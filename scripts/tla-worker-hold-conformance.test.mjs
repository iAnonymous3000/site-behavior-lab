// Trace conformance between the TLA+ specification of the shared-worker hold
// (specs/worker-hold/WorkerHold.tla), the hand-written model (lib/fv-worker-model.ts) and the
// real attacher thread, mirror and readout.
//
// It runs without Java: what TLC computed is in specs/worker-hold/conformance.json, which
// scripts/tla-worker-hold-export.mjs regenerates with TLC and compares byte for byte with
// --check. The unit tests never regenerate it: here TLC's side of every comparison is that committed
// file. The workflow tla-checks.yml checks the file against TLC on every push to main. The file records the SHA-256 of the script that wrote it, of each module that script
// imports, of each specification file and each committed configuration, and of the jar, and the
// first test fails when one of those files no longer has the digest recorded. TLC model-checks the specification's rows over each world under the sets of switches
// that file names. This suite then holds three things:
// - The model and the specification take the same steps. For each world the hand-written model's
//   whole graph, with nothing assumed, is folded into a digest over its labels (each move's steps
//   with what the thread posted and sent, then the switches that forbid the move) and over what
//   each worker landed as with the world's facts about it. That digest must be the one TLC's
//   printed graph gave. A state's digest is SHA-256 over its moves and the digests of the states
//   they lead to, cut to 128 bits. Equal digests therefore show that the two are bisimilar over
//   those labels (every trace of the model is a trace of the specification, and the other way,
//   under every set of switches) unless two different digests collide. The equality is
//   established by that truncated digest, not edge by edge; the export script walks to the first
//   difference whenever the two part.
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
// - No shared worker is excluded. From fingerprint-observer@14 the readout lands a worker released,
//   or still held at the bound, unread as a hold the freeze cannot place (holdUnplaced), where
//   through @13 it excluded it. So both exclusion rows have nothing to judge in every world, and
//   are listed nowhere: in no cell, in no committed configuration and in no cell of the register's
//   table below. That is asserted for each world, not skipped: TLC held NoWorkerExcluded with
//   nothing assumed, the hand-written model's graph has no excluded landing, and no kept trace
//   ends in one. The two rows stay in the specification and can still fail: three variants of the
//   real readout, each with one @13 exclusion put back, are caught by an exclusion row on the
//   named traces, and the specification's own seeded faults do the same under TLC.
// - The real code follows TLC's traces, and is held to the specification on those traces only:
//   40, 13, 23 and 19 covering traces in the hold, stream, two-worker and small worlds, 9 that
//   break a row and 33 that reach a form of the named trace. Two seeded faults of the real thread are pinned
//   below as not detected by this replay. Each kept trace, a path of moves TLC printed, is replayed
//   through the real thread, its in-process transport, the real mirror and the real readout by
//   the suite's own harness (lib/fv-worker-model-replay.ts): at each step the thread must post
//   and send what the label says, the port must carry it, and the mirror must hold what the
//   specification's state holds; at the end the readout must land each worker where the
//   specification does. The traces take every label of each world under the plan's axioms with
//   C1 and D1, break each row the register says fails, and reach each form of the named trace.
//   The named trace ends with its worker unread, as a hold the freeze cannot place.
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
import { provenanceNow } from "./tla-tools-lib.mjs";
import { CELLS } from "./tla-worker-hold-export.mjs";
import { COMPANION_REACHED_BY, COMPANIONS, companionsOf, digests, EXCLUDED_TERMS, failsUnder, modelGraph, NAMED_TERM, NOT_JUDGED, PLAN_AXIOMS, ROWS as INVARIANT_OF, sha256Hex, smallestSets, summary, SWITCHES, WORLDS } from "./tla-worker-hold-lib.mjs";

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
const EXCLUSION_ROWS = [EXCLUDED_1, EXCLUDED_2];
const WITH_C1 = [...PLAN_AXIOMS, "C1"];
const WITH_C1_D1 = [...PLAN_AXIOMS, "C1", "D1"];

// What each committed configuration lists: the type invariant, and the rows that hold under the plan's axioms in that
// world and have something to judge there. No world lists an exclusion row: no shared worker is excluded, so neither
// has anything to judge anywhere. The stream world lists no no-term row and no F4-READ either.
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

