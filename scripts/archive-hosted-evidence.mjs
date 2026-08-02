#!/usr/bin/env node

import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  createHostedEvidenceDirectory,
  HOSTED_EVIDENCE_BUNDLE_FILE,
  HOSTED_EVIDENCE_CONTEXT_FILE,
  hostedEvidenceArchiveRelativePath,
  hostedEvidenceCollectionContract,
  sha256HostedEvidence,
  verifyHostedEvidenceDirectory
} from "./hosted-evidence-provenance-lib.mjs";

const API_ROOT = "https://api.github.com";
const API_VERSION = "2022-11-28";
const JSON_LIMIT = 4 * 1024 * 1024;
const ARCHIVE_LIMIT = 56 * 1024 * 1024;
const SUBJECT_LIMIT = 8 * 1024 * 1024;
const PLAN_LIMIT = 256 * 1024;
const PAGE_LIMIT = 10;
const REQUEST_TIMEOUT_MS = 60_000;
const CANONICAL_REPOSITORY = "iAnonymous3000/site-behavior-lab";

export async function main(args = process.argv.slice(2)) {
  const options = parseOptions(args);
  if (options.mode === "verify") {
    const result = verifyHostedEvidenceDirectory({
      rootDir: options.rootDir,
      directory: options.directory,
      expectedProfile: options.profile,
      expectedSubjectPath: options.subjectPath,
      expectedSubjectSha256: options.subjectSha256,
      expectedSubjectCommit: options.subjectCommit,
      expectedArchiverCommit: options.archiverCommit
    });
    if (!result.ok) throw new Error(result.issues.join("; "));
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        profile: result.profile,
        contextSha256: result.contextSha256,
        contextDigest: result.contextDigest,
        subjectSha256: result.subjectSha256,
        bundleSha256: result.bundleSha256
      })}\n`
    );
    return;
  }
  await collect(options);
}

async function collect(input) {
  const token = requiredEnvironment("GH_TOKEN");
  const runnerEnvironment = requiredEnvironment("RUNNER_ENVIRONMENT");
  if (runnerEnvironment !== "github-hosted") {
    throw new Error(
      "hosted evidence collection requires runner.environment == github-hosted"
    );
  }
  const repository = requiredEnvironment("GITHUB_REPOSITORY");
  if (repository !== CANONICAL_REPOSITORY) {
    throw new Error(
      "hosted evidence collection is restricted to its canonical repository"
    );
  }
  const contract = hostedEvidenceCollectionContract(input.profile);
  const rawPlan = parseJsonObject(
    fatalUtf8(
      readBoundedNoFollow(
        input.sourcesPath,
        PLAN_LIMIT,
        "hosted evidence source plan"
      ),
      "hosted evidence source plan"
    ),
    "hosted evidence source plan"
  );
  exactKeys(rawPlan, ["sources"], "hosted evidence source plan");
  if (
    !Array.isArray(rawPlan.sources) ||
    rawPlan.sources.length !== contract.exactRoles.length
  ) {
    throw new Error(
      `hosted evidence source plan must contain exactly ${contract.exactRoles.join(", ")}`
    );
  }

  const scratch = path.join(input.outputRoot, ".collector-inputs");
  mkdirSync(scratch, { recursive: false, mode: 0o700 });
  const sources = [];
  for (const [index, planned] of rawPlan.sources.entries()) {
    const expectedRole = contract.exactRoles[index];
    exactKeys(
      planned,
      [
        "role",
        "workflowPath",
        "runId",
        "runAttempt",
        "headSha",
        "artifact"
      ],
      `source ${index + 1}`
    );
    const role = boundedToken(planned.role, `source ${index + 1} role`);
    if (role !== expectedRole) {
      throw new Error(
        `source ${index + 1} role must be exactly ${expectedRole}`
      );
    }
    const sourceContract = contract.sources[role];
    const runId = positiveInteger(planned.runId, `${role} run id`);
    const runAttempt = positiveInteger(
      planned.runAttempt,
      `${role} run attempt`,
      100
    );
    const workflowPath = repositoryPath(
      planned.workflowPath,
      `${role} workflow path`
    );
    if (!sourceContract.workflows.includes(workflowPath)) {
      throw new Error(`${role} workflow path is not trusted by the profile`);
    }
    const headSha = fullSha(planned.headSha, `${role} head SHA`);
    const prefix = path.join(
      scratch,
      `${String(index).padStart(2, "0")}-${role}`
    );
    mkdirSync(prefix, { recursive: false, mode: 0o700 });

    const runPath = path.join(prefix, "run.json");
    writeExclusive(
      runPath,
      await githubApi(
        `/repos/${repository}/actions/runs/${runId}`,
        token,
        JSON_LIMIT
      )
    );
    const jobsPagePaths = await collectPages({
      endpoint: `/repos/${repository}/actions/runs/${runId}/jobs`,
      collectionKey: "jobs",
      prefix,
      stem: "jobs",
      token
    });
    const artifactsPagePaths = await collectPages({
      endpoint: `/repos/${repository}/actions/runs/${runId}/artifacts`,
      collectionKey: "artifacts",
      prefix,
      stem: "artifacts",
      token
    });

    let artifact = null;
    let artifactMetadataPath;
    let artifactArchivePath;
    if (sourceContract.artifactRequired) {
      exactKeys(planned.artifact, ["id"], `${role} artifact selection`);
      const artifactId = positiveInteger(
        planned.artifact.id,
        `${role} artifact id`
      );
      artifactMetadataPath = path.join(prefix, "artifact.json");
      const artifactMetadataBytes = await githubApi(
        `/repos/${repository}/actions/artifacts/${artifactId}`,
        token,
        JSON_LIMIT
      );
      writeExclusive(artifactMetadataPath, artifactMetadataBytes);
      const metadata = parseJsonObject(
        fatalUtf8(artifactMetadataBytes, `${role} artifact metadata`),
        `${role} artifact metadata`
      );
      artifactArchivePath = path.join(prefix, "artifact.zip");
      const archiveBytes = await githubApi(
        `/repos/${repository}/actions/artifacts/${artifactId}/zip`,
        token,
        ARCHIVE_LIMIT,
        "application/octet-stream"
      );
      writeExclusive(artifactArchivePath, archiveBytes);
      artifact = {
        id: artifactId,
        name: metadata.name,
        sha256: sha256HostedEvidence(archiveBytes),
        members: [...sourceContract.requiredArtifactMembers]
      };
    } else if (planned.artifact !== null) {
      throw new Error(`${role} artifact selection must be null`);
    }

    sources.push({
      role,
      workflowPath,
      runId,
      runAttempt,
      headSha,
      runPath,
      jobsPagePaths,
      artifactsPagePaths,
      artifact,
      artifactMetadataPath,
      artifactArchivePath
    });
  }

  const subjectBytes = readBoundedNoFollow(
    input.subjectFile,
    SUBJECT_LIMIT,
    "hosted evidence subject"
  );
  const subjectSha256 = sha256HostedEvidence(subjectBytes);
  const relativePath = hostedEvidenceArchiveRelativePath(
    input.profile,
    subjectSha256
  );
  const outputDirectory = path.join(
    input.outputRoot,
    ...relativePath.split("/")
  );
  mkdirSync(path.dirname(outputDirectory), {
    recursive: true,
    mode: 0o700
  });
  const created = createHostedEvidenceDirectory({
    profile: input.profile,
    recordedAt: new Date().toISOString(),
    archiver: {
      runId: requiredEnvironment("GITHUB_RUN_ID"),
      runAttempt: requiredEnvironment("GITHUB_RUN_ATTEMPT"),
      sourceCommit: requiredEnvironment("GITHUB_SHA"),
      runnerEnvironment
    },
    subject: {
      repositoryPath: input.subjectPath,
      commit: input.subjectCommit,
      filePath: input.subjectFile
    },
    sources,
    outputDirectory,
    repositoryRoot: process.cwd()
  });
  const githubOutput = process.env.GITHUB_OUTPUT?.trim();
  if (githubOutput) {
    writeFileSync(
      githubOutput,
      [
        `relative_path=${created.relativePath}`,
        `directory=${created.outputDirectory}`,
        `context_path=${path.join(created.outputDirectory, HOSTED_EVIDENCE_CONTEXT_FILE)}`,
        `bundle_path=${path.join(created.outputDirectory, HOSTED_EVIDENCE_BUNDLE_FILE)}`,
        `subject_sha256=${created.subjectSha256}`,
        `context_sha256=${created.contextSha256}`,
        `context_digest=${created.contextDigest}`,
        `retained_bytes=${created.retainedBytes}`
      ].join("\n") + "\n",
      { flag: "a", encoding: "utf8" }
    );
  }
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      relativePath: created.relativePath,
      contextSha256: created.contextSha256,
      contextDigest: created.contextDigest,
      subjectSha256: created.subjectSha256,
      retainedBytes: created.retainedBytes
    })}\n`
  );
}

