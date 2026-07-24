import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import playwrightPackage from "playwright/package.json";
import playwrightCorePackage from "playwright-core/package.json";
import tldtsPackage from "tldts/package.json";
import { NODE_ADBLOCK_ENGINE_VERSION, NODE_PLAYWRIGHT_VERSION } from "./legacy-methodology";

type PackageManifest = {
  dependencies?: Record<string, string>;
  engines?: Record<string, string>;
  packageManager?: string;
};

type LockPackage = PackageManifest & {
  version?: string;
};

type PackageLock = {
  packages: Record<string, LockPackage>;
};

const ROOT = process.cwd();
const EXACT_VERSION = /^\d+\.\d+\.\d+$/;
const REQUIRED_NODE = "24.14.1";
const REQUIRED_NPM = "11.11.0";
const REQUIRED_CONTAINER_NODE = "24.17.0";
const REQUIRED_CONTAINER_NPM = "11.13.0";

function source(relativePath: string): string {
  return readFileSync(path.join(ROOT, relativePath), "utf8");
}

function exactCargoPackageVersion(packageName: string): string {
  const packageBlocks = source("tools/adblock-wasm/Cargo.lock")
    .split(/^\[\[package\]\]\s*$/m)
    .slice(1);
  const nameLine = new RegExp(`^name = "${packageName}"\\s*$`, "m");
  const matches = packageBlocks.filter((block) => nameLine.test(block));

  assert.equal(matches.length, 1, `Cargo.lock must resolve exactly one ${packageName} package`);
  const version = /^version = "([^"]+)"\s*$/m.exec(matches[0]);
  assert.ok(version, `Cargo.lock ${packageName} package must have a version`);
  assert.match(version[1], EXACT_VERSION, `Cargo.lock ${packageName} version must be exact`);
  return version[1];
}

test("published adblock provenance matches the exact locked engine version", () => {
  assert.equal(NODE_ADBLOCK_ENGINE_VERSION, `adblock-rust-${exactCargoPackageVersion("adblock")}`);
});

test("repository and non-CI workflows use one exact Node and npm toolchain", () => {
  const manifest = JSON.parse(source("package.json")) as PackageManifest;
  const lock = JSON.parse(source("package-lock.json")) as PackageLock;
  const lockRoot = lock.packages[""];

  assert.equal(manifest.engines?.node, REQUIRED_NODE);
  assert.equal(manifest.engines?.npm, REQUIRED_NPM);
  assert.equal(manifest.packageManager, `npm@${REQUIRED_NPM}`);
  assert.equal(lockRoot?.engines?.node, REQUIRED_NODE);
  assert.equal(lockRoot?.engines?.npm, REQUIRED_NPM);
  assert.equal(lockRoot?.packageManager, manifest.packageManager);
  assert.equal(source(".nvmrc").trim(), REQUIRED_NODE);
  assert.equal(source(".node-version").trim(), REQUIRED_NODE);

  const workflowDirectory = path.join(ROOT, ".github", "workflows");
  let setupNodeJobs = 0;
  for (const name of readdirSync(workflowDirectory).sort()) {
    if (name === "ci.yml" || !/\.ya?ml$/.test(name)) continue;
    const workflow = readFileSync(path.join(workflowDirectory, name), "utf8");
    const setupCount = (workflow.match(/^\s*uses:\s*actions\/setup-node@/gm) ?? []).length;
    if (setupCount === 0) continue;
    setupNodeJobs += setupCount;

    assert.equal(
      (workflow.match(/^\s*node-version:\s*24\.14\.1\s*$/gm) ?? []).length,
      setupCount,
      `${name} must pin every setup-node input to Node ${REQUIRED_NODE}`
    );
    assert.equal(
      (workflow.match(/^\s*test "\$\(node --version\)" = "v24\.14\.1"\s*$/gm) ?? []).length,
      setupCount,
      `${name} must verify the exact Node runtime before install`
    );
    assert.equal(
      (workflow.match(/^\s*test "\$\(npm --version\)" = "11\.11\.0"\s*$/gm) ?? []).length,
      setupCount,
      `${name} must verify the exact npm runtime before install`
    );
  }
  assert.ok(setupNodeJobs > 0, "at least one non-CI setup-node job must be covered");
});

