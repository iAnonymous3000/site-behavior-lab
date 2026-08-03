/**
 * One source identity for every post-freeze release-evidence carrier.
 *
 * The measurement candidate is the last commit allowed to change code,
 * workflows, catalogs, lists, packages, or policy. Later commits may carry
 * evidence, but this verifier accepts them only when the complete C..S diff is
 * set-equal to digest-enumerated files under code-owned path policies. Deletes,
 * renames, and unlisted changes always fail closed.
 *
 * This is a host verifier. It requires Git metadata and cryptographically
 * verifies the candidate's committed CI attestation bundle with `gh`. A
 * container/static build without `.git` may consume only the verifier-produced
 * candidate projection exposed by measurementCandidateBuildProjection().
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, createPublicKey } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import packageManifest from "../package.json";
import braveListManifest from "./adblock-wasm/brave-default-filters.meta.json";
import { canonicalJson } from "./canonical-json";
import {
  analyzeDetectorCalibrationStudy,
  detectorCalibrationMeasurementCondition,
  detectorCalibrationRuntimeDigest,
  type DetectorCalibrationAnalysis
} from "./detector-calibration";
import {
  NODE_ADBLOCK_ENGINE_VERSION,
  NODE_PLAYWRIGHT_VERSION
} from "./legacy-methodology";
import {
  DETECTOR_REGISTRY_DIGEST,
  DETECTOR_REGISTRY_VERSION
} from "./measurement-kernel";
import { DETECTOR_IDS, type DetectorId } from "./scan-report-v2";
import { NODE_SCAN_REPORT_V2_R2_NORMALIZATION_VERSION } from "./scan-report-v2-normalization";
import { NODE_SCAN_REPORT_V2_R2_METHODOLOGY_VERSION } from "./scan-report-v2-r2-producer-contract";
import {
  deriveChoiceStateR2,
  deriveReverifiedAfterReloadR2
} from "./scan-report-v2-r2-evaluators";
import type {
  ConsentEvidenceR2,
  ScanRunV2R2
} from "./scan-report-v2-r2";
import { trackerCatalogMetadata } from "./tracker-catalog";

export const MEASUREMENT_CANDIDATE_BINDING_PATH = "research/measurement-candidate-binding.json";
export const MEASUREMENT_CANDIDATE_SOURCE_EVIDENCE_PATH =
  "research/measurement-candidate/site-behavior-lab-container-release-evidence.json";
export const MEASUREMENT_CANDIDATE_ATTESTATION_BUNDLE_PATH =
  "research/measurement-candidate/container-evidence-manifest.bundle.json";
export const MEASUREMENT_CANDIDATE_PACKAGE_INVENTORY_PATH =
  "research/measurement-candidate/site-behavior-lab-container-package-inventory.json";
export const MEASUREMENT_CANDIDATE_PACKAGE_ATTESTATION_BUNDLE_PATH =
  "research/measurement-candidate/container-package-inventory.bundle.json";
export const MEASUREMENT_CANDIDATE_PACKAGE_REVIEW_LEDGER_PATH =
  "CONTAINER_IMAGE_PACKAGE_REVIEWS.json";
export const MEASUREMENT_CANDIDATE_INPUTS_PATH =
  "research/measurement-candidate/measurement-inputs.json";
export const MEASUREMENT_IDENTITY_PATH =
  "research/measurement-candidate/measurement-identity.json";
export const MEASUREMENT_CALIBRATION_CENSORING_POLICY_PATH =
  "research/measurement-candidate/calibration-censoring-policy.json";
export const MEASUREMENT_CALIBRATION_POLICY_DISPOSITION_DOMAIN =
  "site-behavior-calibration-censoring-policy-disposition-v2";
export const MEASUREMENT_CALIBRATION_POLICY_SCHEMA_VERSION = 2;
export const MEASUREMENT_CALIBRATION_MINIMUM_CLASS_DENOMINATOR = 100;
export const MEASUREMENT_CALIBRATION_CONFIDENCE_LEVEL = 0.95;
export const MEASUREMENT_CALIBRATION_MAXIMUM_WORST_CASE_HALF_WIDTH = 0.1;
export const MEASUREMENT_CANDIDATE_BINDING_KIND = "site-behavior-measurement-candidate-binding";
export const MEASUREMENT_CANDIDATE_BINDING_VERSION = 1;
export const MEASUREMENT_CALIBRATION_ARTIFACT_MANIFEST_KIND =
  "site-behavior-detector-calibration-artifact-manifest";
export const MEASUREMENT_CALIBRATION_CENSORING_POLICY_ID =
  "complete-case-only-zero-censoring";
export const MEASUREMENT_CANDIDATE_INPUTS_KIND =
  "site-behavior-measurement-inputs";
export const MEASUREMENT_CANDIDATE_INPUTS_DIGEST_DOMAIN =
  "site-behavior-measurement-inputs-v1";
export const MEASUREMENT_IDENTITY_KIND =
  "site-behavior-measurement-identity";
export const MEASUREMENT_IDENTITY_DIGEST_DOMAIN =
  "site-behavior-measurement-identity-v1";
export const MEASUREMENT_CANDIDATE_REPOSITORY = "iAnonymous3000/site-behavior-lab";
export const MEASUREMENT_CANDIDATE_TARGET_RELEASE = "1.0.0";
export const MEASUREMENT_CANDIDATE_SIGNER_WORKFLOW =
  "iAnonymous3000/site-behavior-lab/.github/workflows/ci.yml";
export const MEASUREMENT_AA_PRODUCER_WORKFLOW =
  "iAnonymous3000/site-behavior-lab/.github/workflows/aa-study.yml";
export const VERIFIED_MEASUREMENT_CANDIDATE_PROOF_ENV =
  "SITE_BEHAVIOR_LAB_VERIFIED_MEASUREMENT_CANDIDATE_PROOF";
export const MEASUREMENT_DURABLE_CONFIG_PATH = "wrangler.container.jsonc";
export const MEASUREMENT_DURABLE_TRANSITION_RECEIPT_PATH =
  "research/ops-receipts/durable-enable-transition.json";
export const MEASUREMENT_DURABLE_SOAK_ATTESTATION_PATH =
  "research/ops-receipts/durable-soak-attestation.json";
export const MEASUREMENT_DURABLE_SOAK_HOSTED_PROFILE =
  "durable-soak";
export const MEASUREMENT_STAGING_TEARDOWN_EVIDENCE_PATH =
  "research/ops-evidence/staging-teardown.json";
export const MEASUREMENT_STAGING_TEARDOWN_HOSTED_PROFILE =
  "staging-teardown";
export const MEASUREMENT_STAGING_TEARDOWN_CAPTURE_WORKFLOW_PATH =
  ".github/workflows/staging-teardown-evidence.yml";
export const MEASUREMENT_STAGING_TEARDOWN_SOURCE_CLOSURE_PATHS =
  Object.freeze([
    MEASUREMENT_STAGING_TEARDOWN_CAPTURE_WORKFLOW_PATH,
    "lib/canonical-json.ts",
    "lib/sha256.ts",
    "package-lock.json",
    "package.json",
    "scripts/operator-evidence-common.mjs",
    "scripts/staging-teardown-evidence-lib.mjs",
    "scripts/staging-teardown-hosted-capture-lib.mjs",
    "scripts/staging-teardown-hosted-capture.mjs",
    "tsconfig.json",
    "tsconfig.schema.json"
  ]);
export const MEASUREMENT_HOSTED_EVIDENCE_ARCHIVER_WORKFLOW_PATH =
  ".github/workflows/archive-hosted-evidence.yml";
export const MEASUREMENT_DURABLE_SOAK_MINIMUM_HOURS = 24;
export const MEASUREMENT_DURABLE_SOAK_TARGET_HOURS = 168;

const FULL_GIT_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const GIT_TIMESTAMP_PRECISION_SKEW_MS = 1_000;
const TOKEN = "[a-z0-9][a-z0-9._-]{0,99}";
const REPORT_ID = "[0-9]{8}-[0-9a-f]{32}";
const CALIBRATION_PREREGISTRATION_PATH = new RegExp(
  `^calibration/(${TOKEN})/preregistration\\.json$`
);
const CALIBRATION_FRAME_PATH = new RegExp(`^calibration/(${TOKEN})/frame\\.json$`);
const CALIBRATION_LABEL_SEALING_PUBLIC_KEY_PATH = new RegExp(
  `^calibration/(${TOKEN})/label-sealing-public-key\\.pem$`
);
const CALIBRATION_LABEL_SEALING_ALGORITHM =
  "rsa-oaep-sha256+a256gcm";
const STUDY_PATH = new RegExp(`^calibration/(${TOKEN})/study\\.json$`);
const ANALYSIS_PATH = new RegExp(`^calibration/(${TOKEN})/analysis\\.json$`);
const RUNTIME_RECEIPT_PATH = new RegExp(`^calibration/(${TOKEN})/runtime-receipt\\.json$`);
const RUNTIME_RECEIPT_BUNDLE_PATH = new RegExp(
  `^calibration/(${TOKEN})/runtime-receipt\\.sigstore\\.json$`
);
const CALIBRATION_ARTIFACT_MANIFEST_PATH = new RegExp(
  `^calibration/(${TOKEN})/artifact-manifest\\.json$`
);
const CALIBRATION_LABEL_ROSTER_AUTHORIZATION_PATH = new RegExp(
  `^calibration/(${TOKEN})/label-roster-authorization\\.json$`
);
const CALIBRATION_ROSTER_SELECTION_LEDGER_PATH = new RegExp(
  `^calibration/(${TOKEN})/roster-selection-ledger\\.json$`
);
const CALIBRATION_ACQUISITION_ATTEMPT_LEDGER_PATH = new RegExp(
  `^calibration/(${TOKEN})/acquisition-attempt-ledger\\.json$`
);

export type MeasurementEvidenceCategory =
  | "featured-report"
  | "featured-provenance"
  | "generated-report-index"
  | "generated-corpus-stats"
  | "runner-receipt"
  | "controlled-publication-manifest"
  | "controlled-publication-receipt"
  | "aa-attempt-ledger"
  | "aa-evaluation"
  | "aa-producer-receipt"
  | "aa-producer-attestation"
  | "calibration-label-coordinate"
  | "measurement-freeze-receipt"
  | "lifecycle-receipt"
  | "operator-evidence"
  | "operator-attestation"
  | "hosted-evidence-archive"
  | "release-policy-finalization"
  | "citation-finalization"
  | "changelog-finalization";

export type MeasurementEvidenceEntry = {
  category: MeasurementEvidenceCategory;
  path: string;
  change: MeasurementEvidenceChange;
  sha256: string;
};

export type MeasurementEvidenceChange =
  | "added"
  | "generated-update"
  | "refreshed"
  | "release-finalization";

export type MeasurementCalibrationStudy = {
  studyId: string;
  detector: DetectorId;
  preregistrationPath: string;
  preregistrationSha256: string;
  samplingFramePath: string;
  samplingFrameSha256: string;
  censoringPolicy: {
    id: typeof MEASUREMENT_CALIBRATION_CENSORING_POLICY_ID;
    path: string;
    sha256: string;
  };
  studyPath: string;
  studySha256: string;
  analysisPath: string;
  analysisSha256: string;
  runtimeReceiptPath: string;
  runtimeReceiptSha256: string;
  runtimeReceiptBundlePath: string;
  runtimeReceiptBundleSha256: string;
  runtimeReceiptRecordedAt: string;
  runtimeReceiptProducerCommit: string;
  runtimeReceiptRunHeadCommit: string;
  runtimeReceiptRuntimeDigest: string;
  labelsManifestPath: string;
  labelsManifestSha256: string;
  labelRosterAuthorizationPath: string;
  labelRosterAuthorizationSha256: string;
  rosterSelectionLedgerPath: string;
  rosterSelectionLedgerSha256: string;
  acquisitionAttemptLedgerPath: string;
  acquisitionAttemptLedgerSha256: string;
  artifactManifestPath: string;
  artifactManifestSha256: string;
  artifacts: MeasurementCalibrationArtifact[];
  analysisPolicyProblems: string[];
};

export type MeasurementCalibrationArtifactRole =
  | "selection"
  | "condition"
  | "source-report"
  | "detector-observation"
  | "prediction"
  | "evidence"
  | "label"
  | "adjudication"
  | "attempt";

export type MeasurementCalibrationArtifact = {
  role: MeasurementCalibrationArtifactRole;
  caseId: string;
  path: string;
  sha256: string;
};

export type MeasurementCandidateInput = {
  path: string;
  sha256: string;
};

type CalibrationLabelSealingKey = {
  algorithm: typeof CALIBRATION_LABEL_SEALING_ALGORITHM;
  keyId: string;
  publicKeyPath: string;
  publicKeySha256: string;
};

export type MeasurementIdentity = {
  implementation: {
    detectorRegistryVersion: string;
    detectorRegistryDigest: string;
    methodologyVersion: string;
    normalizationVersion: string;
  };
  catalogs: {
    trackerCatalogVersion: string;
    trackerCatalogDigest: string;
    trackerCatalogProvenanceVersion: string;
    trackerCatalogProvenanceDigest: string;
    braveCatalogCommit: string;
    braveCatalogDigest: string;
    braveManifestDigest: string;
    braveRulesDigest: string;
    braveEngineVersion: string;
  };
  toolchain: {
    nodeVersion: string;
    playwrightVersion: string;
    containerBaseImageDigest: string;
    containerNodeVersion: string;
  };
};

export type MeasurementRuntimeIdentity = {
  containerImageId: string;
  operatingSystem: string;
  architecture: string;
  rootfsLayers: string[];
  nodeVersion: string;
  npm: "absent";
};

export type DurableSoakTargetDeviationApproval = {
  status: "approved";
  approverType: "named-human";
  approvedBy: string;
  approvedAt: string;
  reason: string;
  candidateCommit: string;
  soakDeploymentCommit: string;
  ledgerSha256: string;
  evidenceWindow: {
    startedAt: string;
    restartObservedAt: string;
    endedAt: string;
  };
  minimumEvidenceHours: typeof MEASUREMENT_DURABLE_SOAK_MINIMUM_HOURS;
  targetEvidenceHours: typeof MEASUREMENT_DURABLE_SOAK_TARGET_HOURS;
};

export type DurableEnableTransition = {
  configPath: "wrangler.container.jsonc";
  configSha256: string;
  fromCommit: string;
  toCommit: string;
  transitionReceiptPath: typeof MEASUREMENT_DURABLE_TRANSITION_RECEIPT_PATH;
  transitionReceiptSha256: string;
  deploymentDigest: string;
  replayDeploymentCommit: string;
  replayReceiptSetDigest: string;
  replayReceipts: Array<{
    mode: "lease-expiry" | "lost-resolve";
    path: string;
    sha256: string;
  }>;
  replayEvidenceStartedAt: string;
  replayEvidenceCapturedAt: string;
  stagingTeardownEvidencePath: typeof MEASUREMENT_STAGING_TEARDOWN_EVIDENCE_PATH;
  stagingTeardownEvidenceSha256: string;
  stagingTeardownInventoryDigest: string;
  stagingTeardownRecordedAt: string;
  soakAttestationPath: typeof MEASUREMENT_DURABLE_SOAK_ATTESTATION_PATH;
  soakAttestationSha256: string;
  soakLedgerSha256: string;
  soakStartedAt: string;
  soakRestartObservedAt: string;
  soakEndedAt: string;
  soakAttestedAt: string;
  targetDeviationApproval: DurableSoakTargetDeviationApproval | null;
  secretsCheckedAt: string;
  transitionMergedAt: string;
  ciCompletedAt: string;
  promotionConvergedAt: string;
  productionHealthObservedAt: string;
};

export type MeasurementDurableReplayVerificationRequest = {
  rootDir: string;
  deploymentCommit: string;
  leaseExpiryReceiptPath: string;
  lostResolveReceiptPath: string;
};

export type MeasurementOperatorEvidenceVerificationRequest = {
  rootDir: string;
  evidencePath: string;
};

export type MeasurementStagingTeardownProvenanceVerificationRequest = {
  rootDir: string;
  candidateCommit: string;
  carrierCommit: string;
  replayDeploymentCommit: string;
  subjectCommit: string;
  evidencePath: typeof MEASUREMENT_STAGING_TEARDOWN_EVIDENCE_PATH;
  evidenceSha256: string;
  archiveDirectory: string;
};

export type MeasurementDurableSoakProvenanceVerificationRequest = {
  rootDir: string;
  candidateCommit: string;
  carrierCommit: string;
  deploymentCommit: string;
  subjectCommit: string;
  evidencePath: typeof MEASUREMENT_DURABLE_SOAK_ATTESTATION_PATH;
  evidenceSha256: string;
  archiveDirectory: string;
  archiveEntries: Array<{
    path: string;
    sha256: string;
  }>;
};

export type MeasurementCandidateAttestationRequest = {
  subject:
    | "container-evidence"
    | "container-package-inventory"
    | "aa-producer-receipt"
    | "calibration-runtime-receipt";
  artifactPath: string;
  bundlePath: string;
  repository: string;
  signerWorkflow: string;
  certIdentity: string;
  signerDigest: string;
  sourceDigest: string;
  sourceRef: "refs/heads/main";
  denySelfHostedRunners: true;
  predicateType: "https://slsa.dev/provenance/v1";
  oidcIssuer: "https://token.actions.githubusercontent.com";
};

export type MeasurementCalibrationPolicyProfile = {
  id: typeof MEASUREMENT_CALIBRATION_CENSORING_POLICY_ID;
  policyArtifactPath: typeof MEASUREMENT_CALIBRATION_CENSORING_POLICY_PATH;
  policyArtifactSha256: string;
  dispositionSha256: string;
  anyCensoredCase: "study-ineligible";
  plannedDenominator: "must-remain-complete";
  ratePublicationEligibility: {
    sampling: "simple-random";
    independentUnits: true;
    predictionBlindedToReference: true;
    referenceBlindedToPrediction: true;
    minimumDenominators: {
      referencePresent: 100;
      referenceAbsent: 100;
      predictedDetected: 100;
      predictedNotDetected: 100;
    };
    uncertainty: {
      method: "wilson-score";
      confidenceLevel: 0.95;
      maximumWorstCaseHalfWidth: 0.1;
    };
    performanceThreshold: null;
  };
  decidedBy: string;
  decidedAt: string;
};

export type MeasurementFreezeReceiptVerificationRequest = {
  rootDir: string;
  receiptPath: string;
  candidateCommit: string;
};

export type InspectedMeasurementCandidateBinding = {
  candidateCommit: string;
  candidateTree: string;
  carrierCommit: string;
  acceptedProducerCommits: string[];
  evidenceIntroducedAt: Record<string, string>;
  evidenceIntroducedAtTime: Record<string, string>;
  durablePrerequisite: DurableEnableTransition;
  measurementInputs: {
    manifestPath: typeof MEASUREMENT_CANDIDATE_INPUTS_PATH;
    manifestSha256: string;
    domainSeparatedDigest: string;
    inputs: MeasurementCandidateInput[];
  };
  measurementIdentity: {
    manifestPath: typeof MEASUREMENT_IDENTITY_PATH;
    manifestSha256: string;
    domainSeparatedDigest: string;
    value: MeasurementIdentity;
  };
  calibrationPolicy: MeasurementCalibrationPolicyProfile;
  measurementRuntime: MeasurementRuntimeIdentity;
  bindingSha256: string;
  evidenceSetDigest: string;
  evidence: MeasurementEvidenceEntry[];
  calibrationStudies: MeasurementCalibrationStudy[];
  postCandidateAttestationVerifications: Array<
    MeasurementCandidateAttestationRequest & {
      evidencePath: string;
      producerCommit: string;
      status: "required-external-verification";
    }
  >;
  attestationVerifications: {
    containerEvidence: MeasurementCandidateAttestationRequest & {
      status: "required-external-verification";
    };
    containerPackageInventory: MeasurementCandidateAttestationRequest & {
      status: "required-external-verification";
    };
  };
};

export type VerifiedMeasurementCandidateBinding = Omit<
  InspectedMeasurementCandidateBinding,
  "attestationVerifications" | "postCandidateAttestationVerifications"
> & {
  attestationVerifications: {
    containerEvidence: MeasurementCandidateAttestationRequest & {
      status: "verified-by-gh-attestation";
    };
    containerPackageInventory: MeasurementCandidateAttestationRequest & {
      status: "verified-by-gh-attestation";
    };
  };
  postCandidateAttestationVerifications: Array<
    MeasurementCandidateAttestationRequest & {
      evidencePath: string;
      producerCommit: string;
      status: "verified-by-gh-attestation";
    }
  >;
};

export type MeasurementCandidateBuildProjection = {
  candidateCommit: string;
  carrierCommit: string;
  bindingSha256: string;
  evidenceSetDigest: string;
  calibrationStudies: MeasurementCalibrationStudy[];
  verification: "trusted-host-projection";
};

export type MeasurementCandidateBuildProof = {
  proofVersion: 1;
  candidateCommit: string;
  candidateTree: string;
  carrierCommit: string;
  bindingSha256: string;
  evidenceSetDigest: string;
};

export type MeasurementCandidateBindingOptions = {
  expectedRepository?: string;
  expectedTargetRelease?: string;
  requireCleanWorktree?: boolean;
  /**
   * Lean-scope seam. The release evaluator passes false only while the
   * detector-calibration gate is recorded as deferred in
   * RELEASE_READINESS.json; bound studies are fully verified either way, and
   * omitting the option keeps the non-empty floor.
   */
  requireCalibrationStudies?: boolean;
  /**
   * Test seam only. Production callers omit this so the installed `gh`
   * verifier is mandatory. A callback must throw on any failed verification.
   */
  attestationVerifier?: (request: MeasurementCandidateAttestationRequest) => void;
  /** Test seam for the canonical measurement-freeze receipt parser. */
  freezeReceiptVerifier?: (request: MeasurementFreezeReceiptVerificationRequest) => void;
  /**
   * Trusted offline GitHub artifact context. Release preparation supplies this
   * explicitly so candidate verification never depends on inherited token or
   * process-environment state.
   */
  freezeArtifactContext?: {
    directory: string;
    sha256: string;
  };
  /** Test seam for the canonical durable replay receipt-set parser. */
  durableReplayVerifier?: (
    request: MeasurementDurableReplayVerificationRequest
  ) => void;
  /** Test seam for the canonical operator-evidence parser. */
  operatorEvidenceVerifier?: (
    request: MeasurementOperatorEvidenceVerificationRequest
  ) => void;
  /**
   * Test seam for the dedicated GitHub-hosted provider-capture archive.
   * Production callers omit this: a local receipt and local parser are not
   * evidence that the provider observations happened.
   */
  stagingTeardownProvenanceVerifier?: (
    request: MeasurementStagingTeardownProvenanceVerificationRequest
  ) => void;
  /**
   * Test seam for the authenticated durable-soak hosted archive. Production
   * callers omit this so canonical archive and Sigstore verification remain
   * mandatory.
   */
  durableSoakProvenanceVerifier?: (
    request: MeasurementDurableSoakProvenanceVerificationRequest
  ) => void;
  /**
   * Test seam for the live, append-only calibration ceremony verifier.
   * Production callers omit this so GitHub is re-enumerated for competing
   * roster authorizations, cloned acquisitions, and rerun attempts.
   */
  calibrationCeremonyVerifier?: (
    request: MeasurementCalibrationCeremonyVerificationRequest
  ) => void;
};

export type MeasurementCalibrationCeremonyVerificationRequest = {
  rootDir: string;
  repository: typeof MEASUREMENT_CANDIDATE_REPOSITORY;
  studyId: string;
  candidateCommit: string;
  labelRosterAuthorizationPath: string;
  labelRosterAuthorizationSha256: string;
  rosterSelectionLedgerPath: string;
  rosterSelectionLedgerSha256: string;
  acquisitionAttemptLedgerPath: string;
  acquisitionAttemptLedgerSha256: string;
};

export function measurementCalibrationAnalysisPolicyProblems(
  analysis: DetectorCalibrationAnalysis,
  policy: MeasurementCalibrationPolicyProfile
): string[] {
  const problems: string[] = [];
  if (
    analysis.status !== "sample-estimate" ||
    analysis.uncertainty.method !== "wilson-score-95" ||
    analysis.inference.conditionalTargetPopulationRateClaimAllowed !== true ||
    analysis.inference.measurementCondition === null ||
    typeof analysis.inference.conditionalRateClaim !== "string" ||
    analysis.inference.conditionalRateClaim.length === 0
  ) {
    problems.push(
      "study must be a release-bound v2 simple-random, independent, blinded sample estimate with an exact fixed measurement condition, explicit conditional claim, and Wilson 95% intervals"
    );
  }
  for (const field of [
    "referencePresent",
    "referenceAbsent",
    "predictedDetected",
    "predictedNotDetected"
  ] as const) {
    const minimum = policy.ratePublicationEligibility.minimumDenominators[field];
    if (analysis.denominators[field] < minimum) {
      problems.push(
        `${field} denominator ${analysis.denominators[field]} is below the policy minimum ${minimum}`
      );
    }
  }
  if (analysis.rates === null) {
    problems.push("study does not expose recomputed calibration rates");
  } else {
    for (const [rateId, rate] of Object.entries(analysis.rates)) {
      const interval = rate.interval95;
      if (
        interval === null ||
        interval.method !==
          policy.ratePublicationEligibility.uncertainty.method ||
        (interval.upper - interval.lower) / 2 >
          policy.ratePublicationEligibility.uncertainty
            .maximumWorstCaseHalfWidth +
            Number.EPSILON
      ) {
        problems.push(
          `${rateId} does not meet the policy's Wilson 95% maximum half-width`
        );
      }
    }
  }
  return problems;
}

type JsonRecord = Record<string, unknown>;

type MeasurementPostCandidateProducerReceipt = {
  evidencePath: string;
  pairedEvidencePaths: string[];
  producerCommit: string;
  causalProducerCommits: string[];
  causalEvidencePaths: string[];
  collectionStartedAt: string;
  collectionCompletedAt: string;
  artifactCreatedAt: string;
  attestationRequest: MeasurementCandidateAttestationRequest;
};

type ParsedBindingFiles = {
  candidateCommit: string;
  candidateTree: string;
  evidence: MeasurementEvidenceEntry[];
  calibrationStudies: MeasurementCalibrationStudy[];
  attestationRequest: MeasurementCandidateAttestationRequest;
  packageAttestationRequest: MeasurementCandidateAttestationRequest;
  postCandidateProducerReceipts: MeasurementPostCandidateProducerReceipt[];
  bindingSha256: string;
  evidenceSetDigest: string;
  measurementInputs: {
    manifestPath: typeof MEASUREMENT_CANDIDATE_INPUTS_PATH;
    manifestSha256: string;
    domainSeparatedDigest: string;
    inputs: MeasurementCandidateInput[];
  };
  measurementIdentity: {
    manifestPath: typeof MEASUREMENT_IDENTITY_PATH;
    manifestSha256: string;
    domainSeparatedDigest: string;
    value: MeasurementIdentity;
  };
  calibrationPolicy: MeasurementCalibrationPolicyProfile;
  measurementRuntime: MeasurementRuntimeIdentity;
  durablePrerequisite: DurableEnableTransition;
  enumeratedPaths: Map<
    string,
    {
      change: MeasurementEvidenceChange;
      sha256: string;
    }
  >;
};

const EVIDENCE_PATH_POLICIES: Readonly<
  Record<
    MeasurementEvidenceCategory,
    {
      pattern: RegExp;
      allowedChange: MeasurementEvidenceChange;
    }
  >
> = Object.freeze({
  "featured-report": {
    pattern: new RegExp(`^public/reports/${REPORT_ID}\\.json$`),
    allowedChange: "added"
  },
  "featured-provenance": {
    pattern: new RegExp(`^public/reports/${REPORT_ID}\\.provenance\\.json$`),
    allowedChange: "added"
  },
  "generated-report-index": {
    pattern: /^public\/reports\/index\.json$/,
    allowedChange: "generated-update"
  },
  "generated-corpus-stats": {
    pattern: /^public\/corpus-stats\.json$/,
    allowedChange: "generated-update"
  },
  "runner-receipt": {
    pattern: /^research\/runner-receipts\/[1-9][0-9]{0,19}\.json$/,
    allowedChange: "added"
  },
  "controlled-publication-manifest": {
    pattern:
      /^research\/controlled-publications\/[1-9][0-9]{0,19}-[1-9][0-9]{0,2}\/publication\.json$/,
    allowedChange: "added"
  },
  "controlled-publication-receipt": {
    pattern:
      /^research\/controlled-publications\/[1-9][0-9]{0,19}-[1-9][0-9]{0,2}\/receipt\.json$/,
    allowedChange: "added"
  },
  "aa-attempt-ledger": {
    pattern: new RegExp(`^research/aa-studies/${TOKEN}/attempt-ledger\\.json$`),
    allowedChange: "added"
  },
  "aa-evaluation": {
    pattern: new RegExp(`^research/aa-studies/${TOKEN}/evaluation\\.json$`),
    allowedChange: "added"
  },
  "aa-producer-receipt": {
    pattern: new RegExp(
      `^research/aa-studies/${TOKEN}/producer-receipt\\.json$`
    ),
    allowedChange: "added"
  },
  "aa-producer-attestation": {
    pattern: new RegExp(
      `^research/aa-studies/${TOKEN}/producer-receipt\\.sigstore\\.json$`
    ),
    allowedChange: "added"
  },
  "calibration-label-coordinate": {
    pattern: new RegExp(
      `^calibration-labels/${TOKEN}/sources\\.json$`
    ),
    allowedChange: "added"
  },
  "measurement-freeze-receipt": {
    pattern: /^research\/ops-receipts\/measurement-freeze-activation\.json$/,
    allowedChange: "added"
  },
  "lifecycle-receipt": {
    pattern: /^research\/ops-receipts\/r2-lifecycle-readback\.json$/,
    allowedChange: "refreshed"
  },
  "operator-attestation": {
    pattern:
      /^research\/ops-receipts\/(?:egress-backstop|waf-ceilings|log-retention|container-image-licensing)-attestation\.json$/,
    allowedChange: "added"
  },
  "operator-evidence": {
    pattern:
      /^research\/ops-evidence\/(?:egress-backstop|waf-ceilings|log-retention|container-image-licensing)\.json$/,
    allowedChange: "added"
  },
  "hosted-evidence-archive": {
    pattern:
      /^research\/hosted-evidence\/(?:controlled-publication|runner-destruction|durable-transition|durable-soak|staging-teardown|lifecycle|waf-ceilings)\/[0-9a-f]{64}\/(?:context\.json|context\.sigstore\.json|subject\.json|sources\/(?:0[0-9]|[1-9][0-9])-[a-z0-9][a-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,99})*)$/,
    allowedChange: "added"
  },
  "release-policy-finalization": {
    pattern: /^release-policy\.json$/,
    allowedChange: "release-finalization"
  },
  "citation-finalization": {
    pattern: /^CITATION\.cff$/,
    allowedChange: "release-finalization"
  },
  "changelog-finalization": {
    pattern: /^CHANGELOG\.md$/,
    allowedChange: "release-finalization"
  }
});

/**
 * Structurally inspect the binding and C..S Git history.
 *
 * This deliberately returns `required-external-verification`, never
 * "verified". Release readiness must call verifiedMeasurementCandidateBinding.
 */
export function inspectMeasurementCandidateBinding(
  rootDir: string = process.cwd(),
  options: Omit<MeasurementCandidateBindingOptions, "attestationVerifier"> = {}
): InspectedMeasurementCandidateBinding | null {
  return inspectMeasurementCandidateBindingInternal(
    rootDir,
    options,
    options.requireCalibrationStudies !== false
  );
}

function inspectMeasurementCandidateBindingInternal(
  rootDir: string,
  options: Omit<MeasurementCandidateBindingOptions, "attestationVerifier">,
  requireCalibrationStudies: boolean
): InspectedMeasurementCandidateBinding | null {
  const bindingAbsolute = absoluteRepoPath(rootDir, MEASUREMENT_CANDIDATE_BINDING_PATH);
  if (!existsSync(bindingAbsolute)) return null;

  const expectedRepository = options.expectedRepository ?? MEASUREMENT_CANDIDATE_REPOSITORY;
  const expectedTargetRelease = options.expectedTargetRelease ?? MEASUREMENT_CANDIDATE_TARGET_RELEASE;
  const parsed = parseBindingFiles(
    rootDir,
    expectedRepository,
    expectedTargetRelease,
    options.freezeReceiptVerifier ??
      ((request) =>
        verifyMeasurementFreezeReceiptWithCanonicalCli(
          request,
          options.freezeArtifactContext
        )),
    options.durableReplayVerifier,
    options.operatorEvidenceVerifier,
    options.stagingTeardownProvenanceVerifier,
    requireCalibrationStudies,
    true,
    options.durableSoakProvenanceVerifier
  );
  const carrierCommit = git(rootDir, ["rev-parse", "--verify", "HEAD"]).trim().toLowerCase();
  requireValue(FULL_GIT_SHA.test(carrierCommit), "measurement evidence carrier HEAD must be a full Git SHA");
  if (parsed.durablePrerequisite.targetDeviationApproval !== null) {
    const carrierCommittedAt = git(
      rootDir,
      ["show", "-s", "--format=%cI", carrierCommit]
    ).trim();
    requireValue(
      Date.parse(
        parsed.durablePrerequisite.targetDeviationApproval.approvedAt
      ) <=
        Date.parse(carrierCommittedAt) +
          GIT_TIMESTAMP_PRECISION_SKEW_MS,
      "durable soak target deviation approval postdates its evidence carrier"
    );
  }
  requireGitCommit(rootDir, parsed.candidateCommit);
  requireValue(
    gitExit(rootDir, ["merge-base", "--is-ancestor", parsed.candidateCommit, carrierCommit]) === 0,
    `measurement candidate ${parsed.candidateCommit} must be an ancestor of evidence carrier ${carrierCommit}`
  );
  const resolvedTree = git(rootDir, [
    "rev-parse",
    "--verify",
    `${parsed.candidateCommit}^{tree}`
  ])
    .trim()
    .toLowerCase();
  requireValue(resolvedTree === parsed.candidateTree, "measurement candidate tree does not match candidateCommit");
  if (options.requireCleanWorktree ?? true) {
    const dirty = git(rootDir, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--ignore-submodules=none"
    ]);
    requireValue(dirty.length === 0, "measurement candidate binding requires a clean worktree");
  }

  const historyProof = verifyCandidateCarrierDiff(
    rootDir,
    parsed.candidateCommit,
    carrierCommit,
    parsed.enumeratedPaths
  );
  for (const receipt of parsed.postCandidateProducerReceipts) {
    for (const producerCommit of receipt.causalProducerCommits) {
      for (const evidencePath of receipt.causalEvidencePaths) {
        requireValue(
          measurementCandidateAcceptsProducerForEvidencePath(
            historyProof,
            producerCommit,
            evidencePath
          ),
          `${evidencePath} producer ${producerCommit} must strictly predate its evidence introduction`
        );
      }
    }
  }
  for (const study of parsed.calibrationStudies) {
    requireValue(
      measurementCandidateEvidenceTimestampIsCausal(
        historyProof,
        study.runtimeReceiptPath,
        study.runtimeReceiptRecordedAt
      ),
      `${study.runtimeReceiptPath} recordedAt must not postdate its introducing commit`
    );
  }

  return {
    candidateCommit: parsed.candidateCommit,
    candidateTree: parsed.candidateTree,
    carrierCommit,
    acceptedProducerCommits: historyProof.acceptedProducerCommits,
    evidenceIntroducedAt: historyProof.evidenceIntroducedAt,
    evidenceIntroducedAtTime: historyProof.evidenceIntroducedAtTime,
    durablePrerequisite: parsed.durablePrerequisite,
    measurementInputs: parsed.measurementInputs,
    measurementIdentity: parsed.measurementIdentity,
    measurementRuntime: parsed.measurementRuntime,
    calibrationPolicy: parsed.calibrationPolicy,
    bindingSha256: parsed.bindingSha256,
    evidenceSetDigest: parsed.evidenceSetDigest,
    evidence: parsed.evidence,
    calibrationStudies: parsed.calibrationStudies,
    postCandidateAttestationVerifications:
      parsed.postCandidateProducerReceipts.map((receipt) => ({
        ...receipt.attestationRequest,
        evidencePath: receipt.evidencePath,
        producerCommit: receipt.producerCommit,
        status: "required-external-verification" as const
      })),
    attestationVerifications: {
      containerEvidence: {
        ...parsed.attestationRequest,
        status: "required-external-verification"
      },
      containerPackageInventory: {
        ...parsed.packageAttestationRequest,
        status: "required-external-verification"
      }
    }
  };
}

/**
 * The release/readiness authority: structural Git proof plus real Sigstore
 * verification. A missing `gh`, invalid bundle, wrong signer/source, or an
 * unverifiable signature throws and therefore leaves readiness red.
 */
