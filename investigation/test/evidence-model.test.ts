import assert from "node:assert/strict";
import { test } from "node:test";
import { assertCaughtBy, holds, loadVariant, type SourceEdit } from "../../lib/finite-check";
import * as machine from "../core/case-machine";
import type { MachineActor, MachineState, SlotName } from "../core/case-machine";
import * as production from "../core/evidence-model";
import type { Assertion, EvidenceRecord, EvidenceRow, Fact, Interpretation, RecordEvent, RecordRefusal, RowState, Unknown, UnknownInput } from "../core/evidence-model";
import type { AttemptPhase, Cleanup } from "../core/case-machine";
import { captureOf, CONTROL_RUNNER, controlMet, driven, finishOf, FOREIGN_RUNNER, frozen, OWNER, planOf, runnerOf, startOf } from "./case-fixture";

/**
 * What a case says, by kind. Rows here are built by hand and every id differs from every
 * other, so a look-up by the wrong key cannot find the right thing. Each kind is checked
 * against every event, because a conversion would look like an event accepted for the
 * wrong kind. The walk further down holds every order of a small set of events to a plain
 * model kept in this file, which RESTATES the flagging rule and says so.
 */

type Module = typeof production;
const variant = (...edits: SourceEdit[]) => loadVariant<Module>(require.resolve("../core/evidence-model"), edits);

const AT = 7;

const row = (id: string, slot: SlotName, instrument: string, state: RowState = "present", over: Partial<EvidenceRow> = {}): EvidenceRow => ({
  id,
  slot,
  instrument,
  state,
  window: { clock: "page", startMs: 100, endMs: 900 },
  limits: [],
  digest: state === "present" ? "ab".repeat(32) : null,
  observation: null,
  ...over
});

const WORLD: MachineState = driven(machine, "the path runs", planOf("B1", "B2", "I1", "I2"), frozen, controlMet(), startOf("B1"), ...captureOf("B1"), finishOf("B1"));
const ROW_LANTERN = row("row-lantern", "B1", "coverage", "present", { limits: ["main-frame-only"], window: { clock: "page", startMs: 120, endMs: 480 } });
const ROW_THIMBLE = row("row-thimble", "B1", "logger", "present", { window: { clock: "harness", startMs: 5, endMs: 50 } });
const ROW_QUILL = row("row-quill", "I1", "coverage", "present", { window: { clock: null, note: "window-not-recorded" }, limits: ["attach-window-only", "wrapped-apis-only"] });
const ROW_NO_RECORD = row("row-nothing", "B1", "coverage", "no_record");

const seeded = (): EvidenceRecord => ({ ...production.EMPTY_RECORD, rows: [ROW_LANTERN, ROW_THIMBLE, ROW_QUILL, ROW_NO_RECORD] });

function apply(module: Module, property: string, record: EvidenceRecord, event: RecordEvent, by: MachineActor = OWNER, world: MachineState = WORLD, atSeq: number = AT): EvidenceRecord {
  const result = module.applyRecordEvent(record, event, by, world, atSeq);
  holds(property, result.ok, () => ({ event, result }));
  return (result as Extract<production.RecordResult, { ok: true }>).record;
}

function refused(module: Module, property: string, record: EvidenceRecord, event: RecordEvent, refusal: RecordRefusal, by: MachineActor = OWNER, world: MachineState = WORLD): void {
  const result = module.applyRecordEvent(record, event, by, world, AT);
  holds(property, !result.ok && result.refusal === refusal, () => ({ event, result, expected: refusal }));
}

const B1_RUNNING: MachineState = driven(machine, "the path runs", planOf("B1", "B2", "I1", "I2"), frozen, controlMet(), startOf("B1"));

const unknownInput = (id: string): UnknownInput => ({ id, question: "What did the second loader run?", reason: "No instrument covered that loader.", detail: null, wouldResolve: "A logger arm on that loader." });

const factEvent = (id: string, evidence: readonly string[], statement = `Statement of ${id}.`): RecordEvent => ({ type: "fact-recorded", id, statement, evidence });
const supersede = (fact: string, statement = `New wording of ${fact}.`): RecordEvent => ({ type: "fact-superseded", fact, statement, reason: "The first wording said more than the rows do." });
const retractFact = (fact: string, unknown: UnknownInput | null = null): RecordEvent => ({ type: "fact-retracted", fact, reason: "The row it rested on was misread.", unknown });
const interpretation = (id: string, cites: production.Cite[]): RecordEvent => ({ type: "interpretation-recorded", id, statement: `Reading ${id}.`, cites });
const assertionEvent = (id: string): RecordEvent => ({ type: "assertion-recorded", id, statement: `Someone said ${id}.` });
const reaffirm = (id: string, cites: production.Cite[]): RecordEvent => ({ type: "interpretation-reaffirmed", interpretation: id, cites });
const retractAssertion = (id: string, unknownId: string): RecordEvent => ({ type: "assertion-retracted", assertion: id, reason: "Nothing recorded backs it.", unknown: unknownInput(unknownId) });

/** A record with one claim of each kind, whose ids say nothing about their kinds. */
const everyKind = (module: Module): EvidenceRecord => {
  const property = "the fixture builds";
  let record = seeded();
  record = apply(module, property, record, factEvent("alpha", ["row-lantern"]));
  record = apply(module, property, record, assertionEvent("bravo"));
  record = apply(module, property, record, interpretation("charlie", [{ fact: "alpha", version: 1 }]));
  record = apply(module, property, record, { type: "unknown-recorded", unknown: unknownInput("delta") });
  return record;
};

// Type level. The stage compiles this file, so a conversion becoming legal fails the stage
// at its compile, by an unused expect-error, before any test runs.
function typeLevelSeparation(fact: Fact, assertion: Assertion, reading: Interpretation, unknown: Unknown): void {
  // @ts-expect-error an assertion is not a fact
  const a: Fact = assertion;
  // @ts-expect-error an unknown is not a fact
  const b: Fact = unknown;
  // @ts-expect-error an interpretation is not a fact
  const c: Fact = reading;
  // @ts-expect-error a fact is not an assertion
  const d: Assertion = fact;
  // @ts-expect-error a fact is not an unknown
  const e: Unknown = fact;
  // @ts-expect-error a fact is not an interpretation
  const f: Interpretation = fact;
  // @ts-expect-error an assertion is not an unknown
  const g: Unknown = assertion;
  // @ts-expect-error an unknown is not an assertion
  const h: Assertion = unknown;
  // @ts-expect-error an assertion is never citable, by its type
  const i: Assertion = { ...assertion, citable: true };
  void [a, b, c, d, e, f, g, h, i];
}
void typeLevelSeparation;

test("the claim kinds, each by its own tag, with every field a fact links", () => {
  const record = apply(production, "builds", seeded(), factEvent("alpha", ["row-lantern", "row-quill"]));
  assert.deepEqual(record.facts[0], {
    kind: "fact",
    id: "alpha",
    version: 1,
    status: "current",
    statement: "Statement of alpha.",
    links: [
      { evidence: "row-lantern", slot: "B1", instrument: "coverage", window: { clock: "page", startMs: 120, endMs: 480 }, limits: ["main-frame-only"] },
      { evidence: "row-quill", slot: "I1", instrument: "coverage", window: { clock: null, note: "window-not-recorded" }, limits: ["attach-window-only", "wrapped-apis-only"] }
    ],
    history: [],
    retraction: null
  });
  const kinds = everyKind(production);
  assert.deepEqual(
    [kinds.facts[0].kind, kinds.assertions[0].kind, kinds.interpretations[0].kind, kinds.unknowns[0].kind],
    ["fact", "assertion", "interpretation", "unknown"]
  );
  assert.deepEqual(kinds.assertions[0], { kind: "assertion", id: "bravo", status: "unverified", citable: false, statement: "Someone said bravo.", retraction: null });
});

const NO_CONVERSION = "no event accepts an id of another kind, so nothing can become something else";

/** Every event that names a claim, against an id of every kind. Exactly one kind answers each. */
const checkNoConversion = (module: Module) => {
  const record = everyKind(module);
  const kinds = [["alpha", "fact"], ["bravo", "assertion"], ["charlie", "interpretation"], ["delta", "unknown"]] as const;
  const events: readonly (readonly [(id: string) => RecordEvent, "fact" | "assertion" | "interpretation", RecordRefusal])[] = [
    [(id) => supersede(id), "fact", "not-a-fact"],
    [(id) => retractFact(id), "fact", "not-a-fact"],
    [(id) => retractAssertion(id, "fresh-unknown"), "assertion", "not-an-assertion"],
    [(id) => reaffirm(id, [{ fact: "alpha", version: 1 }]), "interpretation", "not-an-interpretation"]
  ];
  for (const [event, accepts, refusal] of events) {
    for (const [id, kind] of kinds) {
      const result = module.applyRecordEvent(record, event(id), OWNER, WORLD, AT);
      if (kind === accepts) {
        // An interpretation not flagged has nothing to reaffirm, which is that event's own refusal, not a kind's.
        holds(NO_CONVERSION, result.ok || (result as { refusal: string }).refusal === "not-flagged", () => ({ id, kind, result }));
      } else {
        holds(NO_CONVERSION, !result.ok && result.refusal === refusal, () => ({ id, kind, result }));
      }
    }
  }
};

const checkIdsAreOneKind = (module: Module) => {
  const record = everyKind(module);
  for (const id of ["alpha", "bravo", "charlie", "delta"]) {
    refused(module, NO_CONVERSION, record, factEvent(id, ["row-thimble"]), "id-taken");
    refused(module, NO_CONVERSION, record, assertionEvent(id), "id-taken");
    refused(module, NO_CONVERSION, record, interpretation(id, [{ fact: "alpha", version: 1 }]), "id-taken");
    refused(module, NO_CONVERSION, record, { type: "unknown-recorded", unknown: unknownInput(id) }, "id-taken");
    refused(module, NO_CONVERSION, record, retractAssertion("bravo", id), "id-taken");
  }
  refused(module, NO_CONVERSION, record, retractFact("alpha", unknownInput("bravo")), "id-taken");
};

const NAMESPACE = "rows and every claim kind share one namespace of ids, and a fact can only rest on a row";

const checkNamespace = (module: Module) => {
  const record = everyKind(module);
  // A row's id is taken for every kind of claim.
  refused(module, NAMESPACE, record, factEvent("row-thimble", ["row-lantern"]), "id-taken");
  refused(module, NAMESPACE, record, assertionEvent("row-thimble"), "id-taken");
  refused(module, NAMESPACE, record, interpretation("row-thimble", [{ fact: "alpha", version: 1 }]), "id-taken");
  refused(module, NAMESPACE, record, { type: "unknown-recorded", unknown: unknownInput("row-thimble") }, "id-taken");
  refused(module, NAMESPACE, record, retractAssertion("bravo", "row-thimble"), "id-taken");
  refused(module, NAMESPACE, record, retractFact("alpha", unknownInput("row-thimble")), "id-taken");
  // A claim's id is taken for a row, whichever kind holds it.
  for (const id of ["alpha", "bravo", "charlie", "delta"]) {
    const added = module.addRow(record, row(id, "B1", "logger"), "capturing");
    holds(NAMESPACE, !added.ok && added.refusal === "id-taken" && added.at === "row.id", () => ({ id, added }));
  }
  // So is another row's.
  const repeated = module.addRow(record, row("row-thimble", "B1", "logger"), "capturing");
  holds(NAMESPACE, !repeated.ok && repeated.refusal === "id-taken", () => repeated);
  // A fact citing a claim is citing no row, and stays refused whatever is named later.
  for (const id of ["alpha", "bravo", "charlie", "delta"]) refused(module, NAMESPACE, record, factEvent("x-fact", [id]), "no-such-row");
  refused(module, NAMESPACE, record, factEvent("x-fact", ["named-later"]), "no-such-row");
  const named = apply(module, NAMESPACE, record, assertionEvent("named-later"));
  refused(module, NAMESPACE, named, factEvent("x-fact", ["named-later"]), "no-such-row");
  const addedLater = module.addRow(named, row("named-later", "B1", "logger"), "capturing");
  holds(NAMESPACE, !addedLater.ok && addedLater.refusal === "id-taken", () => addedLater);
};

test("no event accepts an id of another kind, and an id belongs to one kind for good", async () => {
  checkNoConversion(production);
  checkIdsAreOneKind(production);
  checkNamespace(production);
  await assertCaughtBy("a row's id free for a claim", NAMESPACE, () => checkNamespace(variant({ find: "return claimWithId(record, id) !== null || record.rows.some((row) => row.id === id);", replace: "return claimWithId(record, id) !== null;" })));
  await assertCaughtBy("a claim's id free for a row", NAMESPACE, () => checkNamespace(variant({ find: "return claimWithId(record, id) !== null || record.rows.some((row) => row.id === id);", replace: "return record.rows.some((row) => row.id === id);" })));
  await assertCaughtBy("a row added over a taken id", NAMESPACE, () => checkNamespace(variant({ find: 'if (isIdTaken(record, row.id))\n        return refuse("id-taken", "row.id");', replace: "" })));
  await assertCaughtBy("a fact resting on a claim by its id", NAMESPACE, () => checkNamespace(variant({ find: 'if (row === undefined)\n            return refuse("no-such-row", "evidence");', replace: 'if (row === undefined) {\n            if (claimWithId(record, id) === null)\n                return refuse("no-such-row", "evidence");\n            continue;\n        }' })));
  await assertCaughtBy("a supersede taking any claim", NO_CONVERSION, () => checkNoConversion(variant({ find: 'if (claim.kind !== "fact")\n        return refuse("not-a-fact", "fact");', replace: "" })));
  await assertCaughtBy("an assertion retraction taking any claim", NO_CONVERSION, () => checkNoConversion(variant({ find: 'if (claim.kind !== "assertion")\n        return refuse("not-an-assertion", "assertion");', replace: "" })));
  await assertCaughtBy("a reaffirm taking any claim", NO_CONVERSION, () => checkNoConversion(variant({ find: 'if (claim.kind !== "interpretation")\n        return refuse("not-an-interpretation", "interpretation");', replace: "" })));
  await assertCaughtBy("a fact over another kind's id", NO_CONVERSION, () => checkIdsAreOneKind(variant({ find: 'if (isIdTaken(record, event.id))\n        return refuse("id-taken", "id");\n    if (event.evidence.length === 0)', replace: "if (event.evidence.length === 0)" })));
  await assertCaughtBy("an interpretation over another kind's id", NO_CONVERSION, () => checkIdsAreOneKind(variant({ find: 'if (isIdTaken(record, event.id))\n        return refuse("id-taken", "id");\n    if (event.cites.length === 0)', replace: "if (event.cites.length === 0)" })));
  await assertCaughtBy("an assertion over another kind's id", NO_CONVERSION, () => checkIdsAreOneKind(variant({ find: 'case "assertion-recorded":\n            if (isIdTaken(record, event.id))\n                return refuse("id-taken", "id");', replace: 'case "assertion-recorded":' })));
  await assertCaughtBy("an unknown over another kind's id", NO_CONVERSION, () => checkIdsAreOneKind(variant({ find: 'case "unknown-recorded":\n            if (isIdTaken(record, event.unknown.id))\n                return refuse("id-taken", "unknown.id");', replace: 'case "unknown-recorded":' })));
  await assertCaughtBy("a retraction's unknown over a taken id", NO_CONVERSION, () => checkIdsAreOneKind(variant({ find: 'if (isIdTaken(record, event.unknown.id))\n        return refuse("id-taken", "unknown.id");\n    const retracted', replace: "const retracted" })));
  await assertCaughtBy("a fact retraction's unknown over a taken id", NO_CONVERSION, () => checkIdsAreOneKind(variant({ find: 'if (event.unknown !== null && isIdTaken(record, event.unknown.id))\n        return refuse("id-taken", "unknown.id");', replace: "" })));
});

