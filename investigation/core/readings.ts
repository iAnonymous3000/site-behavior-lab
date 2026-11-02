// What a record may be read as. Pure functions over closed inputs, each exhaustively
// testable, and neither knows any tool's output: an adapter that turns real output into
// these inputs belongs to a later batch, so this is the rule alone.
//
// readObservation answers "did this show up in this window". A count above 0 stays observed
// whatever else went wrong. A count of 0 is a statement about that window, at the granularity
// reported, and only that. No record, a window cut short, out of scope and an operation that
// failed are unknown, and no answer here means a thing did not happen: the vocabulary has no
// word for it.
//
// readExecutionJoin answers "is this position consistent with that reported range". It
// needs every condition below and says which ones failed. Equal attempt ids alone never
// link. A met join reads "position_consistent", and nothing here can say one thing
// caused another.
//
// Coordinates, as the plan states them. A stack frame is one-based, in the coordinates of the
// resource that holds the script. A reported range is zero-based in the script's own
// coordinates, in UTF-16 columns, with an exclusive end, as CDP's are. An inline script
// starts at resource_start in its document, zero-based, which shifts lines and shifts columns
// on its first line only. An external script's resource_start is 0, 0, and it must say so,
// since nothing here assumes one.

import type { Cleanup } from "./case-machine";

/** The largest time a Date can hold. A time past it, or any time that is not a finite number at or above 0, is not a time. */
export const MAX_TIME_MS = 8_640_000_000_000_000;
/**
 * How far apart two clocks may be declared to be, and still stand in for sharing one. A minute
 * is wider than any window yet armed, so a bound past it would link nearly anything to anything.
 */
export const MAX_UNCERTAINTY_MS = 60_000;

export type Granularity = "block" | "function";
/** Why the window ended. Only window_closed means it ran as armed. */
export type WindowEnd = "window_closed" | "truncated" | "target_crashed" | "operation_failed" | "deadline" | "cancelled";
export type Scope = "in_scope" | "out_of_scope";
export type Completeness = "complete" | "partial" | "missing" | "not_recorded";

export type ObservationInput = Readonly<{
  record: "present" | "absent";
  count: number | null;
  granularity: Granularity;
  windowEnd: WindowEnd;
  scope: Scope;
  completeness: Completeness;
  cleanup: Cleanup;
  /**
   * How the attempt the record came from ended, as far as the record's reading goes. Walled and
   * incomplete withhold complete, and name themselves. An operation that failed, timed out or was
   * cancelled keeps what it retained, and its 0 says nothing.
   */
  operation: "succeeded" | "walled" | "incomplete" | "failed_retained";
}>;

export const COMPLETENESS_LIMITS = ["no_record", "malformed_record", "out_of_scope", "window_not_closed", "coverage_not_complete", "cleanup_unresolved", "function_only", "attempt_walled", "attempt_incomplete", "operation_failed", "late"] as const;

/** A condition complete needs that does not hold. An empty list is what complete means. */
export type CompletenessLimit = (typeof COMPLETENESS_LIMITS)[number];

export type UnknownReason = "no_record" | "out_of_scope" | "truncated" | "malformed_record" | "operation_failed";

export type ObservationReading =
  | Readonly<{ reading: "observed"; count: number; granularity: Granularity; windowEnd: WindowEnd; complete: boolean; limits: readonly CompletenessLimit[] }>
  | Readonly<{ reading: "zero_in_window"; granularity: Granularity; windowEnd: WindowEnd; complete: boolean; limits: readonly CompletenessLimit[] }>
  | Readonly<{ reading: "unknown"; reason: UnknownReason; complete: false; limits: readonly CompletenessLimit[] }>;

