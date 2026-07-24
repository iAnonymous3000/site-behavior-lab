import assert from "node:assert/strict";
import { test } from "node:test";
import {
  analyzeRepeatedEffects,
  REPEATED_EFFECT_ANALYSIS_VERSION,
  type RepeatedEffectMetricId
} from "./repeated-effect-analysis";
import { buildComparisonDiffV2, evaluateQuality } from "./scan-report-v2-evaluators";
import { evaluateComparabilityR2 } from "./scan-report-v2-r2-evaluators";
import {
  makeGpcInterventionReportV2R2,
  makePublicSingleReportV2R2,
  makeSupportingPairInterventionReportV2R2,
  makeTemporalReportV2R2
} from "./scan-report-v2-r2-fixtures";
import type { PublicComparisonReportV2R2, ScanRunV2R2 } from "./scan-report-v2-r2";
import { readStoredScanReport } from "./scan-report-reader";

test("repeated effects stay metric-scoped, descriptive, and explicit about the pair denominator", () => {
  const report = makeSupportingPairInterventionReportV2R2();
  addThirdPartyRequests(report.variant, 2, "primary-variant");
  const support = supportingPair(report);
  addThirdPartyRequests(support.variant, 3, "support-variant");
  rebuildPrimaryDiff(report);
  assert.equal(readStoredScanReport(report).ok, true, "test artifact remains validator-clean");

  const analysis = analyzeRepeatedEffects(report);
  assert.equal(analysis.analysisVersion, REPEATED_EFFECT_ANALYSIS_VERSION);
  assert.equal(analysis.status, "descriptive-only");
  assert.deepEqual(analysis.pairDenominator, {
    recordedPairs: 2,
    abPairs: 1,
    baPairs: 1,
    counterbalanced: true
  });
  const metric = byMetric(analysis, "raw.thirdPartyRequests");
  assert.equal(metric.status, "descriptive-only");
  assert.deepEqual(metric.denominator, {
    recordedPairs: 2,
    eligiblePairs: 2,
    excludedPairs: 0,
    positiveEffects: 2,
    negativeEffects: 0,
    zeroEffects: 0
  });
  assert.deepEqual(metric.pairs.map((pair) => pair.delta), [2, 3]);
  assert.deepEqual(metric.descriptive, {
    arithmeticMeanDelta: 2.5,
    medianDelta: 2.5,
    minimumDelta: 2,
    maximumDelta: 3,
    pattern: "same-direction-nonzero",
    repeatedDirectionalObservation: true
  });
  assert.deepEqual(metric.uncertainty.observedEffectRange, { minimum: 2, maximum: 3 });
  assert.equal(metric.uncertainty.confidenceInterval, null);
  assert.match(metric.uncertainty.reason, /no-sampling-frame/);
  assert.equal(analysis.inference.replicatedEffectClaimAllowed, false);
  assert.equal(analysis.inference.causalClaimAllowed, false);
  assert.equal(analysis.inference.populationEffect, null);
});

test("opposite directions and zero effects never satisfy the descriptive repeat pattern", () => {
  const opposite = makeSupportingPairInterventionReportV2R2();
  addThirdPartyRequests(opposite.variant, 2, "primary-up");
  addThirdPartyRequests(supportingPair(opposite).baseline, 3, "support-down");
  rebuildPrimaryDiff(opposite);
  assert.equal(readStoredScanReport(opposite).ok, true);
  const oppositeMetric = byMetric(analyzeRepeatedEffects(opposite), "raw.thirdPartyRequests");
  assert.equal(oppositeMetric.descriptive?.pattern, "opposite-directions");
  assert.equal(oppositeMetric.descriptive?.repeatedDirectionalObservation, false);

  const zero = makeSupportingPairInterventionReportV2R2();
  const zeroMetric = byMetric(analyzeRepeatedEffects(zero), "raw.thirdPartyRequests");
  assert.equal(zeroMetric.descriptive?.pattern, "all-zero");
  assert.equal(zeroMetric.descriptive?.repeatedDirectionalObservation, false);
});

test("one censored supporting pair fails the entire metric denominator closed", () => {
  const report = makeSupportingPairInterventionReportV2R2();
  const censoredRun = supportingPair(report).variant;
  censoredRun.qualityFacts.captureLoss.push({
    family: "requests",
    phaseId: 0,
    kind: "dropped",
    count: 1,
    detail: "repeated-effect-test-loss"
  });
  censoredRun.quality = evaluateQuality(censoredRun.qualityFacts, {
    observedRequests: censoredRun.evidence.requests.length
  });
  assert.equal(readStoredScanReport(report).ok, true, "family censorship remains an honest validator-clean wire");

  const analysis = analyzeRepeatedEffects(report);
  assert.equal(analysis.status, "ineligible");
  assert.equal(analysis.reasons.includes("one-or-more-metrics-ineligible"), true);
  const metric = byMetric(analysis, "raw.thirdPartyRequests");
  assert.equal(metric.status, "ineligible");
  assert.equal(metric.denominator.recordedPairs, 2);
  assert.equal(metric.denominator.eligiblePairs, 1);
  assert.equal(metric.denominator.excludedPairs, 1);
  assert.equal(metric.pairs[1].delta, null);
  assert.equal(metric.pairs[1].reasons.includes("family-censored:variant"), true);
  assert.equal(metric.descriptive, null, "the eligible subset is never promoted to an aggregate");
  assert.equal(metric.uncertainty.observedEffectRange, null);
});

