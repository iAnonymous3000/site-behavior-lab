import { readFile } from "node:fs/promises";
import path from "node:path";
import { buildCategoryRollups, type CategoryRollup } from "./category-rollups";
import type { CompatibilityFingerprint, ComparisonDecision } from "./comparison-decision";
import { domainsMatch } from "./featured-sites";
import { buildReportHeadline, type HeadlineTone } from "./report-headline";
import { trackingServiceRequests } from "./report-insights";
import { readStoredReportForId } from "./report-source";
import {
  comparisonArmViews,
  displayRunView,
  familyCensoredOnRun,
  runHitRequestRecordingCap,
  toReportView,
  type ReportView
} from "./scan-report-view";
import { isReservedReportDomain } from "./reserved-report-domains";
import { listStaticReportIds } from "./static-report-files";
import {
  comparisonHistoryPairingKey,
  computeComparableSinceLastScan,
  type SinceLastScan
} from "./temporal-deltas";
import {
  comparisonHistoryCohortForStoredReport,
  consentClicksForView,
  type ConsentClicks
} from "./temporal-report-identity";
import type { RunConsentView } from "./scan-report-views";
import type { ComparisonType } from "./types";

export { consentClicksForView } from "./temporal-report-identity";
export type { ConsentClicks } from "./temporal-report-identity";

/**
 * Server-only: loads the committed report corpus and derives the index-level views
 * shared by the directory page and the homepage hero, per-report entries, the
 * per-category rollups, the heaviest sites, and the distinct-site count. Metrics
 * use the baseline (off / unprotected) run; one data point per site.
 *
 * Imported only by server components (it reads the filesystem), so it is never
 * bundled into the client.
 */

export type DirectoryEntry = {
  id: string;
  domain: string;
  tone: HeadlineTone;
  headline: string;
  thirdPartyRequests: number;
  trackerRequests: number;
  thirdPartyCookies: number;
  /**
   * Signed change in third-party requests on an eligible Shields pair: the
   * blocking visit's count minus the unblocked baseline's, so negative means
   * fewer requests with blocking on and positive means more. Null when the
   * report is not an eligible Shields comparison. An increase is a real
   * paired-visit observation (ad rotation, fallback loading), never clamped
   * away; it is not a claim that blocking causes tracking.
   */
  shieldsThirdPartyChange: number | null;
  category: string;
  categoryLabel: string;
  scannedAt: string;
  reportType: "single" | "comparison";
  comparisonType?: ComparisonType;
  device: "desktop" | "mobile";
  /** GPC state of the report's lead (baseline) run. */
  gpcEnabled: boolean;
  /** Consent mode of the report's lead run ("accept-all" on consent comparisons). */
  consentMode: string;
  /**
   * Which consent-banner choices the scanner dispatched a click for; null on reports
   * that never attempted a consent interaction. Anything short of
   * "accept-and-reject" on a consent comparison means at least one run reflects
   * the PRE-consent state, so the report is not evidence of post-choice behavior.
   */
  consentClicks: ConsentClicks | null;
  /** Lead run's top-level HTTP status; >= 400 means an error/block page, not the site. */
  status: number | null;
  /** Evaluator-derived outcome; status 200 can still be a failed/bot-wall run. */
  runOutcome: "complete" | "failed";
  /** Whether the single run or either primary comparison arm loaded successfully. */
  reportHasSuccessfulLoad: boolean;
  /** Whether any successfully loaded arm hit the exact request-recording cap. */
  reportHasRequestCappedLoad: boolean;
  /** Whether request-derived counts are complete enough for aggregate use. */
  requestEvidenceComplete: boolean;
  /** Whether cookie counts are complete enough for a cookie-specific aggregate. */
  cookieEvidenceComplete: boolean;
  /**
   * The lead run hit the request-recording cap: its activity counts are floors cut
   * off mid-collection, so the row is excluded from percentiles, rollups,
   * the leaderboard, and since-last-scan pairing, and marked in the exports.
   */
  capped: boolean;
  /** Lead run's requested URL (origin + path); pairs since-last-scan by exact subject. */
  requestedUrl: string;
  /** Lead run's final URL after redirects; a different landing page is a different subject. */
  finalUrl: string;
  /** Wire schema generation of the stored report. */
  schemaVersion: 1 | 2;
  /** v2 schema revision; null on v1 reports. */
  schemaRevision: 1 | 2 | null;
  /** View origin: "legacy-derived" facts come from v1 wire, never recorded v2 fact. */
  schemaOrigin: "v2" | "legacy-derived";
  /** RFC 15.7 limited/descriptive marker (true for every v1 and v2 r1 report). */
  limited: boolean;
  /**
   * Evaluator-derived consent state of the lead run. null means no verifier
   * state was recorded (including every v1 run), never that consent succeeded.
   */
  consentChoiceState: RunConsentView["choiceState"];
  /**
   * Evaluator-derived consent state of the comparison's variant arm. This is
   * kept separate from the lead state so accept/reject pairs are unambiguous;
   * null on singles and arms with no recorded verifier state.
   */
  variantConsentChoiceState: RunConsentView["choiceState"];
  /** Pair-level comparison ruling; null on singles. Per-family gates remain in the linked report. */
  comparisonDecisionMode: ComparisonDecision["mode"] | null;
  /** Whether the pair's compatibility fingerprint was recorded or legacy-derived; null on singles. */
  compatibilityFingerprintOrigin: CompatibilityFingerprint["origin"] | null;
  /**
   * Tri-state equality verdict for the two measurement-environment digests.
   * null means equality was unprovable (or there is no pair), never a match.
   */
  compatibilityFingerprintMatched: CompatibilityFingerprint["matched"];
  /**
   * Set only when an earlier report shares the versioned passive-history key.
   * The filter-list snapshot date may differ; this is a descriptive raw/catalog delta, never a Shields delta.
   */
  sinceLastScan?: SinceLastScan;
};

