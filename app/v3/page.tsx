import type { Metadata } from "next";
import styles from "@/app/v3/v3.module.css";
import { CorpusExplorerV3 } from "@/app/_components/v3/CorpusExplorerV3";
import { V3Nav } from "@/app/_components/v3/V3Nav";

export const metadata: Metadata = {
  title: "Explorer & Live Scanner (v3)",
  description:
    "Live concurrent CDP privacy scanner and D1-indexed searchable web behavior evidence corpus."
};

export default function V3HomePage() {
  return (
    <div className={styles.shell}>
      <V3Nav active="explorer" />
      <main className={styles.main}>
        <CorpusExplorerV3 />
      </main>
    </div>
  );
}
