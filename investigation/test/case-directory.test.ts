import assert from "node:assert/strict";
import { test } from "node:test";
import { caseIndexObject, caseObject, hostedCasesFrom, MAX_HOSTED_CASES, type CaseDirectory, type CreateAnswer, type HostEnv, type ListAnswer, type NewCasePlan, type ReleaseAnswer } from "../core/case-host";
import { bucketObjectStore, type HostBucket } from "../core/case-host-stores";
import { BASE_POLICY, VIEWER_STYLE_HASH } from "../core/workspace-response";
import { IDENTITY_ALDER } from "./case-fixture";
import { VIEWER_ORIGIN } from "./memory-case-world";
import { ISSUER, certsFor, generateSigningKey } from "./token-fixture";
import { AccessKeySet } from "../core/access-token";
import { textOf, VIEWER_ENV, viewerWorld } from "./viewer-fixture";

/**
 * The list's two routes and the front Worker's side of the case host, in this process. A
 * stand-in answers where a Durable Object would, so each rule here is held for what the front
 * Worker does with an answer, whatever gave it. The objects themselves, on real workerd, are
 * case-host-workerd.test.ts and case-host-faults-workerd.test.ts.
 */

const MINTED = "5c".repeat(16);
const OTHER = "6d".repeat(16);

const FIELDS: readonly (readonly [string, string])[] = [
  ["slot", "B1"],
  ["slot", "I2"],
  ["commit", `  ${IDENTITY_ALDER.commit} `],
  ["runner-image", IDENTITY_ALDER.runnerImage],
  ["rea-release", IDENTITY_ALDER.reaRelease],
  ["rea-integrity", IDENTITY_ALDER.reaIntegrity],
  ["scanner-node", IDENTITY_ALDER.scannerNode],
  ["rea-node", IDENTITY_ALDER.reaNode],
  ["chromium", IDENTITY_ALDER.chromium],
  ["instruments", " coverage  inspect\tlogger "],
  ["grammar-version", "1"],
  ["fixture", "first line\r\nsecond line\r\n"],
  ["criterion", "  kept as typed  "]
];

const PLAN: NewCasePlan = {
  slots: ["B1", "I2"],
  configuration: {
    commit: IDENTITY_ALDER.commit,
    runnerImage: IDENTITY_ALDER.runnerImage,
    reaRelease: IDENTITY_ALDER.reaRelease,
    reaIntegrity: IDENTITY_ALDER.reaIntegrity,
    scannerNode: IDENTITY_ALDER.scannerNode,
    reaNode: IDENTITY_ALDER.reaNode,
    chromium: IDENTITY_ALDER.chromium,
    instruments: ["coverage", "inspect", "logger"],
    grammarVersion: 1
  },
  fixture: "first line\nsecond line\n",
  criterion: "  kept as typed  "
};

type Recorded = { creates: NewCasePlan[]; lists: number; releases?: string[] };

function directoryAnswering(create: CreateAnswer, list: ListAnswer = { ok: true, cases: [], limit: MAX_HOSTED_CASES }, release: ReleaseAnswer = { ok: true }): { directory: CaseDirectory; recorded: Recorded; releases: string[] } {
  const recorded: Recorded = { creates: [], lists: 0 };
  const releases: string[] = [];
  return {
    recorded,
    releases,
    directory: {
      release: async (_assertion, caseId) => {
        releases.push(caseId);
        return release;
      },
      create: async (_assertion, plan) => {
        recorded.creates.push(structuredClone(plan) as NewCasePlan);
        return create;
      },
      list: async () => {
        recorded.lists += 1;
        return list;
      }
    }
  };
}

