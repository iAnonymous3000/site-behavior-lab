#!/usr/bin/env node

// Runs the compiled lib unit tests in two phases instead of one strictly
// serial pass. Which tests run, and everything each one asserts, is unchanged.
//
// scripts/unit-test-serial-lane.json names every lib test whose outcome can
// depend on how busy the machine is or on a resource shared across processes:
// Chromium launches (including page.evaluate function serialization), wall
// clock and CPU-time assertions, timers racing deadlines, short timeouts and
// watchdogs, and wrangler bundles booted in Miniflare. Those files keep exactly
// the conditions they always had: one at a time, after everything else has
// finished, with nothing running beside them.
//
// Every other lib test runs first, PARALLEL_FILES at a time, each file in its
// own process as before. The one command named by --alongside (the
// corpus-overview group, which is one process by design) runs beside that
// phase, its output held back and printed whole once it ends so the two logs
// never interleave. A failure in either stops the run before the serial phase.
// The former single pass reported every failing lib file at once; now serial
// files are not reached until the parallel phase passes. The gate is the same.
//
// Every node --test this runner starts carries TEST_BOUND_FLAGS: a per-test
// timeout and --test-force-exit. Node's own default timeout is Infinity, so a
// test awaiting a promise that never settles, a server that never closes or a
// child that never exits would otherwise hang its lane, and with it a local
// gate or a CI job, until someone killed it. The other node --test stages of
// test:unit spell the same flags in package.json.
//
// A lane passes only if every one of its files delivered the summary its
// process writes last. node --test passes a file whose process exits 0 on the
// results that reached it, however few; this runner names the file instead.
// See fileSummaries below.
//
// dist/ is the one shared build output tests read: several load
// dist/schema/lib/*.js before falling back to .unit-test-dist, and tsc rewrites
// those files in place. A test that recompiles it belongs in the serial lane, so
// this runner fingerprints dist/ before and after the parallel phase and fails
// if anything in that phase changed it.
//
// scripts/unit-test-lanes.test.mjs forces every lib test that matches a
// browser, timing, timer, git-spawning or Worker-runtime pattern into the
// serial lane, proves this runner fails when any lane fails, a file's results
// stop short or dist/ changes, and holds every node --test stage of test:unit
// to TEST_TIMEOUT_MS. Those patterns are a heuristic, not a proof: a deadline
// hidden in a helper module can still slip past them, so a test that ever
// fails only in the parallel lane belongs in the serial lane, never behind a
// retry.

import { spawn } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SERIAL_LANE_FILE = path.join("scripts", "unit-test-serial-lane.json");
// Three test files plus the alongside process keep a 4-vCPU CI runner busy
// without queueing work behind it. More cores do not raise this: the parallel
// lane holds no timing-sensitive test, so a slower machine only takes longer.
export const PARALLEL_FILES = 3;
// The per-test bound. A test, subtest or hook that sets no timeout of its own
// fails at this one with node's "test timed out after 600000ms"; one that sets
// its own keeps it. The slowest test without one is the corpus-overview
// group's walk of every committed bundle (committed-corpus-surface-fidelity):
// 135 to 183 s on CI runners and 72 to 94 s on a busy Mac in October 2026,
// growing with the corpus. A timeout there means the corpus outgrew this
// bound, not a deadlock. Ten minutes still lets two stuck tests in a row fail
// by name inside the 45 minutes CI gives the whole tests job.
export const TEST_TIMEOUT_MS = 600_000;
// --test-timeout alone fails a stuck test on time, but a server, socket or
// child process that test left open keeps its file's process alive, and node
// --test waits for that process to exit. --test-force-exit ends each test
// process once its tests and hooks have finished. The cost: asynchronous
// activity after a file's last test, such as a late rejection, goes
// unreported, because the process is gone before it happens, and so can the
// end of the file's own results (see fileSummaries). One hang remains out of
// reach: a child that never exits and shares the test process's stdout (stdio
// "inherit", say) keeps open the pipe node --test reads results from. A child
// that shares only stderr does not.
export const TEST_BOUND_FLAGS = [`--test-timeout=${TEST_TIMEOUT_MS}`, "--test-force-exit"];

// node --test runs each test file in its own process, which streams its
// results back over a pipe and ends the stream with that file's test:summary.
// --test-force-exit ends the process with process.exit() once its reporter has
// handed the last result to stdout, without waiting for the pipe to take it,
// and on POSIX node writes to a pipe asynchronously: results still queued in
// the process at that moment are discarded. node --test then sees exit code 0
// and passes the file on the results that did arrive, with no error. A file
// whose tests never yield to the event loop writes its whole stream at once
// when they end, so it is enough for node --test to fall behind while that
// burst fills the pipe. On 2026-10-21 a local gate passed a lane in which
// measurement-candidate-binding.test.js had reported 51 of its 96 results.
// A process that calls process.exit(0) before its tests end looks the same,
// and there the tests after it never ran at all.
//
// The summary is the last thing a file's process writes, so its arrival means
// everything before it arrived. Each lane names this module's default export
// as a second reporter, writing every file's summary to a scratch file, and
// fails if any of its files has none. Naming any reporter replaces node's
// default, so spec on stdout is named again first.
export function laneReporterFlags(summaryLog) {
  return [
    "--test-reporter=spec",
    "--test-reporter-destination=stdout",
    `--test-reporter=${import.meta.url}`,
    `--test-reporter-destination=${summaryLog}`
  ];
}

