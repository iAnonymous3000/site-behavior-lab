import {
  isEligibleCalibrationStatus,
  type DetectorCalibrationAnalysis,
  type DetectorCalibrationIneligibilityReason
} from "./detector-calibration";
import {
  MEASUREMENT_CALIBRATION_MAXIMUM_WORST_CASE_HALF_WIDTH,
  MEASUREMENT_CALIBRATION_MINIMUM_CLASS_DENOMINATOR
} from "./measurement-candidate-binding";
import { DETECTOR_IDS, type DetectorId } from "./scan-report-v2";

/**
 * What a REPORT READER may be told about a detector's measured accuracy.
 *
 * This exists because a report asserts things like "Behavioral fingerprinting
 * heuristics matched" with no indication anywhere on the page that no study
 * has ever measured how often that assertion is right. The absence read as
 * confidence. It is not; it is an unmeasured instrument.
 *
 * Two rules hold this module together.
 *
 * FAIL CLOSED. A rate is quotable only when the analyzer says the study is a
 * simple-random, blinded, release-bound sample estimate AND the approved
 * rate-publication policy would also accept it: every class denominator at or
 * above the policy minimum, and every Wilson interval inside the policy's
 * maximum half-width. Both numbers are imported from the same module the
 * release gate reads them from. Restating either here is the contract
 * duplication that lets two halves of one rule drift apart while both pass
 * their own tests.
 *
 * NEVER STORE THE ANSWER. Callers must derive this at render time from studies
 * re-analyzed against the CURRENT release identity, never from a value written
 * into a report. A study's eligibility is perishable by construction: the
 * analyzer compares the study's recorded Brave-list identity against the
 * current one, and that identity carries `fetchedAt`, which the weekly list
 * refresh moves. A rate rendered from a stored string would keep asserting a
 * number days after the analyzer stopped accepting it.
 */

export type DetectorCalibrationReaderState =
  /** A study measured this detector and its rates are publishable right now. */
  | "rates-published"
  /** A study names this detector but its re-analysis does not support a rate. */
  | "study-recorded-not-eligible"
  /** No committed study names this detector at all. */
  | "unmeasured";

export type DetectorCalibrationReaderClaim = {
  detector: DetectorId;
  state: DetectorCalibrationReaderState;
  studyId: string | null;
  /** The analyzer's own conditional-claim sentence; null unless publishable. */
  conditionalRateClaim: string | null;
  /** Machine reasons, kept verbatim so a checker can match the analyzer. */
  ineligibilityReasons: readonly DetectorCalibrationIneligibilityReason[];
};

/**
 * The approved rate-publication policy applied to one analysis.
 *
 * Deliberately stricter than `isEligibleCalibrationStatus`, which is only the
 * analyzer's design gate (Layer C). A study can be a clean sample estimate and
 * still be too small or too wide to publish; the release policy is what says
 * so, and a reader-facing rate has to clear the same bar as a released one.
 */
