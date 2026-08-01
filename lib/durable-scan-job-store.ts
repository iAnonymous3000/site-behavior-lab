import { isCanonicalTimestamp } from "./canonical-timestamp";
import {
  DURABLE_SCAN_JOB_ENCRYPTION_KEY_ENV,
  DURABLE_SCAN_JOB_RECONCILIATION_TIMEOUT_MS,
  DURABLE_SCAN_JOB_PUBLICATION_SETTLEMENT_MS,
  DURABLE_SCAN_JOB_PUBLICATION_TIMEOUT_MS,
  isDurableScanJobPayload,
  isScanJobId,
  type DurableScanJobPayload
} from "./durable-scan-job-contract";

export {
  DURABLE_SCAN_JOB_ENCRYPTION_KEY_ENV,
  DURABLE_SCAN_JOBS_ENV,
  type DurableScanJobPayload,
  type DurableScanJobPayloadV1
} from "./durable-scan-job-contract";

export const DURABLE_SCAN_JOB_KEY_ID = "v1" as const;
export const DURABLE_SCAN_JOB_PAYLOAD_VERSION = 1 as const;
export const DURABLE_SCAN_JOB_MAX_NONTERMINAL = 32;
export const DURABLE_SCAN_JOB_MAX_ROWS = 500;
export const DURABLE_SCAN_JOB_DEADLINE_MS = 60 * 60 * 1_000;
export const DURABLE_SCAN_JOB_PURGE_MS = 75 * 60 * 1_000;
export const DURABLE_SCAN_JOB_LEASE_MS = 180 * 1_000;
export const DURABLE_SCAN_JOB_MAX_ATTEMPTS = 2;

const KEY_BASE64URL_LENGTH = 43;
const NONCE_BYTES = 12;
const LEASE_TOKEN_BYTES = 32;
const SHA256_BYTES = 32;
const MAX_PAYLOAD_PLAINTEXT_BYTES = 4_608;
const DURABLE_SCAN_JOB_SCHEMA_VERSION = 1;
const MAX_PAYLOAD_CIPHERTEXT_BYTES = MAX_PAYLOAD_PLAINTEXT_BYTES + 16;
const MAX_PUBLICATION_MANIFEST_BYTES = 16 * 1_024;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const TERMINAL_REASON_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const CONTENT_VERSION_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const NONTERMINAL_STATES = ["queued", "leased", "publishing"] as const;
const TERMINAL_STATES = ["succeeded", "failed", "expired", "cancelled"] as const;
const PUBLICATION_MANIFEST_KEYS = [
  "canonicalizationVersion",
  "manifestVersion",
  "publicDigest",
  "redactionVersion",
  "reportBytes",
  "reportId",
  "reportWireSha256",
  "retention",
  "sidecarWire"
] as const;
const PUBLICATION_SIDECAR_KEYS = [
  "canonicalizationVersion",
  "createdAt",
  "expiresAt",
  "publicDigest",
  "redactionVersion",
  "reportId",
  "writtenAt"
] as const;

const issuedLeaseCredentials = new WeakMap<
  object,
  Readonly<{ token: string; tokenHash: ArrayBuffer }>
>();

type SqlValue = ArrayBuffer | string | number | null;

/** The synchronous subset shared by Durable Object SQLite and the test adapter. */
export interface DurableScanJobStoreSql {
  exec<T extends Record<string, SqlValue>>(
    query: string,
    ...bindings: SqlValue[]
  ): { toArray(): T[] };
}

export type DurableScanJobState =
  | (typeof NONTERMINAL_STATES)[number]
  | (typeof TERMINAL_STATES)[number];

export type DurableScanJobPublicationManifest = string;

export type DurableScanJobEncryptionKey = Readonly<{
  keyId: typeof DURABLE_SCAN_JOB_KEY_ID;
  cryptoKey: CryptoKey;
}>;

export type DurableScanJobEnvelope = Readonly<{
  version: typeof DURABLE_SCAN_JOB_PAYLOAD_VERSION;
  keyId: typeof DURABLE_SCAN_JOB_KEY_ID;
  nonce: ArrayBuffer;
  ciphertext: ArrayBuffer;
}>;

export type DurableScanJobAdmission = Readonly<{
  jobId: string;
  reportId: string;
  createdAt: number;
  deadlineAt: number;
  purgeAt: number;
  totalRuns: 1 | 2;
  envelope: DurableScanJobEnvelope;
}>;

export type DurableScanJobSnapshot = Readonly<{
  jobId: string;
  reportId: string;
  state: DurableScanJobState;
  createdAt: number;
  deadlineAt: number;
  purgeAt: number;
  totalRuns: 1 | 2;
  attemptCount: number;
  leaseGeneration: number;
  leaseExpiresAt: number | null;
  publicationManifest: DurableScanJobPublicationManifest | null;
  terminalReason: string | null;
  finishedAt: number | null;
  updatedAt: number;
}>;

export type DurableScanJobLeaseCredential = Readonly<{
  token: string;
  tokenHash: ArrayBuffer;
}>;

export type DurableScanJobClaim = Readonly<{
  jobId: string;
  reportId: string;
  state: "leased";
  createdAt: number;
  deadlineAt: number;
  purgeAt: number;
  totalRuns: 1 | 2;
  attemptCount: number;
  leaseGeneration: number;
  leaseExpiresAt: number;
  leaseToken: string;
  envelope: DurableScanJobEnvelope;
}>;

export type DurableScanJobStateErrorCode = "not-found" | "conflict" | "lease-invalid";

export class DurableScanJobStateError extends Error {
  constructor(
    public readonly code: DurableScanJobStateErrorCode,
    message: string,
    public readonly currentState: DurableScanJobState | null = null
  ) {
    super(message);
    this.name = "DurableScanJobStateError";
  }
}

export class DurableScanJobCapacityError extends Error {
  readonly code = "capacity" as const;

  constructor() {
    super("The durable scan-job queue is full.");
    this.name = "DurableScanJobCapacityError";
  }
}

export class DurableScanJobValidationError extends Error {
  readonly code = "validation" as const;

  constructor(message: string) {
    super(message);
    this.name = "DurableScanJobValidationError";
  }
}

export class DurableScanJobCryptoError extends Error {
  readonly code = "crypto" as const;

  constructor(message: string) {
    super(message);
    this.name = "DurableScanJobCryptoError";
  }
}

type AdmissionInput = Readonly<{
  jobId: string;
  reportId: string;
  createdAt: number;
  payload: DurableScanJobPayload;
}>;

type LeaseMutationInput = Readonly<{
  jobId: string;
  generation: number;
  tokenHash: ArrayBuffer;
  now: number;
}>;

type DurableScanJobRow = Record<string, SqlValue> & {
  job_id: string;
  report_id: string;
  state: string;
  created_at: number;
  deadline_at: number;
  purge_at: number;
  total_runs: number;
  attempt_count: number;
  lease_generation: number;
  lease_token_hash: ArrayBuffer | null;
  lease_expires_at: number | null;
  payload_version: number;
  payload_key_id: string | null;
  payload_nonce: ArrayBuffer | null;
  payload_ciphertext: ArrayBuffer | null;
  publication_manifest: string | null;
  terminal_reason: string | null;
  finished_at: number | null;
  updated_at: number;
};

