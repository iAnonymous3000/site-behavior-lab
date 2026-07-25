import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { entryEligibleForCorpusRollups, loadCorpusOverview, type DirectoryEntry } from "@/lib/corpus-overview";
import { reportPagePath } from "@/lib/report-locator";
import { scanPrefillHref } from "@/lib/scan-prefill";
import { conciseMetadataText, publicPageMetadata } from "@/lib/seo-metadata";
import { siteProfileKey, siteProfilePath } from "@/lib/site-profile";
import { formatDelta } from "@/lib/temporal-deltas";
import { safeNavigableHttpUrl } from "@/lib/report-url";
import { sitePagesBasePath, siteUrl } from "@/lib/site-url";
import { reportKindLabel } from "@/lib/text-format";

export const dynamic = "force-static";

export async function generateStaticParams() {
  const { entries } = await loadCorpusOverview();
  return [...new Set(entries.map((entry) => siteProfileKey(entry.domain)).filter((key): key is string => Boolean(key)))].map(
    (domain) => ({ domain })
  );
}

export async function generateMetadata({ params }: { params: Promise<{ domain: string }> }): Promise<Metadata> {
  const profile = await loadProfile((await params).domain);
  if (!profile) {
    return {
      title: "Site history not found",
      alternates: { canonical: null },
      robots: { index: false, follow: false }
    };
  }
  const latest = profile.entries[0];
  const profilePath = siteProfilePath(profile.domain);
  const canonical = siteUrl(`${profilePath}/`);
  const title = `What ${profile.domain} loaded: website behavior history`;
  const description = conciseMetadataText(
    `Controlled-visit evidence, not a verdict. Browse ${profile.entries.length} ${
      profile.entries.length === 1 ? "report" : "reports"
    } for ${profile.domain}; latest ${formatDate(latest.scannedAt)}: ${latest.headline}`,
    160
  );
  return {
    ...publicPageMetadata({ title, description, path: `${profilePath}/` }),
    alternates: {
      canonical,
      types: {
        "application/atom+xml": siteUrl(`${profilePath}/feed.xml`)
      }
    }
  };
}