test("the committed export names the script that wrote it and the files it was written from, each still has the digest it records, and its worlds are the hand-written model's", () => {
  assert.equal(conformance.format, 3);
  // What the export says it was produced by and from, against the files as they stand. A file edited since the export
  // fails here: the export script and the modules it imports, a specification file, or a configuration.
  const now = provenanceNow(conformance, SPEC_DIR);
  for (const kind of ["producedBy", "specification", "configurations"]) {
    for (const [file, digest] of Object.entries(conformance[kind])) assert.equal(now[kind][file], digest, `${file} changed since TLC last exported with it: run scripts/tla-worker-hold-export.mjs`);
  }
  assert.deepEqual(Object.keys(conformance.producedBy).sort(), ["scripts/tla-case-machine-lib.mjs", "scripts/tla-tools-lib.mjs", "scripts/tla-worker-hold-export.mjs", "scripts/tla-worker-hold-lib.mjs"]);
  assert.deepEqual(Object.keys(conformance.specification).sort(), ["WorkerHold.tla", "WorkerHoldExport.tla", "WorkerHoldTable.tla"]);
  assert.deepEqual(Object.keys(conformance.configurations).sort(), Object.keys(WORLDS).map((world) => `${world}-plan.cfg`).sort());
  assert.equal(conformance.tla2tools, pins.tla2tools.sha256, "the export was made with the pinned jar");
  assert.equal(sha256Hex(conformanceText), pins.artifacts["specs/worker-hold/conformance.json"], "the export's digest is the pinned one");
  assert.deepEqual(Object.keys(conformance.worlds).sort(), Object.keys(WORLDS).sort(), "every world is exported");
  for (const [name, { model, constants }] of Object.entries(WORLDS)) {
    const world = fv[model];
    assert.deepEqual(conformance.worlds[name].constants, constants);
    assert.deepEqual({ WorkerCount: world.workers, CollapseSessions: world.collapseSessions, Stream: world.stream, StartReleased: world.startReleased, Reduced: world.reduced }, constants, `${name}: the specification's constants are the model's world`);
    assert.equal(conformance.worlds[name].tlc.generated > conformance.worlds[name].tlc.distinct, true);
    // No depth: TLC's reported depth varies from run to run with more than one worker, so the export does not hold it.
    for (const counts of [conformance.worlds[name].tlc, conformance.worlds[name].underPlan.tlc]) assert.deepEqual(Object.keys(counts).sort(), ["distinct", "generated"], `${name}: TLC's two counts and nothing else are recorded`);
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
// A cell is here only where its row has something to judge. So neither exclusion row has a cell here, in any world.
// Through fingerprint-observer@13 the readout excluded a worker released, or still held at the bound, and both rows
// held under no subset of the plan's axioms in the hold and two-worker worlds. From @14 no shared worker is excluded:
// TLC's table has no set of switches that breaks either row, which reads as "holds under no axiom" and says nothing,
// because the rows pass whatever the rest of the protocol does. They are held apart, below, as rows with nothing to
// judge in every world.
//
// The same is so of the no-term row and F4-READ in the stream world: no worker of that world lands nowhere or runs
// unobserved. Those two cells are held apart as well.
//
// The register's table gives F4-AGE [[]] in the hold and two-worker worlds as well, and its row says "the stream world
// decides it". Those two cells are also held apart: with no stream the realm has one snapshot at the freeze, every read
// is of it, and the row cannot tell a right read from a wrong one.
const REGISTER_TABLE = {
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

test("where a row has nothing to judge: no worker of any world is excluded; in the stream world none lands nowhere or runs unobserved; outside it no read is of a realm past its first snapshot; every other row can be judged in every world", () => {
  assert.deepEqual(Object.keys(NOT_JUDGED).sort(), Object.keys(WORLDS).sort());
  for (const world of Object.keys(WORLDS)) {
    // TLC's side: the export ran each companion below with nothing assumed, and writes a row here only if TLC held it.
    assert.deepEqual(Object.keys(conformance.worlds[world].notJudged), ROWS.filter((row) => NOT_JUDGED[world].includes(row)), `${world}: the rows TLC found with nothing to judge`);
    for (const row of ROWS) {
      // With nothing assumed every path is open, so a companion not reached here is reached under no set of switches.
      const neverReached = COMPANIONS[row].filter((companion) => !reachedUnder(world, companion, []));
      assert.equal(neverReached.length > 0, NOT_JUDGED[world].includes(row), `${row} in the ${world} world: ${neverReached.join() || "every companion is reached"}`);
      if (neverReached.length === 0) continue;
      assert.deepEqual(conformance.worlds[world].notJudged[row], neverReached, `${row} in the ${world} world: the companions TLC held with nothing assumed are the ones the model's graph never reaches`);
      // Such a row cannot fail there, which is all its "holds" says: TLC's table has no set of switches that breaks it,
      // and no cell and no committed configuration lists it.
      assert.deepEqual(conformance.worlds[world].table.violations[row], [], `${row} in the ${world} world`);
      for (const { holds, fails } of CELLS[world]) assert.equal([...holds, ...fails].includes(row), false, `${row} is in a cell of the ${world} world`);
      assert.equal(conformance.worlds[world].underPlan.invariants.includes(INVARIANT_OF[row]), false, `${world}-plan.cfg lists ${INVARIANT_OF[row]}`);
    }
  }
  assert.deepEqual(NOT_JUDGED, { hold: [EXCLUDED_1, EXCLUDED_2, AGE], stream: [EXCLUDED_1, EXCLUDED_2, READ, NO_TERM], two: [EXCLUDED_1, EXCLUDED_2, AGE], small: [EXCLUDED_1, EXCLUDED_2, AGE] });
  // The world that judges F4-AGE is the one with a stream, and only that one.
  for (const [world, { constants }] of Object.entries(WORLDS)) assert.equal(NOT_JUDGED[world].includes(AGE), !constants.Stream, world);
});

for (const world of Object.keys(WORLDS)) {
  test(`no shared worker is excluded in the ${world} world, under any set of switches: TLC held NoWorkerExcluded with nothing assumed, the model's graph has no excluded landing, and both exclusion rows are listed nowhere`, () => {
    const exported = conformance.worlds[world];
    // TLC's own run, with nothing assumed, so over every path of the world.
    for (const row of EXCLUSION_ROWS) assert.equal(exported.notJudged[row].includes("NoWorkerExcluded"), true, `${row}: TLC held NoWorkerExcluded`);
    // The hand-written model, over the real kernels: no landing on any path is in an excluded term.
    assert.equal(reachedUnder(world, "NoWorkerExcluded", []), false, "the model's graph excludes a worker");
    // What else of that world lands a worker is not empty, so the walk above read landings.
    assert.equal(reachedUnder(world, "NoWorkerInANamedTerm", []), true);
    // No kept trace ends with a worker in an excluded term.
    for (const node of exported.tree) for (const landed of node[3] ?? []) assert.equal(EXCLUDED_TERMS.includes(landed[0]), false, `a kept trace of the ${world} world ends in ${landed[0]}`);
    // So no set of switches breaks either row, and neither is listed as holding or as failing anywhere.
    for (const row of EXCLUSION_ROWS) {
      assert.deepEqual(exported.table.violations[row], [], row);
      assert.deepEqual(modelTable(world).violations[row], [], row);
      for (const { assumed, holds, fails } of CELLS[world]) assert.equal([...holds, ...fails].includes(row), false, `${row} is in the cell of the ${world} world under ${assumed.join() || "nothing"}`);
      for (const { holds, fails } of exported.cells) assert.equal([...holds, ...fails].includes(row), false, `${row} is in a cell TLC ran`);
      assert.equal(exported.underPlan.invariants.includes(INVARIANT_OF[row]), false, `${world}-plan.cfg lists ${INVARIANT_OF[row]}`);
      assert.equal(readFileSync(join(SPEC_DIR, `${world}-plan.cfg`), "utf8").split("\n").some((line) => line.trim() === INVARIANT_OF[row]), false, `${world}-plan.cfg lists ${INVARIANT_OF[row]}`);
      assert.equal(REGISTER_TABLE[row], undefined, `${row} has a cell in the suite's copy of the register's table`);
      assert.equal(exported.traces.witnesses.some((witness) => witness.row === row), false, `a kept trace is said to break ${row}`);
    }
    // The rows are still live: a worker that ran and landed in an excluded term would break both, and reach the companion.
    for (const term of EXCLUDED_TERMS) {
      const landed = { term, readSeq: 0, ranAtFreeze: true, ranUnobservedAtFreeze: true, ranUnobserved: true, attacherLives: true, realmAtFreeze: 0, movedFromAt11: "no" };
      assert.deepEqual(fv.judged(landed), EXCLUSION_ROWS, term);
      assert.equal(COMPANION_REACHED_BY.NoWorkerExcluded(landed), true, term);
    }
    assert.equal(COMPANION_REACHED_BY.NoWorkerExcluded({ term: NAMED_TERM }), false);
  });
}

test("F4-TABLE and F4-BEYOND, from TLC's table: A4 changes no verdict, no set of switches breaks an exclusion row now that no shared worker is excluded, D1 closes the no-term row only where the tree is waited for, and only Z closes it everywhere", () => {
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
  // Through fingerprint-observer@13 the exclusion rows failed with C1 and D1 on top of every axiom, and only A5's
  // order half with Z kept them. From @14 nothing breaks either, with nothing assumed, in any world, the small one
  // included: a row with no worker to judge.
  for (const row of EXCLUSION_ROWS) {
    assert.deepEqual(violationsOver(Object.keys(WORLDS))[row], [], row);
    assert.equal(failsUnder(everywhere, row, []), false, row);
    assert.deepEqual(asKeys(smallestSets(everywhere, row, SWITCHES.filter((name) => name !== "A4"))), [""], row);
  }
  // The register words this over the hold and stream worlds. The stream world adds nothing to it: the no-term row
  // cannot fail there under any set of switches, so what D1 closes is the hold world's.
  const waiting = violationsOver(["hold", "stream"]);
  assert.equal(failsUnder(waiting, NO_TERM, WITH_C1), true);
  assert.equal(failsUnder(waiting, NO_TERM, ["D1"]), false);
  assert.deepEqual(asKeys(smallestSets(everywhere, NO_TERM, SWITCHES.filter((name) => name !== "A4"))), ["Z"]);
  assert.deepEqual(asKeys(smallestSets(waiting, NO_TERM, SWITCHES.filter((name) => name !== "A4"))), ["D1", "Z"]);
});

test("TLC's own verdict on each row, as an invariant under each set of switches the register names, is the register's", () => {
  // Each cell is a TLC run the export made: the rows listed as holding passed as invariants, and each row listed as
  // failing was reported violated. The export refuses to write a cell TLC did not confirm.
  const cell = (world, assumed) => conformance.worlds[world].cells.find((candidate) => candidate.assumed.join() === assumed.join());
  assert.deepEqual(cell("hold", ["A1", "A2"]).holds, [READ]);
  assert.deepEqual(cell("hold", PLAN_AXIOMS.filter((name) => name !== "A1")).fails, [READ]);
  assert.deepEqual(cell("hold", PLAN_AXIOMS.filter((name) => name !== "A2")).fails, [READ]);
  // With C1 and D1 on top of the plan's axioms nothing fails in the hold world now: through @13 both exclusion rows did.
  assert.deepEqual(cell("hold", WITH_C1_D1), { assumed: WITH_C1_D1, holds: [READ, TERM, NO_TERM], fails: [], distinct: cell("hold", WITH_C1_D1).distinct, reached: companionsOf([READ, TERM, NO_TERM]) });
  assert.equal(cell("hold", ["A5fifo", "Z"]), undefined, "the cell that held the exclusion rows under A5's order half and Z is gone");
  assert.deepEqual(cell("stream", ["A1", "notA3", "A5fifo"]).holds, [AGE]);
  for (const dropped of ["A1", "notA3", "A5fifo"]) assert.deepEqual(cell("stream", PLAN_AXIOMS.filter((name) => name !== dropped)).fails, [AGE]);
  assert.deepEqual(cell("two", PLAN_AXIOMS).fails, [NO_TERM]);
  assert.deepEqual(cell("two", WITH_C1_D1).fails, [NO_TERM]);
  assert.equal(cell("two", ["A5fifo", "Z"]), undefined);
  // The small world's cell through @13 was the exclusion rows under Z. Its cell now is the world with nothing assumed.
  assert.equal(cell("small", ["Z"]), undefined);
  assert.deepEqual(cell("small", []).holds, [READ, TERM]);
  for (const world of Object.keys(WORLDS)) {
    for (const { assumed, holds, fails } of conformance.worlds[world].cells) {
      for (const row of holds) assert.equal(failsUnder(conformance.worlds[world].table.violations, row, assumed), false, `${world}, ${assumed.join()}: ${row}`);
      for (const row of fails) assert.equal(failsUnder(conformance.worlds[world].table.violations, row, assumed), true, `${world}, ${assumed.join()}: ${row}`);
    }
  }
});

test("the named trace, from TLC's table: reachable, and unread as a hold the freeze cannot place, frozen as held, as reaching and by the second pass, with the causes each set of switches leaves", () => {
  // The trace is as reachable as it was through fingerprint-observer@13, form for form and cause for cause. What changed
  // is where the readout lands its worker: unread (holdUnplaced), and no longer excluded (pausedAtReadout). The table
  // module prints the term on each line of the trace, and the export refuses a line whose term is not NAMED_TERM.
  assert.equal(NAMED_TERM, "holdUnplaced");
  assert.equal(EXCLUDED_TERMS.includes(NAMED_TERM), false);
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
    // The rows TLC found to hold under that set must hold of the real readout's terms too, judged by the specification's
    // facts. Both exclusion rows are among them in every world, so a real readout that excluded a worker that ran, on a
    // covering trace, fails here.
    const mustHold = new Set(ROWS.filter((row) => !failsUnder(table.violations, row, WITH_C1_D1)));
    for (const row of EXCLUSION_ROWS) assert.equal(mustHold.has(row), true, row);
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

// How the hold stood when a named trace's readout ended, as the export keeps it: the mirror had heard the release, or
// still showed the worker held at the bound.
const NAMED_END = { released: "released by the drain's end", held: "still held at the bound" };

/**
 * The line of the readout's classification a named trace goes through, which is the line that excluded its worker
 * through fingerprint-observer@13: the second pass (attached after the freeze, as the mirror heard it, and released),
 * the reaching branch (reaching at the freeze, and released), or the held branch (seen held, then released or still
 * held at the bound). A worker read by the second pass or frozen as reaching, and still held at the bound, is seen
 * held first and goes through the held branch.
 */
const routeOf = ({ form, end }) => (end === "released" && form.startsWith("second-pass:") ? "second-pass" : end === "released" && form.startsWith("reaching:") ? "reaching" : "held");

for (const [index, { form, end, assumed, leaf }] of (conformance.worlds.hold?.traces.named ?? []).entries()) {
  test(`the named trace as ${form}, ${NAMED_END[end]}, under ${assumed.join(" ")} goes through the real code: the real readout lands a worker that ran unobserved as unread, a hold the freeze cannot place, and does not exclude it (${index})`, async () => {
    const path = pathOf("hold", leaf);
    const [term, , , ranUnobservedAtFreeze] = path[path.length - 1][3][0];
    assert.deepEqual([term, ranUnobservedAtFreeze], [NAMED_TERM, 1]);
    await replay.underReplayClock(async (clock) => {
      // Both exclusion rows are required of the real readout's own term: excluding this worker would break both.
      assert.equal(await replayPath(clock, PRODUCTION, "hold", leaf, new Set(EXCLUSION_ROWS)), 1);
    });
  });
}

test("the kept traces are the ones the suite replays: each row the register says fails has its trace, and the named trace each of its forms", () => {
  const witnessed = (world) => conformance.worlds[world].traces.witnesses.map(({ row, assumed }) => `${row} under ${assumed.join()}`).sort();
  const failing = (world) => conformance.worlds[world].cells.flatMap(({ assumed, fails }) => fails.map((row) => `${row} under ${assumed.join()}`)).sort();
  for (const world of Object.keys(WORLDS)) assert.deepEqual(witnessed(world), failing(world), world);
  const forms = new Set(conformance.worlds.hold.traces.named.map(({ form }) => form.split(":")[0]));
  assert.deepEqual([...forms].sort(), ["held", "reaching", "second-pass"]);
  // Each form is kept both ways its hold can stand at the end, so each of the three lines that excluded a worker
  // through fingerprint-observer@13 has a named trace that goes through it.
  for (const form of forms) assert.deepEqual([...new Set(conformance.worlds.hold.traces.named.filter((named) => named.form.split(":")[0] === form).map(({ end }) => end))].sort(), ["held", "released"], form);
  assert.deepEqual([...new Set(conformance.worlds.hold.traces.named.map(routeOf))].sort(), ["held", "reaching", "second-pass"]);
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

// Faults seeded in the real readout's compiled text: each puts back one exclusion the readout made through
// fingerprint-observer@13, and leaves the other two as @14 has them. The named traces end with a worker that ran
// unobserved before the freeze, so a readout that excludes it there breaks an exclusion row, judged by the
// specification's facts against the term the real readout counted. This is what shows, on the real code, that the two
// rows can still fail though no cell lists them. The specification's own three faults of the same kind need TLC
// (scripts/tla-worker-hold-mutations.mjs).
const UNPLACED = 'return { record, state: "unread", reason: "holdUnplaced" };';
const EXCLUDED_AGAIN = 'return { record, state: "excluded", reason: "pausedAtReadout" };';
// From @14 the readout's landing reads no excluded form at all, so each variant also gives it back the line that lands
// one in its term, as @13 had it. Without it a variant throws inside the readout, which is no verdict of a row.
const LANDS_EXCLUDED = {
  find: 'if (resolved.state === "unread")\n        return { term: resolved.reason, snapshot: null };\n    if (resolved.state === "ended-at-once")',
  replace: 'if (resolved.state === "excluded" || resolved.state === "unread")\n        return { term: resolved.reason, snapshot: null };\n    if (resolved.state === "ended-at-once")'
};
const READOUT_VARIANTS = [
  ["the second pass excludes a worker attached after the freeze and released", "second-pass", [{ find: `if (options.attachedAfterFreeze)\n        ${UNPLACED}`, replace: `if (options.attachedAfterFreeze)\n        ${EXCLUDED_AGAIN}` }]],
  ["a worker reaching at the freeze and released by the drain's end is excluded", "reaching", [{ find: `if (worker.hold === "released")\n        ${UNPLACED}`, replace: `if (worker.hold === "released")\n        ${EXCLUDED_AGAIN}` }]],
  ["a worker seen held, then released or still held at the bound, is excluded", "held", [{ find: `return { record, state: "unread", reason: "diedHeld" };\n    ${UNPLACED}`, replace: `return { record, state: "unread", reason: "diedHeld" };\n    ${EXCLUDED_AGAIN}` }]]
];

for (const [name, route, edits] of READOUT_VARIANTS) {
  test(`the replay of TLC's named traces catches a variant of the real readout by an exclusion row: ${name}`, async (t) => {
    const variant = { attacher, realm: loadVariant(join(DIST, "worker-fingerprint-realm.js"), [...edits, LANDS_EXCLUDED]) };
    const traces = conformance.worlds.hold.traces.named;
    let caught = 0;
    await replay.underReplayClock(async (clock) => {
      for (const named of traces) {
        const through = routeOf(named) === route;
        const what = `${named.form}, ${NAMED_END[named.end]}`;
        let reported = null;
        try {
          await replayPath(clock, variant, "hold", named.leaf, new Set(EXCLUSION_ROWS));
        } catch (error) {
          if (!(error instanceof Counterexample)) throw error;
          reported = error.property;
        }
        // A trace that goes through the line the variant changed is excluded again, and the first exclusion row reports
        // it. A trace that goes through another line replays as it does through the real readout.
        assert.equal(reported, through ? EXCLUDED_1 : null, what);
        if (through) caught += 1;
      }
    });
    assert.ok(caught > 0, `no named trace goes through the line this variant changes`);
    t.diagnostic(`caught on ${caught} of ${traces.length} named traces`);
  });
}
