#!/usr/bin/env node
// Writes research/v1-release-binding.json, the file a carrier commit S adds
// for a candidate C under the investigative-v1 contract.
//
//   npm run release:v1-binding -- --candidate <C, 40 hex> --receipt-sha256 <64 hex>
//   npm run release:v1-binding -- --candidate <C, 40 hex> --receipt-sha256 <64 hex> --check
//
// Run it at the repository root, with the six fixed evidence files and the
// governance receipt in place and nothing else changed. It reads C's tree
// from Git, takes the six paths and their categories from the contract
// (scripts/v1-release-contract.mjs), reads each file's bytes from the working
// tree, and writes the binding as canonical JSON. --check writes nothing: it
// refuses unless the binding that exists is byte for byte what would be
// written, before or after the carrier is committed.
//
// It writes that one file and nothing else. It never stages, commits or
// pushes, and it makes no network call: the only process it starts is git,
// through the closed list of reading subcommands below.
//
// A refusal here is early notice, not authority. verifyV1ReleaseBinding is
// what accepts a carrier, on the committed history, with the two content
// verifiers and the three attestations this producer never runs. Each check
// here restates a rule of that function so that a carrier it would refuse is
// not written in the first place, and lib/v1-release-binding.test.ts holds
// the two together on fixture histories.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  V1_BINDING_KIND,
  V1_BINDING_PATH,
  V1_FIXED_EVIDENCE,
  V1_PROFILE,
  V1_REPOSITORY,
  v1AllowedEvidence,
  v1EvidenceBytes,
  v1ProfileProblems
} from "./v1-release-contract.mjs";

export const V1_BINDING_USAGE = "Usage: node scripts/v1-release-binding.mjs --candidate <full commit SHA> --receipt-sha256 <sha256 of the governance receipt> [--check]";
const GOVERNANCE_RECEIPT_CATEGORY = "release-tag-governance-receipt";
const governanceReceiptPath = (digest) => `research/ops-receipts/release-tag-governance/${digest}.json`;
const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

/** A refusal the producer states by itself. Anything else thrown is a fault. */
export class V1BindingRefusal extends Error {}
const refuse = (message) => { throw new V1BindingRefusal(message); };

