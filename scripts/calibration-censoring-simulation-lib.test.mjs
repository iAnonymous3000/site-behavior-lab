import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CLASS_DENOMINATORS,
  METRIC_DENOMINATOR,
  POLICIES,
  classDenominators,
  distributeIndeterminate,
  simulatePolicy,
  wilsonHalfWidth
} from "./calibration-censoring-simulation-lib.mjs";

test("each rate is sized on its own marginal denominator, never the total", () => {
  // THE REGRESSION THIS SUITE EXISTS FOR. The first simulation computed one
  // Wilson half-width from the TOTAL usable count and reported 5.5% at 310
  // usable cases. The gate evaluates four rates on four marginals, each a
  // fraction of that total, so every published interval was understated.
  const pooled = wilsonHalfWidth(310);
  const result = simulatePolicy({
    policy: "detector-scoped-complete-case",
    plannedCases: 350,
    usableRate: 310 / 350,
    prevalence: 0.5,
    recall: 0.7,
    specificity: 0.95
  });

  assert.equal(result.usableCases, 310);
  // referencePresent ~155, predictedDetected ~ 0.7*155 + 0.05*155 ~ 116.
  assert.ok(result.denominators.referencePresent < 310);
  assert.ok(result.denominators.predictedDetected < result.denominators.referencePresent);

  for (const [metric, className] of Object.entries(METRIC_DENOMINATOR)) {
    assert.equal(result.metrics[metric].className, className);
    assert.ok(
      result.metrics[metric].samplingHalfWidth > pooled,
      `${metric} must be wider than the pooled figure, since its class is smaller than the total`
    );
  }
  assert.ok(
    result.widestHalfWidth > pooled * 1.5,
    "the binding metric is materially wider than the pooled number suggested"
  );
});

test("predictedDetected is not referencePresent", () => {
  // At recall below 1 the detector's own class is short even when the
  // reference class is sized exactly. This is why sizing to E[present]=100
  // leaves the study ineligible.
  const d = classDenominators({ usableCases: 200, prevalence: 0.5, recall: 0.7, specificity: 1 });
  assert.equal(d.referencePresent, 100);
  assert.equal(d.predictedDetected, 70);
  assert.equal(d.referenceAbsent, 100);
  assert.equal(d.predictedNotDetected, 130);

  // False positives push it back up; it is a different quantity either way.
  const withFp = classDenominators({ usableCases: 200, prevalence: 0.5, recall: 0.7, specificity: 0.8 });
  assert.equal(withFp.predictedDetected, 90);
});

test("the class floors are enforced alongside interval width", () => {
  // A study can be narrow and still ineligible: the policy requires every one
  // of the four classes to reach its minimum, which width alone never shows.
  const result = simulatePolicy({
    policy: "detector-scoped-complete-case",
    plannedCases: 350,
    usableRate: 0.885,
    prevalence: 0.5,
    recall: 0.5,
    specificity: 1
  });
  assert.ok(result.denominators.predictedDetected < 100, "recall 0.5 starves the detector class");
  assert.equal(result.publishable, false);
  assert.deepEqual(result.failingFloors, ["predictedDetected"]);
});

