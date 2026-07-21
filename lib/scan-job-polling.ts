import { readLoadedReport } from "./client-report-reader";
import { REPORT_ID_PATTERN } from "./report-validation";
import { recoverSavedReport } from "./saved-report-recovery";
import { readScanJobProgress } from "./scan-job-progress";
import type { LoadedReport } from "./scan-report-view";
import type { RuntimeScanJobApiResponse } from "./runtime-scan-report";
import type { ScanJobProgress } from "./types";

const TRANSIENT_HTTP_STATUSES = new Set([429, 502, 503]);
const MAX_TRANSIENT_BACKOFF_MS = 30_000;
const MAX_TRANSIENT_RETRIES_PER_CYCLE = 3;

export type ScanJobPollFetcher = (input: string, init: RequestInit) => Promise<Response>;
export type ScanJobPollWait = (ms: number, signal?: AbortSignal) => Promise<void>;

export type AcceptedScanJobPoll = {
  statusPath: string;
  accessKey?: string;
  reportId?: string;
  signal?: AbortSignal;
  resolveApiUrl?: (path: string) => string;
  fetcher?: ScanJobPollFetcher;
  wait?: ScanJobPollWait;
  now?: () => number;
  onProgress?: (progress: ScanJobProgress) => void;
};

/**
 * A definitive unsuccessful terminal state from the job coordinator. Poll
 * transport, auth, payload, and succeeded-but-unreadable report failures use
 * ordinary Error so the client retains recovery identifiers for retry/dismiss.
 */
export class ScanJobEndedError extends Error {
  readonly status: "failed" | "expired" | "cancelled";

  constructor(status: "failed" | "expired" | "cancelled", message: string) {
    super(message);
    this.name = "ScanJobEndedError";
    this.status = status;
  }
}

/**
 * Poll one already-accepted scan until the coordinator returns a terminal
 * state. There is intentionally no client-side attempt/time limit: durable
 * jobs have a 60-minute server deadline, and the server is authoritative for
 * expiry. A browser must not abandon a valid accepted capability after the
 * old 180-second in-memory window.
 */
export async function pollAcceptedScanJob(options: AcceptedScanJobPoll): Promise<LoadedReport> {
  const fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
  const wait = options.wait ?? abortableWait;
  const now = options.now ?? Date.now;
  const resolveApiUrl = options.resolveApiUrl ?? ((path: string) => path);
  const headers: Record<string, string> = {};
  if (options.accessKey) headers.Authorization = `Bearer ${options.accessKey}`;

  const savedReportId =
    options.reportId && REPORT_ID_PATTERN.test(options.reportId)
      ? options.reportId
      : scanJobIdFromStatusPath(options.statusPath);
  const startedAt = now();

  for (;;) {
    throwIfAborted(options.signal);
    const response = await fetchWithTransientRetry(resolveApiUrl(options.statusPath), {
      fetcher,
      headers,
      signal: options.signal,
      wait,
      now
    });
    const payload = await readJobPayload(response);

    if (!payload.ok) {
      if (response.status === 404 && savedReportId) {
        const recovered = await readSavedReportWithRetry(savedReportId, {
          fetcher,
          resolveApiUrl,
          signal: options.signal,
          wait,
          now
        });
        if (recovered) return recovered;
      }
      throw new Error(payload.error);
    }

    const progress = readScanJobProgress(payload.progress);
    if (progress) options.onProgress?.(progress);

    if (payload.status === "succeeded") {
      if (payload.report) {
        const read = await readLoadedReport(payload.report, "The completed scan's report");
        if (read.ok) return read.loaded;
        // The coordinator is done, but its public report may still be briefly
        // unavailable or unreadable. Keep recovery identifiers so the visitor
        // can retry the report read or explicitly dismiss this tab recovery.
        throw new Error(read.message);
      }
      if (savedReportId) {
        const recovered = await readSavedReportWithRetry(savedReportId, {
          fetcher,
          resolveApiUrl,
          signal: options.signal,
          wait,
          now
        });
        if (recovered) return recovered;
      }
      throw new Error("Completed scan did not include a readable report yet. Retry status checks shortly.");
    }

    if (payload.status === "failed" || payload.status === "expired" || payload.status === "cancelled") {
      throw new ScanJobEndedError(payload.status, payload.error || "Scan job did not complete.");
    }

    await wait(scanJobPollIntervalMs(now() - startedAt), options.signal);
  }
}

