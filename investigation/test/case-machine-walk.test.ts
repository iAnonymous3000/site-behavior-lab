import assert from "node:assert/strict";
import { test } from "node:test";
import { assertCaughtBy, holds, loadVariant, type SourceEdit } from "../../lib/finite-check";
import * as production from "../core/case-machine";
import type { AttemptState, MachineActor, MachineEvent, MachineState, PlanInput, SlotName } from "../core/case-machine";
import * as evidenceModule from "../core/evidence-model";
import type { RecordEvent } from "../core/evidence-model";
import { ATTEMPT_IDS, CONFIG_A, CONFIG_B, CONTROL_RUNNER, FOREIGN_RUNNER, OWNER, PLAN_DIGEST, planOf, runnerOf, type MachineModule } from "./case-fixture";

/**
 * Every state a small plan can reach, by trying every event of a finite alphabet from every
 * state found, against a plain model kept here. This is the small sibling of the full
 * exploration a later batch runs over all six slots, which is why it stays on small plans.
 *
 * The model RESTATES the machine's rules, in order, on purpose: it is a second writing of
 * the same table, so a change to either shows up as a disagreement, and what it establishes
 * is that the two writings agree on every (state, event) pair in the domain, down to which
 * refusal answers. It says nothing about whether the rules are the right ones. The
 * properties further down are stated apart from both, over states and transitions.
 */

const machineVariant = (...edits: SourceEdit[]) => loadVariant<MachineModule>(require.resolve("../core/case-machine"), edits);

type ModelAnswer = Readonly<{ refusal: string }> | Readonly<{ state: MachineState }>;

const OUTCOMES = ["usable", "walled", "failed", "incomplete", "timed_out", "cancelled"] as const;
const RUNNING = new Set(["starting", "capturing", "finalizing"]);
const SETTLED = new Set(["usable", "walled", "failed", "incomplete", "timed_out", "cancelled", "not_started"]);

function cloned(state: MachineState): { -readonly [K in keyof MachineState]: MachineState[K] } & { attempts: { -readonly [K in keyof AttemptState]: AttemptState[K] }[] } {
  return JSON.parse(JSON.stringify(state));
}

