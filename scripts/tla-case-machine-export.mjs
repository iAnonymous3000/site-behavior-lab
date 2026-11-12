#!/usr/bin/env node

// Regenerates specs/case-machine/conformance.json from the TLA+ specification, with TLC.
//
// CI has no Java, so the conformance suite (scripts/tla-case-machine-conformance.test.mjs)
// reads that file and never runs TLC. This script is the other half: it runs TLC on
// specs/case-machine/CaseMachineExport.tla for each plan, under that plan's committed
// configuration, so the same run holds every invariant the configuration lists on every
// state; a run TLC does not finish clean writes nothing. It reads every state TLC reaches
// with the events it accepts and the states they leave, and writes what the suite needs:
// each plan's alphabet, its counts, an order-free digest of its whole transition relation,
// one transition of every class on traces from the planned state, kept as a tree, the authority probes,
// and the purge reducer's table. With --check it writes nothing and fails on any byte that
// differs from the committed file.
//
// While it has TLC's lines in hand it also holds the real machine to each of them, state
// by state: the real step's answer to every event of the alphabet, and the real views, on
// every state TLC reached. That comparison needs the compiled workspace:
//   npx tsc -p tsconfig.investigation-test.json
//
// Usage:
//   node scripts/tla-case-machine-export.mjs --jar <tla2tools.jar> [--java <java>] [--check] [--plans a,b] [--workers n]
// The jar must be the one specs/tla-tools.json pins, by its SHA-256.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindReal, CAPS, packCode, parseExportLine, PLAN_OPERATORS, PLANS, relationDigest, sha256Hex, stateLine, transitionClass } from "./tla-case-machine-lib.mjs";
import { layout, pinArtifact, pinnedTools, option, ROOT, runTlc, tupleLine } from "./tla-tools-lib.mjs";

const SPEC_DIR = join(ROOT, "specs", "case-machine");
const SPEC_FILES = ["CaseMachine.tla", "CaseMachineMC.tla", "CaseMachineExport.tla", "PurgeSlice.tla"];
const OUTPUT = join(SPEC_DIR, "conformance.json");
/** The plans whose traces are kept. The others are held by their digest alone. */
const TRACE_PLANS = new Set(["six-slots", "two-each", "one-each"]);

/**
 * A plan's committed configuration, with the export's first state and its line added: TLC then holds every invariant
 * the committed file lists, on every state, in the run that prints the relation.
 */
function exportConfiguration(planName) {
  const committed = readFileSync(join(SPEC_DIR, `${planName}.cfg`), "utf8");
  if (!committed.includes("\nINIT Init\n") || !committed.includes(`Plan <- ${PLAN_OPERATORS[planName]}\n`) || !/\nINVARIANTS\n(  \w+\n)+$/.test(committed)) throw new Error(`${planName}.cfg is not laid out as this script reads it`);
  const invariants = committed.slice(committed.indexOf("\nINVARIANTS\n") + "\nINVARIANTS\n".length).trim().split(/\s+/);
  return { text: `${committed.replace("\nINIT Init\n", "\nINIT ExportInit\n")}  StateLine\n`, invariants, sha256: sha256Hex(committed) };
}

/** The purge table needs no walk: one first state that prints it, and a next-state relation that goes nowhere. */
function purgeTableConfiguration() {
  return `${["CONSTANTS", `  Plan <- ${PLAN_OPERATORS["one-each"]}`, ...Object.entries(CAPS).map(([name, value]) => `  ${name} = ${value}`), '  HeldManifests = "two"', "INIT PurgeInit", "NEXT Stutter"].join("\n")}\n`;
}

const maskOf = (accepted, size) => {
  let mask = 0n;
  for (const [index] of accepted) mask |= 1n << BigInt(index - 1);
  return mask.toString(16).padStart(Math.ceil(size / 4), "0");
};

