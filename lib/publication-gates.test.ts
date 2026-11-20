import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { spawnSyncBounded } from "./bounded-spawn";

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
    ["actions/create-github-app-token", "64ab729a6294000f5aa4a4bc0b73d1f32bc45510"],
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

  // 3. It writes only inside Dependabot's own branch namespace: the two
  //    tests below run the repair step and show it refuses any input that is
  //    not exactly one dependabot/* branch, runs only main's code on a
  //    branch's files, and hands the token to git's remote calls alone. The
  //    checkout keeps no token for a script to read.
  assert.match(workflow, /ref: main\n {10}fetch-depth: 0\n {10}persist-credentials: false\n/);
  assert.match(workflow, /remote_git -C "\$worktree" push origin "HEAD:refs\/heads\/\$branch"/);
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
    ["cargo", "/tools/trust-kernel"],
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
    /- name: Apply retention policy and rebuild trusted aggregate outputs[\s\S]*?npm run reports:prune[\s\S]*?npm run reports:remediate -- --check[\s\S]*?npm run reports:manifest[\s\S]*?npm run corpus:stats/
  );
  assert.match(workflow, /- name: Verify report redaction and provenance[\s\S]*?steps\.refresh_policy\.outputs\.publishable == 'true'/);
  assert.match(workflow, /- name: Build corpus stats[\s\S]*?steps\.report_manifest\.outcome == 'success'/);
  assert.match(workflow, /- name: Apply retention policy and rebuild trusted aggregate outputs[\s\S]*?- name: Commit static reports/);
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

// The repair step of .github/workflows/dependabot-bookkeeping.yml, run as
// Actions runs it: its own text in bash, with `git` and `node` replaced by
// recorders on PATH. The recorders log every call with its working folder,
// and record whether the job's token reached any process but git's own
// remote calls, which take it only as an argument.
type RepairCall = { tool: string; cwd: string; args: string[]; sawToken: boolean };

function runRepairStep(requested: string, remoteBranches: string[] = []): { status: number | null; stdout: string; calls: RepairCall[]; workspace: string; runnerTemp: string } {
  const workflow = readFileSync(path.join(process.cwd(), ".github", "workflows", "dependabot-bookkeeping.yml"), "utf8");
  const start = workflow.indexOf("      - name: Repair derived manifests\n");
  assert.ok(start >= 0, "the workflow has no repair step");
  const step = workflow.slice(start);
  const runAt = step.indexOf("\n        run: |\n");
  const body: string[] = [];
  for (const line of step.slice(runAt + "\n        run: |\n".length).split("\n")) {
    if (line.trim() !== "" && !line.startsWith("          ")) break;
    body.push(line.slice(10));
  }
  const token = "ghs_fixtureTokenThatMustNotLeak0123456789";
  const context: Record<string, string> = { "inputs.branch": requested, "github.token": token };
  const env: Record<string, string> = {};
  for (const match of step.slice(0, runAt).matchAll(/^ {10}([A-Z0-9_]+): \$\{\{ ([a-z.]+) \}\}$/gm)) {
    assert.ok(match[2] in context, `the model does not know ${match[2]}`);
    env[match[1]] = context[match[2]];
  }
  const temp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "sbl-dependabot-repair-")));
  const workspace = path.join(temp, "workspace");
  const runnerTemp = path.join(temp, "runner-temp");
  const bin = path.join(temp, "bin");
  for (const directory of [workspace, runnerTemp, bin]) mkdirSync(directory);
  writeFileSync(path.join(temp, "token"), token);
  writeFileSync(path.join(temp, "ls-remote"), remoteBranches.map((branch) => `${"a".repeat(40)}\trefs/heads/${branch}\n`).join(""));
  const realGit = spawnSyncBounded("bash", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  // Each call is one line: tool, working folder, token seen, then its
  // arguments, all separated by the unit separator.
  const recorder = (tool: string, act: string) => `#!/bin/bash
seen=0
if env | grep -qF -- "$(cat "$FIXTURE/token")"; then seen=1; fi
{ printf '%s\\x1f%s\\x1f%s' ${tool} "$PWD" "$seen"; for argument in "$@"; do printf '\\x1f%s' "$argument"; done; printf '\\n'; } >> "$FIXTURE/calls"
${act}
`;
  writeFileSync(path.join(bin, "node"), recorder("node", "exit 0"), { mode: 0o755 });
  writeFileSync(path.join(bin, "git"), recorder("git", `
for argument in "$@"; do
  case "$argument" in
    check-ref-format) exec "${realGit}" "$@" ;;
    ls-remote) cat "$FIXTURE/ls-remote"; exit 0 ;;
    diff) exit 1 ;;
  esac
done
if [ "$1" = "worktree" ] && [ "$2" = "add" ]; then mkdir -p "\${@: -2:1}"; fi
if [ "$1" = "worktree" ] && [ "$2" = "remove" ]; then rm -rf "\${@: -1}"; fi
if [ "$1" = "checkout" ]; then :; fi
exit 0`), { mode: 0o755 });
  const result = spawnSyncBounded("bash", ["-c", body.join("\n")], {
    encoding: "utf8",
    cwd: workspace,
    env: { PATH: `${bin}:${process.env.PATH ?? ""}`, FIXTURE: temp, RUNNER_TEMP: runnerTemp, GITHUB_WORKSPACE: workspace, ...env }
  });
  const calls = existsSync(path.join(temp, "calls"))
    ? readFileSync(path.join(temp, "calls"), "utf8").split("\n").filter((line) => line !== "").map((line) => {
      const [tool, cwd, seen, ...args] = line.split("\x1f");
      return { tool, cwd, args, sawToken: seen === "1" };
    })
    : [];
  rmSync(temp, { recursive: true, force: true });
  return { status: result.status, stdout: result.stdout, calls, workspace, runnerTemp };
}