export function verifiedMeasurementCandidateBinding(
  rootDir: string = process.cwd(),
  options: MeasurementCandidateBindingOptions = {}
): VerifiedMeasurementCandidateBinding | null {
  const inspected = inspectMeasurementCandidateBinding(rootDir, options);
  if (!inspected) return null;
  requireCalibrationStudyPolicyAdequacy(inspected.calibrationStudies);
  const containerRequest = attestationRequest(
    inspected.attestationVerifications.containerEvidence
  );
  const packageRequest = attestationRequest(
    inspected.attestationVerifications.containerPackageInventory
  );
  const verifier =
    options.attestationVerifier ??
    ((request: MeasurementCandidateAttestationRequest) =>
      verifyAttestationWithGh(request, rootDir));
  verifier(containerRequest);
  verifier(packageRequest);
  const postCandidateRequests =
    inspected.postCandidateAttestationVerifications.map((request) =>
      attestationRequest(request)
    );
  for (const request of postCandidateRequests) verifier(request);
  const calibrationCeremonyVerifier =
    options.calibrationCeremonyVerifier ??
    verifyCalibrationCeremonyWithCanonicalCli;
  for (const study of inspected.calibrationStudies) {
    calibrationCeremonyVerifier({
      rootDir,
      repository: MEASUREMENT_CANDIDATE_REPOSITORY,
      studyId: study.studyId,
      candidateCommit: inspected.candidateCommit,
      labelRosterAuthorizationPath:
        study.labelRosterAuthorizationPath,
      labelRosterAuthorizationSha256:
        study.labelRosterAuthorizationSha256,
      rosterSelectionLedgerPath: study.rosterSelectionLedgerPath,
      rosterSelectionLedgerSha256: study.rosterSelectionLedgerSha256,
      acquisitionAttemptLedgerPath:
        study.acquisitionAttemptLedgerPath,
      acquisitionAttemptLedgerSha256:
        study.acquisitionAttemptLedgerSha256
    });
  }
  return {
    candidateCommit: inspected.candidateCommit,
    candidateTree: inspected.candidateTree,
    carrierCommit: inspected.carrierCommit,
    acceptedProducerCommits: inspected.acceptedProducerCommits,
    evidenceIntroducedAt: inspected.evidenceIntroducedAt,
    evidenceIntroducedAtTime: inspected.evidenceIntroducedAtTime,
    durablePrerequisite: inspected.durablePrerequisite,
    measurementInputs: inspected.measurementInputs,
    measurementIdentity: inspected.measurementIdentity,
    measurementRuntime: inspected.measurementRuntime,
    calibrationPolicy: inspected.calibrationPolicy,
    bindingSha256: inspected.bindingSha256,
    evidenceSetDigest: inspected.evidenceSetDigest,
    evidence: inspected.evidence,
    calibrationStudies: inspected.calibrationStudies,
    postCandidateAttestationVerifications:
      postCandidateRequests.map((request, index) => ({
        ...request,
        evidencePath:
          inspected.postCandidateAttestationVerifications[index].evidencePath,
        producerCommit:
          inspected.postCandidateAttestationVerifications[index].producerCommit,
        status: "verified-by-gh-attestation" as const
      })),
    attestationVerifications: {
      containerEvidence: {
        ...containerRequest,
        status: "verified-by-gh-attestation"
      },
      containerPackageInventory: {
        ...packageRequest,
        status: "verified-by-gh-attestation"
      }
    }
  };
}

/**
 * Trusted acquisition preflight for the first calibration study.
 *
 * It performs the same candidate/history/Sigstore verification as release
 * readiness but permits the binding's calibrationStudies array to be empty.
 * No other evidence or identity requirement is relaxed. Release/build callers
 * must use verifiedMeasurementCandidateBinding, whose non-empty floor is
 * governed by the requireCalibrationStudies option.
 */
export function verifiedMeasurementCandidateAcquisitionContext(
  rootDir: string = process.cwd(),
  options: MeasurementCandidateBindingOptions = {}
): VerifiedMeasurementCandidateBinding | null {
  const inspected = inspectMeasurementCandidateBindingInternal(
    rootDir,
    options,
    false
  );
  if (!inspected) return null;
  requireCalibrationStudyPolicyAdequacy(inspected.calibrationStudies);
  const containerRequest = attestationRequest(
    inspected.attestationVerifications.containerEvidence
  );
  const packageRequest = attestationRequest(
    inspected.attestationVerifications.containerPackageInventory
  );
  const verifier =
    options.attestationVerifier ??
    ((request: MeasurementCandidateAttestationRequest) =>
      verifyAttestationWithGh(request, rootDir));
  verifier(containerRequest);
  verifier(packageRequest);
  const postCandidateRequests =
    inspected.postCandidateAttestationVerifications.map((request) =>
      attestationRequest(request)
    );
  for (const request of postCandidateRequests) verifier(request);
  const calibrationCeremonyVerifier =
    options.calibrationCeremonyVerifier ??
    verifyCalibrationCeremonyWithCanonicalCli;
  for (const study of inspected.calibrationStudies) {
    calibrationCeremonyVerifier({
      rootDir,
      repository: MEASUREMENT_CANDIDATE_REPOSITORY,
      studyId: study.studyId,
      candidateCommit: inspected.candidateCommit,
      labelRosterAuthorizationPath:
        study.labelRosterAuthorizationPath,
      labelRosterAuthorizationSha256:
        study.labelRosterAuthorizationSha256,
      rosterSelectionLedgerPath: study.rosterSelectionLedgerPath,
      rosterSelectionLedgerSha256: study.rosterSelectionLedgerSha256,
      acquisitionAttemptLedgerPath:
        study.acquisitionAttemptLedgerPath,
      acquisitionAttemptLedgerSha256:
        study.acquisitionAttemptLedgerSha256
    });
  }
  return {
    ...inspected,
    postCandidateAttestationVerifications:
      postCandidateRequests.map((request, index) => ({
        ...request,
        evidencePath:
          inspected.postCandidateAttestationVerifications[index].evidencePath,
        producerCommit:
          inspected.postCandidateAttestationVerifications[index].producerCommit,
        status: "verified-by-gh-attestation" as const
      })),
    attestationVerifications: {
      containerEvidence: {
        ...containerRequest,
        status: "verified-by-gh-attestation"
      },
      containerPackageInventory: {
        ...packageRequest,
        status: "verified-by-gh-attestation"
      }
    }
  };
}

function requireCalibrationStudyPolicyAdequacy(
  studies: MeasurementCalibrationStudy[]
): void {
  for (const study of studies) {
    requireValue(
      study.analysisPolicyProblems.length === 0,
      `${study.studyId} does not satisfy the candidate calibration publication policy: ${study.analysisPolicyProblems.join("; ")}`
    );
  }
}

/** Serialize the exact result a trusted host precheck hands to a Git-less build. */
export function verifiedMeasurementCandidateBuildProof(
  binding: VerifiedMeasurementCandidateBinding
): string {
  const proof: MeasurementCandidateBuildProof = {
    proofVersion: 1,
    candidateCommit: binding.candidateCommit,
    candidateTree: binding.candidateTree,
    carrierCommit: binding.carrierCommit,
    bindingSha256: binding.bindingSha256,
    evidenceSetDigest: binding.evidenceSetDigest
  };
  return Buffer.from(JSON.stringify(proof), "utf8").toString("base64url");
}

/** Cross-binding helper for runner, A/A, durable, and report producer receipts. */
export function measurementCandidateAcceptsProducerCommit(
  binding: Pick<InspectedMeasurementCandidateBinding, "acceptedProducerCommits">,
  commit: string
): boolean {
  return FULL_GIT_SHA.test(commit) && binding.acceptedProducerCommits.includes(commit);
}

/**
 * Causal producer check for append-only acquired evidence.
 *
 * Evidence PRs are created after a trusted run finishes, so a truthful
 * producer commit must be C or an accepted evidence-only S_i strictly before
 * the commit that first adds the retained artifact. Membership by itself would
 * allow an early receipt to claim a future carrier SHA.
 */
export function measurementCandidateAcceptsProducerForEvidencePath(
  binding: Pick<
    InspectedMeasurementCandidateBinding,
    "acceptedProducerCommits" | "evidenceIntroducedAt"
  >,
  commit: string,
  evidencePath: string
): boolean {
  if (!FULL_GIT_SHA.test(commit)) return false;
  const producerIndex = binding.acceptedProducerCommits.indexOf(commit);
  const introduction = binding.evidenceIntroducedAt[evidencePath];
  const introductionIndex = introduction
    ? binding.acceptedProducerCommits.indexOf(introduction)
    : -1;
  return producerIndex >= 0 && introductionIndex > producerIndex;
}

/** Compare an acquisition timestamp with the immutable introducing commit. */
export function measurementCandidateEvidenceTimestampIsCausal(
  binding: Pick<
    InspectedMeasurementCandidateBinding,
    "evidenceIntroducedAtTime"
  >,
  evidencePath: string,
  timestamp: string
): boolean {
  const introducedAt = binding.evidenceIntroducedAtTime[evidencePath];
  return (
    typeof introducedAt === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(timestamp) &&
    Number.isFinite(Date.parse(timestamp)) &&
    new Date(Date.parse(timestamp)).toISOString() === timestamp &&
    Date.parse(timestamp) <= Date.parse(introducedAt)
  );
}

/**
 * Hostless build seam for Docker/Pages.
 *
 * It is intentionally not a release verifier. The dedicated proof must be the
 * output of verifiedMeasurementCandidateBuildProof in the trusted host precheck.
 * The ordinary build-provenance variable is never consulted. If Git metadata
 * is present, callers must use the host verifier instead of this projection.
 */
export function measurementCandidateBuildProjection(
  rootDir: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
  options: Pick<MeasurementCandidateBindingOptions, "freezeReceiptVerifier"> = {}
): MeasurementCandidateBuildProjection | null {
  const bindingAbsolute = absoluteRepoPath(rootDir, MEASUREMENT_CANDIDATE_BINDING_PATH);
  const encodedProof =
    env[VERIFIED_MEASUREMENT_CANDIDATE_PROOF_ENV]?.trim() ?? "";
  if (!existsSync(bindingAbsolute)) {
    requireValue(
      encodedProof.length === 0,
      `${VERIFIED_MEASUREMENT_CANDIDATE_PROOF_ENV} is set but no measurement candidate binding exists`
    );
    return null;
  }
  const proof = parseMeasurementCandidateBuildProof(encodedProof);
  const carrierCommit =
    env.SITE_BEHAVIOR_LAB_BUILD_COMMIT?.trim().toLowerCase() ?? "";
  requireValue(
    FULL_GIT_SHA.test(carrierCommit) &&
      proof.carrierCommit === carrierCommit,
    `${VERIFIED_MEASUREMENT_CANDIDATE_PROOF_ENV} carrier must match SITE_BEHAVIOR_LAB_BUILD_COMMIT`
  );
  requireValue(
    !gitMetadataAvailable(rootDir),
    "build projection is hostless-only; use verifiedMeasurementCandidateBinding when Git metadata is available"
  );
  const parsed = parseBindingFiles(
    rootDir,
    MEASUREMENT_CANDIDATE_REPOSITORY,
    MEASUREMENT_CANDIDATE_TARGET_RELEASE,
    options.freezeReceiptVerifier,
    undefined,
    undefined,
    undefined,
    true,
    false
  );
  requireValue(
    proof.candidateCommit === parsed.candidateCommit &&
      proof.candidateTree === parsed.candidateTree &&
      proof.bindingSha256 === parsed.bindingSha256 &&
      proof.evidenceSetDigest === parsed.evidenceSetDigest,
    `${VERIFIED_MEASUREMENT_CANDIDATE_PROOF_ENV} does not match the committed candidate evidence`
  );
  requireCalibrationStudyPolicyAdequacy(parsed.calibrationStudies);
  return {
    candidateCommit: parsed.candidateCommit,
    carrierCommit,
    bindingSha256: parsed.bindingSha256,
    evidenceSetDigest: parsed.evidenceSetDigest,
    calibrationStudies: parsed.calibrationStudies,
    verification: "trusted-host-projection"
  };
}

/** True only when this checkout can prove history, not merely run Git. */
export function gitMetadataAvailable(rootDir: string = process.cwd()): boolean {
  const result = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd: rootDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  });
  return result.status === 0 && result.stdout.trim() === "true";
}

/** Exact argv used by the host verifier, exposed for workflow-contract tests. */
export function measurementCandidateAttestationVerifyArgs(
  request: MeasurementCandidateAttestationRequest
): string[] {
  return [
    "attestation",
    "verify",
    request.artifactPath,
    "--bundle",
    request.bundlePath,
    "--repo",
    request.repository,
    "--cert-identity",
    request.certIdentity,
    "--signer-digest",
    request.signerDigest,
    "--source-digest",
    request.sourceDigest,
    "--source-ref",
    request.sourceRef,
    "--predicate-type",
    request.predicateType,
    "--cert-oidc-issuer",
    request.oidcIssuer,
    "--deny-self-hosted-runners",
    "--format",
    "json"
  ];
}

function parseMeasurementCandidateBuildProof(encoded: string): MeasurementCandidateBuildProof {
  requireValue(
    encoded.length > 0 && encoded.length <= 4096 && /^[A-Za-z0-9_-]+$/.test(encoded),
    `${VERIFIED_MEASUREMENT_CANDIDATE_PROOF_ENV} must be one bounded base64url proof`
  );
  let decoded: string;
  try {
    decoded = Buffer.from(encoded, "base64url").toString("utf8");
  } catch {
    throw new Error(`${VERIFIED_MEASUREMENT_CANDIDATE_PROOF_ENV} is not valid base64url`);
  }
  requireValue(
    Buffer.from(decoded, "utf8").toString("base64url") === encoded,
    `${VERIFIED_MEASUREMENT_CANDIDATE_PROOF_ENV} is not canonical base64url`
  );
  const value = readJsonTextObject(decoded, "measurement candidate build proof");
  requireExactOrderedKeys(
    value,
    [
      "proofVersion",
      "candidateCommit",
      "candidateTree",
      "carrierCommit",
      "bindingSha256",
      "evidenceSetDigest"
    ],
    "measurement candidate build proof"
  );
  requireValue(value.proofVersion === 1, "measurement candidate build proofVersion must be 1");
  const candidateCommit = requiredPattern(
    value.candidateCommit,
    FULL_GIT_SHA,
    "measurement candidate build proof candidateCommit"
  );
  const candidateTree = requiredPattern(
    value.candidateTree,
    FULL_GIT_SHA,
    "measurement candidate build proof candidateTree"
  );
  const carrierCommit = requiredPattern(
    value.carrierCommit,
    FULL_GIT_SHA,
    "measurement candidate build proof carrierCommit"
  );
  const bindingSha256 = requiredPattern(
    value.bindingSha256,
    SHA256,
    "measurement candidate build proof bindingSha256"
  );
  const evidenceSetDigest = requiredPattern(
    value.evidenceSetDigest,
    SHA256,
    "measurement candidate build proof evidenceSetDigest"
  );
  return {
    proofVersion: 1,
    candidateCommit,
    candidateTree,
    carrierCommit,
    bindingSha256,
    evidenceSetDigest
  };
}

function parseBindingFiles(
  rootDir: string,
  expectedRepository: string,
  expectedTargetRelease: string,
  freezeReceiptVerifier:
    | ((request: MeasurementFreezeReceiptVerificationRequest) => void)
    | undefined,
  durableReplayVerifier:
    | ((request: MeasurementDurableReplayVerificationRequest) => void)
    | undefined,
  operatorEvidenceVerifier:
    | ((request: MeasurementOperatorEvidenceVerificationRequest) => void)
    | undefined,
  stagingTeardownProvenanceVerifier:
    | ((
        request: MeasurementStagingTeardownProvenanceVerificationRequest
      ) => void)
    | undefined,
  requireCalibrationStudies: boolean = true,
  verifyCandidateFinalization: boolean = true,
  durableSoakProvenanceVerifier:
    | ((
        request: MeasurementDurableSoakProvenanceVerificationRequest
      ) => void)
    | undefined = undefined
): ParsedBindingFiles {
  const bindingAbsolute = regularFileInside(
    rootDir,
    MEASUREMENT_CANDIDATE_BINDING_PATH,
    "measurement candidate binding"
  );
  const binding = readJsonObject(bindingAbsolute, "measurement candidate binding");
  requireExactKeys(
    binding,
    [
      "schemaVersion",
      "artifactKind",
      "repository",
      "targetRelease",
      "candidateCommit",
      "candidateTree",
      "measurementInputs",
      "measurementIdentity",
      "calibrationPolicy",
      "durablePrerequisite",
      "sourceEvidence",
      "attestationPolicy",
      "evidence",
      "calibrationStudies"
    ],
    "measurement candidate binding"
  );
  requireValue(
    binding.schemaVersion === MEASUREMENT_CANDIDATE_BINDING_VERSION,
    `measurement candidate binding schemaVersion must be ${MEASUREMENT_CANDIDATE_BINDING_VERSION}`
  );
  requireValue(
    binding.artifactKind === MEASUREMENT_CANDIDATE_BINDING_KIND,
    `measurement candidate binding artifactKind must be ${MEASUREMENT_CANDIDATE_BINDING_KIND}`
  );
  requireValue(
    binding.repository === expectedRepository,
    `measurement candidate binding repository must be ${expectedRepository}`
  );
  requireValue(
    binding.targetRelease === expectedTargetRelease,
    `measurement candidate binding targetRelease must be ${expectedTargetRelease}`
  );

  const candidateCommit = requiredPattern(binding.candidateCommit, FULL_GIT_SHA, "candidateCommit");
  const candidateTree = requiredPattern(binding.candidateTree, FULL_GIT_SHA, "candidateTree");
  const enumeratedPaths = new Map<
    string,
    {
      change: MeasurementEvidenceChange;
      sha256: string;
    }
  >();

  const measurementInputs = verifyMeasurementCandidateInputs(
    rootDir,
    candidateCommit,
    requiredRecord(binding.measurementInputs, "measurementInputs"),
    verifyCandidateFinalization
  );
  const measurementInputByPath = new Map(
    measurementInputs.inputs.map((entry) => [entry.path, entry.sha256] as const)
  );
  const measurementIdentity = verifyMeasurementIdentity(
    rootDir,
    candidateCommit,
    requiredRecord(binding.measurementIdentity, "measurementIdentity"),
    verifyCandidateFinalization
  );
  requireValue(
    measurementInputByPath.get(MEASUREMENT_IDENTITY_PATH) ===
      measurementIdentity.manifestSha256,
    "measurement identity must be digest-bound by the candidate inputs manifest"
  );
  const calibrationPolicy = verifyCalibrationPolicyDecision(
    rootDir,
    candidateCommit,
    requiredRecord(binding.calibrationPolicy, "calibrationPolicy"),
    measurementInputByPath,
    verifyCandidateFinalization
  );
  const durablePrerequisite = verifyDurablePrerequisite(
    rootDir,
    candidateCommit,
    requiredRecord(binding.durablePrerequisite, "durablePrerequisite"),
    verifyCandidateFinalization,
    durableReplayVerifier,
    operatorEvidenceVerifier,
    stagingTeardownProvenanceVerifier
  );

  const sourceEvidence = requiredRecord(binding.sourceEvidence, "sourceEvidence");
  requireExactKeys(
    sourceEvidence,
    [
      "manifestPath",
      "manifestSha256",
      "bundlePath",
      "bundleSha256",
      "packageInventoryPath",
      "packageInventorySha256",
      "packageBundlePath",
      "packageBundleSha256",
      "packageReviewLedgerPath",
      "packageReviewLedgerSha256",
      "packageLegalEvidence"
    ],
    "sourceEvidence"
  );
  requireValue(
    sourceEvidence.manifestPath === MEASUREMENT_CANDIDATE_SOURCE_EVIDENCE_PATH,
    `sourceEvidence.manifestPath must be ${MEASUREMENT_CANDIDATE_SOURCE_EVIDENCE_PATH}`
  );
  requireValue(
    sourceEvidence.bundlePath === MEASUREMENT_CANDIDATE_ATTESTATION_BUNDLE_PATH,
    `sourceEvidence.bundlePath must be ${MEASUREMENT_CANDIDATE_ATTESTATION_BUNDLE_PATH}`
  );
  requireValue(
    sourceEvidence.packageInventoryPath === MEASUREMENT_CANDIDATE_PACKAGE_INVENTORY_PATH,
    `sourceEvidence.packageInventoryPath must be ${MEASUREMENT_CANDIDATE_PACKAGE_INVENTORY_PATH}`
  );
  requireValue(
    sourceEvidence.packageBundlePath ===
      MEASUREMENT_CANDIDATE_PACKAGE_ATTESTATION_BUNDLE_PATH,
    `sourceEvidence.packageBundlePath must be ${MEASUREMENT_CANDIDATE_PACKAGE_ATTESTATION_BUNDLE_PATH}`
  );
  requireValue(
    sourceEvidence.packageReviewLedgerPath ===
      MEASUREMENT_CANDIDATE_PACKAGE_REVIEW_LEDGER_PATH,
    `sourceEvidence.packageReviewLedgerPath must be ${MEASUREMENT_CANDIDATE_PACKAGE_REVIEW_LEDGER_PATH}`
  );
  const manifestSha256 = requiredPattern(
    sourceEvidence.manifestSha256,
    SHA256,
    "sourceEvidence.manifestSha256"
  );
  const bundleSha256 = requiredPattern(
    sourceEvidence.bundleSha256,
    SHA256,
    "sourceEvidence.bundleSha256"
  );
  const packageInventorySha256 = requiredPattern(
    sourceEvidence.packageInventorySha256,
    SHA256,
    "sourceEvidence.packageInventorySha256"
  );
  const packageBundleSha256 = requiredPattern(
    sourceEvidence.packageBundleSha256,
    SHA256,
    "sourceEvidence.packageBundleSha256"
  );
  const packageReviewLedgerSha256 = requiredPattern(
    sourceEvidence.packageReviewLedgerSha256,
    SHA256,
    "sourceEvidence.packageReviewLedgerSha256"
  );
  const manifestAbsolute = regularFileInside(
    rootDir,
    MEASUREMENT_CANDIDATE_SOURCE_EVIDENCE_PATH,
    "measurement candidate source evidence manifest"
  );
  const bundleAbsolute = regularFileInside(
    rootDir,
    MEASUREMENT_CANDIDATE_ATTESTATION_BUNDLE_PATH,
    "measurement candidate source attestation bundle"
  );
  const packageInventoryAbsolute = regularFileInside(
    rootDir,
    MEASUREMENT_CANDIDATE_PACKAGE_INVENTORY_PATH,
    "measurement candidate container package inventory"
  );
  const packageBundleAbsolute = regularFileInside(
    rootDir,
    MEASUREMENT_CANDIDATE_PACKAGE_ATTESTATION_BUNDLE_PATH,
    "measurement candidate container package inventory attestation bundle"
  );
  const packageReviewLedgerAbsolute = regularFileInside(
    rootDir,
    MEASUREMENT_CANDIDATE_PACKAGE_REVIEW_LEDGER_PATH,
    "measurement candidate container package review ledger"
  );
  requireValue(
    sha256File(manifestAbsolute) === manifestSha256,
    "measurement candidate source evidence manifest digest does not match"
  );
  requireValue(
    sha256File(bundleAbsolute) === bundleSha256,
    "measurement candidate source attestation bundle digest does not match"
  );
  requireValue(
    sha256File(packageInventoryAbsolute) === packageInventorySha256,
    "measurement candidate package inventory digest does not match"
  );
  requireValue(
    sha256File(packageBundleAbsolute) === packageBundleSha256,
    "measurement candidate package inventory attestation bundle digest does not match"
  );
  requireValue(
    sha256File(packageReviewLedgerAbsolute) ===
      packageReviewLedgerSha256,
    "measurement candidate package review ledger digest does not match"
  );
  readJson(bundleAbsolute, "measurement candidate source attestation bundle");
  readJson(
    packageBundleAbsolute,
    "measurement candidate container package inventory attestation bundle"
  );
  const sourceManifest = readJsonObject(
    manifestAbsolute,
    "measurement candidate source evidence manifest"
  );
  const containerArtifact = verifySourceEvidenceManifest(
    sourceManifest,
    candidateCommit,
    candidateTree,
    expectedRepository
  );
  const packageInventoryText = readFileSync(packageInventoryAbsolute, "utf8");
  const packageInventory = readJsonTextObject(
    packageInventoryText,
    "measurement candidate container package inventory"
  );
  requireValue(
    packageInventoryText === `${JSON.stringify(packageInventory, null, 2)}\n`,
    "measurement candidate container package inventory is not canonical serialized JSON"
  );
  verifyContainerPackageInventory(
    packageInventory,
    candidateCommit,
    containerArtifact
  );
  const packageReviewLedgerText = readFileSync(
    packageReviewLedgerAbsolute,
    "utf8"
  );
  const packageReviewLedger = readJsonTextObject(
    packageReviewLedgerText,
    "measurement candidate container package review ledger"
  );
  requireValue(
    packageReviewLedgerText ===
      `${JSON.stringify(packageReviewLedger, null, 2)}\n`,
    "measurement candidate container package review ledger is not canonical serialized JSON"
  );
  const referencedLegalEvidence =
    repositoryLegalEvidenceRefs(packageReviewLedger);
  requireValue(
    Array.isArray(sourceEvidence.packageLegalEvidence),
    "sourceEvidence.packageLegalEvidence must be an array"
  );
  const boundLegalEvidence = new Map<string, string>();
  let priorLegalEvidencePath = "";
  for (const [index, rawLegalEvidence] of (
    sourceEvidence.packageLegalEvidence as unknown[]
  ).entries()) {
    const label = `sourceEvidence.packageLegalEvidence[${index}]`;
    const legalEvidence = requiredRecord(rawLegalEvidence, label);
    requireExactOrderedKeys(legalEvidence, ["path", "sha256"], label);
    const legalEvidencePath = requiredCanonicalPath(
      legalEvidence.path,
      `${label}.path`
    );
    const legalEvidenceSha256 = requiredPattern(
      legalEvidence.sha256,
      SHA256,
      `${label}.sha256`
    );
    requireValue(
      legalEvidencePath > priorLegalEvidencePath,
      "sourceEvidence.packageLegalEvidence must be unique and sorted by path"
    );
    priorLegalEvidencePath = legalEvidencePath;
    boundLegalEvidence.set(legalEvidencePath, legalEvidenceSha256);
    candidateResidentText(
      rootDir,
      candidateCommit,
      legalEvidencePath,
      legalEvidenceSha256,
      verifyCandidateFinalization,
      `container legal evidence ${legalEvidencePath}`
    );
  }
  requireValue(
    boundLegalEvidence.size === referencedLegalEvidence.size &&
      [...referencedLegalEvidence].every(
        ([evidencePath, evidenceSha256]) =>
          boundLegalEvidence.get(evidencePath) === evidenceSha256
      ),
    "sourceEvidence.packageLegalEvidence must be set-equal to every repo: legal evidence reference in the package review ledger"
  );
  const measurementRuntime = measurementRuntimeFromContainerEvidence(
    containerArtifact,
    measurementIdentity.value
  );
  addEnumeratedPath(
    enumeratedPaths,
    MEASUREMENT_CANDIDATE_SOURCE_EVIDENCE_PATH,
    "added",
    manifestSha256
  );
  addEnumeratedPath(
    enumeratedPaths,
    MEASUREMENT_CANDIDATE_ATTESTATION_BUNDLE_PATH,
    "added",
    bundleSha256
  );
  addEnumeratedPath(
    enumeratedPaths,
    MEASUREMENT_CANDIDATE_PACKAGE_INVENTORY_PATH,
    "added",
    packageInventorySha256
  );
  addEnumeratedPath(
    enumeratedPaths,
    MEASUREMENT_CANDIDATE_PACKAGE_ATTESTATION_BUNDLE_PATH,
    "added",
    packageBundleSha256
  );
  addEnumeratedPath(
    enumeratedPaths,
    MEASUREMENT_CANDIDATE_PACKAGE_REVIEW_LEDGER_PATH,
    "refreshed",
    packageReviewLedgerSha256
  );

  const attestationPolicy = requiredRecord(binding.attestationPolicy, "attestationPolicy");
  requireExactKeys(
    attestationPolicy,
    ["status", "repository", "signerWorkflow", "sourceDigest", "sourceRef", "denySelfHostedRunners"],
    "attestationPolicy"
  );
  requireValue(
    attestationPolicy.status === "required-external-verification",
    "attestationPolicy.status must remain required-external-verification"
  );
  requireValue(
    attestationPolicy.repository === expectedRepository,
    "attestationPolicy.repository must match repository"
  );
  requireValue(
    attestationPolicy.signerWorkflow === MEASUREMENT_CANDIDATE_SIGNER_WORKFLOW,
    `attestationPolicy.signerWorkflow must be ${MEASUREMENT_CANDIDATE_SIGNER_WORKFLOW}`
  );
  requireValue(
    attestationPolicy.sourceDigest === candidateCommit,
    "attestationPolicy.sourceDigest must match candidateCommit"
  );
  requireValue(
    attestationPolicy.sourceRef === "refs/heads/main",
    "attestationPolicy.sourceRef must be refs/heads/main"
  );
  requireValue(
    attestationPolicy.denySelfHostedRunners === true,
    "attestationPolicy must deny self-hosted attestation runners"
  );
  const attestationRequest: MeasurementCandidateAttestationRequest = {
    subject: "container-evidence",
    artifactPath: manifestAbsolute,
    bundlePath: bundleAbsolute,
    repository: expectedRepository,
    signerWorkflow: MEASUREMENT_CANDIDATE_SIGNER_WORKFLOW,
    certIdentity: `https://github.com/${MEASUREMENT_CANDIDATE_SIGNER_WORKFLOW}@refs/heads/main`,
    signerDigest: candidateCommit,
    sourceDigest: candidateCommit,
    sourceRef: "refs/heads/main",
    denySelfHostedRunners: true,
    predicateType: "https://slsa.dev/provenance/v1",
    oidcIssuer: "https://token.actions.githubusercontent.com"
  };
  const packageAttestationRequest: MeasurementCandidateAttestationRequest = {
    ...attestationRequest,
    subject: "container-package-inventory",
    artifactPath: packageInventoryAbsolute,
    bundlePath: packageBundleAbsolute
  };

  requireValue(Array.isArray(binding.evidence), "evidence must be an array");
  const evidence: MeasurementEvidenceEntry[] = [];
  const postCandidateProducerReceipts: MeasurementPostCandidateProducerReceipt[] =
    [];
  let freezeActivatedAt = "";
  let freezeReceiptPath = "";
  let freezeReceiptSha256 = "";
  let freezeRunnerLabelSha256 = "";
  let freezeScannerEgress = "";
  let freezeScannerEgressRegionSha256 = "";
  for (const [index, rawEntry] of binding.evidence.entries()) {
    const label = `evidence[${index}]`;
    const entry = requiredRecord(rawEntry, label);
    requireExactKeys(entry, ["category", "path", "change", "sha256"], label);
    const category = requiredEvidenceCategory(entry.category, `${label}.category`);
    const policy = EVIDENCE_PATH_POLICIES[category];
    const evidencePath = requiredCanonicalPath(entry.path, `${label}.path`);
    requireValue(
      policy.pattern.test(evidencePath),
      `${label}.path is outside the fixed ${category} evidence root`
    );
    requireValue(
      entry.change === policy.allowedChange,
      `${label}.change must be ${policy.allowedChange} for ${category}`
    );
    const digest = requiredPattern(entry.sha256, SHA256, `${label}.sha256`);
    const absolute = regularFileInside(rootDir, evidencePath, label);
    requireValue(sha256File(absolute) === digest, `${label} digest does not match`);
    if (category === "measurement-freeze-receipt") {
      freezeReceiptPath = evidencePath;
      freezeReceiptSha256 = digest;
      const freezeReceipt = readJsonObject(
        absolute,
        "measurement-freeze activation receipt"
      );
      verifyMeasurementFreezeReceipt(
        rootDir,
        freezeReceipt,
        candidateCommit,
        evidencePath,
        verifyCandidateFinalization
      );
      const activation = requiredRecord(
        freezeReceipt.activation,
        "measurement-freeze receipt activation"
      );
      freezeActivatedAt = requiredCanonicalInstant(
        activation.activatedAt,
        "measurement-freeze receipt activation.activatedAt"
      );
      const safeConfiguration = requiredRecord(
        freezeReceipt.safeConfiguration,
        "measurement-freeze receipt safeConfiguration"
      );
      freezeRunnerLabelSha256 = requiredPattern(
        safeConfiguration.runnerLabelSha256,
        SHA256,
        "measurement-freeze receipt safeConfiguration.runnerLabelSha256"
      );
      freezeScannerEgress = requireNonEmptyString(
        safeConfiguration.scannerEgress,
        "measurement-freeze receipt safeConfiguration.scannerEgress"
      );
      freezeScannerEgressRegionSha256 = requiredPattern(
        safeConfiguration.scannerEgressRegionSha256,
        SHA256,
        "measurement-freeze receipt safeConfiguration.scannerEgressRegionSha256"
      );
      (freezeReceiptVerifier ?? verifyMeasurementFreezeReceiptWithCanonicalCli)({
        rootDir,
        receiptPath: absolute,
        candidateCommit
      });
    }
    if (category === "operator-evidence" && verifyCandidateFinalization) {
      (
        operatorEvidenceVerifier ?? verifyOperatorEvidenceWithCanonicalCli
      )({
        rootDir,
        evidencePath: absolute
      });
    }
    addEnumeratedPath(enumeratedPaths, evidencePath, policy.allowedChange, digest);
    evidence.push({
      category,
      path: evidencePath,
      change: policy.allowedChange,
      sha256: digest
    });
  }
  verifyEvidenceSets(evidence);
  if (verifyCandidateFinalization) {
    const carrierCommit = git(rootDir, [
      "rev-parse",
      "--verify",
      "HEAD"
    ])
      .trim()
      .toLowerCase();
    requireValue(
      FULL_GIT_SHA.test(carrierCommit),
      "durable soak archive verification requires an exact carrier commit"
    );
    const archiveDirectory =
      `research/hosted-evidence/${MEASUREMENT_DURABLE_SOAK_HOSTED_PROFILE}/${durablePrerequisite.soakAttestationSha256}`;
    const subjectCommit = git(rootDir, [
      "log",
      "-1",
      "--format=%H",
      candidateCommit,
      "--",
      durablePrerequisite.soakAttestationPath
    ])
      .trim()
      .toLowerCase();
    requireValue(
      FULL_GIT_SHA.test(subjectCommit),
      "durable soak attestation has no candidate-resident finalization commit"
    );
    (
      durableSoakProvenanceVerifier ??
      verifyDurableSoakProvenanceWithCanonicalCli
    )({
      rootDir,
      candidateCommit,
      carrierCommit,
      deploymentCommit: durablePrerequisite.toCommit,
      subjectCommit,
      evidencePath: durablePrerequisite.soakAttestationPath,
      evidenceSha256:
        durablePrerequisite.soakAttestationSha256,
      archiveDirectory,
      archiveEntries: evidence
        .filter(
          (entry) =>
            entry.category === "hosted-evidence-archive" &&
            entry.path.startsWith(`${archiveDirectory}/`)
        )
        .map((entry) => ({
          path: entry.path,
          sha256: entry.sha256
        }))
    });
  }
  requireValue(
      freezeActivatedAt.length > 0 &&
      freezeReceiptPath.length > 0 &&
      freezeReceiptSha256.length > 0 &&
      freezeRunnerLabelSha256.length > 0 &&
      freezeScannerEgress.length > 0 &&
      freezeScannerEgressRegionSha256.length > 0,
    "measurement-freeze activation receipt must provide activation and controlled runner/egress identities"
  );
  if (verifyCandidateFinalization) {
    verifyReleaseFinalization(rootDir, candidateCommit, evidence);
  }

  requireValue(
    Array.isArray(binding.calibrationStudies) &&
      (!requireCalibrationStudies || binding.calibrationStudies.length > 0),
    requireCalibrationStudies
      ? "calibrationStudies must be a non-empty array"
      : "calibrationStudies must be an array"
  );
  verifyAaProducerReceipts(
    rootDir,
    expectedRepository,
    candidateCommit,
    evidence,
    measurementInputByPath,
    {
      activatedAt: freezeActivatedAt,
      runnerLabelSha256: freezeRunnerLabelSha256,
      scannerEgress: freezeScannerEgress,
      scannerEgressRegionSha256: freezeScannerEgressRegionSha256
    },
    postCandidateProducerReceipts
  );
  const calibrationStudies: MeasurementCalibrationStudy[] = [];
  const studyIds = new Set<string>();
  for (const [index, rawStudy] of binding.calibrationStudies.entries()) {
    const label = `calibrationStudies[${index}]`;
    const study = requiredRecord(rawStudy, label);
    requireExactKeys(
      study,
      [
        "studyId",
        "detector",
        "preregistrationPath",
        "preregistrationSha256",
        "samplingFramePath",
        "samplingFrameSha256",
        "studyPath",
        "studySha256",
        "analysisPath",
        "analysisSha256",
        "runtimeReceiptPath",
        "runtimeReceiptSha256",
        "runtimeReceiptBundlePath",
        "runtimeReceiptBundleSha256",
        "labelRosterAuthorizationPath",
        "labelRosterAuthorizationSha256",
        "rosterSelectionLedgerPath",
        "rosterSelectionLedgerSha256",
        "acquisitionAttemptLedgerPath",
        "acquisitionAttemptLedgerSha256",
        "artifactManifestPath",
        "artifactManifestSha256"
      ],
      label
    );
    const studyId = requiredToken(study.studyId, `${label}.studyId`);
    const detector = requiredDetector(study.detector, `${label}.detector`);
    const preregistrationPath = requiredFixedPath(
      study.preregistrationPath,
      `${label}.preregistrationPath`,
      CALIBRATION_PREREGISTRATION_PATH
    );
    const samplingFramePath = requiredFixedPath(
      study.samplingFramePath,
      `${label}.samplingFramePath`,
      CALIBRATION_FRAME_PATH
    );
    const studyPath = requiredFixedPath(study.studyPath, `${label}.studyPath`, STUDY_PATH);
    const analysisPath = requiredFixedPath(
      study.analysisPath,
      `${label}.analysisPath`,
      ANALYSIS_PATH
    );
    const runtimeReceiptPath = requiredFixedPath(
      study.runtimeReceiptPath,
      `${label}.runtimeReceiptPath`,
      RUNTIME_RECEIPT_PATH
    );
    const runtimeReceiptBundlePath = requiredFixedPath(
      study.runtimeReceiptBundlePath,
      `${label}.runtimeReceiptBundlePath`,
      RUNTIME_RECEIPT_BUNDLE_PATH
    );
    const labelRosterAuthorizationPath = requiredFixedPath(
      study.labelRosterAuthorizationPath,
      `${label}.labelRosterAuthorizationPath`,
      CALIBRATION_LABEL_ROSTER_AUTHORIZATION_PATH
    );
    const rosterSelectionLedgerPath = requiredFixedPath(
      study.rosterSelectionLedgerPath,
      `${label}.rosterSelectionLedgerPath`,
      CALIBRATION_ROSTER_SELECTION_LEDGER_PATH
    );
    const acquisitionAttemptLedgerPath = requiredFixedPath(
      study.acquisitionAttemptLedgerPath,
      `${label}.acquisitionAttemptLedgerPath`,
      CALIBRATION_ACQUISITION_ATTEMPT_LEDGER_PATH
    );
    const artifactManifestPath = requiredFixedPath(
      study.artifactManifestPath,
      `${label}.artifactManifestPath`,
      CALIBRATION_ARTIFACT_MANIFEST_PATH
    );
    requireValue(STUDY_PATH.exec(studyPath)?.[1] === studyId, `${label}.studyPath directory must equal studyId`);
    requireValue(
      ANALYSIS_PATH.exec(analysisPath)?.[1] === studyId,
      `${label}.analysisPath directory must equal studyId`
    );
    requireValue(
      CALIBRATION_PREREGISTRATION_PATH.exec(preregistrationPath)?.[1] ===
        studyId,
      `${label}.preregistrationPath directory must equal studyId`
    );
    requireValue(
      CALIBRATION_FRAME_PATH.exec(samplingFramePath)?.[1] === studyId,
      `${label}.samplingFramePath directory must equal studyId`
    );
    requireValue(
      RUNTIME_RECEIPT_PATH.exec(runtimeReceiptPath)?.[1] === studyId,
      `${label}.runtimeReceiptPath directory must equal studyId`
    );
    requireValue(
      RUNTIME_RECEIPT_BUNDLE_PATH.exec(runtimeReceiptBundlePath)?.[1] ===
        studyId,
      `${label}.runtimeReceiptBundlePath directory must equal studyId`
    );
    requireValue(
      CALIBRATION_LABEL_ROSTER_AUTHORIZATION_PATH.exec(
        labelRosterAuthorizationPath
      )?.[1] === studyId,
      `${label}.labelRosterAuthorizationPath directory must equal studyId`
    );
    requireValue(
      CALIBRATION_ROSTER_SELECTION_LEDGER_PATH.exec(
        rosterSelectionLedgerPath
      )?.[1] === studyId,
      `${label}.rosterSelectionLedgerPath directory must equal studyId`
    );
    requireValue(
      CALIBRATION_ACQUISITION_ATTEMPT_LEDGER_PATH.exec(
        acquisitionAttemptLedgerPath
      )?.[1] === studyId,
      `${label}.acquisitionAttemptLedgerPath directory must equal studyId`
    );
    requireValue(
      CALIBRATION_ARTIFACT_MANIFEST_PATH.exec(artifactManifestPath)?.[1] === studyId,
      `${label}.artifactManifestPath directory must equal studyId`
    );
    requireValue(!studyIds.has(studyId), `calibrationStudies repeats studyId ${studyId}`);
    studyIds.add(studyId);
    const studySha256 = requiredPattern(study.studySha256, SHA256, `${label}.studySha256`);
    const analysisSha256 = requiredPattern(
      study.analysisSha256,
      SHA256,
      `${label}.analysisSha256`
    );
    const preregistrationSha256 = requiredPattern(
      study.preregistrationSha256,
      SHA256,
      `${label}.preregistrationSha256`
    );
    const samplingFrameSha256 = requiredPattern(
      study.samplingFrameSha256,
      SHA256,
      `${label}.samplingFrameSha256`
    );
    const runtimeReceiptSha256 = requiredPattern(
      study.runtimeReceiptSha256,
      SHA256,
      `${label}.runtimeReceiptSha256`
    );
    const runtimeReceiptBundleSha256 = requiredPattern(
      study.runtimeReceiptBundleSha256,
      SHA256,
      `${label}.runtimeReceiptBundleSha256`
    );
    const labelRosterAuthorizationSha256 = requiredPattern(
      study.labelRosterAuthorizationSha256,
      SHA256,
      `${label}.labelRosterAuthorizationSha256`
    );
    const rosterSelectionLedgerSha256 = requiredPattern(
      study.rosterSelectionLedgerSha256,
      SHA256,
      `${label}.rosterSelectionLedgerSha256`
    );
    const acquisitionAttemptLedgerSha256 = requiredPattern(
      study.acquisitionAttemptLedgerSha256,
      SHA256,
      `${label}.acquisitionAttemptLedgerSha256`
    );
    const artifactManifestSha256 = requiredPattern(
      study.artifactManifestSha256,
      SHA256,
      `${label}.artifactManifestSha256`
    );
    const studyAbsolute = regularFileInside(rootDir, studyPath, `${label} study`);
    const preregistrationAbsolute = regularFileInside(
      rootDir,
      preregistrationPath,
      `${label} preregistration`
    );
    const analysisAbsolute = regularFileInside(
      rootDir,
      analysisPath,
      `${label} analysis`
    );
    const samplingFrameAbsolute = regularFileInside(
      rootDir,
      samplingFramePath,
      `${label} sampling frame`
    );
    const receiptAbsolute = regularFileInside(
      rootDir,
      runtimeReceiptPath,
      `${label} runtime receipt`
    );
    const receiptBundleAbsolute = regularFileInside(
      rootDir,
      runtimeReceiptBundlePath,
      `${label} runtime receipt attestation bundle`
    );
    const labelRosterAuthorizationAbsolute = regularFileInside(
      rootDir,
      labelRosterAuthorizationPath,
      `${label} label roster authorization`
    );
    const rosterSelectionLedgerAbsolute = regularFileInside(
      rootDir,
      rosterSelectionLedgerPath,
      `${label} roster selection ledger`
    );
    const acquisitionAttemptLedgerAbsolute = regularFileInside(
      rootDir,
      acquisitionAttemptLedgerPath,
      `${label} acquisition attempt ledger`
    );
    const artifactManifestAbsolute = regularFileInside(
      rootDir,
      artifactManifestPath,
      `${label} artifact manifest`
    );
    requireValue(sha256File(studyAbsolute) === studySha256, `${label} study digest does not match`);
    requireValue(
      sha256File(analysisAbsolute) === analysisSha256,
      `${label} analysis digest does not match`
    );
    requireValue(
      sha256File(preregistrationAbsolute) === preregistrationSha256,
      `${label} preregistration digest does not match`
    );
    requireValue(
      sha256File(samplingFrameAbsolute) === samplingFrameSha256,
      `${label} sampling frame digest does not match`
    );
    requireValue(
      sha256File(receiptAbsolute) === runtimeReceiptSha256,
      `${label} runtime receipt digest does not match`
    );
    requireValue(
      sha256File(receiptBundleAbsolute) === runtimeReceiptBundleSha256,
      `${label} runtime receipt attestation bundle digest does not match`
    );
    requireValue(
      sha256File(labelRosterAuthorizationAbsolute) ===
        labelRosterAuthorizationSha256,
      `${label} label roster authorization digest does not match`
    );
    requireValue(
      sha256File(rosterSelectionLedgerAbsolute) ===
        rosterSelectionLedgerSha256,
      `${label} roster selection ledger digest does not match`
    );
    requireValue(
      sha256File(acquisitionAttemptLedgerAbsolute) ===
        acquisitionAttemptLedgerSha256,
      `${label} acquisition attempt ledger digest does not match`
    );
    requireValue(
      sha256File(artifactManifestAbsolute) === artifactManifestSha256,
      `${label} artifact manifest digest does not match`
    );
    const studyJson = readJsonObject(studyAbsolute, `${label} study`);
    requireValue(studyJson.studyId === studyId, `${label} studyId disagrees with study.json`);
    requireValue(studyJson.detector === detector, `${label} detector disagrees with study.json`);
    const release = requiredRecord(studyJson.release, `${label} study.release`);
    requireValue(
      release.buildCommit === candidateCommit,
      `${label} study.release.buildCommit must match candidateCommit`
    );
    const runtime = requiredRecord(release.runtime, `${label} study.release.runtime`);
    const receipt = readJsonObject(receiptAbsolute, `${label} runtime receipt`);
    const runtimeReceiptIdentity = verifyCalibrationRuntimeReceipt(
      receipt,
      label,
      studyId,
      detector,
      candidateCommit,
      runtime,
      artifactManifestSha256,
      {
        preregistrationSha256,
        samplingFrameSha256,
        measurementConditionSha256: createHash("sha256")
          .update(
            `${JSON.stringify(
              requiredRecord(
                requiredRecord(
                  studyJson.design,
                  `${label} study.design`
                ).measurementCondition,
                `${label} study.design.measurementCondition`
              ),
              null,
              2
            )}\n`
          )
          .digest("hex"),
        studySha256,
        analysisSha256
      },
      calibrationPolicy,
      {
        receiptPath: freezeReceiptPath,
        receiptSha256: freezeReceiptSha256,
        activatedAt: freezeActivatedAt,
        runnerLabelSha256: freezeRunnerLabelSha256,
        scannerEgress: freezeScannerEgress,
        scannerEgressRegionSha256: freezeScannerEgressRegionSha256
      }
    );
    const analysisText = readFileSync(analysisAbsolute, "utf8");
    const recomputedAnalysis = analyzeDetectorCalibrationStudy(studyJson, {
      expectedBuildCommit: candidateCommit,
      expectedRuntimeDigest: runtimeReceiptIdentity.runtimeDigest
    });
    const analysisPolicyProblems =
      measurementCalibrationAnalysisPolicyProblems(
        recomputedAnalysis,
        calibrationPolicy
      );
    requireValue(
      analysisText === `${JSON.stringify(recomputedAnalysis, null, 2)}\n`,
      `${label} analysis must be canonical and exactly recomputed from the bound study, candidate, and independent runtime receipt`
    );
    const calibrationCandidate = verifyCalibrationPreregistration(
      rootDir,
      label,
      candidateCommit,
      freezeActivatedAt,
      studyId,
      detector,
      studyJson,
      preregistrationPath,
      preregistrationSha256,
      samplingFramePath,
      samplingFrameSha256,
      verifyCandidateFinalization,
      measurementInputByPath,
      calibrationPolicy
    );
    const artifacts = verifyCalibrationArtifactManifest(
      rootDir,
      label,
      studyId,
      detector,
      studyJson,
      samplingFrameAbsolute,
      artifactManifestAbsolute,
      enumeratedPaths
    );
    verifyCalibrationLabelsManifest(
      rootDir,
      label,
      studyId,
      detector,
      runtimeReceiptIdentity.labels,
      calibrationCandidate.labelSealingKey,
      artifacts,
      enumeratedPaths
    );
    addEnumeratedPath(enumeratedPaths, studyPath, "added", studySha256);
    addEnumeratedPath(
      enumeratedPaths,
      runtimeReceiptPath,
      "added",
      runtimeReceiptSha256
    );
    addEnumeratedPath(
      enumeratedPaths,
      runtimeReceiptBundlePath,
      "added",
      runtimeReceiptBundleSha256
    );
    addEnumeratedPath(
      enumeratedPaths,
      labelRosterAuthorizationPath,
      "added",
      labelRosterAuthorizationSha256
    );
    addEnumeratedPath(
      enumeratedPaths,
      rosterSelectionLedgerPath,
      "added",
      rosterSelectionLedgerSha256
    );
    addEnumeratedPath(
      enumeratedPaths,
      acquisitionAttemptLedgerPath,
      "added",
      acquisitionAttemptLedgerSha256
    );
    addEnumeratedPath(
      enumeratedPaths,
      analysisPath,
      "added",
      analysisSha256
    );
    addEnumeratedPath(
      enumeratedPaths,
      artifactManifestPath,
      "added",
      artifactManifestSha256
    );
    calibrationStudies.push({
      studyId,
      detector,
      preregistrationPath,
      preregistrationSha256,
      samplingFramePath,
      samplingFrameSha256,
      censoringPolicy: calibrationCandidate.censoringPolicy,
      studyPath,
      studySha256,
      analysisPath,
      analysisSha256,
      runtimeReceiptPath,
      runtimeReceiptSha256,
      runtimeReceiptBundlePath,
      runtimeReceiptBundleSha256,
      runtimeReceiptRecordedAt: runtimeReceiptIdentity.recordedAt,
      runtimeReceiptProducerCommit:
        runtimeReceiptIdentity.producerCommit,
      runtimeReceiptRunHeadCommit: runtimeReceiptIdentity.runHeadCommit,
      runtimeReceiptRuntimeDigest: runtimeReceiptIdentity.runtimeDigest,
      labelsManifestPath: runtimeReceiptIdentity.labels.manifestPath,
      labelsManifestSha256: runtimeReceiptIdentity.labels.manifestSha256,
      labelRosterAuthorizationPath,
      labelRosterAuthorizationSha256,
      rosterSelectionLedgerPath,
      rosterSelectionLedgerSha256,
      acquisitionAttemptLedgerPath,
      acquisitionAttemptLedgerSha256,
      artifactManifestPath,
      artifactManifestSha256,
      artifacts,
      analysisPolicyProblems
    });
    postCandidateProducerReceipts.push({
      evidencePath: runtimeReceiptPath,
      pairedEvidencePaths: [
        preregistrationPath,
        samplingFramePath,
        studyPath,
        analysisPath,
        artifactManifestPath,
        runtimeReceiptIdentity.labels.manifestPath,
        labelRosterAuthorizationPath,
        rosterSelectionLedgerPath,
        acquisitionAttemptLedgerPath,
        runtimeReceiptPath,
        runtimeReceiptBundlePath
      ],
      producerCommit: runtimeReceiptIdentity.producerCommit,
      causalProducerCommits: [
        runtimeReceiptIdentity.runHeadCommit,
        runtimeReceiptIdentity.producerCommit
      ],
      causalEvidencePaths: [
        studyPath,
        analysisPath,
        artifactManifestPath,
        runtimeReceiptIdentity.labels.manifestPath,
        labelRosterAuthorizationPath,
        rosterSelectionLedgerPath,
        acquisitionAttemptLedgerPath,
        runtimeReceiptPath,
        runtimeReceiptBundlePath,
        ...artifacts.map((artifact) => artifact.path)
      ],
      collectionStartedAt: runtimeReceiptIdentity.collectionStartedAt,
      collectionCompletedAt: runtimeReceiptIdentity.collectionCompletedAt,
      artifactCreatedAt: runtimeReceiptIdentity.artifactCreatedAt,
      attestationRequest: {
        subject: "calibration-runtime-receipt",
        artifactPath: receiptAbsolute,
        bundlePath: receiptBundleAbsolute,
        repository: expectedRepository,
        signerWorkflow:
          "iAnonymous3000/site-behavior-lab/.github/workflows/calibration-study.yml",
        certIdentity:
          "https://github.com/iAnonymous3000/site-behavior-lab/.github/workflows/calibration-study.yml@refs/heads/main",
        signerDigest: runtimeReceiptIdentity.producerCommit,
        sourceDigest: runtimeReceiptIdentity.producerCommit,
        sourceRef: "refs/heads/main",
        denySelfHostedRunners: true,
        predicateType: "https://slsa.dev/provenance/v1",
        oidcIssuer: "https://token.actions.githubusercontent.com"
      }
    });
  }

  return {
    candidateCommit,
    candidateTree,
    evidence,
    calibrationStudies,
    postCandidateProducerReceipts,
    attestationRequest,
    packageAttestationRequest,
    bindingSha256: sha256File(bindingAbsolute),
    evidenceSetDigest: createHash("sha256")
      .update(
        JSON.stringify(
          {
            measurementInputsDigest:
              measurementInputs.domainSeparatedDigest,
            measurementIdentityDigest:
              measurementIdentity.domainSeparatedDigest,
            evidence: [...enumeratedPaths.entries()]
              .sort(([left], [right]) => left.localeCompare(right))
              .map(([evidencePath, value]) => ({
                path: evidencePath,
                change: value.change,
                sha256: value.sha256
              }))
          }
        )
      )
      .digest("hex"),
    measurementInputs,
    measurementIdentity,
    calibrationPolicy,
    measurementRuntime,
    durablePrerequisite,
    enumeratedPaths
  };
}

