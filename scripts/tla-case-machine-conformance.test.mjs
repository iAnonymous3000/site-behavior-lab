// Trace conformance between the TLA+ specification of the case machine
// (specs/case-machine/CaseMachine.tla) and the real machine (investigation/core/case-machine.ts).
//
// It holds the code to the specification, and neither to anything else. TLC model-checks the
// specification's properties over the plans its configurations name; this suite then holds the
// real step to the specification's transitions on those plans. It runs without Java: what TLC
// computed is in specs/case-machine/conformance.json, which scripts/tla-case-machine-export.mjs
// regenerates with TLC and compares byte for byte with --check.
//
// What each test covers, and over what:
// - The reachable relation. For each of the five plans, the real machine is walked breadth first
//   from the planned state over the alphabet the exploration suite's own walk enumerates
//   (machineAlphabet), which must be the specification's alphabet. Each state's line holds its
//   code, the views (denominatorOf, isTerminal, continuationOf) and every accepted event with
//   the state it leaves. The count of states, the count of transitions and an order-free digest
//   of the lines must equal what TLC printed for the specification. Equal relations from the
//   same first state include each in the other. The digest is a sum of SHA-256 values, so this
//   is a comparison by digest, not line by line; the export script makes the line by line
//   comparison whenever it runs.
// - TLC's traces. One transition of every class the specification's relation holds, on traces
//   from the planned state kept as a tree, replayed through the real step: at every node the
//   state, the views and the set of accepted events are compared with the specification's.
// - Authority. Every body from every actor the specification's table refuses, sent to the real
//   step on every reachable state of the two smallest plans and on every node of the six-slot
//   tree. The record events of evidence-model.ts are not in the specification and not here.
// - Purge. The real purgeStep and retentionTier against the specification's reducer on every
//   pairing of the slice; and through the real step on every reachable state of the two smallest
//   plans, with no manifest and, where the case is closed, every manifest the slice reaches.
// - Variants. Each named fault, seeded in the real machine's compiled text, must fail the
//   relation check on the plan B1 and I1.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { bindReal, CAPS, PLANS, sameEventSet, sha256Hex, transitionClass, walkReal } from "./tla-case-machine-lib.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SPEC_DIR = join(ROOT, "specs", "case-machine");
const DIST = join(ROOT, ".investigation-test-dist");
if (!existsSync(join(DIST, "investigation", "core", "case-machine.js"))) throw new Error("Compile the workspace first: npx tsc -p tsconfig.investigation-test.json");

const require = createRequire(join(ROOT, "package.json"));
const machine = require(join(DIST, "investigation", "core", "case-machine.js"));
const purge = require(join(DIST, "investigation", "core", "purge.js"));
const fixture = require(join(DIST, "investigation", "test", "case-fixture.js"));
const walk = require(join(DIST, "investigation", "test", "case-exploration-walk.js"));
const { loadVariant } = require(join(DIST, "lib", "finite-check.js"));

const conformanceText = readFileSync(join(SPEC_DIR, "conformance.json"), "utf8");
const conformance = JSON.parse(conformanceText);
const pins = JSON.parse(readFileSync(join(ROOT, "specs", "tla-tools.json"), "utf8"));

/** The walk's paths, under the specification's names for them. */
const PATHS = { p1: walk.PURGE_PATHS[0], p2: walk.PURGE_PATHS[1], p3: walk.PURGE_PATHS[2], p0: walk.UNLISTED };

const bound = (planName, variant = machine) => ({ real: bindReal(fixture, variant, PLANS[planName]), plan: conformance.plans[planName] });

/** The real walk of a plan against what TLC printed for it. It returns what differs, or null. */
function relationDifference(planName, variant = machine, visit) {
  const { real, plan } = bound(planName, variant);
  const events = plan.alphabet.map(real.eventOf);
  let walked;
  try {
    // One state past the specification's count is already a difference.
    walked = walkReal(variant, plan.states + 1, real, events, visit === undefined ? undefined : (code, views, accepted, state) => visit(real, plan, code, views, accepted, state));
  } catch (error) {
    return `the real walk stopped: ${error instanceof Error ? error.message : String(error)}`;
  }
  const ours = { first: walked.first, states: walked.states, edges: walked.edges, digest: walked.digest };
  const theirs = { first: plan.first, states: plan.states, edges: plan.edges, digest: plan.digest };
  return JSON.stringify(ours) === JSON.stringify(theirs) ? null : `the real machine gives ${JSON.stringify(ours)}, the specification ${JSON.stringify(theirs)}`;
}

