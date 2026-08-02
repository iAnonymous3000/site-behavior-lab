import { createHash } from "node:crypto";

export const DURABLE_REPLAY_RECEIPT_KIND = "site-behavior-durable-replay-receipt";
export const DURABLE_REPLAY_RECEIPT_VERSION = 1;
export const DURABLE_REPLAY_RECEIPT_SET_KIND = "site-behavior-durable-replay-receipt-set";
export const DURABLE_REPLAY_RECEIPT_SET_VERSION = 1;
export const DURABLE_REPLAY_MODES = Object.freeze(["lease-expiry", "lost-resolve"]);

const FULL_GIT_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const REPORT_ID = /^[0-9]{8}-[0-9a-f]{32}$/;
const ORIGIN_LABEL = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const HEADER_NAME = /^x-[a-z0-9-]{1,100}$/;
const EXPECTED_HEALTH_MODES = [...DURABLE_REPLAY_MODES];

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalReplayJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON refuses non-finite numbers.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalReplayJson(entry)).join(",")}]`;
  if (!isRecord(value)) throw new TypeError("Canonical JSON accepts JSON values only.");
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalReplayJson(value[key])}`)
    .join(",")}}`;
}

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalTimestamp(value) {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function exactKeys(record, expected, label, issues) {
  if (!isRecord(record)) {
    issues.push(`${label} must be an object`);
    return false;
  }
  const actual = Object.keys(record).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    issues.push(`${label} must contain exactly: ${wanted.join(", ")}`);
    return false;
  }
  return true;
}

function sameJson(left, right) {
  return canonicalReplayJson(left) === canonicalReplayJson(right);
}

export function durableReplayHealthIdentity(health, coordinatorOrigin) {
  const durable = health?.checks?.durableJobs;
  const fault = durable?.faultInjection;
  return {
    deploymentSha: health?.deployment,
    status: health?.status,
    warningCount: Array.isArray(health?.warnings) ? health.warnings.length : null,
    authenticated: health?.authenticated,
    openAccess: health?.openAccess,
    scansAvailable: health?.scansAvailable,
    chromiumSandbox: health?.checks?.chromiumSandbox,
    publicR2Reports: health?.checks?.publicR2Reports?.status,
    reportStore: health?.checks?.reportStore?.kind,
    durableJobs: {
      requested: durable?.requested,
      enabled: durable?.enabled,
      readiness: durable?.readiness,
      coordinatorOriginSha256: sha256Hex(coordinatorOrigin),
      faultInjection: {
        environment: fault?.environment,
        enabled: fault?.enabled,
        modes: Array.isArray(fault?.modes) ? [...fault.modes].sort() : fault?.modes,
        modeHeaderName: fault?.modeHeaderName,
        tokenHeaderName: fault?.tokenHeaderName,
        minimumNoPollMs: fault?.minimumNoPollMs,
        attemptEvidence: fault?.attemptEvidence,
        completionBeforeStatusRequestEvidence: fault?.completionBeforeStatusRequestEvidence,
        wholeOriginAccessGate: fault?.wholeOriginAccessGate
      }
    }
  };
}

export function durableReplayHealthIdentityDigest(identity) {
  return sha256Hex(canonicalReplayJson(identity));
}

export function durableReplayReceiptDigest(receipt) {
  if (!isRecord(receipt)) throw new TypeError("receipt must be an object");
  const unsigned = { ...receipt };
  delete unsigned.receiptDigest;
  return sha256Hex(canonicalReplayJson(unsigned));
}

export function buildDurableReplayReceipt(input) {
  if (
    input.preHealth?.health?.checks?.durableJobs?.coordinatorOrigin !== input.origin ||
    input.postHealth?.health?.checks?.durableJobs?.coordinatorOrigin !== input.origin
  ) {
    throw new Error("Pre/post health must bind the exact receipt origin before it is hashed.");
  }
  const preIdentity = durableReplayHealthIdentity(input.preHealth.health, input.origin);
  const postIdentity = durableReplayHealthIdentity(input.postHealth.health, input.origin);
  const receipt = {
    kind: DURABLE_REPLAY_RECEIPT_KIND,
    receiptVersion: DURABLE_REPLAY_RECEIPT_VERSION,
    recordedAt: input.recordedAt ?? new Date().toISOString(),
    mode: input.mode,
    expectedDeploymentSha: input.expectedDeploymentSha,
    origin: {
      label: input.originLabel,
      sha256: sha256Hex(input.origin)
    },
    timing: {
      startedAt: input.timing.startedAt,
      submittedAt: input.timing.submittedAt,
      noPollMs: input.timing.noPollMs,
      blindWindowEndedAt: input.timing.blindWindowEndedAt,
      statusObservedAt: input.timing.statusObservedAt,
      reportReadbackAt: input.timing.reportReadbackAt,
      completedAt: input.timing.completedAt
    },
    preHealth: {
      observedAt: input.preHealth.observedAt,
      identity: preIdentity,
      identitySha256: durableReplayHealthIdentityDigest(preIdentity)
    },
    postHealth: {
      observedAt: input.postHealth.observedAt,
      identity: postIdentity,
      identitySha256: durableReplayHealthIdentityDigest(postIdentity)
    },
    execution: {
      terminalStatus: input.execution.terminalStatus,
      jobId: input.execution.jobId,
      reportId: input.execution.reportId,
      attempts: input.execution.attempts,
      faultTriggered: input.execution.faultTriggered,
      triggeredGeneration: input.execution.triggeredGeneration,
      finishedBeforeStatusRequest: input.execution.finishedBeforeStatusRequest,
      reportReadback: input.execution.reportReadback
    },
    evidenceRefs: [
      `pre-health:sha256:${durableReplayHealthIdentityDigest(preIdentity)}`,
      `job:${input.execution.jobId}`,
      `report:${input.execution.reportId}`,
      `post-health:sha256:${durableReplayHealthIdentityDigest(postIdentity)}`
    ]
  };
  receipt.receiptDigest = durableReplayReceiptDigest(receipt);
  const issues = durableReplayReceiptIssues(receipt);
  if (issues.length > 0) {
    throw new Error(`Refusing to write an invalid durable replay receipt: ${issues.join("; ")}`);
  }
  return receipt;
}

function healthIdentityIssues(identity, label, issues) {
  if (
    !exactKeys(
      identity,
      [
        "deploymentSha",
        "status",
        "warningCount",
        "authenticated",
        "openAccess",
        "scansAvailable",
        "chromiumSandbox",
        "publicR2Reports",
        "reportStore",
        "durableJobs"
      ],
      label,
      issues
    )
  ) {
    return;
  }
  if (!FULL_GIT_SHA.test(identity.deploymentSha)) issues.push(`${label}.deploymentSha must be a full lowercase Git SHA`);
  if (identity.status !== "ok") issues.push(`${label}.status must be ok`);
  if (identity.warningCount !== 0) issues.push(`${label}.warningCount must be zero`);
  if (identity.authenticated !== true) issues.push(`${label}.authenticated must be literally true`);
  if (identity.openAccess !== false) issues.push(`${label}.openAccess must be literally false`);
  if (identity.scansAvailable !== true) issues.push(`${label}.scansAvailable must be literally true`);
  if (identity.chromiumSandbox !== "enabled") issues.push(`${label}.chromiumSandbox must be enabled`);
  if (identity.publicR2Reports !== "enabled") issues.push(`${label}.publicR2Reports must be enabled`);
  if (identity.reportStore !== "r2") issues.push(`${label}.reportStore must be r2`);

  const durable = identity.durableJobs;
  if (
    !exactKeys(
      durable,
      ["requested", "enabled", "readiness", "coordinatorOriginSha256", "faultInjection"],
      `${label}.durableJobs`,
      issues
    )
  ) {
    return;
  }
  if (durable.requested !== true) issues.push(`${label}.durableJobs.requested must be literally true`);
  if (durable.enabled !== true) issues.push(`${label}.durableJobs.enabled must be literally true`);
  if (durable.readiness !== "ready") issues.push(`${label}.durableJobs.readiness must be ready`);
  if (!SHA256.test(durable.coordinatorOriginSha256)) {
    issues.push(`${label}.durableJobs.coordinatorOriginSha256 must be a lowercase sha256 digest`);
  }

  const fault = durable.faultInjection;
  if (
    !exactKeys(
      fault,
      [
        "environment",
        "enabled",
        "modes",
        "modeHeaderName",
        "tokenHeaderName",
        "minimumNoPollMs",
        "attemptEvidence",
        "completionBeforeStatusRequestEvidence",
        "wholeOriginAccessGate"
      ],
      `${label}.durableJobs.faultInjection`,
      issues
    )
  ) {
    return;
  }
  if (fault.environment !== "staging") issues.push(`${label}.faultInjection.environment must be staging`);
  if (fault.enabled !== true) issues.push(`${label}.faultInjection.enabled must be literally true`);
  if (!sameJson(fault.modes, EXPECTED_HEALTH_MODES)) {
    issues.push(`${label}.faultInjection.modes must contain lease-expiry and lost-resolve exactly`);
  }
  if (!HEADER_NAME.test(fault.modeHeaderName)) issues.push(`${label}.faultInjection.modeHeaderName must be a safe x- header`);
  if (!HEADER_NAME.test(fault.tokenHeaderName)) issues.push(`${label}.faultInjection.tokenHeaderName must be a safe x- header`);
  if (
    fault.modeHeaderName === "x-site-behavior-lab-access-token" ||
    fault.tokenHeaderName === "x-site-behavior-lab-access-token"
  ) {
    issues.push(`${label}.faultInjection headers must not alias the whole-origin access-token header`);
  }
  if (fault.modeHeaderName === fault.tokenHeaderName) {
    issues.push(`${label}.faultInjection header names must be distinct`);
  }
  if (!Number.isSafeInteger(fault.minimumNoPollMs) || fault.minimumNoPollMs <= 0) {
    issues.push(`${label}.faultInjection.minimumNoPollMs must be a positive integer`);
  }
  if (fault.attemptEvidence !== true) issues.push(`${label}.faultInjection.attemptEvidence must be literally true`);
  if (fault.completionBeforeStatusRequestEvidence !== true) {
    issues.push(`${label}.faultInjection.completionBeforeStatusRequestEvidence must be literally true`);
  }
  if (fault.wholeOriginAccessGate !== true) {
    issues.push(`${label}.faultInjection.wholeOriginAccessGate must be literally true`);
  }
}

function healthReceiptIssues(value, label, issues) {
  if (!exactKeys(value, ["observedAt", "identity", "identitySha256"], label, issues)) return;
  if (!canonicalTimestamp(value.observedAt)) issues.push(`${label}.observedAt must be a canonical ISO timestamp`);
  healthIdentityIssues(value.identity, `${label}.identity`, issues);
  if (!SHA256.test(value.identitySha256)) {
    issues.push(`${label}.identitySha256 must be a lowercase sha256 digest`);
  } else if (value.identitySha256 !== durableReplayHealthIdentityDigest(value.identity)) {
    issues.push(`${label}.identitySha256 does not match the canonical health identity`);
  }
}

export function durableReplayReceiptIssues(receipt) {
  const issues = [];
  if (
    !exactKeys(
      receipt,
      [
        "kind",
        "receiptVersion",
        "recordedAt",
        "mode",
        "expectedDeploymentSha",
        "origin",
        "timing",
        "preHealth",
        "postHealth",
        "execution",
        "evidenceRefs",
        "receiptDigest"
      ],
      "receipt",
      issues
    )
  ) {
    return issues;
  }
  if (receipt.kind !== DURABLE_REPLAY_RECEIPT_KIND) issues.push(`kind must be ${DURABLE_REPLAY_RECEIPT_KIND}`);
  if (receipt.receiptVersion !== DURABLE_REPLAY_RECEIPT_VERSION) {
    issues.push(`receiptVersion must be ${DURABLE_REPLAY_RECEIPT_VERSION}`);
  }
  if (!canonicalTimestamp(receipt.recordedAt)) issues.push("recordedAt must be a canonical ISO timestamp");
  if (!DURABLE_REPLAY_MODES.includes(receipt.mode)) issues.push("mode must be lease-expiry or lost-resolve");
  if (!FULL_GIT_SHA.test(receipt.expectedDeploymentSha)) {
    issues.push("expectedDeploymentSha must be a full lowercase Git SHA");
  }

  if (exactKeys(receipt.origin, ["label", "sha256"], "origin", issues)) {
    if (!ORIGIN_LABEL.test(receipt.origin.label) || receipt.origin.label === "production") {
      issues.push("origin.label must be a bounded non-production operator label");
    }
    if (!SHA256.test(receipt.origin.sha256)) issues.push("origin.sha256 must be a lowercase sha256 digest");
  }

  const timing = receipt.timing;
  if (
    exactKeys(
      timing,
      [
        "startedAt",
        "submittedAt",
        "noPollMs",
        "blindWindowEndedAt",
        "statusObservedAt",
        "reportReadbackAt",
        "completedAt"
      ],
      "timing",
      issues
    )
  ) {
    for (const key of [
      "startedAt",
      "submittedAt",
      "blindWindowEndedAt",
      "statusObservedAt",
      "reportReadbackAt",
      "completedAt"
    ]) {
      if (!canonicalTimestamp(timing[key])) issues.push(`timing.${key} must be a canonical ISO timestamp`);
    }
    if (!Number.isSafeInteger(timing.noPollMs) || timing.noPollMs <= 0 || timing.noPollMs > 3_600_000) {
      issues.push("timing.noPollMs must be an integer from 1 through 3600000");
    } else if (
      canonicalTimestamp(timing.submittedAt) &&
      canonicalTimestamp(timing.blindWindowEndedAt) &&
      Date.parse(timing.blindWindowEndedAt) - Date.parse(timing.submittedAt) < timing.noPollMs
    ) {
      issues.push("timing timestamps do not prove the declared no-poll duration");
    }
  }

  healthReceiptIssues(receipt.preHealth, "preHealth", issues);
  healthReceiptIssues(receipt.postHealth, "postHealth", issues);

  const execution = receipt.execution;
  if (
    exactKeys(
      execution,
      [
        "terminalStatus",
        "jobId",
        "reportId",
        "attempts",
        "faultTriggered",
        "triggeredGeneration",
        "finishedBeforeStatusRequest",
        "reportReadback"
      ],
      "execution",
      issues
    )
  ) {
    if (execution.terminalStatus !== "succeeded") issues.push("execution.terminalStatus must be succeeded");
    if (!REPORT_ID.test(execution.jobId)) issues.push("execution.jobId must be a canonical job id");
    if (!REPORT_ID.test(execution.reportId)) issues.push("execution.reportId must be a canonical report id");
    if (execution.jobId === execution.reportId) issues.push("execution jobId and reportId must be distinct");
    const expectedAttempts = receipt.mode === "lease-expiry" ? 2 : receipt.mode === "lost-resolve" ? 1 : null;
    if (execution.attempts !== expectedAttempts) {
      issues.push(`execution.attempts must be ${String(expectedAttempts)} for ${String(receipt.mode)}`);
    }
    if (execution.faultTriggered !== true) issues.push("execution.faultTriggered must be literally true");
    if (execution.triggeredGeneration !== 1) issues.push("execution.triggeredGeneration must be exactly 1");
    if (execution.finishedBeforeStatusRequest !== true) {
      issues.push("execution.finishedBeforeStatusRequest must be literally true");
    }
    if (execution.reportReadback !== true) issues.push("execution.reportReadback must be literally true");
  }

  const preIdentity = receipt.preHealth?.identity;
  const postIdentity = receipt.postHealth?.identity;
  if (isRecord(preIdentity) && isRecord(postIdentity)) {
    if (!sameJson(preIdentity, postIdentity)) issues.push("preHealth and postHealth identities must match exactly");
    if (preIdentity.deploymentSha !== receipt.expectedDeploymentSha) {
      issues.push("preHealth deployment must match expectedDeploymentSha");
    }
    if (postIdentity.deploymentSha !== receipt.expectedDeploymentSha) {
      issues.push("postHealth deployment must match expectedDeploymentSha");
    }
    if (preIdentity.durableJobs?.coordinatorOriginSha256 !== receipt.origin?.sha256) {
      issues.push("preHealth coordinator origin digest must match origin.sha256");
    }
    if (postIdentity.durableJobs?.coordinatorOriginSha256 !== receipt.origin?.sha256) {
      issues.push("postHealth coordinator origin digest must match origin.sha256");
    }
    if (
      Number.isSafeInteger(timing?.noPollMs) &&
      (timing.noPollMs < preIdentity.durableJobs?.faultInjection?.minimumNoPollMs ||
        timing.noPollMs < postIdentity.durableJobs?.faultInjection?.minimumNoPollMs)
    ) {
      issues.push("timing.noPollMs must satisfy both attested health minima");
    }
  }

  const orderedTimestamps = [
    timing?.startedAt,
    receipt.preHealth?.observedAt,
    timing?.submittedAt,
    timing?.blindWindowEndedAt,
    timing?.statusObservedAt,
    timing?.reportReadbackAt,
    receipt.postHealth?.observedAt,
    timing?.completedAt,
    receipt.recordedAt
  ];
  if (orderedTimestamps.every(canonicalTimestamp)) {
    for (let index = 1; index < orderedTimestamps.length; index += 1) {
      if (Date.parse(orderedTimestamps[index]) < Date.parse(orderedTimestamps[index - 1])) {
        issues.push("receipt timestamps must be monotonically ordered");
        break;
      }
    }
  }

  const expectedRefs =
    SHA256.test(receipt.preHealth?.identitySha256) &&
    REPORT_ID.test(execution?.jobId) &&
    REPORT_ID.test(execution?.reportId) &&
    SHA256.test(receipt.postHealth?.identitySha256)
      ? [
          `pre-health:sha256:${receipt.preHealth.identitySha256}`,
          `job:${execution.jobId}`,
          `report:${execution.reportId}`,
          `post-health:sha256:${receipt.postHealth.identitySha256}`
        ]
      : null;
  if (!Array.isArray(receipt.evidenceRefs) || expectedRefs === null || !sameJson(receipt.evidenceRefs, expectedRefs)) {
    issues.push("evidenceRefs must bind the exact pre-health, job, report, and post-health evidence");
  }

  if (!SHA256.test(receipt.receiptDigest)) {
    issues.push("receiptDigest must be a lowercase sha256 digest");
  } else if (receipt.receiptDigest !== durableReplayReceiptDigest(receipt)) {
    issues.push("receiptDigest does not match the canonical receipt");
  }
  return issues;
}

export function durableReplayReceiptSetIssues(receipts, expectedDeploymentSha) {
  const issues = [];
  if (!Array.isArray(receipts) || receipts.length !== 2) {
    return ["receipt set must contain exactly two receipts"];
  }
  for (const [index, receipt] of receipts.entries()) {
    for (const issue of durableReplayReceiptIssues(receipt)) issues.push(`receipt[${index}]: ${issue}`);
  }
  if (issues.length > 0) return issues;

  if (receipts[0].mode !== "lease-expiry" || receipts[1].mode !== "lost-resolve") {
    issues.push("receipt set order must be lease-expiry followed by lost-resolve");
  }
  const byMode = new Map(receipts.map((receipt) => [receipt.mode, receipt]));
  if (byMode.size !== 2 || !DURABLE_REPLAY_MODES.every((mode) => byMode.has(mode))) {
    issues.push("receipt set must contain one lease-expiry and one lost-resolve receipt");
    return issues;
  }
  const lease = byMode.get("lease-expiry");
  const lost = byMode.get("lost-resolve");
  if (expectedDeploymentSha !== undefined && !FULL_GIT_SHA.test(expectedDeploymentSha)) {
    issues.push("expected deployment must be a full lowercase Git SHA");
  }
  for (const receipt of receipts) {
    if (expectedDeploymentSha !== undefined && receipt.expectedDeploymentSha !== expectedDeploymentSha) {
      issues.push(`${receipt.mode} receipt does not match the operator-selected deployment SHA`);
    }
    if (receipt.expectedDeploymentSha !== lease.expectedDeploymentSha) {
      issues.push("both replay modes must bind the same deployment SHA");
    }
    if (!sameJson(receipt.origin, lease.origin)) {
      issues.push("both replay modes must bind the same labeled staging origin");
    }
    if (receipt.preHealth.identitySha256 !== lease.preHealth.identitySha256) {
      issues.push("both replay modes must bind the same exact staging health identity");
    }
  }
  if (
    new Set([
      lease.execution.jobId,
      lease.execution.reportId,
      lost.execution.jobId,
      lost.execution.reportId
    ]).size !== 4
  ) {
    issues.push("the two replay modes must use four distinct job and report ids");
  }
  if (Date.parse(lost.timing.startedAt) <= Date.parse(lease.recordedAt)) {
    issues.push("lost-resolve must start only after the lease-expiry receipt is recorded");
  }
  return [...new Set(issues)];
}

export function durableReplayReceiptSetDigest(receipts, expectedDeploymentSha) {
  const issues = durableReplayReceiptSetIssues(receipts, expectedDeploymentSha);
  if (issues.length > 0) throw new Error(`Invalid durable replay receipt set: ${issues.join("; ")}`);
  const ordered = [...receipts].sort(
    (left, right) => DURABLE_REPLAY_MODES.indexOf(left.mode) - DURABLE_REPLAY_MODES.indexOf(right.mode)
  );
  return sha256Hex(
    canonicalReplayJson({
      kind: DURABLE_REPLAY_RECEIPT_SET_KIND,
      receiptSetVersion: DURABLE_REPLAY_RECEIPT_SET_VERSION,
      expectedDeploymentSha: ordered[0].expectedDeploymentSha,
      origin: ordered[0].origin,
      receipts: ordered.map(({ mode, receiptDigest }) => ({ mode, receiptDigest }))
    })
  );
}

/**
 * Readiness-friendly replay-set verdict. Callers can compare deploymentSha to
 * the attestation's candidateCommit, receiptSetDigest to
 * replayReceiptsDigest, and evidenceCapturedAt to the attestation's evidence
 * timestamp without reimplementing receipt ordering or digest semantics.
 */
export function verifyDurableReplayReceiptSet(receipts, expectedDeploymentSha) {
  const issues = durableReplayReceiptSetIssues(receipts, expectedDeploymentSha);
  if (issues.length > 0) {
    return {
      ok: false,
      issues,
      receiptSetDigest: null,
      deploymentSha: null,
      originLabel: null,
      originSha256: null,
      evidenceStartedAt: null,
      evidenceCapturedAt: null
    };
  }
  const lease = receipts[0];
  const lost = receipts[1];
  return {
    ok: true,
    issues: [],
    receiptSetDigest: durableReplayReceiptSetDigest(receipts, expectedDeploymentSha),
    deploymentSha: lease.expectedDeploymentSha,
    originLabel: lease.origin.label,
    originSha256: lease.origin.sha256,
    evidenceStartedAt: lease.timing.startedAt,
    evidenceCapturedAt: lost.recordedAt
  };
}