function verifyMeasurementCandidateInputs(
  rootDir: string,
  candidateCommit: string,
  binding: JsonRecord,
  verifyCandidateBlobs: boolean
): {
  manifestPath: typeof MEASUREMENT_CANDIDATE_INPUTS_PATH;
  manifestSha256: string;
  domainSeparatedDigest: string;
  inputs: MeasurementCandidateInput[];
} {
  requireExactOrderedKeys(
    binding,
    ["manifestPath", "manifestSha256", "domainSeparatedDigest"],
    "measurementInputs"
  );
  requireValue(
    binding.manifestPath === MEASUREMENT_CANDIDATE_INPUTS_PATH,
    `measurementInputs.manifestPath must be ${MEASUREMENT_CANDIDATE_INPUTS_PATH}`
  );
  const manifestSha256 = requiredPattern(
    binding.manifestSha256,
    SHA256,
    "measurementInputs.manifestSha256"
  );
  const domainSeparatedDigest = requiredPattern(
    binding.domainSeparatedDigest,
    SHA256,
    "measurementInputs.domainSeparatedDigest"
  );
  const manifestAbsolute = regularFileInside(
    rootDir,
    MEASUREMENT_CANDIDATE_INPUTS_PATH,
    "measurement candidate inputs manifest"
  );
  const currentManifest = readFileSync(manifestAbsolute, "utf8");
  const candidateManifest = verifyCandidateBlobs
    ? gitBlob(rootDir, candidateCommit, MEASUREMENT_CANDIDATE_INPUTS_PATH)
    : currentManifest;
  requireValue(
    currentManifest === candidateManifest &&
      createHash("sha256").update(candidateManifest).digest("hex") ===
        manifestSha256,
    "measurement candidate inputs manifest must be byte-identical to its candidate-resident blob"
  );
  requireValue(
    createHash("sha256")
      .update(MEASUREMENT_CANDIDATE_INPUTS_DIGEST_DOMAIN)
      .update("\0")
      .update(candidateManifest)
      .digest("hex") === domainSeparatedDigest,
    "measurement candidate inputs domain-separated digest does not match"
  );
  const manifest = readJsonTextObject(
    candidateManifest,
    "measurement candidate inputs manifest"
  );
  requireValue(
    candidateManifest === `${JSON.stringify(manifest, null, 2)}\n`,
    "measurement candidate inputs manifest must be canonical serialized JSON"
  );
  requireExactOrderedKeys(
    manifest,
    ["schemaVersion", "artifactKind", "inputs"],
    "measurement candidate inputs manifest"
  );
  requireValue(
    manifest.schemaVersion === 1 &&
      manifest.artifactKind === MEASUREMENT_CANDIDATE_INPUTS_KIND,
    "measurement candidate inputs manifest identity is invalid"
  );
  requireValue(
    Array.isArray(manifest.inputs) && manifest.inputs.length > 0,
    "measurement candidate inputs must be a non-empty array"
  );
  const allowedInputPath =
    /^(?:calibration\/[a-z0-9][a-z0-9._-]{0,99}\/(?:(?:preregistration|frame)\.json|label-sealing-public-key\.pem)|research\/aa-studies\/[a-z0-9][a-z0-9._-]{0,99}\/(?:preregistration|target-frame)\.json|research\/measurement-candidate\/(?:measurement-identity|calibration-censoring-policy)\.json)$/;
  const inputs: MeasurementCandidateInput[] = [];
  let priorPath = "";
  for (const [index, rawInput] of manifest.inputs.entries()) {
    const label = `measurement candidate inputs[${index}]`;
    const input = requiredRecord(rawInput, label);
    requireExactOrderedKeys(input, ["path", "sha256"], label);
    const inputPath = requiredCanonicalPath(input.path, `${label}.path`);
    requireValue(
      allowedInputPath.test(inputPath),
      `${label}.path is outside the fixed claim-affecting input roots`
    );
    requireValue(
      inputPath.localeCompare(priorPath) > 0,
      "measurement candidate input paths must be unique and sorted"
    );
    priorPath = inputPath;
    const digest = requiredPattern(input.sha256, SHA256, `${label}.sha256`);
    const inputAbsolute = regularFileInside(rootDir, inputPath, label);
    const currentInput = readFileSync(inputAbsolute);
    requireValue(
      createHash("sha256").update(currentInput).digest("hex") === digest,
      `${label} digest does not match current bytes`
    );
    if (verifyCandidateBlobs) {
      const candidateInput = Buffer.from(
        gitBlob(rootDir, candidateCommit, inputPath),
        "utf8"
      );
      requireValue(
        currentInput.equals(candidateInput) &&
          createHash("sha256").update(candidateInput).digest("hex") ===
            digest,
        `${label} must be byte-identical to its candidate-resident blob`
      );
    }
    if (!CALIBRATION_LABEL_SEALING_PUBLIC_KEY_PATH.test(inputPath)) {
      readJson(inputAbsolute, label);
    }
    inputs.push({ path: inputPath, sha256: digest });
  }

  const aaInputs = new Map<string, Set<"preregistration" | "target-frame">>();
  for (const input of inputs) {
    const match =
      /^research\/aa-studies\/([a-z0-9][a-z0-9._-]{0,99})\/(preregistration|target-frame)\.json$/.exec(
        input.path
      );
    if (!match) continue;
    const kinds = aaInputs.get(match[1]) ?? new Set();
    kinds.add(match[2] as "preregistration" | "target-frame");
    aaInputs.set(match[1], kinds);
  }
  requireValue(
    aaInputs.size > 0 &&
      [...aaInputs.values()].every(
        (kinds) =>
          kinds.has("preregistration") && kinds.has("target-frame")
      ),
    "measurement candidate inputs must contain paired A/A preregistration and target-frame files"
  );
  return {
    manifestPath: MEASUREMENT_CANDIDATE_INPUTS_PATH,
    manifestSha256,
    domainSeparatedDigest,
    inputs
  };
}

function verifyMeasurementIdentity(
  rootDir: string,
  candidateCommit: string,
  binding: JsonRecord,
  verifyCandidateBlob: boolean
): {
  manifestPath: typeof MEASUREMENT_IDENTITY_PATH;
  manifestSha256: string;
  domainSeparatedDigest: string;
  value: MeasurementIdentity;
} {
  requireExactOrderedKeys(
    binding,
    ["manifestPath", "manifestSha256", "domainSeparatedDigest"],
    "measurementIdentity"
  );
  requireValue(
    binding.manifestPath === MEASUREMENT_IDENTITY_PATH,
    `measurementIdentity.manifestPath must be ${MEASUREMENT_IDENTITY_PATH}`
  );
  const manifestSha256 = requiredPattern(
    binding.manifestSha256,
    SHA256,
    "measurementIdentity.manifestSha256"
  );
  const domainSeparatedDigest = requiredPattern(
    binding.domainSeparatedDigest,
    SHA256,
    "measurementIdentity.domainSeparatedDigest"
  );
  const absolute = regularFileInside(
    rootDir,
    MEASUREMENT_IDENTITY_PATH,
    "measurement identity manifest"
  );
  const current = readFileSync(absolute, "utf8");
  const candidate = verifyCandidateBlob
    ? gitBlob(rootDir, candidateCommit, MEASUREMENT_IDENTITY_PATH)
    : current;
  requireValue(
    current === candidate &&
      createHash("sha256").update(candidate).digest("hex") === manifestSha256,
    "measurement identity must be byte-identical to its candidate-resident blob"
  );
  requireValue(
    createHash("sha256")
      .update(MEASUREMENT_IDENTITY_DIGEST_DOMAIN)
      .update("\0")
      .update(candidate)
      .digest("hex") === domainSeparatedDigest,
    "measurement identity domain-separated digest does not match"
  );
  const identity = readJsonTextObject(candidate, "measurement identity");
  requireValue(
    candidate === `${JSON.stringify(identity, null, 2)}\n`,
    "measurement identity must be canonical serialized JSON"
  );
  requireExactOrderedKeys(
    identity,
    [
      "schemaVersion",
      "artifactKind",
      "implementation",
      "catalogs",
      "toolchain"
    ],
    "measurement identity"
  );
  requireValue(
    identity.schemaVersion === 1 &&
      identity.artifactKind === MEASUREMENT_IDENTITY_KIND,
    "measurement identity schema or artifact kind is invalid"
  );
  const implementation = requiredRecord(
    identity.implementation,
    "measurement identity implementation"
  );
  requireExactOrderedKeys(
    implementation,
    [
      "detectorRegistryVersion",
      "detectorRegistryDigest",
      "methodologyVersion",
      "normalizationVersion"
    ],
    "measurement identity implementation"
  );
  const catalogs = requiredRecord(
    identity.catalogs,
    "measurement identity catalogs"
  );
  requireExactOrderedKeys(
    catalogs,
    [
      "trackerCatalogVersion",
      "trackerCatalogDigest",
      "trackerCatalogProvenanceVersion",
      "trackerCatalogProvenanceDigest",
      "braveCatalogCommit",
      "braveCatalogDigest",
      "braveManifestDigest",
      "braveRulesDigest",
      "braveEngineVersion"
    ],
    "measurement identity catalogs"
  );
  const toolchain = requiredRecord(
    identity.toolchain,
    "measurement identity toolchain"
  );
  requireExactOrderedKeys(
    toolchain,
    [
      "nodeVersion",
      "playwrightVersion",
      "containerBaseImageDigest",
      "containerNodeVersion"
    ],
    "measurement identity toolchain"
  );
  const dockerfile = verifyCandidateBlob
    ? gitBlob(rootDir, candidateCommit, "Dockerfile")
    : readFileSync(absoluteRepoPath(rootDir, "Dockerfile"), "utf8");
  const baseDigest =
    /^FROM mcr\.microsoft\.com\/playwright:[^@\s]+@(sha256:[0-9a-f]{64}) AS playwright-base$/m.exec(
      dockerfile
    )?.[1] ?? "";
  const containerNodeVersion =
    /test "\$\(node --version\)" = "v([^"]+)"/.exec(dockerfile)?.[1] ?? "";
  requireValue(
    /^sha256:[0-9a-f]{64}$/.test(baseDigest) &&
      /^\d+\.\d+\.\d+$/.test(containerNodeVersion),
    "candidate Dockerfile must expose one immutable Playwright base and container Node version"
  );
  const expected: MeasurementIdentity = {
    implementation: {
      detectorRegistryVersion: DETECTOR_REGISTRY_VERSION,
      detectorRegistryDigest: DETECTOR_REGISTRY_DIGEST,
      methodologyVersion: NODE_SCAN_REPORT_V2_R2_METHODOLOGY_VERSION,
      normalizationVersion: NODE_SCAN_REPORT_V2_R2_NORMALIZATION_VERSION
    },
    catalogs: {
      trackerCatalogVersion: trackerCatalogMetadata.version,
      trackerCatalogDigest: trackerCatalogMetadata.digest,
      trackerCatalogProvenanceVersion:
        trackerCatalogMetadata.provenanceVersion,
      trackerCatalogProvenanceDigest: trackerCatalogMetadata.provenanceDigest,
      braveCatalogCommit: braveListManifest.catalogCommit,
      braveCatalogDigest: braveListManifest.catalogSha256,
      braveManifestDigest: braveListManifest.manifestDigest,
      braveRulesDigest: braveListManifest.rulesDigest,
      braveEngineVersion: NODE_ADBLOCK_ENGINE_VERSION
    },
    toolchain: {
      nodeVersion: packageManifest.engines.node,
      playwrightVersion: NODE_PLAYWRIGHT_VERSION,
      containerBaseImageDigest: baseDigest,
      containerNodeVersion
    }
  };
  requireValue(
    JSON.stringify({
      implementation,
      catalogs,
      toolchain
    }) === JSON.stringify(expected),
    "measurement identity must exactly match candidate-derived implementation, catalog, list, and toolchain identities"
  );
  return {
    manifestPath: MEASUREMENT_IDENTITY_PATH,
    manifestSha256,
    domainSeparatedDigest,
    value: expected
  };
}

function verifyCalibrationRuntimeReceipt(
  receipt: JsonRecord,
  label: string,
  studyId: string,
  detector: DetectorId,
  candidateCommit: string,
  studyRuntime: JsonRecord,
  artifactManifestSha256: string,
  boundArtifacts: {
    preregistrationSha256: string;
    samplingFrameSha256: string;
    measurementConditionSha256: string;
    studySha256: string;
    analysisSha256: string;
  },
  calibrationPolicy: MeasurementCalibrationPolicyProfile,
  freeze: {
    receiptPath: string;
    receiptSha256: string;
    activatedAt: string;
    runnerLabelSha256: string;
    scannerEgress: string;
    scannerEgressRegionSha256: string;
  }
): {
  producerCommit: string;
  runHeadCommit: string;
  recordedAt: string;
  collectionStartedAt: string;
  collectionCompletedAt: string;
  artifactCreatedAt: string;
  runtimeDigest: string;
  labels: {
    commit: string;
    tree: string;
    sourcePath: string;
    sourceSha256: string;
    manifestPath: string;
    manifestSha256: string;
    labelSealingKey: CalibrationLabelSealingKey;
    commitmentSetSha256: string;
    recordedFrom: string;
    recordedThrough: string;
  };
} {
  requireExactOrderedKeys(
    receipt,
    [
      "schemaVersion",
      "artifactKind",
      "studyId",
      "detector",
      "candidateCommit",
      "producerCommit",
      "policy",
      "freeze",
      "acquisition",
      "artifact",
      "labels",
      "inputs",
      "outputs",
      "runtime",
      "assembledAt"
    ],
    `${label} runtime receipt`
  );
  requireValue(
    receipt.schemaVersion === 3 &&
      receipt.artifactKind ===
        "site-behavior-detector-calibration-runtime-receipt" &&
      receipt.studyId === studyId &&
      receipt.detector === detector &&
      receipt.candidateCommit === candidateCommit,
    `${label} runtime receipt identity is invalid`
  );
  const producerCommit = requiredPattern(
    receipt.producerCommit,
    FULL_GIT_SHA,
    `${label} runtime receipt producerCommit`
  );

  const policy = requiredRecord(receipt.policy, `${label} runtime receipt policy`);
  requireExactOrderedKeys(
    policy,
    [
      "id",
      "path",
      "sha256",
      "dispositionSha256",
      "decidedBy",
      "decidedAt"
    ],
    `${label} runtime receipt policy`
  );
  requireValue(
    policy.id === calibrationPolicy.id &&
      policy.path === calibrationPolicy.policyArtifactPath &&
      policy.sha256 === calibrationPolicy.policyArtifactSha256 &&
      policy.dispositionSha256 === calibrationPolicy.dispositionSha256 &&
      policy.decidedBy === calibrationPolicy.decidedBy &&
      policy.decidedAt === calibrationPolicy.decidedAt,
    `${label} runtime receipt policy must exactly bind the approved candidate calibration decision`
  );

  const freezeReceipt = requiredRecord(
    receipt.freeze,
    `${label} runtime receipt freeze`
  );
  requireValue(
    Object.keys(freezeReceipt).join("\0") ===
      ["receiptPath", "receiptSha256", "activatedAt"].join("\0") &&
      freezeReceipt.receiptPath === freeze.receiptPath &&
      freezeReceipt.receiptSha256 === freeze.receiptSha256 &&
      freezeReceipt.activatedAt === freeze.activatedAt,
    `${label} runtime receipt freeze must bind the canonical candidate freeze receipt`
  );

  const acquisition = requiredRecord(
    receipt.acquisition,
    `${label} runtime receipt acquisition`
  );
  requireExactOrderedKeys(
    acquisition,
    [
      "repository",
      "workflowPath",
      "workflowRef",
      "runId",
      "runAttempt",
      "event",
      "headBranch",
      "headSha",
      "runStartedAt",
      "runCompletedAt",
      "job",
      "startedAt",
      "completedAt",
      "runner",
      "egress"
    ],
    `${label} runtime receipt acquisition`
  );
  requireValue(
    acquisition.repository === MEASUREMENT_CANDIDATE_REPOSITORY &&
      acquisition.workflowPath === ".github/workflows/calibration-study.yml" &&
      acquisition.workflowRef === "refs/heads/main" &&
      acquisition.event === "workflow_dispatch" &&
      acquisition.headBranch === "main" &&
      Number.isSafeInteger(acquisition.runId) &&
      (acquisition.runId as number) > 0 &&
      Number.isSafeInteger(acquisition.runAttempt) &&
      (acquisition.runAttempt as number) >= 1 &&
      (acquisition.runAttempt as number) <= 100,
    `${label} runtime receipt acquisition must name one governed default-branch workflow run`
  );
  const runHeadCommit = requiredPattern(
    acquisition.headSha,
    FULL_GIT_SHA,
    `${label} runtime receipt acquisition.headSha`
  );
  const runStartedAt = requiredCanonicalInstant(
    acquisition.runStartedAt,
    `${label} runtime receipt acquisition.runStartedAt`
  );
  const runCompletedAt = requiredCanonicalInstant(
    acquisition.runCompletedAt,
    `${label} runtime receipt acquisition.runCompletedAt`
  );
  const acquisitionJob = requiredRecord(
    acquisition.job,
    `${label} runtime receipt acquisition.job`
  );
  requireExactOrderedKeys(
    acquisitionJob,
    ["id", "startedAt", "completedAt", "runnerNameSha256"],
    `${label} runtime receipt acquisition.job`
  );
  requireValue(
    Number.isSafeInteger(acquisitionJob.id) &&
      (acquisitionJob.id as number) > 0,
    `${label} runtime receipt acquisition.job.id must be a positive integer`
  );
  const acquisitionJobStartedAt = requiredCanonicalInstant(
    acquisitionJob.startedAt,
    `${label} runtime receipt acquisition.job.startedAt`
  );
  const acquisitionJobCompletedAt = requiredCanonicalInstant(
    acquisitionJob.completedAt,
    `${label} runtime receipt acquisition.job.completedAt`
  );
  requiredPattern(
    acquisitionJob.runnerNameSha256,
    SHA256,
    `${label} runtime receipt acquisition.job.runnerNameSha256`
  );
  const runner = requiredRecord(
    acquisition.runner,
    `${label} runtime receipt acquisition.runner`
  );
  requireExactOrderedKeys(
    runner,
    ["labelSha256", "identitySha256", "environment"],
    `${label} runtime receipt acquisition.runner`
  );
  requireValue(
    runner.labelSha256 === freeze.runnerLabelSha256 &&
      SHA256.test(
        requireNonEmptyString(
          runner.identitySha256,
          `${label} runtime receipt acquisition.runner.identitySha256`
        )
      ) &&
      runner.environment === "ephemeral-self-hosted",
    `${label} runtime receipt runner must bind the freeze-selected ephemeral controlled runner`
  );
  const egress = requiredRecord(
    acquisition.egress,
    `${label} runtime receipt acquisition.egress`
  );
  requireExactOrderedKeys(
    egress,
    ["identity", "regionSha256"],
    `${label} runtime receipt acquisition.egress`
  );
  requireValue(
    egress.identity === freeze.scannerEgress &&
      egress.regionSha256 === freeze.scannerEgressRegionSha256,
    `${label} runtime receipt egress must bind the freeze-selected controlled identity and region`
  );
  const artifact = requiredRecord(
    receipt.artifact,
    `${label} runtime receipt artifact`
  );
  requireExactOrderedKeys(
    artifact,
    [
      "id",
      "name",
      "archiveSha256",
      "bytes",
      "createdAt",
      "expiresAt"
    ],
    `${label} runtime receipt artifact`
  );
  requireValue(
    Number.isSafeInteger(artifact.id) &&
      (artifact.id as number) > 0 &&
      artifact.name ===
        `site-behavior-calibration-${studyId}-${acquisition.runId}-${acquisition.runAttempt}` &&
      SHA256.test(
        requireNonEmptyString(
          artifact.archiveSha256,
          `${label} runtime receipt artifact.archiveSha256`
        )
      ) &&
      Number.isSafeInteger(artifact.bytes) &&
      (artifact.bytes as number) > 0,
    `${label} runtime receipt artifact must bind one exact governed Actions artifact`
  );
  const artifactCreatedAt = requiredCanonicalInstant(
    artifact.createdAt,
    `${label} runtime receipt artifact.createdAt`
  );
  const artifactExpiresAt = requiredCanonicalInstant(
    artifact.expiresAt,
    `${label} runtime receipt artifact.expiresAt`
  );

  const labels = requiredRecord(
    receipt.labels,
    `${label} runtime receipt labels`
  );
  requireExactOrderedKeys(
    labels,
    [
      "commit",
      "tree",
      "path",
      "sourceSha256",
      "manifestPath",
      "manifestSha256",
      "labelSealingKey",
      "commitmentSetSha256",
      "recordedFrom",
      "recordedThrough"
    ],
    `${label} runtime receipt labels`
  );
  const labelsCommit = requiredPattern(
    labels.commit,
    FULL_GIT_SHA,
    `${label} runtime receipt labels.commit`
  );
  const labelsTree = requiredPattern(
    labels.tree,
    FULL_GIT_SHA,
    `${label} runtime receipt labels.tree`
  );
  const labelsSourcePath = requiredCanonicalPath(
    labels.path,
    `${label} runtime receipt labels.path`
  );
  const labelsManifestPath = requiredCanonicalPath(
    labels.manifestPath,
    `${label} runtime receipt labels.manifestPath`
  );
  const labelsSourceSha256 = requiredPattern(
    labels.sourceSha256,
    SHA256,
    `${label} runtime receipt labels.sourceSha256`
  );
  requireValue(
    labelsSourcePath === `calibration-labels/${studyId}` &&
      labelsManifestPath === `calibration/${studyId}/labels-manifest.json`,
    `${label} runtime receipt labels must use the fixed study-local source and retained manifest paths`
  );
  const labelsManifestSha256 = requiredPattern(
    labels.manifestSha256,
    SHA256,
    `${label} runtime receipt labels.manifestSha256`
  );
  const labelsLabelSealingKey = calibrationLabelSealingKeyDescriptor(
    labels.labelSealingKey,
    studyId,
    `${label} runtime receipt labels.labelSealingKey`
  );
  const labelsCommitmentSetSha256 = requiredPattern(
    labels.commitmentSetSha256,
    SHA256,
    `${label} runtime receipt labels.commitmentSetSha256`
  );
  const labelsRecordedFrom = requiredCanonicalInstant(
    labels.recordedFrom,
    `${label} runtime receipt labels.recordedFrom`
  );
  const labelsRecordedThrough = requiredCanonicalInstant(
    labels.recordedThrough,
    `${label} runtime receipt labels.recordedThrough`
  );

  const inputs = requiredRecord(
    receipt.inputs,
    `${label} runtime receipt inputs`
  );
  requireExactOrderedKeys(
    inputs,
    [
      "preregistrationSha256",
      "samplingFrameSha256",
      "labelSealingPublicKeySha256",
      "measurementConditionSha256",
      "acquisitionManifestSha256"
    ],
    `${label} runtime receipt inputs`
  );
  requireValue(
    inputs.preregistrationSha256 === boundArtifacts.preregistrationSha256 &&
      inputs.samplingFrameSha256 === boundArtifacts.samplingFrameSha256 &&
      inputs.labelSealingPublicKeySha256 ===
        labelsLabelSealingKey.publicKeySha256 &&
      inputs.measurementConditionSha256 ===
        boundArtifacts.measurementConditionSha256 &&
      SHA256.test(
        requireNonEmptyString(
          inputs.acquisitionManifestSha256,
          `${label} runtime receipt inputs.acquisitionManifestSha256`
        )
      ),
    `${label} runtime receipt inputs must bind the candidate study plan, frame, label-sealing public key, and acquired manifest`
  );

  const outputs = requiredRecord(
    receipt.outputs,
    `${label} runtime receipt outputs`
  );
  requireExactOrderedKeys(
    outputs,
    [
      "studySha256",
      "artifactManifestSha256",
      "analysisSha256",
      "labelsManifestSha256"
    ],
    `${label} runtime receipt outputs`
  );
  requireValue(
    outputs.studySha256 === boundArtifacts.studySha256 &&
      outputs.artifactManifestSha256 === artifactManifestSha256 &&
      outputs.analysisSha256 === boundArtifacts.analysisSha256 &&
      outputs.labelsManifestSha256 === labelsManifestSha256,
    `${label} runtime receipt outputs must bind the exact committed study, artifact manifest, analysis, and label manifest`
  );
  const runtime = requiredRecord(
    receipt.runtime,
    `${label} runtime receipt runtime`
  );
  requireExactOrderedKeys(
    runtime,
    [
      "observer",
      "automation",
      "nodeVersion",
      "playwrightVersion",
      "browserName",
      "browserVersion",
      "operatingSystem",
      "architecture",
      "runtimeDigest"
    ],
    `${label} runtime receipt runtime`
  );
  const runtimeFields = {
    observer: runtime.observer,
    automation: runtime.automation,
    nodeVersion: runtime.nodeVersion,
    playwrightVersion: runtime.playwrightVersion,
    browserName: runtime.browserName,
    browserVersion: runtime.browserVersion,
    operatingSystem: runtime.operatingSystem,
    architecture: runtime.architecture
  };
  requireValue(
    runtimeFields.observer === "node-playwright" &&
      runtimeFields.automation === "playwright-chromium" &&
      runtimeFields.browserName === "chromium",
    `${label} runtime receipt runtime must use the governed observer and browser`
  );
  for (const [key, value] of Object.entries(runtimeFields)) {
    requireNonEmptyString(value, `${label} runtime receipt runtime.${key}`);
  }
  const derivedRuntimeDigest = detectorCalibrationRuntimeDigest(
    runtimeFields as Parameters<typeof detectorCalibrationRuntimeDigest>[0]
  );
  requireValue(
    runtime.runtimeDigest === derivedRuntimeDigest,
    `${label} runtime receipt runtimeDigest must be derived from its independently recorded runtime fields`
  );
  requireValue(
    JSON.stringify(runtime) === JSON.stringify(studyRuntime),
    `${label} runtime receipt runtime must exactly match the final study runtime identity`
  );
  const collectionStartedAt = requiredCanonicalInstant(
    acquisition.startedAt,
    `${label} runtime receipt acquisition.startedAt`
  );
  const collectionCompletedAt = requiredCanonicalInstant(
    acquisition.completedAt,
    `${label} runtime receipt acquisition.completedAt`
  );
  const recordedAt = requiredCanonicalInstant(
    receipt.assembledAt,
    `${label} runtime receipt assembledAt`
  );
  requireValue(
    Date.parse(calibrationPolicy.decidedAt) <=
        Date.parse(labelsRecordedFrom) &&
      Date.parse(freeze.activatedAt) <= Date.parse(labelsRecordedFrom) &&
      Date.parse(labelsRecordedFrom) <= Date.parse(labelsRecordedThrough) &&
      Date.parse(labelsRecordedThrough) < Date.parse(runStartedAt) &&
      Date.parse(runStartedAt) <= Date.parse(acquisitionJobStartedAt) &&
      Date.parse(acquisitionJobStartedAt) <=
        Date.parse(collectionStartedAt) &&
      Date.parse(collectionStartedAt) <= Date.parse(collectionCompletedAt) &&
      Date.parse(collectionCompletedAt) <=
        Date.parse(acquisitionJobCompletedAt) &&
      Date.parse(acquisitionJobStartedAt) <= Date.parse(artifactCreatedAt) &&
      Date.parse(artifactCreatedAt) <= Date.parse(acquisitionJobCompletedAt) &&
      Date.parse(acquisitionJobCompletedAt) <= Date.parse(runCompletedAt) &&
      Date.parse(runCompletedAt) <= Date.parse(recordedAt) &&
      Date.parse(artifactCreatedAt) < Date.parse(artifactExpiresAt) &&
      Date.parse(labelsRecordedThrough) <= Date.parse(recordedAt),
    `${label} runtime receipt chronology must run policy and freeze through authenticated pre-acquisition ciphertext commitments, server-bound acquisition, protected reveal, artifact archival, and hosted assembly`
  );
  return {
    producerCommit,
    runHeadCommit,
    recordedAt,
    collectionStartedAt,
    collectionCompletedAt,
    artifactCreatedAt,
    runtimeDigest: derivedRuntimeDigest,
    labels: {
      commit: labelsCommit,
      tree: labelsTree,
      sourcePath: labelsSourcePath,
      sourceSha256: labelsSourceSha256,
      manifestPath: labelsManifestPath,
      manifestSha256: labelsManifestSha256,
      labelSealingKey: labelsLabelSealingKey,
      commitmentSetSha256: labelsCommitmentSetSha256,
      recordedFrom: labelsRecordedFrom,
      recordedThrough: labelsRecordedThrough
    }
  };
}

