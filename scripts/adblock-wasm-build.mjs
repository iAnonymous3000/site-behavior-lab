#!/usr/bin/env node
// Rebuilds the vendored ad-block WebAssembly module (lib/adblock-wasm, four
// files) from tools/adblock-wasm with pinned tools, and compares the result
// with the vendored files byte for byte.
//
//   toolchain               install the pinned compiler with rustup and
//                           check it as described below
//   tools --into <dir>      fetch the pinned binaryen release and the pinned
//                           wasm-bindgen-cli crate, check each archive, and
//                           build the wasm-bindgen tool from the crate
//   verify --tools <dir> [--out <dir>]
//                           two clean builds: the second from a copy of the
//                           crate at another path, with another target
//                           directory and another, empty cargo home. Both
//                           must equal each other and the four vendored
//                           files, and neither may name a path of this host
//   build --tools <dir> --out <dir>
//                           one clean build, copied to <dir>, compared with
//                           nothing
//   metadata                compile the crate once with cargo's own
//                           `-C metadata` and print, per crate of the
//                           target, the value cargo gave on this host (the
//                           table a toolchain epoch records in the pins)
//
// What is claimed, and no more: on a host where `verify` passes, two clean
// builds of the recorded inputs gave the four vendored files. Which hosts
// were tried is written in docs/supply-chain-assurance.md. This script
// changes no vendored file and does not move
// tools/adblock-wasm/reproducibility-contract.json, which is checked by
// scripts/verify-wasm-reproducibility.mjs.
//
// The steps are the ones wasm-pack 0.14.0 ran when the module was built
// first, without wasm-pack: cargo, then wasm-bindgen, then wasm-opt on the
// one .wasm file wasm-bindgen wrote.
//
// What keeps the bytes fixed:
// - cargo runs with --locked, so every crate is the one Cargo.lock names,
//   and cargo itself checks each download against the lock's checksum;
// - the cargo home is remapped to the one name the vendored module already
//   carries, which is the cargo home of the host that built it first. The
//   pins give that name by length and sha256 only, and the build reads the
//   text from the vendored module (see `recordedCargoHome`). The module
//   therefore still names that directory, on every host;
// - the crate directory and the rustup toolchain are remapped to fixed
//   names. Neither was seen in the output; the flags keep it so;
// - every crate compiled for the target gets the `-C metadata` cargo gave it
//   on the host that built the module first, from the pins, in place of the
//   value cargo computes, which differs between host platforms (see
//   `wrapperScript`). Without this the same source gave one module on
//   aarch64-apple-darwin and another on x86_64-unknown-linux-gnu;
// - wasm-bindgen is built from the pinned crate archive with the lock file
//   inside it, and wasm-opt comes from the pinned binaryen release archive.
//
// What binds the tools to the pins:
// - the compiler, as in scripts/trust-kernel-build.mjs: rustc and cargo
//   report the pinned release and commit, and rustup's record of the channel
//   manifest it installed from lists the pinned archive hashes. `toolchain`
//   also downloads the channel manifest and requires the pinned size and
//   sha256. rustup itself is not pinned;
// - wasm-opt: the release archive has the pinned size and sha256, and the
//   files the build runs have the pinned sha256, checked again before every
//   build;
// - wasm-bindgen: the crate archive has the pinned size and sha256 and its
//   Cargo.lock the pinned sha256. cargo builds it with --locked, so each of
//   its dependencies is checked against that lock. The built program is not
//   compared with anything (it differs by host); its output is, and `tools`
//   writes its sha256 beside it so that `verify` runs the program `tools`
//   built.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const WORKSPACE = path.join(ROOT, "tools/adblock-wasm");
const VENDORED = path.join(ROOT, "lib/adblock-wasm");
export const PINS_PATH = "tools/adblock-wasm/build-pins.json";
const CONTRACT_PATH = "tools/adblock-wasm/reproducibility-contract.json";
const CRATE_ARTIFACT = "sbl_adblock_wasm";
/** The four files wasm-bindgen writes, which are the four vendored files. */
export const OUTPUT_FILES = [
  "sbl_adblock_wasm.d.ts",
  "sbl_adblock_wasm.js",
  "sbl_adblock_wasm_bg.wasm",
  "sbl_adblock_wasm_bg.wasm.d.ts"
];
const MODULE_FILE = "sbl_adblock_wasm_bg.wasm";

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function readPins(root = ROOT) {
  return JSON.parse(readFileSync(path.join(root, PINS_PATH), "utf8"));
}

