import { loadCorpusOverview } from "@/lib/corpus-overview";
import { SiteBehaviorApp } from "./site-behavior-app";

export default async function Home() {
  // The hero's "we open N real sites" is a coverage claim (every site that
  // loaded, including capped recordings), not the measured-sample size.
  const { rollups, coverageSiteCount } = await loadCorpusOverview();
  const corpusHighlights = {
    siteCount: coverageSiteCount,
    topCategories: rollups.slice(0, 4).map((rollup) => ({ label: rollup.label, medianTrackers: rollup.medianTrackers }))
  };

  return <SiteBehaviorApp corpusHighlights={corpusHighlights} />;
}
