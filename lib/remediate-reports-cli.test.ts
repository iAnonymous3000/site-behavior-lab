import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { createGpcComparisonReport } from "./compare-reports";
import { readManagedReport } from "./managed-report-reader";
import { SERVER_STORED_REPORT_JSON_MAX_BYTES } from "./report-resource-limits";
import { redactScanReportV1 } from "./redact-scan-report-v1";
import {
  parseRemediationMode,
  remediateReports,
  RemediationCheckError,
  RemediationConflictError,
  RemediationPreflightError
} from "./remediate-reports-cli";
import {
  acquireReportCorpusLock,
  REPORT_CORPUS_LOCK_FILENAME,
  ReportCorpusLockedError
} from "./report-corpus-lock";
import { buildProvenanceEntry, committedSidecarFilename, matchProvenance } from "./redaction-provenance";
import { REDACTION_VERSION } from "./redaction-v2";
import { REDACTION_TRANSITION_AUDIT_VERSION } from "./redaction-transition-audit";
import { buildStaticReportShare } from "./report-locator";
import {
  MIGRATABLE_REDACTION_V3_NORMALIZATIONS,
  REDACTION_V3_TO_V4_NORMALIZATION_SUFFIX
} from "./scan-report-v2-normalization";
import { buildFingerprints } from "./scan-report-v2-fingerprints";
import {
  makePublicSingleReportV2R2,
  makeSupportingPairInterventionReportV2R2
} from "./scan-report-v2-r2-fixtures";
import {
  MIGRATABLE_REDACTION_VERSION,
  r2ReportRuns
} from "./scan-report-v2-r2-remediation";
import {
  HISTORICAL_NODE_R2_V3_ADBLOCK_ENGINE_VERSION,
  HISTORICAL_NODE_R2_V3_DETECTOR_REGISTRY_DIGEST,
  HISTORICAL_NODE_R2_V3_DETECTOR_REGISTRY_VERSION,
  HISTORICAL_NODE_R2_V3_DETECTOR_VERSIONS,
  HISTORICAL_NODE_R2_V3_METHODOLOGY_VERSION,
  HISTORICAL_NODE_R2_V3_TRACKER_CATALOG
} from "./scan-report-v2-r2-producer-contract";
import type { ScanRunV2R2 } from "./scan-report-v2-r2";
import { makePublicSingleReportV2, makeScanReportV1 } from "./scan-report-v2-fixtures";
import type { ScanReport, ScanResult } from "./types";

const WRITTEN_AT = "2026-07-12T20:00:00.000Z";
const LATER_WRITTEN_AT = "2026-07-13T20:00:00.000Z";
const tempDirectories: string[] = [];

