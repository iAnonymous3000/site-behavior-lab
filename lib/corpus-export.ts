import { csvCell } from "./csv-export";
import { preferCorpusRepresentative } from "./corpus-representative";
import { corpusSiteDomainKey } from "./corpus-site-domain";
import type { DirectoryEntry } from "./corpus-overview";
import {
  METRIC_CONTRACT_DIGEST,
  METRIC_CONTRACT_VERSION
} from "./metric-contract";

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

export const CORPUS_EXPORT_SCHEMA_VERSION = 1 as const;

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
  /** Evaluator-backed outcome (legacy-derived for v1, recorded for v2). */
  runOutcome: DirectoryEntry["runOutcome"];
  /** Recorded producer/observer; null on v1. */
  producer: string | null;
  /** Recorded acquisition path; null on v1. */
  acquisition: string | null;
  /** Self-reported producer build commit; null on v1. */
  buildCommit: string | null;
  /** Methodology token defining the statistical cohort. */
  methodologyVersion: string;
  methodologyOrigin: "recorded" | "legacy-derived";
  /** Recorded r2 catalog digest or canonical hash of v1's recorded catalog metadata. */
  trackerCatalogDigest: string;
  trackerCatalogOrigin: "recorded" | "legacy-metadata-hash";
  /** Read-time ServiceRole interpretation applied to this immutable report. */
  serviceRoleTaxonomyVersion: string;
  serviceRoleTaxonomyDigest: string;
  /** Exact request-metric formula contract applied to this row. */
  metricContractVersion: string;
  metricContractDigest: string;
  browserName: string | null;
  browserVersion: string | null;
  egressLabel: string;
  egressRegion: string | null;
  /** Complete schema/methodology/catalog/taxonomy/producer/requested-GPC cohort. */
  corpusCohortId: string;
  /** Distinct-site denominator after this cohort's passive-run quality gates. */
  corpusCohortDenominator: number;
  /** Whether this exact row represents its site in that cohort's statistics. */
  corpusInclusion: "included" | "excluded";
  /** Machine-readable reasons; empty only when corpusInclusion is included. */
  corpusExclusionReasons: CorpusExclusionReason[];
  /** Lead run hit the request-recording cap: every count is a floor, not measured behavior. */
  requestCapped: boolean;
  /** Whether the lead run's request family is complete enough for aggregation. */
  requestEvidenceComplete: boolean;
  /**
   * Whether the lead run's COOKIE family was recorded completely. It moves
   * independently of requestEvidenceComplete (a PageGraph import records no
   * cookies at all while its requests stay complete), so a false value means
   * thirdPartyCookies below is not a measurement: every report, directory,
   * category, and feed surface renders that same row as not measured.
   */
  cookieEvidenceComplete: boolean;
  headline: string;
  thirdPartyRequests: number;
  /** Frozen report-wire count of retained request rows with any direct catalog match. */
  cataloguedServiceRequests: number;
  /** Derived count of retained third-party rows whose catalog-suffix match carries a tracking role. */
  trackingServiceRequests: number;
  /**
   * @deprecated Compatibility alias for trackingServiceRequests. Retained
   * through corpus export schema 1.x.
   */
  trackerRequests: number;
  thirdPartyCookies: number;
  /**
   * Signed third-party change of an eligible Shields pair: blocking visit
   * minus unblocked baseline, so negative = fewer requests with blocking on
   * and positive = more. Null on rows that are not eligible Shields pairs.
   */
  shieldsThirdPartyChange: number | null;
  deltaThirdPartyRequests: number | null;
  deltaCataloguedServiceRequests: number | null;
  deltaTrackingServiceRequests: number | null;
  /**
   * @deprecated Compatibility alias for deltaTrackingServiceRequests. Retained
   * through corpus export schema 1.x.
   */
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

export type CorpusExclusionReason =
  | "run-failed"
  | "missing-http-status"
  | "http-error-status"
  | "request-evidence-incomplete"
  | "request-recording-cap"
  | "post-choice-consent-lead"
  | "superseded-by-newer-report";

