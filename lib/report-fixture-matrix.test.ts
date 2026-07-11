import assert from "node:assert/strict";
import { test } from "node:test";
import { readRenderableReport } from "./client-report-reader";
import { createGpcComparisonReport } from "./compare-reports";
import { buildFindings } from "./report-findings";
import { buildReportHeadline } from "./report-headline";
import { readStoredScanReport } from "./scan-report-reader";
import { toPublicScanReportV1 } from "./scan-report-v1-projection";
import {
  makeEphemeralSingleReport,
  makeInterventionComparisonReportV2,
  makePublicSingleReportV2,
  makeScanReportV1
} from "./scan-report-v2-fixtures";
import {
  makeGpcInterventionReportV2R2,
  makePublicSingleReportV2R2
} from "./scan-report-v2-r2-fixtures";
import {
  publicWireForExportOrPersistence,
  readScanTransportPayload,
  type LoadedReport
} from "./scan-report-view";
import type { ScanReport, ScanResult } from "./types";

/**
 * The r1/r2 fixture matrix acceptance gate (survey, round-10 remaining order,
 * third item): every wire generation, through every consumer entry path the
 * app has, before the atomic LoadedReport migration flips the renderers.
 *
 * Paths per fixture:
 * - upload / sync scan result: readScanTransportPayload on the raw payload;
 * - poll: the same payload wrapped in a succeeded job envelope (unwraps one
 *   level);
 * - permalink / stored (also the gallery's static JSON loads): the canonical
 *   stored reader;
 * - render acceptance: headline and findings engines run on the resulting
 *   view;
 * - the JSON-download rule: publicWireForExportOrPersistence serializes the
 *   original public wire (deep-projected for v1, projection for ephemeral),
 *   never a view or an ephemeral shell.
 *
 * The client seam's v1-only render gate is PINNED here (v2 payloads refuse
 * with the capability message); the atomic migration removes that gate
 * consciously by updating this matrix, never by accident.
 */

type MatrixRow = {
  name: string;
  payload: unknown;
  source: LoadedReport["source"];
  origin: "v2" | "legacy-derived";
  revision: 1 | 2 | null;
  reportType: "single" | "comparison";
};

function v1Single(): ScanReport {
  return makeScanReportV1();
}

function v1Comparison(): ScanReport {
  const single = makeScanReportV1() as ScanResult;
  return createGpcComparisonReport(structuredClone(single), structuredClone(single));
}

const matrix: MatrixRow[] = [
  { name: "v1 single", payload: v1Single(), source: "v1", origin: "legacy-derived", revision: null, reportType: "single" },
  { name: "v1 comparison", payload: v1Comparison(), source: "v1", origin: "legacy-derived", revision: null, reportType: "comparison" },
  { name: "v2 r1 single", payload: makePublicSingleReportV2(), source: "v2-public", origin: "v2", revision: 1, reportType: "single" },
  {
    name: "v2 r1 comparison",
    payload: makeInterventionComparisonReportV2(),
    source: "v2-public",
    origin: "v2",
    revision: 1,
    reportType: "comparison"
  },
  { name: "v2 r2 single", payload: makePublicSingleReportV2R2(), source: "v2-r2-public", origin: "v2", revision: 2, reportType: "single" },
  {
    name: "v2 r2 comparison",
    payload: makeGpcInterventionReportV2R2(),
    source: "v2-r2-public",
    origin: "v2",
    revision: 2,
    reportType: "comparison"
  }
];

test("matrix: every generation loads through the upload, poll, and stored paths", () => {
  for (const row of matrix) {
    // Upload / sync scan result path.
    const direct = readScanTransportPayload(row.payload);
    assert.equal(direct.kind, "report", `${row.name}: direct`);
    if (direct.kind !== "report") continue;
    assert.equal(direct.loaded.source, row.source, `${row.name}: source`);
    assert.equal(direct.loaded.view.origin, row.origin, `${row.name}: origin`);
    assert.equal(direct.loaded.view.revision, row.revision, `${row.name}: revision`);
    assert.equal(direct.loaded.view.reportType, row.reportType, `${row.name}: reportType`);

    // Poll path: a succeeded job envelope unwraps exactly one level.
    const polled = readScanTransportPayload({ ok: true, status: "succeeded", jobId: "job", report: row.payload });
    assert.equal(polled.kind, "report", `${row.name}: polled`);
    if (polled.kind === "report") {
      assert.equal(polled.loaded.source, row.source, `${row.name}: polled source`);
    }

    // Permalink / stored / gallery path: the canonical stored reader.
    const stored = readStoredScanReport(row.payload);
    assert.equal(stored.ok, true, `${row.name}: stored`);
    if (stored.ok) {
      assert.equal(stored.stored.schemaVersion === 1 ? null : stored.stored.schemaRevision, row.revision, `${row.name}: stored revision`);
    }
  }
});

