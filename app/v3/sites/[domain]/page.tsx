import type { Metadata } from "next";
import { notFound } from "next/navigation";
import styles from "@/app/v3/v3.module.css";
import { SiteHistoryViewV3 } from "@/app/_components/v3/SiteHistoryViewV3";
import { V3Nav } from "@/app/_components/v3/V3Nav";
import { getV3RuntimeContext } from "@/lib/v3/runtime/store-context";

export const dynamic = "force-dynamic";

function safeDecodeDomain(raw: string): string | null {
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  const normalized = decoded.trim().toLowerCase();
  if (!normalized || normalized.length > 253 || !/^[a-z0-9.-]+$/.test(normalized) || !normalized.includes(".")) {
    return null;
  }
  return normalized;
}

export async function generateMetadata(context: {
  params: Promise<{ domain: string }>;
}): Promise<Metadata> {
  const { domain } = await context.params;
  const normalized = safeDecodeDomain(domain);
  if (!normalized) return { title: "Site not found (v3)" };
  return {
    title: `${normalized} — Scan History & Temporal Diff (v3)`,
    description: `Historical v3 privacy scans and side-by-side regression diffs for ${normalized}.`
  };
}

export default async function V3SiteHistoryPage(context: {
  params: Promise<{ domain: string }>;
}) {
  const { domain } = await context.params;
  const normalized = safeDecodeDomain(domain);
  if (!normalized) notFound();

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
