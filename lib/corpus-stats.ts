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

import { canonicalJson } from "./canonical-json";
import {
  corpusCohortIdForIdentity,
  type CorpusCohortIdentity
} from "./corpus-cohort";
import { isRecord } from "./guards";

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
  version: 1 | 2 | 3;
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
   * Separate distributions; schema, methodology, catalog, ServiceRole
   * taxonomy, producer, and requested-GPC cohorts are never pooled.
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

/**
 * Corpus artifact schema. Version 3 makes tracker-catalog and read-time
 * ServiceRole identities mandatory for every cohort, so a reader can no
 * longer mistake differently interpreted catalogued-service counts for one
 * substitutable distribution.
 */
export const CORPUS_STATS_ARTIFACT_VERSION = 3;

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
  // This is a parser boundary, so it must be total over arbitrary values.
  // In particular, corpusCohortIdForIdentity uses encodeURIComponent for its
  // public key and malformed Unicode such as a lone surrogate makes that
  // primitive throw. A hostile artifact is invalid input, never an exception
  // that may escape into the page loading it.
  try {
    return isCorpusStatsValue(value);
  } catch {
    return false;
  }
}

function isCorpusStatsValue(value: unknown): value is CorpusStats {
  if (!isRecord(value)) return false;
  if (
    (value.version !== 1 && value.version !== 2 && value.version !== CORPUS_STATS_ARTIFACT_VERSION) ||
    !isCanonicalIsoTimestamp(value.generatedAt) ||
    !isNonnegativeSafeInteger(value.sampleSize)
  ) {
    return false;
  }
  if (value.coverageSiteCount !== undefined && !isNonnegativeSafeInteger(value.coverageSiteCount)) {
    return false;
  }
  if (value.cappedSiteCount !== undefined && !isNonnegativeSafeInteger(value.cappedSiteCount)) {
    return false;
  }
  if (
    value.coverageSiteCount !== undefined &&
    (value.coverageSiteCount < value.sampleSize ||
      (value.cappedSiteCount !== undefined && value.cappedSiteCount > value.coverageSiteCount))
  ) {
    return false;
  }
  if (value.primaryCohortId !== undefined && typeof value.primaryCohortId !== "string") return false;
  if (!isRecord(value.metrics) || !metricsFitSample(value.metrics, value.sampleSize)) return false;
  if (value.version === CORPUS_STATS_ARTIFACT_VERSION) {
    if (!Array.isArray(value.cohorts) || !value.cohorts.every(isCorpusStatsCohort)) return false;
    const ids = new Set(value.cohorts.map((cohort) => cohort.id));
    if (ids.size !== value.cohorts.length) return false;
    if (value.cohorts.some((cohort) => cohort.id !== corpusCohortIdForIdentity(cohort))) return false;

    if (value.cohorts.length === 0) {
      if (value.primaryCohortId !== undefined || value.sampleSize !== 0 || Object.keys(value.metrics).length !== 0) {
        return false;
      }
    } else {
      if (typeof value.primaryCohortId !== "string") return false;
      const primary = value.cohorts.find((cohort) => cohort.id === value.primaryCohortId);
      if (
        !primary ||
        value.sampleSize !== primary.sampleSize ||
        canonicalJson(value.metrics) !== canonicalJson(primary.metrics)
      ) {
        return false;
      }
    }
  } else if (value.cohorts !== undefined) {
    // Versions 1 and 2 predate the complete catalog/taxonomy key. Accepting
    // their cohort arrays would make an incomplete identity look current.
    return false;
  }
  return true;
}

function isCorpusStatsCohort(value: unknown): value is CorpusStatsCohort {
  if (!isRecord(value)) return false;
  if (
    typeof value.id !== "string" ||
    !(
      (value.schemaVersion === 1 && value.schemaRevision === null) ||
      (value.schemaVersion === 2 && (value.schemaRevision === 1 || value.schemaRevision === 2))
    ) ||
    typeof value.methodologyVersion !== "string" ||
    (value.methodologyOrigin !== "recorded" && value.methodologyOrigin !== "legacy-derived") ||
    !(value.producer === null || typeof value.producer === "string") ||
    // Required, not optional: an artifact generated before the GPC condition
    // joined the key cannot be trusted to keep the two eras apart, and reading
    // it as if it could would republish a pooled distribution.
    typeof value.gpc !== "boolean" ||
    !isSha256(value.trackerCatalogDigest) ||
    (value.trackerCatalogOrigin !== "recorded" && value.trackerCatalogOrigin !== "legacy-metadata-hash") ||
    typeof value.serviceRoleTaxonomyVersion !== "string" ||
    value.serviceRoleTaxonomyVersion.length === 0 ||
    !isSha256(value.serviceRoleTaxonomyDigest) ||
    // Also required: primary selection ranks on recency, so an artifact that
    // cannot date its own cohorts cannot justify the cohort it named.
    !(value.latestRunAt === null || isCanonicalIsoTimestamp(value.latestRunAt)) ||
    !isNonnegativeSafeInteger(value.sampleSize) ||
    !isRecord(value.metrics)
  ) {
    return false;
  }
  // These fields are one versioned provenance statement, not independent
  // enums. Frozen v1 never recorded a producer or a catalog content digest;
  // v2 always records both provenance and the exact catalog digest.
  if (
    value.schemaVersion === 1
      ? value.methodologyOrigin !== "legacy-derived" ||
        value.producer !== null ||
        value.trackerCatalogOrigin !== "legacy-metadata-hash"
      : value.methodologyOrigin !== "recorded" ||
        typeof value.producer !== "string" ||
        value.producer.length === 0 ||
        value.trackerCatalogOrigin !== "recorded"
  ) {
    return false;
  }
  return metricsFitSample(value.metrics, value.sampleSize);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isMetricDistribution(value: unknown): value is MetricDistribution {
  if (!isRecord(value)) return false;
  // An empty measurement family is omitted by the builder; publishing
  // percentile marks with a zero denominator would invent a distribution.
  if (!isNonnegativeSafeInteger(value.count) || value.count === 0) return false;
  if (
    !(
      isNonnegativeFiniteNumber(value.min) &&
      isNonnegativeFiniteNumber(value.max) &&
      isNonnegativeFiniteNumber(value.p50) &&
      isNonnegativeFiniteNumber(value.p75) &&
      isNonnegativeFiniteNumber(value.p90) &&
      isNonnegativeFiniteNumber(value.p95)
    )
  ) {
    return false;
  }
  return (
    value.min <= value.p50 &&
    value.p50 <= value.p75 &&
    value.p75 <= value.p90 &&
    value.p90 <= value.p95 &&
    value.p95 <= value.max
  );
}

function metricsFitSample(metrics: Record<string, unknown>, sampleSize: number): boolean {
  return Object.values(metrics).every(
    (distribution) => isMetricDistribution(distribution) && distribution.count <= sampleSize
  );
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isNonnegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isCanonicalIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}
