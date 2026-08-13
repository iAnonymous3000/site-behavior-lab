import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DETECTOR_CALIBRATION_ANALYSIS_VERSION,
  type DetectorCalibrationAnalysis,
  type DetectorCalibrationRateId
} from "./detector-calibration";
import {
  calibrationIneligibilitySummary,
  calibrationRatesQuotable,
  detectorCalibrationReaderClaims,
  detectorCalibrationReaderSentence
} from "./detector-calibration-reader";
import {
  MEASUREMENT_CALIBRATION_MAXIMUM_WORST_CASE_HALF_WIDTH,
  MEASUREMENT_CALIBRATION_MINIMUM_CLASS_DENOMINATOR
} from "./measurement-candidate-binding";

// The whole point of this module is that it REFUSES to quote a number. So the
// fixture is a study that would pass every gate, and each test breaks exactly
// one thing and asserts the refusal. A test that only checked the happy path
// would pass just as well against a function that always returned true.

const RATE_IDS: DetectorCalibrationRateId[] = [
  "sensitivity",
  "specificity",
  "precision",
  "negativePredictiveValue",
  "accuracy",
  "falsePositiveRate",
  "falseNegativeRate"
];

function publishableAnalysis(
  overrides: Partial<DetectorCalibrationAnalysis> = {}
): DetectorCalibrationAnalysis {
  const rates = Object.fromEntries(
    RATE_IDS.map((id) => [
      id,
      {
        numerator: 90,
        denominator: 100,
        estimate: 0.9,
        // Half-width 0.05, comfortably inside the policy ceiling.
        interval95: { lower: 0.85, upper: 0.95, method: "wilson-score" as const }
      }
    ])
  ) as DetectorCalibrationAnalysis["rates"];

  return {
    analysisVersion: DETECTOR_CALIBRATION_ANALYSIS_VERSION,
    status: "sample-estimate",
    studyId: "cname-uncloaking-fixture",
    detector: "cname-uncloaking",
    studyDigest: "a".repeat(64),
    issues: [],
    ineligibilityReasons: [],
    denominators: {
      plannedCases: 800,
      recordedCases: 800,
      completeCases: 800,
      censoredCases: 0,
      referencePresent: 120,
      referenceAbsent: 680,
      predictedDetected: 115,
      predictedNotDetected: 685
    },
    confusionMatrix: { truePositive: 110, falsePositive: 5, trueNegative: 675, falseNegative: 10 },
    rates,
    uncertainty: { method: "wilson-score-95", reason: "conditional-on-declared-simple-random-design" },
    inference: {
      scope: "conditional-on-declared-target-population-and-fixed-measurement-condition",
      targetPopulation: "a declared population",
      measurementCondition: {
        device: "desktop",
        gpcEnabled: false,
        consentMode: "observe",
        interpretation: "Rates are conditional on desktop visits with GPC disabled."
      },
      conditionalRateClaim: "Rates estimate detector performance only for the declared population.",
      conditionalTargetPopulationRateClaimAllowed: true,
      caveats: []
    },
    ...overrides
  };
}

test("the fixture is quotable, so every refusal below is caused by its own mutation", () => {
  assert.equal(calibrationRatesQuotable(publishableAnalysis()), true);
});

test("a rate is refused unless the analyzer called the study a sample estimate", () => {
  for (const status of ["ineligible", "invalid", "descriptive-only"] as const) {
    assert.equal(
      calibrationRatesQuotable(publishableAnalysis({ status })),
      false,
      `status ${status} must not publish a rate`
    );
  }
});

test("a rate is refused when any class denominator is one below the policy minimum", () => {
  for (const field of [
    "referencePresent",
    "referenceAbsent",
    "predictedDetected",
    "predictedNotDetected"
  ] as const) {
    const analysis = publishableAnalysis();
    analysis.denominators[field] = MEASUREMENT_CALIBRATION_MINIMUM_CLASS_DENOMINATOR - 1;
    assert.equal(
      calibrationRatesQuotable(analysis),
      false,
      `${field} below the minimum must not publish a rate`
    );
  }
});

test("a rate is refused when any single interval exceeds the policy half-width", () => {
  // Only ONE of the seven rates is widened. A gate that checked just the first
  // rate, or an aggregate, would pass this fixture and still be wrong.
  for (const rateId of RATE_IDS) {
    const analysis = publishableAnalysis();
    const half = MEASUREMENT_CALIBRATION_MAXIMUM_WORST_CASE_HALF_WIDTH;
    analysis.rates![rateId] = {
      numerator: 50,
      denominator: 100,
      estimate: 0.5,
      interval95: { lower: 0.5 - half - 0.01, upper: 0.5 + half + 0.01, method: "wilson-score" }
    };
    assert.equal(
      calibrationRatesQuotable(analysis),
      false,
      `a too-wide ${rateId} interval must not publish a rate`
    );
  }
});