export async function importDurableScanJobEncryptionKey(encoded: string): Promise<DurableScanJobEncryptionKey> {
  if (typeof encoded !== "string" || encoded.length !== KEY_BASE64URL_LENGTH || !BASE64URL_PATTERN.test(encoded)) {
    throw new DurableScanJobValidationError(
      `${DURABLE_SCAN_JOB_ENCRYPTION_KEY_ENV} must be canonical unpadded base64url for exactly 32 bytes.`
    );
  }
  const bytes = decodeCanonicalBase64Url(encoded, KEY_BASE64URL_LENGTH, 32, "durable scan-job encryption key");
  try {
    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      copyArrayBuffer(bytes),
      { name: "AES-GCM" },
      false,
      ["encrypt", "decrypt"]
    );
    return Object.freeze({ keyId: DURABLE_SCAN_JOB_KEY_ID, cryptoKey });
  } catch {
    throw new DurableScanJobCryptoError("The durable scan-job encryption key could not be imported.");
  }
}

export async function createDurableScanJobAdmission(
  key: DurableScanJobEncryptionKey,
  input: AdmissionInput,
  randomBytes: (length: number) => Uint8Array = secureRandomBytes
): Promise<DurableScanJobAdmission> {
  assertEncryptionKey(key);
  assertJobIdentity(input.jobId, input.reportId);
  assertTimestamp(input.createdAt, "admission timestamp");
  const payload = canonicalPayload(input.payload);
  if (payload.admittedAt !== input.createdAt) {
    throw new DurableScanJobValidationError("The durable payload admission timestamp does not match the row timestamp.");
  }
  const totalRuns = totalRunsForPayload(payload);
  const deadlineAt = safeTimestampAdd(input.createdAt, DURABLE_SCAN_JOB_DEADLINE_MS, "job deadline");
  const purgeAt = safeTimestampAdd(input.createdAt, DURABLE_SCAN_JOB_PURGE_MS, "job purge timestamp");
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  if (plaintext.byteLength > MAX_PAYLOAD_PLAINTEXT_BYTES) {
    throw new DurableScanJobValidationError("The durable scan-job payload is too large.");
  }
  const nonce = randomBytes(NONCE_BYTES);
  if (!(nonce instanceof Uint8Array) || nonce.byteLength !== NONCE_BYTES) {
    throw new DurableScanJobValidationError("The durable scan-job nonce source returned an invalid nonce.");
  }
  const context = { ...input, payload, deadlineAt, totalRuns };
  try {
    const ciphertext = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: copyArrayBuffer(nonce),
        additionalData: durableScanJobAdditionalData(context),
        tagLength: 128
      },
      key.cryptoKey,
      plaintext
    );
    if (ciphertext.byteLength < 16 || ciphertext.byteLength > MAX_PAYLOAD_CIPHERTEXT_BYTES) {
      throw new DurableScanJobCryptoError("The encrypted durable scan-job payload has an invalid size.");
    }
    return Object.freeze({
      jobId: input.jobId,
      reportId: input.reportId,
      createdAt: input.createdAt,
      deadlineAt,
      purgeAt,
      totalRuns,
      envelope: Object.freeze({
        version: DURABLE_SCAN_JOB_PAYLOAD_VERSION,
        keyId: key.keyId,
        nonce: copyArrayBuffer(nonce),
        ciphertext: copyArrayBuffer(ciphertext)
      })
    });
  } catch (error) {
    if (error instanceof DurableScanJobCryptoError) throw error;
    throw new DurableScanJobCryptoError("The durable scan-job payload could not be encrypted.");
  }
}

export async function decryptDurableScanJobClaim(
  key: DurableScanJobEncryptionKey,
  claim: DurableScanJobClaim
): Promise<DurableScanJobPayload> {
  assertEncryptionKey(key);
  assertClaim(claim);
  if (claim.envelope.keyId !== key.keyId) {
    throw new DurableScanJobCryptoError("The durable scan-job payload uses an unavailable encryption key.");
  }
  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: claim.envelope.nonce,
        additionalData: durableScanJobAdditionalData({
          jobId: claim.jobId,
          reportId: claim.reportId,
          createdAt: claim.createdAt,
          deadlineAt: claim.deadlineAt,
          totalRuns: claim.totalRuns,
          payloadVersion: claim.envelope.version
        }),
        tagLength: 128
      },
      key.cryptoKey,
      claim.envelope.ciphertext
    );
    if (plaintext.byteLength > MAX_PAYLOAD_PLAINTEXT_BYTES) {
      throw new DurableScanJobValidationError("The decrypted durable scan-job payload is too large.");
    }
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
    const parsed: unknown = JSON.parse(decoded);
    const payload = canonicalPayload(parsed);
    if (payload.admittedAt !== claim.createdAt || totalRunsForPayload(payload) !== claim.totalRuns) {
      throw new DurableScanJobValidationError("The decrypted durable scan-job payload does not match its row metadata.");
    }
    return payload;
  } catch (error) {
    if (error instanceof DurableScanJobValidationError) throw error;
    throw new DurableScanJobCryptoError("The durable scan-job payload could not be authenticated and decrypted.");
  }
}

export async function createDurableScanJobLeaseCredentials(
  count: number,
  randomBytes: (length: number) => Uint8Array = secureRandomBytes
): Promise<DurableScanJobLeaseCredential[]> {
  if (!Number.isSafeInteger(count) || count < 0 || count > DURABLE_SCAN_JOB_MAX_NONTERMINAL) {
    throw new DurableScanJobValidationError("Invalid durable scan-job lease credential count.");
  }
  const credentials: DurableScanJobLeaseCredential[] = [];
  const seen = new Set<string>();
  while (credentials.length < count) {
    const bytes = randomBytes(LEASE_TOKEN_BYTES);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== LEASE_TOKEN_BYTES) {
      throw new DurableScanJobValidationError("The durable scan-job token source returned an invalid token.");
    }
    const token = encodeBase64Url(bytes);
    if (seen.has(token)) continue;
    seen.add(token);
    const tokenHash = await sha256(bytes);
    const credential = Object.freeze({ token, tokenHash: copyArrayBuffer(tokenHash) });
    issuedLeaseCredentials.set(
      credential,
      Object.freeze({ token, tokenHash: copyArrayBuffer(tokenHash) })
    );
    credentials.push(credential);
  }
  return credentials;
}

export async function hashDurableScanJobLeaseToken(token: string): Promise<ArrayBuffer> {
  const bytes = decodeCanonicalBase64Url(token, KEY_BASE64URL_LENGTH, LEASE_TOKEN_BYTES, "durable scan-job lease token");
  return sha256(bytes);
}

