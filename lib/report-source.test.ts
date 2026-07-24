import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { buildProvenanceEntry, committedSidecarFilename } from "./redaction-provenance";
import { redactScanReportV1 } from "./redact-scan-report-v1";
import { buildStaticReportShare } from "./report-locator";
import { readStoredReportForId } from "./report-source";
import { sha256Hex } from "./sha256";
import { SCAN_REPORT_SCHEMA_VERSION, type ScanResult } from "./types";

const STATIC_EXPORT_ENV = "NEXT_PUBLIC_SITE_BEHAVIOR_LAB_STATIC_EXPORT";

// Each test gets its own fake project root with a public/reports directory.
// The static-export flag keeps the share-store fallback out of these tests,
// so they exercise exactly the committed-report path.
let rootDir = "";

beforeEach(async () => {
  rootDir = await mkdtemp(path.join(tmpdir(), "sbl-report-source-"));
  await mkdir(path.join(rootDir, "public", "reports"), { recursive: true });
  process.env[STATIC_EXPORT_ENV] = "1";
});

afterEach(async () => {
  delete process.env[STATIC_EXPORT_ENV];
  await rm(rootDir, { recursive: true, force: true });
});

test("readStoredReportForId answers typed outcomes for committed reports", async () => {
  const missing = await readStoredReportForId("20260618-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", rootDir);
  assert.deepEqual(missing, { outcome: "not-found" });

  const invalidId = await readStoredReportForId("../escape", rootDir);
  assert.deepEqual(invalidId, { outcome: "not-found" });

  const corruptId = "20260618-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  await writeFile(path.join(rootDir, "public", "reports", `${corruptId}.json`), "{\n");
  assert.deepEqual(await readStoredReportForId(corruptId, rootDir), { outcome: "unreadable", error: "invalid" });

  // Deep-shape violation (null request entry): unreadable, never a crash later.
  const nullEntryId = "20260618-cccccccccccccccccccccccccccccccc";
  await writeFile(
    path.join(rootDir, "public", "reports", `${nullEntryId}.json`),
    `${JSON.stringify({ ...makeScanResult(), requests: [null] })}\n`
  );
  const nullEntryRead = await readStoredReportForId(nullEntryId, rootDir);
  assert.equal(nullEntryRead.outcome, "unreadable");

  const validId = "20260618-dddddddddddddddddddddddddddddddd";
  const report = makeScanResult();
  report.share = buildStaticReportShare(validId);
  const wire = await writeManagedReport(validId, report);
  const found = await readStoredReportForId(validId, rootDir);
  assert.equal(found.outcome, "found");
  if (found.outcome !== "found") throw new Error("expected found");
  assert.equal(found.origin, "committed");
  assert.equal(found.stored.schemaVersion, 1);
  // The wire is the committed bytes verbatim.
  assert.equal(found.wire, wire);
  assert.equal(found.wireSha256, sha256Hex(wire));
});

test("committed reports fail closed when their sidecar is missing or mismatched", async () => {
  const missingId = "20260618-11111111111111111111111111111111";
  const missingReport = redactScanReportV1(makeScanResult()).report;
  await writeFile(
    path.join(rootDir, "public", "reports", `${missingId}.json`),
    `${JSON.stringify(missingReport)}\n`
  );
  assert.deepEqual(await readStoredReportForId(missingId, rootDir), {
    outcome: "unreadable",
    error: "invalid"
  });

  const mismatchId = "20260618-22222222222222222222222222222222";
  await writeManagedReport(mismatchId, makeScanResult());
  const sidecarPath = path.join(rootDir, "public", "reports", committedSidecarFilename(mismatchId));
  const sidecar = JSON.parse(await readFile(sidecarPath, "utf8")) as Record<string, unknown>;
  await writeFile(sidecarPath, `${JSON.stringify({ ...sidecar, publicDigest: "0".repeat(64) })}\n`);
  assert.deepEqual(await readStoredReportForId(mismatchId, rootDir), {
    outcome: "unreadable",
    error: "invalid"
  });
});

test("a future schema version is a typed capability gap, not invalid data", async () => {
  const futureId = "20260618-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
  await writeFile(
    path.join(rootDir, "public", "reports", `${futureId}.json`),
    `${JSON.stringify({ schemaVersion: 3, reportType: "single" })}\n`
  );
  const read = await readStoredReportForId(futureId, rootDir);
  assert.equal(read.outcome, "unreadable");
  if (read.outcome !== "unreadable") throw new Error("expected unreadable");
  assert.equal(read.error, "unsupported-version");
});

function makeScanResult(): ScanResult {
  return {
    ok: true,
    schemaVersion: SCAN_REPORT_SCHEMA_VERSION,
    reportType: "single",
    summary: {
      pageTitle: "",
      status: 200,
      durationMs: 1,
      firstPartyDomain: "example.com",
      totalRequests: 0,
      thirdPartyRequests: 0,
      knownTrackerRequests: 0,
      thirdPartyDomains: 0,
      cookies: 0,
      thirdPartyCookies: 0,
      storageEntries: 0,
      fingerprintEvents: 0
    },
    conditions: {
      requestedUrl: "https://example.com/",
      finalUrl: "https://example.com/",
      scannedAt: new Date(0).toISOString(),
      chromiumVersion: "test",
      userAgent: "test",
      timezone: "UTC",
      locale: "en-US",
      language: "en-US",
      viewport: {
        width: 1440,
        height: 980,
        isMobile: false
      },
      gpcEnabled: false,
      consentMode: "observe",
      automation: "playwright-chromium",
      headless: true,
      scannerEgress: "test",
      trackerCatalog: {
        source: "test",
        version: "test",
        region: "test",
        entries: 0,
        curatedOverrides: 0,
        license: "test"
      },
      scannerDisclosure: "test"
    },
    requests: [],
    domains: [],
    cookies: [],
    storage: [],
    fingerprintEvents: [],
    screenshot: null,
    warnings: []
  };
}

async function writeManagedReport(id: string, input: ScanResult): Promise<string> {
  const report = redactScanReportV1(input).report;
  const wire = `${JSON.stringify(report)}\n`;
  const createdAt = report.conditions.scannedAt;
  const sidecar = buildProvenanceEntry({
    reportId: id,
    publicReport: report,
    writtenAt: "2026-07-12T00:00:00.000Z",
    createdAt,
    expiresAt: null
  });
  const reportsDir = path.join(rootDir, "public", "reports");
  await writeFile(path.join(reportsDir, `${id}.json`), wire);
  await writeFile(path.join(reportsDir, committedSidecarFilename(id)), `${JSON.stringify(sidecar)}\n`);
  return wire;
}
