import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";

export const DURABLE_SOAK_LEDGER_SCHEMA_VERSION = 1;
export const DURABLE_SOAK_LEDGER_KIND =
  "site-behavior-durable-soak-health-ledger";
export const DURABLE_SOAK_SOURCE_DIGESTS_KIND =
  "site-behavior-durable-soak-source-digests";
export const DURABLE_SOAK_LEDGER_FILE = "ledger.json";
export const DURABLE_SOAK_SOURCE_DIGESTS_FILE =
  "source-digests.json";
export const DURABLE_SOAK_MINIMUM_HOURS = 24;
export const DURABLE_SOAK_TARGET_HOURS = 168;
export const DURABLE_SOAK_MAXIMUM_GAP_MINUTES = 90;
export const DURABLE_SOAK_MAXIMUM_WINDOW_HOURS = 192;
export const DURABLE_SOAK_MAXIMUM_SAMPLES = 200;
export const DURABLE_SOAK_DEEP_RUN_NAME =
  "production-health/deep-hourly-v1";
export const DURABLE_SOAK_SHALLOW_RUN_NAME =
  "production-health/shallow-quarter-hour-v1";

export const DURABLE_SOAK_HEALTH_WORKFLOW =
  ".github/workflows/production-health.yml";
export const DURABLE_SOAK_RESTART_WORKFLOW =
  ".github/workflows/durable-soak-restart.yml";
export const DURABLE_SOAK_HEALTH_JOB =
  "Verify scanner health and posture";
export const DURABLE_SOAK_MARKER_STEP =
  "Mark hourly deep-health sample";
export const DURABLE_SOAK_REQUIRED_STEPS = Object.freeze([
  DURABLE_SOAK_MARKER_STEP,
  "Validate availability and production posture",
  "Preserve exact production-health evidence",
  "Run production scan, R2 readback, and report-page synthetic",
  "Run isolated production R2 write/read/delete canary"
]);
export const DURABLE_SOAK_HEALTH_ARTIFACT_MEMBERS = Object.freeze([
  "production-health.json",
  "production-pages-deployment.json",
  "production-public-ingress.json",
  "production-scan-report-schema.json"
]);

const FULL_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const CANONICAL_INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ACTIONS_INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const WORKFLOW_PAGE =
  /^raw\/workflow-runs-page-([0-9]{3})\.json$/;
const JOB_PAGE =
  /^raw\/runs\/([1-9][0-9]*)\/attempt-([0-9]{3})-jobs-page-([0-9]{3})\.json$/;
const ARTIFACT_PAGE =
  /^raw\/runs\/([1-9][0-9]*)\/artifacts-page-([0-9]{3})\.json$/;
const ARTIFACT_ARCHIVE =
  /^raw\/runs\/([1-9][0-9]*)\/artifacts\/([1-9][0-9]*)\.zip$/;
const HEALTH_SAMPLE =
  /^samples\/([1-9][0-9]*)-([0-9]{3})\/production-health\.json$/;

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

function exactKeys(value, expected, label) {
  requireValue(isRecord(value), `${label} must be an object`);
  requireValue(
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify([...expected].sort()),
    `${label} must contain exactly: ${[...expected].sort().join(", ")}`
  );
}

function canonicalValue(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalValue(entry));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalValue(value[key])])
    );
  }
  requireValue(
    value === null ||
      typeof value === "string" ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value)),
    "durable-soak canonical JSON accepts JSON values only"
  );
  return value;
}

export function canonicalDurableSoakText(value) {
  return `${JSON.stringify(canonicalValue(value), null, 2)}\n`;
}

export function sha256DurableSoak(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function fatalUtf8(bytes, label) {
  try {
    return new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true
    }).decode(bytes);
  } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }
}

function jsonObject(bytes, label, canonical = false) {
  const text = fatalUtf8(bytes, label);
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
  requireValue(isRecord(value), `${label} must contain a JSON object`);
  if (canonical) {
    requireValue(
      text === canonicalDurableSoakText(value),
      `${label} is not canonical sorted two-space JSON with one trailing newline`
    );
  }
  return value;
}

