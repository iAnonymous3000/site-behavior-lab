import type { ScanDevice } from "./types";
import { parseStrictJson } from "./strict-json";

export const DURABLE_SCAN_JOBS_ENV = "SITE_BEHAVIOR_LAB_DURABLE_JOBS";
export const DURABLE_SCAN_JOB_ENCRYPTION_KEY_ENV = "SITE_BEHAVIOR_LAB_DURABLE_JOBS_KEY";
export const DURABLE_SCAN_JOB_INTERNAL_TOKEN_ENV = "SITE_BEHAVIOR_LAB_DURABLE_JOBS_INTERNAL_TOKEN";
export const DURABLE_SCAN_JOB_COORDINATOR_URL_ENV = "SITE_BEHAVIOR_LAB_DURABLE_JOBS_COORDINATOR_URL";

export const DURABLE_SCAN_JOB_INTERNAL_HEADER = "x-site-behavior-lab-durable-job-internal-token";
export const DURABLE_SCAN_JOB_PREPARED_HEADER = "x-site-behavior-lab-durable-job-prepared";
export const DURABLE_SCAN_JOB_NODE_PATH_PREFIX = "/api/internal/durable-scans";
export const DURABLE_SCAN_JOB_COORDINATOR_PATH_PREFIX = "/__site-behavior-lab/durable-scans";

// A publication is a point-of-no-return for one report capability. Node must
// settle or abort all local store work within this bound; the coordinator then
// waits the additional settlement interval before final reconciliation.
export const DURABLE_SCAN_JOB_PUBLICATION_TIMEOUT_MS = 60_000;
export const DURABLE_SCAN_JOB_PUBLICATION_SETTLEMENT_MS = 30_000;
export const DURABLE_SCAN_JOB_RECONCILIATION_TIMEOUT_MS = 30_000;

const JOB_ID_PATTERN = /^[0-9]{8}-[0-9a-f]{32}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const LEASE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_PREPARATION_HEADER_LENGTH = 16_384;

/**
 * Privacy-minimized execution DTO. PreparedScanRequest is intentionally not
 * used because it contains the caller-derived client key (an IP in production).
 */
export type DurableScanJobPayload = Readonly<{
  version: 1;
  url: string;
  device: ScanDevice;
  gpcEnabled: boolean;
  compareGpc: boolean;
  compareShields: boolean;
  compareConsent: boolean;
  rateLimitCost: 1 | 2;
  admittedAt: number;
  reportMode: "r2";
  alreadyCharged: true;
}>;

export type DurableScanJobPayloadV1 = DurableScanJobPayload;

export type DurableScanJobSubmission = Readonly<{
  ok: true;
  jobId: string;
  status: "queued";
  statusPath: string;
  reportId: string;
}>;

export type DurableScanJobPreparation = Readonly<{
  submission: DurableScanJobSubmission;
  payload: DurableScanJobPayload;
}>;

/** Every mutation of a leased execution is fenced by this exact owner. */
export type DurableScanJobExecutionOwner = Readonly<{
  jobId: string;
  generation: number;
  leaseToken: string;
}>;

export type DurableScanJobCoordinatorAction = "heartbeat" | "begin-publishing" | "resolve";

export function isDurableScanJobNodePrivatePath(pathname: string): boolean {
  return pathname === DURABLE_SCAN_JOB_NODE_PATH_PREFIX || pathname.startsWith(`${DURABLE_SCAN_JOB_NODE_PATH_PREFIX}/`);
}

export function parseDurableScanJobCoordinatorPath(
  pathname: string
): { jobId: string; action: DurableScanJobCoordinatorAction } | null {
  if (!pathname.startsWith(`${DURABLE_SCAN_JOB_COORDINATOR_PATH_PREFIX}/`)) return null;
  const suffix = pathname.slice(DURABLE_SCAN_JOB_COORDINATOR_PATH_PREFIX.length + 1);
  const segments = suffix.split("/");
  if (segments.length !== 2 || !isScanJobId(segments[0])) return null;
  const action = segments[1];
  if (action !== "heartbeat" && action !== "begin-publishing" && action !== "resolve") {
    return null;
  }
  return { jobId: segments[0], action };
}

