import assert from "node:assert/strict";
import { before, test } from "node:test";
import { assertCaughtBy, holds, loadVariant, type SourceEdit } from "../../lib/finite-check";
import type { Actor } from "../core/actor";
import * as aggregatesModule from "../core/aggregates";
import { aggregate, evidenceForAttempt, type Measure, type MeasureKeys } from "../core/aggregates";
import { appendCommand, openLog } from "../core/case-log";
import * as machineModule from "../core/case-machine";
import { continuationOf, denominatorOf, OUTCOMES, type Cleanup, type MachineState, type Outcome, type SlotName } from "../core/case-machine";
import * as storeModule from "../core/case-store";
import { aggregateRowsOfCase, openCase, runCommand, type CaseState, type OpenCase } from "../core/case-store";
import * as evidenceModule from "../core/evidence-model";
import { EMPTY_RECORD, readRow, type EvidenceRow, type Fact, type Interpretation } from "../core/evidence-model";
import { orderOf } from "../core/readings";
import {
  accepted,
  actorsFor,
  CASE_SCRIPT,
  CONFIG_ALDER_KEY,
  CONFIG_BIRCH_KEY,
  captureOf,
  controlMet,
  digestOfRaw,
  driven,
  FIXED_COMMIT,
  frozen,
  IDENTITY_ALDER,
  IDENTITY_BIRCH,
  logEvent,
  OWNER,
  planOf,
  RAW_OBJECTS,
  RECONSTRUCTED_COMMIT,
  RECONSTRUCTED_IDENTITY,
  RECORDED_IDENTITY,
  RETRACT_ASSERTION_COMMAND,
  risingClock,
  runnerOf,
  runScript,
  startOf,
  SUPERSEDE_COMMAND,
  type ScriptCommand
} from "./case-fixture";
import { CASE_A, sha256OfText, verifiedOwnerActor } from "./log-fixture";
import { memoryStores, type MemoryStores } from "./memory-log-store";
import { NOW_MS } from "./token-fixture";

/**
 * M1's acceptance checks A2, A3, A4, A7, A9, A10 and A12, ported to a generic case. The fixture
 * is invented, and every expected value is spelled out here. Each check says what it ports
 * and what changed. A check's broken variants are caught under that check's own property.
 *
 * M1 read an import of one real case's files. These read a case run command by command,
 * so M1's checks of an importer's refusals become checks of the commands and the fold.
 */

let owner: Actor;
let actorOf: (as: Parameters<ReturnType<typeof actorsFor>>[0]) => Actor;
let stores: MemoryStores;
let marks: ReadonlyMap<string, OpenCase> & { last: OpenCase };
const later = risingClock(NOW_MS + 200_000);

before(async () => {
  owner = await verifiedOwnerActor();
  actorOf = actorsFor(owner);
  stores = memoryStores();
  marks = await runScript({ stores, caseId: CASE_A, actorOf, now: risingClock(NOW_MS + 1000), commands: CASE_SCRIPT });
});

const stateAt = (mark: string): CaseState => (marks.get(mark) as OpenCase).state as CaseState;
const closed = (): CaseState => marks.last.state as CaseState;
const attempt = (state: CaseState, slot: SlotName) => state.machine.attempts.find((candidate) => candidate.slot === slot) as MachineState["attempts"][number];
const rowOf = (state: CaseState, id: string) => state.record.rows.find((row) => row.id === id) as EvidenceRow;

/** An independent copy of the closed case's stores, for a check that goes on to change it, with the case opened on that copy, since a case is registered with the stores it came from. */
async function branch(): Promise<Readonly<{ on: MemoryStores; current: OpenCase }>> {
  const on = memoryStores();
  for (const [address, bytes] of stores.entries.objects) on.entries.objects.set(address, bytes);
  for (const [address, bytes] of stores.evidence.objects) on.evidence.objects.set(address, bytes);
  on.head.value = stores.head.value;
  const opened = await openCase(on, CASE_A);
  assert.ok(opened.ok);
  return { on, current: opened.case };
}

async function commanded(on: MemoryStores, current: OpenCase, command: ScriptCommand): Promise<OpenCase> {
  const answer = await runCommand(on, current, { actor: actorOf(command.as), event: command.event, now: later });
  assert.ok(answer.ok, answer.ok ? "" : `${command.event.type}: ${answer.refusal}`);
  return answer.case;
}

// A2. Ports "denominator: 13 attempts, 12 usable, 1 incomplete, with A12's reason".
// Changed: M1 counted attempts it was handed, so planned could only be their number. Here
// planned comes from the plan and not_started is reachable, so the sum is held at every point of
// the case. The reason is a code the runner reports, not a sentence, since a sentence from a
// capture could carry text. A lost output is still recorded as missing, with no row from it.

const A2 = "A2 the denominator counts every planned attempt, whatever became of it, with its reasons";

const checkA2Reasons = async (store: typeof storeModule) => {
  const reopened = await store.openCase(stores, CASE_A);
  holds(A2, reopened.ok, () => reopened);
  const reasons = reopened.ok ? (reopened.case.state as CaseState).record.acquisitionReasons : [];
  holds(A2, JSON.stringify(reasons) === JSON.stringify([{ slot: "I1", reason: "instrument-output-lost" }, { slot: "I2", reason: "target-crashed" }]), () => reasons);
};

