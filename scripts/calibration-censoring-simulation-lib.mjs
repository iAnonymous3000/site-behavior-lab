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

/**
 * The expected 2x2 at an operating point, with CONSERVED row totals.
 *
 * Rounding each cell independently does not conserve: a 310-case frame produced
 * a matrix totalling 311 for every operating point checked. Each row is now
 * rounded once and its partner takes the remainder, so
 * `tp+fn+tn+fp === usableCases` exactly.
 */
export function confusionMatrix({ usableCases, prevalence, recall, specificity }) {
  requireUnit(prevalence, "prevalence");
  requireUnit(recall, "recall");
  requireUnit(specificity, "specificity");
  const positives = Math.round(usableCases * prevalence);
  const negatives = usableCases - positives;
  const tp = Math.round(recall * positives);
  const tn = Math.round(specificity * negatives);
  return { tp, fn: positives - tp, tn, fp: negatives - tn };
}

const sum = (matrix, cells) => cells.reduce((total, cell) => total + matrix[cell], 0);
export const matrixTotal = (matrix) => matrix.tp + matrix.fn + matrix.tn + matrix.fp;

/**
 * The four class denominators, read straight off the conserved matrix.
 *
 * `classDenominators` recomputes them from fractional expectations and can
 * disagree with the matrix by one -- it reported referenceAbsent 100 where the
 * matrix held 99, so a floor passed on a class that was actually short. Floors
 * and intervals must come from the SAME cells.
 */
export function denominatorsFromMatrix(matrix) {
  return {
    referencePresent: matrix.tp + matrix.fn,
    referenceAbsent: matrix.tn + matrix.fp,
    predictedDetected: matrix.tp + matrix.fp,
    predictedNotDetected: matrix.tn + matrix.fn
  };
}

export function rateFrom(matrix, rateId) {
  const spec = RATE_CELLS[rateId];
  if (spec === undefined) throw new Error(`unknown rate ${rateId}`);
  const denominator = sum(matrix, spec.denominator);
  if (denominator === 0) return null;
  return sum(matrix, spec.numerator) / denominator;
}

export function wilsonInterval(k, n, z = 1.96) {
  if (!Number.isFinite(n) || n <= 0) return { lo: 0, hi: 1 };
  const p = k / n, d = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / d;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return { lo: Math.max(0, centre - half), hi: Math.min(1, centre + half) };
}

/**
 * Every corner assignment of the missing cases.
 *
 * A boolean `referenceKnown` was not enough, and worse, its two branches
 * enumerated the SAME four cells -- so known and unknown produced identical
 * rows and the flag did nothing. The model needs COUNTS:
 *
 *  - `missingReferencePresent`: prediction missing, reference known present.
 *    Can only land in TP or FN.
 *  - `missingReferenceAbsent`: reference known absent. Only TN or FP.
 *  - `missingBoth`: unconstrained, any of the four cells.
 *
 * Each rate is monotone in each cell, so the extremes are attained at corners
 * and this enumeration is an exact envelope rather than an approximation.
 */
export function extremalMatrices(matrix, { missingReferencePresent = 0, missingReferenceAbsent = 0, missingBoth = 0 } = {}) {
  const presentTargets = missingReferencePresent > 0 ? ["tp", "fn"] : [null];
  const absentTargets = missingReferenceAbsent > 0 ? ["tn", "fp"] : [null];
  const bothTargets = missingBoth > 0 ? ["tp", "fn", "tn", "fp"] : [null];

  const results = [];
  for (const p of presentTargets) {
    for (const a of absentTargets) {
      for (const b of bothTargets) {
        const candidate = { ...matrix };
        if (p) candidate[p] += missingReferencePresent;
        if (a) candidate[a] += missingReferenceAbsent;
        if (b) candidate[b] += missingBoth;
        results.push({ label: `present->${p ?? "-"} absent->${a ?? "-"} both->${b ?? "-"}`, matrix: candidate });
      }
    }
  }
  return results;
}

/**
 * Outer Wilson envelope over every realizable assignment.
 *
 * NOT the assignment half-range plus a worst-case sampling half-width -- adding
 * those is neither a Wilson interval nor a bound on one, and it reported 17.3%
 * with precision binding where the true envelope is 13.9% with sensitivity
 * binding. Each assignment gets its own Wilson interval on its own denominator;
 * the envelope is the min lower bound and the max upper bound across all of them.
 */
export function boundsOverAssignments(matrix, missing = {}) {
  const assignments = extremalMatrices(matrix, missing);
  const bounds = {};
  for (const rateId of Object.keys(RATE_CELLS)) {
    let lo = Infinity, hi = -Infinity, smallestDenominator = Infinity, observedDenominator = null;
    for (const { matrix: candidate } of assignments) {
      const spec = RATE_CELLS[rateId];
      const denominator = sum(candidate, spec.denominator);
      if (denominator === 0) continue;
      const interval = wilsonInterval(sum(candidate, spec.numerator), denominator);
      lo = Math.min(lo, interval.lo);
      hi = Math.max(hi, interval.hi);
      smallestDenominator = Math.min(smallestDenominator, denominator);
    }
    observedDenominator = sum(matrix, RATE_CELLS[rateId].denominator);
    if (lo === Infinity) { bounds[rateId] = null; continue; }
    bounds[rateId] = {
      observedDenominator,
      smallestDenominator,
      lower: lo,
      upper: hi,
      totalHalfWidth: (hi - lo) / 2
    };
  }
  return bounds;
}

