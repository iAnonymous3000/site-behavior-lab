"use client";

import { FlaskConical, Loader2, Moon, Sun } from "lucide-react";
import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import { readLoadedReport } from "@/lib/client-report-reader";
import type { LoadedReport } from "@/lib/scan-report-view";
import { staticAssetPath } from "../../client-runtime";

const LazyReportRenderer = lazy(() =>
  import("../../_components/report-renderer").then((module) => ({ default: module.ReportRenderer }))
);

/**
 * Tiny permalink controller. Its RSC slots contain the useful compact summary
 * and trust receipt, so the initial document is complete without JavaScript.
 * The large report JSON, validators, charts, and raw tables cross the network
 * only after an explicit evidence-explorer request.
 */
export function SavedReportClient({
  id,
  evidenceHref,
  title,
  context,
  summary
}: {
  id: string;
  evidenceHref: string;
  title: string;
  context: ReactNode;
  summary: ReactNode;
}) {
  const [loaded, setLoaded] = useState<LoadedReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadEvidence() {
    if (loaded || loading) return;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(evidenceHref, { cache: "no-store" });
      if (!response.ok) throw new Error(`Report evidence returned HTTP ${response.status}.`);
      const read = await readLoadedReport((await response.json()) as unknown, "This saved report");
      if (!read.ok) throw new Error(read.message);
      if (read.loaded.wire.share?.id !== id) {
        throw new Error("The evidence response did not match this report page.");
      }
      setLoaded(read.loaded);
    } catch (readError) {
      setError(readError instanceof Error ? readError.message : "The full report evidence could not be opened.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <a className="skip-link" href="#report">Skip to results</a>
      <main className="app-shell report-page-shell">
        <header className="topbar">
          <a className="brand" href={staticAssetPath("/")} aria-label="Site Behavior Lab home">
            <span className="brand-mark"><FlaskConical size={22} aria-hidden="true" /></span>
            <div>
              <p className="eyebrow">Site Behavior Lab · Evidence</p>
              <h1>{title}</h1>
            </div>
          </a>
          <div className="topbar-actions">
            <a className="topbar-link" href={staticAssetPath("/directory/")}>Directory</a>
            <a className="secondary-button" href={staticAssetPath("/")}>Scan a site</a>
            <ThemeToggle />
          </div>
        </header>

        <div id="report">
          {context}
          {!loaded && summary}
          {!loaded && (
            <section className="report-evidence-loader" aria-labelledby="full-evidence-title">
              <div>
                <p className="eyebrow">Detailed evidence</p>
                <h2 id="full-evidence-title">Open the interactive evidence explorer</h2>
                <p>
                  Load request rows, domains, cookies, storage, browser signals, visit phases, charts, and CSV export
                  only when you need them. The versioned report JSON remains available above without this interface.
                </p>
              </div>
              <button className="primary-button" type="button" onClick={() => void loadEvidence()} disabled={loading}>
                {loading && <Loader2 className="spin" size={17} aria-hidden="true" />}
                {loading ? "Loading evidence…" : "Explore full evidence"}
              </button>
              {error && <p className="report-evidence-load-error" role="alert">{error} Try again or open the report JSON above.</p>}
            </section>
          )}
          {loaded && (
            <Suspense fallback={<p className="muted">Preparing the evidence explorer…</p>}>
              <LazyReportRenderer loaded={loaded} liveApiServesReportPages />
            </Suspense>
          )}
        </div>

        <footer className="app-footer">
          <span>
            Site Behavior Lab: open-source web transparency tooling. {" "}
            <a className="footer-link" href={staticAssetPath("/glossary/")}>Glossary</a>{" · "}
            <a className="footer-link" href={staticAssetPath("/methodology/")}>Methodology</a>{" · "}
            <a className="footer-link" href={staticAssetPath("/privacy/")}>Privacy</a>{" · "}
            <a className="footer-link" href={staticAssetPath("/catalog/")}>Catalog</a>{" · "}
            <a className="footer-link" href={staticAssetPath("/status/")}>Status</a>{" · "}
            <a className="footer-link" href={staticAssetPath("/security/")}>Security</a>{" · "}
            <a className="footer-link" href={staticAssetPath("/corrections/")}>Corrections</a>
          </span>
          <span>
            Reports use one completed automated visit per condition. Reproducible for this configuration, not a
            universal claim.
          </span>
        </footer>
      </main>
    </>
  );
}

function ThemeToggle() {
  const [theme, setTheme] = useState<"light" | "dark" | null>(null);

  useEffect(() => {
    const stored = document.documentElement.dataset.theme as "light" | "dark" | undefined;
    setTheme(stored ?? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
  }, []);

  function toggle() {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("sbl-theme", next); } catch { /* localStorage unavailable */ }
    setTheme(next);
  }

  return (
    <button className="icon-button" type="button" onClick={toggle} aria-label="Toggle colour theme">
      {theme === "dark" ? <Sun size={18} aria-hidden="true" /> : <Moon size={18} aria-hidden="true" />}
    </button>
  );
}
