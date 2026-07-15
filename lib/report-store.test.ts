import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, readdir, rm, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { createComparisonReport, createGpcComparisonReport } from "./compare-reports";
import { buildProvenanceEntry, matchProvenance } from "./redaction-provenance";
import { REDACTION_VERSION } from "./redaction-v2";
import { pruneStoredReports, readStoredScanReportById, reportStoreStatus, saveScanReport } from "./report-store";
import { makeGpcInterventionReportV2R2, makePublicSingleReportV2R2 } from "./scan-report-v2-r2-fixtures";
import { NODE_SCAN_REPORT_V2_R2_MAX_PUBLIC_BYTES } from "./scan-report-v2-r2-limits";
import { toPublicScanReportR2 } from "./scan-report-v2-r2-projection";
import type { EphemeralComparisonReportR2, EphemeralSingleReportR2 } from "./scan-report-v2-r2";
import { SCAN_REPORT_SCHEMA_VERSION, type ScanRequestPayload, type ScanResult } from "./types";

const REPORT_MAX_COUNT_ENV = "SITE_BEHAVIOR_LAB_REPORT_MAX_COUNT";
const REPORT_MIN_SURVIVAL_MS_ENV = "SITE_BEHAVIOR_LAB_REPORT_MIN_SURVIVAL_MS";
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
  delete process.env[REPORT_MIN_SURVIVAL_MS_ENV];
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

