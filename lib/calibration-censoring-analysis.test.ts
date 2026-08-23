import assert from "node:assert/strict";
import { test } from "node:test";
import { wilson95 } from "./detector-calibration";
import {
  CENSORING_ANALYSIS_VERSION,
  CENSORING_RATE_IDS,
  MAX_ENVELOPE_ASSIGNMENTS,
  analyzeCensoring,
  censoringCasesFromStudyV3Rows,
  evaluatePublication,
  type CensoringAnalysisCase,
  type CensoringRateId
} from "./calibration-censoring-analysis";

let nextId = 0;
const id = () => `case-${(nextId += 1)}`;
const scored = (
  reference: "present" | "absent",
  prediction: "detected" | "not-detected"
): CensoringAnalysisCase => ({ caseId: id(), kind: "scored", reference, prediction });
const refUnknown = (prediction: "detected" | "not-detected"): CensoringAnalysisCase => ({
  caseId: id(),
  kind: "reference-unknown",
  prediction
});
const predUnknown = (reference: "present" | "absent"): CensoringAnalysisCase => ({
  caseId: id(),
  kind: "prediction-unknown",
  reference
});
const bothUnknown = (): CensoringAnalysisCase => ({ caseId: id(), kind: "both-unknown" });

function repeat(count: number, make: () => CensoringAnalysisCase): CensoringAnalysisCase[] {
  return Array.from({ length: count }, make);
}

function analyze(cases: CensoringAnalysisCase[]) {
  return analyzeCensoring({ plannedCases: cases.length, cases });
}

test("conservation and fatality refuse the analysis rather than degrading it", () => {
  const cases = [scored("present", "detected"), scored("absent", "not-detected")];
  assert.throws(
    () => analyzeCensoring({ plannedCases: 3, cases }),
    /conservation failure: 2 cases accounted against 3 planned/
  );
  assert.throws(
    () =>
      analyzeCensoring({
        plannedCases: 3,
        cases: [...cases, { caseId: id(), kind: "fatal", violation: "custody chain broken" }]
      }),
    /fatal integrity violation .* never converted into censoring/
  );
  const duplicate = scored("present", "detected");
  assert.throws(
    () => analyzeCensoring({ plannedCases: 2, cases: [duplicate, duplicate] }),
    /duplicate case/
  );
});

test("a fully scored study's envelope collapses to the point Wilson interval", () => {
  const cases = [
    ...repeat(30, () => scored("present", "detected")),
    ...repeat(5, () => scored("present", "not-detected")),
    ...repeat(40, () => scored("absent", "not-detected")),
    ...repeat(4, () => scored("absent", "detected"))
  ];
  const analysis = analyze(cases);
  assert.equal(analysis.analysisVersion, CENSORING_ANALYSIS_VERSION);
  assert.equal(analysis.policyC.assignmentsEnumerated, 1);

  const sensitivity = analysis.policyC.rates.sensitivity;
  const reference = wilson95(30, 35);
  assert.equal(sensitivity.estimateMin, 30 / 35);
  assert.equal(sensitivity.estimateMax, 30 / 35);
  assert.equal(sensitivity.intervalLower, reference.lower);
  assert.equal(sensitivity.intervalUpper, reference.upper);
  assert.equal(sensitivity.denominatorCanBeEmpty, false);

  // And policy B agrees exactly on a fully scored study.
  assert.deepEqual(analysis.policyB.cells, { tp: 30, fp: 4, tn: 40, fn: 5 });
  assert.equal(analysis.policyB.rates.sensitivity.interval95?.lower, reference.lower);
});

