/**
 * Why a REQUESTED measurement phase is absent.
 *
 * This answers exactly one question: does the detector's own outcome explain
 * the missing phase? It is deliberately NOT the question of whether the
 * detector's lost coverage was accounted for, which is about the exact
 * evidence family, the causal capture-loss detail, and the phase that loss
 * belongs to. Both were once called "accountable", both were spelled out
 * separately in the builder and in the r2 consent evaluator, and the two
 * copies drifted. Naming and versioning this one keeps a future coverage rule
 * from inheriting its permissiveness by accident.
 *
 * It lives in its own module rather than in the measurement kernel because the
 * kernel describes the CURRENT active producer and moves with it, while this
 * predicate is read when validating historical reports. A reader of a frozen
 * epoch must not pick up today's producer semantics as a side effect.
 */
import type { DetectorStatus } from "./scan-report-v2";

/** Bump when the vocabulary or the rule below changes; epochs pin this. */
export const PHASE_OMISSION_CONTRACT_VERSION = "phase-omission-v1";

// Private and frozen. An exported Set is still mutable at runtime, which would
// let any importer widen what counts as an explanation for every caller.
const PHASE_OMISSION_EXPLAINING_REASONS: readonly string[] = Object.freeze([
  "budget-unavailable",
  "unsupported",
  "load-failed",
  "scan-failed",
  "engine-unavailable"
]);

/**
 * `complete` and `partial` are the statuses that report activity; every other
 * status in the closed union means the detector produced no phase to record.
 * The builder spelled this as `status !== "complete" && status !== "partial"`
 * and the consent evaluator as `!detectorReportedActivity`. Those look
 * different and are the same set: {skipped, unsupported, failed}.
 */
function reportedActivity(status: DetectorStatus): boolean {
  return status === "complete" || status === "partial";
}

/** Does this detector outcome explain why a requested phase is missing? */
export function phaseOmissionExplainedByDetector(entry: {
  status: DetectorStatus;
  reason?: string | null;
}): boolean {
  if (reportedActivity(entry.status)) return false;
  return typeof entry.reason === "string" && PHASE_OMISSION_EXPLAINING_REASONS.includes(entry.reason);
}
