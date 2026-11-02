import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import ts from "typescript";
import { assertCaughtBy, holds, loadVariant, type SourceEdit } from "../../lib/finite-check";
import * as production from "../core/case-machine";
import { step, type MachineEvent, type MachineRefusal, type MachineState, type PlanInput, type SlotName } from "../core/case-machine";
import {
  accepted,
  ATTEMPT_IDS,
  captureOf,
  CONFIG_A,
  CONFIG_B,
  confirmOf,
  CONTROL_RUN_ID,
  CONTROL_RUNNER,
  controlMet,
  destroyOf,
  driven,
  finishOf,
  FOREIGN_RUNNER,
  frozen,
  FULL_PLAN,
  OWNER,
  PLAN_DIGEST,
  planOf,
  runnerOf,
  start,
  startOf,
  visitOf,
  type MachineModule
} from "./case-fixture";

/**
 * Each of the machine's rules, on a named path, with a positive control beside each
 * refusal, so a refusal is known to come from the rule and not from something else in the
 * way. Each rule then has a broken variant, caught under the exact property the rule states.
 * The expected states are spelled out here and read no reachable-state code.
 */

const machineVariant = (...edits: SourceEdit[]) => loadVariant<MachineModule>(require.resolve("../core/case-machine"), edits);

function refusalOf(module: MachineModule, state: MachineState, event: MachineEvent): MachineRefusal | "accepted" {
  const result = module.step(state, event);
  return result.ok ? "accepted" : result.refusal;
}

/** The event is refused, for exactly this reason. */
function refused(module: MachineModule, property: string, state: MachineState, event: MachineEvent, refusal: MachineRefusal): void {
  const answer = refusalOf(module, state, event);
  holds(property, answer === refusal, () => ({ answer, expected: refusal, event }));
}

const VISIT = "a visit needs a control met for the current configuration, or an earlier exception";

const TWO_BASE: PlanInput = planOf("B1", "B2");
const ONE_EACH: PlanInput = planOf("B1", "I1");

test("positive control: a whole plan runs, each slot in order, to the phases spelled out here", () => {
  const property = "the plan runs";
  const state = driven(
    production,
    property,
    FULL_PLAN,
    frozen,
    controlMet(),
    ...visitOf("B1"),
    ...visitOf("B2"),
    ...visitOf("B3", "failed"),
    { type: "baseline-rule-recorded", result: "met", by: OWNER },
    ...visitOf("I1"),
    ...visitOf("I2", "incomplete"),
    ...visitOf("I3", "walled")
  );
  assert.deepEqual(
    state.attempts.map(({ slot, arm, phase, cleanup, configuration }) => [slot, arm, phase, cleanup, configuration]),
    [
      ["B1", "baseline", "usable", "confirmed", CONFIG_A],
      ["B2", "baseline", "usable", "confirmed", CONFIG_A],
      ["B3", "baseline", "failed", "confirmed", CONFIG_A],
      ["I1", "instrumented", "usable", "confirmed", CONFIG_A],
      ["I2", "instrumented", "incomplete", "confirmed", CONFIG_A],
      ["I3", "instrumented", "walled", "confirmed", CONFIG_A]
    ]
  );
  assert.equal(state.closedBy, "completed");
  assert.equal(state.exploratory, false);
  assert.equal(production.isTerminal(state), true);
  assert.deepEqual(production.denominatorOf(state), { planned: 6, running: 0, notStarted: 0, waiting: 0, usable: 3, walled: 1, failed: 1, incomplete: 1, timed_out: 0, cancelled: 0 });
});

test("the machine is a pure function: the same answer each time, from frozen input, which it leaves alone", () => {
  const deepFreeze = <T>(value: T): T => {
    if (typeof value === "object" && value !== null) {
      for (const inner of Object.values(value)) deepFreeze(inner);
      Object.freeze(value);
    }
    return value;
  };
  const state = deepFreeze(driven(production, "the path runs", FULL_PLAN, frozen, controlMet(), startOf("B1")));
  const before = JSON.stringify(state);
  const event = deepFreeze(captureOf("B1")[0]);
  const once = step(state, event);
  const again = step(state, event);
  assert.deepEqual(once, again);
  assert.equal(JSON.stringify(state), before);
  assert.notEqual(once.ok && once.state, state, "a new state, not this one changed");
});

test("an event of no known type is a typed refusal, not a throw", () => {
  const state = start(production, "the plan is valid", ONE_EACH);
  assert.equal(refusalOf(production, state, { type: "claim-approved", by: OWNER } as unknown as MachineEvent), "unknown-event");
});

const checkPlans = (module: MachineModule) => {
  const property = "a plan is a list of slots in order, each with its own id";
  const plan = (slots: PlanInput["slots"], over: Partial<PlanInput> = {}): PlanInput => ({ slots, controlRunId: CONTROL_RUN_ID, configuration: CONFIG_A, ...over });
  const bad: readonly PlanInput[] = [
    plan([]),
    plan(planOf("B1", "I1").slots, { configuration: "" }),
    plan([...planOf("B1").slots, ...planOf("B1").slots]),
    // The same slot twice with two ids, so only the order check can refuse it.
    plan([{ slot: "B1", attemptId: ATTEMPT_IDS.B1 }, { slot: "B1", attemptId: ATTEMPT_IDS.B2 }]),
    plan([...planOf("I1").slots, ...planOf("B1").slots]),
    plan([{ slot: "B1", attemptId: ATTEMPT_IDS.B1 }, { slot: "B2", attemptId: ATTEMPT_IDS.B1 }]),
    plan([{ slot: "B1", attemptId: "" }]),
    plan([{ slot: "X1" as SlotName, attemptId: ATTEMPT_IDS.B1 }]),
    // The control run holds no slot, so one runner cannot speak for both.
    plan(planOf("B1", "I1").slots, { controlRunId: ATTEMPT_IDS.I1 }),
    plan(planOf("B1", "I1").slots, { controlRunId: "" })
  ];
  for (const plan of bad) {
    const result = module.plannedState(plan);
    holds(property, !result.ok && result.refusal === "malformed-plan", () => ({ plan, result }));
  }
  for (const plan of [planOf("B1"), planOf("I1", "I2", "I3"), planOf("B1", "B3", "I2"), FULL_PLAN]) {
    holds(property, module.plannedState(plan).ok, () => plan);
  }
};

test("a plan is held to its shape, with an arm fixed by each slot", async () => {
  checkPlans(production);
  const state = start(production, "the plan is valid", FULL_PLAN);
  assert.deepEqual(
    state.attempts.map(({ slot, arm, attemptId, phase, cleanup }) => [slot, arm, attemptId, phase, cleanup]),
    [
      ["B1", "baseline", ATTEMPT_IDS.B1, "planned", null],
      ["B2", "baseline", ATTEMPT_IDS.B2, "planned", null],
      ["B3", "baseline", ATTEMPT_IDS.B3, "planned", null],
      ["I1", "instrumented", ATTEMPT_IDS.I1, "planned", null],
      ["I2", "instrumented", ATTEMPT_IDS.I2, "planned", null],
      ["I3", "instrumented", ATTEMPT_IDS.I3, "planned", null]
    ]
  );
  // The whole first state, field by field, for a plan with both arms.
  assert.deepEqual(start(production, "the plan is valid", ONE_EACH), {
    planDigest: null,
    controlRunId: CONTROL_RUN_ID,
    configuration: CONFIG_A,
    configurationChanges: 0,
    controlMet: false,
    controlMisses: 0,
    exceptionFor: null,
    exploratory: false,
    baselineRule: "pending",
    closedBy: null,
    attempts: [
      { slot: "B1", arm: "baseline", attemptId: ATTEMPT_IDS.B1, phase: "planned", cleanup: null, configuration: null, startRetries: 0, evidence: [] },
      { slot: "I1", arm: "instrumented", attemptId: ATTEMPT_IDS.I1, phase: "planned", cleanup: null, configuration: null, startRetries: 0, evidence: [] }
    ],
    purge: null
  });
  for (const [name, find, replace] of [
    ["plan order", "position > positions[index - 1]", "true"],
    ["a slot repeated", "position > positions[index - 1]", "position >= positions[index - 1]"],
    ["a shared attempt id", "ids.size !== plan.slots.length + 1 || ", ""],
    ["a control run sharing an attempt's id", "new Set([plan.controlRunId, ...plan.slots.map(({ attemptId }) => attemptId)])", "new Set(plan.slots.map(({ attemptId }) => attemptId))"],
    ["an empty plan", "plan.slots.length === 0 || ", ""],
    ["an unknown slot", "position >= 0 && ", ""],
    ["an empty id", 'ids.has("") || ', ""],
    ["an empty configuration", ' || plan.configuration === ""', ""]
  ] as const) {
    await assertCaughtBy(name, "a plan is a list of slots in order, each with its own id", () => checkPlans(machineVariant({ find, replace })));
  }
});

const checkFreezeFirst = (module: MachineModule) => {
  const property = "the plan is frozen before any control, exception, change or visit";
  const unfrozen = start(module, property, ONE_EACH);
  refused(module, property, unfrozen, startOf("B1"), "plan-not-frozen");
  refused(module, property, unfrozen, controlMet(), "plan-not-frozen");
  refused(module, property, unfrozen, { type: "exception-recorded", slot: "B1", by: OWNER }, "plan-not-frozen");
  refused(module, property, unfrozen, { type: "configuration-changed", configuration: CONFIG_B, by: OWNER }, "plan-not-frozen");
  const ready = accepted(module, property, unfrozen, frozen);
  holds(property, ready.planDigest === PLAN_DIGEST, () => ready);
  refused(module, property, ready, frozen, "plan-already-frozen");
  accepted(module, property, ready, controlMet());
  accepted(module, property, ready, { type: "exception-recorded", slot: "B1", by: OWNER });
  accepted(module, property, ready, { type: "configuration-changed", configuration: CONFIG_B, by: OWNER });
};

test("the plan is frozen before anything leans on it", async () => {
  checkFreezeFirst(production);
  for (const [name, find, next] of [
    ["control", 'return refuse("not-this-case");\n    if (state.closedBy !== null)\n        return refuse("case-closed");\n    if (state.planDigest === null)\n        return refuse("plan-not-frozen");', 'return refuse("not-this-case");\n    if (state.closedBy !== null)\n        return refuse("case-closed");'],
    ["exception", 'return refuse("no-such-slot");\n    if (state.closedBy !== null)\n        return refuse("case-closed");\n    if (state.planDigest === null)\n        return refuse("plan-not-frozen");\n    if (state.attempts[index].phase !== "planned")', 'return refuse("no-such-slot");\n    if (state.closedBy !== null)\n        return refuse("case-closed");\n    if (state.attempts[index].phase !== "planned")'],
    ["configuration change", 'function configurationChanged(state, event) {\n    if (!isOwner(event.by))\n        return refuse("owner-only");\n    if (state.closedBy !== null)\n        return refuse("case-closed");\n    if (state.planDigest === null)\n        return refuse("plan-not-frozen");', 'function configurationChanged(state, event) {\n    if (!isOwner(event.by))\n        return refuse("owner-only");\n    if (state.closedBy !== null)\n        return refuse("case-closed");'],
    ["visit", 'if (state.planDigest === null)\n        return refuse("plan-not-frozen");\n    if (attempt.phase !== "planned")', 'if (attempt.phase !== "planned")']
  ] as const) {
    await assertCaughtBy(`the freeze check on the ${name}`, "the plan is frozen before any control, exception, change or visit", () => checkFreezeFirst(machineVariant({ find, replace: next })));
  }
});

const checkNoControl = (module: MachineModule) => {
  const ready = driven(module, VISIT, ONE_EACH, frozen);
  refused(module, VISIT, ready, startOf("B1"), "no-valid-control");
  const passed = accepted(module, VISIT, ready, controlMet());
  accepted(module, VISIT, passed, startOf("B1"));
};

const checkFailedControl = (module: MachineModule) => {
  const ready = driven(module, VISIT, ONE_EACH, frozen);
  const failed = accepted(module, VISIT, ready, { type: "control-recorded", configuration: CONFIG_A, result: "not_met", by: CONTROL_RUNNER });
  holds(VISIT, !failed.controlMet && failed.controlMisses === 1, () => failed);
  refused(module, VISIT, failed, startOf("B1"), "no-valid-control");
};

const checkMerelyRecorded = (module: MachineModule) => {
  const ready = driven(module, VISIT, ONE_EACH, frozen);
  const recorded = accepted(module, VISIT, ready, { type: "control-recorded", configuration: CONFIG_A, result: "not_evaluated", by: CONTROL_RUNNER });
  holds(VISIT, !recorded.controlMet, () => recorded);
  refused(module, VISIT, recorded, startOf("B1"), "no-valid-control");
};

const checkOtherConfiguration = (module: MachineModule) => {
  const ready = driven(module, VISIT, ONE_EACH, frozen);
  const elsewhere = accepted(module, VISIT, ready, controlMet(CONFIG_B));
  holds(VISIT, !elsewhere.controlMet, () => elsewhere);
  refused(module, VISIT, elsewhere, startOf("B1"), "no-valid-control");
};

