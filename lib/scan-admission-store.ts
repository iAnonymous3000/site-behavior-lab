import { isScanJobId } from "./durable-scan-job-contract";
import type { DurableScanJobStoreSql } from "./durable-scan-job-store";
import {
  chargeScanAdmissionRecoveryRateLimit,
  commitPublicScanRateLimitedOperation,
  type PublicScanRateLimitResult,
  type PublicScanRateLimitCharge
} from "./public-scan-rate-limit-store";
import {
  SCAN_ADMISSION_TTL_MS,
  isScanAdmissionCommitment
} from "./scan-admission-capability";

export const SCAN_ADMISSION_MAX_ROWS = 500;

const SHA256_BYTES = 32;

type SqlValue = ArrayBuffer | string | number | null;

export type ScanAdmissionStoreKey = Readonly<{
  capabilityHash: ArrayBuffer;
  requestCommitment: string;
}>;

export type ScanAdmissionRegistration = Readonly<{
  jobId: string;
  reportId: string;
  totalRuns: 1 | 2;
  createdAt: number;
}>;

export type ScanAdmissionSnapshot = ScanAdmissionRegistration &
  Readonly<{
    expiresAt: number;
  }>;

export type IdempotentScanAdmissionCommit<T> =
  | { status: "committed"; admission: ScanAdmissionSnapshot; value: T }
  | { status: "recovered"; admission: ScanAdmissionSnapshot }
  | { status: "rate-limited"; retryAfterSeconds: number };

export type RateLimitedScanAdmissionLookup =
  | { status: "found"; admission: ScanAdmissionSnapshot }
  | { status: "not-found" }
  | { status: "conflict" }
  | { status: "rate-limited"; retryAfterSeconds: number };

type ScanAdmissionRow = Record<string, SqlValue> & {
  capability_hash: ArrayBuffer;
  request_commitment: string;
  job_id: string;
  report_id: string;
  total_runs: number;
  created_at: number;
  expires_at: number;
};

export class ScanAdmissionConflictError extends Error {
  readonly code = "conflict" as const;

  constructor() {
    super("This scan-admission capability is already bound to a different request.");
    this.name = "ScanAdmissionConflictError";
  }
}

export class ScanAdmissionCapacityError extends Error {
  readonly code = "capacity" as const;

  constructor() {
    super("The scan-admission recovery store is full.");
    this.name = "ScanAdmissionCapacityError";
  }
}

export class ScanAdmissionValidationError extends Error {
  readonly code = "validation" as const;

  constructor(message: string) {
    super(message);
    this.name = "ScanAdmissionValidationError";
  }
}

/**
 * Create the privacy-minimized admission-recovery table. It stores only a
 * capability digest, a capability-keyed semantic commitment, opaque job/report
 * capabilities, and bounded lifecycle metadata. Targets, request bodies,
 * access credentials, Turnstile tokens, and client identifiers never enter it.
 */
export function ensureScanAdmissionStore(sql: DurableScanJobStoreSql): void {
  sql.exec(
    `CREATE TABLE IF NOT EXISTS scan_admissions (
      capability_hash BLOB PRIMARY KEY CHECK(length(capability_hash) = ${SHA256_BYTES}),
      request_commitment TEXT NOT NULL CHECK(length(request_commitment) = 43),
      job_id TEXT NOT NULL UNIQUE,
      report_id TEXT NOT NULL UNIQUE,
      total_runs INTEGER NOT NULL CHECK(total_runs IN (1,2)),
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL CHECK(expires_at = created_at + ${SCAN_ADMISSION_TTL_MS})
    )`
  );
  sql.exec("CREATE INDEX IF NOT EXISTS scan_admissions_expiry ON scan_admissions(expires_at, created_at)");
}

/**
 * Resolve one browser-held admission capability. A matching capability with a
 * different semantic commitment is an affirmative conflict, never a cache
 * miss that could admit contradictory work.
 */
