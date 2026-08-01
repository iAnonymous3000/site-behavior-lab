import type { Metadata } from "next";
import { corpusCohortLabel, corpusCohortSummaryLabel } from "@/lib/corpus-cohort";
import Link from "next/link";
import { notFound } from "next/navigation";
import { loadCorpusOverview } from "@/lib/corpus-overview";
import { buildCategoryEvidencePages, type CategoryEvidencePage } from "@/lib/directory-view";
import { serializeJsonLd } from "@/lib/jsonld-script";
import { reportPagePath } from "@/lib/report-locator";
import { publicPageMetadata } from "@/lib/seo-metadata";
import { siteBaseUrl, sitePagesBasePath } from "@/lib/site-url";
import styles from "./category.module.css";
import { TrustLinks } from "@/app/_components/trust-links";

export const dynamic = "force-static";
export const dynamicParams = false;

export async function generateStaticParams() {
  const { entries } = await loadCorpusOverview();
  return buildCategoryEvidencePages(entries).map((category) => ({ category: category.id }));
}

export async function generateMetadata({ params }: { params: Promise<{ category: string }> }): Promise<Metadata> {
  const category = await loadCategory((await params).category);
  if (!category) {
    return {
      title: "Evidence category not found",
      alternates: { canonical: null },
      robots: { index: false, follow: false }
    };
  }
  const description = categoryDescription(category);
  return publicPageMetadata({
    title: `${category.label} website behavior evidence`,
    description,
    path: `${category.path}/`
  });
}

