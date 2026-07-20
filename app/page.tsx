import { loadCorpusOverview } from "@/lib/corpus-overview";
import { SiteBehaviorApp } from "./site-behavior-app";

export default async function Home() {
  const {
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

  return <SiteBehaviorApp corpusHighlights={corpusHighlights} />;
}
