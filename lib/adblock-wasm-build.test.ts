import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test, type TestContext } from "node:test";

// The checks of scripts/adblock-wasm-build.mjs that need no compiler. The
// build itself (two clean builds compared with the vendored files) runs in
// .github/workflows/adblock-wasm.yml and by hand; nothing here runs cargo.

type Pins = {
  schemaVersion: number;
  rust: { channel: string; rustcCommit: string; target: string; components: Record<string, Record<string, string> | string> };
  wasmBindgenCli: { version: string; walrus: string; crate: { url: string; sha256: string; directory: string }; arguments: string[] };
  binaryen: { version: string; reports: string; arguments: string[]; assets: Record<string, { url: string; directory: string; files: Record<string, string> }> };
  recordedForm: { recordingHost: string; cargoHome: { bytes: number; sha256: string }; targetCrateMetadata: Record<string, string> };
};

type Helpers = {
  PINS_PATH: string;
  OUTPUT_FILES: string[];
  readPins(root?: string): Pins;
  recordedCargoHome(module: Buffer, pin: { bytes: number; sha256: string }): string;
  cargoHomeName(pin: { bytes?: number; sha256?: string; name?: unknown }, readModule: () => Buffer): string;
  wrapperScript(pins: Pins, log: string, options?: { record?: boolean }): string;
  assertWrapperLog(lines: string[], pins: Pins, host: string): void;
  archiveHash(manifest: string, component: string, platform: string): string | null;
  assertArchives(pins: Pins, manifest: string, host: string, whose: string): void;
  assertArchiveEntries(entries: string[], directory: string): void;
  assertNoHostPath(name: string, bytes: Buffer, hostPaths: string[], recordedHome: string): void;
};

const root = process.cwd();
const nativeImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<Helpers>;
const helpers = nativeImport(pathToFileURL(path.join(root, "scripts", "adblock-wasm-build.mjs")).href);
const source = (file: string): string => readFileSync(path.join(root, file), "utf8");
const vendoredModule = (): Buffer => readFileSync(path.join(root, "lib/adblock-wasm/sbl_adblock_wasm_bg.wasm"));

function scratch(t: TestContext): string {
  const directory = mkdtempSync(path.join(tmpdir(), "adblock-wasm-build-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("the build pins restate the toolchain the contract and the lock file record", async () => {
  const { readPins, OUTPUT_FILES } = await helpers;
  const pins = readPins();
  const contract = JSON.parse(source("tools/adblock-wasm/reproducibility-contract.json")) as {
    requiredBuild: Record<string, string | boolean>;
    outputs: { path: string }[];
  };
  // One toolchain is written down in the contract, in the verifier and here.
  // The pins are the copy the rebuild runs, so they are held to the contract.
  assert.equal(pins.rust.channel, contract.requiredBuild.rustc);
  assert.equal(pins.rust.channel, contract.requiredBuild.cargo);
  assert.equal(pins.rust.rustcCommit, contract.requiredBuild.rustcCommit);
  assert.equal(pins.rust.target, contract.requiredBuild.target);
  assert.equal(pins.wasmBindgenCli.version, contract.requiredBuild.wasmBindgenCli);
  assert.equal(pins.wasmBindgenCli.walrus, contract.requiredBuild.walrus);
  assert.equal(pins.binaryen.version, contract.requiredBuild.wasmOpt);
  assert.deepEqual(pins.wasmBindgenCli.arguments, ["--typescript", "--target", contract.requiredBuild.wasmPackTarget]);
  assert.deepEqual(
    OUTPUT_FILES.map((name) => `lib/adblock-wasm/${name}`).sort(),
    contract.outputs.map((entry) => entry.path).sort()
  );

  // The wasm-bindgen tool must be the release the crate links.
  const locked = /\nname = "wasm-bindgen"\nversion = "([^"]+)"\n/.exec(source("tools/adblock-wasm/Cargo.lock"))?.[1];
  assert.equal(pins.wasmBindgenCli.version, locked);
  assert.ok(pins.wasmBindgenCli.crate.url.endsWith(`/wasm-bindgen-cli-${locked}.crate`));
  assert.equal(pins.wasmBindgenCli.crate.directory, `wasm-bindgen-cli-${locked}`);

  for (const [host, asset] of Object.entries(pins.binaryen.assets)) {
    assert.ok(Object.hasOwn(pins.rust.components, host), `${host} has a binaryen release and no Rust components`);
    assert.match(asset.url, new RegExp(`^https://github\\.com/WebAssembly/binaryen/releases/download/version_${pins.binaryen.version}/binaryen-version_${pins.binaryen.version}-[a-z0-9_-]+\\.tar\\.gz$`));
    assert.ok(Object.hasOwn(asset.files, "bin/wasm-opt"));
  }
  assert.ok(pins.binaryen.reports.includes(`version_${pins.binaryen.version}`));
  assert.ok(Object.hasOwn(pins.rust.components, pins.recordedForm.recordingHost));
});

