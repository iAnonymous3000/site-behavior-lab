// Trace conformance between the TLA+ specification of the shared-worker hold
// (specs/worker-hold/WorkerHold.tla), the hand-written model (lib/fv-worker-model.ts) and the
// real attacher thread, mirror and readout.
//
// It runs without Java: what TLC computed is in specs/worker-hold/conformance.json, which
// scripts/tla-worker-hold-export.mjs regenerates with TLC and compares byte for byte with
// --check. TLC model-checks the specification's rows over each world under the sets of switches
// that file names. This suite then holds three things:
// - The model and the specification take the same steps. For each world the hand-written model's
//   whole graph, with nothing assumed, is folded into a digest over its labels (each move's steps
//   with what the thread posted and sent, then the switches that forbid the move) and over what
//   each worker landed as with the world's facts about it. That digest must be the one TLC's
//   printed graph gave. Equal digests mean the two are bisimilar over those labels, so every
//   trace of the model is a trace of the specification, and the other way, under every set of
//   switches. It is a comparison by digest of SHA-256 values, not edge by edge; the export
//   script walks to the first difference whenever the two part.
// - The table. Each row's smallest sets of the plan's axioms, per world, as TLC found them, must
//   be the ones the register states; and for every one of the 512 sets of switches, the rows the
//   hand-written model's own verdicts break must be the rows TLC found broken.
// - No row is listed where it has nothing to judge. A row of the form "a worker that lands so
//   had this fact" passes wherever no worker lands so, and wherever no worker has the fact that
//   would break it. Each row has reachability companions (WorkerHold.tla), and wherever a row is
//   listed as holding (a cell of the export script's table, a committed configuration, a cell of
//   the register's table below) every companion of it must be reached under the same switches:
//   by TLC's own run, which the export records, and in the hand-written model's own graph, which
//   this suite walks. The worlds and rows where that fails are named, and held to be exactly those.
// - The real code follows TLC's traces. Each kept trace, a path of moves TLC printed, is replayed
//   through the real thread, its in-process transport, the real mirror and the real readout by
//   the suite's own harness (lib/fv-worker-model-replay.ts): at each step the thread must post
//   and send what the label says, the port must carry it, and the mirror must hold what the
//   specification's state holds; at the end the readout must land each worker where the
//   specification does. The traces take every label of each world under the plan's axioms with
//   C1 and D1, break each row the register says fails, and reach each form of the named trace.
//
// What it does not hold: anything about a browser. Each switch is an assumption, and the replay
// drives the real code over a stand-in socket with patched timers. The direction row (where @12
// lands a worker apart from @11) and the dedicated world are not in the specification.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CELLS } from "./tla-worker-hold-export.mjs";
import { COMPANION_REACHED_BY, COMPANIONS, companionsOf, digests, failsUnder, modelGraph, NOT_JUDGED, PLAN_AXIOMS, ROWS as INVARIANT_OF, sha256Hex, smallestSets, summary, SWITCHES, WORLDS } from "./tla-worker-hold-lib.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SPEC_DIR = join(ROOT, "specs", "worker-hold");
const DIST = join(ROOT, ".unit-test-dist", "lib");
if (!existsSync(join(DIST, "fv-worker-model.js"))) throw new Error("Compile the library first: npx tsc -p tsconfig.test.json");

const require = createRequire(join(ROOT, "package.json"));
const fv = require(join(DIST, "fv-worker-model.js"));
const replay = require(join(DIST, "fv-worker-model-replay.js"));
const attacher = require(join(DIST, "shared-worker-attacher.js"));
const realm = require(join(DIST, "worker-fingerprint-realm.js"));
const { Counterexample, loadVariant } = require(join(DIST, "finite-check.js"));

const conformanceText = readFileSync(join(SPEC_DIR, "conformance.json"), "utf8");
const conformance = JSON.parse(conformanceText);
const pins = JSON.parse(readFileSync(join(ROOT, "specs", "tla-tools.json"), "utf8"));
const PRODUCTION = { attacher, realm };