export default async function SiteProfilePage({ params }: { params: Promise<{ domain: string }> }) {
  const profile = await loadProfile((await params).domain);
  if (!profile) notFound();
  const latest = profile.entries[0];
  const compatibleChanges = profile.entries.filter((entry) => entry.sinceLastScan);
  const exactRescanUrl = safeNavigableHttpUrl(latest.requestedUrl) ? latest.requestedUrl : null;
  const rescanUrl = exactRescanUrl ?? `https://${profile.domain}/`;
  const rescanHref = scanPrefillHref(rescanUrl) ?? "/#scan";
  // One trend line must describe one methodology. entryEligibleForCorpusRollups
  // filters load state, capping, and consent arms but says nothing about the
  // measurement cohort, so a site scanned across a producer change had its v1
  // and v2 points joined into a single slope that no single methodology
  // produced. selectSiteDataPoints refuses a mixed-cohort aggregate for exactly
  // this reason, and a sparkline is an aggregate too. Plot the newest cohort
  // only, and say so when older points were left out.
  const sparklineCandidates = profile.entries.filter(entryEligibleForCorpusRollups);
  const sparklineCohortId = sparklineCandidates[0]?.corpusCohort.id ?? null;
  const sparklineEntries =
    sparklineCohortId === null
      ? []
      : sparklineCandidates.filter((entry) => entry.corpusCohort.id === sparklineCohortId);
  const sparklineOmittedCohortCount = sparklineCandidates.length - sparklineEntries.length;

  return (
    <main className="site-profile-page">
      <nav className="report-breadcrumbs" aria-label="Breadcrumb">
        <ol>
          <li><Link href="/">Home</Link></li>
          <li aria-hidden="true">/</li>
          <li><Link href="/directory/">Scanned sites</Link></li>
          <li aria-hidden="true">/</li>
          <li aria-current="page">{profile.domain}</li>
        </ol>
      </nav>
      <header className="site-profile-header">
        <p className="eyebrow">Curated public corpus · Site history</p>
        <h1>{profile.domain}</h1>
        <p>{latest.headline}</p>
        <div className="site-profile-actions">
          <Link className="primary-button" href={rescanHref}>
            {exactRescanUrl ? "Scan this exact route again" : "Scan this site again"}
          </Link>
          <Link className="secondary-button" href={`${reportPagePath(latest.id)}/`}>
            Open latest evidence
          </Link>
          <a className="topbar-link" href="#history">Browse report history</a>
          <Link className="topbar-link" href="/directory/">All scanned sites</Link>
          <a className="topbar-link" href={`${sitePagesBasePath()}${siteProfilePath(profile.domain)}/feed.xml`}>
            Atom feed
          </a>
        </div>
      </header>

      <p className="site-profile-note">
        This timeline contains reviewed reports published into the curated public corpus. A live rescan remains a
        standalone share report until a later corpus publication includes it.
      </p>

      <section className={`site-profile-current tone-${latest.tone}`} aria-labelledby="current-title">
        <div>
          <p className="eyebrow">Latest controlled visit</p>
          <h2 id="current-title">{latest.headline}</h2>
          <p>
            {reportKindLabel(latest)} · {formatDate(latest.scannedAt)} · {latest.device}
            {!latest.requestEvidenceComplete && <> · <IncompleteEvidenceChip capped={latest.capped} /></>}
          </p>
        </div>
        <dl className="site-profile-metrics">
          <div><dt>Third-party requests</dt><dd>{latest.thirdPartyRequests.toLocaleString()}</dd></div>
          <div><dt>Catalogued tracking requests</dt><dd>{latest.trackerRequests.toLocaleString()}</dd></div>
          {/* The directory and the category pages already withhold this count
              when the cookie family was censored mid-collection. Publishing a
              bare number here made the two surfaces disagree about the same
              record (live example: /sites/usatoday.com/ showed 208 while
              /directory/ showed "Not measured" for that exact report). */}
          <div>
            <dt>Third-party cookies</dt>
            <dd>{latest.cookieEvidenceComplete ? latest.thirdPartyCookies.toLocaleString() : "Not measured"}</dd>
          </div>
        </dl>
      </section>

      {compatibleChanges.length > 0 && (
        <section className="site-profile-section" aria-labelledby="changes-title">
          <p className="eyebrow">Comparable visits</p>
          <h2 id="changes-title">Observed differences across comparable visits</h2>
          <ul className="site-change-list">
            {compatibleChanges.map((entry) => (
              <li key={entry.id}>
                <Link href={`${reportPagePath(entry.id)}/`}>{formatDate(entry.scannedAt)}</Link>
                <span>{formatSince(entry)}</span>
              </li>
            ))}
          </ul>
          <p className="site-profile-note">
            These successful, uncapped passive visits hold the route, scanner method, browser, device, conditions,
            catalog, Brave-list source and list count constant. The list snapshot may differ, so these are not
            Shields or detector changes. Differences can still reflect site experiments, ad rotation, caching or
            bot detection.
          </p>
        </section>
      )}

      <section className="site-profile-section" id="history" aria-labelledby="history-title">
        <p className="eyebrow">Evidence timeline</p>
        <h2 id="history-title">{profile.entries.length} {profile.entries.length === 1 ? "report" : "reports"}</h2>
        <HistorySparkline entries={sparklineEntries} />
        {sparklineOmittedCohortCount > 0 && (
          <p className="muted">
            The trend line covers this site&apos;s {sparklineEntries.length} most recent reports from one measurement
            cohort. {sparklineOmittedCohortCount} older {sparklineOmittedCohortCount === 1 ? "report was" : "reports were"}{" "}
            produced by a different methodology and {sparklineOmittedCohortCount === 1 ? "is" : "are"} listed below
            rather than joined to that line.
          </p>
        )}
        <ol className="site-history-list">
          {profile.entries.map((entry) => (
            <li key={entry.id}>
              <Link href={`${reportPagePath(entry.id)}/`}>
                <span><strong>{formatDate(entry.scannedAt)}</strong> · {reportKindLabel(entry)} · {entry.device}</span>
                <span>{entry.headline}</span>
                <small>
                  {entry.thirdPartyRequests.toLocaleString()} third-party · {entry.trackerRequests.toLocaleString()} catalogued tracking · schema {entry.schemaVersion}{entry.schemaRevision ? `.r${entry.schemaRevision}` : ""}
                  {!entry.requestEvidenceComplete && <> · <IncompleteEvidenceChip capped={entry.capped} /></>}
                </small>
              </Link>
            </li>
          ))}
        </ol>
      </section>
    </main>
  );
}

