import type { Metadata } from "next";
import Link from "next/link";
import { SiteChrome } from "@/app/_components/site-chrome";
import { CatalogExplorerV3 } from "@/app/_components/v3/CatalogExplorerV3";
import styles from "@/app/v3/v3.module.css";
import { getCatalogDirectoryV3 } from "@/lib/v3/dev-mode";
import "@/app/_design/fonts.css";
import "@/app/_design/tokens.css";
import "@/app/_design/base.css";
import "@/app/_design/components.css";
import "@/app/_design/pages.css";

export const metadata: Metadata = {
  title: "Corporate Ownership & Block-Impact Simulator",
  description:
    "Browse 180+ global tracking and infrastructure entities across US, EU, UK, APAC, CN, RU, and LATAM, run reverse corpus lookups, and simulate blocking vendor footprints."
};

export default function V3CatalogPage() {
  const { stats, entries, parentOrgs } = getCatalogDirectoryV3();

  return (
    <SiteChrome activePath="/catalog/" shellClassName="da">
      <div className={styles.page}>
        <nav className="page-breadcrumbs" aria-label="Breadcrumb">
          <ol>
            <li><Link href="/">Home</Link></li>
            <li aria-hidden="true">/</li>
            <li><Link href="/catalog/">Catalog</Link></li>
            <li aria-hidden="true">/</li>
            <li aria-current="page">Corporate ownership &amp; block simulator</li>
          </ol>
        </nav>
        <CatalogExplorerV3
          entries={entries}
          parentOrgs={parentOrgs}
          totalDomains={stats.domains}
        />
      </div>
    </SiteChrome>
  );
}
