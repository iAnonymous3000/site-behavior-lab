import assert from "node:assert/strict";
import { test } from "node:test";
import { assertCaughtBy, holds, loadVariant, type SourceEdit } from "../../lib/finite-check";
import { runnerActorFrom, type Actor, type OwnerActor } from "../core/actor";
import { aggregate } from "../core/aggregates";
import * as productionEvents from "../core/case-events";
import { decodeEvent, digestsNamed, EVENT_TYPES, isConfigurationIdentity, type ConfigurationIdentity } from "../core/case-events";
import { appendCommand, createLog, GENESIS_HEAD, openLog, putEvidence, type LogEvent, type LogStores } from "../core/case-log";
import { retentionOf, type MachineRefusal, type SlotName } from "../core/case-machine";
import { readRow } from "../core/evidence-model";
import type { RecordRefusal } from "../core/evidence-model";
import * as production from "../core/case-store";
import { aggregateRowsOfCase, createCase, mintedSlots, openCase, runCommand, type OpenCase } from "../core/case-store";
import { mintCaseId } from "../core/ids";
import {
  actorsFor,
  ATTEMPT_IDS,
  CAPTURE_LABELS,
  CASE_SCRIPT,
  CONFIG_ALDER_KEY,
  CONFIG_BIRCH_KEY,
  CONTROL_RUN_ID,
  continueScript,
  digestOfRaw,
  FOREIGN_RUN_ID,
  IDENTITY_ALDER,
  IDENTITY_ALDER_REBUILT,
  IDENTITY_BIRCH,
  logEvent,
  PLAN_DIGEST,
  RAW_OBJECTS,
  risingClock,
  runScript,
  storeRawObjects,
  type ScriptActor,
  type ScriptCommand
} from "./case-fixture";
import { CASE_A, CASE_B, EXP, FILESYSTEM_BACKEND, MEMORY_BACKEND, verifiedOwnerActor, type Backend } from "./log-fixture";
import { copyOfStores, memoryStores, type MemoryStores } from "./memory-log-store";
import { NOW_MS } from "./token-fixture";

/**
 * A case on its log. The expected states are written out here, by attempt and phase, one per
 * command. Nothing compares the fold with a second run of itself, except where reopening is
 * the very thing being shown, and those are compared with the written-out state too.
 *
 * A crash here is a store operation that never returns, the in-process form of a process
 * dying between two steps, tried at every operation of a command on both stores. The real
 * SIGKILL at every disk call is fs-log-store-kill.test.ts, which covers what this rests on:
 * either the entry is reached from the head, or it is not. This adds no child process.
 */

type StoreModule = typeof production;
const variant = (...edits: SourceEdit[]) => loadVariant<StoreModule>(require.resolve("../core/case-store"), edits);

const fresh = async () => ({ owner: await verifiedOwnerActor() });

const startAt = NOW_MS + 1000;

/**
 * A stretch of the script, run by the real store and then opened by the module under test. A case
 * is registered by the module that folded it, so a variant has to open its own, and a variant
 * that breaks commands must not break the setup it is judged on.
 */
const caseFor = async (module: StoreModule, stores: MemoryStores, owner: Actor, commands: readonly ScriptCommand[], property = "the fixture's case opens"): Promise<OpenCase> => {
  await runScript({ stores, caseId: CASE_A, actorOf: actorsFor(owner), now: risingClock(startAt), commands });
  const opened = await module.openCase(stores, CASE_A);
  holds(property, opened.ok, () => opened);
  return (opened as Extract<production.OpenCaseResult, { ok: true }>).case;
};

function phases(opened: OpenCase): string {
  return (opened.state as NonNullable<OpenCase["state"]>).machine.attempts.map(({ phase }) => phase).join();
}

test("positive control: the whole synthetic case runs, one entry per command, to the phases written here", async () => {
  const { owner } = await fresh();
  const stores = memoryStores();
  const marks = await runScript({ stores, caseId: CASE_A, actorOf: actorsFor(owner), now: risingClock(startAt), commands: CASE_SCRIPT });
  assert.equal(marks.last.seq, CASE_SCRIPT.length, "one entry per command");
  const opened = await openLog(stores, CASE_A);
  assert.ok(opened.ok);
  assert.equal(opened.log.entries.length, CASE_SCRIPT.length);
  for (const { entry } of opened.log.entries) assert.equal(entry.events.length, 1, "one event per entry");
  const expected: readonly (readonly [string, string])[] = [
    ["planned", "planned,planned,planned,planned,planned,planned"],
    ["control-passed", "planned,planned,planned,planned,planned,planned"],
    ["b1-done", "usable,planned,planned,planned,planned,planned"],
    ["b2-done", "usable,usable,planned,planned,planned,planned"],
    ["b3-unconfirmed", "usable,usable,usable,planned,planned,planned"],
    ["baseline-ended", "usable,usable,usable,planned,planned,planned"],
    ["i1-ended", "usable,usable,usable,incomplete,planned,planned"],
    ["i2-ended", "usable,usable,usable,incomplete,failed,planned"],
    ["closed", "usable,usable,usable,incomplete,failed,not_started"]
  ];
  for (const [mark, want] of expected) assert.equal(phases(marks.get(mark) as OpenCase), want, mark);
  const state = marks.last.state as NonNullable<OpenCase["state"]>;
  assert.deepEqual(state.record.visitBases, [
    { slot: "B1", basis: "control" },
    { slot: "B2", basis: "exception" },
    { slot: "B3", basis: "control" },
    { slot: "I1", basis: "control" },
    { slot: "I2", basis: "control" }
  ]);
  assert.equal(state.machine.exploratory, true);
  assert.equal(state.machine.planDigest, PLAN_DIGEST);
  assert.deepEqual(state.machine.attempts.map(({ configuration }) => configuration), [CONFIG_ALDER_KEY, CONFIG_BIRCH_KEY, CONFIG_BIRCH_KEY, CONFIG_BIRCH_KEY, CONFIG_BIRCH_KEY, CONFIG_BIRCH_KEY]);
  assert.deepEqual(state.configurations, [IDENTITY_ALDER, IDENTITY_BIRCH]);
  assert.deepEqual(state.record.acquisitionReasons, [{ slot: "I1", reason: "instrument-output-lost" }, { slot: "I2", reason: "target-crashed" }]);
});

/** What a reopen must give, read off a state: a stable view, not the state compared with itself. */
const viewOf = (opened: OpenCase) => ({ seq: opened.seq, head: opened.head, state: opened.state });

const REOPEN = "a reopen gives the state the commands gave, on either store";

/** What each command does to the phases, read off the script itself and not through the machine. */
function phasesAfterEachCommand(): readonly string[] {
  const phase = new Map<string, string>(Object.keys(ATTEMPT_IDS).map((slot) => [slot, "planned"]));
  return CASE_SCRIPT.map(({ event }) => {
    const slot = (event.data as { slot?: string }).slot;
    if (event.type === "attempt-started") phase.set(slot as string, "starting");
    if (event.type === "capture-began") phase.set(slot as string, "capturing");
    if (event.type === "capture-finished") phase.set(slot as string, "finalizing");
    if (event.type === "attempt-finished") phase.set(slot as string, String(event.data.outcome));
    if (event.type === "case-cancelled") for (const [name, value] of phase) if (value === "planned") phase.set(name, "not_started");
    return [...phase.values()].join();
  });
}

for (const backend of [MEMORY_BACKEND, FILESYSTEM_BACKEND] as const) {
  test(`every prefix of the case reopens to the state its commands gave, on the ${backend.name} store`, async () => {
    const { owner } = await fresh();
    const { stores, dispose } = backend.fresh();
    try {
      await createLog(stores);
      await storeRawObjects(stores);
      const actorOf = actorsFor(owner);
      const now = risingClock(startAt);
      const opened = await openCase(stores, CASE_A);
      assert.ok(opened.ok);
      assert.equal(opened.case.state, null, "a log with no plan opens as no case");
      let current = opened.case;
      const expected = phasesAfterEachCommand();
      assert.equal(expected.length, CASE_SCRIPT.length);
      for (const [index, { as, event }] of CASE_SCRIPT.entries()) {
        const result = await runCommand(stores, current, { actor: actorOf(as), event, now });
        assert.ok(result.ok, `${event.type}: ${result.ok ? "" : result.refusal}`);
        current = result.case;
        const again = await openCase(stores, CASE_A);
        assert.ok(again.ok);
        assert.equal(again.case.seq, index + 1);
        assert.equal(phases(again.case), expected[index], event.type);
        assert.deepEqual(viewOf(again.case), viewOf(current), event.type);
      }
      assert.equal(phases(current), "usable,usable,usable,incomplete,failed,not_started");
    } finally {
      dispose();
    }
  });
}

const checkReturnsFoldOfWritten = async (module: StoreModule, owner: Actor) => {
  const stores = memoryStores();
  const held = await caseFor(module, stores, owner, CASE_SCRIPT.slice(0, 2), REOPEN);
  const event = logEvent("control-recorded", { configuration: IDENTITY_ALDER as never, result: "met" });
  const answer = await module.runCommand(stores, held, { actor: actorsFor(owner)("control"), event, now: risingClock(startAt + 10_000) });
  holds(REOPEN, answer.ok, () => answer);
  if (!answer.ok) return;
  const reopened = await module.openCase(stores, CASE_A);
  holds(REOPEN, reopened.ok && JSON.stringify(reopened.case.state) === JSON.stringify(answer.case.state) && reopened.case.head === answer.case.head, () => ({ answer, reopened }));
  holds(REOPEN, answer.case.seq === 3 && (answer.case.state as NonNullable<OpenCase["state"]>).machine.controlMet, () => answer.case);
};

test("what a command returns is what a reopen finds", async () => {
  const { owner } = await fresh();
  await checkReturnsFoldOfWritten(production, owner);
  await assertCaughtBy("the old state returned", REOPEN, () => checkReturnsFoldOfWritten(variant({ find: "seq: appended.entry.seq, state: checked.state }", replace: "seq: appended.entry.seq, state: opened.state }" }), owner));
  await assertCaughtBy("the old head returned", REOPEN, () => checkReturnsFoldOfWritten(variant({ find: "head: appended.digest, seq: appended.entry.seq,", replace: "head: opened.head, seq: appended.entry.seq," }), owner));
  await assertCaughtBy("a reopen with no fold", REOPEN, () => checkReturnsFoldOfWritten(variant({ find: "state = result.state;\n        seq = entry.seq;", replace: "seq = entry.seq;" }), owner));
});

const WHO = "who acted comes from the entry's derived actor, and from nothing typed";

const checkAttribution = async (module: StoreModule, owner: OwnerActor) => {
  const stores = memoryStores();
  const current = await caseFor(module, stores, owner as Actor, CASE_SCRIPT.slice(0, 2));
  const runner = runnerActorFrom(ATTEMPT_IDS.B1) as Actor;
  const now = risingClock(startAt + 50_000);
  const before = await openLog(stores, CASE_A);

  // A runner's entry cannot record an exception, whatever its data claims.
  const claimed = await module.runCommand(stores, current, { actor: runner, event: logEvent("exception-recorded", { slot: "B1", reason: "A real reason.", by: "owner" }), now });
  holds(WHO, !claimed.ok && claimed.refusal === "malformed-event", () => claimed);
  const plain = await module.runCommand(stores, current, { actor: runner, event: logEvent("exception-recorded", { slot: "B1", reason: "A real reason." }), now });
  holds(WHO, !plain.ok && plain.refusal === "owner-only", () => plain);

  // A typed actor field is a field that does not exist.
  for (const data of [{ planDigest: PLAN_DIGEST, by: { kind: "owner" } }, { planDigest: PLAN_DIGEST, actor: "owner" }, { planDigest: PLAN_DIGEST, name: "someone" }]) {
    const typed = await module.runCommand(stores, current, { actor: owner, event: logEvent("plan-frozen", data as never), now });
    holds(WHO, !typed.ok && typed.refusal === "malformed-event", () => typed);
  }

  // An object that merely looks like an actor gets nowhere, and nor does what is no actor at all.
  for (const lookalike of [{ ...owner }, { kind: "owner" }, null, "owner"]) {
    const looked = await module.runCommand(stores, current, { actor: lookalike as Actor, event: logEvent("exception-recorded", { slot: "B1", reason: "A real reason." }), now }).catch((error: unknown) => ({ ok: false as const, refusal: String(error), at: null }));
    holds(WHO, !looked.ok && looked.refusal === "not-an-actor", () => looked);
  }

  // None of those wrote anything.
  const after = await openLog(stores, CASE_A);
  holds(WHO, before.ok && after.ok && before.log.head === after.log.head, () => ({ before, after }));

  // And the positive control: the owner, with the same data, is who the entry names.
  const real = await module.runCommand(stores, current, { actor: owner, event: logEvent("exception-recorded", { slot: "B1", reason: "A real reason." }), now });
  holds(WHO, real.ok, () => real);
  const logged = await openLog(stores, CASE_A);
  holds(WHO, logged.ok && logged.log.entries.at(-1)?.entry.actor.kind === "owner", () => logged);
  // The fold reads who acted from the entry, so what a reopen finds is the owner's exception.
  const reopened = await module.openCase(stores, CASE_A);
  holds(WHO, reopened.ok && reopened.case.state?.machine.exceptionFor === "B1", () => reopened);
};

test("a command attributes only through a derived actor, and no field can claim otherwise", async () => {
  const { owner } = await fresh();
  await checkAttribution(production, owner as OwnerActor);
  await assertCaughtBy("a look-alike actor reaching the log", WHO, () => checkAttribution(variant({ find: 'if (!(0, actor_1.isDerivedActor)(actor))\n        return { ok: false, refusal: "not-an-actor", at: null };\n    if (!isFoldedCase(opened, stores))', replace: "if (!isFoldedCase(opened, stores))" }), owner as OwnerActor));
  await assertCaughtBy("every entry read as the owner's", WHO, () => checkAttribution(variant({ find: 'return actor.kind === "owner" ? { kind: "owner" } : { kind: "system:runner", attemptId: actor.attemptId };', replace: 'return { kind: "owner" };' }), owner as OwnerActor));
});

const REFUSED_WRITES_NOTHING = "a refused command leaves the log as it was";

const checkRefusedWritesNothing = async (module: StoreModule, owner: Actor) => {
  const stores = memoryStores();
  const held = await caseFor(module, stores, owner, CASE_SCRIPT.slice(0, 2));
  const objectsBefore = stores.entries.objects.size;
  const headBefore = stores.head.value;
  const now = risingClock(startAt + 50_000);
  for (const [event, refusal] of [
    [logEvent("attempt-started", { slot: "B1" }), "no-valid-control"],
    [logEvent("no-such-event"), "unknown-event-type"],
    [logEvent("plan-frozen", {}), "malformed-event"],
    [logEvent("plan-frozen", { planDigest: PLAN_DIGEST }), "plan-already-frozen"],
    [logEvent("fact-recorded", { id: "fact-one", statement: "Words.", evidence: ["row-nowhere"] }), "no-such-row"],
    // Refused by the machine for a row of a slot that never began, before the record is reached.
    [logEvent("evidence-recorded", { row: { id: "row-early", slot: "B1", instrument: "coverage", state: "no_record", window: { clock: null, note: "not-begun" }, limits: [], digest: null, observation: null } }), "not-this-attempt"]
  ] as const) {
    const answer = await module.runCommand(stores, held, { actor: owner, event, now });
    holds(REFUSED_WRITES_NOTHING, !answer.ok && answer.refusal === refusal, () => ({ event, answer }));
  }
  const notCanonical = await module.runCommand(stores, held, { actor: owner, event: { type: "plan-frozen", data: { planDigest: PLAN_DIGEST, extra: 1.5 } }, now });
  holds(REFUSED_WRITES_NOTHING, !notCanonical.ok && notCanonical.refusal === "malformed-command", () => notCanonical);
  holds(REFUSED_WRITES_NOTHING, stores.entries.objects.size === objectsBefore && stores.head.value === headBefore, () => ({ size: stores.entries.objects.size, objectsBefore }));
};

test("a refused command writes nothing", async () => {
  const { owner } = await fresh();
  await checkRefusedWritesNothing(production, owner);
  await assertCaughtBy("appending first and folding after", REFUSED_WRITES_NOTHING, () =>
    checkRefusedWritesNothing(
      variant(
        { find: "const checked = foldEntry(opened.state, { actor, events: [own], evidence, seq: opened.seq + 1 });\n    if (!checked.ok)\n        return checked;", replace: "" },
        { find: "if (!appended.ok)\n        return appended;", replace: "if (!appended.ok)\n        return appended;\n    const checked = foldEntry(opened.state, appended.entry);\n    if (!checked.ok)\n        return checked;" }
      ),
      owner
    )
  );
});

test("a row for an attempt that never began is the machine's refusal, whoever sends it", async () => {
  const { owner } = await fresh();
  const stores = memoryStores();
  const marks = await runScript({ stores, caseId: CASE_A, actorOf: actorsFor(owner), now: risingClock(startAt), commands: CASE_SCRIPT.slice(0, 2) });
  const row = { id: "row-early", slot: "B1", instrument: "coverage", state: "no_record", window: { clock: null, note: "not-begun" }, limits: [], digest: null, observation: null };
  const answer = await runCommand(stores, marks.last, { actor: actorsFor(owner)("B1"), event: logEvent("evidence-recorded", { row }), now: risingClock(startAt + 50_000) });
  assert.deepEqual(answer, { ok: false, refusal: "attempt-not-begun", at: null });
});

test("a stale reader gets the log's conflict, and a second reader's command stands", async () => {
  const { owner } = await fresh();
  const stores = memoryStores();
  const marks = await runScript({ stores, caseId: CASE_A, actorOf: actorsFor(owner), now: risingClock(startAt), commands: CASE_SCRIPT.slice(0, 2) });
  const now = risingClock(startAt + 50_000);
  const first = await runCommand(stores, marks.last, { actor: actorsFor(owner)("control"), event: logEvent("control-recorded", { configuration: IDENTITY_ALDER as never, result: "met" }), now });
  assert.ok(first.ok);
  const stale = await runCommand(stores, marks.last, { actor: actorsFor(owner)("control"), event: logEvent("control-recorded", { configuration: IDENTITY_ALDER as never, result: "not_met" }), now });
  assert.deepEqual(stale, { ok: false, refusal: "conflict", at: null });
  const reopened = await openCase(stores, CASE_A);
  assert.ok(reopened.ok);
  assert.equal(reopened.case.head, first.case.head);
  assert.equal(reopened.case.state?.machine.controlMet, true);
});

const NEVER_SKIPS = "a log the fold cannot explain opens as a refusal, never as a state with a gap in it";

/** For a variant whose fold hands back no state, which production's never does, so it fails on what it reads and not on a null. */
const NO_STATE_PASSES = { find: "return applied.ok ? withKept(state, decoded.event, named, applied.state) : applied;", replace: "return applied.ok && applied.state !== null ? withKept(state, decoded.event, named, applied.state) : applied;" };

/** What an event's entry must name, for a raw entry that does not say otherwise. */
const namedBy = (events: readonly LogEvent[]): readonly string[] => {
  const decoded = events.length === 1 ? decodeEvent(events[0]) : null;
  return decoded !== null && decoded.ok ? digestsNamed(decoded.event) : [];
};

/** Commands written straight to the log, past runCommand, as another writer or a later version could. */
async function withRawEntries(owner: Actor, entries: readonly Readonly<{ events: readonly LogEvent[]; evidence?: readonly string[]; actor?: Actor }>[]): Promise<Readonly<{ stores: MemoryStores; head: string }>> {
  const stores = memoryStores();
  await createLog(stores);
  await storeRawObjects(stores);
  let head = GENESIS_HEAD;
  let at = startAt;
  for (const { events, evidence = namedBy(events), actor = owner } of entries) {
    at += 1000;
    const answer = await appendCommand(stores, { caseId: CASE_A, actor, events, evidence, expectedHead: head, now: () => at });
    assert.ok(answer.ok, answer.ok ? "" : answer.refusal);
    head = answer.digest;
  }
  return { stores, head };
}

const checkFoldRefuses = async (module: StoreModule, owner: Actor) => {
  const planned = CASE_SCRIPT[0].event;
  const frozen = CASE_SCRIPT[1].event;
  // These reach the log only past runCommand, or are the fold's own. `at` is what the refusal names, or null for the entry's digest.
  const table: readonly (readonly [string, readonly Readonly<{ events: readonly LogEvent[]; evidence?: readonly string[]; actor?: Actor }>[], string, string | null])[] = [
    ["an event before the plan", [{ events: [frozen] }], "not-planned", null],
    ["two plans", [{ events: [planned] }, { events: [planned] }], "already-planned", null],
    ["a plan from a runner", [{ events: [planned], actor: runnerActorFrom(ATTEMPT_IDS.B1) as Actor }], "owner-only", null],
    ["an unknown type", [{ events: [planned] }, { events: [logEvent("claim-approved", { claim: "one" })] }], "unknown-event-type", "type"],
    ["extra data", [{ events: [planned] }, { events: [logEvent("plan-frozen", { planDigest: PLAN_DIGEST, by: "owner" })] }], "malformed-event", "plan-frozen"],
    ["two events in one entry", [{ events: [planned, frozen] }], "not-one-command", null],
    ["an entry naming evidence its event does not", [{ events: [planned], evidence: [...namedBy([planned]), digestOfRaw("raw-patch")] }], "evidence-not-named", null],
    ["an entry naming its evidence out of order", [{ events: [planned], evidence: [...namedBy([planned])].reverse() }], "evidence-not-named", null],
    ["an entry naming less than its event", [{ events: [planned], evidence: namedBy([planned]).slice(0, 1) }], "evidence-not-named", null],
    ["an entry naming nothing for a frozen plan", [{ events: [planned] }, { events: [frozen], evidence: [] }], "evidence-not-named", null],
    ["an event naming evidence its entry does not", [{ events: [planned] }, { events: [frozen] }, { events: [logEvent("source-reconstructed", { appliesTo: ["B1"], baseCommit: "ca".repeat(20), patchDigest: digestOfRaw("raw-patch"), identity: "9a".repeat(32) })], evidence: [] }], "evidence-not-named", null]
  ];
  for (const [name, entries, refusal, at] of table) {
    const { stores, head } = await withRawEntries(owner, entries);
    const answer = await module.openCase(stores, CASE_A);
    // A refusal says where. When the rule did not name a field, it names the entry.
    holds(NEVER_SKIPS, !answer.ok && answer.refusal === refusal && answer.at === (at ?? head), () => ({ name, answer, expected: at ?? head }));
  }
};

test("a fold refuses what it cannot apply, and never skips it", async () => {
  const { owner } = await fresh();
  await checkFoldRefuses(production, owner);
  await assertCaughtBy("a refused entry skipped", NEVER_SKIPS, () => checkFoldRefuses(variant({ find: "if (!result.ok)\n            return { ok: false, refusal: result.refusal, at: (_a = result.at) !== null && _a !== void 0 ? _a : digest };", replace: "if (!result.ok)\n            continue;" }), owner));
  await assertCaughtBy("a refusal with no field naming a fixed word and not the entry", NEVER_SKIPS, () => checkFoldRefuses(variant({ find: "at: (_a = result.at) !== null && _a !== void 0 ? _a : digest };", replace: 'at: (_a = result.at) !== null && _a !== void 0 ? _a : "entry" };' }), owner));
  await assertCaughtBy("a second plan taken", NEVER_SKIPS, () => checkFoldRefuses(variant({ find: 'if (state !== null)\n            return refused("already-planned");', replace: "" }), owner));
  await assertCaughtBy("a plan from anyone", NEVER_SKIPS, () => checkFoldRefuses(variant({ find: 'if (by.kind !== "owner")\n            return refused("owner-only");', replace: "" }), owner));
  await assertCaughtBy("an event with no plan taken as nothing", NEVER_SKIPS, () => checkFoldRefuses(variant({ find: 'if (state === null)\n        return refused("not-planned");', replace: 'if (state === null)\n        return { ok: true, state: null };' }, NO_STATE_PASSES), owner));
  await assertCaughtBy("a second event in an entry ignored", NEVER_SKIPS, () => checkFoldRefuses(variant({ find: 'if (entry.events.length !== 1)\n        return refused("not-one-command");', replace: "" }), owner));
  await assertCaughtBy("what an entry names not compared", NEVER_SKIPS, () => checkFoldRefuses(variant({ find: 'if (!sameList(named, entry.evidence))\n        return refused("evidence-not-named");', replace: "" }), owner));
  await assertCaughtBy("what an entry names compared as a set", NEVER_SKIPS, () => checkFoldRefuses(variant({ find: "left.every((value, index) => value === right[index])", replace: "left.every((value) => right.includes(value))" }), owner));
});

const REFUSED_BY_NAME = "every refusal the machine and the record can give stops a fold, and a command, by its own name";