function verifyCalibrationPreregistration(
  rootDir: string,
  label: string,
  candidateCommit: string,
  freezeActivatedAt: string,
  studyId: string,
  detector: DetectorId,
  study: JsonRecord,
  preregistrationPath: string,
  preregistrationSha256: string,
  samplingFramePath: string,
  samplingFrameSha256: string,
  verifyCandidateBlobs: boolean,
  measurementInputByPath: Map<string, string>,
  approvedPolicy: MeasurementCalibrationPolicyProfile
): {
  censoringPolicy: {
    id: typeof MEASUREMENT_CALIBRATION_CENSORING_POLICY_ID;
    path: string;
    sha256: string;
  };
  labelSealingKey: CalibrationLabelSealingKey;
} {
  const expectedCandidateInputs = [
    [preregistrationPath, preregistrationSha256],
    [samplingFramePath, samplingFrameSha256]
  ] as const;
  for (const [inputPath, digest] of expectedCandidateInputs) {
    requireValue(
      measurementInputByPath.get(inputPath) === digest,
      `${label} candidate input ${inputPath} must be digest-bound by the measurement inputs manifest`
    );
  }
  const preregistrationAbsolute = absoluteRepoPath(rootDir, preregistrationPath);
  const currentPreregistration = readFileSync(preregistrationAbsolute, "utf8");
  const candidatePreregistration = verifyCandidateBlobs
    ? gitBlob(rootDir, candidateCommit, preregistrationPath)
    : currentPreregistration;
  requireValue(
    currentPreregistration === candidatePreregistration &&
      createHash("sha256").update(candidatePreregistration).digest("hex") ===
        preregistrationSha256,
    `${label} preregistration must be byte-identical to its candidate-resident blob`
  );
  const preregistration = readJsonTextObject(
    candidatePreregistration,
    `${label} candidate preregistration`
  );
  requireValue(
    candidatePreregistration === `${JSON.stringify(preregistration, null, 2)}\n`,
    `${label} candidate preregistration must be canonical serialized JSON`
  );
  requireExactOrderedKeys(
    preregistration,
    [
      "schemaVersion",
      "artifactKind",
      "studyId",
      "detector",
      "declaredAt",
      "targetPopulation",
      "plannedCases",
      "censoringPolicy",
      "design"
    ],
    `${label} candidate preregistration`
  );
  requireValue(
    preregistration.schemaVersion === 2 &&
      preregistration.artifactKind ===
        "site-behavior-detector-calibration-preregistration" &&
      preregistration.studyId === studyId &&
      preregistration.detector === detector &&
      study.schemaVersion === 3,
    `${label} candidate preregistration identity does not match the study`
  );
  const declaredAt = requiredCanonicalInstant(
    preregistration.declaredAt,
    `${label} candidate preregistration.declaredAt`
  );
  requireValue(
    Date.parse(declaredAt) < Date.parse(freezeActivatedAt),
    `${label} candidate preregistration must predate measurement-freeze activation`
  );
  const censoringPolicy = requiredRecord(
    preregistration.censoringPolicy,
    `${label} candidate preregistration.censoringPolicy`
  );
  requireExactOrderedKeys(
    censoringPolicy,
    ["id", "path", "sha256"],
    `${label} candidate preregistration.censoringPolicy`
  );
  const censoringPolicyId = requiredToken(
    censoringPolicy.id,
    `${label} candidate preregistration.censoringPolicy.id`
  );
  requireValue(
    censoringPolicyId === approvedPolicy.id,
    `${label} candidate preregistration must select the explicitly approved calibration policy`
  );
  const censoringPolicyPath = requiredCanonicalPath(
    censoringPolicy.path,
    `${label} candidate preregistration.censoringPolicy.path`
  );
  requireValue(
    censoringPolicyPath === approvedPolicy.policyArtifactPath,
    `${label} candidate preregistration must use the approved fixed censoring-policy artifact`
  );
  const censoringPolicySha256 = requiredPattern(
    censoringPolicy.sha256,
    SHA256,
    `${label} candidate preregistration.censoringPolicy.sha256`
  );
  verifyCalibrationCensoringPolicy(
    rootDir,
    label,
    candidateCommit,
    censoringPolicyId,
    censoringPolicyPath,
    censoringPolicySha256,
    verifyCandidateBlobs
  );
  requireValue(
    censoringPolicySha256 === approvedPolicy.policyArtifactSha256 &&
      measurementInputByPath.get(censoringPolicyPath) ===
        censoringPolicySha256,
    `${label} candidate censoring policy must be digest-bound by the measurement inputs manifest`
  );
  requireValue(
    preregistration.targetPopulation === study.targetPopulation &&
      preregistration.plannedCases === study.plannedCases &&
      JSON.stringify(preregistration.design) === JSON.stringify(study.design),
    `${label} final study population, denominator, and design must exactly match the candidate preregistration`
  );

  const design = requiredRecord(
    preregistration.design,
    `${label} candidate preregistration.design`
  );
  const measurementCondition = requiredRecord(
    design.measurementCondition,
    `${label} candidate preregistration.design.measurementCondition`
  );
  requireExactOrderedKeys(
    measurementCondition,
    ["device", "gpcEnabled", "consentMode", "interpretation"],
    `${label} candidate preregistration.design.measurementCondition`
  );
  requireValue(
    JSON.stringify(measurementCondition) ===
      JSON.stringify(detectorCalibrationMeasurementCondition(detector)),
    `${label} candidate preregistration must bind the canonical detector-specific measurement condition`
  );
  requireValue(
    design.samplingFrame === samplingFramePath &&
      design.samplingFrameDigest === samplingFrameSha256,
    `${label} candidate preregistration must bind the fixed sampling-frame path and bytes`
  );
  const samplingFrameAbsolute = absoluteRepoPath(rootDir, samplingFramePath);
  const currentSamplingFrame = readFileSync(samplingFrameAbsolute, "utf8");
  const candidateSamplingFrame = verifyCandidateBlobs
    ? gitBlob(rootDir, candidateCommit, samplingFramePath)
    : currentSamplingFrame;
  requireValue(
    currentSamplingFrame === candidateSamplingFrame &&
      createHash("sha256").update(candidateSamplingFrame).digest("hex") ===
        samplingFrameSha256,
    `${label} sampling frame must be byte-identical to its candidate-resident blob`
  );
  const labelSealingKey = verifyCalibrationSamplingFrame(
    rootDir,
    candidateCommit,
    verifyCandidateBlobs,
    measurementInputByPath,
    candidateSamplingFrame,
    studyId,
    detector,
    study,
    `${label} candidate sampling frame`
  );
  return {
    censoringPolicy: {
      id: MEASUREMENT_CALIBRATION_CENSORING_POLICY_ID,
      path: censoringPolicyPath,
      sha256: censoringPolicySha256
    },
    labelSealingKey
  };
}

function verifyCalibrationSamplingFrame(
  rootDir: string,
  candidateCommit: string,
  verifyCandidateBlob: boolean,
  measurementInputByPath: Map<string, string>,
  frameText: string,
  studyId: string,
  detector: DetectorId,
  study: JsonRecord,
  label: string
): CalibrationLabelSealingKey {
  const frame = readJsonTextObject(frameText, label);
  requireValue(
    frameText === `${JSON.stringify(frame, null, 2)}\n`,
    `${label} must be canonical serialized JSON`
  );
  requireExactOrderedKeys(
    frame,
    [
      "schemaVersion",
      "artifactKind",
      "studyId",
      "detector",
      "selectionProtocolDigest",
      "measurementCondition",
      "labelSealingKey",
      "cases"
    ],
    label
  );
  requireValue(
    frame.schemaVersion === 2 &&
      frame.artifactKind ===
        "site-behavior-detector-calibration-sampling-frame" &&
      frame.studyId === studyId &&
      frame.detector === detector,
    `${label} identity does not match the calibration study`
  );
  const labelSealingKey = verifyCalibrationLabelSealingKey(
    rootDir,
    candidateCommit,
    verifyCandidateBlob,
    measurementInputByPath,
    frame.labelSealingKey,
    studyId,
    `${label}.labelSealingKey`
  );
  const design = requiredRecord(study.design, `${label} study design`);
  requireValue(
    JSON.stringify(frame.measurementCondition) ===
      JSON.stringify(design.measurementCondition) &&
      JSON.stringify(frame.measurementCondition) ===
        JSON.stringify(detectorCalibrationMeasurementCondition(detector)),
    `${label} measurementCondition must equal the canonical detector-specific study arm`
  );
  const selectionProtocol = requireNonEmptyString(
    design.selectionProtocol,
    `${label} study selectionProtocol`
  );
  requireValue(
    frame.selectionProtocolDigest ===
      createHash("sha256").update(selectionProtocol).digest("hex"),
    `${label} selectionProtocolDigest does not match the preregistered study design`
  );
  requireValue(
    Array.isArray(study.cases) && Array.isArray(frame.cases),
    `${label} and study cases must be arrays`
  );
  requireValue(
    Number.isSafeInteger(study.plannedCases) &&
      (study.plannedCases as number) >= 1 &&
      (study.plannedCases as number) <= 100_000 &&
      frame.cases.length === study.plannedCases &&
      study.cases.length === study.plannedCases,
    `${label} must preserve the complete planned case denominator`
  );
  const studyCases = new Map<string, string>();
  for (const [index, rawStudyCase] of study.cases.entries()) {
    const calibrationCase = requiredRecord(
      rawStudyCase,
      `${label} study.cases[${index}]`
    );
    const caseId = requiredToken(
      calibrationCase.caseId,
      `${label} study.cases[${index}].caseId`
    );
    requireValue(
      !studyCases.has(caseId),
      `${label} study repeats caseId ${caseId}`
    );
    studyCases.set(
      caseId,
      requiredPattern(
        calibrationCase.conditionDigest,
        SHA256,
        `${label} study.cases[${index}].conditionDigest`
      )
    );
  }
  let priorCaseId = "";
  const observed = new Set<string>();
  const selectionConditions = new Set<string>();
  for (const [index, rawFrameCase] of frame.cases.entries()) {
    const caseLabel = `${label}.cases[${index}]`;
    const frameCase = requiredRecord(rawFrameCase, caseLabel);
    requireExactOrderedKeys(
      frameCase,
      [
        "caseId",
        "selectionDigest",
        "conditionDigest",
        "referenceEvidenceDigest"
      ],
      caseLabel
    );
    const caseId = requiredToken(frameCase.caseId, `${caseLabel}.caseId`);
    requireValue(
      caseId.localeCompare(priorCaseId) > 0,
      `${label} case IDs must be unique and sorted`
    );
    priorCaseId = caseId;
    const selectionDigest = requiredPattern(
      frameCase.selectionDigest,
      SHA256,
      `${caseLabel}.selectionDigest`
    );
    const conditionDigest = requiredPattern(
      frameCase.conditionDigest,
      SHA256,
      `${caseLabel}.conditionDigest`
    );
    const referenceEvidenceDigest = requiredPattern(
      frameCase.referenceEvidenceDigest,
      SHA256,
      `${caseLabel}.referenceEvidenceDigest`
    );
    const selectionCondition =
      `${selectionDigest}:${conditionDigest}:${referenceEvidenceDigest}`;
    requireValue(
      !selectionConditions.has(selectionCondition),
      `${label} selection/condition pairs must be unique`
    );
    selectionConditions.add(selectionCondition);
    requireValue(
      studyCases.get(caseId) === conditionDigest,
      `${caseLabel} is not set-equal to the study case identity and condition`
    );
    observed.add(caseId);
  }
  requireValue(
    observed.size === studyCases.size &&
      [...studyCases.keys()].every((caseId) => observed.has(caseId)),
    `${label} must be set-equal to every complete and censored study case`
  );
  return labelSealingKey;
}

function verifyCalibrationLabelSealingKey(
  rootDir: string,
  candidateCommit: string,
  verifyCandidateBlob: boolean,
  measurementInputByPath: Map<string, string>,
  rawValue: unknown,
  studyId: string,
  label: string
): CalibrationLabelSealingKey {
  const descriptor = calibrationLabelSealingKeyDescriptor(
    rawValue,
    studyId,
    label
  );
  const { keyId, publicKeyPath, publicKeySha256 } = descriptor;
  requireValue(
    measurementInputByPath.get(publicKeyPath) === publicKeySha256,
    `${label} public key must be digest-bound by the measurement inputs manifest`
  );
  const publicKeyAbsolute = regularFileInside(
    rootDir,
    publicKeyPath,
    `${label} public key`
  );
  const currentPublicKey = readFileSync(publicKeyAbsolute, "utf8");
  const candidatePublicKey = verifyCandidateBlob
    ? gitBlob(rootDir, candidateCommit, publicKeyPath)
    : currentPublicKey;
  requireValue(
    currentPublicKey === candidatePublicKey &&
      createHash("sha256").update(candidatePublicKey).digest("hex") ===
        publicKeySha256,
    `${label} public key must be byte-identical to its candidate-resident blob`
  );
  let parsedPublicKey;
  try {
    parsedPublicKey = createPublicKey(candidatePublicKey);
  } catch {
    throw new Error(`${label} public key must be valid PEM`);
  }
  requireValue(
    parsedPublicKey.asymmetricKeyType === "rsa" &&
      (parsedPublicKey.asymmetricKeyDetails?.modulusLength ?? 0) >= 2048,
    `${label} public key must be RSA with at least 2048 bits`
  );
  const canonicalPem = parsedPublicKey
    .export({ format: "pem", type: "spki" })
    .toString();
  requireValue(
    candidatePublicKey === canonicalPem,
    `${label} public key must use canonical SPKI PEM bytes`
  );
  requireValue(
    createHash("sha256")
      .update(parsedPublicKey.export({ format: "der", type: "spki" }))
      .digest("hex") === keyId,
    `${label}.keyId must be SHA-256 of the canonical SPKI DER public key`
  );
  return descriptor;
}

function calibrationLabelSealingKeyDescriptor(
  rawValue: unknown,
  studyId: string,
  label: string
): CalibrationLabelSealingKey {
  const value = requiredRecord(rawValue, label);
  requireExactOrderedKeys(
    value,
    ["algorithm", "keyId", "publicKeyPath", "publicKeySha256"],
    label
  );
  requireValue(
    value.algorithm === CALIBRATION_LABEL_SEALING_ALGORITHM,
    `${label}.algorithm must be ${CALIBRATION_LABEL_SEALING_ALGORITHM}`
  );
  const keyId = requiredPattern(value.keyId, SHA256, `${label}.keyId`);
  const publicKeyPath = requiredCanonicalPath(
    value.publicKeyPath,
    `${label}.publicKeyPath`
  );
  requireValue(
    publicKeyPath ===
      `calibration/${studyId}/label-sealing-public-key.pem`,
    `${label}.publicKeyPath must use the fixed study-local candidate path`
  );
  const publicKeySha256 = requiredPattern(
    value.publicKeySha256,
    SHA256,
    `${label}.publicKeySha256`
  );
  return {
    algorithm: CALIBRATION_LABEL_SEALING_ALGORITHM,
    keyId,
    publicKeyPath,
    publicKeySha256
  };
}

function verifyCalibrationCensoringPolicy(
  rootDir: string,
  label: string,
  candidateCommit: string,
  expectedId: string,
  policyPath: string,
  expectedSha256: string,
  verifyCandidateBlob: boolean
): void {
  const policyAbsolute = regularFileInside(
    rootDir,
    policyPath,
    `${label} censoring policy`
  );
  const currentPolicy = readFileSync(policyAbsolute, "utf8");
  const candidatePolicy = verifyCandidateBlob
    ? gitBlob(rootDir, candidateCommit, policyPath)
    : currentPolicy;
  requireValue(
    currentPolicy === candidatePolicy &&
      createHash("sha256").update(candidatePolicy).digest("hex") ===
        expectedSha256,
    `${label} censoring policy must be byte-identical to its candidate-resident blob`
  );
  const policy = readJsonTextObject(
    candidatePolicy,
    `${label} candidate censoring policy`
  );
  requireValue(
    candidatePolicy === `${JSON.stringify(policy, null, 2)}\n`,
    `${label} candidate censoring policy must be canonical serialized JSON`
  );
  requireExactOrderedKeys(
    policy,
    [
      "schemaVersion",
      "artifactKind",
      "id",
      "allowedReasons",
      "releaseEligibility",
      "ratePublicationEligibility"
    ],
    `${label} candidate censoring policy`
  );
  requireValue(
    policy.schemaVersion === MEASUREMENT_CALIBRATION_POLICY_SCHEMA_VERSION &&
      policy.artifactKind ===
        "site-behavior-detector-calibration-censoring-policy" &&
      policy.id === expectedId,
    `${label} candidate censoring policy identity is invalid`
  );
  requireValue(
    JSON.stringify(policy.allowedReasons) ===
      JSON.stringify([
        "capture-failed",
        "reference-label-uncertain",
        "artifact-unreadable",
        "eligibility-criteria-not-met"
      ]),
    `${label} candidate censoring policy reasons must equal the detector analyzer reasons`
  );
  const releaseEligibility = requiredRecord(
    policy.releaseEligibility,
    `${label} candidate censoring policy.releaseEligibility`
  );
  requireExactOrderedKeys(
    releaseEligibility,
    ["anyCensoredCase", "plannedDenominator"],
    `${label} candidate censoring policy.releaseEligibility`
  );
  requireValue(
    releaseEligibility.anyCensoredCase === "study-ineligible" &&
      releaseEligibility.plannedDenominator === "must-remain-complete",
    `${label} candidate censoring policy must match detector analyzer release eligibility`
  );
  const ratePublicationEligibility = requiredRecord(
    policy.ratePublicationEligibility,
    `${label} candidate censoring policy.ratePublicationEligibility`
  );
  requireExactOrderedKeys(
    ratePublicationEligibility,
    [
      "sampling",
      "independentUnits",
      "predictionBlindedToReference",
      "referenceBlindedToPrediction",
      "minimumDenominators",
      "uncertainty",
      "performanceThreshold"
    ],
    `${label} candidate censoring policy.ratePublicationEligibility`
  );
  const minimumDenominators = requiredRecord(
    ratePublicationEligibility.minimumDenominators,
    `${label} candidate censoring policy.ratePublicationEligibility.minimumDenominators`
  );
  requireExactOrderedKeys(
    minimumDenominators,
    [
      "referencePresent",
      "referenceAbsent",
      "predictedDetected",
      "predictedNotDetected"
    ],
    `${label} candidate censoring policy.ratePublicationEligibility.minimumDenominators`
  );
  const uncertainty = requiredRecord(
    ratePublicationEligibility.uncertainty,
    `${label} candidate censoring policy.ratePublicationEligibility.uncertainty`
  );
  requireExactOrderedKeys(
    uncertainty,
    ["method", "confidenceLevel", "maximumWorstCaseHalfWidth"],
    `${label} candidate censoring policy.ratePublicationEligibility.uncertainty`
  );
  requireValue(
    ratePublicationEligibility.sampling === "simple-random" &&
      ratePublicationEligibility.independentUnits === true &&
      ratePublicationEligibility.predictionBlindedToReference === true &&
      ratePublicationEligibility.referenceBlindedToPrediction === true &&
      minimumDenominators.referencePresent ===
        MEASUREMENT_CALIBRATION_MINIMUM_CLASS_DENOMINATOR &&
      minimumDenominators.referenceAbsent ===
        MEASUREMENT_CALIBRATION_MINIMUM_CLASS_DENOMINATOR &&
      minimumDenominators.predictedDetected ===
        MEASUREMENT_CALIBRATION_MINIMUM_CLASS_DENOMINATOR &&
      minimumDenominators.predictedNotDetected ===
        MEASUREMENT_CALIBRATION_MINIMUM_CLASS_DENOMINATOR &&
      uncertainty.method === "wilson-score" &&
      uncertainty.confidenceLevel ===
        MEASUREMENT_CALIBRATION_CONFIDENCE_LEVEL &&
      uncertainty.maximumWorstCaseHalfWidth ===
        MEASUREMENT_CALIBRATION_MAXIMUM_WORST_CASE_HALF_WIDTH &&
      ratePublicationEligibility.performanceThreshold === null,
    `${label} candidate censoring policy must require simple-random blinded independent sampling, four minimum class denominators, Wilson 95% precision, and no performance threshold`
  );
}

export function measurementCalibrationRatePublicationEligibility(): MeasurementCalibrationPolicyProfile["ratePublicationEligibility"] {
  return {
    sampling: "simple-random",
    independentUnits: true,
    predictionBlindedToReference: true,
    referenceBlindedToPrediction: true,
    minimumDenominators: {
      referencePresent:
        MEASUREMENT_CALIBRATION_MINIMUM_CLASS_DENOMINATOR,
      referenceAbsent:
        MEASUREMENT_CALIBRATION_MINIMUM_CLASS_DENOMINATOR,
      predictedDetected:
        MEASUREMENT_CALIBRATION_MINIMUM_CLASS_DENOMINATOR,
      predictedNotDetected:
        MEASUREMENT_CALIBRATION_MINIMUM_CLASS_DENOMINATOR
    },
    uncertainty: {
      method: "wilson-score",
      confidenceLevel: MEASUREMENT_CALIBRATION_CONFIDENCE_LEVEL,
      maximumWorstCaseHalfWidth:
        MEASUREMENT_CALIBRATION_MAXIMUM_WORST_CASE_HALF_WIDTH
    },
    performanceThreshold: null
  };
}

export function measurementCalibrationPolicyDispositionSha256(input: {
  id: string;
  policyArtifactPath: string;
  policyArtifactSha256: string;
  anyCensoredCase: string;
  plannedDenominator: string;
}): string {
  return createHash("sha256")
    .update(MEASUREMENT_CALIBRATION_POLICY_DISPOSITION_DOMAIN)
    .update("\0")
    .update(
      canonicalJson({
        id: input.id,
        policyArtifactPath: input.policyArtifactPath,
        policyArtifactSha256: input.policyArtifactSha256,
        anyCensoredCase: input.anyCensoredCase,
        plannedDenominator: input.plannedDenominator,
        ratePublicationEligibility:
          measurementCalibrationRatePublicationEligibility()
      })
    )
    .digest("hex");
}

function verifyCalibrationPolicyDecision(
  rootDir: string,
  candidateCommit: string,
  bindingPolicy: JsonRecord,
  measurementInputByPath: Map<string, string>,
  verifyCandidateBlobs: boolean
): MeasurementCalibrationPolicyProfile {
  requireExactOrderedKeys(
    bindingPolicy,
    [
      "id",
      "policyArtifactPath",
      "policyArtifactSha256",
      "dispositionSha256"
    ],
    "calibrationPolicy"
  );
  requireValue(
    bindingPolicy.id === MEASUREMENT_CALIBRATION_CENSORING_POLICY_ID,
    `calibrationPolicy.id must name the currently supported analyzer policy ${MEASUREMENT_CALIBRATION_CENSORING_POLICY_ID}; selecting another policy requires changing the analyzer before candidate selection`
  );
  requireValue(
    bindingPolicy.policyArtifactPath ===
      MEASUREMENT_CALIBRATION_CENSORING_POLICY_PATH,
    `calibrationPolicy.policyArtifactPath must be ${MEASUREMENT_CALIBRATION_CENSORING_POLICY_PATH}`
  );
  const policyArtifactSha256 = requiredPattern(
    bindingPolicy.policyArtifactSha256,
    SHA256,
    "calibrationPolicy.policyArtifactSha256"
  );
  const policyText = candidateResidentText(
    rootDir,
    candidateCommit,
    MEASUREMENT_CALIBRATION_CENSORING_POLICY_PATH,
    policyArtifactSha256,
    verifyCandidateBlobs,
    "approved calibration censoring policy"
  );
  requireValue(
    measurementInputByPath.get(MEASUREMENT_CALIBRATION_CENSORING_POLICY_PATH) ===
      policyArtifactSha256,
    "approved calibration censoring policy must be digest-bound by the measurement inputs manifest"
  );
  verifyCalibrationCensoringPolicy(
    rootDir,
    "approved calibration policy",
    candidateCommit,
    MEASUREMENT_CALIBRATION_CENSORING_POLICY_ID,
    MEASUREMENT_CALIBRATION_CENSORING_POLICY_PATH,
    policyArtifactSha256,
    verifyCandidateBlobs
  );
  const dispositionSha256 = measurementCalibrationPolicyDispositionSha256({
    id: MEASUREMENT_CALIBRATION_CENSORING_POLICY_ID,
    policyArtifactPath: MEASUREMENT_CALIBRATION_CENSORING_POLICY_PATH,
    policyArtifactSha256,
    anyCensoredCase: "study-ineligible",
    plannedDenominator: "must-remain-complete"
  });
  requireValue(
    bindingPolicy.dispositionSha256 === dispositionSha256,
    "calibrationPolicy.dispositionSha256 does not bind the selected artifact and analyzer semantics"
  );
  const readinessText = candidateResidentText(
    rootDir,
    candidateCommit,
    "RELEASE_READINESS.json",
    createHash("sha256")
      .update(readFileSync(absoluteRepoPath(rootDir, "RELEASE_READINESS.json")))
      .digest("hex"),
    verifyCandidateBlobs,
    "release readiness decision manifest"
  );
  const readiness = readJsonTextObject(
    readinessText,
    "release readiness decision manifest"
  );
  const decisions = requiredRecord(
    readiness.decisions,
    "release readiness decisions"
  );
  const decision = requiredRecord(
    decisions.calibrationCensoringPolicy,
    "calibrationCensoringPolicy decision"
  );
  const decidedBy = requireNonEmptyString(
    decision.decidedBy,
    "calibrationCensoringPolicy decision.decidedBy"
  );
  const decidedAt = requiredCanonicalInstant(
    decision.decidedAt,
    "calibrationCensoringPolicy decision.decidedAt"
  );
  requireValue(
    decision.status === "approved" &&
      decision.selected === MEASUREMENT_CALIBRATION_CENSORING_POLICY_ID &&
      decision.policyArtifactPath ===
        MEASUREMENT_CALIBRATION_CENSORING_POLICY_PATH &&
      decision.policyArtifactSha256 === policyArtifactSha256 &&
      decision.dispositionSha256 === dispositionSha256,
    "calibrationCensoringPolicy must be explicitly approved by a named human for the exact candidate policy artifact and analyzer disposition"
  );
  // Force a strict parse before returning. The verifier above also enforces
  // canonical candidate residency and exact analyzer semantics.
  readJsonTextObject(policyText, "approved calibration censoring policy");
  return {
    id: MEASUREMENT_CALIBRATION_CENSORING_POLICY_ID,
    policyArtifactPath: MEASUREMENT_CALIBRATION_CENSORING_POLICY_PATH,
    policyArtifactSha256,
    dispositionSha256,
    anyCensoredCase: "study-ineligible",
    plannedDenominator: "must-remain-complete",
    ratePublicationEligibility:
      measurementCalibrationRatePublicationEligibility(),
    decidedBy,
    decidedAt
  };
}

function verifyCalibrationArtifactManifest(
  rootDir: string,
  label: string,
  studyId: string,
  detector: DetectorId,
  study: JsonRecord,
  samplingFrameAbsolute: string,
  manifestAbsolute: string,
  enumeratedPaths: Map<
    string,
    {
      change: MeasurementEvidenceChange;
      sha256: string;
    }
  >
): MeasurementCalibrationArtifact[] {
  const manifestText = readFileSync(manifestAbsolute, "utf8");
  const manifest = readJsonTextObject(
    manifestText,
    `${label} calibration artifact manifest`
  );
  requireValue(
    manifestText === `${JSON.stringify(manifest, null, 2)}\n`,
    `${label} calibration artifact manifest must be canonical serialized JSON`
  );
  requireExactOrderedKeys(
    manifest,
    ["schemaVersion", "artifactKind", "studyId", "artifacts"],
    `${label} calibration artifact manifest`
  );
  requireValue(
    manifest.schemaVersion === 1 &&
      manifest.artifactKind === MEASUREMENT_CALIBRATION_ARTIFACT_MANIFEST_KIND &&
      manifest.studyId === studyId,
    `${label} calibration artifact manifest identity does not match the study`
  );

  const expected = expectedCalibrationArtifacts(
    studyId,
    detector,
    study,
    readJsonObject(
      samplingFrameAbsolute,
      `${label} calibration sampling frame`
    ),
    label
  );
  requireValue(
    Array.isArray(manifest.artifacts),
    `${label} calibration artifact manifest artifacts must be an array`
  );
  const artifacts: MeasurementCalibrationArtifact[] = [];
  const artifactValues = new Map<string, JsonRecord>();
  const observedKeys = new Set<string>();
  let priorPath = "";
  for (const [index, rawArtifact] of manifest.artifacts.entries()) {
    const artifactLabel = `${label} calibration artifact manifest artifacts[${index}]`;
    const artifact = requiredRecord(rawArtifact, artifactLabel);
    requireExactOrderedKeys(
      artifact,
      ["role", "caseId", "path", "sha256"],
      artifactLabel
    );
    const role = requiredCalibrationArtifactRole(
      artifact.role,
      `${artifactLabel}.role`
    );
    const caseId = requiredToken(
      artifact.caseId,
      `${artifactLabel}.caseId`
    );
    const artifactPath = requiredCanonicalPath(
      artifact.path,
      `${artifactLabel}.path`
    );
    requireValue(
      artifactPath.localeCompare(priorPath) > 0,
      `${label} calibration artifact manifest paths must be unique and sorted`
    );
    priorPath = artifactPath;
    const digest = requiredPattern(
      artifact.sha256,
      SHA256,
      `${artifactLabel}.sha256`
    );
    const key = calibrationArtifactKey(role, caseId);
    const expectedArtifact = expected.get(key);
    requireValue(
      expectedArtifact !== undefined,
      `${artifactLabel} is not required by the detector calibration study`
    );
    requireValue(
      artifactPath === expectedArtifact.path,
      `${artifactLabel}.path must be ${expectedArtifact.path}`
    );
    if (expectedArtifact.sha256 !== null) {
      requireValue(
        digest === expectedArtifact.sha256,
        `${artifactLabel}.sha256 must match the digest bound by the detector calibration study or frozen frame`
      );
    }
    requireValue(
      !observedKeys.has(key),
      `${label} calibration artifact manifest repeats ${key}`
    );
    observedKeys.add(key);
    const artifactAbsolute = regularFileInside(
      rootDir,
      artifactPath,
      artifactLabel
    );
    requireValue(
      sha256File(artifactAbsolute) === digest,
      `${artifactLabel} digest does not match the retained artifact bytes`
    );
    const artifactText = readFileSync(artifactAbsolute, "utf8");
    const artifactValue = readJsonTextObject(artifactText, artifactLabel);
    requireValue(
      artifactText === `${JSON.stringify(artifactValue, null, 2)}\n`,
      `${artifactLabel} must be canonical serialized JSON`
    );
    artifactValues.set(key, artifactValue);
    addEnumeratedPath(enumeratedPaths, artifactPath, "added", digest);
    artifacts.push({ role, caseId, path: artifactPath, sha256: digest });
  }
  requireValue(
    [...expected.entries()].every(
      ([key, value]) => !value.required || observedKeys.has(key)
    ),
    `${label} calibration artifact manifest must enumerate every frame input, retained detector input, prediction, evidence, label, adjudication, and attempt artifact required by the study`
  );
  verifyCalibrationRetainedArtifactBindings(
    label,
    studyId,
    detector,
    study,
    artifactValues
  );
  return artifacts;
}