/** The machine's table, written out a second time. See the note above. */
function modelStep(state: MachineState, event: MachineEvent): ModelAnswer {
  const refuse = (refusal: string): ModelAnswer => ({ refusal });
  const by: MachineActor = event.by;
  const owner = by.kind === "owner";
  const own = (attempt: AttemptState) => by.kind === "system:runner" && by.attemptId === attempt.attemptId;
  const closed = state.closedBy !== null;
  const notFrozen = state.planDigest === null;
  const anyRunning = state.attempts.some(({ phase }) => RUNNING.has(phase));
  const nextIndex = state.attempts.findIndex(({ phase }) => phase === "planned");
  const atSlot = (slot: SlotName) => state.attempts.findIndex((attempt) => attempt.slot === slot);
  const closeOut = (next: ReturnType<typeof cloned>, runningOutcome: AttemptState["phase"], closedBy: NonNullable<MachineState["closedBy"]>) => {
    for (const attempt of next.attempts) {
      if (RUNNING.has(attempt.phase)) {
        attempt.phase = runningOutcome;
        attempt.startRetries = 0;
      } else if (attempt.phase === "planned") {
        attempt.phase = "not_started";
        attempt.configuration = state.configuration;
      }
    }
    next.closedBy = closedBy;
    next.controlMet = false;
    next.controlMisses = 0;
    next.exceptionFor = null;
  };
  const closeWhenAllSettled = (next: ReturnType<typeof cloned>) => {
    if (next.closedBy === null && next.attempts.every(({ phase }) => SETTLED.has(phase))) {
      next.closedBy = "completed";
      next.controlMet = false;
      next.controlMisses = 0;
      next.exceptionFor = null;
    }
  };

  switch (event.type) {
    case "plan-frozen": {
      if (!owner) return refuse("owner-only");
      if (closed) return refuse("case-closed");
      if (!notFrozen) return refuse("plan-already-frozen");
      const next = cloned(state);
      next.planDigest = event.planDigest;
      return { state: next };
    }
    case "control-recorded": {
      if (by.kind !== "system:runner") return refuse("runner-only");
      if (by.attemptId !== state.controlRunId) return refuse("not-this-case");
      if (closed) return refuse("case-closed");
      if (notFrozen) return refuse("plan-not-frozen");
      if (anyRunning) return refuse("another-attempt-running");
      if (state.controlMet) return refuse("control-already-met");
      if (state.controlMisses >= 2) return refuse("control-limit");
      const next = cloned(state);
      if (event.configuration === state.configuration && event.result === "met") {
        next.controlMet = true;
        next.controlMisses = 0;
      } else {
        next.controlMisses += 1;
      }
      return { state: next };
    }
    case "configuration-changed": {
      if (!owner) return refuse("owner-only");
      if (closed) return refuse("case-closed");
      if (notFrozen) return refuse("plan-not-frozen");
      if (anyRunning) return refuse("another-attempt-running");
      if (state.baselineRule === "met") return refuse("configuration-after-rule");
      if (state.configurationChanges >= 1) return refuse("configuration-change-spent");
      if (event.configuration === state.configuration) return refuse("configuration-unchanged");
      if (state.baselineRule === "pending") {
        const baseline = state.attempts.filter(({ arm }) => arm === "baseline");
        const waiting = baseline.filter(({ phase }) => phase === "planned").length;
        if (waiting < (baseline.length < 2 ? baseline.length : 2)) return refuse("configuration-floor-unreachable");
      }
      const next = cloned(state);
      next.configuration = event.configuration;
      next.configurationChanges += 1;
      next.controlMet = false;
      next.controlMisses = 0;
      next.exceptionFor = null;
      return { state: next };
    }
    case "exception-recorded": {
      if (!owner) return refuse("owner-only");
      const index = atSlot(event.slot);
      if (index < 0) return refuse("no-such-slot");
      if (closed) return refuse("case-closed");
      if (notFrozen) return refuse("plan-not-frozen");
      if (state.attempts[index].phase !== "planned") return refuse("exception-after-visit");
      if (state.exceptionFor !== null) return refuse("exception-pending");
      if (index !== nextIndex) return refuse("exception-not-next");
      const next = cloned(state);
      next.exceptionFor = event.slot;
      next.exploratory = true;
      return { state: next };
    }
    case "baseline-rule-recorded": {
      if (!owner) return refuse("owner-only");
      if (closed) return refuse("case-closed");
      if (state.baselineRule === "not_applicable") return refuse("no-baseline");
      if (state.baselineRule !== "pending") return refuse("baseline-rule-already-recorded");
      const baseline = state.attempts.filter(({ arm }) => arm === "baseline");
      if (baseline.some(({ phase }) => !SETTLED.has(phase))) return refuse("baseline-not-finished");
      const next = cloned(state);
      if (event.result === "not_met") {
        next.baselineRule = "not_met";
        closeOut(next, "failed", "baseline_not_met");
        return { state: next };
      }
      const usable = baseline.filter(({ phase, configuration }) => phase === "usable" && configuration === state.configuration).length;
      if (usable < (baseline.length >= 2 ? 2 : baseline.length)) return refuse("baseline-floor-unmet");
      next.baselineRule = "met";
      return { state: next };
    }
    case "attempt-started": {
      if (!owner) return refuse("owner-only");
      const index = atSlot(event.slot);
      if (index < 0) return refuse("no-such-slot");
      const attempt = state.attempts[index];
      if (closed) return refuse("case-closed");
      if (notFrozen) return refuse("plan-not-frozen");
      if (attempt.phase !== "planned") return refuse("attempt-already-begun");
      if (anyRunning) return refuse("another-attempt-running");
      if (index !== nextIndex) return refuse("not-next-slot");
      if (state.attempts.some(({ cleanup }) => cleanup === "pending" || cleanup === "unconfirmed")) return refuse("cleanup-unresolved");
      if (attempt.arm === "instrumented" && state.baselineRule === "pending") return refuse("baseline-rule-pending");
      if (state.exceptionFor !== event.slot && !state.controlMet) return refuse("no-valid-control");
      const next = cloned(state);
      next.attempts[index].phase = "starting";
      next.attempts[index].cleanup = "pending";
      next.attempts[index].configuration = state.configuration;
      next.exceptionFor = null;
      return { state: next };
    }
    case "attempt-start-retried":
    case "capture-began":
    case "capture-finished":
    case "attempt-finished":
    case "evidence-recorded": {
      const index = atSlot(event.slot);
      if (index < 0) return refuse("no-such-slot");
      const attempt = state.attempts[index];
      if (!own(attempt)) return refuse("not-this-attempt");
      const next = cloned(state);
      const target = next.attempts[index];
      if (event.type === "attempt-start-retried") {
        if (attempt.phase !== "starting") return refuse("wrong-phase");
        if (attempt.startRetries >= 2) return refuse("start-retry-limit");
        target.startRetries += 1;
      } else if (event.type === "capture-began") {
        if (attempt.phase !== "starting") return refuse("wrong-phase");
        target.phase = "capturing";
        target.startRetries = 0;
      } else if (event.type === "capture-finished") {
        if (attempt.phase !== "capturing") return refuse("wrong-phase");
        target.phase = "finalizing";
      } else if (event.type === "attempt-finished") {
        if (!RUNNING.has(attempt.phase)) return refuse("wrong-phase");
        const allowed: readonly string[] = attempt.phase === "starting" ? ["failed"] : attempt.phase === "capturing" ? ["failed", "walled"] : ["usable", "incomplete", "walled", "failed"];
        if (!allowed.includes(event.outcome)) return refuse("outcome-not-reachable");
        target.phase = event.outcome;
        target.startRetries = 0;
        closeWhenAllSettled(next);
      } else {
        if (attempt.phase === "planned" || attempt.phase === "not_started") return refuse("attempt-not-begun");
        if (state.attempts.some(({ evidence }) => evidence.includes(event.id))) return refuse("evidence-duplicate");
        target.evidence = [...attempt.evidence, event.id];
      }
      return { state: next };
    }
    case "attempt-deadline": {
      if (!owner) return refuse("owner-only");
      const index = atSlot(event.slot);
      if (index < 0) return refuse("no-such-slot");
      if (!RUNNING.has(state.attempts[index].phase)) return refuse("wrong-phase");
      const next = cloned(state);
      next.attempts[index].phase = "timed_out";
      next.attempts[index].startRetries = 0;
      closeWhenAllSettled(next);
      return { state: next };
    }
    case "case-deadline":
    case "case-cancelled": {
      if (!owner) return refuse("owner-only");
      if (closed) return refuse("case-closed");
      const next = cloned(state);
      if (event.type === "case-cancelled") closeOut(next, "cancelled", "cancelled");
      else closeOut(next, "timed_out", "deadline");
      return { state: next };
    }
    case "reconcile": {
      if (!owner) return refuse("owner-only");
      const next = cloned(state);
      const running = state.attempts.findIndex(({ phase }) => RUNNING.has(phase));
      if (running >= 0) {
        next.attempts[running].phase = "failed";
        next.attempts[running].cleanup = "unconfirmed";
        next.attempts[running].startRetries = 0;
        closeWhenAllSettled(next);
        return { state: next };
      }
      if (!state.attempts.some(({ cleanup }) => cleanup === "pending")) return refuse("nothing-to-reconcile");
      for (const attempt of next.attempts) if (attempt.cleanup === "pending") attempt.cleanup = "unconfirmed";
      return { state: next };
    }
    case "cleanup-confirmed":
    case "cleanup-unconfirmed":
    case "environment-destroyed": {
      const index = atSlot(event.slot);
      if (index < 0) return refuse("no-such-slot");
      const attempt = state.attempts[index];
      if (!owner && !own(attempt)) return refuse("not-this-attempt");
      if (attempt.cleanup === null) return refuse("no-cleanup");
      if (RUNNING.has(attempt.phase)) return refuse("attempt-running");
      if (attempt.cleanup === "confirmed" || attempt.cleanup === "environment_destroyed") return refuse("cleanup-settled");
      if (event.type === "cleanup-unconfirmed" && attempt.cleanup === "unconfirmed") return refuse("cleanup-settled");
      const next = cloned(state);
      next.attempts[index].cleanup = event.type === "cleanup-confirmed" ? "confirmed" : event.type === "cleanup-unconfirmed" ? "unconfirmed" : "environment_destroyed";
      return { state: next };
    }
    case "purge-manifest-recorded":
    case "purge-path-absent":
    case "purge-path-remains": {
      if (!owner) return refuse("owner-only");
      if (!closed) return refuse("case-open");
      const next = cloned(state);
      if (event.type === "purge-manifest-recorded") {
        if (state.purge !== null) return refuse("manifest-already-recorded");
        next.purge = event.paths.map((path) => ({ path, state: "present" }));
        return { state: next };
      }
      const listed = state.purge?.find(({ path }) => path === event.path);
      if (listed === undefined) return refuse("no-such-path");
      const status = event.type === "purge-path-absent" ? "absent" : "remains";
      if (listed.state === status) return refuse("path-status-unchanged");
      next.purge = (state.purge as NonNullable<MachineState["purge"]>).map((entry) => (entry.path === event.path ? { path: event.path, state: status } : entry));
      return { state: next };
    }
    default:
      return refuse("unknown-event");
  }
}