const EXCLUDED_1 = "excluded-implies-no-page-code-before-the-freeze";
const EXCLUDED_2 = "excluded-implies-no-unobserved-page-code-before-the-freeze";
const READ = "read-implies-the-observer-preceded-every-statement";
const AGE = "a-read-state-is-no-older-than-the-freeze";
const TERM = "every-worker-the-readout-heard-of-lands-in-one-term";
const NO_TERM = "a-worker-that-ran-before-the-freeze-lands-in-a-term";
const ROWS = [EXCLUDED_1, EXCLUDED_2, READ, AGE, TERM, NO_TERM];
const WITH_C1 = [...PLAN_AXIOMS, "C1"];
const WITH_C1_D1 = [...PLAN_AXIOMS, "C1", "D1"];

// What each committed configuration lists: the type invariant, and the rows that hold under the plan's axioms in that
// world and have something to judge there. The stream world lists no exclusion row, no no-term row and no F4-READ.
// Only the stream world lists F4-AGE: where Stream is FALSE the realm never goes past its first snapshot.
const PLAN_INVARIANTS = {
  hold: ["TypeOK", "ReadHadItsObserver", "HeardLandsInOneTerm"],
  stream: ["TypeOK", "ReadNoOlderThanTheFreeze", "HeardLandsInOneTerm"],
  two: ["TypeOK", "ReadHadItsObserver", "HeardLandsInOneTerm"],
  small: ["TypeOK", "ReadHadItsObserver", "HeardLandsInOneTerm"]
};
const invariantsOf = (configuration) => configuration.slice(configuration.indexOf("\nINVARIANTS\n") + "\nINVARIANTS\n".length).trim().split(/\s+/);

const models = new Map();
/** A world's hand-written model over the real kernels, explored once. */
function built(world) {
  if (!models.has(world)) {
    const model = new fv.SharedWorkerModel(fv[WORLDS[world].model], realm);
    models.set(world, { model, explored: model.explore() });
  }
  return models.get(world);
}

test("the committed export belongs to the committed specification and the pinned tools, and its worlds are the hand-written model's", () => {
  assert.equal(conformance.format, 1);
  assert.deepEqual(Object.keys(conformance.specification).sort(), ["WorkerHold.tla", "WorkerHoldExport.tla", "WorkerHoldTable.tla"]);
  for (const [file, digest] of Object.entries(conformance.specification)) assert.equal(sha256Hex(readFileSync(join(SPEC_DIR, file))), digest, `${file} changed since TLC last exported it: run scripts/tla-worker-hold-export.mjs`);
  assert.equal(conformance.tla2tools, pins.tla2tools.sha256, "the export was made with the pinned jar");
  assert.equal(sha256Hex(conformanceText), pins.artifacts["specs/worker-hold/conformance.json"], "the export's digest is the pinned one");
  assert.deepEqual(Object.keys(conformance.worlds).sort(), Object.keys(WORLDS).sort(), "every world is exported");
  for (const [name, { model, constants }] of Object.entries(WORLDS)) {
    const world = fv[model];
    assert.deepEqual(conformance.worlds[name].constants, constants);
    assert.deepEqual({ WorkerCount: world.workers, CollapseSessions: world.collapseSessions, Stream: world.stream, StartReleased: world.startReleased, Reduced: world.reduced }, constants, `${name}: the specification's constants are the model's world`);
    assert.equal(conformance.worlds[name].tlc.generated > conformance.worlds[name].tlc.distinct, true);
    // The configuration kept for runs by hand is the one the export ran, clean, with these rows as invariants.
    const committed = readFileSync(join(SPEC_DIR, `${name}-plan.cfg`), "utf8");
    assert.deepEqual({ ...conformance.worlds[name].underPlan, tlc: null, invariants: null, reached: null }, { configuration: `${name}-plan.cfg`, sha256: sha256Hex(committed), invariants: null, reached: null, tlc: null });
    assert.deepEqual(conformance.worlds[name].underPlan.invariants, invariantsOf(committed), `${name}-plan.cfg lists the invariants the export ran`);
    assert.deepEqual(conformance.worlds[name].underPlan.invariants, PLAN_INVARIANTS[name]);
  }
  assert.deepEqual(SWITCHES, [...fv.ASSUMPTIONS], "the switches are the model's");
  assert.deepEqual(fv.namesOf(fv.PLAN_AXIOMS), PLAN_AXIOMS, "the plan's axioms are the model's");
});

