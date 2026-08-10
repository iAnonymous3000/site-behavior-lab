import { PublicScanError } from "./public-errors";
import { AUTHENTICATED_SCAN_RATE_LIMIT_PER_MINUTE } from "./public-scan-rate-limit-store";
import { scanAbortError } from "./scan-runtime";

export const MAX_BODY_BYTES = 4096;
export const MAX_CONCURRENT_SCANS = 2;
// Cap how many requests can park behind the active scans. The synchronous path
// only charges the rate limit after a slot is acquired, so without this bound a
// single burst could enqueue an unbounded number of 15-second waiters before any
// of them is rate-limited.
export const MAX_QUEUED_SCANS = MAX_CONCURRENT_SCANS * 4;
// Aggregate admission cap for the ASYNC job queue, across ALL clients. The
// per-client rate limit cannot bound the queue when many distinct clients each
// submit within their own allowance. Sized so the last admitted job still runs
// before the 60-minute job expiry at two workers and two runs per comparison.
export const MAX_QUEUED_JOBS = 32;
// PDF rendering runs a SECOND Chromium in the same instance, so its cap is
// derived from the scan cap rather than chosen: standard-2 is 6 GiB and the
// scanner's browser already accounts for ~2 GB of it (wrangler.container.jsonc).
// Scanning is the product; printing must never be able to claim as many
// renderers as scanning, so this stays strictly below MAX_CONCURRENT_SCANS and
// never rises above one. Raising the scan cap therefore cannot silently raise
// this one past what the instance holds.
export const MAX_CONCURRENT_REPORT_PDF_RENDERS = Math.min(1, MAX_CONCURRENT_SCANS - 1);
// A render is a browser navigation plus a PDF write, not a byte read, so it
// cannot share the report-read allowance: one client spending its 120 reads a
// minute on renders would hold the single render slot continuously and no other
// reader would ever get a PDF. Sized so a reader can retry a few times and
// download several reports in a sitting, and no more.
export const REPORT_PDF_RATE_LIMIT_MAX = 10;
export const QUEUE_TIMEOUT_MS = 15_000;
export const RATE_LIMIT_WINDOW_MS = 60_000;
export const RATE_LIMIT_MAX = AUTHENTICATED_SCAN_RATE_LIMIT_PER_MINUTE;
export const REPORT_READ_RATE_LIMIT_WINDOW_MS = 60_000;
export const REPORT_READ_RATE_LIMIT_MAX = 120;

const MAX_RATE_LIMIT_CLIENTS = 1_000;
const TRUST_PROXY_HEADERS_ENV = "SITE_BEHAVIOR_LAB_TRUST_PROXY_HEADERS";

type Waiter = {
  resolve: (release: () => void) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
};

const scanTimestampsByClient = new Map<string, number[]>();
const reportReadTimestampsByClient = new Map<string, number[]>();
const reportPdfTimestampsByClient = new Map<string, number[]>();
const queue: Waiter[] = [];
let activeScans = 0;
let lastRateLimitSweepMs = 0;
let lastReportReadLimitSweepMs = 0;
let lastReportPdfLimitSweepMs = 0;

export function assertRequestBodySize(request: Request): void {
  const contentLength = Number(request.headers.get("content-length") || "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    throw new PublicScanError("Request body is too large.", 413);
  }
}

export function peekRateLimit(clientKey: string, now = Date.now(), cost = 1): void {
  sweepRateLimitState(scanTimestampsByClient, now, RATE_LIMIT_WINDOW_MS, lastRateLimitSweepMs, (value) => {
    lastRateLimitSweepMs = value;
  });
  ensureRateLimitCapacity(scanTimestampsByClient, clientKey, now, RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX, cost, "Too many scan requests. Try again shortly.");
}

export function assertRateLimit(clientKey: string, now = Date.now(), cost = 1): void {
  peekRateLimit(clientKey, now, cost);
  chargeRateLimit(scanTimestampsByClient, clientKey, now, RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX, cost, "Too many scan requests. Try again shortly.");

  if (scanTimestampsByClient.size > MAX_RATE_LIMIT_CLIENTS) {
    pruneOldestRateLimitKeys(scanTimestampsByClient);
  }
}

