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

export type CorpusStats = {
  version: number;
  generatedAt: string;
  /**
   * Distinct sites in the measured sample: newest lead run loaded (HTTP < 400)
   * and was not cut off by the request-recording cap. This is the percentile
   * basis and is smaller than the corpus's coverage.
   */
  sampleSize: number;
  /**
   * Distinct sites with at least one successful load, INCLUDING request-capped
   * recordings (which are covered but not statistically measured). Optional:
   * stats files generated before this field existed omit it.
   */
  coverageSiteCount?: number;
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
  if (!distribution) return null;

  const label = METRIC_LABELS[key];
  // "Fully measured": failed and request-capped visits are excluded from the
  // distribution, so the cohort is smaller than everything ever scanned.
  const sites = `${corpus.sampleSize.toLocaleString("en-US")} fully measured sites`;

  if (value <= 0) return { level: "ok", label: `No ${label} observed.` };
  if (value >= distribution.p90) return { level: "loud", label: `More ${label} than about 90% of the ${sites}.` };
  if (value >= distribution.p75) return { level: "warn", label: `More ${label} than about 75% of the ${sites}.` };
  if (value >= distribution.p50) return { level: "info", label: `More ${label} than about half of the ${sites}.` };
  return { level: "quiet", label: `Fewer ${label} than most of the ${sites}.` };
}

export function isCorpusStats(value: unknown): value is CorpusStats {
  if (!isRecord(value)) return false;
  if (typeof value.version !== "number" || typeof value.generatedAt !== "string" || typeof value.sampleSize !== "number") {
    return false;
  }
  if (value.coverageSiteCount !== undefined && typeof value.coverageSiteCount !== "number") {
    return false;
  }
  if (!isRecord(value.metrics)) return false;
  return Object.values(value.metrics).every(isMetricDistribution);
}

function isMetricDistribution(value: unknown): value is MetricDistribution {
  if (!isRecord(value)) return false;
  return (["count", "min", "max", "p50", "p75", "p90", "p95"] as const).every(
    (key) => typeof value[key] === "number" && Number.isFinite(value[key])
  );
}
