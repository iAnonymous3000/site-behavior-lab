import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync
} from "node:fs";
import path from "node:path";
import {
  extractExactSingleFileArtifactZip
} from "./featured-readjudication-lib.mjs";
import {
  MEASUREMENT_FREEZE_DEFAULT_BRANCH,
  MEASUREMENT_FREEZE_REPOSITORY,
  MEASUREMENT_FREEZE_WORKFLOW
} from "./measurement-freeze-activation-lib.mjs";

export const MEASUREMENT_FREEZE_ARTIFACT_CONTEXT_ENV =
  "SITE_BEHAVIOR_LAB_MEASUREMENT_FREEZE_ARTIFACT_CONTEXT";
export const MEASUREMENT_FREEZE_ARTIFACT_CONTEXT_SHA256_ENV =
  "SITE_BEHAVIOR_LAB_MEASUREMENT_FREEZE_ARTIFACT_CONTEXT_SHA256";
export const MEASUREMENT_FREEZE_ARTIFACT_CONTEXT_FILES = Object.freeze([
  "artifact.json",
  "artifact.zip",
  "artifacts-pages.json",
  "run.json"
]);
export const MEASUREMENT_FREEZE_ARTIFACT_RECEIPT_FILE =
  "measurement-freeze-activation-receipt.json";

const MAX_ARCHIVE_BYTES = 1024 * 1024;
const MAX_API_JSON_BYTES = 1024 * 1024;
const MAX_ARTIFACT_PAGES_BYTES = 4 * 1024 * 1024;
const MAX_ARTIFACTS = 1_000;
const MAX_ARTIFACT_PAGES = 10;
const CONTEXT_DIGEST_DOMAIN =
  "site-behavior-lab-measurement-freeze-artifact-context-v1\u0000";
const FULL_GIT_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function measurementFreezeArtifactContextSha256(files) {
  const hash = createHash("sha256");
  hash.update(CONTEXT_DIGEST_DOMAIN, "utf8");
  for (const filename of MEASUREMENT_FREEZE_ARTIFACT_CONTEXT_FILES) {
    const bytes =
      files instanceof Map ? files.get(filename) : files?.[filename];
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
      throw new Error(
        `artifact context digest input ${filename} must be non-empty bytes`
      );
    }
    hash.update(`${filename}\u0000${bytes.byteLength}\u0000`, "utf8");
    hash.update(bytes);
  }
  return hash.digest("hex");
}

function normalizeArtifactDigest(value, label) {
  const digest =
    typeof value === "string" && value.startsWith("sha256:")
      ? value.slice(7)
      : value;
  if (typeof digest !== "string" || !SHA256.test(digest)) {
    throw new Error(`${label} must be a lowercase sha256 digest`);
  }
  return digest;
}

function receiptIdentity(receipt, receiptBytes) {
  if (!isRecord(receipt)) {
    throw new Error("measurement-freeze receipt must be an object");
  }
  if (!(receiptBytes instanceof Uint8Array)) {
    throw new Error("committed measurement-freeze receipt must be exact bytes");
  }
  const bytes = Buffer.from(receiptBytes);
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_ARCHIVE_BYTES) {
    throw new Error(
      "committed measurement-freeze receipt must be non-empty and no larger than 1 MiB"
    );
  }
  const candidate = receipt.candidate;
  const activation = receipt.activation;
  const repository = receipt.repository;
  const handoff = receipt.handoff;
  if (
    !isRecord(candidate) ||
    !isRecord(activation) ||
    !isRecord(repository) ||
    !isRecord(handoff) ||
    repository.fullName !== MEASUREMENT_FREEZE_REPOSITORY ||
    repository.defaultBranch !== MEASUREMENT_FREEZE_DEFAULT_BRANCH ||
    typeof candidate.commit !== "string" ||
    !FULL_GIT_SHA.test(candidate.commit) ||
    activation.workflow !== MEASUREMENT_FREEZE_WORKFLOW ||
    activation.event !== "workflow_dispatch" ||
    activation.headSha !== candidate.commit ||
    !positiveInteger(activation.runId) ||
    !positiveInteger(activation.runAttempt)
  ) {
    throw new Error(
      "measurement-freeze receipt does not bind an exact activation run and candidate"
    );
  }
  const expectedArtifactName =
    `measurement-freeze-activation-${activation.runId}-${activation.runAttempt}`;
  if (
    handoff.artifactName !== expectedArtifactName ||
    handoff.receiptFile !== MEASUREMENT_FREEZE_ARTIFACT_RECEIPT_FILE
  ) {
    throw new Error(
      "measurement-freeze receipt handoff does not bind its exact activation artifact"
    );
  }
  return {
    bytes,
    candidateSha: candidate.commit,
    runId: activation.runId,
    runAttempt: activation.runAttempt,
    artifactName: expectedArtifactName
  };
}

