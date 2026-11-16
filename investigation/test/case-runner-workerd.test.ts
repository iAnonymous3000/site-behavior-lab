import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { MAX_RUNNER_ROWS_PER_ATTEMPT, RUNNER_EVENT_TYPES } from "../core/case-runner";
import { OWNER_COMMAND_EVENT_TYPES } from "../core/case-service";
import { CASES_BINDING, CREATE_FIELDS, hostWorld, OBJECTS_BINDING, type HostWorld } from "./case-host-fixture";

/**
 * A runner's seam in a case object, on real workerd, on the test's own entry. This process stands in
 * for the handler that will forward a runner's calls: it asks the object for an attempt's token and
 * writes that attempt's events with it, straight to the object's stub. The front Worker sends
 * neither call. The test entry's stand-in for the runner's stop records each stop and fails while
 * its marker exists, and three of its own calls bring a mark due, write a slot's destroy record, and
 * hand back the object's storage.
 * Its deadlines are the defaults, so no alarm comes due unless a test brings one due.
 */

const ENTRY = "investigation/test/workerd-case-host-entry.ts";
const BUNDLE = "workerd-case-host-entry.js";
const STOP_FAILS_KEY = "test-fault/stop-fails";

let world: HostWorld;

before(async () => {
  world = await hostWorld(ENTRY, BUNDLE);
}, { timeout: 180_000 });

after(async () => {
  await world?.dispose();
});

type Attempt = { slot: string; attemptId: string; phase: string; cleanup: string | null; evidence: string[] };
type View = { head: string; seq: number; state: { machine: { attempts: Attempt[]; closedBy: string | null }; record: { rows: { id: string; state: string }[] } } };
type Answer = Record<string, unknown>;

/** Every answer a runner's call got in this suite, so the canary test can look through all of them. */
const answers: Answer[] = [];

async function opened(caseId: string): Promise<View> {
  const { answer } = await world.direct(CASES_BINDING, caseId, { call: "open", assertion: world.ownerToken, caseId });
  assert.equal(answer.ok, true, JSON.stringify(answer));
  return answer.case as View;
}

async function command(caseId: string, pathname: string, fields: readonly (readonly [string, string])[] = []): Promise<number> {
  const { head } = await opened(caseId);
  return (await world.send(`/cases/${caseId}${pathname}`, { fields: [["head", head], ...fields] })).status;
}

async function handOut(caseId: string, attemptId: unknown): Promise<Answer> {
  const { status, answer } = await world.direct(CASES_BINDING, caseId, { call: "runner-token", caseId, attemptId });
  assert.equal(status, 200);
  return answer;
}

/** One runner event, written against the head as it stands. */
async function write(caseId: string, token: unknown, type: string, data: Record<string, unknown>): Promise<Answer> {
  const { head } = await opened(caseId);
  const { status, answer } = await world.direct(CASES_BINDING, caseId, { call: "runner", caseId, token, viewedHead: head, event: { type, data } });
  assert.equal(status, 200);
  answers.push(answer);
  return answer;
}

const attemptOf = async (caseId: string, slot: string): Promise<Attempt> => (await opened(caseId)).state.machine.attempts.find((attempt) => attempt.slot === slot) as Attempt;
const row = (id: string, slot = "B1") => ({ row: { id, slot, instrument: "coverage", state: "no_record", window: { clock: null, note: "no-window" }, limits: [], digest: null, observation: null } });
const storageOf = async (caseId: string) => (await world.direct(CASES_BINDING, caseId, { call: "test-storage" })).answer as Record<string, Record<string, unknown>[]>;

/** Every entry this case's log holds, parsed. */
async function entriesOf(caseId: string): Promise<{ actor: Record<string, unknown>; events: { type: string }[] }[]> {
  const bucket = await world.miniflare.getR2Bucket(OBJECTS_BINDING);
  const entries = [];
  for (const key of await world.keys(`cases/${caseId}/entries/`)) entries.push(JSON.parse(await (await bucket.get(key))!.text()));
  return entries;
}

/** What the case holds that a write could change: its head, its entries and every object under it. */
async function snapshot(caseId: string): Promise<string> {
  return JSON.stringify([(await opened(caseId)).head, await world.keys(`cases/${caseId}/`)]);
}

/** The plan's fields with B1 alone, so B1 is the last planned slot and its own outcome closes the case as completed. */
const B1_ONLY = CREATE_FIELDS.filter(([name, value]) => !(name === "slot" && value === "I1"));

