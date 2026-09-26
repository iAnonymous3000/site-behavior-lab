import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  SERIAL_LANE_FILE,
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

// Runs the real CLI over a throwaway package: three parallel tests, an
// alongside script and two serial tests, each appending its name to one log
// when it runs. `fail` names the one piece that should fail; `writeDist` names
// a parallel test that also writes into dist/; `serialLane` replaces the lane.
async function runFixture(
  t,
  { fail = "none", writeDist = "none", serialLane = { "lib/s1.test.ts": "fixture serial test", "lib/s2.test.ts": "fixture serial test" } } = {}
) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "unit-test-lanes-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = path.join(dir, "finished.log");
  await mkdir(path.join(dir, ".unit-test-dist", "lib"), { recursive: true });
  await mkdir(path.join(dir, "scripts"));
  const body = (name) =>
    `const { appendFileSync, mkdirSync, writeFileSync } = require("node:fs");\n` +
    `require("node:test")(${JSON.stringify(name)}, () => {\n` +
    `  appendFileSync(${JSON.stringify(log)}, ${JSON.stringify(`${name}\n`)});\n` +
    `  if (${JSON.stringify(writeDist)} === ${JSON.stringify(name)}) {\n` +
    `    mkdirSync(${JSON.stringify(path.join(dir, "dist", "schema"))}, { recursive: true });\n` +
    `    writeFileSync(${JSON.stringify(path.join(dir, "dist", "schema", "rebuilt.js"))}, "");\n` +
    `  }\n` +
    `  if (${JSON.stringify(fail)} === ${JSON.stringify(name)}) throw new Error("deliberate failure");\n` +
    `});\n`;
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
    // node:test marks its own children through NODE_TEST_CONTEXT, and a nested
    // `node --test` that inherits it skips its files instead of running them.
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== "NODE_TEST_CONTEXT")),
      npm_config_update_notifier: "false"
    }
  });
  const finished = (await readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean);
  return { status: result.status, output: `${result.stdout}${result.stderr}`, finished };
}

test("the serial lane starts only after the parallel lane and the alongside command both pass", async (t) => {
  const { status, output, finished } = await runFixture(t);
  assert.equal(status, 0, output);
  assert.deepEqual([...finished].sort(), ["p1", "p2", "p3", "s1", "s2", "side"]);
  const firstSerial = Math.min(finished.indexOf("s1"), finished.indexOf("s2"));
  for (const earlier of ["p1", "p2", "p3", "side"]) assert.ok(finished.indexOf(earlier) < firstSerial, earlier);
  assert.ok(finished.indexOf("s1") < finished.indexOf("s2"), "the serial lane keeps glob order");
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