const OUTCOME_EVENTS = ["usable", "walled", "failed", "incomplete"] as const;

/** The usual actor for each event. Every event of this alphabet is tried from every state. Evidence is given as how many ids each slot's runner can name. */
function plainAlphabet(plan: PlanInput, evidenceIds = 0): readonly MachineEvent[] {
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
  for (const configuration of [CONFIG_A, CONFIG_B]) {
    for (const result of ["met", "not_met", "not_evaluated"] as const) events.push({ type: "control-recorded", configuration, result, by: CONTROL_RUNNER });
  }
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
    for (const outcome of OUTCOME_EVENTS) events.push({ type: "attempt-finished", slot, outcome, by });
    for (let index = 0; index < evidenceIds; index += 1) events.push({ type: "evidence-recorded", slot, id: `row-${index}-of-${ATTEMPT_IDS[slot].slice(0, 4)}`, by });
  }
  return events;
}

/** The same events, each from every kind of actor there is, including one from another case. */
function everyActorAlphabet(plan: PlanInput): readonly MachineEvent[] {
  const actors: readonly MachineActor[] = [OWNER, CONTROL_RUNNER, FOREIGN_RUNNER, ...plan.slots.map(({ slot }) => runnerOf(slot))];
  return plainAlphabet(plan, 1).flatMap((event) => actors.map((by) => ({ ...event, by })));
}

type Explored = Readonly<{ states: readonly MachineState[]; edges: readonly (readonly number[])[]; refusedPairs: number }>;

type Hooks = Readonly<{
  onPair?: (state: MachineState, event: MachineEvent, answer: production.StepResult) => void;
  onState?: (state: MachineState) => void;
}>;

/** Breadth first from the plan's first state. Equal states are equal JSON, since every path builds a field in the same order. */
function explore(module: MachineModule, plan: PlanInput, alphabet: readonly MachineEvent[], hooks: Hooks = {}): Explored {
  const first = module.plannedState(plan);
  assert.ok(first.ok);
  const indexOf = new Map<string, number>([[JSON.stringify(first.state), 0]]);
  const states: MachineState[] = [first.state];
  const edges: number[][] = [[]];
  let refusedPairs = 0;
  for (let at = 0; at < states.length; at += 1) {
    const state = states[at];
    hooks.onState?.(state);
    for (const event of alphabet) {
      const answer = module.step(state, event);
      hooks.onPair?.(state, event, answer);
      if (!answer.ok) {
        refusedPairs += 1;
        continue;
      }
      const key = JSON.stringify(answer.state);
      let target = indexOf.get(key);
      if (target === undefined) {
        target = states.length;
        indexOf.set(key, target);
        states.push(answer.state);
        edges.push([]);
      }
      edges[at].push(target);
    }
  }
  return { states, edges, refusedPairs };
}

/** Every (state, event) pair agrees with the model, down to the refusal and the next state's bytes. */
function agreesWithModel(module: MachineModule, plan: PlanInput, alphabet: readonly MachineEvent[]): Explored {
  return explore(module, plan, alphabet, {
    onPair(state, event, answer) {
      const expected = modelStep(state, event);
      if ("refusal" in expected) {
        holds("the machine equals the plain model", !answer.ok && answer.refusal === expected.refusal, () => ({ state, event, answer, expected }));
      } else {
        holds("the machine equals the plain model", answer.ok && JSON.stringify(answer.state) === JSON.stringify(expected.state), () => ({ state, event, answer, expected }));
      }
    }
  });
}

/**
 * What must hold over all reachable states and transitions, each stated apart from the model
 * and from the machine, by reading the states the machine produced.
 */
