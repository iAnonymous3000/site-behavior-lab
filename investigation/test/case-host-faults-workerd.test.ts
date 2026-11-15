import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, test } from "node:test";
import { GENESIS_HEAD } from "../core/case-log";
import { MAX_HOSTED_CASES } from "../core/case-host";
import { CASES_BINDING, CREATE_FIELDS, CREATE_PLAN, hostWorld, INDEX_BINDING, INDEX_NAME, OBJECTS_BINDING, type HostWorld } from "./case-host-fixture";
import { IDENTITY_ALDER } from "./case-fixture";

/**
 * What the case host does when a store fails it, and what its stores answer call by call, on
 * real workerd. The entry is the test's own, investigation/test/workerd-case-host-entry.ts: the
 * production wiring, with a bucket that fails an entry's write while a marker object exists and
 * a call that runs the stores through their contract inside an object.
 */

const ENTRY = "investigation/test/workerd-case-host-entry.ts";
const FAULT_KEY = "test-fault/entry-put";
const SLOW_KEY = "test-fault/slow-entry-put";
const SLOW_EVIDENCE_KEY = "test-fault/slow-evidence-put";

let world: HostWorld;

before(async () => {
  world = await hostWorld(ENTRY, "workerd-case-host-entry.js");
}, { timeout: 180_000 });

after(async () => {
  await world?.dispose();
});

const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

test("the head's compare-and-swap, its bounded read, create-only and a size refused before a byte is read, as an object's own storage answers them", { timeout: 120_000 }, async () => {
  const { status, answer } = await world.direct(CASES_BINDING, "9a".repeat(16), { call: "test-probe-stores" });
  assert.equal(status, 200);
  const [a, b] = ["a", "b"].map((letter) => letter.repeat(64));
  assert.deepEqual(answer, {
    // A log never created has no head, and only the first creation takes.
    absent: null,
    first: true,
    second: false,
    // A swap from a head that is not the head changes nothing.
    stale: false,
    afterRefused: a,
    swap: true,
    swapAgain: false,
    now: b,
    // A stored head past the bound is not held: it reads as the empty string.
    bounded: "",
    long: "",
    // An address that holds an object keeps it, whatever is written there next.
    created: "created",
    again: "exists",
    held: "first",
    exact: "first",
    // Past the bound by its recorded size, so nothing of it was fetched.
    tooLarge: "too-large",
    getsForTooLarge: 0,
    missing: null,
    notADigest: null,
    emptyCreated: "created",
    empty: "",
    offDigest: "refused"
  });
  assert.deepEqual(await world.keys("probe/"), [`probe/${sha256("")}`, `probe/${sha256("first")}`].sort());
});

test("a store that fails between the log's start and the plan leaves a log that opens with no plan, listed as a create that did not finish", { timeout: 120_000 }, async () => {
  const bucket = await world.miniflare.getR2Bucket(OBJECTS_BINDING);
  const whole = await world.create();
  await bucket.put(FAULT_KEY, "armed");
  const killed = await world.send("/cases", { fields: CREATE_FIELDS });
  await bucket.delete(FAULT_KEY);
  assert.deepEqual([killed.status, killed.body], [503, '{"error":"unavailable"}']);

  const listed = await world.listed();
  assert.deepEqual(listed.created, [whole]);
  assert.equal(listed.unfinished.length, 1);
  const [caseId] = listed.unfinished;
  // The log was started and holds no entry: its head is the genesis head, and no object is an entry.
  const opened = (await world.direct(CASES_BINDING, caseId, { call: "open", assertion: world.ownerToken, caseId })).answer;
  // A log with no plan has no deadline to watch, so nothing is due.
  assert.deepEqual(opened, { ok: true, case: { caseId, head: GENESIS_HEAD, seq: 0, state: null }, due: [], runnerFlags: [] });
  assert.deepEqual(await world.keys(`cases/${caseId}/entries/`), []);
  assert.deepEqual(await world.keys(`cases/${caseId}/evidence/`), [IDENTITY_ALDER.criterionDigest, IDENTITY_ALDER.fixtureDigest].sort().map((digest) => `cases/${caseId}/evidence/${digest}`));
  const page = await world.send(`/cases/${caseId}`);
  assert.equal(page.status, 200);
  assert.ok(page.body.includes("This case has a log and no plan yet"));
  const listPage = await world.send("/cases");
  assert.ok(listPage.body.includes("Creates that did not finish"));

  // Nothing in this stage plans a case that exists: a second create of it is refused, and its log stands as it was.
  const again = await world.direct(CASES_BINDING, caseId, { call: "create", caseId, plan: CREATE_PLAN, assertion: world.ownerToken });
  assert.deepEqual(again.answer, { ok: false, refusal: "log-exists", at: null, logStarted: true });
  // A claim on a log with no plan is refused by the fold, and nothing is written.
  const claim = await world.send(`/cases/${caseId}/assertions`, { fields: [["head", GENESIS_HEAD], ["id", "said-early"], ["statement", "Said before a plan."]] });
  assert.equal(claim.status, 422);
  assert.deepEqual(await world.keys(`cases/${caseId}/entries/`), []);

  // The host still works: the next create gets its own id and is whole.
  const next = await world.create();
  assert.notEqual(next, caseId);
  assert.deepEqual((await world.listed()).created.sort(), [whole, next].sort());
  assert.deepEqual((await world.listed()).unfinished, [caseId]);
});

