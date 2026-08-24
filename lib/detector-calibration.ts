/**
 * Strict, analysis-only contract for external detector-calibration studies.
 *
 * The source-pinned acceptance fixtures prove selected implementation cases;
 * they are intentionally not fed into this model. Calibration rates require a
 * separately labeled case corpus with an accountable planned denominator.
 */
import packageManifest from "../package.json";
import braveListManifest from "./adblock-wasm/brave-default-filters.meta.json";
import { FULL_GIT_SHA, recordedBuildCommit } from "./build-provenance";
import { detectorValidationMetadata } from "./detector-validation";
import { isRecord } from "./guards";
import {
  NODE_ADBLOCK_ENGINE_VERSION,
  NODE_PLAYWRIGHT_VERSION
} from "./legacy-methodology";
import {
  DETECTOR_REGISTRY_DIGEST,
  DETECTOR_REGISTRY_VERSION,
  DETECTOR_VERSIONS
} from "./measurement-kernel";
import { NODE_SCAN_REPORT_V2_R2_NORMALIZATION_VERSION } from "./scan-report-v2-normalization";
import {
  braveListMeasurementIdentity,
  NODE_SCAN_REPORT_V2_R2_METHODOLOGY_VERSION
} from "./scan-report-v2-r2-producer-contract";
import { DETECTOR_IDS, type DetectorId } from "./scan-report-v2";
import { canonicalJson } from "./scan-report-v2-fingerprints";
import { sha256Hex } from "./sha256";
import { trackerCatalogMetadata } from "./tracker-catalog";

export const DETECTOR_CALIBRATION_ANALYSIS_VERSION = "detector-calibration-analysis-v3" as const;
export const DETECTOR_CALIBRATION_STUDY_SCHEMA_VERSION = 1 as const;
export const DETECTOR_CALIBRATION_STUDY_SCHEMA_ID =
  "https://sitebehavior.org/schemas/detector-calibration-study.v1.schema.json" as const;
export const DETECTOR_CALIBRATION_STUDY_V2_SCHEMA_VERSION = 2 as const;
export const DETECTOR_CALIBRATION_STUDY_V2_SCHEMA_ID =
  "https://sitebehavior.org/schemas/detector-calibration-study.v2.schema.json" as const;
export const DETECTOR_CALIBRATION_STUDY_V3_SCHEMA_VERSION = 3 as const;
export const DETECTOR_CALIBRATION_STUDY_V3_SCHEMA_ID =
  "https://sitebehavior.org/schemas/detector-calibration-study.v3.schema.json" as const;
const DETECTOR_CALIBRATION_MAX_CASES = 100_000;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_LABELERS = 10;

export type DetectorCalibrationSampling = "simple-random" | "census" | "convenience";
export type DetectorCalibrationMeasurementCondition = {
  device: "desktop";
  gpcEnabled: false;
  consentMode: "observe" | "accept-all";
  interpretation: string;
};

const PASSIVE_CALIBRATION_CONDITION_INTERPRETATION =
  "Rates are conditional on desktop visits with GPC disabled under passive consent observation with no consent action.";
const PIXEL_EVENTS_CALIBRATION_CONDITION_INTERPRETATION =
  "Rates are conditional on desktop visits where accept-all registration was verified and reverified after reload, with GPC disabled.";
const CONSENT_BANNER_CALIBRATION_CONDITION_INTERPRETATION =
  "Rates are conditional on desktop visits with GPC disabled under passive consent-banner observation with no consent action.";

/**
 * Canonical, detector-specific measurement arms. A calibration study cannot
 * generalize beyond this exact condition. Pixel sensitivity deliberately uses
 * the consent-accepted arm established by the pilot; the consent-banner
 * detector remains passive because its private observation seam is observe-only.
 */
export function detectorCalibrationMeasurementCondition(
  detector: DetectorId
): DetectorCalibrationMeasurementCondition {
  if (detector === "pixel-events") {
    return {
      device: "desktop",
      gpcEnabled: false,
      consentMode: "accept-all",
      interpretation: PIXEL_EVENTS_CALIBRATION_CONDITION_INTERPRETATION
    };
  }
  if (detector === "consent-banner") {
    return {
      device: "desktop",
      gpcEnabled: false,
      consentMode: "observe",
      interpretation: CONSENT_BANNER_CALIBRATION_CONDITION_INTERPRETATION
    };
  }
  return {
    device: "desktop",
    gpcEnabled: false,
    consentMode: "observe",
    interpretation: PASSIVE_CALIBRATION_CONDITION_INTERPRETATION
  };
}
export type DetectorCalibrationCensorReason =
  | "capture-failed"
  | "reference-label-uncertain"
  | "artifact-unreadable"
  | "eligibility-criteria-not-met";

export type DetectorCalibrationRuntimeIdentity = {
  observer: "node-playwright";
  automation: "playwright-chromium";
  nodeVersion: string;
  playwrightVersion: string;
  browserName: "chromium";
  browserVersion: string;
  operatingSystem: string;
  architecture: string;
  runtimeDigest: string;
};

export type DetectorCalibrationReleaseIdentity = {
  buildCommit: string;
  detectorVersion: string;
  detectorImplementationDigest: string;
  registryVersion: string;
  registryDigest: string;
  methodologyVersion: string;
  normalizationVersion: string;
  trackerCatalog: {
    version: string;
    digest: string;
    provenanceVersion: string;
    provenanceDigest: string;
  };
  braveLists: {
    source: string;
    catalogCommit: string;
    catalogDigest: string;
    lists: number;
    fetchedAt: string;
    manifestDigest: string;
    rulesDigest: string;
    engineVersion: string;
  };
  runtime: DetectorCalibrationRuntimeIdentity;
};

export type DetectorCalibrationReferenceV3 = {
  value: "present" | "absent";
  evidenceArtifactDigest: string;
  labelArtifactDigest: string;
  labelerIds: [string, string, ...string[]];
  adjudication:
    | {
        status: "labelers-agreed";
        tiebreakerId: null;
        artifactDigest: null;
      }
    | {
        status: "disagreement-resolved-by-blind-tiebreaker";
        tiebreakerId: string;
        artifactDigest: string;
      };
};

export type DetectorCalibrationReference = {
  value: "present" | "absent";
  evidenceArtifactDigest: string;
  labelArtifactDigest: string;
  labelerIds: [string, string, ...string[]];
  adjudication:
    | {
        status: "labelers-agreed";
        adjudicatorId: null;
        artifactDigest: null;
      }
    | {
        status: "disagreement-adjudicated";
        adjudicatorId: string;
        artifactDigest: string;
      };
};

