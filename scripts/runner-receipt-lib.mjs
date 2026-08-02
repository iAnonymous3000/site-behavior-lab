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
import {
  CONTROLLED_RUNNER_IDENTITY_REF_PATTERN
} from "./controlled-runner-identity-lib.mjs";

export const RUNNER_DESTRUCTION_RECEIPT_KIND =
  "site-behavior-controlled-runner-destruction-receipt";
export const RUNNER_DESTRUCTION_RECEIPT_VERSION = 3;
export const LEGACY_RUNNER_DESTRUCTION_RECEIPT_VERSION = 2;

const CONTROLLED_RUNNER_REPOSITORY = "iAnonymous3000/site-behavior-lab";
const CONTROLLED_RUNNER_WORKFLOW = "scan-featured.yml";
const CONTROLLED_RUNNER_JOB = "Populate Featured Gallery";
const DESTRUCTION_EVIDENCE_WORKFLOW =
  ".github/workflows/runner-destruction-evidence.yml";
const DESTRUCTION_EVIDENCE_JOB =
  "Read back provider destruction and absence";
const CONTROLLED_RUNNER_CATALOGS = new Set([
  "public/featured-sites.json",
  "public/corpus-seed-sites.json"
]);
const FULL_GIT_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const CANONICAL_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const RUN_EVIDENCE_REF_KIND = "github-actions-run-evidence";
const SHA256_REF = /^sha256:[0-9a-f]{64}$/;
const PUBLIC_REGION = /^[a-z]{2,8}(?:-[a-z0-9]{2,12}){1,2}$/;
const V3_DESTRUCTION_METHOD = "instance-terminate";

const LEGACY_RECEIPT_KEYS = [
  "kind",
  "receiptVersion",
  "actionsRunId",
  "actionsRunAttempt",
  "workflow",
  "runnerLabel",
  "recordedAt",
  "provisioning",
  "runEvidence",
  "isolation",
  "egress",
  "destruction",
  "operator"
];
const RECEIPT_KEYS = [
  ...LEGACY_RECEIPT_KEYS.slice(0, -1).map((key) =>
    key === "runnerLabel" ? "runnerLabelRef" : key
  ),
  "destructionEvidence",
  "operator"
];
const LEGACY_PROVISIONING_KEYS = [
  "provisionedAt",
  "hostImageIdentity",
  "singleUse",
  "registration"
];
const PROVISIONING_KEYS = [
  "provisionedAt",
  "hostImageIdentityRef",
  "singleUse",
  "registration"
];
const LEGACY_REGISTRATION_KEYS = ["repository", "labels", "ephemeral"];
const REGISTRATION_KEYS = ["repository", "labelRefs", "ephemeral"];
const RUN_EVIDENCE_KEYS = [
  "conclusion",
  "reportMode",
  "acquisition",
  "headSha",
  "catalog",
  "collectionDate",
  "job",
  "artifact"
];
const JOB_KEYS = ["id", "name", "startedAt", "completedAt", "url"];
const ARTIFACT_KEYS = ["id", "name", "sha256", "url"];
const ISOLATION_KEYS = [
  "cloudMetadataBlocked",
  "controlPlaneCredentialsAbsent",
  "persistentStateAbsent"
];
const LEGACY_EGRESS_KEYS = [
  "declaredRegion",
  "natIdentity",
  "independentPolicyEnforced",
  "blockedClasses"
];
const EGRESS_KEYS = [
  "declaredRegion",
  "natIdentityRef",
  "independentPolicyEnforced",
  "blockedClasses"
];
const DESTRUCTION_KEYS = ["destroyedAt", "verifiedAbsentAt", "method", "verification"];
const DESTRUCTION_EVIDENCE_KEYS = [
  "workflow",
  "runId",
  "runAttempt",
  "headSha",
  "conclusion",
  "job",
  "artifact",
  "readback"
];
const DESTRUCTION_READBACK_KEYS = ["path", "sha256"];
const OPERATOR_KEYS = ["attestedBy", "evidenceRefs"];
const OPERATOR_EVIDENCE_REF_KEYS = [
  "kind",
  "actionsRunId",
  "runUrl",
  "artifactName",
  "artifactRef",
  "artifactSha256"
];
const SET_OPTION_KEYS = [
  "expectedCandidateCommit",
  "expectedEnvironmentDigest",
  "epochStartedAt",
  "now",
  "maxAgeDays"
];

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 2000;
}

function isoTimestamp(value) {
  if (typeof value !== "string" || !CANONICAL_INSTANT.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function collectionDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  if (Number.isNaN(Date.parse(`${value}T00:00:00.000Z`))) return false;
  return new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
}

function positiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function exactKeys(value, expected, label, issues) {
  if (!isRecord(value)) {
    issues.push(`${label} must be an object`);
    return false;
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    issues.push(`${label} must contain exactly: ${wanted.join(", ")}`);
    return false;
  }
  return true;
}

function exactRunUrl(runId) {
  return `https://github.com/${CONTROLLED_RUNNER_REPOSITORY}/actions/runs/${runId}`;
}

function exactJobUrl(runId, jobId) {
  return `https://github.com/${CONTROLLED_RUNNER_REPOSITORY}/actions/runs/${runId}/job/${jobId}`;
}

function exactArtifactUrl(runId, artifactId) {
  return `https://github.com/${CONTROLLED_RUNNER_REPOSITORY}/actions/runs/${runId}/artifacts/${artifactId}`;
}

function canonicalBoundedString(value, maximum = 2000) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f-\u009f]/.test(value)
  );
}

