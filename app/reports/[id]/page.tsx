import type { Metadata } from "next";
import { buildReportHeadline } from "@/lib/report-headline";
import { buildReportDataset } from "@/lib/report-jsonld";
import { readReportForId } from "@/lib/report-source";
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
  const report = await readReportForId(id);
  const dataset = report
    ? buildReportDataset(report, {
        url: `${siteBaseUrl()}/reports/${id}/`,
        jsonUrl: STATIC_EXPORT ? `${siteBaseUrl()}/reports/${id}.json` : `${siteOrigin()}/api/reports/${id}`
      })
    : null;

  return (
    <>
      {dataset && (
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(dataset) }} />
      )}
      <SavedReportClient id={id} />
    </>
  );
}
