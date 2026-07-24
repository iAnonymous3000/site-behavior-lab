#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { constants, realpathSync } from "node:fs";
import { lstat, open, readFile, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveExactStaticDeploymentCommit } from "./static-deployment-provenance.mjs";

const FULL_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_IMAGE = /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,255}$/;
const OCI_SOURCE = "org.opencontainers.image.source";
const OCI_REVISION = "org.opencontainers.image.revision";
const OCI_TITLE = "org.opencontainers.image.title";
const OCI_LICENSES = "org.opencontainers.image.licenses";
const REQUIRED_NODE = "24.14.1";
const REQUIRED_NPM = "11.11.0";
const REQUIRED_PACKAGE_MANAGER = `npm@${REQUIRED_NPM}`;
const REQUIRED_CONTAINER_NODE = "24.17.0";
const DOCKER_TIMEOUT_MS = 30_000;
const DOCKER_MAX_BUFFER_BYTES = 1024 * 1024;

/**
 * Build a deterministic receipt for the exact clean Git source and one or more
 * tested build artifacts. The receipt deliberately contains no clock, runner,
 * branch, or mutable URL: identical source and artifact bytes produce identical
 * JSON. A workflow conclusion and live deployment readback remain separate
 * evidence and must never be inferred from this file.
 */
export async function buildReleaseEvidence({
  cwd = process.cwd(),
  env = process.env,
  staticDir,
  containerImage,
  dockerBin = env.DOCKER_BIN?.trim() || "docker"
} = {}) {
  const root = realpathSync(path.resolve(cwd));
  const commit = resolveExactStaticDeploymentCommit({ cwd: root, env });
  const sourceTree = git(root, ["rev-parse", "--verify", "HEAD^{tree}"]).trim().toLowerCase();
  if (!FULL_SHA.test(sourceTree)) throw new Error("Release evidence requires an exact full Git source-tree identity");

  const release = await releaseMetadata(root);
  const releaseTags = git(root, ["tag", "--list", release.version, `v${release.version}`])
    .split(/\r?\n/)
    .filter(Boolean);
  if (releaseTags.length !== 0) {
    throw new Error(`Development release policy conflicts with existing tag ${releaseTags[0]}`);
  }
  const evidence = {
    schemaVersion: 1,
    evidenceKind: "exact-source-and-tested-artifact-manifest",
    release,
    source: {
      repository: release.repository,
      commit,
      tree: sourceTree,
      requiredNode: release.requiredNode,
      requiredNpm: release.requiredNpm
    },
    inputs: {
      packageLock: await fileEvidence(root, "package-lock.json"),
      dockerfile: await fileEvidence(root, "Dockerfile"),
      productionContainerConfig: await fileEvidence(root, "wrangler.container.jsonc"),
      releasePolicy: await fileEvidence(root, "release-policy.json")
    },
    artifacts: []
  };

  if (staticDir) evidence.artifacts.push(await staticArtifactEvidence(root, staticDir, commit));
  if (containerImage) {
    evidence.artifacts.push(containerArtifactEvidence(root, containerImage, commit, release, dockerBin));
  }
  if (evidence.artifacts.length === 0) {
    throw new Error("Release evidence requires --static-dir, --container-image, or both");
  }

  assertExactSourceStillClean(root, env, commit, sourceTree);

  return evidence;
}

