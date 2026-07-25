import Link from "next/link";
import adblockMetadata from "@/lib/adblock-wasm/brave-default-filters.meta.json";
import { entryEligibleForCorpusRollups, loadCorpusOverview } from "@/lib/corpus-overview";
import {
  PUBLIC_STATUS_MAX_CORPUS_AGE_MS,
  PUBLIC_STATUS_MAX_FILTER_LIST_AGE_MS
} from "@/lib/public-status";
import { NODE_ADBLOCK_ENGINE_VERSION, NODE_PLAYWRIGHT_VERSION } from "@/lib/legacy-methodology";
import { publicPageMetadata } from "@/lib/seo-metadata";
import { trackerCatalogMetadata } from "@/lib/tracker-catalog";
import { TrustLinks } from "../_components/trust-links";
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
  // the timestamp is scoped to the same cohort the number describes.
  const aggregateCohortId = overview.aggregateCohort?.id ?? null;
  const latestEligibleEvidence = overview.entries
    .filter((entry) => entryEligibleForCorpusRollups(entry) && entry.corpusCohort.id === aggregateCohortId)
    .map((entry) => entry.scannedAt)
    .filter((value) => Number.isFinite(Date.parse(value)))
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null;

  return (
    <main className="legal-page status-page">
      <header className="legal-header">
        <p className="eyebrow">Status &amp; transparency</p>
        <h1>What is current, stale, or unknown</h1>
        <p>
          This page reads public deployment receipts, scanner health, and versioned repository artifacts. Missing,
          malformed, future-dated, or unreachable evidence is shown as unknown, not silently treated as healthy.
        </p>
        <p className="legal-back"><Link href="/">&larr; Back to Site Behavior Lab</Link></p>
      </header>

      <LiveDeploymentStatus />

      <section className="legal-section" aria-labelledby="freshness-heading">
        <p className="eyebrow">Publication freshness</p>
        <h2 id="freshness-heading">Evidence and measurement inputs</h2>
        <div className="status-card-grid">
          <article className="status-card">
            <div className="status-heading-row">
              <h3>Latest eligible corpus evidence</h3>
              <StatusFreshness timestamp={latestEligibleEvidence} maxAgeMs={PUBLIC_STATUS_MAX_CORPUS_AGE_MS} />
            </div>
            <p className="status-value">{formatUtc(latestEligibleEvidence)}</p>
            <p>
              {overview.siteCount.toLocaleString()} distinct sites currently qualify for corpus aggregates;{" "}
              {overview.coverageSiteCount.toLocaleString()} sites have at least one successful load.
            </p>
            <p className="status-note">This date and this site count both describe the single measurement cohort the corpus aggregates use. Current means no more than eight days old. It does not mean every site was refreshed in that window. A site that loaded but whose evidence was cut short, by a request cap or a censored family, is counted as covered and never as measured, so the two numbers differ by more than failed loads.</p>
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

      <TrustLinks />
    </main>
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
