import assert from "node:assert/strict";
import { test } from "node:test";
import { assertCaughtBy, holds, loadVariant } from "../../lib/finite-check";
import { AccessKeySet, verifyAccessToken, type VerifiedIdentity } from "../core/access-token";
import { EVENT_TYPES } from "../core/case-events";
import { appendCommand, createLog, putEvidence, readEvidence, type LogStores } from "../core/case-log";
import type * as caseServiceModule from "../core/case-service";
import { caseServiceOver, CLAIM_EVENT_TYPES, EVIDENCE_PAGE_BYTES, type CaseService } from "../core/case-service";
import { runCommand, type OpenCase } from "../core/case-store";
import { actorsFor, CASE_SCRIPT, continueScript, digestOfRaw, logEvent, risingClock, storeRawObjects } from "./case-fixture";
import { memoryStores, type MemoryStores } from "./memory-log-store";
import { certsFor, generateSigningKey, ISSUER, NOW_MS, NOW_SECONDS, ownerClaims, POLICY, serviceClaims, signToken, type SigningKey } from "./token-fixture";
import { ownerActorAt, SCRIPT_DIGEST, seededStores, VIEWER_CASE } from "./viewer-fixture";

/**
 * The seam a Durable Object will later sit behind, called directly with no gate in front of it.
 * It must verify the assertion itself, write claims and nothing else, refuse a head that moved,
 * and hand back only plain data.
 */

type Seam = Readonly<{ signing: SigningKey; stores: MemoryStores; service: CaseService; opened: () => number; owner: string }>;

async function seam(options: Readonly<{ module?: Pick<typeof caseServiceModule, "caseServiceOver">; stores?: MemoryStores; wrap?: (stores: MemoryStores) => LogStores; fetcher?: SigningKey | "down"; clock?: { now: number } }> = {}): Promise<Seam> {
  const signing = await generateSigningKey("key-1");
  const stores = options.stores ?? (await seededStores(signing, NOW_MS));
  let ticks = NOW_MS;
  const now = options.clock === undefined ? () => (ticks += 1) : () => (options.clock as { now: number }).now;
  const fetcher = options.fetcher === "down" ? async () => new Response("down", { status: 500 }) : certsFor(signing).fetcher;
  const keySet = new AccessKeySet(ISSUER, fetcher, now);
  let opened = 0;
  const service = (options.module ?? { caseServiceOver }).caseServiceOver({
    policy: POLICY,
    keySetFor: () => keySet,
    now,
    storesFor: (caseId) => {
      opened += 1;
      return caseId === VIEWER_CASE ? (options.wrap ? options.wrap(stores) : stores) : null;
    }
  });
  return { signing, stores, service, opened: () => opened, owner: await signToken(signing, ownerClaims()) };
}

test("the seam verifies the assertion itself: a forged, expired, foreign, service or malformed token reaches no case, called directly", async () => {
  const { service, stores, signing, owner, opened } = await seam();
  const forger = await generateSigningKey("key-1");
  const head = stores.head.value as string;
  const refused: Readonly<Record<string, unknown>> = {
    "a forged token": await signToken(forger, ownerClaims()),
    "an expired token": await signToken(signing, ownerClaims({ exp: NOW_SECONDS - 1 })),
    "another person": await signToken(signing, ownerClaims({ sub: "11111111-61da-459d-899c-0a01c76a2f94" })),
    "another email": await signToken(signing, ownerClaims({ email: "someone@workspace.example" })),
    "a service token": await signToken(signing, serviceClaims()),
    "an empty string": "",
    "a malformed token": "not.a.token",
    "no string at all": 42,
    null: null,
    // What an in-isolate caller could hand over in place of the token: neither is a token, and the seam verifies only a token.
    "a genuine owner actor": await ownerActorAt(signing, NOW_MS),
    "a genuine verified identity": await verifiedIdentity(signing)
  };
  for (const [name, assertion] of Object.entries(refused)) {
    const answers = [
      await service.open(assertion as string, VIEWER_CASE),
      await service.evidence(assertion as string, VIEWER_CASE, "ab".repeat(32), 0),
      await service.claim(assertion as string, VIEWER_CASE, head, logEvent("assertion-recorded", { id: "said-x", statement: "x" }))
    ];
    for (const answer of answers) assert.deepEqual(answer, { ok: false, refusal: "access-refused" }, name);
  }
  assert.equal(opened(), 0, "no refused assertion reached a case");
  assert.equal(stores.head.value, head);
  assert.equal((await service.open(owner, VIEWER_CASE)).ok, true);
  const down = await seam({ fetcher: "down" });
  assert.deepEqual(await down.service.open(down.owner, VIEWER_CASE), { ok: false, refusal: "unavailable" });
});