function verifyCalibrationLabelsManifest(
  rootDir: string,
  label: string,
  studyId: string,
  detector: DetectorId,
  identity: {
    commit: string;
    tree: string;
    sourcePath: string;
    sourceSha256: string;
    manifestPath: string;
    manifestSha256: string;
    labelSealingKey: CalibrationLabelSealingKey;
    commitmentSetSha256: string;
    recordedFrom: string;
    recordedThrough: string;
  },
  expectedLabelSealingKey: CalibrationLabelSealingKey,
  artifacts: MeasurementCalibrationArtifact[],
  enumeratedPaths: Map<
    string,
    {
      change: MeasurementEvidenceChange;
      sha256: string;
    }
  >
): void {
  const absolute = regularFileInside(
    rootDir,
    identity.manifestPath,
    `${label} labels manifest`
  );
  requireValue(
    sha256File(absolute) === identity.manifestSha256,
    `${label} labels manifest digest does not match the signed runtime receipt`
  );
  const text = readFileSync(absolute, "utf8");
  const manifest = readJsonTextObject(text, `${label} labels manifest`);
  requireValue(
    text === `${JSON.stringify(manifest, null, 2)}\n`,
    `${label} labels manifest must be canonical serialized JSON`
  );
  requireExactOrderedKeys(
    manifest,
    [
      "schemaVersion",
      "artifactKind",
      "studyId",
      "detector",
      "source",
      "labelSealingKey",
      "authenticatedCommitments",
      "commitmentSetSha256",
      "recordedFrom",
      "recordedThrough",
      "files"
    ],
    `${label} labels manifest`
  );
  requireValue(
    manifest.schemaVersion === 3 &&
      manifest.artifactKind ===
        "site-behavior-detector-calibration-labels-manifest" &&
      manifest.studyId === studyId &&
      manifest.detector === detector &&
      manifest.recordedFrom === identity.recordedFrom &&
      manifest.recordedThrough === identity.recordedThrough,
    `${label} labels manifest identity or recorded label window disagrees with the signed runtime receipt`
  );
  requiredCanonicalInstant(
    manifest.recordedFrom,
    `${label} labels manifest recordedFrom`
  );
  requiredCanonicalInstant(
    manifest.recordedThrough,
    `${label} labels manifest recordedThrough`
  );
  const source = requiredRecord(
    manifest.source,
    `${label} labels manifest source`
  );
  requireExactOrderedKeys(
    source,
    ["commit", "tree", "path", "sha256"],
    `${label} labels manifest source`
  );
  requireValue(
    source.commit === identity.commit &&
      source.tree === identity.tree &&
      source.path === identity.sourcePath &&
      source.sha256 === identity.sourceSha256,
    `${label} labels manifest source must exactly match the signed coordinate-manifest commit, tree, path, and digest`
  );
  const manifestLabelSealingKey = calibrationLabelSealingKeyDescriptor(
    manifest.labelSealingKey,
    studyId,
    `${label} labels manifest labelSealingKey`
  );
  requireValue(
    JSON.stringify(manifestLabelSealingKey) ===
        JSON.stringify(expectedLabelSealingKey) &&
      JSON.stringify(manifestLabelSealingKey) ===
        JSON.stringify(identity.labelSealingKey),
    `${label} labels manifest must bind the exact candidate-pinned label-sealing key`
  );
  requireValue(
    Array.isArray(manifest.authenticatedCommitments) &&
      manifest.authenticatedCommitments.length >= 3 &&
      manifest.authenticatedCommitments.length <= 11,
    `${label} labels manifest authenticatedCommitments must contain 2 through 10 labelers plus one blind tiebreaker`
  );
  const commitmentActors = new Set<string>();
  const commitmentArtifactIds = new Set<number>();
  const commitmentRuns = new Set<string>();
  const commitmentSources = new Set<string>();
  const envelopeCommitments = new Set<string>();
  const ciphertextCommitments = new Set<string>();
  const commitmentTimes: string[] = [];
  const labelerActorTimes = new Map<string, string>();
  let tiebreakerIdentity: {
    actor: string;
    createdAt: string;
    envelopeSha256: string;
  } | null = null;
  let labelerCount = 0;
  let tiebreakerCount = 0;
  let priorCommitmentKey = "";
  for (const [index, rawCommitment] of manifest.authenticatedCommitments.entries()) {
    const commitmentLabel =
      `${label} labels manifest authenticatedCommitments[${index}]`;
    const commitment = requiredRecord(rawCommitment, commitmentLabel);
    requireExactOrderedKeys(
      commitment,
      [
        "role",
        "actor",
        "runId",
        "runAttempt",
        "headSha",
        "artifactId",
        "artifactName",
        "archiveSha256",
        "createdAt",
        "source",
        "algorithm",
        "keyId",
        "envelopeSha256",
        "ciphertextSha256"
      ],
      commitmentLabel
    );
    requireValue(
      commitment.role === "labeler" || commitment.role === "tiebreaker",
      `${commitmentLabel}.role must be labeler or tiebreaker`
    );
    if (commitment.role === "labeler") labelerCount += 1;
    else tiebreakerCount += 1;
    const actor = requireNonEmptyString(
      commitment.actor,
      `${commitmentLabel}.actor`
    );
    requireValue(
      /^(?!-)(?!.*--)[a-z0-9-]{1,39}(?<!-)$/.test(actor),
      `${commitmentLabel}.actor must be one normalized GitHub login`
    );
    const runId = commitment.runId;
    const runAttempt = commitment.runAttempt;
    const artifactId = commitment.artifactId;
    requireValue(
      Number.isSafeInteger(runId) &&
        (runId as number) > 0 &&
        Number.isSafeInteger(runAttempt) &&
        (runAttempt as number) >= 1 &&
        (runAttempt as number) <= 100 &&
        Number.isSafeInteger(artifactId) &&
        (artifactId as number) > 0,
      `${commitmentLabel} must bind positive hosted run, attempt, and artifact ids`
    );
    requiredPattern(
      commitment.headSha,
      FULL_GIT_SHA,
      `${commitmentLabel}.headSha`
    );
    requiredPattern(
      commitment.archiveSha256,
      SHA256,
      `${commitmentLabel}.archiveSha256`
    );
    requireValue(
      commitment.artifactName ===
        `site-behavior-calibration-label-commitment-${commitment.role}-${studyId}-${runId}-${runAttempt}`,
      `${commitmentLabel}.artifactName does not bind its role, study, run, and attempt`
    );
    const createdAt = requiredCanonicalInstant(
      commitment.createdAt,
      `${commitmentLabel}.createdAt`
    );
    const commitmentSource = requiredRecord(
      commitment.source,
      `${commitmentLabel}.source`
    );
    requireExactOrderedKeys(
      commitmentSource,
      ["commit", "tree", "path", "sha256"],
      `${commitmentLabel}.source`
    );
    requiredPattern(
      commitmentSource.commit,
      FULL_GIT_SHA,
      `${commitmentLabel}.source.commit`
    );
    requiredPattern(
      commitmentSource.tree,
      FULL_GIT_SHA,
      `${commitmentLabel}.source.tree`
    );
    requiredCanonicalPath(
      commitmentSource.path,
      `${commitmentLabel}.source.path`
    );
    requiredPattern(
      commitmentSource.sha256,
      SHA256,
      `${commitmentLabel}.source.sha256`
    );
    requireValue(
      commitment.algorithm === expectedLabelSealingKey.algorithm &&
        commitment.keyId === expectedLabelSealingKey.keyId,
      `${commitmentLabel} must bind the candidate-pinned sealing algorithm and key`
    );
    const envelopeSha256 = requiredPattern(
      commitment.envelopeSha256,
      SHA256,
      `${commitmentLabel}.envelopeSha256`
    );
    const ciphertextSha256 = requiredPattern(
      commitment.ciphertextSha256,
      SHA256,
      `${commitmentLabel}.ciphertextSha256`
    );
    const runKey = `${runId}:${runAttempt}`;
    const canonicalKey =
      `${commitment.role === "labeler" ? "0" : "1"}:` +
      `${String(runId).padStart(20, "0")}:` +
      `${String(runAttempt).padStart(3, "0")}:` +
      `${String(artifactId).padStart(20, "0")}`;
    requireValue(
      canonicalKey.localeCompare(priorCommitmentKey) > 0,
      `${label} labels manifest authenticated commitments must be unique and canonically sorted`
    );
    priorCommitmentKey = canonicalKey;
    const sourceKey = canonicalJson(commitmentSource);
    requireValue(
      !commitmentActors.has(actor) &&
        !commitmentArtifactIds.has(artifactId as number) &&
        !commitmentRuns.has(runKey) &&
        !commitmentSources.has(sourceKey) &&
        !envelopeCommitments.has(envelopeSha256) &&
        !ciphertextCommitments.has(ciphertextSha256),
      `${label} labels manifest must use distinct actors, artifacts, workflow runs, sources, envelopes, and ciphertext commitments`
    );
    commitmentActors.add(actor);
    commitmentArtifactIds.add(artifactId as number);
    commitmentRuns.add(runKey);
    commitmentSources.add(sourceKey);
    envelopeCommitments.add(envelopeSha256);
    ciphertextCommitments.add(ciphertextSha256);
    commitmentTimes.push(createdAt);
    if (commitment.role === "labeler") {
      labelerActorTimes.set(`github-${actor}`, createdAt);
    } else {
      tiebreakerIdentity = {
        actor: `github-${actor}`,
        createdAt,
        envelopeSha256
      };
    }
  }
  requireValue(
    labelerCount >= 2 &&
      labelerCount <= 10 &&
      tiebreakerCount === 1,
    `${label} labels manifest must bind 2 through 10 distinct labelers and exactly one independent blind tiebreaker`
  );
  const commitmentSetSha256 = createHash("sha256")
    .update(canonicalJson(manifest.authenticatedCommitments))
    .digest("hex");
  requireValue(
    manifest.commitmentSetSha256 === identity.commitmentSetSha256 &&
      manifest.commitmentSetSha256 === commitmentSetSha256,
    `${label} labels manifest commitmentSetSha256 must derive from the exact authenticated hosted commitment set`
  );
  const orderedCommitmentTimes = [...commitmentTimes].sort();
  requireValue(
    manifest.recordedFrom === orderedCommitmentTimes[0] &&
      manifest.recordedThrough === orderedCommitmentTimes.at(-1),
    `${label} labels manifest recorded window must derive from authenticated artifact creation timestamps`
  );
  requireValue(
    Array.isArray(manifest.files) && manifest.files.length > 0,
    `${label} labels manifest files must be a non-empty array`
  );
  const expected = new Map(
    artifacts
      .filter(
        (artifact) =>
          artifact.role === "label" || artifact.role === "adjudication"
      )
      .map((artifact) => [
        `cases/${artifact.caseId}/${artifact.role}.json`,
        artifact.sha256
      ])
  );
  const observed = new Set<string>();
  let priorPath = "";
  for (const [index, rawFile] of manifest.files.entries()) {
    const fileLabel = `${label} labels manifest files[${index}]`;
    const file = requiredRecord(rawFile, fileLabel);
    requireExactOrderedKeys(file, ["path", "sha256"], fileLabel);
    const filePath = requiredCanonicalPath(file.path, `${fileLabel}.path`);
    requireValue(
      filePath.localeCompare(priorPath) > 0,
      `${label} labels manifest file paths must be unique and sorted`
    );
    priorPath = filePath;
    const digest = requiredPattern(file.sha256, SHA256, `${fileLabel}.sha256`);
    requireValue(
      expected.get(filePath) === digest,
      `${fileLabel} must bind one final label or disagreement adjudication artifact`
    );
    observed.add(filePath);
  }
  for (const artifact of artifacts) {
    if (artifact.role !== "label" && artifact.role !== "adjudication") {
      continue;
    }
    const retained = readJsonObject(
      regularFileInside(
        rootDir,
        artifact.path,
        `${label} authenticated ${artifact.role} artifact`
      ),
      `${label} authenticated ${artifact.role} artifact`
    );
    if (artifact.role === "label") {
      requireValue(
        Array.isArray(retained.labels) &&
          retained.labels.length === labelerActorTimes.size,
        `${label} ${artifact.caseId} retained labels must contain every distinct authenticated labeler exactly once`
      );
      const observedLabelers = new Set<string>();
      for (const [index, rawEntry] of retained.labels.entries()) {
        const entryLabel =
          `${label} ${artifact.caseId} authenticated labels[${index}]`;
        const entry = requiredRecord(rawEntry, entryLabel);
        const labelerId = requireNonEmptyString(
          entry.labelerId,
          `${entryLabel}.labelerId`
        );
        requireValue(
          !observedLabelers.has(labelerId) &&
            labelerActorTimes.get(labelerId) === entry.recordedAt,
          `${entryLabel} must bind one distinct hosted producer actor and its server artifact timestamp`
        );
        observedLabelers.add(labelerId);
      }
      requireValue(
        observedLabelers.size === labelerActorTimes.size &&
          [...labelerActorTimes.keys()].every((actor) =>
            observedLabelers.has(actor)
          ),
        `${label} ${artifact.caseId} retained labels are not set-equal to the authenticated labeler actors`
      );
    } else {
      requireValue(
        tiebreakerIdentity !== null &&
          retained.tiebreakerId === tiebreakerIdentity.actor &&
          retained.committedAt === tiebreakerIdentity.createdAt &&
          retained.tiebreakerCommitmentSha256 ===
            tiebreakerIdentity.envelopeSha256 &&
          retained.resolutionMethod ===
            "blind-precommitted-tiebreaker",
        `${label} ${artifact.caseId} retained disagreement resolution must bind the distinct hosted blind tiebreaker, its pre-acquisition timestamp, and exact ciphertext commitment`
      );
    }
  }
  requireValue(
    observed.size === expected.size &&
      [...expected.keys()].every((filePath) => observed.has(filePath)),
    `${label} labels manifest must be set-equal to every final label and disagreement adjudication artifact`
  );
  addEnumeratedPath(
    enumeratedPaths,
    identity.manifestPath,
    "added",
    identity.manifestSha256
  );
}

function expectedCalibrationArtifacts(
  studyId: string,
  detector: DetectorId,
  study: JsonRecord,
  samplingFrame: JsonRecord,
  label: string
): Map<
  string,
  {
    path: string;
    sha256: string | null;
    required: boolean;
  }
> {
  const expected = new Map<
    string,
    { path: string; sha256: string | null; required: boolean }
  >();
  requireValue(Array.isArray(study.cases), `${label} study.cases must be an array`);
  requireValue(
    Array.isArray(samplingFrame.cases),
    `${label} sampling frame cases must be an array`
  );
  const frameCases = new Map<
    string,
    {
      selectionDigest: string;
      conditionDigest: string;
      referenceEvidenceDigest: string;
    }
  >();
  for (const [index, rawFrameCase] of samplingFrame.cases.entries()) {
    const frameCase = requiredRecord(
      rawFrameCase,
      `${label} sampling frame cases[${index}]`
    );
    const caseId = requiredToken(
      frameCase.caseId,
      `${label} sampling frame cases[${index}].caseId`
    );
    requireValue(
      !frameCases.has(caseId),
      `${label} sampling frame repeats caseId ${caseId}`
    );
    frameCases.set(caseId, {
      selectionDigest: requiredPattern(
        frameCase.selectionDigest,
        SHA256,
        `${label} sampling frame ${caseId} selectionDigest`
      ),
      conditionDigest: requiredPattern(
        frameCase.conditionDigest,
        SHA256,
        `${label} sampling frame ${caseId} conditionDigest`
      ),
      referenceEvidenceDigest: requiredPattern(
        frameCase.referenceEvidenceDigest,
        SHA256,
        `${label} sampling frame ${caseId} referenceEvidenceDigest`
      )
    });
  }
  const caseIds = new Set<string>();
  for (const [index, rawCase] of study.cases.entries()) {
    const caseLabel = `${label} study.cases[${index}]`;
    const calibrationCase = requiredRecord(rawCase, caseLabel);
    const caseId = requiredToken(calibrationCase.caseId, `${caseLabel}.caseId`);
    requireValue(!caseIds.has(caseId), `${label} study repeats caseId ${caseId}`);
    caseIds.add(caseId);
    const frameCase = frameCases.get(caseId);
    requireValue(
      frameCase !== undefined,
      `${caseLabel} is absent from the frozen sampling frame`
    );
    const conditionDigest = requiredPattern(
      calibrationCase.conditionDigest,
      SHA256,
      `${caseLabel}.conditionDigest`
    );
    requireValue(
      conditionDigest === frameCase.conditionDigest,
      `${caseLabel}.conditionDigest disagrees with the frozen sampling frame`
    );
    addExpectedCalibrationArtifact(
      expected,
      studyId,
      caseId,
      "selection",
      frameCase.selectionDigest,
      `${caseLabel} frozen selection digest`
    );
    addExpectedCalibrationArtifact(
      expected,
      studyId,
      caseId,
      "condition",
      conditionDigest,
      `${caseLabel}.conditionDigest`
    );
    if (calibrationCase.outcome === "complete") {
      addExpectedCalibrationArtifact(
        expected,
        studyId,
        caseId,
        "source-report",
        null,
        `${caseLabel} retained source report`
      );
      if (detector === "consent-banner") {
        addExpectedCalibrationArtifact(
          expected,
          studyId,
          caseId,
          "detector-observation",
          null,
          `${caseLabel} retained private detector observation`
        );
      }
      const prediction = requiredRecord(
        calibrationCase.prediction,
        `${caseLabel}.prediction`
      );
      const reference = requiredRecord(
        calibrationCase.reference,
        `${caseLabel}.reference`
      );
      addExpectedCalibrationArtifact(
        expected,
        studyId,
        caseId,
        "prediction",
        prediction.artifactDigest,
        `${caseLabel}.prediction.artifactDigest`
      );
      addExpectedCalibrationArtifact(
        expected,
        studyId,
        caseId,
        "evidence",
        frameCase.referenceEvidenceDigest,
        `${caseLabel}.reference.evidenceArtifactDigest`
      );
      requireValue(
        reference.evidenceArtifactDigest ===
          frameCase.referenceEvidenceDigest,
        `${caseLabel}.reference.evidenceArtifactDigest must equal the frozen pre-acquisition reference evidence digest`
      );
      addExpectedCalibrationArtifact(
        expected,
        studyId,
        caseId,
        "label",
        reference.labelArtifactDigest,
        `${caseLabel}.reference.labelArtifactDigest`
      );
      const adjudication = requiredRecord(
        reference.adjudication,
        `${caseLabel}.reference.adjudication`
      );
      if (
        adjudication.status ===
        "disagreement-resolved-by-blind-tiebreaker"
      ) {
        addExpectedCalibrationArtifact(
          expected,
          studyId,
          caseId,
          "adjudication",
          adjudication.artifactDigest,
          `${caseLabel}.reference.adjudication.artifactDigest`
        );
      } else {
        requireValue(
          adjudication.status === "labelers-agreed" &&
            adjudication.artifactDigest === null,
          `${caseLabel}.reference.adjudication must be one supported calibration state`
        );
      }
    } else if (calibrationCase.outcome === "censored") {
      addExpectedCalibrationArtifact(
        expected,
        studyId,
        caseId,
        "source-report",
        null,
        `${caseLabel} optional retained source report`,
        false
      );
      addExpectedCalibrationArtifact(
        expected,
        studyId,
        caseId,
        "attempt",
        calibrationCase.attemptArtifactDigest,
        `${caseLabel}.attemptArtifactDigest`
      );
    } else {
      throw new Error(`${caseLabel}.outcome must be complete or censored`);
    }
  }
  return expected;
}

function verifyCalibrationRetainedArtifactBindings(
  label: string,
  studyId: string,
  detector: DetectorId,
  study: JsonRecord,
  artifacts: Map<string, JsonRecord>
): void {
  requireValue(Array.isArray(study.cases), `${label} study.cases must be an array`);
  if (detector === "pixel-events") {
    const targetPopulation = requireNonEmptyString(
      study.targetPopulation,
      `${label} study.targetPopulation`
    );
    requireValue(
      /consent[- ]accepted/i.test(targetPopulation) &&
        /GPC[- ]disabled/i.test(targetPopulation),
      `${label} pixel-events rates must name a consent-accepted, GPC-disabled target population`
    );
  }
  const artifact = (
    role: MeasurementCalibrationArtifactRole,
    caseId: string
  ): JsonRecord => {
    const value = artifacts.get(calibrationArtifactKey(role, caseId));
    requireValue(
      value !== undefined,
      `${label} ${caseId} must retain its ${role} artifact`
    );
    return value;
  };
  const artifactDigest = (value: JsonRecord): string =>
    createHash("sha256")
      .update(`${JSON.stringify(value, null, 2)}\n`)
      .digest("hex");

  for (const [index, rawCase] of study.cases.entries()) {
    const caseLabel = `${label} study.cases[${index}]`;
    const calibrationCase = requiredRecord(rawCase, caseLabel);
    const caseId = requiredToken(calibrationCase.caseId, `${caseLabel}.caseId`);
    const conditionDigest = requiredPattern(
      calibrationCase.conditionDigest,
      SHA256,
      `${caseLabel}.conditionDigest`
    );
    const selection = artifact("selection", caseId);
    requireExactOrderedKeys(
      selection,
      ["schemaVersion", "artifactKind", "studyId", "detector", "caseId", "url"],
      `${caseLabel} retained selection`
    );
    requireValue(
      selection.schemaVersion === 1 &&
        selection.artifactKind ===
          "site-behavior-detector-calibration-selection" &&
        selection.studyId === studyId &&
        selection.detector === detector &&
        selection.caseId === caseId,
      `${caseLabel} retained selection identity is invalid`
    );
    const selectionUrl = requireNonEmptyString(
      selection.url,
      `${caseLabel} retained selection.url`
    );
    let parsedSelectionUrl: URL;
    try {
      parsedSelectionUrl = new URL(selectionUrl);
    } catch {
      throw new Error(`${caseLabel} retained selection URL is invalid`);
    }
    requireValue(
      parsedSelectionUrl.protocol === "https:" &&
        parsedSelectionUrl.username === "" &&
        parsedSelectionUrl.password === "" &&
        parsedSelectionUrl.hash === "",
      `${caseLabel} retained selection URL must be credential-free HTTPS without a fragment`
    );

    const condition = artifact("condition", caseId);
    requireExactOrderedKeys(
      condition,
      ["schemaVersion", "artifactKind", "studyId", "detector", "caseId", "request"],
      `${caseLabel} retained condition`
    );
    requireValue(
      condition.schemaVersion === 1 &&
        condition.artifactKind ===
          "site-behavior-detector-calibration-condition" &&
        condition.studyId === studyId &&
        condition.detector === detector &&
        condition.caseId === caseId,
      `${caseLabel} retained condition identity is invalid`
    );
    const request = requiredRecord(
      condition.request,
      `${caseLabel} retained condition.request`
    );
    requireExactOrderedKeys(
      request,
      ["device", "gpcEnabled", "consentMode"],
      `${caseLabel} retained condition.request`
    );
    const expectedCondition =
      detectorCalibrationMeasurementCondition(detector);
    requireValue(
      request.device === expectedCondition.device &&
        request.gpcEnabled === expectedCondition.gpcEnabled &&
        request.consentMode === expectedCondition.consentMode,
      detector === "pixel-events"
        ? `${caseLabel} pixel-events calibration must use the fixed consent-accepted, GPC-disabled arm`
        : `${caseLabel} retained condition must use one supported passive observation request`
    );

    const sourceReport =
      artifacts.get(calibrationArtifactKey("source-report", caseId)) ?? null;
    let sourceReportSha256: string | null = null;
    let sourceRun: JsonRecord | null = null;
    if (sourceReport !== null) {
      requireValue(
        sourceReport.schemaVersion === 2 &&
          sourceReport.schemaRevision === 2 &&
          sourceReport.reportType === "single",
        `${caseLabel} retained source report must be one public v2/r2 single report`
      );
      sourceRun = requiredRecord(
        sourceReport.run,
        `${caseLabel} retained source report.run`
      );
      const sourceConditions = requiredRecord(
        sourceRun.conditions,
        `${caseLabel} retained source report.run.conditions`
      );
      const sourceDevice = requiredRecord(
        sourceConditions.device,
        `${caseLabel} retained source report.run.conditions.device`
      );
      requireValue(
        sourceDevice.kind === request.device &&
          sourceConditions.gpc === request.gpcEnabled &&
          sourceConditions.consent === request.consentMode,
        `${caseLabel} retained source report conditions must equal the frozen case condition`
      );
      sourceReportSha256 = artifactDigest(sourceReport);
    }

    if (calibrationCase.outcome === "complete") {
      requireValue(
        sourceRun !== null && sourceReportSha256 !== null,
        `${caseLabel} complete case must retain one source report`
      );
      const prediction = artifact("prediction", caseId);
      requireExactOrderedKeys(
        prediction,
        [
          "schemaVersion",
          "artifactKind",
          "studyId",
          "detector",
          "caseId",
          "conditionDigest",
          "sourceReportSha256",
          "value",
          "recordedAt"
        ],
        `${caseLabel} retained prediction`
      );
      const studyPrediction = requiredRecord(
        calibrationCase.prediction,
        `${caseLabel}.prediction`
      );
      requireValue(
        prediction.schemaVersion === 1 &&
          prediction.artifactKind ===
            "site-behavior-detector-calibration-prediction" &&
          prediction.studyId === studyId &&
          prediction.detector === detector &&
          prediction.caseId === caseId &&
          prediction.conditionDigest === conditionDigest &&
          prediction.sourceReportSha256 === sourceReportSha256 &&
          prediction.value === studyPrediction.value,
        `${caseLabel} retained prediction identity or source-report binding is invalid`
      );
      requiredCanonicalInstant(
        prediction.recordedAt,
        `${caseLabel} retained prediction.recordedAt`
      );
      let recomputedPrediction: "detected" | "not-detected";
      if (detector === "consent-banner") {
        const observation = artifact("detector-observation", caseId);
        requireExactOrderedKeys(
          observation,
          [
            "schemaVersion",
            "artifactKind",
            "studyId",
            "detector",
            "caseId",
            "sourceReportSha256",
            "observation"
          ],
          `${caseLabel} retained private detector observation`
        );
        requireValue(
          observation.schemaVersion === 1 &&
            observation.artifactKind ===
              "site-behavior-detector-calibration-private-observation" &&
            observation.studyId === studyId &&
            observation.detector === detector &&
            observation.caseId === caseId &&
            observation.sourceReportSha256 === sourceReportSha256,
          `${caseLabel} retained private detector observation identity is invalid`
        );
        const observedFact = requiredRecord(
          observation.observation,
          `${caseLabel} retained private detector observation.observation`
        );
        requireExactOrderedKeys(
          observedFact,
          ["detector", "method", "phaseId", "outcome", "visible"],
          `${caseLabel} retained private detector observation.observation`
        );
        requireValue(
          observedFact.detector === "consent-banner" &&
            observedFact.method === "banner-visibility@1" &&
            Number.isSafeInteger(observedFact.phaseId) &&
            (observedFact.phaseId as number) >= 0 &&
            observedFact.outcome === "complete" &&
            typeof observedFact.visible === "boolean",
          `${caseLabel} retained private detector observation shape is invalid`
        );
        const detectors = requiredRecord(
          sourceRun.detectors,
          `${caseLabel} retained source report.run.detectors`
        );
        const ledger = requiredRecord(
          detectors["consent-banner"],
          `${caseLabel} retained consent detector ledger`
        );
        requireValue(
          Array.isArray(sourceRun.phases),
          `${caseLabel} retained source report.run.phases must be an array`
        );
        const matchingPhases = sourceRun.phases.filter(
          (phase) =>
            isRecord(phase) && phase.phaseId === observedFact.phaseId
        );
        requireValue(
          ledger.status === "complete" &&
            ledger.phaseId === observedFact.phaseId &&
            matchingPhases.length === 1 &&
            matchingPhases[0].kind === "passive-load",
          `${caseLabel} consent observation must link to one complete passive detector phase`
        );
        recomputedPrediction = observedFact.visible
          ? "detected"
          : "not-detected";
      } else {
        recomputedPrediction = calibrationPredictionFromReportRun(
          sourceRun,
          detector,
          caseLabel
        );
      }
      requireValue(
        prediction.value === recomputedPrediction,
        `${caseLabel} retained detector input does not reproduce the prediction`
      );
      const studyReference = requiredRecord(
        calibrationCase.reference,
        `${caseLabel}.reference`
      );
      const referenceEvidence = artifact("evidence", caseId);
      requireExactOrderedKeys(
        referenceEvidence,
        [
          "schemaVersion",
          "artifactKind",
          "studyId",
          "detector",
          "caseId",
          "blindingNonce",
          "source",
          "observations"
        ],
        `${caseLabel} retained reference evidence`
      );
      requireValue(
        referenceEvidence.schemaVersion === 1 &&
          referenceEvidence.artifactKind ===
            "site-behavior-detector-calibration-reference-evidence" &&
          referenceEvidence.studyId === studyId &&
          referenceEvidence.detector === detector &&
          referenceEvidence.caseId === caseId,
        `${caseLabel} retained reference evidence identity is invalid`
      );
      requiredPattern(
        referenceEvidence.blindingNonce,
        SHA256,
        `${caseLabel} retained reference evidence.blindingNonce`
      );
      const referenceSource = requiredRecord(
        referenceEvidence.source,
        `${caseLabel} retained reference evidence.source`
      );
      requireExactOrderedKeys(
        referenceSource,
        ["kind", "locator", "observedAt"],
        `${caseLabel} retained reference evidence.source`
      );
      requireValue(
        referenceSource.kind === "authoritative-record" ||
          referenceSource.kind === "independent-capture" ||
          referenceSource.kind === "human-observation",
        `${caseLabel} retained reference evidence source kind is invalid`
      );
      requireValue(
        /^urn:sbl:reference:sha256:[0-9a-f]{64}$/.test(
          requireNonEmptyString(
            referenceSource.locator,
            `${caseLabel} retained reference evidence source.locator`
          )
        ),
        `${caseLabel} retained reference evidence source.locator must be an opaque digest URN`
      );
      requiredCanonicalInstant(
        referenceSource.observedAt,
        `${caseLabel} retained reference evidence source.observedAt`
      );
      requireValue(
        Array.isArray(referenceEvidence.observations) &&
          referenceEvidence.observations.length >= 1 &&
          referenceEvidence.observations.length <= 1_000,
        `${caseLabel} retained reference evidence must contain 1 through 1000 closed observations`
      );
      let priorFact = "";
      const expectedPresenceFact = `${detector}-presence`;
      let presenceValue: boolean | null = null;
      for (const [observationIndex, rawObservation] of referenceEvidence.observations.entries()) {
        const observationLabel =
          `${caseLabel} retained reference evidence observations[${observationIndex}]`;
        const observation = requiredRecord(rawObservation, observationLabel);
        requireExactOrderedKeys(
          observation,
          ["fact", "value"],
          observationLabel
        );
        const fact = requiredToken(
          observation.fact,
          `${observationLabel}.fact`
        );
        requireValue(
          fact.localeCompare(priorFact) > 0,
          `${caseLabel} retained reference evidence facts must be unique and sorted`
        );
        priorFact = fact;
        if (fact === expectedPresenceFact) {
          requireValue(
            typeof observation.value === "boolean",
            `${observationLabel}.value must be boolean for ${expectedPresenceFact}`
          );
          presenceValue = observation.value as boolean;
        } else if (fact === "observation-count") {
          requireValue(
            Number.isSafeInteger(observation.value) &&
              (observation.value as number) >= 0 &&
              (observation.value as number) <= 1_000_000,
            `${observationLabel}.value must be an integer from 0 through 1000000 for observation-count`
          );
        } else {
          throw new Error(
            `${observationLabel}.fact is outside the public-safe detector evidence vocabulary`
          );
        }
      }
      requireValue(
        presenceValue !== null &&
          presenceValue === (studyReference.value === "present"),
        `${caseLabel} retained reference detector-presence fact must exist and match the final reference value`
      );
      requireValue(
        artifactDigest(referenceEvidence) ===
          studyReference.evidenceArtifactDigest,
        `${caseLabel} retained reference evidence bytes disagree with study.json`
      );
      const retainedLabel = artifact("label", caseId);
      requireExactOrderedKeys(
        retainedLabel,
        [
          "schemaVersion",
          "artifactKind",
          "studyId",
          "detector",
          "caseId",
          "evidenceSha256",
          "labels"
        ],
        `${caseLabel} retained human label`
      );
      requireValue(
        retainedLabel.schemaVersion === 1 &&
          retainedLabel.artifactKind ===
            "site-behavior-detector-calibration-label" &&
          retainedLabel.studyId === studyId &&
          retainedLabel.detector === detector &&
          retainedLabel.caseId === caseId &&
          retainedLabel.evidenceSha256 ===
            studyReference.evidenceArtifactDigest &&
          artifactDigest(retainedLabel) ===
            studyReference.labelArtifactDigest &&
          Array.isArray(retainedLabel.labels) &&
          retainedLabel.labels.length >= 2 &&
          retainedLabel.labels.length <= 10,
        `${caseLabel} retained human label identity or evidence binding is invalid`
      );
      const studyLabelerIds = Array.isArray(studyReference.labelerIds)
        ? studyReference.labelerIds
        : [];
      const retainedValues = new Set<string>();
      let priorLabelerId = "";
      for (const [labelIndex, rawLabelEntry] of retainedLabel.labels.entries()) {
        const entryLabel =
          `${caseLabel} retained human label labels[${labelIndex}]`;
        const labelEntry = requiredRecord(rawLabelEntry, entryLabel);
        requireExactOrderedKeys(
          labelEntry,
          ["labelerId", "value", "recordedAt"],
          entryLabel
        );
        const labelerId = requireNonEmptyString(
          labelEntry.labelerId,
          `${entryLabel}.labelerId`
        );
        requireValue(
          /^github-(?!-)(?!.*--)[a-z0-9-]{1,39}(?<!-)$/.test(labelerId) &&
            labelerId.localeCompare(priorLabelerId) > 0,
          `${caseLabel} retained labeler ids must be distinct sorted authenticated GitHub identities`
        );
        priorLabelerId = labelerId;
        requireValue(
          labelEntry.value === "present" ||
            labelEntry.value === "absent",
          `${entryLabel}.value is invalid`
        );
        retainedValues.add(labelEntry.value as string);
        requiredCanonicalInstant(
          labelEntry.recordedAt,
          `${entryLabel}.recordedAt`
        );
      }
      requireValue(
        JSON.stringify(studyLabelerIds) ===
          JSON.stringify(
            retainedLabel.labels.map(
              (entry) => (entry as JsonRecord).labelerId
            )
          ),
        `${caseLabel}.reference.labelerIds must exactly match the retained authenticated labels`
      );
      const studyAdjudication = requiredRecord(
        studyReference.adjudication,
        `${caseLabel}.reference.adjudication`
      );
      if (retainedValues.size === 1) {
        requireValue(
          studyReference.value ===
            (retainedLabel.labels[0] as JsonRecord).value &&
            studyAdjudication.status === "labelers-agreed" &&
            studyAdjudication.tiebreakerId === null &&
            studyAdjudication.artifactDigest === null &&
            !artifacts.has(calibrationArtifactKey("adjudication", caseId)),
          `${caseLabel} agreed labels must directly determine the reference value without adjudication`
        );
      } else {
        const retainedAdjudication = artifact("adjudication", caseId);
        requireExactOrderedKeys(
          retainedAdjudication,
          [
            "schemaVersion",
            "artifactKind",
            "studyId",
            "detector",
            "caseId",
            "evidenceSha256",
            "labelSha256",
            "labelSetSha256",
            "resolutionMethod",
            "tiebreakerId",
            "tiebreakerCommitmentSha256",
            "value",
            "committedAt"
          ],
          `${caseLabel} retained adjudication`
        );
        requireValue(
            retainedAdjudication.schemaVersion === 1 &&
            retainedAdjudication.artifactKind ===
              "site-behavior-detector-calibration-blind-tiebreaker-resolution" &&
            retainedAdjudication.studyId === studyId &&
            retainedAdjudication.detector === detector &&
            retainedAdjudication.caseId === caseId &&
            retainedAdjudication.evidenceSha256 ===
              studyReference.evidenceArtifactDigest &&
            retainedAdjudication.labelSha256 ===
              studyReference.labelArtifactDigest &&
            retainedAdjudication.labelSetSha256 ===
              createHash("sha256")
                .update("site-behavior-calibration-label-set-v1")
                .update("\0")
                .update(caseId)
                .update("\0")
                .update(
                  canonicalJson(
                    retainedLabel.labels.map((entry) => ({
                      actor: String((entry as JsonRecord).labelerId).replace(
                        /^github-/,
                        ""
                      ),
                      value: (entry as JsonRecord).value,
                      recordedAt: (entry as JsonRecord).recordedAt
                    }))
                  )
                )
                .digest("hex") &&
            retainedAdjudication.resolutionMethod ===
              "blind-precommitted-tiebreaker" &&
            /^github-(?!-)(?!.*--)[a-z0-9-]{1,39}(?<!-)$/.test(
              requireNonEmptyString(
                retainedAdjudication.tiebreakerId,
                `${caseLabel} retained adjudication.tiebreakerId`
              )
            ) &&
            !studyLabelerIds.includes(retainedAdjudication.tiebreakerId) &&
            SHA256.test(
              requireNonEmptyString(
                retainedAdjudication.tiebreakerCommitmentSha256,
                `${caseLabel} retained adjudication.tiebreakerCommitmentSha256`
              )
            ) &&
            (retainedAdjudication.value === "present" ||
              retainedAdjudication.value === "absent") &&
            retainedAdjudication.value === studyReference.value &&
            studyAdjudication.status ===
              "disagreement-resolved-by-blind-tiebreaker" &&
            studyAdjudication.tiebreakerId ===
              retainedAdjudication.tiebreakerId &&
            studyAdjudication.artifactDigest ===
              artifactDigest(retainedAdjudication),
          `${caseLabel} retained adjudication is not a distinct identity-bound resolution of the exact disagreement`
        );
        requiredCanonicalInstant(
          retainedAdjudication.committedAt,
          `${caseLabel} retained adjudication.committedAt`
        );
      }
    } else if (calibrationCase.outcome === "censored") {
      const attempt = artifact("attempt", caseId);
      requireExactOrderedKeys(
        attempt,
        [
          "schemaVersion",
          "artifactKind",
          "studyId",
          "detector",
          "caseId",
          "conditionDigest",
          "outcome",
          "reason",
          "sourceReportSha256",
          "recordedAt"
        ],
        `${caseLabel} retained attempt`
      );
      requireValue(
        attempt.schemaVersion === 1 &&
          attempt.artifactKind ===
            "site-behavior-detector-calibration-attempt" &&
          attempt.studyId === studyId &&
          attempt.detector === detector &&
          attempt.caseId === caseId &&
          attempt.conditionDigest === conditionDigest &&
          attempt.outcome === "censored" &&
          attempt.reason === calibrationCase.reason &&
          attempt.sourceReportSha256 === sourceReportSha256,
        `${caseLabel} retained attempt identity or source-report binding is invalid`
      );
      requiredCanonicalInstant(
        attempt.recordedAt,
        `${caseLabel} retained attempt.recordedAt`
      );
      requireValue(
        !artifacts.has(calibrationArtifactKey("detector-observation", caseId)),
        `${caseLabel} censored case cannot retain a completed private detector observation`
      );
    } else {
      throw new Error(`${caseLabel}.outcome must be complete or censored`);
    }
  }
}

