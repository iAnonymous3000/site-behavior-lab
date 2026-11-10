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
const REQUIRED_CONTAINER_NODE = "24.22.1";
const REQUIRED_CONTAINER_NPM = "11.19.1";

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
  assert.deepEqual(fromLines, [
    externalBase[0],
    "FROM playwright-base AS deps",
    "FROM deps AS build",
    "FROM playwright-base AS runner"
  ]);

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

test("the runner stage fails the build unless every advisory-named package is at or past its fix", () => {
  // libssl3t64 and openssl are not pinned, because the pinned base already
  // ships the CVE-2026-84782 fix, so only this assertion stops a later base
  // from shipping an older OpenSSL. Every package the upgrade step pins must be
  // asserted at its pinned version too, after that step and before USER, in
  // one && chain that dash stops at the first failed check, read or
  // comparison. Each package is first required to be installed exactly once,
  // as one copy whose dpkg status is installed: a copy left as configuration
  // files still has a version to read, and a second architecture's copy would
  // join its version to the first one's, which can still compare as new enough.
  // The chain ends the upgrade step and has no step of its own: a step that
  // changes no file still adds a layer, the same empty one each time, the base
  // stage's browser check already adds one, and the container package
  // inventory refuses an image whose rootfs lists one layer twice.
  const OPENSSL_FIX = "3.0.13-0ubuntu3.16";
  const dockerfile = source("Dockerfile");
  const runnerStage = dockerfile.slice(dockerfile.indexOf("FROM playwright-base AS runner"));
  // The step first moves the base's Ubuntu sources to HTTPS and refuses a
  // plain http one, and its apt-get commands turn retries off (the test
  // after this one holds those lines).
  const upgrade =
    /^RUN sed -i '[^'\n]+' \/etc\/apt\/sources\.list\.d\/ubuntu\.sources \\\n {2}&& ! grep -rqsE '[^'\n]+' \/etc\/apt\/sources\.list \/etc\/apt\/sources\.list\.d \\\n {2}&& apt-get -o Acquire::Retries=0 -o APT::Update::Error-Mode=any update \\\n {2}&& apt-get -o Acquire::Retries=0 install -y --no-install-recommends --only-upgrade \\\n((?: {4}\S.* \\\n)+)/m.exec(
      runnerStage
    );
  assert.ok(upgrade, "the runner stage must keep its exact-version upgrade step");
  const pinned = new Map([...upgrade[1].matchAll(/([a-z0-9][a-z0-9.+-]*)=(\S+)/g)].map((pin) => [pin[1], pin[2]]));
  assert.ok(pinned.size > 0, "the upgrade step must pin at least one package");

  const upgradeEnd = runnerStage.indexOf("\n\n", upgrade.index);
  assert.ok(upgradeEnd > upgrade.index, "the upgrade step must end at a blank line");
  assert.ok(upgradeEnd < runnerStage.indexOf("\nUSER pwuser\n"), "the upgrade step and its version assertion must run as root, before USER");
  const upgradeStep = runnerStage.slice(upgrade.index, upgradeEnd);
  const start = upgradeStep.indexOf(' \\\n  && test "$(dpkg-query ');
  assert.ok(start >= 0, "the upgrade step must end with the version assertion, not leave it to a step of its own");
  assert.ok(start >= upgrade[0].length, "the version assertion must follow the upgrade");
  const elsewhere = (runnerStage.slice(0, upgrade.index) + runnerStage.slice(upgradeEnd))
    .split("\n")
    .filter((line) => !line.startsWith("#"));
  assert.ok(
    !elsewhere.some((line) => line.includes("dpkg-query")),
    "no other runner step may read dpkg, since a step that only checks adds a second empty layer"
  );
  const steps = upgradeStep.slice(start + " \\\n  && ".length).split(" \\\n  && ");
  assert.equal(steps.length % 3, 0, "each package needs one single-copy check, one read and one comparison");
  const asserted = new Map<string, string>();
  for (let index = 0; index < steps.length; index += 3) {
    const once = /^test "\$\(dpkg-query -W -f='\$\{db:Status-Status\}' ([a-z0-9][a-z0-9.+-]*)\)" = installed$/.exec(steps[index]);
    const read = /^v=\$\(dpkg-query -W -f='\$\{Version\}' ([a-z0-9][a-z0-9.+-]*)\)$/.exec(steps[index + 1]);
    const compare = /^dpkg --compare-versions "\$v" ge (\S+)$/.exec(steps[index + 2]);
    assert.ok(once, `assertion step ${index} must require exactly one copy of a package, with status installed: ${steps[index]}`);
    assert.ok(read, `assertion step ${index + 1} must read one package version into v: ${steps[index + 1]}`);
    assert.ok(compare, `assertion step ${index + 2} must require ge a minimum: ${steps[index + 2]}`);
    assert.equal(read[1], once[1], `the version read must name the package checked for one installed copy: ${steps[index + 1]}`);
    assert.ok(!asserted.has(read[1]), `${read[1]} must be asserted once`);
    asserted.set(read[1], compare[1]);
  }
  assert.deepEqual(
    Object.fromEntries([...asserted].sort()),
    Object.fromEntries([...pinned, ["libssl3t64", OPENSSL_FIX], ["openssl", OPENSSL_FIX]].sort())
  );
});

