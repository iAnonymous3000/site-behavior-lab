import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { isDeepStrictEqual } from "node:util";
import ts from "typescript";
import { assertCaughtBy, holds, loadVariant, type SourceEdit } from "../../lib/finite-check";
import { aggregate } from "../core/aggregates";
import * as machine from "../core/case-machine";
import type { MachineState, SlotName } from "../core/case-machine";
import * as w2 from "../core/evidence-model";
import { EMPTY_RECORD, type EvidenceRecord, type EvidenceRow, type RecordEvent, type RowObservation } from "../core/evidence-model";
import * as production from "../core/imported-case";
import { adaptCaptureRun, capturePathsNeeded, surveyCaptureRun, type CapturePlan, type Files } from "../core/capture-adapter";
import { canonicalBytes } from "../core/canonical-json";
import type { ImportedAttemptId, ImportedCase, ImportedClaimEvent, ImportedRow, ImportInput } from "../core/imported-case";
import { assessSufficiency, type Question } from "../core/sufficiency";
import { captureOf, controlMet, driven, finishOf, frozen, OWNER, planOf, startOf } from "./case-fixture";
import { MEASURE_OFFSETS, observeFile, plan as capturePlan, PROVENANCE_RECORD, rowFile, runFiles, seed as captureSeed, sha } from "./recorded-fixture";
import { PROVENANCE_PATH } from "../core/recorder-shapes";

/**
 * An imported case, as its own record kind. The claim functions here restate W2's for attempts
 * instead of slots, so the walk below runs every short script of claims through both, from an empty
 * record and from one that already holds a claim of each kind, over rows that include an observation
 * on a partial instrument and a late positive, and holds them to the same answers: the same refusal at
 * the same place for the same event, and the same claims after it. A variant of either side that
 * drifts is caught by name.
 */

type Module = typeof production;
type W2Module = typeof w2;
const variant = (...edits: SourceEdit[]) => loadVariant<Module>(require.resolve("../core/imported-case"), edits);
const w2Variant = (...edits: SourceEdit[]) => loadVariant<W2Module>(require.resolve("../core/evidence-model"), edits);

const A01 = production.importedAttemptId(0);
const A02 = production.importedAttemptId(1);
const SLOT_OF: Readonly<Record<string, SlotName>> = { A01: "B1", A02: "B2" };
const ATTEMPT_OF: Readonly<Record<string, ImportedAttemptId>> = { B1: A01, B2: A02 };

const WORLD: MachineState = driven(machine, "the path runs", planOf("B1", "B2"), frozen, controlMet(), startOf("B1"), ...captureOf("B1"), finishOf("B1"));

const COUNTED: RowObservation = { subject: "anchor-executions", count: 3, granularity: "block", windowEnd: "window_closed", scope: "in_scope" };

/** Rows on both sides: two present, one not, an observation on a partial instrument, and a late positive. */
const ROWS: readonly Readonly<{ id: string; attempt: ImportedAttemptId; state: EvidenceRow["state"]; observation: RowObservation | null }>[] = [
  { id: "row-ember", attempt: A01, state: "present", observation: null },
  { id: "row-flint", attempt: A02, state: "present", observation: null },
  { id: "row-ash", attempt: A01, state: "no_record", observation: null },
  { id: "row-glow", attempt: A01, state: "present", observation: COUNTED },
  { id: "row-late", attempt: A01, state: "late", observation: { ...COUNTED, count: 2 } }
];

const w2Row = ({ id, attempt, state, observation }: (typeof ROWS)[number]): EvidenceRow => ({
  id,
  slot: SLOT_OF[attempt],
  instrument: "coverage",
  state,
  window: { clock: "page", startMs: 10, endMs: 90 },
  limits: ["main-frame-only"],
  digest: state === "no_record" ? null : "ab".repeat(32),
  observation
});

const importedRow = ({ id, attempt, state, observation }: (typeof ROWS)[number]): ImportedRow => ({
  id,
  attempt,
  topic: "report-read",
  instrument: "coverage",
  state,
  window: { clock: "page", startMs: 10, endMs: 90 },
  limits: ["main-frame-only"],
  digest: state === "no_record" ? null : "ab".repeat(32),
  observation,
  reportKinds: [],
  laterKinds: []
});

const IDENTITY = { name: "synthetic", version: 1, recorder: { name: "REA", release: "6.5.0", commit: "0".repeat(40), integrity: "sha512:00" }, shapes: {} };

const ATTEMPTS = [
  { id: A01, run: "first", recipe: "plain", startedAt: "2025-03-04T05:06:00.000Z", durationMs: 1000, acquisition: "usable" as const, acquisitionReason: null, page: { status: 200 }, instruments: [{ name: "coverage", completeness: "partial" as const, reason: "synthetic", cleanup: null, recorderLimitations: null }], sourceIdentity: "not_recorded" as const },
  { id: A02, run: "second", recipe: "plain", startedAt: "2025-03-04T05:07:00.000Z", durationMs: 1000, acquisition: "incomplete" as const, acquisitionReason: "synthetic", page: { status: 200 }, instruments: [{ name: "coverage", completeness: "partial" as const, reason: "synthetic", cleanup: null, recorderLimitations: null }], sourceIdentity: "reconstructed" as const }
];

const emptyImported = (rows: readonly ImportedRow[] = ROWS.map(importedRow)): ImportedCase => ({
  kind: "imported-case",
  historical: true,
  exploratory: true,
  adapter: IDENTITY,
  recorderBasis: "declared",
  recorderStatement: "declared: synthetic",
  runDigest: "cd".repeat(32),
  assessment: { question: "q", runDigest: "cd".repeat(32), verdict: "supports-import", requirements: [], reasons: [], questionTextDigest: "ab".repeat(32), questionDigest: "ab".repeat(32) },
  question: "Which synthetic row holds what?",
  objects: [],
  attempts: ATTEMPTS,
  rows,
  source: { state: "reconstructed", baseCommit: "c0ffee", patch: { path: "patch.diff", sha256: "cd".repeat(32) }, identity: "ef".repeat(32), appliesTo: [A02] },
  provenanceGaps: [],
  control: null,
  deviations: [],
  independentReproduction: { state: "none", note: "synthetic" },
  facts: [],
  assertions: [],
  interpretations: [],
  unknowns: [],
  claimSeq: 0
});

