import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

type FileRecord = { path: string; bytes: number; sha256: string };
type WasmContract = {
  schemaVersion: number;
  status: string;
  claim: string;
  requiredBuild: Record<string, string | boolean>;
  blockers: string[];
  activationCriteria: string[];
  observedBinaryMarkers: {
    rustcCommit: boolean;
    wasmBindgenProducerVersion: boolean;
    hostCargoRegistryPath: boolean;
  };
  inputs: FileRecord[];
  outputs: FileRecord[];
};

type Helpers = {
  buildObservedWasmContract(root?: string): WasmContract;
  assertWasmContractMatches(contract: WasmContract, observed: WasmContract): void;
  verifyWasmContract(root?: string): WasmContract;
  producersProcessedBy(wasm: Buffer): Map<string, string>;
};

const nativeImport = new Function("specifier", "return import(specifier)") as (
  specifier: string
) => Promise<Helpers>;
const helpers = nativeImport(
  pathToFileURL(path.join(process.cwd(), "scripts", "verify-wasm-reproducibility.mjs")).href
);

test("vendored WASM source and output bytes stay bound to an explicitly blocked provenance contract", async () => {
  const { verifyWasmContract } = await helpers;
  const contract = verifyWasmContract();

  assert.equal(contract.status, "blocked");
  assert.equal(contract.claim, "integrity-only-not-reproducible-build");
  // The verifier deepEquals the contract against literals it restates, so an
  // identical edit to both passes it. The documented toolchain and the
  // activation criteria are therefore pinned here independently, in full.
  assert.deepEqual(contract.requiredBuild, {
    cargoLocked: true,
    target: "wasm32-unknown-unknown",
    wasmPackTarget: "nodejs",
    profile: "release",
    rustc: "1.96.1",
    rustcCommit: "31fca3adb283cc9dfd56b49cdee9a96eb9c96ffd",
    cargo: "1.96.1",
    wasmPack: "0.14.0",
    wasmBindgenCli: "0.2.129",
    wasmOpt: "117",
    pathRemapping: "required-before-activation"
  });
  assert.deepEqual(contract.activationCriteria, [
    "pin-and-install-the-declared-rustc-wasm-pack-wasm-bindgen-cli-and-wasm-opt-versions-from-reviewed-sources",
    "rebuild-with-a-fixed-remapped-source-prefix-and-cargo-locked",
    "prove-two-clean-builds-and-all-four-vendored-output-files-are-byte-identical",
    "replace-this-blocked-contract-with-reviewed-build-provenance-and-enforce-the-rebuild-in-ci"
  ]);
  assert.deepEqual(contract.blockers, [
    "wasm-opt-came-from-an-unverified-wasm-pack-tool-cache-download",
    "committed-wasm-embeds-host-cargo-registry-paths",
    "clean-ci-rebuild-and-byte-compare-is-not-active"
  ]);
  assert.equal(contract.inputs.length, 3);
  assert.equal(contract.outputs.length, 4);
  assert.deepEqual(contract.observedBinaryMarkers, {
    rustcCommit: true,
    wasmBindgenProducerVersion: true,
    hostCargoRegistryPath: true
  });
});

test("the wasm-bindgen marker reads the producers section, not an incidental path string", async () => {
  const { producersProcessedBy } = await helpers;
  const vendored = readFileSync(path.join(process.cwd(), "lib/adblock-wasm/sbl_adblock_wasm_bg.wasm"));
  assert.equal(producersProcessedBy(vendored).get("wasm-bindgen"), "0.2.129");
  // 0.2.129 no longer embeds the crate's own source path, so the path marker
  // the 0.2.126 binary carried cannot stand in for the CLI version.
  assert.equal(vendored.toString("latin1").includes("/wasm-bindgen-0.2.129/"), false);

  const name = (value: string) => Buffer.concat([Buffer.from([value.length]), Buffer.from(value, "utf8")]);
  const producers = Buffer.concat([
    name("producers"),
    Buffer.from([1]),
    name("processed-by"),
    Buffer.from([2]),
    name("walrus"),
    name("0.27.2"),
    name("wasm-bindgen"),
    name("0.2.0")
  ]);
  const synthetic = Buffer.concat([
    Buffer.from("\0asm", "latin1"),
    Buffer.from([1, 0, 0, 0]),
    Buffer.from([0, producers.length]),
    producers
  ]);
  assert.equal(producersProcessedBy(synthetic).get("wasm-bindgen"), "0.2.0");
  assert.equal(producersProcessedBy(synthetic).get("walrus"), "0.27.2");
  assert.equal(producersProcessedBy(Buffer.from("not wasm", "utf8")).size, 0);
});

test("WASM integrity verification rejects a stale or optimistic contract", async () => {
  const { assertWasmContractMatches, buildObservedWasmContract } = await helpers;
  const observed = buildObservedWasmContract();

  const stale = structuredClone(observed);
  stale.outputs[0].sha256 = "0".repeat(64);
  assert.throws(
    () => assertWasmContractMatches(stale, observed),
    /source, vendored output, or blocked provenance policy drifted/
  );

  const withoutWasmOpt = structuredClone(observed);
  delete withoutWasmOpt.requiredBuild.wasmOpt;
  assert.throws(
    () => assertWasmContractMatches(withoutWasmOpt, observed),
    /source, vendored output, or blocked provenance policy drifted/
  );

  const otherWasmOpt = structuredClone(observed);
  otherWasmOpt.requiredBuild.wasmOpt = "123";
  assert.throws(
    () => assertWasmContractMatches(otherWasmOpt, observed),
    /source, vendored output, or blocked provenance policy drifted/
  );

  const optimistic = structuredClone(observed);
  optimistic.status = "reproducible";
  optimistic.claim = "reproducible-build";
  assert.throws(
    () => assertWasmContractMatches(optimistic, observed),
    /must stay explicitly blocked/
  );
});