const FACT_EVIDENCE = "a fact rests only on rows that hold what was seen, every one of them";

const NOT_PRESENT: readonly RowState[] = ["no_record", "before_window", "out_of_scope", "truncated", "not_read", "late"];

const checkFactEvidence = (module: Module) => {
  // None of these holds a count above 0, so the late one among them is not the exception a late positive is.
  const rows = NOT_PRESENT.map((state) => row(`row-${state.replace("_", "-")}`, "B1", "coverage", state));
  const record: EvidenceRecord = { ...seeded(), rows: [...seeded().rows, ...rows] };
  for (const bad of rows) {
    refused(module, FACT_EVIDENCE, record, factEvent("alpha", [bad.id]), "row-not-present");
    // First, last and middle, so a check that reads only one of them is seen.
    refused(module, FACT_EVIDENCE, record, factEvent("alpha", [bad.id, "row-lantern"]), "row-not-present");
    refused(module, FACT_EVIDENCE, record, factEvent("alpha", ["row-lantern", bad.id]), "row-not-present");
    refused(module, FACT_EVIDENCE, record, factEvent("alpha", ["row-lantern", bad.id, "row-thimble"]), "row-not-present");
  }
  refused(module, FACT_EVIDENCE, record, factEvent("alpha", []), "fact-needs-evidence");
  refused(module, FACT_EVIDENCE, record, factEvent("alpha", ["row-absent-from-this-case"]), "no-such-row");
  refused(module, FACT_EVIDENCE, record, factEvent("alpha", ["row-lantern", "row-absent-from-this-case"]), "no-such-row");
  apply(module, FACT_EVIDENCE, record, factEvent("alpha", ["row-lantern", "row-thimble"]));
};

test("a row that is not present can never become a fact", async () => {
  checkFactEvidence(production);
  await assertCaughtBy("a no_record row becoming a fact", FACT_EVIDENCE, () => checkFactEvidence(variant({ find: 'if (row.state !== "present" && !isLatePositive(row))\n            return refuse("row-not-present", "evidence");', replace: "" })));
  await assertCaughtBy("only no_record refused", FACT_EVIDENCE, () => checkFactEvidence(variant({ find: 'if (row.state !== "present" && !isLatePositive(row))\n            return refuse("row-not-present", "evidence");', replace: 'if (row.state === "no_record")\n            return refuse("row-not-present", "evidence");' })));
  await assertCaughtBy("a fact on no evidence", FACT_EVIDENCE, () => checkFactEvidence(variant({ find: 'if (event.evidence.length === 0)\n        return refuse("fact-needs-evidence", "evidence");', replace: "" })));
  await assertCaughtBy("a row checked only if it is first", FACT_EVIDENCE, () => checkFactEvidence(variant({ find: "for (const id of event.evidence) {", replace: "for (const id of event.evidence.slice(0, 1)) {" })));
});

const SUPERSEDE = "a supersede keeps every row and the old wording, and flags exactly what cites the fact";

const dependents = (module: Module): EvidenceRecord => {
  let record = seeded();
  record = apply(module, "builds", record, factEvent("alpha", ["row-lantern", "row-quill"]));
  record = apply(module, "builds", record, factEvent("echo", ["row-thimble"]));
  record = apply(module, "builds", record, interpretation("reads-alpha", [{ fact: "alpha", version: 1 }]));
  record = apply(module, "builds", record, interpretation("reads-both", [{ fact: "echo", version: 1 }, { fact: "alpha", version: 1 }]));
  record = apply(module, "builds", record, interpretation("reads-echo", [{ fact: "echo", version: 1 }]));
  return record;
};

const reviewOf = (record: EvidenceRecord, id: string) => {
  const found = record.interpretations.find((candidate) => candidate.id === id) as Interpretation;
  return { review: found.review, flags: found.flags, cites: found.cites };
};

const checkSupersede = (module: Module) => {
  const before = dependents(module);
  const after = apply(module, SUPERSEDE, before, supersede("alpha", "New wording of alpha."), OWNER, WORLD, 21);
  holds(SUPERSEDE, after.rows === before.rows, () => "rows were rebuilt");
  const fact = after.facts.find(({ id }) => id === "alpha") as Fact;
  const old = before.facts.find(({ id }) => id === "alpha") as Fact;
  holds(SUPERSEDE, fact.version === 2 && fact.status === "current" && fact.statement === "New wording of alpha.", () => fact);
  holds(SUPERSEDE, JSON.stringify(fact.links) === JSON.stringify(old.links), () => fact);
  holds(SUPERSEDE, JSON.stringify(fact.history) === JSON.stringify([{ version: 1, statement: "Statement of alpha.", reason: "The first wording said more than the rows do.", atSeq: 21 }]), () => fact);
  // Two dependents, one of them citing it second, and one interpretation that does not cite it at all.
  const flag = [{ fact: "alpha", fromVersion: 1, change: "superseded", atSeq: 21 }];
  holds(SUPERSEDE, JSON.stringify(reviewOf(after, "reads-alpha")) === JSON.stringify({ review: "needs_review", flags: flag, cites: [{ fact: "alpha", version: 1 }] }), () => reviewOf(after, "reads-alpha"));
  holds(SUPERSEDE, JSON.stringify(reviewOf(after, "reads-both")) === JSON.stringify({ review: "needs_review", flags: flag, cites: [{ fact: "echo", version: 1 }, { fact: "alpha", version: 1 }] }), () => reviewOf(after, "reads-both"));
  holds(SUPERSEDE, JSON.stringify(reviewOf(after, "reads-echo")) === JSON.stringify({ review: "current", flags: [], cites: [{ fact: "echo", version: 1 }] }), () => reviewOf(after, "reads-echo"));
  // Untouched: the other fact, and the record's other parts.
  holds(SUPERSEDE, after.facts.find(({ id }) => id === "echo") === before.facts.find(({ id }) => id === "echo"), () => "the other fact was rebuilt");
  // A second supersede moves on from version 2, and the flag accumulates: nothing clears it but a reaffirm.
  const twice = apply(module, SUPERSEDE, after, supersede("alpha", "A third wording."), OWNER, WORLD, 22);
  const flags = reviewOf(twice, "reads-alpha").flags;
  holds(SUPERSEDE, flags.length === 2 && flags[1].fromVersion === 2 && flags[1].atSeq === 22, () => flags);
  refused(module, SUPERSEDE, twice, supersede("alpha", "A third wording."), "same-wording");
};

test("a supersede keeps the evidence and the old wording, and flags only what depends on it", async () => {
  checkSupersede(production);
  await assertCaughtBy("no flags", SUPERSEDE, () => checkSupersede(variant({ find: 'return accept(flagDependents(replaced(record, next), fact.id, fact.version, "superseded", atSeq));', replace: "return accept(replaced(record, next));" })));
  await assertCaughtBy("every interpretation flagged", SUPERSEDE, () => checkSupersede(variant({ find: "interpretation.cites.some(({ fact }) => fact === factId)", replace: "true" })));
  await assertCaughtBy("only a first citation noticed", SUPERSEDE, () => checkSupersede(variant({ find: "interpretation.cites.some(({ fact }) => fact === factId)", replace: "interpretation.cites[0].fact === factId" })));
  await assertCaughtBy("only an interpretation citing nothing else noticed", SUPERSEDE, () => checkSupersede(variant({ find: "interpretation.cites.some(({ fact }) => fact === factId)", replace: "interpretation.cites.every(({ fact }) => fact === factId)" })));
  await assertCaughtBy("the old wording lost", SUPERSEDE, () => checkSupersede(variant({ find: "history: [...fact.history, { version: fact.version, statement: fact.statement, reason: event.reason, atSeq }] });", replace: "history: fact.history });" })));
  await assertCaughtBy("the version unchanged", SUPERSEDE, () => checkSupersede(variant({ find: "version: fact.version + 1, statement: event.statement,", replace: "statement: event.statement," })));
  await assertCaughtBy("a supersede dropping the rows", SUPERSEDE, () => checkSupersede(variant({ find: "version: fact.version + 1, statement: event.statement,", replace: "version: fact.version + 1, links: [], statement: event.statement," })));
  await assertCaughtBy("a supersede rewriting the record's rows", SUPERSEDE, () => checkSupersede(variant({ find: "return Object.assign(Object.assign({}, record), { facts: record.facts.map((existing) => (existing.id === fact.id ? fact : existing)) });", replace: "return Object.assign(Object.assign({}, record), { rows: [...record.rows], facts: record.facts.map((existing) => (existing.id === fact.id ? fact : existing)) });" })));
  await assertCaughtBy("cites moved to the new version without review", SUPERSEDE, () => checkSupersede(variant({ find: 'review: "needs_review", flags:', replace: 'review: "needs_review", cites: interpretation.cites.map((cite) => (cite.fact === factId ? { fact: factId, version: fromVersion + 1 } : cite)), flags:' })));
  await assertCaughtBy("a flag replacing the ones before it", SUPERSEDE, () => checkSupersede(variant({ find: "flags: [...interpretation.flags, { fact: factId, fromVersion, change, atSeq }]", replace: "flags: [{ fact: factId, fromVersion, change, atSeq }]" })));
  await assertCaughtBy("the same wording accepted", SUPERSEDE, () => checkSupersede(variant({ find: 'if (fact.statement === event.statement)\n        return refuse("same-wording", "statement");', replace: "" })));
});

const RETRACT = "a retracted fact stays readable, stops being citable, and flags what cited it";

const checkRetract = (module: Module) => {
  const before = dependents(module);
  const after = apply(module, RETRACT, before, retractFact("alpha", unknownInput("question-one")), OWNER, WORLD, 31);
  const fact = after.facts.find(({ id }) => id === "alpha") as Fact;
  holds(RETRACT, fact !== undefined, () => after.facts);
  holds(RETRACT, fact.status === "retracted" && fact.statement === "Statement of alpha." && fact.version === 1, () => fact);
  holds(RETRACT, JSON.stringify(fact.retraction) === JSON.stringify({ reason: "The row it rested on was misread.", atSeq: 31, replacedByUnknown: "question-one" }), () => fact);
  holds(RETRACT, after.rows === before.rows && fact.links.length === 2, () => fact);
  // What a flag says of a retraction, spelled: the fact, the version it was read at, the change and when.
  holds(RETRACT, JSON.stringify(reviewOf(after, "reads-alpha").flags) === JSON.stringify([{ fact: "alpha", fromVersion: 1, change: "retracted", atSeq: 31 }]), () => reviewOf(after, "reads-alpha"));
  const reworded = apply(module, RETRACT, before, supersede("alpha", "Another wording."), OWNER, WORLD, 32);
  const gone = apply(module, RETRACT, reworded, retractFact("alpha"), OWNER, WORLD, 33);
  holds(RETRACT, JSON.stringify(reviewOf(gone, "reads-both").flags) === JSON.stringify([{ fact: "alpha", fromVersion: 1, change: "superseded", atSeq: 32 }, { fact: "alpha", fromVersion: 2, change: "retracted", atSeq: 33 }]), () => reviewOf(gone, "reads-both"));
  // What the unknown it left holds, every field of it.
  const leftBehind: UnknownInput = { id: "question-kept", question: "Which loader ran it?", reason: "The row was misread.", detail: "Only the first loader was covered.", wouldResolve: "A second capture." };
  const withUnknown = apply(module, RETRACT, before, retractFact("alpha", leftBehind));
  holds(RETRACT, JSON.stringify(withUnknown.unknowns) === JSON.stringify([{ kind: "unknown", id: "question-kept", question: "Which loader ran it?", reason: "The row was misread.", detail: "Only the first loader was covered.", wouldResolve: "A second capture." }]), () => withUnknown.unknowns);
  holds(RETRACT, reviewOf(after, "reads-alpha").review === "needs_review" && reviewOf(after, "reads-both").review === "needs_review" && reviewOf(after, "reads-echo").review === "current", () => after.interpretations);
  holds(RETRACT, after.unknowns.length === 1 && after.unknowns[0].id === "question-one" && after.unknowns[0].kind === "unknown", () => after.unknowns);
  refused(module, RETRACT, after, supersede("alpha"), "fact-not-current");
  refused(module, RETRACT, after, retractFact("alpha"), "fact-not-current");
  refused(module, RETRACT, after, interpretation("reads-late", [{ fact: "alpha", version: 1 }]), "cite-not-current");
  const bare = apply(module, RETRACT, before, retractFact("alpha"));
  holds(RETRACT, bare.unknowns.length === 0 && (bare.facts[0].retraction as { replacedByUnknown: unknown }).replacedByUnknown === null, () => bare);
};

