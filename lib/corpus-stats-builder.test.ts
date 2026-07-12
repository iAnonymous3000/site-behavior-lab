import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { buildCorpusStats } from "./corpus-stats-builder";
import { makeScanReportV1 } from "./scan-report-v2-fixtures";
import type { ScanResult } from "./types";

let reportsDir = "";

beforeEach(async () => {
  reportsDir = await mkdtemp(path.join(tmpdir(), "sbl-corpus-stats-"));
});

afterEach(async () => {
  await rm(reportsDir, { recursive: true, force: true });
});

function makeResult(overrides: {
  firstPartyDomain?: string;
  thirdPartyRequests?: number;
  status?: number;
  scannedAt?: string;
} = {}): ScanResult {
  const base = makeScanReportV1();
  if (base.reportType === "comparison") throw new Error("fixture must be a single report");
  return {
    ...base,
    summary: {
      ...base.summary,
      firstPartyDomain: overrides.firstPartyDomain ?? "shop.example.dev",
      thirdPartyRequests: overrides.thirdPartyRequests ?? base.summary.thirdPartyRequests,
      status: overrides.status ?? base.summary.status
    },
    conditions: {
      ...base.conditions,
      scannedAt: overrides.scannedAt ?? base.conditions.scannedAt
    }
  };
}

async function writeReport(id: string, report: unknown): Promise<void> {
  await writeFile(path.join(reportsDir, `${id}.json`), `${JSON.stringify(report)}\n`);
}

test("one data point per site, newest scan wins, percentiles over real sites", async () => {
  await writeReport(
    "20260601-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    makeResult({ firstPartyDomain: "one.example.dev", thirdPartyRequests: 10, scannedAt: "2026-06-01T00:00:00.000Z" })
  );
  await writeReport(
    "20260701-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    makeResult({ firstPartyDomain: "one.example.dev", thirdPartyRequests: 40, scannedAt: "2026-07-01T00:00:00.000Z" })
  );
  await writeReport(
    "20260701-cccccccccccccccccccccccccccccccc",
    makeResult({ firstPartyDomain: "two.example.dev", thirdPartyRequests: 20, scannedAt: "2026-07-01T00:00:00.000Z" })
  );

  const { stats, warnings } = await buildCorpusStats(reportsDir);
  assert.deepEqual(warnings, []);
  assert.equal(stats.sampleSize, 2);
  // one.example.dev contributes its NEWEST scan (40), not the older 10.
  assert.equal(stats.metrics.thirdPartyRequests?.max, 40);
  assert.equal(stats.metrics.thirdPartyRequests?.min, 20);
});

test("malformed reports are skipped with a warning, never zero-coerced into the distribution", async () => {
  await writeReport(
    "20260701-dddddddddddddddddddddddddddddddd",
    makeResult({ firstPartyDomain: "real.example.dev", thirdPartyRequests: 50 })
  );
  const malformed = makeResult({ firstPartyDomain: "broken.example.dev" }) as unknown as {
    summary: Record<string, unknown>;
  };
  malformed.summary.thirdPartyRequests = "many";
  await writeReport("20260701-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", malformed);

  const { stats, warnings } = await buildCorpusStats(reportsDir);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Skipping corpus report/);
  assert.equal(stats.sampleSize, 1);
  // The old numberOrZero path would have added a 0 here and pulled p50 down.
  assert.equal(stats.metrics.thirdPartyRequests?.min, 50);
});

test("error/block-page loads and reserved domains stay out of the distribution", async () => {
  await writeReport(
    "20260701-ffffffffffffffffffffffffffffffff",
    makeResult({ firstPartyDomain: "walled.example.dev", status: 403 })
  );
  await writeReport("20260701-abababababababababababababababab", makeResult({ firstPartyDomain: "example.com" }));

  const { stats, warnings } = await buildCorpusStats(reportsDir);
  assert.deepEqual(warnings, []);
  assert.equal(stats.sampleSize, 0);
});

test("request-capped runs stay out of the distribution: their counts are floors, not behavior", async () => {
  const capped = makeResult({ firstPartyDomain: "heavy.example.dev", thirdPartyRequests: 900 });
  capped.summary.totalRequests = 1200;
  await writeReport("20260701-dddddddddddddddddddddddddddddddd", capped);
  await writeReport(
    "20260701-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    makeResult({ firstPartyDomain: "light.example.dev", thirdPartyRequests: 20 })
  );

  const { stats, warnings } = await buildCorpusStats(reportsDir);
  assert.deepEqual(warnings, []);
  // Only the uncapped site contributes: a capped run's counts were cut off
  // mid-collection and would clamp the distribution's tail to the cap.
  assert.equal(stats.sampleSize, 1);
  assert.equal(stats.metrics.thirdPartyRequests?.max, 20);
});

test("a missing reports directory yields an empty distribution", async () => {
  const { stats } = await buildCorpusStats(path.join(reportsDir, "missing"));
  assert.equal(stats.sampleSize, 0);
  assert.deepEqual(stats.metrics, {});
});

test("null-status runs stay out of coverage and measurement: the main document never answered", async () => {
  const nullStatus = makeResult({ firstPartyDomain: "silent.example.dev" });
  nullStatus.summary = { ...nullStatus.summary, status: null };
  await writeReport("20260701-dddddddddddddddddddddddddddddddd", makeResult({ firstPartyDomain: "ok.example.dev" }));
  await writeReport("20260701-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", nullStatus);

  const { stats } = await buildCorpusStats(reportsDir);
  assert.equal(stats.sampleSize, 1);
  assert.equal(stats.coverageSiteCount, 1);
});

test("a consent-interaction arm is covered but never measured: accept-all is not a default visit", async () => {
  const acceptArm = makeResult({ firstPartyDomain: "consent.example.dev" });
  acceptArm.conditions = { ...acceptArm.conditions, consentMode: "accept-all" };
  await writeReport("20260701-ffffffffffffffffffffffffffffffff", makeResult({ firstPartyDomain: "ok.example.dev" }));
  await writeReport("20260701-abababababababababababababababab", acceptArm);

  const { stats } = await buildCorpusStats(reportsDir);
  assert.equal(stats.sampleSize, 1);
  // The site still counts as covered: it loaded, it is in the corpus.
  assert.equal(stats.coverageSiteCount, 2);
});
