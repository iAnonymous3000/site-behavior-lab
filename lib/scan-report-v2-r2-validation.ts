/**
 * Structural runtime validator for ScanReport v2 REVISION 2 (r2-a4, RFC
 * section 15). Strict and default-deny at every level, by construction:
 *
 * 1. The r2-only additions (verificationFacts, observation result blocks,
 *    bannerTransition, supportingPairs) are validated here with known-keys-only
 *    checks and closed vocabularies.
 * 2. Everything else is validated by STRIPPING exactly those additions and
 *    delegating to the strict r1 structural validator, so the r2 shape is
 *    provably "r1 plus the additions": an unknown key anywhere still fails,
 *    because the strip only removes keys this module knows.
 *
 * Structural only. Cross-field consistency (derivations, uniqueness,
 * chronology, comparability/diff agreement) lives in
 * lib/scan-report-v2-r2-evaluators.ts, exactly like the r1 split.
 */
import { isRecord } from "./guards";
import { isPublicComparisonReportV2, isPublicSingleReportV2, isScanRunV2 } from "./scan-report-v2-validation";
import type {
  BannerTransitionR2,
  ConsentObservationResultR2,
  EphemeralComparisonReportR2,
  EphemeralSingleReportR2,
  GpcVerificationFactsR2,
  PublicComparisonReportV2R2,
  PublicScanReportV2R2,
  PublicSingleReportV2R2,
  ShieldsVerificationFactsR2,
  SupportingPairR2
} from "./scan-report-v2-r2";
import { SCAN_REPORT_V2_SCHEMA_REVISION_2 } from "./scan-report-v2-r2";

const RESULT_BASE_KEYS = new Set(["outcome", "sequence"]);
const RESULT_ERROR_KEYS = new Set(["outcome", "sequence", "errorCode"]);
const RESULT_ERROR_CODES: Record<string, Set<string>> = {
  error: new Set(["interpreter-threw", "state-format-unrecognized"]),
  timeout: new Set(["api-timeout"]),
  "unsupported-frame": new Set(["cross-origin-frame-blocked"])
};
const BANNER_KEYS = new Set(["method", "observations"]);
const BANNER_OBSERVATION_KEYS = new Set(["moment", "phaseId", "atMs", "visible"]);
const BANNER_MOMENTS = new Set(["before-interaction", "after-interaction", "after-reload"]);
const FACTS_KEYS = new Set(["gpc", "shields"]);
const GPC_FACTS_KEYS = new Set(["method", "header", "jsSignal", "observedOn", "phaseId"]);
const GPC_HEADER_STATES = new Set(["confirmed-present", "confirmed-absent", "unobservable"]);
const GPC_JS_STATES = new Set(["confirmed-true", "confirmed-false", "confirmed-absent", "read-failed", "unobservable"]);
const SHIELDS_FACTS_KEYS = new Set([
  "method",
  "engineLoaded",
  "applied",
  "requestsEvaluated",
  "requestsMatched",
  "requestsActuallyBlocked",
  "phaseId"
]);
const SUPPORTING_PAIR_KEYS = new Set(["pairId", "order", "baseline", "variant", "verification"]);
const VERIFICATION_KEYS = new Set(["baseline", "variant"]);
const ARM_KEYS = new Set(["axis", "expected", "observed", "method", "outcome", "phaseId"]);
const INTERVENTION_AXES = new Set(["gpc", "shields", "consent"]);
const ARM_OUTCOMES = new Set(["passed", "failed", "inconclusive"]);
const AXIS_STATES = new Set([
  "gpc:on",
  "gpc:off",
  "shields:off",
  "shields:classification",
  "shields:block-simulation",
  "consent:observe",
  "consent:accept-all",
  "consent:reject-all"
]);
const SHA256 = /^[0-9a-f]{64}$/;

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPhaseId(value: unknown, phaseCount: number): value is number {
  return isCount(value) && value < phaseCount;
}

