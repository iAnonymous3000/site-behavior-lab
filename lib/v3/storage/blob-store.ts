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

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { AwsClient } from "aws4fetch";
import { redactScanReportV3 } from "../redaction";
import { validateScanReportV3, type ScanReportV3 } from "../schema";

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
}): BlobStoreV3 {
  const aws = new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    service: "s3",
    region: "auto"
  });
  const baseUrl = `${config.endpoint.replace(/\/+$/, "")}/${encodeURIComponent(config.bucket)}`;
  const urlFor = (key: string) => `${baseUrl}/${key.split("/").map(encodeURIComponent).join("/")}`;

  return {
    async putJson(key, body) {
      const resp = await aws.fetch(urlFor(key), {
        method: "PUT",
        headers: { "content-type": "application/json; charset=utf-8" },
        body
      });
      if (!resp.ok) throw new Error(`R2 PUT ${key} failed with HTTP ${resp.status}`);
    },
    async getJson(key) {
      const resp = await aws.fetch(urlFor(key), { method: "GET" });
      if (resp.status === 404) return null;
      if (!resp.ok) throw new Error(`R2 GET ${key} failed with HTTP ${resp.status}`);
      return resp.text();
    },
    async putBinary(key, bytes, contentType) {
      const resp = await aws.fetch(urlFor(key), {
        method: "PUT",
        headers: { "content-type": contentType },
        body: Buffer.from(bytes)
      });
      if (!resp.ok) throw new Error(`R2 PUT ${key} failed with HTTP ${resp.status}`);
    },
    async getBinary(key) {
      const resp = await aws.fetch(urlFor(key), { method: "GET" });
      if (resp.status === 404) return null;
      if (!resp.ok) throw new Error(`R2 GET ${key} failed with HTTP ${resp.status}`);
      return new Uint8Array(await resp.arrayBuffer());
    },
    async delete(key) {
      const resp = await aws.fetch(urlFor(key), { method: "DELETE" });
      if (!resp.ok && resp.status !== 404) {
        throw new Error(`R2 DELETE ${key} failed with HTTP ${resp.status}`);
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

  return {
    async putJson(key, body) {
      const full = safeResolve(key);
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, body, "utf8");
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
      const full = safeResolve(key);
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, bytes);
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
