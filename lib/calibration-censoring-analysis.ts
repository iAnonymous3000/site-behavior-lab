/**
 * Policy-C and policy-B analysis for detector calibration studies: the
 * analyzer behaviors item 2 of the step-3 censoring decision requires
 * (docs/calibration-censoring-policy-decision.md).
 *
 * DELIBERATELY SELF-CONTAINED. This module is not yet wired into
 * detector-calibration-analysis-v3, the policy artifact, or the readiness
 * binding: wiring changes the candidate-resident artifact bytes and their
 * digests, and the decision record reserves the approval of those exact bytes
 * for a named human AFTER the behaviors exist. What lives here is the
 * behavior, versioned on its own so the later wiring is an integration, not a
 * redefinition.
 *
 * The input domain is a neutral projection of study case rows rather than the
 * study schema itself, because the current v3 wire cannot yet represent a
 * case whose prediction survived while its reference is uncertain (a censored
 * v3 row carries no prediction). The projector for v3 rows below maps every
 * censored row to both-unknown accordingly; the item-3 pipeline work gives
 * the richer kinds their producers.
 *
 * CONSERVATION. Every planned case must be accounted for exactly once, and a
 * fatal integrity violation refuses the whole analysis rather than becoming a
 * censored row: custody, provenance, blinding, identity, and
 * measurement-invariant failures are fatal by the decision's
 * non-negotiable-semantics section, and an analyzer that converted them into
 * censoring would launder them into the envelope.
 */

import { wilson95 } from "./detector-calibration";

export const CENSORING_ANALYSIS_VERSION = "calibration-censoring-analysis-v1";

/**
 * The exhaustive-enumeration ceiling. Envelope computation enumerates every
 * realizable integer composition of the unknown classes across their allowed
 * cells; beyond this many assignments the analyzer REFUSES with the exact
 * count rather than approximating silently. A provably equivalent reduction
 * (per-rate monotone corner search) may raise this later, but only with an
 * equivalence proof in tests, not as a silent substitution.
 */
export const MAX_ENVELOPE_ASSIGNMENTS = 2_000_000;

export type CensoringAnalysisCase =
  | {
      caseId: string;
      kind: "scored";
      reference: "present" | "absent";
      prediction: "detected" | "not-detected";
    }
  | { caseId: string; kind: "reference-unknown"; prediction: "detected" | "not-detected" }
  | { caseId: string; kind: "prediction-unknown"; reference: "present" | "absent" }
  | { caseId: string; kind: "both-unknown" }
  | { caseId: string; kind: "fatal"; violation: string };

export type CensoringRateId =
  | "sensitivity"
  | "specificity"
  | "precision"
  | "negativePredictiveValue"
  | "accuracy"
  | "falsePositiveRate"
  | "falseNegativeRate";

export const CENSORING_RATE_IDS: readonly CensoringRateId[] = [
  "sensitivity",
  "specificity",
  "precision",
  "negativePredictiveValue",
  "accuracy",
  "falsePositiveRate",
  "falseNegativeRate"
];

type Cells = { tp: number; fp: number; tn: number; fn: number };

/**
 * One rate's envelope over every realizable assignment: the lowest Wilson
 * lower bound and the highest Wilson upper bound any assignment produces,
 * plus whether any realizable assignment empties the denominator (in which
 * case no width claim is possible for the rate at all).
 */
export type CensoringRateEnvelope = {
  estimateMin: number | null;
  estimateMax: number | null;
  intervalLower: number | null;
  intervalUpper: number | null;
  /** (intervalUpper - intervalLower) / 2; the width the publication gate reads. */
  envelopeHalfWidth: number | null;
  denominatorCanBeEmpty: boolean;
};

export type PolicyCAnalysis = {
  policy: "bounded-censoring-with-sensitivity-analysis";
  inferenceScope: "declared-population";
  knownCells: Cells;
  unknowns: {
    referenceUnknownPredictedDetected: number;
    referenceUnknownPredictedNotDetected: number;
    predictionUnknownReferencePresent: number;
    predictionUnknownReferenceAbsent: number;
    bothUnknown: number;
  };
  assignmentsEnumerated: number;
  rates: Record<CensoringRateId, CensoringRateEnvelope>;
  /**
   * Class-margin floors: members PROVEN to belong to the margin under every
   * realizable assignment (scored cases plus the one-side-known rows whose
   * known side is the margin). Publication minimums read these, never an
   * optimistic assignment.
   */
  guaranteedMargins: {
    referencePresent: number;
    referenceAbsent: number;
    predictedDetected: number;
    predictedNotDetected: number;
  };
};

