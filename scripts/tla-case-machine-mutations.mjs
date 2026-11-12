#!/usr/bin/env node

// Seeds faults in the TLA+ specification of the case machine and holds TLC to catching each by
// the invariant named beside it, with every other invariant off. It needs Java and the pinned
// jar, so it is not a CI stage: it is the evidence that the invariants can fail.
//
// Each fault is one edit of specs/case-machine/CaseMachine.tla (two where one alone changes no
// answer), in a scratch copy, and each edit must land exactly once. TLC then runs on the named plan with that one invariant, and must report
// it violated. A fault TLC passes, an edit that no longer lands, or a specification that no
// longer parses fails this script.
//
// What a caught fault shows is that the invariant can fail. It does not show that the invariant
// is needed: for thirteen of the thirty invariants of CaseMachine.tla every fault here is also
// caught by some other invariant (specs/case-machine/README.md names them).
//
// Most faults edit the machine: a guard of Accepts, a field of After, the purge reducer. Three
// edit a view an invariant reads and not the machine (the last three before the purge slice's),
// because those invariants restate the view in whole or in part; README.md classes each
// invariant. Where such an invariant has a conjunct a machine fault can break, a machine fault is
// listed for it as well. The plan "purge-slice" runs PurgeSlice.tla from its two first states.
//
// Usage: node scripts/tla-case-machine-mutations.mjs --jar <tla2tools.jar> [--java <java>]

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CAPS, PLAN_OPERATORS, sha256Hex } from "./tla-case-machine-lib.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SPEC_DIR = join(ROOT, "specs", "case-machine");

