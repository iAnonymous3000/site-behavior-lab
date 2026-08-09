// Build research/ops-receipts/durable-enable-transition.json from evidence,
// never from claims.
//
// The binding's transition verifier accepts a receipt only if it carries an
// exact ordered key set, canonical serialization, and a chronology in which
// every step precedes the next:
//
//   replay.evidenceCapturedAt <= secrets.checkedAt <= changeControl.mergedAt
//     <= ci.completedAt <= promotion.convergedAt
//     <= productionHealth.observedAt <= recordedAt
//
// A receipt is therefore trivially forgeable by hand, and the fields most worth
// forging are exactly the ones an operator would otherwise type: whether CI
// succeeded, whether promotion converged, whether production health was clean.
//
// So this module derives every one of those from authenticated GitHub Actions
// API responses and from committed bytes, and has no parameter through which a
// caller can assert a conclusion. `conclusion: "success"` is read off the run
// object; `warningCount` is the length of the health payload's own warnings
// array; the replay digest is recomputed from the committed receipt files.
// Where a value cannot be derived, this refuses rather than defaulting.
//
// The authentication boundary is deliberate: this module never holds a
// credential and performs no network call. A workflow step authenticates,
// captures the exact API responses, and hands them here. That keeps the
// derivation testable against an immutable transcript and keeps secrets out of
// the code that shapes the receipt.

import { createHash } from "node:crypto";

export const TRANSITION_RECEIPT_PATH =
  "research/ops-receipts/durable-enable-transition.json";
export const DURABLE_CONFIG_PATH = "wrangler.container.jsonc";
const REPOSITORY = "iAnonymous3000/site-behavior-lab";
const FULL_GIT_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;

const WORKFLOW_REFS = {
  ci: `${REPOSITORY}/.github/workflows/ci.yml@refs/heads/main`,
  promotion: `${REPOSITORY}/.github/workflows/promote-production.yml@refs/heads/main`,
  productionHealth: `${REPOSITORY}/.github/workflows/production-health.yml@refs/heads/main`
};

const WORKFLOW_PATHS = {
  ci: ".github/workflows/ci.yml",
  promotion: ".github/workflows/promote-production.yml",
  productionHealth: ".github/workflows/production-health.yml"
};

/** Bounded, canonical UTC instant, byte-identical on round trip. */
function canonicalInstant(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.length > 64) {
    throw new Error(`${label} must be a canonical UTC instant`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(`${label} must be a canonical UTC instant, got ${value}`);
  }
  return value;
}

function requireSha(value, label) {
  if (typeof value !== "string" || !FULL_GIT_SHA.test(value)) {
    throw new Error(`${label} must be a full 40-character lowercase commit sha`);
  }
  return value;
}

/** The Actions run endpoint for one attempt. Pure, so callers can be audited. */
export function actionsRunAttemptEndpoint(runId, runAttempt) {
  if (!/^[1-9][0-9]{0,19}$/.test(String(runId))) {
    throw new Error("run id must be a positive integer");
  }
  if (!Number.isSafeInteger(runAttempt) || runAttempt < 1 || runAttempt > 100) {
    throw new Error("run attempt must be between 1 and 100");
  }
  return `/repos/${REPOSITORY}/actions/runs/${runId}/attempts/${runAttempt}`;
}

/**
 * Derive one run's facts from its authenticated attempt response.
 *
 * Every field the receipt carries about a run comes from here, so a caller has
 * no way to assert a conclusion the API did not report.
 */
