import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { before, test } from "node:test";
import ts from "typescript";
import { assertCaughtBy, holds, loadVariant, type SourceEdit } from "../../lib/finite-check";
import type { Actor } from "../core/actor";
import * as aggregates from "../core/aggregates";
import { aggregate, evidenceForAttempt } from "../core/aggregates";
import * as canonicalJson from "../core/canonical-json";
import * as caseEvents from "../core/case-events";
import * as caseLog from "../core/case-log";
import * as caseService from "../core/case-service";
import * as captureAdapter from "../core/capture-adapter";
import { EVENT_TYPES } from "../core/case-events";
import * as machine from "../core/case-machine";
import { continuationOf, denominatorOf, retentionOf } from "../core/case-machine";
import * as store from "../core/case-store";
import { aggregateRowsOfCase, type CaseState, type OpenCase } from "../core/case-store";
import * as evidence from "../core/evidence-model";
import { readRow, sourceIdentityOf } from "../core/evidence-model";
import * as ids from "../core/ids";
import * as importedCase from "../core/imported-case";
import * as importedIds from "../core/imported-ids";
import * as purge from "../core/purge";
import * as readings from "../core/readings";
import * as recorderShapes from "../core/recorder-shapes";
import * as sufficiency from "../core/sufficiency";
import * as summaryTier from "../core/summary-tier";
import * as trialLayout from "../core/trial-layout";
import { projectAttemptSummary } from "../core/summary-tier";
import * as viewerPages from "../core/viewer-pages";
import * as viewerRoutes from "../core/viewer-routes";
import * as viewerText from "../core/viewer-text";
import * as workspaceResponse from "../core/workspace-response";
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
  "aggregates.ts": ["SPLIT_KEYS", "aggregate", "aggregateRowsOf", "evidenceForAttempt", "limitsOfReading"],
  "canonical-json.ts": ["MAX_CANONICAL_DEPTH", "bytesEqual", "canonicalBytes", "hasExactly", "parseCanonical", "sha256Hex"],
  "case-log.ts": ["GENESIS_HEAD", "MAX_ENTRY_BYTES", "MAX_EVIDENCE_BYTES", "MAX_HEAD_CHARS", "appendCommand", "checkFirstEntry", "createLog", "isCaseId", "isDigest", "openLog", "putEvidence", "readEvidence", "verifyAgainstSavedHead"],
  "case-events.ts": ["EVENT_TYPES", "MAX_LIST_ITEMS", "MAX_SLUG_CHARS", "MAX_TEXT_CHARS", "configurationKey", "decodeEvent", "digestsNamed", "isConfigurationIdentity", "isSlug"],
  "case-service.ts": ["CLAIM_EVENT_TYPES", "EVIDENCE_PAGE_BYTES", "caseServiceOver"],
  "capture-adapter.ts": ["CAPTURE_ADAPTER", "LOGGER_APIS", "WALL_STATUSES", "adaptCaptureRun", "capturePathNames", "capturePathsNeeded", "originOfUrl", "readCaptureRun", "surveyCaptureRun"],
  "case-machine.ts": ["MAX_CONFIGURATION_CHANGES", "MAX_CONTROL_MISSES", "MAX_START_RETRIES", "OUTCOMES", "SLOT_NAMES", "continuationOf", "denominatorOf", "isCleanupUnresolved", "isOutcome", "isRunningPhase", "isTerminal", "plannedState", "retentionOf", "step", "visitBasisOf"],
  "case-store.ts": ["aggregateRowsOfCase", "createCase", "foldEntry", "mintedSlots", "openCase", "runCommand"],
  "evidence-model.ts": ["EMPTY_RECORD", "UNREAD_STATES", "addRow", "applyRecordEvent", "readRow", "sourceIdentityOf"],
  "ids.ts": ["mintAttemptId", "mintCaseId"],
  "imported-case.ts": ["IMPORTED_CLAIM_TYPES", "applyImportedClaim", "importCase", "importedAttemptId", "importedDenominatorOf", "importedEvidenceFor", "importedSourceOf", "isImportedAttemptId", "readImportedRow", "runDigestOf"],
  "imported-ids.ts": ["importedAttemptId", "isImportedAttemptId", "runDigestOf"],
  "purge.ts": ["purgeStep", "retentionTier"],
  "readings.ts": ["COMPLETENESS_LIMITS", "MAX_TIME_MS", "MAX_UNCERTAINTY_MS", "orderOf", "readExecutionJoin", "readObservation", "stackToScriptPosition"],
  "recorder-shapes.ts": ["END_REASONS", "NONSTANDARD_METHOD", "PROVENANCE_PATH", "RECORDER", "RECORDER_LIMITATIONS", "RECORDER_SHAPES", "checkEvidenceId", "decodeJson", "isCount", "isInsidePath", "isPlain", "isShapeRefusal", "mirroredFolder", "readCallRecord", "readInspectOutput", "readObserveOutput", "readProvenance", "readScriptManifest", "recorderIdentityOf", "shapeRefusal"],
  "sufficiency.ts": ["EVIDENCE_KINDS", "KIND_MEANINGS", "assessSufficiency"],
  "summary-tier.ts": ["isAttemptSummary", "projectAttemptSummary"],
  "trial-layout.ts": ["TRIAL_LAYOUT", "surveyTrialRun", "trialPathNames", "trialPathsNeeded"],
  "viewer-pages.ts": ["ADAPTER_NOTE", "CANNOT_ANSWER", "aggregatesPage", "attemptPage", "casePage", "evidencePage", "evidenceRefusalPage", "factPage", "formRefusalPage", "methodPage", "notFoundPage", "readingMarkup", "refusalPage", "rowPage"],
  "viewer-routes.ts": ["MAX_FORM_BYTES", "VIEWER_ROUTES", "viewerRoutes"],
  "viewer-text.ts": ["AttributeValue", "MAX_INDENT", "Markup", "attribute", "escapeAttribute", "escapeText", "hiddenField", "html", "linkTo", "pathOf"],
  "workspace-response.ts": ["BASE_POLICY", "VIEWER_STYLE", "VIEWER_STYLE_HASH", "htmlResponse", "jsonResponse", "refusalResponse", "responseHeaders"]
};