async function collectPages({
  endpoint,
  collectionKey,
  prefix,
  stem,
  token
}) {
  const paths = [];
  let totalCount = null;
  let observed = 0;
  for (let page = 1; page <= PAGE_LIMIT; page += 1) {
    const separator = endpoint.includes("?") ? "&" : "?";
    const bytes = await githubApi(
      `${endpoint}${separator}per_page=100&page=${page}`,
      token,
      JSON_LIMIT
    );
    const value = parseJsonObject(
      fatalUtf8(bytes, `${stem} page ${page}`),
      `${stem} page ${page}`
    );
    if (
      !Number.isSafeInteger(value.total_count) ||
      value.total_count < 0 ||
      !Array.isArray(value[collectionKey]) ||
      value[collectionKey].length > 100
    ) {
      throw new Error(`${stem} page ${page} is not a bounded Actions response`);
    }
    if (totalCount === null) totalCount = value.total_count;
    if (value.total_count !== totalCount) {
      throw new Error(`${stem} pages changed total_count during collection`);
    }
    const filePath = path.join(
      prefix,
      `${stem}-page-${String(page).padStart(3, "0")}.json`
    );
    writeExclusive(filePath, bytes);
    paths.push(filePath);
    observed += value[collectionKey].length;
    if (observed === totalCount) return paths;
    if (value[collectionKey].length === 0 || observed > totalCount) {
      throw new Error(`${stem} pagination is incomplete or inconsistent`);
    }
  }
  throw new Error(`${stem} pagination exceeded ${PAGE_LIMIT} pages`);
}

