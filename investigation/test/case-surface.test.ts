import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { before, test } from "node:test";
import { assertCaughtBy, holds, loadVariant, type SourceEdit } from "../../lib/finite-check";
import type { Actor } from "../core/actor";
import * as aggregates from "../core/aggregates";
import { aggregate, evidenceForAttempt } from "../core/aggregates";
import * as canonicalJson from "../core/canonical-json";
import * as caseEvents from "../core/case-events";
import * as caseLog from "../core/case-log";
import { EVENT_TYPES } from "../core/case-events";
import * as machine from "../core/case-machine";
import { continuationOf, denominatorOf, retentionOf } from "../core/case-machine";
import * as store from "../core/case-store";
import { aggregateRowsOfCase, type CaseState, type OpenCase } from "../core/case-store";
import * as evidence from "../core/evidence-model";
import { readRow, sourceIdentityOf } from "../core/evidence-model";
import * as ids from "../core/ids";
import * as purge from "../core/purge";
import * as readings from "../core/readings";
import * as summaryTier from "../core/summary-tier";
import { projectAttemptSummary } from "../core/summary-tier";
import { actorsFor, ATTEMPT_IDS, CANARIES, CASE_SCRIPT, logEvent, RETRACT_ASSERTION_COMMAND, risingClock, runScript, SUPERSEDE_COMMAND, type ScriptCommand } from "./case-fixture";
import { CASE_A, verifiedOwnerActor } from "./log-fixture";
import { memoryStores, type MemoryStores } from "./memory-log-store";
import { NOW_MS } from "./token-fixture";

/**
 * What W2's code offers and what it leaves out. There is no approve route, public claim or
 * export, by the owner's ruling, so each new module's exports are written out here: a new one
 * has to be added on purpose, and none may be named for publishing. The owner's own wording
 * is planted with a marker and looked for in everything a reader function hands back. It stays
 * in the record that holds it, and goes nowhere else.
 *
 * And the code names no real site. M1 did, and this port must not.
 */

const ROOT = process.cwd();
const CORE = "investigation/core";
const TEST = "investigation/test";

const EXPORTS: Readonly<Record<string, readonly string[]>> = {
  "aggregates.ts": ["SPLIT_KEYS", "aggregate", "aggregateRowsOf", "evidenceForAttempt"],
  "canonical-json.ts": ["MAX_CANONICAL_DEPTH", "bytesEqual", "canonicalBytes", "hasExactly", "parseCanonical", "sha256Hex"],
  "case-log.ts": ["GENESIS_HEAD", "MAX_ENTRY_BYTES", "MAX_EVIDENCE_BYTES", "MAX_HEAD_CHARS", "appendCommand", "checkFirstEntry", "createLog", "isCaseId", "isDigest", "openLog", "putEvidence", "verifyAgainstSavedHead"],
  "case-events.ts": ["EVENT_TYPES", "configurationKey", "decodeEvent", "digestsNamed", "isConfigurationIdentity"],
  "case-machine.ts": ["MAX_CONFIGURATION_CHANGES", "MAX_CONTROL_MISSES", "MAX_START_RETRIES", "OUTCOMES", "SLOT_NAMES", "continuationOf", "denominatorOf", "isCleanupUnresolved", "isOutcome", "isRunningPhase", "isTerminal", "plannedState", "retentionOf", "step", "visitBasisOf"],
  "case-store.ts": ["aggregateRowsOfCase", "createCase", "mintedSlots", "openCase", "runCommand"],
  "evidence-model.ts": ["EMPTY_RECORD", "UNREAD_STATES", "addRow", "applyRecordEvent", "readRow", "sourceIdentityOf"],
  "ids.ts": ["mintAttemptId", "mintCaseId"],
  "purge.ts": ["purgeStep", "retentionTier"],
  "readings.ts": ["COMPLETENESS_LIMITS", "MAX_TIME_MS", "MAX_UNCERTAINTY_MS", "orderOf", "readExecutionJoin", "readObservation", "stackToScriptPosition"],
  "summary-tier.ts": ["isAttemptSummary", "projectAttemptSummary"]
};