test("the base's vulnerable apt downloads with its retries off and from HTTPS sources only", () => {
  // CVE-2026-109518 is remote code execution via hard link reuse during
  // package download retries, in the apt the base ships and fixed in the
  // version the upgrade step pins. The fixed apt arrives only when that
  // step's install ends, so every download of the image build, the deps
  // stage's and the upgrade step's own, is made by the vulnerable one. apt
  // retries a failed download three times unless told otherwise, and the
  // base's sources are plain http. So while the pin stands, each apt-get that
  // downloads must turn retries off, and at any time no step may raise them.
  // Each step that runs apt must also move the base's Ubuntu sources to HTTPS
  // before its first apt command and fail if any apt source still names
  // http://, so a base whose sources the rewrite misses cannot leave the
  // vulnerable apt on plain http unseen. And apt-get update exits 0 when an
  // index fails to download, so each one must be told to fail on any failed
  // index: with retries off that is one failed request, and the install
  // after it would otherwise read whatever indexes did arrive.
  const dockerfile = source("Dockerfile");
  const commands = dockerfile
    .split("\n")
    .filter((line) => !line.startsWith("#"))
    .join("\n");
  // One instruction per element: a line that ends in a backslash continues.
  const instructions = commands.replace(/\\\n/g, "\u0000").split("\n").map((instruction) => instruction.replaceAll("\u0000", "\\\n"));
  const apt = instructions.filter((instruction) => /\bapt(?:-get|-cache|itude)?\b/.test(instruction));
  assert.equal(apt.length, 2, "apt runs in the deps stage's step and the runner stage's upgrade step, and nowhere else");
  const pinsApt = apt.some((instruction) => /\sapt=\S+/.test(instruction));

  // Retries: never above 0, set by nothing but the option on a command.
  for (const setting of commands.matchAll(/Acquire::Retries\S*/g)) {
    assert.equal(setting[0], "Acquire::Retries=0", "no step may give apt a retry count other than 0");
  }
  assert.doesNotMatch(commands, /apt\.conf|APT_CONFIG/, "no step may configure apt except by an option on its command");
  const downloads = [...commands.matchAll(/apt-get\b[^\n&|;]*?\b(update|install|upgrade|dist-upgrade|full-upgrade|download|source|build-dep)\b/g)].map((match) => match[0]);
  assert.deepEqual(
    downloads.map((download) => download.split(" ").at(-1)),
    ["update", "install", "update", "install"],
    "the deps stage's step and the upgrade step each update and install once"
  );
  for (const update of downloads.filter((download) => download.endsWith(" update"))) {
    assert.match(update, / -o APT::Update::Error-Mode=any update$/, `${update} must fail when any index fails to download`);
    assert.equal(update.split("Error-Mode").length - 1, 1, `${update} must name one error mode`);
  }
  if (pinsApt) {
    for (const download of downloads) {
      assert.match(
        download,
        /^apt-get -o Acquire::Retries=0 (?:-o APT::Update::Error-Mode=any update|install)$/,
        `while the base's apt is older than its fix, ${download} must run with retries off`
      );
    }
  }

  // HTTPS: the rewrite, then the refusal of any http source, then apt.
  const rewrite = "sed -i 's|^URIs: http://|URIs: https://|' /etc/apt/sources.list.d/ubuntu.sources";
  const noPlainHttp = "! grep -rqsE '^[^#]*http://' /etc/apt/sources.list /etc/apt/sources.list.d";
  for (const instruction of apt) {
    const where = instruction.slice(0, 60);
    const parts = instruction.replace(/^RUN /, "").split(" \\\n  && ");
    assert.equal(parts[0], rewrite, `a step that runs apt must first move the Ubuntu sources to HTTPS: ${where}`);
    assert.equal(parts[1], noPlainHttp, `then fail if any apt source still names http://: ${where}`);
    assert.match(parts[2], /^apt-get /, `and only then run apt: ${where}`);
    const rest = parts.slice(2).join("\n");
    assert.doesNotMatch(rest, /http:\/\/|sources\.list|\bsed\b|\btee\b|>/, `nothing after the check may name or write an apt source: ${where}`);
  }
});