const MODULES: Readonly<Record<string, object>> = {
  "aggregates.ts": aggregates,
  "canonical-json.ts": canonicalJson,
  "case-log.ts": caseLog,
  "case-events.ts": caseEvents,
  "case-service.ts": caseService,
  "capture-adapter.ts": captureAdapter,
  "case-machine.ts": machine,
  "case-store.ts": store,
  "evidence-model.ts": evidence,
  "ids.ts": ids,
  "imported-case.ts": importedCase,
  "imported-ids.ts": importedIds,
  "purge.ts": purge,
  "readings.ts": readings,
  "recorder-shapes.ts": recorderShapes,
  "sufficiency.ts": sufficiency,
  "summary-tier.ts": summaryTier,
  "trial-layout.ts": trialLayout,
  "viewer-pages.ts": viewerPages,
  "viewer-routes.ts": viewerRoutes,
  "viewer-text.ts": viewerText,
  "workspace-response.ts": workspaceResponse
};

const PUBLISHING = /approv|publish|public|export|claim_?text|press|announce/i;

const NO_PUBLIC = "no function here produces text for anyone but the owner";

const checkSurface = (modules: Readonly<Record<string, object>>) => {
  for (const [file, expected] of Object.entries(EXPORTS)) {
    // A module listed and not loaded exports nothing, so it fails the comparison rather than the check.
    const names = Object.keys(modules[file] ?? {}).filter((name) => name !== "__esModule").sort();
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
  // A module listed for its exports but not loaded is caught by the check, not by a TypeError on the way.
  const { ["imported-case.ts"]: _unloaded, ...withoutOne } = MODULES;
  await assertCaughtBy("a listed module left unloaded", NO_PUBLIC, () => checkSurface(withoutOne));
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

const hostPattern = (suffixes: readonly string[]) => new RegExp(`\\b(?:[a-z0-9-]+\\.)+(?:${suffixes.join("|")})\\b`, "g");

/** A hostname under a common real suffix, looked for anywhere in a file's text. */
const REAL_HOST = hostPattern(["com", "net", "org", "io", "co", "gov", "edu", "info", "biz", "dev", "app", "ai"]);

/**
 * A hostname under any of a broad list of real suffixes, generic and country codes alike, looked for in
 * what a file says rather than what it does: its strings, its comments, and any string built from
 * literals joined by a plus or a template. Four country codes are left out, since this code names
 * properties by them and every claim's id would read as a host: at, by, id and is.
 */
const ANY_REAL_HOST = hostPattern([
  ...["com", "net", "org", "io", "co", "gov", "edu", "mil", "int", "info", "biz", "dev", "app", "ai", "tv", "me", "us", "xyz", "online", "site", "store", "shop", "top", "cloud", "page", "news", "blog", "live", "tech", "club", "website", "asia"],
  ...["ac", "ae", "ar", "au", "be", "bd", "bg", "br", "ca", "cc", "ch", "cl", "cn", "cz", "de", "dk", "ee", "eg", "es", "eu", "fi", "fm", "fr", "gg", "gr", "hk", "hr", "hu", "ie", "il", "in", "ir", "it", "jp", "ke", "kr", "kz", "la", "li", "lt", "lu", "lv", "ly", "ma", "mx", "my", "ng", "nl", "no", "nu", "nz", "pe", "ph", "pk", "pl", "pt", "qa", "ro", "rs", "ru", "sa", "se", "sg", "sh", "si", "sk", "th", "to", "tr", "tw", "ua", "uk", "vn", "ws", "za"]
]);

/** The reserved example names (RFC 2606) are fine, and every new file uses them, or .example and .test, which no suffix above matches. */
const isReserved = (host: string) => /(?:^|\.)example\.(?:com|net|org)$/.test(host);

/** The exact hosts the workspace names on purpose, each for a reason that is not a site. */
const ALLOWED: Readonly<Record<string, string>> = {
  "developers.cloudflare.com": "W1's citation of the platform's documentation for checking an access token",
  "workers.dev": "the platform's suffix for a deployed Worker, which W0's configuration refuses as the workspace's host",
  "pages.dev": "the platform's suffix for a Pages site, refused the same way",
  "site-behavior-lab-investigation.example.workers.dev": "a refused Worker host in W0's configuration tests",
  "preview-id-site-behavior-lab-investigation.example.workers.dev": "a refused preview host in W0's configuration tests",
  "abc123-site-behavior-lab-investigation.example.workers.dev": "a refused preview host in W0's configuration tests",
  "site-behavior-lab-investigation.pages.dev": "a refused Pages host in W0's configuration tests",
  "abc123.site-behavior-lab-investigation.pages.dev": "a refused Pages preview host in W0's configuration tests",
  "investigate.sitebehavior.org": "the project's own proposed workspace host, named in one test and pinned out of the code",
  "cloudflareaccess.com": "the platform's suffix for an access team, which W1 holds a token's issuer to",
  "sbl-test.cloudflareaccess.com": "the test team W1's tokens are issued by",
  "team.cloudflareaccess.com": "a team name in W1's issuer tests",
  "a.cloudflareaccess.com": "a team name in W1's issuer tests",
  "a.team.cloudflareaccess.com": "a nested name W1 refuses as an issuer",
  "team-.cloudflareaccess.com": "a malformed team name W1 refuses as an issuer",
  "other.cloudflareaccess.com": "another team, whose tokens W1 refuses",
  "attacker.cloudflareaccess.com": "another team, whose tokens W1 and W2 refuse",
  "mple.org": "the tail of a malformed email with a space in it, which W1 refuses",
  "example.co": "the domain of an address W1 spells in hex, to show no address reaches a digest",
  "sitebehavior.org": "the project's own domain, in W0's pattern that pins it out of the gate, the Worker and their config",
  "scan.sitebehavior.org": "the public scanner's own host, in W0's pattern that pins it out of the workspace's deployment config"
};

/**
 * The two exact predicate-type URIs W4's provenance rule requires, each for its reason. They are cut
 * out of a file's text before hosts are matched, each only where it ends, with no character a URL can
 * hold after it, so nothing else under their hosts is excused, a longer URL that starts with one
 * included.
 */
const PREDICATE_URIS: Readonly<Record<string, string>> = {
  "https://github.com/npm/attestation/tree/main/specs/publish/v0.1": "the predicate type of npm's publish attestation statement, which W4's provenance rule requires",
  "https://slsa.dev/provenance/v1": "the predicate type of the build provenance statement, which W4's provenance rule requires"
};

/** A character a URL can hold: a predicate URI followed by one is the start of a longer URL, and is not cut. */
const URL_CHARACTER = "[A-Za-z0-9._~:/?#\\[\\]@!$&'()*+,;=%-]";
const literally = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const withoutPredicates = (text: string) => Object.keys(PREDICATE_URIS).reduce((cut, uri) => cut.replace(new RegExp(`${literally(uri)}(?!${URL_CHARACTER})`, "g"), " "), text);

/** An escaped dot, however many backslashes spell it, and a dot in a class, read as a dot. */
const undotted = (text: string) => text.replace(/\\+\./g, ".").replace(/\[\.\]/g, ".");

const FOLDERS = ["investigation/core", "investigation/local", "investigation/test"];

/** The workspace's own files outside the three folders, read the same way. */
const WORKSPACE_FILES = ["cloudflare/investigation-worker.ts", "lib/investigation-worker-runtime-integration.test.ts", "scripts/investigation-test-stage.mjs", "tsconfig.investigation-test.json", "wrangler.investigation.jsonc"];

type Read = (file: string) => string;
type List = () => readonly string[];
const readProject: Read = (file) => readFileSync(path.join(ROOT, file), "utf8");
/** Every file under the three folders, whatever any list in this file says, and the workspace's own files beside them. */
const listProject: List = () =>
  [
    ...FOLDERS.flatMap((folder) =>
      readdirSync(path.join(ROOT, folder), { recursive: true, encoding: "utf8" })
        .map((name) => `${folder}/${name}`)
        .filter((file) => statSync(path.join(ROOT, file)).isFile())
    ),
    ...WORKSPACE_FILES
  ].sort();

/**
 * What a file says: its strings, its regular expressions, every comment, and each string joined from
 * literals by a plus or a template, each with its escaped dots read as dots. Comments are collected at
 * every token of the parsed file, punctuation included, as both the leading and the trailing trivia
 * the compiler assigns it, so a comment closing a block, after a comma or at the end of the file is
 * read too. (The compiler's scanner alone reads a regular expression or a template's tail without its
 * parser's context and can lose a comment there, so the parsed tokens drive the collection.)
 *
 * Escaped dots (\. however many backslashes spell it) and a dot in a class ([.]) are read as dots in
 * strings, regular expressions, comments and files that are not code. This scan holds honest drift, not a
 * deliberate evader: a host built by an array join, a concat, hex escapes or a variable inside a
 * template is not joined; a pattern that names its suffixes as an alternation is not expanded; a
 * suffix not on the lists above is not matched; and a label under a reserved name is excused with it.
 */
function textOf(file: string, source: string): string {
  if (!/\.(?:tsx?|mjs|cjs|js)$/.test(file)) return undotted(source);
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const said: string[] = [];
  const seen = new Set<string>();
  const comments = (ranges: readonly ts.CommentRange[] | undefined) => {
    for (const { pos, end } of ranges ?? []) {
      if (seen.has(`${pos}:${end}`)) continue;
      seen.add(`${pos}:${end}`);
      said.push(undotted(source.slice(pos, end)));
    }
  };
  const joined = (node: ts.Node): string | null => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isParenthesizedExpression(node)) return joined(node.expression);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const [left, right] = [joined(node.left), joined(node.right)];
      return left === null || right === null ? null : left + right;
    }
    if (ts.isTemplateExpression(node)) {
      let text = node.head.text;
      for (const span of node.templateSpans) {
        const part = joined(span.expression);
        if (part === null) return null;
        text += part + span.literal.text;
      }
      return text;
    }
    return null;
  };
  const visit = (node: ts.Node): void => {
    comments(ts.getLeadingCommentRanges(source, node.pos));
    comments(ts.getTrailingCommentRanges(source, node.end));
    if (ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node)) said.push(undotted(node.text));
    if (ts.isRegularExpressionLiteral(node)) said.push(undotted(node.text));
    if (ts.isBinaryExpression(node) || ts.isTemplateExpression(node)) {
      const text = joined(node);
      if (text !== null) said.push(undotted(text));
    }
    for (const child of node.getChildren(parsed)) visit(child);
  };
  visit(parsed);
  return said.join("\n");
}