const MODULES: Readonly<Record<string, object>> = {
  "aggregates.ts": aggregates,
  "canonical-json.ts": canonicalJson,
  "case-log.ts": caseLog,
  "case-events.ts": caseEvents,
  "case-machine.ts": machine,
  "case-store.ts": store,
  "evidence-model.ts": evidence,
  "ids.ts": ids,
  "purge.ts": purge,
  "readings.ts": readings,
  "summary-tier.ts": summaryTier
};

const PUBLISHING = /approv|publish|public|export|claim_?text|press|announce/i;

const NO_PUBLIC = "no function here produces text for anyone but the owner";

const checkSurface = (modules: Readonly<Record<string, object>>) => {
  for (const [file, expected] of Object.entries(EXPORTS)) {
    const names = Object.keys(modules[file]).filter((name) => name !== "__esModule").sort();
    holds(NO_PUBLIC, JSON.stringify(names) === JSON.stringify([...expected].sort()), () => ({ file, names }));
    for (const name of names) holds(NO_PUBLIC, !PUBLISHING.test(name), () => ({ file, name }));
  }
};

test("each new module's exports are these, and none is named for publishing", async () => {
  checkSurface(MODULES);
  const planted = (file: string, edit: SourceEdit, from: string) => ({ ...MODULES, [file]: loadVariant<object>(require.resolve(`../core/${from}`), [edit]) });
  await assertCaughtBy("an added export naming no purpose", NO_PUBLIC, () =>
    checkSurface(planted("evidence-model.ts", { find: 'Object.defineProperty(exports, "__esModule", { value: true });', replace: 'Object.defineProperty(exports, "__esModule", { value: true }); exports.textForReaders = (record) => record.facts.map(({ statement }) => statement).join();' }, "evidence-model"))
  );
  await assertCaughtBy("a new export from the log, naming a reader", NO_PUBLIC, () =>
    checkSurface(planted("case-log.ts", { find: 'Object.defineProperty(exports, "__esModule", { value: true });', replace: 'Object.defineProperty(exports, "__esModule", { value: true }); exports.textForReaders = (entry) => JSON.stringify(entry.events);' }, "case-log"))
  );
  await assertCaughtBy("a new export from the bytes, naming a reader", NO_PUBLIC, () =>
    checkSurface(planted("canonical-json.ts", { find: 'Object.defineProperty(exports, "__esModule", { value: true });', replace: 'Object.defineProperty(exports, "__esModule", { value: true }); exports.textOf = (bytes) => new TextDecoder().decode(bytes);' }, "canonical-json"))
  );
  await assertCaughtBy("a claim approver", NO_PUBLIC, () =>
    checkSurface(planted("case-store.ts", { find: 'Object.defineProperty(exports, "__esModule", { value: true });', replace: 'Object.defineProperty(exports, "__esModule", { value: true }); exports.approveClaim = () => null;' }, "case-store"))
  );
});

test("every core module is listed, so a new one cannot arrive unseen", () => {
  const listed = new Set(Object.keys(EXPORTS));
  // W0's and W1's modules are held by their own suites.
  const earlier = ["access-token.ts", "actor.ts", "workspace-config.ts", "workspace-gate.ts"];
  const present = readdirSync(path.join(ROOT, CORE)).filter((file) => file.endsWith(".ts")).sort();
  assert.deepEqual(present, [...listed, ...earlier].sort());
});

test("no event type, no state key and no output field is about publishing", async () => {
  assert.equal(EVENT_TYPES.length, 33);
  for (const type of EVENT_TYPES) assert.doesNotMatch(type, PUBLISHING, type);
  const owner = await verifiedOwnerActor();
  const stores = memoryStores();
  const marks = await runScript({ stores, caseId: CASE_A, actorOf: actorsFor(owner), now: risingClock(NOW_MS + 1000), commands: CASE_SCRIPT });
  const seen: string[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (typeof value === "object" && value !== null) {
      for (const [key, inner] of Object.entries(value)) {
        seen.push(key);
        walk(inner);
      }
    }
  };
  walk(marks.last.state);
  assert.equal(seen.length, STATE_KEYS, "the walk reached the whole state");
  for (const key of seen) assert.doesNotMatch(key, PUBLISHING, key);
  // The event the owner ruled out is refused where it would arrive.
  const answer = await store.runCommand(stores, marks.last, { actor: owner, event: logEvent("claim-approved", { claim: "one", text: "Words." }), now: risingClock(NOW_MS + 900_000) });
  assert.deepEqual(answer, { ok: false, refusal: "unknown-event-type", at: "type" });
});

