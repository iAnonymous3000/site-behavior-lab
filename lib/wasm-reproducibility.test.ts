import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

type FileRecord = { path: string; bytes: number; sha256: string };
type WasmContract = {
  schemaVersion: number;
  status: string;
  claim: string;
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
  assert.deepEqual(contract.blockers, [
    "generator-provenance-was-not-recorded-at-build-time",
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

  const optimistic = structuredClone(observed);
  optimistic.status = "reproducible";
  optimistic.claim = "reproducible-build";
  assert.throws(
    () => assertWasmContractMatches(optimistic, observed),
    /must stay explicitly blocked/
  );
});