/** Create the Phase-2 table without mutating the Phase-1 registry. */
export function ensureDurableScanJobStore(sql: DurableScanJobStoreSql): void {
  sql.exec(
    "CREATE TABLE IF NOT EXISTS durable_scan_job_schema (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), version INTEGER NOT NULL)"
  );
  sql.exec(
    "INSERT OR IGNORE INTO durable_scan_job_schema (singleton, version) VALUES (1, ?)",
    DURABLE_SCAN_JOB_SCHEMA_VERSION
  );
  const schemaVersion = sql
    .exec<Record<string, SqlValue> & { version: number }>(
      "SELECT version FROM durable_scan_job_schema WHERE singleton = 1 LIMIT 1"
    )
    .toArray()[0]?.version;
  if (schemaVersion !== DURABLE_SCAN_JOB_SCHEMA_VERSION) {
    throw new DurableScanJobValidationError("Unsupported durable scan-job store schema version.");
  }
  sql.exec(
    `CREATE TABLE IF NOT EXISTS durable_scan_jobs (
      job_id TEXT PRIMARY KEY,
      report_id TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL CHECK(state IN ('queued','leased','publishing','succeeded','failed','expired','cancelled')),
      created_at INTEGER NOT NULL,
      deadline_at INTEGER NOT NULL CHECK(deadline_at = created_at + ${DURABLE_SCAN_JOB_DEADLINE_MS}),
      purge_at INTEGER NOT NULL CHECK(purge_at = created_at + ${DURABLE_SCAN_JOB_PURGE_MS}),
      total_runs INTEGER NOT NULL CHECK(total_runs IN (1,2)),
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count BETWEEN 0 AND ${DURABLE_SCAN_JOB_MAX_ATTEMPTS}),
      lease_generation INTEGER NOT NULL DEFAULT 0 CHECK(lease_generation >= 0),
      lease_token_hash BLOB,
      lease_expires_at INTEGER,
      payload_version INTEGER NOT NULL CHECK(payload_version = ${DURABLE_SCAN_JOB_PAYLOAD_VERSION}),
      payload_key_id TEXT,
      payload_nonce BLOB,
      payload_ciphertext BLOB,
      publication_manifest TEXT,
      terminal_reason TEXT,
      finished_at INTEGER,
      updated_at INTEGER NOT NULL,
      CHECK(
        (state = 'queued' AND payload_key_id IS NOT NULL AND length(payload_nonce) = ${NONCE_BYTES} AND payload_ciphertext IS NOT NULL AND lease_token_hash IS NULL AND lease_expires_at IS NULL AND publication_manifest IS NULL AND terminal_reason IS NULL AND finished_at IS NULL)
        OR (state = 'leased' AND payload_key_id IS NOT NULL AND length(payload_nonce) = ${NONCE_BYTES} AND payload_ciphertext IS NOT NULL AND length(lease_token_hash) = ${SHA256_BYTES} AND lease_expires_at IS NOT NULL AND publication_manifest IS NULL AND terminal_reason IS NULL AND finished_at IS NULL)
        OR (state = 'publishing' AND payload_key_id IS NOT NULL AND length(payload_nonce) = ${NONCE_BYTES} AND payload_ciphertext IS NOT NULL AND length(lease_token_hash) = ${SHA256_BYTES} AND lease_expires_at IS NOT NULL AND publication_manifest IS NOT NULL AND terminal_reason IS NULL AND finished_at IS NULL)
        OR (state IN ('succeeded','failed','expired','cancelled') AND payload_key_id IS NULL AND payload_nonce IS NULL AND payload_ciphertext IS NULL AND lease_token_hash IS NULL AND lease_expires_at IS NULL AND publication_manifest IS NULL AND finished_at IS NOT NULL)
      )
    )`
  );
  sql.exec(
    "CREATE INDEX IF NOT EXISTS durable_scan_jobs_fifo ON durable_scan_jobs(state, created_at, job_id)"
  );
  sql.exec(
    "CREATE INDEX IF NOT EXISTS durable_scan_jobs_lease_expiry ON durable_scan_jobs(state, lease_expires_at, job_id)"
  );
  sql.exec(
    "CREATE INDEX IF NOT EXISTS durable_scan_jobs_deadline ON durable_scan_jobs(deadline_at, job_id)"
  );
  sql.exec(
    "CREATE INDEX IF NOT EXISTS durable_scan_jobs_purge ON durable_scan_jobs(purge_at, job_id)"
  );
}

/** Caller must invoke this synchronous operation inside the DO transactionSync boundary. */
export function preflightDurableScanJobAdmission(
  sql: DurableScanJobStoreSql,
  admission: DurableScanJobAdmission
): void {
  ensureDurableScanJobStore(sql);
  assertAdmission(admission);
  const existing = selectRow(sql, admission.jobId);
  if (existing) {
    throw new DurableScanJobStateError("conflict", "The durable scan job already exists.", rowState(existing));
  }
  const reportOwner = sql
    .exec<Record<string, SqlValue> & { job_id: string }>(
      "SELECT job_id FROM durable_scan_jobs WHERE report_id = ? LIMIT 1",
      admission.reportId
    )
    .toArray()[0];
  if (reportOwner) {
    throw new DurableScanJobStateError("conflict", "The durable report ID is already assigned.", null);
  }
  evictTerminalRowsToTarget(sql, DURABLE_SCAN_JOB_MAX_ROWS - 1);
  const totalRows = durableScanJobRowCount(sql);
  if (totalRows >= DURABLE_SCAN_JOB_MAX_ROWS) {
    throw new DurableScanJobCapacityError();
  }
  const count = sql
    .exec<Record<string, SqlValue> & { count: number }>(
      "SELECT COUNT(*) AS count FROM durable_scan_jobs WHERE state IN ('queued','leased','publishing')"
    )
    .toArray()[0]?.count;
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new DurableScanJobStateError("conflict", "The durable queue count could not be read.", null);
  }
  if (count >= DURABLE_SCAN_JOB_MAX_NONTERMINAL) throw new DurableScanJobCapacityError();
}

/** Caller must invoke this synchronous operation inside the DO transactionSync boundary. */
export function admitDurableScanJob(
  sql: DurableScanJobStoreSql,
  admission: DurableScanJobAdmission
): DurableScanJobSnapshot {
  preflightDurableScanJobAdmission(sql, admission);

  sql.exec(
    `INSERT INTO durable_scan_jobs (
      job_id, report_id, state, created_at, deadline_at, purge_at, total_runs,
      attempt_count, lease_generation, lease_token_hash, lease_expires_at,
      payload_version, payload_key_id, payload_nonce, payload_ciphertext,
      publication_manifest, terminal_reason, finished_at, updated_at
    ) VALUES (?, ?, 'queued', ?, ?, ?, ?, 0, 0, NULL, NULL, ?, ?, ?, ?, NULL, NULL, NULL, ?)`,
    admission.jobId,
    admission.reportId,
    admission.createdAt,
    admission.deadlineAt,
    admission.purgeAt,
    admission.totalRuns,
    admission.envelope.version,
    admission.envelope.keyId,
    admission.envelope.nonce,
    admission.envelope.ciphertext,
    admission.createdAt
  );
  return snapshotFromRow(requireRow(sql, admission.jobId));
}

export function findDurableScanJobSnapshot(
  sql: DurableScanJobStoreSql,
  jobId: string
): DurableScanJobSnapshot | null {
  if (!isScanJobId(jobId)) return null;
  ensureDurableScanJobStore(sql);
  const row = selectRow(sql, jobId);
  return row ? snapshotFromRow(row) : null;
}

