// Release-1.0 readiness evaluation over RELEASE_READINESS.json.
//
// The manifest is the SINGLE SOURCE of the 1.0 gates (contract duplication is
// this repository's top defect class, so workflows and humans read the same
// file this module reads). Three gate families:
//
// - decisions: recommended values recorded in the manifest stay RED until a
//   human sets status "approved" with decidedBy/decidedAt. The gate carries
//   its own requiredDecisions list, so DELETING a pending decision is a
//   failure, not an approval;
// - derived gates: re-derived from committed evidence on every run. No
//   self-declared verdict is trusted: A/A studies are re-scored from their
//   preregistration and ledger, lifecycle rules are re-validated from the
//   recorded rule bytes, review coverage is recomputed against the inventory,
//   and runner cycles are counted as DISTINCT Actions runs;
// - operator attestations: host truths code cannot see; a uniform contract
//   requiring literally-true statements, the manifest's exact targetRelease,
//   and a per-gate freshness bound.
//
// Every gate fails closed: missing, malformed, stale, or future-dated
// evidence and malformed GATE CONFIGURATION are failures with reasons, never
// skips. A crash in one evidence source is that gate's failure, never the
// evaluator's.
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync
} from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  parseCanonicalRunnerDestructionReceiptBytes,
  verifyRunnerDestructionReceipt,
  verifyRunnerDestructionReceiptSet
} from "./runner-receipt-lib.mjs";
import { verifyDurableReplayReceiptSet } from "./durable-replay-receipt-lib.mjs";
import {
  MEASUREMENT_FREEZE_ARCHIVE_PATH,
  parseAndVerifyMeasurementFreezeActivationReceipt
} from "./measurement-freeze-activation-lib.mjs";
import {
  verifyMeasurementFreezeActivationArtifactContext
} from "./measurement-freeze-artifact-lib.mjs";
import {
  validateContainerPackageReviewReadiness
} from "./container-image-package-reviews-lib.mjs";
import {
  parseCanonicalEvidence
} from "./operator-evidence-common.mjs";
import {
  EGRESS_BACKSTOP_EVIDENCE_PATH,
  validateEgressBackstopEvidence
} from "./egress-backstop-evidence-lib.mjs";
import {
  WAF_CEILING_EVIDENCE_PATH,
  validateWafCeilingEvidence
} from "./waf-ceiling-evidence-lib.mjs";
import {
  LOG_RETENTION_EVIDENCE_PATH,
  validateLogRetentionEvidence
} from "./log-retention-evidence-lib.mjs";
import {
  CONTAINER_LICENSING_EVIDENCE_PATH,
  CONTAINER_PACKAGE_INVENTORY_PATH as OPERATOR_CONTAINER_INVENTORY_PATH,
  CONTAINER_PACKAGE_REVIEW_LEDGER_PATH as OPERATOR_CONTAINER_REVIEW_LEDGER_PATH,
  validateContainerImageLicensingEvidence
} from "./container-image-licensing-evidence-lib.mjs";
import {
  CONTROLLED_PUBLICATION_ROOT,
  verifyControlledPublicationArtifact,
  verifyControlledPublicationDirectory
} from "./controlled-publication-receipt-lib.mjs";
import {
  validateR2LifecycleReadbackReceipt
} from "./r2-lifecycle-lib.mjs";
import { checkReviewLedger } from "./third-party-reviews-lib.mjs";
import { evaluateAaStudy } from "./aa-study-lib.mjs";
import {
  CALIBRATION_CENSORING_POLICY_ID,
  CALIBRATION_CENSORING_POLICY_PATH,
  calibrationPolicyDispositionSha256
} from "./calibration-study-lib.mjs";
import {
  RELEASE_TAG_GOVERNANCE_RECEIPT_PATH,
  RELEASE_TAG_GOVERNANCE_MAX_AGE_DAYS,
  releaseTagGovernanceReceiptFreshnessProblems,
  releaseTagGovernanceReceiptProblems,
  serializeReleaseTagGovernanceReceipt
} from "./release-tag-governance-receipt-lib.mjs";
import {
  HOSTED_EVIDENCE_BUNDLE_FILE,
  HOSTED_EVIDENCE_CONTEXT_FILE,
  HOSTED_EVIDENCE_ARCHIVER_WORKFLOW_PATH,
  hostedEvidenceArchiveRelativePath,
  hostedEvidenceSourceClosureProblems,
  parseAndVerifyHostedEvidenceContext,
  verifyHostedEvidenceDirectory
} from "./hosted-evidence-provenance-lib.mjs";

const requireFromHere = createRequire(import.meta.url);
const SHA256 = /^[0-9a-f]{64}$/;
const FULL_GIT_SHA = /^[0-9a-f]{40}$/;
const CANONICAL_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const MAX_EVIDENCE_STRING = 512;
// Tolerate small clock skew between evidence writers and the evaluator, but
// never a genuinely future-dated artifact: a mistyped year must not read as
// "fresh forever".
const FUTURE_SKEW_MS = 10 * 60 * 1000;
// Git commit timestamps have one-second precision while evidence timestamps
// retain milliseconds. This allowance covers only that representation gap;
// it is not a general clock-skew window.
const GIT_TIMESTAMP_PRECISION_SKEW_MS = 1_000;

export const READINESS_MANIFEST = "RELEASE_READINESS.json";
export const OPERATOR_ATTESTATION_KIND = "site-behavior-operator-attestation";
const MEASUREMENT_CANDIDATE_BINDING_PATH = "research/measurement-candidate-binding.json";
const CONTAINER_PACKAGE_INVENTORY_PATH =
  "research/measurement-candidate/site-behavior-lab-container-package-inventory.json";
const CONTAINER_PACKAGE_INVENTORY_BUNDLE_PATH =
  "research/measurement-candidate/container-package-inventory.bundle.json";
const CONTAINER_PACKAGE_REVIEW_LEDGER_PATH = "CONTAINER_IMAGE_PACKAGE_REVIEWS.json";
const DURABLE_ENABLE_TRANSITION_RECEIPT_PATH =
  "research/ops-receipts/durable-enable-transition.json";
const DURABLE_PRODUCTION_CONFIG_PATH = "wrangler.container.jsonc";
const MEASUREMENT_AA_EVIDENCE_CATEGORIES = Object.freeze([
  "aa-attempt-ledger",
  "aa-evaluation",
  "aa-producer-receipt",
  "aa-producer-attestation"
]);

const REQUIRED_MEASUREMENT_EVIDENCE_CATEGORIES = Object.freeze([
  "featured-report",
  "featured-provenance",
  "generated-report-index",
  "generated-corpus-stats",
  "runner-receipt",
  "controlled-publication-manifest",
  "controlled-publication-receipt",
  "aa-attempt-ledger",
  "aa-evaluation",
  "aa-producer-receipt",
  "aa-producer-attestation",
  "hosted-evidence-archive",
  "measurement-freeze-receipt",
  "lifecycle-receipt",
  "operator-evidence",
  "operator-attestation",
  "release-policy-finalization",
  "citation-finalization",
  "changelog-finalization"
]);

/**
 * The deferral predicate is defined ONCE, in the compiled binding verifier
 * (measurementGateKindRequired), which also derives the binding's own
 * calibration-study floor from the manifest. This module only consumes it;
 * when the compiled verifier is unavailable the category checks are skipped
 * because the binding gate already fails on the missing module.
 */
function requiredMeasurementEvidenceCategories(manifest, gateKindRequired) {
  if (gateKindRequired(manifest, "aa-study")) {
    return REQUIRED_MEASUREMENT_EVIDENCE_CATEGORIES;
  }
  return REQUIRED_MEASUREMENT_EVIDENCE_CATEGORIES.filter(
    (category) => !MEASUREMENT_AA_EVIDENCE_CATEGORIES.includes(category)
  );
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyStringArray(value) {
  return Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === "string" && entry.length > 0);
}