async function exportPlan(tools, planName, real) {
  const planSlots = PLANS[planName];
  const keepGraph = TRACE_PLANS.has(planName);
  const alphabet = [];
  const probes = [];
  let first = null;
  let header = null;
  let events = null;
  const digest = relationDigest();
  // The graph, for the traces: each code's id, and each state's accepted events in the alphabet's order.
  const idOf = new Map();
  const codes = [];
  const viewsOf = [];
  const acceptedOf = [];
  const idFor = (code) => {
    let id = idOf.get(code);
    if (id === undefined) {
      id = codes.length;
      idOf.set(code, id);
      codes.push(code);
    }
    return id;
  };
  let compared = 0;
  const differences = [];

  const checked = exportConfiguration(planName);
  const summary = await runTlc({
    ...tools,
    specDir: SPEC_DIR,
    module: "CaseMachineExport",
    name: `export-${planName}`,
    config: checked.text,
    onLine(line) {
      if (line.startsWith('"<<\\"S\\"')) {
        const [, rawCode, rawViews, rawAccepted] = tupleLine(line);
        const code = packCode(rawCode);
        const views = packCode(rawViews);
        const accepted = rawAccepted.map(([index, next]) => [index, packCode(next)]).sort((left, right) => left[0] - right[0]);
        const specLine = stateLine(code, views, accepted);
        digest.add(specLine, accepted.length);
        if (keepGraph) {
          const id = idFor(code);
          viewsOf[id] = views;
          acceptedOf[id] = accepted.map(([index, next]) => [index, idFor(next)]);
        }
        // The real machine, on this state, against every event of the alphabet.
        if (events === null) events = alphabet.map(real.eventOf);
        const state = real.decode(code);
        const realAccepted = [];
        for (let index = 0; index < events.length; index += 1) {
          const answer = real.machine.step(state, events[index]);
          if (answer.ok) realAccepted.push([index + 1, real.encode(answer.state)]);
        }
        const realLine = stateLine(real.encode(state), real.views(state), realAccepted);
        compared += 1;
        if (realLine !== specLine && differences.length < 10) differences.push({ specification: specLine, real: realLine });
        return;
      }
      const value = parseExportLine(line);
      if (value[0] === "P") header = { slots: value[1], caps: value.slice(2) };
      else if (value[0] === "A") alphabet[value[1] - 1] = value[2];
      else if (value[0] === "I") first = packCode(value[1]);
      else if (value[0] === "B") probes.push(value[1]);
      else throw new Error(`An export line of a kind this script does not know: ${line.slice(0, 120)}`);
    }
  });

  if (!summary.clean) throw new Error(`TLC reported ${String(summary.violated)} violated on the export of ${planName}`);
  const counted = digest.result();
  if (header === null || JSON.stringify(header.slots) !== JSON.stringify(planSlots) || JSON.stringify(header.caps) !== JSON.stringify(Object.values(CAPS))) throw new Error(`TLC walked another plan or other caps than ${planName}'s`);
  if (first === null || alphabet.length === 0 || alphabet.includes(undefined)) throw new Error(`TLC printed no first state or a broken alphabet for ${planName}`);
  if (summary.distinct !== counted.states) throw new Error(`TLC found ${summary.distinct} distinct states on ${planName} and printed ${counted.states}`);
  if (summary.generated !== counted.edges + 1) throw new Error(`TLC generated ${summary.generated} states on ${planName}, where the printed transitions and the first state make ${counted.edges + 1}`);
  if (differences.length > 0 || compared !== counted.states) {
    throw new Error(`The real machine differs from the specification on ${planName}, first at:\n${JSON.stringify(differences, null, 2)}`);
  }

  // Each probe as its body and who sent it; the suite sends each body from each of these actors.
  const probeBodies = new Map();
  for (const probe of probes) {
    const { by, ...body } = probe;
    const key = JSON.stringify(body);
    if (!probeBodies.has(key)) probeBodies.set(key, { body, refusedFrom: [] });
    probeBodies.get(key).refusedFrom.push(by.kind === "owner" ? "owner" : by.of);
  }
  for (const entry of probeBodies.values()) entry.refusedFrom.sort();

  const plan = {
    slots: planSlots,
    alphabet,
    first,
    states: counted.states,
    edges: counted.edges,
    digest: counted.digest,
    tlc: { generated: summary.generated, distinct: summary.distinct, depth: summary.depth },
    // The configuration this run was made under, and the invariants TLC held on every state in it.
    checked: { configuration: `${planName}.cfg`, sha256: checked.sha256, invariants: checked.invariants },
    comparedWithReal: compared,
    probes: [...probeBodies.values()]
  };

  if (keepGraph) {
    // Breadth first from the first state, events in the alphabet's order, so the traces do not depend on the order TLC printed in.
    const firstId = idOf.get(first);
    const parent = new Int32Array(codes.length).fill(-1);
    const parentEvent = new Uint8Array(codes.length);
    const order = [firstId];
    const reached = new Uint8Array(codes.length);
    reached[firstId] = 1;
    const witness = new Map();
    for (let at = 0; at < order.length; at += 1) {
      const id = order[at];
      for (const [index, next] of acceptedOf[id]) {
        const kind = transitionClass(planSlots, alphabet[index - 1], codes[id], codes[next]);
        if (!witness.has(kind)) witness.set(kind, [id, index, next]);
        if (reached[next] === 0) {
          reached[next] = 1;
          parent[next] = id;
          parentEvent[next] = index;
          order.push(next);
        }
      }
    }
    if (order.length !== counted.states) throw new Error(`The traces' search reached ${order.length} of ${counted.states} states on ${planName}`);
    const pathTo = (id) => {
      const steps = [];
      for (let at = id; parent[at] >= 0; at = parent[at]) steps.push([parentEvent[at], at]);
      return steps.reverse();
    };
    const describe = (id) => [codes[id], viewsOf[id], maskOf(acceptedOf[id], alphabet.length)];
    // The traces share their first steps, so they are kept as one tree: a node is the state an event leaves from its
    // parent's state, and each path from the root is a trace TLC's relation holds. Node 0 is the planned state.
    const tree = [[-1, 0, ...describe(firstId)]];
    const nodeOf = new Map();
    const covered = new Set();
    let traces = 0;
    for (const [kind, [id, index, next]] of witness.entries()) {
      if (covered.has(kind)) continue;
      traces += 1;
      let node = 0;
      let before = firstId;
      for (const [stepIndex, after] of [...pathTo(id), [index, next]]) {
        covered.add(transitionClass(planSlots, alphabet[stepIndex - 1], codes[before], codes[after]));
        const key = `${node}:${stepIndex}`;
        if (!nodeOf.has(key)) {
          nodeOf.set(key, tree.length);
          tree.push([node, stepIndex, ...describe(after)]);
        }
        node = nodeOf.get(key);
        before = after;
      }
    }
    plan.classes = [...witness.keys()].sort();
    plan.traces = traces;
    plan.tree = tree;
  }
  return plan;
}

