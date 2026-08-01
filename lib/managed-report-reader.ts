import { publicReportDigest } from "./canonical-json";
import { isCanonicalTimestamp } from "./canonical-timestamp";
import { redactScanReportV1 } from "./redact-scan-report-v1";
import { REDACTION_VERSION } from "./redaction-v2";
import {
  SERVER_STORED_PROVENANCE_SIDECAR_MAX_BYTES,
  SERVER_STORED_REPORT_JSON_MAX_BYTES
} from "./report-resource-limits";
import { isCanonicalReportShare } from "./report-locator";
import { hasSafeReportCollections } from "./report-resource-policy";
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
import { redactPublicScanReportV2R2 } from "./scan-report-v2-r2-remediation";
import { parseStrictJson } from "./strict-json";

export type ManagedReportReadFailureReason =
  | "invalid-report-json"
  | "report-resource-limit"
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
    publicReport = parseStrictJson(input.reportContents, SERVER_STORED_REPORT_JSON_MAX_BYTES);
  } catch {
    return failure("invalid-report-json");
  }

  // Strict JSON and a wire-byte ceiling do not bound the decoded graph's
  // cardinality. Reject amplified arrays, property sets, and render strings
  // before schema guards, semantic evaluation, redaction checks, or SSR walk
  // attacker-controlled collections.
  if (!hasSafeReportCollections(publicReport)) {
    return failure("report-resource-limit");
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

  // Schema-r2 is mutable only at an explicit remediation boundary. A report
  // already declaring the current revision must itself be a fixed point of
  // the reviewed sanitizer; otherwise a forged v4 marker plus a matching
  // sidecar could bless unsafe evidence. Older versions continue below to the
  // provenance/version check so ordinary reads never perform a migration.
  if (
    reportRead.stored.schemaVersion === 2 &&
    reportRead.stored.schemaRevision === 2 &&
    embeddedRedactionVersions(reportRead.stored).every((version) => version === REDACTION_VERSION)
  ) {
    try {
      const redacted = redactPublicScanReportV2R2(reportRead.stored.report);
      if (publicReportDigest(redacted) !== publicReportDigest(publicReport)) {
        return failure("redaction-not-idempotent");
      }
    } catch {
      return failure("redaction-not-idempotent");
    }
  }

  const share = reportRead.stored.report.share;
  if (share && !isCanonicalReportShare(share, input.reportId)) {
    return failure("share-id-mismatch");
  }

  if (input.sidecarContents === null) return failure("no-sidecar");
  let sidecar: unknown;
  try {
    sidecar = parseStrictJson(input.sidecarContents, SERVER_STORED_PROVENANCE_SIDECAR_MAX_BYTES);
  } catch {
    return failure("invalid-sidecar-json");
  }

  const provenance = matchProvenance(publicReport, sidecar, input.reportId);
  if (provenance.status !== "matched") return provenanceFailure(provenance);
  if (
    reportRead.stored.schemaVersion === 2 &&
    embeddedRedactionVersions(reportRead.stored).some(
      (version) => version !== provenance.entry.redactionVersion
    )
  ) {
    return failure("redaction-version-mismatch");
  }
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

function embeddedRedactionVersions(stored: Extract<StoredScanReport, { schemaVersion: 2 }>): number[] {
  if (stored.report.reportType === "single") return [stored.report.run.privacy.redactionVersion];

  const versions = [
    stored.report.baseline.privacy.redactionVersion,
    stored.report.variant.privacy.redactionVersion
  ];
  if (
    stored.schemaRevision === 2 &&
    stored.report.experiment.kind === "intervention" &&
    stored.report.experiment.supportingPairs !== undefined
  ) {
    for (const pair of stored.report.experiment.supportingPairs) {
      versions.push(pair.baseline.privacy.redactionVersion, pair.variant.privacy.redactionVersion);
    }
  }
  return versions;
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