test("a retracted fact keeps its statement and its evidence, and may leave an unknown", async () => {
  checkRetract(production);
  await assertCaughtBy("no flags", RETRACT, () => checkRetract(variant({ find: 'const flagged = flagDependents(replaced(record, next), fact.id, fact.version, "retracted", atSeq);', replace: "const flagged = replaced(record, next);" })));
  await assertCaughtBy("a retract's flag at version 0", RETRACT, () => checkRetract(variant({ find: 'flagDependents(replaced(record, next), fact.id, fact.version, "retracted", atSeq)', replace: 'flagDependents(replaced(record, next), fact.id, 0, "retracted", atSeq)' })));
  await assertCaughtBy("a retract's flag saying superseded", RETRACT, () => checkRetract(variant({ find: 'flagDependents(replaced(record, next), fact.id, fact.version, "retracted", atSeq)', replace: 'flagDependents(replaced(record, next), fact.id, fact.version, "superseded", atSeq)' })));
  await assertCaughtBy("a retract's flag at sequence 0", RETRACT, () => checkRetract(variant({ find: 'flagDependents(replaced(record, next), fact.id, fact.version, "retracted", atSeq)', replace: 'flagDependents(replaced(record, next), fact.id, fact.version, "retracted", 0)' })));
  await assertCaughtBy("an unknown's detail dropped", RETRACT, () => checkRetract(variant({ find: "detail: input.detail, wouldResolve: input.wouldResolve };", replace: "detail: null, wouldResolve: input.wouldResolve };" })));
  await assertCaughtBy("what would resolve an unknown dropped", RETRACT, () => checkRetract(variant({ find: "detail: input.detail, wouldResolve: input.wouldResolve };", replace: "detail: input.detail, wouldResolve: null };" })));
  await assertCaughtBy("an unknown's reason taken for its question", RETRACT, () => checkRetract(variant({ find: "question: input.question, reason: input.reason,", replace: "question: input.reason, reason: input.reason," })));
  await assertCaughtBy("a retraction removing the fact", RETRACT, () => checkRetract(variant({ find: 'const flagged = flagDependents(replaced(record, next), fact.id, fact.version, "retracted", atSeq);', replace: 'const flagged = flagDependents(Object.assign(Object.assign({}, record), { facts: record.facts.filter(({ id }) => id !== fact.id) }), fact.id, fact.version, "retracted", atSeq);' })));
  await assertCaughtBy("a retraction blanking the statement", RETRACT, () => checkRetract(variant({ find: 'status: "retracted", retraction: { reason: event.reason, atSeq, replacedByUnknown: event.unknown === null', replace: 'status: "retracted", statement: "", retraction: { reason: event.reason, atSeq, replacedByUnknown: event.unknown === null' })));
  await assertCaughtBy("a retraction dropping the unknown", RETRACT, () => checkRetract(variant({ find: "return accept(event.unknown === null ? flagged : Object.assign(Object.assign({}, flagged), { unknowns: [...flagged.unknowns, unknownFrom(event.unknown)] }));", replace: "return accept(flagged);" })));
  await assertCaughtBy("a retracted fact still citable", RETRACT, () => checkRetract(variant({ find: 'if (claim.status !== "current" || claim.version !== cite.version)', replace: "if (claim.version !== cite.version)" })));
  await assertCaughtBy("a retracted fact still superseded", RETRACT, () => checkRetract(variant({ find: 'const fact = findFact(record, event.fact);\n    if (isRefused(fact))\n        return fact;\n    if (fact.status !== "current")\n        return refuse("fact-not-current", "fact");\n    if (fact.statement', replace: 'const fact = findFact(record, event.fact);\n    if (isRefused(fact))\n        return fact;\n    if (fact.statement' })));
});

const ASSERTION = "an assertion is unverified, cannot be cited, and retracts into an unknown beside it";

const checkAssertion = (module: Module) => {
  const record = apply(module, ASSERTION, seeded(), assertionEvent("bravo"));
  const facted = apply(module, ASSERTION, record, factEvent("alpha", ["row-lantern"]));
  holds(ASSERTION, facted.assertions[0].status === "unverified" && facted.assertions[0].citable === false, () => facted.assertions);
  refused(module, ASSERTION, facted, interpretation("reads-bravo", [{ fact: "bravo", version: 1 }]), "cites-assertion");
  refused(module, ASSERTION, facted, interpretation("reads-both", [{ fact: "alpha", version: 1 }, { fact: "bravo", version: 1 }]), "cites-assertion");
  const retracted = apply(module, ASSERTION, facted, retractAssertion("bravo", "question-two"), OWNER, WORLD, 41);
  const [assertion] = retracted.assertions;
  holds(ASSERTION, assertion.status === "retracted" && assertion.statement === "Someone said bravo." && assertion.kind === "assertion", () => assertion);
  holds(ASSERTION, JSON.stringify(assertion.retraction) === JSON.stringify({ reason: "Nothing recorded backs it.", atSeq: 41, replacedByUnknown: "question-two" }), () => assertion);
  holds(ASSERTION, retracted.unknowns.map(({ id, kind }) => `${id}:${kind}`).join() === "question-two:unknown", () => retracted.unknowns);
  holds(ASSERTION, retracted.facts.every(({ statement }) => !statement.includes("bravo")), () => retracted.facts);
  refused(module, ASSERTION, retracted, retractAssertion("bravo", "question-three"), "assertion-already-retracted");
  refused(module, ASSERTION, retracted, interpretation("reads-bravo", [{ fact: "bravo", version: 1 }]), "cites-assertion");
};

test("an assertion stays an assertion, and retracting it adds an unknown beside it", async () => {
  checkAssertion(production);
  await assertCaughtBy("an assertion citable as a fact", ASSERTION, () => checkAssertion(variant({ find: 'if (claim.kind === "assertion")\n        return refuse("cites-assertion", "cites");', replace: 'if (claim.kind === "assertion")\n        return null;' })));
  await assertCaughtBy("a retraction removing the statement", ASSERTION, () => checkAssertion(variant({ find: '{ status: "retracted", retraction: { reason: event.reason, atSeq, replacedByUnknown: event.unknown.id } }', replace: '{ status: "retracted", statement: "", retraction: { reason: event.reason, atSeq, replacedByUnknown: event.unknown.id } }' })));
  await assertCaughtBy("a retraction adding no unknown", ASSERTION, () => checkAssertion(variant({ find: "unknowns: [...record.unknowns, unknownFrom(event.unknown)] }));\n}\nfunction interpretationRecorded", replace: "unknowns: record.unknowns }));\n}\nfunction interpretationRecorded" })));
  await assertCaughtBy("a retraction twice", ASSERTION, () => checkAssertion(variant({ find: 'if (claim.status === "retracted")\n        return refuse("assertion-already-retracted", "assertion");', replace: "" })));
  await assertCaughtBy("an assertion that starts out verified", ASSERTION, () => checkAssertion(variant({ find: 'status: "unverified"', replace: 'status: "current"' })));
});

const CITATION = "a cite stands only on a current fact at its current version";

const checkCitation = (module: Module) => {
  const record = dependents(module);
  const assertioned = apply(module, CITATION, apply(module, CITATION, record, assertionEvent("bravo")), { type: "unknown-recorded", unknown: unknownInput("delta") });
  refused(module, CITATION, assertioned, interpretation("x-one", []), "interpretation-needs-cites");
  refused(module, CITATION, assertioned, interpretation("x-one", [{ fact: "nowhere", version: 1 }]), "cites-no-such-fact");
  refused(module, CITATION, assertioned, interpretation("x-one", [{ fact: "bravo", version: 1 }]), "cites-assertion");
  refused(module, CITATION, assertioned, interpretation("x-one", [{ fact: "delta", version: 1 }]), "cites-unknown");
  refused(module, CITATION, assertioned, interpretation("x-one", [{ fact: "reads-alpha", version: 1 }]), "cites-interpretation");
  refused(module, CITATION, assertioned, interpretation("x-one", [{ fact: "alpha", version: 2 }]), "cite-not-current");
  refused(module, CITATION, assertioned, interpretation("x-one", [{ fact: "alpha", version: 1 }, { fact: "alpha", version: 1 }]), "cites-repeated");
  refused(module, CITATION, assertioned, interpretation("x-one", [{ fact: "alpha", version: 1 }, { fact: "echo", version: 1 }, { fact: "alpha", version: 1 }]), "cites-repeated");
  // The second cite is the bad one, so a check of only the first is seen.
  refused(module, CITATION, assertioned, interpretation("x-one", [{ fact: "alpha", version: 1 }, { fact: "echo", version: 9 }]), "cite-not-current");
  apply(module, CITATION, assertioned, interpretation("x-one", [{ fact: "alpha", version: 1 }, { fact: "echo", version: 1 }]));
};

const REAFFIRM = "reaffirming binds an interpretation to current fact versions, and a later change flags it again";

const checkReaffirm = (module: Module) => {
  const changed = apply(module, REAFFIRM, dependents(module), supersede("alpha", "New wording of alpha."));
  refused(module, REAFFIRM, changed, reaffirm("reads-echo", [{ fact: "echo", version: 1 }]), "not-flagged");
  refused(module, REAFFIRM, changed, reaffirm("reads-alpha", []), "interpretation-needs-cites");
  refused(module, REAFFIRM, changed, reaffirm("reads-alpha", [{ fact: "alpha", version: 1 }]), "cite-not-current");
  refused(module, REAFFIRM, changed, reaffirm("reads-both", [{ fact: "alpha", version: 2 }, { fact: "echo", version: 7 }]), "cite-not-current");
  // Exactly its facts: not a duplicate, not one fewer, not one more, and not another in its place.
  refused(module, REAFFIRM, changed, reaffirm("reads-alpha", [{ fact: "alpha", version: 2 }, { fact: "alpha", version: 2 }]), "cites-repeated");
  refused(module, REAFFIRM, changed, reaffirm("reads-both", [{ fact: "alpha", version: 2 }, { fact: "alpha", version: 2 }]), "cites-repeated");
  refused(module, REAFFIRM, changed, reaffirm("reads-both", [{ fact: "echo", version: 1 }]), "cites-not-its-facts");
  refused(module, REAFFIRM, changed, reaffirm("reads-both", [{ fact: "alpha", version: 2 }]), "cites-not-its-facts");
  refused(module, REAFFIRM, changed, reaffirm("reads-alpha", [{ fact: "alpha", version: 2 }, { fact: "echo", version: 1 }]), "cites-not-its-facts");
  refused(module, REAFFIRM, changed, reaffirm("reads-alpha", [{ fact: "echo", version: 1 }]), "cites-not-its-facts");
  // As many facts as it cites, and one of them its own: one in place of another is still not its facts.
  const another = apply(module, REAFFIRM, changed, factEvent("foxtrot", ["row-thimble"]));
  refused(module, REAFFIRM, another, reaffirm("reads-both", [{ fact: "alpha", version: 2 }, { fact: "foxtrot", version: 1 }]), "cites-not-its-facts");
  refused(module, REAFFIRM, another, reaffirm("reads-both", [{ fact: "foxtrot", version: 1 }, { fact: "echo", version: 1 }]), "cites-not-its-facts");
  // In either order, since the set is what it binds to.
  apply(module, REAFFIRM, changed, reaffirm("reads-both", [{ fact: "alpha", version: 2 }, { fact: "echo", version: 1 }]));
  const reaffirmed = apply(module, REAFFIRM, changed, reaffirm("reads-alpha", [{ fact: "alpha", version: 2 }]));
  const after = reviewOf(reaffirmed, "reads-alpha");
  holds(REAFFIRM, JSON.stringify(after) === JSON.stringify({ review: "current", flags: [], cites: [{ fact: "alpha", version: 2 }] }), () => after);
  holds(REAFFIRM, (reaffirmed.interpretations.find(({ id }) => id === "reads-alpha") as Interpretation).reaffirmations === 1, () => reaffirmed);
  // Only this one moved. Another still flagged stays flagged.
  holds(REAFFIRM, reviewOf(reaffirmed, "reads-both").review === "needs_review", () => reaffirmed.interpretations);
  const again = apply(module, REAFFIRM, reaffirmed, supersede("alpha", "A third wording."));
  holds(REAFFIRM, reviewOf(again, "reads-alpha").review === "needs_review" && reviewOf(again, "reads-alpha").flags.length === 1, () => again.interpretations);
  // Resting on a retracted fact, nothing clears it: not keeping the fact, and not dropping it. The owner writes a new one.
  const gone = apply(module, REAFFIRM, again, retractFact("echo"));
  refused(module, REAFFIRM, gone, reaffirm("reads-both", [{ fact: "echo", version: 1 }, { fact: "alpha", version: 3 }]), "cite-not-current");
  refused(module, REAFFIRM, gone, reaffirm("reads-both", [{ fact: "alpha", version: 3 }]), "cites-not-its-facts");
  holds(REAFFIRM, reviewOf(gone, "reads-both").review === "needs_review", () => gone.interpretations);
  const rewritten = apply(module, REAFFIRM, gone, interpretation("reads-alpha-alone", [{ fact: "alpha", version: 3 }]));
  holds(REAFFIRM, reviewOf(rewritten, "reads-alpha-alone").review === "current" && reviewOf(rewritten, "reads-both").review === "needs_review", () => rewritten.interpretations);
};