const met = (configuration: unknown = IDENTITY_ALDER): ScriptCommand => ({ as: "control", event: logEvent("control-recorded", { configuration: configuration as never, result: "met" }) });
const notMet = (): ScriptCommand => ({ as: "control", event: logEvent("control-recorded", { configuration: IDENTITY_ALDER as never, result: "not_met" }) });
const start = (slot: "B1" | "B2" | "I1"): ScriptCommand => ({ as: "owner", event: logEvent("attempt-started", { slot }) });
const began = (slot: "B1" | "B2" | "I1"): ScriptCommand => ({ as: slot, event: logEvent("capture-began", { slot }) });
const ended = (slot: "B1" | "B2" | "I1", outcome = "usable"): readonly ScriptCommand[] => [{ as: slot, event: logEvent("capture-finished", { slot }) }, { as: slot, event: logEvent("attempt-finished", { slot, outcome, reason: outcome === "usable" ? null : "a-reason" }) }];
const clean = (slot: "B1" | "B2" | "I1"): ScriptCommand => ({ as: "owner", event: logEvent("cleanup-confirmed", { slot }) });
const owned = (type: string, data: LogEvent["data"] = {}): ScriptCommand => ({ as: "owner", event: logEvent(type, data) });

const RAW_ONE = digestOfRaw("raw-b1-coverage");
const rowOn = (id: string, instrument = "coverage", state = "present") => ({ id, slot: "B1", instrument, state, window: { clock: "page", startMs: 1, endMs: 2 }, limits: [], digest: state === "present" ? RAW_ONE : null, observation: null });
const rowEvent = (id: string, instrument = "coverage", state = "present"): ScriptCommand => ({ as: "B1", event: logEvent("evidence-recorded", { row: rowOn(id, instrument, state) as never }) });

const PLANNED = [CASE_SCRIPT[0]];
const FROZEN = CASE_SCRIPT.slice(0, 2);
const OPEN_GATE = [...FROZEN, met()];
const STARTED = [...OPEN_GATE, start("B1")];
const CAPTURING = [...STARTED, began("B1")];
const WITH_ROW = [...CAPTURING, rowEvent("row-held")];
const B1_ENDED = [...CAPTURING, ...ended("B1")];
const B1_DONE = [...B1_ENDED, clean("B1")];
/** One of each arm, so the rule and the second arm's slot can be reached in few steps. */
const PLAN_OF_TWO = owned("case-planned", { slots: [{ slot: "B1", attemptId: ATTEMPT_IDS.B1 }, { slot: "I1", attemptId: ATTEMPT_IDS.I1 }], configuration: IDENTITY_ALDER as never });
const TWO_DONE = [PLAN_OF_TWO, CASE_SCRIPT[1], met(), start("B1"), began("B1"), ...ended("B1"), clean("B1")];
const RULE_MET = [...TWO_DONE, owned("baseline-rule-recorded", { result: "met" })];
const CLOSED_WITH_ROW = [...WITH_ROW, owned("case-cancelled")];
const MANIFEST = owned("purge-manifest-recorded", { paths: [RAW_ONE] });
const WITH_MANIFEST = [...CLOSED_WITH_ROW, MANIFEST];
const withClaims = (...more: readonly ScriptCommand[]) => [...WITH_ROW, owned("fact-recorded", { id: "fact-held", statement: "Words.", evidence: ["row-held"] }), ...more];
const HELD_ID = "canary-query-value-9c1bx";
const unknownOf = (id: string) => ({ id, question: "What?", reason: "Nothing showed.", detail: null, wouldResolve: null });

type Path = "stepped" | "evidence" | "add-row" | "record" | "plan" | "fold";
type RefusalRow = Readonly<{ path: Path; before: readonly ScriptCommand[]; as: ScriptActor | "foreign"; event: LogEvent; at: string | null }>;

/**
 * Every refusal the machine and the record have, each reached through the log. The Record type
 * makes it whole at compile time, except for two no log can reach, because the decoder refuses
 * first: "unknown-event", for an unknown type, and "manifest-malformed", for a repeated path.
 * purge.test.ts holds that one. `path` says which line of the fold gives it.
 */
const CATALOGUE: Readonly<Record<Exclude<MachineRefusal | RecordRefusal, "unknown-event" | "manifest-malformed">, RefusalRow>> = {
  "malformed-plan": { path: "plan", before: [], as: "owner", event: logEvent("case-planned", { slots: [{ slot: "B1", attemptId: ATTEMPT_IDS.B1 }, { slot: "B1", attemptId: ATTEMPT_IDS.B2 }], configuration: IDENTITY_ALDER as never }), at: null },
  "owner-only": { path: "stepped", before: PLANNED, as: "B1", event: CASE_SCRIPT[1].event, at: null },
  "runner-only": { path: "stepped", before: FROZEN, as: "owner", event: met().event, at: null },
  "not-this-attempt": { path: "stepped", before: STARTED, as: "B2", event: logEvent("capture-began", { slot: "B1" }), at: null },
  "not-this-case": { path: "stepped", before: FROZEN, as: "B1", event: met().event, at: null },
  "no-such-slot": { path: "stepped", before: [PLAN_OF_TWO, CASE_SCRIPT[1]], as: "owner", event: logEvent("exception-recorded", { slot: "I2", reason: "Because." }), at: null },
  "case-closed": { path: "stepped", before: [...PLANNED, owned("case-cancelled")], as: "owner", event: logEvent("case-cancelled"), at: null },
  "plan-not-frozen": { path: "stepped", before: PLANNED, as: "owner", event: start("B1").event, at: null },
  "plan-already-frozen": { path: "stepped", before: FROZEN, as: "owner", event: CASE_SCRIPT[1].event, at: null },
  "attempt-already-begun": { path: "stepped", before: STARTED, as: "owner", event: start("B1").event, at: null },
  "another-attempt-running": { path: "stepped", before: STARTED, as: "owner", event: start("B2").event, at: null },
  "not-next-slot": { path: "stepped", before: OPEN_GATE, as: "owner", event: start("B2").event, at: null },
  "cleanup-unresolved": { path: "stepped", before: B1_ENDED, as: "owner", event: start("B2").event, at: null },
  "baseline-rule-pending": { path: "stepped", before: TWO_DONE, as: "owner", event: start("I1").event, at: null },
  "no-valid-control": { path: "stepped", before: FROZEN, as: "owner", event: start("B1").event, at: null },
  "control-already-met": { path: "stepped", before: OPEN_GATE, as: "control", event: met().event, at: null },
  "control-limit": { path: "stepped", before: [...FROZEN, notMet(), notMet()], as: "control", event: met().event, at: null },
  "configuration-unchanged": { path: "stepped", before: FROZEN, as: "owner", event: logEvent("configuration-changed", { configuration: IDENTITY_ALDER as never }), at: null },
  "configuration-change-spent": { path: "stepped", before: [...FROZEN, owned("configuration-changed", { configuration: IDENTITY_BIRCH as never })], as: "owner", event: logEvent("configuration-changed", { configuration: IDENTITY_ALDER as never }), at: null },
  "configuration-floor-unreachable": { path: "stepped", before: TWO_DONE, as: "owner", event: logEvent("configuration-changed", { configuration: IDENTITY_BIRCH as never }), at: null },
  "configuration-after-rule": { path: "stepped", before: RULE_MET, as: "owner", event: logEvent("configuration-changed", { configuration: IDENTITY_BIRCH as never }), at: null },
  "exception-after-visit": { path: "stepped", before: STARTED, as: "owner", event: logEvent("exception-recorded", { slot: "B1", reason: "Because." }), at: null },
  "exception-not-next": { path: "stepped", before: FROZEN, as: "owner", event: logEvent("exception-recorded", { slot: "B2", reason: "Because." }), at: null },
  "exception-pending": { path: "stepped", before: [...FROZEN, owned("exception-recorded", { slot: "B1", reason: "Because." })], as: "owner", event: logEvent("exception-recorded", { slot: "B1", reason: "Again." }), at: null },
  "no-baseline": { path: "stepped", before: [owned("case-planned", { slots: [{ slot: "B1", attemptId: ATTEMPT_IDS.B1 }], configuration: IDENTITY_ALDER as never })], as: "owner", event: logEvent("baseline-rule-recorded", { result: "met" }), at: null },
  "baseline-not-finished": { path: "stepped", before: FROZEN, as: "owner", event: logEvent("baseline-rule-recorded", { result: "met" }), at: null },
  "baseline-rule-already-recorded": { path: "stepped", before: RULE_MET, as: "owner", event: logEvent("baseline-rule-recorded", { result: "met" }), at: null },
  "baseline-floor-unmet": { path: "stepped", before: [PLAN_OF_TWO, CASE_SCRIPT[1], met(), start("B1"), began("B1"), ...ended("B1", "walled"), clean("B1")], as: "owner", event: logEvent("baseline-rule-recorded", { result: "met" }), at: null },
  "wrong-phase": { path: "stepped", before: STARTED, as: "B1", event: logEvent("capture-finished", { slot: "B1" }), at: null },
  "outcome-not-reachable": { path: "stepped", before: STARTED, as: "B1", event: logEvent("attempt-finished", { slot: "B1", outcome: "usable", reason: null }), at: null },
  "start-retry-limit": { path: "stepped", before: [...STARTED, { as: "B1", event: logEvent("attempt-start-retried", { slot: "B1" }) }, { as: "B1", event: logEvent("attempt-start-retried", { slot: "B1" }) }], as: "B1", event: logEvent("attempt-start-retried", { slot: "B1" }), at: null },
  "attempt-not-begun": { path: "evidence", before: FROZEN, as: "B1", event: rowEvent("row-early", "coverage", "no_record").event, at: null },
  "evidence-duplicate": { path: "evidence", before: WITH_ROW, as: "B1", event: rowEvent("row-held").event, at: null },
  "nothing-to-reconcile": { path: "stepped", before: PLANNED, as: "owner", event: logEvent("reconcile"), at: null },
  "no-cleanup": { path: "stepped", before: FROZEN, as: "owner", event: clean("B1").event, at: null },
  "attempt-running": { path: "stepped", before: STARTED, as: "owner", event: clean("B1").event, at: null },
  "cleanup-settled": { path: "stepped", before: B1_DONE, as: "owner", event: clean("B1").event, at: null },
  "case-open": { path: "stepped", before: PLANNED, as: "owner", event: MANIFEST.event, at: null },
  "manifest-already-recorded": { path: "stepped", before: WITH_MANIFEST, as: "owner", event: MANIFEST.event, at: null },
  "no-such-path": { path: "stepped", before: CLOSED_WITH_ROW, as: "owner", event: logEvent("purge-path-absent", { path: RAW_ONE }), at: null },
  "path-status-unchanged": { path: "stepped", before: [...WITH_MANIFEST, owned("purge-path-absent", { path: RAW_ONE })], as: "owner", event: logEvent("purge-path-absent", { path: RAW_ONE }), at: null },
  "id-taken": { path: "record", before: [...FROZEN, owned("assertion-recorded", { id: HELD_ID, statement: "Said." })], as: "owner", event: logEvent("assertion-recorded", { id: HELD_ID, statement: "Said again." }), at: "id" },
  "fact-needs-evidence": { path: "record", before: FROZEN, as: "owner", event: logEvent("fact-recorded", { id: HELD_ID, statement: "Words.", evidence: [] }), at: "evidence" },
  "no-such-row": { path: "record", before: FROZEN, as: "owner", event: logEvent("fact-recorded", { id: "fact-one", statement: "Words.", evidence: [HELD_ID] }), at: "evidence" },
  "row-not-present": { path: "record", before: [...CAPTURING, rowEvent(HELD_ID, "coverage", "no_record")], as: "owner", event: logEvent("fact-recorded", { id: "fact-one", statement: "Words.", evidence: [HELD_ID] }), at: "evidence" },
  "row-from-missing-instrument": { path: "add-row", before: [...CAPTURING, { as: "B1", event: logEvent("instrument-recorded", { slot: "B1", instrument: HELD_ID, completeness: "missing", reason: "output-lost" }) }], as: "B1", event: rowEvent("row-new", HELD_ID).event, at: "row.instrument" },
  "instrument-missing-has-row": { path: "record", before: [...CAPTURING, rowEvent("row-new", HELD_ID)], as: "B1", event: logEvent("instrument-recorded", { slot: "B1", instrument: HELD_ID, completeness: "missing", reason: "output-lost" }), at: "instrument" },
  "instrument-already-recorded": { path: "record", before: [...CAPTURING, { as: "B1", event: logEvent("instrument-recorded", { slot: "B1", instrument: HELD_ID, completeness: "complete", reason: null }) }], as: "B1", event: logEvent("instrument-recorded", { slot: "B1", instrument: HELD_ID, completeness: "complete", reason: null }), at: "instrument" },
  "no-such-claim": { path: "record", before: FROZEN, as: "owner", event: logEvent("fact-superseded", { fact: HELD_ID, statement: "Words.", reason: "Because." }), at: "fact" },
  "not-a-fact": { path: "record", before: [...FROZEN, owned("assertion-recorded", { id: HELD_ID, statement: "Said." })], as: "owner", event: logEvent("fact-superseded", { fact: HELD_ID, statement: "Words.", reason: "Because." }), at: "fact" },
  "not-an-assertion": { path: "record", before: withClaims(), as: "owner", event: logEvent("assertion-retracted", { assertion: "fact-held", reason: "Because.", unknown: unknownOf("question-one") }), at: "assertion" },
  "not-an-interpretation": { path: "record", before: withClaims(), as: "owner", event: logEvent("interpretation-reaffirmed", { interpretation: "fact-held", cites: [{ fact: "fact-held", version: 1 }] }), at: "interpretation" },
  "fact-not-current": { path: "record", before: withClaims(owned("fact-retracted", { fact: "fact-held", reason: "Because.", unknown: null })), as: "owner", event: logEvent("fact-superseded", { fact: "fact-held", statement: "Words.", reason: "Because." }), at: "fact" },
  "same-wording": { path: "record", before: withClaims(), as: "owner", event: logEvent("fact-superseded", { fact: "fact-held", statement: "Words.", reason: "Because." }), at: "statement" },
  "assertion-already-retracted": { path: "record", before: [...FROZEN, owned("assertion-recorded", { id: "said-one", statement: "Said." }), owned("assertion-retracted", { assertion: "said-one", reason: "Because.", unknown: unknownOf("question-one") })], as: "owner", event: logEvent("assertion-retracted", { assertion: "said-one", reason: "Because.", unknown: unknownOf("question-two") }), at: "assertion" },
  "interpretation-needs-cites": { path: "record", before: FROZEN, as: "owner", event: logEvent("interpretation-recorded", { id: HELD_ID, statement: "Words.", cites: [] }), at: "cites" },
  "cites-assertion": { path: "record", before: [...FROZEN, owned("assertion-recorded", { id: HELD_ID, statement: "Said." })], as: "owner", event: logEvent("interpretation-recorded", { id: "reading-one", statement: "Words.", cites: [{ fact: HELD_ID, version: 1 }] }), at: "cites" },
  "cites-interpretation": { path: "record", before: withClaims(owned("interpretation-recorded", { id: HELD_ID, statement: "Words.", cites: [{ fact: "fact-held", version: 1 }] })), as: "owner", event: logEvent("interpretation-recorded", { id: "reading-one", statement: "Words.", cites: [{ fact: HELD_ID, version: 1 }] }), at: "cites" },
  "cites-unknown": { path: "record", before: [...FROZEN, owned("unknown-recorded", { unknown: unknownOf(HELD_ID) })], as: "owner", event: logEvent("interpretation-recorded", { id: "reading-one", statement: "Words.", cites: [{ fact: HELD_ID, version: 1 }] }), at: "cites" },
  "cites-no-such-fact": { path: "record", before: FROZEN, as: "owner", event: logEvent("interpretation-recorded", { id: "reading-one", statement: "Words.", cites: [{ fact: HELD_ID, version: 1 }] }), at: "cites" },
  "cite-not-current": { path: "record", before: withClaims(), as: "owner", event: logEvent("interpretation-recorded", { id: "reading-one", statement: "Words.", cites: [{ fact: "fact-held", version: 9 }] }), at: "cites" },
  "cites-repeated": { path: "record", before: withClaims(), as: "owner", event: logEvent("interpretation-recorded", { id: "reading-one", statement: "Words.", cites: [{ fact: "fact-held", version: 1 }, { fact: "fact-held", version: 1 }] }), at: "cites" },
  "cites-not-its-facts": { path: "record", before: [...withClaims(owned("interpretation-recorded", { id: "reading-one", statement: "Words.", cites: [{ fact: "fact-held", version: 1 }] }), owned("fact-recorded", { id: "fact-other", statement: "Other.", evidence: ["row-held"] }), owned("fact-superseded", { fact: "fact-held", statement: "New words.", reason: "Because." }))], as: "owner", event: logEvent("interpretation-reaffirmed", { interpretation: "reading-one", cites: [{ fact: "fact-other", version: 1 }] }), at: "cites" },
  "not-flagged": { path: "record", before: withClaims(owned("interpretation-recorded", { id: "reading-one", statement: "Words.", cites: [{ fact: "fact-held", version: 1 }] })), as: "owner", event: logEvent("interpretation-reaffirmed", { interpretation: "reading-one", cites: [{ fact: "fact-held", version: 1 }] }), at: "interpretation" },
  "source-already-reconstructed": { path: "record", before: [...B1_ENDED, owned("source-reconstructed", { appliesTo: ["B1"], baseCommit: "ca".repeat(20), patchDigest: digestOfRaw("raw-patch"), identity: "9a".repeat(32) })], as: "owner", event: logEvent("source-reconstructed", { appliesTo: ["B1"], baseCommit: "ca".repeat(20), patchDigest: digestOfRaw("raw-patch"), identity: "9b".repeat(32) }), at: null },
  "source-needs-slots": { path: "record", before: FROZEN, as: "owner", event: logEvent("source-reconstructed", { appliesTo: [], baseCommit: "ca".repeat(20), patchDigest: digestOfRaw("raw-patch"), identity: "9a".repeat(32) }), at: "appliesTo" },
  "source-slot-recorded": { path: "record", before: [...CAPTURING, { as: "B1", event: logEvent("source-recorded", { slot: "B1", commit: "c0".repeat(20), identity: "9b".repeat(32) }) }, ...ended("B1")], as: "owner", event: logEvent("source-reconstructed", { appliesTo: ["B1"], baseCommit: "ca".repeat(20), patchDigest: digestOfRaw("raw-patch"), identity: "9a".repeat(32) }), at: "appliesTo" },
  "source-attempt-not-ended": { path: "record", before: FROZEN, as: "owner", event: logEvent("source-reconstructed", { appliesTo: ["B1"], baseCommit: "ca".repeat(20), patchDigest: digestOfRaw("raw-patch"), identity: "9a".repeat(32) }), at: "appliesTo" },
  "source-already-recorded": { path: "record", before: [...CAPTURING, { as: "B1", event: logEvent("source-recorded", { slot: "B1", commit: "c0".repeat(20), identity: "9b".repeat(32) }) }], as: "B1", event: logEvent("source-recorded", { slot: "B1", commit: "c0".repeat(20), identity: "9b".repeat(32) }), at: "slot" },
  "source-after-attempt": { path: "record", before: B1_ENDED, as: "B1", event: logEvent("source-recorded", { slot: "B1", commit: "c0".repeat(20), identity: "9b".repeat(32) }), at: "slot" },
  "instrument-after-attempt": { path: "record", before: B1_ENDED, as: "B1", event: logEvent("instrument-recorded", { slot: "B1", instrument: "coverage", completeness: "complete", reason: null }), at: "slot" }
};

/** The record's own answers to names the machine shares, and the fold's own, which no type lists. */
const MORE_REFUSALS: readonly (RefusalRow & Readonly<{ refusal: string }>)[] = [
  { refusal: "owner-only", path: "record", before: FROZEN, as: "B1", event: logEvent("assertion-recorded", { id: HELD_ID, statement: "Said." }), at: null },
  { refusal: "not-this-attempt", path: "record", before: CAPTURING, as: "owner", event: logEvent("instrument-recorded", { slot: "B1", instrument: HELD_ID, completeness: "complete", reason: null }), at: "slot" },
  { refusal: "no-such-slot", path: "record", before: [PLAN_OF_TWO, CASE_SCRIPT[1]], as: "I2" as ScriptActor, event: logEvent("instrument-recorded", { slot: "I2", instrument: HELD_ID, completeness: "complete", reason: null }), at: "slot" },
  { refusal: "attempt-not-begun", path: "record", before: FROZEN, as: "B1", event: logEvent("instrument-recorded", { slot: "B1", instrument: HELD_ID, completeness: "complete", reason: null }), at: "slot" },
  { refusal: "no-such-slot", path: "record", before: [PLAN_OF_TWO, CASE_SCRIPT[1]], as: "owner", event: logEvent("source-reconstructed", { appliesTo: ["I2"], baseCommit: "ca".repeat(20), patchDigest: digestOfRaw("raw-patch"), identity: "9a".repeat(32) }), at: "appliesTo" },
  { refusal: "id-taken", path: "add-row", before: withClaims(), as: "B1", event: rowEvent("fact-held").event, at: "row.id" },
  { refusal: "id-taken", path: "record", before: WITH_ROW, as: "owner", event: logEvent("unknown-recorded", { unknown: unknownOf("row-held") }), at: "unknown.id" },
  { refusal: "not-this-case", path: "stepped", before: FROZEN, as: "foreign", event: met().event, at: null },
  { refusal: "not-this-attempt", path: "stepped", before: B1_ENDED, as: "foreign", event: clean("B1").event, at: null },
  { refusal: "evidence-after-manifest", path: "fold", before: WITH_MANIFEST, as: "B1", event: rowEvent("row-after").event, at: "row" },
  { refusal: "manifest-not-the-evidence", path: "fold", before: CLOSED_WITH_ROW, as: "owner", event: logEvent("purge-manifest-recorded", { paths: [digestOfRaw("raw-patch")] }), at: "paths" },
  { refusal: "manifest-not-the-evidence", path: "fold", before: CLOSED_WITH_ROW, as: "owner", event: logEvent("purge-manifest-recorded", { paths: [] }), at: "paths" },
  { refusal: "manifest-empty-after-a-visit", path: "fold", before: [...CAPTURING, owned("case-cancelled")], as: "owner", event: logEvent("purge-manifest-recorded", { paths: [] }), at: "paths" },
  { refusal: "raw-object-cannot-be-kept", path: "fold", before: WITH_MANIFEST, as: "owner", event: logEvent("source-reconstructed", { appliesTo: ["B1"], baseCommit: "ca".repeat(20), patchDigest: RAW_ONE, identity: "9a".repeat(32) }), at: "patchDigest" },
  { refusal: "raw-object-cannot-be-kept", path: "fold", before: [...WITH_ROW, ...ended("B1"), clean("B1")], as: "owner", event: logEvent("configuration-changed", { configuration: { ...IDENTITY_BIRCH, fixtureDigest: RAW_ONE } as never }), at: "configuration" },
  { refusal: "raw-object-cannot-be-kept", path: "fold", before: [...FROZEN, owned("exception-recorded", { slot: "B1", reason: "Because." }), start("B1"), began("B1"), rowEvent("row-held"), ...ended("B1"), clean("B1")], as: "owner", event: logEvent("configuration-changed", { configuration: { ...IDENTITY_BIRCH, criterionDigest: RAW_ONE } as never }), at: "configuration" }
];

const everyRow = (): readonly (RefusalRow & Readonly<{ refusal: string }>)[] => [...Object.entries(CATALOGUE).map(([refusal, row]) => ({ refusal, ...row })), ...MORE_REFUSALS];

const checkOneRefusal = async (module: StoreModule, owner: Actor, { refusal, before, as, event, at }: RefusalRow & Readonly<{ refusal: string }>) => {
  const stores = memoryStores();
  const actorOf = actorsFor(owner);
  const held = await caseFor(module, stores, owner, before);
  const actor = as === "foreign" ? (runnerActorFrom(FOREIGN_RUN_ID) as Actor) : actorOf(as);
  const headBefore = stores.head.value;

  // As a command: refused by name, naming the field or nothing, and nothing is written.
  const answer = await module.runCommand(stores, held, { actor, event, now: risingClock(startAt + 500_000) });
  holds(REFUSED_BY_NAME, !answer.ok && answer.refusal === refusal && answer.at === at, () => ({ refusal, at, answer }));
  holds(REFUSED_BY_NAME, stores.head.value === headBefore, () => ({ refusal, wrote: true }));
  holds(REFUSED_BY_NAME, !JSON.stringify(answer).includes(HELD_ID), () => ({ refusal, answer }));

  // As an entry already in the log, past the command's check: the fold stops there and names it.
  const appended = await appendCommand(stores, { caseId: CASE_A, actor, events: [event], evidence: namedBy([event]), expectedHead: held.head, now: () => startAt + 600_000 });
  holds(REFUSED_BY_NAME, appended.ok, () => ({ refusal, appended }));
  const opened = await module.openCase(stores, CASE_A);
  const digest = appended.ok ? appended.digest : "";
  holds(REFUSED_BY_NAME, !opened.ok && opened.refusal === refusal && opened.at === (at ?? digest), () => ({ refusal, at, digest, opened }));
  holds(REFUSED_BY_NAME, !JSON.stringify(opened).includes(HELD_ID), () => ({ refusal, opened }));
};

test("every refusal stops a command and a fold by its own name, with the field it names", async () => {
  const { owner } = await fresh();
  const rows = everyRow();
  assert.equal(rows.length, REFUSAL_ROWS);
  for (const row of rows) await checkOneRefusal(production, owner, row);
});