export default async function* fileSummaries(source) {
  for await (const event of source) {
    // The run's cumulative summary names no file and vouches for none.
    if (event.type === "test:summary" && typeof event.data.file === "string") {
      yield `${JSON.stringify(event.data.file)}\n`;
    }
  }
}

// A file's process names itself by the absolute path it was started with, so
// both sides are compared with symlinks resolved (macOS's temporary directory
// is one). A summary log that was never written leaves every file unfinished.
export function filesWithoutSummary(files, summaryLog, root = process.cwd()) {
  const summarized = new Set(
    (existsSync(summaryLog) ? readFileSync(summaryLog, "utf8") : "")
      .split("\n")
      .filter(Boolean)
      .map((line) => canonicalPath(JSON.parse(line)))
  );
  return files.filter((file) => !summarized.has(canonicalPath(path.resolve(root, file))));
}

function canonicalPath(file) {
  try {
    return realpathSync(file);
  } catch {
    return path.resolve(file);
  }
}

const COMPILED_TEST = /^\.unit-test-dist\/lib\/[A-Za-z0-9._-]+\.test\.js$/;
const SOURCE_TEST = /^lib\/[A-Za-z0-9._-]+\.test\.ts$/;
const ALONGSIDE = /^npm run ([\w:-]+)$/;

function compiledPathOf(source) {
  return `.unit-test-dist/${source.slice(0, -".ts".length)}.js`;
}

export function readSerialLane(root = process.cwd()) {
  const lane = JSON.parse(readFileSync(path.join(root, SERIAL_LANE_FILE), "utf8"));
  if (!lane || typeof lane !== "object" || Array.isArray(lane)) {
    throw new Error(`${SERIAL_LANE_FILE} must map each serial test file to its reason`);
  }
  return lane;
}

// Splits the exact file list the shell glob produced. Order is preserved in
// both lanes, so the serial lane runs its files in the order it always did.
export function partitionCompiledTests(files, serialLane) {
  if (files.length === 0) throw new Error("No compiled lib tests were given; the glob matched nothing.");
  const seen = new Set();
  for (const file of files) {
    if (!COMPILED_TEST.test(file)) throw new Error(`Refusing unexpected test path: ${file}`);
    if (seen.has(file)) throw new Error(`Test file given twice: ${file}`);
    seen.add(file);
  }
  const serial = new Set();
  for (const [source, reason] of Object.entries(serialLane)) {
    if (!SOURCE_TEST.test(source)) throw new Error(`Serial lane entry is not a top-level lib test: ${source}`);
    if (typeof reason !== "string" || reason.trim().length === 0) {
      throw new Error(`Serial lane entry ${source} must state why it runs alone`);
    }
    const compiled = compiledPathOf(source);
    if (!seen.has(compiled)) throw new Error(`Serial lane names ${source}, but ${compiled} was not compiled`);
    serial.add(compiled);
  }
  return {
    parallel: files.filter((file) => !serial.has(file)),
    serial: files.filter((file) => serial.has(file))
  };
}

export function parseLaneArguments(argv) {
  const [flag, alongside, ...files] = argv;
  const script = flag === "--alongside" ? ALONGSIDE.exec(alongside ?? "")?.[1] : undefined;
  if (!script) {
    throw new Error('Usage: unit-test-lanes.mjs --alongside "npm run <script>" <compiled lib tests...>');
  }
  return { alongsideScript: script, files };
}

// Every path under dist/ with its type, size and nanosecond mtime. An absent
// dist/ fingerprints as empty, so creating it also counts as a change.
export function distFingerprint(root = process.cwd()) {
  const entries = [];
  const walk = (relative) => {
    for (const entry of readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const child = path.join(relative, entry.name);
      const stats = lstatSync(path.join(root, child), { bigint: true });
      entries.push(`${child}\t${entry.isDirectory() ? "d" : "f"}\t${stats.size}\t${stats.mtimeNs}`);
      if (entry.isDirectory()) walk(child);
    }
  };
  if (existsSync(path.join(root, "dist"))) walk("dist");
  return entries.sort();
}

const live = new Set();
// The scratch directory of each running lane, which holds its summary log.
const scratch = new Set();