const W2_RECORD: EvidenceRecord = { ...EMPTY_RECORD, rows: ROWS.map(w2Row), instruments: [{ slot: "B1", instrument: "coverage", completeness: "partial", reason: null }] };

const unknown = (id: string) => ({ id, question: `What is ${id}?`, reason: "not_observed", detail: null, wouldResolve: null });

/** The alphabet of the walk: every claim event, and one event for each refusal reachable without a machine. */
const ALPHABET: readonly ImportedClaimEvent[] = [
  { type: "fact-recorded", id: "fact-f", statement: "Statement of f.", evidence: ["row-ember"] },
  { type: "fact-recorded", id: "fact-g", statement: "Statement of g.", evidence: ["row-ember", "row-flint"] },
  { type: "fact-recorded", id: "fact-h", statement: "Statement of h.", evidence: ["row-none"] },
  { type: "fact-recorded", id: "fact-k", statement: "Statement of k.", evidence: ["row-ash"] },
  { type: "fact-recorded", id: "fact-l", statement: "Statement of l.", evidence: [] },
  { type: "fact-recorded", id: "row-ember", statement: "A row's id.", evidence: ["row-flint"] },
  { type: "fact-recorded", id: "fact-m", statement: "Rests on a count.", evidence: ["row-glow"] },
  { type: "fact-recorded", id: "fact-n", statement: "Rests on a late count.", evidence: ["row-late"] },
  { type: "fact-superseded", fact: "fact-f", statement: "New wording of f.", reason: "It said more than the rows." },
  { type: "fact-superseded", fact: "fact-f", statement: "Statement of f.", reason: "The same words." },
  { type: "fact-retracted", fact: "fact-f", reason: "Misread.", unknown: unknown("unknown-nine") },
  { type: "fact-retracted", fact: "fact-g", reason: "Misread.", unknown: null },
  { type: "fact-retracted", fact: "fact-g", reason: "Misread.", unknown: unknown("unknown-seven") },
  { type: "assertion-recorded", id: "said-a", statement: "Someone said a." },
  { type: "assertion-retracted", assertion: "said-a", reason: "Nothing backs it.", unknown: unknown("unknown-eight") },
  { type: "assertion-retracted", assertion: "said-a", reason: "Nothing backs it.", unknown: unknown("row-ash") },
  { type: "interpretation-recorded", id: "reading-i", statement: "Reading i.", cites: [{ fact: "fact-f", version: 1 }] },
  { type: "interpretation-recorded", id: "reading-j", statement: "Reading j.", cites: [{ fact: "said-a", version: 1 }] },
  { type: "interpretation-recorded", id: "reading-m", statement: "Reading m.", cites: [{ fact: "fact-f", version: 1 }, { fact: "fact-f", version: 1 }] },
  { type: "interpretation-recorded", id: "reading-n", statement: "Reading n.", cites: [] },
  { type: "interpretation-recorded", id: "reading-p", statement: "Reading p.", cites: [{ fact: "unknown-seven", version: 1 }] },
  { type: "interpretation-recorded", id: "reading-q", statement: "Reading q.", cites: [{ fact: "reading-i", version: 1 }] },
  { type: "interpretation-reaffirmed", interpretation: "reading-i", cites: [{ fact: "fact-f", version: 2 }] },
  { type: "interpretation-reaffirmed", interpretation: "reading-i", cites: [{ fact: "fact-g", version: 1 }] },
  { type: "interpretation-reaffirmed", interpretation: "reading-i", cites: [] },
  { type: "interpretation-reaffirmed", interpretation: "reading-i", cites: [{ fact: "fact-f", version: 2 }, { fact: "fact-f", version: 2 }] },
  { type: "interpretation-reaffirmed", interpretation: "fact-f", cites: [{ fact: "fact-f", version: 1 }] },
  { type: "assertion-retracted", assertion: "fact-f", reason: "Not one.", unknown: unknown("unknown-six") },
  { type: "fact-superseded", fact: "said-a", statement: "Not a fact.", reason: "Not one." },
  { type: "unknown-recorded", unknown: unknown("unknown-seven") }
];

type Pair = Readonly<{ w2: EvidenceRecord; imported: ImportedCase }>;

const AGREE = "the imported claims answer every event as W2's claim functions do";

function w2Claims(record: EvidenceRecord) {
  return {
    facts: record.facts.map(({ links, ...fact }) => ({ ...fact, links: links.map(({ slot, ...link }) => ({ ...link, attempt: ATTEMPT_OF[slot] })) })),
    assertions: record.assertions,
    interpretations: record.interpretations,
    unknowns: record.unknowns
  };
}

function importedClaims(c: ImportedCase) {
  return { facts: c.facts.map(({ links, ...fact }) => ({ ...fact, links: links.map((link) => ({ ...link })) })), assertions: c.assertions, interpretations: c.interpretations, unknowns: c.unknowns };
}

type Sides = Readonly<{ imported: Module; w2: W2Module }>;

function step(sides: Sides, pair: Pair, event: ImportedClaimEvent, seen?: Set<string>): Pair {
  const atSeq = pair.imported.claimSeq + 1;
  const left = sides.w2.applyRecordEvent(pair.w2, event as RecordEvent, OWNER, WORLD, atSeq);
  const right = sides.imported.applyImportedClaim(pair.imported, event);
  holds(AGREE, left.ok === right.ok, () => ({ event, w2: left, imported: right.ok ? "accepted" : right }));
  if (!left.ok || !right.ok) {
    holds(AGREE, !left.ok && !right.ok && left.refusal === right.refusal && left.at === right.at, () => ({ event, w2: left, imported: right }));
    if (!right.ok) seen?.add(`${right.refusal} ${right.at}`);
    return pair;
  }
  holds(AGREE, isDeepStrictEqual(w2Claims(left.record), importedClaims(right.case)), () => ({ event, w2: w2Claims(left.record), imported: importedClaims(right.case) }));
  holds(AGREE, right.case.claimSeq === atSeq, () => ({ event, claimSeq: right.case.claimSeq }));
  return { w2: left.record, imported: right.case };
}

