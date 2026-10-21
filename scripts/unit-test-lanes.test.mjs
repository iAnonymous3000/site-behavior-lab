import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { closeSync, openSync, readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import fileSummaries, {
  BLOCKING_STDOUT_PRELOAD,
  SERIAL_LANE_FILE,
  TEST_BOUND_FLAGS,
  TEST_TIMEOUT_MS,
  blocksStdoutIn,
  filesWithoutSummary,
  parseLaneArguments,
  partitionCompiledTests,
  readSerialLane
} from "./unit-test-lanes.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runner = path.join(root, "scripts", "unit-test-lanes.mjs");
const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const libTests = readdirSync(path.join(root, "lib"))
  .filter((name) => name.endsWith(".test.ts"))
  .map((name) => `lib/${name}`)
  .sort();
// A fixture run of the lanes takes well under a second. A lane that never
// finishes must fail its test instead of hanging this file, and spawnSync
// blocks this process, so no node --test timeout could interrupt it.
const FIXTURE_TIMEOUT_MS = 60_000;

// Each fixture test loads this module to report whether its process was
// started with the lanes' preload and whether its stdout blocks. Node has no
// call that reads a descriptor's flags, but WASI's fd_fdstat_get does: node's
// WASI reports the descriptor's O_NONBLOCK as FDFLAGS_NONBLOCK, bit 2.
// Turning blocking off for a moment must show that bit, or the reading proves
// nothing.
const STDOUT_PROBE = `
function stdoutNonBlocking() {
  // node:wasi warns, once, as it loads, that it is experimental.
  const emitWarning = process.emitWarning;
  process.emitWarning = () => {};
  let WASI;
  try {
    ({ WASI } = require("node:wasi"));
  } finally {
    process.emitWarning = emitWarning;
  }
  // WASI writes its answers into an instance's memory, and needs nothing else
  // from the instance, so a bare memory stands in for one.
  const wasi = new WASI({ version: "preview1" });
  const memory = new WebAssembly.Memory({ initial: 1 });
  wasi.initialize({ exports: { memory } });
  const errno = wasi.wasiImport.fd_fdstat_get(1, 0);
  if (errno !== 0) throw new Error("fd_fdstat_get(1) returned errno " + errno);
  // The fdstat record keeps its 16-bit flags at byte 2.
  return (new DataView(memory.buffer).getUint16(2, true) & 4) !== 0;
}
module.exports = () => {
  const blocking = !stdoutNonBlocking();
  process.stdout._handle.setBlocking(false);
  const flagVisible = stdoutNonBlocking();
  process.stdout._handle.setBlocking(blocking);
  return { preloaded: process.execArgv.includes(${JSON.stringify(BLOCKING_STDOUT_PRELOAD)}), flagVisible, blocking };
};
`;

// Every `&&` step test:unit executes, following `npm run` hops, including the
// alongside command the lanes start.
function testUnitSteps() {
  const visited = new Set();
  const steps = [];
  const visit = (name) => {
    if (visited.has(name)) return;
    visited.add(name);
    for (const step of packageJson.scripts[name].split(" && ")) {
      if (!/^npm run [\w:-]+$/.test(step)) steps.push(step);
      for (const hop of step.matchAll(/npm run ([\w:-]+)/g)) visit(hop[1]);
    }
  };
  visit("test:unit");
  return steps;
}

// A lib test matching any of these can pass or fail depending on machine load
// or on a resource other processes share, so it must run in the serial lane,
// alone, exactly as every lib test did before the lanes existed. The patterns
// are deliberately broad: a false match costs a few seconds of serial time; a
// miss exposes a timing assertion to parallel load.
const SERIAL_ONLY_PATTERNS = [
  ["launches Chromium or imports the scanner's shared browser", /chromium\.launch\(|getSharedBrowser\(|from "\.\/scanner"/],
  ["measures wall-clock or CPU time", /performance\.now\(|cpuUsage\(|threadCpuUsage|resourceUsage\(|hrtime|Date\.now\(\)\s*-\s*[A-Za-z_(]/],
  ["waits on timers or settle watchdogs", /setTimeout\(|setInterval\(|timers\/promises|AbortSignal\.timeout\(|settleWithin|watchdog/],
  [
    "sets a literal timeout, deadline or delay",
    /\b\w*(?:[Tt]imeout|TIMEOUT|[Dd]eadline|DEADLINE|[Dd]elay|DELAY)(?:Ms|MS|_MS|Seconds|_SECONDS)?\s*[:=]\s*["']?[\d_]+/
  ],
  ["boots a wrangler bundle in Miniflare", /\bMiniflare\b|from "miniflare"|wrangler\/bin\/wrangler\.js|wrangler-dist/],
  // lib/git-fixture.ts disables the detached auto maintenance that can still be
  // writing into a fixture repo when its teardown removes it, which fails only
  // under load. A test that spawns git itself does not get that protection.
  ["runs git directly instead of through lib/git-fixture.ts", /\b(?:spawnSync|execFileSync|execSync|spawn|execFile)\(\s*"git"/]
];

test("the serial lane names existing top-level lib tests, sorted, each with its reason", () => {
  const lane = readSerialLane(root);
  const names = Object.keys(lane);
  assert.ok(names.length > 0);
  assert.deepEqual(names, [...names].sort(), `${SERIAL_LANE_FILE} must stay sorted`);
  for (const [name, reason] of Object.entries(lane)) {
    assert.ok(libTests.includes(name), `${SERIAL_LANE_FILE} names ${name}, which is not a top-level lib test`);
    assert.equal(typeof reason, "string");
    assert.ok(reason.trim().length > 10, `${name} needs a reason to run alone`);
  }
});

test("every lib test that is sensitive to load runs in the serial lane", () => {
  const lane = readSerialLane(root);
  const exposed = [];
  for (const name of libTests) {
    if (Object.hasOwn(lane, name)) continue;
    const source = readFileSync(path.join(root, name), "utf8");
    for (const [why, pattern] of SERIAL_ONLY_PATTERNS) {
      if (pattern.test(source)) exposed.push(`${name} ${why} (${source.match(pattern)[0]})`);
    }
  }
  assert.deepEqual(exposed, [], `move these into ${SERIAL_LANE_FILE}:\n${exposed.join("\n")}`);
});

test("test:unit runs every compiled lib test exactly once, through the lanes, before the producer suites", () => {
  const testUnit = packageJson.scripts["test:unit"];
  const lanes = "node scripts/unit-test-lanes.mjs --alongside 'npm run test:corpus-overview' .unit-test-dist/lib/*.test.js";
  assert.equal(testUnit.split(".unit-test-dist/lib/*.test.js").length - 1, 1, "the lib glob must run exactly once");
  assert.equal(testUnit.split("npm run test:corpus-overview").length - 1, 1, "corpus-overview must run exactly once");
  const compile = testUnit.indexOf("rm -rf .unit-test-dist && tsc -p tsconfig.test.json && ");
  const run = testUnit.indexOf(lanes);
  assert.equal(compile, 0, "test:unit must start from a clean compile");
  assert.ok(run > compile, "the lanes must run the freshly compiled tests");
  assert.ok(run < testUnit.indexOf("npm run test:calibration-producer"), "the lanes must finish before dist/schema is built");
});

test("every stage of test:unit that runs tests bounds each test at TEST_TIMEOUT_MS", () => {
  const launcher = readFileSync(path.join(root, "scripts", "run-schema-cli.mjs"), "utf8");
  let lanes = 0;
  let nodeTest = 0;
  for (const step of testUnitSteps()) {
    const [command, ...args] = step.split(" ");
    if (command !== "node") continue;
    const script = args.find((arg) => !arg.startsWith("-"));
    if (args.includes("--test")) {
      nodeTest += 1;
      assert.deepEqual(
        args.filter((arg) => /^--test-(?:timeout|force-exit)/.test(arg)),
        TEST_BOUND_FLAGS,
        `${step}\nmust carry ${TEST_BOUND_FLAGS.join(" ")}, each exactly once`
      );
    } else if (script === "scripts/unit-test-lanes.mjs") {
      // The lanes add TEST_BOUND_FLAGS to both lanes; the fixtures below prove it.
      lanes += 1;
    } else {
      // The dist/schema launcher names the file it runs in its own table.
      const name = args[args.indexOf(script) + 1];
      const target =
        script === "scripts/run-schema-cli.mjs"
          ? [...(launcher.match(new RegExp(`"${name}": \\[([^\\]]*)\\]`))?.[1] ?? "").matchAll(/"([^"]+)"/g)]
              .map((part) => part[1])
              .join("/")
          : script;
      if (!/\.test\.m?js$/.test(target)) continue;
      // A suite run as a plain script gets none of the flags. That is safe only
      // while every test in it is synchronous: only an asynchronous test can
      // wait forever on a promise.
      assert.doesNotMatch(
        readFileSync(path.join(root, target), "utf8"),
        /\basync\b|\bawait\b|\bPromise\b|\.then\(/,
        `${target} runs outside node --test, so an asynchronous test there has no bound; run it with ${TEST_BOUND_FLAGS.join(" ")} first`
      );
    }
  }
  assert.equal(lanes, 1, "test:unit must run the lib tests through the lanes exactly once");
  assert.ok(nodeTest > 0, "no node --test stage was found in test:unit");
});

test("TEST_TIMEOUT_MS lets two stuck tests fail by name inside CI's budget for the tests job", () => {
  const ci = readFileSync(path.join(root, ".github", "workflows", "ci.yml"), "utf8");
  const testsJob = ci.slice(ci.indexOf("\n  tests:"), ci.indexOf("\n  pages:"));
  assert.match(testsJob, /\n\s+run: npm run test:unit\n/, "the tests job no longer runs test:unit");
  const budget = Number(/\n {4}timeout-minutes: (\d+)\n/.exec(testsJob)?.[1]) * 60_000;
  assert.ok(budget > 0, "the tests job pins no timeout-minutes");
  assert.ok(Number.isInteger(TEST_TIMEOUT_MS) && TEST_TIMEOUT_MS > 0);
  // The suite itself needs about 14 of the job's minutes on a CI runner. With
  // each stuck test given at most a third of the budget, two of them in a row
  // still print node's "test timed out" before Actions cancels the job.
  assert.ok(
    3 * TEST_TIMEOUT_MS <= budget,
    `TEST_TIMEOUT_MS (${TEST_TIMEOUT_MS} ms) must stay within a third of the tests job's ${budget} ms`
  );
});

test("the partition keeps glob order, refuses stale or foreign entries, and never drops a file", () => {
  const files = ["a", "b", "c", "d"].map((name) => `.unit-test-dist/lib/${name}.test.js`);
  const lane = { "lib/b.test.ts": "launches a browser", "lib/d.test.ts": "asserts elapsed time" };
  assert.deepEqual(partitionCompiledTests(files, lane), {
    parallel: [files[0], files[2]],
    serial: [files[1], files[3]]
  });
  assert.throws(() => partitionCompiledTests(files, { "lib/gone.test.ts": "was deleted" }), /was not compiled/);
  assert.throws(() => partitionCompiledTests(files, { "lib/sub/x.test.ts": "nested" }), /not a top-level lib test/);
  assert.throws(() => partitionCompiledTests(files, { "lib/b.test.ts": " " }), /must state why/);
  assert.throws(() => partitionCompiledTests([...files, files[0]], lane), /given twice/);
  assert.throws(() => partitionCompiledTests([".unit-test-dist/lib/sub/x.test.js"], {}), /unexpected test path/);
  assert.throws(() => partitionCompiledTests([], {}), /matched nothing/);
  assert.throws(() => parseLaneArguments(["--alongside", "rm -rf /", files[0]]), /Usage/);
  assert.deepEqual(parseLaneArguments(["--alongside", "npm run side", files[0]]), {
    alongsideScript: "side",
    files: [files[0]]
  });
});

test("the lane reporter records each file's summary and never the run's cumulative one", async () => {
  async function* events() {
    yield { type: "test:pass", data: { name: "a test", nesting: 0, file: "/repo/.unit-test-dist/lib/a.test.js" } };
    yield { type: "test:summary", data: { file: "/repo/.unit-test-dist/lib/a.test.js", success: true, counts: {} } };
    yield { type: "test:summary", data: { file: undefined, success: true, counts: {} } };
  }
  const lines = [];
  for await (const line of fileSummaries(events())) lines.push(line);
  assert.deepEqual(lines, [`${JSON.stringify("/repo/.unit-test-dist/lib/a.test.js")}\n`]);
});

test("a file counts as finished only through its own summary, under any spelling of its path", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "unit-test-lanes-summary-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const real = path.join(dir, "real");
  await mkdir(path.join(real, ".unit-test-dist", "lib"), { recursive: true });
  const files = ["a", "b"].map((name) => `.unit-test-dist/lib/${name}.test.js`);
  for (const file of files) await writeFile(path.join(real, file), "");
  await symlink(real, path.join(dir, "link"));
  // a's process names itself through a symlink to the lane's directory; b's
  // summary never arrived.
  const log = path.join(dir, "summaries");
  await writeFile(log, `${JSON.stringify(path.join(dir, "link", files[0]))}\n`);
  assert.deepEqual(filesWithoutSummary(files, log, real), [files[1]]);
  assert.deepEqual(filesWithoutSummary(files, path.join(dir, "never-written"), real), files);
});

test("the stdout preload acts only in a lane test file's own process, and only where it was named", () => {
  // A test file's process as node --test starts it in a lane.
  const testFile = {
    env: { NODE_TEST_CONTEXT: "child-v8" },
    argv: [process.execPath, "/repo/.unit-test-dist/lib/a.test.js"],
    execArgv: [BLOCKING_STDOUT_PRELOAD, ...TEST_BOUND_FLAGS],
    mainThread: true
  };
  assert.equal(blocksStdoutIn(testFile), true);
  // node --test itself loads the preload too. Its argv[1] is its first test
  // file, and its stdout is the gate's own.
  assert.equal(
    blocksStdoutIn({ ...testFile, env: {}, argv: [process.execPath, ".unit-test-dist/lib/a.test.js"] }),
    false,
    "node --test itself"
  );
  // A worker thread loads --require preloads as well, and is handed any argv.
  assert.equal(blocksStdoutIn({ ...testFile, mainThread: false }), false, "a worker thread");
  // A program a test forks inherits NODE_TEST_CONTEXT and the preload.
  assert.equal(
    blocksStdoutIn({ ...testFile, argv: [process.execPath, "/repo/.unit-test-dist/lib/fixture-server.js"] }),
    false,
    "a forked program"
  );
  // A test file that imports the runner, as this one does, without the preload.
  assert.equal(
    blocksStdoutIn({ ...testFile, argv: [process.execPath, fileURLToPath(import.meta.url)], execArgv: [...TEST_BOUND_FLAGS] }),
    false,
    "a test file that only imports the runner"
  );
});

test("a test file's process says so on stderr when its stdout cannot be made blocking", async (t) => {
  // A file is not a stream libuv can switch, so setBlocking is unavailable
  // there, as it would be if a future node dropped the method.
  const dir = await mkdtemp(path.join(os.tmpdir(), "unit-test-lanes-preload-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const testFile = path.join(dir, "a.test.js");
  await writeFile(testFile, "");
  const stdout = openSync(path.join(dir, "stdout"), "w");
  let result;
  try {
    result = spawnSync(process.execPath, [BLOCKING_STDOUT_PRELOAD, testFile], {
      encoding: "utf8",
      timeout: FIXTURE_TIMEOUT_MS,
      stdio: ["ignore", stdout, "pipe"],
      env: { ...process.env, NODE_TEST_CONTEXT: "child-v8" }
    });
  } finally {
    closeSync(stdout);
  }
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /setBlocking on this test file's stdout returned undefined, so --test-force-exit can still drop/);
});

// Runs the real CLI over a throwaway package: three parallel tests, an
// alongside script and two serial tests, each appending its name to one log
// when it runs, and each test recording the bound flags its process was given
// and what STDOUT_PROBE found there. `fail` names the one piece that should
// fail; `writeDist` names a parallel test that also writes into dist/; `leak`
// names tests that pass but leave a server listening; `cut` names test files
// whose process exits 0 in a second test, before writing the summary that ends
// its results; `serialLane` replaces the lane.
async function runFixture(
  t,
  {
    fail = "none",
    writeDist = "none",
    leak = [],
    cut = [],
    serialLane = { "lib/s1.test.ts": "fixture serial test", "lib/s2.test.ts": "fixture serial test" }
  } = {}
) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "unit-test-lanes-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = path.join(dir, "finished.log");
  const boundLog = path.join(dir, "bound.log");
  const stdoutLog = path.join(dir, "stdout.log");
  const stdoutProbe = path.join(dir, "stdout-probe.js");
  await mkdir(path.join(dir, ".unit-test-dist", "lib"), { recursive: true });
  await mkdir(path.join(dir, "scripts"));
  await writeFile(stdoutProbe, STDOUT_PROBE);
  const body = (name) =>
    `const { appendFileSync, mkdirSync, writeFileSync } = require("node:fs");\n` +
    `require("node:test")(${JSON.stringify(name)}, async () => {\n` +
    `  appendFileSync(${JSON.stringify(log)}, ${JSON.stringify(`${name}\n`)});\n` +
    `  const bound = new Set(process.execArgv.filter((arg) => /^--test-(?:timeout|force-exit)/.test(arg)));\n` +
    `  appendFileSync(${JSON.stringify(boundLog)}, JSON.stringify([${JSON.stringify(name)}, ...bound]) + "\\n");\n` +
    `  const stdout = require(${JSON.stringify(stdoutProbe)})();\n` +
    `  appendFileSync(${JSON.stringify(stdoutLog)}, JSON.stringify([${JSON.stringify(name)}, stdout]) + "\\n");\n` +
    `  if (${JSON.stringify(leak)}.includes(${JSON.stringify(name)})) {\n` +
    `    const server = require("node:net").createServer();\n` +
    `    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));\n` +
    `  }\n` +
    `  if (${JSON.stringify(writeDist)} === ${JSON.stringify(name)}) {\n` +
    `    mkdirSync(${JSON.stringify(path.join(dir, "dist", "schema"))}, { recursive: true });\n` +
    `    writeFileSync(${JSON.stringify(path.join(dir, "dist", "schema", "rebuilt.js"))}, "");\n` +
    `  }\n` +
    `  if (${JSON.stringify(fail)} === ${JSON.stringify(name)}) throw new Error("deliberate failure");\n` +
    `});\n` +
    `if (${JSON.stringify(cut)}.includes(${JSON.stringify(name)})) {\n` +
    `  require("node:test")(${JSON.stringify(`${name} after the cut`)}, () => process.exit(0));\n` +
    `}\n`;
  const names = ["p1", "p2", "p3", "s1", "s2"];
  for (const name of names) {
    await writeFile(path.join(dir, ".unit-test-dist", "lib", `${name}.test.js`), body(name));
  }
  await writeFile(
    path.join(dir, "side.js"),
    `require("node:fs").appendFileSync(${JSON.stringify(log)}, "side\\n");\n` +
      `process.exit(${JSON.stringify(fail)} === "side" ? 3 : 0);\n`
  );
  await writeFile(path.join(dir, "package.json"), JSON.stringify({ private: true, scripts: { side: "node side.js" } }));
  await writeFile(path.join(dir, SERIAL_LANE_FILE), JSON.stringify(serialLane));
  const files = names.map((name) => `.unit-test-dist/lib/${name}.test.js`);
  const result = spawnSync(process.execPath, [runner, "--alongside", "npm run side", ...files], {
    cwd: dir,
    encoding: "utf8",
    timeout: FIXTURE_TIMEOUT_MS,
    // node:test marks its own children through NODE_TEST_CONTEXT, and a nested
    // `node --test` that inherits it skips its files instead of running them.
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== "NODE_TEST_CONTEXT")),
      npm_config_update_notifier: "false"
    }
  });
  const output = `${result.stdout}${result.stderr}`;
  // A killed run has no exit status, which the failure cases' notEqual(status,
  // 0) would read as a failing lane, so a run that never finished fails here.
  assert.equal(result.error, undefined, `the lanes did not finish within ${FIXTURE_TIMEOUT_MS} ms:\n${output}`);
  assert.equal(result.signal, null, `the lanes were killed by ${result.signal}:\n${output}`);
  const finished = (await readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean);
  const bound = new Map(
    (await readFile(boundLog, "utf8").catch(() => ""))
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [name, ...flags] = JSON.parse(line);
        return [name, flags.sort()];
      })
  );
  const stdout = new Map(
    (await readFile(stdoutLog, "utf8").catch(() => ""))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  );
  return { status: result.status, output, finished, bound, stdout };
}

test("the serial lane starts only after the parallel lane and the alongside command both pass", async (t) => {
  const { status, output, finished } = await runFixture(t);
  assert.equal(status, 0, output);
  assert.deepEqual([...finished].sort(), ["p1", "p2", "p3", "s1", "s2", "side"]);
  const firstSerial = Math.min(finished.indexOf("s1"), finished.indexOf("s2"));
  for (const earlier of ["p1", "p2", "p3", "side"]) assert.ok(finished.indexOf(earlier) < firstSerial, earlier);
  assert.ok(finished.indexOf("s1") < finished.indexOf("s2"), "the serial lane keeps glob order");
  // The lanes name a reporter of their own, which replaces node's default, so
  // spec's lines on stdout must still be there. FORCE_COLOR would colour them.
  const plain = output.replace(/\x1b\[[0-9;]*m/g, "");
  for (const name of ["p1", "p2", "p3", "s1", "s2"]) assert.match(plain, new RegExp(`^✔ ${name} \\(`, "m"), name);
});

test("both lanes run every lib test file under TEST_BOUND_FLAGS", async (t) => {
  const { status, output, bound } = await runFixture(t);
  assert.equal(status, 0, output);
  for (const name of ["p1", "p2", "p3", "s1", "s2"]) {
    assert.deepEqual(bound.get(name), [...TEST_BOUND_FLAGS].sort(), `${name} ran without ${TEST_BOUND_FLAGS.join(" ")}`);
  }
});

test("both lanes give every lib test file's process a blocking stdout, so force-exit finds no results queued", async (t) => {
  // On 2026-10-21 --test-force-exit dropped the last 45 of a file's results
  // while they waited in its process for node --test to read them. A blocking
  // stdout cannot hold any back.
  const { status, output, stdout } = await runFixture(t);
  assert.equal(status, 0, output);
  for (const name of ["p1", "p2", "p3", "s1", "s2"]) {
    const found = stdout.get(name);
    assert.equal(found?.preloaded, true, `${name}'s process was started without ${BLOCKING_STDOUT_PRELOAD}`);
    assert.equal(found.flagVisible, true, `${name} could not see O_NONBLOCK on its stdout, so its reading proves nothing`);
    assert.equal(found.blocking, true, `${name}'s stdout does not block`);
  }
  assert.doesNotMatch(output, /setBlocking on this test file's stdout/);
});

test("a lib test that passes but leaves a server listening does not hold its lane open", async (t) => {
  // The server keeps that file's process alive after its last test and node
  // --test waits for the process, so without --test-force-exit neither lane ends.
  const { status, output, finished } = await runFixture(t, { leak: ["p2", "s1"] });
  assert.equal(status, 0, output);
  assert.deepEqual([...finished].sort(), ["p1", "p2", "p3", "s1", "s2", "side"]);
});

for (const [failing, where] of [
  ["p2", "a parallel lib test"],
  ["side", "the alongside command"],
  ["s2", "a serial lib test"]
]) {
  test(`the lanes fail when ${where} fails`, async (t) => {
    const { status, output, finished } = await runFixture(t, { fail: failing });
    assert.notEqual(status, 0, output);
    assert.ok(finished.includes(failing), `${failing} must have run`);
    if (failing !== "s2") {
      assert.ok(!finished.includes("s1") && !finished.includes("s2"), "no serial test may start after a failure");
      assert.match(output, /stopped before the serial lane/);
    }
  });
}

// node --test passes a file whose process exits 0 on whatever results reached
// it. A process that exits before its tests end is the plain case. On
// 2026-10-21 a gate passed a file that had delivered 51 of its 96 results, and
// --test-force-exit ending a process while its results are still queued
// reproduces that.
for (const [cut, lane] of [
  ["p2", "Parallel lib lane (3 files)"],
  ["s1", "Serial lib lane (2 files)"]
]) {
  test(`the lanes fail when ${cut}'s results stop short, though its process exits 0`, async (t) => {
    const { status, output, finished } = await runFixture(t, { cut: [cut] });
    assert.notEqual(status, 0, output);
    assert.ok(finished.includes(cut), `${cut} must have run`);
    assert.match(output, new RegExp(`${lane.replace(/[()]/g, "\\$&")} exited 0 but did not pass`));
    assert.match(output, new RegExp(`One of its files ended without the summary .*: \\.unit-test-dist/lib/${cut}\\.test\\.js\\.`));
    if (cut === "p2") {
      assert.ok(!finished.includes("s1") && !finished.includes("s2"), "no serial test may start after a cut");
      assert.match(output, /stopped before the serial lane/);
    }
  });
}

test("a file whose results stop short is named even when another file has failed its lane", async (t) => {
  // A failure the lost results held would show only as node's bare "test
  // failed" for the file, so the cut must be named beside it.
  const { status, output } = await runFixture(t, { fail: "p1", cut: ["p2"] });
  assert.notEqual(status, 0, output);
  assert.match(output, /Parallel lib lane \(3 files\) failed with exit code 1/);
  assert.match(output, /One of its files ended without the summary .*: \.unit-test-dist\/lib\/p2\.test\.js\./);
});

test("an empty lane is skipped, never handed to node --test with no files", async (t) => {
  // With no file arguments node --test falls back to discovering every test
  // file under the working directory, which would run unrelated suites.
  const { status, output, finished } = await runFixture(t, { serialLane: {} });
  assert.equal(status, 0, output);
  assert.deepEqual([...finished].sort(), ["p1", "p2", "p3", "s1", "s2", "side"]);
  assert.match(output, /Serial lib lane \(0 files\) skipped: no files/);
});

test("the lanes fail when the parallel phase rewrites dist/, even if every test passes", async (t) => {
  const { status, output, finished } = await runFixture(t, { writeDist: "p3" });
  assert.notEqual(status, 0, output);
  assert.match(output, /changed dist\/ while other tests could read it: dist\/schema/);
  assert.ok(!finished.includes("s1") && !finished.includes("s2"), "no serial test may start after a dist/ rewrite");
});
