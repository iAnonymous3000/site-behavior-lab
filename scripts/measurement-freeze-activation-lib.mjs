import { createHash } from "node:crypto";
import {
  featuredReadjudicationActivationFreshnessIssues,
  FEATURED_READJUDICATION_DATES,
  FEATURED_READJUDICATION_RECEIPT_PATH,
  featuredReadjudicationWorkflowIssues
} from "./featured-readjudication-lib.mjs";

export const MEASUREMENT_FREEZE_RECEIPT_KIND =
  "site-behavior-lab-measurement-freeze-activation";
export const MEASUREMENT_FREEZE_RECEIPT_VERSION = 2;
export const MEASUREMENT_FREEZE_REPOSITORY =
  "iAnonymous3000/site-behavior-lab";
export const MEASUREMENT_FREEZE_DEFAULT_BRANCH = "main";
export const MEASUREMENT_FREEZE_WORKFLOW =
  ".github/workflows/activate-measurement-freeze.yml";
export const FEATURED_COLLECTION_WORKFLOW =
  ".github/workflows/scan-featured.yml";
export const CONTROLLED_EGRESS_ALIAS = "controlled-self-hosted";
export const MEASUREMENT_FREEZE_ARCHIVE_PATH =
  "research/ops-receipts/measurement-freeze-activation.json";

export const MEASUREMENT_FREEZE_CLAIMS = Object.freeze([
  "exact-main-candidate-observed",
  "august-featured-readjudication-live-artifacts-verified",
  "measurement-freeze-variable-enabled",
  "controlled-r2-featured-lane-and-online-runner-observed",
  "zero-open-pre-activation-proposals-observed"
]);

const FULL_GIT_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const CANONICAL_INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ACTIONS_RUN_URL =
  /^https:\/\/github\.com\/iAnonymous3000\/site-behavior-lab\/actions\/runs\/[1-9][0-9]*$/;
const HEAD_PREFIXES = Object.freeze(["automation/", "dependabot/"]);

const RECEIPT_KEYS = Object.freeze([
  "kind",
  "receiptVersion",
  "repository",
  "candidate",
  "activation",
  "featuredLane",
  "reAdjudication",
  "safeConfiguration",
  "controlledRunner",
  "proposalGuard",
  "claims",
  "handoff"
]);
const REPOSITORY_KEYS = Object.freeze(["fullName", "defaultBranch"]);
const CANDIDATE_KEYS = Object.freeze([
  "commit",
  "ref",
  "checkoutCommit",
  "mainRefCommit",
  "mainRefObservedAt",
  "activationWorkflowSha256"
]);
const ACTIVATION_KEYS = Object.freeze([
  "workflow",
  "event",
  "headSha",
  "runId",
  "runAttempt",
  "runUrl",
  "runStartedAt",
  "activatedAt"
]);
const FEATURED_LANE_KEYS = Object.freeze([
  "workflow",
  "workflowSha256",
  "reportMode",
  "acquisition"
]);
const READJUDICATION_KEYS = Object.freeze([
  "receiptPath",
  "receiptSha256",
  "verifiedAt",
  "finalFeaturedSitesSha256",
  "finalFeaturedTargetsSha256",
  "dispositionsSha256",
  "cycles"
]);
const READJUDICATION_CYCLE_KEYS = Object.freeze([
  "date",
  "runId",
  "runAttempt",
  "headSha",
  "runStartedAt",
  "workflowSha256",
  "catalogSha256",
  "catalogTargetsSha256",
  "catalogVersion",
  "artifactId",
  "artifactName",
  "artifactSha256",
  "artifactCreatedAt",
  "outcomesSha256"
]);
const SAFE_CONFIGURATION_KEYS = Object.freeze([
  "measurementFreeze",
  "scannerEgress",
  "runnerLabelSha256",
  "scannerEgressRegionSha256",
  "featuredR2EgressAttested",
  "tupleSha256"
]);
const CONTROLLED_RUNNER_KEYS = Object.freeze([
  "queriedAt",
  "endpoint",
  "configuredLabelSha256",
  "onlineMatches",
  "matchesSha256"
]);
const CONTROLLED_RUNNER_MATCH_KEYS = Object.freeze([
  "identitySha256",
  "nameSha256",
  "labelSetSha256",
  "status",
  "busy"
]);
const PROPOSAL_GUARD_KEYS = Object.freeze([
  "checkedAt",
  "baseBranch",
  "headPrefixes",
  "snapshots",
  "snapshotSha256"
]);
const HANDOFF_KEYS = Object.freeze([
  "artifactName",
  "receiptFile",
  "archivePath",
  "retentionDays"
]);

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function canonicalInstant(value) {
  if (typeof value !== "string" || !CANONICAL_INSTANT.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function canonicalText(value, maximum) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Array.from(value).length <= maximum &&
    value.trim() === value &&
    value.toLowerCase() !== "unknown" &&
    !/[\u0000-\u001f\u007f-\u009f]/.test(value)
  );
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

export function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function compactCanonical(value) {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map((entry) => canonicalValue(entry));
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalValue(value[key])])
  );
}

