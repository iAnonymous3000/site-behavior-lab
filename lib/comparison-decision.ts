/**
 * The single reason-bearing comparison decision (RFC 4.4 / the survey's
 * "raw-only | comparable | suppressed" object): one ruling per pair and per
 * metric family, with a shared compatibility fingerprint, built once from the
 * recorded facts of either wire generation.
 *
 * This FOLDS INTO the three-state claim policy: scan-report-views derives
 * `ClaimPolicy.pairComparison` and `ClaimPolicy.familyDeltas` from this
 * object, so the decision and the gates can never disagree. Renderers keep
 * consulting `view.claims`; the decision adds the mode distinction and the
 * fingerprint they could not read before.
 *
 * The three modes:
 *
 * - "comparable": the recorded facts prove the surface may carry comparative
 *   framing (descriptive on v1/r1 per RFC 10.1; the causal booleans stay on
 *   the claim policy).
 * - "raw-only": the arms' evidence still renders side by side, but no
 *   comparative framing; `reasons` say why.
 * - "suppressed": the family was never measured on this pair, so there is not
 *   even per-arm evidence to set side by side; the surface says nothing.
 *
 * Dependency-light on purpose (the shared eligibility rule, the lane-free
 * sha256, and type-only wire imports) so it stays safe for static client
 * imports, like lib/comparison-eligibility.
 */

import { comparisonEligibility } from "./comparison-eligibility";
import { sha256Hex } from "./sha256";
import type { ComparisonScanResult, ScanResult } from "./types";
import type { MetricFamily, PublicScanReportV2 } from "./scan-report-v2";
import type { PublicScanReportV2R2 } from "./scan-report-v2-r2";

export type ComparisonDecisionMode = "comparable" | "raw-only" | "suppressed";

export type FamilyDecision = {
  mode: ComparisonDecisionMode;
  /** Why the mode is not "comparable"; empty when it is. Full sentences on v1, recorded reason tokens on v2. */
  reasons: string[];
};

/**
 * The shared compatibility fingerprint of the pair: one digest per arm over
 * the behavior-affecting measurement environment, EXCLUDING the intervention
 * axes' values (RFC 3.2 measurementEnvironment). v2 arms carry the digest
 * recorded by the scanner; v1 arms get one DERIVED from the environment facts
 * v1 recorded (and it is marked so, never presented as recorded fact). Per
 * the unknown rule, an arm whose environment facts are missing or literally
 * "unknown" has a null fingerprint, and null never matches anything.
 */
export type CompatibilityFingerprint = {
  origin: "recorded" | "legacy-derived";
  baseline: string | null;
  variant: string | null;
  /** Digest equality; null when either side is unprovable. */
  matched: boolean | null;
};

export type ComparisonDecision = {
  /**
   * The pair-level ruling. A pair with two readable arms always renders them,
   * so the pair mode is never "suppressed"; suppression exists per family.
   */
  mode: "comparable" | "raw-only";
  /** Why the pair is not comparable; empty when it is. */
  reasons: string[];
  compatibility: CompatibilityFingerprint;
  families: Record<MetricFamily, FamilyDecision>;
};

// ---------------------------------------------------------------------------
// v1 (legacy-derived)
// ---------------------------------------------------------------------------

/**
 * Version marker hashed into every legacy-derived fingerprint so a change to
 * the dimension set below changes the digests instead of silently colliding
 * with older ones.
 */
const LEGACY_FINGERPRINT_VERSION = "legacy-env-v1";

/** The unknown rule (RFC 3.2): empty or the literal "unknown" proves nothing. */
function knownString(value: string | undefined): string | null {
  const trimmed = (value ?? "").trim();
  if (trimmed === "" || trimmed.toLowerCase() === "unknown") return null;
  return trimmed;
}

/**
 * The legacy measurement-environment fingerprint: a digest over the
 * environment dimensions v1 recorded and the legacy eligibility gate holds
 * constant, minus the intervention axes (gpc, shields, consent) and the
 * subject (subject equality is its own pair rule, not environment). Null when
 * any dimension is unknown: an unprovable environment never matches anything,
 * including itself.
 */
