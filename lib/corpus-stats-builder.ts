import {
  corpusCohortIdentityForView,
  selectPrimaryCorpusCohort,
  type CorpusCohortIdentity
} from "./corpus-cohort";
import { preferCorpusRepresentative } from "./corpus-representative";
import { corpusSiteDomainKey } from "./corpus-site-domain";
import {
  CORPUS_METRIC_KEYS,
  CORPUS_MIN_SAMPLE,
  CORPUS_STATS_ARTIFACT_VERSION,
  type CorpusMetricKey,
  type CurrentCorpusStats,
  type CorpusStatsCohort,
  type MetricDistribution
} from "./corpus-stats";
import {
  METRIC_CONTRACT_DIGEST,
  METRIC_CONTRACT_VERSION
} from "./metric-contract";
import { isReservedReportDomain } from "./reserved-report-domains";
import { buildRunFacts } from "./report-facts";
import { trackingServiceRequests } from "./report-insights";
import {
  displayRunView,
  runHitRequestRecordingCap,
  runInCorpusDistributionPopulation,
  toReportView
} from "./scan-report-view";
import {
  listDanglingStaticSidecarIds,
  listStaticReportCandidateIds,
  readStaticReportBundle,
  StaticReportBundleError
} from "./static-report-files";

/**
 * Computes percentile distributions of key behavior metrics across the
 * committed report corpus (public/corpus-stats.json; consumed by the findings
 * board via lib/corpus-stats). Ported from the former MJS script so
 * recognition goes through the canonical version-aware deep reader (RFC 14.8):
 * a malformed or unmanaged report fails the managed-corpus build instead of
 * silently disappearing or contributing zero-coerced values.
 *
 * One data point per distinct real site within each schema/methodology/
 * catalog/ServiceRole-taxonomy/producer/requested-GPC cohort (most recent
 * eligible scan wins), so repeated scans do not skew a distribution and
 * incompatible cohorts are never pooled.
 * A GPC-requesting lead run is split off rather than excluded: it stays
 * measured, but is only ever ranked against other GPC-requesting visits. Reserved/test
 * domains (the canonical lib/reserved-report-domains.json list, which the old
 * script only partially copied) and error/block-page loads are excluded so
 * the corpus reflects measured real-site behavior only.
 *
 * Node-only module (filesystem); used by the CLI wrapper the build scripts
 * and workflows invoke. Never imported by app, worker, or browser code.
 */

export type CorpusStatsBuildResult = {
  stats: CurrentCorpusStats;
  /** One line per skipped file, already formatted for the build log. */
  warnings: string[];
};

