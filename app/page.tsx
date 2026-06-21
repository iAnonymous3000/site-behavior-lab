import { loadCorpusOverview } from "@/lib/corpus-overview";
import { SiteBehaviorApp } from "./site-behavior-app";

export default async function Home() {
  const { rollups, siteCount } = await loadCorpusOverview();
  const corpusHighlights = {
    siteCount,
    topCategories: rollups.slice(0, 4).map((rollup) => ({ label: rollup.label, medianTrackers: rollup.medianTrackers }))
  };

  return <SiteBehaviorApp corpusHighlights={corpusHighlights} />;
}