function isCanonicalBoundedString(value, maximumLength = MAX_EVIDENCE_STRING) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumLength &&
    value === value.trim() &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function hasDuplicates(values) {
  return new Set(values).size !== values.length;
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function sha256OfFile(filePath) {
  const { createHash } = requireFromHere("node:crypto");
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function sha256OfBytes(bytes) {
  const { createHash } = requireFromHere("node:crypto");
  return createHash("sha256").update(bytes).digest("hex");
}

function gateResult(id, gate, status, reasons = []) {
  return { id, title: gate.title ?? id, kind: gate.kind, status, reasons };
}

function canonicalInstantMillis(value) {
  if (typeof value !== "string" || !CANONICAL_INSTANT.test(value)) return null;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return null;
  const normalizedInput = value.includes(".") ? value : `${value.slice(0, -1)}.000Z`;
  return new Date(parsed).toISOString() === normalizedInput ? parsed : null;
}

/** null when the timestamp is a plausible, non-future, non-stale instant. */
function timestampProblem(label, value, now, maxAgeDays) {
  const parsed = canonicalInstantMillis(value);
  if (parsed === null) return `${label} is missing, invalid, or not a real canonical UTC instant`;
  if (parsed > now + FUTURE_SKEW_MS) return `${label} (${value}) is in the future`;
  if (maxAgeDays !== undefined && now - parsed > maxAgeDays * 86_400_000) {
    return `${label} is older than ${maxAgeDays} days; re-capture the evidence`;
  }
  return null;
}

function decisionProblems(name, decision, now = Date.now()) {
  if (!isRecord(decision)) return [`decision ${name} is malformed`];
  if (decision.status !== "approved") return [`decision ${name} is ${decision.status ?? "undeclared"}`];
  const problems = [];
  if (typeof decision.decidedBy !== "string" || decision.decidedBy.trim().length === 0) {
    problems.push(`decision ${name} is approved without decidedBy`);
  }
  const decidedAtProblem = timestampProblem(`decision ${name} decidedAt`, decision.decidedAt, now);
  if (decidedAtProblem) problems.push(decidedAtProblem);
  return problems;
}

function calibrationCensoringDecisionProblems(
  decision,
  rootDir,
  measurementContext
) {
  const problems = [];
  if (!isRecord(decision)) {
    return ["decision calibrationCensoringPolicy is malformed"];
  }
  if (
    !Array.isArray(decision.currentlySupportedSelections) ||
    decision.currentlySupportedSelections.length !== 1 ||
    decision.currentlySupportedSelections[0] !==
      CALIBRATION_CENSORING_POLICY_ID
  ) {
    problems.push(
      `decision calibrationCensoringPolicy must expose exactly the supported selection ${CALIBRATION_CENSORING_POLICY_ID}`
    );
  }
  if (
    decision.recommendedDisposition !==
    "human-decision-required-before-labeling"
  ) {
    problems.push(
      "decision calibrationCensoringPolicy recommendedDisposition must remain human-decision-required-before-labeling"
    );
  }
  if (decision.selected !== CALIBRATION_CENSORING_POLICY_ID) {
    problems.push(
      `decision calibrationCensoringPolicy must select ${CALIBRATION_CENSORING_POLICY_ID}`
    );
  }
  if (decision.policyArtifactPath !== CALIBRATION_CENSORING_POLICY_PATH) {
    problems.push(
      `decision calibrationCensoringPolicy policyArtifactPath must be ${CALIBRATION_CENSORING_POLICY_PATH}`
    );
  }
  if (
    !isRecord(decision.semanticDisposition) ||
    !hasExactKeys(decision.semanticDisposition, [
      "anyCensoredCase",
      "plannedDenominator"
    ]) ||
    decision.semanticDisposition.anyCensoredCase !== "study-ineligible" ||
    decision.semanticDisposition.plannedDenominator !==
      "must-remain-complete"
  ) {
    problems.push(
      "decision calibrationCensoringPolicy semanticDisposition must be exactly anyCensoredCase=study-ineligible and plannedDenominator=must-remain-complete"
    );
  }
  if (
    typeof decision.policyArtifactSha256 !== "string" ||
    !SHA256.test(decision.policyArtifactSha256)
  ) {
    problems.push(
      "decision calibrationCensoringPolicy must pin the candidate policy artifact sha256"
    );
    return problems;
  }
  const policyAbsolute = path.join(
    rootDir,
    ...CALIBRATION_CENSORING_POLICY_PATH.split("/")
  );
  if (!existsSync(policyAbsolute)) {
    problems.push(
      `${CALIBRATION_CENSORING_POLICY_PATH} does not exist`
    );
  } else if (
    sha256OfFile(policyAbsolute) !== decision.policyArtifactSha256
  ) {
    problems.push(
      "decision calibrationCensoringPolicy policyArtifactSha256 does not match the exact policy bytes"
    );
  }
  const expectedDisposition = calibrationPolicyDispositionSha256(
    decision.policyArtifactSha256
  );
  if (decision.dispositionSha256 !== expectedDisposition) {
    problems.push(
      `decision calibrationCensoringPolicy dispositionSha256 must be ${expectedDisposition}`
    );
  }
  const verified = measurementContext?.binding?.calibrationPolicy;
  if (
    verified &&
    (
      verified.id !== decision.selected ||
      verified.policyArtifactPath !== decision.policyArtifactPath ||
      verified.policyArtifactSha256 !== decision.policyArtifactSha256 ||
      verified.dispositionSha256 !== decision.dispositionSha256 ||
      verified.anyCensoredCase !==
        decision.semanticDisposition?.anyCensoredCase ||
      verified.plannedDenominator !==
        decision.semanticDisposition?.plannedDenominator
    )
  ) {
    problems.push(
      "decision calibrationCensoringPolicy does not match the verified measurement candidate policy"
    );
  }
  return problems;
}

function evaluateDecisions(
  id,
  gate,
  manifest,
  rootDir,
  now,
  measurementContext
) {
  if (!isNonEmptyStringArray(gate.requiredDecisions)) {
    return gateResult(id, gate, "fail", ["gate config: requiredDecisions must name every governed decision"]);
  }
  const reasons = [];
  const decisions = isRecord(manifest.decisions) ? manifest.decisions : {};
  for (const name of gate.requiredDecisions) {
    if (!(name in decisions)) {
      reasons.push(`required decision ${name} is missing from the manifest; deleting a decision is not approving it`);
      continue;
    }
    reasons.push(...decisionProblems(name, decisions[name], now));
    if (name === "calibrationCensoringPolicy") {
      reasons.push(
        ...calibrationCensoringDecisionProblems(
          decisions[name],
          rootDir,
          measurementContext
        )
      );
    }
  }
  for (const [name, decision] of Object.entries(decisions)) {
    if (!gate.requiredDecisions.includes(name)) {
      reasons.push(...decisionProblems(name, decision, now));
      if (name === "calibrationCensoringPolicy") {
        reasons.push(
          ...calibrationCensoringDecisionProblems(
            decision,
            rootDir,
            measurementContext
          )
        );
      }
    }
  }
  return gateResult(id, gate, reasons.length === 0 ? "pass" : "fail", reasons);
}

function evaluateDocumentDigest(id, gate, manifest, rootDir) {
  const decision = manifest.decisions?.compatibilitySurface;
  if (!isRecord(decision) || typeof decision.document !== "string" || decision.document.length === 0) {
    return gateResult(id, gate, "fail", ["the compatibilitySurface decision names no document"]);
  }
  const documentPath = path.join(rootDir, decision.document);
  if (!existsSync(documentPath)) {
    return gateResult(id, gate, "fail", [`${decision.document} does not exist`]);
  }
  const reasons = [];
  if (typeof decision.sha256 !== "string" || !SHA256.test(decision.sha256)) {
    reasons.push("the compatibilitySurface decision pins no valid sha256");
  } else if (sha256OfFile(documentPath) !== decision.sha256) {
    reasons.push(`${decision.document} does not match the pinned digest; approve the edit by updating the pin`);
  }
  return gateResult(id, gate, reasons.length === 0 ? "pass" : "fail", reasons);
}

function evaluateReleaseTagGovernance(id, gate, rootDir, now) {
  const reasons = [];
  const promotionWorkflows = [
    ".github/workflows/ci.yml",
    ".github/workflows/promote-production.yml"
  ];
  const releaseWorkflow = ".github/workflows/release.yml";
  if (gate.artifact !== RELEASE_TAG_GOVERNANCE_RECEIPT_PATH) {
    reasons.push(
      `gate config: artifact must be ${RELEASE_TAG_GOVERNANCE_RECEIPT_PATH}`
    );
  }
  if (
    JSON.stringify(gate.promotionWorkflows) !==
    JSON.stringify(promotionWorkflows)
  ) {
    reasons.push(
      `gate config: promotionWorkflows must be exactly ${promotionWorkflows.join(", ")}`
    );
  }
  if (gate.releaseWorkflow !== releaseWorkflow) {
    reasons.push(`gate config: releaseWorkflow must be ${releaseWorkflow}`);
  }
  if (typeof gate.sha256 !== "string" || !SHA256.test(gate.sha256)) {
    reasons.push(
      "gate config: sha256 must pin the maintainer-reviewed governance receipt"
    );
  }
  if (gate.maxAgeDays !== RELEASE_TAG_GOVERNANCE_MAX_AGE_DAYS) {
    reasons.push(
      `gate config: maxAgeDays must be ${RELEASE_TAG_GOVERNANCE_MAX_AGE_DAYS}`
    );
  }

  const receiptPath = path.join(
    rootDir,
    ...RELEASE_TAG_GOVERNANCE_RECEIPT_PATH.split("/")
  );
  if (!existsSync(receiptPath)) {
    reasons.push(`${RELEASE_TAG_GOVERNANCE_RECEIPT_PATH} does not exist`);
  } else {
    try {
      const bytes = readFileSync(receiptPath);
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const receipt = JSON.parse(text);
      if (serializeReleaseTagGovernanceReceipt(receipt) !== text) {
        reasons.push("release tag governance receipt is not canonical JSON");
      }
      if (gate.sha256 !== sha256OfBytes(bytes)) {
        reasons.push(
          "release tag governance receipt bytes do not match the manifest pin"
        );
      }
      reasons.push(...releaseTagGovernanceReceiptProblems(receipt));
      reasons.push(
        ...releaseTagGovernanceReceiptFreshnessProblems(
          receipt,
          now,
          gate.maxAgeDays
        )
      );
    } catch (error) {
      reasons.push(
        `release tag governance receipt is unreadable: ${String(error).slice(0, 200)}`
      );
    }
  }

  for (const relative of promotionWorkflows) {
    const absolute = path.join(rootDir, ...relative.split("/"));
    if (!existsSync(absolute)) {
      reasons.push(`${relative} does not exist`);
      continue;
    }
    const workflow = readFileSync(absolute, "utf8");
    if (
      !workflow.includes(
        "client-id: ${{ vars.PROMOTION_APP_CLIENT_ID }}"
      )
    ) {
      reasons.push(`${relative} does not authenticate the promoter by client id`);
    }
    if (
      workflow.includes("PROMOTION_APP_ID") ||
      workflow.includes("app-id:") ||
      workflow.includes("!vars.PROMOTION_APP_CLIENT_ID") ||
      workflow.includes("promotion_app_token.outputs.token")
    ) {
      reasons.push(
        `${relative} still permits the deprecated promotion App-id fallback`
      );
    }
  }

  const releaseAbsolute = path.join(rootDir, ...releaseWorkflow.split("/"));
  if (!existsSync(releaseAbsolute)) {
    reasons.push(`${releaseWorkflow} does not exist`);
  } else {
    const workflow = readFileSync(releaseAbsolute, "utf8");
    for (const required of [
      "RELEASE_APP_INTEGRATION_ID",
      "RELEASE_TAG_CREATION_RULESET_ID",
      "RELEASE_TAG_GOVERNANCE_RECEIPT_SHA256",
      "PROMOTION_APP_CLIENT_ID",
      "PROMOTION_APP_INTEGRATION_ID",
      "PROMOTION_APP_SLUG",
      RELEASE_TAG_GOVERNANCE_RECEIPT_PATH
    ]) {
      if (!workflow.includes(required)) {
        reasons.push(`${releaseWorkflow} does not bind ${required}`);
      }
    }
    if (
      workflow.includes("permission-administration") ||
      workflow.includes("Administration: write")
    ) {
      reasons.push(
        `${releaseWorkflow} grants the release App ruleset administration authority`
      );
    }
  }
  return gateResult(
    id,
    gate,
    reasons.length === 0 ? "pass" : "fail",
    reasons.length === 0
      ? [
          "canonical full-bypass receipt is pinned and both Apps use separated client-id identities"
        ]
      : reasons
  );
}

function evaluateErrata(id, gate, manifest, rootDir, now) {
  const reasons = [];
  if (
    !isNonEmptyStringArray(gate.requiredErrata) ||
    gate.requiredErrata.some((entry) => !/^E[1-9]\d*$/.test(entry)) ||
    hasDuplicates(gate.requiredErrata)
  ) {
    reasons.push("gate config: requiredErrata must be a non-empty, unique list of E<number> ids");
  }
  if (!isCanonicalBoundedString(gate.resolution)) {
    reasons.push("gate config: resolution must name the disposition being approved");
  }
  if (!isCanonicalBoundedString(gate.resolvedBy, 100)) {
    reasons.push("gate config: resolvedBy must name the governing decision");
  }
  if (!isCanonicalBoundedString(gate.requiredSelection, 100)) {
    reasons.push("gate config: requiredSelection must name the exact approved selection");
  }
  if (!isCanonicalBoundedString(gate.document)) {
    reasons.push("gate config: document must name the published errata artifact");
  }
  if (typeof gate.sha256 !== "string" || !SHA256.test(gate.sha256)) {
    reasons.push("gate config: sha256 must pin the published errata artifact");
  }
  if (reasons.length > 0) return gateResult(id, gate, "fail", reasons);

  const resolver = manifest.decisions?.[gate.resolvedBy];
  reasons.push(...decisionProblems(gate.resolvedBy, resolver, now));
  if (resolver?.selected !== gate.requiredSelection) {
    reasons.push(
      `decision ${gate.resolvedBy} must explicitly select ${gate.requiredSelection}; got ${String(resolver?.selected)}`
    );
  }
  const dispositionSha256 = errataDispositionSha256(gate);
  if (resolver?.dispositionSha256 !== dispositionSha256) {
    reasons.push(
      `decision ${gate.resolvedBy} must approve disposition sha256 ${dispositionSha256}; got ${String(resolver?.dispositionSha256)}`
    );
  }

  const documentPath = path.join(rootDir, gate.document);
  if (!existsSync(documentPath)) {
    reasons.push(`${gate.document} does not exist`);
  } else {
    const bytes = readFileSync(documentPath, "utf8");
    if (sha256OfFile(documentPath) !== gate.sha256) {
      reasons.push(`${gate.document} does not match the pinned errata digest`);
    }
    for (const erratum of gate.requiredErrata) {
      if (!bytes.includes(`**${erratum} (`)) {
        reasons.push(`${gate.document} does not publish required erratum ${erratum}`);
      }
    }
  }
  return gateResult(
    id,
    gate,
    reasons.length === 0 ? "pass" : "fail",
    reasons.length === 0
      ? [`${gate.requiredErrata.join(", ")} use the approved ${gate.resolution} disposition`]
      : reasons
  );
}

/**
 * Bind the human revision decision to the complete errata disposition. A
 * later edit to even one required id, the selected vehicle, the document, or
 * its bytes therefore requires an explicit re-approval.
 */
export function errataDispositionSha256(gate) {
  return sha256OfBytes(
    JSON.stringify({
      requiredErrata: gate.requiredErrata,
      resolution: gate.resolution,
      document: gate.document,
      sha256: gate.sha256,
      resolvedBy: gate.resolvedBy,
      requiredSelection: gate.requiredSelection
    })
  );
}

function evaluateCorpus(id, gate, rootDir, measurementContext, freezeContext, now) {
  if (
    !isNonEmptyStringArray(gate.requiredMetrics) ||
    !Number.isSafeInteger(gate.minimumSitesPerMetric) ||
    gate.minimumSitesPerMetric < 1 ||
    !isRecord(gate.requiredCohort)
  ) {
    return gateResult(id, gate, "fail", [
      "gate config: requiredMetrics must be a non-empty list and minimumSitesPerMetric a positive integer"
    ]);
  }
  const artifactPath = path.join(rootDir, gate.artifact);
  if (!existsSync(artifactPath)) return gateResult(id, gate, "fail", [`${gate.artifact} does not exist`]);
  let corpus;
  try {
    corpus = readJson(artifactPath);
  } catch {
    return gateResult(id, gate, "fail", [`${gate.artifact} is not valid JSON`]);
  }
  const bindingReasons = boundExactEvidenceProblems(
    measurementContext,
    rootDir,
    "generated-corpus-stats",
    gate.artifact
  );
  if (measurementContext?.configured) {
    if (!freezeContext?.receipt) {
      bindingReasons.push("the verified measurement-freeze receipt is unavailable");
    } else {
      const generatedAt = canonicalInstantMillis(corpus.generatedAt);
      if (generatedAt === null) {
        bindingReasons.push("corpus generatedAt is not a canonical UTC instant");
      } else if (generatedAt > now + FUTURE_SKEW_MS) {
        bindingReasons.push("corpus generatedAt is in the future");
      } else if (
        generatedAt <
        Date.parse(freezeContext.receipt.activation.activatedAt)
      ) {
        bindingReasons.push("corpus aggregate was generated before measurement-freeze activation");
      }
      bindingReasons.push(
        ...evidenceFinalizationProblems(
          rootDir,
          measurementContext,
          gate.artifact,
          "generatedAt",
          corpus.generatedAt
        )
      );
    }
  }
  if (bindingReasons.length > 0) {
    return gateResult(id, gate, "fail", bindingReasons);
  }
  const cohorts = Array.isArray(corpus.cohorts) ? corpus.cohorts : [];
  const candidates = cohorts.filter(
    (cohort) =>
      cohort.schemaVersion === gate.requiredCohort.schemaVersion &&
      cohort.schemaRevision === gate.requiredCohort.schemaRevision
  );
  if (candidates.length === 0) {
    return gateResult(id, gate, "fail", [
      `no cohort matches schemaVersion ${gate.requiredCohort.schemaVersion} revision ${gate.requiredCohort.schemaRevision}`
    ]);
  }
  const clearing = candidates.filter((cohort) =>
    gate.requiredMetrics.every(
      (metric) => (cohort.metrics?.[metric]?.count ?? 0) >= gate.minimumSitesPerMetric
    )
  );
  if (clearing.length === 0) {
    const best = candidates.reduce((leader, cohort) => {
      const floor = Math.min(...gate.requiredMetrics.map((metric) => cohort.metrics?.[metric]?.count ?? 0));
      return floor > leader.floor ? { floor, id: cohort.id } : leader;
    }, { floor: -1, id: null });
    return gateResult(id, gate, "fail", [
      `no current-method cohort clears ${gate.minimumSitesPerMetric} sites on every required metric (best: ${best.id ?? "none"} with a ${best.floor}-site floor)`
    ]);
  }
  // Clearing counts alone are not enough: the cohort must be the one the
  // product's claims actually come from (primaryCohortId) and must carry the
  // artifact's CURRENT metric-contract identity, or a superseded-era cohort
  // could green the gate exactly the way eras were never allowed to pool.
  const reasons = [];
  const bound = clearing.filter((cohort) => {
    let ok = true;
    if (cohort.id !== corpus.primaryCohortId) {
      reasons.push(`cohort ${cohort.id} clears the floors but is not the primary claim-backing cohort (${String(corpus.primaryCohortId)})`);
      ok = false;
    }
    if (cohort.metricContractDigest !== corpus.metricContractDigest) {
      reasons.push(`cohort ${cohort.id} carries a superseded metric-contract identity`);
      ok = false;
    }
    return ok;
  });
  if (bound.length === 0) return gateResult(id, gate, "fail", reasons);
  if (measurementContext?.configured) {
    const derived = deriveBoundCorpusCohort(
      rootDir,
      measurementContext,
      corpus.primaryCohortId
    );
    if (derived.reasons.length > 0) {
      return gateResult(id, gate, "fail", derived.reasons);
    }
    if (
      bound[0].sampleSize !== derived.sampleSize ||
      corpus.sampleSize !== derived.sampleSize
    ) {
      return gateResult(id, gate, "fail", [
        `primary cohort sampleSize must equal the ${derived.sampleSize} distinct eligible post-freeze sites derived from the digest-bound reports`
      ]);
    }
    if (bound[0].latestRunAt !== derived.latestRunAt) {
      return gateResult(id, gate, "fail", [
        `primary cohort latestRunAt ${String(bound[0].latestRunAt)} does not equal the bound-report value ${String(derived.latestRunAt)}`
      ]);
    }
  }
  return gateResult(id, gate, "pass", [`cohort ${bound[0].id} clears every metric denominator as the primary claim-backing cohort`]);
}

export function deriveBoundCorpusCohort(
  rootDir,
  measurementContext,
  primaryCohortId
) {
  const reasons = [];
  const reader = loadCompiled("scan-report-reader", rootDir);
  const views = loadCompiled("scan-report-view", rootDir);
  const cohorts = loadCompiled("corpus-cohort", rootDir);
  const siteDomains = loadCompiled("corpus-site-domain", rootDir);
  const reservedDomains = loadCompiled("reserved-report-domains", rootDir);
  const representatives = loadCompiled("corpus-representative", rootDir);
  if (
    typeof reader?.readStoredScanReport !== "function" ||
    typeof views?.toReportView !== "function" ||
    typeof views?.displayRunView !== "function" ||
    typeof views?.familyCensoredOnRun !== "function" ||
    typeof views?.runHitRequestRecordingCap !== "function" ||
    typeof cohorts?.corpusCohortIdentityForView !== "function" ||
    typeof siteDomains?.corpusSiteDomainKey !== "function" ||
    typeof reservedDomains?.isReservedReportDomain !== "function" ||
    typeof representatives?.preferCorpusRepresentative !== "function"
  ) {
    return {
      reasons: [
        "the freshly compiled canonical corpus reader and cohort modules are unavailable"
      ],
      sampleSize: 0,
      latestRunAt: null
    };
  }

  const bySite = new Map();
  for (const entry of boundEvidence(measurementContext, "featured-report")) {
    try {
      const report = readJson(path.join(rootDir, ...entry.path.split("/")));
      if (report.schemaVersion !== 2 || report.schemaRevision !== 2) {
        reasons.push(`${entry.path} is not a schema v2 revision 2 report`);
        continue;
      }
      const read = reader.readStoredScanReport(report);
      if (!read?.ok) {
        reasons.push(
          `${entry.path} does not pass the canonical deep report reader (${String(read?.error)})`
        );
        continue;
      }
      const view = views.toReportView(read.stored);
      if (view.origin !== "v2" || view.revision !== 2) {
        reasons.push(`${entry.path} did not project as a v2/r2 report`);
        continue;
      }
      const identity = cohorts.corpusCohortIdentityForView(view);
      if (identity.id !== primaryCohortId) {
        reasons.push(
          `${entry.path} belongs to cohort ${identity.id}, not the claim-backing cohort ${String(primaryCohortId)}`
        );
        continue;
      }

      const run = views.displayRunView(view);
      if (
        run?.quality?.outcome !== "complete" ||
        typeof run.status !== "number" ||
        run.status >= 400
      ) {
        continue;
      }
      const domain = siteDomains.corpusSiteDomainKey(run.domain);
      if (!domain || reservedDomains.isReservedReportDomain(domain)) continue;
      if (
        views.familyCensoredOnRun(run, "requests") ||
        views.runHitRequestRecordingCap(run)
      ) {
        continue;
      }
      if (
        run.conditions?.consentMode === "accept-all" ||
        run.conditions?.consentMode === "reject-all"
      ) {
        continue;
      }
      const scannedAt = run.startedAt ?? view.scannedAt ?? "";
      if (!Number.isFinite(Date.parse(scannedAt))) continue;
      const id = path.posix.basename(entry.path, ".json");
      const existing = bySite.get(domain);
      if (
        existing &&
        !representatives.preferCorpusRepresentative(
          { id, scannedAt },
          existing
        )
      ) {
        continue;
      }
      bySite.set(domain, { id, scannedAt });
    } catch (error) {
      reasons.push(
        `${entry.path} cannot be projected into the canonical corpus: ${String(error).slice(0, 180)}`
      );
    }
  }
  const latestRunAt =
    [...bySite.values()]
      .map((site) => site.scannedAt)
      .sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null;
  return { reasons, sampleSize: bySite.size, latestRunAt };
}

function candidateInputProblems(
  measurementContext,
  rootDir,
  relativePath,
  expectedDigest
) {
  const entries =
    measurementContext.binding?.measurementInputs?.inputs?.filter(
      (entry) => entry?.path === relativePath
    ) ?? [];
  const reasons = [];
  if (entries.length !== 1) {
    reasons.push(
      `${relativePath} must appear exactly once in the candidate-input manifest; found ${entries.length}`
    );
    return reasons;
  }
  if (entries[0].sha256 !== expectedDigest) {
    reasons.push(
      `${relativePath} digest does not match the candidate-input manifest`
    );
  }
  const absolute = path.join(rootDir, ...relativePath.split("/"));
  if (!existsSync(absolute) || sha256OfFile(absolute) !== expectedDigest) {
    reasons.push(`${relativePath} current bytes do not match the candidate input`);
  }
  return reasons;
}

export function aaTargetFrameDigestIssues(
  rootDir,
  targetFramePath,
  preregistration,
  ledger
) {
  const absolute = path.join(rootDir, ...targetFramePath.split("/"));
  if (!existsSync(absolute)) return [`${targetFramePath} does not exist`];
  const digest = sha256OfFile(absolute);
  const reasons = [];
  if (
    preregistration.sitesFile !== targetFramePath ||
    preregistration.sitesFileDigest !== digest ||
    ledger.sitesFile !== targetFramePath ||
    ledger.provenance?.sitesFileDigest !== digest
  ) {
    reasons.push(
      "preregistration and ledger must bind the exact study-local target-frame bytes"
    );
  }
  return reasons;
}

function evaluateAaStudies(id, gate, rootDir, measurementContext, freezeContext, now) {
  const directory = path.join(rootDir, gate.directory);
  if (!existsSync(directory)) return gateResult(id, gate, "fail", [`${gate.directory}/ does not exist`]);
  const reasons = [];
  let passing = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const studyDir = path.join(directory, entry.name);
    try {
      // Never trust the committed evaluation.json verdict: re-score the
      // committed preregistration and ledger, then require the committed
      // verdict to AGREE so a stale or hand-written evaluation is loud.
      const preregistration = readJson(path.join(studyDir, "preregistration.json"));
      const targetFramePath = path.posix.join(
        gate.directory,
        entry.name,
        "target-frame.json"
      );
      const preregistrationPath = path.posix.join(
        gate.directory,
        entry.name,
        "preregistration.json"
      );
      const targetFrameText = readFileSync(
        path.join(studyDir, "target-frame.json"),
        "utf8"
      );
      const targetFrame = JSON.parse(targetFrameText);
      const ledger = readJson(path.join(studyDir, "attempt-ledger.json"));
      const rederived = evaluateAaStudy({
        preregistration,
        targetFrame,
        targetFrameText,
        ledger
      });
      const committedPath = path.join(studyDir, "evaluation.json");
      const committed = existsSync(committedPath) ? readJson(committedPath) : null;
      if (rederived.status !== "pass") {
        reasons.push(`${entry.name}: re-derived status ${rederived.status}`);
      } else if (JSON.stringify(committed) !== JSON.stringify(rederived)) {
        reasons.push(
          `${entry.name}: committed evaluation does not exactly equal the re-derived evaluation; regenerate it`
        );
      } else {
        const studyReasons = [];
        if (measurementContext?.configured) {
          for (const [category, filename] of [
            ["aa-attempt-ledger", "attempt-ledger.json"],
            ["aa-evaluation", "evaluation.json"],
            ["aa-producer-receipt", "producer-receipt.json"],
            [
              "aa-producer-attestation",
              "producer-receipt.sigstore.json"
            ]
          ]) {
            studyReasons.push(
              ...boundExactEvidenceProblems(
                measurementContext,
                rootDir,
                category,
                path.posix.join(gate.directory, entry.name, filename)
              )
            );
          }
          const producerReceiptPath = path.posix.join(
            gate.directory,
            entry.name,
            "producer-receipt.json"
          );
          const producerVerifications =
            measurementContext.binding
              ?.postCandidateAttestationVerifications?.filter(
                (verification) =>
                  verification?.subject === "aa-producer-receipt" &&
                  verification?.evidencePath === producerReceiptPath
              ) ?? [];
          if (
            producerVerifications.length !== 1 ||
            producerVerifications[0]?.status !==
              "verified-by-gh-attestation"
          ) {
            studyReasons.push(
              `${entry.name}: governed A/A producer receipt must have exactly one verified hosted attestation`
            );
          }
          const targetFrameDigest = sha256OfFile(
            path.join(studyDir, "target-frame.json")
          );
          const preregistrationDigest = sha256OfFile(
            path.join(studyDir, "preregistration.json")
          );
          studyReasons.push(
            ...aaTargetFrameDigestIssues(
              rootDir,
              targetFramePath,
              preregistration,
              ledger
            ).map((reason) => `${entry.name}: ${reason}`)
          );
          studyReasons.push(
            ...candidateInputProblems(
              measurementContext,
              rootDir,
              targetFramePath,
              targetFrameDigest
            ),
            ...candidateInputProblems(
              measurementContext,
              rootDir,
              preregistrationPath,
              preregistrationDigest
            )
          );
          const identity = measurementContext.binding?.measurementIdentity;
          if (
            preregistration.measurementIdentityManifestPath !==
              identity?.manifestPath ||
            preregistration.measurementIdentityDigest !==
              identity?.manifestSha256 ||
            ledger.provenance?.measurementIdentityDigest !==
              identity?.manifestSha256
          ) {
            studyReasons.push(
              `${entry.name}: preregistration and ledger do not bind the candidate's verified measurement identity`
            );
          }
          studyReasons.push(
            ...aaMeasurementIdentityProblems(
              identity,
              ledger,
              entry.name
            )
          );
          const producerCommit = ledger.provenance?.expectedBuildCommit;
          if (
            !measurementCandidateAcceptsProducer(
              measurementContext,
              producerCommit
            )
          ) {
            studyReasons.push(
              `${entry.name}: ledger producer is not an accepted measurement carrier`
            );
          }
          const declaredAt = canonicalInstantMillis(
            preregistration.declaredAt
          );
          if (declaredAt === null) {
            studyReasons.push(
              `${entry.name}: preregistration declaredAt is not a canonical UTC instant`
            );
          } else if (declaredAt > now + FUTURE_SKEW_MS) {
            studyReasons.push(
              `${entry.name}: preregistration declaredAt is in the future`
            );
          }
          const freezeAt = freezeContext?.receipt?.activation?.activatedAt;
          if (!freezeAt) {
            studyReasons.push(
              `${entry.name}: the verified measurement-freeze receipt is unavailable`
            );
          } else {
            const collectionStartedAt = canonicalInstantMillis(
              ledger.collection?.startedAt
            );
            const collectionCompletedAt = canonicalInstantMillis(
              ledger.collection?.completedAt
            );
            const createdAt = canonicalInstantMillis(ledger.createdAt);
            if (
              collectionStartedAt === null ||
              collectionCompletedAt === null ||
              createdAt === null
            ) {
              studyReasons.push(
                `${entry.name}: collection startedAt, completedAt, and ledger createdAt must be canonical UTC instants`
              );
            } else if (collectionStartedAt < Date.parse(freezeAt)) {
              studyReasons.push(
                `${entry.name}: A/A collection started before measurement-freeze activation`
              );
            } else if (
              collectionStartedAt > collectionCompletedAt ||
              collectionCompletedAt > createdAt
            ) {
              studyReasons.push(
                `${entry.name}: collection chronology must satisfy startedAt <= completedAt <= createdAt`
              );
            } else if (
              collectionStartedAt > now + FUTURE_SKEW_MS ||
              collectionCompletedAt > now + FUTURE_SKEW_MS ||
              createdAt > now + FUTURE_SKEW_MS
            ) {
              studyReasons.push(
                `${entry.name}: A/A collection chronology is in the future`
              );
            }
          }
          for (const [filename, acquiredAt] of [
            ["attempt-ledger.json", ledger.createdAt],
            ["evaluation.json", ledger.createdAt]
          ]) {
            studyReasons.push(
              ...producerEvidenceProblems(
                rootDir,
                measurementContext,
                path.posix.join(gate.directory, entry.name, filename),
                producerCommit,
                acquiredAt
              )
            );
          }
        }
        if (studyReasons.length === 0) passing += 1;
        else reasons.push(...studyReasons);
      }
    } catch (error) {
      reasons.push(`${entry.name}: ${String(error).slice(0, 160)}`);
    }
  }
  if (passing >= 1) {
    return gateResult(id, gate, "pass", [
      `${passing} preregistered stud${passing === 1 ? "y" : "ies"} re-derived as passing`,
      ...reasons.map((reason) => `note: ${reason}`)
    ]);
  }
  reasons.unshift("no committed A/A study re-derives as passing");
  return gateResult(id, gate, "fail", reasons);
}

const freshCompiledCache = new Map();

function freshCompiledSchemaModules(rootDir) {
  if (freshCompiledCache.has(rootDir)) {
    return freshCompiledCache.get(rootDir)?.modules ?? null;
  }
  const config = path.join(rootDir, "tsconfig.schema.json");
  const compiler = path.join(rootDir, "node_modules", "typescript", "bin", "tsc");
  if (!existsSync(config) || !existsSync(compiler)) {
    freshCompiledCache.set(rootDir, null);
    return null;
  }
  const output = mkdtempSync(path.join(tmpdir(), "sbl-readiness-schema-"));
  try {
    execFileSync(process.execPath, [compiler, "-p", config, "--outDir", output], {
      cwd: rootDir,
      stdio: ["ignore", "ignore", "pipe"],
      maxBuffer: 16 * 1024 * 1024
    });
    const modules = {};
    for (const name of [
      "measurement-candidate-binding",
      "detector-calibration-source",
      "detector-calibration",
      "scan-report-v2",
      "scan-report-reader",
      "scan-report-view",
      "corpus-cohort",
      "corpus-site-domain",
      "corpus-representative",
      "corpus-stats-builder",
      "reserved-report-domains",
      "redaction-provenance"
    ]) {
      modules[name] = requireFromHere(path.join(output, "lib", `${name}.js`));
    }
    freshCompiledCache.set(rootDir, { modules, output });
    return modules;
  } catch {
    freshCompiledCache.set(rootDir, null);
    rmSync(output, { recursive: true, force: true });
    return null;
  }
}

process.once("exit", () => {
  for (const entry of freshCompiledCache.values()) {
    if (entry?.output) rmSync(entry.output, { recursive: true, force: true });
  }
});

function freshCompiledOutput(rootDir) {
  freshCompiledSchemaModules(rootDir);
  return freshCompiledCache.get(rootDir)?.output ?? null;
}

function loadCompiled(name, rootDir = process.cwd()) {
  const fresh = freshCompiledSchemaModules(rootDir);
  if (fresh?.[name]) return fresh[name];
  // Synthetic fixtures do not carry the repository compiler. They may use
  // only the test runner's freshly emitted tree; never fall back to ignored
  // dist/schema output whose bytes can lag the current TypeScript source.
  for (const candidate of [`../.unit-test-dist/lib/${name}.js`]) {
    try {
      return requireFromHere(candidate);
    } catch {
      // try the next compiled location
    }
  }
  return null;
}

export function measurementCandidateBindingVerificationOptions(options = {}) {
  const hasContext = options.liveArtifactContext !== undefined;
  const hasDigest = options.liveArtifactContextSha256 !== undefined;
  if (hasContext !== hasDigest) {
    throw new Error(
      "measurement-freeze live artifact context and digest must be supplied together"
    );
  }
  if (!hasContext) return {};
  if (
    typeof options.liveArtifactContext !== "string" ||
    !path.isAbsolute(options.liveArtifactContext)
  ) {
    throw new Error(
      "measurement-freeze live artifact context must be an absolute path"
    );
  }
  if (
    typeof options.liveArtifactContextSha256 !== "string" ||
    !SHA256.test(options.liveArtifactContextSha256)
  ) {
    throw new Error(
      "measurement-freeze live artifact context digest must be a lowercase sha256"
    );
  }
  return {
    freezeArtifactContext: {
      directory: options.liveArtifactContext,
      sha256: options.liveArtifactContextSha256
    }
  };
}

function acquireMeasurementCandidate(manifest, rootDir, options = {}) {
  const configured = Object.values(manifest.gates ?? {}).some(
    (gate) => gate?.kind === "measurement-candidate-binding"
  );
  if (!configured) {
    return {
      configured: false,
      binding: null,
      module: null,
      problems: []
    };
  }
  const bindingModule = loadCompiled("measurement-candidate-binding", rootDir);
  if (
    !bindingModule ||
    typeof bindingModule.verifiedMeasurementCandidateBinding !== "function"
  ) {
    return {
      configured: true,
      binding: null,
      module: bindingModule,
      problems: [
        "the compiled measurement-candidate verifier is unavailable; build it first (tsc -p tsconfig.schema.json)"
      ]
    };
  }
  try {
    const binding = bindingModule.verifiedMeasurementCandidateBinding(
      rootDir,
      measurementCandidateBindingVerificationOptions(options)
    );
    if (!binding) {
      return {
        configured: true,
        binding: null,
        module: bindingModule,
        problems: [
          `${bindingModule.MEASUREMENT_CANDIDATE_BINDING_PATH ?? MEASUREMENT_CANDIDATE_BINDING_PATH} does not exist`
        ]
      };
    }
    return {
      configured: true,
      binding,
      module: bindingModule,
      problems: []
    };
  } catch (error) {
    return {
      configured: true,
      binding: null,
      module: bindingModule,
      problems: [
        `measurement candidate or Sigstore proof failed verification: ${String(error).slice(0, 300)}`
      ]
    };
  }
}

function measurementCandidateProblems(context) {
  if (!context.configured) return ["the measurement-candidate-binding gate is not configured"];
  if (context.problems.length > 0) return [...context.problems];
  if (!context.binding || !FULL_GIT_SHA.test(context.binding.candidateCommit ?? "")) {
    return ["no verified measurement candidate is available"];
  }
  return [];
}

function measurementCandidateAcceptsProducer(context, commit) {
  if (!FULL_GIT_SHA.test(commit ?? "") || !context?.binding) return false;
  if (
    typeof context.module?.measurementCandidateAcceptsProducerCommit ===
    "function"
  ) {
    return context.module.measurementCandidateAcceptsProducerCommit(
      context.binding,
      commit
    );
  }
  return (
    Array.isArray(context.binding.acceptedProducerCommits) &&
    context.binding.acceptedProducerCommits.includes(commit)
  );
}

function evidenceIntroductionCommit(rootDir, context, evidencePath) {
  if (!context?.binding) return null;
  const output = gitRead(rootDir, [
    "log",
    "--format=%H",
    "--diff-filter=A",
    `${context.binding.candidateCommit}..${context.binding.carrierCommit}`,
    "--",
    evidencePath
  ]);
  if (output === null) return null;
  const commits = output
    .toString("utf8")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);
  return commits.length === 1 && FULL_GIT_SHA.test(commits[0])
    ? commits[0]
    : null;
}

