// What a case says, kept apart by kind: facts rest on evidence rows, assertions are what
// someone said and nothing checked, interpretations cite fact versions, and unknowns
// are questions with reasons. Each kind has its own type and its own events. No function
// takes one kind and gives back another, and an id belongs to one kind for good, so
// nothing can become something else. Retracting an assertion keeps the assertion, and adds
// a new unknown beside it. That is not a conversion, and the two stay separate records.
//
// Evidence never changes here. A supersede or a retract writes history and flags what cited
// the fact, and every row stays as it was. A flag persists until the owner reaffirms the
// interpretation against current versions of exactly the facts it cites, and a later change
// flags it again. One resting on a retracted fact can never be reaffirmed: it stays flagged,
// and the owner writes a new one. Rows and claims share one namespace of ids, so a fact
// citing an id that is not a row stays refused whatever is named later.
//
// There is no approve event, no public claim, and no export, by the owner's ruling.
// Reaffirming is interpretation review and nothing more: it publishes nothing and approves
// nothing, and no function in this folder produces text for anyone but the owner. One
// stated limit carries over from M1: nothing checks new wording against its evidence rows.
//
// A row is not a claim. One whose state is not present reads as unknown with that state
// as its reason, and it cannot become a fact by any path. The one exception is a late row that
// holds bytes and a count above 0: a positive stays observed, with late as a limit a reader can
// see, and complete withheld. A late 0 says nothing.
//
// A refusal names a field or a kind, never a value it was handed.

import type { AttemptPhase, MachineActor, MachineState, SlotName } from "./case-machine";
import { isOutcome, isRunningPhase } from "./case-machine";
import type { Completeness, Granularity, ObservationInput, ObservationReading, Scope, WindowEnd } from "./readings";
import { readObservation } from "./readings";

/** The states of a row that holds nothing to read, each of which a reader sees as the reason. */
export const UNREAD_STATES = ["no_record", "before_window", "out_of_scope", "truncated", "not_read", "late"] as const;
export type RowState = "present" | (typeof UNREAD_STATES)[number];
/** The states a runner may report. Late is what the record makes of a row that arrives after its attempt ended. */
export type ReportedRowState = Exclude<RowState, "late">;

/** Every row states its clock, or null with a note saying why it has none. */
export type RowWindow = Readonly<{ clock: string; startMs: number; endMs: number }> | Readonly<{ clock: null; note: string }>;

export type RowObservation = Readonly<{
  /** An opaque name for what was counted. It is never a URL or text from a capture. */
  subject: string;
  count: number | null;
  granularity: Granularity;
  windowEnd: WindowEnd;
  scope: Scope;
}>;

export type EvidenceRow = Readonly<{
  id: string;
  slot: SlotName;
  instrument: string;
  state: RowState;
  window: RowWindow;
  limits: readonly string[];
  /** The evidence object holding its raw bytes. Only a present row has one. */
  digest: string | null;
  observation: RowObservation | null;
}>;

export type InstrumentRecord = Readonly<{ slot: SlotName; instrument: string; completeness: Exclude<Completeness, "not_recorded">; reason: string | null }>;

/** A fact's link to one row: the row's id, and the instrument, window and limits that row was captured under, with what limited its reading when the fact was recorded. */
export type FactLink = Readonly<{ evidence: string; slot: SlotName; instrument: string; window: RowWindow; limits: readonly string[] }>;

export type FactHistory = Readonly<{ version: number; statement: string; reason: string; atSeq: number }>;

export type Fact = Readonly<{
  kind: "fact";
  id: string;
  version: number;
  status: "current" | "retracted";
  statement: string;
  links: readonly FactLink[];
  history: readonly FactHistory[];
  retraction: Readonly<{ reason: string; atSeq: number; replacedByUnknown: string | null }> | null;
}>;

export type Assertion = Readonly<{
  kind: "assertion";
  id: string;
  status: "unverified" | "retracted";
  /** Always false: the type says so, and the citation check refuses the kind whatever this holds. */
  citable: false;
  statement: string;
  retraction: Readonly<{ reason: string; atSeq: number; replacedByUnknown: string }> | null;
}>;