/**
 * The cargo home the vendored module names, read from the module.
 *
 * The module carries the source paths of the crates it was built from, and
 * those begin with the cargo home of the host that built it first. A build
 * on another host gives the same bytes only when its own cargo home is
 * remapped to that name. The name holds a user name, so the pins do not
 * spell it: they give its length and sha256, and the text comes from here.
 * The module must name exactly one such directory, and it must be the
 * pinned one.
 */
export function recordedCargoHome(module, pin) {
  const found = new Set(module.toString("latin1").match(/\/(?:Users|home)\/[^/\0]+\/\.cargo(?=\/registry\/)/g) ?? []);
  if (found.size !== 1) {
    throw new Error(`the vendored module must name one cargo home; it names ${found.size}`);
  }
  const [name] = found;
  if (Buffer.byteLength(name) !== pin.bytes || sha256(name) !== pin.sha256) {
    throw new Error("the cargo home the vendored module names is not the one the pins record");
  }
  return name;
}

/**
 * The name every build remaps its cargo home to. While the vendored module
 * is the one built before this script existed, that is the name the module
 * carries (`recordedCargoHome`). A toolchain epoch that rebuilds the module
 * with this script can choose a name that belongs to no host and write it in
 * the pins as `name`; it must sit under /sbl/, like the other remapped
 * names, so that the pins never spell a real home.
 */
export function cargoHomeName(pin, readModule) {
  if (pin.name === undefined) return recordedCargoHome(readModule(), pin);
  if (typeof pin.name !== "string" || !/^\/sbl\/[a-z0-9-]+$/.test(pin.name)) {
    throw new Error("a cargo home name written in the pins must be /sbl/<name>");
  }
  return pin.name;
}

/**
 * The text of the program that stands between cargo and rustc for one build
 * (RUSTC_WRAPPER). It changes one thing: for a crate compiled for the
 * WebAssembly target, the value of `-C metadata`, which becomes the value
 * the pins record for that crate. Each crate it does that for is written to
 * `log` with the value cargo had given.
 *
 * Why. rustc names and orders what it compiles by a hash seeded with that
 * value, and cargo computes it per crate from, among other things, the
 * compiler's host platform. Observed: with cargo's own values the compiler
 * output on x86_64-unknown-linux-gnu differed from the one on
 * aarch64-apple-darwin; with the recorded values the two were the same
 * bytes. That no other input depends on the host has not been shown.
 *
 * A crate of the target that the pins do not name stops the build: a value
 * cargo computed here would make this host's bytes its own. Crates compiled
 * for the host (the macro crates and the build scripts) keep cargo's value.
 * The file names cargo expects come from another flag (`extra-filename`),
 * which is left alone. It is a shell script, not this file run again, so
 * that rustc inherits cargo's job server.
 *
 * With `record`, nothing is changed: every crate of the target keeps
 * cargo's value and is logged with it. That is how the table is read off a
 * host (`metadata`).
 */
export function wrapperScript(pins, log, { record = false } = {}) {
  const quote = (text) => `'${String(text).replaceAll("'", `'\\''`)}'`;
  const cases = record
    ? "  *) value= ;;"
    : [
        ...Object.entries(pins.recordedForm.targetCrateMetadata).map(([crate, value]) => `  ${quote(crate)}) value=${quote(value)} ;;`),
        `  *) echo "adblock-wasm-build: the pins record no -C metadata for the target crate $crate" >&2; exit 1 ;;`
      ].join("\n");
  return `#!/bin/sh
# Written by scripts/adblock-wasm-build.mjs for one build; see wrapperScript there.
rustc=$1
shift
target=0
crate=
previous=
for argument in "$@"; do
  if [ "$previous" = "--target" ] && [ "$argument" = ${quote(pins.rust.target)} ]; then target=1; fi
  if [ "$previous" = "--crate-name" ]; then crate=$argument; fi
  previous=$argument
done
if [ "$target" = 0 ] || [ -z "$crate" ]; then exec "$rustc" "$@"; fi
case "$crate" in
  # cargo asks rustc about the target with a crate it names ___; that call
  # compiles nothing.
  ___) exec "$rustc" "$@" ;;
