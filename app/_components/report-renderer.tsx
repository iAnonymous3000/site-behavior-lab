"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { STATIC_BASE_PATH, clientReportRuntime } from "../client-runtime";
import { CausalityGraph } from "./causality-graph";
import { ComparisonPanel } from "./comparison-panel";
import { ConnectionInspectionPanel } from "./connection-inspection-panel";
import { FindingsBoard, HeadlineBanner, HeadlinePostActions, MetricGrid, TrafficViz, useReportFindings } from "./report-overview";
import { ReportHeader } from "./report-header";
import { ReportSectionNav, type ReportSection } from "./report-section-nav";
import { ScrollCheckPanel } from "./scroll-check-panel";
import {
  ClaimRows,
  CookieList,
  DomainTable,
  FingerprintList,
  PixelEventsList,
  RequestTable,
  StorageList,
  TopThirdParties,
  Warnings
} from "./report-tables";
import { PrintCompleteProvider, PrintVisitProvider, useEvidenceIds } from "./print-mode";
import { VisitPhasesAndStateChanges } from "./visit-phases-and-state-changes";
import { shareForLoadedReport } from "@/lib/client-report-reader";
import { consentChoiceLabel } from "@/lib/consent-interaction";
import { requestLogRecordingState, requestLogToCsv } from "@/lib/csv-export";
import { EARLIER_RESULT_LINK } from "@/lib/finding-look-closer";
import { consentVerificationSummary } from "@/lib/report-consent-copy";
import { HEADLINE_KICKER, buildReportHeadline } from "@/lib/report-headline";
import { buildReportFacts, type RunFacts } from "@/lib/report-facts";
import { claimRowsLink } from "@/lib/claim-rows-link";
import { parseEvidenceHash, type EvidenceTarget } from "@/lib/report-evidence-navigation";
import { locateReport } from "@/lib/report-locator";
import { reportNewVisitFrom, reportNewVisitTarget } from "@/lib/report-rescan-targets";
import type { RequestInspectionContext } from "@/lib/request-inspection-link";
import type { ShownConnectionInspection } from "@/lib/connection-inspection-result";
import { scrollCheckReportNote } from "@/lib/scroll-check-copy";
import type { ShownScrollCheck } from "@/lib/scroll-check-result";
import {
  displayableScreenshot,
  gpcRunMeasurement
} from "@/lib/report-insights";
import type { LoadedReport } from "@/lib/scan-report-view";
import { degradedRunNotice, runQualitySummary } from "@/lib/scan-report-censorship";
import {
  comparisonArmViews,
  schemaProvenanceLabel,
  type ReportView,
  type RunView
} from "@/lib/scan-report-views";
import { displayHost, plural } from "@/lib/text-format";
import { publishedReportCorrections } from "@/lib/published-report-corrections";
import { comparisonVisitOrderLine } from "@/lib/comparison-visit-order";
import { buildRequestFigure } from "@/lib/request-figure";
import { notMeasuredLeads } from "@/lib/visit-limits";
import { ReportRecord, schemaNotePlacement } from "@/app/_design/record-block";
import { ReportPageSummary } from "@/app/_design/report-summary";
import { RequestFigure } from "@/app/_design/request-figure";
import { groupReportWarnings, reportWarningCount } from "@/lib/report-warnings";
import { methodologyBenchmarkScope } from "@/lib/report-findings";

/**
 * The evidence-heavy half of the product. The homepage imports this module
 * lazily only after a scan/import has produced a report, while report
 * permalinks import it only after the visitor asks to explore raw evidence.
 * Keeping this boundary independent prevents scanner, archive, watch, and
 * importer code from entering report-page bundles and prevents report tables
 * from entering the homepage's initial route chunk.
 */