export const CORPUS_EXPORT_NOTE = [
  "One row per published report. A single report records one automated, controlled Chromium visit; a comparison report pairs two such visits, one per compared condition.",
  "The corpus is a curated set of sites (popular, mostly commercial, plus a diversity seed list), not a random sample of the web, so treat cross-site statistics as describing this corpus only.",
  "Counts use the report's lead run (the unprotected baseline on Shields/GPC comparisons, the accept-all run on consent comparisons) and are lower bounds.",
  "catalogued_service_requests counts retained request rows with any direct catalog match, including operational services and first-party matches. tracking_service_requests counts only retained third-party rows whose recorded host matched a reviewed service-catalog suffix carrying a tracking role under the named metric contract. tracker_requests and delta_tracker_requests are deprecated 1.x compatibility aliases for tracking_service_requests and delta_tracking_service_requests; they are not the broader catalogued-service metric.",
  "On consent rows, consent_clicks records which banner choices the scanner dispatched a click for; it is a dispatch column, not a verification column.",
  "consent_choice_state records the lead run's evaluator-derived verification state (the accept-all arm on consent comparisons), while variant_consent_choice_state records the comparison's variant arm (the reject-all arm on consent comparisons). Values are verified, contradicted, weak-signal, unavailable, or failed; null in JSON and blank in CSV means no verifier state was recorded, including every v1 run, never that consent succeeded.",
  "V1 never recorded whether the site registered a choice, while v2 reports (r1 and r2) carry recorded verification observations and default-deny claim gates in the linked evidence.",
  "Every run's totals include pre-click traffic; rows without accept-and-reject have at least one run still in the pre-consent state (the scanner found no clickable control for that choice), so their diffs do not compare the two choices; an accept-only or reject-only row still mixes one visit where a click was dispatched (its recording spans pre- and post-click traffic) with one pre-consent visit.",
  "comparison_decision_mode is the pair-level comparable or raw-only ruling and is null/blank on singles. It is never a metric-family or causal gate: a pair can be comparable while a particular metric family remains raw-only, so use the linked report's per-family decisions before interpreting a delta.",
  "compatibility_fingerprint_origin says whether the comparison's measurement-environment fingerprints were recorded or legacy-derived. compatibility_fingerprint_matched is true or false only when equality is provable and null/blank otherwise; two unknown fingerprints never match.",
  "The flattened corpus deliberately omits the raw baseline and variant fingerprint digests: they remain available in the linked full reports, while repeating stable digests here would add linkability and noise without a documented corpus consumer.",
  "Rows with a status of 400 or higher reflect an error or block page (the site refusing the automated visit), not the site's normal behavior. request_capped is the exact 1,000-request recording-cap flag; those activity counts are floors cut off mid-collection. request_evidence_complete is the broader request-family completeness flag, so it can be false for other bounded capture loss while request_capped remains false.",
  "Rows with request_evidence_complete false have lower-bound request counts and stay out of this project's percentiles, category medians, leaderboards, and since-last-scan deltas, as do failed loads and post-choice consent lead runs. A request-capped row also has cookie and storage figures that are end-state snapshots of an interrupted visit.",
  "cookie_evidence_complete is the same completeness flag for the cookie family, and it moves independently of the request flags: a producer that records no cookie evidence at all (a PageGraph import) leaves request_evidence_complete true while cookie_evidence_complete is false. Where it is false, third_party_cookies is not a measurement and must not be read as a zero or as a site that set no third-party cookies; the report, directory, category, and feed surfaces render that same row as not measured, and this project's cookie distributions leave it out.",
  "corpus_cohort_id is a versioned schema, methodology, tracker-catalog, read-time ServiceRole-taxonomy, metric-contract, recorded-producer, and requested-GPC identity. tracker_catalog_digest is the recorded content digest on v2 and a canonical hash of the available recorded legacy metadata on v1; tracker_catalog_origin keeps those assurance levels distinct. corpus_cohort_denominator is the distinct-site passive-run denominator for that exact cohort; no percentile, category median, or leaderboard silently pools v1 and r2 or different methodology, catalog, ServiceRole, or metric-contract identities.",
  "corpus_inclusion and corpus_exclusion_reasons state whether a row is the newest eligible representative for its site in that cohort. Excluded rows remain published and auditable; they never contribute a zero or truncated measurement.",
  "siteCount counts distinct sites with a successful single run or primary comparison arm, including request-capped recordings; two successful primary arms do not count a site twice. measuredSampleSize is the denominator of primaryCohortId, the top-level compatibility cohort in corpus-stats.json; the cohorts collection names every separate methodology denominator.",
  "Delta fields compare a site's newest report against its previous successfully loaded, request-complete report only when kind, requested/final subject, schema revision, methodology, browser environment, device/viewport, intervention state, filter-list engine/source/count, known snapshot dates (which may differ), tracker-catalog identity, ServiceRole taxonomy, and metric contract are compatible; an unknown setup never matches another unknown. The deltas can still reflect run-to-run variance as well as real site changes.",
  "schema_version/schema_revision record the report's wire generation, schema_origin marks legacy-derived (v1) rows whose derived facts were never recorded as v2 fact, and limited marks rows whose schema revision supports only descriptive (never causal) claims.",
  "Historical v1 rows are legacy-derived and limited; r2 rows carry recorded facts and may be non-limited. producer, acquisition, build_commit, browser, egress, run_outcome, methodology_version, and methodology_origin make each row's provenance and quality filterable; null or blank means the generation never recorded the fact.",
  "shields_third_party_change is the SIGNED third-party request change of an eligible Brave-list blocking pair: the blocking visit's count minus the unblocked baseline's (Brave's ad-block engine and default Shields lists, simulated in this scanner's browser, not a live Brave-browser visit), so a negative value means fewer requests with blocking on and a positive value means more; increases are real paired-visit observations (ad rotation, fallback loading) and are reported signed, not clamped to zero.",
  "It is never a count of individually blocked requests, which each blocking run records separately. shieldsChangeSummary in this payload counts by direction (decreased / flat / increased) only the pairs with corpus_inclusion included, so a site's superseded rescans never weight the mix; it still spans every cohort, and shieldsChangeCohorts publishes the same mix per corpus_cohort_id for readers who need one measurement instrument at a time.",
  "Full methodology and per-report evidence are linked from each row."
].join(" ");