/**
 * The controlled environment facts that must remain compatible across the
 * two temporal cycles. Per-run identifiers and timestamps are intentionally
 * excluded; the stable image, label, NAT, region, and blocked network classes
 * are the cross-cycle subject.
 */
export function runnerDestructionEnvironmentTuple(receipt) {
  const legacy =
    receipt?.receiptVersion ===
    LEGACY_RUNNER_DESTRUCTION_RECEIPT_VERSION;
  if (legacy) {
    return {
      runnerLabel: receipt?.runnerLabel,
      hostImageIdentity: receipt?.provisioning?.hostImageIdentity,
      declaredRegion: receipt?.egress?.declaredRegion,
      natIdentity: receipt?.egress?.natIdentity,
      blockedClasses: Array.isArray(receipt?.egress?.blockedClasses)
        ? [...receipt.egress.blockedClasses].sort()
        : receipt?.egress?.blockedClasses
    };
  }
  return {
    runnerLabelRef: receipt?.runnerLabelRef,
    hostImageIdentityRef: receipt?.provisioning?.hostImageIdentityRef,
    registrationLabelRefs: Array.isArray(
      receipt?.provisioning?.registration?.labelRefs
    )
      ? [...receipt.provisioning.registration.labelRefs].sort()
      : receipt?.provisioning?.registration?.labelRefs,
    declaredRegion: receipt?.egress?.declaredRegion,
    natIdentityRef: receipt?.egress?.natIdentityRef,
    blockedClasses: Array.isArray(receipt?.egress?.blockedClasses)
      ? [...receipt.egress.blockedClasses].sort()
      : receipt?.egress?.blockedClasses
  };
}