function positiveInteger(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  requireValue(
    Number.isSafeInteger(value) && value > 0 && value <= maximum,
    `${label} must be a positive safe integer`
  );
  return value;
}

function fullSha(value, label) {
  requireValue(
    typeof value === "string" && FULL_SHA.test(value),
    `${label} must be a full lowercase Git commit`
  );
  return value;
}

function digest(value, label) {
  const normalized =
    typeof value === "string"
      ? value.replace(/^sha256:/, "")
      : "";
  requireValue(
    SHA256.test(normalized),
    `${label} must be a lowercase sha256 digest`
  );
  return normalized;
}

function canonicalInstant(value, label) {
  requireValue(
    typeof value === "string" &&
      CANONICAL_INSTANT.test(value) &&
      Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString() === value,
    `${label} must be a canonical millisecond UTC instant`
  );
  return value;
}

function actionsInstant(value, label) {
  requireValue(
    typeof value === "string" &&
      ACTIONS_INSTANT.test(value) &&
      Number.isFinite(Date.parse(value)),
    `${label} must be an Actions UTC instant`
  );
  return new Date(value).toISOString();
}

function pageFiles(members, pattern, label, filter = () => true) {
  const matches = [];
  for (const file of members.keys()) {
    const match = pattern.exec(file);
    if (match && filter(match)) {
      matches.push({ file, match, page: Number(match.at(-1)) });
    }
  }
  matches.sort((left, right) => left.page - right.page);
  requireValue(matches.length > 0, `${label} must retain at least one page`);
  for (const [index, entry] of matches.entries()) {
    requireValue(
      entry.page === index + 1,
      `${label} page numbers must be contiguous from 001`
    );
  }
  return matches;
}

function flattenedPages(members, pages, collectionKey, label, used) {
  const values = [];
  let total = null;
  for (const [index, page] of pages.entries()) {
    used.add(page.file);
    const value = jsonObject(
      members.get(page.file),
      `${label} page ${index + 1}`
    );
    requireValue(
      Number.isSafeInteger(value.total_count) &&
        value.total_count >= 0 &&
        Array.isArray(value[collectionKey]) &&
        value[collectionKey].length <= 100,
      `${label} page ${index + 1} is not a bounded GitHub response`
    );
    if (total === null) total = value.total_count;
    requireValue(
      value.total_count === total,
      `${label} pages disagree on total_count`
    );
    values.push(...value[collectionKey]);
  }
  requireValue(
    values.length === total,
    `${label} pages are not set-complete`
  );
  return values;
}

function requiredSuccessfulStep(job, name, label) {
  const matches = job.steps.filter((step) => step?.name === name);
  requireValue(
    matches.length === 1 &&
      matches[0].status === "completed" &&
      matches[0].conclusion === "success",
    `${label} must execute one successful completed step named ${name}`
  );
  return {
    name,
    number: positiveInteger(
      matches[0].number,
      `${label} step ${name} number`,
      200
    ),
    startedAt: actionsInstant(
      matches[0].started_at,
      `${label} step ${name} started_at`
    ),
    completedAt: actionsInstant(
      matches[0].completed_at,
      `${label} step ${name} completed_at`
    )
  };
}

function artifactIdentity(value, runId, headSha, label) {
  requireValue(isRecord(value), `${label} must be an object`);
  const sha256 = digest(value.digest, `${label} digest`);
  requireValue(
    positiveInteger(value.id, `${label} id`) &&
      typeof value.name === "string" &&
      value.name.length <= 255 &&
      value.expired === false &&
      Number.isSafeInteger(value.size_in_bytes) &&
      value.size_in_bytes > 0 &&
      value.workflow_run?.id === runId &&
      value.workflow_run?.head_sha === headSha,
    `${label} does not bind the exact unexpired workflow artifact`
  );
  return {
    id: value.id,
    name: value.name,
    sha256,
    sizeBytes: value.size_in_bytes
  };
}

