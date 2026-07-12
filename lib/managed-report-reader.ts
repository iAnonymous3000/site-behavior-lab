import { publicReportDigest } from "./canonical-json";
import { redactScanReportV1 } from "./redact-scan-report-v1";
import { isCanonicalReportShare } from "./report-locator";
import {
  matchProvenance,
  type ProvenanceMatch,
  type RedactionProvenanceEntry
} from "./redaction-provenance";
import {
  readStoredScanReport,
  type ReadStoredScanReportError,
  type StoredScanReport
} from "./scan-report-reader";

export type ManagedReportReadFailureReason =
  | "invalid-report-json"
  | "invalid-report"
  | "no-sidecar"
  | "invalid-sidecar-json"
  | "malformed-sidecar"
  | "report-id-mismatch"
  | "canonicalization-version-mismatch"
  | "redaction-version-mismatch"
  | "digest-mismatch"
  | "redaction-not-idempotent"
  | "share-id-mismatch"
  | "missing-retention-metadata"
  | "malformed-retention-metadata"
  | "retention-metadata-mismatch";

/** Runtime objects have a concrete expiry; committed corpus reports use null. */
export type ManagedReportClock = {
  createdAt: string;
  expiresAt: string | null;
};

export type ManagedReportReadResult =
  | {
      ok: true;
      stored: StoredScanReport;
      wire: string;
      provenance: RedactionProvenanceEntry;
      retention: ManagedReportClock;
    }
  | {
      ok: false;
      error: ReadStoredScanReportError;
      reason: ManagedReportReadFailureReason;
      violations?: string[];
    };

/**
 * Reads one managed report as a report + provenance sidecar + immutable
 * retention-metadata unit. Every partial or contradictory state fails closed;
 * only the original report wire is returned on success.
 */
export function readManagedReport(input: {
  reportId: string;
  reportContents: string;
  sidecarContents: string | null;
  retention: ManagedReportClock | null;
}): ManagedReportReadResult {
  let publicReport: unknown;
  try {
    publicReport = JSON.parse(input.reportContents) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) return failure("invalid-report-json");
    throw error;
  }

  const reportRead = readStoredScanReport(publicReport);
  if (!reportRead.ok) {
    return {
      ok: false,
      error: reportRead.error,
      reason: "invalid-report",
      ...(reportRead.violations ? { violations: reportRead.violations } : {})
    };
  }

  // A sidecar is an attestation, not authority to skip the sanitizer. Frozen
  // v1 must already be a fixed point of the current public transform or a
  // forged/current-version sidecar could bless raw legacy bytes.
  if (
    reportRead.stored.schemaVersion === 1 &&
    publicReportDigest(redactScanReportV1(reportRead.stored.report).report) !== publicReportDigest(publicReport)
  ) {
    return failure("redaction-not-idempotent");
  }

  const share = reportRead.stored.report.share;
  if (share && !isCanonicalReportShare(share, input.reportId)) {
    return failure("share-id-mismatch");
  }

  if (input.sidecarContents === null) return failure("no-sidecar");
  let sidecar: unknown;
  try {
    sidecar = JSON.parse(input.sidecarContents) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) return failure("invalid-sidecar-json");
    throw error;
  }

  const provenance = matchProvenance(publicReport, sidecar, input.reportId);
  if (provenance.status !== "matched") return provenanceFailure(provenance);
  if (!input.retention) return failure("missing-retention-metadata");
  if (!isManagedReportClock(input.retention)) return failure("malformed-retention-metadata");
  if (
    provenance.entry.createdAt !== input.retention.createdAt ||
    provenance.entry.expiresAt !== input.retention.expiresAt
  ) {
    return failure("retention-metadata-mismatch");
  }

  return {
    ok: true,
    stored: reportRead.stored,
    wire: input.reportContents,
    provenance: provenance.entry,
    retention: input.retention
  };
}

function provenanceFailure(match: Exclude<ProvenanceMatch, { status: "matched" }>): ManagedReportReadResult {
  return failure(match.status === "digest-mismatch" ? "digest-mismatch" : match.reason);
}

function failure(reason: ManagedReportReadFailureReason): ManagedReportReadResult {
  return { ok: false, error: "invalid", reason };
}

function isManagedReportClock(value: unknown): value is ManagedReportClock {
  if (!value || typeof value !== "object") return false;
  const clock = value as Partial<ManagedReportClock>;
  return (
    Object.keys(value).length === 2 &&
    isCanonicalTimestamp(clock.createdAt) &&
    (clock.expiresAt === null || isCanonicalTimestamp(clock.expiresAt)) &&
    (clock.expiresAt === null || Date.parse(clock.expiresAt) > Date.parse(clock.createdAt))
  );
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}