export type Cite = Readonly<{ fact: string; version: number }>;
export type InterpretationFlag = Readonly<{ fact: string; fromVersion: number; change: "superseded" | "retracted"; atSeq: number }>;

export type Interpretation = Readonly<{
  kind: "interpretation";
  id: string;
  statement: string;
  /** Stays at what it last bound to until the owner reaffirms, so a flag names what it was read against. */
  cites: readonly Cite[];
  review: "current" | "needs_review";
  flags: readonly InterpretationFlag[];
  reaffirmations: number;
}>;

export type Unknown = Readonly<{
  kind: "unknown";
  id: string;
  question: string;
  reason: string;
  detail: string | null;
  wouldResolve: string | null;
}>;

export type UnknownInput = Omit<Unknown, "kind">;

export type ReconstructedSource = Readonly<{
  appliesTo: readonly SlotName[];
  baseCommit: string;
  patchDigest: string;
  identity: string;
}>;

export type RecordedSource = Readonly<{ slot: SlotName; commit: string; identity: string }>;

/** A slot's source identity, as far as anything showed. not_recorded holds no identity, because none is known. */
export type SourceReading =
  | Readonly<{ state: "not_recorded" }>
  | Readonly<{ state: "reconstructed"; baseCommit: string; patchDigest: string; identity: string }>
  | Readonly<{ state: "recorded"; commit: string; identity: string }>;

export type EvidenceRecord = Readonly<{
  rows: readonly EvidenceRow[];
  instruments: readonly InstrumentRecord[];
  /** Why an attempt ended as it did, in the runner's closed vocabulary. */
  acquisitionReasons: readonly Readonly<{ slot: SlotName; reason: string }>[];
  /** What each visit rested on when it began, read from the machine before the step. */
  visitBases: readonly Readonly<{ slot: SlotName; basis: "control" | "exception" }>[];
  reconstructedSource: ReconstructedSource | null;
  recordedSources: readonly RecordedSource[];
  facts: readonly Fact[];
  assertions: readonly Assertion[];
  interpretations: readonly Interpretation[];
  unknowns: readonly Unknown[];
}>;

export const EMPTY_RECORD: EvidenceRecord = {
  rows: [],
  instruments: [],
  acquisitionReasons: [],
  visitBases: [],
  reconstructedSource: null,
  recordedSources: [],
  facts: [],
  assertions: [],
  interpretations: [],
  unknowns: []
};

export type RecordEvent =
  | Readonly<{ type: "instrument-recorded"; slot: SlotName; instrument: string; completeness: InstrumentRecord["completeness"]; reason: string | null }>
  | Readonly<{ type: "source-reconstructed"; appliesTo: readonly SlotName[]; baseCommit: string; patchDigest: string; identity: string }>
  | Readonly<{ type: "source-recorded"; slot: SlotName; commit: string; identity: string }>
  | Readonly<{ type: "fact-recorded"; id: string; statement: string; evidence: readonly string[] }>
  | Readonly<{ type: "fact-superseded"; fact: string; statement: string; reason: string }>
  | Readonly<{ type: "fact-retracted"; fact: string; reason: string; unknown: UnknownInput | null }>
  | Readonly<{ type: "assertion-recorded"; id: string; statement: string }>
  | Readonly<{ type: "assertion-retracted"; assertion: string; reason: string; unknown: UnknownInput }>
  | Readonly<{ type: "interpretation-recorded"; id: string; statement: string; cites: readonly Cite[] }>
  | Readonly<{ type: "interpretation-reaffirmed"; interpretation: string; cites: readonly Cite[] }>
  | Readonly<{ type: "unknown-recorded"; unknown: UnknownInput }>;

export type RecordRefusal =
  | "owner-only"
  | "not-this-attempt"
  | "no-such-slot"
  | "attempt-not-begun"
  | "id-taken"
  | "fact-needs-evidence"
  | "no-such-row"
  | "row-not-present"
  | "row-from-missing-instrument"
  | "instrument-missing-has-row"
  | "instrument-already-recorded"
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
  | "source-already-reconstructed"
  | "source-needs-slots"
  | "source-slot-recorded"
  | "source-attempt-not-ended"
  | "source-already-recorded"
  | "source-after-attempt"
  | "instrument-after-attempt";

