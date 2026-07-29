/**
 * Deterministic ScanReport v2 REVISION 2 fixtures per the accepted r2-a4
 * addendum (docs/scan-report-v2-rfc.md, section 15). Types-and-fixtures slice:
 * these compile against lib/scan-report-v2-r2.ts and seed the next slice's r2
 * validator/evaluator and differential harness; nothing validates or emits
 * them yet.
 *
 * Derived blocks are built with the r2 evaluators, so every fixture is
 * internally consistent by construction and serves as ground truth for the
 * reject-on-disagreement checks.
 */
import { axisStateFor, type ArmVerification, type Experiment } from "./scan-report-v2";
import { buildComparisonDiffV2, evaluateQuality } from "./scan-report-v2-evaluators";
import { evaluateComparabilityR2 } from "./scan-report-v2-r2-evaluators";
import { buildFingerprints } from "./scan-report-v2-fingerprints";
import { makeScanRunV2 } from "./scan-report-v2-fixtures";
import {
  DETECTOR_REGISTRY_DIGEST,
  DETECTOR_REGISTRY_VERSION,
  DETECTOR_VERSIONS
} from "./measurement-kernel";
import { NODE_ADBLOCK_ENGINE_VERSION } from "./legacy-methodology";
import { NODE_SCAN_REPORT_V2_R2_NORMALIZATION_VERSION } from "./scan-report-v2-normalization";
import {
  NODE_R2_CURRENT_ADBLOCK_IDENTITY,
  NODE_SCAN_REPORT_V2_R2_METHODOLOGY_VERSION
} from "./scan-report-v2-r2-producer-contract";
import { trackerCatalogMetadata } from "./tracker-catalog";
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
  run.provenance = {
    ...run.provenance,
    methodologyVersion: NODE_SCAN_REPORT_V2_R2_METHODOLOGY_VERSION,
    detectorRegistry: { version: DETECTOR_REGISTRY_VERSION, digest: DETECTOR_REGISTRY_DIGEST }
  };
  run.toolchain = {
    ...run.toolchain,
    trackerCatalog: {
      source: trackerCatalogMetadata.source,
      version: trackerCatalogMetadata.version,
      entries: trackerCatalogMetadata.entries,
      digest: trackerCatalogMetadata.digest
    },
    adblock:
      run.toolchain.adblock === null
        ? null
        : { ...NODE_R2_CURRENT_ADBLOCK_IDENTITY, engineVersion: NODE_ADBLOCK_ENGINE_VERSION },
    normalizationVersion: NODE_SCAN_REPORT_V2_R2_NORMALIZATION_VERSION
  };
  for (const id of Object.keys(run.detectors) as Array<keyof typeof run.detectors>) {
    run.detectors[id] = { ...run.detectors[id], version: DETECTOR_VERSIONS[id] };
  }
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
  const comparability = evaluateComparabilityR2(evaluatorExperiment, baseline, variant);
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
  // RFC 15.3 summary derivation: present whenever the engine is loaded;
  // classification = requestsMatched, simulation = requestsActuallyBlocked.
  // Explicit zeros here, so the diff carries a real zero delta, never null.
  baseline.summary = { ...baseline.summary, counts: { ...baseline.summary.counts, shieldsBlockedRequests: 0 } };
  variant.summary = { ...variant.summary, counts: { ...variant.summary.counts, shieldsBlockedRequests: 0 } };
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
  supportingBaseline.summary = {
    ...supportingBaseline.summary,
    counts: { ...supportingBaseline.summary.counts, shieldsBlockedRequests: 0 }
  };
  supportingVariant.summary = {
    ...supportingVariant.summary,
    counts: { ...supportingVariant.summary.counts, shieldsBlockedRequests: 0 }
  };

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

// ---------------------------------------------------------------------------
// Consent edge coverage (RFC 15.4/15.5): evaluator ground truth
// ---------------------------------------------------------------------------

/** Zero observations, no transition: derives "unavailable"; the singular
 * compatibility method is the closed placeholder, never a fabricated banner. */
