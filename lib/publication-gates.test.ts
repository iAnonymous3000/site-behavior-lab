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

test("featured scans defer only the repeated corpus-wide check to their trusted parent", () => {
  const ci = source("scripts/run-ci-scan.mjs");
  const featured = source("scripts/run-featured-scans.mjs");

  assert.match(ci, /process\.env\.CI_SCAN_DEFER_CORPUS_CHECK !== "1"/);
  assert.match(featured, /CI_SCAN_DEFER_CORPUS_CHECK: "1"/);
  const main = featured.slice(
    featured.indexOf("async function main"),
    featured.indexOf("export function featuredRunPlan")
  );
  assert.ok(
    main.indexOf("for (const [index, site] of sites.entries())") <
      main.indexOf('"reports:remediate", "--", "--check"'),
    "the parent must run its full-corpus check after all deferred children"
  );
});

test("scan artifacts and commits include provenance sidecars", () => {
  const scan = source(".github/workflows/scan.yml");
  const featured = source(".github/workflows/scan-featured.yml");
  for (const workflow of [scan, featured]) {
    assert.match(workflow, /reports:publication-artifact -- \\\n\s+--prepare/);
    assert.match(workflow, /reports:publication-artifact -- \\\n\s+--publish/);
    assert.match(workflow, /git add public\/reports public\/corpus-stats\.json/);
  }

  const artifact = source("lib/report-publication-artifact.ts");
  assert.match(artifact, /const sidecarRelative = `reports\/\$\{id\}\.provenance\.json`/);
  assert.match(artifact, /Publication artifact report and sidecar ids do not pair exactly/);
  assert.match(artifact, /await writeNewFileDurably\(sidecarPath, sidecar\)/);
});

