import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, test } from "node:test";
import { CASES_BINDING, CREATE_FIELDS, CREATE_PLAN, hostWorld, type HostWorld } from "./case-host-fixture";
import { IDENTITY_ALDER } from "./case-fixture";

/**
 * The owner's commands on a hosted case, through the production entry's own bundle on real
 * workerd: each command written, each refusal the case's own rules give, and what an object
 * answers when a command reaches it past the gate. This workspace has no runner, so a started
 * attempt stays in `starting`, and a visit can rest only on an exception: no control run exists
 * to record a control. Nothing deploys, and every store is in memory.
 */

let world: HostWorld;

before(async () => {
  world = await hostWorld(null, "investigation-worker.js");
}, { timeout: 180_000 });

after(async () => {
  await world?.dispose();
});

type Attempt = { slot: string; phase: string; cleanup: string | null; attemptId: string };
type View = { caseId: string; head: string; seq: number; state: { machine: { planDigest: string | null; closedBy: string | null; exploratory: boolean; exceptionFor: string | null; baselineRule: string; attempts: Attempt[] }; keptObjects: string[] } | null };

async function viewOf(caseId: string): Promise<View> {
  const { answer } = await world.direct(CASES_BINDING, caseId, { call: "open", assertion: world.ownerToken, caseId });
  assert.equal(answer.ok, true, JSON.stringify(answer));
  return answer.case as View;
}

/** One command through the front Worker, at the head the case has now unless the test names another. */
async function command(caseId: string, path: string, fields: readonly (readonly [string, string])[] = [], head?: string) {
  return world.send(`/cases/${caseId}${path}`, { fields: [["head", head ?? (await viewOf(caseId)).head], ...fields] });
}

const phases = (view: View): string[] => (view.state?.machine.attempts ?? []).map(({ slot, phase, cleanup }) => `${slot}:${phase}:${cleanup ?? "none"}`);
const refusalOn = (body: string): string | null => /The case refused it: <code>([a-z-]+)<\/code>/.exec(body)?.[1] ?? null;
const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

/** A command that must be refused by the case's own rules, with nothing written. */
async function refused(caseId: string, path: string, refusal: string, fields: readonly (readonly [string, string])[] = []): Promise<void> {
  const before = await viewOf(caseId);
  const answer = await command(caseId, path, fields);
  assert.deepEqual([answer.status, refusalOn(answer.body)], [422, refusal], `${path}: ${answer.body.slice(0, 200)}`);
  assert.equal((await viewOf(caseId)).head, before.head, path);
}

/** A command that must be written: a redirect to the case, and one more entry. */
async function written(caseId: string, path: string, fields: readonly (readonly [string, string])[] = []): Promise<View> {
  const before = await viewOf(caseId);
  const answer = await command(caseId, path, fields);
  assert.deepEqual([answer.status, answer.location], [303, `/cases/${caseId}`], `${path}: ${answer.body.slice(-700, -500)}`);
  const now = await viewOf(caseId);
  assert.equal(now.seq, before.seq + 1, path);
  return now;
}

