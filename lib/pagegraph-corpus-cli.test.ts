import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { isThirdParty } from "./domain-utils";
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

    assert.equal(main(["--out", output, "--rule", "||google-analytics.com^", input]), 0);
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

test("the CLI attributes parties with the scanner's private-suffix rule", () => {
  // The CLI used ICANN-only eTLD+1, so a sibling tenant under a PSL private
  // suffix exported as first-party while the scan report called it third-party,
  // and every such etld1 (github.io, googleapis.com) redacted to {invalid-host}.
  const temp = mkdtempSync(path.join(tmpdir(), "sbl-pagegraph-party-"));
  try {
    const graphml = readFileSync(
      path.join(process.cwd(), "lib", "__fixtures__", "pagegraph", "real-wikipedia-2026-07-19.graphml"),
      "utf8"
    )
      .replaceAll("https://www.wikipedia.org/static/favicon/", "https://bar.github.io/static/favicon/")
      .replaceAll(
        "https://www.wikipedia.org/portal/wikipedia.org/assets/img/sprite-",
        "https://fonts.googleapis.com/portal/wikipedia.org/assets/img/sprite-"
      )
      .replaceAll(
        "https://www.wikipedia.org/portal/wikipedia.org/assets/img/Wikipedia-logo",
        "https://192.0.2.1/portal/wikipedia.org/assets/img/Wikipedia-logo"
      )
      .replaceAll("https://www.wikipedia.org", "https://foo.github.io");
    const input = path.join(temp, "tenant.graphml");
    writeFileSync(input, graphml);
    const output = path.join(temp, "out");
    assert.equal(main(["--out", output, input]), 0);

    const table = (name: string) => {
      const [header, ...rows] = readFileSync(path.join(output, name), "utf8").trim().split("\r\n");
      const columns = header!.split(",");
      return rows.map((row) => {
        const cells = row.split(",");
        return Object.fromEntries(columns.map((column, index) => [column, cells[index] ?? ""]));
      });
    };
    assert.equal(table("page.csv")[0]!.etld1, "foo.github.io");

    const requests = table("request.csv");
    const byDomain = (domain: string) => {
      const matching = requests.filter((row) => row.domain === domain);
      assert.ok(matching.length > 0, `no request row for ${domain}`);
      return matching;
    };
    for (const domain of ["foo.github.io", "bar.github.io", "fonts.googleapis.com"]) {
      for (const row of byDomain(domain)) {
        assert.equal(row.etld1, domain, `${domain} etld1`);
        assert.equal(
          row.third_party,
          String(isThirdParty("foo.github.io", domain)),
          `${domain} third_party must match the scanner's isThirdParty`
        );
      }
    }
    assert.equal(byDomain("bar.github.io")[0]!.third_party, "true");

    // An IP host has no registrable domain: etld1 and third_party stay unknown
    // (empty) rather than becoming a definite party by exact host equality.
    const [ipRow, ...otherIpRows] = byDomain("{invalid-host}");
    assert.equal(otherIpRows.length, 0);
    assert.equal(ipRow!.etld1, "");
    assert.equal(ipRow!.third_party, "");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
