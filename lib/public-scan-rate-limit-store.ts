import type { DurableScanJobStoreSql } from "./durable-scan-job-store";
import {
  REPORT_READ_GLOBAL_RATE_LIMIT_PER_MINUTE,
  REPORT_READ_RATE_LIMIT_PER_MINUTE
} from "./report-read-edge";

// Token-gated durable scans preserve the Node admission budget while moving
// its mutation into the authoritative DO transaction.
export const AUTHENTICATED_SCAN_RATE_LIMIT_PER_MINUTE = 20;
const AUTHENTICATED_SCAN_RATE_LIMIT_WINDOW_MS = 60_000;
export const PUBLIC_SCAN_GLOBAL_RATE_LIMIT_PER_MINUTE = 600;
export const PUBLIC_SCAN_GLOBAL_RATE_LIMIT_PER_DAY = 30_000;
export const AUTHENTICATED_SCAN_GLOBAL_RATE_LIMIT_PER_MINUTE = 600;
export const DURABLE_SCAN_JOB_READ_RATE_LIMIT_PER_MINUTE = 120;
export const DURABLE_SCAN_JOB_READ_GLOBAL_RATE_LIMIT_PER_MINUTE = 1_200;
export const ENCRYPTED_WATCH_READ_RATE_LIMIT_PER_MINUTE = 120;
export const ENCRYPTED_WATCH_READ_GLOBAL_RATE_LIMIT_PER_MINUTE = 600;
export const SCAN_ADMISSION_RECOVERY_RATE_LIMIT_PER_MINUTE = 30;
export const SCAN_ADMISSION_RECOVERY_GLOBAL_RATE_LIMIT_PER_MINUTE = 300;
export const PUBLIC_SCAN_RATE_LIMIT_CLEANUP_MAX_ROWS = 64;
export const SCAN_ADMISSION_RECOVERY_CLEANUP_MAX_ROWS = PUBLIC_SCAN_RATE_LIMIT_CLEANUP_MAX_ROWS;

export type PublicScanRateLimitCharge = Readonly<{
  scope: "public" | "authenticated";
  clientHash: string;
  cost: 1 | 2;
  perMinute: number;
  perDay: number | null;
}>;

export type PublicScanRateLimitResult =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

export type PublicScanRateLimitedCommit<T> =
  | { status: "committed"; value: T }
  | { status: "rate-limited"; retryAfterSeconds: number };

type FixedWindow = Readonly<{
  bucket: string;
  limit: number;
  expiresAt: number;
  retryAfterSeconds: number;
}>;

export function publicScanRateLimitChargeMatchesCost(
  input: PublicScanRateLimitCharge,
  expectedCost: 1 | 2
): boolean {
  return input.cost === expectedCost;
}

/** Read the exact quota decision without consuming it. */
export function peekPublicScanRateLimit(
  sql: DurableScanJobStoreSql,
  input: PublicScanRateLimitCharge,
  now: number
): PublicScanRateLimitResult {
  return evaluatePublicScanRateLimit(sql, input, now, false);
}

/** Check and consume both configured quota windows in the caller's transaction. */
export function chargePublicScanRateLimit(
  sql: DurableScanJobStoreSql,
  input: PublicScanRateLimitCharge,
  now: number
): PublicScanRateLimitResult {
  return evaluatePublicScanRateLimit(sql, input, now, true);
}

/**
 * Bound accountless admission-recovery probes in dedicated per-client and
 * global buckets. This is deliberately separate from scan quota and ordinary
 * status polling: one legitimate ambiguous-submit recovery costs exactly one
 * read token in each scope and never consumes a scan token. The global bucket
 * prevents rotating client identities from creating unbounded rows or work.
 */
