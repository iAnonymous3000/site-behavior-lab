import { loadCorpusOverview } from "@/lib/corpus-overview";
import { buildCategoryEvidencePages } from "@/lib/directory-view";
import { isFeaturedSiteConfig } from "@/lib/featured-sites";
import { buildHomepageDiscovery, type HomepageReportSource } from "@/lib/homepage-discovery";
import featuredSiteConfigJson from "@/public/featured-sites.json";
import { SiteBehaviorApp } from "./site-behavior-app";

export default async function Home() {
  const { entries, coverageSiteCount, attemptedSiteCount, failedSiteCount, cappedSiteCount } =
    await loadCorpusOverview();
  // The hero's category medians must be the SAME numbers the reader finds on
  // /directory/ and on each /categories/<id>/ page. Those pages publish one
  // cohort per category (chosen by the shared newest-evidence rule in
  // `selectPrimaryCorpusCohort`, not by size), while a corpus-wide rollup mixes a
  // different site set, so deriving the hero from anything else publishes two
  // different medians under one label.
  const categoryPages = buildCategoryEvidencePages(entries);
  const corpusHighlights = {
    attemptedSiteCount,
    loadedSiteCount: coverageSiteCount,
    failedSiteCount,
    cappedSiteCount,
    eligibleSiteCount: categoryPages.reduce((total, category) => total + category.rollup.siteCount, 0),
    // Each category page publishes ONE cohort, but different categories can
    // land on different ones during a methodology migration, so the sum above
    // spans them and no single median covers it. The reader is told how many.
    eligibleCohortCount: new Set(categoryPages.map((category) => category.cohort.id)).size,
    topCategories: [...categoryPages]
      .sort(
        (left, right) =>
          right.rollup.medianTrackers - left.rollup.medianTrackers || left.label.localeCompare(right.label)
      )
      .slice(0, 4)
      .map((category) => ({
        label: category.label,
        medianTrackers: category.rollup.medianTrackers,
        cohort: category.cohort
      }))
  };
  if (!isFeaturedSiteConfig(featuredSiteConfigJson)) {
    throw new Error("public/featured-sites.json is not a valid featured site configuration.");
  }
  const discoveryReports: HomepageReportSource[] = entries.map((entry) => ({
    id: entry.id,
    domain: entry.domain,
    siteKey: entry.siteKey,
    headline: entry.headline,
    tone: entry.tone,
    scannedAt: entry.scannedAt,
    reportType: entry.reportType,
    thirdPartyRequests: entry.thirdPartyRequests,
    trackerRequests: entry.trackerRequests,
    requestCapped: entry.capped,
    requestEvidenceComplete: entry.requestEvidenceComplete,
    successfulLoad: entry.reportHasSuccessfulLoad
  }));
  const homepageDiscovery = buildHomepageDiscovery(featuredSiteConfigJson, discoveryReports);

  return <SiteBehaviorApp corpusHighlights={corpusHighlights} homepageDiscovery={homepageDiscovery} />;
}