const checkControlCarriedAcrossChange = (module: MachineModule) => {
  const passed = driven(module, VISIT, ONE_EACH, frozen, controlMet());
  const changed = accepted(module, VISIT, passed, { type: "configuration-changed", configuration: CONFIG_B, by: OWNER });
  refused(module, VISIT, changed, startOf("B1"), "no-valid-control");
  // The old configuration's control unlocks nothing, and only the new one's does.
  const stale = accepted(module, VISIT, changed, controlMet(CONFIG_A));
  refused(module, VISIT, stale, startOf("B1"), "no-valid-control");
  accepted(module, VISIT, accepted(module, VISIT, changed, controlMet(CONFIG_B)), startOf("B1"));
};

test("a visit needs a control that met its criterion for the current configuration", async () => {
  checkNoControl(production);
  checkFailedControl(production);
  checkMerelyRecorded(production);
  checkOtherConfiguration(production);
  checkControlCarriedAcrossChange(production);
  const met = 'const controlMet = event.configuration === state.configuration && event.result === "met";';
  await assertCaughtBy("an attempt start before the control", VISIT, () => checkNoControl(machineVariant({ find: 'if (visitBasisOf(state, event.slot) === null)\n        return refuse("no-valid-control");', replace: "" })));
  await assertCaughtBy("a failed control unlocking visits", VISIT, () => checkFailedControl(machineVariant({ find: met, replace: 'const controlMet = event.configuration === state.configuration && (event.result === "met" || event.result === "not_met");' })));
  await assertCaughtBy("a merely recorded control", VISIT, () => checkMerelyRecorded(machineVariant({ find: met, replace: 'const controlMet = event.configuration === state.configuration && (event.result === "met" || event.result === "not_evaluated");' })));
  await assertCaughtBy("a control from another configuration", VISIT, () => checkOtherConfiguration(machineVariant({ find: met, replace: 'const controlMet = event.result === "met";' })));
  await assertCaughtBy("a control carried across a configuration change", VISIT, () =>
    checkControlCarriedAcrossChange(machineVariant({ find: "configurationChanges: state.configurationChanges + 1, controlMet: false,", replace: "configurationChanges: state.configurationChanges + 1, controlMet: state.controlMet," }))
  );
});

test("once a configuration has its control no further one is taken, and misses are capped", async () => {
  const passed = driven(production, "the path runs", ONE_EACH, frozen, controlMet());
  assert.equal(refusalOf(production, passed, controlMet()), "control-already-met");
  const miss: MachineEvent = { type: "control-recorded", configuration: CONFIG_A, result: "not_met", by: CONTROL_RUNNER };
  const twice = driven(production, "the path runs", ONE_EACH, frozen, miss, miss);
  assert.equal(twice.controlMisses, 2);
  assert.equal(refusalOf(production, twice, controlMet()), "control-limit");
  // The ways on from there.
  const changed = accepted(production, "the path runs", twice, { type: "configuration-changed", configuration: CONFIG_B, by: OWNER });
  assert.equal(changed.controlMisses, 0);
  assert.equal(refusalOf(production, changed, controlMet(CONFIG_B)), "accepted");
  assert.equal(refusalOf(production, twice, { type: "exception-recorded", slot: "B1", by: OWNER }), "accepted");
});

const EXCEPTION = "an exception covers the one visit named, recorded by the owner before it began";

const checkExceptionCovers = (module: MachineModule) => {
  const ready = driven(module, EXCEPTION, TWO_BASE, frozen);
  const excepted = accepted(module, EXCEPTION, ready, { type: "exception-recorded", slot: "B1", by: OWNER });
  const visited = accepted(module, EXCEPTION, excepted, startOf("B1"));
  holds(EXCEPTION, visited.exceptionFor === null, () => visited);
  const done = [...captureOf("B1"), finishOf("B1"), confirmOf("B1")].reduce((state, event) => accepted(module, EXCEPTION, state, event), visited);
  // It was spent on B1, so the next visit stands where it stood.
  refused(module, EXCEPTION, done, startOf("B2"), "no-valid-control");
};

const checkExceptionAfterVisit = (module: MachineModule) => {
  const passed = driven(module, EXCEPTION, TWO_BASE, frozen, controlMet(), startOf("B1"));
  refused(module, EXCEPTION, passed, { type: "exception-recorded", slot: "B1", by: OWNER }, "exception-after-visit");
  const done = [...captureOf("B1"), finishOf("B1")].reduce((state, event) => accepted(module, EXCEPTION, state, event), passed);
  refused(module, EXCEPTION, done, { type: "exception-recorded", slot: "B1", by: OWNER }, "exception-after-visit");
  holds(EXCEPTION, !done.exploratory, () => done);
};

const checkExceptionByOwner = (module: MachineModule) => {
  const ready = driven(module, EXCEPTION, TWO_BASE, frozen);
  for (const by of [runnerOf("B1"), CONTROL_RUNNER, FOREIGN_RUNNER]) refused(module, EXCEPTION, ready, { type: "exception-recorded", slot: "B1", by }, "owner-only");
  accepted(module, EXCEPTION, ready, { type: "exception-recorded", slot: "B1", by: OWNER });
};

const checkExceptionNotNext = (module: MachineModule) => {
  const ready = driven(module, EXCEPTION, TWO_BASE, frozen);
  refused(module, EXCEPTION, ready, { type: "exception-recorded", slot: "B2", by: OWNER }, "exception-not-next");
};

const checkExceptionPending = (module: MachineModule) => {
  const excepted = driven(module, EXCEPTION, TWO_BASE, frozen, { type: "exception-recorded", slot: "B1", by: OWNER });
  refused(module, EXCEPTION, excepted, { type: "exception-recorded", slot: "B1", by: OWNER }, "exception-pending");
};

const checkExceptionClearedByChange = (module: MachineModule) => {
  const excepted = driven(module, EXCEPTION, TWO_BASE, frozen, { type: "exception-recorded", slot: "B1", by: OWNER });
  const changed = accepted(module, EXCEPTION, excepted, { type: "configuration-changed", configuration: CONFIG_B, by: OWNER });
  holds(EXCEPTION, changed.exceptionFor === null && changed.exploratory, () => changed);
  refused(module, EXCEPTION, changed, startOf("B1"), "no-valid-control");
};

const checkBasisOrder = (module: MachineModule) => {
  // Both on record, in each order: the visit rests on the exception, so it never reads as controlled.
  for (const events of [[{ type: "exception-recorded", slot: "B1", by: OWNER }, controlMet()], [controlMet(), { type: "exception-recorded", slot: "B1", by: OWNER }]] as const) {
    const both = driven(module, EXCEPTION, TWO_BASE, frozen, ...events);
    holds(EXCEPTION, both.controlMet && both.exceptionFor === "B1" && both.exploratory, () => both);
    holds(EXCEPTION, module.visitBasisOf(both, "B1") === "exception", () => both);
    holds(EXCEPTION, module.visitBasisOf(both, "B2") === "control", () => both);
    const visited = accepted(module, EXCEPTION, both, startOf("B1"));
    holds(EXCEPTION, visited.exceptionFor === null && module.visitBasisOf(visited, "B2") === "control", () => visited);
  }
  const neither = driven(module, EXCEPTION, TWO_BASE, frozen);
  holds(EXCEPTION, module.visitBasisOf(neither, "B1") === null, () => neither);
  const passed = driven(module, EXCEPTION, TWO_BASE, frozen, controlMet());
  holds(EXCEPTION, module.visitBasisOf(passed, "B1") === "control", () => passed);
  const excepted = driven(module, EXCEPTION, TWO_BASE, frozen, { type: "exception-recorded", slot: "B1", by: OWNER });
  holds(EXCEPTION, module.visitBasisOf(excepted, "B1") === "exception" && module.visitBasisOf(excepted, "B2") === null, () => excepted);
};

test("an exception covers one named visit, comes from the owner, and comes first", async () => {
  checkBasisOrder(production);
  checkExceptionCovers(production);
  checkExceptionAfterVisit(production);
  checkExceptionByOwner(production);
  checkExceptionNotNext(production);
  checkExceptionPending(production);
  checkExceptionClearedByChange(production);
  const afterVisit = { find: 'if (state.attempts[index].phase !== "planned")\n        return refuse("exception-after-visit");', replace: "" };
  await assertCaughtBy("the exception-after-visit refusal gone", EXCEPTION, () => checkExceptionAfterVisit(machineVariant(afterVisit)));
  // Without both, a late exception is accepted outright, and the case reads exploratory for a visit it did not cover.
  await assertCaughtBy("an exception made after the visit", EXCEPTION, () =>
    checkExceptionAfterVisit(machineVariant(afterVisit, { find: 'if (state.attempts.findIndex(({ phase }) => phase === "planned") !== index)\n        return refuse("exception-not-next");', replace: "" }))
  );
  await assertCaughtBy("an exception from anyone", EXCEPTION, () => checkExceptionByOwner(machineVariant({ find: 'function exceptionRecorded(state, event) {\n    if (!isOwner(event.by))\n        return refuse("owner-only");', replace: "function exceptionRecorded(state, event) {" })));
  await assertCaughtBy("an exception that is not spent", EXCEPTION, () =>
    checkExceptionCovers(
      machineVariant(
        { find: "return accept(Object.assign(Object.assign({}, started), { exceptionFor: null }));", replace: "return accept(started);" },
        { find: "if (state.exceptionFor === slot)", replace: "if (state.exceptionFor !== null)" }
      )
    )
  );
  await assertCaughtBy("a control winning over a recorded exception", EXCEPTION, () => checkBasisOrder(machineVariant({ find: 'if (state.exceptionFor === slot)\n        return "exception";\n    return state.controlMet ? "control" : null;', replace: 'if (state.controlMet)\n        return "control";\n    return state.exceptionFor === slot ? "exception" : null;' })));
  await assertCaughtBy("an exception for a later visit", EXCEPTION, () => checkExceptionNotNext(machineVariant({ find: 'if (state.attempts.findIndex(({ phase }) => phase === "planned") !== index)\n        return refuse("exception-not-next");', replace: "" })));
  await assertCaughtBy("a second exception over a waiting one", EXCEPTION, () => checkExceptionPending(machineVariant({ find: 'if (state.exceptionFor !== null)\n        return refuse("exception-pending");', replace: "" })));
  await assertCaughtBy("an exception that survives a configuration change", EXCEPTION, () =>
    checkExceptionClearedByChange(machineVariant({ find: "controlMet: false, controlMisses: 0, exceptionFor: null }));\n}\nfunction exceptionRecorded", replace: "controlMet: false, controlMisses: 0 }));\n}\nfunction exceptionRecorded" }))
  );
});

const EXPLORATORY = "an exception marks the case exploratory, and nothing clears the mark";

const checkExploratory = (module: MachineModule) => {
  const excepted = driven(module, EXPLORATORY, TWO_BASE, frozen, { type: "exception-recorded", slot: "B1", by: OWNER });
  holds(EXPLORATORY, excepted.exploratory, () => excepted);
  const passed = accepted(module, EXPLORATORY, excepted, controlMet());
  holds(EXPLORATORY, passed.exploratory && passed.controlMet, () => passed);
  const visited = visitOf("B1").reduce((state, event) => accepted(module, EXPLORATORY, state, event), passed);
  holds(EXPLORATORY, visited.exploratory, () => visited);
  const changed = accepted(module, EXPLORATORY, visited, { type: "configuration-changed", configuration: CONFIG_B, by: OWNER });
  holds(EXPLORATORY, changed.exploratory, () => changed);
  const closed = accepted(module, EXPLORATORY, changed, { type: "case-cancelled", by: OWNER });
  holds(EXPLORATORY, closed.exploratory, () => closed);
  // Through a purge, each event of one, and a close of every other kind.
  const path = "01".repeat(32);
  const listed = accepted(module, EXPLORATORY, closed, { type: "purge-manifest-recorded", paths: [path, "02".repeat(32)], by: OWNER });
  holds(EXPLORATORY, listed.exploratory, () => listed);
  const gone = accepted(module, EXPLORATORY, listed, { type: "purge-path-absent", path, by: OWNER });
  holds(EXPLORATORY, gone.exploratory, () => gone);
  const back = accepted(module, EXPLORATORY, gone, { type: "purge-path-remains", path, by: OWNER });
  holds(EXPLORATORY, back.exploratory, () => back);
  const running = driven(module, EXPLORATORY, TWO_BASE, frozen, { type: "exception-recorded", slot: "B1", by: OWNER }, startOf("B1"));
  for (const end of [{ type: "case-deadline", by: OWNER }, { type: "case-cancelled", by: OWNER }] as const) {
    const ended = accepted(module, EXPLORATORY, running, end);
    holds(EXPLORATORY, ended.exploratory, () => ended);
  }
  // A case that completes on its own keeps the mark too.
  const lastSlot = driven(module, EXPLORATORY, planOf("B1"), frozen, { type: "exception-recorded", slot: "B1", by: OWNER }, startOf("B1"), ...captureOf("B1"), finishOf("B1"));
  holds(EXPLORATORY, lastSlot.closedBy === "completed" && lastSlot.exploratory, () => lastSlot);
  // A change that comes after the exception.
  const excepted2 = driven(module, EXPLORATORY, TWO_BASE, frozen, { type: "exception-recorded", slot: "B1", by: OWNER });
  const changedAfter = accepted(module, EXPLORATORY, excepted2, { type: "configuration-changed", configuration: CONFIG_B, by: OWNER });
  holds(EXPLORATORY, changedAfter.exploratory, () => changedAfter);
  const untouched = driven(module, EXPLORATORY, TWO_BASE, frozen, controlMet());
  holds(EXPLORATORY, !untouched.exploratory, () => untouched);
};