const STATE_KEYS = 325;

const MARKER = "OWNER-WORDING-MARKER-2f6e";

const OWNER_TEXT = "the owner's wording reaches no reader function's result";

let owner: Actor;
let stores: MemoryStores;
let closed: OpenCase;
const markedStores = memoryStores();
/** The same case, then with a supersede, an assertion retracted and a fact retracted, so a reason of each kind is in the record. */
let corrected: OpenCase;

before(async () => {
  owner = await verifiedOwnerActor();
  stores = memoryStores();
  // Everywhere the owner writes words: a claim's statement, every field of an unknown, and the reason an exception, a supersede and a retraction give.
  const withMarker = (text: unknown) => `${String(text)} ${MARKER}`;
  const markedUnknown = (unknown: Readonly<Record<string, unknown>>) => ({ ...unknown, question: withMarker(unknown.question), reason: withMarker(unknown.reason), detail: withMarker(unknown.detail), wouldResolve: withMarker(unknown.wouldResolve) });
  const marking = (command: ScriptCommand): ScriptCommand => {
    const { event } = command;
    const data = event.data as Readonly<Record<string, unknown>>;
    switch (event.type) {
      case "fact-recorded":
      case "assertion-recorded":
      case "interpretation-recorded":
        return { ...command, event: logEvent(event.type, { ...data, statement: withMarker(data.statement) } as never) };
      case "exception-recorded":
        return { ...command, event: logEvent(event.type, { ...data, reason: withMarker(data.reason) } as never) };
      case "unknown-recorded":
        return { ...command, event: logEvent(event.type, { unknown: markedUnknown(data.unknown as Readonly<Record<string, unknown>>) } as never) };
      case "fact-superseded":
        return { ...command, event: logEvent(event.type, { ...data, statement: withMarker(data.statement), reason: withMarker(data.reason) } as never) };
      case "assertion-retracted":
        return { ...command, event: logEvent(event.type, { ...data, reason: withMarker(data.reason), unknown: markedUnknown(data.unknown as Readonly<Record<string, unknown>>) } as never) };
      default:
        return command;
    }
  };
  const retractOne: ScriptCommand = { as: "owner", event: logEvent("fact-retracted", { fact: "fact-lantern-ran", reason: "Read too much into the window.", unknown: { id: "unknown-window", question: "What did the window show?", reason: "Only that a range ran.", detail: "It was one frame.", wouldResolve: "A second window." } }) };
  const marks = await runScript({ stores, caseId: CASE_A, actorOf: actorsFor(owner), now: risingClock(NOW_MS + 1000), commands: CASE_SCRIPT.map(marking) });
  closed = marks.last;
  const later = await runScript({ stores: markedStores, caseId: CASE_A, actorOf: actorsFor(owner), now: risingClock(NOW_MS + 1000), commands: [...CASE_SCRIPT, SUPERSEDE_COMMAND, RETRACT_ASSERTION_COMMAND].map(marking).concat({ ...retractOne, event: logEvent("fact-retracted", { fact: "fact-lantern-ran", reason: withMarker("Read too much into the window."), unknown: markedUnknown(retractOne.event.data.unknown as never) } as never) }) });
  corrected = later.last;
});

