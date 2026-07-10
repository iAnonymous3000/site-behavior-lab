import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { buildReportHeadline } from "@/lib/report-headline";
import { serializeJsonLd } from "@/lib/jsonld-script";
import { buildReportDataset } from "@/lib/report-jsonld";
import { readReportForId, readStoredReportForId } from "@/lib/report-source";
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
  const report = await readReportForId(id);

  if (!report) {
    return {
      title: { absolute: "Report not found · Site Behavior Lab" },
      description: "This Site Behavior Lab report is unavailable.",
      robots: { index: false, follow: false }
    };
  }

  const headline = buildReportHeadline(report);
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
  // The renderer below is the legacy v1 surface; producers still emit v1 only
  // (asserted in CI). When v2 storage writes begin, this page gains a
  // view-based renderer first (RFC 14.8 renderer slice).
  if (result.stored.schemaVersion !== 1) {
    throw new Error(`Report ${id} uses schemaVersion 2; this page cannot render it yet.`);
  }
  const report = result.stored.report;
  const dataset = buildReportDataset(report, {
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
