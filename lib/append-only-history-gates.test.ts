import assert from "node:assert/strict";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSyncBounded } from "./bounded-spawn";
import { gitFixtureEnv, initFixtureRepo, removeFixtureTree, runFixtureGit } from "./git-fixture";
import {
  appendTransparencyLogEntries,
  buildTransparencyLog,
  type TransparencyLogAddition
} from "./publication-transparency-log";

/**
 * The append-only gates as CI runs them, against real git history.
 *
 * Each gate compares a file with the same file at a base revision, so the
 * choice of base is part of the gate, and that choice is workflow text. With
 * the previous tip of main as the only base, a rewrite pushed once and
 * followed by any other push is compared with itself and passes, because main
 * accepts a push whose run then fails.
 *
 * These tests run the workflow's own step text and the baseline script in a
 * throwaway clone with a production branch, then run the gate CLIs the gate
 * steps name against the baselines the step resolved.
 */

const root = process.cwd();
const ci = readFileSync(path.join(root, ".github", "workflows", "ci.yml"), "utf8");
const BASELINE_SCRIPT = path.join("scripts", "resolve-history-baselines.mjs");
const LEDGER_CLI = path.join(root, ".unit-test-dist", "lib", "corrections-ledger-history-cli.js");
const LOG_CLI = path.join(root, ".unit-test-dist", "lib", "publication-transparency-log-cli.js");
const LOG_PATH = path.join("public", "transparency-log.json");
const LEDGER_PATH = path.join("public", "corrections.json");
const PINNED_ID = "20250101-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const NOT_A_PULL_REQUEST = "${{ github.event_name != 'pull_request' }}";

type GateStep = { name: string; gate: "ledger" | "log"; output: string; condition: string | null };

/** The lines of one named step of ci.yml's tests job, from its `- name:` to the next step. */
function ciStep(name: string): string[] {
  const lines = ci.split("\n");
  const start = lines.indexOf(`      - name: ${name}`);
  assert.notEqual(start, -1, `ci.yml has no step named "${name}"`);
  const length = lines.slice(start + 1).findIndex((line) => /^ {6}- /.test(line) || /^ {0,4}\S/.test(line));
  return lines.slice(start, length === -1 ? lines.length : start + 1 + length);
}

/** A step's `run: |` block as the runner hands it to bash. */
function runBlock(step: readonly string[]): string {
  const at = step.indexOf("        run: |");
  assert.notEqual(at, -1, "the step must carry a run block");
  return step
    .slice(at + 1)
    .map((line) => line.replace(/^ {10}/, ""))
    .join("\n");
}

/**
 * Every step of the tests job that runs a history gate, read from the workflow
 * text: which gate, which resolved baseline it consumes, and under which
 * condition. The simulation below runs exactly these, so removing a step from
 * ci.yml removes its comparison here too.
 */
function historyGateSteps(): GateStep[] {
  const tests = ci.slice(ci.indexOf("\n  tests:\n"), ci.indexOf("\n  pages:\n"));
  const steps: GateStep[] = [];
  for (const block of tests.split(/\n(?= {6}- name: )/)) {
    const run = /^ {8}run: npm run (corrections|transparency):verify-history -- "\$\{\{ steps\.corrections_baseline\.outputs\.(\w+) \}\}"$/m.exec(block);
    if (!run) {
      assert.doesNotMatch(block, /verify-history/, "a history gate step this test cannot read");
      continue;
    }
    steps.push({
      name: /^ {6}- name: (.+)$/m.exec(block)?.[1] ?? "",
      gate: run[1] === "corrections" ? "ledger" : "log",
      output: run[2],
      condition: /^ {8}if: (.+)$/m.exec(block)?.[1] ?? null
    });
  }
  return steps;
}

function additions(count: number, wire = "a"): TransparencyLogAddition[] {
  return Array.from({ length: count }, (_, index) => ({
    reportId: `20250101-${String(index).padStart(32, "0")}`,
    reportWireSha256: wire.repeat(64),
    publicDigest: "b".repeat(64)
  }));
}

