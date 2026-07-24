#!/usr/bin/env node

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  readResponseJsonWithinLimit,
  withHttpOperationDeadline
} from "./http-response.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const USER_AGENT = "site-behavior-lab-ci (toolchain drift check)";
const FETCH_ATTEMPTS = 3;
const FETCH_TIMEOUT_MS = 20_000;
const FETCH_RESPONSE_MAX_BYTES = 1024 * 1024;
const STABLE_SEMVER_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const CHROME_VERSION_PATTERN =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const REVISION_PATTERN = /^(?:0|[1-9]\d*)$/;
const CRATES_IO_SOURCES = new Set([
  "registry+https://github.com/rust-lang/crates.io-index",
  "registry+https://index.crates.io/",
  "registry+sparse+https://index.crates.io/"
]);

const CRATES_IO_ADBLOCK_URL = "https://crates.io/api/v1/crates/adblock";
const NPM_PLAYWRIGHT_URL = "https://registry.npmjs.org/playwright/latest";
const NPM_TLDTS_URL = "https://registry.npmjs.org/tldts/latest";
const PLAYWRIGHT_TAG_BROWSERS_URL = (version) =>
  `https://raw.githubusercontent.com/microsoft/playwright/v${version}/packages/playwright-core/browsers.json`;
const PLAYWRIGHT_TAG_SECCOMP_URL = (version) =>
  `https://raw.githubusercontent.com/microsoft/playwright/v${version}/utils/docker/seccomp_profile.json`;
const CHROME_STABLE_URL =
  "https://versionhistory.googleapis.com/v1/chrome/platforms/linux/channels/stable/versions?order_by=version%20desc&page_size=1";

function parseArguments(argv) {
  let reportPath = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument !== "--report") throw new Error(`Unknown argument: ${argument}`);
    if (reportPath !== null) throw new Error("--report may only be provided once.");
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error("--report requires a file path.");
    reportPath = path.resolve(value);
    index += 1;
  }
  return { reportPath };
}

function requiredString(value, label, pattern = STABLE_SEMVER_PATTERN) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`${label} is missing or malformed.`);
  }
  return value;
}

function parseJson(source, label) {
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : error}`);
  }
}

function cargoPackageField(block, field) {
  const expression = new RegExp(`^${field} = "([^"\\r\\n]+)"\\r?$`, "m");
  return expression.exec(block)?.[1] ?? null;
}

export function resolvedAdblockVersion(cargoLock) {
  const packages = cargoLock
    .split(/^\[\[package\]\]\s*$/m)
    .slice(1)
    .map((block) => ({
      name: cargoPackageField(block, "name"),
      version: cargoPackageField(block, "version"),
      source: cargoPackageField(block, "source")
    }))
    .filter((entry) => entry.name === "adblock");

  if (packages.length !== 1) {
    throw new Error(`Cargo.lock must contain exactly one resolved adblock package; found ${packages.length}.`);
  }
  const [resolved] = packages;
  if (!resolved.source || !CRATES_IO_SOURCES.has(resolved.source)) {
    throw new Error(`Cargo.lock adblock must resolve from crates.io; found ${resolved.source ?? "no source"}.`);
  }
  return requiredString(resolved.version, "Cargo.lock adblock version");
}

function exactLockedDependency(packageLock, name) {
  const declared = packageLock?.packages?.[""]?.dependencies?.[name];
  const resolved = packageLock?.packages?.[`node_modules/${name}`]?.version;
  const version = requiredString(resolved, `package-lock.json resolved ${name} version`);
  if (declared !== version) {
    throw new Error(
      `package-lock.json must declare ${name} as the exact resolved version ${version}; found ${JSON.stringify(declared)}.`
    );
  }
  return version;
}

