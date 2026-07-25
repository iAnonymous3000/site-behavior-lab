import {
  DURABLE_SCAN_JOB_COORDINATOR_URL_ENV,
  DURABLE_SCAN_JOB_ENCRYPTION_KEY_ENV,
  DURABLE_SCAN_JOB_INTERNAL_TOKEN_ENV,
  DURABLE_SCAN_JOBS_ENV,
  isScanJobId
} from "./durable-scan-job-contract";
import {
  DURABLE_SCAN_JOB_LEASE_MS,
  DURABLE_SCAN_JOB_PURGE_MS,
  ensureDurableScanJobStore,
  type DurableScanJobStoreSql
} from "./durable-scan-job-store";

export const DURABLE_REPLAY_DEPLOYMENT_ENVIRONMENT_ENV =
  "SITE_BEHAVIOR_LAB_DEPLOYMENT_ENVIRONMENT";
const DURABLE_REPLAY_FAULTS_ENV = "SITE_BEHAVIOR_LAB_DURABLE_REPLAY_FAULTS";
export const DURABLE_REPLAY_FAULT_TOKEN_ENV =
  "SITE_BEHAVIOR_LAB_DURABLE_REPLAY_FAULT_TOKEN";
export const DURABLE_REPLAY_R2_BUCKET_ENV = "SITE_BEHAVIOR_LAB_R2_BUCKET";

export const DURABLE_REPLAY_FAULT_MODE_HEADER = "x-staging-fault-mode";
export const DURABLE_REPLAY_FAULT_TOKEN_HEADER = "x-staging-fault-token";
export const DURABLE_REPLAY_MINIMUM_NO_POLL_MS = DURABLE_SCAN_JOB_LEASE_MS + 60_000;
export const DURABLE_REPLAY_FAULT_MODES = ["lease-expiry", "lost-resolve"] as const;

export type DurableReplayFaultMode = (typeof DURABLE_REPLAY_FAULT_MODES)[number];

export type DurableReplayFaultEnvironment = Readonly<{
  SITE_BEHAVIOR_LAB_DEPLOYMENT_ENVIRONMENT?: string;
  SITE_BEHAVIOR_LAB_DURABLE_REPLAY_FAULTS?: string;
  SITE_BEHAVIOR_LAB_DURABLE_REPLAY_FAULT_TOKEN?: string;
  SITE_BEHAVIOR_LAB_DURABLE_JOBS?: string;
  SITE_BEHAVIOR_LAB_DURABLE_JOBS_KEY?: string;
  SITE_BEHAVIOR_LAB_DURABLE_JOBS_INTERNAL_TOKEN?: string;
  SITE_BEHAVIOR_LAB_DURABLE_JOBS_COORDINATOR_URL?: string;
  SITE_BEHAVIOR_LAB_ALLOW_UNAUTHENTICATED_SCANS?: string;
  SITE_BEHAVIOR_LAB_SYNTHETIC_MONITOR_TOKEN?: string;
  SITE_BEHAVIOR_LAB_SCAN_ACCESS_TOKEN?: string;
  TURNSTILE_SECRET_KEY?: string;
  SITE_BEHAVIOR_LAB_R2_BUCKET?: string;
  SITE_BEHAVIOR_LAB_R2_ACCESS_KEY_ID?: string;
  SITE_BEHAVIOR_LAB_R2_SECRET_ACCESS_KEY?: string;
}>;

export type DurableReplayFaultConfig = Readonly<{
  status: "disabled" | "ready" | "misconfigured";
  coordinatorOrigin: string | null;
  reasons: readonly string[];
}>;

export type DurableReplayFault = Readonly<{
  jobId: string;
  mode: DurableReplayFaultMode;
  armedAt: number;
  expiresAt: number;
  triggeredAt: number | null;
  triggeredGeneration: 1 | null;
}>;

export type DurableReplayLostResolveDrop = Readonly<{
  fault: DurableReplayFault;
  firstTrigger: boolean;
}>;

type SqlValue = ArrayBuffer | string | number | null;
type DurableReplayFaultRow = Record<string, SqlValue> & {
  job_id: string;
  mode: string;
  armed_at: number;
  expires_at: number;
  triggered_at: number | null;
  triggered_generation: number | null;
};

