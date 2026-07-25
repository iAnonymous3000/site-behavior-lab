/**
 * Shared evaluators for ScanReport v2 (docs/scan-report-v2-rfc.md, sections 3,
 * 4.4, 5.3, 6, 7): quality derives from recorded facts, fingerprints from the
 * run's own inputs, comparability from the runs, and the diff rebuilds from
 * the runs alone. Producers embed these results, and the reader REJECTS any
 * report whose derived blocks differ from a recomputation (canonical
 * comparison, property order is non-semantic), so neither a producer bug nor
 * a forged upload can smuggle conclusions the facts do not support.
 *
 * Version discipline (RFC 10.2): these constants are the definitions of
 * quality evaluator "1", the current comparability evaluator, and the current
 * metric dependency registry. Historical version "1" definitions remain
 * available for exact validation of already-published reports. Comparability
 * evaluator "2" refuses a consent pair where either requested control was not
 * activated; metric registry "2" refuses unlike Shields measurements.
 */
import {
  DETECTOR_IDS,
  EVIDENCE_FAMILIES,
  METRIC_FAMILIES,
  axisStateFor,
  type ArmVerification,
  type Comparability,
  type ComparabilityReason,
  type ComparisonDiffV2,
  type ConsentEvidence,
  type ConsentObservedState,
  type EvidenceFamily,
  type Experiment,
  type InterventionAxis,
  type MetricDelta,
  type MetricFamily,
  type PhaseKind,
  type PublicScanReportV2,
  type Quality,
  type QualityFacts,
  type QualityReason,
  type ScanRunV2
} from "./scan-report-v2";
import { buildFingerprints, canonicalJson } from "./scan-report-v2-fingerprints";
import { METRIC_EVIDENCE_SOURCES } from "./metric-evidence-sources";
import {
  R2_NAVIGATION_STATUS_UNREPRESENTABLE,
  R2_REQUEST_STATUS_UNREPRESENTABLE
} from "./scan-report-v2-http-status";

export const QUALITY_EVALUATOR_VERSION = "1";
export const COMPARABILITY_EVALUATOR_VERSION = "2";
export const METRIC_REGISTRY_VERSION = "2";
export type ComparabilityEvaluatorVersion = "1" | typeof COMPARABILITY_EVALUATOR_VERSION;
export type MetricRegistryVersion = "1" | typeof METRIC_REGISTRY_VERSION;
export { METRIC_EVIDENCE_SOURCES } from "./metric-evidence-sources";

export function isSupportedComparabilityEvaluatorVersion(value: string): value is ComparabilityEvaluatorVersion {
  return value === "1" || value === COMPARABILITY_EVALUATOR_VERSION;
}

export function isSupportedMetricRegistryVersion(value: string): value is MetricRegistryVersion {
  return value === "1" || value === METRIC_REGISTRY_VERSION;
}

/**
 * Known verification interpreters (RFC 6.1, 9.4): versioned, scanner-owned
 * identifiers. An unknown method is a forgery signal, not an extension point;
 * extending these registries is an evaluator-version event once v2 ships.
 *
 * STRONG methods read actual CMP state and can support "verified" or
 * "contradicted". WEAK methods observe UI signals only (banner dismissal),
 * can never claim a definite consent state, and cap the derivation at
 * "weak-signal" (RFC 6.1).
 */
// r1 is frozen to the interpreter vocabulary it shipped with. The r2 reader
// accepts every shipped TCF version so historical `@1`/`@2` reports remain
// valid while new `@4` reports carry the restriction-aware, LI-conservative mapping.
// Exact method sets are compared by the r2 evaluator, so cross-version pairs
// are ineligible.
const STRONG_CONSENT_INTERPRETERS_R1 = new Set(["tcf-api@1", "onetrust-cookie@1"]);
export const STRONG_CONSENT_INTERPRETERS = new Set([
  ...STRONG_CONSENT_INTERPRETERS_R1,
  "tcf-api@2",
  "tcf-api@3",
  "tcf-api@4"
]);
export const WEAK_CONSENT_INTERPRETERS = new Set(["banner-visibility@1"]);
export const CONSENT_INTERPRETER_METHODS = new Set([...STRONG_CONSENT_INTERPRETERS, ...WEAK_CONSENT_INTERPRETERS]);
const CONSENT_INTERPRETER_METHODS_R1 = new Set([
  ...STRONG_CONSENT_INTERPRETERS_R1,
  ...WEAK_CONSENT_INTERPRETERS
]);
const ARM_METHODS: Record<InterventionAxis, Set<string>> = {
  gpc: new Set(["gpc-header-readback@1"]),
  shields: new Set(["shields-engine-status@1"]),
  consent: STRONG_CONSENT_INTERPRETERS_R1
};

/**
 * Closed budget registry: every budget name maps to the evidence family it
 * cuts, so an exhausted request budget cannot hide behind an unrelated
 * detector loss. An unknown budget name is a violation.
 */
export const BUDGET_FAMILIES: Readonly<Record<string, EvidenceFamily>> = Object.freeze({
  "request-capture": "requests",
  "request-upload": "requests",
  "proxy-traffic": "requests",
  "cookie-snapshot": "cookies",
  "storage-snapshot": "storage",
  "fingerprint-observer": "fingerprinting",
  "keystroke-probe": "detector-output",
  "cname-lookups": "detector-output",
  "pixel-decode": "detector-output",
  "policy-visit": "detector-output",
  // Truncation details the Node scanner records. These are capture-loss
  // details rather than budget names, but assertQualityVocabulary resolves
  // both through this one table, so an unregistered detail is a thrown build
  // and a 500 to the visitor. `policy-link-candidates` did exactly that to
  // every site whose page carries more policy-link candidates than the cap,
  // github.com among them, from the moment it was introduced.
  "policy-link-candidates": "detector-output",
  "keystroke-probe-capture": "detector-output",
  "page-title": "detector-output",
  "consent-verification": "consent-verification",
  // Public build-time caps. These are part of the pre-emission registry: a
  // hostile page cannot bloat a wire artifact, and every clipped family is
  // explicitly censored instead of silently truncated.
  "public-request-records": "requests",
  "public-cookie-mutations": "cookies",
  "public-cookie-final": "cookies",
  "public-storage-mutations": "storage",
  "public-storage-final": "storage",
  "public-fingerprint-events": "fingerprinting",
  "public-fingerprint-detections": "detector-output",
  "public-cname-cloaks": "detector-output",
  "public-pixel-events": "detector-output",
  "public-policy-claims": "detector-output",
  "public-policy-entities": "detector-output",
  "public-warnings": "detector-output",
  "public-consent-observations": "consent-verification"
});

