/**
 * Types-and-fixtures slice for v2 REVISION 2 (r2-a4, RFC section 15). The r2
 * validator/evaluator arrive in the next slice; these tests pin what this
 * slice guarantees: the fixture corpus is well-formed against the a4 rules it
 * can express, every producer still emits legacy v1, and the frozen r1 schema
 * hash is asserted permanently (scan-report-schema-parity.test.ts).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createGpcComparisonReport } from "./compare-reports";
import { buildScanConditions, buildScanResult } from "./scan-result-builder";
import { SCAN_REPORT_SCHEMA_VERSION, type ScanResult } from "./types";
import { SCAN_REPORT_V2_SCHEMA_REVISION } from "./scan-report-v2";
import { SCAN_REPORT_V2_SCHEMA_REVISION_2 } from "./scan-report-v2-r2";
import { makeScanReportV1 } from "./scan-report-v2-fixtures";
import {
  makeConsentInterventionReportV2R2,
  makeConsentSingleReportV2R2,
  makeConsentUnavailableRunR2,
  makeContradictedConsentRunR2,
  makeDescriptiveReportV2R2,
  makeDuplicateSequenceMutantR2,
  makeFailedConsentRunR2,
  makeDuplicateBannerMomentMutantR2,
  makeGpcInterventionReportV2R2,
  makeInterpreterMismatchMutantR2,
  makeInvertedBannerChronologyMutantR2,
  makeMalformedResultBlockMutantR2,
  makeMissingResultMutantR2,
  makePublicSingleReportV2R2,
  makeShieldsInterventionReportV2R2,
  makeSupportingPairInterventionReportV2R2,
  makeTemporalReportV2R2,
  makeWeakSignalConsentRunR2
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
  // RFC 15.3 summary derivation: present when the engine is loaded, so the
  // Shields diff is a REAL zero delta, never null (evaluator ground truth).
  assert.equal(shields.baseline.summary.counts.shieldsBlockedRequests, 0);
  assert.equal(shields.variant.summary.counts.shieldsBlockedRequests, 0);
  assert.deepEqual(shields.diff.families["shields-simulation"].metrics, {
    shieldsBlockedRequests: { baseline: 0, variant: 0, delta: 0 }
  });
  const supported = makeSupportingPairInterventionReportV2R2();
  if (supported.experiment.kind === "intervention") {
    for (const pair of supported.experiment.supportingPairs!) {
      assert.equal(pair.baseline.summary.counts.shieldsBlockedRequests, 0);
      assert.equal(pair.variant.summary.counts.shieldsBlockedRequests, 0);
    }
  }
});

test("consent edge fixtures pin the a4 derivations for the evaluator slice", () => {
  const unavailable = makeConsentUnavailableRunR2().evidence.consent!;
  assert.equal(unavailable.choiceState, "unavailable");
  assert.equal(unavailable.verificationObservations.length, 0);
  assert.equal(unavailable.bannerTransition, undefined);

  const weak = makeWeakSignalConsentRunR2().evidence.consent!;
  assert.equal(weak.choiceState, "weak-signal");
  assert.equal(weak.verificationObservations.length, 0);
  assert.equal(weak.controlActivated, true);
  const moments = weak.bannerTransition!.observations.filter((entry) => entry.moment !== "after-reload");
  assert.deepEqual(moments.map((entry) => entry.visible), [true, false], "grounded disappearance");

  const failed = makeFailedConsentRunR2().evidence.consent!;
  assert.equal(failed.choiceState, "failed");
  assert.equal(failed.verificationObservations[0].result!.outcome, "read");
  assert.equal(failed.verificationObservations[1].result!.outcome, "timeout");
  assert.equal(failed.reverifiedAfterReload, false);

  const contradicted = makeContradictedConsentRunR2().evidence.consent!;
  assert.equal(contradicted.choiceState, "contradicted", "contradiction outranks the recorded timeout");
  assert.equal(contradicted.verificationObservations[0].consistentWithChoice, false);

  const intervention = makeConsentInterventionReportV2R2();
  assert.equal(intervention.experiment.kind, "intervention");
  const interpreterSet = (run: typeof intervention.baseline) =>
    [...new Set(run.evidence.consent!.verificationObservations.map((entry) => entry.method))].sort();
  assert.deepEqual(interpreterSet(intervention.baseline), interpreterSet(intervention.variant));
});

test("the MUST-REJECT mutants each carry exactly their intended defect", () => {
  const mismatch = makeInterpreterMismatchMutantR2();
  const methods = (run: typeof mismatch.baseline) =>
    [...new Set(run.evidence.consent!.verificationObservations.map((entry) => entry.method))].sort();
  assert.notDeepEqual(methods(mismatch.baseline), methods(mismatch.variant));
  if (mismatch.experiment.kind === "intervention") {
    // The retained arm agrees with its own observations: the cross-arm set
    // mismatch is the isolated defect.
    assert.equal(mismatch.experiment.verification.variant.method, "tcf-api@1");
  }

  const duplicate = makeDuplicateSequenceMutantR2().evidence.consent!;
  const sequences = duplicate.verificationObservations.map((entry) => entry.result!.sequence);
  assert.notEqual(new Set(sequences).size, sequences.length, "GLOBAL sequence uniqueness violated");
  assert.deepEqual(duplicate.verificationObservations.map((entry) => entry.phaseId), [1, 2], "phases preserved");

  const malformed = makeMalformedResultBlockMutantR2().evidence.consent!;
  const bad = malformed.verificationObservations[0];
  assert.equal(bad.result!.outcome, "read");
  assert.equal(bad.observed, null, "read outcome contradicting a null observation");
  assert.equal(malformed.choiceState, "weak-signal", "retained fields at their legitimate fallback");
  assert.equal(malformed.reverifiedAfterReload, false);

  const duplicateBanner = makeDuplicateBannerMomentMutantR2().evidence.consent!.bannerTransition!;
  const bannerMoments = duplicateBanner.observations.map((entry) => entry.moment);
  assert.notEqual(new Set(bannerMoments).size, bannerMoments.length, "duplicate moment");
  const times = duplicateBanner.observations.map((entry) => entry.atMs);
  assert.deepEqual([...times].sort((a, b) => a - b), times, "chronology stays valid in the duplicate mutant");

  const inverted = makeInvertedBannerChronologyMutantR2().evidence.consent!.bannerTransition!;
  assert.equal(new Set(inverted.observations.map((entry) => entry.moment)).size, inverted.observations.length);
  assert.equal(inverted.observations[0].atMs > inverted.observations[1].atMs, true, "inverted chronology only");

  const missing = makeMissingResultMutantR2().evidence.consent!;
  assert.equal(missing.verificationObservations[0].result !== undefined, true);
  assert.equal(missing.verificationObservations[1].result, undefined, "one observation missing its result block");
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

test("every producer lane still emits legacy v1", () => {
  assert.equal(SCAN_REPORT_SCHEMA_VERSION, 1);

  // The shared Node builder, exercised for real across all three condition
  // profiles it serves (Node scanner, Cloudflare Browser Run worker, and the
  // PageGraph import all stamp their wire through buildScanResult).
  for (const profile of ["node-playwright", "cloudflare-browser-run", "brave-pagegraph"] as const) {
    const conditions = buildScanConditions({
      profile,
      requestedUrl: "https://example.com/",
      finalUrl: "https://example.com/",
      scannedAt: "2026-07-10T00:00:00.000Z",
      chromiumVersion: "test",
      userAgent: "test",
      viewport: { width: 1440, height: 980, isMobile: false },
      gpcEnabled: false,
      consentMode: "observe"
    });
    const built = buildScanResult({
      pageTitle: "",
      status: 200,
      durationMs: 1,
      firstPartyDomain: "example.com",
      conditions,
      requests: [],
      cookies: [],
      storage: [],
      fingerprintEvents: [],
      screenshot: null,
      warnings: []
    }) as unknown as Record<string, unknown>;
    assert.equal(built.schemaVersion, 1, `builder profile ${profile}`);
    assert.equal("schemaRevision" in built, false, `builder profile ${profile}`);
  }

  // The comparison producer, exercised for real.
  const v1Single = makeScanReportV1() as ScanResult;
  const comparison = createGpcComparisonReport(structuredClone(v1Single), structuredClone(v1Single)) as unknown as Record<
    string,
    unknown
  >;
  assert.equal(comparison.schemaVersion, 1);
  assert.equal("schemaRevision" in comparison, false, "v1 wire has no revision field");

  // The independently hard-coded CI publication lane cannot be imported (it is
  // an executable script), so its pinned literal is asserted at source level.
  const ciScanSource = readFileSync(path.join(process.cwd(), "scripts", "run-ci-scan.mjs"), "utf8");
  assert.equal(ciScanSource.includes("const scanReportSchemaVersion = 1"), true);
  assert.equal(ciScanSource.includes("schemaRevision"), false);
});
