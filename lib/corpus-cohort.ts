import { canonicalJson } from "./canonical-json";
import { legacyV1MethodologyIdentity } from "./legacy-methodology";
import {
  METRIC_CONTRACT_DIGEST,
  METRIC_CONTRACT_VERSION
} from "./metric-contract";
import { displayRunView, type ReportView } from "./scan-report-views";
import {
  SERVICE_ROLE_TAXONOMY_DIGEST,
  SERVICE_ROLE_TAXONOMY_VERSION
} from "./service-role";
import { sha256Hex } from "./sha256";

/**
 * Public, auditable identity for one statistical measurement cohort.
 *
 * Schema revision, methodology, tracker-catalog identity, the read-time
 * ServiceRole taxonomy, and the metric formula contract are deliberately part
 * of the key. Producer identity is included when it was recorded because
 * PageGraph imports and browser observations do not measure the same evidence
 * surface. Build, browser patch, acquisition route, and egress remain row-level
 * provenance: splitting on each of those would turn every deployment into an
 * unusably small cohort, while methodologyVersion is the producer's reviewed
 * promise about when the meaning of the measurements changes.
 *
 * r2 records the tracker catalog's content digest. Frozen v1 did not, so its
 * strongest available identity is a SHA-256 hash of the catalog metadata that
 * survived into the version-aware read view. The origin stays explicit: a
 * legacy metadata hash is never represented as if v1 had recorded a content
 * digest. ServiceRole is intentionally a read-time interpretation rather than
 * a mutation of immutable report wires, so its current version and digest join
 * every cohort that derives tracking/operational semantics from it. The metric
 * contract separately binds the exact row-level formulas that consume those
 * role decisions.
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
  /** Recorded r2 content digest, or a canonical hash of v1's recorded metadata. */
  trackerCatalogDigest: string;
  /** Makes the weaker legacy metadata identity impossible to mistake for an r2 content digest. */
  trackerCatalogOrigin: "recorded" | "legacy-metadata-hash";
  /** Current read-time ServiceRole taxonomy applied to this immutable report. */
  serviceRoleTaxonomyVersion: string;
  /** SHA-256 identity of the exact read-time ServiceRole taxonomy. */
  serviceRoleTaxonomyDigest: string;
  /** Current read-time request-metric formula contract. */
  metricContractVersion: string;
  /** SHA-256 identity of the exact request-metric formula contract. */
  metricContractDigest: string;
};

export type CorpusCohortIdentityComponents = Omit<CorpusCohortIdentity, "id">;

/**
 * Canonical public encoding of the typed cohort identity.
 *
 * Readers use the same function to reject an artifact whose readable fields
 * disagree with its lookup key; maintaining a second string template would
 * recreate the exact identity-drift class this key exists to prevent.
 */
export function corpusCohortIdForIdentity(cohort: CorpusCohortIdentityComponents): string {
  if (
    (cohort.schemaVersion === 1 && cohort.schemaRevision !== null) ||
    (cohort.schemaVersion === 2 && cohort.schemaRevision === null)
  ) {
    throw new Error("Corpus cohort schema generation and revision are inconsistent.");
  }
  const schema =
    cohort.schemaVersion === 1 ? "v1" : `v2-r${cohort.schemaRevision}`;
  const producer = cohort.producer ?? "producer-unrecorded";
  const roleTaxonomy =
    `${encodeURIComponent(cohort.serviceRoleTaxonomyVersion)}-${cohort.serviceRoleTaxonomyDigest}`;
  const metricContract =
    `${encodeURIComponent(cohort.metricContractVersion)}-${cohort.metricContractDigest}`;
  return (
    `${schema}:${encodeURIComponent(cohort.methodologyVersion)}:${encodeURIComponent(producer)}` +
    `:gpc-${cohort.gpc ? "on" : "off"}` +
    `:catalog-${cohort.trackerCatalogOrigin}-${cohort.trackerCatalogDigest}` +
    `:roles-${roleTaxonomy}` +
    `:metrics-${metricContract}`
  );
}

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
      other.identity.schemaVersion !== candidate.identity.schemaVersion ||
      other.identity.trackerCatalogDigest !== candidate.identity.trackerCatalogDigest ||
      other.identity.trackerCatalogOrigin !== candidate.identity.trackerCatalogOrigin ||
      other.identity.serviceRoleTaxonomyVersion !== candidate.identity.serviceRoleTaxonomyVersion ||
      other.identity.serviceRoleTaxonomyDigest !== candidate.identity.serviceRoleTaxonomyDigest ||
      other.identity.metricContractVersion !== candidate.identity.metricContractVersion ||
      other.identity.metricContractDigest !== candidate.identity.metricContractDigest
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
 * The gate keys on schema, methodology, catalog, ServiceRole taxonomy, metric
 * contract, producer, AND the requested GPC condition, so naming a cohort by its
 * methodology alone can print byte-identical labels for two cohorts the gate
 * holds apart: after the gpc-off refresh, two categories differing only in the
 * requested signal both read "measured under one methodology cohort
 * (shields-request-context-v2-...)" while the page also tells the reader their
 * medians are not comparable.
 *
 * The raw id is not usable here: it percent-encodes its components. This
 * renders every field as prose, from the typed identity, so the label and the
 * gate cannot drift.
 */
