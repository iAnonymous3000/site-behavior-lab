/**
 * Tier 1 -> Tier 2 public projection for v2 REVISION 2 shells (RFC section 8,
 * 15.2). Composes the r1 named-field projector with explicit copiers for the
 * r2 additions, so unknown fields are still dropped by construction at every
 * level, the ephemeral block never survives, and nothing this module does not
 * name can reach persistence.
 */
import { copyComparability, copyDiff, copyExperiment, copyScanRunV2, copyShare } from "./scan-report-projection";
import type { ArmVerification } from "./scan-report-v2";
import type {
  BannerTransitionR2,
  ConsentObservationResultR2,
  EphemeralComparisonReportR2,
  EphemeralSingleReportR2,
  GpcVerificationFactsR2,
  InterventionExperimentR2,
  PublicComparisonReportV2R2,
  PublicScanReportV2R2,
  PublicSingleReportV2R2,
  ScanRunV2R2,
  ShieldsVerificationFactsR2,
  SupportingPairR2
} from "./scan-report-v2-r2";

function copyResult(result: ConsentObservationResultR2): ConsentObservationResultR2 {
  switch (result.outcome) {
    case "read":
    case "unreadable":
      return { outcome: result.outcome, sequence: result.sequence };
    case "error":
      return { outcome: "error", sequence: result.sequence, errorCode: result.errorCode };
    case "timeout":
      return { outcome: "timeout", sequence: result.sequence, errorCode: result.errorCode };
    case "unsupported-frame":
      return { outcome: "unsupported-frame", sequence: result.sequence, errorCode: result.errorCode };
  }
}

function copyBannerTransition(transition: BannerTransitionR2): BannerTransitionR2 {
  return {
    method: transition.method,
    observations: transition.observations.map((observation) => ({
      moment: observation.moment,
      phaseId: observation.phaseId,
      atMs: observation.atMs,
      visible: observation.visible
    }))
  };
}

function copyGpcFacts(facts: GpcVerificationFactsR2): GpcVerificationFactsR2 {
  return {
    method: facts.method,
    header: facts.header,
    jsSignal: facts.jsSignal,
    observedOn: facts.observedOn,
    phaseId: facts.phaseId
  };
}

function copyShieldsFacts(facts: ShieldsVerificationFactsR2): ShieldsVerificationFactsR2 {
  return {
    method: facts.method,
    engineLoaded: facts.engineLoaded,
    applied: facts.applied,
    requestsEvaluated: facts.requestsEvaluated,
    requestsMatched: facts.requestsMatched,
    requestsActuallyBlocked: facts.requestsActuallyBlocked,
    phaseId: facts.phaseId
  };
}

export function copyScanRunV2R2(run: ScanRunV2R2): ScanRunV2R2 {
  // The r1 projector copies every retained field and, being named-field,
  // drops the r2 additions; they are re-attached from their own copiers.
  const base = copyScanRunV2(run);
  const copied: ScanRunV2R2 = { ...base, evidence: { ...base.evidence } };

  if (run.verificationFacts !== undefined) {
    copied.verificationFacts = {
      ...(run.verificationFacts.gpc !== undefined ? { gpc: copyGpcFacts(run.verificationFacts.gpc) } : {}),
      ...(run.verificationFacts.shields !== undefined ? { shields: copyShieldsFacts(run.verificationFacts.shields) } : {})
    };
  }

  const consent = run.evidence.consent;
  const baseConsent = copied.evidence.consent;
  if (consent !== undefined && baseConsent !== undefined) {
    copied.evidence.consent = {
      ...baseConsent,
      // The r1 copier preserves observation order, so results re-attach by index.
      verificationObservations: baseConsent.verificationObservations.map((observation, index) => ({
        ...observation,
        ...(consent.verificationObservations[index]?.result !== undefined
          ? { result: copyResult(consent.verificationObservations[index].result!) }
          : {})
      })),
      ...(consent.bannerTransition !== undefined ? { bannerTransition: copyBannerTransition(consent.bannerTransition) } : {})
    };
  }
  return copied;
}

function copyArm(arm: ArmVerification): ArmVerification {
  return {
    axis: arm.axis,
    expected: arm.expected,
    observed: arm.observed,
    method: arm.method,
    outcome: arm.outcome,
    phaseId: arm.phaseId
  };
}

function copySupportingPair(pair: SupportingPairR2): SupportingPairR2 {
  return {
    pairId: pair.pairId,
    order: pair.order,
    baseline: copyScanRunV2R2(pair.baseline),
    variant: copyScanRunV2R2(pair.variant),
    verification: { baseline: copyArm(pair.verification.baseline), variant: copyArm(pair.verification.variant) }
  };
}

function copyExperimentR2(experiment: InterventionExperimentR2 | PublicComparisonReportV2R2["experiment"]) {
  const base = copyExperiment(experiment);
  if (experiment.kind === "intervention" && experiment.supportingPairs !== undefined && base.kind === "intervention") {
    return { ...base, supportingPairs: experiment.supportingPairs.map(copySupportingPair) };
  }
  return base;
}

export function toPublicScanReportR2(report: EphemeralSingleReportR2 | PublicSingleReportV2R2): PublicSingleReportV2R2;
export function toPublicScanReportR2(
  report: EphemeralComparisonReportR2 | PublicComparisonReportV2R2
): PublicComparisonReportV2R2;
export function toPublicScanReportR2(
  report: EphemeralSingleReportR2 | EphemeralComparisonReportR2 | PublicScanReportV2R2
): PublicScanReportV2R2;
export function toPublicScanReportR2(
  report: EphemeralSingleReportR2 | EphemeralComparisonReportR2 | PublicScanReportV2R2
): PublicScanReportV2R2 {
  if (report.reportType === "comparison") {
    return {
      schemaVersion: 2,
      schemaRevision: 2,
      reportType: "comparison",
      baseline: copyScanRunV2R2(report.baseline),
      variant: copyScanRunV2R2(report.variant),
      experiment: copyExperimentR2(report.experiment),
      comparability: copyComparability(report.comparability),
      diff: copyDiff(report.diff),
      ...copyShare(report.share)
    };
  }
  return {
    schemaVersion: 2,
    schemaRevision: 2,
    reportType: "single",
    run: copyScanRunV2R2(report.run),
    ...copyShare(report.share)
  };
}