test("the pins do not spell the cargo home, and the vendored module names exactly the recorded one", async () => {
  const { readPins, recordedCargoHome, PINS_PATH } = await helpers;
  const pins = readPins();
  const home = recordedCargoHome(vendoredModule(), pins.recordedForm.cargoHome);
  assert.equal(Buffer.byteLength(home), pins.recordedForm.cargoHome.bytes);
  assert.equal(createHash("sha256").update(home).digest("hex"), pins.recordedForm.cargoHome.sha256);
  // The name holds a user name. It is in the module's bytes and nowhere in
  // the text of the pins or of the script.
  assert.equal(source(PINS_PATH).includes(home), false);
  assert.equal(source("scripts/adblock-wasm-build.mjs").includes(home), false);

  // Another home of the same length is not the recorded one.
  const other = Buffer.from(vendoredModule().toString("latin1").split(home).join(`${home.slice(0, -8)}X/.cargo`), "latin1");
  assert.throws(() => recordedCargoHome(other, pins.recordedForm.cargoHome), /not the one the pins record/);
  // Two homes in one module cannot both be remapped to.
  const two = Buffer.concat([vendoredModule(), Buffer.from("/home/someone/.cargo/registry/src/x", "latin1")]);
  assert.throws(() => recordedCargoHome(two, pins.recordedForm.cargoHome), /must name one cargo home; it names 2/);
  assert.throws(() => recordedCargoHome(Buffer.from("no path here"), pins.recordedForm.cargoHome), /it names 0/);
});

test("a cargo home written in the pins must be a name under /sbl/, never a home", async () => {
  const { readPins, cargoHomeName, recordedCargoHome } = await helpers;
  const pin = readPins().recordedForm.cargoHome;
  // Today the pins write no name, so it comes from the module.
  assert.equal(Object.hasOwn(pin, "name"), false);
  assert.equal(cargoHomeName(pin, vendoredModule), recordedCargoHome(vendoredModule(), pin));
  const unread = (): Buffer => {
    throw new Error("a written name must not need the module");
  };
  assert.equal(cargoHomeName({ name: "/sbl/cargo-home" }, unread), "/sbl/cargo-home");
  for (const name of ["/Users/someone/.cargo", "/home/someone/.cargo", "/sbl/", "/sbl/a/b", "sbl/cargo-home", "", null, 7]) {
    assert.throws(() => cargoHomeName({ name }, unread), /must be \/sbl\/<name>/, String(name));
  }
});

