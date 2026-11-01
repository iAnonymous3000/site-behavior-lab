import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { spawnSyncBounded, SPAWN_SYNC_TIMEOUT_MS } from "../../lib/bounded-spawn";
import { assertCaughtBy, holds, type SourceEdit } from "../../lib/finite-check";
import { runnerActorFrom, type Actor } from "../core/actor";
import { appendCommand, createLog, openLog, putEvidence, type LogStores } from "../core/case-log";
import { fsLogStores, prepareFsLogDirectory } from "../local/fs-log-store";
import type { ChildPlan } from "./fs-kill-child";
import { ATTEMPT_ONE, ATTEMPT_THREE, ATTEMPT_TWO, CASE_A, decode, encode, eventsTextOf, freshDirectory, GENESIS, handEntryText, runnerActorText, sha256OfText, withDirectory } from "./log-fixture";
import { NOW_MS } from "./token-fixture";

/**
 * M1's A11, on the filesystem store: killing the process at any step, then reopening,
 * gives the same state from the log. Each kill is a real SIGKILL in a real child
 * process, at every call that changes the disk, before it, after it, and halfway
 * through each write. The expected state is a list of hand-written entries, and the
 * step that commits is found from the child's own call trace.
 *
 * What this shows is atomicity under a process kill, including that nothing is held
 * that another process would wait on. A killed process loses nothing the kernel
 * already holds, so it says nothing about a power loss: that rests on the sync order
 * fs-log-store.test.ts writes out.
 */

const CHILD = path.join(__dirname, "fs-kill-child.js");
const SEED_ATTEMPT = ATTEMPT_TWO;
const ATTEMPT = ATTEMPT_ONE;
const ATTEMPT_AT = NOW_MS + 5000;
const EVIDENCE_TEXT = "evidence the killed command names";

type ModelEntry = Readonly<{ text: string; digest: string }>;

function entry(prev: string, seq: number, attemptId: string, type: string, atMs: number, evidence: readonly string[] = []): ModelEntry {
  const text = handEntryText({ actorText: runnerActorText(attemptId), atMs, eventsText: eventsTextOf(type), evidence, prev, seq });
  return { text, digest: sha256OfText(text) };
}

const FIRST = entry(GENESIS, 1, SEED_ATTEMPT, "first", NOW_MS);
const SECOND = entry(FIRST.digest, 2, SEED_ATTEMPT, "second", NOW_MS + 1000);
const ATTEMPTED = entry(SECOND.digest, 3, ATTEMPT, "attempted", ATTEMPT_AT, [sha256OfText(EVIDENCE_TEXT)]);

const plan = (over: Partial<ChildPlan> = {}): ChildPlan => ({
  scenario: "append",
  caseId: CASE_A,
  killAt: null,
  when: "before",
  atMs: ATTEMPT_AT,
  evidenceText: EVIDENCE_TEXT,
  eventType: "attempted",
  ...over
});

let sandbox: string;
let seeded: string;

/** A private copy of the seeded log for one child to die in, gone afterward whichever way the check ends. */
const withCopyOfSeed = <T>(run: (root: string) => T | Promise<T>): Promise<T> =>
  withDirectory("kill", (root) => {
    cpSync(seeded, root, { recursive: true });
    // A copy does not keep its folders' modes, and the store refuses one left open.
    for (const folder of ["entries", "evidence", "head", "tmp"]) chmodSync(path.join(root, folder), 0o700);
    return run(root);
  });

before(async () => {
  sandbox = freshDirectory("kill-seed");
  seeded = path.join(sandbox, "seed");
  mkdirSync(seeded, { mode: 0o700 });
  prepareFsLogDirectory(seeded);
  const stores = fsLogStores(seeded);
  await createLog(stores);
  const actor = runnerActorFrom(SEED_ATTEMPT) as Actor;
  await appendCommand(stores, { caseId: CASE_A, actor, events: [{ type: "first", data: {} }], evidence: [], expectedHead: GENESIS, now: () => NOW_MS });
  await appendCommand(stores, { caseId: CASE_A, actor, events: [{ type: "second", data: {} }], evidence: [], expectedHead: FIRST.digest, now: () => NOW_MS + 1000 });
});

