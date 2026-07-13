import { AwsClient } from "aws4fetch";
import type {
  ReportRetentionMetadata,
  ReportStoreBackend,
  StoredReportBlob,
  StoredReportEntry
} from "./report-store-backend";
import { REPORT_ID_PATTERN } from "./report-validation";

const R2_BUCKET_ENV = "SITE_BEHAVIOR_LAB_R2_BUCKET";
const R2_ENDPOINT_ENV = "SITE_BEHAVIOR_LAB_R2_ENDPOINT";
const R2_ACCESS_KEY_ID_ENV = "SITE_BEHAVIOR_LAB_R2_ACCESS_KEY_ID";
const R2_SECRET_ACCESS_KEY_ENV = "SITE_BEHAVIOR_LAB_R2_SECRET_ACCESS_KEY";
const R2_PREFIX_ENV = "SITE_BEHAVIOR_LAB_R2_PREFIX";
const CREATED_AT_METADATA_HEADER = "x-amz-meta-created-at";
const EXPIRES_AT_METADATA_HEADER = "x-amz-meta-expires-at";

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

  const reportObjectUrl = (id: string): string =>
    `${config.endpoint}/${encodeURIComponent(config.bucket)}/${encodeKey(`${config.prefix}${id}.json`)}`;
  const sidecarObjectUrl = (id: string): string =>
    `${config.endpoint}/${encodeURIComponent(config.bucket)}/${encodeKey(`${config.prefix}${id}.json.provenance.json`)}`;

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

  async function readObject(input: string, action: string): Promise<{ contents: string; headers: Headers; lastModifiedMs: number } | null> {
    const { response } = await send(input, { method: "GET" });
    if (response.status === 404) {
      await drain(response);
      return null;
    }
    await assertOk(response, action);
    const contents = await response.text();
    return { contents, headers: response.headers, lastModifiedMs: parseLastModified(response.headers) };
  }

  async function readBlob(id: string): Promise<StoredReportBlob | null> {
    const stored = await readObject(reportObjectUrl(id), "read report");
    if (!stored) return null;
    return {
      contents: stored.contents,
      lastModifiedMs: stored.lastModifiedMs,
      retention: parseRetentionMetadata(stored.headers)
    };
  }

  async function writeCreateOnly(
    id: string,
    input: string,
    contents: string,
    label: "report" | "report sidecar",
    retention?: ReportRetentionMetadata
  ): Promise<void> {
    if (retention !== undefined && !isRetentionMetadata(retention)) {
      throw new Error("Invalid report retention metadata.");
    }
    const headers: Record<string, string> = {
      "content-length": String(new TextEncoder().encode(contents).byteLength),
      "content-type": "application/json",
      "if-none-match": "*"
    };
    if (retention) {
      headers[CREATED_AT_METADATA_HEADER] = retention.createdAt;
      headers[EXPIRES_AT_METADATA_HEADER] = retention.expiresAt;
    }

    const { response, outcomeUnknown } = await send(input, { method: "PUT", body: contents, headers });
    if (response.status === 412 || response.status === 409) {
      await drain(response);
      // A 412 after an attempt whose outcome was unknown can be this call's
      // own earlier PUT having landed. Exact contents AND retention metadata
      // must match before treating the replay as success.
      if (outcomeUnknown) {
        const stored = await readObject(input, `read ${label}`).catch(() => null);
        const storedRetention = stored ? parseRetentionMetadata(stored.headers) : null;
        if (
          stored?.contents === contents &&
          (retention === undefined || retentionMetadataEqual(storedRetention, retention))
        ) {
          return;
        }
      }
      throw new ReportStoreWriteConflictError(`Report ${id} ${label} already exists.`);
    }
    await assertOk(response, `store ${label}`);
    await drain(response);
  }

  async function deleteObject(input: string, action: string): Promise<void> {
    const { response } = await send(input, { method: "DELETE" });
    if (response.status !== 404) await assertOk(response, action);
    await drain(response);
  }

  async function headRetention(id: string): Promise<{ exists: boolean; retention: ReportRetentionMetadata | null }> {
    const { response } = await send(reportObjectUrl(id), { method: "HEAD" });
    if (response.status === 404) {
      await drain(response);
      return { exists: false, retention: null };
    }
    await assertOk(response, "read report metadata");
    const retention = parseRetentionMetadata(response.headers);
    await drain(response);
    return { exists: true, retention };
  }

  return {
    kind: "r2",
    write(id, contents, retention) {
      return writeCreateOnly(id, reportObjectUrl(id), contents, "report", retention);
    },
    writeSidecar(id, contents) {
      return writeCreateOnly(id, sidecarObjectUrl(id), contents, "report sidecar");
    },
    read(id) {
      return readBlob(id);
    },
    async readSidecar(id) {
      const stored = await readObject(sidecarObjectUrl(id), "read report sidecar");
      return stored?.contents ?? null;
    },
    async remove(id) {
      // Sidecar first: interruption leaves a report that fails provenance
      // closed, never a sidecar-vouched report that pruning meant to remove.
      // Still attempt both deletes if one errors so a transient/permission
      // problem on one half cannot prevent cleanup of the other half.
      let firstError: unknown;
      try {
        await deleteObject(sidecarObjectUrl(id), "delete report sidecar");
      } catch (error) {
        firstError = error;
      }
      try {
        await deleteObject(reportObjectUrl(id), "delete report");
      } catch (error) {
        firstError ??= error;
      }
      if (firstError !== undefined) throw firstError;
    },
    async list() {
      const entries: StoredReportEntry[] = [];
      let continuationToken: string | null = null;
      do {
        const { response } = await send(listUrl(config, continuationToken), { method: "GET" });
        await assertOk(response, "list reports");
        const page = parseListResult(await response.text(), config.prefix);
        const enriched = await Promise.all(
          page.entries.map(async (entry): Promise<StoredReportEntry | null> => {
            const metadata = await headRetention(entry.id);
            return metadata.exists ? { ...entry, retention: metadata.retention } : null;
          })
        );
        entries.push(...enriched.filter((entry): entry is StoredReportEntry => entry !== null));
        continuationToken = page.nextContinuationToken;
      } while (continuationToken);
      return entries;
    },
    status() {
      return { kind: "r2", bucket: config.bucket, prefix: config.prefix, configuredPath: true };
    }
  };
}