for (const world of Object.keys(WORLDS)) {
  test(`the hand-written model and the specification take the same steps under every set of switches, and land every worker the same way, in the ${world} world`, () => {
    const { model, explored } = built(world);
    const graph = modelGraph(fv, model, explored);
    const { digest, classes } = summary(graph, digests(graph));
    assert.deepEqual({ digest, classes }, { digest: conformance.worlds[world].digest, classes: conformance.worlds[world].classes });
    assert.deepEqual(conformance.worlds[world].model, { states: explored.keys.length, moves: explored.edgeTo.length }, "the model is the size the export saw");
  });
}

const tables = new Map();
/**
 * From one walk of the hand-written model over every pair of a state and the switches a path to it broke: the
 * smallest sets of switches that break each row on some path (the model's own verdicts), and for each reachability
 * companion the sets of switches broken on the paths that reach it (the landings are the model's own).
 */
function modelTable(world) {
  if (tables.has(world)) return tables.get(world);
  const { model, explored } = built(world);
  const seen = explored.keys.map(() => new Set());
  const broken = Object.fromEntries(ROWS.map((row) => [row, new Set()]));
  const reached = Object.fromEntries(Object.keys(COMPANION_REACHED_BY).map((name) => [name, new Set()]));
  const queue = [[0, 0]];
  seen[0].add(0);
  for (let at = 0; at < queue.length; at += 1) {
    const [state, used] = queue[at];
    if (model.isFinished(explored.keys[state])) {
      for (const landed of model.termsOf(explored.keys[state])) {
        for (const row of fv.judged(landed)) broken[row].add(used);
        for (const [name, reachedBy] of Object.entries(COMPANION_REACHED_BY)) if (reachedBy(landed)) reached[name].add(used);
      }
      if ((model.verdictOf(explored.keys[state]) & fv.propertyMask(TERM)) !== 0) broken[TERM].add(used);
    }
    for (let edge = explored.firstEdge[state]; edge < explored.firstEdge[state + 1]; edge += 1) {
      const to = explored.edgeTo[edge];
      const next = used | explored.edgeBlockedBy[edge];
      if (seen[to].has(next)) continue;
      seen[to].add(next);
      queue.push([to, next]);
    }
  }
  const smallest = (masks) => [...masks].filter((mask) => ![...masks].some((other) => other !== mask && (other & mask) === other)).map((mask) => fv.namesOf(mask).sort().join(","));
  const table = { violations: Object.fromEntries(ROWS.map((row) => [row, smallest(broken[row]).sort()])), reached: Object.fromEntries(Object.entries(reached).map(([name, masks]) => [name, [...masks].map((mask) => fv.namesOf(mask))])) };
  tables.set(world, table);
  return table;
}

/** Whether some worker of the hand-written model lands the way a companion says none does, on a path the assumed switches leave open. */
const reachedUnder = (world, companion, assumed) => modelTable(world).reached[companion].some((used) => used.every((name) => !assumed.includes(name)));

const asKeys = (sets) => sets.map((set) => [...set].sort().join(",")).sort();

for (const world of Object.keys(WORLDS)) {
  test(`under each of the 512 sets of switches, the rows the model's own verdicts break are the rows TLC found broken, in the ${world} world`, () => {
    const byModel = modelTable(world).violations;
    for (const row of ROWS) assert.deepEqual(asKeys(conformance.worlds[world].table.violations[row]), byModel[row], row);
  });
}

// The register's table, as rows F4-READ to F4-BEYOND state it and as lib/fv-worker-model.test.ts pins it: the smallest
// sets of the plan's axioms each row holds under, by world. [] is no set, and [[]] is the empty set.
//
// A cell is here only where its row has something to judge. The register's table also gives [[]] ("holds under no
// axiom") for both exclusion rows, the no-term row and F4-READ in the stream world. That is true of TLC's table too, and
// it says nothing: no worker of that world is ever excluded, lands nowhere or runs unobserved, so those rows pass there
// whatever the protocol does. Those four cells are held apart, below, as cells with nothing to judge.
//
// The register's table gives F4-AGE [[]] in the hold and two-worker worlds as well, and its row says "the stream world
// decides it". Those two cells are also held apart: with no stream the realm has one snapshot at the freeze, every read
// is of it, and the row cannot tell a right read from a wrong one.
const REGISTER_TABLE = {
  [EXCLUDED_1]: { hold: [], two: [] },
  [EXCLUDED_2]: { hold: [], two: [] },
  [READ]: { hold: [["A1", "A2"]], two: [[]] },
  [AGE]: { stream: [["A1", "notA3", "A5fifo"]] },
  [TERM]: { hold: [[]], stream: [[]], two: [[]] },
  [NO_TERM]: { hold: [], two: [] }
};