after(async () => {
  await Promise.all(tempDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
});

test("dry-run is the default and never mutates reports or sidecars", async () => {
  const reportsDir = await makeReportsDirectory();
  const id = reportId("a");
  const report = sensitiveSingle(id);
  const originalWire = `${JSON.stringify(report)}\n`;
  await writeFile(reportPath(reportsDir, id), originalWire);

  const summary = await remediateReports({ reportsDir, writtenAt: WRITTEN_AT });

  assert.equal(summary.mode, "dry-run");
  assert.equal(summary.reports, 1);
  assert.equal(summary.reportChanges, 1);
  assert.equal(summary.sidecarsWritten, 0);
  assert.equal(await readFile(reportPath(reportsDir, id), "utf8"), originalWire);
  await assert.rejects(() => readFile(sidecarPath(reportsDir, id), "utf8"), /ENOENT/);
  assert.equal((await readdir(reportsDir)).includes(REPORT_CORPUS_LOCK_FILENAME), false);
});

test("apply preserves report identity and clocks, uses one writtenAt, and is report-idempotent", async () => {
  const reportsDir = await makeReportsDirectory();
  const singleId = reportId("b");
  const comparisonId = reportId("c");
  const single = sensitiveSingle(singleId);
  const comparison = sensitiveComparison(comparisonId);
  const originalSingleShare = structuredClone(single.share);
  const originalComparisonShare = structuredClone(comparison.share);
  const originalSingleScannedAt = single.conditions.scannedAt;
  const originalComparisonScannedAt = comparison.scannedAt;
  const originalBaselineScannedAt = comparison.baseline.conditions.scannedAt;
  const originalVariantScannedAt = comparison.variant.conditions.scannedAt;
  await writeReport(reportsDir, singleId, single);
  await writeReport(reportsDir, comparisonId, comparison);

  const first = await remediateReports({ reportsDir, mode: "apply", writtenAt: WRITTEN_AT });
  assert.equal(first.reports, 2);
  assert.equal(first.reportChanges, 2);
  assert.equal(first.sidecarsWritten, 2);

  const storedSingle = JSON.parse(await readFile(reportPath(reportsDir, singleId), "utf8")) as ScanResult;
  const storedComparison = JSON.parse(await readFile(reportPath(reportsDir, comparisonId), "utf8")) as typeof comparison;
  assert.equal(storedSingle.reportType, "single");
  assert.deepEqual(storedSingle.share, originalSingleShare);
  assert.equal(storedSingle.conditions.scannedAt, originalSingleScannedAt);
  assert.equal(storedComparison.reportType, "comparison");
  assert.equal(storedComparison.comparisonType, comparison.comparisonType);
  assert.deepEqual(storedComparison.share, originalComparisonShare);
  assert.equal(storedComparison.scannedAt, originalComparisonScannedAt);
  assert.equal(storedComparison.baseline.conditions.scannedAt, originalBaselineScannedAt);
  assert.equal(storedComparison.variant.conditions.scannedAt, originalVariantScannedAt);

  for (const [id, report, createdAt] of [
    [singleId, storedSingle, originalSingleScannedAt],
    [comparisonId, storedComparison, originalComparisonScannedAt]
  ] as const) {
    const sidecar = JSON.parse(await readFile(sidecarPath(reportsDir, id), "utf8"));
    assert.equal(sidecar.writtenAt, WRITTEN_AT);
    assert.equal(sidecar.createdAt, createdAt);
    assert.equal(sidecar.expiresAt, null);
    assert.equal(matchProvenance(report, sidecar, id).status, "matched");
    assert.equal(
      readManagedReport({
        reportId: id,
        reportContents: await readFile(reportPath(reportsDir, id), "utf8"),
        sidecarContents: JSON.stringify(sidecar),
        retention: { createdAt, expiresAt: null }
      }).ok,
      true
    );
  }

  const firstSingleWire = await readFile(reportPath(reportsDir, singleId), "utf8");
  const firstComparisonWire = await readFile(reportPath(reportsDir, comparisonId), "utf8");
  const firstSingleSidecar = await readFile(sidecarPath(reportsDir, singleId), "utf8");
  const firstComparisonSidecar = await readFile(sidecarPath(reportsDir, comparisonId), "utf8");
  const second = await remediateReports({ reportsDir, mode: "apply", writtenAt: LATER_WRITTEN_AT });
  assert.equal(second.reportChanges, 0);
  assert.equal(second.sidecarsWritten, 0);
  assert.equal(await readFile(reportPath(reportsDir, singleId), "utf8"), firstSingleWire);
  assert.equal(await readFile(reportPath(reportsDir, comparisonId), "utf8"), firstComparisonWire);
  assert.equal(await readFile(sidecarPath(reportsDir, singleId), "utf8"), firstSingleSidecar);
  assert.equal(await readFile(sidecarPath(reportsDir, comparisonId), "utf8"), firstComparisonSidecar);

  const checked = await remediateReports({ reportsDir, mode: "check", writtenAt: LATER_WRITTEN_AT });
  assert.equal(checked.reportChanges, 0);
  assert.deepEqual(checked.issues, []);
});

test("r2/v3 remediation requires its old sidecar, rewrites to v4, and preserves the committed clock", async () => {
  const reportsDir = await makeReportsDirectory();
  const id = reportId("1");
  const report = makeSupportingPairInterventionReportV2R2();
  assert.equal(report.experiment.kind, "intervention");
  if (report.experiment.kind !== "intervention") throw new Error("expected intervention fixture");
  const supportingPair = report.experiment.supportingPairs?.[0];
  assert.ok(supportingPair);
  for (const run of r2ReportRuns(report)) {
    markHistoricalNodeV3(run);
    run.summary.pageTitle = "Private dashboard for Alice";
    run.fingerprints = buildFingerprints({
      conditions: run.conditions,
      provenance: run.provenance,
      toolchain: run.toolchain,
      detectors: run.detectors
    });
  }
  report.share = buildStaticReportShare(id);
  const originalWire = `${JSON.stringify(report)}\n`;
  await writeFile(reportPath(reportsDir, id), originalWire);
  const createdAt = "2026-07-09T11:01:00.000Z";
  await writeFile(
    sidecarPath(reportsDir, id),
    `${JSON.stringify(buildProvenanceEntry({
      reportId: id,
      publicReport: report,
      writtenAt: WRITTEN_AT,
      createdAt,
      expiresAt: null,
      redactionVersion: MIGRATABLE_REDACTION_VERSION
    }))}\n`
  );

  const dryRun = await remediateReports({ reportsDir, writtenAt: WRITTEN_AT });
  assert.equal(dryRun.reportChanges, 1);
  assert.equal(dryRun.sidecarsWritten, 0);
  assert.deepEqual(dryRun.transitionAudit, {
    version: REDACTION_TRANSITION_AUDIT_VERSION,
    pageTitlesWithheld: r2ReportRuns(report).length,
    explicitPortFieldsRemoved: 0,
    ipLiteralFieldsRejected: 0
  });
  assert.deepEqual(dryRun.issues, [{ reportId: id, reason: "redaction-version-mismatch" }]);
  assert.equal(await readFile(reportPath(reportsDir, id), "utf8"), originalWire);

  const applied = await remediateReports({ reportsDir, mode: "apply", writtenAt: WRITTEN_AT });
  assert.equal(applied.reportChanges, 1);
  assert.equal(applied.sidecarsWritten, 1);
  assert.deepEqual(applied.transitionAudit, dryRun.transitionAudit);
  const migratedWire = await readFile(reportPath(reportsDir, id), "utf8");
  assert.notEqual(migratedWire, originalWire);
  const migrated = JSON.parse(migratedWire) as typeof report;
  for (const run of r2ReportRuns(migrated)) {
    assert.equal(run.privacy.redactionVersion, REDACTION_VERSION);
    assert.equal(run.summary.pageTitle, "");
    assert.equal(
      run.toolchain.normalizationVersion,
      `${legacyNodeNormalization()}+${REDACTION_V3_TO_V4_NORMALIZATION_SUFFIX}`
    );
  }

  const sidecarWire = await readFile(sidecarPath(reportsDir, id), "utf8");
  const sidecar = JSON.parse(sidecarWire);
  assert.equal(sidecar.createdAt, createdAt);
  assert.equal(sidecar.expiresAt, null);
  assert.equal(matchProvenance(migrated, sidecar, id).status, "matched");
  assert.equal(
    readManagedReport({
      reportId: id,
      reportContents: migratedWire,
      sidecarContents: sidecarWire,
      retention: { createdAt: sidecar.createdAt, expiresAt: null }
    }).ok,
    true
  );

  const checked = await remediateReports({ reportsDir, mode: "check", writtenAt: LATER_WRITTEN_AT });
  assert.equal(checked.reportChanges, 0);
  assert.deepEqual(checked.issues, []);
  assert.deepEqual(checked.transitionAudit, {
    version: REDACTION_TRANSITION_AUDIT_VERSION,
    pageTitlesWithheld: 0,
    explicitPortFieldsRemoved: 0,
    ipLiteralFieldsRejected: 0
  });
});

test("r2/v3 remediation rejects an unattested migration before any write", async () => {
  const reportsDir = await makeReportsDirectory();
  const id = reportId("5");
  const report = makePublicSingleReportV2R2();
  report.share = buildStaticReportShare(id);
  markHistoricalNodeV3(report.run);
  report.run.fingerprints = buildFingerprints({
    conditions: report.run.conditions,
    provenance: report.run.provenance,
    toolchain: report.run.toolchain,
    detectors: report.run.detectors
  });
  const originalWire = `${JSON.stringify(report, null, 2)}\n`;
  await writeFile(reportPath(reportsDir, id), originalWire);

  await assert.rejects(
    () => remediateReports({ reportsDir, mode: "apply", writtenAt: WRITTEN_AT }),
    /v3 report has no provenance sidecar/
  );
  assert.equal(await readFile(reportPath(reportsDir, id), "utf8"), originalWire);
  await assert.rejects(() => readFile(sidecarPath(reportsDir, id), "utf8"), /ENOENT/);
});

test("the filesystem planner rejects a schema-r2 identity bound to another share", async () => {
  const reportsDir = await makeReportsDirectory();
  const id = reportId("6");
  const report = makePublicSingleReportV2R2();
  report.share = buildStaticReportShare(reportId("7"));
  markHistoricalNodeV3(report.run);
  report.run.fingerprints = buildFingerprints({
    conditions: report.run.conditions,
    provenance: report.run.provenance,
    toolchain: report.run.toolchain,
    detectors: report.run.detectors
  });
  const originalWire = `${JSON.stringify(report, null, 2)}\n`;
  await writeFile(reportPath(reportsDir, id), originalWire);
  await writeFile(
    sidecarPath(reportsDir, id),
    JSON.stringify(buildProvenanceEntry({
      reportId: id,
      publicReport: report,
      writtenAt: WRITTEN_AT,
      createdAt: report.run.startedAt,
      expiresAt: null,
      redactionVersion: MIGRATABLE_REDACTION_VERSION
    }))
  );

  await assert.rejects(
    () => remediateReports({ reportsDir, mode: "apply", writtenAt: WRITTEN_AT }),
    /schema-r2 identity changed during redaction/
  );
  assert.equal(await readFile(reportPath(reportsDir, id), "utf8"), originalWire);
});

test("r2 remediation refuses to rewrite evidence with a non-current embedded redaction version", async () => {
  const reportsDir = await makeReportsDirectory();
  const id = reportId("2");
  const report = makePublicSingleReportV2R2();
  report.share = buildStaticReportShare(id);
  report.run.privacy.redactionVersion = REDACTION_VERSION + 1;
  const originalWire = `${JSON.stringify(report, null, 2)}\n`;
  await writeFile(reportPath(reportsDir, id), originalWire);

  await assert.rejects(
    () => remediateReports({ reportsDir, mode: "apply", writtenAt: WRITTEN_AT }),
    /r2 sanitizer rejected the report \(unsupported-redaction-version\)/
  );
  assert.equal(await readFile(reportPath(reportsDir, id), "utf8"), originalWire);
  await assert.rejects(() => readFile(sidecarPath(reportsDir, id), "utf8"), /ENOENT/);
});

test("v2/r1 with its stale embedded redaction version is not blessed by remediation", async () => {
  const reportsDir = await makeReportsDirectory();
  const id = reportId("3");
  const report = makePublicSingleReportV2();
  assert.notEqual(report.run.privacy.redactionVersion, REDACTION_VERSION);
  report.share = buildStaticReportShare(id);
  const originalWire = `${JSON.stringify(report, null, 2)}\n`;
  await writeFile(reportPath(reportsDir, id), originalWire);

  await assert.rejects(
    () => remediateReports({ reportsDir, mode: "apply", writtenAt: WRITTEN_AT }),
    /only schema-r2 has a reviewed v2 migration/
  );
  assert.equal(await readFile(reportPath(reportsDir, id), "utf8"), originalWire);
  await assert.rejects(() => readFile(sidecarPath(reportsDir, id), "utf8"), /ENOENT/);
});

test("oversized r2 remediation refuses before writing and preserves the exact report bytes", async () => {
  const reportsDir = await makeReportsDirectory();
  const id = reportId("4");
  const report = makePublicSingleReportV2R2();
  report.run.privacy.redactionVersion = REDACTION_VERSION;
  report.run.warnings = ["x".repeat(SERVER_STORED_REPORT_JSON_MAX_BYTES)];
  report.share = buildStaticReportShare(id);
  const originalWire = `${JSON.stringify(report)}\n`;
  assert.ok(Buffer.byteLength(originalWire, "utf8") > SERVER_STORED_REPORT_JSON_MAX_BYTES);
  await writeFile(reportPath(reportsDir, id), originalWire);

  await assert.rejects(
    () => remediateReports({ reportsDir, mode: "apply", writtenAt: WRITTEN_AT }),
    /object exceeds the 33554432-byte remediation limit/
  );
  assert.equal(await readFile(reportPath(reportsDir, id), "utf8"), originalWire);
  await assert.rejects(() => readFile(sidecarPath(reportsDir, id), "utf8"), /ENOENT/);
});

test("filesystem remediation rejects malformed UTF-8 report bytes before JSON or writes", async () => {
  const reportsDir = await makeReportsDirectory();
  const id = reportId("8");
  const malformed = new Uint8Array([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d]);
  await writeFile(reportPath(reportsDir, id), malformed);

  await assert.rejects(
    () => remediateReports({ reportsDir, mode: "apply", writtenAt: WRITTEN_AT }),
    /object is not exact valid UTF-8/
  );
  assert.deepEqual(await readFile(reportPath(reportsDir, id)), Buffer.from(malformed));
  await assert.rejects(() => readFile(sidecarPath(reportsDir, id)), /ENOENT/);
});

test("filesystem remediation rejects malformed UTF-8 sidecar bytes before report writes", async () => {
  const reportsDir = await makeReportsDirectory();
  const id = reportId("9");
  const report = sensitiveSingle(id);
  const originalWire = `${JSON.stringify(report, null, 2)}\n`;
  const malformed = new Uint8Array([0x7b, 0x22, 0xc3, 0x28, 0x22, 0x7d]);
  await writeFile(reportPath(reportsDir, id), originalWire);
  await writeFile(sidecarPath(reportsDir, id), malformed);

  await assert.rejects(
    () => remediateReports({ reportsDir, mode: "apply", writtenAt: WRITTEN_AT }),
    /object is not exact valid UTF-8/
  );
  assert.equal(await readFile(reportPath(reportsDir, id), "utf8"), originalWire);
  assert.deepEqual(await readFile(sidecarPath(reportsDir, id)), Buffer.from(malformed));
});

test("filesystem remediation rejects BOM-prefixed report and sidecar bytes without normalization", async () => {
  const reportCase = await makeReportsDirectory();
  const reportIdValue = reportId("0");
  const reportWire = Buffer.from(`${JSON.stringify(sensitiveSingle(reportIdValue))}\n`, "utf8");
  const bomReportWire = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), reportWire]);
  await writeFile(reportPath(reportCase, reportIdValue), bomReportWire);
  await assert.rejects(
    () => remediateReports({ reportsDir: reportCase, mode: "apply", writtenAt: WRITTEN_AT }),
    /invalid JSON/
  );
  assert.deepEqual(await readFile(reportPath(reportCase, reportIdValue)), bomReportWire);

  const sidecarCase = await makeReportsDirectory();
  const sidecarId = reportId("1");
  const publicReport = remediatedSingle(sidecarId);
  const publicWire = `${JSON.stringify(publicReport, null, 2)}\n`;
  const sidecarWire = Buffer.from(
    `${JSON.stringify(currentSidecar(sidecarId, publicReport, reportCreatedAt(publicReport)))}\n`,
    "utf8"
  );
  const bomSidecarWire = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), sidecarWire]);
  await writeFile(reportPath(sidecarCase, sidecarId), publicWire);
  await writeFile(sidecarPath(sidecarCase, sidecarId), bomSidecarWire);
  await assert.rejects(
    () => remediateReports({ reportsDir: sidecarCase, mode: "apply", writtenAt: WRITTEN_AT }),
    /provenance sidecar is invalid JSON/
  );
  assert.equal(await readFile(reportPath(sidecarCase, sidecarId), "utf8"), publicWire);
  assert.deepEqual(await readFile(sidecarPath(sidecarCase, sidecarId)), bomSidecarWire);
});