// ---------------------------------------------------------------------------
// Quality (RFC 5.3)
// ---------------------------------------------------------------------------

export type QualityContext = {
  /** evidence.requests.length; lets the evaluator derive empty-load. */
  observedRequests: number;
};

export function evaluateQuality(facts: QualityFacts, context: QualityContext): Quality {
  const failureReasons: QualityReason[] = [];
  // The frozen r2 schema cannot carry a syntactically valid 600-999 status.
  // Its reserved navigation marker retains the error/block-page semantics
  // without inventing 599. This is backwards-compatible for evaluator "1":
  // the marker was not emitted by any historical producer, so existing fact
  // sets keep exactly their original derivation.
  const unrepresentableNavigationStatus = facts.captureLoss.some(
    (entry) => entry.detail === R2_NAVIGATION_STATUS_UNREPRESENTABLE
  );
  if ((facts.status !== null && facts.status >= 400) || unrepresentableNavigationStatus) {
    failureReasons.push("http-error-status");
  }
  if (facts.botWallTitleMatched) failureReasons.push("bot-wall-title");
  if (!facts.navigationSettled) failureReasons.push("navigation-timeout");
  const requestLossRecorded = facts.captureLoss.some((entry) => entry.family === "requests");
  if (failureReasons.length === 0 && context.observedRequests === 0 && !requestLossRecorded) {
    // A settled, non-error page that produced zero observable requests did
    // not really load; low counts would be an artifact, not a result.
    failureReasons.push("empty-load");
  }
  const runReasons: QualityReason[] = [...failureReasons];
  for (const budget of [...facts.budgetsExhausted].sort()) {
    runReasons.push(`budget-exhausted:${budget}`);
  }

  const byFamily = Object.fromEntries(
    EVIDENCE_FAMILIES.map((family) => {
      const losses = facts.captureLoss.filter((entry) => entry.family === family);
      const reasons = Array.from(
        new Set(losses.map((entry): QualityReason => `capture-loss:${entry.kind}`))
      ).sort();
      return [family, { outcome: losses.length > 0 ? ("censored" as const) : ("complete" as const), reasons }];
    })
  ) as Quality["byFamily"];

  return {
    evaluatorVersion: QUALITY_EVALUATOR_VERSION,
    run: { outcome: failureReasons.length > 0 ? "failed" : "complete", reasons: runReasons },
    byFamily
  };
}

// ---------------------------------------------------------------------------
// Metric dependency registry "1" (RFC 3.3)
// ---------------------------------------------------------------------------

/**
 * The RFC unknown rule (3.2): a missing or literal-unknown dimension makes
 * strict eligibility unprovable; two unknowns never establish a match.
 */
function isUnknownDimension(value: string | undefined): boolean {
  return value === undefined || value === "" || value.toLowerCase() === "unknown";
}

function environmentReasons(a: ScanRunV2, b: ScanRunV2): ComparabilityReason[] {
  const reasons: ComparabilityReason[] = [];
  const stringDimensions: Array<[string, string | undefined, string | undefined]> = [
    ["browser.name", a.conditions.browser.name, b.conditions.browser.name],
    ["browser.version", a.conditions.browser.version, b.conditions.browser.version],
    ["locale", a.conditions.locale, b.conditions.locale],
    ["language", a.conditions.language, b.conditions.language],
    ["timezone", a.conditions.timezone, b.conditions.timezone],
    ["egress.label", a.conditions.egress.label, b.conditions.egress.label],
    ["egress.region", a.conditions.egress.region, b.conditions.egress.region],
    ["automation", a.conditions.automation, b.conditions.automation],
    ["methodologyVersion", a.provenance.methodologyVersion, b.provenance.methodologyVersion],
    // A Playwright run and a PageGraph import do not measure equivalent
    // things, and a normalization change rewrites domains, routes, and party
    // classification: both are compatibility dimensions for every family.
    ["observer", a.provenance.observer, b.provenance.observer],
    ["normalizationVersion", a.toolchain.normalizationVersion, b.toolchain.normalizationVersion]
  ];
  let mismatch = false;
  for (const [name, left, right] of stringDimensions) {
    if (isUnknownDimension(left) || isUnknownDimension(right)) {
      reasons.push(`unknown-dimension:${name}`);
    } else if (left !== right) {
      mismatch = true;
    }
  }
  if (
    a.conditions.device.kind !== b.conditions.device.kind ||
    a.conditions.device.viewport.width !== b.conditions.device.viewport.width ||
    a.conditions.device.viewport.height !== b.conditions.device.viewport.height ||
    a.conditions.device.viewport.isMobile !== b.conditions.device.viewport.isMobile ||
    a.conditions.probes.keystroke !== b.conditions.probes.keystroke ||
    a.conditions.probes.policyVisit !== b.conditions.probes.policyVisit ||
    a.conditions.headless !== b.conditions.headless
  ) {
    mismatch = true;
  }
  if (mismatch) reasons.push("dependency-version-mismatch:environment");
  return reasons;
}

function digestReason(name: string, left: string, right: string): ComparabilityReason | null {
  if (isUnknownDimension(left) || isUnknownDimension(right)) return `unknown-dimension:${name}`;
  if (left !== right) return `dependency-digest-mismatch:${name}`;
  return null;
}