/**
 * One policy at one planned N.
 *
 * FRAME CONSERVATION. C claims to retain every bare-load-valid case, so its
 * missing count is `admittedRate - scoreableRate`, taken from the WHOLE admitted
 * frame. An earlier version passed scoreable and indeterminate rates that summed
 * to 60/61, silently dropping the stage-incomplete case, so at N=350 only 344
 * cases were represented in a study that claimed 350.
 *
 * ELIGIBILITY IS NOT PUBLISHABILITY. `numericallyEligible` means the floors and
 * the widths clear. It is deliberately NOT called publishable, because a policy
 * whose `inferenceScope` admits only subpopulation inference cannot publish a
 * target-population rate however narrow its interval is. `publishable` requires
 * an explicit preregistered population decision on top.
 */
export function simulatePolicy({
  policy,
  plannedCases,
  scoreableRate,
  admittedRate = scoreableRate,
  // CONSERVATIVE BY DEFAULT: assume nothing is known about a missing case's
  // reference class. Assuming the reference is known narrows the envelope by
  // ~4.5 points here, which is a modelling claim, not a free choice. For CNAME
  // the reference is an independent DNS resolution that does not depend on the
  // scan, so a study that obtains references for every ADMITTED case may
  // justify the known split -- but it must say so.
  missingReferenceSplit = { present: 0, absent: 0, both: 1 },
  prevalence,
  recall,
  specificity,
  populationPredefinedByScreening = false,
  minimumClassDenominator = 100,
  maximumHalfWidth = 0.1
}) {
  const spec = POLICIES[policy];
  if (spec === undefined) throw new Error(`unknown policy ${policy}`);

  const usableCases = Math.round(plannedCases * scoreableRate);
  // Only C carries the unscoreable remainder of the admitted frame.
  const missingCases = spec.admitsIndeterminate
    ? Math.round(plannedCases * admittedRate) - usableCases
    : 0;
  if (missingCases < 0) throw new Error("admittedRate cannot be below scoreableRate");

  const matrix = confusionMatrix({ usableCases, prevalence, recall, specificity });
  if (matrixTotal(matrix) !== usableCases) {
    throw new Error(`matrix total ${matrixTotal(matrix)} does not conserve ${usableCases} usable cases`);
  }

  // Conserve exactly. Rounding both halves of a 57-case split gave 29+29 and a
  // missingBoth of -1, which extremalMatrices silently dropped -- so every
  // matrix carried 58 extra cases while representedCases reported 57. Floor
  // both named shares so the remainder is never negative, and assert the sum.
  const present = Math.floor(missingCases * missingReferenceSplit.present);
  const absent = Math.floor(missingCases * missingReferenceSplit.absent);
  const missing = {
    missingReferencePresent: present,
    missingReferenceAbsent: absent,
    missingBoth: missingCases - present - absent
  };
  for (const [key, value] of Object.entries(missing)) {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`${key} must be a non-negative integer, got ${value}`);
    }
  }
  if (missing.missingReferencePresent + missing.missingReferenceAbsent + missing.missingBoth !== missingCases) {
    throw new Error("missing-case split does not conserve the missing cases");
  }

  const denominators = denominatorsFromMatrix(matrix);
  const bounds = boundsOverAssignments(matrix, missing);

  // Every enumerated assignment must place exactly the missing cases.
  for (const { label, matrix: candidate } of extremalMatrices(matrix, missing)) {
    if (matrixTotal(candidate) !== usableCases + missingCases) {
      throw new Error(
        `assignment ${label} totals ${matrixTotal(candidate)}, not ${usableCases + missingCases}`
      );
    }
  }

  const failingFloors = CLASS_DENOMINATORS.filter((c) => denominators[c] < minimumClassDenominator);
  const rates = Object.entries(bounds).filter(([, b]) => b !== null);
  const widest = rates.reduce((a, b) => (b[1].totalHalfWidth > a[1].totalHalfWidth ? b : a));
  const allWidthsClear = rates.every(([, b]) => b.totalHalfWidth <= maximumHalfWidth);

  const allOrNothingUnsatisfiedAt = spec.allOrNothing && scoreableRate < 1 ? scoreableRate : null;
  const numericallyEligible =
    failingFloors.length === 0 && allWidthsClear && allOrNothingUnsatisfiedAt === null;

  // A scoreable-subpopulation policy needs the population declared before
  // sampling before any target-population rate may be published.
  const inferenceScopeResolved =
    spec.inferenceScope === "target-population" || populationPredefinedByScreening;

  return {
    policy: spec,
    plannedCases,
    usableCases,
    missingCases,
    representedCases: usableCases + missingCases,
    matrix,
    missing,
    denominators,
    bounds,
    widestRate: widest[0],
    widestHalfWidth: widest[1].totalHalfWidth,
    failingFloors,
    numericallyEligible,
    inferenceScopeResolved,
    publishable: numericallyEligible && inferenceScopeResolved,
    allOrNothingUnsatisfiedAt
  };
}

function requireUnit(value, name) {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name} must be a probability in [0,1]`);
  }
}
