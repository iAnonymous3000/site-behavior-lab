import { AwsClient } from "aws4fetch";
import type { ReportStoreBackend, StoredReportBlob, StoredReportEntry } from "./report-store-backend";
import { REPORT_ID_PATTERN } from "./report-validation";

const R2_BUCKET_ENV = "SITE_BEHAVIOR_LAB_R2_BUCKET";
const R2_ENDPOINT_ENV = "SITE_BEHAVIOR_LAB_R2_ENDPOINT";
const R2_ACCESS_KEY_ID_ENV = "SITE_BEHAVIOR_LAB_R2_ACCESS_KEY_ID";
const R2_SECRET_ACCESS_KEY_ENV = "SITE_BEHAVIOR_LAB_R2_SECRET_ACCESS_KEY";
const R2_PREFIX_ENV = "SITE_BEHAVIOR_LAB_R2_PREFIX";

export type R2ReportStoreConfig = {
  bucket: string;
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  prefix: string;
};

export type R2ReportStoreDeps = {
  /** Sign an S3 request. Defaults to SigV4 via aws4fetch; injected in tests. */
  sign?: (input: string, init: RequestInit) => Promise<Request>;
  /** Dispatch the signed request. Defaults to the global fetch; injected in tests. */
  fetch?: typeof fetch;
  /** Wait between retry attempts. Defaults to setTimeout; injected in tests. */
  sleep?: (ms: number) => Promise<void>;
};

// Transient R2 failures (a 5xx from the S3 API, a throttle, or a dropped
// connection such as a stale keep-alive socket after the container sat idle)
// otherwise surface as a user-visible "shareable report could not be saved"
// warning on an otherwise successful scan. S3-compatible stores expect clients
// to retry these; every operation here is safe to retry (GET/DELETE/LIST are
// idempotent, and the create-only PUT resolves an ambiguous replay via a
// read-back, see `write`).
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const RETRY_DELAYS_MS = [250, 750];

/** Thrown when configured for R2 but the required R2_* env vars are missing. */
export class ReportStoreConfigError extends Error {}

/** Thrown when a create-only write loses the race to an existing object. */
export class ReportStoreWriteConflictError extends Error {}

export function createR2ReportStoreBackend(
  config: R2ReportStoreConfig = r2ReportStoreConfigFromEnv(),
  deps: R2ReportStoreDeps = {}
): ReportStoreBackend {
  const doFetch = deps.fetch ?? fetch;
  const sign = deps.sign ?? defaultSigner(config);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const objectUrl = (id: string): string =>
    `${config.endpoint}/${encodeURIComponent(config.bucket)}/${encodeKey(`${config.prefix}${id}.json`)}`;

  // One signed dispatch with bounded retries on transient failures. A rejected
  // fetch (network error) or a retryable status marks the attempt's server-side
  // outcome as unknown, which `write` needs to disambiguate a create-only
  // conflict caused by its own earlier attempt landing.
  async function send(input: string, init: RequestInit): Promise<{ response: Response; outcomeUnknown: boolean }> {
    let outcomeUnknown = false;
    for (let attempt = 0; ; attempt += 1) {
      let response: Response;
      try {
        response = await doFetch(await sign(input, init));
      } catch (error) {
        outcomeUnknown = true;
        if (attempt >= RETRY_DELAYS_MS.length) throw error;
        await sleep(RETRY_DELAYS_MS[attempt]);
        continue;
      }
      if (RETRYABLE_STATUSES.has(response.status) && attempt < RETRY_DELAYS_MS.length) {
        outcomeUnknown = true;
        await drain(response);
        await sleep(RETRY_DELAYS_MS[attempt]);
        continue;
      }
      return { response, outcomeUnknown };
    }
  }

  async function readBlob(id: string): Promise<StoredReportBlob | null> {
    const { response } = await send(objectUrl(id), { method: "GET" });
    if (response.status === 404) {
      await drain(response);
      return null;
    }
    await assertOk(response, "read report");
    const contents = await response.text();
    return { contents, lastModifiedMs: parseLastModified(response.headers) } satisfies StoredReportBlob;
  }

  return {
    kind: "r2",
    async write(id, contents) {
      // If-None-Match: * makes the PUT create-only, preserving the filesystem
      // `wx` guarantee against ID reuse.
      const { response, outcomeUnknown } = await send(objectUrl(id), {
        method: "PUT",
        body: contents,
        headers: { "content-type": "application/json", "if-none-match": "*" }
      });
      if (response.status === 412 || response.status === 409) {
        await drain(response);
        // A 412 after an attempt whose outcome was unknown can be this call's
        // own earlier PUT having landed (the response was lost, the object was
        // created). Read the object back: identical contents mean the write
        // succeeded; anything else is a genuine ID conflict.
        if (outcomeUnknown) {
          const stored = await readBlob(id).catch(() => null);
          if (stored?.contents === contents) return;
        }
        throw new ReportStoreWriteConflictError(`Report ${id} already exists.`);
      }
      await assertOk(response, "store report");
      await drain(response);
    },
    read(id) {
      return readBlob(id);
    },
    async remove(id) {
      const { response } = await send(objectUrl(id), { method: "DELETE" });
      if (response.status !== 404) {
        await assertOk(response, "delete report");
      }
      await drain(response);
    },
    async list() {
      const entries: StoredReportEntry[] = [];
      let continuationToken: string | null = null;
      do {
        const { response } = await send(listUrl(config, continuationToken), { method: "GET" });
        await assertOk(response, "list reports");
        const page = parseListResult(await response.text(), config.prefix);
        entries.push(...page.entries);
        continuationToken = page.nextContinuationToken;
      } while (continuationToken);
      return entries;
    },
    status() {
      return { kind: "r2", bucket: config.bucket, prefix: config.prefix, configuredPath: true };
    }
  };
}

