import { createHash } from "node:crypto";
import { runnerActorFrom, type Actor } from "../core/actor";
import type { ConfigurationIdentity } from "../core/case-events";
import { configurationKey } from "../core/case-events";
import { createLog, putEvidence, type LogEvent, type LogStores } from "../core/case-log";
import { openCase, runCommand, type OpenCase } from "../core/case-store";
import type { MachineActor, MachineEvent, MachineState, PlanInput, SlotName, StepResult } from "../core/case-machine";
import type * as productionMachine from "../core/case-machine";
import { holds } from "../../lib/finite-check";

/**
 * The synthetic world the workspace's W2 suites run in. Every name in it is invented, and
 * every address is under a reserved name. Nothing here came from a real site, and nothing
 * here visits anything. An attempt id differs from its slot's label, from its slot's arm and
 * from every other id, so a confusion between them cannot pass by looking right.
 */

export type MachineModule = typeof productionMachine;

/** Thirty-two hex digits each, the shape the log's runner actor holds, and all different. */
export const ATTEMPT_IDS: Readonly<Record<SlotName, string>> = {
  B1: "1b".repeat(16),
  B2: "2b".repeat(16),
  B3: "3b".repeat(16),
  I1: "1f".repeat(16),
  I2: "2f".repeat(16),
  I3: "3f".repeat(16)
};
/** A control run is a runner too, with its own id, and holds no slot. Every plan here declares this one. */
export const CONTROL_RUN_ID = "c0".repeat(16);
/** A runner of some other case, which has no say here. */
export const FOREIGN_RUN_ID = "ee".repeat(16);

export const OWNER: MachineActor = { kind: "owner" };
export const runnerOf = (slot: SlotName): MachineActor => ({ kind: "system:runner", attemptId: ATTEMPT_IDS[slot] });
export const CONTROL_RUNNER: MachineActor = { kind: "system:runner", attemptId: CONTROL_RUN_ID };
export const FOREIGN_RUNNER: MachineActor = { kind: "system:runner", attemptId: FOREIGN_RUN_ID };

export const CANARY_QUERY = "CANARY-QUERY-VALUE-9c1b";
export const CANARY_PATH = "CANARY-PATH-alice.person";
export const CANARY_STORAGE = "CANARY-STORAGE-VALUE-44d0";
export const CANARY_SCRIPT = "CANARY-SCRIPT-TEXT-7f3a";
export const CANARY_CONSOLE = "CANARY-CONSOLE-TEXT-1e77";
export const CANARIES = [CANARY_QUERY, CANARY_PATH, CANARY_STORAGE, CANARY_SCRIPT, CANARY_CONSOLE] as const;

const rawCapture = (label: string): string =>
  JSON.stringify({
    label,
    url: `https://orchard-lane.example/${CANARY_PATH}/lantern.js?token=${CANARY_QUERY}`,
    text: `function lantern() { /* ${CANARY_SCRIPT} */ }`,
    storage: [{ key: "lantern-state", value: CANARY_STORAGE }],
    console: [CANARY_CONSOLE]
  });

/**
 * What the store holds, by label. The captures hold what only the raw tier may hold: the
 * canaries above appear in those objects, and a test scans everything else for them. The rest
 * are what a case's own records rest on: a frozen plan, a control's fixture and criterion, a patch.
 */
export const RAW_OBJECTS: Readonly<Record<string, string>> = {
  "raw-plan": "a frozen plan, invented for this fixture",
  "raw-fixture": "a control fixture, invented for this fixture",
  "raw-criterion": "a control's written criterion, invented for this fixture",
  "raw-patch": "a saved patch, invented for this fixture",
  "raw-b1-coverage": rawCapture("first baseline coverage"),
  "raw-b1-network": rawCapture("first baseline network"),
  "raw-b2-coverage": rawCapture("second baseline coverage"),
  "raw-b3-coverage": rawCapture("third baseline coverage"),
  "raw-i1-coverage": rawCapture("first instrumented coverage"),
  "raw-i1-late": rawCapture("a late first instrumented coverage")
};

/** The labels whose objects are a capture's raw bytes, which is what a manifest lists. The others are kept with the case. */
export const CAPTURE_LABELS = ["raw-b1-coverage", "raw-b1-network", "raw-b2-coverage", "raw-b3-coverage", "raw-i1-coverage", "raw-i1-late"] as const;

