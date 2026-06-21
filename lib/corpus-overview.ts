import { readFile } from "node:fs/promises";
import path from "node:path";
import { buildCategoryRollups, type CategoryRollup } from "./category-rollups";
import { domainsMatch } from "./featured-sites";
import { buildReportHeadline, displayScanResult, type HeadlineTone } from "./report-headline";
import { readReportForId } from "./report-source";
import { isReservedReportDomain } from "./reserved-report-domains";
import { listStaticReportIds } from "./static-report-files";
import type { ComparisonType } from "./types";

/**
 * Server-only: loads the committed report corpus and derives the index-level views
 * shared by the directory page and the homepage hero — per-report entries, the
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
};

export type CorpusOverview = {
  entries: DirectoryEntry[];
  rollups: CategoryRollup[];
  heaviest: DirectoryEntry[];
  siteCount: number;
};

type CatalogEntry = { domain: string; id: string; label: string };

export async function loadCorpusOverview(): Promise<CorpusOverview> {
  const catalog = await loadCategoryCatalog();
  const entries = await loadDirectoryEntries(catalog);

  // One data point per site for the rollups and leaderboard (a site may carry both
  // a GPC and a Shields report; prefer the Shields one so the blocked number is real).
  const byDomain = new Map<string, DirectoryEntry>();
  for (const entry of entries) {
    const existing = byDomain.get(entry.domain);
    if (!existing || (entry.comparisonType === "shields" && existing.comparisonType !== "shields")) {
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