const violationsOver = (worlds) => Object.fromEntries(ROWS.map((row) => [row, worlds.flatMap((world) => conformance.worlds[world].table.violations[row])]));

test("the axiom table TLC found is the register's: each row's smallest sets of the plan's axioms, in each shared world", () => {
  for (const [row, byWorld] of Object.entries(REGISTER_TABLE)) {
    for (const [world, expected] of Object.entries(byWorld)) {
      assert.deepEqual(asKeys(smallestSets(conformance.worlds[world].table.violations, row, PLAN_AXIOMS)), asKeys(expected), `${row} in the ${world} world`);
      // A cell that says a row holds is compared only where the row has something to judge under that set.
      for (const assumed of expected) {
        for (const companion of COMPANIONS[row]) assert.equal(reachedUnder(world, companion, assumed), true, `${row} is listed as holding in the ${world} world under ${assumed.join() || "no axiom"}, where ${companion} is never reached: it has nothing to judge there`);
      }
    }
  }
});

test("a row is listed as holding only where it has something to judge: each of its companions is reached there, by TLC's own run and in the hand-written model's graph", () => {
  for (const world of Object.keys(WORLDS)) {
    // The cells the export ran are the export script's table as it stands.
    assert.deepEqual(
      conformance.worlds[world].cells.map(({ assumed, holds, fails }) => ({ assumed, holds, fails })),
      CELLS[world],
      `${world}: the export script's table changed since TLC last ran it: run scripts/tla-worker-hold-export.mjs`
    );
    for (const { assumed, holds, reached } of conformance.worlds[world].cells) {
      // What TLC reported violated for this cell: the export refuses to write a cell with a companion TLC holds.
      assert.deepEqual(reached, companionsOf(holds), `${world} under ${assumed.join() || "nothing"}`);
      for (const row of holds) {
        for (const companion of COMPANIONS[row]) assert.equal(reachedUnder(world, companion, assumed), true, `${INVARIANT_OF[row]} is listed as holding in the ${world} world under ${assumed.join() || "nothing"}, where ${companion} is never reached: it has nothing to judge there`);
      }
    }
    // The committed configuration, read as it stands: every row it lists, under the plan's axioms.
    const listed = invariantsOf(readFileSync(join(SPEC_DIR, `${world}-plan.cfg`), "utf8"));
    const rows = ROWS.filter((row) => listed.includes(INVARIANT_OF[row]));
    assert.deepEqual(listed, ["TypeOK", ...rows.map((row) => INVARIANT_OF[row])], `${world}-plan.cfg lists the type invariant and rows`);
    assert.deepEqual(conformance.worlds[world].underPlan.reached, companionsOf(rows), `${world}-plan.cfg`);
    for (const row of rows) {
      for (const companion of COMPANIONS[row]) assert.equal(reachedUnder(world, companion, PLAN_AXIOMS), true, `${world}-plan.cfg lists ${INVARIANT_OF[row]}, and under the plan's axioms ${companion} is never reached in that world: the row has nothing to judge there`);
    }
  }
});

test("where a row has nothing to judge: in the stream world no worker is excluded, lands nowhere or runs unobserved, and outside it no read is of a realm past its first snapshot; every other row can be judged in every world", () => {
  assert.deepEqual(Object.keys(NOT_JUDGED).sort(), Object.keys(WORLDS).sort());
  for (const world of Object.keys(WORLDS)) {
    for (const row of ROWS) {
      // With nothing assumed every path is open, so a companion not reached here is reached under no set of switches.
      const neverReached = COMPANIONS[row].filter((companion) => !reachedUnder(world, companion, []));
      assert.equal(neverReached.length > 0, NOT_JUDGED[world].includes(row), `${row} in the ${world} world: ${neverReached.join() || "every companion is reached"}`);
      if (neverReached.length === 0) continue;
      // Such a row cannot fail there, which is all its "holds" says: TLC's table has no set of switches that breaks it,
      // and no cell and no committed configuration lists it.
      assert.deepEqual(conformance.worlds[world].table.violations[row], [], `${row} in the ${world} world`);
      for (const { holds, fails } of CELLS[world]) assert.equal([...holds, ...fails].includes(row), false, `${row} is in a cell of the ${world} world`);
      assert.equal(conformance.worlds[world].underPlan.invariants.includes(INVARIANT_OF[row]), false, `${world}-plan.cfg lists ${INVARIANT_OF[row]}`);
    }
  }
  assert.deepEqual(NOT_JUDGED, { hold: [AGE], stream: [EXCLUDED_1, EXCLUDED_2, READ, NO_TERM], two: [AGE], small: [AGE] });
  // The world that judges F4-AGE is the one with a stream, and only that one.
  for (const [world, { constants }] of Object.entries(WORLDS)) assert.equal(NOT_JUDGED[world].includes(AGE), !constants.Stream, world);
});