export function makeConsentUnavailableRunR2(): ScanRunV2R2 {
  const run = makeConsentRunR2("reject-all", { runId: "run-consent-unavailable" });
  const consent = run.evidence.consent!;
  consent.interactionAttempted = true;
  consent.controlActivated = false;
  consent.verificationObservations = [];
  delete consent.bannerTransition;
  consent.choiceState = "unavailable";
  consent.reverifiedAfterReload = false;
  return run;
}

/** No interpreter observations; grounded banner disappearance with an
 * activated control derives "weak-signal". */
export function makeWeakSignalConsentRunR2(): ScanRunV2R2 {
  const run = makeConsentRunR2("reject-all", { runId: "run-consent-weak" });
  const consent = run.evidence.consent!;
  consent.verificationObservations = [];
  consent.choiceState = "weak-signal";
  consent.reverifiedAfterReload = false;
  // bannerTransition stays: before visible, after not visible (grounded).
  return run;
}

/** A successful interaction-phase read followed by a reload timeout derives
 * "failed" (RFC 15.4 precedence: verified did not match, a strong timeout is
 * recorded, so this is never "unavailable"). */
export function makeFailedConsentRunR2(): ScanRunV2R2 {
  const run = makeConsentRunR2("reject-all", { runId: "run-consent-failed" });
  const consent = run.evidence.consent!;
  consent.verificationObservations = [
    {
      phaseId: 1,
      method: "onetrust-cookie@1",
      observed: "rejected-all",
      consistentWithChoice: true,
      result: { outcome: "read", sequence: 0 }
    },
    {
      phaseId: 2,
      method: "onetrust-cookie@1",
      observed: null,
      consistentWithChoice: null,
      result: { outcome: "timeout", sequence: 1, errorCode: "api-timeout" }
    }
  ];
  consent.choiceState = "failed";
  consent.reverifiedAfterReload = false;
  return run;
}

/** Contradiction outranks everything: a reject-all run whose interpreter read
 * accepted-all derives "contradicted" even with a later timeout recorded. */
export function makeContradictedConsentRunR2(): ScanRunV2R2 {
  const run = makeConsentRunR2("reject-all", { runId: "run-consent-contradicted" });
  const consent = run.evidence.consent!;
  consent.verificationObservations = [
    {
      phaseId: 1,
      method: "onetrust-cookie@1",
      observed: "accepted-all",
      consistentWithChoice: false,
      result: { outcome: "read", sequence: 0 }
    },
    {
      phaseId: 2,
      method: "onetrust-cookie@1",
      observed: null,
      consistentWithChoice: null,
      result: { outcome: "timeout", sequence: 1, errorCode: "api-timeout" }
    }
  ];
  consent.choiceState = "contradicted";
  consent.reverifiedAfterReload = false;
  return run;
}

/** RFC 15.4: a consent-axis intervention whose arms share one interpreter set. */
export function makeConsentInterventionReportV2R2(): PublicComparisonReportV2R2 {
  const baseline = makeConsentRunR2("accept-all", { runId: "run-consent-accept" });
  const variant = makeConsentRunR2("reject-all", { runId: "run-consent-reject" });
  variant.startedAt = "2026-07-09T10:01:00.000Z"; // not a fingerprint input; no re-mint needed
  const arm = (mode: "accept-all" | "reject-all"): ArmVerification => ({
    axis: "consent",
    expected: `consent:${mode}`,
    observed: `consent:${mode}`,
    method: "onetrust-cookie@1",
    outcome: "passed",
    phaseId: 2
  });
  return makeComparison(baseline, variant, {
    kind: "intervention",
    axis: "consent",
    pairId: "pair-consent-r2",
    order: "AB",
    verification: { baseline: arm("accept-all"), variant: arm("reject-all") },
    evidence: { pairs: 1, counterbalanced: false, strength: "observed-difference" }
  });
}

/** RFC 15.4/15.6: a consent-axis intervention replicated by a supporting pair
 * whose runs share the primary's interpreter set, pass their arms, and run in
 * BA order (so the derived evidence is counterbalanced). */