export function producerEvidenceProblems(
  rootDir,
  context,
  evidencePath,
  producerCommit,
  acquiredAt
) {
  const reasons = [];
  if (!measurementCandidateAcceptsProducer(context, producerCommit)) {
    reasons.push(
      `${evidencePath} producer ${String(producerCommit)} is not an accepted measurement carrier commit`
    );
    return reasons;
  }
  const introducedBy =
    context.binding?.evidenceIntroducedAt?.[evidencePath] ??
    evidenceIntroductionCommit(rootDir, context, evidencePath);
  if (!introducedBy) {
    reasons.push(
      `${evidencePath} does not have exactly one derived introduction commit after the candidate`
    );
    return reasons;
  }
  const pathAwareProducerCheck =
    context.module?.measurementCandidateAcceptsProducerForEvidencePath;
  const producerIsCausal =
    typeof pathAwareProducerCheck === "function"
      ? pathAwareProducerCheck(
          context.binding,
          producerCommit,
          evidencePath
        )
      : producerCommit !== introducedBy &&
        gitRead(rootDir, [
          "merge-base",
          "--is-ancestor",
          producerCommit,
          introducedBy
        ]) !== null;
  if (!producerIsCausal) {
    reasons.push(
      `${evidencePath} producer must be a strict ancestor of its introduction commit ${introducedBy}`
    );
  }
  const acquiredMillis = canonicalInstantMillis(acquiredAt);
  const producerTime = gitRead(rootDir, [
    "show",
    "-s",
    "--format=%cI",
    producerCommit
  ]);
  const producerMillis = Date.parse(
    producerTime?.toString("utf8").trim() ?? ""
  );
  const introductionTime = gitRead(rootDir, [
    "show",
    "-s",
    "--format=%cI",
    introducedBy
  ]);
  const introductionMillis = Date.parse(
    introductionTime?.toString("utf8").trim() ?? ""
  );
  if (
    acquiredMillis === null ||
    !Number.isFinite(producerMillis) ||
    acquiredMillis < producerMillis
  ) {
    reasons.push(
      `${evidencePath} acquisition timestamp must follow its producer commit`
    );
  }
  const pathAwareTimestampCheck =
    context.module?.measurementCandidateEvidenceTimestampIsCausal;
  const timestampIsCausal =
    typeof pathAwareTimestampCheck === "function"
      ? pathAwareTimestampCheck(
          context.binding,
          evidencePath,
          acquiredAt
        )
      : acquiredMillis !== null &&
        Number.isFinite(introductionMillis) &&
        acquiredMillis <=
          introductionMillis + GIT_TIMESTAMP_PRECISION_SKEW_MS;
  if (!timestampIsCausal) {
    reasons.push(
      `${evidencePath} acquisition or finalization timestamp must not follow its introduction commit`
    );
  }
  return reasons;
}

function evidenceFinalizationProblems(
  rootDir,
  context,
  evidencePath,
  label,
  timestamp
) {
  if (!context?.binding) return [];
  const millis = canonicalInstantMillis(timestamp);
  const lastChange = gitRead(rootDir, [
    "log",
    "-1",
    "--format=%H",
    `${context.binding.candidateCommit}..${context.binding.carrierCommit}`,
    "--",
    evidencePath
  ])
    ?.toString("utf8")
    .trim();
  const committedAt =
    FULL_GIT_SHA.test(lastChange ?? "")
      ? gitRead(rootDir, ["show", "-s", "--format=%cI", lastChange])
      : null;
  const commitMillis = Date.parse(
    committedAt?.toString("utf8").trim() ?? ""
  );
  if (
    millis === null ||
    !Number.isFinite(commitMillis) ||
    millis > commitMillis + GIT_TIMESTAMP_PRECISION_SKEW_MS
  ) {
    return [
      `${evidencePath} ${label} must not follow the commit that finalized its retained bytes`
    ];
  }
  return [];
}

export function reportAcquisitionRuns(report) {
  const reasons = [];
  const runs = [];
  if (
    !isRecord(report) ||
    report.schemaVersion !== 2 ||
    report.schemaRevision !== 2
  ) {
    return {
      runs,
      reasons: ["report must be a schema v2 revision 2 object"]
    };
  }
  if (report.reportType === "single") {
    if (!isRecord(report.run)) {
      reasons.push("single report does not contain its run");
    } else {
      runs.push({ label: "run", run: report.run });
    }
    return { runs, reasons };
  }
  if (report.reportType !== "comparison") {
    return {
      runs,
      reasons: ["reportType must be single or comparison"]
    };
  }
  for (const [label, run] of [
    ["baseline", report.baseline],
    ["variant", report.variant]
  ]) {
    if (!isRecord(run)) reasons.push(`comparison does not contain ${label}`);
    else runs.push({ label, run });
  }
  const supportingPairs = report.experiment?.supportingPairs;
  if (supportingPairs !== undefined) {
    if (
      report.experiment?.kind !== "intervention" ||
      !Array.isArray(supportingPairs)
    ) {
      reasons.push(
        "supportingPairs must be an array on an intervention experiment"
      );
    } else {
      for (const [index, pair] of supportingPairs.entries()) {
        if (!isRecord(pair)) {
          reasons.push(`supporting pair ${index + 1} is not an object`);
          continue;
        }
        for (const [arm, run] of [
          ["baseline", pair.baseline],
          ["variant", pair.variant]
        ]) {
          if (!isRecord(run)) {
            reasons.push(
              `supporting pair ${index + 1} does not contain ${arm}`
            );
          } else {
            runs.push({
              label: `supporting pair ${index + 1} ${arm}`,
              run
            });
          }
        }
      }
    }
  }
  return { runs, reasons };
}

function verifiedMeasurementIdentityValue(measurementIdentity) {
  return isRecord(measurementIdentity?.value)
    ? measurementIdentity.value
    : null;
}

function producerIdentityProblems(identity, producer, label) {
  const reasons = [];
  if (!isRecord(identity?.implementation)) {
    return [`${label} cannot be checked because the verified measurement identity is unavailable`];
  }
  if (!isRecord(producer)) {
    return [`${label} does not preserve producer/runtime identity`];
  }
  if (producer.observer !== "node-playwright") {
    reasons.push(`${label} observer is not the candidate's node-playwright producer`);
  }
  if (
    producer.methodologyVersion !==
    identity.implementation.methodologyVersion
  ) {
    reasons.push(`${label} methodologyVersion does not match the verified measurement identity`);
  }
  if (
    producer.detectorRegistry?.version !==
      identity.implementation.detectorRegistryVersion ||
    producer.detectorRegistry?.digest !==
      identity.implementation.detectorRegistryDigest
  ) {
    reasons.push(`${label} detector registry does not match the verified measurement identity`);
  }
  return reasons;
}

/**
 * Cross-check the self-described identity on every public report arm against
 * the candidate identity that the host verifier derived from code, catalogs,
 * list bytes, and the pinned toolchain. A build SHA alone is not sufficient:
 * a producer can emit a valid-looking report while carrying stale identities.
 */
export function measurementIdentityRunProblems(
  measurementIdentity,
  run,
  label = "report run"
) {
  const identity = verifiedMeasurementIdentityValue(measurementIdentity);
  if (!identity) {
    return [`${label} cannot be checked because the verified measurement identity is unavailable`];
  }
  const reasons = producerIdentityProblems(identity, run?.provenance, label);
  if (run?.conditions?.automation !== "playwright-chromium") {
    reasons.push(`${label} automation is not the candidate's Playwright pipeline`);
  }
  if (
    run?.toolchain?.normalizationVersion !==
    identity.implementation.normalizationVersion
  ) {
    reasons.push(`${label} normalizationVersion does not match the verified measurement identity`);
  }
  if (
    run?.toolchain?.trackerCatalog?.version !==
      identity.catalogs?.trackerCatalogVersion ||
    run?.toolchain?.trackerCatalog?.digest !==
      identity.catalogs?.trackerCatalogDigest
  ) {
    reasons.push(`${label} tracker catalog does not match the verified measurement identity`);
  }
  if (
    !isRecord(run?.toolchain?.adblock) ||
    run.toolchain.adblock.manifestDigest !==
      identity.catalogs?.braveManifestDigest ||
    run.toolchain.adblock.engineVersion !==
      identity.catalogs?.braveEngineVersion
  ) {
    reasons.push(`${label} Brave list manifest or engine does not match the verified measurement identity`);
  }
  return reasons;
}

/**
 * A/A ledgers intentionally retain a privacy-reduced producer identity rather
 * than the full report toolchain. Check every attempted arm against every
 * candidate-derived field the ledger actually carries; the full catalog/list
 * identity remains bound separately by measurementIdentityDigest.
 */
export function aaMeasurementIdentityProblems(
  measurementIdentity,
  ledger,
  label = "A/A ledger"
) {
  const identity = verifiedMeasurementIdentityValue(measurementIdentity);
  if (!identity) {
    return [`${label} cannot be checked because the verified measurement identity is unavailable`];
  }
  const reasons = [];
  if (!Array.isArray(ledger?.attempts)) {
    return [`${label} does not preserve an attempts array`];
  }
  for (const [attemptIndex, attempt] of ledger.attempts.entries()) {
    // A recorded scan failure has no producer runtime to compare. Its
    // eligibility/censoring consequence is owned by the A/A evaluator; this
    // cross-check applies to every runtime that was actually observed.
    if (attempt?.observation === null) continue;
    const arms = attempt?.observation?.arms;
    if (!isRecord(arms) || Object.keys(arms).length === 0) {
      reasons.push(`${label} attempt ${attemptIndex + 1} does not preserve report arms`);
      continue;
    }
    for (const [armName, arm] of Object.entries(arms)) {
      const armLabel = `${label} attempt ${attemptIndex + 1} ${armName}`;
      const runtime = arm?.producerRuntime;
      reasons.push(
        ...producerIdentityProblems(identity, runtime, armLabel)
      );
      if (runtime?.runtime?.automation !== "playwright-chromium") {
        reasons.push(`${armLabel} automation is not the candidate's Playwright pipeline`);
      }
    }
  }
  return reasons;
}

function evaluateMeasurementCandidate(
  id,
  gate,
  context,
  manifest,
  rootDir,
  freezeContext,
  now
) {
  const reasons = [];
  if (gate.artifact !== MEASUREMENT_CANDIDATE_BINDING_PATH) {
    reasons.push(
      `gate config: artifact must be the fixed ${MEASUREMENT_CANDIDATE_BINDING_PATH}`
    );
  }
  if (
    context.module?.MEASUREMENT_CANDIDATE_BINDING_PATH !== undefined &&
    context.module.MEASUREMENT_CANDIDATE_BINDING_PATH !== MEASUREMENT_CANDIDATE_BINDING_PATH
  ) {
    reasons.push("compiled measurement-candidate artifact path disagrees with release policy");
  }
  reasons.push(...measurementCandidateProblems(context));
  const gateKindRequired = context.module?.measurementGateKindRequired;
  const requiredCategories =
    typeof gateKindRequired === "function"
      ? requiredMeasurementEvidenceCategories(manifest, gateKindRequired)
      : null;
  if (
    requiredCategories !== null &&
    (!Array.isArray(gate.requiredEvidenceCategories) ||
      hasDuplicates(gate.requiredEvidenceCategories) ||
      JSON.stringify([...gate.requiredEvidenceCategories].sort()) !==
        JSON.stringify([...requiredCategories].sort()))
  ) {
    reasons.push(
      `gate config: requiredEvidenceCategories must be exactly ${requiredCategories.join(", ")}`
    );
  }
  if (context.binding && requiredCategories !== null) {
    const counts = new Map();
    for (const entry of context.binding.evidence ?? []) {
      counts.set(entry.category, (counts.get(entry.category) ?? 0) + 1);
    }
    for (const category of requiredCategories) {
      if ((counts.get(category) ?? 0) === 0) {
        reasons.push(`measurement binding enumerates no ${category} evidence`);
      }
    }
    const exactOne = [
      "generated-report-index",
      "generated-corpus-stats",
      "measurement-freeze-receipt",
      "lifecycle-receipt",
      "release-policy-finalization",
      "citation-finalization",
      "changelog-finalization"
    ];
    for (const category of exactOne) {
      if ((counts.get(category) ?? 0) !== 1) {
        reasons.push(
          `measurement binding must enumerate exactly one ${category}; found ${counts.get(category) ?? 0}`
        );
      }
    }
    for (const category of [
      "runner-receipt",
      "controlled-publication-manifest",
      "controlled-publication-receipt"
    ]) {
      if ((counts.get(category) ?? 0) !== 2) {
        reasons.push(
          `measurement binding must enumerate exactly two ${category} files; found ${counts.get(category) ?? 0}`
        );
      }
    }
    const corpusFloor = manifest.gates?.["current-method-corpus"]?.minimumSitesPerMetric;
    if (!Number.isSafeInteger(corpusFloor) || corpusFloor < 1) {
      reasons.push("current-method-corpus does not declare a positive evidence floor");
    } else {
      for (const category of ["featured-report", "featured-provenance"]) {
        if ((counts.get(category) ?? 0) < corpusFloor) {
          reasons.push(
            `measurement binding enumerates ${counts.get(category) ?? 0} ${category} files; ${corpusFloor} post-freeze files are required`
          );
        }
      }
    }
    const freezeAt = freezeContext?.receipt?.activation?.activatedAt;
    if (!freezeAt) {
      reasons.push("the verified measurement-freeze receipt is unavailable");
    } else {
      for (const entry of boundEvidence(
        context,
        "generated-report-index"
      )) {
        try {
          const index = readJson(
            path.join(rootDir, ...entry.path.split("/"))
          );
          const generatedAt = canonicalInstantMillis(index.generatedAt);
          if (
            generatedAt === null ||
            generatedAt < Date.parse(freezeAt) ||
            generatedAt > now + FUTURE_SKEW_MS
          ) {
            reasons.push(
              `${entry.path} generatedAt must be a nonfuture post-freeze canonical instant`
            );
          }
          reasons.push(
            ...evidenceFinalizationProblems(
              rootDir,
              context,
              entry.path,
              "generatedAt",
              index.generatedAt
            )
          );
        } catch {
          reasons.push(`${entry.path} is not valid report-index JSON`);
        }
      }
      const reportProducers = new Map();
      for (const entry of boundEvidence(context, "featured-report")) {
        try {
          const report = readJson(path.join(rootDir, ...entry.path.split("/")));
          const acquisitions = reportAcquisitionRuns(report);
          if (acquisitions.reasons.length > 0) {
            reasons.push(
              ...acquisitions.reasons.map(
                (reason) => `${entry.path}: ${reason}`
              )
            );
            continue;
          }
          const producerCommits = new Set(
            acquisitions.runs.map(
              ({ run }) => run.provenance?.buildCommit
            )
          );
          if (producerCommits.size !== 1) {
            reasons.push(
              `${entry.path} primary and supporting runs do not share one producer commit`
            );
          }
          for (const { label, run } of acquisitions.runs) {
            reasons.push(
              ...measurementIdentityRunProblems(
                context.binding.measurementIdentity,
                run,
                `${entry.path} ${label}`
              )
            );
            if (
              !measurementCandidateAcceptsProducer(
                context,
                run.provenance?.buildCommit
              )
            ) {
              reasons.push(
                `${entry.path} ${label} does not bind an accepted measurement carrier`
              );
            }
            const startedAt = canonicalInstantMillis(run.startedAt);
            if (startedAt === null || startedAt < Date.parse(freezeAt)) {
              reasons.push(
                `${entry.path} ${label} was not acquired after measurement-freeze activation`
              );
            } else if (startedAt > now + FUTURE_SKEW_MS) {
              reasons.push(
                `${entry.path} ${label} has a future acquisition timestamp`
              );
            }
            reasons.push(
              ...producerEvidenceProblems(
                rootDir,
                context,
                entry.path,
                run.provenance?.buildCommit,
                run.startedAt
              )
            );
          }
          if (producerCommits.size === 1) {
            reportProducers.set(
              entry.path.replace(/\.json$/, ""),
              [...producerCommits][0]
            );
          }
        } catch {
          reasons.push(`${entry.path} is not valid report JSON`);
        }
      }
      const provenanceModule = loadCompiled("redaction-provenance", rootDir);
      for (const entry of boundEvidence(context, "featured-provenance")) {
        try {
          const provenance = readJson(path.join(rootDir, ...entry.path.split("/")));
          const reportPath = entry.path.replace(
            /\.provenance\.json$/,
            ".json"
          );
          const report = readJson(
            path.join(rootDir, ...reportPath.split("/"))
          );
          const reportId = path.posix.basename(reportPath, ".json");
          if (
            provenanceModule?.matchProvenance?.(
              report,
              provenance,
              reportId
            )?.status !== "matched"
          ) {
            reasons.push(
              `${entry.path} does not match its report's canonical public digest and provenance contract`
            );
          }
          const createdAt = canonicalInstantMillis(provenance.createdAt);
          if (createdAt === null || createdAt < Date.parse(freezeAt)) {
            reasons.push(
              `${entry.path} does not record post-freeze report creation`
            );
          } else if (createdAt > now + FUTURE_SKEW_MS) {
            reasons.push(`${entry.path} records future report creation`);
          }
          const reportKey = entry.path.replace(/\.provenance\.json$/, "");
          reasons.push(
            ...producerEvidenceProblems(
              rootDir,
              context,
              entry.path,
              reportProducers.get(reportKey),
              provenance.createdAt
            )
          );
        } catch {
          reasons.push(`${entry.path} is not valid provenance JSON`);
        }
      }
    }
  }
  return gateResult(
    id,
    gate,
    reasons.length === 0 ? "pass" : "fail",
    reasons.length === 0
      ? [
          `candidate ${context.binding.candidateCommit} and carrier ${context.binding.carrierCommit} passed Git and Sigstore verification`
        ]
      : reasons
  );
}

function boundEvidence(context, category) {
  if (!Array.isArray(context.binding?.evidence)) return [];
  return context.binding.evidence.filter((entry) => entry?.category === category);
}

function fileDigestProblem(rootDir, entry) {
  if (!isRecord(entry) || !isCanonicalRelativePath(entry.path) || !SHA256.test(entry.sha256 ?? "")) {
    return "binding contains a malformed evidence entry";
  }
  const absolute = path.join(rootDir, ...entry.path.split("/"));
  if (!existsSync(absolute)) return `${entry.path} does not exist`;
  if (sha256OfFile(absolute) !== entry.sha256) {
    return `${entry.path} does not match its measurement-candidate binding digest`;
  }
  return null;
}

export function hostedEvidenceSourceTrustProblems(
  rootDir,
  measurementContext,
  profile,
  trustedPreCandidateSourceCommit,
  sources
) {
  const reasons = [];
  if (
    !measurementContext?.binding ||
    !Array.isArray(sources)
  ) {
    return ["hosted evidence source trust requires a verified candidate and source set"];
  }
  for (const source of sources) {
    const preCandidateDurableSource =
      (profile === "durable-transition" ||
        profile === "durable-soak") &&
      source?.headSha === trustedPreCandidateSourceCommit;
    if (
      !measurementCandidateAcceptsProducer(
        measurementContext,
        source?.headSha
      ) &&
      !preCandidateDurableSource
    ) {
      reasons.push(
        `${source?.role} source head is neither an accepted candidate-to-carrier producer nor the exact declared pre-candidate durable deployment`
      );
      continue;
    }
    if (
      gitRead(rootDir, [
        "merge-base",
        "--is-ancestor",
        source.headSha,
        measurementContext.binding.carrierCommit
      ]) === null
    ) {
      reasons.push(
        `${source.role} source head is not an ancestor of the verified evidence carrier`
      );
      continue;
    }
  }
  reasons.push(
    ...hostedEvidenceSourceClosureProblems({
      profile,
      candidateCommit:
        measurementContext.binding.candidateCommit,
      sources,
      readBlob: (commit, trustedPath) =>
        gitRead(rootDir, [
          "show",
          `${commit}:${trustedPath}`
        ])
    })
  );
  return reasons;
}