test("the exploratory mark stays through a later pass, a change and a close", async () => {
  checkExploratory(production);
  await assertCaughtBy("no mark", EXPLORATORY, () => checkExploratory(machineVariant({ find: "{ exceptionFor: event.slot, exploratory: true }", replace: "{ exceptionFor: event.slot }" })));
  await assertCaughtBy("a later pass clearing the exploratory mark", EXPLORATORY, () => checkExploratory(machineVariant({ find: "{ controlMet, controlMisses: 0 })", replace: "{ controlMet, controlMisses: 0, exploratory: false })" })));
  await assertCaughtBy("a change clearing the mark", EXPLORATORY, () => checkExploratory(machineVariant({ find: "configurationChanges: state.configurationChanges + 1,", replace: "configurationChanges: state.configurationChanges + 1, exploratory: false," })));
  await assertCaughtBy("a purge clearing the mark", EXPLORATORY, () => checkExploratory(machineVariant({ find: "accept(Object.assign(Object.assign({}, state), { purge: result.manifest }))", replace: "accept(Object.assign(Object.assign({}, state), { purge: result.manifest, exploratory: false }))" })));
  await assertCaughtBy("a completed case clearing the mark", EXPLORATORY, () => checkExploratory(machineVariant({ find: 'Object.assign(Object.assign(Object.assign({}, state), GATE_AT_CLOSE), { closedBy: "completed" })', replace: 'Object.assign(Object.assign(Object.assign({}, state), GATE_AT_CLOSE), { closedBy: "completed", exploratory: false })' })));
  await assertCaughtBy("a close clearing the mark", EXPLORATORY, () => checkExploratory(machineVariant({ find: "const GATE_AT_CLOSE = { controlMet: false,", replace: "const GATE_AT_CLOSE = { exploratory: false, controlMet: false," })));
  await assertCaughtBy("a mark from any recorded control", EXPLORATORY, () => checkExploratory(machineVariant({ find: "{ controlMet, controlMisses: 0 })", replace: "{ controlMet, controlMisses: 0, exploratory: true })" })));
});

const BASELINE = "instrumented waits on baseline's rule";

const baselineDone = (module: MachineModule, outcomes: readonly ("usable" | "failed")[]) => {
  const slots: readonly SlotName[] = outcomes.map((_, index) => `B${index + 1}` as SlotName);
  return driven(module, BASELINE, planOf(...slots, "I1", "I2"), frozen, controlMet(), ...slots.flatMap((slot, index) => visitOf(slot, outcomes[index])));
};

const checkBaselineWaits = (module: MachineModule) => {
  const waiting = baselineDone(module, ["usable", "usable", "failed"]);
  holds(BASELINE, waiting.baselineRule === "pending", () => waiting);
  refused(module, BASELINE, waiting, startOf("I1"), "baseline-rule-pending");
  const met = accepted(module, BASELINE, waiting, { type: "baseline-rule-recorded", result: "met", by: OWNER });
  accepted(module, BASELINE, met, startOf("I1"));
};

const checkBaselineNotFinished = (module: MachineModule) => {
  const part = driven(module, BASELINE, planOf("B1", "B2", "I1"), frozen, controlMet(), ...visitOf("B1"));
  refused(module, BASELINE, part, { type: "baseline-rule-recorded", result: "met", by: OWNER }, "baseline-not-finished");
  refused(module, BASELINE, part, { type: "baseline-rule-recorded", result: "not_met", by: OWNER }, "baseline-not-finished");
  // Three planned: two ended is not all of them, whether the third is waiting, running or finishing.
  const twoEnded = driven(module, BASELINE, FULL_PLAN, frozen, controlMet(), ...visitOf("B1"), ...visitOf("B2"));
  refused(module, BASELINE, twoEnded, { type: "baseline-rule-recorded", result: "met", by: OWNER }, "baseline-not-finished");
  const thirdRuns = accepted(module, BASELINE, twoEnded, startOf("B3"));
  refused(module, BASELINE, thirdRuns, { type: "baseline-rule-recorded", result: "met", by: OWNER }, "baseline-not-finished");
  refused(module, BASELINE, thirdRuns, { type: "baseline-rule-recorded", result: "not_met", by: OWNER }, "baseline-not-finished");
};

const checkBaselineFloor = (module: MachineModule) => {
  const one = baselineDone(module, ["usable", "failed", "failed"]);
  refused(module, BASELINE, one, { type: "baseline-rule-recorded", result: "met", by: OWNER }, "baseline-floor-unmet");
  accepted(module, BASELINE, baselineDone(module, ["usable", "usable", "failed"]), { type: "baseline-rule-recorded", result: "met", by: OWNER });
  accepted(module, BASELINE, baselineDone(module, ["usable"]), { type: "baseline-rule-recorded", result: "met", by: OWNER });
  refused(module, BASELINE, baselineDone(module, ["failed"]), { type: "baseline-rule-recorded", result: "met", by: OWNER }, "baseline-floor-unmet");
};

const checkBaselineNotMet = (module: MachineModule) => {
  const closed = accepted(module, BASELINE, baselineDone(module, ["usable", "usable", "failed"]), { type: "baseline-rule-recorded", result: "not_met", by: OWNER });
  holds(BASELINE, closed.closedBy === "baseline_not_met" && closed.baselineRule === "not_met", () => closed);
  holds(BASELINE, closed.attempts.filter(({ arm }) => arm === "instrumented").every(({ phase, cleanup }) => phase === "not_started" && cleanup === null), () => closed);
  holds(BASELINE, closed.attempts.filter(({ arm }) => arm === "baseline").map(({ phase }) => phase).join() === "usable,usable,failed", () => closed);
  refused(module, BASELINE, closed, { type: "baseline-rule-recorded", result: "met", by: OWNER }, "case-closed");
};

const checkBaselineOwner = (module: MachineModule) => {
  const waiting = baselineDone(module, ["usable", "usable"]);
  refused(module, BASELINE, waiting, { type: "baseline-rule-recorded", result: "met", by: runnerOf("B1") }, "owner-only");
  accepted(module, BASELINE, waiting, { type: "baseline-rule-recorded", result: "met", by: OWNER });
};

const checkBaselineOnce = (module: MachineModule) => {
  const met = accepted(module, BASELINE, baselineDone(module, ["usable", "usable"]), { type: "baseline-rule-recorded", result: "met", by: OWNER });
  refused(module, BASELINE, met, { type: "baseline-rule-recorded", result: "not_met", by: OWNER }, "baseline-rule-already-recorded");
};

/** One usable under each of two configurations is not two usable under the one in force. */
const checkFloorInForce = (module: MachineModule) => {
  // Two usable, one under each configuration, is not two under the one in force.
  const twoConfigurations = driven(module, BASELINE, planOf("B1", "B2", "B3", "I1"), frozen, controlMet(CONFIG_A), ...visitOf("B1"), { type: "configuration-changed", configuration: CONFIG_B, by: OWNER }, controlMet(CONFIG_B), ...visitOf("B2"), ...visitOf("B3", "failed"));
  refused(module, BASELINE, twoConfigurations, { type: "baseline-rule-recorded", result: "met", by: OWNER }, "baseline-floor-unmet");
  // The owner can still say not_met, and the case closes.
  accepted(module, BASELINE, twoConfigurations, { type: "baseline-rule-recorded", result: "not_met", by: OWNER });
  // Three planned, one under the first configuration and two under the second, meets it.
  const twoInForce = driven(module, BASELINE, planOf("B1", "B2", "B3", "I1"), frozen, controlMet(CONFIG_A), ...visitOf("B1"), { type: "configuration-changed", configuration: CONFIG_B, by: OWNER }, controlMet(CONFIG_B), ...visitOf("B2"), ...visitOf("B3"));
  accepted(module, BASELINE, twoInForce, { type: "baseline-rule-recorded", result: "met", by: OWNER });
  // An incomplete attempt in force does not count toward it.
  const notUsable = driven(module, BASELINE, planOf("B1", "B2", "I1"), frozen, controlMet(), ...visitOf("B1"), ...visitOf("B2", "incomplete"));
  refused(module, BASELINE, notUsable, { type: "baseline-rule-recorded", result: "met", by: OWNER }, "baseline-floor-unmet");
  const walledToo = driven(module, BASELINE, planOf("B1", "B2", "I1"), frozen, controlMet(), ...visitOf("B1", "walled"), ...visitOf("B2"));
  refused(module, BASELINE, walledToo, { type: "baseline-rule-recorded", result: "met", by: OWNER }, "baseline-floor-unmet");
};

/** A rule met under one configuration does not carry to another: the change is refused once it is recorded. */
const checkNoChangeAfterRule = (module: MachineModule) => {
  const met = accepted(module, BASELINE, baselineDone(module, ["usable", "usable"]), { type: "baseline-rule-recorded", result: "met", by: OWNER });
  refused(module, BASELINE, met, { type: "configuration-changed", configuration: CONFIG_B, by: OWNER }, "configuration-after-rule");
  // A plan of one arm has no rule to hold it, and its change stands, in either arm.
  accepted(module, BASELINE, driven(module, BASELINE, planOf("I1", "I2"), frozen, controlMet(), ...visitOf("I1")), { type: "configuration-changed", configuration: CONFIG_B, by: OWNER });
  accepted(module, BASELINE, driven(module, BASELINE, planOf("B1", "B2"), frozen, controlMet(), ...visitOf("B1")), { type: "configuration-changed", configuration: CONFIG_B, by: OWNER });
};

const REACHABLE = "while the rule is pending, a change is refused when the baseline slots not yet started cannot reach the floor under it";

const change: MachineEvent = { type: "configuration-changed", configuration: CONFIG_B, by: OWNER };
const metRule: MachineEvent = { type: "baseline-rule-recorded", result: "met", by: OWNER };

const checkFloorStaysReachable = (module: MachineModule) => {
  const allowed = (plan: PlanInput, events: readonly MachineEvent[]) => accepted(module, REACHABLE, driven(module, REACHABLE, plan, frozen, controlMet(), ...events), change);
  const stranded = (plan: PlanInput, events: readonly MachineEvent[]) => refused(module, REACHABLE, driven(module, REACHABLE, plan, frozen, controlMet(), ...events), change, "configuration-floor-unreachable");
  const two = planOf("B1", "B2", "I1");
  const three = planOf("B1", "B2", "B3", "I1");
  const one = planOf("B1", "I1");
  // Two baselines: only before the first starts are there two left to run.
  allowed(two, []);
  stranded(two, visitOf("B1"));
  stranded(two, visitOf("B1", "failed"));
  stranded(two, [...visitOf("B1"), ...visitOf("B2")]);
  // Three: one may have gone, and two may not.
  allowed(three, []);
  allowed(three, visitOf("B1"));
  allowed(three, visitOf("B1", "walled"));
  stranded(three, [...visitOf("B1"), ...visitOf("B2")]);
  // One: the floor is one, so it may change until that one starts.
  allowed(one, []);
  stranded(one, visitOf("B1"));

  // Nothing is lost by the refusal. The reproduction: both usable under the first configuration, a refused change, and the rule still met there.
  const both = driven(module, REACHABLE, two, frozen, controlMet(), ...visitOf("B1"), ...visitOf("B2"));
  refused(module, REACHABLE, both, change, "configuration-floor-unreachable");
  holds(REACHABLE, both.configurationChanges === 0 && both.configuration === CONFIG_A, () => both);
  const met = accepted(module, REACHABLE, both, metRule);
  holds(REACHABLE, met.baselineRule === "met" && met.closedBy === null, () => met);
  accepted(module, REACHABLE, met, startOf("I1"));

  // What a change that is allowed leaves reachable, it really does: two left, and two run under the new one.
  const moved = allowed(three, visitOf("B1"));
  const onward = [controlMet(CONFIG_B), ...visitOf("B2"), ...visitOf("B3")].reduce((state, event) => accepted(module, REACHABLE, state, event), moved);
  accepted(module, REACHABLE, onward, metRule);

  // Refused for what it is first: an unchanged configuration, and a spent change, name themselves.
  const done = driven(module, REACHABLE, two, frozen, controlMet(), ...visitOf("B1"));
  refused(module, REACHABLE, done, { type: "configuration-changed", configuration: CONFIG_A, by: OWNER }, "configuration-unchanged");
  const spent = [change, controlMet(CONFIG_B), ...visitOf("B1")].reduce((state, event) => accepted(module, REACHABLE, state, event), driven(module, REACHABLE, three, frozen));
  refused(module, REACHABLE, spent, { type: "configuration-changed", configuration: CONFIG_A, by: OWNER }, "configuration-change-spent");
};

