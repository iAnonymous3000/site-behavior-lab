import { legacyComparisonDecision, v2ComparisonDecision } from "./comparison-decision";
import { createTemporalComparisonReport, orderTemporalPair } from "./compare-reports";
import { comparableSubjectHosts } from "./comparison-eligibility";
import { withoutReportShare } from "./report-locator";
import type { LoadedReport } from "./scan-report-view";
import { viewFromV1Report, viewFromV2 } from "./scan-report-views";
import { buildComparisonDiffV2 } from "./scan-report-v2-evaluators";
import {
  evaluateComparabilityR2,
  scanReportV2R2SemanticViolations
} from "./scan-report-v2-r2-evaluators";
import type { PublicComparisonReportV2R2, PublicScanReportV2R2, ScanRunV2R2 } from "./scan-report-v2-r2";
import { sha256Hex } from "./sha256";
import { publishedReportCorrections } from "./published-report-corrections";
import type { ScanResult } from "./types";

type TemporalGeneration = "v1" | "v2-r1" | "v2-r2";

export type LoadedTemporalComparisonResult =
  | { ok: true; loaded: LoadedReport; generation: "v1" | "v2-r2" }
  | {
      ok: false;
      code:
        | "mixed-generation"
        | "unsupported-revision"
        | "subject-mismatch"
        | "device-mismatch"
        | "unordered"
        | "duplicate-run"
        | "incompatible"
        | "correction-context"
        | "invalid-derived-report";
      message: string;
    };

/**
 * The archive may take the representative visit from a stored comparison,
 * while file comparison deliberately accepts single reports only. Keeping
 * that selection rule here makes the upload UI and its tests use one gate.
 */
export function temporalUploadSelectionError(loaded: LoadedReport): string | null {
  const correctionError = temporalCorrectionError(loaded);
  if (correctionError) return correctionError;
  if (loaded.view.reportType === "comparison") {
    return "Choose a single-scan Site Behavior Lab JSON report.";
  }
  return null;
}

/**
 * Build a local before/after report without crossing recording contracts.
 *
 * - v1 + v1 retains the frozen descriptive builder and reader-side decision;
 * - r2 + r2 emits a real, validator-consistent r2 temporal report whose
 *   comparability and diff are recomputed from the two recorded runs;
 * - mixed generations and r1 are explicit refusals, never best-effort casts.
 */
export function createLoadedTemporalComparison(
  left: LoadedReport,
  right: LoadedReport
): LoadedTemporalComparisonResult {
  // r2 runs have no source-report field, and a v1 derived pair also drops its
  // parent identities. Do not silently turn a corrected/clarified observation
  // into a fresh artifact whose reader cannot recover those notices. This
  // refusal leaves the original reports readable without altering either wire.
  const correctionError = temporalCorrectionError(left) ?? temporalCorrectionError(right);
  if (correctionError) return { ok: false, code: "correction-context", message: correctionError };
  const leftGeneration = temporalGeneration(left);
  const rightGeneration = temporalGeneration(right);
  if (leftGeneration === "v2-r1" || rightGeneration === "v2-r1") {
    return {
      ok: false,
      code: "unsupported-revision",
      message:
        "Temporal comparison requires two v2/r2 reports. Revision 1 remains readable, but it does not carry the r2 evidence contract."
    };
  }
  if (leftGeneration !== rightGeneration) {
    return {
      ok: false,
      code: "mixed-generation",
      message:
        "Temporal comparison cannot mix v1 and v2 reports because their recording contracts differ. Choose two v1 reports or two v2/r2 reports."
    };
  }
  const leftRunView = representativeRunView(left);
  const rightRunView = representativeRunView(right);
  if (!comparableSubjectHosts(leftRunView.domain, rightRunView.domain)) {
    return {
      ok: false,
      code: "subject-mismatch",
      message: `Temporal comparison needs two scans of the same site (${leftRunView.domain} vs ${rightRunView.domain}).`
    };
  }
  if (leftRunView.conditions.viewport.isMobile !== rightRunView.conditions.viewport.isMobile) {
    return {
      ok: false,
      code: "device-mismatch",
      message: "Temporal comparison needs two scans on the same device type (desktop vs mobile)."
    };
  }

  if (leftGeneration === "v1") {
    return createV1TemporalComparison(left, right);
  }
  return createR2TemporalComparison(left, right);
}

function temporalCorrectionError(loaded: LoadedReport): string | null {
  const context = publishedReportCorrections(loaded.view.reportId);
  const events = [...context.subjectEvents, ...context.replacementEvents];
  if (events.length === 0) return null;
  const ids = events.map(event => event.eventId).join(", ");
  return `This report has published correction context (${ids}). A new temporal report cannot retain that context in the current format. Read the original reports and their notices separately.`;
}

function temporalGeneration(loaded: LoadedReport): TemporalGeneration {
  if (loaded.source === "v1") return "v1";
  if (loaded.source === "v2-r2-public" || loaded.source === "v2-r2-ephemeral") return "v2-r2";
  return "v2-r1";
}

function representativeRunView(loaded: LoadedReport) {
  const runs = loaded.view.runs;
  if (loaded.view.reportType !== "comparison") return runs[0];
  return loaded.view.comparison?.temporalPair ? runs[runs.length - 1] : runs[0];
}

