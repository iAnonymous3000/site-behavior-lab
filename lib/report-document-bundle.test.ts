import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { reportDocumentBundle } from "./report-document-bundle";

test("independent unzip and SHA-256 recover the original binary PDF and exact JSON", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sbl-document-"));
  const pdf = new Uint8Array([37,80,68,70,45,255,0,17,13,10]);
  const reportName = "20260730-748f7a920c0fdcf86c9a348a8660d395.json";
  const wire = '{"evidence":"café"}\r\n'; const corrections = '{"subjectEvents":[]}\n';
  try {
    writeFileSync(path.join(dir, "document.zip"), reportDocumentBundle({
      id: "20260730-748f7a920c0fdcf86c9a348a8660d395", pdf, wire, corrections,
      exportedAt: "2026-09-06T00:00:00Z", rendererCommit: "a".repeat(40), reportUrl: "https://sitebehavior.org/reports/example/"
    }));
    execFileSync("unzip", ["-t", "document.zip"], { cwd: dir });
    const get = (file: string) => execFileSync("unzip", ["-p", "document.zip", file], { cwd: dir });
    assert.deepEqual(get("report.pdf"), Buffer.from(pdf));
    assert.equal(get(reportName).toString(), wire);
    assert.equal(get("corrections.json").toString(), corrections);
    const manifest = JSON.parse(get("export.json").toString());
    for (const file of ["report.pdf", reportName, "corrections.json"]) {
      const sha = createHash("sha256").update(get(file)).digest("hex");
      assert.equal(manifest.files[file].sha256, sha);
      assert.ok(get("SHA256SUMS").toString().includes(`${sha}  ${file}\n`));
    }
    assert.equal(manifest.rendererCommit, "a".repeat(40));
    assert.match(get("README.txt").toString(), /do not prove who created it/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
