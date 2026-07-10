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
 * quality evaluator "1", comparability evaluator "1", and metric dependency
 * registry "1". Decision 2026-07-09: pre-emission refinements keep version
 * "1" because no v2 report has ever been emitted, stored, or published (all
 * producers are v1 and the published JSON Schema encodes shape, not evaluator
 * behavior). The versions freeze the moment the first producer emits v2;
 * any behavior change after that bumps them.
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

export const QUALITY_EVALUATOR_VERSION = "1";
export const COMPARABILITY_EVALUATOR_VERSION = "1";
export const METRIC_REGISTRY_VERSION = "1";

/**
 * Known verification interpreters (RFC 6.1, 9.4): versioned, scanner-owned
 * identifiers. An unknown method is a forgery signal, not an extension point;
 * extending this registry is an evaluator-version event once v2 ships.
 */
export const CONSENT_INTERPRETER_METHODS = new Set(["tcf-api@1", "onetrust-cookie@1", "banner-visibility@1"]);
const ARM_METHODS: Record<InterventionAxis, Set<string>> = {
  gpc: new Set(["gpc-header-readback@1"]),
  shields: new Set(["shields-engine-status@1"]),
  consent: CONSENT_INTERPRETER_METHODS
};

// ---------------------------------------------------------------------------
// Quality (RFC 5.3)
// ---------------------------------------------------------------------------

export type QualityContext = {
  /** evidence.requests.length; lets the evaluator derive empty-load. */
  observedRequests: number;
};