function only(value: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function isObservationResult(value: unknown): value is ConsentObservationResultR2 {
  if (!isRecord(value) || typeof value.outcome !== "string" || !isCount(value.sequence)) return false;
  if (value.outcome === "read" || value.outcome === "unreadable") {
    return only(value, RESULT_BASE_KEYS);
  }
  const codes = RESULT_ERROR_CODES[value.outcome];
  if (codes === undefined) return false;
  return only(value, RESULT_ERROR_KEYS) && typeof value.errorCode === "string" && codes.has(value.errorCode);
}

function isBannerTransition(value: unknown, phaseCount: number): value is BannerTransitionR2 {
  return (
    isRecord(value) &&
    only(value, BANNER_KEYS) &&
    value.method === "banner-visibility@1" &&
    Array.isArray(value.observations) &&
    value.observations.every(
      (entry) =>
        isRecord(entry) &&
        only(entry, BANNER_OBSERVATION_KEYS) &&
        typeof entry.moment === "string" &&
        BANNER_MOMENTS.has(entry.moment) &&
        isPhaseId(entry.phaseId, phaseCount) &&
        isCount(entry.atMs) &&
        typeof entry.visible === "boolean"
    )
  );
}

function isGpcFacts(value: unknown, phaseCount: number): value is GpcVerificationFactsR2 {
  return (
    isRecord(value) &&
    only(value, GPC_FACTS_KEYS) &&
    value.method === "gpc-header-readback@1" &&
    typeof value.header === "string" &&
    GPC_HEADER_STATES.has(value.header) &&
    typeof value.jsSignal === "string" &&
    GPC_JS_STATES.has(value.jsSignal) &&
    value.observedOn === "first-party-navigation" &&
    isPhaseId(value.phaseId, phaseCount)
  );
}

function isShieldsFacts(value: unknown, phaseCount: number): value is ShieldsVerificationFactsR2 {
  return (
    isRecord(value) &&
    only(value, SHIELDS_FACTS_KEYS) &&
    value.method === "shields-engine-status@1" &&
    typeof value.engineLoaded === "boolean" &&
    typeof value.applied === "boolean" &&
    isCount(value.requestsEvaluated) &&
    isCount(value.requestsMatched) &&
    isCount(value.requestsActuallyBlocked) &&
    isPhaseId(value.phaseId, phaseCount)
  );
}

/**
 * Validates the r2-only additions of a run and returns the run with exactly
 * those additions stripped (for r1 delegation), or null when an addition is
 * structurally invalid.
 */
function validateAndStripRun(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value) || !Array.isArray(value.phases)) return null;
  const provenance = value.provenance;
  if (
    isRecord(provenance) &&
    provenance.sourceArtifactDigest !== undefined &&
    (typeof provenance.sourceArtifactDigest !== "string" || !SHA256.test(provenance.sourceArtifactDigest))
  ) {
    return null;
  }
  const phaseCount = value.phases.length;

  const { verificationFacts, ...withoutFacts } = value as Record<string, unknown> & { verificationFacts?: unknown };
  if (verificationFacts !== undefined) {
    if (!isRecord(verificationFacts) || !only(verificationFacts, FACTS_KEYS)) return null;
    if (verificationFacts.gpc !== undefined && !isGpcFacts(verificationFacts.gpc, phaseCount)) return null;
    if (verificationFacts.shields !== undefined && !isShieldsFacts(verificationFacts.shields, phaseCount)) return null;
  }

  const evidence = withoutFacts.evidence;
  if (!isRecord(evidence)) return null;
  const consent = evidence.consent;
  if (consent === undefined) return { ...withoutFacts };
  if (!isRecord(consent)) return null;

  const { bannerTransition, ...consentWithoutTransition } = consent as Record<string, unknown> & {
    bannerTransition?: unknown;
  };
  if (bannerTransition !== undefined && !isBannerTransition(bannerTransition, phaseCount)) return null;

  const observations = consentWithoutTransition.verificationObservations;
  if (!Array.isArray(observations)) return null;
  const strippedObservations: unknown[] = [];
  for (const observation of observations) {
    if (!isRecord(observation)) return null;
    const { result, ...withoutResult } = observation as Record<string, unknown> & { result?: unknown };
    if (result !== undefined && !isObservationResult(result)) return null;
    strippedObservations.push(withoutResult);
  }

  return {
    ...withoutFacts,
    evidence: {
      ...evidence,
      consent: { ...consentWithoutTransition, verificationObservations: strippedObservations }
    }
  };
}