export type RecordResult = Readonly<{ ok: true; record: EvidenceRecord }> | Readonly<{ ok: false; refusal: RecordRefusal; at: string | null }>;

function refuse(refusal: RecordRefusal, at: string | null = null): RecordResult {
  return { ok: false, refusal, at };
}

function accept(record: EvidenceRecord): RecordResult {
  return { ok: true, record };
}

type AnyClaim = Fact | Assertion | Interpretation | Unknown;

/** One namespace across rows and every kind of claim. */
function isIdTaken(record: EvidenceRecord, id: string): boolean {
  return claimWithId(record, id) !== null || record.rows.some((row) => row.id === id);
}

function claimWithId(record: EvidenceRecord, id: string): AnyClaim | null {
  return record.facts.find((fact) => fact.id === id) ?? record.assertions.find((assertion) => assertion.id === id) ?? record.interpretations.find((interpretation) => interpretation.id === id) ?? record.unknowns.find((unknown) => unknown.id === id) ?? null;
}

function unknownFrom(input: UnknownInput): Unknown {
  return { kind: "unknown", id: input.id, question: input.question, reason: input.reason, detail: input.detail, wouldResolve: input.wouldResolve };
}

/** A cite stands only on a current fact at its current version. Every other kind is refused by name. */
function citeRefusal(record: EvidenceRecord, cite: Cite): RecordResult | null {
  const claim = claimWithId(record, cite.fact);
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

/** Everything citing this fact is flagged, and nothing else. The cites stay as they were, so the flag says what the reading rested on. */
function flagDependents(record: EvidenceRecord, factId: string, fromVersion: number, change: InterpretationFlag["change"], atSeq: number): EvidenceRecord {
  return {
    ...record,
    interpretations: record.interpretations.map((interpretation) =>
      interpretation.cites.some(({ fact }) => fact === factId)
        ? { ...interpretation, review: "needs_review", flags: [...interpretation.flags, { fact: factId, fromVersion, change, atSeq }] }
        : interpretation
    )
  };
}

function findFact(record: EvidenceRecord, id: string): Fact | RecordResult {
  const claim = claimWithId(record, id);
  if (claim === null) return refuse("no-such-claim", "fact");
  if (claim.kind !== "fact") return refuse("not-a-fact", "fact");
  return claim;
}

function isRefused(value: Fact | RecordResult): value is RecordResult {
  return "ok" in value;
}

function replaced(record: EvidenceRecord, fact: Fact): EvidenceRecord {
  return { ...record, facts: record.facts.map((existing) => (existing.id === fact.id ? fact : existing)) };
}

function factRecorded(record: EvidenceRecord, event: Extract<RecordEvent, { type: "fact-recorded" }>, machine: MachineState): RecordResult {
  if (isIdTaken(record, event.id)) return refuse("id-taken", "id");
  if (event.evidence.length === 0) return refuse("fact-needs-evidence", "evidence");
  const links: FactLink[] = [];
  for (const id of event.evidence) {
    const row = record.rows.find((candidate) => candidate.id === id);
    if (row === undefined) return refuse("no-such-row", "evidence");
    if (row.state !== "present" && !isLatePositive(row)) return refuse("row-not-present", "evidence");
    const reading = readRow(record, machine, row);
    links.push({ evidence: row.id, slot: row.slot, instrument: row.instrument, window: row.window, limits: "limits" in reading ? [...new Set([...row.limits, ...reading.limits])] : row.limits });
  }
  return accept({
    ...record,
    facts: [...record.facts, { kind: "fact", id: event.id, version: 1, status: "current", statement: event.statement, links, history: [], retraction: null }]
  });
}

function factSuperseded(record: EvidenceRecord, event: Extract<RecordEvent, { type: "fact-superseded" }>, atSeq: number): RecordResult {
  const fact = findFact(record, event.fact);
  if (isRefused(fact)) return fact;
  if (fact.status !== "current") return refuse("fact-not-current", "fact");
  if (fact.statement === event.statement) return refuse("same-wording", "statement");
  const next: Fact = {
    ...fact,
    version: fact.version + 1,
    statement: event.statement,
    history: [...fact.history, { version: fact.version, statement: fact.statement, reason: event.reason, atSeq }]
  };
  return accept(flagDependents(replaced(record, next), fact.id, fact.version, "superseded", atSeq));
}

function factRetracted(record: EvidenceRecord, event: Extract<RecordEvent, { type: "fact-retracted" }>, atSeq: number): RecordResult {
  const fact = findFact(record, event.fact);
  if (isRefused(fact)) return fact;
  if (fact.status !== "current") return refuse("fact-not-current", "fact");
  if (event.unknown !== null && isIdTaken(record, event.unknown.id)) return refuse("id-taken", "unknown.id");
  const next: Fact = {
    ...fact,
    status: "retracted",
    retraction: { reason: event.reason, atSeq, replacedByUnknown: event.unknown === null ? null : event.unknown.id }
  };
  const flagged = flagDependents(replaced(record, next), fact.id, fact.version, "retracted", atSeq);
  return accept(event.unknown === null ? flagged : { ...flagged, unknowns: [...flagged.unknowns, unknownFrom(event.unknown)] });
}

function assertionRetracted(record: EvidenceRecord, event: Extract<RecordEvent, { type: "assertion-retracted" }>, atSeq: number): RecordResult {
  const claim = claimWithId(record, event.assertion);
  if (claim === null) return refuse("no-such-claim", "assertion");
  if (claim.kind !== "assertion") return refuse("not-an-assertion", "assertion");
  if (claim.status === "retracted") return refuse("assertion-already-retracted", "assertion");
  if (isIdTaken(record, event.unknown.id)) return refuse("id-taken", "unknown.id");
  const retracted: Assertion = { ...claim, status: "retracted", retraction: { reason: event.reason, atSeq, replacedByUnknown: event.unknown.id } };
  return accept({
    ...record,
    assertions: record.assertions.map((existing) => (existing.id === claim.id ? retracted : existing)),
    unknowns: [...record.unknowns, unknownFrom(event.unknown)]
  });
}

function interpretationRecorded(record: EvidenceRecord, event: Extract<RecordEvent, { type: "interpretation-recorded" }>): RecordResult {
  if (isIdTaken(record, event.id)) return refuse("id-taken", "id");
  if (event.cites.length === 0) return refuse("interpretation-needs-cites", "cites");
  if (hasRepeatedCite(event.cites)) return refuse("cites-repeated", "cites");
  for (const cite of event.cites) {
    const refusal = citeRefusal(record, cite);
    if (refusal !== null) return refusal;
  }
  return accept({
    ...record,
    interpretations: [...record.interpretations, { kind: "interpretation", id: event.id, statement: event.statement, cites: event.cites, review: "current", flags: [], reaffirmations: 0 }]
  });
}

function interpretationReaffirmed(record: EvidenceRecord, event: Extract<RecordEvent, { type: "interpretation-reaffirmed" }>): RecordResult {
  const claim = claimWithId(record, event.interpretation);
  if (claim === null) return refuse("no-such-claim", "interpretation");
  if (claim.kind !== "interpretation") return refuse("not-an-interpretation", "interpretation");
  if (claim.review !== "needs_review") return refuse("not-flagged", "interpretation");
  if (event.cites.length === 0) return refuse("interpretation-needs-cites", "cites");
  if (hasRepeatedCite(event.cites)) return refuse("cites-repeated", "cites");
  // Exactly the facts it cites: a reaffirm cannot drop the fact that changed, or take on a new one.
  if (event.cites.length !== claim.cites.length || !event.cites.every(({ fact }) => claim.cites.some((cite) => cite.fact === fact))) return refuse("cites-not-its-facts", "cites");
  for (const cite of event.cites) {
    const refusal = citeRefusal(record, cite);
    if (refusal !== null) return refusal;
  }
  const reaffirmed: Interpretation = { ...claim, cites: event.cites, review: "current", flags: [], reaffirmations: claim.reaffirmations + 1 };
  return accept({ ...record, interpretations: record.interpretations.map((existing) => (existing.id === claim.id ? reaffirmed : existing)) });
}

function instrumentRecorded(record: EvidenceRecord, event: Extract<RecordEvent, { type: "instrument-recorded" }>): RecordResult {
  const already = record.instruments.some(({ slot, instrument }) => slot === event.slot && instrument === event.instrument);
  if (already) return refuse("instrument-already-recorded", "instrument");
  if (event.completeness === "missing" && record.rows.some((row) => row.slot === event.slot && row.instrument === event.instrument && row.state === "present")) {
    return refuse("instrument-missing-has-row", "instrument");
  }
  return accept({ ...record, instruments: [...record.instruments, { slot: event.slot, instrument: event.instrument, completeness: event.completeness, reason: event.reason }] });
}

function sourceReconstructed(record: EvidenceRecord, event: Extract<RecordEvent, { type: "source-reconstructed" }>): RecordResult {
  if (record.reconstructedSource !== null) return refuse("source-already-reconstructed");
  if (event.appliesTo.length === 0) return refuse("source-needs-slots", "appliesTo");
  if (event.appliesTo.some((slot) => record.recordedSources.some((source) => source.slot === slot))) return refuse("source-slot-recorded", "appliesTo");
  return accept({ ...record, reconstructedSource: { appliesTo: event.appliesTo, baseCommit: event.baseCommit, patchDigest: event.patchDigest, identity: event.identity } });
}

function sourceRecorded(record: EvidenceRecord, event: Extract<RecordEvent, { type: "source-recorded" }>): RecordResult {
  if (record.recordedSources.some(({ slot }) => slot === event.slot)) return refuse("source-already-recorded", "slot");
  return accept({ ...record, recordedSources: [...record.recordedSources, { slot: event.slot, commit: event.commit, identity: event.identity }] });
}

function attemptOf(machine: MachineState, slot: SlotName): MachineState["attempts"][number] | null {
  return machine.attempts.find((attempt) => attempt.slot === slot) ?? null;
}

function hasBegun(phase: AttemptPhase): boolean {
  return phase !== "planned" && phase !== "not_started";
}

/**
 * One record event. The machine is read, never changed: who may speak for a slot, and
 * whether it began. Claims are the owner's. What a capture recorded is its own runner's.
 */
export function applyRecordEvent(record: EvidenceRecord, event: RecordEvent, by: MachineActor, machine: MachineState, atSeq: number): RecordResult {
  if (event.type === "instrument-recorded" || event.type === "source-recorded") {
    const attempt = attemptOf(machine, event.slot);
    if (attempt === null) return refuse("no-such-slot", "slot");
    if (by.kind !== "system:runner" || by.attemptId !== attempt.attemptId) return refuse("not-this-attempt", "slot");
    if (!hasBegun(attempt.phase)) return refuse("attempt-not-begun", "slot");
    // Both are what a capture says of itself, as it runs. Afterward nothing can supply a missing
    // identity, or turn a reading complete by saying its coverage was.
    if (event.type === "instrument-recorded") return isRunningPhase(attempt.phase) ? instrumentRecorded(record, event) : refuse("instrument-after-attempt", "slot");
    return isRunningPhase(attempt.phase) ? sourceRecorded(record, event) : refuse("source-after-attempt", "slot");
  }
  if (by.kind !== "owner") return refuse("owner-only");
  switch (event.type) {
    case "source-reconstructed": {
      if (event.appliesTo.some((slot) => attemptOf(machine, slot) === null)) return refuse("no-such-slot", "appliesTo");
      // Only of a visit that happened and ended. Never ahead of one, and never of a slot that did not run.
      const ended = event.appliesTo.every((slot) => {
        const attempt = attemptOf(machine, slot);
        return attempt !== null && isOutcome(attempt.phase);
      });
      return ended ? sourceReconstructed(record, event) : refuse("source-attempt-not-ended", "appliesTo");
    }
    case "fact-recorded":
      return factRecorded(record, event, machine);
    case "fact-superseded":
      return factSuperseded(record, event, atSeq);
    case "fact-retracted":
      return factRetracted(record, event, atSeq);
    case "assertion-recorded":
      if (isIdTaken(record, event.id)) return refuse("id-taken", "id");
      return accept({ ...record, assertions: [...record.assertions, { kind: "assertion", id: event.id, status: "unverified", citable: false, statement: event.statement, retraction: null }] });
    case "assertion-retracted":
      return assertionRetracted(record, event, atSeq);
    case "interpretation-recorded":
      return interpretationRecorded(record, event);
    case "interpretation-reaffirmed":
      return interpretationReaffirmed(record, event);
    case "unknown-recorded":
      if (isIdTaken(record, event.unknown.id)) return refuse("id-taken", "unknown.id");
      return accept({ ...record, unknowns: [...record.unknowns, unknownFrom(event.unknown)] });
  }
}

/**
 * A row, as the record keeps it. One that arrives after its attempt ended is kept and
 * labeled late, whatever it claimed, and a present row from an instrument that said it
 * gave nothing is refused. The machine is asked first, and has already refused a
 * duplicate id or an attempt that never began. A claim's id is refused here, since rows and
 * claims share one namespace.
 */
export function addRow(record: EvidenceRecord, row: EvidenceRow, phaseBefore: AttemptPhase): RecordResult {
  if (isIdTaken(record, row.id)) return refuse("id-taken", "row.id");
  const missing = record.instruments.some(({ slot, instrument, completeness }) => slot === row.slot && instrument === row.instrument && completeness === "missing");
  if (missing && row.state === "present") return refuse("row-from-missing-instrument", "row.instrument");
  const kept: EvidenceRow = isOutcome(phaseBefore) ? { ...row, state: "late" } : row;
  return accept({ ...record, rows: [...record.rows, kept] });
}

/** Every evidence row reads as one of these. Only an observation row can say more than that it is there. */
export type RowReading = ObservationReading | Readonly<{ reading: "recorded" }> | Readonly<{ reading: "unknown"; reason: Exclude<RowState, "present">; complete: false }>;

/** A late row that held bytes and a count above 0: what it saw still happened, however late it said so. */
function isLatePositive(row: EvidenceRow): boolean {
  const count = row.observation === null ? null : row.observation.count;
  return row.state === "late" && row.digest !== null && count !== null && count > 0;
}

function operationOf(phase: AttemptPhase): ObservationInput["operation"] {
  if (phase === "walled") return "walled";
  if (phase === "incomplete") return "incomplete";
  return phase === "failed" || phase === "timed_out" || phase === "cancelled" ? "failed_retained" : "succeeded";
}

/**
 * A row as the reader sees it. A row not present is unknown with its own state as the reason, so
 * a no_record row can never read as a count. A late row reads what it counted only when that
 * is a positive, with late as a limit, and otherwise as unknown for being late.
 */
export function readRow(record: EvidenceRecord, machine: MachineState, row: EvidenceRow): RowReading {
  if (row.state !== "present" && !isLatePositive(row)) return { reading: "unknown", reason: row.state as Exclude<RowState, "present">, complete: false };
  if (row.observation === null) return { reading: "recorded" };
  const attempt = attemptOf(machine, row.slot);
  // A row of no attempt in this plan came from nowhere this case can explain.
  if (attempt === null) return { reading: "unknown", reason: "no_record", complete: false };
  const instrument = record.instruments.find(({ slot, instrument: name }) => slot === row.slot && name === row.instrument);
  const reading = readObservation({
    record: "present",
    count: row.observation.count,
    granularity: row.observation.granularity,
    windowEnd: row.observation.windowEnd,
    scope: row.observation.scope,
    completeness: instrument === undefined ? "not_recorded" : instrument.completeness,
    // A row of an attempt with no cleanup yet reads as what it is: nothing has been confirmed.
    cleanup: attempt.cleanup === null ? "pending" : attempt.cleanup,
    operation: operationOf(attempt.phase)
  });
  // The positive check above leaves only a count above 0 here, so a late row reads observed.
  return row.state === "late" && reading.reading === "observed" ? { ...reading, complete: false, limits: [...reading.limits, "late"] } : reading;
}

/** Never guessed. A slot no identity covers reads not_recorded, however many of its neighbors have one. */
export function sourceIdentityOf(record: EvidenceRecord, slot: SlotName): SourceReading {
  const recorded = record.recordedSources.find((source) => source.slot === slot);
  if (recorded !== undefined) return { state: "recorded", commit: recorded.commit, identity: recorded.identity };
  const block = record.reconstructedSource;
  if (block?.appliesTo.includes(slot)) return { state: "reconstructed", baseCommit: block.baseCommit, patchDigest: block.patchDigest, identity: block.identity };
  return { state: "not_recorded" };
}
