import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { CASES_BINDING, CREATE_FIELDS, CREATE_PLAN, hostWorld, INDEX_BINDING, INDEX_NAME, type HostWorld } from "./case-host-fixture";
import { IDENTITY_ALDER } from "./case-fixture";
import { VIEWER_ENV } from "./viewer-fixture";

/**
 * The production entry's own bundle on real workerd, with its two Durable Object classes on
 * SQLite storage and a local bucket: a case is created, opened, listed and written to through
 * the front Worker, and each object is then called past the gate to show it refuses on its own.
 * Nothing deploys: the bundle is `wrangler deploy --dry-run`'s, and every store is in memory.
 */

let world: HostWorld;

before(async () => {
  world = await hostWorld(null, "investigation-worker.js");
}, { timeout: 180_000 });

after(async () => {
  await world?.dispose();
});

const HEAD_FIELD = /name="head" value="([0-9a-f]{64})"/;

async function headOf(caseId: string): Promise<string> {
  const page = await world.send(`/cases/${caseId}`);
  assert.equal(page.status, 200, page.body.slice(0, 300));
  const head = HEAD_FIELD.exec(page.body)?.[1];
  assert.ok(head !== undefined, "the case page carries its head");
  return head;
}

/** What an object answers the owner about a case, past the gate. */
async function openDirect(caseId: string, name: string = caseId): Promise<Record<string, unknown>> {
  return (await world.direct(CASES_BINDING, name, { call: "open", assertion: world.ownerToken, caseId })).answer;
}

test("with its bindings the entry serves cases, and a case is created under a minted id, opened and listed", { timeout: 120_000 }, async () => {
  const health = await world.send("/health");
  assert.deepEqual([health.status, JSON.parse(health.body)], [200, { status: "serving-cases", commit: VIEWER_ENV.SITE_BEHAVIOR_LAB_BUILD_COMMIT }]);
  assert.deepEqual(await world.listed(), { created: [], unfinished: [] });

  const caseId = await world.create();
  assert.match(caseId, /^[0-9a-f]{32}$/);
  const opened = await openDirect(caseId);
  assert.equal(opened.ok, true);
  const view = opened.case as { caseId: string; seq: number; head: string; state: { machine: { attempts: { slot: string; attemptId: string }[] }; configurations: unknown[]; keptObjects: string[] } };
  assert.deepEqual([view.caseId, view.seq], [caseId, 1]);
  assert.deepEqual(view.state.machine.attempts.map(({ slot }) => slot), ["B1", "I1"]);
  // The configuration the owner typed, with the two digests worked out where the objects were stored.
  assert.deepEqual(view.state.configurations, [IDENTITY_ALDER]);
  assert.deepEqual([...view.state.keptObjects].sort(), [IDENTITY_ALDER.fixtureDigest, IDENTITY_ALDER.criterionDigest].sort());
  for (const { attemptId } of view.state.machine.attempts) assert.match(attemptId, /^[0-9a-f]{32}$/);

  // Entries and evidence sit in the bucket under this case's prefix, each at its digest, and the head is not among them.
  assert.deepEqual(await world.keys(`cases/${caseId}/entries/`), [`cases/${caseId}/entries/${view.head}`]);
  assert.deepEqual(await world.keys(`cases/${caseId}/evidence/`), [IDENTITY_ALDER.criterionDigest, IDENTITY_ALDER.fixtureDigest].sort().map((digest) => `cases/${caseId}/evidence/${digest}`));
  assert.deepEqual(await world.keys(""), [...(await world.keys(`cases/${caseId}/`))]);

  const page = await world.send(`/cases/${caseId}`);
  assert.equal(page.status, 200);
  assert.ok(page.body.includes(`<h1>Case ${caseId}</h1>`));
  assert.equal(await headOf(caseId), view.head);
  const evidence = await world.send(`/cases/${caseId}/evidence/${IDENTITY_ALDER.fixtureDigest}`);
  assert.equal(evidence.status, 200);
  assert.ok(evidence.body.includes("a control fixture, invented for this fixture"));
  assert.deepEqual(await world.listed(), { created: [caseId], unfinished: [] });
  assert.deepEqual(world.outbound.refused, []);
});

