import { AwsClient } from "aws4fetch";
import type {
  ReportRetentionMetadata,
  ReportStoreBackend,
  ReportWriteResult,
  StoredReportBlob,
  StoredReportEntry
} from "./report-store-backend";
import { REPORT_ID_PATTERN } from "./report-validation";

const R2_BUCKET_ENV = "SITE_BEHAVIOR_LAB_R2_BUCKET";
const R2_ENDPOINT_ENV = "SITE_BEHAVIOR_LAB_R2_ENDPOINT";
const R2_ACCESS_KEY_ID_ENV = "SITE_BEHAVIOR_LAB_R2_ACCESS_KEY_ID";
const R2_SECRET_ACCESS_KEY_ENV = "SITE_BEHAVIOR_LAB_R2_SECRET_ACCESS_KEY";
const R2_PREFIX_ENV = "SITE_BEHAVIOR_LAB_R2_PREFIX";
export const R2_REQUEST_TIMEOUT_MS_ENV = "SITE_BEHAVIOR_LAB_R2_REQUEST_TIMEOUT_MS";
const CREATED_AT_METADATA_HEADER = "x-amz-meta-created-at";
const EXPIRES_AT_METADATA_HEADER = "x-amz-meta-expires-at";
export const R2_LIST_HEAD_CONCURRENCY = 8;
export const R2_UNCOMMITTED_HEAD_GRACE_MS = 15 * 60 * 1_000;
export const DEFAULT_R2_REQUEST_TIMEOUT_MS = 10_000;
const MAX_R2_REQUEST_TIMEOUT_MS = 120_000;

type ListedSidecar = { id: string; lastModifiedMs: number };

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
  /** Per signed request attempt; defaults to the bounded environment setting. */
  requestTimeoutMs?: number;
  /** Listing clock used to decide when report-only objects need retention HEADs. */
  now?: () => number;
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

export class ReportStoreRequestTimeoutError extends Error {}