test("matrix: headline and findings engines accept every generation's view", () => {
  for (const row of matrix) {
    const result = readScanTransportPayload(row.payload);
    assert.equal(result.kind, "report", row.name);
    if (result.kind !== "report") continue;
    const view = result.loaded.view;

    const headline = buildReportHeadline(view);
    assert.equal(typeof headline.headline, "string", `${row.name}: headline`);
    assert.notEqual(headline.headline.trim(), "", `${row.name}: headline nonempty`);

    const findings = buildFindings(view, null);
    assert.equal(Array.isArray(findings), true, `${row.name}: findings`);
    assert.notEqual(findings.length, 0, `${row.name}: findings nonempty`);

    // Comparisons carry the decision; singles never do.
    if (row.reportType === "comparison") {
      assert.notEqual(view.claims.decision, null, `${row.name}: decision`);
    } else {
      assert.equal(view.claims.decision, null, `${row.name}: no decision`);
    }
  }
});

test("matrix: the JSON-download rule serializes the original public wire per generation", () => {
  for (const row of matrix) {
    const result = readScanTransportPayload(row.payload);
    assert.equal(result.kind, "report", row.name);
    if (result.kind !== "report") continue;
    const wire = publicWireForExportOrPersistence(result.loaded);

    if (row.source === "v1") {
      // v1 goes through the deep named-field projector so smuggled fields and
      // inline screenshots can never ride an upload into a persisted share.
      assert.deepEqual(wire, toPublicScanReportV1(row.payload as ScanReport), row.name);
    } else {
      assert.equal(wire, result.loaded.wire, row.name);
    }
  }
});

test("matrix: ephemeral shells resolve to their public projection for persistence", () => {
  const r1Shell = makeEphemeralSingleReport();
  const r1Result = readScanTransportPayload(r1Shell);
  assert.equal(r1Result.kind, "report");
  if (r1Result.kind === "report") {
    assert.equal(r1Result.loaded.source, "v2-ephemeral");
    const wire = publicWireForExportOrPersistence(r1Result.loaded) as Record<string, unknown>;
    assert.equal("ephemeral" in wire, false);
    // The view restores the shell's screenshot for the immediate viewer; the
    // persistable wire never carries it.
    assert.equal(r1Result.loaded.view.runs[0].screenshot, r1Shell.ephemeral.screenshot);
  }

  const r2Shell = { ...makePublicSingleReportV2R2(), ephemeral: { screenshot: null } };
  const r2Result = readScanTransportPayload(r2Shell);
  assert.equal(r2Result.kind, "report");
  if (r2Result.kind === "report") {
    assert.equal(r2Result.loaded.source, "v2-r2-ephemeral");
    const wire = publicWireForExportOrPersistence(r2Result.loaded) as Record<string, unknown>;
    assert.equal("ephemeral" in wire, false);
  }
});

test("matrix: the client seam's v1-only render gate refuses v2 with the capability message", async () => {
  // PINNED ON PURPOSE: the atomic LoadedReport migration removes this gate by
  // UPDATING this test, so the flip is a conscious matrix change.
  const v1 = await readRenderableReport(v1Single());
  assert.equal(v1.ok, true);

  for (const payload of [makePublicSingleReportV2(), makePublicSingleReportV2R2()]) {
    const refused = await readRenderableReport(payload);
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.match(refused.message, /cannot render it yet/);
  }
});

test("matrix: a future revision is a named capability gap on every path", async () => {
  const future = { ...makePublicSingleReportV2R2(), schemaRevision: 3 };

  const transport = readScanTransportPayload(future);
  assert.equal(transport.kind, "unreadable");
  if (transport.kind === "unreadable") assert.equal(transport.error, "unsupported-revision");

  const stored = readStoredScanReport(future);
  assert.equal(stored.ok, false);
  if (!stored.ok) assert.equal(stored.error, "unsupported-revision");

  const client = await readRenderableReport(future);
  assert.equal(client.ok, false);
  if (!client.ok) assert.match(client.message, /newer scanner/);
});