test("a rate is refused when the analyzer withheld the conditional claim", () => {
  assert.equal(
    calibrationRatesQuotable(
      publishableAnalysis({
        inference: {
          ...publishableAnalysis().inference,
          conditionalTargetPopulationRateClaimAllowed: false
        }
      })
    ),
    false
  );
  assert.equal(
    calibrationRatesQuotable(
      publishableAnalysis({
        inference: { ...publishableAnalysis().inference, conditionalRateClaim: "" }
      })
    ),
    false
  );
  assert.equal(
    calibrationRatesQuotable(
      publishableAnalysis({
        inference: { ...publishableAnalysis().inference, measurementCondition: null }
      })
    ),
    false
  );
});

test("a rate is refused when intervals or rates are missing entirely", () => {
  assert.equal(calibrationRatesQuotable(publishableAnalysis({ rates: null })), false);
  const noInterval = publishableAnalysis();
  noInterval.rates!.precision = {
    numerator: 90,
    denominator: 100,
    estimate: 0.9,
    interval95: null
  };
  assert.equal(calibrationRatesQuotable(noInterval), false);
  assert.equal(
    calibrationRatesQuotable(
      publishableAnalysis({ uncertainty: { method: "none", reason: "study-ineligible" } })
    ),
    false
  );
});

test("a detector no study names reads as unmeasured, not as measured-and-clean", () => {
  const claims = detectorCalibrationReaderClaims([], ["cname-uncloaking"]);
  assert.equal(claims.length, 1);
  assert.equal(claims[0]!.state, "unmeasured");
  assert.equal(claims[0]!.conditionalRateClaim, null);
});

test("an ineligible study is reported as recorded-and-not-eligible, carrying its reasons", () => {
  const ineligible = publishableAnalysis({
    status: "ineligible",
    ineligibilityReasons: ["censored-cases-present", "brave-list-revision-mismatch"]
  });
  const claims = detectorCalibrationReaderClaims([ineligible], ["cname-uncloaking"]);
  assert.equal(claims[0]!.state, "study-recorded-not-eligible");
  assert.equal(claims[0]!.studyId, "cname-uncloaking-fixture");
  assert.equal(claims[0]!.conditionalRateClaim, null);
  assert.deepEqual(
    [...claims[0]!.ineligibilityReasons],
    ["censored-cases-present", "brave-list-revision-mismatch"]
  );
});

test("a publishable study beats an ineligible one for the same detector", () => {
  const claims = detectorCalibrationReaderClaims(
    [publishableAnalysis({ status: "ineligible", ineligibilityReasons: ["no-complete-cases"] }), publishableAnalysis()],
    ["cname-uncloaking"]
  );
  assert.equal(claims[0]!.state, "rates-published");
});

test("the reader sentence states no rate, and quotes no number, when nothing is publishable", () => {
  const sentence = detectorCalibrationReaderSentence(
    detectorCalibrationReaderClaims(
      [publishableAnalysis({ status: "ineligible", ineligibilityReasons: ["censored-cases-present"] })],
      ["cname-uncloaking", "pixel-events"]
    )
  );
  assert.match(sentence, /Detector accuracy is unmeasured/);
  assert.match(sentence, /does not support a published rate/);
  // The failure this guards is a future edit that interpolates an estimate
  // into the unmeasured branch. Any digit at all is the tell.
  assert.equal(/\d/.test(sentence), false, sentence);
});

test("an unknown ineligibility reason survives into the reader summary verbatim", () => {
  // A reason added to the analyzer must never silently vanish from the reader
  // surface just because this module has no friendly phrasing for it yet.
  const summary = calibrationIneligibilitySummary([
    "a-reason-this-module-has-never-seen" as never
  ]);
  assert.equal(summary, "a-reason-this-module-has-never-seen");
  assert.equal(calibrationIneligibilitySummary([]), null);
});

test("every analyzer ineligibility reason gets a non-empty reader phrasing", () => {
  const reasons = [
    "planned-denominator-mismatch",
    "censored-cases-present",
    "measurement-condition-unbound",
    "current-build-commit-unavailable",
    "build-commit-mismatch",
    "detector-implementation-digest-mismatch",
    "expected-runtime-identity-unavailable",
    "runtime-identity-digest-mismatch",
    "no-complete-cases",
    "missing-positive-reference-denominator",
    "missing-negative-reference-denominator"
  ] as const;
  for (const reason of reasons) {
    const summary = calibrationIneligibilitySummary([reason]);
    assert.ok(summary && summary.length > 0, `${reason} must have a reader phrasing`);
  }
});
