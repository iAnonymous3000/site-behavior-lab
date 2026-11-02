import assert from "node:assert/strict";
import { Counterexample, holds, loadVariant, type SourceEdit } from "../../lib/finite-check";
import type { Actor } from "../core/actor";
import { configurationKey, decodeEvent, digestsNamed, type ConfigurationIdentity } from "../core/case-events";
import type { LogEvent } from "../core/case-log";
import * as productionMachine from "../core/case-machine";
import { SLOT_NAMES, type AttemptPhase, type AttemptState, type Cleanup, type MachineActor, type MachineEvent, type MachineState, type PlanInput, type SlotName, type StepResult } from "../core/case-machine";
import * as productionStore from "../core/case-store";
import type { CaseState } from "../core/case-store";
import * as productionEvidence from "../core/evidence-model";
import type { EvidenceRecord as EvidenceRecordType, RecordEvent } from "../core/evidence-model";
import * as productionPurge from "../core/purge";
import type { ManifestPath, PathState, PurgeEvent, PurgeManifest } from "../core/purge";
import { ATTEMPT_IDS, CONFIG_A, CONFIG_B, CONTROL_RUN_ID, CONTROL_RUNNER, FOREIGN_RUN_ID, FOREIGN_RUNNER, IDENTITY_ALDER, OWNER, PLAN_DIGEST, runnerOf, type MachineModule } from "./case-fixture";

/**
 * The walks behind case-exploration.test.ts, kept apart so that a worker thread can load them: the
 * machine's key, alphabet, shadow, restated rules and per-state checks; the purge slice; and the
 * fold's instances, alphabet, key, shadow and walk. The properties, their domains and the table are
 * in that suite's docblock. Nothing here registers a test.
 */

export type EvidenceModule = typeof productionEvidence;
export type PurgeModule = typeof productionPurge;
export type StoreModule = typeof productionStore;
export type Accepted = Extract<StepResult, { ok: true }>;

export const machineVariant = (...edits: SourceEdit[]) => loadVariant<MachineModule>(require.resolve("../core/case-machine"), edits);
export const evidenceVariant = (...edits: SourceEdit[]) => loadVariant<EvidenceModule>(require.resolve("../core/evidence-model"), edits);
export const purgeVariant = (...edits: SourceEdit[]) => loadVariant<PurgeModule>(require.resolve("../core/purge"), edits);
export const storeVariant = (...edits: SourceEdit[]) => loadVariant<StoreModule>(require.resolve("../core/case-store"), edits);

// ---------------------------------------------------------------------------------------------
// The machine.
// ---------------------------------------------------------------------------------------------

export const M = {
  domain: "every state the walk reaches lies inside the domain its key encodes",
  guard: "each event is accepted exactly when the rule W2 states for it holds",
  effect: "an accepted event changes exactly the fields W2's rule for it names, to the values it names",
  caps: "retry counters are what the accepted events count, and stay within their caps",
  gate: "the gate and the rule hold what the accepted events made them, and a closed case keeps no gate",
  closed: "a case is closed exactly when no slot is planned or running, and a slot closed unstarted carries the configuration in force",
  closedStays: "a closed case never reopens: its closure never changes, and nothing but cleanup changes after it",
  ruleFixed: "the baseline rule, once recorded, never changes",
  cleanup: "cleanup changes only by the events that name it, and reconcile reads what it states",
  ranUnder: "a begun attempt ran under the configuration in force when it began, and that never changes",
  agreeDenominator: "denominatorOf agrees with the phases",
  agreeTerminal: "isTerminal agrees with closed and no cleanup pending",
  agreeContinuation: "continuationOf agrees with an open case and its unresolved cleanup",
  oneRuns: "at most one attempt runs",
  arm: "an arm never changes",
  waits: "instrumented waits on baseline's rule, and begins under the configuration it was met under",
  terminalStays: "a terminal attempt never reopens",
  blocks: "continuation blocks on unresolved cleanup",
  acquisition: "unresolved cleanup changes no acquisition",
  purgeSlice: "a purge answers as the restated reducer does on the closed flag and the manifest, and changes nothing else, and nothing else reads the manifest",
  authority: "an event from an actor the rule does not allow is refused",
  interchangeable: "the actors a rule allows get the same answer",
  control: "a visit begins only on a met control for the configuration in force, or on the owner's exception for it",
  exceptionFirst: "an exception is recorded only for a visit that has not begun",
  mark: "the exploratory mark is on exactly when an exception was recorded",
  acyclic: "without the purge slice, no event returns to a state",
  sinks: "every sink is terminal",
  supervisor: "a supervisor's event is accepted from every non-terminal state"
} as const;

/** The caps, restated as this file's bounds. A test below pins production's constants to them. */
export const CAP = { controlMisses: 2, startRetries: 2, configurationChanges: 1 } as const;

export const PHASES: readonly AttemptPhase[] = ["planned", "starting", "capturing", "finalizing", "usable", "walled", "failed", "incomplete", "timed_out", "cancelled", "not_started"];
export const RUNNING = new Set<AttemptPhase>(["starting", "capturing", "finalizing"]);
export const OUTCOME = new Set<AttemptPhase>(["usable", "walled", "failed", "incomplete", "timed_out", "cancelled"]);
export const NOT_BEGUN = new Set<AttemptPhase>(["planned", "not_started"]);
export const CLEANUPS: readonly (Cleanup | null)[] = [null, "pending", "confirmed", "unconfirmed", "environment_destroyed"];
export const UNRESOLVED = new Set<Cleanup | null>(["pending", "unconfirmed"]);
export const CLEANUP_EVENTS = new Set(["cleanup-confirmed", "cleanup-unconfirmed", "environment-destroyed"]);
export const RULES: readonly MachineState["baselineRule"][] = ["pending", "met", "not_met", "not_applicable"];
export const CLOSURES: readonly MachineState["closedBy"][] = [null, "completed", "cancelled", "deadline", "baseline_not_met"];
export const EXCEPTION_SLOTS: readonly (SlotName | null)[] = [null, ...SLOT_NAMES];
export const CASE_CONFIGS: readonly string[] = [CONFIG_A, CONFIG_B];
export const ATTEMPT_CONFIGS: readonly (string | null)[] = [null, CONFIG_A, CONFIG_B];
export const STATE_KEYS = 12;
export const ATTEMPT_KEYS = 8;
export const PURGE_PATHS = ["01".repeat(32), "02".repeat(32), "03".repeat(32)] as const;

export type PlanContext = Readonly<{
  plan: PlanInput;
  slots: readonly SlotName[];
  ids: readonly string[];
  arms: readonly AttemptState["arm"][];
  bothArms: boolean;
  /** Usable baseline attempts the rule's met needs, as the plan states it: two, or all when fewer were planned. */
  floor: number;
}>;

export function contextOf(plan: PlanInput): PlanContext {
  const slots = plan.slots.map(({ slot }) => slot);
  const arms = slots.map((slot) => (slot.startsWith("B") ? "baseline" : "instrumented") as AttemptState["arm"]);
  const baseline = arms.filter((arm) => arm === "baseline").length;
  return { plan, slots, ids: plan.slots.map(({ attemptId }) => attemptId), arms, bothArms: baseline > 0 && baseline < arms.length, floor: Math.min(2, baseline) };
}

export const isCount = (value: unknown, max: number): boolean => Number.isInteger(value) && (value as number) >= 0 && (value as number) <= max;

/**
 * A state as a few characters: one for the case's fields and one per attempt. Every field the key
 * does not hold is held to its constant here, on the state step returned and before it is encoded,
 * so nothing the key rebuilds from constants can hide a change. The caps come first, by name.
 */
export function machineCodec(context: PlanContext) {
  // Each check below builds its counterexample only when it fails: the key is made for every state and edge, so it stays cheap.
  const index = <T>(values: readonly T[], value: T, field: string, state: unknown): number => {
    const found = values.indexOf(value);
    if (found < 0) holds(M.domain, false, () => ({ field, value, state }));
    return found;
  };
  const atoms: AttemptState[][] = context.slots.map((slot, position) => {
    const row: AttemptState[] = [];
    for (const phase of PHASES)
      for (const cleanup of CLEANUPS)
        for (const configuration of ATTEMPT_CONFIGS)
          for (let startRetries = 0; startRetries <= CAP.startRetries; startRetries += 1) {
            row.push(Object.freeze({ slot, arm: context.arms[position], attemptId: context.ids[position], phase, cleanup, configuration, startRetries, evidence: Object.freeze([]) as readonly string[] }));
          }
    return row;
  });
  const encode = (state: MachineState, maskCleanup = false): string => {
    if (!(isCount(state.controlMisses, CAP.controlMisses) && isCount(state.configurationChanges, CAP.configurationChanges) && state.attempts.every(({ startRetries }) => isCount(startRetries, CAP.startRetries)))) holds(M.caps, false, () => state);
    if (!(Object.keys(state).length === STATE_KEYS && state.controlRunId === context.plan.controlRunId && state.purge === null && state.attempts.length === context.slots.length)) holds(M.domain, false, () => state);
    let global = index([null, PLAN_DIGEST], state.planDigest, "planDigest", state);
    global = global * 2 + index(CASE_CONFIGS, state.configuration, "configuration", state);
    global = global * 2 + state.configurationChanges;
    global = global * 2 + index([false, true], state.controlMet, "controlMet", state);
    global = global * 3 + state.controlMisses;
    global = global * 7 + index(EXCEPTION_SLOTS, state.exceptionFor, "exceptionFor", state);
    global = global * 2 + index([false, true], state.exploratory, "exploratory", state);
    global = global * 4 + index(RULES, state.baselineRule, "baselineRule", state);
    global = global * 5 + index(CLOSURES, state.closedBy, "closedBy", state);
    let key = String.fromCharCode(global);
    for (let position = 0; position < state.attempts.length; position += 1) {
      const attempt = state.attempts[position];
      if (!(Object.keys(attempt).length === ATTEMPT_KEYS && attempt.slot === context.slots[position] && attempt.arm === context.arms[position] && attempt.attemptId === context.ids[position] && Array.isArray(attempt.evidence) && attempt.evidence.length === 0)) {
        holds(M.domain, false, () => ({ position, attempt }));
      }
      const cleanup = maskCleanup ? 0 : index(CLEANUPS, attempt.cleanup, "cleanup", attempt);
      key += String.fromCharCode(((index(PHASES, attempt.phase, "phase", attempt) * 5 + cleanup) * 3 + index(ATTEMPT_CONFIGS, attempt.configuration, "attempt configuration", attempt)) * 3 + attempt.startRetries);
    }
    return key;
  };
  const decode = (key: string): MachineState => {
    let global = key.charCodeAt(0);
    const take = (base: number): number => {
      const digit = global % base;
      global = (global - digit) / base;
      return digit;
    };
    const closedBy = CLOSURES[take(5)];
    const baselineRule = RULES[take(4)];
    const exploratory = take(2) === 1;
    const exceptionFor = EXCEPTION_SLOTS[take(7)];
    const controlMisses = take(3);
    const controlMet = take(2) === 1;
    const configurationChanges = take(2);
    const configuration = CASE_CONFIGS[take(2)];
    const planDigest = take(2) === 0 ? null : PLAN_DIGEST;
    const attempts: AttemptState[] = [];
    for (let position = 0; position < context.slots.length; position += 1) attempts.push(atoms[position][key.charCodeAt(position + 1)]);
    return { planDigest, controlRunId: context.plan.controlRunId, configuration, configurationChanges, controlMet, controlMisses, exceptionFor, exploratory, baselineRule, closedBy, attempts, purge: null };
  };
  return { encode, decode };
}

/** Each event from the actor its rule names: 92 for the six-slot plan, as the earlier sizing used. */
export function machineAlphabet(plan: PlanInput): readonly MachineEvent[] {
  const events: MachineEvent[] = [
    { type: "plan-frozen", planDigest: PLAN_DIGEST, by: OWNER },
    { type: "configuration-changed", configuration: CONFIG_A, by: OWNER },
    { type: "configuration-changed", configuration: CONFIG_B, by: OWNER },
    { type: "baseline-rule-recorded", result: "met", by: OWNER },
    { type: "baseline-rule-recorded", result: "not_met", by: OWNER },
    { type: "case-deadline", by: OWNER },
    { type: "case-cancelled", by: OWNER },
    { type: "reconcile", by: OWNER }
  ];
  for (const configuration of [CONFIG_A, CONFIG_B]) for (const result of ["met", "not_met", "not_evaluated"] as const) events.push({ type: "control-recorded", configuration, result, by: CONTROL_RUNNER });
  for (const { slot } of plan.slots) {
    const by = runnerOf(slot);
    events.push(
      { type: "exception-recorded", slot, by: OWNER },
      { type: "attempt-started", slot, by: OWNER },
      { type: "attempt-start-retried", slot, by },
      { type: "capture-began", slot, by },
      { type: "capture-finished", slot, by },
      { type: "attempt-deadline", slot, by: OWNER },
      { type: "cleanup-confirmed", slot, by: OWNER },
      { type: "cleanup-unconfirmed", slot, by: OWNER },
      { type: "environment-destroyed", slot, by: OWNER }
    );
    for (const outcome of ["usable", "walled", "failed", "incomplete"] as const) events.push({ type: "attempt-finished", slot, outcome, by });
  }
  return events;
}

