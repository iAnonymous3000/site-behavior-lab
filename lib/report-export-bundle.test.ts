import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { reportExportBundle } from "./report-export-bundle";
import { requestLogToCsv } from "./csv-export";
import { makeScanReportV1 } from "./scan-report-v2-fixtures";

test("standard unzip verifies the bundle and recovers exact report and correction bytes", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sbl-export-"));
  try {
    const report = '{"report":"Unicode café and retained evidence"}\n';
    const correction = '{"summary":"Use the correction with this report"}\n';
    writeFileSync(path.join(dir, "evidence.zip"), reportExportBundle(report, correction));
    execFileSync("unzip", ["-t", "evidence.zip"], {cwd: dir});
    execFileSync("unzip", ["-q", "evidence.zip"], {cwd: dir});
    assert.equal(readFileSync(path.join(dir, "report.json"), "utf8"), report);
    assert.equal(readFileSync(path.join(dir, "corrections.json"), "utf8"), correction);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test("an empty request CSV retains failed-visit evidence and correction context without fabricated rows", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sbl-empty-log-"));
  try {
    const report = makeScanReportV1();
    assert.equal(report.reportType, "single");
    if (report.reportType !== "single") throw new Error("expected single fixture");
    report.summary.status = 403;
    const reportJson = JSON.stringify(report);
    const correctionsJson = JSON.stringify({ subjectEvents: [], replacementEvents: [], currentSubjectEvent: null, suppressIndexing: false });
    const csv = requestLogToCsv([], "failed");
    assert.equal(csv.trimEnd().split("\r\n").length, 1, "header only; zero observed requests");
    for (const arm of [null, "baseline", "variant"] as const) {
      const bundle = reportExportBundle(reportJson, correctionsJson, { csv, arm });
      writeFileSync(path.join(dir, "requests.zip"), bundle);
      execFileSync("unzip", ["-t", "requests.zip"], { cwd: dir });
      const filename = arm ? `${arm}-requests.csv` : "requests.csv";
      const listing = execFileSync("unzip", ["-Z1", "requests.zip"], { cwd: dir, encoding: "utf8" });
      assert.deepEqual(listing.trimEnd().split("\n"), ["report.json", "corrections.json", filename]);
      assert.equal(execFileSync("unzip", ["-p", "requests.zip", filename], { cwd: dir, encoding: "utf8" }), csv);
      const retained = execFileSync("unzip", ["-p", "requests.zip", "report.json"], { cwd: dir, encoding: "utf8" });
      assert.equal(retained, reportJson);
      assert.equal(JSON.parse(retained).summary.status, 403);
      assert.equal(execFileSync("unzip", ["-p", "requests.zip", "corrections.json"], { cwd: dir, encoding: "utf8" }), correctionsJson);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