function holdsInvariants(module: MachineModule, plan: PlanInput, alphabet: readonly MachineEvent[]): Explored {
  const seenOutcome = new Set<string>(OUTCOMES);
  return explore(module, plan, alphabet, {
    onState(state) {
      const count = (names: readonly string[]) => state.attempts.filter(({ phase }) => names.includes(phase)).length;
      const running = count(["starting", "capturing", "finalizing"]);
      const terminal = count(["usable", "walled", "failed", "incomplete", "timed_out", "cancelled"]);
      const notStarted = count(["planned", "not_started"]);
      const denominator = module.denominatorOf(state);
      holds("planned equals running plus terminal plus not_started", denominator.planned === plan.slots.length && denominator.planned === running + terminal + notStarted, () => state);
      holds(
        "planned equals running plus terminal plus not_started",
        denominator.running === running &&
          denominator.notStarted === notStarted &&
          denominator.usable + denominator.walled + denominator.failed + denominator.incomplete + denominator.timed_out + denominator.cancelled === terminal,
        () => ({ state, denominator })
      );
      for (const outcome of OUTCOMES) holds("planned equals running plus terminal plus not_started", denominator[outcome] === count([outcome]), () => ({ state, denominator, outcome }));
      holds("at most one attempt runs", running <= 1, () => state);
      holds("retry counters stay within their caps", state.controlMisses <= 2 && state.attempts.every(({ startRetries }) => startRetries <= 2) && state.configurationChanges <= 1, () => state);
      holds("a visit is on record only after the plan was frozen", state.planDigest !== null || state.attempts.every(({ phase }) => phase === "planned" || phase === "not_started"), () => state);
    },
    onPair(state, event, answer) {
      if (!answer.ok) return;
      const next = answer.state;
      holds("the plan never changes once frozen", state.planDigest === null || next.planDigest === state.planDigest, () => ({ state, event, next }));
      holds("the exploratory mark never clears", !state.exploratory || next.exploratory, () => ({ state, event, next }));
      holds("a case never reopens", state.closedBy === null || next.closedBy === state.closedBy, () => ({ state, event, next }));
      for (const [index, before] of state.attempts.entries()) {
        const after = next.attempts[index];
        if (event.type === "cleanup-confirmed" || event.type === "cleanup-unconfirmed" || event.type === "environment-destroyed") {
          holds("cleanup never changes acquisition", after.phase === before.phase, () => ({ state, event, next }));
        }
        holds("an arm never changes", after.arm === before.arm && after.slot === before.slot && after.attemptId === before.attemptId, () => ({ state, event, next }));
        holds("a terminal attempt never reopens", !(seenOutcome.has(before.phase) || before.phase === "not_started") || after.phase === before.phase, () => ({ state, event, next }));
        holds(
          "no later state removes evidence",
          before.evidence.every((id, position) => after.evidence[position] === id),
          () => ({ state, event, next })
        );
        holds("the configuration an attempt ran under never changes", before.configuration === null || after.configuration === before.configuration, () => ({ state, event, next }));
      }
    }
  });
}

const PATH_ONE = "01".repeat(32);
const PATH_TWO = "02".repeat(32);

/** A purge's events, with two listed paths and one that is not, added to a plan's own. */
function withPurgeEvents(alphabet: readonly MachineEvent[]): readonly MachineEvent[] {
  return [
    ...alphabet,
    { type: "purge-manifest-recorded", paths: [PATH_ONE, PATH_TWO], by: OWNER },
    { type: "purge-manifest-recorded", paths: [], by: OWNER },
    { type: "purge-manifest-recorded", paths: [PATH_ONE], by: runnerOf("B1") },
    { type: "purge-path-absent", path: PATH_ONE, by: OWNER },
    { type: "purge-path-absent", path: PATH_TWO, by: OWNER },
    { type: "purge-path-remains", path: PATH_ONE, by: OWNER },
    { type: "purge-path-remains", path: PATH_TWO, by: OWNER },
    { type: "purge-path-absent", path: "03".repeat(32), by: OWNER }
  ];
}

/** Every path ends: no event can return to a state, found by removing sources until nothing is left. */
function isAcyclic({ edges }: Explored): boolean {
  const incoming = new Array<number>(edges.length).fill(0);
  for (const targets of edges) for (const target of targets) incoming[target] += 1;
  const ready: number[] = [];
  incoming.forEach((count, index) => {
    if (count === 0) ready.push(index);
  });
  let removed = 0;
  while (ready.length > 0) {
    const index = ready.pop() as number;
    removed += 1;
    for (const target of edges[index]) {
      incoming[target] -= 1;
      if (incoming[target] === 0) ready.push(target);
    }
  }
  return removed === edges.length;
}

/** Termination as the plan states it, read off the explored graph. */
function terminates(module: MachineModule, plan: PlanInput, alphabet: readonly MachineEvent[]): void {
  const explored = explore(module, plan, alphabet);
  holds("no event can return to a state", isAcyclic(explored), () => ({ states: explored.states.length }));
  explored.states.forEach((state, index) => {
    // What terminal means, written out here rather than asked of the module.
    const terminal = state.closedBy !== null && state.attempts.every(({ cleanup }) => cleanup !== "pending");
    holds("terminal means closed with no cleanup pending", module.isTerminal(state) === terminal, () => state);
    if (explored.edges[index].length === 0) holds("every sink is terminal", terminal, () => state);
    if (terminal) return;
    const accepted = [{ type: "case-deadline", by: OWNER }, { type: "reconcile", by: OWNER }].filter((event) => module.step(state, event as MachineEvent).ok);
    holds("a supervisor's event is accepted from every non-terminal state", accepted.length > 0, () => state);
  });
}

const ONE_EACH = planOf("B1", "I1");
const TWO_EACH = planOf("B1", "B2", "I1", "I2");
const SCENARIO = planOf("I1", "I2", "I3");
const BASELINE_ONLY = planOf("B1", "B2");
const BASELINE_ONLY_STATES = 3407;
const REFUSED_PAIRS = 600622;
const EVERY_ACTOR_STATES = 2947;
const SCENARIO_STATES = 45967;
const THREE_AND_ONE = planOf("B1", "B2", "B3", "I1");
const THREE_AND_ONE_STATES = 3391;
const TWO_EACH_STATES = 16909;
const WITH_PURGE_STATES = 6385;
const THREE_WITH_ROWS = planOf("B1", "B2", "I1");
const INVARIANT_ONE_EACH = 12181;
const INVARIANT_THREE = 35539;

test("every pair on a small plan agrees with the model, from every kind of actor", () => {
  const explored = agreesWithModel(production, ONE_EACH, everyActorAlphabet(ONE_EACH));
  assert.equal(explored.states.length, EVERY_ACTOR_STATES, "the reachable count is pinned, so a change to the domain is seen");
  assert.equal(explored.refusedPairs, REFUSED_PAIRS);
});

