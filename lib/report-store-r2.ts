import { AwsClient } from "aws4fetch";
import { isCanonicalTimestamp } from "./canonical-timestamp";
import type {
  ReportRetentionMetadata,
  ReportStoreBackend,
  ReportStoreOperationOptions,
  ReportRetentionDebtEntry,
  ReportWriteResult,
  StoredReportBlob,
  StoredReportEntry
} from "./report-store-backend";
import {
  SERVER_STORED_PROVENANCE_SIDECAR_MAX_BYTES,
  SERVER_STORED_REPORT_JSON_MAX_BYTES
} from "./report-resource-limits";
import { readDurableScanJobInternalResponseBytes } from "./durable-scan-job-internal-response";
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
export const R2_LIST_MAX_PAGES = 32;
export const R2_LIST_MAX_REPORT_ENTRIES = 2_000;
export const R2_LIST_MAX_SIDECAR_ENTRIES = 2_000;
export const R2_LIST_MAX_CANDIDATES = 2_000;
export const R2_LIST_MAX_HEAD_CANDIDATES = 1_000;
export const R2_LIST_MAX_CONTINUATION_TOKEN_CHARS = 4_096;
export const R2_UNCOMMITTED_HEAD_GRACE_MS = 15 * 60 * 1_000;
export const DEFAULT_R2_REQUEST_TIMEOUT_MS = 10_000;
export const R2_REPORT_RESPONSE_MAX_BYTES = SERVER_STORED_REPORT_JSON_MAX_BYTES;
export const R2_SIDECAR_RESPONSE_MAX_BYTES = SERVER_STORED_PROVENANCE_SIDECAR_MAX_BYTES;
export const R2_LIST_RESPONSE_MAX_BYTES = 2 * 1024 * 1024;
export const R2_CONTROL_RESPONSE_MAX_BYTES = 64 * 1024;
const MAX_R2_REQUEST_TIMEOUT_MS = 120_000;
const RETENTION_DEBT_SEGMENT = "_retention-debt/";
const RETENTION_MAINTENANCE_ID = "00000000-00000000000000000000000000000000";
const RETENTION_MARKER_WIRE = "1\n";

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

export class ReportStoreListBoundsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReportStoreListBoundsError";
  }
}

