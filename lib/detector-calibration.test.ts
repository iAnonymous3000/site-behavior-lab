import assert from "node:assert/strict";
import { test } from "node:test";
import {
  analyzeDetectorCalibrationStudy,
  detectorCalibrationReadiness,
  detectorCalibrationStudyIssues,
  DETECTOR_CALIBRATION_ANALYSIS_VERSION,
  type DetectorCalibrationStudy
} from "./detector-calibration";
import { DETECTOR_REGISTRY_VERSION, DETECTOR_VERSIONS } from "./measurement-kernel";

test("acceptance fixtures remain explicitly separate from calibration evidence", () => {
  assert.deepEqual(detectorCalibrationReadiness(), {
    status: "external-labeled-corpus-required",
    acceptanceFixtureCases: 18,
    calibrationStudies: 0,
    labeledCalibrationCases: 0,
    calibrationRateClaimsAvailable: false,
    evidenceGate:
      "A preselected, version-pinned, independently labeled case corpus with a declared sampling frame and complete planned denominator is still required."
  });
});

test("a complete convenience study reports denominators and point rates without population uncertainty", () => {
  const analysis = analyzeDetectorCalibrationStudy(study("convenience"));
  assert.equal(analysis.analysisVersion, DETECTOR_CALIBRATION_ANALYSIS_VERSION);
  assert.equal(analysis.status, "descriptive-only");
  assert.equal(analysis.studyDigest?.length, 64);
  assert.deepEqual(analysis.denominators, {
    plannedCases: 4,
    recordedCases: 4,
    completeCases: 4,
    censoredCases: 0,
    referencePresent: 2,
    referenceAbsent: 2,
    predictedDetected: 2,
    predictedNotDetected: 2
  });
  assert.deepEqual(analysis.confusionMatrix, {
    truePositive: 1,
    falsePositive: 1,
    trueNegative: 1,
    falseNegative: 1
  });
  assert.equal(analysis.rates?.sensitivity.estimate, 0.5);
  assert.equal(analysis.rates?.specificity.estimate, 0.5);
  assert.equal(analysis.rates?.accuracy.denominator, 4);
  assert.equal(analysis.rates?.accuracy.interval95, null);
  assert.deepEqual(analysis.uncertainty, {
    method: "none",
    reason: "descriptive-census-or-convenience-sample"
  });
  assert.equal(analysis.inference.scope, "recorded-cases-only");
  assert.equal(analysis.inference.conditionalTargetPopulationRateClaimAllowed, false);
});

test("Wilson intervals are emitted only when every declared simple-random design gate passes", () => {
  const analysis = analyzeDetectorCalibrationStudy(study("simple-random"));
  assert.equal(analysis.status, "sample-estimate");
  assert.deepEqual(analysis.uncertainty, {
    method: "wilson-score-95",
    reason: "conditional-on-declared-simple-random-design"
  });
  const sensitivity = analysis.rates?.sensitivity;
  assert.notEqual(sensitivity, undefined);
  assert.equal(sensitivity!.estimate, 0.5);
  assert.equal(sensitivity!.interval95?.method, "wilson-score");
  assert.equal((sensitivity!.interval95?.lower ?? 1) < 0.5, true);
  assert.equal((sensitivity!.interval95?.upper ?? 0) > 0.5, true);
  assert.equal(analysis.inference.scope, "conditional-on-declared-target-population");
  assert.equal(analysis.inference.targetPopulation, "Public English-language pages in the declared July frame");
  assert.equal(analysis.inference.conditionalTargetPopulationRateClaimAllowed, true);

  const unblinded = study("simple-random");
  unblinded.design.referenceBlindedToPrediction = false;
  const downgraded = analyzeDetectorCalibrationStudy(unblinded);
  assert.equal(downgraded.status, "descriptive-only");
  assert.equal(downgraded.rates?.sensitivity.interval95, null);
  assert.equal(downgraded.uncertainty.reason, "simple-random-design-gates-not-met");
  assert.equal(downgraded.inference.conditionalTargetPopulationRateClaimAllowed, false);
});

test("one censored case suppresses the complete-case confusion matrix and every rate", () => {
  const input = study("simple-random");
  input.cases[1] = { caseId: "positive-missed", outcome: "censored", reason: "capture-failed" };
  const analysis = analyzeDetectorCalibrationStudy(input);
  assert.equal(analysis.status, "ineligible");
  assert.equal(analysis.ineligibilityReasons.includes("censored-cases-present"), true);
  assert.equal(analysis.denominators.plannedCases, 4);
  assert.equal(analysis.denominators.recordedCases, 4);
  assert.equal(analysis.denominators.completeCases, 3);
  assert.equal(analysis.denominators.censoredCases, 1);
  assert.equal(analysis.confusionMatrix, null);
  assert.equal(analysis.rates, null);
  assert.equal(analysis.inference.scope, "none");
});