const REFUSAL_ROWS = 87;

/** The line of the fold that gives this refusal, changed to skip it as harmless. Only that row needs running. */
const skipping = (path: Path, refusal: string): SourceEdit => {
  const passed = `{ ok: true, state }`;
  switch (path) {
    case "stepped":
      return { find: "const result = (0, case_machine_1.step)(state.machine, event);\n    return result.ok ?", replace: `const result = (0, case_machine_1.step)(state.machine, event);\n    if (!result.ok && result.refusal === ${JSON.stringify(refusal)})\n        return ${passed};\n    return result.ok ?` };
    case "evidence":
      return { find: "if (!stepResult.ok)\n                return refused(stepResult.refusal);", replace: `if (!stepResult.ok)\n                return stepResult.refusal === ${JSON.stringify(refusal)} ? ${passed} : refused(stepResult.refusal);` };
    case "add-row":
      return { find: "refused(added.refusal, added.at);", replace: `added.refusal === ${JSON.stringify(refusal)} ? ${passed} : refused(added.refusal, added.at);` };
    case "record":
      return { find: "const result = (0, evidence_model_1.applyRecordEvent)(state.record, event, by, state.machine, seq);\n        return result.ok ?", replace: `const result = (0, evidence_model_1.applyRecordEvent)(state.record, event, by, state.machine, seq);\n        if (!result.ok && result.refusal === ${JSON.stringify(refusal)})\n            return ${passed};\n        return result.ok ?` };
    case "plan":
      return { find: "refused(planned.refusal);", replace: "{ ok: true, state: null };" };
    case "fold":
      if (refusal === "evidence-after-manifest") return { find: 'if (state.machine.purge !== null)\n                return refused("evidence-after-manifest", "row");', replace: "" };
      if (refusal === "manifest-empty-after-a-visit") return { find: 'return event.paths.length === 0 && begun ? refused("manifest-empty-after-a-visit", "paths") : result;', replace: "return result;" };
      if (refusal === "raw-object-cannot-be-kept") return { find: 'if (named.some((digest) => raw.has(digest)))\n            return refused("raw-object-cannot-be-kept", keptField(event));', replace: "" };
      return { find: 'if (!isSameSet(event.paths, purgeSetOf(state)))\n                return refused("manifest-not-the-evidence", "paths");', replace: "" };
  }
};

test("a fold that takes any one refusal as harmless is caught at that refusal", async () => {
  const { owner } = await fresh();
  for (const row of everyRow()) {
    await assertCaughtBy(`the fold skipping ${row.refusal} from its ${row.path} line`, REFUSED_BY_NAME, () => checkOneRefusal(variant(skipping(row.path, row.refusal), NO_STATE_PASSES), owner, row));
  }
});

const VALUES = "a refusal's field is a name, never what the command held";

test("a refusal that repeats what it was handed is caught, through the store", async () => {
  const { owner } = await fresh();
  const evidenceVariant = (find: string, replace: string) => loadVariant<typeof import("../core/evidence-model")>(require.resolve("../core/evidence-model"), [{ find, replace }]);
  // A store built over an evidence model that echoes, by the way a real one would be: its compiled import pointed there.
  const row = CATALOGUE["no-such-row"];
  const stores = memoryStores();
  const marks = await runScript({ stores, caseId: CASE_A, actorOf: actorsFor(owner), now: risingClock(startAt), commands: row.before });
  const answer = await runCommand(stores, marks.last, { actor: owner, event: row.event, now: risingClock(startAt + 500_000) });
  assert.deepEqual(answer, { ok: false, refusal: "no-such-row", at: "evidence" });
  await assertCaughtBy("no-such-row echoing the row it did not find", VALUES, () => {
    const echoing = evidenceVariant('return refuse("no-such-row", "evidence");', 'return refuse("no-such-row", id);');
    const result = echoing.applyRecordEvent(echoing.EMPTY_RECORD, { type: "fact-recorded", id: "fact-one", statement: "Words.", evidence: [HELD_ID] }, { kind: "owner" }, (marks.last.state as NonNullable<OpenCase["state"]>).machine, 3);
    holds(VALUES, !result.ok && result.at === "evidence", () => result);
  });
});

test("what the log detects still reads through: an edited entry and a changed object refuse the case", async () => {
  const { owner } = await fresh();
  for (const backend of [MEMORY_BACKEND, FILESYSTEM_BACKEND] as Backend[]) {
    const { stores, tamper, dispose } = backend.fresh();
    try {
      const marks = await runScript({ stores, caseId: CASE_A, actorOf: actorsFor(owner), now: risingClock(startAt), commands: CASE_SCRIPT.slice(0, 8) });
      const head = marks.last.head;
      const opened = await openLog(stores, CASE_A);
      assert.ok(opened.ok);
      const entryBytes = await stores.entries.read(head, 1 << 20);
      tamper.setEntry(head, new TextEncoder().encode("edited"));
      assert.deepEqual(await openCase(stores, CASE_A), { ok: false, refusal: "entry-edited", at: head });
      tamper.setEntry(head, entryBytes as Uint8Array);
      assert.ok((await openCase(stores, CASE_A)).ok, "restored");

      const digest = digestOfRaw("raw-b1-coverage");
      tamper.setEvidence(digest, new TextEncoder().encode("a changed capture"));
      assert.deepEqual(await openCase(stores, CASE_A), { ok: false, refusal: "evidence-changed", at: digest });
      tamper.setEvidence(digest, new TextEncoder().encode(RAW_OBJECTS["raw-b1-coverage"]));
      assert.ok((await openCase(stores, CASE_A)).ok, "restored");
    } finally {
      dispose();
    }
  }
});

test("an entry's evidence is named from the event, so the log hashes each object on every open", async () => {
  const { owner } = await fresh();
  const stores = memoryStores();
  const marks = await runScript({ stores, caseId: CASE_A, actorOf: actorsFor(owner), now: risingClock(startAt), commands: CASE_SCRIPT.slice(0, 7) });
  const opened = await openLog(stores, CASE_A);
  assert.ok(opened.ok);
  assert.deepEqual(opened.log.entries.at(-1)?.entry.evidence, [digestOfRaw("raw-b1-coverage")]);
  assert.equal(marks.last.seq, 7);
  // A digest nothing was stored under is refused by the log, so a wrong one cannot be named.
  const wrong = logEvent("evidence-recorded", { row: { ...rowOn("row-wrong"), digest: "7e".repeat(32) } as never });
  const answer = await runCommand(stores, marks.last, { actor: actorsFor(owner)("B1"), event: wrong, now: risingClock(startAt + 90_000) });
  assert.deepEqual(answer, { ok: false, refusal: "evidence-missing", at: "7e".repeat(32) });
});

const NAMED = "what a plan and a configuration rest on is named by their entries, so the log binds each to a stored object";

const checkNamed = (module: typeof productionEvents) => {
  const fixture = digestOfRaw("raw-fixture");
  const criterion = digestOfRaw("raw-criterion");
  const named = (type: string, data: LogEvent["data"]) => {
    const decoded = module.decodeEvent({ type, data });
    holds(NAMED, decoded.ok, () => ({ type, decoded }));
    return (decoded as Extract<productionEvents.DecodeResult, { ok: true }>).event;
  };
  const table: readonly (readonly [string, LogEvent["data"], readonly string[]])[] = [
    ["plan-frozen", { planDigest: PLAN_DIGEST }, [PLAN_DIGEST]],
    ["case-planned", { slots: [{ slot: "B1", attemptId: ATTEMPT_IDS.B1 }], controlRunId: CONTROL_RUN_ID, configuration: IDENTITY_ALDER as never }, [fixture, criterion]],
    ["control-recorded", { configuration: IDENTITY_BIRCH as never, result: "met" }, [fixture, criterion]],
    ["configuration-changed", { configuration: IDENTITY_BIRCH as never }, [fixture, criterion]],
    // A digest used for both is named once, or the log's list would refuse it.
    ["configuration-changed", { configuration: { ...IDENTITY_ALDER, criterionDigest: fixture } as never }, [fixture]],
    ["source-reconstructed", { appliesTo: ["B1"], baseCommit: "ca".repeat(20), patchDigest: digestOfRaw("raw-patch"), identity: "9a".repeat(32) }, [digestOfRaw("raw-patch")]],
    ["evidence-recorded", { row: rowOn("row-one") as never }, [RAW_ONE]],
    ["evidence-recorded", { row: rowOn("row-one", "coverage", "no_record") as never }, []],
    // Recorded as given, and named by nothing: see digestsNamed, which says why.
    ["source-recorded", { slot: "B1", commit: "c0".repeat(20), identity: "9b".repeat(32) }, []],
    ["case-deadline", {}, []]
  ];
  for (const [type, data, expected] of table) {
    const seen = module.digestsNamed(named(type, data));
    holds(NAMED, JSON.stringify(seen) === JSON.stringify(expected), () => ({ type, seen, expected }));
  }
};

test("a frozen plan, a configuration and a patch are bound to stored objects, and the log refuses one that is not there", async () => {
  checkNamed(productionEvents);
  const events = (find: string, replace: string) => () => checkNamed(loadVariant<typeof productionEvents>(require.resolve("../core/case-events"), [{ find, replace }]));
  await assertCaughtBy("a frozen plan bound to nothing", NAMED, events('case "plan-frozen":\n            return [event.planDigest];', ""));
  await assertCaughtBy("a configuration bound to nothing", NAMED, events("return configurationDigests(event.configuration);", "return [];"));
  await assertCaughtBy("a criterion left out", NAMED, events("[...new Set([configuration.fixtureDigest, configuration.criterionDigest])]", "[configuration.fixtureDigest]"));
  await assertCaughtBy("a shared digest named twice", NAMED, events("[...new Set([configuration.fixtureDigest, configuration.criterionDigest])]", "[configuration.fixtureDigest, configuration.criterionDigest]"));
  await assertCaughtBy("a patch bound to nothing", NAMED, events("return [event.patchDigest];", "return [];"));
  await assertCaughtBy("a row bound to nothing", NAMED, events("return event.row.digest === null ? [] : [event.row.digest];", "return [];"));

  const { owner } = await fresh();
  const notThere = "7e".repeat(32);
  const stores = memoryStores();
  const marks = await runScript({ stores, caseId: CASE_A, actorOf: actorsFor(owner), now: risingClock(startAt), commands: PLANNED });
  const now = risingClock(startAt + 90_000);
  const refusedPlan = await runCommand(stores, marks.last, { actor: owner, event: logEvent("plan-frozen", { planDigest: notThere }), now });
  assert.deepEqual(refusedPlan, { ok: false, refusal: "evidence-missing", at: notThere });
  // A configuration whose fixture or criterion is not stored cannot be named at all.
  const frozen = await runCommand(stores, marks.last, { actor: owner, event: CASE_SCRIPT[1].event, now });
  assert.ok(frozen.ok);
  for (const field of ["fixtureDigest", "criterionDigest"]) {
    const changed = await runCommand(stores, frozen.case, { actor: owner, event: logEvent("configuration-changed", { configuration: { ...IDENTITY_BIRCH, [field]: notThere } as never }), now });
    assert.deepEqual(changed, { ok: false, refusal: "evidence-missing", at: notThere }, field);
    const control = await runCommand(stores, frozen.case, { actor: actorsFor(owner)("control"), event: logEvent("control-recorded", { configuration: { ...IDENTITY_ALDER, [field]: notThere } as never, result: "met" }), now });
    assert.deepEqual(control, { ok: false, refusal: "evidence-missing", at: notThere }, field);
  }
});

const BOUND_STATE = "a command takes only the case this isolate folded, at its own head, and a refusal writes nothing";

const checkFoldedCaseOnly = async (module: StoreModule, owner: Actor) => {
  const stores = memoryStores();
  const older = await caseFor(module, stores, owner, CASE_SCRIPT.slice(0, 2));
  await continueScript({ stores, caseId: CASE_A, actorOf: actorsFor(owner), now: risingClock(startAt + 10_000), commands: CASE_SCRIPT.slice(2, 4) });
  const opened = await module.openCase(stores, CASE_A);
  holds(BOUND_STATE, opened.ok, () => opened);
  const genuine = (opened as Extract<production.OpenCaseResult, { ok: true }>).case;
  const now = risingClock(startAt + 50_000);
  const startEvent: LogEvent = logEvent("attempt-started", { slot: "B1" });
  const copied = JSON.parse(JSON.stringify(genuine)) as OpenCase;
  const edited = JSON.parse(JSON.stringify(older)) as { state: { machine: { controlMet: boolean } } };
  edited.state.machine.controlMet = true;
  const forged: readonly (readonly [string, unknown])[] = [
    ["an older state with the current head", { ...genuine, state: older.state }],
    ["the current state with a wrong sequence", { ...genuine, seq: genuine.seq + 500 }],
    ["an edited state", { ...genuine, ...edited }],
    ["a copy of the real thing", copied],
    ["a spread of the real thing", { ...genuine }],
    ["a proxy of the real thing", new Proxy(genuine, {})],
    ["something that is no case", null],
    ["a string", genuine.head],
    ["an empty object, whose head reads undefined", {}],
    ["an empty list", []],
    ["what a case holds, spelled by hand, with no head", { caseId: genuine.caseId, seq: genuine.seq, state: genuine.state }],
    ["undefined", undefined]
  ];
  const before = stores.head.value;
  for (const [name, held] of forged) {
    const answer = await module.runCommand(stores, held as OpenCase, { actor: owner, event: startEvent, now });
    holds(BOUND_STATE, JSON.stringify(answer) === JSON.stringify({ ok: false, refusal: "not-a-folded-case", at: null }), () => ({ name, answer }));
    holds(BOUND_STATE, stores.head.value === before, () => ({ name, wrote: true }));
  }
  // The real one, on stores it did not come from: an independent copy of them, and the same stores behind a new object.
  const elsewhere = copyOfStores(stores);
  const elsewhereHead = elsewhere.head.value;
  const onCopy = await module.runCommand(elsewhere, genuine, { actor: owner, event: startEvent, now });
  holds(BOUND_STATE, JSON.stringify(onCopy) === JSON.stringify({ ok: false, refusal: "not-a-folded-case", at: null }) && elsewhere.head.value === elsewhereHead, () => onCopy);
  const onWrapper = await module.runCommand({ ...stores }, genuine, { actor: owner, event: startEvent, now });
  holds(BOUND_STATE, JSON.stringify(onWrapper) === JSON.stringify({ ok: false, refusal: "not-a-folded-case", at: null }), () => onWrapper);
  // No stores and no case are no match for each other.
  const nothing = await module.runCommand(undefined as never, {} as never, { actor: owner, event: startEvent, now }).catch((error: unknown) => ({ threw: String(error) }));
  holds(BOUND_STATE, JSON.stringify(nothing) === JSON.stringify({ ok: false, refusal: "not-a-folded-case", at: null }), () => nothing);

  // Across two logs at genesis, one case's empty object is refused on the other's stores, so that log stays its own.
  const first = memoryStores();
  const second = memoryStores();
  await createLog(first);
  await createLog(second);
  await storeRawObjects(second);
  const emptyFirst = await module.openCase(first, CASE_A);
  holds(BOUND_STATE, emptyFirst.ok, () => emptyFirst);
  const crossed = await module.runCommand(second, (emptyFirst as Extract<production.OpenCaseResult, { ok: true }>).case, { actor: owner, event: PLANNED[0].event, now });
  holds(BOUND_STATE, JSON.stringify(crossed) === JSON.stringify({ ok: false, refusal: "not-a-folded-case", at: null }), () => crossed);
  const secondOpens = await module.openCase(second, CASE_B);
  holds(BOUND_STATE, secondOpens.ok && secondOpens.case.state === null && secondOpens.case.caseId === CASE_B, () => secondOpens);
  // A case opened on an empty log is frozen too, though it holds nothing yet.
  holds(BOUND_STATE, Object.isFrozen((emptyFirst as Extract<production.OpenCaseResult, { ok: true }>).case), () => emptyFirst);

  // The real one still works, and the log still opens: none of that left an entry no fold could apply.
  const real = await module.runCommand(stores, genuine, { actor: owner, event: startEvent, now });
  holds(BOUND_STATE, real.ok, () => real);
  const reopened = await module.openCase(stores, CASE_A);
  holds(BOUND_STATE, reopened.ok, () => reopened);
  // An older case this isolate did fold is still its own: it stands at its own head, and the log's conflict stops it.
  const stale = await module.runCommand(stores, older, { actor: owner, event: logEvent("exception-recorded", { slot: "B1", reason: "Because." }), now });
  holds(BOUND_STATE, !stale.ok && stale.refusal === "conflict", () => stale);
  // Everything a command returns or a reopen gives is frozen all the way down, so the state cannot be edited in place.
  if (real.ok && reopened.ok) {
    for (const made of [real.case, reopened.case]) {
      const state = made.state as NonNullable<OpenCase["state"]>;
      for (const part of [made, state, state.machine, state.machine.attempts, state.machine.attempts[0], state.machine.attempts[0].evidence, state.record, state.record.rows, state.configurations, state.configurations[0], state.configurations[0].instruments]) {
        holds(BOUND_STATE, Object.isFrozen(part), () => part);
      }
    }
  }
};

test("a command takes only a case this isolate folded, so an old or edited state cannot break the log", async () => {
  const { owner } = await fresh();
  await checkFoldedCaseOnly(production, owner);
  await assertCaughtBy("any object taken as a case", BOUND_STATE, () => checkFoldedCaseOnly(variant({ find: 'if (!isFoldedCase(opened, stores))\n        return { ok: false, refusal: "not-a-folded-case", at: null };', replace: "" }), owner));
  await assertCaughtBy("a registered case taken on any stores", BOUND_STATE, () => checkFoldedCaseOnly(variant({ find: "return registered !== undefined && registered === stores;", replace: "return registered !== undefined;" }), owner));
  await assertCaughtBy("no stores and no registration taken as the same", BOUND_STATE, () => checkFoldedCaseOnly(variant({ find: "return registered !== undefined && registered === stores;", replace: "return registered === stores;" }), owner));
  await assertCaughtBy("nothing frozen", BOUND_STATE, () => checkFoldedCaseOnly(variant({ find: "deepFreeze(opened);\n    foldedCases.set", replace: "foldedCases.set" }), owner));
  await assertCaughtBy("a case opened on an empty log not frozen", BOUND_STATE, () => checkFoldedCaseOnly(variant({ find: "deepFreeze(opened);\n    foldedCases.set", replace: "if (opened.seq > 0)\n        deepFreeze(opened);\n    foldedCases.set" }), owner));
  await assertCaughtBy("only the top frozen", BOUND_STATE, () => checkFoldedCaseOnly(variant({ find: "for (const inner of Object.values(value))\n            deepFreeze(inner);", replace: "" }), owner));
  await assertCaughtBy("what a reopen gives not registered", BOUND_STATE, () => checkFoldedCaseOnly(variant({ find: "return { ok: true, case: foldedCase({ caseId, head: opened.log.head, seq, state }, stores) };", replace: "return { ok: true, case: { caseId, head: opened.log.head, seq, state } };" }), owner));
  await assertCaughtBy("what a command gives not registered", BOUND_STATE, () => checkFoldedCaseOnly(variant({ find: "case: foldedCase({ caseId: opened.caseId, head: appended.digest, seq: appended.entry.seq, state: checked.state }, stores) };", replace: "case: { caseId: opened.caseId, head: appended.digest, seq: appended.entry.seq, state: checked.state } };" }), owner));

  // A case of another isolate is no case here. A second load of the module stands in for one, which is why a Durable Object folds its own.
  const otherIsolate = variant({ find: "const foldedCases = new WeakMap();", replace: "const foldedCases = new WeakMap(); " });
  const stores = memoryStores();
  const theirs = await caseFor(otherIsolate, stores, owner, FROZEN);
  assert.deepEqual(await runCommand(stores, theirs, { actor: owner, event: CASE_SCRIPT[1].event, now: risingClock(startAt + 50_000) }), { ok: false, refusal: "not-a-folded-case", at: null });
});

const FOLD_SEQUENCE = "what a record keeps of when is the sequence of the entry that said it";

const checkAtSeq = async (module: StoreModule, owner: Actor) => {
  const stores = memoryStores();
  const held = await caseFor(module, stores, owner, withClaims(owned("interpretation-recorded", { id: "reading-one", statement: "Words.", cites: [{ fact: "fact-held", version: 1 }] }), owned("assertion-recorded", { id: "said-one", statement: "Said." })));
  // Plan, frozen, control, start, began, row, fact, reading, assertion: nine entries, so the next is 10.
  holds(FOLD_SEQUENCE, held.seq === 9, () => held.seq);
  const now = risingClock(startAt + 50_000);
  const superseded = await module.runCommand(stores, held, { actor: owner, event: logEvent("fact-superseded", { fact: "fact-held", statement: "New words.", reason: "Because." }), now });
  holds(FOLD_SEQUENCE, superseded.ok, () => superseded);
  if (!superseded.ok) return;
  const state1 = superseded.case.state as NonNullable<OpenCase["state"]>;
  holds(FOLD_SEQUENCE, state1.record.facts[0].history[0].atSeq === 10 && state1.record.interpretations[0].flags[0].atSeq === 10, () => state1.record);
  const retracted = await module.runCommand(stores, superseded.case, { actor: owner, event: logEvent("fact-retracted", { fact: "fact-held", reason: "Because.", unknown: null }), now });
  holds(FOLD_SEQUENCE, retracted.ok, () => retracted);
  if (!retracted.ok) return;
  const state2 = retracted.case.state as NonNullable<OpenCase["state"]>;
  holds(FOLD_SEQUENCE, state2.record.facts[0].retraction?.atSeq === 11 && state2.record.interpretations[0].flags[1].atSeq === 11, () => state2.record);
  const assertion = await module.runCommand(stores, retracted.case, { actor: owner, event: logEvent("assertion-retracted", { assertion: "said-one", reason: "Because.", unknown: unknownOf("question-one") }), now });
  holds(FOLD_SEQUENCE, assertion.ok, () => assertion);
  if (!assertion.ok) return;
  holds(FOLD_SEQUENCE, (assertion.case.state as NonNullable<OpenCase["state"]>).record.assertions[0].retraction?.atSeq === 12, () => assertion.case.state);
  // A reopen finds the same sequences, since it folds what was written.
  const reopened = await module.openCase(stores, CASE_A);
  holds(FOLD_SEQUENCE, reopened.ok && JSON.stringify(reopened.case.state) === JSON.stringify(assertion.case.state), () => reopened);
};

test("record events carry the sequence the log gave their entry, through a command and a reopen", async () => {
  const { owner } = await fresh();
  await checkAtSeq(production, owner);
  await assertCaughtBy("a fold that gives every event sequence 0", FOLD_SEQUENCE, () => checkAtSeq(variant({ find: "const applied = applyEvent(state, decoded.event, machineActorOf(entry.actor), entry.seq);", replace: "const applied = applyEvent(state, decoded.event, machineActorOf(entry.actor), entry.seq * 0);" }), owner));
  await assertCaughtBy("a command checked at the wrong sequence", FOLD_SEQUENCE, () => checkAtSeq(variant({ find: "evidence, seq: opened.seq + 1 });", replace: "evidence, seq: opened.seq });" }), owner));
});

const ONE_VALUE = "what is checked and what is written are one value, whatever the caller's object does next";

const checkOneValue = async (module: StoreModule, owner: Actor) => {
  const stores = memoryStores();
  const held = await caseFor(module, stores, owner, PLANNED);
  let reads = 0;
  const shifting = {
    type: "plan-frozen",
    get data() {
      reads += 1;
      return { planDigest: reads === 1 ? PLAN_DIGEST : digestOfRaw("raw-patch") };
    }
  } as LogEvent;
  const answer = await module.runCommand(stores, held, { actor: owner, event: shifting, now: risingClock(startAt + 50_000) });
  holds(ONE_VALUE, answer.ok && answer.case.state?.machine.planDigest === PLAN_DIGEST, () => answer);
  const reopened = await module.openCase(stores, CASE_A);
  holds(ONE_VALUE, reopened.ok && reopened.case.state?.machine.planDigest === PLAN_DIGEST, () => reopened);
  // Read once, for the bytes, and never again.
  holds(ONE_VALUE, reads === 1, () => reads);
};

test("a getter on a command is read once, and what it first said is what is checked and written", async () => {
  const { owner } = await fresh();
  await checkOneValue(production, owner);
  await assertCaughtBy("the caller's object written", ONE_VALUE, () => checkOneValue(variant({ find: "events: [own], evidence, expectedHead: opened.head, now });", replace: "events: [event], evidence, expectedHead: opened.head, now });" }), owner));
  await assertCaughtBy("the caller's object checked", ONE_VALUE, () => checkOneValue(variant({ find: "const decoded = (0, case_events_1.decodeEvent)(own);\n    if (!decoded.ok)\n        return decoded;\n    const evidence = (0, case_events_1.digestsNamed)(decoded.event);\n    const checked = foldEntry(opened.state, { actor, events: [own],", replace: "const decoded = (0, case_events_1.decodeEvent)(event);\n    if (!decoded.ok)\n        return decoded;\n    const evidence = (0, case_events_1.digestsNamed)(decoded.event);\n    const checked = foldEntry(opened.state, { actor, events: [event]," }), owner));
});

