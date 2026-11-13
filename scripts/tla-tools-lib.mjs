// What the TLA+ export scripts share: the pinned jar, one way of running TLC and reading what it
// prints, and the layout of the files they write. Nothing here runs in the unit tests: the
// conformance suites read the files these scripts write and never start Java. The workflow
// tla-checks.yml runs the export and fault scripts on a hosted runner.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const PINS = join(ROOT, "specs", "tla-tools.json");

export const sha256Of = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function option(name) {
  const at = process.argv.indexOf(name);
  return at < 0 ? undefined : process.argv[at + 1];
}

/** The jar and the Java to run it with, from the command line, held to the SHA-256 specs/tla-tools.json pins. */
export function pinnedTools() {
  const jar = option("--jar");
  if (jar === undefined || !existsSync(jar)) throw new Error("Give the pinned tla2tools.jar with --jar <path>");
  const pins = JSON.parse(readFileSync(PINS, "utf8"));
  const digest = sha256Of(readFileSync(jar));
  if (digest !== pins.tla2tools.sha256) throw new Error(`The jar's SHA-256 is ${digest}, and specs/tla-tools.json pins ${pins.tla2tools.sha256}`);
  return { jar, java: option("--java") ?? "java", pins, jarSha256: digest };
}

/**
 * What an export was produced by and from, as SHA-256 values an export writes into itself: the
 * export script with every module of this directory it imports (`scripts`, paths from the
 * repository's root), each specification file and each committed configuration TLC read
 * (`specification` and `configurations`, names in `specDir`), and the jar. The conformance suites
 * compute the same map from the files as they stand, the jar aside, and fail on any difference: an
 * export then names the script that wrote it, and a script, a specification or a configuration
 * edited since no longer matches the export beside it.
 */
export function provenanceOf({ scripts, specDir, specification, configurations, jarSha256 }) {
  const digestsOf = (directory, names) => Object.fromEntries(names.map((name) => [name, sha256Of(readFileSync(join(directory, name)))]));
  return { producedBy: digestsOf(ROOT, scripts), specification: digestsOf(specDir, specification), configurations: digestsOf(specDir, configurations), tla2tools: jarSha256 };
}

/** The same map from the files as they stand, for a suite that has no jar: the jar's digest is the export's own word, held to the pin. */
export function provenanceNow(exported, specDir) {
  return provenanceOf({ scripts: Object.keys(exported.producedBy ?? {}), specDir, specification: Object.keys(exported.specification ?? {}), configurations: Object.keys(exported.configurations ?? {}), jarSha256: exported.tla2tools });
}

/** Records an exported file's digest beside the jar's pin. */
export function pinArtifact(path, text) {
  const pins = JSON.parse(readFileSync(PINS, "utf8"));
  pins.artifacts = { ...(pins.artifacts ?? {}), [path]: sha256Of(text) };
  writeFileSync(PINS, `${JSON.stringify(pins, null, 2)}\n`);
}

/**
 * Runs TLC on a module with a configuration written to the scratch directory, and hands each line
 * TLC prints through PrintT(ToString(...)) to `onLine`. It returns TLC's own counts and whether it
 * ended clean or on a violated invariant, which it names; anything else throws. Deadlock checking
 * is off: every specification here ends in states with no successor on purpose.
 */
export async function runTlc({ java, jar, scratch, specDir, module, name, config, workers = 1, heap = "2g", onLine = () => undefined }) {
  const configPath = join(scratch, `${name}.cfg`);
  writeFileSync(configPath, config);
  const child = spawn(java, ["-XX:+UseParallelGC", `-Xmx${heap}`, "-cp", jar, "tlc2.TLC", "-workers", String(workers), "-deadlock", "-metadir", join(scratch, `${name}-states`), "-config", configPath, module], { cwd: specDir, stdio: ["ignore", "pipe", "pipe"] });
  const tail = [];
  const summary = { generated: null, distinct: null, depth: null, clean: false, violated: null };
  let failure = null;
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on("line", (line) => {
    if (failure !== null) return;
    try {
      if (line.startsWith('"<<')) {
        onLine(line);
        return;
      }
      tail.push(line);
      if (tail.length > 40) tail.shift();
      const counts = /^(\d+) states generated, (\d+) distinct states found, (\d+) states left on queue\.$/.exec(line);
      if (counts !== null) Object.assign(summary, { generated: Number(counts[1]), distinct: Number(counts[2]) });
      const depth = /^The depth of the complete state graph search is (\d+)\.$/.exec(line);
      if (depth !== null) summary.depth = Number(depth[1]);
      const violated = /^Error: Invariant (\S+) is violated/.exec(line);
      if (violated !== null) summary.violated = violated[1];
      if (line === "Model checking completed. No error has been found.") summary.clean = true;
    } catch (error) {
      failure = error;
      child.kill();
    }
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const code = await new Promise((done) => child.on("close", done));
  if (failure !== null) throw failure;
  if (!summary.clean && summary.violated === null) throw new Error(`TLC neither finished clean nor named a violated invariant on ${name} (exit ${String(code)}):\n${tail.join("\n")}\n${stderr}`);
  return summary;
}

/**
 * What --check does when TLC's export is not the committed one: write the export TLC made to the
 * path --candidate names, if one was given, and throw an error that says where the two differ.
 * The exports are laid out one entry to a line, so the differing lines name the entries.
 */
export function refuseDifferentExport(path, committed, text) {
  const candidate = option("--candidate");
  if (candidate !== undefined) writeFileSync(candidate, text);
  const before = committed.split("\n");
  const after = text.split("\n");
  const differing = [];
  for (let line = 0; line < Math.max(before.length, after.length); line += 1) {
    if (before[line] !== after[line]) differing.push(line);
  }
  const shown = differing.slice(0, 12).map((line) => `  line ${line + 1}\n    committed: ${(before[line] ?? "(no line)").slice(0, 240)}\n    TLC now:   ${(after[line] ?? "(no line)").slice(0, 240)}`);
  throw new Error(
    `${path} differs from what TLC exports now: ${differing.length} of ${Math.max(before.length, after.length)} lines differ` +
      `${differing.length > shown.length ? `, the first ${shown.length} shown` : ""}.\n${shown.join("\n")}\n` +
      `${candidate === undefined ? "Give --candidate <file> to keep what TLC exported." : `What TLC exported is in ${candidate}.`} Run this script without --check to write it, and review the difference.`
  );
}

/** A printed line that holds only tuples, strings, numbers and booleans, read as JSON once its brackets are JSON's. */
export function tupleLine(line) {
  return JSON.parse(JSON.parse(line).replaceAll("<<", "[").replaceAll(">>", "]").replaceAll("{", "[").replaceAll("}", "]").replaceAll("TRUE", "true").replaceAll("FALSE", "false"));
}

/** JSON with one line for each entry of a list and each field of the first levels, so a change to one entry is one changed line. */
export function layout(value, depth = 0) {
  const pad = "  ".repeat(depth + 1);
  if (Array.isArray(value) && value.length > 0) return `[\n${value.map((item) => pad + JSON.stringify(item)).join(",\n")}\n${"  ".repeat(depth)}]`;
  if (value !== null && typeof value === "object" && !Array.isArray(value) && depth < 3 && Object.keys(value).length > 0) {
    return `{\n${Object.entries(value)
      .map(([key, inner]) => `${pad}${JSON.stringify(key)}: ${layout(inner, depth + 1)}`)
      .join(",\n")}\n${"  ".repeat(depth)}}`;
  }
  return JSON.stringify(value);
}