function isCount(value: number | null): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function limitsOf(input: ObservationInput): readonly CompletenessLimit[] {
  const limits: CompletenessLimit[] = [];
  if (input.record !== "present") limits.push("no_record");
  else if (!isCount(input.count)) limits.push("malformed_record");
  if (input.scope !== "in_scope") limits.push("out_of_scope");
  if (input.windowEnd !== "window_closed") limits.push("window_not_closed");
  if (input.completeness !== "complete") limits.push("coverage_not_complete");
  if (input.cleanup !== "confirmed" && input.cleanup !== "environment_destroyed") limits.push("cleanup_unresolved");
  if (input.granularity !== "block") limits.push("function_only");
  if (input.operation === "walled") limits.push("attempt_walled");
  else if (input.operation === "incomplete") limits.push("attempt_incomplete");
  else if (input.operation !== "succeeded") limits.push("operation_failed");
  return limits;
}

export function readObservation(input: ObservationInput): ObservationReading {
  const limits = limitsOf(input);
  const unknown = (reason: UnknownReason): ObservationReading => ({ reading: "unknown", reason, complete: false, limits });

  if (input.record !== "present") return unknown(input.scope === "out_of_scope" ? "out_of_scope" : "no_record");
  if (!isCount(input.count)) return unknown("malformed_record");

  const complete = limits.length === 0;
  if (input.count > 0) return { reading: "observed", count: input.count, granularity: input.granularity, windowEnd: input.windowEnd, complete, limits };

  if (input.scope === "out_of_scope") return unknown("out_of_scope");
  if (input.windowEnd !== "window_closed") return unknown("truncated");
  // The instrument says it gave nothing, so a 0 from it is not a count of anything.
  if (input.completeness === "missing") return unknown("no_record");
  // An attempt that failed read as nothing, not as 0: see aggregates.ts.
  if (input.operation === "failed_retained") return unknown("operation_failed");
  return { reading: "zero_in_window", granularity: input.granularity, windowEnd: input.windowEnd, complete, limits };
}

export type Position = Readonly<{ line: number; column: number }>;

export type ScriptIdentity = Readonly<{
  scriptId: string | null;
  url: string | null;
  resourceStart: Position | null;
  digest: string | null;
}>;

/** Where something happened. A null or an empty string is not the same as anything, including another. */
export type JoinPlace = Readonly<{
  attempt: string | null;
  target: string | null;
  frame: string | null;
  loader: string | null;
  script: ScriptIdentity;
}>;

export type StackCall = JoinPlace &
  Readonly<{
    /** One-based, in the resource's coordinates. */
    line: number;
    column: number;
    time: Readonly<{ clock: string | null; ms: number | null }>;
  }>;

export type ReportedRange = JoinPlace &
  Readonly<{
    /** Zero-based, in the script's coordinates, end exclusive. */
    start: Position;
    end: Position;
    window: Readonly<{ clock: string | null; startMs: number; endMs: number; uncertaintyMs: number | null }>;
  }>;

/** The scripts one session saw, in that session's own inventory. */
export type SessionInventory = Readonly<{ attempt: string | null; scripts: readonly ScriptIdentity[] }>;

export type JoinReason =
  | "attempt_not_same"
  | "target_not_same"
  | "frame_not_same"
  | "loader_not_same"
  | "inventory_of_another_session"
  | "script_id_differs"
  | "no_script_identity"
  | "script_identity_differs"
  | "not_in_inventory"
  | "url_repeated"
  | "coordinates_unknown"
  | "coordinates_invalid"
  | "position_outside_range"
  | "time_unknown"
  | "time_invalid"
  | "clock_not_shared"
  | "time_outside_window";

export type JoinReading =
  | Readonly<{ reading: "position_consistent" }>
  | Readonly<{ reading: "ambiguous"; reason: "url_repeated" }>
  | Readonly<{ reading: "no_join"; reasons: readonly JoinReason[] }>;

/** A value only counts when it says something. */
function known(value: string | null): string | null {
  return value === "" ? null : value;
}

function isSameKnown(left: string | null, right: string | null): boolean {
  return known(left) !== null && left === right;
}

/** Whether both sides say something, and not the same thing. An unknown on either side is not a difference. */
function differs(left: string | null, right: string | null): boolean {
  return known(left) !== null && known(right) !== null && left !== right;
}

function isPosition(value: Position): boolean {
  return Number.isSafeInteger(value.line) && value.line >= 0 && Number.isSafeInteger(value.column) && value.column >= 0;
}