/** [what the fault is, the invariant that must catch it alone, the plan, the text to find, its replacement]; the last two may be lists, edit for edit. */
export const MUTATIONS = [
  ["a guard dropped: a visit starts past unresolved cleanup", "Blocks", "one-each", "         /\\ Unresolved(S) = {}\n         /\\ (ArmOf(e.slot)", "         /\\ (ArmOf(e.slot)"],
  ["two guards dropped: a visit starts while another attempt runs, past its pending cleanup", "OneRuns", "two-each", "         /\\ Running(S) = {}\n         /\\ IsNext(S, e.slot)\n         /\\ Unresolved(S) = {}", "         /\\ IsNext(S, e.slot)"],
  ["a guard dropped: the instrumented arm does not wait for the rule", "Waits", "one-each", "         /\\ (ArmOf(e.slot) = \"instrumented\" /\\ BothArms => S.rule = \"met\")\n", ""],
  ["a guard dropped: a visit needs no control and no exception", "ControlGate", "one-each", "         /\\ (S.met \\/ S.exception = e.slot)\n", ""],
  ["a guard dropped: the configuration changes after the rule is recorded", "Waits", "one-each", "         /\\ ~RuleRecorded(S)\n", ""],
  ["a guard dropped: a control is taken on a closed case", "ClosedStays", "one-each", "         /\\ ~Closed(S) /\\ S.frozen /\\ Running(S) = {}\n         /\\ ~S.met /\\ S.misses < MaxControlMisses", "         /\\ S.frozen /\\ Running(S) = {}\n         /\\ ~S.met /\\ S.misses < MaxControlMisses"],
  ["a guard dropped: the rule is recorded again", "RuleFixed", "one-each", "         /\\ ~Closed(S) /\\ S.rule = \"pending\" /\\ BaselineSettled(S)", "         /\\ ~Closed(S) /\\ S.rule # \"not_applicable\" /\\ BaselineSettled(S)"],
  ["a guard dropped: a deadline ends an attempt in any phase", "TerminalStays", "one-each", "e.by = Owner /\\ e.slot \\in Slots /\\ S.att[e.slot].phase \\in RunningPhases", "e.by = Owner /\\ e.slot \\in Slots"],
  ["a guard dropped: an exception for a visit that is not the next", "ExceptionFirst", "one-each", "         /\\ S.exception = NoSlot\n         /\\ IsNext(S, e.slot)", "         /\\ S.exception = NoSlot"],
  ["a guard added: a case deadline waits on cleanup", "Supervisor", "one-each", "         e.by = Owner /\\ ~Closed(S)\n    [] e.type = \"reconcile\"", "         e.by = Owner /\\ ~Closed(S) /\\ Unresolved(S) = {}\n    [] e.type = \"reconcile\""],
  ["a guard added: a case deadline waits on cleanup", "Acquisition", "one-each", "         e.by = Owner /\\ ~Closed(S)\n    [] e.type = \"reconcile\"", "         e.by = Owner /\\ ~Closed(S) /\\ Unresolved(S) = {}\n    [] e.type = \"reconcile\""],
  ["a guard widened: cleanup is taken from any runner", "Authority", "one-each", "/\\ e.slot \\in Slots /\\ e.by \\in {Owner, Runner(e.slot)}", "/\\ e.slot \\in Slots /\\ e.by \\in Actors"],
  ["a guard narrowed: cleanup is refused from the attempt's own runner", "Interchangeable", "one-each", "/\\ e.slot \\in Slots /\\ e.by \\in {Owner, Runner(e.slot)}", "/\\ e.slot \\in Slots /\\ e.by = Owner"],
  ["a guard narrowed: reconcile is refused once the case is closed", "Supervisor", "one-each", "e.by = Owner /\\ (Running(S) # {} \\/ PendingCleanup(S) # {})", "e.by = Owner /\\ ~Closed(S) /\\ (Running(S) # {} \\/ PendingCleanup(S) # {})"],
  [
    "two guards narrowed: nothing answers a closed case's cleanup",
    "Sinks",
    "one-each",
    ["e.by = Owner /\\ (Running(S) # {} \\/ PendingCleanup(S) # {})", "/\\ e.slot \\in Slots /\\ e.by \\in {Owner, Runner(e.slot)}"],
    ["e.by = Owner /\\ ~Closed(S) /\\ (Running(S) # {} \\/ PendingCleanup(S) # {})", "/\\ ~Closed(S) /\\ e.slot \\in Slots /\\ e.by \\in {Owner, Runner(e.slot)}"]
  ],
  ["a cap off by one: a third control miss is counted", "CapsState", "one-each", "/\\ ~S.met /\\ S.misses < MaxControlMisses", "/\\ ~S.met /\\ S.misses <= MaxControlMisses"],
  ["a cap off by one: a third start retry is counted", "Domain", "one-each", "S.att[e.slot].retries < MaxStartRetries", "S.att[e.slot].retries <= MaxStartRetries"],
  ["a cap off by one: a second configuration change is taken", "CapsState", "one-each", "         /\\ S.changes < MaxConfigurationChanges", "         /\\ S.changes <= MaxConfigurationChanges"],
  ["a field not reset: a close keeps the gate", "GateState", "one-each", "  [ClearGate(S) EXCEPT\n     !.closedBy = why,", "  [S EXCEPT\n     !.closedBy = why,"],
  ["a field not reset: a capture keeps the start retries", "CapsState", "one-each", "[S EXCEPT !.att[e.slot].phase = \"capturing\", !.att[e.slot].retries = 0]", "[S EXCEPT !.att[e.slot].phase = \"capturing\"]"],
  ["a field not reset: a configuration change keeps a met control", "GateStep", "one-each", "         [ClearGate(S) EXCEPT !.config = e.configuration, !.changes = @ + 1]", "         [S EXCEPT !.config = e.configuration, !.changes = @ + 1, !.misses = 0, !.exception = NoSlot]"],
  ["a field not set: a slot closed unstarted carries no configuration", "ClosedExactly", "one-each", "[S.att[s] EXCEPT !.phase = \"not_started\", !.ranUnder = S.config]", "[S.att[s] EXCEPT !.phase = \"not_started\"]"],
  ["a field not set: a start records no configuration", "RanUnder", "one-each", "!.att[e.slot].cleanup = \"pending\", !.att[e.slot].ranUnder = S.config,", "!.att[e.slot].cleanup = \"pending\","],
  ["a field not set: an exception does not mark the case", "Mark", "one-each", "[S EXCEPT !.exception = e.slot, !.exploratory = TRUE]", "[S EXCEPT !.exception = e.slot]"],
  ["a field not reset: a close and a configuration change keep the misses", "CapsStep", "one-each", "ClearGate(S) == [S EXCEPT !.met = FALSE, !.misses = 0, !.exception = NoSlot]", "ClearGate(S) == [S EXCEPT !.met = FALSE, !.exception = NoSlot]"],
  ["a field not set: a start leaves no cleanup pending", "CleanupState", "one-each", "!.att[e.slot].phase = \"starting\", !.att[e.slot].cleanup = \"pending\",", "!.att[e.slot].phase = \"starting\","],
  ["a wrong value: every slot is planned as baseline", "ArmState", "one-each", "retries |-> 0, arm |-> ArmOf(s)]],", "retries |-> 0, arm |-> \"baseline\"]],"],
  ["a wrong value: reconcile leaves a running attempt's cleanup pending", "CleanupStep", "one-each", "[S EXCEPT !.att[r].phase = \"failed\", !.att[r].cleanup = \"unconfirmed\", !.att[r].retries = 0]", "[S EXCEPT !.att[r].phase = \"failed\", !.att[r].retries = 0]"],
  ["a wrong value: a retry that does not count", "Acyclic", "one-each", "[S EXCEPT !.att[e.slot].retries = @ + 1]", "[S EXCEPT !.att[e.slot].retries = @]"],
  ["a wrong value: a cleanup event ends the case", "Acquisition", "one-each", "[] e.type = \"cleanup-confirmed\" -> [S EXCEPT !.att[e.slot].cleanup = \"confirmed\"]", "[] e.type = \"cleanup-confirmed\" -> [S EXCEPT !.att[e.slot].cleanup = \"confirmed\", !.closedBy = \"cancelled\"]"],
  ["a wrong value: a purge is taken on an open case", "PurgeSlice", "one-each", "  IF ~closed THEN [ok |-> FALSE, refusal |-> \"case-open\"]", "  IF FALSE THEN [ok |-> FALSE, refusal |-> \"case-open\"]"],
  ["a wrong value: a start rewrites the arm", "ArmStep", "one-each", "!.att[e.slot].cleanup = \"pending\", !.att[e.slot].ranUnder = S.config,", "!.att[e.slot].cleanup = \"pending\", !.att[e.slot].ranUnder = S.config, !.att[e.slot].arm = \"baseline\","],
  ["a wrong value: a blocked continuation reads only pending cleanup", "ContinuationReads", "one-each", "  ELSE IF Unresolved(S) # {} THEN [kind |-> \"blocked\", slots |-> Unresolved(S)]", "  ELSE IF PendingCleanup(S) # {} THEN [kind |-> \"blocked\", slots |-> PendingCleanup(S)]"],
  ["a wrong value: the denominator drops not_started", "DenominatorAdds", "one-each", "notStarted |-> CountIn(S, {\"planned\", \"not_started\"})", "notStarted |-> CountIn(S, {\"planned\"})"],
  ["a wrong value: terminal reads only the closure", "TerminalIsQuiet", "one-each", "Terminal(S) == Closed(S) /\\ PendingCleanup(S) = {}", "Terminal(S) == Closed(S)"],
  // The same two invariants against a fault of the machine and not of the view each reads.
  ["a guard dropped: a control is taken on a closed case", "TerminalIsQuiet", "one-each", "         /\\ ~Closed(S) /\\ S.frozen /\\ Running(S) = {}\n         /\\ ~S.met /\\ S.misses < MaxControlMisses", "         /\\ S.frozen /\\ Running(S) = {}\n         /\\ ~S.met /\\ S.misses < MaxControlMisses"],
  ["a guard dropped: a visit starts past unresolved cleanup", "ContinuationReads", "one-each", "         /\\ Unresolved(S) = {}\n         /\\ (ArmOf(e.slot)", "         /\\ (ArmOf(e.slot)"],
  // The purge slice's own invariants (PurgeSlice.tla), each against a fault of the reducer.
  ["a wrong value: a purge is taken on an open case", "SliceDomain", "purge-slice", "  IF ~closed THEN [ok |-> FALSE, refusal |-> \"case-open\"]", "  IF FALSE THEN [ok |-> FALSE, refusal |-> \"case-open\"]"],
  ["a guard dropped: a path is moved to the status it already holds", "SliceAnswers", "purge-slice", "       IN IF m.entries[k].status = status THEN [ok |-> FALSE, refusal |-> \"path-status-unchanged\"]", "       IN IF FALSE THEN [ok |-> FALSE, refusal |-> \"path-status-unchanged\"]"],
  ["a wrong value: a path read absent is recorded under a status no rule names", "SummaryOnlyExactly", "purge-slice", "StatusNamed(type) == IF type = \"purge-path-absent\" THEN \"absent\" ELSE \"remains\"", "StatusNamed(type) == IF type = \"purge-path-absent\" THEN \"gone\" ELSE \"remains\""]
];

