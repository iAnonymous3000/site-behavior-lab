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
// never interleave. A failure in either stops the run before the serial phase,
// the same fail-fast order the former `&&` chain had.
//
// dist/ is the one shared build output tests read: several load
// dist/schema/lib/*.js before falling back to .unit-test-dist, and tsc rewrites
// those files in place. A test that recompiles it belongs in the serial lane, so
// this runner fingerprints dist/ before and after the parallel phase and fails
// if anything in that phase changed it.
//
// scripts/unit-test-lanes.test.mjs forces every lib test that matches a
// browser, timing, or Worker-runtime pattern into the serial lane, and proves
// this runner fails when any lane fails or dist/ changes. New tests are
// therefore never exposed to parallel load unnoticed.

import { spawn } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SERIAL_LANE_FILE = path.join("scripts", "unit-test-serial-lane.json");
// Three test files plus the alongside process keep a 4-vCPU CI runner busy
// without queueing work behind it. More cores do not raise this: the parallel
// lane holds no timing-sensitive test, so a slower machine only takes longer.
export const PARALLEL_FILES = 3;

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
  const status = result.ok
    ? "passed"
    : result.error
      ? `could not start (${result.error.message})`
      : result.signal
        ? `was killed by ${result.signal}`
        : `failed with exit code ${result.code}`;
  return `${label} ${status} after ${result.seconds.toFixed(1)} s`;
}

async function main() {
  const { alongsideScript, files } = parseLaneArguments(process.argv.slice(2));
  const { parallel, serial } = partitionCompiledTests(files, readSerialLane());

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      for (const child of live) child.kill(signal);
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
    run(process.execPath, ["--test", `--test-concurrency=${PARALLEL_FILES}`, ...parallel]),
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
    process.exit(1);
  }

  const serialResult = await run(process.execPath, ["--test", "--test-concurrency=1", ...serial]);
  console.log(describe(`Serial lib lane (${serial.length} files)`, serialResult));
  if (!serialResult.ok) process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
