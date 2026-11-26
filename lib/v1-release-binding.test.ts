import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { spawnSyncBounded } from "./bounded-spawn";
import { initFixtureRepo, removeFixtureTree, runFixtureGit } from "./git-fixture";
import * as canonical from "./measurement-candidate-binding";

// The producer of research/v1-release-binding.json, held to the contract that
// reads its file. Every history here is a real git repository, and the bytes,
// digests and canonical JSON reads are real.
//
// Stubbed where a carrier is verified: the two content verifiers
// (verifySourceEvidenceManifest and verifyContainerPackageInventory) and the
// attestation verifier that would call `gh attestation verify`. The producer
// runs none of the three, so nothing of the producer is stubbed.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const nativeImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<Any>;
const PRODUCER = path.join(process.cwd(), "scripts/v1-release-binding.mjs");
const contract = () => nativeImport(pathToFileURL(path.join(process.cwd(), "scripts/v1-release-contract.mjs")).href);
const producer = () => nativeImport(pathToFileURL(PRODUCER).href);
const hash = (v: string | Buffer) => createHash("sha256").update(v).digest("hex");
const serialize = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
const manifest = () => JSON.parse(readFileSync(path.join(process.cwd(), "RELEASE_READINESS.json"), "utf8"));
const BINDING = "research/v1-release-binding.json";
const receiptPathOf = (digest: string) => `research/ops-receipts/release-tag-governance/${digest}.json`;

/**
 * A repository with a candidate commit and, in the working tree, everything a
 * carrier adds except the binding: the contract's six fixed files and one
 * governance receipt named by its sha256. Nothing is staged.
 */
function fixture(t: { after: (callback: () => void) => void }, c: Any, atCandidate: Record<string, unknown> = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "sbl-v1-binding-"));
  t.after(() => removeFixtureTree(root));
  const moment = { GIT_AUTHOR_DATE: "2026-09-06T10:07:00Z", GIT_COMMITTER_DATE: "2026-09-06T10:07:00Z" };
  const git = (...args: string[]) => runFixtureGit(root, args, moment).trim();
  const write = (relative: string, value: unknown) => {
    mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    writeFileSync(path.join(root, relative), typeof value === "string" ? value : serialize(value));
  };
  const read = (relative: string) => readFileSync(path.join(root, relative));
  const commit = (message: string, ...paths: string[]) => { git("add", "--", ...(paths.length > 0 ? paths : ["."])); git("commit", "-q", "-m", message); return git("rev-parse", "HEAD"); };
  initFixtureRepo(root, { env: moment });
  write("RELEASE_READINESS.json", manifest());
  write("app.js", "source version one\n");
  for (const [relative, value] of Object.entries(atCandidate)) write(relative, value);
  const candidate = commit("Candidate");
  const candidateTree = git("rev-parse", "HEAD^{tree}");
  const fixed = Object.keys(c.V1_FIXED_EVIDENCE) as string[];
  for (const relative of fixed) write(relative, { fixture: c.V1_FIXED_EVIDENCE[relative] });
  const receiptBytes = serialize({ fixture: "governance", capturedFor: candidate });
  const receiptSha256 = hash(receiptBytes);
  const receipt = receiptPathOf(receiptSha256);
  write(receipt, receiptBytes);
  const carrierFiles = [...fixed, receipt];
  const calls: Any[] = [];
  // The same three seams lib/v1-release-contract.test.ts replaces.
  const instruments = { ...canonical,
    verifySourceEvidenceManifest: (value: unknown, commitOfRecord: string, tree: string, repository: string) => {
      assert.deepEqual(value, { fixture: "container-evidence" }); assert.equal(commitOfRecord, candidate); assert.equal(tree, candidateTree);
      assert.equal(repository, c.V1_REPOSITORY); return { fixture: "container" };
    },
    verifyContainerPackageInventory: (value: unknown, commitOfRecord: string, container: unknown) => {
      assert.deepEqual(value, { fixture: "container-package-inventory" }); assert.equal(commitOfRecord, candidate); assert.deepEqual(container, { fixture: "container" });
    }
  };
  const args = { candidateCommit: candidate, receiptSha256 };
  const status = () => git("status", "--porcelain", "--untracked-files=all");
  return { root, git, write, read, commit, candidate, candidateTree, fixed, receipt, receiptSha256, carrierFiles, instruments, calls, args, status,
    options: { attestationVerifier: (request: Any) => { calls.push(request); } } };
}
type Fixture = ReturnType<typeof fixture>;