const PRODUCTION_COORDINATOR_HOSTNAME = "scan.sitebehavior.org";
const PRODUCTION_R2_BUCKET = "site-behavior-lab-reports";
const R2_BUCKET_PATTERN = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const MAX_SECRET_LENGTH = 4_096;

/**
 * Fault injection is positively enabled only by a complete, isolated staging
 * configuration. Production and disabled deployments never get a permissive
 * fallback from a partially configured value.
 */
export function durableReplayFaultConfig(
  env: DurableReplayFaultEnvironment
): DurableReplayFaultConfig {
  const coordinatorOrigin = readCoordinatorOrigin(
    env[DURABLE_SCAN_JOB_COORDINATOR_URL_ENV]
  );
  const enabled = env[DURABLE_REPLAY_FAULTS_ENV];
  if (enabled === undefined || enabled === "" || enabled === "0") {
    return frozenConfig("disabled", coordinatorOrigin, []);
  }

  const reasons: string[] = [];
  if (enabled !== "1") {
    reasons.push(`${DURABLE_REPLAY_FAULTS_ENV} must be exactly 0 or 1.`);
  }
  if (env[DURABLE_REPLAY_DEPLOYMENT_ENVIRONMENT_ENV] !== "staging") {
    reasons.push(
      `${DURABLE_REPLAY_DEPLOYMENT_ENVIRONMENT_ENV} must be exactly staging.`
    );
  }
  if (env[DURABLE_SCAN_JOBS_ENV] !== "1") {
    reasons.push(`${DURABLE_SCAN_JOBS_ENV} must be exactly 1.`);
  }

  const accessToken = safeSecret(env.SITE_BEHAVIOR_LAB_SCAN_ACCESS_TOKEN);
  if (env.SITE_BEHAVIOR_LAB_ALLOW_UNAUTHENTICATED_SCANS !== "0") {
    reasons.push(
      "SITE_BEHAVIOR_LAB_ALLOW_UNAUTHENTICATED_SCANS must be exactly 0 for the gated staging hook."
    );
  }
  if (!accessToken || accessToken.length < 32) {
    reasons.push(
      "SITE_BEHAVIOR_LAB_SCAN_ACCESS_TOKEN must contain a staging-only token of at least 32 characters."
    );
  }

  if (!coordinatorOrigin) {
    reasons.push(
      `${DURABLE_SCAN_JOB_COORDINATOR_URL_ENV} must be an HTTPS origin without credentials, path, query, or fragment.`
    );
  } else if (normalizedHostname(coordinatorOrigin) === PRODUCTION_COORDINATOR_HOSTNAME) {
    reasons.push(
      `${DURABLE_SCAN_JOB_COORDINATOR_URL_ENV} must not use the production scanner origin.`
    );
  }

  const bucket = env[DURABLE_REPLAY_R2_BUCKET_ENV] ?? "";
  if (!R2_BUCKET_PATTERN.test(bucket) || bucket === PRODUCTION_R2_BUCKET) {
    reasons.push(
      `${DURABLE_REPLAY_R2_BUCKET_ENV} must name a valid, dedicated non-production R2 bucket.`
    );
  }

  const faultToken = safeSecret(env[DURABLE_REPLAY_FAULT_TOKEN_ENV]);
  if (!faultToken || faultToken.length < 32) {
    reasons.push(
      `${DURABLE_REPLAY_FAULT_TOKEN_ENV} must contain a staging-only token of at least 32 characters.`
    );
  } else {
    const otherSecrets = [
      env[DURABLE_SCAN_JOB_ENCRYPTION_KEY_ENV],
      env[DURABLE_SCAN_JOB_INTERNAL_TOKEN_ENV],
      env.SITE_BEHAVIOR_LAB_SYNTHETIC_MONITOR_TOKEN,
      env.SITE_BEHAVIOR_LAB_SCAN_ACCESS_TOKEN,
      env.TURNSTILE_SECRET_KEY,
      env.SITE_BEHAVIOR_LAB_R2_ACCESS_KEY_ID,
      env.SITE_BEHAVIOR_LAB_R2_SECRET_ACCESS_KEY
    ]
      // The corresponding consumers trim these bindings before use. Compare
      // their effective values so whitespace cannot hide secret reuse from the
      // staging-isolation gate.
      .map(normalizedConsumerSecret)
      .filter((value): value is string => value !== null);
    if (otherSecrets.includes(faultToken)) {
      reasons.push(
        `${DURABLE_REPLAY_FAULT_TOKEN_ENV} must not reuse any durable-job, synthetic-monitor, access-gate, Turnstile, or R2 secret.`
      );
    }
  }

  return frozenConfig(
    reasons.length === 0 ? "ready" : "misconfigured",
    coordinatorOrigin,
    reasons
  );
}

