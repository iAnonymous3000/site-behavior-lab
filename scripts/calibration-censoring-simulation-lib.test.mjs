import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CLASS_DENOMINATORS,
  METRIC_DENOMINATOR,
  POLICIES,
  RATE_CELLS,
  WORST_CASE_COMPOSITION_MODES,
  boundsOverAssignments,
  classDenominators,
  confusionMatrix,
  extremalMatrices,
  allocateMissing,
  denominatorsFromMatrix,
  matrixTotal,
  rateFrom,
  worstComposition,
  simulatePolicy,
  wilsonHalfWidth
} from "./calibration-censoring-simulation-lib.mjs";

const ARM = { prevalence: 0.5, recall: 0.9, specificity: 0.95 };

test("the matrix conserves the planned frame exactly", () => {
  // REGRESSION. Rounding each cell independently over-counted every frame
  // checked by one, so a 310-case study carried a 311-case matrix.
  for (const usableCases of [199, 200, 221, 310, 311, 313, 317, 443]) {
    const matrix = confusionMatrix({ usableCases, ...ARM });
    assert.equal(matrixTotal(matrix), usableCases, `matrix must total ${usableCases}`);
    for (const cell of ["tp", "fn", "tn", "fp"]) {
      assert.ok(Number.isInteger(matrix[cell]) && matrix[cell] >= 0, `${cell} must be a count`);
    }
  }
});

test("C represents the whole admitted frame, not just its scoreable part", () => {
  // REGRESSION. C claims to retain every bare-load-valid case, but was passed
  // scoreable + indeterminate rates summing to 60/61, so at N=350 only 344
  // cases were represented in a study claiming 350.
  const result = simulatePolicy({
    policy: "bounded-censoring-with-sensitivity-analysis",
    plannedCases: 350, scoreableRate: 54 / 61, admittedRate: 1, ...ARM
  });
  assert.equal(result.representedCases, 350, "every admitted case must be represented");
  assert.equal(result.usableCases + result.missingCases, 350);
  assert.equal(
    result.missing.missingReferencePresent + result.missing.missingReferenceAbsent + result.missing.missingBoth,
    result.missingCases,
    "every missing case must be assigned a constraint class"
  );
  assert.throws(
    () => simulatePolicy({
      policy: "bounded-censoring-with-sensitivity-analysis",
      plannedCases: 350, scoreableRate: 0.9, admittedRate: 0.5, ...ARM
    }),
    /admittedRate cannot be below scoreableRate/
  );
});

test("known and unknown reference classes bound STRICTLY differently", () => {
  // REGRESSION. A boolean `referenceKnown` had two branches that enumerated the
  // SAME four cells, so it did nothing -- and the old test allowed equality, so
  // it protected the bug. An unconstrained case must bound strictly worse.
  const matrix = confusionMatrix({ usableCases: 310, ...ARM });
  const known = boundsOverAssignments(matrix, { missingReferencePresent: 20, missingReferenceAbsent: 20 });
  const unknown = boundsOverAssignments(matrix, { missingBoth: 40 });
  assert.ok(
    unknown.sensitivity.totalHalfWidth > known.sensitivity.totalHalfWidth + 1e-6,
    "an unconstrained case must bound STRICTLY worse, not merely no better"
  );
  // A reference-present case can only reach TP or FN, never the negative row.
  for (const { matrix: candidate } of extremalMatrices(matrix, { missingReferencePresent: 20 })) {
    assert.equal(candidate.tn, matrix.tn, "a known-present case cannot land in TN");
    assert.equal(candidate.fp, matrix.fp, "a known-present case cannot land in FP");
  }
});