test("the owner freezes a plan, records an exception, starts, deadlines, answers for cleanup, rules and cancels, each as one entry, and each refusal writes nothing", { timeout: 120_000 }, async () => {
  const caseId = await world.create();
  const page = await world.send(`/cases/${caseId}`);
  assert.ok(page.body.includes("<h2>Commands</h2>") && !page.body.includes("A deadline is due"));

  // Nothing starts before the plan is frozen, and a frozen plan is the text given, stored as an object the plan names.
  await refused(caseId, "/attempts/B1/start", "plan-not-frozen");
  const frozen = await written(caseId, "/plan/freeze", [["plan", "the plan, as written"]]);
  assert.equal(frozen.state?.machine.planDigest, sha256("the plan, as written"));
  assert.ok(frozen.state?.keptObjects.includes(sha256("the plan, as written")));
  assert.ok((await world.keys(`cases/${caseId}/evidence/`)).includes(`cases/${caseId}/evidence/${sha256("the plan, as written")}`));
  await refused(caseId, "/plan/freeze", "plan-already-frozen", [["plan", "another plan"]]);

  // No control run exists here, so no control was recorded, and a visit can rest only on an exception.
  await refused(caseId, "/attempts/B1/start", "no-valid-control");
  await refused(caseId, "/exception", "exception-not-next", [["slot", "I1"], ["reason", "Out of turn."]]);
  const excepted = await written(caseId, "/exception", [["slot", "B1"], ["reason", "No control run exists yet."]]);
  assert.deepEqual([excepted.state?.machine.exceptionFor, excepted.state?.machine.exploratory], ["B1", true]);
  await refused(caseId, "/attempts/I1/start", "not-next-slot");

  const started = await written(caseId, "/attempts/B1/start");
  assert.deepEqual(phases(started), ["B1:starting:pending", "I1:planned:none"]);
  await refused(caseId, "/attempts/I1/start", "another-attempt-running");
  await refused(caseId, "/attempts/B1/cleanup", "attempt-running", [["cleanup", "confirmed"]]);
  await refused(caseId, "/attempts/I1/deadline", "wrong-phase");

  // The machine compares no time: a deadline is accepted whenever the owner writes it.
  const timedOut = await written(caseId, "/attempts/B1/deadline");
  assert.deepEqual(phases(timedOut), ["B1:timed_out:pending", "I1:planned:none"]);
  // A stopped attempt's cleanup is the owner's to answer for, and until it is settled nothing starts.
  await refused(caseId, "/attempts/I1/start", "cleanup-unresolved");
  const cleaned = await written(caseId, "/attempts/B1/cleanup", [["cleanup", "confirmed"]]);
  assert.deepEqual(phases(cleaned), ["B1:timed_out:confirmed", "I1:planned:none"]);
  await refused(caseId, "/attempts/B1/cleanup", "cleanup-settled", [["cleanup", "unconfirmed"]]);
  await refused(caseId, "/reconcile", "nothing-to-reconcile");

  await refused(caseId, "/attempts/I1/start", "baseline-rule-pending");
  await refused(caseId, "/baseline-rule", "baseline-floor-unmet", [["result", "met"]]);
  const cancelled = await written(caseId, "/cancel");
  assert.equal(cancelled.state?.machine.closedBy, "cancelled");
  for (const path of ["/cancel", "/deadline"]) await refused(caseId, path, "case-closed");
  await refused(caseId, "/baseline-rule", "case-closed", [["result", "not_met"]]);
  // A closed case's page offers no command that needs an open one.
  const closed = await world.send(`/cases/${caseId}`);
  assert.ok(!closed.body.includes("Cancel the case") && !closed.body.includes("Start attempt"));
});

test("reconcile reads a running attempt as failed with its cleanup unconfirmed, the owner settles it, and the case's deadline closes the case", { timeout: 120_000 }, async () => {
  const caseId = await world.create();
  await written(caseId, "/plan/freeze", [["plan", "a second plan"]]);
  await written(caseId, "/exception", [["slot", "B1"], ["reason", "No control run exists yet."]]);
  await written(caseId, "/attempts/B1/start");
  const reconciled = await written(caseId, "/reconcile");
  assert.deepEqual(phases(reconciled), ["B1:failed:unconfirmed", "I1:planned:none"]);
  await refused(caseId, "/attempts/I1/start", "cleanup-unresolved");
  const destroyed = await written(caseId, "/attempts/B1/cleanup", [["cleanup", "environment-destroyed"]]);
  assert.deepEqual(phases(destroyed), ["B1:failed:environment_destroyed", "I1:planned:none"]);
  const notMet = await written(caseId, "/baseline-rule", [["result", "not_met"]]);
  assert.equal(notMet.state?.machine.closedBy, "baseline_not_met");

  const other = await world.create();
  const deadlined = await written(other, "/deadline");
  assert.equal(deadlined.state?.machine.closedBy, "deadline");
});