const checkA2 = (machine: typeof machineModule, state: CaseState) => {
  const counted = machine.denominatorOf(state.machine);
  holds(A2, JSON.stringify(counted) === JSON.stringify({ planned: 6, running: 0, notStarted: 1, waiting: 0, usable: 3, walled: 0, failed: 1, incomplete: 1, timed_out: 0, cancelled: 0 }), () => counted);
  holds(A2, counted.planned === counted.running + counted.notStarted + counted.usable + counted.walled + counted.failed + counted.incomplete + counted.timed_out + counted.cancelled, () => counted);
};

test("A2 the denominator, at the end of the case and on the way there", () => {
  checkA2(machineModule, closed());
  assert.deepEqual(denominatorOf(stateAt("frozen").machine), { planned: 6, running: 0, notStarted: 6, waiting: 6, usable: 0, walled: 0, failed: 0, incomplete: 0, timed_out: 0, cancelled: 0 });
  assert.deepEqual(denominatorOf(stateAt("b1-done").machine), { planned: 6, running: 0, notStarted: 5, waiting: 5, usable: 1, walled: 0, failed: 0, incomplete: 0, timed_out: 0, cancelled: 0 });
  assert.deepEqual(denominatorOf(stateAt("baseline-ended").machine), { planned: 6, running: 0, notStarted: 3, waiting: 3, usable: 3, walled: 0, failed: 0, incomplete: 0, timed_out: 0, cancelled: 0 });
  const record = closed().record;
  assert.deepEqual(record.acquisitionReasons, [{ slot: "I1", reason: "instrument-output-lost" }, { slot: "I2", reason: "target-crashed" }]);
  assert.equal(attempt(closed(), "I1").phase, "incomplete");
  assert.deepEqual(record.instruments.filter(({ slot }) => slot === "I1"), [
    { slot: "I1", instrument: "coverage", completeness: "partial", reason: "budget-reached" },
    { slot: "I1", instrument: "inspect", completeness: "missing", reason: "output-lost" }
  ]);
  assert.equal(record.rows.some((row) => row.slot === "I1" && row.instrument === "inspect"), false, "a lost output gives no row");
});

test("A2 catches a dropped not_started and a lost reason", async () => {
  const machineVariant = (...edits: SourceEdit[]) => loadVariant<typeof machineModule>(require.resolve("../core/case-machine"), edits);
  await assertCaughtBy("dropping not_started", A2, () => checkA2(machineVariant({ find: 'notStarted: count((phase) => phase === "planned" || phase === "not_started"),', replace: 'notStarted: count((phase) => phase === "planned"),' }), closed()));
  await assertCaughtBy("an outcome miscounted", A2, () => checkA2(machineVariant({ find: 'usable: count((phase) => phase === "usable"),', replace: 'usable: count((phase) => phase === "incomplete"),' }), closed()));
  await checkA2Reasons(storeModule);
  await assertCaughtBy("a lost reason", A2, () =>
    checkA2Reasons(
      loadVariant<typeof storeModule>(require.resolve("../core/case-store"), [
        { find: "const record = event.reason === null ? state.record : Object.assign(Object.assign({}, state.record), { acquisitionReasons: [...state.record.acquisitionReasons, { slot: event.slot, reason: event.reason }] });", replace: "const record = state.record;" }
      ])
    )
  );
});

// A3. Ports "acquisition, completeness, cleanup and continuation are independent".
// Changed: M1 read a historical import, whose cleanup was not_recorded or partly_recorded, and
// whose gate only said what it would have done. Here the machine holds the plan's four cleanup
// states and blocks the next attempt for real, and the independence is walked over the
// whole product rather than three attempts. Historical cleanup values belong to the adapter.

const A3 = "A3 acquisition, completeness, cleanup and continuation are independent";

const CLEANUPS: readonly Cleanup[] = ["pending", "confirmed", "unconfirmed", "environment_destroyed"];
const COMPLETENESS = ["complete", "partial", "missing"] as const;

/** One attempt driven to this outcome and this cleanup, with the next slot still waiting. */
function atOutcome(machine: typeof machineModule, outcome: Outcome, cleanup: Cleanup): MachineState {
  const by = runnerOf("I1");
  const opened = driven(machine, A3, planOf("I1", "I2"), frozen, controlMet(), startOf("I1"), ...captureOf("I1"));
  const ended: MachineState =
    outcome === "timed_out"
      ? accepted(machine, A3, opened, { type: "attempt-deadline", slot: "I1", by: OWNER })
      : outcome === "cancelled"
        ? accepted(machine, A3, opened, { type: "case-cancelled", by: OWNER })
        : accepted(machine, A3, opened, { type: "attempt-finished", slot: "I1", outcome, by });
  if (cleanup === "pending") return ended;
  const type = cleanup === "confirmed" ? "cleanup-confirmed" : cleanup === "unconfirmed" ? "cleanup-unconfirmed" : "environment-destroyed";
  return accepted(machine, A3, ended, { type, slot: "I1", by: OWNER });
}