export const ACTORS: readonly MachineActor[] = [OWNER, CONTROL_RUNNER, FOREIGN_RUNNER, ...SLOT_NAMES.map(runnerOf)];
export const OWNER_ONLY = new Set(["plan-frozen", "configuration-changed", "exception-recorded", "baseline-rule-recorded", "attempt-started", "attempt-deadline", "case-deadline", "case-cancelled", "reconcile", "purge-manifest-recorded", "purge-path-absent", "purge-path-remains"]);
export const OWN_RUNNER = new Set(["attempt-start-retried", "capture-began", "capture-finished", "attempt-finished", "evidence-recorded"]);

/** The rule the plan states, written out here: who may send each kind of event. */
export function allowedFor(context: PlanContext, type: string, slot: SlotName | null, by: MachineActor): boolean {
  if (type === "control-recorded") return by.kind === "system:runner" && by.attemptId === context.plan.controlRunId;
  if (OWNER_ONLY.has(type)) return by.kind === "owner";
  const own = slot !== null && by.kind === "system:runner" && by.attemptId === context.ids[context.slots.indexOf(slot)];
  if (OWN_RUNNER.has(type)) return own;
  if (CLEANUP_EVENTS.has(type)) return by.kind === "owner" || own;
  throw new Error(`No authority rule for ${type}`);
}

export const slotOf = (event: { readonly slot?: SlotName }): SlotName | null => event.slot ?? null;

/** Every body of the alphabet, plus a row and the three purge bodies, from every actor the rule does not allow. */
export function authorityProbes(context: PlanContext, alphabet: readonly MachineEvent[]): readonly MachineEvent[] {
  type Body = Readonly<{ type: string; slot?: SlotName }>;
  const bodies: Body[] = [
    ...alphabet.map(({ by: _by, ...body }) => body as Body),
    ...context.slots.map((slot) => ({ type: "evidence-recorded", slot, id: "row-probe" })),
    { type: "purge-manifest-recorded", paths: [PURGE_PATHS[0]] } as Body,
    { type: "purge-path-absent", path: PURGE_PATHS[0] } as Body,
    { type: "purge-path-remains", path: PURGE_PATHS[0] } as Body
  ];
  const probes: MachineEvent[] = [];
  for (const body of bodies) for (const by of ACTORS) if (!allowedFor(context, body.type, slotOf(body), by)) probes.push({ ...body, by } as unknown as MachineEvent);
  return probes;
}

/** Each cleanup event as the alphabet sends it, from the owner, beside the same event from the attempt's own runner. */
export function cleanupPairs(alphabet: readonly MachineEvent[]): readonly (readonly [number, MachineEvent])[] {
  const pairs: [number, MachineEvent][] = [];
  alphabet.forEach((event, at) => {
    if (CLEANUP_EVENTS.has(event.type)) pairs.push([at, { ...event, by: runnerOf((event as { slot: SlotName }).slot) }]);
  });
  return pairs;
}

export type RecordProbe = Readonly<{ event: RecordEvent; by: MachineActor }>;

export function recordProbes(context: PlanContext): readonly RecordProbe[] {
  const owned: readonly RecordEvent[] = [
    { type: "assertion-recorded", id: "said-probe", statement: "Someone said so." },
    { type: "unknown-recorded", unknown: { id: "question-probe", question: "What?", reason: "Nothing showed.", detail: null, wouldResolve: null } },
    { type: "source-reconstructed", appliesTo: [context.slots[0]], baseCommit: "ca".repeat(20), patchDigest: "ab".repeat(32), identity: "9a".repeat(32) }
  ];
  const probes: RecordProbe[] = [];
  for (const event of owned) for (const by of ACTORS) if (by.kind !== "owner") probes.push({ event, by });
  for (const slot of context.slots) {
    const own = context.ids[context.slots.indexOf(slot)];
    for (const event of [
      { type: "instrument-recorded", slot, instrument: "coverage", completeness: "complete", reason: null },
      { type: "source-recorded", slot, commit: "c0".repeat(20), identity: "9b".repeat(32) }
    ] as const) {
      for (const by of ACTORS) if (!(by.kind === "system:runner" && by.attemptId === own)) probes.push({ event, by });
    }
  }
  return probes;
}

/** A record holding one present row per slot, so authority is also probed where rows exist. */
export function recordWithRows(context: PlanContext): EvidenceRecordType {
  return {
    ...productionEvidence.EMPTY_RECORD,
    rows: context.slots.map((slot) => ({ id: `row-probe-${slot.toLowerCase()}`, slot, instrument: "coverage", state: "present", window: { clock: "page", startMs: 1, endMs: 2 }, limits: [], digest: "cd".repeat(32), observation: null }))
  };
}

/**
 * The shadow: the case's bookkeeping as the accepted events make it, kept here from their bodies
 * and never read from production. The configuration in force (0 alder, 1 birch) and how many
 * changes were taken; whether a control from the declared run met its criterion for that
 * configuration since it came into force, and how many missed; the slot an exception was recorded
 * for since then that has not yet begun (0 none, else 1 plus its index in SLOT_NAMES); whether any
 * exception was ever recorded; the rule (RULES' order) and the configuration it was met under. It
 * travels in the key. M.gate, M.caps and M.mark hold production's own fields equal to it on every
 * state, which is the check that the two agree; that it splits no state is the pin beside it.
 *
 * A configuration change spends a pending exception, as it spends a met control and the misses
 * (case-machine.ts configurationChanged). The plan's text does not say so. This is W2's ruling, kept
 * by the owner for F5, for this reason: an exception is a deviation recorded for the configuration in
 * force, as a control must be valid for the configuration in force, so a new configuration needs its
 * own. A shadow that kept the exception would claim less, and splits 80 states of the six-slot walk
 * and 880 of each scenario plan.
 */
export type Shadow = { config: number; changes: number; met: number; misses: number; except: number; ever: number; rule: number; ruleConfig: number };

/**
 * Each field is held to its range as it is packed. Only a machine that takes more than its caps can
 * push one past it, and then the caps catch that machine by name; without this a variant run with
 * the caps' check off would count forever in the shadow.
 */
export const packShadow = (h: Shadow): number => {
  const misses = Math.min(h.misses, CAP.controlMisses);
  const changes = Math.min(h.changes, CAP.configurationChanges);
  return ((((((h.config * 2 + changes) * 2 + h.met) * 3 + misses) * 7 + h.except) * 2 + h.ever) * 4 + h.rule) * 2 + h.ruleConfig;
};

export function unpackShadow(packed: number): Shadow {
  let rest = packed;
  const take = (base: number): number => {
    const digit = rest % base;
    rest = (rest - digit) / base;
    return digit;
  };
  const ruleConfig = take(2);
  const rule = take(4);
  const ever = take(2);
  const except = take(7);
  const misses = take(3);
  const met = take(2);
  const changes = take(2);
  return { config: rest, changes, met, misses, except, ever, rule, ruleConfig };
}

export const RULE_PENDING = 0;
export const RULE_MET = 1;
export const RULE_NOT_APPLICABLE = 3;

/** What a state shows that more than one rule reads, read once per state. */
export type Facts = Readonly<{ closed: boolean; frozen: boolean; running: number; next: number; unresolved: boolean; pending: boolean; plannedBaseline: number; baselineSettled: boolean; inForce: string }>;

export function factsOf(context: PlanContext, state: MachineState, shadow: Shadow): Facts {
  let running = -1;
  let next = -1;
  let unresolved = false;
  let pending = false;
  let plannedBaseline = 0;
  let baselineSettled = true;
  state.attempts.forEach((attempt, at) => {
    if (RUNNING.has(attempt.phase)) running = at;
    if (attempt.phase === "planned" && next < 0) next = at;
    if (UNRESOLVED.has(attempt.cleanup)) unresolved = true;
    if (attempt.cleanup === "pending") pending = true;
    if (context.arms[at] === "baseline") {
      if (attempt.phase === "planned") plannedBaseline += 1;
      if (!(OUTCOME.has(attempt.phase) || attempt.phase === "not_started")) baselineSettled = false;
    }
  });
  return { closed: state.closedBy !== null, frozen: state.planDigest !== null, running, next, unresolved, pending, plannedBaseline, baselineSettled, inForce: CASE_CONFIGS[shadow.config] };
}

export const REPORTABLE: Readonly<Record<string, readonly string[]>> = { starting: ["failed"], capturing: ["failed", "walled"], finalizing: ["usable", "incomplete", "walled", "failed"] };

/**
 * Whether W2's stated rule takes this event here. This RESTATES W2's rules on purpose, as
 * case-machine-walk.test.ts's model does for small plans, and names where each is stated: the
 * header of case-machine.ts (H), W2's commit 3fef1027 (W), a comment in case-machine.ts named by
 * its line at this commit, or, where no comment states it, the function's code ("code only"). It reads the state's primary facts and the shadow, never production's bookkeeping
 * or a production predicate, and it says nothing of refusal reasons or their order. Every event in
 * the alphabet comes from the actor its rule names, so who sent it is held apart, by M.authority.
 */
export function guardOf(context: PlanContext, state: MachineState, h: Shadow, facts: Facts, event: MachineEvent): boolean {
  const at = "slot" in event ? context.slots.indexOf(event.slot) : -1;
  const attempt = at >= 0 ? state.attempts[at] : null;
  switch (event.type) {
    case "plan-frozen": // H: the plan is frozen before any control, exception or visit; once.
      return !facts.closed && !facts.frozen;
    case "control-recorded": // H: once met, no further control for that configuration; a miss is counted. case-machine.ts:81 (MAX_CONTROL_MISSES): a run and one retry. Code only: not while an attempt runs.
      return !facts.closed && facts.frozen && facts.running < 0 && h.met === 0 && h.misses < CAP.controlMisses;
    case "configuration-changed": // H: once the rule is met the configuration cannot change; while pending, a change the remaining baseline cannot meet is refused; one change. Code only: not to the same, not while running.
      return !facts.closed && facts.frozen && facts.running < 0 && h.rule !== RULE_MET && h.changes < CAP.configurationChanges && event.configuration !== facts.inForce && (h.rule !== RULE_PENDING || facts.plannedBaseline >= context.floor);
    case "exception-recorded": // H: for that visit, before it began. Code only: one pending at a time, for the next slot.
      return attempt !== null && !facts.closed && facts.frozen && attempt.phase === "planned" && h.except === 0 && at === facts.next;
    case "baseline-rule-recorded": {
      // H: every baseline attempt ended, then met or not_met; met needs two usable under the current configuration, or all when fewer were planned.
      if (facts.closed || h.rule !== RULE_PENDING || !facts.baselineSettled) return false;
      if (event.result === "not_met") return true;
      const usable = state.attempts.filter((candidate, position) => context.arms[position] === "baseline" && candidate.phase === "usable" && candidate.configuration === facts.inForce).length;
      return usable >= context.floor;
    }
    case "attempt-started": // H: plan order, one at a time; cleanup unresolved blocks it; instrumented waits on the rule; a met control for the configuration in force, or the owner's exception for this visit.
      return attempt !== null && !facts.closed && facts.frozen && attempt.phase === "planned" && facts.running < 0 && at === facts.next && !facts.unresolved && !(context.arms[at] === "instrumented" && h.rule === RULE_PENDING) && (h.except === SLOT_NAMES.indexOf(event.slot) + 1 || h.met === 1);
    case "attempt-start-retried": // case-machine.ts:95 (AttemptState.startRetries): counted only while starting. Code only: the cap.
      return attempt !== null && attempt.phase === "starting" && attempt.startRetries < CAP.startRetries;
    case "capture-began": // Code only.
      return attempt !== null && attempt.phase === "starting";
    case "capture-finished": // Code only.
      return attempt !== null && attempt.phase === "capturing";
    case "attempt-finished": // Code only: what a runner may report from each running phase (REPORTABLE).
      return attempt !== null && RUNNING.has(attempt.phase) && REPORTABLE[attempt.phase].includes(event.outcome);
    case "attempt-deadline": // Code only.
      return attempt !== null && RUNNING.has(attempt.phase);
    case "case-deadline": // H: a supervisor's event closes an open case, whatever cleanup is doing.
    case "case-cancelled":
      return !facts.closed;
    case "reconcile": // Code only: a running attempt has no runner left; with none running, pending cleanup has gone unanswered.
      return facts.running >= 0 || facts.pending;
    case "cleanup-confirmed": // Code only (cleanupEvent, case-machine.ts:539 to 552): only after the attempt began and stopped running; confirmed and destroyed are settled. case-machine.ts:260 (isTerminal): unconfirmed has been answered and can still be resolved.
    case "cleanup-unconfirmed":
    case "environment-destroyed":
      return attempt !== null && attempt.cleanup !== null && !RUNNING.has(attempt.phase) && attempt.cleanup !== "confirmed" && attempt.cleanup !== "environment_destroyed" && !(event.type === "cleanup-unconfirmed" && attempt.cleanup === "unconfirmed");
    default:
      return false;
  }
}