/**
 * The purge reducer's table as short rows, "closed|manifest|event|answer|tier": a manifest is "-" when none is
 * recorded, else its paths in order with each one's status (p present, a absent, r remains); an event is M with the
 * paths a manifest lists, or A or R with the path read absent or remaining; an answer is = with the manifest left, or
 * ! with the refusal; the tier is S for SUMMARY_ONLY and R for RAW_HELD. Path 0 is the one no manifest lists.
 */
async function exportPurge(tools) {
  const rows = [];
  const pathDigit = (path) => path.slice(1);
  const manifestText = (manifest) => (manifest.recorded ? manifest.entries.map(({ path, status }) => `${pathDigit(path)}${status[0]}`).join(",") : "-");
  const eventLetter = { "purge-manifest-recorded": "M", "purge-path-absent": "A", "purge-path-remains": "R" };
  const summary = await runTlc({
    ...tools,
    specDir: SPEC_DIR,
    module: "CaseMachineExport",
    name: "export-purge",
    config: purgeTableConfiguration(),
    onLine(line) {
      const value = parseExportLine(line);
      if (value[0] !== "U") throw new Error(`An export line of a kind the purge table does not hold: ${line.slice(0, 120)}`);
      const [, closed, manifest, event, answer, tier] = value;
      const named = "paths" in event ? event.paths.map(pathDigit).join(",") : pathDigit(event.path);
      rows.push([closed, manifestText(manifest), `${eventLetter[event.type]}:${named}`, answer.ok ? `=${manifestText(answer.manifest)}` : `!${answer.refusal}`, tier === "SUMMARY_ONLY" ? "S" : "R"].join("|"));
    }
  });
  if (!summary.clean) throw new Error("TLC did not finish clean on the purge table");
  // The slice itself, under its committed configuration: every state the purge events reach, held to its invariants.
  const sliceText = readFileSync(join(SPEC_DIR, "purge-slice.cfg"), "utf8");
  const slice = await runTlc({ ...tools, specDir: SPEC_DIR, module: "PurgeSlice", name: "purge-slice", config: sliceText });
  if (!slice.clean) throw new Error(`TLC reported ${String(slice.violated)} violated on the purge slice`);
  return {
    rows: rows.sort(),
    slice: { configuration: "purge-slice.cfg", sha256: sha256Hex(sliceText), invariants: sliceText.slice(sliceText.indexOf("\nINVARIANTS\n") + "\nINVARIANTS\n".length).trim().split(/\s+/), tlc: { generated: slice.generated, distinct: slice.distinct, depth: slice.depth } }
  };
}