function calibrationPredictionFromReportRun(
  run: JsonRecord,
  detector: Exclude<DetectorId, "consent-banner">,
  label: string
): "detected" | "not-detected" {
  const quality = requiredRecord(run.quality, `${label} source report quality`);
  const runQuality = requiredRecord(
    quality.run,
    `${label} source report quality.run`
  );
  requireValue(
    runQuality.outcome === "complete",
    `${label} source report does not reproduce a complete scan`
  );
  const detectors = requiredRecord(
    run.detectors,
    `${label} source report detectors`
  );
  const ledger = requiredRecord(
    detectors[detector],
    `${label} source report detector ledger ${detector}`
  );
  requireValue(
    ledger.status === "complete",
    `${label} source report detector ledger is not complete`
  );
  const evidence = requiredRecord(
    run.evidence,
    `${label} source report evidence`
  );
  let detected: boolean;
  if (
    detector === "fingerprint-heuristics" ||
    detector === "keystroke-exfiltration"
  ) {
    requireValue(
      Array.isArray(evidence.fingerprintDetections),
      `${label} source report fingerprint detections are missing`
    );
    detected = evidence.fingerprintDetections.some(
      (entry) =>
        isRecord(entry) &&
        (detector === "keystroke-exfiltration"
          ? entry.kind === "keystroke-exfiltration"
          : entry.kind !== "keystroke-exfiltration")
    );
  } else if (detector === "cname-uncloaking") {
    requireValue(
      Array.isArray(evidence.cnameCloaks),
      `${label} source report CNAME evidence is missing`
    );
    detected = evidence.cnameCloaks.length > 0;
  } else if (detector === "pixel-events") {
    const conditions = requiredRecord(
      run.conditions,
      `${label} source report conditions`
    );
    const consent = requiredRecord(
      evidence.consent,
      `${label} source report registered consent evidence`
    );
    let derivedChoiceState:
      | "verified"
      | "contradicted"
      | "failed"
      | "weak-signal"
      | "unavailable"
      | null = null;
    let derivedReverifiedAfterReload = false;
    try {
      derivedChoiceState = deriveChoiceStateR2(
        run as unknown as ScanRunV2R2,
        consent as unknown as ConsentEvidenceR2
      );
      derivedReverifiedAfterReload = deriveReverifiedAfterReloadR2(
        run as unknown as ScanRunV2R2,
        consent as unknown as ConsentEvidenceR2
      );
    } catch {
      // A malformed retained ledger is ineligible. Never fall back to the
      // producer-supplied summary fields.
    }
    requireValue(
      conditions.consent === "accept-all" &&
        consent.mode === "accept-all" &&
        consent.interactionAttempted === true &&
        consent.controlActivated === true &&
        consent.choiceState === derivedChoiceState &&
        derivedChoiceState === "verified" &&
        consent.reverifiedAfterReload ===
          derivedReverifiedAfterReload &&
        derivedReverifiedAfterReload === true,
      `${label} pixel-events complete case must independently derive verified registered consent after reload`
    );
    requireValue(
      Array.isArray(evidence.pixelEvents),
      `${label} source report pixel evidence is missing`
    );
    detected = evidence.pixelEvents.length > 0;
  } else if (detector === "privacy-policy") {
    detected = evidence.privacyPolicy !== undefined;
  } else {
    throw new Error(`${label} source report names unsupported detector ${detector}`);
  }
  return detected ? "detected" : "not-detected";
}

function addExpectedCalibrationArtifact(
  expected: Map<
    string,
    { path: string; sha256: string | null; required: boolean }
  >,
  studyId: string,
  caseId: string,
  role: MeasurementCalibrationArtifactRole,
  digest: unknown,
  label: string,
  required: boolean = true
): void {
  const key = calibrationArtifactKey(role, caseId);
  requireValue(!expected.has(key), `detector calibration study repeats ${key}`);
  expected.set(key, {
    path: `calibration/${studyId}/artifacts/${caseId}/${role}.json`,
    sha256: digest === null ? null : requiredPattern(digest, SHA256, label),
    required
  });
}

function calibrationArtifactKey(
  role: MeasurementCalibrationArtifactRole,
  caseId: string
): string {
  return `${caseId}:${role}`;
}

function requiredCalibrationArtifactRole(
  value: unknown,
  label: string
): MeasurementCalibrationArtifactRole {
  const roles = new Set<MeasurementCalibrationArtifactRole>([
    "selection",
    "condition",
    "source-report",
    "detector-observation",
    "prediction",
    "evidence",
    "label",
    "adjudication",
    "attempt"
  ]);
  requireValue(
    typeof value === "string" &&
      roles.has(value as MeasurementCalibrationArtifactRole),
    `${label} is not a supported calibration artifact role`
  );
  return value as MeasurementCalibrationArtifactRole;
}

function verifyDurablePrerequisite(
  rootDir: string,
  candidateCommit: string,
  durable: JsonRecord,
  verifyCandidateBlobs: boolean,
  durableReplayVerifier:
    | ((request: MeasurementDurableReplayVerificationRequest) => void)
    | undefined,
  operatorEvidenceVerifier:
    | ((request: MeasurementOperatorEvidenceVerificationRequest) => void)
    | undefined,
  stagingTeardownProvenanceVerifier:
    | ((
        request: MeasurementStagingTeardownProvenanceVerificationRequest
      ) => void)
    | undefined
): DurableEnableTransition {
  requireExactOrderedKeys(
    durable,
    ["config", "replay", "stagingTeardown", "transition", "soak"],
    "durablePrerequisite"
  );
  const config = requiredRecord(
    durable.config,
    "durablePrerequisite.config"
  );
  requireExactOrderedKeys(
    config,
    ["path", "sha256"],
    "durablePrerequisite.config"
  );
  requireValue(
    config.path === MEASUREMENT_DURABLE_CONFIG_PATH,
    `durablePrerequisite.config.path must be ${MEASUREMENT_DURABLE_CONFIG_PATH}`
  );
  const configSha256 = requiredPattern(
    config.sha256,
    SHA256,
    "durablePrerequisite.config.sha256"
  );
  const currentConfig = readFileSync(
    regularFileInside(
      rootDir,
      MEASUREMENT_DURABLE_CONFIG_PATH,
      "durable prerequisite config"
    ),
    "utf8"
  );
  const candidateConfig = verifyCandidateBlobs
    ? gitBlob(rootDir, candidateCommit, MEASUREMENT_DURABLE_CONFIG_PATH)
    : currentConfig;
  const enabledMarker = '"SITE_BEHAVIOR_LAB_DURABLE_JOBS": "1"';
  const disabledMarker = '"SITE_BEHAVIOR_LAB_DURABLE_JOBS": "0"';
  requireValue(
    currentConfig === candidateConfig &&
      createHash("sha256").update(candidateConfig).digest("hex") ===
        configSha256 &&
      candidateConfig.split(enabledMarker).length === 2 &&
      !candidateConfig.includes(disabledMarker),
    "candidate must preserve the exact digest-bound production durable=1 configuration"
  );

  const replay = requiredRecord(
    durable.replay,
    "durablePrerequisite.replay"
  );
  requireExactOrderedKeys(
    replay,
    [
      "deploymentCommit",
      "receiptSetDigest",
      "evidenceStartedAt",
      "evidenceCapturedAt",
      "receipts"
    ],
    "durablePrerequisite.replay"
  );
  const replayDeploymentCommit = requiredPattern(
    replay.deploymentCommit,
    FULL_GIT_SHA,
    "durablePrerequisite.replay.deploymentCommit"
  );
  const replayReceiptSetDigest = requiredPattern(
    replay.receiptSetDigest,
    SHA256,
    "durablePrerequisite.replay.receiptSetDigest"
  );
  const replayEvidenceStartedAt = requiredCanonicalInstant(
    replay.evidenceStartedAt,
    "durablePrerequisite.replay.evidenceStartedAt"
  );
  const replayEvidenceCapturedAt = requiredCanonicalInstant(
    replay.evidenceCapturedAt,
    "durablePrerequisite.replay.evidenceCapturedAt"
  );
  requireValue(
    Date.parse(replayEvidenceCapturedAt) > Date.parse(replayEvidenceStartedAt),
    "durable replay capture must end after it starts"
  );
  requireValue(
    Array.isArray(replay.receipts) && replay.receipts.length === 2,
    "durablePrerequisite.replay.receipts must contain exactly two receipts"
  );
  const replayReceipts: DurableEnableTransition["replayReceipts"] = [];
  const replayValues: JsonRecord[] = [];
  for (const [index, mode] of ["lease-expiry", "lost-resolve"].entries()) {
    const label = `durablePrerequisite.replay.receipts[${index}]`;
    const entry = requiredRecord(replay.receipts[index], label);
    requireExactOrderedKeys(entry, ["mode", "path", "sha256"], label);
    requireValue(entry.mode === mode, `${label}.mode must be ${mode}`);
    const receiptPath = requiredCanonicalPath(entry.path, `${label}.path`);
    requireValue(
      receiptPath ===
        `research/ops-receipts/durable-replay/${replayDeploymentCommit}-${mode}.json`,
      `${label}.path must be the fixed replay receipt path for its deployment and mode`
    );
    const receiptSha256 = requiredPattern(
      entry.sha256,
      SHA256,
      `${label}.sha256`
    );
    const absolute = regularFileInside(rootDir, receiptPath, label);
    const currentBytes = readFileSync(absolute);
    const candidateBytes = verifyCandidateBlobs
      ? Buffer.from(gitBlob(rootDir, candidateCommit, receiptPath), "utf8")
      : currentBytes;
    requireValue(
      currentBytes.equals(candidateBytes) &&
        createHash("sha256").update(candidateBytes).digest("hex") ===
          receiptSha256,
      `${label} must be byte-identical to its candidate-resident blob`
    );
    const value = readJsonTextObject(
      currentBytes.toString("utf8"),
      `${label} receipt`
    );
    requireValue(
      value.kind === "site-behavior-durable-replay-receipt" &&
        value.receiptVersion === 1 &&
        value.mode === mode &&
        value.expectedDeploymentSha === replayDeploymentCommit,
      `${label} receipt identity does not match the exact replay deployment`
    );
    replayValues.push(value);
    replayReceipts.push({
      mode: mode as "lease-expiry" | "lost-resolve",
      path: receiptPath,
      sha256: receiptSha256
    });
  }
  const firstReplayTiming = requiredRecord(
    replayValues[0].timing,
    "lease-expiry replay timing"
  );
  requireValue(
    firstReplayTiming.startedAt === replayEvidenceStartedAt &&
      replayValues[1].recordedAt === replayEvidenceCapturedAt,
    "durablePrerequisite replay window must equal the exact ordered receipt window"
  );
  requireValue(
    durableReplayReceiptSetDigest(replayValues, replayDeploymentCommit) ===
      replayReceiptSetDigest,
    "durablePrerequisite replay receiptSetDigest does not match the exact two receipts"
  );
  if (verifyCandidateBlobs) {
    (
      durableReplayVerifier ?? verifyDurableReplayReceiptsWithCanonicalCli
    )({
      rootDir,
      deploymentCommit: replayDeploymentCommit,
      leaseExpiryReceiptPath: absoluteRepoPath(
        rootDir,
        replayReceipts[0].path
      ),
      lostResolveReceiptPath: absoluteRepoPath(
        rootDir,
        replayReceipts[1].path
      )
    });
  }

  const stagingTeardownBinding = requiredRecord(
    durable.stagingTeardown,
    "durablePrerequisite.stagingTeardown"
  );
  requireExactOrderedKeys(
    stagingTeardownBinding,
    ["evidencePath", "evidenceSha256"],
    "durablePrerequisite.stagingTeardown"
  );
  requireValue(
    stagingTeardownBinding.evidencePath ===
      MEASUREMENT_STAGING_TEARDOWN_EVIDENCE_PATH,
    `durablePrerequisite.stagingTeardown.evidencePath must be ${MEASUREMENT_STAGING_TEARDOWN_EVIDENCE_PATH}`
  );
  const stagingTeardownEvidenceSha256 = requiredPattern(
    stagingTeardownBinding.evidenceSha256,
    SHA256,
    "durablePrerequisite.stagingTeardown.evidenceSha256"
  );
  const stagingTeardownText = candidateResidentText(
    rootDir,
    candidateCommit,
    MEASUREMENT_STAGING_TEARDOWN_EVIDENCE_PATH,
    stagingTeardownEvidenceSha256,
    verifyCandidateBlobs,
    "staging teardown evidence"
  );
  const stagingTeardown = readJsonTextObject(
    stagingTeardownText,
    "staging teardown evidence"
  );
  requireValue(
    stagingTeardown.artifactKind ===
      "site-behavior-staging-teardown-session-receipt" &&
      stagingTeardown.schemaVersion === 1 &&
      stagingTeardown.stagingSourceCommit === replayDeploymentCommit,
    "staging teardown evidence must bind the exact pre-enable replay deployment"
  );
  if (verifyCandidateBlobs) {
    (
      operatorEvidenceVerifier ?? verifyOperatorEvidenceWithCanonicalCli
    )({
      rootDir,
      evidencePath: absoluteRepoPath(
        rootDir,
        MEASUREMENT_STAGING_TEARDOWN_EVIDENCE_PATH
      )
    });
    const archiveDirectory =
      `research/hosted-evidence/${MEASUREMENT_STAGING_TEARDOWN_HOSTED_PROFILE}/${stagingTeardownEvidenceSha256}`;
    const subjectCommit = uniqueCandidateResidentIntroduction(
      rootDir,
      candidateCommit,
      MEASUREMENT_STAGING_TEARDOWN_EVIDENCE_PATH,
      stagingTeardownEvidenceSha256,
      "staging teardown evidence"
    );
    (
      stagingTeardownProvenanceVerifier ??
      verifyStagingTeardownProvenanceWithCanonicalCli
    )({
      rootDir,
      candidateCommit,
      carrierCommit: git(rootDir, [
        "rev-parse",
        "--verify",
        "HEAD"
      ])
        .trim()
        .toLowerCase(),
      replayDeploymentCommit,
      subjectCommit,
      evidencePath: MEASUREMENT_STAGING_TEARDOWN_EVIDENCE_PATH,
      evidenceSha256: stagingTeardownEvidenceSha256,
      archiveDirectory
    });
  }
  const stagingTeardownIdentity = verifyStagingTeardownAttestation(
    stagingTeardown,
    replayDeploymentCommit
  );

  const transitionBinding = requiredRecord(
    durable.transition,
    "durablePrerequisite.transition"
  );
  requireExactOrderedKeys(
    transitionBinding,
    ["receiptPath", "receiptSha256"],
    "durablePrerequisite.transition"
  );
  requireValue(
    transitionBinding.receiptPath ===
      MEASUREMENT_DURABLE_TRANSITION_RECEIPT_PATH,
    `durablePrerequisite.transition.receiptPath must be ${MEASUREMENT_DURABLE_TRANSITION_RECEIPT_PATH}`
  );
  const transitionReceiptSha256 = requiredPattern(
    transitionBinding.receiptSha256,
    SHA256,
    "durablePrerequisite.transition.receiptSha256"
  );
  const transitionReceiptText = candidateResidentText(
    rootDir,
    candidateCommit,
    MEASUREMENT_DURABLE_TRANSITION_RECEIPT_PATH,
    transitionReceiptSha256,
    verifyCandidateBlobs,
    "durable-enable transition receipt"
  );
  const receipt = readJsonTextObject(
    transitionReceiptText,
    "durable-enable transition receipt"
  );
  requireValue(
    transitionReceiptText === `${JSON.stringify(receipt, null, 2)}\n`,
    "durable-enable transition receipt must be canonical serialized JSON"
  );
  requireExactOrderedKeys(
    receipt,
    [
      "schemaVersion",
      "artifactKind",
      "transition",
      "replay",
      "secrets",
      "changeControl",
      "ci",
      "promotion",
      "productionHealth",
      "recordedAt"
    ],
    "durable-enable transition receipt"
  );
  requireValue(
    receipt.schemaVersion === 1 &&
      receipt.artifactKind === "site-behavior-durable-enable-transition",
    "durable-enable transition receipt identity is invalid"
  );
  const transition = requiredRecord(
    receipt.transition,
    "durable-enable transition receipt transition"
  );
  requireExactOrderedKeys(
    transition,
    ["configPath", "fromCommit", "toCommit"],
    "durable-enable transition receipt transition"
  );
  requireValue(
    transition.configPath === MEASUREMENT_DURABLE_CONFIG_PATH,
    "durable-enable transition receipt must bind the production config"
  );
  const fromCommit = requiredPattern(
    transition.fromCommit,
    FULL_GIT_SHA,
    "durable-enable transition receipt transition.fromCommit"
  );
  const toCommit = requiredPattern(
    transition.toCommit,
    FULL_GIT_SHA,
    "durable-enable transition receipt transition.toCommit"
  );
  if (verifyCandidateBlobs) {
    requireValue(
      git(rootDir, ["rev-parse", "--verify", `${toCommit}^`]).trim() ===
        fromCommit &&
        replayDeploymentCommit === fromCommit &&
        gitExit(rootDir, [
          "merge-base",
          "--is-ancestor",
          toCommit,
          `${candidateCommit}^`
        ]) === 0,
      "durable replay, exact 0→1 transition, soak archive, and candidate must form an ordered pre-candidate history"
    );
    const fromConfig = gitBlob(
      rootDir,
      fromCommit,
      MEASUREMENT_DURABLE_CONFIG_PATH
    );
    const toConfig = gitBlob(
      rootDir,
      toCommit,
      MEASUREMENT_DURABLE_CONFIG_PATH
    );
    requireValue(
      fromConfig.split(disabledMarker).length === 2 &&
        !fromConfig.includes(enabledMarker) &&
        toConfig === fromConfig.replace(disabledMarker, enabledMarker),
      "pre-candidate durable transition may only change the production flag from 0 to 1"
    );
    const transitionChanges = gitNameStatus(rootDir, fromCommit, toCommit);
    requireValue(
      transitionChanges.length === 1 &&
        transitionChanges[0].status === "M" &&
        transitionChanges[0].paths.length === 1 &&
        transitionChanges[0].paths[0] === MEASUREMENT_DURABLE_CONFIG_PATH,
      "pre-candidate durable transition commit may modify only wrangler.container.jsonc"
    );
    requireValue(
      toConfig === candidateConfig,
      "candidate durable configuration must exactly preserve the governed transition result"
    );
  }

  const receiptReplay = requiredRecord(
    receipt.replay,
    "durable-enable transition receipt replay"
  );
  requireExactOrderedKeys(
    receiptReplay,
    [
      "deploymentCommit",
      "receiptSetDigest",
      "evidenceStartedAt",
      "evidenceCapturedAt"
    ],
    "durable-enable transition receipt replay"
  );
  requireValue(
    receiptReplay.deploymentCommit === replayDeploymentCommit &&
      receiptReplay.receiptSetDigest === replayReceiptSetDigest &&
      receiptReplay.evidenceStartedAt === replayEvidenceStartedAt &&
      receiptReplay.evidenceCapturedAt === replayEvidenceCapturedAt,
    "durable-enable transition receipt replay binding does not match the exact candidate prerequisite"
  );
  const secrets = requiredRecord(
    receipt.secrets,
    "durable-enable transition receipt secrets"
  );
  requireExactOrderedKeys(
    secrets,
    [
      "checkedAt",
      "durableJobsKeyPresent",
      "durableJobsInternalTokenPresent",
      "valuesRecorded"
    ],
    "durable-enable transition receipt secrets"
  );
  const secretsCheckedAt = requiredCanonicalInstant(
    secrets.checkedAt,
    "durable-enable transition receipt secrets.checkedAt"
  );
  requireValue(
    secrets.durableJobsKeyPresent === true &&
      secrets.durableJobsInternalTokenPresent === true &&
      secrets.valuesRecorded === false,
    "durable-enable transition receipt must attest secret presence without recording values"
  );
  const changeControl = requiredRecord(
    receipt.changeControl,
    "durable-enable transition receipt changeControl"
  );
  requireExactOrderedKeys(
    changeControl,
    ["pullRequestUrl", "mergeCommit", "mergedAt"],
    "durable-enable transition receipt changeControl"
  );
  requireValue(
    typeof changeControl.pullRequestUrl === "string" &&
      /^https:\/\/github\.com\/iAnonymous3000\/site-behavior-lab\/pull\/[1-9][0-9]*$/.test(
        changeControl.pullRequestUrl
      ) &&
      changeControl.mergeCommit === toCommit,
    "durable-enable transition receipt must bind the exact governed pull request and merge commit"
  );
  const transitionMergedAt = requiredCanonicalInstant(
    changeControl.mergedAt,
    "durable-enable transition receipt changeControl.mergedAt"
  );
  const ci = requiredRecord(receipt.ci, "durable-enable transition receipt ci");
  requireExactOrderedKeys(
    ci,
    ["workflow", "runId", "runAttempt", "headCommit", "conclusion", "completedAt"],
    "durable-enable transition receipt ci"
  );
  requireValue(
    ci.workflow ===
      "iAnonymous3000/site-behavior-lab/.github/workflows/ci.yml@refs/heads/main",
    "durable-enable transition CI must name the trusted main workflow"
  );
  requiredPattern(
    ci.runId,
    /^[1-9][0-9]{0,19}$/,
    "durable-enable transition receipt ci.runId"
  );
  requireValue(
    Number.isSafeInteger(ci.runAttempt) &&
      (ci.runAttempt as number) >= 1 &&
      (ci.runAttempt as number) <= 100 &&
      ci.headCommit === toCommit &&
      ci.conclusion === "success",
    "durable-enable transition CI must succeed on the exact transition commit"
  );
  const ciCompletedAt = requiredCanonicalInstant(
    ci.completedAt,
    "durable-enable transition receipt ci.completedAt"
  );
  const promotion = requiredRecord(
    receipt.promotion,
    "durable-enable transition receipt promotion"
  );
  requireExactOrderedKeys(
    promotion,
    [
      "workflow",
      "runId",
      "runAttempt",
      "productionCommit",
      "deploymentDigest",
      "convergedAt"
    ],
    "durable-enable transition receipt promotion"
  );
  requireValue(
    promotion.workflow ===
      "iAnonymous3000/site-behavior-lab/.github/workflows/promote-production.yml@refs/heads/main",
    "durable-enable transition promotion must name the governed promotion workflow"
  );
  requiredPattern(
    promotion.runId,
    /^[1-9][0-9]{0,19}$/,
    "durable-enable transition receipt promotion.runId"
  );
  requireValue(
    Number.isSafeInteger(promotion.runAttempt) &&
      (promotion.runAttempt as number) >= 1 &&
      (promotion.runAttempt as number) <= 100,
    "durable-enable transition receipt promotion.runAttempt is invalid"
  );
  const deploymentDigest = requiredPattern(
    promotion.deploymentDigest,
    SHA256,
    "durable-enable transition receipt promotion.deploymentDigest"
  );
  requireValue(
    promotion.productionCommit === toCommit,
    "durable-enable transition promotion must converge on the exact transition commit"
  );
  const promotionConvergedAt = requiredCanonicalInstant(
    promotion.convergedAt,
    "durable-enable transition receipt promotion.convergedAt"
  );
  const productionHealth = requiredRecord(
    receipt.productionHealth,
    "durable-enable transition receipt productionHealth"
  );
  requireExactOrderedKeys(
    productionHealth,
    [
      "workflow",
      "runId",
      "runAttempt",
      "headCommit",
      "status",
      "warningCount",
      "durableJobs",
      "observedAt"
    ],
    "durable-enable transition receipt productionHealth"
  );
  requireValue(
    productionHealth.workflow ===
      "iAnonymous3000/site-behavior-lab/.github/workflows/production-health.yml@refs/heads/main",
    "durable-enable transition must bind the governed production health workflow"
  );
  requiredPattern(
    productionHealth.runId,
    /^[1-9][0-9]{0,19}$/,
    "durable-enable transition receipt productionHealth.runId"
  );
  requireValue(
    Number.isSafeInteger(productionHealth.runAttempt) &&
      (productionHealth.runAttempt as number) >= 1 &&
      (productionHealth.runAttempt as number) <= 100 &&
      productionHealth.headCommit === toCommit &&
      productionHealth.status === "ok" &&
      productionHealth.warningCount === 0,
    "durable-enable transition production health must be a clean run on the exact transition commit"
  );
  const durableJobs = requiredRecord(
    productionHealth.durableJobs,
    "durable-enable transition receipt productionHealth.durableJobs"
  );
  requireExactOrderedKeys(
    durableJobs,
    ["requested", "enabled", "readiness"],
    "durable-enable transition receipt productionHealth.durableJobs"
  );
  requireValue(
    durableJobs.requested === true &&
      durableJobs.enabled === true &&
      durableJobs.readiness === "ready",
    "durable-enable transition production health must positively prove durable readiness"
  );
  const productionHealthObservedAt = requiredCanonicalInstant(
    productionHealth.observedAt,
    "durable-enable transition receipt productionHealth.observedAt"
  );
  const recordedAt = requiredCanonicalInstant(
    receipt.recordedAt,
    "durable-enable transition receipt recordedAt"
  );
  requireValue(
    Date.parse(replayEvidenceCapturedAt) <=
        Date.parse(stagingTeardownIdentity.recordedAt) &&
      Date.parse(stagingTeardownIdentity.recordedAt) <=
        Date.parse(secretsCheckedAt) &&
      Date.parse(secretsCheckedAt) <= Date.parse(transitionMergedAt) &&
      Date.parse(transitionMergedAt) <= Date.parse(ciCompletedAt) &&
      Date.parse(ciCompletedAt) <= Date.parse(promotionConvergedAt) &&
      Date.parse(promotionConvergedAt) <=
        Date.parse(productionHealthObservedAt) &&
      Date.parse(productionHealthObservedAt) <= Date.parse(recordedAt),
    "durable enable chronology must be replay, staging teardown, secrets, governed merge, CI, promotion, health, then receipt"
  );

  const soakBinding = requiredRecord(
    durable.soak,
    "durablePrerequisite.soak"
  );
  requireExactOrderedKeys(
    soakBinding,
    [
      "attestationPath",
      "attestationSha256",
      "targetDeviationApproval"
    ],
    "durablePrerequisite.soak"
  );
  requireValue(
    soakBinding.attestationPath ===
      MEASUREMENT_DURABLE_SOAK_ATTESTATION_PATH,
    `durablePrerequisite.soak.attestationPath must be ${MEASUREMENT_DURABLE_SOAK_ATTESTATION_PATH}`
  );
  const soakAttestationSha256 = requiredPattern(
    soakBinding.attestationSha256,
    SHA256,
    "durablePrerequisite.soak.attestationSha256"
  );
  const soakText = candidateResidentText(
    rootDir,
    candidateCommit,
    MEASUREMENT_DURABLE_SOAK_ATTESTATION_PATH,
    soakAttestationSha256,
    verifyCandidateBlobs,
    "durable soak attestation"
  );
  const soak = readJsonTextObject(soakText, "durable soak attestation");
  requireValue(
    soakText === `${JSON.stringify(soak, null, 2)}\n`,
    "durable soak attestation must be canonical serialized JSON"
  );
  const soakIdentity = verifyDurableSoakAttestation(
    soak,
    fromCommit,
    toCommit,
    configSha256,
    transitionReceiptSha256,
    replayDeploymentCommit,
    replayReceiptSetDigest,
    deploymentDigest
  );
  const evidenceWindow = requiredRecord(
    soak.evidenceWindow,
    "durable soak attestation evidenceWindow"
  );
  const soakStartedAt = requiredCanonicalInstant(
    evidenceWindow.startedAt,
    "durable soak attestation evidenceWindow.startedAt"
  );
  const soakRestartObservedAt = requiredCanonicalInstant(
    evidenceWindow.restartObservedAt,
    "durable soak attestation evidenceWindow.restartObservedAt"
  );
  const soakEndedAt = requiredCanonicalInstant(
    evidenceWindow.endedAt,
    "durable soak attestation evidenceWindow.endedAt"
  );
  const soakAttestedAt = requiredCanonicalInstant(
    soak.attestedAt,
    "durable soak attestation attestedAt"
  );
  const soakDurationMilliseconds =
    Date.parse(soakEndedAt) - Date.parse(soakStartedAt);
  requireValue(
    Date.parse(recordedAt) <= Date.parse(soakStartedAt) &&
      Date.parse(soakStartedAt) <= Date.parse(soakRestartObservedAt) &&
      Date.parse(soakRestartObservedAt) <= Date.parse(soakEndedAt) &&
      Date.parse(soakEndedAt) <= Date.parse(soakAttestedAt) &&
      soakDurationMilliseconds >=
        MEASUREMENT_DURABLE_SOAK_MINIMUM_HOURS * 60 * 60 * 1000,
    "durable soak must follow enablement, include a real restart, last at least 24 hours, and be attested afterward"
  );
  const targetDeviationApproval =
    verifyDurableSoakTargetDeviationApproval(
      soakBinding.targetDeviationApproval,
      {
        rootDir,
        candidateCommit,
        soakDeploymentCommit: toCommit,
        ledgerSha256: soakIdentity.ledgerSha256,
        evidenceWindow: {
          startedAt: soakStartedAt,
          restartObservedAt: soakRestartObservedAt,
          endedAt: soakEndedAt
        },
        soakDurationMilliseconds,
        verifyCandidateTimestamp: verifyCandidateBlobs
      }
    );

  return {
    configPath: MEASUREMENT_DURABLE_CONFIG_PATH,
    configSha256,
    fromCommit,
    toCommit,
    transitionReceiptPath: MEASUREMENT_DURABLE_TRANSITION_RECEIPT_PATH,
    transitionReceiptSha256,
    deploymentDigest,
    replayDeploymentCommit,
    replayReceiptSetDigest,
    replayReceipts,
    replayEvidenceStartedAt,
    replayEvidenceCapturedAt,
    stagingTeardownEvidencePath:
      MEASUREMENT_STAGING_TEARDOWN_EVIDENCE_PATH,
    stagingTeardownEvidenceSha256,
    stagingTeardownInventoryDigest:
      stagingTeardownIdentity.teardownInventoryDigest,
    stagingTeardownRecordedAt: stagingTeardownIdentity.recordedAt,
    soakAttestationPath: MEASUREMENT_DURABLE_SOAK_ATTESTATION_PATH,
    soakAttestationSha256,
    soakLedgerSha256: soakIdentity.ledgerSha256,
    soakStartedAt,
    soakRestartObservedAt,
    soakEndedAt,
    soakAttestedAt,
    targetDeviationApproval,
    secretsCheckedAt,
    transitionMergedAt,
    ciCompletedAt,
    promotionConvergedAt,
    productionHealthObservedAt
  };
}

function candidateResidentText(
  rootDir: string,
  candidateCommit: string,
  relativePath: string,
  expectedSha256: string,
  verifyCandidateBlob: boolean,
  label: string
): string {
  const absolute = regularFileInside(rootDir, relativePath, label);
  const current = readFileSync(absolute, "utf8");
  const candidate = verifyCandidateBlob
    ? gitBlob(rootDir, candidateCommit, relativePath)
    : current;
  requireValue(
    current === candidate &&
      createHash("sha256").update(candidate).digest("hex") === expectedSha256,
    `${label} must be byte-identical to its candidate-resident blob`
  );
  return current;
}

function uniqueCandidateResidentIntroduction(
  rootDir: string,
  candidateCommit: string,
  relativePath: string,
  expectedSha256: string,
  label: string
): string {
  const additions = git(rootDir, [
    "log",
    "--format=%H",
    "--reverse",
    "--diff-filter=A",
    candidateCommit,
    "--",
    relativePath
  ])
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);
  const allChanges = git(rootDir, [
    "log",
    "--format=%H",
    "--reverse",
    candidateCommit,
    "--",
    relativePath
  ])
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);
  requireValue(
    additions.length === 1 &&
      allChanges.length === 1 &&
      allChanges[0] === additions[0],
    `${label} must be introduced exactly once and remain immutable before the measurement candidate`
  );
  const introductionCommit = additions[0];
  const introductionText = gitBlob(
    rootDir,
    introductionCommit,
    relativePath
  );
  requireValue(
    createHash("sha256").update(introductionText).digest("hex") ===
      expectedSha256 &&
      introductionText ===
        gitBlob(rootDir, candidateCommit, relativePath),
    `${label} introduction bytes must equal the exact candidate-resident receipt`
  );
  return introductionCommit;
}

function repositoryLegalEvidenceRefs(
  ledger: JsonRecord
): Map<string, string> {
  requireValue(
    Array.isArray(ledger.reviews),
    "measurement candidate package review ledger reviews must be an array"
  );
  const result = new Map<string, string>();
  const recordRef = (raw: unknown, label: string): void => {
    requireValue(
      typeof raw === "string",
      `${label} must be a string`
    );
    if (!raw.startsWith("repo:")) return;
    const match =
      /^repo:([A-Za-z0-9][A-Za-z0-9._/-]{0,899})#sha256=([0-9a-f]{64})$/.exec(
        raw
      );
    requireValue(
      match !== null,
      `${label} is not a canonical content-addressed repo: legal evidence reference`
    );
    const evidencePath = requiredCanonicalPath(
      match[1],
      `${label} repository path`
    );
    requireValue(
      evidencePath !== MEASUREMENT_CANDIDATE_BINDING_PATH &&
        evidencePath !==
          MEASUREMENT_CANDIDATE_PACKAGE_REVIEW_LEDGER_PATH,
      `${label} cannot self-reference mutable binding or review-ledger bytes`
    );
    const prior = result.get(evidencePath);
    requireValue(
      prior === undefined || prior === match[2],
      `${label} conflicts with another digest for ${evidencePath}`
    );
    result.set(evidencePath, match[2]);
  };
  for (const [reviewIndex, rawReview] of ledger.reviews.entries()) {
    const review = requiredRecord(
      rawReview,
      `package review ledger reviews[${reviewIndex}]`
    );
    requireValue(
      Array.isArray(review.licenseEvidenceRefs),
      `package review ledger reviews[${reviewIndex}].licenseEvidenceRefs must be an array`
    );
    for (const [refIndex, evidenceRef] of (
      review.licenseEvidenceRefs as unknown[]
    ).entries()) {
      recordRef(
        evidenceRef,
        `package review ledger reviews[${reviewIndex}].licenseEvidenceRefs[${refIndex}]`
      );
    }
    requireValue(
      Array.isArray(review.obligations),
      `package review ledger reviews[${reviewIndex}].obligations must be an array`
    );
    for (const [obligationIndex, rawObligation] of (
      review.obligations as unknown[]
    ).entries()) {
      const obligation = requiredRecord(
        rawObligation,
        `package review ledger reviews[${reviewIndex}].obligations[${obligationIndex}]`
      );
      requireValue(
        Array.isArray(obligation.evidenceRefs),
        `package review ledger reviews[${reviewIndex}].obligations[${obligationIndex}].evidenceRefs must be an array`
      );
      for (const [refIndex, evidenceRef] of (
        obligation.evidenceRefs as unknown[]
      ).entries()) {
        recordRef(
          evidenceRef,
          `package review ledger reviews[${reviewIndex}].obligations[${obligationIndex}].evidenceRefs[${refIndex}]`
        );
      }
    }
  }
  return new Map([...result].sort(([left], [right]) => left.localeCompare(right)));
}

function durableReplayReceiptSetDigest(
  receipts: JsonRecord[],
  expectedDeploymentSha: string
): string {
  const leaseOrigin = requiredRecord(
    receipts[0].origin,
    "lease-expiry replay origin"
  );
  const lostOrigin = requiredRecord(
    receipts[1].origin,
    "lost-resolve replay origin"
  );
  requireValue(
    canonicalJson(leaseOrigin) === canonicalJson(lostOrigin),
    "durable replay receipts must bind the same staging origin"
  );
  const receiptBindings = receipts.map((receipt, index) => {
    const mode = index === 0 ? "lease-expiry" : "lost-resolve";
    requireValue(
      receipt.mode === mode &&
        receipt.expectedDeploymentSha === expectedDeploymentSha,
      `durable replay receipt ${index} does not match the ordered deployment`
    );
    return {
      mode,
      receiptDigest: requiredPattern(
        receipt.receiptDigest,
        SHA256,
        `durable replay receipt ${index}.receiptDigest`
      )
    };
  });
  return createHash("sha256")
    .update(
      canonicalJson({
        kind: "site-behavior-durable-replay-receipt-set",
        receiptSetVersion: 1,
        expectedDeploymentSha,
        origin: leaseOrigin,
        receipts: receiptBindings
      })
    )
    .digest("hex");
}

function verifyDurableReplayReceiptsWithCanonicalCli(
  request: MeasurementDurableReplayVerificationRequest
): void {
  const validator = absoluteRepoPath(
    request.rootDir,
    "scripts/validate-durable-replay-receipts.mjs"
  );
  const result = spawnSync(
    process.execPath,
    [
      validator,
      request.deploymentCommit,
      request.leaseExpiryReceiptPath,
      request.lostResolveReceiptPath
    ],
    {
      cwd: request.rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 16 * 1024 * 1024
    }
  );
  requireValue(
    result.status === 0,
    `canonical durable replay receipt verification failed: ${(
      result.stderr || result.stdout
    ).trim()}`
  );
}