/**
 * Whether this deployment declares staging/fault intent and must therefore
 * gate every public route before any Durable Object or container access. This
 * deliberately remains true for incomplete configurations so malformed or
 * missing secrets cannot turn the temporary staging origin public.
 */
export function durableReplayFaultIngressIntent(
  env: DurableReplayFaultEnvironment
): boolean {
  const enabled = env[DURABLE_REPLAY_FAULTS_ENV];
  return (
    env[DURABLE_REPLAY_DEPLOYMENT_ENVIRONMENT_ENV] === "staging" ||
    (enabled !== undefined && enabled !== "" && enabled !== "0")
  );
}

/** Caller must invoke this operation inside the same transaction as admission. */
export function armDurableReplayFault(
  sql: DurableScanJobStoreSql,
  input: Readonly<{ jobId: string; mode: DurableReplayFaultMode; now: number }>
): DurableReplayFault {
  ensureDurableScanJobStore(sql);
  ensureDurableReplayFaultStore(sql);
  assertJobId(input.jobId);
  assertMode(input.mode);
  assertTimestamp(input.now, "fault-arm timestamp");
  purgeDurableReplayFaults(sql, input.now);

  sql.exec(
    `INSERT OR IGNORE INTO durable_replay_faults (
       job_id, mode, armed_at, expires_at, triggered_at, triggered_generation
     )
     SELECT job_id, ?, ?, purge_at, NULL, NULL
     FROM durable_scan_jobs
     WHERE job_id = ? AND state = 'queued' AND lease_generation = 0
       AND created_at <= ? AND purge_at > ? AND purge_at <= ?`,
    input.mode,
    input.now,
    input.jobId,
    input.now,
    input.now,
    safeTimestampAdd(input.now, DURABLE_SCAN_JOB_PURGE_MS)
  );

  const fault = selectDurableReplayFault(sql, input.jobId);
  if (!fault || fault.mode !== input.mode || fault.triggeredAt !== null) {
    throw new Error("The durable replay fault could not be armed for this queued job.");
  }
  return fault;
}

export function findDurableReplayFault(
  sql: DurableScanJobStoreSql,
  jobId: string,
  now: number = Date.now()
): DurableReplayFault | null {
  ensureDurableReplayFaultStore(sql);
  if (!isScanJobId(jobId)) return null;
  assertTimestamp(now, "fault-read timestamp");
  purgeDurableReplayFaults(sql, now);
  return selectDurableReplayFault(sql, jobId);
}

/**
 * Consume the lease-expiry one-shot only for the first live leased generation.
 * Caller must invoke this synchronous operation inside transactionSync.
 */
export function triggerLeaseExpiryDurableReplayFault(
  sql: DurableScanJobStoreSql,
  input: Readonly<{ jobId: string; generation: number; tokenHash: ArrayBuffer; now: number }>
): DurableReplayFault | null {
  return triggerDurableReplayFault(sql, input, "lease-expiry", "leased");
}

/**
 * Drop every successful resolve from the exact first-generation owner after it
 * enters publishing. The first call records the trigger receipt; later retries
 * from that same fenced owner are also dropped so a duplicate callback cannot
 * bypass the canary and terminalize the row before scheduled reconciliation.
 */