/** Negative when a sits before b. */
function compare(a: Position, b: Position): number {
  return a.line !== b.line ? a.line - b.line : a.column - b.column;
}

function isSamePosition(a: Position | null, b: Position | null): boolean {
  return a !== null && b !== null && compare(a, b) === 0;
}

/** A one-based stack position, in the script's zero-based coordinates, or null when it falls before the script. */
export function stackToScriptPosition(line: number, column: number, resourceStart: Position): Position | null {
  const scriptLine = line - 1 - resourceStart.line;
  const scriptColumn = scriptLine === 0 ? column - 1 - resourceStart.column : column - 1;
  return scriptLine < 0 || scriptColumn < 0 ? null : { line: scriptLine, column: scriptColumn };
}

type IdentityFinding = "same" | "repeated" | JoinReason;

/** Whether two accounts of a script say different things where both say anything, its id included. */
function disagree(a: ScriptIdentity, b: ScriptIdentity): boolean {
  return differs(a.scriptId, b.scriptId) || differs(a.url, b.url) || differs(a.digest, b.digest) || (a.resourceStart !== null && b.resourceStart !== null && !isSamePosition(a.resourceStart, b.resourceStart));
}

/**
 * By id where both sides have one, as long as nothing the call and the range say disagrees, and
 * one entry the inventory holds for that id disagrees with neither. No such entry is no join. More
 * than one is ambiguous. Otherwise by URL, resource start and digest.
 *
 * Without an id on both sides the range must be a script this session saw: it names a URL, a
 * start and a digest, the call says nothing against them, and the inventory has an entry with all
 * three that disagrees with neither, a one-sided id included. An id on one side is still an id: the
 * inventory must hold it, in an entry that agrees with the range's place, or there is no join, as
 * with ids on both sides. A known id the inventory cannot confirm is no ground for a join on
 * position alone, so an entry without an id at the range's place does not stand in for it. A
 * range that is not one of those is
 * no candidate, and gets no join for that, however the call's URL repeats. Only then can a join be
 * ambiguous: more than one entry at that URL fits what the call or the range knows, so either side
 * could be that other script, and an entry whose start or digest nobody knows could be the same
 * script, so it counts as fitting. If one entry fits and the call's own start or digest is missing,
 * a URL seen once with the rest of its identity missing is still no identity.
 */
function identityFinding(call: ScriptIdentity, range: ScriptIdentity, inventory: readonly ScriptIdentity[]): IdentityFinding {
  const callId = known(call.scriptId);
  const rangeId = known(range.scriptId);
  if (callId !== null && rangeId !== null) {
    if (callId !== rangeId) return "script_id_differs";
    if (disagree(call, range)) return "script_identity_differs";
    const byId = inventory.filter(({ scriptId }) => scriptId === callId);
    if (byId.length === 0) return "not_in_inventory";
    const agreeing = byId.filter((entry) => !disagree(entry, call) && !disagree(entry, range));
    if (agreeing.length === 0) return "script_identity_differs";
    return agreeing.length === 1 ? "same" : "repeated";
  }
  const url = known(call.url);
  if (url === null) return "no_script_identity";
  if (known(range.url) === null || range.resourceStart === null || known(range.digest) === null) return "no_script_identity";
  if (disagree(call, range)) return "script_identity_differs";
  // The range names its URL, start and digest here, and the call says nothing against them, so an entry agreeing with the range agrees with the call.
  const oneId = callId ?? rangeId;
  if (oneId !== null) {
    const byId = inventory.filter(({ scriptId }) => scriptId === oneId);
    if (byId.length === 0) return "not_in_inventory";
    if (byId.every((entry) => disagree(entry, range))) return "script_identity_differs";
  }
  const sameUrl = inventory.filter((entry) => entry.url === url);
  const ofRange = sameUrl.filter((entry) => isSamePosition(entry.resourceStart, range.resourceStart) && entry.digest === range.digest);
  if (ofRange.length === 0) return "not_in_inventory";
  if (ofRange.every((entry) => disagree(entry, call) || disagree(entry, range))) return "script_identity_differs";
  const fitting = sameUrl.filter((entry) => !disagree(entry, call) || !disagree(entry, range));
  if (fitting.length > 1) return "repeated";
  return call.resourceStart === null || known(call.digest) === null ? "no_script_identity" : "same";
}