export function assertReportReadRateLimit(clientKey: string, now = Date.now()): void {
  sweepRateLimitState(reportReadTimestampsByClient, now, REPORT_READ_RATE_LIMIT_WINDOW_MS, lastReportReadLimitSweepMs, (value) => {
    lastReportReadLimitSweepMs = value;
  });

  chargeRateLimit(
    reportReadTimestampsByClient,
    clientKey,
    now,
    REPORT_READ_RATE_LIMIT_WINDOW_MS,
    REPORT_READ_RATE_LIMIT_MAX,
    1,
    "Too many report requests. Try again shortly."
  );

  if (reportReadTimestampsByClient.size > MAX_RATE_LIMIT_CLIENTS) {
    pruneOldestRateLimitKeys(reportReadTimestampsByClient);
  }
}

/**
 * Charged on top of the report-read limit, in its own bucket.
 *
 * A PDF costs a browser navigation and a PDF write against a single render
 * slot, so it must not be admitted at the rate of a byte read. Deliberately a
 * separate map: exhausting the render allowance must not also lock a reader out
 * of the JSON their PDF request was never going to compete with.
 */
export function assertReportPdfRateLimit(clientKey: string, now = Date.now()): void {
  sweepRateLimitState(reportPdfTimestampsByClient, now, REPORT_READ_RATE_LIMIT_WINDOW_MS, lastReportPdfLimitSweepMs, (value) => {
    lastReportPdfLimitSweepMs = value;
  });

  chargeRateLimit(
    reportPdfTimestampsByClient,
    clientKey,
    now,
    REPORT_READ_RATE_LIMIT_WINDOW_MS,
    REPORT_PDF_RATE_LIMIT_MAX,
    1,
    "Too many PDF requests. Print the page from your browser, or try again shortly."
  );

  if (reportPdfTimestampsByClient.size > MAX_RATE_LIMIT_CLIENTS) {
    pruneOldestRateLimitKeys(reportPdfTimestampsByClient);
  }
}

export function clientKeyFromRequest(request: Request): string {
  return clientKeyFromHeaders(request.headers);
}

function clientKeyFromHeaders(headers: Pick<Headers, "get">): string {
  if (!trustProxyHeaders()) {
    return "local";
  }

  const realIp = headers.get("x-real-ip")?.trim();
  if (realIp) return realIp;

  const forwardedFor = headers
    .get("x-forwarded-for")
    ?.split(",")
    .map((part) => part.trim())
    .filter(Boolean);

  return forwardedFor?.[0] || "local";
}

export async function acquireScanSlot(queueTimeoutMs = QUEUE_TIMEOUT_MS, signal?: AbortSignal): Promise<() => void> {
  throwIfAborted(signal);
  if (activeScans < MAX_CONCURRENT_SCANS) {
    activeScans += 1;
    return makeRelease();
  }

  // Reject excess waiters immediately instead of parking them. This is the only
  // backpressure before the post-slot rate-limit charge, so a burst from one
  // client cannot create an unbounded pile of pending requests.
  if (queue.length >= MAX_QUEUED_SCANS) {
    throw new PublicScanError("Scanner is busy. Try again shortly.", 503);
  }

  return new Promise((resolve, reject) => {
    const waiter: Waiter = {
      resolve,
      reject,
      timer: setTimeout(() => {
        const index = queue.indexOf(waiter);
        if (index >= 0) queue.splice(index, 1);
        signal?.removeEventListener("abort", waiter.onAbort!);
        reject(new PublicScanError("Scanner is busy. Try again shortly.", 503));
      }, queueTimeoutMs),
      signal
    };

    waiter.onAbort = () => {
      const index = queue.indexOf(waiter);
      if (index < 0) return;
      queue.splice(index, 1);
      clearTimeout(waiter.timer);
      signal?.removeEventListener("abort", waiter.onAbort!);
      reject(abortReason(signal));
    };

    queue.push(waiter);
    signal?.addEventListener("abort", waiter.onAbort, { once: true });
    // Abort cannot normally interleave synchronous setup, but this also covers
    // non-standard AbortSignal implementations cleanly.
    if (signal?.aborted) waiter.onAbort();
  });
}

