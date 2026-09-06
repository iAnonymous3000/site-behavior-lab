#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { constants, existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { lstat, open, readFile, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  deploymentReceiptViolation,
  resolveExactStaticDeploymentCommit
} from "./static-deployment-provenance.mjs";

const FULL_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_IMAGE = /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,255}$/;
const OCI_SOURCE = "org.opencontainers.image.source";
const OCI_REVISION = "org.opencontainers.image.revision";
const OCI_TITLE = "org.opencontainers.image.title";
const OCI_LICENSES = "org.opencontainers.image.licenses";
const RELEASE_POLICY_SCHEMA_VERSION = 2;
const RELEASE_DATE_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const RELEASE_VERSION_PATTERN =
  /^(?:0\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?|1\.0\.0(?:-rc\.[1-9]\d*)?)$/;
const RELEASE_TAG_PATTERN =
  /^v(?:0\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?|1\.0\.0(?:-rc\.[1-9]\d*)?)$/;
const REQUIRED_NODE = "24.14.1";
const REQUIRED_NPM = "11.11.0";
const REQUIRED_PACKAGE_MANAGER = `npm@${REQUIRED_NPM}`;
const REQUIRED_CONTAINER_NODE = "24.18.1";
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
  releaseTagGovernanceReceiptSha256,
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
  if (release.status !== "released") {
    if (releaseTags.length !== 0) {
      throw new Error(`Development release policy conflicts with existing tag ${releaseTags[0]}`);
    }
  } else {
    if (!RELEASE_TAG_PATTERN.test(release.tag)) {
      throw new Error("A released policy must name a supported 0.x or 1.0 v<version> tag");
    }
    if (releaseTags.length > 1 || (releaseTags.length === 1 && releaseTags[0] !== release.tag)) {
      throw new Error(`Release tag set for ${release.version} must be exactly ${release.tag}`);
    }
  }
  // Whether THIS commit is the one the release tag names. A released policy
  // stays in place while work continues toward the next version, so a receipt
  // built after the release must not imply it evidences the released tree. The
  // tag is created only after its commit is CI-green and promoted, so it is
  // legitimately absent on the release commit itself until then.
  const taggedCommit =
    release.status === "released" && releaseTags.length === 1
      ? git(root, ["rev-list", "-n", "1", release.tag]).trim().toLowerCase()
      : null;
  release.tagExists = taggedCommit !== null;
  release.evidencesReleaseCommit = taggedCommit !== null && taggedCommit === commit;
  if (
    releaseTagGovernanceReceiptSha256 !== undefined &&
    (typeof releaseTagGovernanceReceiptSha256 !== "string" ||
      !SHA256.test(releaseTagGovernanceReceiptSha256))
  ) {
    throw new Error(
      "--release-tag-governance-receipt-sha256 must be one lowercase sha256"
    );
  }
  const governanceBound = releaseTagGovernanceReceiptSha256 !== undefined;
  const evidence = {
    schemaVersion: governanceBound ? 2 : 1,
    evidenceKind: "exact-source-and-tested-artifact-manifest",
    ...(governanceBound
      ? { releaseTagGovernanceReceiptSha256 }
      : {}),
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

/**
 * Which archived release CITATION.cff must cite, given the set of receipted
 * versions and the version release-policy.json currently declares.
 *
 * The declared version wins the moment its own receipt exists, release
 * candidate or stable: once the archive records that the release happened,
 * the citation must advance to it, and an rc rehearsal whose receipt is
 * archived while the policy still names it (the recorded 0.4.0-rc.1 state)
 * is cited as itself, not as an older stable release. Before that receipt
 * exists, the newest stable receipt is the release that actually happened;
 * 0.4.0-rc.1 has a receipt and is not what this repository should be cited
 * as while 0.4.0 exists. A project whose only receipts are candidates has
 * genuinely shipped nothing else, and citing the newest candidate is then
 * honest -- refusing would be the false claim.
 *
 * Exported because the release workflow's isolated attest job enforces the
 * same contract but must never execute candidate code, so it carries a
 * byte-identical copy of this function; lib/release-evidence.test.ts
 * cross-asserts the two texts. Keep the body self-contained and comment-free.
 */
export function selectCitedReceiptedVersion(receiptedVersions, policyVersion) {
  const versions = [...new Set(receiptedVersions)];
  if (versions.length === 0) return null;
  if (versions.includes(policyVersion)) return policyVersion;
  const stable = versions.filter((name) => !name.includes("-"));
  const candidates = stable.length > 0 ? stable : versions;
  const key = (version) =>
    version.split(".").map((part) => Number(part).toString().padStart(6, "0")).join(".");
  return candidates.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0)).at(-1);
}