function sampleArtifactPages(members, runId, used) {
  const pages = pageFiles(
    members,
    ARTIFACT_PAGE,
    `run ${runId} artifact pages`,
    (match) => Number(match[1]) === runId
  );
  return flattenedPages(
    members,
    pages,
    "artifacts",
    `run ${runId} artifacts`,
    used
  );
}

function healthIdentity(bytes, label, expectedDeployment) {
  const health = jsonObject(bytes, label);
  requireValue(
    health.deployment === expectedDeployment &&
      health.status === "ok" &&
      health.ok === true &&
      health.scansAvailable === true &&
      Array.isArray(health.warnings) &&
      health.warnings.length === 0 &&
      health.checks?.durableJobs?.requested === true &&
      health.checks?.durableJobs?.enabled === true &&
      health.checks?.durableJobs?.readiness === "ready",
    `${label} is not a clean durable-enabled production-health response for ${expectedDeployment}`
  );
  canonicalInstant(health.timestamp, `${label} timestamp`);
  return {
    deploymentCommit: health.deployment,
    durableJobs: {
      requested: true,
      enabled: true,
      readiness: "ready"
    },
    healthTimestamp: health.timestamp
  };
}

function deriveSamples(members, query, used, artifactZipInspector) {
  requireValue(
    typeof artifactZipInspector === "function",
    "durable soak verification requires the reviewed artifact ZIP inspector"
  );
  const workflowPages = pageFiles(
    members,
    WORKFLOW_PAGE,
    "workflow-run query pages"
  );
  const runs = flattenedPages(
    members,
    workflowPages,
    "workflow_runs",
    "workflow runs",
    used
  );
  requireValue(
    runs.length > 0 && runs.length <= 1_000,
    "workflow-run query must retain 1..1000 delivered runs"
  );
  const runIds = new Set();
  const samples = [];
  for (const [runIndex, listed] of runs.entries()) {
    requireValue(
      isRecord(listed) &&
        Number.isSafeInteger(listed.id) &&
        listed.id > 0 &&
        !runIds.has(listed.id),
      `workflow run ${runIndex + 1} has an invalid or duplicate id`
    );
    runIds.add(listed.id);
    const runId = listed.id;
    const currentAttempt = positiveInteger(
      listed.run_attempt,
      `workflow run ${runId} current attempt`,
      20
    );
    requireValue(
      listed.path === DURABLE_SOAK_HEALTH_WORKFLOW &&
        listed.event === "schedule" &&
        listed.head_branch === "main" &&
        listed.repository?.full_name ===
          "iAnonymous3000/site-behavior-lab" &&
        FULL_SHA.test(listed.head_sha) &&
        (
          listed.display_title === DURABLE_SOAK_DEEP_RUN_NAME ||
          listed.display_title === DURABLE_SOAK_SHALLOW_RUN_NAME
        ) &&
        Date.parse(actionsInstant(
          listed.created_at,
          `workflow run ${runId} created_at`
        )) >= Date.parse(query.startedAt) &&
        Date.parse(listed.created_at) <= Date.parse(query.endedAt),
      `workflow run ${runId} is outside the exact scheduled production-health query`
    );

    if (listed.display_title === DURABLE_SOAK_SHALLOW_RUN_NAME) {
      continue;
    }
    requireValue(
      listed.status === "completed" &&
        listed.conclusion === "success",
      `delivered deep Production Health run ${runId} did not complete successfully`
    );

    let artifacts = null;
    for (let attempt = 1; attempt <= currentAttempt; attempt += 1) {
      const attemptWire = String(attempt).padStart(3, "0");
      const jobPages = pageFiles(
        members,
        JOB_PAGE,
        `workflow run ${runId} attempt ${attempt} job pages`,
        (match) =>
          Number(match[1]) === runId &&
          Number(match[2]) === attempt
      );
      const jobs = flattenedPages(
        members,
        jobPages,
        "jobs",
        `workflow run ${runId} attempt ${attempt} jobs`,
        used
      );
      const healthJobs = jobs.filter(
        (job) => job?.name === DURABLE_SOAK_HEALTH_JOB
      );
      requireValue(
        healthJobs.length === 1 && Array.isArray(healthJobs[0].steps),
        `workflow run ${runId} attempt ${attempt} must retain the exact health job and steps`
      );
      const job = healthJobs[0];
      requireValue(
        job.run_id === runId &&
          job.run_attempt === attempt &&
          job.head_sha === listed.head_sha &&
          job.status === "completed" &&
          job.conclusion === "success",
        `delivered deep Production Health run ${runId} attempt ${attempt} has inconsistent identity or did not complete successfully`
      );
      const steps = DURABLE_SOAK_REQUIRED_STEPS.map((name) =>
        requiredSuccessfulStep(
          job,
          name,
          `workflow run ${runId} attempt ${attempt}`
        )
      );
      if (artifacts === null) {
        artifacts = sampleArtifactPages(members, runId, used);
      }
      const expectedName =
        `site-behavior-production-health-evidence-${runId}-${attempt}`;
      const matches = artifacts.filter(
        (artifact) => artifact?.name === expectedName
      );
      requireValue(
        matches.length === 1,
        `deep Production Health run ${runId} attempt ${attempt} must have one exact evidence artifact`
      );
      const artifact = artifactIdentity(
        matches[0],
        runId,
        listed.head_sha,
        `deep Production Health run ${runId} attempt ${attempt} artifact`
      );
      const healthFile =
        `samples/${runId}-${attemptWire}/production-health.json`;
      requireValue(
        members.has(healthFile),
        `deep Production Health run ${runId} attempt ${attempt} health bytes are missing`
      );
      used.add(healthFile);
      const healthBytes = members.get(healthFile);
      const archiveFile =
        `raw/runs/${runId}/artifacts/${artifact.id}.zip`;
      requireValue(
        members.has(archiveFile),
        `deep Production Health artifact ${artifact.id} raw ZIP is missing`
      );
      used.add(archiveFile);
      const archiveBytes = members.get(archiveFile);
      requireValue(
        archiveBytes.byteLength === artifact.sizeBytes &&
          sha256DurableSoak(archiveBytes) === artifact.sha256,
        `deep Production Health artifact ${artifact.id} raw ZIP does not match GitHub metadata`
      );
      const extracted = artifactZipInspector(
        archiveBytes,
        DURABLE_SOAK_HEALTH_ARTIFACT_MEMBERS,
        "exact"
      );
      const extractedHealth = extracted.filter(
        (member) => member?.path === "production-health.json"
      );
      requireValue(
        extractedHealth.length === 1 &&
          Buffer.isBuffer(extractedHealth[0].bytes) &&
          extractedHealth[0].bytes.equals(healthBytes),
        `deep Production Health artifact ${artifact.id} copied health bytes do not equal its strict ZIP member`
      );
      const health = healthIdentity(
        healthBytes,
        `deep Production Health run ${runId} attempt ${attempt}`,
        listed.head_sha
      );
      const jobStartedAt = actionsInstant(
        job.started_at,
        `deep Production Health job ${runId}/${attempt} started_at`
      );
      const jobCompletedAt = actionsInstant(
        job.completed_at,
        `deep Production Health job ${runId}/${attempt} completed_at`
      );
      requireValue(
        Date.parse(health.healthTimestamp) >=
          Date.parse(jobStartedAt) - 60_000 &&
          Date.parse(health.healthTimestamp) <=
            Date.parse(jobCompletedAt),
        `deep Production Health run ${runId} attempt ${attempt} health timestamp is outside its authenticated job`
      );
      samples.push({
        runId,
        runAttempt: attempt,
        headSha: listed.head_sha,
        workflowPath: DURABLE_SOAK_HEALTH_WORKFLOW,
        event: "schedule",
        runStartedAt: jobStartedAt,
        completedAt: jobCompletedAt,
        job: {
          id: positiveInteger(
            job.id,
            `deep Production Health job ${runId}/${attempt} id`
          ),
          name: DURABLE_SOAK_HEALTH_JOB,
          startedAt: jobStartedAt,
          completedAt: jobCompletedAt
        },
        artifact: {
          ...artifact,
          healthSha256: sha256DurableSoak(healthBytes)
        },
        deploymentCommit: health.deploymentCommit,
        durableJobs: health.durableJobs,
        healthTimestamp: health.healthTimestamp,
        requiredSteps: steps
      });
    }
  }
  samples.sort(
    (left, right) =>
      Date.parse(left.runStartedAt) - Date.parse(right.runStartedAt) ||
      left.runId - right.runId ||
      left.runAttempt - right.runAttempt
  );
  requireValue(
    samples.length > 0 &&
      samples.length <= DURABLE_SOAK_MAXIMUM_SAMPLES,
    `durable soak must retain 1..${DURABLE_SOAK_MAXIMUM_SAMPLES} deep samples`
  );
  return samples;
}