test("planned-denominator, version, registry, and reference-class gaps fail closed", () => {
  const input = study("convenience");
  input.plannedCases = 5;
  input.detectorVersion = "stale-detector";
  input.registryVersion = "stale-registry";
  input.cases = input.cases.filter((entry) => entry.outcome !== "complete" || entry.reference === "present");
  const analysis = analyzeDetectorCalibrationStudy(input);
  assert.equal(analysis.status, "ineligible");
  assert.deepEqual(analysis.ineligibilityReasons, [
    "planned-denominator-mismatch",
    "detector-version-mismatch",
    "registry-version-mismatch",
    "missing-negative-reference-denominator"
  ]);
  assert.equal(analysis.confusionMatrix, null);
  assert.equal(analysis.rates, null);
});

test("undefined metric denominators stay null instead of becoming zero-rate claims", () => {
  const input = study("convenience");
  input.cases = [
    { caseId: "positive-one", outcome: "complete", reference: "present", prediction: "not-detected" },
    { caseId: "negative-one", outcome: "complete", reference: "absent", prediction: "not-detected" }
  ];
  input.plannedCases = 2;
  const analysis = analyzeDetectorCalibrationStudy(input);
  assert.equal(analysis.status, "descriptive-only");
  assert.deepEqual(analysis.rates?.precision, {
    numerator: 0,
    denominator: 0,
    estimate: null,
    interval95: null
  });
  assert.equal(analysis.rates?.sensitivity.estimate, 0);
  assert.equal(analysis.rates?.specificity.estimate, 1);
});

test("malformed, duplicate, extra-field, and over-broad study shapes are rejected", () => {
  const duplicate = study("convenience") as DetectorCalibrationStudy & { extra?: boolean };
  duplicate.cases[1] = { ...duplicate.cases[0] };
  duplicate.extra = true;
  const issues = detectorCalibrationStudyIssues(duplicate);
  assert.equal(issues.some((issue) => issue === "study has unexpected or missing fields"), true);
  assert.equal(issues.some((issue) => issue.includes("repeats caseId")), true);
  const analysis = analyzeDetectorCalibrationStudy(duplicate);
  assert.equal(analysis.status, "invalid");
  assert.equal(analysis.studyDigest, null);
  assert.equal(analysis.rates, null);
});

function study(sampling: DetectorCalibrationStudy["design"]["sampling"]): DetectorCalibrationStudy {
  return {
    studyId: "fp-july-calibration-v1",
    detector: "fingerprint-heuristics",
    detectorVersion: DETECTOR_VERSIONS["fingerprint-heuristics"],
    registryVersion: DETECTOR_REGISTRY_VERSION,
    targetPopulation: "Public English-language pages in the declared July frame",
    plannedCases: 4,
    design: {
      sampling,
      samplingFrame: "Frozen frame digest 0123456789abcdef",
      samplingFrameDigest: "0".repeat(64),
      selectionProtocol: "Select case ids before detector output is available.",
      referenceProtocol: "Two blinded reviewers adjudicate presence from independent source evidence.",
      independentUnits: true,
      predictionBlindedToReference: true,
      referenceBlindedToPrediction: true
    },
    cases: [
      { caseId: "positive-detected", outcome: "complete", reference: "present", prediction: "detected" },
      { caseId: "positive-missed", outcome: "complete", reference: "present", prediction: "not-detected" },
      { caseId: "negative-clear", outcome: "complete", reference: "absent", prediction: "not-detected" },
      { caseId: "negative-flagged", outcome: "complete", reference: "absent", prediction: "detected" }
    ]
  };
}

test("the confusion matrix distinguishes every cell, not just their total", () => {
  // The only matrix assertion used a symmetric 1/1/1/1 fixture whose one
  // asymmetric sibling was invariant under a present/absent label swap, so any
  // permutation of truePositive, falsePositive, trueNegative, and falseNegative
  // would have passed. An asymmetric fixture pins each cell to its own meaning.
  const asymmetric = study("convenience");
  asymmetric.plannedCases = 7;
  asymmetric.cases = [
    { caseId: "tp-1", outcome: "complete", reference: "present", prediction: "detected" },
    { caseId: "tp-2", outcome: "complete", reference: "present", prediction: "detected" },
    { caseId: "tp-3", outcome: "complete", reference: "present", prediction: "detected" },
    { caseId: "fn-1", outcome: "complete", reference: "present", prediction: "not-detected" },
    { caseId: "fp-1", outcome: "complete", reference: "absent", prediction: "detected" },
    { caseId: "fp-2", outcome: "complete", reference: "absent", prediction: "detected" },
    { caseId: "tn-1", outcome: "complete", reference: "absent", prediction: "not-detected" }
  ];

  const analysis = analyzeDetectorCalibrationStudy(asymmetric);
  assert.deepEqual(analysis.confusionMatrix, {
    truePositive: 3,
    falsePositive: 2,
    trueNegative: 1,
    falseNegative: 1
  });
  assert.deepEqual(analysis.denominators, {
    plannedCases: 7,
    recordedCases: 7,
    completeCases: 7,
    censoredCases: 0,
    referencePresent: 4,
    referenceAbsent: 3,
    predictedDetected: 5,
    predictedNotDetected: 2
  });
  // Sensitivity and specificity read different cells and must not coincide.
  assert.equal(analysis.rates?.sensitivity.estimate, 0.75);
  assert.equal(analysis.rates?.specificity.estimate, 1 / 3);
  assert.equal(analysis.rates?.sensitivity.denominator, 4);
  assert.equal(analysis.rates?.specificity.denominator, 3);
});
