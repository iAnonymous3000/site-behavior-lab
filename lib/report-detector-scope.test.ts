import assert from "node:assert/strict";
import test from "node:test";
import { readStoredScanReport } from "./scan-report-reader";
import { makePublicSingleReportV2R2, makeShieldsInterventionReportV2R2 } from "./scan-report-v2-r2-fixtures";
import { reportDetectorScope, toReportView, type ReportView } from "./scan-report-views";
import { DETECTOR_IDS } from "./scan-report-v2";

/** Through the reader and view the routes use. */
function viewOf(report: unknown): ReportView {
  const read = readStoredScanReport(JSON.parse(JSON.stringify(report)));
  if (!read.ok) assert.fail(`the fixture is refused by the reader: ${read.error}`);
  return toReportView(read.stored);
}

const DETECTOR = "fingerprint-heuristics";

test("a published rate applies to a comparison only where every arm completed the detector", () => {
  const view = viewOf(makeShieldsInterventionReportV2R2());
  assert.equal(view.runs.length, 2);
  for (const run of view.runs) {
    assert.equal(run.detectors?.[DETECTOR]?.status, "complete", "the fixture's arms both complete the detector");
  }
  assert.equal(reportDetectorScope(view).rateApplicable.includes(DETECTOR), true, "complete on both arms applies");

  // Complete on the baseline, partial on the variant: the variant's evidence
  // was truncated, which is the case a study censors.
  view.runs[1].detectors![DETECTOR] = { ...view.runs[1].detectors![DETECTOR], status: "partial" };
  const scope = reportDetectorScope(view);
  assert.equal(
    scope.rateApplicable.includes(DETECTOR),
    false,
    "a detector partial on one arm is not rate-applicable to the comparison"
  );
  assert.equal(scope.qualified.includes(DETECTOR), true, "it still qualifies the page: it ran on both arms");

  // An arm with no ledger cannot establish that any detector completed.
  view.runs[1].detectors = null;
  assert.deepEqual(
    reportDetectorScope(view).rateApplicable,
    [],
    "an arm with no ledger leaves no detector rate-applicable"
  );
});

test("a single run's scope is its own ledger", () => {
  const view = viewOf(makePublicSingleReportV2R2());
  const complete = DETECTOR_IDS.filter((id) => view.runs[0].detectors?.[id]?.status === "complete");
  assert.deepEqual(reportDetectorScope(view).rateApplicable, complete);
});