function parseJsonBytes(bytes, label) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} must be valid UTF-8`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} must be valid JSON`);
  }
}

export async function readBoundedMeasurementFreezeResponseBytes(
  response,
  label,
  maximumBytes
) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
    throw new Error("measurement-freeze response byte ceiling is invalid");
  }
  if (!response?.ok) {
    const status = Number.isSafeInteger(response?.status)
      ? response.status
      : "unknown";
    cancelResponseBodyDetached(response);
    throw new Error(`${label} failed with HTTP ${status}`);
  }
  // Undici decodes gzip/br bodies but preserves their wire Content-Length.
  // Only an identity body's declared length describes the bytes read below.
  const contentEncoding = response.headers?.get?.("content-encoding");
  const identityEncoded =
    contentEncoding === null ||
    contentEncoding === undefined ||
    contentEncoding.trim().toLowerCase() === "identity";
  const declared = identityEncoded
    ? response.headers?.get?.("content-length")
    : null;
  let declaredLength = null;
  if (declared !== null && declared !== undefined) {
    const size = Number(declared);
    if (
      !Number.isSafeInteger(size) ||
      size <= 0 ||
      size > maximumBytes
    ) {
      cancelResponseBodyDetached(response);
      throw new Error(`${label} returned an out-of-bounds body`);
    }
    declaredLength = size;
  }
  if (!response.body || typeof response.body.getReader !== "function") {
    throw new Error(`${label} returned no readable body`);
  }
  const reader = response.body.getReader();
  // Keep one fixed allocation. A hostile API can otherwise remain under the
  // byte ceiling while forcing one retained Buffer object per tiny chunk.
  const bytes = Buffer.allocUnsafe(maximumBytes);
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        throw new Error(`${label} returned an invalid body chunk`);
      }
      if (value.byteLength === 0) continue;
      if (value.byteLength > maximumBytes - total) {
        throw new Error(`${label} exceeded its ${maximumBytes}-byte bound`);
      }
      bytes.set(value, total);
      total += value.byteLength;
    }
  } catch (error) {
    cancelReaderDetached(reader, "measurement-freeze response was refused");
    throw error;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Broken cleanup must not mask the authoritative response verdict.
    }
  }
  if (total === 0) throw new Error(`${label} returned an empty body`);
  if (declaredLength !== null && total !== declaredLength) {
    throw new Error(`${label} body length does not match Content-Length`);
  }
  return Buffer.from(bytes.subarray(0, total));
}

function observeDetached(value) {
  void Promise.resolve(value).catch(() => undefined);
}

function cancelResponseBodyDetached(response) {
  try {
    observeDetached(response?.body?.cancel?.());
  } catch {
    // Header/status refusal remains authoritative if cleanup is hostile.
  }
}

function cancelReaderDetached(reader, reason) {
  try {
    observeDetached(reader.cancel(reason));
  } catch {
    // Body refusal remains authoritative if cleanup is hostile.
  }
}

function githubHeaders(token, accept = "application/vnd.github+json") {
  if (
    typeof token !== "string" ||
    token.length === 0 ||
    token.length > 4096 ||
    /[\u0000-\u001f\u007f]/.test(token)
  ) {
    throw new Error("a bounded GitHub token is required for live artifact verification");
  }
  return {
    Accept: accept,
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "site-behavior-lab-measurement-freeze-verifier"
  };
}

function apiUrl(apiBase, apiPath) {
  const base = new URL(apiBase);
  if (
    base.protocol !== "https:" ||
    base.username !== "" ||
    base.password !== "" ||
    base.search !== "" ||
    base.hash !== ""
  ) {
    throw new Error("GitHub API base must be an uncredentialed HTTPS URL");
  }
  return new URL(apiPath, `${base.origin}/`).href;
}

