"use client";

import { useEffect, useState } from "react";
import { staticAssetPath } from "@/app/client-runtime";
import styles from "@/app/v3/v3.module.css";

export function V3Nav({ active }: { active: "explorer" | "catalog" | "report" | "site" }) {
  const [theme, setTheme] = useState<"light" | "dark">("light");

  useEffect(() => {
    const current = document.documentElement.dataset.theme;
    if (current === "dark" || current === "light") {
      setTheme(current);
    } else if (window.matchMedia?.("(prefers-color-scheme: dark)").matches) {
      setTheme("dark");
    }
  }, []);

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
        <a href={staticAssetPath("/v3/explorer/")} className={styles.brand}>
          <span>Site Behavior Lab</span>
          <span className={styles.brandBadge}>v3</span>
        </a>
        <nav className={styles.navLinks} aria-label="Site Behavior Lab v3 navigation">
          <a
            href={staticAssetPath("/v3/explorer/")}
            className={`${styles.navLink} ${active === "explorer" ? styles.navLinkActive : ""}`}
          >
            Explorer &amp; Live Scan
          </a>
          <a
            href={staticAssetPath("/v3/catalog/")}
            className={`${styles.navLink} ${active === "catalog" ? styles.navLinkActive : ""}`}
          >
            Vendor Catalog &amp; Simulator
          </a>
          <a href={staticAssetPath("/")} className={styles.navLink}>
            Legacy Home
          </a>
          <button type="button" onClick={toggleTheme} className={styles.btn} aria-label="Toggle color theme">
            {theme === "dark" ? "Light" : "Dark"}
          </button>
        </nav>
      </div>
    </header>
  );
}
