/**
 * Types-and-fixtures slice for v2 REVISION 2 (r2-a4, RFC section 15). The r2
 * validator/evaluator arrive in the next slice; these tests pin what this
 * slice guarantees: the fixture corpus is well-formed against the a4 rules it
 * can express, every producer still emits legacy v1, and the frozen r1 schema
 * hash is asserted permanently (scan-report-schema-parity.test.ts).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createGpcComparisonReport } from "./compare-reports";
import { SCAN_REPORT_SCHEMA_VERSION, type ScanResult } from "./types";
import { SCAN_REPORT_V2_SCHEMA_REVISION } from "./scan-report-v2";
import { SCAN_REPORT_V2_SCHEMA_REVISION_2 } from "./scan-report-v2-r2";
import { makeScanReportV1 } from "./scan-report-v2-fixtures";
import {
  makeConsentSingleReportV2R2,
  makeDescriptiveReportV2R2,
  makeGpcInterventionReportV2R2,
  makePublicSingleReportV2R2,
  makeShieldsInterventionReportV2R2,
  makeSupportingPairInterventionReportV2R2,
  makeTemporalReportV2R2
} from "./scan-report-v2-r2-fixtures";

test("r2 fixtures declare revision 2 and r1's constant is untouched", () => {
  assert.equal(SCAN_REPORT_V2_SCHEMA_REVISION, 1);
  assert.equal(SCAN_REPORT_V2_SCHEMA_REVISION_2, 2);
  const fixtures = [
    makePublicSingleReportV2R2(),
    makeConsentSingleReportV2R2(),
    makeGpcInterventionReportV2R2(),
    makeShieldsInterventionReportV2R2(),
    makeTemporalReportV2R2(),
    makeDescriptiveReportV2R2(),
    makeSupportingPairInterventionReportV2R2()
  ];
  for (const fixture of fixtures) {
    assert.equal(fixture.schemaVersion, 2);
    assert.equal(fixture.schemaRevision, 2);
  }
});

test("consent r2 fixture carries result blocks ordered by (phaseId, sequence)", () => {
  const consent = makeConsentSingleReportV2R2().run.evidence.consent;
  assert.notEqual(consent, undefined);
  const observations = consent!.verificationObservations;
  assert.equal(observations.length > 0, true);
  for (const observation of observations) {
    assert.notEqual(observation.result, undefined, "every present r2 observation carries its result block");
    assert.equal(observation.result!.outcome === "read", observation.observed !== null);
  }
  const ordered = [...observations].sort((a, b) => a.phaseId - b.phaseId || a.result!.sequence - b.result!.sequence);
  assert.deepEqual(observations, ordered);
  // Grounded transition: one before + one after, strictly increasing timestamps.
  const moments = consent!.bannerTransition!.observations.map((entry) => entry.moment);
  assert.deepEqual(moments, ["before-interaction", "after-interaction", "after-reload"]);
  const times = consent!.bannerTransition!.observations.map((entry) => entry.atMs);
  assert.equal(times[0] < times[1] && times[1] < times[2], true);
});

test("intervention r2 fixtures carry structured facts for their axis on both runs", () => {
  const gpc = makeGpcInterventionReportV2R2();
  assert.notEqual(gpc.baseline.verificationFacts?.gpc, undefined);
  assert.notEqual(gpc.variant.verificationFacts?.gpc, undefined);
  assert.equal(gpc.baseline.verificationFacts!.gpc!.observedOn, "first-party-navigation");

  const shields = makeShieldsInterventionReportV2R2();
  for (const run of [shields.baseline, shields.variant]) {
    const facts = run.verificationFacts?.shields;
    assert.notEqual(facts, undefined);
    assert.equal(facts!.requestsActuallyBlocked <= facts!.requestsMatched, true);
    assert.equal(facts!.requestsMatched <= facts!.requestsEvaluated, true);
    assert.equal(facts!.requestsEvaluated > 0, true, "nonzero exercise (15.3)");
  }
});

test("the supporting-pair fixture obeys the a4 uniqueness, order, and evidence rules", () => {
  const report = makeSupportingPairInterventionReportV2R2();
  assert.equal(report.experiment.kind, "intervention");
  if (report.experiment.kind !== "intervention") return;
  const pairs = report.experiment.supportingPairs!;
  assert.equal(pairs.length, 1);

  const pairIds = new Set([report.experiment.pairId, ...pairs.map((pair) => pair.pairId)]);
  assert.equal(pairIds.size, 2, "pairIds unique across the report");
  const runIds = new Set(
    [report.baseline, report.variant, ...pairs.flatMap((pair) => [pair.baseline, pair.variant])].map((run) => run.runId)
  );
  assert.equal(runIds.size, 4, "runIds unique across ALL runs");

  const support = pairs[0];
  // BA order: the variant ran first chronologically (per-pair chronology rule).
  assert.equal(support.order, "BA");
  assert.equal(support.variant.startedAt < support.baseline.startedAt, true);
  // Condition fingerprints match the primary per arm (15.6).
  assert.equal(support.baseline.fingerprints.condition, report.baseline.fingerprints.condition);
  assert.equal(support.variant.fingerprints.condition, report.variant.fingerprints.condition);
  // Derived evidence per 15.6: 1 + supporting, AB+BA => counterbalanced,
  // strength held at observed-difference unconditionally.
  assert.deepEqual(report.experiment.evidence, { pairs: 2, counterbalanced: true, strength: "observed-difference" });
});

test("every producer still emits legacy v1", () => {
  // The comparison producer, exercised for real. The fixture is a v1 single
  // report; the cast narrows the ScanReport union for the producer's input.
  const v1Single = makeScanReportV1() as ScanResult;
  const comparison = createGpcComparisonReport(structuredClone(v1Single), structuredClone(v1Single)) as unknown as Record<
    string,
    unknown
  >;
  assert.equal(comparison.schemaVersion, SCAN_REPORT_SCHEMA_VERSION);
  assert.equal(comparison.schemaVersion, 1);
  assert.equal("schemaRevision" in comparison, false, "v1 wire has no revision field");
  // The single-report wire constant every producer stamps.
  assert.equal(SCAN_REPORT_SCHEMA_VERSION, 1);
  assert.equal((v1Single as Record<string, unknown>).schemaVersion, 1);
});
