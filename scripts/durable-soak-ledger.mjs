#!/usr/bin/env node

import {
  mkdirSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { TextDecoder } from "node:util";
import { fileURLToPath } from "node:url";
import {
  buildDurableSoakSourceDigestManifest,
  canonicalDurableSoakText,
  deriveDurableSoakLedger,
  DURABLE_SOAK_DEEP_RUN_NAME,
  DURABLE_SOAK_HEALTH_ARTIFACT_MEMBERS,
  DURABLE_SOAK_HEALTH_JOB,
  DURABLE_SOAK_LEDGER_FILE,
  DURABLE_SOAK_MARKER_STEP,
  DURABLE_SOAK_MAXIMUM_SAMPLES,
  DURABLE_SOAK_RESTART_WORKFLOW,
  DURABLE_SOAK_SHALLOW_RUN_NAME,
  DURABLE_SOAK_SOURCE_DIGESTS_FILE,
  sha256DurableSoak,
  verifyDurableSoakLedgerMembers
} from "./durable-soak-ledger-lib.mjs";
import {
  extractHostedEvidenceArtifactZipMembers
} from "./hosted-evidence-provenance-lib.mjs";
import {
  verifyDurableRestartEvidenceSet
} from "./durable-soak-restart-evidence-lib.mjs";
import {
  githubApi,
  HOSTED_EVIDENCE_REQUEST_TIMEOUT_MS
} from "./archive-hosted-evidence.mjs";

const REPOSITORY = "iAnonymous3000/site-behavior-lab";
const JSON_LIMIT = 4 * 1024 * 1024;
const ARTIFACT_LIMIT = 16 * 1024 * 1024;
export const DURABLE_SOAK_OUTPUT_LIMIT_BYTES = 48 * 1024 * 1024;
const PAGE_LIMIT = 10;
const EXACT_RUN_PAGE_LIMIT = 1;
export const DURABLE_SOAK_GITHUB_APP_PRIMARY_LIMIT = 5_000;
export const DURABLE_SOAK_REST_REQUEST_CAP = 750;
export const DURABLE_SOAK_MAXIMUM_DEEP_RUNS = 193;
export const DURABLE_SOAK_MAXIMUM_PROJECTED_REST_REQUESTS = 607;
export const DURABLE_SOAK_MAX_CONCURRENT_REQUESTS = 32;
export const DURABLE_SOAK_MAX_ARTIFACT_REDIRECTS = 1;
export const DURABLE_SOAK_REQUEST_TIMEOUT_MS =
  HOSTED_EVIDENCE_REQUEST_TIMEOUT_MS;
export const DURABLE_SOAK_COLLECTION_DEADLINE_MINUTES = 45;
export const DURABLE_SOAK_WORKFLOW_TIMEOUT_MINUTES = 60;
export const DURABLE_SOAK_NON_COLLECTION_RESERVE_MINUTES =
  DURABLE_SOAK_WORKFLOW_TIMEOUT_MINUTES -
  DURABLE_SOAK_COLLECTION_DEADLINE_MINUTES;
export const DURABLE_SOAK_MAXIMUM_NETWORK_TIMEOUT_SLOTS = 43;
const RESTART_ARTIFACT_MEMBERS = Object.freeze([
  "post-health.json",
  "pre-health.json",
  "queued-work-recovery.json",
  "restart-evidence.json"
]);

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function isRecord(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function parseJson(bytes, label) {
  let text;
  try {
    text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true
    }).decode(bytes);
  } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
  requireValue(isRecord(value), `${label} must be a JSON object`);
  return value;
}

function positiveInteger(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed =
    typeof value === "string" && /^[1-9][0-9]*$/.test(value)
      ? Number(value)
      : value;
  requireValue(
    Number.isSafeInteger(parsed) && parsed > 0 && parsed <= maximum,
    `${label} must be a positive safe integer`
  );
  return parsed;
}

function canonicalInstant(value, label) {
  requireValue(
    typeof value === "string" &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
      Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString() === value,
    `${label} must be a canonical millisecond UTC instant`
  );
  return value;
}

function digest(value, label) {
  const normalized =
    typeof value === "string"
      ? value.replace(/^sha256:/, "")
      : "";
  requireValue(
    /^[0-9a-f]{64}$/.test(normalized),
    `${label} must be a lowercase sha256 digest`
  );
  return normalized;
}