test("indeterminate cases are scenario-dependent, not one conservative number", () => {
  // Without independent references the corpus cannot say WHICH class holds the
  // indeterminate predictions, so a single number is not available. The worst
  // case concentrates them in the smallest class.
  const denominators = { referencePresent: 155, referenceAbsent: 155, predictedDetected: 109, predictedNotDetected: 201 };

  const balanced = distributeIndeterminate(denominators, 34, "balanced");
  assert.ok(balanced.predictedDetected < 34);
  assert.equal(
    Object.values(balanced).reduce((a, b) => a + b, 0) >= 33,
    true,
    "a balanced split still assigns every indeterminate case"
  );

  const worst = distributeIndeterminate(denominators, 34, "worst-class-concentration");
  assert.equal(worst.predictedDetected, 34, "the smallest class takes all of them");
  assert.equal(worst.referencePresent, 0);

  const balancedRun = simulatePolicy({
    policy: "bounded-censoring-with-sensitivity-analysis",
    plannedCases: 350, usableRate: 0.885, indeterminateRate: 0.098,
    prevalence: 0.5, recall: 0.7, specificity: 0.95, scenario: "balanced"
  });
  const worstRun = simulatePolicy({
    policy: "bounded-censoring-with-sensitivity-analysis",
    plannedCases: 350, usableRate: 0.885, indeterminateRate: 0.098,
    prevalence: 0.5, recall: 0.7, specificity: 0.95, scenario: "worst-class-concentration"
  });
  assert.ok(
    worstRun.widestHalfWidth > balancedRun.widestHalfWidth,
    "the concentration scenario must bound worse than the balanced one"
  );
});

test("only the bounded policy admits indeterminate cases", () => {
  const common = {
    plannedCases: 350, usableRate: 0.885, indeterminateRate: 0.098,
    prevalence: 0.5, recall: 0.7, specificity: 0.95
  };
  assert.equal(simulatePolicy({ ...common, policy: "zero-censoring" }).indeterminate, 0);
  assert.equal(simulatePolicy({ ...common, policy: "detector-scoped-complete-case" }).indeterminate, 0);
  assert.ok(simulatePolicy({ ...common, policy: "bounded-censoring-with-sensitivity-analysis" }).indeterminate > 0);
});

test("zero-censoring reports its all-or-nothing failure separately from width", () => {
  // A's widths are meaningless on their own: it publishes only if the study
  // censored nothing. A usable rate below 1 is no study, not a narrower one,
  // and that is not a width question.
  const result = simulatePolicy({
    policy: "zero-censoring",
    plannedCases: 350, usableRate: 0.443,
    prevalence: 0.5, recall: 0.7, specificity: 0.95
  });
  assert.equal(result.allOrNothingUnsatisfiedAt, 0.443);

  const complete = simulatePolicy({
    policy: "zero-censoring",
    plannedCases: 350, usableRate: 1,
    prevalence: 0.5, recall: 0.7, specificity: 0.95
  });
  assert.equal(complete.allOrNothingUnsatisfiedAt, null);

  // B never reports it, because it does not make a study-level guarantee.
  assert.equal(
    simulatePolicy({
      policy: "detector-scoped-complete-case",
      plannedCases: 350, usableRate: 0.443,
      prevalence: 0.5, recall: 0.7, specificity: 0.95
    }).allOrNothingUnsatisfiedAt,
    null
  );
});

test("the policies are distinct rules, not two names for one", () => {
  assert.equal(POLICIES["zero-censoring"].allOrNothing, true);
  assert.equal(POLICIES["detector-scoped-complete-case"].allOrNothing, false);
  assert.notEqual(
    POLICIES["zero-censoring"].publishesFrom,
    POLICIES["detector-scoped-complete-case"].publishesFrom
  );
  assert.equal(POLICIES["bounded-censoring-with-sensitivity-analysis"].admitsIndeterminate, true);
});

test("every declared class has a metric and vice versa", () => {
  assert.deepEqual([...CLASS_DENOMINATORS].sort(), [...new Set(Object.values(METRIC_DENOMINATOR))].sort());
});

test("an unknown policy or scenario fails rather than defaulting", () => {
  assert.throws(
    () => simulatePolicy({ policy: "lenient", plannedCases: 350, usableRate: 1, prevalence: 0.5, recall: 0.7, specificity: 0.95 }),
    /unknown policy/
  );
  assert.throws(() => distributeIndeterminate({ a: 1 }, 5, "optimistic"), /unknown missingness scenario/);
  assert.throws(
    () => simulatePolicy({ policy: "zero-censoring", plannedCases: 350, usableRate: 1, prevalence: 1.4, recall: 0.7, specificity: 0.95 }),
    /prevalence must be a probability/
  );
});
