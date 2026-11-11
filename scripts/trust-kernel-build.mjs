#!/usr/bin/env node
// Builds the trust kernel's WebAssembly module and holds the result to
// tools/trust-kernel/reproducibility-contract.json.
//
//   build --out <file>      one clean build, copied to <file>
//   verify [--out <file>]   two clean builds, the second from a copy of the
//                           workspace at another path with another target
//                           directory; both must equal each other and the
//                           digest the contract records for this host, and
//                           neither may name a host path
//   contract [--environment <text>]
//                           print the contract this source and one clean
//                           build give on this host (for a reviewed update)
//   toolchain               install the pinned compiler with rustup and
//                           check it as described below
//
// What is claimed, and no more: on each host platform listed in the
// contract, two clean builds of the recorded inputs gave the recorded
// bytes. The contract names the platforms and how each was observed. It
// does not say "wherever it is built": a platform that is not listed has
// not been tried.
//
// What keeps the bytes fixed:
// - cargo runs with --locked, so every crate is the one Cargo.lock names,
//   and cargo itself checks each download against the lock's checksum;
// - one codegen unit, fat LTO, no incremental state and no debug info, set
//   in the workspace profile;
// - the workspace, the cargo home and the rustup home are remapped to fixed
//   names, so no path of the machine reaches the output;
// - every crate compiled for the target gets one fixed `-C metadata` in
//   place of cargo's hash, which differs between host platforms (see
//   `writeWrapper`). Before this the same source gave one module on
//   aarch64-apple-darwin and another on x86_64-unknown-linux-gnu;
// - no tool runs after the compiler. There is no wasm-bindgen, wasm-pack or
//   wasm-opt step, so there is no tool cache to trust.
//
// What binds the compiler to the pin, in `toolchain()`, before every build:
// - rustc and cargo report the pinned release, and rustc the pinned commit.
//   That is the compiler's own word;
// - rustup's record of the channel manifest it installed this toolchain
//   from lists, for rustc, cargo and the two standard libraries, the
//   archive hashes pinned in pins.json. rustup checks each archive it
//   downloads against that manifest. That is rustup's own record, not a
//   hash of the installed files;
// - for a build, the module's digest: a different compiler would have to
//   produce the same bytes.
// `toolchain` (the install) also downloads the channel manifest, requires
// the pinned size and sha256, and requires the pinned archive hashes to be
// the ones that manifest lists. rustup then downloads its own copy of the
// manifest; the second point above is what ties its copy to the pin.
// rustup itself is not pinned: it is the one on the machine (on a hosted
// runner, the one in the runner image).

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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

// The value every crate compiled for the target gets as `-C metadata`, in
// place of the hash cargo computes. See `writeWrapper`.
const FIXED_METADATA = "sbl-trust-kernel";
// The crates compiled for the target, which is every crate whose code is in
// the module besides the standard library the toolchain ships compiled.
const TARGET_CRATES = ["sbl_trust_kernel", "sbl_trust_kernel_wasm", "verus_builtin", "vstd"];

/**
 * Writes the program that stands between cargo and rustc for one build
 * (RUSTC_WRAPPER) and returns its path. It changes one thing: for a crate
 * compiled for the WebAssembly target, the value of `-C metadata`. Each
 * crate it does that for is written to `log`.
 *
 * Why. rustc names and orders what it compiles by a hash seeded with that
 * value. cargo computes the value per crate and folds into it the values
 * of the crate's dependencies. The kernel depends on vstd, and vstd on
 * procedural macro crates, which are compiled for the machine that builds.
 * cargo's value for those crates differs between host platforms (observed:
 * every host crate's value differs between aarch64-apple-darwin and
 * x86_64-unknown-linux-gnu, and it also moves with the host crates' profile
 * and with an ambient __CARGO_DEFAULT_LIB_METADATA), so vstd's, the
 * kernel's and the module's values did too, and with them the order of
 * functions in the module. With a fixed value for the target's crates, no
 * value cargo computes for a host crate seeds a crate that is compiled
 * into the module.
 *
 * What that was seen to do: the module had two forms, and which one a build
 * gave followed the value. With the value fixed, macOS arm64 and Linux
 * x86-64 give the same module, also when the host crates' profile is
 * changed or the ambient variable is set. That no other input depends on
 * the host has not been shown; the contract lists the hosts that were
 * tried.
 *
 * The file names cargo expects come from another flag (`extra-filename`),
 * which is left alone. Crates compiled for the host (the macro crates and
 * the build scripts) keep cargo's value. No source text is changed and no
 * cfg is set. It is a shell script, not this file run again, so that rustc
 * inherits cargo's job server.
 */
