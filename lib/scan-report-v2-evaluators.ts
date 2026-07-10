/**
 * Shared evaluators for ScanReport v2 (docs/scan-report-v2-rfc.md, sections 4.4
 * and 5.3): quality is derived from recorded facts, comparability from the
 * runs, and the diff is rebuilt from the runs alone. Producers embed the
 * results, and the reader REJECTS reports whose derived blocks disagree with a
 * recomputation, so a producer (or a forged upload) cannot smuggle conclusions
 * the facts do not support.
 *
 * Version discipline: these constants are the definitions of quality evaluator
 * "1", comparability evaluator "1", and metric dependency registry "1". Any
 * behavior change here bumps the corresponding version (RFC 10.2).
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
  type EvidenceFamily,
  type Experiment,
  type InterventionAxis,
  type MetricDelta,
  type MetricFamily,
  type PublicComparisonReportV2,
  type PublicScanReportV2,
  type Quality,
  type QualityFacts,
  type QualityReason,
  type ScanRunV2
} from "./scan-report-v2";

export const QUALITY_EVALUATOR_VERSION = "1";
export const COMPARABILITY_EVALUATOR_VERSION = "1";
export const METRIC_REGISTRY_VERSION = "1";

// ---------------------------------------------------------------------------
// Quality (RFC 5.3): run-level validity from facts, family censoring from loss
// ---------------------------------------------------------------------------

export function evaluateQuality(facts: QualityFacts): Quality {
  const runReasons: QualityReason[] = [];
  if (facts.status !== null && facts.status >= 400) runReasons.push("http-error-status");
  if (facts.botWallTitleMatched) runReasons.push("bot-wall-title");
  if (!facts.navigationSettled) runReasons.push("navigation-timeout");

  const byFamily = Object.fromEntries(
    EVIDENCE_FAMILIES.map((family) => {
      const losses = facts.captureLoss.filter((entry) => entry.family === family);
      const reasons = losses.map((entry): QualityReason => `capture-loss:${entry.kind}`);
      return [family, { outcome: losses.length > 0 ? ("censored" as const) : ("complete" as const), reasons }];
    })
  ) as Quality["byFamily"];

  return {
    evaluatorVersion: QUALITY_EVALUATOR_VERSION,
    run: { outcome: runReasons.length > 0 ? "failed" : "complete", reasons: runReasons },
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

function baseEnvironmentMatches(a: ScanRunV2, b: ScanRunV2): boolean {
  return (
    a.conditions.browser.name === b.conditions.browser.name &&
    a.conditions.browser.version === b.conditions.browser.version &&
    a.conditions.device.kind === b.conditions.device.kind &&
    a.conditions.device.viewport.width === b.conditions.device.viewport.width &&
    a.conditions.device.viewport.height === b.conditions.device.viewport.height &&
    a.conditions.device.viewport.isMobile === b.conditions.device.viewport.isMobile &&
    a.conditions.locale === b.conditions.locale &&
    a.conditions.timezone === b.conditions.timezone &&
    a.conditions.egress.label === b.conditions.egress.label &&
    a.provenance.methodologyVersion === b.provenance.methodologyVersion
  );
}

function metricDependencyMismatch(family: MetricFamily, a: ScanRunV2, b: ScanRunV2): ComparabilityReason | null {
  if (!baseEnvironmentMatches(a, b)) return "dependency-version-mismatch:environment";
  if (family === "tracker-classification" || family === "shields-simulation" || family === "detector-findings") {
    if (a.toolchain.trackerCatalog.digest !== b.toolchain.trackerCatalog.digest) {
      return "dependency-digest-mismatch:trackerCatalog";
    }
  }
  if (family === "shields-simulation") {
    if (a.toolchain.adblock === null || b.toolchain.adblock === null) return "unknown-dimension:adblock";
    if (a.toolchain.adblock.manifestDigest !== b.toolchain.adblock.manifestDigest) {
      return "dependency-digest-mismatch:adblockManifest";
    }
    if (a.toolchain.adblock.engineVersion !== b.toolchain.adblock.engineVersion) {
      return "dependency-version-mismatch:adblockEngine";
    }
  }
  if (family === "consent-verification") {
    if (a.detectors["consent-banner"].version !== b.detectors["consent-banner"].version) {
      return "dependency-version-mismatch:consent-banner";
    }
  }
  if (family === "detector-findings") {
    for (const id of DETECTOR_IDS) {
      if (a.detectors[id].version !== b.detectors[id].version) {
        return `dependency-version-mismatch:${id}`;
      }
    }
  }
  return null;
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

function designStructurallyValid(experiment: Experiment, baseline: ScanRunV2, variant: ScanRunV2): boolean {
  if (experiment.kind === "temporal") return baseline.startedAt < variant.startedAt;
  if (experiment.kind === "intervention") {
    return interventionAxisDelta(baseline, variant) === experiment.axis;
  }
  return true;
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
  if (!designStructurallyValid(experiment, baseline, variant)) pairReasons.push("design-invalid");
  if (baseline.quality.run.outcome !== "complete") pairReasons.push("run-failed:baseline");
  if (variant.quality.run.outcome !== "complete") pairReasons.push("run-failed:variant");
  const pairEligible = pairReasons.length === 0;

  const perMetric = Object.fromEntries(
    METRIC_FAMILIES.map((family) => {
      const reasons: ComparabilityReason[] = [...pairReasons];
      const dependencyMismatch = metricDependencyMismatch(family, baseline, variant);
      if (dependencyMismatch !== null) reasons.push(dependencyMismatch);
      for (const evidenceFamily of METRIC_EVIDENCE[family]) {
        if (baseline.quality.byFamily[evidenceFamily].outcome !== "complete") reasons.push("family-censored:baseline");
        if (variant.quality.byFamily[evidenceFamily].outcome !== "complete") reasons.push("family-censored:variant");
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
// Semantic validation (reject-on-read; RFC 4.3, 4.4, 5.3, 6.1, 7)
// ---------------------------------------------------------------------------

function isCanonicalIsoTimestamp(value: string): boolean {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function deepEqualJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

const CONSENT_CHOICE_TO_ARM_OUTCOME: Record<string, ArmVerification["outcome"]> = {
  verified: "passed",
  contradicted: "failed",
  failed: "failed",
  "weak-signal": "inconclusive",
  unavailable: "inconclusive"
};

function runViolations(run: ScanRunV2, label: string): string[] {
  const violations: string[] = [];
  if (!isCanonicalIsoTimestamp(run.startedAt)) violations.push(`${label}: startedAt is not a canonical ISO timestamp`);
  for (const span of run.phases) {
    if (span.startedAtMs > span.endedAtMs) violations.push(`${label}: phase ${span.phaseId} ends before it starts`);
  }
  const derived = evaluateQuality(run.qualityFacts);
  if (run.quality.run.outcome !== derived.run.outcome) {
    violations.push(`${label}: quality.run.outcome disagrees with qualityFacts`);
  }
  for (const family of EVIDENCE_FAMILIES) {
    if (run.quality.byFamily[family].outcome !== derived.byFamily[family].outcome) {
      violations.push(`${label}: quality.byFamily.${family} disagrees with qualityFacts`);
    }
  }
  return violations;
}

function armViolations(
  arm: ArmVerification,
  run: ScanRunV2,
  axis: InterventionAxis,
  label: string
): string[] {
  const violations: string[] = [];
  if (arm.axis !== axis) violations.push(`${label}: arm axis ${arm.axis} differs from experiment axis ${axis}`);
  if (arm.expected !== axisStateFor(axis, run.conditions)) {
    violations.push(`${label}: arm expected state does not match the run's declared condition`);
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
    if (interventionAxisDelta(report.baseline, report.variant) !== experiment.axis) {
      violations.push("experiment: condition vectors do not differ in exactly the declared axis");
    }
    violations.push(
      ...armViolations(experiment.verification.baseline, report.baseline, experiment.axis, "baseline arm"),
      ...armViolations(experiment.verification.variant, report.variant, experiment.axis, "variant arm")
    );
  }

  const derived = evaluateComparability(experiment, report.baseline, report.variant);
  if (report.comparability.pairValidity.eligible !== derived.pairValidity.eligible) {
    violations.push("comparability: pairValidity disagrees with the shared evaluator");
  }
  for (const family of METRIC_FAMILIES) {
    if (report.comparability.perMetric[family].eligible !== derived.perMetric[family].eligible) {
      violations.push(`comparability: perMetric.${family} disagrees with the shared evaluator`);
    }
  }
  if (experiment.kind === "intervention") {
    if (report.comparability.interventionVerified !== derived.interventionVerified) {
      violations.push("comparability: interventionVerified disagrees with the arm outcomes");
    }
  }

  const rebuiltDiff = buildComparisonDiffV2(report.baseline, report.variant, report.comparability.perMetric);
  if (!deepEqualJson(report.diff, rebuiltDiff)) {
    violations.push("diff: does not equal the diff rebuilt from the two runs");
  }

  return violations;
}
