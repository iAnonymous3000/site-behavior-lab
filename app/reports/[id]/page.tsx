import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { buildReportHeadline } from "@/lib/report-headline";
import { serializeJsonLd } from "@/lib/jsonld-script";
import { buildReportDataset } from "@/lib/report-jsonld";
import { readStoredReportForId } from "@/lib/report-source";
import { toReportView } from "@/lib/scan-report-views";
import { siteBaseUrl, siteOrigin } from "@/lib/site-url";
import { listStaticReportIds } from "@/lib/static-report-files";
import { SavedReportClient } from "./saved-report-client";

const STATIC_EXPORT = process.env.NEXT_PUBLIC_SITE_BEHAVIOR_LAB_STATIC_EXPORT === "1";

export async function generateStaticParams() {
  const ids = await listStaticReportIds();
  return ids.map((id) => ({ id }));
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const result = await readStoredReportForId(id);

  if (result.outcome !== "found") {
    return {
      title: { absolute: "Report not found · Site Behavior Lab" },
      description: "This Site Behavior Lab report is unavailable.",
      robots: { index: false, follow: false }
    };
  }

  // The headline builds from the version-independent view, so the metadata
  // works for any readable schema generation, matching the view-based client
  // renderer below.
  const headline = buildReportHeadline(toReportView(result.stored));
  const title = `${headline.domain}: ${headline.headline}`;
  const description = headline.subhead;

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      type: "article"
    },
    twitter: {
      card: "summary_large_image",
      title,
      description
    }
  };
}

export default async function SavedReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await readStoredReportForId(id);
  // A nonexistent report must answer HTTP 404, not a 200 shell whose client
  // then renders a soft "not found": crawlers and uptime checks read the
  // status code. (Static-export builds only prerender committed ids, which
  // always resolve, so this fires on the dynamic server.)
  if (result.outcome === "not-found") notFound();
  // A report the server HOLDS but cannot read must answer 500, not 404:
  // corrupt bytes are a data fault and a newer schema is a capability gap,
  // and both deserve a visible error over a false "does not exist".
  if (result.outcome === "unreadable") {
    throw new Error(
      result.error === "unsupported-version" || result.error === "unsupported-revision"
        ? `Report ${id} was written by a newer scanner version; this deployment cannot render it yet.`
        : `Report ${id} exists but its stored data is unreadable (${result.error}).`
    );
  }
  // Every readable generation renders through the view-based client below
  // (RFC 14.8 atomic consumer migration); unreadable and newer-revision
  // reports were already answered above.
  const dataset = buildReportDataset(toReportView(result.stored), {
    url: `${siteBaseUrl()}/reports/${id}/`,
    jsonUrl: STATIC_EXPORT ? `${siteBaseUrl()}/reports/${id}.json` : `${siteOrigin()}/api/reports/${id}`
  });

  return (
    <>
      {dataset && (
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: serializeJsonLd(dataset) }} />
      )}
      <SavedReportClient id={id} />
    </>
  );
}
