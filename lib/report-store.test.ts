import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, readdir, rm, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { createComparisonReport, createGpcComparisonReport } from "./compare-reports";
import { buildProvenanceEntry, matchProvenance } from "./redaction-provenance";
import { pruneStoredReports, readStoredScanReportById, reportStoreStatus, saveScanReport } from "./report-store";
import { SCAN_REPORT_SCHEMA_VERSION, type ScanRequestPayload, type ScanResult } from "./types";

const REPORT_MAX_COUNT_ENV = "SITE_BEHAVIOR_LAB_REPORT_MAX_COUNT";
const REPORT_STORE_DIR_ENV = "SITE_BEHAVIOR_LAB_REPORT_STORE_DIR";

// Every test runs against its own temp directory via the store-dir env var.
// Never write to (or worse, delete) the repo's real `.site-behavior-lab`
// default store: a developer running the tests next to a dev server would
// lose their actual saved reports.
let reportDir = "";

beforeEach(async () => {
  reportDir = await mkdtemp(path.join(tmpdir(), "sbl-report-store-"));
  process.env[REPORT_STORE_DIR_ENV] = reportDir;
});

afterEach(async () => {
  delete process.env[REPORT_MAX_COUNT_ENV];
  delete process.env[REPORT_STORE_DIR_ENV];
  await rm(reportDir, { recursive: true, force: true });
});

// The old v1-narrowing readScanReport wrapper is gone (no production callers);
// these tests read through the typed accessor and narrow the same way.
async function readV1Report(id: string) {
  const result = await readStoredScanReportById(id);
  return result.outcome === "found" && result.stored.schemaVersion === 1 ? result.stored.report : null;
}

test("the stored-report read rejects invalid report IDs", async () => {
  await mkdir(reportDir, { recursive: true });
  await writeFile(path.join(reportDir, "20260618-12345678.json"), "{}\n");

  assert.equal(await readV1Report("../escape"), null);
  assert.equal(await readV1Report("20260618-not-hex"), null);
  assert.equal(await readV1Report("20260618-12345678"), null);
});

test("the stored-report read rejects malformed persisted reports", async () => {
  await mkdir(reportDir, { recursive: true });

  const malformedShapeId = "20260618-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const malformedJsonId = "20260618-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  await writeFile(path.join(reportDir, `${malformedShapeId}.json`), "{}\n");
  await writeFile(path.join(reportDir, `${malformedJsonId}.json`), "{\n");

  assert.equal(await readV1Report(malformedShapeId), null);
  assert.equal(await readV1Report(malformedJsonId), null);
});

test("the stored-report read rejects malformed comparison reports", async () => {
  await mkdir(reportDir, { recursive: true });

  const malformedComparisonId = "20260618-cccccccccccccccccccccccccccccccc";
  await writeFile(
    path.join(reportDir, `${malformedComparisonId}.json`),
    `${JSON.stringify({
      ok: true,
      schemaVersion: SCAN_REPORT_SCHEMA_VERSION,
      reportType: "comparison",
      comparisonType: "gpc",
      warnings: [],
      baseline: {},
      variant: {}
    })}\n`
  );

  assert.equal(await readV1Report(malformedComparisonId), null);
});

test("readStoredScanReportById answers typed outcomes instead of silent null", async () => {
  await mkdir(reportDir, { recursive: true });

  // Missing and expired reads are "not-found"; malformed bytes and deep-shape
  // violations are "unreadable", so callers can answer 404 vs 500 honestly.
  const missing = await readStoredScanReportById("20260618-dddddddddddddddddddddddddddddddd");
  assert.deepEqual(missing, { outcome: "not-found" });

  const corruptId = "20260618-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
  await writeFile(path.join(reportDir, `${corruptId}.json`), "{\n");
  assert.deepEqual(await readStoredScanReportById(corruptId), { outcome: "unreadable", error: "invalid" });

  // The exact shallow-validator escape that used to crash the request table:
  // arrays exist but an entry is null. The deep reader rejects it as typed.
  const nullEntryId = "20260618-ffffffffffffffffffffffffffffffff";
  const nullEntryReport = { ...makeScanResult(), requests: [null] };
  await writeFile(path.join(reportDir, `${nullEntryId}.json`), `${JSON.stringify(nullEntryReport)}\n`);
  const nullEntryRead = await readStoredScanReportById(nullEntryId);
  assert.equal(nullEntryRead.outcome, "unreadable");
  if (nullEntryRead.outcome !== "unreadable") throw new Error("expected unreadable");
  assert.equal(nullEntryRead.error, "invalid");

  const saved = await saveScanReport(makeScanResult());
  const found = await readStoredScanReportById(saved.share?.id || "");
  assert.equal(found.outcome, "found");
  if (found.outcome !== "found") throw new Error("expected found");
  assert.equal(found.stored.schemaVersion, 1);
  // The wire is the stored bytes verbatim, so API responses never re-serialize.
  assert.deepEqual(JSON.parse(found.wire), JSON.parse(JSON.stringify({ ...saved, screenshot: null })));
});