export function runnerDestructionEnvironmentDigest(receipt) {
  return sha256Hex(canonicalize(runnerDestructionEnvironmentTuple(receipt)));
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
  const legacy =
    receipt.receiptVersion ===
    LEGACY_RUNNER_DESTRUCTION_RECEIPT_VERSION;
  exactKeys(
    receipt,
    legacy ? LEGACY_RECEIPT_KEYS : RECEIPT_KEYS,
    "receipt",
    issues
  );
  if (receipt.kind !== RUNNER_DESTRUCTION_RECEIPT_KIND) push(`kind must be ${RUNNER_DESTRUCTION_RECEIPT_KIND}`);
  if (receipt.receiptVersion !== RUNNER_DESTRUCTION_RECEIPT_VERSION) {
    push(
      legacy
        ? `receiptVersion ${LEGACY_RUNNER_DESTRUCTION_RECEIPT_VERSION} is readable legacy evidence but is release-ineligible; recapture with version ${RUNNER_DESTRUCTION_RECEIPT_VERSION} hosted destruction readback`
        : `receiptVersion must be ${RUNNER_DESTRUCTION_RECEIPT_VERSION}`
    );
  }
  if (!Number.isSafeInteger(receipt.actionsRunId) || receipt.actionsRunId <= 0) {
    push("actionsRunId must bind the receipt to one Actions run");
  }
  if (!Number.isSafeInteger(receipt.actionsRunAttempt) || receipt.actionsRunAttempt < 1) {
    push("actionsRunAttempt must be a positive integer");
  }
  if (receipt.workflow !== CONTROLLED_RUNNER_WORKFLOW) {
    push(`workflow must be exactly ${CONTROLLED_RUNNER_WORKFLOW}`);
  }
  if (legacy) {
    if (!canonicalBoundedString(receipt.runnerLabel, 200)) {
      push("runnerLabel must name the controlled runner label");
    }
  } else if (
    typeof receipt.runnerLabelRef !== "string" ||
    !CONTROLLED_RUNNER_IDENTITY_REF_PATTERN.test(receipt.runnerLabelRef)
  ) {
    push("runnerLabelRef must be a domain-separated sha256 reference");
  }
  if (!isoTimestamp(receipt.recordedAt)) push("recordedAt must be an ISO 8601 timestamp");

  const provisioning = receipt.provisioning;
  if (!isRecord(provisioning)) {
    push("provisioning block is required");
  } else {
    exactKeys(
      provisioning,
      legacy ? LEGACY_PROVISIONING_KEYS : PROVISIONING_KEYS,
      "provisioning",
      issues
    );
    if (!isoTimestamp(provisioning.provisionedAt)) push("provisioning.provisionedAt must be ISO 8601");
    if (legacy) {
      if (!canonicalBoundedString(provisioning.hostImageIdentity)) {
        push("provisioning.hostImageIdentity must identify the exact host image");
      }
    } else if (
      typeof provisioning.hostImageIdentityRef !== "string" ||
      !CONTROLLED_RUNNER_IDENTITY_REF_PATTERN.test(
        provisioning.hostImageIdentityRef
      )
    ) {
      push(
        "provisioning.hostImageIdentityRef must be a domain-separated sha256 reference"
      );
    }
    if (provisioning.singleUse !== true) push("provisioning.singleUse must be literally true");
    const registration = provisioning.registration;
    if (!isRecord(registration)) {
      push("provisioning.registration block is required");
    } else {
      exactKeys(
        registration,
        legacy ? LEGACY_REGISTRATION_KEYS : REGISTRATION_KEYS,
        "provisioning.registration",
        issues
      );
      if (registration.repository !== CONTROLLED_RUNNER_REPOSITORY) {
        push(`registration.repository must be exactly ${CONTROLLED_RUNNER_REPOSITORY}`);
      }
      const labels = legacy ? registration.labels : registration.labelRefs;
      if (
        !Array.isArray(labels) ||
        labels.length === 0 ||
        labels.length > 32 ||
        labels.some((label) =>
          legacy
            ? !canonicalBoundedString(label, 200)
            : typeof label !== "string" ||
              !CONTROLLED_RUNNER_IDENTITY_REF_PATTERN.test(label)
        ) ||
        new Set(labels).size !== labels.length ||
        (!legacy &&
          labels.some(
            (label, index) =>
              index > 0 && label.localeCompare(labels[index - 1]) <= 0
          ))
      ) {
        push(
          legacy
            ? "registration.labels must list 1 through 32 unique canonical runner labels"
            : "registration.labelRefs must list 1 through 32 unique sorted domain-separated sha256 references"
        );
      } else if (
        legacy
          ? nonEmptyString(receipt.runnerLabel) &&
            !labels.includes(receipt.runnerLabel)
          : typeof receipt.runnerLabelRef === "string" &&
            !labels.includes(receipt.runnerLabelRef)
      ) {
        push(
          legacy
            ? "registration.labels must include runnerLabel exactly"
            : "registration.labelRefs must include runnerLabelRef exactly"
        );
      }
      if (registration.ephemeral !== true) push("registration.ephemeral must be literally true");
    }
  }

  const runEvidence = receipt.runEvidence;
  if (!isRecord(runEvidence)) {
    push("runEvidence block is required");
  } else {
    exactKeys(runEvidence, RUN_EVIDENCE_KEYS, "runEvidence", issues);
    if (runEvidence.conclusion !== "success") push("runEvidence.conclusion must be exactly success");
    if (runEvidence.reportMode !== "r2") push("runEvidence.reportMode must be exactly r2");
    if (runEvidence.acquisition !== "ci-workflow") {
      push("runEvidence.acquisition must be exactly ci-workflow");
    }
    if (typeof runEvidence.headSha !== "string" || !FULL_GIT_SHA.test(runEvidence.headSha)) {
      push("runEvidence.headSha must be a full lowercase Git commit");
    }
    if (!CONTROLLED_RUNNER_CATALOGS.has(runEvidence.catalog)) {
      push("runEvidence.catalog must name one committed featured collection catalog");
    }
    if (!collectionDate(runEvidence.collectionDate)) {
      push("runEvidence.collectionDate must be a real YYYY-MM-DD UTC date");
    }

    const job = runEvidence.job;
    if (!isRecord(job)) {
      push("runEvidence.job block is required");
    } else {
      exactKeys(job, JOB_KEYS, "runEvidence.job", issues);
      if (!positiveSafeInteger(job.id)) push("runEvidence.job.id must be a positive integer");
      if (job.name !== CONTROLLED_RUNNER_JOB) {
        push(`runEvidence.job.name must be exactly ${CONTROLLED_RUNNER_JOB}`);
      }
      if (!isoTimestamp(job.startedAt)) push("runEvidence.job.startedAt must be ISO 8601");
      if (!isoTimestamp(job.completedAt)) push("runEvidence.job.completedAt must be ISO 8601");
      if (
        positiveSafeInteger(receipt.actionsRunId) &&
        positiveSafeInteger(job.id) &&
        job.url !== exactJobUrl(receipt.actionsRunId, job.id)
      ) {
        push("runEvidence.job.url must bind the exact repository, Actions run id, and job id");
      }
      if (
        isoTimestamp(job.startedAt) &&
        isoTimestamp(job.completedAt) &&
        Date.parse(job.completedAt) <= Date.parse(job.startedAt)
      ) {
        push("runEvidence.job.completedAt must be after runEvidence.job.startedAt");
      }
      if (
        collectionDate(runEvidence.collectionDate) &&
        isoTimestamp(job.startedAt) &&
        new Date(job.startedAt).toISOString().slice(0, 10) !== runEvidence.collectionDate
      ) {
        push("runEvidence.collectionDate must equal the UTC date of runEvidence.job.startedAt");
      }
      if (
        isRecord(provisioning) &&
        isoTimestamp(provisioning.provisionedAt) &&
        isoTimestamp(job.startedAt) &&
        Date.parse(provisioning.provisionedAt) > Date.parse(job.startedAt)
      ) {
        push("provisioning.provisionedAt must not be after runEvidence.job.startedAt");
      }
    }

    const artifact = runEvidence.artifact;
    if (!isRecord(artifact)) {
      push("runEvidence.artifact block is required");
    } else {
      exactKeys(artifact, ARTIFACT_KEYS, "runEvidence.artifact", issues);
      if (!positiveSafeInteger(artifact.id)) push("runEvidence.artifact.id must be a positive integer");
      const expectedArtifactName =
        positiveSafeInteger(receipt.actionsRunId) &&
        Number.isSafeInteger(receipt.actionsRunAttempt) &&
        receipt.actionsRunAttempt > 0
          ? `site-behavior-featured-publication-${receipt.actionsRunId}-${receipt.actionsRunAttempt}`
          : null;
      if (expectedArtifactName !== null && artifact.name !== expectedArtifactName) {
        push("runEvidence.artifact.name must bind the exact Actions run id and attempt");
      }
      if (typeof artifact.sha256 !== "string" || !SHA256.test(artifact.sha256)) {
        push("runEvidence.artifact.sha256 must be a lowercase sha256 digest");
      }
      if (
        positiveSafeInteger(receipt.actionsRunId) &&
        positiveSafeInteger(artifact.id) &&
        artifact.url !== exactArtifactUrl(receipt.actionsRunId, artifact.id)
      ) {
        push("runEvidence.artifact.url must bind the exact repository, Actions run id, and artifact id");
      }
    }
  }

  const isolation = receipt.isolation;
  if (!isRecord(isolation)) {
    push("isolation block is required");
  } else {
    exactKeys(isolation, ISOLATION_KEYS, "isolation", issues);
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
    exactKeys(
      egress,
      legacy ? LEGACY_EGRESS_KEYS : EGRESS_KEYS,
      "egress",
      issues
    );
    if (
      !canonicalBoundedString(egress.declaredRegion, 32) ||
      !PUBLIC_REGION.test(egress.declaredRegion)
    ) {
      push("egress.declaredRegion must be a coarse public region label");
    }
    if (legacy) {
      if (!canonicalBoundedString(egress.natIdentity)) {
        push("egress.natIdentity must identify the outbound NAT");
      }
    } else if (
      typeof egress.natIdentityRef !== "string" ||
      !CONTROLLED_RUNNER_IDENTITY_REF_PATTERN.test(egress.natIdentityRef)
    ) {
      push("egress.natIdentityRef must be a domain-separated sha256 reference");
    }
    if (egress.independentPolicyEnforced !== true) {
      push("egress.independentPolicyEnforced must be literally true");
    }
    if (
      !Array.isArray(egress.blockedClasses) ||
      egress.blockedClasses.length > 32 ||
      egress.blockedClasses.some((entry) => !canonicalBoundedString(entry, 100)) ||
      new Set(egress.blockedClasses).size !== egress.blockedClasses.length ||
      !["private", "link-local", "metadata"].every((required) => egress.blockedClasses.includes(required))
    ) {
      push("egress.blockedClasses must be unique canonical values including private, link-local, and metadata");
    }
  }

  const destruction = receipt.destruction;
  if (!isRecord(destruction)) {
    push("destruction block is required");
  } else {
    exactKeys(destruction, DESTRUCTION_KEYS, "destruction", issues);
    if (!isoTimestamp(destruction.destroyedAt)) push("destruction.destroyedAt must be ISO 8601");
    if (!isoTimestamp(destruction.verifiedAbsentAt)) push("destruction.verifiedAbsentAt must be ISO 8601");
    if (
      legacy
        ? !canonicalBoundedString(destruction.method)
        : destruction.method !== V3_DESTRUCTION_METHOD
    ) {
      push(
        legacy
          ? "destruction.method must describe how the host was destroyed"
          : `destruction.method must be exactly ${V3_DESTRUCTION_METHOD}`
      );
    }
    if (
      legacy
        ? !canonicalBoundedString(destruction.verification)
        : typeof destruction.verification !== "string" ||
          !SHA256_REF.test(destruction.verification)
    ) {
      push(
        legacy
          ? "destruction.verification must reference the absence evidence"
          : "destruction.verification must be an exact sha256 readback reference"
      );
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
    const runJob = isRecord(runEvidence) && isRecord(runEvidence.job) ? runEvidence.job : null;
    if (
      runJob &&
      isoTimestamp(runJob.completedAt) &&
      isoTimestamp(destruction.destroyedAt) &&
      Date.parse(destruction.destroyedAt) <= Date.parse(runJob.completedAt)
    ) {
      push("destruction.destroyedAt must be after runEvidence.job.completedAt");
    }
    if (
      isoTimestamp(destruction.verifiedAbsentAt) &&
      isoTimestamp(receipt.recordedAt) &&
      Date.parse(receipt.recordedAt) <= Date.parse(destruction.verifiedAbsentAt)
    ) {
      push("recordedAt must be after destruction.verifiedAbsentAt");
    }
  }

  const destructionEvidence = receipt.destructionEvidence;
  if (!legacy) {
    if (!isRecord(destructionEvidence)) {
      push("destructionEvidence block is required");
    } else {
      exactKeys(
        destructionEvidence,
        DESTRUCTION_EVIDENCE_KEYS,
        "destructionEvidence",
        issues
      );
      if (
        destructionEvidence.workflow !==
        DESTRUCTION_EVIDENCE_WORKFLOW
      ) {
        push(
          `destructionEvidence.workflow must be exactly ${DESTRUCTION_EVIDENCE_WORKFLOW}`
        );
      }
      if (!positiveSafeInteger(destructionEvidence.runId)) {
        push("destructionEvidence.runId must be a positive integer");
      }
      if (
        !Number.isSafeInteger(destructionEvidence.runAttempt) ||
        destructionEvidence.runAttempt < 1 ||
        destructionEvidence.runAttempt > 100
      ) {
        push(
          "destructionEvidence.runAttempt must be an integer from 1 through 100"
        );
      }
      if (
        typeof destructionEvidence.headSha !== "string" ||
        !FULL_GIT_SHA.test(destructionEvidence.headSha)
      ) {
        push(
          "destructionEvidence.headSha must be a full lowercase Git commit"
        );
      }
      if (destructionEvidence.conclusion !== "success") {
        push("destructionEvidence.conclusion must be exactly success");
      }

      const destructionJob = destructionEvidence.job;
      if (!isRecord(destructionJob)) {
        push("destructionEvidence.job block is required");
      } else {
        exactKeys(
          destructionJob,
          JOB_KEYS,
          "destructionEvidence.job",
          issues
        );
        if (!positiveSafeInteger(destructionJob.id)) {
          push("destructionEvidence.job.id must be a positive integer");
        }
        if (destructionJob.name !== DESTRUCTION_EVIDENCE_JOB) {
          push(
            `destructionEvidence.job.name must be exactly ${DESTRUCTION_EVIDENCE_JOB}`
          );
        }
        if (!isoTimestamp(destructionJob.startedAt)) {
          push(
            "destructionEvidence.job.startedAt must be ISO 8601"
          );
        }
        if (!isoTimestamp(destructionJob.completedAt)) {
          push(
            "destructionEvidence.job.completedAt must be ISO 8601"
          );
        }
        if (
          positiveSafeInteger(destructionEvidence.runId) &&
          positiveSafeInteger(destructionJob.id) &&
          destructionJob.url !==
            exactJobUrl(
              destructionEvidence.runId,
              destructionJob.id
            )
        ) {
          push(
            "destructionEvidence.job.url must bind the exact hosted destruction run and job"
          );
        }
        if (
          isoTimestamp(destructionJob.startedAt) &&
          isoTimestamp(destructionJob.completedAt) &&
          Date.parse(destructionJob.completedAt) <=
            Date.parse(destructionJob.startedAt)
        ) {
          push(
            "destructionEvidence.job.completedAt must be after startedAt"
          );
        }
        if (
          isRecord(destruction) &&
          isoTimestamp(destruction.verifiedAbsentAt) &&
          isoTimestamp(destructionJob.completedAt) &&
          Date.parse(destructionJob.completedAt) <
            Date.parse(destruction.verifiedAbsentAt)
        ) {
          push(
            "destructionEvidence hosted readback must complete after absence was verified"
          );
        }
        if (
          isoTimestamp(destructionJob.completedAt) &&
          isoTimestamp(receipt.recordedAt) &&
          Date.parse(receipt.recordedAt) <=
            Date.parse(destructionJob.completedAt)
        ) {
          push(
            "receipt recordedAt must follow the hosted destruction readback job"
          );
        }
      }

      const destructionArtifact = destructionEvidence.artifact;
      if (!isRecord(destructionArtifact)) {
        push("destructionEvidence.artifact block is required");
      } else {
        exactKeys(
          destructionArtifact,
          ARTIFACT_KEYS,
          "destructionEvidence.artifact",
          issues
        );
        if (!positiveSafeInteger(destructionArtifact.id)) {
          push(
            "destructionEvidence.artifact.id must be a positive integer"
          );
        }
        const expectedArtifactName =
          positiveSafeInteger(destructionEvidence.runId) &&
          Number.isSafeInteger(destructionEvidence.runAttempt) &&
          destructionEvidence.runAttempt > 0
            ? `site-behavior-runner-destruction-evidence-${destructionEvidence.runId}-${destructionEvidence.runAttempt}`
            : null;
        if (
          expectedArtifactName !== null &&
          destructionArtifact.name !== expectedArtifactName
        ) {
          push(
            "destructionEvidence.artifact.name must bind the exact hosted destruction run and attempt"
          );
        }
        if (
          typeof destructionArtifact.sha256 !== "string" ||
          !SHA256.test(destructionArtifact.sha256)
        ) {
          push(
            "destructionEvidence.artifact.sha256 must be a lowercase sha256 digest"
          );
        }
        if (
          positiveSafeInteger(destructionEvidence.runId) &&
          positiveSafeInteger(destructionArtifact.id) &&
          destructionArtifact.url !==
            exactArtifactUrl(
              destructionEvidence.runId,
              destructionArtifact.id
            )
        ) {
          push(
            "destructionEvidence.artifact.url must bind the exact hosted destruction artifact"
          );
        }
      }

      const readback = destructionEvidence.readback;
      if (!isRecord(readback)) {
        push("destructionEvidence.readback block is required");
      } else {
        exactKeys(
          readback,
          DESTRUCTION_READBACK_KEYS,
          "destructionEvidence.readback",
          issues
        );
        if (readback.path !== "destruction-evidence.json") {
          push(
            "destructionEvidence.readback.path must be exactly destruction-evidence.json"
          );
        }
        if (
          typeof readback.sha256 !== "string" ||
          !SHA256.test(readback.sha256)
        ) {
          push(
            "destructionEvidence.readback.sha256 must be a lowercase sha256 digest"
          );
        }
        if (
          isRecord(destruction) &&
          destruction.verification !==
            `sha256:${readback.sha256}`
        ) {
          push(
            "destruction.verification must bind the exact hosted readback digest"
          );
        }
      }
    }
  }

  const operator = receipt.operator;
  if (!isRecord(operator)) {
    push("operator block is required");
  } else {
    exactKeys(operator, OPERATOR_KEYS, "operator", issues);
    if (!canonicalBoundedString(operator.attestedBy)) push("operator.attestedBy must name the attesting operator");
    const expectedEvidenceRefCount = legacy ? null : 2;
    if (
      !Array.isArray(operator.evidenceRefs) ||
      (legacy
        ? operator.evidenceRefs.length === 0 ||
          operator.evidenceRefs.length > 32
        : operator.evidenceRefs.length !== expectedEvidenceRefCount)
    ) {
      push(
        legacy
          ? "operator.evidenceRefs must contain 1 through 32 structured evidence artifacts"
          : "operator.evidenceRefs must contain exactly the collection and hosted destruction artifacts"
      );
    } else {
      const seenEvidence = new Set();
      const seenArtifactDigests = new Set();
      let collectionArtifactBound = legacy;
      let hostedDestructionArtifactBound = legacy;
      for (const [index, evidence] of operator.evidenceRefs.entries()) {
        const label = `operator.evidenceRefs[${index}]`;
        if (!exactKeys(evidence, OPERATOR_EVIDENCE_REF_KEYS, label, issues)) continue;
        if (evidence.kind !== RUN_EVIDENCE_REF_KIND) {
          push(`${label}.kind must be exactly ${RUN_EVIDENCE_REF_KIND}`);
        }
        const permittedRunIds = new Set([
          receipt.actionsRunId,
          destructionEvidence?.runId
        ]);
        if (!permittedRunIds.has(evidence.actionsRunId)) {
          push(
            `${label}.actionsRunId must match the collection or hosted destruction run id`
          );
        }
        if (
          positiveSafeInteger(evidence.actionsRunId) &&
          evidence.runUrl !== exactRunUrl(evidence.actionsRunId)
        ) {
          push(
            `${label}.runUrl must bind its exact repository and Actions run id`
          );
        }
        if (!canonicalBoundedString(evidence.artifactName, 200)) {
          push(`${label}.artifactName must name the immutable evidence artifact`);
        }
        if (!canonicalBoundedString(evidence.artifactRef)) {
          push(`${label}.artifactRef must locate the immutable evidence artifact`);
        }
        if (typeof evidence.artifactSha256 !== "string" || !SHA256.test(evidence.artifactSha256)) {
          push(`${label}.artifactSha256 must be a lowercase sha256 digest`);
        }
        const evidenceIdentity = OPERATOR_EVIDENCE_REF_KEYS
          .map((key) => `${key}=${String(evidence[key])}`)
          .join("\u0000");
        if (seenEvidence.has(evidenceIdentity)) push(`${label} duplicates an earlier evidence reference`);
        seenEvidence.add(evidenceIdentity);
        if (seenArtifactDigests.has(evidence.artifactSha256)) {
          push(`${label}.artifactSha256 duplicates an earlier evidence artifact`);
        }
        seenArtifactDigests.add(evidence.artifactSha256);
        if (
          isRecord(runEvidence?.artifact) &&
          evidence.actionsRunId === receipt.actionsRunId &&
          evidence.artifactName === runEvidence.artifact.name &&
          evidence.artifactRef === runEvidence.artifact.url &&
          evidence.artifactSha256 === runEvidence.artifact.sha256
        ) {
          collectionArtifactBound = true;
        }
        if (
          isRecord(destructionEvidence?.artifact) &&
          evidence.actionsRunId === destructionEvidence.runId &&
          evidence.artifactName ===
            destructionEvidence.artifact.name &&
          evidence.artifactRef ===
            destructionEvidence.artifact.url &&
          evidence.artifactSha256 ===
            destructionEvidence.artifact.sha256
        ) {
          hostedDestructionArtifactBound = true;
        }
      }
      if (!collectionArtifactBound) {
        push(
          "operator.evidenceRefs must bind the exact collection artifact"
        );
      }
      if (!hostedDestructionArtifactBound) {
        push(
          "operator.evidenceRefs must bind the exact hosted destruction artifact"
        );
      }
    }
  }
  return issues;
}

/**
 * Full set consistency, with optional release-owned bindings:
 *
 * - expectedCandidateCommit binds every workflow source to an exact reviewed
 *   candidate when the release process keeps one immutable source SHA.
 * - expectedEnvironmentDigest binds the compatible tuple to the reviewed
 *   runner/NAT configuration instead of accepting any internally consistent
 *   environment.
 * - epochStartedAt excludes pre-freeze cycles.
 * - now rejects future evidence; maxAgeDays additionally rejects stale cycles.
 *
 * A release flow that permits data-only commits after freeze should bind a
 * separately governed measurement-input digest before using this exact-SHA
 * option; it must not pretend those later source SHAs equal the activation SHA.
 */
export function runnerDestructionReceiptSetIssues(receipts, options = {}) {
  if (!Array.isArray(receipts)) return ["receipts must be an array"];
  if (!isRecord(options)) return ["receipt-set options must be an object"];

  const issues = [];
  if (receipts.length < 2) {
    issues.push("receipt set must contain at least two controlled cycles");
  }
  const unknownOptions = Object.keys(options).filter((key) => !SET_OPTION_KEYS.includes(key));
  if (unknownOptions.length > 0) {
    issues.push(`receipt-set options contain unknown keys: ${unknownOptions.sort().join(", ")}`);
  }
  if (
    options.expectedCandidateCommit !== undefined &&
    (typeof options.expectedCandidateCommit !== "string" ||
      !FULL_GIT_SHA.test(options.expectedCandidateCommit))
  ) {
    issues.push("expectedCandidateCommit must be a full lowercase Git commit");
  }
  if (
    options.expectedEnvironmentDigest !== undefined &&
    (typeof options.expectedEnvironmentDigest !== "string" ||
      !SHA256.test(options.expectedEnvironmentDigest))
  ) {
    issues.push("expectedEnvironmentDigest must be a lowercase sha256 digest");
  }
  if (options.epochStartedAt !== undefined && !isoTimestamp(options.epochStartedAt)) {
    issues.push("epochStartedAt must be a canonical UTC instant");
  }
  if (
    options.now !== undefined &&
    (!Number.isSafeInteger(options.now) || options.now < 0)
  ) {
    issues.push("now must be a non-negative integer Unix timestamp in milliseconds");
  }
  if (
    options.maxAgeDays !== undefined &&
    (!Number.isSafeInteger(options.maxAgeDays) ||
      options.maxAgeDays < 1 ||
      options.maxAgeDays > 365)
  ) {
    issues.push("maxAgeDays must be an integer from 1 through 365");
  }
  if (options.maxAgeDays !== undefined && options.now === undefined) {
    issues.push("maxAgeDays requires an explicit now timestamp");
  }

  const individuallyValid = [];
  for (let index = 0; index < receipts.length; index += 1) {
    const receiptIssues = runnerDestructionReceiptIssues(receipts[index]);
    if (receiptIssues.length === 0) individuallyValid.push({ index, receipt: receipts[index] });
    else {
      for (const issue of receiptIssues) issues.push(`receipt ${index + 1}: ${issue}`);
    }
  }
  if (individuallyValid.length !== receipts.length) return [...new Set(issues)];

  const seenCollectionDates = new Map();
  const seenRunIds = new Map();
  const referenceEnvironment = receipts.length > 0
    ? canonicalize(runnerDestructionEnvironmentTuple(receipts[0]))
    : null;
  const referenceEnvironmentDigest = receipts.length > 0
    ? runnerDestructionEnvironmentDigest(receipts[0])
    : null;
  if (
    typeof options.expectedEnvironmentDigest === "string" &&
    SHA256.test(options.expectedEnvironmentDigest) &&
    referenceEnvironmentDigest !== null &&
    referenceEnvironmentDigest !== options.expectedEnvironmentDigest
  ) {
    issues.push("controlled runner environment does not match expectedEnvironmentDigest");
  }
  for (let index = 0; index < receipts.length; index += 1) {
    const receipt = receipts[index];
    const date = receipt.runEvidence.collectionDate;
    const priorDate = seenCollectionDates.get(date);
    if (priorDate !== undefined) {
      issues.push(
        `receipt ${index + 1} runEvidence.collectionDate ${date} duplicates receipt ${priorDate + 1}; controlled cycles must use distinct UTC collection dates`
      );
    } else {
      seenCollectionDates.set(date, index);
    }

    const priorRun = seenRunIds.get(receipt.actionsRunId);
    if (priorRun !== undefined) {
      issues.push(
        `receipt ${index + 1} actionsRunId ${receipt.actionsRunId} duplicates receipt ${priorRun + 1}; a rerun is not a second controlled cycle`
      );
    } else {
      seenRunIds.set(receipt.actionsRunId, index);
    }

    if (
      referenceEnvironment !== null &&
      canonicalize(runnerDestructionEnvironmentTuple(receipt)) !== referenceEnvironment
    ) {
      issues.push(
        `receipt ${index + 1} does not match the first cycle's controlled runner environment tuple`
      );
    }
    if (
      typeof options.expectedCandidateCommit === "string" &&
      FULL_GIT_SHA.test(options.expectedCandidateCommit) &&
      receipt.runEvidence.headSha !== options.expectedCandidateCommit
    ) {
      issues.push(
        `receipt ${index + 1} source ${receipt.runEvidence.headSha} does not match expectedCandidateCommit`
      );
    }

    const jobStartedAt = Date.parse(receipt.runEvidence.job.startedAt);
    const recordedAt = Date.parse(receipt.recordedAt);
    if (
      isoTimestamp(options.epochStartedAt) &&
      jobStartedAt < Date.parse(options.epochStartedAt)
    ) {
      issues.push(`receipt ${index + 1} acquisition began before epochStartedAt`);
    }
    if (Number.isSafeInteger(options.now) && options.now >= 0) {
      if (recordedAt > options.now) {
        issues.push(`receipt ${index + 1} recordedAt is in the future`);
      } else if (
        Number.isSafeInteger(options.maxAgeDays) &&
        options.maxAgeDays >= 1 &&
        options.maxAgeDays <= 365 &&
        options.now - recordedAt > options.maxAgeDays * 86_400_000
      ) {
        issues.push(`receipt ${index + 1} recordedAt is older than ${options.maxAgeDays} days`);
      }
    }
  }
  return [...new Set(issues)];
}

/**
 * Canonical receipt bytes are recursively key-sorted JSON with one trailing
 * LF. Requiring the exact bytes makes duplicate keys, hidden alternate values,
 * and whitespace/key-order rewrites fail before a receipt is digested.
 */
export function serializeRunnerDestructionReceipt(receipt) {
  const issues = runnerDestructionReceiptIssues(receipt);
  if (issues.length > 0) {
    throw new Error(`Invalid runner destruction receipt: ${issues.join("; ")}`);
  }
  return `${canonicalize(receipt)}\n`;
}

export function parseCanonicalRunnerDestructionReceiptBytes(
  sourceBytes,
  label = "runner destruction receipt"
) {
  let bytes;
  if (typeof sourceBytes === "string") {
    bytes = Buffer.from(sourceBytes, "utf8");
  } else if (sourceBytes instanceof Uint8Array) {
    bytes = Buffer.from(
      sourceBytes.buffer,
      sourceBytes.byteOffset,
      sourceBytes.byteLength
    );
  } else {
    throw new Error(`${label} must be supplied as exact bytes`);
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} must contain valid UTF-8`);
  }
  let receipt;
  try {
    receipt = JSON.parse(text);
  } catch {
    throw new Error(`${label} must contain valid JSON`);
  }
  const canonicalBytes = `${canonicalize(receipt)}\n`;
  if (text !== canonicalBytes) {
    throw new Error(
      `${label} must use the exact canonical receipt serialization`
    );
  }
  return receipt;
}

/** Verify one receipt; a valid receipt gains its canonical file-byte digest. */
export function verifyRunnerDestructionReceipt(receipt) {
  const issues = runnerDestructionReceiptIssues(receipt);
  if (issues.length > 0) return { ok: false, issues, receiptDigest: null };
  return {
    ok: true,
    issues: [],
    receiptDigest: sha256Hex(serializeRunnerDestructionReceipt(receipt))
  };
}

/**
 * Readiness-friendly set verdict. The environment digest is returned only
 * after every receipt and cross-cycle invariant verifies.
 */
export function verifyRunnerDestructionReceiptSet(receipts, options = {}) {
  const issues = runnerDestructionReceiptSetIssues(receipts, options);
  if (issues.length > 0) {
    return {
      ok: false,
      issues,
      receiptDigests: [],
      environmentDigest: null,
      sourceCommits: [],
      earliestCollectionAt: null,
      latestRecordedAt: null
    };
  }
  const receiptDigests = receipts.map(
    (receipt) => sha256Hex(serializeRunnerDestructionReceipt(receipt))
  );
  const collectionTimes = receipts.map((receipt) =>
    Date.parse(receipt.runEvidence.job.startedAt)
  );
  const recordedTimes = receipts.map((receipt) => Date.parse(receipt.recordedAt));
  return {
    ok: true,
    issues: [],
    receiptDigests,
    environmentDigest:
      receipts.length > 0 ? runnerDestructionEnvironmentDigest(receipts[0]) : null,
    sourceCommits: [...new Set(receipts.map((receipt) => receipt.runEvidence.headSha))].sort(),
    earliestCollectionAt:
      collectionTimes.length > 0
        ? new Date(Math.min(...collectionTimes)).toISOString()
        : null,
    latestRecordedAt:
      recordedTimes.length > 0
        ? new Date(Math.max(...recordedTimes)).toISOString()
        : null
  };
}
