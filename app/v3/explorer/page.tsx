import type { Metadata } from "next";
import styles from "@/app/v3/v3.module.css";
import { CorpusExplorerV3 } from "@/app/_components/v3/CorpusExplorerV3";
import { V3Nav } from "@/app/_components/v3/V3Nav";

export const metadata: Metadata = {
  title: "Corpus Explorer & Live Scanner (v3)",
  description:
    "Faceted search across Site Behavior Lab v3 web privacy scans with live concurrent CDP scanning."
};

export default function V3ExplorerPage() {
  return (
    <div className={styles.shell}>
      <V3Nav active="explorer" />
      <main className={styles.main}>
        <CorpusExplorerV3 />
      </main>
    </div>
  );
}