test("bounds are a Wilson envelope, not a half-range plus a half-width", () => {
  // REGRESSION. Adding the assignment half-range to a worst-case sampling
  // half-width is neither a Wilson interval nor a bound on one. Each assignment
  // gets its own interval; the envelope is min lower to max upper.
  const matrix = confusionMatrix({ usableCases: 310, ...ARM });
  const bounds = boundsOverAssignments(matrix, { missingBoth: 40 });
  for (const [rateId, bound] of Object.entries(bounds)) {
    assert.ok(bound.lower >= 0 && bound.upper <= 1, `${rateId} envelope must stay in [0,1]`);
    assert.ok(bound.upper > bound.lower, `${rateId} envelope must be non-degenerate`);
    assert.ok(
      Math.abs(bound.totalHalfWidth - (bound.upper - bound.lower) / 2) < 1e-9,
      `${rateId} half-width must be derived from the envelope itself`
    );
    // Every realizable assignment's point estimate must lie inside the envelope.
    for (const { matrix: candidate } of extremalMatrices(matrix, { missingBoth: 40 })) {
      const point = rateFrom(candidate, rateId);
      if (point === null) continue;
      assert.ok(
        point >= bound.lower - 1e-9 && point <= bound.upper + 1e-9,
        `${rateId}: assignment estimate ${point} escaped its own envelope`
      );
    }
  }
});

test("numerical eligibility is not publishability", () => {
  // REGRESSION. B could report publishable while its own inferenceScope said
  // only subpopulation inference was justified.
  const b = simulatePolicy({
    policy: "detector-scoped-complete-case", plannedCases: 350, scoreableRate: 54 / 61, ...ARM
  });
  assert.equal(b.numericallyEligible, true, "the floors and widths do clear");
  assert.equal(b.inferenceScopeResolved, false, "but the population was never predefined");
  assert.equal(b.publishable, false, "so no target-population rate may be published");

  const declared = simulatePolicy({
    policy: "detector-scoped-complete-case", plannedCases: 350, scoreableRate: 54 / 61,
    populationPredefinedByScreening: true, ...ARM
  });
  assert.equal(declared.publishable, true, "declaring the screening population resolves it");

  // A target-population policy needs no such declaration.
  const c = simulatePolicy({
    policy: "bounded-censoring-with-sensitivity-analysis",
    plannedCases: 350, scoreableRate: 54 / 61, admittedRate: 1, ...ARM
  });
  assert.equal(c.inferenceScopeResolved, true);
});

test("only the bounded policy carries the unscoreable remainder", () => {
  // A and B analyse only complete cases, so an admittedRate above their
  // scoreable rate must not silently enlarge their study.
  const common = {
    plannedCases: 350, scoreableRate: 0.885, admittedRate: 1,
    prevalence: 0.5, recall: 0.7, specificity: 0.95
  };
  const a = simulatePolicy({ ...common, policy: "zero-censoring" });
  const b = simulatePolicy({ ...common, policy: "detector-scoped-complete-case" });
  const c = simulatePolicy({ ...common, policy: "bounded-censoring-with-sensitivity-analysis" });

  assert.equal(a.missingCases, 0);
  assert.equal(b.missingCases, 0);
  assert.ok(c.missingCases > 0, "C retains the cases the others drop");

  assert.equal(a.representedCases, a.usableCases, "A represents only what it analyses");
  assert.equal(b.representedCases, b.usableCases);
  assert.equal(c.representedCases, 350, "C represents the whole admitted frame");
});

