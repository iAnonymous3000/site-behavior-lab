#!/usr/bin/env node

// Regenerates specs/worker-hold/conformance.json from the TLA+ specification, with TLC.
//
// CI has no Java, so the conformance suite (scripts/tla-worker-hold-conformance.test.mjs) reads
// that file and never runs TLC. For each world this script runs TLC three ways:
// - WorkerHoldExport, with nothing assumed: every state and every move, folded into the digest
//   the suite compares with the hand-written model's (lib/fv-worker-model.ts). The script makes
//   that comparison itself too, and on a difference prints the labels that lead to it.
// - WorkerHoldTable: every pair of a state and the switches a path to it broke, which gives each
//   row's verdict under every set of switches from one search, and the forms of the named trace.
// - WorkerHold, once for each set of switches the register names: TLC's own verdict on each row
//   as an invariant, which must agree with the table.
// From the first run's graph it also keeps traces for the suite to replay through the real
// thread, mirror and readout: one for every label the world takes under the plan's axioms with
// C1 and D1, one that breaks each row the register says fails, and one for each form of the
// named trace. Each trace is a path of moves TLC printed, from the first state.
//
// With --check it writes nothing and fails on any byte that differs from the committed file.
// It needs the compiled library: npx tsc -p tsconfig.test.json
//
// Usage:
//   node scripts/tla-worker-hold-export.mjs --jar <tla2tools.jar> [--java <java>] [--check] [--worlds a,b] [--workers n]

import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTlaValue } from "./tla-case-machine-lib.mjs";
import { layout, option, pinArtifact, pinnedTools, ROOT, runTlc, sha256Of, tupleLine } from "./tla-tools-lib.mjs";
import { digests, firstDifference, landedLabel, modelGraph, newGraph, PLAN_AXIOMS, specLabel, summary, SWITCHES, WORLDS } from "./tla-worker-hold-lib.mjs";

const SPEC_DIR = join(ROOT, "specs", "worker-hold");
const SPEC_FILES = ["WorkerHold.tla", "WorkerHoldExport.tla", "WorkerHoldTable.tla"];
const OUTPUT = join(SPEC_DIR, "conformance.json");

export const ROWS = {
  "excluded-implies-no-page-code-before-the-freeze": "ExcludedRanNothing",
  "excluded-implies-no-unobserved-page-code-before-the-freeze": "ExcludedRanNothingUnobserved",
  "read-implies-the-observer-preceded-every-statement": "ReadHadItsObserver",
  "a-read-state-is-no-older-than-the-freeze": "ReadNoOlderThanTheFreeze",
  "every-worker-the-readout-heard-of-lands-in-one-term": "HeardLandsInOneTerm",
  "a-worker-that-ran-before-the-freeze-lands-in-a-term": "RanLandsInATerm"
};
const EXCLUDED_1 = "excluded-implies-no-page-code-before-the-freeze";
const EXCLUDED_2 = "excluded-implies-no-unobserved-page-code-before-the-freeze";
const READ = "read-implies-the-observer-preceded-every-statement";
const AGE = "a-read-state-is-no-older-than-the-freeze";
const TERM = "every-worker-the-readout-heard-of-lands-in-one-term";
const NO_TERM = "a-worker-that-ran-before-the-freeze-lands-in-a-term";
const EVERY_ROW = Object.keys(ROWS);
const WITH_C1 = [...PLAN_AXIOMS, "C1"];
const WITH_C1_D1 = [...PLAN_AXIOMS, "C1", "D1"];
const without = (name) => PLAN_AXIOMS.filter((axiom) => axiom !== name);

/**
 * The sets of switches the register's rows name, by world, with the rows each says hold there and
 * the rows it says fail. TLC is run once on each with the rows that hold as invariants, and once
 * more for each row that fails, which it must report violated.
 */
