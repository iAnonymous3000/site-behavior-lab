import assert from "node:assert/strict";
import { before, test } from "node:test";
import { runInNewContext } from "node:vm";
import { assertCaughtBy, holds, loadVariant, type SourceEdit } from "../../lib/finite-check";
import { runnerActorFrom, type Actor, type OwnerActor } from "../core/actor";
import * as productionLog from "../core/case-log";
import {
  appendCommand,
  createLog,
  GENESIS_HEAD,
  MAX_ENTRY_BYTES,
  MAX_EVIDENCE_BYTES,
  openLog,
  putEvidence,
  verifyAgainstSavedHead,
  type AppendCommand,
  type LogEvent,
  type LogStores,
  type OpenRefusal
} from "../core/case-log";
import {
  ANOTHER_DIGEST,
  ATTEMPT_ONE,
  CASE_A,
  CASE_B,
  decode,
  encode,
  eventsTextOf,
  EXP,
  FILESYSTEM_BACKEND,
  GENESIS,
  handEntryText,
  MEMORY_BACKEND,
  OWNER_ACTOR_TEXT,
  runnerActorText,
  sha256OfBytes,
  sha256OfText,
  verifiedOwnerActor,
  type Backend,
  type Tamper
} from "./log-fixture";
import { MemoryHead, memoryStores, type MemoryStores } from "./memory-log-store";
import { NOW_MS } from "./token-fixture";

/**
 * The case log's rules, on the in-memory store and the filesystem store alike. The
 * expected bytes and digests are written out here or built by hand in log-fixture.ts,
 * and were worked out with shasum, so no oracle reads this module's own output. Each
 * guard is removed by a named variant and caught under a named property, and a behavior
 * test beside it fails for the same reason, so a find string that stops landing is not
 * the only thing standing in the way.
 */

type LogModule = typeof productionLog;

const logVariant = (...edits: SourceEdit[]) => loadVariant<LogModule>(require.resolve("../core/case-log"), edits);

let owner: OwnerActor;
const runner = runnerActorFrom(ATTEMPT_ONE) as Actor;
const clock = (at = NOW_MS) => () => at;
const event = (type: string, data: Record<string, unknown> = {}): LogEvent => ({ type, data }) as LogEvent;
/** After everything the seeded logs below hold, so a command at this time goes forward. */
const LATER = NOW_MS + 9000;

before(async () => {
  owner = await verifiedOwnerActor();
});

// Spelled out and hashed with shasum, not by this code:
//   printf '%s' "$ENTRY" | shasum -a 256
const FIRST_EVIDENCE_DIGEST = "ec0a5578e135b08703e07aec1bd239a35426697ba0d8c1b4fb451f09a4f6e10a";
const SECOND_EVIDENCE_DIGEST = "98077b9e02a461109a9382626d10d4a40d470b268d9a8f3107a13ba79f015ddd";
const FIRST_ENTRY =
  '{"actor":{"email":"owner@example.org","exp":1793538000,"iat":1793534340,"iss":"https://sbl-test.cloudflareaccess.com","kind":"owner","sub":"7335d417-61da-459d-899c-0a01c76a2f94"},"atMs":1793534400000,"case":"case-a","events":[{"data":{"site":"example.org"},"type":"case-opened"}],"evidence":[],"prev":"0000000000000000000000000000000000000000000000000000000000000000","seq":1,"v":1}';
const FIRST_DIGEST = "ff30e17e164b67d74d2d9941e8217e52238daf656badf1467c4874ed3470e8e3";
const FIRST_DIGEST_IN_ANOTHER_CASE = "e47e81c90e5aeb7be4f1d9d5023909ec25bf3c2c9a7e5906c7c00aa98434b291";
const SECOND_ENTRY =
  '{"actor":{"attemptId":"a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1","kind":"system:runner"},"atMs":1793534401000,"case":"case-a","events":[{"data":{"count":2,"nested":{"a":[1,"é"],"z":null}},"type":"capture-recorded"}],"evidence":["ec0a5578e135b08703e07aec1bd239a35426697ba0d8c1b4fb451f09a4f6e10a","98077b9e02a461109a9382626d10d4a40d470b268d9a8f3107a13ba79f015ddd"],"prev":"ff30e17e164b67d74d2d9941e8217e52238daf656badf1467c4874ed3470e8e3","seq":2,"v":1}';
const SECOND_DIGEST = "ea52ec860c494296c04b5d698981bfc727447e2c96521926c7d075eafc8c57fc";

const appendTo = (module: LogModule, stores: LogStores, actor: Actor, type: string, atMs: number, expectedHead: string, evidence: readonly string[] = [], caseId = CASE_A) =>
  module.appendCommand(stores, { caseId, actor, events: [event(type)], evidence, expectedHead, now: clock(atMs) });

async function mustAppend(stores: LogStores, actor: Actor, type: string, atMs: number, evidence: readonly string[] = [], module: LogModule = productionLog, caseId = CASE_A): Promise<string> {
  const opened = await module.openLog(stores, caseId);
  if (!opened.ok) throw new Error(`The log would not open: ${opened.refusal}`);
  const result = await appendTo(module, stores, actor, type, atMs, opened.log.head, evidence, caseId);
  if (!result.ok) throw new Error(`The append was refused: ${result.refusal}`);
  return result.digest;
}

async function mustPutEvidence(stores: LogStores, text: string): Promise<string> {
  const result = await putEvidence(stores, encode(text));
  if (!result.ok) throw new Error(`The evidence was refused: ${result.refusal}`);
  return result.digest;
}

type Seeded = Readonly<{ digests: readonly [string, string, string]; evidence: readonly [string, string, string, string] }>;

/** Three entries, the later two naming two evidence objects each, which every tamper starts from. */
async function seed(stores: LogStores, module: LogModule = productionLog): Promise<Seeded> {
  await module.createLog(stores);
  const evidence = [
    await mustPutEvidence(stores, "first evidence"),
    await mustPutEvidence(stores, "second evidence"),
    await mustPutEvidence(stores, "third evidence"),
    await mustPutEvidence(stores, "fourth evidence")
  ] as const;
  const first = await mustAppend(stores, owner, "case-opened", NOW_MS, [], module);
  const second = await mustAppend(stores, runner, "capture-recorded", NOW_MS + 1000, evidence.slice(0, 2), module);
  const third = await mustAppend(stores, owner, "fact-recorded", NOW_MS + 2000, evidence.slice(2), module);
  return { digests: [first, second, third], evidence };
}

test("known commands give exactly the known bytes and digests, and open back to them", async () => {
  const stores = memoryStores();
  assert.deepEqual(await createLog(stores), { ok: true });
  assert.equal(stores.head.value, GENESIS);
  assert.equal(GENESIS_HEAD, GENESIS);

  const firstEvidence = await putEvidence(stores, encode("first evidence"));
  const secondEvidence = await putEvidence(stores, encode("second evidence"));
  assert.deepEqual(firstEvidence, { ok: true, digest: FIRST_EVIDENCE_DIGEST });
  assert.deepEqual(secondEvidence, { ok: true, digest: SECOND_EVIDENCE_DIGEST });

  const first = await appendCommand(stores, {
    caseId: CASE_A,
    actor: owner,
    events: [event("case-opened", { site: "example.org" })],
    evidence: [],
    expectedHead: GENESIS,
    now: clock(NOW_MS)
  });
  assert.equal(first.ok && first.digest, FIRST_DIGEST);
  assert.equal(decode(stores.entries.objects.get(FIRST_DIGEST) as Uint8Array), FIRST_ENTRY);
  assert.equal(stores.head.value, FIRST_DIGEST);

  const second = await appendCommand(stores, {
    caseId: CASE_A,
    actor: runner,
    // Keys given unsorted, at both levels, on purpose.
    events: [event("capture-recorded", { nested: { z: null, a: [1, "é"] }, count: 2 })],
    evidence: [FIRST_EVIDENCE_DIGEST, SECOND_EVIDENCE_DIGEST],
    expectedHead: FIRST_DIGEST,
    now: clock(NOW_MS + 1000)
  });
  assert.equal(second.ok && second.digest, SECOND_DIGEST);
  assert.equal(decode(stores.entries.objects.get(SECOND_DIGEST) as Uint8Array), SECOND_ENTRY);
  assert.equal(stores.head.value, SECOND_DIGEST);

  const opened = await openLog(stores, CASE_A);
  assert.deepEqual(opened, {
    ok: true,
    log: {
      head: SECOND_DIGEST,
      entries: [
        { digest: FIRST_DIGEST, entry: JSON.parse(FIRST_ENTRY) },
        { digest: SECOND_DIGEST, entry: JSON.parse(SECOND_ENTRY) }
      ]
    }
  });
  // What was returned for a command is what reopening reads.
  assert.deepEqual(first.ok && first.entry, JSON.parse(FIRST_ENTRY));
});

test("the written-out digests are what an independent hash and the hand-built form give", () => {
  assert.equal(sha256OfText(FIRST_ENTRY), FIRST_DIGEST);
  assert.equal(sha256OfText(SECOND_ENTRY), SECOND_DIGEST);
  assert.equal(
    handEntryText({ actorText: OWNER_ACTOR_TEXT, atMs: NOW_MS, eventsText: '[{"data":{"site":"example.org"},"type":"case-opened"}]', prev: GENESIS, seq: 1 }),
    FIRST_ENTRY
  );
  assert.equal(sha256OfText("first evidence"), FIRST_EVIDENCE_DIGEST);
});

test("the same first command in two cases is two entries, because the case is in the bytes", async () => {
  const check = async (module: LogModule) => {
    const stores = memoryStores();
    await module.createLog(stores);
    const result = await module.appendCommand(stores, {
      caseId: CASE_B,
      actor: owner,
      events: [event("case-opened", { site: "example.org" })],
      evidence: [],
      expectedHead: GENESIS,
      now: clock(NOW_MS)
    });
    holds("an entry's digest depends on its case", result.ok && result.digest === FIRST_DIGEST_IN_ANOTHER_CASE, () => result);
  };
  await check(productionLog);
  await assertCaughtBy("a fixed case in the bytes", "an entry's digest depends on its case", () =>
    check(logVariant({ find: "case: caseId, seq: entries.length + 1", replace: 'case: "case-a", seq: entries.length + 1' }))
  );
});

