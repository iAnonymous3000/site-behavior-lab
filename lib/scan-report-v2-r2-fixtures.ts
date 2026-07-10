/**
 * Deterministic ScanReport v2 REVISION 2 fixtures per the accepted r2-a4
 * addendum (docs/scan-report-v2-rfc.md, section 15). Types-and-fixtures slice:
 * these compile against lib/scan-report-v2-r2.ts and seed the next slice's r2
 * validator/evaluator and differential harness; nothing validates or emits
 * them yet.
 *
 * Derived blocks (quality, comparability, diff) are built with the r1
 * evaluators where the semantics coincide; fields whose derivation changes in
 * r2 (experiment evidence with supporting pairs) are written to the r2-a4
 * rules and will be pinned by the r2 evaluator slice.
 */
import { axisStateFor, type ArmVerification, type Experiment } from "./scan-report-v2";
import { buildComparisonDiffV2, evaluateComparability } from "./scan-report-v2-evaluators";
import { buildFingerprints } from "./scan-report-v2-fingerprints";
import { makeScanRunV2 } from "./scan-report-v2-fixtures";
import type {
  ConsentEvidenceR2,
  ExperimentR2,
  PublicComparisonReportV2R2,
  PublicSingleReportV2R2,
  ScanRunV2R2,
  SupportingPairR2
} from "./scan-report-v2-r2";

type RunOverrides = {
  runId?: string;
  startedAt?: string;
  gpc?: boolean;
  shields?: "off" | "classification" | "block-simulation";
  consent?: "observe" | "accept-all" | "reject-all";
};

export function makeScanRunV2R2(overrides: RunOverrides = {}): ScanRunV2R2 {
  const run = makeScanRunV2({ runId: overrides.runId, startedAt: overrides.startedAt, shields: overrides.shields });
  run.conditions = {
    ...run.conditions,
    ...(overrides.gpc !== undefined ? { gpc: overrides.gpc } : {}),
    ...(overrides.consent !== undefined ? { consent: overrides.consent } : {})
  };
  run.fingerprints = buildFingerprints({
    conditions: run.conditions,
    provenance: run.provenance,
    toolchain: run.toolchain,
    detectors: run.detectors
  });
  return run;
}

/** A consent-mode r2 run: phased, with result-bearing observations and a grounded transition. */
export function makeConsentRunR2(mode: "accept-all" | "reject-all", overrides: RunOverrides = {}): ScanRunV2R2 {
  const run = makeScanRunV2R2({ ...overrides, consent: mode });
  run.phases = [
    { phaseId: 0, kind: "passive-load", startedAtMs: 0, endedAtMs: 2000 },
    { phaseId: 1, kind: "consent-interaction", startedAtMs: 2000, endedAtMs: 3000 },
    { phaseId: 2, kind: "post-choice-reload", startedAtMs: 3000, endedAtMs: 5000 }
  ];
  const observed = mode === "accept-all" ? ("accepted-all" as const) : ("rejected-all" as const);
  const consent: ConsentEvidenceR2 = {
    mode,
    interactionAttempted: true,
    controlActivated: true,
    verificationObservations: [
      {
        phaseId: 1,
        method: "onetrust-cookie@1",
        observed,
        consistentWithChoice: true,
        result: { outcome: "read", sequence: 0 }
      },
      {
        phaseId: 2,
        method: "onetrust-cookie@1",
        observed,
        consistentWithChoice: true,
        result: { outcome: "read", sequence: 1 }
      }
    ],
    choiceState: "verified",
    reverifiedAfterReload: true,
    bannerTransition: {
      method: "banner-visibility@1",
      observations: [
        { moment: "before-interaction", phaseId: 1, atMs: 2100, visible: true },
        { moment: "after-interaction", phaseId: 1, atMs: 2900, visible: false },
        { moment: "after-reload", phaseId: 2, atMs: 3500, visible: false }
      ]
    }
  };
  run.evidence = { ...run.evidence, consent };
  return run;
}

export function makePublicSingleReportV2R2(): PublicSingleReportV2R2 {
  return { schemaVersion: 2, schemaRevision: 2, reportType: "single", run: makeScanRunV2R2() };
}

export function makeConsentSingleReportV2R2(): PublicSingleReportV2R2 {
  return { schemaVersion: 2, schemaRevision: 2, reportType: "single", run: makeConsentRunR2("reject-all") };
}

function makeArm(axis: "gpc" | "shields", run: ScanRunV2R2, phaseId: number): ArmVerification {
  const expected = axisStateFor(axis, run.conditions);
  return {
    axis,
    expected,
    observed: expected,
    method: axis === "gpc" ? "gpc-header-readback@1" : "shields-engine-status@1",
    outcome: "passed",
    phaseId
  };
}

function makeComparison(
  baseline: ScanRunV2R2,
  variant: ScanRunV2R2,
  experiment: ExperimentR2
): PublicComparisonReportV2R2 {
  // The r1 evaluator does not know supportingPairs; strip them for the shared
  // comparability/diff computation (the r2 evaluator slice supersedes this).
  let evaluatorExperiment: Experiment;
  if (experiment.kind === "intervention") {
    const { supportingPairs: _supportingPairs, ...r1Experiment } = experiment;
    evaluatorExperiment = r1Experiment;
  } else {
    evaluatorExperiment = experiment;
  }
  const comparability = evaluateComparability(evaluatorExperiment, baseline, variant);
  return {
    schemaVersion: 2,
    schemaRevision: 2,
    reportType: "comparison",
    baseline,
    variant,
    experiment,
    comparability,
    diff: buildComparisonDiffV2(baseline, variant, comparability.perMetric)
  };
}

