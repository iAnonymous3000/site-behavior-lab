import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, test } from "node:test";
import { HANDLER_HOST, START_ENV_NAMES } from "../core/case-container";
import { MAX_RUNNER_OBJECT_BYTES_PER_ATTEMPT, MAX_RUNNER_OBJECTS_PER_ATTEMPT } from "../core/case-runner";
import { MAX_EVIDENCE_BYTES } from "../core/case-log";
import { RUNNER_CALL_HEADER, RUNNER_CASE_HEADER, RUNNER_DIGEST_HEADER, RUNNER_TOKEN_HEADER } from "../core/runner-handler";
import { CASES_BINDING, CREATE_FIELDS, hostWorld, OBJECTS_BINDING, type HostWorld } from "./case-host-fixture";

/**
 * A case object starting and stopping its runner's container, on real workerd, on the test's own
 * entry with a stand-in container: it starts nothing and records every call made of it, in order,
 * with what it was given. The handler a start registers is the entry's real handler, reached through
 * the real loopback binding with that start's props, and this suite sends the runner's calls through
 * that binding, as the runner in the container would. What a real container does is not shown here.
 */

const ENTRY = "investigation/test/workerd-case-host-entry.ts";
const BUNDLE = "workerd-case-host-entry.js";

let world: HostWorld;

before(async () => {
  world = await hostWorld(ENTRY, BUNDLE, { bindings: { TEST_CONTAINER: "1" } });
}, { timeout: 180_000 });

after(async () => {
  await world?.dispose();
});

type Attempt = { slot: string; attemptId: string; phase: string; cleanup: string | null };
type View = { head: string; seq: number; state: { machine: { attempts: Attempt[]; closedBy: string | null } } };
type Answer = Record<string, unknown>;
type Call = { call: string; detail: Record<string, unknown> | null };

/** Every answer this suite got, so the canary test can look through all of them. */
const answers: unknown[] = [];

async function openAnswer(caseId: string): Promise<Answer> {
  const { answer } = await world.direct(CASES_BINDING, caseId, { call: "open", assertion: world.ownerToken, caseId });
  assert.equal(answer.ok, true, JSON.stringify(answer));
  return answer;
}
const opened = async (caseId: string): Promise<View> => (await openAnswer(caseId)).case as View;
const attemptOf = async (caseId: string, slot: string): Promise<Attempt> => (await opened(caseId)).state.machine.attempts.find((attempt) => attempt.slot === slot) as Attempt;
const phases = async (caseId: string): Promise<string[]> => (await opened(caseId)).state.machine.attempts.map(({ slot, phase, cleanup }) => `${slot}:${phase}:${cleanup ?? "none"}`);
const storageOf = async (caseId: string) => (await world.direct(CASES_BINDING, caseId, { call: "test-storage" })).answer as Record<string, Record<string, unknown>[]>;
const callsOf = async (caseId: string): Promise<Call[]> => (await world.direct(CASES_BINDING, caseId, { call: "test-container-calls" })).answer as unknown as Call[];
const namesOf = async (caseId: string): Promise<string[]> => (await callsOf(caseId)).map(({ call }) => call);
const fault = async (caseId: string, name: string, on: boolean): Promise<void> => {
  assert.deepEqual((await world.direct(CASES_BINDING, caseId, { call: "test-container-fault", name, on })).answer, { ok: true });
};
const sha256 = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");

/** What the case holds that a write could change: its head and every object under it. */
async function snapshot(caseId: string): Promise<string> {
  return JSON.stringify([(await opened(caseId)).head, await world.keys(`cases/${caseId}/`)]);
}

async function command(caseId: string, pathname: string, fields: readonly (readonly [string, string])[] = [], token?: string | null): Promise<Answer & { status: number; body: string }> {
  const { head } = await opened(caseId);
  const answer = await world.send(`/cases/${caseId}${pathname}`, { fields: [["head", head], ...fields], token });
  return { status: answer.status, body: answer.body };
}
const refusalOn = (body: string): string | null => /The case refused it: <code>([a-z-]+)<\/code>/.exec(body)?.[1] ?? null;

/** A case whose plan is frozen and whose first slot may start on an exception. */
async function readyCase(fields = CREATE_FIELDS): Promise<string> {
  const caseId = await world.create(fields);
  for (const [pathname, values] of [
    ["/plan/freeze", [["plan", "a plan for the container suite"]]],
    ["/exception", [["slot", "B1"], ["reason", "No control run exists yet."]]]
  ] as const) {
    assert.equal((await command(caseId, pathname, values)).status, 303, pathname);
  }
  return caseId;
}