function writeWrapper(directory, log) {
  mkdirSync(directory, { recursive: true });
  const quote = (text) => `'${text.replaceAll("'", `'\\''`)}'`;
  const file = path.join(directory, "rustc-wrapper.sh");
  const script = `#!/bin/sh
# Written by scripts/trust-kernel-build.mjs for one build; see writeWrapper there.
rustc=$1
shift
target=0
crate=
previous=
for argument in "$@"; do
  if [ "$previous" = "--target" ] && [ "$argument" = ${quote(PINS.rust.target)} ]; then target=1; fi
  if [ "$previous" = "--crate-name" ]; then crate=$argument; fi
  previous=$argument
done
if [ "$target" = 0 ] || [ -z "$crate" ]; then exec "$rustc" "$@"; fi
count=$#
index=0
rewritten=0
previous=
while [ "$index" -lt "$count" ]; do
  argument=$1
  shift
  given=$argument
  case "$argument" in
    metadata=*) if [ "$previous" = "-C" ]; then argument=${quote(`metadata=${FIXED_METADATA}`)}; rewritten=$((rewritten + 1)); fi ;;
    -Cmetadata=*) argument=${quote(`-Cmetadata=${FIXED_METADATA}`)}; rewritten=$((rewritten + 1)) ;;
  esac
  set -- "$@" "$argument"
  previous=$given
  index=$((index + 1))
done
printf '%s %s\\n' "$crate" "$rewritten" >> ${quote(log)}
exec "$rustc" "$@"
`;
  writeFileSync(file, script);
  chmodSync(file, 0o755);
  return file;
}

/** The wrapper must have given the fixed value to each crate of the target once, and to nothing else. */
function assertWrapperLog(log) {
  const lines = readFileSync(log, "utf8").split("\n").filter(Boolean);
  // cargo asks rustc about the target with a crate it names ___; that call
  // compiles nothing and carries no metadata.
  const compiled = lines.filter((line) => !line.startsWith("___ ")).sort();
  const expected = TARGET_CRATES.map((name) => `${name} 1`).sort();
  if (JSON.stringify(compiled) !== JSON.stringify(expected) || lines.some((line) => line.startsWith("___ ") && line !== "___ 0")) {
    throw new Error(`the fixed -C metadata did not reach exactly the target's crates: ${JSON.stringify(lines)}`);
  }
}

/** The `xz_hash` of one component for one platform in a channel manifest, rustup's copy or the release's. */
function archiveHash(manifest, component, platform) {
  const header = `[pkg.${component}.target.${platform}]\n`;
  const at = manifest.indexOf(header);
  if (at === -1 || manifest.indexOf(header, at + 1) !== -1) return null;
  const end = manifest.indexOf("\n[", at + header.length);
  const section = manifest.slice(at + header.length, end === -1 ? manifest.length : end);
  return /^xz_hash = "([0-9a-f]{64})"$/m.exec(section)?.[1] ?? null;
}

/** The archives the build uses: the compiler, cargo and the host's standard library, and the target's. */
function pinnedArchives(host) {
  const forHost = PINS.rust.components[host];
  if (!forHost) throw new Error(`pins.json pins no Rust components for the host ${host}`);
  return [
    ["rustc", host, forHost.rustc],
    ["cargo", host, forHost.cargo],
    ["rust-std", host, forHost["rust-std"]],
    ["rust-std", PINS.rust.target, PINS.rust.components[PINS.rust.target]["rust-std"]]
  ];
}

function assertArchives(manifest, host, whose) {
  for (const [component, platform, pinned] of pinnedArchives(host)) {
    const found = archiveHash(manifest, component, platform);
    if (found !== pinned) {
      throw new Error(`${whose} lists ${component} for ${platform} as ${found}; the pin is ${pinned}`);
    }
  }
}