const maskOf = (indices, size) => {
  let mask = 0n;
  for (const index of indices) mask |= 1n << BigInt(index - 1);
  return mask.toString(16).padStart(Math.ceil(size / 4), "0");
};

/** TLC's tree replayed through the real step. It hands each node's real state to `visit`, and returns the classes its transitions hold. */
function replayTree(planName, variant = machine, visit) {
  const { real, plan } = bound(planName, variant);
  const events = plan.alphabet.map(real.eventOf);
  const states = [];
  const classes = new Set();
  plan.tree.forEach(([parent, index, code, views, mask], node) => {
    let state;
    if (node === 0) {
      assert.deepEqual([parent, index], [-1, 0], "the tree's root is the planned state");
      const first = variant.plannedState(real.plan);
      assert.equal(first.ok, true, "the real machine takes the plan");
      state = first.state;
    } else {
      assert.ok(parent >= 0 && parent < node, `node ${node} follows its parent`);
      const answer = variant.step(states[parent], events[index - 1]);
      assert.equal(answer.ok, true, `node ${node}: the real machine refused ${JSON.stringify(plan.alphabet[index - 1])}, which the specification accepts from ${plan.tree[parent][2]}`);
      state = answer.state;
      classes.add(transitionClass(plan.slots, plan.alphabet[index - 1], plan.tree[parent][2], code));
    }
    assert.equal(real.encode(state), code, `node ${node}: the state`);
    assert.equal(real.views(state), views, `node ${node}: the views`);
    const accepted = [];
    events.forEach((event, at) => {
      if (variant.step(state, event).ok) accepted.push(at + 1);
    });
    assert.equal(maskOf(accepted, events.length), mask, `node ${node}: the events accepted from ${code}`);
    states.push(state);
    if (visit !== undefined) visit(real, plan, state);
  });
  return classes;
}

const actorNamed = (name) => (name === "owner" ? { kind: "owner", of: "none" } : { kind: "runner", of: name });

/** The probes of a plan as real events: each body from each actor the specification's table refuses. */
function probesOf(real, plan) {
  const probes = [];
  for (const { body, refusedFrom } of plan.probes) {
    for (const name of refusedFrom) {
      const by = real.actorOf(actorNamed(name));
      if (body.type === "purge-manifest-recorded") probes.push({ type: body.type, paths: body.paths.map((path) => PATHS[path]), by });
      else if (body.type === "purge-path-absent" || body.type === "purge-path-remains") probes.push({ type: body.type, path: PATHS[body.path], by });
      else if (body.type === "evidence-recorded") probes.push({ type: body.type, slot: body.slot, id: "row-probe", by });
      else probes.push(real.eventOf({ ...body, by: actorNamed(name) }));
    }
  }
  return probes;
}

function refuseEvery(probes, variant, state) {
  for (const probe of probes) {
    if (variant.step(state, probe).ok) assert.fail(`the real machine took ${JSON.stringify(probe)}, which the specification's authority table refuses`);
  }
}

// The purge table's short rows, read back. The export script's exportPurge states the format.
const statusOf = { p: "present", a: "absent", r: "remains" };
const manifestOf = (text) => (text === "-" ? null : text === "" ? [] : text.split(",").map((entry) => ({ path: PATHS[`p${entry[0]}`], state: statusOf[entry[1]] })));
const purgeEventOf = (text) => {
  const [letter, named] = text.split(":");
  if (letter === "M") return { type: "purge-manifest-recorded", paths: named === "" ? [] : named.split(",").map((digit) => PATHS[`p${digit}`]) };
  return { type: letter === "A" ? "purge-path-absent" : "purge-path-remains", path: PATHS[`p${named}`] };
};
const purgeRows = conformance.purge.map((row) => {
  const [closed, manifest, event, answer, tier] = row.split("|");
  return { row, closed: closed === "1", manifestText: manifest, manifest: manifestOf(manifest), eventText: event, event: purgeEventOf(event), ok: answer.startsWith("="), left: answer.startsWith("=") ? manifestOf(answer.slice(1)) : null, refusal: answer.startsWith("!") ? answer.slice(1) : null, tier: tier === "S" ? "SUMMARY_ONLY" : "RAW_HELD" };
});