test("Playwright package, lockfile, installation, and container base use one exact version", () => {
  const manifest = JSON.parse(source("package.json")) as PackageManifest;
  const lock = JSON.parse(source("package-lock.json")) as PackageLock;
  const declaredVersion = manifest.dependencies?.playwright;

  assert.ok(declaredVersion, "package.json must declare Playwright");
  assert.match(declaredVersion, EXACT_VERSION, "package.json must pin Playwright to an exact version");
  assert.equal(NODE_PLAYWRIGHT_VERSION, declaredVersion);
  assert.equal(lock.packages[""]?.dependencies?.playwright, declaredVersion);
  assert.equal(lock.packages["node_modules/playwright"]?.version, declaredVersion);
  assert.equal(lock.packages["node_modules/playwright"]?.dependencies?.["playwright-core"], declaredVersion);
  assert.equal(lock.packages["node_modules/playwright-core"]?.version, declaredVersion);
  assert.equal(playwrightPackage.version, declaredVersion);
  assert.equal(playwrightPackage.dependencies["playwright-core"], declaredVersion);
  assert.equal(playwrightCorePackage.version, declaredVersion);

  const dockerfile = source("Dockerfile");
  const fromLines = dockerfile
    .split(/\r?\n/)
    .filter((line) => line.startsWith("FROM "));
  const externalBase = fromLines.filter((line) => line.startsWith("FROM mcr.microsoft.com/playwright:"));

  assert.equal(externalBase.length, 1, "Dockerfile must declare one literal external Playwright base");
  const base =
    /^FROM mcr\.microsoft\.com\/playwright:v(\d+\.\d+\.\d+)-noble@sha256:([a-f0-9]{64}) AS playwright-base$/.exec(
      externalBase[0]
    );
  assert.ok(base, "Playwright base must use a literal version, noble, and a lowercase SHA-256 digest");
  assert.equal(base[1], declaredVersion);
  assert.equal(base[2].length, 64);
  assert.deepEqual(fromLines, [externalBase[0], "FROM playwright-base AS build", "FROM playwright-base AS runner"]);

  const runtimePin =
    /RUN test "\$\(node --version\)" = "v(\d+\.\d+\.\d+)" \\\n\s+&& test "\$\(npm --version\)" = "(\d+\.\d+\.\d+)"/.exec(
      dockerfile
    );
  assert.ok(runtimePin, "Dockerfile must fail closed on exact Node/npm versions from the pinned base digest");
  assert.deepEqual(runtimePin.slice(1), [REQUIRED_CONTAINER_NODE, REQUIRED_CONTAINER_NPM]);
  assert.notEqual(REQUIRED_CONTAINER_NODE, REQUIRED_NODE, "container and host Node pins are intentionally distinct");
  assert.notEqual(REQUIRED_CONTAINER_NPM, REQUIRED_NPM, "container and host npm pins are intentionally distinct");

  // The runner stage must strip every global package manager (the base's npm
  // bundle carries its own tar/undici/sigstore copies) and assert the absence,
  // matching the release-evidence container probe's absence contract.
  const runnerDockerfile = source("Dockerfile");
  const runnerStage = runnerDockerfile.slice(runnerDockerfile.indexOf("FROM playwright-base AS runner"));
  assert.match(runnerStage, /rm -rf \/usr\/lib\/node_modules \/usr\/local\/lib\/node_modules/);
  assert.match(runnerStage, /apt-get purge -y gstreamer1\.0-plugins-bad libgstreamer-plugins-bad1\.0-0/);
  assert.match(runnerStage, /! command -v npm && ! command -v npx && ! command -v yarn && ! command -v corepack/);
});

test("tldts manifest, lockfile, and installation use one exact version", () => {
  const manifest = JSON.parse(source("package.json")) as PackageManifest;
  const lock = JSON.parse(source("package-lock.json")) as PackageLock;
  const declaredVersion = manifest.dependencies?.tldts;

  assert.ok(declaredVersion, "package.json must declare tldts");
  assert.match(declaredVersion, EXACT_VERSION, "package.json must pin tldts to an exact version");
  assert.equal(lock.packages[""]?.dependencies?.tldts, declaredVersion);
  assert.equal(lock.packages["node_modules/tldts"]?.version, declaredVersion);
  assert.equal(lock.packages["node_modules/tldts"]?.dependencies?.["tldts-core"], `^${declaredVersion}`);
  assert.equal(lock.packages["node_modules/tldts-core"]?.version, declaredVersion);
  assert.equal(tldtsPackage.version, declaredVersion);
  assert.equal(tldtsPackage.dependencies["tldts-core"], `^${declaredVersion}`);
});

test("runtime container includes the module imported by next.config", () => {
  const nextConfig = source("next.config.mjs");
  const dockerfile = source("Dockerfile");

  assert.match(nextConfig, /from "\.\/scripts\/public-build-commit\.mjs"/);
  assert.match(
    dockerfile,
    /^COPY --from=build \/app\/scripts\/public-build-commit\.mjs \.\/scripts\/public-build-commit\.mjs$/m
  );
});
