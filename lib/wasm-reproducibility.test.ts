import assert from "node:assert/strict";
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
    wasmBindgenCrateVersion: boolean;
    hostCargoRegistryPath: boolean;
  };
  inputs: FileRecord[];
  outputs: FileRecord[];
};

type Helpers = {
  buildObservedWasmContract(root?: string): WasmContract;
  assertWasmContractMatches(contract: WasmContract, observed: WasmContract): void;
  verifyWasmContract(root?: string): WasmContract;
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
    wasmBindgenCli: "0.2.126",
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
    wasmBindgenCrateVersion: true,
    hostCargoRegistryPath: true
  });
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
