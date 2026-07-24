import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const workflowsDir = path.join(process.cwd(), ".github", "workflows");
const single = readFileSync(path.join(workflowsDir, "scan.yml"), "utf8");
const featured = readFileSync(path.join(workflowsDir, "scan-featured.yml"), "utf8");

test("hostile-site acquisition jobs have read-only authority and a fail-closed sandbox", () => {
  for (const [name, source, id] of [
    ["single", single, "scan"],
    ["featured", featured, "scan-featured"]
  ] as const) {
    const acquisition = job(source, id);
    assert.match(acquisition, /permissions:\n\s+contents: read/);
    assert.doesNotMatch(acquisition, /contents: write|actions: write|issues: write/);
    assert.doesNotMatch(acquisition, /git push|gh workflow run|gh issue|gh api/);
    assert.doesNotMatch(acquisition, /cache: npm/, `${name} acquisition must not preserve a writable package cache`);
    assert.match(source, /SITE_BEHAVIOR_LAB_CHROMIUM_SANDBOX: "1"/);
    assert.match(acquisition, /featured-report-preflight-cli\.js[\s\S]*Install Chromium/);
    assert.match(acquisition, /health\?\.checks\?\.chromiumSandbox === "enabled"/);
    assert.match(acquisition, /--prepare[\s\S]*--artifact-dir "\$RUNNER_TEMP\/report-publication"/);
    assert.match(acquisition, /actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7\.0\.1/);
    assert.match(acquisition, /name: site-behavior-(?:report|featured)-publication-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/);
    assert.match(acquisition, /path: \$\{\{ runner\.temp \}\}\/report-publication\//);
    assert.doesNotMatch(acquisition, /steps\.scan\.outputs\.(?:report_path|sidecar_path)/);
  }
});

test("committed r2 provenance is server-owned and publisher-enforced", () => {
  const preflight = readFileSync(path.join(process.cwd(), "lib", "featured-report-preflight.ts"), "utf8");
  const scanApi = readFileSync(path.join(process.cwd(), "lib", "scan-api.ts"), "utf8");
  const acquisition = readFileSync(path.join(process.cwd(), "lib", "scan-report-acquisition.ts"), "utf8");
  const publisher = readFileSync(path.join(process.cwd(), "lib", "report-publication-request.ts"), "utf8");

  assert.match(preflight, /SITE_BEHAVIOR_LAB_REPORT_ACQUISITION: "ci-workflow"/);
  assert.match(scanApi, /const acquisition = runtimeReportAcquisition\(reportMode\)/);
  assert.doesNotMatch(scanApi, /buildRuntime(?:Comparison)?ScanReportV2R2\([^;]*"public-api"/);
  assert.match(acquisition, /environment\[REPORT_ACQUISITION_ENV\]/);
  assert.doesNotMatch(acquisition, /request\.headers|request\.json|headers\.get/);
  assert.match(publisher, /run\.provenance\.acquisition !== "ci-workflow"/);
});

test("trusted publishers validate bounded data before a non-rebasing branch push", () => {
  for (const [name, source] of [["single", single], ["featured", featured]] as const) {
    const publisher = job(source, "publish");
    assert.match(publisher, /runs-on: ubuntu-latest/);
    assert.match(publisher, /permissions:\n\s+contents: write\n[\s\S]*?actions: write/);
    assert.match(publisher, /ref: \$\{\{ github\.sha \}\}/);
    assert.match(publisher, /npm ci --ignore-scripts/);
    assert.doesNotMatch(publisher, /actions\/download-artifact|unzip|tar -x/);
    assert.match(publisher, /Precheck exact raw artifact metadata/);
    assert.match(publisher, /actions\/runs\/\$\{GITHUB_RUN_ID\}\/artifacts/);
    assert.match(publisher, /--validate-metadata[\s\S]*--artifact-id "\$ARTIFACT_ID"[\s\S]*--artifact-name "\$ARTIFACT_NAME"[\s\S]*--run-id "\$GITHUB_RUN_ID"/);
    assert.match(publisher, /actions\/artifacts\/\$\{ARTIFACT_ID\}\/zip/);
    assert.match(publisher, /--extract[\s\S]*--archive "\$RUNNER_TEMP\/report-publication\.zip"[\s\S]*--artifact-dir "\$RUNNER_TEMP\/report-publication"/);
    assert.match(publisher, /--publish[\s\S]*--artifact-dir "\$RUNNER_TEMP\/report-publication"/);
    assert.match(publisher, /npm run reports:prune[\s\S]*npm run reports:remediate -- --check[\s\S]*npm run reports:manifest[\s\S]*npm run corpus:stats/);
    assert.match(publisher, /git push origin "HEAD:refs\/heads\/\$GITHUB_REF_NAME"/);
    assert.match(publisher, /gh workflow run ci\.yml --ref "\$GITHUB_REF_NAME"/);
    assert.doesNotMatch(publisher, /git pull|git rebase|--force/);
    assert.doesNotMatch(publisher, /scan:ci|scan:featured|Install Chromium|next start/);
    assert.equal(
      publisher.indexOf("Build the trusted publication validator once") <
        publisher.indexOf("Precheck exact raw artifact metadata"),
      true,
      `${name} must build validator code from the exact checkout before checking untrusted artifact metadata`
    );
    assert.equal(
      publisher.indexOf("Precheck exact raw artifact metadata") <
        publisher.indexOf("Download raw artifact archive by immutable ID") &&
        publisher.indexOf("Download raw artifact archive by immutable ID") <
        publisher.indexOf("Centrally validate and safely extract raw artifact archive") &&
        publisher.indexOf("Centrally validate and safely extract raw artifact archive") <
        publisher.indexOf("Validate and copy only canonical new report data"),
      true,
      `${name} must precheck metadata, safely extract, then validate report data before publication`
    );
  }
});

test("featured issue authority is isolated from acquisition and receives no diagnostics artifact", () => {
  const acquisition = job(featured, "scan-featured");
  const reconciliation = job(featured, "reconcile");
  assert.doesNotMatch(acquisition, /issues: write/);
  assert.match(reconciliation, /permissions:\n\s+contents: read\n\s+issues: write/);
  assert.match(reconciliation, /FEATURED_PUBLIC_SUMMARY_JSON: \$\{\{ needs\.scan-featured\.outputs\.public_summary \}\}/);
  assert.doesNotMatch(reconciliation, /download-artifact|FEATURED_SUMMARY_PATH/);
  assert.doesNotMatch(featured, /featured-scan-failure-diagnostics/);
});

function job(source: string, id: string): string {
  const startMarker = `\n  ${id}:\n`;
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing workflow job ${id}`);
  const bodyStart = start + startMarker.length;
  const next = /^  [A-Za-z][A-Za-z0-9_-]*:\n/gm;
  next.lastIndex = bodyStart;
  const match = next.exec(source);
  return source.slice(start, match?.index ?? source.length);
}
