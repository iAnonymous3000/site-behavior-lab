import {
  ENCRYPTED_WATCH_CADENCE_MS,
  ENCRYPTED_WATCH_ENCRYPTION_KEY_ENV,
  ENCRYPTED_WATCH_GLOBAL_DAILY_RUN_BUDGET,
  ENCRYPTED_WATCH_LEASE_MS,
  ENCRYPTED_WATCH_MAX_ACTIVE,
  ENCRYPTED_WATCH_MAX_RUNS,
  ENCRYPTED_WATCH_PREVIOUS_ENCRYPTION_KEY_ENV,
  ENCRYPTED_WATCH_TTL_MS,
  deriveEncryptedWatchIdFromCapabilityToken,
  isEncryptedWatchCapabilityToken,
  isEncryptedWatchId,
  isEncryptedWatchPayload,
  type EncryptedWatchPayload
} from "./encrypted-watch-contract";
import { isScanJobId } from "./durable-scan-job-contract";
import type { DurableScanJobStoreSql } from "./durable-scan-job-store";

export type EncryptedWatchStoreSql = DurableScanJobStoreSql;

export const ENCRYPTED_WATCH_ENVELOPE_VERSION = 1 as const;

const KEY_BASE64URL_LENGTH = 43;
const KEY_BYTES = 32;
const CAPABILITY_TOKEN_BYTES = 32;
const LEASE_TOKEN_BYTES = 32;
const NONCE_BYTES = 12;
const SHA256_BYTES = 32;
const MAX_PAYLOAD_PLAINTEXT_BYTES = 4_608;
const MAX_PAYLOAD_CIPHERTEXT_BYTES = MAX_PAYLOAD_PLAINTEXT_BYTES + 16;
const STORE_SCHEMA_VERSION = 1;
const DAY_MS = 24 * 60 * 60 * 1_000;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const KEY_ID_PATTERN = /^sha256:[0-9a-f]{64}$/;
const ERROR_CODE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

const issuedWatchCredentials = new WeakMap<object, Readonly<{ watchId: string; token: string; tokenHash: ArrayBuffer }>>();
const issuedLeaseCredentials = new WeakMap<object, Readonly<{ token: string; tokenHash: ArrayBuffer }>>();

type SqlValue = ArrayBuffer | string | number | null;

export type EncryptedWatchKey = Readonly<{
  keyId: string;
  cryptoKey: CryptoKey;
  optionsBindingKey: CryptoKey;
}>;

export type EncryptedWatchKeyring = Readonly<{
  current: EncryptedWatchKey;
  previous: EncryptedWatchKey | null;
}>;

export type EncryptedWatchEnvelope = Readonly<{
  version: typeof ENCRYPTED_WATCH_ENVELOPE_VERSION;
  keyId: string;
  nonce: ArrayBuffer;
  optionsBinding: ArrayBuffer;
  ciphertext: ArrayBuffer;
}>;

export type EncryptedWatchCredential = Readonly<{
  watchId: string;
  token: string;
  tokenHash: ArrayBuffer;
}>;

export type EncryptedWatchLeaseCredential = Readonly<{
  token: string;
  tokenHash: ArrayBuffer;
}>;

export type EncryptedWatchAdmission = Readonly<{
  watchId: string;
  capabilityHash: ArrayBuffer;
  createdAt: number;
  expiresAt: number;
  nextRunAt: number;
  cadenceMs: typeof ENCRYPTED_WATCH_CADENCE_MS;
  maxRuns: typeof ENCRYPTED_WATCH_MAX_RUNS;
  initialRun: EncryptedWatchRunLink;
  envelope: EncryptedWatchEnvelope;
}>;

export type EncryptedWatchState = "active" | "leased" | "completed";

export type EncryptedWatchSnapshot = Readonly<{
  watchId: string;
  state: EncryptedWatchState;
  createdAt: number;
  expiresAt: number;
  nextRunAt: number | null;
  cadenceMs: typeof ENCRYPTED_WATCH_CADENCE_MS;
  maxRuns: typeof ENCRYPTED_WATCH_MAX_RUNS;
  runCount: number;
  leaseGeneration: number;
  leaseExpiresAt: number | null;
  lastOutcome: "admitted" | "failed" | null;
  latestJobId: string | null;
  latestReportId: string | null;
  lastAttemptAt: number | null;
  completedAt: number | null;
  updatedAt: number;
  history: readonly EncryptedWatchRunRecord[];
}>;

export type EncryptedWatchClaim = Readonly<{
  watchId: string;
  state: "leased";
  createdAt: number;
  expiresAt: number;
  dueAt: number;
  cadenceMs: typeof ENCRYPTED_WATCH_CADENCE_MS;
  maxRuns: typeof ENCRYPTED_WATCH_MAX_RUNS;
  runCount: number;
  leaseGeneration: number;
  leaseExpiresAt: number;
  leaseToken: string;
  envelope: EncryptedWatchEnvelope;
}>;

export type EncryptedWatchRunLink = Readonly<{
  jobId: string;
  reportId: string;
  admittedAt: number;
}>;

export type EncryptedWatchRunRecord = Readonly<{
  runNumber: number;
  outcome: "admitted" | "failed";
  jobId: string | null;
  reportId: string | null;
  admittedAt: number | null;
  recordedAt: number;
  terminalOutcome: "succeeded" | "failed" | "expired" | "cancelled" | null;
  terminalErrorCode: string | null;
  terminalAt: number | null;
}>;

export type EncryptedWatchRunResolution =
  | Readonly<{ outcome: "admitted"; jobId: string; reportId: string; admittedAt: number }>
  | Readonly<{ outcome: "failed" }>;

export type EncryptedWatchRunTerminalResolution =
  | Readonly<{ outcome: "succeeded" }>
  | Readonly<{ outcome: "failed" | "expired" | "cancelled"; errorCode: string }>;

export type EncryptedWatchGlobalBudgetResult = Readonly<{
  allowed: boolean;
  used: number;
  remaining: number;
  resetsAt: number;
}>;

export type EncryptedWatchStateErrorCode = "not-found" | "conflict" | "lease-invalid";

export class EncryptedWatchStateError extends Error {
  constructor(
    public readonly code: EncryptedWatchStateErrorCode,
    message: string,
    public readonly currentState: EncryptedWatchState | null = null
  ) {
    super(message);
    this.name = "EncryptedWatchStateError";
  }
}

export class EncryptedWatchCapacityError extends Error {
  readonly code = "capacity" as const;

  constructor() {
    super("The encrypted-watch capacity is full.");
    this.name = "EncryptedWatchCapacityError";
  }
}

export class EncryptedWatchValidationError extends Error {
  readonly code = "validation" as const;

  constructor(message: string) {
    super(message);
    this.name = "EncryptedWatchValidationError";
  }
}

export class EncryptedWatchCryptoError extends Error {
  readonly code = "crypto" as const;

  constructor(message: string) {
    super(message);
    this.name = "EncryptedWatchCryptoError";
  }
}

type EncryptedWatchRow = Record<string, SqlValue> & {
  watch_id: string;
  capability_hash: ArrayBuffer;
  state: string;
  created_at: number;
  expires_at: number;
  next_run_at: number | null;
  cadence_ms: number;
  max_runs: number;
  run_count: number;
  lease_generation: number;
  lease_token_hash: ArrayBuffer | null;
  lease_expires_at: number | null;
  payload_version: number;
  payload_key_id: string | null;
  payload_nonce: ArrayBuffer | null;
  payload_options_binding: ArrayBuffer | null;
  payload_ciphertext: ArrayBuffer | null;
  last_outcome: string | null;
  last_job_id: string | null;
  last_report_id: string | null;
  last_attempt_at: number | null;
  completed_at: number | null;
  updated_at: number;
};

type EncryptedWatchRunRow = Record<string, SqlValue> & {
  watch_id: string;
  run_number: number;
  outcome: string;
  job_id: string | null;
  report_id: string | null;
  admitted_at: number | null;
  recorded_at: number;
  terminal_outcome: string | null;
  terminal_error_code: string | null;
  terminal_at: number | null;
};

export async function importEncryptedWatchKeyring(input: Readonly<{
  current: string;
  previous?: string;
}>): Promise<EncryptedWatchKeyring> {
  const current = await importEncryptedWatchKey(input.current, ENCRYPTED_WATCH_ENCRYPTION_KEY_ENV);
  const previous = input.previous
    ? await importEncryptedWatchKey(input.previous, ENCRYPTED_WATCH_PREVIOUS_ENCRYPTION_KEY_ENV)
    : null;
  if (previous?.keyId === current.keyId) {
    throw new EncryptedWatchValidationError("The current and previous encrypted-watch keys must be distinct.");
  }
  return Object.freeze({ current, previous });
}