test("filesystem remediation rejects nested duplicate report and sidecar keys before writes", async () => {
  const reportCase = await makeReportsDirectory();
  const reportIdValue = reportId("a");
  const report = sensitiveSingle(reportIdValue);
  const originalReport = `${JSON.stringify(report, null, 2)}\n`;
  const duplicateReport = originalReport.replace(
    /"pageTitle":\s*"[^"]*"/,
    '"pageTitle":"Alice private account token","pageTitle":""'
  );
  await writeFile(reportPath(reportCase, reportIdValue), duplicateReport);
  await assert.rejects(
    () => remediateReports({ reportsDir: reportCase, mode: "apply", writtenAt: WRITTEN_AT }),
    /invalid JSON/
  );
  assert.equal(await readFile(reportPath(reportCase, reportIdValue), "utf8"), duplicateReport);

  const sidecarCase = await makeReportsDirectory();
  const sidecarId = reportId("b");
  const publicReport = remediatedSingle(sidecarId);
  const publicWire = `${JSON.stringify(publicReport, null, 2)}\n`;
  const sidecar = currentSidecar(sidecarId, publicReport, reportCreatedAt(publicReport));
  const duplicateSidecar = JSON.stringify({
    ignored: { safe: true },
    ...sidecar
  }).replace('"ignored":{"safe":true}', '"ignored":{"secret":"Alice","secret":""}');
  await writeFile(reportPath(sidecarCase, sidecarId), publicWire);
  await writeFile(sidecarPath(sidecarCase, sidecarId), duplicateSidecar);
  await assert.rejects(
    () => remediateReports({ reportsDir: sidecarCase, mode: "apply", writtenAt: WRITTEN_AT }),
    /v3 provenance sidecar|invalid JSON|generated managed report/
  );
  assert.equal(await readFile(reportPath(sidecarCase, sidecarId), "utf8"), publicWire);
  assert.equal(await readFile(sidecarPath(sidecarCase, sidecarId), "utf8"), duplicateSidecar);
});