function verifyCalibrationCeremonyWithCanonicalCli(
  request: MeasurementCalibrationCeremonyVerificationRequest
): void {
  const validator = absoluteRepoPath(
    request.rootDir,
    "scripts/calibration-acquisition-authorization.mjs"
  );
  requireValue(
    existsSync(validator),
    "canonical calibration ceremony live verifier is missing"
  );
  const result = spawnSync(
    process.execPath,
    [
      validator,
      "--verify-live",
      "--repository",
      request.repository,
      "--study-id",
      request.studyId,
      "--candidate-commit",
      request.candidateCommit,
      "--label-roster-authorization",
      request.labelRosterAuthorizationPath,
      "--label-roster-authorization-sha256",
      request.labelRosterAuthorizationSha256,
      "--roster-selection-ledger",
      request.rosterSelectionLedgerPath,
      "--roster-selection-ledger-sha256",
      request.rosterSelectionLedgerSha256,
      "--acquisition-attempt-ledger",
      request.acquisitionAttemptLedgerPath,
      "--acquisition-attempt-ledger-sha256",
      request.acquisitionAttemptLedgerSha256
    ],
    {
      cwd: request.rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 16 * 1024 * 1024
    }
  );
  requireValue(
    result.status === 0,
    `canonical calibration ceremony live verification failed: ${(
      result.stderr || result.stdout
    )
      .trim()
      .slice(0, 600)}`
  );
}

function verifyOperatorEvidenceWithCanonicalCli(
  request: MeasurementOperatorEvidenceVerificationRequest
): void {
  const validator = absoluteRepoPath(
    request.rootDir,
    "scripts/verify-operator-evidence.mjs"
  );
  const result = spawnSync(
    process.execPath,
    [validator, "--evidence", request.evidencePath],
    {
      cwd: request.rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 16 * 1024 * 1024
    }
  );
  requireValue(
    result.status === 0,
    `canonical operator evidence verification failed: ${(
      result.stderr || result.stdout
    ).trim()}`
  );
}

function verifyStagingTeardownProvenanceWithCanonicalCli(
  request: MeasurementStagingTeardownProvenanceVerificationRequest
): void {
  const requirement =
    "staging teardown requires dedicated GitHub-hosted provider-capture provenance";
  const expectedDirectory =
    `research/hosted-evidence/${MEASUREMENT_STAGING_TEARDOWN_HOSTED_PROFILE}/${request.evidenceSha256}`;
  requireValue(
    request.archiveDirectory === expectedDirectory,
    `${requirement}; hosted archive is not at its digest-addressed canonical path`
  );
  requireValue(
    FULL_GIT_SHA.test(request.carrierCommit),
    `${requirement}; evidence carrier must be an exact Git commit`
  );
  for (const workflowPath of [
    MEASUREMENT_STAGING_TEARDOWN_CAPTURE_WORKFLOW_PATH,
    MEASUREMENT_HOSTED_EVIDENCE_ARCHIVER_WORKFLOW_PATH
  ]) {
    requireValue(
      gitExit(request.rootDir, [
        "cat-file",
        "-e",
        `${request.candidateCommit}:${workflowPath}`
      ]) === 0,
      `${requirement}; candidate is missing trusted workflow ${workflowPath}`
    );
  }

  const contextPath = `${request.archiveDirectory}/context.json`;
  const bundlePath =
    `${request.archiveDirectory}/context.sigstore.json`;
  const retainedSubjectPath =
    `${request.archiveDirectory}/subject.json`;
  requireValue(
    existsSync(absoluteRepoPath(request.rootDir, request.archiveDirectory)),
    `${requirement}; missing digest-enumerated carrier archive ${request.archiveDirectory}/`
  );
  for (const relativePath of [
    contextPath,
    bundlePath,
    retainedSubjectPath
  ]) {
    requireValue(
      gitExit(request.rootDir, [
        "cat-file",
        "-e",
        `${request.carrierCommit}:${relativePath}`
      ]) === 0,
      `${requirement}; ${relativePath} was not present at the evidence carrier`
    );
    requireValue(
      gitExit(request.rootDir, [
        "cat-file",
        "-e",
        `${request.candidateCommit}:${relativePath}`
      ]) !== 0,
      `${requirement}; authenticated hosted archive must be introduced after candidate C, never embedded in C`
    );
  }
  requireValue(
    gitExit(request.rootDir, [
      "diff",
      "--quiet",
      request.carrierCommit,
      "--",
      request.archiveDirectory
    ]) === 0,
    `${requirement}; hosted archive bytes must be identical to their carrier tree`
  );

  const contextText = candidateResidentText(
    request.rootDir,
    request.carrierCommit,
    contextPath,
    sha256File(
      regularFileInside(
        request.rootDir,
        contextPath,
        "staging teardown hosted evidence context"
      )
    ),
    true,
    "staging teardown hosted evidence carrier context"
  );
  const context = readJsonTextObject(
    contextText,
    "staging teardown hosted evidence context"
  );
  verifyStagingTeardownHostedSourceTrust(
    request.rootDir,
    request.candidateCommit,
    request.subjectCommit,
    context
  );
  const archiver = requiredRecord(
    context.archiver,
    "staging teardown hosted evidence archiver"
  );
  const archiverCommit = requiredPattern(
    archiver.sourceCommit,
    FULL_GIT_SHA,
    "staging teardown hosted evidence archiver.sourceCommit"
  );
  requireValue(
    gitExit(request.rootDir, [
      "merge-base",
      "--is-ancestor",
      request.replayDeploymentCommit,
      request.subjectCommit
    ]) === 0 &&
      gitExit(request.rootDir, [
        "merge-base",
        "--is-ancestor",
        request.subjectCommit,
        request.candidateCommit
      ]) === 0 &&
      gitExit(request.rootDir, [
        "merge-base",
        "--is-ancestor",
        request.candidateCommit,
        archiverCommit
      ]) === 0 &&
      gitExit(request.rootDir, [
        "merge-base",
        "--is-ancestor",
        archiverCommit,
        request.carrierCommit
      ]) === 0,
    `${requirement}; deployment, subject, candidate, archiver, and carrier are not one trusted history`
  );
  requireValue(
    gitBlob(
      request.rootDir,
      archiverCommit,
      MEASUREMENT_HOSTED_EVIDENCE_ARCHIVER_WORKFLOW_PATH
    ) ===
      gitBlob(
        request.rootDir,
        request.candidateCommit,
        MEASUREMENT_HOSTED_EVIDENCE_ARCHIVER_WORKFLOW_PATH
      ),
    `${requirement}; hosted archiver workflow blob must be byte-identical to the candidate-approved trusted workflow`
  );

  const verifier = absoluteRepoPath(
    request.rootDir,
    "scripts/archive-hosted-evidence.mjs"
  );
  const result = spawnSync(
    process.execPath,
    [
      verifier,
      "--verify",
      "--root",
      path.resolve(request.rootDir),
      "--directory",
      absoluteRepoPath(request.rootDir, request.archiveDirectory),
      "--profile",
      MEASUREMENT_STAGING_TEARDOWN_HOSTED_PROFILE,
      "--subject-path",
      request.evidencePath,
      "--subject-sha256",
      request.evidenceSha256,
      "--subject-commit",
      request.subjectCommit,
      "--archiver-commit",
      archiverCommit
    ],
    {
      cwd: request.rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024
    }
  );
  requireValue(
    result.status === 0,
    `${requirement}; canonical hosted archive verification failed: ${(
      result.stderr || result.stdout
    )
      .trim()
      .slice(0, 600)}`
  );
}

function verifyDurableSoakProvenanceWithCanonicalCli(
  request: MeasurementDurableSoakProvenanceVerificationRequest
): void {
  const requirement =
    "durable soak requires its exact authenticated GitHub-hosted archive";
  const expectedDirectory =
    `research/hosted-evidence/${MEASUREMENT_DURABLE_SOAK_HOSTED_PROFILE}/${request.evidenceSha256}`;
  requireValue(
    request.archiveDirectory === expectedDirectory,
    `${requirement}; hosted archive is not at its digest-addressed canonical path`
  );
  const archiveAbsolute = absoluteRepoPath(
    request.rootDir,
    request.archiveDirectory
  );
  requireValue(
    existsSync(archiveAbsolute),
    `${requirement}; missing digest-enumerated carrier archive ${request.archiveDirectory}/`
  );

  const contextPath = `${request.archiveDirectory}/context.json`;
  const bundlePath =
    `${request.archiveDirectory}/context.sigstore.json`;
  const subjectPath = `${request.archiveDirectory}/subject.json`;
  for (const relativePath of [
    contextPath,
    bundlePath,
    subjectPath
  ]) {
    requireValue(
      gitExit(request.rootDir, [
        "cat-file",
        "-e",
        `${request.carrierCommit}:${relativePath}`
      ]) === 0,
      `${requirement}; ${relativePath} was not present at the evidence carrier`
    );
    requireValue(
      gitExit(request.rootDir, [
        "cat-file",
        "-e",
        `${request.candidateCommit}:${relativePath}`
      ]) !== 0,
      `${requirement}; authenticated hosted archive must be introduced after candidate C, never embedded in C`
    );
  }
  requireValue(
    gitExit(request.rootDir, [
      "diff",
      "--quiet",
      request.carrierCommit,
      "--",
      request.archiveDirectory
    ]) === 0,
    `${requirement}; hosted archive bytes must be identical to their carrier tree`
  );

  const context = readJsonObject(
    regularFileInside(
      request.rootDir,
      contextPath,
      "durable soak hosted evidence context"
    ),
    "durable soak hosted evidence context"
  );
  const subject = requiredRecord(
    context.subject,
    "durable soak hosted evidence subject"
  );
  const archiver = requiredRecord(
    context.archiver,
    "durable soak hosted evidence archiver"
  );
  requireValue(
    context.profile === MEASUREMENT_DURABLE_SOAK_HOSTED_PROFILE &&
      subject.repositoryPath === request.evidencePath &&
      subject.commit === request.subjectCommit &&
      subject.sha256 === request.evidenceSha256 &&
      subject.file === "subject.json",
    `${requirement}; hosted context does not bind the exact durable soak attestation`
  );
  const archiverCommit = requiredPattern(
    archiver.sourceCommit,
    FULL_GIT_SHA,
    "durable soak hosted evidence archiver.sourceCommit"
  );
  requireValue(
    gitExit(request.rootDir, [
      "merge-base",
      "--is-ancestor",
      request.deploymentCommit,
      request.subjectCommit
    ]) === 0 &&
      gitExit(request.rootDir, [
        "merge-base",
        "--is-ancestor",
        request.subjectCommit,
        request.candidateCommit
      ]) === 0 &&
      gitExit(request.rootDir, [
        "merge-base",
        "--is-ancestor",
        request.candidateCommit,
        archiverCommit
      ]) === 0 &&
      gitExit(request.rootDir, [
        "merge-base",
        "--is-ancestor",
        archiverCommit,
        request.carrierCommit
      ]) === 0,
    `${requirement}; deployment, subject, candidate, archiver, and carrier are not one trusted history`
  );
  requireValue(
    gitBlob(
      request.rootDir,
      archiverCommit,
      MEASUREMENT_HOSTED_EVIDENCE_ARCHIVER_WORKFLOW_PATH
    ) ===
      gitBlob(
        request.rootDir,
        request.candidateCommit,
        MEASUREMENT_HOSTED_EVIDENCE_ARCHIVER_WORKFLOW_PATH
      ),
    `${requirement}; hosted archiver workflow blob does not equal the candidate-approved workflow`
  );

  requireValue(
    Array.isArray(context.files) && context.files.length > 0,
    `${requirement}; hosted context has no retained file inventory`
  );
  const expectedEntries = new Map<string, string>([
    [contextPath, sha256File(absoluteRepoPath(request.rootDir, contextPath))],
    [bundlePath, sha256File(absoluteRepoPath(request.rootDir, bundlePath))]
  ]);
  for (const [index, rawFile] of context.files.entries()) {
    const file = requiredRecord(
      rawFile,
      `durable soak hosted evidence context.files[${index}]`
    );
    const filePath = requiredCanonicalPath(
      file.path,
      `durable soak hosted evidence context.files[${index}].path`
    );
    const fileSha256 = requiredPattern(
      file.sha256,
      SHA256,
      `durable soak hosted evidence context.files[${index}].sha256`
    );
    expectedEntries.set(
      `${request.archiveDirectory}/${filePath}`,
      fileSha256
    );
  }
  const boundEntries = new Map(
    request.archiveEntries.map((entry) => [
      entry.path,
      entry.sha256
    ])
  );
  requireValue(
    boundEntries.size === request.archiveEntries.length &&
      boundEntries.size === expectedEntries.size &&
      [...expectedEntries].every(
        ([relativePath, sha256]) =>
          boundEntries.get(relativePath) === sha256 &&
          sha256File(
            regularFileInside(
              request.rootDir,
              relativePath,
              "durable soak hosted archive member"
            )
          ) === sha256
      ),
    `${requirement}; binding archive entries are not set-equal to the authenticated context inventory`
  );
  requireValue(
    expectedEntries.get(subjectPath) === request.evidenceSha256 &&
      readFileSync(
        absoluteRepoPath(request.rootDir, subjectPath)
      ).equals(
        readFileSync(
          absoluteRepoPath(request.rootDir, request.evidencePath)
        )
      ),
    `${requirement}; retained subject bytes do not equal the fixed durable soak attestation`
  );

  const verifier = absoluteRepoPath(
    request.rootDir,
    "scripts/archive-hosted-evidence.mjs"
  );
  const result = spawnSync(
    process.execPath,
    [
      verifier,
      "--verify",
      "--root",
      path.resolve(request.rootDir),
      "--directory",
      archiveAbsolute,
      "--profile",
      MEASUREMENT_DURABLE_SOAK_HOSTED_PROFILE,
      "--subject-path",
      request.evidencePath,
      "--subject-sha256",
      request.evidenceSha256,
      "--subject-commit",
      request.subjectCommit,
      "--archiver-commit",
      archiverCommit
    ],
    {
      cwd: request.rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024
    }
  );
  requireValue(
    result.status === 0,
    `${requirement}; canonical hosted archive verification failed: ${(
      result.stderr || result.stdout
    )
      .trim()
      .slice(0, 600)}`
  );
  const sourceClosureVerifier = absoluteRepoPath(
    request.rootDir,
    "scripts/verify-hosted-source-closure.mjs"
  );
  const sourceClosureResult = spawnSync(
    process.execPath,
    [
      sourceClosureVerifier,
      "--root",
      path.resolve(request.rootDir),
      "--context",
      absoluteRepoPath(request.rootDir, contextPath),
      "--profile",
      MEASUREMENT_DURABLE_SOAK_HOSTED_PROFILE,
      "--candidate-commit",
      request.candidateCommit
    ],
    {
      cwd: request.rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 16 * 1024 * 1024
    }
  );
  requireValue(
    sourceClosureResult.status === 0,
    `${requirement}; source closure verification failed: ${(
      sourceClosureResult.stderr ||
      sourceClosureResult.stdout
    )
      .trim()
      .slice(0, 600)}`
  );
}

export function verifyStagingTeardownHostedSourceTrust(
  rootDir: string,
  candidateCommit: string,
  subjectCommit: string,
  contextValue: unknown
): string {
  const context = requiredRecord(
    contextValue,
    "staging teardown hosted evidence context"
  );
  requireValue(
    context.profile === MEASUREMENT_STAGING_TEARDOWN_HOSTED_PROFILE,
    `staging teardown hosted evidence profile must be ${MEASUREMENT_STAGING_TEARDOWN_HOSTED_PROFILE}`
  );
  requireValue(
    Array.isArray(context.sources) && context.sources.length === 1,
    "staging teardown hosted evidence must contain exactly one provider-capture source"
  );
  const source = requiredRecord(
    context.sources[0],
    "staging teardown hosted evidence provider-capture source"
  );
  requireValue(
    source.role === "provider-capture" &&
      source.workflowPath ===
        MEASUREMENT_STAGING_TEARDOWN_CAPTURE_WORKFLOW_PATH &&
      source.headBranch === "main" &&
      source.conclusion === "success",
    "staging teardown hosted evidence source must be one successful trusted main provider-capture run"
  );
  const sourceHeadCommit = requiredPattern(
    source.headSha,
    FULL_GIT_SHA,
    "staging teardown hosted evidence provider-capture source.headSha"
  );
  requireValue(
    gitExit(rootDir, [
      "merge-base",
      "--is-ancestor",
      sourceHeadCommit,
      subjectCommit
    ]) === 0 &&
      gitExit(rootDir, [
        "merge-base",
        "--is-ancestor",
        subjectCommit,
        candidateCommit
      ]) === 0,
    "staging teardown provider-capture source, receipt carrier, and candidate must be one ordered trusted history"
  );
  for (const sourcePath of
    MEASUREMENT_STAGING_TEARDOWN_SOURCE_CLOSURE_PATHS) {
    requireValue(
      gitBlob(rootDir, sourceHeadCommit, sourcePath) ===
        gitBlob(rootDir, candidateCommit, sourcePath),
      `staging teardown provider-capture source ${sourcePath} must be byte-identical to the candidate-approved producer closure`
    );
  }
  return sourceHeadCommit;
}

function verifyStagingTeardownAttestation(
  evidence: JsonRecord,
  replayDeploymentCommit: string
): {
  teardownInventoryDigest: string;
  recordedAt: string;
} {
  requireValue(
    evidence.schemaVersion === 1 &&
      evidence.artifactKind ===
        "site-behavior-staging-teardown-session-receipt" &&
      evidence.stagingSourceCommit === replayDeploymentCommit,
    "staging teardown evidence identity does not match the exact pre-enable deployment"
  );
  const teardownInventoryDigest = requiredPattern(
    evidence.teardownInventoryDigest,
    SHA256,
    "staging teardown evidence teardownInventoryDigest"
  );
  const recordedAt = requiredCanonicalInstant(
    evidence.recordedAt,
    "staging teardown evidence recordedAt"
  );
  return { teardownInventoryDigest, recordedAt };
}

function verifyDurableSoakAttestation(
  attestation: JsonRecord,
  replayDeploymentCommit: string,
  soakDeploymentCommit: string,
  durableConfigDigest: string,
  durableEnableReceiptDigest: string,
  expectedReplayDeploymentCommit: string,
  replayReceiptsDigest: string,
  deploymentDigest: string
): { ledgerSha256: string } {
  requireExactOrderedKeys(
    attestation,
    [
      "kind",
      "gateId",
      "targetRelease",
      "attestedBy",
      "attestedAt",
      "evidenceCapturedAt",
      "bindings",
      "statements",
      "evidenceRefs",
      "evidenceWindow"
    ],
    "durable soak attestation"
  );
  requireValue(
    attestation.kind === "site-behavior-operator-attestation" &&
      attestation.gateId === "durable-soak" &&
      attestation.targetRelease === MEASUREMENT_CANDIDATE_TARGET_RELEASE,
    "durable soak attestation identity is invalid"
  );
  requireNonEmptyString(
    attestation.attestedBy,
    "durable soak attestation attestedBy"
  );
  const attestedAt = requiredCanonicalInstant(
    attestation.attestedAt,
    "durable soak attestation attestedAt"
  );
  const evidenceCapturedAt = requiredCanonicalInstant(
    attestation.evidenceCapturedAt,
    "durable soak attestation evidenceCapturedAt"
  );
  const bindings = requiredRecord(
    attestation.bindings,
    "durable soak attestation bindings"
  );
  requireExactOrderedKeys(
    bindings,
    [
      "replayDeploymentCommit",
      "soakDeploymentCommit",
      "durableConfigDigest",
      "durableEnableReceiptDigest",
      "replayReceiptsDigest",
      "deploymentDigest",
      "ledgerSha256"
    ],
    "durable soak attestation bindings"
  );
  const ledgerSha256 = requiredPattern(
    bindings.ledgerSha256,
    SHA256,
    "durable soak attestation bindings.ledgerSha256"
  );
  requireValue(
    replayDeploymentCommit === expectedReplayDeploymentCommit &&
      bindings.replayDeploymentCommit === replayDeploymentCommit &&
      bindings.soakDeploymentCommit === soakDeploymentCommit &&
      bindings.durableConfigDigest === durableConfigDigest &&
      bindings.durableEnableReceiptDigest === durableEnableReceiptDigest &&
      bindings.replayReceiptsDigest === replayReceiptsDigest &&
      bindings.deploymentDigest === deploymentDigest,
    "durable soak attestation bindings do not match the exact pre-candidate transition"
  );
  const expectedClaims = [
    [
      "lease-expiry-replay-passed",
      "The lease-expiry replay canary passed against the bound pre-enable deployment."
    ],
    [
      "lost-resolve-replay-passed",
      "The lost-resolve replay canary passed against the bound pre-enable deployment."
    ],
    [
      "durable-hourly-health-observed",
      "Every authenticated hourly deep-health sample in the bound soak window observed durable jobs enabled and ready on the exact production deployment; no sample gap exceeded 90 minutes."
    ],
    [
      "real-restart-observed",
      "A real runtime restart occurred inside the soak window, and the queued job recovered on a second fenced attempt to one authenticated report identity and readback."
    ],
    [
      "durable-behavior-exercises-observed",
      "An authenticated production exercise run inside the soak window proved normal completion, cancellation, completed-report recovery, and duplicate prevention on the bound durable deployment."
    ]
  ] as const;
  requireValue(
    Array.isArray(attestation.statements) &&
      attestation.statements.length === expectedClaims.length,
    "durable soak attestation must contain the exact required claim set"
  );
  for (const [index, [claimId, claim]] of expectedClaims.entries()) {
    const statement = requiredRecord(
      attestation.statements[index],
      `durable soak attestation statements[${index}]`
    );
    requireExactOrderedKeys(
      statement,
      ["claimId", "claim", "true"],
      `durable soak attestation statements[${index}]`
    );
    requireValue(
      statement.claimId === claimId &&
        statement.claim === claim &&
        statement.true === true,
      `durable soak attestation statement ${claimId} is not literally true and exact`
    );
  }
  requireValue(
    Array.isArray(attestation.evidenceRefs) &&
      attestation.evidenceRefs.length === 3 &&
      attestation.evidenceRefs.every(
        (entry) =>
          typeof entry === "string" &&
          /^github-actions-run:[1-9][0-9]{0,19}:artifact-sha256:[0-9a-f]{64}$/.test(
            entry
          )
      ) &&
      new Set(attestation.evidenceRefs).size === attestation.evidenceRefs.length,
    "durable soak attestation evidenceRefs must bind exactly three unique authenticated monitor, restart, and exercise run artifacts"
  );
  const window = requiredRecord(
    attestation.evidenceWindow,
    "durable soak attestation evidenceWindow"
  );
  requireExactOrderedKeys(
    window,
    ["startedAt", "restartObservedAt", "endedAt"],
    "durable soak attestation evidenceWindow"
  );
  const startedAt = requiredCanonicalInstant(
    window.startedAt,
    "durable soak attestation evidenceWindow.startedAt"
  );
  const restartObservedAt = requiredCanonicalInstant(
    window.restartObservedAt,
    "durable soak attestation evidenceWindow.restartObservedAt"
  );
  const endedAt = requiredCanonicalInstant(
    window.endedAt,
    "durable soak attestation evidenceWindow.endedAt"
  );
  requireValue(
    Date.parse(startedAt) <= Date.parse(restartObservedAt) &&
      Date.parse(restartObservedAt) <= Date.parse(endedAt) &&
      Date.parse(endedAt) - Date.parse(startedAt) >=
        24 * 60 * 60 * 1000 &&
      evidenceCapturedAt === endedAt &&
      Date.parse(attestedAt) >= Date.parse(endedAt),
    "durable soak attestation must prove a restart inside a complete minimum 24-hour window"
  );
  return { ledgerSha256 };
}

function verifyDurableSoakTargetDeviationApproval(
  rawApproval: unknown,
  expected: {
    rootDir: string;
    candidateCommit: string;
    soakDeploymentCommit: string;
    ledgerSha256: string;
    evidenceWindow: {
      startedAt: string;
      restartObservedAt: string;
      endedAt: string;
    };
    soakDurationMilliseconds: number;
    verifyCandidateTimestamp: boolean;
  }
): DurableSoakTargetDeviationApproval | null {
  const targetMilliseconds =
    MEASUREMENT_DURABLE_SOAK_TARGET_HOURS * 60 * 60 * 1000;
  if (expected.soakDurationMilliseconds >= targetMilliseconds) {
    requireValue(
      rawApproval === null,
      "durable soak target deviation approval must be null when the 168-hour target is met"
    );
    return null;
  }
  requireValue(
    expected.soakDurationMilliseconds >=
      MEASUREMENT_DURABLE_SOAK_MINIMUM_HOURS * 60 * 60 * 1000,
    "durable soak remains ineligible below the 24-hour hard minimum"
  );
  const approval = requiredRecord(
    rawApproval,
    "durablePrerequisite.soak.targetDeviationApproval"
  );
  requireExactOrderedKeys(
    approval,
    [
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
    ],
    "durablePrerequisite.soak.targetDeviationApproval"
  );
  requireValue(
    approval.status === "approved" &&
      approval.approverType === "named-human",
    "durable soak target deviation must be explicitly approved by a named human"
  );
  const approvedBy = requireNonEmptyString(
    approval.approvedBy,
    "durable soak target deviation approvedBy"
  );
  requireValue(
    approvedBy.length <= 200 &&
      !/^<required(?::|>)/i.test(approvedBy) &&
      !/^(?:unknown|unnamed|operator|automation|github-actions(?:\[bot\])?)$/i.test(
        approvedBy
      ),
    "durable soak target deviation approvedBy must identify the named human approver"
  );
  const reason = requireNonEmptyString(
    approval.reason,
    "durable soak target deviation reason"
  );
  requireValue(
    reason.length <= 2000 &&
      !/^<required(?::|>)/i.test(reason),
    "durable soak target deviation reason must record the reviewed release rationale"
  );
  const approvedAt = requiredCanonicalInstant(
    approval.approvedAt,
    "durable soak target deviation approvedAt"
  );
  const candidateCommit = requiredPattern(
    approval.candidateCommit,
    FULL_GIT_SHA,
    "durable soak target deviation candidateCommit"
  );
  const soakDeploymentCommit = requiredPattern(
    approval.soakDeploymentCommit,
    FULL_GIT_SHA,
    "durable soak target deviation soakDeploymentCommit"
  );
  const ledgerSha256 = requiredPattern(
    approval.ledgerSha256,
    SHA256,
    "durable soak target deviation ledgerSha256"
  );
  const evidenceWindow = requiredRecord(
    approval.evidenceWindow,
    "durable soak target deviation evidenceWindow"
  );
  requireExactOrderedKeys(
    evidenceWindow,
    ["startedAt", "restartObservedAt", "endedAt"],
    "durable soak target deviation evidenceWindow"
  );
  const startedAt = requiredCanonicalInstant(
    evidenceWindow.startedAt,
    "durable soak target deviation evidenceWindow.startedAt"
  );
  const restartObservedAt = requiredCanonicalInstant(
    evidenceWindow.restartObservedAt,
    "durable soak target deviation evidenceWindow.restartObservedAt"
  );
  const endedAt = requiredCanonicalInstant(
    evidenceWindow.endedAt,
    "durable soak target deviation evidenceWindow.endedAt"
  );
  requireValue(
    candidateCommit === expected.candidateCommit &&
      soakDeploymentCommit === expected.soakDeploymentCommit &&
      ledgerSha256 === expected.ledgerSha256 &&
      startedAt === expected.evidenceWindow.startedAt &&
      restartObservedAt === expected.evidenceWindow.restartObservedAt &&
      endedAt === expected.evidenceWindow.endedAt &&
      approval.minimumEvidenceHours ===
        MEASUREMENT_DURABLE_SOAK_MINIMUM_HOURS &&
      approval.targetEvidenceHours ===
        MEASUREMENT_DURABLE_SOAK_TARGET_HOURS,
    "durable soak target deviation approval does not bind the exact candidate, deployment, ledger, window, and reviewed duration policy"
  );
  requireValue(
    Date.parse(approvedAt) >= Date.parse(endedAt),
    "durable soak target deviation approval is stale because it predates the completed soak window"
  );
  if (expected.verifyCandidateTimestamp) {
    const candidateCommittedAt = git(
      expected.rootDir,
      ["show", "-s", "--format=%cI", expected.candidateCommit]
    ).trim();
    requireValue(
      Date.parse(approvedAt) >= Date.parse(candidateCommittedAt),
      "durable soak target deviation approval is stale because it predates the candidate"
    );
  }
  return {
    status: "approved",
    approverType: "named-human",
    approvedBy,
    approvedAt,
    reason,
    candidateCommit,
    soakDeploymentCommit,
    ledgerSha256,
    evidenceWindow: {
      startedAt,
      restartObservedAt,
      endedAt
    },
    minimumEvidenceHours: MEASUREMENT_DURABLE_SOAK_MINIMUM_HOURS,
    targetEvidenceHours: MEASUREMENT_DURABLE_SOAK_TARGET_HOURS
  };
}

function verifyCandidateCarrierDiff(
  rootDir: string,
  candidateCommit: string,
  carrierCommit: string,
  enumeratedPaths: Map<
    string,
    {
      change: MeasurementEvidenceChange;
      sha256: string;
    }
  >
): {
  acceptedProducerCommits: string[];
  evidenceIntroducedAt: Record<string, string>;
  evidenceIntroducedAtTime: Record<string, string>;
} {
  const permitted = new Map(enumeratedPaths);
  permitted.set(MEASUREMENT_CANDIDATE_BINDING_PATH, {
    change: "added",
    sha256: ""
  });

  // A net endpoint diff alone is insufficient: forbidden code could change,
  // produce evidence, and then be reverted. Main is required to be linear
  // during the evidence window, and every transition must independently stay
  // inside the same immutable path policy.
  const history = git(rootDir, [
    "rev-list",
    "--reverse",
    "--parents",
    `${candidateCommit}..${carrierCommit}`
  ])
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);
  const evidenceIntroducedAt = new Map<string, string>();
  const releaseFinalizedAt = new Map<string, string>();
  const commitTimes = new Map<string, string>();
  let prior = candidateCommit;
  for (const line of history) {
    const parts = line.split(" ");
    requireValue(
      parts.length === 2 && parts[1] === prior,
      "measurement evidence carrier history must be one linear single-parent chain from the candidate"
    );
    const commit = parts[0];
    commitTimes.set(
      commit,
      new Date(
        git(rootDir, ["show", "-s", "--format=%cI", commit]).trim()
      ).toISOString()
    );
    for (const change of gitNameStatus(rootDir, prior, commit)) {
      requireValue(
        (change.status === "A" || change.status === "M") && change.paths.length === 1,
        `transient candidate-history change ${change.status} ${change.paths.join(" -> ")} is forbidden`
      );
      const changedPath = change.paths[0];
      const policy = permitted.get(changedPath);
      requireValue(
        policy !== undefined,
        `transient candidate-history change ${changedPath} is not enumerated evidence`
      );
      if (changedPath === MEASUREMENT_CANDIDATE_BINDING_PATH) {
        requireValue(
          change.status === "A" || change.status === "M",
          "measurement candidate binding may only be added or updated"
        );
      } else if (policy.change === "added") {
        requireValue(
          change.status === "A",
          `append-only evidence ${changedPath} was modified after introduction`
        );
        requireValue(
          !evidenceIntroducedAt.has(changedPath),
          `append-only evidence ${changedPath} was introduced more than once`
        );
        evidenceIntroducedAt.set(changedPath, commit);
      } else {
        requireValue(
          change.status === "M",
          `candidate-history change ${changedPath} must remain an exact-path modification`
        );
        if (policy.change === "release-finalization") {
          requireValue(
            !releaseFinalizedAt.has(changedPath),
            `release finalization ${changedPath} may be modified exactly once`
          );
          releaseFinalizedAt.set(changedPath, commit);
        }
      }
    }
    prior = commit;
  }
  requireValue(prior === carrierCommit, "measurement evidence carrier is not on the candidate's linear history");

  const observed = new Set<string>();
  for (const change of gitNameStatus(rootDir, candidateCommit, carrierCommit)) {
    requireValue(
      (change.status === "A" || change.status === "M") && change.paths.length === 1,
      `candidate-to-carrier change ${change.status} ${change.paths.join(" -> ")} is not an allowed evidence change`
    );
    const changedPath = change.paths[0];
    const policy = permitted.get(changedPath);
    requireValue(
      policy !== undefined,
      `candidate-to-carrier change ${changedPath} is not enumerated evidence`
    );
    const expectedStatus = policy.change === "added" ? "A" : "M";
    requireValue(
      change.status === expectedStatus,
      `candidate-to-carrier change ${changedPath} must be ${expectedStatus}, received ${change.status}`
    );
    requireValue(!observed.has(changedPath), `candidate-to-carrier diff repeats ${changedPath}`);
    observed.add(changedPath);
  }
  requireValue(
    observed.size === permitted.size && [...permitted.keys()].every((entry) => observed.has(entry)),
    "candidate-to-carrier changes must be set-equal to the binding and every digest-enumerated evidence path"
  );
  for (const [evidencePath, policy] of permitted) {
    if (
      evidencePath !== MEASUREMENT_CANDIDATE_BINDING_PATH &&
      policy.change === "added"
    ) {
      requireValue(
        evidenceIntroducedAt.has(evidencePath),
        `append-only evidence ${evidencePath} lacks an introduction commit`
      );
    }
  }
  const releaseFinalizationPaths = [...permitted]
    .filter(([, policy]) => policy.change === "release-finalization")
    .map(([evidencePath]) => evidencePath);
  if (releaseFinalizationPaths.length > 0) {
    const finalizationCommits = new Set(
      releaseFinalizationPaths.map((evidencePath) =>
        releaseFinalizedAt.get(evidencePath)
      )
    );
    requireValue(
      releaseFinalizationPaths.every((evidencePath) =>
        releaseFinalizedAt.has(evidencePath)
      ) &&
        finalizationCommits.size === 1 &&
        !finalizationCommits.has(undefined),
      "release-policy.json, CITATION.cff, and CHANGELOG.md must be finalized exactly once in one atomic carrier commit"
    );
  }
  return {
    acceptedProducerCommits: [
      candidateCommit,
      ...history.map((line) => line.split(" ")[0])
    ],
    evidenceIntroducedAt: Object.fromEntries(
      [...evidenceIntroducedAt.entries()].sort(([left], [right]) =>
        left.localeCompare(right)
      )
    ),
    evidenceIntroducedAtTime: Object.fromEntries(
      [...evidenceIntroducedAt.entries()]
        .map(([evidencePath, commit]) => [
          evidencePath,
          commitTimes.get(commit) ?? ""
        ])
        .sort(([left], [right]) => left.localeCompare(right))
    )
  };
}

function verifyEvidenceSets(evidence: MeasurementEvidenceEntry[]): void {
  const byCategory = new Map<MeasurementEvidenceCategory, Set<string>>();
  for (const entry of evidence) {
    const paths = byCategory.get(entry.category) ?? new Set<string>();
    paths.add(entry.path);
    byCategory.set(entry.category, paths);
  }
  requireValue(
    byCategory.get("measurement-freeze-receipt")?.size === 1,
    "evidence must enumerate exactly one canonical measurement-freeze activation receipt"
  );
  const finalizationCategories = [
    "release-policy-finalization",
    "citation-finalization",
    "changelog-finalization"
  ] as const;
  const finalizationCount = finalizationCategories.filter(
    (category) => byCategory.get(category)?.size === 1
  ).length;
  requireValue(
    finalizationCount === 0 || finalizationCount === finalizationCategories.length,
    "release finalization must enumerate release-policy.json, CITATION.cff, and CHANGELOG.md together"
  );

  const reports = byCategory.get("featured-report") ?? new Set<string>();
  const provenances = byCategory.get("featured-provenance") ?? new Set<string>();
  for (const report of reports) {
    const provenance = report.replace(/\.json$/, ".provenance.json");
    requireValue(provenances.has(provenance), `featured report ${report} lacks its digest-enumerated provenance sidecar`);
  }
  for (const provenance of provenances) {
    const report = provenance.replace(/\.provenance\.json$/, ".json");
    requireValue(reports.has(report), `featured provenance ${provenance} lacks its digest-enumerated report`);
  }

  const controlledPublicationKinds = [
    "controlled-publication-manifest",
    "controlled-publication-receipt"
  ] as const;
  const controlledPublicationRoots = new Set<string>();
  for (const category of controlledPublicationKinds) {
    for (const entry of byCategory.get(category) ?? []) {
      controlledPublicationRoots.add(entry.split("/").slice(0, 3).join("/"));
    }
  }
  for (const publicationRoot of controlledPublicationRoots) {
    requireValue(
      byCategory
        .get("controlled-publication-manifest")
        ?.has(`${publicationRoot}/publication.json`) === true &&
        byCategory
          .get("controlled-publication-receipt")
          ?.has(`${publicationRoot}/receipt.json`) === true,
      `controlled publication ${publicationRoot} must enumerate exactly one publication manifest and receipt pair`
    );
  }

  const aaKinds = [
    "aa-attempt-ledger",
    "aa-evaluation",
    "aa-producer-receipt",
    "aa-producer-attestation"
  ] as const;
  const aaIds = new Set<string>();
  for (const category of aaKinds) {
    for (const entry of byCategory.get(category) ?? []) {
      aaIds.add(entry.split("/")[2] ?? "");
    }
  }
  for (const studyId of aaIds) {
    for (const category of aaKinds) {
      const filename =
        category === "aa-attempt-ledger"
            ? "attempt-ledger.json"
            : category === "aa-evaluation"
              ? "evaluation.json"
              : category === "aa-producer-receipt"
                ? "producer-receipt.json"
                : "producer-receipt.sigstore.json";
      requireValue(
        byCategory.get(category)?.has(`research/aa-studies/${studyId}/${filename}`) === true,
        `A/A study ${studyId} must enumerate attempt ledger, evaluation, producer receipt, and hosted attestation together`
      );
    }
  }
  const operatorGates = [
    "egress-backstop",
    "waf-ceilings",
    "log-retention",
    "container-image-licensing"
  ] as const;
  for (const gateId of operatorGates) {
    requireValue(
      byCategory
        .get("operator-evidence")
        ?.has(`research/ops-evidence/${gateId}.json`) === true &&
        byCategory
          .get("operator-attestation")
          ?.has(`research/ops-receipts/${gateId}-attestation.json`) === true,
      `operator gate ${gateId} must enumerate its canonical underlying evidence and attestation pair`
    );
  }
  const hostedArchives = new Map<string, Set<string>>();
  for (const archivePath of byCategory.get("hosted-evidence-archive") ?? []) {
    const parts = archivePath.split("/");
    const archiveRoot = parts.slice(0, 4).join("/");
    const relative = parts.slice(4).join("/");
    const entries = hostedArchives.get(archiveRoot) ?? new Set<string>();
    entries.add(relative);
    hostedArchives.set(archiveRoot, entries);
  }
  for (const [archiveRoot, entries] of hostedArchives) {
    requireValue(
      entries.has("context.json") &&
        entries.has("context.sigstore.json") &&
        entries.has("subject.json"),
      `hosted evidence archive ${archiveRoot} must enumerate context.json, context.sigstore.json, and subject.json together`
    );
  }
}

