import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { GENESIS_HEAD } from "../core/case-log";
import { CASES_BINDING, CREATE_FIELDS, hostWorld, OBJECTS_BINDING, type HostWorld } from "./case-host-fixture";

/**
 * A case object's alarm, on real workerd, on the test's own entry: the production wiring with
 * deadlines of under a second, a stand-in for the seam that stops a runner which records each
 * stop it is asked for, and calls that show the object's marks and run its alarm's handler as a
 * second delivery would. Each test here is one way an alarm can go: on time, twice, late, with
 * a stop that fails, and across a restart of the object. In every one the case's log is read
 * before and after, and the alarm has written nothing to it.
 */

const ENTRY = "investigation/test/workerd-case-host-entry.ts";
const BUNDLE = "workerd-case-host-entry.js";
const DEADLINES = { "attempt-deadline": 400, reconcile: 900, "case-deadline": 3_600_000 };
const BINDINGS = { TEST_DEADLINES: JSON.stringify(DEADLINES) };
const STOP_FAILS_KEY = "test-fault/stop-fails";
const FAULT_KEY = "test-fault/entry-put";

let world: HostWorld;

before(async () => {
  world = await hostWorld(ENTRY, BUNDLE, { bindings: BINDINGS });
}, { timeout: 180_000 });

after(async () => {
  await world?.dispose();
});

type Mark = { kind: string; slot: string; due_at_ms: number; flagged_at_ms: number | null };
type Marks = { marks: Mark[]; stops: { slot: string; stopped: number }[]; alarm: number | null };
type View = { head: string; seq: number; state: { machine: { attempts: { slot: string; phase: string; cleanup: string | null }[]; closedBy: string | null } } | null };

const marksOf = async (on: HostWorld, caseId: string): Promise<Marks> => (await on.direct(CASES_BINDING, caseId, { call: "test-marks" })).answer as unknown as Marks;
const runAlarm = async (on: HostWorld, caseId: string) => (await on.direct(CASES_BINDING, caseId, { call: "test-run-alarm" })).answer;
const shape = (marks: Marks): string[] => marks.marks.map(({ kind, slot, flagged_at_ms }) => `${kind}:${slot}:${flagged_at_ms === null ? "waiting" : "flagged"}`);

async function opened(on: HostWorld, caseId: string): Promise<{ case: View; due: { kind: string; slot: string | null }[] }> {
  const { answer } = await on.direct(CASES_BINDING, caseId, { call: "open", assertion: on.ownerToken, caseId });
  assert.equal(answer.ok, true, JSON.stringify(answer));
  return answer as unknown as { case: View; due: { kind: string; slot: string | null }[] };
}

async function command(on: HostWorld, caseId: string, pathname: string, fields: readonly (readonly [string, string])[] = []) {
  const { head } = (await opened(on, caseId)).case;
  return on.send(`/cases/${caseId}${pathname}`, { fields: [["head", head], ...fields] });
}

/** A case with its first attempt started on an exception, which is the only way a visit starts with no control run. */
async function startedCase(on: HostWorld): Promise<string> {
  const caseId = await on.create();
  for (const [pathname, fields] of [
    ["/plan/freeze", [["plan", "a plan for the alarm suite"]]],
    ["/exception", [["slot", "B1"], ["reason", "No control run exists yet."]]],
    ["/attempts/B1/start", []]
  ] as const) {
    const answer = await command(on, caseId, pathname, fields);
    assert.equal(answer.status, 303, `${pathname}: ${answer.body.slice(-700, -500)}`);
  }
  return caseId;
}