test("F4-TABLE and F4-BEYOND, from TLC's table: A4 changes no verdict, the exclusion rows fail with C1 and D1 on top of every axiom, D1 closes the no-term row only where the tree is waited for, and only Z closes it everywhere", () => {
  const shared = ["hold", "stream", "two"];
  const subsets = Array.from({ length: 1 << SWITCHES.length }, (_unused, mask) => SWITCHES.filter((_name, at) => (mask & (1 << at)) !== 0));
  for (const world of shared) {
    for (const row of ROWS) {
      for (const assumed of subsets) {
        if (assumed.includes("A4")) continue;
        assert.equal(failsUnder(conformance.worlds[world].table.violations, row, [...assumed, "A4"]), failsUnder(conformance.worlds[world].table.violations, row, assumed), `${world}: A4 moved ${row} under ${assumed.join()}`);
      }
    }
  }
  const everywhere = violationsOver(shared);
  for (const row of [EXCLUDED_1, EXCLUDED_2]) {
    assert.equal(failsUnder(everywhere, row, WITH_C1_D1), true, row);
    assert.deepEqual(asKeys(smallestSets(everywhere, row, SWITCHES.filter((name) => name !== "A4"))), ["A5fifo,Z"], row);
  }
  const waiting = violationsOver(["hold", "stream"]);
  assert.equal(failsUnder(waiting, NO_TERM, WITH_C1), true);
  assert.equal(failsUnder(waiting, NO_TERM, ["D1"]), false);
  assert.deepEqual(asKeys(smallestSets(everywhere, NO_TERM, SWITCHES.filter((name) => name !== "A4"))), ["Z"]);
  assert.deepEqual(asKeys(smallestSets(waiting, NO_TERM, SWITCHES.filter((name) => name !== "A4"))), ["D1", "Z"]);
  // With Z alone assumed, the small world keeps the exclusion rows.
  for (const row of [EXCLUDED_1, EXCLUDED_2]) assert.equal(failsUnder(conformance.worlds.small.table.violations, row, ["Z"]), false, row);
});

test("TLC's own verdict on each row, as an invariant under each set of switches the register names, is the register's", () => {
  // Each cell is a TLC run the export made: the rows listed as holding passed as invariants, and each row listed as
  // failing was reported violated. The export refuses to write a cell TLC did not confirm.
  const cell = (world, assumed) => conformance.worlds[world].cells.find((candidate) => candidate.assumed.join() === assumed.join());
  assert.deepEqual(cell("hold", ["A1", "A2"]).holds, [READ]);
  assert.deepEqual(cell("hold", PLAN_AXIOMS.filter((name) => name !== "A1")).fails, [READ]);
  assert.deepEqual(cell("hold", PLAN_AXIOMS.filter((name) => name !== "A2")).fails, [READ]);
  assert.deepEqual(cell("hold", WITH_C1_D1).fails, [EXCLUDED_1, EXCLUDED_2]);
  assert.deepEqual(cell("hold", ["A5fifo", "Z"]).holds, [EXCLUDED_1, EXCLUDED_2]);
  assert.deepEqual(cell("stream", ["A1", "notA3", "A5fifo"]).holds, [AGE]);
  for (const dropped of ["A1", "notA3", "A5fifo"]) assert.deepEqual(cell("stream", PLAN_AXIOMS.filter((name) => name !== dropped)).fails, [AGE]);
  assert.deepEqual(cell("two", PLAN_AXIOMS).fails, [EXCLUDED_1, EXCLUDED_2, NO_TERM]);
  // Not a sentence of the register: with C1 on top of the plan's axioms the second exclusion row holds in the two-worker world.
  assert.deepEqual(cell("two", WITH_C1_D1).fails, [EXCLUDED_1, NO_TERM]);
  assert.deepEqual(cell("small", ["Z"]).holds, [EXCLUDED_1, EXCLUDED_2]);
  for (const world of Object.keys(WORLDS)) {
    for (const { assumed, holds, fails } of conformance.worlds[world].cells) {
      for (const row of holds) assert.equal(failsUnder(conformance.worlds[world].table.violations, row, assumed), false, `${world}, ${assumed.join()}: ${row}`);
      for (const row of fails) assert.equal(failsUnder(conformance.worlds[world].table.violations, row, assumed), true, `${world}, ${assumed.join()}: ${row}`);
    }
  }
});