/** The producer refuses with exactly this message and leaves the working tree and HEAD as they were. */
function refuses(p: Any, f: Fixture, message: string | RegExp, args: Any = f.args, mode: "write" | "check" = "write") {
  const before = { status: f.status(), head: f.git("rev-parse", "HEAD"), binding: existsSync(path.join(f.root, BINDING)) ? f.read(BINDING) : null };
  assert.throws(() => (mode === "write" ? p.writeV1ReleaseBinding : p.checkV1ReleaseBinding)(f.root, args), (error: Error) => {
    assert.ok(error instanceof p.V1BindingRefusal, `not a stated refusal: ${String(error?.stack ?? error)}`);
    if (typeof message === "string") assert.equal(error.message, message); else assert.match(error.message, message);
    return true;
  });
  assert.equal(f.status(), before.status, "a refusal changes nothing in the working tree");
  assert.equal(f.git("rev-parse", "HEAD"), before.head);
  if (before.binding === null) assert.equal(existsSync(path.join(f.root, BINDING)), false, "a refusal writes no binding");
  else assert.ok(f.read(BINDING).equals(before.binding), "a refusal leaves an existing binding as it was");
}

test("the binding the producer writes, committed as the carrier with its evidence, is accepted by the contract", async (t) => {
  const c = await contract(); const p = await producer(); const f = fixture(t, c);
  const before = f.status();
  const written = p.writeV1ReleaseBinding(f.root, f.args);
  // It wrote the one file, and staged and committed nothing.
  assert.equal(f.git("rev-parse", "HEAD"), f.candidate);
  assert.equal(f.git("diff", "--cached", "--name-only"), "");
  assert.deepEqual(f.status().split("\n").sort(), [...before.split("\n"), `?? ${BINDING}`].sort());
  // The form both readers require: canonical JSON, two-space indent, one final
  // newline (the contract's json(), and the tag job's comparison).
  const raw = f.read(BINDING);
  assert.ok(raw.equals(written.bytes));
  assert.equal(raw.toString("utf8"), serialize(JSON.parse(raw.toString("utf8"))));
  assert.equal(written.sha256, hash(raw));
  const binding = JSON.parse(raw.toString("utf8"));
  assert.deepEqual(Object.keys(binding), ["schemaVersion", "artifactKind", "repository", "targetRelease", "candidateCommit", "candidateTree", "evidence"]);
  assert.deepEqual({ ...binding, evidence: null }, { schemaVersion: 1, artifactKind: c.V1_BINDING_KIND, repository: "iAnonymous3000/site-behavior-lab",
    targetRelease: "1.0.0", candidateCommit: f.candidate, candidateTree: f.candidateTree, evidence: null });
  assert.deepEqual(binding.evidence, f.carrierFiles.map((relative) => ({
    category: c.V1_FIXED_EVIDENCE[relative] ?? "release-tag-governance-receipt", path: relative, change: "added", sha256: hash(f.read(relative))
  })));
  // The tag job's own rule for the governance row: exactly one add-only row
  // whose path and digest are the selected receipt's.
  assert.equal(binding.evidence.filter((row: Any) => row.category === "release-tag-governance-receipt" && row.path === receiptPathOf(f.receiptSha256) &&
    row.change === "added" && row.sha256 === f.receiptSha256).length, 1);

  const carrier = f.commit("Retain release evidence", ...f.carrierFiles, BINDING);
  assert.equal(f.status(), "");
  const accepted = c.verifyV1ReleaseBinding(f.root, f.instruments, f.options);
  assert.equal(accepted.candidateCommit, f.candidate);
  assert.equal(accepted.carrierCommit, carrier);
  assert.equal(accepted.bindingSha256, written.sha256);
  assert.deepEqual(Object.keys(accepted.evidenceIntroducedAt).sort(), [...f.carrierFiles].sort());
  assert.equal(f.calls.length, 3);
});