/** An owner identity as verifyAccessToken hands it back, so a member of its set in this isolate. */
async function verifiedIdentity(signing: SigningKey): Promise<VerifiedIdentity> {
  const keySet = new AccessKeySet(ISSUER, certsFor(signing).fetcher, () => NOW_MS);
  const decision = await verifyAccessToken(await signToken(signing, ownerClaims()), POLICY, keySet, () => NOW_MS);
  return decision.ok ? decision.identity : assert.fail("the fixture token was refused");
}

test("the seam verifies the assertion on every call, so a token that has expired reaches nothing it reached before", async () => {
  const clock = { now: NOW_MS };
  const { service, stores, owner } = await seam({ clock });
  assert.equal((await service.open(owner, VIEWER_CASE)).ok, true);
  // The fixture token expires an hour after NOW_MS.
  clock.now = NOW_MS + 2 * 3_600_000;
  const head = stores.head.value as string;
  assert.deepEqual(await service.open(owner, VIEWER_CASE), { ok: false, refusal: "access-refused" });
  assert.deepEqual(await service.evidence(owner, VIEWER_CASE, SCRIPT_DIGEST, 0), { ok: false, refusal: "access-refused" });
  assert.deepEqual(await service.claim(owner, VIEWER_CASE, head, logEvent("assertion-recorded", { id: "said-late", statement: "Written after expiry." })), { ok: false, refusal: "access-refused" });
  assert.equal(stores.head.value, head);
});

const CLAIMS_ONLY = "the seam writes claims and nothing else, and refuses any other event before it opens a case";

async function checkClaimsOnly(module: Pick<typeof caseServiceModule, "caseServiceOver">): Promise<void> {
  const { service, stores, owner, opened } = await seam({ module });
  const head = stores.head.value as string;
  const others = EVENT_TYPES.filter((type) => !CLAIM_EVENT_TYPES.includes(type));
  holds(CLAIMS_ONLY, others.length === EVENT_TYPES.length - 7, () => others);
  for (const type of others) {
    const answer = await service.claim(owner, VIEWER_CASE, head, logEvent(type, type === "plan-frozen" ? { planDigest: "ab".repeat(32) } : {}));
    holds(CLAIMS_ONLY, JSON.stringify(answer) === '{"ok":false,"refusal":"not-a-claim"}', () => ({ type, answer }));
  }
  for (const event of [null, "fact-recorded", [], { type: 5, data: {} }, { data: {} }]) {
    const answer = await service.claim(owner, VIEWER_CASE, head, event as never);
    holds(CLAIMS_ONLY, JSON.stringify(answer) === '{"ok":false,"refusal":"not-a-claim"}', () => ({ event, answer }));
  }
  holds(CLAIMS_ONLY, opened() === 0 && stores.head.value === head, () => ({ opened: opened() }));
}

test("the seam writes claims and nothing else: every other event type the log knows is refused before a case is opened", async () => {
  assert.deepEqual([...CLAIM_EVENT_TYPES].sort(), ["assertion-recorded", "assertion-retracted", "fact-recorded", "fact-retracted", "fact-superseded", "interpretation-reaffirmed", "interpretation-recorded"]);
  for (const type of CLAIM_EVENT_TYPES) assert.ok(EVENT_TYPES.includes(type), type);
  await checkClaimsOnly({ caseServiceOver });
  const variant = loadVariant<typeof caseServiceModule>(require.resolve("../core/case-service"), [{ find: "if (!isClaimEvent(event))", replace: "if (false)" }]);
  await assertCaughtBy("the claim check gone", CLAIMS_ONLY, () => checkClaimsOnly(variant));
});

