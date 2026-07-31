// Machine-readable destruction receipts for controlled-runner cycles.
//
// docs/featured-corpus-r2-rollout.md defines, in prose, the operator evidence
// a controlled r2 acquisition run requires: single-use provisioning, metadata
// and credential isolation, independently enforced egress, job-scoped
// registration, and verified destruction recorded against the Actions run id.
// Repository code cannot PROVE any of that about a host; what it can do is
// refuse to count a cycle whose evidence is incomplete. This module is that
// refusal: a receipt schema whose verifier enforces completeness and internal
// consistency, so "two successful scheduled runner cycles" can be gated on
// artifacts instead of folklore. Truth stays with the operator attestation
// and its referenced evidence; the verifier makes omissions loud.
import { canonicalize, sha256Hex } from "./scanner-fidelity-study-lib.mjs";

export const RUNNER_DESTRUCTION_RECEIPT_KIND =
  "site-behavior-controlled-runner-destruction-receipt";
export const RUNNER_DESTRUCTION_RECEIPT_VERSION = 1;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 2000;
}

function isoTimestamp(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

/**
 * Structural + consistency validation. Empty array = the receipt is complete.
 * Every boolean gate must be LITERALLY true: absence, null, or false all read
 * as "the evidence does not exist", never as a soft default.
 */
export function runnerDestructionReceiptIssues(receipt) {
  const issues = [];
  const push = (message) => issues.push(message);
  if (!isRecord(receipt)) return ["receipt must be an object"];
  if (receipt.kind !== RUNNER_DESTRUCTION_RECEIPT_KIND) push(`kind must be ${RUNNER_DESTRUCTION_RECEIPT_KIND}`);
  if (receipt.receiptVersion !== RUNNER_DESTRUCTION_RECEIPT_VERSION) {
    push(`receiptVersion must be ${RUNNER_DESTRUCTION_RECEIPT_VERSION}`);
  }
  if (!Number.isSafeInteger(receipt.actionsRunId) || receipt.actionsRunId <= 0) {
    push("actionsRunId must bind the receipt to one Actions run");
  }
  if (!Number.isSafeInteger(receipt.actionsRunAttempt) || receipt.actionsRunAttempt < 1) {
    push("actionsRunAttempt must be a positive integer");
  }
  if (!nonEmptyString(receipt.workflow)) push("workflow must name the workflow file");
  if (!nonEmptyString(receipt.runnerLabel)) push("runnerLabel must name the controlled runner label");
  if (!isoTimestamp(receipt.recordedAt)) push("recordedAt must be an ISO 8601 timestamp");

  const provisioning = receipt.provisioning;
  if (!isRecord(provisioning)) {
    push("provisioning block is required");
  } else {
    if (!isoTimestamp(provisioning.provisionedAt)) push("provisioning.provisionedAt must be ISO 8601");
    if (!nonEmptyString(provisioning.hostImageIdentity)) {
      push("provisioning.hostImageIdentity must identify the exact host image");
    }
    if (provisioning.singleUse !== true) push("provisioning.singleUse must be literally true");
    const registration = provisioning.registration;
    if (!isRecord(registration)) {
      push("provisioning.registration block is required");
    } else {
      if (!nonEmptyString(registration.repository)) push("registration.repository must name the repository");
      if (
        !Array.isArray(registration.labels) ||
        registration.labels.length === 0 ||
        registration.labels.some((label) => !nonEmptyString(label))
      ) {
        push("registration.labels must list the runner labels");
      }
      if (registration.ephemeral !== true) push("registration.ephemeral must be literally true");
    }
  }

  const isolation = receipt.isolation;
  if (!isRecord(isolation)) {
    push("isolation block is required");
  } else {
    for (const gate of [
      "cloudMetadataBlocked",
      "controlPlaneCredentialsAbsent",
      "persistentStateAbsent"
    ]) {
      if (isolation[gate] !== true) push(`isolation.${gate} must be literally true`);
    }
  }

  const egress = receipt.egress;
  if (!isRecord(egress)) {
    push("egress block is required");
  } else {
    if (!nonEmptyString(egress.declaredRegion)) push("egress.declaredRegion must name the stable region");
    if (!nonEmptyString(egress.natIdentity)) push("egress.natIdentity must identify the outbound NAT");
    if (egress.independentPolicyEnforced !== true) {
      push("egress.independentPolicyEnforced must be literally true");
    }
    if (
      !Array.isArray(egress.blockedClasses) ||
      !["private", "link-local", "metadata"].every((required) => egress.blockedClasses.includes(required))
    ) {
      push("egress.blockedClasses must include at least private, link-local, and metadata");
    }
  }

  const destruction = receipt.destruction;
  if (!isRecord(destruction)) {
    push("destruction block is required");
  } else {
    if (!isoTimestamp(destruction.destroyedAt)) push("destruction.destroyedAt must be ISO 8601");
    if (!isoTimestamp(destruction.verifiedAbsentAt)) push("destruction.verifiedAbsentAt must be ISO 8601");
    if (!nonEmptyString(destruction.method)) push("destruction.method must describe how the host was destroyed");
    if (!nonEmptyString(destruction.verification)) {
      push("destruction.verification must reference the absence evidence");
    }
    if (
      isRecord(provisioning) &&
      isoTimestamp(provisioning.provisionedAt) &&
      isoTimestamp(destruction.destroyedAt) &&
      Date.parse(destruction.destroyedAt) <= Date.parse(provisioning.provisionedAt)
    ) {
      push("destruction.destroyedAt must be after provisioning.provisionedAt");
    }
    if (
      isoTimestamp(destruction.destroyedAt) &&
      isoTimestamp(destruction.verifiedAbsentAt) &&
      Date.parse(destruction.verifiedAbsentAt) < Date.parse(destruction.destroyedAt)
    ) {
      push("destruction.verifiedAbsentAt must not precede destruction.destroyedAt");
    }
  }

  const operator = receipt.operator;
  if (!isRecord(operator)) {
    push("operator block is required");
  } else {
    if (!nonEmptyString(operator.attestedBy)) push("operator.attestedBy must name the attesting operator");
    if (
      !Array.isArray(operator.evidenceRefs) ||
      operator.evidenceRefs.length === 0 ||
      operator.evidenceRefs.some((ref) => !nonEmptyString(ref))
    ) {
      push("operator.evidenceRefs must reference at least one evidence artifact");
    }
  }
  return issues;
}

/** Verify one receipt; a valid receipt gains its canonical digest. */
export function verifyRunnerDestructionReceipt(receipt) {
  const issues = runnerDestructionReceiptIssues(receipt);
  if (issues.length > 0) return { ok: false, issues, receiptDigest: null };
  return { ok: true, issues: [], receiptDigest: sha256Hex(canonicalize(receipt)) };
}