export function digestOfRaw(label: string): string {
  return createHash("sha256").update(RAW_OBJECTS[label], "utf8").digest("hex");
}

/** Short keys for the machine's own walks. The store's walks use real identities, below. */
export const CONFIG_A = "configuration-alder";
export const CONFIG_B = "configuration-birch";
export const PLAN_DIGEST = digestOfRaw("raw-plan");

export const planOf = (...slots: readonly SlotName[]): PlanInput => ({ slots: slots.map((slot) => ({ slot, attemptId: ATTEMPT_IDS[slot] })), controlRunId: CONTROL_RUN_ID, configuration: CONFIG_A });

export const FULL_PLAN = planOf("B1", "B2", "B3", "I1", "I2", "I3");

export const IDENTITY_ALDER: ConfigurationIdentity = {
  commit: "a1".repeat(20),
  runnerImage: `sha256:${"d1".repeat(32)}`,
  reaRelease: "9.1.0",
  reaIntegrity: "sha512-QWxkZXJpbnRlZ3JpdHk=",
  scannerNode: "24.20.0",
  reaNode: "24.22.2",
  chromium: "153.0.1",
  instruments: ["coverage", "inspect", "logger"],
  grammarVersion: 1,
  fixtureDigest: digestOfRaw("raw-fixture"),
  criterionDigest: digestOfRaw("raw-criterion")
};

/** Differs from alder in one field: the runner image. */
export const IDENTITY_ALDER_REBUILT: ConfigurationIdentity = { ...IDENTITY_ALDER, runnerImage: `sha256:${"d2".repeat(32)}` };

/** A different release and commit, so an aggregate has two reasons to split. */
export const IDENTITY_BIRCH: ConfigurationIdentity = {
  ...IDENTITY_ALDER,
  commit: "b2".repeat(20),
  runnerImage: `sha256:${"d3".repeat(32)}`,
  reaRelease: "9.2.0"
};

/** One step that must be accepted, reported under the caller's property when it is not. */
export function accepted(module: MachineModule, property: string, state: MachineState, event: MachineEvent): MachineState {
  const result = module.step(state, event);
  holds(property, result.ok, () => ({ refused: result, event }));
  return (result as Extract<StepResult, { ok: true }>).state;
}

export function start(module: MachineModule, property: string, plan: PlanInput): MachineState {
  const result = module.plannedState(plan);
  holds(property, result.ok, () => ({ refused: result, plan }));
  return (result as Extract<StepResult, { ok: true }>).state;
}

/** Run events in order, all of which must be accepted. */
export function driven(module: MachineModule, property: string, plan: PlanInput, ...events: readonly MachineEvent[]): MachineState {
  return events.reduce((state, event) => accepted(module, property, state, event), start(module, property, plan));
}

export const frozen: MachineEvent = { type: "plan-frozen", planDigest: PLAN_DIGEST, by: OWNER };
export const controlMet = (configuration: string = CONFIG_A): MachineEvent => ({ type: "control-recorded", configuration, result: "met", by: CONTROL_RUNNER });
export const startOf = (slot: SlotName, by: MachineActor = OWNER): MachineEvent => ({ type: "attempt-started", slot, by });
export const captureOf = (slot: SlotName): readonly MachineEvent[] => [
  { type: "capture-began", slot, by: runnerOf(slot) },
  { type: "capture-finished", slot, by: runnerOf(slot) }
];
export const finishOf = (slot: SlotName, outcome: "usable" | "walled" | "failed" | "incomplete" = "usable"): MachineEvent => ({ type: "attempt-finished", slot, outcome, by: runnerOf(slot) });
export const confirmOf = (slot: SlotName): MachineEvent => ({ type: "cleanup-confirmed", slot, by: OWNER });
export const destroyOf = (slot: SlotName): MachineEvent => ({ type: "environment-destroyed", slot, by: OWNER });

/** A whole visit from start to confirmed cleanup, under whatever gate is open. */
export const visitOf = (slot: SlotName, outcome: "usable" | "walled" | "failed" | "incomplete" = "usable"): readonly MachineEvent[] => [startOf(slot), ...captureOf(slot), finishOf(slot, outcome), confirmOf(slot)];

/**
 * The shape a command takes on its way to the log: the same event, with no field naming anyone.
 * A plan must declare its control run, and every plan in this fixture declares the one above,
 * so a plan spelled here without it gets that one. A test of the decoder builds its own event.
 */