test("the rustc wrapper gives a target crate its recorded metadata and leaves every other call alone", async (t) => {
  const { readPins, wrapperScript } = await helpers;
  const pins = readPins();
  const directory = scratch(t);
  const log = path.join(directory, "a log", "target-crates.log");
  const calls = path.join(directory, "calls");
  const wrapper = path.join(directory, "wrapper.sh");
  const rustc = path.join(directory, "fake rustc.sh");
  mkdirSync(path.dirname(log));
  writeFileSync(wrapper, wrapperScript(pins, log));
  // Stands in for rustc: writes its arguments one per line.
  writeFileSync(rustc, `#!/bin/sh\nfor argument in "$@"; do printf '%s\\n' "$argument"; done > '${calls}'\n`);
  chmodSync(wrapper, 0o755);
  chmodSync(rustc, 0o755);
  const run = (args: string[]) => {
    rmSync(calls, { force: true });
    const result = spawnSync(wrapper, [rustc, ...args], { encoding: "utf8" });
    return { status: result.status, stderr: result.stderr, args: existsSync(calls) ? readFileSync(calls, "utf8").split("\n").slice(0, -1) : null };
  };
  const logged = (): string[] => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []);
  const recorded = pins.recordedForm.targetCrateMetadata;
  const [crate] = Object.keys(recorded);
  assert.ok(crate);

  // A crate for the target: only the metadata value changes, and an
  // argument with a space in it stays one argument.
  const target = ["--crate-name", crate, "a file.rs", "-C", "opt-level=s", "-C", "metadata=cargos", "-C", "extra-filename=-abc", "--target", pins.rust.target];
  const separate = run(target);
  assert.equal(separate.status, 0);
  assert.deepEqual(separate.args, target.map((argument) => (argument === "metadata=cargos" ? `metadata=${recorded[crate]}` : argument)));
  assert.deepEqual(logged(), [`${crate} cargos 1`]);

  // The joined spelling of the flag.
  const joined = run(["--crate-name", crate, "-Cmetadata=joined", "--target", pins.rust.target]);
  assert.deepEqual(joined.args, ["--crate-name", crate, `-Cmetadata=${recorded[crate]}`, "--target", pins.rust.target]);
  assert.deepEqual(logged(), [`${crate} cargos 1`, `${crate} joined 1`]);

  // A value that only looks like the flag is not one.
  const lookalike = run(["--crate-name", crate, "--cfg", "metadata=not-a-codegen-flag", "-C", "metadata=real", "--target", pins.rust.target]);
  assert.deepEqual(lookalike.args, ["--crate-name", crate, "--cfg", "metadata=not-a-codegen-flag", "-C", `metadata=${recorded[crate]}`, "--target", pins.rust.target]);

  // A crate for the host (no --target) and cargo's probe keep every argument.
  const before = logged().length;
  const host = ["--crate-name", crate, "-C", "metadata=cargos"];
  assert.deepEqual(run(host).args, host);
  const otherTarget = ["--crate-name", crate, "-C", "metadata=cargos", "--target", "x86_64-unknown-linux-gnu"];
  assert.deepEqual(run(otherTarget).args, otherTarget);
  const probe = ["-", "--crate-name", "___", "--print=file-names", "--target", pins.rust.target];
  assert.deepEqual(run(probe).args, probe);
  assert.equal(logged().length, before);

  // A target crate the pins do not name stops the build before rustc runs.
  const unknown = run(["--crate-name", "not_in_the_pins", "-C", "metadata=cargos", "--target", pins.rust.target]);
  assert.notEqual(unknown.status, 0);
  assert.equal(unknown.args, null);
  assert.match(unknown.stderr, /no -C metadata for the target crate not_in_the_pins/);

  // Recording changes nothing and logs what cargo gave, for any crate.
  rmSync(log);
  writeFileSync(wrapper, wrapperScript(pins, log, { record: true }));
  assert.deepEqual(run(target).args, target);
  const stranger = ["--crate-name", "not_in_the_pins", "-Cmetadata=cargos2", "--target", pins.rust.target];
  assert.deepEqual(run(stranger).args, stranger);
  assert.deepEqual(run(host).args, host);
  assert.deepEqual(logged(), [`${crate} cargos 1`, "not_in_the_pins cargos2 1"]);
});