const checkIndependence = (machine: typeof machineModule) => {
  let combinations = 0;
  for (const outcome of OUTCOMES) {
    for (const cleanup of CLEANUPS) {
      for (const completeness of COMPLETENESS) {
        combinations += 1;
        const state = atOutcome(machine, outcome, cleanup);
        const [first] = state.attempts;
        const input = () => ({ outcome, cleanup, completeness });
        holds(A3, first.phase === outcome, input);
        holds(A3, first.cleanup === cleanup, input);
        // Continuation reads cleanup alone. A cancel closed the case, so there is nothing to continue.
        const expected = outcome === "cancelled" ? "not_applicable" : cleanup === "pending" || cleanup === "unconfirmed" ? "blocked" : "allowed";
        const continuation = machine.continuationOf(state).continuation;
        holds(A3, continuation === expected, () => ({ ...input(), continuation }));
        // A captured count stays observed, whatever acquisition, completeness and cleanup say.
        if (completeness !== "missing") {
          const row: EvidenceRow = { id: "row-one", slot: "I1", instrument: "coverage", state: "present", window: { clock: "page", startMs: 1, endMs: 2 }, limits: [], digest: "ab".repeat(32), observation: { subject: "subject-one", count: 4, granularity: "block", windowEnd: "window_closed", scope: "in_scope" } };
          const record = { ...EMPTY_RECORD, rows: [row], instruments: [{ slot: "I1" as const, instrument: "coverage", completeness, reason: completeness === "complete" ? null : "budget-reached" }] };
          const reading = readRow(record, state, row);
          holds(A3, reading.reading === "observed" && reading.count === 4, () => ({ ...input(), reading }));
        }
      }
    }
  }
  holds(A3, combinations === 6 * 4 * 3, () => combinations);
};

test("A3 on the case: usable with partial coverage and unconfirmed cleanup, which blocks the next attempt and nothing else", () => {
  const blocked = stateAt("b3-unconfirmed");
  assert.equal(attempt(blocked, "B3").phase, "usable");
  assert.equal(attempt(blocked, "B3").cleanup, "unconfirmed");
  assert.deepEqual(blocked.record.instruments.find(({ slot, instrument }) => slot === "B3" && instrument === "coverage"), { slot: "B3", instrument: "coverage", completeness: "partial", reason: "budget-reached" });
  assert.deepEqual(continuationOf(blocked.machine), { continuation: "blocked", reason: "cleanup_unresolved", slots: ["B3"] });
  // The row it captured reads as captured.
  const reading = readRow(blocked.record, blocked.machine, rowOf(blocked, "row-b3-coverage"));
  assert.deepEqual(reading, { reading: "observed", count: 3, granularity: "block", windowEnd: "window_closed", complete: false, limits: ["coverage_not_complete", "cleanup_unresolved"] });
  assert.equal(rowOf(blocked, "row-b3-coverage").state, "present");

  // Another attempt: usable, confirmed, complete, and nothing in the way.
  const clear = stateAt("b1-done");
  assert.equal(attempt(clear, "B1").phase, "usable");
  assert.equal(attempt(clear, "B1").cleanup, "confirmed");
  assert.deepEqual(continuationOf(clear.machine), { continuation: "allowed" });
  assert.deepEqual(readRow(clear.record, clear.machine, rowOf(clear, "row-b1-coverage")), { reading: "observed", count: 12, granularity: "block", windowEnd: "window_closed", complete: true, limits: [] });

  // And one that was incomplete, whose environment went away: acquisition stays, and so does what it captured.
  const ended = stateAt("i2-ended");
  assert.equal(attempt(ended, "I1").phase, "incomplete");
  assert.equal(attempt(ended, "I1").cleanup, "environment_destroyed");
  assert.deepEqual(continuationOf(ended.machine), { continuation: "allowed" });
  assert.equal(rowOf(ended, "row-i1-coverage").state, "present");
});

test("A3 over every combination of outcome, cleanup and completeness", async () => {
  checkIndependence(machineModule);
  const variant = (...edits: SourceEdit[]) => loadVariant<typeof machineModule>(require.resolve("../core/case-machine"), edits);
  await assertCaughtBy("the rejected rule capping an attempt at incomplete", A3, () => checkIndependence(variant({ find: 'return accept(withAttempt(state, index, { cleanup: "unconfirmed" }));', replace: 'return accept(withAttempt(state, index, { cleanup: "unconfirmed", phase: "incomplete" }));' })));
  await assertCaughtBy("continuation reading the outcome", A3, () => checkIndependence(variant({ find: 'return slots.length > 0 ? { continuation: "blocked", reason: "cleanup_unresolved", slots } : { continuation: "allowed" };', replace: 'return slots.length > 0 || state.attempts.some(({ phase }) => phase === "failed") ? { continuation: "blocked", reason: "cleanup_unresolved", slots } : { continuation: "allowed" };' })));
  await assertCaughtBy("unconfirmed cleanup not blocking", A3, () => checkIndependence(variant({ find: 'return cleanup === "pending" || cleanup === "unconfirmed";', replace: 'return cleanup === "pending";' })));
});

// A4. Ports "missing and reconstructed source identities stay distinct, and none is guessed".
// Changed: M1 checked an importer's seed. Its four refused guesses become commands: filling in a
// missing slot is a second block, refused; claiming one observed is a recorded identity from
// outside that attempt or after it ran, refused; a wrong patch digest is an object the log
// cannot find; and an "observed" state is a field no event has. A third state, recorded, is
// new: it is what the runner writes as it runs, which is the gap this exists to close.

const A4 = "A4 missing, reconstructed and recorded source identities stay distinct, and none is guessed";

const checkA4 = (evidence: typeof evidenceModule, state: CaseState) => {
  const reading = (slot: SlotName) => JSON.stringify(evidence.sourceIdentityOf(state.record, slot));
  const reconstructed = JSON.stringify({ state: "reconstructed", baseCommit: RECONSTRUCTED_COMMIT, patchDigest: digestOfRaw("raw-patch"), identity: RECONSTRUCTED_IDENTITY });
  for (const slot of ["B1", "I3"] as const) holds(A4, reading(slot) === '{"state":"not_recorded"}', () => ({ slot, reading: reading(slot) }));
  for (const slot of ["B2", "I1", "I2"] as const) holds(A4, reading(slot) === reconstructed, () => ({ slot, reading: reading(slot) }));
  holds(A4, reading("B3") === JSON.stringify({ state: "recorded", commit: FIXED_COMMIT, identity: RECORDED_IDENTITY }), () => reading("B3"));
};