const PLAIN = "what crosses the seam is plain data, and nothing it hands back can be written with";

function hasNoFunction(value: unknown): boolean {
  if (typeof value === "function") return false;
  if (typeof value !== "object" || value === null) return true;
  return Object.values(value).every(hasNoFunction);
}

test("what crosses the seam is plain data: every answer survives a structured copy, and the case it hands back is no folded case", async () => {
  const { service, stores, owner } = await seam();
  const opened = await service.open(owner, VIEWER_CASE);
  assert.ok(opened.ok);
  const claimed = await service.claim(owner, VIEWER_CASE, opened.case.head, logEvent("assertion-recorded", { id: "said-plain", statement: "Plain." }));
  assert.ok(claimed.ok);
  const stale = await service.claim(owner, VIEWER_CASE, opened.case.head, logEvent("assertion-recorded", { id: "said-stale", statement: "Stale." }));
  assert.equal(stale.ok ? null : stale.refusal, "conflict");
  const refused = await service.claim(owner, VIEWER_CASE, claimed.case.head, logEvent("assertion-recorded", { id: "said-plain", statement: "Again." }));
  assert.equal(refused.ok ? null : refused.refusal, "id-taken");
  const page = await service.evidence(owner, VIEWER_CASE, opened.case.state?.record.rows[0].digest as string, 0);
  for (const [name, answer] of Object.entries({ opened, claimed, stale, refused, page })) {
    holds(PLAIN, hasNoFunction(answer), () => name);
    assert.deepEqual(structuredClone(answer), answer, name);
  }
  // The case handed back is a copy, so the store's own registration stays on its side.
  const owned = await ownerActorAt((await seam()).signing, NOW_MS);
  const written = await runCommand(stores, claimed.case as OpenCase, { actor: owned, event: logEvent("assertion-recorded", { id: "said-through", statement: "Through." }), now: () => NOW_MS + 10 });
  assert.deepEqual(written, { ok: false, refusal: "not-a-folded-case", at: null });
});

test("a write that loses the race between the seam's open and its append is a conflict, with the case as it now stands", async () => {
  const signing = await generateSigningKey("key-1");
  const base = await seededStores(signing, NOW_MS);
  const rival = await ownerActorAt(signing, NOW_MS);
  let raced = false;
  const { service, owner } = await seam({
    stores: base,
    wrap: (stores) => ({
      entries: stores.entries,
      evidence: stores.evidence,
      head: {
        read: (maxChars) => stores.head.read(maxChars),
        compareAndSwap: async (expected, next) => {
          if (!raced && expected !== null) {
            raced = true;
            const landed = await appendCommand(stores, { caseId: VIEWER_CASE, actor: rival, events: [logEvent("assertion-recorded", { id: "said-first", statement: "Landed first." })], evidence: [], expectedHead: expected, now: () => NOW_MS + 5 });
            assert.ok(landed.ok);
          }
          return stores.head.compareAndSwap(expected, next);
        }
      }
    })
  });
  const opened = await service.open(owner, VIEWER_CASE);
  assert.ok(opened.ok);
  const answer = await service.claim(owner, VIEWER_CASE, opened.case.head, logEvent("assertion-recorded", { id: "said-second", statement: "Lost the race." }));
  assert.equal(answer.ok ? null : answer.refusal, "conflict");
  assert.ok(!answer.ok && "case" in answer && answer.case.state?.record.assertions.some(({ id }) => id === "said-first"));
  assert.ok(!answer.ok && "case" in answer && !answer.case.state?.record.assertions.some(({ id }) => id === "said-second"));
});