export function dropLostResolveDurableReplayFault(
  sql: DurableScanJobStoreSql,
  input: Readonly<{ jobId: string; generation: number; tokenHash: ArrayBuffer; now: number }>
): DurableReplayLostResolveDrop | null {
  ensureDurableScanJobStore(sql);
  ensureDurableReplayFaultStore(sql);
  assertJobId(input.jobId);
  assertTokenHash(input.tokenHash);
  assertTimestamp(input.now, "fault-trigger timestamp");
  if (input.generation !== 1) return null;
  purgeDurableReplayFaults(sql, input.now);

  const armed = selectDurableReplayFault(sql, input.jobId);
  if (!armed || armed.mode !== "lost-resolve" || armed.expiresAt <= input.now) return null;

  const owner = sql
    .exec<Record<string, SqlValue> & { lease_expires_at: number }>(
      `SELECT lease_expires_at
       FROM durable_scan_jobs
       WHERE job_id = ? AND state = 'publishing' AND lease_generation = 1
         AND lease_token_hash = ? AND deadline_at > ? AND purge_at > ?
       LIMIT 1`,
      input.jobId,
      input.tokenHash,
      input.now,
      input.now
    )
    .toArray()[0];
  if (!owner) return null;

  if (armed.triggeredAt !== null) {
    return armed.triggeredGeneration === 1
      ? Object.freeze({ fault: armed, firstTrigger: false })
      : null;
  }
  if (integer(owner.lease_expires_at, "fault owner lease expiry") <= input.now) return null;

  const triggered = triggerDurableReplayFault(sql, input, "lost-resolve", "publishing");
  return triggered ? Object.freeze({ fault: triggered, firstTrigger: true }) : null;
}

export function purgeDurableReplayFaults(
  sql: DurableScanJobStoreSql,
  now: number
): number {
  ensureDurableScanJobStore(sql);
  ensureDurableReplayFaultStore(sql);
  assertTimestamp(now, "fault-purge timestamp");
  const stalePredicate = `expires_at <= ? OR NOT EXISTS (
    SELECT 1 FROM durable_scan_jobs
    WHERE durable_scan_jobs.job_id = durable_replay_faults.job_id
  )`;
  const count = integer(
    sql
      .exec<Record<string, SqlValue> & { count: number }>(
        `SELECT COUNT(*) AS count FROM durable_replay_faults WHERE ${stalePredicate}`,
        now
      )
      .toArray()[0]?.count ?? 0,
    "fault purge count"
  );
  sql.exec(`DELETE FROM durable_replay_faults WHERE ${stalePredicate}`, now);
  return count;
}

function triggerDurableReplayFault(
  sql: DurableScanJobStoreSql,
  input: Readonly<{ jobId: string; generation: number; tokenHash: ArrayBuffer; now: number }>,
  mode: DurableReplayFaultMode,
  durableState: "leased" | "publishing"
): DurableReplayFault | null {
  ensureDurableScanJobStore(sql);
  ensureDurableReplayFaultStore(sql);
  assertJobId(input.jobId);
  assertTokenHash(input.tokenHash);
  assertTimestamp(input.now, "fault-trigger timestamp");
  if (input.generation !== 1) return null;
  purgeDurableReplayFaults(sql, input.now);
  const armed = selectDurableReplayFault(sql, input.jobId);
  if (!armed || armed.mode !== mode || armed.triggeredAt !== null) return null;

  sql.exec(
    `UPDATE durable_replay_faults
     SET triggered_at = ?, triggered_generation = 1
     WHERE job_id = ? AND mode = ? AND triggered_at IS NULL AND expires_at > ?
       AND EXISTS (
         SELECT 1 FROM durable_scan_jobs
         WHERE durable_scan_jobs.job_id = durable_replay_faults.job_id
           AND durable_scan_jobs.state = ?
           AND durable_scan_jobs.lease_generation = 1
           AND durable_scan_jobs.lease_token_hash = ?
           AND durable_scan_jobs.lease_expires_at > ?
           AND durable_scan_jobs.deadline_at > ?
       )`,
    input.now,
    input.jobId,
    mode,
    input.now,
    durableState,
    input.tokenHash,
    input.now,
    input.now
  );

  const fault = selectDurableReplayFault(sql, input.jobId);
  return fault?.mode === mode &&
    fault.triggeredAt === input.now &&
    fault.triggeredGeneration === 1
    ? fault
    : null;
}