export async function createEncryptedWatchCredential(
  randomBytes: (length: number) => Uint8Array = secureRandomBytes
): Promise<EncryptedWatchCredential> {
  const bytes = randomBytes(CAPABILITY_TOKEN_BYTES);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== CAPABILITY_TOKEN_BYTES) {
    throw new EncryptedWatchValidationError("The encrypted-watch credential source returned invalid bytes.");
  }
  return createEncryptedWatchCredentialFromToken(encodeBase64Url(bytes));
}

/**
 * Reconstruct one browser-owned idempotency credential without storing its raw
 * capability. The domain-separated 128-bit locator is opaque; authorization
 * still requires the independent full 256-bit capability token.
 */
export async function createEncryptedWatchCredentialFromToken(token: string): Promise<EncryptedWatchCredential> {
  const tokenBytes = decodeCanonicalBase64Url(
    token,
    KEY_BASE64URL_LENGTH,
    CAPABILITY_TOKEN_BYTES,
    "encrypted-watch capability token"
  );
  const [watchId, tokenHash] = await Promise.all([
    deriveEncryptedWatchIdFromCapabilityToken(token),
    sha256(tokenBytes)
  ]);
  const credential = Object.freeze({ watchId, token, tokenHash: copyArrayBuffer(tokenHash) });
  issuedWatchCredentials.set(
    credential,
    Object.freeze({ watchId, token, tokenHash: copyArrayBuffer(tokenHash) })
  );
  return credential;
}

export async function hashEncryptedWatchCapabilityToken(token: string): Promise<ArrayBuffer> {
  const bytes = decodeCanonicalBase64Url(
    token,
    KEY_BASE64URL_LENGTH,
    CAPABILITY_TOKEN_BYTES,
    "encrypted-watch capability token"
  );
  return sha256(bytes);
}

export async function createEncryptedWatchAdmission(
  keyring: EncryptedWatchKeyring,
  input: Readonly<{
    credential: EncryptedWatchCredential;
    createdAt: number;
    payload: EncryptedWatchPayload;
    initialRun: EncryptedWatchRunLink;
  }>,
  randomBytes: (length: number) => Uint8Array = secureRandomBytes
): Promise<EncryptedWatchAdmission> {
  assertKeyring(keyring);
  assertIssuedWatchCredential(input.credential);
  assertTimestamp(input.createdAt, "creation timestamp");
  assertRunLink(input.initialRun, input.createdAt);
  const payload = canonicalPayload(input.payload);
  const expiresAt = safeTimestampAdd(input.createdAt, ENCRYPTED_WATCH_TTL_MS, "expiry timestamp");
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  if (plaintext.byteLength > MAX_PAYLOAD_PLAINTEXT_BYTES) {
    throw new EncryptedWatchValidationError("The encrypted-watch payload is too large.");
  }
  const nonce = randomBytes(NONCE_BYTES);
  if (!(nonce instanceof Uint8Array) || nonce.byteLength !== NONCE_BYTES) {
    throw new EncryptedWatchValidationError("The encrypted-watch nonce source returned an invalid nonce.");
  }
  const optionsBinding = await bindOptions(keyring.current, payload);
  try {
    const ciphertext = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: copyArrayBuffer(nonce),
        additionalData: encryptedWatchAdditionalData({
          watchId: input.credential.watchId,
          keyId: keyring.current.keyId,
          createdAt: input.createdAt,
          expiresAt,
          optionsBinding
        }),
        tagLength: 128
      },
      keyring.current.cryptoKey,
      plaintext
    );
    if (ciphertext.byteLength < 16 || ciphertext.byteLength > MAX_PAYLOAD_CIPHERTEXT_BYTES) {
      throw new EncryptedWatchCryptoError("The encrypted-watch ciphertext has an invalid size.");
    }
    return Object.freeze({
      watchId: input.credential.watchId,
      capabilityHash: copyArrayBuffer(input.credential.tokenHash),
      createdAt: input.createdAt,
      expiresAt,
      nextRunAt: safeTimestampAdd(input.createdAt, ENCRYPTED_WATCH_CADENCE_MS, "first rescan timestamp"),
      cadenceMs: ENCRYPTED_WATCH_CADENCE_MS,
      maxRuns: ENCRYPTED_WATCH_MAX_RUNS,
      initialRun: Object.freeze({ ...input.initialRun }),
      envelope: Object.freeze({
        version: ENCRYPTED_WATCH_ENVELOPE_VERSION,
        keyId: keyring.current.keyId,
        nonce: copyArrayBuffer(nonce),
        optionsBinding: copyArrayBuffer(optionsBinding),
        ciphertext: copyArrayBuffer(ciphertext)
      })
    });
  } catch (error) {
    if (error instanceof EncryptedWatchCryptoError) throw error;
    throw new EncryptedWatchCryptoError("The encrypted-watch payload could not be encrypted.");
  }
}

export async function decryptEncryptedWatchClaim(
  keyring: EncryptedWatchKeyring,
  claim: EncryptedWatchClaim
): Promise<EncryptedWatchPayload> {
  assertKeyring(keyring);
  assertClaim(claim);
  const key = keyForEnvelope(keyring, claim.envelope.keyId);
  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: claim.envelope.nonce,
        additionalData: encryptedWatchAdditionalData({
          watchId: claim.watchId,
          keyId: claim.envelope.keyId,
          createdAt: claim.createdAt,
          expiresAt: claim.expiresAt,
          optionsBinding: claim.envelope.optionsBinding
        }),
        tagLength: 128
      },
      key.cryptoKey,
      claim.envelope.ciphertext
    );
    if (plaintext.byteLength > MAX_PAYLOAD_PLAINTEXT_BYTES) {
      throw new EncryptedWatchValidationError("The decrypted encrypted-watch payload is too large.");
    }
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext));
    const payload = canonicalPayload(parsed);
    const expectedBinding = await bindOptions(key, payload);
    if (!equalBytes(expectedBinding, claim.envelope.optionsBinding)) {
      throw new EncryptedWatchCryptoError("The encrypted-watch options binding does not match.");
    }
    return payload;
  } catch (error) {
    if (error instanceof EncryptedWatchValidationError || error instanceof EncryptedWatchCryptoError) throw error;
    throw new EncryptedWatchCryptoError("The encrypted-watch payload could not be authenticated and decrypted.");
  }
}

export async function createEncryptedWatchLeaseCredentials(
  count: number,
  randomBytes: (length: number) => Uint8Array = secureRandomBytes
): Promise<EncryptedWatchLeaseCredential[]> {
  if (!Number.isSafeInteger(count) || count < 0 || count > ENCRYPTED_WATCH_MAX_ACTIVE) {
    throw new EncryptedWatchValidationError("Invalid encrypted-watch lease credential count.");
  }
  const credentials: EncryptedWatchLeaseCredential[] = [];
  const seen = new Set<string>();
  while (credentials.length < count) {
    const bytes = randomBytes(LEASE_TOKEN_BYTES);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== LEASE_TOKEN_BYTES) {
      throw new EncryptedWatchValidationError("The encrypted-watch lease source returned an invalid token.");
    }
    const token = encodeBase64Url(bytes);
    if (seen.has(token)) continue;
    seen.add(token);
    const tokenHash = await sha256(bytes);
    const credential = Object.freeze({ token, tokenHash: copyArrayBuffer(tokenHash) });
    issuedLeaseCredentials.set(credential, Object.freeze({ token, tokenHash: copyArrayBuffer(tokenHash) }));
    credentials.push(credential);
  }
  return credentials;
}

export async function hashEncryptedWatchLeaseToken(token: string): Promise<ArrayBuffer> {
  return sha256(
    decodeCanonicalBase64Url(token, KEY_BASE64URL_LENGTH, LEASE_TOKEN_BYTES, "encrypted-watch lease token")
  );
}