const STAYS_EXPLORATORY = "once exploratory, a case stays so through the store: a configuration change, a purge, a close and a reopen";

const checkStaysExploratory = async (module: StoreModule, owner: Actor) => {
  const stores = memoryStores();
  const actorOf = actorsFor(owner);
  const held = await caseFor(module, stores, owner, [...FROZEN, owned("exception-recorded", { slot: "B1", reason: "Because." }), owned("configuration-changed", { configuration: IDENTITY_BIRCH as never })]);
  const after = async (label: string, opened: OpenCase) => {
    holds(STAYS_EXPLORATORY, opened.state?.machine.exploratory === true, () => ({ label, state: opened.state?.machine }));
    const again = await module.openCase(stores, CASE_A);
    holds(STAYS_EXPLORATORY, again.ok && again.case.state?.machine.exploratory === true, () => ({ label, again }));
  };
  await after("a configuration change after the exception", held);
  const now = risingClock(startAt + 50_000);
  const go = async (opened: OpenCase, command: ScriptCommand): Promise<OpenCase> => {
    const answer = await module.runCommand(stores, opened, { actor: actorOf(command.as), event: command.event, now });
    holds(STAYS_EXPLORATORY, answer.ok, () => ({ command, answer }));
    return (answer as Extract<typeof answer, { ok: true }>).case;
  };
  await after("the close", await go(held, owned("case-cancelled")));
  // Nothing was captured there, so a manifest has nothing to list. This one has a row, and each purge event is folded by the module under test.
  const withRow = memoryStores();
  const rowHeld = await caseFor(module, withRow, owner, [...FROZEN, owned("exception-recorded", { slot: "B1", reason: "Because." }), start("B1"), began("B1"), rowEvent("row-held"), owned("case-cancelled"), MANIFEST, owned("purge-path-absent", { path: RAW_ONE }), owned("purge-path-remains", { path: RAW_ONE })]);
  holds(STAYS_EXPLORATORY, rowHeld.state?.machine.exploratory === true && rowHeld.state.machine.purge?.length === 1, () => rowHeld.state);
};

test("the exploratory mark survives a configuration change after the exception, and purge events, through the store", async () => {
  const { owner } = await fresh();
  await checkStaysExploratory(production, owner);
  await assertCaughtBy("a configuration change clearing the mark", STAYS_EXPLORATORY, () =>
    checkStaysExploratory(
      variant({ find: "return stepped(state, { type: event.type, configuration: (0, case_events_1.configurationKey)(event.configuration), by }, state.record, [...state.configurations, event.configuration]);", replace: "{\n                const changed = stepped(state, { type: event.type, configuration: (0, case_events_1.configurationKey)(event.configuration), by }, state.record, [...state.configurations, event.configuration]);\n                return changed.ok ? { ok: true, state: Object.assign(Object.assign({}, changed.state), { machine: Object.assign(Object.assign({}, changed.state.machine), { exploratory: false }) }) } : changed;\n            }" }),
      owner
    )
  );
  await assertCaughtBy("a purge clearing the mark", STAYS_EXPLORATORY, () =>
    checkStaysExploratory(
      variant({ find: "default:\n            return stepped(state, Object.assign(Object.assign({}, event), { by }));", replace: "default: {\n                const moved = stepped(state, Object.assign(Object.assign({}, event), { by }));\n                return moved.ok ? { ok: true, state: Object.assign(Object.assign({}, moved.state), { machine: Object.assign(Object.assign({}, moved.state.machine), { exploratory: false }) }) } : moved;\n            }" }),
      owner
    )
  );
});

const MANIFEST_RULE = "a manifest lists exactly the raw bytes the log's rows name, and nothing is named after it";

const checkManifestRule = async (module: StoreModule, owner: Actor) => {
  const stores = memoryStores();
  const closed = await caseFor(module, stores, owner, CASE_SCRIPT);
  const unlisted = copyOfStores(stores);
  const now = risingClock(startAt + 90_000);
  const everyCapture = CAPTURE_LABELS.map((label) => digestOfRaw(label));
  const manifest = (paths: readonly string[]) => module.runCommand(stores, closed, { actor: owner, event: logEvent("purge-manifest-recorded", { paths: [...paths] }), now });
  const wrong: readonly (readonly [string, readonly string[]])[] = [
    ["nothing", []],
    ["one fewer", everyCapture.slice(1)],
    ["one more that is stored and no row's", [...everyCapture, digestOfRaw("raw-patch")]],
    ["the frozen plan in place of a capture", [...everyCapture.slice(1), PLAN_DIGEST]],
    ["the fixture in place of a capture", [...everyCapture.slice(1), digestOfRaw("raw-fixture")]],
    ["the criterion in place of a capture", [...everyCapture.slice(1), digestOfRaw("raw-criterion")]],
    ["the patch in place of a capture", [...everyCapture.slice(1), digestOfRaw("raw-patch")]],
    ["a path nothing holds", [...everyCapture.slice(1), "7e".repeat(32)]]
  ];
  for (const [name, paths] of wrong) {
    const answer = await manifest(paths);
    holds(MANIFEST_RULE, JSON.stringify(answer) === JSON.stringify({ ok: false, refusal: "manifest-not-the-evidence", at: "paths" }), () => ({ name, answer }));
  }
  // In any order, the set is the set.
  const listed = await manifest([...everyCapture].reverse());
  holds(MANIFEST_RULE, listed.ok, () => listed);
  if (!listed.ok) return;
  const held = (listed.case.state as NonNullable<OpenCase["state"]>).machine.purge as NonNullable<NonNullable<OpenCase["state"]>["machine"]["purge"]>;
  holds(MANIFEST_RULE, JSON.stringify(held.map(({ path }) => path).sort()) === JSON.stringify([...everyCapture].sort()), () => held);

  // What the log holds of a manifest is what the fold checks too, past the command.
  const second = await module.runCommand(stores, listed.case, { actor: owner, event: logEvent("purge-manifest-recorded", { paths: everyCapture.slice(1) }), now });
  holds(MANIFEST_RULE, !second.ok && second.refusal === "manifest-already-recorded", () => second);
  // A row after the manifest would hold bytes it does not list. Refused, with the machine's own refusals still first.
  const late = logEvent("evidence-recorded", { row: { id: "row-after-list", slot: "I1", instrument: "coverage", state: "present", window: { clock: "page", startMs: 1, endMs: 2 }, limits: [], digest: digestOfRaw("raw-plan"), observation: null } });
  const afterList = await module.runCommand(stores, listed.case, { actor: actorsFor(owner)("I1"), event: late, now });
  holds(MANIFEST_RULE, JSON.stringify(afterList) === JSON.stringify({ ok: false, refusal: "evidence-after-manifest", at: "row" }), () => afterList);
  const duplicate = logEvent("evidence-recorded", { row: { id: "row-i1-coverage", slot: "I1", instrument: "coverage", state: "no_record", window: { clock: null, note: "none" }, limits: [], digest: null, observation: null } });
  const again = await module.runCommand(stores, listed.case, { actor: actorsFor(owner)("I1"), event: duplicate, now });
  holds(MANIFEST_RULE, !again.ok && again.refusal === "evidence-duplicate", () => again);
  // Before the manifest, a late row on the closed case is kept, and then it must be listed.
  const onUnlisted = await module.openCase(unlisted, CASE_A);
  holds(MANIFEST_RULE, onUnlisted.ok, () => onUnlisted);
  const lateBytes = await putEvidence(unlisted, new TextEncoder().encode("a row's bytes that arrived after the close"));
  holds(MANIFEST_RULE, lateBytes.ok, () => lateBytes);
  const lateDigest = (lateBytes as Extract<typeof lateBytes, { ok: true }>).digest;
  const lateRow = logEvent("evidence-recorded", { row: { id: "row-after-close", slot: "I1", instrument: "coverage", state: "present", window: { clock: "page", startMs: 1, endMs: 2 }, limits: [], digest: lateDigest, observation: null } });
  const lateFirst = await module.runCommand(unlisted, (onUnlisted as Extract<production.OpenCaseResult, { ok: true }>).case, { actor: actorsFor(owner)("I1"), event: lateRow, now });
  holds(MANIFEST_RULE, lateFirst.ok, () => lateFirst);
  if (!lateFirst.ok) return;
  const withoutIt = await module.runCommand(unlisted, lateFirst.case, { actor: owner, event: logEvent("purge-manifest-recorded", { paths: everyCapture }), now });
  holds(MANIFEST_RULE, !withoutIt.ok && withoutIt.refusal === "manifest-not-the-evidence", () => withoutIt);
  const withIt = await module.runCommand(unlisted, lateFirst.case, { actor: owner, event: logEvent("purge-manifest-recorded", { paths: [...everyCapture, lateDigest] }), now });
  holds(MANIFEST_RULE, withIt.ok, () => withIt);

  // Two rows sharing one object's bytes are accepted, and that object is one path.
  const shared = memoryStores();
  const sharing = await caseFor(module, shared, owner, [...WITH_ROW, rowEvent("row-sharing"), owned("case-cancelled")]);
  holds(MANIFEST_RULE, (sharing.state as NonNullable<OpenCase["state"]>).record.rows.length === 2, () => sharing.state);
  const onePath = await module.runCommand(shared, sharing, { actor: owner, event: MANIFEST.event, now });
  holds(MANIFEST_RULE, onePath.ok && onePath.case.state?.machine.purge?.length === 1, () => onePath);

  // A case no attempt ever began in has exactly nothing to list, and an empty manifest says so, speaking only to what the log names.
  const bare = memoryStores();
  const noVisit = await caseFor(module, bare, owner, [...FROZEN, owned("case-cancelled")]);
  holds(MANIFEST_RULE, retentionOf((noVisit.state as NonNullable<OpenCase["state"]>).machine) === "RAW_HELD", () => noVisit.state);
  const notEmpty = await module.runCommand(bare, noVisit, { actor: owner, event: MANIFEST.event, now });
  holds(MANIFEST_RULE, !notEmpty.ok && notEmpty.refusal === "manifest-not-the-evidence", () => notEmpty);
  const emptied = await module.runCommand(bare, noVisit, { actor: owner, event: logEvent("purge-manifest-recorded", { paths: [] }), now });
  holds(MANIFEST_RULE, emptied.ok && retentionOf((emptied.case.state as NonNullable<OpenCase["state"]>).machine) === "SUMMARY_ONLY", () => emptied);
  if (!emptied.ok) return;
  const reopened = await module.openCase(bare, CASE_A);
  holds(MANIFEST_RULE, reopened.ok && JSON.stringify(reopened.case.state) === JSON.stringify(emptied.case.state), () => reopened);
  // It is a manifest like any other: there is no second, and nothing is named after it.
  const secondEmpty = await module.runCommand(bare, emptied.case, { actor: owner, event: logEvent("purge-manifest-recorded", { paths: [] }), now });
  holds(MANIFEST_RULE, !secondEmpty.ok && secondEmpty.refusal === "manifest-already-recorded", () => secondEmpty);

  // Once an attempt began, an empty set is not nothing held: a visit can upload ahead of its row. However it came to be empty, the tier stays RAW_HELD.
  const begunEmpties: readonly (readonly [string, readonly ScriptCommand[]])[] = [
    ["a visit that named nothing, cancelled", [...CAPTURING, owned("case-cancelled")]],
    ["a visit with only a row of no bytes", [...CAPTURING, rowEvent("row-nothing", "coverage", "no_record"), owned("case-cancelled")]],
    ["a visit that ended, then a close", [...B1_DONE, owned("case-cancelled")]],
    ["a visit whose only row names what the case keeps", [...CAPTURING, { as: "B1", event: logEvent("evidence-recorded", { row: { ...rowOn("row-fixture"), digest: digestOfRaw("raw-fixture") } as never }) }, owned("case-cancelled")]]
  ];
  for (const [name, commands] of begunEmpties) {
    const stores = memoryStores();
    const begun = await caseFor(module, stores, owner, commands);
    const refused = await module.runCommand(stores, begun, { actor: owner, event: logEvent("purge-manifest-recorded", { paths: [] }), now });
    holds(MANIFEST_RULE, JSON.stringify(refused) === JSON.stringify({ ok: false, refusal: "manifest-empty-after-a-visit", at: "paths" }), () => ({ name, refused }));
    holds(MANIFEST_RULE, retentionOf((begun.state as NonNullable<OpenCase["state"]>).machine) === "RAW_HELD", () => ({ name, begun }));
  }
  // Every attempt having run, with no row at all.
  const finished = memoryStores();
  const completed = await caseFor(module, finished, owner, [owned("case-planned", { slots: [{ slot: "B1", attemptId: ATTEMPT_IDS.B1 }], configuration: IDENTITY_ALDER as never }), CASE_SCRIPT[1], met(), start("B1"), began("B1"), ...ended("B1")]);
  holds(MANIFEST_RULE, (completed.state as NonNullable<OpenCase["state"]>).machine.closedBy === "completed", () => completed.state);
  const onCompleted = await module.runCommand(finished, completed, { actor: owner, event: logEvent("purge-manifest-recorded", { paths: [] }), now });
  holds(MANIFEST_RULE, !onCompleted.ok && onCompleted.refusal === "manifest-empty-after-a-visit", () => onCompleted);
};

test("a manifest is exactly the raw evidence the log names, and evidence after one is refused", async () => {
  const { owner } = await fresh();
  await checkManifestRule(production, owner);
  await assertCaughtBy("any manifest taken", MANIFEST_RULE, () => checkManifestRule(variant({ find: 'if (!isSameSet(event.paths, purgeSetOf(state)))\n                return refused("manifest-not-the-evidence", "paths");', replace: "" }), owner));
  await assertCaughtBy("an empty manifest taken after a visit", MANIFEST_RULE, () => checkManifestRule(variant({ find: 'return event.paths.length === 0 && begun ? refused("manifest-empty-after-a-visit", "paths") : result;', replace: "return result;" }), owner));
  await assertCaughtBy("an empty manifest refused however the case went", MANIFEST_RULE, () => checkManifestRule(variant({ find: 'return event.paths.length === 0 && begun ?', replace: "return event.paths.length === 0 ?" }), owner));
  await assertCaughtBy("a visit counted as begun only while its attempt ended well", MANIFEST_RULE, () => checkManifestRule(variant({ find: 'const begun = state.machine.attempts.some(({ phase }) => phase !== "not_started");', replace: 'const begun = state.machine.attempts.some(({ phase }) => phase === "usable");' }), owner));
  await assertCaughtBy("a manifest needing only to cover the evidence", MANIFEST_RULE, () => checkManifestRule(variant({ find: "return paths.length === digests.size && paths.every((path) => digests.has(path));", replace: "return [...digests].every((digest) => paths.includes(digest));" }), owner));
  await assertCaughtBy("a manifest needing only to be evidence", MANIFEST_RULE, () => checkManifestRule(variant({ find: "return paths.length === digests.size && paths.every((path) => digests.has(path));", replace: "return paths.every((path) => digests.has(path));" }), owner));
  await assertCaughtBy("a manifest of the right size", MANIFEST_RULE, () => checkManifestRule(variant({ find: "return paths.length === digests.size && paths.every((path) => digests.has(path));", replace: "return paths.length === digests.size;" }), owner));
  await assertCaughtBy("evidence after a manifest kept", MANIFEST_RULE, () => checkManifestRule(variant({ find: 'if (state.machine.purge !== null)\n                return refused("evidence-after-manifest", "row");', replace: "" }), owner));
  await assertCaughtBy("a manifest refused when two rows share one object's bytes", MANIFEST_RULE, () => checkManifestRule(variant({ find: "if (!isSameSet(event.paths, purgeSetOf(state)))", replace: "if (!isSameSet(event.paths, purgeSetOf(state)) || state.record.rows.filter(({ digest }) => digest !== null).length !== event.paths.length)" }), owner));
  await assertCaughtBy("the manifest's own check ahead of the machine's", MANIFEST_RULE, () => checkManifestRule(variant({ find: 'const result = stepped(state, Object.assign(Object.assign({}, event), { by }));\n            if (!result.ok)\n                return result;\n            // What a manifest', replace: 'if (!isSameSet(event.paths, purgeSetOf(state)))\n                return refused("manifest-not-the-evidence", "paths");\n            const result = stepped(state, Object.assign(Object.assign({}, event), { by }));\n            if (!result.ok)\n                return result;\n            // What a manifest' }), owner));
});

const KEPT = "a row may name any bytes, a manifest is what rows name less what the case keeps, and a purge leaves what is kept";

const X_ROW = (digest: string, id = "row-named", slot = "B1") => ({ as: slot as ScriptActor, event: logEvent("evidence-recorded", { row: { ...rowOn(id), slot, digest } as never }) });
const OBJECT_X = digestOfRaw("raw-i1-late");
const OBJECT_Y = RAW_ONE;
const OBJECT_Z = digestOfRaw("raw-b2-coverage");
const BIRCH_X_FIXTURE = { ...IDENTITY_BIRCH, fixtureDigest: OBJECT_X };
const BIRCH_X_CRITERION = { ...IDENTITY_BIRCH, criterionDigest: OBJECT_X };
const reconstructing = (patchDigest: string, identity = "9a".repeat(32)) => logEvent("source-reconstructed", { appliesTo: ["B1"], baseCommit: "ca".repeat(20), patchDigest, identity });
const excepted = owned("exception-recorded", { slot: "B1", reason: "Because." });
const missed = (configuration: unknown) => ({ as: "control" as ScriptActor, event: logEvent("control-recorded", { configuration: configuration as never, result: "not_met" }) });
const bothRows = [X_ROW(OBJECT_X), X_ROW(OBJECT_Y, "row-other")];
const onExceptionRows = [...FROZEN, excepted, start("B1"), began("B1"), ...bothRows];
const cancel = owned("case-cancelled");

/**
 * Each way one object can be both: kept first, and then named by a row. Only the owner's events
 * keep, so no control is here. Each ends closed, with X named by a row and kept, and Y named by a
 * row and not kept. The other order is refused, below.
 */
const BOTH_WAYS: readonly (readonly [string, readonly ScriptCommand[]])[] = [
  ["a change's fixture, then a row", [...FROZEN, owned("configuration-changed", { configuration: BIRCH_X_FIXTURE as never }), excepted, start("B1"), began("B1"), ...bothRows, cancel]],
  ["a change's criterion, then a row", [...FROZEN, owned("configuration-changed", { configuration: BIRCH_X_CRITERION as never }), excepted, start("B1"), began("B1"), ...bothRows, cancel]],
  ["a patch, then a late row", [...FROZEN, excepted, start("B1"), began("B1"), X_ROW(OBJECT_Y, "row-other"), ...ended("B1"), owned("source-reconstructed", { appliesTo: ["B1"], baseCommit: "ca".repeat(20), patchDigest: OBJECT_X, identity: "9a".repeat(32) }), X_ROW(OBJECT_X), cancel]],
  ["closed, a patch, then a late row", [...FROZEN, excepted, start("B1"), began("B1"), X_ROW(OBJECT_Y, "row-other"), cancel, owned("source-reconstructed", { appliesTo: ["B1"], baseCommit: "ca".repeat(20), patchDigest: OBJECT_X, identity: "9a".repeat(32) }), X_ROW(OBJECT_X)]]
];

const RAW_STAYS = "a digest a row named as raw is never kept afterwards, so nothing takes it out of the purge set, and what was kept first stays kept";

type RawCase = Readonly<{ name: string; refused: boolean; commands: readonly ScriptCommand[]; as: ScriptActor; event: LogEvent; at: string; purge: readonly string[]; wrong: readonly string[] }>;

const rowsThenEnded = [...onExceptionRows, ...ended("B1"), clean("B1")];
const FIXTURE = digestOfRaw("raw-fixture");
/** A row names the plan's own fixture: kept first, then named by a row, as the fixture run does. */
const fixtureRow = [...FROZEN, excepted, start("B1"), began("B1"), X_ROW(FIXTURE, "row-fixture"), X_ROW(OBJECT_Y, "row-other"), ...ended("B1"), clean("B1")];
/** A missed control under another identity, before any row. */
const missedFirst = (configuration: unknown) => [...FROZEN, missed(configuration), excepted, start("B1"), began("B1"), X_ROW(OBJECT_Y, "row-other")];

/**
 * Each way an event could start keeping X after a row named it, each way a control could, and each
 * way of naming again what the case kept first. The purge set is what a manifest must list after
 * that event, and a manifest of the wrong set is refused.
 */
const RAW_CASES: readonly RawCase[] = [
  { name: "a patch, after a row", refused: true, commands: [...onExceptionRows, ...ended("B1")], as: "owner", event: reconstructing(OBJECT_X), at: "patchDigest", purge: [OBJECT_X, OBJECT_Y], wrong: [OBJECT_Y] },
  { name: "a patch on a closed case, after a row", refused: true, commands: [...onExceptionRows, cancel], as: "owner", event: reconstructing(OBJECT_X), at: "patchDigest", purge: [OBJECT_X, OBJECT_Y], wrong: [OBJECT_Y] },
  { name: "a change's fixture, after a row", refused: true, commands: rowsThenEnded, as: "owner", event: logEvent("configuration-changed", { configuration: BIRCH_X_FIXTURE as never }), at: "configuration", purge: [OBJECT_X, OBJECT_Y], wrong: [OBJECT_Y] },
  { name: "a change's criterion, after a row", refused: true, commands: rowsThenEnded, as: "owner", event: logEvent("configuration-changed", { configuration: BIRCH_X_CRITERION as never }), at: "configuration", purge: [OBJECT_X, OBJECT_Y], wrong: [OBJECT_Y] },
  // A control keeps nothing, so it is taken, and X stays raw.
  { name: "a missed control's fixture, after a row", refused: false, commands: rowsThenEnded, as: "control", event: missed(BIRCH_X_FIXTURE).event, at: "", purge: [OBJECT_X, OBJECT_Y], wrong: [OBJECT_Y] },
  { name: "a missed control's criterion, after a row", refused: false, commands: rowsThenEnded, as: "control", event: missed(BIRCH_X_CRITERION).event, at: "", purge: [OBJECT_X, OBJECT_Y], wrong: [OBJECT_Y] },
  { name: "a missed control naming X as its fixture under another identity, then a row naming X", refused: false, commands: missedFirst(BIRCH_X_FIXTURE), as: "B1", event: X_ROW(OBJECT_X).event, at: "", purge: [OBJECT_X, OBJECT_Y], wrong: [OBJECT_Y] },
  { name: "a missed control naming X as its criterion under another identity, then a row naming X", refused: false, commands: missedFirst(BIRCH_X_CRITERION), as: "B1", event: X_ROW(OBJECT_X).event, at: "", purge: [OBJECT_X, OBJECT_Y], wrong: [OBJECT_Y] },
  // What the plan kept stays kept, whatever a control names.
  { name: "a control under the configuration in force, then a row naming its fixture", refused: false, commands: [...FROZEN, met(), start("B1"), began("B1"), X_ROW(OBJECT_Y, "row-other")], as: "B1", event: X_ROW(FIXTURE, "row-fixture").event, at: "", purge: [OBJECT_Y], wrong: [FIXTURE, OBJECT_Y] },
  { name: "a control for the identity the plan recorded, after a row named its fixture", refused: false, commands: fixtureRow, as: "control", event: met().event, at: "", purge: [OBJECT_Y], wrong: [FIXTURE, OBJECT_Y] },
  { name: "a change that keeps the same fixture and criterion, after a row named the fixture", refused: false, commands: fixtureRow, as: "owner", event: logEvent("configuration-changed", { configuration: IDENTITY_BIRCH as never }), at: "", purge: [OBJECT_Y], wrong: [FIXTURE, OBJECT_Y] },
  { name: "a patch of the kept fixture's bytes, after a row named them", refused: false, commands: fixtureRow, as: "owner", event: reconstructing(FIXTURE), at: "", purge: [OBJECT_Y], wrong: [FIXTURE, OBJECT_Y] }
];

/**
 * A refused case answers with the new refusal, and an accepted one is taken. Either way the purge
 * set is then the one written, so the wrong manifest is refused and that one is taken. Each
 * kept-first way of being both is checked in full under KEPT, with the fixture run.
 */
const checkRawStaysRaw = async (module: StoreModule, owner: Actor, only?: string) => {
  const now = risingClock(startAt + 90_000);
  const notTheEvidence = JSON.stringify({ ok: false, refusal: "manifest-not-the-evidence", at: "paths" });
  for (const { name, refused, commands, as, event, at, purge, wrong } of RAW_CASES.filter((entry) => only === undefined || entry.name === only)) {
    const stores = memoryStores();
    const answerOn = (current: OpenCase, next: LogEvent, by: ScriptActor = "owner") => module.runCommand(stores, current, { actor: actorsFor(owner)(by), event: next, now });
    const current = await caseFor(module, stores, owner, commands);
    const answer = await answerOn(current, event, as);
    holds(RAW_STAYS, refused ? JSON.stringify(answer) === JSON.stringify({ ok: false, refusal: "raw-object-cannot-be-kept", at }) : answer.ok, () => ({ name, answer }));
    const after = refused || !answer.ok ? current : answer.case;
    const closed = commands.includes(cancel) ? { ok: true as const, case: after } : await answerOn(after, cancel.event);
    holds(RAW_STAYS, closed.ok, () => ({ name, closed }));
    if (!closed.ok) continue;
    holds(RAW_STAYS, JSON.stringify(await answerOn(closed.case, logEvent("purge-manifest-recorded", { paths: [...wrong] }))) === notTheEvidence, () => ({ name, wrong }));
    const listed = await answerOn(closed.case, logEvent("purge-manifest-recorded", { paths: [...purge] }));
    holds(RAW_STAYS, listed.ok, () => ({ name, listed }));
  }
};