/** A case with its first attempt started on an exception, the only way a visit starts with no control run. */
async function startedCase(fields = CREATE_FIELDS): Promise<string> {
  const caseId = await world.create(fields);
  for (const [pathname, fields] of [
    ["/plan/freeze", [["plan", "a plan for the runner suite"]]],
    ["/exception", [["slot", "B1"], ["reason", "No control run exists yet."]]],
    ["/attempts/B1/start", []]
  ] as const) {
    assert.equal(await command(caseId, pathname, fields), 303, pathname);
  }
  return caseId;
}

/** A started case and its first attempt's token. */
async function withToken(fields = CREATE_FIELDS): Promise<{ caseId: string; token: string; attemptId: string; handed: Answer }> {
  const caseId = await startedCase(fields);
  const { attemptId } = await attemptOf(caseId, "B1");
  const answer = await handOut(caseId, attemptId);
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assert.match(answer.token as string, /^[0-9a-f]{64}$/);
  return { caseId, token: answer.token as string, attemptId, handed: answer };
}

/** The first hand-out answers the token, the case's head and its sequence, and nothing else of the case. */
async function holdsHandedShape(caseId: string, handed: Answer): Promise<void> {
  assert.deepEqual(Object.keys(handed).sort(), ["head", "ok", "seq", "token"]);
  const view = await opened(caseId);
  assert.deepEqual([handed.head, handed.seq], [view.head, view.seq]);
}

/** Bring every waiting mark due and run the alarm's handler, as the attempt's deadline would. */
async function stopByAlarm(caseId: string): Promise<Answer> {
  await world.direct(CASES_BINDING, caseId, { call: "test-due-now" });
  return (await world.direct(CASES_BINDING, caseId, { call: "test-run-alarm" })).answer;
}

const destroyRecord = async (caseId: string): Promise<void> => {
  assert.deepEqual((await world.direct(CASES_BINDING, caseId, { call: "test-destroy-record", slot: "B1" })).answer, { ok: true });
};

const REFUSED = { ok: false, refusal: "token-refused", at: null, head: null };
const ENDED = { ok: false, refusal: "attempt-ended", at: null, head: null };
const NOT_CLEANUP = RUNNER_EVENT_TYPES.filter((type) => !type.startsWith("cleanup"));
const dataFor = (type: string, id: string): Record<string, unknown> => (type === "evidence-recorded" ? row(id) : { slot: "B1" });

/** Every runner event answers the same refusal, and the case is as it was. */
async function refusesAll(caseId: string, token: string, types: readonly string[], expected: Answer, label: string): Promise<void> {
  assert.ok(types.length > 0, label);
  const kept = await snapshot(caseId);
  for (const type of types) assert.deepEqual(await write(caseId, token, type, dataFor(type, `row-${label.replace(/[^a-z]/g, "")}`)), expected, `${label}: ${type}`);
  assert.equal(await snapshot(caseId), kept, label);
}

const accepted = (answer: Answer, label: string) => assert.equal(answer.ok, true, `${label}: ${JSON.stringify(answer)}`);

