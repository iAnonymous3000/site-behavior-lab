// The case and attempt machine: one pure function, step(state, event), from a state to a
// new state or a typed refusal. No I/O, no clock, no randomness and no import but the purge
// reducer, so a later exploration can walk this function itself by trying each event of a
// finite alphabet from each state it reaches. What a state holds is plain data that grows
// only with the attempts' finite counters and with evidence ids the events name.
//
// There is deliberately no list of enabled events. It would restate every guard below, so
// the two could disagree while both pass. What is enabled is what step accepts.
//
// Guards, and where each lives:
// - Slots B1 to B3 and I1 to I3, in that order. The arm is fixed by the slot at planning,
//   and no event names an arm. Attempts start in plan order, one at a time. A scenario plan
//   is a plan of one arm: no lane field separates it from a visit plan yet, and nothing here
//   needs one. The baseline rule simply does not apply to it.
// - The plan is frozen before any control, exception or visit.
// - A visit needs a control that met its written criterion for the current configuration,
//   or an exception the owner recorded for that visit before it began. An exception marks
//   the case exploratory, and nothing clears the mark. controlMet holds only whether the
//   current configuration has such a control. Once it does, no further control is taken for
//   that configuration. A failed or unevaluated one, or one from another configuration, is
//   a miss: it unlocks nothing, it is counted, and the log keeps it. A visit with both an
//   exception and a met control rests on the exception, so an exploratory visit never reads
//   as a controlled one.
// - Instrumented waits on baseline's rule: every baseline attempt ended, then the owner
//   records met or not_met. Whether a behavior reproduced is a reading of evidence, so this
//   does not decide it. It does hold the floor it can count: met needs at least two usable
//   baseline attempts under the current configuration, or all of them when fewer than two
//   were planned. Once the rule is recorded the configuration cannot change, so a rule met
//   under one configuration never lets the instrumented arm run under another. While it is
//   pending, a change is refused when the baseline slots not yet started could not reach the
//   floor under the new configuration, since that would leave met out of reach: the rule can
//   still be recorded under the one in force. not_met closes the case, and the instrumented
//   slots read not_started.
// - Unresolved cleanup blocks the next attempt and nothing else. It never changes an
//   outcome, and it never delays a cancel or a deadline.
// - A terminal attempt never reopens, and no event removes an evidence id. Evidence named
//   after an attempt ended is kept, and the record labels it late.
// - Retry counters are in the state, and each is capped. With those and the one
//   configuration change, no sequence of the capture events can return to a state. Purge is
//   the exception, by what it reads: a path read absent can read as remaining and then
//   absent again, since each is what a listing last found. Only a repeat of the same status
//   is refused. See purge.ts.
// - What only steers the next visit is cleared when the case closes, so a closed case holds
//   only what still means something. The log keeps the rest.
// - From each non-terminal state a supervisor's event is accepted: case-deadline while the
//   case is open, reconcile while cleanup is pending. Termination rests on those events
//   arriving, not on a capture responding. Whether they arrive on time is not claimed.
//
// Who acted arrives on the event as `by`, from the log entry's actor and never from a
// command's data (see case-store.ts). A runner's authority stops at its own attempt. It can
// report a capture and answer for that attempt's cleanup, and it cannot end anything by
// deadline, cancel a case, or start a visit, since it does not exist until its visit starts.
// Reporting the end of the last planned attempt does close the case, as completed, since
// nothing is left to run: that is the only close a runner reaches, and no other attempt or slot
// changes by it. A control comes only from the one control run the plan declares, and never
// from the owner.
//
// Deadlines and reconcile are the owner's for now. The log has two kinds of actor, and what
// a Durable Object's alarm acts as belongs to the batch that adds it, the same way actor.ts
// defers the runner's credential. Nothing here should be loosened to give an alarm a way in.

import { purgeStep, retentionTier, type PurgeEvent, type PurgeManifest, type PurgeRefusal, type RetentionTier } from "./purge";

export const SLOT_NAMES = ["B1", "B2", "B3", "I1", "I2", "I3"] as const;
export type SlotName = (typeof SLOT_NAMES)[number];
export type Arm = "baseline" | "instrumented";

export const OUTCOMES = ["usable", "walled", "failed", "incomplete", "timed_out", "cancelled"] as const;
export type Outcome = (typeof OUTCOMES)[number];
/** What a runner may report. The other two come only from a deadline and a cancel. */
export type ReportedOutcome = "usable" | "walled" | "failed" | "incomplete";

