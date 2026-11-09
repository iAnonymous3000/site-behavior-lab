#!/usr/bin/env node
// Resolves the revisions CI's two append-only history gates compare against
// (corrections:verify-history and transparency:verify-history), from the event
// that started the run.
//
// A history gate answers "was this file only appended to since the base", so
// the base decides what a pass means. Two rules follow.
//
// 1. A base is an exact commit this checkout descends from, never a relative
//    ref. A HEAD^ fallback compared one commit back, so two commits could
//    rewrite a ledger and still pass.
//
// 2. On any run that is not a pull request, the gates also compare against
//    the production branch. Production only ever fast-forwards to a commit
//    whose CI passed every gate, so it is the last state known good. The
//    previous tip of main is not: main accepts a push whose run then fails,
//    and the next push would take that failed tip as its base and compare the
//    rewrite with itself. A run that cannot name the production commit fails
//    here instead of leaving that comparison out.
//
// 3. A run whose commit is behind production fails here too. That is a run
//    of an older commit started again after a later one was promoted. It
//    cannot be measured against production, which is its descendant, and it
//    is not given the previous tip in production's place: the release
//    workflow tags any commit reachable from production that has a successful
//    CI run, so a pass against the previous tip alone would let a commit that
//    sat between a rewrite and its repair earn that run after the repair was
//    promoted. A HEAD that neither holds production nor is held by it means
//    main and production have diverged, and fails as well.
//
// A pull request keeps its one base, the commit it would merge into.
//
// Usage:
//   node scripts/resolve-history-baselines.mjs --event <event name> \
//     [--push-before <sha>] [--pull-request-base <sha>] [--production <sha>]
//
// Prints `baseline=<sha>` and `production_baseline=<sha>` on stdout, in the
// form $GITHUB_OUTPUT takes, and everything else on stderr, so the workflow
// appends stdout to $GITHUB_OUTPUT. `production_baseline` is empty on a pull
// request, where the workflow does not run the production comparison.
//
// Reads git in the current directory and nothing else, so a test can run it
// against a throwaway repository.

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ZERO_SHA = "0".repeat(40);
const FLAGS = new Map([
  ["--event", "event"],
  ["--push-before", "pushBefore"],
  ["--pull-request-base", "pullRequestBase"],
  ["--production", "production"]
]);

/**
 * The two baselines for one run. Throws with the reason when a baseline the
 * run needs cannot be trusted; nothing is ever defaulted or skipped.
 */
export function resolveHistoryBaselines(input, root = process.cwd()) {
  const event = input.event ?? "";
  if (event === "") throw new Error("The event name is required.");

  if (event === "pull_request") {
    return {
      baseline: trustedBaseline(input.pullRequestBase, "pull request base", root),
      productionBaseline: ""
    };
  }

  const production = productionBaseline(input.production, root);
  // A first push to a new ref reports the all-zero SHA, and a dispatch reports
  // nothing at all. Neither is a baseline, so the last promoted state stands
  // in for the first comparison too.
  const pushBefore = event === "push" ? (input.pushBefore ?? "") : "";
  const baseline =
    pushBefore === "" || pushBefore === ZERO_SHA ? production : trustedBaseline(pushBefore, "previous tip of the pushed ref", root);
  return { baseline, productionBaseline: production };
}

function trustedBaseline(candidate, what, root) {
  const value = commitInCheckout(candidate, what, root);
  // An unrelated baseline would compare against history this revision never
  // descended from, which proves nothing about appends.
  if (!isAncestor(root, value, "HEAD")) throw new Error(`Baseline ${value} (the ${what}) is not an ancestor of HEAD.`);
  return value;
}

/**
 * The production commit as a baseline, which it is only for a run at or
 * after it. Rule 3 above says why the two other positions fail and are not
 * given another base.
 */
function productionBaseline(candidate, root) {
  const value = commitInCheckout(candidate, "production branch", root);
  if (isAncestor(root, value, "HEAD")) return value;
  if (isAncestor(root, "HEAD", value)) {
    throw new Error(
      `HEAD is behind production ${value}, so this run is of a commit older than the last promoted state. ` +
        "It cannot be measured against production, and a pass against the previous tip alone is refused: " +
        "the release gate takes a successful run of any commit reachable from production. " +
        "Run CI on a commit at or after production."
    );
  }
  throw new Error(
    `Baseline ${value} (the production branch) is not an ancestor of HEAD, and HEAD is not an ancestor of it: ` +
      "main and production have diverged."
  );
}

function commitInCheckout(candidate, what, root) {
  const value = candidate ?? "";
  if (!/^[0-9a-f]{40}$/.test(value)) {
    throw new Error(`Refusing to verify against a malformed baseline: the ${what} is ${value === "" ? "not set" : `"${value}"`}.`);
  }
  if (git(root, ["cat-file", "-e", `${value}^{commit}`]) !== 0) {
    throw new Error(`Baseline ${value} (the ${what}) is not a commit in this checkout.`);
  }
  return value;
}

/** Whether `ancestor` is `descendant` or one of its ancestors. Any answer but yes or no is an error. */
function isAncestor(root, ancestor, descendant) {
  const status = git(root, ["merge-base", "--is-ancestor", ancestor, descendant]);
  if (status !== 0 && status !== 1) throw new Error(`${ancestor} could not be compared with ${descendant}.`);
  return status === 0;
}

/** The exit status of one git command. A git that did not exit on its own is an error, never a status. */
function git(root, args) {
  const result = spawnSync("git", args, { cwd: root, stdio: "ignore" });
  if (result.error) throw result.error;
  if (result.status === null) throw new Error(`git ${args[0]} did not exit on its own (signal ${result.signal ?? "unknown"}).`);
  return result.status;
}

function parseArgs(argv) {
  const input = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = FLAGS.get(argv[index]);
    // An empty value is a value: the workflow passes every flag, and the event
    // decides which of them must hold a commit.
    if (key === undefined || argv[index + 1] === undefined || key in input) {
      throw new Error(
        "Usage: resolve-history-baselines.mjs --event <name> [--push-before <sha>] [--pull-request-base <sha>] [--production <sha>]"
      );
    }
    input[key] = argv[index + 1];
  }
  return input;
}

function main() {
  let baselines;
  try {
    baselines = resolveHistoryBaselines(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(`::error title=History baseline unresolved::${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  console.error(
    `History baselines resolved: ${baselines.baseline}` +
      (baselines.productionBaseline === "" ? " (pull request base)." : `, and production ${baselines.productionBaseline}.`)
  );
  console.log(`baseline=${baselines.baseline}`);
  console.log(`production_baseline=${baselines.productionBaseline}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