function logWire(entries: readonly TransparencyLogAddition[]): string {
  return `${JSON.stringify(buildTransparencyLog(appendTransparencyLogEntries([], entries)), null, 2)}\n`;
}

function ledgerWire(summaries: readonly string[]): string {
  return `${JSON.stringify(
    {
      $schema: "https://sitebehavior.org/corrections.schema.json",
      schemaVersion: 1,
      policy: "https://sitebehavior.org/corrections/",
      entries: summaries.map((summary, index) => ({
        eventId: `SBL-CORR-2025-00${index + 1}`,
        publishedAt: `2025-01-0${index + 1}T12:00:00.000Z`,
        state: "active",
        reportIds: [PINNED_ID],
        summary,
        detailsUrl: "https://sitebehavior.org/corrections/example/"
      }))
    },
    null,
    2
  )}\n`;
}

/**
 * A remote whose `production` branch is the last promoted state, and a clone
 * of it holding main. Commits made in the clone are pushes to main that
 * production has not caught up with. `production: false` leaves the remote
 * without that branch, as a repository that never promoted anything.
 */
function fixture(options: { production: boolean } = { production: true }): {
  parent: string;
  work: string;
  promoted: string;
  commit: (message: string) => string;
} {
  const parent = mkdtempSync(path.join(tmpdir(), "sbl-history-gates-"));
  const remote = path.join(parent, "remote");
  const work = path.join(parent, "work");
  mkdirSync(path.join(remote, "public", "reports"), { recursive: true });
  writeFileSync(path.join(remote, LOG_PATH), logWire(additions(3)));
  writeFileSync(path.join(remote, LEDGER_PATH), ledgerWire(["The reviewed evidence remains active."]));
  writeFileSync(path.join(remote, "public", "reports", `${PINNED_ID}.json`), "published-report-bytes\n");
  writeFileSync(path.join(remote, "public", "reports", `${PINNED_ID}.provenance.json`), "published-sidecar-bytes\n");
  initFixtureRepo(remote);
  runFixtureGit(remote, ["add", "public"]);
  runFixtureGit(remote, ["commit", "-qm", "promoted state"]);
  if (options.production) runFixtureGit(remote, ["branch", "production"]);
  runFixtureGit(parent, ["clone", "-q", remote, work]);
  runFixtureGit(work, ["config", "user.name", "Fixture"]);
  runFixtureGit(work, ["config", "user.email", "fixture@sitebehavior.invalid"]);
  // The step runs the script by its repository path, as the runner does.
  mkdirSync(path.join(work, "scripts"));
  copyFileSync(path.join(root, BASELINE_SCRIPT), path.join(work, BASELINE_SCRIPT));
  const head = () => runFixtureGit(work, ["rev-parse", "HEAD"]).trim();
  return {
    parent,
    work,
    promoted: head(),
    commit: (message) => {
      runFixtureGit(work, ["add", "public"]);
      runFixtureGit(work, ["commit", "-q", "--allow-empty", "-m", message]);
      return head();
    }
  };
}

/**
 * The same clone, with production two pushes past the commit the clone began
 * at: `promoted`, then `earlier`, then `newest`, where production points. The
 * clone holds all three, so a test can stand its HEAD at any of them the way
 * a run of that commit would.
 */
function fixtureWithLaterPromotions() {
  const base = fixture({ production: false });
  const remote = path.join(base.parent, "remote");
  const push = (message: string, entries: number) => {
    writeFileSync(path.join(remote, LOG_PATH), logWire(additions(entries)));
    runFixtureGit(remote, ["add", "public"]);
    runFixtureGit(remote, ["commit", "-qm", message]);
    return runFixtureGit(remote, ["rev-parse", "HEAD"]).trim();
  };
  const earlier = push("a later push", 4);
  const newest = push("the newest promoted push", 5);
  runFixtureGit(remote, ["branch", "production"]);
  runFixtureGit(base.work, ["fetch", "-q", "origin", "main"]);
  const standAt = (commit: string) => runFixtureGit(base.work, ["checkout", "-q", "--detach", commit]);
  return { ...base, earlier, newest, standAt };
}

