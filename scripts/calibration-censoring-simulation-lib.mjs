/**
 * Feasibility simulation for candidate calibration censoring policies.
 *
 * This is the arithmetic only. It reads no corpus and makes no policy choice;
 * the corpus driver supplies observed rates and the human supplies the target.
 *
 * WHY IT EXISTS SEPARATELY. A first version of this simulation computed one
 * Wilson half-width from the TOTAL usable case count. The release gate does not
 * evaluate one rate on the total: it evaluates each rate on its own marginal
 * denominator, and every marginal is a fraction of the total. With 310 usable
 * cases a reference class near 155 carries ~7.8% and a predicted-detected class
 * near 109 carries ~9.2% -- not the 5.5% the pooled figure suggested. Reporting
 * the pooled number understates every published interval.
 */

/** The four class denominators the policy floors apply to. */
export const CLASS_DENOMINATORS = Object.freeze([
  "referencePresent",
  "referenceAbsent",
  "predictedDetected",
  "predictedNotDetected"
]);

/** Which class denominator each published rate is computed over. */
export const METRIC_DENOMINATOR = Object.freeze({
  sensitivity: "referencePresent",
  specificity: "referenceAbsent",
  precision: "predictedDetected",
  negativePredictiveValue: "predictedNotDetected"
});

/**
 * The three candidate policies, defined precisely because the first draft
 * conflated the first two.
 *
 * A `zero-censoring` and B `detector-scoped-complete-case` are NOT the same
 * shape of rule. A publishes only if the study censored NOTHING: one censored
 * case and there is no rate at all. B analyses the cases whose detector-required
 * inputs are whole and reports the rest as coverage loss -- that is a
 * complete-case analysis, and calling it "detector-scoped zero-censoring" would
 * claim a study-level guarantee it does not make.
 */
export const POLICIES = Object.freeze({
  "zero-censoring": Object.freeze({
    id: "zero-censoring",
    label: "A  zero-censoring (current)",
    publishesFrom: "all-cases",
    admitsIndeterminate: false,
    allOrNothing: true
  }),
  "detector-scoped-complete-case": Object.freeze({
    id: "detector-scoped-complete-case",
    label: "B  detector-scoped complete-case",
    publishesFrom: "detector-input-complete cases",
    admitsIndeterminate: false,
    allOrNothing: false
  }),
  "bounded-censoring-with-sensitivity-analysis": Object.freeze({
    id: "bounded-censoring-with-sensitivity-analysis",
    label: "C  bounded + conservative bounds",
    publishesFrom: "all bare-load-valid cases",
    admitsIndeterminate: true,
    allOrNothing: false
  })
});

