/**
 * Analysis-only repeated-pair model for frozen ScanReport v2/r2 artifacts.
 *
 * This module deliberately does not extend or reinterpret the public wire.
 * It derives metric-scoped, descriptive effects from validator-clean embedded
 * pairs, recomputes every pair's eligibility, and keeps population/causal
 * inference unavailable because r2 records no sampling frame, independence
 * claim, analysis plan, or pre-registration.
 */
import {
  METRIC_FAMILIES,
  type ArmVerification,
  type ComparabilityReason,
  type InterventionAxis,
  type InterventionExperiment,
  type MetricFamily
} from "./scan-report-v2";
import { evaluateComparabilityR2 } from "./scan-report-v2-r2-evaluators";
import type { PublicComparisonReportV2R2, ScanRunV2R2 } from "./scan-report-v2-r2";
import { readStoredScanReport, type ReadStoredScanReportError } from "./scan-report-reader";

export const REPEATED_EFFECT_ANALYSIS_VERSION = "repeated-effect-analysis-v1" as const;
export const REPEATED_EFFECT_MAX_PAIRS = 256;

export type RepeatedEffectMetricId =
  | "raw.totalRequests"
  | "raw.thirdPartyRequests"
  | "raw.thirdPartyDomains"
  | "raw.cookies"
  | "raw.thirdPartyCookies"
  | "raw.storageEntries"
  | "tracker.knownTrackerRequests"
  | "shields.blockedRequests"
  | "detector.distinctFingerprintFindingKinds";

export type RepeatedEffectExclusionReason =
  | ComparabilityReason
  | "intervention-unverified"
  | "metric-unavailable";

export type RepeatedPairMetricObservation = {
  pairId: string;
  order: "AB" | "BA";
  eligible: boolean;
  reasons: RepeatedEffectExclusionReason[];
  baseline: number | null;
  variant: number | null;
  /** variant - baseline; null whenever this pair is ineligible. */
  delta: number | null;
};

export type RepeatedEffectPattern =
  | "all-zero"
  | "includes-zero"
  | "same-direction-nonzero"
  | "opposite-directions";

export type RepeatedEffectMetricAnalysis = {
  metric: RepeatedEffectMetricId;
  family: MetricFamily;
  unit: "count";
  status: "insufficient-pairs" | "ineligible" | "descriptive-only";
  denominator: {
    recordedPairs: number;
    eligiblePairs: number;
    excludedPairs: number;
    positiveEffects: number;
    negativeEffects: number;
    zeroEffects: number;
  };
  pairs: RepeatedPairMetricObservation[];
  descriptive: null | {
    arithmeticMeanDelta: number;
    medianDelta: number;
    minimumDelta: number;
    maximumDelta: number;
    pattern: RepeatedEffectPattern;
    /**
     * A mechanical description only: at least two eligible, counterbalanced
     * pairs whose effects are all nonzero and point in the same direction.
     * This is explicitly not a replication or causal claim.
     */
    repeatedDirectionalObservation: boolean;
  };
  uncertainty: {
    observedEffectRange: { minimum: number; maximum: number } | null;
    confidenceInterval: null;
    reason:
      | "ineligible-or-incomplete-pair-denominator"
      | "frozen-r2-has-no-sampling-frame-or-variance-model";
  };
};

export type RepeatedEffectAnalysisReason =
  | `wire-${ReadStoredScanReportError}`
  | "requires-v2-r2"
  | "requires-comparison-report"
  | "requires-intervention-experiment"
  | "pair-limit-exceeded"
  | "requires-at-least-two-pairs"
  | "one-or-more-metrics-ineligible";

export type RepeatedEffectAnalysis = {
  analysisVersion: typeof REPEATED_EFFECT_ANALYSIS_VERSION;
  status: "not-analyzable" | "insufficient-pairs" | "ineligible" | "descriptive-only";
  reasons: RepeatedEffectAnalysisReason[];
  axis: InterventionAxis | null;
  pairDenominator: {
    recordedPairs: number;
    abPairs: number;
    baPairs: number;
    counterbalanced: boolean;
  };
  metrics: RepeatedEffectMetricAnalysis[];
  nonNumericFamilies: Array<{
    family: MetricFamily;
    reason: "no-frozen-r2-numeric-endpoint";
  }>;
  inference: {
    status: "not-supported";
    populationEffect: null;
    replicatedEffectClaimAllowed: false;
    causalClaimAllowed: false;
    reasons: readonly [
      "frozen-r2-strength-is-observed-difference",
      "sampling-frame-not-recorded",
      "pair-independence-not-established",
      "analysis-plan-not-recorded"
    ];
  };
};

type Pair = {
  pairId: string;
  order: "AB" | "BA";
  baseline: ScanRunV2R2;
  variant: ScanRunV2R2;
  verification: { baseline: ArmVerification; variant: ArmVerification };
};

