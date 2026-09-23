import { buildCategoryRollups, type CategoryRollup } from "./category-rollups";
import {
  entryEligibleForCorpusRollups,
  preferAsSiteDataPoint,
  type DirectoryEntry
} from "./corpus-overview";
import { selectPrimaryCorpusCohort, type CorpusCohortIdentity } from "./corpus-cohort";
import { siteProfilePath } from "./site-profile";

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
  /**
   * Every retained report for the site, whatever its eligibility or cohort:
   * the "N reports retained" the linked profile shows. The directory and the
   * category pages print it in one table cell, so it has one meaning on both.
   */
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
  /**
   * Listed sites that also have an eligible visit NEWER than their row, in a
   * cohort this page does not use, with the newest such visit; null when
   * every row is also its site's newest eligible visit. The cohort selector
   * can keep a page on an older cohort (a current-line cohort missing one of
   * five to nine sites fails the handoff), and the rows then describe that
   * cohort's newest visits, not each site's. Derived from the same eligible
   * rows the page is built from, so it restates no eligibility rule.
   */
  newerEligibleOutsideCohort: { siteCount: number; newestScannedAt: string } | null;
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
  return [...retainedReportsBySite(entries).entries()]
    .map(([domain, reports]) => ({
      domain,
      profilePath: siteProfilePath(domain) as string,
      latest: newestEntry(reports),
      reportCount: reports.length
    }))
    .sort((left, right) => left.domain.localeCompare(right.domain));
}

/** Every retained report grouped by site key; a keyless row belongs to no site. */
function retainedReportsBySite(entries: DirectoryEntry[]): Map<string, DirectoryEntry[]> {
  const bySite = new Map<string, DirectoryEntry[]>();
  for (const entry of entries) {
    const domain = entry.siteKey;
    if (!domain) continue;
    const list = bySite.get(domain);
    if (list) list.push(entry);
    else bySite.set(domain, [entry]);
  }
  return bySite;
}

export function directoryPageCount(siteCount: number, pageSize = DIRECTORY_PAGE_SIZE): number {
  return Math.max(1, Math.ceil(siteCount / pageSize));
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
  const retainedBySite = retainedReportsBySite(entries);
  const reportsBySiteAndCohort = new Map<string, DirectoryEntry[]>();
  const eligibleBySite = new Map<string, DirectoryEntry[]>();

  for (const entry of entries) {
    if (!entryEligibleForCorpusRollups(entry) || !entry.category) continue;
    const domain = entry.siteKey;
    if (!domain) continue;
    const key = `${domain}\u0000${entry.corpusCohort.id}`;
    const list = reportsBySiteAndCohort.get(key);
    if (list) list.push(entry);
    else reportsBySiteAndCohort.set(key, [entry]);
    const siteReports = eligibleBySite.get(domain);
    if (siteReports) siteReports.push(entry);
    else eligibleBySite.set(domain, [entry]);
  }

  const currentSites = [...reportsBySiteAndCohort.values()].map((reports) => {
    const domain = reports[0].siteKey as string;
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
      // The site's retained total, as on /directory/ and the profile. The
      // eligible in-cohort count this used to carry printed "1 report" for a
      // site the directory row beside it showed with 12.
      reportCount: (retainedBySite.get(domain) as DirectoryEntry[]).length
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
      sites: sortedSites,
      newerEligibleOutsideCohort: newerEligibleOutsideCohort(sortedSites, eligibleBySite)
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

/**
 * Count the listed sites whose eligible evidence includes a visit newer than
 * the row the page shows, from a different cohort, and date the newest one.
 * Mirrors /status's newerEligibleOutsideAggregate at row scale: the page
 * keeps its one denominator and says what it is leaving out.
 */
function newerEligibleOutsideCohort(
  sites: DirectorySite[],
  eligibleBySite: Map<string, DirectoryEntry[]>
): CategoryEvidencePage["newerEligibleOutsideCohort"] {
  let siteCount = 0;
  const newerScannedAt: string[] = [];
  for (const site of sites) {
    const shownAt = Date.parse(site.latest.scannedAt);
    const newer = (eligibleBySite.get(site.domain) ?? []).filter(
      (report) =>
        report.corpusCohort.id !== site.latest.corpusCohort.id && Date.parse(report.scannedAt) > shownAt
    );
    if (newer.length === 0) continue;
    siteCount += 1;
    newerScannedAt.push(...newer.map((report) => report.scannedAt));
  }
  return siteCount > 0 ? { siteCount, newestScannedAt: newestTimestamp(newerScannedAt) } : null;
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
