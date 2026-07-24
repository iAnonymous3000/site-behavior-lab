import { buildCategoryRollups, type CategoryRollup } from "./category-rollups";
import {
  entryEligibleForCorpusRollups,
  preferAsSiteDataPoint,
  type DirectoryEntry
} from "./corpus-overview";
import type { CorpusCohortIdentity } from "./corpus-cohort";
import { siteProfileKey, siteProfilePath } from "./site-profile";

/** Keep every crawlable directory document comfortably bounded. */
export const DIRECTORY_PAGE_SIZE = 24;

/**
 * A category needs enough independently scanned sites to support a useful
 * median and a page with more than a thin list of links. Categories below the
 * gate remain visible through individual site profiles but do not receive an
 * indexable aggregate page.
 */
export const CATEGORY_MIN_SITE_COUNT = 5;

export type DirectorySite = {
  domain: string;
  profilePath: string;
  latest: DirectoryEntry;
  reportCount: number;
};

export type CategoryEvidencePage = {
  id: string;
  label: string;
  path: string;
  lastScannedAt: string;
  /** Exact methodology cohort backing every site and median on this page. */
  cohort: CorpusCohortIdentity;
  rollup: CategoryRollup;
  sites: DirectorySite[];
};

/** Stable route for a quality-gated evidence category. */
export function categoryPagePath(id: string): string {
  return `/categories/${encodeURIComponent(id)}`;
}

/**
 * Collapse report rows to one newest row per registrable site. All reports
 * remain on the linked profile; this view only prevents the directory from
 * repeating the same site hundreds of times.
 */
export function buildDirectorySites(entries: DirectoryEntry[]): DirectorySite[] {
  const bySite = new Map<string, DirectoryEntry[]>();

  for (const entry of entries) {
    const domain = siteProfileKey(entry.domain);
    if (!domain) continue;
    const list = bySite.get(domain);
    if (list) list.push(entry);
    else bySite.set(domain, [entry]);
  }

  return [...bySite.entries()]
    .map(([domain, reports]) => ({
      domain,
      profilePath: siteProfilePath(domain) as string,
      latest: newestEntry(reports),
      reportCount: reports.length
    }))
    .sort((left, right) => left.domain.localeCompare(right.domain));
}

export function directoryPageCount(siteCount: number, pageSize = DIRECTORY_PAGE_SIZE): number {
  return Math.max(1, Math.ceil(siteCount / pageSize));
}

export function directoryPageSlice<T>(items: T[], page: number, pageSize = DIRECTORY_PAGE_SIZE): T[] {
  if (!Number.isInteger(page) || page < 1 || pageSize < 1) return [];
  const start = (page - 1) * pageSize;
  return items.slice(start, start + pageSize);
}

/**
 * Build category pages only from newest eligible passive evidence. Failed,
 * capped, incomplete and post-choice consent visits never enter the sample.
 * Canonical-site grouping prevents subdomains from counting as independent
 * sites in the same category aggregate.
 */
export function buildCategoryEvidencePages(
  entries: DirectoryEntry[],
  minimumSites = CATEGORY_MIN_SITE_COUNT
): CategoryEvidencePage[] {
  const reportsBySiteAndCohort = new Map<string, DirectoryEntry[]>();

  for (const entry of entries) {
    if (!entryEligibleForCorpusRollups(entry) || !entry.category) continue;
    const domain = siteProfileKey(entry.domain);
    if (!domain) continue;
    const key = `${domain}\u0000${entry.corpusCohort.id}`;
    const list = reportsBySiteAndCohort.get(key);
    if (list) list.push(entry);
    else reportsBySiteAndCohort.set(key, [entry]);
  }

  const currentSites = [...reportsBySiteAndCohort.values()].map((reports) => {
    const domain = siteProfileKey(reports[0].domain) as string;
    const latest = reports.reduce((selected, candidate) =>
      preferAsSiteDataPoint(candidate, selected) ? candidate : selected
    );
    const shieldsReports = reports.filter(
      (report) =>
        report.category === latest.category &&
        report.comparisonType === "shields" &&
        report.shieldsThirdPartyChange !== null
    );
    const latestShields = shieldsReports.length > 0
      ? shieldsReports.reduce((selected, candidate) =>
          preferAsSiteDataPoint(candidate, selected) ? candidate : selected
        )
      : null;
    return {
      domain,
      profilePath: siteProfilePath(domain) as string,
      latest: {
        ...latest,
        shieldsThirdPartyChange: latestShields?.shieldsThirdPartyChange ?? null
      },
      reportCount: reports.length
    } satisfies DirectorySite;
  });

  const byCategoryAndCohort = new Map<string, DirectorySite[]>();
  for (const site of currentSites) {
    const key = `${site.latest.category}\u0000${site.latest.corpusCohort.id}`;
    const list = byCategoryAndCohort.get(key);
    if (list) list.push(site);
    else byCategoryAndCohort.set(key, [site]);
  }

  const candidates: CategoryEvidencePage[] = [];
  for (const sites of byCategoryAndCohort.values()) {
    const id = sites[0].latest.category;
    const sortedSites = [...sites].sort((left, right) => left.domain.localeCompare(right.domain));
    const [rollup] = buildCategoryRollups(
      sortedSites.map(({ latest }) => ({
        category: id,
        categoryLabel: latest.categoryLabel,
        trackerRequests: latest.trackerRequests,
        thirdPartyRequests: latest.thirdPartyRequests,
        thirdPartyCookies: latest.cookieEvidenceComplete ? latest.thirdPartyCookies : null,
        shieldsThirdPartyChange: latest.shieldsThirdPartyChange
      }))
    );
    if (!rollup) continue;

    candidates.push({
      id,
      label: rollup.label,
      path: categoryPagePath(id),
      lastScannedAt: newestTimestamp(sortedSites.map((site) => site.latest.scannedAt)),
      cohort: sortedSites[0].latest.corpusCohort,
      rollup,
      sites: sortedSites
    });
  }

  // A category route has one denominator. During a methodology migration,
  // publish the largest cohort rather than silently adding incompatible rows.
  const selectedByCategory = new Map<string, CategoryEvidencePage>();
  for (const candidate of candidates) {
    const current = selectedByCategory.get(candidate.id);
    if (
      !current ||
      candidate.sites.length > current.sites.length ||
      (candidate.sites.length === current.sites.length && candidate.cohort.id.localeCompare(current.cohort.id) < 0)
    ) {
      selectedByCategory.set(candidate.id, candidate);
    }
  }

  return [...selectedByCategory.values()]
    .filter((page) => page.sites.length >= minimumSites)
    .sort((left, right) => left.label.localeCompare(right.label));
}

function newestEntry(entries: DirectoryEntry[]): DirectoryEntry {
  return entries.reduce((selected, candidate) => {
    const selectedAt = Date.parse(selected.scannedAt);
    const candidateAt = Date.parse(candidate.scannedAt);
    if (!Number.isFinite(selectedAt)) return Number.isFinite(candidateAt) ? candidate : selected;
    if (!Number.isFinite(candidateAt)) return selected;
    if (candidateAt !== selectedAt) return candidateAt > selectedAt ? candidate : selected;
    return candidate.id.localeCompare(selected.id) > 0 ? candidate : selected;
  });
}

function newestTimestamp(values: string[]): string {
  let selected = "";
  let selectedAt = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp) && timestamp > selectedAt) {
      selected = value;
      selectedAt = timestamp;
    }
  }
  return selected;
}
