#!/usr/bin/env node
// Builds the trust kernel's WebAssembly module so that the same source gives
// the same bytes wherever it is built, and holds the result to the digest in
// tools/trust-kernel/reproducibility-contract.json.
//
//   build --out <file>      one clean build, copied to <file>
//   verify [--out <file>]   two clean builds, the second from a copy of the
//                           workspace at another path with another target
//                           directory; both must equal each other and the
//                           contract, and neither may name a host path
//   contract                print the contract this source and one clean
//                           build give (for a reviewed update)
//   toolchain               install the pinned compiler: fetch the release's
//                           channel manifest, refuse it unless its size and
//                           sha256 are the pinned ones, then let rustup
//                           install from it (rustup checks every component
//                           against the hashes that manifest lists)
//
// What keeps the bytes fixed:
// - the compiler is the one rust-toolchain.toml pins, and its commit is
//   checked against pins.json before anything is built;
// - cargo runs with --locked, so every crate is the one Cargo.lock names,
//   and cargo itself checks each download against the lock's checksum;
// - one codegen unit, fat LTO, no incremental state and no debug info, set
//   in the workspace profile;
// - the workspace, the cargo home and the rustup home are remapped to fixed
//   names, so no path of the machine reaches the output;
// - no tool runs after the compiler. There is no wasm-bindgen, wasm-pack or
//   wasm-opt step, so there is no tool cache to trust.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const WORKSPACE = path.join(ROOT, "tools/trust-kernel");
const CONTRACT_PATH = "tools/trust-kernel/reproducibility-contract.json";
const PINS = JSON.parse(readFileSync(path.join(WORKSPACE, "pins.json"), "utf8"));
const ARTIFACT = `${PINS.rust.target}/release/sbl_trust_kernel_wasm.wasm`;
const INPUTS = [
  "tools/trust-kernel/Cargo.toml",
  "tools/trust-kernel/Cargo.lock",
  "tools/trust-kernel/rust-toolchain.toml",
  "tools/trust-kernel/pins.json",
  "tools/trust-kernel/kernel/Cargo.toml",
  "tools/trust-kernel/kernel/src/lib.rs",
  "tools/trust-kernel/kernel/src/encode.rs",
  "tools/trust-kernel/kernel/src/parse.rs",
  "tools/trust-kernel/kernel/src/number.rs",
  "tools/trust-kernel/kernel/src/nfc.rs",
  "tools/trust-kernel/kernel/src/nfc_tables.rs",
  "tools/trust-kernel/kernel/src/tests.rs",
  "tools/trust-kernel/wasm/Cargo.toml",
  "tools/trust-kernel/wasm/src/lib.rs"
];

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function toolchain(workspace) {
  const run = (tool, args) => execFileSync(tool, args, { cwd: workspace, encoding: "utf8" });
  const verbose = run("rustc", ["-Vv"]);
  const field = (name) => new RegExp(`^${name}: (.*)$`, "m").exec(verbose)?.[1];
  const found = { release: field("release"), commit: field("commit-hash"), host: field("host"), llvm: field("LLVM version") };
  if (found.release !== PINS.rust.channel || found.commit !== PINS.rust.rustcCommit) {
    throw new Error(`the compiler is ${found.release} at ${found.commit}; the pin is ${PINS.rust.channel} at ${PINS.rust.rustcCommit}`);
  }
  return { ...found, sysroot: run("rustc", ["--print", "sysroot"]).trim(), cargo: run("cargo", ["-V"]).trim() };
}