test("a change that would leave the rule's met out of reach is refused, and nothing is lost by that", async () => {
  checkFloorStaysReachable(production);
  const guard = 'if (baseline.filter(({ phase }) => phase === "planned").length < baselineFloor(baseline))\n            return refuse("configuration-floor-unreachable");';
  await assertCaughtBy("a change stranding the floor", REACHABLE, () => checkFloorStaysReachable(machineVariant({ find: guard, replace: "" })));
  await assertCaughtBy("what already ran counted as still able to", REACHABLE, () => checkFloorStaysReachable(machineVariant({ find: 'baseline.filter(({ phase }) => phase === "planned").length < baselineFloor(baseline)', replace: "baseline.length < baselineFloor(baseline)" })));
  await assertCaughtBy("exactly enough left taken as too few", REACHABLE, () => checkFloorStaysReachable(machineVariant({ find: 'baseline.filter(({ phase }) => phase === "planned").length < baselineFloor(baseline)', replace: 'baseline.filter(({ phase }) => phase === "planned").length <= baselineFloor(baseline)' })));
  await assertCaughtBy("a floor of two for a plan of one", REACHABLE, () => checkFloorStaysReachable(machineVariant({ find: "return Math.min(2, baseline.length);", replace: "return 2;" })));
  await assertCaughtBy("no change at all once a visit began", REACHABLE, () => checkFloorStaysReachable(machineVariant({ find: 'baseline.filter(({ phase }) => phase === "planned").length < baselineFloor(baseline)', replace: 'baseline.some(({ phase }) => phase !== "planned")' })));
  await assertCaughtBy("a plan of one arm held to a rule it does not have", BASELINE, () => checkNoChangeAfterRule(machineVariant({ find: 'if (state.baselineRule === "pending") {\n        // Only what', replace: 'if (state.baselineRule !== "met") {\n        // Only what' })));
});

/** The rule binds every instrumented slot, not only the first a plan happens to name. */
const checkSkippedSlot = (module: MachineModule) => {
  for (const later of ["I2", "I3"] as const) {
    const ended = driven(module, BASELINE, planOf("B1", later), frozen, controlMet(), ...visitOf("B1"));
    refused(module, BASELINE, ended, startOf(later), "baseline-rule-pending");
    const met = accepted(module, BASELINE, ended, { type: "baseline-rule-recorded", result: "met", by: OWNER });
    accepted(module, BASELINE, met, startOf(later));
  }
  // A plan may skip baseline slots too, and they still come first and are still baseline.
  const skipped = driven(module, BASELINE, planOf("B2", "I2"), frozen, controlMet());
  holds(BASELINE, skipped.baselineRule === "pending" && skipped.attempts[0].arm === "baseline" && skipped.attempts[1].arm === "instrumented", () => skipped);
};

const checkNoRuleInOneArm = (module: MachineModule) => {
  const scenario = driven(module, BASELINE, planOf("I1", "I2"), frozen, controlMet());
  holds(BASELINE, scenario.baselineRule === "not_applicable", () => scenario);
  refused(module, BASELINE, scenario, { type: "baseline-rule-recorded", result: "met", by: OWNER }, "no-baseline");
  accepted(module, BASELINE, scenario, startOf("I1"));
};

test("instrumented waits on baseline's rule, which holds a floor it can count and leaves the rest to the owner", async () => {
  for (const check of [checkBaselineWaits, checkBaselineNotFinished, checkBaselineFloor, checkFloorInForce, checkNoChangeAfterRule, checkSkippedSlot, checkBaselineNotMet, checkBaselineOwner, checkBaselineOnce, checkNoRuleInOneArm]) check(production);
  await assertCaughtBy("a floor across configurations", BASELINE, () => checkFloorInForce(machineVariant({ find: 'phase === "usable" && configuration === state.configuration', replace: 'phase === "usable"' })));
  await assertCaughtBy("incomplete counted as usable", BASELINE, () => checkFloorInForce(machineVariant({ find: 'phase === "usable" && configuration === state.configuration', replace: '(phase === "usable" || phase === "incomplete") && configuration === state.configuration' })));
  await assertCaughtBy("a change after the rule", BASELINE, () => checkNoChangeAfterRule(machineVariant({ find: 'if (state.baselineRule === "met")\n        return refuse("configuration-after-rule");', replace: "" })));
  await assertCaughtBy("no change in a plan of one arm", BASELINE, () => checkNoChangeAfterRule(machineVariant({ find: 'if (state.baselineRule === "met")\n        return refuse("configuration-after-rule");', replace: 'if (state.baselineRule !== "pending")\n        return refuse("configuration-after-rule");' })));
  await assertCaughtBy("the rule on the first instrumented slot only", BASELINE, () => checkSkippedSlot(machineVariant({ find: 'if (attempt.arm === "instrumented" && state.baselineRule === "pending")', replace: 'if (attempt.slot === "I1" && state.baselineRule === "pending")' })));
  await assertCaughtBy("the instrumented arm not waiting", BASELINE, () => checkBaselineWaits(machineVariant({ find: 'if (attempt.arm === "instrumented" && state.baselineRule === "pending")\n        return refuse("baseline-rule-pending");', replace: "" })));
  await assertCaughtBy("the rule before the baseline ended", BASELINE, () => checkBaselineNotFinished(machineVariant({ find: 'if (!baseline.every(({ phase }) => isSettledPhase(phase)))\n        return refuse("baseline-not-finished");', replace: "" })));
  await assertCaughtBy("the rule waiting on the first two baseline attempts only", BASELINE, () => checkBaselineNotFinished(machineVariant({ find: 'if (!baseline.every(({ phase }) => isSettledPhase(phase)))', replace: 'if (!baseline.slice(0, 2).every(({ phase }) => isSettledPhase(phase)))' })));
  await assertCaughtBy("one baseline attempt finishing being enough", BASELINE, () => checkBaselineNotFinished(machineVariant({ find: "!baseline.every(({ phase }) => isSettledPhase(phase))", replace: "!baseline.some(({ phase }) => isSettledPhase(phase))" })));
  await assertCaughtBy("no floor", BASELINE, () => checkBaselineFloor(machineVariant({ find: 'if (usable < baselineFloor(baseline))\n        return refuse("baseline-floor-unmet");', replace: "" })));
  await assertCaughtBy("a floor of one", BASELINE, () => checkBaselineFloor(machineVariant({ find: "return Math.min(2, baseline.length);", replace: "return 1;" })));
  await assertCaughtBy("a floor of two whatever was planned", BASELINE, () => checkBaselineFloor(machineVariant({ find: "return Math.min(2, baseline.length);", replace: "return 2;" })));
  await assertCaughtBy("not_met leaving the case open", BASELINE, () => checkBaselineNotMet(machineVariant({ find: 'accept(closeWith(Object.assign(Object.assign({}, state), { baselineRule: "not_met" }), "failed", "baseline_not_met"))', replace: 'accept(Object.assign(Object.assign({}, state), { baselineRule: "not_met" }))' })));
  await assertCaughtBy("the rule from anyone", BASELINE, () => checkBaselineOwner(machineVariant({ find: 'function baselineRuleRecorded(state, event) {\n    if (!isOwner(event.by))\n        return refuse("owner-only");', replace: "function baselineRuleRecorded(state, event) {" })));
  await assertCaughtBy("the rule rewritten", BASELINE, () => checkBaselineOnce(machineVariant({ find: 'if (state.baselineRule !== "pending")\n        return refuse("baseline-rule-already-recorded");', replace: "" })));
  await assertCaughtBy("a rule in a plan with one arm", BASELINE, () => checkNoRuleInOneArm(machineVariant({ find: 'if (state.baselineRule === "not_applicable")\n        return refuse("no-baseline");', replace: "" })));
  await assertCaughtBy("a one-armed plan held to the rule", BASELINE, () => checkNoRuleInOneArm(machineVariant({ find: 'arms.includes("baseline") && arms.includes("instrumented") ? "pending" : "not_applicable"', replace: '"pending"' })));
});

const ONE_RUNS = "at most one attempt runs, in plan order";

const checkOneAtATime = (module: MachineModule) => {
  const running = driven(module, ONE_RUNS, TWO_BASE, frozen, controlMet(), startOf("B1"));
  refused(module, ONE_RUNS, running, startOf("B2"), "another-attempt-running");
  refused(module, ONE_RUNS, running, controlMet(), "another-attempt-running");
  refused(module, ONE_RUNS, running, { type: "configuration-changed", configuration: CONFIG_B, by: OWNER }, "another-attempt-running");
  refused(module, ONE_RUNS, running, startOf("B1"), "attempt-already-begun");
};

const checkOrder = (module: MachineModule) => {
  const ready = driven(module, ONE_RUNS, TWO_BASE, frozen, controlMet());
  refused(module, ONE_RUNS, ready, startOf("B2"), "not-next-slot");
  accepted(module, ONE_RUNS, ready, startOf("B1"));
};

test("at most one attempt runs, and attempts run in plan order", async () => {
  checkOneAtATime(production);
  checkOrder(production);
  await assertCaughtBy("the running check on a start", ONE_RUNS, () =>
    checkOneAtATime(machineVariant({ find: 'if (state.attempts.some(({ phase }) => isRunningPhase(phase)))\n        return refuse("another-attempt-running");\n    if (state.attempts.findIndex', replace: "if (state.attempts.findIndex" }))
  );
  await assertCaughtBy("a start out of order", ONE_RUNS, () => checkOrder(machineVariant({ find: 'if (state.attempts.findIndex(({ phase }) => phase === "planned") !== index)\n        return refuse("not-next-slot");', replace: "" })));
  await assertCaughtBy("a repeat start", ONE_RUNS, () => checkOneAtATime(machineVariant({ find: 'if (attempt.phase !== "planned")\n        return refuse("attempt-already-begun");', replace: "" })));
});

const SIX_SLOTS = "the last slots of a full plan obey the same rules as the first";

/** A full plan, up to the visit named, so a guard that reads only the first few attempts is seen. */
const checkSixSlots = (module: MachineModule) => {
  const met: readonly MachineEvent[] = [frozen, controlMet(), ...visitOf("B1"), ...visitOf("B2"), ...visitOf("B3"), { type: "baseline-rule-recorded", result: "met", by: OWNER }];
  const toI2 = driven(module, SIX_SLOTS, FULL_PLAN, ...met, ...visitOf("I1"), startOf("I2"));
  // The arms' seam: I1 cannot go ahead of a B3 that still runs, or past its cleanup, however the rule stands.
  const b3Runs = driven(module, SIX_SLOTS, FULL_PLAN, frozen, controlMet(), ...visitOf("B1"), ...visitOf("B2"), startOf("B3"));
  refused(module, SIX_SLOTS, b3Runs, startOf("I1"), "another-attempt-running");
  const b3Ended = [...captureOf("B3"), finishOf("B3")].reduce((state, event) => accepted(module, SIX_SLOTS, state, event), b3Runs);
  const b3Pending = accepted(module, SIX_SLOTS, b3Ended, { type: "baseline-rule-recorded", result: "met", by: OWNER });
  holds(SIX_SLOTS, b3Pending.attempts[2].cleanup === "pending", () => b3Pending);
  refused(module, SIX_SLOTS, b3Pending, startOf("I1"), "cleanup-unresolved");
  holds(SIX_SLOTS, JSON.stringify(module.continuationOf(b3Pending)) === '{"continuation":"blocked","reason":"cleanup_unresolved","slots":["B3"]}', () => b3Pending);
  refused(module, SIX_SLOTS, accepted(module, SIX_SLOTS, b3Pending, { type: "cleanup-unconfirmed", slot: "B3", by: OWNER }), startOf("I1"), "cleanup-unresolved");
  accepted(module, SIX_SLOTS, accepted(module, SIX_SLOTS, b3Pending, confirmOf("B3")), startOf("I1"));
  // One at a time, between the last two slots of the plan.
  refused(module, SIX_SLOTS, toI2, startOf("I3"), "another-attempt-running");
  holds(SIX_SLOTS, module.denominatorOf(toI2).running === 1 && module.denominatorOf(toI2).waiting === 1, () => module.denominatorOf(toI2));
  // I2 ends with its cleanup open, in each unresolved way: I3 waits on it, and continuation names I2.
  const ended = [...captureOf("I2"), finishOf("I2")].reduce((state, event) => accepted(module, SIX_SLOTS, state, event), toI2);
  refused(module, SIX_SLOTS, ended, startOf("I3"), "cleanup-unresolved");
  holds(SIX_SLOTS, JSON.stringify(module.continuationOf(ended)) === '{"continuation":"blocked","reason":"cleanup_unresolved","slots":["I2"]}', () => ended);
  const unconfirmed = accepted(module, SIX_SLOTS, ended, { type: "cleanup-unconfirmed", slot: "I2", by: OWNER });
  refused(module, SIX_SLOTS, unconfirmed, startOf("I3"), "cleanup-unresolved");
  holds(SIX_SLOTS, module.continuationOf(unconfirmed).continuation === "blocked", () => unconfirmed);
  // Order holds at the end too: I3 cannot go ahead of a waiting I2.
  const beforeI2 = driven(module, SIX_SLOTS, FULL_PLAN, ...met, ...visitOf("I1"));
  refused(module, SIX_SLOTS, beforeI2, startOf("I3"), "not-next-slot");
  // And with I2's cleanup settled, I3 runs, and its own end closes the case.
  const cleared = accepted(module, SIX_SLOTS, unconfirmed, destroyOf("I2"));
  holds(SIX_SLOTS, module.continuationOf(cleared).continuation === "allowed", () => cleared);
  const last = [startOf("I3"), ...captureOf("I3"), finishOf("I3")].reduce((state, event) => accepted(module, SIX_SLOTS, state, event), cleared);
  holds(SIX_SLOTS, last.closedBy === "completed" && !module.isTerminal(last), () => last);
  holds(SIX_SLOTS, module.isTerminal(accepted(module, SIX_SLOTS, last, confirmOf("I3"))), () => last);
};

