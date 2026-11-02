// What a log entry's event may hold, one shape per type, with exact keys. This is the wall
// between bytes and the machine: a field not listed is refused, not ignored, so nothing
// typed into a command can pass for who acted, and no value of an unknown kind can reach a
// later reader. A refusal names the event's type or field and never repeats a value.
//
// Slugs carry what the machine's own vocabulary names: ids, instruments, limits, reasons. A
// slug has no slash, equals sign, at sign, dot or upper case, so a URL, a query or an address
// does not fit one as written. That is a shape and nothing more: a lower-case word fits a slug
// whatever it means, so a runner that wrote a captured value into one would get it through.
// Free text exists in one place, what the owner writes in a claim. That is owner-written and
// outside what the summary tier claims.

import { isDigest, type LogEvent } from "./case-log";
import { hasExactly } from "./canonical-json";
import { isAttemptId } from "./actor";
import type { ControlResult, ReportedOutcome, SlotName } from "./case-machine";
import { SLOT_NAMES } from "./case-machine";
import type { PurgeEvent } from "./purge";
import type { Cite, EvidenceRow, InstrumentRecord, RecordEvent, ReportedRowState, RowObservation, RowWindow, UnknownInput } from "./evidence-model";

const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;
const VERSION = /^[0-9]+(?:\.[0-9]+){0,3}$/;
const INTEGRITY = /^sha(?:256|384|512)-[A-Za-z0-9+/]+={0,2}$/;
const MAX_TEXT_CHARS = 4096;
const MAX_LIST_ITEMS = 64;
const ALL_ZERO_ID = "0".repeat(32);

/**
 * What a control is valid for, and what an aggregate splits on. Two configurations
 * differing in any field are different configurations. The commit sits beside the plan's
 * list so that a group can split on it by name, though an image digest already pins it.
 */
export type ConfigurationIdentity = Readonly<{
  commit: string;
  runnerImage: string;
  reaRelease: string;
  reaIntegrity: string;
  scannerNode: string;
  reaNode: string;
  chromium: string;
  instruments: readonly string[];
  grammarVersion: number;
  fixtureDigest: string;
  criterionDigest: string;
}>;

const IDENTITY_KEYS = ["commit", "runnerImage", "reaRelease", "reaIntegrity", "scannerNode", "reaNode", "chromium", "instruments", "grammarVersion", "fixtureDigest", "criterionDigest"];

/** One string for one identity, in a fixed order, so equal identities compare equal and any changed field does not. */
export function configurationKey(identity: ConfigurationIdentity): string {
  return JSON.stringify([
    identity.commit,
    identity.runnerImage,
    identity.reaRelease,
    identity.reaIntegrity,
    identity.scannerNode,
    identity.reaNode,
    identity.chromium,
    identity.instruments,
    identity.grammarVersion,
    identity.fixtureDigest,
    identity.criterionDigest
  ]);
}

export type PlannedSlots = readonly Readonly<{ slot: SlotName; attemptId: string }>[];

export type CaseEvent =
  | Readonly<{ type: "case-planned"; slots: PlannedSlots; controlRunId: string; configuration: ConfigurationIdentity }>
  | Readonly<{ type: "plan-frozen"; planDigest: string }>
  | Readonly<{ type: "control-recorded"; configuration: ConfigurationIdentity; result: ControlResult }>
  | Readonly<{ type: "configuration-changed"; configuration: ConfigurationIdentity }>
  | Readonly<{ type: "exception-recorded"; slot: SlotName; reason: string }>
  | Readonly<{ type: "baseline-rule-recorded"; result: "met" | "not_met" }>
  | Readonly<{ type: "attempt-started" | "attempt-start-retried" | "capture-began" | "capture-finished" | "attempt-deadline"; slot: SlotName }>
  | Readonly<{ type: "cleanup-confirmed" | "cleanup-unconfirmed" | "environment-destroyed"; slot: SlotName }>
  | Readonly<{ type: "attempt-finished"; slot: SlotName; outcome: ReportedOutcome; reason: string | null }>
  | Readonly<{ type: "evidence-recorded"; row: EvidenceRow }>
  | Readonly<{ type: "case-deadline" | "reconcile" | "case-cancelled" }>
  | PurgeEvent
  | RecordEvent;

export type DecodeResult = Readonly<{ ok: true; event: CaseEvent }> | Readonly<{ ok: false; refusal: "unknown-event-type" | "malformed-event"; at: string }>;

type Data = LogEvent["data"];