test("the wrapper log must show every recorded crate once, and cargo's own values on the recording host", async () => {
  const { readPins, assertWrapperLog } = await helpers;
  const pins = readPins();
  const table = pins.recordedForm.targetCrateMetadata;
  const crates = Object.keys(table);
  const recordingHost = pins.recordedForm.recordingHost;
  const elsewhere = "x86_64-unknown-linux-gnu";
  assert.notEqual(recordingHost, elsewhere);
  const own = crates.map((crate) => `${crate} ${table[crate]} 1`);
  const foreign = crates.map((crate) => `${crate} ${"0".repeat(16)} 1`);

  assertWrapperLog(own, pins, recordingHost);
  // Another platform's cargo computes other values; that is why they are replaced.
  assertWrapperLog(foreign, pins, elsewhere);
  // On the recording host a moved value means the table is no longer cargo's.
  assert.throws(() => assertWrapperLog([foreign[0], ...own.slice(1)], pins, recordingHost), /no longer the recorded one for: /);

  assert.throws(() => assertWrapperLog(own.slice(1), pins, elsewhere), /did not compile for the target: /);
  assert.throws(() => assertWrapperLog([...own, own[0]], pins, elsewhere), /exactly once/);
  assert.throws(() => assertWrapperLog([...own, "stranger abc 1"], pins, elsewhere), /exactly once/);
  assert.throws(() => assertWrapperLog([`${crates[0]} abc 0`, ...own.slice(1)], pins, elsewhere), /exactly once/);
  assert.throws(() => assertWrapperLog([`${crates[0]} abc 2`, ...own.slice(1)], pins, elsewhere), /exactly once/);
});