export type RunningPhase = "starting" | "capturing" | "finalizing";
export type AttemptPhase = "planned" | RunningPhase | Outcome | "not_started";
export type Cleanup = "pending" | "confirmed" | "unconfirmed" | "environment_destroyed";
export type ControlResult = "met" | "not_met" | "not_evaluated";
export type BaselineRule = "pending" | "met" | "not_met" | "not_applicable";
export type ClosedBy = "completed" | "cancelled" | "deadline" | "baseline_not_met";
export type VisitBasis = "control" | "exception";

/** A run and one retry. A third try needs a configuration change or an exception. */
export const MAX_CONTROL_MISSES = 2;
export const MAX_START_RETRIES = 2;
export const MAX_CONFIGURATION_CHANGES = 1;

export type AttemptState = Readonly<{
  slot: SlotName;
  arm: Arm;
  attemptId: string;
  phase: AttemptPhase;
  /** Null until the attempt begins, since nothing exists to clean up. */
  cleanup: Cleanup | null;
  /** The configuration it ran under, or the one in force when it was closed unstarted. */
  configuration: string | null;
  /** Counted only while starting, so a finished attempt carries no memory of it. */
  startRetries: number;
  /** Ids, in the order named. The rows themselves are in the evidence record. */
  evidence: readonly string[];
}>;

export type MachineState = Readonly<{
  planDigest: string | null;
  /** The one runner whose controls this case takes, declared with the plan. */
  controlRunId: string;
  configuration: string;
  configurationChanges: number;
  /** Whether this configuration has a control that met its criterion. */
  controlMet: boolean;
  /** Controls recorded for this configuration's gate that did not open it. */
  controlMisses: number;
  /** The one visit an exception is waiting for, spent when that visit begins. */
  exceptionFor: SlotName | null;
  exploratory: boolean;
  baselineRule: BaselineRule;
  closedBy: ClosedBy | null;
  attempts: readonly AttemptState[];
  /** Null until a manifest is recorded. An empty one is a manifest of nothing, which is not the same. */
  purge: PurgeManifest | null;
}>;

/** Who acted, as the log's entry says. Never a name. */
export type MachineActor = Readonly<{ kind: "owner" }> | Readonly<{ kind: "system:runner"; attemptId: string }>;

type Body =
  | Readonly<{ type: "plan-frozen"; planDigest: string }>
  | Readonly<{ type: "control-recorded"; configuration: string; result: ControlResult }>
  | Readonly<{ type: "configuration-changed"; configuration: string }>
  | Readonly<{ type: "exception-recorded"; slot: SlotName }>
  | Readonly<{ type: "baseline-rule-recorded"; result: "met" | "not_met" }>
  | Readonly<{ type: "attempt-started"; slot: SlotName }>
  | Readonly<{ type: "attempt-start-retried"; slot: SlotName }>
  | Readonly<{ type: "capture-began"; slot: SlotName }>
  | Readonly<{ type: "capture-finished"; slot: SlotName }>
  | Readonly<{ type: "attempt-finished"; slot: SlotName; outcome: ReportedOutcome }>
  | Readonly<{ type: "evidence-recorded"; slot: SlotName; id: string }>
  | Readonly<{ type: "attempt-deadline"; slot: SlotName }>
  | Readonly<{ type: "case-deadline" }>
  | Readonly<{ type: "reconcile" }>
  | Readonly<{ type: "case-cancelled" }>
  | Readonly<{ type: "cleanup-confirmed"; slot: SlotName }>
  | Readonly<{ type: "cleanup-unconfirmed"; slot: SlotName }>
  | Readonly<{ type: "environment-destroyed"; slot: SlotName }>
  | PurgeEvent;

export type MachineEvent = Body & Readonly<{ by: MachineActor }>;