export function chargeScanAdmissionRecoveryRateLimit(
  sql: DurableScanJobStoreSql,
  clientHash: string,
  now: number
): PublicScanRateLimitResult {
  if (!/^[a-f0-9]{64}$/.test(clientHash)) {
    throw new Error("Invalid scan-admission recovery client hash.");
  }
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new Error("Invalid scan-admission recovery rate-limit timestamp.");
  }

  ensurePublicScanRateLimitStore(sql);
  cleanupExpiredPublicScanRateLimits(sql, now);
  const durationMs = 60_000;
  const windowId = Math.floor(now / durationMs);
  const expiresAt = (windowId + 1) * durationMs;
  const windows = [
    {
      bucket: `scan-admission-recovery-global/${windowId}`,
      limit: SCAN_ADMISSION_RECOVERY_GLOBAL_RATE_LIMIT_PER_MINUTE
    },
    {
      bucket: `scan-admission-recovery/${windowId}/${clientHash}`,
      limit: SCAN_ADMISSION_RECOVERY_RATE_LIMIT_PER_MINUTE
    }
  ];
  const charges: Array<{ bucket: string; used: number }> = [];
  let exceeded = false;
  for (const window of windows) {
    const used =
      sql
        .exec<{ used: number }>(
          "SELECT used FROM public_scan_rate_limits WHERE bucket = ? AND expires_at > ?",
          window.bucket,
          now
        )
        .toArray()[0]?.used ?? 0;
    if (!Number.isSafeInteger(used) || used < 0) {
      throw new Error("Invalid scan-admission recovery rate-limit state.");
    }
    if (used + 1 > window.limit) exceeded = true;
    else charges.push({ bucket: window.bucket, used: used + 1 });
  }
  if (exceeded) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((expiresAt - now) / 1_000))
    };
  }
  for (const charge of charges) {
    sql.exec(
      "INSERT INTO public_scan_rate_limits (bucket, used, expires_at) VALUES (?, ?, ?) ON CONFLICT(bucket) DO UPDATE SET used = excluded.used, expires_at = excluded.expires_at",
      charge.bucket,
      charge.used,
      expiresAt
    );
  }
  return { allowed: true };
}

/**
 * Bound public capability/status reads in both a per-client and global window.
 * The global row is evaluated first and no per-client row is created after the
 * singleton-wide ceiling has been reached, bounding rotating-identity growth.
 */
export function chargeDurableScanJobReadRateLimit(
  sql: DurableScanJobStoreSql,
  clientHash: string,
  now: number
): PublicScanRateLimitResult {
  return chargeBoundedReadRateLimit(sql, {
    namespace: "durable-status",
    clientHash,
    perClient: DURABLE_SCAN_JOB_READ_RATE_LIMIT_PER_MINUTE,
    global: DURABLE_SCAN_JOB_READ_GLOBAL_RATE_LIMIT_PER_MINUTE,
    now
  });
}

export function chargeEncryptedWatchReadRateLimit(
  sql: DurableScanJobStoreSql,
  clientHash: string,
  now: number
): PublicScanRateLimitResult {
  return chargeBoundedReadRateLimit(sql, {
    namespace: "encrypted-watch-read",
    clientHash,
    perClient: ENCRYPTED_WATCH_READ_RATE_LIMIT_PER_MINUTE,
    global: ENCRYPTED_WATCH_READ_GLOBAL_RATE_LIMIT_PER_MINUTE,
    now
  });
}

/**
 * Charge every server-rendered report representation against one combined
 * namespace. A client cannot multiply its allowance across HTML, RSC, Open
 * Graph, and Twitter-card paths, while the global bucket bounds rotating-IP
 * cache-miss and render amplification.
 */
export function chargeReportReadRateLimit(
  sql: DurableScanJobStoreSql,
  clientHash: string,
  now: number
): PublicScanRateLimitResult {
  return chargeBoundedReadRateLimit(sql, {
    namespace: "report-read",
    clientHash,
    perClient: REPORT_READ_RATE_LIMIT_PER_MINUTE,
    global: REPORT_READ_GLOBAL_RATE_LIMIT_PER_MINUTE,
    now
  });
}

/**
 * Consume quota and run an admission mutation in the caller's transaction.
 * If the mutation throws, the transaction owner must roll both changes back.
 */
export function commitPublicScanRateLimitedOperation<T>(
  sql: DurableScanJobStoreSql,
  input: PublicScanRateLimitCharge,
  now: number,
  commit: () => T,
  assertCommitStillAllowed?: () => void
): PublicScanRateLimitedCommit<T> {
  const charged = chargePublicScanRateLimit(sql, input, now);
  if (!charged.allowed) {
    return { status: "rate-limited", retryAfterSeconds: charged.retryAfterSeconds };
  }
  const value = commit();
  // The transaction owner can place a final authoritative clock/cancellation
  // fence here. A thrown assertion rolls quota and every callback mutation
  // back together; exact recoveries and rate-limit refusals never invoke it.
  assertCommitStillAllowed?.();
  return { status: "committed", value };
}

