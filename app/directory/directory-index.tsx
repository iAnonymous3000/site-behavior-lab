import Link from "next/link";
import { notFound } from "next/navigation";
import { loadCorpusOverview } from "@/lib/corpus-overview";
import {
  buildCategoryEvidencePages,
  buildDirectorySites,
  directoryPageCount,
  type DirectorySite
} from "@/lib/directory-view";
import { reportPagePath } from "@/lib/report-locator";
import { sitePagesBasePath } from "@/lib/site-url";
import { reportKindLabel } from "@/lib/text-format";
import { DirectoryControls } from "./directory-controls";
import { DirectoryTable, type DirectoryTableRow } from "./directory-table";
import styles from "./directory.module.css";
import { SiteChrome } from "../_components/site-chrome";

export async function DirectoryIndex({ page }: { page: number }) {
  const { entries } = await loadCorpusOverview();
  const sites = buildDirectorySites(entries);
  const categoryPages = buildCategoryEvidencePages(entries);
  // The paginated routes still resolve, so nothing already linked or indexed
  // 404s, but every one of them now renders the same complete, sortable table
  // and canonicalises to /directory/. A page slice cannot answer "which sites
  // loaded the most tracking-service requests" -- a sort over twenty-four rows
  // says "most" and means "most of these twenty-four".
  const pageCount = directoryPageCount(sites.length);
  if (!Number.isInteger(page) || page < 1 || page > pageCount) notFound();

  const categoryPathById = new Map(categoryPages.map((category) => [category.id, category.path]));
  const pagesBasePath = sitePagesBasePath();
  const searchItems = sites.map((site) => ({
    domain: site.domain,
    path: `${pagesBasePath}${site.profilePath}/`,
    category: site.latest.categoryLabel,
    categoryPath: categoryPathById.get(site.latest.category) ?? ""
  }));

  return (
    <SiteChrome activePath="/directory/">
      <div className={styles.page}>
      <header className={styles.header}>
        <p className="eyebrow">Evidence directory</p>
        <h1>One current profile per scanned site</h1>
        <p>
          Browse {sites.length.toLocaleString()} canonical site profiles backed by {entries.length.toLocaleString()} currently retained controlled-visit {entries.length === 1 ? "report" : "reports"}. Each profile shows its versioned public-corpus timeline as retained today.
        </p>
        <p className={styles.exportLine}>
          Current versioned report-level exports: <a href={`${sitePagesBasePath()}/corpus.json`}>JSON</a>
          {" · "}
          <a href={`${sitePagesBasePath()}/corpus.csv`}>CSV</a>
          {" "}(curated measured corpus, not a random sample of the web)
        </p>
      </header>

      <DirectoryControls
        sites={searchItems}
        categories={categoryPages.map((category) => ({
          id: category.id,
          label: category.label,
          // window.location.assign bypasses next/link's automatic basePath
          // prefixing, so category paths need the same explicit prefix as the
          // site-profile search paths above; without it a base-path deployment
          // (GitHub project page) 404s on category navigation.
          path: `${pagesBasePath}${category.path}/`,
          siteCount: category.sites.length
        }))}
      />

      {categoryPages.length > 0 && page === 1 && (
        <section className={styles.categories} aria-labelledby="category-title">
          <div className={styles.sectionHeading}>
            <div>
              <p className="eyebrow">Evidence by category</p>
              <h2 id="category-title">Observed behavior within each category</h2>
            </div>
            <p>
              Only categories with at least five eligible canonical sites receive an aggregate page. Each category
              publishes one methodology cohort, so its medians are comparable inside the category rather than against
              another category&apos;s.
            </p>
          </div>
          <div className={styles.categoryGrid}>
            {categoryPages.map((category) => (
              <Link className={styles.categoryCard} href={`${category.path}/`} key={category.id}>
                <span className={styles.categoryTop}>
                  <strong>{category.label}</strong>
                  <small>{category.sites.length} sites</small>
                </span>
                <span>
                  Separate medians across included sites: <b>{category.rollup.medianThirdParty.toLocaleString()}</b> third-party and{" "}
                  <b>{category.rollup.medianTrackers.toLocaleString()}</b> third-party tracking-service requests
                </span>
                <small>Newest included visit: {formatDate(category.lastScannedAt)}</small>
              </Link>
            ))}
          </div>
        </section>
      )}

      <section className={styles.sites} aria-labelledby="sites-title">
        <div className={styles.sectionHeading}>
          <div>
            <p className="eyebrow">Site profiles</p>
            <h2 id="sites-title">
              {sites.length === 0 ? "No published sites" : `All ${sites.length} scanned sites`}
            </h2>
          </div>
          <p>Sort any column, or filter by domain or category.</p>
        </div>
        {sites.length > 0 && <DirectoryTable rows={sites.map((site) => tableRow(pagesBasePath, site))} />}
      </section>

      <aside className={styles.caveat}>
        The newest published report is shown for navigation, including failed or incomplete visits when that is the
        latest observation. Category medians use a stricter sample: one newest successful, request-complete, uncapped
        passive visit per canonical site. Consent-interaction arms are excluded. Visit results can vary because of ad
        rotation, experiments, caching, region and bot detection.
      </aside>
      </div>
    </SiteChrome>
  );
}

/**
 * One table row per site.
 *
 * Every href is prefixed explicitly rather than routed through next/link: the
 * table is a client component that renders raw anchors, so nothing prefixes the
 * Pages base path for it, and an unprefixed "/sites/x/" 404s on a base-path
 * deployment in a way that only reproduces in CI.
 */
function tableRow(basePath: string, site: DirectorySite): DirectoryTableRow {
  const report = site.latest;
  return {
    domain: site.domain,
    profileHref: `${basePath}${site.profilePath}/`,
    reportHref: `${basePath}${reportPagePath(report.id)}/`,
    headline: report.headline,
    tone: report.tone,
    categoryLabel: report.categoryLabel,
    reportCount: site.reportCount,
    scannedAt: report.scannedAt,
    scannedLabel: formatDate(report.scannedAt),
    device: report.device,
    kindLabel: reportKindLabel(report),
    thirdPartyRequests: report.thirdPartyRequests,
    trackerRequests: report.trackerRequests,
    thirdPartyCookies: report.thirdPartyCookies,
    requestEvidenceComplete: report.requestEvidenceComplete,
    cookieEvidenceComplete: report.cookieEvidenceComplete,
    capped: report.capped
  };
}

export function directoryPath(page: number): string {
  return page <= 1 ? "/directory/" : `/directory/page/${page}/`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "date unavailable"
    : date.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}
