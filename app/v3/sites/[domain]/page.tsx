import type { Metadata } from "next";
import { notFound } from "next/navigation";
import styles from "@/app/v3/v3.module.css";
import { SiteHistoryViewV3 } from "@/components/v3/SiteHistoryViewV3";
import { V3Nav } from "@/components/v3/V3Nav";
import { getV3RuntimeContext } from "@/lib/v3/runtime/store-context";

export const dynamic = "force-dynamic";

export async function generateMetadata(context: {
  params: Promise<{ domain: string }>;
}): Promise<Metadata> {
  const { domain } = await context.params;
  const decoded = decodeURIComponent(domain).toLowerCase();
  return {
    title: `${decoded} — Scan History & Temporal Diff (v3)`,
    description: `Historical v3 privacy scans and side-by-side regression diffs for ${decoded}.`
  };
}

export default async function V3SiteHistoryPage(context: {
  params: Promise<{ domain: string }>;
}) {
  const { domain } = await context.params;
  const normalized = decodeURIComponent(domain).trim().toLowerCase();
  if (!normalized || normalized.includes("/") || normalized.includes("..")) {
    notFound();
  }

  const ctx = await getV3RuntimeContext();
  const history = await ctx.reportIndex.getSiteHistory(normalized, 50);

  return (
    <div className={styles.shell}>
      <V3Nav active="site" />
      <main className={styles.main}>
        <SiteHistoryViewV3 domain={normalized} history={history} />
      </main>
    </div>
  );
}
