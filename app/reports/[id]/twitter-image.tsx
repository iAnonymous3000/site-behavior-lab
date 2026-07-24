import { OG_CONTENT_TYPE, OG_SIZE, renderMissingReportCard, renderReportCard } from "@/lib/og-report-card";
import { readStoredReportForId } from "@/lib/report-source";
import { requireFreshRuntimeReportRequest } from "@/lib/report-route-freshness";
import { toReportView } from "@/lib/scan-report-views";

export const alt = "Site Behavior Lab report card";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
// Replaced with force-static plus static params only inside the isolated Pages
// export worktree. Runtime source must remain request-rendered.
export const dynamic = "force-dynamic";

export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  await requireFreshRuntimeReportRequest();
  const { id } = await params;
  const result = await readStoredReportForId(id);
  // The card renders from the version-independent view, so any readable
  // schema generation gets a real social card; unreadable or missing reports
  // get the fallback card instead of a build failure.
  return result.outcome === "found" ? renderReportCard(toReportView(result.stored)) : renderMissingReportCard();
}
