import { publicReportDigest } from "./canonical-json";
import { isCanonicalTimestamp } from "./canonical-timestamp";
import { publicStringPolicyInputs, redactScanReportV1 } from "./redact-scan-report-v1";
import { REDACTION_VERSION } from "./redaction-v2";
import {
  SERVER_STORED_PROVENANCE_SIDECAR_MAX_BYTES,
  SERVER_STORED_REPORT_JSON_MAX_BYTES
} from "./report-resource-limits";
import { isCanonicalReportShare } from "./report-locator";
import { reportResourceViolation, type ReportResourceViolation } from "./report-resource-policy";
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
import {
  R2RedactionRemediationError,
  r2ReportRuns,
  redactPublicScanReportV2R2,
  type R2RedactionRemediationFailure
} from "./scan-report-v2-r2-remediation";
import { R2ProducerContractError } from "./scan-report-v2-r2-producer-contract";
import type { PublicScanReportV2R2 } from "./scan-report-v2-r2";
import { PUBLIC_SCANNER_EGRESS_LABELS } from "./scanner-egress";
import { SeamVisitRefusal } from "./seam-visit-mark";
import { parseStrictJson } from "./strict-json";
import type { ScanReport } from "./types";

export type ManagedReportReadFailureReason =
  | "invalid-report-json"
  | "report-resource-limit"
  | "invalid-report"
  | "unmanaged-schema-revision"
  | "no-sidecar"
  | "invalid-sidecar-json"
  | "malformed-sidecar"
  | "report-id-mismatch"
  | "canonicalization-version-mismatch"
  | "redaction-version-mismatch"
  | "digest-mismatch"
  | "redaction-not-idempotent"
  | "producer-contract-mismatch"
  | "producer-vocabulary-mismatch"
  | "share-id-mismatch"
  | "missing-retention-metadata"
  | "malformed-retention-metadata"
  | "retention-metadata-mismatch";

/**
 * Why a report failed the fixed-point check, carried beside the
 * `redaction-not-idempotent` reason and never in place of it (CLIs and
 * verifiers pin the reason). "digest-mismatch" is the check itself: redacting
 * the report again changed it. A remediation failure kind is the sanitizer
 * refusing the report's content or declarations. "exception" is anything
 * else the sanitizer threw, a defect rather than an answer about the report.
 */
export type ManagedReportRedactionFailure = "digest-mismatch" | R2RedactionRemediationFailure | "exception";

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
      /** Present exactly when `reason` is `redaction-not-idempotent`. */
      redactionFailure?: ManagedReportRedactionFailure;
      /**
       * Present exactly when `reason` is `report-resource-limit`: the first
       * limit the report breaks and where, for operator logs.
       */
      resourceViolation?: ReportResourceViolation;
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
  const resourceViolation = reportResourceViolation(publicReport);
  if (resourceViolation !== null) {
    return { ok: false, error: "invalid", reason: "report-resource-limit", resourceViolation };
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

  // Schema v2 revision 1 has no managed form. The fixed-point checks below
  // exist for frozen v1 and for schema-r2 only, so nothing here can show that
  // an r1 report holds no string the current redaction removes: one that
  // declares the current redaction version beside a sidecar of its own
  // digest, which anyone able to write the store can compute, would be
  // served on its word alone, raw URLs, page title and names included. No
  // producer writes r1, and an r1 report as its producer wrote it declares
  // an older redaction version that no current sidecar matches. The revision
  // itself is refused, before a sidecar is read. A file a person opens is
  // read by readStoredScanReport, which still accepts r1.
  if (reportRead.stored.schemaVersion === 2 && reportRead.stored.schemaRevision === 1) {
    return failure("unmanaged-schema-revision");
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
  // matchProvenance just recomputed the original wire digest. Reuse that
  // verified value for the fixed-point comparison; do not hash the same
  // object twice. A matching sidecar never permits skipping the sanitizer. Frozen
  // v1 must already be a fixed point of the current public transform or a
  // forged/current-version sidecar could bless raw legacy bytes.
  if (reportRead.stored.schemaVersion === 1) {
    let redactedDigest: string;
    try {
      redactedDigest = publicReportDigest(redactScanReportV1(reportRead.stored.report).report);
    } catch (error) {
      // The reader above declines a report that carries the mark of a visit
      // a private capture was connected to, in the places its check looks.
      // The sanitizer makes the same check again on each arm of a comparison,
      // so it can still refuse a stored shape the reader passed. That is the
      // same answer about the report, so it is given the same way: not a
      // report. Anything else the sanitizer throws is thrown on, as before.
      if (error instanceof SeamVisitRefusal) return { ok: false, error: "invalid", reason: "invalid-report" };
      throw error;
    }
    if (redactedDigest !== provenance.entry.publicDigest) return redactionFailure("digest-mismatch");
  }
  if (reportRead.stored.schemaVersion === 1 && !hasReviewedRunLabels(reportRead.stored.report)) {
    return failure("producer-vocabulary-mismatch");
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
      if (publicReportDigest(redacted) !== provenance.entry.publicDigest) {
        return redactionFailure("digest-mismatch");
      }
    } catch (error) {
      if (error instanceof R2ProducerContractError || (error instanceof Error && error.cause instanceof R2ProducerContractError)) {
        return failure("producer-contract-mismatch");
      }
      return redactionFailure(error instanceof R2RedactionRemediationError ? error.reason : "exception");
    }
    if (!hasPublicEgressLabels(reportRead.stored.report)) {
      return failure("producer-vocabulary-mismatch");
    }
  }

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

/*
 * Producer-owned strings that both sanitizers copy as they are, because a
 * producer writes them only from a closed list. A fixed point of the
 * sanitizer therefore says nothing about them, and a planted bundle could
 * publish any text there. Each is held to its closed list, read from the
 * module that owns the list so the reader keeps no copy that could drift.
 */

// The names a v1 comparison gives its two runs: the sanitizer's reviewed run
// labels, which it already requires of the run name that prefixes a warning.
// Every name a comparison producer writes is among them.
const REVIEWED_RUN_LABELS: ReadonlySet<string> = new Set(publicStringPolicyInputs().warningLabels);

// The egress label of a Node run. The scanner resolves an operator's label to
// this list before a visit (resolveScannerEgressLabel). A PageGraph import
// carries a label its metadata declares, which is not from this list.
const PUBLIC_EGRESS_LABELS: ReadonlySet<string> = new Set(PUBLIC_SCANNER_EGRESS_LABELS);

function hasReviewedRunLabels(report: ScanReport): boolean {
  if (report.reportType !== "comparison" || report.runLabels === undefined) return true;
  return REVIEWED_RUN_LABELS.has(report.runLabels.baseline) && REVIEWED_RUN_LABELS.has(report.runLabels.variant);
}

function hasPublicEgressLabels(report: PublicScanReportV2R2): boolean {
  return r2ReportRuns(report).every(
    (run) => run.provenance.observer !== "node-playwright" || PUBLIC_EGRESS_LABELS.has(run.conditions.egress.label)
  );
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

function failure(
  reason: Exclude<ManagedReportReadFailureReason, "redaction-not-idempotent" | "report-resource-limit">
): ManagedReportReadResult {
  return { ok: false, error: "invalid", reason };
}

function redactionFailure(kind: ManagedReportRedactionFailure): ManagedReportReadResult {
  return { ok: false, error: "invalid", reason: "redaction-not-idempotent", redactionFailure: kind };
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