test("the purge events, walked with the capture events on a small plan, agree with the model", () => {
  // These are left out of the termination walks below, since a path can read absent, remaining
  // and absent again. Every other property holds with them in, from every kind of close.
  const explored = agreesWithModel(production, ONE_EACH, withPurgeEvents(plainAlphabet(ONE_EACH)));
  assert.equal(explored.states.length, WITH_PURGE_STATES);
  const closedKinds = new Set(explored.states.filter(({ purge }) => purge !== null).map(({ closedBy }) => closedBy));
  assert.deepEqual([...closedKinds].sort(), ["baseline_not_met", "cancelled", "completed", "deadline"]);
  assert.ok(explored.states.some(({ purge, exploratory }) => purge !== null && exploratory), "a purge with the exploratory mark on");
  assert.ok(explored.states.some(({ purge, exploratory }) => purge !== null && !exploratory), "and with it off");
  assert.ok(explored.states.some(({ purge, attempts }) => purge !== null && attempts.some(({ cleanup }) => cleanup === "pending")), "and with cleanup still pending");
  assert.ok(explored.states.some(({ purge }) => purge !== null && purge.length === 0), "and a manifest of nothing");
  const invariants = holdsInvariants(production, ONE_EACH, withPurgeEvents(plainAlphabet(ONE_EACH)));
  assert.equal(invariants.states.length, explored.states.length);
});

test("every pair on two baseline and two instrumented slots, with its configuration change, agrees with the model", () => {
  const explored = agreesWithModel(production, TWO_EACH, plainAlphabet(TWO_EACH));
  assert.equal(explored.states.length, TWO_EACH_STATES);
  // Each kind of visit basis and closing really occurs, so the walk is not over a narrow part of the domain.
  const seen = new Set(explored.states.map(({ closedBy }) => closedBy));
  assert.deepEqual([...seen].sort(), ["baseline_not_met", "cancelled", "completed", "deadline", null].sort());
  // With two baselines a change comes before the first starts, or it would leave the floor out of reach.
  assert.ok(explored.states.some(({ configurationChanges, attempts }) => configurationChanges === 1 && attempts[0].configuration === CONFIG_B && attempts[3].configuration === CONFIG_B));
  assert.equal(explored.states.some(({ configurationChanges, attempts }) => configurationChanges === 1 && attempts[0].configuration === CONFIG_A), false);
  assert.ok(explored.states.some(({ exploratory, controlMet }) => exploratory && controlMet));
});

test("a scenario plan, three attempts in one arm, agrees with the model on its own", () => {
  const explored = agreesWithModel(production, SCENARIO, plainAlphabet(SCENARIO));
  assert.equal(explored.states.length, SCENARIO_STATES);
  assert.ok(explored.states.every(({ baselineRule }) => baselineRule === "not_applicable"));
  // No rule holds its change back, so one attempt can run under each.
  assert.ok(explored.states.some(({ attempts }) => attempts[0].configuration === CONFIG_A && attempts[2].configuration === CONFIG_B));
});

test("three baselines and one instrumented, where a change can follow the first visit, agree with the model", () => {
  // Fewer ways for an attempt to end, since what this adds is where a change can come, and the whole alphabet takes half a minute here.
  const alphabet = plainAlphabet(THREE_AND_ONE).filter((event) => !["attempt-start-retried", "attempt-deadline", "cleanup-unconfirmed", "environment-destroyed"].includes(event.type) && !(event.type === "attempt-finished" && (event.outcome === "walled" || event.outcome === "incomplete")));
  const explored = agreesWithModel(production, THREE_AND_ONE, alphabet);
  assert.equal(explored.states.length, THREE_AND_ONE_STATES);
  assert.ok(explored.states.some(({ baselineRule, attempts }) => baselineRule === "met" && attempts[0].configuration === CONFIG_A && attempts[1].configuration === CONFIG_B && attempts[2].configuration === CONFIG_B));
  assert.equal(explored.states.some(({ attempts }) => attempts[1].configuration === CONFIG_A && attempts[2].configuration === CONFIG_B), false, "no change between the second and the third");
});

const RECORD_AUTHORITY = "a record event is answered by who sent it, on every state the machine reaches, as a plain rule says";

const RECORD_ACTORS: readonly MachineActor[] = [OWNER, runnerOf("B1"), runnerOf("I1"), CONTROL_RUNNER, FOREIGN_RUNNER];
const CLAIM_EVENTS: readonly RecordEvent[] = [
  { type: "assertion-recorded", id: "said-one", statement: "Someone said so." },
  { type: "unknown-recorded", unknown: { id: "question-one", question: "What?", reason: "Nothing showed.", detail: null, wouldResolve: null } }
];
const CAPTURE_RECORDS: readonly Extract<RecordEvent, { type: "instrument-recorded" | "source-recorded" }>[] = [
  { type: "instrument-recorded", slot: "B1", instrument: "coverage", completeness: "complete", reason: null },
  { type: "instrument-recorded", slot: "I1", instrument: "coverage", completeness: "complete", reason: null },
  { type: "instrument-recorded", slot: "I3", instrument: "coverage", completeness: "complete", reason: null },
  { type: "source-recorded", slot: "B1", commit: "c0".repeat(20), identity: "9b".repeat(32) },
  { type: "source-recorded", slot: "I1", commit: "c0".repeat(20), identity: "9b".repeat(32) }
];
const RECONSTRUCT: RecordEvent = { type: "source-reconstructed", appliesTo: ["B1"], baseCommit: "ca".repeat(20), patchDigest: "ab".repeat(32), identity: "9a".repeat(32) };

