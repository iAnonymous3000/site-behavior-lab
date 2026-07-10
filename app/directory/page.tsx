import type { Metadata } from "next";
import Link from "next/link";
import { loadCorpusOverview, type DirectoryEntry } from "@/lib/corpus-overview";
import { reportPagePath } from "@/lib/report-locator";
import { sitePagesBasePath } from "@/lib/site-url";
import { formatDelta, type SinceLastScan } from "@/lib/temporal-deltas";

export const dynamic = "force-static";

export const metadata: Metadata = {
  title: "Directory of scanned sites",
  description:
    "Browse Site Behavior Lab reports: what popular sites actually loaded during a controlled visit: trackers, cookies, and fingerprinting, as reproducible evidence.",
  alternates: { canonical: "/directory/" }
};

function sinceLastScanText(delta: SinceLastScan): string {
  if (delta.thirdPartyRequests === 0 && delta.trackerRequests === 0) {
    return "no change in third-party or tracker requests";
  }
  // Each metric reads grammatically on its own, so a lone zero renders as
  // "no change in tracker requests" instead of "no change tracker requests".
  const thirdParty =
    delta.thirdPartyRequests === 0 ? "no change in third-party" : `${formatDelta(delta.thirdPartyRequests)} third-party`;
  const tracker =
    delta.trackerRequests === 0 ? "no change in tracker requests" : `${formatDelta(delta.trackerRequests)} tracker requests`;
  return `${thirdParty}, ${tracker}`;
}

function formatScanDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function reportTypeLabel(entry: DirectoryEntry): string {
  if (entry.reportType !== "comparison") return "single scan";
  if (entry.comparisonType === "shields") return "Brave Shields comparison";
  // A consent comparison only compared choices if the scanner verifiably
  // clicked both banner buttons; otherwise the label must say what actually
  // happened, because an unclicked run observed the pre-consent state.
  if (entry.comparisonType === "consent") {
    if (entry.consentClicks === "accept-and-reject") return "consent comparison";
    if (entry.consentClicks === "accept-only") return "consent comparison (Reject not clicked)";
    if (entry.consentClicks === "reject-only") return "consent comparison (Accept not clicked)";
    return "consent comparison (no banner clicked)";
  }
  if (entry.comparisonType === "temporal") return "temporal comparison";
  if (entry.comparisonType === "gpc") return "GPC comparison";
  return "comparison";
}

export default async function DirectoryPage() {
  const { entries, rollups, heaviest } = await loadCorpusOverview();
  const maxMedianTrackers = Math.max(1, ...rollups.map((rollup) => rollup.medianTrackers));

  return (
    <main className="directory-page">
      <header className="directory-header">
        <p className="eyebrow">Directory</p>
        <h1>Scanned sites</h1>
        <p>
          {entries.length === 0
            ? "No reports have been published yet."
            : `${entries.length.toLocaleString()} ${entries.length === 1 ? "report" : "reports"} of what real sites loaded during a controlled visit. Each links to the full, reproducible evidence.`}
        </p>
        <p className="directory-export">
          Researcher export: <a href={`${sitePagesBasePath()}/corpus.json`}>corpus.json</a>
          {" · "}
          <a href={`${sitePagesBasePath()}/corpus.csv`}>corpus.csv</a>
          {" "}(one row per report; a measured corpus of curated sites, not a random sample of the web)
        </p>
        <p className="directory-back">
          <Link href="/">&larr; Back to Site Behavior Lab</Link>
        </p>
      </header>

      {rollups.length > 0 && (
        <section className="category-rollups" aria-labelledby="rollup-title">
          <div className="rollup-heading">
            <p className="eyebrow">By category</p>
            <h2 id="rollup-title">What different kinds of sites load</h2>
            <p>
              Median per site in each category: what sites tried to load during a controlled visit, before any
              blocking. Heaviest first.
            </p>
          </div>
          <div className="rollup-grid">
            {rollups.map((rollup) => (
              <article className="rollup-card" key={rollup.id}>
                <div className="rollup-card-top">
                  <h3>{rollup.label}</h3>
                  <span className="rollup-count">
                    {rollup.siteCount} {rollup.siteCount === 1 ? "site" : "sites"}
                  </span>
                </div>
                <div className="rollup-bar-row">
                  <span className="rollup-bar-track" aria-hidden="true">
                    <span
                      className="rollup-bar"
                      style={{ width: `${Math.round((rollup.medianTrackers / maxMedianTrackers) * 100)}%` }}
                    />
                  </span>
                  <strong>{rollup.medianTrackers.toLocaleString()}</strong>
                </div>
                <span className="rollup-bar-label">median catalogued tracking-service requests per site</span>
                <dl className="rollup-stats">
                  <div>
                    <dt>Third-party reqs</dt>
                    <dd>{rollup.medianThirdParty.toLocaleString()}</dd>
                  </div>
                  <div>
                    <dt>3rd-party cookies</dt>
                    <dd>{rollup.medianCookies.toLocaleString()}</dd>
                  </div>
                  {rollup.medianShieldsBlocked !== null && (
                    <div>
                      <dt>Fewer with Shields on</dt>
                      <dd>{rollup.medianShieldsBlocked.toLocaleString()}</dd>
                    </div>
                  )}
                </dl>
              </article>
            ))}
          </div>
          {heaviest.length > 0 && (
            <div className="rollup-leaderboard">
              <h3>Heaviest sites by tracker requests</h3>
              <ol>
                {heaviest.map((site) => (
                  <li key={site.id}>
                    <Link href={`${reportPagePath(site.id)}/`}>{site.domain}</Link>
                    <b>{site.trackerRequests.toLocaleString()}</b>
                  </li>
                ))}
              </ol>
            </div>
          )}
          <p className="rollup-note">
            Medians from one controlled visit per site, using the curated service catalog (a lower bound). Tracker counts
            exclude operational-only services such as error monitoring. A 0 means no <em>catalogued third-party</em>{" "}
            trackers were seen. Large platforms like Google, YouTube, and X serve much of their own tracking first-party,
            which is not counted as third-party here. &ldquo;Fewer with Shields on&rdquo; is the median difference in
            third-party requests between a normal visit and a paired visit with Brave Shields (the ad and tracker blocker
            built into the Brave browser, with its default lists) actively blocking: an observed paired-visit difference,
            not a count of individually blocked requests.
          </p>
        </section>
      )}

      {entries.length > 0 && (
        <ul className="directory-list">
          {entries.map((entry) => (
            <li key={entry.id} className={`directory-row tone-${entry.tone}`}>
              <Link href={`${reportPagePath(entry.id)}/`}>
                <span className="directory-row-top">
                  <span className="directory-domain">{entry.domain}</span>
                  <span className="directory-type">{reportTypeLabel(entry)}</span>
                </span>
                <span className="directory-headline">{entry.headline}</span>
                <span className="directory-metrics">
                  <span>
                    <b>{entry.thirdPartyRequests.toLocaleString()}</b> third-party
                  </span>
                  <span>
                    <b>{entry.trackerRequests.toLocaleString()}</b> tracker
                  </span>
                  <span>
                    <b>{entry.thirdPartyCookies.toLocaleString()}</b> cookies
                  </span>
                </span>
                {entry.sinceLastScan && (
                  <span
                    className="directory-since"
                    title="Observed difference between two automated visits of the same kind. It can reflect ad rotation, experiments, caching, or bot detection as well as a real site change."
                  >
                    Since {formatScanDate(entry.sinceLastScan.previousScannedAt)}:{" "}
                    {sinceLastScanText(entry.sinceLastScan)}
                  </span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