${cases}
esac
count=$#
index=0
rewritten=0
given=
previous=
while [ "$index" -lt "$count" ]; do
  argument=$1
  shift
  original=$argument
  case "$argument" in
    metadata=*) if [ "$previous" = "-C" ]; then given=\${argument#metadata=}; argument="metadata=\${value:-$given}"; rewritten=$((rewritten + 1)); fi ;;
    -Cmetadata=*) given=\${argument#-Cmetadata=}; argument="-Cmetadata=\${value:-$given}"; rewritten=$((rewritten + 1)) ;;
  esac
  set -- "$@" "$argument"
  previous=$original
  index=$((index + 1))
done
printf '%s %s %s\\n' "$crate" "$given" "$rewritten" >> ${quote(log)}
exec "$rustc" "$@"
`;
}

/**
 * The wrapper must have given its recorded value to each crate of the
 * target once, and the target must have no other crate. On the platform
 * the values were recorded on, cargo's own value must also be the recorded
 * one: there the table is checked against cargo, not only applied.
 */
export function assertWrapperLog(lines, pins, host) {
  const table = pins.recordedForm.targetCrateMetadata;
  const seen = new Map();
  for (const line of lines) {
    const [crate, given, rewritten, ...rest] = line.split(" ");
    if (rest.length !== 0 || rewritten !== "1" || seen.has(crate) || !Object.hasOwn(table, crate)) {
      throw new Error(`the recorded -C metadata did not reach each target crate exactly once: ${JSON.stringify(line)}`);
    }
    seen.set(crate, given);
  }
  const missing = Object.keys(table).filter((crate) => !seen.has(crate));
  if (missing.length !== 0) {
    throw new Error(`the pins record -C metadata for crates this build did not compile for the target: ${missing.join(", ")}`);
  }
  if (host === pins.recordedForm.recordingHost) {
    const moved = [...seen].filter(([crate, given]) => given !== table[crate]).map(([crate]) => crate);
    if (moved.length !== 0) {
      throw new Error(`on ${host} cargo's -C metadata is no longer the recorded one for: ${moved.join(", ")}`);
    }
  }
}

/** The `xz_hash` of one component for one platform in a channel manifest, rustup's copy or the release's. */
export function archiveHash(manifest, component, platform) {
  const header = `[pkg.${component}.target.${platform}]\n`;
  const at = manifest.indexOf(header);
  if (at === -1 || manifest.indexOf(header, at + 1) !== -1) return null;
  const end = manifest.indexOf("\n[", at + header.length);
  const section = manifest.slice(at + header.length, end === -1 ? manifest.length : end);
  return /^xz_hash = "([0-9a-f]{64})"$/m.exec(section)?.[1] ?? null;
}

/** The archives the build uses: the compiler, cargo and the host's standard library, and the target's. */
function pinnedArchives(pins, host) {
  const forHost = pins.rust.components[host];
  if (!forHost || host === "note") throw new Error(`the pins name no Rust components for the host ${host}`);
  return [
    ["rustc", host, forHost.rustc],
    ["cargo", host, forHost.cargo],
    ["rust-std", host, forHost["rust-std"]],
    ["rust-std", pins.rust.target, pins.rust.components[pins.rust.target]["rust-std"]]
  ];
}

export function assertArchives(pins, manifest, host, whose) {
  for (const [component, platform, pinned] of pinnedArchives(pins, host)) {
    const found = archiveHash(manifest, component, platform);
    if (found !== pinned) {
      throw new Error(`${whose} lists ${component} for ${platform} as ${found}; the pin is ${pinned}`);
    }
  }
}

/**
 * The environment for every cargo and rustc this script starts: the pinned
 * toolchain by name, and none of the variables that would add flags, swap
 * the compiler or change a profile behind the build's back.
 */
function buildEnvironment(pins, extra = {}) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (
      /^(RUSTFLAGS|RUSTC|RUSTC_WRAPPER|RUSTC_WORKSPACE_WRAPPER|RUSTC_BOOTSTRAP|CARGO_ENCODED_RUSTFLAGS|__CARGO_DEFAULT_LIB_METADATA)$/.test(name) ||
      /^CARGO_(BUILD|PROFILE|TARGET)_.*/.test(name)
    ) {
      delete env[name];
    }
  }
  return { ...env, RUSTUP_TOOLCHAIN: pins.rust.channel, CARGO_INCREMENTAL: "0", ...extra };
}