export function evaluateQuality(facts: QualityFacts, context: QualityContext): Quality {
  const failureReasons: QualityReason[] = [];
  if (facts.status !== null && facts.status >= 400) failureReasons.push("http-error-status");
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
      const reasons = losses.map((entry): QualityReason => `capture-loss:${entry.kind}`).sort();
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

/** Evidence families each metric family reads; censoring there censors the metric. */
const METRIC_EVIDENCE: Record<MetricFamily, EvidenceFamily[]> = {
  "raw-counts": ["requests", "cookies", "storage"],
  "tracker-classification": ["requests"],
  "shields-simulation": ["requests"],
  "consent-verification": ["consent-verification"],
  "detector-findings": ["detector-output"]
};

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
    ["methodologyVersion", a.provenance.methodologyVersion, b.provenance.methodologyVersion]
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

function metricDependencyReasons(family: MetricFamily, a: ScanRunV2, b: ScanRunV2): ComparabilityReason[] {
  const reasons: ComparabilityReason[] = [...environmentReasons(a, b)];
  if (family === "tracker-classification" || family === "shields-simulation" || family === "detector-findings") {
    const catalog = digestReason("trackerCatalog", a.toolchain.trackerCatalog.digest, b.toolchain.trackerCatalog.digest);
    if (catalog !== null) reasons.push(catalog);
  }
  if (family === "shields-simulation") {
    if (a.toolchain.adblock === null || b.toolchain.adblock === null) {
      reasons.push("unknown-dimension:adblock");
    } else {
      const manifest = digestReason("adblockManifest", a.toolchain.adblock.manifestDigest, b.toolchain.adblock.manifestDigest);
      if (manifest !== null) reasons.push(manifest);
      if (a.toolchain.adblock.engineVersion !== b.toolchain.adblock.engineVersion) {
        reasons.push("dependency-version-mismatch:adblockEngine");
      }
    }
  }
  if (family === "consent-verification") {
    if (a.detectors["consent-banner"].version !== b.detectors["consent-banner"].version) {
      reasons.push("dependency-version-mismatch:consent-banner");
    }
  }
  if (family === "detector-findings") {
    for (const id of DETECTOR_IDS) {
      if (a.detectors[id].version !== b.detectors[id].version) {
        reasons.push(`dependency-version-mismatch:${id}`);
      }
    }
  }
  return reasons;
}

// ---------------------------------------------------------------------------
// Comparability (RFC 4.4)
// ---------------------------------------------------------------------------

function subjectsMatch(a: ScanRunV2, b: ScanRunV2): boolean {
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

export function evaluateComparability(
  experiment: Experiment,
  baseline: ScanRunV2,
  variant: ScanRunV2
): Comparability {
  const pairReasons: ComparabilityReason[] = [];
  if (!subjectsMatch(baseline, variant)) pairReasons.push("subject-mismatch");

  // Design-specific invariants (RFC 4.1). Fingerprints are individually
  // verified against recomputation per run before this evaluator's result is
  // trusted, so equality on the stored values is sound here.
  if (experiment.kind === "intervention") {
    if (interventionAxisDelta(baseline, variant) !== experiment.axis) pairReasons.push("design-invalid");
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
      reasons.push(...metricDependencyReasons(family, baseline, variant));
      for (const evidenceFamily of METRIC_EVIDENCE[family]) {
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
      return [family, { eligible: reasons.length === 0, reasons }];
    })
  ) as Comparability["perMetric"];

  return {
    evaluatorVersion: COMPARABILITY_EVALUATOR_VERSION,
    metricRegistryVersion: METRIC_REGISTRY_VERSION,
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

const CONSENT_CHOICE_TO_ARM_OUTCOME: Record<string, ArmVerification["outcome"]> = {
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

/** Exact when the family is uncensored; a lower bound once evidence was cut. */
function countConsistent(summaryValue: number, derivedValue: number, censored: boolean): boolean {
  return censored ? summaryValue >= derivedValue : summaryValue === derivedValue;
}

function summaryViolations(run: ScanRunV2, derivedQuality: Quality, label: string): string[] {
  const violations: string[] = [];
  const derived = deriveCounts(run);
  const counts = run.summary.counts;
  const requestsCensored = derivedQuality.byFamily.requests.outcome === "censored";
  const cookiesCensored = derivedQuality.byFamily.cookies.outcome === "censored";
  const storageCensored = derivedQuality.byFamily.storage.outcome === "censored";
  const fingerprintingCensored = derivedQuality.byFamily.fingerprinting.outcome === "censored";

  if (run.summary.status !== run.qualityFacts.status) {
    violations.push(`${label}: summary.status disagrees with qualityFacts.status`);
  }

  const checks: Array<[string, number, number, boolean]> = [
    ["totalRequests", counts.totalRequests, derived.totalRequests, requestsCensored],
    ["thirdPartyRequests", counts.thirdPartyRequests, derived.thirdPartyRequests, requestsCensored],
    ["knownTrackerRequests", counts.knownTrackerRequests, derived.knownTrackerRequests, requestsCensored],
    ["thirdPartyDomains", counts.thirdPartyDomains, derived.thirdPartyDomains, requestsCensored],
    ["cookies", counts.cookies, derived.cookies, cookiesCensored],
    ["thirdPartyCookies", counts.thirdPartyCookies, derived.thirdPartyCookies, cookiesCensored],
    ["storageEntries", counts.storageEntries, derived.storageEntries, storageCensored],
    ["fingerprintEvents", counts.fingerprintEvents, derived.fingerprintEvents, fingerprintingCensored]
  ];
  for (const [field, summaryValue, derivedValue, censored] of checks) {
    if (!countConsistent(summaryValue, derivedValue, censored)) {
      violations.push(`${label}: summary.counts.${field} does not reconcile with the evidence`);
    }
  }

  if (counts.shieldsBlockedRequests !== undefined) {
    if (!countConsistent(counts.shieldsBlockedRequests, derived.shieldsBlocked, requestsCensored)) {
      violations.push(`${label}: summary.counts.shieldsBlockedRequests does not reconcile with the evidence`);
    }
  } else if (derived.shieldsBlocked > 0) {
    violations.push(`${label}: requests carry blockedByShields but the summary omits shieldsBlockedRequests`);
  }

  // countsByPhase must cover exactly the phases with observed activity when
  // requests are uncensored; entries must reconcile either way.
  const seenPhases = new Set<number>();
  for (const entry of run.summary.countsByPhase) {
    if (seenPhases.has(entry.phaseId)) {
      violations.push(`${label}: countsByPhase repeats phase ${entry.phaseId}`);
    }
    seenPhases.add(entry.phaseId);
    const derivedPhase = derived.byPhase.get(entry.phaseId) ?? { totalRequests: 0, thirdPartyRequests: 0, knownTrackerRequests: 0 };
    if (
      !countConsistent(entry.totalRequests, derivedPhase.totalRequests, requestsCensored) ||
      !countConsistent(entry.thirdPartyRequests, derivedPhase.thirdPartyRequests, requestsCensored) ||
      !countConsistent(entry.knownTrackerRequests, derivedPhase.knownTrackerRequests, requestsCensored)
    ) {
      violations.push(`${label}: countsByPhase for phase ${entry.phaseId} does not reconcile with the evidence`);
    }
  }
  if (!requestsCensored) {
    for (const phaseId of derived.byPhase.keys()) {
      if (!seenPhases.has(phaseId)) {
        violations.push(`${label}: countsByPhase omits phase ${phaseId} despite observed requests`);
      }
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

function phaseKindAt(run: ScanRunV2, phaseId: number): PhaseKind | null {
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
    if (!CONSENT_INTERPRETER_METHODS.has(observation.method)) {
      violations.push(`${label}: consent observation ${index} uses an unknown interpreter method`);
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

  const anyContradiction = observations.some((observation) => observation.consistentWithChoice === false);
  const consistentInInteraction = observations.some(
    (observation) => observation.consistentWithChoice === true && phaseKindAt(run, observation.phaseId) === "consent-interaction"
  );
  const consistentInReload = observations.some(
    (observation) => observation.consistentWithChoice === true && phaseKindAt(run, observation.phaseId) === "post-choice-reload"
  );

  if (consent.reverifiedAfterReload !== consistentInReload) {
    violations.push(`${label}: reverifiedAfterReload disagrees with the recorded observations`);
  }
  if (anyContradiction && consent.choiceState !== "contradicted") {
    violations.push(`${label}: a contradicting observation exists but choiceState is not contradicted`);
  }
  if (consent.choiceState === "verified") {
    if (!consent.controlActivated) violations.push(`${label}: choiceState verified without an activated control`);
    if (anyContradiction || !consistentInInteraction || !consistentInReload) {
      violations.push(`${label}: choiceState verified is not supported by the recorded observations`);
    }
  }
  if (observations.length === 0 && (consent.choiceState === "verified" || consent.choiceState === "contradicted")) {
    violations.push(`${label}: choiceState claims interpreter evidence but no observations were recorded`);
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
  // Requests attribute by start phase (RFC 7); a timestamp outside its
  // declared phase span is a mis-tagged observation.
  for (const request of run.evidence.requests) {
    const span = run.phases[request.phaseId];
    if (span !== undefined && (request.startedAtMs < span.startedAtMs || request.startedAtMs > span.endedAtMs)) {
      violations.push(`${label}: request ${request.id} starts outside its declared phase span`);
    }
  }
  return violations;
}

function budgetViolations(run: ScanRunV2, label: string): string[] {
  const violations: string[] = [];
  // An exhausted budget with no recorded capture loss would leave every
  // family complete and eligible, silently absorbing the cut (review item 3).
  for (const budget of run.qualityFacts.budgetsExhausted) {
    const mapped = run.qualityFacts.captureLoss.some((entry) => entry.detail === budget);
    if (!mapped) {
      violations.push(`${label}: exhausted budget ${budget} has no corresponding captureLoss entry`);
    }
  }
  return violations;
}

function runViolations(run: ScanRunV2, label: string): string[] {
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
  if (!canonicallyEqual(run.quality, derivedQuality)) {
    violations.push(`${label}: quality does not equal the shared evaluator's output`);
  }

  violations.push(...budgetViolations(run, label));
  violations.push(...summaryViolations(run, derivedQuality, label));
  violations.push(...detectorViolations(run, label));
  violations.push(...consentViolations(run, label));
  return violations;
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
  const consistentOutcome: ArmVerification["outcome"] =
    arm.observed === null ? "inconclusive" : arm.observed === arm.expected ? "passed" : "failed";
  if (arm.outcome !== consistentOutcome) {
    violations.push(`${label}: arm outcome ${arm.outcome} disagrees with expected/observed states`);
  }
  if (axis === "consent" && run.evidence.consent !== undefined) {
    const mapped = CONSENT_CHOICE_TO_ARM_OUTCOME[run.evidence.consent.choiceState];
    if (arm.outcome !== mapped) {
      violations.push(`${label}: arm outcome ${arm.outcome} disagrees with consent choiceState`);
    }
  }
  return violations;
}

function experimentEvidenceViolations(experiment: Experiment): string[] {
  if (experiment.kind !== "intervention") return [];
  const violations: string[] = [];
  const evidence = experiment.evidence;
  // Evidence strength must be earned, not asserted (review item 2):
  // counterbalancing needs at least an AB and a BA pair, and the stronger
  // causal wording needs counterbalanced replication.
  if (evidence.counterbalanced && evidence.pairs < 2) {
    violations.push("experiment: counterbalanced evidence requires at least two pairs");
  }
  if (evidence.strength === "replicated-difference" && (!evidence.counterbalanced || evidence.pairs < 2)) {
    violations.push("experiment: replicated-difference strength requires counterbalanced pairs");
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
  }

  // The whole comparability block must equal the shared evaluator's output:
  // eligibility, reasons, interventionVerified, and versions alike.
  const derived = evaluateComparability(experiment, report.baseline, report.variant);
  if (!canonicallyEqual(report.comparability, derived)) {
    violations.push("comparability: does not equal the shared evaluator's output");
  }

  const rebuiltDiff = buildComparisonDiffV2(report.baseline, report.variant, report.comparability.perMetric);
  if (!canonicallyEqual(report.diff, rebuiltDiff)) {
    violations.push("diff: does not equal the diff rebuilt from the two runs");
  }

  return violations;
}
