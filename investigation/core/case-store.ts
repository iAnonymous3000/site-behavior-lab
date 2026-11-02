// A case on its log. One log entry per command and one event per entry, and the state is
// rebuilt by folding the machine and the record over what the log holds. Nothing else is
// stored, so reopening and continuing are one code path, and a kill at any moment leaves
// exactly what the log explains: either the command's entry is reached from the head and
// it happened, or it is not and it did not. The log's own note says why that holds.
//
// A fold refuses a logged event it cannot apply, and never skips one. A skipped event would
// give a state the log does not explain, so a log this cannot fold opens as a refusal.
//
// Who acted is read from the entry's actor, and only that. A command takes an actor derived
// in this isolate, and its data has no field a name could be written to, since decoding
// refuses any key it does not expect. Nothing here decides how a Durable Object gets an
// actor: a later batch does, and the current default is that it verifies the token itself,
// which calls this with what that gives it.
//
// A command is checked against the case its caller holds, and the head does not bind that state:
// an old state or an edited one, sent with the right head, would write an entry no later fold
// could apply, and the log would never open again. So a case is deep-frozen and registered with
// the stores it came from, by the three functions here that make one, and a command takes only
// that object on those stores. One case's object on another store's log would write an entry that
// log could not open as its own. Like derivedActors in actor.ts this is membership in one
// isolate, so it cannot cross an RPC boundary: a Durable Object folds its own case from its own
// log, and a batch that rebuilds its stores per request reopens with them.
//
// What a case rests on and what a capture recorded can be the same bytes: a controlled fixture
// run's capture is byte for byte its fixture. So a row may name any object. Only the owner's events
// keep: a frozen plan, the fixture and criterion of the planned or a changed configuration, and a
// patch. A control is the control run's, a runner, and keeps nothing. The purge set is the digests
// rows name, and the digests a control names, minus what the owner keeps, so every object the log
// names is either kept or listed. A manifest must equal that set, so it can never list what the case
// rests on. A digest a row names is kept or raw by the order it entered the case: an event that
// would start keeping one a row already names as raw bytes is refused, unless the case keeps it
// already. Once a manifest exists, every path it lists is raw the same way, whoever named it. So
// nothing moves a row's raw digest out of the purge set, before a manifest or after, nothing moves a
// listed path, and an owner cannot adopt a capture already in this case as a fixture by the same
// bytes. What only a control named the owner may still keep before a manifest, as when the plan's
// one change adopts the identity a control missed under.

import { isDerivedActor, type Actor } from "./actor";
import { canonicalBytes, parseCanonical } from "./canonical-json";
import { appendCommand, checkFirstEntry, createLog, GENESIS_HEAD, isCaseId, openLog, type AppendRefusal, type EvidenceSeen, type LogEntry, type LogEvent, type LogStores, type OpenRefusal } from "./case-log";
import { configurationKey, decodeEvent, digestsNamed, type CaseEvent, type ConfigurationIdentity, type PlannedSlots } from "./case-events";
import { plannedState, SLOT_NAMES, step, visitBasisOf, type AttemptState, type MachineActor, type MachineEvent, type MachineRefusal, type MachineState, type SlotName } from "./case-machine";
import { addRow, applyRecordEvent, EMPTY_RECORD, type EvidenceRecord, type RecordEvent, type RecordRefusal } from "./evidence-model";
import { aggregateRowsOf, type AggregateRow } from "./aggregates";
import { mintAttemptId } from "./ids";

export type CaseState = Readonly<{
  machine: MachineState;
  record: EvidenceRecord;
  /** Every configuration the case has named, oldest first. */
  configurations: readonly ConfigurationIdentity[];
  /** Every object the case rests on: plans, fixtures, criteria, patches. A row may name one too, and a purge leaves it. */
  keptObjects: readonly string[];
  /** Every object a control named, each once. A purge lists it unless the owner keeps it. */
  controlObjects: readonly string[];
}>;

