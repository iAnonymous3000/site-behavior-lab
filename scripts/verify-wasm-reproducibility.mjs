#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
export const CONTRACT_PATH = "tools/adblock-wasm/reproducibility-contract.json";

const INPUT_PATHS = [
  "tools/adblock-wasm/Cargo.toml",
  "tools/adblock-wasm/Cargo.lock",
  "tools/adblock-wasm/src/lib.rs"
];
const OUTPUT_PATHS = [
  "lib/adblock-wasm/sbl_adblock_wasm.js",
  "lib/adblock-wasm/sbl_adblock_wasm.d.ts",
  "lib/adblock-wasm/sbl_adblock_wasm_bg.wasm",
  "lib/adblock-wasm/sbl_adblock_wasm_bg.wasm.d.ts"
];
const RUSTC_COMMIT = "31fca3adb283cc9dfd56b49cdee9a96eb9c96ffd";
const WASM_BINDGEN_VERSION = "0.2.126";

function fileRecord(root, relativePath) {
  const absolutePath = path.join(root, relativePath);
  const stat = lstatSync(absolutePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`WASM reproducibility input must be a regular non-symlink file: ${relativePath}`);
  }
  const bytes = readFileSync(absolutePath);
  return {
    path: relativePath,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex")
  };
}

export function buildObservedWasmContract(root = ROOT) {
  const wasm = readFileSync(path.join(root, "lib/adblock-wasm/sbl_adblock_wasm_bg.wasm"));
  const wasmText = wasm.toString("latin1");
  return {
    schemaVersion: 1,
    status: "blocked",
    claim: "integrity-only-not-reproducible-build",
    requiredBuild: {
      cargoLocked: true,
      target: "wasm32-unknown-unknown",
      wasmPackTarget: "nodejs",
      profile: "release",
      rustc: "1.96.1",
      rustcCommit: RUSTC_COMMIT,
      cargo: "1.96.1",
      wasmPack: "0.14.0",
      wasmBindgenCli: WASM_BINDGEN_VERSION,
      pathRemapping: "required-before-activation"
    },
    blockers: [
      "generator-provenance-was-not-recorded-at-build-time",
      "committed-wasm-embeds-host-cargo-registry-paths",
      "clean-ci-rebuild-and-byte-compare-is-not-active"
    ],
    activationCriteria: [
      "pin-and-install-the-declared-rustc-wasm-pack-and-wasm-bindgen-cli-versions-from-reviewed-sources",
      "rebuild-with-a-fixed-remapped-source-prefix-and-cargo-locked",
      "prove-two-clean-builds-and-all-four-vendored-output-files-are-byte-identical",
      "replace-this-blocked-contract-with-reviewed-build-provenance-and-enforce-the-rebuild-in-ci"
    ],
    observedBinaryMarkers: {
      rustcCommit: wasm.includes(Buffer.from(`/rustc/${RUSTC_COMMIT}/`, "utf8")),
      wasmBindgenCrateVersion: wasmText.includes(`/wasm-bindgen-${WASM_BINDGEN_VERSION}/`),
      hostCargoRegistryPath: /\/(?:Users|home)\/[^/\0]+\/\.cargo\/registry\//.test(wasmText)
    },
    inputs: INPUT_PATHS.map((entry) => fileRecord(root, entry)),
    outputs: OUTPUT_PATHS.map((entry) => fileRecord(root, entry))
  };
}

export function assertWasmContractMatches(contract, observed) {
  assert.equal(contract?.schemaVersion, 1, "WASM reproducibility contract schema must be 1");
  assert.equal(
    contract?.status,
    "blocked",
    "WASM contract must stay explicitly blocked until a clean byte-rebuild gate replaces it"
  );
  assert.equal(contract?.claim, "integrity-only-not-reproducible-build");
  try {
    assert.deepEqual(contract, observed);
  } catch (error) {
    throw new Error(
      "WASM source, vendored output, or blocked provenance policy drifted; review the change and regenerate the deterministic contract",
      { cause: error }
    );
  }
}

export function verifyWasmContract(root = ROOT) {
  const contract = JSON.parse(readFileSync(path.join(root, CONTRACT_PATH), "utf8"));
  const observed = buildObservedWasmContract(root);
  assertWasmContractMatches(contract, observed);
  assert.equal(observed.observedBinaryMarkers.rustcCommit, true, "vendored WASM lost its recorded rustc marker");
  assert.equal(
    observed.observedBinaryMarkers.wasmBindgenCrateVersion,
    true,
    "vendored WASM lost its locked wasm-bindgen marker"
  );
  assert.equal(
    observed.observedBinaryMarkers.hostCargoRegistryPath,
    true,
    "blocked contract no longer describes the artifact; review before changing the reproducibility claim"
  );
  return observed;
}

/** Pretty contract JSON for the committed file; no key sorting, not a digest input. */
function prettyContractJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function main() {
  const [command] = process.argv.slice(2);
  if (command === "--print") {
    process.stdout.write(prettyContractJson(buildObservedWasmContract()));
    return;
  }
  if (command === "--verify") {
    const contract = verifyWasmContract();
    console.log(
      `WASM integrity contract OK: ${contract.inputs.length} source inputs and ${contract.outputs.length} vendored outputs are hash-bound; reproducible build remains explicitly blocked.`
    );
    return;
  }
  throw new Error("Usage: verify-wasm-reproducibility.mjs --verify | --print");
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