export type DetectorCalibrationCaseV3 =
  | {
      caseId: string;
      outcome: "complete";
      conditionDigest: string;
      prediction: {
        value: "detected" | "not-detected";
        artifactDigest: string;
      };
      reference: DetectorCalibrationReferenceV3;
    }
  | {
      caseId: string;
      outcome: "censored";
      reason: DetectorCalibrationCensorReason;
      conditionDigest: string;
      attemptArtifactDigest: string;
    };

export type DetectorCalibrationCase =
  | {
      caseId: string;
      outcome: "complete";
      conditionDigest: string;
      prediction: {
        value: "detected" | "not-detected";
        artifactDigest: string;
      };
      reference: DetectorCalibrationReference;
    }
  | {
      caseId: string;
      outcome: "censored";
      reason: DetectorCalibrationCensorReason;
      conditionDigest: string;
      attemptArtifactDigest: string;
    };

export type DetectorCalibrationStudy = {
  schemaVersion: typeof DETECTOR_CALIBRATION_STUDY_SCHEMA_VERSION;
  studyId: string;
  detector: DetectorId;
  release: DetectorCalibrationReleaseIdentity;
  targetPopulation: string;
  plannedCases: number;
  design: {
    sampling: DetectorCalibrationSampling;
    samplingFrame: string;
    samplingFrameDigest: string;
    selectionProtocol: string;
    referenceProtocol: string;
    referenceProtocolDigest: string;
    adjudicationProtocol: string;
    adjudicationProtocolDigest: string;
    independentUnits: boolean;
    predictionBlindedToReference: boolean;
    referenceBlindedToPrediction: boolean;
  };
  cases: DetectorCalibrationCase[];
};

/**
 * Release-grade studies use v2. The published v1 type above remains intact so
 * its immutable schema and the historical pilot remain readable; v1 studies
 * are never eligible for rate publication because they do not bind an exact
 * measurement condition.
 */
export type DetectorCalibrationStudyV2 = {
  schemaVersion: typeof DETECTOR_CALIBRATION_STUDY_V2_SCHEMA_VERSION;
  studyId: string;
  detector: DetectorId;
  release: DetectorCalibrationReleaseIdentity;
  targetPopulation: string;
  plannedCases: number;
  design: {
    sampling: DetectorCalibrationSampling;
    samplingFrame: string;
    samplingFrameDigest: string;
    selectionProtocol: string;
    referenceProtocol: string;
    referenceProtocolDigest: string;
    adjudicationProtocol: string;
    adjudicationProtocolDigest: string;
    measurementCondition: DetectorCalibrationMeasurementCondition;
    independentUnits: boolean;
    predictionBlindedToReference: boolean;
    referenceBlindedToPrediction: boolean;
  };
  cases: DetectorCalibrationCase[];
};

/**
 * Current custody-lane studies use v3. It preserves v2 measurement-condition
 * binding while making the precommitted blind-tiebreaker semantics explicit.
 */
export type DetectorCalibrationStudyV3 = {
  schemaVersion: typeof DETECTOR_CALIBRATION_STUDY_V3_SCHEMA_VERSION;
  studyId: string;
  detector: DetectorId;
  release: DetectorCalibrationReleaseIdentity;
  targetPopulation: string;
  plannedCases: number;
  labelRosterAuthorizationSha256: string;
  rosterSelectionLedgerSha256: string;
  acquisitionAttemptLedgerSha256: string;
  design: DetectorCalibrationStudyV2["design"];
  cases: DetectorCalibrationCaseV3[];
};

type AnalyzableDetectorCalibrationStudy =
  | DetectorCalibrationStudy
  | DetectorCalibrationStudyV2
  | DetectorCalibrationStudyV3;

export type DetectorCalibrationRateId =
  | "sensitivity"
  | "specificity"
  | "precision"
  | "negativePredictiveValue"
  | "accuracy"
  | "falsePositiveRate"
  | "falseNegativeRate";

/** Runtime twin of DetectorCalibrationRateId, exported so consumers share one list. */
export const DETECTOR_CALIBRATION_RATE_IDS: readonly DetectorCalibrationRateId[] = [
  "sensitivity",
  "specificity",
  "precision",
  "negativePredictiveValue",
  "accuracy",
  "falsePositiveRate",
  "falseNegativeRate"
];

export type DetectorCalibrationRate = {
  numerator: number;
  denominator: number;
  estimate: number | null;
  interval95: { lower: number; upper: number; method: "wilson-score" } | null;
};

export type DetectorCalibrationIneligibilityReason =
  | "planned-denominator-mismatch"
  | "censored-cases-present"
  | "current-build-commit-unavailable"
  | "build-commit-mismatch"
  | "expected-runtime-identity-unavailable"
  | "runtime-identity-digest-mismatch"
  | "detector-version-mismatch"
  | "detector-implementation-digest-mismatch"
  | "registry-version-mismatch"
  | "registry-digest-mismatch"
  | "methodology-version-mismatch"
  | "normalization-version-mismatch"
  | "node-version-mismatch"
  | "playwright-version-mismatch"
  | "tracker-catalog-revision-mismatch"
  | "brave-list-revision-mismatch"
  | "measurement-condition-unbound"
  | "no-complete-cases"
  | "missing-positive-reference-denominator"
  | "missing-negative-reference-denominator";

export type DetectorCalibrationDenominators = {
  plannedCases: number;
  recordedCases: number;
  completeCases: number;
  censoredCases: number;
  referencePresent: number;
  referenceAbsent: number;
  predictedDetected: number;
  predictedNotDetected: number;
};

export type DetectorCalibrationAnalysis = {
  analysisVersion: typeof DETECTOR_CALIBRATION_ANALYSIS_VERSION;
  status: "invalid" | "ineligible" | "descriptive-only" | "sample-estimate";
  studyId: string | null;
  detector: DetectorId | null;
  studyDigest: string | null;
  issues: string[];
  ineligibilityReasons: DetectorCalibrationIneligibilityReason[];
  denominators: DetectorCalibrationDenominators;
  confusionMatrix: null | {
    truePositive: number;
    falsePositive: number;
    trueNegative: number;
    falseNegative: number;
  };
  rates: Record<DetectorCalibrationRateId, DetectorCalibrationRate> | null;
  uncertainty: {
    method: "none" | "wilson-score-95";
    reason:
      | "study-ineligible"
      | "descriptive-census-or-convenience-sample"
      | "simple-random-design-gates-not-met"
      | "conditional-on-declared-simple-random-design";
  };
  inference: {
    scope:
      | "none"
      | "recorded-cases-only-under-fixed-measurement-condition"
      | "conditional-on-declared-target-population-and-fixed-measurement-condition";
    targetPopulation: string | null;
    measurementCondition: DetectorCalibrationMeasurementCondition | null;
    conditionalRateClaim: string | null;
    conditionalTargetPopulationRateClaimAllowed: boolean;
    caveats: string[];
  };
};