/** What each reader function gives back on a whole case, by name, with the wording to find planted. */
async function everyReaderResult(modules: Readonly<{ readRow: typeof readRow; projectAttemptSummary: typeof projectAttemptSummary; evidenceForAttempt: typeof evidenceForAttempt }>, opened: OpenCase = corrected): Promise<readonly (readonly [string, unknown])[]> {
  const state = opened.state as CaseState;
  const rows = aggregateRowsOfCase(state);
  const measure = { id: "measure-one", subject: "subject-lantern", population: null, keys: { heldEqual: ["release", "commit", "configuration"], allowedToVary: [{ key: "arm", reason: "Both." }], unknown: [] } };
  return [
    ["denominatorOf", denominatorOf(state.machine)],
    ["continuationOf", continuationOf(state.machine)],
    ["retentionOf", retentionOf(state.machine)],
    ["aggregateRowsOfCase", rows],
    ["aggregate", aggregate(rows, measure)],
    ...state.machine.attempts.map(({ slot }) => [`evidenceForAttempt ${slot}`, modules.evidenceForAttempt(state.machine, state.record, [slot])] as const),
    ["readRow", state.record.rows.map((row) => modules.readRow(state.record, state.machine, row))],
    ["sourceIdentityOf", state.machine.attempts.map(({ slot }) => sourceIdentityOf(state.record, slot))],
    ["projectAttemptSummary", await modules.projectAttemptSummary({ attemptId: ATTEMPT_IDS.B1, slot: "B1", arm: "baseline", phase: "usable" }, { scripts: [{ url: "https://orchard-lane.example/lantern.js", text: "lantern();", ranges: [{ startOffset: 0, endOffset: 10, count: 1 }] }], requests: [{ url: "https://orchard-lane.example/" }], storage: [{ key: "lantern-state", value: "lit" }], console: [{ text: "lantern ran" }] })]
  ];
}

const checkOwnerText = async (modules: Parameters<typeof everyReaderResult>[0]) => {
  for (const [name, result] of await everyReaderResult(modules)) {
    holds(OWNER_TEXT, !JSON.stringify(result).includes(MARKER), () => name);
  }
};

test("the owner's wording stays in the record that holds it, and reaches no reader function", async () => {
  // It is really in each place it could come from: a statement of each kind, every field of an unknown, each kind of reason.
  const { record } = corrected.state as CaseState;
  assert.ok(record.facts.some(({ statement }) => statement.includes(MARKER)), "a fact's statement");
  assert.ok(record.facts.some(({ history }) => history.some(({ reason }) => reason.includes(MARKER))), "a supersede's reason");
  assert.ok(record.facts.some(({ retraction }) => retraction?.reason.includes(MARKER)), "a fact retraction's reason");
  assert.ok(record.assertions.some(({ statement }) => statement.includes(MARKER)), "an assertion's statement");
  assert.ok(record.assertions.some(({ retraction }) => retraction?.reason.includes(MARKER)), "an assertion retraction's reason");
  assert.ok(record.interpretations.some(({ statement }) => statement.includes(MARKER)), "an interpretation's statement");
  for (const { id, question, reason, detail, wouldResolve } of record.unknowns) {
    assert.ok(question.includes(MARKER) && reason.includes(MARKER) && detail?.includes(MARKER) && wouldResolve?.includes(MARKER), id);
  }
  assert.equal(record.unknowns.length, 3);
  // An exception's reason goes to the log and nowhere else, so that is where to find it.
  const entries = [...markedStores.entries.objects.values()].map((bytes) => new TextDecoder().decode(bytes));
  assert.ok(entries.some((text) => text.includes("exception-recorded") && text.includes(MARKER)), "an exception's reason");
  assert.equal(JSON.stringify(corrected.state).includes("Going ahead on one exploratory visit"), false, "an exception's reason is in no state");
  await checkOwnerText({ readRow, projectAttemptSummary, evidenceForAttempt });
  const leaking = loadVariant<typeof evidence>(require.resolve("../core/evidence-model"), [
    { find: 'if (row.observation === null)\n        return { reading: "recorded" };', replace: 'if (row.observation === null)\n        return { reading: "recorded", statement: record.facts.map(({ statement }) => statement).join() };' }
  ]);
  await assertCaughtBy("a reader function handing back the owner's wording", OWNER_TEXT, () => checkOwnerText({ readRow: leaking.readRow, projectAttemptSummary, evidenceForAttempt }));
  const handingBack = (field: string) => loadVariant<typeof aggregates>(require.resolve("../core/aggregates"), [{ find: "return { ok: true, rows: record.rows.filter((row) => row.slot === slot).map(", replace: `return { ok: true, ${field}, rows: record.rows.filter((row) => row.slot === slot).map(` }]);
  for (const [name, field] of [
    ["the owner's unknowns", "unknowns: record.unknowns"],
    ["what an unknown would need", "needs: record.unknowns.map(({ wouldResolve }) => wouldResolve)"],
    ["a supersede's reason", "reasons: record.facts.flatMap(({ history }) => history.map(({ reason }) => reason))"],
    ["a fact retraction's reason", "reasons: record.facts.map(({ retraction }) => retraction && retraction.reason)"],
    ["an assertion retraction's reason", "reasons: record.assertions.map(({ retraction }) => retraction && retraction.reason)"]
  ] as const) {
    await assertCaughtBy(`evidence handing back ${name}`, OWNER_TEXT, () => checkOwnerText({ readRow, projectAttemptSummary, evidenceForAttempt: handingBack(field).evidenceForAttempt }));
  }
});