function verifyAaProducerReceipts(
  rootDir: string,
  expectedRepository: string,
  candidateCommit: string,
  evidence: MeasurementEvidenceEntry[],
  measurementInputByPath: Map<string, string>,
  freeze: {
    activatedAt: string;
    runnerLabelSha256: string;
    scannerEgress: string;
    scannerEgressRegionSha256: string;
  },
  target: MeasurementPostCandidateProducerReceipt[]
): void {
  const byPath = new Map(evidence.map((entry) => [entry.path, entry]));
  for (const receiptEntry of evidence.filter(
    (entry) => entry.category === "aa-producer-receipt"
  )) {
    const studyId = receiptEntry.path.split("/")[2] ?? "";
    const studyRoot = `research/aa-studies/${studyId}`;
    const bundlePath = `${studyRoot}/producer-receipt.sigstore.json`;
    const bundleEntry = byPath.get(bundlePath);
    requireValue(
      bundleEntry?.category === "aa-producer-attestation",
      `A/A study ${studyId} producer receipt lacks its exact Sigstore bundle`
    );
    const receiptAbsolute = regularFileInside(
      rootDir,
      receiptEntry.path,
      `A/A study ${studyId} producer receipt`
    );
    const bundleAbsolute = regularFileInside(
      rootDir,
      bundlePath,
      `A/A study ${studyId} producer receipt bundle`
    );
    const receiptText = readFileSync(receiptAbsolute, "utf8");
    const receipt = readJsonTextObject(
      receiptText,
      `A/A study ${studyId} producer receipt`
    );
    requireValue(
      receiptText === `${JSON.stringify(receipt, null, 2)}\n`,
      `A/A study ${studyId} producer receipt must be canonical serialized JSON`
    );
    requireExactOrderedKeys(
      receipt,
      [
        "schemaVersion",
        "artifactKind",
        "studyId",
        "producer",
        "attester",
        "artifact",
        "collection",
        "execution",
        "evidence",
        "recordedAt"
      ],
      `A/A study ${studyId} producer receipt`
    );
    requireValue(
      receipt.schemaVersion === 1 &&
        receipt.artifactKind === "site-behavior-aa-producer-receipt" &&
        receipt.studyId === studyId,
      `A/A study ${studyId} producer receipt identity is invalid`
    );
    const producer = requiredRecord(
      receipt.producer,
      `A/A study ${studyId} producer`
    );
    requireExactOrderedKeys(
      producer,
      [
        "workflow",
        "runId",
        "runAttempt",
        "runHeadCommit",
        "checkoutCommit",
        "conclusion"
      ],
      `A/A study ${studyId} producer`
    );
    requireValue(
      producer.workflow ===
        "iAnonymous3000/site-behavior-lab/.github/workflows/aa-study.yml@refs/heads/main" &&
        Number.isSafeInteger(producer.runId) &&
        (producer.runId as number) > 0 &&
        Number.isSafeInteger(producer.runAttempt) &&
        (producer.runAttempt as number) >= 1 &&
        (producer.runAttempt as number) <= 100 &&
        producer.checkoutCommit === candidateCommit &&
        producer.conclusion === "success",
      `A/A study ${studyId} must bind one successful governed producer run over the frozen candidate`
    );
    const producerCommit = requiredPattern(
      producer.runHeadCommit,
      FULL_GIT_SHA,
      `A/A study ${studyId} producer.runHeadCommit`
    );
    const attester = requiredRecord(
      receipt.attester,
      `A/A study ${studyId} attester`
    );
    requireExactOrderedKeys(
      attester,
      ["workflow", "sourceCommit"],
      `A/A study ${studyId} attester`
    );
    requireValue(
      attester.workflow ===
        "iAnonymous3000/site-behavior-lab/.github/workflows/archive-aa-study.yml@refs/heads/main",
      `A/A study ${studyId} must name the governed hosted archive workflow`
    );
    const attesterCommit = requiredPattern(
      attester.sourceCommit,
      FULL_GIT_SHA,
      `A/A study ${studyId} attester.sourceCommit`
    );

    const artifact = requiredRecord(
      receipt.artifact,
      `A/A study ${studyId} artifact`
    );
    requireExactOrderedKeys(
      artifact,
      ["id", "name", "archiveSha256", "manifestPath", "manifestSha256"],
      `A/A study ${studyId} artifact`
    );
    requireValue(
      Number.isSafeInteger(artifact.id) &&
        (artifact.id as number) > 0 &&
        artifact.name ===
          `site-behavior-aa-study-${studyId}-${producer.runId}-${producer.runAttempt}` &&
        SHA256.test(
          requireNonEmptyString(
            artifact.archiveSha256,
            `A/A study ${studyId} artifact.archiveSha256`
          )
        ) &&
        artifact.manifestPath === "aa-artifact.json" &&
        SHA256.test(
          requireNonEmptyString(
            artifact.manifestSha256,
            `A/A study ${studyId} artifact.manifestSha256`
          )
        ),
      `A/A study ${studyId} must bind the exact governed Actions artifact`
    );

    const collection = requiredRecord(
      receipt.collection,
      `A/A study ${studyId} collection`
    );
    requireExactOrderedKeys(
      collection,
      ["startedAt", "completedAt"],
      `A/A study ${studyId} collection`
    );
    const collectionStartedAt = requiredCanonicalInstant(
      collection.startedAt,
      `A/A study ${studyId} collection.startedAt`
    );
    const collectionCompletedAt = requiredCanonicalInstant(
      collection.completedAt,
      `A/A study ${studyId} collection.completedAt`
    );

    const execution = requiredRecord(
      receipt.execution,
      `A/A study ${studyId} execution`
    );
    requireExactOrderedKeys(
      execution,
      [
        "shardIndex",
        "shardCount",
        "exactAttemptSet",
        "orderPolicy",
        "runner",
        "egress"
      ],
      `A/A study ${studyId} execution`
    );
    requireValue(
      execution.shardIndex === 0 &&
        execution.shardCount === 1 &&
        execution.exactAttemptSet === true &&
        (execution.orderPolicy === "alternating-ab-ba-by-repetition" ||
          execution.orderPolicy === "not-applicable"),
      `A/A study ${studyId} must use one exact unsharded attempt set and a governed order policy`
    );
    const runner = requiredRecord(
      execution.runner,
      `A/A study ${studyId} execution.runner`
    );
    requireExactOrderedKeys(
      runner,
      ["labelSha256", "identitySha256", "environment"],
      `A/A study ${studyId} execution.runner`
    );
    requireValue(
      runner.labelSha256 === freeze.runnerLabelSha256 &&
        SHA256.test(
          requireNonEmptyString(
            runner.identitySha256,
            `A/A study ${studyId} execution.runner.identitySha256`
          )
        ) &&
        runner.environment === "ephemeral-self-hosted",
      `A/A study ${studyId} runner must bind the freeze-selected ephemeral controlled runner`
    );
    const egress = requiredRecord(
      execution.egress,
      `A/A study ${studyId} execution.egress`
    );
    requireExactOrderedKeys(
      egress,
      ["identity", "regionSha256"],
      `A/A study ${studyId} execution.egress`
    );
    requireValue(
      egress.identity === freeze.scannerEgress &&
        egress.identity === "controlled-self-hosted" &&
        egress.regionSha256 === freeze.scannerEgressRegionSha256,
      `A/A study ${studyId} egress must bind the freeze-selected controlled identity and region`
    );

    const evidenceBindings = requiredRecord(
      receipt.evidence,
      `A/A study ${studyId} evidence`
    );
    requireExactOrderedKeys(
      evidenceBindings,
      ["preregistration", "targetFrame", "attemptLedger", "evaluation"],
      `A/A study ${studyId} evidence`
    );
    const namedBindings = [
      ["preregistration", "preregistration.json", false],
      ["targetFrame", "target-frame.json", false],
      ["attemptLedger", "attempt-ledger.json", true],
      ["evaluation", "evaluation.json", true]
    ] as const;
    const actualEvidencePaths: string[] = [];
    for (const [key, filename, postCandidate] of namedBindings) {
      const binding = requiredRecord(
        evidenceBindings[key],
        `A/A study ${studyId} evidence.${key}`
      );
      requireExactOrderedKeys(
        binding,
        postCandidate
          ? key === "attemptLedger"
            ? ["path", "sha256", "receiptDigest"]
            : ["path", "sha256", "evaluationDigest"]
          : ["path", "sha256"],
        `A/A study ${studyId} evidence.${key}`
      );
      requireValue(
        binding.path === filename,
        `A/A study ${studyId} evidence.${key}.path must be ${filename}`
      );
      const digest = requiredPattern(
        binding.sha256,
        SHA256,
        `A/A study ${studyId} evidence.${key}.sha256`
      );
      const fullPath = `${studyRoot}/${filename}`;
      actualEvidencePaths.push(fullPath);
      if (postCandidate) {
        requireValue(
          byPath.get(fullPath)?.sha256 === digest,
          `A/A study ${studyId} evidence.${key} must bind its digest-enumerated carrier file`
        );
      } else {
        requireValue(
          measurementInputByPath.get(fullPath) === digest,
          `A/A study ${studyId} evidence.${key} must bind its candidate-resident measurement input`
        );
      }
    }
    const ledgerPath = `${studyRoot}/attempt-ledger.json`;
    const ledger = readJsonObject(
      regularFileInside(rootDir, ledgerPath, `A/A study ${studyId} ledger`),
      `A/A study ${studyId} ledger`
    );
    const ledgerBinding = requiredRecord(
      evidenceBindings.attemptLedger,
      `A/A study ${studyId} evidence.attemptLedger`
    );
    requireValue(
      ledgerBinding.receiptDigest === ledger.receiptDigest,
      `A/A study ${studyId} producer receipt must bind the ledger receiptDigest`
    );
    const ledgerCollection = requiredRecord(
      ledger.collection,
      `A/A study ${studyId} ledger.collection`
    );
    requireValue(
      ledgerCollection.startedAt === collectionStartedAt &&
        ledgerCollection.completedAt === collectionCompletedAt,
      `A/A study ${studyId} producer receipt collection must equal the ledger collection window`
    );
    requireValue(
      Array.isArray(ledger.attempts),
      `A/A study ${studyId} ledger attempts must be an array`
    );
    const comparisonPresent = ledger.attempts.some(
      (attempt) =>
        isRecord(attempt) &&
        isRecord(attempt.observation) &&
        attempt.observation.reportType === "comparison"
    );
    requireValue(
      execution.orderPolicy ===
        (comparisonPresent
          ? "alternating-ab-ba-by-repetition"
          : "not-applicable"),
      `A/A study ${studyId} execution order policy must match the retained report shape`
    );
    const evaluationPath = `${studyRoot}/evaluation.json`;
    const evaluation = readJsonObject(
      regularFileInside(
        rootDir,
        evaluationPath,
        `A/A study ${studyId} evaluation`
      ),
      `A/A study ${studyId} evaluation`
    );
    const evaluationBinding = requiredRecord(
      evidenceBindings.evaluation,
      `A/A study ${studyId} evidence.evaluation`
    );
    requireValue(
      evaluation.status === "pass" &&
        evaluationBinding.evaluationDigest === evaluation.evaluationDigest,
      `A/A study ${studyId} producer receipt must bind one passing exact evaluation`
    );

    const recordedAt = requiredCanonicalInstant(
      receipt.recordedAt,
      `A/A study ${studyId} recordedAt`
    );
    requireValue(
      Date.parse(freeze.activatedAt) <= Date.parse(collectionStartedAt) &&
        Date.parse(collectionStartedAt) <= Date.parse(collectionCompletedAt) &&
        Date.parse(collectionCompletedAt) <= Date.parse(recordedAt),
      `A/A study ${studyId} chronology must run freeze, collection, and hosted archival in causal order`
    );
    target.push({
      evidencePath: receiptEntry.path,
      pairedEvidencePaths: [
        ...actualEvidencePaths,
        receiptEntry.path,
        bundlePath
      ],
      producerCommit: attesterCommit,
      causalProducerCommits: [producerCommit, attesterCommit],
      causalEvidencePaths: [
        ledgerPath,
        evaluationPath,
        receiptEntry.path,
        bundlePath
      ],
      collectionStartedAt,
      collectionCompletedAt,
      artifactCreatedAt: recordedAt,
      attestationRequest: {
        subject: "aa-producer-receipt",
        artifactPath: receiptAbsolute,
        bundlePath: bundleAbsolute,
        repository: expectedRepository,
        signerWorkflow:
          "iAnonymous3000/site-behavior-lab/.github/workflows/archive-aa-study.yml",
        certIdentity:
          "https://github.com/iAnonymous3000/site-behavior-lab/.github/workflows/archive-aa-study.yml@refs/heads/main",
        signerDigest: attesterCommit,
        sourceDigest: attesterCommit,
        sourceRef: "refs/heads/main",
        denySelfHostedRunners: true,
        predicateType: "https://slsa.dev/provenance/v1",
        oidcIssuer: "https://token.actions.githubusercontent.com"
      }
    });
  }
}

function verifyReleaseFinalization(
  rootDir: string,
  candidateCommit: string,
  evidence: MeasurementEvidenceEntry[]
): void {
  if (!evidence.some((entry) => entry.category === "release-policy-finalization")) return;
  const candidatePolicy = readJsonTextObject(
    gitBlob(rootDir, candidateCommit, "release-policy.json"),
    "candidate release-policy.json"
  );
  const releasedPolicy = readJsonObject(
    absoluteRepoPath(rootDir, "release-policy.json"),
    "released release-policy.json"
  );
  const policyKeys = [
    "schemaVersion",
    "status",
    "version",
    "releaseTag",
    "releaseDate",
    "stablePublicApi",
    "npmPublication"
  ];
  requireExactKeys(candidatePolicy, policyKeys, "candidate release-policy.json");
  requireExactKeys(releasedPolicy, policyKeys, "released release-policy.json");
  requireValue(
    candidatePolicy.schemaVersion === 2 &&
      candidatePolicy.status === "development" &&
      candidatePolicy.version === MEASUREMENT_CANDIDATE_TARGET_RELEASE &&
      candidatePolicy.releaseTag === null &&
      candidatePolicy.releaseDate === null &&
      candidatePolicy.stablePublicApi === false &&
      candidatePolicy.npmPublication === "disabled",
    "candidate release-policy.json must be the exact reviewed 1.0.0 development policy"
  );
  const releaseDate =
    typeof releasedPolicy.releaseDate === "string" ? releasedPolicy.releaseDate : "";
  requireValue(
    /^\d{4}-\d{2}-\d{2}$/.test(releaseDate) &&
      Number.isFinite(Date.parse(`${releaseDate}T00:00:00.000Z`)) &&
      new Date(`${releaseDate}T00:00:00.000Z`).toISOString().slice(0, 10) ===
        releaseDate,
    "released release-policy.json must carry one canonical release date"
  );
  requireValue(
    releasedPolicy.schemaVersion === 2 &&
      releasedPolicy.status === "released" &&
      releasedPolicy.version === MEASUREMENT_CANDIDATE_TARGET_RELEASE &&
      releasedPolicy.releaseTag === "v1.0.0" &&
      releasedPolicy.stablePublicApi === false &&
      releasedPolicy.npmPublication === "disabled",
    "released release-policy.json must be the exact v1.0.0 finalization"
  );

  const candidatePackage = readJsonTextObject(
    gitBlob(rootDir, candidateCommit, "package.json"),
    "candidate package.json"
  );
  const candidateLock = readJsonTextObject(
    gitBlob(rootDir, candidateCommit, "package-lock.json"),
    "candidate package-lock.json"
  );
  const lockRoot = requiredRecord(
    requiredRecord(candidateLock.packages, "candidate package-lock packages")[""],
    "candidate package-lock root package"
  );
  requireValue(
    candidatePackage.version === "1.0.0" &&
      candidateLock.version === "1.0.0" &&
      lockRoot.version === "1.0.0",
    "candidate package and lock root must already be version 1.0.0"
  );

  const candidateCitation = gitBlob(rootDir, candidateCommit, "CITATION.cff");
  const releasedCitation = readFileSync(
    absoluteRepoPath(rootDir, "CITATION.cff"),
    "utf8"
  );
  const citationVersion = 'version: "1.0.0"\n';
  requireValue(
    candidateCitation.split(citationVersion).length === 2 &&
      !candidateCitation.includes("date-released:"),
    "candidate CITATION.cff must name 1.0.0 and carry no release date"
  );
  const expectedCitation = candidateCitation.replace(
    citationVersion,
    `${citationVersion}date-released: "${releaseDate}"\n`
  );
  requireValue(
    releasedCitation === expectedCitation,
    "CITATION.cff finalization may only add the release-policy date after version 1.0.0"
  );

  const candidateChangelog = gitBlob(rootDir, candidateCommit, "CHANGELOG.md");
  const releasedChangelog = readFileSync(
    absoluteRepoPath(rootDir, "CHANGELOG.md"),
    "utf8"
  );
  const candidateHeading = "## [1.0.0] - UNRELEASED";
  requireValue(
    candidateChangelog.split(candidateHeading).length === 2,
    "candidate CHANGELOG.md must contain exactly one pre-reviewed 1.0.0 UNRELEASED heading"
  );
  requireValue(
    releasedChangelog ===
      candidateChangelog.replace(candidateHeading, `## [1.0.0] - ${releaseDate}`),
    "CHANGELOG.md finalization may only replace the pre-reviewed 1.0.0 date marker"
  );
}

function verifySourceEvidenceManifest(
  manifest: JsonRecord,
  candidateCommit: string,
  candidateTree: string,
  repository: string
): JsonRecord {
  requireValue(
    manifest.evidenceKind === "exact-source-and-tested-artifact-manifest",
    "measurement candidate source evidence manifest has the wrong evidenceKind"
  );
  const source = requiredRecord(manifest.source, "measurement candidate source evidence source");
  requireValue(
    source.commit === candidateCommit,
    "measurement candidate source evidence commit does not match candidateCommit"
  );
  requireValue(
    source.tree === candidateTree,
    "measurement candidate source evidence tree does not match candidateTree"
  );
  const release = requiredRecord(manifest.release, "measurement candidate source evidence release");
  requireValue(
    release.repository === `https://github.com/${repository}`,
    "measurement candidate source evidence repository does not match binding repository"
  );
  requireValue(Array.isArray(manifest.artifacts), "measurement candidate source artifacts must be an array");
  const containers = manifest.artifacts.filter(
    (entry) =>
      isRecord(entry) &&
      entry.name === "container-image" &&
      entry.kind === "docker-image-inspection"
  );
  requireValue(
    containers.length === 1,
    "measurement candidate source evidence must contain exactly one container-image inspection"
  );
  requireValue(
    (containers[0] as JsonRecord).sourceCommit === candidateCommit,
    "measurement candidate container sourceCommit does not match candidateCommit"
  );
  const container = containers[0] as JsonRecord;
  requiredPattern(container.imageId, /^sha256:[0-9a-f]{64}$/, "container imageId");
  requireValue(
    typeof container.os === "string" && container.os.length > 0,
    "measurement candidate container os is missing"
  );
  requireValue(
    typeof container.architecture === "string" && container.architecture.length > 0,
    "measurement candidate container architecture is missing"
  );
  requireValue(
    Array.isArray(container.rootfsLayers) &&
      container.rootfsLayers.length > 0 &&
      container.rootfsLayers.every(
        (entry) => typeof entry === "string" && /^sha256:[0-9a-f]{64}$/.test(entry)
      ),
    "measurement candidate container rootfsLayers are malformed"
  );
  return container;
}

function verifyContainerPackageInventory(
  inventory: JsonRecord,
  candidateCommit: string,
  container: JsonRecord
): void {
  requireExactOrderedKeys(
    inventory,
    [
      "schemaVersion",
      "artifactKind",
      "source",
      "image",
      "scanner",
      "summary",
      "packageSetDigest",
      "packages"
    ],
    "container package inventory"
  );
  requireValue(
    inventory.schemaVersion === 1 &&
      inventory.artifactKind === "site-behavior-container-image-package-inventory",
    "measurement candidate container package inventory has the wrong schema or artifact kind"
  );
  const source = requiredRecord(inventory.source, "container package inventory source");
  requireExactOrderedKeys(source, ["commit"], "container package inventory source");
  requireValue(
    source.commit === candidateCommit,
    "container package inventory source.commit must match the measurement candidate"
  );
  const image = requiredRecord(inventory.image, "container package inventory image");
  requireExactOrderedKeys(
    image,
    ["id", "digest", "os", "architecture", "rootfsLayers"],
    "container package inventory image"
  );
  const imageId = requiredPattern(image.id, /^sha256:[0-9a-f]{64}$/, "container package inventory image.id");
  requireValue(
    image.digest === imageId.slice("sha256:".length),
    "container package inventory image.digest must match image.id"
  );
  requireValue(
    image.id === container.imageId &&
      image.os === container.os &&
      image.architecture === container.architecture &&
      JSON.stringify(image.rootfsLayers) === JSON.stringify(container.rootfsLayers),
    "container package inventory image identity does not match container evidence"
  );
  requireValue(
    Array.isArray(inventory.packages) && inventory.packages.length > 0,
    "container package inventory must contain packages"
  );
  requiredPattern(
    inventory.packageSetDigest,
    SHA256,
    "container package inventory packageSetDigest"
  );
}

function measurementRuntimeFromContainerEvidence(
  container: JsonRecord,
  identity: MeasurementIdentity
): MeasurementRuntimeIdentity {
  const runtime = requiredRecord(
    container.runtime,
    "measurement candidate container runtime"
  );
  requireExactKeys(
    runtime,
    ["node", "npm", "probeIsolation"],
    "measurement candidate container runtime"
  );
  const probeIsolation = requiredRecord(
    runtime.probeIsolation,
    "measurement candidate container runtime probeIsolation"
  );
  requireExactKeys(
    probeIsolation,
    [
      "pull",
      "network",
      "rootFilesystem",
      "capabilities",
      "noNewPrivileges"
    ],
    "measurement candidate container runtime probeIsolation"
  );
  requireValue(
    runtime.node === identity.toolchain.containerNodeVersion &&
      runtime.npm === "absent" &&
      probeIsolation.pull === "never" &&
      probeIsolation.network === "none" &&
      probeIsolation.rootFilesystem === "read-only" &&
      probeIsolation.capabilities === "all-dropped" &&
      probeIsolation.noNewPrivileges === true,
    "attested container runtime does not match the candidate toolchain and isolation contract"
  );
  const imageId = requiredPattern(
    container.imageId,
    /^sha256:[0-9a-f]{64}$/,
    "measurement candidate container imageId"
  );
  const operatingSystem = requireNonEmptyString(
    container.os,
    "measurement candidate container operating system"
  );
  const architecture = requireNonEmptyString(
    container.architecture,
    "measurement candidate container architecture"
  );
  requireValue(
    Array.isArray(container.rootfsLayers) &&
      container.rootfsLayers.length > 0 &&
      container.rootfsLayers.every(
        (entry) =>
          typeof entry === "string" && /^sha256:[0-9a-f]{64}$/.test(entry)
      ),
    "measurement candidate container rootfsLayers are invalid"
  );
  return {
    containerImageId: imageId,
    operatingSystem,
    architecture,
    rootfsLayers: [...(container.rootfsLayers as string[])],
    nodeVersion: runtime.node as string,
    npm: "absent"
  };
}

function verifyMeasurementFreezeReceipt(
  rootDir: string,
  receipt: JsonRecord,
  candidateCommit: string,
  receiptPath: string,
  verifyCandidateBlobs: boolean
): void {
  requireValue(
    receipt.kind === "site-behavior-lab-measurement-freeze-activation",
    "measurement-freeze receipt has the wrong kind"
  );
  requireValue(receipt.receiptVersion === 2, "measurement-freeze receiptVersion must be 2");
  const candidate = requiredRecord(receipt.candidate, "measurement-freeze receipt candidate");
  requireValue(
    candidate.commit === candidateCommit,
    "measurement-freeze receipt candidate.commit must match the measurement candidate"
  );
  requireValue(
    candidate.checkoutCommit === candidateCommit,
    "measurement-freeze receipt candidate.checkoutCommit must match the measurement candidate"
  );
  requireValue(
    candidate.mainRefCommit === candidateCommit,
    "measurement-freeze receipt candidate.mainRefCommit must match the measurement candidate"
  );
  const activation = requiredRecord(receipt.activation, "measurement-freeze receipt activation");
  requireValue(
    activation.headSha === candidateCommit,
    "measurement-freeze receipt activation.headSha must match the measurement candidate"
  );
  const readjudication = requiredRecord(
    receipt.reAdjudication,
    "measurement-freeze receipt reAdjudication"
  );
  requireValue(
    readjudication.receiptPath ===
      "research/ops-receipts/featured-readjudication.json",
    "measurement-freeze receipt must bind the fixed featured re-adjudication receipt"
  );
  const readjudicationSha256 = requiredPattern(
    readjudication.receiptSha256,
    SHA256,
    "measurement-freeze receipt reAdjudication.receiptSha256"
  );
  candidateResidentText(
    rootDir,
    candidateCommit,
    "research/ops-receipts/featured-readjudication.json",
    readjudicationSha256,
    verifyCandidateBlobs,
    "featured re-adjudication receipt"
  );
  const featuredSitesSha256 = requiredPattern(
    readjudication.finalFeaturedSitesSha256,
    SHA256,
    "measurement-freeze receipt reAdjudication.finalFeaturedSitesSha256"
  );
  candidateResidentText(
    rootDir,
    candidateCommit,
    "public/featured-sites.json",
    featuredSitesSha256,
    verifyCandidateBlobs,
    "post-re-adjudication featured-sites catalog"
  );
  const handoff = requiredRecord(receipt.handoff, "measurement-freeze receipt handoff");
  requireValue(
    handoff.archivePath === receiptPath,
    "measurement-freeze receipt handoff.archivePath must match its fixed committed path"
  );
}

function verifyMeasurementFreezeReceiptWithCanonicalCli(
  request: MeasurementFreezeReceiptVerificationRequest,
  explicitArtifactContext?: {
    directory: string;
    sha256: string;
  }
): void {
  const validator = path.join(
    request.rootDir,
    "scripts",
    "validate-measurement-freeze-activation-receipt.mjs"
  );
  const activationWorkflow = path.join(
    request.rootDir,
    ".github",
    "workflows",
    "activate-measurement-freeze.yml"
  );
  const featuredWorkflow = path.join(
    request.rootDir,
    ".github",
    "workflows",
    "scan-featured.yml"
  );
  requireValue(
    existsSync(validator) && existsSync(activationWorkflow) && existsSync(featuredWorkflow),
    "canonical measurement-freeze receipt validator and bound workflows must exist"
  );
  const artifactContext =
    explicitArtifactContext !== undefined
      ? explicitArtifactContext.directory
      : process.env.SITE_BEHAVIOR_LAB_MEASUREMENT_FREEZE_ARTIFACT_CONTEXT?.trim();
  const artifactContextSha256 =
    explicitArtifactContext !== undefined
      ? explicitArtifactContext.sha256
      : process.env
          .SITE_BEHAVIOR_LAB_MEASUREMENT_FREEZE_ARTIFACT_CONTEXT_SHA256?.trim() ??
        "";
  if (artifactContext) {
    requireValue(
      path.isAbsolute(artifactContext),
      "SITE_BEHAVIOR_LAB_MEASUREMENT_FREEZE_ARTIFACT_CONTEXT must be an absolute trusted prefetch directory"
    );
    requireValue(
      SHA256.test(artifactContextSha256),
      "SITE_BEHAVIOR_LAB_MEASUREMENT_FREEZE_ARTIFACT_CONTEXT_SHA256 must bind the exact trusted prefetch context"
    );
  } else {
    requireValue(
      artifactContextSha256.length === 0,
      "SITE_BEHAVIOR_LAB_MEASUREMENT_FREEZE_ARTIFACT_CONTEXT_SHA256 requires SITE_BEHAVIOR_LAB_MEASUREMENT_FREEZE_ARTIFACT_CONTEXT"
    );
  }
  const liveArtifactArgs = artifactContext
    ? [
        "--live-artifact-context",
        artifactContext,
        "--live-artifact-context-sha256",
        artifactContextSha256
      ]
    : ["--verify-live-artifact"];
  const result = spawnSync(
    process.execPath,
    [
      validator,
      "--receipt",
      request.receiptPath,
      "--candidate",
      request.candidateCommit,
      "--activation-workflow",
      activationWorkflow,
      "--featured-workflow",
      featuredWorkflow,
      "--readjudication-receipt",
      "research/ops-receipts/featured-readjudication.json",
      "--featured-sites",
      "public/featured-sites.json",
      ...liveArtifactArgs,
      "--now",
      new Date().toISOString()
    ],
    {
      cwd: request.rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000
    }
  );
  requireValue(
    result.status === 0,
    `canonical measurement-freeze receipt verification failed${
      result.stderr.trim() ? `: ${result.stderr.trim().slice(0, 400)}` : ""
    }`
  );
}

function verifyAttestationWithGh(
  request: MeasurementCandidateAttestationRequest,
  rootDir: string
): void {
  let output: string;
  try {
    const gh = execFileSync(
      process.execPath,
      [path.join(rootDir, "scripts", "ensure-gh-attestation-verifier.mjs")],
      {
        cwd: rootDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"]
      }
    ).trim();
    requireValue(gh.length > 0, "exact GitHub CLI verifier path is empty");
    output = execFileSync(
      gh,
      measurementCandidateAttestationVerifyArgs(request),
      {
        cwd: rootDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
  } catch (error) {
    const detail =
      isRecord(error) && typeof error.stderr === "string"
        ? error.stderr.trim().slice(0, 400)
        : "";
    throw new Error(
      `measurement candidate Sigstore attestation verification failed${detail ? `: ${detail}` : ""}`
    );
  }
  let result: unknown;
  try {
    result = JSON.parse(output);
  } catch {
    throw new Error("measurement candidate Sigstore verifier did not return valid JSON");
  }
  requireValue(
    Array.isArray(result) && result.length > 0,
    "measurement candidate Sigstore verifier returned no verified attestations"
  );
}

function attestationRequest(
  value: MeasurementCandidateAttestationRequest & { status: string }
): MeasurementCandidateAttestationRequest {
  return {
    subject: value.subject,
    artifactPath: value.artifactPath,
    bundlePath: value.bundlePath,
    repository: value.repository,
    signerWorkflow: value.signerWorkflow,
    certIdentity: value.certIdentity,
    signerDigest: value.signerDigest,
    sourceDigest: value.sourceDigest,
    sourceRef: value.sourceRef,
    denySelfHostedRunners: value.denySelfHostedRunners,
    predicateType: value.predicateType,
    oidcIssuer: value.oidcIssuer
  };
}

function addEnumeratedPath(
  target: Map<
    string,
    {
      change: MeasurementEvidenceChange;
      sha256: string;
    }
  >,
  evidencePath: string,
  change: MeasurementEvidenceChange,
  sha256: string
): void {
  requireValue(
    evidencePath !== MEASUREMENT_CANDIDATE_BINDING_PATH,
    "the self-referential binding path cannot be an evidence entry"
  );
  requireValue(!target.has(evidencePath), `evidence repeats path ${evidencePath}`);
  target.set(evidencePath, { change, sha256 });
}

function gitNameStatus(
  rootDir: string,
  candidateCommit: string,
  carrierCommit: string
): Array<{ status: string; paths: string[] }> {
  const raw = git(rootDir, [
    "diff",
    "--name-status",
    "-z",
    "--no-renames",
    candidateCommit,
    carrierCommit,
    "--"
  ]);
  const parts = raw.split("\0");
  if (parts.at(-1) === "") parts.pop();
  const changes: Array<{ status: string; paths: string[] }> = [];
  for (let index = 0; index < parts.length; ) {
    const status = parts[index++];
    requireValue(
      typeof status === "string" && status.length > 0,
      "candidate-to-carrier diff has a malformed status"
    );
    const pathCount = status.startsWith("R") || status.startsWith("C") ? 2 : 1;
    const paths = parts.slice(index, index + pathCount);
    requireValue(
      paths.length === pathCount && paths.every((entry) => entry.length > 0),
      "candidate-to-carrier diff is malformed"
    );
    index += pathCount;
    changes.push({ status, paths });
  }
  return changes;
}

function regularFileInside(rootDir: string, relativePath: string, label: string): string {
  requireCanonicalRelativePath(relativePath, label);
  const absolute = absoluteRepoPath(rootDir, relativePath);
  let stat;
  try {
    stat = lstatSync(absolute);
  } catch {
    throw new Error(`${label} does not exist`);
  }
  requireValue(
    stat.isFile() && !stat.isSymbolicLink(),
    `${label} must be a regular file, never a symlink`
  );
  return absolute;
}

function absoluteRepoPath(rootDir: string, relativePath: string): string {
  const root = path.resolve(rootDir);
  const absolute = path.resolve(root, ...relativePath.split("/"));
  requireValue(
    absolute.startsWith(`${root}${path.sep}`),
    `${relativePath} escapes the repository`
  );
  return absolute;
}

function requiredFixedPath(value: unknown, label: string, pattern: RegExp): string {
  const result = requiredCanonicalPath(value, label);
  requireValue(pattern.test(result), `${label} is outside the fixed calibration evidence roots`);
  return result;
}

function requiredCanonicalPath(value: unknown, label: string): string {
  requireValue(typeof value === "string", `${label} must be a string`);
  requireCanonicalRelativePath(value as string, label);
  return value as string;
}

function requireCanonicalRelativePath(value: string, label: string): void {
  requireValue(value.length > 0 && value.length <= 240, `${label} must be a bounded relative path`);
  requireValue(
    !value.includes("\\") && !value.includes("\0"),
    `${label} must use canonical POSIX path syntax`
  );
  requireValue(!path.posix.isAbsolute(value), `${label} must be relative`);
  requireValue(
    path.posix.normalize(value) === value,
    `${label} must not contain traversal or redundant segments`
  );
}

function readJsonObject(filePath: string, label: string): JsonRecord {
  const value = readJson(filePath, label);
  requireValue(isRecord(value), `${label} must be a JSON object`);
  return value as JsonRecord;
}

function readJsonTextObject(value: string, label: string): JsonRecord {
  try {
    const parsed: unknown = JSON.parse(value);
    requireValue(isRecord(parsed), `${label} must be a JSON object`);
    return parsed;
  } catch (error) {
    if (error instanceof Error && error.message === `${label} must be a JSON object`) throw error;
    throw new Error(`${label} is not valid JSON`);
  }
}

function readJson(filePath: string, label: string): unknown {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

function sha256File(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function requiredRecord(value: unknown, label: string): JsonRecord {
  requireValue(isRecord(value), `${label} must be an object`);
  return value as JsonRecord;
}

function requiredPattern(value: unknown, pattern: RegExp, label: string): string {
  requireValue(typeof value === "string" && pattern.test(value), `${label} has an invalid format`);
  return value as string;
}

function requiredCanonicalInstant(value: unknown, label: string): string {
  requireValue(
    typeof value === "string" &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
      Number.isFinite(Date.parse(value)) &&
      new Date(Date.parse(value)).toISOString() === value,
    `${label} must be a canonical ISO 8601 instant`
  );
  return value as string;
}

function requireNonEmptyString(value: unknown, label: string): string {
  requireValue(
    typeof value === "string" && value.trim().length > 0 && value.length <= 500,
    `${label} must be one bounded non-empty string`
  );
  return value as string;
}

function requiredToken(value: unknown, label: string): string {
  requireValue(
    typeof value === "string" && /^[a-z0-9][a-z0-9._-]{0,99}$/.test(value),
    `${label} must be a bounded lowercase token`
  );
  return value as string;
}

function requiredDetector(value: unknown, label: string): DetectorId {
  requireValue(
    typeof value === "string" && DETECTOR_IDS.includes(value as DetectorId),
    `${label} must name a current detector`
  );
  return value as DetectorId;
}

function requiredEvidenceCategory(value: unknown, label: string): MeasurementEvidenceCategory {
  requireValue(
    typeof value === "string" &&
      Object.prototype.hasOwnProperty.call(EVIDENCE_PATH_POLICIES, value),
    `${label} is not a code-owned evidence category`
  );
  return value as MeasurementEvidenceCategory;
}

function requireExactKeys(value: JsonRecord, expected: string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  requireValue(
    actual.length === wanted.length && actual.every((entry, index) => entry === wanted[index]),
    `${label} must contain exactly ${wanted.join(", ")}`
  );
}

function requireExactOrderedKeys(value: JsonRecord, expected: string[], label: string): void {
  const actual = Object.keys(value);
  requireValue(
    actual.length === expected.length &&
      actual.every((entry, index) => entry === expected[index]),
    `${label} must contain exactly the canonical ordered fields`
  );
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireGitCommit(rootDir: string, commit: string): void {
  requireValue(
    gitExit(rootDir, ["cat-file", "-e", `${commit}^{commit}`]) === 0,
    `measurement candidate ${commit} is not a commit`
  );
}

function git(rootDir: string, args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch {
    throw new Error(`measurement candidate binding could not run git ${args[0] ?? ""}`.trim());
  }
}

function gitBlob(rootDir: string, commit: string, relativePath: string): string {
  requireCanonicalRelativePath(relativePath, "candidate blob path");
  try {
    return execFileSync("git", ["show", `${commit}:${relativePath}`], {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch {
    throw new Error(`measurement candidate is missing ${relativePath}`);
  }
}

function gitExit(rootDir: string, args: string[]): number | null {
  return spawnSync("git", args, {
    cwd: rootDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).status;
}

function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