export type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/**
 * What an accepted event leaves, field for field, as W2's rules state it, with the shadow after it.
 * The same restatement as guardOf, with the same sources. The bookkeeping, and the rules the prose
 * leaves to the code, are in shadowOf, which this takes its shadow from.
 */
export function effectOf(context: PlanContext, state: MachineState, before: Shadow, facts: Facts, event: MachineEvent): Readonly<{ state: MachineState; shadow: Shadow }> {
  const h = shadowOf(context, state, before, facts, event);
  const attempts: Mutable<AttemptState>[] = state.attempts.map((attempt) => ({ ...attempt }));
  let closedBy = state.closedBy;
  let planDigest = state.planDigest;
  const at = "slot" in event ? context.slots.indexOf(event.slot) : -1;
  const closeWith = (outcome: AttemptPhase, by: NonNullable<MachineState["closedBy"]>) => {
    // case-machine.ts:342 (closeWith): close now, whatever cleanup is doing; the running attempt takes the outcome, and a slot still waiting never begins.
    // case-machine.ts:93 (AttemptState.configuration): one closed unstarted carries the configuration in force.
    for (const attempt of attempts) {
      if (RUNNING.has(attempt.phase)) {
        attempt.phase = outcome;
        attempt.startRetries = 0;
      } else if (attempt.phase === "planned") {
        attempt.phase = "not_started";
        attempt.configuration = CASE_CONFIGS[h.config];
      }
    }
    closedBy = by;
  };
  const closeIfDone = () => {
    // Code only: a report, a deadline or a reconcile that ends the last attempt still planned or running closes the case, as completed.
    if (closedBy === null && attempts.every(({ phase }) => OUTCOME.has(phase) || phase === "not_started")) closedBy = "completed";
  };
  switch (event.type) {
    case "plan-frozen":
      planDigest = event.planDigest;
      break;
    case "baseline-rule-recorded":
      if (event.result === "not_met") closeWith("failed", "baseline_not_met");
      break;
    case "attempt-started":
      attempts[at].phase = "starting";
      attempts[at].cleanup = "pending";
      attempts[at].configuration = CASE_CONFIGS[h.config];
      break;
    case "attempt-start-retried":
      attempts[at].startRetries += 1;
      break;
    case "capture-began":
      attempts[at].phase = "capturing";
      attempts[at].startRetries = 0;
      break;
    case "capture-finished":
      attempts[at].phase = "finalizing";
      break;
    case "attempt-finished":
      attempts[at].phase = event.outcome;
      attempts[at].startRetries = 0;
      closeIfDone();
      break;
    case "attempt-deadline":
      attempts[at].phase = "timed_out";
      attempts[at].startRetries = 0;
      closeIfDone();
      break;
    case "case-deadline":
      closeWith("timed_out", "deadline");
      break;
    case "case-cancelled":
      closeWith("cancelled", "cancelled");
      break;
    case "reconcile":
      if (facts.running >= 0) {
        attempts[facts.running].phase = "failed";
        attempts[facts.running].cleanup = "unconfirmed";
        attempts[facts.running].startRetries = 0;
        closeIfDone();
      } else for (const attempt of attempts) if (attempt.cleanup === "pending") attempt.cleanup = "unconfirmed";
      break;
    case "cleanup-confirmed":
      attempts[at].cleanup = "confirmed";
      break;
    case "cleanup-unconfirmed":
      attempts[at].cleanup = "unconfirmed";
      break;
    case "environment-destroyed":
      attempts[at].cleanup = "environment_destroyed";
      break;
    default:
      break;
  }
  return {
    state: { planDigest, controlRunId: state.controlRunId, configuration: CASE_CONFIGS[h.config], configurationChanges: h.changes, controlMet: h.met === 1, controlMisses: h.misses, exceptionFor: EXCEPTION_SLOTS[h.except], exploratory: h.ever === 1, baselineRule: RULES[h.rule], closedBy, attempts, purge: null },
    shadow: h
  };
}

/**
 * The shadow an accepted event leaves, with nothing else built: the bookkeeping half of effectOf,
 * which takes its shadow from here, so the walk's key and the restated effect read one rule. A close
 * clears what only steers the next visit (H); a report, a deadline or a reconcile that ends the last
 * slot still running or planned closes the case, as completed (code only). Every start spends the
 * pending exception (code only, attemptStarted), which is always the started slot's under guardOf.
 *
 * A met control clears the misses. The code states it (code only, controlRecorded), and the owner's
 * batch ruled it in as W2's rule, so the restatement holds it. No answer stands behind it: once a
 * control is met further controls are refused, and a configuration change resets the misses
 * anyway, so the clearing is bookkeeping. The field's comment at case-machine.ts:109 ("controls
 * recorded for this configuration's gate that did not open it") reads otherwise; that comment is
 * production's, and is left as it is.
 */
export function shadowOf(context: PlanContext, state: MachineState, before: Shadow, facts: Facts, event: MachineEvent): Shadow {
  const h: Shadow = { ...before };
  const clearGate = () => {
    h.met = 0;
    h.misses = 0;
    h.except = 0;
  };
  const endsTheLast = (ending: number): boolean => state.closedBy === null && state.attempts.every((attempt, position) => position === ending || OUTCOME.has(attempt.phase) || attempt.phase === "not_started");
  switch (event.type) {
    case "control-recorded":
      if (event.configuration === facts.inForce && event.result === "met") {
        h.met = 1;
        h.misses = 0;
      } else h.misses += 1;
      break;
    case "configuration-changed":
      h.config = Math.max(0, CASE_CONFIGS.indexOf(event.configuration));
      h.changes += 1;
      h.met = 0;
      h.misses = 0;
      h.except = 0;
      break;
    case "exception-recorded":
      h.except = SLOT_NAMES.indexOf(event.slot) + 1;
      h.ever = 1;
      break;
    case "baseline-rule-recorded":
      if (event.result === "not_met") {
        h.rule = 2;
        clearGate();
      } else {
        h.rule = RULE_MET;
        h.ruleConfig = h.config;
      }
      break;
    case "attempt-started":
      h.except = 0;
      break;
    case "attempt-finished":
      if (OUTCOME.has(event.outcome) && endsTheLast(context.slots.indexOf(event.slot))) clearGate();
      break;
    case "attempt-deadline":
      if (endsTheLast(context.slots.indexOf(event.slot))) clearGate();
      break;
    case "case-deadline":
    case "case-cancelled":
      clearGate();
      break;
    case "reconcile":
      if (facts.running >= 0 && endsTheLast(facts.running)) clearGate();
      break;
    default:
      break;
  }
  return h;
}

/** The same own keys, in the same order: what JSON text of the two would also compare. */
export function sameKeys(left: object, right: object): boolean {
  const ours = Object.keys(left);
  const theirs = Object.keys(right);
  if (ours.length !== theirs.length) return false;
  for (let at = 0; at < ours.length; at += 1) if (ours[at] !== theirs[at]) return false;
  return true;
}

/**
 * Two states equal in every field the machine has, with their keys in the same order, the
 * attempts' too: what the key must rebuild. It asks what comparing their JSON text asked, without
 * writing the text.
 */
export function sameState(left: MachineState, right: MachineState): boolean {
  if (!sameKeys(left, right) || left.attempts.length !== right.attempts.length) return false;
  const same =
    left.planDigest === right.planDigest &&
    left.controlRunId === right.controlRunId &&
    left.configuration === right.configuration &&
    left.configurationChanges === right.configurationChanges &&
    left.controlMet === right.controlMet &&
    left.controlMisses === right.controlMisses &&
    left.exceptionFor === right.exceptionFor &&
    left.exploratory === right.exploratory &&
    left.baselineRule === right.baselineRule &&
    left.closedBy === right.closedBy &&
    (left.purge === null ? right.purge === null : sameManifest(right.purge, left.purge));
  return (
    same &&
    left.attempts.every((attempt, position) => {
      const other = right.attempts[position];
      return (
        sameKeys(attempt, other) &&
        attempt.slot === other.slot &&
        attempt.arm === other.arm &&
        attempt.attemptId === other.attemptId &&
        attempt.phase === other.phase &&
        attempt.cleanup === other.cleanup &&
        attempt.configuration === other.configuration &&
        attempt.startRetries === other.startRetries &&
        Array.isArray(other.evidence) &&
        attempt.evidence.length === other.evidence.length &&
        attempt.evidence.every((id, at) => other.evidence[at] === id)
      );
    })
  );
}

export type PurgeAnswer = Readonly<{ ok: true; manifest: PurgeManifest }> | Readonly<{ ok: false; refusal: string }>;

/**
 * purgeStep's rule, RESTATED from purge.ts's docblock and W2's commit, as purge.test.ts's map does:
 * only a closed case has a manifest; one is recorded once, of distinct paths, each read present; a
 * path's status moves only on a listed path, and only to a status it does not hold.
 */
export function purgeAnswer(closed: boolean, manifest: PurgeManifest | null, event: PurgeEvent): PurgeAnswer {
  if (!closed) return { ok: false, refusal: "case-open" };
  if (event.type === "purge-manifest-recorded") {
    if (manifest !== null) return { ok: false, refusal: "manifest-already-recorded" };
    if (new Set(event.paths).size !== event.paths.length) return { ok: false, refusal: "manifest-malformed" };
    return { ok: true, manifest: event.paths.map((path) => ({ path, state: "present" as PathState })) };
  }
  const entry = manifest?.find(({ path }) => path === event.path);
  if (manifest === null || entry === undefined) return { ok: false, refusal: "no-such-path" };
  const status: PathState = event.type === "purge-path-absent" ? "absent" : "remains";
  if (entry.state === status) return { ok: false, refusal: "path-status-unchanged" };
  return { ok: true, manifest: manifest.map((candidate) => (candidate.path === event.path ? { path: event.path, state: status } : candidate)) };
}

export const UNLISTED = "0f".repeat(32);

/** Every manifest of up to three paths in one order, one that repeats a path, and each path, listed or not, read absent or remaining. */
export function purgeSliceAlphabet(): readonly PurgeEvent[] {
  const subsets: string[][] = [[]];
  for (const path of PURGE_PATHS) for (const subset of [...subsets]) subsets.push([...subset, path]);
  return [
    ...subsets.map((paths): PurgeEvent => ({ type: "purge-manifest-recorded", paths })),
    { type: "purge-manifest-recorded", paths: [PURGE_PATHS[0], PURGE_PATHS[0]] },
    ...[...PURGE_PATHS, UNLISTED].flatMap((path): PurgeEvent[] => [
      { type: "purge-path-absent", path },
      { type: "purge-path-remains", path }
    ])
  ];
}

/** Every manifest the slice reaches on a closed case: each subset of three paths, each status of each listed path. */
export function everyManifest(): readonly PurgeManifest[] {
  const manifests: PurgeManifest[] = [];
  const subsets: string[][] = [[]];
  for (const path of PURGE_PATHS) for (const subset of [...subsets]) subsets.push([...subset, path]);
  const statuses: readonly PathState[] = ["present", "absent", "remains"];
  for (const paths of subsets) {
    const assign = (prefix: ManifestPath[], left: number): void => {
      if (left === paths.length) {
        manifests.push(prefix);
        return;
      }
      for (const state of statuses) assign([...prefix, { path: paths[left], state }], left + 1);
    };
    assign([], 0);
  }
  return manifests;
}

export type Coverage = { phases: number; cleanups: number; closures: number; rules: number; changed: boolean; misses: number; exploratory: boolean; closed: number };

export type MachineWalkOptions = Readonly<{ machine: MachineModule; evidence?: EvidenceModule; plan: PlanInput; only?: readonly string[]; manifests?: "two" | "all" }>;

export function grow(array: Int32Array<ArrayBuffer>, need: number): Int32Array<ArrayBuffer> {
  if (need <= array.length) return array;
  const bigger = new Int32Array(Math.max(need, array.length * 2));
  bigger.set(array);
  return bigger;
}

export function growWords(array: Uint16Array<ArrayBuffer>, need: number): Uint16Array<ArrayBuffer> {
  if (need <= array.length) return array;
  const bigger = new Uint16Array(Math.max(need, array.length * 2));
  bigger.set(array);
  return bigger;
}

export function growBytes(array: Uint8Array<ArrayBuffer>, need: number): Uint8Array<ArrayBuffer> {
  if (need <= array.length) return array;
  const bigger = new Uint8Array(Math.max(need, array.length * 2));
  bigger.set(array);
  return bigger;
}

/** Two manifests listing the same paths, in the same order, each read the same way. */
export function sameManifest(left: PurgeManifest | null, right: PurgeManifest): boolean {
  return left !== null && left.length === right.length && left.every((entry, at) => Object.keys(entry).length === 2 && entry.path === right[at].path && entry.state === right[at].state);
}

/** Whether a graph in compressed rows has no cycle: sources are removed until none is left. */
export function isAcyclicGraph(count: number, offsets: Int32Array, targets: Int32Array): boolean {
  const incoming = new Int32Array(count);
  for (let edge = 0; edge < offsets[count]; edge += 1) incoming[targets[edge]] += 1;
  const ready: number[] = [];
  for (let node = 0; node < count; node += 1) if (incoming[node] === 0) ready.push(node);
  let removed = 0;
  while (ready.length > 0) {
    const node = ready.pop() as number;
    removed += 1;
    for (let edge = offsets[node]; edge < offsets[node + 1]; edge += 1) {
      incoming[targets[edge]] -= 1;
      if (incoming[targets[edge]] === 0) ready.push(targets[edge]);
    }
  }
  return removed === count;
}

