import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

// What scripts/tla-checks.mjs decides without Java: which bytes it accepts as
// the pinned tools, and which receipts it accepts as showing that checks
// passed. TLC itself runs in .github/workflows/tla-checks.yml and by hand;
// nothing here starts it. The last test holds that workflow to what its
// header says of it.

type Pin = { url: string; bytes: number; sha256: string; directory: string };
type RuntimePins = { schemaVersion: number; release: string; archives: Record<string, Pin> };
type JarPins = { tla2tools: { release: string; url: string; bytes: number; sha256: string }; artifacts: Record<string, string> };
type CheckEntry = {
  id: string;
  script: string;
  arguments: string[];
  exportSha256: string | null;
  treeCleanBefore: boolean;
  treeCleanAfter: boolean;
  exitStatus: number | null;
  seconds: number;
  lastLine: string;
};
type Receipt = {
  schemaVersion: number;
  kind: string;
  source: { commit: string; tree: string };
  runner: { platform: string; node: string };
  java: { version: string; pinnedArchiveSha256: string | null };
  tla2tools: { release: string; sha256: string };
  checks: CheckEntry[];
};
type Helpers = {
  JAR_PINS_PATH: string;
  RUNTIME_PINS_PATH: string;
  RECEIPT_KIND: string;
  CHECKS: Record<string, { script: string; arguments: string[]; export: string | null }>;
  runtimePin(pins: RuntimePins, platform: string): Pin;
  assertPinned(name: string, bytes: Buffer, pin: { bytes: number; sha256: string }): void;
  receiptProblems(receipt: unknown, expected: { commit: string; require: string[]; pins: JarPins }): string[];
};

const root = process.cwd();
const nativeImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<Helpers>;
const helpers = nativeImport(pathToFileURL(path.join(root, "scripts", "tla-checks.mjs")).href);
const source = (file: string): string => readFileSync(path.join(root, file), "utf8");
const json = <T>(file: string): T => JSON.parse(source(file)) as T;
const sha256 = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");

const COMMIT = "a".repeat(40);

async function goodReceipt(ids: string[]): Promise<{ receipt: Receipt; pins: JarPins }> {
  const { CHECKS, RECEIPT_KIND, JAR_PINS_PATH } = await helpers;
  const pins = json<JarPins>(JAR_PINS_PATH);
  const receipt: Receipt = {
    schemaVersion: 1,
    kind: RECEIPT_KIND,
    source: { commit: COMMIT, tree: "b".repeat(40) },
    runner: { platform: "linux-x64", node: "v24.14.1" },
    java: { version: "openjdk version", pinnedArchiveSha256: "c".repeat(64) },
    tla2tools: { release: pins.tla2tools.release, sha256: pins.tla2tools.sha256 },
    checks: ids.map((id) => ({
      id,
      script: CHECKS[id].script,
      arguments: [...CHECKS[id].arguments],
      exportSha256: CHECKS[id].export === null ? null : pins.artifacts[CHECKS[id].export as string],
      treeCleanBefore: true,
      treeCleanAfter: true,
      exitStatus: 0,
      seconds: 1,
      lastLine: ""
    }))
  };
  return { receipt, pins };
}

