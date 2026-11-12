#!/usr/bin/env node

// Seeds faults in the TLA+ specification of the shared-worker hold and holds TLC to catching each
// by the row named beside it, under a set of switches where the specification as committed keeps
// that row. It needs Java and the pinned jar, so it is not a CI stage: it is the evidence that
// the rows can fail under the sets the register says they hold under.
//
// Each fault is one edit of specs/worker-hold/WorkerHold.tla, in a scratch copy, that must land
// exactly once. A fault TLC passes, an edit that no longer lands, a specification that no longer
// parses, or a committed specification that does not keep the row there, fails this script.
//
// Usage: node scripts/tla-worker-hold-mutations.mjs --jar <tla2tools.jar> [--java <java>] [--worlds a,b]

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { option, pinnedTools, ROOT, runTlc } from "./tla-tools-lib.mjs";
import { WORLDS } from "./tla-worker-hold-lib.mjs";

const SPEC_DIR = join(ROOT, "specs", "worker-hold");

// A fault that is not here because no row tells it from the committed specification: landing a worker that discovery
// found, and the mirror never heard of, nowhere and not as unattached. Under D1 (and under Z) no such worker ran before
// the freeze with the attacher alive, so the no-term row holds either way.

/** [what the fault is, the invariant that must catch it, the world, the switches assumed, the text to find, its replacement] */
export const MUTATIONS = [
  [
    "the thread makes nothing of a resume while it holds a worker",
    "ReadHadItsObserver",
    "hold",
    ["A1", "A2"],
    '       [] e = "resumed" -> IF inMap THEN BreakHold(X, w, earlier) ELSE X',
    '       [] e = "resumed" -> X'
  ],
  [
    "a worker the mirror calls late at the freeze is excluded as held",
    "ExcludedRanNothing",
    "hold",
    ["A5fifo", "Z"],
    '  ELSE IF k.mhold = "late" THEN F("unread", "attachedLate")\n  ELSE IF k.mhold = "pending" THEN (IF k.det THEN GoneUnpaused(k) ELSE F("reaching", ""))',
    '  ELSE IF k.mhold = "late" THEN F("excluded", "pausedAtReadout")\n  ELSE IF k.mhold = "pending" THEN (IF k.det THEN GoneUnpaused(k) ELSE F("reaching", ""))'
  ],
  [
    "a worker the mirror calls late at the freeze is excluded as held",
    "ExcludedRanNothingUnobserved",
    "hold",
    ["A5fifo", "Z"],
    '  ELSE IF k.mhold = "late" THEN F("unread", "attachedLate")\n  ELSE IF k.mhold = "pending" THEN (IF k.det THEN GoneUnpaused(k) ELSE F("reaching", ""))',
    '  ELSE IF k.mhold = "late" THEN F("excluded", "pausedAtReadout")\n  ELSE IF k.mhold = "pending" THEN (IF k.det THEN GoneUnpaused(k) ELSE F("reaching", ""))'
  ],
  [
    "a barrier's answer reads the last closed snapshot though a task is open",
    "ReadNoOlderThanTheFreeze",
    "stream",
    ["A1", "notA3", "A5fifo"],
    '     ELSE IF k.mword = "closed" /\\ k.mclosed # 0\n          THEN [S EXCEPT !.wk[w].answered = TRUE, !.wk[w].snapshot = k.mclosed]',
    "     ELSE IF k.mclosed # 0\n          THEN [S EXCEPT !.wk[w].answered = TRUE, !.wk[w].snapshot = k.mclosed]"
  ],
  [
    "a worker gone at the freeze with a closed last word is read at its first snapshot",
    "ReadNoOlderThanTheFreeze",
    "stream",
    ["A1", "notA3", "A5fifo"],
    '  IN IF form.st = "closed" THEN [S EXCEPT !.wk[w].form = F("closed", ""), !.wk[w].snapshot = k.mclosed]',
    '  IN IF form.st = "closed" THEN [S EXCEPT !.wk[w].form = F("closed", ""), !.wk[w].snapshot = 1]'
  ],
  [
    "a stream with no whole state for the freeze is read all the same",
    "ReadNoOlderThanTheFreeze",
    "stream",
    ["A1", "notA3", "A5fifo"],
    "                 IF k.snapshot = 0\n                 THEN [term |->",
    "                 IF FALSE\n                 THEN [term |->"
  ],
  [
    "a worker still reaching at the drain's end lands in no named term",
    "HeardLandsInOneTerm",
    "small",
    [],
    '            [] r.st = "reaching" -> [term |-> "unreached", readSeq |-> 0]',
    '            [] r.st = "reaching" -> [term |-> "reaching", readSeq |-> 0]'
  ],
  [
    "the frame tree answers ahead of an attach still on its way at the freeze",
    "RanLandsInATerm",
    "hold",
    ["D1"],
    "NewsFromBeforeTheFreeze(S) == \\E w \\in W : InFlightAtFreeze(S.wk[w]) \\/ SomeBefore(S.wk[w])",
    "NewsFromBeforeTheFreeze(S) == \\E w \\in W : SomeBefore(S.wk[w])"
  ]
];