export function artifactRedirectHostAllowed(hostname) {
  return (
    /(?:^|\.)actions\.githubusercontent\.com$/.test(hostname) ||
    /(?:^|\.)actions\.github\.com$/.test(hostname) ||
    /(?:^|\.)blob\.core\.windows\.net$/.test(hostname)
  );
}

export async function githubApi(
  endpoint,
  token,
  maximumBytes,
  accept = "application/vnd.github+json",
  fetchImpl = fetch
) {
  let response = await fetchImpl(`${API_ROOT}${endpoint}`, {
    redirect: "manual",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      Accept: accept,
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": API_VERSION,
      "User-Agent": "site-behavior-lab-hosted-evidence-archiver"
    }
  });
  if (response.status >= 300 && response.status < 400) {
    if (accept !== "application/octet-stream") {
      await cancelBody(response);
      throw new Error(`GitHub API ${endpoint} returned an unexpected redirect`);
    }
    for (let redirect = 0; redirect < 3; redirect += 1) {
      const location = response.headers.get("location");
      await cancelBody(response);
      let target;
      try {
        target = new URL(location ?? "");
      } catch {
        throw new Error(
          `GitHub artifact ${endpoint} returned an invalid redirect`
        );
      }
      if (
        target.protocol !== "https:" ||
        !artifactRedirectHostAllowed(target.hostname)
      ) {
        throw new Error(
          `GitHub artifact ${endpoint} redirected to an untrusted host`
        );
      }
      response = await fetchImpl(target, {
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: {
          Accept: "application/octet-stream",
          "User-Agent": "site-behavior-lab-hosted-evidence-archiver"
        }
      });
      if (!(response.status >= 300 && response.status < 400)) break;
      if (redirect === 2) {
        await cancelBody(response);
        throw new Error(`GitHub artifact ${endpoint} exceeded redirect bound`);
      }
    }
  }
  if (!response.ok) {
    await cancelBody(response);
    throw new Error(`GitHub API ${endpoint} returned HTTP ${response.status}`);
  }
  return readBoundedResponse(response, endpoint, maximumBytes);
}

