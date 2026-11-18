#!/usr/bin/env node
// The receipt of a Verus run over the trust kernel, and the rule that says
// whether a receipt shows that run passed at a commit.
//
//   check --receipt <file> --commit <sha>
//
// scripts/trust-kernel-verus.mjs writes the receipt with `verify --receipt`,
// only after every step of its run held. The workflow
// .github/workflows/trust-kernel.yml then holds the receipt to its commit
// with `check`, keeps it, and a separate job signs it on the main branch.
//
// The receipt is the run's own statement of what it did. A signature on it
// says a run of that workflow at that commit wrote these bytes, and nothing
// more: it does not show that Verus is right, that the statements are the
// ones a reader wants, or anything of the compiled module.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
export const PINS_PATH = "tools/trust-kernel/pins.json";
export const RECEIPT_KIND = "site-behavior-lab-trust-kernel-verus-receipt";
export const RECEIPT_KEYS = ["schemaVersion", "kind", "source", "runner", "verus", "checkedFiles", "specifications", "results"];
const RESULT_KEYS = [
  "verifiedItems",
  "pinnedItems",
  "errors",
  "rlimitFloor",
  "statementsNamed",
  "guardMutationsRefused",
  "cargoTestsPassed",
  "verusMutationsRefused",
  "treeCleanBefore",
  "treeCleanAfter"
];
const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value, keys) => record(value) && JSON.stringify(Object.keys(value)) === JSON.stringify(keys);
const count = (value) => Number.isSafeInteger(value) && value > 0;

function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
}

/** True when the checkout holds no change and no untracked file git does not ignore. */
export const treeClean = () => git(["status", "--porcelain"]) === "";

/** The commit and tree of this checkout. */
export const checkoutSource = () => ({ commit: git(["rev-parse", "HEAD"]), tree: git(["rev-parse", "HEAD^{tree}"]) });

/**
 * The receipt of a run that passed. `source` is the checkout's commit and
 * tree, `run` carries what the run itself counted, and the files are read
 * again here, so the digests are of the bytes the run was given.
 * `workspace` is the kernel directory the paths are relative to.
 */
export function buildReceipt({ source, workspace, pins, checkedFiles, specifications, run }) {
  const platform = `${process.platform}-${process.arch}`;
  const asset = pins.verus.assets[platform];
  return {
    schemaVersion: 1,
    kind: RECEIPT_KIND,
    source: { commit: source.commit, tree: source.tree },
    runner: { platform, node: process.version },
    verus: { version: pins.verus.version, commit: pins.verus.commit, assetSha256: asset?.sha256 ?? null },
    checkedFiles: checkedFiles.map((file) => ({ path: file, sha256: sha256(readFileSync(path.join(workspace, file))) })),
    specifications: Object.entries(specifications).map(([file, specification]) => ({ path: file, sha256: specification.sha256 })),
    results: {
      verifiedItems: run.verifiedItems,
      pinnedItems: run.pinnedItems,
      errors: run.errors,
      rlimitFloor: run.rlimitFloor,
      statementsNamed: run.statementsNamed,
      guardMutationsRefused: run.guardMutationsRefused,
      cargoTestsPassed: run.cargoTestsPassed,
      verusMutationsRefused: run.verusMutationsRefused,
      treeCleanBefore: run.treeCleanBefore,
      treeCleanAfter: run.treeCleanAfter
    }
  };
}

/** Every way a receipt fails to show that the Verus run passed at a commit; empty when it shows it. */
export function receiptProblems(receipt, { commit, pins }) {
  if (!exactKeys(receipt, RECEIPT_KEYS)) return ["the receipt does not hold exactly its fields, in order"];
  const problems = [];
  if (receipt.schemaVersion !== 1 || receipt.kind !== RECEIPT_KIND) problems.push("the receipt is of another kind or version");
  if (!exactKeys(receipt.source, ["commit", "tree"]) || !SHA.test(receipt.source.commit) || !SHA.test(receipt.source.tree)) {
    problems.push("the receipt names no full commit and tree");
  } else if (receipt.source.commit !== commit) {
    problems.push(`the receipt is of commit ${receipt.source.commit}, not ${commit}`);
  }
  const verus = receipt.verus;
  if (!exactKeys(verus, ["version", "commit", "assetSha256"]) || verus.version !== pins.verus.version || verus.commit !== pins.verus.commit) {
    problems.push("the receipt names a Verus other than the pinned one");
  } else if (verus.assetSha256 !== pins.verus.assets[receipt.runner?.platform]?.sha256) {
    problems.push("the receipt names a Verus archive other than the one pinned for its platform");
  }
  for (const [name, list] of [["checked file", receipt.checkedFiles], ["specification", receipt.specifications]]) {
    if (!Array.isArray(list) || list.length === 0 || list.some((entry) => !exactKeys(entry, ["path", "sha256"]) || typeof entry.path !== "string" || !DIGEST.test(entry.sha256))) {
      problems.push(`the receipt's ${name} list is empty or malformed`);
    }
  }
  const results = receipt.results;
  if (!exactKeys(results, RESULT_KEYS)) return [...problems, "the receipt's results do not hold exactly their fields, in order"];
  if (!count(results.verifiedItems) || results.verifiedItems !== results.pinnedItems) {
    problems.push(`Verus verified ${results.verifiedItems} items, and ${results.pinnedItems} are pinned`);
  }
  if (results.errors !== 0) problems.push(`Verus reported ${results.errors} errors`);
  if (!(typeof results.rlimitFloor === "number" && results.rlimitFloor > 0)) problems.push("the receipt names no resource floor");
  for (const field of ["statementsNamed", "guardMutationsRefused", "cargoTestsPassed", "verusMutationsRefused"]) {
    if (!count(results[field])) problems.push(`${field} is not a count above zero`);
  }
  if (results.treeCleanBefore !== true || results.treeCleanAfter !== true) problems.push("the run did not start on a clean tree, or left it changed");
  return problems;
}

function option(argv, name) {
  const at = argv.indexOf(name);
  if (at === -1 || argv[at + 1] === undefined) throw new Error(`missing ${name} <value>`);
  return argv[at + 1];
}

/** Writes a receipt that the rule accepts for this checkout's commit, and refuses to write any other or to overwrite a file. */
export function writeReceipt(file, receipt, pins) {
  const problems = receiptProblems(receipt, { commit: git(["rev-parse", "HEAD"]), pins });
  if (problems.length > 0) throw new Error(`The Verus receipt would not show the run passed:\n- ${problems.join("\n- ")}`);
  writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
}

function check(argv) {
  const receipt = JSON.parse(readFileSync(path.resolve(option(argv, "--receipt")), "utf8"));
  const pins = JSON.parse(readFileSync(path.join(ROOT, PINS_PATH), "utf8"));
  const problems = receiptProblems(receipt, { commit: option(argv, "--commit"), pins });
  if (problems.length > 0) throw new Error(`The Verus receipt does not show the run passed:\n- ${problems.join("\n- ")}`);
  console.log(`The Verus receipt shows ${receipt.results.verifiedItems} items checked with no error at ${receipt.source.commit}.`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [command, ...rest] = process.argv.slice(2);
  try {
    if (command === "check") check(rest);
    else throw new Error("Usage: trust-kernel-verus-receipt.mjs check --receipt <file> --commit <sha>");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
