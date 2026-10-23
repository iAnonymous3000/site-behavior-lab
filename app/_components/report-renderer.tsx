"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { STATIC_BASE_PATH, clientReportRuntime } from "../client-runtime";
import { CausalityGraph } from "./causality-graph";
import { ComparisonPanel } from "./comparison-panel";
import { ConnectionInspectionPanel } from "./connection-inspection-panel";
import { FindingsBoard, HeadlineBanner, MetricGrid, TrafficViz, useReportFindings } from "./report-overview";
import { ReportHeader } from "./report-header";
import { ReportSectionNav, type ReportSection } from "./report-section-nav";
import {
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
import { buildReportHeadline } from "@/lib/report-headline";
import { buildReportFacts, type RunFacts } from "@/lib/report-facts";
import { parseEvidenceHash } from "@/lib/report-evidence-navigation";
import { locateReport } from "@/lib/report-locator";
import { reportNewVisitFrom, reportNewVisitTarget } from "@/lib/report-rescan-targets";
import type { RequestInspectionContext } from "@/lib/request-inspection-link";
import type { ShownConnectionInspection } from "@/lib/connection-inspection-result";
import {
  displayableScreenshot,
  gpcRunMeasurement
} from "@/lib/report-insights";
import type { LoadedReport } from "@/lib/scan-report-view";
import { runQualitySummary } from "@/lib/scan-report-censorship";
import {
  comparisonArmViews,
  schemaProvenanceLabel,
  type ReportView,
  type RunView
} from "@/lib/scan-report-views";
import { displayHost, plural } from "@/lib/text-format";
import { publishedReportCorrections } from "@/lib/published-report-corrections";

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
  earlierResultId = null,
  inspection = null
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
  const benchmarkScope = findings.find((finding) => finding.id === "bottom-line")?.benchmarkScope;
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

  // Reading order, not render order: the rail cards sit beside the main column
  // on a wide screen but a reader moves through them after it. ReportSectionNav
  // drops any of these whose section this report did not render, so the list can
  // stay declarative without shipping an anchor that scrolls nowhere.
  const sections: ReportSection[] = [
    { id: "findings", label: "Findings" },
    { id: "comparison", label: "Comparison" },
    { id: "causal-map", label: "Attribution" },
    { id: "numbers", label: "Numbers" },
    { id: "traffic", label: "Traffic" },
    { id: "visit-phases", label: "Visit phases" },
    { id: "third-parties", label: "Third parties" },
    { id: "pixels", label: "Pixels" },
    { id: "cookies", label: "Cookies" },
    { id: "storage", label: "Storage" },
    { id: "signals", label: "Signals" },
    { id: "domain-evidence", label: "Domains" },
    { id: "request-evidence", label: "Request log" },
    { id: "measurement-limits", label: "Limits" },
    { id: "conditions", label: "Conditions" }
  ];

  const overview = (<>
          {/* An inspection visit's own observation, ahead of the ordinary
              result that follows below it as for any single scan. */}
          {inspection && !printComplete && (
            <ConnectionInspectionPanel evidence={inspection.evidence} earlierResultHref={inspectedFromHref} />
          )}
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
          />
          {exportError && <p role="alert" className="export-error">{exportError}</p>}
          {/* Where this comparison came from, beside the report's identity and
              outside its verdict: a link back to the earlier result and why
              this pair cannot speak for the card that offered it. */}
          {earlierResultHref && (
            <div className="earlier-result-note">
              <a className="earlier-result-link" href={earlierResultHref} aria-describedby="earlier-result-sentence">
                {EARLIER_RESULT_LINK.label}
              </a>
              <p id="earlier-result-sentence">{EARLIER_RESULT_LINK.sentence}</p>
            </div>
          )}
          <HeadlineBanner
            share={shareForLoadedReport(loaded)}
            headline={headline}
            liveApiServesReportPages={liveApiServesReportPages}
          />
          <FindingsBoard evidenceArm={evidenceArm} facts={reportFacts} findings={findings} siteHistoryHref={siteHistoryHref}
            newVisitTarget={newVisitTarget} newVisitFrom={newVisitFrom} afterBottomLine={visitSummary} />
          {reportView.reportType === "comparison" && (
            <ComparisonPanel view={reportView} facts={reportFacts} />
          )}
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
  </>);

  return (
    <PrintCompleteProvider value={printComplete}>
      <p className="visually-hidden" role="status" aria-live="polite">
        {`Scan report ready for ${displayHost(primaryRun.domain)}: ${plural(
          primaryRun.evidence.requests.length,
          "recorded request row"
        )}.${reportFacts.display.subject.describesSubject ? "" : " The requested page was not established."}`}
      </p>
      <ReportSectionNav sections={sections} />
      {printComplete && <>
        {overview}
        <Warnings warnings={reportView.warnings} runLabels={reportView.comparison?.runLabels ?? null} />
        {printGuide}
      </>}
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

  return (
    <section className={printComplete ? "print-visit" : undefined} data-evidence-arm={arm ?? "single"}>
      {printComplete && <header className="print-visit-heading">
        <h2>{arm ? armDisplayLabel(reportView, arm) : "Recorded visit"} — evidence</h2>
        <p>{displayedRun.startedAt ?? "Visit time not recorded"} · {runQualitySummary(displayedRun)}</p>
        <p>Retained observations from this visit. Missing measurements do not establish absence of activity.</p>
      </header>}
      <section className="report-grid">
        <div className="report-main">
          {overview}
          <CausalityGraph
            run={displayedRun}
            requestEvidenceState={displayedFacts.evidence.requests.state}
            arm={arm}
          />
          <MetricGrid facts={displayedFacts} />
          <TrafficViz facts={displayedFacts} />
          <VisitPhasesAndStateChanges run={displayedRun} />
          {!printComplete && <Warnings warnings={reportView.warnings} runLabels={reportView.comparison?.runLabels ?? null} />}
        </div>

        <aside className="report-sidebar" aria-label="Supporting report evidence">
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

          <section className="side-card" id={evidenceId("third-parties")}>
            <h2>Top Third Parties</h2>
            <TopThirdParties facts={displayedFacts} />
          </section>

          {(displayedRun.evidence.pixelEvents.length > 0 || displayedFacts.claims["pixel-events"].blockers.some(
            (blocker) => blocker !== "subject-not-established"
          )) && (
            <section className="side-card" id={evidenceId("pixels")}>
              <h2>Advertising Pixels</h2>
              <PixelEventsList pixels={displayedRun.evidence.pixelEvents} facts={displayedFacts} corrected={publishedReportCorrections(reportView.reportId).suppressIndexing} />
            </section>
          )}

          <section className="side-card" id={evidenceId("cookies")}>
            <h2>Cookies</h2>
            <CookieList
              cookies={displayedRun.evidence.cookies}
              facts={displayedFacts}
            />
          </section>

          <section className="side-card" id={evidenceId("storage")}>
            <h2>Storage</h2>
            <StorageList
              storage={displayedRun.evidence.storage}
              facts={displayedFacts}
            />
          </section>

          <section className="side-card" id={evidenceId("signals")}>
            <h2>Browser Behavior Signals</h2>
            <FingerprintList
              events={displayedRun.evidence.fingerprintEvents}
              detections={displayedRun.evidence.fingerprintDetections}
              facts={displayedFacts}
            />
          </section>

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
        </aside>

        <div className="report-evidence-tables" aria-label="Raw report evidence">
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
        </div>
      </section>
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