test("the container base's bundled scan browser is the one the installed playwright-core names", () => {
  // Production launches the headless shell in the base image's own
  // /ms-playwright: the runner stage is FROM playwright-base and copies only
  // /app. A base rebuilt with a newer patch under the same revision would ship
  // a browser CI never ran, so the base stage requires exactly one headless
  // shell in the revision folder browsers.json names, at its exact version,
  // and this ties both literals to browsers.json.
  const browsers = (JSON.parse(source("node_modules/playwright-core/browsers.json")) as {
    browsers: Array<{ name: string; revision: string; browserVersion?: string }>;
  }).browsers;
  const shell = browsers.find((browser) => browser.name === "chromium-headless-shell");
  assert.ok(shell?.browserVersion, "playwright-core must name a chromium-headless-shell version");
  const dockerfile = source("Dockerfile");
  const baseStage = dockerfile.slice(0, dockerfile.indexOf("FROM playwright-base AS deps"));
  const assertions = [...baseStage.matchAll(
    /^ {2}&& set -- \/ms-playwright\/chromium_headless_shell-(\d+)\/\*\/chrome-headless-shell \\\n {2}&& test "\$#" -eq 1 \\\n {2}&& test -x "\$1" \\\n {2}&& test "\$\("\$1" --version\)" = "Google Chrome for Testing (\d+\.\d+\.\d+\.\d+)"$/gm
  )];
  assert.equal(assertions.length, 1, "the Playwright base stage must require exactly one headless shell at its exact version, once");
  assert.deepEqual(
    { revision: assertions[0][1], version: assertions[0][2] },
    { revision: shell.revision, version: shell.browserVersion }
  );
  assert.equal(dockerfile.split("/chrome-headless-shell").length - 1, 1, "only the base stage names the headless shell");
  // The base stage is one step, and the browser check is part of it. A step
  // that changes no file adds the same empty layer each time, every image
  // built FROM this stage inherits it, and the container package inventory
  // refuses an image whose rootfs lists one layer twice. Two checking steps
  // here passed every emulated build, where they leave Node's compile cache in
  // /tmp and so one layer is not empty, and failed the first native one.
  const baseSteps = baseStage.split("\n").filter((line) => /^(RUN|COPY|ADD|WORKDIR)\b/.test(line));
  assert.deepEqual(
    baseSteps.map((line) => line.split(" ")[0]),
    ["RUN"],
    "the Playwright base stage must hold exactly one layer-adding step, its single checking RUN"
  );
  assert.match(
    baseStage,
    /^RUN test "\$\(node --version\)" = "v\d+\.\d+\.\d+" \\\n {2}&& test "\$\(npm --version\)" = "\d+\.\d+\.\d+" \\\n {2}&& set -- \/ms-playwright\//m,
    "the runtime version check and the browser check must be the same step"
  );
  // The runner stage must not install or copy a browser of its own.
  const runnerStage = dockerfile.slice(dockerfile.indexOf("FROM playwright-base AS runner"));
  assert.doesNotMatch(runnerStage, /playwright install|ms-playwright|PLAYWRIGHT_BROWSERS_PATH/);
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