test("an empty log opens empty, and an entry can name an empty evidence object", async () => {
  const stores = memoryStores();
  await createLog(stores);
  assert.deepEqual(await openLog(stores, CASE_A), { ok: true, log: { head: GENESIS, entries: [] } });
  const empty = await putEvidence(stores, new Uint8Array(0));
  assert.deepEqual(empty, { ok: true, digest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" });
  await mustAppend(stores, runner, "capture-recorded", NOW_MS, [(empty as { digest: string }).digest]);
  assert.equal((await openLog(stores, CASE_A)).ok, true);
});

// Refusals on open. Each attack states what it changes and the one refusal it must get.

type Attack = Readonly<{
  name: string;
  refusal: OpenRefusal;
  /** Where the refusal must point, by a function of the seeded log. */
  at: (seeded: Seeded) => string | null;
  apply: (tamper: Tamper, seeded: Seeded, stores: LogStores) => void | Promise<void>;
  /** A chain problem stops an append too. An evidence problem only stops an open. */
  chain: boolean;
}>;

const editedBytes = (digest: string): Uint8Array => encode(`{"edited":"${digest}"}`);
const nowhere = () => null;
const readBack = async (stores: LogStores, digest: string): Promise<Uint8Array> => (await stores.entries.read(digest, MAX_ENTRY_BYTES)) as Uint8Array;

/** An entry of another case, as written, sitting in the store the two cases share. */
const ANOTHER_CASE_ENTRY = handEntryText({ actorText: runnerActorText(ATTEMPT_ONE), atMs: NOW_MS, caseId: CASE_B, eventsText: eventsTextOf("from-another-case"), prev: GENESIS, seq: 1 });
const ANOTHER_CASE_DIGEST = sha256OfText(ANOTHER_CASE_ENTRY);

const ATTACKS: readonly Attack[] = [
  { name: "the head removed", refusal: "head-missing", chain: true, at: nowhere, apply: (tamper) => tamper.removeHead() },
  { name: "a head of no digest", refusal: "head-malformed", chain: true, at: nowhere, apply: (tamper) => tamper.setHead("not a digest") },
  { name: "a head of no digest, ending in one", refusal: "head-malformed", chain: true, at: nowhere, apply: (tamper, { digests }) => tamper.setHead(`x${digests[2]}`) },
  { name: "an empty head", refusal: "head-malformed", chain: true, at: nowhere, apply: (tamper) => tamper.setHead("") },
  { name: "a torn head", refusal: "head-malformed", chain: true, at: nowhere, apply: (tamper, { digests }) => tamper.setHead(digests[2].slice(0, 32)) },
  { name: "a head with a trailing newline", refusal: "head-malformed", chain: true, at: nowhere, apply: (tamper, { digests }) => tamper.setHead(`${digests[2]}\n`) },
  { name: "a head in uppercase", refusal: "head-malformed", chain: true, at: nowhere, apply: (tamper, { digests }) => tamper.setHead(digests[2].toUpperCase()) },
  { name: "the head at an object that was never written", refusal: "entry-missing", chain: true, at: () => ANOTHER_DIGEST, apply: (tamper) => tamper.setHead(ANOTHER_DIGEST) },
  { name: "the head at an evidence object, which is not an entry", refusal: "entry-missing", chain: true, at: ({ evidence }) => evidence[0], apply: (tamper, { evidence }) => tamper.setHead(evidence[0]) },
  {
    name: "the head at another case's entry, in a store the cases share",
    refusal: "wrong-case",
    chain: true,
    at: () => ANOTHER_CASE_DIGEST,
    apply: (tamper) => {
      tamper.setEntry(ANOTHER_CASE_DIGEST, encode(ANOTHER_CASE_ENTRY));
      tamper.setHead(ANOTHER_CASE_DIGEST);
    }
  },
  {
    name: "an entry of this case chained onto another case's",
    refusal: "wrong-case",
    chain: true,
    at: () => ANOTHER_CASE_DIGEST,
    apply: (tamper) => {
      tamper.setEntry(ANOTHER_CASE_DIGEST, encode(ANOTHER_CASE_ENTRY));
      const spliced = handEntryText({ actorText: runnerActorText(ATTEMPT_ONE), atMs: NOW_MS + 5000, eventsText: eventsTextOf("spliced"), prev: ANOTHER_CASE_DIGEST, seq: 2 });
      tamper.setEntry(sha256OfText(spliced), encode(spliced));
      tamper.setHead(sha256OfText(spliced));
    }
  },
  { name: "the newest entry removed", refusal: "entry-missing", chain: true, at: ({ digests }) => digests[2], apply: (tamper, { digests }) => tamper.removeEntry(digests[2]) },
  { name: "the middle entry removed", refusal: "entry-missing", chain: true, at: ({ digests }) => digests[1], apply: (tamper, { digests }) => tamper.removeEntry(digests[1]) },
  { name: "the oldest entry removed", refusal: "entry-missing", chain: true, at: ({ digests }) => digests[0], apply: (tamper, { digests }) => tamper.removeEntry(digests[0]) },
  { name: "the newest entry edited", refusal: "entry-edited", chain: true, at: ({ digests }) => digests[2], apply: (tamper, { digests }) => tamper.setEntry(digests[2], editedBytes(digests[2])) },
  { name: "the middle entry edited", refusal: "entry-edited", chain: true, at: ({ digests }) => digests[1], apply: (tamper, { digests }) => tamper.setEntry(digests[1], editedBytes(digests[1])) },
  { name: "the oldest entry edited", refusal: "entry-edited", chain: true, at: ({ digests }) => digests[0], apply: (tamper, { digests }) => tamper.setEntry(digests[0], editedBytes(digests[0])) },
  {
    name: "the newest entry cut in half, a torn tail",
    refusal: "entry-edited",
    chain: true,
    at: ({ digests }) => digests[2],
    apply: async (tamper, { digests }, stores) => {
      const bytes = await readBack(stores, digests[2]);
      tamper.setEntry(digests[2], bytes.subarray(0, Math.floor(bytes.length / 2)));
    }
  },
  {
    name: "the middle entry re-attributed in place, still well formed",
    refusal: "entry-edited",
    chain: true,
    at: ({ digests }) => digests[1],
    apply: async (tamper, { digests }, stores) => {
      const text = decode(await readBack(stores, digests[1]));
      assert.ok(text.includes(ATTEMPT_ONE));
      tamper.setEntry(digests[1], encode(text.replace(ATTEMPT_ONE, "d4".repeat(16))));
    }
  },
  {
    name: "the newest entry's time moved in place, still well formed",
    refusal: "entry-edited",
    chain: true,
    at: ({ digests }) => digests[2],
    apply: async (tamper, { digests }, stores) => {
      const text = decode(await readBack(stores, digests[2]));
      tamper.setEntry(digests[2], encode(text.replace(/"atMs":\d+/, `"atMs":${NOW_MS + 2001}`)));
    }
  },
  { name: "an entry past the size bound at its address", refusal: "entry-too-large", chain: true, at: ({ digests }) => digests[1], apply: (tamper, { digests }) => tamper.setEntry(digests[1], new Uint8Array(MAX_ENTRY_BYTES + 1)) },
  { name: "the first object of the newest entry changed", refusal: "evidence-changed", chain: false, at: ({ evidence }) => evidence[2], apply: (tamper, { evidence }) => tamper.setEvidence(evidence[2], encode("third evidence ")) },
  { name: "the second object of the newest entry changed", refusal: "evidence-changed", chain: false, at: ({ evidence }) => evidence[3], apply: (tamper, { evidence }) => tamper.setEvidence(evidence[3], encode("fourth evidence ")) },
  { name: "the first object of the older entry changed", refusal: "evidence-changed", chain: false, at: ({ evidence }) => evidence[0], apply: (tamper, { evidence }) => tamper.setEvidence(evidence[0], encode("")) },
  { name: "the second object of the older entry changed", refusal: "evidence-changed", chain: false, at: ({ evidence }) => evidence[1], apply: (tamper, { evidence }) => tamper.setEvidence(evidence[1], encode("")) },
  { name: "the first object of the newest entry removed", refusal: "evidence-missing", chain: false, at: ({ evidence }) => evidence[2], apply: (tamper, { evidence }) => tamper.removeEvidence(evidence[2]) },
  { name: "the second object of the newest entry removed", refusal: "evidence-missing", chain: false, at: ({ evidence }) => evidence[3], apply: (tamper, { evidence }) => tamper.removeEvidence(evidence[3]) },
  { name: "the first object of the older entry removed", refusal: "evidence-missing", chain: false, at: ({ evidence }) => evidence[0], apply: (tamper, { evidence }) => tamper.removeEvidence(evidence[0]) },
  { name: "the second object of the older entry removed", refusal: "evidence-missing", chain: false, at: ({ evidence }) => evidence[1], apply: (tamper, { evidence }) => tamper.removeEvidence(evidence[1]) },
  { name: "an evidence object past the size bound at its address", refusal: "evidence-too-large", chain: false, at: ({ evidence }) => evidence[1], apply: (tamper, { evidence }) => tamper.setEvidence(evidence[1], new Uint8Array(MAX_EVIDENCE_BYTES + 1)) }
];

for (const backend of [MEMORY_BACKEND, FILESYSTEM_BACKEND]) {
  for (const attack of ATTACKS) {
    test(`${backend.name}: ${attack.name} is refused as ${attack.refusal}`, async () => {
      const { stores, tamper, dispose } = backend.fresh();
      try {
        const seeded = await seed(stores);
        assert.equal((await openLog(stores, CASE_A)).ok, true, "the log was sound before the attack");
        await attack.apply(tamper, seeded, stores);
        assert.deepEqual(await openLog(stores, CASE_A), { ok: false, refusal: attack.refusal, at: attack.at(seeded) });
        const before = await stores.head.read(64);
        const result = await appendTo(productionLog, stores, runner, "after", LATER, seeded.digests[2]);
        assert.equal(result.ok, !attack.chain, "a broken chain takes no command; bad evidence does not stop one, and stays refused on open");
        if (attack.chain) {
          assert.deepEqual(result, { ok: false, refusal: attack.refusal, at: attack.at(seeded) });
          assert.equal(await stores.head.read(64), before);
        } else {
          assert.equal((await openLog(stores, CASE_A)).ok, false);
        }
      } finally {
        dispose();
      }
    });
  }

  test(`${backend.name}: swapping any two entries' bytes is refused, in every pair`, async () => {
    for (const [left, right] of [[0, 1], [0, 2], [1, 2]] as const) {
      const { stores, tamper, dispose } = backend.fresh();
      try {
        const { digests } = await seed(stores);
        const leftBytes = await readBack(stores, digests[left]);
        const rightBytes = await readBack(stores, digests[right]);
        tamper.setEntry(digests[left], rightBytes);
        tamper.setEntry(digests[right], leftBytes);
        const opened = await openLog(stores, CASE_A);
        assert.equal(opened.ok ? "opened" : opened.refusal, "entry-edited", `${left},${right}`);
      } finally {
        dispose();
      }
    }
  });

  test(`${backend.name}: restoring what was changed opens clean again, so the refusals came from the change`, async () => {
    const { stores, tamper, dispose } = backend.fresh();
    try {
      const { digests, evidence } = await seed(stores);
      const entryBytes = await readBack(stores, digests[1]);
      tamper.setEntry(digests[1], editedBytes(digests[1]));
      assert.equal((await openLog(stores, CASE_A)).ok, false);
      tamper.setEntry(digests[1], entryBytes);
      assert.equal((await openLog(stores, CASE_A)).ok, true);
      tamper.setEvidence(evidence[0], encode("changed"));
      assert.equal((await openLog(stores, CASE_A)).ok, false);
      tamper.setEvidence(evidence[0], encode("first evidence"));
      assert.equal((await openLog(stores, CASE_A)).ok, true);
    } finally {
      dispose();
    }
  });
}

// A longer log, with every position tried, so no rule can hold only near the head.

const DEEP_ENTRIES = 6;

type DeepLog = Readonly<{ stores: MemoryStores; digests: readonly string[]; evidence: readonly (readonly string[])[] }>;

async function deepLog(module: LogModule): Promise<DeepLog> {
  const stores = memoryStores();
  await module.createLog(stores);
  const digests: string[] = [];
  const evidence: string[][] = [];
  for (let index = 0; index < DEEP_ENTRIES; index += 1) {
    const named = [await mustPutEvidence(stores, `object ${index} a`), await mustPutEvidence(stores, `object ${index} b`)];
    evidence.push(named);
    digests.push(await mustAppend(stores, runner, "step", NOW_MS + index, named, module));
  }
  return { stores, digests, evidence };
}

const checkEveryPosition = async (module: LogModule) => {
  for (let position = 0; position < DEEP_ENTRIES; position += 1) {
    const edited = await deepLog(module);
    const digest = edited.digests[position];
    const text = decode(edited.stores.entries.objects.get(digest) as Uint8Array);
    edited.stores.entries.objects.set(digest, encode(text.replace(ATTEMPT_ONE, "d4".repeat(16))));
    const afterEdit = await module.openLog(edited.stores, CASE_A);
    holds("an edit is found at every position", !afterEdit.ok && afterEdit.refusal === "entry-edited" && afterEdit.at === digest, () => ({ position, afterEdit }));

    for (const object of [0, 1]) {
      const changed = await deepLog(module);
      const target = changed.evidence[position][object];
      changed.stores.evidence.objects.set(target, encode("changed"));
      const afterChange = await module.openLog(changed.stores, CASE_A);
      holds("a changed object is found at every position", !afterChange.ok && afterChange.refusal === "evidence-changed" && afterChange.at === target, () => ({ position, object, afterChange }));

      const removed = await deepLog(module);
      const gone = removed.evidence[position][object];
      removed.stores.evidence.objects.delete(gone);
      const afterRemoval = await module.openLog(removed.stores, CASE_A);
      holds("a removed object is found at every position", !afterRemoval.ok && afterRemoval.refusal === "evidence-missing" && afterRemoval.at === gone, () => ({ position, object, afterRemoval }));
    }
  }
};

test("an edit, a changed object and a removed object are found at every position of a longer log", async () => {
  await checkEveryPosition(productionLog);
});

for (const [name, property, edit] of [
  ["only the newest three entries hashed", "an edit is found at every position", { find: "if ((await (0, canonical_json_1.sha256Hex)(bytes)) !== cursor)", replace: "if (entries.length < 3 && (await (0, canonical_json_1.sha256Hex)(bytes)) !== cursor)" }],
  ["only the newest three entries' evidence read", "a changed object is found at every position", { find: "for (const { entry } of walk.log.entries) {", replace: "for (const { entry } of walk.log.entries.slice(-3)) {" }],
  ["only an entry's first object read on open", "a changed object is found at every position", { find: "for (const digest of entry.evidence) {\n            const read", replace: "for (const digest of entry.evidence.slice(0, 1)) {\n            const read" }]
] as const) {
  test(`${name} is caught by the walk of every position`, async () => {
    await assertCaughtBy(name, property, () => checkEveryPosition(logVariant(edit)));
  });
}

// Crafted entries: their digests are right and the head names them, as someone holding
// the storage could arrange, and the chain rules still refuse them.

const CRAFTED_BASE = { actorText: runnerActorText(ATTEMPT_ONE), atMs: NOW_MS + 2000, eventsText: eventsTextOf("crafted") };

async function headAtCrafted(stores: MemoryStores, text: string | Uint8Array): Promise<string> {
  const bytes = typeof text === "string" ? encode(text) : text;
  const digest = sha256OfBytes(bytes);
  stores.entries.objects.set(digest, new Uint8Array(bytes));
  stores.head.value = digest;
  return digest;
}

type CraftContext = Readonly<{ first: string; second: string }>;
type Crafted = readonly [name: string, refusal: OpenRefusal, build: (context: CraftContext) => string, at?: (context: CraftContext) => string];

const CRAFTED: readonly Crafted[] = [
  ["a first entry that names a parent", "wrong-genesis", ({ first }) => handEntryText({ ...CRAFTED_BASE, prev: first, seq: 1 })],
  ["a later entry that claims genesis as its parent", "wrong-genesis", () => handEntryText({ ...CRAFTED_BASE, prev: GENESIS, seq: 2 })],
  ["a sequence that skips ahead", "broken-chain", ({ second }) => handEntryText({ ...CRAFTED_BASE, prev: second, seq: 4 }), ({ second }) => second],
  ["a sequence that repeats", "broken-chain", ({ second }) => handEntryText({ ...CRAFTED_BASE, prev: second, seq: 2 }), ({ second }) => second],
  ["a sequence that skips past a parent", "broken-chain", ({ first }) => handEntryText({ ...CRAFTED_BASE, prev: first, seq: 3 }), ({ first }) => first],
  ["a parent that was never written", "entry-missing", () => handEntryText({ ...CRAFTED_BASE, prev: ANOTHER_DIGEST, seq: 3 }), () => ANOTHER_DIGEST],
  ["a time before its parent's", "time-went-backward", ({ second }) => handEntryText({ ...CRAFTED_BASE, atMs: NOW_MS + 999, prev: second, seq: 3 }), ({ second }) => second],
  ["an owner entry at its token's expiry", "actor-expired", ({ second }) => handEntryText({ ...CRAFTED_BASE, actorText: OWNER_ACTOR_TEXT, atMs: EXP * 1000, prev: second, seq: 3 })],
  ["an owner whose token expired at the epoch", "actor-expired", ({ second }) => handEntryText({ ...CRAFTED_BASE, actorText: OWNER_ACTOR_TEXT.replace(/"exp":\d+/, '"exp":0'), prev: second, seq: 3 })],
  ["an entry naming another case", "wrong-case", ({ second }) => handEntryText({ ...CRAFTED_BASE, caseId: CASE_B, prev: second, seq: 3 })],
  ["an entry with a malformed case", "entry-malformed", ({ second }) => handEntryText({ ...CRAFTED_BASE, caseId: "Not A Case", prev: second, seq: 3 })],
  ["an entry with no case", "entry-malformed", ({ second }) => handEntryText({ ...CRAFTED_BASE, prev: second, seq: 3 }).replace('"case":"case-a",', "")],
  ["bytes that are not JSON", "entry-malformed", () => "not json"],
  ["an entry with a space added", "entry-malformed", ({ second }) => handEntryText({ ...CRAFTED_BASE, prev: second, seq: 3 }).replace('"v":1', '"v": 1')],
  ["an entry with unsorted keys", "entry-malformed", ({ second }) => handEntryText({ ...CRAFTED_BASE, prev: second, seq: 3 }).replace('"seq":3,"v":1', '"v":1,"seq":3')],
  ["an entry with a repeated key", "entry-malformed", ({ second }) => handEntryText({ ...CRAFTED_BASE, prev: second, seq: 3 }).replace('"v":1', '"v":1,"v":1')],
  ["another entry version", "entry-malformed", ({ second }) => handEntryText({ ...CRAFTED_BASE, prev: second, seq: 3 }).replace('"v":1', '"v":2')],
  ["an entry version in text", "entry-malformed", ({ second }) => handEntryText({ ...CRAFTED_BASE, prev: second, seq: 3 }).replace('"v":1', '"v":"1"')],
  ["an extra field holding a name", "entry-malformed", ({ second }) => handEntryText({ ...CRAFTED_BASE, prev: second, seq: 3 }).replace('"prev"', '"name":"Mallory","prev"')],
  ["a field missing", "entry-malformed", ({ second }) => handEntryText({ ...CRAFTED_BASE, prev: second, seq: 3 }).replace('"evidence":[],', "")],
  ["an actor with a name added", "entry-malformed", ({ second }) => handEntryText({ ...CRAFTED_BASE, actorText: `{"attemptId":"${ATTEMPT_ONE}","kind":"system:runner","name":"Mallory"}`, prev: second, seq: 3 })],
  ["an actor of an unknown kind and shape", "entry-malformed", ({ second }) => handEntryText({ ...CRAFTED_BASE, actorText: '{"kind":"admin"}', prev: second, seq: 3 })],
  ["an actor of an unknown kind with a runner's fields", "entry-malformed", ({ second }) => handEntryText({ ...CRAFTED_BASE, actorText: `{"attemptId":"${ATTEMPT_ONE}","kind":"system:admin"}`, prev: second, seq: 3 })],
  ["an actor that is a name", "entry-malformed", ({ second }) => handEntryText({ ...CRAFTED_BASE, actorText: '"Mallory"', prev: second, seq: 3 })],
  ["no actor at all", "entry-malformed", ({ second }) => handEntryText({ ...CRAFTED_BASE, actorText: "null", prev: second, seq: 3 })],
  ["a runner with a name for an attempt id", "entry-malformed", ({ second }) => handEntryText({ ...CRAFTED_BASE, actorText: runnerActorText("owner"), prev: second, seq: 3 })],
  ["an owner missing the email", "entry-malformed", ({ second }) => handEntryText({ ...CRAFTED_BASE, actorText: OWNER_ACTOR_TEXT.replace(/"email":"[^"]*",/, ""), prev: second, seq: 3 })],
  ["an owner with a number for an email", "entry-malformed", ({ second }) => handEntryText({ ...CRAFTED_BASE, actorText: OWNER_ACTOR_TEXT.replace(/"email":"[^"]*"/, '"email":7'), prev: second, seq: 3 })],
  ["an owner with an empty email", "entry-malformed", ({ second }) => handEntryText({ ...CRAFTED_BASE, actorText: OWNER_ACTOR_TEXT.replace(/"email":"[^"]*"/, '"email":""'), prev: second, seq: 3 })],
  ["an owner with an empty issuer", "entry-malformed", ({ second }) => handEntryText({ ...CRAFTED_BASE, actorText: OWNER_ACTOR_TEXT.replace(/"iss":"[^"]*"/, '"iss":""'), prev: second, seq: 3 })],
  ["an owner with an empty subject", "entry-malformed", ({ second }) => handEntryText({ ...CRAFTED_BASE, actorText: OWNER_ACTOR_TEXT.replace(/"sub":"[^"]*"/, '"sub":""'), prev: second, seq: 3 })],
  ["an owner with token times in text", "entry-malformed", ({ second }) => handEntryText({ ...CRAFTED_BASE, actorText: OWNER_ACTOR_TEXT.replace(/"iat":\d+/, '"iat":"1"'), prev: second, seq: 3 })],
  ["an owner with a negative issue time", "entry-malformed", ({ second }) => handEntryText({ ...CRAFTED_BASE, actorText: OWNER_ACTOR_TEXT.replace(/"iat":\d+/, '"iat":-1'), prev: second, seq: 3 })],
  ["an owner with a negative expiry", "entry-malformed", ({ second }) => handEntryText({ ...CRAFTED_BASE, actorText: OWNER_ACTOR_TEXT.replace(/"exp":\d+/, '"exp":-1'), prev: second, seq: 3 })],
  ["an owner with an expiry in text", "entry-malformed", ({ second }) => handEntryText({ ...CRAFTED_BASE, actorText: OWNER_ACTOR_TEXT.replace(/"exp":\d+/, `"exp":"${EXP}"`), prev: second, seq: 3 })],
  ["an owner with a name added", "entry-malformed", ({ second }) => handEntryText({ ...CRAFTED_BASE, actorText: OWNER_ACTOR_TEXT.replace('"sub"', '"name":"Mallory","sub"'), prev: second, seq: 3 })],
  ["no events", "entry-malformed", ({ second }) => handEntryText({ ...CRAFTED_BASE, eventsText: "[]", prev: second, seq: 3 })],
  ["events that are not a list", "entry-malformed", ({ second }) => handEntryText({ ...CRAFTED_BASE, eventsText: "{}", prev: second, seq: 3 })],
  ["events that are text", "entry-malformed", ({ second }) => handEntryText({ ...CRAFTED_BASE, eventsText: '"events"', prev: second, seq: 3 })],
  ["an event with a malformed type", "entry-malformed", ({ second }) => handEntryText({ ...CRAFTED_BASE, eventsText: eventsTextOf("Not A Type"), prev: second, seq: 3 })],
  ["an event type with a newline after it", "entry-malformed", ({ second }) => handEntryText({ ...CRAFTED_BASE, eventsText: '[{"data":{},"type":"crafted\\n"}]', prev: second, seq: 3 })],
  ["an event type starting with a digit", "entry-malformed", ({ second }) => handEntryText({ ...CRAFTED_BASE, eventsText: eventsTextOf("1crafted"), prev: second, seq: 3 })],
  ["an event type past 64 characters", "entry-malformed", ({ second }) => handEntryText({ ...CRAFTED_BASE, eventsText: eventsTextOf("a".repeat(65)), prev: second, seq: 3 })],
  ["a malformed second event after a good one", "entry-malformed", ({ second }) => handEntryText({ ...CRAFTED_BASE, eventsText: '[{"data":{},"type":"good"},{"data":{},"type":"Not A Type"}]', prev: second, seq: 3 })],
  ["a malformed first event before a good one", "entry-malformed", ({ second }) => handEntryText({ ...CRAFTED_BASE, eventsText: '[{"data":{},"type":"Not A Type"},{"data":{},"type":"good"}]', prev: second, seq: 3 })],
  ["an event with a field outside its data", "entry-malformed", ({ second }) => handEntryText({ ...CRAFTED_BASE, eventsText: '[{"actor":"Mallory","data":{},"type":"crafted"}]', prev: second, seq: 3 })],
  ["an event whose data is a list", "entry-malformed", ({ second }) => handEntryText({ ...CRAFTED_BASE, eventsText: '[{"data":[],"type":"crafted"}]', prev: second, seq: 3 })],
  ["an event whose data is text", "entry-malformed", ({ second }) => handEntryText({ ...CRAFTED_BASE, eventsText: '[{"data":"text","type":"crafted"}]', prev: second, seq: 3 })],
  ["an event whose data is null", "entry-malformed", ({ second }) => handEntryText({ ...CRAFTED_BASE, eventsText: '[{"data":null,"type":"crafted"}]', prev: second, seq: 3 })],
  ["an event whose type is a list that would read as text", "entry-malformed", ({ second }) => handEntryText({ ...CRAFTED_BASE, eventsText: '[{"data":{},"type":["crafted"]}]', prev: second, seq: 3 })],
  ["an evidence digest that is not one", "entry-malformed", ({ second }) => handEntryText({ ...CRAFTED_BASE, evidence: ["abc"], prev: second, seq: 3 })],
  ["a second evidence digest that is not one", "entry-malformed", ({ second }) => handEntryText({ ...CRAFTED_BASE, evidence: [FIRST_EVIDENCE_DIGEST, "abc"], prev: second, seq: 3 })],
  ["a first evidence digest that is not one", "entry-malformed", ({ second }) => handEntryText({ ...CRAFTED_BASE, evidence: ["abc", FIRST_EVIDENCE_DIGEST], prev: second, seq: 3 })],
  ["evidence that is not a list", "entry-malformed", ({ second }) => handEntryText({ ...CRAFTED_BASE, prev: second, seq: 3 }).replace('"evidence":[]', '"evidence":{}')],
  ["a parent that is not a digest", "entry-malformed", () => handEntryText({ ...CRAFTED_BASE, prev: "abc", seq: 3 })],
  ["a parent that is a list holding a digest", "entry-malformed", ({ second }) => handEntryText({ ...CRAFTED_BASE, prev: second, seq: 3 }).replace(`"prev":"${second}"`, `"prev":["${second}"]`)],
  ["a parent with a newline after its digest", "entry-malformed", ({ second }) => handEntryText({ ...CRAFTED_BASE, prev: second, seq: 3 }).replace(`"prev":"${second}"`, `"prev":"${second}\\n"`)],
  ["a parent with text before its digest", "entry-malformed", ({ second }) => handEntryText({ ...CRAFTED_BASE, prev: second, seq: 3 }).replace(`"prev":"${second}"`, `"prev":"x${second}"`)],
  ["a sequence of zero", "entry-malformed", ({ second }) => handEntryText({ ...CRAFTED_BASE, prev: second, seq: 0 })],
  ["a sequence in text", "entry-malformed", ({ second }) => handEntryText({ ...CRAFTED_BASE, prev: second, seq: 3 }).replace('"seq":3', '"seq":"3"')],
  ["a time before the epoch", "entry-malformed", ({ second }) => handEntryText({ ...CRAFTED_BASE, atMs: -1, prev: second, seq: 3 })],
  ["an entry that is a list", "entry-malformed", () => "[]"]
];

type Outcome = Readonly<{ outcome: string; at: string | null; crafted: string; context: CraftContext }>;

async function craftedOutcome(module: LogModule, build: (context: CraftContext) => string): Promise<Outcome> {
  const stores = memoryStores();
  await module.createLog(stores);
  const first = await mustAppend(stores, owner, "first", NOW_MS, [], module);
  const second = await mustAppend(stores, runner, "second", NOW_MS + 1000, [], module);
  await mustPutEvidence(stores, "first evidence");
  const context = { first, second };
  const crafted = await headAtCrafted(stores, build(context));
  try {
    const opened = await module.openLog(stores, CASE_A);
    return { outcome: opened.ok ? "opened" : opened.refusal, at: opened.ok ? null : opened.at, crafted, context };
  } catch {
    // Reading a stored entry must end in a typed refusal, so a throw is not the promised answer.
    return { outcome: "threw", at: null, crafted, context };
  }
}

const KEEPING_EVERY_RULE: readonly (readonly [string, (context: CraftContext) => string])[] = [
  ["a runner's entry", ({ second }) => handEntryText({ ...CRAFTED_BASE, prev: second, seq: 3 })],
  ["an owner's entry", ({ second }) => handEntryText({ ...CRAFTED_BASE, actorText: OWNER_ACTOR_TEXT, prev: second, seq: 3 })],
  ["an owner's entry a moment before expiry", ({ second }) => handEntryText({ ...CRAFTED_BASE, actorText: OWNER_ACTOR_TEXT, atMs: EXP * 1000 - 1, prev: second, seq: 3 })],
  ["an owner's token issued at the epoch", ({ second }) => handEntryText({ ...CRAFTED_BASE, actorText: OWNER_ACTOR_TEXT.replace(/"iat":\d+/, '"iat":0'), prev: second, seq: 3 })],
  ["a runner's entry long past any token's expiry", ({ second }) => handEntryText({ ...CRAFTED_BASE, atMs: (EXP + 31_536_000) * 1000, prev: second, seq: 3 })],
  ["the same time as its parent", ({ second }) => handEntryText({ ...CRAFTED_BASE, atMs: NOW_MS + 1000, prev: second, seq: 3 })],
  ["an event type of one character", ({ second }) => handEntryText({ ...CRAFTED_BASE, eventsText: eventsTextOf("a"), prev: second, seq: 3 })],
  ["an event type of exactly 64 characters", ({ second }) => handEntryText({ ...CRAFTED_BASE, eventsText: eventsTextOf("a".repeat(64)), prev: second, seq: 3 })],
  ["an event type using each kind of character it may", ({ second }) => handEntryText({ ...CRAFTED_BASE, eventsText: eventsTextOf("a0.b_c-d"), prev: second, seq: 3 })],
  ["two events", ({ second }) => handEntryText({ ...CRAFTED_BASE, eventsText: '[{"data":{},"type":"one"},{"data":{},"type":"two"}]', prev: second, seq: 3 })]
];

for (const [name, build] of KEEPING_EVERY_RULE) {
  test(`positive control: ${name} opens, so the refusals below come from what each one breaks`, async () => {
    assert.equal((await craftedOutcome(productionLog, build)).outcome, "opened");
  });
}

test("a first entry at the epoch opens, and a crafted first entry follows the same rules", async () => {
  const stores = memoryStores();
  await createLog(stores);
  await headAtCrafted(stores, handEntryText({ ...CRAFTED_BASE, atMs: 0, prev: GENESIS, seq: 1 }));
  assert.equal((await openLog(stores, CASE_A)).ok, true);
});

for (const [name, refusal, build, at] of CRAFTED) {
  test(`${name} is refused as ${refusal}, with a right digest and the head naming it`, async () => {
    const { outcome, at: reported, crafted, context } = await craftedOutcome(productionLog, build);
    assert.equal(outcome, refusal);
    assert.equal(reported, at === undefined ? crafted : at(context));
  });
}

/** Each chain or shape rule removed, the crafted entry only it stops, and the property that reports it. */
const CRAFTED_VARIANTS: readonly (readonly [string, SourceEdit, string])[] = [
  ["the case check", { find: 'if (entry.case !== caseId)\n            return refuse("wrong-case", cursor);', replace: "" }, "an entry naming another case"],
  ["the case's shape", { find: "isCaseId(value.case) &&", replace: "" }, "an entry with a malformed case"],
  ["the genesis rule", { find: 'if ((entry.seq === 1) !== (entry.prev === exports.GENESIS_HEAD))\n            return refuse("wrong-genesis", cursor);', replace: "" }, "a later entry that claims genesis as its parent"],
  ["the sequence rule", { find: 'if (later !== null && entry.seq !== later.seq - 1)\n            return refuse("broken-chain", cursor);', replace: "" }, "a sequence that repeats"],
  ["the sequence rule, past a parent", { find: 'if (later !== null && entry.seq !== later.seq - 1)\n            return refuse("broken-chain", cursor);', replace: "" }, "a sequence that skips past a parent"],
  ["the time rule on read", { find: 'if (later !== null && entry.atMs > later.atMs)\n            return refuse("time-went-backward", cursor);', replace: "" }, "a time before its parent's"],
  ["the expiry rule on read", { find: 'if (isPastActorExpiry(entry))\n            return refuse("actor-expired", cursor);', replace: "" }, "an owner entry at its token's expiry"],
  ["the expiry's own boundary", { find: "entry.atMs >= entry.actor.exp * 1000", replace: "entry.atMs > entry.actor.exp * 1000" }, "an owner entry at its token's expiry"],
  ["the entry shape check", { find: 'if (!isLogEntry(entry))\n            return refuse("entry-malformed", cursor);', replace: "" }, "an extra field holding a name"],
  ["the one-spelling rule on read", { find: '(0, canonical_json_1.parseCanonical)(bytes);\n        if (!isLogEntry(entry))\n            return refuse("entry-malformed", cursor);', replace: 'JSON.parse(new TextDecoder().decode(bytes));\n        if (!isLogEntry(entry))\n            return refuse("entry-malformed", cursor);' }, "an entry with a space added"],
  ["the exact fields of an entry", { find: '(0, canonical_json_1.hasExactly)(value, ["v", "case", "seq", "prev", "atMs", "actor", "events", "evidence"]) &&', replace: "" }, "an extra field holding a name"],
  ["the exact fields of an owner", { find: '(0, canonical_json_1.hasExactly)(value, ["kind", "iss", "sub", "email", "iat", "exp"]) &&', replace: "" }, "an owner with a name added"],
  ["the exact fields of a runner", { find: '(0, canonical_json_1.hasExactly)(value, ["kind", "attemptId"]) && ', replace: "" }, "an actor with a name added"],
  ["the runner's kind", { find: 'return value.kind === "system:runner" && (0, canonical_json_1.hasExactly)', replace: "return (0, canonical_json_1.hasExactly)" }, "an actor of an unknown kind with a runner's fields"],
  ["the exact fields of an event", { find: '(0, canonical_json_1.hasExactly)(value, ["type", "data"]) &&', replace: "" }, "an event with a field outside its data"],
  ["the runner's attempt id check", { find: "&& (0, actor_1.isAttemptId)(value.attemptId)", replace: "" }, "a runner with a name for an attempt id"],
  ["the owner's email check", { find: "isFilledString(value.email) &&", replace: "" }, "an owner with an empty email"],
  ["the owner's issuer check", { find: "isFilledString(value.iss) &&", replace: "" }, "an owner with an empty issuer"],
  ["the owner's subject check", { find: "isFilledString(value.sub) &&", replace: "" }, "an owner with an empty subject"],
  ["the owner's issue time check", { find: "isCount(value.iat, 0) &&", replace: "" }, "an owner with token times in text"],
  ["the owner's issue time floor", { find: "isCount(value.iat, 0) &&", replace: 'typeof value.iat === "number" &&' }, "an owner with a negative issue time"],
  ["the owner's expiry check", { find: "isCount(value.exp, 0)", replace: "true" }, "an owner with an expiry in text"],
  ["the rule that an entry has events", { find: "value.events.length > 0 &&", replace: "" }, "no events"],
  ["the rule that events are a list", { find: "Array.isArray(value.events) &&", replace: "" }, "events that are text"],
  ["checking only the first event", { find: "value.events.every(isLogEvent) &&", replace: "value.events.slice(0, 1).every(isLogEvent) &&" }, "a malformed second event after a good one"],
  ["checking only the last event", { find: "value.events.every(isLogEvent) &&", replace: "value.events.slice(-1).every(isLogEvent) &&" }, "a malformed first event before a good one"],
  ["the rule that evidence is a list", { find: "Array.isArray(value.evidence) &&", replace: "" }, "evidence that is not a list"],
  ["the event type pattern", { find: "EVENT_TYPE.test(value.type) &&", replace: "" }, "an event with a malformed type"],
  ["the event type pattern's end", { find: "const EVENT_TYPE = /^[a-z][a-z0-9._-]{0,63}$/;", replace: "const EVENT_TYPE = /^[a-z][a-z0-9._-]{0,63}/;" }, "an event type with a newline after it"],
  ["the event type pattern's first character", { find: "const EVENT_TYPE = /^[a-z][a-z0-9._-]{0,63}$/;", replace: "const EVENT_TYPE = /^[a-z0-9._-]{1,64}$/;" }, "an event type starting with a digit"],
  ["the event type pattern's bound", { find: "const EVENT_TYPE = /^[a-z][a-z0-9._-]{0,63}$/;", replace: "const EVENT_TYPE = /^[a-z][a-z0-9._-]{0,64}$/;" }, "an event type past 64 characters"],
  ["the rule that event data is an object", { find: "isPlainRecord(value.data)", replace: "true" }, "an event whose data is a list"],
  ["the evidence digest shape", { find: "value.evidence.every(isDigest)", replace: "true" }, "an evidence digest that is not one"],
  ["checking only the first evidence digest", { find: "value.evidence.every(isDigest)", replace: "value.evidence.slice(0, 1).every(isDigest)" }, "a second evidence digest that is not one"],
  ["accepting an evidence list with any good digest", { find: "value.evidence.every(isDigest)", replace: "(value.evidence.length === 0 || value.evidence.some(isDigest))" }, "a first evidence digest that is not one"],
  ["the parent digest shape", { find: "isDigest(value.prev) &&", replace: "" }, "a parent that is not a digest"],
  ["the digest check's type", { find: 'return typeof value === "string" && DIGEST.test(value);', replace: "return DIGEST.test(value);" }, "a parent that is a list holding a digest"],
  ["the digest pattern's end", { find: "const DIGEST = /^[0-9a-f]{64}$/;", replace: "const DIGEST = /^[0-9a-f]{64}/;" }, "a parent with a newline after its digest"],
  ["the digest pattern's start", { find: "const DIGEST = /^[0-9a-f]{64}$/;", replace: "const DIGEST = /[0-9a-f]{64}$/;" }, "a parent with text before its digest"],
  ["the sequence floor", { find: "isCount(value.seq, 1) &&", replace: "" }, "a sequence of zero"],
  ["the time check", { find: "isCount(value.atMs, 0) &&", replace: "" }, "a time before the epoch"],
  ["the entry version", { find: "value.v === ENTRY_VERSION &&", replace: "" }, "another entry version"],
  ["the entry version's strict comparison", { find: "value.v === ENTRY_VERSION &&", replace: "value.v == ENTRY_VERSION &&" }, "an entry version in text"],
  ["the count's type", { find: 'typeof value === "number" && value >= least', replace: "value >= least" }, "a sequence in text"],
  ["the count's floor", { find: 'typeof value === "number" && value >= least', replace: 'typeof value === "number"' }, "a sequence of zero"],
  ["a filled string's type", { find: 'typeof value === "string" && value !== ""', replace: 'value !== ""' }, "an owner with a number for an email"],
  ["a filled string's content", { find: 'typeof value === "string" && value !== ""', replace: 'typeof value === "string"' }, "an owner with an empty subject"],
  ["the event type's own type", { find: 'typeof value.type === "string" &&', replace: "" }, "an event whose type is a list that would read as text"],
  ["the object rule's list check", { find: 'typeof value === "object" && value !== null && !Array.isArray(value)', replace: 'typeof value === "object" && value !== null' }, "an event whose data is a list"],
  ["the object rule's null check", { find: 'typeof value === "object" && value !== null && !Array.isArray(value)', replace: 'typeof value === "object" && !Array.isArray(value)' }, "an event whose data is null"],
  ["the object rule's type check", { find: 'typeof value === "object" && value !== null && !Array.isArray(value)', replace: "value !== null && !Array.isArray(value)" }, "an event whose data is text"]
];

for (const [name, edit, attackName] of CRAFTED_VARIANTS) {
  test(`removing ${name} is caught by "${attackName}"`, async () => {
    const attack = CRAFTED.find(([candidate]) => candidate === attackName);
    assert.ok(attack, attackName);
    const check = async (module: LogModule) => {
      const { outcome } = await craftedOutcome(module, attack[2]);
      holds(`a crafted entry is refused as ${attack[1]}`, outcome === attack[1], () => ({ attackName, outcome }));
    };
    await check(productionLog);
    await assertCaughtBy(name, `a crafted entry is refused as ${attack[1]}`, () => check(logVariant(edit)));
  });
}

// A refusal names the object it is about, and these are the rows that say which.

for (const [refusal, attackName] of [
  ["entry-malformed", "an extra field holding a name"],
  ["broken-chain", "a sequence that repeats"],
  ["wrong-genesis", "a later entry that claims genesis as its parent"],
  ["wrong-case", "an entry naming another case"],
  ["time-went-backward", "a time before its parent's"],
  ["actor-expired", "an owner entry at its token's expiry"]
] as const) {
  test(`a ${refusal} refusal names where it was found, and dropping that is caught`, async () => {
    const attack = CRAFTED.find(([candidate]) => candidate === attackName);
    assert.ok(attack, attackName);
    const check = async (module: LogModule) => {
      const { at, crafted, context } = await craftedOutcome(module, attack[2]);
      const expected = attack[3] === undefined ? crafted : attack[3](context);
      holds("a refusal names the object it is about", at === expected, () => ({ refusal, at, expected }));
    };
    await check(productionLog);
    await assertCaughtBy(`${refusal} with no address`, "a refusal names the object it is about", () =>
      check(logVariant({ find: `return refuse("${refusal}", cursor);`, replace: `return refuse("${refusal}");` }))
    );
  });
}

// The rest of the refusals on open, each with its own broken variant.

async function outcomeOf(module: LogModule, attackName: string): Promise<string> {
  const attack = ATTACKS.find(({ name }) => name === attackName);
  assert.ok(attack, attackName);
  const { stores, tamper, dispose } = MEMORY_BACKEND.fresh();
  try {
    const seeded = await seed(stores, module);
    await attack.apply(tamper, seeded, stores);
    const opened = await module.openLog(stores, CASE_A);
    return opened.ok ? "opened" : opened.refusal;
  } finally {
    dispose();
  }
}

for (const [name, edit, attackName] of [
  ["the missing head rule", { find: 'if (head === null)\n        return refuse("head-missing");', replace: "if (head === null)\n        return { ok: true, log: { head: exports.GENESIS_HEAD, entries: [] } };" }, "the head removed"],
  ["the head shape rule", { find: 'if (!isDigest(head))\n        return refuse("head-malformed");', replace: "" }, "a torn head"],
  ["the rule that an object must exist", { find: 'if (bytes === null)\n            return refuse("entry-missing", cursor);', replace: "if (bytes === null)\n            break;" }, "the newest entry removed"],
  ["the rule that an object must exist, mid-chain", { find: 'if (bytes === null)\n            return refuse("entry-missing", cursor);', replace: "if (bytes === null)\n            break;" }, "the middle entry removed"],
  ["the digest check", { find: 'if ((await (0, canonical_json_1.sha256Hex)(bytes)) !== cursor)\n            return refuse("entry-edited", cursor);', replace: "" }, "the middle entry re-attributed in place, still well formed"],
  ["the digest check on the newest entry", { find: 'if ((await (0, canonical_json_1.sha256Hex)(bytes)) !== cursor)\n            return refuse("entry-edited", cursor);', replace: "" }, "the newest entry's time moved in place, still well formed"],
  ["the digest check on all but the newest entry", { find: "if ((await (0, canonical_json_1.sha256Hex)(bytes)) !== cursor)", replace: "if (entries.length === 0 && (await (0, canonical_json_1.sha256Hex)(bytes)) !== cursor)" }, "the middle entry re-attributed in place, still well formed"],
  ["reading all but the newest entry's evidence", { find: "for (const { entry } of walk.log.entries) {", replace: "for (const { entry } of walk.log.entries.slice(-1)) {" }, "the first object of the older entry changed"],
  ["reading only an entry's first object", { find: "for (const digest of entry.evidence) {\n            const read", replace: "for (const digest of entry.evidence.slice(0, 1)) {\n            const read" }, "the second object of the newest entry changed"],
  ["reading only an entry's first object, for a removal", { find: "for (const digest of entry.evidence) {\n            const read", replace: "for (const digest of entry.evidence.slice(0, 1)) {\n            const read" }, "the second object of the older entry removed"],
  ["the digest pattern's case", { find: "const DIGEST = /^[0-9a-f]{64}$/;", replace: "const DIGEST = /^[0-9a-fA-F]{64}$/;" }, "a head in uppercase"],
  ["the digest pattern's length", { find: "const DIGEST = /^[0-9a-f]{64}$/;", replace: "const DIGEST = /^[0-9a-f]+$/;" }, "a torn head"],
  ["the rule that a removed evidence object is refused", { find: 'if (bytes === null)\n        return refuse("evidence-missing", digest);', replace: "if (bytes === null)\n        return null;" }, "the second object of the newest entry removed"],
  ["the evidence digest check", { find: 'if ((await (0, canonical_json_1.sha256Hex)(bytes)) !== digest)\n        return refuse("evidence-changed", digest);', replace: "" }, "the second object of the newest entry changed"],
  ["the evidence size bound on read", { find: 'if (bytes === "too-large")\n        return refuse("evidence-too-large", digest);', replace: "" }, "an evidence object past the size bound at its address"],
  ["reading evidence on open at all", { find: "for (const digest of entry.evidence) {\n            const read = await readEvidence(stores, digest);\n            if (!read.ok)\n                return read;\n            if (seen !== null)\n                seen(digest, read.bytes);\n        }\n    }\n    return walk;", replace: "}\n    return walk;" }, "the second object of the newest entry changed"]
] as const) {
  test(`removing ${name} is caught by "${attackName}"`, async () => {
    const expected = ATTACKS.find((attack) => attack.name === attackName)?.refusal;
    const check = async (module: LogModule) => {
      let outcome: string;
      try {
        outcome = await outcomeOf(module, attackName);
      } catch {
        outcome = "threw";
      }
      holds(`${attackName} is refused`, outcome === expected, () => outcome);
    };
    await check(productionLog);
    await assertCaughtBy(name, `${attackName} is refused`, () => check(logVariant(edit)));
  });
}

// Size. The numbers are written here so a changed constant cannot move a test with it.

const ENTRY_LIMIT = 256 * 1024;
const EVIDENCE_LIMIT = 32 * 1024 * 1024;

function entryOfExactly(size: number, prev: string, seq: number): string {
  const empty = handEntryText({ ...CRAFTED_BASE, eventsText: '[{"data":{"pad":""},"type":"crafted"}]', prev, seq });
  return handEntryText({ ...CRAFTED_BASE, eventsText: `[{"data":{"pad":"${"x".repeat(size - encode(empty).length)}"},"type":"crafted"}]`, prev, seq });
}

test("the size bounds are the stated ones", () => {
  assert.equal(MAX_ENTRY_BYTES, ENTRY_LIMIT);
  assert.equal(MAX_EVIDENCE_BYTES, EVIDENCE_LIMIT);
});

const checkReadBound = async (module: LogModule) => {
  for (const [size, expected] of [[ENTRY_LIMIT, "opened"], [ENTRY_LIMIT + 1, "entry-too-large"]] as const) {
    const stores = memoryStores();
    await module.createLog(stores);
    await headAtCrafted(stores, entryOfExactly(size, GENESIS, 1));
    let outcome: string;
    try {
      const opened = await module.openLog(stores, CASE_A);
      outcome = opened.ok ? "opened" : opened.refusal;
    } catch {
      outcome = "threw";
    }
    holds("an entry past the bound is refused on read, and one at it opens", outcome === expected, () => ({ size, outcome }));
  }
};

const checkWriteBound = async (module: LogModule) => {
  const padding = (size: number) => {
    const text = entryOfExactly(size, GENESIS, 1);
    return (JSON.parse(text) as { events: { data: { pad: string } }[] }).events[0].data.pad;
  };
  for (const [size, ok] of [[ENTRY_LIMIT, true], [ENTRY_LIMIT + 1, false]] as const) {
    const stores = memoryStores();
    await module.createLog(stores);
    const result = await module.appendCommand(stores, { caseId: CASE_A, actor: runner, events: [event("crafted", { pad: padding(size) })], evidence: [], expectedHead: GENESIS, now: clock(CRAFTED_BASE.atMs) });
    const opened = await module.openLog(stores, CASE_A);
    holds("a command past the bound is refused and changes nothing, and one at it commits", result.ok === ok && opened.ok && opened.log.entries.length === (ok ? 1 : 0) && (ok || (!result.ok && result.refusal === "entry-too-large")), () => ({ size, result }));
  }
};

test("an entry past the bound is refused on read and on write, and one exactly at it is not", async () => {
  await checkReadBound(productionLog);
  await checkWriteBound(productionLog);
});

test("removing either entry bound is caught", async () => {
  await assertCaughtBy("the bound on read", "an entry past the bound is refused on read, and one at it opens", () =>
    checkReadBound(logVariant({ find: 'if (bytes === "too-large")\n            return refuse("entry-too-large", cursor);', replace: "" }))
  );
  await assertCaughtBy("the bound passed to a read", "an entry past the bound is refused on read, and one at it opens", () =>
    checkReadBound(logVariant({ find: "readOwn(stores.entries, cursor, exports.MAX_ENTRY_BYTES)", replace: "readOwn(stores.entries, cursor, 2 * exports.MAX_ENTRY_BYTES)" }))
  );
  await assertCaughtBy("the bound on write", "a command past the bound is refused and changes nothing, and one at it commits", () =>
    checkWriteBound(logVariant({ find: 'if (bytes.length > exports.MAX_ENTRY_BYTES)\n        return refuse("entry-too-large");', replace: "" }))
  );
});

const checkEvidenceBounds = async (module: LogModule) => {
  const stores = memoryStores();
  const refused = await module.putEvidence(stores, new Uint8Array(EVIDENCE_LIMIT + 1));
  holds("evidence past the bound is refused, and nothing is stored", !refused.ok && refused.refusal === "evidence-too-large" && stores.evidence.objects.size === 0, () => refused);
  const stored = await module.putEvidence(stores, new Uint8Array(EVIDENCE_LIMIT));
  holds("evidence at the bound is stored", stored.ok, () => stored);
  await module.createLog(stores);
  const digest = (stored as { digest: string }).digest;
  await headAtCrafted(stores, handEntryText({ ...CRAFTED_BASE, evidence: [digest], prev: GENESIS, seq: 1 }));
  const atBound = await module.openLog(stores, CASE_A);
  holds("evidence at the bound opens", atBound.ok, () => atBound);

  const over = new Uint8Array(EVIDENCE_LIMIT + 1);
  const overDigest = sha256OfBytes(over);
  stores.evidence.objects.set(overDigest, over);
  await headAtCrafted(stores, handEntryText({ ...CRAFTED_BASE, evidence: [overDigest], prev: GENESIS, seq: 1 }));
  const placed = await module.openLog(stores, CASE_A);
  holds("evidence placed past the bound, under its true digest, is refused on open", !placed.ok && placed.refusal === "evidence-too-large" && placed.at === overDigest, () => placed);
};

test("an evidence object past the bound is refused on the way in and on open, and one at it is not", async () => {
  await checkEvidenceBounds(productionLog);
});

test("removing an evidence bound is caught", async () => {
  await assertCaughtBy("the evidence bound on the way in", "evidence past the bound is refused, and nothing is stored", () =>
    checkEvidenceBounds(logVariant({ find: 'if (bytes.length > exports.MAX_EVIDENCE_BYTES)\n        return refuse("evidence-too-large");', replace: "" }))
  );
  await assertCaughtBy("the bound passed to an evidence read", "evidence placed past the bound, under its true digest, is refused on open", () =>
    checkEvidenceBounds(logVariant({ find: "readOwn(stores.evidence, digest, exports.MAX_EVIDENCE_BYTES)", replace: "readOwn(stores.evidence, digest, 2 * exports.MAX_EVIDENCE_BYTES)" }))
  );
});

test("every read names its bound, and a read-back asks for no more than it wrote", async () => {
  const stores = memoryStores();
  await createLog(stores);
  await mustPutEvidence(stores, "first evidence");
  const reads: string[] = [];
  const entries = stores.entries.read.bind(stores.entries);
  const evidence = stores.evidence.read.bind(stores.evidence);
  stores.entries.read = async (address, maxBytes) => (reads.push(`entry ${maxBytes}`), entries(address, maxBytes));
  stores.evidence.read = async (address, maxBytes) => (reads.push(`evidence ${maxBytes}`), evidence(address, maxBytes));
  await mustAppend(stores, runner, "one", NOW_MS, [FIRST_EVIDENCE_DIGEST]);
  assert.deepEqual(reads, [`evidence ${EVIDENCE_LIMIT}`]);
  reads.length = 0;
  await putEvidence(stores, encode("first evidence"));
  assert.deepEqual(reads, ["evidence 14"]);
  reads.length = 0;
  await openLog(stores, CASE_A);
  assert.deepEqual(reads, [`entry ${ENTRY_LIMIT}`, `evidence ${EVIDENCE_LIMIT}`]);
});

test("a store that finds no object at an address is believed, and reads as a change", async () => {
  const check = async (module: LogModule) => {
    const stores = memoryStores();
    const { digests, evidence } = await seed(stores, module);
    const entries = stores.entries.read.bind(stores.entries);
    const objects = stores.evidence.read.bind(stores.evidence);
    stores.evidence.read = async (address, maxBytes) => (address === evidence[1] ? "not-an-object" : objects(address, maxBytes));
    const changed = await module.openLog(stores, CASE_A).catch(() => "threw");
    holds("something at an evidence address that is no object is a changed object", typeof changed === "object" && !changed.ok && changed.refusal === "evidence-changed" && changed.at === evidence[1], () => changed);
    stores.entries.read = async (address, maxBytes) => (address === digests[1] ? "not-an-object" : entries(address, maxBytes));
    const edited = await module.openLog(stores, CASE_A).catch(() => "threw");
    holds("something at an entry address that is no object is an edited entry", typeof edited === "object" && !edited.ok && edited.refusal === "entry-edited" && edited.at === digests[1], () => edited);
  };
  await check(productionLog);
  await assertCaughtBy("reading past it as evidence", "something at an evidence address that is no object is a changed object", () =>
    check(logVariant({ find: 'if (bytes === "not-an-object")\n        return refuse("evidence-changed", digest);', replace: "" }))
  );
  await assertCaughtBy("reading past it as an entry", "something at an entry address that is no object is an edited entry", () =>
    check(logVariant({ find: 'if (bytes === "not-an-object")\n            return refuse("entry-edited", cursor);', replace: "" }))
  );
});

// A store is not trusted with what it returned, or with the bound it was given.

/** A store that keeps hold of what it hands back, and overwrites it once a reader has gone on to await something else. */
function changingAfterReturn(inner: MemoryStores, rewrite: (text: string) => string, turns: number, present: (bytes: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer> = (bytes) => bytes): LogStores {
  const wrap = (objects: MemoryStores["entries"]): LogStores["entries"] => ({
    createOnly: (address, bytes) => objects.createOnly(address, bytes),
    read: async (address, maxBytes) => {
      const bytes = await objects.read(address, maxBytes);
      if (bytes instanceof Uint8Array) {
        const handed = present(bytes);
        const changed = encode(rewrite(decode(bytes)));
        void (async () => {
          for (let turn = 0; turn < turns; turn += 1) await null;
          // A bare buffer is written through a view of its own, as the store's own memory.
          if (changed.length === bytes.length) (handed instanceof ArrayBuffer ? new Uint8Array(handed) : handed).set(changed);
        })();
        return handed;
      }
      return bytes;
    }
  });
  return { entries: wrap(inner.entries), evidence: wrap(inner.evidence), head: inner.head };
}

/** A store's own bare buffer, handed back as it is: the one answer a typed array built from it would only view. */
const bareBuffer = (bytes: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> => bytes.buffer as unknown as Uint8Array<ArrayBuffer>;

const checkLiveBuffers = async (module: LogModule) => {
  // However long the store waits, the reader must see what it hashed. Zero to a few thousand turns spans every await in a read.
  for (const [present, turns] of [undefined, bareBuffer].flatMap((form) => [0, 1, 2, 3, 5, 8, 13, 50, 200, 2000].map((count) => [form, count] as const))) {
    const inner = memoryStores();
    await module.createLog(inner);
    const first = await mustAppend(inner, runner, "true-first", NOW_MS, [], module);
    const second = await mustAppend(inner, runner, "true-next", NOW_MS + 1, [], module);

    // Rewrites the events to something else of the same length, after the digest has its copy.
    const edited = changingAfterReturn(inner, (text) => text.replace("true-next", "fake-next"), turns, present);
    const opened = await module.openLog(edited, CASE_A);
    if (opened.ok) {
      const events = opened.log.entries.map(({ entry }) => entry.events[0].type);
      holds("what opens is what was hashed, whatever the store does to its own buffer", JSON.stringify(events) === '["true-first","true-next"]', () => ({ turns, events }));
    }

    // Repoints a chain at a head it never held, which a saved-head check would then accept.
    const never = sha256OfText("a head this chain never held");
    const repointed = changingAfterReturn(inner, (text) => text.replace(first, never), turns, present);
    const verdict = await module.verifyAgainstSavedHead(repointed, CASE_A, never);
    holds("a saved head the chain never held is refused, whatever the store does to its own buffer", !verdict.ok, () => ({ turns, verdict, second }));

    const withEvidence = memoryStores();
    await module.createLog(withEvidence);
    const named = (await module.putEvidence(withEvidence, encode("first evidence")) as { digest: string }).digest;
    await mustAppend(withEvidence, runner, "named", NOW_MS, [named], module);
    // Evidence is only ever hashed, so a change either came first and is refused, or came too late to matter.
    const changedEvidence = changingAfterReturn(withEvidence, (text) => text.replace("first evidence", "fakes evidence"), turns, present);
    const evidenceOpened = await module.openLog(changedEvidence, CASE_A);
    holds("evidence is what was hashed, whatever the store does to its own buffer", evidenceOpened.ok || evidenceOpened.refusal === "evidence-changed", () => ({ turns, evidenceOpened }));
  }
};

test("what is hashed and what is read are one copy, taken once, so a store's later writes change neither", async () => {
  await checkLiveBuffers(productionLog);
});

test("using the store's own buffer is caught", async () => {
  await assertCaughtBy("no copy", "what opens is what was hashed, whatever the store does to its own buffer", () =>
    checkLiveBuffers(logVariant({ find: "const own = view.buffer === answer ? view.slice() : view;", replace: "const own = answer;" }))
  );
});

/** Each kind of answer a store could hand back in place of a plain Uint8Array of this realm. */
class LyingLength extends Uint8Array {
  override get length(): number {
    return 1;
  }
}
const ANSWER_FORMS: ReadonlyArray<readonly [string, (bytes: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer>]> = [
  [
    "a view from another realm",
    (bytes) => {
      const foreign = runInNewContext("new Uint8Array(size)", { size: bytes.length }) as Uint8Array<ArrayBuffer>;
      foreign.set(bytes);
      return foreign;
    }
  ],
  ["a subclass that lies about its length", (bytes) => LyingLength.from(bytes)],
  [
    "a proxy that lies about its length",
    (bytes) =>
      new Proxy(bytes, {
        get(target, key) {
          if (key === "length") return 1;
          const value: unknown = Reflect.get(target, key, target);
          return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
        }
      })
  ],
  ["a bare ArrayBuffer", (bytes) => bytes.slice().buffer as unknown as Uint8Array<ArrayBuffer>]
];

/** A store handing back any answer in the given form, and ignoring the bound it is given. */
const answeringAs = (inner: MemoryStores, present: (bytes: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer>): LogStores => {
  const wrap = (objects: MemoryStores["entries"]): LogStores["entries"] => ({
    createOnly: (address, bytes) => objects.createOnly(address, bytes),
    read: async (address) => {
      const bytes = objects.objects.get(address);
      return bytes === undefined ? null : present(bytes as Uint8Array<ArrayBuffer>);
    }
  });
  return { entries: wrap(inner.entries), evidence: wrap(inner.evidence), head: inner.head };
};

const checkAnswerForms = async (module: LogModule) => {
  for (const [form, present] of ANSWER_FORMS) {
    const plain = memoryStores();
    await module.createLog(plain);
    await mustAppend(plain, runner, "first", NOW_MS, [], module);
    const named = (await module.putEvidence(plain, encode("some evidence")) as { digest: string }).digest;
    await mustAppend(plain, runner, "second", NOW_MS + 1, [named], module);
    const opened = await module.openLog(answeringAs(plain, present), CASE_A);
    holds("a good log opens through every kind of answer", opened.ok && opened.log.entries.length === 2, () => ({ form, opened }));

    const bigEntry = memoryStores();
    await module.createLog(bigEntry);
    await headAtCrafted(bigEntry, handEntryText({ ...CRAFTED_BASE, eventsText: `[{"data":{"pad":"${"x".repeat(300 * 1024)}"},"type":"crafted"}]`, prev: GENESIS, seq: 1 }));
    const refused = await module.openLog(answeringAs(bigEntry, present), CASE_A);
    holds("an oversize entry is refused through every kind of answer", !refused.ok && refused.refusal === "entry-too-large", () => ({ form, refused }));

    const bigEvidence = memoryStores();
    await module.createLog(bigEvidence);
    const over = new Uint8Array(EVIDENCE_LIMIT + 1);
    const overDigest = sha256OfBytes(over);
    bigEvidence.evidence.objects.set(overDigest, over);
    await headAtCrafted(bigEvidence, handEntryText({ ...CRAFTED_BASE, evidence: [overDigest], prev: GENESIS, seq: 1 }));
    const refusedEvidence = await module.openLog(answeringAs(bigEvidence, present), CASE_A);
    holds("oversize evidence is refused through every kind of answer", !refusedEvidence.ok && refusedEvidence.refusal === "evidence-too-large", () => ({ form, refusedEvidence }));
  }
  // Changed by the store after it answered, in a realm where instanceof would not see it, and as a bare buffer of its own.
  const [, foreign] = ANSWER_FORMS[0];
  for (const [present, turns] of [foreign, bareBuffer].flatMap((form) => [0, 1, 2, 3, 5, 8, 13, 50, 200, 2000].map((count) => [form, count] as const))) {
    const inner = memoryStores();
    await module.createLog(inner);
    const first = await mustAppend(inner, runner, "true-first", NOW_MS, [], module);
    await mustAppend(inner, runner, "true-next", NOW_MS + 1, [], module);
    const opened = await module.openLog(changingAfterReturn(inner, (text) => text.replace("true-next", "fake-next"), turns, present), CASE_A);
    if (opened.ok) {
      const events = opened.log.entries.map(({ entry }) => entry.events[0].type);
      holds("what opens is what was hashed, through another realm's view", JSON.stringify(events) === '["true-first","true-next"]', () => ({ turns, events }));
    }
    const never = sha256OfText("a head this chain never held");
    const verdict = await module.verifyAgainstSavedHead(changingAfterReturn(inner, (text) => text.replace(first, never), turns, present), CASE_A, never);
    holds("a saved head the chain never held is refused, through another realm's view", !verdict.ok, () => ({ turns, verdict }));
  }
};

test("whatever kind of answer a store hands back, the core works from its own plain copy and its own measure", async () => {
  await checkAnswerForms(productionLog);
});

test("trusting instanceof for a store's answer is caught", async () => {
  await assertCaughtBy("instanceof", "an oversize entry is refused through every kind of answer", () =>
    checkAnswerForms(logVariant({ find: 'if (answer === null || typeof answer === "string")', replace: "if (!(answer instanceof Uint8Array))" }))
  );
});

test("working from a store's answer as it came is caught", async () => {
  await assertCaughtBy("no copy", "a good log opens through every kind of answer", () =>
    checkAnswerForms(logVariant({ find: "const own = view.buffer === answer ? view.slice() : view;", replace: "const own = answer;" }))
  );
});

const BIG_PADDING = "x".repeat(300 * 1024);

/** A store whose read ignores the bound it is given. */
const ignoringBounds = (inner: MemoryStores): LogStores => ({
  entries: { createOnly: (address, bytes) => inner.entries.createOnly(address, bytes), read: async (address) => inner.entries.objects.get(address) ?? null },
  evidence: { createOnly: (address, bytes) => inner.evidence.createOnly(address, bytes), read: async (address) => inner.evidence.objects.get(address) ?? null },
  head: { read: async () => inner.head.value, compareAndSwap: (expected, next) => inner.head.compareAndSwap(expected, next) }
});

const checkBoundsHeld = async (module: LogModule) => {
  const entryCase = memoryStores();
  await module.createLog(entryCase);
  const big = handEntryText({ ...CRAFTED_BASE, eventsText: `[{"data":{"pad":"${BIG_PADDING}"},"type":"crafted"}]`, prev: GENESIS, seq: 1 });
  const bigDigest = await headAtCrafted(entryCase, big);
  const opened = await module.openLog(ignoringBounds(entryCase), CASE_A);
  holds("an entry past the bound is refused, whichever store handed it over", !opened.ok && opened.refusal === "entry-too-large" && opened.at === bigDigest, () => opened);
  const verified = await module.verifyAgainstSavedHead(ignoringBounds(entryCase), CASE_A, bigDigest);
  holds("a saved head is not verified through an entry past the bound", !verified.ok && verified.refusal === "entry-too-large", () => verified);

  const evidenceCase = memoryStores();
  await module.createLog(evidenceCase);
  const over = new Uint8Array(EVIDENCE_LIMIT + 1);
  const overDigest = sha256OfBytes(over);
  evidenceCase.evidence.objects.set(overDigest, over);
  await headAtCrafted(evidenceCase, handEntryText({ ...CRAFTED_BASE, evidence: [overDigest], prev: GENESIS, seq: 1 }));
  const evidenceOpened = await module.openLog(ignoringBounds(evidenceCase), CASE_A);
  holds("evidence past the bound is refused, whichever store handed it over", !evidenceOpened.ok && evidenceOpened.refusal === "evidence-too-large" && evidenceOpened.at === overDigest, () => evidenceOpened);
};

test("the core holds a store to the bound, whichever store it is", async () => {
  await checkBoundsHeld(productionLog);
});

test("trusting the store with the bound is caught", async () => {
  await assertCaughtBy("no length check", "an entry past the bound is refused, whichever store handed it over", () =>
    checkBoundsHeld(logVariant({ find: 'return own.length > maxBytes ? "too-large" : own;', replace: "return own;" }))
  );
});

test("the head is read with a bound, and a long one is malformed even from a store that ignores it", async () => {
  const check = async (module: LogModule) => {
    const stores = memoryStores();
    await module.createLog(stores);
    const asked: number[] = [];
    const read = stores.head.read.bind(stores.head);
    stores.head.read = async (maxChars) => (asked.push(maxChars), read(maxChars));
    await module.openLog(stores, CASE_A);
    holds("the head is read with a digest's length as its bound", JSON.stringify(asked) === "[64]", () => asked);
    stores.head.read = read;
    stores.head.value = "f".repeat(65);
    const long = await module.openLog(ignoringBounds(stores), CASE_A);
    holds("a long head is malformed, whichever store handed it over", !long.ok && long.refusal === "head-malformed", () => long);
  };
  await check(productionLog);
  await assertCaughtBy("an unbounded head read", "the head is read with a digest's length as its bound", () =>
    check(logVariant({ find: "await stores.head.read(exports.MAX_HEAD_CHARS)", replace: "await stores.head.read(Number.MAX_SAFE_INTEGER)" }))
  );
  await assertCaughtBy("a longer head bound", "the head is read with a digest's length as its bound", () =>
    check(logVariant({ find: "exports.MAX_HEAD_CHARS = 64;", replace: "exports.MAX_HEAD_CHARS = 65;" }))
  );
});

// Binding a log to its case.

const GOOD_CASE_IDS = ["a", "0", "case-a", "a-b-c", "a".repeat(64)];
const BAD_CASE_IDS = ["", "-a", "a-", "A", "Case-A", "a b", "a\n", "a/b", "../a", "a.b", "a_b", "é", "a".repeat(65), 7, null, undefined, ["case-a"]];

const checkCaseIds = async (module: LogModule) => {
  for (const caseId of BAD_CASE_IDS) {
    const stores = memoryStores();
    await module.createLog(stores);
    const opened = await module.openLog(stores, caseId as string);
    holds("a malformed case id is refused before anything is read", !opened.ok && opened.refusal === "malformed-case-id", () => ({ caseId, opened }));
    const appended = await module.appendCommand(stores, { caseId: caseId as string, actor: runner, events: [event("fine")], evidence: [], expectedHead: GENESIS, now: clock() });
    holds("a malformed case id is refused before anything is written", !appended.ok && appended.refusal === "malformed-case-id" && stores.head.value === GENESIS, () => ({ caseId, appended }));
  }
  for (const caseId of GOOD_CASE_IDS) {
    const stores = memoryStores();
    await module.createLog(stores);
    const appended = await module.appendCommand(stores, { caseId, actor: runner, events: [event("fine")], evidence: [], expectedHead: GENESIS, now: clock() });
    holds("a well-formed case id is a case", appended.ok && appended.entry.case === caseId, () => ({ caseId, appended }));
    const opened = await module.openLog(stores, caseId);
    holds("a well-formed case id opens its own log", opened.ok && opened.log.entries.length === 1, () => ({ caseId, opened }));
  }
};

test("only a well-formed case id names a log", async () => {
  await checkCaseIds(productionLog);
});

for (const [name, property, find, replace] of [
  ["the case id check", "a malformed case id is refused before anything is read", 'if (!isCaseId(caseId))\n        return refuse("malformed-case-id");', ""],
  ["the case id's type check", "a malformed case id is refused before anything is read", 'return typeof value === "string" && CASE_ID.test(value);', "return CASE_ID.test(value);"],
  ["the case id pattern's end", "a malformed case id is refused before anything is read", "const CASE_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;", "const CASE_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?/;"],
  ["the case id pattern's start", "a malformed case id is refused before anything is read", "const CASE_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;", "const CASE_ID = /(?:[a-z0-9-]{0,63}[a-z0-9])?$/;"],
  ["the case id's bound", "a malformed case id is refused before anything is read", "const CASE_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;", "const CASE_ID = /^[a-z0-9](?:[a-z0-9-]{0,63}[a-z0-9])?$/;"],
  ["the case id's trailing rule", "a malformed case id is refused before anything is read", "const CASE_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;", "const CASE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;"],
  ["a shorter case id bound", "a well-formed case id is a case", "const CASE_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;", "const CASE_ID = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;"]
] as const) {
  test(`a variant with ${name} is caught`, async () => {
    await assertCaughtBy(name, property, () => checkCaseIds(logVariant({ find, replace })));
  });
}

/** Two cases sharing their object stores, as a hosted store might, each with its own head. */
function sharingStores(): readonly [LogStores & { head: MemoryHead }, LogStores & { head: MemoryHead }] {
  const shared = memoryStores();
  const one = { entries: shared.entries, evidence: shared.evidence, head: new MemoryHead() };
  const other = { entries: shared.entries, evidence: shared.evidence, head: new MemoryHead() };
  return [one, other];
}

const checkSplice = async (module: LogModule) => {
  const [caseA, caseB] = sharingStores();
  await module.createLog(caseA);
  await module.createLog(caseB);
  const first = await mustAppend(caseA, runner, "from-case-a", NOW_MS, [], module, CASE_A);
  // A head write, and only that: nothing else in the store changes.
  caseB.head.value = first;
  const opened = await module.openLog(caseB, CASE_B);
  holds("a head moved to another case's entry is refused", !opened.ok && opened.refusal === "wrong-case" && opened.at === first, () => opened);
  const appended = await module.appendCommand(caseB, { caseId: CASE_B, actor: runner, events: [event("continued")], evidence: [], expectedHead: first, now: clock(LATER) });
  holds("no command continues another case's log", !appended.ok && appended.refusal === "wrong-case" && caseB.head.value === first, () => appended);
  const original = await module.openLog(caseA, CASE_A);
  holds("the case it was taken from still opens", original.ok && original.log.entries.length === 1, () => original);
};

test("a head moved to another case's entry opens nothing and continues nothing", async () => {
  await checkSplice(productionLog);
});

test("removing the case check lets one case read as another, and is caught", async () => {
  await assertCaughtBy("the case check", "a head moved to another case's entry is refused", () =>
    checkSplice(logVariant({ find: 'if (entry.case !== caseId)\n            return refuse("wrong-case", cursor);', replace: "" }))
  );
});

// Creating a log, and stale writers.

test("a log is created once, and creating it again changes nothing", async () => {
  const check = async (module: LogModule) => {
    const stores = memoryStores();
    await module.createLog(stores);
    const digest = await mustAppend(stores, runner, "first", NOW_MS, [], module);
    const again = await module.createLog(stores);
    holds("creating a log twice is refused", !again.ok && again.refusal === "log-exists", () => again);
    holds("creating a log twice changes nothing", stores.head.value === digest, () => stores.head.value);
  };
  await check(productionLog);
  await assertCaughtBy("the creation outcome", "creating a log twice is refused", () =>
    check(logVariant({ find: 'return (await stores.head.compareAndSwap(null, exports.GENESIS_HEAD)) ? { ok: true } : refuse("log-exists");', replace: "await stores.head.compareAndSwap(null, exports.GENESIS_HEAD);\n    return { ok: true };" }))
  );
});

const checkStaleWriter = async (module: LogModule) => {
  const stores = memoryStores();
  await module.createLog(stores);
  const first = await mustAppend(stores, owner, "first", NOW_MS, [], module);
  await mustAppend(stores, owner, "second", NOW_MS + 1000, [], module);
  const before = stores.head.value;
  const objectsBefore = stores.entries.objects.size;
  for (const [what, expectedHead] of [["an older head", first], ["genesis", GENESIS], ["a head that never was", ANOTHER_DIGEST]] as const) {
    const result = await appendTo(module, stores, owner, "stale", LATER, expectedHead);
    holds("a stale writer gets a typed conflict", !result.ok && result.refusal === "conflict", () => ({ what, result }));
    holds("a stale writer changes nothing, and leaves no object", stores.head.value === before && stores.entries.objects.size === objectsBefore, () => what);
  }
};

test("a stale page gets a typed conflict and changes nothing", async () => {
  await checkStaleWriter(productionLog);
});

test("removing the stale head check is caught", async () => {
  await assertCaughtBy("the stale head check", "a stale writer gets a typed conflict", () =>
    checkStaleWriter(logVariant({ find: 'if (head !== expectedHead)\n        return refuse("conflict");', replace: "" }))
  );
});

test("a command with no expected head is refused, never read as unconditional", async () => {
  const check = async (module: LogModule) => {
    for (const expectedHead of [undefined, null, [GENESIS]]) {
      const stores = memoryStores();
      await module.createLog(stores);
      const command = { caseId: CASE_A, actor: owner, events: [event("unchecked")], evidence: [], expectedHead, now: clock() } as unknown as AppendCommand;
      const result = await module.appendCommand(stores, command);
      holds("no expected head is no command", !result.ok && result.refusal === "conflict" && stores.head.value === GENESIS, () => ({ expectedHead, result }));
    }
  };
  await check(productionLog);
  // The shape M1's expectedHead took: optional, so leaving it out skipped the check.
  await assertCaughtBy("the required expected head", "no expected head is no command", () =>
    check(logVariant({ find: "if (head !== expectedHead)", replace: "if (expectedHead !== undefined && head !== expectedHead)" }))
  );
  await assertCaughtBy("the strict comparison with the expected head", "no expected head is no command", () =>
    check(logVariant({ find: "if (head !== expectedHead)", replace: "if (head != expectedHead)" }))
  );
});

const checkLostRace = async (module: LogModule) => {
  const stores = memoryStores();
  await module.createLog(stores);
  // A second writer lands between the first writer's check and its swap.
  const swap = stores.head.compareAndSwap.bind(stores.head);
  let interleaved = false;
  stores.head.compareAndSwap = async (expected, next) => {
    if (!interleaved) {
      interleaved = true;
      stores.head.value = sha256OfText("the other writer");
      stores.entries.objects.set(stores.head.value, encode("the other writer"));
    }
    return swap(expected, next);
  };
  const result = await appendTo(module, stores, runner, "loser", NOW_MS, GENESIS);
  holds("losing the swap is a conflict, not a success", !result.ok && result.refusal === "conflict", () => result);
  holds("losing the swap leaves the winner's head", stores.head.value === sha256OfText("the other writer"), () => stores.head.value);
};

test("a writer that loses the swap gets a conflict, and the winner's head stands", async () => {
  await checkLostRace(productionLog);
});

test("ignoring the swap's outcome is caught", async () => {
  await assertCaughtBy("the swap's outcome", "losing the swap is a conflict, not a success", () =>
    checkLostRace(logVariant({ find: 'if (!(await stores.head.compareAndSwap(head, digest)))\n        return refuse("conflict");', replace: "await stores.head.compareAndSwap(head, digest);" }))
  );
});

// Time.

const checkTimes = async (module: LogModule) => {
  const expiry = owner.exp * 1000;
  const atExpiry = memoryStores();
  await module.createLog(atExpiry);
  const late = await appendTo(module, atExpiry, owner, "late", expiry, GENESIS);
  holds("an owner's command at its token's expiry is refused", !late.ok && late.refusal === "actor-expired" && atExpiry.head.value === GENESIS && atExpiry.entries.objects.size === 0, () => late);
  const yearLate = await appendTo(module, atExpiry, owner, "late", expiry + 31_536_000_000, GENESIS);
  holds("an owner's command a year past its token is refused", !yearLate.ok && yearLate.refusal === "actor-expired", () => yearLate);
  const inTime = await appendTo(module, atExpiry, owner, "in-time", expiry - 1, GENESIS);
  holds("an owner's command a moment before expiry commits", inTime.ok, () => inTime);

  const runnerLate = memoryStores();
  await module.createLog(runnerLate);
  const runnerResult = await appendTo(module, runnerLate, runner, "runner", expiry + 31_536_000_000, GENESIS);
  holds("a runner has no token to outlast", runnerResult.ok, () => runnerResult);

  const backward = memoryStores();
  await module.createLog(backward);
  const first = await mustAppend(backward, runner, "first", NOW_MS, [], module);
  const stepBack = await appendTo(module, backward, runner, "back", NOW_MS - 1, first);
  holds("a command timed before its parent is refused and changes nothing", !stepBack.ok && stepBack.refusal === "time-went-backward" && backward.head.value === first && backward.entries.objects.size === 1, () => stepBack);
  const sameTime = await appendTo(module, backward, runner, "same", NOW_MS, first);
  holds("a command at its parent's time commits", sameTime.ok, () => sameTime);
};

test("an owner's command must fall inside its token, and time in a log only goes forward", async () => {
  await checkTimes(productionLog);
});

for (const [name, property, find, replace] of [
  ["the expiry rule on write", "an owner's command at its token's expiry is refused", 'if (isPastActorExpiry(entry))\n        return refuse("actor-expired");', ""],
  ["seconds compared with milliseconds", "an owner's command a moment before expiry commits", "entry.atMs >= entry.actor.exp * 1000", "entry.atMs >= entry.actor.exp"],
  ["the expiry rule for everyone", "a runner has no token to outlast", 'entry.actor.kind === "owner" && entry.atMs >= entry.actor.exp * 1000', "entry.atMs >= 1793538000000"],
  ["the time rule on write", "a command timed before its parent is refused and changes nothing", 'if (entries.length > 0 && entry.atMs < entries[entries.length - 1].entry.atMs)\n        return refuse("time-went-backward");', ""],
  ["equal times refused", "a command at its parent's time commits", "entry.atMs < entries[entries.length - 1].entry.atMs", "entry.atMs <= entries[entries.length - 1].entry.atMs"],
  ["comparing with the first entry", "a command at its parent's time commits", "entry.atMs < entries[entries.length - 1].entry.atMs", "entry.atMs <= entries[0].entry.atMs"]
] as const) {
  test(`a variant with ${name} is caught`, async () => {
    await assertCaughtBy(name, property, () => checkTimes(logVariant({ find, replace })));
  });
}

test("time is compared with the parent, not only the first entry", async () => {
  const check = async (module: LogModule) => {
    const stores = memoryStores();
    await module.createLog(stores);
    await mustAppend(stores, runner, "first", NOW_MS, [], module);
    const second = await mustAppend(stores, runner, "second", NOW_MS + 5000, [], module);
    const between = await appendTo(module, stores, runner, "between", NOW_MS + 2000, second);
    holds("a command timed between older entries is refused", !between.ok && between.refusal === "time-went-backward", () => between);
  };
  await check(productionLog);
  await assertCaughtBy("comparing with the first entry", "a command timed between older entries is refused", () =>
    check(logVariant({ find: "entry.atMs < entries[entries.length - 1].entry.atMs", replace: "entry.atMs < entries[0].entry.atMs" }))
  );
});

test("an equal time on read is allowed, and a backward one is caught at its own entry", async () => {
  const check = async (module: LogModule) => {
    const { outcome } = await craftedOutcome(module, ({ second }) => handEntryText({ ...CRAFTED_BASE, atMs: NOW_MS + 1000, prev: second, seq: 3 }));
    holds("an equal time on read opens", outcome === "opened", () => outcome);
  };
  await check(productionLog);
  await assertCaughtBy("equal times refused on read", "an equal time on read opens", () =>
    check(logVariant({ find: "entry.atMs > later.atMs", replace: "entry.atMs >= later.atMs" }))
  );
});

// Actors in commands.

const lookalikeActors = (): readonly (readonly [string, unknown])[] => [
  ["spelled out", { kind: "owner", iss: owner.iss, sub: owner.sub, email: owner.email, iat: owner.iat, exp: owner.exp }],
  ["spread from a real one", { ...owner }],
  ["parsed from a real one", JSON.parse(JSON.stringify(owner))],
  ["inheriting from a real one", Object.create(owner)],
  ["frozen like a real one", Object.freeze({ ...owner })],
  ["a runner spelled out", { kind: "system:runner", attemptId: ATTEMPT_ONE }],
  ["read back from an entry", JSON.parse(FIRST_ENTRY).actor],
  ["a name", "Mallory"],
  ["nothing", undefined],
  ["null", null]
];

const checkForgedActors = async (module: LogModule) => {
  const stores = memoryStores();
  await module.createLog(stores);
  for (const [how, actor] of lookalikeActors()) {
    const result = await module.appendCommand(stores, { caseId: CASE_A, actor: actor as Actor, events: [event("forged")], evidence: [], expectedHead: GENESIS, now: clock() });
    holds("a look-alike actor cannot write", !result.ok && result.refusal === "not-an-actor" && stores.head.value === GENESIS && stores.entries.objects.size === 0, () => ({ how, result }));
  }
};

test("an actor that was not derived cannot write, however closely it looks like one", async () => {
  await checkForgedActors(productionLog);
});

test("removing the derivation check is caught", async () => {
  await assertCaughtBy("the derivation check", "a look-alike actor cannot write", () =>
    checkForgedActors(logVariant({ find: 'if (!(0, actor_1.isDerivedActor)(actor))\n        return refuse("not-an-actor");', replace: "" }))
  );
});

const SMUGGLED_FIELDS = {
  actor: { kind: "owner", iss: "https://attacker.cloudflareaccess.com", sub: "mallory", email: "mallory@example.org", iat: 1, exp: 2 },
  name: "Mallory",
  typedName: "Mallory",
  by: "Mallory",
  email: "mallory@example.org",
  sub: "mallory",
  iss: "https://attacker.cloudflareaccess.com",
  kind: "owner",
  attemptId: "mallory"
};

const { actor: _dataOnlyActor, ...SMUGGLED_BESIDE_A_COMMAND } = SMUGGLED_FIELDS;

const checkSmuggling = async (module: LogModule) => {
  // Beside the command: not one byte differs from the same command without them.
  const stores = memoryStores();
  await module.createLog(stores);
  const beside = await module.appendCommand(stores, {
    caseId: CASE_A,
    actor: owner,
    events: [event("case-opened", { site: "example.org" })],
    evidence: [],
    expectedHead: GENESIS,
    now: clock(NOW_MS),
    ...SMUGGLED_BESIDE_A_COMMAND
  } as AppendCommand);
  holds("a name beside the command has no effect", beside.ok && beside.digest === FIRST_DIGEST && decode(stores.entries.objects.get(FIRST_DIGEST) as Uint8Array) === FIRST_ENTRY, () => beside);

  // Inside the event data: the data is kept as data, and the entry's actor does not move.
  const inData = memoryStores();
  await module.createLog(inData);
  const dataResult = await module.appendCommand(inData, { caseId: CASE_A, actor: runner, events: [event("capture-recorded", SMUGGLED_FIELDS)], evidence: [], expectedHead: GENESIS, now: clock() });
  holds("an actor in event data has no effect on the entry's actor", dataResult.ok && JSON.stringify(dataResult.entry.actor) === runnerActorText(ATTEMPT_ONE), () => dataResult);
  const reopened = await module.openLog(inData, CASE_A);
  holds("an actor in event data has no effect on reopening", reopened.ok && JSON.stringify(reopened.log.entries[0].entry.actor) === runnerActorText(ATTEMPT_ONE), () => reopened);
};

test("a name, or an actor field smuggled through event data, has no effect", async () => {
  await checkSmuggling(productionLog);
});

test("the smuggled data itself is untouched, so this is not passing by discarding it", async () => {
  const stores = memoryStores();
  await createLog(stores);
  const result = await appendCommand(stores, { caseId: CASE_A, actor: runner, events: [event("capture-recorded", SMUGGLED_FIELDS)], evidence: [], expectedHead: GENESIS, now: clock() });
  assert.deepEqual(result.ok && result.entry.events[0].data, SMUGGLED_FIELDS);
});

const COMPOSED_FIELDS = "{ v: ENTRY_VERSION, case: caseId, seq: entries.length + 1, prev: head, atMs: now(), actor, events, evidence }";
for (const [name, replace, property] of [
  ["an entry taking its actor from event data", "{ v: ENTRY_VERSION, case: caseId, seq: entries.length + 1, prev: head, atMs: now(), actor: events[0]?.data?.actor ?? actor, events, evidence }", "an actor in event data has no effect on the entry's actor"],
  ["an entry taking fields from the command as a whole", '{ ...Object.fromEntries(Object.entries(command).filter(([key]) => key !== "now" && key !== "expectedHead" && key !== "caseId")), v: ENTRY_VERSION, case: caseId, seq: entries.length + 1, prev: head, atMs: now(), actor, events, evidence }', "a name beside the command has no effect"],
  ["an actor taking a name from the command", "{ v: ENTRY_VERSION, case: caseId, seq: entries.length + 1, prev: head, atMs: now(), actor: command.name ? { ...actor, name: command.name } : actor, events, evidence }", "a name beside the command has no effect"]
] as const) {
  test(`a variant with ${name} is caught`, async () => {
    await assertCaughtBy(name, property, () => checkSmuggling(logVariant({ find: COMPOSED_FIELDS, replace })));
  });
}

// What a command may hold.

const GOOD_EVENT = { type: "fine", data: {} };
const MALFORMED_COMMANDS: readonly (readonly [string, readonly unknown[], readonly unknown[]])[] = [
  ["no events", [], []],
  ["an event with a malformed type", [{ type: "Not A Type", data: {} }], []],
  ["an event with an extra field", [{ type: "fine", data: {}, actor: "Mallory" }], []],
  ["an event whose data is a list", [{ type: "fine", data: [] }], []],
  ["an event with no data", [{ type: "fine" }], []],
  ["data with no spelling", [{ type: "fine", data: { n: 1.5 } }], []],
  ["data with undefined", [{ type: "fine", data: { n: undefined } }], []],
  ["data with a date", [{ type: "fine", data: { n: new Date(0) } }], []],
  ["events that are not a list", "not a list" as unknown as readonly unknown[], []],
  ["a malformed second event", [GOOD_EVENT, { type: "Not A Type", data: {} }], []],
  ["a malformed first event", [{ type: "Not A Type", data: {} }, GOOD_EVENT], []],
  ["a second event with no data", [GOOD_EVENT, { type: "fine" }], []],
  ["evidence that is not a digest", [GOOD_EVENT], ["abc"]],
  ["a malformed second digest", [GOOD_EVENT], [FIRST_EVIDENCE_DIGEST, "abc"]],
  ["a malformed first digest", [GOOD_EVENT], ["abc", FIRST_EVIDENCE_DIGEST]],
  ["evidence that is not a list", [GOOD_EVENT], "not a list" as unknown as readonly unknown[]]
];

const checkMalformedCommands = async (module: LogModule) => {
  for (const [name, events, evidence] of MALFORMED_COMMANDS) {
    const stores = memoryStores();
    await module.createLog(stores);
    let result: unknown;
    try {
      result = await module.appendCommand(stores, { caseId: CASE_A, actor: runner, events: events as readonly LogEvent[], evidence: evidence as readonly string[], expectedHead: GENESIS, now: clock() });
    } catch (error) {
      result = error;
    }
    const refused = (result as { refusal?: string }).refusal === "malformed-command";
    holds("a malformed command is refused and changes nothing", refused && stores.head.value === GENESIS && stores.entries.objects.size === 0, () => ({ name, result }));
    const opened = await module.openLog(stores, CASE_A);
    holds("a malformed command leaves the log able to open", opened.ok, () => name);
  }
};

test("a malformed command is refused before anything is written, so it cannot brick its log", async () => {
  await checkMalformedCommands(productionLog);
  const stores = memoryStores();
  await createLog(stores);
  const badClock = await appendCommand(stores, { caseId: CASE_A, actor: runner, events: [event("fine")], evidence: [], expectedHead: GENESIS, now: () => 1.5 });
  assert.equal(!badClock.ok && badClock.refusal, "malformed-command");
});

test("removing the check of what is about to be written is caught", async () => {
  await assertCaughtBy("the write check", "a malformed command is refused and changes nothing", () =>
    checkMalformedCommands(logVariant({ find: 'if (!isLogEntry(entry))\n        return refuse("malformed-command");', replace: "" }))
  );
});

// Evidence a command names, and objects found already there.

const checkNamedEvidence = async (module: LogModule) => {
  const stores = memoryStores();
  await module.createLog(stores);
  const missing = await appendTo(module, stores, runner, "fine", NOW_MS, GENESIS, [FIRST_EVIDENCE_DIGEST]);
  holds("a command naming missing evidence is refused", !missing.ok && missing.refusal === "evidence-missing" && missing.at === FIRST_EVIDENCE_DIGEST && stores.head.value === GENESIS && stores.entries.objects.size === 0, () => missing);
  await module.putEvidence(stores, encode("first evidence"));
  const secondMissing = await appendTo(module, stores, runner, "fine", NOW_MS, GENESIS, [FIRST_EVIDENCE_DIGEST, SECOND_EVIDENCE_DIGEST]);
  holds("a second named object that is missing is refused, so the command cannot brick the log", !secondMissing.ok && secondMissing.refusal === "evidence-missing" && secondMissing.at === SECOND_EVIDENCE_DIGEST && stores.head.value === GENESIS && stores.entries.objects.size === 0, () => secondMissing);
  stores.evidence.objects.set(SECOND_EVIDENCE_DIGEST, encode("not the second evidence"));
  const secondChanged = await appendTo(module, stores, runner, "fine", NOW_MS, GENESIS, [FIRST_EVIDENCE_DIGEST, SECOND_EVIDENCE_DIGEST]);
  holds("a second named object that changed is refused", !secondChanged.ok && secondChanged.refusal === "evidence-changed" && secondChanged.at === SECOND_EVIDENCE_DIGEST && stores.head.value === GENESIS && stores.entries.objects.size === 0, () => secondChanged);
};

test("a command naming evidence that is missing or changed is refused and writes nothing, at every position", async () => {
  await checkNamedEvidence(productionLog);
});

test("the check on named evidence is what stops them", async () => {
  await assertCaughtBy("the check on named evidence", "a command naming missing evidence is refused", () =>
    checkNamedEvidence(logVariant({ find: "for (const digest of entry.evidence) {\n        const refusal = await checkEvidence(stores, digest);\n        if (refusal !== null)\n            return refusal;\n    }\n    const digest = await", replace: "const digest = await" }))
  );
  await assertCaughtBy("checking only the first named object", "a second named object that is missing is refused, so the command cannot brick the log", () =>
    checkNamedEvidence(logVariant({ find: "for (const digest of entry.evidence) {\n        const refusal", replace: "for (const digest of entry.evidence.slice(0, 1)) {\n        const refusal" }))
  );
});

const differingAt = (text: string, index: number): Uint8Array => {
  const bytes = encode(text);
  bytes[index] = bytes[index] === 0x2e ? 0x2f : 0x2e;
  return bytes;
};

const checkCollisions = async (module: LogModule) => {
  // Something else is already at the address this entry will have, as a torn orphan or a tamper would leave.
  const entryBytes = encode(FIRST_ENTRY);
  for (const [what, there] of [
    ["torn", entryBytes.slice(0, 40)],
    ["one byte different at its start", differingAt(FIRST_ENTRY, 0)],
    ["one byte different at its end", differingAt(FIRST_ENTRY, entryBytes.length - 1)],
    ["longer", encode(`${FIRST_ENTRY} `)]
  ] as const) {
    const stores = memoryStores();
    await module.createLog(stores);
    stores.entries.objects.set(FIRST_DIGEST, new Uint8Array(there));
    const entry = await module.appendCommand(stores, { caseId: CASE_A, actor: owner, events: [event("case-opened", { site: "example.org" })], evidence: [], expectedHead: GENESIS, now: clock(NOW_MS) });
    holds("an entry address holding other bytes is refused, and the head does not move to it", !entry.ok && entry.refusal === "object-collision" && entry.at === FIRST_DIGEST && stores.head.value === GENESIS, () => ({ what, entry }));
  }

  for (const [what, there] of [
    ["other", encode("something else")],
    ["one byte different at its start", differingAt("first evidence", 0)],
    ["one byte different at its end", differingAt("first evidence", 13)]
  ] as const) {
    const evidence = memoryStores();
    evidence.evidence.objects.set(FIRST_EVIDENCE_DIGEST, new Uint8Array(there));
    const put = await module.putEvidence(evidence, encode("first evidence"));
    holds("an evidence address holding other bytes is refused", !put.ok && put.refusal === "object-collision" && put.at === FIRST_EVIDENCE_DIGEST, () => ({ what, put }));
  }

  // A store that says an address is taken and then shows nothing there has not stored this.
  const vanishing = memoryStores();
  await module.createLog(vanishing);
  vanishing.entries.createOnly = async () => "exists";
  const gone = await appendTo(module, vanishing, owner, "case-opened", NOW_MS, GENESIS);
  holds("an address that reads back as nothing is refused", !gone.ok && gone.refusal === "object-collision" && vanishing.head.value === GENESIS, () => gone);
};

test("an address already holding other bytes is refused, and never overwritten", async () => {
  await checkCollisions(productionLog);
});

test("removing the read-back, or what it compares, is caught", async () => {
  await assertCaughtBy("the read-back", "an entry address holding other bytes is refused, and the head does not move to it", () =>
    checkCollisions(logVariant({ find: "const there = await readOwn(store, digest, bytes.length);\n    return there instanceof Uint8Array && (0, canonical_json_1.bytesEqual)(there, bytes);", replace: "return true;" }))
  );
  await assertCaughtBy("the empty read-back", "an address that reads back as nothing is refused", () =>
    checkCollisions(logVariant({ find: "return there instanceof Uint8Array && (0, canonical_json_1.bytesEqual)(there, bytes);", replace: "return there === null || (0, canonical_json_1.bytesEqual)(there, bytes);" }))
  );
  await assertCaughtBy("the address on an entry's collision", "an entry address holding other bytes is refused, and the head does not move to it", () =>
    checkCollisions(logVariant({ find: 'if (!(await createVerified(stores.entries, digest, bytes)))\n        return refuse("object-collision", digest);', replace: 'if (!(await createVerified(stores.entries, digest, bytes)))\n        return refuse("object-collision");' }))
  );
  await assertCaughtBy("the address on evidence's collision", "an evidence address holding other bytes is refused", () =>
    checkCollisions(logVariant({ find: 'if (!(await createVerified(stores.evidence, digest, own)))\n        return refuse("object-collision", digest);', replace: 'if (!(await createVerified(stores.evidence, digest, own)))\n        return refuse("object-collision");' }))
  );
});

test("the same bytes already at an address are a retry and go through", async () => {
  const stores = memoryStores();
  await createLog(stores);
  stores.entries.objects.set(FIRST_DIGEST, encode(FIRST_ENTRY));
  const result = await appendCommand(stores, { caseId: CASE_A, actor: owner, events: [event("case-opened", { site: "example.org" })], evidence: [], expectedHead: GENESIS, now: clock(NOW_MS) });
  assert.equal(result.ok && result.digest, FIRST_DIGEST);
  assert.equal(stores.head.value, FIRST_DIGEST);
});

test("a caller changing its buffer after handing it over changes nothing stored", async () => {
  const check = async (module: LogModule) => {
    const stores = memoryStores();
    const buffer = encode("first evidence");
    const pending = module.putEvidence(stores, buffer);
    // The call has hashed nothing yet, or has hashed and not yet stored: both are behind an await.
    buffer.fill(0);
    const put = await pending;
    holds("the object is stored at the digest of the bytes it was given", put.ok && put.digest === FIRST_EVIDENCE_DIGEST, () => put);
    const stored = stores.evidence.objects.get(FIRST_EVIDENCE_DIGEST);
    holds("the bytes stored are the bytes that were hashed", stored !== undefined && decode(stored) === "first evidence", () => stored);
  };
  await check(productionLog);
  await assertCaughtBy("the copy", "the bytes stored are the bytes that were hashed", () =>
    check(logVariant({ find: "const own = new Uint8Array(bytes);", replace: "const own = bytes;" }))
  );
});

// What is not detected, pinned so the docblock cannot drift from what the code does.

type Rewrite = Readonly<{ name: string; apply: (stores: MemoryStores, seeded: Seeded) => Promise<void> }>;

/** Each is a rewrite by someone holding the Cloudflare account. All of them open clean. Only a saved head can tell. */
const REWRITES: readonly Rewrite[] = [
  {
    name: "the head moved back one entry",
    apply: async (stores, { digests }) => {
      stores.head.value = digests[1];
    }
  },
  {
    name: "the head moved back to genesis",
    apply: async (stores) => {
      stores.head.value = GENESIS;
    }
  },
  {
    name: "the newest entry replaced, and the head moved to it",
    apply: async (stores, { digests }) => {
      await headAtCrafted(stores, handEntryText({ ...CRAFTED_BASE, atMs: NOW_MS + 2000, prev: digests[1], seq: 3 }));
    }
  },
  {
    name: "the head moved to an orphan a lost race left, forking off the entry before",
    apply: async (stores, { digests }) => {
      // Written the way a losing writer writes one, chained from the older head.
      await headAtCrafted(stores, handEntryText({ ...CRAFTED_BASE, actorText: OWNER_ACTOR_TEXT, atMs: NOW_MS + 1500, prev: digests[0], seq: 2 }));
    }
  },
  {
    name: "another case's events copied into new entries naming this case",
    apply: async (stores) => {
      await headAtCrafted(stores, handEntryText({ ...CRAFTED_BASE, eventsText: eventsTextOf("from-another-case"), atMs: NOW_MS, prev: GENESIS, seq: 1 }));
    }
  },
  {
    name: "the whole log rewritten from genesis",
    apply: async (stores) => {
      const first = await headAtCrafted(stores, handEntryText({ ...CRAFTED_BASE, prev: GENESIS, seq: 1 }));
      await headAtCrafted(stores, handEntryText({ ...CRAFTED_BASE, prev: first, seq: 2 }));
    }
  }
];

for (const { name, apply } of REWRITES) {
  test(`stated limit: ${name} opens clean, and only a saved head refuses it`, async () => {
    const stores = memoryStores();
    const seeded = await seed(stores);
    const saved = stores.head.value;
    assert.deepEqual(await verifyAgainstSavedHead(stores, CASE_A, saved), { ok: true });
    await apply(stores, seeded);
    const opened = await openLog(stores, CASE_A);
    assert.ok(opened.ok, "if this ever fails, the docblock's list of what is not detected is out of date");
    assert.deepEqual(await verifyAgainstSavedHead(stores, CASE_A, saved), { ok: false, refusal: "saved-head-not-on-chain", at: null });
  });
}

test("stated limit: two cases given one id in a shared store can be spliced by a head write, and only a saved head refuses it", async () => {
  const [one, other] = sharingStores();
  await createLog(one);
  await createLog(other);
  const first = await mustAppend(one, runner, "from-the-first-case", NOW_MS);
  const own = await mustAppend(other, runner, "from-the-second-case", NOW_MS);
  other.head.value = first;
  const opened = await openLog(other, CASE_A);
  assert.ok(opened.ok, "if this ever fails, the docblock's note on unique ids is out of date");
  assert.deepEqual(await verifyAgainstSavedHead(other, CASE_A, own), { ok: false, refusal: "saved-head-not-on-chain", at: null });
});

const checkSavedHead = async (module: LogModule) => {
  const stores = memoryStores();
  const { digests } = await seed(stores, module);
  for (const saved of [...digests, GENESIS]) {
    const verdict = await module.verifyAgainstSavedHead(stores, CASE_A, saved);
    holds("every head the log passed through is accepted", verdict.ok, () => ({ saved, verdict }));
  }
  // Grown past the saved head, it still passes through it.
  await mustAppend(stores, runner, "later", LATER, [], module);
  const grown = await module.verifyAgainstSavedHead(stores, CASE_A, digests[2]);
  holds("a log grown past a saved head still passes through it", grown.ok, () => grown);
  // A head from some other log entirely, and values that are no head at all.
  const unrelated = await module.verifyAgainstSavedHead(stores, CASE_A, ANOTHER_DIGEST);
  holds("a head the log never passed through is refused", !unrelated.ok && unrelated.refusal === "saved-head-not-on-chain", () => unrelated);
  for (const saved of [undefined, null, "", "abc", digests[2].toUpperCase(), `${digests[2]}\n`, 7, { head: digests[2] }]) {
    const verdict = await module.verifyAgainstSavedHead(stores, CASE_A, saved);
    holds("a saved value that is no head is refused as malformed", !verdict.ok && verdict.refusal === "saved-head-malformed", () => saved);
  }
  // A log rolled back before the saved head is refused.
  const shorter = memoryStores();
  await module.createLog(shorter);
  const rolledBack = await module.verifyAgainstSavedHead(shorter, CASE_A, digests[0]);
  holds("a log rolled back before a saved head is refused", !rolledBack.ok && rolledBack.refusal === "saved-head-not-on-chain", () => rolledBack);
  // Under another case's name, the same log is not this log.
  const otherCase = await module.verifyAgainstSavedHead(stores, CASE_B, digests[0]);
  holds("a log is checked as the case it is asked about", !otherCase.ok && otherCase.refusal === "wrong-case", () => otherCase);
};

test("a saved head is checked against the chain, by digest", async () => {
  await checkSavedHead(productionLog);
});

test("the saved head check's variants are caught", async () => {
  await assertCaughtBy("the digest comparison", "a head the log never passed through is refused", () =>
    checkSavedHead(logVariant({ find: 'opened.log.entries.some(({ digest }) => digest === savedHead) ? { ok: true } : refuse("saved-head-not-on-chain")', replace: "{ ok: true }" }))
  );
  await assertCaughtBy("comparing only with the newest head", "every head the log passed through is accepted", () =>
    checkSavedHead(logVariant({ find: "opened.log.entries.some(({ digest }) => digest === savedHead)", replace: "opened.log.head === savedHead" }))
  );
  await assertCaughtBy("the shape check", "a saved value that is no head is refused as malformed", () =>
    checkSavedHead(logVariant({ find: 'if (!isDigest(savedHead))\n        return refuse("saved-head-malformed");', replace: "" }))
  );
  await assertCaughtBy("the genesis rule", "every head the log passed through is accepted", () =>
    checkSavedHead(logVariant({ find: "if (savedHead === exports.GENESIS_HEAD)\n        return { ok: true };", replace: "" }))
  );
});

/** The stores this function is handed, with something other than the truth behind each address. */
const checkSavedHeadDoesItsOwnHashing = async (module: LogModule) => {
  const stores = memoryStores();
  const { digests, evidence } = await seed(stores, module);
  const saved = digests[2];

  // Forged bytes under the saved digest's label: this is the log a forger would hand over.
  const forged = memoryStores();
  forged.head.value = saved;
  forged.entries.objects.set(saved, encode(handEntryText({ ...CRAFTED_BASE, eventsText: eventsTextOf("forged"), prev: GENESIS, seq: 1 })));
  const labelled = await module.verifyAgainstSavedHead(forged, CASE_A, saved);
  holds("a digest label over forged bytes is refused, because the bytes are hashed", !labelled.ok && labelled.refusal === "entry-edited" && labelled.at === saved, () => labelled);

  // The chain is sound and an older entry under the saved head is not.
  stores.entries.objects.set(digests[0], encode("edited"));
  const older = await module.verifyAgainstSavedHead(stores, CASE_A, saved);
  holds("an entry edited behind the saved head is refused", !older.ok && older.refusal === "entry-edited" && older.at === digests[0], () => older);

  // Evidence the saved log named is held to the same check.
  const withEvidence = memoryStores();
  const again = await seed(withEvidence, module);
  withEvidence.evidence.objects.set(again.evidence[1], encode("changed"));
  const changed = await module.verifyAgainstSavedHead(withEvidence, CASE_A, again.digests[2]);
  holds("evidence changed behind the saved head is refused", !changed.ok && changed.refusal === "evidence-changed" && changed.at === evidence[1], () => changed);
};

test("nothing is taken on trust: labels, older entries and evidence are all read and hashed again", async () => {
  await checkSavedHeadDoesItsOwnHashing(productionLog);
});

test("the saved head check that walks less is caught", async () => {
  await assertCaughtBy("checking the head alone", "a digest label over forged bytes is refused, because the bytes are hashed", () =>
    checkSavedHeadDoesItsOwnHashing(logVariant({ find: "const opened = await openLog(stores, caseId);\n    if (!opened.ok)\n        return opened;", replace: "const head = await stores.head.read(64);\n    const opened = { log: { head, entries: [{ digest: head }] } };" }))
  );
  await assertCaughtBy("walking without the evidence", "evidence changed behind the saved head is refused", () =>
    checkSavedHeadDoesItsOwnHashing(logVariant({ find: "const opened = await openLog(stores, caseId);\n    if (!opened.ok)\n        return opened;", replace: "const opened = await walkChain(stores, caseId);\n    if (!opened.ok)\n        return opened;" }))
  );
});

test("the shape the check used to take, a list of digest labels, is not accepted", async () => {
  const forged = { head: ANOTHER_DIGEST, entries: [{ digest: ANOTHER_DIGEST, entry: { forged: true } }] };
  await assert.rejects(() => verifyAgainstSavedHead(forged as unknown as LogStores, CASE_A, ANOTHER_DIGEST));
});

test("a backend's fresh log has no head until it is created", async () => {
  for (const backend of [MEMORY_BACKEND, FILESYSTEM_BACKEND] as readonly Backend[]) {
    const { stores, dispose } = backend.fresh();
    try {
      assert.deepEqual(await openLog(stores, CASE_A), { ok: false, refusal: "head-missing", at: null }, backend.name);
      assert.deepEqual(await appendTo(productionLog, stores, runner, "early", NOW_MS, GENESIS), { ok: false, refusal: "head-missing", at: null }, backend.name);
      assert.deepEqual(await createLog(stores), { ok: true }, backend.name);
      assert.deepEqual(await createLog(stores), { ok: false, refusal: "log-exists", at: null }, backend.name);
      assert.deepEqual(await openLog(stores, CASE_A), { ok: true, log: { head: GENESIS, entries: [] } }, backend.name);
    } finally {
      dispose();
    }
  }
});
