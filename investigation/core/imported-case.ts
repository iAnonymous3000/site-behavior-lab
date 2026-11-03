// An imported case: what a recorded run held, brought in after the fact, as a record kind of its
// own. It has no plan, no machine and no slots. Its attempts are named by their own id type, the
// letter A and digits, which no slot name can be, so nothing written for a planned case's six slots
// takes one of them. It is historical and exploratory by construction: both are literal true in
// its type, and nothing here makes a planned case from one or one from a planned case.
//
// It is never pooled. aggregates.ts takes rows keyed by slot, read from a machine, and nothing here
// produces one, so no aggregate can hold an imported attempt beside a planned one. Its counts are
// its own denominator: every attempt the seed's plan names, whatever became of it. Nothing here checks
// the plan against the folder, so an attempt the plan leaves out is in no count.
//
// Raw bytes stay where the run left them. The case refers to each object it read by its relative
// path and its digest, and each row names the object holding its bytes. A row keeps what the summary
// tier keeps (summary-tier.ts): an origin as a URL parser spells it, a path and a script's text as
// digests, counts, and the instrument's own vocabulary. No URL path, query, script text or other
// prose from a capture reaches it. The summary tier's stated limits apply here too: a host can carry
// whatever a site put in it, and a path digest is an unsalted sha256, so anyone who can guess a path
// can confirm it, from a row's digest or from the twelve digits of it a row's id can carry where the
// seed names no label for its script. It hides a path from a reader, not from a determined one.
//
// Claims are the owner's, and every claim function here is one: a fact rests on present rows of
// this case, an assertion is what someone said and nothing checked, an interpretation cites current
// fact versions, and an unknown is a question with its reason. These restate the rules of
// applyRecordEvent in evidence-model.ts for attempts instead of slots, since those functions read a
// machine and a slot, and W2's files stay as they are. The types that need no slot are W2's own.
// investigation/test/imported-case.test.ts runs one script of claims through both and holds them to
// the same claims and the same refusals, so the two cannot drift apart unseen.
//
// The import (importCase) takes the plan, a map of the run's bytes holding exactly the paths the
// adapter asks for, the seed's claims and the structured question, works on a clone of them, and
// itself reads the run, surveys that reading and assesses it, so a case exists only for a run the
// import's own assessment supported, and records that assessment: the question by its id and
// digests, the verdict, every finding and the run's digest. No run, survey or assessment a caller
// built is accepted.
//
// Persistence is deferred: no log event carries an imported case, so it lives in memory, and its
// sequence counts the claims applied to it in this process. A refusal names a field or a kind,
// never a value it was handed.

import { capturePathsNeeded, readCaptureRun, type CapturePlan, type Files } from "./capture-adapter";
import { canonicalBytes, sha256Hex } from "./canonical-json";
import type { Assertion, Cite, Fact, Interpretation, InterpretationFlag, RecordEvent, RecordRefusal, RowObservation, RowReading, RowState, RowWindow, SourceReading, Unknown, UnknownInput } from "./evidence-model";
import type { ImportedAttemptId, RunObject } from "./imported-ids";
import { readObservation } from "./readings";
import { isInsidePath } from "./recorder-shapes";
import { assessSufficiency, type Assessment, type Question } from "./sufficiency";

export { importedAttemptId, isImportedAttemptId, runDigestOf } from "./imported-ids";
export type { ImportedAttemptId } from "./imported-ids";

/** How a recorded attempt ended, as far as acquisition goes. A deadline and a cancel need a machine, so they never appear here. */
export type Acquisition = "usable" | "walled" | "failed" | "incomplete";

export type ImportedInstrument = Readonly<{
  name: string;
  completeness: "complete" | "partial" | "missing";
  /** Why it is not complete, in the adapter's words. Null when complete. */
  reason: string | null;
  /** What the instrument reported of its own cleanup, or null when it reported nothing. Never the browser's. */
  cleanup: string | null;
  /** The recorder's own stated limitations of the output this instrument left, by identifier, or null when no recorder output of it was read. */
  recorderLimitations: readonly string[] | null;
}>;

export type ImportedAttempt = Readonly<{
  id: ImportedAttemptId;
  /** The run's own name for its folder, as the seed gives it. */
  run: string;
  recipe: string;
  startedAt: string;
  durationMs: number;
  acquisition: Acquisition;
  acquisitionReason: string | null;
  /** The main document's status as the harness recorded it, or null when it recorded none. */
  page: Readonly<{ status: number | null }>;
  instruments: readonly ImportedInstrument[];
  /** What showed the scanner's own source identity for this attempt. Never observed for a historical run. */
  sourceIdentity: "not_recorded" | "reconstructed";
}>;

