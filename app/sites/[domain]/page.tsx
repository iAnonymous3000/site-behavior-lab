import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { siteProfileComparableVisitsNote } from "@/lib/comparable-visits-note";
import { entryEligibleForCorpusRollups, loadCorpusOverview, type DirectoryEntry } from "@/lib/corpus-overview";
import { reportPagePath } from "@/lib/report-locator";
import { scanPrefillHref } from "@/lib/scan-prefill";
import { conciseMetadataText, publicPageMetadata } from "@/lib/seo-metadata";
import { siteProfileKey, siteProfilePath } from "@/lib/site-profile";
import { formatDelta } from "@/lib/temporal-deltas";
import { safeNavigableHttpUrl } from "@/lib/report-url";
import { sitePagesBasePath, siteUrl } from "@/lib/site-url";
import { corpusCohortDifferences } from "@/lib/corpus-cohort";
import { displayHost, humanList, reportKindLabel } from "@/lib/text-format";
import { SiteChrome } from "../../_components/site-chrome";

export const dynamic = "force-static";

export async function generateStaticParams() {
  const { entries } = await loadCorpusOverview();
  return [...new Set(entries.map((entry) => entry.siteKey).filter((key): key is string => key !== null))].map(
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
  const visibleDomain = displayHost(profile.domain);
  const title = `What ${visibleDomain} loaded: website behavior history`;
  const description = conciseMetadataText(
    `Controlled-visit evidence, not a verdict. Browse ${profile.entries.length} ${
      profile.entries.length === 1 ? "report" : "reports"
    } for ${visibleDomain}; latest ${formatDate(latest.scannedAt)}: ${latest.headline}`,
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
  // The v1 and v2/r2 pairing identities hold different things constant (the
  // v1 key binds the Brave-list source and list count and lets only the
  // snapshot date drift; the v2 key omits all three), so the method note is
  // stated per era actually present among these pairs, exactly like the
  // archive's compare picker. One flat sentence here restated the v2 rule
  // over pairs that were all v1.
  const comparableEras = (["v1", "v2"] as const).filter((era) =>
    compatibleChanges.some((entry) => entry.comparisonHistoryEra === era)
  );
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
  // HistorySparkline renders nothing below two points, so the note must be
  // gated on the SAME condition. It used to announce "The trend line covers
  // this site's 1 most recent reports" under a figure that was never drawn --
  // true for wikipedia.org and every other site whose newest cohort holds a
  // single report.
  const sparklineRendered = sparklineEntries.length >= 2;
  // And say what actually differs. The corpus cohort key splits on requested
  // GPC, schema revision, producer, catalog and taxonomy as well as
  // methodology, so "produced by a different methodology" was simply false for
  // omitted reports whose scanner disclosure is byte-for-byte identical to the
  // plotted one and which differ only in the GPC condition.
  const sparklineOmittedCohortNote = corpusCohortDifferences([
    ...new Map(
      sparklineCandidates.map((entry) => [entry.corpusCohort.id, entry.corpusCohort])
    ).values()
  ]);

  return (
    <SiteChrome activePath="/directory/">
      <div className="site-profile-page">
      <nav className="page-breadcrumbs" aria-label="Breadcrumb">
        <ol>
          <li><Link href="/">Home</Link></li>
          <li aria-hidden="true">/</li>
          <li><Link href="/directory/">Scanned sites</Link></li>
          <li aria-hidden="true">/</li>
          <li aria-current="page">{displayHost(profile.domain)}</li>
        </ol>
      </nav>
      <header className="page-header">
        <p className="eyebrow">Site history · curated public corpus</p>
        <h1>{displayHost(profile.domain)}</h1>
        <p className="lede">{latest.headline}</p>
        <p className="page-meta">
          {profile.entries.length} {profile.entries.length === 1 ? "report" : "reports"} retained. This timeline
          contains reviewed reports published into the curated public corpus; a live rescan remains a standalone
          share report until a later corpus publication includes it.
        </p>
        <div className="page-actions">
          <Link className="primary-button" href={rescanHref}>
            {exactRescanUrl ? "Scan this exact route again" : "Scan this site again"}
          </Link>
          <Link className="secondary-button" href={`${reportPagePath(latest.id)}/`}>
            Open latest evidence
          </Link>
          <a className="topbar-link" href="#history">Report history</a>
          <a className="topbar-link" href={`${sitePagesBasePath()}${siteProfilePath(profile.domain)}/feed.xml`}>
            Atom feed
          </a>
        </div>
      </header>

      <section className={`site-profile-current tone-${latest.tone}`} aria-labelledby="current-title">
        <div>
          <p className="eyebrow">Latest controlled visit</p>
          <h2 id="current-title">{latest.headline}</h2>
          <p>
            {reportKindLabel(latest)} · {formatDate(latest.scannedAt)} · {latest.device}
            {!latest.requestEvidenceComplete && (
              <> · <IncompleteEvidenceChip capped={latest.capped} failed={latest.runOutcome !== "complete"} /></>
            )}
          </p>
        </div>
        <dl className="site-profile-metrics">
          <div>
            <dt>Third-party requests</dt>
            <dd>{!latest.requestEvidenceComplete && "at least "}{latest.thirdPartyRequests.toLocaleString()}</dd>
          </div>
          <div>
            <dt>Third-party tracking-service requests</dt>
            <dd>{!latest.requestEvidenceComplete && "at least "}{latest.trackerRequests.toLocaleString()}</dd>
          </div>
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
          {comparableEras.map((era) => (
            <p className="site-profile-note" key={era}>
              {siteProfileComparableVisitsNote(era)}
            </p>
          ))}
        </section>
      )}

      <section className="site-profile-section" id="history" aria-labelledby="history-title">
        <p className="eyebrow">Evidence timeline</p>
        <h2 id="history-title">{profile.entries.length} {profile.entries.length === 1 ? "report" : "reports"}</h2>
        <HistorySparkline entries={sparklineEntries} />
        {sparklineOmittedCohortCount > 0 && (
          <p className="muted">
            {sparklineRendered
              ? `The trend line covers this site's ${sparklineEntries.length} most recent reports from one measurement cohort. `
              : `No trend line: this site's newest measurement cohort holds ${
                  sparklineEntries.length === 1 ? "only one report" : "no comparable report"
                }. `}
            {sparklineOmittedCohortCount}{" "}
            {sparklineOmittedCohortCount === 1 ? "other report was" : "other reports were"} measured under{" "}
            {`${
              sparklineOmittedCohortNote.length > 0
                ? humanList(sparklineOmittedCohortNote, 3)
                : "a different measurement cohort"
            }, so ${
              sparklineOmittedCohortCount === 1 ? "it is" : "they are"
            } listed below rather than joined to one line.`}
          </p>
        )}
        {/* A table, not a list of cards. Seven cards for github.com carried
            the identical headline sentence seven times while the numbers that
            differ between visits sat in their small print; a reader comparing
            visits reads down a column. The lead finding for each visit is
            still one click away on the report itself. */}
        <div className="site-history-table-wrap">
          <table className="site-history-table">
            <caption className="visually-hidden">
              Every retained report for {displayHost(profile.domain)}, newest first: its date, what kind of visit
              it was, its request counts as recorded, its third-party cookie count and its schema. Its request
              counts are lower bounds where the visit was incomplete.
            </caption>
            <thead>
              <tr>
                <th scope="col">Visit</th>
                <th scope="col">Kind</th>
                <th scope="col" className="num">Third-party requests</th>
                <th scope="col" className="num">Third-party tracking-service requests</th>
                <th scope="col" className="num">Third-party cookies</th>
                <th scope="col">Schema</th>
              </tr>
            </thead>
            <tbody>
              {profile.entries.map((entry) => (
                <tr key={entry.id}>
                  <th scope="row">
                    <Link href={`${reportPagePath(entry.id)}/`}>{formatDate(entry.scannedAt)}</Link>
                    {!entry.requestEvidenceComplete && (
                      <div>
                        <IncompleteEvidenceChip capped={entry.capped} failed={entry.runOutcome !== "complete"} />
                      </div>
                    )}
                  </th>
                  <td>{reportKindLabel(entry)} · {entry.device}</td>
                  <td className="num">
                    {!entry.requestEvidenceComplete && "at least "}{entry.thirdPartyRequests.toLocaleString()}
                  </td>
                  <td className="num">
                    {!entry.requestEvidenceComplete && "at least "}{entry.trackerRequests.toLocaleString()}
                  </td>
                  <td className="num">
                    {entry.cookieEvidenceComplete ? entry.thirdPartyCookies.toLocaleString() : "Not measured"}
                  </td>
                  <td>schema {entry.schemaVersion}{entry.schemaRevision ? `.r${entry.schemaRevision}` : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      </div>
    </SiteChrome>
  );
}

async function loadProfile(rawDomain: string): Promise<{ domain: string; entries: DirectoryEntry[] } | null> {
  const key = siteProfileKey(rawDomain);
  if (!key) return null;
  const { entries } = await loadCorpusOverview();
  const matches = entries
    .filter((entry) => entry.siteKey === key)
    .sort((left, right) => Date.parse(right.scannedAt) - Date.parse(left.scannedAt));
  return matches.length > 0 ? { domain: key, entries: matches } : null;
}

/**
 * The two-word chip is the visible label; the sentence that says what it means goes in
 * the reading order rather than a `title`. A pointer tooltip on a non-focusable span is
 * unreachable by touch and by keyboard, and screen readers skip `title` when the element
 * already has text. lib/accessibility-contract.test.ts bans this pattern elsewhere.
 */
function IncompleteEvidenceChip({ capped, failed }: { capped: boolean; failed: boolean }) {
  // A failed visit is named as such: its counts are floors because the load
  // did not complete, not because of a capture loss the run never recorded.
  return (
    <span className="capped-chip">
      {failed ? "visit did not complete" : capped ? "recording capped" : "request evidence incomplete"}
      <span className="visually-hidden print-text-equivalent">
        {failed
          ? ": this visit returned an error document or was blocked, so its request counts are lower bounds, its cookie count is not measured, and it is excluded from the medians, leaderboard, and since-last-scan deltas."
          : capped
            ? ": this visit hit the exact request-recording cap, so its request counts are lower bounds and it is excluded from the medians, leaderboard, and since-last-scan deltas."
            : ": this visit has incomplete request evidence from another bounded capture loss, so its request counts are lower bounds and it is excluded from the medians, leaderboard, and since-last-scan deltas."}
      </span>
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
    "third-party tracking-service requests"
  )} compared with ${formatDate(delta.previousScannedAt)}`;
}

function formatMetricDelta(value: number, label: string): string {
  return value === 0 ? `no change in ${label}` : `${formatDelta(value)} ${label}`;
}