test("1. each runner event is written as system:runner for its own attempt only", { timeout: 120_000 }, async () => {
  const { caseId, token, attemptId } = await withToken();
  const sequence: [string, Record<string, unknown>][] = [
    ["attempt-start-retried", { slot: "B1" }],
    ["capture-began", { slot: "B1" }],
    ["instrument-recorded", { slot: "B1", instrument: "coverage", completeness: "complete", reason: null }],
    ["source-recorded", { slot: "B1", commit: "c1".repeat(20), identity: "e1".repeat(32) }],
    ["evidence-recorded", row("row-one")],
    ["capture-finished", { slot: "B1" }],
    ["attempt-finished", { slot: "B1", outcome: "usable", reason: null }],
    ["cleanup-confirmed", { slot: "B1" }]
  ];
  // Another attempt's slot is refused at every step, and writes nothing.
  for (const [type, data] of sequence) {
    const other = await snapshot(caseId);
    const elsewhere = type === "evidence-recorded" ? row("row-other", "I1") : { ...data, slot: "I1" };
    assert.deepEqual(await write(caseId, token, type, elsewhere), { ok: false, refusal: "not-this-attempt", at: null, head: null }, type);
    assert.equal(await snapshot(caseId), other, type);
    const answer = await write(caseId, token, type, data);
    accepted(answer, type);
    // The runner is told the head and nothing else of the case.
    assert.deepEqual(Object.keys(answer).sort(), ["head", "ok", "seq"], type);
  }
  const entries = await entriesOf(caseId);
  const written = entries.filter(({ actor }) => actor.kind === "system:runner");
  assert.equal(written.length, sequence.length);
  // Everything else in the log is the owner's: the plan, the freeze, the exception and the start.
  assert.deepEqual(entries.filter(({ actor }) => actor.kind !== "system:runner").map(({ actor }) => actor.kind), ["owner", "owner", "owner", "owner"]);
  // Entries are keyed by digest, so their order is read from the types, not the keys.
  assert.deepEqual(written.map(({ events }) => events[0].type).sort(), sequence.map(([type]) => type).sort());
  for (const entry of written) assert.deepEqual(entry.actor, { kind: "system:runner", attemptId }, entry.events[0].type);
  // Every runner event but the second cleanup event was written: the list is covered.
  assert.deepEqual(RUNNER_EVENT_TYPES.filter((type) => !sequence.some(([written]) => written === type)), ["cleanup-unconfirmed"]);
  const b1 = await attemptOf(caseId, "B1");
  assert.deepEqual([b1.phase, b1.cleanup, b1.evidence], ["usable", "confirmed", ["row-one"]]);
});

test("2. another attempt's token, and another case's, is refused", { timeout: 120_000 }, async () => {
  const first = await withToken();
  for (const [type, data] of [["capture-began", { slot: "B1" }], ["capture-finished", { slot: "B1" }], ["attempt-finished", { slot: "B1", outcome: "usable", reason: null }]] as const) accepted(await write(first.caseId, first.token, type, data), type);
  // The baseline was usable, so the owner can record the rule and start the instrumented attempt.
  assert.equal(await command(first.caseId, "/attempts/B1/cleanup", [["cleanup", "confirmed"]]), 303);
  assert.equal(await command(first.caseId, "/baseline-rule", [["result", "met"]]), 303);
  assert.equal(await command(first.caseId, "/exception", [["slot", "I1"], ["reason", "No control run exists yet."]]), 303);
  assert.equal(await command(first.caseId, "/attempts/I1/start"), 303);
  const i1 = await attemptOf(first.caseId, "I1");
  const second = await handOut(first.caseId, i1.attemptId);
  accepted(second, "I1's token");
  // B1's token cannot speak for I1, nor I1's for B1.
  const kept = await snapshot(first.caseId);
  assert.deepEqual(await write(first.caseId, first.token, "capture-began", { slot: "I1" }), { ok: false, refusal: "not-this-attempt", at: null, head: null });
  assert.deepEqual(await write(first.caseId, second.token, "cleanup-unconfirmed", { slot: "B1" }), { ok: false, refusal: "not-this-attempt", at: null, head: null });
  assert.equal(await snapshot(first.caseId), kept);
  // Another case's token for the same slot is not held by this object at all.
  const other = await withToken();
  const otherKept = await snapshot(other.caseId);
  assert.deepEqual(await write(other.caseId, first.token, "capture-began", { slot: "B1" }), { ok: false, refusal: "token-refused", at: null, head: null });
  assert.deepEqual(await write(first.caseId, other.token, "capture-began", { slot: "I1" }), { ok: false, refusal: "token-refused", at: null, head: null });
  assert.deepEqual(await write(first.caseId, other.token, "capture-began", { slot: "B1" }), { ok: false, refusal: "token-refused", at: null, head: null });
  assert.equal(await snapshot(other.caseId), otherKept);
  assert.equal(await snapshot(first.caseId), kept);
  // A token request that names another case, sent to this case's object, reaches no attempt, and changes nothing.
  const storage = JSON.stringify(await storageOf(first.caseId));
  assert.deepEqual((await world.direct(CASES_BINDING, first.caseId, { call: "runner-token", caseId: other.caseId, attemptId: i1.attemptId })).answer, { ok: false, refusal: "no-such-attempt" });
  assert.equal(JSON.stringify(await storageOf(first.caseId)), storage);
  // I1's own token still writes for I1.
  accepted(await write(first.caseId, second.token, "capture-began", { slot: "I1" }), "I1 capture");
});