test("A4 each slot's source identity reads what was shown of it, and a slot nothing covers holds no identity", async () => {
  checkA4(evidenceModule, closed());
  // Attempts carry no identity. Only the block and what the runner recorded hold one.
  assert.equal(JSON.stringify(closed().machine).includes(RECONSTRUCTED_IDENTITY), false);
  assert.equal(JSON.stringify(closed().machine).includes(RECORDED_IDENTITY), false);
  const variant = (...edits: SourceEdit[]) => loadVariant<typeof evidenceModule>(require.resolve("../core/evidence-model"), edits);
  await assertCaughtBy("a missing identity filled in from the block", A4, () => checkA4(variant({ find: "if (block === null || block === void 0 ? void 0 : block.appliesTo.includes(slot))", replace: "if (block)" }), closed()));
  await assertCaughtBy("a recorded identity read as reconstructed", A4, () => checkA4(variant({ find: 'if (recorded !== undefined)\n        return { state: "recorded", commit: recorded.commit, identity: recorded.identity };', replace: "" }), closed()));
});

test("A4 every way of guessing is refused", async () => {
  const { on, current } = await branch();
  const now = later;
  const block = (appliesTo: readonly SlotName[], patchDigest = digestOfRaw("raw-patch"), extra: Record<string, unknown> = {}) => logEvent("source-reconstructed", { appliesTo: appliesTo as never, baseCommit: RECONSTRUCTED_COMMIT, patchDigest, identity: RECONSTRUCTED_IDENTITY, ...(extra as object) });
  // B1 filled in as reconstructed.
  assert.deepEqual(await runCommand(on, current, { actor: owner, event: block(["B1"]), now }), { ok: false, refusal: "source-already-reconstructed", at: null });
  // B1 claimed as recorded, by the owner, and by its own runner long after it ran.
  const claim = logEvent("source-recorded", { slot: "B1", commit: FIXED_COMMIT, identity: RECORDED_IDENTITY });
  assert.deepEqual(await runCommand(on, current, { actor: owner, event: claim, now }), { ok: false, refusal: "not-this-attempt", at: "slot" });
  assert.deepEqual(await runCommand(on, current, { actor: actorOf("B1"), event: claim, now }), { ok: false, refusal: "source-after-attempt", at: "slot" });
  // Ahead of a visit, and of a visit that never ran: nothing happened yet to reconstruct.
  const fresh = memoryStores();
  const b1Done = CASE_SCRIPT.findIndex(({ mark }) => mark === "b1-done");
  const started = await runScript({ stores: fresh, caseId: CASE_A, actorOf, now: risingClock(NOW_MS + 1000), commands: CASE_SCRIPT.slice(0, b1Done + 1) });
  assert.deepEqual(await runCommand(fresh, started.last, { actor: owner, event: block(["B2"]), now }), { ok: false, refusal: "source-attempt-not-ended", at: "appliesTo" });
  assert.deepEqual(await runCommand(on, current, { actor: owner, event: block(["I3"]), now }), { ok: false, refusal: "source-attempt-not-ended", at: "appliesTo" });
  // A wrong patch digest: nothing is stored under it.
  assert.deepEqual(await runCommand(fresh, started.last, { actor: owner, event: block(["B1"], "7e".repeat(32)), now }), { ok: false, refusal: "evidence-missing", at: "7e".repeat(32) });
  // An observed identity overall: there is no such field.
  assert.deepEqual(await runCommand(fresh, started.last, { actor: owner, event: block(["B1"], digestOfRaw("raw-patch"), { state: "observed" }), now }), { ok: false, refusal: "malformed-event", at: "source-reconstructed" });
  // A changed patch fails its digest on every open afterward.
  const patched = await runCommand(fresh, started.last, { actor: owner, event: block(["B1"]), now });
  assert.ok(patched.ok);
  fresh.evidence.objects.set(digestOfRaw("raw-patch"), new TextEncoder().encode("another patch"));
  assert.deepEqual(await openCase(fresh, CASE_A), { ok: false, refusal: "evidence-changed", at: digestOfRaw("raw-patch") });
});

// A7. Ports "unknowns show with reasons, and a no_record row cannot become a fact".
// Changed: M1's importer refused a fact on a no_record row. A command does here, and so does a
// fold, for an entry written past the commands. A row's other unread states are refused alike,
// and the row reads as unknown with its own state as the reason, not a phrase in a value.

const A7 = "A7 unknowns show with reasons, and a no_record row never becomes a fact";

const checkFactsRest = (state: CaseState) => {
  holds(A7, state.record.facts.length === 2, () => state.record.facts);
  for (const fact of state.record.facts) {
    holds(A7, fact.links.length > 0, () => fact);
    for (const { evidence } of fact.links) holds(A7, rowOf(state, evidence).state === "present", () => ({ fact: fact.id, evidence }));
  }
};

