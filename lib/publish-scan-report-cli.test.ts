import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { readManagedReport } from "./managed-report-reader";
import { matchProvenance } from "./redaction-provenance";
import { REDACTION_VERSION } from "./redaction-v2";
import { readStoredScanReport } from "./scan-report-reader";
import { toPublicScanReportV1 } from "./scan-report-v1-projection";
import type { PublicScanReportV2R2 } from "./scan-report-v2-r2";
import {
  makePublicSingleReportV2R2,
  makeSupportingPairInterventionReportV2R2
} from "./scan-report-v2-r2-fixtures";
import { NODE_SCAN_REPORT_V2_R2_MAX_PUBLIC_BYTES } from "./scan-report-v2-r2-limits";
import { makePublicSingleReportV2, makeScanReportV1 } from "./scan-report-v2-fixtures";

const REPORT_ID = "20260712-0123456789abcdef0123456789abcdef";

test("the committed publisher deep-projects, sanitizes, and writes a matching sidecar", () => {
  const temp = mkdtempSync(path.join(tmpdir(), "sbl-publisher-test-"));
  try {
    const inputPath = path.join(temp, "input.json");
    const outputPath = path.join(temp, `${REPORT_ID}.json`);
    const input = makeScanReportV1() as Record<string, unknown>;
    const conditions = input.conditions as Record<string, unknown>;
    conditions.requestedUrl = "https://example.com/patients/anna?token=secret";
    conditions.finalUrl = "https://example.com/account/12345";
    input.screenshot = "data:image/png;base64,PRIVATE_SCREENSHOT";
    input.secret = "SMUGGLED_ROOT_SECRET";
    conditions.secret = "SMUGGLED_NESTED_SECRET";
    input.share = {
      id: "20260712-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      path: "/reports/foreign/",
      jsonPath: "/reports/foreign.json"
    };
    writeFileSync(inputPath, JSON.stringify(input));

    const run = spawnSync(
      process.execPath,
      [path.join(__dirname, "publish-scan-report-cli.js"), inputPath, outputPath, REPORT_ID],
      { encoding: "utf8" }
    );
    assert.equal(run.status, 0, run.stderr || run.stdout);

    const report = JSON.parse(readFileSync(outputPath, "utf8"));
    const serialized = JSON.stringify(report);
    assert.equal(serialized.includes("anna"), false);
    assert.equal(serialized.includes("secret"), false);
    assert.equal(serialized.includes("PRIVATE_SCREENSHOT"), false);
    assert.equal(serialized.includes("SMUGGLED"), false);
    assert.equal(report.conditions.requestedUrl, "https://example.com/{seg}/{seg}");
    assert.equal(report.conditions.finalUrl, "https://example.com/account/{n}");
    assert.deepEqual(report.share, {
      id: REPORT_ID,
      path: `/reports/${REPORT_ID}/`,
      jsonPath: `/reports/${REPORT_ID}.json`
    });
    assert.deepEqual(toPublicScanReportV1(report), report);
    assert.equal(readStoredScanReport(report).ok, true);

    const sidecar = JSON.parse(
      readFileSync(path.join(temp, `${REPORT_ID}.provenance.json`), "utf8")
    );
    assert.equal(matchProvenance(report, sidecar, REPORT_ID).status, "matched");
    assert.equal(sidecar.createdAt, report.conditions.scannedAt);
    assert.equal(sidecar.expiresAt, null);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("the publisher refuses an output filename that cannot pair with its sidecar", () => {
  const temp = mkdtempSync(path.join(tmpdir(), "sbl-publisher-test-"));
  try {
    const inputPath = path.join(temp, "input.json");
    const outputPath = path.join(temp, "wrong.json");
    writeFileSync(inputPath, JSON.stringify(makeScanReportV1()));
    const run = spawnSync(
      process.execPath,
      [path.join(__dirname, "publish-scan-report-cli.js"), inputPath, outputPath, REPORT_ID],
      { encoding: "utf8" }
    );
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /output filename must match the report id/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("the committed publisher accepts public and ephemeral r2, projects public wire, and uses the latest embedded run clock", () => {
  const supporting = withCurrentR2Redaction(makeSupportingPairInterventionReportV2R2());
  const single = withCurrentR2Redaction(makePublicSingleReportV2R2());
  const cases = [
    {
      name: "public supporting-pair comparison",
      input: supporting,
      createdAt: "2026-07-09T11:01:00.000Z"
    },
    {
      name: "ephemeral single",
      input: { ...single, ephemeral: { screenshot: "data:image/png;base64,PRIVATE_SCREENSHOT" } },
      createdAt: single.run.startedAt
    }
  ];

  for (const fixture of cases) {
    const temp = mkdtempSync(path.join(tmpdir(), "sbl-publisher-r2-test-"));
    try {
      const inputPath = path.join(temp, "input.json");
      const outputPath = path.join(temp, `${REPORT_ID}.json`);
      writeFileSync(inputPath, JSON.stringify(fixture.input));

      const run = spawnSync(
        process.execPath,
        [path.join(__dirname, "publish-scan-report-cli.js"), inputPath, outputPath, REPORT_ID],
        { encoding: "utf8" }
      );
      assert.equal(run.status, 0, `${fixture.name}: ${run.stderr || run.stdout}`);

      const reportWire = readFileSync(outputPath, "utf8");
      const report = JSON.parse(reportWire);
      const serialized = JSON.stringify(report);
      assert.equal(report.schemaVersion, 2, fixture.name);
      assert.equal(report.schemaRevision, 2, fixture.name);
      assert.equal("ephemeral" in report, false, fixture.name);
      assert.equal(serialized.includes("PRIVATE_SCREENSHOT"), false, fixture.name);
      assert.deepEqual(report.share, {
        id: REPORT_ID,
        path: `/reports/${REPORT_ID}/`,
        jsonPath: `/reports/${REPORT_ID}.json`
      });
      const expectedPublic = structuredClone(fixture.input) as Record<string, unknown>;
      delete expectedPublic.ephemeral;
      expectedPublic.share = report.share;
      assert.deepEqual(report, expectedPublic, fixture.name);
      assert.equal(readStoredScanReport(report).ok, true, fixture.name);

      const sidecarWire = readFileSync(path.join(temp, `${REPORT_ID}.provenance.json`), "utf8");
      const sidecar = JSON.parse(sidecarWire);
      assert.equal(sidecar.createdAt, fixture.createdAt, fixture.name);
      assert.equal(sidecar.expiresAt, null, fixture.name);
      assert.equal(matchProvenance(report, sidecar, REPORT_ID).status, "matched", fixture.name);
      assert.equal(
        readManagedReport({
          reportId: REPORT_ID,
          reportContents: reportWire,
          sidecarContents: sidecarWire,
          retention: { createdAt: fixture.createdAt, expiresAt: null }
        }).ok,
        true,
        fixture.name
      );
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }
});

test("the committed publisher keeps v2/r1 read-only", () => {
  const temp = mkdtempSync(path.join(tmpdir(), "sbl-publisher-test-"));
  try {
    const inputPath = path.join(temp, "input.json");
    const outputPath = path.join(temp, `${REPORT_ID}.json`);
    writeFileSync(inputPath, JSON.stringify(makePublicSingleReportV2()));
    const run = spawnSync(
      process.execPath,
      [path.join(__dirname, "publish-scan-report-cli.js"), inputPath, outputPath, REPORT_ID],
      { encoding: "utf8" }
    );
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /v2\/r1 is compatibility-readable/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("the committed publisher refuses validator-clean r2 above the public byte limit", () => {
  const temp = mkdtempSync(path.join(tmpdir(), "sbl-publisher-limit-test-"));
  try {
    const inputPath = path.join(temp, "input.json");
    const outputPath = path.join(temp, `${REPORT_ID}.json`);
    const input = withCurrentR2Redaction(makePublicSingleReportV2R2());
    input.run.warnings = ["x".repeat(NODE_SCAN_REPORT_V2_R2_MAX_PUBLIC_BYTES)];
    assert.equal(readStoredScanReport(input).ok, true, "oversized fixture must fail on size, not validity");
    writeFileSync(inputPath, JSON.stringify(input));

    const run = spawnSync(
      process.execPath,
      [path.join(__dirname, "publish-scan-report-cli.js"), inputPath, outputPath, REPORT_ID],
      { encoding: "utf8" }
    );
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /projected v2\/r2 report exceeds the 8388608-byte public limit/);
    assert.throws(() => readFileSync(outputPath, "utf8"), /ENOENT/);
    assert.throws(() => readFileSync(path.join(temp, `${REPORT_ID}.provenance.json`), "utf8"), /ENOENT/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

function withCurrentR2Redaction<T extends PublicScanReportV2R2>(report: T): T {
  const runs = report.reportType === "single" ? [report.run] : [report.baseline, report.variant];
  if (report.reportType === "comparison" && report.experiment.kind === "intervention") {
    for (const pair of report.experiment.supportingPairs ?? []) runs.push(pair.baseline, pair.variant);
  }
  for (const run of runs) run.privacy.redactionVersion = REDACTION_VERSION;
  return report;
}