/** Which plan, which properties, which manifests, and which variant of production, as plain data a worker can take. */
export type MachineSetup = Readonly<{ plan: PlanInput; only?: readonly string[]; manifests?: "two" | "all"; machineEdits?: readonly SourceEdit[]; evidenceEdits?: readonly SourceEdit[] }>;

export type Prepared = ReturnType<typeof prepareMachine>;

/**
 * Everything the walk and the per-state checks need, made once per setup in each thread. The
 * checks are the same functions whichever thread runs them, so a property means the same thing
 * inline and in a worker.
 */
export function prepareMachine(setup: MachineSetup, given?: Readonly<{ machine: MachineModule; evidence: EvidenceModule }>) {
  const machine = given?.machine ?? (setup.machineEdits === undefined || setup.machineEdits.length === 0 ? productionMachine : machineVariant(...setup.machineEdits));
  const evidence = given?.evidence ?? (setup.evidenceEdits === undefined || setup.evidenceEdits.length === 0 ? productionEvidence : evidenceVariant(...setup.evidenceEdits));
  const { plan, only, manifests = "two" } = setup;
  const context = contextOf(plan);
  const on = (name: string): boolean => only === undefined || only.includes(name);
  const check = Object.fromEntries(Object.entries(M).map(([key, name]) => [key, on(name)])) as Record<keyof typeof M, boolean>;
  const codec = machineCodec(context);
  const alphabet = machineAlphabet(plan);
  const probes = check.authority ? authorityProbes(context, alphabet) : [];
  const records = check.authority ? recordProbes(context) : [];
  const probeRecords = [evidence.EMPTY_RECORD, recordWithRows(context)];
  const pairs = check.interchangeable ? cleanupPairs(alphabet) : [];
  const counterfactual = alphabet.map((event, at) => (event.type === "attempt-started" || event.type === "reconcile" || CLEANUP_EVENTS.has(event.type) ? -1 : at)).filter((at) => at >= 0);
  const deadline = alphabet.findIndex(({ type }) => type === "case-deadline");
  const reconcile = alphabet.findIndex(({ type }) => type === "reconcile");
  const slotIndex = context.slots.map((slot) => SLOT_NAMES.indexOf(slot) + 1);
  const purgeEvents = purgeSliceAlphabet();
  // The slice's events as the owner sends them, made once: step reads them and writes nothing.
  const ownerPurgeEvents = purgeEvents.map((body) => ({ ...body, by: OWNER }) as MachineEvent);
  const listed: PurgeManifest = PURGE_PATHS.map((path) => ({ path, state: "present" as PathState }));
  const cleared: PurgeManifest = PURGE_PATHS.map((path) => ({ path, state: "absent" as PathState }));
  const held: readonly PurgeManifest[] = manifests === "all" ? everyManifest() : [listed, cleared];
  const firstShadow: Shadow = { config: 0, changes: 0, met: 0, misses: 0, except: 0, ever: 0, rule: context.bothArms ? RULE_PENDING : RULE_NOT_APPLICABLE, ruleConfig: 0 };

  const checkArm = (state: MachineState, next: MachineState | null): void => {
    if (!check.arm) return;
    if (next !== null) {
      holds(M.arm, next.attempts.length === state.attempts.length && next.attempts.every((attempt, position) => attempt.slot === state.attempts[position].slot && attempt.arm === state.attempts[position].arm && attempt.attemptId === state.attempts[position].attemptId), () => ({ state, next }));
    }
    const subject = next ?? state;
    holds(M.arm, subject.attempts.length === context.slots.length && subject.attempts.every((attempt, position) => attempt.slot === context.slots[position] && attempt.arm === context.arms[position] && attempt.attemptId === context.ids[position]), () => subject);
  };

  const checkState = (state: MachineState, h: Shadow): void => {
    let running = 0;
    for (const { phase } of state.attempts) if (RUNNING.has(phase)) running += 1;
    if (check.closed) {
      const allSettled = state.attempts.every(({ phase }) => OUTCOME.has(phase) || phase === "not_started");
      holds(M.closed, (state.closedBy !== null) === allSettled && state.attempts.every(({ phase, configuration }) => phase !== "not_started" || configuration === CASE_CONFIGS[h.config]), () => ({ state, shadow: h }));
    }
    if (check.oneRuns) holds(M.oneRuns, running <= 1, () => state);
    if (check.mark) holds(M.mark, state.exploratory === (h.ever === 1), () => ({ state, shadow: h }));
    if (check.caps) {
      holds(
        M.caps,
        state.controlMisses === h.misses && state.configurationChanges === h.changes && state.attempts.every(({ phase, startRetries }) => isCount(startRetries, CAP.startRetries) && (phase === "starting" || startRetries === 0)),
        () => ({ state, shadow: h })
      );
    }
    if (check.gate) {
      holds(
        M.gate,
        state.configuration === CASE_CONFIGS[h.config] && state.controlMet === (h.met === 1) && state.exceptionFor === EXCEPTION_SLOTS[h.except] && state.baselineRule === RULES[h.rule] && (state.closedBy === null || (!state.controlMet && state.controlMisses === 0 && state.exceptionFor === null)),
        () => ({ state, shadow: h })
      );
    }
    if (check.cleanup) holds(M.cleanup, state.attempts.every(({ phase, cleanup }) => (!RUNNING.has(phase) || cleanup === "pending") && (phase !== "planned" || cleanup === null)), () => state);
  };

  const checkTransition = (state: MachineState, h: Shadow, facts: Facts, event: MachineEvent, next: MachineState, closedKey: string | null): void => {
    const slotOfEvent = "slot" in event ? event.slot : null;
    for (let position = 0; position < state.attempts.length && position < next.attempts.length; position += 1) {
      const was = state.attempts[position];
      const now = next.attempts[position];
      if (check.terminalStays && (OUTCOME.has(was.phase) || was.phase === "not_started")) holds(M.terminalStays, now.phase === was.phase, () => ({ state, event, next }));
      if (check.ranUnder && was.phase !== "planned") holds(M.ranUnder, now.configuration === was.configuration, () => ({ state, event, next }));
      if (check.cleanup && now.cleanup !== was.cleanup) {
        const mine = slotOfEvent === was.slot;
        const allowed =
          (now.cleanup === "pending" && was.cleanup === null && mine && event.type === "attempt-started") ||
          (now.cleanup === "confirmed" && mine && event.type === "cleanup-confirmed") ||
          (now.cleanup === "environment_destroyed" && mine && event.type === "environment-destroyed") ||
          (now.cleanup === "unconfirmed" && ((mine && event.type === "cleanup-unconfirmed") || event.type === "reconcile"));
        holds(M.cleanup, allowed, () => ({ state, event, next, slot: was.slot }));
      }
      if (was.phase !== "planned" || NOT_BEGUN.has(now.phase)) continue;
      // This attempt began on this transition.
      if (check.blocks) holds(M.blocks, !state.attempts.some(({ cleanup }) => UNRESOLVED.has(cleanup)), () => ({ state, event, next }));
      if (check.control) holds(M.control, h.met === 1 || h.except === slotIndex[position], () => ({ state, shadow: h, event, next }));
      if (check.ranUnder) holds(M.ranUnder, now.configuration === CASE_CONFIGS[h.config], () => ({ state, shadow: h, event, next }));
      if (check.waits && context.bothArms && context.arms[position] === "instrumented") holds(M.waits, h.rule === RULE_MET && now.configuration === CASE_CONFIGS[h.ruleConfig], () => ({ state, shadow: h, event, next }));
    }
    if (check.exceptionFirst && event.type === "exception-recorded") {
      const target = state.attempts.find(({ slot }) => slot === event.slot);
      holds(M.exceptionFirst, target !== undefined && target.phase === "planned", () => ({ state, event, next }));
    }
    if (check.waits && event.type === "baseline-rule-recorded") {
      const baseline = state.attempts.filter((_, position) => context.arms[position] === "baseline");
      holds(M.waits, baseline.every(({ phase }) => OUTCOME.has(phase) || phase === "not_started"), () => ({ state, event, next }));
      if (event.result === "met") {
        const usable = baseline.filter(({ phase, configuration }) => phase === "usable" && configuration === CASE_CONFIGS[h.config]).length;
        holds(M.waits, usable >= context.floor, () => ({ state, shadow: h, event, next }));
      }
    }
    if (check.acquisition && CLEANUP_EVENTS.has(event.type)) {
      holds(M.acquisition, next.closedBy === state.closedBy && next.attempts.every((attempt, position) => attempt.phase === state.attempts[position].phase), () => ({ state, event, next }));
    }
    if (check.cleanup && event.type === "reconcile") {
      // Code only, reconcile: a running attempt has no runner left, so it failed and nothing confirmed its cleanup; with none running, pending cleanup reads unconfirmed.
      const verdict =
        facts.running >= 0
          ? next.attempts[facts.running].phase === "failed" && next.attempts[facts.running].cleanup === "unconfirmed"
          : state.attempts.every((attempt, position) => attempt.cleanup !== "pending" || next.attempts[position].cleanup === "unconfirmed");
      holds(M.cleanup, verdict, () => ({ state, event, next }));
    }
    if (check.closedStays && closedKey !== null) holds(M.closedStays, next.closedBy === state.closedBy && codec.encode(next, true) === closedKey, () => ({ state, event, next }));
    if (check.ruleFixed && (state.baselineRule === "met" || state.baselineRule === "not_met")) holds(M.ruleFixed, next.baselineRule === state.baselineRule, () => ({ state, event, next }));
  };

  /** The slice's answer on a state holding this manifest, against the restated reducer, refusal included, with nothing but the manifest moved. */
  const checkPurge = (state: MachineState, plainKey: string, manifest: PurgeManifest | null): void => {
    const holding: MachineState = manifest === null ? state : { ...state, purge: manifest };
    for (let at = 0; at < purgeEvents.length; at += 1) {
      const body = purgeEvents[at];
      const answer = machine.step(holding, ownerPurgeEvents[at]);
      const expected = purgeAnswer(state.closedBy !== null, manifest, body);
      holds(
        M.purgeSlice,
        answer.ok === expected.ok && (answer.ok ? sameManifest(answer.state.purge, (expected as Extract<PurgeAnswer, { ok: true }>).manifest) && codec.encode({ ...answer.state, purge: null }) === plainKey : answer.refusal === (expected as { refusal: string }).refusal),
        () => ({ state, manifest, body, answer, expected })
      );
    }
  };

  return { machine, evidence, context, check, codec, alphabet, probes, records, probeRecords, pairs, counterfactual, deadline, reconcile, purgeEvents, held, firstShadow, checkArm, checkState, checkTransition, checkPurge };
}

/**
 * The most states the machine walk takes: twice the six-slot plan's pinned 2,985,379. The
 * space-growing variants found so far die by name on the small plans; one that grows the space only
 * on the six-slot plan stops here instead, with an error that names no property, before any
 * per-state property runs and before the key map's own limit.
 */
export const MACHINE_STATE_BOUND = 5_970_758;

export type Explored = Readonly<{ keys: readonly string[]; shadows: Uint16Array<ArrayBuffer>; states: number; edges: number; splits: number; coverage: Coverage; acyclic: boolean | null }>;

/**
 * The walk, done once, in one thread: breadth first from the plan's first state over the alphabet,
 * with only what the key needs held as it goes (the domain, the caps, and the arm, whose change
 * would leave the domain), the first state's own properties, and the graph for acyclicity. Every
 * other property is held per state afterwards, by checkMachineRange, in any number of threads. It
 * stops with an error at `bound` states (MACHINE_STATE_BOUND unless a test names a smaller one).
 */