type Event = { name: string; pushBefore?: string; pullRequestBase?: string };

/** Run ci.yml's own baseline step in `work`, and return what it wrote to $GITHUB_OUTPUT. */
function resolveBaselines(work: string, event: Event) {
  const outputPath = path.join(work, "..", "github-output");
  writeFileSync(outputPath, "");
  const result = spawnSyncBounded("bash", ["-c", runBlock(ciStep("Resolve the trusted corrections baseline"))], {
    cwd: work,
    encoding: "utf8",
    env: gitFixtureEnv({
      EVENT_NAME: event.name,
      PUSH_BEFORE: event.pushBefore ?? "",
      PULL_REQUEST_BASE: event.pullRequestBase ?? "",
      GITHUB_OUTPUT: outputPath
    })
  });
  const outputs = new Map(
    readFileSync(outputPath, "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)] as const)
  );
  return { status: result.status, stderr: result.stderr, outputs };
}

/** Run every history gate step that applies to this event, as the tests job would. */
function runHistoryGates(work: string, event: Event) {
  const resolved = resolveBaselines(work, event);
  assert.equal(resolved.status, 0, resolved.stderr);
  return historyGateSteps()
    .filter((step) => {
      if (step.condition === null) return true;
      // The one condition a gate step may carry. Anything else is a way to
      // skip a comparison that this simulation would not model.
      assert.equal(step.condition, NOT_A_PULL_REQUEST, `${step.name} runs under a condition this test does not model`);
      return event.name !== "pull_request";
    })
    .map((step) => {
      const baseline = resolved.outputs.get(step.output) ?? "";
      const result = spawnSyncBounded(
        process.execPath,
        step.gate === "ledger" ? [LEDGER_CLI, baseline] : [LOG_CLI, "--verify-history", baseline],
        { cwd: work, encoding: "utf8", env: gitFixtureEnv() }
      );
      return { step, baseline, status: result.status, output: result.stdout + result.stderr };
    });
}

function rewritePublishedHistory(work: string): void {
  writeFileSync(path.join(work, LOG_PATH), logWire(additions(3, "c")));
  writeFileSync(path.join(work, LEDGER_PATH), ledgerWire(["Reworded after publication."]));
}

test("the npm scripts the gate steps name still launch the two history CLIs this file runs", () => {
  const scripts = (JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;
  assert.equal(scripts["corrections:verify-history"], "node scripts/run-schema-cli.mjs corrections-ledger-history");
  assert.equal(scripts["transparency:verify-history"], "node scripts/run-schema-cli.mjs publication-transparency-log --verify-history");
  assert.ok(existsSync(LEDGER_CLI) && existsSync(LOG_CLI));
});

test("a rewrite pushed once is still refused on the next push, because production is also a base", () => {
  const { parent, work, promoted, commit } = fixture();
  try {
    rewritePublishedHistory(work);
    const rewrite = commit("X: rewrite the log and an earlier ledger event");

    // The rewriting push itself is red against either base.
    const atRewrite = runHistoryGates(work, { name: "push", pushBefore: promoted });
    assert.ok(atRewrite.length > 0 && atRewrite.every((run) => run.status === 1), "the rewriting push must fail every history gate");

    writeFileSync(path.join(work, "public", "notes.txt"), "unrelated\n");
    commit("Y: an unrelated change");
    const atNext = runHistoryGates(work, { name: "push", pushBefore: rewrite });

    // Against the previous tip the rewrite is compared with itself.
    const againstPreviousTip = atNext.filter((run) => run.baseline === rewrite);
    assert.equal(againstPreviousTip.length, 2);
    assert.ok(againstPreviousTip.every((run) => run.status === 0), "the previous tip alone cannot see the rewrite");

    // Against the last promoted state both gates refuse it.
    const againstProduction = atNext.filter((run) => run.baseline === promoted);
    assert.deepEqual(againstProduction.map((run) => run.step.gate).sort(), ["ledger", "log"]);
    const ledger = againstProduction.find((run) => run.step.gate === "ledger");
    const log = againstProduction.find((run) => run.step.gate === "log");
    assert.ok(ledger && log);
    assert.equal(ledger.status, 1, ledger.output);
    assert.match(ledger.output, /Corrections ledger entries\[0\] changed/);
    assert.equal(log.status, 1, log.output);
    assert.match(log.output, /Transparency log entries\[0\] changed/);
  } finally {
    removeFixtureTree(parent);
  }
});

test("honest appends pass every history gate against both bases", () => {
  const { parent, work, promoted, commit } = fixture();
  try {
    writeFileSync(path.join(work, LOG_PATH), logWire(additions(4)));
    const first = commit("append one publication");
    writeFileSync(
      path.join(work, LEDGER_PATH),
      ledgerWire(["The reviewed evidence remains active.", "A later clarification of the same report."])
    );
    commit("append one ledger event");

    const runs = runHistoryGates(work, { name: "push", pushBefore: first });
    assert.deepEqual(
      runs.map((run) => `${run.step.gate} against ${run.baseline === promoted ? "production" : "the previous tip"}`).sort(),
      ["ledger against production", "ledger against the previous tip", "log against production", "log against the previous tip"]
    );
    for (const run of runs) assert.equal(run.status, 0, `${run.step.name}: ${run.output}`);
  } finally {
    removeFixtureTree(parent);
  }
});

test("a pull request is measured against its base alone, and a dispatch against production", () => {
  const { parent, work, promoted, commit } = fixture();
  try {
    writeFileSync(path.join(work, LOG_PATH), logWire(additions(4)));
    const tip = commit("append one publication");

    const pullRequest = resolveBaselines(work, { name: "pull_request", pullRequestBase: promoted });
    assert.equal(pullRequest.status, 0, pullRequest.stderr);
    assert.deepEqual([...pullRequest.outputs], [["baseline", promoted], ["production_baseline", ""]]);
    const pullRequestRuns = runHistoryGates(work, { name: "pull_request", pullRequestBase: promoted });
    assert.deepEqual(pullRequestRuns.map((run) => [run.step.gate, run.step.output, run.status]), [
      ["ledger", "baseline", 0],
      ["log", "baseline", 0]
    ]);

    const dispatch = resolveBaselines(work, { name: "workflow_dispatch" });
    assert.equal(dispatch.status, 0, dispatch.stderr);
    assert.deepEqual([...dispatch.outputs], [["baseline", promoted], ["production_baseline", promoted]]);

    // A first push to a new ref reports the all-zero SHA, which is no base.
    const firstPush = resolveBaselines(work, { name: "push", pushBefore: "0".repeat(40) });
    assert.deepEqual([...firstPush.outputs], [["baseline", promoted], ["production_baseline", promoted]]);

    const push = resolveBaselines(work, { name: "push", pushBefore: tip });
    assert.deepEqual([...push.outputs], [["baseline", tip], ["production_baseline", promoted]]);
  } finally {
    removeFixtureTree(parent);
  }
});

test("a run that is not a pull request fails when production cannot be read", () => {
  const { parent, work, promoted } = fixture({ production: false });
  try {
    for (const event of [{ name: "push", pushBefore: promoted }, { name: "workflow_dispatch" }]) {
      const resolved = resolveBaselines(work, event);
      assert.notEqual(resolved.status, 0, `${event.name} must not go on without production`);
      assert.equal(resolved.outputs.size, 0, "no baseline may be written when production is unresolved");
    }
    // A pull request never asked for it.
    assert.equal(resolveBaselines(work, { name: "pull_request", pullRequestBase: promoted }).status, 0);
  } finally {
    removeFixtureTree(parent);
  }
});

test("a run of a commit behind production is refused, and is not measured against the previous tip alone", () => {
  // A run of an older commit, started again after a later one was promoted.
  // Production is its descendant, so there is nothing to measure it against.
  // The previous tip may not stand in: the release workflow tags any commit
  // reachable from production that has a successful CI run, so that pass would
  // hand a commit that sat between a rewrite and its repair a run to release.
  const { parent, work, promoted, earlier, newest, standAt } = fixtureWithLaterPromotions();
  try {
    standAt(earlier);
    for (const event of [{ name: "push", pushBefore: promoted }, { name: "workflow_dispatch" }]) {
      const resolved = resolveBaselines(work, event);
      assert.notEqual(resolved.status, 0, `${event.name}: a run behind production must not resolve a baseline`);
      assert.match(resolved.stderr, new RegExp(`HEAD is behind production ${newest}`), event.name);
      assert.match(resolved.stderr, /a pass against the previous tip alone is refused/);
      assert.match(resolved.stderr, /release gate takes a successful run of any commit reachable from production/);
      assert.equal(resolved.outputs.size, 0, "a refused run must write no baseline");
    }
    // A pull request never reads production, wherever its head sits.
    const pullRequest = resolveBaselines(work, { name: "pull_request", pullRequestBase: promoted });
    assert.deepEqual([...pullRequest.outputs], [["baseline", promoted], ["production_baseline", ""]]);
  } finally {
    removeFixtureTree(parent);
  }
});

test("a commit between a rewrite and its repair cannot earn a successful run once the repair is promoted", () => {
  // The case the refusal above exists for. A rewrite lands and fails. A later
  // push compares clean against that tip and fails only against production.
  // The files are then restored and a push after that is promoted. Run again
  // now, the commit in between is behind production, and its previous tip is
  // the one base that would pass it.
  const { parent, work, promoted } = fixture({ production: false });
  const remote = path.join(parent, "remote");
  const push = (message: string) => {
    runFixtureGit(remote, ["add", "public"]);
    runFixtureGit(remote, ["commit", "-qm", message]);
    return runFixtureGit(remote, ["rev-parse", "HEAD"]).trim();
  };
  const gates = (base: string) =>
    [[LEDGER_CLI, base], [LOG_CLI, "--verify-history", base]].map(
      (args) => spawnSyncBounded(process.execPath, args, { cwd: work, encoding: "utf8", env: gitFixtureEnv() }).status
    );
  try {
    rewritePublishedHistory(remote);
    const rewrite = push("rewrite the log and an earlier ledger event");
    writeFileSync(path.join(remote, "public", "notes.txt"), "unrelated\n");
    const between = push("an unrelated change on top of the rewrite");
    writeFileSync(path.join(remote, LOG_PATH), logWire(additions(3)));
    writeFileSync(path.join(remote, LEDGER_PATH), ledgerWire(["The reviewed evidence remains active."]));
    const repair = push("restore the published log and ledger");
    writeFileSync(path.join(remote, "public", "notes.txt"), "unrelated, again\n");
    const afterRepair = push("the push that is promoted");
    runFixtureGit(remote, ["branch", "production"]);
    runFixtureGit(work, ["fetch", "-q", "origin", "main"]);

    // The promoted push is sound against both of its bases.
    runFixtureGit(work, ["checkout", "-q", "--detach", afterRepair]);
    assert.deepEqual([gates(repair), gates(promoted)], [[0, 0], [0, 0]]);

    runFixtureGit(work, ["checkout", "-q", "--detach", between]);
    assert.deepEqual(gates(rewrite), [0, 0], "against its previous tip the rewrite is compared with itself");
    assert.deepEqual(gates(promoted), [1, 1], "against the state promoted before it, both gates refuse it");
    const resolved = resolveBaselines(work, { name: "push", pushBefore: rewrite });
    assert.notEqual(resolved.status, 0, "the previous tip must not stand in for production");
    assert.match(resolved.stderr, new RegExp(`HEAD is behind production ${afterRepair}`));
    assert.equal(resolved.outputs.size, 0);
  } finally {
    removeFixtureTree(parent);
  }
});

test("a run of the promoted commit itself is measured against production and passes", () => {
  const { parent, work, earlier, newest, standAt } = fixtureWithLaterPromotions();
  try {
    standAt(newest);
    const push = { name: "push", pushBefore: earlier };
    assert.deepEqual([...resolveBaselines(work, push).outputs], [["baseline", earlier], ["production_baseline", newest]]);
    const runs = runHistoryGates(work, push);
    assert.equal(runs.length, 4);
    for (const run of runs) assert.equal(run.status, 0, `${run.step.name}: ${run.output}`);

    const dispatch = resolveBaselines(work, { name: "workflow_dispatch" });
    assert.deepEqual([...dispatch.outputs], [["baseline", newest], ["production_baseline", newest]]);
  } finally {
    removeFixtureTree(parent);
  }
});

test("a run of a commit that has diverged from production is refused", () => {
  // Neither holds the other: production moved to commits this history never
  // had. That is not an old run and not a new push, and nothing is a base.
  const { parent, work, promoted, newest, standAt, commit } = fixtureWithLaterPromotions();
  try {
    standAt(promoted);
    writeFileSync(path.join(work, "public", "notes.txt"), "a push production never saw\n");
    commit("a push on a history production left");
    for (const event of [{ name: "push", pushBefore: promoted }, { name: "workflow_dispatch" }]) {
      const resolved = resolveBaselines(work, event);
      assert.notEqual(resolved.status, 0, event.name);
      assert.match(resolved.stderr, new RegExp(`Baseline ${newest} \\(the production branch\\) is not an ancestor of HEAD, and HEAD is not an ancestor of it`));
      assert.match(resolved.stderr, /main and production have diverged/);
      assert.doesNotMatch(resolved.stderr, /HEAD is behind production/);
      assert.equal(resolved.outputs.size, 0, "a refused run must write no baseline");
    }
  } finally {
    removeFixtureTree(parent);
  }
});

test("the baseline script refuses a base that is malformed, unknown, or not an ancestor, and writes nothing", () => {
  const { parent, work, promoted, commit } = fixture();
  try {
    writeFileSync(path.join(work, "public", "notes.txt"), "main\n");
    const tip = commit("a push");
    // A commit production never led to: a sibling of the promoted state.
    runFixtureGit(work, ["checkout", "-q", "--orphan", "elsewhere"]);
    const unrelated = commit("unrelated history");
    runFixtureGit(work, ["checkout", "-q", "main"]);

    const run = (args: readonly string[]) =>
      spawnSyncBounded(process.execPath, [BASELINE_SCRIPT, ...args], { cwd: work, encoding: "utf8", env: gitFixtureEnv() });
    const refusals: [string, readonly string[], RegExp][] = [
      ["a relative ref as the push base", ["--event", "push", "--push-before", "HEAD^", "--production", promoted], /Refusing to verify against a malformed baseline/],
      ["an abbreviated production commit", ["--event", "push", "--push-before", tip, "--production", promoted.slice(0, 12)], /Refusing to verify against a malformed baseline/],
      ["no production on a push", ["--event", "push", "--push-before", tip, "--production", ""], /malformed baseline: the production branch is not set/],
      ["no production on a dispatch", ["--event", "workflow_dispatch"], /malformed baseline: the production branch is not set/],
      ["a commit this checkout does not hold", ["--event", "push", "--push-before", "1".repeat(40), "--production", promoted], /is not a commit in this checkout/],
      ["a push base HEAD does not descend from", ["--event", "push", "--push-before", unrelated, "--production", promoted], /is not an ancestor of HEAD/],
      ["a production commit with no history in common", ["--event", "push", "--push-before", tip, "--production", unrelated], /main and production have diverged/],
      ["a pull request with no base", ["--event", "pull_request", "--production", promoted], /malformed baseline: the pull request base is not set/],
      ["no event", ["--production", promoted], /The event name is required/],
      ["an unknown flag", ["--event", "push", "--baseline", promoted], /Usage: resolve-history-baselines\.mjs/],
      ["a flag given twice", ["--event", "push", "--event", "pull_request"], /Usage: resolve-history-baselines\.mjs/]
    ];
    for (const [what, args, message] of refusals) {
      const result = run(args);
      assert.equal(result.status, 1, `${what}: ${result.stdout}${result.stderr}`);
      assert.match(result.stderr, message, what);
      assert.equal(result.stdout, "", `${what}: a refused run must write no baseline`);
    }

    const accepted = run(["--event", "push", "--push-before", tip, "--pull-request-base", "", "--production", promoted]);
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.equal(accepted.stdout, `baseline=${tip}\nproduction_baseline=${promoted}\n`);
  } finally {
    removeFixtureTree(parent);
  }
});

test("the log gate refuses a non-empty log that the base does not hold", () => {
  // A base without the log gives the gate no prefix to hold the entries to.
  // If a non-empty log passed there, a revision that lost the file and a
  // later one that brought back a shorter log would read as the log's
  // beginning, with every dropped entry unseen.
  const repo = mkdtempSync(path.join(tmpdir(), "sbl-history-gates-base-"));
  try {
    mkdirSync(path.join(repo, "public"));
    writeFileSync(path.join(repo, "public", "notes.txt"), "no log yet\n");
    initFixtureRepo(repo);
    const commit = (message: string) => {
      runFixtureGit(repo, ["add", "public"]);
      runFixtureGit(repo, ["commit", "-qm", message]);
      return runFixtureGit(repo, ["rev-parse", "HEAD"]).trim();
    };
    const withoutLog = commit("a base that does not hold the log");
    const gate = () =>
      spawnSyncBounded(process.execPath, [LOG_CLI, "--verify-history", withoutLog], { cwd: repo, encoding: "utf8", env: gitFixtureEnv() });

    writeFileSync(path.join(repo, LOG_PATH), logWire(additions(2)));
    commit("a log with entries, where the base has none");
    const nonEmpty = gate();
    assert.equal(nonEmpty.status, 1, nonEmpty.stdout);
    assert.match(nonEmpty.stderr, /is absent at Git base [0-9a-f]{40}; refusing to verify a non-empty transparency log without its base/);
    assert.equal(nonEmpty.stdout, "", "a refused log must not be reported as verified or introduced");

    // An empty log may begin where none existed: there is nothing to rewrite.
    writeFileSync(path.join(repo, LOG_PATH), logWire([]));
    commit("an empty log");
    const empty = gate();
    assert.equal(empty.status, 0, empty.stderr);
    assert.match(empty.stdout, /Transparency log initialized empty; .*transparency-log\.json is absent at/);
  } finally {
    removeFixtureTree(repo);
  }
});

test("a git that fails while reading the base is an error to both gates, never an absent file", () => {
  const { parent, work, promoted, commit } = fixture();
  try {
    writeFileSync(path.join(work, LOG_PATH), logWire(additions(3, "c")));
    writeFileSync(path.join(work, LEDGER_PATH), ledgerWire(["Reworded after publication."]));
    commit("rewrite the log and the ledger");

    // A stand-in git that answers every question but is killed while printing
    // a blob, the way a runner out of memory kills a child.
    const realGit = (process.env.PATH ?? "")
      .split(path.delimiter)
      .map((dir) => path.join(dir, "git"))
      .find((candidate) => existsSync(candidate));
    assert.ok(realGit, "git must be on PATH for this test");
    const bin = path.join(parent, "bin");
    mkdirSync(bin);
    writeFileSync(path.join(bin, "git"), `#!/bin/sh\nif [ "$1" = "show" ]; then kill -KILL $$; fi\nexec "${realGit}" "$@"\n`);
    chmodSync(path.join(bin, "git"), 0o755);
    const env = gitFixtureEnv({ PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` });

    for (const args of [[LOG_CLI, "--verify-history", promoted], [LEDGER_CLI, promoted]]) {
      const result = spawnSyncBounded(process.execPath, args, { cwd: work, encoding: "utf8", env });
      assert.equal(result.status, 1, `${path.basename(args[0])}: ${result.stdout}`);
      assert.match(result.stderr, /git show [0-9a-f]{40}:public\/\S+ did not exit on its own \(signal SIGKILL\)/);
      assert.doesNotMatch(result.stdout + result.stderr, /absent at|introduced at this revision|initialized/);
    }
  } finally {
    removeFixtureTree(parent);
  }
});