test("two commands that both read one head and both write their entry meet at the swap, and exactly one is committed", { timeout: 120_000 }, async () => {
  const bucket = await world.miniflare.getR2Bucket(OBJECTS_BINDING);
  const caseId = await world.create();
  const opened = (await world.direct(CASES_BINDING, caseId, { call: "open", assertion: world.ownerToken, caseId })).answer.case as { head: string };
  const claim = (id: string) => world.direct(CASES_BINDING, caseId, { call: "claim", caseId, viewedHead: opened.head, assertion: world.ownerToken, event: { type: "assertion-recorded", data: { id, statement: `Said as ${id}.` } } });
  await bucket.put(SLOW_KEY, "armed");
  const raced = await Promise.all([claim("said-first"), claim("said-second"), claim("said-third")]);
  await bucket.delete(SLOW_KEY);
  assert.deepEqual(raced.map(({ answer }) => (answer.ok === true ? "committed" : answer.refusal)).sort(), ["committed", "conflict", "conflict"]);
  // All three wrote an entry, so each was past the service's own look at the head: only the swap stood between them.
  assert.equal((await world.keys(`cases/${caseId}/entries/`)).length, 4);
  const after = (await world.direct(CASES_BINDING, caseId, { call: "open", assertion: world.ownerToken, caseId })).answer.case as { seq: number; state: { record: { assertions: unknown[] } } };
  assert.deepEqual([after.seq, after.state.record.assertions.length], [2, 1]);
});