export function hostedArchiveCarrierPlacementProblems(
  rootDir,
  candidateCommit,
  carrierCommit,
  archiveEntries
) {
  const reasons = [];
  if (
    !FULL_GIT_SHA.test(candidateCommit ?? "") ||
    !FULL_GIT_SHA.test(carrierCommit ?? "") ||
    !Array.isArray(archiveEntries) ||
    archiveEntries.length === 0
  ) {
    return [
      "hosted archive carrier placement requires exact candidate/carrier commits and a non-empty digest inventory"
    ];
  }
  if (
    gitRead(rootDir, [
      "merge-base",
      "--is-ancestor",
      candidateCommit,
      carrierCommit
    ]) === null
  ) {
    reasons.push(
      "hosted archive does not have one verified candidate-to-carrier history"
    );
  }
  for (const entry of archiveEntries) {
    if (
      !isRecord(entry) ||
      typeof entry.path !== "string" ||
      !SHA256.test(entry.sha256 ?? "")
    ) {
      reasons.push(
        "hosted archive carrier inventory contains an invalid path or digest"
      );
      continue;
    }
    const carrierBytes = gitRead(rootDir, [
      "show",
      `${carrierCommit}:${entry.path}`
    ]);
    if (
      carrierBytes === null ||
      sha256OfBytes(carrierBytes) !== entry.sha256
    ) {
      reasons.push(
        `${entry.path} is not the exact digest-enumerated byte sequence at evidence carrier ${carrierCommit}`
      );
    }
    if (
      gitRead(rootDir, [
        "cat-file",
        "-e",
        `${candidateCommit}:${entry.path}`
      ]) !== null
    ) {
      reasons.push(
        `${entry.path} must be introduced after candidate C, never embedded in C`
      );
    }
  }
  return reasons;
}

export function hostedArchiverCarrierOrderProblems(
  rootDir,
  candidateCommit,
  archiverCommit,
  carrierCommit
) {
  if (
    !FULL_GIT_SHA.test(candidateCommit ?? "") ||
    !FULL_GIT_SHA.test(archiverCommit ?? "") ||
    !FULL_GIT_SHA.test(carrierCommit ?? "") ||
    gitRead(rootDir, [
      "merge-base",
      "--is-ancestor",
      candidateCommit,
      archiverCommit
    ]) === null ||
    gitRead(rootDir, [
      "merge-base",
      "--is-ancestor",
      archiverCommit,
      carrierCommit
    ]) === null
  ) {
    return [
      "hosted archiver is not ordered candidate C <= archiver <= evidence carrier S"
    ];
  }
  return [];
}

export function durableSoakNestedWorkflowTrustProblems(
  rootDir,
  candidateCommit,
  deploymentCommit
) {
  const reasons = [];
  if (
    !FULL_GIT_SHA.test(candidateCommit ?? "") ||
    !FULL_GIT_SHA.test(deploymentCommit ?? "")
  ) {
    return [
      "durable-soak nested workflow trust requires full candidate and deployment commits"
    ];
  }
  if (
    gitRead(rootDir, [
      "merge-base",
      "--is-ancestor",
      deploymentCommit,
      candidateCommit
    ]) === null
  ) {
    reasons.push(
      "durable-soak deployment is not an ancestor of the verified measurement candidate"
    );
  }
  const workflowPath = ".github/workflows/production-health.yml";
  const deploymentWorkflow = gitRead(rootDir, [
    "show",
    `${deploymentCommit}:${workflowPath}`
  ]);
  const candidateWorkflow = gitRead(rootDir, [
    "show",
    `${candidateCommit}:${workflowPath}`
  ]);
  if (
    deploymentWorkflow === null ||
    candidateWorkflow === null ||
    !deploymentWorkflow.equals(candidateWorkflow)
  ) {
    reasons.push(
      "hourly durable-soak samples ran Production Health workflow bytes that do not equal the candidate-approved workflow"
    );
  }
  return reasons;
}

function verifyHostedEvidenceSubject({
  rootDir,
  measurementContext,
  profile,
  subjectPath,
  subjectSha256,
  subjectCommit,
  trustedPreCandidateSourceCommit,
  expectedSources,
  attestationVerifier
}) {
  const reasons = [];
  if (!measurementContext?.binding) {
    return {
      ok: false,
      reasons: ["no verified measurement candidate is available"],
      verification: null
    };
  }
  if (
    typeof subjectSha256 !== "string" ||
    !SHA256.test(subjectSha256)
  ) {
    return {
      ok: false,
      reasons: [`${subjectPath} has no trusted lowercase sha256 binding`],
      verification: null
    };
  }
  if (
    typeof subjectCommit !== "string" ||
    !FULL_GIT_SHA.test(subjectCommit)
  ) {
    return {
      ok: false,
      reasons: [`${subjectPath} has no trusted subject commit`],
      verification: null
    };
  }
  const subjectAbsolute = path.join(
    rootDir,
    ...subjectPath.split("/")
  );
  if (
    !existsSync(subjectAbsolute) ||
    sha256OfFile(subjectAbsolute) !== subjectSha256
  ) {
    return {
      ok: false,
      reasons: [`${subjectPath} bytes do not match ${subjectSha256}`],
      verification: null
    };
  }

  let relativeDirectory;
  try {
    relativeDirectory = hostedEvidenceArchiveRelativePath(
      profile,
      subjectSha256
    );
  } catch (error) {
    return {
      ok: false,
      reasons: [String(error).slice(0, 240)],
      verification: null
    };
  }
  const directory = path.join(
    rootDir,
    ...relativeDirectory.split("/")
  );
  const contextRelative =
    `${relativeDirectory}/${HOSTED_EVIDENCE_CONTEXT_FILE}`;
  const bundleRelative =
    `${relativeDirectory}/${HOSTED_EVIDENCE_BUNDLE_FILE}`;
  if (!existsSync(directory)) {
    return {
      ok: false,
      reasons: [`${relativeDirectory}/ does not exist`],
      verification: null
    };
  }

  let parsed;
  try {
    parsed = parseAndVerifyHostedEvidenceContext(
      readFileSync(
        path.join(directory, HOSTED_EVIDENCE_CONTEXT_FILE),
        "utf8"
      ),
      {
        expectedProfile: profile,
        expectedSubjectPath: subjectPath,
        expectedSubjectSha256: subjectSha256,
        expectedSubjectCommit: subjectCommit,
        expectedSources
      }
    );
  } catch (error) {
    reasons.push(
      `${contextRelative}: ${String(error).slice(0, 240)}`
    );
  }
  if (!parsed?.ok || !parsed.context) {
    reasons.push(
      ...(
        parsed?.issues ?? [
          `${contextRelative} cannot be parsed as hosted evidence`
        ]
      ).map((issue) => `${contextRelative}: ${issue}`)
    );
    return { ok: false, reasons, verification: null };
  }

  const expectedArchivePaths = new Set([
    contextRelative,
    bundleRelative,
    ...parsed.context.files.map(
      (file) => `${relativeDirectory}/${file.path}`
    )
  ]);
  const boundArchiveEntries = boundEvidence(
    measurementContext,
    "hosted-evidence-archive"
  ).filter((entry) =>
    entry.path.startsWith(`${relativeDirectory}/`)
  );
  const boundArchivePaths = new Set(
    boundArchiveEntries.map((entry) => entry.path)
  );
  if (
    boundArchivePaths.size !== expectedArchivePaths.size ||
    [...expectedArchivePaths].some(
      (entry) => !boundArchivePaths.has(entry)
    )
  ) {
    reasons.push(
      `${relativeDirectory}/ files must be set-equal to the candidate binding's digest-enumerated hosted archive`
    );
  }
  const candidateCommit =
    measurementContext.binding.candidateCommit;
  const carrierCommit =
    measurementContext.binding.carrierCommit;
  reasons.push(
    ...hostedArchiveCarrierPlacementProblems(
      rootDir,
      candidateCommit,
      carrierCommit,
      boundArchiveEntries
    ).map((reason) => `${relativeDirectory}/: ${reason}`)
  );
  for (const entry of boundArchiveEntries) {
    const problem = fileDigestProblem(rootDir, entry);
    if (problem) reasons.push(problem);
  }

  const archiverCommit = parsed.context.archiver?.sourceCommit;
  reasons.push(
    ...hostedArchiverCarrierOrderProblems(
      rootDir,
      candidateCommit,
      archiverCommit,
      carrierCommit
    ).map((reason) => `${contextRelative} ${reason}`)
  );
  if (
    !measurementCandidateAcceptsProducer(
      measurementContext,
      archiverCommit
    )
  ) {
    reasons.push(
      `${contextRelative} archiver is not an accepted measurement carrier commit`
    );
  } else {
    reasons.push(
      ...producerEvidenceProblems(
        rootDir,
        measurementContext,
        contextRelative,
        archiverCommit,
        parsed.context.recordedAt
      )
    );
  }
  const archiverWorkflow = gitRead(rootDir, [
    "show",
    `${archiverCommit}:${HOSTED_EVIDENCE_ARCHIVER_WORKFLOW_PATH}`
  ]);
  const candidateArchiverWorkflow = gitRead(rootDir, [
    "show",
    `${measurementContext.binding.candidateCommit}:${HOSTED_EVIDENCE_ARCHIVER_WORKFLOW_PATH}`
  ]);
  if (
    archiverWorkflow === null ||
    candidateArchiverWorkflow === null ||
    !archiverWorkflow.equals(candidateArchiverWorkflow)
  ) {
    reasons.push(
      `${contextRelative} archiver workflow bytes do not equal the candidate-approved trusted workflow`
    );
  }
  if (reasons.length > 0) {
    return { ok: false, reasons, verification: null };
  }

  const verification = verifyHostedEvidenceDirectory({
    rootDir,
    directory,
    expectedProfile: profile,
    expectedSubjectPath: subjectPath,
    expectedSubjectSha256: subjectSha256,
    expectedSubjectCommit: subjectCommit,
    expectedSources,
    expectedArchiverCommit: archiverCommit,
    ...(attestationVerifier ? { attestationVerifier } : {})
  });
  if (!verification.ok) {
    reasons.push(
      ...verification.issues.map(
        (issue) => `${relativeDirectory}: ${issue}`
      )
    );
  } else {
    reasons.push(
      ...hostedEvidenceSourceTrustProblems(
        rootDir,
        measurementContext,
        profile,
        trustedPreCandidateSourceCommit,
        verification.sources
      ).map((reason) => `${relativeDirectory}: ${reason}`)
    );
  }
  return {
    ok: reasons.length === 0,
    reasons,
    verification: reasons.length === 0 ? verification : null
  };
}

export function hostedSubjectFinalizationCommit(
  rootDir,
  boundCommit,
  subjectPath,
  subjectSha256
) {
  const latest = gitRead(rootDir, [
    "log",
    "-1",
    "--format=%H",
    boundCommit,
    "--",
    subjectPath
  ])
    ?.toString("utf8")
    .trim();
  if (!FULL_GIT_SHA.test(latest ?? "")) return null;
  const subject = gitRead(rootDir, [
    "show",
    `${latest}:${subjectPath}`
  ]);
  const candidate = gitRead(rootDir, [
    "show",
    `${boundCommit}:${subjectPath}`
  ]);
  if (
    subject === null ||
    candidate === null ||
    !subject.equals(candidate) ||
    sha256OfBytes(subject) !== subjectSha256
  ) {
    return null;
  }
  return latest;
}

function boundExactEvidenceProblems(context, rootDir, category, relativePath) {
  if (!context?.configured) return [];
  const matches = boundEvidence(context, category).filter(
    (entry) => entry.path === relativePath
  );
  const reasons = [];
  if (matches.length !== 1) {
    reasons.push(
      `${relativePath} must appear exactly once as ${category} in the measurement binding; found ${matches.length}`
    );
  } else {
    const problem = fileDigestProblem(rootDir, matches[0]);
    if (problem) reasons.push(problem);
  }
  return reasons;
}

function acquireMeasurementFreeze(
  id,
  gate,
  rootDir,
  now,
  context,
  liveArtifactContext,
  liveArtifactContextSha256
) {
  const reasons = [];
  if (gate.receipt !== MEASUREMENT_FREEZE_ARCHIVE_PATH) {
    reasons.push(
      `gate config: receipt must be the fixed ${MEASUREMENT_FREEZE_ARCHIVE_PATH}`
    );
  }
  reasons.push(...measurementCandidateProblems(context));
  const entries = boundEvidence(context, "measurement-freeze-receipt");
  if (entries.length !== 1) {
    reasons.push(
      `measurement candidate must enumerate exactly one freeze receipt; found ${entries.length}`
    );
  } else {
    if (entries[0].path !== MEASUREMENT_FREEZE_ARCHIVE_PATH) {
      reasons.push(
        `the enumerated freeze receipt must be ${MEASUREMENT_FREEZE_ARCHIVE_PATH}`
      );
    }
    const digestProblem = fileDigestProblem(rootDir, entries[0]);
    if (digestProblem) reasons.push(digestProblem);
  }
  let receipt = null;
  if (reasons.length === 0) {
    try {
      const receiptBytes = readFileSync(
        path.join(rootDir, ...MEASUREMENT_FREEZE_ARCHIVE_PATH.split("/"))
      );
      const receiptText = new TextDecoder("utf-8", {
        fatal: true
      }).decode(receiptBytes);
      const verdict = parseAndVerifyMeasurementFreezeActivationReceipt(receiptText, {
        expectedCandidateSha: context.binding.candidateCommit,
        now
      });
      if (!verdict.ok) reasons.push(...verdict.issues);
      else {
        receipt = verdict.receipt;
        if (liveArtifactContext !== undefined) {
          if (
            typeof liveArtifactContext !== "string" ||
            !path.isAbsolute(liveArtifactContext)
          ) {
            reasons.push(
              "measurement-freeze live artifact context must be an absolute path"
            );
          } else {
            verifyMeasurementFreezeActivationArtifactContext({
              receipt,
              receiptBytes,
              contextDirectory: liveArtifactContext,
              expectedContextSha256: liveArtifactContextSha256
            });
          }
        }
      }
    } catch (error) {
      reasons.push(
        `freeze receipt or immutable artifact verification failed: ${String(error).slice(0, 240)}`
      );
    }
  }
  return {
    result: gateResult(
      id,
      gate,
      reasons.length === 0 ? "pass" : "fail",
      reasons.length === 0
        ? [
            `measurement freeze activated at ${receipt.activation.activatedAt} on ${context.binding.candidateCommit}`
          ]
        : reasons
    ),
    receipt
  };
}

function evaluateCalibration(id, gate, rootDir, measurementContext) {
  if (!isNonEmptyStringArray(gate.requiredDetectors)) {
    return gateResult(id, gate, "fail", ["gate config: requiredDetectors must be a non-empty list"]);
  }
  const source = loadCompiled("detector-calibration-source", rootDir);
  const calibration = loadCompiled("detector-calibration", rootDir);
  const calibrationPolicy = loadCompiled(
    "measurement-candidate-binding",
    rootDir
  );
  const schema = loadCompiled("scan-report-v2", rootDir);
  if (!source || !calibration || !calibrationPolicy || !schema) {
    return gateResult(id, gate, "fail", [
      "the compiled schema artifact is unavailable; build it first (tsc -p tsconfig.schema.json)"
    ]);
  }
  // The manifest list must stay in lockstep with the detector registry in
  // BOTH directions: an unknown name is a config error, and a registry
  // detector missing from the list would silently escape release gating.
  const registry = Array.isArray(schema.DETECTOR_IDS) ? schema.DETECTOR_IDS : [];
  const reasons = [];
  for (const detector of gate.requiredDetectors) {
    if (!registry.includes(detector)) reasons.push(`gate config: ${detector} is not a registry detector id`);
  }
  for (const detector of registry) {
    if (!gate.requiredDetectors.includes(detector)) {
      reasons.push(`registry detector ${detector} is not covered by requiredDetectors; cover it or record why it bears no claims`);
    }
  }
  if (reasons.length > 0) return gateResult(id, gate, "fail", reasons);
  const policy = measurementContext?.binding?.calibrationPolicy;
  if (
    !policy ||
    typeof calibrationPolicy.measurementCalibrationAnalysisPolicyProblems !==
      "function"
  ) {
    return gateResult(id, gate, "fail", [
      "the verified candidate calibration adequacy policy is unavailable"
    ]);
  }

  let studies;
  try {
    const sourceOptions =
      measurementContext?.configured && measurementContext.binding
        ? {
            // The binding was already verified once above. This callback only
            // prevents the calibration loader from invoking `gh` a second
            // time while it re-checks the same Git-bound carrier structure.
            attestationVerifier: () => {},
            requireCleanWorktree: true
          }
        : {};
    studies = source.committedCalibrationStudyAnalyses(
      rootDir,
      process.env,
      sourceOptions
    );
  } catch (error) {
    return gateResult(id, gate, "fail", [`committed calibration studies are unreadable: ${String(error).slice(0, 160)}`]);
  }
  const eligibleByDetector = new Set();
  for (const study of studies) {
    if (!calibration.isEligibleCalibrationStatus(study.analysis.status)) {
      reasons.push(
        `${study.studyDir}: status ${study.analysis.status} is not release-eligible`
      );
      continue;
    }
    const policyProblems =
      calibrationPolicy.measurementCalibrationAnalysisPolicyProblems(
        study.analysis,
        policy
      );
    if (!Array.isArray(policyProblems) || policyProblems.length > 0) {
      const normalized =
        Array.isArray(policyProblems) && policyProblems.length > 0
          ? policyProblems
          : ["canonical calibration policy evaluation returned no result"];
      for (const problem of normalized) {
        reasons.push(
          `${study.studyDir}/${study.analysis.detector}: ${problem}`
        );
      }
      continue;
    }
    eligibleByDetector.add(study.analysis.detector);
  }
  const missing = gate.requiredDetectors.filter((detector) => !eligibleByDetector.has(detector));
  if (missing.length === 0) {
    return gateResult(id, gate, "pass", [
      `policy-adequate studies cover all ${gate.requiredDetectors.length} claim-bearing detectors`
    ]);
  }
  return gateResult(id, gate, "fail", [
    `no policy-adequate study at the current identity for: ${missing.join(", ")}`,
    ...reasons
  ]);
}

function evaluateReviewLedger(id, gate, rootDir, now) {
  const ledgerPath = path.join(rootDir, gate.artifact);
  const inventoryPath = path.join(rootDir, gate.inventory);
  for (const [label, filePath] of [[gate.artifact, ledgerPath], [gate.inventory, inventoryPath]]) {
    if (!existsSync(filePath)) return gateResult(id, gate, "fail", [`${label} does not exist`]);
  }
  let ledger;
  let inventory;
  try {
    ledger = readJson(ledgerPath);
    inventory = readJson(inventoryPath);
  } catch {
    return gateResult(id, gate, "fail", ["the review ledger or inventory is not valid JSON"]);
  }
  // The canonical checker owns drift, completeness, and runtime-flag truth;
  // this gate only adds the release bar: zero unreviewed runtime items.
  const verdict = checkReviewLedger(inventory, ledger, now);
  const reasons = [...verdict.problems];
  let runtimeTotal = 0;
  let unreviewedRuntime = 0;
  for (const bucket of Object.values(verdict.summary ?? {})) {
    runtimeTotal += bucket.total;
    unreviewedRuntime += bucket.unreviewedRuntime;
  }
  if (runtimeTotal === 0) reasons.push("the inventory lists no items to review");
  if (unreviewedRuntime > 0) reasons.push(`${unreviewedRuntime} runtime item(s) are unreviewed`);
  return gateResult(id, gate, reasons.length === 0 ? "pass" : "fail", reasons);
}