function installToolchain() {
  const pinned = PINS.rust.manifest;
  withScratch((scratch) => {
    const file = path.join(scratch, "channel.toml");
    execFileSync(
      "curl",
      ["--fail", "--silent", "--show-error", "--location", "--proto", "=https", "--tlsv1.2", "--max-filesize", String(pinned.bytes), "--output", file, pinned.url],
      { stdio: "inherit" }
    );
    const bytes = readFileSync(file);
    if (bytes.length !== pinned.bytes || sha256(bytes) !== pinned.sha256) {
      throw new Error(`the channel manifest is not the pinned one: ${bytes.length} bytes, sha256 ${sha256(bytes)}`);
    }
  });
  execFileSync(
    "rustup",
    ["toolchain", "install", PINS.rust.channel, "--profile", "minimal", "--target", PINS.rust.target, "--no-self-update"],
    { stdio: "inherit" }
  );
  const tools = toolchain(WORKSPACE);
  console.log(`Rust ${tools.release} at ${tools.commit} on ${tools.host}, from the manifest with sha256 ${pinned.sha256}`);
}

function cleanBuild(workspace, targetDirectory) {
  const tools = toolchain(workspace);
  // cargo creates its home on first use; make it now so its real path can
  // be remapped even on a machine that has never run cargo.
  const cargoHomeGiven = process.env.CARGO_HOME ?? path.join(os.homedir(), ".cargo");
  mkdirSync(cargoHomeGiven, { recursive: true });
  const cargoHome = realpathSync(cargoHomeGiven);
  // rustc applies the last remap that matches, so the longest path goes
  // last: if one of these ever sat inside another, the inner one would win.
  const remaps = [
    [realpathSync(workspace), "/sbl/trust-kernel"],
    [cargoHome, "/sbl/cargo-home"],
    [realpathSync(tools.sysroot), "/sbl/rust-sysroot"]
  ].sort((a, b) => a[0].length - b[0].length);
  // CARGO_ENCODED_RUSTFLAGS takes the flags as they are, separated by 0x1f,
  // so a path with a space is still one flag, and it outranks every other
  // source of flags, so an ambient RUSTFLAGS cannot reach this build.
  const flags = remaps.map(([from, to]) => `--remap-path-prefix=${from}=${to}`);
  const env = { ...process.env, CARGO_ENCODED_RUSTFLAGS: flags.join("\x1f"), CARGO_TARGET_DIR: targetDirectory, CARGO_INCREMENTAL: "0" };
  for (const name of Object.keys(env)) {
    if (name === "RUSTFLAGS" || name === "RUSTC_WRAPPER" || name === "RUSTC_WORKSPACE_WRAPPER" || /^CARGO_(BUILD|PROFILE|TARGET)_.*/.test(name)) {
      if (name !== "CARGO_TARGET_DIR") delete env[name];
    }
  }
  execFileSync(
    "cargo",
    ["build", "--locked", "--release", "--target", PINS.rust.target, "-p", "sbl-trust-kernel-wasm"],
    { cwd: workspace, env, stdio: ["ignore", "inherit", "inherit"] }
  );
  const wasm = readFileSync(path.join(targetDirectory, ARTIFACT));
  return { wasm, tools, hostPaths: [realpathSync(workspace), cargoHome, realpathSync(tools.sysroot), os.homedir()] };
}