/** A script as the summary tier would keep it. Each part is null when the capture did not say. */
export type ScriptRef = Readonly<{ origin: string | null; pathDigest: string | null; textDigest: string | null }>;

export type RequestRef = Readonly<{ method: string; origin: string | null; pathDigest: string | null }>;

type RowBase = Readonly<{
  id: string;
  attempt: ImportedAttemptId;
  /** One instrument, or the instruments of a join, joined by a plus sign. */
  instrument: string;
  state: RowState;
  window: RowWindow;
  limits: readonly string[];
  /** The object holding the row's raw bytes. Only a present row read from one object has one. */
  digest: string | null;
  observation: RowObservation | null;
}>;

export type ImportedRow = RowBase &
  (
    | Readonly<{ topic: "report-read"; reportKinds: readonly string[]; laterKinds: readonly string[] }>
    | Readonly<{ topic: "connection-inspection"; address: Readonly<{ origin: string | null; pathDigest: string | null }>; counts: Readonly<Record<string, number>> }>
    | Readonly<{ topic: "script-identity"; script: ScriptRef }>
    | Readonly<{ topic: "anchor-coverage"; script: ScriptRef; anchor: string; offset: number }>
    | Readonly<{ topic: "request"; request: RequestRef; callsite: ScriptRef | null; causalAttribution: string }>
    | Readonly<{ topic: "attributed-calls"; api: string; script: ScriptRef | null; calls: number }>
    | Readonly<{ topic: "calls-in-executed-ranges"; api: string; script: ScriptRef | null; calls: number; inside: number; ranges: readonly (readonly [number, number, number])[]; joined: readonly string[] }>
  );

export type RowTopic = ImportedRow["topic"];

/** What the adapter that read the run says it accepts. It is recorded on the case it made. */
export type AdapterIdentity = Readonly<{
  name: string;
  version: number;
  recorder: Readonly<{ name: string; release: string; commit: string; integrity: string }>;
  shapes: Readonly<Record<string, string>>;
}>;

export type ImportedObject = RunObject;

export type ImportedSource = Readonly<{
  state: "reconstructed";
  baseCommit: string;
  patch: Readonly<{ path: string; sha256: string }>;
  identity: string;
  appliesTo: readonly ImportedAttemptId[];
}>;

export type ControlRead = Readonly<{ name: string; readsAs: "executed" | "not executed" | "count 0" | "no record" | "false execution claim" }>;

export type ImportedControl = Readonly<{
  historical: Readonly<{ criterionAsWritten: string; result: "met" | "not_met"; observed: Readonly<Record<string, string>>; gate: string; deviation: string; preserved: boolean }>;
  current: Readonly<{ text: string; note: string; sameOutputWouldRead: "met" | "not_met"; digestMatches: boolean; called: readonly ControlRead[]; uncalled: readonly ControlRead[] }>;
  /** The limitations REA stated for the control run's observation, by identifier. */
  recorderLimitations: readonly string[];
}>;

/**
 * The assessment the import itself made of the run it imports, against the structured question it
 * was handed: the verdict, each requirement's findings kind by kind, with each attempt's status and
 * reason, the run it judged by digest, and the question by its id, the sha256 of its text and the
 * sha256 of W2's canonical bytes of the whole question.
 */
export type RecordedAssessment = Assessment & Readonly<{ questionTextDigest: string; questionDigest: string }>;

export type ImportedFactLink = Readonly<{ evidence: string; attempt: ImportedAttemptId; instrument: string; window: RowWindow; limits: readonly string[] }>;

export type ImportedFact = Omit<Fact, "links"> & Readonly<{ links: readonly ImportedFactLink[] }>;

export type ImportedCase = Readonly<{
  kind: "imported-case";
  historical: true;
  exploratory: true;
  adapter: AdapterIdentity;
  /** On what the recorder's identity rests: a provenance statement at the pinned path, or the seed's declaration. See recorderIdentityOf in recorder-shapes.ts. */
  recorderBasis: "attested" | "declared";
  /** What that basis means here, in the identity rule's words: an attested statement's signatures are not verified. */
  recorderStatement: string;
  /** The digest of the run as read: see runDigestOf. */
  runDigest: string;
  /** The import's own assessment of this run. Its verdict supported the import, or there would be no case. */
  assessment: RecordedAssessment;
  /** The seed's own question, as the owner wrote it. The structured question assessed is in the assessment. */
  question: string;
  objects: readonly ImportedObject[];
  attempts: readonly ImportedAttempt[];
  rows: readonly ImportedRow[];
  source: ImportedSource | null;
  provenanceGaps: readonly string[];
  control: ImportedControl | null;
  deviations: readonly Readonly<{ id: string; summary: string }>[];
  independentReproduction: Readonly<{ state: string; note: string }>;
  facts: readonly ImportedFact[];
  assertions: readonly Assertion[];
  interpretations: readonly Interpretation[];
  unknowns: readonly Unknown[];
  /** How many claims this process applied, which is the order a history or a flag records. */
  claimSeq: number;
}>;