export type MachineRefusal =
  | "malformed-plan"
  | "unknown-event"
  | "owner-only"
  | "runner-only"
  | "not-this-attempt"
  | "not-this-case"
  | "no-such-slot"
  | "case-closed"
  | "plan-not-frozen"
  | "plan-already-frozen"
  | "attempt-already-begun"
  | "another-attempt-running"
  | "not-next-slot"
  | "cleanup-unresolved"
  | "baseline-rule-pending"
  | "no-valid-control"
  | "control-already-met"
  | "control-limit"
  | "configuration-unchanged"
  | "configuration-change-spent"
  | "configuration-after-rule"
  | "configuration-floor-unreachable"
  | "exception-after-visit"
  | "exception-not-next"
  | "exception-pending"
  | "no-baseline"
  | "baseline-not-finished"
  | "baseline-rule-already-recorded"
  | "baseline-floor-unmet"
  | "wrong-phase"
  | "outcome-not-reachable"
  | "start-retry-limit"
  | "attempt-not-begun"
  | "evidence-duplicate"
  | "nothing-to-reconcile"
  | "no-cleanup"
  | "attempt-running"
  | "cleanup-settled"
  | PurgeRefusal;

export type StepResult = Readonly<{ ok: true; state: MachineState }> | Readonly<{ ok: false; refusal: MachineRefusal }>;

export type PlanInput = Readonly<{
  slots: readonly Readonly<{ slot: SlotName; attemptId: string }>[];
  /** The runner whose controls count. It holds no slot. */
  controlRunId: string;
  configuration: string;
}>;

function refuse(refusal: MachineRefusal): StepResult {
  return { ok: false, refusal };
}

function accept(state: MachineState): StepResult {
  return { ok: true, state };
}

function armOf(slot: SlotName): Arm {
  return slot.startsWith("B") ? "baseline" : "instrumented";
}

/** The state a plan begins in, or a refusal. Slots come in plan order, each once, and no two ids among the slots and the control run are the same. */
export function plannedState(plan: PlanInput): StepResult {
  const positions = plan.slots.map(({ slot }) => SLOT_NAMES.indexOf(slot));
  const inOrder = positions.every((position, index) => position >= 0 && (index === 0 || position > positions[index - 1]));
  const ids = new Set([plan.controlRunId, ...plan.slots.map(({ attemptId }) => attemptId)]);
  if (plan.slots.length === 0 || !inOrder || ids.size !== plan.slots.length + 1 || ids.has("") || plan.configuration === "") return refuse("malformed-plan");
  const arms = plan.slots.map(({ slot }) => armOf(slot));
  return accept({
    planDigest: null,
    controlRunId: plan.controlRunId,
    configuration: plan.configuration,
    configurationChanges: 0,
    controlMet: false,
    controlMisses: 0,
    exceptionFor: null,
    exploratory: false,
    baselineRule: arms.includes("baseline") && arms.includes("instrumented") ? "pending" : "not_applicable",
    closedBy: null,
    attempts: plan.slots.map(({ slot, attemptId }) => ({
      slot,
      arm: armOf(slot),
      attemptId,
      phase: "planned",
      cleanup: null,
      configuration: null,
      startRetries: 0,
      evidence: []
    })),
    purge: null
  });
}

export function isRunningPhase(phase: AttemptPhase): phase is RunningPhase {
  return phase === "starting" || phase === "capturing" || phase === "finalizing";
}

/** One of the six outcomes. not_started is its own thing, since no visit happened. */
export function isOutcome(phase: AttemptPhase): phase is Outcome {
  return (OUTCOMES as readonly string[]).includes(phase);
}

/** Whether the attempt's phase can never change again. */
function isSettledPhase(phase: AttemptPhase): boolean {
  return isOutcome(phase) || phase === "not_started";
}

/** Pending or unconfirmed. Absence of a confirmation blocks, and so does a known failure to get one. */
export function isCleanupUnresolved(cleanup: Cleanup | null): boolean {
  return cleanup === "pending" || cleanup === "unconfirmed";
}

/** Closed, with no cleanup still waiting on anyone. An unconfirmed one has been answered, though it can still be resolved. */
export function isTerminal(state: MachineState): boolean {
  return state.closedBy !== null && !state.attempts.some((attempt) => attempt.cleanup === "pending");
}

/**
 * Planned equals running plus every outcome plus not started, at every state. notStarted
 * counts every slot where no visit began: waiting is the part that still could, and the
 * rest were closed unstarted.
 */
export type Denominator = Readonly<{
  planned: number;
  running: number;
  notStarted: number;
  waiting: number;
  usable: number;
  walled: number;
  failed: number;
  incomplete: number;
  timed_out: number;
  cancelled: number;
}>;

