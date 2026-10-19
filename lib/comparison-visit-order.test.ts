import assert from "node:assert/strict";
import { test } from "node:test";
import {
  comparisonOrderDisclosure,
  createGpcComparisonReport,
  createShieldsComparisonReport,
  createTemporalComparisonReport
} from "./compare-reports";
import { comparisonVisitOrder, comparisonVisitOrderLine, type ComparisonVisitOrder } from "./comparison-visit-order";
import {
  makeDescriptiveComparisonReportV2,
  makeInterventionComparisonReportV2,
  makeScanReportV1,
  makeTemporalComparisonReportV2
} from "./scan-report-v2-fixtures";
import {
  makeDescriptiveReportV2R2,
  makeGpcInterventionReportV2R2,
  makeTemporalReportV2R2
} from "./scan-report-v2-r2-fixtures";
import { viewFromV1Report, viewFromV2, type ReportView } from "./scan-report-views";
import type { ComparisonScanResult, ScanResult } from "./types";

const EARLIER = "2026-08-01T10:00:00.000Z";
const LATER = "2026-08-01T10:01:00.000Z";

function v1Run(scannedAt: string): ScanResult {
  const run = makeScanReportV1() as ScanResult;
  run.conditions = { ...run.conditions, scannedAt };
  return run;
}

function visitOrderOf(view: ReportView): ComparisonVisitOrder {
  assert.ok(view.comparison, "expected a comparison view");
  return view.comparison.visitOrder;
}

function lineOf(view: ReportView) {
  assert.ok(view.comparison, "expected a comparison view");
  return comparisonVisitOrderLine(view.comparison.visitOrder, view.comparison.runLabels);
}

test("a recorded order stands unless the start times contradict it", () => {
  const order = (recordedFirst: "baseline" | "variant" | null, baselineStartedAt: string | null, variantStartedAt: string | null) =>
    comparisonVisitOrder({ temporalPair: false, recordedFirst, baselineStartedAt, variantStartedAt });

  assert.deepEqual(order("baseline", EARLIER, LATER), { state: "recorded", first: "baseline" });
  assert.deepEqual(order("variant", LATER, EARLIER), { state: "recorded", first: "variant" });
  // Start times that order nothing cannot contradict the record.
  assert.deepEqual(order("variant", EARLIER, EARLIER), { state: "recorded", first: "variant" });
  assert.deepEqual(order("variant", null, EARLIER), { state: "recorded", first: "variant" });
  assert.deepEqual(order("variant", "not a time", EARLIER), { state: "recorded", first: "variant" });
  // A record the start times contradict is stated neither way.
  assert.deepEqual(order("baseline", LATER, EARLIER), { state: "not-recorded", startedFirst: null });
  assert.deepEqual(order("variant", EARLIER, LATER), { state: "not-recorded", startedFirst: null });
});

test("without a record, the start times order the visits only when they strictly differ", () => {
  const order = (baselineStartedAt: string | null, variantStartedAt: string | null) =>
    comparisonVisitOrder({ temporalPair: false, recordedFirst: null, baselineStartedAt, variantStartedAt });

  assert.deepEqual(order(EARLIER, LATER), { state: "not-recorded", startedFirst: "baseline" });
  assert.deepEqual(order(LATER, EARLIER), { state: "not-recorded", startedFirst: "variant" });
  assert.deepEqual(order(EARLIER, EARLIER), { state: "not-recorded", startedFirst: null });
  assert.deepEqual(order(null, LATER), { state: "not-recorded", startedFirst: null });
  assert.deepEqual(order(EARLIER, ""), { state: "not-recorded", startedFirst: null });
  assert.deepEqual(order("not a time", LATER), { state: "not-recorded", startedFirst: null });
});

test("a temporal pair states no order, even one that carries a record", () => {
  for (const recordedFirst of [null, "baseline", "variant"] as const) {
    assert.deepEqual(
      comparisonVisitOrder({ temporalPair: true, recordedFirst, baselineStartedAt: EARLIER, variantStartedAt: LATER }),
      { state: "not-applicable" }
    );
  }
});