export const CELLS = {
  hold: [
    { assumed: [], holds: [AGE, TERM], fails: [] },
    { assumed: ["A1", "A2"], holds: [READ], fails: [] },
    { assumed: without("A1"), holds: [], fails: [READ] },
    { assumed: without("A2"), holds: [], fails: [READ] },
    { assumed: WITH_C1, holds: [], fails: [NO_TERM] },
    { assumed: WITH_C1_D1, holds: [READ, AGE, TERM, NO_TERM], fails: [EXCLUDED_1, EXCLUDED_2] },
    { assumed: ["D1"], holds: [NO_TERM], fails: [] },
    { assumed: ["Z"], holds: [NO_TERM], fails: [] },
    { assumed: ["A5fifo", "Z"], holds: [EXCLUDED_1, EXCLUDED_2], fails: [] }
  ],
  stream: [
    { assumed: [], holds: [EXCLUDED_1, EXCLUDED_2, READ, TERM, NO_TERM], fails: [AGE] },
    { assumed: ["A1", "notA3", "A5fifo"], holds: [AGE], fails: [] },
    { assumed: without("A1"), holds: [], fails: [AGE] },
    { assumed: without("notA3"), holds: [], fails: [AGE] },
    { assumed: without("A5fifo"), holds: [], fails: [AGE] }
  ],
  two: [
    { assumed: [], holds: [READ, AGE, TERM], fails: [] },
    { assumed: PLAN_AXIOMS, holds: [READ, AGE, TERM], fails: [EXCLUDED_1, EXCLUDED_2, NO_TERM] },
    // The register does not state this one: with C1 on top, the second exclusion row holds in this world, and the first stays broken.
    { assumed: WITH_C1_D1, holds: [EXCLUDED_2, READ, AGE, TERM], fails: [EXCLUDED_1, NO_TERM] },
    { assumed: ["Z"], holds: [NO_TERM], fails: [] },
    { assumed: ["A5fifo", "Z"], holds: [EXCLUDED_1, EXCLUDED_2], fails: [] }
  ],
  small: [{ assumed: ["Z"], holds: [EXCLUDED_1, EXCLUDED_2], fails: [] }]
};

/** The sets the register's named-trace row reads the hold world under. */
export const NAMED_UNDER = [["A1", "A2", "notA3", "A4", "A5fifo"], PLAN_AXIOMS, WITH_C1, [...PLAN_AXIOMS, "D1"], WITH_C1_D1];

const tlaSet = (names) => `{${names.map((name) => `"${name}"`).join(", ")}}`;

function configuration(world, assumed, init, next, invariants) {
  const constants = Object.entries(WORLDS[world].constants).map(([name, value]) => `  ${name} = ${typeof value === "boolean" ? String(value).toUpperCase() : value}`);
  return `${["CONSTANTS", ...constants, `  Assumed = ${tlaSet(assumed)}`, `INIT ${init}`, `NEXT ${next}`, ...(invariants.length > 0 ? ["INVARIANTS", ...invariants.map((name) => `  ${name}`)] : [])].join("\n")}\n`;
}

const maskOf = (names) => names.reduce((mask, name) => mask | (1 << SWITCHES.indexOf(name)), 0);
const namesOf = (mask) => SWITCHES.filter((_name, at) => (mask & (1 << at)) !== 0);

// Where a worker's code holds what the suite reads: WorkerCode in WorkerHoldExport.tla states the order.
const AT = { ranuF: 14, conc: 21, known: 24, mhold: 25, det: 26, dwp: 27, unreached: 28, install: 30, formState: 37, events: 44 };

/** The mirror as the replay holds the real one to it, read off a state's code. */
const mirrorOf = (worker) => [worker[AT.known] ? 1 : 0, worker[AT.mhold], worker[AT.det] ? 1 : 0, worker[AT.dwp] ? 1 : 0, worker[AT.unreached] ? 1 : 0, worker[AT.install]];

/** The named trace's form and cause at a state, restating NamedForm and NamedCause of WorkerHoldTable.tla. The export holds this restatement to TLC's own lines. */
function namedAt(code) {
  const [gphase, , glost, port, workers] = code;
  const worker = workers[0];
  if ((gphase !== "draining" && gphase !== "waiting-trees") || !worker[AT.ranuF] || worker[AT.det] || glost || worker[AT.mhold] === "late") return null;
  const form = { held: "held", reaching: "reaching", none: "second-pass" }[worker[AT.formState]];
  if (form === undefined) return null;
  const late = port.find(([item]) => item === "late");
  const cause =
    late !== undefined
      ? late[2]
        ? "late-posted-before-the-freeze"
        : "late-posted-after-the-freeze"
      : worker[AT.events].some(([event]) => event === "resumed")
        ? "resume-still-on-the-socket"
        : port.some(([item]) => item === "lost")
          ? "connection-lost-on-the-port"
          : worker[AT.conc]
            ? "thread-concluded-first"
            : "no-word-on-its-way";
  return `${form}:${cause}`;
}

