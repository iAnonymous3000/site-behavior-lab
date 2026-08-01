"use client";

import {
  Cookie,
  ExternalLink,
  Eye,
  FileJson,
  Fingerprint,
  FlaskConical,
  Keyboard,
  Loader2,
  Network,
  Radar,
  Shield
} from "lucide-react";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import {
  PageGraphR2UploadButton,
  ReportUploadButton,
  type PageGraphUploadSelection
} from "./_components/file-upload-button";
import { ScanControls } from "./_components/scan-controls";
import { ScanRecoveryBanner } from "./_components/scan-recovery-banner";
import { ScheduledRescans } from "./_components/scheduled-rescans";
import { useScanRuntime } from "./_hooks/use-scan-runtime";
import { ThemeToggle } from "./_components/theme-toggle";
import {
  LIVE_SCAN_ENABLED,
  SCAN_WORKFLOW_URL,
  STATIC_EXPORT,
  clientReportRuntime,
  staticAssetPath
} from "./client-runtime";
import {
  corpusCohortDifferences,
  type CorpusCohortIdentity
} from "@/lib/corpus-cohort";
import { committedReportLocation } from "@/lib/report-locator";
import { scanJobProgressCopy } from "@/lib/scan-job-progress";
import {
  LatestClientOperation,
  MAX_DIRECTORY_JSON_BYTES,
  fetchJsonWithPolicy,
  parseJsonTextWithPolicy
} from "@/lib/client-fetch-policy";
import { BROWSER_PUBLIC_REPORT_JSON_MAX_BYTES } from "@/lib/report-resource-limits";
import { readClientFileText } from "@/lib/client-file-policy";
import { isStaticReportManifest } from "@/lib/static-report-manifest-guard";
import type { HomepageDiscovery, HomepageFeaturedGroup } from "@/lib/homepage-discovery";
import { plural } from "@/lib/text-format";
import { readLoadedReport, withoutLoadedReportShare } from "@/lib/client-report-reader";
// Type-only: the deep reader module stays lazy-loaded (client-report-reader);
// a type import is erased at build time and adds nothing to the bundle.
import type { LoadedReport } from "@/lib/scan-report-view";
import type { ScanJobProgress, StaticReportManifestEntry } from "@/lib/types";

const LazyStaticReportGallery = lazy(() =>
  import("./_components/static-gallery").then((module) => ({ default: module.StaticReportGallery }))
);
const LazyReportRenderer = lazy(() =>
  import("./_components/report-renderer").then((module) => ({ default: module.ReportRenderer }))
);

// Every hint restates evidence from a committed public-corpus report (the
// gallery carries the receipts), phrased as what was observed, never as a
// promise about the next visit. Update hints only from committed reports.
const EXAMPLES: { url: string; hint: string }[] = [
  { url: "weather.gov", hint: "typed text reached a third party" },
  { url: "webmd.com", hint: "980 third-party requests on record" },
  { url: "coolmathgames.com", hint: "kids' games, 164 third-party requests" },
  { url: "capitalone.com", hint: "bank with a cloaked tracker" },
  { url: "homedepot.com", hint: "Meta Pixel with an identity field" },
  { url: "wikipedia.org", hint: "zero third parties on record" }
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
  /** Distinct methodology cohorts those eligible sites span, one per category. */
  eligibleCohortCount: number;
  topCategories: { label: string; medianTrackers: number; cohort: CorpusCohortIdentity }[];
};

type SiteBehaviorAppProps = {
  corpusHighlights?: CorpusHighlights | null;
  /** Small server-selected homepage payload; never the full report manifest. */
  homepageDiscovery?: HomepageDiscovery | null;
};

