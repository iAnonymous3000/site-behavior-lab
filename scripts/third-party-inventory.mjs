#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = "scripts/third-party-inventory.mjs";
const DEFAULT_OUTPUT = "THIRD_PARTY_INVENTORY.json";
const INPUT_PATHS = Object.freeze({
  packageLock: "package-lock.json",
  cargoLock: "tools/adblock-wasm/Cargo.lock",
  cargoManifest: "tools/adblock-wasm/Cargo.toml",
  filterMetadata: "lib/adblock-wasm/brave-default-filters.meta.json"
});
const UNKNOWN_LICENSE = "UNKNOWN";
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const GIT_COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const LEGAL_NOTICE =
  "This generated file is an evidence inventory, not legal advice or a complete set of license texts. " +
  "Declared license identifiers are copied from the checked local inputs and have not been legally " +
  "verified. UNKNOWN means those inputs do not prove a license. Legal review and any required notice " +
  "or source-offer work remain external release gates.";

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseJson(source, inputPath) {
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(`${inputPath} is not valid JSON: ${error.message}`);
  }
}

function requireObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function requireString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function optionalString(value, label) {
  if (value === undefined) return null;
  return requireString(value, label);
}

function compareStrings(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function requireHttpsUrl(value, label) {
  const rawUrl = requireString(value, label);
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (error) {
    throw new Error(`${label} is not a valid URL: ${error.message}`);
  }
  if (parsed.protocol !== "https:") throw new Error(`${label} must use HTTPS`);
  if (parsed.username || parsed.password) throw new Error(`${label} must not contain credentials`);
  return rawUrl;
}

function packageNameFromLockPath(lockPath) {
  const marker = "node_modules/";
  const index = lockPath.lastIndexOf(marker);
  if (index < 0) {
    throw new Error(`Cannot derive an npm package name from package-lock path ${JSON.stringify(lockPath)}`);
  }
  const name = lockPath.slice(index + marker.length);
  if (!name || name === "." || name.includes("/node_modules/")) {
    throw new Error(`Invalid npm package-lock path ${JSON.stringify(lockPath)}`);
  }
  return name;
}

function buildNpmInventory(packageLockSource) {
  const lock = requireObject(parseJson(packageLockSource, INPUT_PATHS.packageLock), INPUT_PATHS.packageLock);
  if (lock.lockfileVersion !== 3) {
    throw new Error(`${INPUT_PATHS.packageLock} must use lockfileVersion 3`);
  }
  const packages = requireObject(lock.packages, `${INPUT_PATHS.packageLock}.packages`);
  const inventory = [];

  for (const [lockPath, rawPackage] of Object.entries(packages)) {
    if (lockPath === "") continue;
    const packageRecord = requireObject(rawPackage, `${INPUT_PATHS.packageLock}.packages[${JSON.stringify(lockPath)}]`);
    const name = packageNameFromLockPath(lockPath);
    const version = requireString(packageRecord.version, `${lockPath}.version`);
    const declaredLicense = optionalString(packageRecord.license, `${lockPath}.license`);

    inventory.push({
      name,
      version,
      lockPath,
      license: declaredLicense ?? UNKNOWN_LICENSE,
      licenseStatus: declaredLicense === null ? "unknown-not-recorded-in-package-lock" : "declared-in-package-lock",
      licenseEvidence: declaredLicense === null ? null : INPUT_PATHS.packageLock,
      resolved: optionalString(packageRecord.resolved, `${lockPath}.resolved`),
      integrity: optionalString(packageRecord.integrity, `${lockPath}.integrity`),
      developmentOnly: packageRecord.dev === true,
      optional: packageRecord.optional === true
    });
  }

  inventory.sort((left, right) =>
    compareStrings(left.name, right.name) ||
    compareStrings(left.version, right.version) ||
    compareStrings(left.lockPath, right.lockPath)
  );
  return inventory;
}

function tomlBasicString(rawValue, label) {
  const value = rawValue.trim();
  if (!value.startsWith('"') || !value.endsWith('"')) {
    throw new Error(`${label} must be a TOML basic string`);
  }
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`${label} is not a supported TOML basic string: ${error.message}`);
  }
}

function tomlField(section, key, label, { required = false } = {}) {
  const match = section.match(new RegExp(`^${key}\\s*=\\s*(.+?)\\s*$`, "m"));
  if (!match) {
    if (required) throw new Error(`${label}.${key} is required`);
    return null;
  }
  return tomlBasicString(match[1], `${label}.${key}`);
}