/** The claim events, by W2's own types. What a capture records of itself needs a machine, so it has no place here. */
export type ImportedClaimEvent = Extract<
  RecordEvent,
  { type: "fact-recorded" | "fact-superseded" | "fact-retracted" | "assertion-recorded" | "assertion-retracted" | "interpretation-recorded" | "interpretation-reaffirmed" | "unknown-recorded" }
>;

export const IMPORTED_CLAIM_TYPES: readonly ImportedClaimEvent["type"][] = [
  "fact-recorded",
  "fact-superseded",
  "fact-retracted",
  "assertion-recorded",
  "assertion-retracted",
  "interpretation-recorded",
  "interpretation-reaffirmed",
  "unknown-recorded"
];

export type ImportedClaimRefusal = Extract<
  RecordRefusal,
  | "id-taken"
  | "fact-needs-evidence"
  | "no-such-row"
  | "row-not-present"
  | "no-such-claim"
  | "not-a-fact"
  | "not-an-assertion"
  | "not-an-interpretation"
  | "fact-not-current"
  | "same-wording"
  | "assertion-already-retracted"
  | "interpretation-needs-cites"
  | "cites-assertion"
  | "cites-interpretation"
  | "cites-unknown"
  | "cites-no-such-fact"
  | "cite-not-current"
  | "cites-repeated"
  | "cites-not-its-facts"
  | "not-flagged"
>;

export type ImportedClaimResult = Readonly<{ ok: true; case: ImportedCase }> | Readonly<{ ok: false; refusal: ImportedClaimRefusal | "unknown-claim"; at: string | null }>;

function refuse(refusal: ImportedClaimRefusal | "unknown-claim", at: string | null = null): ImportedClaimResult {
  return { ok: false, refusal, at };
}

type AnyClaim = ImportedFact | Assertion | Interpretation | Unknown;

function claimWithId(c: ImportedCase, id: string): AnyClaim | null {
  return c.facts.find((fact) => fact.id === id) ?? c.assertions.find((assertion) => assertion.id === id) ?? c.interpretations.find((interpretation) => interpretation.id === id) ?? c.unknowns.find((unknown) => unknown.id === id) ?? null;
}

/** One namespace across rows and every kind of claim, as in W2. */
function isIdTaken(c: ImportedCase, id: string): boolean {
  return claimWithId(c, id) !== null || c.rows.some((row) => row.id === id);
}

function unknownFrom(input: UnknownInput): Unknown {
  return { kind: "unknown", id: input.id, question: input.question, reason: input.reason, detail: input.detail, wouldResolve: input.wouldResolve };
}

function citeRefusal(c: ImportedCase, cite: Cite): ImportedClaimResult | null {
  const claim = claimWithId(c, cite.fact);
  if (claim === null) return refuse("cites-no-such-fact", "cites");
  if (claim.kind === "assertion") return refuse("cites-assertion", "cites");
  if (claim.kind === "interpretation") return refuse("cites-interpretation", "cites");
  if (claim.kind === "unknown") return refuse("cites-unknown", "cites");
  if (claim.status !== "current" || claim.version !== cite.version) return refuse("cite-not-current", "cites");
  return null;
}

function hasRepeatedCite(cites: readonly Cite[]): boolean {
  return new Set(cites.map(({ fact }) => fact)).size !== cites.length;
}

function flagDependents(c: ImportedCase, factId: string, fromVersion: number, change: InterpretationFlag["change"], atSeq: number): ImportedCase {
  return {
    ...c,
    interpretations: c.interpretations.map((interpretation) =>
      interpretation.cites.some(({ fact }) => fact === factId) ? { ...interpretation, review: "needs_review", flags: [...interpretation.flags, { fact: factId, fromVersion, change, atSeq }] } : interpretation
    )
  };
}

function findFact(c: ImportedCase, id: string): ImportedFact | ImportedClaimResult {
  const claim = claimWithId(c, id);
  if (claim === null) return refuse("no-such-claim", "fact");
  if (claim.kind !== "fact") return refuse("not-a-fact", "fact");
  return claim;
}

function isRefused(value: ImportedFact | ImportedClaimResult): value is ImportedClaimResult {
  return "ok" in value;
}

