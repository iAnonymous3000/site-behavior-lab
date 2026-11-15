#!/usr/bin/env node

import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Hex } from "./brave-list-digests.mjs";
import {
  GITHUB_CLI_BUILD_TOOL_MANIFEST_PATH,
  parseGithubCliBuildToolManifest
} from "./github-cli-build-tool-lib.mjs";

const SCRIPT_PATH = "scripts/third-party-inventory.mjs";
const DEFAULT_OUTPUT = "THIRD_PARTY_INVENTORY.json";
const INPUT_PATHS = Object.freeze({
  packageLock: "package-lock.json",
  cargoLock: "tools/adblock-wasm/Cargo.lock",
  cargoManifest: "tools/adblock-wasm/Cargo.toml",
  filterMetadata: "lib/adblock-wasm/brave-default-filters.meta.json",
  githubCliBuildTool: GITHUB_CLI_BUILD_TOOL_MANIFEST_PATH,
  // The investigation runner's own lockfile (the recorder release the owner confirmed) and the second
  // Node it installs. The runner image is built by hand and is not the scanner's; its packages and its
  // Node are inventoried apart from the scanner's, under runnerNpm and runnerTools.
  runnerPackageLock: "investigation/runner/s4/package-lock-6.8.0.json",
  runnerNodeRuntime: "investigation/runner/s4/node-runtime.json",
  // The site's own typefaces: the files public/fonts serves and the share card's static instances in
  // lib/og-fonts, each named with the upstream file it was made from (scripts/build-design-fonts.mjs).
  designFonts: "scripts/design-fonts-provenance.json"
});
/** Where font files live; every font file under these must be named by the design-fonts manifest. */
const DESIGN_FONT_DIRECTORIES = ["public/fonts", "lib/og-fonts"];
const DESIGN_FONT_FILE_PATTERN = /\.(?:woff2?|ttf|otf)$/;
const DESIGN_FONT_USAGES = new Set(["served", "share-card-build-and-container"]);
/** The text an OFL 1.1 license file carries; the declared identifier is accepted only beside it. */
const OFL_11_HEADING = "SIL OPEN FONT LICENSE Version 1.1";
/**
 * The runner lockfile's optional entries that the runner image does install: the terminal module's
 * Linux prebuilds, one per architecture, which the owner approved by name. Every other optional
 * entry (frida, the darwin and win32 prebuilds) was never downloaded and is not installed.
 */
const RUNNER_INSTALLED_OPTIONAL = new Set(["@lydell/node-pty-linux-arm64", "@lydell/node-pty-linux-x64"]);
/** What the two runner sections describe, stated in the file itself. */
const RUNNER_SCOPE =
  "The private investigation runner image only (investigation/runner/s4), built by hand and pushed nowhere. " +
  "Nothing in these runner sections is shipped by the public site or the public scanner.";
const UNKNOWN_LICENSE = "UNKNOWN";
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const GIT_COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const LEGAL_NOTICE =
  "This generated file is an evidence inventory, not legal advice or a complete set of license texts. " +
  "Declared license identifiers are copied from the checked local inputs and have not been legally " +
  "verified. UNKNOWN means those inputs do not prove a license. No human legal review of these items " +
  "has been performed, and this file does not show that any notice or source-offer obligation has been met.";

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