async function main() {
  const { jar, java, pins } = pinnedTools();
  const check = process.argv.includes("--check");
  const planNames = (option("--plans") ?? Object.keys(PLANS).join(",")).split(",");

  const require = createRequire(join(ROOT, "package.json"));
  const dist = join(ROOT, ".investigation-test-dist", "investigation");
  if (!existsSync(join(dist, "core", "case-machine.js"))) throw new Error("Compile the workspace first: npx tsc -p tsconfig.investigation-test.json");
  const machine = require(join(dist, "core", "case-machine.js"));
  const fixture = require(join(dist, "test", "case-fixture.js"));

  const scratch = mkdtempSync(join(tmpdir(), "tla-case-machine-"));
  try {
    const tools = { java, jar, scratch, workers: Number(option("--workers") ?? "2"), heap: "3g" };
    // The files as they are before TLC reads them: a file edited while TLC runs would leave an export that names the
    // edited file and was made from the other.
    const specification = () => Object.fromEntries(SPEC_FILES.map((file) => [file, sha256Hex(readFileSync(join(SPEC_DIR, file)))]));
    const before = specification();
    const previous = existsSync(OUTPUT) ? JSON.parse(readFileSync(OUTPUT, "utf8")) : { plans: {} };
    const plans = {};
    for (const planName of Object.keys(PLANS)) {
      if (!planNames.includes(planName)) {
        // A plan not asked for keeps what the committed file holds, if that was exported from these same files; the
        // suite fails on a file with a plan missing.
        if (previous.plans[planName] !== undefined) {
          if (JSON.stringify(previous.specification) !== JSON.stringify(before)) throw new Error(`${planName} was exported from another specification: export every plan`);
          plans[planName] = previous.plans[planName];
        }
        continue;
      }
      const started = Date.now();
      plans[planName] = await exportPlan(tools, planName, { ...bindReal(fixture, machine, PLANS[planName]), machine });
      console.error(`${planName}: ${plans[planName].states} states, ${plans[planName].edges} transitions, ${plans[planName].traces ?? 0} traces as ${plans[planName].tree?.length ?? 0} nodes, ${Math.round((Date.now() - started) / 1000)}s`);
    }
    const purged = await exportPurge(tools);
    const result = {
      format: 1,
      about: "Exported by scripts/tla-case-machine-export.mjs from specs/case-machine with TLC. Do not edit by hand.",
      specification: before,
      tla2tools: pins.tla2tools.sha256,
      caps: CAPS,
      plans,
      purge: purged.rows,
      purgeSlice: purged.slice
    };
    if (JSON.stringify(specification()) !== JSON.stringify(before)) throw new Error("A specification file changed while TLC was running: nothing was written");
    const text = `${layout(result)}\n`;
    if (check) {
      const committed = existsSync(OUTPUT) ? readFileSync(OUTPUT, "utf8") : "";
      if (committed !== text) throw new Error("specs/case-machine/conformance.json differs from what TLC exports now. Run this script without --check and review the difference.");
      console.error("specs/case-machine/conformance.json is what TLC exports now.");
    } else {
      writeFileSync(OUTPUT, text);
      pinArtifact("specs/case-machine/conformance.json", text);
      console.error(`Wrote ${OUTPUT} (${text.length} bytes) and its digest in specs/tla-tools.json.`);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