/** Who may say each thing, written out here. It RESTATES the record's rule, so it holds the module to this reading over every state and actor. */
function expectedRecordAnswer(state: MachineState, event: RecordEvent, by: MachineActor): string {
  if (event.type === "instrument-recorded" || event.type === "source-recorded") {
    const attempt = state.attempts.find(({ slot }) => slot === event.slot);
    if (attempt === undefined) return "no-such-slot";
    if (by.kind !== "system:runner" || by.attemptId !== attempt.attemptId) return "not-this-attempt";
    if (attempt.phase === "planned" || attempt.phase === "not_started") return "attempt-not-begun";
    if (RUNNING.has(attempt.phase)) return "accepted";
    return event.type === "instrument-recorded" ? "instrument-after-attempt" : "source-after-attempt";
  }
  if (by.kind !== "owner") return "owner-only";
  if (event.type !== "source-reconstructed") return "accepted";
  return RUNNING.has(state.attempts[0].phase) || state.attempts[0].phase === "planned" || state.attempts[0].phase === "not_started" ? "source-attempt-not-ended" : "accepted";
}

const RECORD_EVENTS: readonly RecordEvent[] = [...CLAIM_EVENTS, ...CAPTURE_RECORDS, RECONSTRUCT];

const checkRecordAuthority = (module: typeof evidenceModule, states: readonly MachineState[]): number => {
  let pairs = 0;
  for (const state of states) {
    for (const event of RECORD_EVENTS) {
      for (const by of RECORD_ACTORS) {
        const answer = module.applyRecordEvent(module.EMPTY_RECORD, event, by, state, 9);
        const expected = expectedRecordAnswer(state, event, by);
        holds(RECORD_AUTHORITY, (answer.ok ? "accepted" : answer.refusal) === expected, () => ({ state, event, by, answer, expected }));
        pairs += 1;
      }
    }
  }
  return pairs;
};

test("record events, from every kind of actor, on every state of a small plan's every-actor walk", async () => {
  const { states } = explore(production, ONE_EACH, everyActorAlphabet(ONE_EACH));
  assert.equal(states.length, EVERY_ACTOR_STATES);
  assert.equal(checkRecordAuthority(evidenceModule, states), EVERY_ACTOR_STATES * RECORD_EVENTS.length * RECORD_ACTORS.length);
  const variant = (find: string, replace: string) => loadVariant<typeof evidenceModule>(require.resolve("../core/evidence-model"), [{ find, replace }]);
  const OWNER_LINE = 'if (by.kind !== "owner")\n        return refuse("owner-only");';
  const RUNNER_LINE = 'if (by.kind !== "system:runner" || by.attemptId !== attempt.attemptId)\n            return refuse("not-this-attempt", "slot");';
  await assertCaughtBy("a claim from the control run", RECORD_AUTHORITY, () => { checkRecordAuthority(variant(OWNER_LINE, 'if (by.kind !== "owner" && by.attemptId !== machine.controlRunId)\n        return refuse("owner-only");'), states); });
  await assertCaughtBy("a claim from a runner of another case", RECORD_AUTHORITY, () => { checkRecordAuthority(variant(OWNER_LINE, 'if (by.kind !== "owner" && machine.attempts.some(({ attemptId }) => attemptId === by.attemptId))\n        return refuse("owner-only");'), states); });
  await assertCaughtBy("a capture's record from the control run", RECORD_AUTHORITY, () => { checkRecordAuthority(variant(RUNNER_LINE, 'if (by.kind !== "system:runner" || (by.attemptId !== attempt.attemptId && by.attemptId !== machine.controlRunId))\n            return refuse("not-this-attempt", "slot");'), states); });
  await assertCaughtBy("a capture's record from the owner", RECORD_AUTHORITY, () => { checkRecordAuthority(variant(RUNNER_LINE, 'if (by.kind === "system:runner" && by.attemptId !== attempt.attemptId)\n            return refuse("not-this-attempt", "slot");'), states); });
});

test("a baseline-only plan closes itself when its last attempt ends, and agrees with the model", () => {
  const explored = agreesWithModel(production, BASELINE_ONLY, plainAlphabet(BASELINE_ONLY));
  assert.equal(explored.states.length, BASELINE_ONLY_STATES);
  assert.ok(explored.states.every(({ baselineRule }) => baselineRule === "not_applicable"));
  assert.ok(explored.states.some(({ closedBy, attempts }) => closedBy === "completed" && attempts.every(({ phase }) => phase === "usable")), "the last attempt's end closes it, with no event to do so");
  assert.ok(explored.states.filter(({ closedBy }) => closedBy === null).every(({ attempts }) => attempts.some(({ phase }) => phase === "planned" || RUNNING.has(phase))));
});

test("every invariant holds over the same reachable states, and with evidence on more than one attempt", () => {
  const counts = [
    // Two ids on each of two slots, and one on each of three, so a check that reads one id or one attempt is seen.
    [ONE_EACH, plainAlphabet(ONE_EACH, 2)],
    [THREE_WITH_ROWS, plainAlphabet(THREE_WITH_ROWS, 1)],
    [TWO_EACH, plainAlphabet(TWO_EACH)],
    [SCENARIO, plainAlphabet(SCENARIO)]
  ].map(([plan, alphabet]) => holdsInvariants(production, plan as PlanInput, alphabet as readonly MachineEvent[]).states.length);
  assert.deepEqual(counts, [INVARIANT_ONE_EACH, INVARIANT_THREE, TWO_EACH_STATES, SCENARIO_STATES]);
});

test("termination, as the plan states it: acyclic, every sink terminal, and a supervisor's event from every non-terminal state", () => {
  terminates(production, ONE_EACH, plainAlphabet(ONE_EACH, 2));
  terminates(production, TWO_EACH, plainAlphabet(TWO_EACH));
  terminates(production, SCENARIO, plainAlphabet(SCENARIO));
});

/** The compiled lines the variants below edit. A find that stops landing fails loudly in loadVariant. */
const REMOVE_NO_VALID_CONTROL = { find: 'if (visitBasisOf(state, event.slot) === null)\n        return refuse("no-valid-control");', replace: "" };