export function projectedDurableSoakRestRequests({
  workflowPageCount,
  deepRunCount,
  deepAttemptCount
}) {
  for (const [label, value, maximum] of [
    ["workflowPageCount", workflowPageCount, PAGE_LIMIT],
    [
      "deepRunCount",
      deepRunCount,
      DURABLE_SOAK_MAXIMUM_DEEP_RUNS
    ],
    [
      "deepAttemptCount",
      deepAttemptCount,
      DURABLE_SOAK_MAXIMUM_SAMPLES
    ]
  ]) {
    requireValue(
      Number.isSafeInteger(value) && value >= 0 && value <= maximum,
      `${label} must be an integer from 0 through ${maximum}`
    );
  }
  requireValue(
    deepRunCount <= deepAttemptCount,
    "deepRunCount cannot exceed deepAttemptCount"
  );
  // One Jobs page and one ZIP per deep attempt, one artifact page per
  // deep run, plus the set-complete workflow pages and four exact restart
  // requests (run, Jobs page, artifact page, ZIP).
  return (
    workflowPageCount +
    deepAttemptCount +
    deepRunCount +
    deepAttemptCount +
    4
  );
}

export function projectedDurableSoakNetworkTimeoutSlots({
  workflowPageCount,
  deepRunCount,
  deepAttemptCount
}) {
  projectedDurableSoakRestRequests({
    workflowPageCount,
    deepRunCount,
    deepAttemptCount
  });
  const attemptWaves = Math.ceil(
    deepAttemptCount / DURABLE_SOAK_MAX_CONCURRENT_REQUESTS
  );
  const runWaves = Math.ceil(
    deepRunCount / DURABLE_SOAK_MAX_CONCURRENT_REQUESTS
  );
  // Workflow pagination remains serial so each page can prove a stable
  // total_count. The three deep-run phases are independently bounded:
  // attempt Jobs pages, per-run artifact pages, and artifact downloads.
  // Each download permits one API-to-blob redirect, hence two fetch slots.
  // Exact restart capture is three JSON calls plus one redirected download.
  return (
    workflowPageCount +
    attemptWaves +
    runWaves +
    attemptWaves * (1 + DURABLE_SOAK_MAX_ARTIFACT_REDIRECTS) +
    3 +
    1 +
    DURABLE_SOAK_MAX_ARTIFACT_REDIRECTS
  );
}

export function createDurableSoakCollectionControl({
  deadlineMs = DURABLE_SOAK_COLLECTION_DEADLINE_MINUTES * 60_000,
  now = Date.now,
  signal = AbortSignal.timeout(deadlineMs)
} = {}) {
  requireValue(
    Number.isSafeInteger(deadlineMs) &&
      deadlineMs > 0 &&
      deadlineMs <=
        DURABLE_SOAK_COLLECTION_DEADLINE_MINUTES * 60_000,
    `durable soak collection deadline must be 1..${
      DURABLE_SOAK_COLLECTION_DEADLINE_MINUTES * 60_000
    } milliseconds`
  );
  requireValue(
    typeof now === "function",
    "durable soak collection deadline requires a clock"
  );
  requireValue(
    signal instanceof AbortSignal,
    "durable soak collection deadline requires an AbortSignal"
  );
  const startedAtMs = now();
  requireValue(
    Number.isSafeInteger(startedAtMs) &&
      startedAtMs >= 0 &&
      Number.isSafeInteger(startedAtMs + deadlineMs),
    "durable soak collection deadline clock is invalid"
  );
  const deadlineAtMs = startedAtMs + deadlineMs;
  return Object.freeze({
    signal,
    deadlineAtMs,
    assertActive(phase) {
      requireValue(
        typeof phase === "string" && phase.length >= 1 && phase.length <= 100,
        "durable soak collection deadline phase is invalid"
      );
      const observedAtMs = now();
      requireValue(
        Number.isSafeInteger(observedAtMs) && observedAtMs >= 0,
        "durable soak collection deadline clock is invalid"
      );
      requireValue(
        !signal.aborted && observedAtMs < deadlineAtMs,
        `durable soak collection deadline expired before ${phase}`
      );
    }
  });
}

export function createDurableSoakOutputDirectoryWithinDeadline(
  outputDirectory,
  collectionControl
) {
  requireValue(
    collectionControl !== null &&
      typeof collectionControl === "object" &&
      typeof collectionControl.assertActive === "function",
    "durable soak output requires collection deadline control"
  );
  collectionControl.assertActive("output creation");
  mkdirSync(outputDirectory, {
    recursive: false,
    mode: 0o700
  });
}

