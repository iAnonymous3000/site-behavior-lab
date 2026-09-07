import adblockMetadata from "./adblock-wasm/brave-default-filters.meta.json";
import { entryEligibleForCorpusRollups, loadCorpusOverview } from "./corpus-overview";
import { currentScanRankingSentence, loadCommittedCorpusStats } from "./current-scan-cohort";
import { buildCategoryEvidencePages } from "./directory-view";
import { NODE_ADBLOCK_ENGINE_VERSION, NODE_PLAYWRIGHT_VERSION } from "./legacy-methodology";
import { trackerCatalogMetadata } from "./tracker-catalog";

import { readStatusSnapshot } from "./status-snapshot";

export async function loadStatusSnapshot() {
  const overview = await loadCorpusOverview();
  // The card's own sentence reports `siteCount`, which counts only the
  // aggregate cohort. Dating it from any eligible row would certify the
  // freshness of the aggregates using a report those aggregates exclude, so
  // the timestamp is scoped to the same cohort the number describes. That
  // scope is stated in the copy, and eligible evidence newer than this
  // cohort's is disclosed with its own derived date: without it, this card
  // and the directory can date the corpus three days apart on one build.
  const aggregateCohortId = overview.aggregateCohort?.id ?? null;
  const eligibleEntries = overview.entries.filter(
    (entry) => entryEligibleForCorpusRollups(entry) && Number.isFinite(Date.parse(entry.scannedAt))
  );
  const newestEligibleScannedAt = (entries: typeof eligibleEntries): string | null =>
    entries
      .map((entry) => entry.scannedAt)
      .sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null;
  const latestAggregateEvidence = newestEligibleScannedAt(
    eligibleEntries.filter((entry) => entry.corpusCohort.id === aggregateCohortId)
  );
  const latestEligibleEvidence = newestEligibleScannedAt(eligibleEntries);
  const newerEligibleOutsideAggregate =
    latestEligibleEvidence !== null &&
    (latestAggregateEvidence === null ||
      Date.parse(latestEligibleEvidence) > Date.parse(latestAggregateEvidence));
  // "Most committed pages rank against a different cohort than this one" is a
  // corpus-state fact, not a timeless one: one generation flip or one large
  // refresh can invert it. Derive it from the same entries the card counts so
  // corpus churn changes the sentence instead of falsifying it.
  const committedPagesOnAggregateCohort = overview.entries.filter(
    (entry) => entry.corpusCohort.id === aggregateCohortId
  ).length;
  const mostPagesRankElsewhere = committedPagesOnAggregateCohort * 2 < overview.entries.length;
  // Category medians are published one cohort per category and can land on
  // several cohorts during a methodology migration, so the aggregate cohort
  // above is not the whole published corpus. The homepage counts them from
  // exactly these pages; deriving the count here the same way keeps the two
  // surfaces from telling the reader different things.
  const categoryCohortCount = new Set(
    buildCategoryEvidencePages(overview.entries).map((category) => category.cohort.id)
  ).size;
  // What a scan run TODAY is ranked against depends on whether the committed
  // artifact holds a usable cohort for the current production tuple, which
  // changes both when the toolchain epoch moves and when the corpus refreshes.
  // The sentence is derived per build; a fixed sentence here was true only in
  // the gap between a methodology bump and the next refresh.
  const scanRankingSentence = currentScanRankingSentence(
    await loadCommittedCorpusStats(),
    aggregateCohortId
  );

  const datesBySite = new Map<string, string>();
  for (const entry of eligibleEntries) {
    if (entry.corpusCohort.id !== aggregateCohortId || entry.siteKey === null) continue;
    const previous = datesBySite.get(entry.siteKey);
    if (!previous || Date.parse(entry.scannedAt) > Date.parse(previous)) datesBySite.set(entry.siteKey, entry.scannedAt);
  }
  return readStatusSnapshot({
    schemaVersion: 1,
    sourceRevision: process.env.NEXT_PUBLIC_SITE_BEHAVIOR_LAB_BUILD_COMMIT || null,
    aggregateCohortId, latestAggregateEvidence, latestEligibleEvidence,
    newerEligibleOutsideAggregate, mostPagesRankElsewhere, categoryCohortCount,
    categoriesUseAggregateCohort: categoryCohortCount === 1 && buildCategoryEvidencePages(overview.entries).every((category) => category.cohort.id === aggregateCohortId),
    scanRankingSentence, siteCount: overview.siteCount, coverageSiteCount: overview.coverageSiteCount,
    v1ReportCount: overview.entries.filter((entry) => entry.corpusCohort.schemaVersion === 1).length,
    v2ReportCount: overview.entries.filter((entry) => entry.corpusCohort.schemaVersion === 2).length,
    aggregateSiteDates: [...datesBySite.values()],
    filterFetchedAt: adblockMetadata.fetchedAt, filterSourceCount: adblockMetadata.sourceCount,
    filterManifestDigest: adblockMetadata.manifestDigest,
    playwrightVersion: NODE_PLAYWRIGHT_VERSION, adblockEngineVersion: NODE_ADBLOCK_ENGINE_VERSION,
    catalogVersion: trackerCatalogMetadata.version, catalogEntries: trackerCatalogMetadata.entries
  });
}
