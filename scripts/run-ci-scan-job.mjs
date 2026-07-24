import {
  readResponseJsonWithinLimit,
  withHttpOperationDeadline
} from "./http-response.mjs";

const TRANSIENT_HTTP_STATUSES = new Set([429, 502, 503]);
const MAX_TRANSIENT_RETRIES_PER_CYCLE = 3;
const MAX_TRANSIENT_BACKOFF_MS = 30_000;
const STATUS_REQUEST_TIMEOUT_MS = 30_000;
const STATUS_RESPONSE_MAX_BYTES = 32 * 1024 * 1024;

/**
 * Resolve one accepted scan using the coordinator's terminal state as the
 * deadline authority. The caller supplies the report validator because the
 * publisher supports both frozen v1 and current public v2/r2 wires.
 */
export async function awaitSubmittedScanJob({
  submission,
  baseUrl,
  headers = {},
  isPublishableScanReport,
  fetcher = fetch,
  wait = delay,
  now = Date.now
}) {
  if (!submission || typeof submission.jobId !== "string" || typeof submission.statusPath !== "string") {
    throw new Error("Invalid accepted scan-job submission.");
  }
  if (typeof isPublishableScanReport !== "function") {
    throw new Error("A scan-report validator is required.");
  }

  const statusUrl = sameOriginStatusUrl(baseUrl, submission.statusPath);
  const startedAt = now();
  for (;;) {
    const status = await fetchJsonWithTransientRetry(statusUrl, { fetcher, headers, wait, now });

    if (isRecord(status) && status.ok === true && status.status === "succeeded") {
      if (!isPublishableScanReport(status.report)) {
        throw new Error("Completed scan job did not include a publishable report.");
      }
      return status.report;
    }
    if (
      isRecord(status) &&
      status.ok === true &&
      (status.status === "queued" || status.status === "running")
    ) {
      await wait(scanJobPollIntervalMs(now() - startedAt));
      continue;
    }
    throw new Error(
      isRecord(status) && typeof status.error === "string"
        ? status.error
        : `Scan job ${submission.jobId} did not complete.`
    );
  }
}

/** Back off long-lived jobs without imposing a stale client-side deadline. */
export function scanJobPollIntervalMs(elapsedMs) {
  if (elapsedMs < 3 * 60_000) return 1_000;
  if (elapsedMs < 10 * 60_000) return 5_000;
  return 10_000;
}

export function retryAfterMs(value, now = Date.now()) {
  if (value === null) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isSafeInteger(seconds)) return MAX_TRANSIENT_BACKOFF_MS;
    return Math.min(seconds * 1_000, MAX_TRANSIENT_BACKOFF_MS);
  }
  const timestamp = Date.parse(trimmed);
  if (!Number.isFinite(timestamp)) return null;
  return Math.min(Math.max(0, timestamp - now), MAX_TRANSIENT_BACKOFF_MS);
}

async function fetchJsonWithTransientRetry(url, { fetcher, headers, wait, now }) {
  let transientRetries = 0;
  for (;;) {
    const attempt = await withHttpOperationDeadline(
      { timeoutMs: STATUS_REQUEST_TIMEOUT_MS, label: url },
      async (signal) => {
        const response = await fetcher(url, { cache: "no-store", headers, signal });
        if (!TRANSIENT_HTTP_STATUSES.has(response.status)) {
          return { done: true, value: await readJsonResponse(response, url) };
        }
        const status = response.status;
        const retryAfter = response.headers.get("Retry-After");
        try {
          await response.body?.cancel();
        } catch {
          /* discarded response */
        }
        return { done: false, status, retryAfter };
      }
    );
    if (attempt.done) return attempt.value;

    const { status, retryAfter } = attempt;
    if (transientRetries >= MAX_TRANSIENT_RETRIES_PER_CYCLE) {
      throw new Error(`Scan job status remained temporarily unavailable (HTTP ${status}).`);
    }
    transientRetries += 1;
    const fallback = Math.min(1_000 * 2 ** (transientRetries - 1), MAX_TRANSIENT_BACKOFF_MS);
    await wait(retryAfterMs(retryAfter, now()) ?? fallback);
  }
}

async function readJsonResponse(response, url) {
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    throw new Error(`Expected JSON from ${url}, got ${response.status}.`);
  }
  return readResponseJsonWithinLimit(response, {
    maxBytes: STATUS_RESPONSE_MAX_BYTES,
    label: url
  });
}

function sameOriginStatusUrl(baseUrl, statusPath) {
  const base = new URL(baseUrl);
  const resolved = new URL(statusPath, `${base.href.replace(/\/+$/, "")}/`);
  if (resolved.origin !== base.origin || !/^\/api\/scans\/[^/]+$/.test(resolved.pathname) || resolved.search || resolved.hash) {
    throw new Error("Scan job returned an invalid status path.");
  }
  return resolved.href;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