export function buildCorpusExportRows(entries: DirectoryEntry[], origin: string): CorpusExportRow[] {
  const base = origin.replace(/\/+$/, "");
  const inclusion = corpusInclusionForEntries(entries);
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
    runOutcome: entry.runOutcome,
    producer: entry.producer,
    acquisition: entry.acquisition,
    buildCommit: entry.buildCommit,
    methodologyVersion: entry.corpusCohort.methodologyVersion,
    methodologyOrigin: entry.corpusCohort.methodologyOrigin,
    trackerCatalogDigest: entry.corpusCohort.trackerCatalogDigest,
    trackerCatalogOrigin: entry.corpusCohort.trackerCatalogOrigin,
    serviceRoleTaxonomyVersion: entry.corpusCohort.serviceRoleTaxonomyVersion,
    serviceRoleTaxonomyDigest: entry.corpusCohort.serviceRoleTaxonomyDigest,
    metricContractVersion: entry.corpusCohort.metricContractVersion,
    metricContractDigest: entry.corpusCohort.metricContractDigest,
    browserName: entry.browserName,
    browserVersion: entry.browserVersion,
    egressLabel: entry.egressLabel,
    egressRegion: entry.egressRegion,
    corpusCohortId: entry.corpusCohort.id,
    corpusCohortDenominator: inclusion.denominators.get(entry.corpusCohort.id) ?? 0,
    corpusInclusion: inclusion.reasons.get(entry.id)?.length ? "excluded" : "included",
    corpusExclusionReasons: inclusion.reasons.get(entry.id) ?? [],
    requestCapped: entry.capped,
    requestEvidenceComplete: entry.requestEvidenceComplete,
    cookieEvidenceComplete: entry.cookieEvidenceComplete,
    headline: entry.headline,
    thirdPartyRequests: entry.thirdPartyRequests,
    cataloguedServiceRequests: entry.cataloguedServiceRequests,
    trackingServiceRequests: entry.trackerRequests,
    // Deprecated schema-1.x alias; do not give it an independent formula.
    trackerRequests: entry.trackerRequests,
    thirdPartyCookies: entry.thirdPartyCookies,
    shieldsThirdPartyChange: entry.shieldsThirdPartyChange,
    deltaThirdPartyRequests: entry.sinceLastScan?.thirdPartyRequests ?? null,
    deltaCataloguedServiceRequests: entry.sinceLastScan?.cataloguedServiceRequests ?? null,
    deltaTrackingServiceRequests: entry.sinceLastScan?.trackerRequests ?? null,
    // Deprecated schema-1.x alias; exact equality is enforced in tests.
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

function corpusInclusionForEntries(entries: DirectoryEntry[]): {
  reasons: Map<string, CorpusExclusionReason[]>;
  denominators: Map<string, number>;
} {
  const reasons = new Map<string, CorpusExclusionReason[]>();
  const newestEligible = new Map<string, DirectoryEntry>();

  for (const entry of entries) {
    const entryReasons: CorpusExclusionReason[] = [];
    if (entry.runOutcome !== "complete") entryReasons.push("run-failed");
    if (entry.status === null) entryReasons.push("missing-http-status");
    else if (entry.status >= 400) entryReasons.push("http-error-status");
    if (!entry.requestEvidenceComplete) entryReasons.push("request-evidence-incomplete");
    if (entry.capped) entryReasons.push("request-recording-cap");
    if (entry.consentMode === "accept-all" || entry.consentMode === "reject-all") {
      entryReasons.push("post-choice-consent-lead");
    }
    reasons.set(entry.id, entryReasons);
    if (entryReasons.length > 0) continue;

    const domain = corpusSiteDomainKey(entry.domain) || entry.domain.toLowerCase();
    const key = `${entry.corpusCohort.id}\u0000${domain}`;
    const current = newestEligible.get(key);
    if (!current || preferCorpusRepresentative(entry, current)) newestEligible.set(key, entry);
  }

  const selectedIds = new Set([...newestEligible.values()].map((entry) => entry.id));
  for (const entry of entries) {
    const entryReasons = reasons.get(entry.id) as CorpusExclusionReason[];
    if (entryReasons.length === 0 && !selectedIds.has(entry.id)) entryReasons.push("superseded-by-newer-report");
  }

  const denominators = new Map<string, number>();
  for (const entry of newestEligible.values()) {
    denominators.set(entry.corpusCohort.id, (denominators.get(entry.corpusCohort.id) ?? 0) + 1);
  }
  return { reasons, denominators };
}

export type CorpusExportPayload = {
  /** Major compatibility line. Deprecated aliases remain present through 1.x. */
  exportSchemaVersion: 1;
  generatedAt: string;
  metricContractVersion: string;
  metricContractDigest: string;
  note: string;
  license: string;
  reportCount: number;
  /** Distinct sites with at least one successful load, including capped recordings. */
  siteCount: number;
  /** Exact primaryCohortId passive-run denominator used by the compatibility view. */
  measuredSampleSize: number;
  /** Cohort backing measuredSampleSize/top-level corpus-stats compatibility fields. */
  primaryCohortId: string | null;
  /** Auditable per-methodology denominators derived from the exported rows. */
  cohorts: CorpusExportCohort[];
  /**
   * Direction mix of the eligible Shields pairs that REPRESENT their site in a
   * cohort's statistics (corpus_inclusion included): decreased (< 0, fewer with
   * blocking), flat (0), increased (> 0). Published so the aggregate never
   * hides that some pairs observe MORE third-party requests with blocking on.
   * Rescans the same payload marks superseded are not counted again here, for
   * the reason they are excluded everywhere else: they are not their site's
   * representative measurement. It still spans every cohort, so a site
   * measured under two of them contributes one row to each.
   */
  shieldsChangeSummary: ShieldsChangeSummary;
  /**
   * The same direction mix per cohort, which is the un-pooled form of the
   * summary above: two blocking instruments (or two requested-GPC lanes) are
   * different measurements of the same question, and nothing else in this
   * project pools them into one denominator.
   */
  shieldsChangeCohorts: ShieldsChangeCohortSummary[];
  reports: CorpusExportRow[];
};

export type CorpusExportCohort = {
  id: string;
  schemaVersion: 1 | 2;
  schemaRevision: 1 | 2 | null;
  methodologyVersion: string;
  methodologyOrigin: "recorded" | "legacy-derived";
  producer: string | null;
  gpc: boolean;
  trackerCatalogDigest: string;
  trackerCatalogOrigin: "recorded" | "legacy-metadata-hash";
  serviceRoleTaxonomyVersion: string;
  serviceRoleTaxonomyDigest: string;
  metricContractVersion: string;
  metricContractDigest: string;
  denominator: number;
  includedRows: number;
  excludedRows: number;
};

export type ShieldsChangeSummary = {
  /** Representative rows carrying a signed change; one per site within a cohort. */
  pairedReports: number;
  decreased: number;
  flat: number;
  increased: number;
};

export type ShieldsChangeCohortSummary = ShieldsChangeSummary & { cohortId: string };

/**
 * Direction mix of the eligible Shields pairs a cohort's statistics speak for.
 *
 * Only rows this same payload publishes as corpus_inclusion included are
 * counted: a superseded rescan is not its site's representative measurement,
 * and counting one would weight the mix by how often a site was rescanned
 * rather than by how sites behave. That is the rule every other aggregate in
 * this project applies, and this is the aggregate whose whole purpose is to
 * keep an inconvenient direction visible, so it may not be the one exception.
 */
export function summarizeShieldsChanges(rows: CorpusExportRow[]): ShieldsChangeSummary {
  return shieldsDirectionMix(representativeShieldsChanges(rows));
}

/** The same mix per cohort, so no reader has to un-pool two measurement instruments. */
export function summarizeShieldsChangesByCohort(rows: CorpusExportRow[]): ShieldsChangeCohortSummary[] {
  const byId = new Map<string, CorpusExportRow[]>();
  for (const row of rows) {
    const cohortRows = byId.get(row.corpusCohortId);
    if (cohortRows) cohortRows.push(row);
    else byId.set(row.corpusCohortId, [row]);
  }
  return [...byId.entries()]
    .map(([cohortId, cohortRows]) => ({
      cohortId,
      ...shieldsDirectionMix(representativeShieldsChanges(cohortRows))
    }))
    .filter((cohort) => cohort.pairedReports > 0)
    .sort((left, right) => left.cohortId.localeCompare(right.cohortId));
}

function representativeShieldsChanges(rows: CorpusExportRow[]): number[] {
  return rows
    .filter((row) => row.corpusInclusion === "included")
    .map((row) => row.shieldsThirdPartyChange)
    .filter((value): value is number => value !== null);
}

function shieldsDirectionMix(changes: number[]): ShieldsChangeSummary {
  return {
    pairedReports: changes.length,
    decreased: changes.filter((value) => value < 0).length,
    flat: changes.filter((value) => value === 0).length,
    increased: changes.filter((value) => value > 0).length
  };
}

export function buildCorpusExportPayload(
  rows: CorpusExportRow[],
  input: { generatedAt: string; siteCount: number; measuredSampleSize: number; primaryCohortId?: string | null }
): CorpusExportPayload {
  return {
    exportSchemaVersion: CORPUS_EXPORT_SCHEMA_VERSION,
    generatedAt: input.generatedAt,
    metricContractVersion: METRIC_CONTRACT_VERSION,
    metricContractDigest: METRIC_CONTRACT_DIGEST,
    note: CORPUS_EXPORT_NOTE,
    license: "AGPL-3.0-or-later (same repository license as the generating scanner)",
    reportCount: rows.length,
    siteCount: input.siteCount,
    measuredSampleSize: input.measuredSampleSize,
    primaryCohortId: input.primaryCohortId ?? null,
    cohorts: summarizeExportCohorts(rows),
    shieldsChangeSummary: summarizeShieldsChanges(rows),
    shieldsChangeCohorts: summarizeShieldsChangesByCohort(rows),
    reports: rows
  };
}

export function summarizeExportCohorts(rows: CorpusExportRow[]): CorpusExportCohort[] {
  const byId = new Map<string, CorpusExportCohort>();
  for (const row of rows) {
    const current = byId.get(row.corpusCohortId) ?? {
      id: row.corpusCohortId,
      schemaVersion: row.schemaVersion,
      schemaRevision: row.schemaRevision,
      methodologyVersion: row.methodologyVersion,
      methodologyOrigin: row.methodologyOrigin,
      producer: row.producer,
      gpc: row.gpcEnabled,
      trackerCatalogDigest: row.trackerCatalogDigest,
      trackerCatalogOrigin: row.trackerCatalogOrigin,
      serviceRoleTaxonomyVersion: row.serviceRoleTaxonomyVersion,
      serviceRoleTaxonomyDigest: row.serviceRoleTaxonomyDigest,
      metricContractVersion: row.metricContractVersion,
      metricContractDigest: row.metricContractDigest,
      denominator: row.corpusCohortDenominator,
      includedRows: 0,
      excludedRows: 0
    };
    if (row.corpusInclusion === "included") current.includedRows += 1;
    else current.excludedRows += 1;
    byId.set(row.corpusCohortId, current);
  }
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
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
  "compatibility_fingerprint_matched",
  // Additive export evolution: keep every historical column in its original
  // position and append new provenance/cohort fields for positional readers.
  "run_outcome",
  "producer",
  "acquisition",
  "build_commit",
  "methodology_version",
  "methodology_origin",
  "browser_name",
  "browser_version",
  "egress_label",
  "egress_region",
  "corpus_cohort_id",
  "corpus_cohort_denominator",
  "corpus_inclusion",
  "corpus_exclusion_reasons",
  "tracker_catalog_digest",
  "tracker_catalog_origin",
  "service_role_taxonomy_version",
  "service_role_taxonomy_digest",
  // Schema-1 additive fields. Historical columns above never move.
  "corpus_export_schema_version",
  "metric_contract_version",
  "metric_contract_digest",
  "catalogued_service_requests",
  "tracking_service_requests",
  "delta_catalogued_service_requests",
  "delta_tracking_service_requests",
  "cookie_evidence_complete"
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
    row.compatibilityFingerprintMatched === null ? "" : row.compatibilityFingerprintMatched ? "true" : "false",
    row.runOutcome,
    row.producer ?? "",
    row.acquisition ?? "",
    row.buildCommit ?? "",
    row.methodologyVersion,
    row.methodologyOrigin,
    row.browserName ?? "",
    row.browserVersion ?? "",
    row.egressLabel,
    row.egressRegion ?? "",
    row.corpusCohortId,
    row.corpusCohortDenominator,
    row.corpusInclusion,
    row.corpusExclusionReasons.join(";"),
    row.trackerCatalogDigest,
    row.trackerCatalogOrigin,
    row.serviceRoleTaxonomyVersion,
    row.serviceRoleTaxonomyDigest,
    CORPUS_EXPORT_SCHEMA_VERSION,
    row.metricContractVersion,
    row.metricContractDigest,
    row.cataloguedServiceRequests,
    row.trackingServiceRequests,
    row.deltaCataloguedServiceRequests ?? "",
    row.deltaTrackingServiceRequests ?? "",
    row.cookieEvidenceComplete ? "true" : "false"
  ]);
  return [CSV_HEADER, ...lines].map((line) => line.map(csvCell).join(",")).join("\r\n").concat("\r\n");
}
