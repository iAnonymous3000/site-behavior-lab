import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Metadata } from "next";
import Link from "next/link";
import { buildCategoryRollups } from "@/lib/category-rollups";
import { domainsMatch } from "@/lib/featured-sites";
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
  shieldsBlocked: number | null;
  category: string;
  categoryLabel: string;
  scannedAt: string;
  reportType: "single" | "comparison";
  comparisonType?: ComparisonType;
};

type CatalogEntry = { domain: string; id: string; label: string };

function reportTypeLabel(entry: DirectoryEntry): string {
  if (entry.reportType !== "comparison") return "single scan";
  if (entry.comparisonType === "shields") return "Shields comparison";
  if (entry.comparisonType === "temporal") return "temporal comparison";
  if (entry.comparisonType === "gpc") return "GPC comparison";
  return "comparison";
}

export default async function DirectoryPage() {
  const catalog = await loadCategoryCatalog();
  const entries = await loadDirectoryEntries(catalog);

  // One data point per site for the rollups and leaderboard (a site may carry both
  // a GPC and a Shields report; prefer the Shields one so the blocked number is real).
  const byDomain = new Map<string, DirectoryEntry>();
  for (const entry of entries) {
    const existing = byDomain.get(entry.domain);
    if (!existing || (entry.comparisonType === "shields" && existing.comparisonType !== "shields")) {
      byDomain.set(entry.domain, entry);
    }
  }
  const sites = [...byDomain.values()];

  const rollups = buildCategoryRollups(
    sites.map((site) => ({
      category: site.category,
      categoryLabel: site.categoryLabel,
      trackerRequests: site.trackerRequests,
      thirdPartyRequests: site.thirdPartyRequests,
      thirdPartyCookies: site.thirdPartyCookies,
      shieldsBlocked: site.shieldsBlocked
    }))
  );
  const maxMedianTrackers = Math.max(1, ...rollups.map((rollup) => rollup.medianTrackers));
  const heaviest = [...sites]
    .filter((site) => site.trackerRequests > 0)
    .sort((a, b) => b.trackerRequests - a.trackerRequests)
    .slice(0, 5);

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

async function loadCategoryCatalog(): Promise<CatalogEntry[]> {
  const files = ["featured-sites.json", "corpus-seed-sites.json"];
  const catalog: CatalogEntry[] = [];
  for (const file of files) {
    try {
      const raw = await readFile(path.join(process.cwd(), "public", file), "utf8");
      const config = JSON.parse(raw) as {
        categories?: { id: string; label: string }[];
        sites?: { domain: string; category: string }[];
      };
      const labels = new Map((config.categories ?? []).map((category) => [category.id, category.label]));
      for (const site of config.sites ?? []) {
        if (typeof site.domain === "string" && typeof site.category === "string") {
          catalog.push({ domain: site.domain, id: site.category, label: labels.get(site.category) ?? site.category });
        }
      }
    } catch {
      // A catalog file is optional; skip it if missing or malformed.
    }
  }
  return catalog;
}

function categoryFor(domain: string, catalog: CatalogEntry[]): { id: string; label: string } {
  const hit = catalog.find((entry) => domainsMatch(domain, entry.domain));
  return hit ? { id: hit.id, label: hit.label } : { id: "", label: "Other" };
}

async function loadDirectoryEntries(catalog: CatalogEntry[]): Promise<DirectoryEntry[]> {
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
    const { id: category, label: categoryLabel } = categoryFor(result.summary.firstPartyDomain, catalog);
    const shieldsBlocked =
      report.reportType === "comparison" && report.comparisonType === "shields"
        ? Math.max(0, report.baseline.summary.thirdPartyRequests - report.variant.summary.thirdPartyRequests)
        : null;

    entries.push({
      id,
      domain: headline.domain,
      tone: headline.tone,
      headline: headline.headline,
      thirdPartyRequests: result.summary.thirdPartyRequests,
      trackerRequests: result.summary.knownTrackerRequests,
      thirdPartyCookies: result.summary.thirdPartyCookies,
      shieldsBlocked,
      category,
      categoryLabel,
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