test("an unverified primary intervention suppresses every repeated effect", () => {
  const report = makeSupportingPairInterventionReportV2R2();
  if (report.experiment.kind !== "intervention") throw new Error("fixture invariant");
  const facts = report.variant.verificationFacts?.shields;
  if (!facts) throw new Error("fixture invariant");
  facts.applied = false;
  report.experiment.verification.variant = {
    ...report.experiment.verification.variant,
    observed: "shields:classification",
    outcome: "failed"
  };
  const { supportingPairs: _supportingPairs, ...primaryExperiment } = report.experiment;
  report.comparability = evaluateComparabilityR2(primaryExperiment, report.baseline, report.variant);
  rebuildPrimaryDiff(report);
  assert.equal(readStoredScanReport(report).ok, true, "failed verification is an honest validator-clean outcome");

  const analysis = analyzeRepeatedEffects(report);
  assert.equal(analysis.status, "ineligible");
  const metric = byMetric(analysis, "raw.thirdPartyRequests");
  assert.equal(metric.status, "ineligible");
  assert.equal(metric.pairs[0].reasons.includes("intervention-unverified"), true);
  assert.equal(metric.pairs[0].delta, null);
  assert.equal(metric.descriptive, null);
});

test("a single pair is insufficient and consent is named as a non-numeric frozen endpoint", () => {
  const analysis = analyzeRepeatedEffects(makeGpcInterventionReportV2R2());
  assert.equal(analysis.status, "insufficient-pairs");
  assert.deepEqual(analysis.reasons.includes("requires-at-least-two-pairs"), true);
  assert.equal(byMetric(analysis, "raw.totalRequests").status, "insufficient-pairs");
  assert.deepEqual(analysis.nonNumericFamilies, [
    { family: "consent-verification", reason: "no-frozen-r2-numeric-endpoint" }
  ]);
});

test("invalid, older, single, and non-intervention wires are never best-effort analyzed", () => {
  assert.deepEqual(analyzeRepeatedEffects({ schemaVersion: 3 }).reasons, ["wire-unsupported-version"]);

  const r1Shape = structuredClone(makeGpcInterventionReportV2R2()) as unknown as Record<string, unknown>;
  r1Shape.schemaRevision = 1;
  assert.equal(analyzeRepeatedEffects(r1Shape).status, "not-analyzable");

  assert.deepEqual(analyzeRepeatedEffects(makePublicSingleReportV2R2()).reasons, ["requires-comparison-report"]);
  assert.deepEqual(analyzeRepeatedEffects(makeTemporalReportV2R2()).reasons, ["requires-intervention-experiment"]);
});

function byMetric(
  analysis: ReturnType<typeof analyzeRepeatedEffects>,
  id: RepeatedEffectMetricId
) {
  const metric = analysis.metrics.find((entry) => entry.metric === id);
  assert.notEqual(metric, undefined, `missing metric ${id}`);
  return metric!;
}

function supportingPair(report: PublicComparisonReportV2R2) {
  if (report.experiment.kind !== "intervention") throw new Error("fixture invariant");
  const pair = report.experiment.supportingPairs?.[0];
  if (!pair) throw new Error("fixture invariant");
  return pair;
}

function addThirdPartyRequests(run: ScanRunV2R2, count: number, prefix: string): void {
  const maxId = run.evidence.requests.reduce((maximum, request) => Math.max(maximum, request.id), 0);
  for (let index = 0; index < count; index += 1) {
    const domain = `${prefix}-${index}.example.net`;
    run.evidence.requests.push({
      id: maxId + index + 1,
      url: `https://${domain}/asset/{seg}`,
      domain,
      method: "GET",
      resourceType: "script",
      status: 200,
      thirdParty: true,
      tracker: null,
      startedAtMs: 100 + index,
      phaseId: 0
    });
  }
  const requests = run.evidence.requests;
  run.summary.counts = {
    ...run.summary.counts,
    totalRequests: requests.length,
    thirdPartyRequests: requests.filter((request) => request.thirdParty).length,
    knownTrackerRequests: requests.filter((request) => request.tracker !== null).length,
    thirdPartyDomains: new Set(requests.filter((request) => request.thirdParty).map((request) => request.domain)).size
  };
  run.summary.countsByPhase = run.phases.map((phase) => {
    const inPhase = requests.filter((request) => request.phaseId === phase.phaseId);
    return {
      phaseId: phase.phaseId,
      totalRequests: inPhase.length,
      thirdPartyRequests: inPhase.filter((request) => request.thirdParty).length,
      knownTrackerRequests: inPhase.filter((request) => request.tracker !== null).length
    };
  });
}

function rebuildPrimaryDiff(report: PublicComparisonReportV2R2): void {
  report.diff = buildComparisonDiffV2(report.baseline, report.variant, report.comparability.perMetric);
}