after(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

/** A child told to run to the end. It must exit on its own: this is the case lib/bounded-spawn.ts is for. */
function runToEnd(root: string, childPlan: ChildPlan): { trace: readonly string[]; result: unknown; created: unknown } {
  const finished = spawnSyncBounded(process.execPath, [CHILD, root, JSON.stringify(childPlan)], { encoding: "utf8" });
  assert.equal(finished.status, 0, finished.stderr);
  return JSON.parse(finished.stdout.trim().split("\n").at(-1) as string) as { trace: readonly string[]; result: unknown; created: unknown };
}

/**
 * A child that must die at the step it was told. spawnSyncBounded rightly fails on a
 * signal, so this holds the same three facts itself: no timeout, SIGKILL, and the
 * marker the child wrote just before killing itself, without which a kill from
 * anywhere else would pass as this one.
 */
function runUntilKilled(root: string, childPlan: ChildPlan): void {
  const killed = spawnSync(process.execPath, [CHILD, root, JSON.stringify(childPlan)], { encoding: "utf8", timeout: SPAWN_SYNC_TIMEOUT_MS, killSignal: "SIGKILL" });
  assessKill(killed, childPlan.killAt);
}

type SpawnOutcome = Readonly<{ error?: Error; signal: NodeJS.Signals | null; status: number | null; stdout: string; stderr: string }>;

function assessKill(outcome: SpawnOutcome, killAt: number | null): void {
  const input = () => ({ killAt, error: outcome.error?.message, signal: outcome.signal, status: outcome.status, stdout: outcome.stdout, stderr: outcome.stderr });
  holds("the child did not time out", outcome.error === undefined, input);
  holds("the child died by SIGKILL", outcome.signal === "SIGKILL", input);
  holds("the child reached the step it was to die at", new RegExp(`^reached ${killAt} `, "m").test(outcome.stdout), input);
}

const reopened = (root: string): LogStores => fsLogStores(root);

/** The state in the disk, compared with hand-written entries, byte for byte. */
async function holdsToEntries(root: string, expected: readonly ModelEntry[], evidence: readonly string[], input: () => unknown): Promise<void> {
  const property = "the state after a kill and reopen equals the model";
  const stores = reopened(root);
  const opened = await openLog(stores, CASE_A);
  holds(property, opened.ok, () => ({ input: input(), opened }));
  assert.ok(opened.ok);
  const expectedHead = expected.at(-1)?.digest ?? GENESIS;
  holds(property, opened.log.head === expectedHead, () => ({ input: input(), head: opened.log.head, expectedHead }));
  holds(property, opened.log.entries.length === expected.length, () => ({ input: input(), length: opened.log.entries.length }));
  for (const [index, { digest, text }] of expected.entries()) {
    const bytes = await stores.entries.read(digest, 1024);
    holds(property, bytes instanceof Uint8Array && decode(bytes) === text && opened.log.entries[index].digest === digest, () => ({ input: input(), index }));
  }
  for (const text of evidence) {
    const bytes = await stores.evidence.read(sha256OfText(text), 1024);
    holds(property, bytes instanceof Uint8Array && decode(bytes) === text, () => ({ input: input(), text }));
  }
}

type FaultPoint = Readonly<{ index: number; step: string; when: ChildPlan["when"] }>;

function faultPoints(trace: readonly string[]): readonly FaultPoint[] {
  return trace.flatMap((step, index): FaultPoint[] => [
    { index, step, when: "before" },
    { index, step, when: "after" },
    ...(step.startsWith("write ") ? [{ index, step, when: "partial" as const }] : [])
  ]);
}

const appendTrace = (): Promise<readonly string[]> => withCopyOfSeed((root) => runToEnd(root, plan()).trace);

/** The one call that commits: the head slot's link. Exactly one, or the commit point is not what this file says. */
function commitIndex(trace: readonly string[]): number {
  const links = trace.flatMap((step, index) => (step.startsWith("link ") && step.endsWith(" head/000000000004") ? [index] : []));
  assert.equal(links.length, 1, JSON.stringify(trace));
  return links[0];
}

/**
 * A kill halfway through a write leaves exactly what reached the disk: the first half
 * of those bytes, under a temp name. Counting names alone would pass a child that
 * wrote nothing. The kill's own bytes are read back here, so this is what was written.
 */
function holdsPartialWrite(root: string, written: string, input: () => unknown): void {
  const temps = readdirSync(path.join(root, "tmp"));
  holds("a kill mid-write leaves exactly one temp file", temps.length === 1, () => ({ input: input(), temps }));
  const expected = encode(written);
  const half = Math.floor(expected.length / 2);
  const bytes = readFileSync(path.join(root, "tmp", temps[0]));
  holds("a kill mid-write leaves the first half of the bytes on disk, and no more", bytes.length === half && half > 0 && decode(bytes) === decode(expected.subarray(0, half)), () => ({ input: input(), bytes: bytes.length, half }));
}

/** What the nth write of an append writes, by the order the calls are written out below. */
const APPEND_WRITES = [EVIDENCE_TEXT, ATTEMPTED.text, ATTEMPTED.digest];

async function checkKillAt(point: FaultPoint, commit: number, edits: { logEdits?: readonly SourceEdit[]; storeEdits?: readonly SourceEdit[] } = {}): Promise<void> {
  await withCopyOfSeed(async (root) => {
    const input = () => point;
    const childPlan = plan({ killAt: point.index, when: point.when, ...edits });
    runUntilKilled(root, childPlan);
    const applied = point.index > commit || (point.index === commit && point.when === "after");
    const prior = [FIRST, SECOND];
    const afterwards = [FIRST, SECOND, ATTEMPTED];
    await holdsToEntries(root, applied ? afterwards : prior, [], input);

    // The next try, with new stores over what is on disk and the head the killed one read.
    const stores = reopened(root);
    const put = await putEvidence(stores, encode(EVIDENCE_TEXT));
    holds("evidence can be stored again after a kill", put.ok, () => ({ input: input(), put }));
    const actor = runnerActorFrom(ATTEMPT) as Actor;
    const retry = await appendCommand(stores, { caseId: CASE_A, actor, events: [{ type: "attempted", data: {} }], evidence: [sha256OfText(EVIDENCE_TEXT)], expectedHead: SECOND.digest, now: () => ATTEMPT_AT });
    if (applied) holds("a command that happened is not applied twice", !retry.ok && retry.refusal === "conflict", () => ({ input: input(), retry }));
    else holds("the next try after a kill works", retry.ok, () => ({ input: input(), retry }));
    await holdsToEntries(root, afterwards, [EVIDENCE_TEXT], input);
    // Leftover temp files change nothing, and the log still takes commands.
    const later = await appendCommand(stores, { caseId: CASE_A, actor, events: [{ type: "later", data: {} }], evidence: [], expectedHead: ATTEMPTED.digest, now: () => ATTEMPT_AT + 1000 });
    holds("the log takes the next command after a kill", later.ok, () => ({ input: input(), later }));
    if (point.when === "partial") {
      const nthWrite = (point.index - 1) / 9;
      holdsPartialWrite(root, APPEND_WRITES[nthWrite], input);
    }
  });
}

test("an append's calls are the stated ones, ending in the head slot's link and its cleanup", async () => {
  const trace = await appendTrace();
  const publish = (target: string, directory: string) => [
    "open tmp",
    "write tmp",
    "fsync tmp",
    "close tmp",
    `link tmp ${target}`,
    `open ${directory}`,
    `fsync ${directory}`,
    `close ${directory}`,
    "unlink tmp"
  ];
  assert.deepEqual(trace, [...publish("evidence/<digest>", "evidence"), ...publish("entries/<digest>", "entries"), ...publish("head/000000000004", "head")]);
});

test("SIGKILL at every step of an append reopens to the same state, and the next try lands exactly once", async () => {
  const trace = await appendTrace();
  const commit = commitIndex(trace);
  const points = faultPoints(trace);
  // 27 calls, before and after each, and halfway through each of the 3 writes.
  assert.equal(points.length, 57);
  for (const point of points) await checkKillAt(point, commit);
});

test("SIGKILL at every step of creating a log leaves no log or a whole one, and creating it again works", async () => {
  const { trace, created } = await withDirectory("kill-create", (root) => {
    prepareFsLogDirectory(root);
    return runToEnd(root, plan({ scenario: "create" }));
  });
  assert.deepEqual(created, { ok: true });
  const commit = trace.findIndex((step) => step === "link tmp head/000000000001");
  assert.ok(commit > 0);
  const points = faultPoints(trace);
  // 9 calls, before and after each, and halfway through the one write.
  assert.equal(points.length, 19);
  for (const point of points) {
    await withDirectory("kill-create", async (root) => {
      prepareFsLogDirectory(root);
      runUntilKilled(root, plan({ scenario: "create", killAt: point.index, when: point.when }));
      const applied = point.index > commit || (point.index === commit && point.when === "after");
      const opened = await openLog(reopened(root), CASE_A);
      assert.deepEqual(opened, applied ? { ok: true, log: { head: GENESIS, entries: [] } } : { ok: false, refusal: "head-missing", at: null }, `${point.index} ${point.when}`);
      if (point.when === "partial") holdsPartialWrite(root, GENESIS, () => point);
      const again = await createLog(reopened(root));
      assert.deepEqual(again, applied ? { ok: false, refusal: "log-exists", at: null } : { ok: true }, `${point.index} ${point.when}`);
      assert.deepEqual(await openLog(reopened(root), CASE_A), { ok: true, log: { head: GENESIS, entries: [] } });
    });
  }
});

// A check that cannot fail shows nothing. Each broken build runs in the real child.

/** Written in place, with no temp file, so a kill mid-write leaves a torn object at its real name. */
const WRITE_IN_PLACE: readonly SourceEdit[] = [
  {
    find: "const temp = writeTemp(ops, root, bytes);\n    let created = true;\n    try {\n        ops.linkSync(temp, target);\n    }\n    catch (error) {\n        if (!isTaken(error))\n            throw error;\n        created = false;\n    }\n",
    replace:
      'let created = true;\n    try {\n        const handle = ops.openSync(target, "wx", 0o600);\n        let written = 0;\n        while (written < bytes.length)\n            written += ops.writeSync(handle, bytes, written);\n        ops.fsyncSync(handle);\n        ops.closeSync(handle);\n    }\n    catch (error) {\n        if (!isTaken(error))\n            throw error;\n        created = false;\n    }\n'
  },
  { find: "ops.unlinkSync(temp);", replace: "" }
];

const SWAP_FIRST: readonly SourceEdit[] = [
  {
    find: 'if (!(await createVerified(stores.entries, digest, bytes)))\n        return refuse("object-collision", digest);\n    // The commit point. Everything before it is unreachable until this succeeds.\n    if (!(await stores.head.compareAndSwap(head, digest)))\n        return refuse("conflict");',
    replace: 'if (!(await stores.head.compareAndSwap(head, digest)))\n        return refuse("conflict");\n    if (!(await createVerified(stores.entries, digest, bytes)))\n        return refuse("object-collision", digest);'
  }
];

test("a store that writes in place is caught by a real kill: the torn object blocks the retry", async () => {
  // In this broken store the evidence object's first calls are its open at 0 and its write at 1, under its real name.
  await assertCaughtBy("writing in place", "evidence can be stored again after a kill", () =>
    checkKillAt({ index: 1, step: "write evidence/<digest>", when: "partial" }, Number.MAX_SAFE_INTEGER, { storeEdits: WRITE_IN_PLACE })
  );
});

test("the mid-write check reads the bytes, so a kill with nothing written, or all of it, does not pass", async () => {
  // What it exists to rule out: a child killed at the right step with its write never begun.
  const written = EVIDENCE_TEXT;
  const half = written.slice(0, Math.floor(written.length / 2));
  await withDirectory("partial", async (root) => {
    mkdirSync(path.join(root, "tmp"));
    const property = "a kill mid-write leaves the first half of the bytes on disk, and no more";
    writeFileSync(path.join(root, "tmp", "temp"), half);
    holdsPartialWrite(root, written, () => "half");
    for (const [what, bytes] of [["nothing", ""], ["all of it", written], ["the wrong half", written.slice(half.length, 2 * half.length)]] as const) {
      writeFileSync(path.join(root, "tmp", "temp"), bytes);
      await assertCaughtBy(what, property, () => holdsPartialWrite(root, written, () => what));
    }
    writeFileSync(path.join(root, "tmp", "another"), half);
    await assertCaughtBy("a second temp file", "a kill mid-write leaves exactly one temp file", () => holdsPartialWrite(root, written, () => "two"));
  });
});

test("the swap coming before the entry is caught by a real kill: the head names an object that never arrived", async () => {
  // In this broken build, the head's slot is published just before the entry's first call.
  const check = async () => {
    const trace = await withCopyOfSeed((dry) => runToEnd(dry, plan({ logEdits: SWAP_FIRST })).trace);
    const headLink = trace.findIndex((step) => step === "link tmp head/000000000004");
    const entryOpen = trace.findIndex((step, index) => index > headLink && step === "open tmp");
    assert.ok(headLink > 0 && entryOpen > headLink, JSON.stringify(trace));
    await withCopyOfSeed(async (root) => {
      runUntilKilled(root, plan({ killAt: entryOpen, when: "before", logEdits: SWAP_FIRST }));
      const opened = await openLog(reopened(root), CASE_A);
      holds("a kill never leaves the head naming an object that is not there", opened.ok, () => opened);
    });
  };
  await assertCaughtBy("the swap first", "a kill never leaves the head naming an object that is not there", check);
});

test("nothing but a kill at the planned step passes as one", async () => {
  // Handed to the same check that reads each real child, so these are its only ways out.
  const outcome = (over: Partial<SpawnOutcome>): SpawnOutcome => ({ signal: "SIGKILL", status: null, stdout: "reached 3 before open tmp\n", stderr: "", ...over });
  assessKill(outcome({}), 3);
  await assertCaughtBy("a timeout, which also ends in SIGKILL", "the child did not time out", () => assessKill(outcome({ error: new Error("ETIMEDOUT") }), 3));
  await assertCaughtBy("a child that exited on its own", "the child died by SIGKILL", () => assessKill(outcome({ signal: null, status: 0 }), 3));
  await assertCaughtBy("a child killed somewhere else", "the child reached the step it was to die at", () => assessKill(outcome({ stdout: "" }), 3));
  await assertCaughtBy("a child killed at another step", "the child reached the step it was to die at", () => assessKill(outcome({ stdout: "reached 13 before open tmp\n" }), 3));
});

test("a planned step the child never reaches fails, rather than passing as nothing happening", async () => {
  await withCopyOfSeed((root) => {
    assert.throws(() => runUntilKilled(root, plan({ killAt: 1_000, when: "before" })), /the child died by SIGKILL/);
  });
});

// M1's stale page and torn tail, on real files, after a real kill.

test("a torn orphan left at an entry's address is refused for that one write, and the log stays readable", async () => {
  await withCopyOfSeed(async (root) => {
    const stores = reopened(root);
    writeFileSync(path.join(root, "entries", ATTEMPTED.digest), ATTEMPTED.text.slice(0, 40));
    await holdsToEntries(root, [FIRST, SECOND], [], () => "a torn orphan");
    const put = await putEvidence(stores, encode(EVIDENCE_TEXT));
    assert.ok(put.ok);
    const actor = runnerActorFrom(ATTEMPT) as Actor;
    const sameWrite = await appendCommand(stores, { caseId: CASE_A, actor, events: [{ type: "attempted", data: {} }], evidence: [put.digest], expectedHead: SECOND.digest, now: () => ATTEMPT_AT });
    assert.equal(!sameWrite.ok && sameWrite.refusal, "object-collision");
    await holdsToEntries(root, [FIRST, SECOND], [], () => "after the refused write");
    // Any later moment gives different bytes and another address, so the log is not stuck.
    const otherWrite = await appendCommand(stores, { caseId: CASE_A, actor, events: [{ type: "attempted", data: {} }], evidence: [put.digest], expectedHead: SECOND.digest, now: () => ATTEMPT_AT + 1 });
    assert.equal(otherWrite.ok, true);
  });
});

// A FIFO opens with no writer and blocks forever unless told not to, and a test in this
// process could not time out while blocked, so these run in a child with a bound.

const openInChild = (root: string, edits: { storeEdits?: readonly SourceEdit[] } = {}, timeoutMs?: number): unknown => {
  const child = spawnSyncBounded(process.execPath, [CHILD, root, JSON.stringify(plan({ scenario: "open", ...edits }))], { encoding: "utf8" }, timeoutMs);
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout.trim().split("\n").at(-1) as string);
};