/** FIFO claim. Credentials are prepared asynchronously before entering transactionSync. */
export function claimDurableScanJobs(
  sql: DurableScanJobStoreSql,
  input: Readonly<{
    now: number;
    capacity: number;
    credentials: readonly DurableScanJobLeaseCredential[];
  }>
): DurableScanJobClaim[] {
  ensureDurableScanJobStore(sql);
  assertTimestamp(input.now, "claim timestamp");
  if (
    !Number.isSafeInteger(input.capacity) ||
    input.capacity < 0 ||
    input.capacity > DURABLE_SCAN_JOB_MAX_NONTERMINAL ||
    input.credentials.length < input.capacity
  ) {
    throw new DurableScanJobValidationError("Invalid durable scan-job claim capacity.");
  }
  const activeCount = sql
    .exec<Record<string, SqlValue> & { count: number }>(
      "SELECT COUNT(*) AS count FROM durable_scan_jobs WHERE state IN ('leased','publishing')"
    )
    .toArray()[0]?.count;
  if (!Number.isSafeInteger(activeCount) || activeCount < 0) {
    throw new DurableScanJobStateError("conflict", "The active durable queue count could not be read.", null);
  }
  const availableCapacity = Math.max(0, input.capacity - activeCount);
  const credentials = input.credentials.slice(0, availableCapacity);
  assertLeaseCredentials(credentials);
  const rows = sql
    .exec<DurableScanJobRow>(
      "SELECT * FROM durable_scan_jobs WHERE state = 'queued' AND deadline_at > ? AND attempt_count < ? ORDER BY created_at ASC, job_id ASC LIMIT ?",
      input.now,
      DURABLE_SCAN_JOB_MAX_ATTEMPTS,
      availableCapacity
    )
    .toArray();
  const claims: DurableScanJobClaim[] = [];
  rows.forEach((row, index) => {
    const credential = credentials[index];
    const generation = integer(row.lease_generation, "lease generation") + 1;
    const attemptCount = integer(row.attempt_count, "attempt count") + 1;
    const leaseExpiresAt = Math.min(
      safeTimestampAdd(input.now, DURABLE_SCAN_JOB_LEASE_MS, "lease expiry"),
      integer(row.deadline_at, "deadline")
    );
    sql.exec(
      `UPDATE durable_scan_jobs
       SET state = 'leased', attempt_count = ?, lease_generation = ?, lease_token_hash = ?,
           lease_expires_at = ?, publication_manifest = NULL, updated_at = ?
       WHERE job_id = ? AND state = 'queued' AND attempt_count = ? AND lease_generation = ? AND deadline_at > ?`,
      attemptCount,
      generation,
      credential.tokenHash,
      leaseExpiresAt,
      input.now,
      row.job_id,
      attemptCount - 1,
      generation - 1,
      input.now
    );
    const claimed = requireRow(sql, row.job_id);
    if (
      claimed.state !== "leased" ||
      claimed.attempt_count !== attemptCount ||
      claimed.lease_generation !== generation ||
      !equalBytes(requireBlob(claimed.lease_token_hash, "lease token hash"), credential.tokenHash)
    ) {
      throw new DurableScanJobStateError("conflict", "The durable scan job could not be claimed.", rowState(claimed));
    }
    claims.push(claimFromRow(claimed, credential.token));
  });
  return claims;
}

export function heartbeatDurableScanJob(
  sql: DurableScanJobStoreSql,
  input: LeaseMutationInput
): DurableScanJobSnapshot {
  ensureDurableScanJobStore(sql);
  const row = requireCurrentLease(sql, input, ["leased", "publishing"]);
  const leaseCeiling =
    rowState(row) === "publishing"
      ? row.deadline_at -
        DURABLE_SCAN_JOB_PUBLICATION_SETTLEMENT_MS -
        DURABLE_SCAN_JOB_RECONCILIATION_TIMEOUT_MS
      : row.deadline_at;
  if (leaseCeiling <= input.now) {
    throw new DurableScanJobStateError(
      "lease-invalid",
      "The durable scan-job lease cannot cross its publication settlement fence.",
      rowState(row)
    );
  }
  const leaseExpiresAt = Math.min(
    safeTimestampAdd(input.now, DURABLE_SCAN_JOB_LEASE_MS, "lease expiry"),
    leaseCeiling
  );
  sql.exec(
    "UPDATE durable_scan_jobs SET lease_expires_at = ?, updated_at = ? WHERE job_id = ? AND lease_generation = ? AND lease_expires_at > ? AND deadline_at > ?",
    leaseExpiresAt,
    input.now,
    input.jobId,
    input.generation,
    input.now,
    input.now
  );
  return snapshotFromRow(requireRow(sql, input.jobId));
}

export function beginPublishingDurableScanJob(
  sql: DurableScanJobStoreSql,
  input: LeaseMutationInput & Readonly<{ manifest: DurableScanJobPublicationManifest }>
): DurableScanJobSnapshot {
  ensureDurableScanJobStore(sql);
  const leased = requireCurrentLease(sql, input, ["leased"]);
  assertPublicationManifest(input.manifest, leased.report_id);
  const minimumDeadline = safeTimestampAdd(
    input.now,
    DURABLE_SCAN_JOB_PUBLICATION_TIMEOUT_MS +
      DURABLE_SCAN_JOB_PUBLICATION_SETTLEMENT_MS +
      DURABLE_SCAN_JOB_RECONCILIATION_TIMEOUT_MS,
    "minimum publication deadline"
  );
  if (leased.deadline_at < minimumDeadline) {
    throw new DurableScanJobStateError(
      "conflict",
      "The durable scan job is too close to its deadline to begin publication.",
      "leased"
    );
  }
  const leaseExpiresAt = Math.min(
    safeTimestampAdd(input.now, DURABLE_SCAN_JOB_LEASE_MS, "publication lease expiry"),
    leased.deadline_at -
      DURABLE_SCAN_JOB_PUBLICATION_SETTLEMENT_MS -
      DURABLE_SCAN_JOB_RECONCILIATION_TIMEOUT_MS
  );
  sql.exec(
    `UPDATE durable_scan_jobs
     SET state = 'publishing', publication_manifest = ?, lease_expires_at = ?, updated_at = ?
     WHERE job_id = ? AND state = 'leased' AND lease_generation = ? AND lease_expires_at > ? AND deadline_at >= ?`,
    input.manifest,
    leaseExpiresAt,
    input.now,
    input.jobId,
    input.generation,
    input.now,
    minimumDeadline
  );
  const row = requireRow(sql, input.jobId);
  if (
    row.state !== "publishing" ||
    row.publication_manifest !== input.manifest ||
    row.lease_expires_at !== leaseExpiresAt
  ) {
    throw new DurableScanJobStateError("conflict", "The durable scan job could not begin publication.", rowState(row));
  }
  return snapshotFromRow(row);
}

export function resolveDurableScanJob(
  sql: DurableScanJobStoreSql,
  input: LeaseMutationInput &
    Readonly<{
      outcome: "succeeded" | "failed" | "cancelled";
      reason?: string;
    }>
): DurableScanJobSnapshot {
  ensureDurableScanJobStore(sql);
  const allowedStates: readonly DurableScanJobState[] =
    input.outcome === "succeeded" ? ["publishing"] : ["leased"];
  requireCurrentLease(sql, input, allowedStates);
  const reason = terminalReason(input.outcome, input.reason);
  terminalize(sql, input.jobId, input.outcome, input.now, reason, {
    generation: input.generation,
    tokenHash: input.tokenHash,
    requireUnexpiredAt: input.now,
    allowedStates
  });
  return snapshotFromRow(requireRow(sql, input.jobId));
}

/**
 * DO-authoritative DELETE transition. Queued and leased work is cancelled and
 * wiped without the worker's lease token; publishing has already crossed the
 * public write boundary and therefore conflicts. A repeated cancellation is
 * idempotent.
 */
export function cancelDurableScanJob(
  sql: DurableScanJobStoreSql,
  input: Readonly<{ jobId: string; now: number }>
): DurableScanJobSnapshot {
  ensureDurableScanJobStore(sql);
  assertTimestamp(input.now, "cancellation timestamp");
  const row = requireRow(sql, input.jobId);
  const state = rowState(row);
  if (state === "cancelled") return snapshotFromRow(row);
  if (state === "publishing") {
    throw new DurableScanJobStateError("conflict", "The durable scan job is already publishing.", state);
  }
  if (state !== "queued" && state !== "leased") {
    throw new DurableScanJobStateError("conflict", "The durable scan job can no longer be cancelled.", state);
  }
  terminalize(sql, input.jobId, "cancelled", input.now, "cancelled", { allowedStates: [state] });
  return snapshotFromRow(requireRow(sql, input.jobId));
}

export function listExpiredDurableScanJobLeases(
  sql: DurableScanJobStoreSql,
  now: number
): DurableScanJobSnapshot[] {
  ensureDurableScanJobStore(sql);
  assertTimestamp(now, "lease-expiry listing timestamp");
  return sql
    .exec<DurableScanJobRow>(
      "SELECT * FROM durable_scan_jobs WHERE state IN ('leased','publishing') AND lease_expires_at <= ? ORDER BY lease_expires_at ASC, created_at ASC, job_id ASC",
      now
    )
    .toArray()
    .map(snapshotFromRow);
}