const pushes = (calls: RepairCall[]) => calls.filter((call) => call.tool === "git" && call.args.includes("push"));
const authorized = (call: RepairCall) => call.args.some((argument) => argument.startsWith("http.https://github.com/.extraheader=AUTHORIZATION: basic "));

test("the Dependabot repair refuses any requested branch that is not exactly one dependabot/* branch, before it touches a branch", () => {
  for (const requested of [
    "dependabot/npm_and_yarn/x main",
    "dependabot/npm_and_yarn/x\nproduction",
    "main",
    "production",
    "dependabot/*",
    "dependabot/npm_and_yarn/x;touch pwned",
    "dependabot/../main",
    "dependabot/x..y",
    " dependabot/npm_and_yarn/x"
  ]) {
    const run = runRepairStep(requested);
    assert.notEqual(run.status, 0, `${JSON.stringify(requested)}: the repair accepted it`);
    assert.match(run.stdout, /::error title=Refused::the requested branch is not one dependabot\/\* branch/, JSON.stringify(requested));
    const acted = run.calls.filter((call) => call.tool === "node" || ["worktree", "checkout", "commit", "push"].some((verb) => call.args.includes(verb)));
    assert.deepEqual(acted, [], `${JSON.stringify(requested)}: the repair acted on a branch`);
  }
});

test("the Dependabot repair refuses a scheduled run whose listing holds a branch that is not one dependabot/* branch, before it touches a branch", () => {
  const run = runRepairStep("", ["dependabot/npm_and_yarn/next-16.1.0", "dependabot/npm_and_yarn/x;touch-pwned"]);
  assert.notEqual(run.status, 0, "the repair accepted the listing");
  assert.match(run.stdout, /::error title=Refused::a listed branch is not one dependabot\/\* branch/);
  const acted = run.calls.filter((call) => call.tool === "node" || ["worktree", "checkout", "commit", "push"].some((verb) => call.args.includes(verb)));
  assert.deepEqual(acted, [], "the repair acted on a branch of the listing");
});

test("the Dependabot repair runs only main's code on a branch's files, and hands the token to git's remote calls alone", () => {
  for (const [what, requested, remote] of [
    ["one requested branch", "dependabot/npm_and_yarn/next-16.1.0", ["dependabot/cargo/serde-1.0.0"]],
    ["every open branch", "", ["dependabot/npm_and_yarn/next-16.1.0", "dependabot/cargo/serde-1.0.0"]]
  ] as [string, string, string[]][]) {
    const run = runRepairStep(requested, remote);
    assert.equal(run.status, 0, `${what}: the repair failed: ${run.stdout}`);
    const expected = requested === "" ? remote : [requested];
    // No branch is ever checked out where main's code runs; each is read
    // in a worktree of its own, by main's inventory script.
    assert.ok(!run.calls.some((call) => call.tool === "git" && call.args[0] === "checkout"), `${what}: a branch was checked out over main`);
    assert.deepEqual(
      pushes(run.calls).map((call) => call.args[call.args.length - 1]),
      expected.map((branch) => `HEAD:refs/heads/${branch}`),
      `${what}: the repair pushed to other branches`
    );
    assert.ok(pushes(run.calls).every(authorized), `${what}: a push carries no token`);
    for (const call of run.calls) {
      assert.equal(call.sawToken, false, `${what}: ${call.tool} ${call.args.join(" ")} could read the token`);
      if (call.tool === "git" && authorized(call)) {
        assert.ok(call.args.includes("push") || call.args.includes("ls-remote"), `${what}: git ${call.args.join(" ")} was given the token`);
      }
    }
    const nodes = run.calls.filter((call) => call.tool === "node");
    assert.equal(nodes.length, expected.length * 2, `${what}: node ran another number of times`);
    for (const call of nodes) {
      if (call.args.includes("scripts/third-party-inventory.mjs")) {
        assert.equal(call.cwd, run.workspace, `${what}: the inventory script ran from the branch`);
        assert.deepEqual(call.args.slice(0, 1), ["scripts/third-party-inventory.mjs"]);
        assert.equal(call.args[1], "--root", `${what}: the inventory script was not pointed at the branch`);
        assert.ok(call.args[2].startsWith(run.runnerTemp), `${what}: the inventory read another folder`);
      } else {
        assert.equal(call.args[0], "--input-type=module", `${what}: node ran something else`);
        assert.ok(call.cwd.startsWith(run.runnerTemp), `${what}: the lock repair ran outside the branch's worktree`);
      }
    }
  }
});
