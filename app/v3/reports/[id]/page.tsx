import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";
import { staticAssetPath } from "@/app/client-runtime";
import { SiteChrome } from "@/app/_components/site-chrome";
import { ReportViewV3 } from "@/app/_components/v3/ReportViewV3";
import styles from "@/app/v3/v3.module.css";
import { getV3RuntimeContext } from "@/lib/v3/runtime/store-context";
import { loadReportV3, V3_REPORT_ID_RE } from "@/lib/v3/storage/blob-store";
import "@/app/_design/fonts.css";
import "@/app/_design/tokens.css";
import "@/app/_design/base.css";
import "@/app/_design/components.css";
import "@/app/_design/pages.css";

export const dynamic = "force-dynamic";

const loadCachedReportV3 = cache(async (id: string) => {
  if (!V3_REPORT_ID_RE.test(id)) return null;
  const ctx = await getV3RuntimeContext();
  const [report, meta] = await Promise.all([
    loadReportV3(ctx.blobStore, id),
    ctx.reportIndex.getReportMeta(id)
  ]);
  if (!report || (meta?.expiresAt && Date.parse(meta.expiresAt) <= Date.now())) {
    return null;
  }
  return report;
});

export async function generateMetadata(context: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await context.params;
  const report = await loadCachedReportV3(id);
  if (!report) {
    return { title: "Report not found", robots: { index: false, follow: false } };
  }
  return {
    title: `${report.canonicalDomain} — Multi-Arm Behavior Report`,
    description: `Site Behavior Lab multi-arm report for ${report.canonicalDomain}: ${report.leadArm.summary.thirdPartyDomains} third-party domains, ${report.leadArm.summary.cookiesTotal} cookies, dark-pattern score ${report.leadArm.summary.darkPatternScore}/100.`,
    robots: { index: false, follow: false, noarchive: true }
  };
}

export default async function V3ReportPage(context: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await context.params;
  const report = await loadCachedReportV3(id);
  if (!report) notFound();

  return (
    <SiteChrome activePath="/directory/" shellClassName="da">
      <div className={styles.page}>
        <nav className="page-breadcrumbs" aria-label="Breadcrumb">
          <ol>
            <li><a href={staticAssetPath("/")}>Home</a></li>
            <li aria-hidden="true">/</li>
            <li><a href={staticAssetPath("/directory/")}>Scanned sites</a></li>
            <li aria-hidden="true">/</li>
            <li aria-current="page">{report.canonicalDomain}</li>
          </ol>
        </nav>
        <ReportViewV3 report={report} />
      </div>
    </SiteChrome>
  );
}