/** A case whose B1 rows name each of these objects, in order, with nothing else after B1 began. */
async function caseNaming(signing: SigningKey, objects: readonly Uint8Array[]): Promise<Readonly<{ stores: MemoryStores; digests: readonly string[] }>> {
  const stores = memoryStores();
  assert.ok((await createLog(stores)).ok);
  await storeRawObjects(stores);
  const digests: string[] = [];
  for (const bytes of objects) {
    const put = await putEvidence(stores, bytes);
    digests.push(put.ok ? put.digest : assert.fail("an object was refused"));
  }
  const row = (index: number, digest: string) => ({ as: "B1" as const, event: logEvent("evidence-recorded", { row: { id: `row-object-${index}`, slot: "B1", instrument: "inspect", state: "present", window: { clock: "harness", startMs: 1, endMs: 2 }, limits: [], digest, observation: null } }) });
  const start = CASE_SCRIPT.findIndex(({ event }) => event.type === "capture-began");
  const owner = await ownerActorAt(signing, NOW_MS);
  await continueScript({ stores, caseId: VIEWER_CASE, actorOf: actorsFor(owner), now: risingClock(NOW_MS - 3_600_000), commands: [...CASE_SCRIPT.slice(0, start + 1), ...digests.map((digest, index) => row(index, digest))] });
  return { stores, digests };
}