export function wilsonHalfWidth(n, p = 0.5, z = 1.96) {
  if (!Number.isFinite(n) || n <= 0) return 0.5;
  const d = 1 + (z * z) / n;
  return (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
}

/**
 * The four marginal denominators implied by an operating point.
 *
 * `predictedDetected` is NOT `referencePresent`: at recall r it is
 * `r*referencePresent + (1-specificity)*referenceAbsent`, which is why sizing a
 * frame so the reference class reaches 100 can still leave the detector's own
 * class short.
 */
export function classDenominators({ usableCases, prevalence, recall, specificity }) {
  requireUnit(prevalence, "prevalence");
  requireUnit(recall, "recall");
  requireUnit(specificity, "specificity");
  const referencePresent = usableCases * prevalence;
  const referenceAbsent = usableCases - referencePresent;
  const predictedDetected = recall * referencePresent + (1 - specificity) * referenceAbsent;
  return {
    referencePresent: Math.round(referencePresent),
    referenceAbsent: Math.round(referenceAbsent),
    predictedDetected: Math.round(predictedDetected),
    predictedNotDetected: Math.round(usableCases - predictedDetected)
  };
}

/**
 * How indeterminate predictions distribute across the four classes.
 *
 * Without independent references the corpus CANNOT show which class holds them,
 * so a single "conservative" number is not available. Both scenarios are
 * reported and the worst one governs.
 *
 *  - `balanced` spreads them in proportion to class size.
 *  - `worst-class-concentration` puts every one into the SMALLEST class, which
 *    is where they do the most damage to a bound.
 */
export function distributeIndeterminate(denominators, indeterminate, scenario) {
  const entries = CLASS_DENOMINATORS.map((k) => [k, denominators[k]]);
  const total = entries.reduce((sum, [, v]) => sum + v, 0);
  if (indeterminate <= 0 || total <= 0) {
    return Object.fromEntries(CLASS_DENOMINATORS.map((k) => [k, 0]));
  }
  if (scenario === "balanced") {
    return Object.fromEntries(entries.map(([k, v]) => [k, Math.round((indeterminate * v) / total)]));
  }
  if (scenario === "worst-class-concentration") {
    const smallest = entries.reduce((a, b) => (b[1] < a[1] ? b : a))[0];
    return Object.fromEntries(CLASS_DENOMINATORS.map((k) => [k, k === smallest ? indeterminate : 0]));
  }
  throw new Error(`unknown missingness scenario ${scenario}`);
}

/**
 * Per-metric bound for one policy at one planned N.
 *
 * Total half-width is sampling uncertainty on the observed class PLUS the
 * width the indeterminate cases could move the estimate through: with `d`
 * observed and `m` indeterminate in a class, the rate lies anywhere in an
 * interval of width `m/(d+m)`, so its half-contribution is `m/(2*(d+m))`.
 */
export function simulatePolicy({
  policy,
  plannedCases,
  usableRate,
  indeterminateRate = 0,
  prevalence,
  recall,
  specificity,
  scenario = "balanced",
  minimumClassDenominator = 100,
  maximumHalfWidth = 0.1
}) {
  const spec = POLICIES[policy];
  if (spec === undefined) throw new Error(`unknown policy ${policy}`);

  const usableCases = Math.round(plannedCases * usableRate);
  const indeterminate = spec.admitsIndeterminate ? Math.round(plannedCases * indeterminateRate) : 0;
  const denominators = classDenominators({ usableCases, prevalence, recall, specificity });
  const missing = distributeIndeterminate(denominators, indeterminate, scenario);

  const metrics = {};
  for (const [metric, className] of Object.entries(METRIC_DENOMINATOR)) {
    const observed = denominators[className];
    const m = missing[className];
    const sampling = wilsonHalfWidth(observed);
    const missingness = m > 0 ? m / (2 * (observed + m)) : 0;
    metrics[metric] = {
      className,
      observed,
      indeterminate: m,
      samplingHalfWidth: sampling,
      missingnessHalfWidth: missingness,
      totalHalfWidth: sampling + missingness,
      clearsWidth: sampling + missingness <= maximumHalfWidth,
      clearsFloor: observed >= minimumClassDenominator
    };
  }

  const failingFloors = Object.values(metrics).filter((m) => !m.clearsFloor).map((m) => m.className);
  const widest = Object.entries(metrics).reduce((a, b) => (b[1].totalHalfWidth > a[1].totalHalfWidth ? b : a));

  return {
    policy: spec,
    plannedCases,
    usableCases,
    indeterminate,
    scenario,
    denominators,
    metrics,
    widestMetric: widest[0],
    widestHalfWidth: widest[1].totalHalfWidth,
    // Every floor AND every width, which is what the gate actually requires.
    publishable: failingFloors.length === 0 && Object.values(metrics).every((m) => m.clearsWidth),
    failingFloors: [...new Set(failingFloors)],
    // A publishes nothing unless the study censored nothing at all, so a usable
    // rate below 1 is not a smaller study -- it is no study. Stated separately
    // because it is not a width question.
    allOrNothingUnsatisfiedAt: spec.allOrNothing && usableRate < 1 ? usableRate : null
  };
}

function requireUnit(value, name) {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name} must be a probability in [0,1]`);
  }
}