function chromiumDescriptor(payload, label) {
  const entries = Array.isArray(payload?.browsers)
    ? payload.browsers.filter((entry) => entry?.name === "chromium")
    : [];
  if (entries.length !== 1) {
    throw new Error(`${label} must contain exactly one chromium entry; found ${entries.length}.`);
  }
  const [entry] = entries;
  if (entry.installByDefault !== true) {
    throw new Error(`${label} chromium must be installed by default.`);
  }
  return {
    version: requiredString(entry.browserVersion, `${label} Chromium version`, CHROME_VERSION_PATTERN),
    revision: requiredString(entry.revision, `${label} Chromium revision`, REVISION_PATTERN)
  };
}

async function localPins() {
  const [cargoLock, packageSource, packageLockSource, corePackageSource, installedBrowsersSource, seccompProfileSource] =
    await Promise.all([
      readFile(path.join(ROOT, "tools", "adblock-wasm", "Cargo.lock"), "utf8"),
      readFile(path.join(ROOT, "package.json"), "utf8"),
      readFile(path.join(ROOT, "package-lock.json"), "utf8"),
      readFile(path.join(ROOT, "node_modules", "playwright-core", "package.json"), "utf8"),
      readFile(path.join(ROOT, "node_modules", "playwright-core", "browsers.json"), "utf8"),
      readFile(path.join(ROOT, "scripts", "playwright-seccomp-profile.json"), "utf8")
    ]);

  const packageJson = parseJson(packageSource, "package.json");
  const packageLock = parseJson(packageLockSource, "package-lock.json");
  const corePackage = parseJson(corePackageSource, "installed playwright-core/package.json");
  const installedBrowsers = parseJson(installedBrowsersSource, "installed playwright-core/browsers.json");
  const playwright = exactLockedDependency(packageLock, "playwright");
  const tldts = exactLockedDependency(packageLock, "tldts");

  for (const [name, version] of [
    ["playwright", playwright],
    ["tldts", tldts]
  ]) {
    if (packageJson?.dependencies?.[name] !== version) {
      throw new Error(
        `package.json and package-lock.json must pin ${name} identically; found ` +
          `${JSON.stringify(packageJson?.dependencies?.[name])} and ${JSON.stringify(version)}.`
      );
    }
  }

  const playwrightCore = requiredString(
    packageLock?.packages?.["node_modules/playwright-core"]?.version,
    "package-lock.json resolved playwright-core version"
  );
  const playwrightCoreRequirement = packageLock?.packages?.["node_modules/playwright"]?.dependencies?.["playwright-core"];
  if (playwrightCore !== playwright || playwrightCoreRequirement !== playwrightCore) {
    throw new Error(
      `package-lock.json Playwright packages must resolve to one exact version; playwright=${playwright}, ` +
        `playwright-core=${playwrightCore}, requirement=${JSON.stringify(playwrightCoreRequirement)}.`
    );
  }
  if (corePackage.version !== playwrightCore) {
    throw new Error(
      `Installed playwright-core ${JSON.stringify(corePackage.version)} does not match package-lock.json ${playwrightCore}. ` +
        "Run npm ci before checking drift."
    );
  }

  return {
    adblock: resolvedAdblockVersion(cargoLock),
    playwright,
    chromium: chromiumDescriptor(installedBrowsers, "installed playwright-core/browsers.json"),
    seccompProfile: parseJson(seccompProfileSource, "scripts/playwright-seccomp-profile.json"),
    tldts
  };
}

async function fetchJson(label, url) {
  let lastError;
  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt += 1) {
    try {
      return await withHttpOperationDeadline(
        { timeoutMs: FETCH_TIMEOUT_MS, label },
        async (signal) => {
          const response = await fetch(url, {
            headers: { accept: "application/json", "user-agent": USER_AGENT },
            redirect: "error",
            signal
          });
          if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
          return readResponseJsonWithinLimit(response, {
            maxBytes: FETCH_RESPONSE_MAX_BYTES,
            label
          });
        }
      );
    } catch (error) {
      lastError = error;
      if (attempt < FETCH_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
    }
  }
  throw new Error(`${label} lookup failed after ${FETCH_ATTEMPTS} attempts: ${lastError instanceof Error ? lastError.message : lastError}`);
}