function replaced(c: ImportedCase, fact: ImportedFact): ImportedCase {
  return { ...c, facts: c.facts.map((existing) => (existing.id === fact.id ? fact : existing)) };
}

/** A late row that held bytes and a count above 0: what it saw still happened, however late it said so. As W2's isLatePositive. */
function isLatePositive(row: ImportedRow): boolean {
  const count = row.observation === null ? null : row.observation.count;
  return row.state === "late" && row.digest !== null && count !== null && count > 0;
}

function operationOf(acquisition: Acquisition): "succeeded" | "walled" | "incomplete" | "failed_retained" {
  if (acquisition === "usable") return "succeeded";
  return acquisition === "failed" ? "failed_retained" : acquisition;
}

/**
 * A row as the reader sees it, by W2's readings. A row not present is unknown with its own state as
 * the reason, except a late positive, which reads what it counted with late as a limit, as W2's
 * readRow does. An observation reads through readObservation with the attempt's acquisition and the
 * instrument's coverage, and with cleanup unconfirmed, since no recorded run here confirmed the
 * browser's cleanup. What an instrument said of its own cleanup is not that.
 */
export function readImportedRow(c: ImportedCase, row: ImportedRow): RowReading {
  if (row.state !== "present" && !isLatePositive(row)) return { reading: "unknown", reason: row.state as Exclude<RowState, "present">, complete: false };
  if (row.observation === null) return { reading: "recorded" };
  const attempt = c.attempts.find(({ id }) => id === row.attempt);
  if (attempt === undefined) return { reading: "unknown", reason: "no_record", complete: false };
  const instrument = attempt.instruments.find(({ name }) => name === row.instrument);
  const reading = readObservation({
    record: "present",
    count: row.observation.count,
    granularity: row.observation.granularity,
    windowEnd: row.observation.windowEnd,
    scope: row.observation.scope,
    completeness: instrument === undefined ? "not_recorded" : instrument.completeness,
    cleanup: "unconfirmed",
    operation: operationOf(attempt.acquisition)
  });
  // The positive check above leaves only a count above 0 here, so a late row reads observed.
  return row.state === "late" && reading.reading === "observed" ? { ...reading, complete: false, limits: [...reading.limits, "late"] } : reading;
}

function limitsOfReading(reading: RowReading): readonly string[] {
  return "limits" in reading ? reading.limits : [];
}

function factRecorded(c: ImportedCase, event: Extract<ImportedClaimEvent, { type: "fact-recorded" }>): ImportedClaimResult {
  if (isIdTaken(c, event.id)) return refuse("id-taken", "id");
  if (event.evidence.length === 0) return refuse("fact-needs-evidence", "evidence");
  const links: ImportedFactLink[] = [];
  for (const id of event.evidence) {
    const row = c.rows.find((candidate) => candidate.id === id);
    if (row === undefined) return refuse("no-such-row", "evidence");
    if (row.state !== "present" && !isLatePositive(row)) return refuse("row-not-present", "evidence");
    const reading = readImportedRow(c, row);
    links.push({ evidence: row.id, attempt: row.attempt, instrument: row.instrument, window: row.window, limits: "limits" in reading ? [...new Set([...row.limits, ...limitsOfReading(reading)])] : row.limits });
  }
  return { ok: true, case: { ...c, facts: [...c.facts, { kind: "fact", id: event.id, version: 1, status: "current", statement: event.statement, links, history: [], retraction: null }] } };
}

function factSuperseded(c: ImportedCase, event: Extract<ImportedClaimEvent, { type: "fact-superseded" }>, atSeq: number): ImportedClaimResult {
  const fact = findFact(c, event.fact);
  if (isRefused(fact)) return fact;
  if (fact.status !== "current") return refuse("fact-not-current", "fact");
  if (fact.statement === event.statement) return refuse("same-wording", "statement");
  const next: ImportedFact = { ...fact, version: fact.version + 1, statement: event.statement, history: [...fact.history, { version: fact.version, statement: fact.statement, reason: event.reason, atSeq }] };
  return { ok: true, case: flagDependents(replaced(c, next), fact.id, fact.version, "superseded", atSeq) };
}

function factRetracted(c: ImportedCase, event: Extract<ImportedClaimEvent, { type: "fact-retracted" }>, atSeq: number): ImportedClaimResult {
  const fact = findFact(c, event.fact);
  if (isRefused(fact)) return fact;
  if (fact.status !== "current") return refuse("fact-not-current", "fact");
  if (event.unknown !== null && isIdTaken(c, event.unknown.id)) return refuse("id-taken", "unknown.id");
  const next: ImportedFact = { ...fact, status: "retracted", retraction: { reason: event.reason, atSeq, replacedByUnknown: event.unknown === null ? null : event.unknown.id } };
  const flagged = flagDependents(replaced(c, next), fact.id, fact.version, "retracted", atSeq);
  return { ok: true, case: event.unknown === null ? flagged : { ...flagged, unknowns: [...flagged.unknowns, unknownFrom(event.unknown)] } };
}