function metricDependencyReasons(
  family: MetricFamily,
  a: ScanRunV2,
  b: ScanRunV2,
  metricRegistryVersion: MetricRegistryVersion
): ComparabilityReason[] {
  const reasons: ComparabilityReason[] = [...environmentReasons(a, b)];
  if (metricRegistryVersion === "2" && family === "shields-simulation" && a.conditions.shields !== b.conditions.shields) {
    reasons.push("dependency-version-mismatch:shieldsMode");
  }
  if (family === "tracker-classification" || family === "shields-simulation" || family === "detector-findings") {
    const catalog = digestReason("trackerCatalog", a.toolchain.trackerCatalog.digest, b.toolchain.trackerCatalog.digest);
    if (catalog !== null) reasons.push(catalog);
  }
  if (family === "shields-simulation" || family === "detector-findings") {
    const leftAdblock = a.toolchain.adblock;
    const rightAdblock = b.toolchain.adblock;
    const missingAdblock = leftAdblock === null || rightAdblock === null;
    if (missingAdblock) {
      // Shields metrics always require an engine. Detector findings require
      // the engine identity only when the Brave-list CNAME fallback was
      // enabled on either arm; a known null/null pair means that fallback was
      // disabled symmetrically.
      if (family === "shields-simulation" || leftAdblock !== rightAdblock) {
        reasons.push("unknown-dimension:adblock");
      }
    } else {
      const manifest = digestReason("adblockManifest", leftAdblock.manifestDigest, rightAdblock.manifestDigest);
      if (manifest !== null) reasons.push(manifest);
      // The unknown rule applies to versions too: two "unknown" engines are
      // not the same engine.
      if (isUnknownDimension(leftAdblock.engineVersion) || isUnknownDimension(rightAdblock.engineVersion)) {
        reasons.push("unknown-dimension:adblockEngine");
      } else if (leftAdblock.engineVersion !== rightAdblock.engineVersion) {
        reasons.push("dependency-version-mismatch:adblockEngine");
      }
    }
  }
  if (family === "consent-verification") {
    const left = a.detectors["consent-banner"].version;
    const right = b.detectors["consent-banner"].version;
    if (isUnknownDimension(left) || isUnknownDimension(right)) {
      reasons.push("unknown-dimension:consent-banner");
    } else if (left !== right) {
      reasons.push("dependency-version-mismatch:consent-banner");
    }
  }
  if (family === "detector-findings") {
    for (const id of DETECTOR_IDS) {
      const left = a.detectors[id];
      const right = b.detectors[id];
      if (isUnknownDimension(left.version) || isUnknownDimension(right.version)) {
        reasons.push(`unknown-dimension:${id}`);
      } else if (left.version !== right.version) {
        reasons.push(`dependency-version-mismatch:${id}`);
      }
      // Detector-status eligibility: a failed detector's findings differ for
      // tool reasons; an APPLICABLE detector that did not run to completion
      // on both sides makes the finding sets incomparable even when the
      // incompleteness is symmetric (two partial pixel decoders are still
      // incomplete). Non-applicable detectors (their probe condition is off
      // on both runs) are legitimately skipped.
      if (left.status === "failed" || right.status === "failed") {
        reasons.push(`unknown-dimension:detectorStatus.${id}`);
      } else if (detectorApplicable(id, a) || detectorApplicable(id, b)) {
        if (left.status !== "complete" || right.status !== "complete") {
          reasons.push(`dependency-version-mismatch:detectorStatus.${id}`);
        }
      } else if (left.status !== right.status) {
        reasons.push(`dependency-version-mismatch:detectorStatus.${id}`);
      }
    }
  }
  return reasons;
}

/** Probe-gated detectors are applicable only when their condition is on. */
function detectorApplicable(id: (typeof DETECTOR_IDS)[number], run: ScanRunV2): boolean {
  if (id === "keystroke-exfiltration") return run.conditions.probes.keystroke;
  if (id === "privacy-policy") return run.conditions.probes.policyVisit;
  return true;
}

// ---------------------------------------------------------------------------
// Comparability (RFC 4.4)
// ---------------------------------------------------------------------------

export function subjectsMatch(a: ScanRunV2, b: ScanRunV2): boolean {
  return (
    a.subject.observed.origin === b.subject.observed.origin &&
    a.subject.observed.routeShape === b.subject.observed.routeShape
  );
}

/**
 * The single differing intervention axis between two condition vectors, or
 * null when zero or more than one axis differs (RFC 4.1: an intervention pair
 * moves exactly its declared axis).
 */
export function interventionAxisDelta(baseline: ScanRunV2, variant: ScanRunV2): InterventionAxis | null {
  const differing: InterventionAxis[] = [];
  if (baseline.conditions.gpc !== variant.conditions.gpc) differing.push("gpc");
  if (baseline.conditions.shields !== variant.conditions.shields) differing.push("shields");
  if (baseline.conditions.consent !== variant.conditions.consent) differing.push("consent");
  return differing.length === 1 ? differing[0] : null;
}

/**
 * Whether an intervention pair is stored in its canonical orientation: the
 * baseline arm holds the UNINTERVENED state and the variant holds the declared
 * intervention (RFC 4.1).
 *
 * Orientation is not cosmetic. Every published label, every delta sign, and
 * every causal sentence is positional: `runLabels` names runs[0] "GPC off" /
 * "No blocking" / "Accept-all click" purely by position, and the diff subtracts
 * baseline from variant. A pair whose arms are swapped therefore validates its
 * axis, its subject, and its fingerprints while inverting the entire narrative.
 * The v1 reader has always enforced this (lib/comparison-eligibility.ts) and so
 * has the node producer; this is the same rule for the v2 reader, which
 * previously only checked THAT one axis differed, never WHICH way.
 */
export function canonicalInterventionOrientation(
  axis: InterventionAxis,
  baseline: { conditions: ScanRunV2["conditions"] },
  variant: { conditions: ScanRunV2["conditions"] }
): boolean {
  if (axis === "gpc") return baseline.conditions.gpc === false && variant.conditions.gpc === true;
  if (axis === "shields") {
    return baseline.conditions.shields === "classification" && variant.conditions.shields === "block-simulation";
  }
  return baseline.conditions.consent === "accept-all" && variant.conditions.consent === "reject-all";
}