test("a command names the head its writer viewed: a stale one, and the same command sent twice, is a conflict that shows the case as it stands", { timeout: 120_000 }, async () => {
  const caseId = await world.create();
  const viewed = (await viewOf(caseId)).head;
  await written(caseId, "/plan/freeze", [["plan", "a third plan"]]);
  const stale = await command(caseId, "/cancel", [], viewed);
  assert.equal(stale.status, 409);
  assert.ok(stale.body.includes("The case changed after you viewed it"));
  assert.equal((await viewOf(caseId)).state?.machine.closedBy, null);

  // No command carries a key of its own. A second send after an answer that never arrived is refused as a conflict when the first landed.
  await written(caseId, "/exception", [["slot", "B1"], ["reason", "No control run exists yet."]]);
  const head = (await viewOf(caseId)).head;
  const first = await command(caseId, "/attempts/B1/start", [], head);
  const again = await command(caseId, "/attempts/B1/start", [], head);
  assert.deepEqual([first.status, again.status], [303, 409]);
  const now = await viewOf(caseId);
  assert.deepEqual(phases(now), ["B1:starting:pending", "I1:planned:none"]);
  // The conflict's page is the case as it stands, so it shows the first send did land.
  assert.ok(again.body.includes("<code>starting</code>"));
  // Sent twice at once, one is written.
  const raced = await Promise.all([command(caseId, "/cancel", [], now.head), command(caseId, "/deadline", [], now.head)]);
  assert.deepEqual(raced.map(({ status }) => status).sort(), [303, 409]);
});

test("a command's form is its own fields and the head, by its own path, from the owner on this origin", { timeout: 120_000 }, async () => {
  const caseId = await world.create();
  const before = await viewOf(caseId);
  const head: readonly [string, string] = ["head", before.head];
  for (const [why, path, fields, status] of [
    ["a field the command does not take", "/cancel", [head, ["slot", "B1"]], 400],
    ["an attempt id sent with a start", "/attempts/B1/start", [head, ["attemptId", "ab".repeat(16)]], 400],
    ["no head", "/cancel", [], 400],
    ["a head that is no digest", "/cancel", [["head", "latest"]], 400],
    ["a cleanup that is no cleanup", "/attempts/B1/cleanup", [head, ["cleanup", "constructor"]], 400],
    ["no reason", "/exception", [head, ["slot", "B1"]], 400],
    ["a slot that is no slot", "/attempts/B9/start", [head], 404],
    ["a path no command has", "/start", [head], 404],
    ["a path no command has", "/purge", [head], 404],
    ["a path no command has", "/control", [head], 404]
  ] as const) {
    const answer = await world.send(`/cases/${caseId}${path}`, { fields: fields as readonly (readonly [string, string])[] });
    assert.equal(answer.status, status, `${why}: ${path}`);
  }
  // An event's own shape is the decoder's to refuse: a result that is no result, an empty reason.
  assert.equal((await command(caseId, "/baseline-rule", [["result", "maybe"]])).status, 422);
  assert.equal((await command(caseId, "/exception", [["slot", "B1"], ["reason", " "]])).status, 422);
  assert.equal((await command(caseId, "/plan/freeze", [["plan", "x".repeat(4097)]])).status, 422);
  assert.equal((await world.send(`/cases/${caseId}/cancel`)).status, 405);
  for (const [who, token] of Object.entries(world.refusedTokens)) {
    const answer = await world.send(`/cases/${caseId}/cancel`, { fields: [head], token });
    assert.deepEqual([answer.status, answer.body], [401, '{"error":"access-refused"}'], who);
  }
  for (const origin of ["https://elsewhere.example", null]) assert.equal((await world.send(`/cases/${caseId}/cancel`, { fields: [head], origin })).status, 403, String(origin));
  const after = await viewOf(caseId);
  assert.deepEqual([after.head, after.seq], [before.head, before.seq]);
  assert.deepEqual(await world.keys(`cases/${caseId}/evidence/`), [IDENTITY_ALDER.criterionDigest, IDENTITY_ALDER.fixtureDigest].sort().map((digest) => `cases/${caseId}/evidence/${digest}`));
});

