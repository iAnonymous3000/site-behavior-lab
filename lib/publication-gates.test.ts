import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const root = process.cwd();

function source(relative: string): string {
  return readFileSync(path.join(root, relative), "utf8");
}

test("static Pages publication runs the exact historical remediation check before publishing", () => {
  const pagesBuilder = source("scripts/build-github-pages.mjs");
  assert.equal(pagesBuilder.includes('"reports:remediate", "--", "--check"'), true, "scripts/build-github-pages.mjs");
});

test("historical publication artifact validator pairs report JSON and provenance sidecars", () => {
  const artifact = source("lib/report-publication-artifact.ts");
  assert.match(artifact, /const sidecarRelative = `reports\/\$\{id\}\.provenance\.json`/);
  assert.match(artifact, /Publication artifact report and sidecar ids do not pair exactly/);
  assert.match(artifact, /await writeNewFileDurably\(sidecarPath, sidecar\)/);
});

test("official actions are pinned to reviewed Node-24-compatible releases", () => {
  const approvedPins = new Map([
    ["actions/checkout", "3d3c42e5aac5ba805825da76410c181273ba90b1"],
    ["actions/create-github-app-token", "f418cff399f7aef4c2f0ad47e25ca7a6abbdd6fc"],
    ["actions/setup-node", "949feb2413d6458794dcd2491c4babbbce0c15c1"],
    ["actions/upload-artifact", "cf430e030ddbb5b0abf93d22962f4752f3646cd9"]
  ]);
  const workflowsDir = path.join(root, ".github", "workflows");
  for (const name of readdirSync(workflowsDir).filter((entry) => entry.endsWith(".yml"))) {
    const contents = readFileSync(path.join(workflowsDir, name), "utf8");
    for (const match of contents.matchAll(
      /uses:\s*(actions\/(?:checkout|create-github-app-token|setup-node|upload-artifact))@([^\s#]+)/g
    )) {
      const [, action, ref] = match;
      assert.equal(ref, approvedPins.get(action), `${name}: ${action}`);
    }
  }
});

test("Dependabot covers every tracked dependency ecosystem at its manifest path", () => {
  const config = source(".github/dependabot.yml");
  const configuredPaths = [...config.matchAll(/- package-ecosystem: "([^"]+)"\n\s+directory: "([^"]+)"/g)].map(
    ([, ecosystem, directory]) => [ecosystem, directory]
  );

  assert.deepEqual(configuredPaths, [
    ["npm", "/"],
    ["cargo", "/tools/adblock-wasm"],
    ["cargo", "/tools/trust-kernel"],
    ["docker", "/"],
    ["github-actions", "/"]
  ]);
  assert.equal(config.match(/interval: "weekly"/g)?.length, configuredPaths.length);
});

test("automation logs do not print raw local input paths or filter rules", () => {
  const pageGraph = source("lib/pagegraph-corpus-cli.ts");
  assert.equal(pageGraph.includes("path.basename(file)"), false);
  assert.equal(pageGraph.includes("JSON.stringify(options.rule)"), false);
});

test("scheduled v3 corpus refresh isolates untrusted scanning, keeps the Chromium sandbox enabled, and proposes updates via PR", () => {
  const workflow = source(".github/workflows/seed-v3-corpus.yml");
  const scanStart = workflow.indexOf("\n  seed-v3-corpus:");
  const proposeStart = workflow.indexOf("\n  propose-update:");
  assert.ok(scanStart >= 0 && proposeStart > scanStart);
  const scanJob = workflow.slice(scanStart, proposeStart);
  const proposeJob = workflow.slice(proposeStart);

  // Untrusted scanning stays strictly read-only with Chromium sandbox enabled.
  assert.match(scanJob, /permissions:\n\s+contents: read/);
  assert.doesNotMatch(scanJob, /contents: write|pull-requests: write|issues: write/);
  assert.match(scanJob, /SITE_BEHAVIOR_LAB_CHROMIUM_SANDBOX: "1"/);
  assert.match(scanJob, /kernel\.apparmor_restrict_unprivileged_userns=0/);
  assert.ok(
    scanJob.indexOf("kernel.apparmor_restrict_unprivileged_userns=0") <
      scanJob.indexOf("npx playwright install --with-deps chromium"),
    "the hosted runner must allow Chromium user namespaces before Chromium is installed and launched"
  );
  assert.doesNotMatch(workflow, /--no-sandbox/);
  assert.doesNotMatch(workflow, /SITE_BEHAVIOR_LAB_CHROMIUM_SANDBOX: "0"/);
  assert.match(scanJob, /node bin\/sbl\.mjs verify/);

  // Publisher validates SHA-256 digests, schema, and redaction offline and opens a PR.
  assert.match(proposeJob, /npm ci --ignore-scripts/);
  assert.match(proposeJob, /validateScanReportV3/);
  assert.match(proposeJob, /assertNoUnredactedSecretsV3/);
  assert.match(proposeJob, /PROPOSAL_BRANCH: automation\/seed-v3-corpus-/);
  assert.match(proposeJob, /gh pr create/);
  assert.doesNotMatch(proposeJob, /git push origin main|git push origin HEAD:refs\/heads\/main/);
});
