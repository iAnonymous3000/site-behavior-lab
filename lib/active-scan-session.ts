import { REPORT_ID_PATTERN } from "./report-validation";

export const ACTIVE_SCAN_SESSION_STORAGE_KEY = "site-behavior-lab.active-scan.v1";
export const ACTIVE_SCAN_SESSION_MAX_AGE_MS = 75 * 60 * 1000;

type SessionStorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type RecoverableScanJob = {
  jobId: string;
  statusPath: string;
  reportId: string;
};

/** Authentication is intentionally memory-only and never part of recovery storage. */
export type ActiveScanJob = RecoverableScanJob & { accessKey: string };

export type ActiveScanSession = {
  job: RecoverableScanJob;
  acceptedAt: number;
  expiresAt: number;
};

/**
 * Persist only the accepted job/report capability linkage, scoped to this tab.
 * Target URLs, form choices, deployment access keys, Turnstile tokens, reports,
 * and evidence never enter browser storage through this recovery path.
 */
export function persistActiveScanSession(
  storage: SessionStorageLike,
  job: ActiveScanJob,
  now = Date.now()
): ActiveScanSession {
  const session = {
    job: copyRecoverableScanJob(job),
    acceptedAt: now,
    expiresAt: now + ACTIVE_SCAN_SESSION_MAX_AGE_MS
  } satisfies ActiveScanSession;

  try {
    storage.setItem(
      ACTIVE_SCAN_SESSION_STORAGE_KEY,
      JSON.stringify({ version: 1, ...session })
    );
  } catch {
    // The in-memory lifecycle still works when storage is unavailable. Never
    // weaken browser privacy settings or turn a storage failure into a resubmit.
  }
  return session;
}

/** Read, strictly validate, and consume no more authority than this tab owns. */
export function restoreActiveScanSession(
  storage: SessionStorageLike,
  now = Date.now()
): ActiveScanSession | null {
  let raw: string | null = null;
  try {
    raw = storage.getItem(ACTIVE_SCAN_SESSION_STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    clearActiveScanSession(storage);
    return null;
  }

  if (!isStoredActiveScanSession(parsed, now)) {
    clearActiveScanSession(storage);
    return null;
  }
  return {
    job: copyRecoverableScanJob(parsed.job),
    acceptedAt: parsed.acceptedAt,
    expiresAt: parsed.expiresAt
  };
}

export function clearActiveScanSession(storage: Pick<Storage, "removeItem">): void {
  try {
    storage.removeItem(ACTIVE_SCAN_SESSION_STORAGE_KEY);
  } catch {
    /* sessionStorage unavailable */
  }
}

export function isRecoverableScanJob(value: unknown): value is RecoverableScanJob {
  if (!isPlainRecord(value) || !hasExactKeys(value, ["jobId", "reportId", "statusPath"])) {
    return false;
  }
  return (
    typeof value.jobId === "string" &&
    REPORT_ID_PATTERN.test(value.jobId) &&
    value.statusPath === `/api/scans/${value.jobId}` &&
    typeof value.reportId === "string" &&
    REPORT_ID_PATTERN.test(value.reportId) &&
    value.reportId !== value.jobId
  );
}

function isStoredActiveScanSession(
  value: unknown,
  now: number
): value is ActiveScanSession & { version: 1 } {
  if (!isPlainRecord(value) || !hasExactKeys(value, ["acceptedAt", "expiresAt", "job", "version"])) {
    return false;
  }
  if (
    value.version !== 1 ||
    !Number.isSafeInteger(value.acceptedAt) ||
    !Number.isSafeInteger(value.expiresAt) ||
    typeof value.acceptedAt !== "number" ||
    typeof value.expiresAt !== "number" ||
    value.expiresAt !== value.acceptedAt + ACTIVE_SCAN_SESSION_MAX_AGE_MS ||
    value.acceptedAt > now ||
    value.expiresAt <= now
  ) {
    return false;
  }
  return isRecoverableScanJob(value.job);
}

function copyRecoverableScanJob(job: RecoverableScanJob): RecoverableScanJob {
  return {
    jobId: job.jobId,
    statusPath: job.statusPath,
    reportId: job.reportId
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}
