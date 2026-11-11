#!/usr/bin/env node
// Installs the pinned Verus release and runs it on the trust kernel.
//
//   install --into <dir>   download the release for this platform, refuse it
//                          unless its size and sha256 are the pinned ones,
//                          and unpack it
//   verify --verus <dir>   check tools/trust-kernel with it
//
// `verify` does three things, because a green verifier run alone can mean
// that nothing was asked:
//   1. reads src/encode.rs and refuses the words that would let a claim
//      through unchecked (assume, admit, an external or trusted marker), and
//      requires the two theorems and the checked entry point by name;
//   2. runs `cargo verus verify` and requires every result line to report
//      zero errors, with at least one verified item for the kernel itself;
//   3. breaks the specification in a temporary copy (a quote written with no
//      escape, which makes two strings share bytes) and requires Verus to
//      refuse that copy.
//
// Nothing here is cached between runs and nothing is fetched except the one
// pinned archive, by `install`.

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const WORKSPACE = path.join(ROOT, "tools/trust-kernel");
const PINS = JSON.parse(readFileSync(path.join(WORKSPACE, "pins.json"), "utf8"));
const ENCODER = "kernel/src/encode.rs";

// A word here widens what is trusted without a proof. None may appear in the
// checked file, comments included, so the check stays a plain text search.
const FORBIDDEN = [
  /\bassume\s*\(/,
  /\badmit\s*\(/,
  /\bassume_specification\b/,
  /external_body/,
  /verifier::external/,
  /verifier::trusted/,
  /verifier::exec_allows_no_decreases_clause/,
  /\bunsafe\b/
];
const REQUIRED = [
  "pub proof fn theorem_encoding_is_injective(t1: Tree, t2: Tree)",
  "pub proof fn theorem_key_order_is_strict(a: Seq<u16>)",
  "pub fn encode_admitted(v: &Value) -> (r: Option<Vec<u8>>)"
];
const MUTATION = {
  from: "    if u == 0x22 {\n        seq![0x5cu8, 0x22u8]\n    } else if u == 0x5c {",
  to: "    if u == 0x22 {\n        seq![0x22u8]\n    } else if u == 0x5c {"
};

function option(argv, name) {
  const at = argv.indexOf(name);
  if (at === -1 || argv[at + 1] === undefined) throw new Error(`missing ${name} <value>`);
  return argv[at + 1];
}

function asset() {
  const key = `${process.platform}-${process.arch}`;
  const found = PINS.verus.assets[key];
  if (!found) throw new Error(`no pinned Verus release for ${key}`);
  return found;
}

function install(into) {
  const pinned = asset();
  mkdirSync(into, { recursive: true });
  const archive = path.join(into, "verus.zip");
  execFileSync(
    "curl",
    ["--fail", "--silent", "--show-error", "--location", "--proto", "=https", "--tlsv1.2", "--max-filesize", String(pinned.bytes), "--output", archive, pinned.url],
    { stdio: "inherit" }
  );
  const bytes = readFileSync(archive);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (bytes.length !== pinned.bytes || sha256 !== pinned.sha256) {
    rmSync(archive, { force: true });
    throw new Error(`the Verus archive is not the pinned one: ${bytes.length} bytes, sha256 ${sha256}`);
  }
  execFileSync("unzip", ["-q", "-o", archive, "-d", into], { stdio: "inherit" });
  rmSync(archive, { force: true });
  const directory = path.join(into, pinned.directory);
  const version = JSON.parse(readFileSync(path.join(directory, "version.json"), "utf8")).verus;
  if (version.version !== PINS.verus.version || version.commit !== PINS.verus.commit) {
    throw new Error(`the unpacked Verus names itself ${version.version} at ${version.commit}`);
  }
  console.log(`Verus ${version.version} (sha256 ${sha256}) unpacked to ${directory}`);
  return directory;
}

function checkSource(source) {
  for (const pattern of FORBIDDEN) {
    if (pattern.test(source)) throw new Error(`${ENCODER} holds ${pattern}, which lets a claim through unchecked`);
  }
  for (const signature of REQUIRED) {
    if (!source.includes(signature)) throw new Error(`${ENCODER} no longer states: ${signature}`);
  }
  if (!source.includes(MUTATION.from)) throw new Error(`${ENCODER} no longer holds the text the refusal check breaks`);
}

function runVerus(workspace, verusDirectory, targetDirectory) {
  const result = spawnSync("cargo", ["verus", "verify", "--locked", "-p", "sbl-trust-kernel"], {
    cwd: workspace,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${verusDirectory}${path.delimiter}${process.env.PATH}`,
      CARGO_TARGET_DIR: targetDirectory
    },
    maxBuffer: 1 << 26
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const results = [...output.matchAll(/verification results:: (\d+) verified, (\d+) errors/g)].map((found) => ({
    verified: Number(found[1]),
    errors: Number(found[2])
  }));
  return { status: result.status, signal: result.signal, output, results };
}

function verify(verusDirectory) {
  if (!existsSync(path.join(verusDirectory, "cargo-verus"))) {
    throw new Error(`no cargo-verus in ${verusDirectory}; run install first`);
  }
  const version = JSON.parse(readFileSync(path.join(verusDirectory, "version.json"), "utf8")).verus;
  if (version.version !== PINS.verus.version || version.commit !== PINS.verus.commit) {
    throw new Error(`this is Verus ${version.version}, and the pin is ${PINS.verus.version}`);
  }
  const lock = readFileSync(path.join(WORKSPACE, "Cargo.lock"), "utf8");
  if (!lock.includes(`name = "vstd"\nversion = "${PINS.verus.vstdCrate}"`)) {
    throw new Error("Cargo.lock does not resolve the pinned vstd");
  }
  const source = readFileSync(path.join(WORKSPACE, ENCODER), "utf8");
  checkSource(source);

  const scratch = mkdtempSync(path.join(os.tmpdir(), "sbl-trust-kernel-verus-"));
  try {
    const target = path.join(scratch, "target");
    const started = Date.now();
    const real = runVerus(WORKSPACE, verusDirectory, target);
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    // The last result line is the kernel's; the one before it, on a clean
    // target, is vstd checking itself.
    const own = real.results.at(-1);
    if (real.status !== 0 || real.results.length === 0 || real.results.some((line) => line.errors !== 0) || own.verified < 1) {
      process.stderr.write(real.output);
      throw new Error(`Verus did not check the kernel (exit ${real.status ?? real.signal})`);
    }

    // The same run on a copy whose specification is broken must fail, and
    // fail in the verifier, not in the build.
    const copy = path.join(scratch, "copy");
    cpSync(WORKSPACE, copy, { recursive: true, filter: (from) => path.basename(from) !== "target" });
    writeFileSync(path.join(copy, ENCODER), source.replace(MUTATION.from, MUTATION.to));
    const broken = runVerus(copy, verusDirectory, target);
    const brokenOwn = broken.results.at(-1);
    if (broken.status === 0 || broken.signal !== null || !brokenOwn || brokenOwn.errors < 1) {
      process.stderr.write(broken.output);
      throw new Error("Verus accepted an encoding in which two strings share bytes");
    }

    console.log(
      `Verus ${version.version}: ${own.verified} items of ${ENCODER} verified, 0 errors, in ${seconds} s; ` +
        `the broken copy was refused with ${brokenOwn.errors} errors.`
    );
    return { verified: own.verified, seconds: Number(seconds), brokenErrors: brokenOwn.errors };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "install") {
    install(path.resolve(option(rest, "--into")));
    return;
  }
  if (command === "verify") {
    const directory = path.resolve(option(rest, "--verus"));
    if (!statSync(directory).isDirectory()) throw new Error(`${directory} is not a directory`);
    verify(directory);
    return;
  }
  throw new Error("Usage: trust-kernel-verus.mjs install --into <dir> | verify --verus <dir>");
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