/** A case as a reader holds it. The state is null for a log that exists and holds no plan yet. */
export type OpenCase = Readonly<{ caseId: string; head: string; seq: number; state: CaseState | null }>;

type FoldRefusal = "not-planned" | "already-planned" | "not-one-command" | "evidence-not-named" | "unknown-event-type" | "malformed-event" | "manifest-not-the-evidence" | "manifest-empty-after-a-visit" | "evidence-after-manifest" | "raw-object-cannot-be-kept" | MachineRefusal | RecordRefusal;

export type OpenCaseResult = Readonly<{ ok: true; case: OpenCase }> | Readonly<{ ok: false; refusal: OpenRefusal | FoldRefusal; at: string | null }>;

export type CommandRefusal = "malformed-command" | "not-an-actor" | "not-a-folded-case" | "malformed-plan" | "log-exists" | AppendRefusal | FoldRefusal;

export type CommandResult = Readonly<{ ok: true; case: OpenCase; digest: string }> | Readonly<{ ok: false; refusal: CommandRefusal; at: string | null }>;

type ApplyResult = Readonly<{ ok: true; state: CaseState }> | Readonly<{ ok: false; refusal: FoldRefusal; at: string | null }>;

function refused(refusal: FoldRefusal, at: string | null = null): ApplyResult {
  return { ok: false, refusal, at };
}

const foldedCases = new WeakMap<OpenCase, LogStores>();

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    Object.freeze(value);
    for (const inner of Object.values(value)) deepFreeze(inner);
  }
  return value;
}

/** A case made here, frozen all the way down and registered with the stores it came from. */
function foldedCase(opened: OpenCase, stores: LogStores): OpenCase {
  deepFreeze(opened);
  foldedCases.set(opened, stores);
  return opened;
}

/** Whether this exact object came from foldedCase, on these stores. */
function isFoldedCase(opened: OpenCase, stores: LogStores): boolean {
  const registered = foldedCases.get(opened);
  return registered !== undefined && registered === stores;
}

/** The bytes this log's rows name, each once, less what the case keeps. The raw bytes: no owner's event may start keeping one. */
function rowRawOf({ record, keptObjects }: CaseState): ReadonlySet<string> {
  return new Set(record.rows.flatMap(({ digest }) => (digest === null || keptObjects.includes(digest) ? [] : [digest])));
}

/** The raw bytes, and what a control named, less what the case keeps. What a purge can remove, and all it can. */
function purgeSetOf(state: CaseState): ReadonlySet<string> {
  return new Set([...rowRawOf(state), ...state.controlObjects.filter((digest) => !state.keptObjects.includes(digest))]);
}

function isSameSet(paths: readonly string[], digests: ReadonlySet<string>): boolean {
  return paths.length === digests.size && paths.every((path) => digests.has(path));
}

function machineActorOf(actor: LogEntry["actor"]): MachineActor {
  return actor.kind === "owner" ? { kind: "owner" } : { kind: "system:runner", attemptId: actor.attemptId };
}

const RECORD_TYPES: readonly string[] = [
  "instrument-recorded",
  "source-reconstructed",
  "source-recorded",
  "fact-recorded",
  "fact-superseded",
  "fact-retracted",
  "assertion-recorded",
  "assertion-retracted",
  "interpretation-recorded",
  "interpretation-reaffirmed",
  "unknown-recorded"
];

function isRecordEvent(event: CaseEvent): event is RecordEvent {
  return RECORD_TYPES.includes(event.type);
}

function stepped(state: CaseState, event: MachineEvent, record: EvidenceRecord = state.record, configurations: readonly ConfigurationIdentity[] = state.configurations): ApplyResult {
  const result = step(state.machine, event);
  return result.ok ? { ok: true, state: { ...state, machine: result.state, record, configurations } } : refused(result.refusal);
}