test("check fails closed for every incomplete or contradictory provenance state", async (context) => {
  const cases: Array<{
    name: string;
    reason: string;
    report: (id: string) => ScanReport;
    sidecar: (id: string, report: ScanReport) => string | null;
  }> = [
    {
      name: "missing sidecar",
      reason: "no-sidecar",
      report: remediatedSingle,
      sidecar: () => null
    },
    {
      name: "malformed sidecar",
      reason: "invalid-sidecar-json",
      report: remediatedSingle,
      sidecar: () => "{"
    },
    {
      name: "wrong report id",
      reason: "report-id-mismatch",
      report: remediatedSingle,
      sidecar: (_id, report) =>
        JSON.stringify(currentSidecar(reportId("f"), report, reportCreatedAt(report)))
    },
    {
      name: "non-current redaction version",
      reason: "redaction-version-mismatch",
      report: remediatedSingle,
      sidecar: (id, report) =>
        JSON.stringify({ ...currentSidecar(id, report, reportCreatedAt(report)), redactionVersion: REDACTION_VERSION + 1 })
    },
    {
      name: "wrong digest",
      reason: "digest-mismatch",
      report: remediatedSingle,
      sidecar: (id, report) =>
        JSON.stringify({ ...currentSidecar(id, report, reportCreatedAt(report)), publicDigest: "0".repeat(64) })
    },
    {
      name: "non-idempotent report",
      reason: "redaction-not-idempotent",
      report: sensitiveSingle,
      sidecar: (id, report) => JSON.stringify(currentSidecar(id, report, reportCreatedAt(report)))
    }
  ];

  for (const [index, fixture] of cases.entries()) {
    await context.test(fixture.name, async () => {
      const reportsDir = await makeReportsDirectory();
      const id = `20260712-${index.toString(16).padStart(32, "0")}`;
      const report = fixture.report(id);
      await writeReport(reportsDir, id, report);
      const sidecar = fixture.sidecar(id, report);
      if (sidecar !== null) await writeFile(sidecarPath(reportsDir, id), sidecar);

      await assert.rejects(
        () => remediateReports({ reportsDir, mode: "check", writtenAt: WRITTEN_AT }),
        (error: unknown) => {
          assert.ok(error instanceof RemediationCheckError);
          assert.deepEqual(error.summary.issues, [{ reportId: id, reason: fixture.reason }]);
          return true;
        }
      );
    });
  }
});