export function measurementFreezeReceiptText(receipt) {
  return `${JSON.stringify(canonicalValue(receipt), null, 2)}\n`;
}

export function safeMeasurementFreezeConfiguration({
  measurementFreeze,
  runnerLabel,
  scannerEgress,
  scannerEgressRegion,
  featuredR2EgressAttested
}) {
  const issues = [];
  if (measurementFreeze !== "1") {
    issues.push("SITE_BEHAVIOR_LAB_MEASUREMENT_FREEZE must be exactly 1");
  }
  if (!canonicalText(runnerLabel, 120)) {
    issues.push(
      "FEATURED_RUNNER_LABEL must be a canonical, non-unknown value of at most 120 characters"
    );
  } else if (
    new Set([
      "self-hosted",
      "github-hosted",
      "ubuntu-latest",
      "linux",
      "x64",
      "arm64"
    ]).has(runnerLabel.toLowerCase())
  ) {
    issues.push(
      "FEATURED_RUNNER_LABEL must be a custom controlled-runner label, not a generic runner label"
    );
  }
  if (scannerEgress !== CONTROLLED_EGRESS_ALIAS) {
    issues.push(`SCANNER_EGRESS must be exactly ${CONTROLLED_EGRESS_ALIAS}`);
  }
  if (!canonicalText(scannerEgressRegion, 64)) {
    issues.push(
      "SCANNER_EGRESS_REGION must be a canonical, non-unknown r2-safe value of at most 64 characters"
    );
  }
  if (featuredR2EgressAttested !== "1") {
    issues.push("FEATURED_R2_EGRESS_ATTESTED must be exactly 1");
  }
  if (issues.length > 0) throw new Error(issues.join("; "));

  const tuple = {
    measurementFreeze,
    runnerLabel,
    scannerEgress,
    scannerEgressRegion,
    featuredR2EgressAttested
  };
  return {
    measurementFreeze,
    scannerEgress,
    runnerLabelSha256: sha256Hex(`runner-label\u0000${runnerLabel}`),
    scannerEgressRegionSha256: sha256Hex(
      `scanner-egress-region\u0000${scannerEgressRegion}`
    ),
    featuredR2EgressAttested,
    tupleSha256: sha256Hex(compactCanonical(tuple))
  };
}

export function featuredControlledR2WorkflowIssues(source) {
  if (typeof source !== "string" || source.length === 0) {
    return ["featured workflow source must be a non-empty string"];
  }
  const requiredFragments = [
    "default: r2",
    "(vars.FEATURED_RUNNER_LABEL && 'r2' || 'v1')",
    "FEATURED_CONTROLLED_RUNNER_CONFIGURED: ${{ vars.FEATURED_RUNNER_LABEL && '1' || '' }}",
    "FEATURED_R2_EGRESS_ATTESTED: ${{ vars.FEATURED_R2_EGRESS_ATTESTED || '' }}",
    "SITE_BEHAVIOR_LAB_MEASUREMENT_FREEZE: ${{ vars.SITE_BEHAVIOR_LAB_MEASUREMENT_FREEZE || '' }}",
    "SITE_BEHAVIOR_LAB_SCANNER_EGRESS: ${{ vars.SCANNER_EGRESS || 'github-actions-ubuntu' }}",
    "SITE_BEHAVIOR_LAB_SCANNER_EGRESS_REGION: ${{ vars.SCANNER_EGRESS_REGION || '' }}",
    "vars.FEATURED_RUNNER_LABEL || 'ubuntu-latest'",
    "- name: Prepare featured report production",
    "run: node dist/schema/lib/featured-report-preflight-cli.js",
    'const expected = mode === "r2" ? "ci-workflow" : "public-api";'
  ];
  return [
    ...requiredFragments
    .filter((fragment) => !source.includes(fragment))
    .map((fragment) => `featured workflow is missing controlled-r2 contract fragment: ${fragment}`),
    ...featuredReadjudicationWorkflowIssues(source)
  ];
}

function normalizeRunnerMatches(matches) {
  if (!Array.isArray(matches)) {
    throw new TypeError("controlled runner matches must be an array");
  }
  return [...matches].sort((left, right) =>
    String(left.identitySha256).localeCompare(String(right.identitySha256))
  );
}

