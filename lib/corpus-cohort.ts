import { legacyV1MethodologyIdentity } from "./legacy-methodology";
import { displayRunView, type ReportView } from "./scan-report-views";

/**
 * Public, auditable identity for one statistical measurement cohort.
 *
 * Schema revision and methodology are deliberately part of the key. Producer
 * identity is included when it was recorded because PageGraph imports and
 * browser observations do not measure the same evidence surface. Build,
 * browser patch, acquisition route, and egress remain row-level provenance:
 * splitting on each of those would turn every deployment into an unusably
 * small cohort, while methodologyVersion is the producer's reviewed promise
 * about when the meaning of the measurements changes.
 *
 * The requested GPC state joins them because it is a measured condition, not
 * environment: comparison eligibility already refuses to compare two arms that
 * differ in it. It also changed what the corpus could observe at all. While
 * every lane sent GPC, the injector could not add the signal to a blob: worker
 * without changing that realm's origin, so it blocked those workers and
 * censored the request family on 80 committed reports across 30 domains. Their
 * truncated floors already median 93 third-party requests to the measured
 * population's 25, so pooling the two eras would pool two different inclusion
 * criteria and move published percentiles by an unmarked amount.
 */
export type CorpusCohortIdentity = {
  id: string;
  schemaVersion: 1 | 2;
  schemaRevision: 1 | 2 | null;
  methodologyVersion: string;
  methodologyOrigin: "recorded" | "legacy-derived";
  producer: string | null;
  /** Whether the cohort's lead runs requested Global Privacy Control. */
  gpc: boolean;
};

/**
 * Minimum distinct sites before a cohort may back a corpus-wide aggregate.
 * Mirrors CORPUS_MIN_SAMPLE, which lib/corpus-stats.ts owns; it is restated as
 * a parameter rather than imported so this module stays free of the stats
 * artifact's shape, and {@link selectPrimaryCorpusCohort} takes the floor from
 * its caller.
 */
export type CorpusCohortCandidate<Identity extends CorpusCohortIdentity = CorpusCohortIdentity> = {
  identity: Identity;
  /** Distinct sites the cohort measures. */
  siteCount: number;
  /** Newest eligible measurement in the cohort, ISO-8601, or null when unrecorded. */
  latestRunAt: string | null;
};

/**
 * Choose the ONE cohort a corpus-wide aggregate speaks for.
 *
 * Size alone is the wrong rule and used to be this repository's: a cohort keyed
 * on an UNRECORDED methodology can never receive another scan, because every
 * current producer records one. The legacy v1 cohort was therefore frozen at 85
 * sites while the current-methodology cohort held 71 fresher ones, so "largest
 * wins" pinned every published percentile, and the status page's own freshness
 * badge, to measurements that no amount of scanning could refresh.
 *
 * So: among cohorts that clear `minSiteCount` and can still carry percentile
 * language, the newest evidence wins; ties break by size, then by id. The floor
 * is a gate, not a second ranking: it stops a handful of sites from the first
 * partial refresh of a new era from taking the aggregate away from a cohort
 * that can still support percentiles. When nothing clears it the same recency
 * rule applies to everything, because no percentile language is published in
 * that state anyway and the newest evidence is the more honest thing to date
 * the corpus by.
 *
 * v1 keeps precedence while v1 remains the deployed benchmark source. Promoting
 * an r2 cohort is a separate, deliberate policy change, not a side effect of it
 * happening to be newer.
 */
export function selectPrimaryCorpusCohort<Identity extends CorpusCohortIdentity>(
  candidates: readonly CorpusCohortCandidate<Identity>[],
  minSiteCount: number
): CorpusCohortCandidate<Identity> | null {
  if (candidates.length === 0) return null;
  const legacy = candidates.filter((candidate) => candidate.identity.schemaVersion === 1);
  const generation = legacy.length > 0 ? legacy : candidates;
  const usable = generation.filter((candidate) => candidate.siteCount >= minSiteCount);
  const pool = usable.length > 0 ? usable : generation;
  return [...pool].sort((left, right) => {
    const leftAt = Date.parse(left.latestRunAt ?? "");
    const rightAt = Date.parse(right.latestRunAt ?? "");
    const leftRank = Number.isFinite(leftAt) ? leftAt : Number.NEGATIVE_INFINITY;
    const rightRank = Number.isFinite(rightAt) ? rightAt : Number.NEGATIVE_INFINITY;
    return (
      rightRank - leftRank ||
      right.siteCount - left.siteCount ||
      left.identity.id.localeCompare(right.identity.id)
    );
  })[0];
}

export function corpusCohortIdentityForView(view: ReportView): CorpusCohortIdentity {
  const run = displayRunView(view);
  const methodologyVersion =
    run.provenance?.methodologyVersion ?? legacyV1MethodologyIdentity(run.conditions.disclosure ?? undefined);
  const producer = run.provenance?.observer ?? null;
  const schemaVersion = view.origin === "v2" ? 2 : 1;
  const schemaRevision = view.revision;
  const schema = schemaVersion === 1 ? "v1" : `v2-r${schemaRevision}`;
  const producerKey = producer ?? "producer-unrecorded";
  const gpc = run.conditions.gpcEnabled;

  return {
    id: `${schema}:${encodeURIComponent(methodologyVersion)}:${encodeURIComponent(producerKey)}:gpc-${gpc ? "on" : "off"}`,
    schemaVersion,
    schemaRevision,
    methodologyVersion,
    methodologyOrigin: run.provenance ? "recorded" : "legacy-derived",
    producer,
    gpc
  };
}