export function SiteBehaviorApp({
  corpusHighlights = null,
  homepageDiscovery = null
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
    pendingScanAdmission,
    recoveringScanAdmission,
    activeScanProgress,
    cancellingScan,
    cancelScanError,
    scanNotice,
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
    recoverPendingAdmission,
    resumeActiveScan,
    cancelActiveScan,
    dismissActiveScan,
    stopWaitingForAdmission
  } = useScanRuntime({ reportPage: false, initialLoaded: null, initialError: null, initialLoading: false });
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
  const [staticReports, setStaticReports] = useState<StaticReportManifestEntry[] | null>(null);
  const [staticReportsError, setStaticReportsError] = useState<string | null>(null);
  const [archiveRequested, setArchiveRequested] = useState(false);
  const reportRegionRef = useRef<HTMLElement | null>(null);
  const recoveryBannerRef = useRef<HTMLElement | null>(null);
  const archiveOperationRef = useRef<LatestClientOperation | null>(null);
  const reportOpenOperationRef = useRef<LatestClientOperation | null>(null);
  if (!archiveOperationRef.current) archiveOperationRef.current = new LatestClientOperation();
  if (!reportOpenOperationRef.current) reportOpenOperationRef.current = new LatestClientOperation();
  const archiveOperation = archiveOperationRef.current;
  const reportOpenOperation = reportOpenOperationRef.current;

  useEffect(() => () => {
    archiveOperation.cancel();
    reportOpenOperation.cancel();
  }, [archiveOperation, reportOpenOperation]);

  // Every producer replaces the workbench state with a report. Announce that
  // transition at the shared result boundary instead of leaving focus on a
  // submit/upload control that may have disappeared.
  useEffect(() => {
    if (loaded) reportRegionRef.current?.focus();
  }, [loaded]);

  // A failure replaces the loading panel that held the focused Cancel button, so without
  // this a keyboard user is dropped to <body> at the top of the document exactly when the
  // recovery controls they now need are the thing to read.
  const scanFailure = error ?? cancelScanError;
  const hadScanFailure = useRef(false);
  useEffect(() => {
    if (scanFailure && !hadScanFailure.current) recoveryBannerRef.current?.focus();
    hadScanFailure.current = Boolean(scanFailure);
  }, [scanFailure]);

  async function loadStaticArchive() {
    setArchiveRequested(true);
    if (!STATIC_EXPORT || staticReports !== null) return;

    await archiveOperation.run(
      async (signal) => {
        const payload = await fetchJsonWithPolicy(staticAssetPath("/reports/index.json"), { cache: "no-store" }, {
          label: "Generated report index",
          maxBytes: MAX_DIRECTORY_JSON_BYTES,
          signal,
          httpError: () => new Error("Report manifest unavailable.")
        });
        if (!isStaticReportManifest(payload)) throw new Error("Generated report index was not valid.");
        return payload.reports;
      },
      {
        onStart: () => setStaticReportsError(null),
        onSuccess: (reports) => {
          setStaticReports(reports);
          setStaticReportsError(null);
        },
        onError: (readError) => {
          setStaticReports(null);
          setStaticReportsError(
            readError instanceof Error ? readError.message : "Generated report index is not available."
          );
        }
      }
    );
  }

  async function loadReportFile(file: File | null) {
    if (!file) return;
    await reportOpenOperation.run(
      async (signal) => {
        const contents = await readClientFileText(file, {
          label: "This report JSON",
          maxBytes: BROWSER_PUBLIC_REPORT_JSON_MAX_BYTES,
          signal
        });
        const payload = parseJsonTextWithPolicy(contents, "This report JSON");
        signal.throwIfAborted();
        const read = await readLoadedReport(payload, "This report JSON");
        signal.throwIfAborted();
        if (!read.ok) throw new Error(read.message);
        return withoutLoadedReportShare(read.loaded);
      },
      reportOpenHandlers("Report JSON could not be opened.")
    );
  }

  async function loadPageGraphFile(selection: PageGraphUploadSelection) {
    await reportOpenOperation.run(
      async (signal) => {
        // Code-split the strict r2 importer and graph parser so neither affects
        // the first-load bundle. The importer verifies the digest-bound sidecar.
        const { readPageGraphUpload } = await import("@/lib/pagegraph-client-import");
        const opened = await readPageGraphUpload(selection, signal);
        signal.throwIfAborted();
        return opened;
      },
      reportOpenHandlers("The PageGraph capture pair could not be opened.")
    );
  }

  function reportOpenHandlers(fallbackMessage: string) {
    return {
      onStart: () => {
        setLoading(true);
        setError(null);
        setLoaded(null);
      },
      onSuccess: setLoaded,
      onError: (readError: unknown) => {
        setError(readError instanceof Error ? readError.message : fallbackMessage);
      },
      onSettled: () => setLoading(false)
    };
  }

  function surfaceReportOperationError(message: string) {
    reportOpenOperation.cancel();
    setLoading(false);
    setError(message);
  }

  function acceptCreatedComparison(comparison: LoadedReport) {
    reportOpenOperation.cancel();
    setLoading(false);
    setError(null);
    setLoaded(comparison);
  }

  function rejectCreatedComparison(message: string) {
    reportOpenOperation.cancel();
    setLoading(false);
    setLoaded(null);
    setError(message);
  }

  const statusClassName = `status-pill${STATIC_EXPORT ? " status-pill-static" : ""}${
    LIVE_SCAN_ENABLED ? " status-pill-live" : ""
  }`;
  const scanControls = (
    <ScanControls
      form={form}
      setForm={setForm}
      onSubmit={(event) => {
        reportOpenOperation.cancel();
        void handleSubmit(event);
      }}
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
      turnstileUnsupported={turnstileUnsupported}
      awaitingTurnstile={awaitingTurnstile}
      gpcComparisonEnabled={gpcComparisonEnabled}
      shieldsComparisonEnabled={shieldsComparisonEnabled}
      consentComparisonEnabled={consentComparisonEnabled}
      scannerRequiresAccessKey={scannerRequiresAccessKey}
      onAccessKeyChange={updateAccessKey}
      examples={EXAMPLES}
      onPickExample={useExample}
      knownSites={homepageDiscovery?.knownSites ?? []}
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
        acceptedScanJob={Boolean(activeScanJob || pendingScanAdmission)}
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
      <div className="app-shell">
        <header className="topbar">
          <a className="brand" href={staticAssetPath("/")} aria-label="Site Behavior Lab home">
            <span className="brand-mark">
              <FlaskConical size={22} aria-hidden="true" />
            </span>
            <div>
              <p className="eyebrow">Site Behavior Lab</p>
              <h1>See what a site does, not just what it says.</h1>
            </div>
          </a>
          <div className="topbar-actions">
            {/* The library is the larger half of the product. Without this the only
                route to it is the footer, and Directory disappears entirely once a
                report loads. */}
            <nav className="topbar-nav" aria-label="Site">
              <a className="topbar-link" href={staticAssetPath("/directory/")}>
                Directory
              </a>
              <a className="topbar-link" href={staticAssetPath("/methodology/")}>
                Methodology
              </a>
              <a className="topbar-link" href={staticAssetPath("/glossary/")}>
                Glossary
              </a>
            </nav>
            <span className={statusClassName}>
              <span className="status-dot" />
              {statusLabel}
            </span>
            <ThemeToggle />
          </div>
        </header>

        <main>
          <section className="scan-workbench" id="scan">
            {LIVE_SCAN_ENABLED ? (
              scanForm
            ) : (
              <StaticPublicPanel onUploadReport={loadReportFile} onUploadError={surfaceReportOperationError} />
            )}

            <section className="method-card" aria-labelledby="method-card-title">
              <div className="method-icon">
                <Shield size={20} aria-hidden="true" />
              </div>
              <div>
                <h2 id="method-card-title">Evidence, then interpretation</h2>
                <p>
                  Reports disclose their scan conditions and exactly which evidence families were captured or
                  unsupported. Recorded signals describe one visit, not a verdict about the site.
                </p>
              </div>
            </section>
          </section>

        {corpusHighlights && corpusHighlights.attemptedSiteCount > 0 && !loaded && !loading && !error && !pendingScanAdmission && (
          <CorpusHero highlights={corpusHighlights} />
        )}

        <ScanRecoveryBanner
          bannerRef={recoveryBannerRef}
          error={error}
          notice={scanNotice}
          acceptedJob={Boolean(activeScanJob)}
          pendingAdmission={Boolean(pendingScanAdmission)}
          recoveringAdmission={recoveringScanAdmission}
          loading={loading}
          cancelling={cancellingScan}
          cancellationError={cancelScanError}
          onResume={() => void resumeActiveScan()}
          onCheckAdmission={() => void recoverPendingAdmission()}
          onCancel={() => void cancelActiveScan()}
          onDismiss={dismissActiveScan}
        />

          <section aria-label="Results" id="report" ref={reportRegionRef} tabIndex={-1}>
          {!loaded && !loading && !activeScanJob && !pendingScanAdmission && (
            <EmptyState
              onUploadReport={loadReportFile}
              onUploadPageGraph={loadPageGraphFile}
              onUploadError={surfaceReportOperationError}
              onCreateComparison={acceptCreatedComparison}
              onComparisonError={rejectCreatedComparison}
              liveScanEnabled={LIVE_SCAN_ENABLED}
              staticExport={STATIC_EXPORT}
              staticReports={staticReports}
              staticReportsError={staticReportsError}
              homepageDiscovery={homepageDiscovery}
              archiveRequested={archiveRequested}
              onLoadArchive={() => void loadStaticArchive()}
            />
          )}
          {loading && (
            <LoadingState
              mode={
                recoveringScanAdmission
                  ? "recovering"
                  : !scanning
                  ? "opening"
                  : form.compareGpc
                    ? "gpc"
                    : form.compareShields
                      ? "shields"
                      : form.compareConsent
                        ? "consent"
                        : "single"
              }
              // Before admission there is no job to cancel, but the visitor still needs
              // a way out of the wait, and the label must not promise a cancellation.
              onCancel={activeScanJob ? () => void cancelActiveScan() : stopWaitingForAdmission}
              cancelLabel={activeScanJob ? "Cancel scan" : "Stop waiting"}
              cancelling={cancellingScan}
              cancellationError={cancelScanError}
              progress={activeScanProgress}
            />
          )}
          {loaded && (
            <Suspense fallback={<p className="muted">Preparing the evidence explorer…</p>}>
              <LazyReportRenderer loaded={loaded} liveApiServesReportPages={liveApiServesReportPages} />
            </Suspense>
          )}
          </section>
        </main>

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
            {" · "}
            <a className="footer-link" href={staticAssetPath("/catalog/")}>
              Catalog
            </a>
            {" · "}
            <a className="footer-link" href={staticAssetPath("/status/")}>
              Status
            </a>
            {" · "}
            <a className="footer-link" href={staticAssetPath("/security/")}>
              Security
            </a>
            {" · "}
            <a className="footer-link" href={staticAssetPath("/corrections/")}>
              Corrections
            </a>
          </span>
          <span>
            Reports use one completed automated visit per condition. On restart-safe deployments, an interrupted visit
            may be retried; attempts are never merged. Reproducible for this configuration, not a universal claim.
          </span>
        </footer>
      </div>
    </>
  );
}

