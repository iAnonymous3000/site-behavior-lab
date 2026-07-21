import { loadCorpusOverview } from "@/lib/corpus-overview";
import { isFeaturedSiteConfig } from "@/lib/featured-sites";
import { buildHomepageDiscovery, type HomepageReportSource } from "@/lib/homepage-discovery";
import featuredSiteConfigJson from "@/public/featured-sites.json";
import { SiteBehaviorApp } from "./site-behavior-app";

export default async function Home() {
  const {
    entries,
    rollups,
    coverageSiteCount,
    attemptedSiteCount,
    failedSiteCount,
    cappedSiteCount
  } = await loadCorpusOverview();
  const corpusHighlights = {
    attemptedSiteCount,
    loadedSiteCount: coverageSiteCount,
    failedSiteCount,
    cappedSiteCount,
    eligibleSiteCount: rollups.reduce((total, rollup) => total + rollup.siteCount, 0),
    topCategories: rollups.slice(0, 4).map((rollup) => ({ label: rollup.label, medianTrackers: rollup.medianTrackers }))
  };
  if (!isFeaturedSiteConfig(featuredSiteConfigJson)) {
    throw new Error("public/featured-sites.json is not a valid featured site configuration.");
  }
  const discoveryReports: HomepageReportSource[] = entries.map((entry) => ({
    id: entry.id,
    domain: entry.domain,
    headline: entry.headline,
    tone: entry.tone,
    scannedAt: entry.scannedAt,
    reportType: entry.reportType,
    thirdPartyRequests: entry.thirdPartyRequests,
    trackerRequests: entry.trackerRequests,
    requestCapped: entry.capped,
    successfulLoad: entry.reportHasSuccessfulLoad
  }));
  const homepageDiscovery = buildHomepageDiscovery(featuredSiteConfigJson, discoveryReports);

  return <SiteBehaviorApp corpusHighlights={corpusHighlights} homepageDiscovery={homepageDiscovery} />;
}