function cargoManifestPackage(cargoManifestSource) {
  const packageHeader = /^\[package\]\s*$/m.exec(cargoManifestSource);
  if (!packageHeader) {
    throw new Error(`${INPUT_PATHS.cargoManifest} does not contain a [package] section`);
  }
  const afterHeader = cargoManifestSource.slice(packageHeader.index + packageHeader[0].length);
  const nextSection = afterHeader.search(/^\[/m);
  const packageSection = nextSection < 0 ? afterHeader : afterHeader.slice(0, nextSection);
  return {
    name: tomlField(packageSection, "name", `${INPUT_PATHS.cargoManifest} [package]`, { required: true }),
    version: tomlField(packageSection, "version", `${INPUT_PATHS.cargoManifest} [package]`, { required: true }),
    license: tomlField(packageSection, "license", `${INPUT_PATHS.cargoManifest} [package]`)
  };
}

function parseCargoPackages(cargoLockSource) {
  const blocks = cargoLockSource.split(/^\[\[package\]\]\s*$/m).slice(1);
  if (blocks.length === 0) {
    throw new Error(`${INPUT_PATHS.cargoLock} does not contain any [[package]] entries`);
  }
  return blocks.map((block, index) => {
    const label = `${INPUT_PATHS.cargoLock} [[package]] #${index + 1}`;
    return {
      name: tomlField(block, "name", label, { required: true }),
      version: tomlField(block, "version", label, { required: true }),
      source: tomlField(block, "source", label),
      checksum: tomlField(block, "checksum", label)
    };
  });
}

function buildCargoInventory(cargoLockSource, cargoManifestSource) {
  const workspacePackage = cargoManifestPackage(cargoManifestSource);
  const packages = parseCargoPackages(cargoLockSource).map((packageRecord) => {
    const isWorkspace =
      packageRecord.source === null &&
      packageRecord.name === workspacePackage.name &&
      packageRecord.version === workspacePackage.version;
    const declaredLicense = isWorkspace ? workspacePackage.license : null;

    if (packageRecord.source?.startsWith("registry+") && !packageRecord.checksum) {
      throw new Error(`Registry Cargo package ${packageRecord.name}@${packageRecord.version} has no checksum`);
    }
    if (packageRecord.checksum !== null && !SHA256_PATTERN.test(packageRecord.checksum)) {
      throw new Error(`Cargo package ${packageRecord.name}@${packageRecord.version} has an invalid checksum`);
    }

    return {
      name: packageRecord.name,
      version: packageRecord.version,
      kind: isWorkspace ? "workspace" : "third-party",
      source: packageRecord.source,
      checksum: packageRecord.checksum,
      license: declaredLicense ?? UNKNOWN_LICENSE,
      licenseStatus:
        declaredLicense === null
          ? "unknown-not-recorded-in-cargo-lock"
          : "declared-in-workspace-cargo-manifest",
      licenseEvidence: declaredLicense === null ? null : INPUT_PATHS.cargoManifest
    };
  });

  packages.sort((left, right) =>
    compareStrings(left.name, right.name) ||
    compareStrings(left.version, right.version) ||
    compareStrings(left.source ?? "", right.source ?? "")
  );
  return packages;
}

function validateDigest(value, label) {
  const digest = requireString(value, label);
  if (!SHA256_PATTERN.test(digest)) throw new Error(`${label} must be a lowercase SHA-256 digest`);
  return digest;
}

function buildFilterInventory(filterMetadataSource) {
  const metadata = requireObject(
    parseJson(filterMetadataSource, INPUT_PATHS.filterMetadata),
    INPUT_PATHS.filterMetadata
  );
  const catalog = requireHttpsUrl(metadata.catalog, `${INPUT_PATHS.filterMetadata}.catalog`);
  const catalogCommit = requireString(
    metadata.catalogCommit,
    `${INPUT_PATHS.filterMetadata}.catalogCommit`
  );
  if (!GIT_COMMIT_PATTERN.test(catalogCommit)) {
    throw new Error("Filter catalog commit must be a lowercase 40-character Git commit");
  }
  if (!catalog.includes(`/${catalogCommit}/`)) {
    throw new Error("Filter catalog URL must embed the declared catalog commit");
  }
  const catalogSha256 = validateDigest(
    metadata.catalogSha256,
    `${INPUT_PATHS.filterMetadata}.catalogSha256`
  );
  if (!Array.isArray(metadata.sources)) {
    throw new Error(`${INPUT_PATHS.filterMetadata}.sources must be an array`);
  }
  if (!Number.isSafeInteger(metadata.sourceCount) || metadata.sourceCount !== metadata.sources.length) {
    throw new Error(`${INPUT_PATHS.filterMetadata}.sourceCount must match sources.length`);
  }

  const sources = metadata.sources.map((rawSource, index) => {
    const source = requireObject(rawSource, `${INPUT_PATHS.filterMetadata}.sources[${index}]`);
    const url = requireHttpsUrl(source.url, `${INPUT_PATHS.filterMetadata}.sources[${index}].url`);
    if (!Number.isSafeInteger(source.bytes) || source.bytes < 0) {
      throw new Error(`Filter source #${index + 1} bytes must be a non-negative safe integer`);
    }
    return {
      sourceIndex: index,
      url,
      bytes: source.bytes,
      sha256: validateDigest(source.sha256, `${INPUT_PATHS.filterMetadata}.sources[${index}].sha256`),
      license: UNKNOWN_LICENSE,
      licenseStatus: "unknown-not-recorded-in-filter-metadata",
      licenseEvidence: null
    };
  });

  const manifestDigest = validateDigest(
    metadata.manifestDigest,
    `${INPUT_PATHS.filterMetadata}.manifestDigest`
  );
  const rulesDigest = validateDigest(metadata.rulesDigest, `${INPUT_PATHS.filterMetadata}.rulesDigest`);
  for (const [field, value] of [
    ["rawBytes", metadata.rawBytes],
    ["gzipBytes", metadata.gzipBytes]
  ]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${INPUT_PATHS.filterMetadata}.${field} must be a non-negative safe integer`);
    }
  }

  return {
    catalog: {
      url: catalog,
      commit: catalogCommit,
      sha256: catalogSha256
    },
    bundle: {
      sourceCount: sources.length,
      sourceManifestSha256: manifestDigest,
      rulesSha256: rulesDigest,
      rawBytes: metadata.rawBytes,
      gzipBytes: metadata.gzipBytes
    },
    sources
  };
}

function summarizeLicenseEvidence(entries) {
  return {
    total: entries.length,
    declared: entries.filter((entry) => entry.license !== UNKNOWN_LICENSE).length,
    unknown: entries.filter((entry) => entry.license === UNKNOWN_LICENSE).length
  };
}

export function buildThirdPartyInventory(inputSources) {
  const npm = buildNpmInventory(inputSources.packageLock);
  const cargo = buildCargoInventory(inputSources.cargoLock, inputSources.cargoManifest);
  const filterLists = buildFilterInventory(inputSources.filterMetadata);
  const cargoThirdParty = cargo.filter((entry) => entry.kind === "third-party");

  return {
    schemaVersion: 1,
    artifactKind: "deterministic-third-party-inventory-and-notice-evidence",
    generatedBy: SCRIPT_PATH,
    legalReviewRequired: true,
    notice: LEGAL_NOTICE,
    inputs: Object.fromEntries(
      Object.entries(INPUT_PATHS).map(([name, inputPath]) => [
        name,
        { path: inputPath, sha256: sha256Hex(inputSources[name]) }
      ])
    ),
    summary: {
      npm: summarizeLicenseEvidence(npm),
      cargo: {
        ...summarizeLicenseEvidence(cargoThirdParty),
        workspacePackages: cargo.length - cargoThirdParty.length
      },
      filterLists: summarizeLicenseEvidence(filterLists.sources)
    },
    npm,
    cargo,
    filterLists
  };
}

export function serializeThirdPartyInventory(inventory) {
  return `${JSON.stringify(inventory, null, 2)}\n`;
}

async function readInputs(rootDir) {
  return Object.fromEntries(
    await Promise.all(
      Object.entries(INPUT_PATHS).map(async ([name, inputPath]) => [
        name,
        await readFile(path.join(rootDir, inputPath), "utf8")
      ])
    )
  );
}

function parseArguments(argv) {
  let check = false;
  let rootDir = process.cwd();
  let outputPath = DEFAULT_OUTPUT;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--check") {
      check = true;
    } else if (argument === "--root") {
      const value = argv[index + 1];
      if (!value) throw new Error("--root requires a directory");
      rootDir = path.resolve(value);
      index += 1;
    } else if (argument === "--output") {
      const value = argv[index + 1];
      if (!value) throw new Error("--output requires a file path");
      outputPath = value;
      index += 1;
    } else {
      throw new Error(`Unknown argument ${JSON.stringify(argument)}`);
    }
  }

  return {
    check,
    rootDir: path.resolve(rootDir),
    outputPath: path.resolve(rootDir, outputPath)
  };
}

async function writeAtomically(outputPath, content) {
  await mkdir(path.dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.tmp-${process.pid}`;
  try {
    await writeFile(temporaryPath, content, { encoding: "utf8", mode: 0o644 });
    await rename(temporaryPath, outputPath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const inputs = await readInputs(options.rootDir);
  const content = serializeThirdPartyInventory(buildThirdPartyInventory(inputs));
  const relativeOutput = path.relative(options.rootDir, options.outputPath) || path.basename(options.outputPath);

  if (options.check) {
    let existing;
    try {
      existing = await readFile(options.outputPath, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") {
        throw new Error(`${relativeOutput} is missing; generate it with node ${SCRIPT_PATH}`);
      }
      throw error;
    }
    if (existing !== content) {
      throw new Error(`${relativeOutput} is stale; regenerate it with node ${SCRIPT_PATH}`);
    }
    process.stdout.write(`Third-party inventory verified: ${relativeOutput}\n`);
    return;
  }

  await writeAtomically(options.outputPath, content);
  process.stdout.write(`Third-party inventory generated: ${relativeOutput}\n`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`Third-party inventory failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