export type PolicyBAnalysis = {
  policy: "detector-scoped-complete-case";
  inferenceScope: "scoreable-subpopulation";
  /** A B result can never satisfy the publication gate for a population claim. */
  canSatisfyPublicationGate: false;
  coverage: {
    plannedCases: number;
    analyzedCases: number;
    referenceUnknown: number;
    predictionUnknown: number;
    bothUnknown: number;
  };
  cells: Cells;
  rates: Record<
    CensoringRateId,
    {
      numerator: number;
      denominator: number;
      estimate: number | null;
      interval95: { lower: number; upper: number; method: "wilson-score" } | null;
    }
  >;
};

export type CensoringAnalysis = {
  analysisVersion: typeof CENSORING_ANALYSIS_VERSION;
  plannedCases: number;
  accounted: {
    scored: number;
    referenceUnknown: number;
    predictionUnknown: number;
    bothUnknown: number;
  };
  policyC: PolicyCAnalysis;
  policyB: PolicyBAnalysis;
};

function fail(message: string): never {
  throw new Error(message);
}

/**
 * Number of weak compositions of `total` into 4 cells: C(total+3, 3).
 * Exact in doubles far past the enumeration ceiling.
 */
function compositionsOfBoth(total: number): number {
  return ((total + 1) * (total + 2) * (total + 3)) / 6;
}

function rateOf(id: CensoringRateId, cells: Cells): { numerator: number; denominator: number } {
  switch (id) {
    case "sensitivity":
      return { numerator: cells.tp, denominator: cells.tp + cells.fn };
    case "specificity":
      return { numerator: cells.tn, denominator: cells.tn + cells.fp };
    case "precision":
      return { numerator: cells.tp, denominator: cells.tp + cells.fp };
    case "negativePredictiveValue":
      return { numerator: cells.tn, denominator: cells.tn + cells.fn };
    case "accuracy":
      return {
        numerator: cells.tp + cells.tn,
        denominator: cells.tp + cells.fp + cells.tn + cells.fn
      };
    case "falsePositiveRate":
      return { numerator: cells.fp, denominator: cells.fp + cells.tn };
    case "falseNegativeRate":
      return { numerator: cells.fn, denominator: cells.fn + cells.tp };
  }
}

/**
 * Project the existing study-v3 case rows into the neutral domain. A v3
 * censored row records no prediction, so every censor reason maps to
 * both-unknown today, including reference-label-uncertain: representing a
 * surviving prediction beside an uncertain reference requires the item-3 wire
 * revision, and this projector must never invent information the row does not
 * carry.
 */
export function censoringCasesFromStudyV3Rows(
  rows: ReadonlyArray<
    | {
        caseId: string;
        outcome: "complete";
        prediction: { value: "detected" | "not-detected" };
        reference: { value: "present" | "absent" };
      }
    | { caseId: string; outcome: "censored"; reason: string }
  >
): CensoringAnalysisCase[] {
  return rows.map((row) => {
    if (row.outcome === "complete") {
      return {
        caseId: row.caseId,
        kind: "scored",
        reference: row.reference.value,
        prediction: row.prediction.value
      };
    }
    return { caseId: row.caseId, kind: "both-unknown" };
  });
}

/**
 * The full B/C analysis. Throws on conservation failure, on any fatal case,
 * and on an assignment space beyond the enumeration ceiling.
 */