async function loadProfile(rawDomain: string): Promise<{ domain: string; entries: DirectoryEntry[] } | null> {
  const key = siteProfileKey(rawDomain);
  if (!key) return null;
  const { entries } = await loadCorpusOverview();
  const matches = entries
    .filter((entry) => siteProfileKey(entry.domain) === key)
    .sort((left, right) => Date.parse(right.scannedAt) - Date.parse(left.scannedAt));
  return matches.length > 0 ? { domain: key, entries: matches } : null;
}

function IncompleteEvidenceChip({ capped }: { capped: boolean }) {
  return (
    <span
      className="capped-chip"
      title={
        capped
          ? "This visit hit the exact request-recording cap: its counts are lower bounds, and it is excluded from the medians, leaderboard, and since-last-scan deltas."
          : "This visit has incomplete request evidence from another bounded capture loss: its counts are lower bounds, and it is excluded from the medians, leaderboard, and since-last-scan deltas."
      }
    >
      {capped ? "recording capped" : "request evidence incomplete"}
    </span>
  );
}

/**
 * Dependency-free inline sparkline over eligible passive visits only. Consent
 * interaction arms, failed loads, and incomplete recordings remain visible in
 * the evidence timeline below, but must never be plotted as one trend series.
 */
function HistorySparkline({ entries }: { entries: DirectoryEntry[] }) {
  // `entries` arrive newest first; plot chronologically.
  const points = [...entries].reverse().map((entry) => entry.thirdPartyRequests);
  if (points.length < 2) return null;
  const width = 240;
  const height = 48;
  const pad = 4;
  const max = Math.max(...points, 1);
  const step = (width - 2 * pad) / (points.length - 1);
  const coords = points.map((value, index) => ({
    x: Number((pad + index * step).toFixed(1)),
    y: Number((height - pad - (value / max) * (height - 2 * pad)).toFixed(1))
  }));
  const last = coords[coords.length - 1];
  return (
    <figure className="site-sparkline">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width={width}
        height={height}
        role="img"
        aria-label={`Third-party requests across ${points.length} reports, oldest to newest: ${points.join(", ")}.`}
      >
        <polyline
          points={coords.map((point) => `${point.x},${point.y}`).join(" ")}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        <circle cx={last.x} cy={last.y} r="2.5" fill="currentColor" />
      </svg>
      <figcaption>
        Third-party requests in successful, complete passive visits, oldest to newest. The full mixed evidence
        timeline remains below.
      </figcaption>
    </figure>
  );
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}

function formatSince(entry: DirectoryEntry): string {
  const delta = entry.sinceLastScan;
  if (!delta) return "";
  return `${formatMetricDelta(delta.thirdPartyRequests, "third-party requests")}, ${formatMetricDelta(
    delta.trackerRequests,
    "catalogued tracking requests"
  )} compared with ${formatDate(delta.previousScannedAt)}`;
}

function formatMetricDelta(value: number, label: string): string {
  return value === 0 ? `no change in ${label}` : `${formatDelta(value)} ${label}`;
}