test("an output may name the recorded cargo home and no other path of a host", async () => {
  const { assertNoHostPath } = await helpers;
  const recorded = "/Users/first/.cargo";
  const module = (text: string): Buffer => Buffer.from(`\0asm${text}\0`, "latin1");
  const hostPaths = ["/work/checkout/tools/adblock-wasm", "/opt/cargo home", "/opt/rustup/toolchains/x"];

  assertNoHostPath("m", module(`${recorded}/registry/src/index/a-1.0/src/lib.rs\0/rustc/abc/library/core/src/fmt.rs`), hostPaths, recorded);
  assert.throws(() => assertNoHostPath("m", module("/opt/cargo home/registry/src/a/lib.rs"), hostPaths, recorded), /m names a host path: \/opt\/cargo home/);
  assert.throws(() => assertNoHostPath("m", module("/Users/second/.cargo/registry/src/a/lib.rs"), hostPaths, recorded), /looks like a host's/);
  assert.throws(() => assertNoHostPath("m", module("/Users/first/project/src/lib.rs"), hostPaths, recorded), /looks like a host's/);
  assert.throws(() => assertNoHostPath("m", module("/home/runner/work/x"), hostPaths, recorded), /looks like a host's/);
  // The recorded home's owner is itself a host path where it is this host's.
  assert.throws(() => assertNoHostPath("m", module("/Users/first/elsewhere"), ["/Users/first"], recorded), /names a host path: \/Users\/first/);
});

test("the vendored files pass the same path check the rebuilt ones must", async () => {
  const { readPins, recordedCargoHome, assertNoHostPath, OUTPUT_FILES } = await helpers;
  const home = recordedCargoHome(vendoredModule(), readPins().recordedForm.cargoHome);
  for (const name of OUTPUT_FILES) {
    assertNoHostPath(name, readFileSync(path.join(root, "lib/adblock-wasm", name)), [], home);
  }
});

test("an archive entry outside the pinned directory is refused before anything is unpacked", async () => {
  const { assertArchiveEntries } = await helpers;
  assertArchiveEntries(["tool-1/", "tool-1/bin/", "tool-1/bin/run"], "tool-1");
  assert.throws(() => assertArchiveEntries([], "tool-1"), /lists no entries/);
  for (const entry of ["tool-2/bin/run", "/tool-1/bin/run", "tool-1/../../escape", "../tool-1/x", "tool-1x/y"]) {
    assert.throws(() => assertArchiveEntries(["tool-1/", entry], "tool-1"), /outside tool-1\//, entry);
  }
});

test("the compiler's archives are read from one unambiguous manifest section each", async () => {
  const { readPins, archiveHash, assertArchives } = await helpers;
  const pins = readPins();
  const section = (component: string, platform: string, hash: string): string =>
    `[pkg.${component}.target.${platform}]\navailable = true\nxz_url = "https://example.invalid/x"\nxz_hash = "${hash}"\n\n`;
  const host = pins.recordedForm.recordingHost;
  const components = pins.rust.components as Record<string, Record<string, string>>;
  const manifest =
    section("rustc", host, components[host].rustc) +
    section("cargo", host, components[host].cargo) +
    section("rust-std", host, components[host]["rust-std"]) +
    section("rust-std", pins.rust.target, components[pins.rust.target]["rust-std"]);
  assert.equal(archiveHash(manifest, "rustc", host), components[host].rustc);
  assert.equal(archiveHash(manifest, "rustc", "riscv64gc-unknown-linux-gnu"), null);
  // A second section of the same name makes the answer ambiguous: none is taken.
  assert.equal(archiveHash(manifest + section("rustc", host, "f".repeat(64)), "rustc", host), null);
  assertArchives(pins, manifest, host, "a manifest");
  assert.throws(
    () => assertArchives(pins, manifest.replace(components[host].cargo, "e".repeat(64)), host, "a manifest"),
    /a manifest lists cargo for .* as e{64}; the pin is /
  );
  assert.throws(() => assertArchives(pins, manifest, "note", "a manifest"), /name no Rust components for the host note/);
});

test("the rebuild workflow stands outside every gate and runs the three steps in order", () => {
  const workflow = source(".github/workflows/adblock-wasm.yml");
  const name = /^name: (.+)$/m.exec(workflow)?.[1];
  assert.equal(name, "Ad-block Module Rebuild");
  const job = /^    name: (.+)$/m.exec(workflow)?.[1];
  assert.ok(job);
  // Nothing may read this workflow's conclusion: a release asset that cannot
  // be fetched must not stop a promotion of code the rebuild does not touch.
  const required = JSON.parse(source(".github/required-ci-jobs.json")) as { jobs: string[] };
  assert.equal(required.jobs.includes(job), false);
  for (const file of readdirSync(path.join(root, ".github/workflows")).filter((entry) => entry !== "adblock-wasm.yml")) {
    assert.equal(source(`.github/workflows/${file}`).includes(name), false, `${file} names the rebuild workflow`);
  }
  assert.match(workflow, /^permissions:\n  contents: read\n/m);
  assert.doesNotMatch(workflow, /continue-on-error|secrets\.|id-token|contents: write/);
  const steps = [
    "run: node scripts/adblock-wasm-build.mjs toolchain\n",
    'run: node scripts/adblock-wasm-build.mjs tools --into "$RUNNER_TEMP/adblock-wasm-tools"\n',
    'node scripts/adblock-wasm-build.mjs verify\n          --tools "$RUNNER_TEMP/adblock-wasm-tools"\n'
  ].map((step) => workflow.indexOf(step));
  assert.ok(steps.every((at) => at > 0), JSON.stringify(steps));
  assert.deepEqual([...steps].sort((a, b) => a - b), steps);
  // The static contract check runs in the same job, so one run shows the
  // rebuilt bytes and the bound bytes are the same files.
  assert.ok(workflow.indexOf("run: node scripts/verify-wasm-reproducibility.mjs --verify\n") > 0);
});