function toolchain(pins) {
  const env = buildEnvironment(pins);
  const run = (tool, args) => execFileSync(tool, args, { cwd: WORKSPACE, env, encoding: "utf8" });
  const verbose = run("rustc", ["-Vv"]);
  const field = (name) => new RegExp(`^${name}: (.*)$`, "m").exec(verbose)?.[1];
  const found = { release: field("release"), commit: field("commit-hash"), host: field("host") };
  if (found.release !== pins.rust.channel || found.commit !== pins.rust.rustcCommit) {
    throw new Error(`the compiler is ${found.release} at ${found.commit}; the pin is ${pins.rust.channel} at ${pins.rust.rustcCommit}`);
  }
  const cargo = run("cargo", ["-V"]).trim();
  if (!cargo.startsWith(`cargo ${pins.rust.channel} `)) throw new Error(`cargo is "${cargo}"; the pin is ${pins.rust.channel}`);
  const sysroot = run("rustc", ["--print", "sysroot"]).trim();
  // rustup keeps, inside the toolchain, the channel manifest it installed
  // it from and the list of components it installed.
  let manifest;
  let components;
  try {
    manifest = readFileSync(path.join(sysroot, "lib/rustlib/multirust-channel-manifest.toml"), "utf8");
    components = readFileSync(path.join(sysroot, "lib/rustlib/components"), "utf8").split("\n").filter(Boolean);
  } catch {
    throw new Error(`${sysroot} holds no rustup record of what was installed; the toolchain must be installed by rustup`);
  }
  assertArchives(pins, manifest, found.host, "rustup's record of the installed toolchain");
  for (const [component, platform] of pinnedArchives(pins, found.host)) {
    if (!components.includes(`${component}-${platform}`)) throw new Error(`rustup did not install ${component} for ${platform}`);
  }
  return { ...found, sysroot, cargo };
}

/** One file from the network, refused unless it has the pinned size and sha256. */
function download(pin, file) {
  execFileSync(
    "curl",
    ["--fail", "--silent", "--show-error", "--location", "--proto", "=https", "--tlsv1.2", "--max-filesize", String(pin.bytes), "--output", file, pin.url],
    { stdio: "inherit" }
  );
  const bytes = readFileSync(file);
  if (bytes.length !== pin.bytes || sha256(bytes) !== pin.sha256) {
    throw new Error(`${pin.url} is not the pinned file: ${bytes.length} bytes, sha256 ${sha256(bytes)}`);
  }
  return bytes;
}

/** Every entry of an archive listing must sit inside the one directory the pin names. */
export function assertArchiveEntries(entries, directory) {
  if (entries.length === 0) throw new Error("the archive lists no entries");
  for (const entry of entries) {
    const parts = entry.split("/");
    if (parts[0] !== directory || parts.includes("..") || entry.startsWith("/")) {
      throw new Error(`the archive holds an entry outside ${directory}/: ${JSON.stringify(entry)}`);
    }
  }
}