const byName = (...names: string[]) => (entry: RawCase) => names.includes(entry.name);
const KEEP_LINE = "return { ok: true, state: Object.assign(Object.assign({}, after), { keptObjects: [...new Set([...after.keptObjects, ...named])] }) };";

test("a raw capture cannot be moved out of the purge by keeping it afterwards, by any route, a control keeps nothing, and kept-first stays allowed", async () => {
  const { owner } = await fresh();
  await checkRawStaysRaw(production, owner);
  const edited = (find: string, replace: string, only?: string) => () => checkRawStaysRaw(variant({ find, replace }), owner, only);
  const GUARD = 'if (named.some((digest) => raw.has(digest)))\n            return refused("raw-object-cannot-be-kept", keptField(event));';
  const CONTROL = 'if (event.type === "control-recorded")\n        return { ok: true, state: after };';
  // The reversal's behavior, each owner's route on its own: it was accepted.
  for (const { name } of RAW_CASES.filter(({ refused }) => refused)) await assertCaughtBy(`${name}, kept as the reversal left it`, RAW_STAYS, edited(GUARD, "", name));
  // The behavior before this rule, each control case on its own: a control kept what it named, so one after a row was refused, and one before it kept X.
  for (const { name } of RAW_CASES.filter(byName("a missed control's fixture, after a row", "a missed control's criterion, after a row", "a missed control naming X as its fixture under another identity, then a row naming X", "a missed control naming X as its criterion under another identity, then a row naming X"))) {
    await assertCaughtBy(`${name}, with a control keeping what it names`, RAW_STAYS, edited(CONTROL, "", name));
  }
  // The plan is what keeps a control's fixture under the configuration in force.
  await assertCaughtBy("a control under the configuration in force, with the plan keeping nothing", RAW_STAYS, edited(KEEP_LINE, `return { ok: true, state: event.type === "case-planned" ? after : Object.assign(Object.assign({}, after), { keptObjects: [...new Set([...after.keptObjects, ...named])] }) };`, "a control under the configuration in force, then a row naming its fixture"));
  // An over-strict rule, each allowed case on its own: it was refused.
  await assertCaughtBy("a control for the plan's identity, refused when a row named what it names", RAW_STAYS, edited(CONTROL, 'if (event.type === "control-recorded" && before !== null && before.record.rows.some(({ digest }) => digest !== null && named.includes(digest)))\n        return refused("raw-object-cannot-be-kept", "configuration");\n    if (event.type === "control-recorded")\n        return { ok: true, state: after };', "a control for the identity the plan recorded, after a row named its fixture"));
  for (const name of ["a change that keeps the same fixture and criterion, after a row named the fixture", "a patch of the kept fixture's bytes, after a row named them"]) {
    await assertCaughtBy(`${name}, refused when anything a row names counts as raw`, RAW_STAYS, edited("const raw = purgeSetOf(before);", "const raw = new Set(before.record.rows.flatMap(({ digest }) => (digest === null ? [] : [digest])));", name));
  }
  await assertCaughtBy("only a patch checked", RAW_STAYS, edited(GUARD, 'if (event.type === "source-reconstructed" && named.some((digest) => raw.has(digest)))\n            return refused("raw-object-cannot-be-kept", keptField(event));'));
  await assertCaughtBy("only the first object an event names checked", RAW_STAYS, edited("if (named.some((digest) => raw.has(digest)))", "if (named.slice(0, 1).some((digest) => raw.has(digest)))"));
  await assertCaughtBy("every refusal pointed at the configuration", RAW_STAYS, edited('return event.type === "source-reconstructed" ? "patchDigest" : "configuration";', 'return "configuration";'));
});

const checkKept = async (module: StoreModule, owner: Actor) => {
  const now = risingClock(startAt + 90_000);
  const manifest = (paths: readonly string[]) => logEvent("purge-manifest-recorded", { paths: [...paths] });
  const answerOn = (stores: LogStores, current: OpenCase, event: LogEvent, as: ScriptActor = "owner") => module.runCommand(stores, current, { actor: actorsFor(owner)(as), event, now });
  const notTheEvidence = JSON.stringify({ ok: false, refusal: "manifest-not-the-evidence", at: "paths" });

  for (const [name, commands] of BOTH_WAYS) {
    const stores = memoryStores();
    const closed = await caseFor(module, stores, owner, commands);
    const state = closed.state as NonNullable<OpenCase["state"]>;
    holds(KEPT, state.keptObjects.includes(OBJECT_X) && !state.keptObjects.includes(OBJECT_Y), () => ({ name, kept: state.keptObjects }));
    holds(KEPT, state.record.rows.some(({ digest }) => digest === OBJECT_X), () => ({ name, rows: state.record.rows }));
    // A manifest listing the kept object is refused, alone or beside the rest, and one leaving it out is taken.
    for (const paths of [[OBJECT_X, OBJECT_Y], [OBJECT_X], [OBJECT_Y, OBJECT_X]]) {
      const refused = await answerOn(stores, closed, manifest(paths));
      holds(KEPT, JSON.stringify(refused) === notTheEvidence, () => ({ name, paths, refused }));
    }
    const listed = await answerOn(stores, closed, manifest([OBJECT_Y]));
    holds(KEPT, listed.ok, () => ({ name, listed }));
    if (!listed.ok) continue;
    const gone = await answerOn(stores, listed.case, logEvent("purge-path-absent", { path: OBJECT_Y }));
    holds(KEPT, gone.ok && retentionOf((gone.case.state as NonNullable<OpenCase["state"]>).machine) === "SUMMARY_ONLY", () => ({ name, gone }));
    // The kept object is on no list, so nothing a route reads could remove it, and every row is still there.
    holds(KEPT, gone.ok && JSON.stringify((gone.case.state as NonNullable<OpenCase["state"]>).machine.purge) === JSON.stringify([{ path: OBJECT_Y, state: "absent" }]), () => ({ name, gone }));
    holds(KEPT, stores.evidence.objects.has(OBJECT_X), () => name);
    const reopened = await module.openCase(stores, CASE_A);
    holds(KEPT, reopened.ok && gone.ok && JSON.stringify(reopened.case.state) === JSON.stringify(gone.case.state), () => ({ name, reopened }));
  }

  // What the case rests on from the start: a row naming the plan, the fixture or the criterion.
  for (const label of ["raw-plan", "raw-fixture", "raw-criterion"]) {
    const stores = memoryStores();
    const named = digestOfRaw(label);
    const closed = await caseFor(module, stores, owner, [...CAPTURING, X_ROW(named), X_ROW(OBJECT_Y, "row-other"), cancel]);
    const refused = await answerOn(stores, closed, manifest([named, OBJECT_Y]));
    holds(KEPT, JSON.stringify(refused) === notTheEvidence, () => ({ label, refused }));
    const taken = await answerOn(stores, closed, manifest([OBJECT_Y]));
    holds(KEPT, taken.ok, () => ({ label, taken }));
  }

  // A late row's own bytes are raw like any other's, and must be listed.
  const lateOwn = memoryStores();
  const withLateOwn = await caseFor(module, lateOwn, owner, [...CAPTURING, X_ROW(OBJECT_Y, "row-other"), ...ended("B1"), X_ROW(OBJECT_Z, "row-late"), cancel]);
  holds(KEPT, (withLateOwn.state as NonNullable<OpenCase["state"]>).record.rows.at(-1)?.state === "late", () => withLateOwn.state);
  holds(KEPT, JSON.stringify(await answerOn(lateOwn, withLateOwn, manifest([OBJECT_Y]))) === notTheEvidence, () => "a late row's bytes left out");
  holds(KEPT, (await answerOn(lateOwn, withLateOwn, manifest([OBJECT_Y, OBJECT_Z]))).ok, () => "a late row's bytes listed");

  // After a manifest, nothing can start keeping what it listed: a listed path is a raw digest, and a patch is the one event still able to name one there.
  const after = memoryStores();
  const closedAfter = await caseFor(module, after, owner, [...onExceptionRows, X_ROW(OBJECT_Z, "row-third"), cancel]);
  const listedAfter = await answerOn(after, closedAfter, manifest([OBJECT_X, OBJECT_Y, OBJECT_Z]));
  holds(KEPT, listedAfter.ok, () => listedAfter);
  if (!listedAfter.ok) return;
  for (const path of [OBJECT_X, OBJECT_Y, OBJECT_Z]) {
    const answer = await answerOn(after, listedAfter.case, reconstructing(path));
    holds(KEPT, JSON.stringify(answer) === JSON.stringify({ ok: false, refusal: "raw-object-cannot-be-kept", at: "patchDigest" }), () => ({ path, answer }));
  }
  // Whatever a listing later found, a listed path stays raw: one found remaining, one found absent, and one not yet looked at.
  const marked = copyOfStores(after);
  const markedCase = await module.openCase(marked, CASE_A);
  holds(KEPT, markedCase.ok, () => markedCase);
  if (!markedCase.ok) return;
  const remains = await answerOn(marked, markedCase.case, logEvent("purge-path-remains", { path: OBJECT_X }));
  const absent = remains.ok ? await answerOn(marked, remains.case, logEvent("purge-path-absent", { path: OBJECT_Y })) : remains;
  holds(KEPT, absent.ok && JSON.stringify(absent.case.state?.machine.purge?.map(({ state }) => state)) === '["remains","absent","present"]', () => absent);
  if (!absent.ok) return;
  for (const path of [OBJECT_X, OBJECT_Y, OBJECT_Z]) {
    const answer = await answerOn(marked, absent.case, reconstructing(path));
    holds(KEPT, JSON.stringify(answer) === JSON.stringify({ ok: false, refusal: "raw-object-cannot-be-kept", at: "patchDigest" }), () => ({ path, marked: true, answer }));
  }
  // A patch refused for what it is hears that first: this one applies to an attempt that never started.
  const unstarted = logEvent("source-reconstructed", { appliesTo: ["I1"], baseCommit: "ca".repeat(20), patchDigest: OBJECT_X, identity: "9a".repeat(32) });
  holds(KEPT, JSON.stringify(await answerOn(after, listedAfter.case, unstarted)) === JSON.stringify({ ok: false, refusal: "source-attempt-not-ended", at: "appliesTo" }), () => "the machine's refusal first");
  // The rest are refused for the closed case itself, and a row after a manifest by that rule, whatever it names.
  holds(KEPT, JSON.stringify(await answerOn(after, listedAfter.case, logEvent("configuration-changed", { configuration: { ...IDENTITY_BIRCH, fixtureDigest: OBJECT_X } as never }))) === JSON.stringify({ ok: false, refusal: "case-closed", at: null }), () => "a change");
  holds(KEPT, JSON.stringify(await answerOn(after, listedAfter.case, logEvent("control-recorded", { configuration: { ...IDENTITY_BIRCH, fixtureDigest: OBJECT_X } as never, result: "not_met" }), "control")) === JSON.stringify({ ok: false, refusal: "case-closed", at: null }), () => "a control");
  holds(KEPT, JSON.stringify(await answerOn(after, listedAfter.case, logEvent("plan-frozen", { planDigest: OBJECT_X }))) === JSON.stringify({ ok: false, refusal: "case-closed", at: null }), () => "a plan");
  // A patch of something the manifest did not list is still a patch, and is kept.
  const elsewhere = await answerOn(after, listedAfter.case, reconstructing(digestOfRaw("raw-patch")));
  holds(KEPT, elsewhere.ok && elsewhere.case.state?.keptObjects.includes(digestOfRaw("raw-patch")) === true, () => elsewhere);

  // The list itself, for the whole case: each object once, though controls name them over and over.
  const whole = await caseFor(module, memoryStores(), owner, CASE_SCRIPT);
  holds(KEPT, JSON.stringify((whole.state as NonNullable<OpenCase["state"]>).keptObjects) === JSON.stringify([digestOfRaw("raw-fixture"), digestOfRaw("raw-criterion"), PLAN_DIGEST, digestOfRaw("raw-patch")]), () => whole.state);
};

test("one object can be kept and then named as a row's bytes, and a manifest leaves it out", async () => {
  const { owner } = await fresh();
  await checkKept(production, owner);
  const edited = (find: string, replace: string) => () => checkKept(variant({ find, replace }), owner);
  const KEEP = "return { ok: true, state: Object.assign(Object.assign({}, after), { keptObjects: [...new Set([...after.keptObjects, ...named])] }) };";
  await assertCaughtBy("nothing kept after all", KEPT, edited(KEEP, "return { ok: true, state: after };"));
  await assertCaughtBy("a kept object listed each time it is named", KEPT, edited("[...new Set([...after.keptObjects, ...named])]", "[...after.keptObjects, ...named]"));
  await assertCaughtBy("a change's objects not kept", KEPT, edited(KEEP, `return { ok: true, state: event.type === "configuration-changed" ? after : Object.assign(Object.assign({}, after), { keptObjects: [...new Set([...after.keptObjects, ...named])] }) };`));
  await assertCaughtBy("a patch not kept", KEPT, edited(KEEP, `return { ok: true, state: event.type === "source-reconstructed" ? after : Object.assign(Object.assign({}, after), { keptObjects: [...new Set([...after.keptObjects, ...named])] }) };`));
  await assertCaughtBy("a frozen plan not kept", KEPT, edited(KEEP, `return { ok: true, state: event.type === "plan-frozen" ? after : Object.assign(Object.assign({}, after), { keptObjects: [...new Set([...after.keptObjects, ...named])] }) };`));
  await assertCaughtBy("what the first plan names not kept", KEPT, edited(KEEP, `return { ok: true, state: event.type === "case-planned" ? after : Object.assign(Object.assign({}, after), { keptObjects: [...new Set([...after.keptObjects, ...named])] }) };`));
  await assertCaughtBy("nothing kept once a case has closed", KEPT, edited(KEEP, "return { ok: true, state: before !== null && before.machine.closedBy !== null ? after : Object.assign(Object.assign({}, after), { keptObjects: [...new Set([...after.keptObjects, ...named])] }) };"));
  await assertCaughtBy("a row's bytes kept too", KEPT, edited('if (event.type === "evidence-recorded")\n        return { ok: true, state: after };\n    ', ""));
  await assertCaughtBy("a manifest free to list what the case keeps", KEPT, edited("digest === null || keptObjects.includes(digest) ? [] : [digest]", "digest === null ? [] : [digest]"));
  await assertCaughtBy("a late row's bytes left out of the set", KEPT, edited("flatMap(({ digest }) => (digest === null || keptObjects.includes(digest)", 'flatMap(({ digest, state }) => (digest === null || state === "late" || keptObjects.includes(digest)'));
  await assertCaughtBy("a late row naming a kept object still listed", KEPT, edited("flatMap(({ digest }) => (digest === null || keptObjects.includes(digest)", 'flatMap(({ digest, state }) => (digest === null || (state !== "late" && keptObjects.includes(digest))'));
  await assertCaughtBy("a patch free to name what a manifest listed", KEPT, edited('if (named.some((digest) => raw.has(digest)))\n            return refused("raw-object-cannot-be-kept", keptField(event));', ""));
  await assertCaughtBy("only the first listed path looked at", KEPT, edited("const raw = purgeSetOf(before);", "const raw = new Set([...purgeSetOf(before)].slice(0, 1));"));
  await assertCaughtBy("only a listed path still present held raw", KEPT, edited("const raw = purgeSetOf(before);", 'const raw = new Set([...purgeSetOf(before)].filter((digest) => before.machine.purge === null || before.machine.purge.some(({ path, state }) => path === digest && state === "present")));'));
  await assertCaughtBy("a listed path found absent no longer held raw", KEPT, edited("const raw = purgeSetOf(before);", 'const raw = new Set([...purgeSetOf(before)].filter((digest) => before.machine.purge === null || before.machine.purge.some(({ path, state }) => path === digest && state !== "absent")));'));
  await assertCaughtBy("the raw rule heard ahead of the machine's", KEPT, edited("return applied.ok ? withKept(state, decoded.event, named, applied.state) : applied;", "const early = withKept(state, decoded.event, named, applied.ok ? applied.state : state);\n    return !early.ok || applied.ok ? early : applied;"));
  await assertCaughtBy("no patch at all after a manifest", KEPT, edited("if (named.some((digest) => raw.has(digest)))", "if (before.machine.purge !== null || named.some((digest) => raw.has(digest)))"));
});

const FIXTURE_RUN = "a controlled fixture run whose capture is byte for byte its fixture is recorded, read and purged, and the purge keeps the fixture";

const checkFixtureRun = async (module: StoreModule, owner: Actor) => {
  // The page is the fixture, so what the capture stored is those very bytes under that very digest.
  const pageBytes = new TextEncoder().encode("function lantern() { return 1; }");
  const stores = memoryStores();
  await storeRawObjects(stores);
  const fixture = await putEvidence(stores, pageBytes);
  holds(FIXTURE_RUN, fixture.ok, () => fixture);
  const fixtureDigest = (fixture as Extract<typeof fixture, { ok: true }>).digest;
  const identity = { ...IDENTITY_ALDER, fixtureDigest };
  const ids = [ATTEMPT_IDS.B1, ATTEMPT_IDS.I1, CONTROL_RUN_ID];
  const now = risingClock(startAt);
  const made = await module.createCase(stores, { caseId: CASE_A, actor: owner, slots: ["B1", "I1"], configuration: identity, now, mint: () => ids.shift() as string });
  holds(FIXTURE_RUN, made.ok, () => made);
  let current = (made as Extract<typeof made, { ok: true }>).case;
  const go = async (as: ScriptActor, event: LogEvent) => {
    const answer = await module.runCommand(stores, current, { actor: actorsFor(owner)(as), event, now });
    holds(FIXTURE_RUN, answer.ok, () => ({ event, answer }));
    current = (answer as Extract<typeof answer, { ok: true }>).case;
  };
  await go("owner", CASE_SCRIPT[1].event);
  await go("control", logEvent("control-recorded", { configuration: identity as never, result: "met" }));
  await go("owner", start("B1").event);
  await go("B1", began("B1").event);
  // The capture stores what it read, which is the fixture, and that is accepted as itself.
  const captured = await putEvidence(stores, pageBytes);
  holds(FIXTURE_RUN, captured.ok && (captured as Extract<typeof captured, { ok: true }>).digest === fixtureDigest, () => captured);
  const observed = { subject: "subject-lantern", count: 3, granularity: "block", windowEnd: "window_closed", scope: "in_scope" };
  await go("B1", logEvent("evidence-recorded", { row: { ...rowOn("row-page"), digest: fixtureDigest, observation: observed } as never }));
  await go("B1", logEvent("evidence-recorded", { row: { ...rowOn("row-network"), digest: OBJECT_Y } as never }));
  await go("B1", logEvent("instrument-recorded", { slot: "B1", instrument: "coverage", completeness: "complete", reason: null }));
  await go("B1", logEvent("capture-finished", { slot: "B1" }));
  await go("B1", logEvent("attempt-finished", { slot: "B1", outcome: "usable", reason: null }));
  await go("owner", clean("B1").event);
  const state = () => current.state as NonNullable<OpenCase["state"]>;
  // It reads as what it is, and a fact can rest on it.
  const pageReading = readRow(state().record, state().machine, state().record.rows[0]);
  holds(FIXTURE_RUN, JSON.stringify(pageReading) === JSON.stringify({ reading: "observed", count: 3, granularity: "block", windowEnd: "window_closed", complete: true, limits: [] }), () => pageReading);
  await go("owner", logEvent("fact-recorded", { id: "fact-page", statement: "The routine ran in this window.", evidence: ["row-page"] }));
  await go("owner", cancel.event);
  // The purge lists only the other capture. The fixture is on no list, however it is asked for.
  const refused = await module.runCommand(stores, current, { actor: owner, event: logEvent("purge-manifest-recorded", { paths: [fixtureDigest, OBJECT_Y] }), now });
  holds(FIXTURE_RUN, !refused.ok && refused.refusal === "manifest-not-the-evidence", () => refused);
  await go("owner", logEvent("purge-manifest-recorded", { paths: [OBJECT_Y] }));
  await go("owner", logEvent("purge-path-absent", { path: OBJECT_Y }));
  holds(FIXTURE_RUN, retentionOf(state().machine) === "SUMMARY_ONLY" && JSON.stringify(state().machine.purge) === JSON.stringify([{ path: OBJECT_Y, state: "absent" }]), () => state().machine.purge);
  // What it rests on is still there, and the case still opens on it.
  const reopened = await module.openCase(stores, CASE_A);
  holds(FIXTURE_RUN, reopened.ok && reopened.case.head === current.head && stores.evidence.objects.has(fixtureDigest), () => reopened);

  // The same run with no other capture: nothing is left to list, and a visit began, so it stays RAW_HELD and takes no empty manifest.
  const only = memoryStores();
  await storeRawObjects(only);
  const onlyClosed = await caseFor(module, only, owner, [...CAPTURING, X_ROW(digestOfRaw("raw-fixture"), "row-page"), cancel]);
  holds(FIXTURE_RUN, retentionOf((onlyClosed.state as NonNullable<OpenCase["state"]>).machine) === "RAW_HELD", () => onlyClosed.state);
  const nothingToList = await module.runCommand(only, onlyClosed, { actor: owner, event: logEvent("purge-manifest-recorded", { paths: [] }), now });
  holds(FIXTURE_RUN, !nothingToList.ok && nothingToList.refusal === "manifest-empty-after-a-visit", () => nothingToList);
};

test("a controlled fixture run, from its row to a purge that keeps the fixture", async () => {
  const { owner } = await fresh();
  await checkFixtureRun(production, owner);
  await assertCaughtBy("a row refused for naming what the case keeps", FIXTURE_RUN, () => checkFixtureRun(variant({ find: 'if (event.type === "evidence-recorded")\n        return { ok: true, state: after };', replace: 'if (event.type === "evidence-recorded")\n        return before !== null && named.some((digest) => before.keptObjects.includes(digest)) ? refused("raw-object-cannot-be-kept", "row.digest") : { ok: true, state: after };' }), owner));
  await assertCaughtBy("a purge that lists the fixture", FIXTURE_RUN, () => checkFixtureRun(variant({ find: "digest === null || keptObjects.includes(digest) ? [] : [digest]", replace: "digest === null ? [] : [digest]" }), owner));
});

test("open (blocks any purge route): the log allows one evidence store for several cases, and then one case's purge set can name another's kept object", async () => {
  const { owner } = await fresh();
  // Each case its own entries and head, over one evidence store. case-log.ts allows it, and nothing here refuses it.
  const first = memoryStores();
  const second: MemoryStores = { ...memoryStores(), evidence: first.evidence };
  const shared = digestOfRaw("raw-fixture");
  await runScript({ stores: first, caseId: CASE_A, actorOf: actorsFor(owner), now: risingClock(startAt), commands: FROZEN });
  // The second case keeps other bytes, and names the first case's fixture as a capture of its own.
  const other = { ...IDENTITY_BIRCH, fixtureDigest: digestOfRaw("raw-plan"), criterionDigest: digestOfRaw("raw-patch") };
  const marks = await runScript({
    stores: second,
    caseId: CASE_B,
    actorOf: actorsFor(owner),
    now: risingClock(startAt),
    commands: [
      owned("case-planned", { ...(CASE_SCRIPT[0].event.data as object), configuration: other } as never),
      owned("plan-frozen", { planDigest: digestOfRaw("raw-criterion") }),
      met(other),
      start("B1"),
      began("B1"),
      X_ROW(shared, "row-other-case"),
      cancel,
      owned("purge-manifest-recorded", { paths: [shared] }),
      owned("purge-path-absent", { path: shared })
    ]
  });
  // The second reads SUMMARY_ONLY over bytes the first rests on. A purge route that deleted them would break the first.
  assert.equal(retentionOf((marks.last.state as NonNullable<OpenCase["state"]>).machine), "SUMMARY_ONLY");
  const keeping = await openCase(first, CASE_A);
  assert.ok(keeping.ok);
  assert.ok((keeping.case.state as NonNullable<OpenCase["state"]>).keptObjects.includes(shared));
});