async function upstreamVersions(pinnedPlaywright) {
  const [adblockPayload, playwrightPayload, tldtsPayload, taggedBrowsersPayload, taggedSeccompProfile, chromePayload] =
    await Promise.all([
      fetchJson("crates.io adblock", CRATES_IO_ADBLOCK_URL),
      fetchJson("npm playwright", NPM_PLAYWRIGHT_URL),
      fetchJson("npm tldts", NPM_TLDTS_URL),
      fetchJson(`Playwright v${pinnedPlaywright} browsers.json`, PLAYWRIGHT_TAG_BROWSERS_URL(pinnedPlaywright)),
      fetchJson(
        `Playwright v${pinnedPlaywright} seccomp profile`,
        PLAYWRIGHT_TAG_SECCOMP_URL(pinnedPlaywright)
      ),
      fetchJson("Chrome VersionHistory stable", CHROME_STABLE_URL)
    ]);

  if (!Array.isArray(chromePayload?.versions) || chromePayload.versions.length !== 1) {
    throw new Error("Chrome VersionHistory must return exactly one Linux stable version.");
  }
  return {
    adblock: requiredString(adblockPayload?.crate?.max_stable_version, "crates.io adblock stable version"),
    playwright: requiredString(playwrightPayload?.version, "npm playwright latest version"),
    taggedChromium: chromiumDescriptor(taggedBrowsersPayload, `Playwright v${pinnedPlaywright} browsers.json`),
    taggedSeccompProfile,
    chromeStable: requiredString(
      chromePayload.versions[0]?.version,
      "Chrome VersionHistory Linux stable version",
      CHROME_VERSION_PATTERN
    ),
    tldts: requiredString(tldtsPayload?.version, "npm tldts latest version")
  };
}

function major(version) {
  return Number.parseInt(version.split(".", 1)[0], 10);
}

export function driftRows(pinned, upstream) {
  return [
    {
      component: "adblock-rust",
      pinned: pinned.adblock,
      upstream: upstream.adblock,
      drift: pinned.adblock !== upstream.adblock,
      actionable: pinned.adblock !== upstream.adblock,
      action: "Rebuild tools/adblock-wasm, re-vendor the WASM output, and update the disclosed engine version."
    },
    {
      component: "Playwright",
      pinned: pinned.playwright,
      upstream: upstream.playwright,
      drift: pinned.playwright !== upstream.playwright,
      actionable: pinned.playwright !== upstream.playwright,
      action: "Update the exact npm pin, lockfile, reviewed container base, and version-tagged seccomp profile together."
    },
    {
      component: "Bundled Chromium / Chrome Stable (Linux)",
      pinned: pinned.chromium.version,
      upstream: upstream.chromeStable,
      drift: major(pinned.chromium.version) !== major(upstream.chromeStable),
      // Chrome Stable often moves before a stable Playwright release bundles
      // the same major. Keep that lag visible without proposing an unpinned
      // system browser or opening an issue that cannot yet be resolved.
      actionable: false,
      action: "Upgrade through a stable Playwright release; do not substitute an unpinned system Chrome binary."
    },
    {
      component: "tldts",
      pinned: pinned.tldts,
      upstream: upstream.tldts,
      drift: pinned.tldts !== upstream.tldts,
      actionable: pinned.tldts !== upstream.tldts,
      action: "Update the exact npm pin, lockfile, and public-suffix provenance disclosure together."
    }
  ];
}

export function assertPinnedSeccompProfile(playwrightVersion, localProfile, taggedProfile) {
  if (!isDeepStrictEqual(localProfile, taggedProfile)) {
    throw new Error(
      `scripts/playwright-seccomp-profile.json does not match Playwright v${playwrightVersion} ` +
        "utils/docker/seccomp_profile.json. Update and review the profile with the Playwright pin."
    );
  }
}