test("the producer accepts evidence that is staged, or committed after the candidate, and the contract accepts each carrier", async (t) => {
  const c = await contract(); const p = await producer();
  // Staged additions whose staged bytes are the working bytes.
  const staged = fixture(t, c);
  staged.git("add", "--", ...staged.carrierFiles);
  p.writeV1ReleaseBinding(staged.root, staged.args);
  staged.commit("Carrier", BINDING);
  assert.equal(c.verifyV1ReleaseBinding(staged.root, staged.instruments, staged.options).candidateCommit, staged.candidate);

  // The evidence in two commits after the candidate, and the binding alone in the carrier.
  const split = fixture(t, c);
  split.commit("Container evidence", ...split.fixed.slice(0, 4));
  split.commit("Report, bundle and receipt", ...split.fixed.slice(4), split.receipt);
  assert.equal(split.status(), "");
  p.writeV1ReleaseBinding(split.root, split.args);
  const carrier = split.commit("Carrier", BINDING);
  const accepted = c.verifyV1ReleaseBinding(split.root, split.instruments, split.options);
  assert.equal(accepted.carrierCommit, carrier);
  assert.equal(accepted.acceptedProducerCommits.length, 4);
});

test("the producer's paths are the contract's: six fixed files with their categories, and the one receipt", async (t) => {
  const c = await contract(); const p = await producer(); const f = fixture(t, c);
  const fixed = Object.entries(c.V1_FIXED_EVIDENCE) as [string, string][];
  assert.equal(fixed.length, 6);
  const { binding } = p.v1ReleaseBindingBytes(f.root, f.args);
  const rows = binding.evidence as Any[];
  // No path the contract does not name, and none omitted.
  assert.deepEqual(rows.filter((row) => row.category !== "release-tag-governance-receipt").map((row) => [row.path, row.category]), fixed);
  assert.deepEqual(rows.filter((row) => row.category === "release-tag-governance-receipt").map((row) => row.path), [f.receipt]);
  assert.equal(rows.length, 7);
  for (const row of rows) assert.equal(c.v1AllowedEvidence(row), true, row.path);
  // The verifier's four container paths and the two report paths are among them.
  for (const relative of [canonical.MEASUREMENT_CANDIDATE_SOURCE_EVIDENCE_PATH, canonical.MEASUREMENT_CANDIDATE_ATTESTATION_BUNDLE_PATH,
    canonical.MEASUREMENT_CANDIDATE_PACKAGE_INVENTORY_PATH, canonical.MEASUREMENT_CANDIDATE_PACKAGE_ATTESTATION_BUNDLE_PATH,
    c.V1_FORMAL_VERIFICATION_REPORT_PATH, c.V1_FORMAL_VERIFICATION_BUNDLE_PATH]) assert.ok(rows.some((row) => row.path === relative), relative);
  // The producer's source holds no copy of the list: it names no fixed path,
  // no fixed category, and not the binding's own path or kind.
  const source = readFileSync(PRODUCER, "utf8");
  for (const [relative, category] of fixed) {
    assert.equal(source.includes(relative), false, relative);
    assert.equal(source.includes(path.posix.basename(relative)), false, relative);
    assert.equal(source.includes(`"${category}"`), false, category);
  }
  assert.equal(source.includes(`"${c.V1_BINDING_PATH}"`), false);
  assert.equal(source.includes(`"${c.V1_BINDING_KIND}"`), false);
});

