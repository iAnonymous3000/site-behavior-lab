import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { createGpcComparisonReport } from "./compare-reports";
import { buildStaticReportManifest } from "./static-report-manifest";
import { makeScanReportV1 } from "./scan-report-v2-fixtures";
import type { ScanResult } from "./types";

let reportsDir = "";

beforeEach(async () => {
  reportsDir = await mkdtemp(path.join(tmpdir(), "sbl-manifest-"));
});

afterEach(async () => {
  await rm(reportsDir, { recursive: true, force: true });
});

function makeResult(overrides: { firstPartyDomain?: string; totalRequests?: number } = {}): ScanResult {
  const base = makeScanReportV1();
  if (base.reportType === "comparison") throw new Error("fixture must be a single report");
  return {
    ...base,
    summary: {
      ...base.summary,
      firstPartyDomain: overrides.firstPartyDomain ?? "shop.example.org",
      totalRequests: overrides.totalRequests ?? base.summary.totalRequests
    }
  };
}

async function writeReport(id: string, report: unknown): Promise<void> {
  await writeFile(path.join(reportsDir, `${id}.json`), `${JSON.stringify(report, null, 2)}\n`);
}

test("builds entries for valid v1 reports and ignores non-report files", async () => {
  await writeReport("20260618-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", makeResult());
  await writeFile(path.join(reportsDir, "index.json"), "{}\n");
  await writeFile(path.join(reportsDir, "notes.txt"), "not a report\n");
  await mkdir(path.join(reportsDir, "subdir"));

  const { manifest, warnings } = await buildStaticReportManifest(reportsDir);
  assert.equal(manifest.reports.length, 1);
  assert.deepEqual(warnings, []);
  const entry = manifest.reports[0];
  assert.equal(entry.id, "20260618-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  assert.equal(entry.domain, "shop.example.org");
  assert.equal(entry.reportType, "single");
  assert.equal(typeof entry.metrics.totalRequests, "number");
});

test("comparison reports lead with the baseline and carry the comparison type", async () => {
  const comparison = createGpcComparisonReport(makeResult({ totalRequests: 80 }), makeResult({ totalRequests: 30 }));
  await writeReport("20260618-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", comparison);

  const { manifest } = await buildStaticReportManifest(reportsDir);
  assert.equal(manifest.reports.length, 1);
  const entry = manifest.reports[0];
  assert.equal(entry.reportType, "comparison");
  assert.equal(entry.comparisonType, "gpc");
  assert.equal(entry.gpcEnabled, "comparison");
  assert.equal(entry.metrics.totalRequests, 80);
});

test("a malformed metric skips the report with a warning instead of zero-coercing", async () => {
  // The former MJS builder turned a malformed count into a silent 0 and
  // published the entry anyway; the deep reader refuses the whole report.
  const report = makeResult() as unknown as { summary: Record<string, unknown> };
  report.summary.totalRequests = "twelve";
  await writeReport("20260618-cccccccccccccccccccccccccccccccc", report);

  const { manifest, warnings } = await buildStaticReportManifest(reportsDir);
  assert.equal(manifest.reports.length, 0);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Skipping static report 20260618-cccccccccccccccccccccccccccccccc\.json/);
});

test("a deep-shape violation (null request entry) is skipped with a warning", async () => {
  await writeReport("20260618-dddddddddddddddddddddddddddddddd", { ...makeResult(), requests: [null] });

  const { manifest, warnings } = await buildStaticReportManifest(reportsDir);
  assert.equal(manifest.reports.length, 0);
  assert.equal(warnings.length, 1);
});

test("reserved/test domains stay out of the public gallery", async () => {
  await writeReport("20260618-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", makeResult({ firstPartyDomain: "example.com" }));

  const { manifest, warnings } = await buildStaticReportManifest(reportsDir);
  assert.equal(manifest.reports.length, 0);
  assert.deepEqual(warnings, []);
});

test("a missing reports directory yields an empty manifest", async () => {
  const { manifest, warnings } = await buildStaticReportManifest(path.join(reportsDir, "does-not-exist"));
  assert.deepEqual(manifest.reports, []);
  assert.deepEqual(warnings, []);
});
