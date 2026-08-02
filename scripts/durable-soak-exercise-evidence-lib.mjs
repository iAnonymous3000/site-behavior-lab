import {
  exactKeys,
  parseCanonicalEvidence,
  requireCanonicalInstant,
  requireCommit,
  requireSha256,
  serializeCanonicalEvidence,
  sha256Bytes
} from "./operator-evidence-common.mjs";
import { parseStrictJson } from "../lib/strict-json.ts";

export const DURABLE_SOAK_EXERCISE_SCHEMA_VERSION = 1;
export const DURABLE_SOAK_EXERCISE_KIND =
  "site-behavior-durable-soak-exercise-evidence";
export const DURABLE_SOAK_EXERCISE_FILE = "exercise-evidence.json";
export const DURABLE_SOAK_EXERCISE_HEALTH_FILE = "production-health.json";
export const DURABLE_SOAK_EXERCISE_POST_HEALTH_FILE =
  "post-production-health.json";
export const DURABLE_SOAK_EXERCISE_MAX_FILE_BYTES = 1024 * 1024;
export const DURABLE_SOAK_EXERCISE_MAX_SESSION_MS = 30 * 60 * 1000;
export const DURABLE_SOAK_EXERCISE_CONFIG_PATH =
  "wrangler.container.jsonc";
export const DURABLE_SOAK_EXERCISE_BEHAVIOR_IDS = Object.freeze([
  "normal-completion",
  "cancellation",
  "completed-report-recovery",
  "duplicate-prevention"
]);

const REPORT_ID = /^[0-9]{8}-[0-9a-f]{32}$/;
const ROOT_KEYS = [
  "schemaVersion",
  "artifactKind",
  "sourceCommit",
  "deploymentCommit",
  "durableConfig",
  "health",
  "postHealth",
  "session",
  "behaviors"
];
const FILE_BINDING_KEYS = ["path", "sha256"];
const HEALTH_KEYS = ["observedAt", "sha256"];
const SESSION_KEYS = ["startedAt", "completedAt"];
const NORMAL_KEYS = [
  "id",
  "observedAt",
  "jobId",
  "reportId",
  "reportSha256"
];
const CANCELLATION_KEYS = [
  "id",
  "observedAt",
  "jobId",
  "reportId",
  "status",
  "responseSha256"
];
const RECOVERY_KEYS = NORMAL_KEYS;
const DUPLICATE_KEYS = [
  "id",
  "observedAt",
  "jobId",
  "reportId",
  "firstStatus",
  "replayStatus",
  "requestCommitmentSha256"
];

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function exact(value, keys, label) {
  const problems = [];
  if (!exactKeys(value, keys, label, problems)) {
    throw new Error(problems.join("; "));
  }
}

function canonicalInstant(value, label) {
  const problems = [];
  const instant = requireCanonicalInstant(value, label, problems);
  if (instant === null || problems.length > 0) {
    throw new Error(problems.join("; "));
  }
  return instant;
}

function commit(value, label) {
  const problems = [];
  requireCommit(value, label, problems);
  if (problems.length > 0) throw new Error(problems.join("; "));
  return value;
}

function digest(value, label) {
  const problems = [];
  requireSha256(value, label, problems);
  if (problems.length > 0) throw new Error(problems.join("; "));
  return value;
}

function jobIdentity(value, label) {
  requireValue(
    typeof value.jobId === "string" &&
      REPORT_ID.test(value.jobId) &&
      typeof value.reportId === "string" &&
      REPORT_ID.test(value.reportId) &&
      value.jobId !== value.reportId,
    `${label} must bind distinct canonical job and report ids`
  );
}

function fileBinding(value, label, expectedPath) {
  exact(value, FILE_BINDING_KEYS, label);
  requireValue(
    value.path === expectedPath,
    `${label}.path must be exactly ${expectedPath}`
  );
  digest(value.sha256, `${label}.sha256`);
}

function behavior(value, index, id, keys) {
  const label = `durable soak behavior ${index + 1}`;
  exact(value, keys, label);
  requireValue(value.id === id, `${label}.id must be exactly ${id}`);
  const observedAt = canonicalInstant(
    value.observedAt,
    `${label}.observedAt`
  );
  jobIdentity(value, label);
  return observedAt;
}

export function verifyDurableSoakExerciseHealth(
  health,
  expectedDeploymentCommit
) {
  commit(
    expectedDeploymentCommit,
    "durable soak expected health deployment"
  );
  requireValue(
    health &&
      typeof health === "object" &&
      !Array.isArray(health) &&
      health.deployment === expectedDeploymentCommit &&
      health.status === "ok" &&
      Array.isArray(health.warnings) &&
      health.warnings.length === 0 &&
      health.checks?.durableJobs?.requested === true &&
      health.checks?.durableJobs?.enabled === true &&
      health.checks?.durableJobs?.readiness === "ready",
    "durable soak exercise health is not clean, durable-enabled, ready, and on the exact deployment"
  );
  return health;
}

