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
  /**
   * Distinct site keys the cohort measures, when the caller knows them.
   *
   * Recency alone cannot tell whether a newer cohort describes the same
   * universe. Omit only when composition is genuinely unknown; an omitted set
   * is treated as "cannot be shown to be narrower" and leaves ranking to
   * recency, which is the behavior that existed before this guard.
   */
  sites?: readonly string[];
};

/**
 * How much of another qualifying cohort's site set a candidate may be missing
 * and still lead the aggregate.
 *
 * The corpus is two disjoint catalogs: a deliberately tracker-heavy gallery and
 * a de-bias seed list. When only one is rescanned, the resulting cohort clears
 * the site floor on its own and, being newest, took the aggregate — moving the
 * published median third-party requests from 11 to 87 with no site behaving
 * differently. A percentile is a claim about a population, so replacing the
 * population silently republishes a different question's answer.
 */
export const MAX_DROPPED_SITE_SHARE = 0.1;

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
  // Recency may not buy a narrower universe. A candidate leads only if it is
  // not missing a material share of any other qualifying cohort's sites; when
  // every candidate drops one of the others, no composition is comparable and
  // the broadest description is the honest one.
  const ranked = pool.filter((candidate) => !dropsAComparableCohortsSites(candidate, pool));
  const contenders = ranked.length > 0 ? ranked : [...pool].sort((left, right) => right.siteCount - left.siteCount).slice(0, 1);
  return [...contenders].sort((left, right) => {
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

function dropsAComparableCohortsSites<Identity extends CorpusCohortIdentity>(
  candidate: CorpusCohortCandidate<Identity>,
  pool: readonly CorpusCohortCandidate<Identity>[]
): boolean {
  const own = new Set(candidate.sites ?? []);
  if (own.size === 0) return false;
  return pool.some((other) => {
    if (other === candidate) return false;
    // Only cohorts on the SAME measurement line are substitutable descriptions
    // of the corpus. A different methodology or producer is a different
    // question, and a legacy cohort keyed on an unrecorded methodology can
    // never receive another scan, so neither may veto this one.
    if (
      other.identity.methodologyVersion !== candidate.identity.methodologyVersion ||
      other.identity.producer !== candidate.identity.producer ||
      other.identity.schemaVersion !== candidate.identity.schemaVersion
    ) {
      return false;
    }
    // Asymmetric on purpose: only a BROADER comparable cohort blocks. Blocking
    // in both directions would leave two partial refreshes vetoing each other
    // and hand the aggregate to whatever frozen cohort remained.
    const otherSites = other.sites ?? [];
    if (otherSites.length === 0 || other.siteCount <= candidate.siteCount) return false;
    const missing = otherSites.reduce((total, site) => (own.has(site) ? total : total + 1), 0);
    return missing / otherSites.length > MAX_DROPPED_SITE_SHARE;
  });
}

/**
 * Reader-facing name for a cohort, covering every component of its id.
 *
 * The gate keys on schema, methodology, producer AND the requested GPC
 * condition, so naming a cohort by its methodology alone can print byte-
 * identical labels for two cohorts the gate holds apart: after the gpc-off
 * refresh, two categories differing only in the requested signal both read
 * "measured under one methodology cohort (shields-request-context-v2-...)"
 * while the page also tells the reader their medians are not comparable.
 *
 * The raw id is not usable here: it percent-encodes its components. This
 * renders the same four fields as prose, from the typed identity, so the label
 * and the gate cannot drift.
 */
export function corpusCohortLabel(cohort: CorpusCohortIdentity): string {
  const schema =
    cohort.schemaVersion === 1 ? "schema v1" : `schema v2 revision ${cohort.schemaRevision ?? "unrecorded"}`;
  const producer = cohort.producer ?? "producer unrecorded";
  const gpc = cohort.gpc ? "GPC requested" : "GPC not requested";
  return `${cohort.methodologyVersion}, ${schema}, ${producer}, ${gpc}`;
}

/**
 * Which identity components differ across a set of cohorts, as reader-facing
 * nouns. Naming the wrong cause is its own defect: attributing a split to
 * "different methodology generations" when the real difference is the
 * requested GPC condition tells the reader to distrust the wrong thing.
 */
export function corpusCohortDifferences(cohorts: readonly CorpusCohortIdentity[]): string[] {
  const distinct = <T,>(pick: (cohort: CorpusCohortIdentity) => T) => new Set(cohorts.map(pick)).size > 1;
  const differences: string[] = [];
  if (distinct((cohort) => cohort.methodologyVersion)) differences.push("different methodology generations");
  if (distinct((cohort) => `${cohort.schemaVersion}:${cohort.schemaRevision}`)) differences.push("different schema revisions");
  if (distinct((cohort) => cohort.producer)) differences.push("different producers");
  if (distinct((cohort) => cohort.gpc)) differences.push("a different requested GPC condition");
  return differences;
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