function evaluatePublicScanRateLimit(
  sql: DurableScanJobStoreSql,
  input: PublicScanRateLimitCharge,
  now: number,
  consume: boolean
): PublicScanRateLimitResult {
  assertPublicScanRateLimitCharge(input);
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new Error("Invalid public-scan rate-limit timestamp.");
  }
  if (input.scope === "authenticated") {
    return evaluateAuthenticatedRollingRateLimit(sql, input, now, consume);
  }

  ensurePublicScanRateLimitStore(sql);
  cleanupExpiredPublicScanRateLimits(sql, now);

  const windows = [
    atomicGlobalRateLimitWindow("public-scan", "minute", 60_000, PUBLIC_SCAN_GLOBAL_RATE_LIMIT_PER_MINUTE, now),
    atomicGlobalRateLimitWindow("public-scan", "day", 86_400_000, PUBLIC_SCAN_GLOBAL_RATE_LIMIT_PER_DAY, now),
    atomicRateLimitWindow(input, "minute", 60_000, input.perMinute, now),
    ...(input.perDay === null
      ? []
      : [atomicRateLimitWindow(input, "day", 86_400_000, input.perDay, now)])
  ];
  const exceeded: number[] = [];
  const charges: Array<{ bucket: string; used: number; expiresAt: number }> = [];

  for (const window of windows) {
    const row = sql
      .exec<{ used: number }>(
        "SELECT used FROM public_scan_rate_limits WHERE bucket = ? AND expires_at > ?",
        window.bucket,
        now
      )
      .toArray()[0];
    const used = row?.used ?? 0;
    if (used + input.cost > window.limit) {
      exceeded.push(window.retryAfterSeconds);
    } else {
      charges.push({ bucket: window.bucket, used: used + input.cost, expiresAt: window.expiresAt });
    }
  }

  if (exceeded.length > 0) {
    return { allowed: false, retryAfterSeconds: Math.max(...exceeded) };
  }
  if (!consume) return { allowed: true };

  for (const charge of charges) {
    sql.exec(
      "INSERT INTO public_scan_rate_limits (bucket, used, expires_at) VALUES (?, ?, ?) ON CONFLICT(bucket) DO UPDATE SET used = excluded.used, expires_at = excluded.expires_at",
      charge.bucket,
      charge.used,
      charge.expiresAt
    );
  }
  return { allowed: true };
}

function evaluateAuthenticatedRollingRateLimit(
  sql: DurableScanJobStoreSql,
  input: PublicScanRateLimitCharge,
  now: number,
  consume: boolean
): PublicScanRateLimitResult {
  const cutoff = now - AUTHENTICATED_SCAN_RATE_LIMIT_WINDOW_MS;
  sql.exec(
    "CREATE TABLE IF NOT EXISTS authenticated_scan_rate_limits (id INTEGER PRIMARY KEY AUTOINCREMENT, client_hash TEXT NOT NULL, charged_at INTEGER NOT NULL, cost INTEGER NOT NULL CHECK(cost IN (1,2)))"
  );
  sql.exec(
    "CREATE INDEX IF NOT EXISTS authenticated_scan_rate_limits_client_time ON authenticated_scan_rate_limits(client_hash, charged_at, id)"
  );
  sql.exec(
    "CREATE INDEX IF NOT EXISTS authenticated_scan_rate_limits_time ON authenticated_scan_rate_limits(charged_at, id)"
  );
  sql.exec(
    `DELETE FROM authenticated_scan_rate_limits WHERE id IN (
      SELECT id FROM authenticated_scan_rate_limits
      WHERE charged_at <= ?
      ORDER BY charged_at ASC, id ASC
      LIMIT ${PUBLIC_SCAN_RATE_LIMIT_CLEANUP_MAX_ROWS}
    )`,
    cutoff
  );

  const rows = sql
    .exec<{ charged_at: number; cost: number }>(
      `SELECT charged_at, cost FROM authenticated_scan_rate_limits
       WHERE client_hash = ? AND charged_at > ?
       ORDER BY charged_at ASC, id ASC
       LIMIT ${AUTHENTICATED_SCAN_RATE_LIMIT_PER_MINUTE + 1}`,
      input.clientHash,
      cutoff
    )
    .toArray();
  const globalRows = sql
    .exec<{ charged_at: number; cost: number }>(
      `SELECT charged_at, cost FROM authenticated_scan_rate_limits
       WHERE charged_at > ?
       ORDER BY charged_at ASC, id ASC
       LIMIT ${AUTHENTICATED_SCAN_GLOBAL_RATE_LIMIT_PER_MINUTE + 1}`,
      cutoff
    )
    .toArray();
  const globalDecision = evaluateRollingEventWindow(
    globalRows,
    input.cost,
    AUTHENTICATED_SCAN_GLOBAL_RATE_LIMIT_PER_MINUTE,
    now
  );
  if (!globalDecision.allowed) return globalDecision;

  const clientDecision = evaluateRollingEventWindow(rows, input.cost, input.perMinute, now);
  if (!clientDecision.allowed) return clientDecision;
  if (!consume) return { allowed: true };

  sql.exec(
    "INSERT INTO authenticated_scan_rate_limits (client_hash, charged_at, cost) VALUES (?, ?, ?)",
    input.clientHash,
    now,
    input.cost
  );
  return { allowed: true };
}