test("the named trace, from TLC's table: reachable and excluded, frozen as held, as reaching and by the second pass, with the causes each set of switches leaves", () => {
  const namedUnder = (assumed) => Object.keys(conformance.worlds.hold.table.named).filter((form) => failsUnder(conformance.worlds.hold.table.named, form, assumed)).sort();
  const each = (causes) => ["held", "reaching", "second-pass"].flatMap((form) => causes.map((cause) => `${form}:${cause}`));
  // As lib/fv-worker-model.test.ts pins the hand-written model's: without A5's latency half, every form by five causes.
  const noLatencyHalf = each(["late-posted-before-the-freeze", "late-posted-after-the-freeze", "resume-still-on-the-socket", "connection-lost-on-the-port", "thread-concluded-first"]);
  assert.deepEqual(namedUnder(["A1", "A2", "notA3", "A4", "A5fifo"]), [...noLatencyHalf].sort());
  const withIt = noLatencyHalf.filter((form) => form !== "held:late-posted-before-the-freeze" && form !== "reaching:late-posted-before-the-freeze");
  assert.deepEqual(namedUnder(PLAN_AXIOMS), [...withIt].sort());
  const andC1 = withIt.filter((form) => !["held:late-posted-after-the-freeze", "reaching:late-posted-after-the-freeze", "held:resume-still-on-the-socket", "reaching:resume-still-on-the-socket"].includes(form));
  assert.deepEqual(namedUnder(WITH_C1), [...andC1].sort());
  const stay = each(["connection-lost-on-the-port", "thread-concluded-first"]).sort();
  assert.deepEqual(namedUnder([...PLAN_AXIOMS, "D1"]), stay);
  assert.deepEqual(namedUnder(WITH_C1_D1), stay);
});

// ---------------------------------------------------------------------------------------------
// TLC's traces through the real thread, mirror and readout.
// ---------------------------------------------------------------------------------------------

const mirrorView = ([known, hold, detached, detachedWhilePaused, endedUnreached, install]) => ({ known: known === 1, hold: hold === "none" ? null : hold, detached: detached === 1, detachedWhilePaused: detachedWhilePaused === 1, endedUnreached: endedUnreached === 1, install: install === "none" ? null : install });
const landedWorker = ([term, readSeq, ranAtFreeze, ranUnobservedAtFreeze, ranUnobserved, attacherLives, realmAtFreeze]) => ({ term, readSeq, ranAtFreeze: ranAtFreeze === 1, ranUnobservedAtFreeze: ranUnobservedAtFreeze === 1, ranUnobserved: ranUnobserved === 1, attacherLives: attacherLives === 1, realmAtFreeze, movedFromAt11: "no" });

/** A kept trace: the tree's nodes from the first state to a leaf. */
function pathOf(world, leaf) {
  const { tree } = conformance.worlds[world];
  const nodes = [];
  for (let at = leaf; at > 0; at = tree[at][0]) nodes.push(tree[at]);
  return nodes.reverse();
}

/**
 * One of TLC's traces through the whole real path, as the hand-written suite's own replay of a
 * path goes: each step of each label to the real thread or the real main side, the mirror held to
 * the specification's state after each label, and the landing at the end of a readout. It
 * returns how many landings it checked.
 */