/**
 * The homepage sums per-category medians that each belong to ONE cohort, so
 * when the tiles span cohorts it must say so. Naming the cause matters: the
 * cohort key covers schema, methodology, tracker catalog, read-time ServiceRole
 * taxonomy, producer, and the requested GPC condition. Attributing a GPC split
 * to "different methodology generations" points the reader at the wrong thing.
 */
function cohortSplitNote(cohorts: readonly CorpusCohortIdentity[]): string {
  if (new Set(cohorts.map((cohort) => cohort.id)).size <= 1) return "";
  const differences = corpusCohortDifferences(cohorts);
  const cause =
    differences.length === 0
      ? "different measurement cohorts"
      : differences.length === 1
        ? differences[0]
        : `${differences.slice(0, -1).join(", ")} and ${differences[differences.length - 1]}`;
  return `. These categories were measured under ${cause}, so read each on its own rather than ranking them against each other.`;
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
          <a className="secondary-button" href={SCAN_WORKFLOW_URL} target="_blank" rel="noreferrer">
            <ExternalLink size={17} aria-hidden="true" />
            Maintainer scan (repository access)
            <span className="visually-hidden"> (opens in a new tab)</span>
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
        The public library covers {plural(highlights.loadedSiteCount, "successfully loaded site")} from controlled
        visits. Each report records request rows, cookie records, and service-catalog matches from one visit:
        reproducible evidence, not a privacy score or verdict.
      </p>
      {highlights.topCategories.length > 0 && (
        <div className="corpus-hero-cats">
          {highlights.topCategories.map((category) => (
            <div className="corpus-hero-cat" key={category.label}>
              <span className="corpus-hero-cat-num">{category.medianTrackers.toLocaleString("en-US")}</span>
              <span className="corpus-hero-cat-label">{category.label}</span>
            </div>
          ))}
          <span className="corpus-hero-cat-note">
            median third-party tracking-service requests per site, by category
            {cohortSplitNote(highlights.topCategories.map((category) => category.cohort))}
          </span>
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
      <details className="corpus-counting-disclosure">
        <summary>How coverage and category medians are counted</summary>
        <p>
          The committed library attempted {plural(highlights.attemptedSiteCount, "real site")}. {plural(highlights.failedSiteCount, "site")} only produced failed or block-page primary visits, and {plural(highlights.cappedSiteCount, "successfully loaded site")} had at least one request-capped recording that remains visible as lower-bound evidence. Category medians use {plural(highlights.eligibleSiteCount, "site")} with an eligible, request-complete passive lead visit. Each site counts once, even when a comparison loaded both arms. {highlights.eligibleCohortCount > 1
            ? `Those sites span ${highlights.eligibleCohortCount} methodology cohorts: each category publishes a single cohort, so a median is comparable within a category and not across them, and no one median covers all ${highlights.eligibleSiteCount} sites.`
            : "Every one of them was measured under a single methodology cohort."} Requests are also evaluated with the open-source <code>adblock-rust</code> engine and Brave&rsquo;s default filter lists.
        </p>
      </details>
    </section>
  );
}

function EmptyState({
  onUploadReport,
  onUploadPageGraph,
  onUploadError,
  onCreateComparison,
  onComparisonError,
  liveScanEnabled,
  staticExport,
  staticReports,
  staticReportsError,
  homepageDiscovery,
  archiveRequested,
  onLoadArchive
}: {
  onUploadReport: (file: File | null) => Promise<void>;
  onUploadPageGraph: (selection: PageGraphUploadSelection) => Promise<void>;
  /** Surfaces picker-side rejections (e.g. the size cap) that never reach the upload handlers. */
  onUploadError: (message: string) => void;
  onCreateComparison: (comparison: LoadedReport) => void;
  onComparisonError: (message: string) => void;
  liveScanEnabled: boolean;
  staticExport: boolean;
  staticReports: StaticReportManifestEntry[] | null;
  staticReportsError: string | null;
  homepageDiscovery: HomepageDiscovery | null;
  archiveRequested: boolean;
  onLoadArchive: () => void;
}) {
  const latestReport = homepageDiscovery?.latestReport ?? null;
  const archiveToolsRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (archiveRequested) archiveToolsRef.current?.focus();
  }, [archiveRequested]);

  return (
    <section className={`empty-state${staticExport ? " static-library-state" : ""}`}>
      <div className="empty-icon">
        <Radar size={28} aria-hidden="true" />
      </div>
      <h2>{homepageDiscovery ? "Explore measured evidence" : liveScanEnabled ? "Ready to scan" : "Saved site reports"}</h2>
      <p>
        {homepageDiscovery
          ? `${plural(homepageDiscovery.reportCount, "public report")} ${
              homepageDiscovery.reportCount === 1 ? "is" : "are"
            } available now. Open existing evidence instantly, or ${
              liveScanEnabled
                ? "scan a site above for a new controlled visit."
                : "open a report file someone shared with you."
            }`
          : liveScanEnabled
            ? "Run a controlled browser visit and inspect the observable behavior from that one session."
            : "Open a saved report, or open a report file someone shared with you."}
      </p>
      {homepageDiscovery && <HomepageFeaturedGallery groups={homepageDiscovery.featuredGroups} />}
      <div className="homepage-discovery-actions">
        {latestReport && (
          <a
            className="primary-button"
            href={committedReportLocation(latestReport.latestReportId, clientReportRuntime()).pagePath}
          >
            <FileJson size={17} aria-hidden="true" />
            Open latest report
          </a>
        )}
        <a className="secondary-button" href={staticAssetPath("/directory/")}>Browse all sites</a>
      </div>

      <details className="homepage-tools-disclosure">
        <summary>Open report files, PageGraph captures, or comparison tools</summary>
        <div className="homepage-tools">
          <div className="static-action-row">
            <ReportUploadButton onUploadReport={onUploadReport} onError={onUploadError}>
              Open report file
            </ReportUploadButton>
            <PageGraphR2UploadButton onUploadPair={onUploadPageGraph} onError={onUploadError}>
              Open GraphML + meta.json
            </PageGraphR2UploadButton>
            {SCAN_WORKFLOW_URL && (
              <a className="secondary-button" href={SCAN_WORKFLOW_URL} target="_blank" rel="noreferrer">
                <ExternalLink size={17} aria-hidden="true" />
                Maintainer scan (repository access)
                <span className="visually-hidden"> (opens in a new tab)</span>
              </a>
            )}
            {staticExport && !archiveRequested && (
              <button className="secondary-button" type="button" onClick={onLoadArchive}>
                Load saved-report tools
              </button>
            )}
          </div>
          <p className="homepage-tools-note">
            PageGraph imports require a <code>.graphml</code> file and its matching <code>.meta.json</code> sidecar.
            Browser imports are capped at 8 MB for report JSON, 16 MB for GraphML, and 256 KB for metadata.
            Unsupported evidence families remain censored rather than guessed.
          </p>
          {staticExport && archiveRequested && (
            <section aria-label="Saved-report tools" ref={archiveToolsRef} tabIndex={-1}>
              <Suspense fallback={<p className="muted" role="status">Loading saved-report tools…</p>}>
                <LazyStaticReportGallery
                  reports={staticReports}
                  error={staticReportsError}
                  onRetry={() => {
                    archiveToolsRef.current?.focus();
                    onLoadArchive();
                  }}
                  onCreateComparison={onCreateComparison}
                  onComparisonError={onComparisonError}
                />
              </Suspense>
            </section>
          )}
        </div>
      </details>
    </section>
  );
}

