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