test("A7 unknowns carry their reasons, and a no_record row reads unknown and cannot become a fact", async () => {
  const state = closed();
  assert.deepEqual(state.record.unknowns, [{ kind: "unknown", id: "unknown-author", question: "Who wrote the routine?", reason: "No capture establishes authorship.", detail: null, wouldResolve: null }]);
  checkFactsRest(state);

  const noRecord = rowOf(state, "row-i2-nothing");
  assert.equal(noRecord.state, "no_record");
  assert.deepEqual(readRow(state.record, state.machine, noRecord), { reading: "unknown", reason: "no_record", complete: false });
  // The late rule here is ours, and the plan's rule wins: a count above 0 stays observed. So a late row that saw something reads
  // observed, with late as a limit and complete withheld, and can back a fact with that limit on its link. A late 0 says nothing.
  const late = rowOf(state, "row-i1-late");
  assert.equal(late.state, "late", "it arrived after its attempt ended, whatever it claimed");
  assert.deepEqual(readRow(state.record, state.machine, late), { reading: "observed", count: 2, granularity: "block", windowEnd: "window_closed", complete: false, limits: ["coverage_not_complete", "attempt_incomplete", "late"] });
  assert.deepEqual(readRow(state.record, state.machine, { ...late, observation: { ...(late.observation as NonNullable<EvidenceRow["observation"]>), count: 0 } }), { reading: "unknown", reason: "late", complete: false });

  const { on, current } = await branch();
  const facts = logEvent("fact-recorded", { id: "fact-absent", statement: "The routine did not run in the third baseline attempt.", evidence: ["row-i2-nothing"] });
  assert.deepEqual(await runCommand(on, current, { actor: owner, event: facts, now: later }), { ok: false, refusal: "row-not-present", at: "evidence" });
  const mixed = logEvent("fact-recorded", { id: "fact-absent", statement: "Words.", evidence: ["row-b1-coverage", "row-i2-nothing"] });
  assert.deepEqual(await runCommand(on, current, { actor: owner, event: mixed, now: later }), { ok: false, refusal: "row-not-present", at: "evidence" });
  const lateBranch = await branch();
  const backed = await commanded(lateBranch.on, lateBranch.current, { as: "owner", event: logEvent("fact-recorded", { id: "fact-late", statement: "It also ran after the window.", evidence: ["row-i1-late"] }) });
  assert.deepEqual((backed.state as CaseState).record.facts.at(-1)?.links, [{ evidence: "row-i1-late", slot: "I1", instrument: "coverage", window: late.window, limits: ["main-frame-only", "coverage_not_complete", "attempt_incomplete", "late"] }]);

  // Written past the commands, as another writer could. The fold refuses it, rather than reading it as a fact or skipping it.
  const past = await appendCommand(on, { caseId: CASE_A, actor: owner, events: [facts], evidence: [], expectedHead: marks.last.head, now: later });
  assert.ok(past.ok);
  const opened = await openCase(on, CASE_A);
  assert.deepEqual(opened, { ok: false, refusal: "row-not-present", at: "evidence" });

  // An unknown with no reason is no unknown.
  const blank = logEvent("unknown-recorded", { unknown: { id: "unknown-two", question: "What is it?", reason: "   ", detail: null, wouldResolve: null } });
  const blankBranch = await branch();
  assert.deepEqual(await runCommand(blankBranch.on, blankBranch.current, { actor: owner, event: blank, now: later }), { ok: false, refusal: "malformed-event", at: "unknown-recorded" });
});

test("A7 catches a no_record row becoming a fact", async () => {
  const check = (evidence: typeof evidenceModule) => {
    const state = closed();
    const answer = evidence.applyRecordEvent(state.record, { type: "fact-recorded", id: "fact-absent", statement: "Words.", evidence: ["row-i2-nothing"] }, OWNER, state.machine, 99);
    holds(A7, !answer.ok && answer.refusal === "row-not-present" && answer.at === "evidence", () => answer);
  };
  check(evidenceModule);
  await assertCaughtBy("a no_record row becoming a fact", A7, () => check(loadVariant<typeof evidenceModule>(require.resolve("../core/evidence-model"), [{ find: 'if (row.state !== "present" && !isLatePositive(row))\n            return refuse("row-not-present", "evidence");', replace: "" }])));
});

// A9. Ports "superseding F5 keeps evidence, keeps v1, and flags only its dependents".
// Changed: no public claim is flagged, since there are none, by the owner's ruling. "Who" is
// gone from the command, since the entry's actor says it. The fixture has two dependents, one
// citing the fact second, and one interpretation that does not cite it. Reaffirming, which M1
// left for later, is here, and it is interpretation review and nothing else.

const A9 = "A9 a supersede keeps the evidence and the old version, and flags only its dependents";

const checkA9 = (before: CaseState, after: CaseState) => {
  holds(A9, JSON.stringify(after.record.rows) === JSON.stringify(before.record.rows), () => "rows changed");
  holds(A9, JSON.stringify(after.machine) === JSON.stringify(before.machine), () => "attempts changed");
  const fact = after.record.facts.find(({ id }) => id === "fact-lantern-host") as Fact;
  holds(A9, fact.version === 2 && fact.status === "current" && fact.statement === "The lantern script's URL names the first-party host.", () => fact);
  holds(A9, fact.history.length === 1 && fact.history[0].version === 1 && fact.history[0].statement === "The lantern script was served from its first-party host.", () => fact.history);
  const review = (id: string) => after.record.interpretations.find((item) => item.id === id) as Interpretation;
  holds(A9, review("reading-host").review === "needs_review", () => review("reading-host"));
  holds(A9, review("reading-both").review === "needs_review", () => review("reading-both"));
  holds(A9, review("reading-ran").review === "current" && review("reading-ran").flags.length === 0, () => review("reading-ran"));
  holds(A9, JSON.stringify(review("reading-both").cites) === JSON.stringify([{ fact: "fact-lantern-ran", version: 1 }, { fact: "fact-lantern-host", version: 1 }]), () => review("reading-both").cites);
};

