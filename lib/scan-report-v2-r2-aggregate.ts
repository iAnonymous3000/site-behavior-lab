import { FULL_GIT_SHA } from "./build-provenance";
import { NODE_SCAN_REPORT_V2_R2_MAX_PUBLIC_BYTES } from "./scan-report-v2-r2-limits";
import { readStoredScanReport } from "./scan-report-reader";
import { toPublicScanReportR2 } from "./scan-report-v2-r2-projection";
import { scanReportV2R2SemanticViolations } from "./scan-report-v2-r2-evaluators";
import type { PublicComparisonReportV2R2, SupportingPairR2 } from "./scan-report-v2-r2";

const OPAQUE_PRODUCER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export type AggregatedSupportingPairR2 = {
  report: PublicComparisonReportV2R2;
  buildCommit: string;
  axis: "gpc" | "shields" | "consent";
  primaryPairId: string;
  supportingPairId: string;
  counterbalanced: boolean;
  publicBytes: number;
};

/**
 * Combine two independently produced, primary-only r2 intervention reports.
 *
 * This is deliberately an operator/CI boundary, not a public four-run scan
 * mode. Each input remains a separately admitted and charged comparison. The
 * second report contributes one complete SupportingPairR2; r2 has no
 * metric-scoped repeated-effect model, so strength stays observed-difference
 * regardless of order or the recorded metric deltas.
 */
export function aggregateSupportingPairR2(
  primaryInput: unknown,
  supportingInput: unknown
): AggregatedSupportingPairR2 {
  const primary = readPrimaryOnlyIntervention(primaryInput, "Primary input");
  const supporting = readPrimaryOnlyIntervention(supportingInput, "Supporting input");

  if (primary.experiment.axis !== supporting.experiment.axis) {
    throw new Error(
      `Comparison axes do not match (${primary.experiment.axis} versus ${supporting.experiment.axis}).`
    );
  }

  const primaryBuild = reportBuildCommit(primary, "Primary input");
  const supportingBuild = reportBuildCommit(supporting, "Supporting input");
  if (primaryBuild !== supportingBuild) {
    throw new Error(`Comparison build provenance does not match (${primaryBuild} versus ${supportingBuild}).`);
  }

  assertVerifiedPrimaryPair(primary, "Primary input");
  assertVerifiedPrimaryPair(supporting, "Supporting input");
  assertUniquePairAndRunIds(primary, supporting);

  const supportingPair: SupportingPairR2 = {
    pairId: supporting.experiment.pairId,
    order: supporting.experiment.order,
    baseline: supporting.baseline,
    variant: supporting.variant,
    verification: supporting.experiment.verification
  };
  const counterbalanced = primary.experiment.order !== supporting.experiment.order;
  const report: PublicComparisonReportV2R2 = {
    ...primary,
    experiment: {
      ...primary.experiment,
      supportingPairs: [supportingPair],
      evidence: {
        pairs: 2,
        counterbalanced,
        strength: "observed-difference"
      }
    }
  };

  const violations = scanReportV2R2SemanticViolations(report);
  if (violations.length > 0) {
    throw new Error(`Supporting pair is not compatible with the primary pair: ${violations.join("; ")}`);
  }
  const readback = readStoredScanReport(report);
  if (
    !readback.ok ||
    readback.stored.schemaVersion !== 2 ||
    readback.stored.schemaRevision !== 2 ||
    readback.stored.report.reportType !== "comparison"
  ) {
    throw new Error("Aggregated report failed the shared ScanReport v2/r2 reader gate.");
  }

  const publicReport = toPublicScanReportR2(readback.stored.report);
  const publicBytes = Buffer.byteLength(`${JSON.stringify(publicReport, null, 2)}\n`, "utf8");
  if (publicBytes > NODE_SCAN_REPORT_V2_R2_MAX_PUBLIC_BYTES) {
    throw new Error(
      `Aggregated ScanReport v2/r2 is ${publicBytes} public bytes; the limit is ${NODE_SCAN_REPORT_V2_R2_MAX_PUBLIC_BYTES}.`
    );
  }

  return {
    report: publicReport,
    buildCommit: primaryBuild,
    axis: primary.experiment.axis,
    primaryPairId: primary.experiment.pairId,
    supportingPairId: supporting.experiment.pairId,
    counterbalanced,
    publicBytes
  };
}