/** Create the watch tables without activating any public route or scheduler. */
export function ensureEncryptedWatchStore(sql: EncryptedWatchStoreSql): void {
  sql.exec(
    "CREATE TABLE IF NOT EXISTS encrypted_watch_schema (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), version INTEGER NOT NULL)"
  );
  sql.exec(
    "INSERT OR IGNORE INTO encrypted_watch_schema (singleton, version) VALUES (1, ?)",
    STORE_SCHEMA_VERSION
  );
  const version = sql
    .exec<Record<string, SqlValue> & { version: number }>(
      "SELECT version FROM encrypted_watch_schema WHERE singleton = 1 LIMIT 1"
    )
    .toArray()[0]?.version;
  if (version !== STORE_SCHEMA_VERSION) {
    throw new EncryptedWatchValidationError("Unsupported encrypted-watch store schema version.");
  }
  sql.exec(
    `CREATE TABLE IF NOT EXISTS encrypted_watches (
      watch_id TEXT PRIMARY KEY,
      capability_hash BLOB NOT NULL UNIQUE CHECK(length(capability_hash) = ${SHA256_BYTES}),
      state TEXT NOT NULL CHECK(state IN ('active','leased','completed')),
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL CHECK(expires_at = created_at + ${ENCRYPTED_WATCH_TTL_MS}),
      next_run_at INTEGER,
      cadence_ms INTEGER NOT NULL CHECK(cadence_ms = ${ENCRYPTED_WATCH_CADENCE_MS}),
      max_runs INTEGER NOT NULL CHECK(max_runs = ${ENCRYPTED_WATCH_MAX_RUNS}),
      run_count INTEGER NOT NULL DEFAULT 0 CHECK(run_count BETWEEN 0 AND ${ENCRYPTED_WATCH_MAX_RUNS}),
      lease_generation INTEGER NOT NULL DEFAULT 0 CHECK(lease_generation >= 0),
      lease_token_hash BLOB,
      lease_expires_at INTEGER,
      payload_version INTEGER NOT NULL CHECK(payload_version = ${ENCRYPTED_WATCH_ENVELOPE_VERSION}),
      payload_key_id TEXT,
      payload_nonce BLOB,
      payload_options_binding BLOB,
      payload_ciphertext BLOB,
      last_outcome TEXT CHECK(last_outcome IN ('admitted','failed')),
      last_job_id TEXT,
      last_report_id TEXT,
      last_attempt_at INTEGER,
      completed_at INTEGER,
      updated_at INTEGER NOT NULL,
      CHECK(
        (state = 'active' AND next_run_at IS NOT NULL AND run_count < max_runs
          AND payload_key_id IS NOT NULL AND length(payload_nonce) = ${NONCE_BYTES}
          AND length(payload_options_binding) = ${SHA256_BYTES} AND payload_ciphertext IS NOT NULL
          AND lease_token_hash IS NULL AND lease_expires_at IS NULL AND completed_at IS NULL)
        OR (state = 'leased' AND next_run_at IS NOT NULL AND run_count < max_runs
          AND payload_key_id IS NOT NULL AND length(payload_nonce) = ${NONCE_BYTES}
          AND length(payload_options_binding) = ${SHA256_BYTES} AND payload_ciphertext IS NOT NULL
          AND length(lease_token_hash) = ${SHA256_BYTES} AND lease_expires_at IS NOT NULL AND completed_at IS NULL)
        OR (state = 'completed' AND next_run_at IS NULL
          AND payload_key_id IS NULL AND payload_nonce IS NULL
          AND payload_options_binding IS NULL AND payload_ciphertext IS NULL
          AND lease_token_hash IS NULL AND lease_expires_at IS NULL AND completed_at IS NOT NULL)
      ),
      CHECK(
        (last_outcome IS NULL AND last_job_id IS NULL AND last_report_id IS NULL AND last_attempt_at IS NULL)
        OR (last_outcome = 'admitted' AND last_job_id IS NOT NULL AND last_report_id IS NOT NULL AND last_attempt_at IS NOT NULL)
        OR (last_outcome = 'failed' AND last_job_id IS NULL AND last_report_id IS NULL AND last_attempt_at IS NOT NULL)
      )
    )`
  );
  sql.exec("CREATE INDEX IF NOT EXISTS encrypted_watches_due ON encrypted_watches(state, next_run_at, watch_id)");
  sql.exec(
    "CREATE INDEX IF NOT EXISTS encrypted_watches_lease_expiry ON encrypted_watches(state, lease_expires_at, watch_id)"
  );
  sql.exec("CREATE INDEX IF NOT EXISTS encrypted_watches_expiry ON encrypted_watches(expires_at, watch_id)");
  sql.exec(
    `CREATE TABLE IF NOT EXISTS encrypted_watch_runs (
      watch_id TEXT NOT NULL,
      run_number INTEGER NOT NULL CHECK(run_number BETWEEN 1 AND ${ENCRYPTED_WATCH_MAX_RUNS}),
      outcome TEXT NOT NULL CHECK(outcome IN ('admitted','failed')),
      job_id TEXT,
      report_id TEXT,
      admitted_at INTEGER,
      recorded_at INTEGER NOT NULL,
      terminal_outcome TEXT CHECK(terminal_outcome IN ('succeeded','failed','expired','cancelled')),
      terminal_error_code TEXT,
      terminal_at INTEGER,
      PRIMARY KEY (watch_id, run_number),
      CHECK(
        (outcome = 'admitted' AND job_id IS NOT NULL AND report_id IS NOT NULL AND admitted_at IS NOT NULL)
        OR (outcome = 'failed' AND job_id IS NULL AND report_id IS NULL AND admitted_at IS NULL)
      ),
      CHECK(
        (terminal_outcome IS NULL AND terminal_error_code IS NULL AND terminal_at IS NULL)
        OR (terminal_outcome = 'succeeded' AND terminal_error_code IS NULL AND terminal_at IS NOT NULL)
        OR (terminal_outcome IN ('failed','expired','cancelled') AND terminal_error_code IS NOT NULL AND terminal_at IS NOT NULL)
      )
    )`
  );
  sql.exec("CREATE INDEX IF NOT EXISTS encrypted_watch_runs_watch ON encrypted_watch_runs(watch_id, run_number)");
  sql.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS encrypted_watch_runs_job ON encrypted_watch_runs(job_id) WHERE job_id IS NOT NULL"
  );
  sql.exec(
    "CREATE TABLE IF NOT EXISTS encrypted_watch_global_budget (bucket_start INTEGER PRIMARY KEY, used INTEGER NOT NULL CHECK(used >= 0), resets_at INTEGER NOT NULL)"
  );
}

/** Caller must run this synchronous mutation inside the authoritative DO transaction. */
export function admitEncryptedWatch(
  sql: EncryptedWatchStoreSql,
  admission: EncryptedWatchAdmission
): EncryptedWatchSnapshot {
  ensureEncryptedWatchStore(sql);
  assertAdmission(admission);
  purgeExpiredEncryptedWatches(sql, admission.createdAt);
  if (selectRow(sql, admission.watchId)) {
    throw new EncryptedWatchStateError("conflict", "The encrypted watch already exists.");
  }
  const capabilityOwner = sql
    .exec<Record<string, SqlValue> & { watch_id: string }>(
      "SELECT watch_id FROM encrypted_watches WHERE capability_hash = ? LIMIT 1",
      admission.capabilityHash
    )
    .toArray()[0];
  if (capabilityOwner) throw new EncryptedWatchStateError("conflict", "The encrypted-watch capability is already assigned.");
  const activeCount = integer(
    sql
      .exec<Record<string, SqlValue> & { count: number }>(
        "SELECT COUNT(*) AS count FROM encrypted_watches WHERE state IN ('active','leased')"
      )
      .toArray()[0]?.count,
    "active count"
  );
  if (activeCount >= ENCRYPTED_WATCH_MAX_ACTIVE) throw new EncryptedWatchCapacityError();

  sql.exec(
    `INSERT INTO encrypted_watches (
      watch_id, capability_hash, state, created_at, expires_at, next_run_at,
      cadence_ms, max_runs, run_count, lease_generation, lease_token_hash, lease_expires_at,
      payload_version, payload_key_id, payload_nonce, payload_options_binding, payload_ciphertext,
      last_outcome, last_job_id, last_report_id, last_attempt_at, completed_at, updated_at
    ) VALUES (?, ?, 'active', ?, ?, ?, ?, ?, 1, 0, NULL, NULL, ?, ?, ?, ?, ?, 'admitted', ?, ?, ?, NULL, ?)`,
    admission.watchId,
    admission.capabilityHash,
    admission.createdAt,
    admission.expiresAt,
    admission.nextRunAt,
    admission.cadenceMs,
    admission.maxRuns,
    admission.envelope.version,
    admission.envelope.keyId,
    admission.envelope.nonce,
    admission.envelope.optionsBinding,
    admission.envelope.ciphertext,
    admission.initialRun.jobId,
    admission.initialRun.reportId,
    admission.createdAt,
    admission.createdAt
  );
  insertRunRecord(sql, admission.watchId, 1, {
    outcome: "admitted",
    jobId: admission.initialRun.jobId,
    reportId: admission.initialRun.reportId,
    admittedAt: admission.initialRun.admittedAt
  }, admission.createdAt);
  return snapshotFromRow(sql, requireRow(sql, admission.watchId));
}

