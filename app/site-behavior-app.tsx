"use client";

import { Check, Copy, ExternalLink, FileJson } from "lucide-react";
import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import {
  PageGraphR2UploadButton,
  ReportUploadButton,
  type PageGraphUploadSelection
} from "./_components/file-upload-button";
import { ScanControls } from "./_components/scan-controls";
import { SiteChrome } from "./_components/site-chrome";
import { ScanRecoveryBanner } from "./_components/scan-recovery-banner";
import { useScanRuntime } from "./_hooks/use-scan-runtime";
import {
  LIVE_SCAN_API_BASE,
  LIVE_SCAN_ENABLED,
  SCAN_WORKFLOW_URL,
  STATIC_BASE_PATH,
  STATIC_EXPORT,
  clientReportRuntime,
  staticAssetPath
} from "./client-runtime";
import { corpusCohortDifferences } from "@/lib/corpus-cohort-differences";
import type { CorpusCohortIdentity } from "@/lib/corpus-cohort";
import { committedReportLocation } from "@/lib/report-locator";
import { SCAN_CHECKS } from "@/lib/scan-checks";
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
import { OPEN_LATEST_REPORT_LABEL } from "@/lib/homepage-labels";
import { plural } from "@/lib/text-format";
import { readLoadedReport, asLocalReport } from "@/lib/client-report-reader";
// Type-only: the deep reader module stays lazy-loaded (client-report-reader);
// a type import is erased at build time and adds nothing to the bundle.
import type { LoadedReport } from "@/lib/scan-report-view";
import type { StaticReportManifestEntry } from "@/lib/types";
import { resolveV3DynamicPageUrl } from "@/lib/v3/client-urls";
import type { ScanReportV3 } from "@/lib/v3/schema";

const LazyStaticReportGallery = lazy(() =>
  import("./_components/static-gallery").then((module) => ({ default: module.StaticReportGallery }))
);
const LazyReportRenderer = lazy(() =>
  import("./_components/report-renderer").then((module) => ({ default: module.ReportRenderer }))
);
const LazyReportViewV3 = lazy(() =>
  import("./_components/v3/ReportViewV3").then((module) => ({ default: module.ReportViewV3 }))
);

const V3_LOCATION = {
  staticExport: STATIC_EXPORT,
  scanApiBase: LIVE_SCAN_API_BASE,
  basePath: STATIC_BASE_PATH
};

// Every hint restates evidence from a committed public-corpus report (the
// gallery carries the receipts), phrased as what was observed, never as a
// promise about the next visit. Update hints only from committed reports.
const EXAMPLES: { url: string; hint: string }[] = [
  { url: "weather.gov", hint: "typed text reached a third party" },
  { url: "webmd.com", hint: "at least 980 third-party requests on record" },
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
  /** What a scan does to the page, rendered by the server page (app/page.tsx). */
  scanDisclosure?: ReactNode;
  /** What one controlled visit records, rendered by the server page, for the first screen. */
  visitRecords?: ReactNode;
  /** The latest report as a record, rendered by the server page, or null. */
  frontRecord?: ReactNode;
  /** Each featured report's marks by report id, rendered by the server page. */
  rowMarks?: Record<string, ReactNode>;
  /** The key under the site rows, rendered by the server page. */
  rowKey?: ReactNode;
};