test("the producer starts no process but git, through reading subcommands, and imports nothing that reaches a network", () => {
  const source = readFileSync(PRODUCER, "utf8");
  assert.deepEqual([...source.matchAll(/from "([^"]+)"/g)].map((match) => match[1]).sort(),
    ["./v1-release-contract.mjs", "node:child_process", "node:crypto", "node:fs", "node:path", "node:url"]);
  assert.equal(/\bimport\(|\brequire\(|\bfetch\(/.test(source), false);
  // One spawn site, inside the helper that holds the subcommand list.
  assert.deepEqual([...source.matchAll(/\b(?:execFileSync|execSync|spawnSync|spawn|execFile|exec|fork)\(([^,)]*)/g)].map((match) => match[1]), ['"git"']);
  const listed = source.match(/const READING_SUBCOMMANDS = new Set\(\[([^\]]*)\]\)/)?.[1];
  assert.equal(listed, '"cat-file", "diff-tree", "ls-tree", "merge-base", "rev-list", "rev-parse", "status"');
  assert.match(source, /if \(!READING_SUBCOMMANDS\.has\(args\[0\]\)\) throw new Error/);
  // Every call names its subcommand as a literal from that list.
  const used = [...source.matchAll(/\bgit(?:Succeeds)?\(rootDir, \["([a-z-]+)"/g)].map((match) => match[1]);
  assert.ok(used.length >= 10);
  for (const subcommand of used) assert.ok(listed?.includes(`"${subcommand}"`), subcommand);
  assert.equal([...source.matchAll(/\bgit(?:Succeeds)?\(rootDir, (?!args\))/g)].length, used.length, "a git call that does not name its subcommand as a literal");
  // One write site, exclusive.
  assert.deepEqual([...source.matchAll(/\b(?:writeFileSync|appendFileSync|renameSync|rmSync|unlinkSync|mkdirSync|copyFileSync)\(/g)].length, 1);
  assert.match(source, /writeFileSync\(path\.join\(rootDir, V1_BINDING_PATH\), result\.bytes, \{ flag: "wx" \}\)/);
});

test("the producer refuses a candidate that is malformed, unknown, not a commit, or not an ancestor of HEAD", async (t) => {
  const c = await contract(); const p = await producer(); const f = fixture(t, c);
  const FULL = "the candidate must be a full commit SHA: 40 lowercase hexadecimal characters";
  for (const candidateCommit of [f.candidate.slice(0, 12), f.candidate.toUpperCase(), "HEAD", "main", "", `${f.candidate} `, undefined, 7]) {
    refuses(p, f, FULL, { ...f.args, candidateCommit });
  }
  const unknown = "0123456789abcdef0123456789abcdef01234567";
  refuses(p, f, `candidate ${unknown} is not a commit in this repository`, { ...f.args, candidateCommit: unknown });
  refuses(p, f, `candidate ${f.candidateTree} is not a commit in this repository`, { ...f.args, candidateCommit: f.candidateTree });
  // An annotated tag's own object id names a commit and is not one.
  f.git("tag", "-a", "-m", "An annotated tag", "candidate-tag", f.candidate);
  const tagObject = f.git("rev-parse", "candidate-tag");
  assert.equal(f.git("cat-file", "-t", tagObject), "tag");
  refuses(p, f, `candidate ${tagObject} is not a commit in this repository`, { ...f.args, candidateCommit: tagObject });

  // A commit on another line of history: HEAD does not descend from it.
  f.git("checkout", "-q", "-b", "side");
  f.write("side.txt", "a commit main never held\n");
  const side = f.commit("Side commit", "side.txt");
  f.git("checkout", "-q", "main");
  assert.equal(f.git("rev-parse", "HEAD"), f.candidate);
  refuses(p, f, `candidate ${side} is not an ancestor of HEAD (${f.candidate})`, { ...f.args, candidateCommit: side });
  // A descendant of HEAD is not its ancestor either.
  f.git("checkout", "-q", "--detach", `${f.candidate}`);
  refuses(p, f, `candidate ${side} is not an ancestor of HEAD (${f.candidate})`, { ...f.args, candidateCommit: side });
  // The candidate itself, with HEAD at it, is the ordinary state before the carrier.
  assert.equal(p.v1ReleaseBindingBytes(f.root, f.args).head, f.candidate);
});

test("the producer refuses a candidate that already holds a carrier file, and so the carrier named as its own candidate", async (t) => {
  const c = await contract(); const p = await producer();
  const holds = (candidate: string, held: string) => `candidate ${candidate} already holds ${held}; a carrier may only add its files, so the candidate must come before them`;
  // HEAD is the carrier and is named as the candidate: the contract requires C before S.
  const carried = fixture(t, c);
  p.writeV1ReleaseBinding(carried.root, carried.args);
  const carrier = carried.commit("Carrier", ...carried.carrierFiles, BINDING);
  assert.equal(c.verifyV1ReleaseBinding(carried.root, carried.instruments, carried.options).carrierCommit, carrier);
  refuses(p, carried, holds(carrier, [...carried.fixed, carried.receipt, BINDING].sort().join(", ")), { ...carried.args, candidateCommit: carrier }, "check");

  // A second candidate that keeps the first carrier's files, as a final 1.0.0
  // would after an rc without deleting them.
  carried.write("app.js", "source version two\n");
  const second = carried.commit("Second candidate", "app.js");
  refuses(p, carried, holds(second, [...carried.fixed, carried.receipt, BINDING].sort().join(", ")), { ...carried.args, candidateCommit: second }, "check");

  // Each fixed file alone, and the binding alone, held by the candidate.
  const probe = fixture(t, c);
  for (const relative of [...probe.fixed, BINDING]) {
    const f = fixture(t, c, { [relative]: { fixture: "held by the candidate" } });
    if (relative === BINDING) unlinkSync(path.join(f.root, BINDING));
    else f.write(relative, { fixture: c.V1_FIXED_EVIDENCE[relative] });
    refuses(p, f, holds(f.candidate, relative));
  }
});

test("the producer refuses a missing evidence file, a missing receipt, and a receipt not named by its sha256", async (t) => {
  const c = await contract(); const p = await producer();
  const probe = fixture(t, c);
  assert.equal(probe.fixed.length, 6);
  for (const relative of probe.fixed) {
    const f = fixture(t, c); unlinkSync(path.join(f.root, relative));
    refuses(p, f, `missing evidence file ${relative}`);
  }
  const noReceipt = fixture(t, c); unlinkSync(path.join(noReceipt.root, noReceipt.receipt));
  refuses(p, noReceipt, `missing governance receipt ${noReceipt.receipt}`);
  // The digest names no file here, although another receipt is present.
  const other = fixture(t, c); const absent = "b".repeat(64);
  refuses(p, other, `missing governance receipt ${receiptPathOf(absent)}`, { ...other.args, receiptSha256: absent });
  const DIGEST = "the receipt must be named by its sha256: 64 lowercase hexadecimal characters";
  for (const receiptSha256 of [other.receiptSha256.slice(0, 40), other.receiptSha256.toUpperCase(), `${other.receiptSha256}.json`, other.receipt, "", undefined]) {
    refuses(p, other, DIGEST, { ...other.args, receiptSha256 });
  }

  // A receipt whose bytes changed after it was named.
  const renamed = fixture(t, c);
  renamed.write(renamed.receipt, { fixture: "governance", edited: true });
  refuses(p, renamed, `${renamed.receipt} is not named by the sha256 of its bytes, which is ${hash(renamed.read(renamed.receipt))}`);
  // An empty evidence file is not evidence: the contract's bounded read refuses it.
  const empty = fixture(t, c); empty.write(empty.fixed[0], "");
  assert.throws(() => p.writeV1ReleaseBinding(empty.root, empty.args), (error: Error) => error.message === `${empty.fixed[0]} is not a bounded regular evidence file`);
  assert.equal(existsSync(path.join(empty.root, BINDING)), false);
});

test("the producer never overwrites a binding, and --check compares one byte for byte and writes nothing", async (t) => {
  const c = await contract(); const p = await producer(); const f = fixture(t, c);
  const EXISTS = `${BINDING} already exists; the producer never overwrites a binding (use --check to compare it)`;
  refuses(p, f, `${BINDING} does not exist, so there is no binding to check`, f.args, "check");
  const written = p.writeV1ReleaseBinding(f.root, f.args);
  refuses(p, f, EXISTS);
  // Not committed yet: the check holds, and changes nothing.
  const status = f.status();
  const checked = p.checkV1ReleaseBinding(f.root, f.args);
  assert.equal(checked.sha256, written.sha256); assert.equal(checked.committed, false);
  assert.equal(f.status(), status); assert.ok(f.read(BINDING).equals(written.bytes));

  // The same binding in other bytes is refused: rows in another order, another
  // indent, no final newline, and a row whose digest is not the file's.
  const differs = (found: Buffer | string) => `${BINDING} (sha256 ${hash(found)}) is not byte for byte what the producer would write (sha256 ${written.sha256})`;
  const value = JSON.parse(written.bytes.toString("utf8"));
  for (const other of [
    serialize({ ...value, evidence: [...value.evidence].reverse() }),
    `${JSON.stringify(value, null, 4)}\n`,
    JSON.stringify(value, null, 2),
    serialize({ ...value, evidence: value.evidence.map((row: Any, index: number) => (index === 0 ? { ...row, sha256: "f".repeat(64) } : row)) }),
    serialize({ ...value, candidateTree: "f".repeat(40) })
  ]) {
    f.write(BINDING, other);
    refuses(p, f, differs(other), f.args, "check");
  }
  // Evidence that changed after the binding was written.
  f.write(BINDING, written.bytes.toString("utf8"));
  const original = f.read(f.fixed[2]);
  f.write(f.fixed[2], { fixture: "changed after the binding was written" });
  refuses(p, f, /is not byte for byte what the producer would write/, f.args, "check");
  writeFileSync(path.join(f.root, f.fixed[2]), original);

  // Committed as the carrier: the check holds at S, the write is refused, and
  // the check is refused once HEAD is no longer the carrier.
  const carrier = f.commit("Carrier", ...f.carrierFiles, BINDING);
  assert.equal(f.status(), "");
  const atCarrier = p.checkV1ReleaseBinding(f.root, f.args);
  assert.equal(atCarrier.committed, true); assert.equal(atCarrier.sha256, written.sha256); assert.equal(atCarrier.head, carrier);
  assert.equal(c.verifyV1ReleaseBinding(f.root, f.instruments, f.options).bindingSha256, written.sha256);
  refuses(p, f, EXISTS);
  f.git("commit", "-q", "--allow-empty", "-m", "An empty commit after the carrier");
  refuses(p, f, `commit ${carrier} changes ${BINDING} (A) after the candidate; the only tracked change a carrier history may hold is each of the carrier's files added once`, f.args, "check");
});

test("the producer refuses a working tree that holds anything but the carrier's additions", async (t) => {
  const c = await contract(); const p = await producer();
  const dirty = (state: string, relative: string) => `the working tree holds a change that a carrier does not add: "${state}" ${relative}`;
  const cases: [string, (f: Fixture) => string][] = [
    ["a tracked file modified", (f) => { f.write("app.js", "edited\n"); return dirty(" M", "app.js"); }],
    ["a tracked file modified and staged", (f) => { f.write("app.js", "edited\n"); f.git("add", "app.js"); return dirty("M ", "app.js"); }],
    ["a tracked file deleted", (f) => { unlinkSync(path.join(f.root, "app.js")); return dirty(" D", "app.js"); }],
    ["an untracked file that is no carrier file", (f) => { f.write("notes.txt", "stray\n"); return dirty("??", "notes.txt"); }],
    ["a staged file that is no carrier file", (f) => { f.write("notes.txt", "stray\n"); f.git("add", "notes.txt"); return dirty("A ", "notes.txt"); }],
    ["a second governance receipt", (f) => { const other = receiptPathOf(hash("other")); f.write(other, "other"); return dirty("??", other); }],
    ["a stray file beside the evidence", (f) => { const stray = `${path.posix.dirname(f.fixed[0])}/stray.json`; f.write(stray, {}); return dirty("??", stray); }],
    // The staged bytes are not the bytes the producer would read and bind.
    ["an evidence file staged and then edited", (f) => { f.git("add", "--", f.fixed[1]); f.write(f.fixed[1], { fixture: "edited after staging" }); return dirty("AM", f.fixed[1]); }],
    ["an evidence file committed after the candidate and then edited", (f) => {
      f.commit("Evidence", f.fixed[3]); f.write(f.fixed[3], { fixture: "edited after its commit" }); return dirty(" M", f.fixed[3]);
    }]
  ];
  for (const [name, arrange] of cases) {
    const f = fixture(t, c);
    assert.ok(p.v1ReleaseBindingBytes(f.root, f.args), `${name}: the fixture is accepted before the change`);
    refuses(p, f, arrange(f));
  }
  // An existing binding is a carrier file only for --check.
  const f = fixture(t, c);
  p.writeV1ReleaseBinding(f.root, f.args);
  f.write("notes.txt", "stray\n");
  refuses(p, f, dirty("??", "notes.txt"), f.args, "check");

  // An evidence file git ignores would never reach the carrier commit.
  const ignored = fixture(t, c, { ".gitignore": `${path.posix.basename(probeName(c))}\n` });
  refuses(p, ignored, `${probeName(c)} is on disk and git would not commit it (is it ignored?)`);
  // Nor would an ignored binding, which --check is there to catch before the carrier is committed.
  const ignoredBinding = fixture(t, c, { ".gitignore": `${path.posix.basename(BINDING)}\n` });
  p.writeV1ReleaseBinding(ignoredBinding.root, ignoredBinding.args);
  assert.equal(ignoredBinding.status().includes(BINDING), false);
  refuses(p, ignoredBinding, `${BINDING} is on disk and git would not commit it (is it ignored?)`, ignoredBinding.args, "check");
});
const probeName = (c: Any) => Object.keys(c.V1_FIXED_EVIDENCE)[5] as string;

test("the producer refuses any tracked change since the candidate that is not a carrier file added once", async (t) => {
  const c = await contract(); const p = await producer();
  const changed = (commit: string, relative: string, status: string) =>
    `commit ${commit} changes ${relative} (${status}) after the candidate; the only tracked change a carrier history may hold is each of the carrier's files added once`;

  const source = fixture(t, c);
  source.write("app.js", "altered instrument\n");
  const altered = source.commit("Intervening source change", "app.js");
  refuses(p, source, changed(altered, "app.js", "M"));
  // Reverted before the carrier: the tree is the candidate's again, and the history is not.
  source.write("app.js", "source version one\n");
  source.commit("Revert it", "app.js");
  assert.equal(source.git("diff", "--name-only", source.candidate, "HEAD"), "");
  refuses(p, source, changed(altered, "app.js", "M"));

  const added = fixture(t, c);
  added.write("notes.txt", "a new tracked file\n");
  refuses(p, added, changed(added.commit("A file no carrier adds", "notes.txt"), "notes.txt", "A"));

  const removed = fixture(t, c);
  removed.git("rm", "-q", "app.js");
  removed.git("commit", "-q", "-m", "Delete a source file");
  refuses(p, removed, changed(removed.git("rev-parse", "HEAD"), "app.js", "D"));

  // An evidence file added after the candidate and then rewritten in a later commit.
  const rewritten = fixture(t, c);
  rewritten.commit("Evidence", rewritten.fixed[0]);
  rewritten.write(rewritten.fixed[0], { fixture: "rewritten" });
  const rewrite = rewritten.commit("Rewrite it", rewritten.fixed[0]);
  refuses(p, rewritten, changed(rewrite, rewritten.fixed[0], "M"));
  // Added after the candidate and then deleted.
  const twice = fixture(t, c);
  twice.commit("Evidence", twice.fixed[0]);
  twice.git("rm", "-q", "--", twice.fixed[0]);
  twice.git("commit", "-q", "-m", "Delete it");
  refuses(p, twice, changed(twice.git("rev-parse", "HEAD"), twice.fixed[0], "D"));

  // A binding committed before HEAD is refused for --check, as the contract refuses it.
  const early = fixture(t, c);
  p.writeV1ReleaseBinding(early.root, early.args);
  const first = early.commit("Binding and six files", ...early.fixed, BINDING);
  early.commit("Receipt, one commit later", early.receipt);
  refuses(p, early, changed(first, BINDING, "A"), early.args, "check");
  assert.throws(() => c.verifyV1ReleaseBinding(early.root, early.instruments, early.options), (error: Error) => error.message === "v1 binding must be added once in the final carrier commit");

  // A merge between the candidate and HEAD, whose own diff shows nothing.
  const merged = fixture(t, c);
  merged.git("checkout", "-q", "-b", "side");
  merged.commit("Evidence on a side branch", merged.fixed[0]);
  merged.git("checkout", "-q", "main");
  merged.commit("Evidence on main", merged.fixed[1]);
  merged.git("merge", "-q", "--no-ff", "-m", "Merge the side branch", "side");
  assert.equal(merged.git("rev-list", "--merges", "--count", `${merged.candidate}..HEAD`), "1");
  refuses(p, merged, "the history from the candidate to HEAD holds a merge; a carrier history is linear");
});

test("the producer refuses a checkout that is not the complete investigative-v1 contract, and a directory that is not the root", async (t) => {
  const c = await contract(); const p = await producer();
  const PROFILE = "RELEASE_READINESS.json is not the complete investigative-v1 contract, which is the only one this binding serves";
  for (const mutate of [(m: Any) => { delete m.releaseProfile; }, (m: Any) => { m.targetRelease = "1.1.0"; }, (m: Any) => { delete m.gates["durable-soak"]; }]) {
    const m = manifest(); mutate(m);
    const root = mkdtempSync(path.join(tmpdir(), "sbl-v1-binding-profile-"));
    t.after(() => removeFixtureTree(root));
    initFixtureRepo(root);
    writeFileSync(path.join(root, "RELEASE_READINESS.json"), serialize(m));
    runFixtureGit(root, ["add", "."]); runFixtureGit(root, ["commit", "-q", "-m", "Candidate"]);
    const candidate = runFixtureGit(root, ["rev-parse", "HEAD"]).trim();
    assert.throws(() => p.writeV1ReleaseBinding(root, { candidateCommit: candidate, receiptSha256: "a".repeat(64) }),
      (error: Error) => error instanceof p.V1BindingRefusal && error.message === PROFILE);
    assert.equal(existsSync(path.join(root, BINDING)), false);
  }
  // No manifest at all.
  const bare = mkdtempSync(path.join(tmpdir(), "sbl-v1-binding-bare-"));
  t.after(() => removeFixtureTree(bare));
  initFixtureRepo(bare);
  writeFileSync(path.join(bare, "app.js"), "source\n");
  runFixtureGit(bare, ["add", "."]); runFixtureGit(bare, ["commit", "-q", "-m", "Candidate"]);
  assert.throws(() => p.writeV1ReleaseBinding(bare, { candidateCommit: runFixtureGit(bare, ["rev-parse", "HEAD"]).trim(), receiptSha256: "a".repeat(64) }),
    (error: Error) => error instanceof p.V1BindingRefusal && error.message === "RELEASE_READINESS.json cannot be read");
  assert.equal(existsSync(path.join(bare, "research")), false);

  const f = fixture(t, c);
  const ROOT = "run the binding producer at the root of the repository checkout";
  assert.throws(() => p.writeV1ReleaseBinding(path.join(f.root, "research"), f.args), (error: Error) => error instanceof p.V1BindingRefusal && error.message === ROOT);
  const outside = mkdtempSync(path.join(tmpdir(), "sbl-v1-binding-outside-"));
  t.after(() => removeFixtureTree(outside));
  assert.throws(() => p.writeV1ReleaseBinding(outside, f.args), (error: Error) => error instanceof p.V1BindingRefusal && error.message === ROOT);
  assert.equal(existsSync(path.join(f.root, BINDING)), false);
});

test("the command writes once, checks, refuses with exit 1 and a reason, and package.json names it", async (t) => {
  const c = await contract(); const f = fixture(t, c);
  const run = (...args: string[]) => spawnSyncBounded(process.execPath, [PRODUCER, ...args], { cwd: f.root, encoding: "utf8" });
  const packageJson = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8"));
  assert.equal(packageJson.scripts["release:v1-binding"], "node scripts/v1-release-binding.mjs");

  for (const args of [[], ["--candidate", f.candidate], ["--receipt-sha256", f.receiptSha256], ["--candidate", f.candidate, "--receipt-sha256"],
    ["--candidate", f.candidate, "--receipt-sha256", f.receiptSha256, "--force"], [f.candidate, f.receiptSha256],
    ["--candidate", f.candidate, "--candidate", f.candidate, "--receipt-sha256", f.receiptSha256]]) {
    const usage = run(...args);
    assert.equal(usage.status, 1, args.join(" ")); assert.match(usage.stderr, /^Usage: node scripts\/v1-release-binding\.mjs --candidate /);
    assert.equal(usage.stdout, "");
  }
  assert.equal(existsSync(path.join(f.root, BINDING)), false);

  const refusedCheck = run("--candidate", f.candidate, "--receipt-sha256", f.receiptSha256, "--check");
  assert.equal(refusedCheck.status, 1);
  assert.equal(refusedCheck.stderr, `Refused: ${BINDING} does not exist, so there is no binding to check\nNothing was written.\n`);

  const wrote = run("--candidate", f.candidate, "--receipt-sha256", f.receiptSha256);
  assert.equal(wrote.status, 0, wrote.stderr); assert.equal(wrote.stderr, "");
  const digest = hash(f.read(BINDING));
  assert.match(wrote.stdout, new RegExp(`^Wrote ${BINDING}\\n  sha256     ${digest}\\n  candidate  ${f.candidate} \\(tree ${f.candidateTree}\\)\\n`));
  for (const relative of f.carrierFiles) assert.ok(wrote.stdout.includes(`  ${hash(f.read(relative))}  ${relative}\n`), relative);
  assert.match(wrote.stdout, /Nothing was staged or committed\./);
  assert.equal(f.git("rev-parse", "HEAD"), f.candidate);
  assert.equal(f.git("diff", "--cached", "--name-only"), "");

  const again = run("--candidate", f.candidate, "--receipt-sha256", f.receiptSha256);
  assert.equal(again.status, 1); assert.equal(again.stdout, "");
  assert.equal(again.stderr, `Refused: ${BINDING} already exists; the producer never overwrites a binding (use --check to compare it)\nNo binding was written.\n`);
  assert.equal(hash(f.read(BINDING)), digest);

  const checked = run("--check", "--candidate", f.candidate, "--receipt-sha256", f.receiptSha256);
  assert.equal(checked.status, 0, checked.stderr);
  assert.match(checked.stdout, new RegExp(`^Checked ${BINDING}\\n  sha256     ${digest}\\n`));
  assert.match(checked.stdout, /The binding is not committed yet and is what the producer would write\.\n$/);
  f.commit("Carrier", ...f.carrierFiles, BINDING);
  const atCarrier = run("--candidate", f.candidate, "--receipt-sha256", f.receiptSha256, "--check");
  assert.equal(atCarrier.status, 0, atCarrier.stderr);
  assert.match(atCarrier.stdout, /The binding is committed at HEAD and is what the producer would write\.\n$/);
  assert.equal(c.verifyV1ReleaseBinding(f.root, f.instruments, f.options).bindingSha256, digest);
});