export function exploreMachine(p: Prepared, bound = MACHINE_STATE_BOUND): Explored {
  const { machine, context, check, codec, alphabet, firstShadow } = p;
  const first = machine.plannedState(context.plan);
  holds(M.domain, first.ok, () => first);
  const firstState = (first as Accepted).state;
  p.checkArm(firstState, null);
  p.checkState(firstState, firstShadow);
  const firstKey = codec.encode(firstState);
  if (check.effect) {
    // H: a plan begins with every slot planned, nothing frozen, no gate open and the rule pending only where both arms are planned.
    const expected: MachineState = {
      planDigest: null,
      controlRunId: context.plan.controlRunId,
      configuration: context.plan.configuration,
      configurationChanges: 0,
      controlMet: false,
      controlMisses: 0,
      exceptionFor: null,
      exploratory: false,
      baselineRule: RULES[firstShadow.rule],
      closedBy: null,
      attempts: context.slots.map((slot, position) => ({ slot, arm: context.arms[position], attemptId: context.ids[position], phase: "planned", cleanup: null, configuration: null, startRetries: 0, evidence: [] })),
      purge: null
    };
    holds(M.effect, firstKey === codec.encode(expected), () => ({ first: firstState, expected }));
  }
  const byKey = new Map<string, number>([[firstKey, 0]]);
  const keys: string[] = [firstKey];
  let shadows = new Uint16Array(1 << 16);
  shadows[0] = packShadow(firstShadow);
  let chain = new Int32Array(1 << 16).fill(-1);
  let offsets = new Int32Array(1 << 16);
  let targets = new Int32Array(check.acyclic ? 1 << 18 : 0);
  let edges = 0;
  let splits = 0;
  const coverage: Coverage = { phases: 0, cleanups: 0, closures: 0, rules: 0, changed: false, misses: 0, exploratory: false, closed: 0 };

  for (let at = 0; at < keys.length; at += 1) {
    const state = codec.decode(keys[at]);
    const shadow = unpackShadow(shadows[at]);
    const facts = factsOf(context, state, shadow);
    offsets = grow(offsets, at + 2);
    offsets[at] = edges;
    for (const event of alphabet) {
      const answer = machine.step(state, event);
      if (!answer.ok) continue;
      const next = answer.state;
      p.checkArm(state, next);
      const nextShadow = packShadow(shadowOf(context, state, shadow, facts, event));
      const key = codec.encode(next);
      let target = byKey.get(key);
      const head = target;
      while (target !== undefined && target >= 0 && shadows[target] !== nextShadow) target = chain[target];
      if (target === undefined || target < 0) {
        target = keys.length;
        if (target >= bound) throw new Error(`the walk reached its bound of ${bound} states before it ended: the state space grew past it, so no property was held here`);
        keys.push(key);
        shadows = growWords(shadows, target + 1);
        chain = grow(chain, target + 1);
        shadows[target] = nextShadow;
        if (head === undefined) {
          byKey.set(key, target);
          chain[target] = -1;
        } else {
          // Two histories that disagree about the shadow reach one production state: kept apart, and counted.
          chain[target] = chain[head];
          chain[head] = target;
          splits += 1;
        }
      }
      if (check.acyclic) {
        targets = grow(targets, edges + 1);
        targets[edges] = target;
      }
      edges += 1;
    }
    const key = keys[at];
    let global = key.charCodeAt(0);
    coverage.closures |= 1 << global % 5;
    global = Math.floor(global / 5);
    coverage.rules |= 1 << global % 4;
    global = Math.floor(global / 4);
    if (global % 2 === 1) coverage.exploratory = true;
    global = Math.floor(global / 14);
    coverage.misses |= 1 << global % 3;
    global = Math.floor(global / 6);
    if (global % 2 === 1) coverage.changed = true;
    for (let position = 1; position < key.length; position += 1) {
      const code = key.charCodeAt(position);
      coverage.phases |= 1 << Math.floor(code / 45);
      coverage.cleanups |= 1 << Math.floor(code / 9) % 5;
    }
    if (facts.closed) coverage.closed += 1;
  }
  offsets[keys.length] = edges;
  const acyclic = check.acyclic ? isAcyclicGraph(keys.length, offsets, targets) : null;
  if (check.acyclic) holds(M.acyclic, acyclic === true, () => ({ states: keys.length, edges }));
  return { keys, shadows, states: keys.length, edges, splits, coverage, acyclic };
}

/** Every property but the walk's own, on one reachable state and every transition out of it. */
export function checkMachineState(p: Prepared, key: string, packed: number): void {
  const { machine, evidence, context, check, codec, alphabet } = p;
  const state = codec.decode(key);
  const shadow = unpackShadow(packed);
  const facts = factsOf(context, state, shadow);
  const closed = facts.closed;
  const terminal = closed && !facts.pending;
  const closedKey = closed && check.closedStays ? codec.encode(state, true) : null;

  if (check.agreeDenominator) {
    const denominator = machine.denominatorOf(state);
    const of = PHASES.map(() => 0);
    for (const { phase } of state.attempts) of[PHASES.indexOf(phase)] += 1;
    const [planned, starting, capturing, finalizing, usable, walled, failed, incomplete, timedOut, cancelled, notStarted] = of;
    holds(
      M.agreeDenominator,
      denominator.planned === context.slots.length &&
        denominator.running === starting + capturing + finalizing &&
        denominator.notStarted === planned + notStarted &&
        denominator.waiting === planned &&
        denominator.usable === usable &&
        denominator.walled === walled &&
        denominator.failed === failed &&
        denominator.incomplete === incomplete &&
        denominator.timed_out === timedOut &&
        denominator.cancelled === cancelled,
      () => ({ state, denominator })
    );
  }
  if (check.agreeTerminal) holds(M.agreeTerminal, machine.isTerminal(state) === terminal, () => state);
  if (check.agreeContinuation) {
    const blocked = state.attempts.filter(({ cleanup }) => UNRESOLVED.has(cleanup)).map(({ slot }) => slot);
    const expected = closed ? { continuation: "not_applicable" } : blocked.length > 0 ? { continuation: "blocked", reason: "cleanup_unresolved", slots: blocked } : { continuation: "allowed" };
    const actual = machine.continuationOf(state);
    holds(M.agreeContinuation, JSON.stringify(actual) === JSON.stringify(expected), () => ({ state, actual, expected }));
  }

  const results: StepResult[] = new Array(alphabet.length);
  let accepted = 0;
  for (let index = 0; index < alphabet.length; index += 1) {
    const event = alphabet[index];
    const answer = machine.step(state, event);
    results[index] = answer;
    if (check.guard) {
      const allowed = guardOf(context, state, shadow, facts, event);
      if (allowed !== answer.ok) holds(M.guard, false, () => ({ state, shadow, event, answer, expected: allowed ? "accepted" : "refused" }));
    }
    if (!answer.ok) continue;
    accepted += 1;
    const next = answer.state;
    const expected = effectOf(context, state, shadow, facts, event);
    p.checkArm(state, next);
    p.checkTransition(state, shadow, facts, event, next, closedKey);
    p.checkState(next, expected.shadow);
    const nextKey = codec.encode(next);
    // The key rebuilds the state exactly: every field, in production's own order.
    holds(M.domain, sameState(codec.decode(nextKey), next), () => ({ next, decoded: codec.decode(nextKey) }));
    if (check.effect && nextKey !== codec.encode(expected.state)) holds(M.effect, false, () => ({ state, event, next, expected: expected.state }));
  }

  // Every sink is terminal follows from the supervisor property below, since a non-terminal state accepts one of its events; it is kept as its own check.
  if (check.sinks && accepted === 0) holds(M.sinks, terminal, () => state);
  if (check.supervisor && !terminal) holds(M.supervisor, results[p.deadline].ok || results[p.reconcile].ok, () => state);

  if (check.authority) {
    for (const probe of p.probes) {
      const answer = machine.step(state, probe);
      if (answer.ok) holds(M.authority, false, () => ({ state, probe }));
    }
    for (const record of p.probeRecords) {
      for (const { event, by } of p.records) {
        const answer = evidence.applyRecordEvent(record, event, by, state, 9);
        if (answer.ok) holds(M.authority, false, () => ({ state, rows: record.rows.length, event, by }));
      }
    }
  }
  if (check.interchangeable) {
    for (const [ownerAt, fromRunner] of p.pairs) {
      const asOwner = results[ownerAt];
      const asRunner = machine.step(state, fromRunner);
      holds(M.interchangeable, asOwner.ok === asRunner.ok && (asOwner.ok ? codec.encode(asOwner.state) === codec.encode((asRunner as Accepted).state) : asOwner.refusal === (asRunner as { refusal: string }).refusal), () => ({ state, fromRunner, asOwner, asRunner }));
    }
  }
  if (check.acquisition && facts.unresolved) {
    // The same state with every unresolved cleanup resolved: nothing but attempt-started, reconcile and cleanup may answer differently, cleanup aside.
    const resolved: MachineState = { ...state, attempts: state.attempts.map((attempt) => (UNRESOLVED.has(attempt.cleanup) ? { ...attempt, cleanup: "confirmed" } : attempt)) };
    for (const index of p.counterfactual) {
      const here = results[index];
      const there = machine.step(resolved, alphabet[index]);
      holds(
        M.acquisition,
        here.ok === there.ok && (here.ok ? codec.encode(here.state, true) === codec.encode((there as Accepted).state, true) : here.refusal === (there as { refusal: string }).refusal),
        () => ({ state, event: alphabet[index], here, there })
      );
    }
  }
  if (check.purgeSlice) {
    p.checkPurge(state, key, null);
    if (closed) {
      for (const manifest of p.held) {
        p.checkPurge(state, key, manifest);
        // Every other event answers on a state holding this manifest as it does without one, and carries the manifest unchanged.
        const holding: MachineState = { ...state, purge: manifest };
        for (let index = 0; index < alphabet.length; index += 1) {
          const plain = results[index];
          const answer = machine.step(holding, alphabet[index]);
          holds(
            M.purgeSlice,
            plain.ok === answer.ok && (plain.ok ? sameManifest((answer as Accepted).state.purge, manifest) && codec.encode({ ...(answer as Accepted).state, purge: null }) === codec.encode(plain.state) : plain.refusal === (answer as { refusal: string }).refusal),
            () => ({ state, manifest, event: alphabet[index], plain, answer })
          );
        }
      }
    }
  }
}

/**
 * What a range of states reports: how many states its loop held to every property, and a digest of
 * the keys and shadows it held them on, and nothing more, or the first counterexample in it, with
 * the state's index.
 */
export type RangeResult = Readonly<{ checked: number; digest: number; failure: null }> | Readonly<{ checked: number; digest: number; failure: Readonly<{ index: number; property: string; input: unknown }> }>;

/** FNV-1a over 32 bits: the offset basis a digest starts from. */
export const DIGEST_BASIS = 0x811c9dc5;

/** One state folded into an FNV-1a digest: each code unit of its key as two bytes, low byte first, then its shadow's two bytes. */
export function foldState(digest: number, key: string, shadow: number): number {
  let hash = digest;
  for (let at = 0; at < key.length; at += 1) {
    const code = key.charCodeAt(at);
    hash = Math.imul(hash ^ (code & 0xff), 0x01000193);
    hash = Math.imul(hash ^ (code >>> 8), 0x01000193);
  }
  hash = Math.imul(hash ^ (shadow & 0xff), 0x01000193);
  hash = Math.imul(hash ^ ((shadow >>> 8) & 0xff), 0x01000193);
  return hash >>> 0;
}

/** The digest of states from to to, as these readers give them. */
export function sliceDigest(keyAt: (index: number) => string, shadowAt: (index: number) => number, from: number, to: number): number {
  let digest = DIGEST_BASIS;
  for (let index = from; index < to; index += 1) digest = foldState(digest, keyAt(index), shadowAt(index));
  return digest;
}

/**
 * The per-state properties over states from to to, in order, stopping at the first counterexample.
 * It counts each state, and folds the key and shadow it read into the digest, only once every
 * property has held there, so a range that skips a state reports fewer than it was given, and one
 * that held its properties on other states reports another digest; whoever sent it can tell both.
 */
export function checkMachineRange(p: Prepared, keyAt: (index: number) => string, shadowAt: (index: number) => number, from: number, to: number): RangeResult {
  let checked = 0;
  let digest = DIGEST_BASIS;
  for (let index = from; index < to; index += 1) {
    const key = keyAt(index);
    const shadow = shadowAt(index);
    try {
      checkMachineState(p, key, shadow);
    } catch (error) {
      if (error instanceof Counterexample) return { checked, digest, failure: { index, property: error.property, input: error.input } };
      throw error;
    }
    checked += 1;
    digest = foldState(digest, key, shadow);
  }
  return { checked, digest, failure: null };
}

/** A whole walk's range, in one thread: its counterexample raised, or every state checked, on the walk's own states, or an error saying what was not. */
export function assertWholeRange(result: RangeResult, explored: Explored): void {
  if (result.failure !== null) throw new Counterexample(result.failure.property, result.failure.input);
  if (result.checked !== explored.states) throw new Error(`the checks held ${result.checked} of the walk's ${explored.states} states`);
  const digest = sliceDigest((index) => explored.keys[index], (index) => explored.shadows[index], 0, explored.states);
  if (result.digest !== digest) throw new Error(`the checks report digest ${result.digest}, where the walk's own states give ${digest}`);
}

export type MachineWalk = Readonly<{ states: number; edges: number; splits: number; coverage: Coverage; acyclic: boolean | null }>;

/** The keys as one shared array of character codes, so every thread reads the walk without copying it. */
export function shareKeys(explored: Explored): Readonly<{ keys: SharedArrayBuffer; shadows: SharedArrayBuffer; width: number }> {
  const width = explored.keys[0].length;
  const keys = new SharedArrayBuffer(explored.states * width * 2);
  const codes = new Uint16Array(keys);
  explored.keys.forEach((key, index) => {
    for (let at = 0; at < width; at += 1) codes[index * width + at] = key.charCodeAt(at);
  });
  const shadows = new SharedArrayBuffer(explored.states * 2);
  new Uint16Array(shadows).set(explored.shadows.subarray(0, explored.states));
  return { keys, shadows, width };
}