/** Metadata-only authenticated lookup; this function never decrypts target/options. */
export function findEncryptedWatchByCapability(
  sql: EncryptedWatchStoreSql,
  input: Readonly<{ watchId: string; capabilityHash: ArrayBuffer; now: number }>
): EncryptedWatchSnapshot | null {
  ensureEncryptedWatchStore(sql);
  assertWatchId(input.watchId);
  assertDigest(input.capabilityHash, "capability digest");
  assertTimestamp(input.now, "read timestamp");
  const row = selectRow(sql, input.watchId);
  if (!row || !equalBytes(row.capability_hash, input.capabilityHash)) return null;
  if (row.expires_at <= input.now) {
    sql.exec("DELETE FROM encrypted_watch_runs WHERE watch_id = ?", input.watchId);
    sql.exec("DELETE FROM encrypted_watches WHERE watch_id = ? AND expires_at <= ?", input.watchId, input.now);
    return null;
  }
  return snapshotFromRow(sql, row);
}

/** Hard delete is rollback-safe while disabled and fences every outstanding lease. */
export function deleteEncryptedWatch(
  sql: EncryptedWatchStoreSql,
  input: Readonly<{ watchId: string; capabilityHash: ArrayBuffer }>
): boolean {
  ensureEncryptedWatchStore(sql);
  assertWatchId(input.watchId);
  assertDigest(input.capabilityHash, "capability digest");
  const row = selectRow(sql, input.watchId);
  if (!row || !equalBytes(row.capability_hash, input.capabilityHash)) return false;
  sql.exec("DELETE FROM encrypted_watch_runs WHERE watch_id = ?", input.watchId);
  sql.exec("DELETE FROM encrypted_watches WHERE watch_id = ? AND capability_hash = ?", input.watchId, input.capabilityHash);
  return true;
}

/**
 * Claim at most one in-flight run per watch. The caller must first enforce the
 * readiness gate and must keep this mutation inside transactionSync.
 */
export function claimDueEncryptedWatches(
  sql: EncryptedWatchStoreSql,
  input: Readonly<{
    now: number;
    capacity: number;
    credentials: readonly EncryptedWatchLeaseCredential[];
  }>
): EncryptedWatchClaim[] {
  ensureEncryptedWatchStore(sql);
  assertTimestamp(input.now, "claim timestamp");
  if (
    !Number.isSafeInteger(input.capacity) ||
    input.capacity < 0 ||
    input.capacity > ENCRYPTED_WATCH_MAX_ACTIVE ||
    input.credentials.length < input.capacity
  ) {
    throw new EncryptedWatchValidationError("Invalid encrypted-watch claim capacity.");
  }
  purgeExpiredEncryptedWatches(sql, input.now);
  recoverExpiredEncryptedWatchLeases(sql, input.now);
  const leasedCount = integer(
    sql
      .exec<Record<string, SqlValue> & { count: number }>(
        "SELECT COUNT(*) AS count FROM encrypted_watches WHERE state = 'leased'"
      )
      .toArray()[0]?.count,
    "leased count"
  );
  const budget = peekEncryptedWatchGlobalBudget(sql, { now: input.now, cost: 1 });
  if (!budget.allowed) return [];
  const available = Math.min(input.capacity - leasedCount, budget.remaining, input.credentials.length);
  if (available <= 0) return [];
  const credentials = input.credentials.slice(0, available);
  assertLeaseCredentials(credentials);
  const rows = sql
    .exec<EncryptedWatchRow>(
      "SELECT * FROM encrypted_watches WHERE state = 'active' AND next_run_at <= ? AND expires_at > ? AND run_count < max_runs ORDER BY next_run_at ASC, created_at ASC, watch_id ASC LIMIT ?",
      input.now,
      input.now,
      available
    )
    .toArray();
  if (rows.length === 0) return [];
  const charge = chargeEncryptedWatchGlobalBudget(sql, { now: input.now, cost: rows.length });
  if (!charge.allowed) return [];

  const claims: EncryptedWatchClaim[] = [];
  rows.forEach((row, index) => {
    const credential = credentials[index];
    const generation = integer(row.lease_generation, "lease generation") + 1;
    const leaseExpiresAt = Math.min(
      safeTimestampAdd(input.now, ENCRYPTED_WATCH_LEASE_MS, "lease expiry"),
      integer(row.expires_at, "expiry timestamp")
    );
    sql.exec(
      `UPDATE encrypted_watches
       SET state = 'leased', lease_generation = ?, lease_token_hash = ?, lease_expires_at = ?, updated_at = ?
       WHERE watch_id = ? AND state = 'active' AND lease_generation = ? AND next_run_at <= ? AND expires_at > ?`,
      generation,
      credential.tokenHash,
      leaseExpiresAt,
      input.now,
      row.watch_id,
      generation - 1,
      input.now,
      input.now
    );
    const claimed = requireRow(sql, row.watch_id);
    if (
      claimed.state !== "leased" ||
      claimed.lease_generation !== generation ||
      !equalBytes(requireBlob(claimed.lease_token_hash, "lease-token digest"), credential.tokenHash)
    ) {
      throw new EncryptedWatchStateError("conflict", "The encrypted watch could not be claimed.");
    }
    claims.push(claimFromRow(claimed, credential.token));
  });
  return claims;
}

/** Resolve one exact unexpired lease; delete/cancel and newer leases always fence it. */
export function resolveEncryptedWatchLease(
  sql: EncryptedWatchStoreSql,
  input: Readonly<{
    watchId: string;
    generation: number;
    tokenHash: ArrayBuffer;
    now: number;
    resolution: EncryptedWatchRunResolution;
  }>
): EncryptedWatchSnapshot {
  ensureEncryptedWatchStore(sql);
  assertResolution(input.resolution);
  purgeExpiredEncryptedWatches(sql, input.now);
  const row = requireCurrentLease(sql, input);
  advanceAfterRun(sql, row, input.now, input.resolution, {
    generation: input.generation,
    tokenHash: input.tokenHash,
    requireUnexpired: true
  });
  return snapshotFromRow(sql, requireRow(sql, input.watchId));
}

/**
 * Persist the durable job's terminal truth before its short-lived coordinator
 * row is purged. Replays are idempotent; contradictory terminal outcomes fail.
 */
export function recordEncryptedWatchRunTerminalOutcome(
  sql: EncryptedWatchStoreSql,
  input: Readonly<{
    jobId: string;
    now: number;
    resolution: EncryptedWatchRunTerminalResolution;
  }>
): EncryptedWatchSnapshot | null {
  ensureEncryptedWatchStore(sql);
  if (!isScanJobId(input.jobId)) throw new EncryptedWatchValidationError("Invalid encrypted-watch terminal job ID.");
  assertTimestamp(input.now, "terminal timestamp");
  assertTerminalResolution(input.resolution);
  purgeExpiredEncryptedWatches(sql, input.now);
  const run = sql
    .exec<EncryptedWatchRunRow>("SELECT * FROM encrypted_watch_runs WHERE job_id = ? LIMIT 1", input.jobId)
    .toArray()[0];
  if (!run) return null;
  if (run.admitted_at === null || run.admitted_at > input.now) {
    throw new EncryptedWatchStateError("conflict", "The encrypted-watch terminal timestamp predates admission.");
  }
  const errorCode = input.resolution.outcome === "succeeded" ? null : input.resolution.errorCode;
  if (run.terminal_outcome !== null) {
    if (run.terminal_outcome !== input.resolution.outcome || run.terminal_error_code !== errorCode) {
      throw new EncryptedWatchStateError("conflict", "The encrypted-watch run already has a different terminal outcome.");
    }
    const existing = selectRow(sql, run.watch_id);
    return existing ? snapshotFromRow(sql, existing) : null;
  }
  sql.exec(
    `UPDATE encrypted_watch_runs
     SET terminal_outcome = ?, terminal_error_code = ?, terminal_at = ?
     WHERE job_id = ? AND terminal_outcome IS NULL`,
    input.resolution.outcome,
    errorCode,
    input.now,
    input.jobId
  );
  const updated = sql
    .exec<EncryptedWatchRunRow>("SELECT * FROM encrypted_watch_runs WHERE job_id = ? LIMIT 1", input.jobId)
    .toArray()[0];
  if (!updated || updated.terminal_outcome !== input.resolution.outcome || updated.terminal_error_code !== errorCode) {
    throw new EncryptedWatchStateError("conflict", "The encrypted-watch terminal outcome could not be recorded.");
  }
  const watch = selectRow(sql, run.watch_id);
  return watch ? snapshotFromRow(sql, watch) : null;
}

