const JOB_ID_PATTERN = /^[0-9]{8}-[0-9a-f]{32}$/;

export const DURABLE_SCAN_JOB_REGISTRY_TTL_MS = 75 * 60 * 1_000;
export const DURABLE_SCAN_JOB_REGISTRY_MAX_ROWS = 500;

type SqlValue = ArrayBuffer | string | number | null;

/** The small subset shared by Cloudflare's DO SQLite API and the test adapter. */
export interface DurableScanJobSql {
  exec<T extends Record<string, SqlValue>>(
    query: string,
    ...bindings: SqlValue[]
  ): { toArray(): T[] };
}

export type DurableScanJobRegistration = {
  jobId: string;
  reportId: string;
  totalRuns: 1 | 2;
  createdAt: number;
};

/**
 * Persist only the two capabilities and bounded scheduling metadata. Target
 * URLs and client identifiers deliberately never cross this phase-1 boundary.
 */
export function registerDurableScanJob(
  sql: DurableScanJobSql,
  registration: DurableScanJobRegistration
): void {
  assertRegistration(registration);
  ensureRegistryTable(sql);

  const cutoff = registration.createdAt - DURABLE_SCAN_JOB_REGISTRY_TTL_MS;
  sql.exec("DELETE FROM scan_job_registry WHERE created_at <= ?", cutoff);
  sql.exec(
    "INSERT INTO scan_job_registry (job_id, report_id, total_runs, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(job_id) DO NOTHING",
    registration.jobId,
    registration.reportId,
    registration.totalRuns,
    registration.createdAt
  );
  // Keep the newest bounded set. job_id is a deterministic tie-breaker for the
  // extremely common case where multiple admissions share the same millisecond.
  sql.exec(
    "DELETE FROM scan_job_registry WHERE job_id IN (SELECT job_id FROM scan_job_registry ORDER BY created_at DESC, job_id DESC LIMIT -1 OFFSET ?)",
    DURABLE_SCAN_JOB_REGISTRY_MAX_ROWS
  );
}

export function findDurableScanJob(
  sql: DurableScanJobSql,
  jobId: string,
  now = Date.now()
): DurableScanJobRegistration | null {
  if (!JOB_ID_PATTERN.test(jobId)) return null;
  assertTimestamp(now);
  ensureRegistryTable(sql);

  const row = sql
    .exec<{ report_id: string; total_runs: number; created_at: number }>(
      "SELECT report_id, total_runs, created_at FROM scan_job_registry WHERE job_id = ? AND created_at > ?",
      jobId,
      now - DURABLE_SCAN_JOB_REGISTRY_TTL_MS
    )
    .toArray()[0];

  if (!row || !JOB_ID_PATTERN.test(row.report_id) || (row.total_runs !== 1 && row.total_runs !== 2)) {
    return null;
  }
  return {
    jobId,
    reportId: row.report_id,
    totalRuns: row.total_runs,
    createdAt: row.created_at
  };
}

export async function durableRegistrationFromAcceptedResponse(
  response: Response,
  scanBody: string,
  createdAt = Date.now()
): Promise<DurableScanJobRegistration | null> {
  if (response.status !== 202) return null;
  assertTimestamp(createdAt);

  let payload: unknown;
  try {
    payload = await response.clone().json();
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object") return null;

  const candidate = payload as Record<string, unknown>;
  if (
    candidate.ok !== true ||
    candidate.status !== "queued" ||
    typeof candidate.jobId !== "string" ||
    typeof candidate.reportId !== "string" ||
    candidate.statusPath !== `/api/scans/${candidate.jobId}` ||
    !JOB_ID_PATTERN.test(candidate.jobId) ||
    !JOB_ID_PATTERN.test(candidate.reportId) ||
    candidate.jobId === candidate.reportId
  ) {
    return null;
  }

  return {
    jobId: candidate.jobId,
    reportId: candidate.reportId,
    totalRuns: totalRunsFromScanBody(scanBody),
    createdAt
  };
}

/** Best-effort edge write: an accepted container response always wins. */
export async function recordAcceptedScanJob(
  response: Response,
  scanBody: string,
  register: (registration: DurableScanJobRegistration) => void | Promise<void>,
  onError: (error: unknown) => void,
  createdAt = Date.now()
): Promise<boolean> {
  const registration = await durableRegistrationFromAcceptedResponse(response, scanBody, createdAt);
  if (!registration) {
    if (response.status === 202) onError(new Error("The container returned an invalid async scan submission."));
    return false;
  }

  try {
    await register(registration);
    return true;
  } catch (error) {
    onError(error);
    return false;
  }
}

export function scanJobIdFromPath(pathname: string): string | null {
  const match = /^\/api\/scans\/([^/]+)$/.exec(pathname);
  const id = match?.[1] ?? "";
  return JOB_ID_PATTERN.test(id) ? id : null;
}

function totalRunsFromScanBody(body: string): 1 | 2 {
  try {
    const payload = JSON.parse(body) as Record<string, unknown> | null;
    if (
      payload &&
      (payload.compareGpc === true || payload.compareShields === true || payload.compareConsent === true)
    ) {
      return 2;
    }
  } catch {
    // The container cannot return a 202 for malformed JSON, so this fallback is
    // defensive only and never changes admission behavior.
  }
  return 1;
}

function ensureRegistryTable(sql: DurableScanJobSql): void {
  sql.exec(
    "CREATE TABLE IF NOT EXISTS scan_job_registry (job_id TEXT PRIMARY KEY, report_id TEXT NOT NULL UNIQUE, total_runs INTEGER NOT NULL CHECK(total_runs IN (1, 2)), created_at INTEGER NOT NULL)"
  );
  sql.exec(
    "CREATE INDEX IF NOT EXISTS scan_job_registry_created_at ON scan_job_registry(created_at, job_id)"
  );
}

function assertRegistration(registration: DurableScanJobRegistration): void {
  if (
    !JOB_ID_PATTERN.test(registration.jobId) ||
    !JOB_ID_PATTERN.test(registration.reportId) ||
    registration.jobId === registration.reportId ||
    (registration.totalRuns !== 1 && registration.totalRuns !== 2)
  ) {
    throw new Error("Invalid durable scan-job registration.");
  }
  assertTimestamp(registration.createdAt);
}

function assertTimestamp(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Invalid durable scan-job timestamp.");
  }
}