export const logEvent = (type: string, data: LogEvent["data"] = {}): LogEvent => ({
  type,
  data: type === "case-planned" && !("controlRunId" in data) ? { ...data, controlRunId: CONTROL_RUN_ID } : data
});

// These call the module's own key function, so an oracle reading them restates nothing about
// its spelling: they are names for two keys, compared with what the machine holds.
export const CONFIG_ALDER_KEY = configurationKey(IDENTITY_ALDER);
export const CONFIG_BIRCH_KEY = configurationKey(IDENTITY_BIRCH);

/**
 * One whole synthetic case, command by command, for the store's suites and the acceptance
 * suite. The page, its scripts and every statement are invented.
 *
 * How it goes: B1 runs under alder on a control that failed once and then passed. The
 * configuration changes. B2 runs under birch on an exception, while its control has failed. A
 * later pass opens the gate, and B3 runs on that, with partial coverage and a cleanup left
 * unconfirmed for a while. With two usable under birch the rule is met. I1 is incomplete, lost
 * an instrument, and sends a row after it ended. I2 fails with no record. The owner cancels, so
 * I3 never starts.
 */
export type ScriptActor = "owner" | "control" | SlotName;
export type ScriptCommand = Readonly<{ as: ScriptActor; event: LogEvent; mark?: string }>;

const coverageRow = (id: string, slot: SlotName, raw: string, count: number, windowStart: number): LogEvent["data"] => ({
  row: {
    id,
    slot,
    instrument: "coverage",
    state: "present",
    window: { clock: "page", startMs: windowStart, endMs: windowStart + 4000 },
    limits: ["main-frame-only"],
    digest: digestOfRaw(raw),
    observation: { subject: "subject-lantern", count, granularity: "block", windowEnd: "window_closed", scope: "in_scope" }
  }
});

export const FIXED_COMMIT = "c0".repeat(20);
export const RECONSTRUCTED_COMMIT = "ca".repeat(20);
export const RECONSTRUCTED_IDENTITY = "9a".repeat(32);
export const RECORDED_IDENTITY = "9b".repeat(32);

const planSlots = (Object.keys(ATTEMPT_IDS) as SlotName[]).map((slot) => ({ slot, attemptId: ATTEMPT_IDS[slot] }));

const visitOpen = (slot: SlotName): readonly ScriptCommand[] => [
  { as: "owner", event: logEvent("attempt-started", { slot }) },
  { as: slot, event: logEvent("capture-began", { slot }) }
];

const finished = (slot: SlotName, outcome: "usable" | "failed" | "incomplete", reason: string | null): readonly ScriptCommand[] => [
  { as: slot, event: logEvent("capture-finished", { slot }) },
  { as: slot, event: logEvent("attempt-finished", { slot, outcome, reason }) }
];

