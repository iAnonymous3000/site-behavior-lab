import { buildCorpusExportRows, corpusExportToCsv } from "@/lib/corpus-export";
import { loadCorpusOverview } from "@/lib/corpus-overview";
import { siteBaseUrl } from "@/lib/site-url";

// CSV twin of /corpus.json for spreadsheet and R/pandas workflows. The
// measured-corpus framing lives in the JSON payload's `note` and the README;
// CSV stays header + data rows so parsers never trip on a preamble.
export const dynamic = "force-static";

export async function GET(): Promise<Response> {
  const { entries } = await loadCorpusOverview();
  const csv = corpusExportToCsv(buildCorpusExportRows(entries, siteBaseUrl()));
  return new Response(csv, {
    headers: { "content-type": "text/csv; charset=utf-8" }
  });
}
