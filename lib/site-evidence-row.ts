import { reportPagePath } from "./report-locator";
import { reportKindLabel } from "./text-format";
import type { DirectorySite } from "./directory-view";

/**
 * One row of the shared site evidence table.
 *
 * Lives here rather than beside the component so the two surfaces that build it
 * -- `/directory/` and every `/categories/<id>/` page -- map a `DirectorySite`
 * through ONE function. They rendered the same facts as two independent card
 * grids before, and the two disagreed: the directory withheld a cookie count it
 * could not vouch for while the category page published the bare number, which
 * is the shape of defect this repository files most often.
 *
 * Deliberately not exported from the `"use client"` component: a server route
 * importing a value from a client module pulls that module into the client
 * bundle. The component imports this type only, and a type import is erased.
 */
export type SiteEvidenceRow = {
  domain: string;
  profileHref: string;
  reportHref: string;
  headline: string;
  tone: string;
  categoryLabel: string;
  reportCount: number;
  scannedAt: string;
  scannedLabel: string;
  device: string;
  kindLabel: string;
  thirdPartyRequests: number;
  trackerRequests: number;
  thirdPartyCookies: number;
  requestEvidenceComplete: boolean;
  cookieEvidenceComplete: boolean;
  capped: boolean;
};

/**
 * Build a row for one site.
 *
 * Every href is prefixed explicitly rather than routed through `next/link`: the
 * table is a client component that renders raw anchors, so nothing prefixes the
 * Pages base path for it, and an unprefixed "/sites/x/" 404s on a base-path
 * deployment in a way that only reproduces in CI.
 */
export function siteEvidenceRow(basePath: string, site: DirectorySite): SiteEvidenceRow {
  const report = site.latest;
  return {
    domain: site.domain,
    profileHref: `${basePath}${site.profilePath}/`,
    reportHref: `${basePath}${reportPagePath(report.id)}/`,
    headline: report.headline,
    tone: report.tone,
    categoryLabel: report.categoryLabel,
    reportCount: site.reportCount,
    scannedAt: report.scannedAt,
    scannedLabel: formatEvidenceDate(report.scannedAt),
    device: report.device,
    kindLabel: reportKindLabel(report),
    thirdPartyRequests: report.thirdPartyRequests,
    trackerRequests: report.trackerRequests,
    thirdPartyCookies: report.thirdPartyCookies,
    requestEvidenceComplete: report.requestEvidenceComplete,
    cookieEvidenceComplete: report.cookieEvidenceComplete,
    capped: report.capped
  };
}

/** UTC, so a reader in any timezone sees the date the scan actually recorded. */
export function formatEvidenceDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "date unavailable"
    : date.toLocaleDateString("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
        timeZone: "UTC"
      });
}

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
