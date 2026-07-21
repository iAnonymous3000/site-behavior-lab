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
   * interaction was attempted. This is a dispatch field, not a verification
   * field: v1 never recorded registration, while r2 keeps its interpreter
   * observations and claim gates in the linked report. Consent rows without
   * "accept-and-reject" have at least one run still in the pre-consent state,
   * so their diffs do not compare the two choices.
   */
  consentClicks: string | null;
  /** Lead run's top-level HTTP status; >= 400 means an error/block page, not the site. */
  status: number | null;
  /** Lead run hit the request-recording cap: every count is a floor, not measured behavior. */
  requestCapped: boolean;
  /** Whether the lead run's request family is complete enough for aggregation. */
  requestEvidenceComplete: boolean;
  headline: string;
  thirdPartyRequests: number;
  trackerRequests: number;
  thirdPartyCookies: number;
  /**
   * Signed third-party change of an eligible Shields pair: blocking visit
   * minus unblocked baseline, so negative = fewer requests with blocking on
   * and positive = more. Null on rows that are not eligible Shields pairs.
   */
  shieldsThirdPartyChange: number | null;
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
  /** Evaluator-derived state of the lead run; null when no verifier state was recorded. */
  consentChoiceState: DirectoryEntry["consentChoiceState"];
  /** Evaluator-derived state of the comparison's variant arm; null on singles or absent evidence. */
  variantConsentChoiceState: DirectoryEntry["variantConsentChoiceState"];
  /** Pair-level comparable/raw-only ruling; null on singles and never a per-family or causal gate. */
  comparisonDecisionMode: DirectoryEntry["comparisonDecisionMode"];
  /** Whether the compatibility verdict uses recorded or legacy-derived fingerprints; null on singles. */
  compatibilityFingerprintOrigin: DirectoryEntry["compatibilityFingerprintOrigin"];
  /** Tri-state digest-equality verdict; null means unprovable or not applicable. */
  compatibilityFingerprintMatched: DirectoryEntry["compatibilityFingerprintMatched"];
};

export const CORPUS_EXPORT_NOTE = [
  "One row per published report. A single report records one automated, controlled Chromium visit; a comparison report pairs two such visits, one per compared condition.",
  "The corpus is a curated set of sites (popular, mostly commercial, plus a diversity seed list), not a random sample of the web, so treat cross-site statistics as describing this corpus only.",
  "Counts use the report's lead run (the unprotected baseline on Shields/GPC comparisons, the accept-all run on consent comparisons) and are lower bounds.",
  "On consent rows, consent_clicks records which banner choices the scanner dispatched a click for; it is a dispatch column, not a verification column.",
  "consent_choice_state records the lead run's evaluator-derived verification state (the accept-all arm on consent comparisons), while variant_consent_choice_state records the comparison's variant arm (the reject-all arm on consent comparisons). Values are verified, contradicted, weak-signal, unavailable, or failed; null in JSON and blank in CSV means no verifier state was recorded, including every v1 run, never that consent succeeded.",
  "V1 never recorded whether the site registered a choice, while v2 reports (r1 and r2) carry recorded verification observations and default-deny claim gates in the linked evidence.",
  "Every run's totals include pre-click traffic; rows without accept-and-reject have at least one run still in the pre-consent state (the scanner found no clickable control for that choice), so their diffs do not compare the two choices; an accept-only or reject-only row still mixes one visit where a click was dispatched (its recording spans pre- and post-click traffic) with one pre-consent visit.",
  "comparison_decision_mode is the pair-level comparable or raw-only ruling and is null/blank on singles. It is never a metric-family or causal gate: a pair can be comparable while a particular metric family remains raw-only, so use the linked report's per-family decisions before interpreting a delta.",
  "compatibility_fingerprint_origin says whether the comparison's measurement-environment fingerprints were recorded or legacy-derived. compatibility_fingerprint_matched is true or false only when equality is provable and null/blank otherwise; two unknown fingerprints never match.",
  "The flattened corpus deliberately omits the raw baseline and variant fingerprint digests: they remain available in the linked full reports, while repeating stable digests here would add linkability and noise without a documented corpus consumer.",
  "Rows with a status of 400 or higher reflect an error or block page (the site refusing the automated visit), not the site's normal behavior. request_capped is the exact 1,000-request recording-cap flag; those activity counts are floors cut off mid-collection. request_evidence_complete is the broader request-family completeness flag, so it can be false for other bounded capture loss while request_capped remains false.",
  "Rows with request_evidence_complete false have lower-bound request counts and stay out of this project's percentiles, category medians, leaderboards, and since-last-scan deltas, as do failed loads and post-choice consent lead runs. A request-capped row also has cookie and storage figures that are end-state snapshots of an interrupted visit.",
  "siteCount counts distinct sites with a successful single run or primary comparison arm, including request-capped recordings; two successful primary arms do not count a site twice. measuredSampleSize is the exact current percentile cohort: distinct sites whose newest eligible legacy-v1 lead run loaded successfully, had complete request evidence, and remained in the passive observe consent state.",
  "Category medians and leaderboards apply the same passive-run exclusions across every supported schema generation, so their cross-version cohort can differ from measuredSampleSize.",
  "Delta fields compare a site's newest report against its previous successfully loaded, request-complete report only when kind, requested/final subject, schema revision, methodology, browser environment, device/viewport, intervention state, filter-list engine/source/count, known snapshot dates (which may differ), and tracker-catalog identity are compatible; an unknown setup never matches another unknown. The deltas can still reflect run-to-run variance as well as real site changes.",
  "schema_version/schema_revision record the report's wire generation, schema_origin marks legacy-derived (v1) rows whose derived facts were never recorded as v2 fact, and limited marks rows whose schema revision supports only descriptive (never causal) claims.",
  "Historical v1 rows are legacy-derived and limited; r2 rows carry recorded facts and may be non-limited. Filter by these columns before aggregation: this project's current percentile distributions remain v1-only and never mix r2 metrics into the legacy cohort.",
  "shields_third_party_change is the SIGNED third-party request change of an eligible Brave-list blocking pair: the blocking visit's count minus the unblocked baseline's (Brave's ad-block engine and default Shields lists, simulated in this scanner's browser, not a live Brave-browser visit), so a negative value means fewer requests with blocking on and a positive value means more; increases are real paired-visit observations (ad rotation, fallback loading) and are reported signed, not clamped to zero.",
  "It is never a count of individually blocked requests, which each blocking run records separately. shieldsChangeSummary in this payload counts the rows with a non-null change by direction (decreased / flat / increased).",
  "Full methodology and per-report evidence are linked from each row."
].join(" ");

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
    requestCapped: entry.capped,
    requestEvidenceComplete: entry.requestEvidenceComplete,
    headline: entry.headline,
    thirdPartyRequests: entry.thirdPartyRequests,
    trackerRequests: entry.trackerRequests,
    thirdPartyCookies: entry.thirdPartyCookies,
    shieldsThirdPartyChange: entry.shieldsThirdPartyChange,
    deltaThirdPartyRequests: entry.sinceLastScan?.thirdPartyRequests ?? null,
    deltaTrackerRequests: entry.sinceLastScan?.trackerRequests ?? null,
    previousReportId: entry.sinceLastScan?.previousId ?? null,
    previousScannedAt: entry.sinceLastScan?.previousScannedAt ?? null,
    schemaVersion: entry.schemaVersion,
    schemaRevision: entry.schemaRevision,
    schemaOrigin: entry.schemaOrigin,
    limited: entry.limited,
    consentChoiceState: entry.consentChoiceState,
    variantConsentChoiceState: entry.variantConsentChoiceState,
    comparisonDecisionMode: entry.comparisonDecisionMode,
    compatibilityFingerprintOrigin: entry.compatibilityFingerprintOrigin,
    compatibilityFingerprintMatched: entry.compatibilityFingerprintMatched
  }));
}

