import type { Metadata } from "next";
import styles from "@/app/v3/v3.module.css";
import { CatalogExplorerV3 } from "@/app/_components/v3/CatalogExplorerV3";
import { V3Nav } from "@/app/_components/v3/V3Nav";
import { getCatalogDirectoryV3 } from "@/lib/v3/dev-mode";

export const metadata: Metadata = {
  title: "Global Vendor Catalog & Block Impact Simulator (v3)",
  description:
    "Browse 150+ global tracking & infrastructure entities across US, EU, UK, APAC, CN, RU, and LATAM, run reverse corpus lookups, and simulate blocking vendor footprints."
};

export default function V3CatalogPage() {
  const { stats, entries, parentOrgs } = getCatalogDirectoryV3();

  return (
    <div className={styles.shell}>
      <V3Nav active="catalog" />
      <main className={styles.main}>
        <CatalogExplorerV3
          entries={entries}
          parentOrgs={parentOrgs}
          totalDomains={stats.domains}
        />
      </main>
    </div>
  );
}