export function legacyMeasurementEnvironmentFingerprint(run: ScanResult): string | null {
  const conditions = run.conditions;
  const automation = knownString(conditions.automation);
  const browserVersion = knownString(conditions.chromiumVersion);
  const userAgent = knownString(conditions.userAgent);
  const timezone = knownString(conditions.timezone);
  const locale = knownString(conditions.locale);
  const language = knownString(conditions.language);
  const egress = knownString(conditions.scannerEgress);
  if (!automation || !browserVersion || !userAgent || !timezone || !locale || !language || !egress) return null;

  // Fixed key order = canonical form; JSON.stringify of this literal is stable.
  const canonical = JSON.stringify({
    version: LEGACY_FINGERPRINT_VERSION,
    automation,
    browserVersion,
    egress,
    headless: conditions.headless,
    language,
    locale,
    timezone,
    userAgent,
    viewport: {
      width: conditions.viewport.width,
      height: conditions.viewport.height,
      isMobile: conditions.viewport.isMobile
    }
  });
  return sha256Hex(canonical);
}

function legacyCompatibility(report: ComparisonScanResult): CompatibilityFingerprint {
  const baseline = legacyMeasurementEnvironmentFingerprint(report.baseline);
  const variant = legacyMeasurementEnvironmentFingerprint(report.variant);
  return {
    origin: "legacy-derived",
    baseline,
    variant,
    matched: baseline !== null && variant !== null ? baseline === variant : null
  };
}

/**
 * The decision a v1 comparison supports: at most a descriptive pairing with
 * per-family rulings from the facts v1 actually recorded. Family semantics
 * (moved here from the claim-policy builder, reasons preserved verbatim):
 *
 * - raw-counts: the whole-pair rule (same subject, both loaded, uncapped,
 *   same device class and pipeline) is the only compatibility v1 can state,
 *   and it covers what raw counts depend on.
 * - tracker-classification: additionally requires the SAME tracker catalog
 *   (source, version, region, entries, overrides) on both arms; a different
 *   catalog classifies differently, so entity deltas would compare
 *   instruments.
 * - shields-simulation: comparable only when BOTH arms carry an active engine
 *   measurement of the same kind (equal shieldsMode) from the same list
 *   snapshot. Exactly one measured arm is raw-only (its number renders, no
 *   delta); NO measured arm is suppressed (there is no Shields evidence to
 *   set side by side at all).
 * - consent-verification: suppressed; v1 recorded that a click was
 *   dispatched, never a verified consent state (RFC 6), so the family was
 *   never measured.
 * - detector-findings: raw-only; the detectors ran and their per-arm evidence
 *   renders, but v1 never recorded detector versions, so deltas cannot be
 *   proven to come from matching instrumentation (RFC 3.2).
 */