test("3. after the outcome the token is refused for every event that is not a cleanup event; after a stop, after the destroy record and after the owner's close it is refused for all; the last slot keeps its cleanup", { timeout: 180_000 }, async () => {
  assert.equal(NOT_CLEANUP.length, 7);
  // After the outcome: every event but cleanup.
  const finished = await withToken();
  accepted(await write(finished.caseId, finished.token, "attempt-finished", { slot: "B1", outcome: "failed", reason: "start-failed" }), "outcome");
  await refusesAll(finished.caseId, finished.token, NOT_CLEANUP, ENDED, "after the outcome");
  accepted(await write(finished.caseId, finished.token, "cleanup-confirmed", { slot: "B1" }), "cleanup after the outcome");

  // After a stop alone: everything, cleanup included, before and after the owner writes the deadline.
  const stopped = await withToken();
  assert.deepEqual(await stopByAlarm(stopped.caseId), { ok: true });
  await refusesAll(stopped.caseId, stopped.token, RUNNER_EVENT_TYPES, REFUSED, "after a stop");
  assert.equal(await command(stopped.caseId, "/attempts/B1/deadline"), 303);
  await refusesAll(stopped.caseId, stopped.token, RUNNER_EVENT_TYPES, REFUSED, "after a stop and the deadline");
  assert.deepEqual((await storageOf(stopped.caseId)).runner_records.map(({ stopped_at_ms, destroyed_at_ms }) => [stopped_at_ms !== null, destroyed_at_ms !== null]), [[true, false]]);

  // After the destroy record alone: everything, while running and after the outcome.
  const destroyed = await withToken();
  await destroyRecord(destroyed.caseId);
  await refusesAll(destroyed.caseId, destroyed.token, RUNNER_EVENT_TYPES, REFUSED, "after the destroy record");
  assert.deepEqual((await storageOf(destroyed.caseId)).runner_records.map(({ stopped_at_ms, destroyed_at_ms }) => [stopped_at_ms !== null, destroyed_at_ms !== null]), [[false, true]]);
  assert.deepEqual((await storageOf(destroyed.caseId)).test_stops, []);

  // After each of the owner's closes: everything, cleanup included.
  const cancelled = await withToken();
  assert.equal(await command(cancelled.caseId, "/cancel"), 303);
  const deadline = await withToken();
  assert.equal(await command(deadline.caseId, "/deadline"), 303);
  const notMet = await withToken();
  accepted(await write(notMet.caseId, notMet.token, "attempt-finished", { slot: "B1", outcome: "failed", reason: "start-failed" }), "baseline failed");
  assert.equal(await command(notMet.caseId, "/baseline-rule", [["result", "not_met"]]), 303);
  for (const [label, { caseId, token }, closedBy] of [["cancel", cancelled, "cancelled"], ["case deadline", deadline, "deadline"], ["baseline not met", notMet, "baseline_not_met"]] as const) {
    const b1 = await attemptOf(caseId, "B1");
    assert.deepEqual([(await opened(caseId)).state.machine.closedBy, b1.cleanup], [closedBy, "pending"], label);
    await refusesAll(caseId, token, RUNNER_EVENT_TYPES, REFUSED, `after the ${label}`);
    assert.deepEqual(await handOut(caseId, b1.attemptId), { ok: false, refusal: "no-such-attempt" }, label);
  }

  // The last planned slot: its own outcome closes the case as completed, and its cleanup is still its own.
  const last = await withToken(B1_ONLY);
  accepted(await write(last.caseId, last.token, "capture-began", { slot: "B1" }), "capture");
  accepted(await write(last.caseId, last.token, "capture-finished", { slot: "B1" }), "finished");
  accepted(await write(last.caseId, last.token, "attempt-finished", { slot: "B1", outcome: "usable", reason: null }), "outcome");
  assert.equal((await opened(last.caseId)).state.machine.closedBy, "completed");
  await refusesAll(last.caseId, last.token, NOT_CLEANUP, ENDED, "after the last slot's outcome");
  accepted(await write(last.caseId, last.token, "cleanup-confirmed", { slot: "B1" }), "the last slot's cleanup");
  // Once the cleanup is settled the window is shut: the runner's own cleanup event stops its runner, and the stop ends the token.
  await refusesAll(last.caseId, last.token, RUNNER_EVENT_TYPES, REFUSED, "after the last slot's cleanup");
  assert.notEqual((await storageOf(last.caseId)).runner_records.find(({ slot }) => slot === "B1")?.stopped_at_ms ?? null, null);
});

