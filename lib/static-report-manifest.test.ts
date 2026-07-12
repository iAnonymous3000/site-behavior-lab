import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { createGpcComparisonReport } from "./compare-reports";
import { buildProvenanceEntry, committedSidecarFilename } from "./redaction-provenance";
import { redactScanReportV1 } from "./redact-scan-report-v1";
import { buildStaticReportManifest } from "./static-report-manifest";
import { makeScanReportV1 } from "./scan-report-v2-fixtures";
import type { ScanReport, ScanResult } from "./types";

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
  const totalRequests = overrides.totalRequests ?? base.summary.totalRequests;
  return {
    ...base,
    requests:
      overrides.totalRequests === undefined
        ? base.requests
        : Array.from({ length: totalRequests }, (_, index) => ({
            id: index + 1,
            url: `https://cdn.example.net/privacy?utm_source=${index}`,
            domain: "cdn.example.net",
            method: "GET",
            resourceType: "image",
            status: 200,
            thirdParty: true,
            tracker: null,
            startedAtMs: index
          })),
    summary: {
      ...base.summary,
      firstPartyDomain: overrides.firstPartyDomain ?? "shop.example.org",
      totalRequests
    }
  };
}

async function writeReport(id: string, report: unknown): Promise<void> {
  const redacted = redactScanReportV1(report as ScanReport).report;
  await writeReportAndSidecar(id, redacted);
}

async function writeRawManagedReport(id: string, report: unknown): Promise<void> {
  await writeReportAndSidecar(id, report);
}

async function writeReportAndSidecar(id: string, report: unknown): Promise<void> {
  await writeFile(path.join(reportsDir, `${id}.json`), `${JSON.stringify(report, null, 2)}\n`);
  const createdAt = reportCreationTime(report);
  const sidecar = buildProvenanceEntry({
    reportId: id,
    publicReport: report,
    writtenAt: "2026-07-12T00:00:00.000Z",
    createdAt,
    expiresAt: null
  });
  await writeFile(path.join(reportsDir, committedSidecarFilename(id)), `${JSON.stringify(sidecar)}\n`);
}

function reportCreationTime(report: unknown): string {
  const value = report as { scannedAt?: unknown; conditions?: { scannedAt?: unknown } };
  const scannedAt = value.scannedAt ?? value.conditions?.scannedAt;
  if (typeof scannedAt !== "string") throw new Error("fixture needs a recorded scan time");
  return scannedAt;
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

test("a malformed metric fails the managed manifest build instead of zero-coercing", async () => {
  // The former MJS builder turned a malformed count into a silent 0 and
  // published the entry anyway; the deep reader refuses the whole report.
  const report = makeResult() as unknown as { summary: Record<string, unknown> };
  report.summary.totalRequests = "twelve";
  await writeRawManagedReport("20260618-cccccccccccccccccccccccccccccccc", report);

  await assert.rejects(() => buildStaticReportManifest(reportsDir), /invalid-report/);
});

test("a deep-shape violation fails the managed manifest build", async () => {
  await writeRawManagedReport("20260618-dddddddddddddddddddddddddddddddd", { ...makeResult(), requests: [null] });

  await assert.rejects(() => buildStaticReportManifest(reportsDir), /invalid-report/);
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

test("a missing or mismatched sidecar fails the manifest build", async () => {
  const missingId = "20260618-11111111111111111111111111111111";
  const report = redactScanReportV1(makeResult()).report;
  await writeFile(path.join(reportsDir, `${missingId}.json`), `${JSON.stringify(report)}\n`);
  await assert.rejects(() => buildStaticReportManifest(reportsDir), /no-sidecar/);

  await rm(path.join(reportsDir, `${missingId}.json`));
  const mismatchId = "20260618-22222222222222222222222222222222";
  await writeReport(mismatchId, makeResult());
  const sidecarPath = path.join(reportsDir, committedSidecarFilename(mismatchId));
  const sidecar = JSON.parse(await readFile(sidecarPath, "utf8")) as Record<string, unknown>;
  await writeFile(sidecarPath, `${JSON.stringify({ ...sidecar, publicDigest: "0".repeat(64) })}\n`);
  await assert.rejects(() => buildStaticReportManifest(reportsDir), /digest-mismatch/);
});
