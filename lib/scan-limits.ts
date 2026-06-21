import { PublicScanError } from "./public-errors";

export const MAX_BODY_BYTES = 4096;
export const MAX_CONCURRENT_SCANS = 2;
// Cap how many requests can park behind the active scans. The synchronous path
// only charges the rate limit after a slot is acquired, so without this bound a
// single burst could enqueue an unbounded number of 15-second waiters before any
// of them is rate-limited.
export const MAX_QUEUED_SCANS = MAX_CONCURRENT_SCANS * 4;
export const QUEUE_TIMEOUT_MS = 15_000;
export const RATE_LIMIT_WINDOW_MS = 60_000;
export const RATE_LIMIT_MAX = 20;
export const REPORT_READ_RATE_LIMIT_WINDOW_MS = 60_000;
export const REPORT_READ_RATE_LIMIT_MAX = 120;

const MAX_RATE_LIMIT_CLIENTS = 1_000;
const TRUST_PROXY_HEADERS_ENV = "SITE_BEHAVIOR_LAB_TRUST_PROXY_HEADERS";

type Waiter = {
  resolve: (release: () => void) => void;
  reject: (error: PublicScanError) => void;
  timer: ReturnType<typeof setTimeout>;
};

const scanTimestampsByClient = new Map<string, number[]>();
const reportReadTimestampsByClient = new Map<string, number[]>();
const queue: Waiter[] = [];
let activeScans = 0;
let lastRateLimitSweepMs = 0;
let lastReportReadLimitSweepMs = 0;

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

export async function acquireScanSlot(queueTimeoutMs = QUEUE_TIMEOUT_MS): Promise<() => void> {
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
        reject(new PublicScanError("Scanner is busy. Try again shortly.", 503));
      }, queueTimeoutMs)
    };

    queue.push(waiter);
  });
}

function releaseScanSlot(): void {
  const next = queue.shift();
  if (next) {
    clearTimeout(next.timer);
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
  queue.splice(0, queue.length);
  activeScans = 0;
  lastRateLimitSweepMs = 0;
  lastReportReadLimitSweepMs = 0;
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