test("the committed export belongs to the committed specification and the pinned tools", () => {
  assert.equal(conformance.format, 1);
  for (const [file, digest] of Object.entries(conformance.specification)) assert.equal(sha256Hex(readFileSync(join(SPEC_DIR, file))), digest, `${file} changed since TLC last exported it: run scripts/tla-case-machine-export.mjs`);
  assert.deepEqual(Object.keys(conformance.specification).sort(), ["CaseMachine.tla", "CaseMachineExport.tla", "CaseMachineMC.tla", "PurgeSlice.tla"]);
  assert.equal(conformance.tla2tools, pins.tla2tools.sha256, "the export was made with the pinned jar");
  assert.equal(sha256Hex(conformanceText), pins.artifacts["specs/case-machine/conformance.json"], "the export's digest is the pinned one");
  assert.deepEqual(Object.keys(conformance.plans).sort(), Object.keys(PLANS).sort(), "every plan is exported");
  for (const [name, plan] of Object.entries(conformance.plans)) {
    assert.deepEqual(plan.slots, PLANS[name]);
    assert.equal(plan.comparedWithReal, plan.states, `${name}: the export compared every state with the real machine`);
    assert.deepEqual(plan.tlc, { generated: plan.edges + 1, distinct: plan.states, depth: plan.tlc.depth }, `${name}: TLC's own counts are the printed relation's`);
  }
});

// The invariants of specs/case-machine/README.md's table, in the order the configurations list them.
const INVARIANTS = ["Domain", "CapsState", "CapsStep", "GateState", "GateStep", "ClosedExactly", "ClosedStays", "RuleFixed", "CleanupState", "CleanupStep", "RanUnder", "DenominatorAdds", "TerminalIsQuiet", "ContinuationReads", "OneRuns", "ArmState", "ArmStep", "Waits", "TerminalStays", "Blocks", "Acquisition", "PurgeSlice", "Authority", "Interchangeable", "ControlGate", "ExceptionFirst", "Mark", "Acyclic", "Sinks", "Supervisor"];

test("the export was made under each plan's committed configuration, in a run where TLC held every invariant of the table on every state", () => {
  // The export script writes a plan only from a TLC run that finished clean under that plan's configuration with these
  // invariants listed, so what this holds is that the committed configurations are the ones those runs were made under.
  for (const [name, plan] of Object.entries(conformance.plans)) {
    const committed = readFileSync(join(SPEC_DIR, `${name}.cfg`), "utf8");
    assert.deepEqual(plan.checked, { configuration: `${name}.cfg`, sha256: sha256Hex(committed), invariants: INVARIANTS }, name);
    for (const invariant of INVARIANTS) assert.match(committed, new RegExp(`\\n  ${invariant}\\n`), `${name}.cfg lists ${invariant}`);
    assert.match(committed, name === "six-slots" ? /HeldManifests = "two"/ : /HeldManifests = "all"/);
  }
  const slice = readFileSync(join(SPEC_DIR, "purge-slice.cfg"), "utf8");
  assert.deepEqual({ ...conformance.purgeSlice, tlc: null }, { configuration: "purge-slice.cfg", sha256: sha256Hex(slice), invariants: ["SliceDomain", "SliceAnswers", "SummaryOnlyExactly"], tlc: null });
  // Open with no manifest, closed with none, and closed with each of the 64 the slice reaches; two first states.
  assert.deepEqual([conformance.purgeSlice.tlc.distinct, conformance.purgeSlice.tlc.generated - 2], [2 + walk.everyManifest().length, 200]);
});

test("the caps the specification's configurations set are production's", () => {
  assert.deepEqual(conformance.caps, CAPS);
  assert.deepEqual(CAPS, { MaxControlMisses: machine.MAX_CONTROL_MISSES, MaxStartRetries: machine.MAX_START_RETRIES, MaxConfigurationChanges: machine.MAX_CONFIGURATION_CHANGES });
});

for (const planName of Object.keys(PLANS)) {
  test(`the real machine's reachable transitions are the specification's, on the plan ${planName}`, () => {
    const { real, plan } = bound(planName);
    assert.ok(sameEventSet(plan.alphabet.map(real.eventOf), walk.machineAlphabet(real.plan)), "the specification's alphabet is the one the exploration suite's walk enumerates");
    const classes = new Set();
    const difference = relationDifference(planName, machine, (_real, _plan, code, _views, accepted) => {
      if (plan.classes !== undefined) for (const [index, next] of accepted) classes.add(transitionClass(plan.slots, plan.alphabet[index - 1], code, next));
    });
    assert.equal(difference, null);
    if (plan.classes !== undefined) assert.deepEqual([...classes].sort(), plan.classes, "the real relation holds the classes the specification's holds");
  });
}