for (const [name, plan, edits] of [
  ["a visit with no control", ONE_EACH, [REMOVE_NO_VALID_CONTROL]],
  ["a failed control unlocking visits", ONE_EACH, [{ find: 'event.result === "met";', replace: '(event.result === "met" || event.result === "not_met");' }]],
  ["a merely recorded control", ONE_EACH, [{ find: 'event.result === "met";', replace: '(event.result === "met" || event.result === "not_evaluated");' }]],
  ["a control from another configuration", ONE_EACH, [{ find: 'const controlMet = event.configuration === state.configuration && event.result === "met";', replace: 'const controlMet = event.result === "met";' }]],
  ["a later pass clearing the exploratory mark", ONE_EACH, [{ find: "{ controlMet, controlMisses: 0 })", replace: "{ controlMet, controlMisses: 0, exploratory: false })" }]],
  ["the instrumented arm not waiting", ONE_EACH, [{ find: 'if (attempt.arm === "instrumented" && state.baselineRule === "pending")\n        return refuse("baseline-rule-pending");', replace: "" }]],
  ["two attempts at once", TWO_EACH, [{ find: 'if (state.attempts.some(({ phase }) => isRunningPhase(phase)))\n        return refuse("another-attempt-running");\n    if (state.attempts.findIndex', replace: "if (state.attempts.findIndex" }]],
  ["continuing past unresolved cleanup", TWO_EACH, [{ find: 'if (state.attempts.some(({ cleanup }) => isCleanupUnresolved(cleanup)))\n        return refuse("cleanup-unresolved");', replace: "" }]],
  ["a cancel waiting on cleanup", ONE_EACH, [{ find: 'function caseCancelled(state, event) {\n    if (!isOwner(event.by))\n        return refuse("owner-only");', replace: 'function caseCancelled(state, event) {\n    if (!isOwner(event.by))\n        return refuse("owner-only");\n    if (state.attempts.some(({ cleanup }) => isCleanupUnresolved(cleanup)))\n        return refuse("cleanup-unresolved");' }]],
  ["an unconfirmed cleanup capping an outcome", ONE_EACH, [{ find: 'return accept(withAttempt(state, index, { cleanup: "unconfirmed" }));', replace: 'return accept(withAttempt(state, index, { cleanup: "unconfirmed", phase: "incomplete" }));' }]],
  ["a control cap gone", ONE_EACH, [{ find: 'if (state.controlMisses >= exports.MAX_CONTROL_MISSES)\n        return refuse("control-limit");', replace: "" }]],
  ["a start retry cap gone", ONE_EACH, [{ find: 'if (found.attempt.startRetries >= exports.MAX_START_RETRIES)\n        return refuse("start-retry-limit");', replace: "" }]],
  ["a second configuration change", ONE_EACH, [{ find: 'if (state.configurationChanges >= exports.MAX_CONFIGURATION_CHANGES)\n        return refuse("configuration-change-spent");', replace: "" }]]
] as const) {
  test(`the model walk catches ${name}`, async () => {
    await assertCaughtBy(name, "the machine equals the plain model", () => agreesWithModel(machineVariant(...(edits as readonly SourceEdit[])), plan, plainAlphabet(plan)));
  });
}

for (const [name, property, plan, edits] of [
  ["dropping not_started", "planned equals running plus terminal plus not_started", ONE_EACH, [{ find: 'notStarted: count((phase) => phase === "planned" || phase === "not_started"),', replace: 'notStarted: count((phase) => phase === "planned"),' }]],
  ["dropping the slots still waiting", "planned equals running plus terminal plus not_started", ONE_EACH, [{ find: 'notStarted: count((phase) => phase === "planned" || phase === "not_started"),', replace: 'notStarted: count((phase) => phase === "not_started"),' }]],
  // A running attempt's cleanup is pending, so that guard also stands in the way, and only with both gone can this property fail.
  ["an outcome miscounted", "planned equals running plus terminal plus not_started", ONE_EACH, [{ find: 'failed: count((phase) => phase === "failed"),', replace: 'failed: count((phase) => phase === "incomplete"),' }]],
  ["a running attempt read as not started", "planned equals running plus terminal plus not_started", ONE_EACH, [{ find: "running: count(isRunningPhase),", replace: 'running: count((phase) => phase === "capturing"),' }]],
  ["two attempts at once", "at most one attempt runs", TWO_EACH, [{ find: 'if (state.attempts.some(({ phase }) => isRunningPhase(phase)))\n        return refuse("another-attempt-running");\n    if (state.attempts.findIndex(({ phase }) => phase === "planned") !== index)\n        return refuse("not-next-slot");\n    if (state.attempts.some(({ cleanup }) => isCleanupUnresolved(cleanup)))\n        return refuse("cleanup-unresolved");', replace: 'if (state.attempts.findIndex(({ phase }) => phase === "planned") !== index)\n        return refuse("not-next-slot");' }]],
  ["an arm rewritten at the start of a visit", "an arm never changes", ONE_EACH, [{ find: '{ phase: "starting", cleanup: "pending", configuration: state.configuration }', replace: '{ phase: "starting", arm: "baseline", cleanup: "pending", configuration: state.configuration }' }]],
  ["a terminal attempt finishing again", "a terminal attempt never reopens", ONE_EACH, [{ find: 'if (!isRunningPhase(phase))\n        return refuse("wrong-phase");\n    if (!REPORTABLE[phase].includes(event.outcome))\n        return refuse("outcome-not-reachable");', replace: "" }]],
  ["a close that drops evidence", "no later state removes evidence", ONE_EACH, [{ find: "return Object.assign(Object.assign({}, attempt), { phase: runningOutcome, startRetries: 0 });", replace: "return Object.assign(Object.assign({}, attempt), { phase: runningOutcome, startRetries: 0, evidence: [] });" }]],
  ["a later pass clearing the exploratory mark", "the exploratory mark never clears", ONE_EACH, [{ find: "{ controlMet, controlMisses: 0 })", replace: "{ controlMet, controlMisses: 0, exploratory: false })" }]],
  ["a cleanup event changing an outcome", "cleanup never changes acquisition", ONE_EACH, [{ find: 'return accept(withAttempt(state, index, { cleanup: "unconfirmed" }));', replace: 'return accept(withAttempt(state, index, { cleanup: "unconfirmed", phase: "not_started" }));' }]],
  ["a control cap gone", "retry counters stay within their caps", ONE_EACH, [{ find: 'if (state.controlMisses >= exports.MAX_CONTROL_MISSES)\n        return refuse("control-limit");', replace: "" }]],
  ["a start retry cap gone", "retry counters stay within their caps", ONE_EACH, [{ find: 'if (found.attempt.startRetries >= exports.MAX_START_RETRIES)\n        return refuse("start-retry-limit");', replace: "" }]],
  ["a plan rewritten after it froze", "the plan never changes once frozen", ONE_EACH, [{ find: 'if (state.planDigest !== null)\n        return refuse("plan-already-frozen");', replace: "" }, { find: "{ planDigest: event.planDigest })", replace: '{ planDigest: event.planDigest + (state.planDigest === null ? "" : "x") })' }]],
  ["a visit before the plan froze", "a visit is on record only after the plan was frozen", ONE_EACH, [{ find: 'if (state.planDigest === null)\n        return refuse("plan-not-frozen");\n    if (attempt.phase !== "planned")', replace: 'if (attempt.phase !== "planned")' }, REMOVE_NO_VALID_CONTROL]],
  ["a closed case taking a second close", "a case never reopens", ONE_EACH, [{ find: 'if (state.closedBy !== null)\n        return refuse("case-closed");\n    return accept(closeWith(state, "cancelled", "cancelled"));', replace: 'return accept(closeWith(state, "cancelled", "cancelled"));' }]]
] as const) {
  test(`the invariant walk catches ${name}, as ${property}`, async () => {
    await assertCaughtBy(name, property, () => holdsInvariants(machineVariant(...(edits as readonly SourceEdit[])), plan, plainAlphabet(plan, 1)));
  });
}