test("A9 a supersede, reopened, keeps every byte of evidence and flags exactly its dependents, until they are reaffirmed", async () => {
  const { on, current } = await branch();
  const beforeBytes = new Map([...on.evidence.objects].map(([address, bytes]) => [address, new TextDecoder().decode(bytes)]));
  for (const [label, text] of Object.entries(RAW_OBJECTS)) assert.equal(beforeBytes.get(digestOfRaw(label)), text, label);

  const superseded = await commanded(on, current, SUPERSEDE_COMMAND);
  const reopened = await openCase(on, CASE_A);
  assert.ok(reopened.ok);
  checkA9(closed(), superseded.state as CaseState);
  checkA9(closed(), reopened.case.state as CaseState);
  assert.deepEqual(new Map([...on.evidence.objects].map(([address, bytes]) => [address, new TextDecoder().decode(bytes)])), beforeBytes, "evidence bytes do not change");

  // A blank reason is refused, and so is a typed name, and neither is written.
  const blank = logEvent("fact-superseded", { fact: "fact-lantern-ran", statement: "Other words.", reason: "  " });
  assert.deepEqual(await runCommand(on, superseded, { actor: owner, event: blank, now: later }), { ok: false, refusal: "malformed-event", at: "fact-superseded" });
  const named = logEvent("fact-superseded", { fact: "fact-lantern-ran", statement: "Other words.", reason: "Why.", by: "someone" });
  assert.deepEqual(await runCommand(on, superseded, { actor: owner, event: named, now: later }), { ok: false, refusal: "malformed-event", at: "fact-superseded" });

  // A reaffirm binds to current versions, clears only its own flag, and a later change flags it again.
  const stale = logEvent("interpretation-reaffirmed", { interpretation: "reading-host", cites: [{ fact: "fact-lantern-host", version: 1 }] });
  assert.deepEqual(await runCommand(on, superseded, { actor: owner, event: stale, now: later }), { ok: false, refusal: "cite-not-current", at: "cites" });
  const reaffirmed = await commanded(on, superseded, { as: "owner", event: logEvent("interpretation-reaffirmed", { interpretation: "reading-host", cites: [{ fact: "fact-lantern-host", version: 2 }] }) });
  const record = (reaffirmed.state as CaseState).record;
  const item = (id: string) => record.interpretations.find((candidate) => candidate.id === id) as Interpretation;
  assert.deepEqual(item("reading-host").cites, [{ fact: "fact-lantern-host", version: 2 }]);
  assert.equal(item("reading-host").review, "current");
  assert.equal(item("reading-both").review, "needs_review", "another dependent stays flagged");
  const again = await commanded(on, reaffirmed, { as: "owner", event: logEvent("fact-superseded", { fact: "fact-lantern-host", statement: "A third wording.", reason: "A better reading." }) });
  assert.equal(((again.state as CaseState).record.interpretations.find(({ id }) => id === "reading-host") as Interpretation).review, "needs_review");
  // And the flags are there on the next reopen.
  const last = await openCase(on, CASE_A);
  assert.ok(last.ok);
  assert.deepEqual(last.case.state, again.state);
});

test("A9 catches flags on everything, flags on nothing, and an old version lost", async () => {
  const { on, current } = await branch();
  const superseded = await commanded(on, current, SUPERSEDE_COMMAND);
  checkA9(closed(), superseded.state as CaseState);
  const run = async (edits: readonly SourceEdit[]) => {
    const variant = loadVariant<typeof evidenceModule>(require.resolve("../core/evidence-model"), edits);
    const state = closed();
    const answer = variant.applyRecordEvent(state.record, { type: "fact-superseded", fact: "fact-lantern-host", statement: "The lantern script's URL names the first-party host.", reason: "A URL's host does not show whose server answered." }, OWNER, state.machine, 99);
    assert.ok(answer.ok);
    checkA9(state, { ...state, record: answer.record });
  };
  await assertCaughtBy("no flags", A9, () => run([{ find: 'return accept(flagDependents(replaced(record, next), fact.id, fact.version, "superseded", atSeq));', replace: "return accept(replaced(record, next));" }]));
  await assertCaughtBy("flags on everything", A9, () => run([{ find: "interpretation.cites.some(({ fact }) => fact === factId)", replace: "true" }]));
  await assertCaughtBy("only a first citation noticed", A9, () => run([{ find: "interpretation.cites.some(({ fact }) => fact === factId)", replace: "interpretation.cites[0].fact === factId" }]));
  await assertCaughtBy("the old version lost", A9, () => run([{ find: "history: [...fact.history, { version: fact.version, statement: fact.statement, reason: event.reason, atSeq }] });", replace: "history: fact.history });" }]));
});

// A10. Ports "H1 is an unverified assertion, cannot be cited, and retracts into an unknown".
// Changed: M1 let a retraction go without an unknown. Here retracting an assertion always
// leaves one, since saying "we no longer say this" leaves the question open. M1's kind string
// is the type's tag, and can_be_cited is false by the type. A fact's retraction still may or
// may not leave one, as in M1.

const A10 = "A10 an assertion is unverified, uncitable, and retracts into an unknown beside it";

