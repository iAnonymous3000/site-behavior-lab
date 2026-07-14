import assert from "node:assert/strict";
import { test } from "node:test";
import { committedReportCreatedAt } from "./committed-report-created-at";
import { readStoredScanReport, type StoredScanReport } from "./scan-report-reader";
import {
  makePublicSingleReportV2R2,
  makeSupportingPairInterventionReportV2R2
} from "./scan-report-v2-r2-fixtures";
import { makeScanReportV1 } from "./scan-report-v2-fixtures";

test("committed report creation keeps the frozen v1 clock", () => {
  const report = makeScanReportV1();
  if (report.reportType === "comparison") throw new Error("expected single fixture");
  assert.equal(committedReportCreatedAt(read(report)), report.conditions.scannedAt);
});

test("committed report creation uses the v2 single run clock", () => {
  const report = makePublicSingleReportV2R2();
  assert.equal(committedReportCreatedAt(read(report)), report.run.startedAt);
});

test("committed report creation includes every r2 supporting-pair arm", () => {
  const report = makeSupportingPairInterventionReportV2R2();
  assert.equal(committedReportCreatedAt(read(report)), "2026-07-09T11:01:00.000Z");
});

function read(report: unknown): StoredScanReport {
  const result = readStoredScanReport(report);
  if (!result.ok) throw new Error(`fixture should be readable (${result.error})`);
  return result.stored;
}
