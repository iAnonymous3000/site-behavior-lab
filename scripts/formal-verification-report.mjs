#!/usr/bin/env node
// Runs the suites the formal-verification release gate requires, and writes
// the execution report that CI signs for the commit it ran at.
//
//   --output <file>  Run at an exact, clean commit and write the report to
//                    <file>, which must not exist and must be outside the
//                    worktree. A dirty tree is refused before the run and
//                    again after it, and a report that does not meet the
//                    gate's rule is never written.
//   --dry-run        Run the same suites on whatever is checked out and write
//                    nothing. Exits 1 unless the result meets the gate's rule.
//                    Needs no Git, so it also runs where there is none.
//
// The report is made by running the suites, here, and by nothing else. Each
// required suite file is compiled afresh and run alone through the unit lanes'
// own lane (scripts/unit-test-lanes.mjs), so it gets the lanes' per-test
// bound, their blocking stdout and their guard against a file whose results
// stop short, and a skipped or todo test fails its run. Two things are read
// back from each run: node's test events, through the reporter in
// scripts/formal-verification-report-lib.mjs, and the catch log that
// lib/finite-check.ts appends to when asked.
//
// The lane's verdict is not enough by itself. node exits 0, and the lane
// passes, on a describe block that fails as a block, on a test marked
// expectFailure whose body throws, and on a todo block with no test in it.
// The events show all three, and a run with any of them is refused here by
// name, whatever the lane said.
//
// Why a run of its own, and not a stage of test:unit. These suites already run
// in test:unit, which is what gates a change. Running them a second time there
// would also run them a second time inside the container image build, whose
// CI job has no minutes to spare, so CI runs this as one step of the tests job
// instead. The cost is that the suites run twice in that job.
//
// One file at a time: the case exploration needs about 2 GB while it runs,
// and nothing here is worth racing it for.

import { execFileSync } from "node:child_process";
import { closeSync, constants, existsSync, fsyncSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  FORMAL_VERIFICATION_CATCH_LOG_ENV,
  buildFormalVerificationReport,
  compiledSuitePath,
  formalVerificationReportProblems,
  formalVerificationReportTotals,
  formalVerificationRequiredSuitesProblems,
  serializeFormalVerificationReport
} from "./formal-verification-report-lib.mjs";
import { resolveExactStaticDeploymentCommit } from "./static-deployment-provenance.mjs";
import { describeLane, runLane, stopLanesOnSignal } from "./unit-test-lanes.mjs";
import { v1ProfileProblems } from "./v1-release-contract.mjs";

export const FORMAL_VERIFICATION_GATE = "formal-verification";
const REPORTER = pathToFileURL(fileURLToPath(new URL("./formal-verification-report-lib.mjs", import.meta.url))).href;
const USAGE = "Usage: node scripts/formal-verification-report.mjs --output <file outside the worktree> | --dry-run";
// A dry run has no commit to name. Its report is judged and never written.
const NO_SOURCE = "0".repeat(40);
const BLOCK_REFUSAL = { skipped: "was skipped", todo: "is left todo", failed: "failed as a block" };

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function canonicalPath(file) {
  try {
    return realpathSync(file);
  } catch {
    return path.resolve(file);
  }
}

