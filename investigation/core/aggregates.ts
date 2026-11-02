// Counts across attempts, each with its denominator and its declared keys. An aggregate
// is never one execution, and it says so. Evidence itself is shown one attempt at a time.
//
// A measure is data, not a function per case. It names the subject it counts and declares
// every key it pools over: held equal, allowed to vary with a reason, or unknown. A key on
// a row that the measure does not declare is refused, so nothing is pooled over silently.
// Release, commit and configuration must be held equal, so a change to any of them splits a
// group. So does what a visit rested on, whatever a measure declares: an exception's visit
// never pools with any other, so an exploratory visit never reads as a controlled one.
//
// The denominator is every attempt in the group, whatever became of it. A slot that never
// started and an attempt that failed stay counted, and read unknown, never as a 0. The
// only way out is the measure's population, which reads the arm, fixed at planning, and
// cannot read an outcome. A slot no visit reached rested on nothing, control or exception,
// even if an exception was recorded for it. Its row says not_visited, and it sits with the
// ordinary attempts under its configuration so that a denominator keeps it: the group's label is
// ordinary, meaning a visit on the met control or a slot that never visited, and its notStarted
// says how many are which.
//
// A count says how many attempts read each way, and n, zero and unknown partition the
// denominator. What limited those readings stays beside them, counted per reading, so a 0 from a
// walled attempt and a late positive do not read as the plain thing. A refusal names a role and a
// position in what it was handed, and never one of the strings it holds.

import type { Arm, AttemptPhase, MachineState, SlotName, VisitBasis } from "./case-machine";
import { readRow, UNREAD_STATES, type EvidenceRecord, type EvidenceRow, type RowReading } from "./evidence-model";
import { COMPLETENESS_LIMITS } from "./readings";

/** The three keys every measure must hold equal. */
export const SPLIT_KEYS = ["release", "commit", "configuration"] as const;

export type AttemptBasis = VisitBasis | "not_visited";

export type ReadingName = "observed" | "zero_in_window" | "unknown";

/** What an attempt's evidence reads as for one subject, and every limit the rows behind that reading carried. */
export type AttemptReading = Readonly<{ reading: ReadingName; limits: readonly string[] }>;

export type AggregateRow = Readonly<{
  slot: SlotName;
  attemptId: string;
  arm: Arm;
  phase: AttemptPhase;
  /** What the visit rested on, or that there was none. Always read by a group, so it is no key a measure can leave out. */
  basis: AttemptBasis;
  keys: Readonly<Record<string, string | null>>;
  /** What this attempt's evidence reads as, by subject. A subject not here reads unknown. */
  readings: Readonly<Record<string, AttemptReading>>;
}>;

export type MeasureKeys = Readonly<{
  heldEqual: readonly string[];
  allowedToVary: readonly Readonly<{ key: string; reason: string }>[];
  unknown: readonly string[];
}>;

export type Measure = Readonly<{
  id: string;
  subject: string;
  /** Limits who the measure is about, by arm alone. Null means every attempt. */
  population: Readonly<{ arm: Arm; whyOutside: string }> | null;
  keys: MeasureKeys | null;
}>;

export type AggregateGroup = Readonly<{
  measure: string;
  subject: string;
  group: Readonly<Record<string, string | null>>;
  /** Attempts whose evidence reads observed. */
  n: number;
  /** Every attempt in the group: n, plus zero, plus unknown. */
  of: number;
  zero: number;
  unknown: number;
  /** Of the attempts reading each way, how many carried each limit. An attempt can count under several. */
  limits: Readonly<Record<ReadingName, Readonly<Record<string, number>>>>;
  notStarted: number;
  failed: number;
  /** Attempts in the group's keys that the population left out, and why. */
  outsideDenominator: number;
  whyOutside: string | null;
  presentedAs: "aggregate across attempts, not one execution";
  compatibility: MeasureKeys;
}>;

export type AggregateRefusal = "no-declared-keys" | "split-key-not-held" | "undeclared-key" | "declared-key-missing" | "held-key-unknown" | "unknown-key-has-value" | "empty-reason" | "basis-unknown" | "reading-malformed";

export type AggregateResult = Readonly<{ ok: true; groups: readonly AggregateGroup[] }> | Readonly<{ ok: false; refusal: AggregateRefusal; at: string | null }>;

function refuse(refusal: AggregateRefusal, at: string | null = null): AggregateResult {
  return { ok: false, refusal, at };
}