function evaluateRollingEventWindow(
  rows: readonly Readonly<{ charged_at: number; cost: number }>[],
  cost: number,
  limit: number,
  now: number
): PublicScanRateLimitResult {
  let used = 0;
  for (const row of rows) {
    if (!Number.isSafeInteger(row.charged_at) || row.charged_at < 0 || (row.cost !== 1 && row.cost !== 2)) {
      throw new Error("Invalid authenticated scan rate-limit state.");
    }
    used += row.cost;
  }
  if (used + cost <= limit) return { allowed: true };

  let tokensToExpire = used + cost - limit;
  let retryAt = now + AUTHENTICATED_SCAN_RATE_LIMIT_WINDOW_MS;
  for (const row of rows) {
    tokensToExpire -= row.cost;
    retryAt = row.charged_at + AUTHENTICATED_SCAN_RATE_LIMIT_WINDOW_MS;
    if (tokensToExpire <= 0) break;
  }
  return {
    allowed: false,
    retryAfterSeconds: Math.max(1, Math.ceil((retryAt - now) / 1_000))
  };
}

function chargeBoundedReadRateLimit(
  sql: DurableScanJobStoreSql,
  input: Readonly<{
    namespace: "durable-status" | "encrypted-watch-read" | "report-read";
    clientHash: string;
    perClient: number;
    global: number;
    now: number;
  }>
): PublicScanRateLimitResult {
  if (!/^[a-f0-9]{64}$/.test(input.clientHash)) {
    throw new Error("Invalid public read-rate-limit client hash.");
  }
  if (!Number.isSafeInteger(input.now) || input.now < 0) {
    throw new Error("Invalid public read-rate-limit timestamp.");
  }
  ensurePublicScanRateLimitStore(sql);
  cleanupExpiredPublicScanRateLimits(sql, input.now);
  const durationMs = 60_000;
  const windowId = Math.floor(input.now / durationMs);
  const expiresAt = (windowId + 1) * durationMs;
  const retryAfterSeconds = Math.max(1, Math.ceil((expiresAt - input.now) / 1_000));
  return evaluateFixedWindows(
    sql,
    [
      {
        bucket: `${input.namespace}-global/${windowId}`,
        limit: input.global,
        expiresAt,
        retryAfterSeconds
      },
      {
        bucket: `${input.namespace}/${windowId}/${input.clientHash}`,
        limit: input.perClient,
        expiresAt,
        retryAfterSeconds
      }
    ],
    input.now,
    true
  );
}

function ensurePublicScanRateLimitStore(sql: DurableScanJobStoreSql): void {
  sql.exec(
    "CREATE TABLE IF NOT EXISTS public_scan_rate_limits (bucket TEXT PRIMARY KEY, used INTEGER NOT NULL CHECK(used >= 0), expires_at INTEGER NOT NULL CHECK(expires_at >= 0))"
  );
  sql.exec(
    "CREATE INDEX IF NOT EXISTS public_scan_rate_limits_expiry ON public_scan_rate_limits (expires_at, bucket)"
  );
}

function cleanupExpiredPublicScanRateLimits(sql: DurableScanJobStoreSql, now: number): void {
  sql.exec(
    `DELETE FROM public_scan_rate_limits WHERE bucket IN (
      SELECT bucket FROM public_scan_rate_limits
      WHERE expires_at <= ?
      ORDER BY expires_at ASC, bucket ASC
      LIMIT ${PUBLIC_SCAN_RATE_LIMIT_CLEANUP_MAX_ROWS}
    )`,
    now
  );
}