test("the pinned Java runtime is one archive of a release page, by size and SHA-256, and no other platform has one", async () => {
  const { runtimePin, RUNTIME_PINS_PATH } = await helpers;
  const pins = json<RuntimePins>(RUNTIME_PINS_PATH);
  assert.deepEqual(Object.keys(pins.archives), ["linux-x64"]);
  const pin = runtimePin(pins, "linux-x64");
  assert.match(pin.url, /^https:\/\/github\.com\/adoptium\/temurin21-binaries\/releases\/download\//);
  assert.match(pin.sha256, /^[0-9a-f]{64}$/);
  assert.ok(pin.url.includes(encodeURIComponent(pins.release)), "the archive is of the release the file names");
  assert.throws(() => runtimePin(pins, "darwin-arm64"), /No Java runtime is pinned for darwin-arm64/);
  for (const broken of [
    { ...pin, url: "http://github.com/adoptium/x" },
    { ...pin, url: "https://example.org/x" },
    { ...pin, sha256: pin.sha256.slice(1) },
    { ...pin, bytes: 0 },
    { ...pin, directory: "../elsewhere" }
  ]) {
    assert.throws(() => runtimePin({ ...pins, archives: { "linux-x64": broken } }, "linux-x64"), /has no usable/);
  }
});

test("bytes are accepted as a pinned tool only at the pinned size and SHA-256", async () => {
  const { assertPinned } = await helpers;
  const bytes = Buffer.from("the pinned bytes");
  const pin = { bytes: bytes.length, sha256: sha256(bytes) };
  assertPinned("a file", bytes, pin);
  assert.throws(() => assertPinned("a file", Buffer.concat([bytes, Buffer.from("x")]), pin), /is 17 bytes, and 16 are pinned/);
  assert.throws(() => assertPinned("a file", Buffer.from("the pinned bytez"), pin), /has SHA-256 .* is pinned/);
});

test("the jar the workflow downloads is the one the exports record", async () => {
  const { JAR_PINS_PATH } = await helpers;
  const pins = json<JarPins>(JAR_PINS_PATH);
  for (const file of ["specs/case-machine/conformance.json", "specs/worker-hold/conformance.json"]) {
    const exported = json<{ tla2tools: string }>(file);
    assert.equal(exported.tla2tools, pins.tla2tools.sha256, file);
    assert.equal(pins.artifacts[file], sha256(readFileSync(path.join(root, file))), `${file} is the export the pins name`);
  }
});

test("a receipt shows its checks passed only when each required check is there once, passed, on a clean tree, at the commit", async () => {
  const { receiptProblems } = await helpers;
  const all = ["hold", "hold-faults", "case", "case-faults"];
  const { receipt, pins } = await goodReceipt(all);
  const expected = { commit: COMMIT, require: all, pins };
  assert.deepEqual(receiptProblems(receipt, expected), []);
  assert.deepEqual(receiptProblems({ ...receipt, checks: receipt.checks.slice(0, 2) }, { ...expected, require: ["hold", "hold-faults"] }), []);

  const withCheck = (at: number, change: Partial<CheckEntry>): Receipt => ({
    ...receipt,
    checks: receipt.checks.map((entry, index) => (index === at ? { ...entry, ...change } : entry))
  });
  const refused: [string, unknown, RegExp][] = [
    ["another commit", { ...receipt, source: { ...receipt.source, commit: "d".repeat(40) } }, /is of commit d+, not a+/],
    ["another kind", { ...receipt, kind: "something-else" }, /another kind or version/],
    ["another jar", { ...receipt, tla2tools: { ...receipt.tla2tools, sha256: "e".repeat(64) } }, /a jar other than the pinned one/],
    ["a check that failed", withCheck(0, { exitStatus: 1 }), /hold exited 1/],
    ["a check a signal ended", withCheck(2, { exitStatus: null }), /case exited null/],
    ["a tree dirty before", withCheck(1, { treeCleanBefore: false }), /hold-faults did not run on a clean tree/],
    ["a tree left changed", withCheck(0, { treeCleanAfter: false }), /hold did not run on a clean tree, or left it changed/],
    ["another export", withCheck(0, { exportSha256: "f".repeat(64) }), /hold compared an export other than the one/],
    ["another script", withCheck(3, { script: "scripts/other.mjs" }), /case-faults is not a check of this script/],
    ["a required check missing", { ...receipt, checks: receipt.checks.slice(1) }, /hold is in the receipt 0 times, not once/],
    ["a required check twice", { ...receipt, checks: [...receipt.checks, receipt.checks[0]] }, /hold is in the receipt 2 times, not once/],
    ["a field more", { ...receipt, note: "passed" }, /does not hold exactly its fields/],
    ["a check with a field more", { ...receipt, checks: [{ ...receipt.checks[0], note: "passed" }, ...receipt.checks.slice(1)] }, /a check does not hold exactly its fields/],
    ["no list of checks", { ...receipt, checks: "all" }, /holds no list of checks/]
  ];
  for (const [what, broken, message] of refused) {
    const problems = receiptProblems(broken, expected);
    assert.ok(problems.some((problem) => message.test(problem)), `${what}: ${JSON.stringify(problems)}`);
  }
});

test("the workflow checks the hold on every push, the case machine by schedule and by hand, and nothing reads its conclusion", async () => {
  const { CHECKS } = await helpers;
  const workflow = source(".github/workflows/tla-checks.yml");
  assert.equal(/^name: (.+)$/m.exec(workflow)?.[1], "TLA Checks");
  const jobNames = [...workflow.matchAll(/^    name: (.+)$/gm)].map((match) => match[1]);
  assert.deepEqual(jobNames, ["TLC Export and Fault Checks", "Attest the TLA checks receipt"]);
  const required = json<{ jobs: string[] }>(".github/required-ci-jobs.json");
  for (const job of jobNames) assert.equal(required.jobs.includes(job), false, `${job} is a required job`);
  for (const file of readdirSync(path.join(root, ".github/workflows")).filter((entry) => entry !== "tla-checks.yml")) {
    assert.equal(/TLA Checks|tla-checks\.yml/.test(source(`.github/workflows/${file}`)), false, `${file} names the TLA checks workflow`);
  }

  assert.match(workflow, /^on:\n  push:\n    branches:\n      - main\n  schedule:\n(?:    #.*\n)*    - cron: "17 5 \* \* 1"\n  workflow_dispatch:\n/m);
  assert.doesNotMatch(workflow, /pull_request|continue-on-error|secrets\.|contents: write/);
  assert.match(workflow, /^permissions:\n  contents: read\n/m);

  const [checkJob, attestJob] = workflow.split(/^  attest:\n/m);
  assert.ok(attestJob !== undefined);
  // The job that runs the commit's code can sign nothing, and the job that
  // signs runs none of the commit's code.
  assert.doesNotMatch(checkJob, /id-token|attestations/);
  assert.doesNotMatch(attestJob, /actions\/checkout|npm ci|scripts\//);
  assert.match(attestJob, /needs:\n      - tla-checks\n    if: github\.ref == 'refs\/heads\/main'\n/);
  assert.match(attestJob, /uses: actions\/attest@[0-9a-f]{40} # v/);

  const step = (id: string): string => {
    const match = new RegExp(`      - name: [^\\n]+\\n(?:        if: [^\\n]+\\n)?        run: >-\\n          node scripts/tla-checks\\.mjs run ${id}\\n[^]*?(?=\\n\\n)`).exec(checkJob);
    assert.ok(match, `no step runs ${id}`);
    return match[0];
  };
  assert.deepEqual(Object.keys(CHECKS), ["hold", "hold-faults", "case", "case-faults"]);
  for (const id of ["hold", "hold-faults"]) assert.doesNotMatch(step(id), /\n        if: /, `${id} runs on every event`);
  for (const id of ["case", "case-faults"]) assert.match(step(id), /\n        if: env\.WITH_CASE_MACHINE == 'true'\n/, `${id} runs by schedule and by hand`);
  assert.match(checkJob, /WITH_CASE_MACHINE: \$\{\{ github\.event_name == 'schedule' \|\| \(github\.event_name == 'workflow_dispatch' && inputs\.case_machine\) \}\}\n/);

  // The tools come from the pinned archives, before any check, and the
  // receipt is held to the commit and to the checks that ran before it is kept.
  const order = [
    'node scripts/tla-checks.mjs tools --into "$RUNNER_TEMP/tla-tools"',
    "node scripts/tla-checks.mjs run hold\n",
    "node scripts/tla-checks.mjs run hold-faults\n",
    "node scripts/tla-checks.mjs run case\n",
    "node scripts/tla-checks.mjs run case-faults\n",
    'node scripts/tla-checks.mjs verify --receipt "$RECEIPT" --commit "$GITHUB_SHA"',
    "      - name: Preserve the receipt\n        if: always()\n"
  ].map((text) => checkJob.indexOf(text));
  assert.ok(order.every((at) => at > 0), JSON.stringify(order));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.match(checkJob, /--require "\$\{\{ env\.WITH_CASE_MACHINE == 'true' && 'hold,hold-faults,case,case-faults' \|\| 'hold,hold-faults' \}\}"/);
  assert.doesNotMatch(checkJob, /setup-java|JAVA_HOME/);
});