/** The smallest of a list of sets of switches: a set is dropped when another is inside it. */
function smallest(masks) {
  const unique = [...new Set(masks)].sort((x, y) => x - y);
  return unique.filter((mask) => !unique.some((other) => other !== mask && (other & mask) === other)).map(namesOf);
}

async function exportWorld(tools, world, fv, kernels) {
  const started = Date.now();
  // The graph, as TLC prints it: a state's line, then each move's label and the state it leaves.
  const ids = new Map();
  const out = [[]];
  const codeOf = [null];
  const landing = [null];
  const labelIds = new Map();
  const labels = [];
  const lineCache = new Map();
  const idOf = (text) => {
    const key = createHash("sha1").update(text).digest("base64");
    let id = ids.get(key);
    if (id === undefined) {
      id = ids.size;
      ids.set(key, id);
      if (id > 0) {
        out.push([]);
        codeOf.push(null);
        landing.push(null);
      }
    }
    return id;
  };
  let current = -1;
  let pending = null;
  let printedStates = 0;
  let printedMoves = 0;
  const exported = await runTlc({
    ...tools,
    workers: 1,
    specDir: SPEC_DIR,
    module: "WorkerHoldExport",
    name: `export-${world}`,
    config: configuration(world, [], "Init", "Next", ["StateLines"]),
    onLine(line) {
      const kind = line[5];
      if (kind === "S") {
        current = idOf(line.slice(9));
        // The mirror, the landing and the named trace are read from few states, so a state keeps only what those need.
        const code = tupleLine(line)[1];
        codeOf[current] = { mirror: code[4].map(mirrorOf), named: namedAt(code), done: code[0] === "done" };
        printedStates += 1;
      } else if (kind === "L") {
        pending = lineCache.get(line);
        if (pending === undefined) {
          const [, steps, blocked] = parseTlaValue(JSON.parse(line));
          const text = specLabel(steps, []).slice(0, -2);
          let label = labelIds.get(text);
          if (label === undefined) {
            label = labels.length;
            labels.push(text);
            labelIds.set(text, label);
          }
          pending = [label, maskOf(blocked.set)];
          lineCache.set(line, pending);
        }
      } else if (kind === "N") {
        out[current].push([pending[0], pending[1], idOf(line.slice(9))]);
        printedMoves += 1;
      } else if (kind === "D") {
        const [, worker, term, readSeq, ranAtFreeze, ranUnobservedAtFreeze, ranUnobserved, attacherLives, realmAtFreeze] = tupleLine(line);
        landing[current] ??= [];
        landing[current][worker] = [term, readSeq, ranAtFreeze, ranUnobservedAtFreeze, ranUnobserved, attacherLives, realmAtFreeze];
      } else throw new Error(`An export line of a kind this script does not know: ${line.slice(0, 120)}`);
    }
  });
  if (!exported.clean || exported.distinct !== printedStates || exported.generated !== printedMoves + 1 || ids.size !== printedStates) {
    throw new Error(`TLC's counts on ${world} (${JSON.stringify(exported)}) are not the printed graph's: ${printedStates} states, ${printedMoves} moves, ${ids.size} named`);
  }

  // The same graph with the labels the digest reads, beside the hand-written model's.
  const landedOf = ([term, readSeq, ranAtFreeze, ranUnobservedAtFreeze, ranUnobserved, attacherLives, realmAtFreeze]) => ({ term, readSeq, ranAtFreeze: ranAtFreeze === 1, ranUnobservedAtFreeze: ranUnobservedAtFreeze === 1, ranUnobserved: ranUnobserved === 1, attacherLives: attacherLives === 1, realmAtFreeze });
  const graph = newGraph();
  for (let node = 1; node < out.length; node += 1) graph.node();
  out.forEach((moves, node) => {
    for (const [label, mask, to] of moves) graph.edge(node, `${labels[label]} /${namesOf(mask).sort().join(",")}`, to);
    if (landing[node] !== null) landing[node].forEach((landed, worker) => graph.edge(node, landedLabel(worker, landedOf(landed)), graph.sink()));
  });
  const specDigests = digests(graph);
  const model = new fv.SharedWorkerModel(fv[WORLDS[world].model], kernels);
  const explored = model.explore();
  const byHand = modelGraph(fv, model, explored);
  const handDigests = digests(byHand);
  const difference = firstDifference(graph, byHand, specDigests, handDigests);
  if (difference !== null) {
    throw new Error(`The specification and the hand-written model part in the ${world} world, after:\n  ${difference.path.join("\n  ")}\nonly the specification takes: ${JSON.stringify(difference.onlyLeft)}\nonly the model takes: ${JSON.stringify(difference.onlyRight)}`);
  }
  const counted = summary(graph, specDigests);

  // Breadth first under a set of switches, moves in the order TLC printed them.
  const under = (assumed) => {
    const mask = maskOf(assumed);
    const parent = new Int32Array(out.length).fill(-1);
    const parentMove = new Int32Array(out.length).fill(-1);
    const seen = new Uint8Array(out.length);
    const order = [0];
    seen[0] = 1;
    for (let at = 0; at < order.length; at += 1) {
      out[order[at]].forEach(([, blocked, to], move) => {
        if ((blocked & mask) !== 0 || seen[to] === 1) return;
        seen[to] = 1;
        parent[to] = order[at];
        parentMove[to] = move;
        order.push(to);
      });
    }
    const pathTo = (node) => {
      const path = [];
      for (let at = node; parent[at] >= 0; at = parent[at]) path.push([out[parent[at]][parentMove[at]][0], at]);
      return path.reverse();
    };
    return { mask, order, pathTo };
  };

  // The traces, kept as one tree: a node is the state a label leaves from its parent's state, with what the replay
  // holds the real mirror to there, and at the end of a readout what each worker landed as.
  const tree = [[-1, -1, codeOf[0].mirror]];
  const nodeOf = new Map();
  const leafOf = (path) => {
    let node = 0;
    for (const [label, state] of path) {
      const key = `${node}:${label}:${state}`;
      if (!nodeOf.has(key)) {
        nodeOf.set(key, tree.length);
        tree.push(landing[state] === null ? [node, label, codeOf[state].mirror] : [node, label, codeOf[state].mirror, landing[state]]);
      }
      node = nodeOf.get(key);
    }
    return node;
  };

  // One trace for every label the world takes under the plan's axioms with C1 and D1, which is what the suite's own
  // replay through both sides assumes.
  const whole = under(WITH_C1_D1);
  const witnessOf = new Map();
  for (const state of whole.order) {
    for (const [label, blocked, to] of out[state]) if ((blocked & whole.mask) === 0 && !witnessOf.has(label)) witnessOf.set(label, [state, to]);
  }
  const covered = new Set();
  const cover = [];
  for (const [label, [state, to]] of [...witnessOf.entries()].reverse()) {
    if (covered.has(label)) continue;
    const path = [...whole.pathTo(state), [label, to]];
    for (const [taken] of path) covered.add(taken);
    cover.push(leafOf(path));
  }

  // One trace that breaks each row the register says fails, under the set it names: the first TLC printed, breadth first.
  const breaks = (state, row) => landing[state] !== null && landing[state].some((landed) => fv.judged({ ...landedOf(landed), movedFromAt11: "no" }).includes(row));
  const witnesses = [];
  for (const { assumed, fails } of CELLS[world]) {
    const reach = under(assumed);
    for (const row of fails) {
      const state = reach.order.find((candidate) => breaks(candidate, row));
      if (state === undefined) throw new Error(`Nothing breaks ${row} in the ${world} world under ${assumed.join()}, where the register says it fails`);
      witnesses.push({ row, assumed, leaf: leafOf(reach.pathTo(state)) });
    }
  }

  // The named trace, by each form and cause, on the step that ends the readout and excludes the worker.
  const named = [];
  const namedForms = {};
  if (world === "hold") {
    for (const assumed of NAMED_UNDER) {
      const reach = under(assumed);
      const found = new Map();
      for (const state of reach.order) {
        if (codeOf[state].named === null) continue;
        for (const [label, blocked, to] of out[state]) {
          if ((blocked & reach.mask) !== 0 || landing[to] === null || landing[to][0][0] !== "pausedAtReadout" || found.has(codeOf[state].named)) continue;
          found.set(codeOf[state].named, [...reach.pathTo(state), [label, to]]);
        }
      }
      namedForms[assumed.join(",")] = [...found.keys()].sort();
      if (assumed === WITH_C1_D1 || assumed === NAMED_UNDER[0]) for (const [form, path] of found) named.push({ form, assumed, leaf: leafOf(path) });
    }
  }

  // The table: every pair of a state and the switches a path to it broke.
  const broken = Object.fromEntries(EVERY_ROW.map((row) => [row, []]));
  const namedBroken = {};
  const seenLines = new Set();
  const table = await runTlc({
    ...tools,
    specDir: SPEC_DIR,
    module: "WorkerHoldTable",
    name: `table-${world}`,
    config: configuration(world, [], "TableInit", "TableNext", ["TableLines"]),
    onLine(line) {
      if (seenLines.has(line)) return;
      seenLines.add(line);
      const value = parseTlaValue(JSON.parse(line));
      if (value[0] === "V") broken[value[1]].push(maskOf(value[2].set));
      else if (value[0] === "T") (namedBroken[`${value[1]}:${value[2]}`] ??= []).push(maskOf(value[3].set));
      else throw new Error(`A table line of a kind this script does not know: ${line.slice(0, 120)}`);
    }
  });
  if (!table.clean) throw new Error(`TLC did not finish the table of the ${world} world clean`);
  const violations = Object.fromEntries(EVERY_ROW.map((row) => [row, smallest(broken[row])]));
  const namedSets = Object.fromEntries(Object.keys(namedBroken).sort().map((form) => [form, smallest(namedBroken[form])]));
  const failsUnder = (sets, assumed) => sets.some((used) => used.every((name) => !assumed.includes(name)));
  // The restated named trace above, held to TLC's own word on each set the register reads.
  for (const [key, forms] of Object.entries(namedForms)) {
    const byTlc = Object.keys(namedSets).filter((form) => failsUnder(namedSets[form], key.split(","))).sort();
    if (JSON.stringify(byTlc) !== JSON.stringify(forms)) throw new Error(`Under ${key} TLC finds the named trace as ${JSON.stringify(byTlc)}, and this script's reading of the printed graph as ${JSON.stringify(forms)}`);
  }

  // TLC's own verdict on each row, as an invariant, under each set of switches the register names.
  const cells = [];
  for (const { assumed, holds, fails } of CELLS[world]) {
    const cell = { assumed, holds, fails, distinct: null };
    if (holds.length > 0) {
      const run = await runTlc({ ...tools, specDir: SPEC_DIR, module: "WorkerHold", name: `cell-${world}-${cells.length}`, config: configuration(world, assumed, "Init", "Next", holds.map((row) => ROWS[row])) });
      if (!run.clean) throw new Error(`In the ${world} world under ${assumed.join()} TLC reports ${run.violated} violated, where the register says it holds`);
      cell.distinct = run.distinct;
    }
    for (const row of fails) {
      const run = await runTlc({ ...tools, specDir: SPEC_DIR, module: "WorkerHold", name: `cell-${world}-${cells.length}-${ROWS[row]}`, config: configuration(world, assumed, "Init", "Next", [ROWS[row]]) });
      if (run.violated !== ROWS[row]) throw new Error(`In the ${world} world under ${assumed.join()} TLC does not report ${ROWS[row]} violated, where the register says it fails`);
    }
    for (const row of [...holds, ...fails]) {
      if (failsUnder(violations[row], assumed) !== fails.includes(row)) throw new Error(`The table and TLC's own run disagree on ${row} in the ${world} world under ${assumed.join()}`);
    }
    cells.push(cell);
  }

  // The committed configuration of this world under the plan's axioms, as it stands, so that a run by hand has a
  // run on record to be compared with.
  const planText = readFileSync(join(SPEC_DIR, `${world}-plan.cfg`), "utf8");
  const planRun = await runTlc({ ...tools, specDir: SPEC_DIR, module: "WorkerHold", name: `plan-${world}`, config: planText });
  if (!planRun.clean) throw new Error(`TLC reports ${planRun.violated} violated under ${world}-plan.cfg`);
  const underPlan = { configuration: `${world}-plan.cfg`, sha256: sha256Of(planText), invariants: planText.slice(planText.indexOf("\nINVARIANTS\n") + "\nINVARIANTS\n".length).trim().split(/\s+/), tlc: { distinct: planRun.distinct, generated: planRun.generated, depth: planRun.depth } };

  console.error(`${world}: ${printedStates} states, ${printedMoves} moves, ${counted.classes} classes, ${cover.length + witnesses.length + named.length} traces as ${tree.length} nodes, table over ${table.distinct} pairs, ${Math.round((Date.now() - started) / 1000)}s`);
  return {
    constants: WORLDS[world].constants,
    tlc: { distinct: exported.distinct, generated: exported.generated, depth: exported.depth },
    digest: counted.digest,
    classes: counted.classes,
    model: { states: explored.keys.length, moves: explored.edgeTo.length },
    underPlan,
    table: { pairs: table.distinct, violations, named: namedSets },
    cells,
    labels,
    traces: { coverLabels: witnessOf.size, cover, witnesses, named },
    tree
  };
}