const tlaSet = (names) => `{${names.map((name) => `"${name}"`).join(", ")}}`;

function configuration(world, assumed, invariant) {
  const constants = Object.entries(WORLDS[world].constants).map(([name, value]) => `  ${name} = ${typeof value === "boolean" ? String(value).toUpperCase() : value}`);
  return `${["CONSTANTS", ...constants, `  Assumed = ${tlaSet(assumed)}`, "INIT Init", "NEXT Next", "INVARIANTS", `  ${invariant}`].join("\n")}\n`;
}

async function main() {
  const { jar, java } = pinnedTools();
  const worlds = (option("--worlds") ?? Object.keys(WORLDS).join(",")).split(",");
  const mutations = MUTATIONS.filter(([, , world]) => worlds.includes(world));
  const source = readFileSync(join(SPEC_DIR, "WorkerHold.tla"), "utf8");
  const scratch = mkdtempSync(join(tmpdir(), "tla-worker-hold-mutations-"));
  let failed = 0;
  try {
    const run = (text, name, world, assumed, invariant) => {
      writeFileSync(join(scratch, "WorkerHold.tla"), text);
      return runTlc({ java, jar, scratch, specDir: scratch, module: "WorkerHold", name, config: configuration(world, assumed, invariant), workers: 2 });
    };
    // The specification as committed keeps each row under its set, so a violation below is the fault's.
    const kept = new Set();
    for (const [, invariant, world, assumed] of mutations) {
      const key = `${invariant} ${world} ${assumed.join()}`;
      if (kept.has(key)) continue;
      kept.add(key);
      const clean = await run(source, `clean-${kept.size}`, world, assumed, invariant);
      if (!clean.clean) {
        failed += 1;
        console.log(`FAILED  the committed specification does not keep ${invariant} in the ${world} world under ${assumed.join() || "nothing"}`);
      }
    }
    for (const [at, [what, invariant, world, assumed, find, replace]] of mutations.entries()) {
      const occurrences = source.split(find).length - 1;
      if (occurrences !== 1) {
        failed += 1;
        console.log(`FAILED  ${what}: its edit lands ${occurrences} times`);
        continue;
      }
      let result;
      try {
        result = await run(source.replace(find, () => replace), `mutation-${at}`, world, assumed, invariant);
      } catch (error) {
        failed += 1;
        console.log(`FAILED  ${what}: ${String(error instanceof Error ? error.message : error).split("\n").slice(0, 6).join(" | ")}`);
        continue;
      }
      const caught = result.violated === invariant;
      if (!caught) failed += 1;
      console.log(`${caught ? "caught " : "FAILED "} ${invariant.padEnd(30)} ${world.padEnd(7)} under ${(assumed.join(",") || "nothing").padEnd(16)} ${what}`);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  console.log(`${mutations.length - failed} of ${mutations.length} faults caught by the row named for each.`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