// With no file arguments node --test would discover and run every test file
// under the working directory, so an empty lane is skipped instead.
async function runLane(files, concurrency) {
  if (files.length === 0) return { ok: true, skipped: true, seconds: 0, output: Buffer.alloc(0), unfinished: [] };
  const dir = mkdtempSync(path.join(os.tmpdir(), "unit-test-lane-"));
  scratch.add(dir);
  try {
    const summaryLog = path.join(dir, "summaries");
    const result = await run(process.execPath, [
      "--test",
      `--test-concurrency=${concurrency}`,
      ...TEST_BOUND_FLAGS,
      ...laneReporterFlags(summaryLog),
      ...files
    ]);
    // A lane that never started has already failed and wrote no summaries.
    const unfinished = result.error ? [] : filesWithoutSummary(files, summaryLog);
    return { ...result, ok: result.ok && unfinished.length === 0, unfinished };
  } finally {
    rmSync(dir, { recursive: true, force: true });
    scratch.delete(dir);
  }
}

function run(command, args, { capture = false } = {}) {
  const started = process.hrtime.bigint();
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit" });
    live.add(child);
    const output = [];
    if (capture) {
      child.stdout.on("data", (chunk) => output.push(chunk));
      child.stderr.on("data", (chunk) => output.push(chunk));
    }
    const finish = (code, signal, error) => {
      live.delete(child);
      const seconds = Number(process.hrtime.bigint() - started) / 1e9;
      resolve({ ok: code === 0 && !signal && !error, code, signal, error, output: Buffer.concat(output), seconds });
    };
    child.on("error", (error) => finish(null, null, error));
    child.on("close", (code, signal) => finish(code, signal, null));
  });
}

function describe(label, result) {
  if (result.skipped) return `${label} skipped: no files`;
  const status = result.error
    ? `could not start (${result.error.message})`
    : result.signal
      ? `was killed by ${result.signal}`
      : result.code !== 0
        ? `failed with exit code ${result.code}`
        : result.ok
          ? "passed"
          : "exited 0 but did not pass";
  const line = `${label} ${status} after ${result.seconds.toFixed(1)} s`;
  const unfinished = result.unfinished ?? [];
  if (unfinished.length === 0) return line;
  const one = unfinished.length === 1;
  const listed = unfinished.slice(0, 10).join(", ") + (unfinished.length > 10 ? `, and ${unfinished.length - 10} more` : "");
  return (
    `${line}\n` +
    `${one ? "One of its files" : `${unfinished.length} of its files`} ended without the summary a test file's ` +
    `process writes last, so the results above stop short for ${one ? "it" : "them"} and the counts leave out ` +
    `whatever was lost: ${listed}. Rerun ${one ? "it" : "each"} alone. A file cut short there too ends its own ` +
    `process before its tests finish; one that completes there lost the end of its results while node --test ` +
    `fell behind reading them, so check \`uptime\` for host load.`
  );
}

async function main() {
  const { alongsideScript, files } = parseLaneArguments(process.argv.slice(2));
  const { parallel, serial } = partitionCompiledTests(files, readSerialLane());

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      for (const child of live) child.kill(signal);
      for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
      process.exit(signal === "SIGINT" ? 130 : 143);
    });
  }

  const alongsideLabel = `npm run ${alongsideScript}`;
  console.log(
    `Unit test lanes: ${parallel.length} lib test files ${PARALLEL_FILES} at a time beside \`${alongsideLabel}\`, ` +
      `then ${serial.length} serial lib test files one at a time.`
  );
  const distBefore = distFingerprint();
  const [parallelResult, alongsideResult] = await Promise.all([
    runLane(parallel, PARALLEL_FILES),
    run("npm", ["run", alongsideScript], { capture: true })
  ]);
  console.log(`\n----- output of \`${alongsideLabel}\`, which ran beside the parallel lane -----`);
  process.stdout.write(alongsideResult.output);
  console.log(`----- end of \`${alongsideLabel}\` -----\n`);
  const phaseOne = [
    describe(`Parallel lib lane (${parallel.length} files)`, parallelResult),
    describe(`\`${alongsideLabel}\``, alongsideResult)
  ];
  console.log(phaseOne.join("\n"));
  const before = new Set(distBefore);
  const after = new Set(distFingerprint());
  const changed = [...after, ...before]
    .filter((entry) => !before.has(entry) || !after.has(entry))
    .map((entry) => entry.split("\t")[0]);
  if (changed.length > 0) {
    console.error(
      `A parallel-lane test or \`${alongsideLabel}\` changed dist/ while other tests could read it: ` +
        `${[...new Set(changed)].sort().slice(0, 10).join(", ")}. Move the test that writes dist/ into ${SERIAL_LANE_FILE}.`
    );
  }
  if (!parallelResult.ok || !alongsideResult.ok || changed.length > 0) {
    console.error("Unit test lanes stopped before the serial lane: the parallel phase above did not pass.");
    return 1;
  }

  const serialResult = await runLane(serial, 1);
  console.log(describe(`Serial lib lane (${serial.length} files)`, serialResult));
  return serialResult.ok ? 0 : 1;
}

// Set the exit code rather than calling process.exit, so every byte of the
// buffered alongside output reaches a piped stdout before the process ends.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    }
  );
}