test("citations and reaffirmation", async () => {
  checkCitation(production);
  checkReaffirm(production);
  await assertCaughtBy("an interpretation citing nothing", CITATION, () => checkCitation(variant({ find: 'if (event.cites.length === 0)\n        return refuse("interpretation-needs-cites", "cites");\n    if (hasRepeatedCite(event.cites))\n        return refuse("cites-repeated", "cites");\n    for (const cite of event.cites) {\n        const refusal = citeRefusal(record, cite);\n        if (refusal !== null)\n            return refusal;\n    }\n    return accept(Object.assign', replace: 'if (hasRepeatedCite(event.cites))\n        return refuse("cites-repeated", "cites");\n    for (const cite of event.cites) {\n        const refusal = citeRefusal(record, cite);\n        if (refusal !== null)\n            return refusal;\n    }\n    return accept(Object.assign' })));
  await assertCaughtBy("an interpretation citing an unknown", CITATION, () => checkCitation(variant({ find: 'if (claim.kind === "unknown")\n        return refuse("cites-unknown", "cites");', replace: 'if (claim.kind === "unknown")\n        return null;' })));
  await assertCaughtBy("an interpretation citing an interpretation", CITATION, () => checkCitation(variant({ find: 'if (claim.kind === "interpretation")\n        return refuse("cites-interpretation", "cites");', replace: 'if (claim.kind === "interpretation")\n        return null;' })));
  await assertCaughtBy("a cite of a version that was never current", CITATION, () => checkCitation(variant({ find: 'if (claim.status !== "current" || claim.version !== cite.version)', replace: 'if (claim.status !== "current")' })));
  await assertCaughtBy("only the first cite checked", CITATION, () => checkCitation(variant({ find: 'for (const cite of event.cites) {\n        const refusal = citeRefusal(record, cite);\n        if (refusal !== null)\n            return refusal;\n    }\n    return accept(Object.assign(Object.assign({}, record), { interpretations: [...record.interpretations,', replace: 'for (const cite of event.cites.slice(0, 1)) {\n        const refusal = citeRefusal(record, cite);\n        if (refusal !== null)\n            return refusal;\n    }\n    return accept(Object.assign(Object.assign({}, record), { interpretations: [...record.interpretations,' })));
  await assertCaughtBy("an interpretation citing a fact twice", CITATION, () => checkCitation(variant({ find: 'if (event.cites.length === 0)\n        return refuse("interpretation-needs-cites", "cites");\n    if (hasRepeatedCite(event.cites))\n        return refuse("cites-repeated", "cites");\n    for (const cite of event.cites) {\n        const refusal = citeRefusal(record, cite);\n        if (refusal !== null)\n            return refusal;\n    }\n    return accept(Object.assign', replace: 'if (event.cites.length === 0)\n        return refuse("interpretation-needs-cites", "cites");\n    for (const cite of event.cites) {\n        const refusal = citeRefusal(record, cite);\n        if (refusal !== null)\n            return refusal;\n    }\n    return accept(Object.assign' })));
  await assertCaughtBy("a reaffirm citing a fact twice", REAFFIRM, () => checkReaffirm(variant({ find: 'if (hasRepeatedCite(event.cites))\n        return refuse("cites-repeated", "cites");\n    // Exactly', replace: "// Exactly" })));
  await assertCaughtBy("a reaffirm dropping or adding a fact", REAFFIRM, () => checkReaffirm(variant({ find: 'if (event.cites.length !== claim.cites.length || !event.cites.every(({ fact }) => claim.cites.some((cite) => cite.fact === fact)))\n        return refuse("cites-not-its-facts", "cites");', replace: "" })));
  await assertCaughtBy("a reaffirm only as long as its facts", REAFFIRM, () => checkReaffirm(variant({ find: 'if (event.cites.length !== claim.cites.length || !event.cites.every(({ fact }) => claim.cites.some((cite) => cite.fact === fact)))', replace: "if (event.cites.length !== claim.cites.length)" })));
  await assertCaughtBy("a reaffirm that needs only one fact in common", REAFFIRM, () => checkReaffirm(variant({ find: "!event.cites.every(({ fact }) => claim.cites.some((cite) => cite.fact === fact))", replace: "!event.cites.some(({ fact }) => claim.cites.some((cite) => cite.fact === fact))" })));
  await assertCaughtBy("a reaffirm dropping a fact", REAFFIRM, () => checkReaffirm(variant({ find: 'if (event.cites.length !== claim.cites.length || !event.cites.every(({ fact }) => claim.cites.some((cite) => cite.fact === fact)))', replace: "if (!event.cites.every(({ fact }) => claim.cites.some((cite) => cite.fact === fact)))" })));
  await assertCaughtBy("a reaffirm with nothing flagged", REAFFIRM, () => checkReaffirm(variant({ find: 'if (claim.review !== "needs_review")\n        return refuse("not-flagged", "interpretation");', replace: "" })));
  await assertCaughtBy("a reaffirm to an old version", REAFFIRM, () => checkReaffirm(variant({ find: 'for (const cite of event.cites) {\n        const refusal = citeRefusal(record, cite);\n        if (refusal !== null)\n            return refusal;\n    }\n    const reaffirmed', replace: "const reaffirmed" })));
  await assertCaughtBy("a reaffirm with no cites", REAFFIRM, () => checkReaffirm(variant({ find: 'if (event.cites.length === 0)\n        return refuse("interpretation-needs-cites", "cites");\n    if (hasRepeatedCite(event.cites))\n        return refuse("cites-repeated", "cites");\n    // Exactly', replace: 'if (hasRepeatedCite(event.cites))\n        return refuse("cites-repeated", "cites");\n    // Exactly' })));
  await assertCaughtBy("a reaffirm that leaves the flags", REAFFIRM, () => checkReaffirm(variant({ find: 'cites: event.cites, review: "current", flags: [], reaffirmations: claim.reaffirmations + 1', replace: 'cites: event.cites, review: "current", reaffirmations: claim.reaffirmations + 1' })));
  await assertCaughtBy("a reaffirm that leaves the review open", REAFFIRM, () => checkReaffirm(variant({ find: 'cites: event.cites, review: "current", flags: [], reaffirmations: claim.reaffirmations + 1', replace: "cites: event.cites, flags: [], reaffirmations: claim.reaffirmations + 1" })));
  await assertCaughtBy("a reaffirm that keeps the old cites", REAFFIRM, () => checkReaffirm(variant({ find: 'cites: event.cites, review: "current", flags: [], reaffirmations: claim.reaffirmations + 1', replace: 'review: "current", flags: [], reaffirmations: claim.reaffirmations + 1' })));
  await assertCaughtBy("a reaffirm that clears every interpretation", REAFFIRM, () => checkReaffirm(variant({ find: "interpretations: record.interpretations.map((existing) => (existing.id === claim.id ? reaffirmed : existing))", replace: 'interpretations: record.interpretations.map((existing) => (existing.id === claim.id ? reaffirmed : Object.assign(Object.assign({}, existing), { review: "current", flags: [] })))' })));
});

const WHO = "a claim is the owner's, and what a capture recorded is its own runner's";

const checkWho = (module: Module) => {
  const record = dependents(module);
  const runner = runnerOf("B1");
  for (const event of [factEvent("x-one", ["row-lantern"]), supersede("alpha"), retractFact("alpha"), assertionEvent("x-two"), retractAssertion("x-two", "x-three"), interpretation("x-four", [{ fact: "alpha", version: 1 }]), reaffirm("reads-alpha", [{ fact: "alpha", version: 1 }]), { type: "unknown-recorded", unknown: unknownInput("x-five") } as RecordEvent, { type: "source-reconstructed", appliesTo: ["B1"], baseCommit: "a1".repeat(20), patchDigest: "ab".repeat(32), identity: "cd".repeat(32) } as RecordEvent]) {
    // The attempt's own runner, the plan's control run, and a runner of some other case.
    for (const by of [runner, CONTROL_RUNNER, FOREIGN_RUNNER]) refused(module, WHO, record, event, "owner-only", by);
  }
  const instrument: RecordEvent = { type: "instrument-recorded", slot: "B1", instrument: "coverage", completeness: "complete", reason: null };
  for (const by of [OWNER, runnerOf("B2"), CONTROL_RUNNER, FOREIGN_RUNNER]) refused(module, WHO, record, instrument, "not-this-attempt", by, B1_RUNNING);
  apply(module, WHO, record, instrument, runner, B1_RUNNING);
  const sourceEvent: RecordEvent = { type: "source-recorded", slot: "B1", commit: "a1".repeat(20), identity: "cd".repeat(32) };
  const stillRunning = driven(machine, WHO, planOf("B1", "B2", "I1", "I2"), frozen, controlMet(), startOf("B1"));
  for (const by of [OWNER, runnerOf("B2"), CONTROL_RUNNER, FOREIGN_RUNNER]) refused(module, WHO, record, sourceEvent, "not-this-attempt", by, stillRunning);
  apply(module, WHO, record, sourceEvent, runner, stillRunning);
  // A slot that never began holds nothing, and one that is not in the plan is refused by name.
  refused(module, WHO, record, { ...instrument, slot: "B2" }, "attempt-not-begun", runnerOf("B2"));
  refused(module, WHO, record, { ...instrument, slot: "I3" }, "no-such-slot", runnerOf("I3"));
};

test("claims come from the owner, and a capture's records from its own runner", async () => {
  checkWho(production);
  await assertCaughtBy("a claim from a runner", WHO, () => checkWho(variant({ find: 'if (by.kind !== "owner")\n        return refuse("owner-only");', replace: "" })));
  await assertCaughtBy("a capture's record from anyone", WHO, () => checkWho(variant({ find: 'if (by.kind !== "system:runner" || by.attemptId !== attempt.attemptId)\n            return refuse("not-this-attempt", "slot");', replace: "" })));
  await assertCaughtBy("a claim from the plan's control run", WHO, () => checkWho(variant({ find: 'if (by.kind !== "owner")\n        return refuse("owner-only");', replace: 'if (by.kind !== "owner" && by.attemptId !== machine.controlRunId)\n        return refuse("owner-only");' })));
  await assertCaughtBy("a claim from a runner of another case", WHO, () => checkWho(variant({ find: 'if (by.kind !== "owner")\n        return refuse("owner-only");', replace: 'if (by.kind !== "owner" && machine.attempts.some(({ attemptId }) => attemptId === by.attemptId))\n        return refuse("owner-only");' })));
  await assertCaughtBy("a capture's record from the plan's control run", WHO, () => checkWho(variant({ find: 'if (by.kind !== "system:runner" || by.attemptId !== attempt.attemptId)\n            return refuse("not-this-attempt", "slot");', replace: 'if (by.kind !== "system:runner" || (by.attemptId !== attempt.attemptId && by.attemptId !== machine.controlRunId))\n            return refuse("not-this-attempt", "slot");' })));
  await assertCaughtBy("a capture's record from any runner", WHO, () => checkWho(variant({ find: 'if (by.kind !== "system:runner" || by.attemptId !== attempt.attemptId)', replace: 'if (by.kind !== "system:runner")' })));
  await assertCaughtBy("a record for a slot that never began", WHO, () => checkWho(variant({ find: 'if (!hasBegun(attempt.phase))\n            return refuse("attempt-not-begun", "slot");', replace: "" })));
});

const SOURCE = "a source identity is never guessed, and the three states stay apart";

const COMMIT_ONE = "a1".repeat(20);
const COMMIT_TWO = "b2".repeat(20);
const IDENTITY_ONE = "11".repeat(32);
const IDENTITY_TWO = "22".repeat(32);
const PATCH = "33".repeat(32);

type Ending = "usable" | "incomplete" | "walled" | "failed" | "timed_out" | "cancelled";

/** B1 ended the given way, in a plan with I1 after it. */
const endedAs = (outcome: Ending): MachineState => {
  const closing = outcome === "timed_out" ? ({ type: "attempt-deadline", slot: "B1", by: OWNER } as const) : outcome === "cancelled" ? ({ type: "case-cancelled", by: OWNER } as const) : finishOf("B1", outcome);
  return driven(machine, "the path runs", planOf("B1", "I1"), frozen, controlMet(), startOf("B1"), ...captureOf("B1"), closing);
};

const ENDINGS: readonly Ending[] = ["usable", "incomplete", "walled", "failed", "timed_out", "cancelled"];

const checkSource = (module: Module) => {
  const reconstruct = (appliesTo: readonly SlotName[]): RecordEvent => ({ type: "source-reconstructed", appliesTo, baseCommit: COMMIT_ONE, patchDigest: PATCH, identity: IDENTITY_ONE });
  // B1 ended, B2 runs, I1 has not begun.
  const running = driven(machine, SOURCE, planOf("B1", "B2", "I1"), frozen, controlMet(), startOf("B1"), ...captureOf("B1"), finishOf("B1"), { type: "cleanup-confirmed", slot: "B1", by: OWNER }, startOf("B2"));
  // What ran can record what it ran as, only while it runs. Afterward nothing can fill in a missing identity.
  refused(module, SOURCE, production.EMPTY_RECORD, { type: "source-recorded", slot: "B1", commit: COMMIT_ONE, identity: IDENTITY_ONE }, "source-after-attempt", runnerOf("B1"), running);
  for (const outcome of ENDINGS) refused(module, SOURCE, production.EMPTY_RECORD, { type: "source-recorded", slot: "B1", commit: COMMIT_ONE, identity: IDENTITY_ONE }, "source-after-attempt", runnerOf("B1"), endedAs(outcome));
  // Each moment a capture runs in can.
  for (const moment of [[startOf("B1")], [startOf("B1"), ...captureOf("B1")]] as const) {
    const world = driven(machine, SOURCE, planOf("B1", "I1"), frozen, controlMet(), ...moment);
    apply(module, SOURCE, production.EMPTY_RECORD, { type: "source-recorded", slot: "B1", commit: COMMIT_ONE, identity: IDENTITY_ONE }, runnerOf("B1"), world);
  }

  let record = production.EMPTY_RECORD;
  // Nothing recorded yet: nothing is known of any slot.
  for (const slot of ["B1", "B2", "I1"] as const) holds(SOURCE, JSON.stringify(module.sourceIdentityOf(record, slot)) === '{"state":"not_recorded"}', () => slot);
  refused(module, SOURCE, record, reconstruct([]), "source-needs-slots", OWNER, running);
  refused(module, SOURCE, record, reconstruct(["B1", "I3"]), "no-such-slot", OWNER, running);

  // Never ahead of a visit, and never of a slot that did not run: first, last and alone.
  refused(module, SOURCE, record, reconstruct(["B2"]), "source-attempt-not-ended", OWNER, running);
  refused(module, SOURCE, record, reconstruct(["I1"]), "source-attempt-not-ended", OWNER, running);
  refused(module, SOURCE, record, reconstruct(["B1", "I1"]), "source-attempt-not-ended", OWNER, running);
  refused(module, SOURCE, record, reconstruct(["I1", "B1"]), "source-attempt-not-ended", OWNER, running);
  // A slot that a cancel turned to not_started did not run either.
  const cancelled = endedAs("cancelled");
  holds(SOURCE, cancelled.attempts[1].phase === "not_started", () => cancelled.attempts);
  refused(module, SOURCE, record, reconstruct(["I1"]), "source-attempt-not-ended", OWNER, cancelled);
  // However a visit ended, it ended.
  for (const outcome of ENDINGS) apply(module, SOURCE, record, reconstruct(["B1"]), OWNER, endedAs(outcome));

  record = apply(module, SOURCE, record, { type: "source-recorded", slot: "B2", commit: COMMIT_TWO, identity: IDENTITY_TWO }, runnerOf("B2"), running);
  refused(module, SOURCE, record, { type: "source-recorded", slot: "B2", commit: COMMIT_ONE, identity: IDENTITY_ONE }, "source-already-recorded", runnerOf("B2"), running);
  const bothEnded = driven(machine, SOURCE, planOf("B1", "B2", "I1"), frozen, controlMet(), startOf("B1"), ...captureOf("B1"), finishOf("B1"), { type: "cleanup-confirmed", slot: "B1", by: OWNER }, startOf("B2"), ...captureOf("B2"), finishOf("B2"));
  refused(module, SOURCE, record, reconstruct(["B1", "B2"]), "source-slot-recorded", OWNER, bothEnded);
  refused(module, SOURCE, record, reconstruct(["B2", "B1"]), "source-slot-recorded", OWNER, bothEnded);

  record = apply(module, SOURCE, record, reconstruct(["B1"]), OWNER, bothEnded);
  // One block, once: it cannot be widened to cover a slot it left out, however good that slot's claim.
  const allEnded = driven(machine, SOURCE, planOf("B1", "B2", "I1"), frozen, controlMet(), startOf("B1"), ...captureOf("B1"), finishOf("B1"), { type: "cleanup-confirmed", slot: "B1", by: OWNER }, startOf("B2"), ...captureOf("B2"), finishOf("B2"), { type: "cleanup-confirmed", slot: "B2", by: OWNER }, { type: "baseline-rule-recorded", result: "met", by: OWNER }, startOf("I1"), ...captureOf("I1"), finishOf("I1"));
  refused(module, SOURCE, record, reconstruct(["I1"]), "source-already-reconstructed", OWNER, allEnded);

  holds(SOURCE, JSON.stringify(module.sourceIdentityOf(record, "B1")) === JSON.stringify({ state: "reconstructed", baseCommit: COMMIT_ONE, patchDigest: PATCH, identity: IDENTITY_ONE }), () => module.sourceIdentityOf(record, "B1"));
  holds(SOURCE, JSON.stringify(module.sourceIdentityOf(record, "B2")) === JSON.stringify({ state: "recorded", commit: COMMIT_TWO, identity: IDENTITY_TWO }), () => module.sourceIdentityOf(record, "B2"));
  // The slot between them: its neighbors' identities do not reach it.
  holds(SOURCE, JSON.stringify(module.sourceIdentityOf(record, "I1")) === '{"state":"not_recorded"}', () => module.sourceIdentityOf(record, "I1"));
};

