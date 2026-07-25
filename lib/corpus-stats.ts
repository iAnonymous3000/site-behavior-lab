/**
 * Corpus statistics for percentile-based severity.
 *
 * The fixed severity thresholds in the findings board are placeholders. When a
 * real corpus of scanned sites exists (`public/corpus-stats.json`, built by
 * `scripts/build-corpus-stats.mjs`), the findings rank a report against measured
 * percentiles instead.
 *
 * Honesty gate: percentile / "X% of sites" language is only used once the corpus
 * has at least {@link CORPUS_MIN_SAMPLE} distinct real sites. Below that, callers
 * fall back to the fixed reference thresholds so the product never makes a
 * population claim it cannot back with data.
 */

import { isRecord } from "./guards";
import type { CorpusCohortIdentity } from "./corpus-cohort";

export type CorpusMetricKey =
  | "thirdPartyRequests"
  | "thirdPartyDomains"
  | "knownTrackerRequests"
  | "thirdPartyCookies"
  | "fingerprintEvents";

export type MetricDistribution = {
  count: number;
  min: number;
  max: number;
  p50: number;
  p75: number;
  p90: number;
  p95: number;
};

export type CorpusStatsCohort = CorpusCohortIdentity & {
  /** Distinct sites represented once by their newest eligible run in this cohort. */
  sampleSize: number;
  /**
   * Newest measurement backing this cohort's distributions, ISO-8601, or null
   * when no row carried a parseable time. Published so the artifact can justify
   * which cohort it named primary, and so a reader can date the distributions
   * without re-reading every committed report.
   */
  latestRunAt: string | null;
  metrics: Partial<Record<CorpusMetricKey, MetricDistribution>>;
};

export type CorpusStats = {
  version: number;
  generatedAt: string;
  /**
   * Distinct sites in primaryCohortId's percentile sample: newest eligible
   * lead run loaded (HTTP < 400), retained complete request evidence, and
   * remained in the passive observe consent state. This is smaller than the
   * corpus's cross-cohort coverage.
   */
  sampleSize: number;
  /**
   * Distinct sites with at least one successful load, INCLUDING request-capped
   * recordings (which are covered but not statistically measured). Optional:
   * stats files generated before this field existed omit it.
   */
  coverageSiteCount?: number;
  /**
   * Distinct covered sites with an exact request-recording cap in at least
   * one successfully loaded arm. Optional for older generated artifacts.
   */
  cappedSiteCount?: number;
  /** Cohort backing the legacy top-level sampleSize/metrics compatibility view. */
  primaryCohortId?: string;
  /**
   * Separate distributions; schema, methodology, producer, and requested-GPC
   * cohorts are never pooled.
   */
  cohorts?: CorpusStatsCohort[];
  metrics: Partial<Record<CorpusMetricKey, MetricDistribution>>;
};

export type SeverityLevel = "ok" | "quiet" | "info" | "warn" | "loud";

/**
 * Minimum distinct real sites before percentile language is used. Below this the
 * findings keep the fixed reference-threshold wording.
 */
export const CORPUS_MIN_SAMPLE = 50;

const METRIC_LABELS: Record<CorpusMetricKey, string> = {
  thirdPartyRequests: "third-party requests",
  thirdPartyDomains: "third-party domains",
  // The summary field counts every catalogued match, operational services
  // included, so the public label must not call them all trackers.
  knownTrackerRequests: "catalogued-service requests",
  thirdPartyCookies: "third-party cookies",
  fingerprintEvents: "fingerprint-like API calls"
};

export function corpusIsUsable(corpus: CorpusStats | null): corpus is CorpusStats {
  return corpus !== null && Number.isFinite(corpus.sampleSize) && corpus.sampleSize >= CORPUS_MIN_SAMPLE;
}

/**
 * Map a metric value to a severity level + plain-language label using corpus
 * percentiles. Returns `null` when the corpus is missing, too small, or lacks a
 * distribution for the metric, callers should then use their fixed-threshold
 * fallback.
 */