async function startedCase(fields = CREATE_FIELDS): Promise<string> {
  const caseId = await readyCase(fields);
  assert.equal((await command(caseId, "/attempts/B1/start")).status, 303);
  return caseId;
}

/** One request through the binding the latest start registered, as something in that container sends it. */
async function through(caseId: string, request: Readonly<{ headers?: Record<string, string>; body?: string; fill?: { length: number; byte: number }; stream?: boolean }>): Promise<{ status: number; answer: Answer }> {
  const { answer } = await world.direct(CASES_BINDING, caseId, { call: "test-through-handler", ...request });
  answers.push(answer);
  return answer as unknown as { status: number; answer: Answer };
}
const json = (body: Record<string, unknown>) => ({ headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function handOut(caseId: string, attemptId: string): Promise<{ status: number; answer: Answer }> {
  return through(caseId, json({ call: "runner-token", caseId, attemptId }));
}

async function write(caseId: string, token: string, type: string, data: Record<string, unknown>, extra: Record<string, unknown> = {}): Promise<{ status: number; answer: Answer }> {
  const { head } = await opened(caseId);
  return through(caseId, json({ call: "runner", caseId, token, viewedHead: head, event: { type, data }, ...extra }));
}

async function withToken(fields = CREATE_FIELDS): Promise<{ caseId: string; token: string; attemptId: string }> {
  const caseId = await startedCase(fields);
  const { attemptId } = await attemptOf(caseId, "B1");
  const { status, answer } = await handOut(caseId, attemptId);
  assert.equal(status, 200);
  assert.equal(answer.ok, true, JSON.stringify(answer));
  return { caseId, token: answer.token as string, attemptId };
}

async function storeObject(caseId: string, token: string, fill: { length: number; byte: number }, more: Readonly<{ digest?: string; stream?: boolean; caseHeader?: string }> = {}): Promise<{ status: number; answer: Answer }> {
  const headers: Record<string, string> = { [RUNNER_CALL_HEADER]: "runner-object", [RUNNER_CASE_HEADER]: more.caseHeader ?? caseId, [RUNNER_TOKEN_HEADER]: token, "content-type": "application/octet-stream" };
  if (more.digest !== undefined) headers[RUNNER_DIGEST_HEADER] = more.digest;
  return through(caseId, { headers, fill, stream: more.stream });
}

/** An object's request as the handler sends one, built inside the object and given to it directly, its body counted as it is pulled. */
type Straight = Readonly<{ headers: Record<string, string>; declared: number; first: number; rest: number; byte: number }>;
type StraightAnswer = { status: number; answer: Answer; pulled: number };
const objectHeaders = (caseId: string, token: string): Record<string, string> => ({ [RUNNER_CALL_HEADER]: "runner-object", [RUNNER_CASE_HEADER]: caseId, [RUNNER_TOKEN_HEADER]: token, "content-type": "application/octet-stream" });
const whole = (caseId: string, token: string, length: number, byte: number): Straight => ({ headers: objectHeaders(caseId, token), declared: length, first: length, rest: 0, byte });

async function straight(caseId: string, object: Straight): Promise<StraightAnswer> {
  const { answer } = await world.direct(CASES_BINDING, caseId, { call: "test-straight-to-object", object });
  answers.push(answer);
  return answer as unknown as StraightAnswer;
}

/** A first object held open after its first part, each of `during` sent while it is, then the first let finish. */
async function inFlight(caseId: string, first: Straight, during: readonly Straight[]): Promise<{ startedReading: number; during: StraightAnswer[]; first: StraightAnswer }> {
  const { answer } = await world.direct(CASES_BINDING, caseId, { call: "test-objects-in-flight", first, during });
  answers.push(answer);
  return answer as unknown as { startedReading: number; during: StraightAnswer[]; first: StraightAnswer };
}

const recordsOf = async (caseId: string, slot = "B1") => ({
  runner: (await storageOf(caseId)).runner_records?.find((row) => row.slot === slot) ?? null,
  run: (await storageOf(caseId)).runner_runs?.find((row) => row.slot === slot) ?? null
});

/** Wait for what a container's exit does after the call that reported it has been answered. */
async function until(label: string, check: () => Promise<boolean>): Promise<void> {
  for (let tries = 0; tries < 50; tries += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`${label}: not seen within five seconds`);
}

const stopByAlarm = async (caseId: string): Promise<Answer> => {
  await world.direct(CASES_BINDING, caseId, { call: "test-due-now" });
  return (await world.direct(CASES_BINDING, caseId, { call: "test-run-alarm" })).answer;
};

/** The plan with a second baseline slot, so a second attempt can start in the same case. */
const TWO_BASELINES = [...CREATE_FIELDS.slice(0, 1), ["slot", "B2"] as const, ...CREATE_FIELDS.slice(1)];

/** B2's start, on an exception of its own: an exception covers one start. */
async function startB2(caseId: string): Promise<number> {
  assert.equal((await command(caseId, "/exception", [["slot", "B2"], ["reason", "No control run exists yet."]])).status, 303);
  return (await command(caseId, "/attempts/B2/start")).status;
}

/** B1 reports failed through the handler. */
async function b1Finished(caseId: string, token: string): Promise<void> {
  assert.equal((await write(caseId, token, "attempt-finished", { slot: "B1", outcome: "failed", reason: "browser-crashed" })).answer.ok, true);
}

test("1. a start the case refuses, a conflict, a resend and a refused assertion launch nothing", { timeout: 180_000 }, async () => {
  const unfrozen = await world.create();
  assert.equal(refusalOn((await command(unfrozen, "/attempts/B1/start")).body), "plan-not-frozen");
  assert.deepEqual(await namesOf(unfrozen), []);

  const caseId = await readyCase();
  const viewed = (await opened(caseId)).head;
  const expired = Object.entries(world.refusedTokens).find(([name]) => name === "an expired token")?.[1] ?? null;
  assert.equal((await command(caseId, "/attempts/B1/start", [], expired)).status, 401);
  assert.deepEqual(await namesOf(caseId), []);
  assert.equal((await command(caseId, "/attempts/B1/start")).status, 303);
  const launched = await namesOf(caseId);
  assert.deepEqual(launched, ["handler-for", "intercept", "start", "monitor"]);
  // The same start sent again on the head it was viewed at is a conflict, and launches nothing more.
  const resent = await world.send(`/cases/${caseId}/attempts/B1/start`, { fields: [["head", viewed]] });
  assert.equal(resent.status, 409);
  // A start the machine refuses, with B1 running.
  assert.equal(refusalOn((await command(caseId, "/attempts/I1/start")).body), "another-attempt-running");
  assert.deepEqual(await namesOf(caseId), launched);
});

test("2. a written start registers the handler for its own attempt at one address, then starts with four names and no token, then watches the run", { timeout: 180_000 }, async () => {
  const caseId = await startedCase();
  const { attemptId } = await attemptOf(caseId, "B1");
  const calls = await callsOf(caseId);
  assert.deepEqual(calls.map(({ call }) => call), ["handler-for", "intercept", "start", "monitor"]);
  assert.deepEqual(calls[0].detail, { caseId, slot: "B1", attemptId });
  assert.deepEqual(calls[1].detail, { address: HANDLER_HOST });
  const start = calls[2].detail as { env: Record<string, string>; enableInternet: boolean };
  assert.deepEqual(Object.keys(start).sort(), ["enableInternet", "env"]);
  assert.equal(start.enableInternet, false);
  assert.deepEqual(Object.keys(start.env).sort(), [...START_ENV_NAMES]);
  assert.deepEqual(start.env, { SBL_ATTEMPT_ID: attemptId, SBL_CASE_ID: caseId, SBL_HANDLER_ORIGIN: `http://${HANDLER_HOST}`, SBL_SLOT: "B1" });
  // The handler registered is reached through the binding and acts for that attempt.
  const { status, answer } = await handOut(caseId, attemptId);
  assert.equal(status, 200);
  assert.equal(answer.ok, true);
  assert.equal(JSON.stringify(calls).includes(answer.token as string), false);
});

test("3. a start that throws, or a registration that is refused, writes no event: the attempt reads starting, is flagged, and no token is ever handed", { timeout: 180_000 }, async () => {
  for (const [planted, expectedCalls] of [
    ["start-throws", ["handler-for", "intercept", "start"]],
    ["intercept-rejects", ["handler-for", "intercept"]]
  ] as const) {
    const caseId = await readyCase();
    await fault(caseId, planted, true);
    assert.equal((await command(caseId, "/attempts/B1/start")).status, 303, planted);
    const seq = (await opened(caseId)).seq;
    assert.deepEqual(await namesOf(caseId), expectedCalls, planted);
    assert.deepEqual(await phases(caseId), ["B1:starting:pending", "I1:planned:none"], planted);
    assert.deepEqual((await openAnswer(caseId)).runnerFlags, [{ slot: "B1", reason: "container-start-failed" }], planted);
    const { attemptId } = await attemptOf(caseId, "B1");
    // Asked of the object directly: no binding was registered for a refused registration.
    assert.deepEqual((await world.direct(CASES_BINDING, caseId, { call: "runner-token", caseId, attemptId })).answer, { ok: false, refusal: "token-revoked" }, planted);
    assert.equal((await opened(caseId)).seq, seq, planted);
  }
});

test("4. the alarm's stop records the stop, destroys the container, then writes the destroy record, and the token is refused after", { timeout: 180_000 }, async () => {
  const { caseId, token } = await withToken();
  assert.equal((await recordsOf(caseId)).runner?.destroyed_at_ms ?? null, null);
  assert.deepEqual(await stopByAlarm(caseId), { ok: true });
  assert.deepEqual((await namesOf(caseId)).slice(-1), ["destroy"]);
  const { runner, run } = await recordsOf(caseId);
  assert.notEqual(runner?.stopped_at_ms, null);
  assert.notEqual(runner?.destroyed_at_ms, null);
  assert.notEqual(run?.destroyed_at_ms, null);
  assert.deepEqual((await write(caseId, token, "capture-began", { slot: "B1" })).answer, { ok: false, refusal: "token-refused", at: null, head: null });
});

test("5. a destroy that fails leaves the stop, no destroy record and the mark unflagged; the next delivery destroys and records", { timeout: 180_000 }, async () => {
  const { caseId } = await withToken();
  await fault(caseId, "destroy-fails", true);
  assert.equal((await stopByAlarm(caseId)).ok, false);
  let { runner } = await recordsOf(caseId);
  assert.notEqual(runner?.stopped_at_ms, null);
  assert.equal(runner?.destroyed_at_ms, null);
  const marks = (await world.direct(CASES_BINDING, caseId, { call: "test-marks" })).answer as { marks: { kind: string; flagged_at_ms: number | null }[] };
  assert.ok(marks.marks.some(({ kind, flagged_at_ms }) => kind === "attempt-deadline" && flagged_at_ms === null));
  await fault(caseId, "destroy-fails", false);
  assert.deepEqual((await world.direct(CASES_BINDING, caseId, { call: "test-run-alarm" })).answer, { ok: true });
  ({ runner } = await recordsOf(caseId));
  assert.notEqual(runner?.destroyed_at_ms, null);
  assert.deepEqual((await namesOf(caseId)).filter((name) => name === "destroy").length, 2);
});

test("6. a second stop of the same attempt is done: no second destroy, and the records stand", { timeout: 180_000 }, async () => {
  const { caseId, attemptId } = await withToken();
  // A second token request stops the runner, which destroys the container.
  assert.deepEqual((await handOut(caseId, attemptId)).answer, { ok: false, refusal: "token-already-handed" });
  assert.deepEqual((await namesOf(caseId)).filter((name) => name === "destroy").length, 1);
  const kept = await recordsOf(caseId);
  // The deadline's stop comes after it, and finds the destroy record.
  assert.deepEqual(await stopByAlarm(caseId), { ok: true });
  assert.deepEqual((await namesOf(caseId)).filter((name) => name === "destroy").length, 1);
  assert.deepEqual(await recordsOf(caseId), kept);
});

test("7. the exit of a run destroys and records that run only; an earlier run's exit after a later start touches nothing", { timeout: 180_000 }, async () => {
  const exiting = await startedCase();
  assert.deepEqual((await world.direct(CASES_BINDING, exiting, { call: "test-container-exit", which: "latest" })).answer, { ok: true });
  await until("the exit's destroy record", async () => ((await recordsOf(exiting)).runner?.destroyed_at_ms ?? null) !== null);
  assert.deepEqual((await namesOf(exiting)).slice(-1), ["destroy"]);

  const caseId = await readyCase(TWO_BASELINES);
  assert.equal((await command(caseId, "/attempts/B1/start")).status, 303);
  const { token } = await handOut(caseId, (await attemptOf(caseId, "B1")).attemptId).then(({ answer }) => answer as { token: string });
  await b1Finished(caseId, token);
  // The owner answers for B1's cleanup while its container still runs; B2's start destroys it first.
  assert.equal((await command(caseId, "/attempts/B1/cleanup", [["cleanup", "confirmed"]])).status, 303);
  assert.equal(await startB2(caseId), 303);
  const before = await callsOf(caseId);
  assert.deepEqual((await world.direct(CASES_BINDING, caseId, { call: "test-container-exit", which: "first" })).answer, { ok: true });
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.deepEqual(await callsOf(caseId), before);
  assert.equal((await recordsOf(caseId, "B2")).run?.destroyed_at_ms, null);
});

test("8. the runner's own cleanup event ends its container: the stop, the destroy, the destroy record", { timeout: 180_000 }, async () => {
  const { caseId, token } = await withToken();
  await b1Finished(caseId, token);
  assert.equal((await recordsOf(caseId)).runner?.destroyed_at_ms ?? null, null);
  assert.equal((await write(caseId, token, "cleanup-confirmed", { slot: "B1" })).answer.ok, true);
  assert.deepEqual((await namesOf(caseId)).slice(-1), ["destroy"]);
  const { runner } = await recordsOf(caseId);
  assert.notEqual(runner?.stopped_at_ms, null);
  assert.notEqual(runner?.destroyed_at_ms, null);
});

test("9. only the destroy record lets the owner record a slot's environment as destroyed; a stop alone does not", { timeout: 180_000 }, async () => {
  const caseId = await startedCase();
  await fault(caseId, "destroy-fails", true);
  // The owner's reconcile ends the attempt and stops its run; the destroy fails, so only the stop is recorded.
  assert.equal((await command(caseId, "/reconcile")).status, 303);
  const { runner } = await recordsOf(caseId);
  assert.notEqual(runner?.stopped_at_ms, null);
  assert.equal(runner?.destroyed_at_ms, null);
  const kept = await snapshot(caseId);
  const refused = await command(caseId, "/attempts/B1/cleanup", [["cleanup", "environment-destroyed"]]);
  assert.deepEqual([refused.status, refusalOn(refused.body)], [422, "environment-not-destroyed"]);
  assert.equal(await snapshot(caseId), kept);
  // The run's exit destroys it and records it; then the owner's record is written.
  await fault(caseId, "destroy-fails", false);
  await world.direct(CASES_BINDING, caseId, { call: "test-container-exit", which: "latest" });
  await until("the destroy record after the exit", async () => ((await recordsOf(caseId)).runner?.destroyed_at_ms ?? null) !== null);
  assert.equal((await command(caseId, "/attempts/B1/cleanup", [["cleanup", "environment-destroyed"]])).status, 303);
  assert.deepEqual(await phases(caseId), ["B1:failed:environment_destroyed", "I1:planned:none"]);
});

test("10. through the handler: no token, a stale token, another case's token, another slot or attempt, and anything after the outcome but cleanup, are refused and change nothing", { timeout: 180_000 }, async () => {
  const other = await withToken();
  const { caseId, token, attemptId } = await withToken();
  const kept = await snapshot(caseId);
  const refusals: [string, Promise<{ status: number; answer: Answer }>, number, string][] = [];
  const expect = (label: string, sent: Promise<{ status: number; answer: Answer }>, status: number, refusal: string) => refusals.push([label, sent, status, refusal]);
  expect("no token", write(caseId, "", "capture-began", { slot: "B1" }), 200, "token-refused");
  expect("another case's token", write(caseId, other.token, "capture-began", { slot: "B1" }), 200, "token-refused");
  expect("another slot's event", write(caseId, token, "capture-began", { slot: "I1" }), 400, "not-this-attempt");
  expect("a call naming another case", through(caseId, json({ call: "runner", caseId: other.caseId, token, viewedHead: (await opened(caseId)).head, event: { type: "capture-began", data: { slot: "B1" } } })), 400, "not-this-attempt");
  expect("a token request for another attempt", handOut(caseId, other.attemptId), 400, "not-this-attempt");
  expect("a token request naming another case", through(caseId, json({ call: "runner-token", caseId: other.caseId, attemptId })), 400, "not-this-attempt");
  expect("a call with no token field", through(caseId, json({ call: "runner", caseId, viewedHead: "0".repeat(64), event: { type: "capture-began", data: { slot: "B1" } } })), 400, "malformed-call");
  expect("a body that is no JSON", through(caseId, { body: "not json" }), 400, "malformed-call");
  for (const [label, sent, status, refusal] of refusals) {
    const answer = await sent;
    assert.deepEqual([answer.status, answer.answer.refusal], [status, refusal], label);
  }
  assert.equal(await snapshot(caseId), kept);
  // Props that are not a start's: the handler's own export with none, malformed ones, or one key too many.
  for (const props of [undefined, { caseId, slot: "B1", attemptId: "x" }, { caseId, slot: "B1", attemptId, actor: "owner" }]) {
    const { answer } = await world.direct(CASES_BINDING, caseId, { call: "test-handler-unregistered", props, ...json({ call: "runner-token", caseId, attemptId }) });
    answers.push(answer);
    assert.deepEqual(answer, { status: 400, answer: { ok: false, refusal: "malformed-call" } }, JSON.stringify(props));
  }
  // After the outcome, a row is refused, a cleanup event passes; after its stop, a stale token writes nothing.
  await b1Finished(caseId, token);
  assert.deepEqual((await write(caseId, token, "capture-finished", { slot: "B1" })).answer.refusal, "attempt-ended");
  assert.equal((await write(caseId, token, "cleanup-confirmed", { slot: "B1" })).answer.ok, true);
  assert.deepEqual((await write(caseId, token, "cleanup-unconfirmed", { slot: "B1" })).answer.refusal, "token-refused");
});

test("11. through the handler a call cannot choose its actor: a call that carries an actor, an assertion or an attempt is refused whole, and the written actor is the token's attempt's", { timeout: 180_000 }, async () => {
  const { caseId, token, attemptId } = await withToken();
  const kept = await snapshot(caseId);
  const ownerActor = { kind: "owner", iss: "x", sub: "y", email: "z", iat: 1, exp: 2 };
  for (const extra of [{ actor: ownerActor }, { assertion: world.ownerToken }, { attemptId: "e".repeat(32) }, { by: ownerActor }]) {
    const { status, answer } = await write(caseId, token, "capture-began", { slot: "B1" }, extra);
    assert.deepEqual([status, answer.refusal], [400, "malformed-call"], JSON.stringify(extra));
  }
  assert.equal(await snapshot(caseId), kept);
  assert.equal((await write(caseId, token, "capture-began", { slot: "B1" })).answer.ok, true);
  const bucket = await world.miniflare.getR2Bucket(OBJECTS_BINDING);
  const entries = await Promise.all((await world.keys(`cases/${caseId}/entries/`)).map(async (key) => JSON.parse(await (await bucket.get(key))!.text())));
  assert.deepEqual(entries.filter(({ events }) => events[0].type === "capture-began").map(({ actor }) => actor), [{ kind: "system:runner", attemptId }]);
});

test("12. an object: bounded by its declared length before it is read, stored only under the digest worked out from its bytes, once per digest, never after the outcome", { timeout: 300_000 }, async () => {
  const { caseId, token } = await withToken();
  const bytes = new Uint8Array(1000).fill(0x61);
  const stored = await storeObject(caseId, token, { length: 1000, byte: 0x61 });
  assert.deepEqual(stored, { status: 200, answer: { ok: true, digest: sha256(bytes) } });
  assert.ok((await world.keys(`cases/${caseId}/evidence/`)).includes(`cases/${caseId}/evidence/${sha256(bytes)}`));
  // The same bytes again answer the same digest and are counted once.
  assert.deepEqual(await storeObject(caseId, token, { length: 1000, byte: 0x61 }), stored);
  assert.equal((await storageOf(caseId)).runner_objects.length, 1);
  const kept = await snapshot(caseId);
  // A digest the call gives is compared, never used as the key.
  assert.deepEqual((await storeObject(caseId, token, { length: 10, byte: 0x62 }, { digest: "0".repeat(64) })).answer, { ok: false, refusal: "digest-mismatch" });
  assert.deepEqual((await storeObject(caseId, token, { length: 10, byte: 0x62 }, { digest: "not-a-digest" })).answer, { ok: false, refusal: "malformed-call" });
  // Past the cap by its declared length, refused before it is read; with no declared length, refused.
  assert.deepEqual(await storeObject(caseId, token, { length: MAX_EVIDENCE_BYTES + 1, byte: 0x63 }), { status: 413, answer: { ok: false, refusal: "body-too-large" } });
  assert.deepEqual(await storeObject(caseId, token, { length: 10, byte: 0x63 }, { stream: true }), { status: 411, answer: { ok: false, refusal: "length-required" } });
  assert.deepEqual((await storeObject(caseId, token, { length: 10, byte: 0x63 }, { caseHeader: "f".repeat(32) })).status, 400);
  assert.deepEqual((await storeObject(caseId, "0".repeat(64), { length: 10, byte: 0x63 })).answer, { ok: false, refusal: "token-refused" });
  assert.equal(await snapshot(caseId), kept);
  // A runner call to the object without the header the handler sends is refused, so none is read unbounded.
  const head = (await opened(caseId)).head;
  assert.deepEqual(await world.directRaw(CASES_BINDING, caseId, { headers: { "content-type": "application/json" }, body: JSON.stringify({ call: "runner", caseId, token, viewedHead: head, event: { type: "capture-began", data: { slot: "B1" } } }) }), { status: 400, answer: { ok: false, refusal: "malformed-call" } });
  // A runner's call to the object is held to its own cap there too: a token request past 1 KiB is refused.
  const padded = JSON.stringify({ call: "runner-token", caseId, attemptId: (await attemptOf(caseId, "B1")).attemptId }) + " ".repeat(1024);
  assert.deepEqual(await world.directRaw(CASES_BINDING, caseId, { headers: { "content-type": "application/json", [RUNNER_CALL_HEADER]: "runner-token" }, body: padded }), { status: 413, answer: { ok: false, refusal: "body-too-large" } });
  // After the outcome an object is refused as a row is.
  await b1Finished(caseId, token);
  assert.deepEqual((await storeObject(caseId, token, { length: 10, byte: 0x64 })).answer, { ok: false, refusal: "attempt-ended" });
});

test("13. an attempt's objects are bounded in number and in bytes, counted by the object", { timeout: 600_000 }, async () => {
  const counted = await withToken();
  for (let index = 0; index < MAX_RUNNER_OBJECTS_PER_ATTEMPT; index += 1) {
    assert.equal((await storeObject(counted.caseId, counted.token, { length: 16 + index, byte: 0x41 })).answer.ok, true, `object ${index}`);
  }
  assert.deepEqual((await storeObject(counted.caseId, counted.token, { length: 200, byte: 0x41 })).answer, { ok: false, refusal: "object-bound" });
  assert.equal((await storageOf(counted.caseId)).runner_objects.length, MAX_RUNNER_OBJECTS_PER_ATTEMPT);

  const sized = await withToken();
  const whole = MAX_RUNNER_OBJECT_BYTES_PER_ATTEMPT / MAX_EVIDENCE_BYTES;
  assert.ok(Number.isInteger(whole) && whole > 0);
  for (let index = 0; index < whole; index += 1) {
    assert.equal((await storeObject(sized.caseId, sized.token, { length: MAX_EVIDENCE_BYTES, byte: 0x30 + index })).answer.ok, true, `large object ${index}`);
  }
  assert.deepEqual((await storeObject(sized.caseId, sized.token, { length: 1, byte: 0x7a })).answer, { ok: false, refusal: "object-bound" });
});

test("14. no route of the front Worker reaches the handler or a runner's calls", { timeout: 180_000 }, async () => {
  const caseId = await startedCase();
  const before = await callsOf(caseId);
  const kept = await snapshot(caseId);
  for (const pathname of [`/cases/${caseId}/runner`, `/cases/${caseId}/runner-token`, `/cases/${caseId}/runner-object`, "/runner", "/runner-object", "/"]) {
    for (const method of ["GET", "POST"]) {
      const answer = await world.send(pathname, method === "POST" ? { fields: [["call", "runner-token"]] } : {});
      assert.equal(answer.status, 404, `${method} ${pathname}`);
    }
  }
  assert.deepEqual(await callsOf(caseId), before);
  assert.equal(await snapshot(caseId), kept);
});

test("15. never two runs at once: a live earlier run is destroyed and recorded before the next start, and a destroy that fails launches nothing and flags the attempt", { timeout: 180_000 }, async () => {
  for (const failing of [false, true]) {
    const caseId = await readyCase(TWO_BASELINES);
    assert.equal((await command(caseId, "/attempts/B1/start")).status, 303);
    const { token } = (await handOut(caseId, (await attemptOf(caseId, "B1")).attemptId)).answer as { token: string };
    await b1Finished(caseId, token);
    assert.equal((await command(caseId, "/attempts/B1/cleanup", [["cleanup", "confirmed"]])).status, 303);
    if (failing) await fault(caseId, "destroy-fails", true);
    assert.equal((await command(caseId, "/exception", [["slot", "B2"], ["reason", "No control run exists yet."]])).status, 303);
    const before = (await callsOf(caseId)).length;
    assert.equal((await command(caseId, "/attempts/B2/start")).status, 303);
    const after = (await callsOf(caseId)).slice(before);
    const label = failing ? "a failing destroy" : "a destroy";
    if (!failing) {
      assert.deepEqual(after.map(({ call }) => call), ["destroy", "handler-for", "intercept", "start", "monitor"], label);
      assert.notEqual((await recordsOf(caseId, "B1")).run?.destroyed_at_ms, null, label);
      assert.deepEqual(after[1].detail, { caseId, slot: "B2", attemptId: (await attemptOf(caseId, "B2")).attemptId }, label);
    } else {
      assert.deepEqual(after.map(({ call }) => call), ["destroy"], label);
      assert.deepEqual((await openAnswer(caseId)).runnerFlags, [{ slot: "B2", reason: "container-destroy-failed" }], label);
      assert.equal((await recordsOf(caseId, "B1")).run?.destroyed_at_ms, null, label);
    }
  }
});

test("16. the owner's ending commands stop the live run of each attempt they end", { timeout: 180_000 }, async () => {
  for (const pathname of ["/reconcile", "/attempts/B1/deadline", "/cancel"]) {
    const caseId = await startedCase();
    assert.equal((await command(caseId, pathname)).status, 303, pathname);
    assert.deepEqual((await namesOf(caseId)).slice(-1), ["destroy"], pathname);
    assert.notEqual((await recordsOf(caseId)).runner?.destroyed_at_ms, null, pathname);
  }
});

test("17. a canary token is absent from every answer, error, key, object, entry, storage row and container call, and from the owner's pages", { timeout: 180_000 }, async () => {
  const { caseId, token } = await withToken();
  await write(caseId, token, "capture-began", { slot: "B1" });
  await storeObject(caseId, token, { length: 64, byte: 0x71 });
  await storeObject(caseId, token, { length: 64, byte: 0x72 }, { digest: "1".repeat(64) });
  await write(caseId, token, "capture-began", { slot: "I1" });
  await stopByAlarm(caseId);
  await write(caseId, token, "capture-finished", { slot: "B1" });
  const bucket = await world.miniflare.getR2Bucket(OBJECTS_BINDING);
  const keys = await world.keys(`cases/${caseId}/`);
  const objects = await Promise.all(keys.map(async (key) => (await bucket.get(key))!.text()));
  const page = await world.send(`/cases/${caseId}`);
  const places: Readonly<Record<string, string>> = { keys: keys.join("\n"), objects: objects.join("\n"), storage: JSON.stringify(await storageOf(caseId)), calls: JSON.stringify(await callsOf(caseId)), answers: JSON.stringify(answers.filter((answer) => (answer as { answer?: { token?: unknown } }).answer?.token !== token)), open: JSON.stringify(await openAnswer(caseId)), page: page.body };
  for (const [where, text] of Object.entries(places)) {
    assert.ok(text.length > 0, where);
    assert.ok(!text.includes(token), where);
  }
  // A check that would find it: the one answer that hands the token over holds it, and only that one.
  assert.equal(answers.filter((answer) => JSON.stringify(answer).includes(token)).length, 1);
});

test("18. the object holds an object to its declared length before its token: past the cap, a forged token is answered 413 and nothing is read", { timeout: 180_000 }, async () => {
  const { caseId, token } = await withToken();
  const forged = "0".repeat(64);
  for (const sent of [forged, token]) {
    assert.deepEqual(await straight(caseId, { ...whole(caseId, sent, 16, 0x65), declared: MAX_EVIDENCE_BYTES + 1 }), { status: 413, answer: { ok: false, refusal: "body-too-large" }, pulled: 0 }, sent === token ? "its token" : "a forged token");
  }
  // Within the cap the forged token is what is refused, still unread; with its token the object is read whole and stored.
  assert.deepEqual(await straight(caseId, whole(caseId, forged, 16, 0x65)), { status: 200, answer: { ok: false, refusal: "token-refused" }, pulled: 0 });
  assert.deepEqual(await straight(caseId, whole(caseId, token, 16, 0x65)), { status: 200, answer: { ok: true, digest: sha256(new Uint8Array(16).fill(0x65)) }, pulled: 16 });
});

test("19. one object at a time: while one is read, another is refused object-in-flight unread after its token is checked, and the hold is freed however the first ends", { timeout: 180_000 }, async () => {
  const { caseId, token } = await withToken();
  const forged = "0".repeat(64);
  const held = await inFlight(caseId, { headers: objectHeaders(caseId, token), declared: 4096, first: 1024, rest: 3072, byte: 0x66 }, [whole(caseId, forged, 64, 0x67), whole(caseId, token, 64, 0x67)]);
  assert.equal(held.startedReading, 1024);
  assert.deepEqual(held.during, [
    { status: 200, answer: { ok: false, refusal: "token-refused" }, pulled: 0 },
    { status: 200, answer: { ok: false, refusal: "object-in-flight" }, pulled: 0 }
  ]);
  assert.deepEqual(held.first, { status: 200, answer: { ok: true, digest: sha256(new Uint8Array(4096).fill(0x66)) }, pulled: 4096 });
  // Once the first is stored the one refused is taken.
  assert.deepEqual(await straight(caseId, whole(caseId, token, 64, 0x67)), { status: 200, answer: { ok: true, digest: sha256(new Uint8Array(64).fill(0x67)) }, pulled: 64 });
  // A first that ends refused, its body shorter than it declares, frees the hold as well.
  const cut = await inFlight(caseId, { headers: objectHeaders(caseId, token), declared: 4096, first: 1024, rest: 0, byte: 0x68 }, [whole(caseId, token, 64, 0x69)]);
  assert.deepEqual([cut.during[0].answer, cut.first.status, cut.first.answer], [{ ok: false, refusal: "object-in-flight" }, 400, { ok: false, refusal: "body-length-mismatch" }]);
  assert.deepEqual(await straight(caseId, whole(caseId, token, 64, 0x69)), { status: 200, answer: { ok: true, digest: sha256(new Uint8Array(64).fill(0x69)) }, pulled: 64 });
  assert.equal((await storageOf(caseId)).runner_objects.length, 3);
});
