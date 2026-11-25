"use client";

import Link from "next/link";
import { useState } from "react";
import styles from "@/app/v3/v3.module.css";

export function V3Nav({ active }: { active: "explorer" | "catalog" | "report" | "site" }) {
  const [theme, setTheme] = useState<"auto" | "light" | "dark">("auto");

  function toggleTheme() {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("sbl-theme", next);
    } catch {}
  }

  return (
    <header className={styles.topbar}>
      <div className={styles.topbarInner}>
        <Link href="/v3/explorer" className={styles.brand}>
          <span>Site Behavior Lab</span>
          <span className={styles.brandBadge}>v3</span>
        </Link>
        <nav className={styles.navLinks} aria-label="Site Behavior Lab v3 navigation">
          <Link
            href="/v3/explorer"
            className={`${styles.navLink} ${active === "explorer" ? styles.navLinkActive : ""}`}
          >
            Explorer &amp; Live Scan
          </Link>
          <Link
            href="/v3/catalog"
            className={`${styles.navLink} ${active === "catalog" ? styles.navLinkActive : ""}`}
          >
            Vendor Catalog &amp; Simulator
          </Link>
          <Link href="/" className={styles.navLink}>
            Legacy Home
          </Link>
          <button type="button" onClick={toggleTheme} className={styles.btn} aria-label="Toggle color theme">
            {theme === "dark" ? "Light" : "Dark"}
          </button>
        </nav>
      </div>
    </header>
  );
}