export function sharedReaders(keys: SharedArrayBuffer, shadows: SharedArrayBuffer, width: number): Readonly<{ keyAt: (index: number) => string; shadowAt: (index: number) => number }> {
  const codes = new Uint16Array(keys);
  const packed = new Uint16Array(shadows);
  return { keyAt: (index) => String.fromCharCode(...codes.subarray(index * width, index * width + width)), shadowAt: (index) => packed[index] };
}

/** The walk and every per-state property in this thread, for small plans and variants. */
export function walkMachine({ machine, evidence = productionEvidence, plan, only, manifests = "two" }: MachineWalkOptions): MachineWalk {
  const p = prepareMachine({ plan, only, manifests }, { machine, evidence });
  const explored = exploreMachine(p);
  assertWholeRange(checkMachineRange(p, (index) => explored.keys[index], (index) => explored.shadows[index], 0, explored.states), explored);
  return { states: explored.states, edges: explored.edges, splits: explored.splits, coverage: explored.coverage, acyclic: explored.acyclic };
}

/** The same, from plain data: production or the variant its edits name. A worker runs this. */
export function walkMachineSetup(setup: MachineSetup): MachineWalk {
  const p = prepareMachine(setup);
  const explored = exploreMachine(p);
  assertWholeRange(checkMachineRange(p, (index) => explored.keys[index], (index) => explored.shadows[index], 0, explored.states), explored);
  return { states: explored.states, edges: explored.edges, splits: explored.splits, coverage: explored.coverage, acyclic: explored.acyclic };
}

/** Every value of every field the plan names is reached, so no property above holds by being out of reach. */
export function assertCovered(coverage: Coverage, expected: Readonly<{ phases: readonly AttemptPhase[]; closures: readonly MachineState["closedBy"][]; rules: readonly MachineState["baselineRule"][]; changed: boolean }>): void {
  const names = (mask: number, values: readonly unknown[]) => values.filter((_, at) => (mask & (1 << at)) !== 0);
  assert.deepEqual(names(coverage.phases, PHASES), [...expected.phases]);
  assert.deepEqual(names(coverage.cleanups, CLEANUPS), [...CLEANUPS], "every cleanup state, null among them");
  assert.deepEqual(names(coverage.closures, CLOSURES), [...expected.closures]);
  assert.deepEqual(names(coverage.rules, RULES), [...expected.rules]);
  assert.deepEqual(names(coverage.misses, [0, 1, 2]), [0, 1, 2], "every count of control misses up to the cap");
  assert.equal(coverage.changed, expected.changed, "the configuration change");
  assert.equal(coverage.exploratory, true, "the exploratory mark");
}

// ---------------------------------------------------------------------------------------------
// The purge slice, apart from the machine. purge.test.ts pins its signature to the closed flag, the
// manifest and the event, which is what lets it be walked alone: widening it invalidates this.
// ---------------------------------------------------------------------------------------------

export const S = {
  answer: "purgeStep answers as the restated reducer does, accepting exactly when it does, with its refusal and its manifest",
  summary: "SUMMARY_ONLY holds exactly when a manifest exists and every path on it reads absent"
} as const;

export type SliceNode = Readonly<{ closed: boolean; manifest: PurgeManifest | null }>;

export function walkPurgeSlice(module: PurgeModule, only?: readonly string[]): Readonly<{ states: number; edges: number; summary: number; cyclic: boolean }> {
  const on = (name: string): boolean => only === undefined || only.includes(name);
  const alphabet = purgeSliceAlphabet();
  const nodes: SliceNode[] = [
    { closed: true, manifest: null },
    { closed: false, manifest: null }
  ];
  const index = new Map(nodes.map((node, at) => [JSON.stringify(node), at]));
  const adjacency: number[][] = [];
  let summary = 0;
  let edges = 0;
  for (let at = 0; at < nodes.length; at += 1) {
    const { closed, manifest } = nodes[at];
    adjacency.push([]);
    const allAbsent = manifest !== null && manifest.every(({ state }) => state === "absent");
    if (allAbsent) summary += 1;
    if (on(S.summary)) holds(S.summary, module.retentionTier(manifest) === (allAbsent ? "SUMMARY_ONLY" : "RAW_HELD"), () => ({ manifest }));
    for (const event of alphabet) {
      const answer = module.purgeStep(closed, manifest, event);
      if (on(S.answer)) {
        const expected = purgeAnswer(closed, manifest, event);
        holds(
          S.answer,
          answer.ok === expected.ok && (answer.ok ? sameManifest(answer.manifest, (expected as Extract<PurgeAnswer, { ok: true }>).manifest) : answer.refusal === (expected as { refusal: string }).refusal),
          () => ({ closed, manifest, event, answer, expected })
        );
      }
      if (!answer.ok) continue;
      const node: SliceNode = { closed, manifest: answer.manifest };
      const key = JSON.stringify(node);
      let target = index.get(key);
      if (target === undefined) {
        target = nodes.length;
        nodes.push(node);
        index.set(key, target);
      }
      adjacency[at].push(target);
      edges += 1;
    }
  }
  const offsets = new Int32Array(nodes.length + 1);
  const targets = new Int32Array(edges);
  let edge = 0;
  adjacency.forEach((next, at) => {
    offsets[at] = edge;
    for (const target of next) targets[edge++] = target;
  });
  offsets[nodes.length] = edge;
  return { states: nodes.length, edges, summary, cyclic: !isAcyclicGraph(nodes.length, offsets, targets) };
}

// ---------------------------------------------------------------------------------------------
// The fold.
// ---------------------------------------------------------------------------------------------

export const F = {
  domain: "every fold state the walk reaches is held whole by its key",
  summary: "SUMMARY_ONLY implies every digest the log names is kept by the owner or listed and confirmed absent",
  apart: "nothing is both kept and listed",
  rawStays: "a digest a row names as raw never becomes kept",
  manifest: "a manifest subset walked here is taken exactly when it is what rows and controls named, less what the owner keeps",
  empty: "an empty manifest is taken only when no attempt began",
  refusal: "raw-object-cannot-be-kept is heard exactly when an owner's event would start keeping a raw digest, or a listed path once a manifest exists, and nothing else refuses it first",
  genuine: "the genuine paths stay reachable",
  authority: "a fold entry from an actor the rule does not allow is refused",
  control: "a visit begins only on a control met under the identity in force, or on the owner's exception for it",
  basis: "a visit's basis on record is the exception when one was pending for it, and the control otherwise",
  late: "a row is recorded late exactly when its attempt had ended",
  rowTaken: "a row is taken exactly when its attempt began, its id is unused and no manifest exists",
  patch: "a patch is taken exactly when none was and the visit it names ended, where no raw digest or listed path is involved",
  planOnce: "a case is planned once"
} as const;

export const DIGEST_ZERO = "a0".repeat(32);
export const DIGEST_ONE = "a1".repeat(32);
export const DIGEST_TWO = "a2".repeat(32);
/** Named by no event of any instance: what a counterfactual names in place of a raw digest or a listed path. */
export const FRESH = "ff".repeat(32);

export const identityOf = (image: string, fixtureDigest: string, criterionDigest: string): ConfigurationIdentity => ({ ...IDENTITY_ALDER, runnerImage: `sha256:${image.repeat(32)}`, fixtureDigest, criterionDigest });

/**
 * An instance names its digests, the plan's identity, every other identity it walks, and which genuine paths (GENUINE's
 * bits) must still reach SUMMARY_ONLY in it. Every instance must accept all four; the fourth reaches SUMMARY_ONLY only
 * where the identity it adopts adds no digest, as in FOLD_TWO. Elsewhere it leaves every digest kept, and after a visit
 * no manifest can then be recorded: W2's open item on a case whose rows name only kept objects, not this rule.
 */
export type FoldInstance = Readonly<{ digests: readonly string[]; plan: ConfigurationIdentity; others: readonly ConfigurationIdentity[]; genuine: readonly number[] }>;

/** Two digests, the plan's identity naming one, and every identity over both on another image. */
export const FOLD_TWO: FoldInstance = {
  digests: [DIGEST_ZERO, DIGEST_ONE],
  plan: identityOf("d1", DIGEST_ZERO, DIGEST_ZERO),
  others: [identityOf("d2", DIGEST_ZERO, DIGEST_ZERO), identityOf("d2", DIGEST_ZERO, DIGEST_ONE), identityOf("d2", DIGEST_ONE, DIGEST_ZERO), identityOf("d2", DIGEST_ONE, DIGEST_ONE)],
  genuine: [1, 2, 4, 8]
};
/** Three digests, two of them free, and one other identity naming both free digests. */
export const FOLD_THREE: FoldInstance = { digests: [DIGEST_ZERO, DIGEST_ONE, DIGEST_TWO], plan: identityOf("d1", DIGEST_ZERO, DIGEST_ZERO), others: [identityOf("d2", DIGEST_ONE, DIGEST_TWO)], genuine: [1, 2, 4] };
/** Three digests, the plan's fixture and criterion apart as a real configuration's are, and one other identity sharing the criterion and naming the free digest. */
export const FOLD_PAIR: FoldInstance = { digests: [DIGEST_ZERO, DIGEST_ONE, DIGEST_TWO], plan: identityOf("d1", DIGEST_ZERO, DIGEST_ONE), others: [identityOf("d2", DIGEST_ONE, DIGEST_TWO)], genuine: [1, 2, 4] };
/** A smaller one for the variants, so each stops soon. */
export const FOLD_SMALL: FoldInstance = { digests: [DIGEST_ZERO, DIGEST_ONE], plan: identityOf("d1", DIGEST_ZERO, DIGEST_ZERO), others: [identityOf("d2", DIGEST_ONE, DIGEST_ONE)], genuine: [1, 2, 4] };

/** Who signed an entry, as the log stores it. foldEntry reads its kind and a runner's id. Every name is under a reserved one. */
export const FOLD_OWNER: Actor = { kind: "owner", iss: "https://issuer.example", sub: "owner-fold", email: "owner@issuer.example", iat: 0, exp: 0 };
export const foldRunner = (attemptId: string): Actor => ({ kind: "system:runner", attemptId });
export const FOLD_SLOTS = ["B1", "B2"] as const;
export const FOLD_CONTROL = foldRunner(CONTROL_RUN_ID);
export const FOLD_ACTORS: readonly Actor[] = [FOLD_OWNER, FOLD_CONTROL, foldRunner(FOREIGN_RUN_ID), ...FOLD_SLOTS.map((slot) => foldRunner(ATTEMPT_IDS[slot]))];

export type Role = "keep" | "row" | "control" | "manifest" | "path" | "drive";

export type FoldStep = Readonly<{
  actor: Actor;
  event: LogEvent;
  evidence: readonly string[];
  role: Role;
  /** The instance's digests the event names, read off its own fields here, as bits. */
  named: number;
  /** A manifest's paths, as bits. */
  paths: number;
  slot: SlotName | null;
  /** Which identity a control or a change names: 0 the plan's, then the others in order. */
  identity: number;
  met: boolean;
}>;

export function bitsOf(instance: FoldInstance, digests: readonly string[]): number {
  return digests.reduce((bits, digest) => {
    const at = instance.digests.indexOf(digest);
    return at < 0 ? bits : bits | (1 << at);
  }, 0);
}

export function foldStepOf(instance: FoldInstance, actor: Actor, type: string, data: LogEvent["data"], role: Role, named: readonly string[], extra: Partial<FoldStep> = {}): FoldStep {
  const event: LogEvent = { type, data };
  const decoded = decodeEvent(event);
  if (!decoded.ok) throw new Error(`The walk's own ${type} does not decode: ${decoded.refusal} at ${decoded.at}`);
  return { actor, event, evidence: digestsNamed(decoded.event), role, named: bitsOf(instance, named), paths: 0, slot: null, identity: -1, met: false, ...extra };
}

export const planStepOf = (instance: FoldInstance, actor: Actor = FOLD_OWNER): FoldStep =>
  foldStepOf(instance, actor, "case-planned", { slots: FOLD_SLOTS.map((slot) => ({ slot, attemptId: ATTEMPT_IDS[slot] })), controlRunId: CONTROL_RUN_ID, configuration: instance.plan as never }, "keep", [instance.plan.fixtureDigest, instance.plan.criterionDigest]);