function normalizeRestart(restart) {
  exactKeys(
    restart,
    [
      "workflowPath",
      "runId",
      "runAttempt",
      "headSha",
      "startedAt",
      "completedAt",
      "restartObservedAt",
      "artifact",
      "recoverySha256"
    ],
    "durable soak restart"
  );
  exactKeys(
    restart.artifact,
    ["id", "name", "sha256"],
    "durable soak restart artifact"
  );
  requireValue(
    restart.workflowPath === DURABLE_SOAK_RESTART_WORKFLOW,
    "durable soak restart must use the dedicated restart workflow"
  );
  const runId = positiveInteger(
    restart.runId,
    "durable soak restart run id"
  );
  const runAttempt = positiveInteger(
    restart.runAttempt,
    "durable soak restart run attempt",
    20
  );
  requireValue(
    restart.artifact.name ===
      `site-behavior-durable-soak-restart-evidence-${runId}-${runAttempt}`,
    "durable soak restart artifact name does not bind its run and attempt"
  );
  return {
    workflowPath: restart.workflowPath,
    runId,
    runAttempt,
    headSha: fullSha(restart.headSha, "durable soak restart head SHA"),
    startedAt: canonicalInstant(
      restart.startedAt,
      "durable soak restart startedAt"
    ),
    completedAt: canonicalInstant(
      restart.completedAt,
      "durable soak restart completedAt"
    ),
    restartObservedAt: canonicalInstant(
      restart.restartObservedAt,
      "durable soak restart restartObservedAt"
    ),
    artifact: {
      id: positiveInteger(
        restart.artifact.id,
        "durable soak restart artifact id"
      ),
      name: restart.artifact.name,
      sha256: digest(
        restart.artifact.sha256,
        "durable soak restart artifact digest"
      )
    },
    recoverySha256: digest(
      restart.recoverySha256,
      "durable soak restart recovery digest"
    )
  };
}

