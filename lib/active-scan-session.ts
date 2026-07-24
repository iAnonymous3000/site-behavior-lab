import { REPORT_ID_PATTERN } from "./report-validation";
import {
  SCAN_ADMISSION_TTL_MS,
  isScanAdmissionCredential,
  type ScanAdmissionCredential
} from "./scan-admission-capability";
import { parseStrictJson } from "./strict-json";

export const ACTIVE_SCAN_SESSION_STORAGE_KEY = "site-behavior-lab.active-scan.v1";
export const PENDING_SCAN_ADMISSION_STORAGE_KEY =
  "site-behavior-lab.pending-scan-admission.v1";
export const ACTIVE_SCAN_SESSION_MAX_AGE_MS = SCAN_ADMISSION_TTL_MS;
/** Both canonical recovery records are under 512 bytes; leave bounded headroom for versioned metadata. */
export const ACTIVE_SCAN_SESSION_MAX_STORAGE_BYTES = 2_048;

type SessionStorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type RecoverableScanJob = {
  jobId: string;
  statusPath: string;
  reportId: string;
};

/** Deployment-wide authentication is memory-only and never part of recovery storage. */
export type ActiveScanJob = RecoverableScanJob & { accessKey: string };

export type ActiveScanSession = {
  job: RecoverableScanJob;
  acceptedAt: number;
  expiresAt: number;
};

export type PendingScanAdmissionSession = {
  credential: ScanAdmissionCredential;
  createdAt: number;
  expiresAt: number;
};

/**
 * Persist a freshly minted, request-bound capability before any POST bytes are
 * dispatched. This record contains no target, options, access key, Turnstile
 * token, report, or evidence and is scoped to the current browser tab.
 */
export function persistPendingScanAdmissionSession(
  storage: SessionStorageLike,
  credential: ScanAdmissionCredential,
  now = Date.now()
): PendingScanAdmissionSession {
  if (
    !isScanAdmissionCredential(credential) ||
    !isValidSessionTimestamp(now) ||
    now > Number.MAX_SAFE_INTEGER - SCAN_ADMISSION_TTL_MS
  ) {
    throw new Error("Invalid pending scan admission.");
  }
  const session = {
    credential: copyScanAdmissionCredential(credential),
    createdAt: now,
    expiresAt: now + SCAN_ADMISSION_TTL_MS
  } satisfies PendingScanAdmissionSession;

  const serialized = JSON.stringify({ version: 1, ...session });
  storage.setItem(PENDING_SCAN_ADMISSION_STORAGE_KEY, serialized);
  if (storage.getItem(PENDING_SCAN_ADMISSION_STORAGE_KEY) !== serialized) {
    clearPendingScanAdmissionSession(storage);
    // Durable POST bytes must never leave a tab unless crash/reload recovery
    // authority was written and read back exactly.
    throw new Error("The pending scan admission could not be retained in this tab.");
  }
  return session;
}

export function restorePendingScanAdmissionSession(
  storage: SessionStorageLike,
  now = Date.now()
): PendingScanAdmissionSession | null {
  let raw: string | null = null;
  try {
    raw = storage.getItem(PENDING_SCAN_ADMISSION_STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  if (raw.length > ACTIVE_SCAN_SESSION_MAX_STORAGE_BYTES) {
    clearPendingScanAdmissionSession(storage);
    return null;
  }

  let parsed: unknown;
  try {
    parsed = parseStrictJson(raw, ACTIVE_SCAN_SESSION_MAX_STORAGE_BYTES);
  } catch {
    clearPendingScanAdmissionSession(storage);
    return null;
  }
  if (!isStoredPendingScanAdmissionSession(parsed, now)) {
    clearPendingScanAdmissionSession(storage);
    return null;
  }
  return {
    credential: copyScanAdmissionCredential(parsed.credential),
    createdAt: parsed.createdAt,
    expiresAt: parsed.expiresAt
  };
}

export function clearPendingScanAdmissionSession(
  storage: Pick<Storage, "removeItem">
): void {
  try {
    storage.removeItem(PENDING_SCAN_ADMISSION_STORAGE_KEY);
  } catch {
    /* sessionStorage unavailable */
  }
}

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
  if (raw.length > ACTIVE_SCAN_SESSION_MAX_STORAGE_BYTES) {
    clearActiveScanSession(storage);
    return null;
  }

  let parsed: unknown;
  try {
    parsed = parseStrictJson(raw, ACTIVE_SCAN_SESSION_MAX_STORAGE_BYTES);
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

function isStoredPendingScanAdmissionSession(
  value: unknown,
  now: number
): value is PendingScanAdmissionSession & { version: 1 } {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, ["createdAt", "credential", "expiresAt", "version"])
  ) {
    return false;
  }
  return (
    value.version === 1 &&
    isValidSessionTimestamp(value.createdAt) &&
    isValidSessionTimestamp(value.expiresAt) &&
    value.expiresAt === value.createdAt + SCAN_ADMISSION_TTL_MS &&
    value.createdAt <= now &&
    value.expiresAt > now &&
    isScanAdmissionCredential(value.credential)
  );
}

function copyRecoverableScanJob(job: RecoverableScanJob): RecoverableScanJob {
  return {
    jobId: job.jobId,
    statusPath: job.statusPath,
    reportId: job.reportId
  };
}

function copyScanAdmissionCredential(
  credential: ScanAdmissionCredential
): ScanAdmissionCredential {
  return {
    capabilityToken: credential.capabilityToken,
    requestCommitment: credential.requestCommitment
  };
}

function isValidSessionTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}