function mkfifo(file: string): void {
  const made = spawnSyncBounded("mkfifo", [file], { encoding: "utf8" });
  assert.equal(made.status, 0, made.stderr);
}

test("a FIFO at an entry, an evidence object or a head slot is refused by name, and nothing hangs on it", async () => {
  await withCopyOfSeed((root) => {
    rmSync(path.join(root, "entries", FIRST.digest));
    mkfifo(path.join(root, "entries", FIRST.digest));
    assert.deepEqual(openInChild(root), { ok: false, refusal: "entry-edited", at: FIRST.digest });
  });
  await withCopyOfSeed((root) => {
    mkfifo(path.join(root, "head", "000000000004"));
    assert.deepEqual(openInChild(root), { ok: false, refusal: "head-malformed", at: null });
  });
});

test("a FIFO at the address of empty evidence is not read as the empty object it would match", async () => {
  // Reading no bytes from a FIFO hashes to exactly this digest, so only the file type can stop it.
  const empty = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
  const check = async (edits: { storeEdits?: readonly SourceEdit[] } = {}) =>
    withDirectory("fifo", async (root) => {
      prepareFsLogDirectory(root);
      const stores = reopened(root);
      await createLog(stores);
      await putEvidence(stores, new Uint8Array(0));
      const actor = runnerActorFrom(ATTEMPT) as Actor;
      await appendCommand(stores, { caseId: CASE_A, actor, events: [{ type: "named", data: {} }], evidence: [empty], expectedHead: GENESIS, now: () => NOW_MS });
      rmSync(path.join(root, "evidence", empty));
      mkfifo(path.join(root, "evidence", empty));
      return openInChild(root, edits);
    });
  assert.deepEqual(await check(), { ok: false, refusal: "evidence-changed", at: empty });
  const withoutTheTypeCheck = await check({ storeEdits: [{ find: 'if (!stats.isFile())\n            return "not-an-object";', replace: "" }] });
  assert.equal((withoutTheTypeCheck as { ok: boolean }).ok, true, "removing the file type check lets it through, so that check is what stops it");
});