export function r2ReportStoreConfigFromEnv(): R2ReportStoreConfig {
  return {
    bucket: requireEnv(R2_BUCKET_ENV),
    endpoint: requireEnv(R2_ENDPOINT_ENV).replace(/\/+$/, ""),
    accessKeyId: requireEnv(R2_ACCESS_KEY_ID_ENV),
    secretAccessKey: requireEnv(R2_SECRET_ACCESS_KEY_ENV),
    prefix: normalizePrefix(process.env[R2_PREFIX_ENV])
  };
}

function defaultSigner(config: R2ReportStoreConfig): (input: string, init: RequestInit) => Promise<Request> {
  const client = new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    service: "s3",
    region: "auto"
  });
  return (input, init) => client.sign(input, init);
}

export function parseListResult(
  xml: string,
  prefix: string
): { entries: StoredReportEntry[]; nextContinuationToken: string | null } {
  const entries: StoredReportEntry[] = [];
  const contentsPattern = /<Contents>([\s\S]*?)<\/Contents>/g;
  let match: RegExpExecArray | null;
  while ((match = contentsPattern.exec(xml))) {
    const key = extractTag(match[1], "Key");
    if (!key || (prefix && !key.startsWith(prefix))) continue;
    const fileName = key.slice(prefix.length);
    const id = fileName.replace(/\.json$/, "");
    if (id === fileName || !REPORT_ID_PATTERN.test(id)) continue;
    const lastModified = extractTag(match[1], "LastModified");
    const parsed = lastModified ? Date.parse(lastModified) : Number.NaN;
    entries.push({ id, lastModifiedMs: Number.isFinite(parsed) ? parsed : Date.now() });
  }

  const truncated = extractTag(xml, "IsTruncated") === "true";
  const nextContinuationToken = truncated ? extractTag(xml, "NextContinuationToken") : null;
  return { entries, nextContinuationToken: nextContinuationToken || null };
}

function listUrl(config: R2ReportStoreConfig, continuationToken: string | null): string {
  const params = new URLSearchParams({ "list-type": "2" });
  if (config.prefix) params.set("prefix", config.prefix);
  if (continuationToken) params.set("continuation-token", continuationToken);
  return `${config.endpoint}/${encodeURIComponent(config.bucket)}?${params.toString()}`;
}

function encodeKey(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

function parseLastModified(headers: Headers): number {
  const header = headers.get("last-modified");
  const parsed = header ? Date.parse(header) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function normalizePrefix(raw: string | undefined): string {
  const trimmed = raw?.trim();
  if (!trimmed) return "";
  return `${trimmed.replace(/^\/+/, "").replace(/\/+$/, "")}/`;
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new ReportStoreConfigError(`${name} is required when SITE_BEHAVIOR_LAB_REPORT_STORE_BACKEND=r2.`);
  }
  return value;
}

function extractTag(xml: string, tag: string): string | null {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
  return match ? decodeXmlEntities(match[1].trim()) : null;
}

function decodeXmlEntities(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'");
}

async function assertOk(response: Response, action: string): Promise<void> {
  if (response.ok) return;
  const body = await response.text().catch(() => "");
  throw new Error(`Failed to ${action} (HTTP ${response.status}). ${body.slice(0, 200)}`.trim());
}

async function drain(response: Response): Promise<void> {
  // Consume the body so the underlying connection can be released/reused.
  await response.text().catch(() => undefined);
}