export type DetectorCalibrationStudySummary = {
  studyId: string;
  detector: DetectorId | null;
  /** Analyzer verdict against the CURRENT release identity, never a stored one. */
  status: DetectorCalibrationAnalysis["status"];
  completeCases: number;
  censoredCases: number;
  ineligibilityReasons: DetectorCalibrationIneligibilityReason[];
};

export type DetectorCalibrationReadiness = {
  status:
    | "external-labeled-corpus-required"
    | "committed-studies-ineligible"
    | "eligible-studies-recorded";
  acceptanceFixtureCases: number;
  acceptanceFixturesExcludedFromCalibration: true;
  calibrationStudies: number;
  /** Studies whose re-analysis against the current release is not ineligible/invalid. */
  eligibleCalibrationStudies: number;
  /** Complete (fully labeled and adjudicated) cases across ELIGIBLE studies only. */
  labeledCalibrationCases: number;
  /** Complete cases across committed studies that failed the eligibility gates. */
  ineligibleStudyLabeledCases: number;
  calibrationRateClaimsAvailable: boolean;
  studies: DetectorCalibrationStudySummary[];
  studySchema: "detector-calibration-study.v3";
  studySchemaPath: "/schemas/detector-calibration-study.v3.schema.json";
  releaseIdentityGate: string;
  labelProvenanceGate: string;
  evidenceGate: string;
};

/**
 * Derive repository truth from re-analysis of the committed studies against
 * the CURRENT release identity. Acceptance fixtures are never relabeled as a
 * calibration corpus; a study committed under an earlier build stays visible
 * here but counts as ineligible until it is re-run under the exact current
 * identity, so any commit to the release identity re-zeroes the eligible
 * columns by construction rather than by someone remembering to.
 */
/**
 * The ONE definition of "this study's analysis supports calibration claims".
 * Readiness derivation and the release gate both consume it; restating the
 * status pair anywhere else is the drift this export exists to prevent.
 */
export function isEligibleCalibrationStatus(status: DetectorCalibrationAnalysis["status"]): boolean {
  return status === "sample-estimate";
}

export function detectorCalibrationReadiness(
  analyses: ReadonlyArray<DetectorCalibrationAnalysis> = []
): DetectorCalibrationReadiness {
  const studies: DetectorCalibrationStudySummary[] = analyses.map((analysis) => ({
    studyId: analysis.studyId ?? "(unidentified study)",
    detector: analysis.detector,
    status: analysis.status,
    completeCases: analysis.denominators.completeCases,
    censoredCases: analysis.denominators.censoredCases,
    ineligibilityReasons: [...analysis.ineligibilityReasons]
  }));
  const eligible = analyses.filter((analysis) => isEligibleCalibrationStatus(analysis.status));
  const ineligible = analyses.filter(
    (analysis) => analysis.status === "ineligible" || analysis.status === "invalid"
  );
  const labeledCalibrationCases = eligible.reduce(
    (total, analysis) => total + analysis.denominators.completeCases,
    0
  );
  return {
    status:
      analyses.length === 0
        ? "external-labeled-corpus-required"
        : eligible.length === 0
          ? "committed-studies-ineligible"
          : "eligible-studies-recorded",
    acceptanceFixtureCases: detectorValidationMetadata.cases,
    acceptanceFixturesExcludedFromCalibration: true,
    calibrationStudies: analyses.length,
    eligibleCalibrationStudies: eligible.length,
    labeledCalibrationCases,
    ineligibleStudyLabeledCases: ineligible.reduce(
      (total, analysis) => total + analysis.denominators.completeCases,
      0
    ),
    calibrationRateClaimsAvailable: eligible.some((analysis) => analysis.rates !== null),
    studies,
    studySchema: "detector-calibration-study.v3",
    studySchemaPath: "/schemas/detector-calibration-study.v3.schema.json",
    releaseIdentityGate:
      "Eligibility requires the exact build commit, detector implementation and registry digests, methodology, normalization, tracker-catalog revision, Brave-list revision, and an independently pinned runtime-identity digest.",
    labelProvenanceGate:
      "Every complete case requires immutable prediction, evidence, and label artifacts plus at least two distinct labeler ids and an independent precommitted blind-tiebreaker identity.",
    evidenceGate:
      "A preselected, release-bound, independently labeled case corpus with a declared sampling frame, immutable artifacts, and complete planned denominator is still required."
  };
}

export type DetectorCalibrationAnalysisContext = {
  /** Exact source build against which the study is being evaluated. Null fails closed. */
  expectedBuildCommit: string | null;
  /**
   * Digest from the independently pinned execution plan/runtime receipt, never
   * copied from the study under analysis. Null or malformed input fails closed.
   */
  expectedRuntimeDigest: string | null;
};

type DetectorCalibrationRuntimeDigestInput = Omit<DetectorCalibrationRuntimeIdentity, "runtimeDigest">;

/** Digest the complete behavior-relevant runtime declaration, excluding only the digest itself. */
export function detectorCalibrationRuntimeDigest(runtime: DetectorCalibrationRuntimeDigestInput): string {
  return sha256Hex(canonicalJson(runtime));
}

/**
 * Domain-separated digest for one detector implementation at one exact Git
 * tree. The commit binds source bytes; the remaining fields bind the semantic
 * identities the detector writes into reports.
 */
export function detectorCalibrationImplementationDigest(input: {
  buildCommit: string;
  detector: DetectorId;
  detectorVersion: string;
  registryVersion: string;
  registryDigest: string;
}): string {
  return sha256Hex(canonicalJson({ domain: "site-behavior-lab-detector-implementation-v1", ...input }));
}

/** Current immutable release fields. It intentionally does not create cases or labels. */
export function currentDetectorCalibrationReleaseIdentity(
  detector: DetectorId,
  buildCommit: string,
  runtime: DetectorCalibrationRuntimeIdentity
): DetectorCalibrationReleaseIdentity {
  const detectorVersion = DETECTOR_VERSIONS[detector];
  return {
    buildCommit,
    detectorVersion,
    detectorImplementationDigest: detectorCalibrationImplementationDigest({
      buildCommit,
      detector,
      detectorVersion,
      registryVersion: DETECTOR_REGISTRY_VERSION,
      registryDigest: DETECTOR_REGISTRY_DIGEST
    }),
    registryVersion: DETECTOR_REGISTRY_VERSION,
    registryDigest: DETECTOR_REGISTRY_DIGEST,
    methodologyVersion: NODE_SCAN_REPORT_V2_R2_METHODOLOGY_VERSION,
    normalizationVersion: NODE_SCAN_REPORT_V2_R2_NORMALIZATION_VERSION,
    trackerCatalog: currentTrackerCatalogIdentity(),
    braveLists: currentBraveListIdentity(),
    runtime
  };
}