async function cancelBody(response) {
  try {
    await response.body?.cancel?.();
  } catch {
    // Best-effort cancellation only.
  }
}

async function readBoundedResponse(response, endpoint, maximumBytes) {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    if (!/^(?:0|[1-9][0-9]*)$/.test(declared)) {
      await cancelBody(response);
      throw new Error(`GitHub API ${endpoint} returned invalid Content-Length`);
    }
    const parsed = Number(declared);
    if (!Number.isSafeInteger(parsed) || parsed > maximumBytes) {
      await cancelBody(response);
      throw new Error(`GitHub API ${endpoint} exceeds its byte bound`);
    }
  }
  if (!response.body) throw new Error(`GitHub API ${endpoint} has no body`);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        throw new Error(`GitHub API ${endpoint} returned a non-byte chunk`);
      }
      if (value.byteLength > maximumBytes - total) {
        await reader.cancel("response exceeds its byte bound");
        throw new Error(`GitHub API ${endpoint} exceeds its byte bound`);
      }
      chunks.push(Buffer.from(value));
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  if (total === 0) {
    throw new Error(`GitHub API ${endpoint} returned an empty body`);
  }
  if (declared !== null && total !== Number(declared)) {
    throw new Error(`GitHub API ${endpoint} body length changed in transit`);
  }
  return Buffer.concat(chunks, total);
}

function writeExclusive(filePath, bytes) {
  writeFileSync(filePath, bytes, { flag: "wx", mode: 0o600 });
}

export function readBoundedNoFollow(filePath, maximumBytes, label) {
  let descriptor;
  try {
    descriptor = openSync(
      filePath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)
    );
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.size < 1 || info.size > maximumBytes) {
      throw new Error(`${label} is not a bounded regular file`);
    }
    const bytes = readFileSync(descriptor);
    if (
      bytes.byteLength !== info.size ||
      bytes.byteLength < 1 ||
      bytes.byteLength > maximumBytes
    ) {
      throw new Error(`${label} changed size while it was read`);
    }
    return bytes;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function parseOptions(args) {
  if (args[0] === "--verify") {
    const values = pairs(args.slice(1));
    const required = [
      "--root",
      "--directory",
      "--profile",
      "--subject-path",
      "--subject-sha256",
      "--subject-commit",
      "--archiver-commit"
    ];
    exactOptionSet(values, required);
    return {
      mode: "verify",
      rootDir: absolute(values.get("--root"), "--root"),
      directory: absolute(values.get("--directory"), "--directory"),
      profile: boundedToken(values.get("--profile"), "--profile"),
      subjectPath: repositoryPath(
        values.get("--subject-path"),
        "--subject-path"
      ),
      subjectSha256: digest(
        values.get("--subject-sha256"),
        "--subject-sha256"
      ),
      subjectCommit: fullSha(
        values.get("--subject-commit"),
        "--subject-commit"
      ),
      archiverCommit: fullSha(
        values.get("--archiver-commit"),
        "--archiver-commit"
      )
    };
  }
  if (args[0] !== "--collect") throw new Error(usage());
  const values = pairs(args.slice(1));
  const required = [
    "--profile",
    "--subject-file",
    "--subject-path",
    "--subject-commit",
    "--sources",
    "--output-root"
  ];
  exactOptionSet(values, required);
  return {
    mode: "collect",
    profile: boundedToken(values.get("--profile"), "--profile"),
    subjectFile: absolute(values.get("--subject-file"), "--subject-file"),
    subjectPath: repositoryPath(
      values.get("--subject-path"),
      "--subject-path"
    ),
    subjectCommit: fullSha(
      values.get("--subject-commit"),
      "--subject-commit"
    ),
    sourcesPath: absolute(values.get("--sources"), "--sources"),
    outputRoot: absolute(values.get("--output-root"), "--output-root")
  };
}