function acquireRunnerReceipts(
  id,
  gate,
  rootDir,
  now,
  measurementContext,
  freezeContext,
  options = {}
) {
  const configReasons = [];
  if (!Number.isSafeInteger(gate.minimumReceipts) || gate.minimumReceipts < 1) {
    configReasons.push("gate config: minimumReceipts must be a positive integer");
  }
  if (measurementContext.configured) {
    if (typeof gate.expectedEnvironmentDigest !== "string" || !SHA256.test(gate.expectedEnvironmentDigest)) {
      configReasons.push(
        "gate config: expectedEnvironmentDigest must be a release-owned lowercase sha256 (it remains null until the environment is reviewed)"
      );
    }
    if (!Number.isSafeInteger(gate.maxAgeDays) || gate.maxAgeDays < 1 || gate.maxAgeDays > 365) {
      configReasons.push("gate config: maxAgeDays must be an integer from 1 through 365");
    }
    configReasons.push(...measurementCandidateProblems(measurementContext));
    if (!freezeContext?.receipt) configReasons.push("the verified measurement-freeze receipt is unavailable");
  }
  const directory = path.join(rootDir, gate.directory);
  if (!existsSync(directory)) {
    configReasons.push(`${gate.directory}/ does not exist (${gate.minimumReceipts} verifying receipts required)`);
    return {
      result: gateResult(id, gate, "fail", configReasons),
      verification: null,
      receipts: [],
      hosted: []
    };
  }
  const reasons = [...configReasons];
  const receipts = [];
  // The full directory listing, including files that fail to parse, because the
  // binding set-equality check below must still see them.
  const receiptPaths = [];
  // Pairs a parsed receipt with its own path, so attribution cannot drift when a
  // file in the listing never yields a receipt.
  const parsedReceipts = [];
  const hosted = [];
  for (const entry of readdirSync(directory).sort()) {
    if (!entry.endsWith(".json")) continue;
    const relative = path.posix.join(gate.directory, entry);
    receiptPaths.push(relative);
    try {
      const receipt = parseCanonicalRunnerDestructionReceiptBytes(
        readFileSync(path.join(directory, entry)),
        relative
      );
      receipts.push(receipt);
      parsedReceipts.push({ receipt, receiptPath: relative });
      const individual = verifyRunnerDestructionReceipt(receipt);
      if (!individual.ok) {
        reasons.push(
          ...individual.issues.map((issue) => `${entry}: ${issue}`)
        );
      } else if (measurementContext.configured) {
        const hostedVerification = verifyHostedEvidenceSubject({
          rootDir,
          measurementContext,
          profile: "runner-destruction",
          subjectPath: relative,
          subjectSha256: sha256OfFile(path.join(directory, entry)),
          subjectCommit:
            measurementContext.binding?.evidenceIntroducedAt?.[
              relative
            ],
          expectedSources: [
            {
              role: "collection",
              workflowPath: ".github/workflows/scan-featured.yml",
              runId: receipt.actionsRunId,
              runAttempt: receipt.actionsRunAttempt,
              headSha: receipt.runEvidence.headSha,
              artifactId: receipt.runEvidence.artifact.id,
              artifactName: receipt.runEvidence.artifact.name,
              artifactSha256: receipt.runEvidence.artifact.sha256,
              requiredJobNames: ["Populate Featured Gallery"]
            },
            {
              role: "destruction",
              workflowPath:
                receipt.destructionEvidence.workflow,
              runId: receipt.destructionEvidence.runId,
              runAttempt:
                receipt.destructionEvidence.runAttempt,
              headSha: receipt.destructionEvidence.headSha,
              artifactId:
                receipt.destructionEvidence.artifact.id,
              artifactName:
                receipt.destructionEvidence.artifact.name,
              artifactSha256:
                receipt.destructionEvidence.artifact.sha256,
              requiredJobNames: [
                "Read back provider destruction and absence"
              ]
            }
          ],
          attestationVerifier:
            options.hostedEvidenceAttestationVerifier
        });
        if (!hostedVerification.ok) {
          reasons.push(
            ...hostedVerification.reasons.map(
              (reason) => `${entry}: ${reason}`
            )
          );
        } else {
          const destructionSource =
            hostedVerification.verification.sources.find(
              (source) => source.role === "destruction"
            );
          const readbackMembers =
            destructionSource?.artifact?.members?.filter(
              (member) =>
                member.path ===
                  receipt.destructionEvidence.readback.path &&
                member.sha256 ===
                  receipt.destructionEvidence.readback.sha256
            ) ?? [];
          if (readbackMembers.length !== 1) {
            reasons.push(
              `${entry}: hosted destruction artifact must carry the exact digest-bound provider readback member`
            );
          }
          hosted.push({
            receiptPath: relative,
            runId: receipt.actionsRunId,
            runAttempt: receipt.actionsRunAttempt,
            verification: hostedVerification.verification
          });
        }
      }
    } catch (error) {
      reasons.push(`${entry}: ${String(error).slice(0, 160)}`);
    }
  }
  if (measurementContext.configured) {
    const boundEntries = boundEvidence(measurementContext, "runner-receipt");
    const boundPaths = boundEntries.map((entry) => entry.path).sort();
    if (JSON.stringify(receiptPaths) !== JSON.stringify(boundPaths)) {
      reasons.push(
        "runner receipt files must be set-equal to the measurement-candidate binding's digest-enumerated runner receipts"
      );
    }
    for (const entry of boundEntries) {
      const problem = fileDigestProblem(rootDir, entry);
      if (problem) reasons.push(problem);
    }
    for (const { receipt, receiptPath } of parsedReceipts) {
      if (
        !measurementCandidateAcceptsProducer(
          measurementContext,
          receipt?.runEvidence?.headSha
        )
      ) {
        reasons.push(
          `${receiptPath} source is not an accepted measurement carrier commit`
        );
      }
      reasons.push(
        ...producerEvidenceProblems(
          rootDir,
          measurementContext,
          receiptPath,
          receipt?.runEvidence?.headSha,
          receipt?.runEvidence?.job?.startedAt
        ),
        ...producerEvidenceProblems(
          rootDir,
          measurementContext,
          receiptPath,
          receipt?.runEvidence?.headSha,
          receipt?.recordedAt
        )
      );
    }
  }
  if (receipts.length < gate.minimumReceipts) {
    reasons.push(`${receipts.length} of ${gate.minimumReceipts} required controlled cycles`);
  }
  let verification = null;
  if (reasons.length === 0) {
    verification = verifyRunnerDestructionReceiptSet(
      receipts,
      measurementContext.configured
        ? {
            expectedEnvironmentDigest: gate.expectedEnvironmentDigest,
            epochStartedAt: freezeContext.receipt.activation.activatedAt,
            now,
            maxAgeDays: gate.maxAgeDays
          }
        : {}
    );
    if (!verification.ok) reasons.push(...verification.issues);
  }
  return {
    result: gateResult(
      id,
      gate,
      reasons.length === 0 ? "pass" : "fail",
      reasons.length === 0
        ? [
            `${receipts.length} controlled cycles bind ${
              measurementContext.binding?.candidateCommit ?? "their internally consistent source"
            } and environment ${verification.environmentDigest}`
          ]
        : reasons
    ),
    verification: reasons.length === 0 ? verification : null,
    receipts: reasons.length === 0 ? receipts : [],
    hosted: reasons.length === 0 ? hosted : []
  };
}

function evaluateControlledPublications(
  id,
  gate,
  rootDir,
  measurementContext,
  runnerContext,
  options = {}
) {
  const reasons = [];
  if (
    gate.directory !== CONTROLLED_PUBLICATION_ROOT ||
    gate.requiredPublications !== 2
  ) {
    reasons.push(
      `gate config: directory must be ${CONTROLLED_PUBLICATION_ROOT} and requiredPublications must be exactly 2`
    );
  }
  reasons.push(...measurementCandidateProblems(measurementContext));
  const runners = runnerContext?.receipts ?? [];
  if (runners.length !== 2 || !runnerContext?.verification?.ok) {
    reasons.push(
      "exactly two verified controlled-runner destruction receipts are required"
    );
  }

  const manifestEntries = boundEvidence(
    measurementContext,
    "controlled-publication-manifest"
  );
  const receiptEntries = boundEvidence(
    measurementContext,
    "controlled-publication-receipt"
  );
  if (manifestEntries.length !== 2 || receiptEntries.length !== 2) {
    reasons.push(
      `measurement binding must enumerate exactly two controlled publication manifest/receipt pairs; found ${manifestEntries.length}/${receiptEntries.length}`
    );
  }
  for (const entry of [...manifestEntries, ...receiptEntries]) {
    const problem = fileDigestProblem(rootDir, entry);
    if (problem) reasons.push(problem);
  }

  const directory = path.join(rootDir, CONTROLLED_PUBLICATION_ROOT);
  const publicationEntries = existsSync(directory)
    ? readdirSync(directory, { withFileTypes: true })
    : [];
  if (publicationEntries.some((entry) => !entry.isDirectory())) {
    reasons.push(
      "the controlled publication root may contain only the two canonical run directories"
    );
  }
  const actualDirectories = publicationEntries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const expectedDirectories = runners
    .map(
      (runner) =>
        `${runner.actionsRunId}-${runner.actionsRunAttempt}`
    )
    .sort();
  if (
    JSON.stringify(actualDirectories) !== JSON.stringify(expectedDirectories)
  ) {
    reasons.push(
      "controlled publication directories must be set-equal to the two verified runner cycles"
    );
  }

  const boundPaths = new Set(
    [...manifestEntries, ...receiptEntries].map((entry) => entry.path)
  );
  const expectedPaths = new Set(
    expectedDirectories.flatMap((name) => [
      `${CONTROLLED_PUBLICATION_ROOT}/${name}/publication.json`,
      `${CONTROLLED_PUBLICATION_ROOT}/${name}/receipt.json`
    ])
  );
  if (
    boundPaths.size !== expectedPaths.size ||
    [...expectedPaths].some((entry) => !boundPaths.has(entry))
  ) {
    reasons.push(
      "controlled publication files must be set-equal to the binding's two manifest/receipt pairs"
    );
  }

  const governedReportIds = new Set();
  const artifactIds = new Set();
  for (const runner of runners) {
    const relativeRoot =
      `${CONTROLLED_PUBLICATION_ROOT}/${runner.actionsRunId}-${runner.actionsRunAttempt}`;
    const manifestPath = `${relativeRoot}/publication.json`;
    const receiptPath = `${relativeRoot}/receipt.json`;
    if (artifactIds.has(runner.runEvidence.artifact.id)) {
      reasons.push(
        `controlled publication cycles duplicate artifact id ${runner.runEvidence.artifact.id}`
      );
    }
    artifactIds.add(runner.runEvidence.artifact.id);
    try {
      const verified = verifyControlledPublicationDirectory({
        checkoutRoot: rootDir,
        directory: path.join(rootDir, ...relativeRoot.split("/")),
        runId: runner.actionsRunId,
        runAttempt: runner.actionsRunAttempt,
        sourceCommit: runner.runEvidence.headSha,
        artifactId: runner.runEvidence.artifact.id,
        archiveSha256: runner.runEvidence.artifact.sha256
      });
      const hostedPublication = verifyHostedEvidenceSubject({
        rootDir,
        measurementContext,
        profile: "controlled-publication",
        subjectPath: receiptPath,
        subjectSha256: verified.receiptSha256,
        subjectCommit:
          measurementContext.binding?.evidenceIntroducedAt?.[
            receiptPath
          ],
        expectedSources: [
          {
            role: "publisher",
            workflowPath: ".github/workflows/scan-featured.yml",
            runId: runner.actionsRunId,
            runAttempt: runner.actionsRunAttempt,
            headSha: runner.runEvidence.headSha,
            artifactName:
              `site-behavior-controlled-publication-evidence-${runner.actionsRunId}-${runner.actionsRunAttempt}`,
            requiredJobNames: [
              "Validate and Publish Featured Reports"
            ]
          }
        ],
        attestationVerifier:
          options.hostedEvidenceAttestationVerifier
      });
      if (!hostedPublication.ok) {
        reasons.push(...hostedPublication.reasons);
      } else {
        const publisherArtifact =
          hostedPublication.verification.sources.find(
            (source) => source.role === "publisher"
          )?.artifact;
        const expectedPublisherMembers = new Map([
          ["publication.json", verified.manifestSha256],
          ["receipt.json", verified.receiptSha256]
        ]);
        if (
          !Array.isArray(publisherArtifact?.members) ||
          publisherArtifact.members.length !==
            expectedPublisherMembers.size ||
          publisherArtifact.members.some(
            (member) =>
              expectedPublisherMembers.get(member.path) !==
              member.sha256
          )
        ) {
          reasons.push(
            `${relativeRoot}: hosted publisher artifact must carry the exact publication manifest and receipt bytes`
          );
        }
      }

      const runnerHosted = runnerContext.hosted.find(
        (entry) =>
          entry.runId === runner.actionsRunId &&
          entry.runAttempt === runner.actionsRunAttempt
      )?.verification;
      const collectionSource = runnerHosted?.sources.find(
        (source) => source.role === "collection"
      );
      if (
        !runnerHosted ||
        !collectionSource?.files?.artifactMetadata ||
        !collectionSource?.files?.artifactArchive
      ) {
        reasons.push(
          `${relativeRoot}: authenticated collection artifact metadata and ZIP are unavailable`
        );
      } else {
        const runnerArchiveRoot = path.join(
          rootDir,
          ...hostedEvidenceArchiveRelativePath(
            "runner-destruction",
            runnerHosted.subjectSha256
          ).split("/")
        );
        try {
          verifyControlledPublicationArtifact({
            checkoutRoot: rootDir,
            metadataPath: path.join(
              runnerArchiveRoot,
              ...collectionSource.files.artifactMetadata.split("/")
            ),
            archivePath: path.join(
              runnerArchiveRoot,
              ...collectionSource.files.artifactArchive.split("/")
            ),
            receipt: verified.receipt
          });
        } catch (error) {
          reasons.push(
            `${relativeRoot}: controlled publication does not re-derive from the retained authenticated collection ZIP: ${String(error).slice(0, 220)}`
          );
        }
      }
      const ids = verified.manifest.expectedReportIds;
      for (const reportId of ids) {
        if (governedReportIds.has(reportId)) {
          reasons.push(
            `controlled publication cycles duplicate report id ${reportId}`
          );
        }
        governedReportIds.add(reportId);
      }
      for (const evidencePath of [manifestPath, receiptPath]) {
        reasons.push(
          ...producerEvidenceProblems(
            rootDir,
            measurementContext,
            evidencePath,
            runner.runEvidence.headSha,
            runner.recordedAt
          )
        );
      }
    } catch (error) {
      reasons.push(
        `${relativeRoot}: ${String(error).slice(0, 240)}`
      );
    }
  }

  const reportIds = boundEvidence(measurementContext, "featured-report")
    .map((entry) => path.posix.basename(entry.path, ".json"))
    .sort();
  const provenanceIds = boundEvidence(
    measurementContext,
    "featured-provenance"
  )
    .map((entry) =>
      path.posix.basename(entry.path, ".provenance.json")
    )
    .sort();
  const publicationIds = [...governedReportIds].sort();
  if (
    JSON.stringify(publicationIds) !== JSON.stringify(reportIds) ||
    JSON.stringify(publicationIds) !== JSON.stringify(provenanceIds)
  ) {
    reasons.push(
      "the union of controlled publication report ids must be set-equal to the digest-bound featured report/provenance pairs"
    );
  }
  return gateResult(
    id,
    gate,
    reasons.length === 0 ? "pass" : "fail",
    reasons.length === 0
      ? [
          `two controlled publication archives bind ${publicationIds.length} report/provenance pairs to their runner cycles`
        ]
      : reasons
  );
}

function evaluateLifecycleReceipt(
  id,
  gate,
  rootDir,
  now,
  measurementContext,
  options = {}
) {
  if (!Number.isSafeInteger(gate.maxAgeDays) || gate.maxAgeDays < 1) {
    return gateResult(id, gate, "fail", ["gate config: maxAgeDays must be a positive integer"]);
  }
  const receiptPath = path.join(rootDir, gate.receipt);
  if (!existsSync(receiptPath)) return gateResult(id, gate, "fail", [`${gate.receipt} does not exist`]);
  let receipt;
  try {
    receipt = readJson(receiptPath);
  } catch {
    return gateResult(id, gate, "fail", [`${gate.receipt} is not valid JSON`]);
  }
  const reasons = [
    ...boundExactEvidenceProblems(
      measurementContext,
      rootDir,
      "lifecycle-receipt",
      gate.receipt
    ),
    ...evidenceFinalizationProblems(
      rootDir,
      measurementContext,
      gate.receipt,
      "recordedAt",
      receipt.recordedAt
    )
  ];
  const verdict = validateR2LifecycleReadbackReceipt(receipt);
  if (!verdict.ok) {
    reasons.push(
      ...verdict.problems.map(
        (problem) => `lifecycle receipt: ${problem}`
      )
    );
  } else if (receipt.ok !== true) {
    reasons.push(
      "the authenticated lifecycle source does not satisfy the production reports/ backstop policy"
    );
  }
  const staleness = timestampProblem("recordedAt", receipt.recordedAt, now, gate.maxAgeDays);
  if (staleness) reasons.push(staleness);
  if (verdict.ok && measurementContext.configured) {
    const subjectSha256 = sha256OfFile(receiptPath);
    const subjectCommit = hostedSubjectFinalizationCommit(
      rootDir,
      measurementContext.binding.carrierCommit,
      gate.receipt,
      subjectSha256
    );
    if (subjectCommit === null) {
      reasons.push(
        `${gate.receipt} has no final evidence-carrier commit containing its exact bytes`
      );
    }
    const hosted = verifyHostedEvidenceSubject({
      rootDir,
      measurementContext,
      profile: "lifecycle",
      subjectPath: gate.receipt,
      subjectSha256,
      subjectCommit,
      attestationVerifier:
        options.hostedEvidenceAttestationVerifier
    });
    if (!hosted.ok) {
      reasons.push(...hosted.reasons);
    } else {
      const source = hosted.verification.sources.find(
        (entry) => entry.role === "readback"
      );
      const receiptMembers =
        source?.artifact?.members?.filter(
          (member) =>
            member.path === "receipt.json" &&
            member.sha256 === subjectSha256
        ) ?? [];
      if (receiptMembers.length !== 1) {
        reasons.push(
          "hosted lifecycle readback artifact must carry the exact canonical lifecycle receipt"
        );
      }
      if (
        !measurementCandidateAcceptsProducer(
          measurementContext,
          source?.headSha
        )
      ) {
        reasons.push(
          "hosted lifecycle readback source is not an accepted measurement carrier"
        );
      } else {
        reasons.push(
          ...producerEvidenceProblems(
            rootDir,
            measurementContext,
            gate.receipt,
            source.headSha,
            receipt.recordedAt
          )
        );
      }
    }
  }
  return gateResult(id, gate, reasons.length === 0 ? "pass" : "fail", reasons);
}

function evaluateReceiptArchive(id, gate, rootDir) {
  const directory = path.join(rootDir, gate.directory);
  if (!existsSync(directory)) {
    return gateResult(id, gate, "fail", [`${gate.directory}/ holds no archived release receipt yet`]);
  }
  const reasons = [];
  let archived = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const receiptPath = path.join(directory, entry.name, "release-receipt.json");
    if (!existsSync(receiptPath)) {
      reasons.push(`${entry.name}/ carries no release-receipt.json`);
      continue;
    }
    try {
      const receipt = readJson(receiptPath);
      const receiptReasons = archivedReleaseReceiptProblems(receipt, entry.name, {
        rootDir,
        receiptPath
      });
      if (receiptReasons.length === 0) archived += 1;
      else reasons.push(...receiptReasons.map((reason) => `${entry.name}/release-receipt.json: ${reason}`));
    } catch {
      reasons.push(`${entry.name}/release-receipt.json is not valid JSON`);
    }
  }
  if (archived >= 1 && reasons.length === 0) {
    return gateResult(id, gate, "pass", [`${archived} archived release receipt(s)`]);
  }
  reasons.unshift(`${gate.directory}/ holds no archived release receipt yet`);
  return gateResult(id, gate, "fail", reasons);
}

function archivedReleaseReceiptProblems(receipt, directoryVersion, { rootDir, receiptPath }) {
  if (!isRecord(receipt)) return ["receipt must be an object"];
  const reasons = [];
  const repository = "https://github.com/iAnonymous3000/site-behavior-lab";
  const topLevelKeys = ["schemaVersion", "evidenceKind", "release", "source", "inputs", "artifacts"];
  if (!hasExactKeys(receipt, topLevelKeys)) {
    reasons.push(`receipt must contain exactly ${topLevelKeys.join(", ")}`);
  }
  if (receipt.schemaVersion !== 1) reasons.push("schemaVersion must be 1");
  if (receipt.evidenceKind !== "exact-source-and-tested-artifact-manifest") {
    reasons.push("evidenceKind must be exact-source-and-tested-artifact-manifest");
  }
  if (!/^(?:0\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?|1\.0\.0(?:-rc\.[1-9]\d*)?)$/.test(directoryVersion)) {
    reasons.push(`archive directory ${directoryVersion} must be a supported 0.x or exact 1.0 semantic version`);
  }
  if (!isRecord(receipt.release)) {
    reasons.push("release must be an object");
  } else {
    const releaseKeys = [
      "status",
      "version",
      "tag",
      "releaseDate",
      "stablePublicApi",
      "npmPublication",
      "requiredNode",
      "requiredNpm",
      "repository",
      "tagExists",
      "evidencesReleaseCommit"
    ];
    if (!hasExactKeys(receipt.release, releaseKeys)) {
      reasons.push(`release must contain exactly ${releaseKeys.join(", ")}`);
    }
    if (receipt.release.status !== "released") reasons.push("release.status must be released");
    if (receipt.release.version !== directoryVersion) {
      reasons.push(`release.version must match archive directory ${directoryVersion}`);
    }
    if (receipt.release.tag !== `v${directoryVersion}`) {
      reasons.push(`release.tag must be v${directoryVersion}`);
    }
    if (!isCanonicalDate(receipt.release.releaseDate)) {
      reasons.push("release.releaseDate must be a real canonical YYYY-MM-DD date");
    }
    if (receipt.release.repository !== repository) {
      reasons.push("release.repository must name this repository");
    }
    if (receipt.release.stablePublicApi !== false || receipt.release.npmPublication !== "disabled") {
      reasons.push("curated release archive must not claim a blanket stable API or npm publication");
    }
    if (
      !isCanonicalBoundedString(receipt.release.requiredNode, 100) ||
      !isCanonicalBoundedString(receipt.release.requiredNpm, 100)
    ) {
      reasons.push("release must name bounded Node and npm toolchain versions");
    }
    if (receipt.release.tagExists !== false || receipt.release.evidencesReleaseCommit !== false) {
      reasons.push("archived release-job receipt must preserve the honest pre-tag false/false state");
    }
  }
  if (!isRecord(receipt.source)) {
    reasons.push("source must be an object");
  } else {
    const sourceKeys = ["repository", "commit", "tree", "requiredNode", "requiredNpm"];
    if (!hasExactKeys(receipt.source, sourceKeys)) {
      reasons.push(`source must contain exactly ${sourceKeys.join(", ")}`);
    }
    if (
      receipt.source.repository !== repository ||
      !FULL_GIT_SHA.test(receipt.source.commit ?? "") ||
      !FULL_GIT_SHA.test(receipt.source.tree ?? "")
    ) {
      reasons.push("source must bind this repository to full commit and tree SHAs");
    }
    if (
      receipt.source.requiredNode !== receipt.release?.requiredNode ||
      receipt.source.requiredNpm !== receipt.release?.requiredNpm
    ) {
      reasons.push("source and release toolchain versions must match");
    }
  }
  const expectedInputs = {
    packageLock: "package-lock.json",
    dockerfile: "Dockerfile",
    productionContainerConfig: "wrangler.container.jsonc",
    releasePolicy: "release-policy.json"
  };
  if (!isRecord(receipt.inputs)) {
    reasons.push("inputs must be an object");
  } else {
    if (!hasExactKeys(receipt.inputs, Object.keys(expectedInputs))) {
      reasons.push(`inputs must contain exactly ${Object.keys(expectedInputs).join(", ")}`);
    }
    for (const [name, expectedPath] of Object.entries(expectedInputs)) {
      const input = receipt.inputs[name];
      if (
        !isRecord(input) ||
        !hasExactKeys(input, ["path", "bytes", "sha256"]) ||
        input.path !== expectedPath ||
        !Number.isSafeInteger(input.bytes) ||
        input.bytes < 0 ||
        !SHA256.test(input.sha256 ?? "")
      ) {
        reasons.push(`input ${name} must carry the canonical path, byte count, and sha256`);
      }
    }
  }
  if (!Array.isArray(receipt.artifacts) || receipt.artifacts.length !== 1) {
    reasons.push("artifacts must contain exactly one tested static artifact");
  } else {
    const artifact = receipt.artifacts[0];
    const artifactKeys = [
      "name",
      "kind",
      "path",
      "deployment",
      "digestAlgorithm",
      "manifestSha256",
      "fileCount",
      "bytes",
      "files"
    ];
    if (!isRecord(artifact) || !hasExactKeys(artifact, artifactKeys)) {
      reasons.push(`static artifact must contain exactly ${artifactKeys.join(", ")}`);
    } else {
      if (
        artifact.name !== "static-pages" ||
        artifact.kind !== "directory-manifest" ||
        artifact.path !== "out" ||
        artifact.digestAlgorithm !== "sha256"
      ) {
        reasons.push("static artifact must identify the canonical out/ directory manifest");
      }
      if (!isRecord(artifact.deployment) || !hasExactKeys(
        artifact.deployment,
        ["schemaVersion", "deployment", "revisionCommittedAt"]
      )) {
        reasons.push("static artifact deployment receipt has the wrong shape");
      } else {
        if (
          artifact.deployment.schemaVersion !== 1 ||
          artifact.deployment.deployment !== receipt.source?.commit
        ) {
          reasons.push("static artifact deployment must bind the source commit");
        }
        if (canonicalInstantMillis(artifact.deployment.revisionCommittedAt) === null) {
          reasons.push("static artifact revisionCommittedAt must be a real canonical UTC instant");
        }
      }
      if (!Array.isArray(artifact.files) || artifact.files.length === 0) {
        reasons.push("static artifact files must be a non-empty manifest");
      } else {
        let byteTotal = 0;
        let previousPath = null;
        const seenPaths = new Set();
        for (const [index, file] of artifact.files.entries()) {
          if (
            !isRecord(file) ||
            !hasExactKeys(file, ["path", "bytes", "sha256"]) ||
            !isCanonicalRelativePath(file.path) ||
            !Number.isSafeInteger(file.bytes) ||
            file.bytes < 0 ||
            !SHA256.test(file.sha256 ?? "")
          ) {
            reasons.push(`static artifact file ${index} is malformed`);
            continue;
          }
          if (seenPaths.has(file.path)) reasons.push(`static artifact repeats file path ${file.path}`);
          if (previousPath !== null && previousPath >= file.path) {
            reasons.push("static artifact files must use unique canonical sort order");
          }
          seenPaths.add(file.path);
          previousPath = file.path;
          byteTotal += file.bytes;
          if (!Number.isSafeInteger(byteTotal)) reasons.push("static artifact byte total is not a safe integer");
        }
        if (artifact.fileCount !== artifact.files.length) {
          reasons.push("static artifact fileCount does not match the files manifest");
        }
        if (!Number.isSafeInteger(artifact.bytes) || artifact.bytes !== byteTotal) {
          reasons.push("static artifact bytes does not match the files manifest");
        }
        if (
          !SHA256.test(artifact.manifestSha256 ?? "") ||
          artifact.manifestSha256 !== sha256OfBytes(JSON.stringify(artifact.files))
        ) {
          reasons.push("static artifact manifestSha256 does not match the committed files manifest");
        }
      }
    }
  }
  reasons.push(
    ...archivedReleaseGitProblems(receipt, directoryVersion, {
      rootDir,
      receiptPath,
      expectedInputs
    })
  );
  return reasons;
}

