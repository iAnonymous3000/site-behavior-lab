import { readFile } from "node:fs/promises";
import path from "node:path";
import { buildCategoryRollups, type CategoryRollup } from "./category-rollups";
import { domainsMatch } from "./featured-sites";
import { buildReportHeadline, displayScanResult, type HeadlineTone } from "./report-headline";
import { readReportForId } from "./report-source";
import { isReservedReportDomain } from "./reserved-report-domains";
import { listStaticReportIds } from "./static-report-files";
import { computeSinceLastScan, type SinceLastScan } from "./temporal-deltas";
import type { ComparisonType, ScanReport } from "./types";

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
  shieldsBlocked: number | null;
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
   * Which consent-banner choices the scanner verifiably clicked; null on reports
   * that never attempted a consent interaction. Anything short of
   * "accept-and-reject" on a consent comparison means at least one run reflects
   * the PRE-consent state, so the report is not evidence of post-choice behavior.
   */
  consentClicks: ConsentClicks | null;
  /** Lead run's top-level HTTP status; >= 400 means an error/block page, not the site. */
  status: number | null;
  /** Set on a site's newest report when an earlier report of the same kind exists. */
  sinceLastScan?: SinceLastScan;
};

export type ConsentClicks = "accept-and-reject" | "accept-only" | "reject-only" | "none";

export type CorpusOverview = {
  entries: DirectoryEntry[];
  rollups: CategoryRollup[];
  heaviest: DirectoryEntry[];
  siteCount: number;
};

type CatalogEntry = { domain: string; id: string; label: string };

/** Same rule as lib/report-insights scanLoadFailureStatus: HTTP >= 400 = error/block page. */
function entryLoadFailed(entry: DirectoryEntry): boolean {
  return typeof entry.status === "number" && entry.status >= 400;
}

export async function loadCorpusOverview(): Promise<CorpusOverview> {
  const catalog = await loadCategoryCatalog();
  const entries = await loadDirectoryEntries(catalog);

  // Failed loads (HTTP >= 400: bot walls, outages) stay listed with their honest
  // "did not load" headline, but they are error pages, not measured site
  // behavior, so they must not feed the statistics: no since-last-scan pairing
  // (a delta against an error page reads as a site change), no category
  // medians, no leaderboard.
  const measured = entries.filter((entry) => !entryLoadFailed(entry));

  // "Changed since last scan": each site's newest report is paired with its most
  // recent predecessor of the same kind (see lib/temporal-deltas.ts for why kinds
  // never mix), so the directory can show what a re-scan changed.
  const deltas = computeSinceLastScan(measured);
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
      shieldsBlocked: site.shieldsBlocked
    }))
  );
  const heaviest = [...sites]
    .filter((site) => site.trackerRequests > 0)
    .sort((a, b) => b.trackerRequests - a.trackerRequests)
    .slice(0, 5);

  return { entries, rollups, heaviest, siteCount: sites.length };
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

/**
 * Derives the verified consent-click state from the report's recorded
 * interactions. Classification must come from what the scanner actually
 * clicked, never from the requested mode: most consent runs find no clickable
 * banner and therefore only observed the pre-consent state.
 */
export function consentClicksForReport(report: ScanReport): ConsentClicks | null {
  if (report.reportType === "comparison") {
    if (report.comparisonType !== "consent") return null;
    const accepted = report.baseline.consentInteraction?.clicked === true;
    const rejected = report.variant.consentInteraction?.clicked === true;
    if (accepted && rejected) return "accept-and-reject";
    if (accepted) return "accept-only";
    if (rejected) return "reject-only";
    return "none";
  }

  const interaction = report.consentInteraction;
  if (!interaction) return null;
  if (!interaction.clicked) return "none";
  return interaction.mode === "accept-all" ? "accept-only" : "reject-only";
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

async function loadDirectoryEntries(catalog: CatalogEntry[]): Promise<DirectoryEntry[]> {
  const ids = await listStaticReportIds();
  const entries: DirectoryEntry[] = [];

  for (const id of ids) {
    const report = await readReportForId(id);
    if (!report) continue;

    // Lead with the baseline (off / unprotected) run for GPC/Shields so the directory
    // lists and ranks what each site actually did, not the protected residual.
    const result = displayScanResult(report);
    // Keep reserved/test domains out of the public directory, mirroring the gallery
    // manifest exclusion (a reserved-domain report is reachable by permalink only).
    if (isReservedReportDomain(result.summary.firstPartyDomain)) continue;
    const headline = buildReportHeadline(report);
    const { id: category, label: categoryLabel } = categoryFor(result.summary.firstPartyDomain, catalog);
    const shieldsBlocked =
      report.reportType === "comparison" && report.comparisonType === "shields"
        ? Math.max(0, report.baseline.summary.thirdPartyRequests - report.variant.summary.thirdPartyRequests)
        : null;

    entries.push({
      id,
      domain: headline.domain,
      tone: headline.tone,
      headline: headline.headline,
      thirdPartyRequests: result.summary.thirdPartyRequests,
      trackerRequests: result.summary.knownTrackerRequests,
      thirdPartyCookies: result.summary.thirdPartyCookies,
      shieldsBlocked,
      category,
      categoryLabel,
      scannedAt: report.reportType === "comparison" ? report.scannedAt : result.conditions.scannedAt,
      reportType: report.reportType === "comparison" ? "comparison" : "single",
      device: result.conditions.viewport.isMobile ? "mobile" : "desktop",
      gpcEnabled: result.conditions.gpcEnabled,
      consentMode: result.conditions.consentMode ?? "observe",
      consentClicks: consentClicksForReport(report),
      status: typeof result.summary.status === "number" ? result.summary.status : null,
      ...(report.reportType === "comparison" ? { comparisonType: report.comparisonType } : {})
    });
  }

  return entries.sort(
    (a, b) =>
      b.trackerRequests - a.trackerRequests ||
      b.thirdPartyRequests - a.thirdPartyRequests ||
      a.domain.localeCompare(b.domain)
  );
}
