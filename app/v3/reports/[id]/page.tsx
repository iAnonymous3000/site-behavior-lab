import type { Metadata } from "next";
import { notFound } from "next/navigation";
import styles from "@/app/v3/v3.module.css";
import { ReportViewV3 } from "@/components/v3/ReportViewV3";
import { V3Nav } from "@/components/v3/V3Nav";
import { getV3RuntimeContext } from "@/lib/v3/runtime/store-context";
import { loadReportV3, V3_REPORT_ID_RE } from "@/lib/v3/storage/blob-store";

export const dynamic = "force-dynamic";

export async function generateMetadata(context: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await context.params;
  if (!V3_REPORT_ID_RE.test(id)) {
    return { title: "Report not found (v3)" };
  }
  const ctx = await getV3RuntimeContext();
  const report = await loadReportV3(ctx.blobStore, id);
  if (!report) {
    return { title: "Report not found (v3)" };
  }
  return {
    title: `${report.canonicalDomain} — v3 Privacy Report`,
    description: `Site Behavior Lab v3 report for ${report.canonicalDomain}: ${report.leadArm.summary.thirdPartyDomains} third-party domains, ${report.leadArm.summary.cookiesTotal} cookies, dark-pattern score ${report.leadArm.summary.darkPatternScore}/100.`
  };
}

export default async function V3ReportPage(context: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await context.params;
  if (!V3_REPORT_ID_RE.test(id)) notFound();

  const ctx = await getV3RuntimeContext();
  const report = await loadReportV3(ctx.blobStore, id);
  if (!report) notFound();

  return (
    <div className={styles.shell}>
      <V3Nav active="report" />
      <main className={styles.main}>
        <ReportViewV3 report={report} />
      </main>
    </div>
  );
}