const encoded = (text: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(text);

test("an evidence page ends before a character it would cut, shows a cut character's bytes as bytes, and links back to where the page before began", async () => {
  const signing = await generateSigningKey("key-1");
  const PAGE = EVIDENCE_PAGE_BYTES;
  const objects = [
    // A two-byte letter straddling the first page's end.
    encoded(`${"a".repeat(PAGE - 1)}\u{E9}z`),
    // A four-byte character cut after its first, second and third byte.
    encoded(`${"a".repeat(PAGE - 1)}\u{1F600}z`),
    encoded(`${"a".repeat(PAGE - 2)}\u{1F600}z`),
    encoded(`${"a".repeat(PAGE - 3)}\u{1F600}z`),
    // Valid UTF-8 of three-byte characters over several pages.
    encoded(`x${"\u{20AC}".repeat(40_000)}`),
    // Not UTF-8, and cut short at its end.
    new Uint8Array([0x41, 0xff, 0xfe, 0x42]),
    new Uint8Array([0x61, 0xe2, 0x82]),
    // Bad only past the first page's end; a four-byte character to start inside; cut after three of its bytes; two bytes that lead nothing; stray bytes first.
    new Uint8Array([...encoded("a".repeat(40_000)), 0xff]),
    encoded("\u{1F600}z"),
    new Uint8Array([0x61, 0xf0, 0x9f, 0x98]),
    new Uint8Array([0x61, 0xc0]),
    new Uint8Array([0x61, 0xc1]),
    new Uint8Array([0x9f, 0x98, 0x61]),
    // A lead of four bytes before one continuation byte and a letter; a letter before a stray byte; two letters.
    new Uint8Array([0xf0, 0x9f, 0x61]),
    new Uint8Array([0x61, 0x80, 0x62]),
    encoded("ab")
  ];
  const { stores, digests } = await caseNaming(signing, objects);
  const { service, owner: token } = await seam({ stores });
  const page = async (index: number, offset: number) => {
    const answer = await service.evidence(token, VIEWER_CASE, digests[index], offset);
    return answer.ok ? answer.page : assert.fail(`refused: ${answer.refusal}`);
  };
  const one = await page(0, 0);
  assert.deepEqual([one.end, one.total, one.validUtf8, one.leadingBytes, one.trailingBytes, one.text.length, one.previous], [PAGE - 1, PAGE + 2, true, [], [], PAGE - 1, null]);
  const two = await page(0, one.end);
  assert.deepEqual([two.text, two.leadingBytes, two.previous], ["\u{E9}z", [], 0]);
  // Asked to start inside the letter: its last byte shows as a byte, and the whole object is still
  // UTF-8. No page starts here, so the page before is the one that holds this offset.
  const inside = await page(0, PAGE);
  assert.deepEqual([inside.leadingBytes, inside.text, inside.validUtf8, inside.previous], [[0xa9], "z", true, PAGE - 1]);
  for (const [index, cut] of [[1, 1], [2, 2], [3, 3]] as const) {
    const first = await page(index, 0);
    assert.equal(first.end, PAGE - cut, `a four-byte character cut after ${cut}`);
    assert.deepEqual([first.trailingBytes, first.text.endsWith("a")], [[], true]);
    const second = await page(index, first.end);
    assert.deepEqual([second.leadingBytes, second.text, second.previous], [[], "\u{1F600}z", 0]);
  }
  // Following each page's own links forward and then back lands on exactly the pages it left.
  const starts: number[] = [0];
  for (let at = await page(4, 0); at.end < at.total; at = await page(4, at.end)) starts.push(at.end);
  assert.ok(starts.length >= 4);
  for (let index = starts.length - 1; index > 0; index -= 1) {
    const at = await page(4, starts[index]);
    assert.deepEqual([at.previous, at.leadingBytes, at.validUtf8], [starts[index - 1], [], true], `page ${index}`);
  }
  const bad = await page(5, 0);
  assert.deepEqual([bad.validUtf8, bad.text], [false, "A\u{FFFD}\u{FFFD}B"]);
  const cutShort = await page(6, 0);
  assert.deepEqual([cutShort.validUtf8, cutShort.text, cutShort.trailingBytes], [false, "a", [0xe2, 0x82]]);
  // Whether the object is UTF-8 is said of all of it, not of the page shown.
  const badLater = await page(7, 0);
  assert.deepEqual([badLater.end, badLater.validUtf8, badLater.leadingBytes, badLater.trailingBytes], [PAGE, false, [], []]);
  // A page at the first continuation byte of a four-byte character: all three show as bytes, and they end the character the page before begins.
  const insideFour = await page(8, 1);
  assert.deepEqual([insideFour.leadingBytes, insideFour.leadingEndsCharacter, insideFour.text, insideFour.previous], [[0x9f, 0x98, 0x80], true, "z", 0]);
  const cutFour = await page(9, 0);
  assert.deepEqual([cutFour.trailingBytes, cutFour.text, cutFour.validUtf8], [[0xf0, 0x9f, 0x98], "a", false]);
  // 0xC0 and 0xC1 lead no character, so they are bad bytes in the text, not a character cut short.
  for (const index of [10, 11]) {
    const lone = await page(index, 0);
    assert.deepEqual([lone.trailingBytes, lone.text, lone.validUtf8], [[], "a\u{FFFD}", false], `0x${index === 10 ? "C0" : "C1"}`);
  }
  // Stray continuation bytes on the first page end no character.
  const stray = await page(12, 0);
  assert.deepEqual([stray.leadingBytes, stray.leadingEndsCharacter, stray.text, stray.previous], [[0x9f, 0x98], false, "a", null]);
  assert.deepEqual([one.leadingEndsCharacter, inside.leadingEndsCharacter], [false, true]);
  // Inside the four-byte character after its third byte: the lead is three bytes back, and one byte ends it.
  const lastOfFour = await page(8, 3);
  assert.deepEqual([lastOfFour.leadingBytes, lastOfFour.leadingEndsCharacter, lastOfFour.text], [[0x80], true, "z"]);
  // A lead that needs four bytes, with one after it, ends nothing; nor does a letter before a continuation byte.
  const shortOfFour = await page(13, 1);
  assert.deepEqual([shortOfFour.leadingBytes, shortOfFour.leadingEndsCharacter, shortOfFour.text], [[0x9f], false, "a"]);
  const afterLetter = await page(14, 1);
  assert.deepEqual([afterLetter.leadingBytes, afterLetter.leadingEndsCharacter, afterLetter.text], [[0x80], false, "b"]);
  // A page that starts on a character's first byte has no leading bytes, and ends nothing.
  const between = await page(15, 1);
  assert.deepEqual([between.leadingBytes, between.leadingEndsCharacter, between.text, between.previous], [[], false, "b", 0]);
  assert.deepEqual(await service.evidence(token, VIEWER_CASE, digests[0], PAGE + 2), { ok: false, refusal: "offset-past-end" });
  assert.deepEqual(await service.evidence(token, VIEWER_CASE, digests[0], -1), { ok: false, refusal: "offset-past-end" });
  assert.deepEqual(await service.evidence(token, VIEWER_CASE, digests[0], 0.5), { ok: false, refusal: "offset-past-end" });
  // An object this case's log does not name is not read through it, wherever it is stored.
  const loose = await putEvidence(stores, encoded("named by nothing"));
  assert.deepEqual(await service.evidence(token, VIEWER_CASE, loose.ok ? loose.digest : "", 0), { ok: false, refusal: "not-named-by-this-case" });
  assert.deepEqual(await service.open(token, "case-nobody"), { ok: false, refusal: "head-missing", at: null });
});

test("the evidence shown is the bytes the case's open hashed, read once, whatever the store answers next", async () => {
  const signing = await generateSigningKey("seed");
  const stores = await seededStores(signing, NOW_MS);
  const digest = digestOfRaw("raw-b1-network");
  let reads = 0;
  const toggling: LogStores = {
    entries: stores.entries,
    head: stores.head,
    evidence: {
      createOnly: (address, bytes) => stores.evidence.createOnly(address, bytes),
      read: async (address, maxBytes) => {
        if (address !== digest) return stores.evidence.read(address, maxBytes);
        reads += 1;
        // Every answer after the first is other bytes, which no hash would match.
        return reads === 1 ? stores.evidence.read(address, maxBytes) : encoded("CANARY-SECOND-ANSWER");
      }
    }
  };
  const { service, owner } = await seam({ stores, wrap: () => toggling });
  const answer = await service.evidence(owner, VIEWER_CASE, digest, 0);
  assert.ok(answer.ok, JSON.stringify(answer));
  assert.equal(answer.page.text, new TextDecoder().decode(stores.evidence.objects.get(digest)));
  assert.equal(reads, 1, "the object was read once");
});

test("readEvidence asks no store for an address that is not a digest, and reads it as missing", async () => {
  const stores = memoryStores();
  // A store that would answer that address, were it asked.
  stores.evidence.objects.set("../outside", encoded("CANARY-OUTSIDE"));
  let asked = 0;
  const watched: LogStores = { ...stores, evidence: { createOnly: (address, bytes) => stores.evidence.createOnly(address, bytes), read: (address, maxBytes) => ((asked += 1), stores.evidence.read(address, maxBytes)) } };
  for (const address of ["../outside", "AB".repeat(32), "ab".repeat(31), ""]) assert.deepEqual(await readEvidence(watched, address), { ok: false, refusal: "evidence-missing", at: null }, address);
  assert.equal(asked, 0);
});

test("an object only a control named, which no owner kept, is readable as the case names it", async () => {
  const signing = await generateSigningKey("key-1");
  const stores = memoryStores();
  assert.ok((await createLog(stores)).ok);
  await storeRawObjects(stores);
  const put = await putEvidence(stores, encoded("a fixture another configuration names"));
  assert.ok(put.ok);
  const original = CASE_SCRIPT[2];
  const configuration = { ...(original.event.data.configuration as Record<string, unknown>), commit: "c3".repeat(20), fixtureDigest: put.digest };
  const stray = { as: "control" as const, event: logEvent("control-recorded", { configuration: configuration as never, result: "not_met" }) };
  const owner = await ownerActorAt(signing, NOW_MS);
  await continueScript({ stores, caseId: VIEWER_CASE, actorOf: actorsFor(owner), now: risingClock(NOW_MS - 3_600_000), commands: [...CASE_SCRIPT.slice(0, 2), stray, ...CASE_SCRIPT.slice(3, 6)] });
  const { service, owner: token } = await seam({ stores });
  const opened = await service.open(token, VIEWER_CASE);
  assert.ok(opened.ok && opened.case.state !== null);
  assert.ok(opened.case.state.controlObjects.includes(put.digest) && !opened.case.state.keptObjects.includes(put.digest), "only the control names it");
  const answer = await service.evidence(token, VIEWER_CASE, put.digest, 0);
  assert.ok(answer.ok, JSON.stringify(answer));
  assert.equal(answer.page.text, "a fixture another configuration names");
});