export function legacyComparisonDecision(report: ComparisonScanResult): ComparisonDecision {
  const eligibility = comparisonEligibility(report);
  const pairReasons = [...eligibility.reasons];

  const gatedFamily = (extraReasons: string[]): FamilyDecision =>
    eligibility.eligible && extraReasons.length === 0
      ? { mode: "comparable", reasons: [] }
      : { mode: "raw-only", reasons: [...pairReasons, ...extraReasons] };

  const catalogReasons: string[] = [];
  const baselineCatalog = report.baseline.conditions.trackerCatalog;
  const variantCatalog = report.variant.conditions.trackerCatalog;
  if (!baselineCatalog.source || !variantCatalog.source || !baselineCatalog.version || !variantCatalog.version) {
    catalogReasons.push("A visit did not record its tracker-catalog identity, so classification comparability is unprovable.");
  } else if (
    baselineCatalog.source !== variantCatalog.source ||
    baselineCatalog.version !== variantCatalog.version ||
    (baselineCatalog.region ?? null) !== (variantCatalog.region ?? null) ||
    baselineCatalog.entries !== variantCatalog.entries ||
    (baselineCatalog.curatedOverrides ?? null) !== (variantCatalog.curatedOverrides ?? null)
  ) {
    catalogReasons.push(
      "The two visits classified trackers with different catalogs, so classification deltas would compare instruments, not the site."
    );
  }

  const baselineMeasured =
    typeof report.baseline.summary.shieldsBlockedRequests === "number" && report.baseline.conditions.adblock?.active === true;
  const variantMeasured =
    typeof report.variant.summary.shieldsBlockedRequests === "number" && report.variant.conditions.adblock?.active === true;

  let shields: FamilyDecision;
  if (!baselineMeasured && !variantMeasured) {
    shields = {
      mode: "suppressed",
      reasons: [...pairReasons, "Neither visit carried a Shields measurement, so there is no Shields evidence to compare or display."]
    };
  } else if (!baselineMeasured || !variantMeasured) {
    shields = {
      mode: "raw-only",
      reasons: [...pairReasons, "A Shields measurement exists on only one visit, so there is no like-for-like Shields delta."]
    };
  } else {
    const shieldsReasons: string[] = [];
    if ((report.baseline.conditions.shieldsMode ?? null) !== (report.variant.conditions.shieldsMode ?? null)) {
      shieldsReasons.push(
        "The two visits measured different Shields quantities (filter-list matches vs engine-blocked requests), which must never share a delta."
      );
    } else if (
      report.baseline.conditions.adblock?.source !== report.variant.conditions.adblock?.source ||
      report.baseline.conditions.adblock?.fetchedAt !== report.variant.conditions.adblock?.fetchedAt
    ) {
      shieldsReasons.push("The two visits used different filter-list snapshots, so their Shields numbers measure different lists.");
    }
    shields = gatedFamily(shieldsReasons);
  }

  return {
    mode: eligibility.eligible ? "comparable" : "raw-only",
    reasons: pairReasons,
    compatibility: legacyCompatibility(report),
    families: {
      "raw-counts": gatedFamily([]),
      "tracker-classification": gatedFamily(catalogReasons),
      "shields-simulation": shields,
      "consent-verification": {
        mode: "suppressed",
        reasons: [
          "v1 recorded whether a consent click was dispatched, never a verified consent state, so consent-verification deltas are unprovable."
        ]
      },
      "detector-findings": {
        mode: "raw-only",
        reasons: [
          "v1 never recorded detector versions, so fingerprinting and pixel deltas cannot be proven to come from matching instrumentation."
        ]
      }
    }
  };
}

// ---------------------------------------------------------------------------
// v2 (recorded)
// ---------------------------------------------------------------------------

/**
 * The decision a v2 comparison recorded: pair mode from
 * comparability.pairValidity, family modes from comparability.perMetric, and
 * the fingerprint from each run's RECORDED measurementEnvironment digest. v2
 * families stay comparable/raw-only: the evaluator recorded eligibility, and
 * this reader must not invent a suppression the evaluator did not record.
 */
export function v2ComparisonDecision(
  report: Extract<PublicScanReportV2 | PublicScanReportV2R2, { reportType: "comparison" }>
): ComparisonDecision {
  const comparability = report.comparability;
  const baseline = report.baseline.fingerprints.measurementEnvironment;
  const variant = report.variant.fingerprints.measurementEnvironment;
  return {
    mode: comparability.pairValidity.eligible ? "comparable" : "raw-only",
    reasons: [...comparability.pairValidity.reasons],
    compatibility: {
      origin: "recorded",
      baseline,
      variant,
      matched: baseline === variant
    },
    families: Object.fromEntries(
      Object.entries(comparability.perMetric).map(([family, entry]) => [
        family,
        entry.eligible
          ? { mode: "comparable", reasons: [] }
          : { mode: "raw-only", reasons: [...entry.reasons] }
      ])
    ) as Record<MetricFamily, FamilyDecision>
  };
}
