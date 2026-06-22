"use client";

import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Clock,
  Cookie,
  Copy,
  Database,
  Download,
  ExternalLink,
  Eye,
  FileJson,
  Fingerprint,
  FlaskConical,
  Github,
  Globe2,
  Loader2,
  Monitor,
  Moon,
  Network,
  Radar,
  Search,
  Shield,
  ShieldCheck,
  SlidersHorizontal,
  Smartphone,
  Sun,
  Upload
} from "lucide-react";
import type { FormEvent, ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createTemporalComparisonReport } from "@/lib/compare-reports";
import { isCorpusStats, type CorpusStats } from "@/lib/corpus-stats";
import { domainsMatch, isFeaturedSiteConfig, type FeaturedSite, type FeaturedSiteConfig } from "@/lib/featured-sites";
import { buildReportHeadline, displayScanResult, type ReportHeadline } from "@/lib/report-headline";
import { committedReportLocation, locateReport, type ReportRuntime } from "@/lib/report-locator";
import { isScanRuntimeHealth, type ScanRuntimeHealth } from "@/lib/scan-runtime-health";
import {
  detectionEvidence,
  detectionLabel,
  fingerprintDetectionCount,
  fingerprintDetections,
  trackerEntitySummaries
} from "@/lib/report-insights";
import {
  buildFindings,
  provenanceChangeText,
  requestProvenanceSearchText,
  requestProvenanceSummary,
  type FindingIconKey
} from "@/lib/report-findings";
import { plural } from "@/lib/text-format";
import { isScanReport, REPORT_ID_PATTERN } from "@/lib/report-validation";
import type {
  ComparisonMetricDelta,
  ComparisonScanResult,
  CookieChange,
  CookieRecord,
  DomainSummary,
  DomainChange,
  EntityChange,
  FingerprintDetectionSummary,
  FingerprintingChange,
  NetworkRequestRecord,
  ProvenanceChange,
  StorageKeyChange,
  ScanApiResponse,
  ScanDevice,
  ScanJobApiResponse,
  ScanJobSubmissionResponse,
  ScanReport,
  ScanResult,
  StaticReportManifestEntry
} from "@/lib/types";

type ScanFormState = {
  url: string;
  device: ScanDevice;
  gpcEnabled: boolean;
  compareGpc: boolean;
  compareShields: boolean;
  accessKey: string;
};

const initialForm: ScanFormState = {
  url: "",
  device: "desktop",
  gpcEnabled: true,
  compareGpc: false,
  compareShields: false,
  accessKey: ""
};

function isComparisonMode(form: ScanFormState): boolean {
  return form.compareGpc || form.compareShields;
}

// The browser reads health through the shared cross-runtime contract.
type ScannerHealth = ScanRuntimeHealth;

const EXAMPLES: { url: string; hint: string }[] = [
  { url: "youtube.com", hint: "one mega-entity" },
  { url: "usatoday.com", hint: "heavy trackers" },
  { url: "amazon.com", hint: "retail + retargeting" },
  { url: "weather.com", hint: "tracker-dense" },
  { url: "wikipedia.org", hint: "minimal" }
];
const STATIC_EXPORT = process.env.NEXT_PUBLIC_SITE_BEHAVIOR_LAB_STATIC_EXPORT === "1";
const STATIC_BASE_PATH = normalizeBasePath(process.env.NEXT_PUBLIC_SITE_BEHAVIOR_LAB_PAGES_BASE_PATH || "");
const LIVE_SCAN_API_BASE = normalizeApiBase(process.env.NEXT_PUBLIC_SITE_BEHAVIOR_LAB_SCAN_API_BASE || "");
const STATIC_LIVE_SCAN_ENABLED = STATIC_EXPORT && Boolean(LIVE_SCAN_API_BASE);
const LIVE_SCAN_ENABLED = !STATIC_EXPORT || STATIC_LIVE_SCAN_ENABLED;
const OPEN_ACCESS_SCANNER = process.env.NEXT_PUBLIC_SITE_BEHAVIOR_LAB_OPEN_ACCESS === "1";
// Public Turnstile site key for the static scan UI. Required to satisfy a Worker
// that is deployed with TURNSTILE_SECRET_KEY set on a gated deployment.
const LIVE_SCAN_TURNSTILE_SITE_KEY = (process.env.NEXT_PUBLIC_SITE_BEHAVIOR_LAB_TURNSTILE_SITE_KEY || "").trim();
const GITHUB_REPOSITORY = process.env.NEXT_PUBLIC_SITE_BEHAVIOR_LAB_GITHUB_REPOSITORY || "";
const SCAN_WORKFLOW_URL = GITHUB_REPOSITORY
  ? `https://github.com/${GITHUB_REPOSITORY}/actions/workflows/scan.yml`
  : null;
const SCAN_JOB_POLL_INTERVAL_MS = 1000;
const SCAN_JOB_MAX_POLLS = 180;
const TURNSTILE_SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

type TurnstileRenderOptions = {
  sitekey: string;
  callback?: (token: string) => void;
  "error-callback"?: () => void;
  "expired-callback"?: () => void;
  "timeout-callback"?: () => void;
  theme?: "auto" | "light" | "dark";
  size?: "normal" | "flexible" | "compact";
};