test("4. a second stop of the same attempt is accepted as done", { timeout: 120_000 }, async () => {
  const { caseId, token, attemptId } = await withToken();
  const bucket = await world.miniflare.getR2Bucket(OBJECTS_BINDING);
  await bucket.put(STOP_FAILS_KEY, "armed");
  try {
    // The seam after the record fails, so the alarm flags nothing and will ask again. The stop is already recorded.
    assert.equal((await stopByAlarm(caseId)).ok, false);
  } finally {
    await bucket.delete(STOP_FAILS_KEY);
  }
  const afterFirst = await storageOf(caseId);
  assert.equal(afterFirst.runner_records.length, 1);
  assert.notEqual(afterFirst.runner_records[0].stopped_at_ms, null);
  assert.deepEqual(await write(caseId, token, "capture-began", { slot: "B1" }), REFUSED);
  // The second stop of the same attempt is done: the handler succeeds, and the record is the first one.
  assert.deepEqual(await stopByAlarm(caseId), { ok: true });
  const afterSecond = await storageOf(caseId);
  assert.deepEqual(afterSecond.runner_records, afterFirst.runner_records);
  assert.deepEqual(afterSecond.test_stops.map(({ slot, stopped }) => `${slot}:${stopped}`), ["B1:0", "B1:1"]);
  // A second destroy record is done too.
  await destroyRecord(caseId);
  const destroyedOnce = (await storageOf(caseId)).runner_records;
  await destroyRecord(caseId);
  assert.deepEqual((await storageOf(caseId)).runner_records, destroyedOnce);
  assert.deepEqual(await handOut(caseId, attemptId), { ok: false, refusal: "token-revoked" });
  assert.deepEqual(await write(caseId, token, "capture-began", { slot: "B1" }), REFUSED);
});

test("5. owner events are refused through the runner seam, and runner events through the owner seam", { timeout: 120_000 }, async () => {
  const { caseId, token } = await withToken();
  const kept = await snapshot(caseId);
  const ownerOnly = OWNER_COMMAND_EVENT_TYPES.filter((type) => !RUNNER_EVENT_TYPES.includes(type));
  const runnerOnly = RUNNER_EVENT_TYPES.filter((type) => !OWNER_COMMAND_EVENT_TYPES.includes(type));
  assert.deepEqual([ownerOnly.length, runnerOnly.length], [10, 7]);
  for (const type of [...ownerOnly, "control-recorded", "configuration-changed", "fact-recorded"]) {
    assert.deepEqual(await write(caseId, token, type, { slot: "B1" }), { ok: false, refusal: "not-a-runner-event", at: null, head: null }, type);
  }
  for (const type of runnerOnly) {
    const { head } = await opened(caseId);
    const { answer } = await world.direct(CASES_BINDING, caseId, { call: "command", assertion: world.ownerToken, caseId, viewedHead: head, event: { type, data: type === "evidence-recorded" ? row("row-owner") : { slot: "B1" } } });
    assert.deepEqual(answer, { ok: false, refusal: "not-a-command" }, type);
  }
  assert.equal(await snapshot(caseId), kept);
});

test("6. a forged token writes nothing", { timeout: 120_000 }, async () => {
  const { caseId, token } = await withToken();
  const kept = await snapshot(caseId);
  const storage = JSON.stringify(await storageOf(caseId));
  const { digest } = (await storageOf(caseId)).runner_tokens[0] as { digest: string };
  const forged: unknown[] = [null, "", 7, { token }, [token], "f".repeat(64), token.toUpperCase(), `${token}0`, token.slice(1), digest, world.ownerToken];
  for (const candidate of forged) {
    for (const type of RUNNER_EVENT_TYPES) {
      const answer = await write(caseId, candidate, type, type === "evidence-recorded" ? row("row-forged") : { slot: "B1" });
      assert.deepEqual(answer, { ok: false, refusal: "token-refused", at: null, head: null }, `${JSON.stringify(candidate)?.slice(0, 20)} ${type}`);
    }
  }
  assert.equal(await snapshot(caseId), kept);
  assert.equal(JSON.stringify(await storageOf(caseId)), storage);
});