function extract(archive, directory, into) {
  const entries = execFileSync("tar", ["-tzf", archive], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\n").filter(Boolean);
  assertArchiveEntries(entries, directory);
  mkdirSync(into, { recursive: true });
  execFileSync("tar", ["-xzf", archive, "-C", into], { stdio: "inherit" });
  return path.join(into, directory);
}

function withScratch(run) {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "sbl-adblock-wasm-build-"));
  try {
    return run(scratch);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function installToolchain(pins) {
  const pinned = pins.rust.manifest;
  withScratch((scratch) => {
    const bytes = download(pinned, path.join(scratch, "channel.toml"));
    // The archive hashes in the pins must be this manifest's, for every
    // host the pins name, so the two pins cannot drift apart.
    for (const host of Object.keys(pins.rust.components).filter((name) => name !== "note" && name !== pins.rust.target)) {
      assertArchives(pins, bytes.toString("utf8"), host, "the pinned channel manifest");
    }
  });
  execFileSync(
    "rustup",
    ["toolchain", "install", pins.rust.channel, "--profile", "minimal", "--target", pins.rust.target, "--no-self-update"],
    { stdio: "inherit" }
  );
  const tools = toolchain(pins);
  console.log(
    `Rust ${tools.release} at ${tools.commit} on ${tools.host}. rustup's record of the install lists the pinned archives ` +
      `of rustc, cargo and both standard libraries; the release's channel manifest has the pinned sha256 ${pinned.sha256}.`
  );
}

const RECEIPT = "tools.json";

/** Where the two tools sit inside a tools directory, and the pinned binaryen release for this host. */
function toolPaths(pins, directory, host) {
  const asset = pins.binaryen.assets[host];
  if (!asset) throw new Error(`the pins name no binaryen release for the host ${host}`);
  return {
    asset,
    binaryen: path.join(directory, asset.directory),
    wasmOpt: path.join(directory, asset.directory, "bin/wasm-opt"),
    wasmBindgen: path.join(directory, "wasm-bindgen/bin/wasm-bindgen")
  };
}

/**
 * The two tools as they stand in `directory`, held to the pins: the binaryen
 * files by sha256, both by the version they report, and wasm-bindgen by the
 * sha256 `tools` wrote when it built it.
 */
function checkTools(pins, directory, host) {
  const paths = toolPaths(pins, directory, host);
  for (const [file, pinned] of Object.entries(paths.asset.files)) {
    const found = sha256(readFileSync(path.join(paths.binaryen, file)));
    if (found !== pinned) throw new Error(`${file} of binaryen is ${found}; the pin is ${pinned}`);
  }
  const optimizer = execFileSync(paths.wasmOpt, ["--version"], { encoding: "utf8" }).trim();
  if (optimizer !== pins.binaryen.reports) throw new Error(`wasm-opt reports "${optimizer}"; the pin is "${pins.binaryen.reports}"`);
  const receipt = JSON.parse(readFileSync(path.join(directory, RECEIPT), "utf8"));
  const built = sha256(readFileSync(paths.wasmBindgen));
  if (receipt.host !== host || receipt.wasmBindgenSha256 !== built || receipt.crateSha256 !== pins.wasmBindgenCli.crate.sha256) {
    throw new Error(`the wasm-bindgen in ${directory} is not the one \`tools\` built there from the pinned crate`);
  }
  const bindgen = execFileSync(paths.wasmBindgen, ["--version"], { encoding: "utf8" }).trim();
  if (bindgen !== `wasm-bindgen ${pins.wasmBindgenCli.version}`) {
    throw new Error(`wasm-bindgen reports "${bindgen}"; the pin is "wasm-bindgen ${pins.wasmBindgenCli.version}"`);
  }
  return { ...paths, wasmBindgenSha256: built };
}

function installTools(pins, into) {
  const tools = toolchain(pins);
  const directory = path.resolve(into);
  const paths = toolPaths(pins, directory, tools.host);
  mkdirSync(directory, { recursive: true });
  rmSync(paths.binaryen, { recursive: true, force: true });
  rmSync(path.join(directory, "wasm-bindgen"), { recursive: true, force: true });
  rmSync(path.join(directory, RECEIPT), { force: true });
  withScratch((scratch) => {
    download(paths.asset, path.join(scratch, "binaryen.tar.gz"));
    extract(path.join(scratch, "binaryen.tar.gz"), paths.asset.directory, directory);

    const crate = pins.wasmBindgenCli.crate;
    download(crate, path.join(scratch, "cli.crate"));
    const source = extract(path.join(scratch, "cli.crate"), crate.directory, path.join(scratch, "cli"));
    const lock = sha256(readFileSync(path.join(source, "Cargo.lock")));
    if (lock !== crate.lockSha256) throw new Error(`the crate's Cargo.lock is ${lock}; the pin is ${crate.lockSha256}`);
    const walrus = /\nname = "walrus"\nversion = "([^"]+)"\n/.exec(readFileSync(path.join(source, "Cargo.lock"), "utf8"))?.[1];
    if (walrus !== pins.wasmBindgenCli.walrus) throw new Error(`the crate's Cargo.lock names walrus ${walrus}; the pin is ${pins.wasmBindgenCli.walrus}`);
    execFileSync(
      "cargo",
      ["install", "--locked", "--path", source, "--root", path.join(directory, "wasm-bindgen"), "--bin", "wasm-bindgen"],
      { env: buildEnvironment(pins, { CARGO_TARGET_DIR: path.join(scratch, "cli-target") }), stdio: ["ignore", "inherit", "inherit"] }
    );
  });
  writeFileSync(
    path.join(directory, RECEIPT),
    `${JSON.stringify({ host: tools.host, crateSha256: pins.wasmBindgenCli.crate.sha256, wasmBindgenSha256: sha256(readFileSync(paths.wasmBindgen)) }, null, 2)}\n`
  );
  const checked = checkTools(pins, directory, tools.host);
  console.log(
    `binaryen ${pins.binaryen.version} from the pinned release archive (${paths.asset.sha256}) and wasm-bindgen ` +
      `${pins.wasmBindgenCli.version} built on ${tools.host} from the pinned crate (${pins.wasmBindgenCli.crate.sha256}); ` +
      `the built wasm-bindgen is ${checked.wasmBindgenSha256}.`
  );
}