test("open (blocks any purge route): a manifest covers what the log names, and bytes uploaded ahead of their row are not named, or are kept when a patch names them before the row lands", async () => {
  const { owner } = await fresh();
  const stores = memoryStores();
  const closed = await caseFor(production, stores, owner, [...WITH_ROW, cancel]);
  const now = risingClock(startAt + 90_000);
  // The runner stored this and never got to its row. Nothing names it.
  const orphan = await putEvidence(stores, new TextEncoder().encode("a capture whose row was never written"));
  assert.ok(orphan.ok);
  const listed = await runCommand(stores, closed, { actor: owner, event: MANIFEST.event, now });
  assert.ok(listed.ok);
  const gone = await runCommand(stores, listed.case, { actor: owner, event: logEvent("purge-path-absent", { path: RAW_ONE }), now });
  assert.ok(gone.ok);
  // SUMMARY_ONLY speaks to what the log names: the object is still stored, a listing would find it, and nothing can now record it.
  assert.equal(retentionOf((gone.case.state as NonNullable<OpenCase["state"]>).machine), "SUMMARY_ONLY");
  assert.ok(stores.evidence.objects.has(orphan.digest));
  assert.deepEqual(await runCommand(stores, listed.case, { actor: owner, event: logEvent("purge-manifest-recorded", { paths: [orphan.digest] }), now }), { ok: false, refusal: "manifest-already-recorded", at: null });
  const late = logEvent("evidence-recorded", { row: { ...rowOn("row-found-later"), digest: orphan.digest } as never });
  assert.deepEqual(await runCommand(stores, gone.case, { actor: actorsFor(owner)("B1"), event: late, now }), { ok: false, refusal: "evidence-after-manifest", at: "row" });
  // A manifest listing it before then is refused too, since the log does not name it.
  const fresh2 = copyOfStores(stores);
  fresh2.head.value = closed.head;
  const reopened = await openCase(fresh2, CASE_A);
  assert.ok(reopened.ok);
  assert.deepEqual(await runCommand(fresh2, reopened.case, { actor: owner, event: logEvent("purge-manifest-recorded", { paths: [RAW_ONE, orphan.digest] }), now }), { ok: false, refusal: "manifest-not-the-evidence", at: "paths" });
  // A patch may name bytes a runner uploaded ahead of their row. The row then lands on bytes the case keeps, so no manifest lists them.
  const patchFirst = memoryStores();
  const visited = await caseFor(production, patchFirst, owner, [...FROZEN, excepted, start("B1"), began("B1"), X_ROW(OBJECT_Y, "row-other"), ...ended("B1")]);
  const ahead = await putEvidence(patchFirst, new TextEncoder().encode("a capture uploaded ahead of its row, which a patch names first"));
  assert.ok(ahead.ok);
  const patched = await runCommand(patchFirst, visited, { actor: owner, event: reconstructing(ahead.digest), now });
  assert.ok(patched.ok);
  const landed = await runCommand(patchFirst, patched.case, { actor: actorsFor(owner)("B1"), event: X_ROW(ahead.digest, "row-landed").event, now });
  assert.ok(landed.ok);
  const closedFirst = await runCommand(patchFirst, landed.case, { actor: owner, event: cancel.event, now });
  assert.ok(closedFirst.ok);
  assert.deepEqual(await runCommand(patchFirst, closedFirst.case, { actor: owner, event: logEvent("purge-manifest-recorded", { paths: [OBJECT_Y, ahead.digest] }), now }), { ok: false, refusal: "manifest-not-the-evidence", at: "paths" });
  assert.ok((await runCommand(patchFirst, closedFirst.case, { actor: owner, event: logEvent("purge-manifest-recorded", { paths: [OBJECT_Y] }), now })).ok);
});

test("open (blocks any purge route): what a missed control names is bound by the log but neither kept nor raw, so the control run can store bytes no manifest lists, and the case opens only while they stay", async () => {
  const { owner } = await fresh();
  const stores = memoryStores();
  // X is capture bytes, named by a control under another identity and by no row.
  const closed = await caseFor(production, stores, owner, [...missedFirst(BIRCH_X_FIXTURE), cancel]);
  assert.ok(!(closed.state as NonNullable<OpenCase["state"]>).keptObjects.includes(OBJECT_X));
  const now = risingClock(startAt + 90_000);
  assert.deepEqual(await runCommand(stores, closed, { actor: owner, event: logEvent("purge-manifest-recorded", { paths: [OBJECT_X, OBJECT_Y] }), now }), { ok: false, refusal: "manifest-not-the-evidence", at: "paths" });
  const listed = await runCommand(stores, closed, { actor: owner, event: logEvent("purge-manifest-recorded", { paths: [OBJECT_Y] }), now });
  assert.ok(listed.ok);
  const gone = await runCommand(stores, listed.case, { actor: owner, event: logEvent("purge-path-absent", { path: OBJECT_Y }), now });
  assert.ok(gone.ok);
  // SUMMARY_ONLY, and X is still stored, named by the log, on no list.
  assert.equal(retentionOf((gone.case.state as NonNullable<OpenCase["state"]>).machine), "SUMMARY_ONLY");
  assert.ok(stores.evidence.objects.has(OBJECT_X));
  // A route that deleted it would leave a case that does not open.
  const copy = copyOfStores(stores);
  copy.evidence.objects.delete(OBJECT_X);
  assert.deepEqual(await openCase(copy, CASE_A), { ok: false, refusal: "evidence-missing", at: OBJECT_X });
});

test("open (blocks any purge route): a case whose only rows name kept objects, after a visit, can never record a manifest, for the same reason bytes uploaded ahead of a row block a purge route", async () => {
  const { owner } = await fresh();
  const stores = memoryStores();
  // The row names the plan's fixture, which the case keeps, so the purge set is empty while an attempt began.
  const closed = await caseFor(production, stores, owner, [...FROZEN, excepted, start("B1"), began("B1"), X_ROW(digestOfRaw("raw-fixture"), "row-fixture"), cancel]);
  const now = risingClock(startAt + 90_000);
  const manifest = (paths: readonly string[]) => runCommand(stores, closed, { actor: owner, event: logEvent("purge-manifest-recorded", { paths: [...paths] }), now });
  assert.deepEqual(await manifest([]), { ok: false, refusal: "manifest-empty-after-a-visit", at: "paths" });
  assert.deepEqual(await manifest([digestOfRaw("raw-fixture")]), { ok: false, refusal: "manifest-not-the-evidence", at: "paths" });
  // No manifest the case accepts exists, so it reads RAW_HELD for good, whatever a runner stored and never named.
  assert.equal(retentionOf((closed.state as NonNullable<OpenCase["state"]>).machine), "RAW_HELD");
});

test("open (blocks any purge route): once an object is really deleted, the case no longer opens, and a kill before confirming cannot be recorded", async () => {
  const { owner } = await fresh();
  const stores = memoryStores();
  const marks = await runScript({ stores, caseId: CASE_A, actorOf: actorsFor(owner), now: risingClock(startAt), commands: WITH_MANIFEST });
  // Delete first, as a purge must, and then try to say so.
  stores.evidence.objects.delete(RAW_ONE);
  assert.deepEqual(await openCase(stores, CASE_A), { ok: false, refusal: "evidence-missing", at: RAW_ONE }, "a real deletion reads as a broken case, because every open hashes every named object");
  // A process that held the case from before the delete can still say so, since it folds nothing again.
  const confirmed = await runCommand(stores, marks.last, { actor: owner, event: logEvent("purge-path-absent", { path: RAW_ONE }), now: risingClock(startAt + 90_000) });
  assert.ok(confirmed.ok);
  assert.equal(retentionOf((confirmed.case.state as NonNullable<OpenCase["state"]>).machine), "SUMMARY_ONLY");
  // And the case that says SUMMARY_ONLY does not open either. A fresh process, after a kill between the delete and that
  // command, gets the same refusal, so it has no case to record anything on, and a copy of one is refused too.
  assert.deepEqual(await openCase(stores, CASE_A), { ok: false, refusal: "evidence-missing", at: RAW_ONE });
  const afterKill = memoryStores();
  const uncommitted = await caseFor(production, afterKill, owner, WITH_MANIFEST);
  afterKill.evidence.objects.delete(RAW_ONE);
  assert.deepEqual(await openCase(afterKill, CASE_A), { ok: false, refusal: "evidence-missing", at: RAW_ONE });
  assert.deepEqual(await runCommand(afterKill, { ...uncommitted }, { actor: owner, event: logEvent("purge-path-absent", { path: RAW_ONE }), now: risingClock(startAt + 95_000) }), { ok: false, refusal: "not-a-folded-case", at: null });
});

test("open (blocks any purge route): a list holds 64 items, so a case with more raw objects cannot list them all", () => {
  const paths = Array.from({ length: 65 }, (_, index) => index.toString(16).padStart(2, "0").repeat(32));
  assert.deepEqual(decodeEvent({ type: "purge-manifest-recorded", data: { paths } }), { ok: false, refusal: "malformed-event", at: "purge-manifest-recorded" });
  assert.ok(decodeEvent({ type: "purge-manifest-recorded", data: { paths: paths.slice(0, 64) } }).ok);
});

test("open (Durable Object batch): attempt-started is the owner's, so an unattended run cannot start its next attempt once the owner's token has passed", async () => {
  const { owner } = await fresh();
  const stores = memoryStores();
  const current = await caseFor(production, stores, owner, [...B1_ENDED, clean("B1")]);
  const pastExpiry = () => EXP * 1000 + 1;
  const next = start("B2").event;
  // The owner's token no longer vouches for the command, and no runner may send it. So B2 waits for someone to come back.
  assert.deepEqual(await runCommand(stores, current, { actor: owner, event: next, now: pastExpiry }), { ok: false, refusal: "actor-expired", at: null });
  for (const as of ["B1", "B2", "control"] as const) {
    assert.deepEqual(await runCommand(stores, current, { actor: actorsFor(owner)(as), event: next, now: pastExpiry }), { ok: false, refusal: "owner-only", at: null }, as);
  }
  const reopened = await openCase(stores, CASE_A);
  assert.ok(reopened.ok);
  assert.equal(reopened.case.head, current.head);
});

test("open (Durable Object batch): the log has no command id, so a landed command resent after a reopen is a new command", async () => {
  const { owner } = await fresh();
  const stores = memoryStores();
  const marks = await runScript({ stores, caseId: CASE_A, actorOf: actorsFor(owner), now: risingClock(startAt), commands: FROZEN });
  const actor = actorsFor(owner)("control");
  const now = risingClock(startAt + 50_000);
  const landed = await runCommand(stores, marks.last, { actor, event: notMet().event, now });
  assert.ok(landed.ok);
  assert.equal(landed.case.state?.machine.controlMisses, 1);
  // A retrier still holding its case before the crash is told: conflict, and sends nothing twice.
  assert.deepEqual(await runCommand(stores, marks.last, { actor, event: notMet().event, now }), { ok: false, refusal: "conflict", at: null });
  // A retrier that reopened first has no way to see its command landed. One real miss counts two.
  const reopened = await openCase(stores, CASE_A);
  assert.ok(reopened.ok);
  const resent = await runCommand(stores, reopened.case, { actor, event: notMet().event, now });
  assert.ok(resent.ok);
  assert.equal(resent.case.state?.machine.controlMisses, 2);
});

class Crash extends Error {}

/**
 * The stores with one chosen operation never returning, as a process dying there would look. A
 * case is registered with its stores, so it opens through these before they are armed.
 */
function crashing(stores: MemoryStores, at: number, when: "before" | "after"): LogStores & Readonly<{ arm: () => void }> {
  let count = -1;
  let armed = false;
  const around = async <T>(run: () => Promise<T>): Promise<T> => {
    if (!armed) return run();
    count += 1;
    const here = count;
    if (here === at && when === "before") throw new Crash("before");
    const result = await run();
    if (here === at && when === "after") throw new Crash("after");
    return result;
  };
  return {
    arm: () => {
      armed = true;
    },
    entries: { createOnly: (address, bytes) => around(() => stores.entries.createOnly(address, bytes)), read: (address, max) => around(() => stores.entries.read(address, max)) },
    evidence: { createOnly: (address, bytes) => around(() => stores.evidence.createOnly(address, bytes)), read: (address, max) => around(() => stores.evidence.read(address, max)) },
    head: { read: (max) => around(() => stores.head.read(max)), compareAndSwap: (expected, next) => around(() => stores.head.compareAndSwap(expected, next)) }
  };
}

const KILL = "a kill between any two steps gives a state the log explains: the command happened whole or not at all";

/** One command, from a case stopped just before it, crashed at every store operation in turn. */
const checkKillAtEveryStep = async (module: StoreModule, owner: Actor, prefix: readonly ScriptCommand[], next: ScriptCommand, phasesBefore: string, phasesAfter: string, expectedOperations: number) => {
  const base = memoryStores();
  const before = await caseFor(module, base, owner, prefix);
  const clockAfter = () => startAt + 500_000;
  const actor = actorsFor(owner)(next.as);
  let operations = 0;
  let outcomes = 0;
  for (let at = 0; at < 200; at += 1) {
    let ranOut = false;
    for (const when of ["before", "after"] as const) {
      const stores = copyOfStores(base);
      const doomed = crashing(stores, at, when);
      const opened = await module.openCase(doomed, CASE_A);
      holds(KILL, opened.ok, () => opened);
      const held = (opened as Extract<production.OpenCaseResult, { ok: true }>).case;
      doomed.arm();
      let crashed = false;
      try {
        const answer = await module.runCommand(doomed, held, { actor, event: next.event, now: clockAfter });
        holds(KILL, answer.ok, () => answer);
      } catch (error) {
        if (!(error instanceof Crash)) throw error;
        crashed = true;
      }
      if (!crashed) {
        ranOut = true;
        continue;
      }
      outcomes += 1;
      // A fresh process finds exactly the state the log explains: before, or after.
      const fresh = copyOfStores(stores);
      const found = await module.openCase(fresh, CASE_A);
      holds(KILL, found.ok, () => ({ at, when, found }));
      if (!found.ok) return;
      const seen = phases(found.case);
      holds(KILL, seen === phasesBefore || seen === phasesAfter, () => ({ at, when, seen }));
      // And a seq one past what was logged never appears: the state is the entries' fold, no more.
      const log = await openLog(stores, CASE_A);
      holds(KILL, log.ok && log.log.entries.length === found.case.seq && (found.case.seq === before.seq || found.case.seq === before.seq + 1), () => ({ at, when, seq: found.case.seq }));
      // One still holding its case from before the crash lands it once if it did not land, and gets a conflict if it did.
      // One that opens fresh and finds it did not land sends it once. One that opens fresh and finds it landed has nothing to tell it so: see the open test.
      if (found.case.seq === before.seq) {
        const fromHeld = await module.runCommand(doomed, held, { actor, event: next.event, now: clockAfter });
        holds(KILL, fromHeld.ok && phases(fromHeld.case) === phasesAfter && fromHeld.case.seq === before.seq + 1, () => ({ at, when, fromHeld }));
        const retried = await module.runCommand(fresh, found.case, { actor, event: next.event, now: clockAfter });
        holds(KILL, retried.ok && phases(retried.case) === phasesAfter && retried.case.seq === before.seq + 1, () => ({ at, when, retried }));
      } else {
        const stale = await module.runCommand(doomed, held, { actor, event: next.event, now: clockAfter });
        holds(KILL, !stale.ok && stale.refusal === "conflict", () => ({ at, when, stale }));
      }
    }
    if (ranOut) break;
    operations += 1;
  }
  holds(KILL, operations === expectedOperations && outcomes === operations * 2, () => ({ operations, outcomes, expectedOperations }));
};

/** A marked point of the script, and everything up to it. */
const upTo = (mark: string): readonly ScriptCommand[] => CASE_SCRIPT.slice(0, CASE_SCRIPT.findIndex((command) => command.mark === mark) + 1);

test("a crash at every store operation of a command leaves before or after, and a retrier holding its pre-crash case lands it once", async () => {
  const { owner } = await fresh();
  await checkKillAtEveryStep(production, owner, upTo("control-passed"), CASE_SCRIPT[upTo("control-passed").length], "planned,planned,planned,planned,planned,planned", "starting,planned,planned,planned,planned,planned", OPS_PLAIN);
  const beforeUsable = upTo("b1-done").slice(0, -2);
  await checkKillAtEveryStep(production, owner, beforeUsable, CASE_SCRIPT[beforeUsable.length], "finalizing,planned,planned,planned,planned,planned", "usable,planned,planned,planned,planned,planned", OPS_PLAIN_LATER);
  // A command that names an evidence object, so the object's check sits among the steps.
  const beforeRow = upTo("control-passed").concat(CASE_SCRIPT.slice(upTo("control-passed").length, upTo("control-passed").length + 2));
  await checkKillAtEveryStep(production, owner, beforeRow, CASE_SCRIPT[beforeRow.length], "capturing,planned,planned,planned,planned,planned", "capturing,planned,planned,planned,planned,planned", OPS_WITH_OBJECT);
  // And the first command of all, from a log with no plan.
  await checkKillAtEveryStep(production, owner, [CASE_SCRIPT[0]], CASE_SCRIPT[1], "planned,planned,planned,planned,planned,planned", "planned,planned,planned,planned,planned,planned", OPS_FREEZE);
});

const OPS_PLAIN = 7;
const OPS_PLAIN_LATER = 13;
const OPS_WITH_OBJECT = 10;
const OPS_FREEZE = 5;

test("the walk catches a state that does not come from what the log holds", async () => {
  const { owner } = await fresh();
  // An open that adds a step the log does not hold: the state moves past what was written.
  await assertCaughtBy("an extra step on open", KILL, () =>
    checkKillAtEveryStep(
      variant({ find: "return { ok: true, case: foldedCase({ caseId, head: opened.log.head, seq, state }, stores) };", replace: 'return { ok: true, case: foldedCase({ caseId, head: opened.log.head, seq, state: state === null ? null : { ...state, machine: { ...state.machine, attempts: state.machine.attempts.map((attempt, index) => (index === 0 ? { ...attempt, phase: "failed" } : attempt)) } } }, stores) };' }),
      owner,
      upTo("control-passed"),
      CASE_SCRIPT[upTo("control-passed").length],
      "planned,planned,planned,planned,planned,planned",
      "starting,planned,planned,planned,planned,planned",
      OPS_PLAIN
    )
  );
});

test("the same crash on the filesystem store, at each command boundary and inside one command, reopens to the phases written here", async () => {
  const { owner } = await fresh();
  const { stores, dispose } = FILESYSTEM_BACKEND.fresh();
  try {
    const actorOf = actorsFor(owner);
    const marks = await runScript({ stores, caseId: CASE_A, actorOf, now: risingClock(startAt), commands: upTo("control-passed") });
    // Boundary: reopening between commands, from nothing a process held.
    const between = await openCase(stores, CASE_A);
    assert.ok(between.ok);
    assert.equal(between.case.seq, marks.last.seq);
    assert.equal(phases(between.case), "planned,planned,planned,planned,planned,planned");

    // Inside a command: a head swap that throws, with the entry already written, leaves an orphan and no command.
    const failing: LogStores = {
      ...stores,
      head: {
        read: (max) => stores.head.read(max),
        compareAndSwap: async () => {
          throw new Crash("the swap");
        }
      }
    };
    const onFailing = await openCase(failing, CASE_A);
    assert.ok(onFailing.ok);
    await assert.rejects(runCommand(failing, onFailing.case, { actor: owner, event: CASE_SCRIPT[upTo("control-passed").length].event, now: () => startAt + 500_000 }), Crash);
    const after = await openCase(stores, CASE_A);
    assert.ok(after.ok);
    assert.equal(after.case.head, between.case.head, "the orphan is not reached");
    assert.equal(phases(after.case), "planned,planned,planned,planned,planned,planned");
    const retried = await runCommand(stores, after.case, { actor: owner, event: CASE_SCRIPT[upTo("control-passed").length].event, now: () => startAt + 500_000 });
    assert.ok(retried.ok);
    assert.equal(phases(retried.case), "starting,planned,planned,planned,planned,planned");
  } finally {
    dispose();
  }
});

const READABLE_IDS = ["aa", "ab", "ac", "ad", "ae", "af", "b0"].map((pair) => pair.repeat(16));

const mintFrom = (ids: readonly string[]) => {
  let used = 0;
  return () => {
    used += 1;
    return ids[used - 1];
  };
};

const NEW_CASE = "a new case mints its own ids, and is checked whole before anything is written";

const checkNewCase = async (module: StoreModule, owner: Actor) => {
  const fresh = async () => {
    const stores = memoryStores();
    await storeRawObjects(stores);
    return stores;
  };
  const now = risingClock(startAt);
  const base = { caseId: CASE_A, actor: owner, slots: ["B1", "I1"] as const, configuration: IDENTITY_ALDER, now };

  // Whatever a fixture hands in, it is asked once per slot and once for the control, in that order.
  const stores = await fresh();
  const made = await module.createCase(stores, { ...base, mint: mintFrom(READABLE_IDS) });
  holds(NEW_CASE, made.ok, () => made);
  if (!made.ok) return;
  const state = made.case.state as NonNullable<OpenCase["state"]>;
  holds(NEW_CASE, JSON.stringify(state.machine.attempts.map(({ slot, arm, attemptId }) => [slot, arm, attemptId])) === JSON.stringify([["B1", "baseline", READABLE_IDS[0]], ["I1", "instrumented", READABLE_IDS[1]]]), () => state.machine.attempts);
  holds(NEW_CASE, state.machine.controlRunId === READABLE_IDS[2] && made.case.seq === 1, () => state.machine);
  // Its control run is who can answer for the gate, and an attempt's runner cannot.
  const control = await module.runCommand(stores, made.case, { actor: owner, event: CASE_SCRIPT[1].event, now });
  holds(NEW_CASE, control.ok, () => control);

  // A second call on that log.
  const twice = await module.createCase(stores, base);
  holds(NEW_CASE, !twice.ok && twice.refusal === "log-exists", () => twice);

  // Every refusal, with the store as empty afterward as it was, and the corrected call then going through.
  const refusals: readonly (readonly [string, Partial<Parameters<StoreModule["createCase"]>[1]>, string, string | null])[] = [
    ["a look-alike actor", { actor: { ...(owner as object) } as Actor }, "not-an-actor", null],
    ["a runner", { actor: runnerActorFrom(ATTEMPT_IDS.B1) as Actor }, "owner-only", null],
    ["a bad id", { caseId: "NOT A CASE ID" }, "malformed-case-id", null],
    ["no slots", { slots: [] }, "malformed-plan", null],
    ["a slot of no name", { slots: ["Z9"] as never }, "malformed-plan", null],
    ["a slot of no name after a good one", { slots: ["B1", "Z9"] as never }, "malformed-plan", null],
    ["a configuration no canonical bytes can hold", { configuration: { ...IDENTITY_ALDER, grammarVersion: 1.5 } }, "malformed-command", null],
    ["a slot as an object, with an id someone chose", { slots: [{ slot: "B1", attemptId: READABLE_IDS[0] }] as never }, "malformed-plan", null],
    ["slots that are not a list", { slots: "B1" as never }, "malformed-plan", null],
    ["a slot repeated", { slots: ["B1", "B1"] }, "malformed-plan", null],
    ["slots out of order", { slots: ["I1", "B1"] }, "malformed-plan", null],
    ["a bad identity", { configuration: { ...IDENTITY_ALDER, commit: "not-a-commit" } }, "malformed-event", "case-planned"],
    ["a mint that repeats itself", { mint: () => READABLE_IDS[0] }, "malformed-event", "case-planned"],
    ["a mint that gives zeros", { mint: () => "0".repeat(32) }, "malformed-event", "case-planned"],
    ["a configuration whose fixture is not stored", { configuration: { ...IDENTITY_ALDER, fixtureDigest: "7e".repeat(32) } }, "evidence-missing", "7e".repeat(32)],
    ["an entry past the size bound", { configuration: { ...IDENTITY_ALDER, reaIntegrity: `sha512-${"Q".repeat(300_000)}` } }, "entry-too-large", null],
    // The clock is part of the entry, so it is checked before there is a log, and its answer is not read twice.
    ["a clock at the token's expiry", { now: () => EXP * 1000 }, "actor-expired", null],
    ["a clock past the token's expiry", { now: () => EXP * 1000 + 5 }, "actor-expired", null],
    ["a clock giving no number", { now: () => Number.NaN }, "malformed-command", null],
    ["a clock before the epoch", { now: () => -5 }, "malformed-command", null],
    ["a clock giving a fraction", { now: () => startAt + 0.5 }, "malformed-command", null],
    ["a clock that throws", { now: () => { throw new Error("no clock here"); } }, "malformed-command", null],
    ["no clock at all", { now: undefined as never }, "malformed-command", null]
  ];
  for (const [name, change, refusal, at] of refusals) {
    const empty = await fresh();
    const answer = await module.createCase(empty, { ...base, ...change }).catch((error: unknown) => ({ ok: true as const, threw: String(error) }));
    holds(NEW_CASE, !answer.ok && answer.refusal === refusal && answer.at === at, () => ({ name, answer }));
    holds(NEW_CASE, empty.head.value === null && empty.entries.objects.size === 0, () => ({ name, head: empty.head.value }));
    const corrected = await module.createCase(empty, base);
    holds(NEW_CASE, corrected.ok, () => ({ name, corrected }));
  }

  // The bound holds on the bytes that would be written, its case id among them. One byte past it starts no log, and at it the log starts.
  const padded = (length: number) => ({ ...IDENTITY_ALDER, reaIntegrity: `sha512-${"Q".repeat(length)}` });
  const sizeRefused = async (length: number) => {
    const empty = await fresh();
    return module.createCase(empty, { ...base, configuration: padded(length), mint: mintFrom(READABLE_IDS), now: () => startAt + 1000 });
  };
  let low = 100_000;
  let high = 300_000;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if ((await sizeRefused(middle)).ok) low = middle;
    else high = middle;
  }
  const overTheBound = await fresh();
  const justOver = await module.createCase(overTheBound, { ...base, configuration: padded(high), mint: mintFrom(READABLE_IDS), now: () => startAt + 1000 });
  holds(NEW_CASE, !justOver.ok && justOver.refusal === "entry-too-large" && overTheBound.head.value === null, () => ({ refusal: justOver.ok ? "ok" : justOver.refusal, head: overTheBound.head.value }));
  const atTheBound = await sizeRefused(low);
  holds(NEW_CASE, atTheBound.ok, () => (atTheBound.ok ? "ok" : atTheBound.refusal));

  // One reading of each thing it was handed, so what was checked is what is written, whatever a getter does next.
  const shifted = await fresh();
  let digestReads = 0;
  const configuration = { ...IDENTITY_ALDER };
  Object.defineProperty(configuration, "fixtureDigest", {
    enumerable: true,
    get() {
      digestReads += 1;
      return digestReads === 1 ? IDENTITY_ALDER.fixtureDigest : "7e".repeat(32);
    }
  });
  let slotReads = 0;
  const slots: SlotName[] = ["B1", "I1"];
  Object.defineProperty(slots, 0, {
    enumerable: true,
    get() {
      slotReads += 1;
      return slotReads === 1 ? "B1" : "Z9";
    }
  });
  let clockReads = 0;
  const once = await module.createCase(shifted, {
    ...base,
    slots,
    configuration,
    now: () => {
      clockReads += 1;
      return startAt + clockReads * 1000;
    }
  });
  holds(NEW_CASE, once.ok, () => once);
  holds(NEW_CASE, JSON.stringify([digestReads, slotReads, clockReads]) === "[1,1,1]", () => ({ digestReads, slotReads, clockReads }));
  const log = await openLog(shifted, CASE_A);
  holds(NEW_CASE, log.ok && log.log.entries[0].entry.atMs === startAt + 1000 && log.log.entries[0].entry.evidence[0] === IDENTITY_ALDER.fixtureDigest, () => log);
};