async function replayPath(clock, modules, world, leaf, mustHold) {
  const { labels } = conformance.worlds[world];
  const path = pathOf(world, leaf);
  const texts = path.map(([, label]) => labels[label]);
  const input = () => ({ world, trace: texts });
  const whole = await replay.WholeReplay.open(clock, modules, WORLDS[world].constants.WorkerCount);
  try {
    whole.main.treesComeLate = texts.some((label) => label.includes("documents-late"));
    const prefix = WORLDS[world].constants.StartReleased ? fv.STREAM_WORLD_PREFIX.flatMap(fv.stepsOf).filter((step) => fv.realCodeHearsStep(step.name)) : [];
    for (const step of prefix) await whole.step(step, input);
    for (const [, label, mirror, landing] of path) {
      for (const step of fv.stepsOf(labels[label])) await whole.step(step, input);
      if (landing !== undefined) whole.main.checkLanding([landing.map(landedWorker)], mustHold, input);
      else {
        whole.main.checkMirror(mirror.map(mirrorView), input);
        whole.main.checkEnded(false, input);
      }
    }
    assert.equal(whole.main.checked, path.length, "every label of the trace was checked");
    return whole.main.landingsChecked;
  } finally {
    whole.close();
  }
}

for (const world of Object.keys(WORLDS)) {
  test(`TLC's traces replay through the real thread, mirror and readout: every label the ${world} world takes under the plan's axioms with C1 and D1`, async () => {
    const { traces, labels, tree, table } = conformance.worlds[world];
    // The rows TLC found to hold under that set must hold of the real readout's terms too, judged by the specification's facts.
    const mustHold = new Set(ROWS.filter((row) => !failsUnder(table.violations, row, WITH_C1_D1)));
    const taken = new Set();
    let landings = 0;
    await replay.underReplayClock(async (clock) => {
      for (const leaf of traces.cover) {
        landings += await replayPath(clock, PRODUCTION, world, leaf, mustHold);
        for (const [, label] of pathOf(world, leaf)) taken.add(label);
      }
    });
    assert.ok(traces.cover.length > 0 && landings > 0 && tree.length > traces.cover.length);
    // The export chose the traces so as to take every label the world has under that set, and counted those labels.
    assert.equal(taken.size, traces.coverLabels);
    assert.ok(taken.size <= labels.length);
  });
}

for (const world of Object.keys(WORLDS)) {
  // A world the file lacks fails the first test, and registers no trace here.
  for (const [index, { row, assumed, leaf }] of (conformance.worlds[world]?.traces.witnesses ?? []).entries()) {
    test(`TLC's trace that breaks ${row} in the ${world} world under ${assumed.join(" ") || "nothing"} goes through the real code, and the real readout's term breaks it too (${index})`, async () => {
      const path = pathOf(world, leaf);
      assert.ok(path[path.length - 1][3] !== undefined, "the trace ends with the readout");
      await replay.underReplayClock(async (clock) => {
        // Judged first by the specification's facts against the term the real readout counted: the row is broken there.
        await assert.rejects(replayPath(clock, PRODUCTION, world, leaf, new Set([row])), (error) => error instanceof Counterexample && error.property === row);
      });
      // And with no row required, the real readout lands every worker where the specification does. Not so for the
      // no-term row: there the specification, like the hand-written model, lands the worker nowhere, which no count of
      // the real readout says, so that landing is judged above and not compared, as the register's F4-TRACE row has it.
      if (row === NO_TERM) return;
      await replay.underReplayClock(async (clock) => {
        assert.equal(await replayPath(clock, PRODUCTION, world, leaf, new Set()), 1);
      });
    });
  }
}

for (const [index, { form, assumed, leaf }] of (conformance.worlds.hold?.traces.named ?? []).entries()) {
  test(`the named trace as ${form} under ${assumed.join(" ")} goes through the real code: the real readout excludes a worker that ran unobserved (${index})`, async () => {
    const path = pathOf("hold", leaf);
    const [term, , , ranUnobservedAtFreeze] = path[path.length - 1][3][0];
    assert.deepEqual([term, ranUnobservedAtFreeze], ["pausedAtReadout", 1]);
    await replay.underReplayClock(async (clock) => {
      assert.equal(await replayPath(clock, PRODUCTION, "hold", leaf, new Set()), 1);
    });
  });
}