function assertionRetracted(c: ImportedCase, event: Extract<ImportedClaimEvent, { type: "assertion-retracted" }>, atSeq: number): ImportedClaimResult {
  const claim = claimWithId(c, event.assertion);
  if (claim === null) return refuse("no-such-claim", "assertion");
  if (claim.kind !== "assertion") return refuse("not-an-assertion", "assertion");
  if (claim.status === "retracted") return refuse("assertion-already-retracted", "assertion");
  if (isIdTaken(c, event.unknown.id)) return refuse("id-taken", "unknown.id");
  const retracted: Assertion = { ...claim, status: "retracted", retraction: { reason: event.reason, atSeq, replacedByUnknown: event.unknown.id } };
  return { ok: true, case: { ...c, assertions: c.assertions.map((existing) => (existing.id === claim.id ? retracted : existing)), unknowns: [...c.unknowns, unknownFrom(event.unknown)] } };
}

function interpretationRecorded(c: ImportedCase, event: Extract<ImportedClaimEvent, { type: "interpretation-recorded" }>): ImportedClaimResult {
  if (isIdTaken(c, event.id)) return refuse("id-taken", "id");
  if (event.cites.length === 0) return refuse("interpretation-needs-cites", "cites");
  if (hasRepeatedCite(event.cites)) return refuse("cites-repeated", "cites");
  for (const cite of event.cites) {
    const refusal = citeRefusal(c, cite);
    if (refusal !== null) return refusal;
  }
  return { ok: true, case: { ...c, interpretations: [...c.interpretations, { kind: "interpretation", id: event.id, statement: event.statement, cites: event.cites, review: "current", flags: [], reaffirmations: 0 }] } };
}

function interpretationReaffirmed(c: ImportedCase, event: Extract<ImportedClaimEvent, { type: "interpretation-reaffirmed" }>): ImportedClaimResult {
  const claim = claimWithId(c, event.interpretation);
  if (claim === null) return refuse("no-such-claim", "interpretation");
  if (claim.kind !== "interpretation") return refuse("not-an-interpretation", "interpretation");
  if (claim.review !== "needs_review") return refuse("not-flagged", "interpretation");
  if (event.cites.length === 0) return refuse("interpretation-needs-cites", "cites");
  if (hasRepeatedCite(event.cites)) return refuse("cites-repeated", "cites");
  if (event.cites.length !== claim.cites.length || !event.cites.every(({ fact }) => claim.cites.some((cite) => cite.fact === fact))) return refuse("cites-not-its-facts", "cites");
  for (const cite of event.cites) {
    const refusal = citeRefusal(c, cite);
    if (refusal !== null) return refusal;
  }
  const reaffirmed: Interpretation = { ...claim, cites: event.cites, review: "current", flags: [], reaffirmations: claim.reaffirmations + 1 };
  return { ok: true, case: { ...c, interpretations: c.interpretations.map((existing) => (existing.id === claim.id ? reaffirmed : existing)) } };
}

function applied(c: ImportedCase, event: ImportedClaimEvent, atSeq: number): ImportedClaimResult {
  switch (event.type) {
    case "fact-recorded":
      return factRecorded(c, event);
    case "fact-superseded":
      return factSuperseded(c, event, atSeq);
    case "fact-retracted":
      return factRetracted(c, event, atSeq);
    case "assertion-recorded":
      if (isIdTaken(c, event.id)) return refuse("id-taken", "id");
      return { ok: true, case: { ...c, assertions: [...c.assertions, { kind: "assertion", id: event.id, status: "unverified", citable: false, statement: event.statement, retraction: null }] } };
    case "assertion-retracted":
      return assertionRetracted(c, event, atSeq);
    case "interpretation-recorded":
      return interpretationRecorded(c, event);
    case "interpretation-reaffirmed":
      return interpretationReaffirmed(c, event);
    case "unknown-recorded":
      if (isIdTaken(c, event.unknown.id)) return refuse("id-taken", "unknown.id");
      return { ok: true, case: { ...c, unknowns: [...c.unknowns, unknownFrom(event.unknown)] } };
    default:
      return refuse("unknown-claim", "type");
  }
}

