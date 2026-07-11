import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { runHitRequestCap } from "./comparison-eligibility";
import type { CorpusMetricKey, CorpusStats, MetricDistribution } from "./corpus-stats";
import { isReservedReportDomain } from "./reserved-report-domains";
import { readStoredScanReport } from "./scan-report-reader";
import type { ScanReport, ScanResult } from "./types";

/**
 * Computes percentile distributions of key behavior metrics across the
 * committed report corpus (public/corpus-stats.json; consumed by the findings
 * board via lib/corpus-stats). Ported from the former MJS script so
 * recognition goes through the canonical version-aware deep reader (RFC 14.8):
 * a malformed report is SKIPPED WITH A WARNING instead of contributing
 * silently zero-coerced values that drag every percentile down.
 *
 * One data point per distinct real site (most recent scan wins) so repeated
 * scans of the same domain do not skew the distribution. Reserved/test
 * domains (the canonical lib/reserved-report-domains.json list, which the old
 * script only partially copied) and error/block-page loads are excluded so
 * the corpus reflects measured real-site behavior only.
 *
 * Node-only module (filesystem); used by the CLI wrapper the build scripts
 * and workflows invoke. Never imported by app, worker, or browser code.
 */

const REPORT_FILE_PATTERN = /^[0-9]{8}-[0-9a-f]{32}\.json$/;
const METRIC_KEYS: CorpusMetricKey[] = [
  "thirdPartyRequests",
  "thirdPartyDomains",
  "knownTrackerRequests",
  "thirdPartyCookies",
  "fingerprintEvents"
];

export type CorpusStatsBuildResult = {
  stats: CorpusStats;
  /** One line per skipped file, already formatted for the build log. */
  warnings: string[];
};

export async function buildCorpusStats(reportsDir: string, now = new Date()): Promise<CorpusStatsBuildResult> {
  const warnings: string[] = [];
  const bySite = new Map<string, { scannedAt: string; metrics: Record<CorpusMetricKey, number> }>();
  // Coverage and measurement are different concepts: a request-capped run is
  // a site the corpus COVERS (it loaded) but not one it statistically
  // MEASURES, so the two counts are reported separately.
  const coverageDomains = new Set<string>();

  for (const file of await listReportFiles(reportsDir)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path.join(reportsDir, file), "utf8")) as unknown;
    } catch (error) {
      warnings.push(`Skipping unparseable corpus report ${file}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }

    const read = readStoredScanReport(parsed);
    if (!read.ok) {
      warnings.push(`Skipping corpus report ${file}: ${read.error}${read.violations ? ` (${read.violations[0]})` : ""}`);
      continue;
    }
    if (read.stored.schemaVersion !== 1) {
      warnings.push(`Skipping corpus report ${file}: schemaVersion 2 metrics are not comparable to the v1 distribution.`);
      continue;
    }

    // Use the baseline (the plain "off" state) of any comparison so the corpus
    // distribution stays comparable to a normal single scan. The "on" variant
    // is a protected state (Shields/GPC enabled) that no default scan is in,
    // so ranking ordinary scans against it would misrank nearly every site.
    const report: ScanReport = read.stored.report;
    const result: ScanResult = report.reportType === "comparison" ? report.baseline : report;

    // A run that answered with an HTTP error (403/401/429 bot walls, outages)
    // reflects an error page, not the site: its near-zero counts would drag
    // the percentile distribution down and misrank every real site against
    // it. The per-report pages already disclose these as failed loads.
    if (typeof result.summary.status === "number" && result.summary.status >= 400) continue;

    const domain = normalizeDomain(result.summary.firstPartyDomain);
    if (!domain || isReservedReportDomain(domain)) continue;
    coverageDomains.add(domain);

    // A run that hit the request-recording cap has activity counts that are
    // floors cut off mid-collection (and cookie/storage snapshots of an
    // interrupted visit), not the site's measured behavior: including
    // them clamps the distribution's tail to the cap (the heaviest sites are
    // exactly the ones that cap) and misranks every real site against a
    // truncated ceiling. The per-report pages disclose capped runs as cut
    // short.
    if (runHitRequestCap(result)) continue;

    const scannedAt = result.conditions.scannedAt;
    const existing = bySite.get(domain);
    if (existing && Date.parse(existing.scannedAt) >= Date.parse(scannedAt)) continue;

    bySite.set(domain, {
      scannedAt,
      // The deep guard already proved every summary count is a finite number,
      // so the values are copied verbatim; there is no zero-coercion path.
      metrics: Object.fromEntries(METRIC_KEYS.map((key) => [key, result.summary[key]])) as Record<CorpusMetricKey, number>
    });
  }

  const sites = Array.from(bySite.values());
  const metrics: Partial<Record<CorpusMetricKey, MetricDistribution>> = {};
  for (const key of METRIC_KEYS) {
    const values = sites.map((site) => site.metrics[key]).sort((a, b) => a - b);
    if (values.length === 0) continue;
    metrics[key] = {
      count: values.length,
      min: values[0],
      max: values[values.length - 1],
      p50: percentile(values, 50),
      p75: percentile(values, 75),
      p90: percentile(values, 90),
      p95: percentile(values, 95)
    };
  }

  return {
    stats: {
      version: 1,
      generatedAt: now.toISOString(),
      sampleSize: sites.length,
      coverageSiteCount: coverageDomains.size,
      metrics
    },
    warnings
  };
}

async function listReportFiles(reportsDir: string): Promise<string[]> {
  try {
    const entries = await readdir(reportsDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && REPORT_FILE_PATTERN.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT")) {
      return [];
    }
    throw error;
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function normalizeDomain(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
}
