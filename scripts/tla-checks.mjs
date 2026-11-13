#!/usr/bin/env node

// Runs TLC where a hosted runner can: the workflow .github/workflows/tla-checks.yml calls this
// script, and a person with the two archives can call it by hand.
//
//   tools --into <dir>
//       Download the pinned tla2tools.jar and the pinned Java runtime for this platform, refuse
//       either unless its size and SHA-256 are the pinned ones, and unpack the runtime. Prints
//       the two paths as JSON.
//   run <check> --jar <jar> --java <java> --receipt <file> [--heap 6g] [--workers 4]
//       Run one check as a child and add what it did to the receipt, whatever its exit status.
//       The checks:
//         hold            scripts/tla-worker-hold-export.mjs --check
//         hold-faults     scripts/tla-worker-hold-mutations.mjs
//         case            scripts/tla-case-machine-export.mjs --check
//         case-faults     scripts/tla-case-machine-mutations.mjs
//       Exits with the child's status.
//   verify --receipt <file> --commit <sha> --require <check,check>
//       Fail unless the receipt is of that commit, on a clean tree, with each required check
//       present once and passed.
//
// What a receipt says, and what it does not. An export check that passed says TLC, run on that
// runner from the files of that commit, wrote byte for byte the export the commit holds. A fault
// run that passed says each seeded fault of the specification was caught by the invariant or row
// named for it. Neither says anything of the real code: the conformance suites in the unit tests
// hold the code to the export. The receipt is written by this script, on the runner that ran
// TLC; a signature over it shows which workflow run produced the file, not that TLC is right.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const JAR_PINS_PATH = "specs/tla-tools.json";
export const RUNTIME_PINS_PATH = "specs/tla-ci-runtime.json";
export const RECEIPT_KIND = "site-behavior-lab-tla-checks-receipt";

/** Each check: the script it runs, what the script must have compiled first, and the export it compares. */
export const CHECKS = {
  hold: { script: "scripts/tla-worker-hold-export.mjs", arguments: ["--check"], export: "specs/worker-hold/conformance.json", takesHeap: false, takesWorkers: true },
  "hold-faults": { script: "scripts/tla-worker-hold-mutations.mjs", arguments: [], export: null, takesHeap: false, takesWorkers: false },
  case: { script: "scripts/tla-case-machine-export.mjs", arguments: ["--check"], export: "specs/case-machine/conformance.json", takesHeap: true, takesWorkers: true },
  "case-faults": { script: "scripts/tla-case-machine-mutations.mjs", arguments: [], export: null, takesHeap: false, takesWorkers: false }
};

const RECEIPT_KEYS = ["schemaVersion", "kind", "source", "runner", "java", "tla2tools", "checks"];
const CHECK_KEYS = ["id", "script", "arguments", "exportSha256", "treeCleanBefore", "treeCleanAfter", "exitStatus", "seconds", "lastLine"];

const sha256Of = (bytes) => createHash("sha256").update(bytes).digest("hex");
const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));

function option(args, name) {
  const at = args.indexOf(name);
  return at < 0 ? undefined : args[at + 1];
}

function required(args, name) {
  const value = option(args, name);
  if (value === undefined || value === "") throw new Error(`Give ${name} <value>`);
  return value;
}