test("official actions are pinned to reviewed Node-24-compatible releases", () => {
  const approvedPins = new Map([
    ["actions/checkout", "3d3c42e5aac5ba805825da76410c181273ba90b1"],
    ["actions/create-github-app-token", "bcd2ba49218906704ab6c1aa796996da409d3eb1"],
    ["actions/setup-node", "a0853c24544627f65ddf259abe73b1d18a591444"],
    ["actions/upload-artifact", "043fb46d1a93c77aae656e7c1c64a875d1fc6a0a"]
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

test("the workflow_run promotion never checks out code the triggering event chose", () => {
  // checkout v7 refuses fork pull-request code under workflow_run because that
  // trigger runs privileged. This job is the one that runs under it, so its
  // checkout must stay a literal same-repository ref: resolving anything from
  // github.event.workflow_run would be both refused by the action and the
  // exact confused-deputy this repo's promotion gate exists to prevent.
  const workflow = source(".github/workflows/promote-production.yml");
  const checkoutStep = workflow.slice(
    workflow.indexOf("- name: Checkout main history"),
    workflow.indexOf("- name: Confirm every CI test gate passed")
  );
  assert.ok(checkoutStep.length > 0, "the promotion checkout step could not be located");
  assert.match(checkoutStep, /^\s+ref: main$/m);
  assert.doesNotMatch(checkoutStep, /\$\{\{/, "the promotion checkout ref must not be interpolated from the event");
  assert.doesNotMatch(checkoutStep, /repository:/, "the promotion must never check out another repository");
});

test("a measurement freeze quiesces Dependabot bookkeeping loudly", () => {
  const workflow = source(".github/workflows/dependabot-bookkeeping.yml");
  assert.match(
    workflow,
    /repair:\n\s+name: Regenerate derived manifests on Dependabot branches\n[\s\S]{0,300}?if: vars\.SITE_BEHAVIOR_LAB_MEASUREMENT_FREEZE != '1'/
  );
  assert.match(
    workflow,
    /measurement-freeze-notice:\n\s+name: Measurement freeze notice\n\s+if: vars\.SITE_BEHAVIOR_LAB_MEASUREMENT_FREEZE == '1'/
  );
});

test("the Dependabot bookkeeping repair cannot run or be rewritten by the branch it repairs", () => {
  // This job holds contents:write and operates on branches whose contents are
  // an untrusted dependency bump, so three properties carry the whole design.
  const workflow = source(".github/workflows/dependabot-bookkeeping.yml");

  // 1. It never installs or executes the bump. The inventory generator only
  //    reads and hashes declarative files; an install here would run the new
  //    dependency's lifecycle scripts with write access to the repository.
  // Command position only: the phrase "npm install" also appears inside a
  // commit-message argument explaining why the bookkeeping went stale, and a
  // substring match there would be a false positive.
  const commandLines = workflow
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  for (const line of commandLines) {
    assert.doesNotMatch(line, /^(npm (ci|install|exec|run)|npx)\b/, line);
    assert.doesNotMatch(line, /(&&|\|\||;)\s*(npm (ci|install|exec|run)|npx)\b/, line);
  }

  // 2. Only `schedule` and `workflow_dispatch`, which GitHub always runs from
  //    the DEFAULT branch's copy of the file. A `push` or `pull_request`
  //    trigger would let a pushed branch rewrite the privileged job itself.
  assert.match(workflow, /^on:$/m);
  assert.match(workflow, /^ {2}schedule:$/m);
  assert.match(workflow, /^ {2}workflow_dispatch:$/m);
  for (const forbidden of ["push", "pull_request", "pull_request_target", "workflow_run"]) {
    assert.doesNotMatch(workflow, new RegExp(`^ {2}${forbidden}:`, "m"), forbidden);
  }

  // 3. It writes only inside Dependabot's own branch namespace, and refuses
  //    any other branch it is handed.
  assert.match(workflow, /dependabot\/\*\) branches="\$REQUESTED_BRANCH" ;;/);
  assert.match(workflow, /is not a dependabot\/\* branch/);
  assert.match(workflow, /git push origin "HEAD:\$branch"/);
  // A force-push would let this job discard whatever it did not expect to find
  // on the branch. Local `git checkout --force` is unrelated and allowed.
  for (const line of commandLines) {
    if (!/\bgit push\b/.test(line)) continue;
    assert.doesNotMatch(line, /(--force\b|--force-with-lease\b|\s-f\b|\s\+refs)/, line);
  }

  // Least privilege: read by default, write only on the one job.
  assert.match(workflow, /^permissions:\n {2}contents: read$/m);
});

test("Dependabot covers every tracked dependency ecosystem at its manifest path", () => {
  const config = source(".github/dependabot.yml");
  const configuredPaths = [...config.matchAll(/- package-ecosystem: "([^"]+)"\n\s+directory: "([^"]+)"/g)].map(
    ([, ecosystem, directory]) => [ecosystem, directory]
  );

  assert.deepEqual(configuredPaths, [
    ["npm", "/"],
    ["cargo", "/tools/adblock-wasm"],
    ["docker", "/"],
    ["github-actions", "/"]
  ]);
  assert.equal(config.match(/interval: "weekly"/g)?.length, configuredPaths.length);
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

test("featured refresh failures publish only validated successes, stay loud, and remain tracked", () => {
  const workflow = source(".github/workflows/scan-featured.yml");
  const runner = source("scripts/run-featured-scans.mjs");

  assert.match(runner, /featuredMinimumSuccessRate\(process\.env\.FEATURED_MIN_SUCCESS_RATE, 0\.9, 0\.8\)/);
  assert.match(workflow, /FEATURED_MIN_SUCCESS_RATE: \$\{\{ vars\.FEATURED_MIN_SUCCESS_RATE \|\| '0\.8' \}\}/);
  assert.match(workflow, /permissions:[\s\S]*?issues: write/);
  assert.match(workflow, /id: featured_scan\n\s+continue-on-error: true/);
  assert.match(workflow, /--classify-publication/);
  assert.match(
    workflow,
    /- name: Rebuild trusted retention and aggregate outputs[\s\S]*?npm run reports:prune[\s\S]*?npm run reports:remediate -- --check[\s\S]*?npm run reports:manifest[\s\S]*?npm run corpus:stats/
  );
  assert.match(workflow, /- name: Verify report redaction and provenance[\s\S]*?steps\.refresh_policy\.outputs\.publishable == 'true'/);
  assert.match(workflow, /- name: Build corpus stats[\s\S]*?steps\.report_manifest\.outcome == 'success'/);
  assert.match(workflow, /- name: Rebuild trusted retention and aggregate outputs[\s\S]*?- name: Commit static reports/);
  assert.match(workflow, /steps\.refresh_alert\.outputs\.authoritative == 'true'/);
  assert.match(workflow, /site-behavior-lab:featured-corpus-refresh/);
  assert.match(workflow, /MANAGED_ISSUE_LABEL: site-behavior-lab-featured-refresh/);
  assert.match(workflow, /issue\.user\?\.login === "github-actions\[bot\]"/);
  assert.match(workflow, /issue\.user\?\.type === "Bot"/);
  assert.match(workflow, /labels\.includes\(managedLabel\)/);
  assert.match(workflow, /issue\.title === process\.env\.ISSUE_TITLE/);
  assert.match(workflow, /issue_needs_label/);
  assert.match(workflow, /--add-label "\$MANAGED_ISSUE_LABEL"/);
  assert.match(workflow, /gh api --silent --method POST "repos\/\$\{GITHUB_REPOSITORY\}\/labels"/);
  assert.match(workflow, /--label "\$MANAGED_ISSUE_LABEL"/);
  assert.match(workflow, /gh issue create/);
  assert.match(workflow, /gh issue edit/);
  assert.match(workflow, /gh issue reopen/);
  assert.match(workflow, /gh issue close/);
  assert.match(workflow, /::error title=Featured corpus refresh failed::/);
  assert.match(workflow, /- name: Preserve featured-refresh failure[\s\S]*?exit 1/);
});

test("the featured scan keeps the Chromium sandbox on and makes the runner support it", () => {
  const workflow = readFileSync(
    path.join(process.cwd(), ".github", "workflows", "scan-featured.yml"),
    "utf8"
  );
  // Committed-report acquisition is forbidden from launching Chromium without
  // its sandbox, so the sandbox switch must stay on.
  assert.match(workflow, /SITE_BEHAVIOR_LAB_CHROMIUM_SANDBOX: "1"/);
  // GitHub-hosted Ubuntu 24.04 restricts unprivileged user namespaces with
  // AppArmor, which made every scan die at browser launch with "No usable
  // sandbox!". The remedy must be to let the sandbox initialize, never to
  // launch without one.
  assert.match(workflow, /kernel\.apparmor_restrict_unprivileged_userns=0/);
  assert.match(
    workflow,
    /- name: Allow the Chromium sandbox to initialize on the hosted runner\n\s+if: runner\.environment == 'github-hosted'/
  );
  assert.match(
    workflow,
    /- name: Verify Chromium sandbox support on the controlled runner\n\s+if: runner\.environment == 'self-hosted'/
  );
  const selfHostedVerification = workflow.slice(
    workflow.indexOf("- name: Verify Chromium sandbox support on the controlled runner"),
    workflow.indexOf("- name: Install Chromium")
  );
  assert.match(selfHostedVerification, /refusing to change a host-wide kernel setting from the job/);
  assert.doesNotMatch(selfHostedVerification, /sudo\s+sysctl\s+-w/);
  assert.ok(
    workflow.indexOf("kernel.apparmor_restrict_unprivileged_userns=0") <
      workflow.indexOf("npx playwright install --with-deps chromium"),
    "the sandbox must be made usable before Chromium is installed and launched"
  );
  assert.doesNotMatch(workflow, /--no-sandbox/);
  assert.doesNotMatch(workflow, /SITE_BEHAVIOR_LAB_CHROMIUM_SANDBOX: "0"/);
  // The scanner log stays diagnosable when scans fail for any other reason.
  assert.match(workflow, /Show scanner log when the scans failed/);
});