export function corpusBenchmark(
  corpus: CorpusStats | null,
  key: CorpusMetricKey,
  value: number
): { level: SeverityLevel; label: string } | null {
  if (!corpusIsUsable(corpus)) return null;

  const distribution = corpus.metrics[key];
  // Family-specific capture loss can make a metric distribution narrower
  // than its cohort. A large request-complete cohort does not authorize a
  // percentile claim from (for example) only a handful of cookie-complete
  // runs, so the honesty gate applies to the metric's actual denominator too.
  if (
    !distribution ||
    !Number.isSafeInteger(distribution.count) ||
    distribution.count < CORPUS_MIN_SAMPLE
  ) {
    return null;
  }

  const label = METRIC_LABELS[key];
  // "Fully measured": failed and request-capped visits are excluded from the
  // distribution, so the cohort is smaller than everything ever scanned.
  const sites = `${distribution.count.toLocaleString("en-US")} sites measured for this metric`;

  // Anchored to the percentile mark, not a share of sites: with heavy ties a
  // value AT the mark can exceed far fewer than 90% of sites, so "more than
  // 90% of sites" would overclaim. "At or above the mark" is true by
  // construction.
  if (value <= 0) return { level: "ok", label: `No ${label} observed.` };
  if (value >= distribution.p90)
    return { level: "loud", label: `At or above the 90th-percentile mark for ${label} across the ${sites}.` };
  if (value >= distribution.p75)
    return { level: "warn", label: `At or above the 75th-percentile mark for ${label} across the ${sites}.` };
  if (value >= distribution.p50) return { level: "info", label: `At or above the median for ${label} across the ${sites}.` };
  return { level: "quiet", label: `Below the median for ${label} across the ${sites}.` };
}

/**
 * Select a named methodology cohort for consumers that know the report's
 * cohort identity. The returned top-level compatibility view keeps existing
 * benchmark callers unchanged while preventing cross-cohort use.
 */
export function selectCorpusStatsCohort(corpus: CorpusStats | null, cohortId: string): CorpusStats | null {
  if (!corpus?.cohorts) return null;
  const cohort = corpus.cohorts.find((candidate) => candidate.id === cohortId);
  if (!cohort) return null;
  return {
    ...corpus,
    primaryCohortId: cohort.id,
    sampleSize: cohort.sampleSize,
    metrics: cohort.metrics
  };
}

export function isCorpusStats(value: unknown): value is CorpusStats {
  if (!isRecord(value)) return false;
  if (typeof value.version !== "number" || typeof value.generatedAt !== "string" || typeof value.sampleSize !== "number") {
    return false;
  }
  if (value.coverageSiteCount !== undefined && typeof value.coverageSiteCount !== "number") {
    return false;
  }
  if (value.cappedSiteCount !== undefined && typeof value.cappedSiteCount !== "number") {
    return false;
  }
  if (value.primaryCohortId !== undefined && typeof value.primaryCohortId !== "string") return false;
  if (value.cohorts !== undefined && (!Array.isArray(value.cohorts) || !value.cohorts.every(isCorpusStatsCohort))) {
    return false;
  }
  if (!isRecord(value.metrics)) return false;
  return Object.values(value.metrics).every(isMetricDistribution);
}

function isCorpusStatsCohort(value: unknown): value is CorpusStatsCohort {
  if (!isRecord(value)) return false;
  if (
    typeof value.id !== "string" ||
    (value.schemaVersion !== 1 && value.schemaVersion !== 2) ||
    !(
      value.schemaRevision === null ||
      value.schemaRevision === 1 ||
      value.schemaRevision === 2
    ) ||
    typeof value.methodologyVersion !== "string" ||
    (value.methodologyOrigin !== "recorded" && value.methodologyOrigin !== "legacy-derived") ||
    !(value.producer === null || typeof value.producer === "string") ||
    // Required, not optional: an artifact generated before the GPC condition
    // joined the key cannot be trusted to keep the two eras apart, and reading
    // it as if it could would republish a pooled distribution.
    typeof value.gpc !== "boolean" ||
    // Also required: primary selection ranks on recency, so an artifact that
    // cannot date its own cohorts cannot justify the cohort it named.
    !(value.latestRunAt === null || typeof value.latestRunAt === "string") ||
    typeof value.sampleSize !== "number" ||
    !Number.isFinite(value.sampleSize) ||
    !isRecord(value.metrics)
  ) {
    return false;
  }
  return Object.values(value.metrics).every(isMetricDistribution);
}

function isMetricDistribution(value: unknown): value is MetricDistribution {
  if (!isRecord(value)) return false;
  return (["count", "min", "max", "p50", "p75", "p90", "p95"] as const).every(
    (key) => typeof value[key] === "number" && Number.isFinite(value[key])
  );
}
