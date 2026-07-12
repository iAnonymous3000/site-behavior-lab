import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { loadCorpusOverview, type DirectoryEntry } from "@/lib/corpus-overview";
import { reportPagePath } from "@/lib/report-locator";
import { siteProfileKey, siteProfilePath } from "@/lib/site-profile";
import { formatDelta } from "@/lib/temporal-deltas";
import { safeNavigableHttpUrl } from "@/lib/report-url";
import { sitePagesBasePath } from "@/lib/site-url";

export const dynamic = "force-static";

export async function generateStaticParams() {
  const { entries } = await loadCorpusOverview();
  return [...new Set(entries.map((entry) => siteProfileKey(entry.domain)).filter((key): key is string => Boolean(key)))].map(
    (domain) => ({ domain })
  );
}

export async function generateMetadata({ params }: { params: Promise<{ domain: string }> }): Promise<Metadata> {
  const profile = await loadProfile((await params).domain);
  if (!profile) return { title: "Site history not found", robots: { index: false, follow: false } };
  const compatibleChanges = profile.entries.filter((entry) => entry.sinceLastScan).length;
  return {
    title: `${profile.domain} site behavior history`,
    description: `${profile.entries.length} controlled Site Behavior Lab ${
      profile.entries.length === 1 ? "report" : "reports"
    } for ${profile.domain}, with reproducible evidence${
      compatibleChanges > 0 ? " and observed differences across comparable visits" : " from the curated public corpus"
    }.`,
    alternates: { canonical: `${sitePagesBasePath()}${siteProfilePath(profile.domain)}/` }
  };
}

export default async function SiteProfilePage({ params }: { params: Promise<{ domain: string }> }) {
  const profile = await loadProfile((await params).domain);
  if (!profile) notFound();
  const latest = profile.entries[0];
  const compatibleChanges = profile.entries.filter((entry) => entry.sinceLastScan);
  const exactRescanUrl = safeNavigableHttpUrl(latest.requestedUrl) ? latest.requestedUrl : null;
  const rescanUrl = exactRescanUrl ?? `https://${profile.domain}/`;

  return (
    <main className="site-profile-page">
      <header className="site-profile-header">
        <p className="eyebrow">Curated public corpus · Site history</p>
        <h1>{profile.domain}</h1>
        <p>{latest.headline}</p>
        <div className="site-profile-actions">
          <Link className="primary-button" href={`/?url=${encodeURIComponent(rescanUrl)}#scan`}>
            {exactRescanUrl ? "Scan this exact route again" : "Scan this site again"}
          </Link>
          <Link className="secondary-button" href={`${reportPagePath(latest.id)}/`}>
            Open latest evidence
          </Link>
          <Link className="topbar-link" href="/directory/">All scanned sites</Link>
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
          <p>{formatReportKind(latest)} · {formatDate(latest.scannedAt)} · {latest.device}</p>
        </div>
        <dl className="site-profile-metrics">
          <div><dt>Third-party requests</dt><dd>{latest.thirdPartyRequests.toLocaleString()}</dd></div>
          <div><dt>Catalogued tracking requests</dt><dd>{latest.trackerRequests.toLocaleString()}</dd></div>
          <div><dt>Third-party cookies</dt><dd>{latest.thirdPartyCookies.toLocaleString()}</dd></div>
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

      <section className="site-profile-section" aria-labelledby="history-title">
        <p className="eyebrow">Evidence timeline</p>
        <h2 id="history-title">{profile.entries.length} {profile.entries.length === 1 ? "report" : "reports"}</h2>
        <ol className="site-history-list">
          {profile.entries.map((entry) => (
            <li key={entry.id}>
              <Link href={`${reportPagePath(entry.id)}/`}>
                <span><strong>{formatDate(entry.scannedAt)}</strong> · {formatReportKind(entry)} · {entry.device}</span>
                <span>{entry.headline}</span>
                <small>
                  {entry.thirdPartyRequests.toLocaleString()} third-party · {entry.trackerRequests.toLocaleString()} catalogued tracking · schema {entry.schemaVersion}{entry.schemaRevision ? `.r${entry.schemaRevision}` : ""}
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

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

function formatReportKind(entry: DirectoryEntry): string {
  if (entry.reportType === "single") return "single scan";
  if (entry.comparisonType === "shields") return "Brave-list blocking comparison";
  if (entry.comparisonType === "gpc") return "GPC comparison";
  if (entry.comparisonType === "consent") return "consent comparison";
  if (entry.comparisonType === "temporal") return "temporal comparison";
  return "comparison";
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
