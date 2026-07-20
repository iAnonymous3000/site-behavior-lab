import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import playwrightPackage from "playwright/package.json";
import playwrightCorePackage from "playwright-core/package.json";
import tldtsPackage from "tldts/package.json";
import { NODE_ADBLOCK_ENGINE_VERSION } from "./legacy-methodology";

type PackageManifest = {
  dependencies?: Record<string, string>;
};

type LockPackage = PackageManifest & {
  version?: string;
};

type PackageLock = {
  packages: Record<string, LockPackage>;
};

const ROOT = process.cwd();
const EXACT_VERSION = /^\d+\.\d+\.\d+$/;

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

test("Playwright package, lockfile, installation, and container base use one exact version", () => {
  const manifest = JSON.parse(source("package.json")) as PackageManifest;
  const lock = JSON.parse(source("package-lock.json")) as PackageLock;
  const declaredVersion = manifest.dependencies?.playwright;

  assert.ok(declaredVersion, "package.json must declare Playwright");
  assert.match(declaredVersion, EXACT_VERSION, "package.json must pin Playwright to an exact version");
  assert.equal(lock.packages[""]?.dependencies?.playwright, declaredVersion);
  assert.equal(lock.packages["node_modules/playwright"]?.version, declaredVersion);
  assert.equal(lock.packages["node_modules/playwright"]?.dependencies?.["playwright-core"], declaredVersion);
  assert.equal(lock.packages["node_modules/playwright-core"]?.version, declaredVersion);
  assert.equal(playwrightPackage.version, declaredVersion);
  assert.equal(playwrightPackage.dependencies["playwright-core"], declaredVersion);
  assert.equal(playwrightCorePackage.version, declaredVersion);

  const fromLines = source("Dockerfile")
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
