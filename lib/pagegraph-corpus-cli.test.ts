import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { main } from "./pagegraph-corpus-cli";
import type { PageGraphExportManifest } from "./pagegraph-corpus";
import { REDACTION_ALLOWLISTS_VERSION, REDACTION_VERSION } from "./redaction-v2";
import { sha256Hex } from "./sha256";

test("the PageGraph CLI exports opaque, sanitized, digest-pinned artifacts", () => {
  const temp = mkdtempSync(path.join(tmpdir(), "sbl-pagegraph-export-"));
  try {
    const input = path.join(temp, "anna-private-customer.graphml");
    const output = path.join(temp, "out");
    copyFileSync(
      path.join(process.cwd(), "lib", "__fixtures__", "pagegraph", "schema-provenance.graphml"),
      input
    );

    assert.equal(main(["--out", output, "--rule", "||tracker.example^", input]), 0);
    const exportedNames = readdirSync(output).sort();
    assert.equal(exportedNames.includes("export-manifest.json"), true);

    const pageCsv = readFileSync(path.join(output, "page.csv"), "utf8");
    const requestCsv = readFileSync(path.join(output, "request.csv"), "utf8");
    const storageCsv = readFileSync(path.join(output, "storage_op.csv"), "utf8");
    assert.match(pageCsv, /page-000001/);
    assert.equal(pageCsv.includes("anna-private-customer"), false);
    assert.equal(requestCsv.includes("cid=abc"), false);
    assert.equal(requestCsv.includes("a%40b.test"), false);
    assert.equal(storageCsv.includes("seen-banner"), false);
    const nodeIds = new Set(
      readFileSync(path.join(output, "node.csv"), "utf8")
        .trim()
        .split("\r\n")
        .slice(1)
        .map((row) => row.split(",", 1)[0])
    );
    const blockedIds = readFileSync(path.join(output, "directly_blocked.csv"), "utf8")
      .trim()
      .split("\r\n")
      .slice(1)
      .map((row) => row.split(",")[1]);
    assert.equal(blockedIds.length > 0, true);
    assert.equal(blockedIds.every((id) => nodeIds.has(id)), true);
    const impactJson = readFileSync(path.join(output, "impact-report.json"), "utf8");
    assert.equal(impactJson.includes("cid=abc"), false);
    assert.equal(impactJson.includes("a%40b.test"), false);

    const manifest = JSON.parse(
      readFileSync(path.join(output, "export-manifest.json"), "utf8")
    ) as PageGraphExportManifest;
    assert.equal(manifest.redactionVersion, REDACTION_VERSION);
    assert.equal(manifest.redactionAllowlistsVersion, REDACTION_ALLOWLISTS_VERSION);
    assert.equal(manifest.pages, 1);
    for (const entry of manifest.files) {
      const contents = readFileSync(path.join(output, entry.name), "utf8");
      assert.equal(entry.sha256, sha256Hex(contents));
      assert.equal(entry.bytes, new TextEncoder().encode(contents).length);
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
