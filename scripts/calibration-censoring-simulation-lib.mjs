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
    allOrNothing: true,
    inferenceScope: "target-population"
  }),
  "detector-scoped-complete-case": Object.freeze({
    id: "detector-scoped-complete-case",
    label: "B  detector-scoped complete-case",
    publishesFrom: "detector-input-complete cases",
    admitsIndeterminate: false,
    allOrNothing: false,
    /**
     * B DOES NOT INHERIT THE FRAME'S TARGET POPULATION.
     *
     * Complete-case analysis is potentially selected on measurement
     * difficulty: the cases it drops are exactly the ones the instrument found
     * hard, and there is no reason to assume the detector performs the same on
     * those. So a B rate describes the SCOREABLE SUBPOPULATION, not the
     * randomized frame, unless the target population was defined before
     * sampling as sites that pass detector-input screening.
     *
     * Two admissible resolutions, and the preregistration must pick one:
     *  - define the population up front as screening-passing sites, which makes
     *    B a target-population estimate for a narrower, explicitly stated
     *    population; or
     *  - publish B as descriptive scoreable-subpopulation evidence and let C
     *    carry the target-population claim through its bounds.
     */
    inferenceScope: "scoreable-subpopulation-unless-population-predefined"
  }),
  "bounded-censoring-with-sensitivity-analysis": Object.freeze({
    id: "bounded-censoring-with-sensitivity-analysis",
    label: "C  bounded + conservative bounds",
    publishesFrom: "all bare-load-valid cases",
    admitsIndeterminate: true,
    allOrNothing: false,
    /** C keeps every admitted case, so its bounds do describe the frame. */
    inferenceScope: "target-population"
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
 * The seven rates the analyzer publishes, each with the 2x2 cells it is
 * computed from. Mirrors `detectorCalibrationRates` in lib/detector-calibration.ts.
 */
export const RATE_CELLS = Object.freeze({
  sensitivity: Object.freeze({ numerator: ["tp"], denominator: ["tp", "fn"] }),
  specificity: Object.freeze({ numerator: ["tn"], denominator: ["tn", "fp"] }),
  precision: Object.freeze({ numerator: ["tp"], denominator: ["tp", "fp"] }),
  negativePredictiveValue: Object.freeze({ numerator: ["tn"], denominator: ["tn", "fn"] }),
  accuracy: Object.freeze({ numerator: ["tp", "tn"], denominator: ["tp", "fp", "tn", "fn"] }),
  falsePositiveRate: Object.freeze({ numerator: ["fp"], denominator: ["fp", "tn"] }),
  falseNegativeRate: Object.freeze({ numerator: ["fn"], denominator: ["fn", "tp"] })
});

/** The expected 2x2 at an operating point. */
export function confusionMatrix({ usableCases, prevalence, recall, specificity }) {
  requireUnit(prevalence, "prevalence");
  requireUnit(recall, "recall");
  requireUnit(specificity, "specificity");
  const positives = usableCases * prevalence;
  const negatives = usableCases - positives;
  return {
    tp: Math.round(recall * positives),
    fn: Math.round(positives - recall * positives),
    tn: Math.round(specificity * negatives),
    fp: Math.round(negatives - specificity * negatives)
  };
}

const sum = (matrix, cells) => cells.reduce((total, cell) => total + matrix[cell], 0);

export function rateFrom(matrix, rateId) {
  const spec = RATE_CELLS[rateId];
  if (spec === undefined) throw new Error(`unknown rate ${rateId}`);
  const denominator = sum(matrix, spec.denominator);
  if (denominator === 0) return null;
  return sum(matrix, spec.numerator) / denominator;
}

/**
 * Extremal 2x2s obtained by assigning `missing` indeterminate cases.
 *
 * WHY A MATRIX AND NOT FOUR MARGINS. The four class denominators are two
 * PARTITIONS of the same cases -- referencePresent+referenceAbsent = n and
 * predictedDetected+predictedNotDetected = n -- so they sum to 2n. An earlier
 * version allocated each missing case ONCE across those four margins, which is
 * not a realizable assignment: "all of them in predictedDetected" never says
 * what their reference class is, and a case cannot be added to a prediction
 * margin without also joining a reference margin.
 *
 * A case with a missing PREDICTION but a known reference can only land in the
 * two cells of its reference row (TP or FN if present; TN or FP if absent). A
 * case missing BOTH is unconstrained. Enumerating the corner assignments and
 * taking the envelope over all of them is the honest bound: every corner is
 * realizable, and the true value lies inside their hull.
 */
export function extremalMatrices(matrix, missing, { referenceKnown = true } = {}) {
  if (missing <= 0) return [{ label: "observed", matrix }];
  const corners = referenceKnown
    ? [["tp", "fn"], ["tn", "fp"]].flatMap(([a, b]) => [a, b])
    : ["tp", "fn", "tn", "fp"];
  const results = [];
  for (const cell of corners) {
    results.push({ label: `all-missing->${cell}`, matrix: { ...matrix, [cell]: matrix[cell] + missing } });
  }
  // Split evenly across the reference rows as an interior reference point.
  results.push({
    label: "missing-split-evenly",
    matrix: {
      tp: matrix.tp + Math.round(missing / 4),
      fn: matrix.fn + Math.round(missing / 4),
      tn: matrix.tn + Math.round(missing / 4),
      fp: matrix.fp + (missing - 3 * Math.round(missing / 4))
    }
  });
  return results;
}

/**
 * Per-rate bound over every extremal assignment, combined with sampling
 * uncertainty on that rate's own denominator.
 */
export function boundsOverAssignments(matrix, missing, options) {
  const assignments = extremalMatrices(matrix, missing, options);
  const bounds = {};
  for (const rateId of Object.keys(RATE_CELLS)) {
    let lo = Infinity, hi = -Infinity, widestSampling = 0, smallestDenominator = Infinity;
    for (const { matrix: candidate } of assignments) {
      const value = rateFrom(candidate, rateId);
      if (value === null) continue;
      lo = Math.min(lo, value);
      hi = Math.max(hi, value);
      const denominator = sum(candidate, RATE_CELLS[rateId].denominator);
      smallestDenominator = Math.min(smallestDenominator, denominator);
      widestSampling = Math.max(widestSampling, wilsonHalfWidth(denominator));
    }
    if (lo === Infinity) { bounds[rateId] = null; continue; }
    const assignmentHalfWidth = (hi - lo) / 2;
    bounds[rateId] = {
      observedDenominator: sum(matrix, RATE_CELLS[rateId].denominator),
      smallestDenominator,
      assignmentHalfWidth,
      samplingHalfWidth: widestSampling,
      totalHalfWidth: assignmentHalfWidth + widestSampling
    };
  }
  return bounds;
}

/**
 * One policy at one planned N, derived from a full 2x2.
 *
 * `publishable` requires ALL of: every class floor met, every rate's total
 * half-width within the maximum, AND the policy's own all-or-nothing rule
 * satisfied. An earlier version omitted the last clause, so policy A reported
 * publishable at N=500 while only 44.3% of cases were usable -- which
 * contradicts A's own definition, since A publishes nothing unless the study
 * censored nothing at all.
 */
export function simulatePolicy({
  policy,
  plannedCases,
  usableRate,
  indeterminateRate = 0,
  prevalence,
  recall,
  specificity,
  referenceKnownForMissing = true,
  minimumClassDenominator = 100,
  maximumHalfWidth = 0.1
}) {
  const spec = POLICIES[policy];
  if (spec === undefined) throw new Error(`unknown policy ${policy}`);

  const usableCases = Math.round(plannedCases * usableRate);
  const missing = spec.admitsIndeterminate ? Math.round(plannedCases * indeterminateRate) : 0;
  const matrix = confusionMatrix({ usableCases, prevalence, recall, specificity });
  const denominators = classDenominators({ usableCases, prevalence, recall, specificity });
  const bounds = boundsOverAssignments(matrix, missing, { referenceKnown: referenceKnownForMissing });

  const failingFloors = CLASS_DENOMINATORS.filter((c) => denominators[c] < minimumClassDenominator);
  const rates = Object.entries(bounds).filter(([, b]) => b !== null);
  const widest = rates.reduce((a, b) => (b[1].totalHalfWidth > a[1].totalHalfWidth ? b : a));
  const allWidthsClear = rates.every(([, b]) => b.totalHalfWidth <= maximumHalfWidth);

  // A's rule is not a width question: it publishes only when nothing was
  // censored at all, so a usable rate below 1 means no study.
  const allOrNothingUnsatisfiedAt = spec.allOrNothing && usableRate < 1 ? usableRate : null;

  return {
    policy: spec,
    plannedCases,
    usableCases,
    indeterminate: missing,
    matrix,
    denominators,
    bounds,
    widestRate: widest[0],
    widestHalfWidth: widest[1].totalHalfWidth,
    failingFloors,
    publishable: failingFloors.length === 0 && allWidthsClear && allOrNothingUnsatisfiedAt === null,
    allOrNothingUnsatisfiedAt
  };
}

function requireUnit(value, name) {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name} must be a probability in [0,1]`);
  }
}