function runFacts(kind, response, { expectedHeadCommit }) {
  if (!response || typeof response !== "object") {
    throw new Error(`${kind} run response is missing`);
  }
  const path = response.path;
  if (path !== WORKFLOW_PATHS[kind]) {
    throw new Error(
      `${kind} run is ${String(path)}, not ${WORKFLOW_PATHS[kind]}; the receipt must bind the governed workflow`
    );
  }
  if (response.head_branch !== "main") {
    throw new Error(`${kind} run is on ${String(response.head_branch)}, not main`);
  }
  if (response.repository?.full_name !== REPOSITORY) {
    throw new Error(`${kind} run belongs to ${String(response.repository?.full_name)}, not ${REPOSITORY}`);
  }
  const headCommit = requireSha(response.head_sha, `${kind} run head_sha`);
  if (headCommit !== expectedHeadCommit) {
    throw new Error(
      `${kind} run ran against ${headCommit}, not the transition commit ${expectedHeadCommit}`
    );
  }
  if (response.status !== "completed") {
    throw new Error(`${kind} run has not completed (status ${String(response.status)})`);
  }
  if (response.conclusion !== "success") {
    throw new Error(`${kind} run concluded ${String(response.conclusion)}, not success`);
  }
  const runAttempt = response.run_attempt;
  if (!Number.isSafeInteger(runAttempt) || runAttempt < 1 || runAttempt > 100) {
    throw new Error(`${kind} run attempt ${String(runAttempt)} is out of range`);
  }
  // GitHub's run object has no completed_at; updated_at is the completion of
  // the attempt, and is the only authenticated completion time available.
  const completedAt = canonicalInstant(response.updated_at, `${kind} run updated_at`);
  return {
    workflow: WORKFLOW_REFS[kind],
    runId: String(response.id),
    runAttempt,
    headCommit,
    conclusion: response.conclusion,
    completedAt
  };
}

/** Derive production health from the run AND its captured health payload. */
function productionHealthFacts(response, healthPayload, expectedHeadCommit) {
  const run = runFacts("productionHealth", response, { expectedHeadCommit });
  if (!healthPayload || typeof healthPayload !== "object") {
    throw new Error("production health payload is missing");
  }
  if (healthPayload.status !== "ok") {
    throw new Error(`production health status is ${String(healthPayload.status)}, not ok`);
  }
  if (!Array.isArray(healthPayload.warnings)) {
    throw new Error("production health payload must carry a warnings array");
  }
  const durable = healthPayload.checks?.durableJobs;
  if (!durable || typeof durable !== "object") {
    throw new Error("production health payload must report checks.durableJobs");
  }
  if (durable.requested !== true || durable.enabled !== true || durable.readiness !== "ready") {
    throw new Error(
      "production health must positively prove durable readiness " +
        `(requested=${String(durable.requested)} enabled=${String(durable.enabled)} readiness=${String(durable.readiness)})`
    );
  }
  return {
    workflow: run.workflow,
    runId: run.runId,
    runAttempt: run.runAttempt,
    headCommit: run.headCommit,
    status: healthPayload.status,
    // Derived from the payload's own array rather than accepted as a count.
    warningCount: healthPayload.warnings.length,
    durableJobs: {
      requested: durable.requested,
      enabled: durable.enabled,
      readiness: durable.readiness
    },
    observedAt: run.completedAt
  };
}

/** sha256 over the two committed replay receipt files, in fixed mode order. */
export function replayReceiptSetDigest(receiptBytesByMode) {
  const hash = createHash("sha256");
  for (const mode of ["lease-expiry", "lost-resolve"]) {
    const bytes = receiptBytesByMode[mode];
    if (!bytes || bytes.length === 0) {
      throw new Error(`replay receipt bytes for ${mode} are missing`);
    }
    hash.update(bytes);
  }
  return hash.digest("hex");
}

/**
 * Build the receipt.
 *
 * Throws on anything missing, out of range, or inconsistent. There is no
 * partial success: a receipt that cannot be fully derived is not written.
 */