function verifyPolicyAndWindow(ledger, samples, restart) {
  exactKeys(
    ledger.policy,
    [
      "minimumHours",
      "targetHours",
      "maximumGapMinutes",
      "maximumWindowHours"
    ],
    "durable soak policy"
  );
  requireValue(
    ledger.policy.minimumHours === DURABLE_SOAK_MINIMUM_HOURS &&
      ledger.policy.targetHours === DURABLE_SOAK_TARGET_HOURS &&
      ledger.policy.maximumGapMinutes ===
        DURABLE_SOAK_MAXIMUM_GAP_MINUTES &&
      ledger.policy.maximumWindowHours ===
        DURABLE_SOAK_MAXIMUM_WINDOW_HOURS,
    "durable soak policy constants do not match the reviewed release policy"
  );
  exactKeys(
    ledger.query,
    ["workflowPath", "event", "startedAt", "endedAt"],
    "durable soak query"
  );
  requireValue(
    ledger.query.workflowPath === DURABLE_SOAK_HEALTH_WORKFLOW &&
      ledger.query.event === "schedule",
    "durable soak query must select scheduled Production Health"
  );
  const queryStartedAt = canonicalInstant(
    ledger.query.startedAt,
    "durable soak query startedAt"
  );
  const queryEndedAt = canonicalInstant(
    ledger.query.endedAt,
    "durable soak query endedAt"
  );
  const queryDuration =
    Date.parse(queryEndedAt) - Date.parse(queryStartedAt);
  requireValue(
    queryDuration >= DURABLE_SOAK_MINIMUM_HOURS * 3_600_000 &&
      queryDuration <= DURABLE_SOAK_MAXIMUM_WINDOW_HOURS * 3_600_000,
    "durable soak query must span 24 hours through the bounded 8-day maximum"
  );
  requireValue(
    Date.parse(canonicalInstant(
      ledger.recordedAt,
      "durable soak recordedAt"
    )) >= Date.parse(queryEndedAt),
    "durable soak recordedAt must not predate the completed query window"
  );
  exactKeys(
    ledger.window,
    [
      "startedAt",
      "endedAt",
      "observedSeconds",
      "targetAchieved"
    ],
    "durable soak observed window"
  );
  const first = samples[0];
  const last = samples.at(-1);
  const startedAt = first.runStartedAt;
  const endedAt = last.completedAt;
  const observedMilliseconds =
    Date.parse(endedAt) - Date.parse(startedAt);
  const observedSeconds = observedMilliseconds / 1000;
  requireValue(
    Number.isSafeInteger(observedSeconds) &&
      observedSeconds >= DURABLE_SOAK_MINIMUM_HOURS * 3_600 &&
      ledger.window.startedAt === startedAt &&
      ledger.window.endedAt === endedAt &&
      ledger.window.observedSeconds === observedSeconds &&
      ledger.window.targetAchieved ===
        (observedSeconds >= DURABLE_SOAK_TARGET_HOURS * 3_600),
    "durable soak observed window is not derived from its authenticated samples"
  );
  const maximumGap =
    DURABLE_SOAK_MAXIMUM_GAP_MINUTES * 60_000;
  requireValue(
    Date.parse(first.runStartedAt) >= Date.parse(queryStartedAt) &&
      Date.parse(first.runStartedAt) - Date.parse(queryStartedAt) <=
        maximumGap &&
      Date.parse(last.completedAt) <= Date.parse(queryEndedAt) &&
      Date.parse(queryEndedAt) - Date.parse(last.completedAt) <=
        maximumGap,
    "durable soak query boundaries have a material uncovered gap"
  );
  for (let index = 1; index < samples.length; index += 1) {
    const gap =
      Date.parse(samples[index].runStartedAt) -
      Date.parse(samples[index - 1].runStartedAt);
    requireValue(
      gap > 0 && gap <= maximumGap,
      `durable soak has a material gap before sample ${index + 1}`
    );
  }
  requireValue(
    restart.headSha === ledger.deploymentCommit &&
      Date.parse(restart.startedAt) >= Date.parse(startedAt) &&
      Date.parse(restart.completedAt) <= Date.parse(endedAt) &&
      Date.parse(restart.restartObservedAt) >=
        Date.parse(restart.startedAt) &&
      Date.parse(restart.restartObservedAt) <=
        Date.parse(restart.completedAt),
    "durable restart is not fully contained in the authenticated soak window"
  );
}