async function releaseMetadata(root) {
  const packageManifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const packageLock = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
  const policy = JSON.parse(await readFile(path.join(root, "release-policy.json"), "utf8"));
  const citation = await readFile(path.join(root, "CITATION.cff"), "utf8");
  const changelog = await readFile(path.join(root, "CHANGELOG.md"), "utf8");

  if (policy?.schemaVersion !== 1) throw new Error("release-policy.json must use schemaVersion 1");
  if (policy?.status !== "development") {
    throw new Error("This evidence schema currently permits only the truthful development release state");
  }
  if (policy?.releaseTag !== null || policy?.stablePublicApi !== false || policy?.npmPublication !== "disabled") {
    throw new Error("Development release policy must keep tag, stable-API, and npm-publication claims disabled");
  }
  if (packageManifest?.private !== true) throw new Error("Development release policy requires package.json private=true");
  if (typeof packageManifest?.version !== "string" || packageManifest.version !== policy.version) {
    throw new Error("package.json and release-policy.json versions must match exactly");
  }
  if (!/^0\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(policy.version)) {
    throw new Error("Development release policy requires one pre-1.0 semantic version");
  }
  if (packageManifest?.engines?.node !== REQUIRED_NODE) {
    throw new Error(`Release evidence requires the repository Node engine to remain exactly ${REQUIRED_NODE}`);
  }
  if (packageManifest?.engines?.npm !== REQUIRED_NPM) {
    throw new Error(`Release evidence requires the repository npm engine to remain exactly ${REQUIRED_NPM}`);
  }
  if (packageManifest?.packageManager !== REQUIRED_PACKAGE_MANAGER) {
    throw new Error(`Release evidence requires packageManager=${REQUIRED_PACKAGE_MANAGER}`);
  }
  const lockRoot = packageLock?.packages?.[""];
  if (
    lockRoot?.engines?.node !== REQUIRED_NODE ||
    lockRoot?.engines?.npm !== REQUIRED_NPM ||
    lockRoot?.packageManager !== REQUIRED_PACKAGE_MANAGER
  ) {
    throw new Error("package-lock.json must mirror the exact Node/npm package contract");
  }
  if (process.versions.node !== REQUIRED_NODE) {
    throw new Error(
      `Release evidence must run under the declared Node ${REQUIRED_NODE} toolchain, not Node ${process.versions.node}`
    );
  }
  const runningNpm = execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
  if (runningNpm !== REQUIRED_NPM) {
    throw new Error(`Release evidence must run under npm ${REQUIRED_NPM}, not npm ${runningNpm}`);
  }
  if (packageLock?.version !== policy.version || packageLock?.packages?.[""]?.version !== policy.version) {
    throw new Error("package-lock.json root versions must match release-policy.json exactly");
  }
  const citationVersions = [...citation.matchAll(/^version:\s*["']?([^"'\s]+)["']?\s*$/gm)].map(
    (match) => match[1]
  );
  if (citationVersions.length !== 1 || citationVersions[0] !== policy.version) {
    throw new Error("CITATION.cff must declare exactly the release-policy.json version");
  }
  if (/^date-released:/m.test(citation)) {
    throw new Error("Development CITATION.cff must not claim a release date");
  }
  const unreleasedSections = [...changelog.matchAll(/^## Unreleased\s*$/gm)];
  if (unreleasedSections.length !== 1) {
    throw new Error("Development release policy requires one explicit Unreleased changelog section");
  }
  const escapedVersion = policy.version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`^## \\[?${escapedVersion}\\]?\\s+-`, "m").test(changelog)) {
    throw new Error("Development changelog must not claim a dated release for the current version");
  }

  const repository = normalizeRepository(packageManifest?.repository?.url);
  return {
    status: policy.status,
    version: policy.version,
    tag: null,
    stablePublicApi: false,
    npmPublication: "disabled",
    requiredNode: packageManifest.engines.node,
    requiredNpm: packageManifest.engines.npm,
    repository
  };
}

function normalizeRepository(value) {
  if (typeof value !== "string") throw new Error("package.json must declare a repository URL");
  const normalized = value.replace(/^git\+/, "").replace(/\.git$/, "");
  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error("package.json repository must be an absolute HTTPS URL");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname && parsed.pathname.endsWith("/"))
  ) {
    throw new Error("package.json repository must be a credential-free canonical HTTPS URL");
  }
  return parsed.href.replace(/\/$/, "");
}