export function makeConsentSupportingPairReportV2R2(): PublicComparisonReportV2R2 {
  const report = makeConsentInterventionReportV2R2();
  if (report.experiment.kind !== "intervention") throw new Error("fixture invariant");

  const supportingBaseline = makeConsentRunR2("accept-all", {
    runId: "run-consent-accept-2",
    startedAt: "2026-07-09T11:01:00.000Z"
  });
  const supportingVariant = makeConsentRunR2("reject-all", {
    runId: "run-consent-reject-2",
    startedAt: "2026-07-09T11:00:00.000Z"
  });
  const arm = (mode: "accept-all" | "reject-all"): ArmVerification => ({
    axis: "consent",
    expected: `consent:${mode}`,
    observed: `consent:${mode}`,
    method: "onetrust-cookie@1",
    outcome: "passed",
    phaseId: 2
  });

  const supportingPair: SupportingPairR2 = {
    pairId: "pair-consent-r2-support",
    // BA: the reject (variant) run came first chronologically (11:00 < 11:01).
    order: "BA",
    baseline: supportingBaseline,
    variant: supportingVariant,
    verification: { baseline: arm("accept-all"), variant: arm("reject-all") }
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

// ---------------------------------------------------------------------------
// MUST-REJECT mutants for the r2 validator/evaluator slice. Each returns a
// structurally plausible object whose single defect the next slice's
// adversarial harness must catch; they are exported here so the harness and
// the fixtures never drift apart.
// ---------------------------------------------------------------------------

/** Arms whose attempted interpreter sets differ (tcf vs onetrust). The
 * variant's retained arm method is updated too, so the CROSS-ARM set mismatch
 * is the isolated defect, not a stale arm string. */
export function makeInterpreterMismatchMutantR2(): PublicComparisonReportV2R2 {
  const report = makeConsentInterventionReportV2R2();
  const consent = report.variant.evidence.consent!;
  consent.verificationObservations = consent.verificationObservations.map((observation) => ({
    ...observation,
    method: "tcf-api@1"
  }));
  if (report.experiment.kind === "intervention") {
    report.experiment.verification.variant = { ...report.experiment.verification.variant, method: "tcf-api@1" };
  }
  return report;
}

/** Two observations sharing a sequence value. Phase ids 1 and 2 are
 * preserved (sequence uniqueness is GLOBAL within the evidence, RFC 15.4), so
 * choice-state and reload derivations stay intact and the duplicate is the
 * isolated defect. */
export function makeDuplicateSequenceMutantR2(): ScanRunV2R2 {
  const run = makeConsentRunR2("reject-all", { runId: "run-consent-dup-seq" });
  const consent = run.evidence.consent!;
  consent.verificationObservations = consent.verificationObservations.map((observation) => ({
    ...observation,
    result: { outcome: "read", sequence: 0 }
  }));
  return run;
}

/** A result block whose outcome contradicts the observed state (read with
 * observed null). The retained fields are set to what would derive were the
 * observation legitimately null (weak-signal via the grounded transition, no
 * reload verification), so the outcome/observed contradiction is isolated. */
export function makeMalformedResultBlockMutantR2(): ScanRunV2R2 {
  const run = makeConsentRunR2("reject-all", { runId: "run-consent-bad-result" });
  const consent = run.evidence.consent!;
  consent.verificationObservations = [
    {
      phaseId: 1,
      method: "onetrust-cookie@1",
      observed: null,
      consistentWithChoice: null,
      result: { outcome: "read", sequence: 0 }
    }
  ];
  consent.choiceState = "weak-signal";
  consent.reverifiedAfterReload = false;
  return run;
}

/** A duplicate before-interaction moment beside an otherwise valid
 * before/after pair: the duplicate is the isolated defect. */
export function makeDuplicateBannerMomentMutantR2(): ScanRunV2R2 {
  const run = makeConsentRunR2("reject-all", { runId: "run-consent-dup-banner" });
  const consent = run.evidence.consent!;
  consent.bannerTransition = {
    method: "banner-visibility@1",
    observations: [
      { moment: "before-interaction", phaseId: 1, atMs: 2100, visible: true },
      { moment: "before-interaction", phaseId: 1, atMs: 2200, visible: true },
      { moment: "after-interaction", phaseId: 1, atMs: 2900, visible: false }
    ]
  };
  return run;
}

/** Unique moments whose in-span timestamps are inverted: chronology is the
 * isolated defect. */
export function makeInvertedBannerChronologyMutantR2(): ScanRunV2R2 {
  const run = makeConsentRunR2("reject-all", { runId: "run-consent-inverted-banner" });
  const consent = run.evidence.consent!;
  consent.bannerTransition = {
    method: "banner-visibility@1",
    observations: [
      { moment: "before-interaction", phaseId: 1, atMs: 2900, visible: true },
      { moment: "after-interaction", phaseId: 1, atMs: 2100, visible: false }
    ]
  };
  return run;
}

/** An observation missing its r2 result block: structurally optional but
 * semantically mandatory whenever an observation exists (RFC 15.4). */
export function makeMissingResultMutantR2(): ScanRunV2R2 {
  const run = makeConsentRunR2("reject-all", { runId: "run-consent-missing-result" });
  const consent = run.evidence.consent!;
  const stripped = { ...consent.verificationObservations[1] };
  delete stripped.result;
  consent.verificationObservations = [consent.verificationObservations[0], stripped];
  return run;
}

/** GPC facts claiming confirmed states from a phase with NO observed eligible
 * first-party navigation (the run's only document request becomes a script;
 * counts, quality, and diff are unaffected, so the missing navigation is the
 * isolated defect). RFC 15.3: without one, both signals are "unobservable". */
export function makeGpcUnobservedNavigationMutantR2(): PublicComparisonReportV2R2 {
  const report = makeGpcInterventionReportV2R2();
  report.variant.evidence.requests = report.variant.evidence.requests.map((request) => ({
    ...request,
    resourceType: "script"
  }));
  return report;
}

/** A consent-mode run with observations but NO consent-interaction phase: the
 * observation phases collapse to passive-load + post-choice-reload. Built from
 * the zero-observation run so the missing phase is the isolated defect (with
 * observations present, every phase-tag rule would fire too). */
export function makeConsentWithoutInteractionPhaseMutantR2(): ScanRunV2R2 {
  const run = makeConsentUnavailableRunR2();
  run.phases = [{ phaseId: 0, kind: "passive-load", startedAtMs: 0, endedAtMs: 5000 }];
  return run;
}

/** A supporting pair whose variant run did not complete (HTTP 500 recorded in
 * the quality facts and honestly derived through evaluateQuality, so the
 * incomplete run is the isolated defect, never a quality-derivation
 * disagreement). RFC 15.6: supporting pairs pass the SAME completeness gate
 * as the primary. */
export function makeSupportingPairIncompleteRunMutantR2(): PublicComparisonReportV2R2 {
  const report = makeSupportingPairInterventionReportV2R2();
  if (report.experiment.kind !== "intervention") throw new Error("fixture invariant");
  const pair = report.experiment.supportingPairs![0];
  pair.variant.qualityFacts = { ...pair.variant.qualityFacts, status: 500 };
  pair.variant.summary = { ...pair.variant.summary, status: 500 };
  pair.variant.quality = evaluateQuality(pair.variant.qualityFacts, {
    observedRequests: pair.variant.evidence.requests.length
  });
  return report;
}

/** A consent supporting pair whose VARIANT run attempted a different strong
 * interpreter than the primary (its arm strings are updated to what its own
 * observations derive, so the cross-pair set mismatch is the isolated
 * defect). RFC 15.4: every supporting run's set must equal the primary's. */
export function makeSupportingPairInterpreterParityMutantR2(): PublicComparisonReportV2R2 {
  const report = makeConsentSupportingPairReportV2R2();
  if (report.experiment.kind !== "intervention") throw new Error("fixture invariant");
  const pair = report.experiment.supportingPairs![0];
  const consent = pair.variant.evidence.consent!;
  consent.verificationObservations = consent.verificationObservations.map((observation) => ({
    ...observation,
    method: "tcf-api@1"
  }));
  pair.verification.variant = { ...pair.verification.variant, method: "tcf-api@1" };
  return report;
}