function HomepageFeaturedGallery({ groups }: { groups: HomepageFeaturedGroup[] }) {
  if (groups.length === 0) return null;

  return (
    <section className="featured-gallery homepage-featured-gallery" aria-labelledby="featured-title">
      <div className="featured-heading">
        <p className="eyebrow">Start here</p>
        <h3 id="featured-title">Real sites, already scanned</h3>
        <p>Each category gets a place before any category receives a second card.</p>
      </div>
      <div className="homepage-featured-groups">
        {groups.map((group) => (
          <div className="featured-group" key={group.id}>
            <h4>{group.label}</h4>
            <div className="featured-cards">
              {group.items.map((item) => (
                <a
                  className={`featured-card tone-${item.tone}`}
                  href={committedReportLocation(item.id, clientReportRuntime()).pagePath}
                  key={item.id}
                >
                  <span className="featured-card-top">
                    <span className="featured-card-site">{item.siteLabel}</span>
                    {!item.requestEvidenceComplete && (
                      <span className="capped-chip">
                        {item.requestCapped ? "recording capped" : "request evidence incomplete"}
                      </span>
                    )}
                    <span className="featured-card-dot" aria-hidden="true" />
                  </span>
                  <span className="featured-card-headline">{item.headline}</span>
                  <span className="featured-card-stats">
                    <span className="featured-card-stat">
                      {!item.requestEvidenceComplete && "at least "}
                      <b>{item.thirdPartyRequests.toLocaleString("en-US")}</b> third-party requests
                    </span>
                    <span className="featured-card-stat">
                      {!item.requestEvidenceComplete && "at least "}
                      <b>{item.trackerRequests.toLocaleString("en-US")}</b> third-party tracking-service requests
                    </span>
                  </span>
                </a>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

const SCAN_CHECKS: { icon: typeof Eye; label: string; question: string }[] = [
  { icon: Radar, label: "Catalog matches", question: "Which request rows matched the reviewed service catalog, and what roles does that catalog assign?" },
  { icon: Cookie, label: "Third-party cookie records", question: "Which cookie records crossed the site's registrable-domain boundary?" },
  { icon: Network, label: "Named platforms", question: "Were requests dispatched to catalogued Google, Meta, TikTok, or X domains?" },
  { icon: Radar, label: "Google Analytics remarketing", question: "Did the scan see the Analytics-to-DoubleClick request marker?" },
  { icon: Fingerprint, label: "Fingerprint-like API calls", question: "Did canvas, WebGL, or audio behavior cross a documented heuristic threshold?" },
  { icon: Eye, label: "Session-replay signals", question: "Did a catalogued service appear or broad interaction listeners register?" },
  { icon: Keyboard, label: "Synthetic input check", question: "Did the test value appear in a cross-site request before form submission?" }
];

function LoadingState({
  mode,
  onCancel,
  cancelLabel = "Cancel scan",
  cancelling = false,
  cancellationError = null,
  progress = null
}: {
  mode: "single" | "gpc" | "shields" | "consent" | "opening" | "recovering";
  onCancel?: () => void;
  cancelLabel?: string;
  cancelling?: boolean;
  cancellationError?: string | null;
  progress?: ScanJobProgress | null;
}) {
  const isScanning = mode !== "opening" && mode !== "recovering";
  const scanningRegionRef = useRef<HTMLElement | null>(null);

  // Submitting disables the Scan button while it still holds focus, which browsers
  // resolve by blurring to <body>. Without this a keyboard user is dropped to the top
  // of the document for the length of the scan, with the cancel control they now need
  // sitting behind the entire header and form.
  useEffect(() => {
    if (isScanning) scanningRegionRef.current?.focus();
  }, [isScanning]);

  // Opening a saved report is a quick fetch, not a controlled browser visit, so it
  // gets a lightweight state without the elapsed timer or the "what we check" list.
  // Admission recovery reuses the same lightweight shape but must not claim to be
  // opening a report: at that point it is still asking whether a scan was accepted.
  if (!isScanning) {
    return (
      <section className="loading-state" role="status">
        <span className="pulse-dot" />
        <h2>{mode === "recovering" ? "Checking the previous scan request" : "Opening saved report"}</h2>
        <p>
          {mode === "recovering"
            ? "Asking whether the previous scan request was accepted before starting anything new."
            : "Loading the saved evidence for this report."}
        </p>
        <div className="progress-track" aria-hidden="true">
          <div className="progress-fill" />
        </div>
      </section>
    );
  }

  const progressCopy = scanJobProgressCopy(progress);

  return (
    <section
      className="loading-state"
      aria-labelledby="scan-loading-title"
      ref={scanningRegionRef}
      tabIndex={-1}
    >
      <p className="visually-hidden" role="status" aria-live="polite">
        {progressCopy.title}. {progressCopy.completedRuns ?? "Progress details are shown below."}
      </p>
      <span className="pulse-dot" />
      <h2 id="scan-loading-title">{progressCopy.title}</h2>
      <p>{progressCopy.detail}</p>
      <div className="progress-track" aria-hidden="true">
        <div className="progress-fill" />
      </div>
      {progressCopy.completedRuns && <p className="loading-elapsed">{progressCopy.completedRuns}</p>}
      {onCancel && (
        <button className="secondary-button" type="button" onClick={onCancel} disabled={cancelling}>
          {cancelling ? <Loader2 className="spin" size={16} aria-hidden="true" /> : null}
          {cancelling ? "Cancelling…" : cancelLabel}
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
        watching for it to appear in a request to another registrable domain during typing, blur, or unload. A match
        proves that synthetic value crossed the domain boundary, not why it was sent. It covers fields on the loaded
        page, not flows behind login or extra steps.
      </p>
    </section>
  );
}
