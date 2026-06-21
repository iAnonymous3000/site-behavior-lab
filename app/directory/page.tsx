import type { Metadata } from "next";
import Link from "next/link";
import { loadCorpusOverview, type DirectoryEntry } from "@/lib/corpus-overview";
import { reportPagePath } from "@/lib/report-locator";

export const dynamic = "force-static";

export const metadata: Metadata = {
  title: "Directory of scanned sites",
  description:
    "Browse Site Behavior Lab reports: what popular sites actually loaded during a controlled visit — trackers, cookies, and fingerprinting, as reproducible evidence.",
  alternates: { canonical: "/directory/" }
};

function reportTypeLabel(entry: DirectoryEntry): string {
  if (entry.reportType !== "comparison") return "single scan";
  if (entry.comparisonType === "shields") return "Shields comparison";
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
              Median per site in each category — what sites tried to load during a controlled visit, before any
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
                <span className="rollup-bar-label">median catalogued tracker requests per site</span>
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
                      <dt>Brave would block</dt>
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
            Medians from one controlled visit per site, using the curated service catalog (a lower bound). A 0 means no{" "}
            <em>catalogued third-party</em> trackers were seen — large platforms like Google, YouTube, and X serve much of
            their own tracking first-party, which is not counted as third-party here. &ldquo;Brave would block&rdquo; is the
            median third-party requests Brave&rsquo;s default Shields would remove, from a block simulation.
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
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