async function staticArtifactEvidence(root, value, commit) {
  const { absolute, relative } = safeArtifactDirectory(root, value, "--static-dir");
  const deployment = JSON.parse(await readFile(path.join(absolute, "deployment.json"), "utf8"));
  if (
    Object.keys(deployment).sort().join(",") !== "deployment,schemaVersion" ||
    deployment.schemaVersion !== 1 ||
    deployment.deployment !== commit
  ) {
    throw new Error("Static artifact deployment.json must identify the exact clean source commit with schemaVersion 1");
  }

  const manifest = await directoryManifest(absolute);
  return {
    name: "static-pages",
    kind: "directory-manifest",
    path: relative,
    deployment,
    digestAlgorithm: "sha256",
    manifestSha256: sha256(JSON.stringify(manifest.files)),
    fileCount: manifest.files.length,
    bytes: manifest.bytes,
    files: manifest.files
  };
}

function containerArtifactEvidence(root, image, commit, release, dockerBin) {
  if (typeof image !== "string" || !SAFE_IMAGE.test(image)) {
    throw new Error("--container-image must be one bounded Docker image name or immutable digest");
  }
  let parsed;
  try {
    parsed = JSON.parse(
      execFileSync(dockerBin, ["image", "inspect", image], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: DOCKER_TIMEOUT_MS,
        maxBuffer: DOCKER_MAX_BUFFER_BYTES
      })
    );
  } catch {
    throw new Error(`Could not inspect the tested container image ${image}`);
  }
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error("Container evidence requires exactly one inspected image");
  }
  const inspected = parsed[0];
  const imageId = inspected?.Id;
  if (typeof imageId !== "string" || !/^sha256:[0-9a-f]{64}$/.test(imageId)) {
    throw new Error("Inspected container image must have one exact sha256 image ID");
  }
  const labels = inspected?.Config?.Labels;
  if (
    labels?.[OCI_REVISION] !== commit ||
    labels?.[OCI_SOURCE] !== release.repository ||
    labels?.[OCI_TITLE] !== "Site Behavior Lab" ||
    labels?.[OCI_LICENSES] !== "AGPL-3.0-or-later"
  ) {
    throw new Error("Inspected container image OCI labels do not match the exact source and release identity");
  }
  const buildCommitValues = (Array.isArray(inspected?.Config?.Env) ? inspected.Config.Env : [])
    .filter((entry) => typeof entry === "string" && entry.startsWith("SITE_BEHAVIOR_LAB_BUILD_COMMIT="))
    .map((entry) => entry.slice("SITE_BEHAVIOR_LAB_BUILD_COMMIT=".length));
  if (buildCommitValues.length !== 1 || buildCommitValues[0] !== commit) {
    throw new Error("Inspected container image runtime environment does not identify the exact source commit");
  }
  const repoDigests = Array.isArray(inspected?.RepoDigests) ? [...inspected.RepoDigests].sort() : [];
  for (const digest of repoDigests) {
    if (typeof digest !== "string" || !/@sha256:[0-9a-f]{64}$/.test(digest)) {
      throw new Error("Inspected container image exposed a malformed repository digest");
    }
  }
  const layers = Array.isArray(inspected?.RootFS?.Layers) ? inspected.RootFS.Layers : [];
  if (layers.length === 0 || layers.some((layer) => typeof layer !== "string" || !/^sha256:[0-9a-f]{64}$/.test(layer))) {
    throw new Error("Inspected container image must expose exact sha256 root-filesystem layer identities");
  }
  if (!Number.isSafeInteger(inspected?.Size) || inspected.Size <= 0) {
    throw new Error("Inspected container image must expose a positive exact byte size");
  }
  if (typeof inspected?.Os !== "string" || typeof inspected?.Architecture !== "string") {
    throw new Error("Inspected container image must expose its operating system and architecture");
  }

  const runtime = {
    node: containerRuntimeVersion(root, dockerBin, imageId, "node", REQUIRED_CONTAINER_NODE),
    npm: containerPackageManagerAbsence(root, dockerBin, imageId),
    probeIsolation: {
      pull: "never",
      network: "none",
      rootFilesystem: "read-only",
      capabilities: "all-dropped",
      noNewPrivileges: true
    }
  };

  return {
    name: "container-image",
    kind: "docker-image-inspection",
    image,
    imageId,
    repoDigests,
    os: inspected.Os,
    architecture: inspected.Architecture,
    bytes: inspected.Size,
    rootfsLayers: layers,
    sourceCommit: commit,
    runtime
  };
}