// Every git subcommand this file runs. Each one only reads.
const READING_SUBCOMMANDS = new Set(["cat-file", "diff-tree", "ls-tree", "merge-base", "rev-list", "rev-parse", "status"]);
function git(rootDir, args) {
  if (!READING_SUBCOMMANDS.has(args[0])) throw new Error(`the binding producer does not run git ${args[0]}`);
  return execFileSync("git", ["--no-optional-locks", ...args], { cwd: rootDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
}
function gitSucceeds(rootDir, args) {
  try { git(rootDir, args); return true; } catch { return false; }
}
function present(rootDir, relative) {
  try { lstatSync(path.join(rootDir, relative)); return true; } catch { return false; }
}

/**
 * The binding for candidate C and one governance receipt, as the bytes a
 * carrier must add. Reads only. `existing` says the binding file is already
 * there and is being checked, which admits it as a carrier file: untracked,
 * staged, or added by HEAD itself.
 */
export function v1ReleaseBindingBytes(rootDir, { candidateCommit, receiptSha256, existing = false }) {
  if (typeof candidateCommit !== "string" || !SHA.test(candidateCommit)) refuse("the candidate must be a full commit SHA: 40 lowercase hexadecimal characters");
  if (typeof receiptSha256 !== "string" || !DIGEST.test(receiptSha256)) refuse("the receipt must be named by its sha256: 64 lowercase hexadecimal characters");
  if (!gitSucceeds(rootDir, ["rev-parse", "--show-toplevel"]) || realpathSync(git(rootDir, ["rev-parse", "--show-toplevel"]).trimEnd()) !== realpathSync(rootDir)) {
    refuse("run the binding producer at the root of the repository checkout");
  }
  if (!existing && present(rootDir, V1_BINDING_PATH)) refuse(`${V1_BINDING_PATH} already exists; the producer never overwrites a binding (use --check to compare it)`);
  if (existing && !present(rootDir, V1_BINDING_PATH)) refuse(`${V1_BINDING_PATH} does not exist, so there is no binding to check`);

  let manifest;
  try { manifest = JSON.parse(readFileSync(path.join(rootDir, "RELEASE_READINESS.json"), "utf8")); } catch { refuse("RELEASE_READINESS.json cannot be read"); }
  if (manifest?.releaseProfile !== V1_PROFILE || v1ProfileProblems(manifest).length > 0) refuse(`RELEASE_READINESS.json is not the complete ${V1_PROFILE} contract, which is the only one this binding serves`);

  if (!gitSucceeds(rootDir, ["cat-file", "-e", `${candidateCommit}^{commit}`]) || git(rootDir, ["rev-parse", `${candidateCommit}^{commit}`]).trim() !== candidateCommit) {
    refuse(`candidate ${candidateCommit} is not a commit in this repository`);
  }
  const head = git(rootDir, ["rev-parse", "HEAD"]).trim();
  if (!gitSucceeds(rootDir, ["merge-base", "--is-ancestor", candidateCommit, head])) refuse(`candidate ${candidateCommit} is not an ancestor of HEAD (${head})`);

  const receipt = governanceReceiptPath(receiptSha256);
  const carrierPaths = [...Object.keys(V1_FIXED_EVIDENCE), receipt];
  // A carrier may only add. A file the candidate holds would be modified by
  // the carrier, which the contract refuses, so a candidate that follows an
  // earlier carrier must first delete that carrier's files and its binding.
  // This is also what refuses the candidate being the carrier itself.
  const held = git(rootDir, ["ls-tree", "-r", "--name-only", "-z", candidateCommit, "--", ...carrierPaths, V1_BINDING_PATH]).split("\0").filter(Boolean);
  if (held.length > 0) refuse(`candidate ${candidateCommit} already holds ${held.join(", ")}; a carrier may only add its files, so the candidate must come before them`);

  // Every commit after the candidate, as the contract walks them.
  const range = `${candidateCommit}..${head}`;
  if (git(rootDir, ["rev-list", "--merges", range]).trim() !== "") refuse("the history from the candidate to HEAD holds a merge; a carrier history is linear");
  const committed = new Set();
  let bindingCommitted = false;
  for (const commit of git(rootDir, ["rev-list", "--reverse", range]).split("\n").filter(Boolean)) {
    const fields = git(rootDir, ["diff-tree", "--no-commit-id", "--name-status", "--no-renames", "-r", "-z", commit]).split("\0").filter(Boolean);
    for (let index = 0; index < fields.length; index += 2) {
      const [status, relative] = [fields[index], fields[index + 1]];
      // The binding in the final commit is the carrier's. Its status needs no
      // test: a path the candidate does not hold, first touched here, is added.
      if (relative === V1_BINDING_PATH && commit === head) { bindingCommitted = true; continue; }
      // A file added twice would need a deletion between, which is refused as it is met.
      if (!carrierPaths.includes(relative) || status !== "A") {
        refuse(`commit ${commit} changes ${relative} (${status}) after the candidate; the only tracked change a carrier history may hold is each of the carrier's files added once`);
      }
      committed.add(relative);
    }
  }

  for (const relative of carrierPaths) {
    if (!present(rootDir, relative)) refuse(relative === receipt ? `missing governance receipt ${relative}` : `missing evidence file ${relative}`);
  }
  // The working tree apart from what a carrier adds. An addition is a file
  // git does not track yet or a staged addition whose staged bytes are the
  // working bytes; anything else would not be committed as what is read here.
  const pending = new Set();
  const entries = git(rootDir, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]).split("\0").filter(Boolean);
  for (const entry of entries) {
    const [state, relative] = [entry.slice(0, 2), entry.slice(3)];
    // The binding is on disk only when it is being checked: a write was refused above.
    const addable = carrierPaths.includes(relative) || relative === V1_BINDING_PATH;
    if (!addable || (state !== "??" && state !== "A ")) refuse(`the working tree holds a change that a carrier does not add: "${state}" ${relative}`);
    pending.add(relative);
  }
  for (const relative of [...carrierPaths, ...(existing ? [V1_BINDING_PATH] : [])]) {
    const tracked = relative === V1_BINDING_PATH ? bindingCommitted : committed.has(relative);
    if (!tracked && !pending.has(relative)) refuse(`${relative} is on disk and git would not commit it (is it ignored?)`);
  }

  const evidence = carrierPaths.map((relative) => {
    const raw = v1EvidenceBytes(rootDir, relative);
    const row = { category: V1_FIXED_EVIDENCE[relative] ?? GOVERNANCE_RECEIPT_CATEGORY, path: relative, change: "added", sha256: sha256(raw) };
    if (!v1AllowedEvidence(row)) refuse(`the contract does not admit ${relative} as ${row.category}`);
    return row;
  });
  if (evidence.at(-1).sha256 !== receiptSha256) refuse(`${receipt} is not named by the sha256 of its bytes, which is ${evidence.at(-1).sha256}`);

  const binding = { schemaVersion: 1, artifactKind: V1_BINDING_KIND, repository: V1_REPOSITORY, targetRelease: manifest.targetRelease,
    candidateCommit, candidateTree: git(rootDir, ["rev-parse", `${candidateCommit}^{tree}`]).trim(), evidence };
  return { binding, bytes: Buffer.from(`${JSON.stringify(binding, null, 2)}\n`), head, committed: bindingCommitted };
}

/** Write the binding, once. Refuses, and writes nothing, on any refusal above. */
export function writeV1ReleaseBinding(rootDir, { candidateCommit, receiptSha256 }) {
  const result = v1ReleaseBindingBytes(rootDir, { candidateCommit, receiptSha256 });
  // wx: fail on a path that exists, a symbolic link included.
  writeFileSync(path.join(rootDir, V1_BINDING_PATH), result.bytes, { flag: "wx" });
  return { ...result, sha256: sha256(result.bytes) };
}

/** Compare the binding that exists with the one that would be written. Writes nothing. */
export function checkV1ReleaseBinding(rootDir, { candidateCommit, receiptSha256 }) {
  const result = v1ReleaseBindingBytes(rootDir, { candidateCommit, receiptSha256, existing: true });
  const found = v1EvidenceBytes(rootDir, V1_BINDING_PATH);
  if (!found.equals(result.bytes)) {
    refuse(`${V1_BINDING_PATH} (sha256 ${sha256(found)}) is not byte for byte what the producer would write (sha256 ${sha256(result.bytes)})`);
  }
  return { ...result, sha256: sha256(result.bytes) };
}

function main(argv) {
  const options = { check: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--check" && !options.check) options.check = true;
    else if (flag === "--candidate" && options.candidateCommit === undefined && index + 1 < argv.length) options.candidateCommit = argv[++index];
    else if (flag === "--receipt-sha256" && options.receiptSha256 === undefined && index + 1 < argv.length) options.receiptSha256 = argv[++index];
    else { console.error(V1_BINDING_USAGE); return 1; }
  }
  if (options.candidateCommit === undefined || options.receiptSha256 === undefined) { console.error(V1_BINDING_USAGE); return 1; }
  try {
    const result = (options.check ? checkV1ReleaseBinding : writeV1ReleaseBinding)(process.cwd(), options);
    console.log(`${options.check ? "Checked" : "Wrote"} ${V1_BINDING_PATH}`);
    console.log(`  sha256     ${result.sha256}`);
    console.log(`  candidate  ${result.binding.candidateCommit} (tree ${result.binding.candidateTree})`);
    for (const row of result.binding.evidence) console.log(`  ${row.sha256}  ${row.path}`);
    if (options.check) console.log(result.committed ? "The binding is committed at HEAD and is what the producer would write." : "The binding is not committed yet and is what the producer would write.");
    else console.log("Nothing was staged or committed. The carrier is one commit that adds the files above and the binding, and nothing else.");
    return 0;
  } catch (error) {
    if (!(error instanceof V1BindingRefusal)) throw error;
    console.error(`Refused: ${error.message}`);
    console.error(options.check ? "Nothing was written." : "No binding was written.");
    return 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) process.exitCode = main(process.argv.slice(2));