test("the list page shows created cases, sets apart a create that did not finish, and its form carries no id", async () => {
  const hostile = '"><script>window.listRan = 1</script>';
  const { directory } = directoryAnswering(
    { ok: true, caseId: MINTED },
    { ok: true, limit: MAX_HOSTED_CASES, cases: [{ caseId: MINTED, reservedAtMs: Date.UTC(2026, 10, 1, 12), created: true }, { caseId: OTHER, reservedAtMs: Date.UTC(2026, 10, 2, 12), created: false }, { caseId: hostile, reservedAtMs: Number.NaN, created: true }] }
  );
  const world = await viewerWorld({ seeded: false, directory });
  const response = await world.send("/cases");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-security-policy"), `${BASE_POLICY}; style-src '${VIEWER_STYLE_HASH}'`);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const page = await response.text();
  const [whole, late] = page.split("Creates that did not finish");
  assert.ok(whole.includes(`<a href="/cases/${MINTED}">${MINTED}</a></td><td>2026-11-01T12:00:00.000Z</td>`));
  assert.ok(!whole.includes(OTHER));
  assert.ok(late.includes(`<a href="/cases/${OTHER}">${OTHER}</a></td><td>2026-11-02T12:00:00.000Z</td>`));
  assert.ok(textOf(page).includes(`Created: 2. This workspace lists at most ${MAX_HOSTED_CASES} ids`));
  // What a list held is text and a path segment, whatever it is, and a time that is none is said to be none.
  assert.ok(!page.includes("<script>"));
  assert.ok(page.includes("&lt;script&gt;window.listRan = 1&lt;/script&gt;"));
  assert.ok(page.includes('href="/cases/%22%3E%3Cscript%3Ewindow.listRan%20%3D%201%3C%2Fscript%3E"'));
  assert.ok(page.includes("at a time not recorded"));
  // One form for each create that did not finish, to release its id, with no field at all, and none for a created case.
  const allForms = [...page.matchAll(/<form method="post" action="([^"]*)">([\s\S]*?)<\/form>/g)];
  assert.deepEqual(allForms.filter((form) => form[1] !== "/cases").map((form) => [form[1], form[2]]), [[`/cases/${OTHER}/release`, '<button type="submit">Release this id</button>']]);
  // One form to create, posting to the list's own address, with every field of a plan and none for an id.
  const forms = allForms.filter((form) => form[1] === "/cases");
  assert.deepEqual(forms.map((form) => form[1]), ["/cases"]);
  const names = [...new Set([...forms[0][2].matchAll(/ name="([^"]*)"/g)].map((match) => match[1]))].sort();
  assert.deepEqual(names, ["chromium", "commit", "criterion", "fixture", "grammar-version", "instruments", "rea-integrity", "rea-node", "rea-release", "runner-image", "scanner-node", "slot"]);
  assert.deepEqual([...forms[0][2].matchAll(/name="slot" value="([^"]*)"/g)].map((match) => match[1]), ["B1", "B2", "B3", "I1", "I2", "I3"]);
});

test("a create is sent to the directory as the plan the form held, and answers with the minted id's page", async () => {
  const { directory, recorded } = directoryAnswering({ ok: true, caseId: MINTED });
  const world = await viewerWorld({ seeded: false, directory });
  const response = await world.post("/cases", FIELDS);
  assert.deepEqual([response.status, response.headers.get("location")], [303, `/cases/${MINTED}`]);
  // Each line break is one line feed, the single-line fields are trimmed, and the two texts are kept as typed.
  assert.deepEqual(recorded.creates, [PLAN]);
});

test("a create the directory refuses answers by the refusal's kind, and shows nothing the form held", async () => {
  for (const [answer, status, shows] of [
    [{ ok: false, refusal: "malformed-plan", at: "configuration" }, 422, "<code>malformed-plan</code> at <code>configuration</code>"],
    [{ ok: false, refusal: "index-full", at: null }, 422, "<code>index-full</code>."],
    [{ ok: false, refusal: "access-refused" }, 401, '{"error":"access-refused"}'],
    [{ ok: false, refusal: "unavailable" }, 503, '{"error":"unavailable"}']
  ] as const) {
    const world = await viewerWorld({ seeded: false, directory: directoryAnswering(answer).directory });
    const response = await world.post("/cases", FIELDS);
    const body = await response.text();
    assert.equal(response.status, status, answer.refusal);
    assert.ok(body.includes(shows), body.slice(0, 400));
    assert.ok(!body.includes("kept as typed") && !body.includes(IDENTITY_ALDER.commit));
  }
  const listRefused = await viewerWorld({ seeded: false, directory: directoryAnswering({ ok: true, caseId: MINTED }, { ok: false, refusal: "access-refused" }).directory });
  assert.equal((await listRefused.send("/cases")).status, 401);
  const listDown = await viewerWorld({ seeded: false, directory: directoryAnswering({ ok: true, caseId: MINTED }, { ok: false, refusal: "unavailable" }).directory });
  assert.equal((await listDown.send("/cases")).status, 503);
});

test("a form that names an id, repeats a field, or is not a plan's form is refused before the directory is asked", async () => {
  const { directory, recorded } = directoryAnswering({ ok: true, caseId: MINTED });
  const world = await viewerWorld({ seeded: false, directory });
  const without = (name: string) => FIELDS.filter(([field]) => field !== name);
  for (const [why, fields, status] of [
    ["an id", [...FIELDS, ["id", "my-own-case"]], 400],
    ["a case", [...FIELDS, ["case", MINTED]], 400],
    ["a head, which a claim carries", [...FIELDS, ["head", "0".repeat(64)]], 400],
    ["two commits", [...FIELDS, ["commit", IDENTITY_ALDER.commit]], 400],
    ["no fixture", without("fixture"), 400],
    ["no grammar version", without("grammar-version"), 400],
    ["a grammar version that is no whole number", [...without("grammar-version"), ["grammar-version", "1.5"]], 400],
    ["a grammar version with a sign", [...without("grammar-version"), ["grammar-version", "-1"]], 400]
  ] as const) {
    const response = await world.post("/cases", fields as readonly (readonly [string, string])[]);
    assert.equal(response.status, status, why);
    assert.ok((await response.text()).includes("<code>malformed-form</code>"), why);
  }
  assert.equal((await world.post("/cases", FIELDS, { contentType: "application/json" })).status, 415);
  assert.equal((await world.post("/cases", [...without("fixture"), ["fixture", "x".repeat(400_000)]])).status, 413);
  assert.deepEqual(recorded.creates, []);
});

test("the list's routes answer 503 with no directory, by their own two methods with one, and nobody but the owner on this origin reaches the directory", async () => {
  const absent = await viewerWorld({ seeded: false });
  assert.deepEqual([(await absent.send("/cases")).status, (await absent.post("/cases", FIELDS)).status], [503, 503]);
  assert.equal((await absent.send("/cases", { token: absent.serviceToken })).status, 401);

  const { directory, recorded } = directoryAnswering({ ok: true, caseId: MINTED });
  const world = await viewerWorld({ seeded: false, directory });
  for (const method of ["HEAD", "PUT", "DELETE", "PATCH", "OPTIONS"]) {
    const response = await world.send("/cases", { method, origin: VIEWER_ORIGIN });
    assert.deepEqual([response.status, response.headers.get("allow")], [405, "GET, POST"], method);
  }
  for (const pathname of ["/cases/", "/case", "/cases//"]) assert.equal((await world.send(pathname)).status, 404, pathname);
  for (const [who, token] of Object.entries({ "no token": null, "a forged token": world.forgedToken, "another person": world.otherPersonToken, "a service token": world.serviceToken, "a malformed token": "not.a.token" })) {
    assert.equal((await world.send("/cases", { token })).status, 401, who);
    assert.equal((await world.post("/cases", FIELDS, { token })).status, 401, who);
  }
  for (const origin of ["https://elsewhere.example", null]) assert.equal((await world.post("/cases", FIELDS, { origin })).status, 403, String(origin));
  assert.deepEqual(recorded, { creates: [], lists: 0 });
});

/** A namespace whose objects answer what a test says, recording every call by the name it reached. */
function namespaceAnswering(answerFor: (name: string, call: Record<string, unknown>) => Response | Error) {
  const calls: { name: string; call: Record<string, unknown> }[] = [];
  return {
    calls,
    namespace: {
      idFromName: (name: string) => ({ name }),
      get: (id: { name: string }) => ({
        fetch: async (_url: string, init: { body: string }) => {
          const call = JSON.parse(init.body) as Record<string, unknown>;
          calls.push({ name: id.name, call });
          const answer = answerFor(id.name, call);
          if (answer instanceof Error) throw answer;
          return answer;
        }
      })
    }
  };
}

const BUCKET = { head: async () => null, get: async () => null, put: async () => ({}) };
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });

function hostedWith(caseAnswer: (call: Record<string, unknown>) => Response | Error, indexAnswer: (call: Record<string, unknown>) => Response | Error = () => json({ ok: true })) {
  const cases = namespaceAnswering((_name, call) => caseAnswer(call));
  const index = namespaceAnswering((_name, call) => indexAnswer(call));
  const env: HostEnv = { ...VIEWER_ENV, INVESTIGATION_CASES: cases.namespace, INVESTIGATION_CASE_INDEX: index.namespace, INVESTIGATION_OBJECTS: BUCKET };
  const hosted = hostedCasesFrom(env, () => MINTED);
  assert.ok(hosted !== null);
  return { hosted, caseCalls: cases.calls, indexCalls: index.calls };
}

const order = (calls: readonly { name: string; call: Record<string, unknown> }[]) => calls.map(({ name, call }) => `${name}:${String(call.call)}:${String(call.caseId)}`);

test("the front Worker serves cases only with its configuration and all three bindings", () => {
  const { namespace } = namespaceAnswering(() => json({ ok: true }));
  const whole: HostEnv = { ...VIEWER_ENV, INVESTIGATION_CASES: namespace, INVESTIGATION_CASE_INDEX: namespace, INVESTIGATION_OBJECTS: BUCKET };
  assert.ok(hostedCasesFrom(whole) !== null);
  for (const missing of ["INVESTIGATION_CASES", "INVESTIGATION_CASE_INDEX", "INVESTIGATION_OBJECTS", "INVESTIGATION_OWNER_SUBJECT", "INVESTIGATION_WORKSPACE_HOSTNAME"] as const) {
    assert.equal(hostedCasesFrom({ ...whole, [missing]: undefined }), null, missing);
  }
  // A binding of another kind is no binding: a bucket where a namespace belongs, and the other way.
  assert.equal(hostedCasesFrom({ ...whole, INVESTIGATION_CASES: BUCKET }), null);
  assert.equal(hostedCasesFrom({ ...whole, INVESTIGATION_OBJECTS: namespace }), null);
  assert.equal(hostedCasesFrom({ ...whole, INVESTIGATION_CASE_INDEX: "case-index" }), null);
});

test("a create reserves the minted id, makes the case in the object of that name, and marks it created, in that order", async () => {
  const { hosted, caseCalls, indexCalls } = hostedWith(() => json({ ok: true, case: { caseId: MINTED, head: "a".repeat(64), seq: 1, state: null } }));
  assert.deepEqual(await hosted.directory.create("the-assertion", PLAN), { ok: true, caseId: MINTED });
  assert.deepEqual(order(indexCalls), [`case-index:reserve:${MINTED}`, `case-index:confirm:${MINTED}`]);
  assert.deepEqual(caseCalls, [{ name: MINTED, call: { call: "create", assertion: "the-assertion", caseId: MINTED, plan: JSON.parse(JSON.stringify(PLAN)) } }]);
  for (const { call } of indexCalls) assert.equal(call.assertion, "the-assertion");
});

test("a reservation is given back only when the case says no log was started, and a refused reservation reaches no case", async () => {
  const refusedPlan = { ok: false, refusal: "malformed-plan", at: "fixture", logStarted: false };
  const notStarted = hostedWith(() => json(refusedPlan));
  assert.deepEqual(await notStarted.hosted.directory.create("a", PLAN), { ok: false, refusal: "malformed-plan", at: "fixture" });
  assert.deepEqual(order(notStarted.indexCalls), [`case-index:reserve:${MINTED}`, `case-index:release:${MINTED}`]);

  // Refused for its assertion, which a case does before it writes anything.
  const accessRefused = hostedWith(() => json({ ok: false, refusal: "access-refused" }));
  assert.deepEqual(await accessRefused.hosted.directory.create("a", PLAN), { ok: false, refusal: "access-refused" });
  assert.deepEqual(order(accessRefused.indexCalls), [`case-index:reserve:${MINTED}`, `case-index:release:${MINTED}`]);

  // A log was started, so the id stays reserved and the list shows it as not finished.
  const started = hostedWith(() => json({ ok: false, refusal: "conflict", at: null, logStarted: true }));
  assert.deepEqual(await started.hosted.directory.create("a", PLAN), { ok: false, refusal: "conflict", at: null });
  assert.deepEqual(order(started.indexCalls), [`case-index:reserve:${MINTED}`]);

  // No usable answer: what the case wrote is unknown, so the reservation stays.
  for (const [why, answer] of [
    ["the object threw", new Error("the object went away")],
    ["a status that is not 200", json({ ok: true, case: {} }, 500)],
    ["a body that is not JSON", new Response("<html>", { status: 200 })],
    ["an answer with no ok", json({ case: {} })],
    ["an answer that is no object", json("ok")]
  ] as const) {
    const unknown = hostedWith(() => (answer instanceof Error ? answer : answer.clone()));
    assert.deepEqual(await unknown.hosted.directory.create("a", PLAN), { ok: false, refusal: "unavailable" }, why);
    assert.deepEqual(order(unknown.indexCalls), [`case-index:reserve:${MINTED}`], why);
  }

  for (const refusal of ["index-full", "case-id-taken"]) {
    const full = hostedWith(() => json({ ok: true }), () => json({ ok: false, refusal, at: null }));
    assert.deepEqual(await full.hosted.directory.create("a", PLAN), { ok: false, refusal, at: null });
    assert.deepEqual(full.caseCalls, []);
  }
  const down = hostedWith(() => json({ ok: true }), () => new Error("the list went away"));
  assert.deepEqual(await down.hosted.directory.create("a", PLAN), { ok: false, refusal: "unavailable" });
  assert.deepEqual(down.caseCalls, []);
});

test("only an id of the minted shape reaches an object, each call to the object of its own name, and an object that does not answer reads as unavailable", async () => {
  const view = { caseId: MINTED, head: "a".repeat(64), seq: 0, state: null };
  const { hosted, caseCalls } = hostedWith(() => json({ ok: true, case: view }));
  const event = { type: "assertion-recorded", data: { id: "said-one", statement: "Said." } };
  assert.deepEqual(await hosted.service.open("a", MINTED), { ok: true, case: view });
  await hosted.service.evidence("a", MINTED, "b".repeat(64), 7);
  await hosted.service.claim("a", MINTED, "c".repeat(64), event);
  assert.deepEqual(caseCalls, [
    { name: MINTED, call: { call: "open", assertion: "a", caseId: MINTED } },
    { name: MINTED, call: { call: "evidence", assertion: "a", caseId: MINTED, digest: "b".repeat(64), offset: 7 } },
    { name: MINTED, call: { call: "claim", assertion: "a", caseId: MINTED, viewedHead: "c".repeat(64), event } }
  ]);
  // Every other id a path can carry: a slug, capitals, a digit short, a digit long.
  for (const caseId of ["case-one", MINTED.toUpperCase(), MINTED.slice(1), `${MINTED}0`, "case-index"]) {
    assert.deepEqual(await hosted.service.open("a", caseId), { ok: false, refusal: "head-missing", at: null }, caseId);
    assert.deepEqual(await hosted.service.claim("a", caseId, "c".repeat(64), event), { ok: false, refusal: "head-missing", at: null }, caseId);
    assert.deepEqual(await hosted.service.evidence("a", caseId, "b".repeat(64), 0), { ok: false, refusal: "head-missing", at: null }, caseId);
  }
  assert.equal(caseCalls.length, 3);
  const gone = hostedWith(() => new Error("the object went away"));
  assert.deepEqual(await gone.hosted.service.open("a", MINTED), { ok: false, refusal: "unavailable" });
  const list = hostedWith(() => json({ ok: true }), () => json({ ok: true, cases: [], limit: MAX_HOSTED_CASES }));
  assert.deepEqual(await list.hosted.directory.list("a"), { ok: true, cases: [], limit: MAX_HOSTED_CASES });
  assert.deepEqual(order(list.indexCalls), ["case-index:list:undefined"]);
});

test("an object with no configuration, no bucket, a name that is no minted id, or storage of another kind serves nothing", async () => {
  const signing = await generateSigningKey("key-1");
  const keySet = new AccessKeySet(ISSUER, certsFor(signing).fetcher, Date.now);
  const touched: string[] = [];
  const storage = { sql: { exec: (query: string) => (touched.push(query), { toArray: () => [], rowsWritten: 0 }) }, transactionSync: <T>(run: () => T): T => run() };
  const whole: HostEnv = { ...VIEWER_ENV, INVESTIGATION_OBJECTS: BUCKET };
  const ask = async (object: (request: Request) => Promise<Response>) => (await object(new Request("https://case-host.invalid/call", { method: "POST", body: JSON.stringify({ call: "open", assertion: "x", caseId: MINTED }) }))).json();
  const world = { keySetFor: () => keySet, now: Date.now };
  for (const [why, object] of [
    ["no configuration", caseObject({ ...world, name: MINTED, storage, env: { INVESTIGATION_OBJECTS: BUCKET } })],
    ["no bucket", caseObject({ ...world, name: MINTED, storage, env: VIEWER_ENV })],
    ["a slug for a name", caseObject({ ...world, name: "case-one", storage, env: whole })],
    ["no name", caseObject({ ...world, name: undefined, storage, env: whole })],
    ["storage with no SQL", caseObject({ ...world, name: MINTED, storage: { get: async () => undefined }, env: whole })],
    ["a list with no configuration", caseIndexObject({ ...world, name: "case-index", storage, env: {} })],
    ["a list under another name", caseIndexObject({ ...world, name: MINTED, storage, env: whole })],
    ["a list on storage with no SQL", caseIndexObject({ ...world, name: "case-index", storage: {}, env: whole })]
  ] as const) {
    assert.deepEqual(await ask(object), { ok: false, refusal: "unavailable" }, why);
  }
  assert.deepEqual(touched, [], "an object that serves nothing makes no table");
});

test("the bucket's store refuses an object past the bound from its recorded size, and never holds more than one byte past it", async () => {
  const digest = "d".repeat(64);
  const calls: string[] = [];
  const bucketHolding = (recorded: number, actual: number): HostBucket => ({
    head: async (key) => (calls.push(`head ${key}`), { size: recorded }),
    get: async (key, options) => {
      calls.push(`get ${key} ${options.range.offset}+${options.range.length}`);
      return { arrayBuffer: async () => new Uint8Array(Math.min(actual, options.range.length)).buffer };
    },
    put: async (key, _value, options) => (calls.push(`put ${key} ${JSON.stringify(options)}`), null)
  });
  assert.equal(await bucketObjectStore(bucketHolding(11, 11), "p/").read(digest, 10), "too-large");
  assert.deepEqual(calls.splice(0), [`head p/${digest}`]);
  const read = await bucketObjectStore(bucketHolding(10, 10), "p/").read(digest, 10);
  assert.ok(read instanceof Uint8Array && read.length === 10);
  assert.deepEqual(calls.splice(0), [`head p/${digest}`, `get p/${digest} 0+11`]);
  // Replaced by a longer object after its size was read: cut one byte past the bound, and refused.
  assert.equal(await bucketObjectStore(bucketHolding(10, 5000), "p/").read(digest, 10), "too-large");
  assert.equal(await bucketObjectStore(bucketHolding(10, 10), "p/").read("../escape", 10), null);
  calls.splice(0);
  // A write asks the bucket to store only where nothing is stored, and a null answer is an object already there.
  assert.equal(await bucketObjectStore(bucketHolding(0, 0), "p/").createOnly(digest, new Uint8Array(1)), "exists");
  assert.deepEqual(calls, [`put p/${digest} {"onlyIf":{"etagDoesNotMatch":"*"}}`]);
  await assert.rejects(bucketObjectStore(bucketHolding(0, 0), "p/").createOnly("../escape", new Uint8Array(1)));
});

test("a release asks the case first and the list only after the case says it holds no log", async () => {
  const yes = hostedWith(() => json({ ok: true }));
  assert.deepEqual(await yes.hosted.directory.release("a", MINTED), { ok: true });
  assert.deepEqual([order(yes.caseCalls), order(yes.indexCalls)], [[`${MINTED}:abandon:${MINTED}`], [`case-index:release:${MINTED}`]]);
  // A case that holds a log, refuses the assertion or does not answer: the list is never asked.
  for (const [why, answer, expected] of [
    ["a log exists", json({ ok: false, refusal: "log-exists", at: null }), { ok: false, refusal: "log-exists", at: null }],
    ["the assertion is refused", json({ ok: false, refusal: "access-refused" }), { ok: false, refusal: "access-refused" }],
    ["the object threw", new Error("the object went away"), { ok: false, refusal: "unavailable" }],
    ["a status that is not 200", json({ ok: true }, 500), { ok: false, refusal: "unavailable" }]
  ] as const) {
    const no = hostedWith(() => (answer instanceof Error ? answer : answer.clone()));
    assert.deepEqual(await no.hosted.directory.release("a", MINTED), expected, why);
    assert.deepEqual(no.indexCalls, [], why);
  }
  // The list's own answer is the release's: a created case stays, and a list that is down reads as that.
  const created = hostedWith(() => json({ ok: true }), () => json({ ok: false, refusal: "not-reserved", at: null }));
  assert.deepEqual(await created.hosted.directory.release("a", MINTED), { ok: false, refusal: "not-reserved", at: null });
  const down = hostedWith(() => json({ ok: true }), () => new Error("the list went away"));
  assert.deepEqual(await down.hosted.directory.release("a", MINTED), { ok: false, refusal: "unavailable" });
  // A slug names no object and no reservation.
  const slug = hostedWith(() => json({ ok: true }));
  assert.deepEqual(await slug.hosted.directory.release("a", "case-one"), { ok: false, refusal: "head-missing", at: null });
  assert.deepEqual([slug.caseCalls, slug.indexCalls], [[], []]);
});

test("a create whose assertion expires between the reserve and the create strands its reservation: the release carries the same assertion, and the list refuses it", async () => {
  // The list took the reserve, then refuses everything, as it does for an assertion that has since expired.
  let reserved = false;
  const stranded = hostedWith(
    () => json({ ok: false, refusal: "access-refused" }),
    (call) => (call.call === "reserve" && !reserved ? ((reserved = true), json({ ok: true })) : json({ ok: false, refusal: "access-refused" }))
  );
  assert.deepEqual(await stranded.hosted.directory.create("an-assertion-about-to-expire", PLAN), { ok: false, refusal: "access-refused" });
  // The release was tried, with the same assertion, and refused. Nothing else follows, so the id stays reserved.
  assert.deepEqual(stranded.indexCalls.map(({ call }) => [call.call, call.assertion]), [["reserve", "an-assertion-about-to-expire"], ["release", "an-assertion-about-to-expire"]]);
});

test("the release route sends the path's id to the directory, takes no field, and answers by the refusal's kind", async () => {
  const ok = directoryAnswering({ ok: true, caseId: MINTED });
  const world = await viewerWorld({ seeded: false, directory: ok.directory });
  const released = await world.post(`/cases/${MINTED}/release`, []);
  assert.deepEqual([released.status, released.headers.get("location")], [303, "/cases"]);
  assert.deepEqual(ok.releases, [MINTED]);
  assert.equal((await world.post(`/cases/${MINTED}/release`, [["force", "yes"]])).status, 400);
  assert.equal((await world.post(`/cases/${MINTED}/release`, [], { token: world.serviceToken })).status, 401);
  assert.equal((await world.post(`/cases/${MINTED}/release`, [], { origin: "https://elsewhere.example" })).status, 403);
  assert.equal((await world.send(`/cases/${MINTED}/release`)).status, 405);
  assert.deepEqual(ok.releases, [MINTED]);
  for (const [answer, status, shows] of [
    [{ ok: false, refusal: "log-exists", at: null }, 422, "<code>log-exists</code>. The list still holds it."],
    [{ ok: false, refusal: "access-refused" }, 401, '{"error":"access-refused"}'],
    [{ ok: false, refusal: "unavailable" }, 503, '{"error":"unavailable"}']
  ] as const) {
    const refusing = await viewerWorld({ seeded: false, directory: directoryAnswering({ ok: true, caseId: MINTED }, undefined, answer).directory });
    const response = await refusing.post(`/cases/${MINTED}/release`, []);
    assert.equal(response.status, status, answer.refusal);
    assert.ok((await response.text()).includes(shows), answer.refusal);
  }
  assert.equal((await (await viewerWorld({ seeded: false })).post(`/cases/${MINTED}/release`, [])).status, 503);
});
