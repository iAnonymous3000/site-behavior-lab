import type { MetadataRoute } from "next";
import { reportPagePath } from "@/lib/report-locator";
import { readReportForId } from "@/lib/report-source";
import { isReservedReportDomain } from "@/lib/reserved-report-domains";
import { listStaticReportIds } from "@/lib/static-report-files";
import { siteBaseUrl } from "@/lib/site-url";

export const dynamic = "force-static";

const STATIC_EXPORT = process.env.NEXT_PUBLIC_SITE_BEHAVIOR_LAB_STATIC_EXPORT === "1";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = siteBaseUrl();
  const lastModified = new Date();

  const entries: MetadataRoute.Sitemap = [
    { url: `${base}/`, lastModified, changeFrequency: "weekly", priority: 1 },
    { url: `${base}/directory/`, lastModified, changeFrequency: "weekly", priority: 0.8 },
    { url: `${base}/privacy/`, lastModified, changeFrequency: "yearly", priority: 0.3 }
  ];

  // Only the static export serves committed report pages at /reports/:id/; the
  // Node app's share permalinks are random-ID and short-lived, so they are not
  // listed here (and are disallowed in robots.txt).
  if (STATIC_EXPORT) {
    for (const id of await listStaticReportIds()) {
      const report = await readReportForId(id);
      if (!report) continue;
      const result = report.reportType === "comparison" ? report.variant : report;
      // Reserved/test domains stay out of the sitemap, matching the gallery and directory.
      if (isReservedReportDomain(result.summary.firstPartyDomain)) continue;
      entries.push({ url: `${base}${reportPagePath(id)}/`, lastModified, changeFrequency: "monthly", priority: 0.7 });
    }
  }

  return entries;
}