test("the list shows only the cases this namespace created: a refused create, an opened id nobody created and a typed slug add nothing", { timeout: 120_000 }, async () => {
  const before = await world.listed();
  const second = await world.create();
  assert.deepEqual((await world.listed()).created.sort(), [...before.created, second].sort());
  const objects = await world.keys("");

  // Refused before any log exists, so its reservation is given back and nothing is stored.
  for (const [field, value, at] of [
    ["commit", "not-a-commit", "configuration"],
    ["fixture", "x".repeat(4097), "fixture"],
    ["criterion", "x".repeat(4097), "criterion"]
  ] as const) {
    const refused = await world.send("/cases", { fields: CREATE_FIELDS.map(([name, held]) => [name, name === field ? value : held] as const) });
    assert.equal(refused.status, 422, field);
    assert.ok(refused.body.includes(`<code>malformed-plan</code> at <code>${at}</code>`), refused.body.slice(0, 600));
  }
  const noSlots = await world.send("/cases", { fields: CREATE_FIELDS.filter(([name]) => name !== "slot") });
  assert.equal(noSlots.status, 422);
  // The form has no field for an id, and one sent anyway is refused, not ignored.
  const typedId = await world.send("/cases", { fields: [...CREATE_FIELDS, ["id", "my-own-case"]] });
  assert.equal(typedId.status, 400);
  assert.ok(typedId.body.includes("<code>malformed-form</code>"));

  // An id of the minted shape that nobody created reads as a log never created. Opening it lists nothing.
  const never = "ab".repeat(16);
  const unknown = await world.send(`/cases/${never}`);
  assert.equal(unknown.status, 409);
  assert.ok(unknown.body.includes("<code>head-missing</code>"));
  // A slug names no object: it answers as a log never created, from the front Worker alone.
  const slug = await world.send("/cases/case-one");
  assert.deepEqual([slug.status, slug.body.includes("<code>head-missing</code>")], [409, true]);

  assert.deepEqual((await world.listed()).created.sort(), [...before.created, second].sort());
  assert.deepEqual((await world.listed()).unfinished, []);
  assert.deepEqual(await world.keys(""), objects);
});

test("a create from anyone but the owner, or from another origin, is refused at the gate and reserves nothing", { timeout: 120_000 }, async () => {
  const before = await world.listed();
  const objects = await world.keys("");
  for (const [who, token] of Object.entries(world.refusedTokens)) {
    const refused = await world.send("/cases", { fields: CREATE_FIELDS, token });
    assert.deepEqual([refused.status, refused.body], [401, '{"error":"access-refused"}'], who);
    assert.equal((await world.send("/cases", { token })).status, 401, who);
  }
  for (const origin of ["https://elsewhere.example", null]) {
    const refused = await world.send("/cases", { fields: CREATE_FIELDS, origin });
    assert.deepEqual([refused.status, refused.body], [403, '{"error":"origin-refused"}'], String(origin));
  }
  assert.deepEqual(await world.listed(), before);
  assert.deepEqual(await world.keys(""), objects);
});