/** Any trace of the building machine in the module is a failure. */
function assertNoHostPath(wasm, hostPaths) {
  const text = wasm.toString("latin1");
  for (const hostPath of hostPaths) {
    if (text.includes(hostPath)) throw new Error(`the module names a host path: ${hostPath}`);
  }
  const leak = /\/(?:Users|home|runner|private\/tmp|tmp)\/[^\0"]{0,80}/.exec(text);
  if (leak) throw new Error(`the module names a path that looks like a host's: ${leak[0]}`);
}

function inputs() {
  return INPUTS.map((file) => {
    const bytes = readFileSync(path.join(ROOT, file));
    return { path: file, bytes: bytes.length, sha256: sha256(bytes) };
  });
}

function observedContract(wasm) {
  return {
    schemaVersion: 1,
    status: "rebuild-and-compare",
    claim: "two-clean-builds-of-these-inputs-give-these-bytes",
    build: {
      cargoLocked: true,
      target: PINS.rust.target,
      profile: "release",
      rustc: PINS.rust.channel,
      rustcCommit: PINS.rust.rustcCommit,
      pathRemapping: ["workspace", "cargo home", "rust sysroot"],
      toolsAfterTheCompiler: []
    },
    inputs: inputs(),
    output: { artifact: "sbl_trust_kernel_wasm.wasm", bytes: wasm.length, sha256: sha256(wasm) }
  };
}

function withScratch(run) {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "sbl-trust-kernel-build-"));
  try {
    return run(scratch);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function copyWorkspace(into) {
  mkdirSync(into, { recursive: true });
  cpSync(WORKSPACE, into, { recursive: true, filter: (from) => path.basename(from) !== "target" });
  return into;
}

function verify(keepAt) {
  const contract = JSON.parse(readFileSync(path.join(ROOT, CONTRACT_PATH), "utf8"));
  return withScratch((scratch) => {
    const started = Date.now();
    const first = cleanBuild(WORKSPACE, path.join(scratch, "first-target"));
    const firstSeconds = (Date.now() - started) / 1000;
    // The second build sees a different workspace path, deeper and with a
    // space in it, and a different target directory.
    const elsewhere = copyWorkspace(path.join(scratch, "a second place", "nested", "trust-kernel-copy"));
    const second = cleanBuild(elsewhere, path.join(scratch, "second-target"));
    const seconds = (Date.now() - started) / 1000;
    assertNoHostPath(first.wasm, first.hostPaths);
    assertNoHostPath(second.wasm, second.hostPaths);
    const digests = [sha256(first.wasm), sha256(second.wasm)];
    if (digests[0] !== digests[1]) {
      throw new Error(`two clean builds differ: ${digests[0]} and ${digests[1]}`);
    }
    const observed = observedContract(first.wasm);
    if (JSON.stringify(observed) !== JSON.stringify(contract)) {
      const drifted = observed.inputs.filter((entry, index) => entry.sha256 !== contract.inputs?.[index]?.sha256).map((entry) => entry.path);
      throw new Error(
        `the build is not the one the contract records.\n  built:    ${observed.output.sha256} (${observed.output.bytes} bytes) on ${first.tools.host}\n` +
          `  contract: ${contract.output?.sha256} (${contract.output?.bytes} bytes)\n  inputs that differ: ${drifted.join(", ") || "none"}`
      );
    }
    if (keepAt) {
      mkdirSync(path.dirname(path.resolve(keepAt)), { recursive: true });
      copyFileSync(path.join(scratch, "first-target", ARTIFACT), path.resolve(keepAt));
    }
    console.log(
      `Two clean builds on ${first.tools.host} (${first.tools.cargo}) are byte-identical and match the contract: ` +
        `${observed.output.sha256}, ${observed.output.bytes} bytes. First build ${firstSeconds.toFixed(1)} s, both ${seconds.toFixed(1)} s.`
    );
  });
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "toolchain") return installToolchain();
  if (command === "verify") return verify(rest[0] === "--out" ? rest[1] : undefined);
  if (command === "contract") {
    return withScratch((scratch) => {
      const built = cleanBuild(WORKSPACE, path.join(scratch, "target"));
      assertNoHostPath(built.wasm, built.hostPaths);
      process.stdout.write(`${JSON.stringify(observedContract(built.wasm), null, 2)}\n`);
    });
  }
  if (command === "build" && rest[0] === "--out" && rest[1]) {
    return withScratch((scratch) => {
      const built = cleanBuild(WORKSPACE, path.join(scratch, "target"));
      assertNoHostPath(built.wasm, built.hostPaths);
      mkdirSync(path.dirname(path.resolve(rest[1])), { recursive: true });
      copyFileSync(path.join(scratch, "target", ARTIFACT), path.resolve(rest[1]));
      console.log(`${sha256(built.wasm)}  ${rest[1]} (${built.wasm.length} bytes, ${built.tools.host})`);
    });
  }
  throw new Error("Usage: trust-kernel-build.mjs toolchain | verify [--out <file>] | contract | build --out <file>");
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
