import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { buildCorpusStats } from "./corpus-stats-builder";
import { buildProvenanceEntry, committedSidecarFilename } from "./redaction-provenance";
import { redactScanReportV1 } from "./redact-scan-report-v1";
import { REDACTION_VERSION } from "./redaction-v2";
import { buildStaticReportShare } from "./report-locator";
import { makePublicSingleReportV2R2 } from "./scan-report-v2-r2-fixtures";
import { makeScanReportV1 } from "./scan-report-v2-fixtures";
import type { ScanReport, ScanResult } from "./types";

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
  const thirdPartyRequests = overrides.thirdPartyRequests ?? base.summary.thirdPartyRequests;
  return {
    ...base,
    requests:
      overrides.thirdPartyRequests === undefined
        ? base.requests
        : Array.from({ length: thirdPartyRequests }, (_, index) => ({
            id: index + 1,
            url: `https://tracker.example.net/privacy?utm_source=${index}`,
            domain: "tracker.example.net",
            method: "GET",
            resourceType: "image",
            status: 200,
            thirdParty: true,
            tracker: null,
            startedAtMs: index
          })),
    summary: {
      ...base.summary,
      firstPartyDomain: overrides.firstPartyDomain ?? "shop-fixture.dev",
      totalRequests: overrides.thirdPartyRequests === undefined ? base.summary.totalRequests : thirdPartyRequests,
      thirdPartyRequests,
      status: overrides.status ?? base.summary.status
    },
    conditions: {
      ...base.conditions,
      scannedAt: overrides.scannedAt ?? base.conditions.scannedAt
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
  await writeFile(path.join(reportsDir, `${id}.json`), `${JSON.stringify(report)}\n`);
  const value = report as { scannedAt?: unknown; conditions?: { scannedAt?: unknown } };
  const createdAt = value.scannedAt ?? value.conditions?.scannedAt;
  if (typeof createdAt !== "string") throw new Error("fixture needs a recorded scan time");
  const sidecar = buildProvenanceEntry({
    reportId: id,
    publicReport: report,
    writtenAt: "2026-07-12T00:00:00.000Z",
    createdAt,
    expiresAt: null
  });
  await writeFile(path.join(reportsDir, committedSidecarFilename(id)), `${JSON.stringify(sidecar)}\n`);
}

test("one data point per site, newest scan wins, percentiles over real sites", async () => {
  await writeReport(
    "20260601-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    makeResult({ firstPartyDomain: "one-fixture.dev", thirdPartyRequests: 10, scannedAt: "2026-06-01T00:00:00.000Z" })
  );
  await writeReport(
    "20260701-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    makeResult({ firstPartyDomain: "one-fixture.dev", thirdPartyRequests: 40, scannedAt: "2026-07-01T00:00:00.000Z" })
  );
  await writeReport(
    "20260701-cccccccccccccccccccccccccccccccc",
    makeResult({ firstPartyDomain: "two-fixture.dev", thirdPartyRequests: 20, scannedAt: "2026-07-01T00:00:00.000Z" })
  );

  const { stats, warnings } = await buildCorpusStats(reportsDir);
  assert.deepEqual(warnings, []);
  assert.equal(stats.sampleSize, 2);
  // one-fixture.dev contributes its NEWEST scan (40), not the older 10.
  assert.equal(stats.metrics.thirdPartyRequests?.max, 40);
  assert.equal(stats.metrics.thirdPartyRequests?.min, 20);
});

test("redacted and unredacted host labels collapse to one corpus site", async () => {
  await writeReport(
    "20260601-12121212121212121212121212121212",
    makeResult({ firstPartyDomain: "mit.edu", thirdPartyRequests: 10, scannedAt: "2026-06-01T00:00:00.000Z" })
  );
  await writeReport(
    "20260701-34343434343434343434343434343434",
    makeResult({ firstPartyDomain: "{label}.mit.edu", thirdPartyRequests: 40, scannedAt: "2026-07-01T00:00:00.000Z" })
  );
  await writeReport(
    "20260701-56565656565656565656565656565656",
    makeResult({ firstPartyDomain: "stanford.edu", thirdPartyRequests: 20, scannedAt: "2026-07-01T00:00:00.000Z" })
  );

  const { stats } = await buildCorpusStats(reportsDir);
  assert.equal(stats.sampleSize, 2);
  assert.equal(stats.coverageSiteCount, 2);
  assert.equal(stats.metrics.thirdPartyRequests?.max, 40, "the newest marked MIT report wins");
});

test("a loaded v2 site stays covered even though its metrics are never measured", async () => {
  await writeReport(
    "20260701-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    makeResult({ firstPartyDomain: "legacy-fixture.dev", thirdPartyRequests: 20 })
  );

  const id = "20260710-cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd";
  const r2 = makePublicSingleReportV2R2();
  const subject = { origin: "https://covered-fixture.dev", registrableDomain: "covered-fixture.dev", routeShape: "/" };
  r2.run.subject = { requested: subject, observed: { ...subject } };
  r2.run.privacy.redactionVersion = REDACTION_VERSION;
  r2.share = buildStaticReportShare(id);
  await writeFile(path.join(reportsDir, `${id}.json`), `${JSON.stringify(r2, null, 2)}\n`);
  await writeFile(
    path.join(reportsDir, committedSidecarFilename(id)),
    `${JSON.stringify(
      buildProvenanceEntry({
        reportId: id,
        publicReport: r2,
        writtenAt: "2026-07-14T00:00:00.000Z",
        createdAt: r2.run.startedAt,
        expiresAt: null
      })
    )}\n`
  );

  const { stats } = await buildCorpusStats(reportsDir);
  // Coverage must not shrink as a site's newest evidence migrates from v1 to
  // v2: the v2 site loaded, so it is covered; only measurement stays v1-only.
  assert.equal(stats.sampleSize, 1);
  assert.equal(stats.coverageSiteCount, 2);
});

test("r2 reports remain visible to the corpus but never enter the legacy v1 percentile cohort", async () => {
  await writeReport(
    "20260701-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    makeResult({ firstPartyDomain: "legacy-fixture.dev", thirdPartyRequests: 20 })
  );

  const id = "20260710-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const r2 = makePublicSingleReportV2R2();
  r2.run.privacy.redactionVersion = REDACTION_VERSION;
  r2.share = buildStaticReportShare(id);
  await writeFile(path.join(reportsDir, `${id}.json`), `${JSON.stringify(r2, null, 2)}\n`);
  await writeFile(
    path.join(reportsDir, committedSidecarFilename(id)),
    `${JSON.stringify(
      buildProvenanceEntry({
        reportId: id,
        publicReport: r2,
        writtenAt: "2026-07-12T00:00:00.000Z",
        createdAt: r2.run.startedAt,
        expiresAt: null
      })
    )}\n`
  );

  const { stats, warnings } = await buildCorpusStats(reportsDir);
  assert.equal(stats.sampleSize, 1);
  assert.equal(stats.metrics.thirdPartyRequests?.min, 20);
  assert.equal(stats.metrics.thirdPartyRequests?.max, 20);
  // The fixture's subject is the reserved example.com, so it stays out of
  // coverage exactly as a reserved v1 report would.
  assert.equal(stats.coverageSiteCount, 1);
  assert.deepEqual(warnings, [
    `Skipping corpus report ${id}.json: schemaVersion 2 metrics are not comparable to the v1 distribution.`
  ]);
});

test("malformed reports fail the managed corpus build, never zero-coerce into the distribution", async () => {
  await writeReport(
    "20260701-dddddddddddddddddddddddddddddddd",
    makeResult({ firstPartyDomain: "real-fixture.dev", thirdPartyRequests: 50 })
  );
  const malformed = makeResult({ firstPartyDomain: "broken-fixture.dev" }) as unknown as {
    summary: Record<string, unknown>;
  };
  malformed.summary.thirdPartyRequests = "many";
  await writeRawManagedReport("20260701-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", malformed);

  await assert.rejects(() => buildCorpusStats(reportsDir), /invalid-report/);
});

test("error/block-page loads and reserved domains stay out of the distribution", async () => {
  await writeReport(
    "20260701-ffffffffffffffffffffffffffffffff",
    makeResult({ firstPartyDomain: "walled-fixture.dev", status: 403 })
  );
  await writeReport("20260701-abababababababababababababababab", makeResult({ firstPartyDomain: "example.com" }));

  const { stats, warnings } = await buildCorpusStats(reportsDir);
  assert.deepEqual(warnings, []);
  assert.equal(stats.sampleSize, 0);
});

test("request-capped runs stay out of the distribution: their counts are floors, not behavior", async () => {
  const capped = makeResult({ firstPartyDomain: "heavy-fixture.dev", thirdPartyRequests: 900 });
  capped.summary.totalRequests = 1200;
  capped.warnings = ["The scan stopped recording or loading additional requests after 1000 requests."];
  await writeReport("20260701-dddddddddddddddddddddddddddddddd", capped);
  await writeReport(
    "20260701-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    makeResult({ firstPartyDomain: "light-fixture.dev", thirdPartyRequests: 20 })
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
  const nullStatus = makeResult({ firstPartyDomain: "silent-fixture.dev" });
  nullStatus.summary = { ...nullStatus.summary, status: null };
  await writeReport("20260701-dddddddddddddddddddddddddddddddd", makeResult({ firstPartyDomain: "ok-fixture.dev" }));
  await writeReport("20260701-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", nullStatus);

  const { stats } = await buildCorpusStats(reportsDir);
  assert.equal(stats.sampleSize, 1);
  assert.equal(stats.coverageSiteCount, 1);
});

test("a consent-interaction arm is covered but never measured: accept-all is not a default visit", async () => {
  const acceptArm = makeResult({ firstPartyDomain: "consent-fixture.dev" });
  acceptArm.conditions = { ...acceptArm.conditions, consentMode: "accept-all" };
  await writeReport("20260701-ffffffffffffffffffffffffffffffff", makeResult({ firstPartyDomain: "ok-fixture.dev" }));
  await writeReport("20260701-abababababababababababababababab", acceptArm);

  const { stats } = await buildCorpusStats(reportsDir);
  assert.equal(stats.sampleSize, 1);
  // The site still counts as covered: it loaded, it is in the corpus.
  assert.equal(stats.coverageSiteCount, 2);
});

test("missing or mismatched sidecars fail the corpus build", async () => {
  const missingId = "20260701-11111111111111111111111111111111";
  const report = redactScanReportV1(makeResult()).report;
  await writeFile(path.join(reportsDir, `${missingId}.json`), `${JSON.stringify(report)}\n`);
  await assert.rejects(() => buildCorpusStats(reportsDir), /no-sidecar/);

  await rm(path.join(reportsDir, `${missingId}.json`));
  const mismatchId = "20260701-22222222222222222222222222222222";
  await writeReport(mismatchId, makeResult());
  const sidecarPath = path.join(reportsDir, committedSidecarFilename(mismatchId));
  const sidecar = JSON.parse(await readFile(sidecarPath, "utf8")) as Record<string, unknown>;
  await writeFile(sidecarPath, `${JSON.stringify({ ...sidecar, redactionVersion: 999 })}\n`);
  await assert.rejects(() => buildCorpusStats(reportsDir), /redaction-version-mismatch/);
});