type CorpusExportMetadata = Pick<
  DirectoryEntry,
  | "consentChoiceState"
  | "variantConsentChoiceState"
  | "comparisonDecisionMode"
  | "compatibilityFingerprintOrigin"
  | "compatibilityFingerprintMatched"
>;

/**
 * Cross-generation metadata for the flattened researcher export. Read only
 * from the version-independent view so v1 stays explicitly legacy-derived and
 * v2 uses the evaluator-backed facts already consumed by the report UI.
 */
export function corpusExportMetadataForView(view: ReportView): CorpusExportMetadata {
  const lead = displayRunView(view);
  const arms = comparisonArmViews(view);
  const decision = view.claims.decision;
  return {
    consentChoiceState: lead.consent?.choiceState ?? null,
    variantConsentChoiceState: arms?.variant.consent?.choiceState ?? null,
    comparisonDecisionMode: decision?.mode ?? null,
    compatibilityFingerprintOrigin: decision?.compatibility.origin ?? null,
    compatibilityFingerprintMatched: decision?.compatibility.matched ?? null
  };
}

export type CorpusOverview = {
  entries: DirectoryEntry[];
  /** Valid public report routes and their newest recorded run, sorted by ID for stable sitemap output. */
  sitemapReports: { id: string; lastModifiedAt: string }[];
  rollups: CategoryRollup[];
  heaviest: DirectoryEntry[];
  /**
   * Distinct sites in the cross-version passive sample (loaded, uncapped, no
   * post-choice consent lead): the basis of the rollups, leaderboard, and
   * since-last-scan pairing.
   */
  siteCount: number;
  /**
   * Distinct sites with a successful single run or primary comparison arm,
   * INCLUDING request-capped recordings: what the corpus covers, as opposed
   * to what it measures. Both arms of a comparison count the site once.
   */
  coverageSiteCount: number;
  /** Distinct real sites represented by any committed attempt, successful or failed. */
  attemptedSiteCount: number;
  /** Attempted sites with no successful load in the committed corpus. */
  failedSiteCount: number;
  /** Successfully loaded sites with a request-capped primary recording. */
  cappedSiteCount: number;
};

export type CorpusSiteCounts = Pick<
  CorpusOverview,
  "coverageSiteCount" | "attemptedSiteCount" | "failedSiteCount" | "cappedSiteCount"
>;

type CatalogEntry = { domain: string; id: string; label: string };