/**
 * The release-identity comparison, extracted verbatim from
 * analyzeDetectorCalibrationStudy so the v4 deep-identity validation states
 * the SAME contract by calling it: reason ORDER is part of the observable
 * output, and both fail-closed availability arms (a missing expected build
 * commit also skips the implementation-digest comparison) travel with the
 * block. Refusal-only: reads its inputs, writes nothing.
 */
export function detectorCalibrationReleaseMismatchReasons(
  release: DetectorCalibrationReleaseIdentity,
  detector: DetectorId,
  context?: DetectorCalibrationAnalysisContext
): DetectorCalibrationIneligibilityReason[] {
  const ineligibilityReasons: DetectorCalibrationIneligibilityReason[] = [];
  const expectedBuildCommit = context
    ? normalizedBuildCommit(context.expectedBuildCommit)
    : recordedBuildCommit();
  if (expectedBuildCommit === null) {
    ineligibilityReasons.push("current-build-commit-unavailable");
  } else {
    if (release.buildCommit !== expectedBuildCommit) ineligibilityReasons.push("build-commit-mismatch");
    const expectedImplementationDigest = detectorCalibrationImplementationDigest({
      buildCommit: expectedBuildCommit,
      detector,
      detectorVersion: DETECTOR_VERSIONS[detector],
      registryVersion: DETECTOR_REGISTRY_VERSION,
      registryDigest: DETECTOR_REGISTRY_DIGEST
    });
    if (release.detectorImplementationDigest !== expectedImplementationDigest) {
      ineligibilityReasons.push("detector-implementation-digest-mismatch");
    }
  }
  const expectedRuntimeDigest =
    context && typeof context.expectedRuntimeDigest === "string" && SHA256.test(context.expectedRuntimeDigest)
      ? context.expectedRuntimeDigest
      : null;
  if (expectedRuntimeDigest === null) {
    ineligibilityReasons.push("expected-runtime-identity-unavailable");
  } else if (release.runtime.runtimeDigest !== expectedRuntimeDigest) {
    ineligibilityReasons.push("runtime-identity-digest-mismatch");
  }
  if (release.detectorVersion !== DETECTOR_VERSIONS[detector]) {
    ineligibilityReasons.push("detector-version-mismatch");
  }
  if (release.registryVersion !== DETECTOR_REGISTRY_VERSION) {
    ineligibilityReasons.push("registry-version-mismatch");
  }
  if (release.registryDigest !== DETECTOR_REGISTRY_DIGEST) {
    ineligibilityReasons.push("registry-digest-mismatch");
  }
  if (release.methodologyVersion !== NODE_SCAN_REPORT_V2_R2_METHODOLOGY_VERSION) {
    ineligibilityReasons.push("methodology-version-mismatch");
  }
  if (release.normalizationVersion !== NODE_SCAN_REPORT_V2_R2_NORMALIZATION_VERSION) {
    ineligibilityReasons.push("normalization-version-mismatch");
  }
  if (release.runtime.nodeVersion !== packageManifest.engines.node) {
    ineligibilityReasons.push("node-version-mismatch");
  }
  if (release.runtime.playwrightVersion !== NODE_PLAYWRIGHT_VERSION) {
    ineligibilityReasons.push("playwright-version-mismatch");
  }
  if (canonicalJson(release.trackerCatalog) !== canonicalJson(currentTrackerCatalogIdentity())) {
    ineligibilityReasons.push("tracker-catalog-revision-mismatch");
  }
  // Compared without `fetchedAt`, through the same definition the producer
  // tuple uses. A refetch of byte-identical lists is not a new revision, and
  // treating it as one would retire an otherwise eligible study over a
  // timestamp that says only when the download happened. A moved
  // catalogCommit, manifestDigest, rulesDigest or engine still mismatches.
  if (
    canonicalJson(braveListMeasurementIdentity(release.braveLists as Record<string, unknown>)) !==
    canonicalJson(braveListMeasurementIdentity(currentBraveListIdentity() as unknown as Record<string, unknown>))
  ) {
    ineligibilityReasons.push("brave-list-revision-mismatch");
  }
  return ineligibilityReasons;
}

/**
 * Analyze one externally supplied study. Any missing planned case, censored
 * outcome, stale detector identity, or absent reference class suppresses the
 * entire confusion matrix and all rates rather than estimating from a quiet
 * eligible subset.
 */
export function analyzeDetectorCalibrationStudy(
  input: unknown,
  context?: DetectorCalibrationAnalysisContext
): DetectorCalibrationAnalysis {
  const issues = detectorCalibrationStudyIssues(input);
  if (issues.length > 0) return invalidAnalysis(input, issues);
  const study = input as AnalyzableDetectorCalibrationStudy;
  const complete = study.cases.filter(
    (entry): entry is Extract<DetectorCalibrationCase, { outcome: "complete" }> => entry.outcome === "complete"
  );
  const denominators = buildDenominators(study, complete);
  const ineligibilityReasons: DetectorCalibrationIneligibilityReason[] = [];
  if (study.plannedCases !== study.cases.length) ineligibilityReasons.push("planned-denominator-mismatch");
  if (denominators.censoredCases > 0) ineligibilityReasons.push("censored-cases-present");
  if (study.schemaVersion === 1) {
    ineligibilityReasons.push("measurement-condition-unbound");
  }
  ineligibilityReasons.push(
    ...detectorCalibrationReleaseMismatchReasons(study.release, study.detector, context)
  );
  if (denominators.completeCases === 0) ineligibilityReasons.push("no-complete-cases");
  if (denominators.referencePresent === 0) ineligibilityReasons.push("missing-positive-reference-denominator");
  if (denominators.referenceAbsent === 0) ineligibilityReasons.push("missing-negative-reference-denominator");

  const studyDigest = sha256Hex(canonicalJson(study));
  if (ineligibilityReasons.length > 0) {
    return {
      ...analysisShell(study, denominators),
      status: "ineligible",
      studyDigest,
      ineligibilityReasons,
      uncertainty: { method: "none", reason: "study-ineligible" }
    };
  }

  const confusionMatrix = buildConfusionMatrix(complete);
  const sampleDesignEligible =
    study.design.sampling === "simple-random" &&
    study.design.independentUnits &&
    study.design.predictionBlindedToReference &&
    study.design.referenceBlindedToPrediction;
  const rates = buildRates(confusionMatrix, sampleDesignEligible);
  const status = sampleDesignEligible ? "sample-estimate" : "descriptive-only";
  const designReason =
    study.design.sampling === "simple-random"
      ? "simple-random-design-gates-not-met"
      : "descriptive-census-or-convenience-sample";

  return {
    analysisVersion: DETECTOR_CALIBRATION_ANALYSIS_VERSION,
    status,
    studyId: study.studyId,
    detector: study.detector,
    studyDigest,
    issues: [],
    ineligibilityReasons: [],
    denominators,
    confusionMatrix,
    rates,
    uncertainty: sampleDesignEligible
      ? { method: "wilson-score-95", reason: "conditional-on-declared-simple-random-design" }
      : { method: "none", reason: designReason },
    inference: sampleDesignEligible
      ? {
          scope:
            "conditional-on-declared-target-population-and-fixed-measurement-condition",
          targetPopulation: study.targetPopulation,
          measurementCondition:
            study.schemaVersion !== 1
              ? study.design.measurementCondition
              : null,
          conditionalRateClaim:
            study.schemaVersion !== 1
              ? conditionalCalibrationRateClaim(
                  study.targetPopulation,
                  study.design.measurementCondition
                )
              : null,
          conditionalTargetPopulationRateClaimAllowed: true,
          caveats: [
            "The interval is conditional on the study's declared equal-probability simple-random sampling, independence, and blinding metadata.",
            "It applies only to the named target population, fixed measurement condition, exact source build, detector implementation, registry, toolchain snapshots, runtime identity, and reference-label protocol."
          ]
        }
      : {
          scope:
            "recorded-cases-only-under-fixed-measurement-condition",
          targetPopulation: null,
          measurementCondition:
            study.schemaVersion !== 1
              ? study.design.measurementCondition
              : null,
          conditionalRateClaim: null,
          conditionalTargetPopulationRateClaimAllowed: false,
          caveats: [
            "Point rates describe only the complete recorded cases under the fixed measurement condition and do not estimate detector accuracy in a wider population."
          ]
        }
  };
}