export async function buildCorpusStats(reportsDir: string, now = new Date()): Promise<CorpusStatsBuildResult> {
  const warnings: string[] = [];
  const byCohort = new Map<
    string,
    {
      identity: CorpusCohortIdentity;
      bySite: Map<
        string,
        {
          id: string;
          scannedAt: string;
          metrics: Record<CorpusMetricKey, number>;
          metricAvailability: Record<CorpusMetricKey, boolean>;
        }
      >;
    }
  >();
  // Coverage and measurement are different concepts: a request-capped run is
  // a site the corpus COVERS (it loaded) but not one it statistically
  // MEASURES, so the two counts are reported separately.
  const coverageDomains = new Set<string>();
  const cappedDomains = new Set<string>();

  const dangling = await listDanglingStaticSidecarIds(reportsDir);
  if (dangling.length > 0) throw new StaticReportBundleError(dangling[0], "dangling-sidecar");

  for (const id of await listStaticReportCandidateIds(reportsDir)) {
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

    // Use the canonical display/lead run: the plain "off" baseline for
    // intervention comparisons, and the newer variant for a temporal pair.
    // Protected intervention variants never enter the passive distribution.
    const result = displayRunView(view);

    // A run that answered with an HTTP error (403/401/429 bot walls, outages)
    // reflects an error page, not the site, and a null status means the main
    // document never produced a response at all (timeout, refused connect):
    // either way the near-zero counts would drag the percentile distribution
    // down and misrank every real site against it. The per-report pages
    // already disclose these as failed loads.
    if (result.quality.outcome !== "complete" || typeof result.status !== "number" || result.status >= 400) continue;

    const leadDomain = corpusSiteDomainKey(result.domain);
    if (!leadDomain || isReservedReportDomain(leadDomain)) continue;

    // A run that hit the request-recording cap has activity counts that are
    // floors cut off mid-collection (and cookie/storage snapshots of an
    // interrupted visit), not the site's measured behavior: including
    // them clamps the distribution's tail to the cap (the heaviest sites are
    // exactly the ones that cap) and misranks every real site against a
    // truncated ceiling. The per-report pages disclose capped runs as cut
    // short.
    //
    // A consent-interaction arm is a post-intervention state, not a default
    // visit: a consent comparison's baseline clicked "accept all" before
    // collection, so its counts describe the accepted-cookies experience.
    // Ranking ordinary scans against it would contaminate the cohort the
    // distribution claims to describe (the plain first visit). Covered, but
    // never measured.
    //
    // Both of those rules, plus the completion check above, live in
    // runInCorpusDistributionPopulation so the findings board applies exactly
    // the same population rule when it decides whether to show a percentile.
    if (!runInCorpusDistributionPopulation(result)) continue;

    // One definition of "when this report was measured", shared with
    // lib/corpus-overview.ts, which ranks the same cohorts by view.scannedAt
    // and hands them to the same selectPrimaryCorpusCohort. Recency is that
    // selector's first sort key, and the lead run's own start is a DIFFERENT
    // clock on every v1 comparison (the wire's report-level time is the
    // variant arm's start, so the two disagree by the baseline visit's
    // duration): ranking on it here would let the published artifact and the
    // rendered aggregate name different cohorts whenever two cohorts' newest
    // reports land within that skew. The same value also picks each site's
    // representative report, which the export and the directory decide with
    // view.scannedAt too.
    const scannedAt = view.scannedAt ?? "";
    if (!Number.isFinite(Date.parse(scannedAt))) continue;
    const identity = corpusCohortIdentityForView(view);
    const cohort = byCohort.get(identity.id) ?? { identity, bySite: new Map() };
    if (!byCohort.has(identity.id)) byCohort.set(identity.id, cohort);
    const existing = cohort.bySite.get(leadDomain);
    if (existing && !preferCorpusRepresentative({ id, scannedAt }, existing)) continue;
    const facts = buildRunFacts(result);

    cohort.bySite.set(leadDomain, {
      id,
      scannedAt,
      // The deep guard already proved every summary count is a finite number,
      // so the values are copied verbatim; there is no zero-coercion path.
      metrics: {
        thirdPartyRequests: result.counts.thirdPartyRequests,
        thirdPartyDomains: result.counts.thirdPartyDomains,
        cataloguedServiceRequests: result.counts.knownTrackerRequests,
        trackingServiceRequests: trackingServiceRequests(result.evidence),
        thirdPartyCookies: result.counts.thirdPartyCookies,
        fingerprintEvents: result.counts.fingerprintEvents
      },
      metricAvailability: {
        thirdPartyRequests: facts.claims["third-party-services"].benchmarkAllowed,
        thirdPartyDomains: facts.claims["third-party-services"].benchmarkAllowed,
        cataloguedServiceRequests: facts.claims["third-party-services"].benchmarkAllowed,
        trackingServiceRequests: facts.claims["third-party-services"].benchmarkAllowed,
        thirdPartyCookies: facts.claims["third-party-cookies"].benchmarkAllowed,
        fingerprintEvents: facts.claims["fingerprint-apis"].benchmarkAllowed
      }
    });
  }

  const cohorts: CorpusStatsCohort[] = [...byCohort.values()]
    .map(({ identity, bySite: sites }) => ({
      ...identity,
      sampleSize: sites.size,
      latestRunAt:
        [...sites.values()]
          .map((site) => site.scannedAt)
          .sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null,
      metrics: metricDistributions([...sites.values()])
    }))
    .sort((left, right) => left.id.localeCompare(right.id));

  // Keep the historical top-level fields as a compatibility view for current
  // findings consumers. It names exactly one cohort, never a pool, chosen by
  // the shared selector the directory leaderboard also calls so the artifact
  // and the rendered aggregate can never name different cohorts.
  // Site keys travel with each candidate so the selector can refuse to hand the
  // aggregate to a structurally narrower universe; `byCohort` already holds
  // them, keyed exactly as the eligibility pass counted them.
  const cohortSites = new Map(
    [...byCohort.values()].map(({ identity, bySite }) => [identity.id, [...bySite.keys()]] as const)
  );
  const primary = selectPrimaryCorpusCohort(
    cohorts.map((cohort) => ({
      identity: cohort,
      siteCount: cohort.sampleSize,
      latestRunAt: cohort.latestRunAt,
      sites: cohortSites.get(cohort.id) ?? []
    })),
    CORPUS_MIN_SAMPLE
  )?.identity;

  return {
    stats: {
      version: CORPUS_STATS_ARTIFACT_VERSION,
      generatedAt: now.toISOString(),
      metricContractVersion: METRIC_CONTRACT_VERSION,
      metricContractDigest: METRIC_CONTRACT_DIGEST,
      sampleSize: primary?.sampleSize ?? 0,
      coverageSiteCount: coverageDomains.size,
      cappedSiteCount: cappedDomains.size,
      ...(primary ? { primaryCohortId: primary.id } : {}),
      cohorts,
      metrics: primary?.metrics ?? {}
    },
    warnings
  };
}

function metricDistributions(
  sites: {
    metrics: Record<CorpusMetricKey, number>;
    metricAvailability: Record<CorpusMetricKey, boolean>;
  }[]
): Partial<Record<CorpusMetricKey, MetricDistribution>> {
  const metrics: Partial<Record<CorpusMetricKey, MetricDistribution>> = {};
  for (const key of CORPUS_METRIC_KEYS) {
    const values = sites
      .filter((site) => site.metricAvailability[key])
      .map((site) => site.metrics[key])
      .sort((a, b) => a - b);
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

  return metrics;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}
