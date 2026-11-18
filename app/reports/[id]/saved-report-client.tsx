"use client";

import { Loader2 } from "lucide-react";
import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { readLoadedReport } from "@/lib/client-report-reader";
import {
  LatestClientOperation,
  fetchBytesResponseWithPolicy
} from "@/lib/client-fetch-policy";
import { parseDigestBoundReportJson } from "@/lib/client-report-integrity";
import { parseEvidenceHash } from "@/lib/report-evidence-navigation";
import { explorerSectionForHash } from "@/lib/report-section-ids";
import { claimRowsLink } from "@/lib/claim-rows-link";
import { BROWSER_PUBLIC_REPORT_JSON_MAX_BYTES } from "@/lib/report-resource-limits";
import type { LoadedReport } from "@/lib/scan-report-view";
import { SiteChrome } from "@/app/_components/site-chrome";

const LazyReportRenderer = lazy(() =>
  import("../../_components/report-renderer").then((module) => ({ default: module.ReportRenderer }))
);

/** How many frames a section link waits for its section to render after the explorer mounts (about two seconds). */
const SECTION_ARRIVAL_FRAMES = 120;

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
  pdfExportQuery,
  title,
  context,
  receipt,
  summary,
  visitSummary,
  siteHistoryHref,
  freshResult,
  summaryBenchmarkScope
}: {
  id: string;
  evidenceHref: string;
  expectedEvidenceSha256: string;
  /**
   * Binds the explorer's PDF control to this page's evidence and correction
   * context. Computed on the server (lib/report-pdf-export-query.ts), the same
   * producer as the receipt's links, so this client never restates the binding.
   */
  pdfExportQuery: string;
  title: string;
  context: ReactNode;
  /** Integrity and provenance, rendered after the evidence rather than before it. */
  receipt: ReactNode;
  summary: ReactNode;
  /**
   * The same server-built visit summary the summary slot's board renders after
   * its bottom line, handed to the explorer's board so it stays in place once
   * the explorer replaces the summary.
   */
  visitSummary: ReactNode;
  /**
   * The cookie card's Look closer target, built on the server: the explorer
   * has no corpus to count a site's reports from, so it renders the history
   * view exactly when the summary board did.
   */
  siteHistoryHref: string | null;
  /**
   * The cohort sentence of the bottom line this page's server built, null when
   * it does not rank: the explorer's Methodology block prints this, never a
   * sentence from findings the browser builds after fetching statistics.
   */
  summaryBenchmarkScope: string | null;
  /**
   * Whether the server read this report from the runtime share store, a live
   * scan's fresh result: the explorer's board then offers the same new visit
   * the summary board did, from the same value.
   */
  freshResult: boolean;
}) {
  const [loaded, setLoaded] = useState<LoadedReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const evidenceExplorerRef = useRef<HTMLElement | null>(null);
  const evidenceLoaderRef = useRef<HTMLElement | null>(null);
  const evidenceOperationRef = useRef<LatestClientOperation | null>(null);
  const evidenceIdentityRef = useRef({ id, evidenceHref, expectedEvidenceSha256 });
  const autoOpenedRef = useRef(false);
  const pendingSectionRef = useRef<string | null>(null);
  // The finding evidence link whose press loaded the evidence, if one did.
  const pressedClaimRef = useRef<HTMLAnchorElement | null>(null);
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
      autoOpenedRef.current = false;
      pressedClaimRef.current = null;
    }
    return () => evidenceOperation.cancel();
  }, [evidenceHref, evidenceOperation, expectedEvidenceSha256, id]);

  // The trigger disappears when the lazy explorer opens. Move focus to the
  // explorer, which starts with its evidence head, so keyboard and
  // screen-reader users do not fall back to the document body.
  // A finding's evidence link is the exception: its rows open under its own
  // claim, the link is still there, and focus stays on it.
  // A section link (#cookies, #request-evidence) lands on that section once
  // the explorer has rendered it, which happens after the lazy chunk mounts.
  useEffect(() => {
    if (pressedClaimRef.current || !loaded) return;
    const section = pendingSectionRef.current;
    pendingSectionRef.current = null;
    if (!section) {
      evidenceExplorerRef.current?.focus();
      return;
    }
    evidenceExplorerRef.current?.focus({ preventScroll: true });
    let frames = 0;
    let handle = 0;
    const land = () => {
      const target = document.getElementById(section);
      if (target) {
        target.scrollIntoView({ block: "start" });
        return;
      }
      // Bounded: a section this report does not render never appears.
      if ((frames += 1) < SECTION_ARRIVAL_FRAMES) handle = window.requestAnimationFrame(land);
    };
    handle = window.requestAnimationFrame(land);
    return () => window.cancelAnimationFrame(handle);
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
        return { ...read.loaded, canonicalEvidence: {
          wire: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
          sha256: expectedEvidenceSha256
        } };
      },
      {
        onStart: () => {
          setLoading(true);
          setError(null);
        },
        onSuccess: setLoaded,
        onError: (readError) => {
          setError(readError instanceof Error ? readError.message : "The full report evidence could not be opened.");
          // The button that held focus is still disabled at this point, so recover to
          // the section that now carries the error and the retry.
          window.requestAnimationFrame(() => evidenceLoaderRef.current?.focus());
        },
        onSettled: () => setLoading(false)
      }
    );
  }

  const loadEvidenceRef = useRef(loadEvidence);
  loadEvidenceRef.current = loadEvidence;

  // A finding's evidence link opens that finding's rows under its claim, and
  // the rows are the explorer's. Nothing is loaded before the first press:
  // the press loads the evidence, and the explorer then opens that link's
  // rows (report-renderer.tsx, which handles every later press itself).
  useEffect(() => {
    if (loaded) return;
    function loadForClaim(event: MouseEvent) {
      const pressed = claimRowsLink(event.target);
      if (!pressed || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      pressedClaimRef.current = pressed.anchor;
      void loadEvidenceRef.current();
    }
    document.addEventListener("click", loadForClaim, true);
    return () => document.removeEventListener("click", loadForClaim, true);
  }, [loaded]);

  // "#evidence=..." links are minted by the explorer itself and documented as
  // reload-free, but the code that reads the fragment ships with the lazy
  // renderer, which on this page mounts only when someone presses the button
  // below. So a shared or reloaded evidence link used to do nothing at all: no
  // table, no filter, not even a scroll, and no hint the fragment meant
  // anything. Opening the explorer hands the fragment to its existing handler.
  useEffect(() => {
    if (loaded) return;
    // A section anchor the explorer alone renders is the same case: copied out
    // of the address bar or reloaded, it named a section that did not exist yet.
    const openWhenEvidenceLinked = () => {
      if (autoOpenedRef.current) return;
      const section = explorerSectionForHash(window.location.hash);
      if (!parseEvidenceHash(window.location.hash) && !section) return;
      autoOpenedRef.current = true;
      pendingSectionRef.current = section;
      void loadEvidenceRef.current();
    };
    openWhenEvidenceLinked();
    // A fragment can also arrive after mount, by editing the address bar or
    // following a link to this same page.
    window.addEventListener("hashchange", openWhenEvidenceLinked);
    return () => window.removeEventListener("hashchange", openWhenEvidenceLinked);
  }, [loaded]);

  return (
    <SiteChrome
      /* The title names the main landmark rather than being painted a second
         time. The former shell rendered it as an <h1> in the top bar while the
         headline banner repeated the same sentence verbatim two blocks lower;
         the visible heading is now the site, rendered once in the context. */
      mainId="report"
      mainProps={{ "aria-label": title, tabIndex: -1 }}
      /* "da" opts this route into the direction A stylesheet (app/_design/). */
      /* "is-evidence-open": the page's own excerpt of the domain table and
         its visit-order line give way to the explorer's full table and its
         comparison section, which say the same thing (report.css). */
      shellClassName={`report-page-shell da${loaded ? " is-evidence-open" : ""}`}
    >
          {context}
          {/* The report stays when the explorer opens: the evidence opens
              under the findings, and nothing above it is replaced. */}
          {summary}
          {!loaded && (
            <section
              className="report-evidence-loader"
              aria-labelledby="full-evidence-title"
              ref={evidenceLoaderRef}
              tabIndex={-1}
            >
              <div>
                <p className="eyebrow">Raw evidence</p>
                <h2 id="full-evidence-title">Open the interactive evidence explorer</h2>
                <p>
                  The findings above are built from the stored report. Load the request rows, domains, cookies,
                  storage keys, browser signals, visit phases, charts and CSV export when you want to check them; the
                  versioned report JSON is always available below without this interface.
                </p>
              </div>
              <button className="primary-button" type="button" onClick={() => void loadEvidence()} disabled={loading}>
                {loading && <Loader2 className="spin" size={17} aria-hidden="true" />}
                {loading ? "Loading evidence…" : "Explore full evidence"}
              </button>
              {/* The report JSON this fetches is allowed up to 8 MB, so the disabled
                  button blurs a keyboard user to <body> for the whole wait with nothing
                  announced. Name the wait, then land focus back on this section if it
                  fails, since the success path already relocates to the explorer. */}
              <p className="visually-hidden" role="status" aria-live="polite">
                {loading ? "Loading report evidence." : ""}
              </p>
              {error && <p className="report-evidence-load-error" role="alert">{error} Try again or open the report JSON below.</p>}
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
                <LazyReportRenderer loaded={loaded} liveApiServesReportPages pdfExportQuery={pdfExportQuery}
                  visitSummary={visitSummary} siteHistoryHref={siteHistoryHref} freshResult={freshResult} summaryBenchmarkScope={summaryBenchmarkScope} evidenceOnly
                  pressedClaim={pressedClaimRef.current} />
              </Suspense>
            </section>
          )}
          {/* Provenance follows the evidence it certifies. It used to be the
              third block on the page, ahead of the finding it is a receipt
              for. */}
          {receipt}
    </SiteChrome>
  );
}