/** Every event of the instance, each from the actor its rule names. */
export function foldAlphabet(instance: FoldInstance): readonly FoldStep[] {
  const steps: FoldStep[] = [];
  const add = (actor: Actor, type: string, data: LogEvent["data"], role: Role, named: readonly string[], extra: Partial<FoldStep> = {}) => steps.push(foldStepOf(instance, actor, type, data, role, named, extra));
  for (const digest of instance.digests) add(FOLD_OWNER, "plan-frozen", { planDigest: digest }, "keep", [digest]);
  [instance.plan, ...instance.others].forEach((identity, at) => {
    const named = [identity.fixtureDigest, identity.criterionDigest];
    add(FOLD_OWNER, "configuration-changed", { configuration: identity as never }, "keep", named, { identity: at });
    for (const result of ["met", "not_met", "not_evaluated"]) add(FOLD_CONTROL, "control-recorded", { configuration: identity as never, result }, "control", named, { identity: at, met: result === "met" });
  });
  for (const digest of instance.digests) add(FOLD_OWNER, "source-reconstructed", { appliesTo: ["B1"], baseCommit: "ca".repeat(20), patchDigest: digest, identity: "9a".repeat(32) }, "keep", [digest]);
  for (const slot of FOLD_SLOTS) {
    const runner = foldRunner(ATTEMPT_IDS[slot]);
    add(FOLD_OWNER, "exception-recorded", { slot, reason: "One exploratory visit while the control is looked at." }, "drive", [], { slot });
    add(FOLD_OWNER, "attempt-started", { slot }, "drive", [], { slot });
    add(FOLD_OWNER, "cleanup-confirmed", { slot }, "drive", [], { slot });
    add(runner, "attempt-finished", { slot, outcome: "failed", reason: "target-crashed" }, "drive", [], { slot });
    for (const digest of instance.digests) {
      const row = { id: `row-${slot.toLowerCase()}`, slot, instrument: "coverage", state: "present", window: { clock: "page", startMs: 1, endMs: 2 }, limits: [], digest, observation: null };
      add(runner, "evidence-recorded", { row }, "row", [digest], { slot });
    }
  }
  add(FOLD_OWNER, "case-cancelled", {}, "drive", []);
  const subsets: string[][] = [[]];
  for (const digest of instance.digests) for (const subset of [...subsets]) subsets.push([...subset, digest]);
  for (const paths of subsets) add(FOLD_OWNER, "purge-manifest-recorded", { paths }, "manifest", [], { paths: bitsOf(instance, paths) });
  for (const path of instance.digests) {
    add(FOLD_OWNER, "purge-path-absent", { path }, "path", []);
    add(FOLD_OWNER, "purge-path-remains", { path }, "path", []);
  }
  return steps;
}

/** The rule the plan states, written out here: who may sign each kind of entry. */
export function foldAllowed(step: FoldStep, actor: Actor): boolean {
  const own = step.slot !== null && actor.kind === "system:runner" && actor.attemptId === ATTEMPT_IDS[step.slot];
  if (step.role === "control") return actor.kind === "system:runner" && actor.attemptId === CONTROL_RUN_ID;
  if (step.role === "row" || step.event.type === "attempt-finished") return own;
  if (step.event.type === "cleanup-confirmed") return actor.kind === "owner" || own;
  return actor.kind === "owner";
}

/**
 * A fold state as JSON, with each of the instance's digests, identity keys, identities and ids as a
 * short token, and rebuilt by writing each token's JSON text back in its place and parsing the
 * result. A string that could be read as a token is refused, so the two directions stay one
 * another's inverse; each new state is held to that by comparing it with what its key rebuilds.
 */