test("a non-regular sidecar is rejected during preflight before any report write", async () => {
  const reportsDir = await makeReportsDirectory();
  const id = reportId("d");
  const raw = sensitiveSingle(id);
  await writeReport(reportsDir, id, raw);
  await mkdir(sidecarPath(reportsDir, id));

  await assert.rejects(() => remediateReports({ reportsDir, mode: "apply", writtenAt: WRITTEN_AT }));

  const stored = JSON.parse(await readFile(reportPath(reportsDir, id), "utf8"));
  assert.deepEqual(stored, raw);
  assert.equal((await readdir(reportsDir)).some((file) => file.endsWith(".tmp")), false);
});

test("a conflict between report and sidecar writes leaves a fail-closed partial pair", async () => {
  const reportsDir = await makeReportsDirectory();
  const id = reportId("c");
  const raw = sensitiveSingle(id);
  await writeReport(reportsDir, id, raw);

  await assert.rejects(
    () => remediateReports({
      reportsDir,
      mode: "apply",
      writtenAt: WRITTEN_AT,
      _testApplyHook: async ({ stage, reportId: current }) => {
        if (stage === "before-sidecar-write" && current === id) await mkdir(sidecarPath(reportsDir, id));
      }
    }),
    RemediationConflictError
  );

  const partialWire = await readFile(reportPath(reportsDir, id), "utf8");
  assert.deepEqual(JSON.parse(partialWire), redactScanReportV1(raw).report);
  assert.deepEqual(
    readManagedReport({ reportId: id, reportContents: partialWire, sidecarContents: null, retention: null }),
    { ok: false, error: "invalid", reason: "no-sidecar" }
  );
  assert.equal((await readdir(reportsDir)).some((file) => file.endsWith(".tmp")), false);
});