test("called past the gate, a case object refuses a service token and a forged, expired or wrong-audience assertion on every call, and writes nothing", { timeout: 120_000 }, async () => {
  const caseId = await world.create();
  const head = await headOf(caseId);
  const objects = await world.keys("");
  const fresh = "cd".repeat(16);
  const claim = { type: "assertion-recorded", data: { id: "said-direct", statement: "Written past the gate." } };
  for (const [who, assertion] of Object.entries(world.refusedTokens)) {
    for (const call of [
      { call: "open", caseId },
      { call: "evidence", caseId, digest: IDENTITY_ALDER.fixtureDigest, offset: 0 },
      { call: "claim", caseId, viewedHead: head, event: claim }
    ]) {
      const { status, answer } = await world.direct(CASES_BINDING, caseId, { ...call, assertion });
      assert.deepEqual([status, answer], [200, { ok: false, refusal: "access-refused" }], `${who}: ${call.call}`);
    }
    // A new case under a fresh name, too: the object verifies before it reads the plan.
    const created = await world.direct(CASES_BINDING, fresh, { call: "create", caseId: fresh, plan: CREATE_PLAN, assertion });
    assert.deepEqual(created.answer, { ok: false, refusal: "access-refused" }, `${who}: create`);
  }
  assert.equal(await headOf(caseId), head);
  assert.deepEqual(await world.keys(""), objects);
  assert.deepEqual(await openDirect(fresh), { ok: false, refusal: "head-missing", at: null });
  // The same calls with the owner's own assertion are answered, so the refusals above were for the assertion.
  assert.equal((await openDirect(caseId)).ok, true);
  const written = await world.direct(CASES_BINDING, caseId, { call: "claim", caseId, viewedHead: head, event: claim, assertion: world.ownerToken });
  assert.equal(written.answer.ok, true);
  assert.notEqual(await headOf(caseId), head);
});

test("called past the gate, the list's object refuses the same assertions on every call, and its rows do not move", { timeout: 120_000 }, async () => {
  const caseId = await world.create();
  const before = await world.listed();
  const fresh = "ef".repeat(16);
  for (const [who, assertion] of Object.entries(world.refusedTokens)) {
    for (const call of [{ call: "list" }, { call: "reserve", caseId: fresh }, { call: "confirm", caseId: fresh }, { call: "release", caseId }, { call: "release", caseId: fresh }]) {
      const { status, answer } = await world.direct(INDEX_BINDING, INDEX_NAME, { ...call, assertion });
      assert.deepEqual([status, answer], [200, { ok: false, refusal: "access-refused" }], `${who}: ${call.call}`);
    }
  }
  assert.deepEqual(await world.listed(), before);
  // The owner's own calls: a created case cannot be released, and an id with no reservation cannot be marked created.
  const owner = { assertion: world.ownerToken };
  assert.deepEqual((await world.direct(INDEX_BINDING, INDEX_NAME, { call: "release", caseId, ...owner })).answer, { ok: false, refusal: "not-reserved", at: null });
  assert.deepEqual((await world.direct(INDEX_BINDING, INDEX_NAME, { call: "confirm", caseId: fresh, ...owner })).answer, { ok: false, refusal: "not-reserved", at: null });
  assert.deepEqual((await world.direct(INDEX_BINDING, INDEX_NAME, { call: "reserve", caseId, ...owner })).answer, { ok: false, refusal: "case-id-taken", at: null });
  assert.deepEqual((await world.direct(INDEX_BINDING, INDEX_NAME, { call: "reserve", caseId: "my-own-case", ...owner })).answer, { ok: false, refusal: "malformed-case-id", at: null });
  assert.deepEqual(await world.listed(), before);
  // An object of the list's class under any other name serves nothing.
  assert.deepEqual((await world.direct(INDEX_BINDING, "another-list", { call: "list", ...owner })).answer, { ok: false, refusal: "unavailable" });
});