function releaseScanSlot(): void {
  const next = queue.shift();
  if (next) {
    clearTimeout(next.timer);
    next.signal?.removeEventListener("abort", next.onAbort!);
    next.resolve(makeRelease());
    return;
  }

  activeScans = Math.max(activeScans - 1, 0);
}

function makeRelease(): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseScanSlot();
  };
}

function ensureRateLimitCapacity(
  timestampsByClient: Map<string, number[]>,
  clientKey: string,
  now: number,
  windowMs: number,
  max: number,
  cost: number,
  message: string
): void {
  const cutoff = now - windowMs;
  const current = timestampsByClient.get(clientKey)?.filter((timestamp) => timestamp > cutoff) ?? [];
  const charge = Math.max(1, Math.floor(cost));

  if (current.length + charge > max) {
    throw new PublicScanError(message, 429);
  }
}

function chargeRateLimit(
  timestampsByClient: Map<string, number[]>,
  clientKey: string,
  now: number,
  windowMs: number,
  max: number,
  cost: number,
  message: string
): void {
  ensureRateLimitCapacity(timestampsByClient, clientKey, now, windowMs, max, cost, message);

  const cutoff = now - windowMs;
  const current = timestampsByClient.get(clientKey)?.filter((timestamp) => timestamp > cutoff) ?? [];
  const charge = Math.max(1, Math.floor(cost));
  current.push(...Array.from({ length: charge }, () => now));
  timestampsByClient.set(clientKey, current);
}

function sweepRateLimitState(
  timestampsByClient: Map<string, number[]>,
  now: number,
  windowMs: number,
  lastSweepMs: number,
  setLastSweepMs: (value: number) => void
): void {
  if (now - lastSweepMs < windowMs) return;

  const cutoff = now - windowMs;
  for (const [clientKey, timestamps] of timestampsByClient) {
    const fresh = timestamps.filter((timestamp) => timestamp > cutoff);
    if (fresh.length > 0) {
      timestampsByClient.set(clientKey, fresh);
    } else {
      timestampsByClient.delete(clientKey);
    }
  }

  setLastSweepMs(now);
}

function pruneOldestRateLimitKeys(timestampsByClient: Map<string, number[]>): void {
  const entries = Array.from(timestampsByClient.entries()).sort((a, b) => {
    const aLatest = Math.max(...a[1]);
    const bLatest = Math.max(...b[1]);
    return aLatest - bLatest;
  });

  for (const [clientKey] of entries.slice(0, timestampsByClient.size - MAX_RATE_LIMIT_CLIENTS)) {
    timestampsByClient.delete(clientKey);
  }
}

function trustProxyHeaders(): boolean {
  return process.env[TRUST_PROXY_HEADERS_ENV] === "1";
}

export function resetScanLimitStateForTests(): void {
  scanTimestampsByClient.clear();
  reportReadTimestampsByClient.clear();
  reportPdfTimestampsByClient.clear();
  for (const waiter of queue.splice(0, queue.length)) {
    clearTimeout(waiter.timer);
    waiter.signal?.removeEventListener("abort", waiter.onAbort!);
  }
  activeScans = 0;
  lastRateLimitSweepMs = 0;
  lastReportReadLimitSweepMs = 0;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}

function abortReason(signal?: AbortSignal): Error {
  return signal ? scanAbortError(signal) : new DOMException("The scan was cancelled.", "AbortError");
}

export function scanLimitStateForTests(): {
  activeScans: number;
  queuedScans: number;
  trackedClients: number;
  trackedReportReadClients: number;
} {
  return {
    activeScans,
    queuedScans: queue.length,
    trackedClients: scanTimestampsByClient.size,
    trackedReportReadClients: reportReadTimestampsByClient.size
  };
}