test("saveScanReport creates strongly random share IDs", async () => {
  const saved = await saveScanReport(makeScanResult());
  assert.match(saved.share?.id || "", /^[0-9]{8}-[0-9a-f]{32}$/);
});

test("saveScanReport writes a matched report, sidecar, and immutable retention clock", async () => {
  const saved = await saveScanReport(makeScanResult());
  const id = saved.share?.id || "";
  const report = JSON.parse(await readFile(path.join(reportDir, `${id}.json`), "utf8")) as unknown;
  const sidecar = JSON.parse(await readFile(path.join(reportDir, `${id}.provenance.json`), "utf8")) as {
    reportId: string;
    createdAt: string;
    expiresAt: string;
  };
  const retention = JSON.parse(await readFile(path.join(reportDir, `${id}.retention.json`), "utf8")) as {
    createdAt: string;
    expiresAt: string;
  };

  assert.equal(matchProvenance(report, sidecar, id).status, "matched");
  assert.deepEqual(retention, { createdAt: sidecar.createdAt, expiresAt: sidecar.expiresAt });
  assert.equal(Date.parse(retention.expiresAt) - Date.parse(retention.createdAt), 7 * 24 * 60 * 60 * 1_000);
});

test("saveScanReport writes report first and fails the share when sidecar creation fails", async () => {
  const shareId = "20260712-" + "c".repeat(32);
  await writeFile(path.join(reportDir, `${shareId}.provenance.json`), "{}\n");

  await assert.rejects(() => saveScanReport(makeScanResult(), { shareId }), /EEXIST/);
  await access(path.join(reportDir, `${shareId}.json`));
  await access(path.join(reportDir, `${shareId}.retention.json`));
  assert.deepEqual(await readStoredScanReportById(shareId), { outcome: "unreadable", error: "invalid" });
});

test("missing provenance or retention metadata makes an existing report unreadable", async () => {
  const withoutSidecar = await saveScanReport(makeScanResult());
  const sidecarId = withoutSidecar.share?.id || "";
  await unlink(path.join(reportDir, `${sidecarId}.provenance.json`));
  assert.deepEqual(await readStoredScanReportById(sidecarId), { outcome: "unreadable", error: "invalid" });

  const withoutRetention = await saveScanReport(makeScanResult());
  const retentionId = withoutRetention.share?.id || "";
  await unlink(path.join(reportDir, `${retentionId}.retention.json`));
  assert.deepEqual(await readStoredScanReportById(retentionId), { outcome: "unreadable", error: "invalid" });
});

test("saveScanReport can persist under a caller-supplied strong share ID", async () => {
  const shareId = "20260619-0123456789abcdef0123456789abcdef";
  const saved = await saveScanReport(makeScanResult(), { shareId });

  assert.equal(saved.share?.id, shareId);
  assert.equal(saved.share?.path, `/reports/${shareId}`);
  assert.deepEqual(await readV1Report(shareId), saved);
  await assert.rejects(() => saveScanReport(makeScanResult(), { shareId: "20260619-12345678" }), /Invalid report share id/);
});

test("saveScanReport keeps returned screenshots but strips persisted screenshots", async () => {
  const savedSingle = await saveScanReport(makeScanResult({ screenshot: "data:image/jpeg;base64,single" }));
  const persistedSingle = await readV1Report(savedSingle.share?.id || "");

  assert.equal(savedSingle.screenshot, "data:image/jpeg;base64,single");
  assert.ok(persistedSingle && persistedSingle.reportType !== "comparison");
  assert.equal(persistedSingle.screenshot, null);

  const comparison = createGpcComparisonReport(
    makeScanResult({ gpcEnabled: false, screenshot: "data:image/jpeg;base64,off" }),
    makeScanResult({ gpcEnabled: true, screenshot: "data:image/jpeg;base64,on" })
  );
  const savedComparison = await saveScanReport(comparison);
  const persistedComparison = await readV1Report(savedComparison.share?.id || "");

  assert.equal(savedComparison.baseline.screenshot, "data:image/jpeg;base64,off");
  assert.equal(savedComparison.variant.screenshot, "data:image/jpeg;base64,on");
  assert.equal(persistedComparison?.reportType, "comparison");
  if (persistedComparison?.reportType !== "comparison") throw new Error("expected comparison report");
  assert.equal(persistedComparison.baseline.screenshot, null);
  assert.equal(persistedComparison.variant.screenshot, null);
});

