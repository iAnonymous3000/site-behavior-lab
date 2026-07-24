import assert from "node:assert/strict";
import { test } from "node:test";
import { readLoadedReport, withoutLoadedReportShare } from "./client-report-reader";
import { buildReportShare } from "./report-locator";
import { displayableScreenshot } from "./report-insights";
import { loadedReportFromStored } from "./scan-report-view";
import { readStoredScanReport } from "./scan-report-reader";
import { makeEphemeralSingleReport, makePublicSingleReportV2, makeScanReportV1 } from "./scan-report-v2-fixtures";
import { makePublicSingleReportV2R2 } from "./scan-report-v2-r2-fixtures";
import { BROWSER_REPORT_COLLECTION_LIMITS } from "./client-report-resource-policy";

const SHARE_ID = "20260619-1cae9eb5a7b2fae0d49af5acda78031b";
const VALID_PNG_SCREENSHOT =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

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

test("stored reports become server-renderable loaded envelopes without a transport fetch", () => {
  for (const payload of [makeScanReportV1(), makePublicSingleReportV2(), makePublicSingleReportV2R2()]) {
    const read = readStoredScanReport(payload);
    assert.equal(read.ok, true);
    if (!read.ok) continue;
    const loaded = loadedReportFromStored(read.stored);
    assert.equal(loaded.wire, read.stored.report);
    assert.equal(loaded.view.reportType, "single");
  }
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

test("browser report reads reject oversized collections before the deep reader", async () => {
  const payload = structuredClone(makePublicSingleReportV2()) as Record<string, any>;
  payload.run.evidence.requests = Array.from(
    { length: BROWSER_REPORT_COLLECTION_LIMITS.requests + 1 },
    () => payload.run.evidence.requests[0]
  );
  const read = await readLoadedReport(payload, "The upload");
  assert.equal(read.ok, false);
  if (!read.ok) assert.match(read.message, /safe report evidence limits/);
});

test("uploaded and immediate screenshots reach rendering only after bounded image admission", async () => {
  const upload = makeScanReportV1();
  if (upload.reportType !== "single") throw new Error("expected single fixture");
  upload.screenshot = VALID_PNG_SCREENSHOT;
  const uploaded = await readLoadedReport(upload, "The upload");
  assert.equal(uploaded.ok, true);
  if (uploaded.ok) {
    assert.equal(uploaded.loaded.view.runs[0].screenshot, VALID_PNG_SCREENSHOT);
    assert.equal(displayableScreenshot(uploaded.loaded.view.runs[0].screenshot), VALID_PNG_SCREENSHOT);
  }

  const immediate = await readLoadedReport({
    ...makePublicSingleReportV2R2(),
    ephemeral: { screenshot: VALID_PNG_SCREENSHOT }
  });
  assert.equal(immediate.ok, true);
  if (immediate.ok) assert.equal(displayableScreenshot(immediate.loaded.view.runs[0].screenshot), VALID_PNG_SCREENSHOT);

  const bomb = makeScanReportV1();
  if (bomb.reportType !== "single") throw new Error("expected single fixture");
  const bytes = Buffer.from(VALID_PNG_SCREENSHOT.slice(VALID_PNG_SCREENSHOT.indexOf(",") + 1), "base64");
  bytes.writeUInt32BE(65_535, 16);
  bomb.screenshot = `data:image/png;base64,${bytes.toString("base64")}`;
  const refused = await readLoadedReport(bomb, "The upload");
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.match(refused.message, /safe report evidence limits/);
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

test("withoutLoadedReportShare strips every generation and both ephemeral projections", async () => {
  const share = buildReportShare(SHARE_ID);
  const payloads = [
    { ...makeScanReportV1(), share },
    { ...makePublicSingleReportV2(), share },
    { ...makePublicSingleReportV2R2(), share },
    { ...makeEphemeralSingleReport(), share, ephemeral: { screenshot: null } },
    { ...makePublicSingleReportV2R2(), share, ephemeral: { screenshot: null } }
  ];

  for (const payload of payloads) {
    const read = await readLoadedReport(payload, "This report");
    assert.equal(read.ok, true);
    if (!read.ok) continue;
    const originalView = read.loaded.view;
    const stripped = withoutLoadedReportShare(read.loaded);
    assert.equal(stripped.wire.share, undefined);
    assert.equal(stripped.view, originalView);
    if (stripped.source === "v2-ephemeral" || stripped.source === "v2-r2-ephemeral") {
      assert.equal(stripped.public.share, undefined);
    }
    assert.deepEqual(read.loaded.wire.share, share);
  }
});