/** Every script of up to three events, from each base, with every (refusal, place) pair the imported side gave. */
function walk(sides: Sides): Readonly<{ scripts: number; seen: ReadonlySet<string> }> {
  let scripts = 0;
  const seen = new Set<string>();
  const extend = (pair: Pair, depth: number): void => {
    scripts += 1;
    if (depth === 3) return;
    for (const event of ALPHABET) extend(step(sides, pair, event, seen), depth + 1);
  };
  for (const base of bases(sides)) extend(base, 0);
  return { scripts, seen };
}

function bases(sides: Sides): readonly Pair[] {
  const empty: Pair = { w2: W2_RECORD, imported: emptyImported() };
  let held = empty;
  for (const event of [ALPHABET[0], ALPHABET[1], ALPHABET[13], ALPHABET[16], ALPHABET[29]]) held = step(sides, held, event);
  return [empty, held];
}

const PRODUCTION: Sides = { imported: production, w2 };

const EVERY_PAIR = [
  "assertion-already-retracted assertion",
  "cite-not-current cites",
  "cites-assertion cites",
  "cites-interpretation cites",
  "cites-no-such-fact cites",
  "cites-not-its-facts cites",
  "cites-repeated cites",
  "cites-unknown cites",
  "fact-needs-evidence evidence",
  "fact-not-current fact",
  "id-taken id",
  "id-taken unknown.id",
  "interpretation-needs-cites cites",
  "no-such-claim assertion",
  "no-such-claim fact",
  "no-such-claim interpretation",
  "no-such-row evidence",
  "not-a-fact fact",
  "not-an-assertion assertion",
  "not-an-interpretation interpretation",
  "not-flagged interpretation",
  "row-not-present evidence",
  "same-wording statement"
];

test("every script of three claims answers alike through W2's functions and the imported ones, at every refusal's place", () => {
  const { scripts, seen } = walk(PRODUCTION);
  assert.equal(scripts, 2 * (1 + ALPHABET.length + ALPHABET.length ** 2 + ALPHABET.length ** 3));
  assert.deepEqual([...seen].sort(), EVERY_PAIR);
});

test("the walk reaches every claim kind, links a reading's limits, and accepts a late positive with late as its limit", () => {
  const kinds = new Set<string>();
  const extend = (c: ImportedCase, depth: number): void => {
    if (depth === 2) return;
    for (const event of ALPHABET) {
      const result = production.applyImportedClaim(c, event);
      if (result.ok) {
        kinds.add(event.type);
        extend(result.case, depth + 1);
      }
    }
  };
  for (const base of bases(PRODUCTION)) extend(base.imported, 0);
  assert.deepEqual([...kinds].sort(), [...production.IMPORTED_CLAIM_TYPES].sort());
  const counted = production.applyImportedClaim(emptyImported(), ALPHABET[6]);
  assert.ok(counted.ok);
  assert.deepEqual([...counted.case.facts[0].links[0].limits].sort(), ["cleanup_unresolved", "coverage_not_complete", "main-frame-only"]);
  const late = production.applyImportedClaim(emptyImported(), ALPHABET[7]);
  assert.ok(late.ok);
  assert.deepEqual([...late.case.facts[0].links[0].limits].sort(), ["cleanup_unresolved", "coverage_not_complete", "late", "main-frame-only"]);
});

for (const [name, edits] of [
  ["a repeated cite let through", [{ find: 'return refuse("cites-repeated", "cites");\n    for (const cite of event.cites) {', replace: "for (const cite of event.cites) {" }]],
  ["a supersede that flags nothing", [{ find: 'return { ok: true, case: flagDependents(replaced(c, next), fact.id, fact.version, "superseded", atSeq) };', replace: "return { ok: true, case: replaced(c, next) };" }]],
  ["a no_record row accepted as a fact's evidence", [{ find: 'if (row.state !== "present" && !isLatePositive(row))\n            return refuse("row-not-present", "evidence");', replace: "" }]],
  ["a late positive refused as a fact's evidence", [{ find: 'if (row.state !== "present" && !isLatePositive(row))\n            return refuse("row-not-present", "evidence");', replace: 'if (row.state !== "present")\n            return refuse("row-not-present", "evidence");' }]],
  ["a fact link that drops the reading's limits", [{ find: '"limits" in reading ? [...new Set([...row.limits, ...limitsOfReading(reading)])] : row.limits', replace: "row.limits" }]],
  ["a fact retraction that takes a held unknown id", [{ find: 'if (event.unknown !== null && isIdTaken(c, event.unknown.id))\n        return refuse("id-taken", "unknown.id");', replace: "" }]],
  ["an assertion retraction that takes a held unknown id", [{ find: 'if (claim.status === "retracted")\n        return refuse("assertion-already-retracted", "assertion");\n    if (isIdTaken(c, event.unknown.id))\n        return refuse("id-taken", "unknown.id");', replace: 'if (claim.status === "retracted")\n        return refuse("assertion-already-retracted", "assertion");' }]],
  ["a retracted assertion that keeps no unknown", [{ find: "existing)), unknowns: [...c.unknowns, unknownFrom(event.unknown)] }) };", replace: "existing)) }) };" }]],
  ["an assertion that a cite accepts", [{ find: 'if (claim.kind === "assertion")\n        return refuse("cites-assertion", "cites");', replace: "" }]],
  ["a reaffirm that keeps the flag", [{ find: 'review: "current", flags: [], reaffirmations: claim.reaffirmations + 1 });', replace: 'review: "current", reaffirmations: claim.reaffirmations + 1 });' }]],
  ["a reaffirm with no cites", [{ find: 'if (claim.review !== "needs_review")\n        return refuse("not-flagged", "interpretation");\n    if (event.cites.length === 0)\n        return refuse("interpretation-needs-cites", "cites");', replace: 'if (claim.review !== "needs_review")\n        return refuse("not-flagged", "interpretation");' }]],
  ["a sequence that does not advance", [{ find: "return result.ok ? { ok: true, case: Object.assign(Object.assign({}, result.case), { claimSeq: atSeq }) } : result;", replace: "return result;" }]]
] as const) {
  test(`the walk catches ${name}`, async () => {
    const drifted = variant(...edits);
    await assertCaughtBy(name, AGREE, () => walk({ imported: drifted, w2 }));
  });
}