/** One claim, the owner's, applied in memory. A refused claim leaves the case as it was. */
export function applyImportedClaim(c: ImportedCase, event: ImportedClaimEvent): ImportedClaimResult {
  const atSeq = c.claimSeq + 1;
  const result = applied(c, event, atSeq);
  return result.ok ? { ok: true, case: { ...result.case, claimSeq: atSeq } } : result;
}

/** Every attempt the seed's plan names, whatever became of it; nothing here checks the plan against the folder. None is waiting or running, since the run is over. */
export type ImportedDenominator = Readonly<{ planned: number; notStarted: number; usable: number; walled: number; failed: number; incomplete: number; timed_out: number; cancelled: number }>;

export function importedDenominatorOf(c: ImportedCase): ImportedDenominator {
  const count = (acquisition: Acquisition): number => c.attempts.filter((attempt) => attempt.acquisition === acquisition).length;
  return { planned: c.attempts.length, notStarted: 0, usable: count("usable"), walled: count("walled"), failed: count("failed"), incomplete: count("incomplete"), timed_out: 0, cancelled: 0 };
}

/** The scanner's source identity for one attempt. Never guessed: an attempt no identity covers reads not_recorded. */
export function importedSourceOf(c: ImportedCase, attempt: ImportedAttemptId): SourceReading {
  const { source } = c;
  if (source?.appliesTo.includes(attempt)) return { state: "reconstructed", baseCommit: source.baseCommit, patchDigest: source.patch.sha256, identity: source.identity };
  return { state: "not_recorded" };
}

/** One attempt's rows, each with its reading. Rows of several attempts are never handed back as one. */
export function importedEvidenceFor(c: ImportedCase, attempts: readonly string[]): Readonly<{ ok: true; rows: readonly (ImportedRow & Readonly<{ reading: RowReading }>)[] }> | Readonly<{ ok: false; refusal: "one-attempt-at-a-time" | "no-such-attempt" }> {
  if (attempts.length !== 1) return { ok: false, refusal: "one-attempt-at-a-time" };
  const [id] = attempts;
  if (!c.attempts.some((attempt) => attempt.id === id)) return { ok: false, refusal: "no-such-attempt" };
  return { ok: true, rows: c.rows.filter((row) => row.attempt === id).map((row) => ({ ...row, reading: readImportedRow(c, row) })) };
}

/** What the owner's seed says, as the import takes it. The seed is data: it names nothing here, and stays wherever the owner keeps it. */
export type ImportSeed = Readonly<{
  question: string;
  provenanceGaps: readonly string[];
  deviations: readonly Readonly<{ id: string; summary: string }>[];
  independentReproduction: Readonly<{ state: string; note: string }>;
  facts: readonly Readonly<{ id: string; statement: string; evidence: readonly string[] }>[];
  assertions: readonly Readonly<{ id: string; statement: string }>[];
  interpretations: readonly Readonly<{ id: string; statement: string; cites: readonly Cite[] }>[];
  unknowns: readonly UnknownInput[];
}>;

/** What an adapter hands over: the run as read, and nothing a seed asserts. Only the import's own reading makes one into a case. */
export type AdaptedRun = Readonly<{
  adapter: AdapterIdentity;
  recorderBasis: "attested" | "declared";
  recorderStatement: string;
  objects: readonly ImportedObject[];
  attempts: readonly ImportedAttempt[];
  rows: readonly ImportedRow[];
  source: ImportedSource | null;
  control: ImportedControl | null;
}>;

/** What the import takes: the plan the seed gives for the run, the run folder's bytes as the local reader returned them, the seed's claims, and the structured question. */
export type ImportInput = Readonly<{ plan: CapturePlan; files: Files; seed: ImportSeed; question: Question }>;

export type ImportRefusal = "input-malformed" | "question-malformed" | "survey-malformed" | "does-not-support-import" | "seed-malformed" | ImportedClaimRefusal | "unknown-claim";

export type ImportResult = Readonly<{ ok: true; case: ImportedCase }> | Readonly<{ ok: false; refusal: ImportRefusal; at: string | null; assessment?: Assessment }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && own.every((key) => keys.includes(key));
}

const INPUT_KEYS = ["plan", "files", "seed", "question"];
const SEED_KEYS = ["question", "provenanceGaps", "deviations", "independentReproduction", "facts", "assertions", "interpretations", "unknowns"];

const isId = (value: unknown): value is string => typeof value === "string" && value !== "";
const isNullableText = (value: unknown): boolean => value === null || typeof value === "string";

/** The bytes handed over: a map from a path inside the run folder to its bytes, or null for a path asked for and not there. */
function filesProblem(files: unknown): string | null {
  if (!(files instanceof Map)) return "files";
  for (const [path, bytes] of files) {
    if (typeof path !== "string" || !path.isWellFormed() || !isInsidePath(path)) return "files: a path";
    if (bytes !== null && !(bytes instanceof Uint8Array)) return "files: the bytes of a path";
  }
  return null;
}