/** Remove every current and future header in the reserved durable namespace. */
export function stripDurableScanJobInternalHeaders(input: Headers): Headers {
  const headers = new Headers(input);
  const reserved: string[] = [];
  headers.forEach((_value, name) => {
    if (name.toLowerCase().startsWith("x-site-behavior-lab-durable-job-")) reserved.push(name);
  });
  for (const name of reserved) headers.delete(name);
  return headers;
}

/**
 * Encode the trusted Node preparation into an ASCII-only response header. The
 * caller must still remove the header before returning a public response.
 */
export function encodeDurableScanJobPreparation(preparation: DurableScanJobPreparation): string {
  if (!isDurableScanJobPreparation(preparation)) {
    throw new Error("Invalid durable scan-job preparation.");
  }
  const bytes = new TextEncoder().encode(JSON.stringify(preparation));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/** Strictly decode the private preparation header; malformed values fail closed. */
export function decodeDurableScanJobPreparation(value: string | null): DurableScanJobPreparation | null {
  if (
    !value ||
    value.length > MAX_PREPARATION_HEADER_LENGTH ||
    !BASE64URL_PATTERN.test(value) ||
    value.length % 4 === 1
  ) {
    return null;
  }

  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const parsed: unknown = parseStrictJson(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      bytes.byteLength
    );
    return isDurableScanJobPreparation(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function readDurableScanJobPreparation(response: Response): DurableScanJobPreparation | null {
  return decodeDurableScanJobPreparation(response.headers.get(DURABLE_SCAN_JOB_PREPARED_HEADER));
}

export function isDurableScanJobExecutionOwner(value: unknown): value is DurableScanJobExecutionOwner {
  if (!isRecordWithExactKeys(value, ["jobId", "generation", "leaseToken"])) return false;
  return (
    isScanJobId(value.jobId) &&
    Number.isSafeInteger(value.generation) &&
    (value.generation as number) >= 1 &&
    typeof value.leaseToken === "string" &&
    LEASE_TOKEN_PATTERN.test(value.leaseToken)
  );
}

export function isScanJobId(value: unknown): value is string {
  return typeof value === "string" && JOB_ID_PATTERN.test(value);
}

function isDurableScanJobPreparation(value: unknown): value is DurableScanJobPreparation {
  if (!isRecordWithExactKeys(value, ["submission", "payload"])) return false;
  const { submission, payload } = value;
  if (!isRecordWithExactKeys(submission, ["ok", "jobId", "status", "statusPath", "reportId"])) return false;
  if (!isScanJobId(submission.jobId) || !isScanJobId(submission.reportId) || submission.jobId === submission.reportId) {
    return false;
  }
  if (
    submission.ok !== true ||
    submission.status !== "queued" ||
    submission.statusPath !== `/api/scans/${submission.jobId}`
  ) {
    return false;
  }

  return isDurableScanJobPayload(payload);
}

export function isDurableScanJobPayload(value: unknown): value is DurableScanJobPayload {
  if (
    !isRecordWithExactKeys(value, [
      "version",
      "url",
      "device",
      "gpcEnabled",
      "compareGpc",
      "compareShields",
      "compareConsent",
      "rateLimitCost",
      "admittedAt",
      "reportMode",
      "alreadyCharged"
    ]) ||
    value.version !== 1 ||
    (value.device !== "desktop" && value.device !== "mobile") ||
    typeof value.gpcEnabled !== "boolean" ||
    typeof value.compareGpc !== "boolean" ||
    typeof value.compareShields !== "boolean" ||
    typeof value.compareConsent !== "boolean" ||
    (value.rateLimitCost !== 1 && value.rateLimitCost !== 2) ||
    !Number.isSafeInteger(value.admittedAt) ||
    (value.admittedAt as number) < 0 ||
    value.reportMode !== "r2" ||
    value.alreadyCharged !== true ||
    !isDurableTargetUrl(value.url)
  ) {
    return false;
  }
  const comparisonCount = Number(value.compareGpc) + Number(value.compareShields) + Number(value.compareConsent);
  return comparisonCount <= 1 && value.rateLimitCost === (comparisonCount === 1 ? 2 : 1);
}

function isDurableTargetUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096) return false;
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.href === value
    );
  } catch {
    return false;
  }
}

function isRecordWithExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value as Record<string, unknown>).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