const checkSiteStrings = (read: Read, list: List = listProject) => {
  const files = list();
  holds(SITE_STRINGS, files.length > 0, () => "no file was listed");
  for (const file of files) {
    const source = withoutPredicates(read(file));
    const said = withoutPredicates(textOf(file, read(file))).toLowerCase();
    for (const banned of BANNED) holds(SITE_STRINGS, !source.toLowerCase().includes(banned) && !said.includes(banned), () => ({ file, banned }));
    const hosts = [...source.toLowerCase().matchAll(REAL_HOST), ...said.matchAll(ANY_REAL_HOST)].map(([host]) => host);
    for (const host of hosts) holds(SITE_STRINGS, isReserved(host) || Object.hasOwn(ALLOWED, host), () => ({ file, host }));
  }
};

/** A host's labels joined at run time, so this file's own text holds none of the hosts it plants. */
const dotted = (...labels: readonly string[]) => labels.join(".");

test("every file in the workspace's folders names no real site, by a list and by the shape of a hostname", async () => {
  checkSiteStrings(readProject);
  const plant = (target: string, line: string): Read => (file) => (file === target ? `${line}\n${readProject(file)}` : readProject(file));
  for (const [name, target, line] of [
    ["a site named in the machine", `${CORE}/case-machine.ts`, `// checked against ${BANNED[0]}`],
    ["a site's vendor in the reading functions", `${CORE}/readings.ts`, `const host = "${dotted("client", BANNED[1], "net")}";`],
    ["a site in the fixture", `${TEST}/case-fixture.ts`, `export const SITE = "https://${dotted("www", BANNED[0], "com")}/";`],
    ["a site spelled in two pieces", `${TEST}/case-fixture.ts`, `export const SITE = "${BANNED[0].slice(0, 3)}" + "${BANNED[0].slice(3)}";`],
    ["another real site in a store test", `${TEST}/case-store.test.ts`, `const SITE = "${dotted("news", "bigpaper", "com")}";`],
    ["a real hostname in the summary", `${CORE}/summary-tier.ts`, `const SITE = "${dotted("shop", "acme", "io")}";`],
    ["a real hostname in the adapter", `${CORE}/capture-adapter.ts`, `const HOST = "${dotted("cdn", "lamplighter", "net")}";`],
    ["a real hostname in the synthetic run", `${TEST}/recorded-fixture.ts`, `export const PAGE = "https://${dotted("www", "lantern", "com")}";`],
    ["a real hostname in the local reader", `investigation/local/recorded-folder.ts`, `// read from ${dotted("archive", "quillpress", "org")}`],
    ["a real hostname in the log's store, which W1 wrote", `investigation/local/fs-log-store.ts`, `// mirrored to ${dotted("backup", "quillpress", "org")}`],
    ["a real hostname in an earlier module", `${CORE}/access-token.ts`, `const KEYS = "https://${dotted("keys", "lamplighter", "net")}/";`],
    ["a hostname under a country code", `${CORE}/trial-layout.ts`, `const HOST = "${dotted("www", "lantern", "de")}";`],
    ["a hostname under a short generic suffix", `${TEST}/trial-layout.test.ts`, `const HOST = "${dotted("media", "lantern", "tv")}";`],
    ["a hostname under a personal suffix", `${TEST}/sufficiency.test.ts`, `// see ${dotted("quill", "me")}`],
    ["a hostname split by a plus", `${CORE}/imported-case.ts`, `const HOST = "${dotted("cdn", "lamplighter")}." + "us";`],
    ["a hostname split by a template", `${CORE}/sufficiency.ts`, "const HOST = `" + dotted("cdn", "lamplighter") + '.${"tv"}`;'],
    ["a real host with example as one of its labels", `${CORE}/viewer-text.ts`, `const HOST = "${dotted("www", "example", "lamplighter", "net")}";`]
  ] as const) {
    await assertCaughtBy(name, SITE_STRINGS, () => checkSiteStrings(plant(target, line)));
  }
  // A file no list in this file names is read as well, and a host on the allow-list is excused only when spelled exactly.
  const unlisted = `${TEST}/a-new-helper.ts`;
  await assertCaughtBy("a real hostname in a file no list names", SITE_STRINGS, () =>
    checkSiteStrings((file) => (file === unlisted ? `export const HOST = "${dotted("www", "lantern", "com")}";` : readProject(file)), () => [...listProject(), unlisted])
  );
  await assertCaughtBy("a host that only ends like an allowed one", SITE_STRINGS, () => checkSiteStrings(plant(`${CORE}/sufficiency.ts`, `const HOST = "${dotted("cdn", "lamplighter", "workers", "dev")}";`)));
  await assertCaughtBy("no file listed at all", SITE_STRINGS, () => checkSiteStrings(readProject, () => []));
});

