/**
 * Index-level "what kinds of sites load" rollups for the directory.
 *
 * Pure aggregation over one data point per scanned site (already deduped and
 * categorized by the caller), so it stays unit-testable and free of fs/Next deps.
 * Metrics describe the baseline (off / unprotected) run (what the site tried),
 * matching the rest of the report surface; `shieldsThirdPartyChange` is the
 * SIGNED third-party change of the site's eligible Shields pair (blocking
 * visit minus unblocked baseline; negative = fewer with blocking), when one
 * exists for that site. Increased pairs stay signed: clamping them to zero
 * would misreport an observed increase as "no change" in the medians.
 */

export type RollupSite = {
  category: string;
  categoryLabel: string;
  trackerRequests: number;
  thirdPartyRequests: number;
  /** null when this run's cookie family was unsupported or censored. */
  thirdPartyCookies: number | null;
  shieldsThirdPartyChange: number | null;
};

export type CategoryRollup = {
  id: string;
  label: string;
  siteCount: number;
  medianTrackers: number;
  medianThirdParty: number;
  /** null when no site in the category has complete cookie evidence. */
  medianCookies: number | null;
  /** Cookie-family denominator, which can be smaller than siteCount. */
  cookieMeasuredSites: number;
  /** Signed median of the category's paired-site changes; null with no pairs. */
  medianShieldsChange: number | null;
  /** Sites in this category with an eligible Shields pair (the mix's basis). */
  shieldsPairedSites: number;
  /** Of the paired sites: how many loaded fewer third-party requests with blocking on. */
  shieldsDecreased: number;
  /** Of the paired sites: how many loaded the same number. */
  shieldsFlat: number;
  /** Of the paired sites: how many loaded more (a real observation, not clamped away). */
  shieldsIncreased: number;
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
    const paired = list.map((site) => site.shieldsThirdPartyChange).filter((value): value is number => value !== null);
    const measuredCookies = list.map((site) => site.thirdPartyCookies).filter((value): value is number => value !== null);
    rollups.push({
      id,
      label: list[0].categoryLabel,
      siteCount: list.length,
      medianTrackers: median(list.map((site) => site.trackerRequests)),
      medianThirdParty: median(list.map((site) => site.thirdPartyRequests)),
      medianCookies: measuredCookies.length > 0 ? median(measuredCookies) : null,
      cookieMeasuredSites: measuredCookies.length,
      medianShieldsChange: paired.length > 0 ? median(paired) : null,
      shieldsPairedSites: paired.length,
      shieldsDecreased: paired.filter((value) => value < 0).length,
      shieldsFlat: paired.filter((value) => value === 0).length,
      shieldsIncreased: paired.filter((value) => value > 0).length
    });
  }

  return rollups.sort(
    (a, b) =>
      b.medianTrackers - a.medianTrackers ||
      b.medianThirdParty - a.medianThirdParty ||
      a.label.localeCompare(b.label)
  );
}
