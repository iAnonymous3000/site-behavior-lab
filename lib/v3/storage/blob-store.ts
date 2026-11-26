/**
 * Direct O(1) blob store for ScanReportV3 JSON & cached PDFs.
 *
 * Eliminates R2 `ListObjectsV2` + 1,000-HEAD pruning entirely:
 *  - Metadata & search live in D1 (`D1ReportIndexStoreV3`)
 *  - Expiry of transient shares is handled natively by R2 bucket lifecycle rules
 *  - Reads & writes are single O(1) PUT / GET / DELETE operations
 *
 * Supports:
 *  1. Cloudflare Workers R2 bucket binding (`createWorkerR2BlobStoreV3`)
 *  2. S3-compatible R2 HTTP API via `aws4fetch` (`createS3R2BlobStoreV3`)
 *  3. Local filesystem directory (`createFsBlobStoreV3`) for standalone/CLI/tests
 */

import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { AwsClient } from "aws4fetch";
import { readDurableScanJobInternalResponseBytes } from "../../durable-scan-job-internal-response";
import { redactScanReportV3 } from "../redaction";
import { validateScanReportV3, type ScanReportV3 } from "../schema";

const R2_FETCH_TIMEOUT_MS = 10_000;
const R2_CONTROL_RESPONSE_MAX_BYTES = 64 * 1024;
const R2_BLOB_JSON_MAX_BYTES = 24 * 1024 * 1024;
const R2_BLOB_BINARY_MAX_BYTES = 24 * 1024 * 1024;
const R2_RETRY_DELAYS_MS = [250];
const R2_RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