/** RFC 15.3: a GPC intervention pair with structured facts on both runs. */
export function makeGpcInterventionReportV2R2(): PublicComparisonReportV2R2 {
  const baseline = makeScanRunV2R2({ runId: "run-gpc-off", gpc: false });
  const variant = makeScanRunV2R2({ runId: "run-gpc-on", startedAt: "2026-07-09T10:01:00.000Z", gpc: true });
  baseline.verificationFacts = {
    gpc: {
      method: "gpc-header-readback@1",
      header: "confirmed-absent",
      jsSignal: "confirmed-absent",
      observedOn: "first-party-navigation",
      phaseId: 0
    }
  };
  variant.verificationFacts = {
    gpc: {
      method: "gpc-header-readback@1",
      header: "confirmed-present",
      jsSignal: "confirmed-true",
      observedOn: "first-party-navigation",
      phaseId: 0
    }
  };
  return makeComparison(baseline, variant, {
    kind: "intervention",
    axis: "gpc",
    pairId: "pair-gpc-r2",
    order: "AB",
    verification: { baseline: makeArm("gpc", baseline, 0), variant: makeArm("gpc", variant, 0) },
    evidence: { pairs: 1, counterbalanced: false, strength: "observed-difference" }
  });
}

/** RFC 15.3: a Shields intervention pair with evaluated/matched/actually-blocked facts. */
export function makeShieldsInterventionReportV2R2(): PublicComparisonReportV2R2 {
  const baseline = makeScanRunV2R2({ runId: "run-shields-class", shields: "classification" });
  const variant = makeScanRunV2R2({
    runId: "run-shields-sim",
    startedAt: "2026-07-09T10:01:00.000Z",
    shields: "block-simulation"
  });
  baseline.verificationFacts = {
    shields: {
      method: "shields-engine-status@1",
      engineLoaded: true,
      applied: false,
      requestsEvaluated: 1,
      requestsMatched: 0,
      requestsActuallyBlocked: 0,
      phaseId: 0
    }
  };
  variant.verificationFacts = {
    shields: {
      method: "shields-engine-status@1",
      engineLoaded: true,
      applied: true,
      requestsEvaluated: 1,
      requestsMatched: 0,
      requestsActuallyBlocked: 0,
      phaseId: 0
    }
  };
  return makeComparison(baseline, variant, {
    kind: "intervention",
    axis: "shields",
    pairId: "pair-shields-r2",
    order: "AB",
    verification: { baseline: makeArm("shields", baseline, 0), variant: makeArm("shields", variant, 0) },
    evidence: { pairs: 1, counterbalanced: false, strength: "observed-difference" }
  });
}

export function makeTemporalReportV2R2(): PublicComparisonReportV2R2 {
  const baseline = makeScanRunV2R2({ runId: "run-earlier-r2", startedAt: "2026-06-18T10:00:00.000Z" });
  const variant = makeScanRunV2R2({ runId: "run-later-r2" });
  return makeComparison(baseline, variant, { kind: "temporal", pairId: "pair-temporal-r2" });
}

export function makeDescriptiveReportV2R2(): PublicComparisonReportV2R2 {
  const baseline = makeScanRunV2R2({ runId: "run-a-r2" });
  const variant = makeScanRunV2R2({ runId: "run-b-r2" });
  return makeComparison(baseline, variant, {
    kind: "descriptive",
    pairId: "pair-descriptive-r2",
    sourceOrder: "as-provided"
  });
}

/**
 * RFC 15.6: an intervention with one complete embedded supporting pair. The
 * experiment evidence follows the r2 derivations (pairs = 1 + supporting,
 * counterbalanced iff orders include AB and BA, strength held at
 * observed-difference unconditionally).
 */
export function makeSupportingPairInterventionReportV2R2(): PublicComparisonReportV2R2 {
  const report = makeShieldsInterventionReportV2R2();
  if (report.experiment.kind !== "intervention") throw new Error("fixture invariant");

  const supportingBaseline = makeScanRunV2R2({
    runId: "run-shields-class-2",
    startedAt: "2026-07-09T11:01:00.000Z",
    shields: "classification"
  });
  const supportingVariant = makeScanRunV2R2({
    runId: "run-shields-sim-2",
    startedAt: "2026-07-09T11:00:00.000Z",
    shields: "block-simulation"
  });
  supportingBaseline.verificationFacts = structuredClone(report.baseline.verificationFacts);
  supportingVariant.verificationFacts = structuredClone(report.variant.verificationFacts);

  const supportingPair: SupportingPairR2 = {
    pairId: "pair-shields-r2-support",
    // BA: the variant ran first chronologically (11:00 before 11:01).
    order: "BA",
    baseline: supportingBaseline,
    variant: supportingVariant,
    verification: {
      baseline: makeArm("shields", supportingBaseline, 0),
      variant: makeArm("shields", supportingVariant, 0)
    }
  };

  return {
    ...report,
    experiment: {
      ...report.experiment,
      supportingPairs: [supportingPair],
      evidence: { pairs: 2, counterbalanced: true, strength: "observed-difference" }
    }
  };
}
