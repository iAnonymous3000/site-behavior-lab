import type { Metadata } from "next";
import Link from "next/link";
import { buildReportHeadline, displayScanResult, type HeadlineTone } from "@/lib/report-headline";
import { reportPagePath } from "@/lib/report-locator";
import { readReportForId } from "@/lib/report-source";
import { isReservedReportDomain } from "@/lib/reserved-report-domains";
import { listStaticReportIds } from "@/lib/static-report-files";
import type { ComparisonType } from "@/lib/types";

export const dynamic = "force-static";

export const metadata: Metadata = {
  title: "Directory of scanned sites",
  description:
    "Browse Site Behavior Lab reports: what popular sites actually loaded during a controlled visit — trackers, cookies, and fingerprinting, as reproducible evidence.",
  alternates: { canonical: "/directory/" }
};

type DirectoryEntry = {
  id: string;
  domain: string;
  tone: HeadlineTone;
  headline: string;
  thirdPartyRequests: number;
  trackerRequests: number;
  thirdPartyCookies: number;
  scannedAt: string;
  reportType: "single" | "comparison";
  comparisonType?: ComparisonType;
};

function reportTypeLabel(entry: DirectoryEntry): string {
  if (entry.reportType !== "comparison") return "single scan";
  if (entry.comparisonType === "shields") return "Shields comparison";
  if (entry.comparisonType === "temporal") return "temporal comparison";
  if (entry.comparisonType === "gpc") return "GPC comparison";
  return "comparison";
}

export default async function DirectoryPage() {
  const entries = await loadDirectoryEntries();

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

async function loadDirectoryEntries(): Promise<DirectoryEntry[]> {
  const ids = await listStaticReportIds();
  const entries: DirectoryEntry[] = [];

  for (const id of ids) {
    const report = await readReportForId(id);
    if (!report) continue;

    // Lead with the baseline (off / unprotected) run for GPC/Shields so the directory
    // lists and ranks what each site actually did, not the protected residual.
    const result = displayScanResult(report);
    // Keep reserved/test domains out of the public directory, mirroring the gallery
    // manifest exclusion (a reserved-domain report is reachable by permalink only).
    if (isReservedReportDomain(result.summary.firstPartyDomain)) continue;
    const headline = buildReportHeadline(report);

    entries.push({
      id,
      domain: headline.domain,
      tone: headline.tone,
      headline: headline.headline,
      thirdPartyRequests: result.summary.thirdPartyRequests,
      trackerRequests: result.summary.knownTrackerRequests,
      thirdPartyCookies: result.summary.thirdPartyCookies,
      scannedAt: report.reportType === "comparison" ? report.scannedAt : result.conditions.scannedAt,
      reportType: report.reportType === "comparison" ? "comparison" : "single",
      ...(report.reportType === "comparison" ? { comparisonType: report.comparisonType } : {})
    });
  }

  return entries.sort(
    (a, b) =>
      b.trackerRequests - a.trackerRequests ||
      b.thirdPartyRequests - a.thirdPartyRequests ||
      a.domain.localeCompare(b.domain)
  );
}
