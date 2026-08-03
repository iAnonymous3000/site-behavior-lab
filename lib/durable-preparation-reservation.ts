import { DURABLE_SCAN_JOB_ADMISSION_TIMEOUT_MS } from "./durable-scan-job-edge-wiring";
import type { DurableScanJobStoreSql } from "./durable-scan-job-store";

/**
 * Bounds concurrent UNCOMMITTED durable preparations to one per admission
 * capability. This closes the activation gate that stood in front of
 * `SITE_BEHAVIOR_LAB_DURABLE_JOBS=1` (docs/scan-job-model.md, "Activation gate:
 * bound in-flight uncommitted preparations").
 *
 * The durable admission path preflights quota with a *peek* and charges it
 * atomically only at commit time, inside the Durable Object. Quota integrity
 * was never in doubt: the DO serializes the commits and rejects the surplus.
 * What was unbounded is the work in between. Turnstile redemption is idempotent
 * per capability by design, so one solved token replayed N times concurrently
 * cleared the peek N times, performed preparation N times (including a fresh
 * DNS resolution of the caller's target each time), and only then lost the
 * race. The preparation cost amplified by whatever concurrency the caller
 * chose, for the price of a single solved challenge.
 *
 * A reservation is taken in the same authoritative DO that commits, after the
 * committed-admission recovery lookup and before the crossing to Node, and is
 * released in a `finally`. So the honest retry of a lost response still
 * recovers through the committed-admission path without ever reaching here, and
 * a concurrent replay is refused before it can buy any preparation work.
 *
 * Privacy: the table holds a capability digest and two timestamps. No target,
 * request body, client identifier, or Turnstile token enters it.
 */

const SHA256_BYTES = 32;

/**
 * A reservation expires with the operation that holds it. The caller passes the
 * deadline its own admission attempt is already bound by, and this ceiling
 * refuses a nonsensically distant one, so a crashed isolate can strand a
 * capability for at most one admission window rather than indefinitely.
 */
export const DURABLE_PREPARATION_RESERVATION_MAX_MS = DURABLE_SCAN_JOB_ADMISSION_TIMEOUT_MS;

/**
 * Bounds the table under adversarial churn. Reservations are short-lived and
 * purged on every call, so reaching this means many distinct capabilities are
 * preparing at once; refusing the surplus is the same answer the queue cap
 * gives, and it keeps the singleton DO's storage bounded.
 */
export const DURABLE_PREPARATION_RESERVATION_MAX_ROWS = 200;

export type DurablePreparationReservation =
  | { status: "reserved"; expiresAt: number }
  /** Another preparation holds this exact capability right now. */
  | { status: "in-flight"; retryAfterSeconds: number }
  /** Too many distinct capabilities are preparing concurrently. */
  | { status: "at-capacity"; retryAfterSeconds: number }
  /**
   * The caller's admission window had already elapsed on THIS clock.
   *
   * The deadline is stamped at the edge and evaluated here, so the only way to
   * reach this without a genuinely slow round trip is the two machines
   * disagreeing about the time. That is a transient condition the caller can
   * retry, not a malformed request, and it must not surface as a server error.
   */
  | { status: "window-elapsed"; retryAfterSeconds: number };

export class DurablePreparationReservationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DurablePreparationReservationValidationError";
  }
}

export function ensureDurablePreparationReservationStore(sql: DurableScanJobStoreSql): void {
  sql.exec(
    `CREATE TABLE IF NOT EXISTS durable_preparations (
      capability_hash BLOB PRIMARY KEY CHECK(length(capability_hash) = ${SHA256_BYTES}),
      reserved_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL CHECK(expires_at > reserved_at)
    )`
  );
  sql.exec(
    "CREATE INDEX IF NOT EXISTS durable_preparations_expiry ON durable_preparations(expires_at, reserved_at)"
  );
}

/**
 * Take the single preparation slot for one capability, or report who holds it.
 * Callers MUST run this inside the DO's `transactionSync` so the check and the
 * insert are one atomic step; a read-then-write here would reintroduce exactly
 * the race it exists to close.
 */