test("missing, reconstructed and recorded source identities stay apart, and none is guessed", async () => {
  checkSource(production);
  await assertCaughtBy("a missing identity filled in from the block", SOURCE, () => checkSource(variant({ find: "if (block === null || block === void 0 ? void 0 : block.appliesTo.includes(slot))", replace: "if (block)" })));
  await assertCaughtBy("a missing identity filled in from a neighbor", SOURCE, () => checkSource(variant({ find: "const recorded = record.recordedSources.find((source) => source.slot === slot);", replace: "const recorded = record.recordedSources[0];" })));
  await assertCaughtBy("a block widened after the fact", SOURCE, () => checkSource(variant({ find: 'if (record.reconstructedSource !== null)\n        return refuse("source-already-reconstructed");', replace: "" })));
  await assertCaughtBy("a block covering a recorded slot", SOURCE, () => checkSource(variant({ find: 'if (event.appliesTo.some((slot) => record.recordedSources.some((source) => source.slot === slot)))\n        return refuse("source-slot-recorded", "appliesTo");', replace: "" })));
  await assertCaughtBy("a block covering no slot", SOURCE, () => checkSource(variant({ find: 'if (event.appliesTo.length === 0)\n        return refuse("source-needs-slots", "appliesTo");', replace: "" })));
  await assertCaughtBy("a block over a slot not planned", SOURCE, () => checkSource(variant({ find: 'if (event.appliesTo.some((slot) => attemptOf(machine, slot) === null))\n                return refuse("no-such-slot", "appliesTo");', replace: "" })));
  await assertCaughtBy("a block over a visit not yet ended, or never run", SOURCE, () => checkSource(variant({ find: 'return ended ? sourceReconstructed(record, event) : refuse("source-attempt-not-ended", "appliesTo");', replace: "return sourceReconstructed(record, event);" })));
  await assertCaughtBy("a block that needs only one of its slots ended", SOURCE, () => checkSource(variant({ find: "const ended = event.appliesTo.every((slot) => {", replace: "const ended = event.appliesTo.length === 0 || event.appliesTo.some((slot) => {" })));
  await assertCaughtBy("a block over a slot that has begun, ended or not", SOURCE, () => checkSource(variant({ find: "return attempt !== null && (0, case_machine_1.isOutcome)(attempt.phase);", replace: "return attempt !== null && hasBegun(attempt.phase);" })));
  await assertCaughtBy("a block over any slot not still planned", SOURCE, () => checkSource(variant({ find: "return attempt !== null && (0, case_machine_1.isOutcome)(attempt.phase);", replace: 'return attempt !== null && attempt.phase !== "planned";' })));
  await assertCaughtBy("an identity filled in after the attempt ended", SOURCE, () => checkSource(variant({ find: 'return (0, case_machine_1.isRunningPhase)(attempt.phase) ? sourceRecorded(record, event) : refuse("source-after-attempt", "slot");', replace: "return sourceRecorded(record, event);" })));
  await assertCaughtBy("a recorded identity rewritten", SOURCE, () => checkSource(variant({ find: 'if (record.recordedSources.some(({ slot }) => slot === event.slot))\n        return refuse("source-already-recorded", "slot");', replace: "" })));
});

const INSTRUMENT = "an instrument that gave nothing has no present row, in either order";

const checkInstrument = (module: Module) => {
  const missing: RecordEvent = { type: "instrument-recorded", slot: "B1", instrument: "inspect", completeness: "missing", reason: "output-lost" };
  const runner = runnerOf("B1");
  const said = apply(module, INSTRUMENT, production.EMPTY_RECORD, missing, runner, B1_RUNNING);
  holds(INSTRUMENT, JSON.stringify(said.instruments) === JSON.stringify([{ slot: "B1", instrument: "inspect", completeness: "missing", reason: "output-lost" }]), () => said);
  const refusedRow = module.addRow(said, row("row-inspect", "B1", "inspect"), "capturing");
  holds(INSTRUMENT, !refusedRow.ok && refusedRow.refusal === "row-from-missing-instrument", () => refusedRow);
  // A row of another instrument, or the same instrument in another attempt, is not touched by that.
  holds(INSTRUMENT, module.addRow(said, row("row-other", "B1", "coverage"), "capturing").ok, () => "another instrument");
  holds(INSTRUMENT, module.addRow(said, row("row-elsewhere", "I1", "inspect"), "capturing").ok, () => "another attempt");
  // A no_record row from it is what it should have.
  holds(INSTRUMENT, module.addRow(said, row("row-inspect", "B1", "inspect", "no_record"), "capturing").ok, () => "a no_record row");

  const withRow = module.addRow(production.EMPTY_RECORD, row("row-inspect", "B1", "inspect"), "capturing");
  holds(INSTRUMENT, withRow.ok, () => withRow);
  refused(module, INSTRUMENT, (withRow as Extract<production.RecordResult, { ok: true }>).record, missing, "instrument-missing-has-row", runner, B1_RUNNING);
  refused(module, INSTRUMENT, said, missing, "instrument-already-recorded", runner, B1_RUNNING);
  apply(module, INSTRUMENT, said, { ...missing, instrument: "coverage" }, runner, B1_RUNNING);
  // Saying so after the attempt ended would turn a reading complete, so it is refused, by the moment and not by the instrument.
  const complete: RecordEvent = { type: "instrument-recorded", slot: "B1", instrument: "coverage", completeness: "complete", reason: null };
  for (const outcome of ENDINGS) refused(module, INSTRUMENT, production.EMPTY_RECORD, complete, "instrument-after-attempt", runner, endedAs(outcome));
  refused(module, INSTRUMENT, production.EMPTY_RECORD, complete, "instrument-after-attempt", runner, WORLD);
  apply(module, INSTRUMENT, production.EMPTY_RECORD, complete, runner, B1_RUNNING);
  apply(module, INSTRUMENT, production.EMPTY_RECORD, complete, runner, driven(machine, INSTRUMENT, planOf("B1", "I1"), frozen, controlMet(), startOf("B1"), ...captureOf("B1")));
};

test("an instrument's completeness and its rows cannot disagree", async () => {
  checkInstrument(production);
  await assertCaughtBy("a present row from a missing instrument", INSTRUMENT, () => checkInstrument(variant({ find: 'if (missing && row.state === "present")\n        return refuse("row-from-missing-instrument", "row.instrument");', replace: "" })));
  await assertCaughtBy("any row from a missing instrument", INSTRUMENT, () => checkInstrument(variant({ find: 'if (missing && row.state === "present")', replace: "if (missing)" })));
  await assertCaughtBy("missing read across instruments", INSTRUMENT, () => checkInstrument(variant({ find: 'slot === row.slot && instrument === row.instrument && completeness === "missing"', replace: 'slot === row.slot && completeness === "missing"' })));
  await assertCaughtBy("missing read across attempts", INSTRUMENT, () => checkInstrument(variant({ find: 'slot === row.slot && instrument === row.instrument && completeness === "missing"', replace: 'instrument === row.instrument && completeness === "missing"' })));
  await assertCaughtBy("missing recorded over a present row", INSTRUMENT, () => checkInstrument(variant({ find: 'if (event.completeness === "missing" && record.rows.some((row) => row.slot === event.slot && row.instrument === event.instrument && row.state === "present")) {\n        return refuse("instrument-missing-has-row", "instrument");\n    }', replace: "" })));
  await assertCaughtBy("completeness rewritten", INSTRUMENT, () => checkInstrument(variant({ find: 'if (already)\n        return refuse("instrument-already-recorded", "instrument");', replace: "" })));
  await assertCaughtBy("completeness said after the attempt ended", INSTRUMENT, () => checkInstrument(variant({ find: 'return (0, case_machine_1.isRunningPhase)(attempt.phase) ? instrumentRecorded(record, event) : refuse("instrument-after-attempt", "slot");', replace: "return instrumentRecorded(record, event);" })));
});

const NO_CLAIM = "a claim that is not there is refused by that name";

const checkNoClaim = (module: Module) => {
  const record = seeded();
  refused(module, NO_CLAIM, record, supersede("nowhere"), "no-such-claim");
  refused(module, NO_CLAIM, record, retractFact("nowhere"), "no-such-claim");
  refused(module, NO_CLAIM, record, retractAssertion("nowhere", "question-two"), "no-such-claim");
  refused(module, NO_CLAIM, record, reaffirm("nowhere", [{ fact: "alpha", version: 1 }]), "no-such-claim");
};

test("a claim that is not there", async () => {
  checkNoClaim(production);
  await assertCaughtBy("a missing claim read as the wrong kind", NO_CLAIM, () => checkNoClaim(variant({ find: 'if (claim === null)\n        return refuse("no-such-claim", "fact");\n    if (claim.kind !== "fact")', replace: 'if (claim === null)\n        return refuse("not-a-fact", "fact");\n    if (claim.kind !== "fact")' })));
});

const LATE = "a row after its attempt ended is kept and labeled late; a count above 0 reads observed with late as a limit and complete withheld, and can back a fact with that limit on its link, and a late 0 says nothing";

const observed = (over: Partial<NonNullable<EvidenceRow["observation"]>> = {}): NonNullable<EvidenceRow["observation"]> => ({ subject: "subject-lantern", count: 3, granularity: "block", windowEnd: "window_closed", scope: "in_scope", ...over });

const FULLY_COMPLETE: EvidenceRecord = { ...production.EMPTY_RECORD, instruments: [{ slot: "B1", instrument: "coverage", completeness: "complete", reason: null }] };
/** B1 ended usable with its cleanup confirmed, so late is the only thing a reading of it could have against it. */
const B1_SETTLED: MachineState = driven(machine, "the path runs", planOf("B1", "I1"), frozen, controlMet(), startOf("B1"), ...captureOf("B1"), finishOf("B1"), { type: "cleanup-confirmed", slot: "B1", by: OWNER });

const checkLate = (module: Module) => {
  for (const phase of ["usable", "walled", "failed", "incomplete", "timed_out", "cancelled"] as const) {
    const kept = module.addRow(production.EMPTY_RECORD, row("row-late", "B1", "coverage"), phase);
    holds(LATE, kept.ok, () => kept);
    const { record } = kept as Extract<production.RecordResult, { ok: true }>;
    holds(LATE, record.rows[0].state === "late" && record.rows[0].digest === "ab".repeat(32), () => record.rows);
    refused(module, LATE, record, factEvent("alpha", ["row-late"]), "row-not-present");
  }
  for (const phase of ["starting", "capturing", "finalizing"] as const) {
    const kept = module.addRow(production.EMPTY_RECORD, row("row-on-time", "B1", "coverage"), phase);
    holds(LATE, kept.ok && kept.record.rows[0].state === "present", () => kept);
  }

  // Even a row that claimed it was on time, with every other condition met.
  const positive = module.addRow(FULLY_COMPLETE, row("row-late-seen", "B1", "coverage", "present", { limits: ["main-frame-only"], observation: observed({ count: 2 }) }), "usable");
  const { record: withPositive } = positive as Extract<production.RecordResult, { ok: true }>;
  holds(LATE, positive.ok && withPositive.rows[0].state === "late", () => positive);
  const lateRow = withPositive.rows[0];
  const reading = module.readRow(withPositive, B1_SETTLED, lateRow);
  holds(LATE, JSON.stringify(reading) === JSON.stringify({ reading: "observed", count: 2, granularity: "block", windowEnd: "window_closed", complete: false, limits: ["late"] }), () => reading);
  // The same row on time, so the limit above is what late alone took away.
  const onTime = module.readRow(withPositive, B1_SETTLED, { ...lateRow, state: "present" });
  holds(LATE, JSON.stringify(onTime) === JSON.stringify({ reading: "observed", count: 2, granularity: "block", windowEnd: "window_closed", complete: true, limits: [] }), () => onTime);
  const backed = apply(module, LATE, withPositive, factEvent("alpha", ["row-late-seen"]), OWNER, B1_SETTLED);
  holds(LATE, JSON.stringify(backed.facts[0].links) === JSON.stringify([{ evidence: "row-late-seen", slot: "B1", instrument: "coverage", window: lateRow.window, limits: ["main-frame-only", "late"] }]), () => backed.facts[0].links);
  // And the row keeps what it had: the limit is on the link.
  holds(LATE, JSON.stringify(backed.rows[0].limits) === '["main-frame-only"]', () => backed.rows);
  // A present row's link is not said to be late.
  const present = module.addRow(FULLY_COMPLETE, row("row-on-time", "B1", "coverage", "present", { limits: ["main-frame-only"], observation: observed({ count: 2 }) }), "capturing");
  const onTimeFact = apply(module, LATE, (present as Extract<production.RecordResult, { ok: true }>).record, factEvent("echo", ["row-on-time"]), OWNER, B1_SETTLED);
  holds(LATE, JSON.stringify(onTimeFact.facts[0].links[0].limits) === '["main-frame-only"]', () => onTimeFact.facts[0]);

  // Everything short of a positive with bytes: it reads unknown for being late, and cannot back a fact.
  const notPositive: readonly (readonly [string, Partial<EvidenceRow>])[] = [
    ["a late 0", { observation: observed({ count: 0 }) }],
    ["a late row with no count", { observation: observed({ count: null }) }],
    ["a late row with no observation", { observation: null }],
    ["a late positive with no bytes", { digest: null, observation: observed({ count: 2 }) }]
  ];
  for (const [name, over] of notPositive) {
    const added = module.addRow(FULLY_COMPLETE, row("row-late-empty", "B1", "coverage", "present", over), "usable");
    const { record } = added as Extract<production.RecordResult, { ok: true }>;
    const read = module.readRow(record, B1_SETTLED, record.rows[0]);
    holds(LATE, JSON.stringify(read) === JSON.stringify({ reading: "unknown", reason: "late", complete: false }), () => ({ name, read }));
    refused(module, LATE, record, factEvent("alpha", ["row-late-empty"]), "row-not-present");
  }
  // A positive stays observed however its attempt ended, and the attempt's own limit stands beside late.
  for (const [outcome, limits] of [["usable", ["cleanup_unresolved", "late"]], ["walled", ["cleanup_unresolved", "attempt_walled", "late"]], ["incomplete", ["cleanup_unresolved", "attempt_incomplete", "late"]], ["failed", ["cleanup_unresolved", "operation_failed", "late"]], ["timed_out", ["cleanup_unresolved", "operation_failed", "late"]], ["cancelled", ["cleanup_unresolved", "operation_failed", "late"]]] as const) {
    const read = module.readRow(FULLY_COMPLETE, endedAs(outcome), lateRow);
    holds(LATE, JSON.stringify(read) === JSON.stringify({ reading: "observed", count: 2, granularity: "block", windowEnd: "window_closed", complete: false, limits }), () => ({ outcome, read }));
  }
};

