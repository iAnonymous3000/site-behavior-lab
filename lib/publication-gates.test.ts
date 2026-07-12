import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const root = process.cwd();

function source(relative: string): string {
  return readFileSync(path.join(root, relative), "utf8");
}

test("every static publication lane runs the exact remediation check before publishing", () => {
  for (const workflow of [".github/workflows/scan.yml", ".github/workflows/scan-featured.yml"]) {
    assert.match(source(workflow), /npm run reports:remediate -- --check/);
  }
  for (const script of [
    "scripts/build-github-pages.mjs",
    "scripts/run-ci-scan.mjs",
    "scripts/run-featured-scans.mjs"
  ]) {
    const contents = source(script);
    assert.equal(contents.includes('"reports:remediate", "--", "--check"'), true, script);
  }
});

test("scan artifacts and commits include provenance sidecars", () => {
  const scan = source(".github/workflows/scan.yml");
  assert.match(scan, /steps\.scan\.outputs\.sidecar_path/);
  assert.match(scan, /git add public\/reports/);

  const featured = source(".github/workflows/scan-featured.yml");
  assert.match(featured, /path: \|\n\s+public\/reports/);
  assert.match(featured, /git add public\/reports/);
});

test("official actions use their Node-24-compatible runtime releases", () => {
  const workflowsDir = path.join(root, ".github", "workflows");
  for (const name of readdirSync(workflowsDir).filter((entry) => entry.endsWith(".yml"))) {
    const contents = readFileSync(path.join(workflowsDir, name), "utf8");
    assert.equal(/actions\/(?:checkout|setup-node)@v4/.test(contents), false, name);
    assert.equal(/actions\/upload-artifact@(?!v7\b)/.test(contents), false, name);
  }
});

test("automation logs do not print raw scan URLs, page titles, rules, or local input paths", () => {
  const ci = source("scripts/run-ci-scan.mjs");
  assert.equal(ci.includes("Skipping ${targetUrl}"), false);
  assert.equal(ci.includes("for ${targetUrl}"), false);
  assert.equal(ci.includes('landing page title "${title}"'), false);

  const featured = source("scripts/run-featured-scans.mjs");
  assert.equal(featured.includes("${site.url}"), false);

  const pageGraph = source("lib/pagegraph-corpus-cli.ts");
  assert.equal(pageGraph.includes("path.basename(file)"), false);
  assert.equal(pageGraph.includes("JSON.stringify(options.rule)"), false);
});
