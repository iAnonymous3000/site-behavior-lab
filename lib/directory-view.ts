import { buildCategoryRollups, type CategoryRollup } from "./category-rollups";
import {
  entryEligibleForCorpusRollups,
  preferAsSiteDataPoint,
  type DirectoryEntry
} from "./corpus-overview";
import { selectPrimaryCorpusCohort, type CorpusCohortIdentity } from "./corpus-cohort";
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

  // A category route has one denominator, chosen by the SAME rule as every
  // other cohort selection in this project: composition-vetted, then newest
  // evidence wins. `selectAggregateCorpusCohort` and the stats builder both
  // call `selectPrimaryCorpusCohort` and neither restates it; this was the
  // third caller, and it restated it as largest-wins.
  //
  // That is the rule `lib/corpus-cohort.ts` documents as wrong, for a reason
  // this route demonstrated live: a cohort keyed on an UNRECORDED methodology
  // can never receive another scan, so size alone pins a category to
  // measurements no amount of scanning can refresh. Six of the twelve
  // published categories were owned by a frozen 2026-07-06
  // `legacy-v1-methodology-unspecified` cohort, and every one of them had won
  // on an EXACT TIE against an equally sized current-line cohort up to five
  // weeks newer, resolved by `"v1:legacy-" < "v1:shields-"`. Because a tie
  // survives rescanning the same sites, the current line could only take those
  // pages by gaining a site the frozen cohort never measured.
  const byCategory = new Map<string, CategoryEvidencePage[]>();
  for (const candidate of candidates) {
    const list = byCategory.get(candidate.id);
    if (list) list.push(candidate);
    else byCategory.set(candidate.id, [candidate]);
  }

  const selectedByCategory = new Map<string, CategoryEvidencePage>();
  for (const [id, group] of byCategory) {
    // THE FLOOR IS APPLIED HERE, BEFORE THE SELECTOR, and that ordering is the
    // whole reason this is not a bare delegation.
    //
    // `selectPrimaryCorpusCohort` reduces to the v1 generation whenever ANY v1
    // candidate exists, and it does that BEFORE its own floor. That is right
    // for the corpus aggregate, which must never publish a blended denominator
    // and holds the whole site on v1 until r2 takes over. Applied to a category
    // unfiltered it also means a single one-site v1 leftover can beat a
    // complete r2 cohort and then fail `sites.length >= minimumSites` below --
    // deleting a live route from generateStaticParams and sitemap.xml, and
    // 404ing every inbound link to it. Filtering to cohorts that can actually
    // carry the page first keeps the generation rule and cannot starve the
    // category with a candidate too small to publish.
    const eligible = group.filter((candidate) => candidate.sites.length >= minimumSites);
    const publishable = eligible.length > 0 ? eligible : group;
    const selected = selectPrimaryCorpusCohort(
      publishable.map((candidate) => ({
        identity: candidate.cohort,
        siteCount: candidate.sites.length,
        latestRunAt: candidate.lastScannedAt,
        sites: candidate.sites.map((site) => site.domain)
      })),
      minimumSites
    );
    const page = selected
      ? publishable.find((candidate) => candidate.cohort.id === selected.identity.id)
      : undefined;
    if (page) selectedByCategory.set(id, page);
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