test("a late row is kept and labeled, a late positive stays observed with the limit in view, and a late 0 says nothing", async () => {
  checkLate(production);
  await assertCaughtBy("a late row kept as present", LATE, () => checkLate(variant({ find: 'const kept = (0, case_machine_1.isOutcome)(phaseBefore) ? Object.assign(Object.assign({}, row), { state: "late" }) : row;', replace: "const kept = row;" })));
  await assertCaughtBy("every row labeled late", LATE, () => checkLate(variant({ find: 'const kept = (0, case_machine_1.isOutcome)(phaseBefore) ? Object.assign(Object.assign({}, row), { state: "late" }) : row;', replace: 'const kept = Object.assign(Object.assign({}, row), { state: "late" });' })));
  await assertCaughtBy("late erasing a positive", LATE, () => checkLate(variant({ find: 'if (row.state !== "present" && !isLatePositive(row))\n        return { reading: "unknown", reason: row.state, complete: false };', replace: 'if (row.state !== "present")\n        return { reading: "unknown", reason: row.state, complete: false };' })));
  await assertCaughtBy("a late 0 read as a 0", LATE, () => checkLate(variant({ find: 'return row.state === "late" && row.digest !== null && count !== null && count > 0;', replace: 'return row.state === "late" && row.digest !== null && count !== null;' })));
  await assertCaughtBy("a late row with no bytes read as observed", LATE, () => checkLate(variant({ find: 'return row.state === "late" && row.digest !== null && count !== null && count > 0;', replace: 'return row.state === "late" && count !== null && count > 0;' })));
  await assertCaughtBy("a late positive no fact can rest on", LATE, () => checkLate(variant({ find: 'if (row.state !== "present" && !isLatePositive(row))\n            return refuse("row-not-present", "evidence");', replace: 'if (row.state !== "present")\n            return refuse("row-not-present", "evidence");' })));
  await assertCaughtBy("a late link hiding its limit", LATE, () => checkLate(variant({ find: 'limits: "limits" in reading ? [...new Set([...row.limits, ...reading.limits])] : row.limits });', replace: "limits: row.limits });" })));
  await assertCaughtBy("every link said to be late", LATE, () => checkLate(variant({ find: 'limits: "limits" in reading ? [...new Set([...row.limits, ...reading.limits])] : row.limits });', replace: 'limits: [...row.limits, "late"] });' })));
  await assertCaughtBy("a late link dropping the row's limits", LATE, () => checkLate(variant({ find: 'limits: "limits" in reading ? [...new Set([...row.limits, ...reading.limits])] : row.limits });', replace: 'limits: "limits" in reading ? reading.limits : row.limits });' })));
  await assertCaughtBy("a late reading left complete", LATE, () => checkLate(variant({ find: 'Object.assign(Object.assign({}, reading), { complete: false, limits: [...reading.limits, "late"] })', replace: 'Object.assign(Object.assign({}, reading), { limits: [...reading.limits, "late"] })' })));
  await assertCaughtBy("a late reading hiding its limit", LATE, () => checkLate(variant({ find: 'Object.assign(Object.assign({}, reading), { complete: false, limits: [...reading.limits, "late"] })', replace: "Object.assign(Object.assign({}, reading), { complete: false })" })));
  await assertCaughtBy("a late reading that drops the attempt's own limits", LATE, () => checkLate(variant({ find: 'Object.assign(Object.assign({}, reading), { complete: false, limits: [...reading.limits, "late"] })', replace: 'Object.assign(Object.assign({}, reading), { complete: false, limits: ["late"] })' })));
});

const LINKS = "a fact's link carries the row's own limits and everything that limited its reading when the fact was recorded";

const checkLinks = (module: Module) => {
  const count0 = (id: string, slot: SlotName, over: Partial<EvidenceRow> = {}) => row(id, slot, "coverage", "present", { limits: ["main-frame-only"], observation: observed({ count: 0 }), ...over });
  const complete: EvidenceRecord["instruments"] = [{ slot: "B1", instrument: "coverage", completeness: "complete", reason: null }];
  const linkOn = (world: MachineState, rowOfLink: EvidenceRow, instruments: EvidenceRecord["instruments"] = complete) => {
    const record: EvidenceRecord = { ...production.EMPTY_RECORD, rows: [rowOfLink], instruments };
    return apply(module, LINKS, record, factEvent("alpha", [rowOfLink.id]), OWNER, world).facts[0].links[0].limits;
  };
  const endedWith = (outcome: "walled" | "incomplete" | "failed") => driven(machine, LINKS, planOf("B1", "I1"), frozen, controlMet(), startOf("B1"), ...captureOf("B1"), finishOf("B1", outcome), { type: "cleanup-confirmed", slot: "B1", by: OWNER });
  // The outcome that limits a 0, spelled, beside the row's own.
  const table: readonly (readonly [string, readonly string[], readonly string[]])[] = [
    ["a walled 0", linkOn(endedWith("walled"), count0("row-one", "B1")), ["main-frame-only", "attempt_walled"]],
    ["an incomplete 0", linkOn(endedWith("incomplete"), count0("row-one", "B1")), ["main-frame-only", "attempt_incomplete"]],
    ["a failed 0", linkOn(endedWith("failed"), count0("row-one", "B1")), ["main-frame-only", "operation_failed"]],
    ["a clean 0", linkOn(B1_SETTLED, count0("row-one", "B1")), ["main-frame-only"]],
    ["a walled positive", linkOn(endedWith("walled"), count0("row-one", "B1", { observation: observed({ count: 3 }) })), ["main-frame-only", "attempt_walled"]],
    ["coverage no instrument said was complete", linkOn(B1_SETTLED, count0("row-one", "B1"), []), ["main-frame-only", "coverage_not_complete"]],
    ["a cleanup still open", linkOn(WORLD, count0("row-one", "B1")), ["main-frame-only", "cleanup_unresolved"]],
    ["function-only", linkOn(B1_SETTLED, count0("row-one", "B1", { observation: observed({ count: 0, granularity: "function" }) })), ["main-frame-only", "function_only"]],
    ["a limit named twice is one limit", linkOn(endedWith("walled"), count0("row-one", "B1", { limits: ["attempt_walled"] })), ["attempt_walled"]],
    ["a row with no observation has no reading to limit it", linkOn(endedWith("walled"), count0("row-one", "B1", { observation: null })), ["main-frame-only"]]
  ];
  for (const [name, actual, expected] of table) holds(LINKS, JSON.stringify(actual) === JSON.stringify(expected), () => ({ name, actual, expected }));
};

test("a fact on a limited reading says so on its link", async () => {
  checkLinks(production);
  await assertCaughtBy("a link with only the row's limits", LINKS, () => checkLinks(variant({ find: 'limits: "limits" in reading ? [...new Set([...row.limits, ...reading.limits])] : row.limits });', replace: "limits: row.limits });" })));
  await assertCaughtBy("a link with only the reading's limits", LINKS, () => checkLinks(variant({ find: 'limits: "limits" in reading ? [...new Set([...row.limits, ...reading.limits])] : row.limits });', replace: 'limits: "limits" in reading ? reading.limits : row.limits });' })));
  await assertCaughtBy("a link naming a limit twice", LINKS, () => checkLinks(variant({ find: "[...new Set([...row.limits, ...reading.limits])]", replace: "[...row.limits, ...reading.limits]" })));
  await assertCaughtBy("a link read from an empty record", LINKS, () => checkLinks(variant({ find: "const reading = readRow(record, machine, row);\n        links.push", replace: "const reading = readRow(exports.EMPTY_RECORD, machine, row);\n        links.push" })));
  assert.deepEqual([...production.UNREAD_STATES], [...NOT_PRESENT]);
});

const ROW_READING = "a row is read through its own state, attempt and instrument, by the table of what it recorded";

const ROW_STATES: readonly RowState[] = ["present", "no_record", "before_window", "out_of_scope", "truncated", "not_read", "late"];
const ROW_DIGESTS: readonly (string | null)[] = ["cd".repeat(32), null];
const ROW_COUNTS: readonly (number | null)[] = [null, 0, 1, 7];
const ROW_GRANULARITIES = ["block", "function"] as const;
const ROW_WINDOW_ENDS = ["window_closed", "truncated", "target_crashed", "operation_failed", "deadline", "cancelled"] as const;
const ROW_SCOPES = ["in_scope", "out_of_scope"] as const;
const ROW_PHASES: readonly AttemptPhase[] = ["planned", "starting", "capturing", "finalizing", "usable", "walled", "failed", "incomplete", "timed_out", "cancelled", "not_started"];
const ROW_CLEANUPS: readonly (Cleanup | null)[] = [null, "pending", "confirmed", "unconfirmed", "environment_destroyed"];
const ROW_INSTRUMENTS = ["none", "complete", "partial", "missing"] as const;
/** states x digests x (no observation + counts x granularities x ends x scopes) x phases x cleanups x instruments */
const ROW_COMBINATIONS = 7 * 2 * (1 + 4 * 2 * 6 * 2) * 11 * 5 * 4;

type Combination = Readonly<{
  state: RowState;
  digest: string | null;
  observation: NonNullable<EvidenceRow["observation"]> | null;
  phase: AttemptPhase;
  cleanup: Cleanup | null;
  instrument: (typeof ROW_INSTRUMENTS)[number];
}>;

/**
 * What a row should read as, written out apart from the module. It RESTATES readObservation and
 * the late rule on purpose, so it shows the module does what this says rather than that the
 * rule is right. The spelled readings below it are the ones that say what the rule is.
 */
function expectedReading({ state, digest, observation, phase, cleanup, instrument }: Combination): unknown {
  const count = observation === null ? null : observation.count;
  const latePositive = state === "late" && digest !== null && count !== null && count > 0;
  if (state !== "present" && !latePositive) return { reading: "unknown", reason: state, complete: false };
  if (observation === null) return { reading: "recorded" };
  const failedOperation = phase === "failed" || phase === "timed_out" || phase === "cancelled";
  const limits = [
    ...(count === null ? ["malformed_record"] : []),
    ...(observation.scope === "out_of_scope" ? ["out_of_scope"] : []),
    ...(observation.windowEnd !== "window_closed" ? ["window_not_closed"] : []),
    ...(instrument !== "complete" ? ["coverage_not_complete"] : []),
    ...(cleanup !== "confirmed" && cleanup !== "environment_destroyed" ? ["cleanup_unresolved"] : []),
    ...(observation.granularity === "function" ? ["function_only"] : []),
    ...(phase === "walled" ? ["attempt_walled"] : []),
    ...(phase === "incomplete" ? ["attempt_incomplete"] : []),
    ...(failedOperation ? ["operation_failed"] : [])
  ];
  const unknown = (reason: string) => ({ reading: "unknown", reason, complete: false, limits });
  if (count === null) return unknown("malformed_record");
  if (count > 0) {
    const shown = state === "late" ? [...limits, "late"] : limits;
    return { reading: "observed", count, granularity: observation.granularity, windowEnd: observation.windowEnd, complete: shown.length === 0, limits: shown };
  }
  if (observation.scope === "out_of_scope") return unknown("out_of_scope");
  if (observation.windowEnd !== "window_closed") return unknown("truncated");
  if (instrument === "missing") return unknown("no_record");
  if (failedOperation) return unknown("operation_failed");
  return { reading: "zero_in_window", granularity: observation.granularity, windowEnd: observation.windowEnd, complete: limits.length === 0, limits };
}

const everyObservation = (): readonly (NonNullable<EvidenceRow["observation"]> | null)[] => [
  null,
  ...ROW_COUNTS.flatMap((count) => ROW_GRANULARITIES.flatMap((granularity) => ROW_WINDOW_ENDS.flatMap((windowEnd) => ROW_SCOPES.map((scope) => ({ subject: "subject-quill", count, granularity, windowEnd, scope })))))
];

/** The attempt and the instrument as a reading finds them, with decoys on another slot and another instrument. */
const worldAt = (phase: AttemptPhase, cleanup: Cleanup | null): MachineState => ({ ...WORLD, attempts: WORLD.attempts.map((attempt) => (attempt.slot === "B1" ? { ...attempt, phase, cleanup } : { ...attempt, phase: "failed", cleanup: "unconfirmed" })) });

const recordAt = (instrument: (typeof ROW_INSTRUMENTS)[number]): EvidenceRecord => ({
  ...production.EMPTY_RECORD,
  instruments: [
    { slot: "B2", instrument: "coverage", completeness: "complete", reason: null },
    { slot: "B1", instrument: "logger", completeness: "complete", reason: null },
    ...(instrument === "none" ? [] : [{ slot: "B1" as const, instrument: "coverage", completeness: instrument, reason: instrument === "complete" ? null : "budget" }])
  ]
});

const checkEveryReading = (module: Module): number => {
  let visited = 0;
  const observations = everyObservation();
  for (const instrument of ROW_INSTRUMENTS) {
    const record = recordAt(instrument);
    for (const phase of ROW_PHASES) {
      for (const cleanup of ROW_CLEANUPS) {
        const world = worldAt(phase, cleanup);
        for (const state of ROW_STATES) {
          for (const digest of ROW_DIGESTS) {
            for (const observation of observations) {
              const actual = module.readRow(record, world, { id: "row-any", slot: "B1", instrument: "coverage", state, window: { clock: "page", startMs: 1, endMs: 2 }, limits: [], digest, observation });
              const expected = expectedReading({ state, digest, observation, phase, cleanup, instrument });
              holds(ROW_READING, JSON.stringify(actual) === JSON.stringify(expected), () => ({ state, digest, observation, phase, cleanup, instrument, actual, expected }));
              visited += 1;
            }
          }
        }
      }
    }
  }
  return visited;
};