/**
 * One clean build: cargo, wasm-bindgen, wasm-opt. `cargoHome`, when given,
 * is the cargo home for this build; otherwise it is the machine's.
 */
function cleanBuild(pins, { workspace, targetDirectory, cargoHome, toolsDirectory, recordedHome }) {
  const tools = toolchain(pins);
  const programs = checkTools(pins, toolsDirectory, tools.host);
  const { cargoHomeReal, wrapperLog } = compile(pins, tools, { workspace, targetDirectory, cargoHome, recordedHome });
  assertWrapperLog(readFileSync(wrapperLog, "utf8").split("\n").filter(Boolean), pins, tools.host);
  return pack(pins, tools, programs, { workspace, targetDirectory, cargoHomeReal });
}

/** The cargo step of a build. With `record`, cargo's own `-C metadata` is kept and logged. */
function compile(pins, tools, { workspace, targetDirectory, cargoHome, recordedHome, record = false }) {
  // cargo creates its home on first use; make it now so its real path can
  // be remapped even on a machine that has never run cargo.
  const cargoHomeGiven = cargoHome ?? process.env.CARGO_HOME ?? path.join(os.homedir(), ".cargo");
  mkdirSync(cargoHomeGiven, { recursive: true });
  const cargoHomeReal = realpathSync(cargoHomeGiven);
  // rustc applies the last remap that matches, so the longest path goes
  // last: if one of these ever sat inside another, the inner one would win.
  const remaps = [
    [realpathSync(workspace), "/sbl/adblock-wasm"],
    [cargoHomeReal, recordedHome],
    [realpathSync(tools.sysroot), "/sbl/rust-sysroot"]
  ].sort((a, b) => a[0].length - b[0].length);
  const wrapperDirectory = `${targetDirectory}-rustc-wrapper`;
  const wrapperLog = path.join(wrapperDirectory, "target-crates.log");
  mkdirSync(wrapperDirectory, { recursive: true });
  const wrapper = path.join(wrapperDirectory, "rustc-wrapper.sh");
  writeFileSync(wrapper, wrapperScript(pins, wrapperLog, { record }));
  chmodSync(wrapper, 0o755);
  writeFileSync(wrapperLog, "");
  // CARGO_ENCODED_RUSTFLAGS takes the flags as they are, separated by 0x1f,
  // so a path with a space is still one flag, and it outranks every other
  // source of flags, so an ambient RUSTFLAGS cannot reach this build.
  const env = buildEnvironment(pins, {
    CARGO_ENCODED_RUSTFLAGS: remaps.map(([from, to]) => `--remap-path-prefix=${from}=${to}`).join("\x1f"),
    CARGO_TARGET_DIR: targetDirectory,
    CARGO_HOME: cargoHomeReal,
    RUSTC_WRAPPER: wrapper
  });
  execFileSync("cargo", ["build", "--locked", "--release", "--lib", "--target", pins.rust.target], {
    cwd: workspace,
    env,
    stdio: ["ignore", "inherit", "inherit"]
  });
  return { cargoHomeReal, wrapperLog };
}