function conditionalCalibrationRateClaim(
  targetPopulation: string,
  condition: DetectorCalibrationMeasurementCondition
): string {
  return (
    `Rates estimate detector performance only for the declared target population ` +
    `(${targetPopulation}) under the fixed measurement condition. ${condition.interpretation}`
  );
}

/** Runtime structural validation for JSON-loaded study sidecars. */
export function detectorCalibrationStudyIssues(input: unknown): string[] {
  const issues: string[] = [];
  if (!isRecord(input)) return ["study must be an object"];
  const custodyKeys =
    input.schemaVersion === DETECTOR_CALIBRATION_STUDY_V3_SCHEMA_VERSION
      ? [
          "labelRosterAuthorizationSha256",
          "rosterSelectionLedgerSha256",
          "acquisitionAttemptLedgerSha256"
        ]
      : [];
  exactKeys(
    input,
    [
      "schemaVersion",
      "studyId",
      "detector",
      "release",
      "targetPopulation",
      "plannedCases",
      ...custodyKeys,
      "design",
      "cases"
    ],
    "study",
    issues
  );
  if (
    input.schemaVersion !== DETECTOR_CALIBRATION_STUDY_SCHEMA_VERSION &&
    input.schemaVersion !== DETECTOR_CALIBRATION_STUDY_V2_SCHEMA_VERSION &&
    input.schemaVersion !== DETECTOR_CALIBRATION_STUDY_V3_SCHEMA_VERSION
  ) {
    issues.push(
      `schemaVersion must be ${DETECTOR_CALIBRATION_STUDY_SCHEMA_VERSION}, ${DETECTOR_CALIBRATION_STUDY_V2_SCHEMA_VERSION}, or ${DETECTOR_CALIBRATION_STUDY_V3_SCHEMA_VERSION}`
    );
  }
  if (!boundedToken(input.studyId)) issues.push("studyId must be a bounded opaque token");
  const detectorValid =
    typeof input.detector === "string" && DETECTOR_IDS.includes(input.detector as DetectorId);
  if (!detectorValid) {
    issues.push("detector must name a current detector id");
  }
  if (!boundedText(input.targetPopulation, 1000)) {
    issues.push("targetPopulation must be a bounded non-empty string");
  }
  validateRelease(input.release, detectorValid ? (input.detector as DetectorId) : null, issues);
  if (
    !Number.isInteger(input.plannedCases) ||
    (input.plannedCases as number) < 1 ||
    (input.plannedCases as number) > DETECTOR_CALIBRATION_MAX_CASES
  ) {
    issues.push(`plannedCases must be an integer from 1 through ${DETECTOR_CALIBRATION_MAX_CASES}`);
  }
  if (input.schemaVersion === DETECTOR_CALIBRATION_STUDY_V3_SCHEMA_VERSION) {
    validateSha256(
      input.labelRosterAuthorizationSha256,
      "labelRosterAuthorizationSha256",
      issues
    );
    validateSha256(
      input.rosterSelectionLedgerSha256,
      "rosterSelectionLedgerSha256",
      issues
    );
    validateSha256(
      input.acquisitionAttemptLedgerSha256,
      "acquisitionAttemptLedgerSha256",
      issues
    );
  }

  validateDesign(
    input.design,
    detectorValid ? (input.detector as DetectorId) : null,
    input.schemaVersion,
    issues
  );
  if (!Array.isArray(input.cases)) {
    issues.push("cases must be an array");
    return issues;
  }
  if (input.cases.length > DETECTOR_CALIBRATION_MAX_CASES) {
    issues.push(`cases exceeds the ${DETECTOR_CALIBRATION_MAX_CASES} case analysis limit`);
    return issues;
  }
  const ids = new Set<string>();
  for (const [index, entry] of input.cases.entries()) {
    const label = `case ${index + 1}`;
    if (!isRecord(entry)) {
      issues.push(`${label} must be an object`);
      continue;
    }
    if (!boundedToken(entry.caseId)) issues.push(`${label} caseId must be a bounded opaque token`);
    if (typeof entry.caseId === "string") {
      if (ids.has(entry.caseId)) issues.push(`${label} repeats caseId ${entry.caseId}`);
      ids.add(entry.caseId);
    }
    if (entry.outcome === "complete") {
      exactKeys(entry, ["caseId", "outcome", "conditionDigest", "reference", "prediction"], label, issues);
      validateSha256(entry.conditionDigest, `${label} conditionDigest`, issues);
      validatePrediction(entry.prediction, label, issues);
      validateReference(
        entry.reference,
        label,
        input.schemaVersion,
        issues
      );
    } else if (entry.outcome === "censored") {
      exactKeys(entry, ["caseId", "outcome", "reason", "conditionDigest", "attemptArtifactDigest"], label, issues);
      if (!CENSOR_REASONS.has(entry.reason as DetectorCalibrationCensorReason)) {
        issues.push(`${label} has an invalid censor reason`);
      }
      validateSha256(entry.conditionDigest, `${label} conditionDigest`, issues);
      validateSha256(entry.attemptArtifactDigest, `${label} attemptArtifactDigest`, issues);
    } else {
      issues.push(`${label} outcome must be complete or censored`);
    }
  }
  return issues;
}