export type CorpusExportPayload = {
  generatedAt: string;
  note: string;
  license: string;
  reportCount: number;
  /** Distinct sites with at least one successful load, including capped recordings. */
  siteCount: number;
  /** Exact legacy-v1 passive-run cohort used by the current percentile artifact. */
  measuredSampleSize: number;
  /**
   * Direction mix of the rows carrying a non-null shields_third_party_change:
   * decreased (< 0, fewer with blocking), flat (0), increased (> 0). Published
   * so the aggregate never hides that some pairs observe MORE third-party
   * requests with blocking on.
   */
  shieldsChangeSummary: ShieldsChangeSummary;
  reports: CorpusExportRow[];
};

export type ShieldsChangeSummary = {
  pairedReports: number;
  decreased: number;
  flat: number;
  increased: number;
};

export function summarizeShieldsChanges(rows: CorpusExportRow[]): ShieldsChangeSummary {
  const changes = rows.map((row) => row.shieldsThirdPartyChange).filter((value): value is number => value !== null);
  return {
    pairedReports: changes.length,
    decreased: changes.filter((value) => value < 0).length,
    flat: changes.filter((value) => value === 0).length,
    increased: changes.filter((value) => value > 0).length
  };
}

export function buildCorpusExportPayload(
  rows: CorpusExportRow[],
  input: { generatedAt: string; siteCount: number; measuredSampleSize: number }
): CorpusExportPayload {
  return {
    generatedAt: input.generatedAt,
    note: CORPUS_EXPORT_NOTE,
    license: "AGPL-3.0-or-later (same repository license as the generating scanner)",
    reportCount: rows.length,
    siteCount: input.siteCount,
    measuredSampleSize: input.measuredSampleSize,
    shieldsChangeSummary: summarizeShieldsChanges(rows),
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
  "request_capped",
  "request_evidence_complete",
  "headline",
  "third_party_requests",
  "tracker_requests",
  "third_party_cookies",
  "shields_third_party_change",
  "delta_third_party_requests",
  "delta_tracker_requests",
  "previous_report_id",
  "previous_scanned_at",
  "schema_version",
  "schema_revision",
  "schema_origin",
  "limited",
  "consent_choice_state",
  "variant_consent_choice_state",
  "comparison_decision_mode",
  "compatibility_fingerprint_origin",
  "compatibility_fingerprint_matched"
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
    row.requestCapped ? "true" : "false",
    row.requestEvidenceComplete ? "true" : "false",
    row.headline,
    row.thirdPartyRequests,
    row.trackerRequests,
    row.thirdPartyCookies,
    row.shieldsThirdPartyChange ?? "",
    row.deltaThirdPartyRequests ?? "",
    row.deltaTrackerRequests ?? "",
    row.previousReportId ?? "",
    row.previousScannedAt ?? "",
    row.schemaVersion,
    row.schemaRevision ?? "",
    row.schemaOrigin,
    row.limited ? "yes" : "no",
    row.consentChoiceState ?? "",
    row.variantConsentChoiceState ?? "",
    row.comparisonDecisionMode ?? "",
    row.compatibilityFingerprintOrigin ?? "",
    row.compatibilityFingerprintMatched === null ? "" : row.compatibilityFingerprintMatched ? "true" : "false"
  ]);
  return [CSV_HEADER, ...lines].map((line) => line.map(csvCell).join(",")).join("\r\n").concat("\r\n");
}
