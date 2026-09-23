import type { CorpusCohortIdentity } from "./corpus-cohort";

/**
 * Which identity components differ across a set of cohorts, as reader-facing
 * nouns. Naming the wrong cause is its own defect: attributing a split to
 * "different methodology generations" when the real difference is the
 * requested GPC condition tells the reader to distrust the wrong thing.
 *
 * Its own module because the HOMEPAGE needs this function and nothing else
 * from corpus-cohort. Importing it from there pulled the version-aware report
 * views, the comparison modules, the ServiceRole taxonomy and SHA-256 into the
 * homepage's initial JavaScript, which is measured against an enforced gzip
 * budget. It reads only the typed identity, so the type import above is
 * erased at build time; corpus-cohort re-exports it, so every other consumer
 * is unchanged.
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
