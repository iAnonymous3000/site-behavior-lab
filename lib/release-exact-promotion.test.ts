import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { gitFixtureEnv, initFixtureRepo, removeFixtureTree, runFixtureGit } from "./git-fixture";

/**
 * The release's promotion requirement, run as the workflow runs it: the
 * step's own shell, against a real git history and a stub `gh` that answers
 * the deploy-run lookup by the query it receives. Reachable from production
 * is not promoted: a later push can carry production past a revision it
 * never held as its tip, and a tag on that revision would claim a promotion
 * that never happened.
 */
const STEP = "- name: Require the revision to be already promoted to production";

function stepScript(): string {
  const workflow = readFileSync(path.join(process.cwd(), ".github", "workflows", "release.yml"), "utf8");
  const start = workflow.indexOf(STEP);
  assert.ok(start !== -1, "the release workflow carries its promotion step");
  const run = workflow.indexOf("run: |\n", start);
  const next = workflow.indexOf("\n      - name:", start + STEP.length);
  assert.ok(run !== -1 && run < next, "the promotion step carries a literal shell block");
  return workflow
    .slice(run + "run: |\n".length, next)
    .split("\n")
    .map((line) => line.replace(/^ {10}/, ""))
    .join("\n");
}

type Outcome = { status: number | null; output: string };

function runStep(options: { release: "promoted" | "skipped" | "outside"; exactRuns: number }): Outcome {
  const root = mkdtempSync(path.join(tmpdir(), "sbl-release-promotion-"));
  try {
    const git = (cwd: string, ...args: string[]) => runFixtureGit(cwd, args).trim();
    const origin = path.join(root, "origin.git");
    const work = path.join(root, "work");
    mkdirSync(origin);
    mkdirSync(work);
    git(origin, "init", "--quiet", "--bare");
    initFixtureRepo(work);
    git(work, "checkout", "--quiet", "-b", "main");
    const commit = (message: string) => {
      git(work, "commit", "--quiet", "--allow-empty", "-m", message);
      return git(work, "rev-parse", "HEAD");
    };
    const skipped = commit("a revision a later push carried production past");
    const tip = commit("the revision production holds");
    git(work, "checkout", "--quiet", "-b", "side", skipped);
    const outside = commit("a revision production never reached");
    git(work, "remote", "add", "origin", origin);
    git(work, "push", "--quiet", "origin", `${tip}:refs/heads/production`);
    const release = options.release === "promoted" ? tip : options.release === "skipped" ? skipped : outside;

    const bin = path.join(root, "bin");
    mkdirSync(bin);
    // Answers the lookup for the exact SHA with exactRuns, and any lookup that
    // does not filter by that SHA with five runs of other revisions.
    writeFileSync(
      path.join(bin, "gh"),
      [
        "#!/usr/bin/env bash",
        'url="$2"',
        'if [[ "$1" != api || "$url" != *"/actions/workflows/deploy-container.yml/runs?"* ]]; then echo "unexpected gh $*" >&2; exit 2; fi',
        'if [[ "$url" == *"head_sha=${RELEASE_SHA}"* && "$url" == *"event=push"* && "$url" == *"branch=production"* ]]; then echo "$SHIM_EXACT_RUNS"; else echo 5; fi'
      ].join("\n") + "\n"
    );
    chmodSync(path.join(bin, "gh"), 0o755);
    const result = spawnSync("bash", ["-c", stepScript()], {
      cwd: work,
      encoding: "utf8",
      // The step's own git calls get the fixture configuration too.
      env: gitFixtureEnv({
        PATH: `${bin}:${process.env.PATH}`,
        RELEASE_SHA: release,
        GITHUB_REPOSITORY: "owner/repo",
        SHIM_EXACT_RUNS: String(options.exactRuns)
      })
    });
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
  } finally {
    removeFixtureTree(root);
  }
}

test("an exactly promoted revision may be tagged", () => {
  const outcome = runStep({ release: "promoted", exactRuns: 1 });
  assert.equal(outcome.status, 0, `an exactly promoted revision may be tagged (${outcome.output})`);
});

test("a revision production was carried past, and never held, is refused", () => {
  const outcome = runStep({ release: "skipped", exactRuns: 0 });
  assert.notEqual(outcome.status, 0, "a revision production was carried past, and never held, is refused");
  assert.match(outcome.output, /production never held it as its tip/, "a revision production was carried past, and never held, is refused");
});

test("a revision outside production is refused before any lookup", () => {
  const outcome = runStep({ release: "outside", exactRuns: 1 });
  assert.notEqual(outcome.status, 0);
  assert.match(outcome.output, /is not reachable from production/, "a revision outside production is refused before any lookup");
});