function pairs(args) {
  const values = new Map();
  if (args.length === 0 || args.length % 2 !== 0) throw new Error(usage());
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (
      !key?.startsWith("--") ||
      !value ||
      value.startsWith("--") ||
      values.has(key)
    ) {
      throw new Error(`invalid hosted evidence option ${key ?? "(missing)"}`);
    }
    values.set(key, value);
  }
  return values;
}

function exactOptionSet(values, expected) {
  if (
    JSON.stringify([...values.keys()].sort()) !==
    JSON.stringify([...expected].sort())
  ) {
    throw new Error(usage());
  }
}

function usage() {
  return [
    "Usage:",
    "  archive-hosted-evidence.mjs --collect --profile PROFILE --subject-file ABS --subject-path PATH --subject-commit SHA --sources ABS --output-root ABS",
    "  archive-hosted-evidence.mjs --verify --root ABS --directory ABS --profile PROFILE --subject-path PATH --subject-sha256 SHA256 --subject-commit SHA --archiver-commit SHA"
  ].join("\n");
}

function absolute(value, label) {
  if (!path.isAbsolute(value)) throw new Error(`${label} must be absolute`);
  return value;
}

function boundedToken(value, label) {
  if (
    typeof value !== "string" ||
    !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(value)
  ) {
    throw new Error(`${label} must be a bounded lowercase token`);
  }
  return value;
}

function repositoryPath(value, label) {
  if (
    typeof value !== "string" ||
    !/^(?!\/)(?!.*\/\/)[A-Za-z0-9._/-]{1,500}$/.test(value) ||
    value.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new Error(`${label} must be a safe repository-relative path`);
  }
  return value;
}

function positiveInteger(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed =
    typeof value === "string" && /^[1-9][0-9]*$/.test(value)
      ? Number(value)
      : value;
  if (
    !Number.isSafeInteger(parsed) ||
    parsed <= 0 ||
    parsed > maximum
  ) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return parsed;
}

function fullSha(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/.test(value)) {
    throw new Error(`${label} must be a full lowercase Git commit`);
  }
  return value;
}

function digest(value, label) {
  const normalized =
    typeof value === "string" ? value.replace(/^sha256:/, "") : "";
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(`${label} must be a sha256 digest`);
  }
  return normalized;
}

function requiredEnvironment(name) {
  const value = process.env[name]?.trim() ?? "";
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function fatalUtf8(bytes, label) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }
}

function parseJsonObject(text, label) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must contain a JSON object`);
  }
  return value;
}

function exactKeys(value, expected, label) {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !==
      JSON.stringify([...expected].sort())
  ) {
    throw new Error(
      `${label} must contain exactly: ${[...expected].sort().join(", ")}`
    );
  }
}

const invokedPath = process.argv[1]
  ? path.resolve(process.argv[1])
  : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  await main();
}
