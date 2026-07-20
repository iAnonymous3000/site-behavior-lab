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

import { comparisonEligibility, temporalPairEligibility } from "./comparison-eligibility";
import { legacyV1MethodologyIdentity } from "./legacy-methodology";
import { sha256Hex } from "./sha256";
import type { ComparisonScanResult, ScanResult } from "./types";
import type { MetricFamily, PublicScanReportV2 } from "./scan-report-v2";
import type { PublicScanReportV2R2 } from "./scan-report-v2-r2";

export type ComparisonDecisionMode = "comparable" | "raw-only" | "suppressed";

export type FamilyDecision = {
  mode: ComparisonDecisionMode;
  /**
   * Why the mode is not "comparable"; empty when it is. Always full
   * sentences: v1 reasons are written here, v2 reasons are translated from
   * the wire's recorded reason tokens (which stay untouched on the wire).
   */
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
const LEGACY_FINGERPRINT_VERSION = "legacy-env-v3";

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
  const methodology = legacyV1MethodologyIdentity(conditions.scannerDisclosure);
  const adblock = conditions.adblock?.active
    ? {
        active: true,
        source: knownString(conditions.adblock.source),
        lists: conditions.adblock.lists,
        fetchedAt: knownString(conditions.adblock.fetchedAt)
      }
    : { active: false as const };
  if (
    !automation ||
    !browserVersion ||
    !userAgent ||
    !timezone ||
    !locale ||
    !language ||
    !egress ||
    (adblock.active && (!adblock.source || !adblock.fetchedAt || !Number.isInteger(adblock.lists) || adblock.lists <= 0))
  ) {
    return null;
  }

  // Fixed key order = canonical form; JSON.stringify of this literal is stable.
  const canonical = JSON.stringify({
    version: LEGACY_FINGERPRINT_VERSION,
    adblock,
    automation,
    browserVersion,
    egress,
    headless: conditions.headless,
    language,
    locale,
    methodology,
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

/**
 * Fail-closed cohort identity for automatic v1 history deltas. Unlike an
 * intervention comparison, a before/after observation must hold the complete
 * recorded condition and classification instrument constant. Unknown fields
 * return null, and two nulls never form a cohort.
 */
export function legacyTemporalCohortFingerprint(run: ScanResult): string | null {
  const environment = legacyMeasurementEnvironmentFingerprint(run);
  return legacyTemporalCohortFromEnvironment(run, environment, "legacy-temporal-cohort-v1");
}

/**
 * Versioned passive-history cohort used only to SUGGEST and preflight
 * descriptive temporal comparisons. It is identical to the strict legacy
 * temporal cohort except that a known Brave-list `fetchedAt` is replaced with
 * a fixed marker. This is allowed only for explicit classification visits;
 * block simulation and unknown engine provenance remain unpairable.
 *
 * The strict cohort and the full compatibility fingerprint above deliberately
 * keep the real snapshot, so retention and Shields comparisons are unchanged.
 */
export function legacyComparisonHistoryCohortFingerprint(run: ScanResult): string | null {
  const conditions = run.conditions;
  const adblock = conditions.adblock;
  if (
    conditions.shieldsMode !== "classification" ||
    adblock?.active !== true ||
    !knownString(adblock.source) ||
    !knownString(adblock.fetchedAt) ||
    !Number.isFinite(Date.parse(adblock.fetchedAt)) ||
    !Number.isInteger(adblock.lists) ||
    adblock.lists <= 0
  ) {
    return null;
  }

  const environment = legacyMeasurementEnvironmentFingerprint({
    ...run,
    conditions: {
      ...conditions,
      adblock: {
        ...adblock,
        fetchedAt: "comparison-history-snapshot-omitted-v1"
      }
    }
  });
  return legacyTemporalCohortFromEnvironment(run, environment, "legacy-comparison-history-cohort-v1");
}

function legacyTemporalCohortFromEnvironment(
  run: ScanResult,
  environment: string | null,
  version: "legacy-temporal-cohort-v1" | "legacy-comparison-history-cohort-v1"
): string | null {
  const conditions = run.conditions;
  const catalog = conditions.trackerCatalog;
  const shields = knownString(conditions.shieldsMode);
  const catalogSource = knownString(catalog.source);
  const catalogVersion = knownString(catalog.version);
  const catalogRegion = knownString(catalog.region);
  const catalogLicense = knownString(catalog.license);
  if (
    !environment ||
    !shields ||
    !catalogSource ||
    !catalogVersion ||
    !catalogRegion ||
    !catalogLicense ||
    !Number.isInteger(catalog.entries) ||
    catalog.entries < 0 ||
    !Number.isInteger(catalog.curatedOverrides) ||
    catalog.curatedOverrides < 0
  ) {
    return null;
  }

  return sha256Hex(
    JSON.stringify({
      version,
      environment,
      conditions: {
        consent: conditions.consentMode,
        gpc: conditions.gpcEnabled,
        shields
      },
      trackerCatalog: {
        source: catalogSource,
        version: catalogVersion,
        region: catalogRegion,
        entries: catalog.entries,
        curatedOverrides: catalog.curatedOverrides,
        license: catalogLicense
      }
    })
  );
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
  const strictEligibility = comparisonEligibility(report);
  const structuralEligibility = temporalPairEligibility(report);
  const pairReasons = [...structuralEligibility.reasons];

  const gatedFamily = (eligibility: { eligible: boolean; reasons: string[] }, extraReasons: string[]): FamilyDecision =>
    eligibility.eligible && extraReasons.length === 0
      ? { mode: "comparable", reasons: [] }
      : { mode: "raw-only", reasons: [...eligibility.reasons, ...extraReasons] };

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
    shields = gatedFamily(strictEligibility, shieldsReasons);
  }

  return {
    mode: structuralEligibility.eligible ? "comparable" : "raw-only",
    reasons: pairReasons,
    compatibility: legacyCompatibility(report),
    families: {
      "raw-counts": gatedFamily(structuralEligibility, []),
      "tracker-classification": gatedFamily(structuralEligibility, catalogReasons),
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

/** Reader-facing names for the RFC 3.2 comparability dimensions. */
const COMPARABILITY_DIMENSION_NAMES: Record<string, string> = {
  "browser.name": "the browser",
  "browser.version": "the browser version",
  locale: "the locale",
  language: "the language",
  timezone: "the timezone",
  "egress.label": "the network egress",
  "egress.region": "the network egress region",
  automation: "the automation toolchain",
  methodologyVersion: "the methodology version",
  observer: "the observation method",
  normalizationVersion: "the normalization version",
  adblock: "the filter-list engine",
  adblockEngine: "the filter-list engine version",
  adblockManifest: "the filter-list snapshot",
  shieldsMode: "the Shields measurement mode",
  trackerCatalog: "the tracker-catalog snapshot",
  "consent-banner": "the consent-banner state",
  "consent-interpreter": "the consent-platform interpreter"
};

function comparabilityDimensionName(dimension: string): string {
  const named = COMPARABILITY_DIMENSION_NAMES[dimension];
  if (named) return named;
  const detector = dimension.match(/^detectorStatus\.(.+)$/);
  if (detector) return `the ${detector[1]} detector's status`;
  return `the recorded "${dimension}" condition`;
}

function comparabilityArmName(arm: string): string {
  return arm === "baseline" || arm === "variant" ? `${arm} visit` : `"${arm}" visit`;
}

/**
 * Translate one recorded ComparabilityReason token (RFC 4.4 vocabulary) into
 * the sentence a report reader sees. Unrecognized tokens are quoted verbatim
 * instead of guessed at, so an evaluator vocabulary bump can never make this
 * reader claim a reason that was not recorded.
 */
export function describeComparabilityReason(reason: string): string {
  if (reason === "subject-mismatch") {
    return "The two visits observed different subjects, so their evidence describes different pages.";
  }
  if (reason === "design-invalid") {
    return "The recorded experiment design is not a valid pair for its declared kind.";
  }
  const runFailed = reason.match(/^run-failed:(.+)$/);
  if (runFailed) {
    return `The ${comparabilityArmName(runFailed[1])} did not complete, and a failed load reflects an error page, not the site.`;
  }
  const unknown = reason.match(/^unknown-dimension:(.+)$/);
  if (unknown) {
    return `The pair did not record ${comparabilityDimensionName(unknown[1])} for both visits, and an unrecorded condition never counts as matching.`;
  }
  const digest = reason.match(/^dependency-digest-mismatch:(.+)$/);
  if (digest) {
    return `The two visits used different versions of ${comparabilityDimensionName(digest[1])}, so their numbers measure different things.`;
  }
  const version = reason.match(/^dependency-version-mismatch:(.+)$/);
  if (version) {
    return version[1] === "environment"
      ? "The two visits ran in different measurement environments (browser, device, probe, or session configuration)."
      : `${capitalizeSentence(comparabilityDimensionName(version[1]))} differed between the two visits, so their numbers measure different things.`;
  }
  const censored = reason.match(/^family-censored:(.+)$/);
  if (censored) {
    return `The ${comparabilityArmName(censored[1])}'s collection was cut short by a recording cap, so its numbers are floors, not totals.`;
  }
  const verificationFailed = reason.match(/^arm-verification-failed:(.+)$/);
  if (verificationFailed) {
    return `The ${comparabilityArmName(verificationFailed[1])} failed its intervention readback, so the pair does not prove its declared conditions.`;
  }
  const verificationInconclusive = reason.match(/^arm-verification-inconclusive:(.+)$/);
  if (verificationInconclusive) {
    return `The ${comparabilityArmName(verificationInconclusive[1])}'s intervention readback was inconclusive, so the pair does not prove its declared conditions.`;
  }
  return `The recorded comparability evaluation named "${reason}".`;
}

function capitalizeSentence(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function describeComparabilityReasons(reasons: readonly string[]): string[] {
  return [...new Set(reasons.map(describeComparabilityReason))];
}

/**
 * The decision a v2 comparison recorded: pair mode from
 * comparability.pairValidity, family modes from comparability.perMetric, and
 * the fingerprint from each run's RECORDED measurementEnvironment digest. v2
 * families stay comparable/raw-only. Historical reports have two reader-side
 * safety errata: metric registry 1 could compare mixed Shields quantities, and
 * comparability evaluator 1 could keep a consent pair comparable after a
 * requested control was not activated. The reader refuses those deltas
 * without rewriting or rejecting the historical wire.
 * Reasons are translated to reader-facing sentences; the recorded tokens
 * remain on the wire for tooling.
 */
export function v2ComparisonDecision(
  report: Extract<PublicScanReportV2 | PublicScanReportV2R2, { reportType: "comparison" }>
): ComparisonDecision {
  const comparability = report.comparability;
  const baseline = report.baseline.fingerprints.measurementEnvironment;
  const variant = report.variant.fingerprints.measurementEnvironment;
  const families = Object.fromEntries(
    Object.entries(comparability.perMetric).map(([family, entry]) => [
      family,
      entry.eligible
        ? { mode: "comparable", reasons: [] }
        : { mode: "raw-only", reasons: describeComparabilityReasons(entry.reasons) }
    ])
  ) as Record<MetricFamily, FamilyDecision>;
  if (
    comparability.metricRegistryVersion === "1" &&
    report.baseline.conditions.shields !== report.variant.conditions.shields
  ) {
    families["shields-simulation"] = {
      mode: "raw-only",
      reasons: [
        ...new Set([
          ...families["shields-simulation"].reasons,
          "The two visits measured different Shields quantities (filter-list matches vs engine-blocked requests), which must never share a delta."
        ])
      ]
    };
  }
  const missingHistoricalConsentActivation =
    comparability.evaluatorVersion === "1" &&
    report.experiment.kind === "intervention" &&
    report.experiment.axis === "consent" &&
    (report.baseline.evidence.consent?.controlActivated !== true ||
      report.variant.evidence.consent?.controlActivated !== true);
  const consentActivationReason =
    "One or both requested consent controls were not activated, so the visits remain separate raw evidence rather than an accept-versus-reject comparison.";
  if (missingHistoricalConsentActivation) {
    for (const family of Object.keys(families) as MetricFamily[]) {
      families[family] = {
        mode: "raw-only",
        reasons: [...new Set([...families[family].reasons, consentActivationReason])]
      };
    }
  }
  return {
    mode:
      comparability.pairValidity.eligible && !missingHistoricalConsentActivation
        ? "comparable"
        : "raw-only",
    reasons: [
      ...new Set([
        ...describeComparabilityReasons(comparability.pairValidity.reasons),
        ...(missingHistoricalConsentActivation ? [consentActivationReason] : [])
      ])
    ],
    compatibility: {
      origin: "recorded",
      baseline,
      variant,
      matched: baseline === variant
    },
    families
  };
}