function jsonLines(file) {
  return (existsSync(file) ? readFileSync(file, "utf8") : "")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** The exact commit and tree of a clean checkout. Throws on a dirty one. */
function exactSource(root, env) {
  const commit = resolveExactStaticDeploymentCommit({ cwd: root, env });
  const tree = execFileSync("git", ["rev-parse", "--verify", "HEAD^{tree}"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
    .trim()
    .toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(tree)) throw new Error("The formal verification report needs an exact Git source tree");
  return { commit, tree };
}

/** Compile, from nothing, each tree a required suite is in. */
function compileSuites(root, requiredSuites) {
  const compiler = path.join(root, "node_modules", "typescript", "bin", "tsc");
  for (const [prefix, output, project] of [
    ["lib/", ".unit-test-dist", "tsconfig.test.json"],
    ["investigation/", ".investigation-test-dist", "tsconfig.investigation-test.json"]
  ]) {
    if (!requiredSuites.some(({ id }) => id.startsWith(prefix))) continue;
    rmSync(path.join(root, output), { recursive: true, force: true });
    execFileSync(process.execPath, [compiler, "-p", project], { cwd: root, stdio: "inherit" });
  }
}

/**
 * Run one suite file alone and read back what it did. Returns its record, or
 * null when its run left no summary to build one from, and every reason the
 * run cannot stand as evidence.
 */
async function runSuite(root, id, compiled) {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "formal-verification-report-"));
  const events = path.join(scratch, "events.jsonl");
  const catches = path.join(scratch, "catches.jsonl");
  const before = process.env[FORMAL_VERIFICATION_CATCH_LOG_ENV];
  try {
    // The lane's child inherits this process's environment when it starts.
    process.env[FORMAL_VERIFICATION_CATCH_LOG_ENV] = catches;
    let lane;
    try {
      lane = await runLane([compiled], 1, {
        requireRealTests: true,
        reporterFlags: [`--test-reporter=${REPORTER}`, `--test-reporter-destination=${events}`]
      });
    } finally {
      if (before === undefined) delete process.env[FORMAL_VERIFICATION_CATCH_LOG_ENV];
      else process.env[FORMAL_VERIFICATION_CATCH_LOG_ENV] = before;
    }
    console.log(describeLane(id, lane));

    const failures = [];
    if (!lane.ok) failures.push(`${id}: its run did not pass`);
    const file = canonicalPath(path.resolve(root, compiled));
    const lines = jsonLines(events).filter((line) => typeof line.file === "string" && canonicalPath(line.file) === file);
    const summaries = lines.filter((line) => line.kind === "summary");
    if (summaries.length !== 1) {
      failures.push(`${id}: its run left ${summaries.length} summaries, so its results are not whole`);
      return { record: null, failures };
    }
    // Only the harness writes this log. A line it would not write means
    // something else did, and then the log is no record of the harness.
    let caught = null;
    try {
      caught = jsonLines(catches);
    } catch {
      // Falls through to the refusal below.
    }
    if (caught === null || !caught.every((line) => isRecord(line) && ["variant", "property", "caughtBy"].every((field) => typeof line[field] === "string"))) {
      failures.push(`${id}: its catch log holds a line that is not a catch`);
      return { record: null, failures };
    }
    const { counts } = summaries[0];
    const tests = lines.filter((line) => line.kind === "test").map(({ name, outcome }) => ({ name, outcome }));
    // A describe block that was skipped, left todo or failed as a block is in
    // none of node's counts, and a failed one does not move node's exit
    // status either. Each is named here, and counted in the report.
    const blocks = lines.filter((line) => line.kind === "block");
    for (const { name, outcome } of blocks) {
      failures.push(`${id}: describe block ${JSON.stringify(name)} ${BLOCK_REFUSAL[outcome] ?? "did not pass"}`);
    }
    const of = (list, outcome) => list.filter((entry) => entry.outcome === outcome).length;
    return {
      failures,
      record: {
        id,
        counts: {
          ...counts,
          expectedFailures: of(tests, "expected-failure"),
          skippedSuites: of(blocks, "skipped"),
          todoSuites: of(blocks, "todo"),
          failedSuites: blocks.length - of(blocks, "skipped") - of(blocks, "todo")
        },
        tests,
        variants: caught
      }
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Refuse an output that exists, or that would dirty the source it names. */
function outputProblem(root, output) {
  const absolute = path.resolve(root, output);
  let parent;
  try {
    parent = realpathSync(path.dirname(absolute));
  } catch {
    return "--output must be in a directory that exists";
  }
  const inside = (base, target) => {
    const relative = path.relative(base, target);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  };
  const resolved = path.join(parent, path.basename(absolute));
  if (inside(root, absolute) || inside(realpathSync(root), resolved)) {
    return "--output must be outside the Git worktree, so that writing the report cannot dirty the source it names";
  }
  if (existsSync(resolved)) return "--output must not already exist";
  return null;
}

function writeExclusive(output, text) {
  const handle = openSync(output, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    writeSync(handle, text, null, "utf8");
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
}

/**
 * Run the required suites in the working directory and judge the result.
 * Returns { ok, problems, totals, report }. With `output`, an ok report is
 * also written there, for the exact clean commit checked out.
 *
 * `compile: false` and `compiledFiles` exist for this module's own tests,
 * which run small fixture suites: the command line always compiles afresh and
 * always runs the files the suite ids name.
 */
export async function produceFormalVerificationReport({ requiredSuites, output, env = process.env, compile = true, compiledFiles = null }) {
  const root = process.cwd();
  const configuration = formalVerificationRequiredSuitesProblems(requiredSuites);
  if (configuration.length > 0) return { ok: false, problems: configuration, totals: null, report: null };

  let source = null;
  if (output !== undefined) {
    const refused = outputProblem(root, output);
    if (refused !== null) return { ok: false, problems: [refused], totals: null, report: null };
    try {
      source = exactSource(root, env);
    } catch (error) {
      return { ok: false, problems: [String(error instanceof Error ? error.message : error)], totals: null, report: null };
    }
  }

  if (compile) compileSuites(root, requiredSuites);

  const records = [];
  const problems = [];
  for (const { id } of requiredSuites) {
    const { record, failures } = await runSuite(root, id, compiledFiles?.[id] ?? compiledSuitePath(id));
    problems.push(...failures);
    if (record !== null) records.push(record);
  }
  const report = buildFormalVerificationReport({ commit: source?.commit ?? NO_SOURCE, tree: source?.tree ?? NO_SOURCE, suites: records });
  problems.push(...formalVerificationReportProblems(report, requiredSuites, source ?? {}));
  if (problems.length > 0) return { ok: false, problems, totals: null, report: null };

  if (source !== null) {
    // The suites ran from this tree. If it moved or was dirtied while they
    // ran, the report would name a source that is not the one that ran.
    let after;
    try {
      after = exactSource(root, env);
    } catch (error) {
      return { ok: false, problems: [`the checkout changed while the suites ran: ${String(error instanceof Error ? error.message : error)}`], totals: null, report: null };
    }
    // A clean checkout at the same commit has the same tree, so the commit is
    // all there is to compare.
    if (after.commit !== source.commit) {
      return { ok: false, problems: ["the checked-out commit changed while the suites ran"], totals: null, report: null };
    }
    writeExclusive(path.resolve(root, output), serializeFormalVerificationReport(report));
  }
  return { ok: true, problems: [], totals: formalVerificationReportTotals(report), report };
}

/** The gate's own list, from the manifest, only while the manifest holds its release profile. */
export function requiredSuitesOfManifest(root) {
  const manifest = JSON.parse(readFileSync(path.join(root, "RELEASE_READINESS.json"), "utf8"));
  const profile = v1ProfileProblems(manifest);
  if (profile.length > 0) {
    throw new Error(`RELEASE_READINESS.json does not hold its release profile, so its required suites are not the reviewed list: ${profile.join("; ")}`);
  }
  const gate = manifest.gates?.[FORMAL_VERIFICATION_GATE];
  if (!isRecord(gate)) throw new Error(`RELEASE_READINESS.json names no ${FORMAL_VERIFICATION_GATE} gate, so no suite is required`);
  return gate.requiredSuites;
}

async function main(argv) {
  const dryRun = argv.length === 1 && argv[0] === "--dry-run";
  const output = argv.length === 2 && argv[0] === "--output" && argv[1] ? argv[1] : undefined;
  if (!dryRun && output === undefined) {
    console.error(USAGE);
    return 1;
  }
  stopLanesOnSignal();
  const result = await produceFormalVerificationReport({ requiredSuites: requiredSuitesOfManifest(process.cwd()), output });
  if (!result.ok) {
    console.error(dryRun ? "The suites do not meet the formal-verification gate's rule:" : "No formal verification report was written:");
    for (const problem of result.problems) console.error(`  - ${problem}`);
    return 1;
  }
  const { suites, tests, variants } = result.totals;
  const ran = `${suites} suite files ran: ${tests} tests passed, none skipped, and ${variants} catches were recorded, each for the property its suite named`;
  console.log(
    dryRun
      ? `Dry run, nothing written. ${ran}.`
      : `Formal verification report for ${result.report.source.commit} written to ${path.resolve(output)}. ${ran}.`
  );
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    }
  );
}