for (const planName of Object.keys(PLANS).filter((name) => conformance.plans[name]?.tree !== undefined)) {
  test(`TLC's traces replay through the real step, state by state, on the plan ${planName}`, () => {
    const plan = conformance.plans[planName];
    const classes = replayTree(planName);
    assert.deepEqual([...classes].sort(), plan.classes, "the traces hold one transition of every class of the specification's relation");
    assert.ok(plan.tree.length > plan.classes.length / 2 && plan.traces > 0);
  });
}

test("the plans whose traces are kept are the six-slot plan and the two smallest", () => {
  assert.deepEqual(
    Object.keys(PLANS).filter((name) => conformance.plans[name].tree !== undefined),
    ["six-slots", "one-each", "two-each"]
  );
});

test("an event from an actor the specification's table refuses is refused by the real machine", () => {
  for (const planName of ["one-each", "two-each"]) {
    let probes = null;
    let states = 0;
    assert.equal(
      relationDifference(planName, machine, (real, plan, _code, _views, _accepted, state) => {
        probes ??= probesOf(real, plan);
        refuseEvery(probes, machine, state);
        states += 1;
      }),
      null
    );
    assert.equal(states, conformance.plans[planName].states);
    assert.ok(probes.length > 100);
  }
  let probes = null;
  replayTree("six-slots", machine, (real, plan, state) => {
    probes ??= probesOf(real, plan);
    refuseEvery(probes, machine, state);
  });
  // 92 bodies of the alphabet, a row for each slot and three purge bodies, each from seven or eight of the nine actors.
  assert.equal(conformance.plans["six-slots"].probes.length, 92 + 6 + 3);
  assert.ok(probes.length >= 7 * 101 && probes.length <= 8 * 101);
});

test("the real purgeStep and retentionTier answer as the specification's reducer, on every pairing of the slice", () => {
  // Open and closed, no manifest and each of the 64 the slice reaches, each of the slice's 17 events.
  assert.equal(purgeRows.length, 2 * 65 * 17);
  assert.equal(new Set(conformance.purge).size, purgeRows.length);
  assert.ok(sameEventSet([...new Set(purgeRows.map(({ eventText }) => eventText))].map(purgeEventOf), walk.purgeSliceAlphabet()), "the specification's slice events are the walk's");
  assert.equal(new Set(purgeRows.map(({ manifestText }) => manifestText)).size, 1 + walk.everyManifest().length);
  for (const { row, closed, manifest, event, ok, left, refusal, tier } of purgeRows) {
    const answer = purge.purgeStep(closed, manifest, event);
    assert.deepEqual(answer, ok ? { ok: true, manifest: left } : { ok: false, refusal }, row);
    assert.equal(purge.retentionTier(manifest), tier, row);
  }
});

test("through the real step a purge answers as the specification's reducer and moves nothing else, and no other event reads the manifest, on the two smallest plans", () => {
  const rowsFor = new Map();
  for (const entry of purgeRows) {
    const key = `${entry.closed}|${entry.manifestText}`;
    if (!rowsFor.has(key)) rowsFor.set(key, []);
    rowsFor.get(key).push(entry);
  }
  for (const planName of ["one-each", "two-each"]) {
    let events = null;
    let closedStates = 0;
    assert.equal(
      relationDifference(planName, machine, (real, plan, code, _views, _accepted, state) => {
        events ??= plan.alphabet.map(real.eventOf);
        const closed = state.closedBy !== null;
        if (closed) closedStates += 1;
        for (const [key, rows] of rowsFor) {
          if (!key.startsWith(`${closed}|`) || (!closed && rows[0].manifest !== null)) continue;
          const holding = { ...state, purge: rows[0].manifest };
          for (const { row, event, ok, left, refusal } of rows) {
            const answer = machine.step(holding, { ...event, by: fixture.OWNER });
            if (ok) {
              assert.equal(answer.ok, true, row);
              assert.deepEqual(answer.state.purge, left, row);
              assert.equal(real.encode({ ...answer.state, purge: null }), code, `${row}: a purge moved something besides the manifest`);
            } else assert.deepEqual(answer, { ok: false, refusal }, row);
          }
          if (rows[0].manifest === null) continue;
          for (const event of events) {
            const plain = machine.step(state, event);
            const held = machine.step(holding, event);
            assert.equal(held.ok, plain.ok, `${code} holding ${key}: ${JSON.stringify(event)}`);
            if (plain.ok) {
              assert.deepEqual(held.state.purge, rows[0].manifest);
              assert.equal(real.encode({ ...held.state, purge: null }), real.encode(plain.state));
            } else assert.equal(held.refusal, plain.refusal);
          }
        }
      }),
      null
    );
    assert.ok(closedStates > 0 && closedStates < conformance.plans[planName].states);
  }
});

