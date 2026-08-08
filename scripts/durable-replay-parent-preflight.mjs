#!/usr/bin/env node

// Refuse to spend a replay capture on a commit that cannot carry the durable
// transition. See scripts/durable-replay-parent-lib.mjs for why.
//
//   node scripts/durable-replay-parent-preflight.mjs [<commit-ish>]
//
// Defaults to HEAD. Exits 0 and prints the transition plan when the commit
// qualifies; exits 1 with the reasons when it does not.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  DURABLE_CONFIG_PATH,
  durableReplayParentIssues,
  durableTransitionPlan
} from "./durable-replay-parent-lib.mjs";

const [requested, ...extra] = process.argv.slice(2);
if (extra.length > 0) {
  console.error("Usage: node scripts/durable-replay-parent-preflight.mjs [<commit-ish>]");
  process.exit(1);
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
}

function gitOrNull(args) {
  try {
    return git(args);
  } catch {
    return null;
  }
}

let parentSha;
try {
  parentSha = git(["rev-parse", "--verify", `${requested ?? "HEAD"}^{commit}`]).trim();
} catch {
  console.error(`FAIL ${requested ?? "HEAD"} does not resolve to a commit in this repository.`);
  process.exit(1);
}

// The default branch is where the ordered pre-candidate history has to live.
// Prefer the remote's view: a stale local main would pass a parent the real
// branch has already built past, which is the exact failure this guards.
const defaultBranchRef =
  gitOrNull(["rev-parse", "--verify", "--quiet", "origin/main^{commit}"]) !== null
    ? "origin/main"
    : "main";

const onDefaultBranch =
  gitOrNull(["merge-base", "--is-ancestor", parentSha, `${defaultBranchRef}^{commit}`]) !== null ||
  gitOrNull(["rev-parse", "--verify", `${defaultBranchRef}^{commit}`])?.trim() === parentSha;

// A direct child is any commit on the default branch whose FIRST parent is our
// commit. First-parent matters: the binding uses `<toCommit>^`, which is the
// first parent, so only that slot is contested.
const childShas = [];
const descendants = gitOrNull(["rev-list", "--first-parent", `${parentSha}..${defaultBranchRef}`]);
if (descendants) {
  for (const sha of descendants.trim().split("\n").filter(Boolean)) {
    const firstParent = gitOrNull(["rev-parse", "--verify", `${sha}^`])?.trim();
    if (firstParent === parentSha) childShas.push(sha);
  }
}

const configAtParent = gitOrNull(["show", `${parentSha}:${DURABLE_CONFIG_PATH}`]) ?? "";

const issues = durableReplayParentIssues({
  parentSha,
  childShas,
  onDefaultBranch,
  configAtParent
});

if (issues.length > 0) {
  for (const issue of issues) console.error(`FAIL ${issue}`);
  console.error(
    "\nRefusing: a replay capture against this commit would produce receipts the release " +
      "transition can never use. Freeze a parent with a free child slot first."
  );
  process.exit(1);
}

const plan = durableTransitionPlan(parentSha, configAtParent);
const resultingSha256 = createHash("sha256").update(plan.resultingConfigSha256Input).digest("hex");

console.log(`PASS ${parentSha} can carry the durable transition.`);
console.log("");
console.log("  Capture replay evidence against this commit, then create the flip commit F:");
console.log(`    parent            ${plan.parent}`);
console.log(`    modifies ONLY     ${plan.changes.join(", ")}`);
console.log(`    substitution      ${plan.substitution.from}  ->  ${plan.substitution.to}`);
console.log(`    resulting config  sha256 ${resultingSha256}`);
console.log("");
console.log("  Receipts must land at:");
for (const mode of ["lease-expiry", "lost-resolve"]) {
  console.log(`    research/ops-receipts/durable-replay/${parentSha}-${mode}.json`);
}
console.log("");
console.log("  Nothing else may merge between this commit and F.");