export function findScanAdmission(
  sql: DurableScanJobStoreSql,
  key: ScanAdmissionStoreKey,
  now: number
): ScanAdmissionSnapshot | null {
  ensureScanAdmissionStore(sql);
  assertStoreKey(key);
  assertTimestamp(now, "lookup timestamp");
  purgeExpiredScanAdmissions(sql, now);
  const row = selectByCapability(sql, key.capabilityHash);
  if (!row) return null;
  if (row.request_commitment !== key.requestCommitment) {
    throw new ScanAdmissionConflictError();
  }
  return snapshotFromRow(row);
}

/**
 * Public recovery's sole lookup boundary. The read token is consumed in the
 * caller's transaction before any scan-admission table purge or capability
 * lookup, so arbitrary valid-looking misses cannot exercise the singleton DO
 * without a finite per-client budget.
 */
export function findScanAdmissionRateLimited(
  sql: DurableScanJobStoreSql,
  key: ScanAdmissionStoreKey,
  clientHash: string,
  now: number
): RateLimitedScanAdmissionLookup {
  const charge: PublicScanRateLimitResult = chargeScanAdmissionRecoveryRateLimit(
    sql,
    clientHash,
    now
  );
  if (!charge.allowed) {
    return { status: "rate-limited", retryAfterSeconds: charge.retryAfterSeconds };
  }
  try {
    const admission = findScanAdmission(sql, key, now);
    return admission ? { status: "found", admission } : { status: "not-found" };
  } catch (error) {
    // Conflict is an ordinary, charged public lookup result. Letting it escape
    // the surrounding transaction would roll the read token back and turn a
    // stolen capability into an unmetered contradictory-probe path.
    if (error instanceof ScanAdmissionConflictError) return { status: "conflict" };
    throw error;
  }
}

/**
 * Bind a committed job exactly once. Callers that also charge quota and admit a
 * durable job must invoke this inside that same authoritative transaction.
 */
export function recordScanAdmission(
  sql: DurableScanJobStoreSql,
  key: ScanAdmissionStoreKey,
  registration: ScanAdmissionRegistration
): ScanAdmissionSnapshot {
  ensureScanAdmissionStore(sql);
  assertStoreKey(key);
  assertRegistration(registration);
  purgeExpiredScanAdmissions(sql, registration.createdAt);

  const existing = selectByCapability(sql, key.capabilityHash);
  if (existing) {
    if (
      existing.request_commitment !== key.requestCommitment ||
      existing.job_id !== registration.jobId ||
      existing.report_id !== registration.reportId ||
      existing.total_runs !== registration.totalRuns ||
      existing.created_at !== registration.createdAt
    ) {
      throw new ScanAdmissionConflictError();
    }
    return snapshotFromRow(existing);
  }

  const identityOwner = sql
    .exec<Record<string, SqlValue> & { capability_hash: ArrayBuffer }>(
      "SELECT capability_hash FROM scan_admissions WHERE job_id = ? OR report_id = ? LIMIT 1",
      registration.jobId,
      registration.reportId
    )
    .toArray()[0];
  if (identityOwner) throw new ScanAdmissionConflictError();

  const count = sql
    .exec<Record<string, SqlValue> & { count: number }>("SELECT COUNT(*) AS count FROM scan_admissions")
    .toArray()[0]?.count;
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new ScanAdmissionValidationError("The scan-admission row count is invalid.");
  }
  if (count >= SCAN_ADMISSION_MAX_ROWS) throw new ScanAdmissionCapacityError();

  const expiresAt = safeTimestampAdd(registration.createdAt, SCAN_ADMISSION_TTL_MS);
  sql.exec(
    "INSERT INTO scan_admissions (capability_hash, request_commitment, job_id, report_id, total_runs, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    key.capabilityHash,
    key.requestCommitment,
    registration.jobId,
    registration.reportId,
    registration.totalRuns,
    registration.createdAt,
    expiresAt
  );
  const inserted = selectByCapability(sql, key.capabilityHash);
  if (!inserted) {
    throw new ScanAdmissionValidationError("The scan admission was not recorded.");
  }
  return snapshotFromRow(inserted);
}

/**
 * The authoritative all-or-nothing admission seam. Exact replays return before
 * quota or the caller's job mutation; a first admission charges quota, commits
 * work, and records recovery linkage in the same surrounding transaction.
 */