/** Count an abandoned lease once, then schedule no sooner than one full cadence. */
export function recoverExpiredEncryptedWatchLeases(sql: EncryptedWatchStoreSql, now: number): number {
  ensureEncryptedWatchStore(sql);
  assertTimestamp(now, "lease-recovery timestamp");
  purgeExpiredEncryptedWatches(sql, now);
  const rows = sql
    .exec<EncryptedWatchRow>(
      "SELECT * FROM encrypted_watches WHERE state = 'leased' AND lease_expires_at <= ? AND expires_at > ? ORDER BY lease_expires_at ASC, watch_id ASC",
      now,
      now
    )
    .toArray();
  for (const row of rows) {
    advanceAfterRun(sql, row, now, { outcome: "failed" }, {
      generation: integer(row.lease_generation, "lease generation"),
      requireExpired: true
    });
  }
  return rows.length;
}

/** Hard TTL: expiry removes metadata, capability digest, and ciphertext together. */
export function purgeExpiredEncryptedWatches(sql: EncryptedWatchStoreSql, now: number): number {
  ensureEncryptedWatchStore(sql);
  assertTimestamp(now, "purge timestamp");
  const count = integer(
    sql
      .exec<Record<string, SqlValue> & { count: number }>(
        "SELECT COUNT(*) AS count FROM encrypted_watches WHERE expires_at <= ?",
        now
      )
      .toArray()[0]?.count,
    "expired count"
  );
  if (count > 0) {
    sql.exec(
      "DELETE FROM encrypted_watch_runs WHERE watch_id IN (SELECT watch_id FROM encrypted_watches WHERE expires_at <= ?)",
      now
    );
    sql.exec("DELETE FROM encrypted_watches WHERE expires_at <= ?", now);
  }
  return count;
}

export function peekEncryptedWatchGlobalBudget(
  sql: EncryptedWatchStoreSql,
  input: Readonly<{ now: number; cost: number }>
): EncryptedWatchGlobalBudgetResult {
  return evaluateGlobalBudget(sql, input, false);
}

export function chargeEncryptedWatchGlobalBudget(
  sql: EncryptedWatchStoreSql,
  input: Readonly<{ now: number; cost: number }>
): EncryptedWatchGlobalBudgetResult {
  return evaluateGlobalBudget(sql, input, true);
}

/** Earliest due/lease/TTL wake, with budget exhaustion deferred to the UTC reset. */
export function nextEncryptedWatchWakeAt(sql: EncryptedWatchStoreSql, now: number): number | null {
  ensureEncryptedWatchStore(sql);
  assertTimestamp(now, "wake timestamp");
  const due = nullableInteger(
    sql
      .exec<Record<string, SqlValue> & { wake_at: number | null }>(
        "SELECT MIN(next_run_at) AS wake_at FROM encrypted_watches WHERE state = 'active'"
      )
      .toArray()[0]?.wake_at,
    "next due timestamp"
  );
  const lease = nullableInteger(
    sql
      .exec<Record<string, SqlValue> & { wake_at: number | null }>(
        "SELECT MIN(lease_expires_at) AS wake_at FROM encrypted_watches WHERE state = 'leased'"
      )
      .toArray()[0]?.wake_at,
    "lease wake timestamp"
  );
  const expiry = nullableInteger(
    sql
      .exec<Record<string, SqlValue> & { wake_at: number | null }>(
        "SELECT MIN(expires_at) AS wake_at FROM encrypted_watches"
      )
      .toArray()[0]?.wake_at,
    "expiry wake timestamp"
  );
  const budget = due !== null && due <= now ? peekEncryptedWatchGlobalBudget(sql, { now, cost: 1 }) : null;
  const dueWake = budget && !budget.allowed ? budget.resetsAt : due;
  const candidates = [dueWake, lease, expiry].filter((value): value is number => value !== null);
  return candidates.length === 0 ? null : Math.max(now, Math.min(...candidates));
}

function evaluateGlobalBudget(
  sql: EncryptedWatchStoreSql,
  input: Readonly<{ now: number; cost: number }>,
  consume: boolean
): EncryptedWatchGlobalBudgetResult {
  ensureEncryptedWatchStore(sql);
  assertTimestamp(input.now, "budget timestamp");
  if (!Number.isSafeInteger(input.cost) || input.cost < 1 || input.cost > ENCRYPTED_WATCH_MAX_ACTIVE) {
    throw new EncryptedWatchValidationError("Invalid encrypted-watch global-budget cost.");
  }
  const bucketStart = Math.floor(input.now / DAY_MS) * DAY_MS;
  const resetsAt = safeTimestampAdd(bucketStart, DAY_MS, "budget reset timestamp");
  sql.exec("DELETE FROM encrypted_watch_global_budget WHERE resets_at <= ?", input.now);
  const row = sql
    .exec<Record<string, SqlValue> & { used: number }>(
      "SELECT used FROM encrypted_watch_global_budget WHERE bucket_start = ? LIMIT 1",
      bucketStart
    )
    .toArray()[0];
  const used = row ? integer(row.used, "global-budget usage") : 0;
  const allowed = used + input.cost <= ENCRYPTED_WATCH_GLOBAL_DAILY_RUN_BUDGET;
  if (allowed && consume) {
    sql.exec(
      "INSERT INTO encrypted_watch_global_budget (bucket_start, used, resets_at) VALUES (?, ?, ?) ON CONFLICT(bucket_start) DO UPDATE SET used = excluded.used, resets_at = excluded.resets_at",
      bucketStart,
      used + input.cost,
      resetsAt
    );
  }
  const finalUsed = allowed && consume ? used + input.cost : used;
  return Object.freeze({
    allowed,
    used: finalUsed,
    remaining: Math.max(0, ENCRYPTED_WATCH_GLOBAL_DAILY_RUN_BUDGET - finalUsed),
    resetsAt
  });
}

function advanceAfterRun(
  sql: EncryptedWatchStoreSql,
  row: EncryptedWatchRow,
  now: number,
  resolution: EncryptedWatchRunResolution,
  fence: Readonly<{
    generation: number;
    tokenHash?: ArrayBuffer;
    requireUnexpired?: boolean;
    requireExpired?: boolean;
  }>
): void {
  const historyCount = integer(
    sql
      .exec<Record<string, SqlValue> & { count: number }>(
        "SELECT COUNT(*) AS count FROM encrypted_watch_runs WHERE watch_id = ?",
        row.watch_id
      )
      .toArray()[0]?.count,
    "history count"
  );
  if (historyCount !== row.run_count) {
    throw new EncryptedWatchStateError("conflict", "The encrypted-watch history is out of sync.", rowState(row));
  }
  const runCount = integer(row.run_count, "run count") + 1;
  const nextRunAt = safeTimestampAdd(now, ENCRYPTED_WATCH_CADENCE_MS, "next-run timestamp");
  const completed = runCount >= ENCRYPTED_WATCH_MAX_RUNS || nextRunAt >= row.expires_at;
  const latestJobId = resolution.outcome === "admitted" ? resolution.jobId : null;
  const latestReportId = resolution.outcome === "admitted" ? resolution.reportId : null;
  const tokenPredicate = fence.tokenHash ? " AND lease_token_hash = ?" : "";
  const timePredicate = fence.requireUnexpired
    ? " AND lease_expires_at > ? AND expires_at > ?"
    : fence.requireExpired
      ? " AND lease_expires_at <= ? AND expires_at > ?"
      : "";
  const tailBindings: SqlValue[] = [row.watch_id, fence.generation];
  if (fence.tokenHash) tailBindings.push(fence.tokenHash);
  if (fence.requireUnexpired || fence.requireExpired) tailBindings.push(now, now);

  if (completed) {
    sql.exec(
      `UPDATE encrypted_watches
       SET state = 'completed', run_count = ?, next_run_at = NULL,
           lease_token_hash = NULL, lease_expires_at = NULL,
           payload_key_id = NULL, payload_nonce = NULL, payload_options_binding = NULL, payload_ciphertext = NULL,
           last_outcome = ?, last_job_id = ?, last_report_id = ?, last_attempt_at = ?, completed_at = ?, updated_at = ?
       WHERE watch_id = ? AND state = 'leased' AND lease_generation = ?${tokenPredicate}${timePredicate}`,
      runCount,
      resolution.outcome,
      latestJobId,
      latestReportId,
      now,
      now,
      now,
      ...tailBindings
    );
  } else {
    sql.exec(
      `UPDATE encrypted_watches
       SET state = 'active', run_count = ?, next_run_at = ?,
           lease_token_hash = NULL, lease_expires_at = NULL,
           last_outcome = ?, last_job_id = ?, last_report_id = ?, last_attempt_at = ?, updated_at = ?
       WHERE watch_id = ? AND state = 'leased' AND lease_generation = ?${tokenPredicate}${timePredicate}`,
      runCount,
      nextRunAt,
      resolution.outcome,
      latestJobId,
      latestReportId,
      now,
      now,
      ...tailBindings
    );
  }
  const current = selectRow(sql, row.watch_id);
  if (!current || current.lease_generation !== fence.generation || current.state === "leased") {
    throw new EncryptedWatchStateError("lease-invalid", "The encrypted-watch lease is stale or expired.", current ? rowState(current) : null);
  }
  insertRunRecord(sql, row.watch_id, runCount, resolution, now);
}

