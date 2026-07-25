/**
 * Strict, analysis-only contract for external detector-calibration studies.
 *
 * The source-pinned acceptance fixtures prove selected implementation cases;
 * they are intentionally not fed into this model. Calibration rates require a
 * separately labeled case corpus with an accountable planned denominator.
 */
import { detectorValidationMetadata } from "./detector-validation";
import { isRecord } from "./guards";
import { DETECTOR_REGISTRY_VERSION, DETECTOR_VERSIONS } from "./measurement-kernel";
import { DETECTOR_IDS, type DetectorId } from "./scan-report-v2";
import { canonicalJson } from "./scan-report-v2-fingerprints";
import { sha256Hex } from "./sha256";

export const DETECTOR_CALIBRATION_ANALYSIS_VERSION = "detector-calibration-analysis-v1" as const;
const DETECTOR_CALIBRATION_MAX_CASES = 100_000;

export type DetectorCalibrationSampling = "simple-random" | "census" | "convenience";
export type DetectorCalibrationCensorReason =
  | "capture-failed"
  | "reference-label-uncertain"
  | "artifact-unreadable"
  | "eligibility-criteria-not-met";

export type DetectorCalibrationCase =
  | {
      caseId: string;
      outcome: "complete";
      reference: "present" | "absent";
      prediction: "detected" | "not-detected";
    }
  | {
      caseId: string;
      outcome: "censored";
      reason: DetectorCalibrationCensorReason;
    };

export type DetectorCalibrationStudy = {
  studyId: string;
  detector: DetectorId;
  detectorVersion: string;
  registryVersion: string;
  targetPopulation: string;
  plannedCases: number;
  design: {
    sampling: DetectorCalibrationSampling;
    samplingFrame: string;
    samplingFrameDigest: string;
    selectionProtocol: string;
    referenceProtocol: string;
    independentUnits: boolean;
    predictionBlindedToReference: boolean;
    referenceBlindedToPrediction: boolean;
  };
  cases: DetectorCalibrationCase[];
};

export type DetectorCalibrationRateId =
  | "sensitivity"
  | "specificity"
  | "precision"
  | "negativePredictiveValue"
  | "accuracy"
  | "falsePositiveRate"
  | "falseNegativeRate";

export type DetectorCalibrationRate = {
  numerator: number;
  denominator: number;
  estimate: number | null;
  interval95: { lower: number; upper: number; method: "wilson-score" } | null;
};

export type DetectorCalibrationIneligibilityReason =
  | "planned-denominator-mismatch"
  | "censored-cases-present"
  | "detector-version-mismatch"
  | "registry-version-mismatch"
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
    scope: "none" | "recorded-cases-only" | "conditional-on-declared-target-population";
    targetPopulation: string | null;
    conditionalTargetPopulationRateClaimAllowed: boolean;
    caveats: string[];
  };
};

export type DetectorCalibrationReadiness = {
  status: "external-labeled-corpus-required";
  acceptanceFixtureCases: number;
  calibrationStudies: 0;
  labeledCalibrationCases: 0;
  calibrationRateClaimsAvailable: false;
  evidenceGate: string;
};

/**
 * Current repository truth. Acceptance fixtures are not silently relabeled as
 * a calibration corpus, so this remains red until an external labeled study
 * is committed and reviewed through the contract above.
 */
export function detectorCalibrationReadiness(): DetectorCalibrationReadiness {
  return {
    status: "external-labeled-corpus-required",
    acceptanceFixtureCases: detectorValidationMetadata.cases,
    calibrationStudies: 0,
    labeledCalibrationCases: 0,
    calibrationRateClaimsAvailable: false,
    evidenceGate:
      "A preselected, version-pinned, independently labeled case corpus with a declared sampling frame and complete planned denominator is still required."
  };
}

/**
 * Analyze one externally supplied study. Any missing planned case, censored
 * outcome, stale detector identity, or absent reference class suppresses the
 * entire confusion matrix and all rates rather than estimating from a quiet
 * eligible subset.
 */
export function analyzeDetectorCalibrationStudy(input: unknown): DetectorCalibrationAnalysis {
  const issues = detectorCalibrationStudyIssues(input);
  if (issues.length > 0) return invalidAnalysis(input, issues);
  const study = input as DetectorCalibrationStudy;
  const complete = study.cases.filter(
    (entry): entry is Extract<DetectorCalibrationCase, { outcome: "complete" }> => entry.outcome === "complete"
  );
  const denominators = buildDenominators(study, complete);
  const ineligibilityReasons: DetectorCalibrationIneligibilityReason[] = [];
  if (study.plannedCases !== study.cases.length) ineligibilityReasons.push("planned-denominator-mismatch");
  if (denominators.censoredCases > 0) ineligibilityReasons.push("censored-cases-present");
  if (study.detectorVersion !== DETECTOR_VERSIONS[study.detector]) {
    ineligibilityReasons.push("detector-version-mismatch");
  }
  if (study.registryVersion !== DETECTOR_REGISTRY_VERSION) ineligibilityReasons.push("registry-version-mismatch");
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
          scope: "conditional-on-declared-target-population",
          targetPopulation: study.targetPopulation,
          conditionalTargetPopulationRateClaimAllowed: true,
          caveats: [
            "The interval is conditional on the study's declared equal-probability simple-random sampling, independence, and blinding metadata.",
            "It applies only to the named target population, detector version, registry version, and reference-label protocol."
          ]
        }
      : {
          scope: "recorded-cases-only",
          targetPopulation: null,
          conditionalTargetPopulationRateClaimAllowed: false,
          caveats: [
            "Point rates describe only the complete recorded cases and do not estimate detector accuracy in a wider population."
          ]
        }
  };
}