const CENSOR_REASONS = new Set<DetectorCalibrationCensorReason>([
  "capture-failed",
  "reference-label-uncertain",
  "artifact-unreadable",
  "eligibility-criteria-not-met"
]);

function validateDesign(
  value: unknown,
  detector: DetectorId | null,
  schemaVersion: unknown,
  issues: string[]
): void {
  if (!isRecord(value)) {
    issues.push("design must be an object");
    return;
  }
  const keys = [
    "sampling",
    "samplingFrame",
    "samplingFrameDigest",
    "selectionProtocol",
    "referenceProtocol",
    "referenceProtocolDigest",
    "adjudicationProtocol",
    "adjudicationProtocolDigest",
    ...(schemaVersion === DETECTOR_CALIBRATION_STUDY_V2_SCHEMA_VERSION ||
    schemaVersion === DETECTOR_CALIBRATION_STUDY_V3_SCHEMA_VERSION
      ? ["measurementCondition"]
      : []),
    "independentUnits",
    "predictionBlindedToReference",
    "referenceBlindedToPrediction"
  ];
  exactKeys(value, keys, "design", issues);
  if (value.sampling !== "simple-random" && value.sampling !== "census" && value.sampling !== "convenience") {
    issues.push("design.sampling must be simple-random, census, or convenience");
  }
  if (!boundedText(value.samplingFrame, 1000)) issues.push("design.samplingFrame must be a bounded non-empty string");
  validateSha256(value.samplingFrameDigest, "design.samplingFrameDigest", issues);
  if (!boundedText(value.selectionProtocol, 1000)) {
    issues.push("design.selectionProtocol must be a bounded non-empty string");
  }
  if (!boundedText(value.referenceProtocol, 1000)) {
    issues.push("design.referenceProtocol must be a bounded non-empty string");
  }
  validateSha256(value.referenceProtocolDigest, "design.referenceProtocolDigest", issues);
  if (!boundedText(value.adjudicationProtocol, 1000)) {
    issues.push("design.adjudicationProtocol must be a bounded non-empty string");
  }
  validateSha256(value.adjudicationProtocolDigest, "design.adjudicationProtocolDigest", issues);
  if (
    schemaVersion === DETECTOR_CALIBRATION_STUDY_V2_SCHEMA_VERSION ||
    schemaVersion === DETECTOR_CALIBRATION_STUDY_V3_SCHEMA_VERSION
  ) {
    validateMeasurementCondition(value.measurementCondition, detector, issues);
  }
  for (const field of [
    "independentUnits",
    "predictionBlindedToReference",
    "referenceBlindedToPrediction"
  ] as const) {
    if (typeof value[field] !== "boolean") issues.push(`design.${field} must be boolean`);
  }
}

function validateMeasurementCondition(
  value: unknown,
  detector: DetectorId | null,
  issues: string[]
): void {
  if (!isRecord(value)) {
    issues.push("design.measurementCondition must be an object");
    return;
  }
  exactKeys(
    value,
    ["device", "gpcEnabled", "consentMode", "interpretation"],
    "design.measurementCondition",
    issues
  );
  if (detector === null) return;
  if (
    canonicalJson(value) !==
    canonicalJson(detectorCalibrationMeasurementCondition(detector))
  ) {
    issues.push(
      "design.measurementCondition must equal the canonical detector-specific measurement arm"
    );
  }
}

function validateRelease(value: unknown, detector: DetectorId | null, issues: string[]): void {
  if (!isRecord(value)) {
    issues.push("release must be an object");
    return;
  }
  exactKeys(
    value,
    [
      "buildCommit",
      "detectorVersion",
      "detectorImplementationDigest",
      "registryVersion",
      "registryDigest",
      "methodologyVersion",
      "normalizationVersion",
      "trackerCatalog",
      "braveLists",
      "runtime"
    ],
    "release",
    issues
  );
  if (typeof value.buildCommit !== "string" || !FULL_GIT_SHA.test(value.buildCommit)) {
    issues.push("release.buildCommit must be a full lowercase Git SHA");
  }
  for (const field of ["detectorVersion", "registryVersion", "methodologyVersion", "normalizationVersion"] as const) {
    if (!boundedText(value[field], field === "normalizationVersion" ? 1000 : 512)) {
      issues.push(`release.${field} must be a bounded non-empty string`);
    }
  }
  validateSha256(value.detectorImplementationDigest, "release.detectorImplementationDigest", issues);
  validateSha256(value.registryDigest, "release.registryDigest", issues);
  validateTrackerCatalog(value.trackerCatalog, issues);
  validateBraveLists(value.braveLists, issues);
  validateRuntime(value.runtime, issues);

  if (
    detector !== null &&
    typeof value.buildCommit === "string" &&
    FULL_GIT_SHA.test(value.buildCommit) &&
    typeof value.detectorVersion === "string" &&
    typeof value.registryVersion === "string" &&
    typeof value.registryDigest === "string" &&
    SHA256.test(value.registryDigest) &&
    typeof value.detectorImplementationDigest === "string" &&
    SHA256.test(value.detectorImplementationDigest)
  ) {
    const declaredDigest = detectorCalibrationImplementationDigest({
      buildCommit: value.buildCommit,
      detector,
      detectorVersion: value.detectorVersion,
      registryVersion: value.registryVersion,
      registryDigest: value.registryDigest
    });
    if (value.detectorImplementationDigest !== declaredDigest) {
      issues.push(
        "release.detectorImplementationDigest does not match the declared build, detector, and registry identity"
      );
    }
  }
}

function validateTrackerCatalog(value: unknown, issues: string[]): void {
  if (!isRecord(value)) {
    issues.push("release.trackerCatalog must be an object");
    return;
  }
  exactKeys(value, ["version", "digest", "provenanceVersion", "provenanceDigest"], "release.trackerCatalog", issues);
  for (const field of ["version", "provenanceVersion"] as const) {
    if (!boundedText(value[field], 256)) issues.push(`release.trackerCatalog.${field} must be bounded text`);
  }
  validateSha256(value.digest, "release.trackerCatalog.digest", issues);
  validateSha256(value.provenanceDigest, "release.trackerCatalog.provenanceDigest", issues);
}

