import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CLASS_DENOMINATORS,
  METRIC_DENOMINATOR,
  POLICIES,
  RATE_CELLS,
  boundsOverAssignments,
  classDenominators,
  confusionMatrix,
  extremalMatrices,
  rateFrom,
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
    assert.equal(result.bounds[metric] && METRIC_DENOMINATOR[metric], className);
    assert.ok(
      result.bounds[metric].samplingHalfWidth > pooled,
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

test("missing cases are assigned in a 2x2, not allocated once across margins", () => {
  // REGRESSION. The four class denominators are TWO PARTITIONS of the same
  // cases, so they sum to 2n. The first version allocated each missing case
  // once across those four margins, which is not a realizable assignment:
  // "all of them in predictedDetected" never says what their reference class
  // is, and nothing can join a prediction margin without joining a reference
  // margin too. Every bound it produced was invalid.
  const matrix = { tp: 109, fn: 47, tn: 147, fp: 8 };
  const observed = matrix.tp + matrix.fn + matrix.tn + matrix.fp;

  for (const { matrix: candidate } of extremalMatrices(matrix, 34, { referenceKnown: true })) {
    const total = candidate.tp + candidate.fn + candidate.tn + candidate.fp;
    assert.equal(total, observed + 34, "every assignment must place all 34 cases exactly once");
    // Each rate's denominators stay coherent: the two partitions still agree.
    assert.equal(
      candidate.tp + candidate.fn + candidate.tn + candidate.fp,
      (candidate.tp + candidate.fn) + (candidate.tn + candidate.fp),
      "reference partition must cover the whole matrix"
    );
    assert.equal(
      (candidate.tp + candidate.fp) + (candidate.tn + candidate.fn),
      total,
      "prediction partition must cover the whole matrix"
    );
  }
});

test("all seven published rates are bounded, from the same matrix", () => {
  // The gate publishes seven rates; bounding four and hoping is not a bound.
  const matrix = { tp: 109, fn: 47, tn: 147, fp: 8 };
  const bounds = boundsOverAssignments(matrix, 34, { referenceKnown: true });
  assert.deepEqual(Object.keys(bounds).sort(), Object.keys(RATE_CELLS).sort());
  for (const [rateId, bound] of Object.entries(bounds)) {
    assert.ok(bound.totalHalfWidth > 0, `${rateId} must carry a bound`);
    assert.ok(bound.assignmentHalfWidth > 0, `${rateId} must widen for 34 unassigned cases`);
  }
  // With nothing missing the assignment component vanishes and only sampling remains.
  const exact = boundsOverAssignments(matrix, 0, { referenceKnown: true });
  for (const bound of Object.values(exact)) assert.equal(bound.assignmentHalfWidth, 0);
});

test("a case missing its reference too bounds no better than one that is not", () => {
  const matrix = { tp: 109, fn: 47, tn: 147, fp: 8 };
  const known = boundsOverAssignments(matrix, 34, { referenceKnown: true });
  const unknown = boundsOverAssignments(matrix, 34, { referenceKnown: false });
  for (const rateId of Object.keys(RATE_CELLS)) {
    assert.ok(
      unknown[rateId].totalHalfWidth >= known[rateId].totalHalfWidth - 1e-9,
      `${rateId}: an unconstrained case cannot bound better than a constrained one`
    );
  }
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
  assert.throws(
    () => simulatePolicy({ policy: "zero-censoring", plannedCases: 350, usableRate: 1, prevalence: 1.4, recall: 0.7, specificity: 0.95 }),
    /prevalence must be a probability/
  );
});

test("B does not silently inherit the frame's target population", () => {
  // Complete-case analysis is potentially selected on measurement difficulty:
  // the cases it drops are the ones the instrument found hard. Absent a
  // predefined screening population, a B rate describes the scoreable
  // subpopulation, and saying otherwise would generalize from a selected set.
  assert.equal(
    POLICIES["detector-scoped-complete-case"].inferenceScope,
    "scoreable-subpopulation-unless-population-predefined"
  );
  assert.equal(POLICIES["zero-censoring"].inferenceScope, "target-population");
  assert.equal(
    POLICIES["bounded-censoring-with-sensitivity-analysis"].inferenceScope,
    "target-population",
    "C keeps every admitted case, so its bounds do describe the frame"
  );
});