export class ReportStoreResponseInvalidUtf8Error extends Error {
  constructor() {
    super("R2 response body was not exact valid UTF-8.");
    this.name = "ReportStoreResponseInvalidUtf8Error";
  }
}

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
  const retentionDebtPrefix = `${config.prefix}${RETENTION_DEBT_SEGMENT}`;
  const retentionDebtObjectUrl = (debt: ReportRetentionDebtEntry): string =>
    `${config.endpoint}/${encodeURIComponent(config.bucket)}/${encodeKey(
      `${retentionDebtPrefix}${debt.id}${debt.scope === "bundle" ? ".json" : ".json.provenance.json"}`
    )}`;
  const retentionMaintenanceObjectUrl = retentionDebtObjectUrl({
    id: RETENTION_MAINTENANCE_ID,
    scope: "bundle"
  });

  // One signed dispatch with bounded retries on transient failures. A rejected
  // fetch (network error) or a retryable status marks the attempt's server-side
  // outcome as unknown, which `write` needs to disambiguate a create-only
  // conflict caused by its own earlier attempt landing.
  async function send(
    input: string,
    init: RequestInit,
    successMaxBytes = R2_CONTROL_RESPONSE_MAX_BYTES
  ): Promise<{ response: Response; body: string; outcomeUnknown: boolean }> {
    init.signal?.throwIfAborted();
    let outcomeUnknown = false;
    for (let attempt = 0; ; attempt += 1) {
      init.signal?.throwIfAborted();
      let dispatched: { response: Response; body: string };
      try {
        dispatched = await dispatchWithTimeout(input, init, successMaxBytes);
      } catch (error) {
        // A durable execution fence is authoritative. Retrying after it fires
        // can let a stale publication outlive its coordinator lease.
        if (init.signal?.aborted) throw init.signal.reason;
        if (error instanceof ReportStoreResponseInvalidUtf8Error) throw error;
        outcomeUnknown = true;
        if (attempt >= RETRY_DELAYS_MS.length) throw error;
        await waitForRetry(RETRY_DELAYS_MS[attempt], init.signal);
        continue;
      }
      const { response, body } = dispatched;
      if (RETRYABLE_STATUSES.has(response.status) && attempt < RETRY_DELAYS_MS.length) {
        outcomeUnknown = true;
        await waitForRetry(RETRY_DELAYS_MS[attempt], init.signal);
        continue;
      }
      return { response, body, outcomeUnknown };
    }
  }

  async function waitForRetry(delayMs: number, signal: AbortSignal | null | undefined): Promise<void> {
    signal?.throwIfAborted();
    if (!signal) {
      await sleep(delayMs);
      return;
    }
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (callback: () => void) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        callback();
      };
      const onAbort = () => settle(() => reject(signal.reason));
      signal.addEventListener("abort", onAbort, { once: true });
      // Abort may have raced the pre-registration throwIfAborted check.
      if (signal.aborted) {
        onAbort();
        return;
      }
      void sleep(delayMs).then(
        () => settle(resolve),
        (error) => settle(() => reject(error))
      );
    });
    signal.throwIfAborted();
  }

  async function dispatchWithTimeout(
    input: string,
    init: RequestInit,
    successMaxBytes: number
  ): Promise<{ response: Response; body: string }> {
    init.signal?.throwIfAborted();
    const controller = new AbortController();
    const signal = init.signal
      ? AbortSignal.any([init.signal, controller.signal])
      : controller.signal;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new ReportStoreRequestTimeoutError(`R2 request attempt timed out after ${requestTimeoutMs} ms.`));
      }, requestTimeoutMs);
    });
    const executionAbort = init.signal
      ? new Promise<never>((_resolve, reject) => {
          abortListener = () => reject(init.signal?.reason);
          init.signal?.addEventListener("abort", abortListener, { once: true });
          if (init.signal?.aborted) abortListener();
        })
      : undefined;
    try {
      const dispatch = (async () => {
        const signed = await sign(input, { ...init, signal });
        // A signer may not itself observe AbortSignal. Never dispatch the
        // signed request if the execution was fenced while signing.
        signal.throwIfAborted();
        // Override even if a custom signer accidentally dropped the signal
        // while rebuilding the Request; cancellation is a persistence-layer
        // invariant, not a signer convention.
        const response = await doFetch(signed, { signal });
        signal.throwIfAborted();
        // Keep the same attempt deadline active through body consumption. A
        // server can return headers and then stall its body; clearing the
        // deadline at headers would still freeze the report-store FIFO.
        const responseMaxBytes = response.ok
          ? successMaxBytes
          : Math.min(successMaxBytes, R2_CONTROL_RESPONSE_MAX_BYTES);
        // HEAD Object uses Content-Length to describe the stored GET object,
        // even though the HEAD response has no representation body. Do not
        // mistake a healthy large report for an oversized control response;
        // any non-conforming actual body remains stream-bounded below.
        const bodyResponse = responseForBoundedBodyRead(response, init.method);
        const bytes = await readDurableScanJobInternalResponseBytes(bodyResponse, signal, responseMaxBytes);
        let body: string;
        try {
          body = new TextDecoder("utf-8", {
            fatal: true,
            // Keep a BOM in exact report/sidecar wires. Managed JSON
            // validation must reject it rather than attest normalized bytes.
            ignoreBOM: true
          }).decode(bytes);
        } catch {
          throw new ReportStoreResponseInvalidUtf8Error();
        }
        signal.throwIfAborted();
        return { response, body };
      })();
      return await Promise.race(executionAbort ? [dispatch, deadline, executionAbort] : [dispatch, deadline]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      if (abortListener) init.signal?.removeEventListener("abort", abortListener);
    }
  }

  async function readObject(
    input: string,
    action: string,
    maxResponseBytes: number,
    signal?: AbortSignal
  ): Promise<{ contents: string; headers: Headers; lastModifiedMs: number } | null> {
    const { response, body } = await send(input, { method: "GET", signal }, maxResponseBytes);
    if (response.status === 404) {
      return null;
    }
    assertOk(response, body, action);
    return { contents: body, headers: response.headers, lastModifiedMs: parseLastModified(response.headers) };
  }

  async function readBlob(id: string, options?: ReportStoreOperationOptions): Promise<StoredReportBlob | null> {
    const stored = await readObject(
      reportObjectUrl(id),
      "read report",
      R2_REPORT_RESPONSE_MAX_BYTES,
      options?.signal
    );
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
    retention?: ReportRetentionMetadata,
    options?: ReportStoreOperationOptions
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

    const { response, body, outcomeUnknown } = await send(input, {
      method: "PUT",
      body: contents,
      headers,
      signal: options?.signal
    });
    if (response.status === 412 || response.status === 409) {
      // A 412 after an attempt whose outcome was unknown can be this call's
      // own earlier PUT having landed. Exact contents AND retention metadata
      // must match before treating the replay as success.
      if (outcomeUnknown) {
        let stored: Awaited<ReturnType<typeof readObject>> = null;
        try {
          stored = await readObject(
            input,
            `read ${label}`,
            label === "report" ? R2_REPORT_RESPONSE_MAX_BYTES : R2_SIDECAR_RESPONSE_MAX_BYTES,
            options?.signal
          );
        } catch {
          if (options?.signal?.aborted) throw options.signal.reason;
        }
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

  async function deleteObject(input: string, action: string, signal?: AbortSignal): Promise<void> {
    const { response, body } = await send(input, { method: "DELETE", signal });
    if (response.status !== 404) assertOk(response, body, action);
  }

  async function writeRetentionMarker(input: string, signal?: AbortSignal): Promise<void> {
    const { response, body } = await send(input, {
      method: "PUT",
      body: RETENTION_MARKER_WIRE,
      headers: {
        "content-length": String(RETENTION_MARKER_WIRE.length),
        "content-type": "text/plain"
      },
      signal
    });
    assertOk(response, body, "persist report retention marker");
  }

  async function headRetention(
    id: string,
    signal?: AbortSignal
  ): Promise<{ exists: boolean; retention: ReportRetentionMetadata | null }> {
    const { response, body } = await send(reportObjectUrl(id), { method: "HEAD", signal });
    if (response.status === 404) {
      return { exists: false, retention: null };
    }
    assertOk(response, body, "read report metadata");
    const retention = parseRetentionMetadata(response.headers);
    return { exists: true, retention };
  }

  return {
    kind: "r2",
    write(id, contents, retention, options) {
      return writeCreateOnly(id, reportObjectUrl(id), contents, "report", retention, options);
    },
    async writeSidecar(id, contents, options) {
      await writeCreateOnly(id, sidecarObjectUrl(id), contents, "report sidecar", undefined, options);
    },
    read(id, options) {
      return readBlob(id, options);
    },
    async readSidecar(id, options) {
      const stored = await readObject(
        sidecarObjectUrl(id),
        "read report sidecar",
        R2_SIDECAR_RESPONSE_MAX_BYTES,
        options?.signal
      );
      return stored?.contents ?? null;
    },
    async remove(id, options) {
      // Sidecar first: interruption leaves a report that fails provenance
      // closed, never a sidecar-vouched report that pruning meant to remove.
      // Still attempt both deletes if one errors so a transient/permission
      // problem on one half cannot prevent cleanup of the other half.
      let firstError: unknown;
      try {
        await deleteObject(sidecarObjectUrl(id), "delete report sidecar", options?.signal);
      } catch (error) {
        firstError = error;
      }
      try {
        await deleteObject(reportObjectUrl(id), "delete report", options?.signal);
      } catch (error) {
        firstError ??= error;
      }
      if (firstError !== undefined) throw firstError;
    },
    async removeSidecar(id, options) {
      // Orphan reconciliation must not delete a report that appeared after the
      // LIST snapshot. Removing only the stale commit marker is idempotent.
      await deleteObject(sidecarObjectUrl(id), "delete orphaned report sidecar", options?.signal);
    },
    async markRetentionDebt(debt, options) {
      await writeRetentionMarker(retentionDebtObjectUrl(debt), options?.signal);
    },
    async clearRetentionDebt(debt, options) {
      await deleteObject(retentionDebtObjectUrl(debt), "clear report retention debt", options?.signal);
    },
    async retentionState(options) {
      options?.signal?.throwIfAborted();
      const debts = new Map<string, ReportRetentionDebtEntry>();
      const seenContinuationTokens = new Set<string>();
      let maintenanceRequired = false;
      let continuationToken: string | null = null;
      let pageCount = 0;
      do {
        if (pageCount >= R2_LIST_MAX_PAGES) {
          throw new ReportStoreListBoundsError(
            `R2 report retention debt exceeded ${R2_LIST_MAX_PAGES} pages.`
          );
        }
        const { response, body } = await send(
          listUrl(config, continuationToken, retentionDebtPrefix, 1_000),
          { method: "GET", signal: options?.signal },
          R2_LIST_RESPONSE_MAX_BYTES
        );
        assertOk(response, body, "list report retention debt");
        pageCount += 1;
        const listed = parseListResult(body, retentionDebtPrefix, {
          maxEntries: 2_001,
          maxSidecars: 2_000
        });
        for (const entry of listed.entries) {
          if (entry.id === RETENTION_MAINTENANCE_ID) {
            maintenanceRequired = true;
          } else {
            debts.set(`bundle:${entry.id}`, { id: entry.id, scope: "bundle" });
          }
        }
        for (const id of listed.sidecarIds) {
          debts.set(`sidecar:${id}`, { id, scope: "sidecar" });
        }
        if (debts.size > 2_000) {
          throw new ReportStoreListBoundsError(
            "R2 report retention debt exceeded the bounded 2,000-entry ledger."
          );
        }
        const next = listed.nextContinuationToken;
        if (next !== null) {
          if (
            next.length > R2_LIST_MAX_CONTINUATION_TOKEN_CHARS ||
            next === continuationToken ||
            seenContinuationTokens.has(next)
          ) {
            throw new ReportStoreListBoundsError(
              "R2 report retention-debt continuation token repeated, did not advance, or exceeded its bound."
            );
          }
          seenContinuationTokens.add(next);
        }
        continuationToken = next;
      } while (continuationToken);
      return { debts: [...debts.values()], maintenanceRequired };
    },
    async setRetentionMaintenanceRequired(required, options) {
      if (required) {
        await writeRetentionMarker(retentionMaintenanceObjectUrl, options?.signal);
      } else {
        await deleteObject(
          retentionMaintenanceObjectUrl,
          "clear report retention maintenance signal",
          options?.signal
        );
      }
    },
    async list(options) {
      options?.signal?.throwIfAborted();
      const listedEntriesById = new Map<string, StoredReportEntry>();
      const listedSidecars = new Map<string, number>();
      const candidateIds = new Set<string>();
      const seenContinuationTokens = new Set<string>();
      let totalReportEntries = 0;
      let totalSidecarEntries = 0;
      let pageCount = 0;
      let continuationToken: string | null = null;
      do {
        if (pageCount >= R2_LIST_MAX_PAGES) {
          throw new ReportStoreListBoundsError(
            `R2 report listing exceeded ${R2_LIST_MAX_PAGES} pages.`
          );
        }
        const { response, body } = await send(
          listUrl(config, continuationToken),
          { method: "GET", signal: options?.signal },
          R2_LIST_RESPONSE_MAX_BYTES
        );
        assertOk(response, body, "list reports");
        pageCount += 1;
        const page = parseListResult(body, config.prefix, {
          maxEntries: R2_LIST_MAX_REPORT_ENTRIES - totalReportEntries,
          maxSidecars: R2_LIST_MAX_SIDECAR_ENTRIES - totalSidecarEntries
        });
        totalReportEntries += page.entries.length;
        totalSidecarEntries += page.sidecars.length;

        for (const entry of page.entries) {
          addListCandidate(candidateIds, entry.id);
          // A conforming S3 LIST snapshot contains each key once. If a faulty
          // endpoint repeats a key under advancing tokens, retain one bounded
          // candidate and conservatively keep its newest observed timestamp.
          const prior = listedEntriesById.get(entry.id);
          if (!prior || entry.lastModifiedMs >= prior.lastModifiedMs) {
            listedEntriesById.set(entry.id, entry);
          }
        }
        for (const sidecar of page.sidecars) {
          addListCandidate(candidateIds, sidecar.id);
          const prior = listedSidecars.get(sidecar.id);
          if (prior === undefined || sidecar.lastModifiedMs >= prior) {
            listedSidecars.set(sidecar.id, sidecar.lastModifiedMs);
          }
        }

        const nextContinuationToken = page.nextContinuationToken;
        if (page.isTruncated && nextContinuationToken === null) {
          throw new ReportStoreListBoundsError(
            "R2 report listing was truncated without a continuation token."
          );
        }
        if (nextContinuationToken !== null) {
          if (nextContinuationToken.length > R2_LIST_MAX_CONTINUATION_TOKEN_CHARS) {
            throw new ReportStoreListBoundsError(
              `R2 report listing continuation token exceeded ${R2_LIST_MAX_CONTINUATION_TOKEN_CHARS} characters.`
            );
          }
          if (
            nextContinuationToken === continuationToken ||
            seenContinuationTokens.has(nextContinuationToken)
          ) {
            throw new ReportStoreListBoundsError(
              "R2 report listing continuation token repeated or did not advance."
            );
          }
          if (pageCount >= R2_LIST_MAX_PAGES) {
            throw new ReportStoreListBoundsError(
              `R2 report listing exceeded ${R2_LIST_MAX_PAGES} pages.`
            );
          }
          seenContinuationTokens.add(nextContinuationToken);
        }
        continuationToken = nextContinuationToken;
      } while (continuationToken);

      const listedEntries = [...listedEntriesById.values()];

      // Collect every page before deciding whether a bundle is committed: S3
      // pagination may place a report and its sidecar on different pages. HEAD
      // every sidecar-vouched candidate, plus report-only objects old enough to
      // need immutable-expiry reconciliation. Fresh report-only objects may be
      // an in-flight cross-process save and do not need an immediate HEAD.
      const listedReportIds = new Set(listedEntries.map((entry) => entry.id));
      const listingNow = now();
      let headCandidateCount = 0;
      for (const entry of listedEntries) {
        const sidecarPresent = listedSidecars.has(entry.id);
        if (
          sidecarPresent ||
          listingNow - entry.lastModifiedMs >= R2_UNCOMMITTED_HEAD_GRACE_MS
        ) {
          headCandidateCount += 1;
          if (headCandidateCount > R2_LIST_MAX_HEAD_CANDIDATES) {
            throw new ReportStoreListBoundsError(
              `R2 report listing exceeded ${R2_LIST_MAX_HEAD_CANDIDATES} retention HEAD candidates.`
            );
          }
        }
      }
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
            const metadata = await headRetention(entry.id, options?.signal);
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
            if (options?.signal?.aborted) throw options.signal.reason;
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
  prefix: string,
  limits: { maxEntries?: number; maxSidecars?: number } = {}
): {
  entries: StoredReportEntry[];
  sidecarIds: string[];
  sidecars: ListedSidecar[];
  isTruncated: boolean;
  nextContinuationToken: string | null;
} {
  const listBody = listBucketResultBody(xml);
  const entries: StoredReportEntry[] = [];
  const sidecarIds: string[] = [];
  const sidecars: ListedSidecar[] = [];
  const contentsPattern = /<Contents>([\s\S]*?)<\/Contents>/g;
  let match: RegExpExecArray | null;
  while ((match = contentsPattern.exec(listBody))) {
    const key = extractTag(match[1], "Key");
    if (!key || (prefix && !key.startsWith(prefix))) continue;
    const fileName = key.slice(prefix.length);
    const sidecarSuffix = ".json.provenance.json";
    if (fileName.endsWith(sidecarSuffix)) {
      const id = fileName.slice(0, -sidecarSuffix.length);
      if (REPORT_ID_PATTERN.test(id)) {
        if (sidecars.length >= (limits.maxSidecars ?? Number.POSITIVE_INFINITY)) {
          throw new ReportStoreListBoundsError(
            `R2 report listing exceeded ${R2_LIST_MAX_SIDECAR_ENTRIES} sidecar entries.`
          );
        }
        sidecarIds.push(id);
        sidecars.push({ id, lastModifiedMs: listedLastModified(match[1]) });
      }
      continue;
    }
    const id = fileName.replace(/\.json$/, "");
    if (id === fileName || !REPORT_ID_PATTERN.test(id)) continue;
    if (entries.length >= (limits.maxEntries ?? Number.POSITIVE_INFINITY)) {
      throw new ReportStoreListBoundsError(
        `R2 report listing exceeded ${R2_LIST_MAX_REPORT_ENTRIES} report entries.`
      );
    }
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

  const truncatedText = extractSingleTag(listBody, "IsTruncated", true);
  if (truncatedText !== "true" && truncatedText !== "false") {
    throw new ReportStoreListBoundsError(
      "R2 report listing did not contain exactly one valid IsTruncated marker."
    );
  }
  const isTruncated = truncatedText === "true";
  const continuationTokens = extractTags(listBody, "NextContinuationToken", false);
  if (
    (isTruncated && (continuationTokens.length !== 1 || continuationTokens[0].length === 0)) ||
    (!isTruncated && continuationTokens.length !== 0)
  ) {
    throw new ReportStoreListBoundsError(
      "R2 report listing contained invalid continuation-token state."
    );
  }
  return {
    entries,
    sidecarIds,
    sidecars,
    isTruncated,
    nextContinuationToken: isTruncated ? continuationTokens[0] : null
  };
}

function addListCandidate(candidateIds: Set<string>, id: string): void {
  if (candidateIds.has(id)) return;
  if (candidateIds.size >= R2_LIST_MAX_CANDIDATES) {
    throw new ReportStoreListBoundsError(
      `R2 report listing exceeded ${R2_LIST_MAX_CANDIDATES} unique report candidates.`
    );
  }
  candidateIds.add(id);
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

function listUrl(
  config: R2ReportStoreConfig,
  continuationToken: string | null,
  prefix = config.prefix,
  maxKeys?: number
): string {
  const params = new URLSearchParams({ "list-type": "2" });
  if (prefix) params.set("prefix", prefix);
  if (maxKeys !== undefined) params.set("max-keys", String(maxKeys));
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

function responseForBoundedBodyRead(response: Response, method: string | undefined): Response {
  if (method?.toUpperCase() !== "HEAD" || !response.headers.has("content-length")) return response;
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
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
  let decoded = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character !== "&") {
      if (character === "<") {
        throw new ReportStoreListBoundsError("R2 report listing contained malformed XML text.");
      }
      decoded += character;
      continue;
    }
    const end = value.indexOf(";", index + 1);
    if (end < 0 || end - index > 16) {
      throw new ReportStoreListBoundsError("R2 report listing contained malformed XML text.");
    }
    const entity = value.slice(index + 1, end);
    const named = XML_NAMED_ENTITIES[entity];
    if (named !== undefined) {
      decoded += named;
    } else {
      const codePoint = xmlNumericEntityCodePoint(entity);
      if (codePoint === null) {
        throw new ReportStoreListBoundsError("R2 report listing contained malformed XML text.");
      }
      decoded += String.fromCodePoint(codePoint);
    }
    index = end;
  }
  return decoded;
}

const XML_NAMED_ENTITIES: Readonly<Record<string, string>> = Object.freeze({
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'"
});

function xmlNumericEntityCodePoint(entity: string): number | null {
  const hexadecimal = /^#x([0-9a-fA-F]+)$/.exec(entity);
  const decimal = /^#([0-9]+)$/.exec(entity);
  const codePoint = hexadecimal
    ? Number.parseInt(hexadecimal[1], 16)
    : decimal
      ? Number.parseInt(decimal[1], 10)
      : Number.NaN;
  if (
    !Number.isSafeInteger(codePoint) ||
    codePoint < 0 ||
    codePoint > 0x10ffff ||
    (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
    !isXmlCodePoint(codePoint)
  ) {
    return null;
  }
  return codePoint;
}

function isXmlCodePoint(codePoint: number): boolean {
  return (
    codePoint === 0x09 ||
    codePoint === 0x0a ||
    codePoint === 0x0d ||
    (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
    (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
    (codePoint >= 0x10000 && codePoint <= 0x10ffff)
  );
}

function listBucketResultBody(xml: string): string {
  let document = xml.trim();
  if (document.startsWith("<?xml")) {
    const declarationEnd = document.indexOf("?>");
    if (declarationEnd < 0) {
      throw new ReportStoreListBoundsError("R2 report listing was not a valid ListBucketResult document.");
    }
    document = document.slice(declarationEnd + 2).trim();
  }
  const root = /^<ListBucketResult(?:\s+[^<>]*)?>([\s\S]*)<\/ListBucketResult>$/.exec(document);
  if (!root) {
    throw new ReportStoreListBoundsError("R2 report listing was not a valid ListBucketResult document.");
  }
  return root[1];
}

function extractTags(xml: string, tag: string, trim: boolean): string[] {
  const values: string[] = [];
  const pattern = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g");
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(xml))) {
    values.push(decodeXmlEntities(trim ? match[1].trim() : match[1]));
  }
  return values;
}

function extractSingleTag(xml: string, tag: string, trim: boolean): string | null {
  const values = extractTags(xml, tag, trim);
  return values.length === 1 ? values[0] : null;
}

/**
 * The upstream HTTP status is carried on the error VALUE, not only inside its
 * message. classifyReportStoreFailure reads `status` deliberately, because a
 * message regex would have to parse the very text the public health projection
 * exists to keep off the wire. A bare Error left every R2 HTTP failure
 * classified "unknown", so the unauthorized, unreachable, and
 * malformed-response tokens were unreachable for the only backend that
 * produces HTTP failures at all.
 */
export class ReportStoreHttpError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "ReportStoreHttpError";
  }
}

function assertOk(response: Response, body: string, action: string): void {
  if (response.ok) return;
  throw new ReportStoreHttpError(
    `Failed to ${action} (HTTP ${response.status}). ${body.slice(0, 200)}`.trim(),
    response.status
  );
}
