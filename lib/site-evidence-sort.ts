import type { SiteEvidenceRow } from "./site-evidence-row";

/**
 * The directory/category table ordering, in a module a client component can
 * import without paying for anything else.
 *
 * Deliberately NOT in site-evidence-row.ts, whose `siteEvidenceRow` builder
 * pulls report-locator and text-format (and through it public-name-policy).
 * Those are server concerns; a "use client" component importing this file for a
 * VALUE would drag all of them into the directory and category bundles for the
 * sake of one comparator. The row TYPE is free -- type imports erase.
 */
export type SiteEvidenceSortKey =
  | "domain"
  | "thirdPartyRequests"
  | "trackerRequests"
  | "thirdPartyCookies"
  | "scannedAt";

/**
 * Whether a row has a value to rank in this column at all.
 *
 * Keyed on what the CELL shows, which is the only thing a reader can compare.
 * `thirdPartyCookies` is withheld entirely when its evidence is incomplete
 * ("Not measured"), so there is nothing to sort. The request columns still
 * publish their number as a lower bound ("at least N"), so they sort by it.
 *
 * Sinking those request rows ranked a published number below every zero, which
 * buried the heaviest sites in the corpus under the lightest ones in exactly
 * the view built to make them comparable.
 */
export function siteEvidenceValueIsRankable(
  row: SiteEvidenceRow,
  key: Exclude<SiteEvidenceSortKey, "domain" | "scannedAt">
): boolean {
  return key === "thirdPartyCookies" ? row.cookieEvidenceComplete : true;
}

/**
 * The directory/category table's whole ordering, extracted so it can be tested.
 * It lived inline in a `"use client"` component, where nothing could reach it.
 */
export function sortSiteEvidenceRows(
  rows: readonly SiteEvidenceRow[],
  sort: { key: SiteEvidenceSortKey; descending: boolean }
): SiteEvidenceRow[] {
  const direction = sort.descending ? -1 : 1;
  return [...rows].sort((left, right) => {
    if (sort.key === "domain") return direction * left.domain.localeCompare(right.domain);
    if (sort.key === "scannedAt") {
      return direction * (Date.parse(left.scannedAt) - Date.parse(right.scannedAt));
    }
    // A count with nothing to rank must not sort as zero, which would put it
    // alongside a site that genuinely recorded none. Those rows sink to the
    // bottom of either direction instead.
    const leftRankable = siteEvidenceValueIsRankable(left, sort.key);
    const rightRankable = siteEvidenceValueIsRankable(right, sort.key);
    if (leftRankable !== rightRankable) return leftRankable ? -1 : 1;
    return direction * (left[sort.key] - right[sort.key]) || left.domain.localeCompare(right.domain);
  });
}