export function denominatorOf(state: MachineState): Denominator {
  const count = (matches: (phase: AttemptPhase) => boolean): number => state.attempts.filter(({ phase }) => matches(phase)).length;
  return {
    planned: state.attempts.length,
    running: count(isRunningPhase),
    notStarted: count((phase) => phase === "planned" || phase === "not_started"),
    waiting: count((phase) => phase === "planned"),
    usable: count((phase) => phase === "usable"),
    walled: count((phase) => phase === "walled"),
    failed: count((phase) => phase === "failed"),
    incomplete: count((phase) => phase === "incomplete"),
    timed_out: count((phase) => phase === "timed_out"),
    cancelled: count((phase) => phase === "cancelled")
  };
}

export type Continuation =
  | Readonly<{ continuation: "allowed" }>
  | Readonly<{ continuation: "blocked"; reason: "cleanup_unresolved"; slots: readonly SlotName[] }>
  | Readonly<{ continuation: "not_applicable" }>;

/** May another attempt begin, as far as cleanup goes. It reads cleanup alone, so it is independent of every outcome. */
export function continuationOf(state: MachineState): Continuation {
  if (state.closedBy !== null) return { continuation: "not_applicable" };
  const slots = state.attempts.filter(({ cleanup }) => isCleanupUnresolved(cleanup)).map(({ slot }) => slot);
  return slots.length > 0 ? { continuation: "blocked", reason: "cleanup_unresolved", slots } : { continuation: "allowed" };
}

export function retentionOf(state: MachineState): RetentionTier {
  return retentionTier(state.purge);
}

function indexOfSlot(state: MachineState, slot: SlotName): number {
  return state.attempts.findIndex((attempt) => attempt.slot === slot);
}

function isOwner(by: MachineActor): boolean {
  return by.kind === "owner";
}

function isRunnerOf(by: MachineActor, attempt: AttemptState): boolean {
  return by.kind === "system:runner" && by.attemptId === attempt.attemptId;
}

function withAttempt(state: MachineState, index: number, change: Partial<AttemptState>): MachineState {
  return { ...state, attempts: state.attempts.map((attempt, position) => (position === index ? { ...attempt, ...change } : attempt)) };
}

/** The fields that only steer the next visit, as a closed case holds them. */
const GATE_AT_CLOSE = { controlMet: false, controlMisses: 0, exceptionFor: null } as const;

function closeIfDone(state: MachineState): MachineState {
  return state.closedBy === null && state.attempts.every(({ phase }) => isSettledPhase(phase)) ? { ...state, ...GATE_AT_CLOSE, closedBy: "completed" } : state;
}

function finish(state: MachineState, index: number, phase: Outcome): StepResult {
  return accept(closeIfDone(withAttempt(state, index, { phase, startRetries: 0 })));
}

/** Close now, whatever cleanup is doing: the running attempt takes this outcome, and every slot still waiting never begins. */
function closeWith(state: MachineState, runningOutcome: Outcome, closedBy: ClosedBy): MachineState {
  return {
    ...state,
    ...GATE_AT_CLOSE,
    closedBy,
    attempts: state.attempts.map((attempt) => {
      if (isRunningPhase(attempt.phase)) return { ...attempt, phase: runningOutcome, startRetries: 0 };
      if (attempt.phase === "planned") return { ...attempt, phase: "not_started", configuration: state.configuration };
      return attempt;
    })
  };
}

/** What the next visit would rest on as things stand, or null when nothing covers it. An exception for that visit comes first, so an exploratory visit never reads as controlled. */
export function visitBasisOf(state: MachineState, slot: SlotName): VisitBasis | null {
  if (state.exceptionFor === slot) return "exception";
  return state.controlMet ? "control" : null;
}

function planFrozen(state: MachineState, event: Extract<MachineEvent, { type: "plan-frozen" }>): StepResult {
  if (!isOwner(event.by)) return refuse("owner-only");
  if (state.closedBy !== null) return refuse("case-closed");
  if (state.planDigest !== null) return refuse("plan-already-frozen");
  return accept({ ...state, planDigest: event.planDigest });
}

