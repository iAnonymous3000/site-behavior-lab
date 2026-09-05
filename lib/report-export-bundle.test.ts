import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { reportExportBundle } from "./report-export-bundle";

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