function isPlain(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSlug(value: unknown): value is string {
  return typeof value === "string" && SLUG.test(value);
}

function isSlot(value: unknown): value is SlotName {
  return (SLOT_NAMES as readonly unknown[]).includes(value);
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "" && value.length <= MAX_TEXT_CHARS;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isListOf<T>(value: unknown, each: (item: unknown) => item is T): value is readonly T[] {
  return Array.isArray(value) && value.length <= MAX_LIST_ITEMS && value.every(each);
}

function isDistinctList<T>(value: unknown, each: (item: unknown) => item is T): value is readonly T[] {
  return isListOf(value, each) && new Set(value).size === value.length;
}

export function isConfigurationIdentity(value: unknown): value is ConfigurationIdentity {
  return (
    isPlain(value) &&
    hasExactly(value, IDENTITY_KEYS) &&
    typeof value.commit === "string" &&
    COMMIT.test(value.commit) &&
    typeof value.runnerImage === "string" &&
    IMAGE_DIGEST.test(value.runnerImage) &&
    typeof value.reaRelease === "string" &&
    VERSION.test(value.reaRelease) &&
    typeof value.reaIntegrity === "string" &&
    INTEGRITY.test(value.reaIntegrity) &&
    typeof value.scannerNode === "string" &&
    VERSION.test(value.scannerNode) &&
    typeof value.reaNode === "string" &&
    VERSION.test(value.reaNode) &&
    typeof value.chromium === "string" &&
    VERSION.test(value.chromium) &&
    isDistinctList(value.instruments, isSlug) &&
    value.instruments.length > 0 &&
    isCount(value.grammarVersion) &&
    isDigest(value.fixtureDigest) &&
    isDigest(value.criterionDigest)
  );
}

/** An id a plan can name. All zeros has the shape and is plainly no minted id. */
function isPlanId(value: unknown): value is string {
  return isAttemptId(value) && value !== ALL_ZERO_ID;
}

function isPlannedSlots(value: unknown): value is PlannedSlots {
  return isListOf(value, (item): item is PlannedSlots[number] => isPlain(item) && hasExactly(item, ["slot", "attemptId"]) && isSlot(item.slot) && isPlanId(item.attemptId));
}

/** Every id a plan names differs from every other, the control run's included. A runner holding one can then speak for one thing. */
function plannedIdsAreDistinct(slots: PlannedSlots, controlRunId: string): boolean {
  return new Set([controlRunId, ...slots.map(({ attemptId }) => attemptId)]).size === slots.length + 1;
}

function isWindow(value: unknown): value is RowWindow {
  if (!isPlain(value)) return false;
  if (value.clock === null) return hasExactly(value, ["clock", "note"]) && isSlug(value.note);
  return hasExactly(value, ["clock", "startMs", "endMs"]) && isSlug(value.clock) && isCount(value.startMs) && isCount(value.endMs) && value.endMs >= value.startMs;
}

const ROW_STATES: readonly unknown[] = ["present", "no_record", "before_window", "out_of_scope", "truncated", "not_read"] satisfies readonly ReportedRowState[];
const GRANULARITIES: readonly unknown[] = ["block", "function"];
const WINDOW_ENDS: readonly unknown[] = ["window_closed", "truncated", "target_crashed", "operation_failed", "deadline", "cancelled"];
const SCOPES: readonly unknown[] = ["in_scope", "out_of_scope"];

function isObservation(value: unknown): value is RowObservation {
  return (
    isPlain(value) &&
    hasExactly(value, ["subject", "count", "granularity", "windowEnd", "scope"]) &&
    isSlug(value.subject) &&
    (value.count === null || isCount(value.count)) &&
    GRANULARITIES.includes(value.granularity) &&
    WINDOW_ENDS.includes(value.windowEnd) &&
    SCOPES.includes(value.scope)
  );
}

/** A present row names the object holding its bytes, and no other row has any. */
function isRow(value: unknown): value is EvidenceRow {
  if (!isPlain(value)) return false;
  if (!hasExactly(value, ["id", "slot", "instrument", "state", "window", "limits", "digest", "observation"])) return false;
  if (!isSlug(value.id) || !isSlot(value.slot) || !isSlug(value.instrument) || !ROW_STATES.includes(value.state)) return false;
  if (!isWindow(value.window) || !isDistinctList(value.limits, isSlug)) return false;
  if (value.observation !== null && !isObservation(value.observation)) return false;
  return value.state === "present" ? isDigest(value.digest) : value.digest === null;
}

function isUnknownInput(value: unknown): value is UnknownInput {
  return (
    isPlain(value) &&
    hasExactly(value, ["id", "question", "reason", "detail", "wouldResolve"]) &&
    isSlug(value.id) &&
    isText(value.question) &&
    isText(value.reason) &&
    (value.detail === null || isText(value.detail)) &&
    (value.wouldResolve === null || isText(value.wouldResolve))
  );
}

function isCiteList(value: unknown): value is readonly Cite[] {
  return isListOf(value, (item): item is Cite => isPlain(item) && hasExactly(item, ["fact", "version"]) && isSlug(item.fact) && isCount(item.version) && item.version >= 1);
}

/** Each type's decoder, or null when the data is not exactly what the type holds. */
const DECODERS: Readonly<Record<string, (data: Data) => CaseEvent | null>> = {
  "case-planned": (data) =>
    hasExactly(data, ["slots", "controlRunId", "configuration"]) && isPlannedSlots(data.slots) && isPlanId(data.controlRunId) && plannedIdsAreDistinct(data.slots, data.controlRunId) && isConfigurationIdentity(data.configuration)
      ? { type: "case-planned", slots: data.slots, controlRunId: data.controlRunId, configuration: data.configuration }
      : null,
  "plan-frozen": (data) => (hasExactly(data, ["planDigest"]) && isDigest(data.planDigest) ? { type: "plan-frozen", planDigest: data.planDigest } : null),
  "control-recorded": (data) =>
    hasExactly(data, ["configuration", "result"]) && isConfigurationIdentity(data.configuration) && (data.result === "met" || data.result === "not_met" || data.result === "not_evaluated")
      ? { type: "control-recorded", configuration: data.configuration, result: data.result }
      : null,
  "configuration-changed": (data) => (hasExactly(data, ["configuration"]) && isConfigurationIdentity(data.configuration) ? { type: "configuration-changed", configuration: data.configuration } : null),
  "exception-recorded": (data) => (hasExactly(data, ["slot", "reason"]) && isSlot(data.slot) && isText(data.reason) ? { type: "exception-recorded", slot: data.slot, reason: data.reason } : null),
  "baseline-rule-recorded": (data) => (hasExactly(data, ["result"]) && (data.result === "met" || data.result === "not_met") ? { type: "baseline-rule-recorded", result: data.result } : null),
  "attempt-finished": (data) => {
    if (!hasExactly(data, ["slot", "outcome", "reason"]) || !isSlot(data.slot)) return null;
    const { outcome, reason } = data;
    if (outcome !== "usable" && outcome !== "walled" && outcome !== "failed" && outcome !== "incomplete") return null;
    // An attempt that did not simply work says why. One that did has nothing to add.
    if (outcome === "usable" ? reason !== null : !isSlug(reason)) return null;
    return { type: "attempt-finished", slot: data.slot, outcome, reason: reason as string | null };
  },
  "evidence-recorded": (data) => (hasExactly(data, ["row"]) && isRow(data.row) ? { type: "evidence-recorded", row: data.row } : null),
  "purge-manifest-recorded": (data) => (hasExactly(data, ["paths"]) && isDistinctList(data.paths, isDigest) ? { type: "purge-manifest-recorded", paths: data.paths } : null),
  "purge-path-absent": (data) => (hasExactly(data, ["path"]) && isDigest(data.path) ? { type: "purge-path-absent", path: data.path } : null),
  "purge-path-remains": (data) => (hasExactly(data, ["path"]) && isDigest(data.path) ? { type: "purge-path-remains", path: data.path } : null),
  "instrument-recorded": (data) => {
    if (!hasExactly(data, ["slot", "instrument", "completeness", "reason"]) || !isSlot(data.slot) || !isSlug(data.instrument)) return null;
    const { completeness, reason } = data;
    if (completeness !== "complete" && completeness !== "partial" && completeness !== "missing") return null;
    if (completeness === "complete" ? reason !== null : !isSlug(reason)) return null;
    return { type: "instrument-recorded", slot: data.slot, instrument: data.instrument, completeness: completeness as InstrumentRecord["completeness"], reason: reason as string | null };
  },
  "source-reconstructed": (data) =>
    hasExactly(data, ["appliesTo", "baseCommit", "patchDigest", "identity"]) && isDistinctList(data.appliesTo, isSlot) && typeof data.baseCommit === "string" && COMMIT.test(data.baseCommit) && isDigest(data.patchDigest) && isDigest(data.identity)
      ? { type: "source-reconstructed", appliesTo: data.appliesTo, baseCommit: data.baseCommit, patchDigest: data.patchDigest, identity: data.identity }
      : null,
  "source-recorded": (data) =>
    hasExactly(data, ["slot", "commit", "identity"]) && isSlot(data.slot) && typeof data.commit === "string" && COMMIT.test(data.commit) && isDigest(data.identity) ? { type: "source-recorded", slot: data.slot, commit: data.commit, identity: data.identity } : null,
  "fact-recorded": (data) =>
    hasExactly(data, ["id", "statement", "evidence"]) && isSlug(data.id) && isText(data.statement) && isDistinctList(data.evidence, isSlug) ? { type: "fact-recorded", id: data.id, statement: data.statement, evidence: data.evidence } : null,
  "fact-superseded": (data) => (hasExactly(data, ["fact", "statement", "reason"]) && isSlug(data.fact) && isText(data.statement) && isText(data.reason) ? { type: "fact-superseded", fact: data.fact, statement: data.statement, reason: data.reason } : null),
  "fact-retracted": (data) =>
    hasExactly(data, ["fact", "reason", "unknown"]) && isSlug(data.fact) && isText(data.reason) && (data.unknown === null || isUnknownInput(data.unknown)) ? { type: "fact-retracted", fact: data.fact, reason: data.reason, unknown: data.unknown } : null,
  "assertion-recorded": (data) => (hasExactly(data, ["id", "statement"]) && isSlug(data.id) && isText(data.statement) ? { type: "assertion-recorded", id: data.id, statement: data.statement } : null),
  "assertion-retracted": (data) =>
    hasExactly(data, ["assertion", "reason", "unknown"]) && isSlug(data.assertion) && isText(data.reason) && isUnknownInput(data.unknown) ? { type: "assertion-retracted", assertion: data.assertion, reason: data.reason, unknown: data.unknown } : null,
  "interpretation-recorded": (data) => (hasExactly(data, ["id", "statement", "cites"]) && isSlug(data.id) && isText(data.statement) && isCiteList(data.cites) ? { type: "interpretation-recorded", id: data.id, statement: data.statement, cites: data.cites } : null),
  "interpretation-reaffirmed": (data) => (hasExactly(data, ["interpretation", "cites"]) && isSlug(data.interpretation) && isCiteList(data.cites) ? { type: "interpretation-reaffirmed", interpretation: data.interpretation, cites: data.cites } : null),
  "unknown-recorded": (data) => (hasExactly(data, ["unknown"]) && isUnknownInput(data.unknown) ? { type: "unknown-recorded", unknown: data.unknown } : null)
};

const SLOT_ONLY = ["attempt-started", "attempt-start-retried", "capture-began", "capture-finished", "attempt-deadline", "cleanup-confirmed", "cleanup-unconfirmed", "environment-destroyed"];
const EMPTY = ["case-deadline", "reconcile", "case-cancelled"];

function decoderFor(type: string): ((data: Data) => CaseEvent | null) | null {
  if (SLOT_ONLY.includes(type)) return (data) => (hasExactly(data, ["slot"]) && isSlot(data.slot) ? ({ type, slot: data.slot } as CaseEvent) : null);
  if (EMPTY.includes(type)) return (data) => (hasExactly(data, []) ? ({ type } as CaseEvent) : null);
  return Object.prototype.hasOwnProperty.call(DECODERS, type) ? DECODERS[type] : null;
}

/** Every event type the log can hold. There is no approve, publish or export among them, and a test holds that. */
export const EVENT_TYPES: readonly string[] = [...Object.keys(DECODERS), ...SLOT_ONLY, ...EMPTY].sort();

/** One logged event as the machine and the record will read it, or a refusal naming what failed and nothing it held. */
export function decodeEvent(event: LogEvent): DecodeResult {
  if (!isPlain(event) || !hasExactly(event, ["type", "data"]) || typeof event.type !== "string" || !isPlain(event.data)) return { ok: false, refusal: "malformed-event", at: "event" };
  const decoder = decoderFor(event.type);
  if (decoder === null) return { ok: false, refusal: "unknown-event-type", at: "type" };
  const decoded = decoder(event.data);
  return decoded === null ? { ok: false, refusal: "malformed-event", at: event.type } : { ok: true, event: decoded };
}

function configurationDigests(configuration: ConfigurationIdentity): readonly string[] {
  return [...new Set([configuration.fixtureDigest, configuration.criterionDigest])];
}

/**
 * The evidence objects an event rests on, which the log hashes on every open. An entry names
 * exactly these. A frozen plan's digest, a configuration's fixture and criterion, a patch and a
 * row's raw bytes are all bound this way, so each must be a stored object.
 *
 * Unbound, because nothing here can check them: a source identity and a commit are recorded as
 * given, and so are a configuration's image digest, release and versions. They are compared
 * with each other, and never with anything they name.
 */
export function digestsNamed(event: CaseEvent): readonly string[] {
  switch (event.type) {
    case "evidence-recorded":
      return event.row.digest === null ? [] : [event.row.digest];
    case "source-reconstructed":
      return [event.patchDigest];
    case "plan-frozen":
      return [event.planDigest];
    case "case-planned":
    case "control-recorded":
    case "configuration-changed":
      return configurationDigests(event.configuration);
    default:
      return [];
  }
}