function controlRecorded(state: MachineState, event: Extract<MachineEvent, { type: "control-recorded" }>): StepResult {
  if (event.by.kind !== "system:runner") return refuse("runner-only");
  if (event.by.attemptId !== state.controlRunId) return refuse("not-this-case");
  if (state.closedBy !== null) return refuse("case-closed");
  if (state.planDigest === null) return refuse("plan-not-frozen");
  if (state.attempts.some(({ phase }) => isRunningPhase(phase))) return refuse("another-attempt-running");
  if (state.controlMet) return refuse("control-already-met");
  if (state.controlMisses >= MAX_CONTROL_MISSES) return refuse("control-limit");
  const controlMet = event.configuration === state.configuration && event.result === "met";
  return accept(controlMet ? { ...state, controlMet, controlMisses: 0 } : { ...state, controlMisses: state.controlMisses + 1 });
}

/** Usable attempts the rule's met needs: two, or all of the baseline when fewer were planned. */
function baselineFloor(baseline: readonly AttemptState[]): number {
  return Math.min(2, baseline.length);
}

function configurationChanged(state: MachineState, event: Extract<MachineEvent, { type: "configuration-changed" }>): StepResult {
  if (!isOwner(event.by)) return refuse("owner-only");
  if (state.closedBy !== null) return refuse("case-closed");
  if (state.planDigest === null) return refuse("plan-not-frozen");
  if (state.attempts.some(({ phase }) => isRunningPhase(phase))) return refuse("another-attempt-running");
  if (state.baselineRule === "met") return refuse("configuration-after-rule");
  if (state.configurationChanges >= MAX_CONFIGURATION_CHANGES) return refuse("configuration-change-spent");
  if (event.configuration === state.configuration) return refuse("configuration-unchanged");
  if (state.baselineRule === "pending") {
    // Only what has not started yet can still run under the new one.
    const baseline = state.attempts.filter(({ arm }) => arm === "baseline");
    if (baseline.filter(({ phase }) => phase === "planned").length < baselineFloor(baseline)) return refuse("configuration-floor-unreachable");
  }
  return accept({
    ...state,
    configuration: event.configuration,
    configurationChanges: state.configurationChanges + 1,
    controlMet: false,
    controlMisses: 0,
    exceptionFor: null
  });
}

function exceptionRecorded(state: MachineState, event: Extract<MachineEvent, { type: "exception-recorded" }>): StepResult {
  if (!isOwner(event.by)) return refuse("owner-only");
  const index = indexOfSlot(state, event.slot);
  if (index < 0) return refuse("no-such-slot");
  if (state.closedBy !== null) return refuse("case-closed");
  if (state.planDigest === null) return refuse("plan-not-frozen");
  if (state.attempts[index].phase !== "planned") return refuse("exception-after-visit");
  if (state.exceptionFor !== null) return refuse("exception-pending");
  if (state.attempts.findIndex(({ phase }) => phase === "planned") !== index) return refuse("exception-not-next");
  return accept({ ...state, exceptionFor: event.slot, exploratory: true });
}

function baselineRuleRecorded(state: MachineState, event: Extract<MachineEvent, { type: "baseline-rule-recorded" }>): StepResult {
  if (!isOwner(event.by)) return refuse("owner-only");
  if (state.closedBy !== null) return refuse("case-closed");
  if (state.baselineRule === "not_applicable") return refuse("no-baseline");
  if (state.baselineRule !== "pending") return refuse("baseline-rule-already-recorded");
  const baseline = state.attempts.filter(({ arm }) => arm === "baseline");
  if (!baseline.every(({ phase }) => isSettledPhase(phase))) return refuse("baseline-not-finished");
  if (event.result === "not_met") return accept(closeWith({ ...state, baselineRule: "not_met" }, "failed", "baseline_not_met"));
  const usable = baseline.filter(({ phase, configuration }) => phase === "usable" && configuration === state.configuration).length;
  if (usable < baselineFloor(baseline)) return refuse("baseline-floor-unmet");
  return accept({ ...state, baselineRule: "met" });
}

