import type { MetadataRoute } from "next";
import { reportPagePath } from "@/lib/report-locator";
import { siteBaseUrl } from "@/lib/site-url";
import { siteProfilePath } from "@/lib/site-profile";
import { loadCorpusOverview } from "@/lib/corpus-overview";
import { newestSitemapDate, sitemapLastModified } from "@/lib/seo-metadata";
import { buildCategoryEvidencePages, buildDirectorySites, directoryPageCount } from "@/lib/directory-view";

export const dynamic = "force-static";

const STATIC_EXPORT = process.env.NEXT_PUBLIC_SITE_BEHAVIOR_LAB_STATIC_EXPORT === "1";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  // The scanner/container origin is intentionally not a discovery surface.
  // Its report pages remain crawlable through direct links solely so crawlers
  // can read their noindex metadata and X-Robots-Tag.
  if (!STATIC_EXPORT) return [];

  const base = siteBaseUrl();
  const generatedAt = Date.now();
  const overview = await loadCorpusOverview();
  const corpusLastModified = newestSitemapDate(
    overview.entries.map((entry) => entry.scannedAt),
    generatedAt
  );

  const entries: MetadataRoute.Sitemap = [
    {
      url: `${base}/`,
      ...(corpusLastModified ? { lastModified: corpusLastModified } : {}),
      changeFrequency: "weekly",
      priority: 1
    },
    {
      url: `${base}/directory/`,
      ...(corpusLastModified ? { lastModified: corpusLastModified } : {}),
      changeFrequency: "weekly",
      priority: 0.8
    },
    { url: `${base}/about/`, changeFrequency: "monthly", priority: 0.6 },
    { url: `${base}/glossary/`, changeFrequency: "monthly", priority: 0.4 },
    { url: `${base}/methodology/`, changeFrequency: "monthly", priority: 0.5 },
    { url: `${base}/privacy/`, changeFrequency: "yearly", priority: 0.3 },
    { url: `${base}/status/`, changeFrequency: "weekly", priority: 0.6 },
    { url: `${base}/security/`, changeFrequency: "yearly", priority: 0.3 },
    { url: `${base}/corrections/`, changeFrequency: "monthly", priority: 0.4 },
    { url: `${base}/catalog/`, changeFrequency: "monthly", priority: 0.55 }
  ];

  const directoryPages = directoryPageCount(buildDirectorySites(overview.entries).length);
  for (let page = 2; page <= directoryPages; page += 1) {
    entries.push({
      url: `${base}/directory/page/${page}/`,
      ...(corpusLastModified ? { lastModified: corpusLastModified } : {}),
      changeFrequency: "weekly",
      priority: 0.65
    });
  }

  for (const category of buildCategoryEvidencePages(overview.entries)) {
    const lastModified = sitemapLastModified(category.lastScannedAt, generatedAt);
    entries.push({
      url: `${base}${category.path}/`,
      ...(lastModified ? { lastModified } : {}),
      changeFrequency: "weekly",
      priority: 0.75
    });
  }

  const profileLastModified = new Map<string, Date | undefined>();
  for (const entry of overview.entries) {
    const profilePath = siteProfilePath(entry.domain);
    if (!profilePath) continue;
    const scannedAt = sitemapLastModified(entry.scannedAt, generatedAt);
    if (!profileLastModified.has(profilePath)) profileLastModified.set(profilePath, undefined);
    if (!scannedAt) continue;
    const current = profileLastModified.get(profilePath);
    if (!current || scannedAt.getTime() > current.getTime()) profileLastModified.set(profilePath, scannedAt);
  }
  for (const [profilePath, lastModified] of [...profileLastModified].sort(([left], [right]) => left.localeCompare(right))) {
    entries.push({
      url: `${base}${profilePath}/`,
      ...(lastModified ? { lastModified } : {}),
      changeFrequency: "weekly",
      priority: 0.85
    });
  }

  // Only the static export serves committed report pages at /reports/:id/; the
  // Node app's share permalinks are random-ID and short-lived, so they are not
  // listed here. Runtime shares stay crawlable only so their noindex directive
  // can be read; they never enter this permanent discovery surface.
  // loadCorpusOverview already validated and filtered every committed report.
  // Reuse it here so the static route does not reread the full corpus during
  // export, which can exceed hosted build-route time limits as the corpus grows.
  for (const report of overview.sitemapReports) {
    const lastModified = sitemapLastModified(report.lastModifiedAt, generatedAt);
    entries.push({
      url: `${base}${reportPagePath(report.id)}/`,
      ...(lastModified ? { lastModified } : {}),
      changeFrequency: "monthly",
      priority: 0.7
    });
  }

  return entries;
}