export function buildMeasurementFreezeActivationReceipt(input) {
  if (!Array.isArray(input.proposalSnapshots)) {
    throw new TypeError("proposal snapshots must be an array");
  }
  const snapshots = [...input.proposalSnapshots];
  const onlineMatches = normalizeRunnerMatches(input.controlledRunnerMatches);
  const safeConfiguration = safeMeasurementFreezeConfiguration(input.configuration);
  const runId = input.runId;
  const runAttempt = input.runAttempt;
  return {
    kind: MEASUREMENT_FREEZE_RECEIPT_KIND,
    receiptVersion: MEASUREMENT_FREEZE_RECEIPT_VERSION,
    repository: {
      fullName: MEASUREMENT_FREEZE_REPOSITORY,
      defaultBranch: MEASUREMENT_FREEZE_DEFAULT_BRANCH
    },
    candidate: {
      commit: input.candidateSha,
      ref: `refs/heads/${MEASUREMENT_FREEZE_DEFAULT_BRANCH}`,
      checkoutCommit: input.checkoutCommit,
      mainRefCommit: input.mainRefCommit,
      mainRefObservedAt: input.mainRefObservedAt,
      activationWorkflowSha256: input.activationWorkflowSha256
    },
    activation: {
      workflow: MEASUREMENT_FREEZE_WORKFLOW,
      event: "workflow_dispatch",
      headSha: input.runHeadSha,
      runId,
      runAttempt,
      runUrl: `https://github.com/${MEASUREMENT_FREEZE_REPOSITORY}/actions/runs/${runId}`,
      runStartedAt: input.runStartedAt,
      activatedAt: input.activatedAt
    },
    featuredLane: {
      workflow: FEATURED_COLLECTION_WORKFLOW,
      workflowSha256: input.featuredWorkflowSha256,
      reportMode: "r2",
      acquisition: "ci-workflow"
    },
    reAdjudication: input.reAdjudication,
    safeConfiguration,
    controlledRunner: {
      queriedAt: input.controlledRunnerQueriedAt,
      endpoint: `/repos/${MEASUREMENT_FREEZE_REPOSITORY}/actions/runners`,
      configuredLabelSha256: safeConfiguration.runnerLabelSha256,
      onlineMatches,
      matchesSha256: sha256Hex(compactCanonical(onlineMatches))
    },
    proposalGuard: {
      checkedAt: input.proposalCheckedAt,
      baseBranch: MEASUREMENT_FREEZE_DEFAULT_BRANCH,
      headPrefixes: [...HEAD_PREFIXES],
      snapshots,
      snapshotSha256: sha256Hex(compactCanonical(snapshots))
    },
    claims: [...MEASUREMENT_FREEZE_CLAIMS],
    handoff: {
      artifactName: `measurement-freeze-activation-${runId}-${runAttempt}`,
      receiptFile: "measurement-freeze-activation-receipt.json",
      archivePath: MEASUREMENT_FREEZE_ARCHIVE_PATH,
      retentionDays: 90
    }
  };
}

function checkExpectedDigest(actual, rawValue, domain, label, issues) {
  if (rawValue === undefined) return;
  const expected = sha256Hex(`${domain}\u0000${rawValue}`);
  if (actual !== expected) issues.push(`${label} does not match the expected live configuration`);
}