async function fetchJson(fetchImpl, apiBase, apiPath, token) {
  const label = `GitHub API ${apiPath}`;
  const response = await fetchImpl(apiUrl(apiBase, apiPath), {
    headers: githubHeaders(token),
    redirect: "error",
    signal: AbortSignal.timeout(30_000)
  });
  return parseJsonBytes(
    await readBoundedMeasurementFreezeResponseBytes(
      response,
      label,
      MAX_API_JSON_BYTES
    ),
    label
  );
}

async function fetchArchive(fetchImpl, apiBase, apiPath, token) {
  const label = `GitHub API ${apiPath}`;
  const response = await fetchImpl(apiUrl(apiBase, apiPath), {
    headers: githubHeaders(token, "application/octet-stream"),
    redirect: "follow",
    signal: AbortSignal.timeout(30_000)
  });
  return readBoundedMeasurementFreezeResponseBytes(
    response,
    label,
    MAX_ARCHIVE_BYTES
  );
}

function flattenedArtifactPages(pages) {
  if (
    !Array.isArray(pages) ||
    pages.length === 0 ||
    pages.length > MAX_ARTIFACT_PAGES
  ) {
    throw new Error("activation artifact listing must contain 1 through 10 pages");
  }
  let declaredTotal;
  const artifacts = [];
  const ids = new Set();
  for (const [index, page] of pages.entries()) {
    if (
      !isRecord(page) ||
      !Number.isSafeInteger(page.total_count) ||
      page.total_count < 0 ||
      page.total_count > MAX_ARTIFACTS ||
      !Array.isArray(page.artifacts) ||
      page.artifacts.length > 100
    ) {
      throw new Error(`activation artifact listing page ${index + 1} is malformed`);
    }
    if (declaredTotal === undefined) declaredTotal = page.total_count;
    if (page.total_count !== declaredTotal) {
      throw new Error("activation artifact total_count changed between pages");
    }
    for (const artifact of page.artifacts) {
      if (!isRecord(artifact) || !positiveInteger(artifact.id)) {
        throw new Error("activation artifact listing contains malformed identity");
      }
      if (ids.has(artifact.id)) {
        throw new Error("activation artifact listing contains a duplicate artifact id");
      }
      ids.add(artifact.id);
      artifacts.push(artifact);
    }
    if (artifacts.length > declaredTotal) {
      throw new Error("activation artifact listing exceeds total_count");
    }
    if (
      index < pages.length - 1 &&
      page.artifacts.length !== 100
    ) {
      throw new Error("activation artifact listing contains a premature page");
    }
  }
  if (artifacts.length !== declaredTotal) {
    throw new Error("activation artifact listing does not satisfy total_count");
  }
  return artifacts;
}

function verifyRun(run, identity) {
  const expectedUrl =
    `https://github.com/${MEASUREMENT_FREEZE_REPOSITORY}/actions/runs/${identity.runId}`;
  if (
    !isRecord(run) ||
    run.id !== identity.runId ||
    run.run_attempt !== identity.runAttempt ||
    run.event !== "workflow_dispatch" ||
    run.path !== MEASUREMENT_FREEZE_WORKFLOW ||
    run.head_branch !== MEASUREMENT_FREEZE_DEFAULT_BRANCH ||
    run.head_sha !== identity.candidateSha ||
    run.html_url !== expectedUrl ||
    run.repository?.full_name !== MEASUREMENT_FREEZE_REPOSITORY ||
    run.head_repository?.full_name !== MEASUREMENT_FREEZE_REPOSITORY ||
    run.status !== "completed" ||
    run.conclusion !== "success"
  ) {
    throw new Error(
      "live activation run is not the completed successful exact main workflow run"
    );
  }
}

function verifiedArtifactMetadata(value, identity, label) {
  if (
    !isRecord(value) ||
    !positiveInteger(value.id) ||
    value.name !== identity.artifactName ||
    value.expired !== false ||
    !positiveInteger(value.size_in_bytes) ||
    value.size_in_bytes > MAX_ARCHIVE_BYTES ||
    value.workflow_run?.id !== identity.runId ||
    value.workflow_run?.head_branch !== MEASUREMENT_FREEZE_DEFAULT_BRANCH ||
    value.workflow_run?.head_sha !== identity.candidateSha
  ) {
    throw new Error(`${label} does not bind the exact activation artifact`);
  }
  return {
    id: value.id,
    name: value.name,
    size: value.size_in_bytes,
    digest: normalizeArtifactDigest(value.digest, `${label}.digest`)
  };
}