test("called past the gate, a case object refuses a command, a plan and a freeze for every refused assertion, and takes only the owner's commands", { timeout: 120_000 }, async () => {
  const caseId = await world.create();
  const { head } = await viewOf(caseId);
  const objects = await world.keys("");
  const cancel = { type: "case-cancelled", data: {} };
  for (const [who, assertion] of Object.entries(world.refusedTokens)) {
    for (const call of [
      { call: "command", viewedHead: head, event: cancel },
      { call: "command", viewedHead: head, event: { type: "attempt-started", data: { slot: "B1" } } },
      { call: "plan", viewedHead: head, plan: CREATE_PLAN },
      { call: "freeze", viewedHead: head, text: "a plan sent past the gate" }
    ]) {
      const { answer } = await world.direct(CASES_BINDING, caseId, { ...call, caseId, assertion });
      assert.deepEqual(answer, { ok: false, refusal: "access-refused" }, `${who}: ${call.call}`);
    }
  }
  const owner = { caseId, assertion: world.ownerToken, viewedHead: head };
  // Every event that is not the owner's command, and the two this object builds itself: a runner's, a control, a row, a changed configuration, a purge and a claim.
  const attemptId = "ab".repeat(16);
  for (const event of [
    { type: "case-planned", data: { slots: [{ slot: "B1", attemptId }], controlRunId: "cd".repeat(16), configuration: IDENTITY_ALDER } },
    { type: "plan-frozen", data: { planDigest: IDENTITY_ALDER.fixtureDigest } },
    { type: "control-recorded", data: { configuration: IDENTITY_ALDER, result: "met" } },
    { type: "configuration-changed", data: { configuration: IDENTITY_ALDER } },
    { type: "capture-began", data: { slot: "B1" } },
    { type: "attempt-finished", data: { slot: "B1", outcome: "usable", reason: null } },
    { type: "evidence-recorded", data: { row: {} } },
    { type: "purge-manifest-recorded", data: { paths: [] } },
    { type: "assertion-recorded", data: { id: "said-as-a-command", statement: "A claim sent as a command." } },
    { type: "no-such-event", data: {} },
    null,
    "case-cancelled"
  ]) {
    const { answer } = await world.direct(CASES_BINDING, caseId, { call: "command", ...owner, event });
    assert.deepEqual(answer, { ok: false, refusal: "not-a-command" }, JSON.stringify(event));
  }
  // And the other way: a command is no claim.
  assert.deepEqual((await world.direct(CASES_BINDING, caseId, { call: "claim", ...owner, event: cancel })).answer, { ok: false, refusal: "not-a-claim" });
  // An object answers commands for its own case alone.
  const other = await world.create();
  for (const call of [{ call: "command", event: cancel }, { call: "plan", plan: CREATE_PLAN }, { call: "freeze", text: "a plan" }]) {
    assert.deepEqual((await world.direct(CASES_BINDING, caseId, { ...call, ...owner, caseId: other })).answer, { ok: false, refusal: "head-missing", at: null }, call.call);
  }
  assert.deepEqual((await viewOf(caseId)).head, head);
  assert.deepEqual((await world.keys("")).filter((key) => key.startsWith(`cases/${caseId}/`)), objects.filter((key) => key.startsWith(`cases/${caseId}/`)));
  // The same command from the owner is written, so the refusals above were for the assertion and the event.
  assert.equal((await world.direct(CASES_BINDING, caseId, { call: "command", ...owner, event: cancel })).answer.ok, true);
});

test("a plan is only for a log with no plan: a planned case refuses one, with the ids it would have minted never written", { timeout: 120_000 }, async () => {
  const caseId = await world.create();
  const before = await viewOf(caseId);
  const answer = await command(caseId, "/plan", CREATE_FIELDS);
  assert.deepEqual([answer.status, refusalOn(answer.body)], [422, "already-planned"]);
  const after = await viewOf(caseId);
  assert.deepEqual([after.head, after.state?.machine.attempts.map(({ attemptId }) => attemptId)], [before.head, before.state?.machine.attempts.map(({ attemptId }) => attemptId)]);
  const malformed = await command(caseId, "/plan", CREATE_FIELDS.map(([name, value]) => [name, name === "commit" ? "not-a-commit" : value] as const));
  assert.equal(malformed.status, 422);
  assert.ok(malformed.body.includes("<code>malformed-plan</code> at <code>configuration</code>"));
});
