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
import { lazy, Suspense, useEffect, useState } from "react";
import {
  PageGraphR2UploadButton,
  ReportUploadButton,
  type PageGraphUploadSelection
} from "./_components/file-upload-button";
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
import { committedReportLocation } from "@/lib/report-locator";
import { scanJobProgressCopy } from "@/lib/scan-job-progress";
import type { HomepageDiscovery, HomepageFeaturedGroup } from "@/lib/homepage-discovery";
import { plural } from "@/lib/text-format";
import { readLoadedReport, withoutLoadedReportShare } from "@/lib/client-report-reader";
import { viewFromV1Report } from "@/lib/scan-report-views";
// Type-only: the deep reader module stays lazy-loaded (client-report-reader);
// a type import is erased at build time and adds nothing to the bundle.
import type { LoadedReport } from "@/lib/scan-report-view";
import type {
  ComparisonScanResult,
  ScanJobProgress,
  ScanReport,
  StaticReportManifestEntry
} from "@/lib/types";

const LazyStaticReportGallery = lazy(() =>
  import("./_components/static-gallery").then((module) => ({ default: module.StaticReportGallery }))
);
const LazyReportRenderer = lazy(() =>
  import("./_components/report-renderer").then((module) => ({ default: module.ReportRenderer }))
);

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
    activeScanProgress,
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
    cancelActiveScan,
    dismissActiveScan
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

  async function loadStaticArchive() {
    setArchiveRequested(true);
    if (!STATIC_EXPORT || staticReports !== null) return;

    try {
      const response = await fetch(staticAssetPath("/reports/index.json"), { cache: "no-store" });
      if (!response.ok) throw new Error("Report manifest unavailable.");
      const payload = (await response.json()) as unknown;
      setStaticReports(isStaticReportManifest(payload) ? payload.reports : []);
      setStaticReportsError(null);
    } catch {
      setStaticReports([]);
      setStaticReportsError("Generated report index is not available.");
    }
  }

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
      <main className="app-shell">
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
            <span className={statusClassName}>
              <span className="status-dot" />
              {statusLabel}
            </span>
            <ThemeToggle />
          </div>
        </header>

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

        {corpusHighlights && corpusHighlights.attemptedSiteCount > 0 && !loaded && !loading && !error && (
          <CorpusHero highlights={corpusHighlights} />
        )}

        <ScanRecoveryBanner
          error={error}
          acceptedJob={Boolean(activeScanJob)}
          loading={loading}
          cancelling={cancellingScan}
          cancellationError={cancelScanError}
          onResume={() => void resumeActiveScan()}
          onCancel={() => void cancelActiveScan()}
          onDismiss={dismissActiveScan}
        />

        <div id="report">
          {!loaded && !loading && !activeScanJob && (
            <EmptyState
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
              homepageDiscovery={homepageDiscovery}
              archiveRequested={archiveRequested}
              onLoadArchive={() => void loadStaticArchive()}
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
              progress={activeScanProgress}
            />
          )}
          {loaded && (
            <Suspense fallback={<p className="muted">Preparing the evidence explorer…</p>}>
              <LazyReportRenderer loaded={loaded} liveApiServesReportPages={liveApiServesReportPages} />
            </Suspense>
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
        The public library covers {plural(highlights.loadedSiteCount, "successfully loaded site")} from controlled
        visits. Each report records observable requests, cookies, and catalogued services from one visit—reproducible
        evidence, not a privacy score or verdict.
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
      <details className="corpus-counting-disclosure">
        <summary>How coverage and category medians are counted</summary>
        <p>
          The committed library attempted {plural(highlights.attemptedSiteCount, "real site")}. {plural(highlights.failedSiteCount, "site")} only produced failed or block-page primary visits, and {plural(highlights.cappedSiteCount, "successfully loaded site")} had at least one request-capped recording that remains visible as lower-bound evidence. Category medians use {plural(highlights.eligibleSiteCount, "site")} with an eligible, request-complete passive lead visit. Each site counts once, even when a comparison loaded both arms. Requests are also evaluated with the open-source <code>adblock-rust</code> engine and Brave&rsquo;s default filter lists.
        </p>
      </details>
    </section>
  );
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
  onCreateComparison: (comparison: ComparisonScanResult) => void;
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

  return (
    <section className={`empty-state${staticExport ? " static-library-state" : ""}`}>
      <div className="empty-icon">
        <Radar size={28} aria-hidden="true" />
      </div>
      <h2>{homepageDiscovery ? "Explore measured evidence" : liveScanEnabled ? "Ready to scan" : "Saved site reports"}</h2>
      <p>
        {homepageDiscovery
          ? `${plural(homepageDiscovery.reportCount, "public report")} are available now. Open existing evidence instantly, or scan a site above for a new controlled visit.`
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
              <a className="secondary-button" href={SCAN_WORKFLOW_URL} target="_blank" rel="noreferrer" title="Requires repository access">
                <Github size={17} aria-hidden="true" />
                Maintainer scan
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
            Unsupported evidence families remain censored rather than guessed.
          </p>
          {staticExport && archiveRequested && (
            <Suspense fallback={<p className="muted">Loading saved-report tools…</p>}>
              <LazyStaticReportGallery
                reports={staticReports}
                error={staticReportsError}
                onCreateComparison={onCreateComparison}
                onComparisonError={onComparisonError}
              />
            </Suspense>
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
                    {item.requestCapped && <span className="capped-chip">recording capped</span>}
                    <span className="featured-card-dot" aria-hidden="true" />
                  </span>
                  <span className="featured-card-headline">{item.headline}</span>
                  <span className="featured-card-stats">
                    <span className="featured-card-stat"><b>{item.thirdPartyRequests.toLocaleString("en-US")}</b> third-party</span>
                    <span className="featured-card-stat"><b>{item.trackerRequests.toLocaleString("en-US")}</b> catalogued-service</span>
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
  cancellationError = null,
  progress = null
}: {
  mode: "single" | "gpc" | "shields" | "consent" | "opening";
  onCancel?: () => void;
  cancelling?: boolean;
  cancellationError?: string | null;
  progress?: ScanJobProgress | null;
}) {
  const isScanning = mode !== "opening";

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

  const progressCopy = scanJobProgressCopy(progress);

  return (
    <section className="loading-state" aria-labelledby="scan-loading-title">
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