function option(name) {
  const at = process.argv.indexOf(name);
  return at < 0 ? undefined : process.argv[at + 1];
}

function main() {
  const jar = option("--jar");
  const java = option("--java") ?? "java";
  if (jar === undefined || !existsSync(jar)) throw new Error("Give the pinned tla2tools.jar with --jar <path>");
  const pins = JSON.parse(readFileSync(join(ROOT, "specs", "tla-tools.json"), "utf8"));
  if (sha256Hex(readFileSync(jar)) !== pins.tla2tools.sha256) throw new Error("The jar is not the one specs/tla-tools.json pins");
  const source = readFileSync(join(SPEC_DIR, "CaseMachine.tla"), "utf8");
  const scratch = mkdtempSync(join(tmpdir(), "tla-case-machine-mutations-"));
  let failed = 0;
  try {
    copyFileSync(join(SPEC_DIR, "CaseMachineMC.tla"), join(scratch, "CaseMachineMC.tla"));
    copyFileSync(join(SPEC_DIR, "PurgeSlice.tla"), join(scratch, "PurgeSlice.tla"));
    const run = (text, invariant, plan, label) => {
      writeFileSync(join(scratch, "CaseMachine.tla"), text);
      // The purge slice is its own module, from its own first states, with every manifest, as purge-slice.cfg has it.
      const slice = plan === "purge-slice";
      const constants = ["CONSTANTS", `  Plan <- ${PLAN_OPERATORS[slice ? "one-each" : plan]}`, ...Object.entries(CAPS).map(([name, value]) => `  ${name} = ${value}`), `  HeldManifests = "${slice ? "all" : "two"}"`];
      writeFileSync(join(scratch, "one.cfg"), [...constants, slice ? "INIT SliceInit" : "INIT Init", slice ? "NEXT SliceNext" : "NEXT Next", "INVARIANTS", `  ${invariant}`, ""].join("\n"));
      const result = spawnSync(java, ["-XX:+UseParallelGC", "-Xmx1g", "-cp", jar, "tlc2.TLC", "-workers", "1", "-deadlock", "-metadir", join(scratch, `states-${label}`), "-config", "one.cfg", slice ? "PurgeSlice" : "CaseMachineMC"], { cwd: scratch, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
      return `${result.stdout}\n${result.stderr}`;
    };
    // The specification as committed passes each invariant alone, so a violation below is the fault's.
    for (const [invariant, plan] of [...new Set(MUTATIONS.map(([, invariant, plan]) => `${invariant} ${plan}`))].map((pair) => pair.split(" "))) {
      const output = run(source, invariant, plan, "clean");
      if (!output.includes("Model checking completed. No error has been found.")) {
        failed += 1;
        console.log(`FAILED  the committed specification does not pass ${invariant} on ${plan}`);
      }
    }
    MUTATIONS.forEach(([what, invariant, plan, find, replace], at) => {
      // An entry holds one edit, or a list of texts to find beside a list of their replacements.
      const finds = Array.isArray(find) ? find : [find];
      const replacements = Array.isArray(replace) ? replace : [replace];
      let mutated = source;
      for (let edit = 0; edit < finds.length; edit += 1) {
        const occurrences = mutated.split(finds[edit]).length - 1;
        if (occurrences !== 1) {
          failed += 1;
          console.log(`FAILED  ${what}: its edit lands ${occurrences} times`);
          return;
        }
        mutated = mutated.replace(finds[edit], () => replacements[edit]);
      }
      const output = run(mutated, invariant, plan, String(at));
      // TLC words a violation in the first state differently.
      const caught = output.includes(`Invariant ${invariant} is violated.`) || output.includes(`Invariant ${invariant} is violated by the initial state`);
      const depth = /The depth of the complete state graph search is (\d+)/.exec(output)?.[1] ?? "?";
      if (!caught) failed += 1;
      console.log(`${caught ? "caught " : "FAILED "} ${invariant.padEnd(18)} ${plan.padEnd(9)} ${what}${caught ? "" : `\n${output.split("\n").slice(-12).join("\n")}`}${caught ? ` (trace of ${(output.match(/^State \d+:/gm) ?? []).length} states)` : ` depth ${depth}`}`);
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  console.log(`${MUTATIONS.length - failed} of ${MUTATIONS.length} faults caught by the invariant named for each.`);
  if (failed > 0) process.exitCode = 1;
}

main();