export function buildDurableEnableTransitionReceipt({
  fromCommit,
  toCommit,
  replay,
  secrets,
  changeControl,
  ciRun,
  promotionRun,
  productionHealthRun,
  productionHealthPayload,
  recordedAt
}) {
  const from = requireSha(fromCommit, "transition.fromCommit");
  const to = requireSha(toCommit, "transition.toCommit");
  if (from === to) throw new Error("the transition must move between two distinct commits");

  if (!replay || typeof replay !== "object") throw new Error("replay evidence is missing");
  const replayDeploymentCommit = requireSha(replay.deploymentCommit, "replay.deploymentCommit");
  if (replayDeploymentCommit !== from) {
    throw new Error(
      `replay evidence names ${replayDeploymentCommit} but the transition starts at ${from}; ` +
        "the flip commit must be the direct first child of the replay deployment commit"
    );
  }
  const replayReceiptSetSha = replay.receiptSetDigest;
  if (typeof replayReceiptSetSha !== "string" || !SHA256.test(replayReceiptSetSha)) {
    throw new Error("replay.receiptSetDigest must be a sha256 recomputed from the committed receipts");
  }
  const replayStartedAt = canonicalInstant(replay.evidenceStartedAt, "replay.evidenceStartedAt");
  const replayCapturedAt = canonicalInstant(replay.evidenceCapturedAt, "replay.evidenceCapturedAt");

  if (!secrets || typeof secrets !== "object") throw new Error("secrets observation is missing");
  const secretsCheckedAt = canonicalInstant(secrets.checkedAt, "secrets.checkedAt");
  if (secrets.durableJobsKeyPresent !== true || secrets.durableJobsInternalTokenPresent !== true) {
    throw new Error("both durable secrets must be observed present before the transition");
  }

  if (!changeControl || typeof changeControl !== "object") {
    throw new Error("changeControl evidence is missing");
  }
  const pullRequestUrl = changeControl.pullRequestUrl;
  if (
    typeof pullRequestUrl !== "string" ||
    !new RegExp(`^https://github\\.com/${REPOSITORY}/pull/[1-9][0-9]*$`).test(pullRequestUrl)
  ) {
    throw new Error("changeControl.pullRequestUrl must be a governed pull request on this repository");
  }
  if (changeControl.mergeCommit !== to) {
    throw new Error("changeControl.mergeCommit must be the transition commit");
  }
  const mergedAt = canonicalInstant(changeControl.mergedAt, "changeControl.mergedAt");

  const ci = runFacts("ci", ciRun, { expectedHeadCommit: to });

  const promotionBase = runFacts("promotion", promotionRun, { expectedHeadCommit: to });
  const deploymentDigest = promotionRun?.deploymentDigest;
  if (typeof deploymentDigest !== "string" || !SHA256.test(deploymentDigest)) {
    throw new Error("promotion evidence must carry the deployed artifact digest as a sha256");
  }
  const promotion = {
    workflow: promotionBase.workflow,
    runId: promotionBase.runId,
    runAttempt: promotionBase.runAttempt,
    productionCommit: to,
    deploymentDigest,
    convergedAt: promotionBase.completedAt
  };

  const productionHealth = productionHealthFacts(productionHealthRun, productionHealthPayload, to);

  const recorded = canonicalInstant(recordedAt, "recordedAt");

  // The binding checks this chain, but discovering a violation there means the
  // receipt was already committed. Refuse to write one that cannot pass.
  const chain = [
    ["replay.evidenceStartedAt", replayStartedAt],
    ["replay.evidenceCapturedAt", replayCapturedAt],
    ["secrets.checkedAt", secretsCheckedAt],
    ["changeControl.mergedAt", mergedAt],
    ["ci.completedAt", ci.completedAt],
    ["promotion.convergedAt", promotion.convergedAt],
    ["productionHealth.observedAt", productionHealth.observedAt],
    ["recordedAt", recorded]
  ];
  for (let index = 1; index < chain.length; index += 1) {
    const [previousLabel, previousValue] = chain[index - 1];
    const [label, value] = chain[index];
    if (Date.parse(previousValue) > Date.parse(value)) {
      throw new Error(
        `durable enable chronology is out of order: ${previousLabel} (${previousValue}) ` +
          `must not follow ${label} (${value})`
      );
    }
  }

  // Key order is part of the contract: requireExactOrderedKeys compares the
  // sequence, not the set.
  return {
    schemaVersion: 1,
    artifactKind: "site-behavior-durable-enable-transition",
    transition: {
      configPath: DURABLE_CONFIG_PATH,
      fromCommit: from,
      toCommit: to
    },
    replay: {
      deploymentCommit: replayDeploymentCommit,
      receiptSetDigest: replayReceiptSetSha,
      evidenceStartedAt: replayStartedAt,
      evidenceCapturedAt: replayCapturedAt
    },
    secrets: {
      checkedAt: secretsCheckedAt,
      durableJobsKeyPresent: true,
      durableJobsInternalTokenPresent: true,
      // Structural, never a caller's choice: a receipt that recorded values
      // would be a secret-bearing artifact in git.
      valuesRecorded: false
    },
    changeControl: {
      pullRequestUrl,
      mergeCommit: to,
      mergedAt
    },
    ci,
    promotion,
    productionHealth,
    recordedAt: recorded
  };
}

/** Exactly the serialization the binding accepts. */
export function canonicalTransitionReceiptText(receipt) {
  return `${JSON.stringify(receipt, null, 2)}\n`;
}

export function transitionReceiptSha256(receipt) {
  return createHash("sha256").update(canonicalTransitionReceiptText(receipt)).digest("hex");
}