export function measurementFreezeActivationReceiptIssues(receipt, options = {}) {
  const issues = [];
  const push = (message) => issues.push(message);
  if (!exactKeys(receipt, RECEIPT_KEYS, "receipt", issues)) return issues;

  if (receipt.kind !== MEASUREMENT_FREEZE_RECEIPT_KIND) {
    push(`kind must be exactly ${MEASUREMENT_FREEZE_RECEIPT_KIND}`);
  }
  if (receipt.receiptVersion !== MEASUREMENT_FREEZE_RECEIPT_VERSION) {
    push(`receiptVersion must be exactly ${MEASUREMENT_FREEZE_RECEIPT_VERSION}`);
  }

  if (exactKeys(receipt.repository, REPOSITORY_KEYS, "repository", issues)) {
    if (receipt.repository.fullName !== MEASUREMENT_FREEZE_REPOSITORY) {
      push(`repository.fullName must be exactly ${MEASUREMENT_FREEZE_REPOSITORY}`);
    }
    if (receipt.repository.defaultBranch !== MEASUREMENT_FREEZE_DEFAULT_BRANCH) {
      push(`repository.defaultBranch must be exactly ${MEASUREMENT_FREEZE_DEFAULT_BRANCH}`);
    }
  }

  const candidate = receipt.candidate;
  if (exactKeys(candidate, CANDIDATE_KEYS, "candidate", issues)) {
    for (const [field, value] of [
      ["candidate.commit", candidate.commit],
      ["candidate.checkoutCommit", candidate.checkoutCommit],
      ["candidate.mainRefCommit", candidate.mainRefCommit]
    ]) {
      if (typeof value !== "string" || !FULL_GIT_SHA.test(value)) {
        push(`${field} must be a full lowercase Git commit`);
      }
    }
    if (
      FULL_GIT_SHA.test(candidate.commit ?? "") &&
      (candidate.checkoutCommit !== candidate.commit ||
        candidate.mainRefCommit !== candidate.commit)
    ) {
      push("candidate commit, checkout commit, and observed main ref must match exactly");
    }
    if (candidate.ref !== "refs/heads/main") {
      push("candidate.ref must be exactly refs/heads/main");
    }
    if (!canonicalInstant(candidate.mainRefObservedAt)) {
      push("candidate.mainRefObservedAt must be a canonical ISO 8601 instant");
    }
    if (
      typeof candidate.activationWorkflowSha256 !== "string" ||
      !SHA256.test(candidate.activationWorkflowSha256)
    ) {
      push("candidate.activationWorkflowSha256 must be a lowercase sha256 digest");
    }
  }

  const activation = receipt.activation;
  if (exactKeys(activation, ACTIVATION_KEYS, "activation", issues)) {
    if (activation.workflow !== MEASUREMENT_FREEZE_WORKFLOW) {
      push(`activation.workflow must be exactly ${MEASUREMENT_FREEZE_WORKFLOW}`);
    }
    if (activation.event !== "workflow_dispatch") {
      push("activation.event must be exactly workflow_dispatch");
    }
    if (activation.headSha !== candidate?.commit) {
      push("activation.headSha must match the exact candidate commit");
    }
    if (!positiveSafeInteger(activation.runId)) {
      push("activation.runId must be a positive integer");
    }
    if (!positiveSafeInteger(activation.runAttempt)) {
      push("activation.runAttempt must be a positive integer");
    }
    const expectedRunUrl = positiveSafeInteger(activation.runId)
      ? `https://github.com/${MEASUREMENT_FREEZE_REPOSITORY}/actions/runs/${activation.runId}`
      : "";
    if (!ACTIONS_RUN_URL.test(activation.runUrl ?? "") || activation.runUrl !== expectedRunUrl) {
      push("activation.runUrl must bind the exact repository and run id");
    }
    if (!canonicalInstant(activation.runStartedAt)) {
      push("activation.runStartedAt must be a canonical ISO 8601 instant");
    }
    if (!canonicalInstant(activation.activatedAt)) {
      push("activation.activatedAt must be a canonical ISO 8601 instant");
    }
    if (
      canonicalInstant(activation.runStartedAt) &&
      canonicalInstant(activation.activatedAt) &&
      Date.parse(activation.runStartedAt) > Date.parse(activation.activatedAt)
    ) {
      push("activation.activatedAt must not precede the workflow start");
    }
    if (
      canonicalInstant(candidate?.mainRefObservedAt) &&
      canonicalInstant(activation.activatedAt) &&
      Date.parse(candidate.mainRefObservedAt) > Date.parse(activation.activatedAt)
    ) {
      push("activation.activatedAt must not precede the main-ref observation");
    }
    if (canonicalInstant(activation.activatedAt)) {
      issues.push(
        ...featuredReadjudicationActivationFreshnessIssues(
          options.expectedReAdjudicationReceipt,
          activation.activatedAt
        )
      );
    }
  }

  const featuredLane = receipt.featuredLane;
  if (exactKeys(featuredLane, FEATURED_LANE_KEYS, "featuredLane", issues)) {
    if (featuredLane.workflow !== FEATURED_COLLECTION_WORKFLOW) {
      push(`featuredLane.workflow must be exactly ${FEATURED_COLLECTION_WORKFLOW}`);
    }
    if (
      typeof featuredLane.workflowSha256 !== "string" ||
      !SHA256.test(featuredLane.workflowSha256)
    ) {
      push("featuredLane.workflowSha256 must be a lowercase sha256 digest");
    }
    if (featuredLane.reportMode !== "r2") {
      push("featuredLane.reportMode must be exactly r2");
    }
    if (featuredLane.acquisition !== "ci-workflow") {
      push("featuredLane.acquisition must be exactly ci-workflow");
    }
  }

  const reAdjudication = receipt.reAdjudication;
  if (
    exactKeys(
      reAdjudication,
      READJUDICATION_KEYS,
      "reAdjudication",
      issues
    )
  ) {
    if (reAdjudication.receiptPath !== FEATURED_READJUDICATION_RECEIPT_PATH) {
      push(
        `reAdjudication.receiptPath must be exactly ${FEATURED_READJUDICATION_RECEIPT_PATH}`
      );
    }
    for (const field of [
      "receiptSha256",
      "finalFeaturedSitesSha256",
      "finalFeaturedTargetsSha256",
      "dispositionsSha256"
    ]) {
      if (
        typeof reAdjudication[field] !== "string" ||
        !SHA256.test(reAdjudication[field])
      ) {
        push(`reAdjudication.${field} must be a lowercase sha256 digest`);
      }
    }
    if (!canonicalInstant(reAdjudication.verifiedAt)) {
      push("reAdjudication.verifiedAt must be a canonical ISO 8601 instant");
    }
    if (
      canonicalInstant(reAdjudication.verifiedAt) &&
      canonicalInstant(activation?.activatedAt) &&
      Date.parse(reAdjudication.verifiedAt) > Date.parse(activation.activatedAt)
    ) {
      push("reAdjudication.verifiedAt must not be after activation");
    }
    if (
      canonicalInstant(reAdjudication.verifiedAt) &&
      canonicalInstant(activation?.runStartedAt) &&
      Date.parse(reAdjudication.verifiedAt) <
        Date.parse(activation.runStartedAt)
    ) {
      push(
        "reAdjudication.verifiedAt must not precede the activation workflow start"
      );
    }
    if (
      canonicalInstant(reAdjudication.verifiedAt) &&
      canonicalInstant(activation?.activatedAt) &&
      Date.parse(activation.activatedAt) -
        Date.parse(reAdjudication.verifiedAt) >
        15 * 60 * 1000
    ) {
      push(
        "reAdjudication live verification must be no more than fifteen minutes before activation"
      );
    }
    if (
      !Array.isArray(reAdjudication.cycles) ||
      reAdjudication.cycles.length !== FEATURED_READJUDICATION_DATES.length
    ) {
      push("reAdjudication.cycles must contain exactly the Aug 3 and Aug 10 cycles");
    } else {
      const runIds = new Set();
      const artifactIds = new Set();
      for (const [index, cycle] of reAdjudication.cycles.entries()) {
        const label = `reAdjudication.cycles[${index}]`;
        if (!exactKeys(cycle, READJUDICATION_CYCLE_KEYS, label, issues)) {
          continue;
        }
        const expectedDate = FEATURED_READJUDICATION_DATES[index];
        if (cycle.date !== expectedDate) {
          push(`${label}.date must be exactly ${expectedDate}`);
        }
        if (!positiveSafeInteger(cycle.runId)) {
          push(`${label}.runId must be a positive integer`);
        } else if (runIds.has(cycle.runId)) {
          push(`${label}.runId must be distinct`);
        }
        runIds.add(cycle.runId);
        if (!positiveSafeInteger(cycle.runAttempt)) {
          push(`${label}.runAttempt must be a positive integer`);
        }
        if (typeof cycle.headSha !== "string" || !FULL_GIT_SHA.test(cycle.headSha)) {
          push(`${label}.headSha must be a full lowercase Git commit`);
        }
        for (const field of ["runStartedAt", "artifactCreatedAt"]) {
          if (!canonicalInstant(cycle[field])) {
            push(`${label}.${field} must be a canonical ISO 8601 instant`);
          } else if (cycle[field].slice(0, 10) !== expectedDate) {
            push(`${label}.${field} must fall on ${expectedDate}`);
          }
        }
        if (
          canonicalInstant(cycle.runStartedAt) &&
          canonicalInstant(cycle.artifactCreatedAt) &&
          Date.parse(cycle.artifactCreatedAt) <
            Date.parse(cycle.runStartedAt)
        ) {
          push(`${label}.artifactCreatedAt must not precede its run start`);
        }
        for (const field of [
          "workflowSha256",
          "catalogSha256",
          "catalogTargetsSha256",
          "artifactSha256",
          "outcomesSha256"
        ]) {
          if (typeof cycle[field] !== "string" || !SHA256.test(cycle[field])) {
            push(`${label}.${field} must be a lowercase sha256 digest`);
          }
        }
        if (!positiveSafeInteger(cycle.artifactId)) {
          push(`${label}.artifactId must be a positive integer`);
        } else if (artifactIds.has(cycle.artifactId)) {
          push(`${label}.artifactId must be distinct`);
        }
        artifactIds.add(cycle.artifactId);
        const expectedArtifactName =
          positiveSafeInteger(cycle.runId) &&
          positiveSafeInteger(cycle.runAttempt)
            ? `featured-readjudication-outcomes-${cycle.runId}-${cycle.runAttempt}`
            : "";
        if (cycle.artifactName !== expectedArtifactName) {
          push(`${label}.artifactName must bind the exact run id and attempt`);
        }
        if (
          !Number.isSafeInteger(cycle.catalogVersion) ||
          cycle.catalogVersion < 2
        ) {
          push(`${label}.catalogVersion must be an integer of at least 2`);
        }
      }
      const targetDigests = new Set(
        reAdjudication.cycles
          .map((cycle) => cycle?.catalogTargetsSha256)
          .filter((value) => SHA256.test(value ?? ""))
      );
      if (targetDigests.size !== 1) {
        push(
          "reAdjudication cycles must bind one identical fixed-domain target identity"
        );
      } else if (
        reAdjudication.finalFeaturedTargetsSha256 !==
        [...targetDigests][0]
      ) {
        push(
          "reAdjudication final featured catalog must preserve the cycle target identity"
        );
      }
    }
    for (const [actual, expected, label] of [
      [
        reAdjudication.receiptSha256,
        options.expectedReAdjudicationReceiptSha256,
        "reAdjudication.receiptSha256"
      ],
      [
        reAdjudication.finalFeaturedSitesSha256,
        options.expectedFeaturedSitesSha256,
        "reAdjudication.finalFeaturedSitesSha256"
      ],
      [
        reAdjudication.finalFeaturedTargetsSha256,
        options.expectedFeaturedTargetsSha256,
        "reAdjudication.finalFeaturedTargetsSha256"
      ],
      [
        reAdjudication.dispositionsSha256,
        options.expectedReAdjudicationDispositionsSha256,
        "reAdjudication.dispositionsSha256"
      ]
    ]) {
      if (expected !== undefined && actual !== expected) {
        push(`${label} does not match the validator's expected value`);
      }
    }
    if (options.expectedReAdjudicationCycles !== undefined) {
      const expectedCycles = options.expectedReAdjudicationCycles;
      if (
        !Array.isArray(expectedCycles) ||
        expectedCycles.length !== FEATURED_READJUDICATION_DATES.length
      ) {
        push(
          "validator expectedReAdjudicationCycles must contain exactly two bindings"
        );
      } else if (Array.isArray(reAdjudication.cycles)) {
        for (const [index, expectedCycle] of expectedCycles.entries()) {
          const actualCycle = reAdjudication.cycles[index];
          for (const field of [
            "date",
            "runId",
            "runAttempt",
            "headSha",
            "catalogSha256",
            "catalogTargetsSha256",
            "catalogVersion",
            "artifactId",
            "artifactName",
            "artifactSha256",
            "outcomesSha256"
          ]) {
            if (actualCycle?.[field] !== expectedCycle?.[field]) {
              push(
                `reAdjudication.cycles[${index}].${field} does not match the aggregate receipt`
              );
            }
          }
        }
      }
    }
  }

  const configuration = receipt.safeConfiguration;
  if (
    exactKeys(
      configuration,
      SAFE_CONFIGURATION_KEYS,
      "safeConfiguration",
      issues
    )
  ) {
    if (configuration.measurementFreeze !== "1") {
      push("safeConfiguration.measurementFreeze must be exactly 1");
    }
    if (configuration.scannerEgress !== CONTROLLED_EGRESS_ALIAS) {
      push(
        `safeConfiguration.scannerEgress must be exactly ${CONTROLLED_EGRESS_ALIAS}`
      );
    }
    for (const field of [
      "runnerLabelSha256",
      "scannerEgressRegionSha256",
      "tupleSha256"
    ]) {
      if (typeof configuration[field] !== "string" || !SHA256.test(configuration[field])) {
        push(`safeConfiguration.${field} must be a lowercase sha256 digest`);
      }
    }
    if (configuration.featuredR2EgressAttested !== "1") {
      push("safeConfiguration.featuredR2EgressAttested must be exactly 1");
    }
    checkExpectedDigest(
      configuration.runnerLabelSha256,
      options.expectedRunnerLabel,
      "runner-label",
      "safeConfiguration.runnerLabelSha256",
      issues
    );
    checkExpectedDigest(
      configuration.scannerEgressRegionSha256,
      options.expectedScannerEgressRegion,
      "scanner-egress-region",
      "safeConfiguration.scannerEgressRegionSha256",
      issues
    );
    if (
      options.expectedRunnerLabel !== undefined &&
      options.expectedScannerEgressRegion !== undefined
    ) {
      try {
        const expected = safeMeasurementFreezeConfiguration({
          measurementFreeze: options.expectedMeasurementFreeze ?? "1",
          runnerLabel: options.expectedRunnerLabel,
          scannerEgress: options.expectedScannerEgress ?? CONTROLLED_EGRESS_ALIAS,
          scannerEgressRegion: options.expectedScannerEgressRegion,
          featuredR2EgressAttested:
            options.expectedFeaturedR2EgressAttested ?? "1"
        });
        if (configuration.tupleSha256 !== expected.tupleSha256) {
          push("safeConfiguration.tupleSha256 does not match the expected live configuration");
        }
      } catch (error) {
        push(
          `expected live configuration is invalid: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }
  }

  const controlledRunner = receipt.controlledRunner;
  if (
    exactKeys(
      controlledRunner,
      CONTROLLED_RUNNER_KEYS,
      "controlledRunner",
      issues
    )
  ) {
    if (!canonicalInstant(controlledRunner.queriedAt)) {
      push("controlledRunner.queriedAt must be a canonical ISO 8601 instant");
    }
    if (
      controlledRunner.endpoint !==
      `/repos/${MEASUREMENT_FREEZE_REPOSITORY}/actions/runners`
    ) {
      push("controlledRunner.endpoint must bind the exact repository runner endpoint");
    }
    if (
      controlledRunner.configuredLabelSha256 !==
      configuration?.runnerLabelSha256
    ) {
      push(
        "controlledRunner.configuredLabelSha256 must match the configured runner-label digest"
      );
    }
    if (
      !Array.isArray(controlledRunner.onlineMatches) ||
      controlledRunner.onlineMatches.length === 0 ||
      controlledRunner.onlineMatches.length > 100
    ) {
      push("controlledRunner.onlineMatches must contain 1 through 100 online matches");
    } else {
      let priorIdentity = "";
      const identities = new Set();
      for (const [index, match] of controlledRunner.onlineMatches.entries()) {
        const label = `controlledRunner.onlineMatches[${index}]`;
        if (!exactKeys(match, CONTROLLED_RUNNER_MATCH_KEYS, label, issues)) continue;
        for (const field of ["identitySha256", "nameSha256", "labelSetSha256"]) {
          if (typeof match[field] !== "string" || !SHA256.test(match[field])) {
            push(`${label}.${field} must be a lowercase sha256 digest`);
          }
        }
        if (
          identities.has(match.identitySha256) ||
          (priorIdentity && match.identitySha256 <= priorIdentity)
        ) {
          push(`${label}.identitySha256 must be unique and strictly sorted`);
        }
        identities.add(match.identitySha256);
        priorIdentity = match.identitySha256;
        if (match.status !== "online") {
          push(`${label}.status must be exactly online`);
        }
        if (typeof match.busy !== "boolean") {
          push(`${label}.busy must be a boolean observed from the runner API`);
        }
      }
      const expectedMatchesDigest = sha256Hex(
        compactCanonical(controlledRunner.onlineMatches)
      );
      if (controlledRunner.matchesSha256 !== expectedMatchesDigest) {
        push("controlledRunner.matchesSha256 does not match the canonical online matches");
      }
    }
    if (
      canonicalInstant(controlledRunner.queriedAt) &&
      canonicalInstant(activation?.activatedAt)
    ) {
      const queryTime = Date.parse(controlledRunner.queriedAt);
      const activationTime = Date.parse(activation.activatedAt);
      if (queryTime > activationTime) {
        push("controlledRunner.queriedAt must not be after activation");
      }
      if (activationTime - queryTime > 5 * 60 * 1000) {
        push("controlledRunner observation must be no more than five minutes before activation");
      }
    }
    if (
      canonicalInstant(reAdjudication?.verifiedAt) &&
      canonicalInstant(controlledRunner.queriedAt) &&
      Date.parse(reAdjudication.verifiedAt) >
        Date.parse(controlledRunner.queriedAt)
    ) {
      push(
        "controlledRunner observation must follow reAdjudication live verification"
      );
    }
  }

  const proposalGuard = receipt.proposalGuard;
  if (exactKeys(proposalGuard, PROPOSAL_GUARD_KEYS, "proposalGuard", issues)) {
    if (!canonicalInstant(proposalGuard.checkedAt)) {
      push("proposalGuard.checkedAt must be a canonical ISO 8601 instant");
    }
    if (
      canonicalInstant(activation?.activatedAt) &&
      canonicalInstant(proposalGuard.checkedAt) &&
      Date.parse(proposalGuard.checkedAt) > Date.parse(activation.activatedAt)
    ) {
      push("proposalGuard.checkedAt must not be after activation.activatedAt");
    }
    if (
      canonicalInstant(controlledRunner?.queriedAt) &&
      canonicalInstant(proposalGuard.checkedAt) &&
      Date.parse(controlledRunner.queriedAt) > Date.parse(proposalGuard.checkedAt)
    ) {
      push("proposalGuard.checkedAt must not precede the controlled-runner observation");
    }
    if (
      canonicalInstant(candidate?.mainRefObservedAt) &&
      canonicalInstant(proposalGuard.checkedAt) &&
      Date.parse(proposalGuard.checkedAt) > Date.parse(candidate.mainRefObservedAt)
    ) {
      push("candidate main ref must be re-read after the final proposal snapshot");
    }
    if (proposalGuard.baseBranch !== MEASUREMENT_FREEZE_DEFAULT_BRANCH) {
      push(`proposalGuard.baseBranch must be exactly ${MEASUREMENT_FREEZE_DEFAULT_BRANCH}`);
    }
    if (JSON.stringify(proposalGuard.headPrefixes) !== JSON.stringify(HEAD_PREFIXES)) {
      push(`proposalGuard.headPrefixes must be exactly ${HEAD_PREFIXES.join(", ")}`);
    }
    if (!Array.isArray(proposalGuard.snapshots)) {
      push("proposalGuard.snapshots must be an array");
    } else {
      if (proposalGuard.snapshots.length !== 0) {
        push(
          "proposalGuard.snapshots must be empty: no automation/* or dependabot/* pull request may be open at activation"
        );
      }
      const expectedSnapshotDigest = sha256Hex(
        compactCanonical(proposalGuard.snapshots)
      );
      if (proposalGuard.snapshotSha256 !== expectedSnapshotDigest) {
        push("proposalGuard.snapshotSha256 does not match the canonical snapshots");
      }
    }
  }

  if (JSON.stringify(receipt.claims) !== JSON.stringify(MEASUREMENT_FREEZE_CLAIMS)) {
    push("claims must be the exact fixed evidence-backed claim identifiers");
  }

  const handoff = receipt.handoff;
  if (exactKeys(handoff, HANDOFF_KEYS, "handoff", issues)) {
    const expectedName =
      positiveSafeInteger(activation?.runId) &&
      positiveSafeInteger(activation?.runAttempt)
        ? `measurement-freeze-activation-${activation.runId}-${activation.runAttempt}`
        : "";
    if (handoff.artifactName !== expectedName) {
      push("handoff.artifactName must bind the exact run id and attempt");
    }
    if (handoff.receiptFile !== "measurement-freeze-activation-receipt.json") {
      push("handoff.receiptFile must be exactly measurement-freeze-activation-receipt.json");
    }
    if (handoff.archivePath !== MEASUREMENT_FREEZE_ARCHIVE_PATH) {
      push(`handoff.archivePath must be exactly ${MEASUREMENT_FREEZE_ARCHIVE_PATH}`);
    }
    if (handoff.retentionDays !== 90) {
      push("handoff.retentionDays must be exactly 90");
    }
  }

  const now = options.now === undefined ? new Date() : new Date(options.now);
  if (Number.isNaN(now.getTime())) {
    push("validator now option must be a valid instant");
  } else {
    for (const [label, value] of [
      ["candidate.mainRefObservedAt", candidate?.mainRefObservedAt],
      ["activation.runStartedAt", activation?.runStartedAt],
      ["activation.activatedAt", activation?.activatedAt],
      ["reAdjudication.verifiedAt", reAdjudication?.verifiedAt],
      ["controlledRunner.queriedAt", controlledRunner?.queriedAt],
      ["proposalGuard.checkedAt", proposalGuard?.checkedAt]
    ]) {
      if (canonicalInstant(value) && Date.parse(value) > now.getTime()) {
        push(`${label} must not be in the future`);
      }
    }
  }
  if (Array.isArray(reAdjudication?.cycles)) {
    for (const [index, cycle] of reAdjudication.cycles.entries()) {
      for (const field of ["runStartedAt", "artifactCreatedAt"]) {
        if (
          canonicalInstant(cycle?.[field]) &&
          !Number.isNaN(now.getTime()) &&
          Date.parse(cycle[field]) > now.getTime()
        ) {
          push(`reAdjudication.cycles[${index}].${field} must not be in the future`);
        }
      }
    }
  }

  for (const [actual, expected, label] of [
    [receipt.repository?.fullName, options.expectedRepository, "repository.fullName"],
    [candidate?.commit, options.expectedCandidateSha, "candidate.commit"],
    [activation?.runId, options.expectedRunId, "activation.runId"],
    [activation?.runAttempt, options.expectedRunAttempt, "activation.runAttempt"],
    [
      candidate?.activationWorkflowSha256,
      options.expectedActivationWorkflowSha256,
      "candidate.activationWorkflowSha256"
    ],
    [
      featuredLane?.workflowSha256,
      options.expectedFeaturedWorkflowSha256,
      "featuredLane.workflowSha256"
    ]
  ]) {
    if (expected !== undefined && actual !== expected) {
      push(`${label} does not match the validator's expected value`);
    }
  }

  return issues;
}

export function verifyMeasurementFreezeActivationReceipt(receipt, options = {}) {
  const issues = measurementFreezeActivationReceiptIssues(receipt, options);
  const canonicalText = measurementFreezeReceiptText(receipt);
  return {
    ok: issues.length === 0,
    issues,
    receiptSha256: sha256Hex(canonicalText)
  };
}

export function parseAndVerifyMeasurementFreezeActivationReceipt(text, options = {}) {
  const issues = [];
  let receipt;
  try {
    receipt = JSON.parse(text);
  } catch {
    return {
      ok: false,
      issues: ["receipt is not valid JSON"],
      receipt: null,
      receiptSha256: null
    };
  }
  const canonicalText = measurementFreezeReceiptText(receipt);
  if (text !== canonicalText) {
    issues.push("receipt bytes must be canonical two-space JSON with one trailing newline");
  }
  issues.push(...measurementFreezeActivationReceiptIssues(receipt, options));
  return {
    ok: issues.length === 0,
    issues,
    receipt,
    receiptSha256: sha256Hex(canonicalText)
  };
}