function verifyArtifactRecords({
  receipt,
  receiptBytes,
  run,
  artifactPages,
  artifact,
  archiveBytes
}) {
  const identity = receiptIdentity(receipt, receiptBytes);
  verifyRun(run, identity);
  const artifacts = flattenedArtifactPages(artifactPages);
  const matches = artifacts.filter(
    (candidate) => candidate.name === identity.artifactName
  );
  if (matches.length !== 1) {
    throw new Error(
      "activation run must contain exactly one artifact with the expected name"
    );
  }
  const listed = verifiedArtifactMetadata(
    matches[0],
    identity,
    "listed activation artifact"
  );
  const detailed = verifiedArtifactMetadata(
    artifact,
    identity,
    "activation artifact metadata"
  );
  if (
    listed.id !== detailed.id ||
    listed.name !== detailed.name ||
    listed.size !== detailed.size ||
    listed.digest !== detailed.digest
  ) {
    throw new Error(
      "activation artifact listing and immutable metadata endpoint disagree"
    );
  }
  if (!(archiveBytes instanceof Uint8Array)) {
    throw new Error("activation artifact ZIP must be exact bytes");
  }
  const archive = Buffer.from(archiveBytes);
  if (
    archive.byteLength === 0 ||
    archive.byteLength > MAX_ARCHIVE_BYTES ||
    archive.byteLength !== detailed.size
  ) {
    throw new Error("activation artifact ZIP byte length does not match metadata");
  }
  const archiveSha256 = sha256(archive);
  if (archiveSha256 !== detailed.digest) {
    throw new Error("activation artifact ZIP digest does not match metadata");
  }
  const extracted = extractExactSingleFileArtifactZip(
    archive,
    MEASUREMENT_FREEZE_ARTIFACT_RECEIPT_FILE
  );
  if (!extracted.equals(identity.bytes)) {
    throw new Error(
      "activation artifact receipt bytes do not match the committed carrier receipt"
    );
  }
  return {
    runId: identity.runId,
    runAttempt: identity.runAttempt,
    artifactId: detailed.id,
    artifactName: detailed.name,
    artifactSha256: archiveSha256,
    receiptSha256: sha256(identity.bytes)
  };
}

function readRegularFile(file, maximumBytes, label) {
  let descriptor;
  try {
    descriptor = openSync(
      file,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)
    );
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.size <= 0 || info.size > maximumBytes) {
      throw new Error(`${label} must be one bounded non-empty regular file`);
    }
    const bytes = readFileSync(descriptor);
    if (
      bytes.byteLength !== info.size ||
      fstatSync(descriptor).size !== info.size
    ) {
      throw new Error(`${label} changed while it was read`);
    }
    return bytes;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function verifyMeasurementFreezeActivationArtifactContext({
  receipt,
  receiptBytes,
  contextDirectory,
  expectedContextSha256
}) {
  if (
    typeof expectedContextSha256 !== "string" ||
    !SHA256.test(expectedContextSha256)
  ) {
    throw new Error(
      "trusted live artifact context sha256 must be a lowercase digest"
    );
  }
  if (
    typeof contextDirectory !== "string" ||
    !path.isAbsolute(contextDirectory)
  ) {
    throw new Error("live artifact context must be an absolute directory");
  }
  const resolved = path.resolve(contextDirectory);
  const directoryInfo = lstatSync(resolved);
  if (
    resolved !== contextDirectory ||
    directoryInfo.isSymbolicLink() ||
    !directoryInfo.isDirectory()
  ) {
    throw new Error("live artifact context must be one real non-symlink directory");
  }
  const actualFiles = readdirSync(resolved).sort();
  if (
    JSON.stringify(actualFiles) !==
    JSON.stringify([...MEASUREMENT_FREEZE_ARTIFACT_CONTEXT_FILES].sort())
  ) {
    throw new Error(
      `live artifact context must contain exactly: ${MEASUREMENT_FREEZE_ARTIFACT_CONTEXT_FILES.join(", ")}`
    );
  }
  const runBytes = readRegularFile(
    path.join(resolved, "run.json"),
    MAX_API_JSON_BYTES,
    "live artifact run metadata"
  );
  const pagesBytes = readRegularFile(
    path.join(resolved, "artifacts-pages.json"),
    MAX_ARTIFACT_PAGES_BYTES,
    "live artifact listing"
  );
  const artifactBytes = readRegularFile(
    path.join(resolved, "artifact.json"),
    MAX_API_JSON_BYTES,
    "live artifact metadata"
  );
  const archiveBytes = readRegularFile(
    path.join(resolved, "artifact.zip"),
    MAX_ARCHIVE_BYTES,
    "live activation artifact ZIP"
  );
  const contextSha256 = measurementFreezeArtifactContextSha256({
    "artifact.json": artifactBytes,
    "artifact.zip": archiveBytes,
    "artifacts-pages.json": pagesBytes,
    "run.json": runBytes
  });
  if (contextSha256 !== expectedContextSha256) {
    throw new Error(
      "live artifact context bytes do not match the trusted prefetch digest"
    );
  }
  return {
    ...verifyArtifactRecords({
      receipt,
      receiptBytes,
      run: parseJsonBytes(runBytes, "live artifact run metadata"),
      artifactPages: parseJsonBytes(pagesBytes, "live artifact listing"),
      artifact: parseJsonBytes(artifactBytes, "live artifact metadata"),
      archiveBytes
    }),
    contextSha256
  };
}