const ALLOWED_NAMED = "every host on the allow-list is named by a file the scan reads, other than this one";

/** The allow-list is exact: each host on it is really named elsewhere, so none is left over to excuse a later one. This file, which spells every one, is left out. */
const checkAllowedNamed = (allowed: Readonly<Record<string, string>>, read: Read = readProject, predicates: Readonly<Record<string, string>> = PREDICATE_URIS) => {
  const named = new Set(
    listProject()
      .filter((file) => file !== `${TEST}/case-surface.test.ts`)
      .flatMap((file) => [...withoutPredicates(read(file)).toLowerCase().matchAll(REAL_HOST), ...withoutPredicates(textOf(file, read(file))).toLowerCase().matchAll(ANY_REAL_HOST)].map(([host]) => host))
  );
  for (const host of Object.keys(allowed)) holds(ALLOWED_NAMED, named.has(host), () => host);
  const elsewhere = listProject().filter((file) => file !== `${TEST}/case-surface.test.ts`);
  for (const uri of Object.keys(predicates)) holds(ALLOWED_NAMED, elsewhere.some((file) => read(file).includes(uri)), () => uri);
};

test("every host on the allow-list is named by some file the scan reads, so a stale entry is caught", async () => {
  checkAllowedNamed(ALLOWED);
  await assertCaughtBy("a stale allow-list entry", ALLOWED_NAMED, () => checkAllowedNamed({ ...ALLOWED, [dotted("old", "lamplighter", "net")]: "named by nothing now" }));
  // This file spells every allowed host, so one named only here is stale all the same.
  const stale = dotted("stale", "lamplighter", "net");
  const spelledHere: Read = (file) => (file === `${TEST}/case-surface.test.ts` ? `${readProject(file)}\nconst STALE = "${stale}";` : readProject(file));
  await assertCaughtBy("an allow-list entry named only by this file", ALLOWED_NAMED, () => checkAllowedNamed({ ...ALLOWED, [stale]: "named only here" }, spelledHere));
  await assertCaughtBy("a predicate URI named by nothing now", ALLOWED_NAMED, () => checkAllowedNamed(ALLOWED, readProject, { ...PREDICATE_URIS, [`https://${dotted("old", "lamplighter", "net")}/predicate/v1`]: "named by nothing now" }));
});