test("a new case mints what it needs, and is checked whole before its log is started", async () => {
  const { owner } = await fresh();
  await checkNewCase(production, owner);
  const edited = (...edits: SourceEdit[]) => () => checkNewCase(variant(...edits), owner);
  await assertCaughtBy("a log started before anything is checked", NEW_CASE, edited({ find: 'if (!(0, actor_1.isDerivedActor)(actor))\n        return { ok: false, refusal: "not-an-actor", at: null };\n    if (!(0, case_log_1.isCaseId)(caseId))', replace: 'const startedFirst = await (0, case_log_1.createLog)(stores);\n    if (!startedFirst.ok)\n        return { ok: false, refusal: startedFirst.refusal, at: null };\n    if (!(0, actor_1.isDerivedActor)(actor))\n        return { ok: false, refusal: "not-an-actor", at: null };\n    if (!(0, case_log_1.isCaseId)(caseId))' }));
  await assertCaughtBy("no look at the actor", NEW_CASE, edited({ find: 'if (!(0, actor_1.isDerivedActor)(actor))\n        return { ok: false, refusal: "not-an-actor", at: null };\n    if (!(0, case_log_1.isCaseId)(caseId))', replace: "if (!(0, case_log_1.isCaseId)(caseId))" }));
  await assertCaughtBy("the plan's fold not tried first", NEW_CASE, edited({ find: "const checked = foldEntry(null, { actor, events: [own], evidence, seq: 1 });\n    if (!checked.ok)\n        return checked;", replace: "" }));
  await assertCaughtBy("an entry too large passing the first check", NEW_CASE, edited({ find: "evidence }, atMs);\n    if (refusal !== null)\n        return refusal;", replace: 'evidence }, atMs);\n    if (refusal !== null && refusal.refusal !== "entry-too-large")\n        return refusal;' }));
  await assertCaughtBy("the first check made under another case's id", NEW_CASE, edited({ find: "(0, case_log_1.checkFirstEntry)(stores, { caseId, actor, events: [own], evidence }, atMs);", replace: '(0, case_log_1.checkFirstEntry)(stores, { caseId: "case", actor, events: [own], evidence }, atMs);' }));
  await assertCaughtBy("the first entry not looked at before the log starts", NEW_CASE, edited({ find: "const refusal = await (0, case_log_1.checkFirstEntry)(stores, { caseId, actor, events: [own], evidence }, atMs);\n    if (refusal !== null)\n        return refusal;", replace: "" }));
  await assertCaughtBy("the caller's object written in the second step", NEW_CASE, edited({ find: "{ actor, event: own, now: () => atMs });", replace: "{ actor, event, now: () => atMs });" }));
  await assertCaughtBy("the clock read a second time for the entry", NEW_CASE, edited({ find: "{ actor, event: own, now: () => atMs });", replace: "{ actor, event: own, now });" }));
  await assertCaughtBy("the caller's slots read again", NEW_CASE, edited({ find: "const names = Array.isArray(slots) ? [...slots] : null;", replace: "const names = Array.isArray(slots) ? slots : null;" }));
  await assertCaughtBy("a clock that throws let through as a rejection", NEW_CASE, edited({ find: "function readClock(now) {\n    try {\n        return now();\n    }\n    catch (_a) {\n        return null;\n    }\n}", replace: "function readClock(now) {\n    return now();\n}" }));
  await assertCaughtBy("a slot of any shape", NEW_CASE, edited({ find: 'if (names === null || !names.every((slot) => case_machine_1.SLOT_NAMES.includes(slot)))\n        return { ok: false, refusal: "malformed-plan", at: null };', replace: "" }));
  await assertCaughtBy("one good slot being enough", NEW_CASE, edited({ find: "!names.every((slot) => case_machine_1.SLOT_NAMES.includes(slot))", replace: "!names.some((slot) => case_machine_1.SLOT_NAMES.includes(slot))" }));
  await assertCaughtBy("bytes that are not there taken as a plan", NEW_CASE, edited({ find: 'const bytes = (0, canonical_json_1.canonicalBytes)(event);\n    if (bytes === null)\n        return { ok: false, refusal: "malformed-command", at: null };\n    const own = (0, canonical_json_1.parseCanonical)(bytes);\n    const decoded = (0, case_events_1.decodeEvent)(own);\n    if (!decoded.ok)\n        return decoded;\n    const evidence = (0, case_events_1.digestsNamed)(decoded.event);\n    const checked = foldEntry(null,', replace: 'const bytes = (0, canonical_json_1.canonicalBytes)(event);\n    if (bytes === null)\n        return { ok: false, refusal: "malformed-event", at: "case-planned" };\n    const own = (0, canonical_json_1.parseCanonical)(bytes);\n    const decoded = (0, case_events_1.decodeEvent)(own);\n    if (!decoded.ok)\n        return decoded;\n    const evidence = (0, case_events_1.digestsNamed)(decoded.event);\n    const checked = foldEntry(null,' }));
  await assertCaughtBy("the control's id taken from a slot's", NEW_CASE, edited({ find: "controlRunId: mint()", replace: "controlRunId: READABLE_FIRST" }, { find: "const foldedCases = new WeakMap();", replace: `const READABLE_FIRST = ${JSON.stringify(READABLE_IDS[0])};\nconst foldedCases = new WeakMap();` }));
  await assertCaughtBy("the mint handed in ignored", NEW_CASE, edited({ find: "slots: mintedSlots(names, mint)", replace: "slots: mintedSlots(names)" }));
});

const MINTED = "left to itself a new case's every id comes through ids.ts, from WebCrypto's bytes, one per slot and then one for the control";

/** WebCrypto's random source replaced for the length of one call, as ids.test.ts does: each draw gives bytes that say which draw it was. */
async function withCountedDraws<T>(run: () => Promise<T>): Promise<Readonly<{ drew: number; answer: T }>> {
  const original = crypto.getRandomValues;
  let drew = 0;
  Object.defineProperty(crypto, "getRandomValues", {
    configurable: true,
    value: (array: Uint8Array) => {
      drew += 1;
      return array.fill(drew);
    }
  });
  try {
    return { answer: await run(), drew };
  } finally {
    delete (crypto as unknown as Record<string, unknown>).getRandomValues;
    assert.equal(crypto.getRandomValues, original, "the real source is back");
  }
}

const idOfDraw = (draw: number) => draw.toString(16).padStart(2, "0").repeat(16);

const checkMinted = async (module: StoreModule, owner: Actor) => {
  const stores = memoryStores();
  await storeRawObjects(stores);
  const { answer, drew } = await withCountedDraws(() => module.createCase(stores, { caseId: CASE_A, actor: owner, slots: ["B1", "B2", "B3", "I1", "I2", "I3"], configuration: IDENTITY_ALDER, now: risingClock(startAt) }));
  holds(MINTED, answer.ok && drew === 7, () => ({ answer, drew }));
  const machine = ((answer as Extract<typeof answer, { ok: true }>).case.state as NonNullable<OpenCase["state"]>).machine;
  holds(MINTED, JSON.stringify(machine.attempts.map(({ attemptId }) => attemptId)) === JSON.stringify([1, 2, 3, 4, 5, 6].map(idOfDraw)), () => machine.attempts);
  holds(MINTED, machine.controlRunId === idOfDraw(7), () => machine.controlRunId);
  const made = await withCountedDraws(async () => module.mintedSlots(["B1", "I1"]));
  holds(MINTED, JSON.stringify(made.answer) === JSON.stringify([{ slot: "B1", attemptId: idOfDraw(1) }, { slot: "I1", attemptId: idOfDraw(2) }]), () => made);
};

test("left to itself a new case mints every id through ids.ts, one per slot and one for the control, all different", async () => {
  const { owner } = await fresh();
  await checkMinted(production, owner);
  const roundabout = 'mint = () => crypto["rand" + "omUUID"]().replaceAll("-", "")';
  await assertCaughtBy("a new case's default minter reaching randomness by a name built at run time", MINTED, () => checkMinted(variant({ find: "now, mint = ids_1.mintAttemptId })", replace: `now, ${roundabout} })` }), owner));
  await assertCaughtBy("mintedSlots' default reaching it the same way", MINTED, () => checkMinted(variant({ find: "function mintedSlots(slots, mint = ids_1.mintAttemptId)", replace: `function mintedSlots(slots, ${roundabout})` }), owner));
  await assertCaughtBy("the control run minted first", MINTED, () => checkMinted(variant({ find: "data: { slots: mintedSlots(names, mint), controlRunId: mint(), configuration }", replace: "data: { controlRunId: mint(), slots: mintedSlots(names, mint), configuration }" }), owner));
  // A real draw, end to end, with a case id minted the same way: all seven differ, and the log holds the case.
  const stores = memoryStores();
  await storeRawObjects(stores);
  const caseId = mintCaseId();
  const made = await createCase(stores, { caseId, actor: owner, slots: ["B1", "B2", "B3", "I1", "I2", "I3"], configuration: IDENTITY_ALDER, now: risingClock(startAt) });
  assert.ok(made.ok);
  const machine = (made.case.state as NonNullable<OpenCase["state"]>).machine;
  const ids = [machine.controlRunId, ...machine.attempts.map(({ attemptId }) => attemptId)];
  assert.equal(new Set(ids).size, 7);
  for (const id of ids) assert.match(id, /^[0-9a-f]{32}$/);
  const log = await openLog(stores, caseId);
  assert.ok(log.ok);
  assert.equal(log.log.entries[0].entry.case, caseId);
  // mintedSlots, on its own, keeps plan order.
  assert.deepEqual(mintedSlots(["B1", "I1"], mintFrom(READABLE_IDS)), [{ slot: "B1", attemptId: READABLE_IDS[0] }, { slot: "I1", attemptId: READABLE_IDS[1] }]);
  // A kill between starting the log and planning leaves no case, and the plan can still be recorded.
  const halfway = memoryStores();
  await createLog(halfway);
  await storeRawObjects(halfway);
  const empty = await openCase(halfway, caseId);
  assert.ok(empty.ok);
  assert.equal(empty.case.state, null);
  assert.equal(empty.case.seq, 0);
  const now = risingClock(startAt);
  const notYet = await runCommand(halfway, empty.case, { actor: owner, event: logEvent("plan-frozen", { planDigest: PLAN_DIGEST }), now });
  assert.deepEqual(notYet, { ok: false, refusal: "not-planned", at: null });
  const planned = await runCommand(halfway, empty.case, { actor: owner, event: PLANNED[0].event, now });
  assert.ok(planned.ok);
});

const IDENTITY = "a configuration's key changes with every field of its identity, and only its shape passes";

const FIELD_CHANGES: readonly (readonly [keyof ConfigurationIdentity, ConfigurationIdentity[keyof ConfigurationIdentity]])[] = [
  ["commit", "b2".repeat(20)],
  ["runnerImage", `sha256:${"d9".repeat(32)}`],
  ["reaRelease", "9.1.1"],
  ["reaIntegrity", "sha512-QW5vdGhlcg=="],
  ["scannerNode", "24.20.1"],
  ["reaNode", "24.22.3"],
  ["chromium", "153.0.2"],
  ["instruments", ["coverage", "logger"]],
  ["grammarVersion", 2],
  ["fixtureDigest", "f9".repeat(32)],
  ["criterionDigest", "c9".repeat(32)]
];

const checkIdentityKey = (module: typeof productionEvents) => {
  holds(IDENTITY, module.configurationKey(IDENTITY_ALDER) !== module.configurationKey(IDENTITY_ALDER_REBUILT), () => "the rebuilt image");
  const keys = new Set([module.configurationKey(IDENTITY_ALDER)]);
  for (const [field, value] of FIELD_CHANGES) {
    const changed = { ...IDENTITY_ALDER, [field]: value };
    holds(IDENTITY, module.isConfigurationIdentity(changed), () => field);
    holds(IDENTITY, module.configurationKey(changed) !== module.configurationKey(IDENTITY_ALDER), () => field);
    keys.add(module.configurationKey(changed));
  }
  holds(IDENTITY, keys.size === FIELD_CHANGES.length + 1, () => "two of them coincide");
  holds(IDENTITY, module.configurationKey({ ...IDENTITY_ALDER }) === module.configurationKey(IDENTITY_ALDER), () => "the same identity, another key");
  // The same instruments in another order are another key. That fails closed: a control for one unlocks nothing for the other.
  holds(IDENTITY, module.configurationKey({ ...IDENTITY_ALDER, instruments: [...IDENTITY_ALDER.instruments].reverse() }) !== module.configurationKey(IDENTITY_ALDER), () => "instrument order");
};

test("a configuration's key changes with every field of its identity, and with no other", async () => {
  assert.equal(FIELD_CHANGES.length, Object.keys(IDENTITY_ALDER).length, "every field is named above");
  checkIdentityKey(productionEvents);
  await assertCaughtBy("a key that sorts the instruments", IDENTITY, () => checkIdentityKey(loadVariant<typeof productionEvents>(require.resolve("../core/case-events"), [{ find: "        identity.instruments,\n", replace: "        [...identity.instruments].sort(),\n" }])));
  for (const [field] of FIELD_CHANGES) {
    await assertCaughtBy(`${field} left out of the key`, IDENTITY, () =>
      checkIdentityKey(loadVariant<typeof productionEvents>(require.resolve("../core/case-events"), [{ find: `        identity.${field}${field === "criterionDigest" ? "" : ","}\n`, replace: "" }]))
    );
  }
});

const OTHER_IMAGE = "a control from another image digest unlocks nothing";

const checkOtherImage = async (module: StoreModule, owner: Actor) => {
  const stores = memoryStores();
  const held = await caseFor(module, stores, owner, CASE_SCRIPT.slice(0, 2));
  const now = risingClock(startAt + 50_000);
  const control = await module.runCommand(stores, held, { actor: actorsFor(owner)("control"), event: logEvent("control-recorded", { configuration: IDENTITY_ALDER_REBUILT as never, result: "met" }), now });
  holds(OTHER_IMAGE, control.ok, () => control);
  if (!control.ok) return;
  holds(OTHER_IMAGE, control.case.state?.machine.controlMet === false, () => control.case.state);
  const visit = await module.runCommand(stores, control.case, { actor: owner, event: logEvent("attempt-started", { slot: "B1" }), now });
  holds(OTHER_IMAGE, !visit.ok && visit.refusal === "no-valid-control", () => visit);
};

test("through the store, a control recorded for another image digest leaves the visit refused", async () => {
  const { owner } = await fresh();
  await checkOtherImage(production, owner);
  await assertCaughtBy("a control taken as this configuration's, whatever it names", OTHER_IMAGE, () =>
    checkOtherImage(
      variant({ find: "return stepped(state, { type: event.type, configuration: (0, case_events_1.configurationKey)(event.configuration), result: event.result, by });", replace: "return stepped(state, { type: event.type, configuration: state.machine.configuration, result: event.result, by });" }),
      owner
    )
  );
});

test("an identity is held to its shape, field by field, and refuses what no real one holds", () => {
  assert.ok(isConfigurationIdentity(IDENTITY_ALDER));
  const bad: readonly (readonly [string, unknown])[] = [
    ["an extra field", { ...IDENTITY_ALDER, note: "x" }],
    ["a missing field", (() => { const { commit: _gone, ...rest } = IDENTITY_ALDER; return rest; })()],
    ["a short commit", { ...IDENTITY_ALDER, commit: "abc" }],
    ["an image that is a tag", { ...IDENTITY_ALDER, runnerImage: "scanner:latest" }],
    ["a release with prose", { ...IDENTITY_ALDER, reaRelease: "the latest one" }],
    ["an integrity with no algorithm", { ...IDENTITY_ALDER, reaIntegrity: "QWxk" }],
    ["a node with prose", { ...IDENTITY_ALDER, reaNode: "system" }],
    ["a scanner node with prose", { ...IDENTITY_ALDER, scannerNode: "the one on the box" }],
    ["a chromium with prose", { ...IDENTITY_ALDER, chromium: "the one on the box" }],
    ["a commit of prose", { ...IDENTITY_ALDER, commit: "the latest one" }],
    ["a commit in upper case", { ...IDENTITY_ALDER, commit: "A1".repeat(20) }],
    ["an image digest too short", { ...IDENTITY_ALDER, runnerImage: `sha256:${"d1".repeat(31)}` }],
    ["a version with four dots", { ...IDENTITY_ALDER, chromium: "1.2.3.4.5" }],
    ["no instruments", { ...IDENTITY_ALDER, instruments: [] }],
    ["instruments repeated", { ...IDENTITY_ALDER, instruments: ["coverage", "coverage"] }],
    ["an instrument with a path", { ...IDENTITY_ALDER, instruments: ["/usr/bin/x"] }],
    ["a grammar version of prose", { ...IDENTITY_ALDER, grammarVersion: "one" }],
    ["a fixture digest of prose", { ...IDENTITY_ALDER, fixtureDigest: "the fixture" }],
    ["a criterion digest of prose", { ...IDENTITY_ALDER, criterionDigest: "the criterion" }]
  ];
  for (const [name, value] of bad) assert.equal(isConfigurationIdentity(value), false, name);
});

const rawEvent = (type: string, data: LogEvent["data"]): LogEvent => ({ type, data });

test("every event type decodes its exact shape, refuses a key more or less, and the list of types is this one", () => {
  const row = { id: "row-one", slot: "B1", instrument: "coverage", state: "present", window: { clock: "page", startMs: 1, endMs: 2 }, limits: ["main-frame-only"], digest: "ab".repeat(32), observation: null };
  const unknown = { id: "question-one", question: "What is it?", reason: "Nothing showed.", detail: null, wouldResolve: null };
  const SAMPLES: Readonly<Record<string, LogEvent["data"]>> = {
    "assertion-recorded": { id: "said-one", statement: "Someone said so." },
    "assertion-retracted": { assertion: "said-one", reason: "Nothing backs it.", unknown },
    "attempt-deadline": { slot: "B1" },
    "attempt-finished": { slot: "B1", outcome: "failed", reason: "target-crashed" },
    "attempt-start-retried": { slot: "B1" },
    "attempt-started": { slot: "B1" },
    "baseline-rule-recorded": { result: "met" },
    "capture-began": { slot: "B1" },
    "capture-finished": { slot: "B1" },
    "case-cancelled": {},
    "case-deadline": {},
    "case-planned": { slots: [{ slot: "B1", attemptId: ATTEMPT_IDS.B1 }], controlRunId: CONTROL_RUN_ID, configuration: IDENTITY_ALDER as never },
    "cleanup-confirmed": { slot: "B1" },
    "cleanup-unconfirmed": { slot: "B1" },
    "configuration-changed": { configuration: IDENTITY_ALDER as never },
    "control-recorded": { configuration: IDENTITY_ALDER as never, result: "not_evaluated" },
    "environment-destroyed": { slot: "B1" },
    "evidence-recorded": { row },
    "exception-recorded": { slot: "B1", reason: "Because." },
    "fact-recorded": { id: "fact-one", statement: "Words.", evidence: ["row-one"] },
    "fact-retracted": { fact: "fact-one", reason: "Because.", unknown: null },
    "fact-superseded": { fact: "fact-one", statement: "Other words.", reason: "Because." },
    "instrument-recorded": { slot: "B1", instrument: "coverage", completeness: "partial", reason: "budget-reached" },
    "interpretation-reaffirmed": { interpretation: "reading-one", cites: [{ fact: "fact-one", version: 1 }] },
    "interpretation-recorded": { id: "reading-one", statement: "Words.", cites: [{ fact: "fact-one", version: 1 }] },
    "plan-frozen": { planDigest: PLAN_DIGEST },
    "purge-manifest-recorded": { paths: ["ab".repeat(32)] },
    "purge-path-absent": { path: "ab".repeat(32) },
    "purge-path-remains": { path: "ab".repeat(32) },
    reconcile: {},
    "source-recorded": { slot: "B1", commit: "a1".repeat(20), identity: "9a".repeat(32) },
    "source-reconstructed": { appliesTo: ["B1"], baseCommit: "a1".repeat(20), patchDigest: "ab".repeat(32), identity: "9a".repeat(32) },
    "unknown-recorded": { unknown }
  };
  assert.deepEqual([...EVENT_TYPES], Object.keys(SAMPLES).sort(), "the types are exactly these, and there is no approve, publish or export among them");
  for (const [type, data] of Object.entries(SAMPLES)) {
    const decoded = decodeEvent(rawEvent(type, data));
    assert.ok(decoded.ok, type);
    // One key more, whatever it holds, is refused rather than ignored. So is each key missing.
    assert.deepEqual(decodeEvent(rawEvent(type, { ...data, by: "owner" })), { ok: false, refusal: "malformed-event", at: type }, `${type} with a typed name`);
    // An empty key, which a joined list of no keys reads the same as nothing at all.
    assert.deepEqual(decodeEvent(rawEvent(type, { ...data, "": "x" })), { ok: false, refusal: "malformed-event", at: type }, `${type} with an empty key`);
    for (const key of Object.keys(data)) {
      const { [key]: _gone, ...rest } = data as Record<string, never>;
      assert.deepEqual(decodeEvent(rawEvent(type, rest)), { ok: false, refusal: "malformed-event", at: type }, `${type} without ${key}`);
    }
    // Two or more keys held as one, which a joined list reads the same as the two.
    const keys = Object.keys(data);
    if (keys.length > 1) assert.deepEqual(decodeEvent(rawEvent(type, { [keys.join(",")]: "x" })), { ok: false, refusal: "malformed-event", at: type }, `${type} with its keys joined`);
  }
  // The top level is held the same way.
  assert.deepEqual(decodeEvent({ type: "reconcile", data: {}, "": "x" } as unknown as LogEvent), { ok: false, refusal: "malformed-event", at: "event" });
  assert.deepEqual(decodeEvent({ "type,data": "x" } as unknown as LogEvent), { ok: false, refusal: "malformed-event", at: "event" });
  assert.deepEqual(decodeEvent(logEvent("toString")), { ok: false, refusal: "unknown-event-type", at: "type" }, "a name every object answers to is no event");
  assert.deepEqual(decodeEvent(logEvent("constructor")), { ok: false, refusal: "unknown-event-type", at: "type" });
});

const DECODES = "decoders hold every value to its shape, nested fields included, and a refusal repeats none of them";

const CANARY = "CANARY-PATH-alice.person?token=CANARY-QUERY-VALUE-9c1b";
const ROW = { id: "row-one", slot: "B1", instrument: "coverage", state: "present", window: { clock: "page", startMs: 1, endMs: 2 }, limits: [], digest: "ab".repeat(32), observation: null };
const OBSERVATION = { subject: "subject-one", count: 1, granularity: "block", windowEnd: "window_closed", scope: "in_scope" };
const UNKNOWN = { id: "question-one", question: "What?", reason: "Nothing showed.", detail: null, wouldResolve: null };
const SLOTS = [{ slot: "B1", attemptId: ATTEMPT_IDS.B1 }, { slot: "I1", attemptId: ATTEMPT_IDS.I1 }];