export function parseDurableSoakExerciseEvidence(
  bytes,
  label = "durable soak exercise evidence"
) {
  requireValue(
    typeof bytes === "string" &&
      Buffer.byteLength(bytes, "utf8") > 0 &&
      Buffer.byteLength(bytes, "utf8") <=
        DURABLE_SOAK_EXERCISE_MAX_FILE_BYTES,
    `${label} must contain bounded UTF-8 bytes`
  );
  return parseCanonicalEvidence(bytes, label);
}

export function verifyDurableSoakExerciseEvidence(
  evidence,
  options = {}
) {
  exact(evidence, ROOT_KEYS, "durable soak exercise evidence");
  requireValue(
    evidence.schemaVersion === DURABLE_SOAK_EXERCISE_SCHEMA_VERSION &&
      evidence.artifactKind === DURABLE_SOAK_EXERCISE_KIND,
    "durable soak exercise evidence schema identity is invalid"
  );
  commit(evidence.sourceCommit, "durable soak exercise sourceCommit");
  commit(
    evidence.deploymentCommit,
    "durable soak exercise deploymentCommit"
  );
  requireValue(
    evidence.sourceCommit === evidence.deploymentCommit,
    "durable soak exercises must run from the exact durable deployment commit"
  );
  if (options.expectedSourceCommit !== undefined) {
    requireValue(
      evidence.sourceCommit === options.expectedSourceCommit,
      "durable soak exercise evidence does not bind the authenticated source commit"
    );
  }
  if (options.expectedDeploymentCommit !== undefined) {
    requireValue(
      evidence.deploymentCommit === options.expectedDeploymentCommit,
      "durable soak exercise evidence does not bind the expected deployment"
    );
  }

  fileBinding(
    evidence.durableConfig,
    "durable soak exercise durableConfig",
    DURABLE_SOAK_EXERCISE_CONFIG_PATH
  );
  if (options.expectedDurableConfigSha256 !== undefined) {
    requireValue(
      evidence.durableConfig.sha256 ===
        options.expectedDurableConfigSha256,
      "durable soak exercise evidence does not bind the candidate durable config"
    );
  }
  exact(evidence.health, HEALTH_KEYS, "durable soak exercise health");
  const healthObservedAt = canonicalInstant(
    evidence.health.observedAt,
    "durable soak exercise health.observedAt"
  );
  digest(evidence.health.sha256, "durable soak exercise health.sha256");
  if (options.healthBytes !== undefined) {
    requireValue(
      Buffer.isBuffer(options.healthBytes) &&
        options.healthBytes.byteLength > 0 &&
        options.healthBytes.byteLength <=
          DURABLE_SOAK_EXERCISE_MAX_FILE_BYTES &&
        sha256Bytes(options.healthBytes) === evidence.health.sha256,
      "durable soak exercise health digest does not match the retained health bytes"
    );
    let health;
    try {
      health = parseStrictJson(
        options.healthBytes.toString("utf8"),
        DURABLE_SOAK_EXERCISE_MAX_FILE_BYTES
      );
    } catch {
      throw new Error(
        "durable soak exercise retained health is not valid strict JSON"
      );
    }
    verifyDurableSoakExerciseHealth(
      health,
      evidence.deploymentCommit
    );
  }
  exact(
    evidence.postHealth,
    HEALTH_KEYS,
    "durable soak exercise postHealth"
  );
  const postHealthObservedAt = canonicalInstant(
    evidence.postHealth.observedAt,
    "durable soak exercise postHealth.observedAt"
  );
  digest(
    evidence.postHealth.sha256,
    "durable soak exercise postHealth.sha256"
  );
  if (options.postHealthBytes !== undefined) {
    requireValue(
      Buffer.isBuffer(options.postHealthBytes) &&
        options.postHealthBytes.byteLength > 0 &&
        options.postHealthBytes.byteLength <=
          DURABLE_SOAK_EXERCISE_MAX_FILE_BYTES &&
        sha256Bytes(options.postHealthBytes) ===
          evidence.postHealth.sha256,
      "durable soak exercise post-health digest does not match the retained post-health bytes"
    );
    let postHealth;
    try {
      postHealth = parseStrictJson(
        options.postHealthBytes.toString("utf8"),
        DURABLE_SOAK_EXERCISE_MAX_FILE_BYTES
      );
    } catch {
      throw new Error(
        "durable soak exercise retained post-health is not valid strict JSON"
      );
    }
    verifyDurableSoakExerciseHealth(
      postHealth,
      evidence.deploymentCommit
    );
  }

  exact(evidence.session, SESSION_KEYS, "durable soak exercise session");
  const startedAt = canonicalInstant(
    evidence.session.startedAt,
    "durable soak exercise session.startedAt"
  );
  const completedAt = canonicalInstant(
    evidence.session.completedAt,
    "durable soak exercise session.completedAt"
  );
  requireValue(
    completedAt > startedAt &&
      completedAt - startedAt <= DURABLE_SOAK_EXERCISE_MAX_SESSION_MS,
    "durable soak exercise session must be positive and no longer than 30 minutes"
  );
  requireValue(
    healthObservedAt >= startedAt && healthObservedAt <= completedAt,
    "durable soak exercise health observation must be inside the session"
  );

  requireValue(
    Array.isArray(evidence.behaviors) &&
      evidence.behaviors.length ===
        DURABLE_SOAK_EXERCISE_BEHAVIOR_IDS.length,
    "durable soak exercise evidence must contain exactly the four non-restart behaviors"
  );
  const normalAt = behavior(
    evidence.behaviors[0],
    0,
    DURABLE_SOAK_EXERCISE_BEHAVIOR_IDS[0],
    NORMAL_KEYS
  );
  digest(
    evidence.behaviors[0].reportSha256,
    "durable soak normal completion reportSha256"
  );
  const cancelledAt = behavior(
    evidence.behaviors[1],
    1,
    DURABLE_SOAK_EXERCISE_BEHAVIOR_IDS[1],
    CANCELLATION_KEYS
  );
  requireValue(
    evidence.behaviors[1].status === "cancelled",
    "durable soak cancellation must terminate as cancelled"
  );
  digest(
    evidence.behaviors[1].responseSha256,
    "durable soak cancellation responseSha256"
  );
  const recoveredAt = behavior(
    evidence.behaviors[2],
    2,
    DURABLE_SOAK_EXERCISE_BEHAVIOR_IDS[2],
    RECOVERY_KEYS
  );
  digest(
    evidence.behaviors[2].reportSha256,
    "durable soak completed-report recovery reportSha256"
  );
  const duplicateAt = behavior(
    evidence.behaviors[3],
    3,
    DURABLE_SOAK_EXERCISE_BEHAVIOR_IDS[3],
    DUPLICATE_KEYS
  );
  requireValue(
    evidence.behaviors[3].firstStatus === 202 &&
      evidence.behaviors[3].replayStatus === 202,
    "durable soak duplicate prevention must bind two accepted 202 admissions"
  );
  digest(
    evidence.behaviors[3].requestCommitmentSha256,
    "durable soak duplicate prevention requestCommitmentSha256"
  );

  const normal = evidence.behaviors[0];
  const cancellation = evidence.behaviors[1];
  const recovery = evidence.behaviors[2];
  const duplicate = evidence.behaviors[3];
  requireValue(
    normal.jobId === recovery.jobId &&
      normal.reportId === recovery.reportId &&
      normal.reportSha256 === recovery.reportSha256 &&
      normal.jobId === duplicate.jobId &&
      normal.reportId === duplicate.reportId,
    "normal completion, completed-report recovery, and duplicate prevention must bind one exact job/report identity"
  );
  requireValue(
    cancellation.jobId !== normal.jobId &&
      cancellation.reportId !== normal.reportId,
    "cancellation must bind a distinct admitted job/report identity"
  );
  requireValue(
    duplicateAt <= normalAt &&
      normalAt <= recoveredAt &&
      cancelledAt >= startedAt &&
      healthObservedAt <= duplicateAt &&
      postHealthObservedAt >= cancelledAt &&
      postHealthObservedAt <= completedAt,
    "durable soak behavior chronology is invalid"
  );
  for (const observedAt of [
    normalAt,
    cancelledAt,
    recoveredAt,
    duplicateAt
  ]) {
    requireValue(
      observedAt >= startedAt && observedAt <= completedAt,
      "every durable soak behavior observation must be inside the exercise session"
    );
  }
  if (options.window !== undefined) {
    const windowStartedAt = canonicalInstant(
      options.window.startedAt,
      "authenticated durable soak window.startedAt"
    );
    const windowEndedAt = canonicalInstant(
      options.window.endedAt,
      "authenticated durable soak window.endedAt"
    );
    requireValue(
      startedAt >= windowStartedAt && completedAt <= windowEndedAt,
      "durable soak exercise session is outside the authenticated soak window"
    );
  }

  return {
    sourceCommit: evidence.sourceCommit,
    deploymentCommit: evidence.deploymentCommit,
    durableConfigSha256: evidence.durableConfig.sha256,
    healthSha256: evidence.health.sha256,
    postHealthSha256: evidence.postHealth.sha256,
    startedAt: evidence.session.startedAt,
    completedAt: evidence.session.completedAt,
    behaviorIds: [...DURABLE_SOAK_EXERCISE_BEHAVIOR_IDS],
    evidenceSha256: sha256Bytes(serializeCanonicalEvidence(evidence))
  };
}

export function serializeDurableSoakExerciseEvidence(evidence) {
  verifyDurableSoakExerciseEvidence(evidence);
  return serializeCanonicalEvidence(evidence);
}