test("a full plan's last slots obey one at a time, cleanup and order, by name", async () => {
  checkSixSlots(production);
  const firstFour = (find: string, replace: string) => machineVariant({ find, replace });
  await assertCaughtBy("the cleanup guard reading only the first four attempts, with the running guard after it", SIX_SLOTS, () =>
    checkSixSlots(
      machineVariant(
        { find: 'if (state.attempts.some(({ phase }) => isRunningPhase(phase)))\n        return refuse("another-attempt-running");\n    if (state.attempts.findIndex', replace: 'if (state.attempts.slice(0, 4).some(({ phase }) => isRunningPhase(phase)))\n        return refuse("another-attempt-running");\n    if (state.attempts.findIndex' },
        { find: 'if (state.attempts.some(({ cleanup }) => isCleanupUnresolved(cleanup)))\n        return refuse("cleanup-unresolved");', replace: 'if (state.attempts.slice(0, 4).some(({ cleanup }) => isCleanupUnresolved(cleanup)))\n        return refuse("cleanup-unresolved");' }
      )
    )
  );
  await assertCaughtBy("the cleanup guard reading only the first four attempts", SIX_SLOTS, () => checkSixSlots(firstFour('if (state.attempts.some(({ cleanup }) => isCleanupUnresolved(cleanup)))\n        return refuse("cleanup-unresolved");', 'if (state.attempts.slice(0, 4).some(({ cleanup }) => isCleanupUnresolved(cleanup)))\n        return refuse("cleanup-unresolved");')));
  await assertCaughtBy("a guard skipping B3's cleanup", SIX_SLOTS, () => checkSixSlots(firstFour('if (state.attempts.some(({ cleanup }) => isCleanupUnresolved(cleanup)))\n        return refuse("cleanup-unresolved");', 'if (state.attempts.filter(({ slot }) => slot !== "B3").some(({ cleanup }) => isCleanupUnresolved(cleanup)))\n        return refuse("cleanup-unresolved");')));
  await assertCaughtBy("a guard skipping B3 when reading what runs", SIX_SLOTS, () => checkSixSlots(firstFour('if (state.attempts.some(({ phase }) => isRunningPhase(phase)))\n        return refuse("another-attempt-running");\n    if (state.attempts.findIndex', 'if (state.attempts.filter(({ slot }) => slot !== "B3").some(({ phase }) => isRunningPhase(phase)))\n        return refuse("another-attempt-running");\n    if (state.attempts.findIndex')));
  await assertCaughtBy("continuation reading only the first four attempts", SIX_SLOTS, () => checkSixSlots(firstFour("const slots = state.attempts.filter(({ cleanup }) => isCleanupUnresolved(cleanup)).map(({ slot }) => slot);", "const slots = state.attempts.slice(0, 4).filter(({ cleanup }) => isCleanupUnresolved(cleanup)).map(({ slot }) => slot);")));
  await assertCaughtBy("terminal reading only the first attempt's cleanup", SIX_SLOTS, () => checkSixSlots(firstFour('return state.closedBy !== null && !state.attempts.some((attempt) => attempt.cleanup === "pending");', 'return state.closedBy !== null && state.attempts[0].cleanup !== "pending";')));
});

const CONTINUATION = "continuation blocks on unresolved cleanup, and on nothing else about an attempt";

const checkContinuation = (module: MachineModule) => {
  const ended = driven(module, CONTINUATION, TWO_BASE, frozen, controlMet(), startOf("B1"), ...captureOf("B1"), finishOf("B1"));
  holds(CONTINUATION, ended.attempts[0].cleanup === "pending", () => ended);
  holds(CONTINUATION, JSON.stringify(module.continuationOf(ended)) === '{"continuation":"blocked","reason":"cleanup_unresolved","slots":["B1"]}', () => ended);
  refused(module, CONTINUATION, ended, startOf("B2"), "cleanup-unresolved");

  const unconfirmed = accepted(module, CONTINUATION, ended, { type: "cleanup-unconfirmed", slot: "B1", by: OWNER });
  holds(CONTINUATION, unconfirmed.attempts[0].phase === "usable", () => unconfirmed);
  holds(CONTINUATION, module.continuationOf(unconfirmed).continuation === "blocked", () => unconfirmed);
  refused(module, CONTINUATION, unconfirmed, startOf("B2"), "cleanup-unresolved");

  for (const clear of [confirmOf("B1"), destroyOf("B1")]) {
    for (const from of [ended, unconfirmed]) {
      const cleared = accepted(module, CONTINUATION, from, clear);
      holds(CONTINUATION, module.continuationOf(cleared).continuation === "allowed", () => cleared);
      accepted(module, CONTINUATION, cleared, startOf("B2"));
    }
  }
  const closed = accepted(module, CONTINUATION, ended, { type: "case-cancelled", by: OWNER });
  holds(CONTINUATION, module.continuationOf(closed).continuation === "not_applicable", () => closed);
};

test("unresolved cleanup blocks the next attempt, and the attempt's outcome stays what it was", async () => {
  checkContinuation(production);
  await assertCaughtBy("the cleanup check on a start", CONTINUATION, () => checkContinuation(machineVariant({ find: 'if (state.attempts.some(({ cleanup }) => isCleanupUnresolved(cleanup)))\n        return refuse("cleanup-unresolved");', replace: "" })));
  await assertCaughtBy("only pending counting as unresolved", CONTINUATION, () => checkContinuation(machineVariant({ find: 'return cleanup === "pending" || cleanup === "unconfirmed";', replace: 'return cleanup === "pending";' })));
  await assertCaughtBy("only unconfirmed counting as unresolved", CONTINUATION, () => checkContinuation(machineVariant({ find: 'return cleanup === "pending" || cleanup === "unconfirmed";', replace: 'return cleanup === "unconfirmed";' })));
  await assertCaughtBy("the rejected rule capping an attempt at incomplete", CONTINUATION, () => checkContinuation(machineVariant({ find: 'return accept(withAttempt(state, index, { cleanup: "unconfirmed" }));', replace: 'return accept(withAttempt(state, index, { cleanup: "unconfirmed", phase: "incomplete" }));' })));
});

const NO_WAITING = "a cancel and a deadline end the case now, whatever cleanup is doing";

const checkCancelNeverWaits = (module: MachineModule) => {
  // Cleanup unresolved, in both ways, with the next slot blocked behind it.
  const pending = driven(module, NO_WAITING, TWO_BASE, frozen, controlMet(), startOf("B1"), ...captureOf("B1"), finishOf("B1"));
  const unconfirmed = accepted(module, NO_WAITING, pending, { type: "cleanup-unconfirmed", slot: "B1", by: OWNER });
  for (const stuck of [pending, unconfirmed]) {
    const cancelled = accepted(module, NO_WAITING, stuck, { type: "case-cancelled", by: OWNER });
    holds(NO_WAITING, cancelled.closedBy === "cancelled" && cancelled.attempts[1].phase === "not_started", () => cancelled);
    holds(NO_WAITING, cancelled.attempts[0].phase === "usable" && cancelled.attempts[0].cleanup === stuck.attempts[0].cleanup, () => cancelled);
  }
  // A running attempt ends as cancelled, its cleanup still to come.
  const running = driven(module, NO_WAITING, TWO_BASE, frozen, controlMet(), startOf("B1"), captureOf("B1")[0]);
  const stopped = accepted(module, NO_WAITING, running, { type: "case-cancelled", by: OWNER });
  holds(NO_WAITING, stopped.attempts[0].phase === "cancelled" && stopped.attempts[0].cleanup === "pending" && stopped.attempts[1].phase === "not_started", () => stopped);
  holds(NO_WAITING, stopped.closedBy === "cancelled" && !module.isTerminal(stopped), () => stopped);
};

const checkDeadlineNeverWaits = (module: MachineModule) => {
  const pending = driven(module, NO_WAITING, TWO_BASE, frozen, controlMet(), startOf("B1"), ...captureOf("B1"), finishOf("B1"));
  const closed = accepted(module, NO_WAITING, pending, { type: "case-deadline", by: OWNER });
  holds(NO_WAITING, closed.closedBy === "deadline" && closed.attempts[1].phase === "not_started" && closed.attempts[1].configuration === CONFIG_A, () => closed);
  const running = driven(module, NO_WAITING, TWO_BASE, frozen, controlMet(), startOf("B1"), captureOf("B1")[0]);
  const late = accepted(module, NO_WAITING, running, { type: "case-deadline", by: OWNER });
  holds(NO_WAITING, late.attempts[0].phase === "timed_out", () => late);
  const before = accepted(module, NO_WAITING, start(module, NO_WAITING, TWO_BASE), { type: "case-deadline", by: OWNER });
  holds(NO_WAITING, before.attempts.every(({ phase }) => phase === "not_started"), () => before);
};

test("a cancel and a deadline never wait on cleanup", async () => {
  checkCancelNeverWaits(production);
  checkDeadlineNeverWaits(production);
  const waitsOn = 'if (state.attempts.some(({ cleanup }) => isCleanupUnresolved(cleanup)))\n        return refuse("cleanup-unresolved");';
  await assertCaughtBy("a cancel waiting on cleanup", NO_WAITING, () => checkCancelNeverWaits(machineVariant({ find: 'return accept(closeWith(state, "cancelled", "cancelled"));', replace: `${waitsOn}\n    return accept(closeWith(state, "cancelled", "cancelled"));` })));
  await assertCaughtBy("a deadline waiting on cleanup", NO_WAITING, () => checkDeadlineNeverWaits(machineVariant({ find: 'return accept(closeWith(state, "timed_out", "deadline"));', replace: `${waitsOn}\n    return accept(closeWith(state, "timed_out", "deadline"));` })));
  await assertCaughtBy("a cancel resolving cleanup on paper", NO_WAITING, () => checkCancelNeverWaits(machineVariant({ find: 'return accept(closeWith(state, "cancelled", "cancelled"));', replace: 'return accept(closeWith(Object.assign(Object.assign({}, state), { attempts: state.attempts.map((attempt) => (attempt.cleanup === "pending" ? Object.assign(Object.assign({}, attempt), { cleanup: "confirmed" }) : attempt)) }), "cancelled", "cancelled"));' })));
  await assertCaughtBy("a cancel counting a running attempt as failed", NO_WAITING, () => checkCancelNeverWaits(machineVariant({ find: 'closeWith(state, "cancelled", "cancelled")', replace: 'closeWith(state, "failed", "cancelled")' })));
  await assertCaughtBy("a close leaving a slot planned", NO_WAITING, () => checkCancelNeverWaits(machineVariant({ find: 'if (attempt.phase === "planned")\n                return Object.assign(Object.assign({}, attempt), { phase: "not_started", configuration: state.configuration });', replace: "" })));
});

const SUPERVISOR = "a supervisor's event ends a running attempt without the capture's help";

const checkAttemptDeadline = (module: MachineModule) => {
  for (const phaseEvents of [[], captureOf("B1").slice(0, 1), captureOf("B1")]) {
    const running = driven(module, SUPERVISOR, TWO_BASE, frozen, controlMet(), startOf("B1"), ...phaseEvents);
    const ended = accepted(module, SUPERVISOR, running, { type: "attempt-deadline", slot: "B1", by: OWNER });
    holds(SUPERVISOR, ended.attempts[0].phase === "timed_out" && ended.attempts[0].cleanup === "pending" && ended.closedBy === null, () => ended);
    refused(module, SUPERVISOR, ended, { type: "attempt-deadline", slot: "B1", by: OWNER }, "wrong-phase");
  }
  const last = driven(module, SUPERVISOR, planOf("I1"), frozen, controlMet(), startOf("I1"));
  const closed = accepted(module, SUPERVISOR, last, { type: "attempt-deadline", slot: "I1", by: OWNER });
  holds(SUPERVISOR, closed.closedBy === "completed", () => closed);
};

