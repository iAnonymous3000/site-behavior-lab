import Link from "next/link";
import adblockMetadata from "@/lib/adblock-wasm/brave-default-filters.meta.json";
import { entryEligibleForCorpusRollups, loadCorpusOverview } from "@/lib/corpus-overview";
import { currentScanRankingSentence, loadCommittedCorpusStats } from "@/lib/current-scan-cohort";
import { buildCategoryEvidencePages } from "@/lib/directory-view";
import {
  PUBLIC_STATUS_MAX_CORPUS_AGE_MS,
  PUBLIC_STATUS_MAX_FILTER_LIST_AGE_MS
} from "@/lib/public-status";
import { NODE_ADBLOCK_ENGINE_VERSION, NODE_PLAYWRIGHT_VERSION } from "@/lib/legacy-methodology";
import { publicPageMetadata } from "@/lib/seo-metadata";
import { trackerCatalogMetadata } from "@/lib/tracker-catalog";
import { SiteChrome } from "../_components/site-chrome";
import { LiveDeploymentStatus } from "./live-deployment-status";
import { StatusFreshness } from "./status-freshness";

export const dynamic = "force-static";

export const metadata = publicPageMetadata({
  title: "Project status and evidence freshness",
  description:
    "Public deployment health, corpus freshness, measurement-toolchain versions, and honest unknown or stale states for Site Behavior Lab.",
  path: "/status/"
});

const ACTIONS_URL = "https://github.com/iAnonymous3000/site-behavior-lab/actions";
const ISSUES_URL = "https://github.com/iAnonymous3000/site-behavior-lab/issues";