type MetricDefinition = {
  id: RepeatedEffectMetricId;
  family: MetricFamily;
  value(run: ScanRunV2R2): number | null;
};

const METRICS: readonly MetricDefinition[] = [
  { id: "raw.totalRequests", family: "raw-counts", value: (run) => run.summary.counts.totalRequests },
  {
    id: "raw.thirdPartyRequests",
    family: "raw-counts",
    value: (run) => run.summary.counts.thirdPartyRequests
  },
  { id: "raw.thirdPartyDomains", family: "raw-counts", value: (run) => run.summary.counts.thirdPartyDomains },
  { id: "raw.cookies", family: "raw-counts", value: (run) => run.summary.counts.cookies },
  { id: "raw.thirdPartyCookies", family: "raw-counts", value: (run) => run.summary.counts.thirdPartyCookies },
  { id: "raw.storageEntries", family: "raw-counts", value: (run) => run.summary.counts.storageEntries },
  {
    id: "tracker.knownTrackerRequests",
    family: "tracker-classification",
    value: (run) => run.summary.counts.knownTrackerRequests
  },
  {
    id: "shields.blockedRequests",
    family: "shields-simulation",
    value: (run) => run.summary.counts.shieldsBlockedRequests ?? null
  },
  {
    id: "detector.distinctFingerprintFindingKinds",
    family: "detector-findings",
    value: (run) => new Set(run.evidence.fingerprintDetections.map((entry) => entry.kind)).size
  }
] as const;

const INFERENCE_REASONS = [
  "frozen-r2-strength-is-observed-difference",
  "sampling-frame-not-recorded",
  "pair-independence-not-established",
  "analysis-plan-not-recorded"
] as const;

/**
 * Derive a bounded, descriptive repeated-pair analysis from an unknown wire.
 * Invalid, older, non-intervention, oversized, and family-censored inputs
 * fail closed without exposing a partial aggregate as if it were complete.
 */
export function analyzeRepeatedEffects(input: unknown): RepeatedEffectAnalysis {
  const read = readStoredScanReport(input);
  if (!read.ok) return unavailable(`wire-${read.error}`);
  if (read.stored.schemaVersion !== 2 || read.stored.schemaRevision !== 2) return unavailable("requires-v2-r2");
  const report = read.stored.report;
  if (report.reportType !== "comparison") return unavailable("requires-comparison-report");
  if (report.experiment.kind !== "intervention") return unavailable("requires-intervention-experiment");

  return analyzeIntervention(report);
}

function analyzeIntervention(report: PublicComparisonReportV2R2): RepeatedEffectAnalysis {
  if (report.experiment.kind !== "intervention") return unavailable("requires-intervention-experiment");
  const experiment = report.experiment;
  const supporting = experiment.supportingPairs ?? [];
  const pairs: Pair[] = [
    {
      pairId: experiment.pairId,
      order: experiment.order,
      baseline: report.baseline,
      variant: report.variant,
      verification: experiment.verification
    },
    ...supporting
  ];
  if (pairs.length > REPEATED_EFFECT_MAX_PAIRS) {
    return unavailable("pair-limit-exceeded", experiment.axis, pairs);
  }

  const abPairs = pairs.filter((pair) => pair.order === "AB").length;
  const baPairs = pairs.length - abPairs;
  const counterbalanced = abPairs > 0 && baPairs > 0;
  const metrics = METRICS.map((metric) =>
    analyzeMetric(
      metric,
      pairs,
      experiment.axis,
      report.comparability.metricRegistryVersion,
      report.comparability.evaluatorVersion,
      counterbalanced
    )
  );

  const reasons: RepeatedEffectAnalysisReason[] = [];
  if (pairs.length < 2) reasons.push("requires-at-least-two-pairs");
  if (metrics.some((metric) => metric.status === "ineligible")) reasons.push("one-or-more-metrics-ineligible");
  const status: RepeatedEffectAnalysis["status"] =
    pairs.length < 2
      ? "insufficient-pairs"
      : metrics.every((metric) => metric.status === "ineligible")
        ? "ineligible"
        : "descriptive-only";

  return {
    analysisVersion: REPEATED_EFFECT_ANALYSIS_VERSION,
    status,
    reasons,
    axis: experiment.axis,
    pairDenominator: { recordedPairs: pairs.length, abPairs, baPairs, counterbalanced },
    metrics,
    nonNumericFamilies: METRIC_FAMILIES.filter((family) => family === "consent-verification").map((family) => ({
      family,
      reason: "no-frozen-r2-numeric-endpoint" as const
    })),
    inference: {
      status: "not-supported",
      populationEffect: null,
      replicatedEffectClaimAllowed: false,
      causalClaimAllowed: false,
      reasons: INFERENCE_REASONS
    }
  };
}

