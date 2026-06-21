import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { createComparisonReport, createGpcComparisonReport } from "./compare-reports";
import { readScanReport, reportStoreStatus, saveScanReport } from "./report-store";
import { SCAN_REPORT_SCHEMA_VERSION, type ScanRequestPayload, type ScanResult } from "./types";

const REPORT_MAX_COUNT_ENV = "SITE_BEHAVIOR_LAB_REPORT_MAX_COUNT";
const REPORT_STORE_DIR_ENV = "SITE_BEHAVIOR_LAB_REPORT_STORE_DIR";

afterEach(async () => {
  delete process.env[REPORT_MAX_COUNT_ENV];
  delete process.env[REPORT_STORE_DIR_ENV];
  await rm(path.join(process.cwd(), ".site-behavior-lab"), { recursive: true, force: true });
});

test("readScanReport rejects invalid report IDs", async () => {
  const reportDir = path.join(process.cwd(), ".site-behavior-lab", "reports");
  await mkdir(reportDir, { recursive: true });
  await writeFile(path.join(reportDir, "20260618-12345678.json"), "{}\n");

  assert.equal(await readScanReport("../escape"), null);
  assert.equal(await readScanReport("20260618-not-hex"), null);
  assert.equal(await readScanReport("20260618-12345678"), null);
});

test("readScanReport rejects malformed persisted reports", async () => {
  const reportDir = path.join(process.cwd(), ".site-behavior-lab", "reports");
  await mkdir(reportDir, { recursive: true });

  const malformedShapeId = "20260618-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const malformedJsonId = "20260618-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  await writeFile(path.join(reportDir, `${malformedShapeId}.json`), "{}\n");
  await writeFile(path.join(reportDir, `${malformedJsonId}.json`), "{\n");

  assert.equal(await readScanReport(malformedShapeId), null);
  assert.equal(await readScanReport(malformedJsonId), null);
});

test("readScanReport rejects malformed comparison reports", async () => {
  const reportDir = path.join(process.cwd(), ".site-behavior-lab", "reports");
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

  assert.equal(await readScanReport(malformedComparisonId), null);
});

test("saveScanReport creates strongly random share IDs", async () => {
  const saved = await saveScanReport(makeScanResult());
  assert.match(saved.share?.id || "", /^[0-9]{8}-[0-9a-f]{32}$/);
});

test("saveScanReport can persist under a caller-supplied strong share ID", async () => {
  const shareId = "20260619-0123456789abcdef0123456789abcdef";
  const saved = await saveScanReport(makeScanResult(), { shareId });

  assert.equal(saved.share?.id, shareId);
  assert.equal(saved.share?.path, `/reports/${shareId}`);
  assert.deepEqual(await readScanReport(shareId), saved);
  await assert.rejects(() => saveScanReport(makeScanResult(), { shareId: "20260619-12345678" }), /Invalid report share id/);
});

test("saveScanReport keeps returned screenshots but strips persisted screenshots", async () => {
  const savedSingle = await saveScanReport(makeScanResult({ screenshot: "data:image/jpeg;base64,single" }));
  const persistedSingle = await readScanReport(savedSingle.share?.id || "");

  assert.equal(savedSingle.screenshot, "data:image/jpeg;base64,single");
  assert.ok(persistedSingle && persistedSingle.reportType !== "comparison");
  assert.equal(persistedSingle.screenshot, null);

  const comparison = createGpcComparisonReport(
    makeScanResult({ gpcEnabled: false, screenshot: "data:image/jpeg;base64,off" }),
    makeScanResult({ gpcEnabled: true, screenshot: "data:image/jpeg;base64,on" })
  );
  const savedComparison = await saveScanReport(comparison);
  const persistedComparison = await readScanReport(savedComparison.share?.id || "");

  assert.equal(savedComparison.baseline.screenshot, "data:image/jpeg;base64,off");
  assert.equal(savedComparison.variant.screenshot, "data:image/jpeg;base64,on");
  assert.equal(persistedComparison?.reportType, "comparison");
  if (persistedComparison?.reportType !== "comparison") throw new Error("expected comparison report");
  assert.equal(persistedComparison.baseline.screenshot, null);
  assert.equal(persistedComparison.variant.screenshot, null);
});

test("readScanReport accepts non-GPC comparison reports", async () => {
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
  const persisted = await readScanReport(saved.share?.id || "");

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

  await saveScanReport(makeScanResult());
  await saveScanReport(makeScanResult());
  await saveScanReport(makeScanResult());

  const reportDir = path.join(process.cwd(), ".site-behavior-lab", "reports");
  const files = (await readdir(reportDir)).filter((file) => file.endsWith(".json"));
  assert.equal(files.length, 2);
});

test("saveScanReport can use a configured report store directory", async () => {
  const reportDir = await mkdtemp(path.join(tmpdir(), "sbl-report-store-"));
  process.env[REPORT_STORE_DIR_ENV] = reportDir;

  try {
    const saved = await saveScanReport(makeScanResult());
    const files = (await readdir(reportDir)).filter((file) => file.endsWith(".json"));

    assert.equal(files.length, 1);
    assert.deepEqual(await readScanReport(saved.share?.id || ""), saved);
    assert.deepEqual(reportStoreStatus(), {
      kind: "filesystem",
      path: reportDir,
      configuredPath: true,
      maxAgeDays: 7,
      maxCount: 500
    });
  } finally {
    await rm(reportDir, { recursive: true, force: true });
  }
});

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