export const CASE_SCRIPT: readonly ScriptCommand[] = [
  { as: "owner", event: logEvent("case-planned", { slots: planSlots, controlRunId: CONTROL_RUN_ID, configuration: IDENTITY_ALDER as never }), mark: "planned" },
  { as: "owner", event: logEvent("plan-frozen", { planDigest: PLAN_DIGEST }), mark: "frozen" },
  { as: "control", event: logEvent("control-recorded", { configuration: IDENTITY_ALDER as never, result: "not_met" }), mark: "control-failed" },
  { as: "control", event: logEvent("control-recorded", { configuration: IDENTITY_ALDER as never, result: "met" }), mark: "control-passed" },

  ...visitOpen("B1"),
  { as: "B1", event: logEvent("evidence-recorded", coverageRow("row-b1-coverage", "B1", "raw-b1-coverage", 12, 1000)) },
  {
    as: "B1",
    event: logEvent("evidence-recorded", {
      row: { id: "row-b1-network", slot: "B1", instrument: "network", state: "present", window: { clock: "harness", startMs: 50, endMs: 900 }, limits: [], digest: digestOfRaw("raw-b1-network"), observation: null }
    })
  },
  { as: "B1", event: logEvent("instrument-recorded", { slot: "B1", instrument: "coverage", completeness: "complete", reason: null }) },
  ...finished("B1", "usable", null),
  { as: "owner", event: logEvent("cleanup-confirmed", { slot: "B1" }), mark: "b1-done" },

  { as: "owner", event: logEvent("configuration-changed", { configuration: IDENTITY_BIRCH as never }), mark: "changed" },
  { as: "control", event: logEvent("control-recorded", { configuration: IDENTITY_BIRCH as never, result: "not_met" }) },
  { as: "owner", event: logEvent("exception-recorded", { slot: "B2", reason: "Going ahead on one exploratory visit while the control is looked at." }), mark: "excepted" },
  ...visitOpen("B2"),
  { as: "B2", event: logEvent("evidence-recorded", coverageRow("row-b2-coverage", "B2", "raw-b2-coverage", 0, 1100)) },
  { as: "B2", event: logEvent("instrument-recorded", { slot: "B2", instrument: "coverage", completeness: "complete", reason: null }) },
  ...finished("B2", "usable", null),
  { as: "owner", event: logEvent("environment-destroyed", { slot: "B2" }), mark: "b2-done" },
  { as: "control", event: logEvent("control-recorded", { configuration: IDENTITY_BIRCH as never, result: "met" }), mark: "later-pass" },

  ...visitOpen("B3"),
  { as: "B3", event: logEvent("evidence-recorded", coverageRow("row-b3-coverage", "B3", "raw-b3-coverage", 3, 1150)) },
  { as: "B3", event: logEvent("instrument-recorded", { slot: "B3", instrument: "coverage", completeness: "partial", reason: "budget-reached" }) },
  { as: "B3", event: logEvent("source-recorded", { slot: "B3", commit: FIXED_COMMIT, identity: RECORDED_IDENTITY }) },
  ...finished("B3", "usable", null),
  { as: "owner", event: logEvent("cleanup-unconfirmed", { slot: "B3" }), mark: "b3-unconfirmed" },
  { as: "owner", event: logEvent("environment-destroyed", { slot: "B3" }), mark: "baseline-ended" },
  { as: "owner", event: logEvent("baseline-rule-recorded", { result: "met" }), mark: "rule-met" },

  ...visitOpen("I1"),
  { as: "I1", event: logEvent("evidence-recorded", coverageRow("row-i1-coverage", "I1", "raw-i1-coverage", 5, 1200)) },
  { as: "I1", event: logEvent("instrument-recorded", { slot: "I1", instrument: "coverage", completeness: "partial", reason: "budget-reached" }) },
  { as: "I1", event: logEvent("instrument-recorded", { slot: "I1", instrument: "inspect", completeness: "missing", reason: "output-lost" }) },
  ...finished("I1", "incomplete", "instrument-output-lost"),
  { as: "I1", event: logEvent("evidence-recorded", coverageRow("row-i1-late", "I1", "raw-i1-late", 2, 1300)), mark: "i1-ended" },
  { as: "owner", event: logEvent("environment-destroyed", { slot: "I1" }) },

  ...visitOpen("I2"),
  {
    as: "I2",
    event: logEvent("evidence-recorded", {
      row: { id: "row-i2-nothing", slot: "I2", instrument: "coverage", state: "no_record", window: { clock: null, note: "instrument-never-armed" }, limits: [], digest: null, observation: { subject: "subject-lantern", count: null, granularity: "block", windowEnd: "target_crashed", scope: "in_scope" } }
    })
  },
  { as: "I2", event: logEvent("attempt-finished", { slot: "I2", outcome: "failed", reason: "target-crashed" }) },
  { as: "owner", event: logEvent("cleanup-confirmed", { slot: "I2" }), mark: "i2-ended" },

  { as: "owner", event: logEvent("source-reconstructed", { appliesTo: ["B2", "I1", "I2"], baseCommit: RECONSTRUCTED_COMMIT, patchDigest: digestOfRaw("raw-patch"), identity: RECONSTRUCTED_IDENTITY }) },
  { as: "owner", event: logEvent("fact-recorded", { id: "fact-lantern-ran", statement: "The lantern routine ran in these windows.", evidence: ["row-b1-coverage", "row-b3-coverage"] }) },
  { as: "owner", event: logEvent("fact-recorded", { id: "fact-lantern-host", statement: "The lantern script was served from its first-party host.", evidence: ["row-b1-network"] }) },
  { as: "owner", event: logEvent("assertion-recorded", { id: "said-thimble-clear", statement: "The logger ruled out the thimble bundle." }) },
  { as: "owner", event: logEvent("interpretation-recorded", { id: "reading-ran", statement: "The routine runs on each visit.", cites: [{ fact: "fact-lantern-ran", version: 1 }] }) },
  { as: "owner", event: logEvent("interpretation-recorded", { id: "reading-both", statement: "The first party runs the routine.", cites: [{ fact: "fact-lantern-ran", version: 1 }, { fact: "fact-lantern-host", version: 1 }] }) },
  { as: "owner", event: logEvent("interpretation-recorded", { id: "reading-host", statement: "The host is the first party's own.", cites: [{ fact: "fact-lantern-host", version: 1 }] }) },
  { as: "owner", event: logEvent("unknown-recorded", { unknown: { id: "unknown-author", question: "Who wrote the routine?", reason: "No capture establishes authorship.", detail: null, wouldResolve: null } }), mark: "claims-made" },
  { as: "owner", event: logEvent("case-cancelled"), mark: "closed" }
];

