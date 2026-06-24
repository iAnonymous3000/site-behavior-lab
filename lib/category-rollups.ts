/**
 * Index-level "what kinds of sites load" rollups for the directory.
 *
 * Pure aggregation over one data point per scanned site (already deduped and
 * categorized by the caller), so it stays unit-testable and free of fs/Next deps.
 * Metrics describe the baseline (off / unprotected) run (what the site tried),
 * matching the rest of the report surface; `shieldsBlocked` is the third-party
 * requests a Shields comparison removed, when one exists for that site.
 */

export type RollupSite = {
  category: string;
  categoryLabel: string;
  trackerRequests: number;
  thirdPartyRequests: number;
  thirdPartyCookies: number;
  shieldsBlocked: number | null;
};

export type CategoryRollup = {
  id: string;
  label: string;
  siteCount: number;
  medianTrackers: number;
  medianThirdParty: number;
  medianCookies: number;
  medianShieldsBlocked: number | null;
};

/** Integer median of a list of counts. Empty list -> 0. */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const value = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  return Math.round(value);
}

/**
 * Group categorized sites and summarize each category by median behavior, heaviest
 * category (most median trackers) first. Sites with no category are excluded.
 */
export function buildCategoryRollups(sites: RollupSite[]): CategoryRollup[] {
  const byCategory = new Map<string, RollupSite[]>();
  for (const site of sites) {
    if (!site.category) continue;
    const list = byCategory.get(site.category);
    if (list) list.push(site);
    else byCategory.set(site.category, [site]);
  }

  const rollups: CategoryRollup[] = [];
  for (const [id, list] of byCategory) {
    const blocked = list.map((site) => site.shieldsBlocked).filter((value): value is number => value !== null);
    rollups.push({
      id,
      label: list[0].categoryLabel,
      siteCount: list.length,
      medianTrackers: median(list.map((site) => site.trackerRequests)),
      medianThirdParty: median(list.map((site) => site.thirdPartyRequests)),
      medianCookies: median(list.map((site) => site.thirdPartyCookies)),
      medianShieldsBlocked: blocked.length > 0 ? median(blocked) : null
    });
  }

  return rollups.sort(
    (a, b) =>
      b.medianTrackers - a.medianTrackers ||
      b.medianThirdParty - a.medianThirdParty ||
      a.label.localeCompare(b.label)
  );
}
