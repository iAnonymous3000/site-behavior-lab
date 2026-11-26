import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { SiteChrome } from "@/app/_components/site-chrome";
import { SiteHistoryViewV3 } from "@/app/_components/v3/SiteHistoryViewV3";
import styles from "@/app/v3/v3.module.css";
import { getV3RuntimeContext } from "@/lib/v3/runtime/store-context";
import "@/app/_design/fonts.css";
import "@/app/_design/tokens.css";
import "@/app/_design/base.css";
import "@/app/_design/components.css";
import "@/app/_design/pages.css";

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
  if (!normalized) return { title: "Site not found" };
  return {
    title: `${normalized} — Scan History & Temporal Diff`,
    description: `Historical multi-arm privacy scans and side-by-side regression diffs for ${normalized}.`
  };
}

export default async function V3SiteHistoryPage(context: {
  params: Promise<{ domain: string }>;
}) {
  const { domain } = await context.params;
  const normalized = safeDecodeDomain(domain);
  if (!normalized) notFound();

  const ctx = await getV3RuntimeContext();
  const history = await ctx.reportIndex.getSiteHistory(normalized, 30);

  return (
    <SiteChrome activePath="/directory/" shellClassName="da">
      <div className={styles.page}>
        <nav className="page-breadcrumbs" aria-label="Breadcrumb">
          <ol>
            <li><Link href="/">Home</Link></li>
            <li aria-hidden="true">/</li>
            <li><Link href="/directory/">Scanned sites</Link></li>
            <li aria-hidden="true">/</li>
            <li aria-current="page">{normalized}</li>
          </ol>
        </nav>
        <SiteHistoryViewV3 domain={normalized} history={history} />
      </div>
    </SiteChrome>
  );
}
