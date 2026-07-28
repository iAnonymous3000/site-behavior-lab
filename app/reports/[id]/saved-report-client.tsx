"use client";

import { FlaskConical, Loader2 } from "lucide-react";
import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { readLoadedReport } from "@/lib/client-report-reader";
import {
  LatestClientOperation,
  fetchBytesResponseWithPolicy
} from "@/lib/client-fetch-policy";
import { parseDigestBoundReportJson } from "@/lib/client-report-integrity";
import { BROWSER_PUBLIC_REPORT_JSON_MAX_BYTES } from "@/lib/report-resource-limits";
import type { LoadedReport } from "@/lib/scan-report-view";
import { ThemeToggle } from "@/app/_components/theme-toggle";
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
  expectedEvidenceSha256,
  title,
  context,
  summary
}: {
  id: string;
  evidenceHref: string;
  expectedEvidenceSha256: string;
  title: string;
  context: ReactNode;
  summary: ReactNode;
}) {
  const [loaded, setLoaded] = useState<LoadedReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const evidenceExplorerRef = useRef<HTMLElement | null>(null);
  const evidenceOperationRef = useRef<LatestClientOperation | null>(null);
  const evidenceIdentityRef = useRef({ id, evidenceHref, expectedEvidenceSha256 });
  if (!evidenceOperationRef.current) evidenceOperationRef.current = new LatestClientOperation();
  const evidenceOperation = evidenceOperationRef.current;

  // A client-side route transition can reuse this controller. Invalidate the
  // previous report's read immediately, and abort again on unmount.
  useEffect(() => {
    const identityChanged =
      evidenceIdentityRef.current.id !== id || evidenceIdentityRef.current.evidenceHref !== evidenceHref;
    const digestChanged = evidenceIdentityRef.current.expectedEvidenceSha256 !== expectedEvidenceSha256;
    evidenceIdentityRef.current = { id, evidenceHref, expectedEvidenceSha256 };
    if (identityChanged || digestChanged) {
      setLoaded(null);
      setLoading(false);
      setError(null);
    }
    return () => evidenceOperation.cancel();
  }, [evidenceHref, evidenceOperation, expectedEvidenceSha256, id]);

  // The trigger disappears when the lazy explorer opens. Move focus to the
  // replacement region so keyboard and screen-reader users do not fall back
  // to the document body.
  useEffect(() => {
    if (loaded) evidenceExplorerRef.current?.focus();
  }, [loaded]);

  async function loadEvidence() {
    if (loaded) return;
    await evidenceOperation.run(
      async (signal) => {
        const { bytes } = await fetchBytesResponseWithPolicy(evidenceHref, { cache: "no-store" }, {
          label: "Report evidence",
          maxBytes: BROWSER_PUBLIC_REPORT_JSON_MAX_BYTES,
          signal,
          httpError: (response) => new Error(`Report evidence returned HTTP ${response.status}.`)
        });
        const payload = await parseDigestBoundReportJson(
          bytes,
          expectedEvidenceSha256,
          "Report evidence"
        );
        const read = await readLoadedReport(payload, "This saved report");
        if (!read.ok) throw new Error(read.message);
        if (read.loaded.wire.share?.id !== id) {
          throw new Error("The evidence response did not match this report page.");
        }
        return read.loaded;
      },
      {
        onStart: () => {
          setLoading(true);
          setError(null);
        },
        onSuccess: setLoaded,
        onError: (readError) => {
          setError(readError instanceof Error ? readError.message : "The full report evidence could not be opened.");
        },
        onSettled: () => setLoading(false)
      }
    );
  }

  return (
    <>
      <a className="skip-link" href="#report">Skip to results</a>
      <div className="app-shell report-page-shell">
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

        <main id="report" tabIndex={-1}>
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
            <section
              aria-label="Interactive evidence explorer"
              className="report-focus-target"
              ref={evidenceExplorerRef}
              tabIndex={-1}
            >
              <Suspense fallback={<p className="muted">Preparing the evidence explorer…</p>}>
                <LazyReportRenderer loaded={loaded} liveApiServesReportPages />
              </Suspense>
            </section>
          )}
        </main>

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
      </div>
    </>
  );
}