test("A10 an assertion stays what it is, and retracting it adds an unknown", async () => {
  const start = closed();
  assert.equal(start.record.facts.some(({ id }) => id === "said-thimble-clear"), false, "it is not a fact");
  assert.deepEqual(start.record.assertions, [{ kind: "assertion", id: "said-thimble-clear", status: "unverified", citable: false, statement: "The logger ruled out the thimble bundle.", retraction: null }]);

  const { on, current } = await branch();
  const cite = logEvent("interpretation-recorded", { id: "reading-bad", statement: "Words.", cites: [{ fact: "said-thimble-clear", version: 1 }] });
  assert.deepEqual(await runCommand(on, current, { actor: owner, event: cite, now: later }), { ok: false, refusal: "cites-assertion", at: "cites" });
  const asFact = logEvent("fact-superseded", { fact: "said-thimble-clear", statement: "Words.", reason: "Why." });
  assert.deepEqual(await runCommand(on, current, { actor: owner, event: asFact, now: later }), { ok: false, refusal: "not-a-fact", at: "fact" });

  // A reason is required, and an unknown is too.
  const noReason = logEvent("assertion-retracted", { assertion: "said-thimble-clear", reason: "", unknown: { id: "unknown-two", question: "What?", reason: "Because.", detail: null, wouldResolve: null } });
  assert.deepEqual(await runCommand(on, current, { actor: owner, event: noReason, now: later }), { ok: false, refusal: "malformed-event", at: "assertion-retracted" });
  const noUnknown = logEvent("assertion-retracted", { assertion: "said-thimble-clear", reason: "Why.", unknown: null });
  assert.deepEqual(await runCommand(on, current, { actor: owner, event: noUnknown, now: later }), { ok: false, refusal: "malformed-event", at: "assertion-retracted" });

  const retracted = await commanded(on, current, RETRACT_ASSERTION_COMMAND);
  const reopened = await openCase(on, CASE_A);
  assert.ok(reopened.ok);
  assert.deepEqual(reopened.case.state, retracted.state);
  const record = (retracted.state as CaseState).record;
  const [assertion] = record.assertions;
  assert.equal(assertion.status, "retracted");
  assert.equal(assertion.statement, "The logger ruled out the thimble bundle.", "the statement stays in history");
  assert.equal(assertion.retraction?.replacedByUnknown, "unknown-thimble");
  assert.deepEqual(record.unknowns.map(({ id, kind }) => [id, kind]), [["unknown-author", "unknown"], ["unknown-thimble", "unknown"]]);
  assert.equal(record.facts.filter(({ status }) => status === "current").some(({ statement }) => /ruled out/.test(statement)), false, "no negative statement stays current");
  assert.deepEqual(await runCommand(on, retracted, { actor: owner, event: cite, now: later }), { ok: false, refusal: "cites-assertion", at: "cites" });
});

test("A10 catches an assertion cited as a fact", async () => {
  const variant = loadVariant<typeof evidenceModule>(require.resolve("../core/evidence-model"), [{ find: 'if (claim.kind === "assertion")\n        return refuse("cites-assertion", "cites");', replace: 'if (claim.kind === "assertion")\n        return null;' }]);
  await assertCaughtBy("an assertion cited as a fact", A10, () => {
    const state = closed();
    const answer = variant.applyRecordEvent(state.record, { type: "interpretation-recorded", id: "reading-bad", statement: "Words.", cites: [{ fact: "said-thimble-clear", version: 1 }] }, OWNER, state.machine, 99);
    holds(A10, !answer.ok && answer.refusal === "cites-assertion", () => answer);
  });
});

// A12. Ports "aggregates show denominators and keys, and cross-attempt evidence is refused".
// Changed: M1's measures were functions written for one case, with hard-coded names. A measure
// here is data naming a subject, and its denominator is every attempt in the group: M1's
// outside_denominator survives only for a population by arm, which cannot leave out a slot
// for what became of it. A different release, commit or configuration splits a group, which M1
// had no second configuration to show, and so does what a visit rested on. Its clock rules carry
// over unchanged.

const A12 = "A12 aggregates show denominators and keys, and split on what must be held equal";

const KEYS: MeasureKeys = { heldEqual: ["commit", "configuration", "release"], allowedToVary: [{ key: "arm", reason: "Both arms report this count, and arms pool here." }], unknown: [] };
const MEASURE: Measure = { id: "measure-lantern", subject: "subject-lantern", population: null, keys: KEYS };