function analyzeMetric(
  metric: MetricDefinition,
  pairs: Pair[],
  axis: InterventionAxis,
  metricRegistryVersion: string,
  evaluatorVersion: string,
  counterbalanced: boolean
): RepeatedEffectMetricAnalysis {
  const observations = pairs.map((pair): RepeatedPairMetricObservation => {
    const experiment: InterventionExperiment = {
      kind: "intervention",
      axis,
      pairId: pair.pairId,
      order: pair.order,
      verification: pair.verification,
      evidence: { pairs: 1, counterbalanced: false, strength: "observed-difference" }
    };
    const comparability = evaluateComparabilityR2(
      experiment,
      pair.baseline,
      pair.variant,
      metricRegistryVersion as Parameters<typeof evaluateComparabilityR2>[3],
      evaluatorVersion as Parameters<typeof evaluateComparabilityR2>[4]
    );
    const family = comparability.perMetric[metric.family];
    const baseline = metric.value(pair.baseline);
    const variant = metric.value(pair.variant);
    const reasons: RepeatedEffectExclusionReason[] = [...family.reasons];
    if (comparability.interventionVerified !== true) reasons.push("intervention-unverified");
    if (baseline === null || variant === null) reasons.push("metric-unavailable");
    const uniqueReasons = [...new Set(reasons)];
    const eligible = uniqueReasons.length === 0;
    return {
      pairId: pair.pairId,
      order: pair.order,
      eligible,
      reasons: uniqueReasons,
      baseline: eligible ? baseline : null,
      variant: eligible ? variant : null,
      delta: eligible ? variant! - baseline! : null
    };
  });

  const deltas = observations.map((entry) => entry.delta).filter((value): value is number => value !== null);
  const allEligible = deltas.length === observations.length;
  const enoughPairs = observations.length >= 2;
  const positiveEffects = deltas.filter((value) => value > 0).length;
  const negativeEffects = deltas.filter((value) => value < 0).length;
  const zeroEffects = deltas.filter((value) => value === 0).length;
  const pattern = allEligible && deltas.length > 0 ? effectPattern(positiveEffects, negativeEffects, zeroEffects) : null;
  const descriptive = allEligible
    ? {
        arithmeticMeanDelta: deltas.reduce((sum, value) => sum + value, 0) / deltas.length,
        medianDelta: median(deltas),
        minimumDelta: Math.min(...deltas),
        maximumDelta: Math.max(...deltas),
        pattern: pattern!,
        repeatedDirectionalObservation:
          enoughPairs && counterbalanced && pattern === "same-direction-nonzero"
      }
    : null;

  return {
    metric: metric.id,
    family: metric.family,
    unit: "count",
    status: !allEligible ? "ineligible" : !enoughPairs ? "insufficient-pairs" : "descriptive-only",
    denominator: {
      recordedPairs: observations.length,
      eligiblePairs: deltas.length,
      excludedPairs: observations.length - deltas.length,
      positiveEffects,
      negativeEffects,
      zeroEffects
    },
    pairs: observations,
    descriptive,
    uncertainty: {
      observedEffectRange:
        descriptive === null ? null : { minimum: descriptive.minimumDelta, maximum: descriptive.maximumDelta },
      confidenceInterval: null,
      reason:
        descriptive === null
          ? "ineligible-or-incomplete-pair-denominator"
          : "frozen-r2-has-no-sampling-frame-or-variance-model"
    }
  };
}

function effectPattern(positive: number, negative: number, zero: number): RepeatedEffectPattern {
  if (positive === 0 && negative === 0) return "all-zero";
  if (positive > 0 && negative > 0) return "opposite-directions";
  if (zero > 0) return "includes-zero";
  return "same-direction-nonzero";
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function unavailable(
  reason: RepeatedEffectAnalysisReason,
  axis: InterventionAxis | null = null,
  pairs: readonly Pick<Pair, "order">[] = []
): RepeatedEffectAnalysis {
  const abPairs = pairs.filter((pair) => pair.order === "AB").length;
  const baPairs = pairs.length - abPairs;
  return {
    analysisVersion: REPEATED_EFFECT_ANALYSIS_VERSION,
    status: "not-analyzable",
    reasons: [reason],
    axis,
    pairDenominator: {
      recordedPairs: pairs.length,
      abPairs,
      baPairs,
      counterbalanced: abPairs > 0 && baPairs > 0
    },
    metrics: [],
    nonNumericFamilies: [],
    inference: {
      status: "not-supported",
      populationEffect: null,
      replicatedEffectClaimAllowed: false,
      causalClaimAllowed: false,
      reasons: INFERENCE_REASONS
    }
  };
}