test("the composition enumeration equals brute-force per-row assignment", () => {
  // The analyzer enumerates integer compositions of the unknown CLASSES; the
  // straightforward-but-exponential ground truth assigns every unknown ROW
  // independently. Rates depend only on cell counts, so the two must agree
  // exactly; this is the equivalence proof for the reduction.
  const cases = [
    ...repeat(6, () => scored("present", "detected")),
    ...repeat(2, () => scored("present", "not-detected")),
    ...repeat(5, () => scored("absent", "not-detected")),
    ...repeat(1, () => scored("absent", "detected")),
    refUnknown("detected"),
    refUnknown("not-detected"),
    predUnknown("present"),
    bothUnknown(),
    bothUnknown()
  ];
  const analysis = analyze(cases);

  type Cells = { tp: number; fp: number; tn: number; fn: number };
  const rateOf = (rate: CensoringRateId, c: Cells): [number, number] => {
    switch (rate) {
      case "sensitivity":
        return [c.tp, c.tp + c.fn];
      case "specificity":
        return [c.tn, c.tn + c.fp];
      case "precision":
        return [c.tp, c.tp + c.fp];
      case "negativePredictiveValue":
        return [c.tn, c.tn + c.fn];
      case "accuracy":
        return [c.tp + c.tn, c.tp + c.fp + c.tn + c.fn];
      case "falsePositiveRate":
        return [c.fp, c.fp + c.tn];
      case "falseNegativeRate":
        return [c.fn, c.fn + c.tp];
    }
  };

  const rows = cases.filter((entry) => entry.kind !== "scored");
  const base: Cells = { tp: 6, fp: 1, tn: 5, fn: 2 };
  const best = new Map<
    CensoringRateId,
    { lower: number; upper: number; estimateMin: number; estimateMax: number; empty: boolean }
  >();
  const walk = (index: number, cells: Cells) => {
    if (index === rows.length) {
      for (const rate of CENSORING_RATE_IDS) {
        const [numerator, denominator] = rateOf(rate, cells);
        const entry =
          best.get(rate) ??
          ({ lower: Infinity, upper: -Infinity, estimateMin: Infinity, estimateMax: -Infinity, empty: false } as {
            lower: number;
            upper: number;
            estimateMin: number;
            estimateMax: number;
            empty: boolean;
          });
        if (denominator === 0) entry.empty = true;
        else {
          const interval = wilson95(numerator, denominator);
          entry.lower = Math.min(entry.lower, interval.lower);
          entry.upper = Math.max(entry.upper, interval.upper);
          entry.estimateMin = Math.min(entry.estimateMin, numerator / denominator);
          entry.estimateMax = Math.max(entry.estimateMax, numerator / denominator);
        }
        best.set(rate, entry);
      }
      return;
    }
    const row = rows[index];
    const options: Array<keyof Cells> =
      row.kind === "reference-unknown"
        ? row.prediction === "detected"
          ? ["tp", "fp"]
          : ["fn", "tn"]
        : row.kind === "prediction-unknown"
          ? row.reference === "present"
            ? ["tp", "fn"]
            : ["fp", "tn"]
          : ["tp", "fp", "tn", "fn"];
    for (const cell of options) {
      walk(index + 1, { ...cells, [cell]: cells[cell] + 1 });
    }
  };
  walk(0, base);

  for (const rate of CENSORING_RATE_IDS) {
    const envelope = analysis.policyC.rates[rate];
    const truth = best.get(rate)!;
    assert.equal(envelope.denominatorCanBeEmpty, truth.empty, `${rate} empty flag`);
    assert.equal(envelope.intervalLower, truth.lower, `${rate} lower`);
    assert.equal(envelope.intervalUpper, truth.upper, `${rate} upper`);
    assert.equal(envelope.estimateMin, truth.estimateMin, `${rate} estimate min`);
    assert.equal(envelope.estimateMax, truth.estimateMax, `${rate} estimate max`);
  }
});

test("adding an unknown case can only widen the envelope, never narrow it", () => {
  const base = [
    ...repeat(20, () => scored("present", "detected")),
    ...repeat(3, () => scored("present", "not-detected")),
    ...repeat(20, () => scored("absent", "not-detected")),
    ...repeat(2, () => scored("absent", "detected"))
  ];
  const before = analyze(base);
  for (const extra of [refUnknown("detected"), predUnknown("absent"), bothUnknown()]) {
    const after = analyze([...base, extra]);
    for (const rate of CENSORING_RATE_IDS) {
      const b = before.policyC.rates[rate];
      const a = after.policyC.rates[rate];
      assert.ok(
        a.intervalLower! <= b.intervalLower! + 1e-12,
        `${rate} lower narrowed after adding ${extra.kind}`
      );
      assert.ok(
        a.intervalUpper! >= b.intervalUpper! - 1e-12,
        `${rate} upper narrowed after adding ${extra.kind}`
      );
    }
  }
});

test("an uncertain reference never strengthens a margin: uncertainty cannot become absence", () => {
  const cases = [
    ...repeat(10, () => scored("present", "detected")),
    ...repeat(10, () => scored("absent", "not-detected")),
    refUnknown("detected"),
    refUnknown("not-detected")
  ];
  const analysis = analyze(cases);
  // The two reference-unknown rows are proven members of PREDICTION margins
  // only; neither reference margin may count them.
  assert.deepEqual(analysis.policyC.guaranteedMargins, {
    referencePresent: 10,
    referenceAbsent: 10,
    predictedDetected: 11,
    predictedNotDetected: 11
  });
});

test("a realizable empty denominator disables the width claim for that rate", () => {
  // No scored absent case at all: under the assignment sending the unknown to
  // TP, specificity's denominator is empty. The rate must say so rather than
  // quoting a width from the assignments that happen to populate it.
  const analysis = analyze([
    ...repeat(5, () => scored("present", "detected")),
    refUnknown("detected")
  ]);
  assert.equal(analysis.policyC.rates.specificity.denominatorCanBeEmpty, true);
  assert.equal(analysis.policyC.rates.specificity.envelopeHalfWidth, null);
  assert.equal(analysis.policyC.rates.sensitivity.denominatorCanBeEmpty, false);
});