test("zero-censoring reports its all-or-nothing failure separately from width", () => {
  // A's widths are meaningless on their own: it publishes only if the study
  // censored nothing. A usable rate below 1 is no study, not a narrower one,
  // and that is not a width question.
  const result = simulatePolicy({
    policy: "zero-censoring",
    plannedCases: 350, scoreableRate: 0.443,
    prevalence: 0.5, recall: 0.7, specificity: 0.95
  });
  assert.equal(result.allOrNothingUnsatisfiedAt, 0.443);

  const complete = simulatePolicy({
    policy: "zero-censoring",
    plannedCases: 350, scoreableRate: 1,
    prevalence: 0.5, recall: 0.7, specificity: 0.95
  });
  assert.equal(complete.allOrNothingUnsatisfiedAt, null);

  // B never reports it, because it does not make a study-level guarantee.
  assert.equal(
    simulatePolicy({
      policy: "detector-scoped-complete-case",
      plannedCases: 350, scoreableRate: 0.443,
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
    () => simulatePolicy({ policy: "lenient", plannedCases: 350, scoreableRate: 1, prevalence: 0.5, recall: 0.7, specificity: 0.95 }),
    /unknown policy/
  );
  assert.throws(
    () => simulatePolicy({ policy: "zero-censoring", plannedCases: 350, scoreableRate: 1, prevalence: 1.4, recall: 0.7, specificity: 0.95 }),
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

test("a declared share of zero allocates exactly zero", () => {
  // REGRESSION. `missingReferenceSplit.both` was never read: present and absent
  // were floored and `both` took the remainder, so a declared {.5,.5,0} over 57
  // cases produced 28/28/1 -- contradicting the zero it was given.
  const odd = allocateMissing(57, { present: 0.5, absent: 0.5, both: 0 });
  assert.equal(odd.missingBoth, 0, "a declared both:0 must allocate zero");
  assert.equal(odd.missingReferencePresent + odd.missingReferenceAbsent, 57);

  // Odd counts still conserve, for every count and both parities.
  for (const missing of [0, 1, 2, 3, 15, 40, 57, 58, 99]) {
    for (const split of [
      { present: 0.5, absent: 0.5, both: 0 },
      { present: 0, absent: 0, both: 1 },
      { present: 1, absent: 0, both: 0 },
      { present: 1 / 3, absent: 1 / 3, both: 1 / 3 }
    ]) {
      const allocated = allocateMissing(missing, split);
      const total = Object.values(allocated).reduce((a, b) => a + b, 0);
      assert.equal(total, missing, `${missing} under ${JSON.stringify(split)} must conserve`);
      for (const [key, share] of [["missingReferencePresent", split.present], ["missingReferenceAbsent", split.absent], ["missingBoth", split.both]]) {
        if (share === 0) assert.equal(allocated[key], 0, `${key} declared 0 must stay 0`);
      }
    }
  }

  assert.throws(() => allocateMissing(10, { present: 0.5, absent: 0.4, both: 0 }), /must sum to 1/);
});

test("the worst composition is found exhaustively, not from sampled corners", () => {
  // REGRESSION. Checking all-present / all-absent / balanced is not "worst
  // realizable": at 100 usable, 15 missing, prevalence .2, recall .5,
  // specificity .95 the maximum sits at ONE reference-present case, which all
  // three sampled corners miss.
  const matrix = confusionMatrix({ usableCases: 100, prevalence: 0.2, recall: 0.5, specificity: 0.95 });
  const worst = worstComposition(matrix, 15, { allowUnknownReference: false });

  const cornerWidth = (present) => {
    const bounds = boundsOverAssignments(matrix, {
      missingReferencePresent: present, missingReferenceAbsent: 15 - present, missingBoth: 0
    });
    return Math.max(...Object.values(bounds).filter(Boolean).map((b) => b.totalHalfWidth));
  };
  const sampledCorners = Math.max(cornerWidth(0), cornerWidth(15), cornerWidth(7));
  assert.ok(
    worst.widestHalfWidth > sampledCorners,
    "the exhaustive maximum must exceed what the three sampled corners find"
  );
  assert.equal(worst.missing.missingBoth, 0, "references obtained means no case lacks one");

  // No composition anywhere may exceed the reported worst.
  for (let present = 0; present <= 15; present++) {
    assert.ok(cornerWidth(present) <= worst.widestHalfWidth + 1e-12, `present=${present} escaped the worst case`);
  }
});

test("an obtained reference cannot be missing", () => {
  const matrix = confusionMatrix({ usableCases: 310, prevalence: 0.5, recall: 0.9, specificity: 0.95 });
  const obtained = worstComposition(matrix, 40, { allowUnknownReference: false });
  assert.equal(obtained.missing.missingBoth, 0);
  const unknown = worstComposition(matrix, 40, { allowUnknownReference: true });
  assert.ok(
    unknown.widestHalfWidth >= obtained.widestHalfWidth,
    "allowing unknown references can only widen the envelope"
  );
});

test("floors are read off the conserved matrix, not recomputed", () => {
  // REGRESSION. Expected margins recomputed from fractions disagreed with the
  // matrix by one at several operating points, always fail-open.
  for (const usableCases of [199, 221, 313, 443]) {
    const point = { prevalence: 0.5, recall: 0.9, specificity: 0.95 };
    const matrix = confusionMatrix({ usableCases, ...point });
    const fromMatrix = denominatorsFromMatrix(matrix);
    const result = simulatePolicy({
      policy: "detector-scoped-complete-case", plannedCases: usableCases, scoreableRate: 1, ...point
    });
    assert.deepEqual(result.denominators, fromMatrix, `n=${usableCases} floors must match the matrix`);
    assert.equal(
      fromMatrix.referencePresent + fromMatrix.referenceAbsent,
      matrixTotal(matrix),
      "the reference partition must cover the matrix"
    );
    assert.equal(
      fromMatrix.predictedDetected + fromMatrix.predictedNotDetected,
      matrixTotal(matrix),
      "the prediction partition must cover the matrix"
    );
  }
});

test("worstCaseComposition is a validated enum, never a truthy flag", () => {
  // REGRESSION. The mode was compared with === "including-unknown-reference",
  // so ANY other truthy value -- `true`, or a misspelling of the conservative
  // mode itself -- silently selected the NARROWER references-obtained model. A
  // typo therefore bought better-looking evidence, which is the one direction a
  // default must never fail.
  const base = {
    policy: "bounded-censoring-with-sensitivity-analysis",
    plannedCases: 350, scoreableRate: 54 / 61, admittedRate: 1,
    prevalence: 0.5, recall: 0.9, specificity: 0.95
  };

  for (const bad of ["typo", true, "References-Obtained", "including-unknown-references", null, 1, {}]) {
    assert.throws(
      () => simulatePolicy({ ...base, worstCaseComposition: bad }),
      /worstCaseComposition must be one of/,
      `${JSON.stringify(bad)} must be rejected, not resolved to a model`
    );
  }

  // The three accepted values, and the direction each one means.
  const conservative = simulatePolicy({ ...base, worstCaseComposition: "including-unknown-reference" });
  const obtained = simulatePolicy({ ...base, worstCaseComposition: "references-obtained" });
  assert.ok(conservative.missing.missingBoth > 0, "the conservative mode admits missing references");
  assert.equal(obtained.missing.missingBoth, 0, "references-obtained admits none");
  assert.ok(
    conservative.widestHalfWidth >= obtained.widestHalfWidth,
    "the conservative mode can never bound tighter than the narrower one"
  );

  // false uses the declared split rather than searching at all.
  const declared = simulatePolicy({
    ...base, worstCaseComposition: false, missingReferenceSplit: { present: 1, absent: 0, both: 0 }
  });
  assert.equal(declared.missing.missingReferencePresent, declared.missingCases);
  assert.deepEqual(
    [...WORST_CASE_COMPOSITION_MODES].sort(),
    [false, "including-unknown-reference", "references-obtained"].sort()
  );
});

test("the allow-list itself cannot be widened at runtime", () => {
  // REGRESSION. The enum was Object.freeze(new Set([...])), which does NOT stop
  // Set.add -- that mutates internal slots, not properties. So the allow-list
  // was mutable: any code could add "typo" and the validation would then accept
  // it, silently selecting a model the author never approved. A frozen ARRAY
  // makes push throw, which is what closes the list.
  assert.ok(Array.isArray(WORST_CASE_COMPOSITION_MODES), "must be an array, not a Set");
  assert.ok(Object.isFrozen(WORST_CASE_COMPOSITION_MODES));
  assert.throws(() => WORST_CASE_COMPOSITION_MODES.push("typo"), TypeError);
  assert.equal(WORST_CASE_COMPOSITION_MODES.includes("typo"), false);

  // And the validation still rejects it after the attempt.
  assert.throws(
    () => simulatePolicy({
      policy: "bounded-censoring-with-sensitivity-analysis",
      plannedCases: 350, scoreableRate: 54 / 61, admittedRate: 1,
      prevalence: 0.5, recall: 0.9, specificity: 0.95,
      worstCaseComposition: "typo"
    }),
    /worstCaseComposition must be one of/
  );
});