test("the walk catches W2 itself drifting: no longer accepting a late positive", async () => {
  const drifted = w2Variant({ find: 'if (row.state !== "present" && !isLatePositive(row))\n            return refuse("row-not-present", "evidence");', replace: 'if (row.state !== "present")\n            return refuse("row-not-present", "evidence");' });
  await assertCaughtBy("W2 refusing a late positive", AGREE, () => walk({ imported: production, w2: drifted }));
});

test("an imported attempt's id is never a slot's, and the case is historical and exploratory by its type", () => {
  assert.equal(production.importedAttemptId(0), "A01");
  assert.equal(production.importedAttemptId(12), "A13");
  assert.equal(production.importedAttemptId(99), "A100");
  for (const slot of machine.SLOT_NAMES) assert.equal(production.isImportedAttemptId(slot), false, slot);
  for (const bad of ["A1", "A", "a01", "A01 ", "A00001", "B01", "Abc", 1]) assert.equal(production.isImportedAttemptId(bad), false, String(bad));
  assert.equal(production.isImportedAttemptId("A0001"), true);
  const c = emptyImported();
  assert.equal(c.historical, true);
  assert.equal(c.exploratory, true);
  assert.equal("planDigest" in c || "machine" in c || "configurations" in c, false, "an imported case holds no plan and no machine");
});

// Type level: no slot-keyed function takes an imported attempt, and no plain string is one. The stage compiles this file, so a widening fails at its compile.
function typeLevelSeparation(id: ImportedAttemptId, slot: SlotName, c: ImportedCase): void {
  // @ts-expect-error an imported attempt's id is not a slot
  const a: SlotName = id;
  // @ts-expect-error a slot is not an imported attempt's id
  const b: ImportedAttemptId = slot;
  // @ts-expect-error a string of any shape is not an imported attempt's id
  const g: ImportedAttemptId = "Abc";
  // @ts-expect-error an imported case is not an evidence record a machine reads
  const d: EvidenceRecord = c;
  // @ts-expect-error an imported case cannot become anything but historical
  const e: ImportedCase = { ...c, historical: false };
  // @ts-expect-error nor anything but exploratory
  const f: ImportedCase = { ...c, exploratory: false };
  void [a, b, d, e, f, g];
}
void typeLevelSeparation;

const POOLING = "an imported case never meets an aggregate";

function importsOf(source: string): readonly string[] {
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) out.push(node.moduleSpecifier.text);
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile("x.ts", source, ts.ScriptTarget.Latest));
  return out;
}

const read = (file: string) => readFileSync(path.join(process.cwd(), "investigation/core", file), "utf8");

const checkPooling = (readFile: (file: string) => string) => {
  for (const file of ["imported-case.ts", "capture-adapter.ts", "trial-layout.ts", "sufficiency.ts", "recorder-shapes.ts"]) {
    holds(POOLING, !importsOf(readFile(file)).some((specifier) => /aggregates/.test(specifier)), () => file);
  }
  holds(POOLING, !importsOf(readFile("aggregates.ts")).some((specifier) => /imported-case|capture-adapter|trial-layout/.test(specifier)), () => "aggregates.ts");
};

test("no module of the imported case reaches the aggregates, and the aggregates reach none of it", async () => {
  checkPooling(read);
  const plant = (target: string, line: string) => (file: string) => (file === target ? `${line}\n${read(file)}` : read(file));
  await assertCaughtBy("the imported case importing the aggregates", POOLING, () => checkPooling(plant("imported-case.ts", 'import { aggregate } from "./aggregates";')));
  await assertCaughtBy("the adapter importing the aggregates' types", POOLING, () => checkPooling(plant("capture-adapter.ts", 'import type { AggregateRow } from "./aggregates";')));
  await assertCaughtBy("the aggregates importing the imported case", POOLING, () => checkPooling(plant("aggregates.ts", 'import { importCase } from "./imported-case";')));
  // @ts-expect-error an imported row is not an aggregate row
  void (() => aggregate(emptyImported().rows, { id: "m", subject: "s", population: null, keys: null }));
});

test("a row reads by W2's readings, with what limited it, and unread states read as their own reason", () => {
  const observed: ImportedRow = { ...importedRow(ROWS[0]), observation: COUNTED };
  const zero: ImportedRow = { ...importedRow(ROWS[1]), observation: { ...COUNTED, count: 0 } };
  const c = emptyImported([observed, zero, importedRow(ROWS[2])]);
  assert.deepEqual(production.readImportedRow(c, observed), { reading: "observed", count: 3, granularity: "block", windowEnd: "window_closed", complete: false, limits: ["coverage_not_complete", "cleanup_unresolved"] });
  assert.deepEqual(production.readImportedRow(c, zero), { reading: "zero_in_window", granularity: "block", windowEnd: "window_closed", complete: false, limits: ["coverage_not_complete", "cleanup_unresolved", "attempt_incomplete"] });
  assert.deepEqual(production.readImportedRow(c, c.rows[2]), { reading: "unknown", reason: "no_record", complete: false });
  assert.deepEqual(production.readImportedRow(c, importedRow(ROWS[0])), { reading: "recorded" });
  const orphan: ImportedRow = { ...observed, attempt: "A09" as ImportedAttemptId };
  assert.deepEqual(production.readImportedRow(c, orphan), { reading: "unknown", reason: "no_record", complete: false });
  const failed: ImportedCase = { ...c, attempts: c.attempts.map((attempt) => (attempt.id === A02 ? { ...attempt, acquisition: "failed" } : attempt)) };
  assert.equal(production.readImportedRow(failed, zero).reading, "unknown");
  const walled: ImportedCase = { ...c, attempts: c.attempts.map((attempt) => (attempt.id === A02 ? { ...attempt, acquisition: "walled" } : attempt)) };
  const wall = production.readImportedRow(walled, zero);
  assert.ok("limits" in wall && wall.limits.includes("attempt_walled"));
  const stray: ImportedRow = { ...observed, instrument: "unlisted" };
  const unlisted = production.readImportedRow(c, stray);
  assert.ok("limits" in unlisted && unlisted.limits.includes("coverage_not_complete"), JSON.stringify(unlisted));
  const lateZero: ImportedRow = { ...importedRow(ROWS[4]), observation: { ...COUNTED, count: 0 } };
  assert.deepEqual(production.readImportedRow(c, lateZero), { reading: "unknown", reason: "late", complete: false });
});

