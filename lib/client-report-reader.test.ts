import assert from "node:assert/strict";
import { test } from "node:test";
import { readLoadedReport } from "./client-report-reader";
import { makePublicSingleReportV2, makeScanReportV1 } from "./scan-report-v2-fixtures";
import { makePublicSingleReportV2R2 } from "./scan-report-v2-r2-fixtures";

test("readLoadedReport accepts a valid v1 report", async () => {
  const read = await readLoadedReport(makeScanReportV1(), "The upload");
  assert.equal(read.ok, true);
  if (!read.ok) throw new Error("expected ok");
  assert.equal(read.loaded.source, "v1");
  assert.equal(read.loaded.view.reportType, "single");
});

test("readLoadedReport accepts every readable v2 generation (the v1-only gate is gone)", async () => {
  const r1 = await readLoadedReport(makePublicSingleReportV2(), "This report");
  assert.equal(r1.ok, true);
  if (r1.ok) {
    assert.equal(r1.loaded.source, "v2-public");
    assert.equal(r1.loaded.view.origin, "v2");
  }

  const r2 = await readLoadedReport(makePublicSingleReportV2R2(), "This report");
  assert.equal(r2.ok, true);
  if (r2.ok) assert.equal(r2.loaded.source, "v2-r2-public");
});

test("a deep-shape violation reads as damaged, not as a crash later", async () => {
  // The exact shallow-validator escape Codex demonstrated: arrays exist but an
  // entry is null; the old isScanReport passed it through to the request table.
  const payload = { ...makeScanReportV1(), requests: [null] };
  const read = await readLoadedReport(payload, "The upload");
  assert.equal(read.ok, false);
  if (read.ok) throw new Error("expected refusal");
  assert.match(read.message, /^The upload is not a Site Behavior Lab report/);
});

test("a newer schema version or revision is a named capability gap", async () => {
  const version = await readLoadedReport({ schemaVersion: 3 }, "This report");
  assert.equal(version.ok, false);
  if (!version.ok) assert.match(version.message, /newer scanner/);

  const revision = await readLoadedReport({ ...makePublicSingleReportV2R2(), schemaRevision: 3 }, "This report");
  assert.equal(revision.ok, false);
  if (!revision.ok) assert.match(revision.message, /newer scanner/);
});

test("job envelopes and API errors are refusals with their own messages, never 'not a report'", async () => {
  const pending = await readLoadedReport({ ok: true, status: "queued", jobId: "j" }, "This file");
  assert.equal(pending.ok, false);
  if (!pending.ok) assert.match(pending.message, /status record, not a finished report/);

  const failed = await readLoadedReport({ ok: true, status: "failed", error: "Scan job failed." }, "This file");
  assert.equal(failed.ok, false);
  if (!failed.ok) assert.match(failed.message, /Scan job failed/);

  const apiError = await readLoadedReport({ ok: false, error: "Unauthorized scan request." }, "This file");
  assert.equal(apiError.ok, false);
  if (!apiError.ok) assert.match(apiError.message, /Unauthorized/);
});