function buildNpmInventory(packageLockSource, inputPath = INPUT_PATHS.packageLock) {
  const lock = requireObject(parseJson(packageLockSource, inputPath), inputPath);
  if (lock.lockfileVersion !== 3) {
    throw new Error(`${inputPath} must use lockfileVersion 3`);
  }
  const packages = requireObject(lock.packages, `${inputPath}.packages`);
  const inventory = [];

  for (const [lockPath, rawPackage] of Object.entries(packages)) {
    if (lockPath === "") continue;
    const packageRecord = requireObject(rawPackage, `${inputPath}.packages[${JSON.stringify(lockPath)}]`);
    const name = packageNameFromLockPath(lockPath);
    const version = requireString(packageRecord.version, `${lockPath}.version`);
    const declaredLicense = optionalString(packageRecord.license, `${lockPath}.license`);

    inventory.push({
      name,
      version,
      lockPath,
      license: declaredLicense ?? UNKNOWN_LICENSE,
      licenseStatus: declaredLicense === null ? "unknown-not-recorded-in-package-lock" : "declared-in-package-lock",
      licenseEvidence: declaredLicense === null ? null : inputPath,
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

/**
 * The runner's packages: the same entries as the scanner's lock gives, each marked by whether the runner
 * image installs it. A license declared in the deprecated "or later" form ("LGPL-3.0+") is copied as
 * declared and its meaning stated beside it, never rewritten.
 */
function buildRunnerNpmInventory(packageLockSource) {
  return buildNpmInventory(packageLockSource, INPUT_PATHS.runnerPackageLock).map((entry) => ({
    ...entry,
    runnerInstall: !entry.optional ? "required" : RUNNER_INSTALLED_OPTIONAL.has(entry.name) ? "linux-prebuild" : "optional-not-installed",
    licenseMeaning: entry.license.endsWith("+") ? `${entry.license.slice(0, -1)} or later` : null
  }));
}

const FINGERPRINT_PATTERN = /^[0-9A-F]{40}$/;
const RUNNER_NODE_PLATFORMS = ["linux-arm64", "linux-x64"];

/** The runner's second Node, read strictly: its checksum file, that file's signature and signer, and each archive's pins. */
function parseRunnerNodeRuntime(source) {
  const label = INPUT_PATHS.runnerNodeRuntime;
  const manifest = requireObject(parseJson(source, label), label);
  const keys = ["schemaVersion", "artifactKind", "id", "name", "version", "sourceUrl", "checksumManifest", "license", "licenseStatus", "licenseEvidence", "usage", "runtime", "redistributed", "assets"];
  if (Object.keys(manifest).join() !== keys.join()) throw new Error(`${label} must hold exactly ${keys.join(", ")}, in that order`);
  if (manifest.schemaVersion !== 1 || manifest.artifactKind !== "investigation-runner-node-runtime-manifest") throw new Error(`${label} has an unknown schema`);
  for (const key of ["id", "name", "version", "license", "licenseStatus", "licenseEvidence", "usage"]) requireString(manifest[key], `${label}.${key}`);
  requireHttpsUrl(manifest.sourceUrl, `${label}.sourceUrl`);
  if (manifest.runtime !== true || typeof manifest.redistributed !== "boolean") throw new Error(`${label}.runtime must be true and redistributed a boolean`);
  const checksum = requireObject(manifest.checksumManifest, `${label}.checksumManifest`);
  requireHttpsUrl(checksum.url, `${label}.checksumManifest.url`);
  if (!SHA256_PATTERN.test(checksum.sha256)) throw new Error(`${label}.checksumManifest.sha256 must be a sha256`);
  const signature = requireObject(checksum.signature, `${label}.checksumManifest.signature`);
  requireHttpsUrl(signature.url, `${label}.checksumManifest.signature.url`);
  if (!FINGERPRINT_PATTERN.test(signature.signerFingerprint)) throw new Error(`${label}: the signer must be a 40-character key fingerprint`);
  const keyring = requireObject(signature.keyring, `${label}.checksumManifest.signature.keyring`);
  requireHttpsUrl(keyring.url, `${label}.checksumManifest.signature.keyring.url`);
  if (!GIT_COMMIT_PATTERN.test(keyring.gitBlob)) throw new Error(`${label}: the keyring must be pinned by its git blob`);
  if (!Array.isArray(manifest.assets) || manifest.assets.map((asset) => asset?.platform).join() !== RUNNER_NODE_PLATFORMS.join()) {
    throw new Error(`${label}.assets must be ${RUNNER_NODE_PLATFORMS.join(" and ")}, in that order`);
  }
  for (const [index, asset] of manifest.assets.entries()) {
    const at = `${label}.assets[${index}]`;
    for (const key of ["archive", "directory", "format"]) requireString(asset[key], `${at}.${key}`);
    requireHttpsUrl(asset.url, `${at}.url`);
    if (!asset.url.startsWith(manifest.sourceUrl) || !asset.url.endsWith(`/${asset.archive}`)) throw new Error(`${at}.url must be the archive under sourceUrl`);
    if (!SHA256_PATTERN.test(asset.archiveSha256) || !SHA256_PATTERN.test(asset.binarySha256)) throw new Error(`${at} must pin the archive and its binary by sha256`);
  }
  const tool = structuredClone(manifest);
  delete tool.schemaVersion;
  delete tool.artifactKind;
  return tool;
}

/**
 * The site's typefaces, read strictly. The manifest names each file's family, its upstream file, that
 * file's version and SHA-256, and the license file committed beside it; the bytes and digest of each
 * font file and license file are measured here from the repository, never copied from the manifest.
 * Every font file under the font directories must be named, and every named file must exist.
 */
function buildDesignFontInventory(source, fileBytes, listedFontPaths) {
  const label = INPUT_PATHS.designFonts;
  const manifest = requireObject(parseJson(source, label), label);
  const keys = ["schemaVersion", "artifactKind", "builtBy", "subsetter", "families", "files"];
  if (Object.keys(manifest).join() !== keys.join()) throw new Error(`${label} must hold exactly ${keys.join(", ")}, in that order`);
  if (manifest.schemaVersion !== 1 || manifest.artifactKind !== "design-fonts-provenance") throw new Error(`${label} has an unknown schema`);
  requireString(manifest.builtBy, `${label}.builtBy`);
  requireString(manifest.subsetter, `${label}.subsetter`);
  if (!Array.isArray(manifest.families) || !Array.isArray(manifest.files)) throw new Error(`${label}.families and .files must be arrays`);
  const families = new Map();
  for (const [index, raw] of manifest.families.entries()) {
    const at = `${label}.families[${index}]`;
    const family = requireObject(raw, at);
    for (const key of ["id", "name", "license"]) requireString(family[key], `${at}.${key}`);
    requireHttpsUrl(family.sourceUrl, `${at}.sourceUrl`);
    if (families.has(family.id)) throw new Error(`${at}.id ${family.id} is named twice`);
    families.set(family.id, family);
  }
  const digest = (bytes) => sha256Hex(bytes);
  const files = manifest.files.map((raw, index) => {
    const at = `${label}.files[${index}]`;
    const file = requireObject(raw, at);
    for (const key of ["path", "family", "usage", "sourceFile", "sourceVersion", "licenseFile"]) requireString(file[key], `${at}.${key}`);
    const family = families.get(file.family);
    if (!family) throw new Error(`${at}.family ${file.family} is not a declared family`);
    if (!DESIGN_FONT_USAGES.has(file.usage)) throw new Error(`${at}.usage must be one of ${[...DESIGN_FONT_USAGES].join(", ")}`);
    if (file.weight !== null && !Number.isSafeInteger(file.weight)) throw new Error(`${at}.weight must be null or an integer`);
    const fontBytes = fileBytes[file.path];
    if (!fontBytes) throw new Error(`${at}.path ${file.path} does not exist`);
    const licenseBytes = fileBytes[file.licenseFile];
    if (!licenseBytes) throw new Error(`${at}.licenseFile ${file.licenseFile} does not exist`);
    const declaredOfl = family.license === "OFL-1.1" && licenseBytes.toString("utf8").includes(OFL_11_HEADING);
    return {
      path: file.path,
      bytes: fontBytes.length,
      sha256: digest(fontBytes),
      family: family.id,
      name: family.name,
      usage: file.usage,
      served: file.usage === "served",
      redistributed: true,
      weight: file.weight,
      sourceUrl: family.sourceUrl,
      sourceFile: file.sourceFile,
      sourceVersion: file.sourceVersion,
      sourceSha256: validateDigest(file.sourceSha256, `${at}.sourceSha256`),
      license: declaredOfl ? family.license : UNKNOWN_LICENSE,
      licenseStatus: declaredOfl ? "declared-in-committed-license-file" : "unknown-license-file-does-not-state-the-declared-license",
      licenseEvidence: { path: file.licenseFile, sha256: digest(licenseBytes) }
    };
  });
  const named = files.map((file) => file.path);
  if (new Set(named).size !== named.length) throw new Error(`${label} names a file twice`);
  const unnamed = listedFontPaths.filter((fontPath) => !named.includes(fontPath));
  if (unnamed.length > 0) throw new Error(`${label} does not name ${unnamed.join(", ")}`);
  return { builtBy: manifest.builtBy, subsetter: manifest.subsetter, files };
}

function buildDownloadedToolInventory(source) {
  const manifest = parseGithubCliBuildToolManifest(
    source,
    INPUT_PATHS.githubCliBuildTool
  );
  const tool = structuredClone(manifest);
  delete tool.schemaVersion;
  delete tool.artifactKind;
  return [tool];
}

export function buildThirdPartyInventory(inputSources) {
  const npm = buildNpmInventory(inputSources.packageLock);
  const cargo = buildCargoInventory(inputSources.cargoLock, inputSources.cargoManifest);
  const filterLists = buildFilterInventory(inputSources.filterMetadata);
  const downloadedTools = buildDownloadedToolInventory(inputSources.githubCliBuildTool);
  const runnerNpm = buildRunnerNpmInventory(inputSources.runnerPackageLock);
  const runnerTools = [parseRunnerNodeRuntime(inputSources.runnerNodeRuntime)];
  const designFonts = buildDesignFontInventory(
    inputSources.designFonts,
    inputSources.designFontFiles ?? {},
    inputSources.designFontPaths ?? []
  );
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
      filterLists: summarizeLicenseEvidence(filterLists.sources),
      downloadedTools: summarizeLicenseEvidence(downloadedTools),
      runnerNpm: {
        scope: RUNNER_SCOPE,
        ...summarizeLicenseEvidence(runnerNpm),
        installed: runnerNpm.filter((entry) => entry.runnerInstall !== "optional-not-installed").length
      },
      runnerTools: { scope: RUNNER_SCOPE, ...summarizeLicenseEvidence(runnerTools) },
      designFonts: {
        ...summarizeLicenseEvidence(designFonts.files),
        served: designFonts.files.filter((file) => file.served).length
      }
    },
    npm,
    cargo,
    filterLists,
    downloadedTools,
    runnerNpm,
    runnerTools,
    designFonts
  };
}

export function serializeThirdPartyInventory(inventory) {
  return `${JSON.stringify(inventory, null, 2)}\n`;
}

async function readInputs(rootDir) {
  const inputs = Object.fromEntries(
    await Promise.all(
      Object.entries(INPUT_PATHS).map(async ([name, inputPath]) => [
        name,
        await readFile(path.join(rootDir, inputPath), "utf8")
      ])
    )
  );
  // Every font file under the font directories, and the bytes of each file the manifest names.
  const designFontPaths = [];
  for (const directory of DESIGN_FONT_DIRECTORIES) {
    let entries = [];
    try {
      entries = await readdir(path.join(rootDir, directory), { recursive: true, withFileTypes: true });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !DESIGN_FONT_FILE_PATTERN.test(entry.name)) continue;
      designFontPaths.push(path.relative(rootDir, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"));
    }
  }
  designFontPaths.sort(compareStrings);
  const manifest = JSON.parse(inputs.designFonts);
  const named = Array.isArray(manifest?.files)
    ? [...new Set(manifest.files.flatMap((file) => [file?.path, file?.licenseFile]).filter((value) => typeof value === "string"))]
    : [];
  const designFontFiles = {};
  for (const relative of named) {
    if (relative.split("/").includes("..") || path.isAbsolute(relative)) throw new Error(`${INPUT_PATHS.designFonts} names a path outside the repository: ${relative}`);
    try {
      designFontFiles[relative] = await readFile(path.join(rootDir, relative));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return { ...inputs, designFontFiles, designFontPaths };
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