function declaredKeys(keys: MeasureKeys): readonly string[] {
  return [...keys.heldEqual, ...keys.allowedToVary.map(({ key }) => key), ...keys.unknown];
}

/** Own keys only, so a name every object answers to, such as constructor, is no key and no subject. */
function ownValue<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

function isBlank(text: string): boolean {
  return text.trim() === "";
}

/** Every limit a reading can carry: what withheld complete, or the state of a row with nothing to read. */
const LIMIT_NAMES: readonly unknown[] = [...COMPLETENESS_LIMITS, ...UNREAD_STATES];

function isAttemptReading(value: unknown): value is AttemptReading {
  const { reading, limits } = (value ?? {}) as Record<string, unknown>;
  return (reading === "observed" || reading === "zero_in_window" || reading === "unknown") && Array.isArray(limits) && limits.every((limit) => LIMIT_NAMES.includes(limit));
}

/** How many of these attempts carried each limit, in a stable order. */
function limitCounts(attempts: readonly AttemptReading[]): Readonly<Record<string, number>> {
  const counts = new Map<string, number>();
  for (const { limits } of attempts) {
    for (const limit of new Set(limits)) counts.set(limit, (counts.get(limit) ?? 0) + 1);
  }
  return Object.fromEntries([...counts].sort(([left], [right]) => (left < right ? -1 : 1)));
}

/** Groups by what is held equal, in a stable order, each with its count. */
export function aggregate(rows: readonly AggregateRow[], measure: Measure): AggregateResult {
  const { keys, population } = measure;
  if (keys === null || keys.heldEqual.length === 0) return refuse("no-declared-keys", "measure.keys");
  for (const key of SPLIT_KEYS) {
    if (!keys.heldEqual.includes(key)) return refuse("split-key-not-held", key);
  }
  for (const [index, { reason }] of keys.allowedToVary.entries()) {
    if (isBlank(reason)) return refuse("empty-reason", `allowedToVary[${index}]`);
  }
  if (population !== null && isBlank(population.whyOutside)) return refuse("empty-reason", "population.whyOutside");
  const declared = declaredKeys(keys);
  for (const [at, row] of rows.entries()) {
    if (row.basis !== "control" && row.basis !== "exception" && row.basis !== "not_visited") return refuse("basis-unknown", `rows[${at}].basis`);
    const held = ownValue(row.readings, measure.subject);
    if (held !== undefined && !isAttemptReading(held)) return refuse("reading-malformed", `rows[${at}].readings`);
    for (const key of Object.keys(row.keys)) {
      if (!declared.includes(key)) return refuse("undeclared-key", `rows[${at}].keys`);
    }
    for (const [index, key] of keys.heldEqual.entries()) {
      const value = ownValue(row.keys, key);
      if (value === undefined) return refuse("declared-key-missing", `rows[${at}] heldEqual[${index}]`);
      if (value === null) return refuse("held-key-unknown", `rows[${at}] heldEqual[${index}]`);
    }
    for (const [index, { key }] of keys.allowedToVary.entries()) {
      if (ownValue(row.keys, key) === undefined) return refuse("declared-key-missing", `rows[${at}] allowedToVary[${index}]`);
    }
    for (const [index, key] of keys.unknown.entries()) {
      const value = ownValue(row.keys, key);
      if (value !== undefined && value !== null) return refuse("unknown-key-has-value", `rows[${at}] unknown[${index}]`);
    }
  }

  const buckets = new Map<string, { group: Readonly<Record<string, string | null>>; members: AggregateRow[] }>();
  for (const row of rows) {
    // The visit's basis last, so that a key a measure happens to call basis cannot stand in for it.
    const label = row.basis === "exception" ? "exception" : "ordinary";
    const group = Object.fromEntries([...[...keys.heldEqual].sort().map((key) => [key, ownValue(row.keys, key) as string] as const), ["basis", label] as const]) as Record<string, string | null>;
    const name = JSON.stringify(group);
    const bucket = buckets.get(name) ?? { group, members: [] };
    bucket.members.push(row);
    buckets.set(name, bucket);
  }

  const groups = [...buckets.keys()].sort().map((name) => {
    const { group, members } = buckets.get(name) as { group: Readonly<Record<string, string | null>>; members: AggregateRow[] };
    const inside = population === null ? members : members.filter(({ arm }) => arm === population.arm);
    const held = inside.map((row): AttemptReading => ownValue(row.readings, measure.subject) ?? { reading: "unknown", limits: [] });
    const reading = (which: ReadingName) => held.filter((attempt) => attempt.reading === which);
    return {
      measure: measure.id,
      subject: measure.subject,
      group,
      n: reading("observed").length,
      of: inside.length,
      zero: reading("zero_in_window").length,
      unknown: reading("unknown").length,
      limits: { observed: limitCounts(reading("observed")), zero_in_window: limitCounts(reading("zero_in_window")), unknown: limitCounts(reading("unknown")) },
      notStarted: inside.filter(({ phase }) => phase === "planned" || phase === "not_started").length,
      failed: inside.filter(({ phase }) => phase === "failed").length,
      outsideDenominator: members.length - inside.length,
      whyOutside: population === null ? null : population.whyOutside,
      presentedAs: "aggregate across attempts, not one execution" as const,
      compatibility: keys
    };
  });
  return { ok: true, groups };
}