export async function mapDurableSoakConcurrent(
  values,
  visit,
  maximumConcurrency = DURABLE_SOAK_MAX_CONCURRENT_REQUESTS
) {
  requireValue(Array.isArray(values), "durable soak work must be an array");
  requireValue(
    typeof visit === "function",
    "durable soak work visitor must be a function"
  );
  requireValue(
    Number.isSafeInteger(maximumConcurrency) &&
      maximumConcurrency > 0 &&
      maximumConcurrency <= DURABLE_SOAK_MAX_CONCURRENT_REQUESTS,
    `durable soak concurrency must be 1..${DURABLE_SOAK_MAX_CONCURRENT_REQUESTS}`
  );
  const results = new Array(values.length);
  let nextIndex = 0;
  let failed = false;
  let firstFailure = null;
  const cancellation = new AbortController();
  const worker = async () => {
    while (!failed) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) return;
      try {
        results[index] = await visit(
          values[index],
          index,
          cancellation.signal
        );
      } catch (error) {
        if (!failed) {
          failed = true;
          firstFailure = error;
          cancellation.abort(error);
        }
      }
    }
  };
  await Promise.all(
    Array.from(
      {
        length: Math.min(maximumConcurrency, values.length)
      },
      () => worker()
    )
  );
  if (failed) throw firstFailure;
  return results;
}

export async function mapDurableSoakDownloads({
  selections,
  retainedBytes,
  download,
  maximumBytes = DURABLE_SOAK_OUTPUT_LIMIT_BYTES
}) {
  requireValue(
    Array.isArray(selections) &&
      selections.every(
        (selection) =>
          Number.isSafeInteger(selection?.identity?.sizeBytes) &&
          selection.identity.sizeBytes > 0 &&
          selection.identity.sizeBytes <= ARTIFACT_LIMIT
      ),
    "durable soak download selections must bind bounded artifact sizes"
  );
  requireValue(
    Number.isSafeInteger(retainedBytes) && retainedBytes >= 0,
    "durable soak retained bytes must be a nonnegative safe integer"
  );
  requireValue(
    Number.isSafeInteger(maximumBytes) &&
      maximumBytes > 0 &&
      maximumBytes <= DURABLE_SOAK_OUTPUT_LIMIT_BYTES,
    `durable soak output limit must be 1..${DURABLE_SOAK_OUTPUT_LIMIT_BYTES}`
  );
  requireValue(
    typeof download === "function",
    "durable soak download visitor must be a function"
  );
  const declaredArchiveBytes = selections.reduce(
    (total, selection) => total + selection.identity.sizeBytes,
    0
  );
  requireValue(
    Number.isSafeInteger(declaredArchiveBytes) &&
      retainedBytes + declaredArchiveBytes < maximumBytes,
    `durable soak declared artifact ZIP bytes cannot fit below ${maximumBytes}`
  );
  let retainedDownloadBytes = 0;
  return mapDurableSoakConcurrent(
    selections,
    async (selection, index, phaseSignal) => {
      const result = await download(selection, index, phaseSignal);
      requireValue(
        Buffer.isBuffer(result?.archiveBytes) &&
          result.archiveBytes.byteLength ===
            selection.identity.sizeBytes &&
          Buffer.isBuffer(result?.healthBytes) &&
          result.healthBytes.byteLength > 0,
        "durable soak download bytes do not match their admitted selection"
      );
      retainedDownloadBytes +=
        result.archiveBytes.byteLength + result.healthBytes.byteLength;
      requireValue(
        retainedBytes + retainedDownloadBytes <= maximumBytes,
        `durable soak retained source bytes exceed ${maximumBytes} during download`
      );
      return { ...result, ...selection };
    }
  );
}

export function createDurableSoakRequestBudget(
  maximum = DURABLE_SOAK_REST_REQUEST_CAP
) {
  requireValue(
    Number.isSafeInteger(maximum) &&
      maximum > 0 &&
      maximum <= DURABLE_SOAK_REST_REQUEST_CAP,
    `durable soak request budget must be 1..${DURABLE_SOAK_REST_REQUEST_CAP}`
  );
  let used = 0;
  return Object.freeze({
    take(label = "GitHub REST request") {
      requireValue(
        used < maximum,
        `durable soak GitHub REST request cap ${maximum} would be exceeded before ${label}`
      );
      used += 1;
      return used;
    },
    get used() {
      return used;
    },
    maximum
  });
}

