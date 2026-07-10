import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { pruneStaticReports } from "./prune-static-reports";
import { makeScanReportV1 } from "./scan-report-v2-fixtures";
import type { ScanResult } from "./types";

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
  await writeFile(path.join(reportsDir, `${id}.json`), `${JSON.stringify(report)}\n`);
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
  assert.equal(remaining.length, 2);
});

test("a file the reader cannot read is never deleted", async () => {
  const now = Date.parse("2026-07-10T00:00:00.000Z");
  await writeFile(path.join(reportsDir, "20250101-dddddddddddddddddddddddddddddddd.json"), "{\n");
  await writeReport("20250101-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", { ...makeResult("two.example.dev", "2025-01-01T00:00:00.000Z"), requests: [null] });

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
