#!/usr/bin/env node

// Resolve the exact GitHub CLI used for artifact-attestation verification.
// Never trust an executable's name or self-reported version: both a PATH
// candidate and the ignored local cache must match a hard-coded upstream
// extracted-binary SHA-256 before execution. If neither does, bootstrap only
// the checksum-pinned official release asset for this platform.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseGithubCliBuildToolManifest } from "./github-cli-build-tool-lib.mjs";
import {
  absolutePathGhCandidates,
  canonicalWorkingDirectory,
  ensureSafeCacheDirectory,
  extractGithubCliBinary,
  GITHUB_CLI_ARCHIVE_MAX_BYTES as MAX_ARCHIVE_BYTES,
  installCacheBinaryNoClobber,
  readBoundedResponseBody,
  readRegularFileNoFollow,
  refuseExistingCacheDestination
} from "./github-cli-verifier-lib.mjs";

const manifestUrl = new URL(
  "./github-cli-build-tool-manifest.json",
  import.meta.url
);
const stats = await lstat(manifestUrl);
if (!stats.isFile() || stats.isSymbolicLink()) {
  throw new Error("GitHub CLI build-tool manifest must be a regular file");
}
const buildTool = parseGithubCliBuildToolManifest(
  (await readRegularFileNoFollow(fileURLToPath(manifestUrl))).toString("utf8")
);
const GH_VERSION = buildTool.version;
const DOWNLOAD_TIMEOUT_MS = 60_000;
const ASSETS = Object.freeze(
  Object.fromEntries(
    buildTool.assets.map(({ platform, ...asset }) => [
      platform,
      Object.freeze(asset)
    ])
  )
);

if (process.argv.length !== 2) {
  throw new Error("ensure-gh-attestation-verifier accepts no arguments");
}

const platformKey = `${process.platform}-${process.arch}`;
const asset = ASSETS[platformKey];
if (!asset) {
  throw new Error(
    `GitHub CLI ${GH_VERSION} attestation verification is unsupported on ${platformKey}`
  );
}

const rootDir = await canonicalWorkingDirectory(process.cwd());

const systemGh = await pinnedPathGh(asset.binarySha256);
if (systemGh) {
  process.stdout.write(systemGh);
  process.exit(0);
}
const cacheDir = await ensureSafeCacheDirectory(rootDir, [
  ".site-behavior-lab",
  "tools",
  `gh-${GH_VERSION}-${platformKey}`
]);
const cachedGh = path.join(cacheDir, "gh");
if (await verifiedGh(cachedGh, asset.binarySha256, true)) {
  process.stdout.write(cachedGh);
  process.exit(0);
}
await refuseExistingCacheDestination(cachedGh);
if (
  process.env.SITE_BEHAVIOR_LAB_GH_BOOTSTRAP_OFFLINE?.trim() === "1"
) {
  throw new Error(
    `No byte-pinned GitHub CLI ${GH_VERSION} verifier is available offline`
  );
}

const response = await fetch(asset.url, {
  redirect: "follow",
  signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
});
if (!response.ok) {
  throw new Error(
    `GitHub CLI bootstrap download failed with HTTP ${response.status}`
  );
}
const archive = await readBoundedResponseBody(
  response,
  MAX_ARCHIVE_BYTES
);
const archiveDigest = createHash("sha256").update(archive).digest("hex");
if (archiveDigest !== asset.archiveSha256) {
  throw new Error("GitHub CLI bootstrap archive SHA-256 does not match the pin");
}
const binary = extractGithubCliBinary(archive, asset);
const binaryDigest = createHash("sha256").update(binary).digest("hex");
if (binaryDigest !== asset.binarySha256) {
  throw new Error(
    "GitHub CLI extracted binary does not match the pinned upstream bytes"
  );
}
const installedGh = await installCacheBinaryNoClobber({
  destination: cachedGh,
  binary,
  expectedSha256: asset.binarySha256,
  verifyExecutable: (candidate) =>
    verifiedGh(candidate, asset.binarySha256, true)
});
process.stdout.write(installedGh);

async function pinnedPathGh(expectedSha256) {
  for (const candidate of absolutePathGhCandidates(
    process.env.PATH,
    rootDir
  )) {
    if (await verifiedGh(candidate, expectedSha256)) return candidate;
  }
  return null;
}

async function verifiedGh(command, expectedSha256, requireOwnedCacheMode = false) {
  if (!path.isAbsolute(command)) return false;
  let bytes;
  try {
    if (requireOwnedCacheMode) {
      const candidateStats = await lstat(command);
      if (
        (typeof process.getuid === "function" &&
          candidateStats.uid !== process.getuid()) ||
        (candidateStats.mode & 0o022) !== 0
      ) {
        return false;
      }
    }
    bytes = await readRegularFileNoFollow(command);
  } catch {
    return false;
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== expectedSha256) return false;
  const result = spawnSync(command, ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  });
  return (
    result.status === 0 &&
    result.stdout.startsWith(`gh version ${GH_VERSION} (`)
  );
}