const checkReadRow = (module: Module) => {
  for (const state of NOT_PRESENT) {
    // Even with a count on it, which is what a no_record row must never be read as.
    const reading = module.readRow(production.EMPTY_RECORD, WORLD, row("row-x", "B1", "coverage", state, { observation: observed({ count: 0 }) }));
    holds(ROW_READING, JSON.stringify(reading) === JSON.stringify({ reading: "unknown", reason: state, complete: false }), () => ({ state, reading }));
  }
  holds(ROW_READING, module.readRow(production.EMPTY_RECORD, WORLD, row("row-x", "B1", "coverage")).reading === "recorded", () => "no observation");

  const settled = driven(machine, ROW_READING, planOf("B1", "B2", "I1"), frozen, controlMet(), startOf("B1"), ...captureOf("B1"), finishOf("B1"), { type: "cleanup-confirmed", slot: "B1", by: OWNER }, startOf("B2"), { type: "attempt-finished", slot: "B2", outcome: "failed", by: runnerOf("B2") });
  const complete: EvidenceRecord = {
    ...production.EMPTY_RECORD,
    instruments: [
      // The same instrument elsewhere, and another instrument here, each saying something else.
      { slot: "B2", instrument: "coverage", completeness: "partial", reason: "budget" },
      { slot: "B1", instrument: "logger", completeness: "partial", reason: "budget" },
      { slot: "B1", instrument: "coverage", completeness: "complete", reason: null }
    ]
  };
  const here = module.readRow(complete, settled, row("row-x", "B1", "coverage", "present", { observation: observed() }));
  holds(ROW_READING, JSON.stringify(here) === JSON.stringify({ reading: "observed", count: 3, granularity: "block", windowEnd: "window_closed", complete: true, limits: [] }), () => here);
  const failed = module.readRow(complete, settled, row("row-y", "B2", "coverage", "present", { observation: observed() }));
  holds(ROW_READING, JSON.stringify(failed) === JSON.stringify({ reading: "observed", count: 3, granularity: "block", windowEnd: "window_closed", complete: false, limits: ["coverage_not_complete", "cleanup_unresolved", "operation_failed"] }), () => failed);
  const unrecorded = module.readRow(production.EMPTY_RECORD, settled, row("row-z", "B1", "coverage", "present", { observation: observed() }));
  holds(ROW_READING, JSON.stringify(unrecorded) === JSON.stringify({ reading: "observed", count: 3, granularity: "block", windowEnd: "window_closed", complete: false, limits: ["coverage_not_complete"] }), () => unrecorded);

  // Every field of the observation reaches the reading, spelled, with the rest in the shape that would give complete.
  const read = (over: Partial<NonNullable<EvidenceRow["observation"]>>) => module.readRow(complete, settled, row("row-x", "B1", "coverage", "present", { observation: observed(over) }));
  const spelled: readonly (readonly [Partial<NonNullable<EvidenceRow["observation"]>>, unknown])[] = [
    [{ count: null }, { reading: "unknown", reason: "malformed_record", complete: false, limits: ["malformed_record"] }],
    [{ count: 0 }, { reading: "zero_in_window", granularity: "block", windowEnd: "window_closed", complete: true, limits: [] }],
    [{ count: 0, granularity: "function" }, { reading: "zero_in_window", granularity: "function", windowEnd: "window_closed", complete: false, limits: ["function_only"] }],
    [{ granularity: "function" }, { reading: "observed", count: 3, granularity: "function", windowEnd: "window_closed", complete: false, limits: ["function_only"] }],
    [{ windowEnd: "truncated" }, { reading: "observed", count: 3, granularity: "block", windowEnd: "truncated", complete: false, limits: ["window_not_closed"] }],
    [{ windowEnd: "deadline" }, { reading: "observed", count: 3, granularity: "block", windowEnd: "deadline", complete: false, limits: ["window_not_closed"] }],
    [{ count: 0, windowEnd: "truncated" }, { reading: "unknown", reason: "truncated", complete: false, limits: ["window_not_closed"] }],
    [{ scope: "out_of_scope" }, { reading: "observed", count: 3, granularity: "block", windowEnd: "window_closed", complete: false, limits: ["out_of_scope"] }],
    [{ count: 0, scope: "out_of_scope" }, { reading: "unknown", reason: "out_of_scope", complete: false, limits: ["out_of_scope"] }]
  ];
  for (const [over, expected] of spelled) holds(ROW_READING, JSON.stringify(read(over)) === JSON.stringify(expected), () => ({ over, actual: read(over), expected }));

  // What the attempt came to, spelled by outcome, for a count of 3 and a count of 0. Cleanup is still open on each, and no instrument said anything.
  const readingAt = (outcome: Ending, count: number) => module.readRow(production.EMPTY_RECORD, endedAs(outcome), row("row-z", "B1", "coverage", "present", { observation: observed({ count }) }));
  const OPEN = ["coverage_not_complete", "cleanup_unresolved"];
  const OF_OUTCOME: Readonly<Record<Ending, readonly string[]>> = { usable: [], walled: ["attempt_walled"], incomplete: ["attempt_incomplete"], failed: ["operation_failed"], timed_out: ["operation_failed"], cancelled: ["operation_failed"] };
  for (const outcome of ENDINGS) {
    const limits = [...OPEN, ...OF_OUTCOME[outcome]];
    holds(ROW_READING, JSON.stringify(readingAt(outcome, 3)) === JSON.stringify({ reading: "observed", count: 3, granularity: "block", windowEnd: "window_closed", complete: false, limits }), () => ({ outcome, reading: readingAt(outcome, 3) }));
    const zero = outcome === "failed" || outcome === "timed_out" || outcome === "cancelled" ? { reading: "unknown", reason: "operation_failed", complete: false, limits } : { reading: "zero_in_window", granularity: "block", windowEnd: "window_closed", complete: false, limits };
    holds(ROW_READING, JSON.stringify(readingAt(outcome, 0)) === JSON.stringify(zero), () => ({ outcome, reading: readingAt(outcome, 0) }));
  }
  // With every other condition met, a walled or incomplete 0 is withheld by its outcome alone.
  for (const [outcome, limit] of [["walled", "attempt_walled"], ["incomplete", "attempt_incomplete"]] as const) {
    const started = driven(machine, ROW_READING, planOf("B1", "I1"), frozen, controlMet(), startOf("B1"), ...captureOf("B1"), finishOf("B1", outcome), { type: "cleanup-confirmed", slot: "B1", by: OWNER });
    const zero = module.readRow(FULLY_COMPLETE, started, row("row-z", "B1", "coverage", "present", { observation: observed({ count: 0 }) }));
    holds(ROW_READING, JSON.stringify(zero) === JSON.stringify({ reading: "zero_in_window", granularity: "block", windowEnd: "window_closed", complete: false, limits: [limit] }), () => zero);
  }

  // A running attempt's cleanup is pending, and reads so.
  const running = driven(machine, ROW_READING, planOf("B1", "I1"), frozen, controlMet(), startOf("B1"));
  const midway = module.readRow(production.EMPTY_RECORD, running, row("row-z", "B1", "coverage", "present", { observation: observed() }));
  holds(ROW_READING, (midway as { limits: readonly string[] }).limits.includes("cleanup_unresolved"), () => midway);

  // A row of a slot this plan does not hold can say nothing.
  const stranger = module.readRow(production.EMPTY_RECORD, running, row("row-z", "I3", "coverage", "present", { observation: observed() }));
  holds(ROW_READING, JSON.stringify(stranger) === JSON.stringify({ reading: "unknown", reason: "no_record", complete: false }), () => stranger);
  // A slot that never began has no cleanup, and a row on it would read as unresolved, not as settled.
  const unstarted = module.readRow(production.EMPTY_RECORD, running, row("row-z", "I1", "coverage", "present", { observation: observed() }));
  holds(ROW_READING, (unstarted as { limits: readonly string[] }).limits.includes("cleanup_unresolved"), () => unstarted);
};

test("a row is read in its own attempt, by its own instrument", async () => {
  checkReadRow(production);
  assert.equal(checkEveryReading(production), ROW_COMBINATIONS);
  const caughtAtEvery = (name: string, ...edits: SourceEdit[]) => assertCaughtBy(name, ROW_READING, () => { checkEveryReading(variant(...edits)); });
  const caught = (name: string, ...edits: SourceEdit[]) => assertCaughtBy(name, ROW_READING, () => checkReadRow(variant(...edits)));
  const NOT_PRESENT_LINE = 'if (row.state !== "present" && !isLatePositive(row))\n        return { reading: "unknown", reason: row.state, complete: false };';
  await caught("a no_record row read as what it holds", { find: NOT_PRESENT_LINE, replace: "" });
  await caught("no record read as did-not-run", { find: NOT_PRESENT_LINE, replace: `if (row.state === "no_record")\n        return { reading: "zero_in_window", granularity: "block", windowEnd: "window_closed", complete: false, limits: [] };\n    ${NOT_PRESENT_LINE}` });
  await caught("an instrument read across attempts", { find: "({ slot, instrument: name }) => slot === row.slot && name === row.instrument", replace: "({ instrument: name }) => name === row.instrument" });
  await caught("completeness read across instruments", { find: "({ slot, instrument: name }) => slot === row.slot && name === row.instrument", replace: "({ slot }) => slot === row.slot" });
  await caught("a failed attempt's operation read as fine", { find: 'phase === "failed" || ', replace: "" });
  await caught("a timed-out attempt's operation read as fine", { find: 'phase === "timed_out" || ', replace: "" });
  await caught("a cancelled attempt's operation read as fine", { find: ' || phase === "cancelled"', replace: "" });
  await caught("every attempt's operation read as failed", { find: 'phase === "failed" || phase === "timed_out" || phase === "cancelled" ? "failed_retained" : "succeeded"', replace: '"failed_retained"' });
  await caught("a walled attempt read as fine", { find: 'if (phase === "walled")\n        return "walled";', replace: "" });
  await caught("an incomplete attempt read as fine", { find: 'if (phase === "incomplete")\n        return "incomplete";', replace: "" });
  await caught("a walled attempt's 0 read as failed", { find: 'if (phase === "walled")\n        return "walled";', replace: 'if (phase === "walled")\n        return "failed_retained";' });
  await caught("a row of no attempt read anyway", { find: 'if (attempt === null)\n        return { reading: "unknown", reason: "no_record", complete: false };', replace: 'if (attempt === null)\n        return { reading: "recorded" };' });
  await caught("no cleanup yet read as settled", { find: 'cleanup: attempt.cleanup === null ? "pending" : attempt.cleanup,', replace: 'cleanup: attempt.cleanup === null ? "confirmed" : attempt.cleanup,' });
  // The ones the review found through this path, each a field of a row dropped on its way to the reading.
  await caughtAtEvery("function-only taken for branch level", { find: "granularity: row.observation.granularity,", replace: 'granularity: row.observation.granularity === "function" ? "block" : row.observation.granularity,' });
  await caught("function-only taken for branch level, spelled", { find: "granularity: row.observation.granularity,", replace: 'granularity: row.observation.granularity === "function" ? "block" : row.observation.granularity,' });
  await caughtAtEvery("a window cut short taken for closed", { find: "windowEnd: row.observation.windowEnd,", replace: 'windowEnd: row.observation.windowEnd === "truncated" ? "window_closed" : row.observation.windowEnd,' });
  await caught("a window cut short taken for closed, spelled", { find: "windowEnd: row.observation.windowEnd,", replace: 'windowEnd: row.observation.windowEnd === "truncated" ? "window_closed" : row.observation.windowEnd,' });
  await caughtAtEvery("out of scope taken for in scope", { find: "scope: row.observation.scope,", replace: 'scope: row.observation.scope === "out_of_scope" ? "in_scope" : row.observation.scope,' });
  await caught("out of scope taken for in scope, spelled", { find: "scope: row.observation.scope,", replace: 'scope: row.observation.scope === "out_of_scope" ? "in_scope" : row.observation.scope,' });
  await caughtAtEvery("a present row with no count read as 0", { find: "count: row.observation.count,", replace: "count: row.observation.count === null ? 0 : row.observation.count," });
  await caught("a present row with no count read as 0, spelled", { find: "count: row.observation.count,", replace: "count: row.observation.count === null ? 0 : row.observation.count," });
  await caughtAtEvery("a missing instrument read as partial", { find: "completeness: instrument === undefined ? \"not_recorded\" : instrument.completeness,", replace: 'completeness: instrument === undefined ? "not_recorded" : instrument.completeness === "missing" ? "partial" : instrument.completeness,' });
  await caughtAtEvery("no instrument record read as complete", { find: 'completeness: instrument === undefined ? "not_recorded" : instrument.completeness,', replace: 'completeness: instrument === undefined ? "complete" : instrument.completeness,' });
  await caughtAtEvery("an unconfirmed cleanup read as confirmed", { find: 'cleanup: attempt.cleanup === null ? "pending" : attempt.cleanup,', replace: 'cleanup: attempt.cleanup === "unconfirmed" ? "confirmed" : attempt.cleanup === null ? "pending" : attempt.cleanup,' });
  await caughtAtEvery("a recorded row with no observation read as unknown", { find: 'if (row.observation === null)\n        return { reading: "recorded" };', replace: 'if (row.observation === null)\n        return { reading: "unknown", reason: "no_record", complete: false };' });
});

const WALKED = "every order of claim events matches a plain model of kinds, versions and flags";

const EVENTS: readonly RecordEvent[] = [
  factEvent("alpha", ["row-lantern", "row-quill"]),
  factEvent("echo", ["row-thimble"]),
  supersede("alpha", "Second wording."),
  retractFact("echo"),
  interpretation("reads-alpha", [{ fact: "alpha", version: 1 }]),
  interpretation("reads-both", [{ fact: "alpha", version: 1 }, { fact: "echo", version: 1 }]),
  reaffirm("reads-alpha", [{ fact: "alpha", version: 2 }]),
  reaffirm("reads-both", [{ fact: "alpha", version: 2 }, { fact: "echo", version: 1 }]),
  reaffirm("reads-both", [{ fact: "alpha", version: 2 }]),
  assertionEvent("bravo"),
  retractAssertion("bravo", "question-two")
];

type ModelInterpretation = { cites: Map<string, number>; flagged: Set<string> };
type Model = { facts: Map<string, { version: number; current: boolean; wording: string }>; interpretations: Map<string, ModelInterpretation>; assertions: Map<string, boolean>; unknowns: Set<string> };

const emptyModel = (): Model => ({ facts: new Map(), interpretations: new Map(), assertions: new Map(), unknowns: new Set() });

const cloneModel = (model: Model): Model => ({
  facts: new Map([...model.facts].map(([id, fact]) => [id, { ...fact }])),
  interpretations: new Map([...model.interpretations].map(([id, value]) => [id, { cites: new Map(value.cites), flagged: new Set(value.flagged) }])),
  assertions: new Map(model.assertions),
  unknowns: new Set(model.unknowns)
});

/** The rule in plain form: what each event does to kinds, versions and flags. It restates the module, on purpose. */
function modelApply(model: Model, event: RecordEvent): Model | null {
  const next = cloneModel(model);
  const citesOk = (cites: readonly production.Cite[]) => cites.every(({ fact, version }) => next.facts.get(fact)?.current === true && next.facts.get(fact)?.version === version);
  const flag = (factId: string) => {
    for (const value of next.interpretations.values()) if (value.cites.has(factId)) value.flagged.add(factId);
  };
  switch (event.type) {
    case "fact-recorded":
      if (next.facts.has(event.id)) return null;
      next.facts.set(event.id, { version: 1, current: true, wording: event.statement });
      return next;
    case "fact-superseded": {
      const fact = next.facts.get(event.fact);
      if (fact === undefined || !fact.current || fact.wording === event.statement) return null;
      fact.version += 1;
      fact.wording = event.statement;
      flag(event.fact);
      return next;
    }
    case "fact-retracted": {
      const fact = next.facts.get(event.fact);
      if (fact === undefined || !fact.current) return null;
      fact.current = false;
      flag(event.fact);
      return next;
    }
    case "interpretation-recorded":
      if (next.interpretations.has(event.id) || !citesOk(event.cites)) return null;
      next.interpretations.set(event.id, { cites: new Map(event.cites.map(({ fact, version }) => [fact, version])), flagged: new Set() });
      return next;
    case "interpretation-reaffirmed": {
      const value = next.interpretations.get(event.interpretation);
      if (value === undefined) return null;
      const sameFacts = event.cites.length === value.cites.size && event.cites.every(({ fact }) => value.cites.has(fact));
      if (value.flagged.size === 0 || !sameFacts || !citesOk(event.cites)) return null;
      value.cites = new Map(event.cites.map(({ fact, version }) => [fact, version]));
      value.flagged = new Set();
      return next;
    }
    case "assertion-recorded":
      if (next.assertions.has(event.id)) return null;
      next.assertions.set(event.id, false);
      return next;
    case "assertion-retracted":
      if (next.assertions.get(event.assertion) !== false) return null;
      next.assertions.set(event.assertion, true);
      next.unknowns.add(event.unknown.id);
      return next;
    default:
      return null;
  }
}