function applyEvent(state: CaseState | null, event: CaseEvent, by: MachineActor, seq: number): ApplyResult {
  if (event.type === "case-planned") {
    if (state !== null) return refused("already-planned");
    if (by.kind !== "owner") return refused("owner-only");
    const planned = plannedState({ slots: event.slots, controlRunId: event.controlRunId, configuration: configurationKey(event.configuration) });
    return planned.ok ? { ok: true, state: { machine: planned.state, record: EMPTY_RECORD, configurations: [event.configuration], keptObjects: [], controlObjects: [] } } : refused(planned.refusal);
  }
  if (state === null) return refused("not-planned");

  if (isRecordEvent(event)) {
    const result = applyRecordEvent(state.record, event, by, state.machine, seq);
    return result.ok ? { ok: true, state: { ...state, record: result.record } } : refused(result.refusal, result.at);
  }

  switch (event.type) {
    case "control-recorded":
      return stepped(state, { type: event.type, configuration: configurationKey(event.configuration), result: event.result, by });
    case "configuration-changed":
      return stepped(state, { type: event.type, configuration: configurationKey(event.configuration), by }, state.record, [...state.configurations, event.configuration]);
    case "exception-recorded":
      return stepped(state, { type: event.type, slot: event.slot, by });
    case "attempt-started": {
      const basis = visitBasisOf(state.machine, event.slot);
      const record = basis === null ? state.record : { ...state.record, visitBases: [...state.record.visitBases, { slot: event.slot, basis }] };
      return stepped(state, { type: event.type, slot: event.slot, by }, record);
    }
    case "attempt-finished": {
      const record = event.reason === null ? state.record : { ...state.record, acquisitionReasons: [...state.record.acquisitionReasons, { slot: event.slot, reason: event.reason }] };
      return stepped(state, { type: event.type, slot: event.slot, outcome: event.outcome, by }, record);
    }
    case "evidence-recorded": {
      const stepResult = step(state.machine, { type: event.type, slot: event.row.slot, id: event.row.id, by });
      if (!stepResult.ok) return refused(stepResult.refusal);
      // A manifest lists what the log named when it was made, so nothing is named after it.
      if (state.machine.purge !== null) return refused("evidence-after-manifest", "row");
      // The machine has just accepted this slot, so it is there.
      const { phase } = state.machine.attempts.find(({ slot }) => slot === event.row.slot) as AttemptState;
      const added = addRow(state.record, event.row, phase);
      return added.ok ? { ok: true, state: { ...state, machine: stepResult.state, record: added.record } } : refused(added.refusal, added.at);
    }
    case "purge-manifest-recorded": {
      const result = stepped(state, { ...event, by });
      if (!result.ok) return result;
      // What a manifest lists is all the bytes the log's rows name that the case does not keep, and
      // nothing else. The reducer does not read the log, so this is held here.
      if (!isSameSet(event.paths, purgeSetOf(state))) return refused("manifest-not-the-evidence", "paths");
      // A visit can upload an object ahead of its row, so once one began an empty set is not
      // nothing held, and such a case stays RAW_HELD. The case is closed here, so no slot still waits.
      const begun = state.machine.attempts.some(({ phase }) => phase !== "not_started");
      return event.paths.length === 0 && begun ? refused("manifest-empty-after-a-visit", "paths") : result;
    }
    default:
      return stepped(state, { ...event, by } as MachineEvent);
  }
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** The field of an event that keeps an object, for a refusal to point at. No row comes before a frozen plan, so a plan never names a raw digest. */
function keptField(event: CaseEvent): string {
  return event.type === "source-reconstructed" ? "patchDigest" : "configuration";
}

/**
 * What this event's named objects add to what the case keeps. A row's are raw bytes, and keep
 * nothing. A control's keep nothing either, since only the owner's events keep, and a purge lists
 * them unless the owner keeps them. An event may not start keeping a digest a row already names
 * as raw, nor, once a manifest exists, a path it lists. The rules that refuse the event for what it
 * is come first, as with a manifest.
 */
function withKept(before: CaseState | null, event: CaseEvent, named: readonly string[], after: CaseState): ApplyResult {
  if (event.type === "evidence-recorded") return { ok: true, state: after };
  // Only the owner's events keep. A control's objects are listed by a purge unless the owner keeps them.
  if (event.type === "control-recorded") return { ok: true, state: { ...after, controlObjects: [...new Set([...after.controlObjects, ...named])] } };
  if (before !== null) {
    const raw = rowRawOf(before);
    if (named.some((digest) => raw.has(digest))) return refused("raw-object-cannot-be-kept", keptField(event));
    // Once a manifest exists, a listed path is raw whoever named it, so nothing starts keeping one.
    const listed = before.machine.purge ?? [];
    if (named.some((digest) => listed.some(({ path }) => path === digest))) return refused("raw-object-cannot-be-kept", keptField(event));
  }
  return { ok: true, state: { ...after, keptObjects: [...new Set([...after.keptObjects, ...named])] } };
}

/**
 * One entry's effect, or why it has none that this code can explain. Exported only so that
 * investigation/test/case-exploration.test.ts can walk the fold itself. It reads its arguments and
 * writes nothing, so it is no way around runCommand: a command still takes only a case this isolate
 * folded and registered, on the stores it came from.
 */
export function foldEntry(state: CaseState | null, entry: Pick<LogEntry, "actor" | "events" | "evidence" | "seq">): ApplyResult {
  if (entry.events.length !== 1) return refused("not-one-command");
  const decoded = decodeEvent(entry.events[0]);
  if (!decoded.ok) return refused(decoded.refusal, decoded.at);
  const named = digestsNamed(decoded.event);
  if (!sameList(named, entry.evidence)) return refused("evidence-not-named");
  const applied = applyEvent(state, decoded.event, machineActorOf(entry.actor), entry.seq);
  return applied.ok ? withKept(state, decoded.event, named, applied.state) : applied;
}

/** This case as its log holds it, every entry and evidence object checked by the log first. `seen` is handed each object's bytes as the log checks them. */
export async function openCase(stores: LogStores, caseId: string, seen: EvidenceSeen | null = null): Promise<OpenCaseResult> {
  const opened = await openLog(stores, caseId, seen);
  if (!opened.ok) return opened;
  let state: CaseState | null = null;
  let seq = 0;
  for (const { digest, entry } of opened.log.entries) {
    const result = foldEntry(state, entry);
    if (!result.ok) return { ok: false, refusal: result.refusal, at: result.at ?? digest };
    state = result.state;
    seq = entry.seq;
  }
  return { ok: true, case: foldedCase({ caseId, head: opened.log.head, seq, state }, stores) };
}

export type CaseCommand = Readonly<{ actor: Actor; event: LogEvent; now: () => number }>;

/**
 * Apply one command to a case this isolate folded from these stores, and log it. Refused here, nothing is written.
 * A reader holding an old head gets the log's conflict, which is what makes the state it checked
 * against current. What was folded is the parse of the bytes written, at the sequence the log
 * gives them, so the state returned is what a reopen finds.
 */
export async function runCommand(stores: LogStores, opened: OpenCase, { actor, event, now }: CaseCommand): Promise<CommandResult> {
  if (!isDerivedActor(actor)) return { ok: false, refusal: "not-an-actor", at: null };
  if (!isFoldedCase(opened, stores)) return { ok: false, refusal: "not-a-folded-case", at: null };
  const bytes = canonicalBytes(event);
  if (bytes === null) return { ok: false, refusal: "malformed-command", at: null };
  // What is checked and what is written must be one value, whatever the caller's object does next.
  const own = parseCanonical(bytes) as LogEvent;
  const decoded = decodeEvent(own);
  if (!decoded.ok) return decoded;
  const evidence = digestsNamed(decoded.event);
  const checked = foldEntry(opened.state, { actor, events: [own], evidence, seq: opened.seq + 1 });
  if (!checked.ok) return checked;

  const appended = await appendCommand(stores, { caseId: opened.caseId, actor, events: [own], evidence, expectedHead: opened.head, now });
  if (!appended.ok) return appended;
  return { ok: true, digest: appended.digest, case: foldedCase({ caseId: opened.caseId, head: appended.digest, seq: appended.entry.seq, state: checked.state }, stores) };
}

/** A fresh attempt id for each slot, in plan order. Ids come from one function, or from the one a fixture hands in: see ids.ts. */
export function mintedSlots(slots: readonly SlotName[], mint: () => string = mintAttemptId): PlannedSlots {
  return slots.map((slot) => ({ slot, attemptId: mint() }));
}

export type NewCase = Readonly<{
  caseId: string;
  actor: Actor;
  /** Which slots the plan holds. Their attempt ids and the control run's are minted here, and nobody hands them in. */
  slots: readonly SlotName[];
  configuration: ConfigurationIdentity;
  now: () => number;
  /** For a fixture that wants readable ids. Anything else leaves ids.ts to it. */
  mint?: () => string;
}>;

/** The caller's clock, read once. One that throws reads as no time, which the first entry's check refuses by shape. */
function readClock(now: () => number): number | null {
  try {
    return now();
  } catch {
    return null;
  }
}

/**
 * Check a whole new case, then start its log and record its plan. The caller's slots,
 * configuration and clock are each read once, and every refusal the plan's entry could get for
 * what it holds or when it was made, including the actor's expiry and an object that is not
 * stored, comes before the log starts. So a call refused for any of that can be corrected and made
 * again. After that only the stores can refuse or fail: log-exists for a log already there, a
 * writer that got in first, or a store going down.
 *
 * The two writes are still two steps, so a kill or a failing store between them leaves a log with
 * no plan, which opens with a null state and takes a case-planned command. That command carries the
 * ids its sender put in it, held to their shape and to differing from each other and nothing
 * more, so recovering from that kill should mint them with mintedSlots and ids.ts. A log that
 * exists is refused, so this cannot start a second history over a first.
 */
export async function createCase(stores: LogStores, { caseId, actor, slots, configuration, now, mint = mintAttemptId }: NewCase): Promise<CommandResult> {
  if (!isDerivedActor(actor)) return { ok: false, refusal: "not-an-actor", at: null };
  if (!isCaseId(caseId)) return { ok: false, refusal: "malformed-case-id", at: null };
  const names: readonly SlotName[] | null = Array.isArray(slots) ? [...slots] : null;
  if (names === null || !names.every((slot) => (SLOT_NAMES as readonly unknown[]).includes(slot))) return { ok: false, refusal: "malformed-plan", at: null };
  const event = { type: "case-planned", data: { slots: mintedSlots(names, mint), controlRunId: mint(), configuration } } as unknown as LogEvent;
  const bytes = canonicalBytes(event);
  if (bytes === null) return { ok: false, refusal: "malformed-command", at: null };
  const own = parseCanonical(bytes) as LogEvent;
  const decoded = decodeEvent(own);
  if (!decoded.ok) return decoded;
  const evidence = digestsNamed(decoded.event);
  const checked = foldEntry(null, { actor, events: [own], evidence, seq: 1 });
  if (!checked.ok) return checked;
  const atMs = readClock(now);
  const refusal = await checkFirstEntry(stores, { caseId, actor, events: [own], evidence }, atMs);
  if (refusal !== null) return refusal;
  const created = await createLog(stores);
  if (!created.ok) return { ok: false, refusal: created.refusal, at: null };
  return runCommand(stores, foldedCase({ caseId, head: GENESIS_HEAD, seq: 0, state: null }, stores), { actor, event: own, now: () => atMs as number });
}

/** One row per planned slot for this case, with the keys its configurations give it. */
export function aggregateRowsOfCase(state: CaseState): readonly AggregateRow[] {
  return aggregateRowsOf(state.machine, state.record, (configuration) => {
    const identity = state.configurations.find((candidate) => configurationKey(candidate) === configuration);
    return identity === undefined ? { release: null, commit: null } : { release: identity.reaRelease, commit: identity.commit };
  });
}
