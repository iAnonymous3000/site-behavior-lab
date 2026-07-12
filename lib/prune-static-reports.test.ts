import assert from "node:assert/strict";
import { access, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { pruneStaticReports } from "./prune-static-reports";
import { buildProvenanceEntry, committedSidecarFilename } from "./redaction-provenance";
import { redactScanReportV1 } from "./redact-scan-report-v1";
import { makeScanReportV1 } from "./scan-report-v2-fixtures";
import type { ScanReport, ScanResult } from "./types";

const DAY_MS = 24 * 60 * 60 * 1_000;

let reportsDir = "";

beforeEach(async () => {
  reportsDir = await mkdtemp(path.join(tmpdir(), "sbl-prune-"));
});

afterEach(async () => {
  await rm(reportsDir, { recursive: true, force: true });
});

function makeResult(domain: string, scannedAt: string): ScanResult {
  const base = makeScanReportV1();
  if (base.reportType === "comparison") throw new Error("fixture must be a single report");
  return {
    ...base,
    summary: { ...base.summary, firstPartyDomain: domain },
    conditions: { ...base.conditions, scannedAt }
  };
}

async function writeReport(id: string, report: unknown): Promise<void> {
  const redacted = redactScanReportV1(report as ScanReport).report;
  await writeFile(path.join(reportsDir, `${id}.json`), `${JSON.stringify(redacted)}\n`);
  const createdAt =
    redacted.reportType === "comparison" ? redacted.scannedAt : redacted.conditions.scannedAt;
  const sidecar = buildProvenanceEntry({
    reportId: id,
    publicReport: redacted,
    writtenAt: "2026-07-12T00:00:00.000Z",
    createdAt,
    expiresAt: null
  });
  await writeFile(path.join(reportsDir, committedSidecarFilename(id)), `${JSON.stringify(sidecar)}\n`);
}

test("age pruning removes stale reports but keeps each site's newest generations", async () => {
  const now = Date.parse("2026-07-10T00:00:00.000Z");
  // Three generations for one site: the newest two are protected, the third
  // is stale and prunable.
  await writeReport("20260101-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", makeResult("one.example.dev", "2026-01-01T00:00:00.000Z"));
  await writeReport("20260301-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", makeResult("one.example.dev", "2026-03-01T00:00:00.000Z"));
  await writeReport("20260501-cccccccccccccccccccccccccccccccc", makeResult("one.example.dev", "2026-05-01T00:00:00.000Z"));

  const { removed, warnings } = await pruneStaticReports(reportsDir, {
    maxAgeMs: 7 * DAY_MS,
    maxCount: 1_000,
    keepPerSite: 2,
    now
  });

  assert.deepEqual(warnings, []);
  assert.equal(removed.length, 1);
  assert.match(removed[0], /20260101-a+\.json$/);
  const remaining = await readdir(reportsDir);
  assert.equal(remaining.filter((file) => /^\d{8}-[a-f0-9]{32}\.json$/.test(file)).length, 2);
  assert.equal(remaining.filter((file) => file.endsWith(".provenance.json")).length, 2);
  await assert.rejects(
    () => access(path.join(reportsDir, "20260101-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.provenance.json")),
    /ENOENT/
  );
});

test("a file the reader cannot read is never deleted", async () => {
  const now = Date.parse("2026-07-10T00:00:00.000Z");
  await writeFile(path.join(reportsDir, "20250101-dddddddddddddddddddddddddddddddd.json"), "{\n");
  await writeFile(
    path.join(reportsDir, "20250101-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee.json"),
    `${JSON.stringify({ ...makeResult("two.example.dev", "2025-01-01T00:00:00.000Z"), requests: [null] })}\n`
  );

  const { removed, warnings } = await pruneStaticReports(reportsDir, {
    maxAgeMs: 7 * DAY_MS,
    maxCount: 1,
    keepPerSite: 0,
    now
  });

  // Both files are ancient and over the count cap, but retention must not
  // destroy evidence it cannot understand.
  assert.deepEqual(removed, []);
  assert.equal(warnings.length, 2);
  assert.equal((await readdir(reportsDir)).length, 2);
});

test("the count cap trims oldest unprotected reports first", async () => {
  const now = Date.parse("2026-07-10T00:00:00.000Z");
  await writeReport("20260708-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", makeResult("a.example.dev", "2026-07-08T00:00:00.000Z"));
  await writeReport("20260709-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", makeResult("b.example.dev", "2026-07-09T00:00:00.000Z"));
  await writeReport("20260710-cccccccccccccccccccccccccccccccc", makeResult("c.example.dev", "2026-07-10T00:00:00.000Z"));

  const { removed } = await pruneStaticReports(reportsDir, {
    maxAgeMs: 365 * DAY_MS,
    maxCount: 2,
    keepPerSite: 0,
    now
  });

  assert.equal(removed.length, 1);
  assert.match(removed[0], /20260708-a+\.json$/);
});

test("unknown provenance is retained while verified pruning removes the whole bundle", async () => {
  const now = Date.parse("2026-07-10T00:00:00.000Z");
  const missingId = "20250101-11111111111111111111111111111111";
  const missing = redactScanReportV1(makeResult("unknown.example.dev", "2025-01-01T00:00:00.000Z")).report;
  await writeFile(path.join(reportsDir, `${missingId}.json`), `${JSON.stringify(missing)}\n`);

  const verifiedId = "20250101-22222222222222222222222222222222";
  await writeReport(verifiedId, makeResult("verified.example.dev", "2025-01-01T00:00:00.000Z"));
  const danglingId = "20250101-33333333333333333333333333333333";
  await writeFile(path.join(reportsDir, committedSidecarFilename(danglingId)), "{}\n");

  const { removed, warnings } = await pruneStaticReports(reportsDir, {
    maxAgeMs: 7 * DAY_MS,
    maxCount: 100,
    keepPerSite: 0,
    now
  });

  assert.deepEqual(removed, [path.join(reportsDir, `${verifiedId}.json`)]);
  assert.equal(warnings.length, 2);
  assert.equal(warnings.some((warning) => warning.includes("no-sidecar")), true);
  assert.equal(warnings.some((warning) => warning.includes("dangling")), true);
  await access(path.join(reportsDir, `${missingId}.json`));
  await access(path.join(reportsDir, committedSidecarFilename(danglingId)));
  await assert.rejects(() => access(path.join(reportsDir, `${verifiedId}.json`)), /ENOENT/);
  await assert.rejects(() => access(path.join(reportsDir, committedSidecarFilename(verifiedId))), /ENOENT/);
});