function toolchain(workspace) {
  const run = (tool, args) => execFileSync(tool, args, { cwd: workspace, encoding: "utf8" });
  const verbose = run("rustc", ["-Vv"]);
  const field = (name) => new RegExp(`^${name}: (.*)$`, "m").exec(verbose)?.[1];
  const found = { release: field("release"), commit: field("commit-hash"), host: field("host"), llvm: field("LLVM version") };
  if (found.release !== PINS.rust.channel || found.commit !== PINS.rust.rustcCommit) {
    throw new Error(`the compiler is ${found.release} at ${found.commit}; the pin is ${PINS.rust.channel} at ${PINS.rust.rustcCommit}`);
  }
  const cargo = run("cargo", ["-V"]).trim();
  if (!cargo.startsWith(`cargo ${PINS.rust.channel} `)) throw new Error(`cargo is "${cargo}"; the pin is ${PINS.rust.channel}`);
  const sysroot = run("rustc", ["--print", "sysroot"]).trim();
  // rustup keeps, inside the toolchain, the channel manifest it installed
  // it from and the list of components it installed.
  const recorded = path.join(sysroot, "lib/rustlib/multirust-channel-manifest.toml");
  let manifest;
  let components;
  try {
    manifest = readFileSync(recorded, "utf8");
    components = readFileSync(path.join(sysroot, "lib/rustlib/components"), "utf8").split("\n").filter(Boolean);
  } catch {
    throw new Error(`${sysroot} holds no rustup record of what was installed; the toolchain must be installed by rustup`);
  }
  assertArchives(manifest, found.host, "rustup's record of the installed toolchain");
  for (const [component, platform] of pinnedArchives(found.host)) {
    if (!components.includes(`${component}-${platform}`)) throw new Error(`rustup did not install ${component} for ${platform}`);
  }
  return { ...found, sysroot, cargo };
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
    // The archive hashes in pins.json must be this manifest's, for every
    // host pins.json names, so the two pins cannot drift apart.
    for (const host of Object.keys(PINS.rust.components).filter((name) => name !== "note" && name !== PINS.rust.target)) {
      assertArchives(bytes.toString("utf8"), host, "the pinned channel manifest");
    }
  });
  execFileSync(
    "rustup",
    ["toolchain", "install", PINS.rust.channel, "--profile", "minimal", "--target", PINS.rust.target, "--no-self-update"],
    { stdio: "inherit" }
  );
  const tools = toolchain(WORKSPACE);
  console.log(
    `Rust ${tools.release} at ${tools.commit} on ${tools.host}. rustup's record of the install lists the pinned archives ` +
      `of rustc, cargo and both standard libraries; the release's channel manifest has the pinned sha256 ${pinned.sha256}.`
  );
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
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (/^(RUSTFLAGS|RUSTC|RUSTC_WRAPPER|RUSTC_WORKSPACE_WRAPPER|RUSTC_BOOTSTRAP|__CARGO_DEFAULT_LIB_METADATA)$/.test(name) || /^CARGO_(BUILD|PROFILE|TARGET)_.*/.test(name)) {
      delete env[name];
    }
  }
  const wrapperDirectory = `${targetDirectory}-rustc-wrapper`;
  const wrapperLog = path.join(wrapperDirectory, "target-crates.log");
  Object.assign(env, {
    CARGO_ENCODED_RUSTFLAGS: flags.join("\x1f"),
    CARGO_TARGET_DIR: targetDirectory,
    CARGO_INCREMENTAL: "0",
    RUSTC_WRAPPER: writeWrapper(wrapperDirectory, wrapperLog)
  });
  execFileSync(
    "cargo",
    ["build", "--locked", "--release", "--target", PINS.rust.target, "-p", "sbl-trust-kernel-wasm"],
    { cwd: workspace, env, stdio: ["ignore", "inherit", "inherit"] }
  );
  assertWrapperLog(wrapperLog);
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