export function commitIdempotentScanAdmission<T>(
  sql: DurableScanJobStoreSql,
  key: ScanAdmissionStoreKey,
  rateLimit: PublicScanRateLimitCharge,
  now: number,
  commit: () => Readonly<{ registration: ScanAdmissionRegistration; value: T }>,
  assertCommitStillAllowed?: () => void
): IdempotentScanAdmissionCommit<T> {
  const existing = findScanAdmission(sql, key, now);
  if (existing) return { status: "recovered", admission: existing };

  const committed = commitPublicScanRateLimitedOperation(
    sql,
    rateLimit,
    now,
    () => {
      const result = commit();
      const admission = recordScanAdmission(sql, key, result.registration);
      return { admission, value: result.value };
    },
    assertCommitStillAllowed
  );
  if (committed.status === "rate-limited") return committed;
  return {
    status: "committed",
    admission: committed.value.admission,
    value: committed.value.value
  };
}

export function purgeExpiredScanAdmissions(sql: DurableScanJobStoreSql, now: number): number {
  ensureScanAdmissionStore(sql);
  assertTimestamp(now, "purge timestamp");
  const expired = sql
    .exec<Record<string, SqlValue> & { count: number }>(
      "SELECT COUNT(*) AS count FROM scan_admissions WHERE expires_at <= ?",
      now
    )
    .toArray()[0]?.count;
  if (!Number.isSafeInteger(expired) || expired < 0) {
    throw new ScanAdmissionValidationError("The expired scan-admission row count is invalid.");
  }
  if (expired > 0) sql.exec("DELETE FROM scan_admissions WHERE expires_at <= ?", now);
  return expired;
}

function selectByCapability(
  sql: DurableScanJobStoreSql,
  capabilityHash: ArrayBuffer
): ScanAdmissionRow | null {
  return (
    sql
      .exec<ScanAdmissionRow>("SELECT * FROM scan_admissions WHERE capability_hash = ? LIMIT 1", capabilityHash)
      .toArray()[0] ?? null
  );
}

function snapshotFromRow(row: ScanAdmissionRow): ScanAdmissionSnapshot {
  if (
    !isScanJobId(row.job_id) ||
    !isScanJobId(row.report_id) ||
    row.job_id === row.report_id ||
    (row.total_runs !== 1 && row.total_runs !== 2) ||
    !isScanAdmissionCommitment(row.request_commitment)
  ) {
    throw new ScanAdmissionValidationError("The scan-admission row is invalid.");
  }
  assertTimestamp(row.created_at, "creation timestamp");
  assertTimestamp(row.expires_at, "expiry timestamp");
  if (row.expires_at !== safeTimestampAdd(row.created_at, SCAN_ADMISSION_TTL_MS)) {
    throw new ScanAdmissionValidationError("The scan-admission expiry is invalid.");
  }
  return Object.freeze({
    jobId: row.job_id,
    reportId: row.report_id,
    totalRuns: row.total_runs,
    createdAt: row.created_at,
    expiresAt: row.expires_at
  });
}

function assertStoreKey(key: ScanAdmissionStoreKey): void {
  if (
    !(key.capabilityHash instanceof ArrayBuffer) ||
    key.capabilityHash.byteLength !== SHA256_BYTES ||
    !isScanAdmissionCommitment(key.requestCommitment)
  ) {
    throw new ScanAdmissionValidationError("Invalid scan-admission store key.");
  }
}

function assertRegistration(registration: ScanAdmissionRegistration): void {
  if (
    !isScanJobId(registration.jobId) ||
    !isScanJobId(registration.reportId) ||
    registration.jobId === registration.reportId ||
    (registration.totalRuns !== 1 && registration.totalRuns !== 2)
  ) {
    throw new ScanAdmissionValidationError("Invalid scan-admission registration.");
  }
  assertTimestamp(registration.createdAt, "creation timestamp");
}

function assertTimestamp(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ScanAdmissionValidationError(`Invalid scan-admission ${label}.`);
  }
}

function safeTimestampAdd(value: number, delta: number): number {
  const result = value + delta;
  if (!Number.isSafeInteger(result) || result < value) {
    throw new ScanAdmissionValidationError("The scan-admission timestamp exceeds the safe range.");
  }
  return result;
}
