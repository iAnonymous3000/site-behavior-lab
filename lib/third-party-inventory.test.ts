import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const SCRIPT = path.join(process.cwd(), "scripts", "third-party-inventory.mjs");
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);

function fixtureRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "sbl-third-party-inventory-"));
  mkdirSync(path.join(root, "tools", "adblock-wasm"), { recursive: true });
  mkdirSync(path.join(root, "lib", "adblock-wasm"), { recursive: true });

  writeFileSync(
    path.join(root, "package-lock.json"),
    `${JSON.stringify(
      {
        name: "fixture",
        version: "1.0.0",
        lockfileVersion: 3,
        requires: true,
        packages: {
          "": { name: "fixture", version: "1.0.0", license: "AGPL-3.0-or-later" },
          "node_modules/zeta": {
            version: "2.0.0",
            resolved: "https://registry.npmjs.org/zeta/-/zeta-2.0.0.tgz",
            integrity: "sha512-fixture",
            dev: true,
            license: "MIT"
          },
          "node_modules/parent/node_modules/@scope/alpha": {
            version: "1.2.3",
            resolved: "https://registry.npmjs.org/@scope/alpha/-/alpha-1.2.3.tgz",
            integrity: "sha512-fixture-two",
            optional: true
          }
        }
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  writeFileSync(
    path.join(root, "tools", "adblock-wasm", "Cargo.toml"),
    `[package]\nname = "fixture-wasm"\nversion = "0.1.0"\nlicense = "MPL-2.0"\n`,
    "utf8"
  );
  writeFileSync(
    path.join(root, "tools", "adblock-wasm", "Cargo.lock"),
    `# generated\nversion = 4\n\n[[package]]\nname = "zeta-crate"\nversion = "2.0.0"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = "${SHA_B}"\n\n[[package]]\nname = "fixture-wasm"\nversion = "0.1.0"\n\n[[package]]\nname = "alpha-crate"\nversion = "1.0.0"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = "${SHA_A}"\n`,
    "utf8"
  );
  writeFileSync(
    path.join(root, "lib", "adblock-wasm", "brave-default-filters.meta.json"),
    `${JSON.stringify(
      {
        fetchedAt: "2035-01-01T00:00:00.000Z",
        catalog: `https://raw.githubusercontent.com/brave/adblock-resources/${"d".repeat(40)}/filter_lists/list_catalog.json`,
        catalogCommit: "d".repeat(40),
        catalogSha256: SHA_C,
        sourceCount: 2,
        sources: [
          { url: "https://example.invalid/z-list.txt", bytes: 12, sha256: SHA_B },
          { url: "https://example.invalid/a-list.txt", bytes: 7, sha256: SHA_A }
        ],
        manifestDigest: SHA_A,
        rulesDigest: SHA_B,
        rawBytes: 20,
        gzipBytes: 10
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  return root;
}

function run(root: string, ...args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, "--root", root, ...args], {
    encoding: "utf8"
  });
}

test("third-party inventory generation is deterministic and evidence-conservative", (context) => {
  const root = fixtureRoot();
  context.after(() => rmSync(root, { recursive: true, force: true }));

  const generated = run(root);
  assert.equal(generated.status, 0, generated.stderr);
  const outputPath = path.join(root, "THIRD_PARTY_INVENTORY.json");
  const firstBytes = readFileSync(outputPath, "utf8");
  const first = JSON.parse(firstBytes);

  assert.equal(first.schemaVersion, 1);
  assert.equal(first.legalReviewRequired, true);
  assert.match(first.notice, /not legal advice/);
  assert.match(first.notice, /UNKNOWN/);
  assert.equal(firstBytes.includes("2035-01-01"), false, "source timestamps must not enter the artifact");

  assert.deepEqual(
    first.npm.map((entry: { name: string }) => entry.name),
    ["@scope/alpha", "zeta"]
  );
  assert.deepEqual(
    {
      license: first.npm[0].license,
      licenseStatus: first.npm[0].licenseStatus,
      licenseEvidence: first.npm[0].licenseEvidence
    },
    {
      license: "UNKNOWN",
      licenseStatus: "unknown-not-recorded-in-package-lock",
      licenseEvidence: null
    }
  );
  assert.equal(first.npm[1].license, "MIT");
  assert.equal(first.npm[1].licenseEvidence, "package-lock.json");

  assert.deepEqual(
    first.cargo.map((entry: { name: string }) => entry.name),
    ["alpha-crate", "fixture-wasm", "zeta-crate"]
  );
  assert.equal(first.cargo[0].license, "UNKNOWN");
  assert.equal(first.cargo[0].checksum, SHA_A);
  assert.equal(first.cargo[1].kind, "workspace");
  assert.equal(first.cargo[1].license, "MPL-2.0");
  assert.equal(first.cargo[1].licenseEvidence, "tools/adblock-wasm/Cargo.toml");

  assert.deepEqual(
    first.filterLists.sources.map((entry: { sourceIndex: number; url: string }) => [entry.sourceIndex, entry.url]),
    [
      [0, "https://example.invalid/z-list.txt"],
      [1, "https://example.invalid/a-list.txt"]
    ],
    "filter ordering is provenance and must be preserved"
  );
  assert.equal(first.filterLists.sources[0].license, "UNKNOWN");
  assert.deepEqual(first.filterLists.catalog, {
    url: `https://raw.githubusercontent.com/brave/adblock-resources/${"d".repeat(40)}/filter_lists/list_catalog.json`,
    commit: "d".repeat(40),
    sha256: SHA_C
  });

  const regenerated = run(root);
  assert.equal(regenerated.status, 0, regenerated.stderr);
  assert.equal(readFileSync(outputPath, "utf8"), firstBytes, "repeat generation must be byte-identical");

  const checked = run(root, "--check");
  assert.equal(checked.status, 0, checked.stderr);
  assert.match(checked.stdout, /inventory verified/);
});

test("check mode detects tampering without rewriting the generated artifact", (context) => {
  const root = fixtureRoot();
  context.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(run(root).status, 0);

  const outputPath = path.join(root, "THIRD_PARTY_INVENTORY.json");
  writeFileSync(outputPath, "{}\n", "utf8");
  const checked = run(root, "--check");

  assert.equal(checked.status, 1);
  assert.match(checked.stderr, /is stale/);
  assert.equal(readFileSync(outputPath, "utf8"), "{}\n");
});

test("generation fails closed when filter provenance is internally inconsistent", (context) => {
  const root = fixtureRoot();
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const metadataPath = path.join(root, "lib", "adblock-wasm", "brave-default-filters.meta.json");
  const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
  metadata.sourceCount = 1;
  writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");

  const generated = run(root);
  assert.equal(generated.status, 1);
  assert.match(generated.stderr, /sourceCount must match sources\.length/);
  assert.equal(generated.stdout, "");
});