function git(args) {
  const result = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

const treeClean = () => git(["status", "--porcelain"]) === "";

/** The runtime archive pinned for a platform, or a refusal that names the platforms that have one. */
export function runtimePin(pins, platform) {
  const pin = pins.archives[platform];
  if (pin === undefined) throw new Error(`No Java runtime is pinned for ${platform}; pinned: ${Object.keys(pins.archives).join(", ")}`);
  for (const [field, pattern] of [["url", /^https:\/\/github\.com\/adoptium\//], ["sha256", /^[0-9a-f]{64}$/], ["directory", /^[A-Za-z0-9._+-]+$/]]) {
    if (typeof pin[field] !== "string" || !pattern.test(pin[field])) throw new Error(`The runtime pin for ${platform} has no usable ${field}`);
  }
  if (!Number.isSafeInteger(pin.bytes) || pin.bytes <= 0) throw new Error(`The runtime pin for ${platform} has no usable size`);
  return pin;
}

/** Bytes that are exactly the pinned ones, or a refusal that says which reading differed. */
export function assertPinned(name, bytes, pin) {
  if (bytes.length !== pin.bytes) throw new Error(`${name} is ${bytes.length} bytes, and ${pin.bytes} are pinned`);
  const digest = sha256Of(bytes);
  if (digest !== pin.sha256) throw new Error(`${name} has SHA-256 ${digest}, and ${pin.sha256} is pinned`);
}

function download(url, file) {
  const result = spawnSync("curl", ["--fail", "--silent", "--show-error", "--location", "--proto", "=https", "--tlsv1.2", "--max-time", "300", "--output", file, url], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`Could not download ${url}: ${result.stderr.trim()}`);
}

function tools(args) {
  const into = resolve(required(args, "--into"));
  mkdirSync(into, { recursive: true });
  const jarPin = readJson(join(ROOT, JAR_PINS_PATH)).tla2tools;
  const platform = `${process.platform}-${process.arch}`;
  const runtime = runtimePin(readJson(join(ROOT, RUNTIME_PINS_PATH)), platform);

  const jar = join(into, "tla2tools.jar");
  download(jarPin.url, jar);
  assertPinned("tla2tools.jar", readFileSync(jar), jarPin);

  const archive = join(into, "java-runtime.tar.gz");
  download(runtime.url, archive);
  assertPinned("The Java runtime archive", readFileSync(archive), runtime);
  const unpacked = spawnSync("tar", ["-xzf", archive, "-C", into], { encoding: "utf8" });
  if (unpacked.status !== 0) throw new Error(`Could not unpack the Java runtime: ${unpacked.stderr.trim()}`);
  const java = join(into, runtime.directory, "bin", "java");
  if (!existsSync(java)) throw new Error(`The Java runtime archive holds no ${runtime.directory}/bin/java`);
  console.log(JSON.stringify({ jar, java }));
}

function javaVersion(java) {
  const result = spawnSync(java, ["-version"], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${java} -version failed`);
  return `${result.stderr}${result.stdout}`.trim().split("\n")[0];
}

function newReceipt(java, jar) {
  const jarPin = readJson(join(ROOT, JAR_PINS_PATH)).tla2tools;
  assertPinned("tla2tools.jar", readFileSync(jar), jarPin);
  const platform = `${process.platform}-${process.arch}`;
  const runtimePins = readJson(join(ROOT, RUNTIME_PINS_PATH));
  return {
    schemaVersion: 1,
    kind: RECEIPT_KIND,
    source: { commit: git(["rev-parse", "HEAD"]), tree: git(["rev-parse", "HEAD^{tree}"]) },
    runner: { platform, node: process.version },
    java: { version: javaVersion(java), pinnedArchiveSha256: runtimePins.archives[platform]?.sha256 ?? null },
    tla2tools: { release: jarPin.release, sha256: jarPin.sha256 },
    checks: []
  };
}

function run(args) {
  const id = args[0];
  const check = CHECKS[id];
  if (check === undefined) throw new Error(`Unknown check ${id}; the checks are ${Object.keys(CHECKS).join(", ")}`);
  const jar = resolve(required(args, "--jar"));
  const java = resolve(required(args, "--java"));
  const receiptPath = resolve(required(args, "--receipt"));
  const receipt = existsSync(receiptPath) ? readJson(receiptPath) : newReceipt(java, jar);
  if (receipt.source.commit !== git(["rev-parse", "HEAD"])) throw new Error("The receipt is of another commit");
  if (receipt.checks.some((entry) => entry.id === id)) throw new Error(`The receipt already holds ${id}`);

  const childArguments = [check.script, "--jar", jar, "--java", java, ...check.arguments];
  if (check.takesHeap && option(args, "--heap") !== undefined) childArguments.push("--heap", option(args, "--heap"));
  if (check.takesWorkers && option(args, "--workers") !== undefined) childArguments.push("--workers", option(args, "--workers"));
  // An export check that fails keeps what TLC exported beside the receipt, so the difference can be read.
  const candidate = check.export === null ? null : join(dirname(receiptPath), `tla-${id}-export-candidate.json`);
  if (candidate !== null) {
    mkdirSync(dirname(candidate), { recursive: true });
    childArguments.push("--candidate", candidate);
  }
  const treeCleanBefore = treeClean();
  const started = Date.now();
  const child = spawnSync(process.execPath, childArguments, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], maxBuffer: 256 * 1024 * 1024 });
  const seconds = Math.round((Date.now() - started) / 1000);
  process.stdout.write(child.stdout ?? "");
  const lines = (child.stdout ?? "").trim().split("\n").filter((line) => line !== "");
  receipt.checks.push({
    id,
    script: check.script,
    // The paths of the jar, the runtime and the kept candidate are the runner's own and say nothing of the commit.
    arguments: childArguments.slice(1).filter((argument, at, all) => !["--jar", "--java", "--candidate"].includes(argument) && !["--jar", "--java", "--candidate"].includes(all[at - 1])),
    exportSha256: check.export === null ? null : sha256Of(readFileSync(join(ROOT, check.export))),
    treeCleanBefore,
    treeCleanAfter: treeClean(),
    exitStatus: child.status,
    seconds,
    lastLine: (lines.at(-1) ?? "").slice(0, 300)
  });
  mkdirSync(dirname(receiptPath), { recursive: true });
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  process.exitCode = child.status === 0 ? 0 : 1;
}

const exactKeys = (value, keys) => value !== null && typeof value === "object" && !Array.isArray(value) && JSON.stringify(Object.keys(value)) === JSON.stringify(keys);

/** Every way a receipt fails to show that the required checks passed at a commit; empty when it shows it. */
export function receiptProblems(receipt, { commit, require: requiredChecks, pins }) {
  const problems = [];
  if (!exactKeys(receipt, RECEIPT_KEYS)) return ["the receipt does not hold exactly its fields, in order"];
  if (receipt.schemaVersion !== 1 || receipt.kind !== RECEIPT_KIND) problems.push("the receipt is of another kind or version");
  if (receipt.source?.commit !== commit) problems.push(`the receipt is of commit ${receipt.source?.commit}, not ${commit}`);
  if (receipt.tla2tools?.sha256 !== pins.tla2tools.sha256) problems.push("the receipt names a jar other than the pinned one");
  if (!Array.isArray(receipt.checks)) return [...problems, "the receipt holds no list of checks"];
  for (const entry of receipt.checks) {
    if (!exactKeys(entry, CHECK_KEYS)) {
      problems.push("a check does not hold exactly its fields, in order");
      continue;
    }
    if (CHECKS[entry.id] === undefined || CHECKS[entry.id].script !== entry.script) problems.push(`${entry.id} is not a check of this script`);
    if (entry.exitStatus !== 0) problems.push(`${entry.id} exited ${entry.exitStatus}`);
    if (entry.treeCleanBefore !== true || entry.treeCleanAfter !== true) problems.push(`${entry.id} did not run on a clean tree, or left it changed`);
    const exported = CHECKS[entry.id]?.export;
    if (exported !== undefined && exported !== null && entry.exportSha256 !== pins.artifacts[exported]) {
      problems.push(`${entry.id} compared an export other than the one ${JAR_PINS_PATH} names`);
    }
  }
  for (const id of requiredChecks) {
    const count = receipt.checks.filter((entry) => entry.id === id).length;
    if (count !== 1) problems.push(`${id} is in the receipt ${count} times, not once`);
  }
  return problems;
}

function verify(args) {
  const receipt = readJson(resolve(required(args, "--receipt")));
  const problems = receiptProblems(receipt, {
    commit: required(args, "--commit"),
    require: required(args, "--require").split(","),
    pins: readJson(join(ROOT, JAR_PINS_PATH))
  });
  if (problems.length > 0) throw new Error(`The receipt does not show the checks passed:\n- ${problems.join("\n- ")}`);
  console.log(`The receipt shows ${receipt.checks.map((entry) => entry.id).join(", ")} passed at ${receipt.source.commit}.`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, ...rest] = process.argv.slice(2);
  try {
    if (command === "tools") tools(rest);
    else if (command === "run") run(rest);
    else if (command === "verify") verify(rest);
    else throw new Error("Usage: tla-checks.mjs tools --into <dir> | run <check> --jar <jar> --java <java> --receipt <file> | verify --receipt <file> --commit <sha> --require <checks>");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