test("the denominator is every attempt, and evidence is handed back one attempt at a time", () => {
  const c = emptyImported();
  assert.deepEqual(production.importedDenominatorOf(c), { planned: 2, notStarted: 0, usable: 1, walled: 0, failed: 0, incomplete: 1, timed_out: 0, cancelled: 0 });
  assert.deepEqual(production.importedEvidenceFor(c, [A01, A02]), { ok: false, refusal: "one-attempt-at-a-time" });
  assert.deepEqual(production.importedEvidenceFor(c, ["A07"]), { ok: false, refusal: "no-such-attempt" });
  const one = production.importedEvidenceFor(c, [A01]);
  assert.ok(one.ok);
  assert.deepEqual(
    one.rows.map(({ id }) => id),
    ["row-ember", "row-ash", "row-glow", "row-late"]
  );
  assert.deepEqual(production.importedSourceOf(c, A02), { state: "reconstructed", baseCommit: "c0ffee", patchDigest: "cd".repeat(32), identity: "ef".repeat(32) });
  assert.deepEqual(production.importedSourceOf(c, A01), { state: "not_recorded" });
});

/** The structured question the import is handed, as the private run hands it one from its frozen file. */
const QUESTION: Question = { id: "synthetic", text: "Which synthetic script made each call?", requirements: [{ kinds: ["script-inventory", "script-execution"], within: "one-attempt", atLeast: 1 }, { kinds: ["recorder-identity"], within: "the-run" }] };

/** The synthetic run's bytes, read the way the local reader would: ask, hand over what was asked, ask again. */
function asked(thePlan: CapturePlan, all: Files): Map<string, Uint8Array | null> {
  const files = new Map<string, Uint8Array | null>();
  for (let round = 0; round < 10; round += 1) {
    const wanted = capturePathsNeeded(thePlan, files);
    if (wanted.length === 0) return files;
    for (const path of wanted) files.set(path, all.get(path) ?? null);
  }
  throw new Error("the paths never settled");
}

const input = (over: Partial<Record<keyof ImportInput, unknown>> = {}, all: Files = runFiles()): ImportInput => ({ plan: capturePlan(), files: asked(capturePlan(), all), seed: captureSeed(), question: QUESTION, ...over }) as ImportInput;

test("an import reads the run itself, assesses that reading against the question it is handed, and records the question, the verdict, every finding and the run", async () => {
  const given = input();
  const made = await production.importCase(given);
  assert.ok(made.ok, JSON.stringify(made));
  const c = made.case;
  // The case is the adapter's reading of these bytes, and nothing else: its rows, attempts, objects, source and control.
  const adapted = await adaptCaptureRun(given.plan, given.files);
  assert.ok(adapted.ok);
  assert.deepEqual([c.adapter, c.objects, c.attempts, c.rows, c.source, c.control, c.recorderBasis, c.recorderStatement], [adapted.run.adapter, adapted.run.objects, adapted.run.attempts, adapted.run.rows, adapted.run.source, adapted.run.control, adapted.run.recorderBasis, adapted.run.recorderStatement]);
  assert.notEqual(c.source, null, "the synthetic run's source identity is held, so the comparison above is not of two nulls");
  // The assessment is the import's own, of that same reading, and names the question it judged.
  const assessed = assessSufficiency(QUESTION, await surveyCaptureRun(given.plan, given.files));
  assert.ok(assessed.ok);
  assert.deepEqual(c.assessment, { ...assessed.assessment, questionTextDigest: sha(QUESTION.text), questionDigest: sha(canonicalBytes(QUESTION) as Uint8Array) });
  assert.deepEqual([c.assessment.question, c.assessment.verdict, c.runDigest], [QUESTION.id, "supports-import", await production.runDigestOf(c.objects)]);
  assert.equal(c.assessment.runDigest, c.runDigest);
  assert.match(c.recorderStatement, /^declared: /);
  assert.equal(c.question, captureSeed().question, "the seed's own question stays as the owner wrote it");
  assert.equal(c.claimSeq, 5);
  assert.deepEqual(c.facts[1].links.map(({ evidence }) => evidence), ["E-A03-identity-lamp", "E-A04-identity-lamp", "E-A05-identity-lamp"]);
  // A different question is recorded as itself: what was judged is on the case.
  const other: Question = { ...QUESTION, id: "other", text: "Which synthetic script ran?" };
  const otherMade = await production.importCase(input({ question: other }));
  assert.ok(otherMade.ok);
  assert.deepEqual([otherMade.case.assessment.question, otherMade.case.assessment.questionTextDigest === c.assessment.questionTextDigest, otherMade.case.assessment.questionDigest === c.assessment.questionDigest], ["other", false, false]);
});

test("the recorder basis follows the bytes read, never a caller", async () => {
  const attestedPlan = capturePlan({ provenancePath: PROVENANCE_PATH });
  const made = await production.importCase(input({ plan: attestedPlan, files: asked(attestedPlan, runFiles({ [PROVENANCE_PATH]: PROVENANCE_RECORD() })) }));
  assert.ok(made.ok, JSON.stringify(made));
  assert.equal(made.case.recorderBasis, "attested");
  assert.match(made.case.recorderStatement, /signatures are not verified/);
  const declared = await production.importCase(input());
  assert.ok(declared.ok);
  assert.equal(declared.case.recorderBasis, "declared");
});