function insertRunRecord(
  sql: EncryptedWatchStoreSql,
  watchId: string,
  runNumber: number,
  resolution: EncryptedWatchRunResolution,
  recordedAt: number
): void {
  assertWatchId(watchId);
  if (!Number.isSafeInteger(runNumber) || runNumber < 1 || runNumber > ENCRYPTED_WATCH_MAX_RUNS) {
    throw new EncryptedWatchValidationError("Invalid encrypted-watch history run number.");
  }
  assertTimestamp(recordedAt, "history timestamp");
  assertResolution(resolution);
  if (resolution.outcome === "admitted") {
    if (resolution.admittedAt > recordedAt) {
      throw new EncryptedWatchValidationError("An encrypted-watch run cannot be admitted in the future.");
    }
    sql.exec(
      "INSERT INTO encrypted_watch_runs (watch_id, run_number, outcome, job_id, report_id, admitted_at, recorded_at) VALUES (?, ?, 'admitted', ?, ?, ?, ?)",
      watchId,
      runNumber,
      resolution.jobId,
      resolution.reportId,
      resolution.admittedAt,
      recordedAt
    );
    return;
  }
  sql.exec(
    "INSERT INTO encrypted_watch_runs (watch_id, run_number, outcome, job_id, report_id, admitted_at, recorded_at) VALUES (?, ?, 'failed', NULL, NULL, NULL, ?)",
    watchId,
    runNumber,
    recordedAt
  );
}

function requireCurrentLease(
  sql: EncryptedWatchStoreSql,
  input: Readonly<{ watchId: string; generation: number; tokenHash: ArrayBuffer; now: number }>
): EncryptedWatchRow {
  assertWatchId(input.watchId);
  assertGeneration(input.generation);
  assertDigest(input.tokenHash, "lease-token digest");
  assertTimestamp(input.now, "lease mutation timestamp");
  const row = selectRow(sql, input.watchId);
  if (!row) throw new EncryptedWatchStateError("not-found", "The encrypted watch does not exist.");
  const state = rowState(row);
  if (
    state !== "leased" ||
    row.lease_generation !== input.generation ||
    row.lease_expires_at === null ||
    row.lease_expires_at <= input.now ||
    row.expires_at <= input.now ||
    !equalBytes(requireBlob(row.lease_token_hash, "lease-token digest"), input.tokenHash)
  ) {
    throw new EncryptedWatchStateError("lease-invalid", "The encrypted-watch lease is invalid or expired.", state);
  }
  return row;
}

function selectRow(sql: EncryptedWatchStoreSql, watchId: string): EncryptedWatchRow | null {
  return sql
    .exec<EncryptedWatchRow>("SELECT * FROM encrypted_watches WHERE watch_id = ? LIMIT 1", watchId)
    .toArray()[0] ?? null;
}

function requireRow(sql: EncryptedWatchStoreSql, watchId: string): EncryptedWatchRow {
  const row = selectRow(sql, watchId);
  if (!row) throw new EncryptedWatchStateError("not-found", "The encrypted watch does not exist.");
  return row;
}

function snapshotFromRow(sql: EncryptedWatchStoreSql, row: EncryptedWatchRow): EncryptedWatchSnapshot {
  const state = rowState(row);
  return Object.freeze({
    watchId: row.watch_id,
    state,
    createdAt: integer(row.created_at, "created timestamp"),
    expiresAt: integer(row.expires_at, "expiry timestamp"),
    nextRunAt: nullableInteger(row.next_run_at, "next-run timestamp"),
    cadenceMs: exactPolicyInteger(row.cadence_ms, ENCRYPTED_WATCH_CADENCE_MS, "cadence"),
    maxRuns: exactPolicyInteger(row.max_runs, ENCRYPTED_WATCH_MAX_RUNS, "maximum runs"),
    runCount: integer(row.run_count, "run count"),
    leaseGeneration: integer(row.lease_generation, "lease generation"),
    leaseExpiresAt: nullableInteger(row.lease_expires_at, "lease expiry"),
    lastOutcome: nullableOutcome(row.last_outcome),
    latestJobId: nullableJobId(row.last_job_id, "latest job ID"),
    latestReportId: nullableJobId(row.last_report_id, "latest report ID"),
    lastAttemptAt: nullableInteger(row.last_attempt_at, "last-attempt timestamp"),
    completedAt: nullableInteger(row.completed_at, "completion timestamp"),
    updatedAt: integer(row.updated_at, "updated timestamp"),
    history: listRunHistory(sql, row.watch_id)
  });
}

function listRunHistory(sql: EncryptedWatchStoreSql, watchId: string): readonly EncryptedWatchRunRecord[] {
  const rows = sql
    .exec<EncryptedWatchRunRow>(
      "SELECT watch_id, run_number, outcome, job_id, report_id, admitted_at, recorded_at, terminal_outcome, terminal_error_code, terminal_at FROM encrypted_watch_runs WHERE watch_id = ? ORDER BY run_number ASC",
      watchId
    )
    .toArray();
  if (rows.length > ENCRYPTED_WATCH_MAX_RUNS) {
    throw new EncryptedWatchStateError("conflict", "The encrypted-watch history exceeds its run cap.");
  }
  return Object.freeze(rows.map((row, index) => {
    const runNumber = integer(row.run_number, "history run number");
    if (runNumber !== index + 1 || runNumber > ENCRYPTED_WATCH_MAX_RUNS) {
      throw new EncryptedWatchStateError("conflict", "The encrypted-watch history is not contiguous.");
    }
    const recordedAt = integer(row.recorded_at, "history recorded timestamp");
    if (row.outcome === "failed") {
      if (row.job_id !== null || row.report_id !== null || row.admitted_at !== null) {
        throw new EncryptedWatchStateError("conflict", "The failed encrypted-watch history record leaks linkage.");
      }
      return Object.freeze({
        runNumber,
        outcome: "failed" as const,
        jobId: null,
        reportId: null,
        admittedAt: null,
        recordedAt,
        terminalOutcome: null,
        terminalErrorCode: null,
        terminalAt: null
      });
    }
    if (
      row.outcome !== "admitted" ||
      !isScanJobId(row.job_id) ||
      !isScanJobId(row.report_id) ||
      row.job_id === row.report_id ||
      typeof row.admitted_at !== "number" ||
      !Number.isSafeInteger(row.admitted_at) ||
      row.admitted_at < 0
    ) {
      throw new EncryptedWatchStateError("conflict", "The admitted encrypted-watch history record is invalid.");
    }
    const terminal = terminalFieldsFromRow(row);
    return Object.freeze({
      runNumber,
      outcome: "admitted" as const,
      jobId: row.job_id,
      reportId: row.report_id,
      admittedAt: row.admitted_at,
      recordedAt,
      ...terminal
    });
  }));
}

function terminalFieldsFromRow(row: EncryptedWatchRunRow): Pick<
  EncryptedWatchRunRecord,
  "terminalOutcome" | "terminalErrorCode" | "terminalAt"
> {
  if (row.terminal_outcome === null) {
    if (row.terminal_error_code !== null || row.terminal_at !== null) {
      throw new EncryptedWatchStateError("conflict", "The encrypted-watch terminal history is incomplete.");
    }
    return { terminalOutcome: null, terminalErrorCode: null, terminalAt: null };
  }
  if (
    row.terminal_outcome !== "succeeded" &&
    row.terminal_outcome !== "failed" &&
    row.terminal_outcome !== "expired" &&
    row.terminal_outcome !== "cancelled"
  ) {
    throw new EncryptedWatchStateError("conflict", "The encrypted-watch terminal history outcome is invalid.");
  }
  const terminalAt = integer(row.terminal_at, "terminal history timestamp");
  if (row.terminal_outcome === "succeeded") {
    if (row.terminal_error_code !== null) {
      throw new EncryptedWatchStateError("conflict", "A successful encrypted-watch run has an error code.");
    }
    return { terminalOutcome: "succeeded", terminalErrorCode: null, terminalAt };
  }
  if (typeof row.terminal_error_code !== "string" || !ERROR_CODE_PATTERN.test(row.terminal_error_code)) {
    throw new EncryptedWatchStateError("conflict", "The encrypted-watch terminal error code is invalid.");
  }
  return {
    terminalOutcome: row.terminal_outcome,
    terminalErrorCode: row.terminal_error_code,
    terminalAt
  };
}