export function reserveDurablePreparation(
  sql: DurableScanJobStoreSql,
  capabilityHash: ArrayBuffer,
  now: number,
  expiresAt: number
): DurablePreparationReservation {
  ensureDurablePreparationReservationStore(sql);
  assertCapabilityHash(capabilityHash);
  assertTimestamp(now, "reservation timestamp");
  assertTimestamp(expiresAt, "reservation expiry");
  if (expiresAt <= now) {
    return { status: "window-elapsed", retryAfterSeconds: 1 };
  }
  // The ceiling exists to bound how long a crashed isolate can strand a
  // capability. Clamping enforces that bound exactly, where refusing enforced
  // it only by failing the request: the caller stamps its deadline on the edge
  // clock and this reads its own, so a DO running behind saw a healthy
  // 30-second window as an over-long one and answered a correct admission with
  // an opaque 500, after the Turnstile token had already been redeemed.
  const boundedExpiresAt = Math.min(expiresAt, now + DURABLE_PREPARATION_RESERVATION_MAX_MS);

  purgeExpiredDurablePreparations(sql, now);

  const held = sql
    .exec<{ expires_at: number }>(
      "SELECT expires_at FROM durable_preparations WHERE capability_hash = ? LIMIT 1",
      capabilityHash
    )
    .toArray()[0];
  if (held) {
    assertTimestamp(held.expires_at, "held reservation expiry");
    return { status: "in-flight", retryAfterSeconds: retryAfterSeconds(held.expires_at, now) };
  }

  if (countDurablePreparations(sql) >= DURABLE_PREPARATION_RESERVATION_MAX_ROWS) {
    // Every surviving row is unexpired, so the soonest any slot frees is the
    // nearest expiry. Reporting that is honest and never advertises zero.
    const soonest = sql
      .exec<{ expires_at: number }>("SELECT MIN(expires_at) AS expires_at FROM durable_preparations")
      .toArray()[0]?.expires_at;
    return {
      status: "at-capacity",
      retryAfterSeconds:
        typeof soonest === "number" && Number.isSafeInteger(soonest)
          ? retryAfterSeconds(soonest, now)
          : Math.ceil(DURABLE_PREPARATION_RESERVATION_MAX_MS / 1000)
    };
  }

  sql.exec(
    "INSERT INTO durable_preparations (capability_hash, reserved_at, expires_at) VALUES (?, ?, ?)",
    capabilityHash,
    now,
    boundedExpiresAt
  );
  return { status: "reserved", expiresAt: boundedExpiresAt };
}

/**
 * Free the slot. Releasing a capability that holds none is deliberately not an
 * error: the release runs in a `finally`, and a caller that failed before
 * reserving must not turn its own earlier failure into a second one.
 *
 * `reservedExpiresAt` is the `expiresAt` the caller's own reservation returned,
 * and it fences the delete to that one reservation. The release runs in a
 * `finally` that also covers the aborted-deadline path, so by construction it
 * can land after its own row already expired, was purged, and was replaced by a
 * successor's. Deleting by capability alone frees that successor's live slot
 * and lets a third replay buy a second concurrent preparation, which is exactly
 * the bound this module exists to hold. Expiries for one capability are
 * strictly increasing (a successor may only reserve once the predecessor's
 * expiry has passed, and its own expiry is later still), so the stored expiry
 * identifies the reservation exactly.
 *
 * Omitting it keeps the older unfenced delete for a caller that does not yet
 * name its reservation; such a caller keeps the stale-release exposure above.
 */
export function releaseDurablePreparation(
  sql: DurableScanJobStoreSql,
  capabilityHash: ArrayBuffer,
  reservedExpiresAt?: number
): void {
  ensureDurablePreparationReservationStore(sql);
  assertCapabilityHash(capabilityHash);
  if (reservedExpiresAt === undefined) {
    sql.exec("DELETE FROM durable_preparations WHERE capability_hash = ?", capabilityHash);
    return;
  }
  assertTimestamp(reservedExpiresAt, "released reservation expiry");
  sql.exec(
    "DELETE FROM durable_preparations WHERE capability_hash = ? AND expires_at = ?",
    capabilityHash,
    reservedExpiresAt
  );
}

export function purgeExpiredDurablePreparations(sql: DurableScanJobStoreSql, now: number): number {
  ensureDurablePreparationReservationStore(sql);
  assertTimestamp(now, "purge timestamp");
  const expired = sql
    .exec<{ count: number }>("SELECT COUNT(*) AS count FROM durable_preparations WHERE expires_at <= ?", now)
    .toArray()[0]?.count;
  if (!Number.isSafeInteger(expired) || expired < 0) {
    throw new DurablePreparationReservationValidationError(
      "The expired durable-preparation row count is invalid."
    );
  }
  if (expired > 0) sql.exec("DELETE FROM durable_preparations WHERE expires_at <= ?", now);
  return expired;
}

export function countDurablePreparations(sql: DurableScanJobStoreSql): number {
  ensureDurablePreparationReservationStore(sql);
  const count = sql
    .exec<{ count: number }>("SELECT COUNT(*) AS count FROM durable_preparations")
    .toArray()[0]?.count;
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new DurablePreparationReservationValidationError("The durable-preparation row count is invalid.");
  }
  return count;
}

function retryAfterSeconds(expiresAt: number, now: number): number {
  return Math.max(1, Math.ceil((expiresAt - now) / 1000));
}

function assertCapabilityHash(capabilityHash: ArrayBuffer): void {
  if (!(capabilityHash instanceof ArrayBuffer) || capabilityHash.byteLength !== SHA256_BYTES) {
    throw new DurablePreparationReservationValidationError(
      "A durable preparation reservation requires a 32-byte capability digest."
    );
  }
}

function assertTimestamp(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new DurablePreparationReservationValidationError(`The ${label} is invalid.`);
  }
}
