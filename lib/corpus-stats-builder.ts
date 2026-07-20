import { runRequestEvidenceCapped } from "./comparison-eligibility";
import { corpusSiteDomainKey } from "./corpus-site-domain";
import type { CorpusMetricKey, CorpusStats, MetricDistribution } from "./corpus-stats";
import { isReservedReportDomain } from "./reserved-report-domains";
import { runHitRequestRecordingCap, toReportView } from "./scan-report-view";
import {
  listDanglingStaticSidecarIds,
  listStaticReportCandidateIds,
  readStaticReportBundle,
  StaticReportBundleError
} from "./static-report-files";
import type { ScanReport, ScanResult } from "./types";

/**
 * Computes percentile distributions of key behavior metrics across the
 * committed report corpus (public/corpus-stats.json; consumed by the findings
 * board via lib/corpus-stats). Ported from the former MJS script so
 * recognition goes through the canonical version-aware deep reader (RFC 14.8):
 * a malformed or unmanaged report fails the managed-corpus build instead of
 * silently disappearing or contributing zero-coerced values.
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
  const cappedDomains = new Set<string>();

  const dangling = await listDanglingStaticSidecarIds(reportsDir);
  if (dangling.length > 0) throw new StaticReportBundleError(dangling[0], "dangling-sidecar");

  for (const id of await listStaticReportCandidateIds(reportsDir)) {
    const file = `${id}.json`;
    const read = await readStaticReportBundle(reportsDir, id);
    if (read.outcome !== "found") {
      throw new StaticReportBundleError(id, read.outcome === "not-found" ? "missing-report" : read.reason);
    }

    // Coverage spans the primary pair, while percentile metrics deliberately
    // use only the lead run. A comparison therefore covers its catalogued site
    // when either primary arm loaded successfully, and is cap-flagged when one
    // hit the exact request-recording cap. The domain sets prevent double counts.
    const view = toReportView(read.stored);
    const domain = corpusSiteDomainKey(view.domain);
    const successfulRuns = view.runs.filter(
      (run) => run.quality.outcome === "complete" && typeof run.status === "number" && run.status < 400
    );
    if (domain && !isReservedReportDomain(domain) && successfulRuns.length > 0) {
      coverageDomains.add(domain);
      if (successfulRuns.some(runHitRequestRecordingCap)) cappedDomains.add(domain);
    }

    if (read.stored.schemaVersion !== 1) {
      // v2 metrics stay out of the v1 percentile distribution, but a loaded
      // v2 report still proves the site was scanned: coverage would otherwise
      // silently shrink as v1 reports prune away while their sites remain in
      // the corpus with v2 evidence.
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
    // reflects an error page, not the site, and a null status means the main
    // document never produced a response at all (timeout, refused connect):
    // either way the near-zero counts would drag the percentile distribution
    // down and misrank every real site against it. The per-report pages
    // already disclose these as failed loads.
    if (typeof result.summary.status !== "number" || result.summary.status >= 400) continue;

    const leadDomain = corpusSiteDomainKey(result.summary.firstPartyDomain);
    if (!leadDomain || isReservedReportDomain(leadDomain)) continue;

    // A run that hit the request-recording cap has activity counts that are
    // floors cut off mid-collection (and cookie/storage snapshots of an
    // interrupted visit), not the site's measured behavior: including
    // them clamps the distribution's tail to the cap (the heaviest sites are
    // exactly the ones that cap) and misranks every real site against a
    // truncated ceiling. The per-report pages disclose capped runs as cut
    // short.
    if (runRequestEvidenceCapped(result)) continue;

    // A consent-interaction arm is a post-intervention state, not a default
    // visit: a consent comparison's baseline clicked "accept all" before
    // collection, so its counts describe the accepted-cookies experience.
    // Ranking ordinary scans against it would contaminate the cohort the
    // distribution claims to describe (the plain first visit). Covered, but
    // never measured.
    if (result.conditions.consentMode === "accept-all" || result.conditions.consentMode === "reject-all") continue;

    const scannedAt = result.conditions.scannedAt;
    const existing = bySite.get(leadDomain);
    if (existing && Date.parse(existing.scannedAt) >= Date.parse(scannedAt)) continue;

    bySite.set(leadDomain, {
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
      cappedSiteCount: cappedDomains.size,
      metrics
    },
    warnings
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}