/** Back off long-lived jobs while keeping the first few minutes responsive. */
export function scanJobPollIntervalMs(elapsedMs: number): number {
  if (elapsedMs < 3 * 60_000) return 1_000;
  if (elapsedMs < 10 * 60_000) return 5_000;
  return 10_000;
}

/** Parse either Retry-After delta-seconds or an HTTP date. */
export function retryAfterMs(value: string | null, now = Date.now()): number | null {
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

export function scanJobIdFromStatusPath(statusPath: string): string | null {
  let pathname = statusPath;
  if (/^https?:\/\//i.test(statusPath)) {
    try {
      pathname = new URL(statusPath).pathname;
    } catch {
      return null;
    }
  }
  const match = pathname.match(/^\/api\/scans\/([^/]+)$/);
  const id = match?.[1] || "";
  return REPORT_ID_PATTERN.test(id) ? id : null;
}

type RetryContext = {
  fetcher: ScanJobPollFetcher;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  wait: ScanJobPollWait;
  now: () => number;
};

async function fetchWithTransientRetry(url: string, context: RetryContext): Promise<Response> {
  let transientRetries = 0;
  for (;;) {
    throwIfAborted(context.signal);
    const response = await context.fetcher(url, {
      cache: "no-store",
      headers: context.headers,
      signal: context.signal
    });
    if (!TRANSIENT_HTTP_STATUSES.has(response.status)) return response;

    const status = response.status;
    try {
      await response.body?.cancel();
    } catch {
      /* the response will be discarded either way */
    }

    // A retry budget belongs to one status/readback cycle, not to the accepted
    // job as a whole. Sustained coordinator trouble must return an ordinary
    // Error so the UI can expose Resume/Cancel while retaining the capability;
    // an explicit resume starts a fresh bounded budget.
    if (transientRetries >= MAX_TRANSIENT_RETRIES_PER_CYCLE) {
      throw new Error(`The scan service remained temporarily unavailable (HTTP ${status}).`);
    }
    transientRetries += 1;
    const fallback = Math.min(1_000 * 2 ** Math.min(transientRetries - 1, 10), MAX_TRANSIENT_BACKOFF_MS);
    const delay = retryAfterMs(response.headers.get("Retry-After"), context.now()) ?? fallback;
    await context.wait(delay, context.signal);
  }
}

async function readSavedReportWithRetry(
  reportId: string,
  context: Omit<RetryContext, "headers"> & { resolveApiUrl: (path: string) => string }
): Promise<LoadedReport | null> {
  const response = await fetchWithTransientRetry(context.resolveApiUrl(`/api/reports/${reportId}`), context);
  return recoverSavedReport(response);
}

async function readJobPayload(response: Response): Promise<RuntimeScanJobApiResponse> {
  try {
    const payload = (await response.json()) as unknown;
    if (payload && typeof payload === "object" && "ok" in payload) {
      const candidate = payload as Record<string, unknown>;
      if (candidate.ok === false && typeof candidate.error === "string") {
        return candidate as RuntimeScanJobApiResponse;
      }
      if (
        candidate.ok === true &&
        typeof candidate.jobId === "string" &&
        (candidate.status === "queued" ||
          candidate.status === "running" ||
          candidate.status === "succeeded" ||
          candidate.status === "failed" ||
          candidate.status === "expired" ||
          candidate.status === "cancelled")
      ) {
        return candidate as RuntimeScanJobApiResponse;
      }
    }
  } catch {
    /* named HTTP fallback below */
  }
  throw new Error(`The scan status could not be read (HTTP ${response.status}).`);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason ?? new DOMException("The scan was cancelled.", "AbortError");
}

function abortableWait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("The scan was cancelled.", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(signal?.reason ?? new DOMException("The scan was cancelled.", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