export default async function CategoryPage({ params }: { params: Promise<{ category: string }> }) {
  const category = await loadCategory((await params).category);
  if (!category) notFound();
  const { rollup } = category;
  const base = siteBaseUrl();
  const pagesBasePath = sitePagesBasePath();
  const structuredData = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: `${category.label} website behavior evidence`,
    description: categoryDescription(category),
    url: `${base}${category.path}/`,
    dateModified: category.lastScannedAt,
    mainEntity: {
      "@type": "ItemList",
      numberOfItems: category.sites.length,
      itemListElement: category.sites.map((site, index) => ({
        "@type": "ListItem",
        position: index + 1,
        name: site.domain,
        url: `${base}${site.profilePath}/`
      }))
    }
  };

  return (
    <main className={styles.page}>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: serializeJsonLd(structuredData) }} />
      {/* Matches the /sites and /reports breadcrumbs: list semantics for the item count,
          aria-hidden separators so the slashes are not spoken, aria-current on the leaf. */}
      <nav className={styles.breadcrumbs} aria-label="Breadcrumb">
        <ol>
          <li><Link href="/">Site Behavior Lab</Link></li>
          <li aria-hidden="true">/</li>
          <li><Link href="/directory/">Directory</Link></li>
          <li aria-hidden="true">/</li>
          <li aria-current="page">{category.label}</li>
        </ol>
      </nav>

      <header className={styles.header}>
        <p className="eyebrow">Controlled-visit evidence · {category.sites.length} canonical sites</p>
        <h1>What {category.label.toLowerCase()} sites loaded</h1>
        <p>
          Descriptive results from one newest eligible passive visit per site, not a ranking, privacy grade, causal
          claim or representative sample of all {category.label.toLowerCase()} sites.
        </p>
        <p className={styles.updated}>Newest included observation: <time dateTime={category.lastScannedAt}>{formatDate(category.lastScannedAt)}</time></p>
      </header>

      <section className={styles.summary} aria-labelledby="summary-title">
        <div className={styles.summaryIntro}>
          <p className="eyebrow">Observed medians</p>
          <h2 id="summary-title">Median across this curated sample.</h2>
          <p>
            Medians summarize the included site-level observations. They do not describe every visit to these sites
            or the wider category.
          </p>
        </div>
        <dl className={styles.metrics}>
          <div><dt>Third-party requests</dt><dd>{rollup.medianThirdParty.toLocaleString()}</dd></div>
          <div><dt>Third-party tracking-service requests</dt><dd>{rollup.medianTrackers.toLocaleString()}</dd></div>
          <div>
            <dt>Third-party cookies</dt>
            <dd>
              {rollup.medianCookies === null ? "Not measured" : rollup.medianCookies.toLocaleString()}
              <small>{rollup.cookieMeasuredSites} of {rollup.siteCount} sites had complete cookie evidence</small>
            </dd>
          </div>
        </dl>
        {rollup.shieldsPairedSites > 0 && (
          <div className={styles.blockingEvidence}>
            <strong>Separate Brave-list blocking pairs</strong>
            <span>{blockingMedianText(rollup.medianShieldsChange)}</span>
            <small>
              {rollup.shieldsPairedSites} paired {rollup.shieldsPairedSites === 1 ? "site" : "sites"}: {rollup.shieldsDecreased} fewer, {rollup.shieldsFlat} unchanged, {rollup.shieldsIncreased} more third-party requests with blocking on.
            </small>
          </div>
        )}
      </section>

      <section className={styles.siteSection} aria-labelledby="sites-title">
        <div className={styles.sectionHeading}>
          <div>
            <p className="eyebrow">Included evidence</p>
            <h2 id="sites-title">{category.sites.length} site-level observations</h2>
          </div>
          <p>Alphabetical, not ranked. Open a profile for the currently retained, versioned report history.</p>
        </div>
        <ul className={styles.siteList}>
          {category.sites.map((site) => (
            <li key={site.domain}>
              <div className={styles.siteHeading}>
                <a href={`${pagesBasePath}${site.profilePath}/`}>{site.domain}</a>
                <time dateTime={site.latest.scannedAt}>{formatDate(site.latest.scannedAt)}</time>
              </div>
              <p>{site.latest.headline}</p>
              <dl>
                <div><dt>Third-party requests</dt><dd>{site.latest.thirdPartyRequests.toLocaleString()}</dd></div>
                <div><dt>Third-party tracking-service requests</dt><dd>{site.latest.trackerRequests.toLocaleString()}</dd></div>
                <div>
                  <dt>Third-party cookies</dt>
                  <dd>{site.latest.cookieEvidenceComplete ? site.latest.thirdPartyCookies.toLocaleString() : "Not measured"}</dd>
                </div>
              </dl>
              <div className={styles.siteActions}>
                <a href={`${pagesBasePath}${site.profilePath}/`}>Profile and history</a>
                <Link href={`${reportPagePath(site.latest.id)}/`}>Included report</Link>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section className={styles.method} aria-labelledby="method-title">
        <p className="eyebrow">How to read this page</p>
        <h2 id="method-title">Eligibility and limits</h2>
        <ul>
          <li>Each row is the newest successful, request-complete, uncapped passive lead visit for one canonical site.</li>
          {/* The full identity carries three 64-character digests. Inline they were most
              of a mobile screen of hex in the one section labelled "How to read this
              page", so the readable half stays in the sentence and the digests move
              behind a disclosure for anyone verifying the cohort. */}
          <li>
            Every row here was measured under one cohort ({corpusCohortSummaryLabel(category.cohort)}), which is
            this page&apos;s denominator. Another category can publish a different cohort, so these medians are
            comparable within this page and not against another category&apos;s.
            <details className={styles.cohortDetails}>
              <summary>Full measurement identity</summary>
              <p className="mono">{corpusCohortLabel(category.cohort)}</p>
            </details>
          </li>
          <li>Failed loads, incomplete recordings and accept/reject consent-interaction arms are excluded.</li>
          <li>
            Third-party tracking-service request counts are lower bounds derived from retained request rows whose
            recorded host matched a reviewed service-catalog suffix and from the recorded ServiceRole taxonomy.
          </li>
          <li>Category membership is editorial. The corpus is curated and is not a random or representative web sample.</li>
          <li>A controlled visit is one observation. Ads, experiments, caching, location and bot detection can change what loads.</li>
          <li>Blocking pairs simulate Brave&apos;s ad-block engine and default lists in the scanner; they are not live Brave-browser visits or counts of individually blocked requests.</li>
        </ul>
        <div className={styles.methodLinks}>
          <Link href="/methodology/">Full methodology</Link>
          <Link href="/directory/">All site profiles</Link>
          <a href={`${base}/corpus.json`}>Current versioned JSON export</a>
        </div>
      </section>
      <TrustLinks />
    </main>
  );
}

async function loadCategory(rawId: string): Promise<CategoryEvidencePage | null> {
  const { entries } = await loadCorpusOverview();
  const id = rawId.trim().toLowerCase();
  return buildCategoryEvidencePages(entries).find((category) => category.id === id) ?? null;
}

function categoryDescription(category: CategoryEvidencePage): string {
  return `Controlled-visit evidence for ${category.sites.length} curated ${category.label.toLowerCase()} sites, with observed medians, dates, limitations and links to reproducible reports.`;
}

function blockingMedianText(value: number | null): string {
  if (value === null) return "No eligible paired median";
  if (value === 0) return "Median observed difference: no change in third-party requests";
  return `Median observed difference: ${Math.abs(value).toLocaleString()} ${value < 0 ? "fewer" : "more"} third-party requests with blocking on`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "date unavailable"
    : date.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}