/** Runtime structural validation for JSON-loaded study sidecars. */
export function detectorCalibrationStudyIssues(input: unknown): string[] {
  const issues: string[] = [];
  if (!isRecord(input)) return ["study must be an object"];
  exactKeys(
    input,
    [
      "studyId",
      "detector",
      "detectorVersion",
      "registryVersion",
      "targetPopulation",
      "plannedCases",
      "design",
      "cases"
    ],
    "study",
    issues
  );
  if (!boundedToken(input.studyId)) issues.push("studyId must be a bounded opaque token");
  if (typeof input.detector !== "string" || !DETECTOR_IDS.includes(input.detector as DetectorId)) {
    issues.push("detector must name a current detector id");
  }
  for (const field of ["detectorVersion", "registryVersion", "targetPopulation"] as const) {
    if (!boundedText(input[field], field === "targetPopulation" ? 1000 : 128)) {
      issues.push(`${field} must be a bounded non-empty string`);
    }
  }
  if (
    !Number.isInteger(input.plannedCases) ||
    (input.plannedCases as number) < 1 ||
    (input.plannedCases as number) > DETECTOR_CALIBRATION_MAX_CASES
  ) {
    issues.push(`plannedCases must be an integer from 1 through ${DETECTOR_CALIBRATION_MAX_CASES}`);
  }

  validateDesign(input.design, issues);
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
      exactKeys(entry, ["caseId", "outcome", "reference", "prediction"], label, issues);
      if (entry.reference !== "present" && entry.reference !== "absent") {
        issues.push(`${label} has an invalid reference label`);
      }
      if (entry.prediction !== "detected" && entry.prediction !== "not-detected") {
        issues.push(`${label} has an invalid prediction`);
      }
    } else if (entry.outcome === "censored") {
      exactKeys(entry, ["caseId", "outcome", "reason"], label, issues);
      if (!CENSOR_REASONS.has(entry.reason as DetectorCalibrationCensorReason)) {
        issues.push(`${label} has an invalid censor reason`);
      }
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

function validateDesign(value: unknown, issues: string[]): void {
  if (!isRecord(value)) {
    issues.push("design must be an object");
    return;
  }
  exactKeys(
    value,
    [
      "sampling",
      "samplingFrame",
      "samplingFrameDigest",
      "selectionProtocol",
      "referenceProtocol",
      "independentUnits",
      "predictionBlindedToReference",
      "referenceBlindedToPrediction"
    ],
    "design",
    issues
  );
  if (value.sampling !== "simple-random" && value.sampling !== "census" && value.sampling !== "convenience") {
    issues.push("design.sampling must be simple-random, census, or convenience");
  }
  if (!boundedText(value.samplingFrame, 1000)) issues.push("design.samplingFrame must be a bounded non-empty string");
  if (typeof value.samplingFrameDigest !== "string" || !/^[0-9a-f]{64}$/.test(value.samplingFrameDigest)) {
    issues.push("design.samplingFrameDigest must be a lowercase SHA-256 digest");
  }
  if (!boundedText(value.selectionProtocol, 1000)) {
    issues.push("design.selectionProtocol must be a bounded non-empty string");
  }
  if (!boundedText(value.referenceProtocol, 1000)) {
    issues.push("design.referenceProtocol must be a bounded non-empty string");
  }
  for (const field of [
    "independentUnits",
    "predictionBlindedToReference",
    "referenceBlindedToPrediction"
  ] as const) {
    if (typeof value[field] !== "boolean") issues.push(`design.${field} must be boolean`);
  }
}

function buildDenominators(
  study: DetectorCalibrationStudy,
  complete: Array<Extract<DetectorCalibrationCase, { outcome: "complete" }>>
): DetectorCalibrationDenominators {
  return {
    plannedCases: study.plannedCases,
    recordedCases: study.cases.length,
    completeCases: complete.length,
    censoredCases: study.cases.length - complete.length,
    referencePresent: complete.filter((entry) => entry.reference === "present").length,
    referenceAbsent: complete.filter((entry) => entry.reference === "absent").length,
    predictedDetected: complete.filter((entry) => entry.prediction === "detected").length,
    predictedNotDetected: complete.filter((entry) => entry.prediction === "not-detected").length
  };
}

function buildConfusionMatrix(complete: Array<Extract<DetectorCalibrationCase, { outcome: "complete" }>>) {
  return {
    truePositive: complete.filter((entry) => entry.reference === "present" && entry.prediction === "detected").length,
    falsePositive: complete.filter((entry) => entry.reference === "absent" && entry.prediction === "detected").length,
    trueNegative: complete.filter((entry) => entry.reference === "absent" && entry.prediction === "not-detected").length,
    falseNegative: complete.filter((entry) => entry.reference === "present" && entry.prediction === "not-detected").length
  };
}

function buildRates(
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

function wilson95(successes: number, denominator: number) {
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
  study: DetectorCalibrationStudy,
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