export function calibrationRatesQuotable(analysis: DetectorCalibrationAnalysis): boolean {
  if (!isEligibleCalibrationStatus(analysis.status)) return false;
  if (analysis.rates === null) return false;
  if (analysis.uncertainty.method !== "wilson-score-95") return false;
  if (!analysis.inference.conditionalTargetPopulationRateClaimAllowed) return false;
  if (analysis.inference.measurementCondition === null) return false;
  if (
    typeof analysis.inference.conditionalRateClaim !== "string" ||
    analysis.inference.conditionalRateClaim.length === 0
  ) {
    return false;
  }
  for (const field of [
    "referencePresent",
    "referenceAbsent",
    "predictedDetected",
    "predictedNotDetected"
  ] as const) {
    if (analysis.denominators[field] < MEASUREMENT_CALIBRATION_MINIMUM_CLASS_DENOMINATOR) {
      return false;
    }
  }
  for (const rate of Object.values(analysis.rates)) {
    const interval = rate.interval95;
    if (interval === null) return false;
    if (
      (interval.upper - interval.lower) / 2 >
      MEASUREMENT_CALIBRATION_MAXIMUM_WORST_CASE_HALF_WIDTH + Number.EPSILON
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Per-detector reader state over every committed study.
 *
 * When several studies name one detector, a publishable one wins; otherwise
 * the most recently sorted recorded study is reported, so a reader sees that
 * the detector HAS been studied and why the study does not carry a rate.
 */
export function detectorCalibrationReaderClaims(
  analyses: ReadonlyArray<DetectorCalibrationAnalysis>,
  detectors: ReadonlyArray<DetectorId> = DETECTOR_IDS
): DetectorCalibrationReaderClaim[] {
  return detectors.map((detector) => {
    const named = analyses.filter((analysis) => analysis.detector === detector);
    const quotable = named.find((analysis) => calibrationRatesQuotable(analysis));
    if (quotable) {
      return {
        detector,
        state: "rates-published",
        studyId: quotable.studyId,
        conditionalRateClaim: quotable.inference.conditionalRateClaim,
        ineligibilityReasons: []
      };
    }
    const recorded = named.at(-1);
    if (!recorded) {
      return {
        detector,
        state: "unmeasured",
        studyId: null,
        conditionalRateClaim: null,
        ineligibilityReasons: []
      };
    }
    return {
      detector,
      state: "study-recorded-not-eligible",
      studyId: recorded.studyId,
      conditionalRateClaim: null,
      ineligibilityReasons: [...recorded.ineligibilityReasons]
    };
  });
}

/**
 * Plain-language grouping of the analyzer's 20 ineligibility reasons.
 *
 * The raw tokens stay on the claim for anyone checking the analyzer; this is
 * only the sentence a non-specialist reader gets. Unknown reasons fall through
 * to the token itself rather than being dropped, so a reason added to the
 * analyzer can never silently disappear from the reader surface.
 */
export function calibrationIneligibilitySummary(
  reasons: ReadonlyArray<DetectorCalibrationIneligibilityReason>
): string | null {
  if (reasons.length === 0) return null;
  const groups: string[] = [];
  const add = (text: string) => {
    if (!groups.includes(text)) groups.push(text);
  };
  for (const reason of reasons) {
    if (reason === "measurement-condition-unbound") {
      add("it predates the schema that binds an exact measurement condition");
    } else if (reason === "censored-cases-present") {
      add("some of its cases could not be captured");
    } else if (
      reason === "no-complete-cases" ||
      reason === "missing-positive-reference-denominator" ||
      reason === "missing-negative-reference-denominator"
    ) {
      add("it recorded too few labeled cases in at least one class");
    } else if (reason === "planned-denominator-mismatch") {
      add("its recorded cases do not match the number it declared");
    } else if (reason.endsWith("-unavailable")) {
      add("its exact build or runtime identity could not be verified");
    } else if (reason.endsWith("-mismatch")) {
      add("it was collected under a different build, instrument or list revision");
    } else {
      add(reason);
    }
  }
  return groups.join("; ");
}

/**
 * The one sentence a report prints about detector accuracy.
 *
 * Single-sourced the same way `coverageBoundarySentence()` and
 * `claimBoundaryParagraph()` are: the report, the print stylesheet and the PDF
 * all render this exact string, so the three surfaces cannot drift into making
 * different promises about the same evidence.
 */
export function detectorCalibrationReaderSentence(
  claims: ReadonlyArray<DetectorCalibrationReaderClaim>
): string {
  const published = claims.filter((claim) => claim.state === "rates-published");
  const recorded = claims.filter((claim) => claim.state === "study-recorded-not-eligible");

  if (published.length === 0) {
    const base =
      "Detector accuracy is unmeasured. No calibration study currently publishes a precision or " +
      "recall for the detectors on this page, so a detector match here is a recorded observation, " +
      "not a calibrated classification.";
    if (recorded.length === 0) return base;
    // The per-reason detail stays on the claim and renders on the study
    // register. Spelled out here it ran to five clauses inside a sentence
    // whose job is to qualify the page, and buried the one fact a reader
    // needs: no rate is published.
    const names = recorded.map((claim) => claim.detector).join(", ");
    return (
      `${base} A study has been recorded for ${names} and does not support a published rate ` +
      "under the current build."
    );
  }

  const names = published.map((claim) => claim.detector).join(", ");
  const remaining = claims.length - published.length;
  const rest =
    remaining > 0
      ? ` The other ${remaining === 1 ? "detector" : `${remaining} detectors`} on this page ` +
        "still have no published rate."
      : "";
  return (
    `Published detector accuracy is available for ${names}. ` +
    `${published[0]?.conditionalRateClaim ?? ""}${rest}`.trim()
  );
}