type TurnstileApi = {
  render: (container: HTMLElement, options: TurnstileRenderOptions) => string;
  reset: (widgetId?: string) => void;
  remove: (widgetId?: string) => void;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

export type CorpusHighlights = {
  siteCount: number;
  topCategories: { label: string; medianTrackers: number }[];
};

type SiteBehaviorAppProps = {
  initialResult?: ScanReport | null;
  initialError?: string | null;
  initialLoading?: boolean;
  corpusHighlights?: CorpusHighlights | null;
};

export function SiteBehaviorApp({
  initialResult = null,
  initialError = null,
  initialLoading = false,
  corpusHighlights = null
}: SiteBehaviorAppProps) {
  const [form, setForm] = useState<ScanFormState>(initialForm);
  const [result, setResult] = useState<ScanReport | null>(initialResult);
  const [error, setError] = useState<string | null>(initialError);
  const [loading, setLoading] = useState(initialLoading);
  // Distinguishes an active scan (long, controlled browser visit) from opening a
  // saved report (a quick fetch). `initialLoading` only ever comes from the saved
  // report permalink, so loading without scanning means "opening a saved report".
  const [scanning, setScanning] = useState(false);
  const [staticReports, setStaticReports] = useState<StaticReportManifestEntry[] | null>(STATIC_EXPORT ? null : []);
  const [staticReportsError, setStaticReportsError] = useState<string | null>(null);
  const [scannerHealth, setScannerHealth] = useState<ScannerHealth | null>(null);
  const [scannerHealthError, setScannerHealthError] = useState<string | null>(null);
  const [turnstileToken, setTurnstileToken] = useState("");
  // Bumped after every scan attempt to force a fresh single-use Turnstile token.
  const [turnstileResetNonce, setTurnstileResetNonce] = useState(0);

  useEffect(() => {
    if (!LIVE_SCAN_ENABLED) return;
    if (OPEN_ACCESS_SCANNER) return;

    try {
      const savedAccessKey = localStorage.getItem("sbl-access-key");
      if (savedAccessKey) {
        setForm((current) => ({ ...current, accessKey: savedAccessKey }));
      }
    } catch {
      /* localStorage unavailable */
    }
  }, []);

  useEffect(() => {
    setResult(initialResult);
  }, [initialResult]);

  useEffect(() => {
    setError(initialError);
  }, [initialError]);

  useEffect(() => {
    setLoading(initialLoading);
  }, [initialLoading]);

  useEffect(() => {
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
  }, []);

  useEffect(() => {
    if (!LIVE_SCAN_ENABLED) return;

    let cancelled = false;

    async function loadScannerHealth() {
      try {
        const response = await fetch(scannerApiUrl("/api/health"), { cache: "no-store" });
        const payload = (await response.json()) as unknown;
        if (!response.ok || !isScanRuntimeHealth(payload)) {
          throw new Error("Scanner health check failed.");
        }
        if (!payload.ok) {
          // The Worker is reachable but configured so scans cannot succeed.
          // Surface the specific reason instead of advertising a working scanner.
          if (!cancelled) {
            setScannerHealth(null);
            setScannerHealthError(payload.error || "The public scanner is not ready for scans right now.");
          }
          return;
        }
        if (!cancelled) {
          setScannerHealth(payload);
          setScannerHealthError(null);
        }
      } catch {
        if (!cancelled) {
          setScannerHealth(null);
          setScannerHealthError("Public scanner status is unavailable. Try again shortly.");
        }
      }
    }

    void loadScannerHealth();
    return () => {
      cancelled = true;
    };
  }, []);

  const gpcComparisonEnabled = !STATIC_EXPORT || scannerHealth?.capabilities?.gpcComparison === true;
  const shieldsComparisonEnabled = !STATIC_EXPORT || scannerHealth?.capabilities?.shieldsComparison === true;
  const openAccessScanner = OPEN_ACCESS_SCANNER || scannerHealth?.openAccess === true;
  // A live-scanned report only has a shareable permalink when the scan API serves
  // its own report pages (the full Node app / container). The JSON-only Browser
  // Run Worker does not, so its reports stay download-only (no broken Share link).
  const liveApiServesReportPages = scannerHealth?.capabilities?.savedReportPages === true;
  const scannerRequiresAccessKey =
    LIVE_SCAN_ENABLED && !openAccessScanner && (!STATIC_LIVE_SCAN_ENABLED || scannerHealth?.authenticated === true);
  const scannerUnavailable = LIVE_SCAN_ENABLED && Boolean(scannerHealthError);
  // The Worker advertises whether it enforces Turnstile. Satisfy it only when the
  // static build also carries a public site key; otherwise scanning can only fail.
  const turnstileRequired = LIVE_SCAN_ENABLED && scannerHealth?.turnstile === true;
  const turnstileSiteKeyConfigured = Boolean(LIVE_SCAN_TURNSTILE_SITE_KEY);
  const turnstileUnsupported = turnstileRequired && !turnstileSiteKeyConfigured;
  const awaitingTurnstile = turnstileRequired && turnstileSiteKeyConfigured && !turnstileToken;
  const scanBlocked = scannerUnavailable || turnstileUnsupported || awaitingTurnstile;

  useEffect(() => {
    setForm((current) => ({
      ...current,
      compareGpc: current.compareGpc && gpcComparisonEnabled,
      compareShields: current.compareShields && shieldsComparisonEnabled
    }));
  }, [gpcComparisonEnabled, shieldsComparisonEnabled]);

  async function runScan(targetUrl: string) {
    if (!LIVE_SCAN_ENABLED) {
      setLoading(false);
      setResult(null);
      setError("This published build cannot run live scans. Use an Actions-generated report, upload JSON, or run the Node app locally.");
      return;
    }
    if (scannerUnavailable) {
      setLoading(false);
      setResult(null);
      setError(scannerHealthError || "The public scanner is not available right now. Try again shortly.");
      return;
    }
    if (turnstileUnsupported) {
      setLoading(false);
      setResult(null);
      setError(
        "This scanner requires Turnstile verification, but this site was not built with a Turnstile site key. Rebuild with NEXT_PUBLIC_SITE_BEHAVIOR_LAB_TURNSTILE_SITE_KEY set to the Worker's site key."
      );
      return;
    }
    if (awaitingTurnstile) {
      setLoading(false);
      setResult(null);
      setError("Complete the Turnstile check before scanning.");
      return;
    }

    setLoading(true);
    setScanning(true);
    setError(null);
    setResult(null);

    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      const accessKey = form.accessKey.trim();
      if (scannerRequiresAccessKey && accessKey) {
        headers.Authorization = `Bearer ${accessKey}`;
      }

      const response = await fetch(scannerApiUrl("/api/scan"), {
        method: "POST",
        headers,
        body: JSON.stringify({
          url: targetUrl,
          device: form.device,
          gpcEnabled: form.gpcEnabled,
          compareGpc: gpcComparisonEnabled && form.compareGpc,
          compareShields: shieldsComparisonEnabled && form.compareShields,
          consentMode: "observe",
          ...(turnstileRequired && turnstileToken ? { turnstileToken } : {})
        })
      });
      const payload = (await response.json()) as ScanApiResponse;
      if (!payload.ok) throw new Error(payload.error);
      if (isScanJobSubmissionResponse(payload)) {
        setResult(await pollScanJob(payload.statusPath, scannerRequiresAccessKey ? accessKey : ""));
        return;
      }
      setResult(payload);
    } catch (scanError) {
      setError(scanError instanceof Error ? friendlyError(scanError.message) : "Scan failed.");
    } finally {
      setLoading(false);
      setScanning(false);
      // Turnstile tokens are single-use, so force a fresh challenge for the next scan.
      if (turnstileRequired) {
        setTurnstileToken("");
        setTurnstileResetNonce((nonce) => nonce + 1);
      }
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = form.url.trim();
    if (!trimmed) {
      setError("Enter a public URL to scan, for example https://example.com.");
      return;
    }
    void runScan(trimmed);
  }

  function useExample(url: string) {
    setForm((current) => ({ ...current, url: `https://${url}` }));
    void runScan(`https://${url}`);
  }

  function updateAccessKey(accessKey: string) {
    setForm((current) => ({ ...current, accessKey }));
    try {
      if (accessKey) {
        localStorage.setItem("sbl-access-key", accessKey);
      } else {
        localStorage.removeItem("sbl-access-key");
      }
    } catch {
      /* localStorage unavailable */
    }
  }

  async function loadReportFile(file: File | null) {
    if (!file) return;
    setLoading(false);
    setError(null);
    setResult(null);

    try {
      const payload = JSON.parse(await file.text()) as unknown;
      if (!isScanReport(payload)) {
        throw new Error("Report JSON is not a Site Behavior Lab report.");
      }
      setResult(stripShareForLocalReport(payload));
    } catch (readError) {
      setError(readError instanceof Error ? readError.message : "Report JSON could not be opened.");
    }
  }

  async function loadPageGraphFile(file: File | null) {
    if (!file) return;
    setLoading(false);
    setError(null);
    setResult(null);

    try {
      const graphml = await file.text();
      // Code-split the PageGraph parser (and its tldts dependency) so it loads
      // only when a GraphML file is actually opened, keeping the main bundle lean.
      const { pageGraphUploadToScanResult } = await import("@/lib/pagegraph-parser");
      setResult(pageGraphUploadToScanResult(graphml));
    } catch (readError) {
      setError(readError instanceof Error ? readError.message : "PageGraph file could not be parsed.");
    }
  }

  function downloadReport() {
    if (!result) return;
    const blob = new Blob([JSON.stringify(exportableReport(result), null, 2)], {
      type: "application/json"
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `site-behavior-lab-${safeFilenamePart(reportDomain(result))}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function downloadCsv() {
    if (!result) return;
    const csv = requestLogToCsv(primaryScanResult(result).requests);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `site-behavior-lab-${safeFilenamePart(reportDomain(result))}-requests.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  const primaryResult = result ? primaryScanResult(result) : null;
  const reportReadyMessage =
    result && primaryResult && !loading && !error
      ? `Scan report ready for ${reportDomain(result)}: ${plural(primaryResult.summary.totalRequests, "request")} observed.`
      : "";
  const statusLabel = liveScannerStatusLabel(scannerHealth, scannerHealthError);
  const statusClassName = `status-pill${STATIC_EXPORT ? " status-pill-static" : ""}${
    LIVE_SCAN_ENABLED ? " status-pill-live" : ""
  }`;
  const scanForm = (
    <form className="scan-panel" onSubmit={handleSubmit}>
      <label className="url-label" htmlFor="url">
        Public URL
      </label>
      <div className="url-row">
        <Globe2 size={18} aria-hidden="true" />
        <input
          id="url"
          inputMode="url"
          autoComplete="url"
          spellCheck={false}
          value={form.url}
          onChange={(event) => setForm((current) => ({ ...current, url: event.target.value }))}
          placeholder="https://example.com"
        />
        <button className={`primary-button${loading ? " is-loading" : ""}`} type="submit" disabled={loading || scanBlocked}>
          {loading ? <Loader2 className="spin" size={18} aria-hidden="true" /> : <Search size={18} aria-hidden="true" />}
          {isComparisonMode(form) ? "Compare" : "Scan"}
        </button>
      </div>

      {STATIC_LIVE_SCAN_ENABLED && (
        <p className="scanner-status-note">
          {scannerStatusText(scannerHealth, scannerHealthError)}
        </p>
      )}

      {turnstileRequired && turnstileSiteKeyConfigured && (
        <div className="turnstile-row">
          <TurnstileWidget
            siteKey={LIVE_SCAN_TURNSTILE_SITE_KEY}
            resetNonce={turnstileResetNonce}
            onToken={setTurnstileToken}
            onError={setError}
          />
        </div>
      )}

      {turnstileUnsupported && (
        <p className="scanner-status-note scanner-status-note-error">
          This scanner requires Turnstile verification, but this static build has no Turnstile site key. Set
          {" "}
          <code>NEXT_PUBLIC_SITE_BEHAVIOR_LAB_TURNSTILE_SITE_KEY</code> at build time to enable scanning.
        </p>
      )}

      <details className="options-disclosure" open={STATIC_LIVE_SCAN_ENABLED}>
        <summary>
          <SlidersHorizontal size={15} aria-hidden="true" />
          <span>Options</span>
          <ChevronDown className="disclosure-chevron" size={15} aria-hidden="true" />
        </summary>
        <div className="controls-grid">
          <fieldset className="control-group">
            <legend>Run</legend>
            <div className="segmented-control run-mode-control" role="group" aria-label="Run mode">
              <button
                type="button"
                aria-pressed={!isComparisonMode(form)}
                className={!isComparisonMode(form) ? "active" : ""}
                onClick={() => setForm((current) => ({ ...current, compareGpc: false, compareShields: false }))}
              >
                <Search size={16} aria-hidden="true" />
                Single
              </button>
              <button
                type="button"
                aria-pressed={form.compareGpc}
                className={form.compareGpc ? "active" : ""}
                disabled={!gpcComparisonEnabled}
                title={gpcComparisonEnabled ? undefined : "GPC comparison is not available from this scanner."}
                onClick={() => setForm((current) => ({ ...current, compareGpc: gpcComparisonEnabled, compareShields: false }))}
              >
                <ShieldCheck size={16} aria-hidden="true" />
                GPC diff
              </button>
              <button
                type="button"
                aria-pressed={form.compareShields}
                className={form.compareShields ? "active" : ""}
                disabled={!shieldsComparisonEnabled}
                title={shieldsComparisonEnabled ? undefined : "Shields comparison requires the Node scanner."}
                onClick={() => setForm((current) => ({ ...current, compareGpc: false, compareShields: shieldsComparisonEnabled }))}
              >
                <Shield size={16} aria-hidden="true" />
                Shields
              </button>
            </div>
          </fieldset>

          <fieldset className="control-group">
            <legend>Device</legend>
            <div className="segmented-control" role="group" aria-label="Device">
              <button
                type="button"
                aria-pressed={form.device === "desktop"}
                className={form.device === "desktop" ? "active" : ""}
                onClick={() => setForm((current) => ({ ...current, device: "desktop" }))}
              >
                <Monitor size={16} aria-hidden="true" />
                Desktop
              </button>
              <button
                type="button"
                aria-pressed={form.device === "mobile"}
                className={form.device === "mobile" ? "active" : ""}
                onClick={() => setForm((current) => ({ ...current, device: "mobile" }))}
              >
                <Smartphone size={16} aria-hidden="true" />
                Mobile
              </button>
            </div>
          </fieldset>

          <fieldset className="control-group">
            <legend>Privacy Signal</legend>
            {gpcComparisonEnabled && form.compareGpc ? (
              <div className="readonly-control">Off + On</div>
            ) : (
              <label className="switch-row">
                <input
                  type="checkbox"
                  checked={form.gpcEnabled}
                  onChange={(event) => setForm((current) => ({ ...current, gpcEnabled: event.target.checked }))}
                />
                <span>Send GPC</span>
              </label>
            )}
          </fieldset>

          {scannerRequiresAccessKey && (
            <fieldset className="control-group access-group">
              <legend>Access</legend>
              <label className="access-control">
                <Shield size={16} aria-hidden="true" />
                <input
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={form.accessKey}
                  onChange={(event) => updateAccessKey(event.target.value)}
                  placeholder={STATIC_LIVE_SCAN_ENABLED ? "access key" : "optional key"}
                  aria-label="Scanner access key"
                />
              </label>
            </fieldset>
          )}
        </div>
      </details>
    </form>
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

        {corpusHighlights && corpusHighlights.siteCount > 0 && !result && !loading && !error && (
          <CorpusHero highlights={corpusHighlights} />
        )}

        <section className="scan-workbench">
          {LIVE_SCAN_ENABLED ? (
            scanForm
          ) : (
            <StaticPublicPanel onUploadReport={loadReportFile} />
          )}

          <aside className="method-card">
            <div className="method-icon">
              <Shield size={20} aria-hidden="true" />
            </div>
            <div>
              <h2>Evidence, then interpretation</h2>
              <p>
                Every report records the exact scan conditions, then the request log, cookies, storage keys,
                known-service labels, and instrumentation notes. Signals describe what was observed, not a verdict.
              </p>
            </div>
          </aside>
        </section>

        {error && (
          <section className="error-banner" role="alert">
            <AlertTriangle size={18} aria-hidden="true" />
            <span>{error}</span>
          </section>
        )}

        <div id="report">
          <p className="visually-hidden" role="status" aria-live="polite">
            {reportReadyMessage}
          </p>
          {!result && !loading && !error && (
            <EmptyState
              onPick={useExample}
              onUploadReport={loadReportFile}
              onUploadPageGraph={loadPageGraphFile}
              onCreateComparison={(comparison) => {
                setLoading(false);
                setError(null);
                setResult(comparison);
              }}
              onComparisonError={(message) => {
                setLoading(false);
                setResult(null);
                setError(message);
              }}
              liveScanEnabled={LIVE_SCAN_ENABLED}
              staticExport={STATIC_EXPORT}
              staticReports={staticReports}
              staticReportsError={staticReportsError}
            />
          )}
          {loading && (
            <LoadingState mode={!scanning ? "opening" : form.compareGpc ? "gpc" : form.compareShields ? "shields" : "single"} />
          )}
          {result && primaryResult && (
            <section className="report-grid">
              <div className="report-main">
                <ReportHeader
                  report={result}
                  result={primaryResult}
                  onDownload={downloadReport}
                  onDownloadCsv={downloadCsv}
                  liveApiServesReportPages={liveApiServesReportPages}
                />
                <HeadlineBanner report={result} liveApiServesReportPages={liveApiServesReportPages} />
                <FindingsBoard report={result} result={primaryResult} />
                <CausalityGraph result={primaryResult} />
                {isComparisonReport(result) && <ComparisonPanel report={result} />}
                <MetricGrid result={primaryResult} />
                <TrafficViz result={primaryResult} />
                <Warnings warnings={isComparisonReport(result) ? result.warnings : primaryResult.warnings} />
                <DomainTable domains={primaryResult.domains} />
                <RequestTable result={primaryResult} />
              </div>

              <aside className="report-sidebar">
                {primaryResult.screenshot && (
                  <section className="side-card screenshot-card">
                    <h2>Viewport</h2>
                    <img src={primaryResult.screenshot} alt={`Screenshot of ${primaryResult.summary.firstPartyDomain}`} />
                  </section>
                )}

                <section className="side-card">
                  <h2>Top Third Parties</h2>
                  <TopThirdParties domains={primaryResult.domains} />
                </section>

                <section className="side-card">
                  <h2>Cookies</h2>
                  <CookieList cookies={primaryResult.cookies} />
                </section>

                <section className="side-card">
                  <h2>Storage</h2>
                  <StorageList result={primaryResult} />
                </section>

                <section className="side-card">
                  <h2>Browser Behavior Signals</h2>
                  <FingerprintList result={primaryResult} />
                </section>

                <section className="side-card methodology">
                  <h2>Methodology</h2>
                  <dl>
                    <div>
                      <dt>Scanner</dt>
                      <dd>{primaryResult.conditions.automation}</dd>
                    </div>
                    <div>
                      <dt>Browser</dt>
                      <dd>{primaryResult.conditions.chromiumVersion}</dd>
                    </div>
                    <div>
                      <dt>Timezone</dt>
                      <dd>{primaryResult.conditions.timezone}</dd>
                    </div>
                    <div>
                      <dt>Headless</dt>
                      <dd>{primaryResult.conditions.headless ? "yes" : "no"}</dd>
                    </div>
                    <div>
                      <dt>Viewport</dt>
                      <dd>
                        {primaryResult.conditions.viewport.width}×{primaryResult.conditions.viewport.height}
                      </dd>
                    </div>
                    <div>
                      <dt>GPC</dt>
                      <dd>{primaryResult.conditions.gpcEnabled ? "sent" : "not sent"}</dd>
                    </div>
                    <div>
                      <dt>Egress</dt>
                      <dd>{primaryResult.conditions.scannerEgress}</dd>
                    </div>
                    <div>
                      <dt>Catalog</dt>
                      <dd>
                        {primaryResult.conditions.trackerCatalog.source}
                        <br />
                        {primaryResult.conditions.trackerCatalog.region} · {primaryResult.conditions.trackerCatalog.version}
                        <br />
                        {primaryResult.conditions.trackerCatalog.entries.toLocaleString()} entries
                      </dd>
                    </div>
                    {primaryResult.conditions.adblock && (
                      <div>
                        <dt>Shields lists</dt>
                        <dd>
                          {primaryResult.conditions.adblock.source}
                          <br />
                          {primaryResult.conditions.adblock.lists.toLocaleString()} lists · fetched{" "}
                          {new Date(primaryResult.conditions.adblock.fetchedAt).toLocaleDateString()}
                        </dd>
                      </div>
                    )}
                  </dl>
                  <p>{primaryResult.conditions.scannerDisclosure}</p>
                </section>
              </aside>
            </section>
          )}
        </div>

        <footer className="app-footer">
          <span>Site Behavior Lab: open-source web transparency tooling.</span>
          <span>One automated visit. Reproducible for this configuration, not a universal claim.</span>
        </footer>
      </main>
    </>
  );
}

function StaticPublicPanel({ onUploadReport }: { onUploadReport: (file: File | null) => Promise<void> }) {
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
        <ReportUploadButton onUploadReport={onUploadReport}>Open report file</ReportUploadButton>
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
      <h2 id="corpus-hero-title">What websites actually load — measured, not claimed.</h2>
      <p className="corpus-hero-lead">
        We open {plural(highlights.siteCount, "real site")} in a controlled browser and record every request, cookie, and
        tracker, then run each through <strong>Brave&rsquo;s own ad-block engine</strong> (the open-source{" "}
        <code>adblock-rust</code>, with Brave&rsquo;s default lists) to show what Shields would block. Reproducible
        evidence, not a score.
      </p>
      {highlights.topCategories.length > 0 && (
        <div className="corpus-hero-cats">
          {highlights.topCategories.map((category) => (
            <div className="corpus-hero-cat" key={category.label}>
              <span className="corpus-hero-cat-num">{category.medianTrackers.toLocaleString()}</span>
              <span className="corpus-hero-cat-label">{category.label}</span>
            </div>
          ))}
          <span className="corpus-hero-cat-note">median trackers per site, by category</span>
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

function liveScannerStatusLabel(health: ScannerHealth | null, error: string | null): string {
  if (!LIVE_SCAN_ENABLED) return STATIC_EXPORT ? "Evidence Library" : "Controlled";
  if (!STATIC_LIVE_SCAN_ENABLED) return "Controlled";
  if (error) return "Offline";
  if (!health) return "Checking";
  return health.status === "ok" ? "Live" : health.ok ? "Limited" : "Offline";
}

function scannerStatusText(health: ScannerHealth | null, error: string | null): string {
  if (error) return error;
  if (!health) return "Checking public scanner status...";

  const storage = health.storage ? ` Storage: ${health.storage.toUpperCase()}.` : "";
  const minuteLimit = health.limits?.publicScanRateLimitPerMinute;
  const dayLimit = health.limits?.publicScanRateLimitPerDay;
  const limits =
    typeof minuteLimit === "number" && typeof dayLimit === "number"
      ? ` Rate-limited to ${minuteLimit} scan tokens/min and ${dayLimit}/day per client.`
      : " Rate-limited per client.";
  const comparison = health.capabilities?.gpcComparison ? " GPC comparison is available." : "";
  const adblock =
    health.checks?.adblock?.active === false ? " Brave Shields classification is unavailable on this scanner." : "";

  if (health.openAccess) {
    return `Public scanner ready. No access key required.${limits}${comparison}${storage}${adblock}`;
  }

  return `Scanner ready. Access key required.${comparison}${storage}${adblock}`;
}

function friendlyError(message: string): string {
  const lower = message.toLowerCase();
  if (lower.includes("timeout") || lower.includes("did not load") || lower.includes("scan duration")) {
    return "The page did not finish loading in time. It may be slow, very large, or blocking automated visits. Try again, or try a different page.";
  }
  if (lower.includes("private") || lower.includes("localhost") || lower.includes("internal") || lower.includes("not a public")) {
    return "That address can't be scanned. The scanner only visits public web pages, not localhost, private networks, or internal hosts.";
  }
  if (lower.includes("rate") || lower.includes("too many") || lower.includes("slow down")) {
    return "Too many scans in a short window. Wait a moment and try again.";
  }
  if (lower.includes("access") || lower.includes("token") || lower.includes("unauthorized") || lower.includes("forbidden")) {
    if (OPEN_ACCESS_SCANNER) {
      return "The public scanner is still rejecting open scans. The Cloudflare Worker may need to be redeployed.";
    }
    return "This scanner requires a valid access key. Add it under Options, or contact whoever runs this instance.";
  }
  if (lower.includes("url") || lower.includes("http")) {
    return "That doesn't look like a valid web address. Use a full URL such as https://example.com.";
  }
  return message;
}

async function pollScanJob(statusPath: string, accessKey = ""): Promise<ScanReport> {
  const jobId = scanJobIdFromStatusPath(statusPath);

  for (let attempt = 0; attempt < SCAN_JOB_MAX_POLLS; attempt += 1) {
    const headers: Record<string, string> = {};
    if (accessKey) {
      headers.Authorization = `Bearer ${accessKey}`;
    }

    const response = await fetch(scannerApiUrl(statusPath), { cache: "no-store", headers });
    const payload = (await response.json()) as ScanJobApiResponse;
    if (!payload.ok) {
      if (response.status === 404 && jobId) {
        const recovered = await readSavedReportForJob(jobId);
        if (recovered) return recovered;
      }
      throw new Error(payload.error);
    }

    if (payload.status === "succeeded") {
      if (payload.report && isScanReport(payload.report)) return payload.report;
      throw new Error("Completed scan did not include a report.");
    }

    if (payload.status === "failed" || payload.status === "expired" || payload.status === "cancelled") {
      throw new Error(payload.error || "Scan job did not complete.");
    }

    await sleep(SCAN_JOB_POLL_INTERVAL_MS);
  }

  if (jobId) {
    const recovered = await readSavedReportForJob(jobId);
    if (recovered) return recovered;
  }

  throw new Error("Scan is still running. Try opening the saved report again shortly.");
}

async function readSavedReportForJob(jobId: string): Promise<ScanReport | null> {
  const response = await fetch(scannerApiUrl(`/api/reports/${jobId}`), { cache: "no-store" });
  if (!response.ok) return null;

  const payload = (await response.json()) as unknown;
  return isScanReport(payload) ? payload : null;
}

function scanJobIdFromStatusPath(statusPath: string): string | null {
  let pathname = statusPath;
  if (/^https?:\/\//i.test(statusPath)) {
    try {
      pathname = new URL(statusPath).pathname;
    } catch {
      return null;
    }
  }
  const match = pathname.match(/^\/api\/scans\/([0-9]{8}-[0-9a-f]{32})$/);
  const id = match?.[1] || "";
  return REPORT_ID_PATTERN.test(id) ? id : null;
}

function isScanJobSubmissionResponse(value: ScanApiResponse): value is ScanJobSubmissionResponse {
  return value.ok === true && "jobId" in value && value.status === "queued" && typeof value.statusPath === "string";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function isComparisonReport(result: ScanReport): result is ComparisonScanResult {
  return result.reportType === "comparison";
}

function primaryScanResult(result: ScanReport): ScanResult {
  // Lead with the baseline (off / unprotected) run for GPC/Shields so the report
  // shows what the site actually did, not the cleaned-up protected residual; the
  // ComparisonPanel carries the diff. (Temporal diffs lead with "after".)
  return displayScanResult(result);
}

function reportDomain(result: ScanReport): string {
  return primaryScanResult(result).summary.firstPartyDomain;
}

function reportSharePath(result: ScanReport, liveApiServesReportPages: boolean): string | null {
  const share = result.share;
  if (!share?.id) return null;
  // The scan API only yields a shareable permalink when it serves its own report
  // pages (the full Node app / container). The JSON-only Browser Run Worker does
  // not, so `locateReport` then withholds the link rather than 404 it.
  const runtime: ReportRuntime = { ...clientReportRuntime(), liveApiServesReportPages };
  // A report whose JSON lives behind the scan API (`/api/reports/:id`) was just
  // produced by a running Node/container scanner; on a live-API static build it
  // is only servable from that API's own origin, so resolve it there. Committed
  // reports instead carry the static-file convention (`/reports/:id.json`) and
  // are served by the page that is already rendering them.
  const apiBacked = share.jsonPath.startsWith("/api/");
  if (runtime.staticExport && runtime.liveApiBacked && apiBacked) {
    return locateReport(share.id, runtime).pagePath;
  }
  return committedReportLocation(share.id, runtime).pagePath;
}

// Runtime context for resolving report locations from the browser build flags.
export function clientReportRuntime(): ReportRuntime {
  return {
    staticExport: STATIC_EXPORT,
    liveApiBacked: STATIC_LIVE_SCAN_ENABLED,
    basePath: STATIC_BASE_PATH,
    // A live-scanned report lives on the scan API's own origin, which serves a
    // working report page, so share permalinks resolve there.
    scanApiBase: LIVE_SCAN_API_BASE
  };
}

function normalizeApiBase(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return "";
  }
}

function normalizeBasePath(value: string): string {
  if (!value || value === "/") return "";
  const withSlash = value.startsWith("/") ? value : `/${value}`;
  return withSlash.replace(/\/+$/, "");
}

function scannerApiUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return LIVE_SCAN_API_BASE ? `${LIVE_SCAN_API_BASE}${normalizedPath}` : normalizedPath;
}

export function staticAssetPath(path: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${STATIC_BASE_PATH}${normalizedPath}`;
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
    typeof entry.domain === "string" &&
    typeof entry.requestedUrl === "string" &&
    typeof entry.scannedAt === "string" &&
    (entry.reportType === "single" || entry.reportType === "comparison") &&
    (entry.device === "desktop" || entry.device === "mobile") &&
    metrics !== undefined &&
    typeof metrics.totalRequests === "number" &&
    typeof metrics.thirdPartyRequests === "number"
  );
}

function requestLogToCsv(requests: NetworkRequestRecord[]): string {
  const header = [
    "id",
    "domain",
    "method",
    "resource_type",
    "status",
    "third_party",
    "tracker_entity",
    "tracker_category",
    "url"
  ];
  const rows = requests.map((request) => [
    request.id,
    request.domain,
    request.method,
    request.resourceType,
    request.status ?? "",
    request.thirdParty ? "yes" : "no",
    request.tracker?.entity ?? "",
    request.tracker?.category ?? "",
    request.url
  ]);
  return [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n").concat("\r\n");
}

function csvCell(value: string | number): string {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function exportableReport(result: ScanReport): unknown {
  if (!isComparisonReport(result)) {
    return { ...result, screenshot: undefined };
  }

  return {
    ...result,
    baseline: { ...result.baseline, screenshot: undefined },
    variant: { ...result.variant, screenshot: undefined }
  };
}

function stripShareForLocalReport(report: ScanReport): ScanReport {
  return { ...report, share: undefined };
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
  onCreateComparison,
  onComparisonError,
  liveScanEnabled,
  staticExport,
  staticReports,
  staticReportsError
}: {
  onPick: (url: string) => void;
  onUploadReport: (file: File | null) => Promise<void>;
  onUploadPageGraph: (file: File | null) => Promise<void>;
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
            <ReportUploadButton onUploadReport={onUploadReport}>Open report file</ReportUploadButton>
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
            Have a Brave <strong>PageGraph</strong> export? Open the <code>.graphml</code> to view it as a report: requests,
            storage, fingerprinting, and script-to-request causality, all rendered here.
          </span>
        </div>
        <PageGraphUploadButton onUploadReport={onUploadPageGraph}>Open PageGraph .graphml</PageGraphUploadButton>
      </div>
    </section>
  );
}

// Shared file-picker button. Resets the input after each pick so re-selecting
// the same file fires onChange again; an optional onError surfaces a rejected
// selection (callers that handle their own errors omit it).
function FileUploadButton({
  accept,
  onSelect,
  onError,
  children
}: {
  accept: string;
  onSelect: (file: File | null) => Promise<void>;
  onError?: (message: string) => void;
  children: ReactNode;
}) {
  return (
    <label className="secondary-button file-button">
      <Upload size={17} aria-hidden="true" />
      {children}
      <input
        type="file"
        accept={accept}
        onChange={(event) => {
          const input = event.currentTarget;
          const file = input.files?.[0] ?? null;
          const handled = onError
            ? onSelect(file).catch((error) =>
                onError(error instanceof Error ? error.message : "Report JSON could not be opened.")
              )
            : onSelect(file);
          void handled.finally(() => {
            input.value = "";
          });
        }}
      />
    </label>
  );
}

function PageGraphUploadButton({
  onUploadReport,
  children
}: {
  onUploadReport: (file: File | null) => Promise<void>;
  children: ReactNode;
}) {
  return (
    <FileUploadButton accept=".graphml,.xml,application/xml,text/xml" onSelect={onUploadReport}>
      {children}
    </FileUploadButton>
  );
}

function ReportUploadButton({
  onUploadReport,
  children
}: {
  onUploadReport: (file: File | null) => Promise<void>;
  children: ReactNode;
}) {
  return (
    <FileUploadButton accept="application/json,.json" onSelect={onUploadReport}>
      {children}
    </FileUploadButton>
  );
}

const FEATURED_MAX_PER_CATEGORY = 4;
const FEATURED_MAX_TOTAL = 12;

type FeaturedGroup = {
  category: FeaturedSiteConfig["categories"][number];
  items: { site: FeaturedSite; entry: StaticReportManifestEntry }[];
};

function pickFeaturedEntry(
  reports: StaticReportManifestEntry[],
  site: FeaturedSite,
  used: Set<string>
): StaticReportManifestEntry | null {
  const matches = reports.filter((report) => !used.has(report.id) && domainsMatch(report.domain, site.domain));
  if (matches.length === 0) return null;

  // Prefer comparisons (the GPC off/on gotcha makes the strongest card), then newest.
  return matches.sort((a, b) => {
    const aRank = a.reportType === "comparison" ? 0 : 1;
    const bRank = b.reportType === "comparison" ? 0 : 1;
    if (aRank !== bRank) return aRank - bRank;
    return Date.parse(b.scannedAt) - Date.parse(a.scannedAt);
  })[0];
}

function buildFeaturedGroups(config: FeaturedSiteConfig, reports: StaticReportManifestEntry[]): FeaturedGroup[] {
  const used = new Set<string>();
  const groups: FeaturedGroup[] = [];
  let total = 0;

  for (const category of config.categories) {
    if (total >= FEATURED_MAX_TOTAL) break;

    const items: FeaturedGroup["items"] = [];
    for (const site of config.sites.filter((candidate) => candidate.category === category.id)) {
      if (items.length >= FEATURED_MAX_PER_CATEGORY || total >= FEATURED_MAX_TOTAL) break;
      const entry = pickFeaturedEntry(reports, site, used);
      if (!entry) continue;
      used.add(entry.id);
      items.push({ site, entry });
      total += 1;
    }

    if (items.length > 0) groups.push({ category, items });
  }

  return groups;
}

async function loadStaticReport(entry: StaticReportManifestEntry): Promise<ScanReport> {
  const response = await fetch(committedReportLocation(entry.id, clientReportRuntime()).dataUrl, { cache: "no-store" });
  if (!response.ok) throw new Error(`Could not load ${entry.domain}.`);

  const payload = (await response.json()) as unknown;
  if (!isScanReport(payload)) throw new Error(`${entry.domain} is not a Site Behavior Lab report.`);
  return payload;
}

function FeaturedGallery({ reports }: { reports: StaticReportManifestEntry[] }) {
  const [config, setConfig] = useState<FeaturedSiteConfig | null>(null);
  const [ready, setReady] = useState(false);
  const [headlines, setHeadlines] = useState<Record<string, ReportHeadline>>({});

  useEffect(() => {
    let cancelled = false;

    async function loadConfig() {
      try {
        const response = await fetch(staticAssetPath("/featured-sites.json"), { cache: "no-store" });
        if (!response.ok) throw new Error("Featured config unavailable.");
        const payload = (await response.json()) as unknown;
        if (!cancelled) setConfig(isFeaturedSiteConfig(payload) ? payload : null);
      } catch {
        if (!cancelled) setConfig(null);
      } finally {
        if (!cancelled) setReady(true);
      }
    }

    void loadConfig();
    return () => {
      cancelled = true;
    };
  }, []);

  const groups = useMemo(() => (config ? buildFeaturedGroups(config, reports) : []), [config, reports]);
  const entries = useMemo(() => groups.flatMap((group) => group.items.map((item) => item.entry)), [groups]);
  const entryKey = entries.map((entry) => entry.id).join(",");

  useEffect(() => {
    if (entries.length === 0) return;
    let cancelled = false;

    async function loadHeadlines() {
      const resolved = await Promise.all(
        entries.map(async (entry) => {
          try {
            return [entry.id, buildReportHeadline(await loadStaticReport(entry))] as const;
          } catch {
            return null;
          }
        })
      );
      if (cancelled) return;
      const next: Record<string, ReportHeadline> = {};
      for (const item of resolved) {
        if (item) next[item[0]] = item[1];
      }
      setHeadlines(next);
    }

    void loadHeadlines();
    return () => {
      cancelled = true;
    };
    // entryKey captures the identity of the entries we need to fetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entryKey]);

  if (!ready || groups.length === 0) return null;

  return (
    <section className="featured-gallery" aria-labelledby="featured-title">
      <div className="featured-heading">
        <p className="eyebrow">Start here</p>
        <h3 id="featured-title">Real sites, already scanned</h3>
        <p>Open one to see what it actually did during a controlled visit. No scan needed.</p>
      </div>
      {groups.map((group) => (
        <div className="featured-group" key={group.category.id}>
          <h4>{group.category.label}</h4>
          <div className="featured-cards">
            {group.items.map(({ site, entry }) => (
              <FeaturedReportCard key={entry.id} site={site} entry={entry} headline={headlines[entry.id] ?? null} />
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}

function FeaturedReportCard({
  site,
  entry,
  headline
}: {
  site: FeaturedSite;
  entry: StaticReportManifestEntry;
  headline: ReportHeadline | null;
}) {
  const stats = headline?.stats.slice(0, 2) ?? [];

  return (
    <a
      className={`featured-card tone-${headline ? headline.tone : "loading"}`}
      href={committedReportLocation(entry.id, clientReportRuntime()).pagePath}
    >
      <span className="featured-card-top">
        <span className="featured-card-site">{site.label}</span>
        <span className="featured-card-dot" aria-hidden="true" />
      </span>
      <span className="featured-card-headline">{headline ? headline.headline : entry.title || site.domain}</span>
      <span className="featured-card-stats">
        {headline ? (
          stats.map((stat) => (
            <span className="featured-card-stat" key={stat.label}>
              <b>{stat.value}</b> {stat.label}
            </span>
          ))
        ) : (
          <span className="featured-card-stat">
            <b>{entry.metrics.thirdPartyRequests.toLocaleString()}</b> third-party
          </span>
        )}
      </span>
    </a>
  );
}

function StaticReportGallery({
  reports,
  error,
  onCreateComparison,
  onComparisonError
}: {
  reports: StaticReportManifestEntry[] | null;
  error: string | null;
  onCreateComparison: (comparison: ComparisonScanResult) => void;
  onComparisonError: (message: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<"all" | "comparison" | "single">("all");
  const [deviceFilter, setDeviceFilter] = useState<"all" | ScanDevice>("all");
  const [sortBy, setSortBy] = useState<"newest" | "domain" | "thirdParty" | "trackers">("newest");
  const [beforeReportId, setBeforeReportId] = useState("");
  const [afterReportId, setAfterReportId] = useState("");
  const [uploadBefore, setUploadBefore] = useState<UploadedCompareReport | null>(null);
  const [uploadAfter, setUploadAfter] = useState<UploadedCompareReport | null>(null);
  const [compareError, setCompareError] = useState<string | null>(null);
  const [compareLoading, setCompareLoading] = useState(false);

  const singleReports = useMemo(
    () =>
      (reports ?? [])
        .filter((report) => report.reportType === "single")
        .sort((a, b) => Date.parse(b.scannedAt) - Date.parse(a.scannedAt)),
    [reports]
  );

  const filteredReports = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const matches = (reports ?? []).filter((report) => {
      const searchable = `${report.title} ${report.domain} ${report.requestedUrl}`.toLowerCase();
      return (
        (!normalizedQuery || searchable.includes(normalizedQuery)) &&
        (typeFilter === "all" || report.reportType === typeFilter) &&
        (deviceFilter === "all" || report.device === deviceFilter)
      );
    });

    return matches.sort((a, b) => {
      if (sortBy === "domain") return a.domain.localeCompare(b.domain) || Date.parse(b.scannedAt) - Date.parse(a.scannedAt);
      if (sortBy === "thirdParty") return b.metrics.thirdPartyRequests - a.metrics.thirdPartyRequests || a.domain.localeCompare(b.domain);
      if (sortBy === "trackers") return b.metrics.knownTrackerRequests - a.metrics.knownTrackerRequests || a.domain.localeCompare(b.domain);
      return Date.parse(b.scannedAt) - Date.parse(a.scannedAt);
    });
  }, [deviceFilter, query, reports, sortBy, typeFilter]);

  useEffect(() => {
    if (singleReports.length === 0) return;
    setBeforeReportId((current) => current || singleReports[1]?.id || singleReports[0].id);
    setAfterReportId((current) => current || singleReports[0].id);
  }, [singleReports]);

  async function compareArchiveReports() {
    const before = singleReports.find((report) => report.id === beforeReportId) ?? null;
    const after = singleReports.find((report) => report.id === afterReportId) ?? null;
    if (!before || !after) {
      setCompareError("Choose two saved single-scan reports.");
      return;
    }
    if (before.id === after.id) {
      setCompareError("Choose two different reports.");
      return;
    }

    setCompareLoading(true);
    setCompareError(null);

    try {
      const [beforeReport, afterReport] = await Promise.all([loadStaticSingleReport(before), loadStaticSingleReport(after)]);
      onCreateComparison(createTemporalComparisonReport(beforeReport, afterReport));
    } catch (readError) {
      const message = readError instanceof Error ? readError.message : "Saved reports could not be compared.";
      setCompareError(message);
      onComparisonError(message);
    } finally {
      setCompareLoading(false);
    }
  }

  function compareUploadedReports() {
    if (!uploadBefore || !uploadAfter) {
      setCompareError("Open two single-scan report files.");
      return;
    }

    setCompareError(null);
    onCreateComparison(createTemporalComparisonReport(uploadBefore.report, uploadAfter.report));
  }

  if (reports === null) {
    return <p className="muted">Loading generated reports...</p>;
  }

  if (reports.length === 0) {
    return (
      <div className="static-gallery-empty">
        <FileJson size={18} aria-hidden="true" />
        <span>{error ?? "No generated reports committed yet."}</span>
      </div>
    );
  }

  return (
    <div className="static-gallery">
      <FeaturedGallery reports={reports} />
      <div className="static-gallery-heading">
        <div>
          <h3>Saved reports</h3>
          <p>{plural(reports.length, "report")} in the public archive</p>
        </div>
        <div className="static-gallery-heading-actions">
          <a className="directory-link" href={staticAssetPath("/directory/")}>
            Browse the full directory
            <ExternalLink size={14} aria-hidden="true" />
          </a>
          <span className="static-gallery-count" aria-live="polite">
            {filteredReports.length.toLocaleString()} shown
          </span>
        </div>
      </div>
      <div className="static-gallery-controls" aria-label="Filter saved reports">
        <label className="static-gallery-search">
          <Search size={16} aria-hidden="true" />
          <span className="visually-hidden">Search reports</span>
          <input
            type="search"
            value={query}
            placeholder="Search domain or URL"
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
        </label>
        <label>
          <span className="visually-hidden">Report type</span>
          <select value={typeFilter} onChange={(event) => setTypeFilter(event.currentTarget.value as "all" | "comparison" | "single")}>
            <option value="all">All types</option>
            <option value="comparison">Comparisons</option>
            <option value="single">Single scans</option>
          </select>
        </label>
        <label>
          <span className="visually-hidden">Device</span>
          <select value={deviceFilter} onChange={(event) => setDeviceFilter(event.currentTarget.value as "all" | ScanDevice)}>
            <option value="all">All devices</option>
            <option value="desktop">Desktop</option>
            <option value="mobile">Mobile</option>
          </select>
        </label>
        <label>
          <span className="visually-hidden">Sort reports</span>
          <select value={sortBy} onChange={(event) => setSortBy(event.currentTarget.value as "newest" | "domain" | "thirdParty" | "trackers")}>
            <option value="newest">Newest</option>
            <option value="domain">Domain</option>
            <option value="thirdParty">Most third-party</option>
            <option value="trackers">Most trackers</option>
          </select>
        </label>
      </div>
      {reports.length > 0 && (
        <section className="static-compare-panel" aria-labelledby="static-compare-title">
          <div className="static-compare-heading">
            <div>
              <h3 id="static-compare-title">Compare reports</h3>
              <p>Temporal diff from two single-scan reports</p>
            </div>
            {singleReports.length >= 2 && (
              <button className="primary-button" type="button" onClick={() => void compareArchiveReports()} disabled={compareLoading}>
                {compareLoading ? <Loader2 className="spin" size={17} aria-hidden="true" /> : <FileJson size={17} aria-hidden="true" />}
                Compare
              </button>
            )}
          </div>
          {singleReports.length >= 2 ? (
            <div className="static-compare-controls">
              <label>
                <span>Before</span>
                <select value={beforeReportId} onChange={(event) => setBeforeReportId(event.currentTarget.value)}>
                  {singleReports.map((report) => (
                    <option key={report.id} value={report.id}>
                      {staticReportOptionLabel(report)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>After</span>
                <select value={afterReportId} onChange={(event) => setAfterReportId(event.currentTarget.value)}>
                  {singleReports.map((report) => (
                    <option key={report.id} value={report.id}>
                      {staticReportOptionLabel(report)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          ) : (
            <p className="static-compare-note">Archive comparison appears when two single-scan reports are present.</p>
          )}
          <div className="static-compare-upload">
            <CompareUploadButton
              label={uploadBefore ? uploadBefore.name : "Open before JSON"}
              onUploadReport={async (file) => {
                const uploaded = await readCompareUpload(file, "before");
                setUploadBefore(uploaded);
                setCompareError(null);
              }}
              onError={setCompareError}
            />
            <CompareUploadButton
              label={uploadAfter ? uploadAfter.name : "Open after JSON"}
              onUploadReport={async (file) => {
                const uploaded = await readCompareUpload(file, "after");
                setUploadAfter(uploaded);
                setCompareError(null);
              }}
              onError={setCompareError}
            />
            <button className="secondary-button" type="button" onClick={compareUploadedReports}>
              <Upload size={17} aria-hidden="true" />
              Compare files
            </button>
          </div>
          {compareError && <p className="static-compare-error">{compareError}</p>}
        </section>
      )}
      <div className="static-report-list">
        {filteredReports.map((report) => (
          <StaticReportCard key={report.id} report={report} />
        ))}
      </div>
      {filteredReports.length === 0 && (
        <div className="static-gallery-empty">
          <FileJson size={18} aria-hidden="true" />
          <span>No reports match those filters.</span>
        </div>
      )}
    </div>
  );
}

function StaticReportCard({ report }: { report: StaticReportManifestEntry }) {
  return (
    <a className="static-report-card" href={committedReportLocation(report.id, clientReportRuntime()).pagePath}>
      <span className="static-report-main">
        <strong>{report.title || report.domain}</strong>
        <small>
          {report.domain} · {formatDateTime(report.scannedAt)}
        </small>
        <em>{report.requestedUrl}</em>
      </span>
      <span className="static-report-meta" aria-label={staticReportCardLabel(report)}>
        <b>{report.metrics.thirdPartyRequests.toLocaleString()} third-party</b>
        <small>
          {report.comparisonType === "shields" && (report.metrics.shieldsBlockedRequests ?? 0) > 0
            ? `Shields blocks ${(report.metrics.shieldsBlockedRequests ?? 0).toLocaleString()} · ${report.device}`
            : `${report.reportType === "comparison" ? "Comparison" : "Single"} · ${report.device}`}
        </small>
      </span>
    </a>
  );
}

type UploadedCompareReport = {
  name: string;
  report: ScanResult;
};

function CompareUploadButton({
  label,
  onUploadReport,
  onError
}: {
  label: string;
  onUploadReport: (file: File | null) => Promise<void>;
  onError: (message: string) => void;
}) {
  return (
    <FileUploadButton accept="application/json,.json" onSelect={onUploadReport} onError={onError}>
      <span className="compare-upload-label">{label}</span>
    </FileUploadButton>
  );
}

async function loadStaticSingleReport(entry: StaticReportManifestEntry): Promise<ScanResult> {
  const response = await fetch(committedReportLocation(entry.id, clientReportRuntime()).dataUrl, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Could not load ${entry.domain}.`);
  }

  const payload = (await response.json()) as unknown;
  if (!isScanReport(payload) || isComparisonReport(payload)) {
    throw new Error(`${entry.domain} is not a single-scan report.`);
  }

  return stripShareForComparison(payload);
}

async function readCompareUpload(file: File | null, slot: "before" | "after"): Promise<UploadedCompareReport> {
  if (!file) {
    throw new Error(`Open a ${slot} report file.`);
  }

  const payload = JSON.parse(await file.text()) as unknown;
  if (!isScanReport(payload) || isComparisonReport(payload)) {
    throw new Error("Choose a single-scan Site Behavior Lab JSON report.");
  }

  return {
    name: file.name,
    report: stripShareForComparison(payload)
  };
}

function stripShareForComparison(report: ScanResult): ScanResult {
  return { ...report, share: undefined };
}

function staticReportOptionLabel(report: StaticReportManifestEntry): string {
  return `${report.domain} · ${formatDateTime(report.scannedAt)} · ${report.device}`;
}

function staticReportCardLabel(report: StaticReportManifestEntry): string {
  const parts = [
    plural(report.metrics.thirdPartyRequests, "third-party request"),
    plural(report.metrics.knownTrackerRequests, "known tracker request"),
    plural(report.metrics.thirdPartyDomains, "third-party domain")
  ];
  if (report.comparisonType === "shields" && (report.metrics.shieldsBlockedRequests ?? 0) > 0) {
    parts.push(`${plural(report.metrics.shieldsBlockedRequests ?? 0, "request")} blocked by Shields`);
  }
  return parts.join(", ");
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

const SCAN_CHECKS: { icon: typeof Eye; label: string; question: string }[] = [
  { icon: Radar, label: "Ad & tracking services", question: "Which advertising and analytics companies received requests?" },
  { icon: Cookie, label: "Third-party cookies", question: "Cookies that can recognize you across other sites?" },
  { icon: Network, label: "Named platforms", question: "Did data go to Google, Meta, TikTok, or X?" },
  { icon: Radar, label: "Google Analytics remarketing", question: "Is Google Analytics also feeding ad-remarketing audiences?" },
  { icon: Fingerprint, label: "Fingerprint-like API calls", question: "Calls to canvas, WebGL, or audio APIs used for device recognition?" },
  { icon: Eye, label: "Session-replay vendors", question: "Known session-recording tools present on the page?" }
];

function LoadingState({ mode }: { mode: "single" | "gpc" | "shields" | "opening" }) {
  const [elapsed, setElapsed] = useState(0);
  const isComparison = mode === "gpc" || mode === "shields";
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
    <section className="loading-state" role="status">
      <span className="pulse-dot" />
      <h2>{isComparison ? "Running two controlled browser visits" : "Running controlled browser visit"}</h2>
      <p>
        {mode === "gpc"
          ? "Comparing GPC off and on runs for requests, cookies, storage, and browser API observations."
          : mode === "shields"
            ? "Comparing Shields off and block-simulated Shields on runs for requests, cookies, storage, and browser API observations."
          : "Collecting network requests, cookies, storage, and browser API observations."}
      </p>
      <div className="progress-track" aria-hidden="true">
        <div className="progress-fill" />
      </div>
      <p className="loading-elapsed">
        {elapsed}s elapsed{isComparison ? " · two visits, up to ~90s" : " · up to ~45s"}
      </p>
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
        Keystroke logging is not checked: it would need interaction this passive visit does not perform.
      </p>
    </section>
  );
}

function ReportHeader({
  report,
  result,
  onDownload,
  onDownloadCsv,
  liveApiServesReportPages
}: {
  report: ScanReport;
  result: ScanResult;
  onDownload: () => void;
  onDownloadCsv: () => void;
  liveApiServesReportPages: boolean;
}) {
  const sharePath = reportSharePath(report, liveApiServesReportPages);
  const finalUrl = safeHttpUrl(result.conditions.finalUrl);
  const title = isComparisonReport(report) ? report.title || result.summary.pageTitle : result.summary.pageTitle;
  return (
    <section className="report-header">
      <div>
        <p className="eyebrow">{isComparisonReport(report) ? "Comparison Report" : "Scan Report"}</p>
        <h2>{title || result.summary.firstPartyDomain}</h2>
        {finalUrl ? (
          <a href={finalUrl} target="_blank" rel="noreferrer">
            {result.conditions.finalUrl}
            <ExternalLink size={14} aria-hidden="true" />
          </a>
        ) : (
          <span className="report-url">{result.conditions.finalUrl}</span>
        )}
      </div>
      <div className="report-actions">
        {sharePath && (
          <>
            <a className="secondary-button" href={sharePath}>
              <ExternalLink size={17} aria-hidden="true" />
              Share
            </a>
            <CopyButton value={sharePath} label="share link" />
          </>
        )}
        <button className="secondary-button" type="button" onClick={onDownloadCsv} title="Download the request log as CSV">
          <Download size={17} aria-hidden="true" />
          CSV
        </button>
        <button className="secondary-button" type="button" onClick={onDownload}>
          <Download size={17} aria-hidden="true" />
          JSON
        </button>
      </div>
    </section>
  );
}

function safeHttpUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

type CausalEdge = { source: string; dest: string; requests: number; tracker: boolean };

function buildCausalEdges(requests: NetworkRequestRecord[]): CausalEdge[] {
  const map = new Map<string, CausalEdge>();

  for (const request of requests) {
    if (!request.thirdParty || !request.provenance) continue;
    const provenance = request.provenance;
    const source = provenance.scriptDomain || provenance.initiatorDomain || provenance.injectedByDomain;
    if (!source) continue;

    const dest = request.tracker?.entity || request.domain;
    const key = `${source}\u001f${dest}`;
    const existing = map.get(key);
    if (existing) {
      existing.requests += 1;
      continue;
    }
    map.set(key, { source, dest, requests: 1, tracker: Boolean(request.tracker) });
  }

  return Array.from(map.values())
    .sort((a, b) => b.requests - a.requests || a.source.localeCompare(b.source))
    .slice(0, 12);
}

function orderedUnique(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function truncateMiddle(value: string, max = 30): string {
  if (value.length <= max) return value;
  const keep = Math.floor((max - 1) / 2);
  return `${value.slice(0, keep)}…${value.slice(value.length - keep)}`;
}

function CausalityGraph({ result }: { result: ScanResult }) {
  const edges = useMemo(() => buildCausalEdges(result.requests), [result.requests]);
  if (edges.length === 0) return null;

  const sources = orderedUnique(edges.map((edge) => edge.source));
  const dests = orderedUnique(edges.map((edge) => edge.dest));
  const sourceReach = new Map<string, number>();
  const destTotals = new Map<string, number>();
  for (const edge of edges) {
    sourceReach.set(edge.source, (sourceReach.get(edge.source) ?? 0) + 1);
    destTotals.set(edge.dest, (destTotals.get(edge.dest) ?? 0) + edge.requests);
  }

  const colW = 250;
  const gap = 150;
  const nodeH = 44;
  const rowH = 58;
  const padY = 18;
  const width = colW * 2 + gap;
  const rows = Math.max(sources.length, dests.length);
  const height = padY * 2 + rows * rowH - (rowH - nodeH);
  const rightX = colW + gap;
  const maxReq = Math.max(...edges.map((edge) => edge.requests));

  const columnY = (count: number, index: number) => {
    const columnHeight = count * rowH - (rowH - nodeH);
    const offset = (height - columnHeight) / 2;
    return offset + index * rowH + nodeH / 2;
  };
  const sourceIndex = new Map(sources.map((source, index) => [source, index]));
  const destIndex = new Map(dests.map((dest, index) => [dest, index]));

  return (
    <section className="data-section causal-graph-card">
      <div className="section-heading">
        <h2>Causal map</h2>
        <span className="muted">Which script caused which third-party request, from PageGraph provenance.</span>
      </div>
      <div className="causal-graph-scroll">
        <svg
          className="causal-graph"
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={`Causal map of ${sources.length} scripts contacting ${dests.length} third-party destinations.`}
        >
          {edges.map((edge) => {
            const y1 = columnY(sources.length, sourceIndex.get(edge.source) ?? 0);
            const y2 = columnY(dests.length, destIndex.get(edge.dest) ?? 0);
            const x1 = colW;
            const x2 = rightX;
            const mx = (x1 + x2) / 2;
            const strokeWidth = 1.5 + (edge.requests / maxReq) * 5;
            return (
              <path
                key={`${edge.source}->${edge.dest}`}
                className={`causal-edge${edge.tracker ? " causal-edge-tracker" : ""}`}
                d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`}
                strokeWidth={strokeWidth}
                fill="none"
              />
            );
          })}
          {sources.map((source, index) => {
            const y = columnY(sources.length, index) - nodeH / 2;
            const reach = sourceReach.get(source) ?? 0;
            return (
              <g key={`s-${source}`} className="causal-node causal-node-source">
                <rect x={0} y={y} width={colW} height={nodeH} rx={8} />
                <text x={12} y={y + 18} className="causal-node-label">
                  {truncateMiddle(source)}
                </text>
                <text x={12} y={y + 34} className="causal-node-detail">
                  script → {plural(reach, "destination")}
                </text>
              </g>
            );
          })}
          {dests.map((dest, index) => {
            const y = columnY(dests.length, index) - nodeH / 2;
            const total = destTotals.get(dest) ?? 0;
            const isTracker = edges.some((edge) => edge.dest === dest && edge.tracker);
            return (
              <g key={`d-${dest}`} className={`causal-node causal-node-dest${isTracker ? " causal-node-tracker" : ""}`}>
                <rect x={rightX} y={y} width={colW} height={nodeH} rx={8} />
                <text x={rightX + 12} y={y + 18} className="causal-node-label">
                  {truncateMiddle(dest)}
                </text>
                <text x={rightX + 12} y={y + 34} className="causal-node-detail">
                  {plural(total, "request")}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </section>
  );
}

function ComparisonPanel({ report }: { report: ComparisonScanResult }) {
  const labels = comparisonRunLabels(report);
  const addedCookies = report.diff.addedCookies ?? [];
  const removedCookies = report.diff.removedCookies ?? [];
  const addedStorageKeys = report.diff.addedStorageKeys ?? [];
  const removedStorageKeys = report.diff.removedStorageKeys ?? [];
  const addedFingerprinting = report.diff.addedFingerprinting ?? [];
  const removedFingerprinting = report.diff.removedFingerprinting ?? [];
  const addedProvenance = report.diff.addedProvenance ?? [];
  const removedProvenance = report.diff.removedProvenance ?? [];
  const metrics = [
    { label: "Requests", metric: report.diff.totalRequests },
    { label: "Third-party requests", metric: report.diff.thirdPartyRequests },
    { label: "Known-service requests", metric: report.diff.knownTrackerRequests },
    { label: "Third-party domains", metric: report.diff.thirdPartyDomains },
    { label: "Cookies", metric: report.diff.cookies },
    { label: "Third-party cookies", metric: report.diff.thirdPartyCookies },
    { label: "Storage keys", metric: report.diff.storageEntries },
    { label: "Fingerprint events", metric: report.diff.fingerprintEvents },
    ...(report.diff.shieldsBlockedRequests ? [{ label: "Shields-blocked", metric: report.diff.shieldsBlockedRequests }] : [])
  ].filter((item): item is { label: string; metric: ComparisonMetricDelta } => Boolean(item.metric));

  return (
    <section className="comparison-card">
      <div className="comparison-heading">
        <div>
          <p className="eyebrow">{comparisonEyebrow(report)}</p>
          <h2>
            {labels.baseline} → {labels.variant} delta
          </h2>
        </div>
        <div className="comparison-runs">
          <span>
            {labels.baseline}: {report.baseline.summary.durationMs.toLocaleString()}ms
          </span>
          <span>
            {labels.variant}: {report.variant.summary.durationMs.toLocaleString()}ms
          </span>
        </div>
      </div>
      <div className="comparison-metrics">
        {metrics.map((item) => (
          <DeltaTile key={item.label} label={item.label} metric={item.metric} />
        ))}
      </div>
      <div className="comparison-lists">
        <ChangeList title={`Domains only with ${labels.variant}`} changes={report.diff.addedDomains} tone="added" />
        <ChangeList title={`Domains only with ${labels.baseline}`} changes={report.diff.removedDomains} tone="removed" />
        <EntityChangeList title={`Entities only with ${labels.variant}`} changes={report.diff.addedEntities} tone="added" />
        <EntityChangeList title={`Entities only with ${labels.baseline}`} changes={report.diff.removedEntities} tone="removed" />
        <CookieChangeList title={`Cookies only with ${labels.variant}`} changes={addedCookies} tone="added" />
        <CookieChangeList title={`Cookies only with ${labels.baseline}`} changes={removedCookies} tone="removed" />
        <StorageChangeList title={`Storage keys only with ${labels.variant}`} changes={addedStorageKeys} tone="added" />
        <StorageChangeList title={`Storage keys only with ${labels.baseline}`} changes={removedStorageKeys} tone="removed" />
        {(addedFingerprinting.length > 0 || removedFingerprinting.length > 0) && (
          <>
            <FingerprintingChangeList title={`Fingerprinting only with ${labels.variant}`} changes={addedFingerprinting} tone="added" />
            <FingerprintingChangeList title={`Fingerprinting only with ${labels.baseline}`} changes={removedFingerprinting} tone="removed" />
          </>
        )}
        {(addedProvenance.length > 0 || removedProvenance.length > 0) && (
          <>
            <ProvenanceChangeList title={`Causal paths only with ${labels.variant}`} changes={addedProvenance} tone="added" />
            <ProvenanceChangeList title={`Causal paths only with ${labels.baseline}`} changes={removedProvenance} tone="removed" />
          </>
        )}
      </div>
    </section>
  );
}

function comparisonRunLabels(report: ComparisonScanResult): { baseline: string; variant: string } {
  if (report.runLabels) return report.runLabels;
  if (report.comparisonType === "gpc") return { baseline: "GPC off", variant: "GPC on" };
  if (report.comparisonType === "shields") return { baseline: "Shields off", variant: "Shields on" };
  if (report.comparisonType === "temporal") return { baseline: "Before", variant: "After" };
  return { baseline: "Baseline", variant: "Variant" };
}

function comparisonEyebrow(report: ComparisonScanResult): string {
  if (report.comparisonType === "gpc") return "GPC Comparison";
  if (report.comparisonType === "shields") return "Shields Comparison";
  if (report.comparisonType === "temporal") return "Temporal Comparison";
  return "Comparison Report";
}

function DeltaTile({ label, metric }: { label: string; metric: ComparisonMetricDelta }) {
  const direction = metric.delta > 0 ? "up" : metric.delta < 0 ? "down" : "flat";
  const formattedDelta = `${metric.delta > 0 ? "+" : ""}${metric.delta.toLocaleString()}`;
  return (
    <div className={`delta-tile delta-${direction}`}>
      <span>{label}</span>
      <strong>{formattedDelta}</strong>
      <small>
        {metric.before.toLocaleString()} → {metric.after.toLocaleString()}
      </small>
    </div>
  );
}

const DIFF_COLLAPSED_COUNT = 6;

function DiffList<T>({
  title,
  emptyText,
  items,
  renderItem,
  className
}: {
  title: string;
  emptyText: string;
  items: T[];
  renderItem: (item: T, index: number) => ReactNode;
  className?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? items : items.slice(0, DIFF_COLLAPSED_COUNT);

  return (
    <div className={`change-list${className ? ` ${className}` : ""}`}>
      <h3>{title}</h3>
      {items.length === 0 ? (
        <p className="muted">{emptyText}</p>
      ) : (
        <>
          {visible.map(renderItem)}
          {items.length > DIFF_COLLAPSED_COUNT && (
            <button type="button" className="change-list-toggle" onClick={() => setExpanded((value) => !value)}>
              {expanded ? "Show fewer" : `Show all ${items.length}`}
            </button>
          )}
        </>
      )}
    </div>
  );
}

function ChangeList({ title, changes, tone }: { title: string; changes: DomainChange[]; tone: "added" | "removed" }) {
  return (
    <DiffList
      title={title}
      emptyText="No domain changes observed."
      items={changes}
      renderItem={(change) => (
        <div className={`change-row change-${tone}`} key={change.domain}>
          <span>
            <strong>{change.domain}</strong>
            <small>{change.tracker ? `${change.tracker.entity} · ${change.tracker.category}` : "unlabeled"}</small>
          </span>
          <b>{change.requests}</b>
        </div>
      )}
    />
  );
}

function EntityChangeList({ title, changes, tone }: { title: string; changes: EntityChange[]; tone: "added" | "removed" }) {
  return (
    <DiffList
      title={title}
      emptyText="No entity changes observed."
      items={changes}
      renderItem={(change) => (
        <div className={`change-row change-${tone}`} key={change.entity}>
          <span>
            <strong>{change.entity}</strong>
            <small>{plural(change.domains, "domain")}</small>
          </span>
          <b>{change.requests}</b>
        </div>
      )}
    />
  );
}

function CookieChangeList({ title, changes, tone }: { title: string; changes: CookieChange[]; tone: "added" | "removed" }) {
  return (
    <DiffList
      title={title}
      emptyText="No cookie changes observed."
      items={changes}
      renderItem={(change, index) => (
        <div className={`change-row change-${tone}`} key={`${change.name}:${change.domain}:${index}`}>
          <span>
            <strong>{change.name}</strong>
            <small>{change.domain}</small>
          </span>
          <b className="change-tag">{change.thirdParty ? "third-party" : "first-party"}</b>
        </div>
      )}
    />
  );
}

function StorageChangeList({ title, changes, tone }: { title: string; changes: StorageKeyChange[]; tone: "added" | "removed" }) {
  return (
    <DiffList
      title={title}
      emptyText="No storage key changes observed."
      items={changes}
      renderItem={(change, index) => (
        <div className={`change-row change-${tone}`} key={`${change.area}:${change.key}:${index}`}>
          <span>
            <strong>{change.key}</strong>
            <small>{change.area === "sessionStorage" ? "session storage" : "local storage"}</small>
          </span>
        </div>
      )}
    />
  );
}

function FingerprintingChangeList({ title, changes, tone }: { title: string; changes: FingerprintingChange[]; tone: "added" | "removed" }) {
  return (
    <DiffList
      title={title}
      emptyText="No fingerprinting changes observed."
      items={changes}
      renderItem={(change) => (
        <div className={`change-row change-${tone}`} key={change.kind}>
          <span>
            <strong>{fingerprintingKindLabel(change.kind)}</strong>
            <small>{change.heuristic}</small>
          </span>
          <b>{change.count}</b>
        </div>
      )}
    />
  );
}

function fingerprintingKindLabel(kind: FingerprintingChange["kind"]): string {
  switch (kind) {
    case "canvas-fingerprinting":
      return "Canvas readback";
    case "canvas-font-fingerprinting":
      return "Canvas font probing";
    case "webgl-fingerprinting":
      return "WebGL entropy read";
    case "audio-fingerprinting":
      return "Audio rendering";
    case "webrtc-fingerprinting":
      return "WebRTC peer connection";
    case "session-recording":
      return "Session-recording listeners";
    case "input-monitoring":
      return "Input-monitoring listeners";
    default:
      return kind;
  }
}

function ProvenanceChangeList({ title, changes, tone }: { title: string; changes: ProvenanceChange[]; tone: "added" | "removed" }) {
  return (
    <DiffList
      title={title}
      emptyText="No causal path changes observed."
      className="provenance-change-list"
      items={changes}
      renderItem={(change) => (
        <div
          className={`change-row change-${tone}`}
          key={`${change.domain}:${change.initiator ?? ""}:${change.script ?? ""}:${change.injectedBy ?? ""}`}
        >
          <span>
            <strong>{change.domain}</strong>
            <small>{provenanceChangeText(change)}</small>
          </span>
          <b>{change.requests}</b>
        </div>
      )}
    />
  );
}

function loadTurnstileScript(): Promise<void> {
  if (typeof window === "undefined") return Promise.reject(new Error("Turnstile is only available in the browser."));
  if (window.turnstile) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${TURNSTILE_SCRIPT_SRC}"]`);
    if (existing) {
      if (window.turnstile) {
        resolve();
        return;
      }
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("Turnstile failed to load.")), { once: true });
      return;
    }

    const script = document.createElement("script");
    script.src = TURNSTILE_SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.addEventListener("load", () => resolve(), { once: true });
    script.addEventListener("error", () => reject(new Error("Turnstile failed to load.")), { once: true });
    document.head.appendChild(script);
  });
}

// Renders a Cloudflare Turnstile widget and reports its single-use token. The
// parent bumps `resetNonce` after each scan so the widget issues a fresh token.
function TurnstileWidget({
  siteKey,
  resetNonce,
  onToken,
  onError
}: {
  siteKey: string;
  resetNonce: number;
  onToken: (token: string) => void;
  onError: (message: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const widgetIdRef = useRef<string | null>(null);
  const onTokenRef = useRef(onToken);
  const onErrorRef = useRef(onError);
  onTokenRef.current = onToken;
  onErrorRef.current = onError;

  useEffect(() => {
    let cancelled = false;

    loadTurnstileScript()
      .then(() => {
        if (cancelled || widgetIdRef.current || !containerRef.current || !window.turnstile) return;
        widgetIdRef.current = window.turnstile.render(containerRef.current, {
          sitekey: siteKey,
          callback: (token) => onTokenRef.current(token),
          "error-callback": () => {
            onTokenRef.current("");
            onErrorRef.current("Turnstile verification could not be completed. Reload and try again.");
          },
          "expired-callback": () => onTokenRef.current(""),
          "timeout-callback": () => onTokenRef.current("")
        });
      })
      .catch(() => {
        if (!cancelled) onErrorRef.current("Turnstile could not load. Check your connection and reload.");
      });

    return () => {
      cancelled = true;
      if (widgetIdRef.current && window.turnstile) {
        try {
          window.turnstile.remove(widgetIdRef.current);
        } catch {
          /* widget already gone */
        }
        widgetIdRef.current = null;
      }
    };
  }, [siteKey]);

  useEffect(() => {
    if (resetNonce === 0) return;
    onTokenRef.current("");
    if (widgetIdRef.current && window.turnstile) {
      try {
        window.turnstile.reset(widgetIdRef.current);
      } catch {
        /* nothing to reset */
      }
    }
  }, [resetNonce]);

  return <div className="turnstile-widget" ref={containerRef} />;
}

function HeadlineBanner({ report, liveApiServesReportPages }: { report: ScanReport; liveApiServesReportPages: boolean }) {
  const headline = useMemo(() => buildReportHeadline(report), [report]);
  const [shareLink, setShareLink] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;

    // Reuse the same permalink rule as the main Share button so "Post on X" /
    // "Copy post" never hand out a link the report's origin cannot render (a
    // JSON-only scan API has no report page); fall back to the current location.
    const sharePath = reportSharePath(report, liveApiServesReportPages);
    if (sharePath) {
      try {
        setShareLink(new URL(sharePath, window.location.origin).toString());
        return;
      } catch {
        /* fall through to current location */
      }
    }
    setShareLink(window.location.href);
  }, [report, liveApiServesReportPages]);

  const postText = shareLink ? `${headline.shareText} ${shareLink}` : headline.shareText;
  const xHref = `https://twitter.com/intent/tweet?${new URLSearchParams({
    text: headline.shareText,
    ...(shareLink ? { url: shareLink } : {})
  }).toString()}`;

  async function copyPost() {
    try {
      await navigator.clipboard.writeText(postText);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <section className={`headline-banner tone-${headline.tone}`} aria-label="Plain-language summary">
      <p className="headline-kicker">{headline.kicker}</p>
      <h2 className="headline-title">{headline.headline}</h2>
      <p className="headline-subhead">{headline.subhead}</p>

      {headline.stats.length > 0 && (
        <div className="headline-stats">
          {headline.stats.map((stat) => (
            <div className={`headline-stat${stat.emphasis ? " is-emphasis" : ""}`} key={stat.label}>
              <span className="headline-stat-value">{stat.value}</span>
              <span className="headline-stat-label">{stat.label}</span>
            </div>
          ))}
        </div>
      )}

      <div className="headline-footer">
        <span className="headline-caveat">{headline.caveat}</span>
        <div className="headline-actions">
          <a className="headline-share primary" href={xHref} target="_blank" rel="noreferrer">
            <ExternalLink size={15} aria-hidden="true" />
            Post on X
          </a>
          <button type="button" className="headline-share" onClick={copyPost}>
            {copied ? <CheckCircle2 size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
            {copied ? "Copied" : "Copy post"}
          </button>
        </div>
      </div>
    </section>
  );
}

// Module-level cache so the corpus stats are fetched once per session.
let corpusStatsCache: CorpusStats | null | undefined;

function useCorpusStats(): CorpusStats | null {
  const [corpus, setCorpus] = useState<CorpusStats | null>(corpusStatsCache ?? null);

  useEffect(() => {
    if (corpusStatsCache !== undefined) {
      setCorpus(corpusStatsCache);
      return;
    }

    let cancelled = false;

    async function loadCorpus() {
      try {
        const response = await fetch(staticAssetPath("/corpus-stats.json"), { cache: "no-store" });
        if (!response.ok) throw new Error("Corpus stats unavailable.");
        const payload = (await response.json()) as unknown;
        corpusStatsCache = isCorpusStats(payload) ? payload : null;
      } catch {
        corpusStatsCache = null;
      }
      if (!cancelled) setCorpus(corpusStatsCache ?? null);
    }

    void loadCorpus();
    return () => {
      cancelled = true;
    };
  }, []);

  return corpus;
}

// Maps the findings engine's React-free icon keys to lucide components.
const FINDING_ICONS: Record<FindingIconKey, typeof Eye> = {
  globe: Globe2,
  network: Network,
  radar: Radar,
  cookie: Cookie,
  eye: Eye,
  fingerprint: Fingerprint,
  "shield-check": ShieldCheck,
  check: CheckCircle2,
  alert: AlertTriangle
};

function FindingsBoard({ report, result }: { report: ScanReport; result: ScanResult }) {
  const corpus = useCorpusStats();
  const findings = buildFindings(report, result, corpus);

  return (
    <section className="findings-board">
      <div className="findings-heading">
        <div>
          <p className="eyebrow">Plain-Language Findings</p>
          <h2>What this visit means</h2>
        </div>
        <span>{result.conditions.automation}</span>
      </div>
      <div className="finding-list">
        {findings.map((finding) => {
          const Icon = FINDING_ICONS[finding.icon];
          return (
            <article className={`finding-card tile-${finding.level}`} key={finding.id}>
              <div className="finding-icon">
                <Icon size={18} aria-hidden="true" />
              </div>
              <div>
                <h3>{finding.title}</h3>
                <p className="finding-lead">{finding.lead}</p>
                <p>{finding.detail}</p>
                <div className="finding-meta">
                  <span>{finding.evidence}</span>
                  {finding.benchmark && <span>{finding.benchmark}</span>}
                </div>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function MetricGrid({ result }: { result: ScanResult }) {
  const knownServices = trackerEntitySummaries(result).length;
  const apiFamilies = result.fingerprintEvents.length;
  const detectionCount = fingerprintDetectionCount(result);
  const metrics = [
    {
      label: "Requests",
      value: result.summary.totalRequests,
      detail: `${result.summary.thirdPartyRequests.toLocaleString()} third-party`,
      icon: Network
    },
    ...(result.conditions.adblock?.active
      ? [
          {
            label: "Shields blocks",
            value: result.summary.shieldsBlockedRequests ?? 0,
            detail: `of ${result.summary.totalRequests.toLocaleString()} requests`,
            icon: ShieldCheck
          }
        ]
      : []),
    {
      label: "Third-party domains",
      value: result.summary.thirdPartyDomains,
      detail: `${knownServices.toLocaleString()} known ${knownServices === 1 ? "service" : "services"}`,
      icon: Globe2
    },
    {
      label: "Cookies",
      value: result.summary.cookies,
      detail: `${result.summary.thirdPartyCookies.toLocaleString()} third-party`,
      icon: Cookie
    },
    { label: "Storage keys", value: result.summary.storageEntries, detail: "values redacted", icon: Database },
    {
      label: "Fingerprint-like calls",
      value: result.summary.fingerprintEvents,
      detail:
        detectionCount > 0
          ? `${plural(detectionCount, "behavior")} matched`
          : `${apiFamilies.toLocaleString()} API ${apiFamilies === 1 ? "family" : "families"}`,
      icon: Fingerprint
    },
    {
      label: "GPC signal",
      value: result.conditions.gpcEnabled ? "Sent" : "Off",
      detail: result.conditions.gpcEnabled ? "opt-out sent" : "no opt-out sent",
      icon: result.conditions.gpcEnabled ? ShieldCheck : Shield
    },
    {
      label: "Duration",
      value: `${Math.round(result.summary.durationMs / 100) / 10}s`,
      detail: new Date(result.conditions.scannedAt).toLocaleTimeString(),
      icon: Clock
    }
  ];

  return (
    <section className="numbers-section">
      <div className="numbers-heading">
        <p className="eyebrow">By the numbers</p>
        <span>Raw counts from this one visit. The findings above interpret them.</span>
      </div>
      <div className="metric-grid">
        {metrics.map((metric) => {
          const Icon = metric.icon;
          return (
            <div className="metric-card" key={metric.label}>
              <Icon size={18} aria-hidden="true" />
              <span className="m-label">{metric.label}</span>
              <strong className="m-value">
                {typeof metric.value === "number" ? metric.value.toLocaleString() : metric.value}
              </strong>
              <small className="m-detail">{metric.detail}</small>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function TrafficViz({ result }: { result: ScanResult }) {
  const total = result.summary.totalRequests;
  const tracker = result.summary.knownTrackerRequests;
  const third = Math.max(result.summary.thirdPartyRequests - tracker, 0);
  const first = Math.max(total - result.summary.thirdPartyRequests, 0);

  const pct = (n: number) => (total > 0 ? `${(n / total) * 100}%` : "0%");

  return (
    <section className="viz-card">
      <h2>Request composition &amp; timeline</h2>
      <div className="party-bar" role="img" aria-label={`${first} first-party, ${third} third-party, ${tracker} known-service requests`}>
        {first > 0 && <span className="party-seg-first" style={{ width: pct(first) }} />}
        {third > 0 && <span className="party-seg-third" style={{ width: pct(third) }} />}
        {tracker > 0 && <span className="party-seg-track" style={{ width: pct(tracker) }} />}
      </div>
      <div className="party-legend">
        <div>
          <span className="legend-swatch party-seg-first" />
          First-party <span className="legend-count">{first.toLocaleString()}</span>
        </div>
        <div>
          <span className="legend-swatch party-seg-third" />
          Third-party <span className="legend-count">{third.toLocaleString()}</span>
        </div>
        <div>
          <span className="legend-swatch party-seg-track" />
          Known service <span className="legend-count">{tracker.toLocaleString()}</span>
        </div>
      </div>
      <RequestTimeline requests={result.requests} />
    </section>
  );
}

function RequestTimeline({ requests }: { requests: NetworkRequestRecord[] }) {
  if (requests.length === 0) return null;
  const maxTime = Math.max(...requests.map((request) => request.startedAtMs), 1);
  const width = 1000;
  const height = 44;

  return (
    <div className="timeline">
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label="When requests fired during the visit">
        {requests.map((request) => {
          const x = (request.startedAtMs / maxTime) * (width - 2);
          const color = request.tracker
            ? "var(--sig-warn)"
            : request.thirdParty
              ? "var(--sig-info)"
              : "var(--sig-quiet)";
          return <rect key={request.id} x={x} y={request.tracker ? 4 : request.thirdParty ? 12 : 20} width={2} height={height - 24} fill={color} opacity={0.85} rx={1} />;
        })}
      </svg>
      <div className="timeline-axis">
        <span>0 ms</span>
        <span>{maxTime.toLocaleString()} ms</span>
      </div>
    </div>
  );
}

function Warnings({ warnings }: { warnings: string[] }) {
  if (warnings.length === 0) return null;
  return (
    <section className="warnings">
      {warnings.map((warning) => (
        <div key={warning}>
          <AlertTriangle size={16} aria-hidden="true" />
          <span>{warning}</span>
        </div>
      ))}
    </section>
  );
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="ghost-button"
      aria-label={`Copy ${label}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        } catch {
          /* clipboard unavailable */
        }
      }}
    >
      {copied ? <CheckCircle2 size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
    </button>
  );
}

function roleTag(domain: DomainSummary) {
  if (domain.tracker) return <span className="role-tag role-tracker">service</span>;
  if (domain.thirdParty) return <span className="role-tag role-third">third-party</span>;
  return <span className="role-tag role-first">first-party</span>;
}

function DomainTable({ domains }: { domains: DomainSummary[] }) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(
    () => domains.filter((domain) => domain.domain.toLowerCase().includes(query.toLowerCase())),
    [domains, query]
  );

  return (
    <details className="data-section disclosure" open>
      <summary className="section-heading">
        <h2>Domain evidence</h2>
        <span className="count-badge">{domains.length} domains</span>
        <ChevronDown className="disclosure-chevron" size={16} aria-hidden="true" />
      </summary>
      <div className="section-tools disclosure-tools">
        <input
          className="filter-input"
          type="search"
          placeholder="Filter domains"
          value={query}
          aria-label="Filter domains"
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Domain</th>
              <th>Role</th>
              <th>Requests</th>
              <th>Known service</th>
              <th>Resource types</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((domain) => (
              <tr key={domain.domain}>
                <td className="mono" data-label="Domain">{domain.domain}</td>
                <td data-label="Role">{roleTag(domain)}</td>
                <td data-label="Requests">{domain.requests.toLocaleString()}</td>
                <td data-label="Known service">{domain.tracker ? `${domain.tracker.entity}: ${domain.tracker.category}` : "-"}</td>
                <td data-label="Resource types">{domain.resourceTypes.join(", ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {filtered.length === 0 && <p className="table-empty">No domains match &ldquo;{query}&rdquo;.</p>}
      </div>
    </details>
  );
}

function RequestTable({ result }: { result: ScanResult }) {
  const [query, setQuery] = useState("");
  const [signalFilter, setSignalFilter] = useState<RequestSignalFilter>("all");
  const [statusFilter, setStatusFilter] = useState<RequestStatusFilter>("all");
  const [resourceFilter, setResourceFilter] = useState("all");

  const resourceTypes = useMemo(
    () => Array.from(new Set(result.requests.map((request) => request.resourceType))).sort((a, b) => a.localeCompare(b)),
    [result.requests]
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return result.requests.filter((request) => {
      if (!requestMatchesSignalFilter(request, signalFilter)) return false;
      if (!requestMatchesStatusFilter(request, statusFilter)) return false;
      if (resourceFilter !== "all" && request.resourceType !== resourceFilter) return false;
      if (!q) return true;
      return (
        request.domain.toLowerCase().includes(q) ||
        request.url.toLowerCase().includes(q) ||
        request.method.toLowerCase().includes(q) ||
        request.resourceType.toLowerCase().includes(q) ||
        requestProvenanceSearchText(request).toLowerCase().includes(q) ||
        request.tracker?.entity.toLowerCase().includes(q) ||
        request.tracker?.category.toLowerCase().includes(q)
      );
    });
  }, [result.requests, query, resourceFilter, signalFilter, statusFilter]);

  const shown = filtered.slice(0, 80);

  return (
    <details className="data-section disclosure">
      <summary className="section-heading">
        <h2>Request log</h2>
        <span className="count-badge">
          {filtered.length === result.requests.length
            ? `${result.requests.length} requests`
            : `${filtered.length} of ${result.requests.length}`}
        </span>
        <ChevronDown className="disclosure-chevron" size={16} aria-hidden="true" />
      </summary>
      <div className="section-tools disclosure-tools request-log-tools">
        <div className="request-filter-chips" role="group" aria-label="Request signal filters">
          {REQUEST_SIGNAL_FILTERS.map((filter) => (
            <button
              key={filter.value}
              type="button"
              className={signalFilter === filter.value ? "secondary-button" : "ghost-button"}
              aria-pressed={signalFilter === filter.value}
              onClick={() => setSignalFilter(filter.value)}
            >
              {filter.label}
            </button>
          ))}
        </div>
        <input
          className="filter-input"
          type="search"
          placeholder="Filter requests"
          value={query}
          aria-label="Filter requests"
          onChange={(event) => setQuery(event.target.value)}
        />
        <label>
          <span className="visually-hidden">Status</span>
          <select value={statusFilter} onChange={(event) => setStatusFilter(event.currentTarget.value as RequestStatusFilter)}>
            <option value="all">All status</option>
            <option value="ok">2xx</option>
            <option value="redirect">3xx</option>
            <option value="client-error">4xx</option>
            <option value="server-error">5xx</option>
            <option value="pending">No status</option>
          </select>
        </label>
        <label>
          <span className="visually-hidden">Resource type</span>
          <select value={resourceFilter} onChange={(event) => setResourceFilter(event.currentTarget.value)}>
            <option value="all">All types</option>
            {resourceTypes.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="table-wrap request-table">
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>Status</th>
              <th>Type</th>
              <th>Domain</th>
              <th>Provenance</th>
              <th>URL</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((request) => (
              <tr key={request.id}>
                <td className="mono" data-label="Time">{request.startedAtMs.toLocaleString()}ms</td>
                <td data-label="Status">
                  <StatusCell status={request.status} />
                </td>
                <td data-label="Type">{request.resourceType}</td>
                <td className="mono" data-label="Domain">{request.domain}</td>
                <td data-label="Provenance">
                  <RequestProvenanceCell request={request} />
                </td>
                <td className="url-cell mono" data-label="URL">{request.url}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {shown.length === 0 && <p className="table-empty">No requests match the current filter.</p>}
        {filtered.length > shown.length && (
          <p className="row-more">Showing first 80 of {filtered.length} matching requests. Export JSON for the full log.</p>
        )}
      </div>
    </details>
  );
}

type RequestSignalFilter = "all" | "third-party" | "known-service" | "shields-blocked" | "fingerprinting" | "provenance";
type RequestStatusFilter = "all" | "ok" | "redirect" | "client-error" | "server-error" | "pending";

const REQUEST_SIGNAL_FILTERS: { value: RequestSignalFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "third-party", label: "Third-party" },
  { value: "known-service", label: "Known services" },
  { value: "shields-blocked", label: "Shields-blocked" },
  { value: "fingerprinting", label: "Fingerprinting" },
  { value: "provenance", label: "Provenance" }
];

function requestMatchesSignalFilter(request: NetworkRequestRecord, filter: RequestSignalFilter): boolean {
  if (filter === "third-party") return request.thirdParty;
  if (filter === "known-service") return Boolean(request.tracker);
  if (filter === "shields-blocked") return request.blockedByShields === true;
  if (filter === "fingerprinting") return (request.tracker?.fingerprinting ?? 0) > 0;
  if (filter === "provenance") return Boolean(request.provenance);
  return true;
}

function requestMatchesStatusFilter(request: NetworkRequestRecord, filter: RequestStatusFilter): boolean {
  const status = request.status;
  if (filter === "pending") return status === null;
  if (status === null) return filter === "all";
  if (filter === "ok") return status >= 200 && status < 300;
  if (filter === "redirect") return status >= 300 && status < 400;
  if (filter === "client-error") return status >= 400 && status < 500;
  if (filter === "server-error") return status >= 500;
  return true;
}

function RequestProvenanceCell({ request }: { request: NetworkRequestRecord }) {
  const summary = requestProvenanceSummary(request);
  if (!summary) return <span className="muted">-</span>;

  return (
    <span className="provenance-cell">
      <span>{summary.primary}</span>
      {summary.secondary && <small>{summary.secondary}</small>}
    </span>
  );
}

function StatusCell({ status }: { status: number | null }) {
  if (status === null) return <span className="status-pending">n/a</span>;
  if (status >= 400) return <span className="status-bad">{status}</span>;
  return <span className="status-ok">{status}</span>;
}

function TopThirdParties({ domains }: { domains: DomainSummary[] }) {
  const top = domains.filter((domain) => domain.thirdParty).slice(0, 8);
  if (top.length === 0) return <p className="muted">No third-party domains observed in this scan.</p>;

  return (
    <div className="domain-stack">
      {top.map((domain) => (
        <div className="domain-chip" key={domain.domain}>
          <div className="chip-main">
            <strong>{domain.domain}</strong>
            <span className="chip-sub">{domain.tracker ? `${domain.tracker.entity} · ${domain.tracker.category}` : "unlabeled third party"}</span>
          </div>
          <span className="count-pill">{domain.requests.toLocaleString()}</span>
        </div>
      ))}
    </div>
  );
}

function CookieList({ cookies }: { cookies: CookieRecord[] }) {
  if (cookies.length === 0) return <p className="muted">No cookies were visible to the scan context.</p>;

  return (
    <div className="compact-list">
      {cookies.slice(0, 12).map((cookie) => (
        <div key={`${cookie.domain}:${cookie.name}:${cookie.path}`}>
          {cookie.thirdParty ? (
            <AlertTriangle className="ico-third" size={14} aria-hidden="true" />
          ) : (
            <CheckCircle2 className="ico-first" size={14} aria-hidden="true" />
          )}
          <span>
            {cookie.name}
            <small>
              {cookie.domain} · {cookie.session ? "session" : "persistent"} · {cookie.thirdParty ? "third-party" : "first-party"}
            </small>
          </span>
        </div>
      ))}
    </div>
  );
}

function StorageList({ result }: { result: ScanResult }) {
  if (result.storage.length === 0) return <p className="muted">No local or session storage keys observed on the final page.</p>;

  return (
    <div className="compact-list">
      {result.storage.slice(0, 12).map((item) => (
        <div key={`${item.area}:${item.key}`}>
          <Database className="ico-neutral" size={14} aria-hidden="true" />
          <span>
            {item.key}
            <small>
              {item.area} · {item.valueBytes} bytes
            </small>
          </span>
        </div>
      ))}
    </div>
  );
}

function FingerprintList({ result }: { result: ScanResult }) {
  const detections = fingerprintDetections(result);
  if (result.fingerprintEvents.length === 0 && detections.length === 0) {
    return <p className="muted">No instrumented high-entropy API or interaction listener signals were observed.</p>;
  }

  return (
    <div className="compact-list">
      {detections.map((detection) => (
        <div key={detection.kind}>
          <Fingerprint className="ico-warn" size={14} aria-hidden="true" />
          <span>
            {detectionLabel(detection)}
            <small>{detectionEvidence(detection)}</small>
          </span>
        </div>
      ))}
      {result.fingerprintEvents.map((event) => (
        <div key={event.api}>
          <Fingerprint className="ico-neutral" size={14} aria-hidden="true" />
          <span>
            {event.api}
            <small>{event.count} calls</small>
          </span>
        </div>
      ))}
    </div>
  );
}