/** A missing main-document response or HTTP >= 400 is not a successful site load. */
function entryLoadFailed(entry: DirectoryEntry): boolean {
  return entry.runOutcome !== "complete" || typeof entry.status !== "number" || entry.status >= 400;
}

/**
 * Mutually distinguishes attempted sites from successful coverage. A site with
 * failed and successful reports or arms counts as covered, not failed; capped
 * coverage is a named subset of successful loads rather than a third total.
 */
export function summarizeCorpusSiteCounts(entries: DirectoryEntry[]): CorpusSiteCounts {
  const attemptedDomains = new Set(entries.map((entry) => entry.domain));
  const coverageDomains = new Set(entries.filter((entry) => entry.reportHasSuccessfulLoad).map((entry) => entry.domain));
  const cappedDomains = new Set(
    entries.filter((entry) => entry.reportHasRequestCappedLoad).map((entry) => entry.domain)
  );
  const failedSiteCount = [...attemptedDomains].filter((domain) => !coverageDomains.has(domain)).length;

  return {
    attemptedSiteCount: attemptedDomains.size,
    coverageSiteCount: coverageDomains.size,
    failedSiteCount,
    cappedSiteCount: cappedDomains.size
  };
}

/** Consent interaction arms are post-choice states, not passive site visits. */
export function entryEligibleForCorpusRollups(entry: DirectoryEntry): boolean {
  return (
    !entryLoadFailed(entry) &&
    entry.requestEvidenceComplete &&
    !entry.capped &&
    entry.consentMode !== "accept-all" &&
    entry.consentMode !== "reject-all"
  );
}

let corpusOverviewPromise: Promise<CorpusOverview> | null = null;

/** One immutable committed-corpus read per server/build process. */
export function loadCorpusOverview(): Promise<CorpusOverview> {
  corpusOverviewPromise ??= buildCorpusOverview();
  return corpusOverviewPromise;
}

async function buildCorpusOverview(): Promise<CorpusOverview> {
  const catalog = await loadCategoryCatalog();
  const loadedEntries = await loadDirectoryEntries(catalog);
  const entries = loadedEntries.map(({ entry }) => entry);

  // Failed loads, request-capped runs, and consent-interaction arms stay listed
  // with their honest headlines, but none describes an uncensored passive
  // visit. Keep them out of since-last-scan pairing, category medians, and the
  // leaderboard just as the percentile builder does.
  const measuredLoaded = loadedEntries.filter(({ entry }) => entryEligibleForCorpusRollups(entry));
  const measured = measuredLoaded.map(({ entry }) => entry);

  // "Since last comparable visit": each site's newest report is paired only
  // with a predecessor carrying the separate compatible passive-history key.
  // This is deliberately broader than the archive's strict retention identity;
  // the key is absent on failed, capped, simulated, unknown, or
  // mismatched-subject visits.
  const deltas = computeComparableSinceLastScan(
    measuredLoaded.map(({ entry, comparisonHistoryKey }) => ({ ...entry, comparisonHistoryKey }))
  );
  for (const entry of entries) {
    const delta = deltas.get(entry.id);
    if (delta) entry.sinceLastScan = delta;
  }

  // Current behavior and Shields-pair evidence have different freshness
  // requirements. A historical Shields pair must not pin a site's ordinary
  // request/cookie metrics forever, but its paired delta remains the newest
  // available Shields observation until a newer eligible pair exists.
  const sites = selectSiteDataPoints(measured);

  const rollups = buildCategoryRollups(
    sites.map((site) => ({
      category: site.category,
      categoryLabel: site.categoryLabel,
      trackerRequests: site.trackerRequests,
      thirdPartyRequests: site.thirdPartyRequests,
      thirdPartyCookies: site.cookieEvidenceComplete ? site.thirdPartyCookies : null,
      shieldsThirdPartyChange: site.shieldsThirdPartyChange
    }))
  );
  const heaviest = [...sites]
    .filter((site) => site.trackerRequests > 0)
    .sort((a, b) => b.trackerRequests - a.trackerRequests)
    .slice(0, 5);

  const siteCounts = summarizeCorpusSiteCounts(entries);
  const sitemapReports = loadedEntries
    .map(({ entry, lastModifiedAt }) => ({ id: entry.id, lastModifiedAt }))
    .sort((left, right) => left.id.localeCompare(right.id));

  return { entries, sitemapReports, rollups, heaviest, siteCount: sites.length, ...siteCounts };
}

