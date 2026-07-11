import { csvCell } from "./csv-export";
import type { DirectoryEntry } from "./corpus-overview";

/**
 * Researcher export of the committed corpus: one row per published report,
 * with the index-level fields (counts, kind, device, headline, since-last-scan
 * deltas) and absolute URLs back to the full evidence. Served as /corpus.json
 * and /corpus.csv, generated at build time from the same loader as /directory/
 * so the three can never disagree.
 *
 * Framing matters and is embedded in the JSON payload itself: this is a
 * MEASURED CORPUS of curated sites (popular/commercial plus a diversity seed
 * list), not a random sample of the web; a single-report row is one automated
 * visit and a comparison row pairs two visits under compared conditions.
 *
 * This module is the pure shaping layer (unit-tested); the route handlers
 * supply the loaded entries and origin.
 */

export type CorpusExportRow = {
  id: string;
  domain: string;
  category: string;
  categoryLabel: string;
  reportUrl: string;
  jsonUrl: string;
  scannedAt: string;
  reportType: "single" | "comparison";
  comparisonType: string | null;
  device: "desktop" | "mobile";
  gpcEnabled: boolean;
  consentMode: string;
  /**
   * Which consent-banner choices the scanner dispatched a click for
   * ("accept-and-reject" / "accept-only" / "reject-only" / "none"); null when no
   * interaction was attempted. The click is never verified as registered by
   * the site. Consent rows without "accept-and-reject" have at least one run
   * still in the pre-consent state, so their diffs do not compare the two
   * choices.
   */
  consentClicks: string | null;
  /** Lead run's top-level HTTP status; >= 400 means an error/block page, not the site. */
  status: number | null;
  headline: string;
  thirdPartyRequests: number;
  trackerRequests: number;
  thirdPartyCookies: number;
  shieldsBlocked: number | null;
  deltaThirdPartyRequests: number | null;
  deltaTrackerRequests: number | null;
  previousReportId: string | null;
  previousScannedAt: string | null;
  /** Wire schema generation of the stored report. */
  schemaVersion: 1 | 2;
  /** v2 schema revision; null on v1 rows. */
  schemaRevision: 1 | 2 | null;
  /** "legacy-derived" facts come from v1 wire, never recorded v2 fact. */
  schemaOrigin: "v2" | "legacy-derived";
  /** RFC 15.7 limited/descriptive marker (true for every v1 and v2 r1 row). */
  limited: boolean;
};

export const CORPUS_EXPORT_NOTE =
  "One row per published report. A single report records one automated, controlled Chromium visit; a comparison report pairs two such visits, one per compared condition. The corpus is a curated set of sites (popular, mostly commercial, plus a diversity seed list), not a random sample of the web, so treat cross-site statistics as describing this corpus only. Counts use the report's lead run (the unprotected baseline on Shields/GPC comparisons, the accept-all run on consent comparisons) and are lower bounds. On consent rows, consent_clicks records which banner choices the scanner dispatched a click for (the click is never verified as registered by the site, and each run's counts include pre-click traffic); rows without accept-and-reject have at least one run still in the pre-consent state (the scanner found no clickable control for that choice), so their diffs do not compare the two choices; an accept-only or reject-only row still mixes one post-click run with one pre-consent run. Rows with a status of 400 or higher reflect an error or block page (the site refusing the automated visit), not the site's normal behavior; exclude them from aggregate statistics, as this project's own percentiles and category medians do. siteCount counts distinct sites with at least one successful load. Delta fields compare a site's newest report against its previous successfully loaded report of the same kind and can reflect run-to-run variance as well as real site changes. schema_version/schema_revision record the report's wire generation, schema_origin marks legacy-derived (v1) rows whose derived facts were never recorded as v2 fact, and limited marks rows whose schema revision supports only descriptive (never causal) claims; every current row is v1, legacy-derived, and limited. Full methodology and per-report evidence are linked from each row.";