export async function verifyMeasurementFreezeActivationArtifactLive({
  receipt,
  receiptBytes,
  token,
  fetchImpl = globalThis.fetch,
  apiBase = "https://api.github.com"
}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("a fetch implementation is required");
  }
  const identity = receiptIdentity(receipt, receiptBytes);
  const prefix = `/repos/${MEASUREMENT_FREEZE_REPOSITORY}`;
  const run = await fetchJson(
    fetchImpl,
    apiBase,
    `${prefix}/actions/runs/${identity.runId}`,
    token
  );
  const pages = [];
  let declaredTotal;
  let observed = 0;
  for (let page = 1; page <= MAX_ARTIFACT_PAGES; page += 1) {
    const result = await fetchJson(
      fetchImpl,
      apiBase,
      `${prefix}/actions/runs/${identity.runId}/artifacts?per_page=100&page=${page}`,
      token
    );
    pages.push(result);
    if (
      !isRecord(result) ||
      !Number.isSafeInteger(result.total_count) ||
      result.total_count < 0 ||
      result.total_count > MAX_ARTIFACTS ||
      !Array.isArray(result.artifacts) ||
      result.artifacts.length > 100
    ) {
      throw new Error(`activation artifact listing page ${page} is malformed`);
    }
    if (declaredTotal === undefined) declaredTotal = result.total_count;
    if (result.total_count !== declaredTotal) {
      throw new Error("activation artifact total_count changed between pages");
    }
    observed += result.artifacts.length;
    if (observed === declaredTotal) break;
    if (observed > declaredTotal || result.artifacts.length !== 100) {
      throw new Error("activation artifact listing ended inconsistently");
    }
    if (page === MAX_ARTIFACT_PAGES) {
      throw new Error("activation artifact listing exceeded its 1,000-item bound");
    }
  }
  const listed = flattenedArtifactPages(pages);
  const matches = listed.filter(
    (candidate) => candidate.name === identity.artifactName
  );
  if (matches.length !== 1 || !positiveInteger(matches[0].id)) {
    throw new Error(
      "activation run must contain exactly one artifact with the expected name"
    );
  }
  const listedMetadata = verifiedArtifactMetadata(
    matches[0],
    identity,
    "listed activation artifact"
  );
  const artifact = await fetchJson(
    fetchImpl,
    apiBase,
    `${prefix}/actions/artifacts/${matches[0].id}`,
    token
  );
  const detailedMetadata = verifiedArtifactMetadata(
    artifact,
    identity,
    "activation artifact metadata"
  );
  if (
    listedMetadata.id !== detailedMetadata.id ||
    listedMetadata.name !== detailedMetadata.name ||
    listedMetadata.size !== detailedMetadata.size ||
    listedMetadata.digest !== detailedMetadata.digest
  ) {
    throw new Error(
      "activation artifact listing and immutable metadata endpoint disagree"
    );
  }
  const archiveBytes = await fetchArchive(
    fetchImpl,
    apiBase,
    `${prefix}/actions/artifacts/${matches[0].id}/zip`,
    token
  );
  return verifyArtifactRecords({
    receipt,
    receiptBytes,
    run,
    artifactPages: pages,
    artifact,
    archiveBytes
  });
}