/**
 * The map held to exactly the paths the adapter asks for when fed this map's own bytes, round by round
 * to its fixpoint. A key outside them is a path the adapter never asked for, refused by its place in
 * the map; a path it asks for that is not a key was never read, refused by its place in the list of
 * paths asked for. A path the reader found missing is a key with null. Neither refusal names a path by
 * its text, so no name a caller gave it reaches the case.
 */
function mapProblem(plan: CapturePlan, files: Files): string | null {
  const asked = new Map<string, Uint8Array | null>();
  for (let round = 0; round < 64; round += 1) {
    const wanted = capturePathsNeeded(plan, asked);
    if (wanted.length === 0) break;
    for (const path of wanted) asked.set(path, files.get(path) ?? null);
  }
  const unasked = [...files.keys()].findIndex((path) => !asked.has(path));
  if (unasked !== -1) return `files[${unasked}]: a path the adapter did not ask for`;
  const unread = [...asked.keys()].findIndex((path) => !files.has(path));
  return unread === -1 ? null : `asked[${unread}]: a path the adapter asked for that the map does not hold`;
}

/** The seed's own shape, item by item, with exactly the fields ImportSeed names. */
function seedProblem(seed: ImportSeed): string | null {
  if (!isRecord(seed) || !hasKeys(seed, SEED_KEYS) || typeof seed.question !== "string" || !Array.isArray(seed.facts) || !Array.isArray(seed.assertions) || !Array.isArray(seed.interpretations) || !Array.isArray(seed.unknowns)) return "seed";
  if (!Array.isArray(seed.provenanceGaps) || !seed.provenanceGaps.every((gap) => typeof gap === "string")) return "provenanceGaps";
  if (!Array.isArray(seed.deviations) || !seed.deviations.every((deviation) => isRecord(deviation) && hasKeys(deviation, ["id", "summary"]) && typeof deviation.id === "string" && typeof deviation.summary === "string")) return "deviations";
  const reproduction = seed.independentReproduction;
  if (!isRecord(reproduction) || !hasKeys(reproduction, ["state", "note"]) || typeof reproduction.state !== "string" || typeof reproduction.note !== "string") return "independentReproduction";
  for (const [index, fact] of seed.facts.entries()) {
    if (!isRecord(fact) || !hasKeys(fact, ["id", "statement", "evidence"]) || !isId(fact.id) || typeof fact.statement !== "string" || !Array.isArray(fact.evidence) || !fact.evidence.every(isId)) return `facts[${index}]`;
  }
  for (const [index, assertion] of seed.assertions.entries()) {
    if (!isRecord(assertion) || !hasKeys(assertion, ["id", "statement"]) || !isId(assertion.id) || typeof assertion.statement !== "string") return `assertions[${index}]`;
  }
  for (const [index, interpretation] of seed.interpretations.entries()) {
    if (!isRecord(interpretation) || !hasKeys(interpretation, ["id", "statement", "cites"]) || !isId(interpretation.id) || typeof interpretation.statement !== "string" || !Array.isArray(interpretation.cites)) return `interpretations[${index}]`;
    if (!interpretation.cites.every((cite) => isRecord(cite) && hasKeys(cite, ["fact", "version"]) && isId(cite.fact) && Number.isSafeInteger(cite.version) && (cite.version as number) >= 1)) return `interpretations[${index}].cites`;
  }
  for (const [index, unknown] of seed.unknowns.entries()) {
    if (!isRecord(unknown) || !hasKeys(unknown, ["id", "question", "reason", "detail", "wouldResolve"]) || !isId(unknown.id) || typeof unknown.question !== "string" || typeof unknown.reason !== "string" || !isNullableText(unknown.detail) || !isNullableText(unknown.wouldResolve)) return `unknowns[${index}]`;
  }
  return null;
}

/** The structured question as the case records it: its id, the sha256 of its text, and the sha256 of W2's canonical bytes of all of it. Null for a question with no text or no canonical form. */
async function questionDigests(question: unknown): Promise<Readonly<{ questionTextDigest: string; questionDigest: string }> | null> {
  if (!isRecord(question) || typeof question.text !== "string" || !question.text.isWellFormed()) return null;
  const whole = canonicalBytes(question);
  if (whole === null) return null;
  return { questionTextDigest: await sha256Hex(new TextEncoder().encode(question.text)), questionDigest: await sha256Hex(whole) };
}