/**
 * Picks the report that represents a site's current behavior in rollups and
 * the leaderboard. Report kind is irrelevant here: the newest eligible visit
 * is the best available observation of current behavior.
 */
export function preferAsSiteDataPoint(candidate: DirectoryEntry, existing: DirectoryEntry): boolean {
  const candidateAt = Date.parse(candidate.scannedAt);
  const existingAt = Date.parse(existing.scannedAt);
  if (!Number.isFinite(candidateAt)) return false;
  if (!Number.isFinite(existingAt)) return true;
  return candidateAt > existingAt || (candidateAt === existingAt && candidate.id.localeCompare(existing.id) > 0);
}

/**
 * One newest behavior row per site, decorated independently with that site's
 * newest eligible Shields delta. Returning copies avoids mutating directory
 * entries that are also rendered individually.
 */
export function selectSiteDataPoints(entries: DirectoryEntry[]): DirectoryEntry[] {
  const currentByDomain = new Map<string, DirectoryEntry>();
  const shieldsByDomain = new Map<string, DirectoryEntry>();

  for (const entry of entries) {
    const current = currentByDomain.get(entry.domain);
    if (!current || preferAsSiteDataPoint(entry, current)) currentByDomain.set(entry.domain, entry);

    if (entry.comparisonType === "shields" && entry.shieldsThirdPartyChange !== null) {
      const shields = shieldsByDomain.get(entry.domain);
      if (!shields || preferAsSiteDataPoint(entry, shields)) shieldsByDomain.set(entry.domain, entry);
    }
  }

  return [...currentByDomain.values()].map((entry) => ({
    ...entry,
    shieldsThirdPartyChange: shieldsByDomain.get(entry.domain)?.shieldsThirdPartyChange ?? null
  }));
}

async function loadCategoryCatalog(): Promise<CatalogEntry[]> {
  const files = ["featured-sites.json", "corpus-seed-sites.json"];
  const catalog: CatalogEntry[] = [];
  for (const file of files) {
    try {
      const raw = await readFile(path.join(process.cwd(), "public", file), "utf8");
      const config = JSON.parse(raw) as {
        categories?: { id: string; label: string }[];
        sites?: { domain: string; category: string }[];
      };
      const labels = new Map((config.categories ?? []).map((category) => [category.id, category.label]));
      for (const site of config.sites ?? []) {
        if (typeof site.domain === "string" && typeof site.category === "string") {
          catalog.push({ domain: site.domain, id: site.category, label: labels.get(site.category) ?? site.category });
        }
      }
    } catch {
      // A catalog file is optional; skip it if missing or malformed.
    }
  }
  return catalog;
}

function categoryFor(domain: string, catalog: CatalogEntry[]): { id: string; label: string } {
  const hit = catalog.find((entry) => domainsMatch(domain, entry.domain));
  return hit ? { id: hit.id, label: hit.label } : { id: "", label: "Other" };
}

type LoadedDirectoryEntry = {
  entry: DirectoryEntry;
  comparisonHistoryKey: string | null;
  lastModifiedAt: string;
};

