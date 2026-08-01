import Link from "next/link";
import { notFound } from "next/navigation";
import { loadCorpusOverview } from "@/lib/corpus-overview";
import {
  buildCategoryEvidencePages,
  buildDirectorySites,
  DIRECTORY_PAGE_SIZE,
  directoryPageCount,
  directoryPageSlice,
  type DirectorySite
} from "@/lib/directory-view";
import { reportPagePath } from "@/lib/report-locator";
import { sitePagesBasePath } from "@/lib/site-url";
import { reportKindLabel } from "@/lib/text-format";
import { DirectoryControls } from "./directory-controls";
import styles from "./directory.module.css";
import { TrustLinks } from "@/app/_components/trust-links";

export async function DirectoryIndex({ page }: { page: number }) {
  const { entries } = await loadCorpusOverview();
  const sites = buildDirectorySites(entries);
  const categoryPages = buildCategoryEvidencePages(entries);
  const pageCount = directoryPageCount(sites.length);
  if (!Number.isInteger(page) || page < 1 || page > pageCount) notFound();
  const visibleSites = directoryPageSlice(sites, page);
  const firstSiteNumber = sites.length === 0 ? 0 : (page - 1) * DIRECTORY_PAGE_SIZE + 1;
  const lastSiteNumber = sites.length === 0 ? 0 : (page - 1) * DIRECTORY_PAGE_SIZE + visibleSites.length;

  const categoryPathById = new Map(categoryPages.map((category) => [category.id, category.path]));
  const pagesBasePath = sitePagesBasePath();
  const searchItems = sites.map((site) => ({
    domain: site.domain,
    path: `${pagesBasePath}${site.profilePath}/`,
    category: site.latest.categoryLabel,
    categoryPath: categoryPathById.get(site.latest.category) ?? ""
  }));

  return (
    <main className={styles.page}>
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
        <Link className={styles.backLink} href="/">&larr; Scan a site</Link>
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
              {sites.length === 0 ? "No published sites" : `Sites ${firstSiteNumber} to ${lastSiteNumber} of ${sites.length}`}
            </h2>
          </div>
          {pageCount > 1 && <p>Page {page} of {pageCount}</p>}
        </div>
        {visibleSites.length > 0 && (
          <ul className={styles.siteList}>
            {visibleSites.map((site) => <DirectorySiteCard basePath={pagesBasePath} key={site.domain} site={site} />)}
          </ul>
        )}
        <DirectoryPagination page={page} pageCount={pageCount} />
      </section>

      <aside className={styles.caveat}>
        The newest published report is shown for navigation, including failed or incomplete visits when that is the
        latest observation. Category medians use a stricter sample: one newest successful, request-complete, uncapped
        passive visit per canonical site. Consent-interaction arms are excluded. Visit results can vary because of ad
        rotation, experiments, caching, region and bot detection.
      </aside>
      <TrustLinks />
    </main>
  );
}

function DirectorySiteCard({ basePath, site }: { basePath: string; site: DirectorySite }) {
  const report = site.latest;
  const profileHref = `${basePath}${site.profilePath}/`;
  return (
    <li className={`${styles.siteCard} tone-${report.tone}`}>
      <a className={styles.profileLink} href={profileHref}>
        <span className={styles.siteTop}>
          <strong>{site.domain}</strong>
          <small>{site.reportCount} {site.reportCount === 1 ? "report" : "reports"}</small>
        </span>
        <span className={styles.headline}>{report.headline}</span>
        <span className={styles.metrics}>
          <span>
            {!report.requestEvidenceComplete && "at least "}
            <b>{report.thirdPartyRequests.toLocaleString()}</b> third-party requests
          </span>
          <span>
            {!report.requestEvidenceComplete && "at least "}
            <b>{report.trackerRequests.toLocaleString()}</b> third-party tracking-service requests
          </span>
          <span>
            <b>{report.cookieEvidenceComplete ? report.thirdPartyCookies.toLocaleString() : "Not measured"}</b>{" "}
            third-party cookies
          </span>
        </span>
        <span className={styles.reportMeta}>
          Latest: {formatDate(report.scannedAt)} · {reportKindLabel(report)} · {report.device}
          {!report.requestEvidenceComplete && ` · ${report.capped ? "recording capped" : "request evidence incomplete"}`}
        </span>
      </a>
      <div className={styles.cardActions}>
        <a href={profileHref}>View profile and history</a>
        <Link href={`${reportPagePath(report.id)}/`}>Open latest evidence</Link>
      </div>
    </li>
  );
}

function DirectoryPagination({ page, pageCount }: { page: number; pageCount: number }) {
  if (pageCount <= 1) return null;
  return (
    <nav className={styles.pagination} aria-label="Directory pages">
      {page > 1 && <Link href={directoryPath(page - 1)} rel="prev">&larr; Previous</Link>}
      <span className={styles.pageLinks}>
        {Array.from({ length: pageCount }, (_, index) => index + 1).map((number) =>
          number === page ? (
            <span aria-current="page" className={styles.currentPage} key={number}>{number}</span>
          ) : (
            <Link href={directoryPath(number)} key={number}>{number}</Link>
          )
        )}
      </span>
      {page < pageCount && <Link href={directoryPath(page + 1)} rel="next">Next &rarr;</Link>}
    </nav>
  );
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