/** Requeue only an expired execution lease. Publishing requires R2 reconciliation. */
export function requeueOrFailExpiredDurableScanJobLease(
  sql: DurableScanJobStoreSql,
  input: Readonly<{ jobId: string; generation: number; now: number }>
): DurableScanJobSnapshot {
  ensureDurableScanJobStore(sql);
  assertGeneration(input.generation);
  assertTimestamp(input.now, "lease-recovery timestamp");
  const row = requireRow(sql, input.jobId);
  if (row.state !== "leased" || row.lease_generation !== input.generation || row.lease_expires_at === null || row.lease_expires_at > input.now) {
    throw new DurableScanJobStateError("conflict", "The durable scan-job lease is not recoverable.", rowState(row));
  }
  if (row.deadline_at <= input.now) {
    terminalize(sql, input.jobId, "expired", input.now, "deadline", {
      generation: input.generation,
      allowedStates: ["leased"],
      requireExpiredAt: input.now
    });
  } else if (row.attempt_count >= DURABLE_SCAN_JOB_MAX_ATTEMPTS) {
    terminalize(sql, input.jobId, "failed", input.now, "restart-limit", {
      generation: input.generation,
      allowedStates: ["leased"],
      requireExpiredAt: input.now
    });
  } else {
    sql.exec(
      `UPDATE durable_scan_jobs
       SET state = 'queued', lease_token_hash = NULL, lease_expires_at = NULL,
           publication_manifest = NULL, updated_at = ?
       WHERE job_id = ? AND state = 'leased' AND lease_generation = ? AND lease_expires_at <= ?`,
      input.now,
      input.jobId,
      input.generation,
      input.now
    );
  }
  return snapshotFromRow(requireRow(sql, input.jobId));
}

/** Fenced, tokenless transition after authenticated R2 reconciliation. */
export function reconcileExpiredPublishingDurableScanJob(
  sql: DurableScanJobStoreSql,
  input: Readonly<{
    jobId: string;
    generation: number;
    now: number;
    result: "succeeded" | "missing" | "integrity-failed" | "expired";
    reason?: string;
  }>
): DurableScanJobSnapshot {
  ensureDurableScanJobStore(sql);
  assertGeneration(input.generation);
  assertTimestamp(input.now, "publication-reconciliation timestamp");
  const row = requireRow(sql, input.jobId);
  if (
    row.state !== "publishing" ||
    row.lease_generation !== input.generation ||
    row.lease_expires_at === null ||
    row.lease_expires_at > input.now
  ) {
    throw new DurableScanJobStateError("conflict", "The durable publication is not reconcilable.", rowState(row));
  }
  const settlementAt = Math.min(
    safeTimestampAdd(
      row.lease_expires_at,
      DURABLE_SCAN_JOB_PUBLICATION_SETTLEMENT_MS,
      "publication settlement timestamp"
    ),
    row.deadline_at
  );
  if (input.now < settlementAt) {
    throw new DurableScanJobStateError(
      "conflict",
      "The durable publication has not reached its settlement fence.",
      "publishing"
    );
  }
  const fence = {
    generation: input.generation,
    allowedStates: ["publishing"] as const,
    requireExpiredAt: input.now
  };
  if (input.result === "succeeded") {
    terminalize(sql, input.jobId, "succeeded", input.now, null, fence);
  } else if (input.result === "integrity-failed") {
    terminalize(sql, input.jobId, "failed", input.now, closedReason(input.reason, "publication-integrity"), fence);
  } else if (input.result === "expired") {
    if (row.deadline_at > input.now) {
      throw new DurableScanJobStateError(
        "conflict",
        "The durable publication has not reached its deadline.",
        "publishing"
      );
    }
    terminalize(sql, input.jobId, "expired", input.now, "deadline", fence);
  } else {
    // Publication is the point of no return for this report capability. Even a
    // bounded/aborted PUT can have an outcome-unknown response, so an observed
    // missing bundle must never admit a competing generation.
    terminalize(sql, input.jobId, "failed", input.now, "publication-missing", fence);
  }
  return snapshotFromRow(requireRow(sql, input.jobId));
}

export function listPastDeadlineDurableScanJobs(
  sql: DurableScanJobStoreSql,
  now: number
): DurableScanJobSnapshot[] {
  ensureDurableScanJobStore(sql);
  assertTimestamp(now, "deadline listing timestamp");
  return sql
    .exec<DurableScanJobRow>(
      "SELECT * FROM durable_scan_jobs WHERE state IN ('queued','leased','publishing') AND deadline_at <= ? ORDER BY deadline_at ASC, created_at ASC, job_id ASC",
      now
    )
    .toArray()
    .map(snapshotFromRow);
}

export function expireDurableScanJob(
  sql: DurableScanJobStoreSql,
  input: Readonly<{ jobId: string; now: number }>
): DurableScanJobSnapshot {
  ensureDurableScanJobStore(sql);
  assertTimestamp(input.now, "expiration timestamp");
  const row = requireRow(sql, input.jobId);
  const state = rowState(row);
  if (state === "expired") return snapshotFromRow(row);
  if (state === "publishing") {
    throw new DurableScanJobStateError(
      "conflict",
      "A publishing durable scan job must cross the reconciliation fence before termination.",
      state
    );
  }
  if (!isNonterminalState(state) || row.deadline_at > input.now) {
    throw new DurableScanJobStateError("conflict", "The durable scan job has not reached its deadline.", state);
  }
  terminalize(sql, input.jobId, "expired", input.now, "deadline", {
    allowedStates: [state],
    requireDeadlineAt: input.now
  });
  return snapshotFromRow(requireRow(sql, input.jobId));
}

/**
 * Settle every unfinished row that has crossed the immutable purge boundary.
 *
 * The caller must run this synchronous operation inside the same transaction
 * that copies linked watch history and purges the resulting tombstones. A
 * publishing row is fenced through the normal reconciliation transition; at
 * the hard horizon, an outcome that could not be reconciled before the job
 * deadline is conservatively recorded as expired.
 */
export function settlePastPurgeDurableScanJobs(
  sql: DurableScanJobStoreSql,
  now: number
): DurableScanJobSnapshot[] {
  ensureDurableScanJobStore(sql);
  assertTimestamp(now, "hard-purge settlement timestamp");
  const rows = sql
    .exec<DurableScanJobRow>(
      "SELECT * FROM durable_scan_jobs WHERE state IN ('queued','leased','publishing') AND purge_at <= ? ORDER BY purge_at ASC, created_at ASC, job_id ASC",
      now
    )
    .toArray();
  const settled: DurableScanJobSnapshot[] = [];
  for (const row of rows) {
    const state = rowState(row);
    settled.push(
      state === "publishing"
        ? reconcileExpiredPublishingDurableScanJob(sql, {
            jobId: row.job_id,
            generation: row.lease_generation,
            now,
            result: "expired"
          })
        : expireDurableScanJob(sql, { jobId: row.job_id, now })
    );
  }
  return settled;
}

// NOTE: there is deliberately no wake computation in this module. The single
// authority for "when should the durable pump wake" is the transactionSync SQL
// in cloudflare/container-worker.ts, which joins the reconciliation-backoff
// table this module predates. A tested store-side twin existed here once,
// never wired, and had already diverged from the shipping query; a contract
// that looks authoritative while pinning nothing is this repo's known worst
// defect class, so it was removed rather than left as a trap.

