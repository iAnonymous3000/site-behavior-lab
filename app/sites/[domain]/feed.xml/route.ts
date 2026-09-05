import { loadCorpusOverview, type DirectoryEntry } from "@/lib/corpus-overview";
import { reportPagePath } from "@/lib/report-locator";
import { siteProfileKey } from "@/lib/site-profile";
import { siteBaseUrl } from "@/lib/site-url";

export const dynamic = "force-static";

/**
 * Per-domain Atom feed: the same reviewed corpus entries the site history page
 * lists, newest first, so a site can be watched from any feed reader without
 * this project running notification infrastructure. Only corpus publications
 * appear here; live share reports stay unlisted by design.
 */

export async function generateStaticParams() {
  const { entries } = await loadCorpusOverview();
  return [...new Set(entries.map((entry) => entry.siteKey).filter((key): key is string => key !== null))].map(
    (domain) => ({ domain })
  );
}

export async function GET(_request: Request, context: { params: Promise<{ domain: string }> }) {
  const key = siteProfileKey((await context.params).domain);
  if (!key) return new Response("Not found", { status: 404 });
  const { entries } = await loadCorpusOverview();
  const matches = entries
    .filter((entry) => entry.siteKey === key)
    .sort((left, right) => Date.parse(right.scannedAt) - Date.parse(left.scannedAt));
  if (matches.length === 0) return new Response("Not found", { status: 404 });

  const base = siteBaseUrl();
  const profileUrl = `${base}/sites/${encodeURIComponent(key)}/`;
  const feedUrl = `${base}/sites/${encodeURIComponent(key)}/feed.xml`;
  const updated = feedTimestamp(matches[0]);

  const feedEntries = matches
    .map((entry) => {
      const reportUrl = `${base}${reportPagePath(entry.id)}/`;
      return [
        "  <entry>",
        `    <id>${escapeXml(reportUrl)}</id>`,
        `    <title>${escapeXml(entry.headline)}</title>`,
        `    <link rel="alternate" type="text/html" href="${escapeXml(reportUrl)}"/>`,
        `    <updated>${escapeXml(feedTimestamp(entry))}</updated>`,
        `    <summary>${escapeXml(entrySummary(entry))}</summary>`,
        "  </entry>"
      ].join("\n");
    })
    .join("\n");

  const xml = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>${escapeXml(`${key} site behavior reports`)}</title>
  <subtitle>Reviewed Site Behavior Lab evidence for ${escapeXml(key)}, from the curated public corpus.</subtitle>
  <id>${escapeXml(profileUrl)}</id>
  <author><name>Site Behavior Lab</name></author>
  <link rel="alternate" type="text/html" href="${escapeXml(profileUrl)}"/>
  <link rel="self" type="application/atom+xml" href="${escapeXml(feedUrl)}"/>
  <updated>${escapeXml(updated)}</updated>
${feedEntries}
</feed>
`;

  return new Response(xml, {
    headers: { "content-type": "application/atom+xml; charset=utf-8" }
  });
}

function entrySummary(entry: DirectoryEntry): string {
  // Cookie completeness is its own family: a visit can finish collecting
  // requests while cookie capture is cut short. Every other DirectoryEntry
  // consumer (the site profile, the directory index, and the category page)
  // renders "Not measured" in that case, and this feed was the one surface
  // stating the count as fact.
  const cookies = entry.cookieEvidenceComplete
    ? `${entry.thirdPartyCookies.toLocaleString("en-US")} third-party cookies`
    : "third-party cookies not measured";
  const requestPrefix = entry.requestEvidenceComplete ? "" : "at least ";
  const metrics = `${requestPrefix}${entry.thirdPartyRequests.toLocaleString("en-US")} third-party requests, ${requestPrefix}${entry.trackerRequests.toLocaleString(
    "en-US"
  )} third-party tracking-service requests, ${cookies}.`;
  if (entry.requestEvidenceComplete) return metrics;
  // A failed visit (an error document or a blocked load) is why the counts are
  // floors, so say that rather than a capture loss the run did not record.
  const reason =
    entry.runOutcome !== "complete"
      ? "Visit did not complete"
      : `Request evidence incomplete${entry.capped ? " (recording capped)" : ""}`;
  return `${metrics} ${reason}; request counts are lower bounds.`;
}

function feedTimestamp(entry: DirectoryEntry): string {
  const parsed = Date.parse(entry.scannedAt);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date(0).toISOString();
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