/**
 * The human half of the cohort identity: everything a reader can act on, with the three
 * 64-character digests left out. The digests still identify the cohort exactly, so
 * `corpusCohortLabel` remains the full form for anyone verifying a report; this is what
 * belongs inline in prose.
 */
export function corpusCohortSummaryLabel(cohort: CorpusCohortIdentity): string {
  const schema =
    cohort.schemaVersion === 1 ? "schema v1" : `schema v2 revision ${cohort.schemaRevision ?? "unrecorded"}`;
  const producer = cohort.producer ?? "producer unrecorded";
  const gpc = cohort.gpc ? "GPC requested" : "GPC not requested";
  return `${cohort.methodologyVersion}, ${schema}, ${producer}, ${gpc}`;
}

export function corpusCohortLabel(cohort: CorpusCohortIdentity): string {
  const schema =
    cohort.schemaVersion === 1 ? "schema v1" : `schema v2 revision ${cohort.schemaRevision ?? "unrecorded"}`;
  const producer = cohort.producer ?? "producer unrecorded";
  const gpc = cohort.gpc ? "GPC requested" : "GPC not requested";
  const catalog =
    cohort.trackerCatalogOrigin === "recorded"
      ? `recorded catalog digest ${cohort.trackerCatalogDigest}`
      : `legacy catalog-metadata hash ${cohort.trackerCatalogDigest}`;
  const serviceRoles =
    `ServiceRole taxonomy ${cohort.serviceRoleTaxonomyVersion} digest ${cohort.serviceRoleTaxonomyDigest}`;
  const metricContract =
    `metric contract ${cohort.metricContractVersion} digest ${cohort.metricContractDigest}`;
  return `${cohort.methodologyVersion}, ${schema}, ${producer}, ${gpc}, ${catalog}, ${serviceRoles}, ${metricContract}`;
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
  if (distinct((cohort) => `${cohort.trackerCatalogOrigin}:${cohort.trackerCatalogDigest}`)) {
    differences.push("different tracker-catalog identities");
  }
  if (distinct((cohort) => `${cohort.serviceRoleTaxonomyVersion}:${cohort.serviceRoleTaxonomyDigest}`)) {
    differences.push("different ServiceRole taxonomies");
  }
  if (distinct((cohort) => `${cohort.metricContractVersion}:${cohort.metricContractDigest}`)) {
    differences.push("different metric contracts");
  }
  return differences;
}

export function corpusCohortIdentityForView(view: ReportView): CorpusCohortIdentity {
  const run = displayRunView(view);
  const methodologyVersion =
    run.provenance?.methodologyVersion ?? legacyV1MethodologyIdentity(run.conditions.disclosure ?? undefined);
  const producer = run.provenance?.observer ?? null;
  const schemaVersion = view.origin === "v2" ? 2 : 1;
  const schemaRevision = view.revision;
  const gpc = run.conditions.gpcEnabled;
  const trackerCatalog = trackerCatalogIdentityForView(view, run);
  const components: CorpusCohortIdentityComponents = {
    schemaVersion,
    schemaRevision,
    methodologyVersion,
    methodologyOrigin: run.provenance ? "recorded" : "legacy-derived",
    producer,
    gpc,
    trackerCatalogDigest: trackerCatalog.digest,
    trackerCatalogOrigin: trackerCatalog.origin,
    serviceRoleTaxonomyVersion: SERVICE_ROLE_TAXONOMY_VERSION,
    serviceRoleTaxonomyDigest: SERVICE_ROLE_TAXONOMY_DIGEST,
    metricContractVersion: METRIC_CONTRACT_VERSION,
    metricContractDigest: METRIC_CONTRACT_DIGEST
  };
  return { id: corpusCohortIdForIdentity(components), ...components };
}

function trackerCatalogIdentityForView(
  view: ReportView,
  run: ReturnType<typeof displayRunView>
): {
  digest: string;
  origin: CorpusCohortIdentity["trackerCatalogOrigin"];
} {
  if (view.origin === "v2") {
    const digest = run.toolchainIdentity?.trackerCatalogDigest;
    if (!digest) throw new Error("A v2 corpus cohort requires its recorded tracker-catalog digest.");
    return { digest, origin: "recorded" };
  }

  const metadata = run.conditions.trackerCatalog;
  if (!metadata) throw new Error("A v1 corpus cohort requires its recorded tracker-catalog metadata.");
  return {
    digest: sha256Hex(canonicalJson(metadata)),
    origin: "legacy-metadata-hash"
  };
}