/** The two steps after cargo: wasm-bindgen, then wasm-opt on the module it wrote. */
function pack(pins, tools, programs, { workspace, targetDirectory, cargoHomeReal }) {
  const compiled = path.join(targetDirectory, pins.rust.target, "release", `${CRATE_ARTIFACT}.wasm`);
  const packageDirectory = `${targetDirectory}-pkg`;
  rmSync(packageDirectory, { recursive: true, force: true });
  execFileSync(programs.wasmBindgen, [compiled, "--out-dir", packageDirectory, ...pins.wasmBindgenCli.arguments], { stdio: ["ignore", "inherit", "inherit"] });
  const written = readdirSync(packageDirectory).sort();
  if (JSON.stringify(written) !== JSON.stringify([...OUTPUT_FILES].sort())) {
    throw new Error(`wasm-bindgen wrote ${JSON.stringify(written)}; the vendored set is ${JSON.stringify(OUTPUT_FILES)}`);
  }
  const moduleFile = path.join(packageDirectory, MODULE_FILE);
  const optimized = `${targetDirectory}-optimized.wasm`;
  execFileSync(programs.wasmOpt, [moduleFile, "-o", optimized, ...pins.binaryen.arguments], { stdio: ["ignore", "inherit", "inherit"] });
  renameSync(optimized, moduleFile);
  return {
    files: new Map(OUTPUT_FILES.map((name) => [name, readFileSync(path.join(packageDirectory, name))])),
    tools,
    programs,
    hostPaths: [realpathSync(workspace), cargoHomeReal, realpathSync(tools.sysroot), os.homedir(), realpathSync(targetDirectory)]
  };
}

/**
 * A trace of the building machine in an output file is a failure. The one
 * directory the output is allowed to name is the recorded cargo home, which
 * every host's own is remapped to; it is taken out before looking.
 */