test("a reserved id whose case has no log is released on the owner's command, a case with a log never is, and a create still on its way cannot land on a released id", { timeout: 120_000 }, async () => {
  const bucket = await world.miniflare.getR2Bucket(OBJECTS_BINDING);
  const owner = { assertion: world.ownerToken };
  const before = await world.listed();
  // A place stranded with no log behind it: reserved, and its case never made.
  const stranded = "5e".repeat(16);
  assert.deepEqual((await world.direct(INDEX_BINDING, INDEX_NAME, { call: "reserve", caseId: stranded, ...owner })).answer, { ok: true });
  assert.deepEqual((await world.listed()).unfinished.filter((id) => !before.unfinished.includes(id)), [stranded]);
  assert.ok((await world.send("/cases")).body.includes(`action="/cases/${stranded}/release"`));

  // Nobody but the owner abandons a case, and a refused call leaves no mark: the case can still be made.
  for (const [who, assertion] of Object.entries(world.refusedTokens)) {
    assert.deepEqual((await world.direct(CASES_BINDING, stranded, { call: "abandon", caseId: stranded, assertion })).answer, { ok: false, refusal: "access-refused" }, who);
    assert.equal((await world.send(`/cases/${stranded}/release`, { fields: [], token: assertion })).status, 401, who);
  }
  assert.deepEqual((await world.direct(CASES_BINDING, stranded, { call: "abandon", caseId: "6f".repeat(16), ...owner })).answer, { ok: false, refusal: "head-missing", at: null });
  assert.deepEqual((await world.listed()).unfinished.filter((id) => !before.unfinished.includes(id)), [stranded]);

  const released = await world.send(`/cases/${stranded}/release`, { fields: [] });
  assert.deepEqual([released.status, released.location], [303, "/cases"]);
  const after = await world.listed();
  assert.ok(!after.unfinished.includes(stranded) && !after.created.includes(stranded));
  // The id is spent: its object refuses a create from now on, and holds no log.
  assert.deepEqual((await world.direct(CASES_BINDING, stranded, { call: "create", caseId: stranded, plan: CREATE_PLAN, ...owner })).answer, { ok: false, refusal: "case-abandoned", at: null, logStarted: false });
  assert.deepEqual((await world.direct(CASES_BINDING, stranded, { call: "open", caseId: stranded, ...owner })).answer, { ok: false, refusal: "head-missing", at: null });
  assert.deepEqual(await world.keys(`cases/${stranded}/`), []);
  // Released twice, the case answers the same and the list has nothing left to give back.
  const again = await world.send(`/cases/${stranded}/release`, { fields: [] });
  assert.equal(again.status, 422);
  assert.ok(again.body.includes("<code>not-reserved</code>"));

  // A case with a log is never released: a whole one, and one whose create stopped after its log began.
  const whole = await world.create();
  await bucket.put(FAULT_KEY, "armed");
  assert.equal((await world.send("/cases", { fields: CREATE_FIELDS })).status, 503);
  await bucket.delete(FAULT_KEY);
  const [noPlan] = (await world.listed()).unfinished.filter((id) => !after.unfinished.includes(id));
  for (const caseId of [whole, noPlan]) {
    const refused = await world.send(`/cases/${caseId}/release`, { fields: [] });
    assert.equal(refused.status, 422, caseId);
    assert.ok(refused.body.includes("<code>log-exists</code>. The list still holds it."), caseId);
    assert.deepEqual((await world.direct(CASES_BINDING, caseId, { call: "abandon", caseId, ...owner })).answer, { ok: false, refusal: "log-exists", at: null });
    assert.equal((await world.direct(CASES_BINDING, caseId, { call: "open", caseId, ...owner })).answer.ok, true, caseId);
  }
  const listed = await world.listed();
  assert.ok(listed.created.includes(whole) && listed.unfinished.includes(noPlan));

  // A create held between its own look at the mark and the start of its log, and a release that lands in between.
  const raced = "7a".repeat(16);
  assert.deepEqual((await world.direct(INDEX_BINDING, INDEX_NAME, { call: "reserve", caseId: raced, ...owner })).answer, { ok: true });
  await bucket.put(SLOW_EVIDENCE_KEY, "armed");
  const creating = world.direct(CASES_BINDING, raced, { call: "create", caseId: raced, plan: CREATE_PLAN, ...owner });
  await new Promise((resolve) => setTimeout(resolve, 150));
  const abandoned = await world.direct(CASES_BINDING, raced, { call: "abandon", caseId: raced, ...owner });
  const created = await creating;
  await bucket.delete(SLOW_EVIDENCE_KEY);
  assert.deepEqual(abandoned.answer, { ok: true });
  // The create got as far as storing its objects, and its log was refused at the head.
  assert.deepEqual(created.answer, { ok: false, refusal: "log-exists", at: null, logStarted: false });
  assert.equal((await world.keys(`cases/${raced}/evidence/`)).length, 2);
  assert.deepEqual(await world.keys(`cases/${raced}/entries/`), []);
  assert.deepEqual((await world.direct(CASES_BINDING, raced, { call: "open", caseId: raced, ...owner })).answer, { ok: false, refusal: "head-missing", at: null });
});

test("the list holds a bounded number of ids, and a create past the bound is refused with nothing reserved", { timeout: 240_000 }, async () => {
  const held = (await world.listed()).created.length + (await world.listed()).unfinished.length;
  let reserved = 0;
  let last: Record<string, unknown> = {};
  for (let index = 0; index <= MAX_HOSTED_CASES; index += 1) {
    last = (await world.direct(INDEX_BINDING, INDEX_NAME, { call: "reserve", assertion: world.ownerToken, caseId: index.toString(16).padStart(32, "0") })).answer;
    if (last.ok !== true) break;
    reserved += 1;
  }
  assert.deepEqual(last, { ok: false, refusal: "index-full", at: null });
  assert.equal(held + reserved, MAX_HOSTED_CASES);
  const objects = await world.keys("cases/");
  const refused = await world.send("/cases", { fields: CREATE_FIELDS });
  assert.equal(refused.status, 422);
  assert.ok(refused.body.includes("<code>index-full</code>"));
  assert.deepEqual(await world.keys("cases/"), objects);
  const listed = await world.listed();
  assert.equal(listed.created.length + listed.unfinished.length, MAX_HOSTED_CASES);
});