/**
 * The case a recorded run makes. The import takes the plan the seed gives, a map from paths inside the
 * run folder to bytes (in the private run, the local reader's), the seed's claims and the structured
 * question, and makes everything else itself. The map must hold exactly the paths the adapter asks
 * for: a path it does not ask for, or one it asks for that is not a key, is refused, so the map holds
 * exactly what the adapter reads, and a path the reader found missing is a key with null. It reads the
 * run with the adapter, surveys that same reading, assesses the survey against the question, and goes
 * on only if the verdict supports importing it. No run, survey or assessment a caller built is taken,
 * so "assessed before import" holds by construction, and the case records the question, the verdict,
 * every finding and the run's digest. The seed's claims are then applied in order, facts first, each
 * through applyImportedClaim.
 *
 * Every input is held to its shape, in this order: the input's keys, the bytes, the seed and the
 * question's canonical form, before the run is read; then the plan, as the adapter reads it, and the
 * map against the paths it asks for; then the question's requirements, as it is assessed. The first
 * refusal refuses the import, naming the place that failed and never a value; nothing here throws on
 * a malformed input.
 *
 * Everything after the entry reads a clone, a copy made once, so no getter, proxy, detached buffer or
 * later edit of the caller's objects reaches the assessment or the case. The clone holds a second copy
 * of the bytes for as long as the import runs.
 */
export async function importCase(input: ImportInput): Promise<ImportResult> {
  let given: unknown;
  try {
    given = structuredClone(input);
  } catch {
    return { ok: false, refusal: "input-malformed", at: "input" };
  }
  if (!isRecord(given) || !hasKeys(given, INPUT_KEYS)) return { ok: false, refusal: "input-malformed", at: "input" };
  const { plan, files, seed, question } = given as ImportInput;
  const badFiles = filesProblem(files);
  if (badFiles !== null) return { ok: false, refusal: "input-malformed", at: badFiles };
  const badSeed = seedProblem(seed);
  if (badSeed !== null) return { ok: false, refusal: "seed-malformed", at: badSeed };
  const digests = await questionDigests(question);
  if (digests === null) return { ok: false, refusal: "question-malformed", at: "question" };
  const reading = await readCaptureRun(plan, files);
  // A plan the adapter refuses is a malformed input, named by its field, before anything is assessed.
  if (!reading.result.ok && reading.result.refusal === "plan-malformed") return { ok: false, refusal: "input-malformed", at: reading.result.at === "plan" ? "plan" : `plan: ${reading.result.at}` };
  const badMap = mapProblem(plan, files);
  if (badMap !== null) return { ok: false, refusal: "input-malformed", at: badMap };
  const assessed = assessSufficiency(question, reading.survey);
  if (!assessed.ok) return { ok: false, refusal: assessed.refusal, at: assessed.at };
  const { assessment } = assessed;
  if (assessment.verdict !== "supports-import" || !reading.result.ok) return { ok: false, refusal: "does-not-support-import", at: "assessment", assessment };
  const { run } = reading.result;
  let c: ImportedCase = {
    kind: "imported-case",
    historical: true,
    exploratory: true,
    adapter: run.adapter,
    recorderBasis: run.recorderBasis,
    recorderStatement: run.recorderStatement,
    runDigest: assessment.runDigest,
    assessment: { ...assessment, ...digests },
    question: seed.question,
    objects: run.objects,
    attempts: run.attempts,
    rows: run.rows,
    source: run.source,
    provenanceGaps: seed.provenanceGaps,
    control: run.control,
    deviations: seed.deviations,
    independentReproduction: seed.independentReproduction,
    facts: [],
    assertions: [],
    interpretations: [],
    unknowns: [],
    claimSeq: 0
  };
  // Each claim is named by its place in the seed, never by what it holds.
  const events: readonly (readonly [string, ImportedClaimEvent])[] = [
    ...seed.facts.map(({ id, statement, evidence }, index) => [`facts[${index}]`, { type: "fact-recorded", id, statement, evidence }] as const),
    ...seed.assertions.map(({ id, statement }, index) => [`assertions[${index}]`, { type: "assertion-recorded", id, statement }] as const),
    ...seed.interpretations.map(({ id, statement, cites }, index) => [`interpretations[${index}]`, { type: "interpretation-recorded", id, statement, cites }] as const),
    ...seed.unknowns.map((unknown, index) => [`unknowns[${index}]`, { type: "unknown-recorded", unknown }] as const)
  ];
  for (const [place, event] of events) {
    const result = applyImportedClaim(c, event);
    if (!result.ok) return { ok: false, refusal: result.refusal, at: result.at === null ? place : `${place}.${result.at}` };
    c = result.case;
  }
  return { ok: true, case: c };
}
