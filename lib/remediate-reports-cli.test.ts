import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { createGpcComparisonReport } from "./compare-reports";
import { readManagedReport } from "./managed-report-reader";
import { redactScanReportV1 } from "./redact-scan-report-v1";
import {
  parseRemediationMode,
  remediateReports,
  RemediationCheckError,
  RemediationPreflightError
} from "./remediate-reports-cli";
import { buildProvenanceEntry, committedSidecarFilename, matchProvenance } from "./redaction-provenance";
import { REDACTION_VERSION } from "./redaction-v2";
import { buildStaticReportShare } from "./report-locator";
import {
  makePublicSingleReportV2R2,
  makeSupportingPairInterventionReportV2R2
} from "./scan-report-v2-r2-fixtures";
import { NODE_SCAN_REPORT_V2_R2_MAX_PUBLIC_BYTES } from "./scan-report-v2-r2-limits";
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

test("r2 remediation is byte-for-byte pass-through and backfills only a current sidecar", async () => {
  const reportsDir = await makeReportsDirectory();
  const id = reportId("1");
  const report = makeSupportingPairInterventionReportV2R2();
  assert.equal(report.experiment.kind, "intervention");
  if (report.experiment.kind !== "intervention") throw new Error("expected intervention fixture");
  const supportingPair = report.experiment.supportingPairs?.[0];
  assert.ok(supportingPair);
  for (const run of [report.baseline, report.variant, supportingPair.baseline, supportingPair.variant]) {
    run.privacy.redactionVersion = REDACTION_VERSION;
  }
  report.share = buildStaticReportShare(id);
  const originalWire = `${JSON.stringify(report)}\n`;
  await writeFile(reportPath(reportsDir, id), originalWire);

  const dryRun = await remediateReports({ reportsDir, writtenAt: WRITTEN_AT });
  assert.equal(dryRun.reportChanges, 0);
  assert.equal(dryRun.sidecarsWritten, 0);
  assert.deepEqual(dryRun.issues, [{ reportId: id, reason: "no-sidecar" }]);
  assert.equal(await readFile(reportPath(reportsDir, id), "utf8"), originalWire);

  const applied = await remediateReports({ reportsDir, mode: "apply", writtenAt: WRITTEN_AT });
  assert.equal(applied.reportChanges, 0);
  assert.equal(applied.sidecarsWritten, 1);
  assert.equal(await readFile(reportPath(reportsDir, id), "utf8"), originalWire);

  const sidecarWire = await readFile(sidecarPath(reportsDir, id), "utf8");
  const sidecar = JSON.parse(sidecarWire);
  assert.equal(sidecar.createdAt, "2026-07-09T11:01:00.000Z");
  assert.equal(sidecar.expiresAt, null);
  assert.equal(matchProvenance(report, sidecar, id).status, "matched");
  assert.equal(
    readManagedReport({
      reportId: id,
      reportContents: originalWire,
      sidecarContents: sidecarWire,
      retention: { createdAt: sidecar.createdAt, expiresAt: null }
    }).ok,
    true
  );

  const checked = await remediateReports({ reportsDir, mode: "check", writtenAt: LATER_WRITTEN_AT });
  assert.equal(checked.reportChanges, 0);
  assert.deepEqual(checked.issues, []);
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
    /generated managed report failed validation \(redaction-version-mismatch\)/
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
    /generated managed report failed validation \(redaction-version-mismatch\)/
  );
  assert.equal(await readFile(reportPath(reportsDir, id), "utf8"), originalWire);
  await assert.rejects(() => readFile(sidecarPath(reportsDir, id), "utf8"), /ENOENT/);
});

test("oversized r2 remediation refuses before writing and preserves the exact report bytes", async () => {
  const reportsDir = await makeReportsDirectory();
  const id = reportId("4");
  const report = makePublicSingleReportV2R2();
  report.run.privacy.redactionVersion = REDACTION_VERSION;
  report.run.warnings = ["x".repeat(NODE_SCAN_REPORT_V2_R2_MAX_PUBLIC_BYTES)];
  report.share = buildStaticReportShare(id);
  const originalWire = `${JSON.stringify(report)}\n`;
  assert.ok(Buffer.byteLength(originalWire, "utf8") > NODE_SCAN_REPORT_V2_R2_MAX_PUBLIC_BYTES);
  await writeFile(reportPath(reportsDir, id), originalWire);

  await assert.rejects(
    () => remediateReports({ reportsDir, mode: "apply", writtenAt: WRITTEN_AT }),
    /v2\/r2 report exceeds the 8388608-byte public limit/
  );
  assert.equal(await readFile(reportPath(reportsDir, id), "utf8"), originalWire);
  await assert.rejects(() => readFile(sidecarPath(reportsDir, id), "utf8"), /ENOENT/);
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

test("a sidecar write failure happens after the atomic report replacement and leaves no temp artifact", async () => {
  const reportsDir = await makeReportsDirectory();
  const id = reportId("d");
  const raw = sensitiveSingle(id);
  await writeReport(reportsDir, id, raw);
  await mkdir(sidecarPath(reportsDir, id));

  await assert.rejects(() => remediateReports({ reportsDir, mode: "apply", writtenAt: WRITTEN_AT }));

  const stored = JSON.parse(await readFile(reportPath(reportsDir, id), "utf8"));
  assert.deepEqual(stored, redactScanReportV1(raw).report);
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
