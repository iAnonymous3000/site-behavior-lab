import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { gitFixtureEnv, initFixtureRepo, removeFixtureTree, runFixtureGit } from "./git-fixture";

/**
 * A deploy asks Production Health to verify what it deployed, and names it.
 * A health run that finds production already advanced still verifies the
 * pin, and records the requesting deploy as superseded instead of leaving
 * its verification unrecorded. The step that records it is run here as the
 * workflow runs it, against a real git history.
 */
const WORKFLOWS = path.join(process.cwd(), ".github", "workflows");
const read = (name: string) => readFileSync(path.join(WORKFLOWS, name), "utf8");
const STEP = "- name: Record which deploy requested this run";

test("both deployers name the revision and the run they ask Production Health to verify", () => {
  for (const name of ["deploy-container.yml", "deploy-pages.yml"]) {
    assert.match(
      read(name),
      /gh workflow run production-health\.yml --ref production\n\s+-f expected_sha="\$GITHUB_SHA" -f deploy_run="\$GITHUB_RUN_ID"\n/,
      `both deployers name the revision and the run they ask Production Health to verify (${name})`
    );
  }
  const health = read("production-health.yml");
  assert.match(health, /workflow_dispatch:\n {4}inputs:\n[\s\S]*? {6}expected_sha:\n[\s\S]*? {6}deploy_run:\n/);
  assert.match(health, /REQUESTED_SHA: \$\{\{ inputs\.expected_sha \}\}\n {10}REQUESTED_BY_RUN: \$\{\{ inputs\.deploy_run \}\}\n/);
});

function stepScript(): string {
  const workflow = read("production-health.yml");
  const start = workflow.indexOf(STEP);
  assert.ok(start !== -1, "Production Health carries its deploy-request step");
  const run = workflow.indexOf("run: |\n", start);
  const next = workflow.indexOf("\n      - name:", start + STEP.length);
  assert.ok(run !== -1 && run < next, "the deploy-request step carries a literal shell block");
  return workflow.slice(run + "run: |\n".length, next).split("\n").map((line) => line.replace(/^ {10}/, "")).join("\n");
}

function runStep(requested: "pin" | "earlier" | "outside" | "none"): { status: number | null; output: string; summary: string } {
  const root = mkdtempSync(path.join(tmpdir(), "sbl-health-deploy-request-"));
  try {
    const git = (...args: string[]) => runFixtureGit(root, args).trim();
    initFixtureRepo(root);
    git("checkout", "--quiet", "-b", "production");
    const commit = (message: string) => {
      git("commit", "--quiet", "--allow-empty", "-m", message);
      return git("rev-parse", "HEAD");
    };
    const earlier = commit("a deploy's revision");
    git("checkout", "--quiet", "-b", "side");
    const outside = commit("a revision production never held");
    git("checkout", "--quiet", "production");
    const pin = commit("the later promotion this run pins");
    const summary = path.join(root, "summary.md");
    writeFileSync(summary, "");
    const sha = { pin, earlier, outside, none: "" }[requested];
    const result = spawnSync("bash", ["-c", stepScript()], {
      cwd: root,
      encoding: "utf8",
      // The step's own git calls get the fixture configuration too.
      env: gitFixtureEnv({ REQUESTED_SHA: sha, REQUESTED_BY_RUN: "123456", EXPECTED_PRODUCTION_SHA: pin, GITHUB_STEP_SUMMARY: summary })
    });
    return { status: result.status, output: `${result.stdout}${result.stderr}`, summary: readFileSync(summary, "utf8") };
  } finally {
    removeFixtureTree(root);
  }
}

test("a deploy whose revision production advanced past is recorded as superseded", () => {
  const outcome = runStep("earlier");
  assert.equal(outcome.status, 0, outcome.output);
  assert.match(outcome.output, /::notice title=Deploy superseded::deploy run 123456 asked to verify /, "a deploy whose revision production advanced past is recorded as superseded");
  assert.match(outcome.summary, /\*\*superseded\*\* by production/, "a deploy whose revision production advanced past is recorded as superseded (summary)");
});

test("a deploy of the pinned revision is recorded as the one this run verifies", () => {
  const outcome = runStep("pin");
  assert.equal(outcome.status, 0, outcome.output);
  assert.doesNotMatch(outcome.output, /Deploy superseded/);
  assert.match(outcome.summary, /the revision this run verifies/);
});

test("a deploy request for a revision production does not contain fails the run", () => {
  const outcome = runStep("outside");
  assert.notEqual(outcome.status, 0, "a deploy request for a revision production does not contain fails the run");
  assert.match(outcome.output, /Deploy request outside production/, "a deploy request for a revision production does not contain fails the run");
});

test("a run no deploy asked for records nothing about a deploy", () => {
  const outcome = runStep("none");
  assert.equal(outcome.status, 0, outcome.output);
  assert.equal(outcome.summary, "");
});