let nodesWithAssertions = 0;

const checkWalk = (module: Module, depth: number): number => {
  let visited = 0;
  nodesWithAssertions = 0;
  const start = seeded();
  const { rows } = start;
  const descend = (record: EvidenceRecord, model: Model, left: number): void => {
    visited += 1;
    holds(WALKED, record.rows === rows, () => "the rows changed");
    holds(WALKED, record.facts.length === model.facts.size && record.facts.every(({ id, version, status }) => model.facts.get(id)?.version === version && model.facts.get(id)?.current === (status === "current")), () => ({ record, model: [...model.facts] }));
    holds(WALKED, record.interpretations.length === model.interpretations.size, () => record.interpretations);
    for (const { id, review, cites, flags } of record.interpretations) {
      const value = model.interpretations.get(id) as ModelInterpretation;
      holds(WALKED, (review === "needs_review") === (value.flagged.size > 0), () => ({ id, review, flagged: [...value.flagged] }));
      holds(WALKED, new Set(flags.map(({ fact }) => fact)).size === value.flagged.size, () => ({ id, flags, flagged: [...value.flagged] }));
      holds(WALKED, cites.length === value.cites.size && cites.every(({ fact, version }) => value.cites.get(fact) === version), () => ({ id, cites }));
    }
    if (record.assertions.length > 0) nodesWithAssertions += 1;
    holds(WALKED, record.assertions.length === model.assertions.size && record.assertions.every(({ id, status, citable, kind }) => kind === "assertion" && citable === false && (status === "retracted") === model.assertions.get(id)), () => record.assertions);
    holds(WALKED, record.unknowns.length === model.unknowns.size && record.unknowns.every(({ id, kind }) => kind === "unknown" && model.unknowns.has(id)), () => record.unknowns);
    if (left === 0) return;
    for (const event of EVENTS) {
      const expected = modelApply(model, event);
      const answer = module.applyRecordEvent(record, event, OWNER, WORLD, AT);
      holds(WALKED, answer.ok === (expected !== null), () => ({ event, answer }));
      if (answer.ok) descend(answer.record, expected as Model, left - 1);
    }
  };
  descend(start, emptyModel(), depth);
  return visited;
};

test("every order of claim events matches a plain model, and no row moves", () => {
  // Each event can apply at most a few times, so depth 11 is past the end of every path.
  assert.equal(checkWalk(production, 11), WALK_NODES);
  // The assertion check above read a row on this many of them, and is not holding over nothing.
  assert.equal(nodesWithAssertions, WALK_NODES_WITH_ASSERTIONS);
});

const WALK_NODES = 5384;
const WALK_NODES_WITH_ASSERTIONS = 5219;

for (const [name, edits] of [
  ["no flags on a supersede", [{ find: 'return accept(flagDependents(replaced(record, next), fact.id, fact.version, "superseded", atSeq));', replace: "return accept(replaced(record, next));" }]],
  ["no flags on a retract", [{ find: 'const flagged = flagDependents(replaced(record, next), fact.id, fact.version, "retracted", atSeq);', replace: "const flagged = replaced(record, next);" }]],
  ["a reaffirm that leaves the flags", [{ find: 'cites: event.cites, review: "current", flags: [], reaffirmations: claim.reaffirmations + 1', replace: 'cites: event.cites, review: "current", reaffirmations: claim.reaffirmations + 1' }]],
  ["a cite of an old version", [{ find: 'if (claim.status !== "current" || claim.version !== cite.version)', replace: 'if (claim.status !== "current")' }]],
  ["a retracted fact citable", [{ find: 'if (claim.status !== "current" || claim.version !== cite.version)', replace: "if (claim.version !== cite.version)" }]],
  ["a reaffirm taking fewer facts", [{ find: 'if (event.cites.length !== claim.cites.length || !event.cites.every(({ fact }) => claim.cites.some((cite) => cite.fact === fact)))\n        return refuse("cites-not-its-facts", "cites");', replace: "" }]],
  ["an assertion born citable", [{ find: 'status: "unverified", citable: false,', replace: 'status: "unverified", citable: true,' }]],
  ["an assertion retraction leaving it unverified", [{ find: 'const retracted = Object.assign(Object.assign({}, claim), { status: "retracted", retraction:', replace: 'const retracted = Object.assign(Object.assign({}, claim), { retraction:' }]]
] as const) {
  test(`the walk catches ${name}`, async () => {
    await assertCaughtBy(name, WALKED, () => checkWalk(variant(...(edits as readonly SourceEdit[])), 5));
  });
}

const AT_FIELD = "a refusal names a field or a kind, never a value it was handed";

const HELD = "canary-held-value-4qz";
const HELD_UNKNOWN: UnknownInput = { ...unknownInput(HELD) };

/**
 * Every refusal a record event can give, each with the field it names. The record is built so
 * that the value handed in is a canary wherever an id or a slot can hold one, and the Record type
 * makes the table exhaustive at its compile, so a refusal added without an entry fails the stage.
 */
const refusalTable = (module: Module): Readonly<Record<Exclude<RecordRefusal, "row-from-missing-instrument">, readonly [RecordEvent, EvidenceRecord, MachineActor, MachineState, string | null]>> => {
  const flagged = apply(module, "builds", dependents(module), supersede("alpha", "New wording of alpha."));
  const withHeld = apply(module, "builds", seeded(), assertionEvent(HELD));
  const heldFact = apply(module, "builds", seeded(), factEvent(HELD, ["row-lantern"]));
  const retractedHeld = apply(module, "builds", heldFact, retractFact(HELD));
  const heldInterpretation = apply(module, "builds", apply(module, "builds", seeded(), factEvent("alpha", ["row-lantern"])), interpretation(HELD, [{ fact: "alpha", version: 1 }]));
  const retractedAssertion = apply(module, "builds", withHeld, retractAssertion(HELD, "x-unknown"));
  const heldRow: EvidenceRecord = { ...production.EMPTY_RECORD, rows: [row(HELD, "B1", "coverage", "no_record")] };
  const withInstrument = apply(module, "builds", production.EMPTY_RECORD, { type: "instrument-recorded", slot: "B1", instrument: HELD, completeness: "partial", reason: null }, runnerOf("B1"), B1_RUNNING);
  const presentRow: EvidenceRecord = { ...production.EMPTY_RECORD, rows: [row("row-seen", "B1", HELD)] };
  const withSource = apply(module, "builds", production.EMPTY_RECORD, { type: "source-recorded", slot: "B1", commit: COMMIT_ONE, identity: IDENTITY_ONE }, runnerOf("B1"), B1_RUNNING);
  const reconstructed = apply(module, "builds", production.EMPTY_RECORD, { type: "source-reconstructed", appliesTo: ["B1"], baseCommit: COMMIT_ONE, patchDigest: PATCH, identity: IDENTITY_ONE });
  const source = (appliesTo: readonly SlotName[]): RecordEvent => ({ type: "source-reconstructed", appliesTo, baseCommit: COMMIT_ONE, patchDigest: PATCH, identity: IDENTITY_ONE });
  const empty = production.EMPTY_RECORD;
  return {
    "owner-only": [factEvent(HELD, ["row-lantern"]), seeded(), runnerOf("B1"), WORLD, null],
    "not-this-attempt": [{ type: "instrument-recorded", slot: "B1", instrument: HELD, completeness: "complete", reason: null }, empty, OWNER, B1_RUNNING, "slot"],
    "no-such-slot": [{ type: "instrument-recorded", slot: "I3", instrument: HELD, completeness: "complete", reason: null }, empty, runnerOf("I3"), B1_RUNNING, "slot"],
    "attempt-not-begun": [{ type: "instrument-recorded", slot: "B2", instrument: HELD, completeness: "complete", reason: null }, empty, runnerOf("B2"), B1_RUNNING, "slot"],
    "id-taken": [assertionEvent(HELD), withHeld, OWNER, WORLD, "id"],
    "fact-needs-evidence": [factEvent(HELD, []), seeded(), OWNER, WORLD, "evidence"],
    "no-such-row": [factEvent("x-fact", [HELD]), seeded(), OWNER, WORLD, "evidence"],
    "row-not-present": [factEvent("x-fact", [HELD]), heldRow, OWNER, WORLD, "evidence"],
    "instrument-missing-has-row": [{ type: "instrument-recorded", slot: "B1", instrument: HELD, completeness: "missing", reason: null }, presentRow, runnerOf("B1"), B1_RUNNING, "instrument"],
    "instrument-already-recorded": [{ type: "instrument-recorded", slot: "B1", instrument: HELD, completeness: "partial", reason: null }, withInstrument, runnerOf("B1"), B1_RUNNING, "instrument"],
    "no-such-claim": [supersede(HELD), seeded(), OWNER, WORLD, "fact"],
    "not-a-fact": [supersede(HELD), withHeld, OWNER, WORLD, "fact"],
    "not-an-assertion": [retractAssertion(HELD, "x-unknown"), heldFact, OWNER, WORLD, "assertion"],
    "not-an-interpretation": [reaffirm(HELD, [{ fact: "alpha", version: 1 }]), heldFact, OWNER, WORLD, "interpretation"],
    "fact-not-current": [supersede(HELD), retractedHeld, OWNER, WORLD, "fact"],
    "same-wording": [supersede(HELD, `Statement of ${HELD}.`), heldFact, OWNER, WORLD, "statement"],
    "assertion-already-retracted": [retractAssertion(HELD, "y-unknown"), retractedAssertion, OWNER, WORLD, "assertion"],
    "interpretation-needs-cites": [interpretation(HELD, []), seeded(), OWNER, WORLD, "cites"],
    "cites-assertion": [interpretation("x-reading", [{ fact: HELD, version: 1 }]), withHeld, OWNER, WORLD, "cites"],
    "cites-interpretation": [interpretation("x-reading", [{ fact: HELD, version: 1 }]), heldInterpretation, OWNER, WORLD, "cites"],
    "cites-unknown": [interpretation("x-reading", [{ fact: HELD, version: 1 }]), apply(module, "builds", seeded(), { type: "unknown-recorded", unknown: HELD_UNKNOWN }), OWNER, WORLD, "cites"],
    "cites-no-such-fact": [interpretation("x-reading", [{ fact: HELD, version: 1 }]), seeded(), OWNER, WORLD, "cites"],
    "cite-not-current": [interpretation("x-reading", [{ fact: HELD, version: 9 }]), heldFact, OWNER, WORLD, "cites"],
    "cites-repeated": [interpretation("x-reading", [{ fact: HELD, version: 1 }, { fact: HELD, version: 1 }]), heldFact, OWNER, WORLD, "cites"],
    "cites-not-its-facts": [reaffirm("reads-alpha", [{ fact: "echo", version: 1 }]), flagged, OWNER, WORLD, "cites"],
    "not-flagged": [reaffirm(HELD, [{ fact: "alpha", version: 1 }]), heldInterpretation, OWNER, WORLD, "interpretation"],
    "source-already-reconstructed": [source(["B1"]), reconstructed, OWNER, WORLD, null],
    "source-needs-slots": [source([]), empty, OWNER, WORLD, "appliesTo"],
    "source-slot-recorded": [source(["B1"]), withSource, OWNER, WORLD, "appliesTo"],
    "source-attempt-not-ended": [source(["I2"]), empty, OWNER, WORLD, "appliesTo"],
    "source-already-recorded": [{ type: "source-recorded", slot: "B1", commit: HELD, identity: HELD }, withSource, runnerOf("B1"), B1_RUNNING, "slot"],
    "source-after-attempt": [{ type: "source-recorded", slot: "B1", commit: HELD, identity: HELD }, empty, runnerOf("B1"), WORLD, "slot"],
    "instrument-after-attempt": [{ type: "instrument-recorded", slot: "B1", instrument: HELD, completeness: "complete", reason: null }, empty, runnerOf("B1"), WORLD, "slot"]
  };
};

const checkRefusalFields = (module: Module) => {
  for (const [refusal, [event, record, by, world, at]] of Object.entries(refusalTable(module))) {
    const result = module.applyRecordEvent(record, event, by, world, AT);
    holds(AT_FIELD, !result.ok && result.refusal === refusal && result.at === at, () => ({ refusal, at, result }));
    holds(AT_FIELD, !JSON.stringify(result).includes(HELD), () => ({ refusal, result }));
  }
  // What addRow refuses, by the same rule, whose table entry cannot be an event.
  const taken = module.addRow({ ...production.EMPTY_RECORD, rows: [row(HELD, "B1", "coverage")] }, row(HELD, "B1", "coverage"), "capturing");
  holds(AT_FIELD, !taken.ok && taken.refusal === "id-taken" && taken.at === "row.id" && !JSON.stringify(taken).includes(HELD), () => taken);
  const lost = module.addRow({ ...production.EMPTY_RECORD, instruments: [{ slot: "B1", instrument: HELD, completeness: "missing", reason: null }] }, row("row-seen", "B1", HELD), "capturing");
  holds(AT_FIELD, !lost.ok && lost.refusal === "row-from-missing-instrument" && lost.at === "row.instrument" && !JSON.stringify(lost).includes(HELD), () => lost);
};

test("every refusal names a field or a kind, spelled, and never the value it was handed", async () => {
  checkRefusalFields(production);
  assert.equal(Object.keys(refusalTable(production)).length, 33);
  const atIsValue = (name: string, find: string, replace: string) => assertCaughtBy(name, AT_FIELD, () => checkRefusalFields(variant({ find, replace })));
  await atIsValue("no-such-row echoing the id", 'return refuse("no-such-row", "evidence");', 'return refuse("no-such-row", id);');
  await atIsValue("row-not-present echoing the id", 'return refuse("row-not-present", "evidence");', 'return refuse("row-not-present", id);');
  await atIsValue("no-such-claim echoing the id", 'return refuse("no-such-claim", "fact");', 'return refuse("no-such-claim", id);');
  await atIsValue("not-a-fact echoing the id", 'return refuse("not-a-fact", "fact");', 'return refuse("not-a-fact", id);');
  await atIsValue("id-taken echoing the id", 'if (isIdTaken(record, event.id))\n                return refuse("id-taken", "id");', 'if (isIdTaken(record, event.id))\n                return refuse("id-taken", event.id);');
  await atIsValue("a cite's refusal echoing the fact", 'return refuse("cites-no-such-fact", "cites");', 'return refuse("cites-no-such-fact", cite.fact);');
  await atIsValue("an instrument's refusal echoing its name", 'return refuse("instrument-already-recorded", "instrument");', 'return refuse("instrument-already-recorded", event.instrument);');
  await atIsValue("a row's refusal echoing its id", 'return refuse("id-taken", "row.id");', 'return refuse("id-taken", row.id);');
  await atIsValue("a missing instrument's row echoing its name", 'return refuse("row-from-missing-instrument", "row.instrument");', 'return refuse("row-from-missing-instrument", row.instrument);');
});