/** Each spelling the scan must read, planted alone, one test each, so a scan that stops reading one of them fails by name. */
const appended = (target: string, line: string): Read => (file) => (file === target ? `${readProject(file)}\n${line}` : readProject(file));
const inserted = (target: string, find: string, line: string): Read => (file) => (file === target ? readProject(file).replace(find, `${find}\n${line}`) : readProject(file));
for (const [name, read] of [
  ["a comment on the last line of a block", inserted(`${CORE}/sufficiency.ts`, "  return (EVIDENCE_KINDS as readonly unknown[]).includes(value);", `  // mirrored from ${dotted("cdn", "lamplighter", "tv")}`)],
  ["a regular expression with escaped dots", appended(`${CORE}/sufficiency.ts`, `export const PATTERN = /^${dotted("cdn", "lamplighter", "com").replace(/\./g, "\\.")}$/;`)],
  ["a trailing comment after the last property", appended(`${CORE}/sufficiency.ts`, `export const PLANTED = { a: 1, // see ${dotted("cdn", "lamplighter", "de")}\n};`)],
  ["a host in a trailing comment after a statement", appended(`${CORE}/sufficiency.ts`, `const HOST = 1; // ${dotted("quill", "me")}`)],
  ["a host in a regular expression", appended(`${CORE}/sufficiency.ts`, `const HOST = /${dotted("cdn", "lamplighter", "de")}/;`)],
  ["a host joined across a parenthesis", appended(`${CORE}/sufficiency.ts`, `const HOST = ("${dotted("cdn", "lamplighter")}") + ".de";`)],
  ["a reserved name followed by a real one", appended(`${CORE}/sufficiency.ts`, `const HOST = "${dotted("cdn", "example", "com", "lamplighter", "de")}";`)],
  ["a host that only ends in a reserved name", appended(`${CORE}/sufficiency.ts`, `const HOST = "${dotted("cdn", "myexample", "com")}";`)],
  ["a host in capitals under a country code", appended(`${CORE}/sufficiency.ts`, `const HOST = "${dotted("CDN", "LAMPLIGHTER", "DE")}";`)],
  ["a host in a comment that ends the file", appended(`${CORE}/sufficiency.ts`, `// ${dotted("quill", "me")}`)],
  ["a host in one of the workspace's files outside the folders", appended("wrangler.investigation.jsonc", `// ${dotted("deploy", "lamplighter", "net")}`)],
  ["a host under a predicate URI's host that is not the predicate URI", appended(`${CORE}/sufficiency.ts`, `// see https://${dotted("github", "com")}/lamplighter/notes`)],
  ["a host in a fixture string under a predicate URI's host", appended(`${TEST}/recorded-fixture.ts`, `export const NOTE = "https://${dotted("slsa", "dev")}/spec/v2";`)],
  ["a host in a template's head", appended(`${CORE}/sufficiency.ts`, "const at = (p: string) => `https://" + dotted("cdn", "lamplighter", "de") + "/${p}`;")],
  ["a regular expression with a dot in a class", appended(`${CORE}/sufficiency.ts`, `export const PATTERN = /${dotted("cdn", "lamplighter", "com").replace(/\./g, "[.]")}/;`)],
  ["a pattern built from a string with escaped dots", appended(`${CORE}/sufficiency.ts`, `export const PATTERN = new RegExp("^${dotted("cdn", "lamplighter", "com").replace(/\./g, "\\\\.")}$");`)],
  ["a file that is not code with an escaped-dot pattern", appended("tsconfig.investigation-test.json", `{ "pattern": "^${dotted("cdn", "lamplighter", "com").replace(/\./g, "\\\\.")}$" }`)],
  ["a regular expression with escaped dots in a comment", appended(`${CORE}/sufficiency.ts`, `// export const PATTERN = /^${dotted("cdn", "lamplighter", "com").replace(/\./g, "\\.")}$/;`)],
  ["a predicate URI followed by more of a path", appended(`${CORE}/sufficiency.ts`, `// see ${Object.keys(PREDICATE_URIS)[1]}/notes`)],
  ["a predicate URI followed by a dot and more", appended(`${TEST}/recorded-fixture.ts`, `export const NOTE = "${Object.keys(PREDICATE_URIS)[0]}.1";`)],
  ["a predicate URI followed by a fragment", appended(`${CORE}/sufficiency.ts`, `// see ${Object.keys(PREDICATE_URIS)[1]}#notes`)],
  ["a predicate URI followed by a query", appended(`${CORE}/sufficiency.ts`, `// see ${Object.keys(PREDICATE_URIS)[1]}?v=2`)],
  ["a predicate URI followed by a hyphen", appended(`${CORE}/sufficiency.ts`, `// see ${Object.keys(PREDICATE_URIS)[0]}-draft`)],
  ["a predicate URI followed by an escaped slash", appended(`${CORE}/sufficiency.ts`, `// see ${Object.keys(PREDICATE_URIS)[0]}%2Fnotes`)]
] as const) {
  test(`the site-strings scan reads ${name}`, async () => {
    await assertCaughtBy(name, SITE_STRINGS, () => checkSiteStrings(read));
  });
}