test("a case object answers for the case it is named for and no other, and no slug becomes a hosted case", { timeout: 120_000 }, async () => {
  const caseId = await world.create();
  const other = await world.create();
  const owner = { assertion: world.ownerToken };
  // Asked for another case's id, or one nobody created, it reads as a log never created.
  assert.deepEqual(await openDirect(other, caseId), { ok: false, refusal: "head-missing", at: null });
  assert.deepEqual(await openDirect("12".repeat(16), caseId), { ok: false, refusal: "head-missing", at: null });
  // A new case is this object's own id or nothing.
  const fresh = "34".repeat(16);
  assert.deepEqual((await world.direct(CASES_BINDING, fresh, { call: "create", caseId: other, plan: CREATE_PLAN, ...owner })).answer, { ok: false, refusal: "case-id-not-minted", at: null, logStarted: false });
  assert.deepEqual((await world.direct(CASES_BINDING, fresh, { call: "create", caseId: "my-own-case", plan: CREATE_PLAN, ...owner })).answer, { ok: false, refusal: "case-id-not-minted", at: null, logStarted: false });
  assert.deepEqual(await openDirect(fresh), { ok: false, refusal: "head-missing", at: null });
  // An object reached under a slug serves nothing at all, whatever id the call names.
  for (const named of ["my-own-case", fresh]) {
    assert.deepEqual((await world.direct(CASES_BINDING, "my-own-case", { call: "create", caseId: named, plan: CREATE_PLAN, ...owner })).answer, { ok: false, refusal: "unavailable" });
  }
  assert.deepEqual(await world.keys("cases/my-own-case/"), []);
  assert.deepEqual(await world.keys(`cases/${fresh}/`), []);

  // A second create of a case that exists is refused before anything is stored, so the first one's objects stand alone.
  const objects = await world.keys(`cases/${caseId}/`);
  const again = await world.direct(CASES_BINDING, caseId, { call: "create", caseId, plan: { ...CREATE_PLAN, fixture: "another fixture", criterion: "another criterion" }, ...owner });
  assert.deepEqual(again.answer, { ok: false, refusal: "log-exists", at: null, logStarted: true });
  assert.deepEqual(await world.keys(`cases/${caseId}/`), objects);

  // Text that would not be stored as written is refused as the plan's, before any object exists.
  for (const [field, value] of [["fixture", "lone \ud83d surrogate"], ["criterion", ""], ["fixture", 7]] as const) {
    const answer = (await world.direct(CASES_BINDING, fresh, { call: "create", caseId: fresh, plan: { ...CREATE_PLAN, [field]: value }, ...owner })).answer;
    assert.deepEqual(answer, { ok: false, refusal: "malformed-plan", at: field, logStarted: false });
  }
  assert.deepEqual(await world.keys(`cases/${fresh}/`), []);
  assert.deepEqual((await world.direct(CASES_BINDING, caseId, { call: "purge", caseId, ...owner })).status, 400);
});

test("two claims written against one head: one is committed and the other gets a conflict", { timeout: 120_000 }, async () => {
  const caseId = await world.create();
  const head = await headOf(caseId);
  const claim = (id: string) => world.send(`/cases/${caseId}/assertions`, { fields: [["head", head], ["id", id], ["statement", `Said as ${id}.`]] });
  const answers = await Promise.all([claim("said-first"), claim("said-second")]);
  assert.deepEqual(answers.map(({ status }) => status).sort(), [303, 409]);
  const opened = (await openDirect(caseId)).case as { seq: number; head: string; state: { record: { assertions: { id: string }[] } } };
  assert.equal(opened.seq, 2);
  assert.notEqual(opened.head, head);
  assert.equal(opened.state.record.assertions.length, 1);
  // The loser left at most an object no head names: the log still opens, and holds one claim.
  const entries = await world.keys(`cases/${caseId}/entries/`);
  assert.ok(entries.length === 2 || entries.length === 3, String(entries.length));
  // The same two through the objects' own stubs, so both reach the object at once with no gate between.
  const direct = (id: string) => world.direct(CASES_BINDING, caseId, { call: "claim", caseId, viewedHead: opened.head, assertion: world.ownerToken, event: { type: "assertion-recorded", data: { id, statement: `Said as ${id}.` } } });
  const raced = await Promise.all([direct("said-third"), direct("said-fourth"), direct("said-fifth")]);
  assert.deepEqual(raced.map(({ answer }) => (answer.ok === true ? "committed" : answer.refusal)).sort(), ["committed", "conflict", "conflict"]);
  const after = (await openDirect(caseId)).case as { seq: number; state: { record: { assertions: unknown[] } } };
  assert.deepEqual([after.seq, after.state.record.assertions.length], [3, 2]);
});