async function collectPages({
  endpoint,
  collectionKey,
  memberPrefix,
  members,
  request,
  pageLimit = PAGE_LIMIT
}) {
  const values = [];
  let total = null;
  for (let page = 1; page <= pageLimit; page += 1) {
    const separator = endpoint.includes("?") ? "&" : "?";
    const bytes = await request(
      `${endpoint}${separator}per_page=100&page=${page}`,
      JSON_LIMIT,
      "application/vnd.github+json",
      `${collectionKey} page ${page}`
    );
    const value = parseJson(
      bytes,
      `${collectionKey} page ${page}`
    );
    requireValue(
      Number.isSafeInteger(value.total_count) &&
        value.total_count >= 0 &&
        Array.isArray(value[collectionKey]) &&
        value[collectionKey].length <= 100,
      `${collectionKey} page ${page} is not a bounded GitHub response`
    );
    if (total === null) total = value.total_count;
    requireValue(
      value.total_count === total,
      `${collectionKey} pages changed total_count during collection`
    );
    const member =
      `${memberPrefix}${String(page).padStart(3, "0")}.json`;
    requireValue(!members.has(member), `duplicate source member ${member}`);
    members.set(member, bytes);
    values.push(...value[collectionKey]);
    if (values.length === total) return values;
    requireValue(
      value[collectionKey].length > 0 && values.length < total,
      `${collectionKey} pagination is incomplete or inconsistent`
    );
  }
  throw new Error(
    `${collectionKey} pagination exceeded ${pageLimit} pages`
  );
}

function mergeDurableSoakMembers(target, source) {
  for (const [member, bytes] of source) {
    requireValue(!target.has(member), `duplicate source member ${member}`);
    target.set(member, bytes);
  }
}

function exactHealthJob(jobs, runId, attempt, headSha) {
  const matches = jobs.filter(
    (job) => job?.name === DURABLE_SOAK_HEALTH_JOB
  );
  requireValue(
    matches.length === 1 &&
      Array.isArray(matches[0].steps) &&
      matches[0].run_id === runId &&
      matches[0].run_attempt === attempt &&
      matches[0].head_sha === headSha,
    `run ${runId} attempt ${attempt} has no exact identity-bound health job`
  );
  return matches[0];
}

function requireDeliveredDeep(job, runId, attempt) {
  const markers = job.steps.filter(
    (step) => step?.name === DURABLE_SOAK_MARKER_STEP
  );
  requireValue(
    markers.length === 1 &&
      markers[0].status === "completed" &&
      markers[0].conclusion === "success",
    `run ${runId} attempt ${attempt} did not execute the exact successful deep-health marker`
  );
}

function artifactIdentity(artifact, runId, headSha, expectedId, label) {
  requireValue(
    isRecord(artifact) &&
      artifact.id === expectedId &&
      artifact.expired === false &&
      Number.isSafeInteger(artifact.size_in_bytes) &&
      artifact.size_in_bytes > 0 &&
      artifact.workflow_run?.id === runId &&
      artifact.workflow_run?.head_sha === headSha,
    `${label} does not identify the exact unexpired workflow artifact`
  );
  return {
    id: artifact.id,
    name: artifact.name,
    sha256: digest(artifact.digest, `${label} digest`),
    sizeBytes: artifact.size_in_bytes
  };
}

async function downloadArtifact({
  artifact,
  request,
  expectedMembers,
  label
}) {
  const archiveBytes = await request(
    `/repos/${REPOSITORY}/actions/artifacts/${artifact.id}/zip`,
    ARTIFACT_LIMIT,
    "application/octet-stream",
    `${label} ZIP`
  );
  requireValue(
    archiveBytes.byteLength === artifact.sizeBytes &&
      sha256DurableSoak(archiveBytes) === artifact.sha256,
    `${label} raw ZIP does not match the GitHub artifact digest and size`
  );
  const extracted = extractHostedEvidenceArtifactZipMembers(
    archiveBytes,
    expectedMembers,
    "exact"
  );
  return {
    archiveBytes,
    members: new Map(
      extracted.map((member) => [member.path, member.bytes])
    )
  };
}