function claimFromRow(row: EncryptedWatchRow, leaseToken: string): EncryptedWatchClaim {
  if (rowState(row) !== "leased") throw new EncryptedWatchStateError("conflict", "The encrypted watch is not leased.");
  return Object.freeze({
    watchId: row.watch_id,
    state: "leased",
    createdAt: integer(row.created_at, "created timestamp"),
    expiresAt: integer(row.expires_at, "expiry timestamp"),
    dueAt: integer(row.next_run_at, "due timestamp"),
    cadenceMs: exactPolicyInteger(row.cadence_ms, ENCRYPTED_WATCH_CADENCE_MS, "cadence"),
    maxRuns: exactPolicyInteger(row.max_runs, ENCRYPTED_WATCH_MAX_RUNS, "maximum runs"),
    runCount: integer(row.run_count, "run count"),
    leaseGeneration: integer(row.lease_generation, "lease generation"),
    leaseExpiresAt: integer(row.lease_expires_at, "lease expiry"),
    leaseToken,
    envelope: Object.freeze({
      version: ENCRYPTED_WATCH_ENVELOPE_VERSION,
      keyId: text(row.payload_key_id, "payload key ID"),
      nonce: copyArrayBuffer(requireBlob(row.payload_nonce, "payload nonce")),
      optionsBinding: copyArrayBuffer(requireBlob(row.payload_options_binding, "payload options binding")),
      ciphertext: copyArrayBuffer(requireBlob(row.payload_ciphertext, "payload ciphertext"))
    })
  });
}

function assertAdmission(admission: EncryptedWatchAdmission): void {
  assertWatchId(admission.watchId);
  assertDigest(admission.capabilityHash, "capability digest");
  assertTimestamp(admission.createdAt, "creation timestamp");
  if (
    admission.expiresAt !== admission.createdAt + ENCRYPTED_WATCH_TTL_MS ||
    admission.nextRunAt !== admission.createdAt + ENCRYPTED_WATCH_CADENCE_MS ||
    admission.cadenceMs !== ENCRYPTED_WATCH_CADENCE_MS ||
    admission.maxRuns !== ENCRYPTED_WATCH_MAX_RUNS
  ) {
    throw new EncryptedWatchValidationError("Invalid encrypted-watch scheduling policy.");
  }
  assertRunLink(admission.initialRun, admission.createdAt);
  assertEnvelope(admission.envelope);
}

function assertClaim(claim: EncryptedWatchClaim): void {
  assertWatchId(claim.watchId);
  assertTimestamp(claim.createdAt, "claim creation timestamp");
  if (
    claim.expiresAt !== claim.createdAt + ENCRYPTED_WATCH_TTL_MS ||
    claim.cadenceMs !== ENCRYPTED_WATCH_CADENCE_MS ||
    claim.maxRuns !== ENCRYPTED_WATCH_MAX_RUNS ||
    !Number.isSafeInteger(claim.runCount) ||
    claim.runCount < 0 ||
    claim.runCount >= ENCRYPTED_WATCH_MAX_RUNS ||
    claim.state !== "leased" ||
    !isEncryptedWatchCapabilityToken(claim.leaseToken)
  ) {
    throw new EncryptedWatchValidationError("Invalid encrypted-watch claim.");
  }
  assertGeneration(claim.leaseGeneration);
  assertTimestamp(claim.leaseExpiresAt, "claim lease expiry");
  assertTimestamp(claim.dueAt, "claim due timestamp");
  assertEnvelope(claim.envelope);
}

function assertEnvelope(envelope: EncryptedWatchEnvelope): void {
  if (envelope.version !== ENCRYPTED_WATCH_ENVELOPE_VERSION || !KEY_ID_PATTERN.test(envelope.keyId)) {
    throw new EncryptedWatchValidationError("Unsupported encrypted-watch envelope.");
  }
  if (
    requireBlob(envelope.nonce, "payload nonce").byteLength !== NONCE_BYTES ||
    requireBlob(envelope.optionsBinding, "payload options binding").byteLength !== SHA256_BYTES ||
    requireBlob(envelope.ciphertext, "payload ciphertext").byteLength < 16 ||
    envelope.ciphertext.byteLength > MAX_PAYLOAD_CIPHERTEXT_BYTES
  ) {
    throw new EncryptedWatchValidationError("Invalid encrypted-watch envelope size.");
  }
}

function assertIssuedWatchCredential(credential: EncryptedWatchCredential): void {
  assertWatchId(credential.watchId);
  if (!isEncryptedWatchCapabilityToken(credential.token)) {
    throw new EncryptedWatchValidationError("Invalid encrypted-watch capability token.");
  }
  assertDigest(credential.tokenHash, "capability digest");
  const issued = issuedWatchCredentials.get(credential);
  if (
    !issued ||
    issued.watchId !== credential.watchId ||
    issued.token !== credential.token ||
    !equalBytes(issued.tokenHash, credential.tokenHash)
  ) {
    throw new EncryptedWatchValidationError("Encrypted-watch credentials must come from the credential factory.");
  }
}

function assertLeaseCredentials(credentials: readonly EncryptedWatchLeaseCredential[]): void {
  const seen = new Set<string>();
  for (const credential of credentials) {
    if (!isEncryptedWatchCapabilityToken(credential.token)) {
      throw new EncryptedWatchValidationError("Invalid encrypted-watch lease token.");
    }
    assertDigest(credential.tokenHash, "lease-token digest");
    const issued = issuedLeaseCredentials.get(credential);
    if (!issued || issued.token !== credential.token || !equalBytes(issued.tokenHash, credential.tokenHash)) {
      throw new EncryptedWatchValidationError("Encrypted-watch lease credentials must come from the credential factory.");
    }
    if (seen.has(credential.token)) throw new EncryptedWatchValidationError("Duplicate encrypted-watch lease token.");
    seen.add(credential.token);
  }
}

function assertResolution(resolution: EncryptedWatchRunResolution): void {
  if (!resolution || typeof resolution !== "object" || Array.isArray(resolution)) {
    throw new EncryptedWatchValidationError("Invalid encrypted-watch run resolution.");
  }
  const keys = Object.keys(resolution).sort();
  if (resolution.outcome === "failed") {
    if (keys.length !== 1 || keys[0] !== "outcome") {
      throw new EncryptedWatchValidationError("Invalid failed encrypted-watch resolution.");
    }
    return;
  }
  if (
    resolution.outcome !== "admitted" ||
    keys.join(",") !== "admittedAt,jobId,outcome,reportId" ||
    !isScanJobId(resolution.jobId) ||
    !isScanJobId(resolution.reportId) ||
    resolution.jobId === resolution.reportId ||
    !Number.isSafeInteger(resolution.admittedAt) ||
    resolution.admittedAt < 0
  ) {
    throw new EncryptedWatchValidationError("Invalid admitted encrypted-watch resolution.");
  }
}

function assertTerminalResolution(resolution: EncryptedWatchRunTerminalResolution): void {
  if (!resolution || typeof resolution !== "object" || Array.isArray(resolution)) {
    throw new EncryptedWatchValidationError("Invalid encrypted-watch terminal resolution.");
  }
  const keys = Object.keys(resolution).sort().join(",");
  if (resolution.outcome === "succeeded") {
    if (keys !== "outcome") throw new EncryptedWatchValidationError("Invalid successful encrypted-watch terminal resolution.");
    return;
  }
  if (
    (resolution.outcome !== "failed" && resolution.outcome !== "expired" && resolution.outcome !== "cancelled") ||
    keys !== "errorCode,outcome" ||
    typeof resolution.errorCode !== "string" ||
    !ERROR_CODE_PATTERN.test(resolution.errorCode)
  ) {
    throw new EncryptedWatchValidationError("Invalid failed encrypted-watch terminal resolution.");
  }
}