/** Wait for the platform to deliver alarms until the marks read as wanted, or fail with what they read. */
async function until(on: HostWorld, caseId: string, wanted: readonly string[]): Promise<Marks> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const marks = await marksOf(on, caseId);
    if (JSON.stringify(shape(marks)) === JSON.stringify(wanted)) return marks;
    if (Date.now() > deadline) assert.fail(`the marks never read ${JSON.stringify(wanted)}: ${JSON.stringify(marks)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const WAITING = ["attempt-deadline:B1:waiting", "case-deadline::waiting", "reconcile::waiting"];
const BOTH_FLAGGED = ["attempt-deadline:B1:flagged", "case-deadline::waiting", "reconcile::flagged"];

test("an alarm that comes due flags the mark, asks once for the runner to be stopped and writes nothing to the log, and the owner's own command writes the deadline", { timeout: 120_000 }, async () => {
  const caseId = await startedCase(world);
  const started = await opened(world, caseId);
  const entries = await world.keys(`cases/${caseId}/entries/`);
  const first = await marksOf(world, caseId);
  // The alarm is set to the earliest mark, each mark due its own duration after the start.
  assert.deepEqual(first.alarm, Math.min(...first.marks.map(({ due_at_ms }) => due_at_ms)));
  const byKind = Object.fromEntries(first.marks.map((mark) => [mark.kind, mark.due_at_ms]));
  assert.equal(byKind.reconcile - byKind["attempt-deadline"], DEADLINES.reconcile - DEADLINES["attempt-deadline"]);

  const flagged = await until(world, caseId, BOTH_FLAGGED);
  // One stop for the one attempt, though two alarms were delivered, one for each mark.
  assert.deepEqual(flagged.stops, [{ slot: "B1", stopped: 1 }]);
  for (const mark of flagged.marks.filter(({ flagged_at_ms }) => flagged_at_ms !== null)) assert.ok((mark.flagged_at_ms as number) >= mark.due_at_ms, mark.kind);
  // The next alarm is the case's own deadline, the only mark still waiting.
  assert.equal(flagged.alarm, byKind["case-deadline"]);

  // The log is as it was: same head, same entries, and the attempt still reads as running.
  const after = await opened(world, caseId);
  assert.deepEqual([after.case.head, after.case.seq], [started.case.head, started.case.seq]);
  assert.deepEqual(await world.keys(`cases/${caseId}/entries/`), entries);
  assert.equal(after.case.state?.machine.attempts[0].phase, "starting");
  assert.deepEqual(after.due.map(({ kind, slot }) => `${kind}:${slot}`), ["attempt-deadline:B1", "reconcile:null"]);

  // The page says so, and says what it costs: nothing starts while the flagged attempt reads as running.
  const page = await world.send(`/cases/${caseId}`);
  for (const words of ["A deadline is due, and nothing has been written for it.", "The attempt&#39;s deadline passed.", "Reconcile is due.", "While a flagged attempt still reads as running, the next visit cannot start.", "A runner that was stopped cannot answer for its own cleanup."]) {
    assert.ok(page.body.includes(words), words);
  }
  const blocked = await command(world, caseId, "/attempts/I1/start");
  assert.equal(blocked.status, 422);
  assert.ok(blocked.body.includes("<code>another-attempt-running</code>"));

  // The owner writes the deadline, long after it passed. The attempt's mark goes, and reconcile stays flagged while the cleanup is pending.
  assert.equal((await command(world, caseId, "/attempts/B1/deadline")).status, 303);
  assert.deepEqual(shape(await marksOf(world, caseId)), ["case-deadline::waiting", "reconcile::flagged"]);
  assert.deepEqual((await opened(world, caseId)).due.map(({ kind }) => kind), ["reconcile"]);
  // Reconcile leaves the cleanup unconfirmed, and nothing is left to watch but the case.
  assert.equal((await command(world, caseId, "/reconcile")).status, 303);
  assert.deepEqual((await opened(world, caseId)).case.state?.machine.attempts.map(({ phase, cleanup }) => `${phase}:${cleanup}`), ["timed_out:unconfirmed", "planned:null"]);
  assert.deepEqual(shape(await marksOf(world, caseId)), ["case-deadline::waiting"]);
  assert.ok(!(await world.send(`/cases/${caseId}`)).body.includes("A deadline is due"));
  // Closing the case leaves no mark and no alarm.
  assert.equal((await command(world, caseId, "/cancel")).status, 303);
  assert.deepEqual(await marksOf(world, caseId), { marks: [], stops: [{ slot: "B1", stopped: 1 }], alarm: null });
});

test("a second delivery of an alarm flags nothing more and asks for no second stop", { timeout: 120_000 }, async () => {
  const caseId = await startedCase(world);
  const flagged = await until(world, caseId, BOTH_FLAGGED);
  const { head } = (await opened(world, caseId)).case;
  for (let delivery = 0; delivery < 3; delivery += 1) assert.deepEqual(await runAlarm(world, caseId), { ok: true });
  const after = await marksOf(world, caseId);
  // The same marks, flagged at the same times, and the one stop.
  assert.deepEqual(after, flagged);
  assert.equal((await opened(world, caseId)).case.head, head);
});

test("an alarm delivered after the owner already wrote the deadline finds no mark, and one delivered before any is due flags none", { timeout: 120_000 }, async () => {
  const caseId = await startedCase(world);
  // Before anything is due, a delivery flags nothing and stops nothing, and the alarm stays set.
  assert.deepEqual(await runAlarm(world, caseId), { ok: true });
  const early = await marksOf(world, caseId);
  assert.deepEqual([shape(early), early.stops], [WAITING, []]);
  assert.notEqual(early.alarm, null);
  // The owner ends the attempt and settles its cleanup before either mark is due.
  assert.equal((await command(world, caseId, "/attempts/B1/deadline")).status, 303);
  assert.equal((await command(world, caseId, "/attempts/B1/cleanup", [["cleanup", "confirmed"]])).status, 303);
  assert.deepEqual(shape(await marksOf(world, caseId)), ["case-deadline::waiting"]);
  const { head } = (await opened(world, caseId)).case;
  await new Promise((resolve) => setTimeout(resolve, DEADLINES.reconcile + 300));
  assert.deepEqual(await runAlarm(world, caseId), { ok: true });
  const late = await marksOf(world, caseId);
  assert.deepEqual([shape(late), late.stops], [["case-deadline::waiting"], []]);
  assert.equal((await opened(world, caseId)).case.head, head);
});

test("a stop that fails flags nothing, so the alarm is delivered again, and the stop is asked for again", { timeout: 120_000 }, async () => {
  const bucket = await world.miniflare.getR2Bucket(OBJECTS_BINDING);
  await bucket.put(STOP_FAILS_KEY, "armed");
  const caseId = await startedCase(world);
  // Every delivery fails at the stop: nothing is flagged, however many are made.
  await new Promise((resolve) => setTimeout(resolve, DEADLINES["attempt-deadline"] + 300));
  const failed = await runAlarm(world, caseId);
  assert.equal(failed.ok, false);
  const during = await marksOf(world, caseId);
  assert.deepEqual(shape(during), WAITING);
  assert.ok(during.stops.length >= 1 && during.stops.every(({ slot, stopped }) => slot === "B1" && stopped === 0));
  assert.deepEqual((await opened(world, caseId)).due, []);
  await bucket.delete(STOP_FAILS_KEY);
  // Once the stop works, the platform's own redelivery, or the next one, flags the marks.
  assert.deepEqual(await runAlarm(world, caseId), { ok: true });
  const after = await until(world, caseId, BOTH_FLAGGED);
  assert.equal(after.stops.filter(({ stopped }) => stopped === 1).length, 1);
});

test("marks are brought back to the case's state on every open: lost marks return, and a refused start leaves none behind", { timeout: 120_000 }, async () => {
  const caseId = await world.create();
  assert.deepEqual(shape(await marksOf(world, caseId)), ["case-deadline::waiting"]);
  // A start the case refuses wrote its marks ahead of the command, and the fold after it removes them.
  const refused = await command(world, caseId, "/attempts/B1/start");
  assert.equal(refused.status, 422);
  assert.deepEqual(shape(await marksOf(world, caseId)), ["case-deadline::waiting"]);
  // A start for another case's object, or by anyone but the owner, writes no mark at all.
  for (const [who, assertion] of Object.entries(world.refusedTokens)) {
    await world.direct(CASES_BINDING, caseId, { call: "command", caseId, assertion, viewedHead: GENESIS_HEAD, event: { type: "attempt-started", data: { slot: "B1" } } });
    assert.deepEqual(shape(await marksOf(world, caseId)), ["case-deadline::waiting"], who);
  }
  const started = await startedCase(world);
  await world.direct(CASES_BINDING, started, { call: "test-clear-marks" });
  assert.deepEqual((await marksOf(world, started)).marks, []);
  await opened(world, started);
  const back = await marksOf(world, started);
  assert.deepEqual(shape(back), WAITING);
  assert.notEqual(back.alarm, null);
});

test("a case planned after a killed create is watched from its plan, and the list then shows it as created", { timeout: 120_000 }, async () => {
  const bucket = await world.miniflare.getR2Bucket(OBJECTS_BINDING);
  const before = await world.listed();
  await bucket.put(FAULT_KEY, "armed");
  assert.equal((await world.send("/cases", { fields: CREATE_FIELDS })).status, 503);
  await bucket.delete(FAULT_KEY);
  const [caseId] = (await world.listed()).unfinished.filter((id) => !before.unfinished.includes(id));
  // A log with no plan wants no mark, and its page offers the plan.
  await opened(world, caseId);
  assert.deepEqual(await marksOf(world, caseId), { marks: [], stops: [], alarm: null });
  const page = await world.send(`/cases/${caseId}`);
  assert.ok(page.body.includes("Plan this case") && page.body.includes(`action="/cases/${caseId}/plan"`));
  // The plan's form has no field for an id, and one sent anyway is refused.
  assert.equal((await world.send(`/cases/${caseId}/plan`, { fields: [["head", GENESIS_HEAD], ...CREATE_FIELDS, ["attempt-id", "ab".repeat(16)]] })).status, 400);
  const planned = await world.send(`/cases/${caseId}/plan`, { fields: [["head", GENESIS_HEAD], ...CREATE_FIELDS] });
  assert.deepEqual([planned.status, planned.location], [303, `/cases/${caseId}`]);
  const view = (await opened(world, caseId)).case as unknown as { seq: number; state: { machine: { attempts: { slot: string; attemptId: string }[]; controlRunId: string } } };
  assert.equal(view.seq, 1);
  assert.deepEqual(view.state.machine.attempts.map(({ slot }) => slot), ["B1", "I1"]);
  for (const id of [view.state.machine.controlRunId, ...view.state.machine.attempts.map(({ attemptId }) => attemptId)]) assert.match(id, /^[0-9a-f]{32}$/);
  assert.deepEqual(shape(await marksOf(world, caseId)), ["case-deadline::waiting"]);
  const listed = await world.listed();
  assert.ok(listed.created.includes(caseId) && !listed.unfinished.includes(caseId));
});

test("an alarm due while the object is down is delivered after it comes back, on the marks its storage kept", { timeout: 180_000 }, async () => {
  const persist = mkdtempSync(path.join(tmpdir(), "sbl-case-alarm-"));
  let second: HostWorld | undefined;
  try {
    // Long enough that nothing comes due before the first world is gone.
    const slow = { TEST_DEADLINES: JSON.stringify({ ...DEADLINES, "attempt-deadline": 2500, reconcile: 3000 }) };
    const first = await hostWorld(ENTRY, BUNDLE, { bindings: slow, persist });
    const caseId = await startedCase(first);
    const left = await marksOf(first, caseId);
    const { head } = (await opened(first, caseId)).case;
    assert.deepEqual([shape(left), left.stops], [WAITING, []]);
    await first.dispose();
    await new Promise((resolve) => setTimeout(resolve, 3500));

    second = await hostWorld(ENTRY, BUNDLE, { bindings: slow, persist });
    const flagged = await until(second, caseId, BOTH_FLAGGED);
    // The marks kept their times across the restart, and were flagged after both had passed.
    assert.deepEqual(flagged.marks.map(({ kind, due_at_ms }) => [kind, due_at_ms]), left.marks.map(({ kind, due_at_ms }) => [kind, due_at_ms]));
    assert.deepEqual(flagged.stops, [{ slot: "B1", stopped: 1 }]);
    const after = await opened(second, caseId);
    assert.deepEqual([after.case.head, after.case.state?.machine.attempts[0].phase], [head, "starting"]);
    assert.deepEqual(after.due.map(({ kind }) => kind), ["attempt-deadline", "reconcile"]);
  } finally {
    await second?.dispose();
    rmSync(persist, { recursive: true, force: true });
  }
});
