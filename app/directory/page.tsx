import type { Metadata } from "next";
import Link from "next/link";
import { loadCorpusOverview, type DirectoryEntry } from "@/lib/corpus-overview";
import { reportPagePath } from "@/lib/report-locator";
import { sitePagesBasePath } from "@/lib/site-url";
import { siteProfilePath } from "@/lib/site-profile";
import { formatDelta, type SinceLastScan } from "@/lib/temporal-deltas";

export const dynamic = "force-static";

export const metadata: Metadata = {
  title: "Directory of scanned sites",
  description:
    "Browse Site Behavior Lab reports: what popular sites actually loaded during a controlled visit: trackers, cookies, and fingerprinting, as reproducible evidence.",
  alternates: { canonical: "/directory/" }
};

// "Catalogued-service requests", never "tracker requests": the count is
// requests matching the service catalog, which includes operational-only
// services, and it counts REQUESTS, not distinct services.
function sinceLastScanText(delta: SinceLastScan): string {
  if (delta.thirdPartyRequests === 0 && delta.trackerRequests === 0) {
    return "no change in third-party or catalogued-service requests";
  }
  // Each metric reads grammatically on its own, so a lone zero renders as
  // "no change in catalogued-service requests" instead of a bare "no change".
  const thirdParty =
    delta.thirdPartyRequests === 0 ? "no change in third-party" : `${formatDelta(delta.thirdPartyRequests)} third-party`;
  const tracker =
    delta.trackerRequests === 0
      ? "no change in catalogued-service requests"
      : `${formatDelta(delta.trackerRequests)} catalogued-service requests`;
  return `${thirdParty}, ${tracker}`;
}

function formatScanDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function reportTypeLabel(entry: DirectoryEntry): string {
  if (entry.reportType !== "comparison") return "single scan";
  if (entry.comparisonType === "shields") return "Brave-list blocking comparison";
  // A consent comparison only compared choices if the scanner dispatched
  // clicks on both banner buttons; otherwise the label must say what actually
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

/**
 * Direction-aware label for the category's median signed Shields change
 * (blocking visit minus unblocked baseline). Negative medians read as the
 * familiar "fewer with blocking"; a positive median must say "more", never be
 * clamped or relabeled as a reduction.
 */
function shieldsMedianLabel(medianChange: number): string {
  if (medianChange < 0) return "Fewer with Brave-list blocking";
  if (medianChange > 0) return "More with Brave-list blocking";
  return "With Brave-list blocking";
}

/** Per-category direction mix of the paired sites, so increases are published, not hidden. */
function shieldsMixText(rollup: { shieldsPairedSites: number; shieldsDecreased: number; shieldsFlat: number; shieldsIncreased: number }): string {
  const parts: string[] = [];
  if (rollup.shieldsDecreased > 0) parts.push(`${rollup.shieldsDecreased} fewer`);
  if (rollup.shieldsFlat > 0) parts.push(`${rollup.shieldsFlat} unchanged`);
  if (rollup.shieldsIncreased > 0) parts.push(`${rollup.shieldsIncreased} more`);
  const sites = rollup.shieldsPairedSites === 1 ? "1 paired site" : `${rollup.shieldsPairedSites} paired sites`;
  return `blocking pairs (${sites}): ${parts.join(", ")}`;
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
                  {rollup.medianShieldsChange !== null && (
                    <div>
                      <dt>{shieldsMedianLabel(rollup.medianShieldsChange)}</dt>
                      <dd>
                        {rollup.medianShieldsChange === 0
                          ? "no change"
                          : Math.abs(rollup.medianShieldsChange).toLocaleString()}
                      </dd>
                    </div>
                  )}
                </dl>
                {rollup.shieldsPairedSites > 0 && (
                  <span className="rollup-bar-label">{shieldsMixText(rollup)}</span>
                )}
              </article>
            ))}
          </div>
          {heaviest.length > 0 && (
            <div className="rollup-leaderboard">
              <h3>Heaviest sites by catalogued-service requests</h3>
              <ol>
                {heaviest.map((site) => (
                  <li key={site.id}>
                    <Link href={`${siteProfilePath(site.domain) ?? reportPagePath(site.id)}/`}>{site.domain}</Link>
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
            which is not counted as third-party here. The Brave-list blocking figure is the median <em>signed</em>{" "}
            difference in third-party requests between a normal visit and a paired visit with Brave&apos;s ad-block engine
            and default Shields lists actively blocking (a simulation in this scanner&apos;s browser, not a live
            Brave-browser visit): an observed paired-visit difference, not a count of individually blocked requests. Each
            card also counts its paired sites by direction, because some pairs observe <em>more</em> third-party requests
            with blocking on (ad rotation, fallback loading); those increases are counted as observed, never as
            &ldquo;no change&rdquo;.
          </p>
        </section>
      )}

      {entries.length > 0 && (
        <>
        {entries.some((entry) => entry.sinceLastScan) && (
          <p className="directory-history-note">
            History deltas are observed differences between compatible visits, not proof that the site changed. Ad
            rotation, experiments, caching, and bot detection can also change what a visit sees.
          </p>
        )}
        <ul className="directory-list">
          {entries.map((entry) => {
            const profilePath = siteProfilePath(entry.domain);
            return (
            <li key={entry.id} className={`directory-row tone-${entry.tone}`}>
              <Link className="directory-report-link" href={`${reportPagePath(entry.id)}/`}>
                <span className="directory-row-top">
                  <span className="directory-domain">{entry.domain}</span>
                  {entry.capped && (
                    <span
                      className="capped-chip"
                      title="This visit hit the 1,000-request recording cap: its counts are truncated, and it is excluded from the medians, leaderboard, and since-last-scan deltas."
                    >
                      recording capped
                    </span>
                  )}
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
                    title="Observed difference between successful, uncapped visits of the same subject under a compatible methodology and measurement setup. It can still reflect ad rotation, experiments, caching, or bot detection as well as a real site change."
                  >
                    Observed difference vs {formatScanDate(entry.sinceLastScan.previousScannedAt)}:{" "}
                    {sinceLastScanText(entry.sinceLastScan)}
                  </span>
                )}
              </Link>
              {profilePath && (
                <Link className="directory-profile-link" href={`${profilePath}/`}>
                  View {entry.domain} history
                </Link>
              )}
            </li>
            );
          })}
        </ul>
        </>
      )}
    </main>
  );
}