function containerRuntimeVersion(root, dockerBin, imageId, executable, expectedVersion) {
  const args = [
    "run",
    "--rm",
    "--pull=never",
    "--network=none",
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges:true",
    `--entrypoint=${executable}`,
    imageId,
    "--version"
  ];
  let output;
  try {
    output = execFileSync(dockerBin, args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: DOCKER_TIMEOUT_MS,
      maxBuffer: DOCKER_MAX_BUFFER_BYTES
    }).trim();
  } catch {
    throw new Error(`Could not verify ${executable} inside the exact tested container image ${imageId}`);
  }
  const actualVersion = executable === "node" && output.startsWith("v") ? output.slice(1) : output;
  if (actualVersion !== expectedVersion) {
    throw new Error(
      `Tested container image requires ${executable} ${expectedVersion}, not ${output || "an empty version"}`
    );
  }
  return actualVersion;
}

/**
 * The runtime image must ship no package manager: the base's global npm
 * bundles its own tar, undici, and sigstore copies, so the runner stage
 * removes the whole global toolchain and this probe fails closed if any npm
 * binary ever answers from the exact tested image again.
 */
function containerPackageManagerAbsence(root, dockerBin, imageId) {
  const args = [
    "run",
    "--rm",
    "--pull=never",
    "--network=none",
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges:true",
    "--entrypoint=npm",
    imageId,
    "--version"
  ];
  let output;
  try {
    output = execFileSync(dockerBin, args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: DOCKER_TIMEOUT_MS,
      maxBuffer: DOCKER_MAX_BUFFER_BYTES
    }).trim();
  } catch {
    return "absent";
  }
  throw new Error(
    `Tested container image must not ship a package manager; npm answered with ${output || "an empty version"}`
  );
}

async function fileEvidence(root, relative) {
  const absolute = path.join(root, relative);
  const info = await lstat(absolute);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Release input must be a regular file: ${relative}`);
  const bytes = await readFile(absolute);
  return { path: relative, bytes: bytes.length, sha256: sha256(bytes) };
}

function safeArtifactDirectory(root, value, flag) {
  if (typeof value !== "string" || value.trim() === "" || path.isAbsolute(value)) {
    throw new Error(`${flag} must be a relative directory inside the repository`);
  }
  const absolute = path.resolve(root, value);
  const relative = path.relative(root, absolute);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${flag} must resolve to a non-root directory inside the repository`);
  }
  const realAbsolute = realpathSync(absolute);
  const realRelative = path.relative(root, realAbsolute);
  if (
    !realRelative ||
    realRelative.startsWith("..") ||
    path.isAbsolute(realRelative) ||
    realAbsolute !== absolute
  ) {
    throw new Error(`${flag} must not traverse a symbolic link or leave the repository`);
  }
  return { absolute: realAbsolute, relative: relative.split(path.sep).join("/") };
}

async function directoryManifest(directory) {
  const rootInfo = await lstat(directory);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error("Release artifact root must be a real directory, not a file or symbolic link");
  }
  const files = [];
  await walk(directory, directory, files);
  files.sort((left, right) => compareText(left.path, right.path));
  if (files.length === 0) throw new Error("Release artifact directory must not be empty");
  return { files, bytes: files.reduce((sum, file) => sum + file.bytes, 0) };
}

async function walk(root, directory, files) {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => compareText(left.name, right.name));
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) throw new Error(`Release artifact contains a symbolic link: ${path.relative(root, absolute)}`);
    if (info.isDirectory()) {
      await walk(root, absolute, files);
      continue;
    }
    if (!info.isFile()) throw new Error(`Release artifact contains a non-regular entry: ${path.relative(root, absolute)}`);
    const bytes = await readFile(absolute);
    files.push({
      path: path.relative(root, absolute).split(path.sep).join("/"),
      bytes: bytes.length,
      sha256: sha256(bytes)
    });
  }
}

