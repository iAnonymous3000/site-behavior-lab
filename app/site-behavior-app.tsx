"use client";

import {
  Cookie,
  ExternalLink,
  Eye,
  FileJson,
  Fingerprint,
  Keyboard,
  Loader2,
  Network,
  Radar
} from "lucide-react";
import { lazy, Suspense, useEffect, useRef, useState } from "react";

const GATE_PROOF_PADDING = "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";
if (typeof window !== "undefined") (window as unknown as { gateProof?: string }).gateProof = GATE_PROOF_PADDING;
import {
  PageGraphR2UploadButton,
  ReportUploadButton,
  type PageGraphUploadSelection
} from "./_components/file-upload-button";
import { ScanControls } from "./_components/scan-controls";
import { SiteChrome } from "./_components/site-chrome";
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
import { corpusCohortDifferences } from "@/lib/corpus-cohort-differences";
import type { CorpusCohortIdentity } from "@/lib/corpus-cohort";
import { committedReportLocation } from "@/lib/report-locator";
import { HEADLINE_PLATFORMS } from "@/lib/headline-platforms";
import { humanList } from "@/lib/text-format";
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
import { readLoadedReport, asLocalReport } from "@/lib/client-report-reader";
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
        return asLocalReport(read.loaded);
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
    <SiteChrome
      activePath="/"
      actions={
        <span className={statusClassName}>
          <span className="status-dot" />
          {statusLabel}
        </span>
      }
      skipToId="report"
    >
          <section className="scan-workbench" id="scan">
            <div className="workbench-lede">
              {/* The product's one-line thesis is a page heading now, not a
                  wordmark subtitle inside the brand link. The brand anchor used
                  to wrap this <h1> and override it with its own aria-label,
                  which left every other route free to own a second <h1>. */}
              <h1>See what a site does, not just what it says.</h1>
              <p>
                Run a controlled Chromium visit and read what the page actually loaded: request rows, cookie records,
                service-catalog matches and browser signals from that one visit.
              </p>
            </div>
            {LIVE_SCAN_ENABLED ? (
              scanForm
            ) : (
              <StaticPublicPanel onUploadReport={loadReportFile} onUploadError={surfaceReportOperationError} />
            )}

            {/* What the reader gets for the URL they type, beside the control
                that produces it. This column used to hold a decorative card
                restating the methodology page's thesis; the checks are what
                a first-time reader needs to decide whether to run one. */}
            <section className="method-card" aria-labelledby="method-card-title">
              <p className="eyebrow">One controlled visit records</p>
              <h2 id="method-card-title">Evidence, then interpretation</h2>
              <ul className="method-list">
                {SCAN_CHECKS.map((check) => (
                  <li key={check.label}>
                    <strong>{check.label}</strong>
                    <span>{check.question}</span>
                  </li>
                ))}
              </ul>
              <p className="method-note">
                Every report records its own conditions and which evidence families were captured, censored or
                unsupported. Signals describe one visit, not a verdict about the site.
              </p>
            </section>
          </section>

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
              corpusHighlights={corpusHighlights}
              archiveRequested={archiveRequested}
              onLoadArchive={() => void loadStaticArchive()}
            />
          )}
          {loading && (
            <LoadingState
              // recoveringScanAdmission stays true for the whole resumed scan (it is
              // cleared in the recovery finally, after resumeRuntimeScan returns), so
              // this must also require !scanning. Without that the resumed run loses its
              // progress bar and its Cancel control for minutes.
              mode={
                recoveringScanAdmission && !scanning
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
    </SiteChrome>
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

/**
 * The library's numbers, as a strip under the library heading rather than a
 * hero of their own. Same class names as before: the print stylesheet hides
 * this block by name, and the guard that pins that reads the class here.
 */
function CorpusHero({ highlights }: { highlights: CorpusHighlights }) {
  return (
    <div className="corpus-hero">
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
      <details className="corpus-counting-disclosure">
        <summary>How coverage and category medians are counted</summary>
        <p>
          The committed library attempted {plural(highlights.attemptedSiteCount, "real site")}. {plural(highlights.failedSiteCount, "site")} only produced failed or block-page primary visits, and {plural(highlights.cappedSiteCount, "successfully loaded site")} had at least one request-capped recording that remains visible as lower-bound evidence. Category medians use {plural(highlights.eligibleSiteCount, "site")} with an eligible, request-complete passive lead visit. Each site counts once, even when a comparison loaded both arms. {highlights.eligibleCohortCount > 1
            ? `Those sites span ${highlights.eligibleCohortCount} methodology cohorts: each category publishes a single cohort, so a median is comparable within a category and not across them, and no one median covers all ${highlights.eligibleSiteCount} sites.`
            : "Every one of them was measured under a single methodology cohort."} Requests are also evaluated with the open-source <code>adblock-rust</code> engine and Brave&rsquo;s default filter lists.
        </p>
      </details>
    </div>
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
  corpusHighlights,
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
  corpusHighlights: CorpusHighlights | null;
  archiveRequested: boolean;
  onLoadArchive: () => void;
}) {
  const latestReport = homepageDiscovery?.latestReport ?? null;
  const highlights =
    corpusHighlights && corpusHighlights.attemptedSiteCount > 0 ? corpusHighlights : null;
  const archiveToolsRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (archiveRequested) archiveToolsRef.current?.focus();
  }, [archiveRequested]);

  // The library is the second half of the product and used to be presented
  // as the scan form's empty state: an icon, "Explore measured evidence", and
  // the featured cards inside it. A first-time reader arrives for the
  // evidence more often than for the scanner, so it is a section with its
  // own heading, counts, and actions, and the tools it also carried sit at
  // the end where a returning reader knows to look.
  return (
    <section
      className={`empty-state${staticExport ? " static-library-state" : ""}`}
      aria-labelledby="library-title"
    >
      <div className="page-section-heading">
        <div>
          <p className="eyebrow">Public library</p>
          <h2 id="library-title">
            {homepageDiscovery
              ? highlights
                ? `${plural(highlights.loadedSiteCount, "site")} with a successful load, ${plural(
                    homepageDiscovery.reportCount,
                    "report"
                  )} on record`
                : `${plural(homepageDiscovery.reportCount, "public report")} on record`
              : liveScanEnabled
                ? "Ready to scan"
                : "Saved site reports"}
          </h2>
        </div>
        <p>
          {homepageDiscovery
            ? liveScanEnabled
              ? "Reproducible evidence from controlled visits, not a score. Open a report, or scan a site above."
              : "Reproducible evidence from controlled visits, not a score. Open a report, or open one shared with you."
            : liveScanEnabled
              ? "Run a controlled browser visit and inspect the observable behavior from that one session."
              : "Open a saved report, or open a report file someone shared with you."}
        </p>
      </div>
      {highlights && <CorpusHero highlights={highlights} />}
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
        <p>One lead finding per site, from its newest retained visit. Each category gets a place before any category receives a second card.</p>
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
  {
    icon: Network,
    label: "Named platforms",
    // Derived, not restated: this sentence was a hand-written copy that named
    // four platforms and went stale when Microsoft, LinkedIn, and Pinterest
    // joined the shared constant, so the homepage advertised less than the
    // report actually checks.
    question: `Were requests dispatched to catalogued ${humanList(
      HEADLINE_PLATFORMS,
      HEADLINE_PLATFORMS.length
    )} domains?`
  },
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
        watching for it to appear in a request to another registrable domain during typing, blur, or the wait after. A match
        proves that synthetic value crossed the domain boundary, not why it was sent. It covers fields on the loaded
        page, not flows behind login or extra steps.
      </p>
    </section>
  );
}