test("the purge walk catches a machine that reads more than the reducer should", async () => {
  const walk = (module: MachineModule) => agreesWithModel(module, ONE_EACH, withPurgeEvents(plainAlphabet(ONE_EACH)));
  const closedFlag = "(0, purge_1.purgeStep)(state.closedBy !== null, state.purge, event)";
  for (const [name, replace] of [
    ["a purge only of a cancelled case", '(0, purge_1.purgeStep)(state.closedBy === "cancelled", state.purge, event)'],
    ["a purge held by pending cleanup", "(0, purge_1.purgeStep)(isTerminal(state), state.purge, event)"],
    ["a purge held by the exploratory mark", "(0, purge_1.purgeStep)(state.closedBy !== null && !state.exploratory, state.purge, event)"]
  ] as const) {
    await assertCaughtBy(name, "the machine equals the plain model", () => walk(machineVariant({ find: closedFlag, replace })));
  }
  await assertCaughtBy("the mark cleared by a purge", "the machine equals the plain model", () => walk(machineVariant({ find: "accept(Object.assign(Object.assign({}, state), { purge: result.manifest }))", replace: "accept(Object.assign(Object.assign({}, state), { purge: result.manifest, exploratory: false }))" })));
  await assertCaughtBy("a purge from a runner", "the machine equals the plain model", () => walk(machineVariant({ find: 'function purgeEvent(state, event) {\n    if (!isOwner(event.by))\n        return refuse("owner-only");', replace: "function purgeEvent(state, event) {" })));
});

for (const [name, property, edits] of [
  ["terminal reading only the first attempt", "terminal means closed with no cleanup pending", [{ find: 'return state.closedBy !== null && !state.attempts.some((attempt) => attempt.cleanup === "pending");', replace: 'return state.closedBy !== null && state.attempts[0].cleanup !== "pending";' }]],
  ["a retry that does not count", "no event can return to a state", [{ find: "{ startRetries: found.attempt.startRetries + 1 }", replace: "{ startRetries: found.attempt.startRetries }" }]],
  ["a control miss that does not count", "no event can return to a state", [{ find: "Object.assign(Object.assign({}, state), { controlMisses: state.controlMisses + 1 })", replace: "state" }]],
  ["a case deadline that does not close", "a supervisor's event is accepted from every non-terminal state", [{ find: 'if (state.closedBy !== null)\n        return refuse("case-closed");\n    return accept(closeWith(state, "timed_out", "deadline"));', replace: 'return refuse("case-closed");' }]],
  ["a closed case with cleanup pending and no way to answer", "a supervisor's event is accepted from every non-terminal state", [{ find: 'if (!state.attempts.some(({ cleanup }) => cleanup === "pending"))\n        return refuse("nothing-to-reconcile");', replace: 'if (state.closedBy !== null || !state.attempts.some(({ cleanup }) => cleanup === "pending"))\n        return refuse("nothing-to-reconcile");' }]],
  ["a closed case that never reads terminal", "terminal means closed with no cleanup pending", [{ find: 'return state.closedBy !== null && !state.attempts.some((attempt) => attempt.cleanup === "pending");', replace: "return false;" }]],
  ["a closed case's cleanup that nothing can answer", "every sink is terminal", [{ find: 'if (state.closedBy !== null)\n        return refuse("case-closed");\n    return accept(closeWith(state, "cancelled", "cancelled"));', replace: 'if (state.closedBy !== null)\n        return refuse("case-closed");\n    return accept(closeWith(Object.assign(Object.assign({}, state), { attempts: state.attempts.map((attempt) => (isRunningPhase(attempt.phase) ? Object.assign(Object.assign({}, attempt), { cleanup: "pending" }) : attempt)) }), "cancelled", "cancelled"));' }, { find: 'if (!state.attempts.some(({ cleanup }) => cleanup === "pending"))\n        return refuse("nothing-to-reconcile");', replace: 'return refuse("nothing-to-reconcile");' }, { find: 'function cleanupEvent(state, event) {', replace: 'function cleanupEvent(state, event) {\n    return refuse("cleanup-settled");' }]]
] as const) {
  test(`termination catches ${name}`, async () => {
    await assertCaughtBy(name, property, () => terminates(machineVariant(...(edits as readonly SourceEdit[])), ONE_EACH, plainAlphabet(ONE_EACH)));
  });
}
