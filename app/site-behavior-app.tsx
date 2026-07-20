"use client";

import {
  Cookie,
  Eye,
  FileJson,
  Fingerprint,
  FlaskConical,
  Github,
  Keyboard,
  Loader2,
  Moon,
  Network,
  Radar,
  Shield,
  Sun
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { CausalityGraph } from "./_components/causality-graph";
import { ComparisonPanel } from "./_components/comparison-panel";
import {
  PageGraphR2UploadButton,
  ReportUploadButton,
  type PageGraphUploadSelection
} from "./_components/file-upload-button";
import { FindingsBoard, HeadlineBanner, MetricGrid, TrafficViz } from "./_components/report-overview";
import { ReportHeader } from "./_components/report-header";
import {
  CookieList,
  DomainTable,
  FingerprintList,
  PixelEventsList,
  RequestTable,
  StorageList,
  TopThirdParties,
  Warnings
} from "./_components/report-tables";
import { StaticReportGallery } from "./_components/static-gallery";
import { VisitPhasesAndStateChanges } from "./_components/visit-phases-and-state-changes";
import { ScanControls } from "./_components/scan-controls";
import { ScanRecoveryBanner } from "./_components/scan-recovery-banner";
import { ScheduledRescans } from "./_components/scheduled-rescans";
import { useScanRuntime } from "./_hooks/use-scan-runtime";
import {
  LIVE_SCAN_ENABLED,
  SCAN_WORKFLOW_URL,
  STATIC_EXPORT,
  clientReportRuntime,
  staticAssetPath
} from "./client-runtime";
import { consentChoiceLabel } from "@/lib/consent-interaction";
import { requestLogToCsv } from "@/lib/csv-export";
import { displayableScreenshot, gpcRunMeasurement } from "@/lib/report-insights";
import { consentVerificationSummary } from "@/lib/report-consent-copy";
import { buildReportHeadline, reportPageTitle } from "@/lib/report-headline";
import { committedReportLocation } from "@/lib/report-locator";
import { plural } from "@/lib/text-format";
import { readLoadedReport, withoutLoadedReportShare } from "@/lib/client-report-reader";
import {
  comparisonArmViews,
  displayRunView,
  familyUnsupportedOnRun,
  runQualitySummary,
  schemaProvenanceLabel,
  viewFromV1Report,
  type ReportView,
  type RunView
} from "@/lib/scan-report-views";
// Type-only: the deep reader module stays lazy-loaded (client-report-reader);
// a type import is erased at build time and adds nothing to the bundle.
import type { LoadedReport } from "@/lib/scan-report-view";
import type {
  ComparisonScanResult,
  ScanReport,
  StaticReportManifestEntry
} from "@/lib/types";

const EXAMPLES: { url: string; hint: string }[] = [
  { url: "youtube.com", hint: "one mega-entity" },
  { url: "usatoday.com", hint: "heavy trackers" },
  { url: "amazon.com", hint: "retail + retargeting" },
  { url: "weather.com", hint: "tracker-dense" },
  { url: "wikipedia.org", hint: "minimal" }
];
export type CorpusHighlights = {
  /** Distinct real sites represented by any committed attempt. */
  attemptedSiteCount: number;
  /** Attempted sites with at least one successful load, capped recordings included. */
  loadedSiteCount: number;
  /** Attempted sites with no successful load in the committed corpus. */
  failedSiteCount: number;
  /** Successfully loaded sites with at least one request-capped recording. */
  cappedSiteCount: number;
  /** Sites eligible for the cross-version category medians. */
  eligibleSiteCount: number;
  topCategories: { label: string; medianTrackers: number }[];
};

type SiteBehaviorAppProps = {
  /** A pre-loaded report (the saved-report permalink page's read result). */
  initialLoaded?: LoadedReport | null;
  initialError?: string | null;
  initialLoading?: boolean;
  corpusHighlights?: CorpusHighlights | null;
  /** Evidence-first permalink: render the report directly, without the scanner workbench. */
  reportPage?: boolean;
};

export function SiteBehaviorApp({
  initialLoaded = null,
  initialError = null,
  initialLoading = false,
  corpusHighlights = null,
  reportPage = false
}: SiteBehaviorAppProps) {
  const {
    form,
    setForm,
    loaded,
    setLoaded,
    error,
    setError,
    loading,
    setLoading,
    scanning,
    activeScanJob,
    cancellingScan,
    cancelScanError,
    scheduledRescanCreateBusy,
    setScheduledRescanCreateBusy,
    turnstileToken,
    turnstileResetNonce,
    setTurnstileToken,
    urlNotice,
    urlError,
    clearUrlNotice,
    policy,
    scannerStatus,
    statusLabel,
    retryScannerHealth,
    handleSubmit,
    useExample,
    updateAccessKey,
    acceptScheduledRescanTarget,
    resetTurnstileAfterScheduledRescanAttempt,
    resumeActiveScan,
    cancelActiveScan
  } = useScanRuntime({ reportPage, initialLoaded, initialError, initialLoading });
  const {
    gpcComparisonEnabled,
    shieldsComparisonEnabled,
    consentComparisonEnabled,
    liveApiServesReportPages,
    scheduledRescansEnabled,
    scannerRequiresAccessKey,
    turnstileRequired,
    turnstileUnsupported,
    awaitingTurnstile,
    scannerUnavailable,
    scanBlocked
  } = policy;
  const [staticReports, setStaticReports] = useState<StaticReportManifestEntry[] | null>(STATIC_EXPORT ? null : []);
  const [staticReportsError, setStaticReportsError] = useState<string | null>(null);

  useEffect(() => {
    if (reportPage) return;
    if (!STATIC_EXPORT) return;

    let cancelled = false;

    async function loadStaticReports() {
      try {
        const response = await fetch(staticAssetPath("/reports/index.json"), { cache: "no-store" });
        if (!response.ok) throw new Error("Report manifest unavailable.");
        const payload = (await response.json()) as unknown;
        const reports = isStaticReportManifest(payload) ? payload.reports : [];
        if (!cancelled) {
          setStaticReports(reports);
          setStaticReportsError(null);
        }
      } catch {
        if (!cancelled) {
          setStaticReports([]);
          setStaticReportsError("Generated report index is not available.");
        }
      }
    }

    void loadStaticReports();
    return () => {
      cancelled = true;
    };
  }, [reportPage]);

  async function loadReportFile(file: File | null) {
    if (!file) return;
    setLoading(true);
    setError(null);
    setLoaded(null);

    try {
      const payload = JSON.parse(await file.text()) as unknown;
      const read = await readLoadedReport(payload, "This report JSON");
      if (!read.ok) {
        throw new Error(read.message);
      }
      setLoaded(withoutLoadedReportShare(read.loaded));
    } catch (readError) {
      setError(readError instanceof Error ? readError.message : "Report JSON could not be opened.");
    } finally {
      setLoading(false);
    }
  }

  async function loadPageGraphFile(selection: PageGraphUploadSelection) {
    setLoading(true);
    setError(null);
    setLoaded(null);

    try {
      // Code-split the strict r2 importer and graph parser so neither affects
      // the first-load bundle. The importer verifies the digest-bound sidecar.
      const { readPageGraphUpload } = await import("@/lib/pagegraph-client-import");
      setLoaded(await readPageGraphUpload(selection));
    } catch (readError) {
      setError(readError instanceof Error ? readError.message : "The PageGraph capture pair could not be opened.");
    } finally {
      setLoading(false);
    }
  }

  // The version-independent view every renderer consumes; the wire form stays
  // on `loaded` for share links and exports only (RFC 14.8).
  const reportView = loaded ? loaded.view : null;
  const primaryRun = reportView ? displayRunView(reportView) : null;
  const arms = reportView ? comparisonArmViews(reportView) : null;
  // Two-arm evidence audit: on comparisons every per-run surface (tables,
  // sidebar, methodology, CSV) can show EITHER visit, so the protected or
  // rejected arm is inspectable without downloading the JSON. Defaults to the
  // arm the headline's lead finding describes (headline.focusArm), else the
  // lead run; report-level surfaces (headline, findings, panel) stay pair-fed.
  const [selectedArm, setSelectedArm] = useState<"baseline" | "variant" | null>(null);
  // A new report must not inherit the previous report's arm selection.
  useEffect(() => {
    setSelectedArm(null);
  }, [loaded]);
  const headlineFocusArm = useMemo(
    () => (reportView && arms ? buildReportHeadline(reportView).focusArm ?? null : null),
    [reportView, arms]
  );
  const defaultArm: "baseline" | "variant" =
    headlineFocusArm ?? (reportView?.comparison?.temporalPair ? "variant" : "baseline");
  const displayedArmLabel: "baseline" | "variant" = selectedArm ?? defaultArm;
  const displayedRun = arms ? arms[displayedArmLabel] : primaryRun;

  async function downloadReport() {
    if (!loaded || !primaryRun) return;
    // THE serialization boundary (RFC 14.8): the original public wire per
    // generation (deep-projected v1, projection for ephemeral shells), never a
    // view. Lazy-loaded with the deep reader so downloads stay off first-load.
    const { publicWireForExportOrPersistence } = await import("@/lib/scan-report-view");
    const blob = new Blob([JSON.stringify(publicWireForExportOrPersistence(loaded), null, 2)], {
      type: "application/json"
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `site-behavior-lab-${safeFilenamePart(primaryRun.domain)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function downloadCsv() {
    if (!loaded || !displayedRun) return;
    // The CSV is per-visit evidence: it exports the ARM the page is showing,
    // and a comparison's filename names that arm so two exports never mix up.
    const csv = requestLogToCsv(displayedRun.evidence.requests);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    const armPart = arms ? `-${safeFilenamePart(armDisplayLabel(reportView, displayedArmLabel))}` : "";
    anchor.href = url;
    anchor.download = `site-behavior-lab-${safeFilenamePart(displayedRun.domain)}${armPart}-requests.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  const reportReadyMessage =
    loaded && primaryRun && !loading && !error
      ? `Scan report ready for ${primaryRun.domain}: ${plural(primaryRun.counts.totalRequests, "request")} observed.`
      : "";
  const permalinkHeadline = reportPage && reportView ? buildReportHeadline(reportView) : null;
  const statusClassName = `status-pill${STATIC_EXPORT ? " status-pill-static" : ""}${
    LIVE_SCAN_ENABLED ? " status-pill-live" : ""
  }`;
  const scanControls = (
    <ScanControls
      form={form}
      setForm={setForm}
      onSubmit={handleSubmit}
      loading={loading}
      scanBlocked={scanBlocked || scheduledRescanCreateBusy}
      activeScanJob={Boolean(activeScanJob)}
      urlNotice={urlNotice}
      urlError={urlError}
      clearUrlNotice={clearUrlNotice}
      scannerStatus={scannerStatus}
      scannerStatusError={scannerUnavailable}
      onRetryScannerHealth={retryScannerHealth}
      turnstileRequired={turnstileRequired}
      turnstileResetNonce={turnstileResetNonce}
      onTurnstileToken={setTurnstileToken}
      onError={setError}
      turnstileUnsupported={turnstileUnsupported}
      awaitingTurnstile={awaitingTurnstile}
      gpcComparisonEnabled={gpcComparisonEnabled}
      shieldsComparisonEnabled={shieldsComparisonEnabled}
      consentComparisonEnabled={consentComparisonEnabled}
      scannerRequiresAccessKey={scannerRequiresAccessKey}
      onAccessKeyChange={updateAccessKey}
    />
  );
  const scanForm = (
    <div className="scan-panel-stack">
      {scanControls}
      <ScheduledRescans
        enabled={scheduledRescansEnabled}
        form={form}
        scanBlocked={scanBlocked}
        scanBusy={loading}
        acceptedScanJob={Boolean(activeScanJob)}
        scannerRequiresAccessKey={scannerRequiresAccessKey}
        turnstileRequired={turnstileRequired}
        turnstileToken={turnstileToken}
        onTargetNormalized={acceptScheduledRescanTarget}
        onCreateBusyChange={setScheduledRescanCreateBusy}
        onCreateNetworkAttemptSettled={resetTurnstileAfterScheduledRescanAttempt}
      />
    </div>
  );

  return (
    <>
      <a className="skip-link" href="#report">
        Skip to results
      </a>
      <main className={`app-shell${reportPage ? " report-page-shell" : ""}`}>
        <header className="topbar">
          <a className="brand" href={staticAssetPath("/")} aria-label="Site Behavior Lab home">
            <span className="brand-mark">
              <FlaskConical size={22} aria-hidden="true" />
            </span>
            <div>
              <p className="eyebrow">{reportPage ? "Site Behavior Lab · Evidence" : "Site Behavior Lab"}</p>
              <h1>
                {permalinkHeadline
                  ? reportPageTitle(permalinkHeadline)
                  : reportPage
                    ? "Saved site behavior report"
                    : "See what a site does, not just what it says."}
              </h1>
            </div>
          </a>
          <div className="topbar-actions">
            {reportPage ? (
              <>
                <a className="topbar-link" href={staticAssetPath("/directory/")}>Directory</a>
                <a className="secondary-button" href={staticAssetPath("/")}>Scan a site</a>
              </>
            ) : (
              <span className={statusClassName}>
                <span className="status-dot" />
                {statusLabel}
              </span>
            )}
            <ThemeToggle />
          </div>
        </header>

        {corpusHighlights && corpusHighlights.attemptedSiteCount > 0 && !loaded && !loading && !error && (
          <CorpusHero highlights={corpusHighlights} />
        )}

        {!reportPage && (
          <section className="scan-workbench" id="scan">
            {LIVE_SCAN_ENABLED ? (
              scanForm
            ) : (
              <StaticPublicPanel onUploadReport={loadReportFile} onUploadError={setError} />
            )}

            <aside className="method-card">
              <div className="method-icon">
                <Shield size={20} aria-hidden="true" />
              </div>
              <div>
                <h2>Evidence, then interpretation</h2>
                <p>
                  Reports disclose their scan conditions and exactly which evidence families were captured or
                  unsupported. Recorded signals describe one visit, not a verdict about the site.
                </p>
              </div>
            </aside>
          </section>
        )}

        <ScanRecoveryBanner
          error={error}
          acceptedJob={Boolean(activeScanJob)}
          loading={loading}
          cancelling={cancellingScan}
          cancellationError={cancelScanError}
          onResume={() => void resumeActiveScan()}
          onCancel={() => void cancelActiveScan()}
        />

        <div id="report">
          <p className="visually-hidden" role="status" aria-live="polite">
            {reportReadyMessage}
          </p>
          {!loaded && !loading && !activeScanJob && (
            <EmptyState
              onPick={useExample}
              onUploadReport={loadReportFile}
              onUploadPageGraph={loadPageGraphFile}
              onUploadError={setError}
              onCreateComparison={(comparison) => {
                setLoading(false);
                setError(null);
                setLoaded(loadedFromV1Wire(comparison));
              }}
              onComparisonError={(message) => {
                setLoading(false);
                setLoaded(null);
                setError(message);
              }}
              liveScanEnabled={LIVE_SCAN_ENABLED}
              staticExport={STATIC_EXPORT}
              staticReports={staticReports}
              staticReportsError={staticReportsError}
            />
          )}
          {loading && (
            <LoadingState
              mode={
                !scanning
                  ? "opening"
                  : form.compareGpc
                    ? "gpc"
                    : form.compareShields
                      ? "shields"
                      : form.compareConsent
                        ? "consent"
                        : "single"
              }
              onCancel={activeScanJob ? () => void cancelActiveScan() : undefined}
              cancelling={cancellingScan}
              cancellationError={cancelScanError}
            />
          )}
          {loaded && reportView && primaryRun && displayedRun && (
            <section className="report-grid">
              <div className="report-main">
                <ReportHeader
                  share={loaded.wire.share ?? null}
                  view={reportView}
                  run={primaryRun}
                  evidenceRun={displayedRun}
                  csvArmLabel={arms ? armDisplayLabel(reportView, displayedArmLabel) : null}
                  onDownload={() => void downloadReport()}
                  onDownloadCsv={downloadCsv}
                  liveApiServesReportPages={liveApiServesReportPages}
                />
                <HeadlineBanner share={loaded.wire.share ?? null} view={reportView} liveApiServesReportPages={liveApiServesReportPages} />
                <FindingsBoard view={reportView} />
                {reportView.reportType === "comparison" && <ComparisonPanel view={reportView} />}
                {arms && (
                  // Two-arm audit switcher: every per-visit surface below (and
                  // the sidebar and CSV export) follows the selected arm, so
                  // the protected or rejected visit's evidence is inspectable
                  // without opening the JSON. The headline, findings, and
                  // comparison panel above stay pair-level.
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
                    {/* Announce arm switches to assistive technology: the
                        tables below swap silently otherwise. */}
                    <p className="visually-hidden" role="status" aria-live="polite">
                      {`Showing evidence from the ${armDisplayLabel(reportView, displayedArmLabel)} visit.`}
                    </p>
                  </div>
                )}
                <CausalityGraph requests={displayedRun.evidence.requests} />
                <MetricGrid run={displayedRun} />
                <TrafficViz run={displayedRun} />
                <VisitPhasesAndStateChanges run={displayedRun} />
                <Warnings warnings={reportView.warnings} />
              </div>

              <aside className="report-sidebar">
                {displayableScreenshot(displayedRun.screenshot) && (
                  <section className="side-card screenshot-card">
                    <h2>Viewport</h2>
                    {/* Only inline data URIs render: an uploaded report's
                        screenshot field must never drive a network request. */}
                    <img
                      src={displayableScreenshot(displayedRun.screenshot)!}
                      alt={`Screenshot of ${displayedRun.domain}`}
                      loading="lazy"
                      decoding="async"
                    />
                  </section>
                )}

                <section className="side-card">
                  <h2>Top Third Parties</h2>
                  <TopThirdParties domains={displayedRun.evidence.domains} />
                </section>

                {displayedRun.evidence.pixelEvents.length > 0 && (
                  <section className="side-card">
                    <h2>Advertising Pixels</h2>
                    <PixelEventsList pixels={displayedRun.evidence.pixelEvents} />
                  </section>
                )}

                <section className="side-card">
                  <h2>Cookies</h2>
                  <CookieList
                    cookies={displayedRun.evidence.cookies}
                    unsupported={familyUnsupportedOnRun(displayedRun, "cookies")}
                  />
                </section>

                <section className="side-card">
                  <h2>Storage</h2>
                  <StorageList
                    storage={displayedRun.evidence.storage}
                    unsupported={familyUnsupportedOnRun(displayedRun, "storage")}
                  />
                </section>

                <section className="side-card">
                  <h2>Browser Behavior Signals</h2>
                  <FingerprintList
                    events={displayedRun.evidence.fingerprintEvents}
                    detections={displayedRun.evidence.fingerprintDetections}
                    unsupported={
                      familyUnsupportedOnRun(displayedRun, "fingerprinting") ||
                      familyUnsupportedOnRun(displayedRun, "detector-output")
                    }
                  />
                </section>

                <section className="side-card methodology">
                  <h2>Methodology</h2>
                  <dl>
                    <div>
                      <dt>Schema</dt>
                      <dd>{schemaProvenanceLabel(reportView)}</dd>
                    </div>
                    <div>
                      <dt>Run quality</dt>
                      <dd>{runQualitySummary(displayedRun)}</dd>
                    </div>
                    <div>
                      <dt>Scanner</dt>
                      <dd>{displayedRun.conditions.automation}</dd>
                    </div>
                    <div>
                      <dt>Browser</dt>
                      <dd>{displayedRun.conditions.browserVersion ?? "not recorded"}</dd>
                    </div>
                    <div>
                      <dt>Timezone</dt>
                      <dd>{displayedRun.conditions.timezone}</dd>
                    </div>
                    <div>
                      <dt>Headless</dt>
                      <dd>{displayedRun.conditions.headless ? "yes" : "no"}</dd>
                    </div>
                    <div>
                      <dt>Viewport</dt>
                      <dd>
                        {displayedRun.conditions.viewport.width}×{displayedRun.conditions.viewport.height}
                      </dd>
                    </div>
                    <div>
                      <dt>GPC</dt>
                      <dd>{gpcMethodologyLabel(displayedRun)}</dd>
                    </div>
                    {displayedRun.consent && (
                      <div>
                        <dt>Consent</dt>
                        <dd>
                          {displayedRun.consent.controlActivated
                            ? `clicked "${consentChoiceLabel(displayedRun.consent.mode)}"${
                                displayedRun.consent.cmp ? ` (${displayedRun.consent.cmp})` : ""
                              }`
                            : "no banner control found; pre-consent"}
                          {/* Dispatch vs verification stay distinct, and the
                              reader-facing summary never exposes wire tokens. */}
                          {` · ${consentVerificationSummary(displayedRun.consent)}`}
                        </dd>
                      </div>
                    )}
                    <div>
                      <dt>Egress</dt>
                      <dd>{displayedRun.conditions.scannerEgress}</dd>
                    </div>
                    {displayedRun.conditions.trackerCatalog && (
                      <div>
                        <dt>Catalog</dt>
                        <dd>
                          {displayedRun.conditions.trackerCatalog.source}
                          <br />
                          {displayedRun.conditions.trackerCatalog.region
                            ? `${displayedRun.conditions.trackerCatalog.region} · `
                            : ""}
                          {displayedRun.conditions.trackerCatalog.version}
                          <br />
                          {displayedRun.conditions.trackerCatalog.entries.toLocaleString("en-US")} entries
                        </dd>
                      </div>
                    )}
                    {displayedRun.conditions.adblockLists && (
                      <div>
                        <dt>Brave Shields lists</dt>
                        <dd>
                          {displayedRun.conditions.adblockLists.source}
                          <br />
                          {displayedRun.conditions.adblockLists.lists.toLocaleString("en-US")} lists · fetched{" "}
                          {new Date(displayedRun.conditions.adblockLists.fetchedAt).toLocaleDateString("en-US", { timeZone: "UTC" })}
                        </dd>
                      </div>
                    )}
                  </dl>
                  {displayedRun.conditions.disclosure && <p>{displayedRun.conditions.disclosure}</p>}
                </section>
              </aside>

              <div className="report-evidence-tables" aria-label="Raw report evidence">
                <DomainTable domains={displayedRun.evidence.domains} />
                <RequestTable requests={displayedRun.evidence.requests} phases={displayedRun.phases} />
              </div>
            </section>
          )}
        </div>

        <footer className="app-footer">
          <span>
            Site Behavior Lab: open-source web transparency tooling.{" "}
            <a className="footer-link" href={staticAssetPath("/glossary/")}>
              Glossary
            </a>
            {" · "}
            <a className="footer-link" href={staticAssetPath("/methodology/")}>
              Methodology
            </a>
            {" · "}
            <a className="footer-link" href={staticAssetPath("/privacy/")}>
              Privacy
            </a>
          </span>
          <span>
            Reports use one completed automated visit per condition. On restart-safe deployments, an interrupted visit
            may be retried; attempts are never merged. Reproducible for this configuration, not a universal claim.
          </span>
        </footer>
      </main>
    </>
  );
}

function StaticPublicPanel({
  onUploadReport,
  onUploadError
}: {
  onUploadReport: (file: File | null) => Promise<void>;
  /** Surfaces picker-side rejections (e.g. the size cap) that never reach the upload handler. */
  onUploadError: (message: string) => void;
}) {
  return (
    <section className="scan-panel public-mode-panel" aria-labelledby="public-mode-title">
      <div className="public-mode-copy">
        <p className="eyebrow">Public report library</p>
        <h2 id="public-mode-title">Open saved site scans.</h2>
        <p>
          This hosted page shows reports that have already been scanned. New scans run in the full app, where a controlled
          browser can safely visit the site.
        </p>
      </div>
      <div className="public-mode-actions">
        <a className="primary-button" href="#report">
          <FileJson size={17} aria-hidden="true" />
          Browse reports
        </a>
        <ReportUploadButton onUploadReport={onUploadReport} onError={onUploadError}>
          Open report file
        </ReportUploadButton>
        {SCAN_WORKFLOW_URL && (
          <a className="secondary-button" href={SCAN_WORKFLOW_URL} target="_blank" rel="noreferrer" title="Requires repository access">
            <Github size={17} aria-hidden="true" />
            Maintainer scan
          </a>
        )}
      </div>
    </section>
  );
}

function CorpusHero({ highlights }: { highlights: CorpusHighlights }) {
  return (
    <section className="corpus-hero" aria-labelledby="corpus-hero-title">
      <p className="eyebrow">Transparency index</p>
      <h2 id="corpus-hero-title">What websites actually load: measured, not claimed.</h2>
      <p className="corpus-hero-lead">
        Across the committed library, we attempted controlled visits to {plural(highlights.attemptedSiteCount, "real site")}: {plural(highlights.loadedSiteCount, "site")} {highlights.loadedSiteCount === 1 ? "has" : "have"} at least one successful single run or primary comparison arm, while {plural(highlights.failedSiteCount, "site")} {highlights.failedSiteCount === 1 ? "has" : "have"} only failed or block-page primary visits. {plural(highlights.cappedSiteCount, "successfully loaded site")} {highlights.cappedSiteCount === 1 ? "has" : "have"} a request-capped recording in at least one successful primary arm, which remains visible as lower-bound evidence; each site counts once even when both primary arms loaded. The category medians below use {plural(highlights.eligibleSiteCount, "site")} with an eligible, request-complete passive lead visit. For each visit, we record the requests, cookies, and
        trackers it observes, then run its requests through <strong>Brave&rsquo;s own ad-block engine</strong> (the open-source{" "}
        <code>adblock-rust</code>, with Brave&rsquo;s default lists) to show which requests match the filter lists of
        Brave Shields, the ad and tracker blocker built into the Brave browser. Reproducible evidence, not a score.
      </p>
      {highlights.topCategories.length > 0 && (
        <div className="corpus-hero-cats">
          {highlights.topCategories.map((category) => (
            <div className="corpus-hero-cat" key={category.label}>
              <span className="corpus-hero-cat-num">{category.medianTrackers.toLocaleString("en-US")}</span>
              <span className="corpus-hero-cat-label">{category.label}</span>
            </div>
          ))}
          <span className="corpus-hero-cat-note">median catalogued tracking-service requests per site, by category</span>
        </div>
      )}
      <div className="corpus-hero-actions">
        <a className="primary-button" href={staticAssetPath("/directory/")}>
          See the breakdown by category
        </a>
        <a className="secondary-button" href="#report">
          Browse the report library
        </a>
      </div>
    </section>
  );
}

function safeFilenamePart(value: string): string {
  return value.replace(/[^a-z0-9.-]+/gi, "-").replace(/^-+|-+$/g, "") || "report";
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

function isStaticReportManifest(value: unknown): value is { reports: StaticReportManifestEntry[] } {
  if (!value || typeof value !== "object" || !Array.isArray((value as { reports?: unknown }).reports)) {
    return false;
  }

  return (value as { reports: unknown[] }).reports.every(isStaticReportManifestEntry);
}

function isStaticReportManifestEntry(value: unknown): value is StaticReportManifestEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<StaticReportManifestEntry> & { metrics?: Partial<StaticReportManifestEntry["metrics"]> };
  const metrics = entry.metrics;
  return (
    typeof entry.id === "string" &&
    typeof entry.title === "string" &&
    typeof entry.headline === "string" &&
    (entry.tone === "alarm" || entry.tone === "warn" || entry.tone === "info" || entry.tone === "calm") &&
    typeof entry.domain === "string" &&
    typeof entry.requestedUrl === "string" &&
    typeof entry.scannedAt === "string" &&
    (entry.reportType === "single" || entry.reportType === "comparison") &&
    (entry.device === "desktop" || entry.device === "mobile") &&
    (entry.historyKey === undefined || typeof entry.historyKey === "string") &&
    (entry.comparisonHistoryKey === undefined || typeof entry.comparisonHistoryKey === "string") &&
    metrics !== undefined &&
    typeof metrics.totalRequests === "number" &&
    typeof metrics.thirdPartyRequests === "number"
  );
}

/** Display label for one arm of a comparison view ("Shields off"). */
function armDisplayLabel(view: ReportView | null, arm: "baseline" | "variant"): string {
  return view?.comparison?.runLabels[arm] ?? arm;
}

/**
 * Wrap the gallery's locally built v1 temporal comparison as a LoadedReport,
 * using the LIGHT view builder so that legacy-only path never pulls the deep
 * validators into the bundle. PageGraph imports use the paired r2 reader.
 */
function loadedFromV1Wire(report: ScanReport): LoadedReport {
  return { source: "v1", wire: report, view: viewFromV1Report(report) };
}

function ThemeToggle() {
  const [theme, setTheme] = useState<"light" | "dark" | null>(null);

  useEffect(() => {
    const stored = document.documentElement.dataset.theme as "light" | "dark" | undefined;
    if (stored) {
      setTheme(stored);
    } else {
      setTheme(window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    }
  }, []);

  function toggle() {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("sbl-theme", next);
    } catch {
      /* ignore */
    }
  }

  return (
    <button className="icon-button" type="button" onClick={toggle} aria-label="Toggle colour theme">
      {theme === "dark" ? <Sun size={18} aria-hidden="true" /> : <Moon size={18} aria-hidden="true" />}
    </button>
  );
}

function EmptyState({
  onPick,
  onUploadReport,
  onUploadPageGraph,
  onUploadError,
  onCreateComparison,
  onComparisonError,
  liveScanEnabled,
  staticExport,
  staticReports,
  staticReportsError
}: {
  onPick: (url: string) => void;
  onUploadReport: (file: File | null) => Promise<void>;
  onUploadPageGraph: (selection: PageGraphUploadSelection) => Promise<void>;
  /** Surfaces picker-side rejections (e.g. the size cap) that never reach the upload handlers. */
  onUploadError: (message: string) => void;
  onCreateComparison: (comparison: ComparisonScanResult) => void;
  onComparisonError: (message: string) => void;
  liveScanEnabled: boolean;
  staticExport: boolean;
  staticReports: StaticReportManifestEntry[] | null;
  staticReportsError: string | null;
}) {
  const latestReport = staticReports?.[0] ?? null;

  return (
    <section className={`empty-state${staticExport ? " static-library-state" : ""}`}>
      <div className="empty-icon">
        <Radar size={28} aria-hidden="true" />
      </div>
      <h2>{liveScanEnabled ? "Ready to scan" : staticExport ? "Saved site reports" : "Ready to scan"}</h2>
      <p>
        {liveScanEnabled
          ? "Run a controlled browser visit and inspect the observable behavior from that one session."
          : staticExport
            ? "Open a saved report below, or open a report file someone shared with you."
            : "Run a controlled browser visit and inspect the observable behavior from that one session."}
      </p>
      {liveScanEnabled && (
        <div className="example-row">
          <span>Try</span>
          {EXAMPLES.map((example) => (
            <button key={example.url} type="button" className="example-chip" onClick={() => onPick(example.url)}>
              <span className="example-chip-url">{example.url}</span>
              <span className="example-chip-hint">{example.hint}</span>
            </button>
          ))}
        </div>
      )}
      {staticExport ? (
        <div className="static-tools">
          <div className="static-action-row">
            {latestReport && (
              <a className="primary-button" href={committedReportLocation(latestReport.id, clientReportRuntime()).pagePath}>
                <FileJson size={17} aria-hidden="true" />
                Open latest report
              </a>
            )}
            <ReportUploadButton onUploadReport={onUploadReport} onError={onUploadError}>
              Open report file
            </ReportUploadButton>
            {SCAN_WORKFLOW_URL && (
              <a className="secondary-button" href={SCAN_WORKFLOW_URL} target="_blank" rel="noreferrer" title="Requires repository access">
                <Github size={17} aria-hidden="true" />
                Maintainer scan
              </a>
            )}
          </div>
          <StaticReportGallery
            reports={staticReports}
            error={staticReportsError}
            onCreateComparison={onCreateComparison}
            onComparisonError={onComparisonError}
          />
        </div>
      ) : null}
      <div className="pagegraph-ingest">
        <div className="pagegraph-ingest-text">
          <Network size={16} aria-hidden="true" />
          <span>
            Have a Brave <strong>PageGraph</strong> capture? Open its <code>.graphml</code> and matching{" "}
            <code>.meta.json</code> sidecar for a request-only r2 report. Unsupported evidence families stay censored,
            never guessed.
          </span>
        </div>
        <PageGraphR2UploadButton onUploadPair={onUploadPageGraph} onError={onUploadError}>
          Open GraphML + meta.json
        </PageGraphR2UploadButton>
      </div>
    </section>
  );
}

const SCAN_CHECKS: { icon: typeof Eye; label: string; question: string }[] = [
  { icon: Radar, label: "Ad & tracking services", question: "Which advertising and analytics companies received requests?" },
  { icon: Cookie, label: "Third-party cookies", question: "Cookies that can recognize you across other sites?" },
  { icon: Network, label: "Named platforms", question: "Did data go to Google, Meta, TikTok, or X?" },
  { icon: Radar, label: "Google Analytics remarketing", question: "Is Google Analytics also feeding ad-remarketing audiences?" },
  { icon: Fingerprint, label: "Fingerprint-like API calls", question: "Calls to canvas, WebGL, or audio APIs used for device recognition?" },
  { icon: Eye, label: "Session-replay vendors", question: "Known session-recording tools present on the page?" },
  { icon: Keyboard, label: "Keystroke capture", question: "Is what you type into a form sent to a third party?" }
];

function LoadingState({
  mode,
  onCancel,
  cancelling = false,
  cancellationError = null
}: {
  mode: "single" | "gpc" | "shields" | "consent" | "opening";
  onCancel?: () => void;
  cancelling?: boolean;
  cancellationError?: string | null;
}) {
  const [elapsed, setElapsed] = useState(0);
  const isComparison = mode === "gpc" || mode === "shields" || mode === "consent";
  const isScanning = mode !== "opening";

  useEffect(() => {
    if (!isScanning) return;
    const startedAt = Date.now();
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [isScanning]);

  // Opening a saved report is a quick fetch, not a controlled browser visit, so it
  // gets a lightweight state without the elapsed timer or the "what we check" list.
  if (!isScanning) {
    return (
      <section className="loading-state" role="status">
        <span className="pulse-dot" />
        <h2>Opening saved report</h2>
        <p>Loading the saved evidence for this report.</p>
        <div className="progress-track" aria-hidden="true">
          <div className="progress-fill" />
        </div>
      </section>
    );
  }

  return (
    <section className="loading-state" aria-labelledby="scan-loading-title">
      <p className="visually-hidden" role="status">
        Scan started. Progress details are shown below.
      </p>
      <span className="pulse-dot" />
      <h2 id="scan-loading-title">
        {isComparison ? "Preparing two controlled browser visits" : "Preparing a controlled browser visit"}
      </h2>
      <p>
        {mode === "gpc"
          ? "Comparing GPC off and on runs for requests, cookies, storage, and browser API observations."
          : mode === "shields"
            ? "Comparing a normal visit against one with Brave Shields (the ad and tracker blocker built into the Brave browser) simulated on, across requests, cookies, storage, and browser API observations."
            : mode === "consent"
              ? 'Comparing a visit asked to click "Accept all" on the cookie banner against one asked to click "Reject all", across requests, cookies, storage, and browser API observations.'
              : "Collecting network requests, cookies, storage, and browser API observations."}
      </p>
      <div className="progress-track" aria-hidden="true">
        <div className="progress-fill" />
      </div>
      <p className="loading-elapsed">
        {elapsed}s elapsed
        {isComparison
          ? " · usually two visits, up to ~90s; queueing can take longer, as can one retry on restart-safe deployments"
          : " · usually up to ~45s; queueing can take longer, as can one retry on restart-safe deployments"}
      </p>
      {onCancel && (
        <button className="secondary-button" type="button" onClick={onCancel} disabled={cancelling}>
          {cancelling ? <Loader2 className="spin" size={16} aria-hidden="true" /> : null}
          {cancelling ? "Cancelling…" : "Cancel scan"}
        </button>
      )}
      {cancellationError && <p role="alert">{cancellationError} The scan is still running.</p>}
      <ul className="scan-checks">
        {SCAN_CHECKS.map((check) => {
          const Icon = check.icon;
          return (
            <li key={check.label}>
              <Icon size={16} aria-hidden="true" />
              <span>
                <strong>{check.label}</strong>
                {check.question}
              </span>
            </li>
          );
        })}
      </ul>
      <p className="scan-checks-note">
        Keystroke capture is tested by typing a synthetic value into the page&rsquo;s form fields (never submitting) and
        watching for it to be sent off-site. It covers fields on the loaded page, not flows behind login or extra steps.
      </p>
    </section>
  );
}