function validateBraveLists(value: unknown, issues: string[]): void {
  if (!isRecord(value)) {
    issues.push("release.braveLists must be an object");
    return;
  }
  exactKeys(
    value,
    [
      "source",
      "catalogCommit",
      "catalogDigest",
      "lists",
      "fetchedAt",
      "manifestDigest",
      "rulesDigest",
      "engineVersion"
    ],
    "release.braveLists",
    issues
  );
  for (const field of ["source", "engineVersion"] as const) {
    if (!boundedText(value[field], 256)) issues.push(`release.braveLists.${field} must be bounded text`);
  }
  if (typeof value.catalogCommit !== "string" || !FULL_GIT_SHA.test(value.catalogCommit)) {
    issues.push("release.braveLists.catalogCommit must be a full lowercase Git SHA");
  }
  for (const field of ["catalogDigest", "manifestDigest", "rulesDigest"] as const) {
    validateSha256(value[field], `release.braveLists.${field}`, issues);
  }
  if (!Number.isSafeInteger(value.lists) || (value.lists as number) < 1 || (value.lists as number) > 10_000) {
    issues.push("release.braveLists.lists must be a positive safe integer");
  }
  if (
    typeof value.fetchedAt !== "string" ||
    !Number.isFinite(Date.parse(value.fetchedAt)) ||
    new Date(value.fetchedAt).toISOString() !== value.fetchedAt
  ) {
    issues.push("release.braveLists.fetchedAt must be a canonical ISO timestamp");
  }
}

function validateRuntime(value: unknown, issues: string[]): void {
  if (!isRecord(value)) {
    issues.push("release.runtime must be an object");
    return;
  }
  exactKeys(
    value,
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
    "release.runtime",
    issues
  );
  if (value.observer !== "node-playwright") issues.push("release.runtime.observer must be node-playwright");
  if (value.automation !== "playwright-chromium") {
    issues.push("release.runtime.automation must be playwright-chromium");
  }
  if (value.browserName !== "chromium") issues.push("release.runtime.browserName must be chromium");
  for (const field of [
    "nodeVersion",
    "playwrightVersion",
    "browserVersion",
    "operatingSystem",
    "architecture"
  ] as const) {
    if (!boundedText(value[field], 256)) issues.push(`release.runtime.${field} must be bounded text`);
  }
  validateSha256(value.runtimeDigest, "release.runtime.runtimeDigest", issues);
  if (
    value.observer === "node-playwright" &&
    value.automation === "playwright-chromium" &&
    value.browserName === "chromium" &&
    typeof value.nodeVersion === "string" &&
    typeof value.playwrightVersion === "string" &&
    typeof value.browserVersion === "string" &&
    typeof value.operatingSystem === "string" &&
    typeof value.architecture === "string" &&
    typeof value.runtimeDigest === "string" &&
    SHA256.test(value.runtimeDigest)
  ) {
    const declaredRuntime = {
      observer: value.observer,
      automation: value.automation,
      nodeVersion: value.nodeVersion,
      playwrightVersion: value.playwrightVersion,
      browserName: value.browserName,
      browserVersion: value.browserVersion,
      operatingSystem: value.operatingSystem,
      architecture: value.architecture
    } satisfies DetectorCalibrationRuntimeDigestInput;
    if (value.runtimeDigest !== detectorCalibrationRuntimeDigest(declaredRuntime)) {
      issues.push("release.runtime.runtimeDigest does not match the declared runtime identity");
    }
  }
}

function validatePrediction(value: unknown, label: string, issues: string[]): void {
  if (!isRecord(value)) {
    issues.push(`${label} prediction must be an object`);
    return;
  }
  exactKeys(value, ["value", "artifactDigest"], `${label} prediction`, issues);
  if (value.value !== "detected" && value.value !== "not-detected") {
    issues.push(`${label} has an invalid prediction`);
  }
  validateSha256(value.artifactDigest, `${label} prediction.artifactDigest`, issues);
}

function validateReference(
  value: unknown,
  label: string,
  schemaVersion: unknown,
  issues: string[]
): void {
  if (!isRecord(value)) {
    issues.push(`${label} reference must be an object`);
    return;
  }
  exactKeys(
    value,
    ["value", "evidenceArtifactDigest", "labelArtifactDigest", "labelerIds", "adjudication"],
    `${label} reference`,
    issues
  );
  if (value.value !== "present" && value.value !== "absent") {
    issues.push(`${label} has an invalid reference label`);
  }
  validateSha256(value.evidenceArtifactDigest, `${label} reference.evidenceArtifactDigest`, issues);
  validateSha256(value.labelArtifactDigest, `${label} reference.labelArtifactDigest`, issues);
  const labelers = value.labelerIds;
  if (
    !Array.isArray(labelers) ||
    labelers.length < 2 ||
    labelers.length > MAX_LABELERS ||
    labelers.some((entry) => !boundedToken(entry))
  ) {
    issues.push(`${label} reference.labelerIds must contain 2 through ${MAX_LABELERS} opaque labeler ids`);
  } else if (new Set(labelers).size !== labelers.length) {
    issues.push(`${label} reference.labelerIds must be unique`);
  }
  validateAdjudication(
    value.adjudication,
    Array.isArray(labelers) ? labelers : [],
    label,
    schemaVersion,
    issues
  );
}

function validateAdjudication(
  value: unknown,
  labelerIds: unknown[],
  label: string,
  schemaVersion: unknown,
  issues: string[]
): void {
  if (!isRecord(value)) {
    issues.push(`${label} reference.adjudication must be an object`);
    return;
  }
  const isV3 =
    schemaVersion === DETECTOR_CALIBRATION_STUDY_V3_SCHEMA_VERSION;
  const identityField = isV3 ? "tiebreakerId" : "adjudicatorId";
  exactKeys(
    value,
    ["status", identityField, "artifactDigest"],
    `${label} reference.adjudication`,
    issues
  );
  if (value.status === "labelers-agreed") {
    if (value[identityField] !== null || value.artifactDigest !== null) {
      issues.push(
        `${label} agreed reference must use null ${isV3 ? "tiebreaker" : "adjudicator"} and artifact fields`
      );
    }
    return;
  }
  const expectedStatus = isV3
    ? "disagreement-resolved-by-blind-tiebreaker"
    : "disagreement-adjudicated";
  if (value.status !== expectedStatus) {
    issues.push(
      `${label} reference.adjudication status must be labelers-agreed or ${expectedStatus}`
    );
    return;
  }
  if (!boundedToken(value[identityField])) {
    issues.push(`${label} ${identityField} must be a bounded opaque token`);
  } else if (labelerIds.includes(value[identityField])) {
    issues.push(
      `${label} ${identityField} must differ from the original labeler ids`
    );
  }
  validateSha256(value.artifactDigest, `${label} reference.adjudication.artifactDigest`, issues);
}

function currentTrackerCatalogIdentity(): DetectorCalibrationReleaseIdentity["trackerCatalog"] {
  return {
    version: trackerCatalogMetadata.version,
    digest: trackerCatalogMetadata.digest,
    provenanceVersion: trackerCatalogMetadata.provenanceVersion,
    provenanceDigest: trackerCatalogMetadata.provenanceDigest
  };
}