/** Earliest immutable row-retention boundary across the whole durable store. */
export function earliestDurableScanJobPurgeAt(sql: DurableScanJobStoreSql): number | null {
  ensureDurableScanJobStore(sql);
  const row = sql
    .exec<Record<string, SqlValue> & { purge_at: number | null }>(
      "SELECT MIN(purge_at) AS purge_at FROM durable_scan_jobs"
    )
    .toArray()[0];
  return row?.purge_at === null || row?.purge_at === undefined
    ? null
    : integer(row.purge_at, "earliest purge timestamp");
}

/**
 * Hard 75-minute row purge. Unfinished work is never silently deleted: callers
 * must terminalize it first, inside the transaction that preserves any linked
 * long-lived history.
 */
export function purgeDurableScanJobs(sql: DurableScanJobStoreSql, now: number): number {
  ensureDurableScanJobStore(sql);
  assertTimestamp(now, "purge timestamp");
  const unfinished = sql
    .exec<DurableScanJobRow>(
      "SELECT * FROM durable_scan_jobs WHERE state IN ('queued','leased','publishing') AND purge_at <= ? ORDER BY purge_at ASC, created_at ASC, job_id ASC LIMIT 1",
      now
    )
    .toArray()[0];
  if (unfinished) {
    throw new DurableScanJobStateError(
      "conflict",
      "A durable scan job must be terminalized before hard purge.",
      rowState(unfinished)
    );
  }
  const before = sql
    .exec<Record<string, SqlValue> & { count: number }>(
      "SELECT COUNT(*) AS count FROM durable_scan_jobs WHERE state IN ('succeeded','failed','expired','cancelled') AND purge_at <= ?",
      now
    )
    .toArray()[0]?.count;
  const count = integer(before ?? 0, "purge count");
  sql.exec(
    "DELETE FROM durable_scan_jobs WHERE state IN ('succeeded','failed','expired','cancelled') AND purge_at <= ?",
    now
  );
  return count + evictTerminalRowsToTarget(sql, DURABLE_SCAN_JOB_MAX_ROWS);
}

function requireCurrentLease(
  sql: DurableScanJobStoreSql,
  input: LeaseMutationInput,
  allowedStates: readonly DurableScanJobState[]
): DurableScanJobRow {
  assertGeneration(input.generation);
  assertTimestamp(input.now, "lease mutation timestamp");
  assertDigest(input.tokenHash);
  const row = requireRow(sql, input.jobId);
  const state = rowState(row);
  if (!allowedStates.includes(state)) {
    throw new DurableScanJobStateError("conflict", "The durable scan job is in the wrong state.", state);
  }
  if (
    row.lease_generation !== input.generation ||
    row.lease_expires_at === null ||
    row.lease_expires_at <= input.now ||
    row.deadline_at <= input.now ||
    !equalBytes(requireBlob(row.lease_token_hash, "lease token hash"), input.tokenHash)
  ) {
    throw new DurableScanJobStateError("lease-invalid", "The durable scan-job lease is invalid or expired.", state);
  }
  return row;
}

function terminalize(
  sql: DurableScanJobStoreSql,
  jobId: string,
  state: (typeof TERMINAL_STATES)[number],
  now: number,
  reason: string | null,
  fence: Readonly<{
    generation?: number;
    tokenHash?: ArrayBuffer;
    allowedStates: readonly DurableScanJobState[];
    requireUnexpiredAt?: number;
    requireExpiredAt?: number;
    requireDeadlineAt?: number;
  }>
): void {
  if (reason !== null) closedReason(reason, reason);
  const row = requireRow(sql, jobId);
  const currentState = rowState(row);
  if (!fence.allowedStates.includes(currentState)) {
    throw new DurableScanJobStateError("conflict", "The durable scan job changed state.", currentState);
  }
  if (fence.generation !== undefined && row.lease_generation !== fence.generation) {
    throw new DurableScanJobStateError("conflict", "The durable scan-job generation changed.", currentState);
  }
  if (fence.tokenHash !== undefined) {
    assertDigest(fence.tokenHash);
    if (!equalBytes(requireBlob(row.lease_token_hash, "lease token hash"), fence.tokenHash)) {
      throw new DurableScanJobStateError("lease-invalid", "The durable scan-job lease token is invalid.", currentState);
    }
  }
  if (
    fence.requireUnexpiredAt !== undefined &&
    (row.lease_expires_at === null || row.lease_expires_at <= fence.requireUnexpiredAt || row.deadline_at <= fence.requireUnexpiredAt)
  ) {
    throw new DurableScanJobStateError("lease-invalid", "The durable scan-job lease is expired.", currentState);
  }
  if (fence.requireExpiredAt !== undefined && (row.lease_expires_at === null || row.lease_expires_at > fence.requireExpiredAt)) {
    throw new DurableScanJobStateError("conflict", "The durable scan-job lease has not expired.", currentState);
  }
  if (fence.requireDeadlineAt !== undefined && row.deadline_at > fence.requireDeadlineAt) {
    throw new DurableScanJobStateError("conflict", "The durable scan-job deadline has not elapsed.", currentState);
  }
  sql.exec(
    `UPDATE durable_scan_jobs
     SET state = ?, payload_key_id = NULL, payload_nonce = NULL, payload_ciphertext = NULL,
         lease_token_hash = NULL, lease_expires_at = NULL, publication_manifest = NULL,
         terminal_reason = ?, finished_at = ?, updated_at = ?
     WHERE job_id = ?`,
    state,
    reason,
    now,
    now,
    jobId
  );
}

function selectRow(sql: DurableScanJobStoreSql, jobId: string): DurableScanJobRow | null {
  if (!isScanJobId(jobId)) return null;
  return sql.exec<DurableScanJobRow>("SELECT * FROM durable_scan_jobs WHERE job_id = ? LIMIT 1", jobId).toArray()[0] ?? null;
}

function requireRow(sql: DurableScanJobStoreSql, jobId: string): DurableScanJobRow {
  const row = selectRow(sql, jobId);
  if (!row) throw new DurableScanJobStateError("not-found", "The durable scan job was not found.", null);
  return row;
}

function snapshotFromRow(row: DurableScanJobRow): DurableScanJobSnapshot {
  const totalRuns = integer(row.total_runs, "total runs");
  if (totalRuns !== 1 && totalRuns !== 2) throw new DurableScanJobStateError("conflict", "Invalid durable row total runs.", null);
  return Object.freeze({
    jobId: text(row.job_id, "job ID"),
    reportId: text(row.report_id, "report ID"),
    state: rowState(row),
    createdAt: integer(row.created_at, "created timestamp"),
    deadlineAt: integer(row.deadline_at, "deadline timestamp"),
    purgeAt: integer(row.purge_at, "purge timestamp"),
    totalRuns,
    attemptCount: integer(row.attempt_count, "attempt count"),
    leaseGeneration: integer(row.lease_generation, "lease generation"),
    leaseExpiresAt: nullableInteger(row.lease_expires_at, "lease expiry"),
    publicationManifest: nullableText(row.publication_manifest, "publication manifest"),
    terminalReason: nullableText(row.terminal_reason, "terminal reason"),
    finishedAt: nullableInteger(row.finished_at, "finished timestamp"),
    updatedAt: integer(row.updated_at, "updated timestamp")
  });
}