/**
 * The release CITATION.cff must cite right now.
 *
 * A receipt is the canonical record that a release happened: it exists only
 * after the tag ceremony completes. A version merely DECLARED in
 * release-policy.json has not necessarily been tagged, promoted, or receipted.
 */
function latestReceiptedVersion(root, policyVersion) {
  const dir = path.join(root, "docs", "release-receipts");
  const versions = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => existsSync(path.join(dir, name, "release-receipt.json")));
  const selected = selectCitedReceiptedVersion(versions, policyVersion);
  if (selected === null) throw new Error("no archived release receipt exists to cite");
  return selected;
}

function receiptedReleaseDate(root, version) {
  const receipt = JSON.parse(
    readFileSync(path.join(root, "docs", "release-receipts", version, "release-receipt.json"), "utf8")
  );
  const date = receipt.releaseDate ?? receipt.release?.releaseDate;
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`release receipt for ${version} carries no usable releaseDate`);
  }
  return date;
}

async function releaseMetadata(root) {
  const packageManifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const packageLock = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
  const policy = JSON.parse(await readFile(path.join(root, "release-policy.json"), "utf8"));
  const citation = await readFile(path.join(root, "CITATION.cff"), "utf8");
  const changelog = await readFile(path.join(root, "CHANGELOG.md"), "utf8");

  if (policy?.schemaVersion !== RELEASE_POLICY_SCHEMA_VERSION) {
    throw new Error(`release-policy.json must use schemaVersion ${RELEASE_POLICY_SCHEMA_VERSION}`);
  }
  if (policy?.status !== "development" && policy?.status !== "released") {
    throw new Error("release-policy.json status must be exactly development or released");
  }
  const released = policy.status === "released";
  // Neither state may claim a blanket stable public API or npm publication:
  // 1.0 promises only the governed compatibility surface.
  if (policy?.stablePublicApi !== false || policy?.npmPublication !== "disabled") {
    throw new Error("Release policy must keep stable-API and npm-publication claims disabled");
  }
  if (!released && policy?.releaseTag !== null) {
    throw new Error("Development release policy must not name a release tag");
  }
  if (!released && policy?.releaseDate !== null) {
    throw new Error("Development release policy must not claim a release date");
  }
  if (released && policy?.releaseTag !== `v${policy.version}`) {
    throw new Error("A released policy must name the tag v<version> for its own version");
  }
  if (released && !RELEASE_DATE_PATTERN.test(policy?.releaseDate ?? "")) {
    throw new Error("A released policy must carry one YYYY-MM-DD release date");
  }
  if (packageManifest?.private !== true) throw new Error("Release policy requires package.json private=true");
  if (typeof packageManifest?.version !== "string" || packageManifest.version !== policy.version) {
    throw new Error("package.json and release-policy.json versions must match exactly");
  }
  if (!RELEASE_VERSION_PATTERN.test(policy.version)) {
    throw new Error("Release policy requires one supported 0.x or exact 1.0 semantic version");
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
  // CITATION.cff cites the most recent RECEIPTED release, not the declared one.
  //
  // Citation tooling reads this file standalone: it never sees RELEASE.md's
  // declare-then-tag window, so a version declared but not yet tagged and
  // receipted reads as a release that exists. 0.5.0 sat declared for five days
  // with no tag, no GitHub release and no receipt, and this check REQUIRED
  // CITATION.cff to assert it -- making the standalone overclaim mandatory
  // rather than accidental. Two sibling guards in lib/ enforced the same
  // coupling and now follow the receipt too.
  const receiptedVersion = latestReceiptedVersion(root, policy.version);
  const citationVersions = [...citation.matchAll(/^version:\s*["']?([^"'\s]+)["']?\s*$/gm)].map(
    (match) => match[1]
  );
  if (citationVersions.length !== 1 || citationVersions[0] !== receiptedVersion) {
    throw new Error(
      `CITATION.cff must declare the most recent receipted release (${receiptedVersion})` +
        (receiptedVersion === policy.version ? "" : `, not the declared version ${policy.version}`)
    );
  }
  const citationDates = [...citation.matchAll(/^date-released:\s*["']?([0-9]{4}-[0-9]{2}-[0-9]{2})["']?\s*$/gm)].map(
    (match) => match[1]
  );
  // The date follows the receipt for the same reason the version does: the
  // receipt is the canonical record of a release that actually happened.
  const receiptedDate = receiptedReleaseDate(root, receiptedVersion);
  if (citationDates.length !== 1 || citationDates[0] !== receiptedDate) {
    throw new Error(
      `CITATION.cff must carry the receipted release date for ${receiptedVersion} (${receiptedDate})`
    );
  }
  // Ongoing work always has somewhere to go, in both states.
  const unreleasedSections = [...changelog.matchAll(/^## Unreleased\s*$/gm)];
  if (unreleasedSections.length !== 1) {
    throw new Error("Release policy requires one explicit Unreleased changelog section");
  }
  const escapedVersion = policy.version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const datedSections = [
    ...changelog.matchAll(new RegExp(`^## \\[?${escapedVersion}\\]?\\s+-\\s*([0-9]{4}-[0-9]{2}-[0-9]{2})\\s*$`, "gm"))
  ];
  if (!released && datedSections.length !== 0) {
    throw new Error("Development changelog must not claim a dated release for the current version");
  }
  if (released && (datedSections.length !== 1 || datedSections[0][1] !== policy.releaseDate)) {
    throw new Error("A released changelog must carry exactly one dated section for its own version and date");
  }

  const repository = normalizeRepository(packageManifest?.repository?.url);
  return {
    status: policy.status,
    version: policy.version,
    tag: released ? policy.releaseTag : null,
    releaseDate: released ? policy.releaseDate : null,
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
  // The receipt shape is owned by static-deployment-provenance.mjs, which also
  // builds it. Restating it here is what let the producer and this gate drift.
  const violation = deploymentReceiptViolation(deployment, commit, { cwd: root });
  if (violation !== null) {
    throw new Error(`Static artifact ${violation}`);
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
  // "absent" is an ATTESTED CLAIM, so it needs positive proof, not merely the
  // absence of a successful run. Catching every throw and returning "absent"
  // meant a probe that never tested anything -- a docker timeout, an ENOBUFS,
  // an OOM-killed container, or npm failing to create $HOME/.npm under
  // --read-only -- published the same supply-chain assurance as a real
  // not-found. Only docker's own "executable file not found" answer proves the
  // image ships no npm; anything else is inconclusive and must fail the run.
  const result = spawnSync(dockerBin, args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: DOCKER_TIMEOUT_MS,
    maxBuffer: DOCKER_MAX_BUFFER_BYTES
  });
  if (result.error) {
    throw new Error(
      `Container package-manager probe could not run: ${result.error.code ?? result.error.message}`
    );
  }
  if (result.signal) {
    throw new Error(`Container package-manager probe was terminated by ${result.signal}`);
  }
  const stdout = (result.stdout ?? "").trim();
  const stderr = (result.stderr ?? "").trim();
  if (result.status === 0) {
    throw new Error(
      `Tested container image must not ship a package manager; npm answered with ${stdout || "an empty version"}`
    );
  }
  if (result.status === 127 && /executable file not found/i.test(stderr)) {
    return "absent";
  }
  throw new Error(
    `Container package-manager probe was inconclusive (exit ${result.status ?? "unknown"}): ${
      stderr.slice(0, 300) || "no stderr"
    }`
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

export async function directoryManifest(directory) {
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
    if (
      ![
        "--static-dir",
        "--container-image",
        "--release-tag-governance-receipt-sha256",
        "--output"
      ].includes(flag)
    ) {
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
    releaseTagGovernanceReceiptSha256:
      options["--release-tag-governance-receipt-sha256"],
    output: options["--output"]
  };
}

async function runCli() {
  const {
    staticDir,
    containerImage,
    releaseTagGovernanceReceiptSha256,
    output
  } = parseArgs(process.argv.slice(2));
  const evidence = await buildReleaseEvidence({
    staticDir,
    containerImage,
    releaseTagGovernanceReceiptSha256
  });
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