test("failed report or sidecar creation cleans up owned partial bundles without accumulation", async () => {
  for (const suffix of ["c", "d", "e"]) {
    const shareId = `20260712-${suffix.repeat(32)}`;
    await writeFile(path.join(reportDir, `${shareId}.provenance.json`), "{}\n");

    await assert.rejects(() => saveScanReport(makeScanResult(), { shareId }), /EEXIST/);
    assert.deepEqual(await readStoredScanReportById(shareId), { outcome: "not-found" });
    assert.deepEqual(await readdir(reportDir), []);
  }

  // A filesystem report write is itself two create-only files. If the report
  // lands but retention creation conflicts, the backend owns and rolls back
  // that report rather than leaving a permanently uncommitted object.
  const retentionConflictId = `20260712-${"f".repeat(32)}`;
  await writeFile(path.join(reportDir, `${retentionConflictId}.retention.json`), "{}\n");
  await assert.rejects(() => saveScanReport(makeScanResult(), { shareId: retentionConflictId }), /EEXIST/);
  assert.deepEqual(await readdir(reportDir), []);
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

test("saveScanReport attaches shares to ephemeral r2 responses and persists only public projections", async () => {
  const singlePublic = makePublicSingleReportV2R2();
  singlePublic.run.privacy.redactionVersion = REDACTION_VERSION;
  const single: EphemeralSingleReportR2 = {
    ...singlePublic,
    ephemeral: { screenshot: "data:image/png;base64,R2_SINGLE_PRIVATE" }
  };
  const savedSingle = await saveScanReport(single);
  assert.match(savedSingle.share?.id ?? "", /^[0-9]{8}-[0-9a-f]{32}$/);
  assert.equal(savedSingle.ephemeral.screenshot, "data:image/png;base64,R2_SINGLE_PRIVATE");

  const storedSingle = await readStoredScanReportById(savedSingle.share?.id ?? "");
  assert.equal(storedSingle.outcome, "found");
  if (storedSingle.outcome !== "found") throw new Error("expected stored r2 single");
  assert.equal(storedSingle.stored.schemaVersion, 2);
  assert.equal(storedSingle.wire.includes("R2_SINGLE_PRIVATE"), false);
  assert.equal("ephemeral" in JSON.parse(storedSingle.wire), false);
  assert.equal(storedSingle.stored.report.share?.id, savedSingle.share?.id);

  const comparisonPublic = makeGpcInterventionReportV2R2();
  comparisonPublic.baseline.privacy.redactionVersion = REDACTION_VERSION;
  comparisonPublic.variant.privacy.redactionVersion = REDACTION_VERSION;
  const comparison: EphemeralComparisonReportR2 = {
    ...comparisonPublic,
    ephemeral: {
      baselineScreenshot: "data:image/png;base64,R2_BASELINE_PRIVATE",
      variantScreenshot: "data:image/png;base64,R2_VARIANT_PRIVATE"
    }
  };
  const savedComparison = await saveScanReport(comparison);
  assert.equal(savedComparison.ephemeral.baselineScreenshot, "data:image/png;base64,R2_BASELINE_PRIVATE");
  assert.equal(savedComparison.ephemeral.variantScreenshot, "data:image/png;base64,R2_VARIANT_PRIVATE");
  assert.match(savedComparison.share?.id ?? "", /^[0-9]{8}-[0-9a-f]{32}$/);

  const storedComparison = await readStoredScanReportById(savedComparison.share?.id ?? "");
  assert.equal(storedComparison.outcome, "found");
  if (storedComparison.outcome !== "found") throw new Error("expected stored r2 comparison");
  assert.equal(storedComparison.stored.schemaVersion, 2);
  assert.equal(storedComparison.wire.includes("R2_BASELINE_PRIVATE"), false);
  assert.equal(storedComparison.wire.includes("R2_VARIANT_PRIVATE"), false);
  assert.equal("ephemeral" in JSON.parse(storedComparison.wire), false);
  assert.equal(storedComparison.stored.report.share?.id, savedComparison.share?.id);
});

test("saveScanReport enforces the r2 byte cap after attaching a share and writes nothing", async () => {
  const publicReport = makePublicSingleReportV2R2();
  publicReport.run.privacy.redactionVersion = REDACTION_VERSION;
  publicReport.run.warnings = [""];
  const report: EphemeralSingleReportR2 = {
    ...publicReport,
    ephemeral: { screenshot: null }
  };
  const emptyWarningBytes = Buffer.byteLength(
    `${JSON.stringify(toPublicScanReportR2(report), null, 2)}\n`,
    "utf8"
  );
  report.run.warnings = ["x".repeat(NODE_SCAN_REPORT_V2_R2_MAX_PUBLIC_BYTES - emptyWarningBytes - 16)];
  const preShareBytes = Buffer.byteLength(
    `${JSON.stringify(toPublicScanReportR2(report), null, 2)}\n`,
    "utf8"
  );
  assert.ok(preShareBytes <= NODE_SCAN_REPORT_V2_R2_MAX_PUBLIC_BYTES);

  await assert.rejects(
    () => saveScanReport(report),
    new RegExp(`larger than ${NODE_SCAN_REPORT_V2_R2_MAX_PUBLIC_BYTES} public bytes after attaching its share`)
  );
  assert.deepEqual(await readdir(reportDir), []);
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
  process.env[REPORT_MIN_SURVIVAL_MS_ENV] = "0";

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

test("concurrent successful saves remain live through a bounded max-count survival grace", async () => {
  process.env[REPORT_MAX_COUNT_ENV] = "1";
  const firstId = `20260714-${"a".repeat(32)}`;
  const secondId = `20260714-${"b".repeat(32)}`;

  const [first, second] = await Promise.all([
    saveScanReport(makeScanResult(), { shareId: firstId }),
    saveScanReport(makeScanResult(), { shareId: secondId })
  ]);

  assert.equal(first.share?.id, firstId);
  assert.equal(second.share?.id, secondId);
  assert.equal((await readStoredScanReportById(firstId)).outcome, "found");
  assert.equal((await readStoredScanReportById(secondId)).outcome, "found");
  assert.deepEqual((await readdir(reportDir)).sort(), [
    `${firstId}.json`,
    `${firstId}.provenance.json`,
    `${firstId}.retention.json`,
    `${secondId}.json`,
    `${secondId}.provenance.json`,
    `${secondId}.retention.json`
  ]);

  // The max-count cap converges after the short return-safety window.
  await pruneStoredReports(Date.now() + 10 * 60 * 1_000);
  assert.equal((await readStoredScanReportById(firstId)).outcome, "not-found");
  assert.equal((await readStoredScanReportById(secondId)).outcome, "found");
});

test("count pruning never age-deletes a report while another process delays its sidecar", async () => {
  process.env[REPORT_MAX_COUNT_ENV] = "1";
  const existing = await saveScanReport(makeScanResult());
  const existingId = existing.share?.id || "";
  const retention = JSON.parse(await readFile(path.join(reportDir, `${existingId}.retention.json`), "utf8")) as {
    createdAt: string;
    expiresAt: string;
  };
  const inFlightId = `20260714-${"f".repeat(32)}`;
  const existingPublicReport = JSON.parse(
    await readFile(path.join(reportDir, `${existingId}.json`), "utf8")
  ) as Record<string, unknown>;
  const inFlightReport = {
    ...existingPublicReport,
    share: {
      id: inFlightId,
      path: `/reports/${inFlightId}`,
      jsonPath: `/api/reports/${inFlightId}`
    }
  };
  await writeFile(path.join(reportDir, `${inFlightId}.json`), `${JSON.stringify(inFlightReport, null, 2)}\n`);
  await writeFile(path.join(reportDir, `${inFlightId}.retention.json`), `${JSON.stringify(retention)}\n`);

  // A competing process that loses the create-only report race must not run
  // owned cleanup against the winner while its sidecar is deliberately held.
  await assert.rejects(() => saveScanReport(makeScanResult(), { shareId: inFlightId }), /EEXIST/);
  await access(path.join(reportDir, `${inFlightId}.json`));
  await access(path.join(reportDir, `${inFlightId}.retention.json`));

  // This is well beyond the old 15-minute foreground cleanup grace. Wall-clock
  // age cannot prove that another process crashed, so the report must survive.
  const now = Date.parse(retention.createdAt) + 24 * 60 * 60 * 1_000;
  await pruneStoredReports(now);
  assert.equal((await readStoredScanReportById(existingId)).outcome, "found");
  await access(path.join(reportDir, `${inFlightId}.json`));

  await writeFile(
    path.join(reportDir, `${inFlightId}.provenance.json`),
    `${JSON.stringify(
      buildProvenanceEntry({
        reportId: inFlightId,
        publicReport: inFlightReport,
        writtenAt: retention.createdAt,
        createdAt: retention.createdAt,
        expiresAt: retention.expiresAt
      })
    )}\n`
  );
  await pruneStoredReports(now);

  assert.equal((await readStoredScanReportById(existingId)).outcome, "not-found");
  assert.equal((await readStoredScanReportById(inFlightId)).outcome, "found");
});

test("report-only bundles are retained while delayed and removed at immutable expiry", async () => {
  const saved = await saveScanReport(makeScanResult());
  const id = saved.share?.id || "";
  const reportPath = path.join(reportDir, `${id}.json`);
  const retentionPath = path.join(reportDir, `${id}.retention.json`);
  const retention = JSON.parse(await readFile(retentionPath, "utf8")) as {
    createdAt: string;
    expiresAt: string;
  };
  await unlink(path.join(reportDir, `${id}.provenance.json`));

  await pruneStoredReports(Date.parse(retention.createdAt) + 24 * 60 * 60 * 1_000);
  await access(reportPath);
  await access(retentionPath);

  await pruneStoredReports(Date.parse(retention.expiresAt));
  await assert.rejects(() => access(reportPath), /ENOENT/);
  await assert.rejects(() => access(retentionPath), /ENOENT/);
});

test("pruning surfaces and reconciles a sidecar-only deletion orphan", async () => {
  const orphanId = `20260714-${"e".repeat(32)}`;
  const orphanPath = path.join(reportDir, `${orphanId}.provenance.json`);
  await writeFile(orphanPath, "{}\n");

  await pruneStoredReports();
  await assert.rejects(() => access(orphanPath), /ENOENT/);
  assert.deepEqual(await readdir(reportDir), []);
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
