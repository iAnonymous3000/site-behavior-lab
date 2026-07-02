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
 * list), not a random sample of the web, and each row is one automated visit.
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
  headline: string;
  thirdPartyRequests: number;
  trackerRequests: number;
  thirdPartyCookies: number;
  shieldsBlocked: number | null;
  deltaThirdPartyRequests: number | null;
  deltaTrackerRequests: number | null;
  previousReportId: string | null;
  previousScannedAt: string | null;
};

export const CORPUS_EXPORT_NOTE =
  "One row per published report; each report is one automated, controlled Chromium visit. The corpus is a curated set of sites (popular, mostly commercial, plus a diversity seed list), not a random sample of the web, so treat cross-site statistics as describing this corpus only. Counts use the report's lead run (the unprotected baseline on Shields/GPC comparisons, the accept-all run on consent comparisons) and are lower bounds. Delta fields compare a site's newest report against its previous report of the same kind and can reflect run-to-run variance as well as real site changes. Full methodology and per-report evidence are linked from each row.";

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
    headline: entry.headline,
    thirdPartyRequests: entry.thirdPartyRequests,
    trackerRequests: entry.trackerRequests,
    thirdPartyCookies: entry.thirdPartyCookies,
    shieldsBlocked: entry.shieldsBlocked,
    deltaThirdPartyRequests: entry.sinceLastScan?.thirdPartyRequests ?? null,
    deltaTrackerRequests: entry.sinceLastScan?.trackerRequests ?? null,
    previousReportId: entry.sinceLastScan?.previousId ?? null,
    previousScannedAt: entry.sinceLastScan?.previousScannedAt ?? null
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
  "headline",
  "third_party_requests",
  "tracker_requests",
  "third_party_cookies",
  "shields_blocked",
  "delta_third_party_requests",
  "delta_tracker_requests",
  "previous_report_id",
  "previous_scanned_at"
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
    row.headline,
    row.thirdPartyRequests,
    row.trackerRequests,
    row.thirdPartyCookies,
    row.shieldsBlocked ?? "",
    row.deltaThirdPartyRequests ?? "",
    row.deltaTrackerRequests ?? "",
    row.previousReportId ?? "",
    row.previousScannedAt ?? ""
  ]);
  return [CSV_HEADER, ...lines].map((line) => line.map(csvCell).join(",")).join("\r\n").concat("\r\n");
}