function assertRunLink(link: EncryptedWatchRunLink, latestAllowedAt: number): void {
  if (!link || typeof link !== "object" || Array.isArray(link)) {
    throw new EncryptedWatchValidationError("Invalid encrypted-watch initial run link.");
  }
  if (
    Object.keys(link).sort().join(",") !== "admittedAt,jobId,reportId" ||
    !isScanJobId(link.jobId) ||
    !isScanJobId(link.reportId) ||
    link.jobId === link.reportId ||
    !Number.isSafeInteger(link.admittedAt) ||
    link.admittedAt < 0 ||
    link.admittedAt > latestAllowedAt
  ) {
    throw new EncryptedWatchValidationError("Invalid encrypted-watch initial run link.");
  }
}

function canonicalPayload(value: unknown): EncryptedWatchPayload {
  if (!isEncryptedWatchPayload(value)) throw new EncryptedWatchValidationError("Invalid encrypted-watch payload.");
  return Object.freeze({
    version: 1,
    target: Object.freeze({ url: value.target.url }),
    options: Object.freeze({
      device: value.options.device,
      gpcEnabled: value.options.gpcEnabled,
      reportMode: "r2",
      comparison: "none"
    })
  });
}

async function importEncryptedWatchKey(encoded: string, label: string): Promise<EncryptedWatchKey> {
  if (typeof encoded !== "string" || encoded.length !== KEY_BASE64URL_LENGTH || !BASE64URL_PATTERN.test(encoded)) {
    throw new EncryptedWatchValidationError(
      `${label} must be canonical unpadded base64url for exactly 32 bytes.`
    );
  }
  const bytes = decodeCanonicalBase64Url(encoded, KEY_BASE64URL_LENGTH, KEY_BYTES, "encrypted-watch key");
  try {
    const [cryptoKey, keyDigest, optionsBindingKey] = await Promise.all([
      crypto.subtle.importKey("raw", copyArrayBuffer(bytes), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]),
      sha256(bytes),
      deriveOptionsBindingKey(bytes)
    ]);
    return Object.freeze({ keyId: `sha256:${hex(new Uint8Array(keyDigest))}`, cryptoKey, optionsBindingKey });
  } catch {
    throw new EncryptedWatchCryptoError("The encrypted-watch key could not be imported.");
  }
}

async function deriveOptionsBindingKey(bytes: Uint8Array): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", copyArrayBuffer(bytes), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(SHA256_BYTES),
      info: new TextEncoder().encode("site-behavior-lab/encrypted-watch/options-binding/v1")
    },
    material,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign"]
  );
}

async function bindOptions(key: EncryptedWatchKey, payload: EncryptedWatchPayload): Promise<ArrayBuffer> {
  const encoded = new TextEncoder().encode(JSON.stringify([
    payload.options.device,
    payload.options.gpcEnabled,
    payload.options.reportMode,
    payload.options.comparison
  ]));
  return crypto.subtle.sign("HMAC", key.optionsBindingKey, encoded);
}

function encryptedWatchAdditionalData(input: Readonly<{
  watchId: string;
  keyId: string;
  createdAt: number;
  expiresAt: number;
  optionsBinding: ArrayBuffer;
}>): ArrayBuffer {
  assertWatchId(input.watchId);
  if (!KEY_ID_PATTERN.test(input.keyId)) throw new EncryptedWatchValidationError("Invalid encrypted-watch AAD key ID.");
  assertTimestamp(input.createdAt, "AAD creation timestamp");
  if (input.expiresAt !== input.createdAt + ENCRYPTED_WATCH_TTL_MS) {
    throw new EncryptedWatchValidationError("Invalid encrypted-watch AAD expiry.");
  }
  assertDigest(input.optionsBinding, "AAD options binding");
  return copyArrayBuffer(new TextEncoder().encode(JSON.stringify([
    "site-behavior-lab/encrypted-watch",
    ENCRYPTED_WATCH_ENVELOPE_VERSION,
    input.keyId,
    input.watchId,
    input.createdAt,
    input.expiresAt,
    ENCRYPTED_WATCH_CADENCE_MS,
    ENCRYPTED_WATCH_MAX_RUNS,
    hex(new Uint8Array(input.optionsBinding))
  ])));
}

function keyForEnvelope(keyring: EncryptedWatchKeyring, keyId: string): EncryptedWatchKey {
  if (keyring.current.keyId === keyId) return keyring.current;
  if (keyring.previous?.keyId === keyId) return keyring.previous;
  throw new EncryptedWatchCryptoError("The encrypted-watch payload uses an unavailable key.");
}

function assertKeyring(keyring: EncryptedWatchKeyring): void {
  if (
    !keyring ||
    !keyring.current ||
    !KEY_ID_PATTERN.test(keyring.current.keyId) ||
    !keyring.current.cryptoKey ||
    !keyring.current.optionsBindingKey ||
    (keyring.previous !== null &&
      (!KEY_ID_PATTERN.test(keyring.previous.keyId) ||
        keyring.previous.keyId === keyring.current.keyId ||
        !keyring.previous.cryptoKey ||
        !keyring.previous.optionsBindingKey))
  ) {
    throw new EncryptedWatchValidationError("Invalid encrypted-watch keyring.");
  }
}

function rowState(row: EncryptedWatchRow): EncryptedWatchState {
  if (row.state !== "active" && row.state !== "leased" && row.state !== "completed") {
    throw new EncryptedWatchStateError("conflict", "The encrypted watch has an invalid state.");
  }
  return row.state;
}

function nullableOutcome(value: SqlValue | undefined): "admitted" | "failed" | null {
  if (value === null) return null;
  if (value !== "admitted" && value !== "failed") {
    throw new EncryptedWatchStateError("conflict", "The encrypted watch has an invalid outcome.");
  }
  return value;
}

function nullableJobId(value: SqlValue | undefined, label: string): string | null {
  if (value === null) return null;
  if (!isScanJobId(value)) throw new EncryptedWatchStateError("conflict", `Invalid encrypted-watch ${label}.`);
  return value;
}

function assertWatchId(value: unknown): asserts value is string {
  if (!isEncryptedWatchId(value)) throw new EncryptedWatchValidationError("Invalid encrypted-watch ID.");
}

function assertGeneration(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new EncryptedWatchValidationError("Invalid encrypted-watch lease generation.");
}

function assertTimestamp(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new EncryptedWatchValidationError(`Invalid encrypted-watch ${label}.`);
}

function safeTimestampAdd(value: number, delta: number, label: string): number {
  const result = value + delta;
  assertTimestamp(result, label);
  return result;
}

function assertDigest(value: unknown, label: string): asserts value is ArrayBuffer {
  if (!(value instanceof ArrayBuffer) || value.byteLength !== SHA256_BYTES) {
    throw new EncryptedWatchValidationError(`Invalid encrypted-watch ${label}.`);
  }
}

function exactPolicyInteger<T extends number>(value: SqlValue | undefined, expected: T, label: string): T {
  if (value !== expected) throw new EncryptedWatchStateError("conflict", `Invalid encrypted-watch ${label}.`);
  return expected;
}

function integer(value: SqlValue | undefined, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new EncryptedWatchStateError("conflict", `Invalid encrypted-watch ${label}.`);
  }
  return value;
}

function nullableInteger(value: SqlValue | undefined, label: string): number | null {
  return value === null ? null : integer(value, label);
}

function text(value: SqlValue | undefined, label: string): string {
  if (typeof value !== "string") throw new EncryptedWatchStateError("conflict", `Invalid encrypted-watch ${label}.`);
  return value;
}

function requireBlob(value: unknown, label: string): ArrayBuffer {
  if (!(value instanceof ArrayBuffer)) {
    throw new EncryptedWatchStateError("conflict", `Invalid encrypted-watch ${label}.`);
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

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeCanonicalBase64Url(
  value: string,
  expectedLength: number,
  expectedBytes: number,
  label: string
): Uint8Array {
  if (
    typeof value !== "string" ||
    value.length !== expectedLength ||
    !BASE64URL_PATTERN.test(value) ||
    value.length % 4 === 1
  ) {
    throw new EncryptedWatchValidationError(`Invalid ${label}.`);
  }
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    if (bytes.byteLength !== expectedBytes || encodeBase64Url(bytes) !== value) throw new Error("non-canonical");
    return bytes;
  } catch {
    throw new EncryptedWatchValidationError(`Invalid ${label}.`);
  }
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function equalBytes(left: ArrayBuffer, right: ArrayBuffer): boolean {
  const leftBytes = new Uint8Array(left);
  const rightBytes = new Uint8Array(right);
  if (leftBytes.byteLength !== rightBytes.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < leftBytes.byteLength; index += 1) difference |= leftBytes[index] ^ rightBytes[index];
  return difference === 0;
}

function copyArrayBuffer(value: ArrayBuffer | Uint8Array): ArrayBuffer {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  return Uint8Array.from(bytes).buffer;
}