export function evaluateComparability(
  experiment: Experiment,
  baseline: ScanRunV2,
  variant: ScanRunV2,
  metricRegistryVersion: MetricRegistryVersion = METRIC_REGISTRY_VERSION,
  comparabilityEvaluatorVersion: ComparabilityEvaluatorVersion = COMPARABILITY_EVALUATOR_VERSION
): Comparability {
  const pairReasons: ComparabilityReason[] = [];
  if (!subjectsMatch(baseline, variant)) pairReasons.push("subject-mismatch");

  // Design-specific invariants (RFC 4.1). Fingerprints are individually
  // verified against recomputation per run before this evaluator's result is
  // trusted, so equality on the stored values is sound here.
  if (experiment.kind === "intervention") {
    const missingConsentActivation =
      comparabilityEvaluatorVersion === "2" &&
      experiment.axis === "consent" &&
      (baseline.evidence.consent?.controlActivated !== true ||
        variant.evidence.consent?.controlActivated !== true);
    const axisMoved = interventionAxisDelta(baseline, variant) === experiment.axis;
    // Orientation is checked at EVERY evaluator version, not gated behind
    // version 2 like the consent-activation rule: a swapped pair does not
    // become a valid experiment by having been recorded under an older
    // evaluator, and a canonically oriented pair recomputes identically, so
    // this cannot change the verdict of any correctly built report.
    const swappedArms = axisMoved && !canonicalInterventionOrientation(experiment.axis, baseline, variant);
    if (!axisMoved || swappedArms || missingConsentActivation) {
      // A consent visit that never activated its requested control remains
      // valid per-run raw evidence, but it did not produce the declared
      // accept-vs-reject pair. Pair-level ineligibility keeps every family
      // delta raw-only while preserving both runs on the report.
      pairReasons.push("design-invalid");
    }
    if (baseline.fingerprints.measurementEnvironment !== variant.fingerprints.measurementEnvironment) {
      pairReasons.push("dependency-digest-mismatch:measurementEnvironment");
    }
  } else if (experiment.kind === "temporal") {
    if (!(baseline.startedAt < variant.startedAt)) pairReasons.push("design-invalid");
    if (baseline.fingerprints.condition !== variant.fingerprints.condition) {
      pairReasons.push("dependency-digest-mismatch:conditionFingerprint");
    }
  }

  if (baseline.quality.run.outcome !== "complete") pairReasons.push("run-failed:baseline");
  if (variant.quality.run.outcome !== "complete") pairReasons.push("run-failed:variant");
  const pairEligible = pairReasons.length === 0;

  const perMetric = Object.fromEntries(
    METRIC_FAMILIES.map((family) => {
      const reasons: ComparabilityReason[] = [...pairReasons];
      reasons.push(...metricDependencyReasons(family, baseline, variant, metricRegistryVersion));
      for (const evidenceFamily of METRIC_EVIDENCE_SOURCES[family]) {
        if (baseline.quality.byFamily[evidenceFamily].outcome !== "complete") reasons.push("family-censored:baseline");
        if (variant.quality.byFamily[evidenceFamily].outcome !== "complete") reasons.push("family-censored:variant");
      }
      // RFC example 12.2: a consent intervention whose arms did not both pass
      // has NO verified consent comparison, whatever else is compatible.
      if (family === "consent-verification" && experiment.kind === "intervention" && experiment.axis === "consent") {
        for (const arm of ["baseline", "variant"] as const) {
          const outcome = experiment.verification[arm].outcome;
          if (outcome === "failed") reasons.push(`arm-verification-failed:${arm}`);
          if (outcome === "inconclusive") reasons.push(`arm-verification-inconclusive:${arm}`);
        }
      }
      const uniqueReasons = Array.from(new Set(reasons));
      return [family, { eligible: uniqueReasons.length === 0, reasons: uniqueReasons }];
    })
  ) as Comparability["perMetric"];

  return {
    evaluatorVersion: comparabilityEvaluatorVersion,
    metricRegistryVersion,
    pairValidity: { eligible: pairEligible, reasons: pairReasons },
    perMetric,
    ...(experiment.kind === "intervention"
      ? {
          interventionVerified:
            experiment.verification.baseline.outcome === "passed" &&
            experiment.verification.variant.outcome === "passed"
        }
      : {})
  };
}

// ---------------------------------------------------------------------------
// Diff (RFC 4.5 constraints): rebuilt from the runs alone
// ---------------------------------------------------------------------------

function delta(baseline: number, variant: number): MetricDelta {
  return { baseline, variant, delta: variant - baseline };
}

function trackerDomains(run: ScanRunV2): Set<string> {
  return new Set(run.evidence.requests.filter((request) => request.tracker !== null).map((request) => request.domain));
}

function detectionKinds(run: ScanRunV2): Set<string> {
  return new Set(run.evidence.fingerprintDetections.map((detection) => detection.kind));
}

function sortedDifference(a: Set<string>, b: Set<string>): string[] {
  return [...a].filter((entry) => !b.has(entry)).sort();
}

export function buildComparisonDiffV2(
  baseline: ScanRunV2,
  variant: ScanRunV2,
  perMetric: Comparability["perMetric"]
): ComparisonDiffV2 {
  const baseCounts = baseline.summary.counts;
  const variantCounts = variant.summary.counts;
  const baselineTrackers = trackerDomains(baseline);
  const variantTrackers = trackerDomains(variant);
  const baselineDetections = detectionKinds(baseline);
  const variantDetections = detectionKinds(variant);

  return {
    families: {
      "raw-counts": {
        eligible: perMetric["raw-counts"].eligible,
        metrics: {
          totalRequests: delta(baseCounts.totalRequests, variantCounts.totalRequests),
          thirdPartyRequests: delta(baseCounts.thirdPartyRequests, variantCounts.thirdPartyRequests),
          thirdPartyDomains: delta(baseCounts.thirdPartyDomains, variantCounts.thirdPartyDomains),
          cookies: delta(baseCounts.cookies, variantCounts.cookies),
          thirdPartyCookies: delta(baseCounts.thirdPartyCookies, variantCounts.thirdPartyCookies),
          storageEntries: delta(baseCounts.storageEntries, variantCounts.storageEntries)
        }
      },
      "tracker-classification": {
        eligible: perMetric["tracker-classification"].eligible,
        metrics: { knownTrackerRequests: delta(baseCounts.knownTrackerRequests, variantCounts.knownTrackerRequests) },
        addedTrackerDomains: sortedDifference(variantTrackers, baselineTrackers),
        removedTrackerDomains: sortedDifference(baselineTrackers, variantTrackers)
      },
      "shields-simulation": {
        eligible: perMetric["shields-simulation"].eligible,
        metrics:
          baseCounts.shieldsBlockedRequests !== undefined && variantCounts.shieldsBlockedRequests !== undefined
            ? { shieldsBlockedRequests: delta(baseCounts.shieldsBlockedRequests, variantCounts.shieldsBlockedRequests) }
            : null
      },
      "consent-verification": { eligible: perMetric["consent-verification"].eligible },
      "detector-findings": {
        eligible: perMetric["detector-findings"].eligible,
        addedDetectionKinds: sortedDifference(variantDetections, baselineDetections),
        removedDetectionKinds: sortedDifference(baselineDetections, variantDetections)
      }
    }
  };
}

// ---------------------------------------------------------------------------
// Semantic validation (reject-on-read)
// ---------------------------------------------------------------------------