test("7. a canary token is absent from entries, objects, storage, errors and answers", { timeout: 120_000 }, async () => {
  const { caseId, token, handed } = await withToken();
  await holdsHandedShape(caseId, handed);
  // The token handed over is the canary. It is used for every kind of answer: written, refused by the machine, refused here, a conflict.
  accepted(await write(caseId, token, "capture-began", { slot: "B1" }), "capture");
  accepted(await write(caseId, token, "evidence-recorded", row("row-canary")), "row");
  assert.equal((await write(caseId, token, "capture-began", { slot: "B1" })).refusal, "wrong-phase");
  assert.equal((await write(caseId, token, "fact-recorded", { slot: "B1" })).refusal, "not-a-runner-event");
  const { answer: conflict } = await world.direct(CASES_BINDING, caseId, { call: "runner", caseId, token, viewedHead: "0".repeat(64), event: { type: "capture-finished", data: { slot: "B1" } } });
  answers.push(conflict);
  assert.equal(conflict.refusal, "conflict");
  const second = await handOut(caseId, (await attemptOf(caseId, "B1")).attemptId);
  answers.push(second);
  assert.equal(await write(caseId, token, "capture-finished", { slot: "B1" }).then((answer) => answer.refusal), "token-refused");

  const bucket = await world.miniflare.getR2Bucket(OBJECTS_BINDING);
  const keys = await world.keys(`cases/${caseId}/`);
  assert.ok(keys.length > 0);
  const objects = await Promise.all(keys.map(async (key) => (await bucket.get(key))!.text()));
  const page = await world.send(`/cases/${caseId}`);
  assert.equal(page.status, 200);
  const places: Readonly<Record<string, string>> = { keys: keys.join("\n"), objects: objects.join("\n"), storage: JSON.stringify(await storageOf(caseId)), answers: JSON.stringify(answers), open: JSON.stringify(await opened(caseId)), page: page.body };
  for (const [where, text] of Object.entries(places)) {
    assert.ok(text.length > 0, where);
    assert.ok(!text.includes(token), where);
  }
  // A check that would find it: the token is where a reader would look for it.
  assert.ok(JSON.stringify({ token }).includes(token));
});

test("8. the token is handed out once: a second request is refused, revokes the token, asks for the stop and flags the attempt, and the owner's reconcile fails it", { timeout: 120_000 }, async () => {
  const { caseId, token, attemptId, handed } = await withToken();
  await holdsHandedShape(caseId, handed);
  // The runner's first write names the head it was handed, and is written.
  const { answer: first } = await world.direct(CASES_BINDING, caseId, { call: "runner", caseId, token, viewedHead: handed.head, event: { type: "capture-began", data: { slot: "B1" } } });
  accepted(first, "the first write on the handed head");
  const entries = (await entriesOf(caseId)).length;
  const head = (await opened(caseId)).head;
  assert.deepEqual((await world.direct(CASES_BINDING, caseId, { call: "open", assertion: world.ownerToken, caseId })).answer.runnerFlags, []);
  assert.deepEqual(await handOut(caseId, attemptId), { ok: false, refusal: "token-already-handed" });
  // The flag, with its reason, in the object's storage and in the owner's status answer.
  const records = (await storageOf(caseId)).runner_records;
  assert.equal(records.length, 1);
  assert.notEqual(records[0].requested_twice_at_ms, null);
  const status = (await world.direct(CASES_BINDING, caseId, { call: "open", assertion: world.ownerToken, caseId })).answer;
  assert.deepEqual(status.runnerFlags, [{ slot: "B1", reason: "token-requested-twice" }]);
  assert.ok(!JSON.stringify(status).includes(token));
  // The stop was asked for, and recorded.
  assert.deepEqual((await storageOf(caseId)).test_stops.map(({ slot, stopped }) => `${slot}:${stopped}`), ["B1:1"]);
  assert.notEqual(records[0].stopped_at_ms, null);
  // The token is refused for every event, and a third request too.
  await refusesAll(caseId, token, RUNNER_EVENT_TYPES, REFUSED, "after a second request");
  assert.deepEqual(await handOut(caseId, attemptId), { ok: false, refusal: "token-revoked" });
  // The object wrote no event: the log still reads the attempt as running.
  assert.equal((await entriesOf(caseId)).length, entries);
  assert.equal((await opened(caseId)).head, head);
  assert.equal((await attemptOf(caseId, "B1")).phase, "capturing");
  // The owner's reconcile fails the attempt, with its cleanup unconfirmed.
  assert.equal(await command(caseId, "/reconcile"), 303);
  assert.equal((await entriesOf(caseId)).length, entries + 1);
  const b1 = await attemptOf(caseId, "B1");
  assert.deepEqual([b1.phase, b1.cleanup], ["failed", "unconfirmed"]);
  // The reconcile is no longer due, so the status answer no longer shows the flag, and the storage keeps it.
  assert.deepEqual((await world.direct(CASES_BINDING, caseId, { call: "open", assertion: world.ownerToken, caseId })).answer.runnerFlags, []);
  assert.notEqual((await storageOf(caseId)).runner_records[0].requested_twice_at_ms, null);
  // Only one token row ever existed for the attempt, and it holds a digest, never the token.
  const tokens = (await storageOf(caseId)).runner_tokens;
  assert.equal(tokens.length, 1);
  assert.notEqual(tokens[0].digest, token);
  // No token is handed for an attempt that is not running, nor for an id this case does not plan.
  assert.deepEqual(await handOut(caseId, (await attemptOf(caseId, "I1")).attemptId), { ok: false, refusal: "no-such-attempt" });
  assert.deepEqual(await handOut(caseId, "0".repeat(32)), { ok: false, refusal: "no-such-attempt" });

  // A second request after the outcome is refused and changes nothing.
  const ended = await withToken();
  accepted(await write(ended.caseId, ended.token, "attempt-finished", { slot: "B1", outcome: "failed", reason: "start-failed" }), "outcome");
  const storage = JSON.stringify(await storageOf(ended.caseId));
  const kept = await snapshot(ended.caseId);
  assert.deepEqual(await handOut(ended.caseId, ended.attemptId), { ok: false, refusal: "no-such-attempt" });
  assert.equal(JSON.stringify(await storageOf(ended.caseId)), storage);
  assert.equal(await snapshot(ended.caseId), kept);
  accepted(await write(ended.caseId, ended.token, "cleanup-confirmed", { slot: "B1" }), "its cleanup is still its own");
});