test("the stored-report read accepts non-GPC comparison reports", async () => {
  const comparison = createComparisonReport({
    comparisonType: "shields",
    title: "Shields off/on comparison",
    runLabels: {
      baseline: "Shields off",
      variant: "Shields on"
    },
    baseline: makeScanResult(),
    variant: makeScanResult(),
    warningPrefix: "Sequential Shields comparison."
  });

  const saved = await saveScanReport(comparison);
  const persisted = await readV1Report(saved.share?.id || "");

  assert.equal(persisted?.reportType, "comparison");
  if (persisted?.reportType !== "comparison") throw new Error("expected comparison report");
  assert.equal(persisted.comparisonType, "shields");
  assert.deepEqual(persisted.runLabels, {
    baseline: "Shields off",
    variant: "Shields on"
  });
});

test("saveScanReport prunes persisted reports by max count", async () => {
  process.env[REPORT_MAX_COUNT_ENV] = "2";

  const saved = [
    await saveScanReport(makeScanResult()),
    await saveScanReport(makeScanResult()),
    await saveScanReport(makeScanResult())
  ];

  const files = await readdir(reportDir);
  assert.equal(files.filter(isReportFile).length, 2);
  assert.equal(files.filter((file) => file.endsWith(".provenance.json")).length, 2);
  assert.equal(files.filter((file) => file.endsWith(".retention.json")).length, 2);

  let completeBundles = 0;
  let removedBundles = 0;
  for (const report of saved) {
    const id = report.share?.id || "";
    const bundle = [
      `${id}.json`,
      `${id}.provenance.json`,
      `${id}.retention.json`
    ].map((file) => files.includes(file));
    assert.ok(bundle.every((present) => present === bundle[0]), `partial report bundle for ${id}`);
    if (bundle[0]) completeBundles += 1;
    else removedBundles += 1;
  }
  assert.equal(completeBundles, 2);
  assert.equal(removedBundles, 1);
});

test("pruning uses immutable expiry metadata, never a rewritten report mtime", async () => {
  const saved = await saveScanReport(makeScanResult());
  const id = saved.share?.id || "";
  const reportPath = path.join(reportDir, `${id}.json`);
  const report = JSON.parse(await readFile(reportPath, "utf8")) as unknown;
  const retention = {
    createdAt: "2026-06-01T00:00:00.000Z",
    expiresAt: "2026-06-08T00:00:00.000Z"
  };
  await writeFile(path.join(reportDir, `${id}.retention.json`), `${JSON.stringify(retention)}\n`);
  await writeFile(
    path.join(reportDir, `${id}.provenance.json`),
    `${JSON.stringify(
      buildProvenanceEntry({
        reportId: id,
        publicReport: report,
        writtenAt: "2026-07-12T00:00:00.000Z",
        createdAt: retention.createdAt,
        expiresAt: retention.expiresAt
      })
    )}\n`
  );
  const rewrittenAt = new Date("2030-01-01T00:00:00.000Z");
  await utimes(reportPath, rewrittenAt, rewrittenAt);

  await pruneStoredReports(Date.parse("2026-07-12T00:00:00.000Z"));
  await assert.rejects(() => access(reportPath), /ENOENT/);
  await assert.rejects(() => access(path.join(reportDir, `${id}.provenance.json`)), /ENOENT/);
  await assert.rejects(() => access(path.join(reportDir, `${id}.retention.json`)), /ENOENT/);
});

test("saveScanReport reports the configured report store directory in its status", async () => {
  const saved = await saveScanReport(makeScanResult());
  const files = (await readdir(reportDir)).filter(isReportFile);

  assert.equal(files.length, 1);
  assert.deepEqual(await readV1Report(saved.share?.id || ""), saved);
  assert.deepEqual(reportStoreStatus(), {
    kind: "filesystem",
    path: reportDir,
    configuredPath: true,
    maxAgeDays: 7,
    maxCount: 500
  });
});

function isReportFile(file: string): boolean {
  return /^[0-9]{8}-[0-9a-f]{32}\.json$/.test(file);
}

function makeScanResult(options: { gpcEnabled?: boolean; screenshot?: string | null } = {}): ScanResult {
  const payload: ScanRequestPayload = {
    url: "https://example.com/",
    device: "desktop",
    gpcEnabled: options.gpcEnabled ?? true,
    consentMode: "observe"
  };

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
      requestedUrl: payload.url,
      finalUrl: payload.url,
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
      gpcEnabled: payload.gpcEnabled,
      consentMode: payload.consentMode,
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
    screenshot: options.screenshot ?? null,
    warnings: []
  };
}