function evaluateFixedWindows(
  sql: DurableScanJobStoreSql,
  windows: readonly FixedWindow[],
  now: number,
  consume: boolean,
  cost = 1
): PublicScanRateLimitResult {
  if (!Number.isSafeInteger(cost) || cost <= 0) throw new Error("Invalid fixed-window rate-limit cost.");
  const charges: Array<{ window: FixedWindow; used: number }> = [];
  const exceeded: number[] = [];
  for (const window of windows) {
    const used =
      sql
        .exec<{ used: number }>(
          "SELECT used FROM public_scan_rate_limits WHERE bucket = ? AND expires_at > ?",
          window.bucket,
          now
        )
        .toArray()[0]?.used ?? 0;
    if (!Number.isSafeInteger(used) || used < 0) throw new Error("Invalid fixed-window rate-limit state.");
    if (used + cost > window.limit) exceeded.push(window.retryAfterSeconds);
    else charges.push({ window, used: used + cost });
  }
  if (exceeded.length > 0) {
    return { allowed: false, retryAfterSeconds: Math.max(...exceeded) };
  }
  if (!consume) return { allowed: true };
  for (const charge of charges) {
    sql.exec(
      "INSERT INTO public_scan_rate_limits (bucket, used, expires_at) VALUES (?, ?, ?) ON CONFLICT(bucket) DO UPDATE SET used = excluded.used, expires_at = excluded.expires_at",
      charge.window.bucket,
      charge.used,
      charge.window.expiresAt
    );
  }
  return { allowed: true };
}

export function assertPublicScanRateLimitCharge(input: PublicScanRateLimitCharge): void {
  if (!input || typeof input !== "object") {
    throw new Error("Invalid public-scan rate-limit charge.");
  }
  if (input.scope !== "public" && input.scope !== "authenticated") {
    throw new Error("Invalid public-scan rate-limit scope.");
  }
  if (!/^[a-f0-9]{64}$/.test(input.clientHash)) {
    throw new Error("Invalid public-scan client hash.");
  }
  if (input.cost !== 1 && input.cost !== 2) {
    throw new Error("Invalid public-scan rate-limit charge.");
  }
  if (
    !Number.isSafeInteger(input.perMinute) ||
    input.perMinute <= 0 ||
    (input.perDay !== null && (!Number.isSafeInteger(input.perDay) || input.perDay <= 0))
  ) {
    throw new Error("Invalid public-scan rate-limit configuration.");
  }
  if (
    (input.scope === "authenticated" &&
      (input.perMinute !== AUTHENTICATED_SCAN_RATE_LIMIT_PER_MINUTE || input.perDay !== null)) ||
    (input.scope === "public" && input.perDay === null)
  ) {
    throw new Error("Invalid public-scan rate-limit policy.");
  }
}

function atomicRateLimitWindow(
  input: PublicScanRateLimitCharge,
  name: "minute" | "day",
  durationMs: number,
  limit: number,
  now: number
): { bucket: string; expiresAt: number; limit: number; retryAfterSeconds: number } {
  const windowId = Math.floor(now / durationMs);
  const expiresAt = (windowId + 1) * durationMs;
  // Keep the established public bucket names stable. Authenticated traffic has
  // its own ledger so a deployment-mode change cannot mix the two policies.
  const scope = input.scope === "public" ? "" : "authenticated/";
  return {
    bucket: `${scope}${name}/${windowId}/${input.clientHash}`,
    expiresAt,
    limit,
    retryAfterSeconds: Math.max(1, Math.ceil((expiresAt - now) / 1_000))
  };
}

function atomicGlobalRateLimitWindow(
  namespace: "public-scan" | "authenticated-scan",
  name: "minute" | "day",
  durationMs: number,
  limit: number,
  now: number
): FixedWindow {
  const windowId = Math.floor(now / durationMs);
  const expiresAt = (windowId + 1) * durationMs;
  return {
    bucket: `${namespace}-global/${name}/${windowId}`,
    expiresAt,
    limit,
    retryAfterSeconds: Math.max(1, Math.ceil((expiresAt - now) / 1_000))
  };
}