test("apply rejects changed report bytes, changed sidecar bytes, and added inventory before replacement", async () => {
  for (const mutation of ["report", "sidecar", "added-report", "added-sidecar"] as const) {
    const reportsDir = await makeReportsDirectory();
    const id = reportId(mutation === "report" ? "1" : mutation === "sidecar" ? "2" : mutation === "added-report" ? "3" : "4");
    const raw = sensitiveSingle(id);
    const original = `${JSON.stringify(raw, null, 2)}\n`;
    await writeFile(reportPath(reportsDir, id), original);
    if (mutation === "sidecar") {
      const sidecar = buildProvenanceEntry({
        reportId: id,
        publicReport: raw,
        writtenAt: WRITTEN_AT,
        createdAt: WRITTEN_AT,
        expiresAt: null
      });
      await writeFile(sidecarPath(reportsDir, id), `${JSON.stringify(sidecar)}\n`);
    }

    await assert.rejects(
      () => remediateReports({
        reportsDir,
        mode: "apply",
        writtenAt: WRITTEN_AT,
        _testApplyHook: async ({ stage }) => {
          if (stage !== "after-plan") return;
          if (mutation === "report") await writeFile(reportPath(reportsDir, id), `${original} `);
          if (mutation === "sidecar") await writeFile(sidecarPath(reportsDir, id), "{}\n");
          if (mutation === "added-report") await writeFile(reportPath(reportsDir, reportId("5")), "{}\n");
          if (mutation === "added-sidecar") await writeFile(sidecarPath(reportsDir, reportId("6")), "{}\n");
        }
      }),
      RemediationConflictError,
      mutation
    );
    assert.equal(
      await readFile(reportPath(reportsDir, id), "utf8"),
      mutation === "report" ? `${original} ` : original,
      mutation
    );
    if (mutation === "sidecar") {
      assert.equal(await readFile(sidecarPath(reportsDir, id), "utf8"), "{}\n");
    } else {
      await assert.rejects(() => readFile(sidecarPath(reportsDir, id), "utf8"), /ENOENT/);
    }
  }
});