const checkReconcile = (module: MachineModule) => {
  const ready = driven(module, SUPERVISOR, TWO_BASE, frozen, controlMet());
  refused(module, SUPERVISOR, ready, { type: "reconcile", by: OWNER }, "nothing-to-reconcile");
  const running = accepted(module, SUPERVISOR, ready, startOf("B1"));
  const lost = accepted(module, SUPERVISOR, running, { type: "reconcile", by: OWNER });
  holds(SUPERVISOR, lost.attempts[0].phase === "failed" && lost.attempts[0].cleanup === "unconfirmed", () => lost);
  refused(module, SUPERVISOR, lost, { type: "reconcile", by: OWNER }, "nothing-to-reconcile");

  // An attempt that ended on its own, with its cleanup never answered.
  const ended = driven(module, SUPERVISOR, TWO_BASE, frozen, controlMet(), startOf("B1"), ...captureOf("B1"), finishOf("B1"));
  const unanswered = accepted(module, SUPERVISOR, ended, { type: "reconcile", by: OWNER });
  holds(SUPERVISOR, unanswered.attempts[0].phase === "usable" && unanswered.attempts[0].cleanup === "unconfirmed", () => unanswered);

  // A closed case with cleanup pending is not terminal, and this is what lets it become so.
  const closed = accepted(module, SUPERVISOR, ended, { type: "case-cancelled", by: OWNER });
  holds(SUPERVISOR, closed.closedBy !== null && !module.isTerminal(closed), () => closed);
  const answered = accepted(module, SUPERVISOR, closed, { type: "reconcile", by: OWNER });
  holds(SUPERVISOR, module.isTerminal(answered), () => answered);
};

test("deadline and reconcile need nothing from a capture", async () => {
  checkAttemptDeadline(production);
  checkReconcile(production);
  await assertCaughtBy("a deadline on a finished attempt", SUPERVISOR, () => checkAttemptDeadline(machineVariant({ find: 'if (!isRunningPhase(state.attempts[index].phase))\n        return refuse("wrong-phase");', replace: "" })));
  await assertCaughtBy("a deadline that only reaches capturing", SUPERVISOR, () => checkAttemptDeadline(machineVariant({ find: 'if (!isRunningPhase(state.attempts[index].phase))\n        return refuse("wrong-phase");', replace: 'if (state.attempts[index].phase !== "capturing")\n        return refuse("wrong-phase");' })));
  await assertCaughtBy("a last attempt's deadline leaving the case open", SUPERVISOR, () => checkAttemptDeadline(machineVariant({ find: 'return finish(state, index, "timed_out");', replace: 'return accept(withAttempt(state, index, { phase: "timed_out", startRetries: 0 }));' })));
  await assertCaughtBy("a reconcile that leaves cleanup looking fine", SUPERVISOR, () => checkReconcile(machineVariant({ find: '{ phase: "failed", cleanup: "unconfirmed", startRetries: 0 }', replace: '{ phase: "failed", startRetries: 0 }' })));
  await assertCaughtBy("a reconcile with nothing to do, accepted anyway", SUPERVISOR, () => checkReconcile(machineVariant({ find: 'if (!state.attempts.some(({ cleanup }) => cleanup === "pending"))\n        return refuse("nothing-to-reconcile");', replace: "" })));
  await assertCaughtBy("a terminal test that ignores pending cleanup", SUPERVISOR, () => checkReconcile(machineVariant({ find: 'return state.closedBy !== null && !state.attempts.some((attempt) => attempt.cleanup === "pending");', replace: "return state.closedBy !== null;" })));
});

const RUNNER = "only an attempt's own runner reports for it";

const checkRunnerBinding = (module: MachineModule) => {
  const running = driven(module, RUNNER, TWO_BASE, frozen, controlMet(), startOf("B1"));
  for (const by of [OWNER, runnerOf("B2"), CONTROL_RUNNER, FOREIGN_RUNNER]) {
    refused(module, RUNNER, running, { type: "capture-began", slot: "B1", by }, "not-this-attempt");
    refused(module, RUNNER, running, { type: "attempt-start-retried", slot: "B1", by }, "not-this-attempt");
    refused(module, RUNNER, running, { type: "attempt-finished", slot: "B1", outcome: "failed", by }, "not-this-attempt");
    refused(module, RUNNER, running, { type: "evidence-recorded", slot: "B1", id: "row-one", by }, "not-this-attempt");
  }
  const capturing = accepted(module, RUNNER, running, { type: "capture-began", slot: "B1", by: runnerOf("B1") });
  refused(module, RUNNER, capturing, { type: "capture-finished", slot: "B1", by: runnerOf("B2") }, "not-this-attempt");
  accepted(module, RUNNER, capturing, { type: "capture-finished", slot: "B1", by: runnerOf("B1") });
  // Cleanup is the owner's or that attempt's own runner's. Another attempt's runner cannot clear what blocks it.
  const ended = driven(module, RUNNER, planOf("B1", "B2", "I1"), frozen, controlMet(), startOf("B1"), ...captureOf("B1"), finishOf("B1"));
  for (const type of ["cleanup-confirmed", "cleanup-unconfirmed", "environment-destroyed"] as const) {
    for (const by of [runnerOf("B2"), runnerOf("I1"), CONTROL_RUNNER, FOREIGN_RUNNER]) refused(module, RUNNER, ended, { type, slot: "B1", by }, "not-this-attempt");
    accepted(module, RUNNER, ended, { type, slot: "B1", by: runnerOf("B1") });
    accepted(module, RUNNER, ended, { type, slot: "B1", by: OWNER });
  }
};

const AUTHORITY = "each event comes only from who may send it";

const checkAuthority = (module: MachineModule) => {
  const fresh = start(module, AUTHORITY, ONE_EACH);
  const everyRunner = [runnerOf("B1"), runnerOf("I1"), CONTROL_RUNNER, FOREIGN_RUNNER];
  for (const by of everyRunner) refused(module, AUTHORITY, fresh, { ...frozen, by }, "owner-only");
  const ready = accepted(module, AUTHORITY, fresh, frozen);
  // A control comes from the one control run the plan declares: not the owner, and no other runner.
  refused(module, AUTHORITY, ready, { type: "control-recorded", configuration: CONFIG_A, result: "met", by: OWNER }, "runner-only");
  for (const by of [runnerOf("B1"), runnerOf("I1"), FOREIGN_RUNNER]) refused(module, AUTHORITY, ready, { type: "control-recorded", configuration: CONFIG_A, result: "met", by }, "not-this-case");
  accepted(module, AUTHORITY, ready, { type: "control-recorded", configuration: CONFIG_A, result: "met", by: CONTROL_RUNNER });
  for (const by of everyRunner) {
    // Nothing a runner sends can start a visit, change the configuration, or close the case.
    refused(module, AUTHORITY, ready, { type: "configuration-changed", configuration: CONFIG_B, by }, "owner-only");
    refused(module, AUTHORITY, ready, { type: "case-cancelled", by }, "owner-only");
    refused(module, AUTHORITY, ready, { type: "case-deadline", by }, "owner-only");
    refused(module, AUTHORITY, ready, { type: "reconcile", by }, "owner-only");
    refused(module, AUTHORITY, ready, { type: "attempt-started", slot: "B1", by }, "owner-only");
  }
  const running = accepted(module, AUTHORITY, accepted(module, AUTHORITY, ready, controlMet()), startOf("B1"));
  // A deadline or a reconcile on a running attempt is the owner's, even from that attempt's own runner.
  for (const by of everyRunner) {
    refused(module, AUTHORITY, running, { type: "attempt-deadline", slot: "B1", by }, "owner-only");
    refused(module, AUTHORITY, running, { type: "reconcile", by }, "owner-only");
    refused(module, AUTHORITY, running, { type: "case-deadline", by }, "owner-only");
  }
  accepted(module, AUTHORITY, running, { type: "attempt-deadline", slot: "B1", by: OWNER });
  accepted(module, AUTHORITY, running, { type: "reconcile", by: OWNER });
  accepted(module, AUTHORITY, running, { type: "case-deadline", by: OWNER });
};

test("a runner reports only for its own attempt, and each event comes only from who may send it", async () => {
  checkRunnerBinding(production);
  checkAuthority(production);
  await assertCaughtBy("any runner reporting for any attempt", RUNNER, () => checkRunnerBinding(machineVariant({ find: 'return by.kind === "system:runner" && by.attemptId === attempt.attemptId;', replace: 'return by.kind === "system:runner";' })));
  await assertCaughtBy("the owner typing a capture in", RUNNER, () => checkRunnerBinding(machineVariant({ find: 'if (!isRunnerOf(by, state.attempts[index]))\n        return "not-this-attempt";', replace: 'if (by.kind !== "owner" && !isRunnerOf(by, state.attempts[index]))\n        return "not-this-attempt";' })));
  const cleanupWho = 'if (!isOwner(event.by) && !isRunnerOf(event.by, attempt))\n        return refuse("not-this-attempt");';
  await assertCaughtBy("cleanup from any runner", RUNNER, () => checkRunnerBinding(machineVariant({ find: cleanupWho, replace: 'if (!isOwner(event.by) && event.by.kind !== "system:runner")\n        return refuse("not-this-attempt");' })));
  await assertCaughtBy("cleanup from the owner alone", RUNNER, () => checkRunnerBinding(machineVariant({ find: cleanupWho, replace: 'if (!isOwner(event.by))\n        return refuse("not-this-attempt");' })));
  await assertCaughtBy("cleanup from a runner alone", RUNNER, () => checkRunnerBinding(machineVariant({ find: cleanupWho, replace: 'if (!isRunnerOf(event.by, attempt))\n        return refuse("not-this-attempt");' })));
  await assertCaughtBy("the owner typing a control in", AUTHORITY, () => checkAuthority(machineVariant({ find: 'if (event.by.kind !== "system:runner")\n        return refuse("runner-only");', replace: "" })));
  await assertCaughtBy("a control from any runner", AUTHORITY, () => checkAuthority(machineVariant({ find: 'if (event.by.attemptId !== state.controlRunId)\n        return refuse("not-this-case");', replace: "" })));
  const ownerOnly = (name: string) => ({ find: `function ${name}(state, event) {\n    if (!isOwner(event.by))\n        return refuse("owner-only");`, replace: `function ${name}(state, event) {` });
  for (const [what, name] of [
    ["a start from a runner", "attemptStarted"],
    ["an attempt deadline from a runner", "attemptDeadline"],
    ["a case deadline from a runner", "caseDeadline"],
    ["a reconcile from a runner", "reconcile"]
  ] as const) {
    await assertCaughtBy(what, AUTHORITY, () => checkAuthority(machineVariant(ownerOnly(name))));
  }
  await assertCaughtBy("a freeze from anyone", AUTHORITY, () => checkAuthority(machineVariant({ find: 'function planFrozen(state, event) {\n    if (!isOwner(event.by))\n        return refuse("owner-only");', replace: "function planFrozen(state, event) {" })));
  await assertCaughtBy("a change from anyone", AUTHORITY, () => checkAuthority(machineVariant({ find: 'function configurationChanged(state, event) {\n    if (!isOwner(event.by))\n        return refuse("owner-only");', replace: "function configurationChanged(state, event) {" })));
  await assertCaughtBy("a cancel from anyone", AUTHORITY, () => checkAuthority(machineVariant({ find: 'function caseCancelled(state, event) {\n    if (!isOwner(event.by))\n        return refuse("owner-only");', replace: "function caseCancelled(state, event) {" })));
});

const OUTCOMES_REACHABLE = "an outcome is reachable only from the phases that can report it";

const checkReportable = (module: MachineModule) => {
  const by = runnerOf("I1");
  const at = (...events: readonly MachineEvent[]) => driven(module, OUTCOMES_REACHABLE, planOf("I1"), frozen, controlMet(), startOf("I1"), ...events);
  const table: readonly (readonly [MachineState, "usable" | "walled" | "failed" | "incomplete", boolean])[] = [
    [at(), "failed", true],
    [at(), "walled", false],
    [at(), "usable", false],
    [at(), "incomplete", false],
    [at({ type: "capture-began", slot: "I1", by }), "failed", true],
    [at({ type: "capture-began", slot: "I1", by }), "walled", true],
    [at({ type: "capture-began", slot: "I1", by }), "usable", false],
    [at({ type: "capture-began", slot: "I1", by }), "incomplete", false],
    [at(...captureOf("I1")), "usable", true],
    [at(...captureOf("I1")), "incomplete", true],
    [at(...captureOf("I1")), "walled", true],
    [at(...captureOf("I1")), "failed", true]
  ];
  for (const [state, outcome, reachable] of table) {
    const answer = refusalOf(module, state, { type: "attempt-finished", slot: "I1", outcome, by });
    holds(OUTCOMES_REACHABLE, answer === (reachable ? "accepted" : "outcome-not-reachable"), () => ({ phase: state.attempts[0].phase, outcome, answer }));
  }
  refused(module, OUTCOMES_REACHABLE, at(), { type: "capture-finished", slot: "I1", by }, "wrong-phase");
  refused(module, OUTCOMES_REACHABLE, at(...captureOf("I1")), { type: "capture-began", slot: "I1", by }, "wrong-phase");
  // Timed out and cancelled are nobody's to report: they come from a deadline and a cancel, and the type has no such outcome.
  for (const outcome of ["timed_out", "cancelled", "not_started", "planned"] as const) {
    refused(module, OUTCOMES_REACHABLE, at(...captureOf("I1")), { type: "attempt-finished", slot: "I1", outcome, by } as unknown as MachineEvent, "outcome-not-reachable");
  }
};