test("each state renders its line in the display labels, without calling the pair randomized", () => {
  const labels = { baseline: "No blocking", variant: "Brave-list blocking" };
  const lines = [
    comparisonVisitOrderLine({ state: "recorded", first: "variant" }, labels),
    comparisonVisitOrderLine({ state: "recorded", first: "baseline" }, labels),
    comparisonVisitOrderLine({ state: "not-recorded", startedFirst: "baseline" }, labels),
    comparisonVisitOrderLine({ state: "not-recorded", startedFirst: null }, labels)
  ];
  assert.deepEqual(lines, [
    { text: "Ran first: Brave-list blocking", seeMethodology: false },
    { text: "Ran first: No blocking", seeMethodology: false },
    { text: "Started first: No blocking; order not recorded", seeMethodology: true },
    { text: "Order not recorded", seeMethodology: true }
  ]);
  for (const line of lines) assert.doesNotMatch(line?.text ?? "", /randomi[sz]|counterbalanc/i);
  assert.equal(comparisonVisitOrderLine({ state: "not-applicable" }, labels), null);
});

test("a v1 view reads the producer's order sentence for either arm, and keeps the structured order null", () => {
  const variantFirst = viewFromV1Report(createGpcComparisonReport(v1Run(LATER), v1Run(EARLIER), { executedFirst: "variant" }));
  assert.deepEqual(visitOrderOf(variantFirst), { state: "recorded", first: "variant" });
  assert.deepEqual(lineOf(variantFirst), { text: "Ran first: GPC on", seeMethodology: false });
  assert.equal(variantFirst.comparison?.order, null);

  const baselineFirst = viewFromV1Report(
    createShieldsComparisonReport(v1Run(EARLIER), v1Run(LATER), { executedFirst: "baseline" })
  );
  assert.deepEqual(visitOrderOf(baselineFirst), { state: "recorded", first: "baseline" });
  assert.deepEqual(lineOf(baselineFirst), { text: "Ran first: No blocking", seeMethodology: false });
  assert.equal(baselineFirst.comparison?.order, null);
});

test("a v1 order sentence is matched against the wire labels and rendered in the display labels", () => {
  // Older Shields reports carry the wire labels "Shields off"/"Shields on",
  // which the view displays as the block-simulation labels. The sentence
  // names the WIRE label, so it is matched against that and rendered with the
  // display label of the same arm.
  const legacyLabels = { baseline: "Shields off", variant: "Shields on" };
  const legacy = createShieldsComparisonReport(v1Run(LATER), v1Run(EARLIER));
  legacy.runLabels = legacyLabels;
  legacy.warnings = [legacy.warnings[0], comparisonOrderDisclosure(legacyLabels, "variant")];
  const view = viewFromV1Report(legacy);
  assert.deepEqual(view.comparison?.runLabels, { baseline: "No blocking", variant: "Brave-list blocking" });
  assert.deepEqual(visitOrderOf(view), { state: "recorded", first: "variant" });
  assert.deepEqual(lineOf(view), { text: "Ran first: Brave-list blocking", seeMethodology: false });

  // A sentence naming the display label instead is not the producer's record.
  legacy.warnings = [legacy.warnings[0], comparisonOrderDisclosure({ baseline: "No blocking", variant: "Brave-list blocking" }, "variant")];
  assert.deepEqual(visitOrderOf(viewFromV1Report(legacy)), { state: "not-recorded", startedFirst: "variant" });
});

test("a v1 order sentence that names no single arm exactly leaves the order unrecorded", () => {
  const withWarnings = (report: ComparisonScanResult, warnings: string[]): ComparisonScanResult => ({ ...report, warnings });
  const recorded = createGpcComparisonReport(v1Run(EARLIER), v1Run(LATER), { executedFirst: "baseline" });
  const sentence = comparisonOrderDisclosure(recorded.runLabels!, "baseline");
  const unrecorded = { state: "not-recorded", startedFirst: "baseline" };

  // Exact match only: a prefixed, re-spaced, or foreign-label copy is not the record.
  for (const lookAlike of [
    `GPC on: ${sentence}`,
    sentence.replace("ran first.", "ran first"),
    sentence.replace("The two", "The  two"),
    'The two visits ran in randomized order; the "Anna Schmidt" visit ran first.'
  ]) {
    assert.deepEqual(visitOrderOf(viewFromV1Report(withWarnings(recorded, [lookAlike]))), unrecorded, lookAlike);
  }
  // Both arms' sentences at once name no single arm.
  const both = [sentence, comparisonOrderDisclosure(recorded.runLabels!, "variant")];
  assert.deepEqual(visitOrderOf(viewFromV1Report(withWarnings(recorded, both))), unrecorded);
  // Equal labels make the two sentences identical.
  const sameLabels = { ...recorded, runLabels: { baseline: "Arm", variant: "Arm" } };
  assert.deepEqual(
    visitOrderOf(viewFromV1Report(withWarnings(sameLabels, [comparisonOrderDisclosure(sameLabels.runLabels, "baseline")]))),
    unrecorded
  );
  // No wire labels: nothing to match the sentence against.
  const noLabels: ComparisonScanResult = { ...recorded };
  delete noLabels.runLabels;
  assert.deepEqual(visitOrderOf(viewFromV1Report(noLabels)), unrecorded);
});