async function main() {
  const tools = pinnedTools();
  const check = process.argv.includes("--check");
  const worldNames = (option("--worlds") ?? Object.keys(WORLDS).join(",")).split(",");
  const require = createRequire(join(ROOT, "package.json"));
  const dist = join(ROOT, ".unit-test-dist", "lib");
  if (!existsSync(join(dist, "fv-worker-model.js"))) throw new Error("Compile the library first: npx tsc -p tsconfig.test.json");
  const fv = require(join(dist, "fv-worker-model.js"));
  const kernels = require(join(dist, "worker-fingerprint-realm.js"));
  const scratch = mkdtempSync(join(tmpdir(), "tla-worker-hold-"));
  // The files as they are before TLC reads them: a file edited while TLC runs would leave an export that names the
  // edited file and was made from the other.
  const specification = () => Object.fromEntries(SPEC_FILES.map((file) => [file, sha256Of(readFileSync(join(SPEC_DIR, file)))]));
  const before = specification();
  try {
    const previous = existsSync(OUTPUT) ? JSON.parse(readFileSync(OUTPUT, "utf8")) : { worlds: {} };
    const worlds = {};
    for (const world of Object.keys(WORLDS)) {
      // A world not asked for keeps what the committed file holds, if that was exported from these same files; the suite
      // fails on a file with a world missing.
      if (!worldNames.includes(world)) {
        if (previous.worlds[world] !== undefined) {
          if (JSON.stringify(previous.specification) !== JSON.stringify(before)) throw new Error(`${world} was exported from another specification: export every world`);
          worlds[world] = previous.worlds[world];
        }
        continue;
      }
      worlds[world] = await exportWorld({ java: tools.java, jar: tools.jar, scratch, workers: Number(option("--workers") ?? "2") }, world, fv, kernels);
    }
    const result = {
      format: 1,
      about: "Exported by scripts/tla-worker-hold-export.mjs from specs/worker-hold with TLC. Do not edit by hand.",
      specification: before,
      tla2tools: tools.pins.tla2tools.sha256,
      worlds
    };
    if (JSON.stringify(specification()) !== JSON.stringify(before)) throw new Error("A specification file changed while TLC was running: nothing was written");
    const text = `${layout(result)}\n`;
    if (check) {
      const committed = existsSync(OUTPUT) ? readFileSync(OUTPUT, "utf8") : "";
      if (committed !== text) throw new Error("specs/worker-hold/conformance.json differs from what TLC exports now. Run this script without --check and review the difference.");
      console.error("specs/worker-hold/conformance.json is what TLC exports now.");
    } else {
      writeFileSync(OUTPUT, text);
      pinArtifact("specs/worker-hold/conformance.json", text);
      console.error(`Wrote ${OUTPUT} (${text.length} bytes) and its digest in specs/tla-tools.json.`);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && process.argv[1].endsWith("tla-worker-hold-export.mjs")) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