/** The limits a row's reading carried. One read as unknown for its own state has that state as its limit. The viewer shows a reading's limits through this, so a page and a count agree. */
export function limitsOfReading(reading: RowReading): readonly string[] {
  if ("limits" in reading) return reading.limits;
  return "reason" in reading ? [reading.reason] : [];
}

function limitsOfAll(readings: readonly RowReading[]): readonly string[] {
  return [...new Set(readings.flatMap(limitsOfReading))].sort();
}

/**
 * What several rows on one subject read as, for one attempt. Observed if any row saw it,
 * since a positive stays, with the limits of the rows that saw it. 0 only when every row says
 * 0, since one that could not say leaves the attempt unknown, and then every row's limits stand.
 */
function combined(readings: readonly RowReading[]): AttemptReading {
  const saw = readings.filter(({ reading }) => reading === "observed");
  if (saw.length > 0) return { reading: "observed", limits: limitsOfAll(saw) };
  // Nothing calls this with no rows today. If something did, no rows must not read as a 0.
  const reading = readings.length > 0 && readings.every((row) => row.reading === "zero_in_window") ? "zero_in_window" : "unknown";
  return { reading, limits: limitsOfAll(readings) };
}

/** Null when a configuration's identity is not known, which an aggregate then refuses to hold equal. */
export type ConfigurationKeys = Readonly<{ release: string | null; commit: string | null }>;

/**
 * One row per planned slot, whatever became of it, read from the machine and the record.
 * `keysOf` maps a configuration to its release and commit, so a slot that never ran still
 * sits in the group its configuration names. A slot still waiting uses the one in force.
 */
export function aggregateRowsOf(machine: MachineState, record: EvidenceRecord, keysOf: (configuration: string) => ConfigurationKeys): readonly AggregateRow[] {
  return machine.attempts.map((attempt) => {
    const configuration = attempt.configuration ?? machine.configuration;
    const { release, commit } = keysOf(configuration);
    const bySubject = new Map<string, RowReading[]>();
    for (const row of record.rows) {
      if (row.slot !== attempt.slot || row.observation === null) continue;
      bySubject.set(row.observation.subject, [...(bySubject.get(row.observation.subject) ?? []), readRow(record, machine, row)]);
    }
    const readings = Object.fromEntries([...bySubject].map(([subject, list]) => [subject, combined(list)] as const));
    const visit = record.visitBases.find(({ slot }) => slot === attempt.slot);
    const basis: AttemptBasis = visit === undefined ? "not_visited" : visit.basis;
    return { slot: attempt.slot, attemptId: attempt.attemptId, arm: attempt.arm, phase: attempt.phase, basis, keys: { release, commit, configuration, arm: attempt.arm }, readings };
  });
}

export type AttemptEvidence = Readonly<{ ok: true; rows: readonly (EvidenceRow & Readonly<{ reading: RowReading }>)[] }> | Readonly<{ ok: false; refusal: "one-attempt-at-a-time" | "no-such-attempt" }>;

/** One execution's evidence, each row with its reading, so a bare count of 0 never leaves without what limits it. Rows of several attempts are never handed back as one, which is what a count is for. */
export function evidenceForAttempt(machine: MachineState, record: EvidenceRecord, slots: readonly SlotName[]): AttemptEvidence {
  if (slots.length !== 1) return { ok: false, refusal: "one-attempt-at-a-time" };
  const [slot] = slots;
  if (!machine.attempts.some((attempt) => attempt.slot === slot)) return { ok: false, refusal: "no-such-attempt" };
  return { ok: true, rows: record.rows.filter((row) => row.slot === slot).map((row) => ({ ...row, reading: readRow(record, machine, row) })) };
}