export function assertNoHostPath(name, bytes, hostPaths, recordedHome) {
  const text = bytes.toString("latin1").split(recordedHome).join("");
  for (const hostPath of hostPaths) {
    if (text.includes(hostPath)) throw new Error(`${name} names a host path: ${hostPath}`);
  }
  const leak = /\/(?:Users|home|runner|root|private\/tmp|tmp)\/[^\0"]{0,80}/.exec(text);
  if (leak) throw new Error(`${name} names a path that looks like a host's: ${leak[0]}`);
}

function assertBuildNamesNoHost(built, recordedHome) {
  for (const [name, bytes] of built.files) assertNoHostPath(name, bytes, built.hostPaths, recordedHome);
}

function copyWorkspace(into) {
  mkdirSync(into, { recursive: true });
  cpSync(WORKSPACE, into, { recursive: true, filter: (from) => !["target", "pkg"].includes(path.basename(from)) });
  return into;
}

function keep(built, directory) {
  mkdirSync(directory, { recursive: true });
  for (const [name, bytes] of built.files) writeFileSync(path.join(directory, name), bytes);
}

function verify(pins, toolsDirectory, keepAt) {
  const vendored = new Map(OUTPUT_FILES.map((name) => [name, readFileSync(path.join(VENDORED, name))]));
  const recordedHome = cargoHomeName(pins.recordedForm.cargoHome, () => vendored.get(MODULE_FILE));
  const contract = JSON.parse(readFileSync(path.join(ROOT, CONTRACT_PATH), "utf8"));
  return withScratch((scratch) => {
    const started = Date.now();
    const first = cleanBuild(pins, { workspace: WORKSPACE, targetDirectory: path.join(scratch, "first-target"), toolsDirectory, recordedHome });
    const firstSeconds = (Date.now() - started) / 1000;
    // The second build sees a different crate path, deeper and with a space
    // in it, a different target directory, and a cargo home that is new and
    // empty, so cargo fetches every crate again and the remap of the cargo
    // home is exercised even on the host whose own cargo home is the
    // recorded one.
    const second = cleanBuild(pins, {
      workspace: copyWorkspace(path.join(scratch, "a second place", "nested", "adblock-wasm-copy")),
      targetDirectory: path.join(scratch, "second-target"),
      cargoHome: path.join(scratch, "a second cargo home"),
      toolsDirectory,
      recordedHome
    });
    const seconds = (Date.now() - started) / 1000;
    assertBuildNamesNoHost(first, recordedHome);
    assertBuildNamesNoHost(second, recordedHome);
    if (keepAt) keep(first, path.resolve(keepAt));
    const lines = [];
    for (const name of OUTPUT_FILES) {
      const digests = [sha256(first.files.get(name)), sha256(second.files.get(name)), sha256(vendored.get(name))];
      if (digests[0] !== digests[1]) throw new Error(`two clean builds differ in ${name}: ${digests[0]} and ${digests[1]}`);
      if (digests[0] !== digests[2]) {
        throw new Error(`the build is not the vendored ${name}.\n  built:    ${digests[0]} (${first.files.get(name).length} bytes)\n  vendored: ${digests[2]} (${vendored.get(name).length} bytes)`);
      }
      const bound = contract.outputs?.find((entry) => entry.path === `lib/adblock-wasm/${name}`);
      if (bound?.sha256 !== digests[0] || bound?.bytes !== first.files.get(name).length) {
        throw new Error(`${CONTRACT_PATH} does not bind ${name} as built: ${digests[0]}`);
      }
      lines.push(`  ${digests[0]}  ${name} (${first.files.get(name).length} bytes)`);
    }
    console.log(
      `Two clean builds on ${first.tools.host} (${first.tools.cargo}) are byte-identical and are the four vendored files:\n${lines.join("\n")}\n` +
        `wasm-bindgen ${first.programs.wasmBindgenSha256}. First build ${firstSeconds.toFixed(1)} s, both ${seconds.toFixed(1)} s.`
    );
  });
}

function buildOnce(pins, toolsDirectory, out) {
  const recordedHome = cargoHomeName(pins.recordedForm.cargoHome, () => readFileSync(path.join(VENDORED, MODULE_FILE)));
  return withScratch((scratch) => {
    const built = cleanBuild(pins, { workspace: WORKSPACE, targetDirectory: path.join(scratch, "target"), toolsDirectory, recordedHome });
    assertBuildNamesNoHost(built, recordedHome);
    keep(built, path.resolve(out));
    for (const [name, bytes] of built.files) console.log(`${sha256(bytes)}  ${path.join(out, name)} (${bytes.length} bytes, ${built.tools.host})`);
  });
}

/**
 * cargo's own `-C metadata` for each crate of the target on this host, as
 * JSON. On the recording host this is the table in the pins; `verify`
 * checks that on every build there.
 */
function printMetadata(pins) {
  const tools = toolchain(pins);
  return withScratch((scratch) => {
    const { wrapperLog } = compile(pins, tools, {
      workspace: WORKSPACE,
      targetDirectory: path.join(scratch, "target"),
      recordedHome: "/sbl/cargo-home",
      record: true
    });
    const table = {};
    for (const line of readFileSync(wrapperLog, "utf8").split("\n").filter(Boolean)) {
      const [crate, given, ...rest] = line.split(" ");
      if (rest.length !== 1 || !given || Object.hasOwn(table, crate)) throw new Error(`cargo compiled a target crate twice or without -C metadata: ${JSON.stringify(line)}`);
      table[crate] = given;
    }
    const sorted = Object.fromEntries(Object.entries(table).sort(([a], [b]) => (a < b ? -1 : 1)));
    process.stdout.write(`${JSON.stringify({ host: tools.host, targetCrateMetadata: sorted }, null, 2)}\n`);
  });
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  const options = new Map();
  for (let index = 0; index < rest.length; index += 2) {
    if (!/^--(tools|into|out)$/.test(rest[index]) || !rest[index + 1] || options.has(rest[index])) {
      throw new Error(USAGE);
    }
    options.set(rest[index], rest[index + 1]);
  }
  const only = (...names) => [...options.keys()].every((name) => names.includes(name));
  const pins = readPins();
  if (command === "toolchain" && options.size === 0) return installToolchain(pins);
  if (command === "metadata" && options.size === 0) return printMetadata(pins);
  if (command === "tools" && options.has("--into") && only("--into")) return installTools(pins, options.get("--into"));
  if (command === "verify" && options.has("--tools") && only("--tools", "--out")) {
    return verify(pins, path.resolve(options.get("--tools")), options.get("--out"));
  }
  if (command === "build" && options.has("--tools") && options.has("--out") && only("--tools", "--out")) {
    return buildOnce(pins, path.resolve(options.get("--tools")), options.get("--out"));
  }
  throw new Error(USAGE);
}

const USAGE =
  "Usage: adblock-wasm-build.mjs toolchain | tools --into <dir> | verify --tools <dir> [--out <dir>] | build --tools <dir> --out <dir> | metadata";

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