test("an outcome is reachable only from the phases spelled out here", async () => {
  checkReportable(production);
  await assertCaughtBy("no table", OUTCOMES_REACHABLE, () => checkReportable(machineVariant({ find: 'if (!REPORTABLE[phase].includes(event.outcome))\n        return refuse("outcome-not-reachable");', replace: "" })));
  await assertCaughtBy("usable while capturing", OUTCOMES_REACHABLE, () => checkReportable(machineVariant({ find: 'capturing: ["failed", "walled"],', replace: 'capturing: ["failed", "walled", "usable"],' })));
  await assertCaughtBy("a wall while starting", OUTCOMES_REACHABLE, () => checkReportable(machineVariant({ find: 'starting: ["failed"],', replace: 'starting: ["failed", "walled"],' })));
  await assertCaughtBy("a capture restarting", OUTCOMES_REACHABLE, () => checkReportable(machineVariant({ find: 'function captureBegan(state, event) {\n    const found = runnerEvent(state, event.by, event.slot);\n    if (typeof found === "string")\n        return refuse(found);\n    if (found.attempt.phase !== "starting")\n        return refuse("wrong-phase");', replace: 'function captureBegan(state, event) {\n    const found = runnerEvent(state, event.by, event.slot);\n    if (typeof found === "string")\n        return refuse(found);' })));
  await assertCaughtBy("a capture finishing before it began", OUTCOMES_REACHABLE, () => checkReportable(machineVariant({ find: 'if (found.attempt.phase !== "capturing")\n        return refuse("wrong-phase");', replace: "" })));
});

const RETRIES = "a start retry is counted, capped, and forgotten once the attempt moves on";

const checkRetries = (module: MachineModule) => {
  const by = runnerOf("B1");
  const retry: MachineEvent = { type: "attempt-start-retried", slot: "B1", by };
  const starting = driven(module, RETRIES, TWO_BASE, frozen, controlMet(), startOf("B1"));
  const twice = [retry, retry].reduce((state, event) => accepted(module, RETRIES, state, event), starting);
  holds(RETRIES, twice.attempts[0].startRetries === 2, () => twice);
  refused(module, RETRIES, twice, retry, "start-retry-limit");
  const capturing = accepted(module, RETRIES, twice, { type: "capture-began", slot: "B1", by });
  holds(RETRIES, capturing.attempts[0].startRetries === 0, () => capturing);
  refused(module, RETRIES, capturing, retry, "wrong-phase");
  const ended = accepted(module, RETRIES, twice, { type: "attempt-finished", slot: "B1", outcome: "failed", by });
  holds(RETRIES, ended.attempts[0].startRetries === 0, () => ended);
  for (const close of [{ type: "case-cancelled", by: OWNER }, { type: "case-deadline", by: OWNER }, { type: "reconcile", by: OWNER }, { type: "attempt-deadline", slot: "B1", by: OWNER }] as const) {
    const closed = accepted(module, RETRIES, twice, close);
    holds(RETRIES, closed.attempts[0].startRetries === 0, () => ({ close, closed }));
  }
};

test("a start retry is counted in the state and capped, so the machine cannot loop on one", async () => {
  checkRetries(production);
  await assertCaughtBy("no cap", RETRIES, () => checkRetries(machineVariant({ find: 'if (found.attempt.startRetries >= exports.MAX_START_RETRIES)\n        return refuse("start-retry-limit");', replace: "" })));
  await assertCaughtBy("a retry after the capture began", RETRIES, () => checkRetries(machineVariant({ find: 'function attemptStartRetried(state, event) {\n    const found = runnerEvent(state, event.by, event.slot);\n    if (typeof found === "string")\n        return refuse(found);\n    if (found.attempt.phase !== "starting")\n        return refuse("wrong-phase");', replace: 'function attemptStartRetried(state, event) {\n    const found = runnerEvent(state, event.by, event.slot);\n    if (typeof found === "string")\n        return refuse(found);' })));
  await assertCaughtBy("a count kept past the start", RETRIES, () => checkRetries(machineVariant({ find: '{ phase: "capturing", startRetries: 0 }', replace: '{ phase: "capturing" }' })));
  await assertCaughtBy("a count kept past a finish", RETRIES, () => checkRetries(machineVariant({ find: "return accept(closeIfDone(withAttempt(state, index, { phase, startRetries: 0 })));", replace: "return accept(closeIfDone(withAttempt(state, index, { phase })));" })));
  await assertCaughtBy("a count kept past a close", RETRIES, () => checkRetries(machineVariant({ find: "{ phase: runningOutcome, startRetries: 0 }", replace: "{ phase: runningOutcome }" })));
  await assertCaughtBy("a count kept past a reconcile", RETRIES, () => checkRetries(machineVariant({ find: '{ phase: "failed", cleanup: "unconfirmed", startRetries: 0 }', replace: '{ phase: "failed", cleanup: "unconfirmed" }' })));
});

const CONFIGURATION = "one configuration change, between attempts, recorded on what ran under each";

const checkConfiguration = (module: MachineModule) => {
  const ready = driven(module, CONFIGURATION, TWO_BASE, frozen, controlMet(), ...visitOf("B1"));
  refused(module, CONFIGURATION, ready, { type: "configuration-changed", configuration: CONFIG_A, by: OWNER }, "configuration-unchanged");
  const changed = accepted(module, CONFIGURATION, ready, { type: "configuration-changed", configuration: CONFIG_B, by: OWNER });
  holds(CONFIGURATION, changed.configuration === CONFIG_B && changed.configurationChanges === 1, () => changed);
  holds(CONFIGURATION, changed.attempts[0].configuration === CONFIG_A && changed.attempts[1].configuration === null, () => changed);
  refused(module, CONFIGURATION, changed, { type: "configuration-changed", configuration: CONFIG_A, by: OWNER }, "configuration-change-spent");
  const passed = accepted(module, CONFIGURATION, changed, controlMet(CONFIG_B));
  const second = accepted(module, CONFIGURATION, passed, startOf("B2"));
  holds(CONFIGURATION, second.attempts[1].configuration === CONFIG_B, () => second);
  // A slot that never ran still belongs to the configuration in force when the case closed.
  const closed = accepted(module, CONFIGURATION, changed, { type: "case-cancelled", by: OWNER });
  holds(CONFIGURATION, closed.attempts[1].configuration === CONFIG_B && closed.attempts[1].phase === "not_started", () => closed);
};

test("one configuration change, with each attempt recording what it ran under", async () => {
  checkConfiguration(production);
  await assertCaughtBy("a second change", CONFIGURATION, () => checkConfiguration(machineVariant({ find: 'if (state.configurationChanges >= exports.MAX_CONFIGURATION_CHANGES)\n        return refuse("configuration-change-spent");', replace: "" })));
  await assertCaughtBy("a change to the same configuration", CONFIGURATION, () => checkConfiguration(machineVariant({ find: 'if (event.configuration === state.configuration)\n        return refuse("configuration-unchanged");', replace: "" })));
  await assertCaughtBy("an attempt with no configuration recorded", CONFIGURATION, () => checkConfiguration(machineVariant({ find: '{ phase: "starting", cleanup: "pending", configuration: state.configuration }', replace: '{ phase: "starting", cleanup: "pending" }' })));
  await assertCaughtBy("an unstarted slot with no configuration recorded", CONFIGURATION, () => checkConfiguration(machineVariant({ find: '{ phase: "not_started", configuration: state.configuration }', replace: '{ phase: "not_started" }' })));
  await assertCaughtBy("a change rewriting what already ran", CONFIGURATION, () => checkConfiguration(machineVariant({ find: "configuration: event.configuration, configurationChanges: state.configurationChanges + 1,", replace: "configuration: event.configuration, attempts: state.attempts.map((attempt) => Object.assign(Object.assign({}, attempt), { configuration: attempt.configuration === null ? null : event.configuration })), configurationChanges: state.configurationChanges + 1," })));
});

const CLEANUP = "cleanup moves forward only, once an attempt has ended";

const checkCleanupStates = (module: MachineModule) => {
  const ready = driven(module, CLEANUP, TWO_BASE, frozen, controlMet());
  refused(module, CLEANUP, ready, confirmOf("B1"), "no-cleanup");
  const running = accepted(module, CLEANUP, ready, startOf("B1"));
  refused(module, CLEANUP, running, confirmOf("B1"), "attempt-running");
  refused(module, CLEANUP, running, destroyOf("B1"), "attempt-running");
  refused(module, CLEANUP, running, { type: "cleanup-unconfirmed", slot: "B1", by: OWNER }, "attempt-running");
  const ended = [...captureOf("B1"), finishOf("B1")].reduce((state, event) => accepted(module, CLEANUP, state, event), running);
  holds(CLEANUP, ended.attempts[0].cleanup === "pending", () => ended);
  const unconfirmed = accepted(module, CLEANUP, ended, { type: "cleanup-unconfirmed", slot: "B1", by: OWNER });
  refused(module, CLEANUP, unconfirmed, { type: "cleanup-unconfirmed", slot: "B1", by: OWNER }, "cleanup-settled");
  const confirmed = accepted(module, CLEANUP, unconfirmed, confirmOf("B1"));
  holds(CLEANUP, confirmed.attempts[0].cleanup === "confirmed", () => confirmed);
  const destroyed = accepted(module, CLEANUP, ended, destroyOf("B1"));
  holds(CLEANUP, destroyed.attempts[0].cleanup === "environment_destroyed", () => destroyed);
  for (const settled of [confirmed, destroyed]) {
    for (const event of [confirmOf("B1"), destroyOf("B1"), { type: "cleanup-unconfirmed", slot: "B1", by: OWNER }] as const) refused(module, CLEANUP, settled, event, "cleanup-settled");
  }
};

test("cleanup moves forward only, and only after the attempt ended", async () => {
  checkCleanupStates(production);
  await assertCaughtBy("cleanup with nothing to clean", CLEANUP, () => checkCleanupStates(machineVariant({ find: 'if (attempt.cleanup === null)\n        return refuse("no-cleanup");', replace: "" })));
  await assertCaughtBy("cleanup during a visit", CLEANUP, () => checkCleanupStates(machineVariant({ find: 'if (isRunningPhase(attempt.phase))\n        return refuse("attempt-running");', replace: "" })));
  await assertCaughtBy("a settled cleanup moving back", CLEANUP, () => checkCleanupStates(machineVariant({ find: 'if (attempt.cleanup === "confirmed" || attempt.cleanup === "environment_destroyed")\n        return refuse("cleanup-settled");', replace: "" })));
  await assertCaughtBy("confirmed read as destroyed", CLEANUP, () => checkCleanupStates(machineVariant({ find: 'cleanup: event.type === "cleanup-confirmed" ? "confirmed" : "environment_destroyed"', replace: 'cleanup: "environment_destroyed"' })));
  await assertCaughtBy("an unconfirmed read that repeats", CLEANUP, () => checkCleanupStates(machineVariant({ find: 'if (attempt.cleanup === "unconfirmed")\n            return refuse("cleanup-settled");', replace: "" })));
});

const EVIDENCE = "evidence is added to an attempt that began, and stays";

const checkEvidence = (module: MachineModule) => {
  const by = runnerOf("B1");
  const row = (id: string): MachineEvent => ({ type: "evidence-recorded", slot: "B1", id, by });
  const ready = driven(module, EVIDENCE, TWO_BASE, frozen, controlMet());
  refused(module, EVIDENCE, ready, row("row-one"), "attempt-not-begun");
  const capturing = driven(module, EVIDENCE, TWO_BASE, frozen, controlMet(), startOf("B1"), captureOf("B1")[0], row("row-one"), row("row-two"));
  holds(EVIDENCE, capturing.attempts[0].evidence.join() === "row-one,row-two", () => capturing);
  refused(module, EVIDENCE, capturing, row("row-one"), "evidence-duplicate");
  // After the attempt ended and the case closed, a late row is still kept.
  const closed = [{ type: "case-cancelled", by: OWNER }, row("row-late")].reduce((state, event) => accepted(module, EVIDENCE, state, event as MachineEvent), capturing);
  holds(EVIDENCE, closed.attempts[0].phase === "cancelled" && closed.attempts[0].evidence.join() === "row-one,row-two,row-late", () => closed);
  // A slot closed unstarted has nothing to add to.
  refused(module, EVIDENCE, closed, { type: "evidence-recorded", slot: "B2", id: "row-three", by: runnerOf("B2") }, "attempt-not-begun");
  // One id belongs to one attempt, across the case.
  const second = driven(module, EVIDENCE, TWO_BASE, frozen, controlMet(), ...visitOf("B1"), row("row-one"), startOf("B2"));
  refused(module, EVIDENCE, second, { type: "evidence-recorded", slot: "B2", id: "row-one", by: runnerOf("B2") }, "evidence-duplicate");
};