function representativeV1Run(loaded: Extract<LoadedReport, { source: "v1" }>): ScanResult {
  const report = loaded.wire;
  const run =
    report.reportType === "comparison"
      ? report.comparisonType === "temporal"
        ? report.variant
        : report.baseline
      : report;
  return withoutReportShare(run);
}

function createV1TemporalComparison(left: LoadedReport, right: LoadedReport): LoadedTemporalComparisonResult {
  if (left.source !== "v1" || right.source !== "v1") {
    return generationInvariantFailure();
  }
  const ordered = orderTemporalPair(representativeV1Run(left), representativeV1Run(right));
  if (!ordered) {
    return {
      ok: false,
      code: "unordered",
      message: "The two reports' recorded timestamps cannot order a before/after pair."
    };
  }
  const wire = createTemporalComparisonReport(ordered[0], ordered[1]);
  const decision = legacyComparisonDecision(wire);
  const supportsDescriptiveDelta =
    decision.mode === "comparable" &&
    (decision.families["raw-counts"].mode === "comparable" ||
      decision.families["tracker-classification"].mode === "comparable");
  if (!supportsDescriptiveDelta) {
    return {
      ok: false,
      code: "incompatible",
      message: `These visits do not support a comparable descriptive delta. ${decision.reasons.slice(0, 2).join(" ")}`.trim()
    };
  }
  return {
    ok: true,
    generation: "v1",
    loaded: { source: "v1", wire, view: viewFromV1Report(wire) }
  };
}

function publicR2Wire(loaded: LoadedReport): PublicScanReportV2R2 | null {
  if (loaded.source === "v2-r2-public") return loaded.wire;
  if (loaded.source === "v2-r2-ephemeral") return loaded.public;
  return null;
}

function representativeR2Run(report: PublicScanReportV2R2): ScanRunV2R2 {
  if (report.reportType === "single") return report.run;
  return report.experiment.kind === "temporal" ? report.variant : report.baseline;
}

function createR2TemporalComparison(left: LoadedReport, right: LoadedReport): LoadedTemporalComparisonResult {
  const leftWire = publicR2Wire(left);
  const rightWire = publicR2Wire(right);
  if (!leftWire || !rightWire) return generationInvariantFailure();

  const leftRun = representativeR2Run(leftWire);
  const rightRun = representativeR2Run(rightWire);
  const leftTime = Date.parse(leftRun.startedAt);
  const rightTime = Date.parse(rightRun.startedAt);
  if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime) || leftTime === rightTime) {
    return {
      ok: false,
      code: "unordered",
      message: "The two reports' recorded timestamps cannot order a before/after pair."
    };
  }
  const [baseline, variant] = leftTime < rightTime ? [leftRun, rightRun] : [rightRun, leftRun];
  if (baseline.runId === variant.runId) {
    return {
      ok: false,
      code: "duplicate-run",
      message: "Choose two distinct recorded visits; these files contain the same run identifier."
    };
  }

  const experiment = {
    kind: "temporal" as const,
    pairId: `temporal-${sha256Hex(`${baseline.runId}\n${variant.runId}`)}`
  };
  const comparability = evaluateComparabilityR2(experiment, baseline, variant);
  const wire: PublicComparisonReportV2R2 = {
    schemaVersion: 2,
    schemaRevision: 2,
    reportType: "comparison",
    baseline: structuredClone(baseline),
    variant: structuredClone(variant),
    experiment,
    comparability,
    diff: buildComparisonDiffV2(baseline, variant, comparability.perMetric)
  };
  const violations = scanReportV2R2SemanticViolations(wire);
  if (violations.length > 0) {
    return {
      ok: false,
      code: "invalid-derived-report",
      message: "The selected visits could not form a valid v2/r2 temporal report."
    };
  }

  const decision = v2ComparisonDecision(wire);
  const comparableFamilies = Object.values(decision.families).filter((family) => family.mode === "comparable");
  if (decision.mode !== "comparable" || comparableFamilies.length === 0) {
    const reasons = [
      ...specificR2CompatibilityReasons(baseline, variant),
      ...decision.reasons,
      ...Object.values(decision.families).flatMap((family) => family.reasons)
    ];
    return {
      ok: false,
      code: "incompatible",
      message: `These v2/r2 visits are not methodologically comparable. ${[...new Set(reasons)].slice(0, 2).join(" ")}`.trim()
    };
  }

  return {
    ok: true,
    generation: "v2-r2",
    loaded: { source: "v2-r2-public", wire, view: viewFromV2(wire, 2) }
  };
}

function specificR2CompatibilityReasons(baseline: ScanRunV2R2, variant: ScanRunV2R2): string[] {
  const reasons: string[] = [];
  if (baseline.provenance.methodologyVersion !== variant.provenance.methodologyVersion) {
    reasons.push("The two visits recorded different methodology versions.");
  }
  if (baseline.provenance.observer !== variant.provenance.observer) {
    reasons.push("The two visits used different observation methods.");
  }
  if (baseline.toolchain.normalizationVersion !== variant.toolchain.normalizationVersion) {
    reasons.push("The two visits used different normalization versions.");
  }
  if (baseline.toolchain.trackerCatalog.digest !== variant.toolchain.trackerCatalog.digest) {
    reasons.push("The two visits used different tracker-catalog snapshots.");
  }
  return reasons;
}

function generationInvariantFailure(): LoadedTemporalComparisonResult {
  return {
    ok: false,
    code: "invalid-derived-report",
    message: "The selected reports changed generation while the temporal comparison was being prepared."
  };
}