function verifySourceManifest(members) {
  requireValue(
    members instanceof Map,
    "durable soak artifact members must be a Map"
  );
  const manifestBytes = members.get(DURABLE_SOAK_SOURCE_DIGESTS_FILE);
  requireValue(
    Buffer.isBuffer(manifestBytes),
    "durable soak source-digests.json is missing"
  );
  const manifest = jsonObject(
    manifestBytes,
    "durable soak source digests",
    true
  );
  exactKeys(
    manifest,
    ["schemaVersion", "artifactKind", "files"],
    "durable soak source digests"
  );
  requireValue(
    manifest.schemaVersion === DURABLE_SOAK_LEDGER_SCHEMA_VERSION &&
      manifest.artifactKind === DURABLE_SOAK_SOURCE_DIGESTS_KIND &&
      Array.isArray(manifest.files) &&
      manifest.files.length > 0 &&
      manifest.files.length <= 4_096,
    "durable soak source digests identity or file count is invalid"
  );
  const expectedPaths = [...members.keys()]
    .filter((file) => file !== DURABLE_SOAK_SOURCE_DIGESTS_FILE)
    .sort();
  let prior = "";
  const actualPaths = [];
  for (const [index, file] of manifest.files.entries()) {
    exactKeys(
      file,
      ["path", "sha256", "sizeBytes"],
      `durable soak source file ${index + 1}`
    );
    requireValue(
      typeof file.path === "string" &&
        file.path > prior &&
        members.has(file.path),
      "durable soak source digest paths must be unique, sorted, and retained"
    );
    prior = file.path;
    const bytes = members.get(file.path);
    requireValue(
      positiveInteger(
        file.sizeBytes,
        `durable soak source ${file.path} size`
      ) === bytes.byteLength &&
        digest(
          file.sha256,
          `durable soak source ${file.path} digest`
        ) === sha256DurableSoak(bytes),
      `durable soak source ${file.path} does not match its digest manifest`
    );
    actualPaths.push(file.path);
  }
  requireValue(
    JSON.stringify(actualPaths) === JSON.stringify(expectedPaths),
    "durable soak source digest manifest is not set-equal to the artifact"
  );
  return manifest;
}