/** The lists of each batch's test files: the site-strings check above reads every file whatever these say, and the test below holds them to the folder. */
const W2_TESTS = ["aggregates.test.ts", "case-fixture.ts", "case-machine-walk.test.ts", "case-machine.test.ts", "case-store.test.ts", "case-surface.test.ts", "evidence-model.test.ts", "ids.test.ts", "purge.test.ts", "readings.test.ts", "summary-tier.test.ts", "w2-acceptance.test.ts"];

/** W3's, the viewer's. */
const W3_TESTS = ["case-service.test.ts", "memory-case-world.ts", "viewer-browser.test.ts", "viewer-fixture.ts", "viewer.test.ts", "workerd-bundle.ts", "workerd-viewer-entry.ts", "workspace-entry-workerd.test.ts"];

/** Batch F5's exhaustive exploration, which runs in a stage of its own. */
const F5_TESTS = ["case-exploration-plant-worker.ts", "case-exploration-walk.ts", "case-exploration-worker.ts", "case-exploration.test.ts"];

/** W4's, the imported case, its adapters, the sufficiency assessment and the local reader, with a synthetic run on reserved names. */
const W4_TESTS = ["capture-adapter.test.ts", "imported-case.test.ts", "recorded-fixture.ts", "recorded-folder.test.ts", "sufficiency.test.ts", "trial-layout.test.ts"];

test("the lists of new test files are every test file W2, W3, F5 and W4 added beside the ones before them", () => {
  const earlier = ["access-token.test.ts", "actor.test.ts", "canonical-json.test.ts", "case-log-walk.test.ts", "case-log-workerd.test.ts", "case-log.test.ts", "deployment-config.test.ts", "fs-kill-child.ts", "fs-log-store-kill.test.ts", "fs-log-store.test.ts", "log-fixture.ts", "memory-log-store.ts", "token-fixture.ts", "workerd-case-log-entry.ts", "workspace-boundaries.test.ts", "workspace-config.test.ts", "workspace-gate.test.ts"];
  const present = readdirSync(path.join(ROOT, TEST)).filter((file) => file.endsWith(".ts")).sort();
  assert.deepEqual(present, [...earlier, ...W2_TESTS, ...W3_TESTS, ...F5_TESTS, ...W4_TESTS].sort());
  // And the local folder holds the log's store and W4's reader; the site-strings check reads both, and any file added beside them.
  assert.deepEqual(readdirSync(path.join(ROOT, "investigation/local")).filter((file) => file.endsWith(".ts")).sort(), ["fs-log-store.ts", "recorded-folder.ts"]);
});