function positionReasons(call: StackCall, range: ReportedRange): readonly JoinReason[] {
  const { resourceStart } = call.script;
  if (resourceStart === null) return ["coordinates_unknown"];
  const stackOk = Number.isSafeInteger(call.line) && call.line >= 1 && Number.isSafeInteger(call.column) && call.column >= 1;
  if (!stackOk || !isPosition(resourceStart) || !isPosition(range.start) || !isPosition(range.end) || compare(range.start, range.end) >= 0) {
    return ["coordinates_invalid"];
  }
  const position = stackToScriptPosition(call.line, call.column, resourceStart);
  if (position === null) return ["position_outside_range"];
  return compare(position, range.start) >= 0 && compare(position, range.end) < 0 ? [] : ["position_outside_range"];
}

function isTime(value: unknown): value is number {
  return typeof value === "number" && value >= 0 && value <= MAX_TIME_MS;
}

function timeReasons(call: StackCall, range: ReportedRange): readonly JoinReason[] {
  const { clock, ms } = call.time;
  const { window } = range;
  if (!isTime(window.startMs) || !isTime(window.endMs) || window.startMs > window.endMs) return ["time_invalid"];
  if (window.uncertaintyMs !== null && (!isTime(window.uncertaintyMs) || window.uncertaintyMs > MAX_UNCERTAINTY_MS)) return ["time_invalid"];
  if (known(clock) === null || known(window.clock) === null || ms === null) return ["time_unknown"];
  if (!isTime(ms)) return ["time_invalid"];
  // On one clock the window is what it says. Across clocks only a declared bound on their
  // difference can stand in for sharing one, and with none there is no order to speak of.
  let slack = 0;
  if (clock !== window.clock) {
    if (window.uncertaintyMs === null) return ["clock_not_shared"];
    slack = window.uncertaintyMs;
  }
  return ms >= window.startMs - slack && ms <= window.endMs + slack ? [] : ["time_outside_window"];
}

export function readExecutionJoin(call: StackCall, range: ReportedRange, inventory: SessionInventory): JoinReading {
  const reasons: JoinReason[] = [];
  if (!isSameKnown(call.attempt, range.attempt)) reasons.push("attempt_not_same");
  if (!isSameKnown(call.target, range.target)) reasons.push("target_not_same");
  if (!isSameKnown(call.frame, range.frame)) reasons.push("frame_not_same");
  if (!isSameKnown(call.loader, range.loader)) reasons.push("loader_not_same");
  if (!isSameKnown(call.attempt, inventory.attempt)) reasons.push("inventory_of_another_session");

  const identity = identityFinding(call.script, range.script, inventory.scripts);
  if (identity !== "same" && identity !== "repeated") reasons.push(identity);
  reasons.push(...positionReasons(call, range), ...timeReasons(call, range));

  if (reasons.length > 0) return { reading: "no_join", reasons: identity === "repeated" ? [...reasons, "url_repeated"] : reasons };
  return identity === "repeated" ? { reading: "ambiguous", reason: "url_repeated" } : { reading: "position_consistent" };
}

export type ClockedTime = Readonly<{ clock: string | null; ms: number }>;
export type OrderResult = Readonly<{ ok: true; order: -1 | 0 | 1 }> | Readonly<{ ok: false; refusal: "clocks-differ" | "time-invalid" }>;

/** Which of two times came first. Across clocks, or with no clock named, that is not established. */
export function orderOf(a: ClockedTime, b: ClockedTime): OrderResult {
  if (known(a.clock) === null || a.clock !== b.clock) return { ok: false, refusal: "clocks-differ" };
  if (!isTime(a.ms) || !isTime(b.ms)) return { ok: false, refusal: "time-invalid" };
  if (a.ms === b.ms) return { ok: true, order: 0 };
  return { ok: true, order: a.ms < b.ms ? -1 : 1 };
}