test("opening without O_NONBLOCK would hang on a FIFO, so that flag is what stops it", async () => {
  await withCopyOfSeed((root) => {
    rmSync(path.join(root, "entries", FIRST.digest));
    mkfifo(path.join(root, "entries", FIRST.digest));
    const blocking = [{ find: "O_RDONLY | nodeFs.constants.O_NOFOLLOW | nodeFs.constants.O_NONBLOCK", replace: "O_RDONLY | nodeFs.constants.O_NOFOLLOW" }];
    assert.throws(() => openInChild(root, { storeEdits: blocking }, 3_000), /still running after 3000 ms/);
  });
});

// Real processes at once. Whichever loses a slot retries, and nothing is lost or repeated.

function raceChild(root: string, writer: string, commands: number): Promise<{ conflicts: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [CHILD, root, JSON.stringify(plan({ scenario: "race", writer, commands, eventType: "raced", atMs: ATTEMPT_AT }))],
      { stdio: ["ignore", "pipe", "pipe"], timeout: SPAWN_SYNC_TIMEOUT_MS, killSignal: "SIGKILL" }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", reject);
    child.on("close", (status, signal) => {
      if (status !== 0) reject(new Error(`A writer ended with status ${status}, signal ${signal}: ${stderr}`));
      else resolve(JSON.parse(stdout.trim().split("\n").at(-1) as string) as { conflicts: number });
    });
  });
}

test("real processes appending at once lose no command and repeat none", async () => {
  await withCopyOfSeed(async (root) => {
    const writers = [ATTEMPT_ONE, ATTEMPT_TWO, ATTEMPT_THREE];
    const perWriter = 5;
    await Promise.all(writers.map((writer) => raceChild(root, writer, perWriter)));
    const opened = await openLog(reopened(root), CASE_A);
    assert.ok(opened.ok, JSON.stringify(opened));
    assert.equal(opened.log.entries.length, 2 + writers.length * perWriter);
    const landed = opened.log.entries.slice(2).map(({ entry: logged }) => {
      const { command, writer } = logged.events[0].data;
      return `${String(writer)} ${String(command)}`;
    });
    assert.deepEqual([...landed].sort(), writers.flatMap((writer) => Array.from({ length: perWriter }, (_, command) => `${writer} ${command}`)).sort());
    // Each writer's own commands land in its own order.
    for (const writer of writers) {
      const own = landed.filter((line) => line.startsWith(writer)).map((line) => Number(line.split(" ")[1]));
      assert.deepEqual(own, Array.from({ length: perWriter }, (_, command) => command));
    }
  });
});