const NO_CANARY = "what the raw tier holds is in no entry, head, address or state, and a command that tries to carry it is refused by shape";

/** Spelled by hand from what a capture could hold. */
const scanForCanaries = (entries: readonly (readonly [string, Uint8Array])[], head: string, evidenceAddresses: readonly string[], state: unknown) => {
  const everything: string[] = [];
  for (const [address, bytes] of entries) everything.push(address, new TextDecoder().decode(bytes));
  everything.push(head, ...evidenceAddresses, JSON.stringify(state));
  const text = everything.join("\n");
  for (const canary of CANARIES) holds(NO_CANARY, !text.includes(canary), () => canary);
};

test("the canaries in the raw tier reach no log entry, head or address, and a command cannot carry one in", async () => {
  const raw = [...stores.evidence.objects.values()].map((bytes) => new TextDecoder().decode(bytes)).join("\n");
  // Each is really in the raw tier, in bytes the store holds and no fold reads.
  for (const canary of CANARIES) assert.ok(raw.includes(canary), `${canary} is really in the raw tier`);
  const entries = [...stores.entries.objects];
  scanForCanaries(entries, String(stores.head.value), [...stores.evidence.objects.keys()], closed.state);
  // The scan can see one, wherever it landed.
  const planted = new TextEncoder().encode(`an entry holding ${CANARIES[0]}`);
  await assertCaughtBy("a canary in an entry", NO_CANARY, () => scanForCanaries([...entries, ["somewhere", planted]], String(stores.head.value), [], closed.state));
  await assertCaughtBy("a canary in an address", NO_CANARY, () => scanForCanaries(entries, String(stores.head.value), [CANARIES[1]], closed.state));
  await assertCaughtBy("a canary in the state", NO_CANARY, () => scanForCanaries(entries, String(stores.head.value), [], { held: CANARIES[2] }));

  // A command trying to carry one in: refused by shape, and the refusal does not repeat it. The fixture's canaries
  // are upper case, which alone refuses them. These hold each character a URL or an address needs, in lower case.
  const punctuated = ["canary/path", "canary@mail", "canary=value", "canary?query", "canary.example", "alice.person@mail.example/path?token=one"];
  const now = risingClock(NOW_MS + 800_000);
  const row = { id: "row-new", slot: "I2", instrument: "coverage", state: "present", window: { clock: "page", startMs: 1, endMs: 2 }, limits: [], digest: "ab".repeat(32), observation: null };
  const headBefore = stores.head.value;
  let tried = 0;
  for (const canary of [...CANARIES, ...punctuated]) {
    for (const data of [
      { row: { ...row, id: canary } },
      { row: { ...row, instrument: canary } },
      { row: { ...row, limits: [canary] } },
      { row: { ...row, window: { clock: null, note: canary } } },
      { row: { ...row, script: canary } },
      { row, url: canary }
    ]) {
      const answer = await store.runCommand(stores, closed, { actor: actorsFor(owner)("I2"), event: logEvent("evidence-recorded", data as never), now });
      assert.deepEqual(answer, { ok: false, refusal: "malformed-event", at: "evidence-recorded" }, canary);
      tried += 1;
    }
  }
  assert.equal(tried, (5 + 6) * 6);
  assert.equal(stores.head.value, headBefore);
  // The limit, stated here and pinned in the store's suite: a lower-case word fits a slug whatever it means, so the slug is a shape only.
  assert.ok(caseEvents.decodeEvent(logEvent("evidence-recorded", { row: { ...row, id: "canary-query-value-9c1b" } as never })).ok);
});