/** Each character a URL or an address needs, and a word that holds them all, in lower case, so case is not what refuses them. */
const SLUG_BREAKERS = ["a/b", "a@b", "a=b", "a?b", "a.b", "a#b", "a b", "a%20b", "a:b", "alice.person@mail.example/path?token=one", ""];

/** Every place a slug is the shape, and the event that holds it there. */
const SLUG_FIELDS: readonly (readonly [string, (value: string) => readonly [string, LogEvent["data"]]])[] = [
  ["a row's id", (value) => ["evidence-recorded", { row: { ...ROW, id: value } }]],
  ["a row's instrument", (value) => ["evidence-recorded", { row: { ...ROW, instrument: value } }]],
  ["a row's limit", (value) => ["evidence-recorded", { row: { ...ROW, limits: [value] } }]],
  ["a window's clock", (value) => ["evidence-recorded", { row: { ...ROW, window: { clock: value, startMs: 1, endMs: 2 } } }]],
  ["a window's note", (value) => ["evidence-recorded", { row: { ...ROW, window: { clock: null, note: value } } }]],
  ["an observation's subject", (value) => ["evidence-recorded", { row: { ...ROW, observation: { ...OBSERVATION, subject: value } } }]],
  ["a finish's reason", (value) => ["attempt-finished", { slot: "B1", outcome: "failed", reason: value }]],
  ["an instrument's name", (value) => ["instrument-recorded", { slot: "B1", instrument: value, completeness: "complete", reason: null }]],
  ["an instrument's reason", (value) => ["instrument-recorded", { slot: "B1", instrument: "coverage", completeness: "partial", reason: value }]],
  ["a fact's id", (value) => ["fact-recorded", { id: value, statement: "Words.", evidence: ["row-one"] }]],
  ["a fact's evidence", (value) => ["fact-recorded", { id: "fact-one", statement: "Words.", evidence: [value] }]],
  ["a superseded fact", (value) => ["fact-superseded", { fact: value, statement: "Words.", reason: "Because." }]],
  ["a retracted fact", (value) => ["fact-retracted", { fact: value, reason: "Because.", unknown: null }]],
  ["an assertion's id", (value) => ["assertion-recorded", { id: value, statement: "Words." }]],
  ["a retracted assertion", (value) => ["assertion-retracted", { assertion: value, reason: "Because.", unknown: UNKNOWN }]],
  ["an interpretation's id", (value) => ["interpretation-recorded", { id: value, statement: "Words.", cites: [{ fact: "fact-one", version: 1 }] }]],
  ["a cited fact", (value) => ["interpretation-recorded", { id: "reading-one", statement: "Words.", cites: [{ fact: value, version: 1 }] }]],
  ["a reaffirmed interpretation", (value) => ["interpretation-reaffirmed", { interpretation: value, cites: [{ fact: "fact-one", version: 1 }] }]],
  ["an unknown's id", (value) => ["unknown-recorded", { unknown: { ...UNKNOWN, id: value } }]],
  ["a retraction's unknown id", (value) => ["fact-retracted", { fact: "fact-one", reason: "Because.", unknown: { ...UNKNOWN, id: value } }]],
  ["an instrument in a configuration", (value) => ["configuration-changed", { configuration: { ...IDENTITY_ALDER, instruments: [value] } }]]
];

const BAD_EVENTS: readonly (readonly [string, LogEvent["data"]])[] = [
  ["plan-frozen", { planDigest: CANARY }],
  ["exception-recorded", { slot: "Z9", reason: "Because." }],
  ["exception-recorded", { slot: "B1", reason: "   " }],
  ["baseline-rule-recorded", { result: "maybe" }],
  ["attempt-finished", { slot: "B1", outcome: "published", reason: null }],
  ["attempt-finished", { slot: "B1", outcome: "failed", reason: null }],
  ["attempt-finished", { slot: "B1", outcome: "usable", reason: "no-reason-needed" }],
  ["attempt-finished", { slot: "B1", outcome: "failed", reason: CANARY }],
  ["evidence-recorded", { row: { ...ROW, id: CANARY } }],
  ["evidence-recorded", { row: { ...ROW, instrument: CANARY } }],
  ["evidence-recorded", { row: { ...ROW, limits: [CANARY] } }],
  ["evidence-recorded", { row: { ...ROW, digest: CANARY } }],
  ["evidence-recorded", { row: { ...ROW, digest: null } }],
  ["evidence-recorded", { row: { ...ROW, state: "no_record" } }],
  ["evidence-recorded", { row: { ...ROW, state: "late" } }],
  ["evidence-recorded", { row: { ...ROW, window: { clock: "page", startMs: 5, endMs: 2 } } }],
  ["evidence-recorded", { row: { ...ROW, window: { clock: null, note: CANARY } } }],
  ["evidence-recorded", { row: { ...ROW, window: { clock: null } } }],
  ["evidence-recorded", { row: { ...ROW, observation: { ...OBSERVATION, subject: CANARY } } }],
  ["evidence-recorded", { row: { ...ROW, observation: { ...OBSERVATION, count: -1 } } }],
  ["evidence-recorded", { row: { ...ROW, observation: { ...OBSERVATION, granularity: "line" } } }],
  // A field more, at every nested level.
  ["evidence-recorded", { row: { ...ROW, url: "x" } }],
  ["evidence-recorded", { row: { ...ROW, window: { clock: "page", startMs: 1, endMs: 2, url: "x" } } }],
  ["evidence-recorded", { row: { ...ROW, window: { clock: null, note: "none", url: "x" } } }],
  ["evidence-recorded", { row: { ...ROW, observation: { ...OBSERVATION, url: "x" } } }],
  ["interpretation-recorded", { id: "reading-one", statement: "Words.", cites: [{ fact: "fact-one", version: 1, url: "x" }] }],
  ["interpretation-reaffirmed", { interpretation: "reading-one", cites: [{ fact: "fact-one", version: 1, url: "x" }] }],
  ["unknown-recorded", { unknown: { ...UNKNOWN, url: "x" } }],
  ["fact-retracted", { fact: "fact-one", reason: "Because.", unknown: { ...UNKNOWN, url: "x" } }],
  ["assertion-retracted", { assertion: "said-one", reason: "Because.", unknown: { ...UNKNOWN, url: "x" } }],
  ["case-planned", { slots: [{ ...SLOTS[0], url: "x" }], controlRunId: CONTROL_RUN_ID, configuration: IDENTITY_ALDER }],
  ["configuration-changed", { configuration: { ...IDENTITY_ALDER, url: "x" } }],
  // A key that is empty, and keys held as one.
  ["evidence-recorded", { row: { ...ROW, window: { clock: "page", startMs: 1, endMs: 2, "": "x" } } }],
  ["unknown-recorded", { unknown: { ...UNKNOWN, "": "x" } }],
  ["exception-recorded", { "slot,reason": "x" }],
  ["purge-manifest-recorded", { paths: [CANARY] }],
  ["purge-manifest-recorded", { paths: ["ab".repeat(32), "ab".repeat(32)] }],
  ["purge-path-absent", { path: CANARY }],
  ["purge-path-remains", { path: CANARY }],
  ["source-reconstructed", { appliesTo: ["B1", "B1"], baseCommit: "a1".repeat(20), patchDigest: "ab".repeat(32), identity: "9a".repeat(32) }],
  ["source-reconstructed", { appliesTo: ["B1"], baseCommit: CANARY, patchDigest: "ab".repeat(32), identity: "9a".repeat(32) }],
  ["source-reconstructed", { appliesTo: ["B1"], baseCommit: "a1".repeat(20), patchDigest: CANARY, identity: "9a".repeat(32) }],
  ["source-reconstructed", { appliesTo: ["B1"], baseCommit: "a1".repeat(20), patchDigest: "ab".repeat(32), identity: "whatever it was" }],
  ["source-reconstructed", { appliesTo: ["B1"], baseCommit: "the latest one", patchDigest: "ab".repeat(32), identity: "9a".repeat(32) }],
  ["source-reconstructed", { appliesTo: ["Z9"], baseCommit: "a1".repeat(20), patchDigest: "ab".repeat(32), identity: "9a".repeat(32) }],
  ["source-recorded", { slot: "B1", commit: "the latest one", identity: "9a".repeat(32) }],
  ["source-recorded", { slot: "B1", commit: "a1".repeat(20), identity: "whatever it was" }],
  ["source-recorded", { slot: "Z9", commit: "a1".repeat(20), identity: "9a".repeat(32) }],
  ["fact-recorded", { id: "fact-one", statement: "", evidence: ["row-one"] }],
  ["fact-recorded", { id: "fact-one", statement: "Words.", evidence: ["row-one", "row-one"] }],
  ["fact-recorded", { id: CANARY, statement: "Words.", evidence: ["row-one"] }],
  ["fact-superseded", { fact: "fact-one", statement: "Words.", reason: "  " }],
  ["fact-retracted", { fact: "fact-one", reason: "", unknown: null }],
  ["assertion-retracted", { assertion: "said-one", reason: "Because.", unknown: null }],
  ["interpretation-recorded", { id: "reading-one", statement: "Words.", cites: [{ fact: "fact-one", version: 0 }] }],
  ["unknown-recorded", { unknown: { ...UNKNOWN, reason: "   " } }],
  ["unknown-recorded", { unknown: { ...UNKNOWN, question: "   " } }],
  ["unknown-recorded", { unknown: { ...UNKNOWN, detail: "   " } }],
  ["unknown-recorded", { unknown: { ...UNKNOWN, wouldResolve: "   " } }],
  // What a plan declares: the ids it mints, each once, and none of them nothing.
  ["case-planned", { slots: [{ slot: "B1", attemptId: "the first one" }], controlRunId: CONTROL_RUN_ID, configuration: IDENTITY_ALDER }],
  ["case-planned", { slots: [{ slot: "B1", attemptId: "0".repeat(32) }], controlRunId: CONTROL_RUN_ID, configuration: IDENTITY_ALDER }],
  ["case-planned", { slots: SLOTS, controlRunId: "0".repeat(32), configuration: IDENTITY_ALDER }],
  ["case-planned", { slots: SLOTS, controlRunId: "the control run", configuration: IDENTITY_ALDER }],
  ["case-planned", { slots: SLOTS, controlRunId: null, configuration: IDENTITY_ALDER }],
  ["case-planned", { slots: SLOTS, configuration: IDENTITY_ALDER }],
  ["case-planned", { slots: [SLOTS[0], { slot: "I1", attemptId: ATTEMPT_IDS.B1 }], controlRunId: CONTROL_RUN_ID, configuration: IDENTITY_ALDER }],
  ["case-planned", { slots: SLOTS, controlRunId: ATTEMPT_IDS.I1, configuration: IDENTITY_ALDER }],
  ["case-planned", { slots: SLOTS, controlRunId: ATTEMPT_IDS.B1, configuration: IDENTITY_ALDER }],
  ["control-recorded", { configuration: IDENTITY_ALDER, result: "passed" }],
  // Not the row's shape at all.
  ["evidence-recorded", { row: null }],
  ["evidence-recorded", { row: "a row" }],
  ["evidence-recorded", { row: { ...ROW, window: null } }],
  ["evidence-recorded", { row: { ...ROW, window: "page" } }],
  // A runner's outcome and completeness, each with a reason in the right place.
  ["attempt-finished", { slot: "B1", outcome: "published", reason: "a-code" }],
  ["attempt-finished", { slot: "Z9", outcome: "failed", reason: "a-code" }],
  ["instrument-recorded", { slot: "Z9", instrument: "coverage", completeness: "partial", reason: "a-code" }],
  ["instrument-recorded", { slot: "B1", instrument: CANARY, completeness: "partial", reason: "a-code" }],
  ["instrument-recorded", { slot: "B1", instrument: "coverage", completeness: "mostly", reason: "a-code" }],
  ["instrument-recorded", { slot: "B1", instrument: "coverage", completeness: "complete", reason: "a-code" }],
  ["instrument-recorded", { slot: "B1", instrument: "coverage", completeness: "partial", reason: null }],
  ["instrument-recorded", { slot: "B1", instrument: "coverage", completeness: "missing", reason: CANARY }],
  // A list and a text past their bounds.
  ["fact-recorded", { id: "fact-one", statement: "x".repeat(4097), evidence: ["row-one"] }],
  ["fact-recorded", { id: "fact-one", statement: "Words.", evidence: Array.from({ length: 65 }, (_, index) => `row-${index}`) }]
] as never;

const checkDecoders = (module: typeof productionEvents) => {
  for (const [type, data] of BAD_EVENTS) {
    const answer = module.decodeEvent(rawEvent(type, data));
    holds(DECODES, JSON.stringify(answer) === JSON.stringify({ ok: false, refusal: "malformed-event", at: type }), () => ({ type, data, answer }));
  }
  for (const [name, build] of SLUG_FIELDS) {
    // The field takes a word, so the refusals below are the value's and nothing else's.
    const [goodType, goodData] = build("a-word_1");
    const good = module.decodeEvent(rawEvent(goodType, goodData));
    holds(DECODES, good.ok, () => ({ name, good }));
    for (const value of SLUG_BREAKERS) {
      const [type, data] = build(value);
      const answer = module.decodeEvent(rawEvent(type, data));
      holds(DECODES, JSON.stringify(answer) === JSON.stringify({ ok: false, refusal: "malformed-event", at: type }), () => ({ name, value, answer }));
    }
  }
  const identityBad: readonly (readonly [string, unknown])[] = [
    ["a chromium of prose", { ...IDENTITY_ALDER, chromium: "the one on the box" }],
    ["a scanner of prose", { ...IDENTITY_ALDER, scannerNode: "the one on the box" }]
  ];
  for (const [name, value] of identityBad) holds(DECODES, !module.isConfigurationIdentity(value), () => name);
};

test("decoders hold their values to shape, nested fields included, and a refusal repeats none of them", async () => {
  checkDecoders(productionEvents);
  const events = (find: string, replace: string) => () => checkDecoders(loadVariant<typeof productionEvents>(require.resolve("../core/case-events"), [{ find, replace }]));
  const exact = "(0, canonical_json_1.hasExactly)";
  await assertCaughtBy("a clocked window keeping a field more", DECODES, events(`return ${exact}(value, ["clock", "startMs", "endMs"]) && isSlug(value.clock)`, "return isSlug(value.clock)"));
  await assertCaughtBy("a clockless window keeping a field more", DECODES, events(`return ${exact}(value, ["clock", "note"]) && isSlug(value.note);`, "return isSlug(value.note);"));
  await assertCaughtBy("an observation keeping a field more", DECODES, events(`${exact}(value, ["subject", "count", "granularity", "windowEnd", "scope"]) &&\n        `, ""));
  await assertCaughtBy("a cite keeping a field more", DECODES, events(`isPlain(item) && ${exact}(item, ["fact", "version"]) && isSlug(item.fact)`, "isPlain(item) && isSlug(item.fact)"));
  await assertCaughtBy("an unknown keeping a field more", DECODES, events(`${exact}(value, ["id", "question", "reason", "detail", "wouldResolve"]) &&\n        `, ""));
  await assertCaughtBy("a planned slot keeping a field more", DECODES, events(`isPlain(item) && ${exact}(item, ["slot", "attemptId"]) && isSlot(item.slot)`, "isPlain(item) && isSlot(item.slot)"));
  await assertCaughtBy("a row keeping a field more", DECODES, events(`if (!${exact}(value, ["id", "slot", "instrument", "state", "window", "limits", "digest", "observation"]))\n        return false;`, ""));
  await assertCaughtBy("a slug holding what a URL needs", DECODES, events("const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;", "const SLUG = /^[a-z0-9][a-z0-9_.\\/@=?-]{0,63}$/;"));
  await assertCaughtBy("a recorded commit of any shape", DECODES, events('isSlot(data.slot) && typeof data.commit === "string" && COMMIT.test(data.commit) && (0, case_log_1.isDigest)(data.identity)', 'isSlot(data.slot) && typeof data.commit === "string" && (0, case_log_1.isDigest)(data.identity)'));
  await assertCaughtBy("a recorded identity of any shape", DECODES, events('isSlot(data.slot) && typeof data.commit === "string" && COMMIT.test(data.commit) && (0, case_log_1.isDigest)(data.identity)', 'isSlot(data.slot) && typeof data.commit === "string" && COMMIT.test(data.commit) && typeof data.identity === "string"'));
  await assertCaughtBy("a reconstructed identity of any shape", DECODES, events('(0, case_log_1.isDigest)(data.patchDigest) && (0, case_log_1.isDigest)(data.identity)', '(0, case_log_1.isDigest)(data.patchDigest) && typeof data.identity === "string"'));
  await assertCaughtBy("a chromium of any shape", DECODES, events('typeof value.chromium === "string" &&\n        VERSION.test(value.chromium) &&', 'typeof value.chromium === "string" &&'));
  await assertCaughtBy("a scanner node of any shape", DECODES, events('typeof value.scannerNode === "string" &&\n        VERSION.test(value.scannerNode) &&', 'typeof value.scannerNode === "string" &&'));
  await assertCaughtBy("an assertion's id of any shape", DECODES, events('(0, canonical_json_1.hasExactly)(data, ["id", "statement"]) && isSlug(data.id)', '(0, canonical_json_1.hasExactly)(data, ["id", "statement"]) && typeof data.id === "string"'));
  await assertCaughtBy("an interpretation's id of any shape", DECODES, events('(0, canonical_json_1.hasExactly)(data, ["id", "statement", "cites"]) && isSlug(data.id)', '(0, canonical_json_1.hasExactly)(data, ["id", "statement", "cites"]) && typeof data.id === "string"'));
  await assertCaughtBy("an unknown's id of any shape", DECODES, events('"wouldResolve"]) &&\n        isSlug(value.id) &&', '"wouldResolve"]) &&\n        typeof value.id === "string" &&'));
  await assertCaughtBy("a plan's ids allowed to repeat", DECODES, events("isPlanId(data.controlRunId) && plannedIdsAreDistinct(data.slots, data.controlRunId) &&", "isPlanId(data.controlRunId) &&"));
  await assertCaughtBy("a control id of any shape", DECODES, events("isPlanId(data.controlRunId) && plannedIdsAreDistinct(data.slots, data.controlRunId) &&", 'typeof data.controlRunId === "string" && plannedIdsAreDistinct(data.slots, data.controlRunId) &&'));
  await assertCaughtBy("an all-zero id taken", DECODES, events("return (0, actor_1.isAttemptId)(value) && value !== ALL_ZERO_ID;", "return (0, actor_1.isAttemptId)(value);"));
  assert.deepEqual(digestsNamed({ type: "case-deadline" }), []);
  // At the bounds, each is still what it is: the longest text, the longest list, and a window with no width.
  assert.ok(decodeEvent(logEvent("fact-recorded", { id: "fact-one", statement: "x".repeat(4096), evidence: ["row-one"] })).ok);
  assert.ok(decodeEvent(logEvent("fact-recorded", { id: "fact-one", statement: "Words.", evidence: Array.from({ length: 64 }, (_, index) => `row-${index}`) })).ok);
  assert.ok(decodeEvent(logEvent("evidence-recorded", { row: { ...ROW, window: { clock: "page", startMs: 5, endMs: 5 } } as never })).ok);
  // A value that is no event at all, as an untyped caller could send, is refused and not thrown on.
  for (const value of [null, "an event", 7, [], { type: 7, data: {} }, { type: "reconcile" }, { type: "reconcile", data: [] }, { type: "reconcile", data: null }]) {
    assert.deepEqual(decodeEvent(value as unknown as LogEvent), { ok: false, refusal: "malformed-event", at: "event" }, JSON.stringify(value));
  }
});

test("open (a stated limit): a fact's link limits are what limited its reading when it was recorded, so a fact taken during capture keeps cleanup_unresolved after the outcome", async () => {
  const { owner } = await fresh();
  const zero = { ...rowOn("row-page"), observation: { subject: "subject-lantern", count: 0, granularity: "block", windowEnd: "window_closed", scope: "in_scope" } };
  const visit = [...FROZEN, met(), start("B1"), began("B1"), { as: "B1" as ScriptActor, event: logEvent("evidence-recorded", { row: zero as never }) }, { as: "B1" as ScriptActor, event: logEvent("instrument-recorded", { slot: "B1", instrument: "coverage", completeness: "complete", reason: null }) }];
  const fact = owned("fact-recorded", { id: "fact-page", statement: "Nothing ran in this window.", evidence: ["row-page"] });
  const outcomes: readonly (readonly [string, readonly ScriptCommand[], unknown, readonly string[]])[] = [
    ["walled", [...ended("B1", "walled"), clean("B1")], { reading: "zero_in_window", granularity: "block", windowEnd: "window_closed", complete: false, limits: ["attempt_walled"] }, ["attempt_walled"]],
    ["failed", [...ended("B1", "failed"), clean("B1")], { reading: "unknown", reason: "operation_failed", complete: false, limits: ["operation_failed"] }, ["operation_failed"]],
    ["cancelled", [cancel], { reading: "unknown", reason: "operation_failed", complete: false, limits: ["cleanup_unresolved", "operation_failed"] }, ["cleanup_unresolved", "operation_failed"]]
  ];
  for (const [phase, outcome, readingNow, linkAfter] of outcomes) {
    const before = await caseFor(production, memoryStores(), owner, [...visit, fact, ...outcome]);
    const afterwards = await caseFor(production, memoryStores(), owner, [...visit, ...outcome, fact]);
    const { record, machine } = before.state as NonNullable<OpenCase["state"]>;
    assert.equal(machine.attempts.find(({ slot }) => slot === "B1")?.phase, phase);
    // Taken while the attempt ran, the link says what limited the 0 then, and keeps saying it.
    assert.deepEqual(record.facts[0].links[0].limits, ["cleanup_unresolved"], phase);
    // The row's reading now, and the same fact taken after the outcome, name the outcome.
    assert.deepEqual(readRow(record, machine, record.rows[0]), readingNow, phase);
    assert.deepEqual((afterwards.state as NonNullable<OpenCase["state"]>).record.facts[0].links[0].limits, linkAfter, phase);
  }
});

test("open (a stated limit): a slug is a shape and nothing more, so a lower-case word a capture held would fit one", () => {
  // Case and punctuation are what it refuses. Meaning is out of its reach: these are canaries, and they pass.
  for (const word of ["canary-query-value-9c1b", "alice-person", "secret_token_1"]) {
    assert.ok(decodeEvent(rawEvent("evidence-recorded", { row: { ...ROW, id: word } as never })).ok, word);
    assert.ok(decodeEvent(rawEvent("attempt-finished", { slot: "B1", outcome: "failed", reason: word })).ok, word);
  }
  // In upper case, as the fixture's own canaries are, the same word is refused.
  assert.equal(decodeEvent(rawEvent("evidence-recorded", { row: { ...ROW, id: "CANARY-QUERY-VALUE-9C1B" } as never })).ok, false);
});

test("rows for an aggregate come out of a whole case, with each slot under the configuration it ran or closed under", async () => {
  const { owner } = await fresh();
  const stores = memoryStores();
  const marks = await runScript({ stores, caseId: CASE_A, actorOf: actorsFor(owner), now: risingClock(startAt), commands: CASE_SCRIPT });
  const rows = aggregateRowsOfCase(marks.last.state as NonNullable<OpenCase["state"]>);
  assert.deepEqual(
    rows.map(({ slot, keys }) => [slot, keys.release, keys.commit]),
    [
      ["B1", IDENTITY_ALDER.reaRelease, IDENTITY_ALDER.commit],
      ["B2", IDENTITY_BIRCH.reaRelease, IDENTITY_BIRCH.commit],
      ["B3", IDENTITY_BIRCH.reaRelease, IDENTITY_BIRCH.commit],
      ["I1", IDENTITY_BIRCH.reaRelease, IDENTITY_BIRCH.commit],
      ["I2", IDENTITY_BIRCH.reaRelease, IDENTITY_BIRCH.commit],
      ["I3", IDENTITY_BIRCH.reaRelease, IDENTITY_BIRCH.commit]
    ]
  );
  assert.deepEqual(rows.map(({ basis }) => basis), ["control", "exception", "control", "control", "control", "not_visited"]);
  // Closed with no control and no visit, and closed with an exception no visit used: no row says control or exception, and the denominator keeps them all.
  const measure = { id: "measure-one", subject: "subject-lantern", population: null, keys: { heldEqual: ["commit", "configuration", "release"], allowedToVary: [{ key: "arm", reason: "Both arms." }], unknown: [] } };
  for (const [name, before] of [["no control and no visit", FROZEN], ["an exception no visit used", [...FROZEN, owned("exception-recorded", { slot: "B1", reason: "Because." })]]] as const) {
    const closing = await runScript({ stores: memoryStores(), caseId: CASE_A, actorOf: actorsFor(owner), now: risingClock(startAt), commands: [...before, owned("case-cancelled")] });
    const unvisited = aggregateRowsOfCase(closing.last.state as NonNullable<OpenCase["state"]>);
    assert.deepEqual([...new Set(unvisited.map(({ basis }) => basis))], ["not_visited"], name);
    const groups = aggregate(unvisited, measure);
    assert.ok(groups.ok, name);
    assert.deepEqual(groups.groups.map(({ group, of, notStarted, unknown }) => [group.basis, of, notStarted, unknown]), [["ordinary", 6, 6, 6]], name);
  }
});