test("apply rejects report and sidecar symlinks and honors the shared corpus lock", async () => {
  const reportCase = await makeReportsDirectory();
  const reportIdValue = reportId("7");
  const target = path.join(reportCase, "target.json");
  await writeFile(target, `${JSON.stringify(sensitiveSingle(reportIdValue))}\n`);
  await symlink(target, reportPath(reportCase, reportIdValue));
  await assert.rejects(
    () => remediateReports({ reportsDir: reportCase, mode: "apply", writtenAt: WRITTEN_AT }),
    /not a regular file/
  );

  const sidecarCase = await makeReportsDirectory();
  const sidecarId = reportId("8");
  await writeReport(sidecarCase, sidecarId, sensitiveSingle(sidecarId));
  const sidecarTarget = path.join(sidecarCase, "target-sidecar.json");
  await writeFile(sidecarTarget, "{}\n");
  await symlink(sidecarTarget, sidecarPath(sidecarCase, sidecarId));
  await assert.rejects(
    () => remediateReports({ reportsDir: sidecarCase, mode: "apply", writtenAt: WRITTEN_AT }),
    /not a regular file/
  );

  const lockedCase = await makeReportsDirectory();
  const lock = await acquireReportCorpusLock(lockedCase, "test-writer");
  try {
    for (const mode of ["dry-run", "check", "apply"] as const) {
      await assert.rejects(
        () => remediateReports({ reportsDir: lockedCase, mode, writtenAt: WRITTEN_AT }),
        ReportCorpusLockedError,
        mode
      );
    }
  } finally {
    await lock.release();
  }
});

test("final exact readback rejects a non-settling apply result", async () => {
  const reportsDir = await makeReportsDirectory();
  const id = reportId("9");
  await writeReport(reportsDir, id, sensitiveSingle(id));

  await assert.rejects(
    () => remediateReports({
      reportsDir,
      mode: "apply",
      writtenAt: WRITTEN_AT,
      _testApplyHook: async ({ stage }) => {
        if (stage === "before-final-readback") {
          const wire = await readFile(reportPath(reportsDir, id));
          await writeFile(reportPath(reportsDir, id), Buffer.concat([wire, Buffer.from(" ")]));
        }
      }
    }),
    RemediationConflictError
  );
  assert.equal((await readdir(reportsDir)).some((file) => file.endsWith(".tmp")), false);
});

test("dangling sidecars are reported and make apply fail before any write", async () => {
  const reportsDir = await makeReportsDirectory();
  const id = reportId("e");
  const danglingId = reportId("f");
  const report = sensitiveSingle(id);
  const reportWire = `${JSON.stringify(report, null, 2)}\n`;
  const danglingWire = "{}\n";
  await writeFile(reportPath(reportsDir, id), reportWire);
  await writeFile(sidecarPath(reportsDir, danglingId), danglingWire);

  const dryRun = await remediateReports({ reportsDir, writtenAt: WRITTEN_AT });
  assert.ok(dryRun.issues.some((issue) => issue.reportId === danglingId && issue.reason === "dangling-sidecar"));

  await assert.rejects(
    () => remediateReports({ reportsDir, mode: "check", writtenAt: WRITTEN_AT }),
    (error: unknown) => {
      assert.ok(error instanceof RemediationCheckError);
      assert.ok(error.summary.issues.some((issue) => issue.reportId === danglingId && issue.reason === "dangling-sidecar"));
      return true;
    }
  );
  await assert.rejects(
    () => remediateReports({ reportsDir, mode: "apply", writtenAt: WRITTEN_AT }),
    (error: unknown) => {
      assert.ok(error instanceof RemediationPreflightError);
      assert.deepEqual(error.summary.issues, [{ reportId: danglingId, reason: "dangling-sidecar" }]);
      return true;
    }
  );

  assert.equal(await readFile(reportPath(reportsDir, id), "utf8"), reportWire);
  assert.equal(await readFile(sidecarPath(reportsDir, danglingId), "utf8"), danglingWire);
  await assert.rejects(() => readFile(sidecarPath(reportsDir, id), "utf8"), /ENOENT/);
});