export default async function StatusPage() {
  const overview = await loadCorpusOverview();
  // The card's own sentence reports `siteCount`, which counts only the
  // aggregate cohort. Dating it from any eligible row would certify the
  // freshness of the aggregates using a report those aggregates exclude, so
  // the timestamp is scoped to the same cohort the number describes. That
  // scope is stated in the copy, and eligible evidence newer than this
  // cohort's is disclosed with its own derived date: without it, this card
  // and the directory can date the corpus three days apart on one build.
  const aggregateCohortId = overview.aggregateCohort?.id ?? null;
  const eligibleEntries = overview.entries.filter(
    (entry) => entryEligibleForCorpusRollups(entry) && Number.isFinite(Date.parse(entry.scannedAt))
  );
  const newestEligibleScannedAt = (entries: typeof eligibleEntries): string | null =>
    entries
      .map((entry) => entry.scannedAt)
      .sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null;
  const latestAggregateEvidence = newestEligibleScannedAt(
    eligibleEntries.filter((entry) => entry.corpusCohort.id === aggregateCohortId)
  );
  const latestEligibleEvidence = newestEligibleScannedAt(eligibleEntries);
  const newerEligibleOutsideAggregate =
    latestEligibleEvidence !== null &&
    (latestAggregateEvidence === null ||
      Date.parse(latestEligibleEvidence) > Date.parse(latestAggregateEvidence));
  // "Most committed pages rank against a different cohort than this one" is a
  // corpus-state fact, not a timeless one: one generation flip or one large
  // refresh can invert it. Derive it from the same entries the card counts so
  // corpus churn changes the sentence instead of falsifying it.
  const committedPagesOnAggregateCohort = overview.entries.filter(
    (entry) => entry.corpusCohort.id === aggregateCohortId
  ).length;
  const mostPagesRankElsewhere = committedPagesOnAggregateCohort * 2 < overview.entries.length;
  // Category medians are published one cohort per category and can land on
  // several cohorts during a methodology migration, so the aggregate cohort
  // above is not the whole published corpus. The homepage counts them from
  // exactly these pages; deriving the count here the same way keeps the two
  // surfaces from telling the reader different things.
  const categoryCohortCount = new Set(
    buildCategoryEvidencePages(overview.entries).map((category) => category.cohort.id)
  ).size;
  // What a scan run TODAY is ranked against depends on whether the committed
  // artifact holds a usable cohort for the current production tuple, which
  // changes both when the toolchain epoch moves and when the corpus refreshes.
  // The sentence is derived per build; a fixed sentence here was true only in
  // the gap between a methodology bump and the next refresh.
  const scanRankingSentence = currentScanRankingSentence(
    await loadCommittedCorpusStats(),
    aggregateCohortId
  );

  return (
    <SiteChrome>
      <div className="legal-page status-page">
      <header className="legal-header">
        <p className="eyebrow">Status &amp; transparency</p>
        <h1>What is current, stale, or unknown</h1>
        <p>
          This page reads public deployment receipts, scanner health, and versioned repository artifacts. Missing,
          malformed, future-dated, or unreachable evidence is shown as unknown, not silently treated as healthy.
        </p>
      </header>

      <LiveDeploymentStatus />

      <section className="legal-section" aria-labelledby="freshness-heading">
        <p className="eyebrow">Publication freshness</p>
        <h2 id="freshness-heading">Evidence and measurement inputs</h2>
        <div className="status-card-grid">
          <article className="status-card">
            <div className="status-heading-row">
              <h3>Latest aggregate-cohort evidence</h3>
              <StatusFreshness timestamp={latestAggregateEvidence} maxAgeMs={PUBLIC_STATUS_MAX_CORPUS_AGE_MS} />
            </div>
            <p className="status-value">{formatUtc(latestAggregateEvidence)}</p>
            <p>
              {overview.siteCount.toLocaleString()} distinct sites make up the measurement cohort this
              page&apos;s aggregates describe, and the date above is the newest eligible evidence inside that same
              cohort; {overview.coverageSiteCount.toLocaleString()} sites have at least one
              successful load.
            </p>
            <p className="status-note">{newerEligibleOutsideAggregate ? `Eligible evidence as new as ${formatUtc(latestEligibleEvidence)} sits in cohorts this aggregate excludes; the date above deliberately covers the aggregate cohort only.` : latestAggregateEvidence !== null ? "Today the aggregate cohort also holds the newest eligible evidence in the committed corpus." : "Today no committed report is eligible for these aggregates."} This is not the cohort every report page uses. Each report ranks against its own exact cohort{mostPagesRankElsewhere ? ", and most committed pages carry a different one than this" : ""}: a page compares only against scans that share its schema revision, methodology, tracker catalog, role taxonomy, metric contract, producer and requested-GPC state. Where no cohort reaches fifty sites, that page falls back to fixed thresholds instead. {scanRankingSentence} Each percentile card names its own denominator, and the <a href="/methodology/#corpus">methodology</a> states the rule. {categoryCohortCount > 1 ? `Category medians are published one cohort per category and span ${categoryCohortCount} cohorts in total, so no single cohort backs every published aggregate.` : "Category medians are published one cohort per category, and today that is this same cohort."} Current means no more than eight days old. It does not mean every site was refreshed in that window. A site that loaded but whose evidence was cut short, by a request cap or a censored family, is counted as covered and never as measured, so the two numbers differ by more than failed loads. Nearly all committed corpus reports are frozen schema v1 from the disclosed fallback collection lane; the <a href="/methodology/#corpus">methodology</a> states what v1 evidence can and cannot support.</p>
          </article>

          <article className="status-card">
            <div className="status-heading-row">
              <h3>Brave default-list snapshot</h3>
              <StatusFreshness timestamp={adblockMetadata.fetchedAt} maxAgeMs={PUBLIC_STATUS_MAX_FILTER_LIST_AGE_MS} />
            </div>
            <p className="status-value">{formatUtc(adblockMetadata.fetchedAt)}</p>
            <p>
              {adblockMetadata.sourceCount.toLocaleString()} source files · manifest{" "}
              <code title={adblockMetadata.manifestDigest}>{adblockMetadata.manifestDigest.slice(0, 12)}</code>
            </p>
            <p className="status-note">Current means no more than eight days old. A failed refresh never replaces the last validated snapshot.</p>
          </article>
        </div>
      </section>

      <section className="legal-section" aria-labelledby="toolchain-heading">
        <p className="eyebrow">Recorded toolchain</p>
        <h2 id="toolchain-heading">Versions that shape the measurement</h2>
        <dl className="status-fact-grid">
          <div><dt>Playwright</dt><dd><code>{NODE_PLAYWRIGHT_VERSION}</code></dd></div>
          <div><dt>Ad-block engine</dt><dd><code>{NODE_ADBLOCK_ENGINE_VERSION}</code></dd></div>
          <div><dt>Service catalog</dt><dd><code>{trackerCatalogMetadata.version}</code></dd></div>
          <div><dt>Catalog entries</dt><dd>{trackerCatalogMetadata.entries.toLocaleString()}</dd></div>
        </dl>
        <p>
          Exact browser versions and per-report toolchain identities remain attached to each report. See the{" "}
          <Link href="/methodology/">methodology</Link> for what these inputs can and cannot establish.
        </p>
      </section>

      <section className="legal-section" aria-labelledby="operations-heading">
        <p className="eyebrow">Monitoring evidence</p>
        <h2 id="operations-heading">Checks and incident visibility</h2>
        <p>
          GitHub Actions runs the production posture monitor and records delivered successes and failures. GitHub
          scheduling is best-effort, so an absent run is not proof of uptime. The browser check above verifies only the
          public endpoints it can reach now.
        </p>
        <ul>
          <li><a href={ACTIONS_URL + "/workflows/production-health.yml"}>Production health history</a></li>
          <li><a href={ACTIONS_URL + "/workflows/scan-featured.yml"}>Featured-corpus refresh history</a></li>
          <li><a href={ACTIONS_URL + "/workflows/update-brave-lists.yml"}>Measurement-input refresh history</a></li>
          <li><a href={ISSUES_URL}>Open project issues and managed incidents</a></li>
        </ul>
      </section>

    </div>
    </SiteChrome>
  );
}

function formatUtc(value: string | null): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "Unknown";
  return new Date(value).toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC"
  }) + " UTC";
}