const SITE_STRINGS = "the code names no real site";

/** Invented terms, spelled in pieces so this file does not hold what it looks for. Real terms are kept out of the repository and checked for outside it. */
const BANNED = [["zorv", "andle"], ["quil", "matrex"], ["brin", "dosh"]].map((parts) => parts.join(""));
/** A hostname under a real suffix. Reserved names are fine, and everything here uses them. */
const REAL_HOST = /\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|co|gov|edu|info|biz|dev|app|ai)\b/i;

const W2_TESTS = ["aggregates.test.ts", "case-fixture.ts", "case-machine-walk.test.ts", "case-machine.test.ts", "case-store.test.ts", "case-surface.test.ts", "evidence-model.test.ts", "ids.test.ts", "purge.test.ts", "readings.test.ts", "summary-tier.test.ts", "w2-acceptance.test.ts"];

const newFiles = (): readonly string[] => [...Object.keys(EXPORTS).map((file) => `${CORE}/${file}`), ...W2_TESTS.map((file) => `${TEST}/${file}`)];

type Read = (file: string) => string;
const readProject: Read = (file) => readFileSync(path.join(ROOT, file), "utf8");

const checkSiteStrings = (read: Read) => {
  for (const file of newFiles()) {
    const source = read(file).toLowerCase();
    for (const banned of BANNED) holds(SITE_STRINGS, !source.includes(banned), () => ({ file, banned }));
    const host = source.match(REAL_HOST);
    holds(SITE_STRINGS, host === null, () => ({ file, host: host?.[0] }));
  }
};

test("the new code and its fixture name no real site, by a list and by the shape of a hostname", async () => {
  checkSiteStrings(readProject);
  const plant = (target: string, line: string): Read => (file) => (file === target ? `${line}\n${readProject(file)}` : readProject(file));
  for (const [name, target, line] of [
    ["a site named in the machine", `${CORE}/case-machine.ts`, `// checked against ${BANNED[0]}`],
    ["a site's vendor in the reading functions", `${CORE}/readings.ts`, `const host = "client.${BANNED[1]}.net";`],
    ["a site in the fixture", `${TEST}/case-fixture.ts`, `export const SITE = "https://www.${BANNED[0]}.com/";`],
    ["another real site in a store test", `${TEST}/case-store.test.ts`, `const SITE = "news.bigpaper.${"com"}";`],
    ["a real hostname in the summary", `${CORE}/summary-tier.ts`, `const SITE = "shop.acme.${"io"}";`]
  ] as const) {
    await assertCaughtBy(name, SITE_STRINGS, () => checkSiteStrings(plant(target, line)));
  }
});

test("the list of new test files is every test file this batch added beside the ones before it", () => {
  const earlier = ["access-token.test.ts", "actor.test.ts", "canonical-json.test.ts", "case-log-walk.test.ts", "case-log-workerd.test.ts", "case-log.test.ts", "deployment-config.test.ts", "fs-kill-child.ts", "fs-log-store-kill.test.ts", "fs-log-store.test.ts", "log-fixture.ts", "memory-log-store.ts", "token-fixture.ts", "workerd-case-log-entry.ts", "workspace-boundaries.test.ts", "workspace-config.test.ts", "workspace-gate.test.ts"];
  const present = readdirSync(path.join(ROOT, TEST)).filter((file) => file.endsWith(".ts")).sort();
  assert.deepEqual(present, [...earlier, ...W2_TESTS].sort());
});