function verifyNoUnusedRawMembers(members, used) {
  const unused = [...members.keys()].filter(
    (file) =>
      file !== DURABLE_SOAK_LEDGER_FILE &&
      file !== DURABLE_SOAK_SOURCE_DIGESTS_FILE &&
      !used.has(file)
  );
  requireValue(
    unused.length === 0,
    `durable soak artifact contains unconsumed source bytes: ${unused
      .slice(0, 3)
      .join(", ")}`
  );
}

export function buildDurableSoakSourceDigestManifest(members) {
  requireValue(
    members instanceof Map &&
      !members.has(DURABLE_SOAK_SOURCE_DIGESTS_FILE),
    "source manifest input must be a member Map without source-digests.json"
  );
  return {
    schemaVersion: DURABLE_SOAK_LEDGER_SCHEMA_VERSION,
    artifactKind: DURABLE_SOAK_SOURCE_DIGESTS_KIND,
    files: [...members.entries()]
      .map(([file, bytes]) => {
        requireValue(
          Buffer.isBuffer(bytes) && bytes.byteLength > 0,
          `source member ${file} must contain bytes`
        );
        return {
          path: file,
          sha256: sha256DurableSoak(bytes),
          sizeBytes: bytes.byteLength
        };
      })
      .sort((left, right) => left.path.localeCompare(right.path))
  };
}

export function deriveDurableSoakLedger({
  members,
  query,
  restart,
  recordedAt,
  artifactZipInspector
}) {
  const used = new Set();
  const normalizedQuery = {
    workflowPath: DURABLE_SOAK_HEALTH_WORKFLOW,
    event: "schedule",
    startedAt: canonicalInstant(
      query?.startedAt,
      "durable soak query startedAt"
    ),
    endedAt: canonicalInstant(
      query?.endedAt,
      "durable soak query endedAt"
    )
  };
  const samples = deriveSamples(
    members,
    normalizedQuery,
    used,
    artifactZipInspector
  );
  const deploymentCommit = samples[0].deploymentCommit;
  requireValue(
    samples.every(
      (sample) =>
        sample.deploymentCommit === deploymentCommit &&
        sample.headSha === deploymentCommit
    ),
    "durable soak samples do not share one exact deployment commit"
  );
  const normalizedRestart = normalizeRestart(restart);
  const first = samples[0];
  const last = samples.at(-1);
  const observedSeconds =
    (Date.parse(last.completedAt) - Date.parse(first.runStartedAt)) /
    1000;
  const ledger = {
    schemaVersion: DURABLE_SOAK_LEDGER_SCHEMA_VERSION,
    artifactKind: DURABLE_SOAK_LEDGER_KIND,
    recordedAt: canonicalInstant(
      recordedAt,
      "durable soak recordedAt"
    ),
    policy: {
      minimumHours: DURABLE_SOAK_MINIMUM_HOURS,
      targetHours: DURABLE_SOAK_TARGET_HOURS,
      maximumGapMinutes: DURABLE_SOAK_MAXIMUM_GAP_MINUTES,
      maximumWindowHours: DURABLE_SOAK_MAXIMUM_WINDOW_HOURS
    },
    query: normalizedQuery,
    window: {
      startedAt: first.runStartedAt,
      endedAt: last.completedAt,
      observedSeconds,
      targetAchieved:
        observedSeconds >= DURABLE_SOAK_TARGET_HOURS * 3_600
    },
    deploymentCommit,
    restart: normalizedRestart,
    samples
  };
  verifyPolicyAndWindow(ledger, samples, normalizedRestart);
  verifyNoUnusedRawMembers(members, used);
  return ledger;
}

