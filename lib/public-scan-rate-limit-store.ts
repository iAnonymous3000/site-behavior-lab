import type { DurableScanJobStoreSql } from "./durable-scan-job-store";

// Token-gated durable scans preserve the Node admission budget while moving
// its mutation into the authoritative DO transaction.
export const AUTHENTICATED_SCAN_RATE_LIMIT_PER_MINUTE = 20;
const AUTHENTICATED_SCAN_RATE_LIMIT_WINDOW_MS = 60_000;

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
 * Consume quota and run an admission mutation in the caller's transaction.
 * If the mutation throws, the transaction owner must roll both changes back.
 */
export function commitPublicScanRateLimitedOperation<T>(
  sql: DurableScanJobStoreSql,
  input: PublicScanRateLimitCharge,
  now: number,
  commit: () => T
): PublicScanRateLimitedCommit<T> {
  const charged = chargePublicScanRateLimit(sql, input, now);
  if (!charged.allowed) {
    return { status: "rate-limited", retryAfterSeconds: charged.retryAfterSeconds };
  }
  return { status: "committed", value: commit() };
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

  sql.exec(
    "CREATE TABLE IF NOT EXISTS public_scan_rate_limits (bucket TEXT PRIMARY KEY, used INTEGER NOT NULL, expires_at INTEGER NOT NULL)"
  );
  sql.exec("DELETE FROM public_scan_rate_limits WHERE expires_at <= ?", now);

  const windows = [
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
  sql.exec("DELETE FROM authenticated_scan_rate_limits WHERE charged_at <= ?", cutoff);

  const rows = sql
    .exec<{ charged_at: number; cost: number }>(
      "SELECT charged_at, cost FROM authenticated_scan_rate_limits WHERE client_hash = ? AND charged_at > ? ORDER BY charged_at ASC, id ASC",
      input.clientHash,
      cutoff
    )
    .toArray();
  let used = 0;
  for (const row of rows) {
    if (!Number.isSafeInteger(row.charged_at) || row.charged_at < 0 || (row.cost !== 1 && row.cost !== 2)) {
      throw new Error("Invalid authenticated scan rate-limit state.");
    }
    used += row.cost;
  }

  if (used + input.cost > input.perMinute) {
    let tokensToExpire = used + input.cost - input.perMinute;
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
  if (!consume) return { allowed: true };

  sql.exec(
    "INSERT INTO authenticated_scan_rate_limits (client_hash, charged_at, cost) VALUES (?, ?, ?)",
    input.clientHash,
    now,
    input.cost
  );
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