export function analyzeCensoring(input: {
  plannedCases: number;
  cases: readonly CensoringAnalysisCase[];
}): CensoringAnalysis {
  const { plannedCases, cases } = input;
  if (!Number.isSafeInteger(plannedCases) || plannedCases <= 0) {
    fail("censoring analysis requires a positive planned-case count");
  }
  if (cases.length !== plannedCases) {
    fail(
      `conservation failure: ${cases.length} cases accounted against ${plannedCases} planned; every planned attempt must appear exactly once`
    );
  }
  const seen = new Set<string>();
  for (const entry of cases) {
    if (typeof entry.caseId !== "string" || entry.caseId.length === 0) {
      fail("every case needs a case id");
    }
    if (seen.has(entry.caseId)) fail(`duplicate case ${entry.caseId}`);
    seen.add(entry.caseId);
    if (entry.kind === "fatal") {
      fail(
        `fatal integrity violation on ${entry.caseId}: ${entry.violation}; fatal failures refuse the analysis and are never converted into censoring`
      );
    }
  }

  const known: Cells = { tp: 0, fp: 0, tn: 0, fn: 0 };
  let refUnknownDetected = 0;
  let refUnknownNotDetected = 0;
  let predUnknownPresent = 0;
  let predUnknownAbsent = 0;
  let bothUnknown = 0;
  for (const entry of cases) {
    if (entry.kind === "scored") {
      if (entry.reference === "present") {
        if (entry.prediction === "detected") known.tp += 1;
        else known.fn += 1;
      } else if (entry.prediction === "detected") known.fp += 1;
      else known.tn += 1;
    } else if (entry.kind === "reference-unknown") {
      if (entry.prediction === "detected") refUnknownDetected += 1;
      else refUnknownNotDetected += 1;
    } else if (entry.kind === "prediction-unknown") {
      if (entry.reference === "present") predUnknownPresent += 1;
      else predUnknownAbsent += 1;
    } else if (entry.kind === "both-unknown") {
      bothUnknown += 1;
    }
  }
  const scored = known.tp + known.fp + known.tn + known.fn;

  const assignmentCount =
    (refUnknownDetected + 1) *
    (refUnknownNotDetected + 1) *
    (predUnknownPresent + 1) *
    (predUnknownAbsent + 1) *
    compositionsOfBoth(bothUnknown);
  if (assignmentCount > MAX_ENVELOPE_ASSIGNMENTS) {
    fail(
      `the realizable assignment space has ${assignmentCount} members, beyond the ${MAX_ENVELOPE_ASSIGNMENTS} exhaustive-enumeration ceiling; implement and PROVE a reduction before analyzing a study this censored, never approximate silently`
    );
  }

  // Envelope accumulation over every realizable assignment.
  type Accumulator = {
    estimateMin: number | null;
    estimateMax: number | null;
    intervalLower: number | null;
    intervalUpper: number | null;
    denominatorCanBeEmpty: boolean;
  };
  const accumulators = new Map<CensoringRateId, Accumulator>(
    CENSORING_RATE_IDS.map((id) => [
      id,
      {
        estimateMin: null,
        estimateMax: null,
        intervalLower: null,
        intervalUpper: null,
        denominatorCanBeEmpty: false
      }
    ])
  );
  const consider = (cells: Cells) => {
    for (const id of CENSORING_RATE_IDS) {
      const { numerator, denominator } = rateOf(id, cells);
      const accumulator = accumulators.get(id)!;
      if (denominator === 0) {
        accumulator.denominatorCanBeEmpty = true;
        continue;
      }
      const estimate = numerator / denominator;
      const interval = wilson95(numerator, denominator);
      accumulator.estimateMin =
        accumulator.estimateMin === null ? estimate : Math.min(accumulator.estimateMin, estimate);
      accumulator.estimateMax =
        accumulator.estimateMax === null ? estimate : Math.max(accumulator.estimateMax, estimate);
      accumulator.intervalLower =
        accumulator.intervalLower === null
          ? interval.lower
          : Math.min(accumulator.intervalLower, interval.lower);
      accumulator.intervalUpper =
        accumulator.intervalUpper === null
          ? interval.upper
          : Math.max(accumulator.intervalUpper, interval.upper);
    }
  };

  for (let x1 = 0; x1 <= refUnknownDetected; x1 += 1) {
    for (let x2 = 0; x2 <= refUnknownNotDetected; x2 += 1) {
      for (let x3 = 0; x3 <= predUnknownPresent; x3 += 1) {
        for (let x4 = 0; x4 <= predUnknownAbsent; x4 += 1) {
          for (let b1 = 0; b1 <= bothUnknown; b1 += 1) {
            for (let b2 = 0; b2 <= bothUnknown - b1; b2 += 1) {
              for (let b3 = 0; b3 <= bothUnknown - b1 - b2; b3 += 1) {
                const b4 = bothUnknown - b1 - b2 - b3;
                consider({
                  // refUnknown & detected: TP or FP. predUnknown & present: TP or FN.
                  tp: known.tp + x1 + x3 + b1,
                  fp: known.fp + (refUnknownDetected - x1) + x4 + b2,
                  fn: known.fn + x2 + (predUnknownPresent - x3) + b3,
                  tn:
                    known.tn +
                    (refUnknownNotDetected - x2) +
                    (predUnknownAbsent - x4) +
                    b4
                });
              }
            }
          }
        }
      }
    }
  }

  const envelopes = Object.fromEntries(
    CENSORING_RATE_IDS.map((id) => {
      const accumulator = accumulators.get(id)!;
      const usable =
        accumulator.intervalLower !== null &&
        accumulator.intervalUpper !== null &&
        !accumulator.denominatorCanBeEmpty;
      return [
        id,
        {
          estimateMin: accumulator.estimateMin,
          estimateMax: accumulator.estimateMax,
          intervalLower: accumulator.intervalLower,
          intervalUpper: accumulator.intervalUpper,
          envelopeHalfWidth: usable
            ? (accumulator.intervalUpper! - accumulator.intervalLower!) / 2
            : null,
          denominatorCanBeEmpty: accumulator.denominatorCanBeEmpty
        } satisfies CensoringRateEnvelope
      ];
    })
  ) as Record<CensoringRateId, CensoringRateEnvelope>;

  // Policy B: scored cases only, plainly labeled.
  const bRates = Object.fromEntries(
    CENSORING_RATE_IDS.map((id) => {
      const { numerator, denominator } = rateOf(id, known);
      return [
        id,
        {
          numerator,
          denominator,
          estimate: denominator === 0 ? null : numerator / denominator,
          interval95: denominator === 0 ? null : wilson95(numerator, denominator)
        }
      ];
    })
  ) as PolicyBAnalysis["rates"];

  return {
    analysisVersion: CENSORING_ANALYSIS_VERSION,
    plannedCases,
    accounted: {
      scored,
      referenceUnknown: refUnknownDetected + refUnknownNotDetected,
      predictionUnknown: predUnknownPresent + predUnknownAbsent,
      bothUnknown
    },
    policyC: {
      policy: "bounded-censoring-with-sensitivity-analysis",
      inferenceScope: "declared-population",
      knownCells: known,
      unknowns: {
        referenceUnknownPredictedDetected: refUnknownDetected,
        referenceUnknownPredictedNotDetected: refUnknownNotDetected,
        predictionUnknownReferencePresent: predUnknownPresent,
        predictionUnknownReferenceAbsent: predUnknownAbsent,
        bothUnknown
      },
      assignmentsEnumerated: assignmentCount,
      rates: envelopes,
      guaranteedMargins: {
        referencePresent: known.tp + known.fn + predUnknownPresent,
        referenceAbsent: known.fp + known.tn + predUnknownAbsent,
        predictedDetected: known.tp + known.fp + refUnknownDetected,
        predictedNotDetected: known.fn + known.tn + refUnknownNotDetected
      }
    },
    policyB: {
      policy: "detector-scoped-complete-case",
      inferenceScope: "scoreable-subpopulation",
      canSatisfyPublicationGate: false,
      coverage: {
        plannedCases,
        analyzedCases: scored,
        referenceUnknown: refUnknownDetected + refUnknownNotDetected,
        predictionUnknown: predUnknownPresent + predUnknownAbsent,
        bothUnknown
      },
      cells: known,
      rates: bRates
    }
  };
}