function archivedReleaseGitProblems(receipt, directoryVersion, { rootDir, receiptPath, expectedInputs }) {
  const reasons = [];
  const shallow = gitRead(rootDir, ["rev-parse", "--is-shallow-repository"]);
  if (shallow === null) {
    return ["release receipt provenance requires a Git checkout with fetch-depth: 0 and tags"];
  }
  if (shallow.toString("utf8").trim() !== "false") {
    return ["release receipt provenance cannot be verified in a shallow checkout; fetch with depth 0 and tags"];
  }

  const commit = receipt.source?.commit;
  if (!FULL_GIT_SHA.test(commit ?? "")) return reasons;
  const objectType = gitRead(rootDir, ["cat-file", "-t", commit]);
  if (objectType?.toString("utf8").trim() !== "commit") {
    return [`source commit ${commit} is unavailable; fetch full history and tags before evaluating readiness`];
  }
  const sourceTree = gitRead(rootDir, ["rev-parse", `${commit}^{tree}`]);
  if (sourceTree?.toString("utf8").trim() !== receipt.source?.tree) {
    reasons.push("source.tree does not match the tree of source.commit");
  }
  const committedAt = gitRead(rootDir, ["show", "-s", "--format=%cI", commit]);
  const committedAtMillis = Date.parse(committedAt?.toString("utf8").trim() ?? "");
  const receiptCommittedAt = canonicalInstantMillis(receipt.artifacts?.[0]?.deployment?.revisionCommittedAt);
  if (
    !Number.isFinite(committedAtMillis) ||
    receiptCommittedAt === null ||
    committedAtMillis !== receiptCommittedAt
  ) {
    reasons.push("static artifact revisionCommittedAt does not match the source commit");
  }

  for (const [name, repositoryPath] of Object.entries(expectedInputs)) {
    const bytes = gitRead(rootDir, ["show", `${commit}:${repositoryPath}`]);
    if (bytes === null) {
      reasons.push(`source input ${repositoryPath} is unavailable at ${commit}; fetch full history`);
      continue;
    }
    const recorded = receipt.inputs?.[name];
    if (
      recorded?.path !== repositoryPath ||
      recorded?.bytes !== bytes.length ||
      recorded?.sha256 !== sha256OfBytes(bytes)
    ) {
      reasons.push(`input ${name} does not match ${repositoryPath} at source.commit`);
    }
  }

  const tag = `v${directoryVersion}`;
  const tagType = gitRead(rootDir, ["cat-file", "-t", `refs/tags/${tag}`]);
  if (tagType?.toString("utf8").trim() !== "tag") {
    reasons.push(`${tag} must be an available annotated tag; fetch full history and tags`);
    return reasons;
  }
  const taggedCommit = gitRead(rootDir, ["rev-parse", `refs/tags/${tag}^{commit}`]);
  if (taggedCommit?.toString("utf8").trim() !== commit) {
    reasons.push(`${tag} does not target source.commit`);
  }
  const tagContents = gitRead(rootDir, ["for-each-ref", "--format=%(contents)", `refs/tags/${tag}`]);
  const receiptSha256 = sha256OfFile(receiptPath);
  const digestLine = `Release receipt sha256: ${receiptSha256}`;
  if (
    tagContents === null ||
    !tagContents
      .toString("utf8")
      .split(/\r?\n/)
      .some((line) => line === digestLine)
  ) {
    reasons.push(`${tag} does not embed the archived receipt sha256`);
  }
  return reasons;
}

function gitRead(rootDir, args) {
  try {
    return execFileSync("git", args, {
      cwd: rootDir,
      encoding: "buffer",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024
    });
  } catch {
    return null;
  }
}

function hasExactKeys(value, expected) {
  return (
    isRecord(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort())
  );
}

function isCanonicalDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const instant = Date.UTC(year, month - 1, day);
  return Number.isFinite(instant) && new Date(instant).toISOString().slice(0, 10) === value;
}

function isCanonicalRelativePath(value) {
  return (
    isCanonicalBoundedString(value, 2048) &&
    !value.includes("\\") &&
    !path.posix.isAbsolute(value) &&
    path.posix.normalize(value) === value &&
    value.split("/").every((segment) => segment !== "." && segment !== ".." && segment !== "")
  );
}

/**
 * Uniform operator attestation: named human, dated within the gate's window,
 * bound to the manifest's exact targetRelease and evidence subjects, with the
 * gate's exact required claims literally true.
 */
export function operatorAttestationIssues(attestation, gateId, binding = {}) {
  if (!isRecord(attestation)) return ["attestation must be an object"];
  const issues = [];
  const expectedTopLevelKeys = [
    "kind",
    "gateId",
    "targetRelease",
    "attestedBy",
    "attestedAt",
    "evidenceCapturedAt",
    "bindings",
    "statements",
    "evidenceRefs",
    ...(binding.minimumEvidenceHours !== undefined ? ["evidenceWindow"] : [])
  ];
  if (!hasExactKeys(attestation, expectedTopLevelKeys)) {
    issues.push(
      `attestation must contain exactly ${expectedTopLevelKeys.join(", ")}`
    );
  }
  if (attestation.kind !== OPERATOR_ATTESTATION_KIND) issues.push(`kind must be ${OPERATOR_ATTESTATION_KIND}`);
  if (attestation.gateId !== gateId) issues.push(`gateId must be ${gateId}`);
  if (typeof attestation.attestedBy !== "string" || attestation.attestedBy.trim().length === 0) {
    issues.push("attestedBy must name the operator");
  }
  if (binding.targetRelease !== undefined && attestation.targetRelease !== binding.targetRelease) {
    issues.push(`targetRelease must be ${binding.targetRelease}; an attestation for another release cannot satisfy this one`);
  }
  const staleness = timestampProblem(
    "attestedAt",
    attestation.attestedAt,
    binding.now ?? Date.now(),
    binding.maxAgeDays
  );
  if (staleness) issues.push(staleness);

  const evidenceStaleness = timestampProblem(
    "evidenceCapturedAt",
    attestation.evidenceCapturedAt,
    binding.now ?? Date.now(),
    binding.maxAgeDays
  );
  if (evidenceStaleness) issues.push(evidenceStaleness);
  const attestedAt = canonicalInstantMillis(attestation.attestedAt);
  const evidenceCapturedAt = canonicalInstantMillis(attestation.evidenceCapturedAt);
  if (attestedAt !== null && evidenceCapturedAt !== null && attestedAt < evidenceCapturedAt) {
    issues.push("attestedAt cannot precede evidenceCapturedAt");
  }

  const requiredClaims = Array.isArray(binding.requiredClaims) ? binding.requiredClaims : [];
  const requiredClaimIds = requiredClaims.map((claim) => claim?.id);
  if (
    requiredClaims.length === 0 ||
    requiredClaims.some(
      (claim) =>
        !isRecord(claim) ||
        !isCanonicalBoundedString(claim.id, 100) ||
        !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(claim.id) ||
        !isCanonicalBoundedString(claim.claim)
    ) ||
    hasDuplicates(requiredClaimIds)
  ) {
    issues.push("gate config requiredClaims must be a non-empty, unique list of stable ids and exact claims");
  }
  if (!Array.isArray(attestation.statements)) {
    issues.push("statements must list what is being attested");
  } else {
    const seen = new Set();
    for (const statement of attestation.statements) {
      if (
        !isRecord(statement) ||
        !isCanonicalBoundedString(statement.claimId, 100) ||
        !isCanonicalBoundedString(statement.claim) ||
        statement.true !== true
      ) {
        issues.push(
          `every statement must carry a stable claimId, exact claim, and be literally true (offender: ${JSON.stringify(statement).slice(0, 100)})`
        );
        continue;
      }
      if (seen.has(statement.claimId)) issues.push(`duplicate statement claimId ${statement.claimId}`);
      seen.add(statement.claimId);
      const expected = requiredClaims.find((claim) => claim.id === statement.claimId);
      if (!expected) issues.push(`statement ${statement.claimId} is not required by gate ${gateId}`);
      else if (statement.claim !== expected.claim) {
        issues.push(`statement ${statement.claimId} does not match the gate's exact claim`);
      }
    }
    for (const claim of requiredClaims) {
      if (isRecord(claim) && !seen.has(claim.id)) issues.push(`required claim ${claim.id} is missing`);
    }
  }

  const requiredBindings = Array.isArray(binding.requiredBindings) ? binding.requiredBindings : [];
  if (
    requiredBindings.length === 0 ||
    requiredBindings.some(
      (name) => !isCanonicalBoundedString(name, 100) || !/^[a-z][A-Za-z0-9]*$/.test(name)
    ) ||
    hasDuplicates(requiredBindings)
  ) {
    issues.push("gate config requiredBindings must be a non-empty, unique list of binding names");
  }
  if (!isRecord(attestation.bindings)) {
    issues.push("bindings must bind the evidence to its exact subjects");
  } else {
    const bindingNames = Object.keys(attestation.bindings);
    for (const name of requiredBindings) {
      const value = attestation.bindings[name];
      if (name.endsWith("Commit")) {
        if (typeof value !== "string" || !FULL_GIT_SHA.test(value)) {
          issues.push(`binding ${name} must be a full lowercase Git SHA`);
        }
      } else if (
        name.endsWith("Digest") ||
        name.endsWith("Sha256")
      ) {
        if (typeof value !== "string" || !SHA256.test(value)) {
          issues.push(`binding ${name} must be a lowercase sha256`);
        }
      } else if (!isCanonicalBoundedString(value)) {
        issues.push(`binding ${name} must be a canonical non-empty string`);
      }
    }
    for (const name of bindingNames) {
      if (!requiredBindings.includes(name)) issues.push(`unexpected binding ${name}`);
    }
    if (isRecord(binding.expectedBindings)) {
      for (const [name, expected] of Object.entries(binding.expectedBindings)) {
        if (!requiredBindings.includes(name)) {
          issues.push(`gate config expected binding ${name} is not listed in requiredBindings`);
        } else if (attestation.bindings[name] !== expected) {
          issues.push(
            `binding ${name} does not match the release-derived expected value`
          );
        }
      }
    }
  }

  if (!Array.isArray(attestation.evidenceRefs) || attestation.evidenceRefs.length === 0) {
    issues.push("evidenceRefs must reference the underlying evidence");
  } else if (
    attestation.evidenceRefs.some((entry) => !isCanonicalBoundedString(entry)) ||
    hasDuplicates(attestation.evidenceRefs)
  ) {
    issues.push("evidenceRefs must be unique, trimmed, non-empty bounded strings");
  } else if (
    Array.isArray(binding.expectedEvidenceRefs) &&
    JSON.stringify(attestation.evidenceRefs) !==
      JSON.stringify(binding.expectedEvidenceRefs)
  ) {
    issues.push(
      "evidenceRefs must exactly bind the canonical underlying evidence receipt and digest"
    );
  }

  if (binding.minimumEvidenceHours !== undefined) {
    if (
      !Number.isSafeInteger(binding.minimumEvidenceHours) ||
      binding.minimumEvidenceHours < 1 ||
      binding.minimumEvidenceHours > 24 * 365
    ) {
      issues.push("gate config minimumEvidenceHours must be a positive bounded integer");
    }
    if (!isRecord(attestation.evidenceWindow)) {
      issues.push("evidenceWindow must record the bounded soak window");
    } else {
      if (
        !hasExactKeys(attestation.evidenceWindow, [
          "startedAt",
          "restartObservedAt",
          "endedAt"
        ])
      ) {
        issues.push(
          "evidenceWindow must contain exactly startedAt, restartObservedAt, and endedAt"
        );
      }
      const startedProblem = timestampProblem(
        "evidenceWindow.startedAt",
        attestation.evidenceWindow.startedAt,
        binding.now ?? Date.now()
      );
      if (startedProblem) issues.push(startedProblem);
      const endedProblem = timestampProblem(
        "evidenceWindow.endedAt",
        attestation.evidenceWindow.endedAt,
        binding.now ?? Date.now(),
        binding.maxAgeDays
      );
      if (endedProblem) issues.push(endedProblem);
      const restartProblem = timestampProblem(
        "evidenceWindow.restartObservedAt",
        attestation.evidenceWindow.restartObservedAt,
        binding.now ?? Date.now()
      );
      if (restartProblem) issues.push(restartProblem);
      const started = canonicalInstantMillis(attestation.evidenceWindow.startedAt);
      const restart = canonicalInstantMillis(
        attestation.evidenceWindow.restartObservedAt
      );
      const ended = canonicalInstantMillis(attestation.evidenceWindow.endedAt);
      if (started !== null && ended !== null) {
        if (ended <= started) issues.push("evidenceWindow.endedAt must follow startedAt");
        else if (ended - started < binding.minimumEvidenceHours * 3_600_000) {
          issues.push(`evidenceWindow is shorter than ${binding.minimumEvidenceHours} required hours`);
        }
        if (evidenceCapturedAt !== null && evidenceCapturedAt !== ended) {
          issues.push("evidenceCapturedAt must equal evidenceWindow.endedAt");
        }
      }
      if (
        started !== null &&
        restart !== null &&
        ended !== null &&
        (restart < started || restart > ended)
      ) {
        issues.push(
          "evidenceWindow.restartObservedAt must fall inside the soak window"
        );
      }
    }
  }
  return issues;
}

export function durableTargetDeviationApprovalProblems({
  approval,
  rootDir,
  candidateCommit,
  soakDeploymentCommit,
  ledgerSha256,
  evidenceWindow,
  minimumEvidenceHours,
  targetEvidenceHours
}) {
  const reasons = [];
  const startedAt = canonicalInstantMillis(evidenceWindow?.startedAt);
  const restartObservedAt = canonicalInstantMillis(
    evidenceWindow?.restartObservedAt
  );
  const endedAt = canonicalInstantMillis(evidenceWindow?.endedAt);
  const minimumMilliseconds =
    minimumEvidenceHours * 3_600_000;
  const targetMilliseconds =
    targetEvidenceHours * 3_600_000;
  const duration =
    startedAt === null || endedAt === null
      ? null
      : endedAt - startedAt;
  if (
    duration === null ||
    restartObservedAt === null ||
    duration < minimumMilliseconds
  ) {
    return [
      `durable soak remains ineligible below the ${minimumEvidenceHours}-hour hard minimum`
    ];
  }
  if (duration >= targetMilliseconds) {
    if (approval !== null) {
      reasons.push(
        `durable soak target deviation approval must be null when the ${targetEvidenceHours}-hour target is met`
      );
    }
    return reasons;
  }
  if (!isRecord(approval)) {
    return [
      `a ${minimumEvidenceHours}-to-${targetEvidenceHours}-hour durable soak requires an exact named-human target-deviation approval`
    ];
  }
  if (
    !hasExactKeys(approval, [
      "status",
      "approverType",
      "approvedBy",
      "approvedAt",
      "reason",
      "candidateCommit",
      "soakDeploymentCommit",
      "ledgerSha256",
      "evidenceWindow",
      "minimumEvidenceHours",
      "targetEvidenceHours"
    ])
  ) {
    reasons.push(
      "durable soak target deviation approval has the wrong exact field set"
    );
  }
  if (
    approval.status !== "approved" ||
    approval.approverType !== "named-human"
  ) {
    reasons.push(
      "durable soak target deviation must be explicitly approved by a named human"
    );
  }
  if (
    typeof approval.approvedBy !== "string" ||
    approval.approvedBy.length === 0 ||
    approval.approvedBy.length > 200 ||
    approval.approvedBy.trim() !== approval.approvedBy ||
    /^<required(?::|>)/i.test(approval.approvedBy) ||
    /^(?:unknown|unnamed|operator|automation|github-actions(?:\[bot\])?)$/i.test(
      approval.approvedBy
    )
  ) {
    reasons.push(
      "durable soak target deviation approvedBy must identify the named human approver"
    );
  }
  if (
    typeof approval.reason !== "string" ||
    approval.reason.length === 0 ||
    approval.reason.length > 2000 ||
    approval.reason.trim() !== approval.reason ||
    /^<required(?::|>)/i.test(approval.reason)
  ) {
    reasons.push(
      "durable soak target deviation must record the reviewed release rationale"
    );
  }
  const approvedAt = canonicalInstantMillis(approval.approvedAt);
  const candidateCommittedAt = gitRead(rootDir, [
    "show",
    "-s",
    "--format=%cI",
    candidateCommit
  ]);
  const candidateMillis = Date.parse(
    candidateCommittedAt?.toString("utf8").trim() ?? ""
  );
  if (
    approvedAt === null ||
    !Number.isFinite(candidateMillis) ||
    approvedAt < candidateMillis ||
    approvedAt < endedAt
  ) {
    reasons.push(
      "durable soak target deviation approval is stale because it predates the candidate or completed soak window"
    );
  }
  if (
    approval.candidateCommit !== candidateCommit ||
    approval.soakDeploymentCommit !== soakDeploymentCommit ||
    approval.ledgerSha256 !== ledgerSha256 ||
    approval.minimumEvidenceHours !== minimumEvidenceHours ||
    approval.targetEvidenceHours !== targetEvidenceHours ||
    !isRecord(approval.evidenceWindow) ||
    !hasExactKeys(approval.evidenceWindow, [
      "startedAt",
      "restartObservedAt",
      "endedAt"
    ]) ||
    approval.evidenceWindow.startedAt !== evidenceWindow.startedAt ||
    approval.evidenceWindow.restartObservedAt !==
      evidenceWindow.restartObservedAt ||
    approval.evidenceWindow.endedAt !== evidenceWindow.endedAt
  ) {
    reasons.push(
      "durable soak target deviation approval does not bind the exact candidate, deployment, ledger, window, and reviewed duration policy"
    );
  }
  return reasons;
}