function isArmShape(value: unknown, phaseCount: number): boolean {
  return (
    isRecord(value) &&
    only(value, ARM_KEYS) &&
    typeof value.axis === "string" &&
    INTERVENTION_AXES.has(value.axis) &&
    typeof value.expected === "string" &&
    AXIS_STATES.has(value.expected) &&
    (value.observed === null || (typeof value.observed === "string" && AXIS_STATES.has(value.observed))) &&
    typeof value.method === "string" &&
    value.method.length > 0 &&
    typeof value.outcome === "string" &&
    ARM_OUTCOMES.has(value.outcome) &&
    isPhaseId(value.phaseId, phaseCount)
  );
}

function isSupportingPair(value: unknown): value is SupportingPairR2 {
  if (!isRecord(value) || !only(value, SUPPORTING_PAIR_KEYS)) return false;
  if (typeof value.pairId !== "string" || value.pairId.length === 0) return false;
  if (value.order !== "AB" && value.order !== "BA") return false;
  const baseline = validateAndStripRun(value.baseline);
  const variant = validateAndStripRun(value.variant);
  if (baseline === null || variant === null || !isScanRunV2(baseline, 2) || !isScanRunV2(variant, 2)) return false;
  const verification = value.verification;
  return (
    isRecord(verification) &&
    only(verification, VERIFICATION_KEYS) &&
    isArmShape(verification.baseline, (baseline.phases as unknown[]).length) &&
    isArmShape(verification.variant, (variant.phases as unknown[]).length)
  );
}

export function isPublicSingleReportV2R2(value: unknown): value is PublicSingleReportV2R2 {
  if (!isRecord(value) || value.schemaRevision !== SCAN_REPORT_V2_SCHEMA_REVISION_2) return false;
  const strippedRun = validateAndStripRun(value.run);
  if (strippedRun === null) return false;
  return isPublicSingleReportV2({ ...value, schemaRevision: 1, run: strippedRun }, 2);
}

export function isPublicComparisonReportV2R2(value: unknown): value is PublicComparisonReportV2R2 {
  if (!isRecord(value) || value.schemaRevision !== SCAN_REPORT_V2_SCHEMA_REVISION_2) return false;
  const baseline = validateAndStripRun(value.baseline);
  const variant = validateAndStripRun(value.variant);
  if (baseline === null || variant === null) return false;

  let experiment = value.experiment;
  if (isRecord(experiment) && "supportingPairs" in experiment) {
    const { supportingPairs, ...withoutPairs } = experiment as Record<string, unknown> & { supportingPairs?: unknown };
    // supportingPairs exist ONLY on intervention experiments (RFC 15.2).
    if (withoutPairs.kind !== "intervention") return false;
    if (supportingPairs !== undefined) {
      if (!Array.isArray(supportingPairs) || !supportingPairs.every(isSupportingPair)) return false;
    }
    experiment = withoutPairs;
  }

  return isPublicComparisonReportV2({ ...value, schemaRevision: 1, baseline, variant, experiment }, 2);
}

export function isPublicScanReportV2R2(value: unknown): value is PublicScanReportV2R2 {
  if (!isRecord(value)) return false;
  if (value.reportType === "comparison") return isPublicComparisonReportV2R2(value);
  return isPublicSingleReportV2R2(value);
}

/** Ephemeral r2 shells: the public shape plus exactly the ephemeral block. */
export function isEphemeralScanReportR2(value: unknown): value is EphemeralSingleReportR2 | EphemeralComparisonReportR2 {
  if (!isRecord(value) || !isRecord(value.ephemeral)) return false;
  const { ephemeral, ...publicPart } = value;
  const shape =
    value.reportType === "comparison"
      ? only(ephemeral, new Set(["baselineScreenshot", "variantScreenshot"])) &&
        (ephemeral.baselineScreenshot === null || typeof ephemeral.baselineScreenshot === "string") &&
        (ephemeral.variantScreenshot === null || typeof ephemeral.variantScreenshot === "string")
      : only(ephemeral, new Set(["screenshot"])) &&
        (ephemeral.screenshot === null || typeof ephemeral.screenshot === "string");
  return shape && isPublicScanReportV2R2(publicPart);
}
