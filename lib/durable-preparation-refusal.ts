import {
  DURABLE_PREPARATION_RESERVATION_MAX_MS,
  DURABLE_PREPARATION_RESERVATION_MAX_ROWS
} from "./durable-preparation-reservation";
import type { DurableScanJobStoreSql } from "./durable-scan-job-store";

/**
 * Remembers, for one admission window, that Node definitively refused to
 * prepare a capability's request, so a replay is answered without preparing it
 * again.
 *
 * The preparation reservation (lib/durable-preparation-reservation.ts) bounds
 * CONCURRENT replays to one. It is released when the attempt ends, and a
 * refusal commits nothing, so the committed-admission lookup that answers an
 * honest retry finds nothing either. Turnstile redemption is idempotent per
 * capability, so the same solved token could be replayed serially, each replay
 * buying a fresh preparation (including a DNS resolution of the target) at no
 * quota charge. A marker written while the reservation is still held closes
 * that: every later attempt in the window sees the marker before it can
 * reserve. This bounds a token to one preparation per admission window; it
 * does not remove the replay entirely.
 *
 * Only a definitive refusal of the request is recorded. A transient one (a 5xx,
 * a 429, a Node route not yet deployed) must stay retryable with the same
 * capability, because an honest client keeps it after an outcome it could not
 * read.
 *
 * Privacy: like the reservation table, this holds a capability digest and an
 * expiry. No target, refusal text, client identifier or token enters it, so the
 * answer to a replay is a fixed sentence and never the original refusal.
 */

const SHA256_BYTES = 32;

export const DURABLE_PREPARATION_REFUSAL_MAX_ROWS = DURABLE_PREPARATION_RESERVATION_MAX_ROWS;

export type DurablePreparationRefused = { status: "refused"; retryAfterSeconds: number };

export class DurablePreparationRefusalValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DurablePreparationRefusalValidationError";
  }
}

/**
 * Whether Node's answer to `/prepare` refused this exact request, as opposed to
 * failing for a reason a retry of the same request could outlive. 404 is a
 * container that predates the route, and 429 is a limit, not a verdict.
 */
export function isDefinitivePreparationRefusal(status: number): boolean {
  return Number.isSafeInteger(status) && status >= 400 && status < 500 && status !== 404 && status !== 429;
}

export function ensureDurablePreparationRefusalStore(sql: DurableScanJobStoreSql): void {
  sql.exec(
    `CREATE TABLE IF NOT EXISTS durable_preparation_refusals (
      capability_hash BLOB PRIMARY KEY CHECK(length(capability_hash) = ${SHA256_BYTES}),
      expires_at INTEGER NOT NULL
    )`
  );
  sql.exec(
    "CREATE INDEX IF NOT EXISTS durable_preparation_refusals_expiry ON durable_preparation_refusals(expires_at)"
  );
}

/**
 * Record the refusal until `expiresAt`, the admission deadline the refused
 * attempt was bound by, clamped exactly as a reservation is. Returns whether a
 * marker is now held. At capacity it records nothing: the table stays bounded
 * and that capability falls back to the reservation alone.
 *
 * Callers MUST run this inside the DO's `transactionSync`.
 */
export function recordDurablePreparationRefusal(
  sql: DurableScanJobStoreSql,
  capabilityHash: ArrayBuffer,
  now: number,
  expiresAt: number
): boolean {
  ensureDurablePreparationRefusalStore(sql);
  assertCapabilityHash(capabilityHash);
  assertTimestamp(now, "refusal timestamp");
  assertTimestamp(expiresAt, "refusal expiry");
  if (expiresAt <= now) return false;
  const boundedExpiresAt = Math.min(expiresAt, now + DURABLE_PREPARATION_RESERVATION_MAX_MS);

  purgeExpiredDurablePreparationRefusals(sql, now);
  const held = selectRefusalExpiry(sql, capabilityHash);
  if (held === null && countDurablePreparationRefusals(sql) >= DURABLE_PREPARATION_REFUSAL_MAX_ROWS) {
    return false;
  }
  sql.exec(
    `INSERT INTO durable_preparation_refusals (capability_hash, expires_at) VALUES (?, ?)
     ON CONFLICT(capability_hash) DO UPDATE SET expires_at = MAX(expires_at, excluded.expires_at)`,
    capabilityHash,
    boundedExpiresAt
  );
  return true;
}

/** Callers MUST run this inside the same `transactionSync` that reserves. */
export function findDurablePreparationRefusal(
  sql: DurableScanJobStoreSql,
  capabilityHash: ArrayBuffer,
  now: number
): DurablePreparationRefused | null {
  ensureDurablePreparationRefusalStore(sql);
  assertCapabilityHash(capabilityHash);
  assertTimestamp(now, "refusal lookup timestamp");
  purgeExpiredDurablePreparationRefusals(sql, now);
  const expiresAt = selectRefusalExpiry(sql, capabilityHash);
  if (expiresAt === null) return null;
  return { status: "refused", retryAfterSeconds: Math.max(1, Math.ceil((expiresAt - now) / 1000)) };
}

export function purgeExpiredDurablePreparationRefusals(sql: DurableScanJobStoreSql, now: number): void {
  ensureDurablePreparationRefusalStore(sql);
  assertTimestamp(now, "refusal purge timestamp");
  sql.exec("DELETE FROM durable_preparation_refusals WHERE expires_at <= ?", now);
}

export function countDurablePreparationRefusals(sql: DurableScanJobStoreSql): number {
  ensureDurablePreparationRefusalStore(sql);
  const count = sql
    .exec<{ count: number }>("SELECT COUNT(*) AS count FROM durable_preparation_refusals")
    .toArray()[0]?.count;
  if (!Number.isSafeInteger(count) || (count as number) < 0) {
    throw new DurablePreparationRefusalValidationError("The durable-preparation refusal count is invalid.");
  }
  return count as number;
}

function selectRefusalExpiry(sql: DurableScanJobStoreSql, capabilityHash: ArrayBuffer): number | null {
  const row = sql
    .exec<{ expires_at: number }>(
      "SELECT expires_at FROM durable_preparation_refusals WHERE capability_hash = ? LIMIT 1",
      capabilityHash
    )
    .toArray()[0];
  if (!row) return null;
  assertTimestamp(row.expires_at, "held refusal expiry");
  return row.expires_at;
}

function assertCapabilityHash(capabilityHash: ArrayBuffer): void {
  if (!(capabilityHash instanceof ArrayBuffer) || capabilityHash.byteLength !== SHA256_BYTES) {
    throw new DurablePreparationRefusalValidationError(
      "A durable preparation refusal requires a 32-byte capability digest."
    );
  }
}

function assertTimestamp(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new DurablePreparationRefusalValidationError(`The ${label} is invalid.`);
  }
}