function evaluateDurableSoak(
  id,
  gate,
  rootDir,
  now,
  measurementContext,
  options = {}
) {
  const expectedBindings = [
    "replayDeploymentCommit",
    "soakDeploymentCommit",
    "durableConfigDigest",
    "durableEnableReceiptDigest",
    "replayReceiptsDigest",
    "deploymentDigest",
    "ledgerSha256"
  ];
  const expectedDeviationPolicy = {
    requiredBelowTarget: true,
    forbiddenAtOrAboveTarget: true,
    status: "approved",
    approverType: "named-human",
    requiredBindings: [
      "candidateCommit",
      "soakDeploymentCommit",
      "ledgerSha256",
      "evidenceWindow",
      "minimumEvidenceHours",
      "targetEvidenceHours"
    ]
  };
  const expectedClaims = [
    {
      id: "lease-expiry-replay-passed",
      claim:
        "The lease-expiry replay canary passed against the bound pre-enable deployment."
    },
    {
      id: "lost-resolve-replay-passed",
      claim:
        "The lost-resolve replay canary passed against the bound pre-enable deployment."
    },
    {
      id: "durable-hourly-health-observed",
      claim:
        "Every authenticated hourly deep-health sample in the bound soak window observed durable jobs enabled and ready on the exact production deployment; no sample gap exceeded 90 minutes."
    },
    {
      id: "real-restart-observed",
      claim:
        "A real runtime restart occurred inside the soak window, and the queued job recovered on a second fenced attempt to one authenticated report identity and readback."
    },
    {
      id: "durable-behavior-exercises-observed",
      claim:
        "An authenticated production exercise run inside the soak window proved normal completion, cancellation, completed-report recovery, and duplicate prevention on the bound durable deployment."
    }
  ];
  const reasons = [...measurementCandidateProblems(measurementContext)];
  if (!Number.isSafeInteger(gate.maxAgeDays) || gate.maxAgeDays < 1) {
    reasons.push("gate config: maxAgeDays must be a positive integer");
  }
  if (
    !Number.isSafeInteger(gate.minimumEvidenceHours) ||
    gate.minimumEvidenceHours < 24 ||
    !Number.isSafeInteger(gate.targetEvidenceHours) ||
    gate.targetEvidenceHours < gate.minimumEvidenceHours
  ) {
    reasons.push(
      "gate config: durable soak must retain a minimum of at least 24 hours and a target no shorter than the minimum"
    );
  }
  if (
    JSON.stringify(gate.targetDeviationApprovalPolicy) !==
    JSON.stringify(expectedDeviationPolicy)
  ) {
    reasons.push(
      "gate config: durable target deviations must require an exact named-human approval bound to candidate, deployment, ledger, window, and duration policy"
    );
  }
  if (
    JSON.stringify(gate.requiredBindings) !==
    JSON.stringify(expectedBindings)
  ) {
    reasons.push(
      `gate config: durable bindings must be exactly ${expectedBindings.join(", ")}`
    );
  }
  if (
    JSON.stringify(gate.requiredClaims) !== JSON.stringify(expectedClaims)
  ) {
    reasons.push(
      "gate config: durable claims must exactly match the candidate-resident soak contract"
    );
  }
  if (
    gate.attestation !==
    "research/ops-receipts/durable-soak-attestation.json"
  ) {
    reasons.push(
      "gate config: durable soak must use the fixed candidate-resident attestation path"
    );
  }
  const durable = measurementContext.binding?.durablePrerequisite;
  if (!isRecord(durable)) {
    reasons.push(
      "the verified measurement candidate has no candidate-resident durable prerequisite"
    );
  } else {
    for (const [label, value, pattern] of [
      ["replay deployment commit", durable.replayDeploymentCommit, FULL_GIT_SHA],
      ["soak deployment commit", durable.toCommit, FULL_GIT_SHA],
      ["durable config digest", durable.configSha256, SHA256],
      [
        "durable enable receipt digest",
        durable.transitionReceiptSha256,
        SHA256
      ],
      ["replay receipt-set digest", durable.replayReceiptSetDigest, SHA256],
      ["production deployment digest", durable.deploymentDigest, SHA256]
    ]) {
      if (typeof value !== "string" || !pattern.test(value)) {
        reasons.push(`${label} is missing from the verified durable prerequisite`);
      }
    }
    if (durable.soakAttestationPath !== gate.attestation) {
      reasons.push(
        "the verified durable prerequisite does not bind the gate's exact soak attestation"
      );
    }
    const freshness = timestampProblem(
      "durable soak endedAt",
      durable.soakEndedAt,
      now,
      gate.maxAgeDays
    );
    if (freshness) reasons.push(freshness);
    const chronology = [
      durable.replayEvidenceStartedAt,
      durable.replayEvidenceCapturedAt,
      durable.stagingTeardownRecordedAt,
      durable.secretsCheckedAt,
      durable.transitionMergedAt,
      durable.ciCompletedAt,
      durable.promotionConvergedAt,
      durable.productionHealthObservedAt,
      durable.soakStartedAt,
      durable.soakRestartObservedAt,
      durable.soakEndedAt,
      durable.soakAttestedAt
    ].map(canonicalInstantMillis);
    if (
      chronology.some((value) => value === null) ||
      chronology.some(
        (value, index) =>
          index > 0 &&
          value < chronology[index - 1]
      )
    ) {
      reasons.push(
        "durable chronology must be replay, teardown, enable, CI, promotion, health, restart-bearing soak, then attestation"
      );
    }
    const soakStart = canonicalInstantMillis(durable.soakStartedAt);
    const soakEnd = canonicalInstantMillis(durable.soakEndedAt);
    if (
      soakStart === null ||
      soakEnd === null ||
      soakEnd - soakStart <
        gate.minimumEvidenceHours * 3_600_000
    ) {
      reasons.push(
        `candidate-resident durable soak is shorter than ${gate.minimumEvidenceHours} required hours`
      );
    }
    reasons.push(
      ...durableTargetDeviationApprovalProblems({
        approval: durable.targetDeviationApproval,
        rootDir,
        candidateCommit:
          measurementContext.binding.candidateCommit,
        soakDeploymentCommit: durable.toCommit,
        ledgerSha256: durable.soakLedgerSha256,
        evidenceWindow: {
          startedAt: durable.soakStartedAt,
          restartObservedAt: durable.soakRestartObservedAt,
          endedAt: durable.soakEndedAt
        },
        minimumEvidenceHours: gate.minimumEvidenceHours,
        targetEvidenceHours: gate.targetEvidenceHours
      })
    );
    const candidateCommittedAt = gitRead(rootDir, [
      "show",
      "-s",
      "--format=%cI",
      measurementContext.binding.candidateCommit
    ]);
    const candidateMillis = Date.parse(
      candidateCommittedAt?.toString("utf8").trim() ?? ""
    );
    const attestedMillis = canonicalInstantMillis(durable.soakAttestedAt);
    if (
      !Number.isFinite(candidateMillis) ||
      attestedMillis === null ||
      attestedMillis >
        candidateMillis + GIT_TIMESTAMP_PRECISION_SKEW_MS
    ) {
      reasons.push(
        "durable soak attestation must predate the commit that selected the measurement candidate"
      );
    }

    if (
      typeof durable.transitionReceiptPath !== "string" ||
      typeof durable.transitionReceiptSha256 !== "string"
    ) {
      reasons.push(
        "the verified durable prerequisite has no exact transition-receipt binding"
      );
    } else {
      let transitionReceipt = null;
      try {
        transitionReceipt = readJson(
          path.join(
            rootDir,
            ...durable.transitionReceiptPath.split("/")
          )
        );
      } catch {
        reasons.push(
          `${durable.transitionReceiptPath} is not valid JSON`
        );
      }
      if (transitionReceipt) {
        const transitionSubjectCommit =
          hostedSubjectFinalizationCommit(
            rootDir,
            measurementContext.binding.candidateCommit,
            durable.transitionReceiptPath,
            durable.transitionReceiptSha256
          );
        if (transitionSubjectCommit === null) {
          reasons.push(
            `${durable.transitionReceiptPath} has no unique final candidate-resident subject commit containing its exact bytes`
          );
        }
        const transitionHosted = verifyHostedEvidenceSubject({
          rootDir,
          measurementContext,
          profile: "durable-transition",
          subjectPath: durable.transitionReceiptPath,
          subjectSha256: durable.transitionReceiptSha256,
          subjectCommit: transitionSubjectCommit,
          trustedPreCandidateSourceCommit: durable.toCommit,
          expectedSources: [
            {
              role: "ci",
              workflowPath: ".github/workflows/ci.yml",
              runId: transitionReceipt.ci?.runId,
              runAttempt: transitionReceipt.ci?.runAttempt,
              headSha: transitionReceipt.ci?.headCommit,
              requiredJobNames: [
                "Attest exact-SHA evidence manifests"
              ]
            },
            {
              role: "promotion",
              workflowPath:
                ".github/workflows/promote-production.yml",
              runId: transitionReceipt.promotion?.runId,
              runAttempt:
                transitionReceipt.promotion?.runAttempt,
              headSha:
                transitionReceipt.promotion?.productionCommit,
              requiredJobNames: [
                "Advance production to the tested SHA"
              ]
            },
            {
              role: "production-health",
              workflowPath:
                ".github/workflows/production-health.yml",
              runId:
                transitionReceipt.productionHealth?.runId,
              runAttempt:
                transitionReceipt.productionHealth?.runAttempt,
              headSha:
                transitionReceipt.productionHealth?.headCommit,
              requiredJobNames: [
                "Verify scanner health and posture"
              ]
            }
          ],
          attestationVerifier:
            options.hostedEvidenceAttestationVerifier
        });
        if (!transitionHosted.ok) {
          reasons.push(...transitionHosted.reasons);
        }
      }
    }

    if (
      typeof durable.soakAttestationPath !== "string" ||
      typeof durable.soakAttestationSha256 !== "string"
    ) {
      reasons.push(
        "the verified durable prerequisite has no exact soak-attestation binding"
      );
    } else {
      const soakSubjectCommit = hostedSubjectFinalizationCommit(
        rootDir,
        measurementContext.binding.candidateCommit,
        durable.soakAttestationPath,
        durable.soakAttestationSha256
      );
      if (soakSubjectCommit === null) {
        reasons.push(
          `${durable.soakAttestationPath} has no unique final candidate-resident subject commit containing its exact bytes`
        );
      }
      const soakHosted = verifyHostedEvidenceSubject({
        rootDir,
        measurementContext,
        profile: "durable-soak",
        subjectPath: durable.soakAttestationPath,
        subjectSha256: durable.soakAttestationSha256,
        subjectCommit: soakSubjectCommit,
        trustedPreCandidateSourceCommit: durable.toCommit,
        attestationVerifier:
          options.hostedEvidenceAttestationVerifier
      });
      if (!soakHosted.ok) {
        reasons.push(...soakHosted.reasons);
      } else {
        const aggregateDeployment =
          soakHosted.verification?.subject?.bindings
            ?.soakDeploymentCommit;
        if (aggregateDeployment !== durable.toCommit) {
          reasons.push(
            "authenticated durable-soak ledger does not bind the exact declared durable deployment"
          );
        }
        reasons.push(
          ...durableSoakNestedWorkflowTrustProblems(
            rootDir,
            measurementContext.binding.candidateCommit,
            durable.toCommit
          )
        );
      }
    }
  }
  return gateResult(
    id,
    gate,
    reasons.length === 0 ? "pass" : "fail",
    reasons.length === 0
      ? [
          `candidate ${measurementContext.binding.candidateCommit} contains the replay, teardown, exact enable transition, all five durable behaviors, and ${gate.minimumEvidenceHours}-hour production soak prerequisite`
        ]
      : [...new Set(reasons)]
  );
}

function evaluateContainerPackageReview(
  id,
  gate,
  rootDir,
  now,
  measurementContext
) {
  const reasons = [...measurementCandidateProblems(measurementContext)];
  for (const [field, expected] of [
    ["inventory", CONTAINER_PACKAGE_INVENTORY_PATH],
    ["bundle", CONTAINER_PACKAGE_INVENTORY_BUNDLE_PATH],
    ["ledger", CONTAINER_PACKAGE_REVIEW_LEDGER_PATH]
  ]) {
    if (gate[field] !== expected) {
      reasons.push(`gate config: ${field} must be ${expected}`);
    }
  }
  const bindingModule = measurementContext.module;
  if (
    bindingModule?.MEASUREMENT_CANDIDATE_PACKAGE_INVENTORY_PATH !==
      CONTAINER_PACKAGE_INVENTORY_PATH ||
    bindingModule?.MEASUREMENT_CANDIDATE_PACKAGE_ATTESTATION_BUNDLE_PATH !==
      CONTAINER_PACKAGE_INVENTORY_BUNDLE_PATH
  ) {
    reasons.push("compiled candidate verifier does not own the exact package inventory and bundle paths");
  }
  if (
    measurementContext.binding?.attestationVerifications?.containerPackageInventory
      ?.status !== "verified-by-gh-attestation"
  ) {
    reasons.push("the container package inventory Sigstore bundle was not verified");
  }

  let inventory = null;
  let ledger = null;
  for (const [label, relative] of [
    ["inventory", CONTAINER_PACKAGE_INVENTORY_PATH],
    ["ledger", CONTAINER_PACKAGE_REVIEW_LEDGER_PATH]
  ]) {
    const absolute = path.join(rootDir, ...relative.split("/"));
    if (!existsSync(absolute)) {
      reasons.push(`${relative} does not exist`);
      continue;
    }
    try {
      if (label === "inventory") inventory = readJson(absolute);
      else ledger = readJson(absolute);
    } catch {
      reasons.push(`${relative} is not valid JSON`);
    }
  }

  let review = null;
  if (inventory && ledger) {
    review = validateContainerPackageReviewReadiness(inventory, ledger, { now });
    if (!review.ok) reasons.push(...review.problems);
    if (
      review.bindings?.candidateCommit !==
      measurementContext.binding?.candidateCommit
    ) {
      reasons.push("container package inventory is not bound to the verified measurement candidate");
    }
  }

  return gateResult(
    id,
    gate,
    reasons.length === 0 ? "pass" : "fail",
    reasons.length === 0
      ? [
          `${review.summary.reviewed}/${review.summary.total} exact-candidate OS packages are reviewed and attested`
        ]
      : [...new Set(reasons)]
  );
}

const OPERATOR_EVIDENCE_CONTRACTS = Object.freeze({
  "egress-backstop": Object.freeze({
    path: EGRESS_BACKSTOP_EVIDENCE_PATH,
    validate: validateEgressBackstopEvidence
  }),
  "waf-ceilings": Object.freeze({
    path: WAF_CEILING_EVIDENCE_PATH,
    validate: validateWafCeilingEvidence
  }),
  "log-retention": Object.freeze({
    path: LOG_RETENTION_EVIDENCE_PATH,
    validate: validateLogRetentionEvidence
  }),
  "container-image-licensing": Object.freeze({
    path: CONTAINER_LICENSING_EVIDENCE_PATH,
    validate: validateContainerImageLicensingEvidence
  })
});

function containerOperatorEvidenceDependencies(rootDir, now) {
  const inventoryBytes = readFileSync(
    path.join(rootDir, ...OPERATOR_CONTAINER_INVENTORY_PATH.split("/")),
    "utf8"
  );
  const ledgerBytes = readFileSync(
    path.join(rootDir, ...OPERATOR_CONTAINER_REVIEW_LEDGER_PATH.split("/")),
    "utf8"
  );
  return {
    inventory: JSON.parse(inventoryBytes),
    ledger: JSON.parse(ledgerBytes),
    inventoryBytes,
    ledgerBytes,
    now,
    // Never let a caller evaluating a different checkout resolve repo:
    // evidence references against this process's working directory.
    repositoryRoot: rootDir
  };
}

function acquireCanonicalOperatorEvidence(id, gate, rootDir, now) {
  const contract = OPERATOR_EVIDENCE_CONTRACTS[id];
  if (!contract) {
    return {
      evidence: null,
      bindings: null,
      digest: null,
      path: null,
      problems: [`gate ${id} has no canonical operator-evidence contract`]
    };
  }
  const problems = [];
  if (gate.evidence !== contract.path) {
    problems.push(
      `gate config: evidence must be the fixed ${contract.path}`
    );
  }
  const absolute = path.join(rootDir, ...contract.path.split("/"));
  if (!existsSync(absolute)) {
    return {
      evidence: null,
      bindings: null,
      digest: null,
      path: contract.path,
      problems: [...problems, `${contract.path} does not exist`]
    };
  }
  let bytes;
  let evidence;
  try {
    bytes = readFileSync(absolute, "utf8");
    evidence = parseCanonicalEvidence(bytes, contract.path);
  } catch (error) {
    return {
      evidence: null,
      bindings: null,
      digest: null,
      path: contract.path,
      problems: [
        ...problems,
        `${contract.path} failed canonical parsing: ${String(error).slice(0, 240)}`
      ]
    };
  }
  let verdict;
  try {
    verdict =
      id === "container-image-licensing"
        ? contract.validate(
            evidence,
            containerOperatorEvidenceDependencies(rootDir, now)
          )
        : contract.validate(evidence);
  } catch (error) {
    return {
      evidence,
      bindings: null,
      digest: null,
      path: contract.path,
      problems: [
        ...problems,
        `${contract.path} verification threw: ${String(error).slice(0, 240)}`
      ]
    };
  }
  if (!verdict.ok || !isRecord(verdict.bindings)) {
    problems.push(
      ...verdict.problems.map(
        (problem) => `${contract.path}: ${problem}`
      )
    );
  }
  const attestationBindings = isRecord(verdict.bindings)
    ? Object.fromEntries(
        Object.entries(verdict.bindings)
          // This list is a verifier-side set-equality aid. Operator
          // attestations intentionally bind its canonical digest, not an
          // extensible array in the otherwise scalar bindings object.
          .filter(([name]) => name !== "repositoryLegalEvidencePaths")
          .map(([name, value]) => [
            name,
            name.endsWith("Digest") &&
            typeof value === "string" &&
            /^sha256:[0-9a-f]{64}$/.test(value)
              ? value.slice("sha256:".length)
              : value
          ])
      )
    : null;
  const digest = sha256OfBytes(bytes);
  if (
    verdict.receiptDigest !== null &&
    verdict.receiptDigest !== digest
  ) {
    problems.push(
      `${contract.path} validator digest does not match its exact canonical bytes`
    );
  }
  const providerObservedAt =
    id === "egress-backstop" ||
    id === "waf-ceilings" ||
    id === "log-retention"
      ? verdict.bindings?.effectiveSourceObservedAt
      : evidence.capturedAt;
  if (
    (id === "egress-backstop" ||
      id === "waf-ceilings" ||
      id === "log-retention") &&
    (typeof providerObservedAt !== "string" ||
      evidence.capturedAt !== providerObservedAt)
  ) {
    problems.push(
      `${contract.path} must bind capturedAt to its authenticated effective source observation time`
    );
  }
  const freshness = timestampProblem(
    `${contract.path} effective source observedAt`,
    providerObservedAt,
    now,
    gate.maxAgeDays
  );
  if (freshness) problems.push(freshness);
  return {
    evidence,
    bindings: problems.length === 0 ? attestationBindings : null,
    digest: problems.length === 0 ? digest : null,
    path: contract.path,
    problems
  };
}

function egressCollectionBindingProblems(evidence, runnerContext) {
  const problems = [];
  const expected = evidence?.networkPolicy?.collectionEgress;
  const receipts = runnerContext?.receipts;
  if (!isRecord(expected)) {
    return [
      "canonical egress evidence does not expose the controlled collection egress tuple"
    ];
  }
  if (
    !Array.isArray(receipts) ||
    receipts.length !== 2 ||
    !runnerContext?.verification?.ok
  ) {
    return [
      "exactly two verified controlled-runner receipts are required to bind collection egress"
    ];
  }
  for (const [index, receipt] of receipts.entries()) {
    if (
      expected.labelRef !== receipt.runnerLabelRef ||
      expected.region !== receipt.egress?.declaredRegion ||
      expected.natIdentityRef !== receipt.egress?.natIdentityRef
    ) {
      problems.push(
        `canonical egress evidence does not match controlled-runner receipt ${index + 1}'s label, region, and NAT identity`
      );
    }
  }
  return problems;
}

const PRIVATE_PROVIDER_HOSTED_CAPTURE_GATES = new Set([
  "egress-backstop",
  "log-retention"
]);

export function trustedProviderCapturePreflightIssue(gateId) {
  return PRIVATE_PROVIDER_HOSTED_CAPTURE_GATES.has(gateId)
    ? `trusted GitHub-hosted ${gateId} provider capture is unavailable; caller-supplied source digests and a hand attestation cannot satisfy this gate`
    : null;
}

export function hostedWafCaptureBindingProblems(
  source,
  receiptBindings,
  receiptSha256
) {
  const receiptMembers =
    source?.artifact?.members?.filter(
      (member) =>
        member.path === "receipt.json" &&
        member.sha256 === receiptSha256
    ) ?? [];
  const problems = [];
  if (receiptMembers.length !== 1) {
    problems.push(
      "hosted WAF capture artifact must carry the exact canonical WAF receipt"
    );
  }
  if (
    source?.headSha !== receiptBindings?.candidateCommit ||
    source?.headSha !== receiptBindings?.deploymentCommit
  ) {
    problems.push(
      "hosted WAF capture source must equal the receipt's exact candidate and deployment commits"
    );
  }
  return problems;
}

function hostedWafCaptureProblems({
  id,
  canonical,
  rootDir,
  measurementContext,
  attestationVerifier
}) {
  if (id !== "waf-ceilings") return [];
  if (
    canonical.problems.length > 0 ||
    !isRecord(canonical.bindings) ||
    typeof canonical.digest !== "string" ||
    !measurementContext?.binding
  ) {
    return [
      "trusted GitHub-hosted WAF capture cannot be verified until the canonical receipt and measurement candidate validate"
    ];
  }
  const subjectCommit = hostedSubjectFinalizationCommit(
    rootDir,
    measurementContext.binding.carrierCommit,
    canonical.path,
    canonical.digest
  );
  if (subjectCommit === null) {
    return [
      `${canonical.path} has no final evidence-carrier commit containing its exact hosted-capture bytes`
    ];
  }
  const hosted = verifyHostedEvidenceSubject({
    rootDir,
    measurementContext,
    profile: "waf-ceilings",
    subjectPath: canonical.path,
    subjectSha256: canonical.digest,
    subjectCommit,
    ...(attestationVerifier ? { attestationVerifier } : {})
  });
  if (!hosted.ok) return hosted.reasons;
  const source = hosted.verification.sources.find(
    (entry) => entry.role === "provider-capture"
  );
  return hostedWafCaptureBindingProblems(
    source,
    canonical.bindings,
    canonical.digest
  );
}

function evaluateAttestation(
  id,
  gate,
  manifest,
  rootDir,
  now,
  measurementContext,
  runnerContext,
  options = {}
) {
  if (!Number.isSafeInteger(gate.maxAgeDays) || gate.maxAgeDays < 1) {
    return gateResult(id, gate, "fail", ["gate config: maxAgeDays must be a positive integer"]);
  }
  const canonical = acquireCanonicalOperatorEvidence(id, gate, rootDir, now);
  const preflightIssues = [
    ...canonical.problems,
    ...boundExactEvidenceProblems(
      measurementContext,
      rootDir,
      "operator-evidence",
      canonical.path
    ),
    ...boundExactEvidenceProblems(
      measurementContext,
      rootDir,
      "operator-attestation",
      gate.attestation
    ),
    ...measurementCandidateProblems(measurementContext)
  ];
  const providerCaptureIssue =
    trustedProviderCapturePreflightIssue(id);
  if (providerCaptureIssue) preflightIssues.push(providerCaptureIssue);
  preflightIssues.push(
    ...hostedWafCaptureProblems({
      id,
      canonical,
      rootDir,
      measurementContext,
      attestationVerifier: options.hostedEvidenceAttestationVerifier
    })
  );
  const attestationPath = path.join(rootDir, gate.attestation);
  if (!existsSync(attestationPath)) {
    return gateResult(
      id,
      gate,
      "fail",
      [...new Set([...preflightIssues, `${gate.attestation} does not exist`])]
    );
  }
  let attestation;
  try {
    attestation = readJson(attestationPath);
  } catch {
    return gateResult(
      id,
      gate,
      "fail",
      [...new Set([...preflightIssues, `${gate.attestation} is not valid JSON`])]
    );
  }
  const expectedBindings = isRecord(canonical.bindings)
    ? { ...canonical.bindings }
    : {};
  const deploymentCommit = canonical.bindings?.deploymentCommit;
  if (
    canonical.bindings?.candidateCommit !==
    measurementContext.binding?.candidateCommit
  ) {
    preflightIssues.push(
      "canonical operator evidence is not bound to the verified measurement candidate"
    );
  }
  if (
    !measurementCandidateAcceptsProducer(
      measurementContext,
      deploymentCommit
    )
  ) {
    preflightIssues.push(
      "canonical operator evidence deploymentCommit is not an accepted measurement carrier"
    );
  } else {
    preflightIssues.push(
      ...producerEvidenceProblems(
        rootDir,
        measurementContext,
        canonical.path,
        deploymentCommit,
        canonical.evidence?.capturedAt
      ),
      ...producerEvidenceProblems(
        rootDir,
        measurementContext,
        gate.attestation,
        deploymentCommit,
        attestation.evidenceCapturedAt
      ),
      ...producerEvidenceProblems(
        rootDir,
        measurementContext,
        gate.attestation,
        deploymentCommit,
        attestation.attestedAt
      )
    );
  }
  if (
    canonical.evidence?.capturedAt !==
    attestation.evidenceCapturedAt
  ) {
    preflightIssues.push(
      "attestation evidenceCapturedAt must equal the canonical underlying evidence capturedAt"
    );
  }
  if (id === "egress-backstop") {
    preflightIssues.push(
      ...egressCollectionBindingProblems(canonical.evidence, runnerContext)
    );
    if (!gate.requiredBindings?.includes("collectionEnvironmentDigest")) {
      preflightIssues.push(
        "gate config: egress-backstop must require collectionEnvironmentDigest"
      );
    } else if (!runnerContext?.verification?.environmentDigest) {
      preflightIssues.push(
        "the verified controlled-runner environment digest is unavailable"
      );
    } else {
      expectedBindings.collectionEnvironmentDigest =
        runnerContext.verification.environmentDigest;
    }
    if (!gate.requiredBindings?.includes("collectionProducerCommitsDigest")) {
      preflightIssues.push(
        "gate config: egress-backstop must require collectionProducerCommitsDigest"
      );
    } else if (!Array.isArray(runnerContext?.verification?.sourceCommits)) {
      preflightIssues.push(
        "the verified controlled-runner producer commit set is unavailable"
      );
    } else {
      expectedBindings.collectionProducerCommitsDigest = sha256OfBytes(
        JSON.stringify([...runnerContext.verification.sourceCommits].sort())
      );
    }
  }
  const issues = [
    ...preflightIssues,
    ...operatorAttestationIssues(attestation, id, {
    targetRelease: manifest.targetRelease,
    maxAgeDays: gate.maxAgeDays,
    now,
    requiredClaims: gate.requiredClaims,
    requiredBindings: gate.requiredBindings,
    minimumEvidenceHours: gate.minimumEvidenceHours,
    expectedBindings,
    expectedEvidenceRefs:
      canonical.path && canonical.digest
        ? [`${canonical.path}#sha256:${canonical.digest}`]
        : []
    })
  ];
  return gateResult(
    id,
    gate,
    issues.length === 0 ? "pass" : "fail",
    [...new Set(issues)]
  );
}