test("9. the object enforces the per-attempt row bound: a row past it is refused", { timeout: 120_000 }, async () => {
  const { caseId, token } = await withToken();
  accepted(await write(caseId, token, "capture-began", { slot: "B1" }), "capture");
  for (let index = 0; index < MAX_RUNNER_ROWS_PER_ATTEMPT; index += 1) accepted(await write(caseId, token, "evidence-recorded", row(`row-${index}`)), `row ${index}`);
  assert.equal((await attemptOf(caseId, "B1")).evidence.length, MAX_RUNNER_ROWS_PER_ATTEMPT);
  const kept = await snapshot(caseId);
  assert.deepEqual(await write(caseId, token, "evidence-recorded", row("row-past")), { ok: false, refusal: "row-bound", at: null, head: null });
  assert.equal(await snapshot(caseId), kept);
  // The bound is on rows: the attempt still reports.
  accepted(await write(caseId, token, "capture-finished", { slot: "B1" }), "capture finished");
});

test("10. a row after the outcome is refused; a cleanup event before the destroy record is accepted, and after it is refused, for the last slot by name", { timeout: 120_000 }, async () => {
  // B1 is the last planned slot, so its outcome closes the case as completed.
  const finished = await withToken(B1_ONLY);
  accepted(await write(finished.caseId, finished.token, "capture-began", { slot: "B1" }), "capture");
  accepted(await write(finished.caseId, finished.token, "attempt-finished", { slot: "B1", outcome: "walled", reason: "wall-seen" }), "outcome");
  assert.equal((await opened(finished.caseId)).state.machine.closedBy, "completed");
  const kept = await snapshot(finished.caseId);
  // The machine would keep this row and label it late. The object refuses it.
  assert.deepEqual(await write(finished.caseId, finished.token, "evidence-recorded", row("row-late")), ENDED);
  assert.equal(await snapshot(finished.caseId), kept);
  assert.deepEqual((await opened(finished.caseId)).state.record.rows, []);
  // No destroy record yet: the cleanup is accepted.
  accepted(await write(finished.caseId, finished.token, "cleanup-confirmed", { slot: "B1" }), "cleanup before the destroy record");
  assert.equal((await attemptOf(finished.caseId, "B1")).cleanup, "confirmed");

  // With the destroy record, the last slot's own cleanup is refused, and the owner settles it.
  const destroyed = await withToken(B1_ONLY);
  accepted(await write(destroyed.caseId, destroyed.token, "attempt-finished", { slot: "B1", outcome: "failed", reason: "browser-crashed" }), "outcome");
  assert.equal((await opened(destroyed.caseId)).state.machine.closedBy, "completed");
  await destroyRecord(destroyed.caseId);
  await refusesAll(destroyed.caseId, destroyed.token, ["cleanup-confirmed", "cleanup-unconfirmed", "evidence-recorded"], REFUSED, "after the destroy record");
  assert.equal(await command(destroyed.caseId, "/attempts/B1/cleanup", [["cleanup", "environment-destroyed"]]), 303);
  assert.equal((await attemptOf(destroyed.caseId, "B1")).cleanup, "environment_destroyed");
});