test("the kept traces are the ones the suite replays: each row the register says fails has its trace, and the named trace each of its forms", () => {
  const witnessed = (world) => conformance.worlds[world].traces.witnesses.map(({ row, assumed }) => `${row} under ${assumed.join()}`).sort();
  const failing = (world) => conformance.worlds[world].cells.flatMap(({ assumed, fails }) => fails.map((row) => `${row} under ${assumed.join()}`)).sort();
  for (const world of Object.keys(WORLDS)) assert.deepEqual(witnessed(world), failing(world), world);
  const forms = new Set(conformance.worlds.hold.traces.named.map(({ form }) => form.split(":")[0]));
  assert.deepEqual([...forms].sort(), ["held", "reaching", "second-pass"]);
});

// Faults seeded in the real thread's compiled text. The first is one the hand-written suite also seeds
// (lib/fv-worker-model.test.ts, "the whole replay catches a variant of the thread"); the other two break the thread's
// answer to a hold another client released.
const THREAD_VARIANTS = [
  ["a report that says more than the port's word for it", [{ find: 'post({ type: "held", contextId: worker.contextId, sessionId: worker.sessionId });', replace: 'post({ type: "held", contextId: worker.contextId, sessionId: worker.sessionId, heldAt: 1 });' }]],
  ["a broken hold is posted late and the debugger is left on", [{ find: 'post({ type: "late", contextId: worker.contextId, sessionId: worker.sessionId, reason: "resumed-while-held" });\n        void turnDebuggerOff(worker);', replace: 'post({ type: "late", contextId: worker.contextId, sessionId: worker.sessionId, reason: "resumed-while-held" });' }]],
  ["the thread makes nothing of a resume while it holds a worker", [{ find: 'const breakHold = (worker) => {\n        if (worker.hold !== "held" || worker.installConcluded)\n            return;', replace: "const breakHold = (worker) => {\n        if (worker !== null)\n            return;" }]]
];

// Two faults the hand-written suite catches and these traces cannot, kept here so that the limit is on record and not
// only in prose. The first acts on a word the model drops (a resume behind the install's answers), which is no step of
// any trace: the suite catches it by delivering dropped words to the real thread. The second needs a session's words
// out of order at one particular point, and the kept traces take each label once, in order, under the plan's axioms
// with C1 and D1, plus one path to each broken row. The tie that reaches such faults is the suite's own replay of the
// model (register row F4-TRACE), which reaches the specification through the comparison of graphs above.
const NOT_TOLD_APART = [
  ["a resume behind the install's answers breaks the hold", [{ find: 'if (worker.hold !== "held" || worker.installConcluded)', replace: 'if (worker.hold !== "held")' }]],
  ["the question is taken away from a worker whatever its hold", [{ find: 'if (workers.get(sessionId) !== worker || worker.hold !== "pending")', replace: "if (workers.get(sessionId) !== worker)" }]]
];

/** The property the first kept trace of the hold and stream worlds reports against a variant of the thread, or null when every one of them replays clean. */
async function caughtBy(edits) {
  const variant = { attacher: loadVariant(join(DIST, "shared-worker-attacher.js"), edits), realm };
  let caught = null;
  await replay.underReplayClock(async (clock) => {
    for (const world of ["hold", "stream"]) {
      const { traces } = conformance.worlds[world];
      for (const leaf of [...traces.cover, ...traces.witnesses.map((witness) => witness.leaf), ...traces.named.map((named) => named.leaf)]) {
        try {
          await replayPath(clock, variant, world, leaf, new Set());
        } catch (error) {
          if (!(error instanceof Counterexample)) throw error;
          caught = error.property;
          return;
        }
      }
    }
  });
  return caught;
}

for (const [name, edits] of THREAD_VARIANTS) {
  test(`the replay of TLC's traces catches a variant of the real thread: ${name}`, async (t) => {
    const caught = await caughtBy(edits);
    assert.notEqual(caught, null, "no trace told the variant from the real thread");
    t.diagnostic(`caught by ${caught}`);
  });
}

test("what the kept traces cannot tell from the real thread: a fault on a word the model drops, and one that needs a session's words out of order at one point", async () => {
  for (const [name, edits] of NOT_TOLD_APART) assert.equal(await caughtBy(edits), null, `${name}: the kept traces now tell it apart, so move it to the variants they catch`);
});
