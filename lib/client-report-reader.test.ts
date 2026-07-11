import assert from "node:assert/strict";
import { test } from "node:test";
import { readRenderableReport } from "./client-report-reader";
import { makePublicSingleReportV2, makeScanReportV1 } from "./scan-report-v2-fixtures";

test("readRenderableReport accepts a valid v1 report", async () => {
  const read = await readRenderableReport(makeScanReportV1(), "The upload");
  assert.equal(read.ok, true);
  if (!read.ok) throw new Error("expected ok");
  assert.equal(read.report.reportType, "single");
});

test("a deep-shape violation reads as damaged, not as a crash later", async () => {
  // The exact shallow-validator escape Codex demonstrated: arrays exist but an
  // entry is null; the old isScanReport passed it through to the request table.
  const payload = { ...makeScanReportV1(), requests: [null] };
  const read = await readRenderableReport(payload, "The upload");
  assert.equal(read.ok, false);
  if (read.ok) throw new Error("expected refusal");
  assert.match(read.message, /^The upload is not a Site Behavior Lab report/);
});

test("a newer schema version is a named capability gap", async () => {
  const read = await readRenderableReport({ schemaVersion: 3 }, "This report");
  assert.equal(read.ok, false);
  if (read.ok) throw new Error("expected refusal");
  assert.match(read.message, /newer scanner/);
});

test("a valid v2 report is refused as unrenderable, never mislabeled invalid", async () => {
  const read = await readRenderableReport(makePublicSingleReportV2(), "This report");
  assert.equal(read.ok, false);
  if (read.ok) throw new Error("expected refusal");
  assert.match(read.message, /v2 report schema/);
  assert.doesNotMatch(read.message, /not a Site Behavior Lab report/);
});