export function foldCodec(instance: FoldInstance) {
  const identities = [instance.plan, ...instance.others];
  const keys = identities.map(configurationKey);
  const ids = [ATTEMPT_IDS.B1, ATTEMPT_IDS.B2, CONTROL_RUN_ID];
  const toToken = new Map<string, string>([...instance.digests.map((digest, at) => [digest, `#${at}`] as const), ...keys.map((key, at) => [key, `@${at}`] as const), ...ids.map((id, at) => [id, `&${at}`] as const)]);
  const fromToken = new Map<string, unknown>([...instance.digests.map((digest, at) => [`#${at}`, digest] as const), ...keys.map((key, at) => [`@${at}`, key] as const), ...ids.map((id, at) => [`&${at}`, id] as const), ...identities.map((identity, at) => [`%${at}`, identity] as const)]);
  const replacer = (_key: string, value: unknown): unknown => {
    if (typeof value === "string") {
      const token = toToken.get(value);
      if (token !== undefined) return token;
      holds(F.domain, !/^[#@&%]/.test(value), () => value);
      return value;
    }
    if (typeof value === "object" && value !== null && !Array.isArray(value) && "runnerImage" in value) {
      const at = keys.indexOf(configurationKey(value as ConfigurationIdentity));
      holds(F.domain, at >= 0, () => value);
      return `%${at}`;
    }
    return value;
  };
  // In the key's text a token is always a whole string: no string there begins with one of the four marks unless it is a token,
  // and a quote that a backslash escapes is inside a string, so a mark after an unescaped quote opens one.
  const tokenText = new Map<string, string>([...fromToken].map(([token, value]) => [JSON.stringify(token), JSON.stringify(value)]));
  const tokens = /(?<!\\)"[#@&%][0-9]+"/g;
  return { encode: (state: CaseState): string => JSON.stringify(state, replacer), decode: (key: string): CaseState => JSON.parse(key.replace(tokens, (text) => tokenText.get(text) ?? text)) as CaseState };
}

/**
 * The fold's shadow, read off accepted entries and never off production's bookkeeping: the digests
 * the owner's events named (case-planned, plan-frozen, configuration-changed, a patch), the digests
 * rows named, the digests a row named while the owner kept none of them (raw), the digests controls
 * named, the identity in force (0 the plan's, then the others), whether a control met under it since
 * it came into force, and the slot a pending exception is for (0 none, 1 B1, 2 B2). The masks have
 * no order: they say what was named, not which came first.
 */
export type FoldShadow = { ownerKept: number; rowNamed: number; raw: number; controlNamed: number; inForce: number; met: number; except: number };
export const packFold = (h: FoldShadow): number => (((((h.ownerKept * 8 + h.rowNamed) * 8 + h.raw) * 8 + h.controlNamed) * 8 + h.inForce) * 2 + h.met) * 4 + h.except;
export function unpackFold(packed: number): FoldShadow {
  let rest = packed;
  const take = (base: number): number => {
    const digit = rest % base;
    rest = (rest - digit) / base;
    return digit;
  };
  const except = take(4);
  const met = take(2);
  const inForce = take(8);
  const controlNamed = take(8);
  const raw = take(8);
  const rowNamed = take(8);
  return { ownerKept: rest, rowNamed, raw, controlNamed, inForce, met, except };
}

export type FoldWalk = Readonly<{ states: number; edges: number; splits: number; summary: number; seen: Readonly<Record<string, number>> }>;

export function growLongs(array: Uint32Array<ArrayBuffer>, need: number): Uint32Array<ArrayBuffer> {
  if (need <= array.length) return array;
  const bigger = new Uint32Array(Math.max(need, array.length * 2));
  bigger.set(array);
  return bigger;
}

export const FOLD_MACHINE_ACTORS: readonly MachineActor[] = [{ kind: "owner" }, ...[CONTROL_RUN_ID, FOREIGN_RUN_ID, ATTEMPT_IDS.B1, ATTEMPT_IDS.B2].map((attemptId): MachineActor => ({ kind: "system:runner", attemptId }))];

/** Record events no fold step sends, each from every actor its rule does not allow, probed on every fold state's own record. */
export function foldRecordProbes(): readonly RecordProbe[] {
  const probes: RecordProbe[] = [];
  const owned: readonly RecordEvent[] = [
    { type: "assertion-recorded", id: "said-probe", statement: "Someone said so." },
    { type: "unknown-recorded", unknown: { id: "question-probe", question: "What?", reason: "Nothing showed.", detail: null, wouldResolve: null } },
    { type: "source-reconstructed", appliesTo: ["B1"], baseCommit: "ca".repeat(20), patchDigest: "ab".repeat(32), identity: "9a".repeat(32) }
  ];
  for (const event of owned) for (const by of FOLD_MACHINE_ACTORS) if (by.kind !== "owner") probes.push({ event, by });
  for (const slot of FOLD_SLOTS) {
    for (const event of [
      { type: "instrument-recorded", slot, instrument: "coverage", completeness: "complete", reason: null },
      { type: "source-recorded", slot, commit: "c0".repeat(20), identity: "9b".repeat(32) }
    ] as const) {
      for (const by of FOLD_MACHINE_ACTORS) if (!(by.kind === "system:runner" && by.attemptId === ATTEMPT_IDS[slot])) probes.push({ event, by });
    }
  }
  return probes;
}

export const GENUINE: Readonly<Record<number, string>> = {
  1: "a fixture run's capture, byte-equal to its fixture",
  2: "the owner adopting an identity a control missed under",
  4: "a control re-recorded for the plan's identity, a row having named its fixture",
  8: "a change keeping a fixture the case already keeps, a row having named it"
};

/** Breadth first from the instance's case-planned, every fold property on every state and accepted entry, or only those in `only`. */
export function walkFold({ store, evidence = productionEvidence, instance, only }: Readonly<{ store: StoreModule; evidence?: EvidenceModule; instance: FoldInstance; only?: readonly string[] }>): FoldWalk {
  const on = (name: string): boolean => only === undefined || only.includes(name);
  const check = Object.fromEntries(Object.entries(F).map(([key, name]) => [key, on(name)])) as Record<keyof typeof F, boolean>;
  const alphabet = foldAlphabet(instance);
  const codec = foldCodec(instance);
  const probes = check.authority ? foldRecordProbes() : [];
  const bits = (digests: readonly string[]) => bitsOf(instance, digests);
  const planFixture = bits([instance.plan.fixtureDigest]);
  const seen: Record<string, number> = {};
  const count = (name: string) => {
    seen[name] = (seen[name] ?? 0) + 1;
  };
  const fresh = new Map<number, FoldStep>();
  /** The same owner's event, naming fresh bytes where it named a raw digest or a listed path. */
  const counterfactual = (at: number, step: FoldStep, blocked: number): FoldStep => {
    const cached = fresh.get(at * 8 + blocked);
    if (cached !== undefined) return cached;
    const swap = (digest: unknown): string => ((bits([digest as string]) & blocked) !== 0 ? FRESH : (digest as string));
    const data = step.event.data as Readonly<Record<string, unknown>>;
    const swapped =
      step.event.type === "plan-frozen"
        ? { planDigest: swap(data.planDigest) }
        : step.event.type === "source-reconstructed"
          ? { ...data, patchDigest: swap(data.patchDigest) }
          : { configuration: { ...(data.configuration as ConfigurationIdentity), fixtureDigest: swap((data.configuration as ConfigurationIdentity).fixtureDigest), criterionDigest: swap((data.configuration as ConfigurationIdentity).criterionDigest) } };
    const made = foldStepOf(instance, step.actor, step.event.type, swapped as unknown as LogEvent["data"], step.role, []);
    fresh.set(at * 8 + blocked, made);
    return made;
  };
  const slotIndexOf = (slot: SlotName | null): number => (slot === "B1" ? 1 : slot === "B2" ? 2 : 0);

  const planStep = planStepOf(instance);
  if (check.authority) {
    for (const actor of FOLD_ACTORS) {
      if (actor.kind === "owner") continue;
      const answer = store.foldEntry(null, { actor, events: [planStep.event], evidence: planStep.evidence, seq: 1 });
      holds(F.authority, !answer.ok, () => ({ actor, answer }));
    }
  }
  const first = store.foldEntry(null, { actor: FOLD_OWNER, events: [planStep.event], evidence: planStep.evidence, seq: 1 });
  holds(F.domain, first.ok, () => first);
  const firstState = (first as Extract<typeof first, { ok: true }>).state;
  const firstKey = codec.encode(firstState);
  holds(F.domain, JSON.stringify(codec.decode(firstKey)) === JSON.stringify(firstState), () => firstState);
  const byKey = new Map<string, number>([[firstKey, 0]]);
  const keys: string[] = [firstKey];
  let shadows = new Uint32Array(1 << 12);
  shadows[0] = packFold({ ownerKept: planStep.named, rowNamed: 0, raw: 0, controlNamed: 0, inForce: 0, met: 0, except: 0 });
  let chain = new Int32Array(1 << 12).fill(-1);
  let offsets = new Int32Array(1 << 12);
  let targets = new Int32Array(1 << 14);
  let summaries = new Uint8Array(1 << 12);
  let genuine = new Uint8Array(1 << 12);
  let edges = 0;
  let splits = 0;
  let summary = 0;

  for (let at = 0; at < keys.length; at += 1) {
    const state = codec.decode(keys[at]);
    const shadow = unpackFold(shadows[at]);
    offsets = grow(offsets, at + 2);
    offsets[at] = edges;
    const { machine } = state;
    const manifest = machine.purge;
    const closed = machine.closedBy !== null;
    const listed = manifest === null ? 0 : bits(manifest.map(({ path }) => path));
    // The subject state's own list of what it keeps, read beside the shadow: these two oracles hold each against the other.
    const kept = bits(state.keptObjects);
    const named = shadow.ownerKept | shadow.rowNamed | shadow.controlNamed;
    const isSummary = manifest !== null && manifest.every(({ state: status }) => status === "absent");
    const begun = machine.attempts.some(({ phase }) => phase !== "planned" && phase !== "not_started");
    const purgeSet = (shadow.rowNamed | shadow.controlNamed) & ~shadow.ownerKept;
    const phaseOf = (slot: SlotName | null): AttemptPhase | null => machine.attempts.find((attempt) => attempt.slot === slot)?.phase ?? null;
    summaries = growBytes(summaries, at + 1);
    if (isSummary) {
      summaries[at] = 1;
      summary += 1;
    }
    if (check.summary && isSummary) holds(F.summary, (named & ~(shadow.ownerKept | listed)) === 0, () => ({ state, shadow }));
    if (check.apart) holds(F.apart, (listed & shadow.ownerKept) === 0 && (listed & kept) === 0, () => ({ state, shadow }));
    if (check.rawStays) holds(F.rawStays, (shadow.raw & shadow.ownerKept) === 0 && (shadow.raw & kept) === 0, () => ({ state, shadow }));
    if (state.record.rows.some(({ state: rowState }) => rowState === "late")) count("a late row on record");
    if (check.planOnce) {
      // Code only (applyEvent's already-planned, case-store.ts:142): a log holds one plan; a second case-planned on a planned case is refused, from anyone.
      const again = store.foldEntry(state, { actor: FOLD_OWNER, events: [planStep.event], evidence: planStep.evidence, seq: 2 });
      holds(F.planOnce, !again.ok, () => ({ state, again }));
    }
    if (check.authority) {
      for (const { event, by } of probes) {
        const answer = evidence.applyRecordEvent(state.record, event, by, machine, 2);
        if (answer.ok) holds(F.authority, false, () => ({ state, event, by }));
      }
    }

    for (let index = 0; index < alphabet.length; index += 1) {
      const step = alphabet[index];
      const answer = store.foldEntry(state, { actor: step.actor, events: [step.event], evidence: step.evidence, seq: 2 });
      if (step.role === "manifest") {
        if (closed && manifest === null) {
          if (check.manifest) {
            holds(F.manifest, !answer.ok || step.paths === purgeSet, () => ({ state, shadow, paths: step.event.data, answer }));
            if (step.paths === purgeSet && (step.paths !== 0 || !begun)) holds(F.manifest, answer.ok, () => ({ state, shadow, paths: step.event.data, answer }));
          }
          if (check.empty && answer.ok && step.paths === 0) holds(F.empty, !begun, () => ({ state, answer }));
        } else if (check.manifest) {
          holds(F.manifest, !answer.ok, () => ({ state, paths: step.event.data, answer }));
        }
      }
      const blocked = step.role === "keep" ? step.named & (shadow.raw | listed) : 0;
      if (check.refusal) {
        if (blocked !== 0) {
          const other = counterfactual(index, step, blocked);
          const plain = store.foldEntry(state, { actor: other.actor, events: [other.event], evidence: other.evidence, seq: 2 });
          holds(F.refusal, !answer.ok && (plain.ok ? answer.refusal === "raw-object-cannot-be-kept" : answer.refusal === plain.refusal), () => ({ state, shadow, event: step.event, answer, plain }));
        } else {
          holds(F.refusal, answer.ok || answer.refusal !== "raw-object-cannot-be-kept", () => ({ state, shadow, event: step.event, answer }));
        }
      }
      if (check.rowTaken && step.role === "row") {
        // Code and W: a row is its own runner's, for an attempt that began, under an id no row holds, and none after a manifest.
        const phase = phaseOf(step.slot);
        const id = ((step.event.data as Readonly<{ row: { id: string } }>).row).id;
        const expected = phase !== null && phase !== "planned" && phase !== "not_started" && !state.record.rows.some((row) => row.id === id) && manifest === null;
        holds(F.rowTaken, answer.ok === expected, () => ({ state, event: step.event, answer, expected }));
      }
      if (check.patch && step.event.type === "source-reconstructed" && blocked === 0) {
        // W: a source identity can be reconstructed once, only for an attempt that ended.
        const expected = state.record.reconstructedSource === null && OUTCOME.has(phaseOf("B1") as AttemptPhase);
        holds(F.patch, answer.ok === expected, () => ({ state, event: step.event, answer, expected }));
      }
      if (!answer.ok) {
        if (answer.refusal === "raw-object-cannot-be-kept") count(manifest === null ? "raw-object-cannot-be-kept before a manifest" : "raw-object-cannot-be-kept after a manifest");
        else if (["manifest-not-the-evidence", "manifest-empty-after-a-visit", "evidence-after-manifest"].includes(answer.refusal)) count(answer.refusal);
        continue;
      }
      const next = answer.state;
      const after: FoldShadow = { ...shadow };
      if (step.role === "keep") after.ownerKept |= step.named;
      if (step.role === "row") {
        after.rowNamed |= step.named;
        after.raw |= step.named & ~shadow.ownerKept;
      }
      if (step.role === "control") {
        after.controlNamed |= step.named;
        if (step.met && step.identity === shadow.inForce) after.met = 1;
      }
      if (step.event.type === "configuration-changed") {
        after.inForce = step.identity;
        after.met = 0;
        after.except = 0;
      }
      if (step.event.type === "exception-recorded") after.except = slotIndexOf(step.slot);
      if (step.event.type === "attempt-started") after.except = 0;
      if (next.machine.closedBy !== null) {
        after.met = 0;
        after.except = 0;
      }
      const nextShadow = packFold(after);
      if (check.authority) {
        for (const actor of FOLD_ACTORS) {
          if (foldAllowed(step, actor)) continue;
          const resent = store.foldEntry(state, { actor, events: [step.event], evidence: step.evidence, seq: 2 });
          holds(F.authority, !resent.ok, () => ({ state, event: step.event, actor }));
        }
      }
      for (const [position, attempt] of machine.attempts.entries()) {
        const now = next.machine.attempts[position];
        if (attempt.phase !== "planned" || now.phase === "planned" || now.phase === "not_started") continue;
        // A visit began on this entry.
        const mine = slotIndexOf(attempt.slot);
        if (check.control) holds(F.control, shadow.met === 1 || shadow.except === mine, () => ({ state, shadow, event: step.event }));
        if (check.basis) {
          // H, W: a visit with both an exception and a met control rests on the exception.
          const basis = shadow.except === mine ? "exception" : "control";
          const bases = next.record.visitBases;
          holds(F.basis, bases.length === state.record.visitBases.length + 1 && bases[bases.length - 1].slot === attempt.slot && bases[bases.length - 1].basis === basis, () => ({ state, shadow, bases }));
          count(`a visit on ${basis === "exception" ? "an exception" : "a control"}`);
        }
      }
      if (check.late && step.role === "row") {
        // H (case-machine.ts:36 to 37) and the addRow comment in evidence-model.ts: a row that arrives after its attempt ended is kept and labeled late, whatever it claimed.
        const rows = next.record.rows;
        const last = rows[rows.length - 1];
        const expected = OUTCOME.has(phaseOf(step.slot) as AttemptPhase) ? "late" : "present";
        holds(F.late, rows.length === state.record.rows.length + 1 && last.id === ((step.event.data as Readonly<{ row: { id: string } }>).row).id && last.state === expected, () => ({ state, event: step.event, last }));
      }
      if (step.event.type === "source-reconstructed") count("a patch taken");
      // The genuine paths, each seen as an accepted edge. The masks have no order, so "having named" is all a path can say of its row.
      const inForce = state.configurations[state.configurations.length - 1];
      let kind = 0;
      if (step.role === "row" && (step.named & bits([inForce.fixtureDigest])) !== 0) kind |= 1;
      if (step.event.type === "configuration-changed" && (step.named & shadow.controlNamed & ~shadow.ownerKept) !== 0) kind |= 2;
      if (step.role === "control" && step.identity === 0 && step.met && (shadow.rowNamed & planFixture) !== 0 && (shadow.controlNamed & planFixture) !== 0) kind |= 4;
      if (step.event.type === "configuration-changed" && (step.named & shadow.ownerKept & shadow.rowNamed) !== 0) kind |= 8;
      if (step.role === "manifest") count(`a manifest of ${step.event.data.paths instanceof Array ? step.event.data.paths.length : 0} taken`);
      if (step.event.type === "purge-path-remains") count("a path read remaining");

      const key = codec.encode(next);
      let target = byKey.get(key);
      const head = target;
      while (target !== undefined && target >= 0 && shadows[target] !== nextShadow) target = chain[target];
      if (target === undefined || target < 0) {
        target = keys.length;
        keys.push(key);
        shadows = growLongs(shadows, target + 1);
        chain = grow(chain, target + 1);
        shadows[target] = nextShadow;
        if (head === undefined) {
          byKey.set(key, target);
          chain[target] = -1;
        } else {
          chain[target] = chain[head];
          chain[head] = target;
          splits += 1;
        }
        holds(F.domain, JSON.stringify(codec.decode(key)) === JSON.stringify(next), () => ({ next }));
      }
      if (kind !== 0) {
        genuine = growBytes(genuine, target + 1);
        genuine[target] |= kind;
        for (const bit of [1, 2, 4, 8]) if ((kind & bit) !== 0) count(GENUINE[bit]);
      }
      targets = grow(targets, edges + 1);
      targets[edges] = target;
      edges += 1;
    }
  }
  offsets[keys.length] = edges;

  if (check.genuine) {
    // Which states can still reach SUMMARY_ONLY, by walking the edges backward from every state that reads it.
    const total = keys.length;
    const incoming = new Int32Array(total + 1);
    for (let edge = 0; edge < edges; edge += 1) incoming[targets[edge] + 1] += 1;
    for (let node = 0; node < total; node += 1) incoming[node + 1] += incoming[node];
    const sources = new Int32Array(edges);
    const fill = incoming.slice(0, total);
    for (let node = 0; node < total; node += 1) for (let edge = offsets[node]; edge < offsets[node + 1]; edge += 1) sources[fill[targets[edge]]++] = node;
    const reaches = new Uint8Array(total);
    const pending: number[] = [];
    for (let node = 0; node < total; node += 1) {
      if (summaries[node] !== 1) continue;
      reaches[node] = 1;
      pending.push(node);
    }
    while (pending.length > 0) {
      const node = pending.pop() as number;
      for (let edge = incoming[node]; edge < incoming[node + 1]; edge += 1) {
        const source = sources[edge];
        if (reaches[source] === 0) {
          reaches[source] = 1;
          pending.push(source);
        }
      }
    }
    for (const kind of instance.genuine) {
      let found = false;
      for (let node = 0; node < total && !found; node += 1) found = (genuine[node] & kind) !== 0 && reaches[node] === 1;
      holds(F.genuine, found, () => ({ path: GENUINE[kind], accepted: seen[GENUINE[kind]] ?? 0 }));
    }
  }
  return { states: keys.length, edges, splits, summary, seen };
}

/** The rules this list names are each reached in this instance, so none of the properties above holds by being out of reach. */
export function assertFoldCovered(walk: FoldWalk, largestManifest: number): void {
  assert.equal(walk.splits, 0, "the shadow is a function of a correct fold state, so it splits none");
  assert.ok(walk.summary > 0, "SUMMARY_ONLY is reached");
  for (const name of [
    "raw-object-cannot-be-kept before a manifest",
    "raw-object-cannot-be-kept after a manifest",
    "manifest-not-the-evidence",
    "manifest-empty-after-a-visit",
    "evidence-after-manifest",
    "a late row on record",
    "a path read remaining",
    "a visit on an exception",
    "a visit on a control",
    "a patch taken",
    ...Object.values(GENUINE)
  ]) {
    assert.ok((walk.seen[name] ?? 0) > 0, name);
  }
  for (let size = 0; size <= largestManifest; size += 1) assert.ok((walk.seen[`a manifest of ${size} taken`] ?? 0) > 0, `a manifest of ${size}`);
  assert.equal(walk.seen[`a manifest of ${largestManifest + 1} taken`], undefined);
}

export let injected = 0;

/** The store compiled over a given machine or evidence model, so a variant of either reaches the fold. Production is untouched. */
export function storeOver(modules: Readonly<{ machine?: MachineModule; evidence?: EvidenceModule }>, edits: readonly SourceEdit[] = []): StoreModule {
  const redirected: SourceEdit[] = [];
  for (const [name, module] of [
    ["./case-machine", modules.machine],
    ["./evidence-model", modules.evidence]
  ] as const) {
    if (module === undefined) continue;
    const key = `caseExplorationModule${(injected += 1)}`;
    (globalThis as Record<string, unknown>)[key] = module;
    redirected.push({ find: `require("${name}")`, replace: `globalThis.${key}` });
  }
  return loadVariant<StoreModule>(require.resolve("../core/case-store"), [...redirected, ...edits]);
}


/** Which fold instance, which properties, and which variant of the store, machine or evidence model, as plain data a worker can take. */
export type FoldSetup = Readonly<{ instance: keyof typeof FOLD_INSTANCES; only?: readonly string[]; storeEdits?: readonly SourceEdit[]; machineEdits?: readonly SourceEdit[]; evidenceEdits?: readonly SourceEdit[] }>;

export const FOLD_INSTANCES = { FOLD_TWO, FOLD_PAIR, FOLD_THREE, FOLD_SMALL } as const;

/** A fold walk from plain data: production, or the variant its edits name. A worker runs this. */
export function walkFoldSetup(setup: FoldSetup): FoldWalk {
  const machine = setup.machineEdits === undefined ? undefined : machineVariant(...setup.machineEdits);
  const evidence = setup.evidenceEdits === undefined ? undefined : evidenceVariant(...setup.evidenceEdits);
  const edits = setup.storeEdits ?? [];
  const store = machine !== undefined || evidence !== undefined ? storeOver({ machine, evidence }, edits) : edits.length > 0 ? storeVariant(...edits) : productionStore;
  return walkFold({ store, evidence, instance: FOLD_INSTANCES[setup.instance], only: setup.only });
}