test("the enumeration ceiling refuses loudly instead of approximating", () => {
  // C(253, 3) = 2,667,126 realizable compositions, past the 2,000,000 cap.
  const cases = [
    ...repeat(2, () => scored("present", "detected")),
    ...repeat(250, () => bothUnknown())
  ];
  assert.throws(
    () => analyze(cases),
    (error: Error) =>
      /beyond the 2000000 exhaustive-enumeration ceiling/.test(error.message) &&
      /never approximate silently/.test(error.message)
  );
  assert.equal(MAX_ENVELOPE_ASSIGNMENTS, 2_000_000);
});

test("policy B is scope-tagged, coverage-accounted, and can never satisfy the gate", () => {
  const cases = [
    ...repeat(8, () => scored("present", "detected")),
    ...repeat(8, () => scored("absent", "not-detected")),
    refUnknown("detected"),
    predUnknown("present"),
    bothUnknown()
  ];
  const analysis = analyze(cases);
  assert.equal(analysis.policyB.inferenceScope, "scoreable-subpopulation");
  assert.equal(analysis.policyB.canSatisfyPublicationGate, false);
  assert.deepEqual(analysis.policyB.coverage, {
    plannedCases: 19,
    analyzedCases: 16,
    referenceUnknown: 1,
    predictionUnknown: 1,
    bothUnknown: 1
  });
});

test("the publication gate reads policy C only; a narrow B cannot rescue a wide C", () => {
  // Heavily censored: B's complete cases give a tight interval, C's envelope
  // is wide. The decision's B-never-rescues-C rule means the verdict is C's.
  const cases = [
    ...repeat(120, () => scored("present", "detected")),
    ...repeat(120, () => scored("absent", "not-detected")),
    ...repeat(30, () => bothUnknown())
  ];
  const analysis = analyze(cases);
  const profile = {
    claimedClasses: [
      "reference-present",
      "reference-absent",
      "predicted-detected",
      "predicted-not-detected"
    ] as const,
    minimumPerClaimedClass: 100,
    maxWorstCaseHalfWidth: 0.1,
    claimedRates: ["sensitivity", "specificity"] as const
  };
  // B alone would look publishable: its own sensitivity interval is narrow.
  const bInterval = analysis.policyB.rates.sensitivity.interval95!;
  assert.ok((bInterval.upper - bInterval.lower) / 2 < 0.1);
  // The gate still fails, from C's envelope.
  const verdict = evaluatePublication(analysis, profile);
  assert.equal(verdict.publishable, false);
  assert.ok(verdict.problems.some((problem) => /envelope half-width/.test(problem)));
});

test("the sensitivity-only profile makes no absent-class demand", () => {
  // Synthetic-positive keystroke shape: everything reference-present.
  const cases = [
    ...repeat(110, () => scored("present", "detected")),
    ...repeat(10, () => scored("present", "not-detected"))
  ];
  const analysis = analyze(cases);
  const verdict = evaluatePublication(analysis, {
    claimedClasses: ["reference-present"] as const,
    minimumPerClaimedClass: 100,
    maxWorstCaseHalfWidth: 0.1,
    claimedRates: ["sensitivity"] as const
  });
  assert.equal(verdict.publishable, true, verdict.problems.join("; "));

  // The same study under the two-class profile fails on the absent margins,
  // which is exactly why the reframe was needed for option (b).
  const twoClass = evaluatePublication(analysis, {
    claimedClasses: [
      "reference-present",
      "reference-absent",
      "predicted-detected",
      "predicted-not-detected"
    ] as const,
    minimumPerClaimedClass: 100,
    maxWorstCaseHalfWidth: 0.1,
    claimedRates: ["sensitivity"] as const
  });
  assert.equal(twoClass.publishable, false);
  assert.ok(twoClass.problems.some((problem) => /reference-absent has 0 guaranteed members/.test(problem)));
});

test("the v3 projector maps every censored row to both-unknown, inventing nothing", () => {
  const projected = censoringCasesFromStudyV3Rows([
    {
      caseId: "a",
      outcome: "complete",
      prediction: { value: "detected" },
      reference: { value: "present" }
    },
    { caseId: "b", outcome: "censored", reason: "capture-failed" },
    { caseId: "c", outcome: "censored", reason: "reference-label-uncertain" }
  ]);
  assert.deepEqual(projected, [
    { caseId: "a", kind: "scored", reference: "present", prediction: "detected" },
    // A v3 censored row records no prediction, so even reference-label-uncertain
    // cannot become reference-unknown-with-known-prediction until the item-3
    // wire revision exists. The projector must not invent the prediction.
    { caseId: "b", kind: "both-unknown" },
    { caseId: "c", kind: "both-unknown" }
  ]);
});
