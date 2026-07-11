import { buildCorpusExportPayload, buildCorpusExportRows } from "@/lib/corpus-export";
import { loadCorpusOverview } from "@/lib/corpus-overview";
import { siteBaseUrl } from "@/lib/site-url";

// Researcher export: one row per published report, generated at build time
// from the committed corpus (same loader as /directory/). Static on both the
// Node app and the Pages export; `generatedAt` is the build moment.
export const dynamic = "force-static";

export async function GET(): Promise<Response> {
  const { entries, siteCount, coverageSiteCount } = await loadCorpusOverview();
  const rows = buildCorpusExportRows(entries, siteBaseUrl());
  const payload = buildCorpusExportPayload(rows, {
    generatedAt: new Date().toISOString(),
    siteCount: coverageSiteCount,
    measuredSampleSize: siteCount
  });
  return new Response(`${JSON.stringify(payload, null, 2)}\n`, {
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}
