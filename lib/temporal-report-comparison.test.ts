import assert from "node:assert/strict";
import { test } from "node:test";
import { buildStaticReportShare } from "./report-locator";
import { buildFingerprints } from "./scan-report-v2-fingerprints";
import {
  makePublicSingleReportV2R2,
  makeShieldsInterventionReportV2R2,
  makeTemporalReportV2R2
} from "./scan-report-v2-r2-fixtures";
import { scanReportV2R2SemanticViolations } from "./scan-report-v2-r2-evaluators";
import { makePublicSingleReportV2, makeScanReportV1 } from "./scan-report-v2-fixtures";
import { readStoredScanReport } from "./scan-report-reader";
import { viewFromV1Report, viewFromV2 } from "./scan-report-views";
import { publicWireForExportOrPersistence, type LoadedReport } from "./scan-report-view";
import {
  createLoadedTemporalComparison,
  temporalUploadSelectionError
} from "./temporal-report-comparison";

function loadedR2(report: ReturnType<typeof makePublicSingleReportV2R2>): LoadedReport {
  return { source: "v2-r2-public", wire: report, view: viewFromV2(report, 2) };
}

test("compatible v2/r2 singles build an ordered, exportable temporal report", () => {
  const before = makePublicSingleReportV2R2();
  before.run.runId = "run-before";
  before.run.startedAt = "2026-07-01T10:00:00.000Z";
  before.share = buildStaticReportShare("20260701-11111111111111111111111111111111");
  const after = makePublicSingleReportV2R2();
  after.run.runId = "run-after";
  after.run.startedAt = "2026-07-02T10:00:00.000Z";
  after.share = buildStaticReportShare("20260702-22222222222222222222222222222222");

  // Reverse picker order: chronology, not the UI slot, defines the arms.
  const result = createLoadedTemporalComparison(loadedR2(after), loadedR2(before));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.generation, "v2-r2");
  assert.equal(result.loaded.source, "v2-r2-public");
  if (result.loaded.source !== "v2-r2-public") return;
  assert.equal(result.loaded.wire.reportType, "comparison");
  if (result.loaded.wire.reportType !== "comparison") return;
  assert.equal(result.loaded.wire.experiment.kind, "temporal");
  assert.equal(result.loaded.wire.baseline.runId, "run-before");
  assert.equal(result.loaded.wire.variant.runId, "run-after");
  assert.equal(result.loaded.wire.share, undefined, "a local comparison must not inherit a stored share capability");
  assert.deepEqual(scanReportV2R2SemanticViolations(result.loaded.wire), []);
  assert.equal(publicWireForExportOrPersistence(result.loaded), result.loaded.wire);
  const reread = readStoredScanReport(result.loaded.wire);
  assert.equal(reread.ok, true, "the exported temporal report must survive the canonical reader");
  assert.equal(result.loaded.view.claims.temporalChange, true);
  assert.equal(result.loaded.view.scannedAt, after.run.startedAt, "the temporal report is dated by its displayed newer visit");
  assert.equal(result.loaded.view.claims.familyDeltas?.["raw-counts"].allowed, true);
});

test("r2 methodology drift is an explicit incompatible-cohort refusal", () => {
  const before = makePublicSingleReportV2R2();
  before.run.runId = "run-method-before";
  before.run.startedAt = "2026-07-01T10:00:00.000Z";
  const after = makePublicSingleReportV2R2();
  after.run.runId = "run-method-after";
  after.run.startedAt = "2026-07-02T10:00:00.000Z";
  after.run.provenance.methodologyVersion = "3.0";
  after.run.fingerprints = buildFingerprints({
    conditions: after.run.conditions,
    provenance: after.run.provenance,
    toolchain: after.run.toolchain,
    detectors: after.run.detectors
  });

  const result = createLoadedTemporalComparison(loadedR2(before), loadedR2(after));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "incompatible");
  assert.match(result.message, /methodology version/i);
});

test("archive selection extracts the representative visit from r2 comparisons", () => {
  const older = makeShieldsInterventionReportV2R2();
  const newer = makeShieldsInterventionReportV2R2();
  newer.baseline.runId = "archive-new-baseline";
  newer.baseline.startedAt = "2026-07-10T11:00:00.000Z";
  newer.variant.runId = "archive-new-variant";
  newer.variant.startedAt = "2026-07-10T11:01:00.000Z";

  const result = createLoadedTemporalComparison(
    { source: "v2-r2-public", wire: newer, view: viewFromV2(newer, 2) },
    { source: "v2-r2-public", wire: older, view: viewFromV2(older, 2) }
  );
  assert.equal(result.ok, true);
  if (!result.ok || result.loaded.source !== "v2-r2-public" || result.loaded.wire.reportType !== "comparison") return;
  assert.equal(result.loaded.wire.baseline.runId, older.baseline.runId);
  assert.equal(result.loaded.wire.variant.runId, newer.baseline.runId);
});

test("mixed generations and v2/r1 pairs are refused by name", () => {
  const v1 = makeScanReportV1();
  const v1Loaded: LoadedReport = { source: "v1", wire: v1, view: viewFromV1Report(v1) };
  const r2 = makePublicSingleReportV2R2();
  r2.run.startedAt = "2026-07-11T10:00:00.000Z";
  const mixed = createLoadedTemporalComparison(v1Loaded, loadedR2(r2));
  assert.equal(mixed.ok, false);
  if (!mixed.ok) {
    assert.equal(mixed.code, "mixed-generation");
    assert.match(mixed.message, /cannot mix v1 and v2/i);
  }

  const r1Before = makePublicSingleReportV2();
  const r1After = makePublicSingleReportV2();
  r1After.run.runId = "r1-after";
  r1After.run.startedAt = "2026-07-10T11:00:00.000Z";
  const r1BeforeLoaded: LoadedReport = {
    source: "v2-public",
    wire: r1Before,
    view: viewFromV2(r1Before, 1)
  };
  const r1AfterLoaded: LoadedReport = {
    source: "v2-public",
    wire: r1After,
    view: viewFromV2(r1After, 1)
  };
  const r1Result = createLoadedTemporalComparison(
    r1BeforeLoaded,
    r1AfterLoaded
  );
  assert.equal(r1Result.ok, false);
  if (!r1Result.ok) {
    assert.equal(r1Result.code, "unsupported-revision");
    assert.match(r1Result.message, /revision 1/i);
  }

  const r1R2Result = createLoadedTemporalComparison(r1BeforeLoaded, loadedR2(r2));
  assert.equal(r1R2Result.ok, false);
  if (!r1R2Result.ok) {
    assert.equal(r1R2Result.code, "unsupported-revision");
    assert.match(r1R2Result.message, /revision 1/i);
  }
});

test("uploaded comparisons remain refused while uploaded r2 singles are selectable", () => {
  const single = makePublicSingleReportV2R2();
  assert.equal(temporalUploadSelectionError(loadedR2(single)), null);

  const comparison = makeTemporalReportV2R2();
  const loaded: LoadedReport = {
    source: "v2-r2-public",
    wire: comparison,
    view: viewFromV2(comparison, 2)
  };
  assert.match(temporalUploadSelectionError(loaded) ?? "", /single-scan/i);
});