function currentBraveListIdentity(): DetectorCalibrationReleaseIdentity["braveLists"] {
  return {
    source: "Brave default ad-block lists",
    catalogCommit: braveListManifest.catalogCommit,
    catalogDigest: braveListManifest.catalogSha256,
    lists: braveListManifest.sourceCount,
    fetchedAt: braveListManifest.fetchedAt,
    manifestDigest: braveListManifest.manifestDigest,
    rulesDigest: braveListManifest.rulesDigest,
    engineVersion: NODE_ADBLOCK_ENGINE_VERSION
  };
}

function validateSha256(value: unknown, label: string, issues: string[]): void {
  if (typeof value !== "string" || !SHA256.test(value)) {
    issues.push(`${label} must be a lowercase SHA-256 digest`);
  }
}

function normalizedBuildCommit(value: string | null): string | null {
  const canonical = value?.trim().toLowerCase() ?? "";
  return FULL_GIT_SHA.test(canonical) ? canonical : null;
}

function buildDenominators(
  study: AnalyzableDetectorCalibrationStudy,
  complete: Array<Extract<DetectorCalibrationCase, { outcome: "complete" }>>
): DetectorCalibrationDenominators {
  return {
    plannedCases: study.plannedCases,
    recordedCases: study.cases.length,
    completeCases: complete.length,
    censoredCases: study.cases.length - complete.length,
    referencePresent: complete.filter((entry) => entry.reference.value === "present").length,
    referenceAbsent: complete.filter((entry) => entry.reference.value === "absent").length,
    predictedDetected: complete.filter((entry) => entry.prediction.value === "detected").length,
    predictedNotDetected: complete.filter((entry) => entry.prediction.value === "not-detected").length
  };
}

function buildConfusionMatrix(complete: Array<Extract<DetectorCalibrationCase, { outcome: "complete" }>>) {
  return {
    truePositive: complete.filter(
      (entry) => entry.reference.value === "present" && entry.prediction.value === "detected"
    ).length,
    falsePositive: complete.filter(
      (entry) => entry.reference.value === "absent" && entry.prediction.value === "detected"
    ).length,
    trueNegative: complete.filter(
      (entry) => entry.reference.value === "absent" && entry.prediction.value === "not-detected"
    ).length,
    falseNegative: complete.filter(
      (entry) => entry.reference.value === "present" && entry.prediction.value === "not-detected"
    ).length
  };
}

/**
 * Exported additively for the censoring analyzer's binding test
 * (lib/calibration-censoring-analysis.test.ts): the seven rate definitions
 * must have one authority, and the test proves the envelope analyzer's cell
 * arithmetic equals this function's, so the two cannot drift apart silently.
 * No analysis output changes.
 */
export function buildRates(
  matrix: NonNullable<DetectorCalibrationAnalysis["confusionMatrix"]>,
  withIntervals: boolean
): Record<DetectorCalibrationRateId, DetectorCalibrationRate> {
  const { truePositive: tp, falsePositive: fp, trueNegative: tn, falseNegative: fn } = matrix;
  return {
    sensitivity: rate(tp, tp + fn, withIntervals),
    specificity: rate(tn, tn + fp, withIntervals),
    precision: rate(tp, tp + fp, withIntervals),
    negativePredictiveValue: rate(tn, tn + fn, withIntervals),
    accuracy: rate(tp + tn, tp + fp + tn + fn, withIntervals),
    falsePositiveRate: rate(fp, fp + tn, withIntervals),
    falseNegativeRate: rate(fn, fn + tp, withIntervals)
  };
}

function rate(numerator: number, denominator: number, withInterval: boolean): DetectorCalibrationRate {
  if (denominator === 0) return { numerator, denominator, estimate: null, interval95: null };
  return {
    numerator,
    denominator,
    estimate: numerator / denominator,
    interval95: withInterval ? wilson95(numerator, denominator) : null
  };
}

/**
 * Exported for the censoring analyzer (lib/calibration-censoring-analysis.ts):
 * one interval definition, never two. Additive export only; nothing about the
 * computation or any analysis output changes.
 */
export function wilson95(successes: number, denominator: number) {
  const z = 1.959963984540054;
  const zSquared = z * z;
  const proportion = successes / denominator;
  const scale = 1 + zSquared / denominator;
  const center = (proportion + zSquared / (2 * denominator)) / scale;
  const margin =
    (z * Math.sqrt((proportion * (1 - proportion)) / denominator + zSquared / (4 * denominator ** 2))) / scale;
  return {
    lower: Math.max(0, center - margin),
    upper: Math.min(1, center + margin),
    method: "wilson-score" as const
  };
}

function analysisShell(
  study: AnalyzableDetectorCalibrationStudy,
  denominators: DetectorCalibrationDenominators
): DetectorCalibrationAnalysis {
  return {
    analysisVersion: DETECTOR_CALIBRATION_ANALYSIS_VERSION,
    status: "ineligible",
    studyId: study.studyId,
    detector: study.detector,
    studyDigest: null,
    issues: [],
    ineligibilityReasons: [],
    denominators,
    confusionMatrix: null,
    rates: null,
    uncertainty: { method: "none", reason: "study-ineligible" },
    inference: {
      scope: "none",
      targetPopulation: null,
      measurementCondition:
        study.schemaVersion !== 1
          ? study.design.measurementCondition
          : null,
      conditionalRateClaim: null,
      conditionalTargetPopulationRateClaimAllowed: false,
      caveats: ["No calibration claim is available from an ineligible study denominator."]
    }
  };
}

function invalidAnalysis(input: unknown, issues: string[]): DetectorCalibrationAnalysis {
  const studyId = isRecord(input) && typeof input.studyId === "string" ? input.studyId : null;
  const detector =
    isRecord(input) && typeof input.detector === "string" && DETECTOR_IDS.includes(input.detector as DetectorId)
      ? (input.detector as DetectorId)
      : null;
  return {
    analysisVersion: DETECTOR_CALIBRATION_ANALYSIS_VERSION,
    status: "invalid",
    studyId,
    detector,
    studyDigest: null,
    issues,
    ineligibilityReasons: [],
    denominators: emptyDenominators(),
    confusionMatrix: null,
    rates: null,
    uncertainty: { method: "none", reason: "study-ineligible" },
    inference: {
      scope: "none",
      targetPopulation: null,
      measurementCondition: null,
      conditionalRateClaim: null,
      conditionalTargetPopulationRateClaimAllowed: false,
      caveats: ["Malformed study metadata cannot support calibration analysis."]
    }
  };
}

function emptyDenominators(): DetectorCalibrationDenominators {
  return {
    plannedCases: 0,
    recordedCases: 0,
    completeCases: 0,
    censoredCases: 0,
    referencePresent: 0,
    referenceAbsent: 0,
    predictedDetected: 0,
    predictedNotDetected: 0
  };
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string, issues: string[]): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    issues.push(`${label} has unexpected or missing fields`);
  }
}

function boundedToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

function boundedText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
}