export type BlobStoreV3 = {
  putJson(key: string, body: string): Promise<void>;
  getJson(key: string): Promise<string | null>;
  putBinary(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  getBinary(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
};

export const V3_REPORT_ID_RE = /^\d{8}-[a-f0-9]{16,64}$/;

export function reportBlobKeyV3(reportId: string, prefix = "v3/reports/"): string {
  assertSafeReportIdV3(reportId);
  return `${prefix}${reportId}.json`;
}

export function pdfBlobKeyV3(reportId: string, prefix = "v3/pdfs/"): string {
  assertSafeReportIdV3(reportId);
  return `${prefix}${reportId}.pdf`;
}

export function assertSafeReportIdV3(reportId: string): void {
  if (!V3_REPORT_ID_RE.test(reportId)) {
    throw new Error(`Invalid v3 report ID: ${reportId}`);
  }
}

export async function saveReportV3(store: BlobStoreV3, report: ScanReportV3): Promise<string> {
  const clean = redactScanReportV3(report);
  const issues = validateScanReportV3(clean);
  if (issues.length > 0) {
    throw new Error(`Refusing to store invalid ScanReportV3: ${issues.join("; ")}`);
  }
  const key = reportBlobKeyV3(clean.reportId);
  await store.putJson(key, JSON.stringify(clean));
  return key;
}

export async function loadReportV3(store: BlobStoreV3, reportId: string): Promise<ScanReportV3 | null> {
  const key = reportBlobKeyV3(reportId);
  const raw = await store.getJson(key);
  if (raw === null) return null;
  const parsed = JSON.parse(raw) as ScanReportV3;
  const issues = validateScanReportV3(parsed);
  if (issues.length > 0) {
    throw new Error(`Stored ScanReportV3 ${reportId} failed validation: ${issues.join("; ")}`);
  }
  return parsed;
}

/** Cloudflare Workers native R2Bucket adapter (zero SigV4 overhead!). */
export function createWorkerR2BlobStoreV3(bucket: {
  put(key: string, value: string | ArrayBuffer | Uint8Array, opts?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  get(key: string): Promise<{ text(): Promise<string>; arrayBuffer(): Promise<ArrayBuffer> } | null>;
  delete(key: string): Promise<void>;
}): BlobStoreV3 {
  return {
    async putJson(key, body) {
      await bucket.put(key, body, { httpMetadata: { contentType: "application/json; charset=utf-8" } });
    },
    async getJson(key) {
      const obj = await bucket.get(key);
      return obj ? obj.text() : null;
    },
    async putBinary(key, bytes, contentType) {
      await bucket.put(key, bytes, { httpMetadata: { contentType } });
    },
    async getBinary(key) {
      const obj = await bucket.get(key);
      if (!obj) return null;
      return new Uint8Array(await obj.arrayBuffer());
    },
    async delete(key) {
      await bucket.delete(key);
    }
  };
}

/** S3-compatible Cloudflare R2 HTTP adapter for Node container / CLI processes. */
export function createS3R2BlobStoreV3(config: {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): BlobStoreV3 {
  const aws = new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    service: "s3",
    region: "auto",
    retries: 0
  });
  const doFetch = config.fetchImpl ?? fetch;
  const timeoutMs = Math.max(1_000, Math.min(60_000, config.timeoutMs ?? R2_FETCH_TIMEOUT_MS));
  const baseUrl = `${config.endpoint.replace(/\/+$/, "")}/${encodeURIComponent(config.bucket)}`;
  const urlFor = (key: string) => `${baseUrl}/${key.split("/").map(encodeURIComponent).join("/")}`;

  async function signedFetchBytes(
    url: string,
    init: { method: string; headers?: Record<string, string>; body?: string | Uint8Array },
    successMaxBytes: number
  ): Promise<{ status: number; ok: boolean; bytes: Uint8Array }> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= R2_RETRY_DELAYS_MS.length; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error(`R2 ${init.method} timed out after ${timeoutMs}ms`)), timeoutMs);
      try {
        const reqInit: RequestInit = {
          method: init.method,
          ...(init.headers ? { headers: init.headers } : {}),
          ...(init.body !== undefined ? { body: typeof init.body === "string" ? init.body : Buffer.from(init.body) } : {}),
          signal: controller.signal
        };
        const signed = await aws.sign(url, reqInit);
        const resp = await doFetch(signed, { signal: controller.signal });
        // Always drain small control/error/404 bodies through the bounded reader
        // instead of awaiting `resp.body.cancel()`, which can stall until timeout
        // on Node/undici 8 HTTP responses.
        const maxBytes = resp.ok
          ? successMaxBytes
          : Math.min(successMaxBytes, R2_CONTROL_RESPONSE_MAX_BYTES);
        const bytes = await readDurableScanJobInternalResponseBytes(resp, controller.signal, maxBytes);
        if (R2_RETRYABLE_STATUSES.has(resp.status) && attempt < R2_RETRY_DELAYS_MS.length) {
          clearTimeout(timer);
          await new Promise((resolve) => setTimeout(resolve, R2_RETRY_DELAYS_MS[attempt]));
          continue;
        }
        return { status: resp.status, ok: resp.ok, bytes };
      } catch (err) {
        lastError = err;
        if (attempt < R2_RETRY_DELAYS_MS.length) {
          clearTimeout(timer);
          await new Promise((resolve) => setTimeout(resolve, R2_RETRY_DELAYS_MS[attempt]));
          continue;
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError ?? new Error(`R2 ${init.method} failed`);
  }

  return {
    async putJson(key, body) {
      const res = await signedFetchBytes(
        urlFor(key),
        {
          method: "PUT",
          headers: { "content-type": "application/json; charset=utf-8" },
          body
        },
        R2_CONTROL_RESPONSE_MAX_BYTES
      );
      if (!res.ok) throw new Error(`R2 PUT ${key} failed with HTTP ${res.status}`);
    },
    async getJson(key) {
      const res = await signedFetchBytes(urlFor(key), { method: "GET" }, R2_BLOB_JSON_MAX_BYTES);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`R2 GET ${key} failed with HTTP ${res.status}`);
      return new TextDecoder("utf-8", { fatal: true }).decode(res.bytes);
    },
    async putBinary(key, bytes, contentType) {
      const res = await signedFetchBytes(
        urlFor(key),
        {
          method: "PUT",
          headers: { "content-type": contentType },
          body: bytes
        },
        R2_CONTROL_RESPONSE_MAX_BYTES
      );
      if (!res.ok) throw new Error(`R2 PUT ${key} failed with HTTP ${res.status}`);
    },
    async getBinary(key) {
      const res = await signedFetchBytes(urlFor(key), { method: "GET" }, R2_BLOB_BINARY_MAX_BYTES);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`R2 GET ${key} failed with HTTP ${res.status}`);
      return res.bytes;
    },
    async delete(key) {
      const res = await signedFetchBytes(urlFor(key), { method: "DELETE" }, R2_CONTROL_RESPONSE_MAX_BYTES);
      if (!res.ok && res.status !== 404) {
        throw new Error(`R2 DELETE ${key} failed with HTTP ${res.status}`);
      }
    }
  };
}