export function ReportRenderer({
  loaded,
  liveApiServesReportPages,
  pdfExportQuery,
  printComplete = false,
  printGuide,
  visitSummary,
  siteHistoryHref = null,
  freshResult = false,
  evidenceOnly = false,
  pressedClaim = null,
  earlierResultId = null,
  inspection = null,
  scrollCheck = null,
  summaryBenchmarkScope
}: {
  loaded: LoadedReport;
  liveApiServesReportPages: boolean;
  /** Server-computed evidence and correction binding for the header's PDF control; saved pages only. */
  pdfExportQuery?: string;
  /**
   * Render every retained row and open every disclosure, for a page that will
   * be printed. Defaults false so the interactive route is byte-identical to
   * what it renders today.
   */
  printComplete?: boolean;
  printGuide?: ReactNode;
  /**
   * What was checked and what the visit could not see, built by the report
   * page on the server and rendered by the board directly after its bottom
   * line. Absent for a live scan, which has no stored report to summarize.
   */
  visitSummary?: ReactNode;
  /**
   * The cookie card's Look closer target, built by the report page on the
   * server (lib/report-site-history.ts). Absent on the homepage, whose result
   * has no site history; the board renders no view at all on paper.
   */
  siteHistoryHref?: string | null;
  /**
   * Whether this is a fresh result: the homepage's own live scan, or that
   * scan's runtime share permalink, whose server decides it and renders its
   * summary board from the same value. Only a fresh result's cards offer a
   * new visit; a committed report, an opened file and an archive comparison
   * leave it false.
   */
  freshResult?: boolean;
  /**
   * True on a report page, whose own summary stays above the explorer: the
   * headline and the findings are on the page already, so the explorer does
   * not render them a second time and opens at its evidence head.
   */
  evidenceOnly?: boolean;
  /**
   * The finding evidence link whose press loaded this explorer, on a report
   * page: its rows open under its claim as soon as the explorer mounts.
   */
  pressedClaim?: HTMLAnchorElement | null;
  /**
   * The share report id of the earlier result whose new visit opened this
   * scan, handed over by the homepage for its own result of a scan that
   * started with that link's arrival intact (app/_hooks/use-scan-runtime.ts),
   * and only while that result is shown. A permalink, its explorer and the
   * printable route pass none.
   */
  earlierResultId?: string | null;
  /**
   * What an inspection visit recorded, handed over by the homepage for the
   * result its own submit received (app/_hooks/use-scan-runtime.ts), and
   * only while that result is shown. A permalink, its explorer and the
   * printable route pass none, so a reload or a share shows no panel.
   */
  inspection?: ShownConnectionInspection | null;
  /**
   * What a "Check after scrolling" visit recorded, handed over by the
   * homepage for the result its own submit received, and only while that
   * result is shown. Nothing from that visit is saved, so its result offers
   * no export and never prints; a permalink, its explorer and the printable
   * route pass none.
   */
  scrollCheck?: ShownScrollCheck | null;
  /**
   * The cohort sentence of the bottom line the server built for this
   * report's summary (lib/report-findings.ts bottomLineBenchmarkScope), null
   * when that bottom line does not rank. A permalink's explorer and the
   * printed route pass it, so the Methodology block and the bottom line come
   * from one source. The homepage's own result has no server summary and
   * passes none: its block reads the findings built here.
   */
  summaryBenchmarkScope?: string | null;
}) {
  useEffect(() => {
    if (!printComplete) return;
    document.documentElement.dataset.reportPrintReady = "true";
    return () => { delete document.documentElement.dataset.reportPrintReady; };
  }, [printComplete]);
  const reportView = loaded.view;
  const reportFacts = useMemo(() => buildReportFacts(reportView), [reportView]);
  const headline = useMemo(
    () => buildReportHeadline(reportView, reportFacts),
    [reportFacts, reportView]
  );
  const { evidenceArm, findings } = useReportFindings(reportView, reportFacts, headline);
  const newVisitTarget = reportNewVisitTarget(reportView, freshResult);
  const newVisitFrom = reportNewVisitFrom(reportView, freshResult);
  // A fresh result's request log offers "Inspect this connection" on its
  // third-party rows, for the same page a new visit would visit again, and
  // only from a scanner whose results can carry an inspection (r2). Never on
  // paper.
  const requestInspection: RequestInspectionContext | null =
    !printComplete && newVisitTarget && (loaded.source === "v2-r2-ephemeral" || loaded.source === "v2-r2-public")
      ? { page: newVisitTarget, from: newVisitFrom, basePath: STATIC_BASE_PATH }
      : null;
  // The earlier result was a fresh one, so its share lives wherever this
  // runtime reaches a freshly produced report: this origin on the Node app,
  // the scan API's own origin behind a static build. Where that API serves
  // no report pages there is nothing to link to, and nothing shows.
  const earlierResultHref = earlierResultId
    ? locateReport(earlierResultId, { ...clientReportRuntime(), liveApiServesReportPages }).pagePath
    : null;
  // The inspection's link named the fresh result it was offered on, whose
  // share resolves the same way.
  const inspectedFromHref =
    inspection && inspection.from && !printComplete
      ? locateReport(inspection.from, { ...clientReportRuntime(), liveApiServesReportPages }).pagePath
      : null;
  // So did a check's.
  const checkedFromHref =
    scrollCheck && scrollCheck.from && !printComplete
      ? locateReport(scrollCheck.from, { ...clientReportRuntime(), liveApiServesReportPages }).pagePath
      : null;
  const benchmarkScope = methodologyBenchmarkScope(summaryBenchmarkScope, findings);
  const primaryRun = reportFacts.display.run;
  const arms = comparisonArmViews(reportView);
  const [selectedArm, setSelectedArm] = useState<"baseline" | "variant" | null>(null);

  useEffect(() => {
    setSelectedArm(null);
  }, [loaded]);

  useEffect(() => {
    function selectLinkedEvidenceArm(hash: string) {
      const target = parseEvidenceHash(hash);
      if (target?.arm) setSelectedArm(target.arm);
    }
    // The fragment the navigation went to, not location.hash, which an
    // earlier listener can already have replaced (useEvidenceTarget in
    // report-tables.tsx says which one).
    const selectNavigatedLinkedEvidenceArm = (event: HashChangeEvent) =>
      selectLinkedEvidenceArm(new URL(event.newURL).hash);
    function selectRepeatedLinkedEvidenceArm(event: MouseEvent) {
      if (!(event.target instanceof Element)) return;
      const anchor = event.target.closest<HTMLAnchorElement>("a");
      const href = anchor?.getAttribute("href") ?? "";
      if (!href.startsWith("#evidence=") || anchor?.hash !== window.location.hash) return;
      selectLinkedEvidenceArm(anchor.hash);
    }

    selectLinkedEvidenceArm(window.location.hash);
    window.addEventListener("hashchange", selectNavigatedLinkedEvidenceArm);
    document.addEventListener("click", selectRepeatedLinkedEvidenceArm);
    return () => {
      window.removeEventListener("hashchange", selectNavigatedLinkedEvidenceArm);
      document.removeEventListener("click", selectRepeatedLinkedEvidenceArm);
    };
  }, [loaded]);

  // A finding's rows under its claim. Pressing a finding's evidence link
  // opens the first rows the request log shows under that link's filter,
  // directly under the finding; pressing it again closes them and leaves focus
  // on the link. The link's own navigation to the log does not happen: the
  // rows carry a link to the whole log. Never on paper.
  type OpenClaim = { anchor: HTMLAnchorElement; target: EvidenceTarget; host: HTMLElement };
  const [claim, setClaim] = useState<OpenClaim | null>(null);
  // The open claim's nodes, for the handlers: what they add to the page they
  // remove themselves, never from inside a state update.
  const openClaimRef = useRef<OpenClaim | null>(null);
  useEffect(() => {
    if (printComplete) return;
    function close() {
      const open = openClaimRef.current;
      if (!open) return;
      open.host.remove();
      open.anchor.removeAttribute("aria-expanded");
      openClaimRef.current = null;
      setClaim(null);
    }
    function open(anchor: HTMLAnchorElement, target: EvidenceTarget) {
      const card = anchor.closest(".finding-card");
      if (!card) return;
      close();
      const host = document.createElement("div");
      host.className = "claim-rows-host";
      // After the card, never inside it: the card lays out its own last child.
      // (insertAdjacentElement, not after(): the Workers types the investigation
      // entries bring into the type check give Element.after another signature.)
      card.insertAdjacentElement("afterend", host);
      anchor.setAttribute("aria-expanded", "true");
      openClaimRef.current = { anchor, target, host };
      setClaim(openClaimRef.current);
    }
    function toggle(event: MouseEvent) {
      const pressed = claimRowsLink(event.target);
      if (!pressed || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      // The log's own listeners must not read this press as a navigation to it.
      event.stopPropagation();
      if (openClaimRef.current?.anchor === pressed.anchor) {
        close();
        pressed.anchor.focus();
        return;
      }
      open(pressed.anchor, pressed.target);
    }
    const initial = pressedClaim ? claimRowsLink(pressedClaim) : null;
    if (initial) open(initial.anchor, initial.target);
    document.addEventListener("click", toggle, true);
    return () => {
      document.removeEventListener("click", toggle, true);
      close();
    };
  }, [loaded, pressedClaim, printComplete]);
  const claimFacts = claim ? (claim.target.arm && reportFacts.arms ? reportFacts.arms[claim.target.arm] : reportFacts.display) : null;

  // When a result arrives on a page of its own making (the homepage), focus
  // goes to the first heading the result shows: an inspection's or a check's
  // panel when one leads it, otherwise the site. The homepage first focuses
  // its results region, which holds focus while this renderer loads; this
  // runs a frame later, after that, so the heading keeps it. A report page
  // focuses its own explorer, and paper has no focus.
  useEffect(() => {
    if (printComplete || evidenceOnly) return;
    const frame = window.requestAnimationFrame(() => {
      const heading = document.querySelector<HTMLElement>(
        "#report :is(.connection-inspection, .scroll-check) h2, #report .result-page > .report-identity h2"
      );
      if (!heading) return;
      if (!heading.hasAttribute("tabindex")) heading.setAttribute("tabindex", "-1");
      heading.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [loaded, printComplete, evidenceOnly]);

  const headlineFocusArm = arms ? headline.focusArm ?? null : null;
  const defaultArm: "baseline" | "variant" =
    headlineFocusArm ?? (reportView.comparison?.temporalPair ? "variant" : "baseline");
  const displayedArmLabel: "baseline" | "variant" = selectedArm ?? defaultArm;
  const displayedFacts =
    arms && reportFacts.arms ? reportFacts.arms[displayedArmLabel] : reportFacts.display;
  const displayedRun = displayedFacts.run;
  const [exportError, setExportError] = useState<string | null>(null);
  async function exportWire() {
    const { reportWireForDownload } = await import("@/lib/client-report-export");
    return reportWireForDownload(loaded, { ...clientReportRuntime(), liveApiServesReportPages });
  }
  async function exportWithFeedback(operation: () => Promise<void>) {
    setExportError(null);
    try { await operation(); } catch (error) {
      setExportError(error instanceof Error ? error.message : "The report could not be exported. Please retry.");
    }
  }
  async function downloadReport() {
    const wire = await exportWire();
    const corrections = publishedReportCorrections(reportView.reportId);
    if (corrections.subjectEvents.length || corrections.replacementEvents.length) {
      const { reportExportBundle } = await import("@/lib/report-export-bundle");
      const bundle = reportExportBundle(wire, JSON.stringify(corrections, null, 2));
      downloadBlob(new Blob([bundle as Uint8Array<ArrayBuffer>], {type: "application/zip"}), `site-behavior-lab-${safeFilenamePart(primaryRun.domain)}-evidence.zip`);
      return;
    }
    const blob = new Blob([wire], {
      type: "application/json"
    });
    downloadBlob(blob, `site-behavior-lab-${safeFilenamePart(primaryRun.domain)}.json`);
  }

  async function downloadCsv() {
    const { reportExportBundle } = await import("@/lib/report-export-bundle");
    const corrections = publishedReportCorrections(reportView.reportId);
    const csv = requestLogToCsv(displayedRun.evidence.requests, requestLogRecordingState(displayedRun), corrections.subjectEvents);
    const bundle = reportExportBundle(
      await exportWire(),
      JSON.stringify(corrections, null, 2),
      { csv, arm: arms ? displayedArmLabel : null }
    );
    const armPart = arms ? `-${safeFilenamePart(armDisplayLabel(reportView, displayedArmLabel))}` : "";
    downloadBlob(
      new Blob([bundle as Uint8Array<ArrayBuffer>], { type: "application/zip" }),
      `site-behavior-lab-${safeFilenamePart(displayedRun.domain)}${armPart}-requests.zip`
    );
  }

  // In the order the screen shows the sections. ReportSectionNav drops any of
  // these whose section this report did not render, so the list can stay
  // declarative without shipping an anchor that scrolls nowhere.
  // The counts are the ones the sections themselves state for the visit shown.
  const count = (value: number) => value.toLocaleString("en-US");
  const shown = displayedRun.evidence;
  const limitCount = reportWarningCount(groupReportWarnings(reportView.warnings, reportView.comparison?.runLabels ?? null));
  const sections: ReportSection[] = [
    { id: "findings", label: "Findings" },
    { id: "comparison", label: "Comparison" },
    { id: "numbers", label: "Numbers" },
    { id: "traffic", label: "Traffic" },
    { id: "visit-phases", label: "Visit phases" },
    { id: "domain-evidence", label: "Domains", count: count(shown.domains.length) },
    { id: "request-evidence", label: "Request log", count: count(shown.requests.length) },
    { id: "third-parties", label: "Third parties" },
    { id: "cookies", label: "Cookies", ...(shown.cookies.length > 0 ? { count: count(shown.cookies.length) } : {}) },
    { id: "storage", label: "Storage", ...(shown.storage.length > 0 ? { count: count(shown.storage.length) } : {}) },
    { id: "signals", label: "Signals" },
    { id: "pixels", label: "Pixels" },
    { id: "causal-map", label: "Attribution" },
    { id: "measurement-limits", label: "Limits", ...(limitCount > 0 ? { count: count(limitCount) } : {}) },
    { id: "conditions", label: "Conditions" }
  ];

  // A result with no page of its own (a scan's result on the homepage, a
  // report opened from a file) reads as a report page does, in place: the
  // site as the title, the finding sentence and the limits on the whole
  // report, the request figure, then the findings with their index. The
  // same components the report page renders on the server, given the same
  // values; a report page passes evidenceOnly and renders its own.
  // Where this comparison came from: a link back to the earlier result and
  // why this pair cannot speak for the card that offered it. Outside the
  // verdict: it leads the result, in the rows a report page gives its
  // breadcrumb, and on paper it follows the header.
  const earlierResult = (
    <>
          {earlierResultHref && (
            <div className="earlier-result-note">
              <a className="earlier-result-link" href={earlierResultHref} aria-describedby="earlier-result-sentence">
                {EARLIER_RESULT_LINK.label}
              </a>
              <p id="earlier-result-sentence">{EARLIER_RESULT_LINK.sentence}</p>
            </div>
          )}
    </>
  );
  const resultSummary = printComplete || evidenceOnly ? null : (
    <div className="result-page">
      {earlierResult}
      <ReportRecord view={reportView} siteHeading="h2" />
      <ReportPageSummary
        basePath={STATIC_BASE_PATH}
        correctionLabel={headline.kicker !== HEADLINE_KICKER ? headline.kicker : null}
        headline={headline}
        dateline={null}
        incompleteNotice={degradedRunNotice(reportView)}
        schemaLimit={schemaNotePlacement(reportView).limit}
        recordLinks={null}
        findings={findings}
        evidenceArm={evidenceArm}
        automation={reportFacts.display.run.conditions.automation}
        visitOrder={reportView.comparison
          ? comparisonVisitOrderLine(reportView.comparison.visitOrder, reportView.comparison.runLabels)
          : null}
        siteHistoryHref={siteHistoryHref}
        newVisitTarget={newVisitTarget}
        newVisitFrom={newVisitFrom}
        visitSummary={visitSummary}
        // The "Not measured" row: the visit summary's limit leads, from the
        // module the report page's summary builds them from.
        figure={<RequestFigure figure={buildRequestFigure(reportView, reportFacts, evidenceArm)}
          notMeasured={notMeasuredLeads({ view: reportView, facts: reportFacts, findings, evidenceArm })} />}
        domainTable={null}
      />
    </div>
  );

  const overview = (<>
          {/* A file the reader opened is drawn by the same components as a
              published report, on the same site, and its own text fills the
              title, the measurement limits and the methodology card. Nothing
              else on the result says the page did not vouch for it, so this
              line does, first and for as long as the result is shown. The
              incomplete-visit notice's frame is reused: it is the one notice
              style this chunk already carries, and it prints. */}
          {loaded.localOnly && (
            <p className="report-incomplete-notice" role="note">
              This report was opened from a file on this device. It was not checked against the published corpus, and
              text in it may not be the scanner&apos;s.
            </p>
          )}
          {/* An inspection visit's own observation, ahead of the ordinary
              result that follows below it as for any single scan. */}
          {inspection && !printComplete && (
            <ConnectionInspectionPanel evidence={inspection.evidence} earlierResultHref={inspectedFromHref} />
          )}
          {/* A check visit's own observation, then one sentence saying what
              the ordinary report beneath it covers. */}
          {scrollCheck && !printComplete && (
            <>
              <ScrollCheckPanel evidence={scrollCheck.evidence} earlierResultHref={checkedFromHref} />
              <p className="scroll-check-report-note">{scrollCheckReportNote(scrollCheck.evidence)}</p>
            </>
          )}
          {resultSummary}
          <ReportHeader
            share={shareForLoadedReport(loaded)}
            view={reportView}
            runFacts={displayedFacts}
            evidenceFacts={displayedFacts}
            csvArmLabel={arms ? armDisplayLabel(reportView, displayedArmLabel) : null}
            onDownload={() => void exportWithFeedback(downloadReport)}
            onDownloadCsv={() => void exportWithFeedback(downloadCsv)}
            liveApiServesReportPages={liveApiServesReportPages}
            pdfExportQuery={pdfExportQuery}
            exportsOffered={scrollCheck === null}
            // The report pages build a visit summary, and state the time
            // there and in their identity block. A result with none has no
            // other place that says when its visit ran.
            visitStartShown={visitSummary === undefined}
            // On screen no result renders the earlier banner, so the banner's
            // two sharing controls close the head's action row.
            postActions={!printComplete && scrollCheck === null
              ? (
                // The banner's own wrapper and class, so the two controls are
                // the same group wherever they are offered.
                <div className="headline-actions">
                  <HeadlinePostActions share={shareForLoadedReport(loaded)} headline={headline} liveApiServesReportPages={liveApiServesReportPages} />
                </div>
              )
              : null}
          />
          {exportError && <p role="alert" className="export-error">{exportError}</p>}
          {/* Where this comparison came from, beside the report's identity and
              outside its verdict: a link back to the earlier result and why
              this pair cannot speak for the card that offered it. */}
          {(printComplete || evidenceOnly) && earlierResult}
          {/* Paper keeps the banner and the board. On screen a report page has
              its own summary above the explorer, and any other result gets
              that same summary before the evidence head (resultSummary). */}
          {printComplete && !evidenceOnly && (<>
          <HeadlineBanner
            share={shareForLoadedReport(loaded)}
            headline={headline}
            liveApiServesReportPages={liveApiServesReportPages}
            sharingOffered={scrollCheck === null}
          />
          <FindingsBoard evidenceArm={evidenceArm} facts={reportFacts} findings={findings} siteHistoryHref={siteHistoryHref}
            newVisitTarget={newVisitTarget} newVisitFrom={newVisitFrom} afterBottomLine={visitSummary} />
          </>)}
          {/* The bar: which visit's evidence is shown, and the section list.
              It stays under the top of the window while the evidence is read.
              Paper has no bar: its section list leads the document. */}
          {!printComplete && (
          <div className="evidence-bar">
                {arms && !printComplete && (
                  <div className="arm-switcher" role="group" aria-label="Which visit's evidence the tables below show">
                    <span>Evidence shown:</span>
                    {(["baseline", "variant"] as const).map((arm) => (
                      <button
                        key={arm}
                        type="button"
                        className={`arm-option${displayedArmLabel === arm ? " is-active" : ""}`}
                        aria-pressed={displayedArmLabel === arm}
                        onClick={() => setSelectedArm(arm)}
                      >
                        {armDisplayLabel(reportView, arm)}
                      </button>
                    ))}
                    <p className="visually-hidden" role="status" aria-live="polite">
                      {`Showing evidence from the ${armDisplayLabel(reportView, displayedArmLabel)} visit.`}
                    </p>
                  </div>
                )}
            <ReportSectionNav sections={sections} />
          </div>
          )}
          {reportView.reportType === "comparison" && (
            <ComparisonPanel view={reportView} facts={reportFacts} />
          )}
  </>);

  return (
    <PrintCompleteProvider value={printComplete}>
      <p className="visually-hidden" role="status" aria-live="polite">
        {`Scan report ready for ${displayHost(primaryRun.domain)}: ${plural(
          primaryRun.evidence.requests.length,
          "recorded request row"
        )}.${reportFacts.display.subject.describesSubject ? "" : " The requested page was not established."}`}
      </p>
      {claim && claimFacts && createPortal(
        <ClaimRows requests={claimFacts.run.evidence.requests} phases={claimFacts.run.phases} facts={claimFacts} target={claim.target} />,
        claim.host
      )}
      {printComplete && <ReportSectionNav sections={sections} />}
      {/* Paper: the evidence head, the comparison, the limits and the guide,
          inside the same grid the evidence uses, so the explorer's sheet
          dresses them as it does on screen. */}
      {printComplete && (
        <section className="report-grid">
          <div className="report-main">
            {overview}
            <Warnings warnings={reportView.warnings} runLabels={reportView.comparison?.runLabels ?? null} />
            {printGuide}
          </div>
        </section>
      )}
      {printComplete && reportFacts.arms ? (
        (["baseline", "variant"] as const).map((arm) => (
          <PrintVisitProvider key={arm} arm={arm}>
            <RunEvidence reportView={reportView} displayedFacts={reportFacts.arms![arm]} arm={arm} printComplete
              benchmarkScope={benchmarkScope} />
          </PrintVisitProvider>
        ))
      ) : (
        <RunEvidence reportView={reportView} displayedFacts={displayedFacts}
          arm={arms ? displayedArmLabel : undefined} printComplete={printComplete} overview={printComplete ? undefined : overview}
          benchmarkScope={benchmarkScope} requestInspection={requestInspection} />
      )}
    </PrintCompleteProvider>
  );
}

/** Shared per-visit evidence: the screen selects one; paper renders every visit. */
function RunEvidence({ reportView, displayedFacts, arm, printComplete, overview, benchmarkScope, requestInspection = null }: {
  reportView: ReportView; displayedFacts: RunFacts; arm?: "baseline" | "variant"; printComplete: boolean; overview?: ReactNode;
  /** The cohort the bottom line ranks against, when it ranks; see Finding.benchmarkScope. */
  benchmarkScope?: string;
  /** The request log's inspection links, for a fresh result's screen render only. */
  requestInspection?: RequestInspectionContext | null;
}) {
  const evidenceId = useEvidenceIds();
  const displayedRun = displayedFacts.run;
  const screenshot = displayableScreenshot(displayedRun.screenshot);
  // The capture itself is right to keep: it is the reader's only direct look at
  // what the scanner actually hit. What was missing is the caption. A block page
  // scaled into the sidebar column is often near-blank, which reads either as a
  // broken image or as a claim that the site is a blank page.
  const screenshotFailureStatus =
    displayedFacts.subject.kind === "http-error" ? displayedFacts.subject.status : null;
  const screenshotSubjectUnverified = displayedFacts.subject.kind === "unverified";
  const screenshotSoftBlock = displayedFacts.subject.kind === "interstitial";
  const screenshotFailedLoad = !displayedFacts.subject.describesSubject;
  const screenshotSubject =
    screenshotFailureStatus !== null
      ? `the HTTP ${screenshotFailureStatus} error or block page returned by ${displayHost(displayedRun.domain)}`
      : screenshotSubjectUnverified
        ? `an unverified page subject returned while scanning ${displayHost(displayedRun.domain)}`
        : screenshotSoftBlock
          ? `the suspected challenge or soft-block page returned by ${displayHost(displayedRun.domain)}`
          : screenshotFailedLoad
            ? `the page ${displayHost(displayedRun.domain)} returned on a load that did not complete`
            : displayHost(displayedRun.domain);

  const causality = (
          <CausalityGraph
            run={displayedRun}
            requestEvidenceState={displayedFacts.evidence.requests.state}
            arm={arm}
          />
  );
  const screenshotCard = (<>
          {screenshot && (
            <section className="side-card screenshot-card">
              <h2>Viewport</h2>
              {/* Intrinsic size from the recorded viewport, which is exact for the
                  non-fullPage capture this is. Without it the image had no reserved
                  box and its arrival pushed the whole evidence sidebar down. */}
              <img
                src={screenshot}
                alt={`Screenshot of ${screenshotSubject}`}
                width={displayedRun.conditions.viewport.width}
                height={displayedRun.conditions.viewport.height}
                style={{
                  aspectRatio: `${displayedRun.conditions.viewport.width} / ${displayedRun.conditions.viewport.height}`
                }}
                loading="lazy"
                decoding="async"
              />
              {screenshotFailedLoad && (
                <p className="muted">
                  {screenshotFailureStatus !== null
                    ? `This is the HTTP ${screenshotFailureStatus} error or block page, not the site. A near-blank image is what the browser actually rendered.`
                    : screenshotSubjectUnverified
                      ? "The scanner could not verify that this rendered document was the requested page."
                      : screenshotSoftBlock
                        ? "This is the suspected challenge or soft-block page the browser rendered, not a normal load of the site."
                        : "This is what the browser rendered on a load that did not complete, not the site."}
                </p>
              )}
            </section>
          )}

  </>);
  const thirdParties = (
          <section className="side-card" id={evidenceId("third-parties")}>
            <h2>Top Third Parties</h2>
            <TopThirdParties facts={displayedFacts} />
          </section>
  );
  const pixels = (<>
          {(displayedRun.evidence.pixelEvents.length > 0 || displayedFacts.claims["pixel-events"].blockers.some(
            (blocker) => blocker !== "subject-not-established"
          )) && (
            <section className="side-card" id={evidenceId("pixels")}>
              <h2>Advertising Pixels</h2>
              <PixelEventsList pixels={displayedRun.evidence.pixelEvents} facts={displayedFacts} corrected={publishedReportCorrections(reportView.reportId).suppressIndexing} />
            </section>
          )}

  </>);
  const cookies = (
          <section className="side-card" id={evidenceId("cookies")}>
            <h2>Cookies</h2>
            <CookieList
              cookies={displayedRun.evidence.cookies}
              facts={displayedFacts}
            />
          </section>
  );
  const storage = (
          <section className="side-card" id={evidenceId("storage")}>
            <h2>Storage</h2>
            <StorageList
              storage={displayedRun.evidence.storage}
              facts={displayedFacts}
            />
          </section>
  );
  const signals = (
          <section className="side-card" id={evidenceId("signals")}>
            <h2>Browser Behavior Signals</h2>
            <FingerprintList
              events={displayedRun.evidence.fingerprintEvents}
              detections={displayedRun.evidence.fingerprintDetections}
              facts={displayedFacts}
            />
          </section>
  );
  const methodology = (
          <section className="side-card methodology" id={evidenceId("conditions")}>
            <h2>Methodology</h2>
            <dl>
              <div><dt>Schema</dt><dd>{schemaProvenanceLabel(reportView)}</dd></div>
              <div><dt>Run quality</dt><dd>{runQualitySummary(displayedRun)}</dd></div>
              <div><dt>Scanner</dt><dd>{displayedRun.conditions.automation}</dd></div>
              {displayedRun.conditions.automation === "playwright-chromium" && (
                <div><dt>Playwright</dt><dd>{displayedRun.conditions.playwrightVersion ?? "not recorded"}</dd></div>
              )}
              <div><dt>Browser</dt><dd>{displayedRun.conditions.browserVersion ?? "not recorded"}</dd></div>
              <div><dt>Timezone</dt><dd>{displayedRun.conditions.timezone}</dd></div>
              <div><dt>Headless</dt><dd>{displayedRun.conditions.headless ? "yes" : "no"}</dd></div>
              <div>
                <dt>Viewport</dt>
                <dd>{displayedRun.conditions.viewport.width}×{displayedRun.conditions.viewport.height}</dd>
              </div>
              <div><dt>GPC</dt><dd>{gpcMethodologyLabel(displayedRun)}</dd></div>
              {displayedRun.consent && (
                <div>
                  <dt>Consent</dt>
                  <dd>
                    {displayedRun.consent.controlActivated
                      ? `${
                          displayedRun.consent.matchedControlQualification
                            ? // The click is evidence of which control was activated, not of
                              // what it expressed, so the row states the request rather than
                              // asserting the choice as an outcome.
                              `asked for "${consentChoiceLabel(displayedRun.consent.mode)}"`
                            : `clicked "${consentChoiceLabel(displayedRun.consent.mode)}"`
                        }${displayedRun.consent.cmp ? ` (${displayedRun.consent.cmp})` : ""}${
                          displayedRun.consent.matchedControlQualification
                            ? `; clicked ${displayedRun.consent.matchedControlQualification}`
                            : ""
                        }`
                      : "no control activation recorded"}
                    {` · ${consentVerificationSummary(displayedRun.consent)}`}
                  </dd>
                </div>
              )}
              <div><dt>Egress</dt><dd>{displayedRun.conditions.scannerEgress}</dd></div>
              {displayedRun.conditions.trackerCatalog && (
                <div>
                  <dt>Catalog</dt>
                  <dd>
                    {displayedRun.conditions.trackerCatalog.source}<br />
                    {displayedRun.conditions.trackerCatalog.region
                      ? `${displayedRun.conditions.trackerCatalog.region} · `
                      : ""}
                    {displayedRun.conditions.trackerCatalog.version}<br />
                    {displayedRun.conditions.trackerCatalog.entries.toLocaleString("en-US")} entries
                  </dd>
                </div>
              )}
              {displayedRun.conditions.adblockLists && (
                <div>
                  <dt>Brave Shields lists</dt>
                  <dd>
                    {displayedRun.conditions.adblockLists.source}<br />
                    {displayedRun.conditions.adblockLists.lists.toLocaleString("en-US")} lists · fetched{" "}
                    {formatListSnapshot(displayedRun.conditions.adblockLists.fetchedAt)}
                  </dd>
                </div>
              )}
            </dl>
            {benchmarkScope && <p>{benchmarkScope}</p>}
            {displayedRun.conditions.disclosure && <p>{displayedRun.conditions.disclosure}</p>}
          </section>
  );
  const tables = (<>
          <DomainTable domains={displayedRun.evidence.domains} facts={displayedFacts} />
          <RequestTable
            requests={displayedRun.evidence.requests}
            phases={displayedRun.phases}
            facts={displayedFacts}
            // A visit that did not establish the page (an HTTP error, an
            // unverified subject, a suspected challenge or a failed load)
            // offers no new visit of it, gate G3 of the Look closer draft.
            inspection={displayedFacts.subject.describesSubject ? requestInspection : null}
          />
  </>);
  const warnings = <Warnings warnings={reportView.warnings} runLabels={reportView.comparison?.runLabels ?? null} />;

  return (
    <section className={printComplete ? "print-visit" : undefined} data-evidence-arm={arm ?? "single"}>
      {printComplete && <header className="print-visit-heading">
        <h2>{arm ? armDisplayLabel(reportView, arm) : "Recorded visit"}: evidence</h2>
        <p>{displayedRun.startedAt ?? "Visit time not recorded"} · {runQualitySummary(displayedRun)}</p>
        <p>Retained observations from this visit. Missing measurements do not establish absence of activity.</p>
      </header>}
      {printComplete ? (
      /* Paper reads in the screen's order: numbers, timeline, phases, the two
         tables, the lists, the attribution map, the conditions. Paper keeps
         the third-party list the screen leaves to the domain table. */
      <section className="report-grid">
        <div className="report-main">
          <MetricGrid facts={displayedFacts} />
          <TrafficViz facts={displayedFacts} />
          <VisitPhasesAndStateChanges run={displayedRun} />
        </div>

        <div className="report-evidence-tables" aria-label="Raw report evidence">
          {tables}
        </div>

        <aside className="report-sidebar" aria-label="Supporting report evidence">
          {thirdParties}
          {cookies}
          {storage}
          {signals}
          {pixels}
        </aside>

        <div className="report-main">
          {causality}
          {methodology}
          {screenshotCard}
        </div>
      </section>
      ) : (
      /* On screen, one record read down: numbers, timeline, the two tables,
         the lists, the attribution map, the limits, the conditions. The
         source order is the order seen. */
      <section className="report-grid">
        <div className="report-main">
          {overview}
          <MetricGrid facts={displayedFacts} />
          <TrafficViz facts={displayedFacts} />
          <VisitPhasesAndStateChanges run={displayedRun} />
        </div>

        <div className="report-evidence-tables" aria-label="Raw report evidence">
          {tables}
        </div>

        {/* No "Top Third Parties" here: its rows are the first rows of the
            domain table above. Paper keeps the card. */}
        <aside className="report-sidebar" aria-label="Supporting report evidence">
          {cookies}
          {storage}
          {signals}
          {pixels}
        </aside>

        <div className="report-main">
          {causality}
          {warnings}
          {methodology}
          {screenshotCard}
        </div>
      </section>
      )}
    </section>
  );
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function safeFilenamePart(value: string): string {
  return value.replace(/[^a-z0-9.-]+/gi, "-").replace(/^-+|-+$/g, "") || "report";
}

// Builds that could not read the vendored list metadata record `fetchedAt` as the
// literal "unknown" sentinel, and imported report files can carry anything. Say the
// provenance is missing rather than rendering "Invalid Date" in the methodology block.
function formatListSnapshot(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "date not recorded";
  return date.toLocaleDateString("en-US", { timeZone: "UTC" });
}

function gpcMethodologyLabel(run: RunView): string {
  const measurement = gpcRunMeasurement(run);
  if (measurement.outcome === "verified") {
    return `${measurement.configured ? "configured on" : "configured off"} · readback verified`;
  }
  if (measurement.outcome === "contradicted") {
    return `${measurement.configured ? "configured on" : "configured off"} · readback contradicted`;
  }
  if (measurement.outcome === "unverified") {
    return `${measurement.configured ? "configured on" : "configured off"} · readback inconclusive`;
  }
  return `${measurement.configured ? "configured on" : "configured off"} · readback not recorded`;
}

function armDisplayLabel(view: ReportView, arm: "baseline" | "variant"): string {
  return view.comparison?.runLabels[arm] ?? (arm === "baseline" ? "Baseline" : "Variant");
}