export function createR2ReportStoreBackend(
  config: R2ReportStoreConfig = r2ReportStoreConfigFromEnv(),
  deps: R2ReportStoreDeps = {}
): ReportStoreBackend {
  const doFetch = deps.fetch ?? fetch;
  const sign = deps.sign ?? defaultSigner(config);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const requestTimeoutMs = normalizedRequestTimeoutMs(
    deps.requestTimeoutMs ?? Number(process.env[R2_REQUEST_TIMEOUT_MS_ENV] ?? "")
  );
  const now = deps.now ?? Date.now;

  const reportObjectUrl = (id: string): string =>
    `${config.endpoint}/${encodeURIComponent(config.bucket)}/${encodeKey(`${config.prefix}${id}.json`)}`;
  const sidecarObjectUrl = (id: string): string =>
    `${config.endpoint}/${encodeURIComponent(config.bucket)}/${encodeKey(`${config.prefix}${id}.json.provenance.json`)}`;

  // One signed dispatch with bounded retries on transient failures. A rejected
  // fetch (network error) or a retryable status marks the attempt's server-side
  // outcome as unknown, which `write` needs to disambiguate a create-only
  // conflict caused by its own earlier attempt landing.
  async function send(
    input: string,
    init: RequestInit
  ): Promise<{ response: Response; body: string; outcomeUnknown: boolean }> {
    let outcomeUnknown = false;
    for (let attempt = 0; ; attempt += 1) {
      let dispatched: { response: Response; body: string };
      try {
        dispatched = await dispatchWithTimeout(input, init);
      } catch (error) {
        outcomeUnknown = true;
        if (attempt >= RETRY_DELAYS_MS.length) throw error;
        await sleep(RETRY_DELAYS_MS[attempt]);
        continue;
      }
      const { response, body } = dispatched;
      if (RETRYABLE_STATUSES.has(response.status) && attempt < RETRY_DELAYS_MS.length) {
        outcomeUnknown = true;
        await sleep(RETRY_DELAYS_MS[attempt]);
        continue;
      }
      return { response, body, outcomeUnknown };
    }
  }

  async function dispatchWithTimeout(
    input: string,
    init: RequestInit
  ): Promise<{ response: Response; body: string }> {
    const controller = new AbortController();
    const signal = init.signal
      ? AbortSignal.any([init.signal, controller.signal])
      : controller.signal;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new ReportStoreRequestTimeoutError(`R2 request attempt timed out after ${requestTimeoutMs} ms.`));
      }, requestTimeoutMs);
    });
    try {
      const dispatch = (async () => {
        const response = await doFetch(await sign(input, { ...init, signal }));
        // Keep the same attempt deadline active through body consumption. A
        // server can return headers and then stall its body; clearing the
        // deadline at headers would still freeze the report-store FIFO.
        const body = await response.text();
        return { response, body };
      })();
      return await Promise.race([dispatch, deadline]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  async function readObject(input: string, action: string): Promise<{ contents: string; headers: Headers; lastModifiedMs: number } | null> {
    const { response, body } = await send(input, { method: "GET" });
    if (response.status === 404) {
      return null;
    }
    assertOk(response, body, action);
    return { contents: body, headers: response.headers, lastModifiedMs: parseLastModified(response.headers) };
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
  ): Promise<ReportWriteResult> {
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

    const { response, body, outcomeUnknown } = await send(input, { method: "PUT", body: contents, headers });
    if (response.status === 412 || response.status === 409) {
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
          // Read-back proves matching bytes, not which identical concurrent
          // writer won the conditional create. The facade may proceed, but it
          // must never destructively clean this object up as certainly owned.
          return { ownership: "ambiguous" };
        }
      }
      throw new ReportStoreWriteConflictError(`Report ${id} ${label} already exists.`);
    }
    assertOk(response, body, `store ${label}`);
    return { ownership: "certain" };
  }

  async function deleteObject(input: string, action: string): Promise<void> {
    const { response, body } = await send(input, { method: "DELETE" });
    if (response.status !== 404) assertOk(response, body, action);
  }

  async function headRetention(id: string): Promise<{ exists: boolean; retention: ReportRetentionMetadata | null }> {
    const { response, body } = await send(reportObjectUrl(id), { method: "HEAD" });
    if (response.status === 404) {
      return { exists: false, retention: null };
    }
    assertOk(response, body, "read report metadata");
    const retention = parseRetentionMetadata(response.headers);
    return { exists: true, retention };
  }

  return {
    kind: "r2",
    write(id, contents, retention) {
      return writeCreateOnly(id, reportObjectUrl(id), contents, "report", retention);
    },
    async writeSidecar(id, contents) {
      await writeCreateOnly(id, sidecarObjectUrl(id), contents, "report sidecar");
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
    async removeSidecar(id) {
      // Orphan reconciliation must not delete a report that appeared after the
      // LIST snapshot. Removing only the stale commit marker is idempotent.
      await deleteObject(sidecarObjectUrl(id), "delete orphaned report sidecar");
    },
    async list() {
      const listedEntries: StoredReportEntry[] = [];
      const listedSidecars = new Map<string, number>();
      let continuationToken: string | null = null;
      do {
        const { response, body } = await send(listUrl(config, continuationToken), { method: "GET" });
        assertOk(response, body, "list reports");
        const page = parseListResult(body, config.prefix);
        listedEntries.push(...page.entries);
        for (const sidecar of page.sidecars) listedSidecars.set(sidecar.id, sidecar.lastModifiedMs);
        continuationToken = page.nextContinuationToken;
      } while (continuationToken);

      // Collect every page before deciding whether a bundle is committed: S3
      // pagination may place a report and its sidecar on different pages. HEAD
      // every sidecar-vouched candidate, plus report-only objects old enough to
      // need immutable-expiry reconciliation. Fresh report-only objects may be
      // an in-flight cross-process save and do not need an immediate HEAD.
      const listedReportIds = new Set(listedEntries.map((entry) => entry.id));
      const listingNow = now();
      const enrichedCandidates = await mapWithConcurrency(
        listedEntries,
        R2_LIST_HEAD_CONCURRENCY,
        async (entry): Promise<StoredReportEntry | null> => {
          const sidecarLastModifiedMs = listedSidecars.get(entry.id);
          const sidecarPresent = sidecarLastModifiedMs !== undefined;
          const shouldReadUncommittedRetention =
            !sidecarPresent && listingNow - entry.lastModifiedMs >= R2_UNCOMMITTED_HEAD_GRACE_MS;
          if (!sidecarPresent && !shouldReadUncommittedRetention) return entry;

          try {
            const metadata = await headRetention(entry.id);
            if (!metadata.exists) {
              return sidecarPresent ? sidecarOnlyEntry(entry.id, sidecarLastModifiedMs) : null;
            }
            return {
              ...entry,
              retention: metadata.retention,
              sidecarPresent,
              committed: sidecarPresent
            };
          } catch (error) {
            // A listed report+sidecar is a committed candidate. Silently
            // downgrading it on HEAD failure would hide an operational outage
            // and change count/retention decisions, so fail the list/prune.
            if (sidecarPresent) throw error;
            // An old report-only candidate remains conservatively uncommitted
            // when metadata is temporarily unavailable; no deletion follows.
            return entry;
          }
        }
      );
      const enriched = enrichedCandidates.filter((entry): entry is StoredReportEntry => entry !== null);
      for (const [id, lastModifiedMs] of listedSidecars) {
        if (!listedReportIds.has(id)) enriched.push(sidecarOnlyEntry(id, lastModifiedMs));
      }
      return enriched;
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
): {
  entries: StoredReportEntry[];
  sidecarIds: string[];
  sidecars: ListedSidecar[];
  nextContinuationToken: string | null;
} {
  const entries: StoredReportEntry[] = [];
  const sidecarIds: string[] = [];
  const sidecars: ListedSidecar[] = [];
  const contentsPattern = /<Contents>([\s\S]*?)<\/Contents>/g;
  let match: RegExpExecArray | null;
  while ((match = contentsPattern.exec(xml))) {
    const key = extractTag(match[1], "Key");
    if (!key || (prefix && !key.startsWith(prefix))) continue;
    const fileName = key.slice(prefix.length);
    const sidecarSuffix = ".json.provenance.json";
    if (fileName.endsWith(sidecarSuffix)) {
      const id = fileName.slice(0, -sidecarSuffix.length);
      if (REPORT_ID_PATTERN.test(id)) {
        sidecarIds.push(id);
        sidecars.push({ id, lastModifiedMs: listedLastModified(match[1]) });
      }
      continue;
    }
    const id = fileName.replace(/\.json$/, "");
    if (id === fileName || !REPORT_ID_PATTERN.test(id)) continue;
    const lastModified = extractTag(match[1], "LastModified");
    const parsed = lastModified ? Date.parse(lastModified) : Number.NaN;
    entries.push({
      id,
      lastModifiedMs: Number.isFinite(parsed) ? parsed : Date.now(),
      retention: null,
      reportPresent: true,
      sidecarPresent: false,
      committed: false
    });
  }

  const truncated = extractTag(xml, "IsTruncated") === "true";
  const nextContinuationToken = truncated ? extractTag(xml, "NextContinuationToken") : null;
  return { entries, sidecarIds, sidecars, nextContinuationToken: nextContinuationToken || null };
}

function sidecarOnlyEntry(id: string, lastModifiedMs: number): StoredReportEntry {
  return {
    id,
    lastModifiedMs,
    retention: null,
    reportPresent: false,
    sidecarPresent: true,
    committed: false
  };
}

function listedLastModified(contentsXml: string): number {
  const value = extractTag(contentsXml, "LastModified");
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Date.now();
}

async function mapWithConcurrency<T, U>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<U>
): Promise<U[]> {
  const results = new Array<U>(values.length);
  let nextIndex = 0;
  const worker = async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) return;
      results[index] = await mapper(values[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
  return results;
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

function normalizedRequestTimeoutMs(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_R2_REQUEST_TIMEOUT_MS;
  return Math.min(MAX_R2_REQUEST_TIMEOUT_MS, Math.max(1, Math.floor(value)));
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

function assertOk(response: Response, body: string, action: string): void {
  if (response.ok) return;
  throw new Error(`Failed to ${action} (HTTP ${response.status}). ${body.slice(0, 200)}`.trim());
}
