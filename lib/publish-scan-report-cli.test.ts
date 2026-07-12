import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { matchProvenance } from "./redaction-provenance";
import { readStoredScanReport } from "./scan-report-reader";
import { toPublicScanReportV1 } from "./scan-report-v1-projection";
import { makeScanReportV1 } from "./scan-report-v2-fixtures";

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