/**
 * The publication gate for one preregistered profile, read from the policy-C
 * envelope ONLY: a policy-B result can never make this gate pass, which is
 * the decision's B-never-rescues-C rule stated as code. Margins are the
 * GUARANTEED margins: members proven to belong under every realizable
 * assignment, never an optimistic one.
 */
export function evaluatePublication(
  analysis: CensoringAnalysis,
  profile: {
    claimedClasses: readonly (
      | "reference-present"
      | "reference-absent"
      | "predicted-detected"
      | "predicted-not-detected"
    )[];
    minimumPerClaimedClass: number | null;
    maxWorstCaseHalfWidth: number;
    claimedRates: readonly CensoringRateId[];
  }
): {
  publishable: boolean;
  problems: string[];
} {
  const problems: string[] = [];
  const margins = analysis.policyC.guaranteedMargins;
  const marginOf = {
    "reference-present": margins.referencePresent,
    "reference-absent": margins.referenceAbsent,
    "predicted-detected": margins.predictedDetected,
    "predicted-not-detected": margins.predictedNotDetected
  } as const;
  if (profile.minimumPerClaimedClass !== null) {
    for (const claimed of profile.claimedClasses) {
      if (marginOf[claimed] < profile.minimumPerClaimedClass) {
        problems.push(
          `claimed class ${claimed} has ${marginOf[claimed]} guaranteed members; the profile requires ${profile.minimumPerClaimedClass}`
        );
      }
    }
  }
  for (const rateId of profile.claimedRates) {
    const envelope = analysis.policyC.rates[rateId];
    if (envelope.denominatorCanBeEmpty) {
      problems.push(
        `${rateId}: a realizable assignment empties the denominator, so no width claim is possible`
      );
      continue;
    }
    if (envelope.envelopeHalfWidth === null) {
      problems.push(`${rateId}: no realizable assignment produced an interval`);
      continue;
    }
    if (envelope.envelopeHalfWidth > profile.maxWorstCaseHalfWidth) {
      problems.push(
        `${rateId}: envelope half-width ${envelope.envelopeHalfWidth.toFixed(4)} exceeds ${profile.maxWorstCaseHalfWidth}`
      );
    }
  }
  return { publishable: problems.length === 0, problems };
}