test("a v1 comparison without an order sentence names the visit that started first, or none", () => {
  const ordered = viewFromV1Report(createGpcComparisonReport(v1Run(EARLIER), v1Run(LATER)));
  assert.deepEqual(visitOrderOf(ordered), { state: "not-recorded", startedFirst: "baseline" });
  assert.deepEqual(lineOf(ordered), { text: "Started first: GPC off; order not recorded", seeMethodology: true });

  const simultaneous = viewFromV1Report(createGpcComparisonReport(v1Run(EARLIER), v1Run(EARLIER)));
  assert.deepEqual(visitOrderOf(simultaneous), { state: "not-recorded", startedFirst: null });
  assert.deepEqual(lineOf(simultaneous), { text: "Order not recorded", seeMethodology: true });
});

test("temporal pairs state no order on either generation", () => {
  const v1 = createTemporalComparisonReport(v1Run(EARLIER), v1Run(LATER));
  assert.deepEqual(visitOrderOf(viewFromV1Report(v1)), { state: "not-applicable" });
  assert.equal(lineOf(viewFromV1Report(v1)), null);
  // A planted order sentence does not turn Before/After into a recorded order.
  v1.warnings = [...v1.warnings, comparisonOrderDisclosure(v1.runLabels!, "variant")];
  assert.deepEqual(visitOrderOf(viewFromV1Report(v1)), { state: "not-applicable" });

  assert.deepEqual(visitOrderOf(viewFromV2(makeTemporalComparisonReportV2(), 1)), { state: "not-applicable" });
  assert.deepEqual(visitOrderOf(viewFromV2(makeTemporalReportV2R2(), 2)), { state: "not-applicable" });
});

test("v2 views state the recorded experiment order, and descriptive pairs fall back to the start times", () => {
  const r1 = viewFromV2(makeInterventionComparisonReportV2(), 1);
  assert.deepEqual(visitOrderOf(r1), { state: "recorded", first: "baseline" });

  const ab = viewFromV2(makeGpcInterventionReportV2R2(), 2);
  assert.equal(ab.comparison?.order, "AB");
  assert.deepEqual(visitOrderOf(ab), { state: "recorded", first: "baseline" });
  assert.deepEqual(lineOf(ab), { text: "Ran first: GPC off", seeMethodology: false });

  const ba = makeGpcInterventionReportV2R2();
  if (ba.experiment.kind !== "intervention") throw new Error("expected an intervention fixture");
  ba.experiment.order = "BA";
  [ba.baseline.startedAt, ba.variant.startedAt] = [ba.variant.startedAt, ba.baseline.startedAt];
  const baView = viewFromV2(ba, 2);
  assert.deepEqual(visitOrderOf(baView), { state: "recorded", first: "variant" });
  assert.deepEqual(lineOf(baView), { text: "Ran first: GPC on", seeMethodology: false });

  // Descriptive pairs record no execution order (sourceOrder is the order the
  // runs were supplied in, not the order they ran).
  assert.deepEqual(visitOrderOf(viewFromV2(makeDescriptiveComparisonReportV2(), 1)), {
    state: "not-recorded",
    startedFirst: "baseline"
  });
  assert.deepEqual(visitOrderOf(viewFromV2(makeDescriptiveReportV2R2(), 2)), { state: "not-recorded", startedFirst: null });
});