test("11. a runner call cannot choose its actor: a call that carries an actor, or names an attempt other than its token's, writes nothing", { timeout: 120_000 }, async () => {
  const { caseId, token, attemptId } = await withToken();
  const kept = await snapshot(caseId);
  const storage = JSON.stringify(await storageOf(caseId));
  const ownerActor = { kind: "owner", iss: "x", sub: "y", email: "z", iat: 1, exp: 2 };
  const otherAttempt = "e".repeat(32);
  const { head } = await opened(caseId);
  const base = { call: "runner", caseId, token, viewedHead: head, event: { type: "capture-began", data: { slot: "B1" } } };
  const calls: [string, Record<string, unknown>][] = [
    ["an actor beside the call", { ...base, actor: ownerActor }],
    ["a runner actor of another attempt", { ...base, actor: { kind: "system:runner", attemptId: otherAttempt } }],
    ["an attempt id beside the call", { ...base, attemptId: otherAttempt }],
    ["its own attempt id beside the call", { ...base, attemptId }],
    ["an assertion beside the call", { ...base, assertion: world.ownerToken }],
    ["a by on the event", { ...base, event: { ...base.event, by: ownerActor } }],
    ["an actor in the event's data", { ...base, event: { type: "capture-began", data: { slot: "B1", actor: ownerActor } } }],
    ["an attempt id in the event's data", { ...base, event: { type: "capture-began", data: { slot: "B1", attemptId: otherAttempt } } }],
    ["another slot's attempt", { ...base, event: { type: "capture-began", data: { slot: "I1" } } }],
    ["an actor beside a token request", { call: "runner-token", caseId, attemptId, actor: ownerActor }]
  ];
  for (const [label, call] of calls) {
    const { status, answer } = await world.direct(CASES_BINDING, caseId, call);
    answers.push(answer);
    assert.equal(answer.ok, false, `${label}: ${status} ${JSON.stringify(answer)}`);
  }
  assert.equal(await snapshot(caseId), kept);
  assert.equal(JSON.stringify(await storageOf(caseId)), storage);
  // The same call with nothing added is written, as the token's attempt.
  const { answer } = await world.direct(CASES_BINDING, caseId, base);
  accepted(answer, "the plain call");
  const written = (await entriesOf(caseId)).filter(({ events }) => events[0].type === "capture-began");
  assert.deepEqual(written.map(({ actor }) => actor), [{ kind: "system:runner", attemptId }]);
});

test("12. the object bounds an attempt's instrument records as it bounds its rows: one past the bound is refused", { timeout: 120_000 }, async () => {
  const { caseId, token } = await withToken();
  accepted(await write(caseId, token, "capture-began", { slot: "B1" }), "capture");
  const instrument = (index: number) => ({ slot: "B1", instrument: `instrument-${index}`, completeness: "complete", reason: null });
  for (let index = 0; index < MAX_RUNNER_ROWS_PER_ATTEMPT; index += 1) accepted(await write(caseId, token, "instrument-recorded", instrument(index)), `instrument ${index}`);
  const kept = await snapshot(caseId);
  assert.deepEqual(await write(caseId, token, "instrument-recorded", instrument(MAX_RUNNER_ROWS_PER_ATTEMPT)), { ok: false, refusal: "row-bound", at: null, head: null });
  assert.equal(await snapshot(caseId), kept);
  // The two bounds are apart: rows still pass, and the attempt still reports.
  accepted(await write(caseId, token, "evidence-recorded", row("row-after-instruments")), "a row");
  accepted(await write(caseId, token, "capture-finished", { slot: "B1" }), "capture finished");
});