const ATTESTATION_SCAFFOLD_GATES = Object.freeze([
  "durable-soak",
  "egress-backstop",
  "waf-ceilings",
  "log-retention",
  "container-image-licensing"
]);

function requiredScaffoldValue(description) {
  return `<required: ${description}>`;
}

/**
 * Pure scaffold builder. It emits the validator's exact key/statement set,
 * preserves every release-derived binding supplied by the resolver, and uses
 * conspicuous non-passing placeholders for facts only an operator can capture.
 * Claim booleans start false: generating a file must never attest the claim.
 */
export function buildReleaseAttestationScaffold(
  manifest,
  gateId,
  derivedBindings = {},
  derivedEvidence = {}
) {
  if (!ATTESTATION_SCAFFOLD_GATES.includes(gateId)) {
    throw new Error(
      `Unsupported attestation gate ${gateId}; expected one of ${ATTESTATION_SCAFFOLD_GATES.join(", ")}`
    );
  }
  const gate = manifest?.gates?.[gateId];
  if (
    !isRecord(gate) ||
    !isNonEmptyStringArray(gate.requiredBindings) ||
    !Array.isArray(gate.requiredClaims) ||
    gate.requiredClaims.length === 0
  ) {
    throw new Error(`${gateId} does not declare a complete attestation contract`);
  }
  const bindings = Object.fromEntries(
    gate.requiredBindings.map((name) => [
      name,
      Object.hasOwn(derivedBindings, name)
        ? derivedBindings[name]
        : requiredScaffoldValue(`${name} from the evidence named in evidenceRefs`)
    ])
  );
  return {
    kind: OPERATOR_ATTESTATION_KIND,
    gateId,
    targetRelease: manifest.targetRelease,
    attestedBy: requiredScaffoldValue("named human operator"),
    attestedAt: requiredScaffoldValue("canonical UTC instant after review"),
    evidenceCapturedAt:
      derivedEvidence.evidenceCapturedAt ??
      requiredScaffoldValue(
        "canonical UTC instant when the newest evidence was captured"
      ),
    bindings,
    statements: gate.requiredClaims.map(({ id, claim }) => ({
      claimId: id,
      claim,
      true: false
    })),
    evidenceRefs:
      derivedEvidence.evidenceRefs ??
      [
        requiredScaffoldValue(
          "one or more immutable run, receipt, query, or policy evidence references"
        )
      ],
    ...(Number.isSafeInteger(gate.minimumEvidenceHours)
      ? {
          evidenceWindow: {
            startedAt: requiredScaffoldValue(
              "canonical UTC soak start"
            ),
            restartObservedAt: requiredScaffoldValue(
              "canonical UTC instant of the real restart inside the soak"
            ),
            endedAt: requiredScaffoldValue(
              "canonical UTC soak end equal to evidenceCapturedAt"
            )
          }
        }
      : {})
  };
}

export function buildDurableTargetDeviationApprovalScaffold({
  candidateCommit,
  soakDeploymentCommit,
  ledgerSha256,
  evidenceWindow,
  minimumEvidenceHours,
  targetEvidenceHours
}) {
  if (
    !FULL_GIT_SHA.test(candidateCommit ?? "") ||
    !FULL_GIT_SHA.test(soakDeploymentCommit ?? "") ||
    !SHA256.test(ledgerSha256 ?? "") ||
    !isRecord(evidenceWindow) ||
    canonicalInstantMillis(evidenceWindow.startedAt) === null ||
    canonicalInstantMillis(evidenceWindow.restartObservedAt) === null ||
    canonicalInstantMillis(evidenceWindow.endedAt) === null ||
    !Number.isSafeInteger(minimumEvidenceHours) ||
    !Number.isSafeInteger(targetEvidenceHours)
  ) {
    throw new Error(
      "durable target-deviation scaffold requires exact candidate, deployment, ledger, window, and duration-policy bindings"
    );
  }
  const duration =
    canonicalInstantMillis(evidenceWindow.endedAt) -
    canonicalInstantMillis(evidenceWindow.startedAt);
  if (
    duration < minimumEvidenceHours * 3_600_000 ||
    duration >= targetEvidenceHours * 3_600_000
  ) {
    throw new Error(
      `durable target-deviation scaffold applies only from ${minimumEvidenceHours} hours through less than the ${targetEvidenceHours}-hour target`
    );
  }
  return {
    status: requiredScaffoldValue(
      "approved only after the named human reviews this exact candidate-bound deviation"
    ),
    approverType: "named-human",
    approvedBy: requiredScaffoldValue("named human approver"),
    approvedAt: requiredScaffoldValue(
      "canonical UTC instant after candidate and window review"
    ),
    reason: requiredScaffoldValue(
      "reviewed rationale for releasing below the soak target"
    ),
    candidateCommit,
    soakDeploymentCommit,
    ledgerSha256,
    evidenceWindow: {
      startedAt: evidenceWindow.startedAt,
      restartObservedAt: evidenceWindow.restartObservedAt,
      endedAt: evidenceWindow.endedAt
    },
    minimumEvidenceHours,
    targetEvidenceHours
  };
}

export function preCandidateDurableAttestationBindings(rootDir) {
  const transitionAbsolute = path.join(
    rootDir,
    ...DURABLE_ENABLE_TRANSITION_RECEIPT_PATH.split("/")
  );
  if (!existsSync(transitionAbsolute)) {
    throw new Error(
      `${DURABLE_ENABLE_TRANSITION_RECEIPT_PATH} does not exist`
    );
  }
  const receipt = readJson(transitionAbsolute);
  if (
    receipt?.schemaVersion !== 1 ||
    receipt?.artifactKind !==
      "site-behavior-durable-enable-transition"
  ) {
    throw new Error("the durable-enable transition receipt has the wrong identity");
  }
  const replayDeploymentCommit = receipt.replay?.deploymentCommit;
  const soakDeploymentCommit = receipt.transition?.toCommit;
  const fromCommit = receipt.transition?.fromCommit;
  const replayReceiptsDigest = receipt.replay?.receiptSetDigest;
  const deploymentDigest = receipt.promotion?.deploymentDigest;
  for (const [label, value, pattern] of [
    ["replay deployment commit", replayDeploymentCommit, FULL_GIT_SHA],
    ["soak deployment commit", soakDeploymentCommit, FULL_GIT_SHA],
    ["transition from commit", fromCommit, FULL_GIT_SHA],
    ["replay receipt-set digest", replayReceiptsDigest, SHA256],
    ["deployment digest", deploymentDigest, SHA256]
  ]) {
    if (typeof value !== "string" || !pattern.test(value)) {
      throw new Error(`${label} is missing or malformed`);
    }
  }
  if (
    receipt.transition?.configPath !== DURABLE_PRODUCTION_CONFIG_PATH ||
    fromCommit !== replayDeploymentCommit ||
    receipt.promotion?.productionCommit !== soakDeploymentCommit ||
    receipt.ci?.headCommit !== soakDeploymentCommit ||
    receipt.productionHealth?.headCommit !== soakDeploymentCommit
  ) {
    throw new Error(
      "the durable transition does not bind one replay commit and one converged soak commit"
    );
  }
  const replayReceipts = ["lease-expiry", "lost-resolve"].map((mode) => {
    const relative =
      `research/ops-receipts/durable-replay/${replayDeploymentCommit}-${mode}.json`;
    if (!existsSync(path.join(rootDir, ...relative.split("/")))) {
      throw new Error(`${relative} does not exist`);
    }
    return readJson(path.join(rootDir, ...relative.split("/")));
  });
  const replayVerification = verifyDurableReplayReceiptSet(
    replayReceipts,
    replayDeploymentCommit
  );
  if (
    !replayVerification.ok ||
    replayVerification.receiptSetDigest !== replayReceiptsDigest
  ) {
    throw new Error(
      `the transition's replay binding is not the canonical receipt set: ${
        replayVerification.issues.join("; ") || "digest mismatch"
      }`
    );
  }
  const configAbsolute = path.join(rootDir, DURABLE_PRODUCTION_CONFIG_PATH);
  const configText = readFileSync(configAbsolute, "utf8");
  if (
    configText.split('"SITE_BEHAVIOR_LAB_DURABLE_JOBS": "1"').length !== 2 ||
    configText.includes('"SITE_BEHAVIOR_LAB_DURABLE_JOBS": "0"')
  ) {
    throw new Error(
      `${DURABLE_PRODUCTION_CONFIG_PATH} does not contain the exact durable=1 candidate configuration`
    );
  }
  const before = gitRead(rootDir, [
    "show",
    `${fromCommit}:${DURABLE_PRODUCTION_CONFIG_PATH}`
  ]);
  const after = gitRead(rootDir, [
    "show",
    `${soakDeploymentCommit}:${DURABLE_PRODUCTION_CONFIG_PATH}`
  ]);
  const disabledMarker = '"SITE_BEHAVIOR_LAB_DURABLE_JOBS": "0"';
  const enabledMarker = '"SITE_BEHAVIOR_LAB_DURABLE_JOBS": "1"';
  if (
    before === null ||
    after === null ||
    before.toString("utf8").split(disabledMarker).length !== 2 ||
    after.toString("utf8") !==
      before.toString("utf8").replace(disabledMarker, enabledMarker) ||
    after.toString("utf8") !== configText
  ) {
    throw new Error(
      "the recorded durable transition is not the exact production 0-to-1 config change"
    );
  }
  return {
    replayDeploymentCommit,
    soakDeploymentCommit,
    durableConfigDigest: sha256OfBytes(configText),
    durableEnableReceiptDigest: sha256OfFile(transitionAbsolute),
    replayReceiptsDigest,
    deploymentDigest
  };
}

export function releaseDurableTargetDeviationApprovalScaffold(
  candidateCommit,
  rootDir = process.cwd(),
  now = Date.now()
) {
  const manifest = readJson(path.join(rootDir, READINESS_MANIFEST));
  const gate = manifest?.gates?.["durable-soak"];
  if (!isRecord(gate)) {
    throw new Error("durable-soak gate is missing");
  }
  if (!FULL_GIT_SHA.test(candidateCommit ?? "")) {
    throw new Error("--candidate-commit must be a full 40-character Git SHA");
  }
  const resolvedCandidate = gitRead(rootDir, [
    "rev-parse",
    "--verify",
    `${candidateCommit}^{commit}`
  ])
    ?.toString("utf8")
    .trim()
    .toLowerCase();
  if (resolvedCandidate !== candidateCommit) {
    throw new Error("--candidate-commit does not resolve to that exact commit");
  }
  const attestation = readJson(
    path.join(rootDir, ...gate.attestation.split("/"))
  );
  const issues = operatorAttestationIssues(
    attestation,
    "durable-soak",
    {
      targetRelease: manifest.targetRelease,
      maxAgeDays: gate.maxAgeDays,
      now,
      requiredClaims: gate.requiredClaims,
      requiredBindings: gate.requiredBindings,
      minimumEvidenceHours: gate.minimumEvidenceHours
    }
  );
  if (issues.length > 0) {
    throw new Error(
      `the durable soak attestation is not eligible: ${issues.join("; ")}`
    );
  }
  const transitionBindings =
    preCandidateDurableAttestationBindings(rootDir);
  if (
    gitRead(rootDir, [
      "merge-base",
      "--is-ancestor",
      transitionBindings.soakDeploymentCommit,
      candidateCommit
    ]) === null
  ) {
    throw new Error(
      "the declared soak deployment is not an ancestor of the candidate"
    );
  }
  return buildDurableTargetDeviationApprovalScaffold({
    candidateCommit,
    soakDeploymentCommit:
      transitionBindings.soakDeploymentCommit,
    ledgerSha256: attestation.bindings.ledgerSha256,
    evidenceWindow: attestation.evidenceWindow,
    minimumEvidenceHours: gate.minimumEvidenceHours,
    targetEvidenceHours: gate.targetEvidenceHours
  });
}

/**
 * Resolve every value that repository evidence can determine before printing
 * an operator scaffold. Post-candidate gates derive all subject digests from
 * their canonical producer receipt; no operator transcribes a digest.
 */
export function releaseAttestationScaffold(
  gateId,
  rootDir = process.cwd(),
  now = Date.now()
) {
  const manifest = readJson(path.join(rootDir, READINESS_MANIFEST));
  const gate = manifest?.gates?.[gateId];
  if (!ATTESTATION_SCAFFOLD_GATES.includes(gateId) || !isRecord(gate)) {
    throw new Error(
      `--gate must name one of ${ATTESTATION_SCAFFOLD_GATES.join(", ")}`
    );
  }
  if (gateId === "durable-soak") {
    return buildReleaseAttestationScaffold(
      manifest,
      gateId,
      preCandidateDurableAttestationBindings(rootDir)
    );
  }
  const measurementContext = acquireMeasurementCandidate(manifest, rootDir);
  const candidateProblems = measurementCandidateProblems(measurementContext);
  if (candidateProblems.length > 0) {
    throw new Error(
      `verified measurement candidate is required: ${candidateProblems.join("; ")}`
    );
  }
  const canonical = acquireCanonicalOperatorEvidence(
    gateId,
    gate,
    rootDir,
    now
  );
  if (canonical.problems.length > 0 || !canonical.bindings) {
    throw new Error(
      `canonical operator evidence is required: ${canonical.problems.join("; ")}`
    );
  }
  const derivedBindings = { ...canonical.bindings };
  if (
    derivedBindings.candidateCommit !==
    measurementContext.binding.candidateCommit
  ) {
    throw new Error(
      "canonical operator evidence is not bound to the verified measurement candidate"
    );
  }
  if (
    !measurementCandidateAcceptsProducer(
      measurementContext,
      derivedBindings.deploymentCommit
    )
  ) {
    throw new Error(
      "canonical operator evidence deploymentCommit is not an accepted measurement carrier"
    );
  }

  if (gateId === "egress-backstop") {
    const freezeGateEntry = Object.entries(manifest.gates ?? {}).find(
      ([, value]) => value?.kind === "measurement-freeze"
    );
    const runnerGateEntry = Object.entries(manifest.gates ?? {}).find(
      ([, value]) => value?.kind === "runner-receipts"
    );
    if (!freezeGateEntry || !runnerGateEntry) {
      throw new Error("egress scaffold requires the freeze and runner gates");
    }
    const freezeContext = acquireMeasurementFreeze(
      freezeGateEntry[0],
      freezeGateEntry[1],
      rootDir,
      now,
      measurementContext
    );
    const runnerContext = acquireRunnerReceipts(
      runnerGateEntry[0],
      runnerGateEntry[1],
      rootDir,
      now,
      measurementContext,
      freezeContext
    );
    if (!runnerContext.verification) {
      throw new Error(
        `verified controlled-runner evidence is required: ${runnerContext.result.reasons.join("; ")}`
      );
    }
    const collectionProblems = egressCollectionBindingProblems(
      canonical.evidence,
      runnerContext
    );
    if (collectionProblems.length > 0) {
      throw new Error(collectionProblems.join("; "));
    }
    derivedBindings.collectionEnvironmentDigest =
      runnerContext.verification.environmentDigest;
    derivedBindings.collectionProducerCommitsDigest = sha256OfBytes(
      JSON.stringify([...runnerContext.verification.sourceCommits].sort())
    );
  }
  return buildReleaseAttestationScaffold(
    manifest,
    gateId,
    derivedBindings,
    {
      evidenceCapturedAt: canonical.evidence.capturedAt,
      evidenceRefs: [
        `${canonical.path}#sha256:${canonical.digest}`
      ]
    }
  );
}

/** Evaluate the committed manifest against the repository's current evidence. */
export function evaluateReleaseReadiness(
  rootDir = process.cwd(),
  now = Date.now(),
  options = {}
) {
  const manifestPath = path.join(rootDir, READINESS_MANIFEST);
  if (!existsSync(manifestPath)) {
    return { ready: false, manifestProblems: [`${READINESS_MANIFEST} does not exist`], gates: [] };
  }
  let manifest;
  try {
    manifest = readJson(manifestPath);
  } catch {
    return { ready: false, manifestProblems: [`${READINESS_MANIFEST} is not valid JSON`], gates: [] };
  }
  const manifestProblems = [];
  if (manifest.artifactKind !== "site-behavior-release-readiness-manifest") {
    manifestProblems.push("wrong artifactKind");
  }
  if (typeof manifest.targetRelease !== "string" || manifest.targetRelease.length === 0) {
    manifestProblems.push("targetRelease must name the release this manifest gates");
  }
  if (manifestProblems.length > 0) return { ready: false, manifestProblems, gates: [] };

  const measurementContext = acquireMeasurementCandidate(
    manifest,
    rootDir,
    options
  );
  const freezeGateEntry = Object.entries(manifest.gates ?? {}).find(
    ([, gate]) => gate?.kind === "measurement-freeze"
  );
  const freezeContext = freezeGateEntry
    ? acquireMeasurementFreeze(
        freezeGateEntry[0],
        freezeGateEntry[1],
        rootDir,
        now,
        measurementContext,
        options.liveArtifactContext,
        options.liveArtifactContextSha256
      )
    : { result: null, receipt: null };
  const runnerGateEntry = Object.entries(manifest.gates ?? {}).find(
    ([, gate]) => gate?.kind === "runner-receipts"
  );
  const runnerContext = runnerGateEntry
    ? acquireRunnerReceipts(
        runnerGateEntry[0],
        runnerGateEntry[1],
        rootDir,
        now,
        measurementContext,
        freezeContext,
        options
      )
    : {
        result: null,
        verification: null,
        receipts: [],
        hosted: []
      };

  const gates = [];
  for (const [id, gate] of Object.entries(manifest.gates ?? {})) {
    let result;
    try {
      switch (gate.kind) {
        case "decisions":
          result = evaluateDecisions(
            id,
            gate,
            manifest,
            rootDir,
            now,
            measurementContext
          );
          break;
        case "document-digest":
          result = evaluateDocumentDigest(id, gate, manifest, rootDir);
          break;
        case "release-tag-governance":
          result = evaluateReleaseTagGovernance(id, gate, rootDir, now);
          break;
        case "errata":
          result = evaluateErrata(id, gate, manifest, rootDir, now);
          break;
        case "corpus":
          result = evaluateCorpus(
            id,
            gate,
            rootDir,
            measurementContext,
            freezeContext,
            now
          );
          break;
        case "aa-study":
          result = evaluateAaStudies(
            id,
            gate,
            rootDir,
            measurementContext,
            freezeContext,
            now
          );
          break;
        case "calibration":
          result = evaluateCalibration(id, gate, rootDir, measurementContext);
          break;
        case "review-ledger":
          result = evaluateReviewLedger(id, gate, rootDir, now);
          break;
        case "runner-receipts":
          result = runnerContext.result;
          break;
        case "controlled-publications":
          result = evaluateControlledPublications(
            id,
            gate,
            rootDir,
            measurementContext,
            runnerContext,
            options
          );
          break;
        case "lifecycle-receipt":
          result = evaluateLifecycleReceipt(
            id,
            gate,
            rootDir,
            now,
            measurementContext,
            options
          );
          break;
        case "receipt-archive":
          result = evaluateReceiptArchive(id, gate, rootDir);
          break;
        case "operator-attestation":
          result = evaluateAttestation(
            id,
            gate,
            manifest,
            rootDir,
            now,
            measurementContext,
            runnerContext,
            options
          );
          break;
        case "measurement-candidate-binding":
          result = evaluateMeasurementCandidate(
            id,
            gate,
            measurementContext,
            manifest,
            rootDir,
            freezeContext,
            now
          );
          break;
        case "measurement-freeze":
          result = freezeContext.result;
          break;
        case "durable-soak":
          result = evaluateDurableSoak(
            id,
            gate,
            rootDir,
            now,
            measurementContext,
            options
          );
          break;
        case "container-package-review":
          result = evaluateContainerPackageReview(
            id,
            gate,
            rootDir,
            now,
            measurementContext
          );
          break;
        default:
          result = gateResult(id, gate, "fail", [`unknown gate kind ${JSON.stringify(gate.kind)}`]);
      }
    } catch (error) {
      result = gateResult(id, gate, "fail", [`gate evaluation threw: ${String(error).slice(0, 200)}`]);
    }
    gates.push(result);
  }
  return {
    ready: gates.length > 0 && gates.every((gate) => gate.status === "pass"),
    manifestProblems: [],
    gates
  };
}