// The faults, as edits of the compiled case-machine.js. Each is one the exploration suite's own
// variants seed (case-exploration.test.ts, MACHINE_VARIANTS), so each is a fault that suite also
// catches, by the property named beside it there.
const VARIANTS = [
  ["a change to the configuration in force", [{ find: 'if (event.configuration === state.configuration)\n        return refuse("configuration-unchanged");', replace: "" }]],
  ["usable reported from starting", [{ find: 'starting: ["failed"],', replace: 'starting: ["failed", "usable"],' }]],
  ["unconfirmed cleanup made final", [{ find: 'if (attempt.cleanup === "confirmed" || attempt.cleanup === "environment_destroyed")', replace: 'if (attempt.cleanup === "confirmed" || attempt.cleanup === "environment_destroyed" || attempt.cleanup === "unconfirmed")' }]],
  ["a deadline read as a failure", [{ find: 'return finish(state, index, "timed_out");', replace: 'return finish(state, index, "failed");' }]],
  ["a cancel recorded as a deadline", [{ find: 'closeWith(state, "cancelled", "cancelled")', replace: 'closeWith(state, "cancelled", "deadline")' }]],
  ["a control cap gone", [{ find: 'if (state.controlMisses >= exports.MAX_CONTROL_MISSES)\n        return refuse("control-limit");', replace: "" }]],
  ["a finish keeping the retries", [{ find: "return accept(closeIfDone(withAttempt(state, index, { phase, startRetries: 0 })));", replace: "return accept(closeIfDone(withAttempt(state, index, { phase })));" }]],
  ["a close keeping the gate", [{ find: "return Object.assign(Object.assign(Object.assign({}, state), GATE_AT_CLOSE), { closedBy, attempts:", replace: "return Object.assign(Object.assign({}, state), { closedBy, attempts:" }]],
  ["no close when the last attempt ends", [{ find: "return accept(closeIfDone(withAttempt(state, index, { phase, startRetries: 0 })));", replace: "return accept(withAttempt(state, index, { phase, startRetries: 0 }));" }]],
  ["reconcile confirming pending cleanup", [{ find: '(attempt.cleanup === "pending" ? Object.assign(Object.assign({}, attempt), { cleanup: "unconfirmed" }) : attempt)', replace: '(attempt.cleanup === "pending" ? Object.assign(Object.assign({}, attempt), { cleanup: "confirmed" }) : attempt)' }]],
  ["the instrumented arm not waiting", [{ find: 'if (attempt.arm === "instrumented" && state.baselineRule === "pending")\n        return refuse("baseline-rule-pending");', replace: "" }]],
  ["a control from another configuration", [{ find: 'const controlMet = event.configuration === state.configuration && event.result === "met";', replace: 'const controlMet = event.result === "met";' }]],
  ["a slot closed unstarted with no configuration", [{ find: '{ phase: "not_started", configuration: state.configuration }', replace: '{ phase: "not_started" }' }]],
  ["terminal reading only the first attempt", [{ find: '!state.attempts.some((attempt) => attempt.cleanup === "pending")', replace: '!(state.attempts[0].cleanup === "pending")' }]]
];

for (const [name, edits] of VARIANTS) {
  test(`the relation check catches a variant of the real machine: ${name}`, (t) => {
    const variant = loadVariant(join(DIST, "investigation", "core", "case-machine.js"), edits);
    const difference = relationDifference("one-each", variant);
    assert.notEqual(difference, null, "the variant's relation is not the specification's");
    let traces = "the traces replay clean";
    try {
      replayTree("one-each", variant);
    } catch (error) {
      traces = `the traces fail too: ${String(error instanceof Error ? error.message : error).split("\n")[0]}`;
    }
    t.diagnostic(`${difference.slice(0, 160)}; ${traces}`);
  });
}

test("the relation check passes the real machine on the plan the variants run on", () => {
  assert.equal(relationDifference("one-each"), null);
});
