import type { Metadata } from "next";
import Link from "next/link";
import { SiteChrome } from "@/app/_components/site-chrome";
import { CorpusExplorerV3 } from "@/app/_components/v3/CorpusExplorerV3";
import styles from "@/app/v3/v3.module.css";
import "@/app/_design/fonts.css";
import "@/app/_design/tokens.css";
import "@/app/_design/base.css";
import "@/app/_design/components.css";
import "@/app/_design/pages.css";

export const metadata: Metadata = {
  title: "Multi-Arm Scanner & Signal Index",
  description:
    "Concurrent multi-arm Chromium privacy scanner and searchable deep-signal web behavior corpus."
};

export default function V3HomePage() {
  return (
    <SiteChrome activePath="/" shellClassName="da">
      <div className={styles.page}>
        <nav className="page-breadcrumbs" aria-label="Breadcrumb">
          <ol>
            <li><Link href="/">Home</Link></li>
            <li aria-hidden="true">/</li>
            <li aria-current="page">Multi-arm scan &amp; signal index</li>
          </ol>
        </nav>
        <CorpusExplorerV3 />
      </div>
    </SiteChrome>
  );
}