function readPrimaryOnlyIntervention(input: unknown, label: string): PublicComparisonReportV2R2 & {
  experiment: Extract<PublicComparisonReportV2R2["experiment"], { kind: "intervention" }>;
} {
  const read = readStoredScanReport(input);
  if (!read.ok) {
    throw new Error(`${label} is not a validator-clean ScanReport (${read.error}).`);
  }
  if (read.stored.schemaVersion !== 2 || read.stored.schemaRevision !== 2) {
    throw new Error(`${label} must be ScanReport v2/r2.`);
  }
  if (read.stored.report.reportType !== "comparison" || read.stored.report.experiment.kind !== "intervention") {
    throw new Error(`${label} must be an r2 intervention comparison.`);
  }
  if (read.stored.report.experiment.supportingPairs !== undefined) {
    throw new Error(`${label} must contain exactly one primary pair and no supportingPairs property.`);
  }
  if (read.stored.report.share !== undefined) {
    throw new Error(`${label} must be an unpublished shadow artifact without a share identity.`);
  }
  return toPublicScanReportR2(read.stored.report) as PublicComparisonReportV2R2 & {
    experiment: Extract<PublicComparisonReportV2R2["experiment"], { kind: "intervention" }>;
  };
}

function reportBuildCommit(report: PublicComparisonReportV2R2, label: string): string {
  const builds = new Set([report.baseline.provenance.buildCommit, report.variant.provenance.buildCommit]);
  if (builds.size !== 1) {
    throw new Error(`${label} arms do not share one build commit.`);
  }
  const build = report.baseline.provenance.buildCommit;
  if (!FULL_GIT_SHA.test(build)) {
    throw new Error(`${label} build provenance must be a full lowercase 40-character Git SHA.`);
  }
  return build;
}

function assertVerifiedPrimaryPair(report: PublicComparisonReportV2R2, label: string): void {
  if (report.experiment.kind !== "intervention") throw new Error(`${label} is not an intervention comparison.`);
  if (!report.comparability.pairValidity.eligible) {
    throw new Error(`${label} primary pair is not pair-eligible.`);
  }
  if (report.comparability.interventionVerified !== true) {
    throw new Error(`${label} intervention was not verified.`);
  }
  const arms = [report.experiment.verification.baseline, report.experiment.verification.variant];
  if (arms.some((arm) => arm.outcome !== "passed")) {
    throw new Error(`${label} requires two passed intervention arms.`);
  }
}

function assertUniquePairAndRunIds(
  primary: PublicComparisonReportV2R2,
  supporting: PublicComparisonReportV2R2
): void {
  if (primary.experiment.kind !== "intervention" || supporting.experiment.kind !== "intervention") {
    throw new Error("Both inputs must be intervention comparisons.");
  }
  const pairIds = [primary.experiment.pairId, supporting.experiment.pairId];
  if (pairIds.some((id) => !OPAQUE_PRODUCER_ID.test(id))) {
    throw new Error("Comparison pairIds must be bounded producer-generated opaque tokens.");
  }
  if (primary.experiment.pairId === supporting.experiment.pairId) {
    throw new Error(`Comparison pairId ${primary.experiment.pairId} is reused.`);
  }
  const runIds = [
    primary.baseline.runId,
    primary.variant.runId,
    supporting.baseline.runId,
    supporting.variant.runId
  ];
  if (runIds.some((id) => !OPAQUE_PRODUCER_ID.test(id))) {
    throw new Error("Comparison runIds must be bounded producer-generated opaque tokens.");
  }
  if (new Set(runIds).size !== runIds.length) {
    throw new Error("Comparison runIds must be unique across both pairs.");
  }
}