export function SiteBehaviorApp({
  corpusHighlights = null,
  homepageDiscovery = null,
  scanDisclosure = null,
  visitRecords = null,
  frontRecord = null,
  rowMarks = {},
  rowKey = null
}: SiteBehaviorAppProps) {
  const {
    form,
    setForm,
    loaded,
    setLoaded,
    liveV3Result,
    setLiveV3Result,
    error,
    setError,
    loading,
    setLoading,
    scanning,
    scanNotice,
    turnstileResetNonce,
    setTurnstileToken,
    urlNotice,
    urlError,
    prefilledUrl,
    prefilledMode,
    clearUrlNotice,
    policy,
    scannerStatus,
    statusLabel,
    retryScannerHealth,
    handleSubmit,
    useExample,
    updateAccessKey,
    cancelActiveScan,
    dismissBanner
  } = useScanRuntime({ reportPage: false, initialLoaded: null, initialError: null, initialLoading: false });
  const {
    gpcComparisonEnabled,
    shieldsComparisonEnabled,
    consentComparisonEnabled,
    liveApiServesReportPages,
    scannerRequiresAccessKey,
    turnstileRequired,
    turnstileUnsupported,
    awaitingTurnstile,
    awaitingScannerHealth,
    scannerUnavailable,
    scanBlocked,
    shareReportMaxAgeDays
  } = policy;
  const [staticReports, setStaticReports] = useState<StaticReportManifestEntry[] | null>(null);
  const [staticReportsError, setStaticReportsError] = useState<string | null>(null);
  const [archiveRequested, setArchiveRequested] = useState(false);
  const [uploadedV3, setUploadedV3] = useState<ScanReportV3 | null>(null);
  const reportRegionRef = useRef<HTMLElement | null>(null);
  const recoveryBannerRef = useRef<HTMLElement | null>(null);
  const archiveOperationRef = useRef<LatestClientOperation | null>(null);
  const reportOpenOperationRef = useRef<LatestClientOperation | null>(null);
  if (!archiveOperationRef.current) archiveOperationRef.current = new LatestClientOperation();
  if (!reportOpenOperationRef.current) reportOpenOperationRef.current = new LatestClientOperation();
  const archiveOperation = archiveOperationRef.current;
  const reportOpenOperation = reportOpenOperationRef.current;

  const activeV3Report = liveV3Result?.report ?? uploadedV3;
  const activeV3Permalink = liveV3Result
    ? resolveV3DynamicPageUrl(liveV3Result.sharePath, V3_LOCATION)
    : null;

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

  useEffect(() => {
    if (loaded) {
      setUploadedV3(null);
      setLiveV3Result(null);
    }
  }, [loaded, setLiveV3Result]);

  useEffect(() => {
    if (activeV3Report) reportRegionRef.current?.focus();
  }, [activeV3Report]);

  // A failure replaces the loading panel that held the focused Cancel button, so without
  // this a keyboard user is dropped to <body> at the top of the document exactly when the
  // error notice they now need is the thing to read.
  const scanFailure = error;
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
        if (payload && typeof payload === "object" && (payload as { schemaVersion?: unknown }).schemaVersion === 3) {
          const { validateScanReportV3 } = await import("@/lib/v3/schema");
          signal.throwIfAborted();
          const issues = validateScanReportV3(payload as ScanReportV3);
          if (issues.length > 0) {
            throw new Error(`Multi-arm report JSON is invalid: ${issues[0]}`);
          }
          setLoaded(null);
          setLiveV3Result(null);
          setUploadedV3(payload as ScanReportV3);
          return null;
        }
        const read = await readLoadedReport(payload, "This report JSON");
        signal.throwIfAborted();
        if (!read.ok) throw new Error(read.message);
        return asLocalReport(read.loaded);
      },
      {
        onStart: () => {
          setLoading(true);
          setError(null);
          setLoaded(null);
          setLiveV3Result(null);
          setUploadedV3(null);
        },
        onSuccess: (next) => {
          if (next) setLoaded(next);
        },
        onError: (readError: unknown) => {
          setError(readError instanceof Error ? readError.message : "Report JSON could not be opened.");
        },
        onSettled: () => setLoading(false)
      }
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
        setLiveV3Result(null);
        setUploadedV3(null);
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
    setLiveV3Result(null);
    setUploadedV3(null);
    setLoaded(comparison);
  }

  function rejectCreatedComparison(message: string) {
    reportOpenOperation.cancel();
    setLoading(false);
    setLoaded(null);
    setLiveV3Result(null);
    setUploadedV3(null);
    setError(message);
  }

  function clearV3Report() {
    setLiveV3Result(null);
    setUploadedV3(null);
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
        setUploadedV3(null);
        void handleSubmit(event);
      }}
      loading={loading}
      scanBlocked={scanBlocked}
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
      awaitingScannerHealth={awaitingScannerHealth}
      scannerRequiresAccessKey={scannerRequiresAccessKey}
      onAccessKeyChange={updateAccessKey}
      examples={EXAMPLES}
      onPickExample={useExample}
      knownSites={homepageDiscovery?.knownSites ?? []}
      prefilledUrl={prefilledUrl}
      shareReportMaxAgeDays={shareReportMaxAgeDays}
      prefilledMode={prefilledMode}
      disclosure={scanDisclosure}
    />
  );
  const scanForm = (
    <div className="scan-panel-stack">
      {scanControls}
      {/* After the form in the source, so a phone reads it after More
          options; a wide screen lays it in the limit column under the scan
          disclosure (app/_design/home.css). */}
      {visitRecords}
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
      /* "da" opts this route into the direction A stylesheet (app/_design/). */
      shellClassName="da"
    >
      <section className="scan-workbench" id="scan">
        <div className="workbench-lede">
          <h1>See what a site does, not just what it says.</h1>
          <p>
            Run a controlled Chromium visit and read what the page actually loaded: request rows, cookie records,
            service-catalog matches and browser signals from that one visit.
          </p>
        </div>
        {LIVE_SCAN_ENABLED ? (
          scanForm
        ) : (
          <>
            <StaticPublicPanel onUploadReport={loadReportFile} onUploadError={surfaceReportOperationError} />
            {visitRecords}
          </>
        )}
      </section>

      <ScanRecoveryBanner
        bannerRef={recoveryBannerRef}
        error={error}
        notice={scanNotice}
        onDismiss={dismissBanner}
      />

      <section aria-label="Results" id="report" ref={reportRegionRef} tabIndex={-1}>
        {activeV3Report && !loaded && !loading && (
          <Suspense fallback={<p className="muted">Preparing multi-arm report view…</p>}>
            <div className="homepage-discovery-actions">
              {activeV3Permalink && (
                <>
                  <a className="primary-button" href={activeV3Permalink}>
                    Open permalink
                  </a>
                  <SharePermalinkCopyButton href={activeV3Permalink} />
                </>
              )}
              <button type="button" className="secondary-button" onClick={clearV3Report}>
                Back to library
              </button>
            </div>
            <LazyReportViewV3 key={activeV3Report.reportId} embedded report={activeV3Report} />
          </Suspense>
        )}
        {!activeV3Report && (
          <>
            {!loaded && !loading && frontRecord}
            {!loaded && !loading && (
              <EmptyState
                rowMarks={rowMarks}
                rowKey={rowKey}
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
          </>
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
            onCancel={scanning ? cancelActiveScan : undefined}
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

function SharePermalinkCopyButton({ href }: { href: string }) {
  const [copied, setCopied] = useState(false);

  async function copyPermalink() {
    const absolute =
      typeof window !== "undefined" ? new URL(href, window.location.origin).toString() : href;
    try {
      await navigator.clipboard.writeText(absolute);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <button
      className="secondary-button"
      type="button"
      aria-live="polite"
      onClick={() => void copyPermalink()}
    >
      {copied ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
      {copied ? "Copied" : "Copy link"}
      <span className="visually-hidden"> (share link)</span>
    </button>
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
  return `. These categories were measured under ${cause}: they are shown highest median first, but a median is comparable within a category and not across them.`;
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
  rowMarks,
  rowKey,
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
  rowMarks: Record<string, ReactNode>;
  rowKey: ReactNode;
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
      {homepageDiscovery && (
        <HomepageFeaturedGallery groups={homepageDiscovery.featuredGroups} rowMarks={rowMarks} rowKey={rowKey} />
      )}
      <div className="homepage-discovery-actions">
        {latestReport && (
          <a
            className="primary-button"
            href={committedReportLocation(latestReport.latestReportId, clientReportRuntime()).pagePath}
          >
            <FileJson size={17} aria-hidden="true" />
            {OPEN_LATEST_REPORT_LABEL}
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

function HomepageFeaturedGallery({
  groups,
  rowMarks,
  rowKey
}: {
  groups: HomepageFeaturedGroup[];
  rowMarks: Record<string, ReactNode>;
  rowKey: ReactNode;
}) {
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
                <div className="featured-card" key={item.id}>
                  <a
                    className="featured-card-site"
                    href={committedReportLocation(item.id, clientReportRuntime()).pagePath}
                  >
                    {item.siteLabel}
                  </a>
                  <span className="featured-card-headline">{item.headline}</span>
                  {!item.requestEvidenceComplete && (
                    <span className="capped-chip">
                      {item.requestCapped ? "recording capped" : "request evidence incomplete"}
                    </span>
                  )}
                  <span className="featured-card-stats">
                    {rowMarks[item.id]}
                    <span className="featured-card-stat">
                      {!item.requestEvidenceComplete && "at least "}
                      <b>{item.thirdPartyRequests.toLocaleString("en-US")}</b> third-party{" "}
                      {item.thirdPartyRequests === 1 ? "request" : "requests"}
                    </span>
                    <span className="featured-card-stat">
                      {!item.requestEvidenceComplete && "at least "}
                      <b>{item.trackerRequests.toLocaleString("en-US")}</b> third-party tracking-service{" "}
                      {item.trackerRequests === 1 ? "request" : "requests"}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      {rowKey}
    </section>
  );
}

function loadingCopy(mode: "single" | "gpc" | "shields" | "consent"): { title: string; detail: string } {
  if (mode === "gpc") {
    return {
      title: "Running GPC comparison visits",
      detail: "Launching isolated Chromium arms with and without Global Privacy Control (Sec-GPC: 1)."
    };
  }
  if (mode === "shields") {
    return {
      title: "Running blocker comparison visits",
      detail: "Launching isolated Chromium arms normally and with Brave's adblock-rust filter lists actively blocking."
    };
  }
  if (mode === "consent") {
    return {
      title: "Running consent comparison visits",
      detail: "Launching isolated Chromium arms attempting Accept all and Reject all on the consent banner."
    };
  }
  return {
    title: "Running controlled browser visit",
    detail: "Recording passive load, scroll-triggered requests, cookies, storage, CNAME chains, beacon decoding, and form-field probe coverage."
  };
}

function LoadingState({
  mode,
  onCancel
}: {
  mode: "single" | "gpc" | "shields" | "consent" | "opening";
  onCancel?: () => void;
}) {
  const isScanning = mode !== "opening";
  const scanningRegionRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (isScanning) scanningRegionRef.current?.focus();
  }, [isScanning]);

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

  const copy = loadingCopy(mode);

  return (
    <section
      className="loading-state"
      aria-labelledby="scan-loading-title"
      ref={scanningRegionRef}
      tabIndex={-1}
    >
      <p className="visually-hidden" role="status" aria-live="polite">
        {copy.title}. Progress details are shown below.
      </p>
      <span className="pulse-dot" />
      <h2 id="scan-loading-title">{copy.title}</h2>
      <p>{copy.detail}</p>
      <div className="progress-track" aria-hidden="true">
        <div className="progress-fill" />
      </div>
      {onCancel && (
        <button className="secondary-button" type="button" onClick={onCancel}>
          Cancel scan
        </button>
      )}
      <ul className="scan-checks">
        {SCAN_CHECKS.map((check) => (
          <li key={check.label}>
            <span>
              <strong>{check.label}</strong>
              {check.question}
            </span>
          </li>
        ))}
      </ul>
      <p className="scan-checks-note">
        Keystroke capture is tested by typing a synthetic value into visible form fields (never submitting) and
        watching for it to appear in a request to another registrable domain during typing, blur, or the wait after. A match
        proves that synthetic value crossed the domain boundary, not why it was sent. It covers fields on the loaded
        page, not flows behind login or extra steps.
      </p>
    </section>
  );
}