test("evidence is only ever added, including after the attempt ended", async () => {
  checkEvidence(production);
  await assertCaughtBy("a row for an attempt that never began", EVIDENCE, () => checkEvidence(machineVariant({ find: 'if (phase === "planned" || phase === "not_started")\n        return refuse("attempt-not-begun");', replace: "" })));
  await assertCaughtBy("a row for a slot closed unstarted", EVIDENCE, () => checkEvidence(machineVariant({ find: 'if (phase === "planned" || phase === "not_started")\n        return refuse("attempt-not-begun");', replace: 'if (phase === "planned")\n        return refuse("attempt-not-begun");' })));
  await assertCaughtBy("a duplicate id", EVIDENCE, () => checkEvidence(machineVariant({ find: 'if (state.attempts.some(({ evidence }) => evidence.includes(event.id)))\n        return refuse("evidence-duplicate");', replace: "" })));
  await assertCaughtBy("a duplicate checked only within its own attempt", EVIDENCE, () => checkEvidence(machineVariant({ find: "state.attempts.some(({ evidence }) => evidence.includes(event.id))", replace: "found.attempt.evidence.includes(event.id)" })));
  await assertCaughtBy("a new row replacing the list", EVIDENCE, () => checkEvidence(machineVariant({ find: "{ evidence: [...found.attempt.evidence, event.id] }", replace: "{ evidence: [event.id] }" })));
});

const CLOSED = "a closed case takes no event that would steer a visit";

const checkClosed = (module: MachineModule) => {
  const closed = driven(module, CLOSED, TWO_BASE, frozen, { type: "case-cancelled", by: OWNER });
  refused(module, CLOSED, closed, controlMet(), "case-closed");
  refused(module, CLOSED, closed, { type: "configuration-changed", configuration: CONFIG_B, by: OWNER }, "case-closed");
  refused(module, CLOSED, closed, { type: "exception-recorded", slot: "B1", by: OWNER }, "case-closed");
  refused(module, CLOSED, closed, startOf("B1"), "case-closed");
  refused(module, CLOSED, closed, { type: "case-cancelled", by: OWNER }, "case-closed");
  refused(module, CLOSED, closed, { type: "case-deadline", by: OWNER }, "case-closed");
  const never = driven(module, CLOSED, TWO_BASE, { type: "case-deadline", by: OWNER });
  refused(module, CLOSED, never, frozen, "case-closed");
  const both = driven(module, CLOSED, ONE_EACH, { type: "case-cancelled", by: OWNER });
  refused(module, CLOSED, both, { type: "baseline-rule-recorded", result: "met", by: OWNER }, "case-closed");
  // What steered visits is cleared, and what still means something is not.
  const gated = driven(module, CLOSED, TWO_BASE, frozen, { type: "exception-recorded", slot: "B1", by: OWNER }, controlMet(), { type: "case-cancelled", by: OWNER });
  holds(CLOSED, !gated.controlMet && gated.exceptionFor === null && gated.controlMisses === 0 && gated.exploratory && gated.planDigest === PLAN_DIGEST, () => gated);
  const missed = driven(module, CLOSED, TWO_BASE, frozen, { type: "control-recorded", configuration: CONFIG_A, result: "not_met", by: CONTROL_RUNNER }, ...[{ type: "exception-recorded", slot: "B1", by: OWNER } as const], startOf("B1"), { type: "attempt-finished", slot: "B1", outcome: "failed", by: runnerOf("B1") }, confirmOf("B1"), { type: "exception-recorded", slot: "B2", by: OWNER }, startOf("B2"), { type: "attempt-finished", slot: "B2", outcome: "failed", by: runnerOf("B2") });
  holds(CLOSED, missed.closedBy === "completed" && missed.controlMisses === 0, () => missed);
};

const NO_SLOT = "an event naming a slot this plan does not hold is refused by name";

const checkNoSlot = (module: MachineModule) => {
  const ready = driven(module, NO_SLOT, ONE_EACH, frozen, controlMet());
  const answer = (event: MachineEvent) => {
    try {
      return refusalOf(module, ready, event);
    } catch (error) {
      return `threw: ${String(error)}`;
    }
  };
  for (const event of [
    { type: "exception-recorded", slot: "I3", by: OWNER },
    { type: "attempt-started", slot: "I3", by: OWNER },
    { type: "attempt-start-retried", slot: "I3", by: runnerOf("I3") },
    { type: "capture-began", slot: "I3", by: runnerOf("I3") },
    { type: "capture-finished", slot: "I3", by: runnerOf("I3") },
    { type: "attempt-finished", slot: "I3", outcome: "failed", by: runnerOf("I3") },
    { type: "evidence-recorded", slot: "I3", id: "row-one", by: runnerOf("I3") },
    { type: "attempt-deadline", slot: "I3", by: OWNER },
    { type: "cleanup-confirmed", slot: "I3", by: OWNER },
    { type: "cleanup-unconfirmed", slot: "I3", by: OWNER },
    { type: "environment-destroyed", slot: "I3", by: OWNER }
  ] as const satisfies readonly MachineEvent[]) {
    const result = answer(event);
    holds(NO_SLOT, result === "no-such-slot", () => ({ event, result }));
  }
};

test("a closed case is closed, and a slot the plan does not hold is no slot", async () => {
  checkClosed(production);
  checkNoSlot(production);
  const closedLine = 'if (state.closedBy !== null)\n        return refuse("case-closed");';
  for (const [name, find, replace] of [
    ["a control on a closed case", `return refuse("not-this-case");\n    ${closedLine}`, 'return refuse("not-this-case");'],
    ["a change on a closed case", `function configurationChanged(state, event) {\n    if (!isOwner(event.by))\n        return refuse("owner-only");\n    ${closedLine}`, 'function configurationChanged(state, event) {\n    if (!isOwner(event.by))\n        return refuse("owner-only");'],
    ["an exception on a closed case", `return refuse("no-such-slot");\n    ${closedLine}\n    if (state.planDigest === null)\n        return refuse("plan-not-frozen");\n    if (state.attempts[index].phase`, 'return refuse("no-such-slot");\n    if (state.planDigest === null)\n        return refuse("plan-not-frozen");\n    if (state.attempts[index].phase'],
    ["a visit on a closed case", `const attempt = state.attempts[index];\n    ${closedLine}`, "const attempt = state.attempts[index];"],
    ["a freeze on a closed case", `function planFrozen(state, event) {\n    if (!isOwner(event.by))\n        return refuse("owner-only");\n    ${closedLine}`, 'function planFrozen(state, event) {\n    if (!isOwner(event.by))\n        return refuse("owner-only");'],
    ["a rule on a closed case", `function baselineRuleRecorded(state, event) {\n    if (!isOwner(event.by))\n        return refuse("owner-only");\n    ${closedLine}`, 'function baselineRuleRecorded(state, event) {\n    if (!isOwner(event.by))\n        return refuse("owner-only");'],
    ["a second cancel", `${closedLine}\n    return accept(closeWith(state, "cancelled", "cancelled"));`, 'return accept(closeWith(state, "cancelled", "cancelled"));'],
    ["a second deadline", `${closedLine}\n    return accept(closeWith(state, "timed_out", "deadline"));`, 'return accept(closeWith(state, "timed_out", "deadline"));'],
    ["a close keeping what steered visits", "const GATE_AT_CLOSE = { controlMet: false, controlMisses: 0, exceptionFor: null };", "const GATE_AT_CLOSE = {};"]
  ] as const) {
    await assertCaughtBy(name, CLOSED, () => checkClosed(machineVariant({ find, replace })));
  }
  for (const [name, find, replace] of [
    ["no check on an exception", 'const index = indexOfSlot(state, event.slot);\n    if (index < 0)\n        return refuse("no-such-slot");\n    if (state.closedBy !== null)\n        return refuse("case-closed");\n    if (state.planDigest === null)\n        return refuse("plan-not-frozen");\n    if (state.attempts[index].phase', 'const index = indexOfSlot(state, event.slot);\n    if (state.closedBy !== null)\n        return refuse("case-closed");\n    if (state.planDigest === null)\n        return refuse("plan-not-frozen");\n    if (state.attempts[index].phase'],
    ["no check on a start", 'return refuse("owner-only");\n    const index = indexOfSlot(state, event.slot);\n    if (index < 0)\n        return refuse("no-such-slot");\n    const attempt = state.attempts[index];\n    if (state.closedBy !== null)', 'return refuse("owner-only");\n    const index = indexOfSlot(state, event.slot);\n    const attempt = state.attempts[index];\n    if (state.closedBy !== null)'],
    ["no check on what a runner reports", 'const index = indexOfSlot(state, slot);\n    if (index < 0)\n        return "no-such-slot";', "const index = indexOfSlot(state, slot);"],
    ["no check on a deadline", 'const index = indexOfSlot(state, event.slot);\n    if (index < 0)\n        return refuse("no-such-slot");\n    if (!isRunningPhase(state.attempts[index].phase))', "const index = indexOfSlot(state, event.slot);\n    if (!isRunningPhase(state.attempts[index].phase))"],
    ["no check on cleanup", 'const index = indexOfSlot(state, event.slot);\n    if (index < 0)\n        return refuse("no-such-slot");\n    const attempt = state.attempts[index];\n    if (!isOwner(event.by)', "const index = indexOfSlot(state, event.slot);\n    const attempt = state.attempts[index];\n    if (!isOwner(event.by)"]
  ] as const) {
    await assertCaughtBy(name, NO_SLOT, () => checkNoSlot(machineVariant({ find, replace })));
  }
});

test("the control's own refusals and the running check on a control and on a change", async () => {
  const check = (module: MachineModule) => {
    const property = "a control is taken once per configuration, between visits, and not forever";
    const passed = driven(module, property, ONE_EACH, frozen, controlMet());
    refused(module, property, passed, controlMet(), "control-already-met");
    const miss: MachineEvent = { type: "control-recorded", configuration: CONFIG_A, result: "not_met", by: CONTROL_RUNNER };
    const twice = driven(module, property, ONE_EACH, frozen, miss, miss);
    refused(module, property, twice, miss, "control-limit");
    const running = driven(module, property, ONE_EACH, frozen, { type: "exception-recorded", slot: "B1", by: OWNER }, startOf("B1"));
    refused(module, property, running, miss, "another-attempt-running");
    refused(module, property, running, { type: "configuration-changed", configuration: CONFIG_B, by: OWNER }, "another-attempt-running");
  };
  check(production);
  const property = "a control is taken once per configuration, between visits, and not forever";
  const running = 'if (state.attempts.some(({ phase }) => isRunningPhase(phase)))\n        return refuse("another-attempt-running");';
  await assertCaughtBy("a second control over a passed one", property, () => check(machineVariant({ find: 'if (state.controlMet)\n        return refuse("control-already-met");', replace: "" })));
  await assertCaughtBy("no cap on misses", property, () => check(machineVariant({ find: 'if (state.controlMisses >= exports.MAX_CONTROL_MISSES)\n        return refuse("control-limit");', replace: "" })));
  await assertCaughtBy("a control during a visit", property, () => check(machineVariant({ find: `${running}\n    if (state.controlMet)`, replace: "if (state.controlMet)" })));
  await assertCaughtBy("a change during a visit", property, () => check(machineVariant({ find: `${running}\n    if (state.baselineRule === "met")`, replace: 'if (state.baselineRule === "met")' })));
});

test("an unknown event is refused where it would have done something", async () => {
  const property = "an event of no known type is refused";
  const check = (module: MachineModule) => {
    const state = start(module, property, ONE_EACH);
    const answer = module.step(state, { type: "claim-approved", by: OWNER } as unknown as MachineEvent);
    holds(property, !answer.ok && answer.refusal === "unknown-event", () => answer);
  };
  check(production);
  await assertCaughtBy("an unknown event accepted", property, () => check(machineVariant({ find: 'return refuse("unknown-event");', replace: "return accept(state);" })));
});

const SOURCE = readFileSync(path.join(process.cwd(), "investigation/core/case-machine.ts"), "utf8");
const PURGE_SOURCE = readFileSync(path.join(process.cwd(), "investigation/core/purge.ts"), "utf8");

/** Every identifier a reader of the parse would see used as a value, for what a pure function must not reach. */
function identifiersIn(file: string, source: string): Set<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) names.add(node.text);
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true));
  return names;
}

test("the machine reads no clock, no randomness and no store, and imports only the purge reducer", () => {
  for (const [file, source] of [["case-machine.ts", SOURCE], ["purge.ts", PURGE_SOURCE]] as const) {
    const names = identifiersIn(file, source);
    for (const banned of ["Date", "performance", "Math.random", "random", "crypto", "fetch", "setTimeout", "setInterval", "process", "globalThis", "Promise"]) {
      assert.equal(names.has(banned), false, `${file} names ${banned}`);
    }
  }
  const runtimeImports = (source: string) => [...source.matchAll(/^import (?!type)[^;]*from "([^"]+)";/gm)].map((match) => match[1]);
  assert.deepEqual(runtimeImports(SOURCE), ["./purge"]);
  assert.deepEqual(runtimeImports(PURGE_SOURCE), []);
  assert.equal(step.length, 2, "step takes the state and the event");
});

test("no event names an arm, and the event list has no way to change one", () => {
  const bodyOfEvents = SOURCE.slice(SOURCE.indexOf("type Body ="), SOURCE.indexOf("export type MachineEvent ="));
  assert.ok(bodyOfEvents.includes('"plan-frozen"'), "the event list could not be located");
  assert.doesNotMatch(bodyOfEvents, /\barm\b/);
});

test("the machine's caps are the values this suite assumes", () => {
  assert.deepEqual([production.MAX_CONTROL_MISSES, production.MAX_START_RETRIES, production.MAX_CONFIGURATION_CHANGES], [2, 2, 1]);
});