function attemptStarted(state: MachineState, event: Extract<MachineEvent, { type: "attempt-started" }>): StepResult {
  if (!isOwner(event.by)) return refuse("owner-only");
  const index = indexOfSlot(state, event.slot);
  if (index < 0) return refuse("no-such-slot");
  const attempt = state.attempts[index];
  if (state.closedBy !== null) return refuse("case-closed");
  if (state.planDigest === null) return refuse("plan-not-frozen");
  if (attempt.phase !== "planned") return refuse("attempt-already-begun");
  if (state.attempts.some(({ phase }) => isRunningPhase(phase))) return refuse("another-attempt-running");
  if (state.attempts.findIndex(({ phase }) => phase === "planned") !== index) return refuse("not-next-slot");
  if (state.attempts.some(({ cleanup }) => isCleanupUnresolved(cleanup))) return refuse("cleanup-unresolved");
  if (attempt.arm === "instrumented" && state.baselineRule === "pending") return refuse("baseline-rule-pending");
  if (visitBasisOf(state, event.slot) === null) return refuse("no-valid-control");
  const started = withAttempt(state, index, { phase: "starting", cleanup: "pending", configuration: state.configuration });
  return accept({ ...started, exceptionFor: null });
}

/** The attempt's own runner, in one of the phases given. Everything a runner reports comes through here. */
function runnerEvent(state: MachineState, by: MachineActor, slot: SlotName): Readonly<{ index: number; attempt: AttemptState }> | MachineRefusal {
  const index = indexOfSlot(state, slot);
  if (index < 0) return "no-such-slot";
  if (!isRunnerOf(by, state.attempts[index])) return "not-this-attempt";
  return { index, attempt: state.attempts[index] };
}

function attemptStartRetried(state: MachineState, event: Extract<MachineEvent, { type: "attempt-start-retried" }>): StepResult {
  const found = runnerEvent(state, event.by, event.slot);
  if (typeof found === "string") return refuse(found);
  if (found.attempt.phase !== "starting") return refuse("wrong-phase");
  if (found.attempt.startRetries >= MAX_START_RETRIES) return refuse("start-retry-limit");
  return accept(withAttempt(state, found.index, { startRetries: found.attempt.startRetries + 1 }));
}

function captureBegan(state: MachineState, event: Extract<MachineEvent, { type: "capture-began" }>): StepResult {
  const found = runnerEvent(state, event.by, event.slot);
  if (typeof found === "string") return refuse(found);
  if (found.attempt.phase !== "starting") return refuse("wrong-phase");
  return accept(withAttempt(state, found.index, { phase: "capturing", startRetries: 0 }));
}

function captureFinished(state: MachineState, event: Extract<MachineEvent, { type: "capture-finished" }>): StepResult {
  const found = runnerEvent(state, event.by, event.slot);
  if (typeof found === "string") return refuse(found);
  if (found.attempt.phase !== "capturing") return refuse("wrong-phase");
  return accept(withAttempt(state, found.index, { phase: "finalizing" }));
}

const REPORTABLE: Readonly<Record<RunningPhase, readonly ReportedOutcome[]>> = {
  starting: ["failed"],
  capturing: ["failed", "walled"],
  finalizing: ["usable", "incomplete", "walled", "failed"]
};

function attemptFinished(state: MachineState, event: Extract<MachineEvent, { type: "attempt-finished" }>): StepResult {
  const found = runnerEvent(state, event.by, event.slot);
  if (typeof found === "string") return refuse(found);
  const { phase } = found.attempt;
  if (!isRunningPhase(phase)) return refuse("wrong-phase");
  if (!REPORTABLE[phase].includes(event.outcome)) return refuse("outcome-not-reachable");
  return finish(state, found.index, event.outcome);
}

function evidenceRecorded(state: MachineState, event: Extract<MachineEvent, { type: "evidence-recorded" }>): StepResult {
  const found = runnerEvent(state, event.by, event.slot);
  if (typeof found === "string") return refuse(found);
  const { phase } = found.attempt;
  if (phase === "planned" || phase === "not_started") return refuse("attempt-not-begun");
  if (state.attempts.some(({ evidence }) => evidence.includes(event.id))) return refuse("evidence-duplicate");
  return accept(withAttempt(state, found.index, { evidence: [...found.attempt.evidence, event.id] }));
}

function attemptDeadline(state: MachineState, event: Extract<MachineEvent, { type: "attempt-deadline" }>): StepResult {
  if (!isOwner(event.by)) return refuse("owner-only");
  const index = indexOfSlot(state, event.slot);
  if (index < 0) return refuse("no-such-slot");
  if (!isRunningPhase(state.attempts[index].phase)) return refuse("wrong-phase");
  return finish(state, index, "timed_out");
}

function caseDeadline(state: MachineState, event: Extract<MachineEvent, { type: "case-deadline" }>): StepResult {
  if (!isOwner(event.by)) return refuse("owner-only");
  if (state.closedBy !== null) return refuse("case-closed");
  return accept(closeWith(state, "timed_out", "deadline"));
}