function claimFromRow(row: DurableScanJobRow, leaseToken: string): DurableScanJobClaim {
  const snapshot = snapshotFromRow(row);
  if (snapshot.state !== "leased" || snapshot.leaseExpiresAt === null) {
    throw new DurableScanJobStateError("conflict", "The durable scan-job claim row is invalid.", snapshot.state);
  }
  if (row.payload_version !== DURABLE_SCAN_JOB_PAYLOAD_VERSION || row.payload_key_id !== DURABLE_SCAN_JOB_KEY_ID) {
    throw new DurableScanJobStateError("conflict", "The durable scan-job envelope is unsupported.", snapshot.state);
  }
  return Object.freeze({
    jobId: snapshot.jobId,
    reportId: snapshot.reportId,
    state: "leased",
    createdAt: snapshot.createdAt,
    deadlineAt: snapshot.deadlineAt,
    purgeAt: snapshot.purgeAt,
    totalRuns: snapshot.totalRuns,
    attemptCount: snapshot.attemptCount,
    leaseGeneration: snapshot.leaseGeneration,
    leaseExpiresAt: snapshot.leaseExpiresAt,
    leaseToken,
    envelope: Object.freeze({
      version: DURABLE_SCAN_JOB_PAYLOAD_VERSION,
      keyId: DURABLE_SCAN_JOB_KEY_ID,
      nonce: copyArrayBuffer(requireBlob(row.payload_nonce, "payload nonce")),
      ciphertext: copyArrayBuffer(requireBlob(row.payload_ciphertext, "payload ciphertext"))
    })
  });
}

function assertAdmission(admission: DurableScanJobAdmission): void {
  assertJobIdentity(admission.jobId, admission.reportId);
  assertTimestamp(admission.createdAt, "created timestamp");
  if (admission.deadlineAt !== safeTimestampAdd(admission.createdAt, DURABLE_SCAN_JOB_DEADLINE_MS, "job deadline")) {
    throw new DurableScanJobValidationError("Invalid durable scan-job deadline.");
  }
  if (admission.purgeAt !== safeTimestampAdd(admission.createdAt, DURABLE_SCAN_JOB_PURGE_MS, "job purge timestamp")) {
    throw new DurableScanJobValidationError("Invalid durable scan-job purge timestamp.");
  }
  if (admission.totalRuns !== 1 && admission.totalRuns !== 2) {
    throw new DurableScanJobValidationError("Invalid durable scan-job run count.");
  }
  assertEnvelope(admission.envelope);
}

function assertClaim(claim: DurableScanJobClaim): void {
  assertJobIdentity(claim.jobId, claim.reportId);
  assertTimestamp(claim.createdAt, "created timestamp");
  if (claim.deadlineAt !== claim.createdAt + DURABLE_SCAN_JOB_DEADLINE_MS || claim.purgeAt !== claim.createdAt + DURABLE_SCAN_JOB_PURGE_MS) {
    throw new DurableScanJobValidationError("Invalid durable scan-job claim timestamps.");
  }
  if (claim.totalRuns !== 1 && claim.totalRuns !== 2) throw new DurableScanJobValidationError("Invalid durable claim run count.");
  assertEnvelope(claim.envelope);
}

function assertEnvelope(envelope: DurableScanJobEnvelope): void {
  if (envelope.version !== DURABLE_SCAN_JOB_PAYLOAD_VERSION || envelope.keyId !== DURABLE_SCAN_JOB_KEY_ID) {
    throw new DurableScanJobValidationError("Unsupported durable scan-job envelope.");
  }
  const nonce = requireBlob(envelope.nonce, "payload nonce");
  const ciphertext = requireBlob(envelope.ciphertext, "payload ciphertext");
  if (nonce.byteLength !== NONCE_BYTES || ciphertext.byteLength < 16 || ciphertext.byteLength > MAX_PAYLOAD_CIPHERTEXT_BYTES) {
    throw new DurableScanJobValidationError("Invalid durable scan-job envelope size.");
  }
}

function assertEncryptionKey(key: DurableScanJobEncryptionKey): void {
  if (!key || key.keyId !== DURABLE_SCAN_JOB_KEY_ID || !key.cryptoKey || typeof key.cryptoKey !== "object") {
    throw new DurableScanJobValidationError("Invalid durable scan-job encryption key.");
  }
}

function canonicalPayload(value: unknown): DurableScanJobPayload {
  if (!isDurableScanJobPayload(value)) {
    throw new DurableScanJobValidationError("Invalid durable scan-job payload.");
  }
  const comparisons = [value.compareGpc, value.compareShields, value.compareConsent].filter(Boolean).length;
  if (comparisons > 1 || value.rateLimitCost !== (comparisons === 1 ? 2 : 1)) {
    throw new DurableScanJobValidationError("The durable scan-job comparison and rate-limit charge disagree.");
  }
  return Object.freeze({
    version: 1,
    url: value.url,
    device: value.device,
    gpcEnabled: value.gpcEnabled,
    compareGpc: value.compareGpc,
    compareShields: value.compareShields,
    compareConsent: value.compareConsent,
    rateLimitCost: value.rateLimitCost,
    admittedAt: value.admittedAt,
    reportMode: "r2",
    alreadyCharged: true
  });
}

function totalRunsForPayload(payload: DurableScanJobPayload): 1 | 2 {
  return payload.compareGpc || payload.compareShields || payload.compareConsent ? 2 : 1;
}

function durableScanJobAdditionalData(input: {
  jobId: string;
  reportId: string;
  createdAt: number;
  deadlineAt: number;
  totalRuns: 1 | 2;
  payloadVersion?: number;
}): ArrayBuffer {
  assertJobIdentity(input.jobId, input.reportId);
  assertTimestamp(input.createdAt, "AAD created timestamp");
  assertTimestamp(input.deadlineAt, "AAD deadline timestamp");
  if (input.deadlineAt !== input.createdAt + DURABLE_SCAN_JOB_DEADLINE_MS || (input.totalRuns !== 1 && input.totalRuns !== 2)) {
    throw new DurableScanJobValidationError("Invalid durable scan-job associated data.");
  }
  const version = input.payloadVersion ?? DURABLE_SCAN_JOB_PAYLOAD_VERSION;
  if (version !== DURABLE_SCAN_JOB_PAYLOAD_VERSION) {
    throw new DurableScanJobValidationError("Unsupported durable scan-job associated-data version.");
  }
  return copyArrayBuffer(new TextEncoder().encode(
    JSON.stringify([
      "site-behavior-lab/durable-scan-job",
      version,
      DURABLE_SCAN_JOB_KEY_ID,
      input.jobId,
      input.reportId,
      input.createdAt,
      input.deadlineAt,
      input.totalRuns
    ])
  ));
}

function assertLeaseCredentials(credentials: readonly DurableScanJobLeaseCredential[]): void {
  const tokens = new Set<string>();
  for (const credential of credentials) {
    decodeCanonicalBase64Url(credential.token, KEY_BASE64URL_LENGTH, LEASE_TOKEN_BYTES, "durable scan-job lease token");
    assertDigest(credential.tokenHash);
    const issued = issuedLeaseCredentials.get(credential);
    if (
      !issued ||
      issued.token !== credential.token ||
      !equalBytes(issued.tokenHash, credential.tokenHash)
    ) {
      throw new DurableScanJobValidationError(
        "Durable scan-job lease credentials must come from the authenticated credential factory."
      );
    }
    if (tokens.has(credential.token)) throw new DurableScanJobValidationError("Duplicate durable scan-job lease token.");
    tokens.add(credential.token);
  }
}