async function collectRestart({
  runId,
  runAttempt,
  artifactId,
  request
}) {
  const runBytes = await request(
    `/repos/${REPOSITORY}/actions/runs/${runId}/attempts/${runAttempt}`,
    JSON_LIMIT,
    "application/vnd.github+json",
    "durable restart run"
  );
  const run = parseJson(runBytes, "durable restart run");
  requireValue(
    run.id === runId &&
      run.run_attempt === runAttempt &&
      run.repository?.full_name === REPOSITORY &&
      run.path === DURABLE_SOAK_RESTART_WORKFLOW &&
      run.event === "workflow_dispatch" &&
      run.head_branch === "main" &&
      /^[0-9a-f]{40}$/.test(run.head_sha) &&
      run.status === "completed" &&
      run.conclusion === "success",
    "durable restart selection is not an exact successful main-branch restart run"
  );
  const scratch = new Map();
  const jobs = await collectPages({
    endpoint:
      `/repos/${REPOSITORY}/actions/runs/${runId}/attempts/${runAttempt}/jobs`,
    collectionKey: "jobs",
    memberPrefix: "restart-jobs-page-",
    members: scratch,
    request,
    pageLimit: EXACT_RUN_PAGE_LIMIT
  });
  const restartJobs = jobs.filter(
    (job) =>
      job?.name ===
        "Restart runtime and prove queued work recovery"
  );
  requireValue(
    restartJobs.length === 1 &&
      restartJobs[0].status === "completed" &&
      restartJobs[0].conclusion === "success",
    "durable restart source is missing its exact successful job"
  );
  const artifacts = await collectPages({
    endpoint: `/repos/${REPOSITORY}/actions/runs/${runId}/artifacts`,
    collectionKey: "artifacts",
    memberPrefix: "restart-artifacts-page-",
    members: scratch,
    request,
    pageLimit: EXACT_RUN_PAGE_LIMIT
  });
  const matches = artifacts.filter(
    (artifact) => artifact?.id === artifactId
  );
  requireValue(
    matches.length === 1,
    "durable restart artifact id is not unique in its source run"
  );
  const expectedName =
    `site-behavior-durable-soak-restart-evidence-${runId}-${runAttempt}`;
  const identity = artifactIdentity(
    matches[0],
    runId,
    run.head_sha,
    artifactId,
    "durable restart artifact"
  );
  requireValue(
    identity.name === expectedName,
    `durable restart artifact must be named ${expectedName}`
  );
  const downloaded = await downloadArtifact({
    artifact: identity,
    request,
    expectedMembers: RESTART_ARTIFACT_MEMBERS,
    label: "durable restart artifact"
  });
  const preHealth = parseJson(
    downloaded.members.get("pre-health.json"),
    "durable restart pre-health"
  );
  const postHealth = parseJson(
    downloaded.members.get("post-health.json"),
    "durable restart post-health"
  );
  const recoveryBytes = downloaded.members.get(
    "queued-work-recovery.json"
  );
  const recovery = parseJson(
    recoveryBytes,
    "durable restart queued recovery"
  );
  const restart = parseJson(
    downloaded.members.get("restart-evidence.json"),
    "durable restart evidence"
  );
  const verified = verifyDurableRestartEvidenceSet({
    preHealth,
    postHealth,
    recovery,
    restart,
    recoverySha256: sha256DurableSoak(recoveryBytes)
  });
  requireValue(
    verified.deploymentCommit === run.head_sha,
    "durable restart artifact deployment does not match its run head"
  );
  return {
    workflowPath: DURABLE_SOAK_RESTART_WORKFLOW,
    runId,
    runAttempt,
    headSha: run.head_sha,
    startedAt: restart.startedAt,
    completedAt: restart.completedAt,
    restartObservedAt: restart.restartObservedAt,
    artifact: {
      id: identity.id,
      name: identity.name,
      sha256: identity.sha256
    },
    recoverySha256: sha256DurableSoak(recoveryBytes)
  };
}