test("CLI modes are explicit and mutually exclusive", () => {
  assert.equal(parseRemediationMode([]), "dry-run");
  assert.equal(parseRemediationMode(["--apply"]), "apply");
  assert.equal(parseRemediationMode(["--check"]), "check");
  assert.throws(() => parseRemediationMode(["--apply", "--check"]), /mutually exclusive/);
  assert.throws(() => parseRemediationMode(["--force"]), /Unknown argument/);
});

function sensitiveSingle(id: string): ScanResult {
  const report = makeScanReportV1();
  if (report.reportType === "comparison") throw new Error("expected single report fixture");
  report.conditions.requestedUrl = "https://patient-0123456789abcdef.example.com/users/alice?token=secret";
  report.conditions.finalUrl = report.conditions.requestedUrl;
  report.summary.firstPartyDomain = "patient-0123456789abcdef.example.com";
  report.share = buildStaticReportShare(id);
  return report;
}

function remediatedSingle(id: string): ScanResult {
  return redactScanReportV1(sensitiveSingle(id)).report;
}

function sensitiveComparison(id: string) {
  const baseline = sensitiveSingle(id);
  const variant = structuredClone(baseline);
  variant.conditions.scannedAt = "2026-07-09T10:01:00.000Z";
  variant.conditions.gpcEnabled = true;
  const report = createGpcComparisonReport(baseline, variant);
  report.share = buildStaticReportShare(id);
  return report;
}

function currentSidecar(id: string, report: ScanReport, createdAt: string) {
  return buildProvenanceEntry({
    reportId: id,
    publicReport: report,
    writtenAt: WRITTEN_AT,
    createdAt,
    expiresAt: null
  });
}

function legacyNodeNormalization(): string {
  const [identity] = MIGRATABLE_REDACTION_V3_NORMALIZATIONS["node-playwright"];
  if (!identity) throw new Error("missing reviewed v3 fixture identity");
  return identity;
}

function markHistoricalNodeV3(run: ScanRunV2R2): void {
  run.privacy.redactionVersion = MIGRATABLE_REDACTION_VERSION;
  run.toolchain.normalizationVersion = legacyNodeNormalization();
  run.provenance.methodologyVersion = HISTORICAL_NODE_R2_V3_METHODOLOGY_VERSION;
  run.provenance.detectorRegistry = {
    version: HISTORICAL_NODE_R2_V3_DETECTOR_REGISTRY_VERSION,
    digest: HISTORICAL_NODE_R2_V3_DETECTOR_REGISTRY_DIGEST
  };
  run.toolchain.trackerCatalog = { ...HISTORICAL_NODE_R2_V3_TRACKER_CATALOG };
  for (const id of Object.keys(run.detectors) as Array<keyof typeof run.detectors>) {
    run.detectors[id] = { ...run.detectors[id], version: HISTORICAL_NODE_R2_V3_DETECTOR_VERSIONS[id] };
  }
  if (run.toolchain.adblock !== null) {
    run.toolchain.adblock.engineVersion = HISTORICAL_NODE_R2_V3_ADBLOCK_ENGINE_VERSION;
  }
}

function reportCreatedAt(report: ScanReport): string {
  return report.reportType === "comparison" ? report.scannedAt : report.conditions.scannedAt;
}

function reportId(character: string): string {
  return `20260712-${character.repeat(32)}`;
}

async function makeReportsDirectory(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "site-behavior-remediation-"));
  tempDirectories.push(root);
  const reportsDir = path.join(root, "public", "reports");
  await mkdir(reportsDir, { recursive: true });
  return reportsDir;
}

async function writeReport(reportsDir: string, id: string, report: ScanReport): Promise<void> {
  await writeFile(reportPath(reportsDir, id), `${JSON.stringify(report, null, 2)}\n`);
}

function reportPath(reportsDir: string, id: string): string {
  return path.join(reportsDir, `${id}.json`);
}

function sidecarPath(reportsDir: string, id: string): string {
  return path.join(reportsDir, committedSidecarFilename(id));
}