/** What this source and one clean build on this host give, without any other host's observation. */
function observedContract(built, environment) {
  return {
    schemaVersion: 2,
    status: "rebuild-and-compare",
    claim: "on-each-host-listed-two-clean-builds-of-these-inputs-gave-these-bytes",
    build: {
      cargoLocked: true,
      target: PINS.rust.target,
      profile: "release",
      rustc: PINS.rust.channel,
      rustcCommit: PINS.rust.rustcCommit,
      pathRemapping: ["workspace", "cargo home", "rust sysroot"],
      targetCrateMetadata: FIXED_METADATA,
      toolsAfterTheCompiler: []
    },
    inputs: inputs(),
    artifact: "sbl_trust_kernel_wasm.wasm",
    observed: {
      [built.tools.host]: { bytes: built.wasm.length, sha256: sha256(built.wasm), environment }
    },
    notObserved: "Any host platform that is not a key of `observed`. A GitHub-hosted runner has not built this."
  };
}

/** The part of a contract that must be the same whatever host built: everything but the observations. */
const withoutObservations = (contract) => JSON.stringify({ ...contract, observed: null });

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
    const host = first.tools.host;
    const built = observedContract(first, "");
    if (withoutObservations(built) !== withoutObservations(contract)) {
      const drifted = built.inputs.filter((entry, index) => entry.sha256 !== contract.inputs?.[index]?.sha256).map((entry) => entry.path);
      throw new Error(`the contract does not describe this source and build.\n  inputs that differ: ${drifted.join(", ") || "none (the build settings or the file list differ)"}`);
    }
    const recorded = contract.observed?.[host];
    if (!recorded) {
      throw new Error(
        `the contract records no observation for ${host}. This host built ${digests[0]} (${first.wasm.length} bytes) twice.\n` +
          `  recorded hosts: ${Object.keys(contract.observed ?? {}).join(", ") || "none"}`
      );
    }
    if (recorded.sha256 !== digests[0] || recorded.bytes !== first.wasm.length) {
      throw new Error(
        `the build is not the one the contract records for ${host}.\n  built:    ${digests[0]} (${first.wasm.length} bytes)\n` +
          `  contract: ${recorded.sha256} (${recorded.bytes} bytes)`
      );
    }
    if (keepAt) {
      mkdirSync(path.dirname(path.resolve(keepAt)), { recursive: true });
      copyFileSync(path.join(scratch, "first-target", ARTIFACT), path.resolve(keepAt));
    }
    console.log(
      `Two clean builds on ${host} (${first.tools.cargo}) are byte-identical and are what the contract records for ${host}: ` +
        `${digests[0]}, ${first.wasm.length} bytes. First build ${firstSeconds.toFixed(1)} s, both ${seconds.toFixed(1)} s.`
    );
  });
}

/**
 * The contract for this source with this host's observation. Another
 * host's recorded observation is kept only while everything else in the
 * committed contract still describes this source: an observation belongs to
 * the inputs it was made on.
 */
function printContract(environment) {
  return withScratch((scratch) => {
    const built = cleanBuild(WORKSPACE, path.join(scratch, "target"));
    assertNoHostPath(built.wasm, built.hostPaths);
    const next = observedContract(built, environment);
    let committed = null;
    try {
      committed = JSON.parse(readFileSync(path.join(ROOT, CONTRACT_PATH), "utf8"));
    } catch {
      // No contract yet, or not JSON: this host's observation stands alone.
    }
    if (committed && withoutObservations(committed) === withoutObservations(next)) {
      next.observed = Object.fromEntries(Object.entries({ ...committed.observed, ...next.observed }).sort(([a], [b]) => (a < b ? -1 : 1)));
    }
    process.stdout.write(`${JSON.stringify(next, null, 2)}\n`);
  });
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "toolchain") return installToolchain();
  if (command === "verify") return verify(rest[0] === "--out" ? rest[1] : undefined);
  if (command === "contract") {
    if (rest.length !== 0 && !(rest.length === 2 && rest[0] === "--environment")) throw new Error("contract takes --environment <text> or nothing");
    return printContract(rest[1] ?? `${os.type()} ${os.release()} ${os.arch()}, not described further`);
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
  throw new Error("Usage: trust-kernel-build.mjs toolchain | verify [--out <file>] | contract [--environment <text>] | build --out <file>");
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