async function collect(options) {
  const token = requiredEnvironment("GH_TOKEN");
  const requestBudget = createDurableSoakRequestBudget();
  const collectionControl = createDurableSoakCollectionControl();
  const request = async (
    endpoint,
    maximumBytes,
    accept,
    label,
    phaseSignal = null
  ) => {
    collectionControl.assertActive("provider request");
    requestBudget.take(label);
    const overallSignal =
      phaseSignal === null
        ? collectionControl.signal
        : AbortSignal.any([collectionControl.signal, phaseSignal]);
    const bytes = await githubApi(
      endpoint,
      token,
      maximumBytes,
      accept,
      fetch,
      {
        requestTimeoutMs: DURABLE_SOAK_REQUEST_TIMEOUT_MS,
        maximumArtifactRedirects:
          DURABLE_SOAK_MAX_ARTIFACT_REDIRECTS,
        overallSignal
      }
    );
    // AbortSignal timeout delivery can be delayed while synchronous work owns
    // the event loop. The fixed timestamp check is authoritative before any
    // response parsing, ZIP expansion, or other CPU work begins.
    collectionControl.assertActive("provider response processing");
    return bytes;
  };
  requireValue(
    requiredEnvironment("GITHUB_REPOSITORY") === REPOSITORY,
    "durable soak collection is restricted to its canonical repository"
  );
  requireValue(
    requiredEnvironment("RUNNER_ENVIRONMENT") === "github-hosted",
    "durable soak collection requires an isolated GitHub-hosted runner"
  );
  requireValue(
    Date.parse(options.endedAt) <= Date.now(),
    "durable soak query end must not be in the future"
  );
  const members = new Map();
  const created =
    `${options.startedAt}..${options.endedAt}`;
  const runs = await collectPages({
    endpoint:
      `/repos/${REPOSITORY}/actions/workflows/production-health.yml/runs` +
      `?event=schedule&created=${encodeURIComponent(created)}`,
    collectionKey: "workflow_runs",
    memberPrefix: "raw/workflow-runs-page-",
    members,
    request
  });
  collectionControl.assertActive("workflow-run phase completion");
  requireValue(
    runs.length > 0 && runs.length <= 1_000,
    "durable soak query must return 1..1000 scheduled runs"
  );

  const deepRuns = [];
  let deepAttemptCount = 0;
  for (const [index, listed] of runs.entries()) {
    const runId = positiveInteger(listed?.id, "workflow run id");
    const currentAttempt = positiveInteger(
      listed?.run_attempt,
      `workflow run ${runId} current attempt`,
      20
    );
    requireValue(
      isRecord(listed) &&
        listed.repository?.full_name === REPOSITORY &&
        listed.path ===
          ".github/workflows/production-health.yml" &&
        listed.event === "schedule" &&
        listed.head_branch === "main" &&
        /^[0-9a-f]{40}$/.test(listed.head_sha) &&
        (
          listed.display_title === DURABLE_SOAK_DEEP_RUN_NAME ||
          listed.display_title === DURABLE_SOAK_SHALLOW_RUN_NAME
        ),
      `workflow run ${index + 1}/${runId} is not an exact source-named scheduled Production Health lane`
    );
    if (listed.display_title === DURABLE_SOAK_SHALLOW_RUN_NAME) {
      continue;
    }
    requireValue(
      listed.status === "completed" &&
        listed.conclusion === "success",
      `delivered deep Production Health run ${runId} did not complete successfully`
    );
    deepAttemptCount += currentAttempt;
    deepRuns.push({ listed, runId, currentAttempt });
  }
  requireValue(
    deepRuns.length > 0 &&
      deepRuns.length <= DURABLE_SOAK_MAXIMUM_DEEP_RUNS,
    `durable soak query must contain 1..${DURABLE_SOAK_MAXIMUM_DEEP_RUNS} exact deep runs`
  );
  requireValue(
    deepAttemptCount <= DURABLE_SOAK_MAXIMUM_SAMPLES,
    `durable soak query exceeds ${DURABLE_SOAK_MAXIMUM_SAMPLES} deep attempts`
  );
  const projectedRequests = projectedDurableSoakRestRequests({
    workflowPageCount: requestBudget.used,
    deepRunCount: deepRuns.length,
    deepAttemptCount
  });
  const projectedNetworkTimeoutSlots =
    projectedDurableSoakNetworkTimeoutSlots({
      workflowPageCount: requestBudget.used,
      deepRunCount: deepRuns.length,
      deepAttemptCount
    });
  requireValue(
    projectedRequests <= DURABLE_SOAK_REST_REQUEST_CAP &&
      projectedRequests <
        DURABLE_SOAK_GITHUB_APP_PRIMARY_LIMIT,
    `durable soak projection ${projectedRequests} exceeds the reviewed REST budget`
  );
  requireValue(
    projectedNetworkTimeoutSlots <=
      DURABLE_SOAK_MAXIMUM_NETWORK_TIMEOUT_SLOTS &&
      projectedNetworkTimeoutSlots *
        DURABLE_SOAK_REQUEST_TIMEOUT_MS <
        DURABLE_SOAK_COLLECTION_DEADLINE_MINUTES * 60_000,
    `durable soak projection ${projectedNetworkTimeoutSlots} exceeds the reviewed collection deadline`
  );

  const deepAttempts = [];
  for (const { listed, runId, currentAttempt } of deepRuns) {
    for (let attempt = 1; attempt <= currentAttempt; attempt += 1) {
      deepAttempts.push({ listed, runId, attempt });
    }
  }

  const jobResults = await mapDurableSoakConcurrent(
    deepAttempts,
    async ({ listed, runId, attempt }, _index, phaseSignal) => {
      const attemptWire = String(attempt).padStart(3, "0");
      const scratch = new Map();
      const jobs = await collectPages({
        endpoint:
          `/repos/${REPOSITORY}/actions/runs/${runId}/attempts/${attempt}/jobs`,
        collectionKey: "jobs",
        memberPrefix:
          `raw/runs/${runId}/attempt-${attemptWire}-jobs-page-`,
        members: scratch,
        request: (...args) => request(...args, phaseSignal),
        pageLimit: EXACT_RUN_PAGE_LIMIT
      });
      const healthJob = exactHealthJob(
        jobs,
        runId,
        attempt,
        listed.head_sha
      );
      requireDeliveredDeep(healthJob, runId, attempt);
      return scratch;
    }
  );
  collectionControl.assertActive("job phase completion");
  for (const scratch of jobResults) {
    mergeDurableSoakMembers(members, scratch);
  }

  const artifactPageResults = await mapDurableSoakConcurrent(
    deepRuns,
    async ({ runId }, _index, phaseSignal) => {
      const scratch = new Map();
      const artifacts = await collectPages({
        endpoint: `/repos/${REPOSITORY}/actions/runs/${runId}/artifacts`,
        collectionKey: "artifacts",
        memberPrefix: `raw/runs/${runId}/artifacts-page-`,
        members: scratch,
        request: (...args) => request(...args, phaseSignal),
        pageLimit: EXACT_RUN_PAGE_LIMIT
      });
      return { artifacts, scratch };
    }
  );
  collectionControl.assertActive("artifact-list phase completion");
  const artifactsByRun = new Map();
  for (const [index, result] of artifactPageResults.entries()) {
    mergeDurableSoakMembers(members, result.scratch);
    artifactsByRun.set(deepRuns[index].runId, result.artifacts);
  }

  const downloadSelections = deepAttempts.map(
    ({ listed, runId, attempt }) => {
      const artifacts = artifactsByRun.get(runId);
      const expectedName =
        `site-behavior-production-health-evidence-${runId}-${attempt}`;
      const matches = artifacts.filter(
        (artifact) => artifact?.name === expectedName
      );
      requireValue(
        matches.length === 1,
        `deep Production Health run ${runId} attempt ${attempt} has no exact evidence artifact`
      );
      const identity = artifactIdentity(
        matches[0],
        runId,
        listed.head_sha,
        matches[0].id,
        `deep Production Health run ${runId} attempt ${attempt} artifact`
      );
      return { identity, runId, attempt };
    }
  );
  const retainedBytesBeforeDownloads = [...members.values()].reduce(
    (total, bytes) => total + bytes.byteLength,
    0
  );
  const downloadResults = await mapDurableSoakDownloads({
    selections: downloadSelections,
    retainedBytes: retainedBytesBeforeDownloads,
    download: async (
      { identity, runId, attempt },
      _index,
      phaseSignal
    ) => {
      const downloaded = await downloadArtifact({
        artifact: identity,
        request: (...args) => request(...args, phaseSignal),
        expectedMembers: DURABLE_SOAK_HEALTH_ARTIFACT_MEMBERS,
        label:
          `deep Production Health run ${runId} attempt ${attempt} artifact`
      });
      const healthBytes = downloaded.members.get("production-health.json");
      return {
        archiveBytes: downloaded.archiveBytes,
        healthBytes
      };
    }
  });
  collectionControl.assertActive("artifact-download phase completion");
  for (const {
    archiveBytes,
    healthBytes,
    identity,
    runId,
    attempt
  } of downloadResults) {
    const scratch = new Map([
      [
        `raw/runs/${runId}/artifacts/${identity.id}.zip`,
        archiveBytes
      ],
      [
        `samples/${runId}-${String(attempt).padStart(3, "0")}/production-health.json`,
        healthBytes
      ]
    ]);
    mergeDurableSoakMembers(members, scratch);
  }

  const restart = await collectRestart({
    runId: options.restartRunId,
    runAttempt: options.restartRunAttempt,
    artifactId: options.restartArtifactId,
    request
  });
  collectionControl.assertActive("restart phase completion");
  requireValue(
    requestBudget.used === projectedRequests,
    `durable soak used ${requestBudget.used} REST calls but projected ${projectedRequests}`
  );
  collectionControl.assertActive("ledger derivation");
  const ledger = deriveDurableSoakLedger({
    members,
    query: {
      startedAt: options.startedAt,
      endedAt: options.endedAt
    },
    restart,
    recordedAt: new Date().toISOString(),
    artifactZipInspector:
      extractHostedEvidenceArtifactZipMembers
  });
  members.set(
    DURABLE_SOAK_LEDGER_FILE,
    Buffer.from(canonicalDurableSoakText(ledger), "utf8")
  );
  const manifest = buildDurableSoakSourceDigestManifest(members);
  members.set(
    DURABLE_SOAK_SOURCE_DIGESTS_FILE,
    Buffer.from(canonicalDurableSoakText(manifest), "utf8")
  );
  const verified = verifyDurableSoakLedgerMembers(members, {
    expectedRestart: restart,
    artifactZipInspector:
      extractHostedEvidenceArtifactZipMembers
  });
  collectionControl.assertActive("verified output preparation");
  const totalBytes = [...members.values()].reduce(
    (total, bytes) => total + bytes.byteLength,
    0
  );
  requireValue(
    totalBytes > 0 && totalBytes <= DURABLE_SOAK_OUTPUT_LIMIT_BYTES,
    `durable soak aggregate exceeds ${DURABLE_SOAK_OUTPUT_LIMIT_BYTES} retained bytes`
  );
  createDurableSoakOutputDirectoryWithinDeadline(
    options.outputDirectory,
    collectionControl
  );
  for (const [relative, content] of members) {
    const output = path.join(
      options.outputDirectory,
      ...relative.split("/")
    );
    mkdirSync(path.dirname(output), {
      recursive: true,
      mode: 0o700
    });
    writeFileSync(output, content, {
      flag: "wx",
      mode: 0o600
    });
  }
  const githubOutput = process.env.GITHUB_OUTPUT?.trim();
  if (githubOutput) {
    writeFileSync(
      githubOutput,
      [
        `sample_count=${verified.sampleCount}`,
        `observed_seconds=${verified.observedSeconds}`,
        `target_achieved=${verified.targetAchieved}`,
        `deployment_commit=${verified.deploymentCommit}`,
        `ledger_sha256=${verified.ledgerSha256}`,
        `window_started_at=${verified.ledger.window.startedAt}`,
        `window_ended_at=${verified.ledger.window.endedAt}`,
        `restart_observed_at=${verified.ledger.restart.restartObservedAt}`,
        `rest_request_count=${requestBudget.used}`,
        `rest_request_cap=${requestBudget.maximum}`,
        `network_timeout_slots=${projectedNetworkTimeoutSlots}`,
        `network_timeout_slot_cap=${DURABLE_SOAK_MAXIMUM_NETWORK_TIMEOUT_SLOTS}`,
        `collection_deadline_minutes=${DURABLE_SOAK_COLLECTION_DEADLINE_MINUTES}`,
        `max_concurrent_requests=${DURABLE_SOAK_MAX_CONCURRENT_REQUESTS}`
      ].join("\n") + "\n",
      { flag: "a", encoding: "utf8" }
    );
  }
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      sampleCount: verified.sampleCount,
      observedSeconds: verified.observedSeconds,
      targetAchieved: verified.targetAchieved,
      deploymentCommit: verified.deploymentCommit,
      ledgerSha256: verified.ledgerSha256,
      retainedBytes: totalBytes,
      restRequestCount: requestBudget.used,
      restRequestCap: requestBudget.maximum,
      networkTimeoutSlots: projectedNetworkTimeoutSlots,
      networkTimeoutSlotCap:
        DURABLE_SOAK_MAXIMUM_NETWORK_TIMEOUT_SLOTS,
      collectionDeadlineMinutes:
        DURABLE_SOAK_COLLECTION_DEADLINE_MINUTES,
      maxConcurrentRequests:
        DURABLE_SOAK_MAX_CONCURRENT_REQUESTS
    })}\n`
  );
}

function parseOptions(args) {
  const values = new Map();
  if (args.length === 0 || args.length % 2 !== 0) {
    throw new Error(usage());
  }
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (
      !key?.startsWith("--") ||
      !value ||
      value.startsWith("--") ||
      values.has(key)
    ) {
      throw new Error(usage());
    }
    values.set(key, value);
  }
  const expected = [
    "--start-at",
    "--end-at",
    "--restart-run-id",
    "--restart-run-attempt",
    "--restart-artifact-id",
    "--output"
  ];
  requireValue(
    JSON.stringify([...values.keys()].sort()) ===
      JSON.stringify(expected.sort()),
    usage()
  );
  const outputDirectory = path.resolve(values.get("--output"));
  requireValue(
    path.isAbsolute(values.get("--output")),
    "--output must be absolute"
  );
  return {
    startedAt: canonicalInstant(
      values.get("--start-at"),
      "--start-at"
    ),
    endedAt: canonicalInstant(
      values.get("--end-at"),
      "--end-at"
    ),
    restartRunId: positiveInteger(
      values.get("--restart-run-id"),
      "--restart-run-id"
    ),
    restartRunAttempt: positiveInteger(
      values.get("--restart-run-attempt"),
      "--restart-run-attempt",
      20
    ),
    restartArtifactId: positiveInteger(
      values.get("--restart-artifact-id"),
      "--restart-artifact-id"
    ),
    outputDirectory
  };
}

function requiredEnvironment(name) {
  const value = process.env[name]?.trim() ?? "";
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function usage() {
  return [
    "Usage: durable-soak-ledger.mjs",
    "  --start-at YYYY-MM-DDTHH:mm:ss.sssZ",
    "  --end-at YYYY-MM-DDTHH:mm:ss.sssZ",
    "  --restart-run-id ID",
    "  --restart-run-attempt N",
    "  --restart-artifact-id ID",
    "  --output ABSOLUTE_DIRECTORY"
  ].join(" ");
}

const invokedPath = process.argv[1]
  ? path.resolve(process.argv[1])
  : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  await collect(parseOptions(process.argv.slice(2)));
}

export { collect, parseOptions };