export function buildCorpusExportRows(entries: DirectoryEntry[], origin: string): CorpusExportRow[] {
  const base = origin.replace(/\/+$/, "");
  return entries.map((entry) => ({
    id: entry.id,
    domain: entry.domain,
    category: entry.category,
    categoryLabel: entry.categoryLabel,
    reportUrl: `${base}/reports/${entry.id}/`,
    jsonUrl: `${base}/reports/${entry.id}.json`,
    scannedAt: entry.scannedAt,
    reportType: entry.reportType,
    comparisonType: entry.comparisonType ?? null,
    device: entry.device,
    gpcEnabled: entry.gpcEnabled,
    consentMode: entry.consentMode,
    consentClicks: entry.consentClicks,
    status: entry.status,
    headline: entry.headline,
    thirdPartyRequests: entry.thirdPartyRequests,
    trackerRequests: entry.trackerRequests,
    thirdPartyCookies: entry.thirdPartyCookies,
    shieldsBlocked: entry.shieldsBlocked,
    deltaThirdPartyRequests: entry.sinceLastScan?.thirdPartyRequests ?? null,
    deltaTrackerRequests: entry.sinceLastScan?.trackerRequests ?? null,
    previousReportId: entry.sinceLastScan?.previousId ?? null,
    previousScannedAt: entry.sinceLastScan?.previousScannedAt ?? null,
    schemaVersion: entry.schemaVersion,
    schemaRevision: entry.schemaRevision,
    schemaOrigin: entry.schemaOrigin,
    limited: entry.limited
  }));
}

export type CorpusExportPayload = {
  generatedAt: string;
  note: string;
  license: string;
  reportCount: number;
  siteCount: number;
  reports: CorpusExportRow[];
};

export function buildCorpusExportPayload(
  rows: CorpusExportRow[],
  input: { generatedAt: string; siteCount: number }
): CorpusExportPayload {
  return {
    generatedAt: input.generatedAt,
    note: CORPUS_EXPORT_NOTE,
    license: "AGPL-3.0-or-later (same repository license as the generating scanner)",
    reportCount: rows.length,
    siteCount: input.siteCount,
    reports: rows
  };
}

const CSV_HEADER = [
  "id",
  "domain",
  "category",
  "category_label",
  "report_url",
  "json_url",
  "scanned_at",
  "report_type",
  "comparison_type",
  "device",
  "gpc_enabled",
  "consent_mode",
  "consent_clicks",
  "status",
  "headline",
  "third_party_requests",
  "tracker_requests",
  "third_party_cookies",
  "shields_blocked",
  "delta_third_party_requests",
  "delta_tracker_requests",
  "previous_report_id",
  "previous_scanned_at",
  "schema_version",
  "schema_revision",
  "schema_origin",
  "limited"
] as const;

export function corpusExportToCsv(rows: CorpusExportRow[]): string {
  const lines = rows.map((row) => [
    row.id,
    row.domain,
    row.category,
    row.categoryLabel,
    row.reportUrl,
    row.jsonUrl,
    row.scannedAt,
    row.reportType,
    row.comparisonType ?? "",
    row.device,
    row.gpcEnabled ? "yes" : "no",
    row.consentMode,
    row.consentClicks ?? "",
    row.status ?? "",
    row.headline,
    row.thirdPartyRequests,
    row.trackerRequests,
    row.thirdPartyCookies,
    row.shieldsBlocked ?? "",
    row.deltaThirdPartyRequests ?? "",
    row.deltaTrackerRequests ?? "",
    row.previousReportId ?? "",
    row.previousScannedAt ?? "",
    row.schemaVersion,
    row.schemaRevision ?? "",
    row.schemaOrigin,
    row.limited ? "yes" : "no"
  ]);
  return [CSV_HEADER, ...lines].map((line) => line.map(csvCell).join(",")).join("\r\n").concat("\r\n");
}