function sha256(value) {
  const digest = createHash("sha256").update(value).digest("hex");
  if (!SHA256.test(digest)) throw new Error("Internal sha256 generation failed");
  return digest;
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function git(cwd, args) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    throw new Error("Release evidence requires an accessible Git checkout");
  }
}

function assertExactSourceStillClean(root, env, expectedCommit, expectedTree) {
  const commit = resolveExactStaticDeploymentCommit({ cwd: root, env });
  const tree = git(root, ["rev-parse", "--verify", "HEAD^{tree}"]).trim().toLowerCase();
  if (commit !== expectedCommit || tree !== expectedTree) {
    throw new Error("Release evidence source identity changed during artifact inspection");
  }
}

async function writeEvidenceExclusive(output, serialized) {
  let handle;
  try {
    handle = await open(
      output,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0),
      0o600
    );
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && ["EEXIST", "ELOOP", "EISDIR"].includes(error.code)) {
      throw new Error("--output must not already exist as a file, directory, or symbolic link");
    }
    throw error;
  }

  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("--output could not be created as a regular file");
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(output).catch(() => undefined);
    throw error;
  }
  await handle.close();
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!["--static-dir", "--container-image", "--output"].includes(flag)) {
      throw new Error(`Unknown argument: ${flag}`);
    }
    if (options[flag]) throw new Error(`${flag} may only be provided once`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    options[flag] = value;
    index += 1;
  }
  return {
    staticDir: options["--static-dir"],
    containerImage: options["--container-image"],
    output: options["--output"]
  };
}

async function runCli() {
  const { staticDir, containerImage, output } = parseArgs(process.argv.slice(2));
  const evidence = await buildReleaseEvidence({ staticDir, containerImage });
  const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
  const receiptSha256 = sha256(serialized);
  if (!output) {
    assertExactSourceStillClean(
      realpathSync(path.resolve(process.cwd())),
      process.env,
      evidence.source.commit,
      evidence.source.tree
    );
    process.stdout.write(serialized);
    return;
  }

  const absoluteOutput = path.resolve(output);
  const root = realpathSync(path.resolve(process.cwd()));
  const lexicalRelativeOutput = path.relative(root, absoluteOutput);
  if (!lexicalRelativeOutput.startsWith("..") && !path.isAbsolute(lexicalRelativeOutput)) {
    throw new Error("--output must be outside the Git worktree so creating evidence cannot dirty its claimed source");
  }
  const outputParent = path.dirname(absoluteOutput);
  const parentInfo = await lstat(outputParent);
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) {
    throw new Error("--output parent must already exist as a real directory");
  }
  const realOutput = path.join(realpathSync(outputParent), path.basename(absoluteOutput));
  const relativeOutput = path.relative(root, realOutput);
  if (!relativeOutput.startsWith("..") && !path.isAbsolute(relativeOutput)) {
    throw new Error("--output must be outside the Git worktree so creating evidence cannot dirty its claimed source");
  }
  const exactRoot = realpathSync(path.resolve(process.cwd()));
  assertExactSourceStillClean(exactRoot, process.env, evidence.source.commit, evidence.source.tree);
  await writeEvidenceExclusive(realOutput, serialized);
  try {
    assertExactSourceStillClean(exactRoot, process.env, evidence.source.commit, evidence.source.tree);
  } catch (error) {
    await unlink(realOutput).catch(() => undefined);
    throw error;
  }
  console.log(`Release evidence sha256:${receiptSha256} written outside the worktree.`);
}

// macOS commonly exposes /var as a symlink to /private/var. Compare real paths
// so a copied/tested CLI under that tree does not silently skip its entrypoint.
const invokedPath = process.argv[1] ? realpathSync(path.resolve(process.argv[1])) : null;
if (invokedPath === realpathSync(fileURLToPath(import.meta.url))) {
  runCli().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    // Surface the refusal reason as a checks-API annotation so a failed
    // required gate is diagnosable from the public run summary, not only
    // from authenticated log access.
    if (process.env.GITHUB_ACTIONS === "true") {
      console.error(`::error title=Release evidence failed::${message}`);
    }
    process.exitCode = 1;
  });
}