function ensureDurableReplayFaultStore(sql: DurableScanJobStoreSql): void {
  sql.exec(
    `CREATE TABLE IF NOT EXISTS durable_replay_faults (
       job_id TEXT PRIMARY KEY,
       mode TEXT NOT NULL CHECK(mode IN ('lease-expiry','lost-resolve')),
       armed_at INTEGER NOT NULL CHECK(armed_at >= 0),
       expires_at INTEGER NOT NULL CHECK(
         expires_at > armed_at AND expires_at <= armed_at + ${DURABLE_SCAN_JOB_PURGE_MS}
       ),
       triggered_at INTEGER,
       triggered_generation INTEGER,
       CHECK(
         (triggered_at IS NULL AND triggered_generation IS NULL)
         OR (
           triggered_at IS NOT NULL AND triggered_at >= armed_at
           AND triggered_at < expires_at AND triggered_generation = 1
         )
       )
     )`
  );
  sql.exec(
    "CREATE INDEX IF NOT EXISTS durable_replay_faults_expiry ON durable_replay_faults(expires_at, job_id)"
  );
}

function selectDurableReplayFault(
  sql: DurableScanJobStoreSql,
  jobId: string
): DurableReplayFault | null {
  const row = sql
    .exec<DurableReplayFaultRow>(
      "SELECT * FROM durable_replay_faults WHERE job_id = ? LIMIT 1",
      jobId
    )
    .toArray()[0];
  if (!row) return null;
  const mode = row.mode;
  assertMode(mode);
  const generation = nullableInteger(row.triggered_generation, "fault generation");
  if (generation !== null && generation !== 1) {
    throw new Error("The durable replay fault has an invalid generation.");
  }
  return Object.freeze({
    jobId: row.job_id,
    mode,
    armedAt: integer(row.armed_at, "fault armed timestamp"),
    expiresAt: integer(row.expires_at, "fault expiry timestamp"),
    triggeredAt: nullableInteger(row.triggered_at, "fault trigger timestamp"),
    triggeredGeneration: generation
  });
}

function readCoordinatorOrigin(value: string | undefined): string | null {
  if (!value || value !== value.trim()) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

function normalizedHostname(origin: string): string {
  return new URL(origin).hostname.toLowerCase().replace(/\.+$/, "");
}

function safeSecret(value: string | undefined): string | null {
  if (
    !value ||
    value !== value.trim() ||
    value.length > MAX_SECRET_LENGTH ||
    /[\r\n]/.test(value)
  ) {
    return null;
  }
  return value;
}

function normalizedConsumerSecret(value: string | undefined): string | null {
  const normalized = value?.trim() ?? "";
  if (!normalized || normalized.length > MAX_SECRET_LENGTH || /[\r\n]/.test(normalized)) {
    return null;
  }
  return normalized;
}

function frozenConfig(
  status: DurableReplayFaultConfig["status"],
  coordinatorOrigin: string | null,
  reasons: readonly string[]
): DurableReplayFaultConfig {
  return Object.freeze({
    status,
    coordinatorOrigin,
    reasons: Object.freeze([...reasons])
  });
}

function assertJobId(jobId: string): void {
  if (!isScanJobId(jobId)) throw new Error("Invalid durable replay fault job ID.");
}

function assertMode(mode: unknown): asserts mode is DurableReplayFaultMode {
  if (mode !== "lease-expiry" && mode !== "lost-resolve") {
    throw new Error("Invalid durable replay fault mode.");
  }
}

function assertTimestamp(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid ${label}.`);
  }
}

function assertTokenHash(value: ArrayBuffer): void {
  if (!(value instanceof ArrayBuffer) || value.byteLength !== 32) {
    throw new Error("Invalid durable replay fault lease-token hash.");
  }
}

function safeTimestampAdd(value: number, delta: number): number {
  const result = value + delta;
  assertTimestamp(result, "fault expiry timestamp");
  return result;
}

function integer(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid ${label}.`);
  }
  return value;
}

function nullableInteger(value: number | null, label: string): number | null {
  return value === null ? null : integer(value, label);
}