export function r2ReportStoreConfigFromEnv(env: NodeJS.ProcessEnv = process.env): R2ReportStoreConfig {
  return {
    bucket: requireEnv(R2_BUCKET_ENV, env),
    endpoint: requireEnv(R2_ENDPOINT_ENV, env).replace(/\/+$/, ""),
    accessKeyId: requireEnv(R2_ACCESS_KEY_ID_ENV, env),
    secretAccessKey: requireEnv(R2_SECRET_ACCESS_KEY_ENV, env),
    prefix: normalizePrefix(env[R2_PREFIX_ENV])
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
    entries.push({ id, lastModifiedMs: Number.isFinite(parsed) ? parsed : Date.now(), retention: null });
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

function parseRetentionMetadata(headers: Headers): ReportRetentionMetadata | null {
  const value = {
    createdAt: headers.get(CREATED_AT_METADATA_HEADER) ?? "",
    expiresAt: headers.get(EXPIRES_AT_METADATA_HEADER) ?? ""
  };
  return isRetentionMetadata(value) ? value : null;
}

function retentionMetadataEqual(left: ReportRetentionMetadata | null, right: ReportRetentionMetadata): boolean {
  return left?.createdAt === right.createdAt && left.expiresAt === right.expiresAt;
}

function isRetentionMetadata(value: unknown): value is ReportRetentionMetadata {
  if (!value || typeof value !== "object") return false;
  const metadata = value as Partial<ReportRetentionMetadata>;
  return (
    Object.keys(value).length === 2 &&
    isCanonicalTimestamp(metadata.createdAt) &&
    isCanonicalTimestamp(metadata.expiresAt) &&
    Date.parse(metadata.expiresAt) > Date.parse(metadata.createdAt)
  );
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function normalizePrefix(raw: string | undefined): string {
  const trimmed = raw?.trim();
  if (!trimmed) return "";
  return `${trimmed.replace(/^\/+/, "").replace(/\/+$/, "")}/`;
}

function requireEnv(name: string, env: NodeJS.ProcessEnv): string {
  const value = env[name]?.trim();
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