/** The commands a correction adds after the case above. */
export const SUPERSEDE_COMMAND: ScriptCommand = { as: "owner", event: logEvent("fact-superseded", { fact: "fact-lantern-host", statement: "The lantern script's URL names the first-party host.", reason: "A URL's host does not show whose server answered." }), mark: "superseded" };
export const RETRACT_ASSERTION_COMMAND: ScriptCommand = {
  as: "owner",
  event: logEvent("assertion-retracted", { assertion: "said-thimble-clear", reason: "The logger wraps listed calls only, so it rules nothing out.", unknown: { id: "unknown-thimble", question: "Did the thimble bundle make the calls?", reason: "The logger reads only what it wraps.", detail: null, wouldResolve: "A coverage window over that bundle." } }),
  mark: "assertion-retracted"
};

export type RunWorld = Readonly<{ owner: Actor; actorOf: (as: ScriptActor) => Actor; stores: LogStores; caseId: string; now: () => number }>;

export function actorsFor(owner: Actor): (as: ScriptActor) => Actor {
  return (as) => {
    if (as === "owner") return owner;
    return runnerActorFrom(as === "control" ? CONTROL_RUN_ID : ATTEMPT_IDS[as]) as Actor;
  };
}

/** Every raw object into the store, ahead of the commands that name them, as a capture would be. */
export async function storeRawObjects(stores: LogStores): Promise<void> {
  for (const text of Object.values(RAW_OBJECTS)) {
    const put = await putEvidence(stores, new TextEncoder().encode(text));
    if (!put.ok) throw new Error(`The fixture's object was refused: ${put.refusal}`);
  }
}

/** Times that only rise, starting inside the fixture token's life. */
export function risingClock(startMs: number): () => number {
  let at = startMs;
  return () => {
    at += 1000;
    return at;
  };
}

type StoreModule = Pick<typeof import("../core/case-store"), "openCase" | "runCommand">;
type Marks = ReadonlyMap<string, OpenCase> & { last: OpenCase };

/** Start the log, store the raw objects, and run a stretch of the script. Throws on a refusal: the suites compare the results by hand. */
export async function runScript(world: Omit<RunWorld, "owner"> & Readonly<{ commands: readonly ScriptCommand[]; store?: StoreModule }>): Promise<Marks> {
  const created = await createLog(world.stores);
  if (!created.ok) throw new Error("The fixture's log exists already");
  await storeRawObjects(world.stores);
  return continueScript(world);
}

/**
 * The same, on a log that is already there. A case is registered by the module that folded it,
 * so a variant of the store runs its own script with `store`, or its own runCommand refuses
 * what this one folded.
 */
export async function continueScript(world: Omit<RunWorld, "owner"> & Readonly<{ commands: readonly ScriptCommand[]; store?: StoreModule }>): Promise<Marks> {
  const store: StoreModule = world.store ?? { openCase, runCommand };
  const opened = await store.openCase(world.stores, world.caseId);
  if (!opened.ok) throw new Error(`The fixture's log would not open: ${opened.refusal}`);
  let current = opened.case;
  const marks = new Map<string, OpenCase>() as Map<string, OpenCase> & { last: OpenCase };
  for (const { as, event, mark } of world.commands) {
    const result = await store.runCommand(world.stores, current, { actor: world.actorOf(as), event, now: world.now });
    if (!result.ok) throw new Error(`The fixture's ${event.type} was refused: ${result.refusal} at ${String(result.at)}`);
    current = result.case;
    if (mark !== undefined) marks.set(mark, current);
  }
  marks.last = current;
  return marks;
}