const checkA12 = (aggregates: typeof aggregatesModule, state: CaseState) => {
  const result = aggregates.aggregate(aggregateRowsOfCase(state), MEASURE);
  holds(A12, result.ok, () => result);
  const { groups } = result as Extract<aggregatesModule.AggregateResult, { ok: true }>;
  const shape = groups.map((group) => [group.group.configuration === CONFIG_ALDER_KEY ? "alder" : group.group.configuration === CONFIG_BIRCH_KEY ? "birch" : "neither", group.group.basis, group.group.release, group.group.commit, group.n, group.of, group.zero, group.unknown, group.notStarted, group.failed, group.limits]);
  const expected = [
    // The first configuration: B1 saw it, with nothing against it.
    ["alder", "ordinary", IDENTITY_ALDER.reaRelease, IDENTITY_ALDER.commit, 1, 1, 0, 0, 0, 0, { observed: {}, zero_in_window: {}, unknown: {} }],
    // The second, on its one exception: B2 read 0 in its window. It does not pool with the visits that rested on a control.
    ["birch", "exception", IDENTITY_BIRCH.reaRelease, IDENTITY_BIRCH.commit, 0, 1, 1, 0, 0, 0, { observed: {}, zero_in_window: {}, unknown: {} }],
    // The second otherwise: B3 and I1 saw it, one partial and the other incomplete with a row after it ended, and each limit shows. I2 failed with no record. I3 never started, and its only trace is notStarted.
    ["birch", "ordinary", IDENTITY_BIRCH.reaRelease, IDENTITY_BIRCH.commit, 2, 4, 0, 2, 1, 1, { observed: { attempt_incomplete: 1, coverage_not_complete: 2, late: 1 }, zero_in_window: {}, unknown: { no_record: 1 } }]
  ];
  const sorted = (list: readonly unknown[]) => list.map((item) => JSON.stringify(item)).sort();
  holds(A12, JSON.stringify(sorted(shape)) === JSON.stringify(sorted(expected)), () => shape);
  holds(A12, groups.reduce((sum, { of }) => sum + of, 0) === 6, () => groups);
  for (const group of groups) {
    holds(A12, group.presentedAs === "aggregate across attempts, not one execution", () => group);
    holds(A12, group.outsideDenominator === 0 && group.n + group.zero + group.unknown === group.of, () => group);
    holds(A12, JSON.stringify(group.compatibility) === JSON.stringify(KEYS), () => group);
  }
};

test("A12 on the case: three groups, split by configuration and by what a visit rested on, each with its denominator and keys", () => {
  checkA12(aggregatesModule, closed());
});

test("A12 catches a measure that pools over a change, and a denominator that drops an attempt", async () => {
  const variant = (...edits: SourceEdit[]) => loadVariant<typeof aggregatesModule>(require.resolve("../core/aggregates"), edits);
  await assertCaughtBy("nothing split", A12, () => checkA12(variant({ find: "const name = JSON.stringify(group);", replace: 'const name = "one";' }), closed()));
  await assertCaughtBy("an exception's visit pooled with the controlled ones", A12, () => checkA12(variant({ find: 'const label = row.basis === "exception" ? "exception" : "ordinary";', replace: 'const label = "ordinary";' }), closed()));
  await assertCaughtBy("a group that drops what limited its readings", A12, () => checkA12(variant({ find: 'limits: { observed: limitCounts(reading("observed")), zero_in_window: limitCounts(reading("zero_in_window")), unknown: limitCounts(reading("unknown")) },', replace: "limits: { observed: {}, zero_in_window: {}, unknown: {} }," }), closed()));
  await assertCaughtBy("dropping not_started", A12, () => checkA12(variant({ find: "const inside = population === null ? members : members.filter(({ arm }) => arm === population.arm);", replace: 'const inside = (population === null ? members : members.filter(({ arm }) => arm === population.arm)).filter(({ phase }) => phase !== "not_started");' }), closed()));
  await assertCaughtBy("dropping failed", A12, () => checkA12(variant({ find: "const inside = population === null ? members : members.filter(({ arm }) => arm === population.arm);", replace: 'const inside = (population === null ? members : members.filter(({ arm }) => arm === population.arm)).filter(({ phase }) => phase !== "failed");' }), closed()));
});

test("A12 keys must be declared, cross-attempt evidence is refused, and order across clocks is not established", () => {
  const rows = aggregateRowsOfCase(closed());
  assert.deepEqual(aggregate(rows, { ...MEASURE, keys: null }), { ok: false, refusal: "no-declared-keys", at: "measure.keys" });
  assert.deepEqual(aggregate(rows, { ...MEASURE, keys: { ...KEYS, allowedToVary: [] } }), { ok: false, refusal: "undeclared-key", at: "rows[0].keys" });
  assert.deepEqual(aggregate(rows, { ...MEASURE, keys: { heldEqual: ["commit", "release"], allowedToVary: [{ key: "configuration", reason: "It may vary." }, { key: "arm", reason: "Both." }], unknown: [] } }), { ok: false, refusal: "split-key-not-held", at: "configuration" });

  const state = closed();
  assert.deepEqual(evidenceForAttempt(state.machine, state.record, ["B1", "I2"]), { ok: false, refusal: "one-attempt-at-a-time" });
  const one = evidenceForAttempt(state.machine, state.record, ["B1"]);
  assert.ok(one.ok);
  assert.deepEqual(one.rows.map(({ id }) => id), ["row-b1-coverage", "row-b1-network"]);
  assert.ok(one.rows.every(({ slot }) => slot === "B1"));

  assert.deepEqual(orderOf({ clock: "page", ms: 1 }, { clock: "harness", ms: 2 }), { ok: false, refusal: "clocks-differ" });
  assert.deepEqual(orderOf({ clock: "page", ms: 1 }, { clock: "page", ms: 2 }), { ok: true, order: -1 });
  for (const row of state.record.rows) {
    const { window } = row;
    assert.ok(window.clock === null ? "note" in window && window.note !== "" : "startMs" in window, `${row.id} states its clock, or null with a note`);
  }
  // The case holds both kinds, so this loop is over something.
  assert.ok(state.record.rows.some(({ window }) => window.clock === null));
  assert.ok(state.record.rows.some(({ window }) => window.clock !== null));
});

test("the fixture's raw tier is really the store's, and its digests are node:crypto's", async () => {
  for (const [label, text] of Object.entries(RAW_OBJECTS)) assert.equal(digestOfRaw(label), sha256OfText(text));
  const opened = await openLog(stores, CASE_A);
  assert.ok(opened.ok);
  assert.equal(opened.log.entries.length, CASE_SCRIPT.length);
});
