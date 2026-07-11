import { OG_CONTENT_TYPE, OG_SIZE, renderMissingReportCard, renderReportCard } from "@/lib/og-report-card";
import { readStoredReportForId } from "@/lib/report-source";
import { toReportView } from "@/lib/scan-report-views";
import { listStaticReportIds } from "@/lib/static-report-files";

export const alt = "Site Behavior Lab report card";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
// Required for the static GitHub Pages export (`output: export`).
export const dynamic = "force-static";

export async function generateStaticParams() {
  const ids = await listStaticReportIds();
  return ids.map((id) => ({ id }));
}

export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await readStoredReportForId(id);
  // The card renders from the version-independent view, so any readable
  // schema generation gets a real social card; unreadable or missing reports
  // get the fallback card instead of a build failure.
  return result.outcome === "found" ? renderReportCard(toReportView(result.stored)) : renderMissingReportCard();
}