function assertPublicationManifest(manifest: string, expectedReportId: string): void {
  if (typeof manifest !== "string" || manifest.length === 0 || new TextEncoder().encode(manifest).byteLength > MAX_PUBLICATION_MANIFEST_BYTES) {
    throw new DurableScanJobValidationError("Invalid durable publication manifest size.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifest);
  } catch {
    throw new DurableScanJobValidationError("The durable publication manifest must be a JSON object.");
  }
  if (!isRecordWithExactKeys(parsed, PUBLICATION_MANIFEST_KEYS)) {
    throw new DurableScanJobValidationError("The durable publication manifest has an invalid shape.");
  }
  const retention = parsed.retention;
  if (!isRecordWithExactKeys(retention, ["createdAt", "expiresAt"])) {
    throw new DurableScanJobValidationError("The durable publication retention metadata is invalid.");
  }
  if (
    parsed.manifestVersion !== 1 ||
    parsed.reportId !== expectedReportId ||
    typeof parsed.reportWireSha256 !== "string" ||
    !SHA256_HEX_PATTERN.test(parsed.reportWireSha256) ||
    typeof parsed.publicDigest !== "string" ||
    !SHA256_HEX_PATTERN.test(parsed.publicDigest) ||
    typeof parsed.canonicalizationVersion !== "string" ||
    !CONTENT_VERSION_PATTERN.test(parsed.canonicalizationVersion) ||
    !Number.isSafeInteger(parsed.redactionVersion) ||
    (parsed.redactionVersion as number) < 1 ||
    !Number.isSafeInteger(parsed.reportBytes) ||
    (parsed.reportBytes as number) < 1 ||
    !isCanonicalTimestamp(retention.createdAt) ||
    !isCanonicalTimestamp(retention.expiresAt) ||
    Date.parse(retention.expiresAt) <= Date.parse(retention.createdAt) ||
    typeof parsed.sidecarWire !== "string"
  ) {
    throw new DurableScanJobValidationError("The durable publication manifest is invalid.");
  }
  let sidecar: unknown;
  try {
    sidecar = JSON.parse(parsed.sidecarWire);
  } catch {
    throw new DurableScanJobValidationError("The durable publication sidecar is invalid.");
  }
  if (
    !isRecordWithExactKeys(sidecar, PUBLICATION_SIDECAR_KEYS) ||
    sidecar.reportId !== expectedReportId ||
    sidecar.publicDigest !== parsed.publicDigest ||
    sidecar.canonicalizationVersion !== parsed.canonicalizationVersion ||
    sidecar.redactionVersion !== parsed.redactionVersion ||
    sidecar.writtenAt !== retention.createdAt ||
    sidecar.createdAt !== retention.createdAt ||
    sidecar.expiresAt !== retention.expiresAt ||
    parsed.sidecarWire !== `${JSON.stringify(sidecar, null, 2)}\n`
  ) {
    throw new DurableScanJobValidationError("The durable publication sidecar does not match its manifest.");
  }
}

function isRecordWithExactKeys(
  value: unknown,
  keys: readonly string[]
): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value as Record<string, unknown>).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function terminalReason(outcome: "succeeded" | "failed" | "cancelled", reason: string | undefined): string | null {
  if (outcome === "succeeded") {
    if (reason !== undefined) throw new DurableScanJobValidationError("A successful durable job cannot have a failure reason.");
    return null;
  }
  return closedReason(reason, outcome === "failed" ? "execution-failed" : "cancelled");
}

function closedReason(value: string | undefined, fallback: string): string {
  const reason = value ?? fallback;
  if (!TERMINAL_REASON_PATTERN.test(reason)) {
    throw new DurableScanJobValidationError("Invalid durable scan-job terminal reason.");
  }
  return reason;
}

function rowState(row: DurableScanJobRow): DurableScanJobState {
  const state = row.state;
  if (![...NONTERMINAL_STATES, ...TERMINAL_STATES].includes(state as DurableScanJobState)) {
    throw new DurableScanJobStateError("conflict", "The durable scan job has an invalid state.", null);
  }
  return state as DurableScanJobState;
}

function isNonterminalState(state: DurableScanJobState): state is (typeof NONTERMINAL_STATES)[number] {
  return (NONTERMINAL_STATES as readonly string[]).includes(state);
}

function assertJobIdentity(jobId: string, reportId: string): void {
  if (!isScanJobId(jobId) || !isScanJobId(reportId) || jobId === reportId) {
    throw new DurableScanJobValidationError("Invalid durable scan-job identity.");
  }
}

function assertGeneration(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new DurableScanJobValidationError("Invalid durable scan-job lease generation.");
  }
}

function assertTimestamp(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new DurableScanJobValidationError(`Invalid durable scan-job ${label}.`);
  }
}

function safeTimestampAdd(value: number, delta: number, label: string): number {
  const result = value + delta;
  assertTimestamp(result, label);
  return result;
}

function assertDigest(value: ArrayBuffer): void {
  if (!(value instanceof ArrayBuffer) || value.byteLength !== SHA256_BYTES) {
    throw new DurableScanJobValidationError("Invalid durable scan-job lease-token digest.");
  }
}

function integer(value: SqlValue | undefined, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new DurableScanJobStateError("conflict", `Invalid durable scan-job ${label}.`, null);
  }
  return value;
}

function nullableInteger(value: SqlValue | undefined, label: string): number | null {
  return value === null ? null : integer(value, label);
}

function text(value: SqlValue | undefined, label: string): string {
  if (typeof value !== "string") throw new DurableScanJobStateError("conflict", `Invalid durable scan-job ${label}.`, null);
  return value;
}

function nullableText(value: SqlValue | undefined, label: string): string | null {
  return value === null ? null : text(value, label);
}

function requireBlob(value: unknown, label: string): ArrayBuffer {
  if (!(value instanceof ArrayBuffer)) {
    throw new DurableScanJobStateError("conflict", `Invalid durable scan-job ${label}.`, null);
  }
  return value;
}

function secureRandomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

async function sha256(bytes: Uint8Array): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", copyArrayBuffer(bytes));
}

function durableScanJobRowCount(sql: DurableScanJobStoreSql): number {
  const count = sql
    .exec<Record<string, SqlValue> & { count: number }>("SELECT COUNT(*) AS count FROM durable_scan_jobs")
    .toArray()[0]?.count;
  return integer(count, "row count");
}

function evictTerminalRowsToTarget(sql: DurableScanJobStoreSql, targetRows: number): number {
  const rowCount = durableScanJobRowCount(sql);
  const excess = Math.max(0, rowCount - targetRows);
  if (excess === 0) return 0;
  const terminalCount = sql
    .exec<Record<string, SqlValue> & { count: number }>(
      "SELECT COUNT(*) AS count FROM durable_scan_jobs WHERE state IN ('succeeded','failed','expired','cancelled')"
    )
    .toArray()[0]?.count;
  const evictCount = Math.min(excess, integer(terminalCount, "terminal row count"));
  if (evictCount === 0) return 0;
  sql.exec(
    `DELETE FROM durable_scan_jobs WHERE job_id IN (
       SELECT job_id FROM durable_scan_jobs
       WHERE state IN ('succeeded','failed','expired','cancelled')
       ORDER BY finished_at ASC, created_at ASC, job_id ASC
       LIMIT ?
     )`,
    evictCount
  );
  return evictCount;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeCanonicalBase64Url(value: string, expectedLength: number, expectedBytes: number, label: string): Uint8Array {
  if (typeof value !== "string" || value.length !== expectedLength || !BASE64URL_PATTERN.test(value)) {
    throw new DurableScanJobValidationError(`Invalid ${label}.`);
  }
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    if (bytes.byteLength !== expectedBytes || encodeBase64Url(bytes) !== value) throw new Error();
    return bytes;
  } catch {
    throw new DurableScanJobValidationError(`Invalid ${label}.`);
  }
}

function copyArrayBuffer(value: ArrayBuffer | Uint8Array): ArrayBuffer {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  return Uint8Array.from(bytes).buffer;
}

function equalBytes(left: ArrayBuffer, right: ArrayBuffer): boolean {
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  if (a.byteLength !== b.byteLength) return false;
  let mismatch = 0;
  for (let index = 0; index < a.byteLength; index += 1) mismatch |= a[index] ^ b[index];
  return mismatch === 0;
}