/** Local filesystem blob store for standalone self-hosting, local dev, and tests. */
export function createFsBlobStoreV3(rootDir: string): BlobStoreV3 {
  const safeResolve = (key: string): string => {
    const resolved = path.resolve(rootDir, key);
    const rootResolved = path.resolve(rootDir);
    if (!resolved.startsWith(`${rootResolved}${path.sep}`)) {
      throw new Error(`Refusing path traversal key: ${key}`);
    }
    return resolved;
  };

  const writeAtomic = async (fullPath: string, data: string | Uint8Array): Promise<void> => {
    await mkdir(path.dirname(fullPath), { recursive: true });
    const tmp = `${fullPath}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await writeFile(tmp, data);
      await rename(tmp, fullPath);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
  };

  return {
    async putJson(key, body) {
      await writeAtomic(safeResolve(key), body);
    },
    async getJson(key) {
      try {
        return await readFile(safeResolve(key), "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
        throw err;
      }
    },
    async putBinary(key, bytes) {
      await writeAtomic(safeResolve(key), bytes);
    },
    async getBinary(key) {
      try {
        return new Uint8Array(await readFile(safeResolve(key)));
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
        throw err;
      }
    },
    async delete(key) {
      await rm(safeResolve(key), { force: true });
    }
  };
}

const SEED_REPORT_KEY_RE = /^v3\/reports\/(\d{8}-[a-f0-9]{16,64})\.json$/;

/**
 * Read-only blob store backed by committed redacted v3 seed reports under
 * `public/v3/reports/`. Strictly scoped to canonical `v3/reports/<id>.json` keys.
 */
export function createReadOnlySeedBlobStoreV3(seedV3Dir: string): BlobStoreV3 {
  const reportsRoot = path.resolve(seedV3Dir, "reports");

  return {
    async putJson() {
      throw new Error("Read-only v3 seed blob store does not accept writes.");
    },
    async getJson(key) {
      const match = SEED_REPORT_KEY_RE.exec(key);
      if (!match) return null;
      const reportId = match[1];
      assertSafeReportIdV3(reportId);
      const target = path.resolve(reportsRoot, `${reportId}.json`);
      if (!target.startsWith(`${reportsRoot}${path.sep}`)) {
        throw new Error(`Refusing path traversal key: ${key}`);
      }
      try {
        return await readFile(target, "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
        throw err;
      }
    },
    async putBinary() {
      throw new Error("Read-only v3 seed blob store does not accept writes.");
    },
    async getBinary() {
      return null;
    },
    async delete() {
      throw new Error("Read-only v3 seed blob store does not accept deletes.");
    }
  };
}

/**
 * Layered blob store: all mutations go strictly to `primary` (R2 or writable FS),
 * while reads check `primary` first and fall back to `fallbackReadOnly` (committed seed files).
 */
export function createLayeredBlobStoreV3(primary: BlobStoreV3, fallbackReadOnly: BlobStoreV3): BlobStoreV3 {
  return {
    async putJson(key, body) {
      await primary.putJson(key, body);
    },
    async getJson(key) {
      const primaryHit = await primary.getJson(key);
      if (primaryHit !== null) return primaryHit;
      return fallbackReadOnly.getJson(key);
    },
    async putBinary(key, bytes, contentType) {
      await primary.putBinary(key, bytes, contentType);
    },
    async getBinary(key) {
      const primaryHit = await primary.getBinary(key);
      if (primaryHit !== null) return primaryHit;
      return fallbackReadOnly.getBinary(key);
    },
    async delete(key) {
      await primary.delete(key);
    }
  };
}