function caseCancelled(state: MachineState, event: Extract<MachineEvent, { type: "case-cancelled" }>): StepResult {
  if (!isOwner(event.by)) return refuse("owner-only");
  if (state.closedBy !== null) return refuse("case-closed");
  return accept(closeWith(state, "cancelled", "cancelled"));
}

/**
 * The supervisor's look at what the platform holds. A running attempt that reached this
 * has no runner left to report: it failed, and nothing confirmed its cleanup. With nothing
 * running, cleanup still pending has gone unanswered and reads unconfirmed.
 */
function reconcile(state: MachineState, event: Extract<MachineEvent, { type: "reconcile" }>): StepResult {
  if (!isOwner(event.by)) return refuse("owner-only");
  const running = state.attempts.findIndex(({ phase }) => isRunningPhase(phase));
  if (running >= 0) return accept(closeIfDone(withAttempt(state, running, { phase: "failed", cleanup: "unconfirmed", startRetries: 0 })));
  if (!state.attempts.some(({ cleanup }) => cleanup === "pending")) return refuse("nothing-to-reconcile");
  return accept({ ...state, attempts: state.attempts.map((attempt) => (attempt.cleanup === "pending" ? { ...attempt, cleanup: "unconfirmed" } : attempt)) });
}

/** The owner's, or that attempt's own runner's. Another attempt's runner cannot clear what is blocking it. */
function cleanupEvent(state: MachineState, event: Extract<MachineEvent, { type: "cleanup-confirmed" | "cleanup-unconfirmed" | "environment-destroyed" }>): StepResult {
  const index = indexOfSlot(state, event.slot);
  if (index < 0) return refuse("no-such-slot");
  const attempt = state.attempts[index];
  if (!isOwner(event.by) && !isRunnerOf(event.by, attempt)) return refuse("not-this-attempt");
  if (attempt.cleanup === null) return refuse("no-cleanup");
  if (isRunningPhase(attempt.phase)) return refuse("attempt-running");
  if (attempt.cleanup === "confirmed" || attempt.cleanup === "environment_destroyed") return refuse("cleanup-settled");
  if (event.type === "cleanup-unconfirmed") {
    if (attempt.cleanup === "unconfirmed") return refuse("cleanup-settled");
    return accept(withAttempt(state, index, { cleanup: "unconfirmed" }));
  }
  return accept(withAttempt(state, index, { cleanup: event.type === "cleanup-confirmed" ? "confirmed" : "environment_destroyed" }));
}

function purgeEvent(state: MachineState, event: PurgeEvent & Readonly<{ by: MachineActor }>): StepResult {
  if (!isOwner(event.by)) return refuse("owner-only");
  const result = purgeStep(state.closedBy !== null, state.purge, event);
  return result.ok ? accept({ ...state, purge: result.manifest }) : refuse(result.refusal);
}

export function step(state: MachineState, event: MachineEvent): StepResult {
  switch (event.type) {
    case "plan-frozen":
      return planFrozen(state, event);
    case "control-recorded":
      return controlRecorded(state, event);
    case "configuration-changed":
      return configurationChanged(state, event);
    case "exception-recorded":
      return exceptionRecorded(state, event);
    case "baseline-rule-recorded":
      return baselineRuleRecorded(state, event);
    case "attempt-started":
      return attemptStarted(state, event);
    case "attempt-start-retried":
      return attemptStartRetried(state, event);
    case "capture-began":
      return captureBegan(state, event);
    case "capture-finished":
      return captureFinished(state, event);
    case "attempt-finished":
      return attemptFinished(state, event);
    case "evidence-recorded":
      return evidenceRecorded(state, event);
    case "attempt-deadline":
      return attemptDeadline(state, event);
    case "case-deadline":
      return caseDeadline(state, event);
    case "case-cancelled":
      return caseCancelled(state, event);
    case "reconcile":
      return reconcile(state, event);
    case "cleanup-confirmed":
    case "cleanup-unconfirmed":
    case "environment-destroyed":
      return cleanupEvent(state, event);
    case "purge-manifest-recorded":
    case "purge-path-absent":
    case "purge-path-remains":
      return purgeEvent(state, event);
    default:
      return refuse("unknown-event");
  }
}