test("an import its own assessment does not support is refused as such, with the assessment that refused it", async () => {
  const narrow: Question = { id: "narrow", text: "Which synthetic listener ran?", requirements: [{ kinds: ["listener-registrations"], within: "one-attempt", atLeast: 1 }] };
  const refused = await production.importCase(input({ question: narrow }));
  assert.ok(!refused.ok);
  assert.deepEqual([refused.refusal, refused.at, refused.assessment?.verdict], ["does-not-support-import", "assessment", "does-not-support-import"]);
  // A run the adapter refuses is a run no assessment supports.
  const broken = await production.importCase(input({}, runFiles({ "runs/cover-1/observe.json": observeFile({ lampSha: "0".repeat(64) }) })));
  assert.ok(!broken.ok);
  assert.equal(broken.refusal, "does-not-support-import");
  assert.match(broken.assessment?.reasons[0] ?? "", /^the survey's reading refuses this run: digest-mismatch: /);
  assert.deepEqual(await production.importCase(input({ question: { ...QUESTION, requirements: [] } })), { ok: false, refusal: "question-malformed", at: "requirements" });
  assert.deepEqual(await production.importCase(input({ question: { ...QUESTION, text: "\ud800" } })), { ok: false, refusal: "question-malformed", at: "question" });
  assert.deepEqual(await production.importCase(input({ question: { ...QUESTION, id: "q\ud800" } })), { ok: false, refusal: "question-malformed", at: "question" });
});

test("the input is the plan, the bytes, the seed and the question, exactly: no run, survey or assessment a caller built is taken", async () => {
  const base = input();
  const made = await production.importCase(base);
  assert.ok(made.ok);
  const adapted = await adaptCaptureRun(base.plan, base.files);
  assert.ok(adapted.ok);
  const assessment = made.case.assessment;
  for (const extra of [{ run: adapted.run }, { assessment }, { survey: await surveyCaptureRun(base.plan, base.files) }, { assessment: { runDigest: made.case.runDigest, verdict: "supports-import" } }]) {
    assert.deepEqual(await production.importCase({ ...base, ...extra } as never), { ok: false, refusal: "input-malformed", at: "input" }, Object.keys(extra)[0]);
  }
  // The rows are only the adapter's: the case holds exactly the rows its reading made.
  assert.deepEqual(made.case.rows, adapted.run.rows);
});

test("the map holds every path the adapter asks for, one found missing as null: a path it does not hold is refused by its place in the list asked for", async () => {
  const order = [...asked(capturePlan(), runFiles()).keys()];
  assert.equal(input().files.get(PROVENANCE_PATH), null, "the pinned path, found missing, is a key with null");
  for (const path of [PROVENANCE_PATH, "runs/logged-1/witness.json"]) {
    const given = input();
    (given.files as Map<string, Uint8Array | null>).delete(path);
    assert.ok(order.indexOf(path) >= 0, path);
    const refused = await production.importCase(given);
    assert.deepEqual(refused, { ok: false, refusal: "input-malformed", at: `asked[${order.indexOf(path)}]: a path the adapter asked for that the map does not hold` }, path);
    assert.ok(!JSON.stringify(refused).includes(path.split("/").pop() as string), JSON.stringify(refused));
  }
});

/** The synthetic run on each basis, and once with the logger's frames found missing. */
const BASES = (): readonly (readonly [string, CapturePlan, Files])[] => [
  ["declared", capturePlan(), runFiles()],
  ["attested", capturePlan({ provenancePath: PROVENANCE_PATH }), runFiles({ [PROVENANCE_PATH]: PROVENANCE_RECORD() })],
  ["frames found missing", capturePlan(), runFiles({ "runs/logged-1/witness.json": null })]
];

test("on either basis, a map without any one path the adapter asks for is refused by the adapter, its survey and the import, by place, never read as found missing", async () => {
  for (const [basis, thePlan, all] of BASES().slice(0, 2)) {
    const whole = asked(thePlan, all);
    assert.ok((await adaptCaptureRun(thePlan, whole)).ok, basis);
    const keys = [...whole.keys()];
    assert.ok(keys.length > 10, basis);
    for (const [index, key] of keys.entries()) {
      const without = new Map(whole);
      without.delete(key);
      const label = `${basis}, asked[${index}]`;
      assert.equal((await adaptCaptureRun(thePlan, without)).ok, false, label);
      assert.notEqual((await surveyCaptureRun(thePlan, without)).refusal, null, label);
      const refused = await production.importCase({ plan: thePlan, files: without, seed: captureSeed(), question: QUESTION });
      if (refused.ok || refused.at === null) assert.fail(label);
      assert.equal(refused.refusal, "input-malformed", label);
      // By its place: the path itself, or a path the adapter asks for only once that one is read.
      assert.match(refused.at, /^(asked\[\d+\]: a path the adapter asked for that the map does not hold|files\[\d+\]: a path the adapter did not ask for)$/, label);
      if (refused.at.startsWith("asked[")) assert.equal(refused.at, `asked[${index}]: a path the adapter asked for that the map does not hold`, label);
      assert.ok(!refused.at.includes(key.split("/").pop() as string), label);
    }
  }
});

test("the adapter reads only paths capturePathsNeeded asked for, on either basis and with a path found missing", async () => {
  for (const [basis, thePlan, all] of BASES()) {
    const whole = asked(thePlan, all);
    const read = new Set<string>();
    const watched = new Map(whole);
    const get = watched.get.bind(watched);
    watched.get = (key: string) => {
      read.add(key);
      return get(key);
    };
    assert.ok((await adaptCaptureRun(thePlan, watched)).ok, basis);
    await surveyCaptureRun(thePlan, watched);
    assert.ok(read.size > 0, basis);
    assert.deepEqual([...read].filter((key) => !whole.has(key)), [], basis);
  }
});

test("the seed and the question's canonical form are held to their shapes before the run is read, so a malformed one is refused as such on every run", async () => {
  const broken = runFiles({ "runs/cover-1/observe.json": observeFile({ lampSha: "0".repeat(64) }) });
  const badSeed = { ...captureSeed(), facts: "none" };
  assert.deepEqual(await production.importCase(input({ seed: badSeed }, broken)), { ok: false, refusal: "seed-malformed", at: "seed" });
  assert.deepEqual(await production.importCase(input({ seed: badSeed, plan: null })), { ok: false, refusal: "seed-malformed", at: "seed" });
  assert.deepEqual(await production.importCase(input({ question: { ...QUESTION, text: "\ud800" } }, broken)), { ok: false, refusal: "question-malformed", at: "question" });
  assert.deepEqual(await production.importCase(input({ question: { ...QUESTION, text: "\ud800" }, plan: null })), { ok: false, refusal: "question-malformed", at: "question" });
  // A question whose text is well formed but which has no canonical form (a number that is not an integer) is refused before the run is read too.
  assert.deepEqual(await production.importCase(input({ question: { ...QUESTION, extra: 1.5 } }, broken)), { ok: false, refusal: "question-malformed", at: "question" });
});

test("a run's digest changes with any object's digest, size or name, and not with the order they were listed in", async () => {
  const objects = [{ path: "runs/first/row.json", digest: "ab".repeat(32), bytes: 10 }, { path: "a", digest: "00".repeat(32), bytes: 1 }];
  const digest = await production.runDigestOf(objects);
  assert.notEqual(digest, await production.runDigestOf([{ ...objects[0], digest: "ac".repeat(32) }, objects[1]]));
  assert.notEqual(digest, await production.runDigestOf([{ ...objects[0], bytes: 11 }, objects[1]]));
  assert.notEqual(digest, await production.runDigestOf([{ ...objects[0], path: "runs/first/row2.json" }, objects[1]]));
  assert.equal(digest, await production.runDigestOf([objects[1], objects[0]]));
});

test("an import refuses every malformed input by its place, and never throws", async () => {
  const good = input();
  const malformedInputs: readonly (readonly [unknown, string, string])[] = [
    [null, "input-malformed", "input"],
    [[], "input-malformed", "input"],
    [{}, "input-malformed", "input"],
    [{ plan: good.plan, files: good.files, seed: good.seed }, "input-malformed", "input"],
    [{ ...good, files: [...good.files] }, "input-malformed", "files"],
    [{ ...good, files: new Map([[7, null]]) }, "input-malformed", "files: a path"],
    [{ ...good, files: new Map([["../outside.json", null]]) }, "input-malformed", "files: a path"],
    [{ ...good, files: new Map([["runs/plain-1/row.json", "not bytes"]]) }, "input-malformed", "files: the bytes of a path"],
    [{ ...good, plan: null }, "input-malformed", "plan"],
    [{ ...good, plan: { ...good.plan, recipes: "none" } }, "input-malformed", "plan: recipes"],
    [{ ...good, plan: { ...good.plan, provenancePath: "elsewhere/attestations.json" } }, "input-malformed", "plan: provenancePath"],
    [{ ...good, question: null }, "question-malformed", "question"],
    [{ ...good, question: { ...QUESTION, requirements: [{ kinds: null, within: "the-run" }] } }, "question-malformed", "requirements[0].kinds"],
    [{ ...good, files: new Map([...good.files, ["\ud800", new Uint8Array(1)]]) }, "input-malformed", "files: a path"],
    [{ plan: good.plan, files: good.files, seed: good.seed, assessment: {} }, "input-malformed", "input"],
    [{ ...good, files: new Map([...good.files, ["runs/plain-1/analysis/big.json", new Uint8Array(1)]]) }, "input-malformed", `files[${good.files.size}]: a path the adapter did not ask for`]
  ];
  for (const [given, refusal, at] of malformedInputs) {
    let result: unknown;
    await assert.doesNotReject(async () => {
      result = await production.importCase(given as never);
    }, JSON.stringify(given)?.slice(0, 80));
    assert.deepEqual([(result as { refusal: string }).refusal, (result as { at: string }).at], [refusal, at], JSON.stringify(given)?.slice(0, 80));
  }
  const seed = captureSeed();
  const seedCases: readonly (readonly [unknown, string])[] = [
    [null, "seed"],
    [{ ...seed, facts: null }, "seed"],
    [{ ...seed, question: 7 }, "seed"],
    [{ ...seed, control: "from the seed" }, "seed"],
    [{ ...seed, provenanceGaps: [1] }, "provenanceGaps"],
    [{ ...seed, deviations: [{ id: "dev-one" }] }, "deviations"],
    [{ ...seed, deviations: [{ id: "dev-one", summary: "x", note: "an extra key" }] }, "deviations"],
    [{ ...seed, independentReproduction: { state: "none", note: "x", url: "an extra key" } }, "independentReproduction"],
    [{ ...seed, independentReproduction: null }, "independentReproduction"],
    [{ ...seed, facts: [{ id: 7, statement: "x", evidence: ["E-A01-read"] }] }, "facts[0]"],
    [{ ...seed, facts: [{ id: "fact-f", statement: null, evidence: ["E-A01-read"] }] }, "facts[0]"],
    [{ ...seed, facts: [{ id: "fact-f", statement: "x" }] }, "facts[0]"],
    [{ ...seed, facts: [{ id: "fact-f", statement: "x", evidence: null }] }, "facts[0]"],
    [{ ...seed, facts: [{ id: "fact-f", statement: "x", evidence: ["E-A01-read"], support: 3 }] }, "facts[0]"],
    [{ ...seed, assertions: [{ id: "", statement: "x" }] }, "assertions[0]"],
    [{ ...seed, interpretations: [{ id: "reading-i", statement: "x" }] }, "interpretations[0]"],
    [{ ...seed, interpretations: [{ id: "reading-i", statement: "x", cites: [{ fact: "fact-f", version: 0 }] }] }, "interpretations[0].cites"],
    [{ ...seed, interpretations: [{ id: "reading-i", statement: "x", cites: [null] }] }, "interpretations[0].cites"],
    [{ ...seed, unknowns: [{ id: "u", question: "q", reason: "r", detail: 3, wouldResolve: null }] }, "unknowns[0]"],
    [{ ...seed, unknowns: [null] }, "unknowns[0]"]
  ];
  for (const [badSeed, at] of seedCases) {
    let result: unknown;
    await assert.doesNotReject(async () => {
      result = await production.importCase(input({ seed: badSeed }));
    }, at);
    assert.deepEqual(result, { ok: false, refusal: "seed-malformed", at }, at);
  }
  // A claim the run cannot hold refuses the import by its place.
  assert.deepEqual(await production.importCase(input({ seed: { ...seed, facts: [{ id: "fact-f", statement: "Rests on nothing.", evidence: ["E-A01-none"] }], interpretations: [] } })), { ok: false, refusal: "no-such-row", at: "facts[0].evidence" });
});

test("the import works on a clone made at entry: what the caller's objects do later reaches neither the assessment nor the case", async () => {
  const given = input();
  const question = JSON.parse(JSON.stringify(QUESTION)) as Question;
  const made = await production.importCase({ ...given, question });
  assert.ok(made.ok);
  (question.requirements[0] as { atLeast: number }).atLeast = 99;
  assert.deepEqual(made.case.assessment.requirements[0].requirement, QUESTION.requirements[0]);
  // A value no clone can be made of is refused, never thrown on: a detached buffer, a getter that throws, a proxy.
  const detached = new Uint8Array(4);
  structuredClone(detached.buffer, { transfer: [detached.buffer] });
  const throwing = { ...captureSeed() };
  Object.defineProperty(throwing, "question", { enumerable: true, get: () => { throw new Error("boom"); } });
  for (const [name, bad] of [
    ["a detached buffer", { ...given, files: new Map([...given.files, ["runs/plain-1/row.json", detached]]) }],
    ["a getter that throws", { ...given, seed: throwing }],
    ["a proxy for the question", { ...given, question: new Proxy(QUESTION, {}) }]
  ] as const) {
    let result: unknown;
    await assert.doesNotReject(async () => {
      result = await production.importCase(bad as never);
    }, name);
    assert.deepEqual(result, { ok: false, refusal: "input-malformed", at: "input" }, name);
  }
});

test("an output nested too deeply to spell is refused through the import too, never thrown", async () => {
  const written = new TextDecoder().decode(observeFile());
  // Deeper than any stack spells, however warm the code that spells it.
  const nested = written.replace('"parameters":{"target_id":"SYNTHETICTARGET"}', `"parameters":${'{"d":'.repeat(200000)}1${"}".repeat(200000)}`);
  let result: unknown;
  await assert.doesNotReject(async () => {
    result = await production.importCase(input({}, runFiles({ "runs/cover-1/observe.json": new TextEncoder().encode(nested) })));
  });
  const refused = result as { ok: false; refusal: string; assessment?: { reasons: readonly string[] } };
  assert.equal(refused.refusal, "does-not-support-import");
  assert.match(refused.assessment?.reasons[0] ?? "", /unknown-shape: runs\/cover-1\/observe\.json: evidence_id/);
});

test("a walled attempt, reachable through an import's own input, reads as W2 reads it", async () => {
  const walled = runFiles({ "runs/cover-1/row.json": rowFile(["observe", "inspect"], { mainDocumentStatus: 403 }) });
  const anchor = `E-A04-cov-lamp-canvas-font-${MEASURE_OFFSETS[1]}`;
  const made = await production.importCase(input({ seed: captureSeed({ facts: [{ id: "fact-walled", statement: "Counted though walled.", evidence: [anchor] }], interpretations: [] }) }, walled));
  assert.ok(made.ok, JSON.stringify(made));
  assert.equal(made.case.attempts[3].acquisition, "walled");
  assert.ok(made.case.facts[0].links[0].limits.includes("attempt_walled"), JSON.stringify(made.case.facts[0].links[0].limits));
  assert.deepEqual(production.importedDenominatorOf(made.case).walled, 1);
});

test("a reaffirm is held to cites of the interpretation's own facts at their current versions, none left out and none repeated", () => {
  const applied = (c: ImportedCase, ...events: readonly ImportedClaimEvent[]) =>
    events.reduce((held, event) => {
      const result = production.applyImportedClaim(held, event);
      if (!result.ok) throw new Error(`refused: ${JSON.stringify(result)}`);
      return result.case;
    }, c);
  const c = applied(
    emptyImported(),
    { type: "fact-recorded", id: "fact-f", statement: "Statement of f.", evidence: ["row-ember"] },
    { type: "fact-recorded", id: "fact-g", statement: "Statement of g.", evidence: ["row-flint"] },
    { type: "fact-recorded", id: "fact-x", statement: "Statement of x.", evidence: ["row-flint"] },
    { type: "interpretation-recorded", id: "reading-i", statement: "Reading i.", cites: [{ fact: "fact-f", version: 1 }, { fact: "fact-g", version: 1 }] },
    { type: "fact-superseded", fact: "fact-f", statement: "New wording of f.", reason: "It said more than the rows." }
  );
  for (const [cites, refusal] of [
    [[], "interpretation-needs-cites"],
    [[{ fact: "fact-f", version: 2 }, { fact: "fact-f", version: 2 }], "cites-repeated"],
    [[{ fact: "fact-f", version: 2 }, { fact: "fact-x", version: 1 }], "cites-not-its-facts"],
    [[{ fact: "fact-f", version: 2 }], "cites-not-its-facts"]
  ] as const) {
    assert.deepEqual(production.applyImportedClaim(c, { type: "interpretation-reaffirmed", interpretation: "reading-i", cites }), { ok: false, refusal, at: "cites" }, JSON.stringify(cites));
  }
  assert.ok(production.applyImportedClaim(c, { type: "interpretation-reaffirmed", interpretation: "reading-i", cites: [{ fact: "fact-f", version: 2 }, { fact: "fact-g", version: 1 }] }).ok);
});

