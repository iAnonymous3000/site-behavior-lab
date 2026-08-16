/**
 * Bare-load reliability sweep for a calibration sampling frame.
 *
 * WHY THIS MODULE EXISTS AS A SEPARATE NARROWING LAYER.
 *
 * The sweep answers one question: can this candidate URL be loaded reliably
 * enough to be worth labeling? Answering it requires running the scanner, and
 * the scanner produces detector output. Preregistration is void if the frame is
 * chosen after predictions are seen -- selecting on the detector's own answers
 * is how a calibration study silently becomes a measurement of itself.
 *
 * So the separation cannot be a convention that reviewers remember. It is
 * enforced three ways here:
 *
 *   1. `bareLoadOutcome` is the ONLY way a report enters this module, and it
 *      returns a fixed, closed record. Anything it does not name is gone before
 *      sweep logic runs.
 *   2. `assertBareLoadOnly` refuses any object carrying a key outside that
 *      vocabulary, so a future edit that widens the projection fails loudly
 *      instead of quietly admitting evidence.
 *   3. The receipt is built only from projected outcomes, and is re-checked on
 *      the way out. A receipt is a published artifact; it must be provably free
 *      of predictions, not believed to be.
 *
 * The sweep deliberately cannot tell you whether a site is a positive. That is
 * the point. A frame built from these receipts is blind to the detector.
 */

/**
 * The complete vocabulary a sweep may observe. Load facts only.
 *
 * Every field here answers "did the page load, and was the visit sound enough
 * to label later" -- never "what did the detector find". `capturedFamilies` is
 * deliberately a COUNT of censored families rather than which ones: knowing
 * that cname evidence specifically was censored is a weak signal about the
 * detector, and the sweep has no need for it.
 */
export const BARE_LOAD_OUTCOME_FIELDS = Object.freeze([
  "caseId",
  "loaded",
  "status",
  "navigationSettled",
  "runOutcome",
  "censoredFamilyCount",
  "requestEvidenceComplete"
]);

const BARE_LOAD_FIELD_SET = new Set(BARE_LOAD_OUTCOME_FIELDS);

function require(condition, message) {
  if (!condition) throw new Error(message);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Refuse anything carrying a key outside the load vocabulary.
 *
 * This is the enforcement the frame-construction draft said nothing currently
 * provided. It runs on every projected case AND on the assembled receipt, so
 * neither a widened projection nor a receipt field added later can carry a
 * prediction into a published artifact.
 */
export function assertBareLoadOnly(outcome, context = "bare-load outcome") {
  require(isRecord(outcome), `${context} must be a record`);
  for (const key of Object.keys(outcome)) {
    require(
      BARE_LOAD_FIELD_SET.has(key),
      `${context} carries "${key}", which is not a bare-load field; the reliability sweep must never observe detector output`
    );
  }
  return outcome;
}

/**
 * Project a scan report down to load facts.
 *
 * Takes the whole report and returns only the closed record. Callers never see
 * the report again, so there is no path by which sweep logic can consult
 * evidence: the narrowing happens once, here, at ingestion.
 */
export function bareLoadOutcome(caseId, report) {
  require(
    typeof caseId === "string" && caseId.length > 0,
    "bare-load outcome requires a case id"
  );
  const run = isRecord(report)
    ? (report.run ?? report.baseline ?? null)
    : null;
  if (!isRecord(run)) {
    return assertBareLoadOnly({
      caseId,
      loaded: false,
      status: null,
      navigationSettled: false,
      runOutcome: "unavailable",
      censoredFamilyCount: 0,
      requestEvidenceComplete: false
    });
  }

  const status = typeof run.summary?.status === "number" ? run.summary.status : null;
  const navigationSettled = run.qualityFacts?.navigationSettled !== false;
  const runOutcome =
    typeof run.quality?.run?.outcome === "string" ? run.quality.run.outcome : "unrecorded";
  const byFamily = isRecord(run.quality?.byFamily) ? run.quality.byFamily : {};
  const censoredFamilyCount = Object.values(byFamily).filter(
    (entry) => entry?.outcome === "censored"
  ).length;

  return assertBareLoadOnly({
    caseId,
    loaded: status !== null && status < 400,
    status,
    navigationSettled,
    runOutcome,
    censoredFamilyCount,
    requestEvidenceComplete: byFamily.requests?.outcome !== "censored"
  });
}

/**
 * A case is sweep-eligible when the visit was sound enough that a later labeled
 * run is likely to be usable. This reads ONLY projected load facts.
 */
export function bareLoadEligible(outcome) {
  assertBareLoadOnly(outcome, "eligibility input");
  return (
    outcome.loaded &&
    outcome.navigationSettled &&
    outcome.runOutcome !== "failed" &&
    outcome.requestEvidenceComplete
  );
}

export const CALIBRATION_RELIABILITY_SWEEP_RECEIPT_KIND =
  "site-behavior-calibration-reliability-sweep";

/**
 * Build the sweep receipt.
 *
 * `outcomes` must already be projections. The receipt records per-case load
 * outcome and the aggregate, and is re-checked field by field before it is
 * returned, so the published artifact provably carries no prediction.
 */
export function buildReliabilitySweepReceipt({ studyId, sweptAt, outcomes }) {
  require(
    typeof studyId === "string" && studyId.length > 0,
    "reliability sweep receipt requires a study id"
  );
  require(
    typeof sweptAt === "string" && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(sweptAt),
    "reliability sweep receipt requires an ISO-8601 UTC sweptAt supplied by the caller"
  );
  require(Array.isArray(outcomes) && outcomes.length > 0, "reliability sweep observed no cases");

  const seen = new Set();
  const cases = outcomes.map((outcome) => {
    assertBareLoadOnly(outcome, "receipt case");
    require(!seen.has(outcome.caseId), `duplicate case id ${outcome.caseId} in reliability sweep`);
    seen.add(outcome.caseId);
    return outcome;
  });
  cases.sort((a, b) => a.caseId.localeCompare(b.caseId));

  const eligible = cases.filter((outcome) => bareLoadEligible(outcome)).length;
  const receipt = {
    kind: CALIBRATION_RELIABILITY_SWEEP_RECEIPT_KIND,
    studyId,
    sweptAt,
    observedCases: cases.length,
    eligibleCases: eligible,
    // A rate, not a verdict. Whether the pool clears is a preregistered
    // threshold applied by a human, not something this producer decides.
    eligibleFraction: eligible / cases.length,
    cases
  };
  for (const entry of receipt.cases) assertBareLoadOnly(entry, "assembled receipt case");
  return receipt;
}