function isCanonicalIsoTimestamp(value: string): boolean {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

/** Canonical comparison: JSON property order is non-semantic. */
function canonicallyEqual(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

function sortedStrings(values: readonly string[]): string[] {
  return [...values].sort();
}

/** Evaluator reasons are sets; their producer order carries no meaning. */
function normalizedQuality(value: Quality): Quality {
  return {
    ...value,
    run: { ...value.run, reasons: sortedStrings(value.run.reasons) as Quality["run"]["reasons"] },
    byFamily: Object.fromEntries(
      EVIDENCE_FAMILIES.map((family) => [
        family,
        {
          ...value.byFamily[family],
          reasons: sortedStrings(value.byFamily[family].reasons) as Quality["byFamily"][typeof family]["reasons"]
        }
      ])
    ) as Quality["byFamily"]
  };
}

/** Comparability reasons and added/removed diff members are set-like. */
function normalizedComparability(value: Comparability): Comparability {
  return {
    ...value,
    pairValidity: { ...value.pairValidity, reasons: sortedStrings(value.pairValidity.reasons) as Comparability["pairValidity"]["reasons"] },
    perMetric: Object.fromEntries(
      METRIC_FAMILIES.map((family) => [
        family,
        {
          ...value.perMetric[family],
          reasons: sortedStrings(value.perMetric[family].reasons) as Comparability["perMetric"][typeof family]["reasons"]
        }
      ])
    ) as Comparability["perMetric"]
  };
}

function normalizedComparisonDiff(value: ComparisonDiffV2): ComparisonDiffV2 {
  return {
    families: {
      ...value.families,
      "tracker-classification": {
        ...value.families["tracker-classification"],
        addedTrackerDomains: sortedStrings(value.families["tracker-classification"].addedTrackerDomains),
        removedTrackerDomains: sortedStrings(value.families["tracker-classification"].removedTrackerDomains)
      },
      "detector-findings": {
        ...value.families["detector-findings"],
        addedDetectionKinds: sortedStrings(value.families["detector-findings"].addedDetectionKinds),
        removedDetectionKinds: sortedStrings(value.families["detector-findings"].removedDetectionKinds)
      }
    }
  };
}

export const CONSENT_CHOICE_TO_ARM_OUTCOME: Record<string, ArmVerification["outcome"]> = {
  verified: "passed",
  contradicted: "failed",
  failed: "failed",
  "weak-signal": "inconclusive",
  unavailable: "inconclusive"
};

type DerivedCounts = {
  totalRequests: number;
  thirdPartyRequests: number;
  knownTrackerRequests: number;
  thirdPartyDomains: number;
  shieldsBlocked: number;
  cookies: number;
  thirdPartyCookies: number;
  storageEntries: number;
  fingerprintEvents: number;
  byPhase: Map<number, { totalRequests: number; thirdPartyRequests: number; knownTrackerRequests: number }>;
};

function deriveCounts(run: ScanRunV2): DerivedCounts {
  const byPhase = new Map<number, { totalRequests: number; thirdPartyRequests: number; knownTrackerRequests: number }>();
  const thirdPartyDomains = new Set<string>();
  let thirdPartyRequests = 0;
  let knownTrackerRequests = 0;
  let shieldsBlocked = 0;
  for (const request of run.evidence.requests) {
    const phase = byPhase.get(request.phaseId) ?? { totalRequests: 0, thirdPartyRequests: 0, knownTrackerRequests: 0 };
    phase.totalRequests += 1;
    if (request.thirdParty) {
      thirdPartyRequests += 1;
      thirdPartyDomains.add(request.domain);
      phase.thirdPartyRequests += 1;
    }
    if (request.tracker !== null) {
      knownTrackerRequests += 1;
      phase.knownTrackerRequests += 1;
    }
    if (request.blockedByShields === true) shieldsBlocked += 1;
    byPhase.set(request.phaseId, phase);
  }
  return {
    totalRequests: run.evidence.requests.length,
    thirdPartyRequests,
    knownTrackerRequests,
    thirdPartyDomains: thirdPartyDomains.size,
    shieldsBlocked,
    cookies: run.evidence.cookiesFinal.length,
    thirdPartyCookies: run.evidence.cookiesFinal.filter((cookie) => cookie.thirdParty).length,
    storageEntries: run.evidence.storageFinal.length,
    fingerprintEvents: run.evidence.fingerprintEvents.reduce((total, event) => total + event.count, 0),
    byPhase
  };
}

/** Public summaries count the retained public evidence, even when it was cut. */
function countConsistent(summaryValue: number, derivedValue: number): boolean {
  return summaryValue === derivedValue;
}

export type RunCoreOptions = {
  /**
   * r2 runs with Shields verification facts derive summary
   * shieldsBlockedRequests from the facts (RFC 15.3), not from retained
   * evidence flags; the r2 evaluator opts out of the r1 evidence-flag rule
   * and enforces its own.
   */
  skipShieldsSummary?: boolean;
};

function summaryViolations(run: ScanRunV2, label: string, options: RunCoreOptions = {}): string[] {
  const violations: string[] = [];
  const derived = deriveCounts(run);
  const counts = run.summary.counts;

  if (run.summary.status !== run.qualityFacts.status) {
    violations.push(`${label}: summary.status disagrees with qualityFacts.status`);
  }

  const checks: Array<[string, number, number]> = [
    ["totalRequests", counts.totalRequests, derived.totalRequests],
    ["thirdPartyRequests", counts.thirdPartyRequests, derived.thirdPartyRequests],
    ["knownTrackerRequests", counts.knownTrackerRequests, derived.knownTrackerRequests],
    ["thirdPartyDomains", counts.thirdPartyDomains, derived.thirdPartyDomains],
    ["cookies", counts.cookies, derived.cookies],
    ["thirdPartyCookies", counts.thirdPartyCookies, derived.thirdPartyCookies],
    ["storageEntries", counts.storageEntries, derived.storageEntries],
    ["fingerprintEvents", counts.fingerprintEvents, derived.fingerprintEvents]
  ];
  for (const [field, summaryValue, derivedValue] of checks) {
    if (!countConsistent(summaryValue, derivedValue)) {
      violations.push(`${label}: summary.counts.${field} does not reconcile with the evidence`);
    }
  }

  if (!options.skipShieldsSummary) {
    if (counts.shieldsBlockedRequests !== undefined) {
      if (!countConsistent(counts.shieldsBlockedRequests, derived.shieldsBlocked)) {
        violations.push(`${label}: summary.counts.shieldsBlockedRequests does not reconcile with the evidence`);
      }
    } else if (derived.shieldsBlocked > 0) {
      violations.push(`${label}: requests carry blockedByShields but the summary omits shieldsBlockedRequests`);
    }
  }

  // countsByPhase must cover exactly the retained phases with observed
  // activity, and each entry must reconcile with the retained request rows.
  const seenPhases = new Set<number>();
  for (const entry of run.summary.countsByPhase) {
    if (seenPhases.has(entry.phaseId)) {
      violations.push(`${label}: countsByPhase repeats phase ${entry.phaseId}`);
    }
    seenPhases.add(entry.phaseId);
    const derivedPhase = derived.byPhase.get(entry.phaseId) ?? { totalRequests: 0, thirdPartyRequests: 0, knownTrackerRequests: 0 };
    if (
      !countConsistent(entry.totalRequests, derivedPhase.totalRequests) ||
      !countConsistent(entry.thirdPartyRequests, derivedPhase.thirdPartyRequests) ||
      !countConsistent(entry.knownTrackerRequests, derivedPhase.knownTrackerRequests)
    ) {
      violations.push(`${label}: countsByPhase for phase ${entry.phaseId} does not reconcile with the evidence`);
    }
  }
  for (const phaseId of derived.byPhase.keys()) {
    if (!seenPhases.has(phaseId)) {
      violations.push(`${label}: countsByPhase omits phase ${phaseId} despite observed requests`);
    }
  }
  return violations;
}

const ACTIVE_DETECTOR_STATUSES = new Set(["complete", "partial"]);

function detectorViolations(run: ScanRunV2, label: string): string[] {
  const violations: string[] = [];
  const detectors = run.detectors;

  if (!run.conditions.probes.keystroke && ACTIVE_DETECTOR_STATUSES.has(detectors["keystroke-exfiltration"].status)) {
    violations.push(`${label}: keystroke detector reports activity but the keystroke probe condition is off`);
  }
  if (!run.conditions.probes.policyVisit && ACTIVE_DETECTOR_STATUSES.has(detectors["privacy-policy"].status)) {
    violations.push(`${label}: privacy-policy detector reports activity but the policy-visit probe condition is off`);
  }
  const evidenceRequirements: Array<[boolean, string, string]> = [
    [run.evidence.fingerprintDetections.some((d) => d.kind === "keystroke-exfiltration"), "keystroke-exfiltration", "keystroke findings"],
    [run.evidence.cnameCloaks.length > 0, "cname-uncloaking", "CNAME findings"],
    [run.evidence.pixelEvents.length > 0, "pixel-events", "pixel findings"],
    [run.evidence.privacyPolicy !== undefined, "privacy-policy", "a policy summary"],
    [
      run.evidence.fingerprintDetections.some((d) => d.kind !== "keystroke-exfiltration") ||
        run.evidence.fingerprintEvents.length > 0,
      "fingerprint-heuristics",
      "fingerprint observations"
    ]
  ];
  for (const [present, detectorId, what] of evidenceRequirements) {
    if (present && !ACTIVE_DETECTOR_STATUSES.has(detectors[detectorId as keyof typeof detectors].status)) {
      violations.push(`${label}: evidence contains ${what} but the ${detectorId} detector did not report activity`);
    }
  }
  return violations;
}

export function phaseKindAt(run: ScanRunV2, phaseId: number): PhaseKind | null {
  return run.phases[phaseId]?.kind ?? null;
}

/**
 * The one derivation for observation consistency: from the normalized state
 * and the requested choice, never trusted from the wire (a Reject-all run
 * whose interpreter read accepted-all can no longer claim consistency).
 */
export function deriveObservationConsistency(
  mode: "accept-all" | "reject-all",
  observed: ConsentObservedState | null
): boolean | null {
  if (observed === null || observed === "unknown") return null;
  if (mode === "accept-all") return observed === "accepted-all";
  return observed === "rejected-all";
}

const CONSENT_OBSERVATION_PHASES = new Set<PhaseKind>(["consent-interaction", "post-choice-reload"]);

/**
 * The exact choiceState derivation, evaluator "1" (RFC 6.1). "verified"
 * requires STRONG interpreter agreement in both consent phases plus an
 * activated control; weak UI evidence caps at "weak-signal"; "failed" is not
 * representable in r1 (no interpreter-error flag on the wire) and becomes
 * representable in the planned r2, so an r1 report claiming it is
 * inconsistent by construction.
 */
export function deriveChoiceState(
  consent: Pick<ConsentEvidence, "controlActivated" | "verificationObservations">,
  phaseKindOf: (phaseId: number) => PhaseKind | null
): "verified" | "contradicted" | "weak-signal" | "unavailable" {
  const strong = consent.verificationObservations.filter((observation) =>
    STRONG_CONSENT_INTERPRETERS_R1.has(observation.method)
  );
  const weak = consent.verificationObservations.filter((observation) => WEAK_CONSENT_INTERPRETERS.has(observation.method));
  if (strong.some((observation) => observation.consistentWithChoice === false)) return "contradicted";
  const strongInInteraction = strong.some(
    (observation) => observation.consistentWithChoice === true && phaseKindOf(observation.phaseId) === "consent-interaction"
  );
  const strongInReload = strong.some(
    (observation) => observation.consistentWithChoice === true && phaseKindOf(observation.phaseId) === "post-choice-reload"
  );
  if (consent.controlActivated && strongInInteraction && strongInReload) return "verified";
  if (consent.controlActivated && (weak.length > 0 || strong.some((observation) => observation.consistentWithChoice === true))) {
    return "weak-signal";
  }
  return "unavailable";
}

function consentViolations(run: ScanRunV2, label: string): string[] {
  const violations: string[] = [];
  const consent = run.evidence.consent;

  if (run.conditions.consent === "observe") {
    if (consent !== undefined) violations.push(`${label}: consent evidence present on an observe-mode run`);
    return violations;
  }
  if (consent === undefined) {
    // An accept/reject run without its interaction record is unaccountable;
    // a consent comparison could otherwise claim verification from nothing.
    violations.push(`${label}: consent-mode run carries no consent evidence`);
    return violations;
  }

  if (consent.mode !== run.conditions.consent) {
    violations.push(`${label}: consent evidence mode disagrees with the run's consent condition`);
  }
  if (!consent.interactionAttempted && consent.controlActivated) {
    violations.push(`${label}: a control was activated without an interaction attempt`);
  }
  if (!ACTIVE_DETECTOR_STATUSES.has(run.detectors["consent-banner"].status)) {
    violations.push(`${label}: consent evidence present but the consent-banner detector did not report activity`);
  }

  const observations = consent.verificationObservations;
  for (const [index, observation] of observations.entries()) {
    if (!CONSENT_INTERPRETER_METHODS_R1.has(observation.method)) {
      violations.push(`${label}: consent observation ${index} uses an unknown interpreter method`);
    }
    // Weak UI methods cannot read consent state; a definite state claim from
    // one is a forgery signal.
    if (
      WEAK_CONSENT_INTERPRETERS.has(observation.method) &&
      observation.observed !== null &&
      observation.observed !== "unknown"
    ) {
      violations.push(`${label}: consent observation ${index} claims a definite state from a weak UI method`);
    }
    const phaseKind = phaseKindAt(run, observation.phaseId);
    if (phaseKind === null || !CONSENT_OBSERVATION_PHASES.has(phaseKind)) {
      violations.push(`${label}: consent observation ${index} is tagged to a non-consent phase`);
    }
    const derivedConsistency = deriveObservationConsistency(consent.mode, observation.observed);
    if (observation.consistentWithChoice !== derivedConsistency) {
      violations.push(`${label}: consent observation ${index} consistency does not derive from its observed state`);
    }
  }

  // choiceState and reverifiedAfterReload are DERIVED, never trusted.
  const derivedState = deriveChoiceState(consent, (phaseId) => phaseKindAt(run, phaseId));
  if (consent.choiceState !== derivedState) {
    violations.push(`${label}: choiceState ${consent.choiceState} does not derive from the observations (expected ${derivedState})`);
  }
  const strongInReload = observations.some(
    (observation) =>
      STRONG_CONSENT_INTERPRETERS_R1.has(observation.method) &&
      observation.consistentWithChoice === true &&
      phaseKindAt(run, observation.phaseId) === "post-choice-reload"
  );
  if (consent.reverifiedAfterReload !== strongInReload) {
    violations.push(`${label}: reverifiedAfterReload disagrees with the recorded strong observations`);
  }
  return violations;
}

function phaseAndTimingViolations(run: ScanRunV2, label: string): string[] {
  const violations: string[] = [];
  for (const [index, span] of run.phases.entries()) {
    if (span.startedAtMs > span.endedAtMs) violations.push(`${label}: phase ${span.phaseId} ends before it starts`);
    if (index > 0 && span.startedAtMs < run.phases[index - 1].endedAtMs) {
      violations.push(`${label}: phase ${span.phaseId} starts before phase ${index - 1} ends`);
    }
  }
  const lastPhaseEnd = Math.max(0, ...run.phases.map((span) => span.endedAtMs));
  if (run.summary.durationMs < lastPhaseEnd) {
    violations.push(`${label}: summary.durationMs ends before the final measurement phase`);
  }
  // Requests attribute by start phase (RFC 7); a timestamp outside its
  // declared phase span is a mis-tagged observation.
  const requestIds = new Set<number>();
  for (const request of run.evidence.requests) {
    if (requestIds.has(request.id)) {
      violations.push(`${label}: request id ${request.id} is duplicated`);
    }
    requestIds.add(request.id);
    const span = run.phases[request.phaseId];
    if (span !== undefined && (request.startedAtMs < span.startedAtMs || request.startedAtMs > span.endedAtMs)) {
      violations.push(`${label}: request ${request.id} starts outside its declared phase span`);
    }
  }
  return violations;
}

function budgetViolations(run: ScanRunV2, label: string): string[] {
  const violations: string[] = [];
  // An exhausted budget with no recorded capture loss IN ITS OWN FAMILY would
  // leave the metrics it actually cut complete and eligible; the closed
  // registry pins each budget to the family it censors.
  for (const budget of run.qualityFacts.budgetsExhausted) {
    const family = BUDGET_FAMILIES[budget];
    if (family === undefined) {
      violations.push(`${label}: exhausted budget ${budget} is not in the budget registry`);
      continue;
    }
    const mapped = run.qualityFacts.captureLoss.some((entry) => entry.detail === budget && entry.family === family);
    if (!mapped) {
      violations.push(`${label}: exhausted budget ${budget} has no captureLoss entry in its ${family} family`);
    }
  }
  return violations;
}

/**
 * The two compatibility markers are a tightly constrained correctness
 * backport, not an open extension channel. They may only account for null
 * fields that replaced otherwise-valid 600-999 observations at the frozen r2
 * wire boundary.
 */
function httpStatusCompatibilityViolations(run: ScanRunV2, label: string): string[] {
  const violations: string[] = [];
  const navigation = run.qualityFacts.captureLoss.filter(
    (entry) => entry.detail === R2_NAVIGATION_STATUS_UNREPRESENTABLE
  );
  if (navigation.length > 1) {
    violations.push(`${label}: unrepresentable navigation HTTP status marker is duplicated`);
  }
  for (const marker of navigation) {
    if (marker.family !== "requests" || marker.phaseId !== null || marker.kind !== "dropped" || marker.count !== 1) {
      violations.push(`${label}: unrepresentable navigation HTTP status marker has an invalid shape`);
    }
    if (run.qualityFacts.status !== null) {
      violations.push(`${label}: unrepresentable navigation HTTP status marker requires a null qualityFacts.status`);
    }
  }

  const requestMarkers = run.qualityFacts.captureLoss.filter(
    (entry) => entry.detail === R2_REQUEST_STATUS_UNREPRESENTABLE
  );
  const phases = new Set<number>();
  for (const marker of requestMarkers) {
    if (marker.family !== "requests" || marker.phaseId === null || marker.kind !== "dropped") {
      violations.push(`${label}: unrepresentable request HTTP status marker has an invalid shape`);
      continue;
    }
    if (phases.has(marker.phaseId)) {
      violations.push(`${label}: unrepresentable request HTTP status marker is duplicated for phase ${marker.phaseId}`);
      continue;
    }
    phases.add(marker.phaseId);
    const nullStatuses = run.evidence.requests.filter(
      (request) => request.phaseId === marker.phaseId && request.status === null
    ).length;
    if (marker.count > nullStatuses) {
      violations.push(
        `${label}: unrepresentable request HTTP status marker exceeds null request statuses in phase ${marker.phaseId}`
      );
    }
  }
  return violations;
}

/**
 * Every run-level cross-check EXCEPT consent semantics: timestamps, phases,
 * fingerprints, quality, budgets, summary reconciliation, and detector
 * consistency. Exported for the r2 evaluator, whose consent derivations
 * (result blocks, transitions, failed-via-outcomes) supersede this module's
 * r1 rules while everything here applies to both revisions.
 */
export function scanRunCoreViolations(run: ScanRunV2, label: string, options: RunCoreOptions = {}): string[] {
  const violations: string[] = [];
  if (!isCanonicalIsoTimestamp(run.startedAt)) violations.push(`${label}: startedAt is not a canonical ISO timestamp`);

  violations.push(...phaseAndTimingViolations(run, label));

  // Fingerprints are recomputed, never trusted (RFC 3.2).
  const rebuiltFingerprints = buildFingerprints({
    conditions: run.conditions,
    provenance: run.provenance,
    toolchain: run.toolchain,
    detectors: run.detectors
  });
  if (!canonicallyEqual(run.fingerprints, rebuiltFingerprints)) {
    violations.push(`${label}: fingerprints do not match a recomputation from the run's own inputs`);
  }

  // Quality must equal the shared evaluator's output, reasons and version
  // included (canonically: property order is non-semantic).
  const derivedQuality = evaluateQuality(run.qualityFacts, { observedRequests: run.evidence.requests.length });
  if (!canonicallyEqual(normalizedQuality(run.quality), normalizedQuality(derivedQuality))) {
    violations.push(`${label}: quality does not equal the shared evaluator's output`);
  }

  violations.push(...httpStatusCompatibilityViolations(run, label));
  violations.push(...budgetViolations(run, label));
  violations.push(...summaryViolations(run, label, options));
  violations.push(...detectorViolations(run, label));
  return violations;
}

function runViolations(run: ScanRunV2, label: string): string[] {
  return [...scanRunCoreViolations(run, label), ...consentViolations(run, label)];
}

function armViolations(arm: ArmVerification, run: ScanRunV2, axis: InterventionAxis, label: string): string[] {
  const violations: string[] = [];
  if (arm.axis !== axis) violations.push(`${label}: arm axis ${arm.axis} differs from experiment axis ${axis}`);
  if (!ARM_METHODS[axis].has(arm.method)) {
    violations.push(`${label}: arm verification uses an unknown method for axis ${axis}`);
  }
  if (arm.expected !== axisStateFor(axis, run.conditions)) {
    violations.push(`${label}: arm expected state does not match the run's declared condition`);
  }
  if (axis === "consent") {
    const phaseKind = phaseKindAt(run, arm.phaseId);
    if (phaseKind === null || !CONSENT_OBSERVATION_PHASES.has(phaseKind)) {
      violations.push(`${label}: consent arm verification is tagged to a non-consent phase`);
    }
  }
  // A Shields arm cannot have observed the block simulation without a loaded
  // engine: the promised underlying fact for this axis.
  if (axis === "shields" && arm.observed === "shields:block-simulation" && run.toolchain.adblock === null) {
    violations.push(`${label}: shields arm observed block-simulation without a loaded adblock engine`);
  }
  if (axis === "consent") {
    // The consent arm is DEFINED by the run's derived choiceState: outcome is
    // its mapping, and observed is the expected state only when verified.
    // The generic observed/expected rule does not apply, so an honest
    // interpreter failure stays representable without contradiction.
    const choiceState = run.evidence.consent?.choiceState;
    const mappedOutcome = choiceState === undefined ? "inconclusive" : CONSENT_CHOICE_TO_ARM_OUTCOME[choiceState];
    if (arm.outcome !== mappedOutcome) {
      violations.push(`${label}: arm outcome ${arm.outcome} disagrees with consent choiceState`);
    }
    const expectedObserved = choiceState === "verified" ? arm.expected : null;
    if (arm.observed !== expectedObserved) {
      violations.push(`${label}: consent arm observed state does not derive from the choiceState`);
    }
  } else {
    const consistentOutcome: ArmVerification["outcome"] =
      arm.observed === null ? "inconclusive" : arm.observed === arm.expected ? "passed" : "failed";
    if (arm.outcome !== consistentOutcome) {
      violations.push(`${label}: arm outcome ${arm.outcome} disagrees with expected/observed states`);
    }
  }
  return violations;
}

function experimentEvidenceViolations(experiment: Experiment): string[] {
  if (experiment.kind !== "intervention") return [];
  const violations: string[] = [];
  const evidence = experiment.evidence;
  // First-release rule: a report carries exactly the one pair it contains,
  // so replicated claims are not representable at all. One stored pair
  // asserting { pairs: 2, counterbalanced: true } was reproducibly accepted
  // before; r2 gains per-pair records before any replicated claim is allowed.
  if (evidence.pairs !== 1) violations.push("experiment: a report represents exactly the one pair it contains");
  if (evidence.counterbalanced) violations.push("experiment: counterbalanced claims need per-pair records (r2)");
  if (evidence.strength !== "observed-difference") {
    violations.push("experiment: replicated-difference strength needs per-pair records (r2)");
  }
  return violations;
}

/**
 * Cross-checks every derived block against a recomputation from the recorded
 * facts. Empty result = internally consistent; any entry makes the report
 * unacceptable on read (the reader surfaces "inconsistent").
 */
export function scanReportV2SemanticViolations(report: PublicScanReportV2): string[] {
  if (report.reportType === "single") return runViolations(report.run, "run");

  const violations: string[] = [
    ...runViolations(report.baseline, "baseline"),
    ...runViolations(report.variant, "variant")
  ];

  const experiment = report.experiment;
  if (experiment.kind === "intervention") {
    violations.push(
      ...armViolations(experiment.verification.baseline, report.baseline, experiment.axis, "baseline arm"),
      ...armViolations(experiment.verification.variant, report.variant, experiment.axis, "variant arm"),
      ...experimentEvidenceViolations(experiment)
    );
    // The declared execution order must match the runs' chronology: AB means
    // the baseline actually ran first, BA means the variant did.
    const baselineFirst = report.baseline.startedAt < report.variant.startedAt;
    const variantFirst = report.variant.startedAt < report.baseline.startedAt;
    if ((experiment.order === "AB" && !baselineFirst) || (experiment.order === "BA" && !variantFirst)) {
      violations.push("experiment: declared order disagrees with the runs' chronology");
    }
  }

  // Validate historical reports with the metric registry they recorded. New
  // producer output uses the current registry, while unknown future registry
  // versions fail closed until this reader learns their semantics.
  const evaluatorVersion = report.comparability.evaluatorVersion;
  const metricRegistryVersion = report.comparability.metricRegistryVersion;
  if (!isSupportedComparabilityEvaluatorVersion(evaluatorVersion)) {
    violations.push(`comparability: unsupported evaluatorVersion ${evaluatorVersion}`);
  }
  if (!isSupportedMetricRegistryVersion(metricRegistryVersion)) {
    violations.push(`comparability: unsupported metricRegistryVersion ${metricRegistryVersion}`);
  }
  if (
    isSupportedComparabilityEvaluatorVersion(evaluatorVersion) &&
    isSupportedMetricRegistryVersion(metricRegistryVersion)
  ) {
    // The whole comparability block must equal the matching shared evaluator's
    // output: eligibility, reasons, interventionVerified, and versions alike.
    const derived = evaluateComparability(
      experiment,
      report.baseline,
      report.variant,
      metricRegistryVersion,
      evaluatorVersion
    );
    if (!canonicallyEqual(normalizedComparability(report.comparability), normalizedComparability(derived))) {
      violations.push("comparability: does not equal the shared evaluator's output");
    }
  }

  const rebuiltDiff = buildComparisonDiffV2(report.baseline, report.variant, report.comparability.perMetric);
  if (!canonicallyEqual(normalizedComparisonDiff(report.diff), normalizedComparisonDiff(rebuiltDiff))) {
    violations.push("diff: does not equal the diff rebuilt from the two runs");
  }

  return violations;
}