export function markdownReport(rows, checkedAt) {
  const drifted = rows.filter((row) => row.drift);
  const actionable = rows.filter((row) => row.actionable);
  const table = rows
    .map(
      (row) =>
        `| ${row.component} | \`${row.pinned}\` | \`${row.upstream}\` | ${
          !row.drift ? "current" : row.actionable ? "upgrade available" : "waiting on stable Playwright"
        } |`
    )
    .join("\n");
  const actions =
    actionable.length > 0
      ? actionable.map((row) => `- **${row.component}:** ${row.action}`).join("\n")
      : drifted.length === 0
      ? "All monitored measurement-toolchain pins match their upstream stable references."
      : "All monitored pins match the latest versions available through their supported upgrade paths. The bundled Chromium release may trail Chrome Stable until a newer stable Playwright release is available.";

  return `<!-- site-behavior-lab:measurement-toolchain-drift -->
# Measurement toolchain drift

Generated by the weekly \`Update Brave Shields Lists\` workflow at ${checkedAt}.

| Component | Resolved or bundled here | Upstream stable reference | Status |
| --- | --- | --- | --- |
${table}

${actions}

The adblock version comes from the exact resolved package in \`tools/adblock-wasm/Cargo.lock\`. npm pins must match exactly across \`package.json\`, \`package-lock.json\`, and the resolved lockfile packages. The bundled browser comes from the integrity-checked Playwright package and must match \`playwright-core/browsers.json\` at the exact pinned Playwright Git tag. The Docker seccomp profile must likewise match \`utils/docker/seccomp_profile.json\` at that tag. Chrome Stable is the Linux consumer stable channel from Google's VersionHistory API and is compared by major version only.

Only rows marked \`upgrade available\` open or reopen the maintenance issue. Browser-channel lag remains visible here, but is informational until a newer stable Playwright release provides the supported upgrade path.

This issue is a maintenance signal, not authorization to update automatically. Measurement-version changes require the repository's provenance, comparability, and validation gates.
`;
}

async function publishOutputs(report, reportPath, hasDrift, driftCount) {
  if (reportPath) {
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, report, "utf8");
  } else {
    process.stdout.write(`${report}\n`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${report}\n`, "utf8");
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(
      process.env.GITHUB_OUTPUT,
      `drift=${hasDrift ? "true" : "false"}\ndrift_count=${driftCount}\n`,
      "utf8"
    );
  }
}

async function main() {
  const { reportPath } = parseArguments(process.argv.slice(2));
  const pinned = await localPins();
  const upstream = await upstreamVersions(pinned.playwright);
  if (
    pinned.chromium.version !== upstream.taggedChromium.version ||
    pinned.chromium.revision !== upstream.taggedChromium.revision
  ) {
    throw new Error(
      `The installed Playwright ${pinned.playwright} Chromium mapping ` +
        `${pinned.chromium.version} (revision ${pinned.chromium.revision}) does not match its Git tag mapping ` +
        `${upstream.taggedChromium.version} (revision ${upstream.taggedChromium.revision}).`
    );
  }
  assertPinnedSeccompProfile(pinned.playwright, pinned.seccompProfile, upstream.taggedSeccompProfile);
  const rows = driftRows(pinned, upstream);
  const driftCount = rows.filter((row) => row.actionable).length;
  const informationalCount = rows.filter((row) => row.drift && !row.actionable).length;
  const report = markdownReport(rows, new Date().toISOString());
  await publishOutputs(report, reportPath, driftCount > 0, driftCount);
  console.log(
    driftCount > 0
      ? `Actionable measurement toolchain drift detected in ${driftCount} component(s).`
      : informationalCount > 0
        ? `No actionable measurement toolchain drift; ${informationalCount} informational ${
            informationalCount === 1 ? "difference remains" : "differences remain"
          } visible.`
        : "Measurement toolchain pins match upstream stable references."
  );
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
