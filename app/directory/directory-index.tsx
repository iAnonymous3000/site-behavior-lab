import Link from "next/link";
import { notFound } from "next/navigation";
import { loadCorpusOverview } from "@/lib/corpus-overview";
import {
  buildCategoryEvidencePages,
  buildDirectorySites,
  directoryPageCount
} from "@/lib/directory-view";
import { sitePagesBasePath } from "@/lib/site-url";
import { formatEvidenceDate, siteEvidenceRow } from "@/lib/site-evidence-row";
import { DirectoryControls } from "./directory-controls";
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

  const pagesBasePath = sitePagesBasePath();

  return (
    <SiteChrome activePath="/directory/">
      <div className={styles.page}>
      <header className="page-header">
        <p className="eyebrow">Scanned sites</p>
        <h1>One current profile per scanned site</h1>
        <p className="lede">
          {sites.length.toLocaleString()} canonical site profiles backed by {entries.length.toLocaleString()} currently retained controlled-visit {entries.length === 1 ? "report" : "reports"}. Each profile shows its versioned public-corpus timeline as retained today.
        </p>
        <p className="page-meta">
          Current versioned report-level exports: <a href={`${sitePagesBasePath()}/corpus.json`}>JSON</a>
          {" · "}
          <a href={`${sitePagesBasePath()}/corpus.csv`}>CSV</a>
          {" "}(curated measured corpus, not a random sample of the web)
        </p>
        {categoryPages.length > 0 && (
          /* Plain links, where a select with a disabled "Browse category"
             button used to be: a category is a page, and a page is a link. */
          <nav className="category-chips" aria-label="Browse a category">
            {categoryPages.map((category) => (
              <Link className="category-chip" href={`${category.path}/`} key={category.id}>
                {category.label}
                <span>{category.sites.length}</span>
              </Link>
            ))}
          </nav>
        )}
      </header>

      {categoryPages.length > 0 && page === 1 && (
        <section className={styles.categories} aria-labelledby="category-title">
          <div className="page-section-heading">
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
                <small>Newest included visit: {formatEvidenceDate(category.lastScannedAt)}</small>
              </Link>
            ))}
          </div>
        </section>
      )}

      <section aria-labelledby="sites-title">
        <div className="page-section-heading">
          <div>
            <p className="eyebrow">Site profiles</p>
            <h2 id="sites-title">
              {sites.length === 0 ? "No published sites" : `All ${sites.length} scanned sites`}
            </h2>
          </div>
          <p>Sort any column. The newest retained report leads each row, including a failed or incomplete visit when that is the latest observation.</p>
        </div>
        {sites.length > 0 && (
          <DirectoryControls
            caption="One current profile per scanned site, sortable by request, tracking-service and cookie counts, and by the date of the latest retained visit."
            rows={sites.map((site) => siteEvidenceRow(pagesBasePath, site))}
          />
        )}
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

export function directoryPath(page: number): string {
  return page <= 1 ? "/directory/" : `/directory/page/${page}/`;
}
