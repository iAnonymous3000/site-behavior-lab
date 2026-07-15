import { readFile } from "node:fs/promises";
import path from "node:path";
import { buildCategoryRollups, type CategoryRollup } from "./category-rollups";
import { domainsMatch } from "./featured-sites";
import { buildReportHeadline, type HeadlineTone } from "./report-headline";
import { trackingServiceRequests } from "./report-insights";
import { readStoredReportForId } from "./report-source";
import { comparisonArmViews, displayRunView, familyCensoredOnRun, toReportView, type ReportView } from "./scan-report-view";
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
   * Set only when an earlier report shares the versioned passive-history key.
   * The filter-list snapshot date may differ; this is a descriptive raw/catalog delta, never a Shields delta.
   */
  sinceLastScan?: SinceLastScan;
};

export type CorpusOverview = {
  entries: DirectoryEntry[];
  rollups: CategoryRollup[];
  heaviest: DirectoryEntry[];
  /**
   * Distinct sites in the cross-version passive sample (loaded, uncapped, no
   * post-choice consent lead): the basis of the rollups, leaderboard, and
   * since-last-scan pairing.
   */
  siteCount: number;
  /**
   * Distinct sites with at least one successful load, INCLUDING request-capped
   * recordings: what the corpus covers, as opposed to what it measures.
   */
  coverageSiteCount: number;
};

type CatalogEntry = { domain: string; id: string; label: string };

/** A missing main-document response or HTTP >= 400 is not a successful site load. */
function entryLoadFailed(entry: DirectoryEntry): boolean {
  return typeof entry.status !== "number" || entry.status >= 400;
}

/** Consent interaction arms are post-choice states, not passive site visits. */
export function entryEligibleForCorpusRollups(entry: DirectoryEntry): boolean {
  return (
    !entryLoadFailed(entry) &&
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
  // with a predecessor carrying the same versioned passive-history key used
  // by the archive. The key is absent on failed, capped, simulated, unknown,
  // or mismatched-subject visits.
  const deltas = computeComparableSinceLastScan(
    measuredLoaded.map(({ entry, comparisonHistoryKey }) => ({ ...entry, comparisonHistoryKey }))
  );
  for (const entry of entries) {
    const delta = deltas.get(entry.id);
    if (delta) entry.sinceLastScan = delta;
  }

  // One data point per site for the rollups and leaderboard (a site may carry both
  // a GPC and a Shields report; prefer the Shields one so the blocked number is real).
  const byDomain = new Map<string, DirectoryEntry>();
  for (const entry of measured) {
    const existing = byDomain.get(entry.domain);
    if (!existing || preferAsSiteDataPoint(entry, existing)) {
      byDomain.set(entry.domain, entry);
    }
  }
  const sites = [...byDomain.values()];

  const rollups = buildCategoryRollups(
    sites.map((site) => ({
      category: site.category,
      categoryLabel: site.categoryLabel,
      trackerRequests: site.trackerRequests,
      thirdPartyRequests: site.thirdPartyRequests,
      thirdPartyCookies: site.thirdPartyCookies,
      shieldsThirdPartyChange: site.shieldsThirdPartyChange
    }))
  );
  const heaviest = [...sites]
    .filter((site) => site.trackerRequests > 0)
    .sort((a, b) => b.trackerRequests - a.trackerRequests)
    .slice(0, 5);

  // Coverage counts every distinct site that loaded, including capped
  // recordings the statistics exclude.
  const coverageDomains = new Set(entries.filter((entry) => !entryLoadFailed(entry)).map((entry) => entry.domain));

  return { entries, rollups, heaviest, siteCount: sites.length, coverageSiteCount: coverageDomains.size };
}

/**
 * Picks the report that represents a site in the rollups and leaderboard:
 * prefer a Shields comparison (its blocked count is real), then the NEWEST
 * scan. Newest matters because the archive keeps every historical report and
 * the entry list arrives sorted heaviest-first, so keeping the first hit would
 * pin category medians and "heaviest" rankings to each site's historical
 * maximum instead of its current behavior.
 */
export function preferAsSiteDataPoint(candidate: DirectoryEntry, existing: DirectoryEntry): boolean {
  const candidateShields = candidate.comparisonType === "shields";
  const existingShields = existing.comparisonType === "shields";
  if (candidateShields !== existingShields) return candidateShields;
  return Date.parse(candidate.scannedAt) > Date.parse(existing.scannedAt);
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

type LoadedDirectoryEntry = { entry: DirectoryEntry; comparisonHistoryKey: string | null };

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
      capped: familyCensoredOnRun(run, "requests"),
      requestedUrl: run.conditions.requestedUrl,
      finalUrl: run.conditions.finalUrl,
      schemaVersion: readResult.stored.schemaVersion,
      schemaRevision: view.revision,
      schemaOrigin: view.origin,
      limited: view.limited,
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
    entries.push({ entry, comparisonHistoryKey });
  }

  return entries.sort(
    (a, b) =>
      b.entry.trackerRequests - a.entry.trackerRequests ||
      b.entry.thirdPartyRequests - a.entry.thirdPartyRequests ||
      a.entry.domain.localeCompare(b.entry.domain)
  );
}