async function loadDirectoryEntries(catalog: CatalogEntry[]): Promise<LoadedDirectoryEntry[]> {
  const ids = await listStaticReportIds();
  const entries: LoadedDirectoryEntry[] = [];

  for (const id of ids) {
    // The stored read keeps the schema metadata: the directory and researcher
    // exports carry schema version/revision/origin/limited per row, so a v2
    // row is distinguishable from a legacy-derived v1 row. Every readable
    // generation joins the directory (RFC 14.8 atomic consumer migration);
    // the corpus-stats builder keeps its own measurement-cohort policy (v2
    // metrics never join the v1 percentile distribution).
    const readResult = await readStoredReportForId(id);
    if (readResult.outcome !== "found") continue;
    const view = toReportView(readResult.stored);

    // Lead with the baseline (off / unprotected) run for GPC/Shields so the directory
    // lists and ranks what each site actually did, not the protected residual.
    const run = displayRunView(view);
    const arms = comparisonArmViews(view);
    const successfulRuns = view.runs.filter(
      (candidate) =>
        candidate.quality.outcome === "complete" &&
        typeof candidate.status === "number" &&
        candidate.status < 400
    );
    // Keep reserved/test domains out of the public directory, mirroring the gallery
    // manifest exclusion (a reserved-domain report is reachable by permalink only).
    if (isReservedReportDomain(run.domain)) continue;
    const headline = buildReportHeadline(view);
    const { id: category, label: categoryLabel } = categoryFor(run.domain, catalog);
    // The observed signed third-party change of an ELIGIBLE Shields pair
    // (blocking visit minus unblocked baseline; negative = fewer with
    // blocking). A request-count delta is a raw-counts family claim (RFC 4.4),
    // so it needs that family's gate on top of pair validity. This is a
    // paired-visit difference, never a "blocked" count, and an increased pair
    // stays signed: clamping it to zero would misreport an observed increase
    // as "no change" in every aggregate built from this field.
    const shieldsThirdPartyChange =
      arms &&
      view.comparison?.axis === "shields" &&
      view.claims.pairComparison?.allowed === true &&
      view.claims.familyDeltas?.["raw-counts"]?.allowed === true
        ? arms.variant.counts.thirdPartyRequests - arms.baseline.counts.thirdPartyRequests
        : null;

    const entry: DirectoryEntry = {
      id,
      domain: headline.domain,
      tone: headline.tone,
      headline: headline.headline,
      thirdPartyRequests: run.counts.thirdPartyRequests,
      // Tracking services only: counts.knownTrackerRequests also counts
      // operational-only matches (error monitoring, support chat), which must
      // not rank sites on a surface labeled "tracker".
      trackerRequests: trackingServiceRequests(run.evidence),
      thirdPartyCookies: run.counts.thirdPartyCookies,
      shieldsThirdPartyChange,
      category,
      categoryLabel,
      // Recorded by both supported wire generations; malformed timestamps are
      // ignored by temporal pairing rather than silently treated as current.
      scannedAt: view.scannedAt ?? "",
      reportType: view.reportType,
      device: run.conditions.viewport.isMobile ? "mobile" : "desktop",
      gpcEnabled: run.conditions.gpcEnabled,
      consentMode: run.conditions.consentMode,
      consentClicks: consentClicksForView(view),
      status: run.status,
      runOutcome: run.quality.outcome,
      // Coverage spans the primary pair: a comparison still covered its
      // catalogued site when one primary arm failed but the other loaded. Sets
      // in the count summarizer keep a two-arm report from counting it twice.
      reportHasSuccessfulLoad: successfulRuns.length > 0,
      reportHasRequestCappedLoad: successfulRuns.some(runHitRequestRecordingCap),
      requestEvidenceComplete: !familyCensoredOnRun(run, "requests"),
      cookieEvidenceComplete: !familyCensoredOnRun(run, "cookies"),
      capped: runHitRequestRecordingCap(run),
      requestedUrl: run.conditions.requestedUrl,
      finalUrl: run.conditions.finalUrl,
      schemaVersion: readResult.stored.schemaVersion,
      schemaRevision: view.revision,
      schemaOrigin: view.origin,
      limited: view.limited,
      ...corpusExportMetadataForView(view),
      ...(view.comparison
        ? { comparisonType: view.comparison.axis ?? (view.comparison.temporalPair ? ("temporal" as const) : ("custom" as const)) }
        : {})
    };
    const comparisonHistoryKey = comparisonHistoryPairingKey({
      domain: entry.domain,
      reportType: entry.reportType,
      comparisonType: entry.comparisonType,
      consentClicks: entry.consentClicks,
      requestedUrl: entry.requestedUrl,
      finalUrl: entry.finalUrl,
      comparisonHistoryCohort: comparisonHistoryCohortForStoredReport(readResult.stored, view)
    });
    entries.push({
      entry,
      comparisonHistoryKey,
      lastModifiedAt: view.latestRunAt ?? view.scannedAt ?? ""
    });
  }

  return entries.sort(
    (a, b) =>
      b.entry.trackerRequests - a.entry.trackerRequests ||
      b.entry.thirdPartyRequests - a.entry.thirdPartyRequests ||
      a.entry.domain.localeCompare(b.entry.domain)
  );
}