export function verifyDurableSoakLedgerMembers(
  members,
  { expectedRestart, artifactZipInspector } = {}
) {
  verifySourceManifest(members);
  const ledgerBytes = members.get(DURABLE_SOAK_LEDGER_FILE);
  requireValue(
    Buffer.isBuffer(ledgerBytes),
    "durable soak ledger.json is missing"
  );
  const ledger = jsonObject(
    ledgerBytes,
    "durable soak ledger",
    true
  );
  exactKeys(
    ledger,
    [
      "schemaVersion",
      "artifactKind",
      "recordedAt",
      "policy",
      "query",
      "window",
      "deploymentCommit",
      "restart",
      "samples"
    ],
    "durable soak ledger"
  );
  requireValue(
    ledger.schemaVersion === DURABLE_SOAK_LEDGER_SCHEMA_VERSION &&
      ledger.artifactKind === DURABLE_SOAK_LEDGER_KIND &&
      Array.isArray(ledger.samples),
    "durable soak ledger identity is invalid"
  );
  canonicalInstant(ledger.recordedAt, "durable soak recordedAt");
  fullSha(
    ledger.deploymentCommit,
    "durable soak deployment commit"
  );
  const used = new Set();
  const derivedSamples = deriveSamples(
    members,
    ledger.query,
    used,
    artifactZipInspector
  );
  requireValue(
    canonicalDurableSoakText(derivedSamples) ===
      canonicalDurableSoakText(ledger.samples),
    "durable soak samples do not rederive from retained GitHub and health bytes"
  );
  requireValue(
    derivedSamples.every(
      (sample) =>
        sample.headSha === ledger.deploymentCommit &&
        sample.deploymentCommit === ledger.deploymentCommit
    ),
    "durable soak samples do not share the declared deployment"
  );
  const restart = normalizeRestart(ledger.restart);
  if (expectedRestart !== undefined) {
    requireValue(
      canonicalDurableSoakText(restart) ===
        canonicalDurableSoakText(normalizeRestart(expectedRestart)),
      "durable soak ledger restart does not match the authenticated restart source"
    );
  }
  verifyPolicyAndWindow(ledger, derivedSamples, restart);
  verifyNoUnusedRawMembers(members, used);
  return {
    ledger,
    ledgerSha256: sha256DurableSoak(ledgerBytes),
    deploymentCommit: ledger.deploymentCommit,
    sampleCount: derivedSamples.length,
    observedSeconds: ledger.window.observedSeconds,
    targetAchieved: ledger.window.targetAchieved
  };
}

export function durableSoakAggregateMemberNameAllowed(name) {
  return (
    name === DURABLE_SOAK_LEDGER_FILE ||
    name === DURABLE_SOAK_SOURCE_DIGESTS_FILE ||
    WORKFLOW_PAGE.test(name) ||
    JOB_PAGE.test(name) ||
    ARTIFACT_PAGE.test(name) ||
    ARTIFACT_ARCHIVE.test(name) ||
    HEALTH_SAMPLE.test(name)
  );
}
