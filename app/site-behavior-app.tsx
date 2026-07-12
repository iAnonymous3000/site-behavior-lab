"use client";

import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Cookie,
  Copy,
  Download,
  ExternalLink,
  Eye,
  FileJson,
  Fingerprint,
  FlaskConical,
  Github,
  Globe2,
  Keyboard,
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
  Sun
} from "lucide-react";
import type { FormEvent, MouseEvent } from "react";
import { useEffect, useRef, useState } from "react";
import { CausalityGraph } from "./_components/causality-graph";
import { ComparisonPanel } from "./_components/comparison-panel";
import { PageGraphUploadButton, ReportUploadButton } from "./_components/file-upload-button";
import {
  absoluteShareUrl,
  FindingsBoard,
  HeadlineBanner,
  MetricGrid,
  reportSharePath,
  TrafficViz
} from "./_components/report-overview";
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
import {
  LIVE_SCAN_ENABLED,
  LIVE_SCAN_TURNSTILE_SITE_KEY,
  OPEN_ACCESS_SCANNER,
  SCAN_WORKFLOW_URL,
  STATIC_EXPORT,
  STATIC_LIVE_SCAN_ENABLED,
  clientReportRuntime,
  scannerApiUrl,
  staticAssetPath
} from "./client-runtime";
import { consentChoiceLabel } from "@/lib/consent-interaction";
import { requestLogToCsv } from "@/lib/csv-export";
import { displayableScreenshot } from "@/lib/report-insights";
import { committedReportLocation } from "@/lib/report-locator";
import { isScanRuntimeHealth, type ScanRuntimeHealth } from "@/lib/scan-runtime-health";
import { RUN_MODE_LABELS, RUN_MODE_TITLES, runModeHint, type RunMode } from "@/lib/run-mode-copy";
import { plural } from "@/lib/text-format";
import { readLoadedReport } from "@/lib/client-report-reader";
import { recoverSavedReport } from "@/lib/saved-report-recovery";
import {
  comparisonArmViews,
  displayRunView,
  familyCensoredOnRun,
  runQualitySummary,
  schemaProvenanceLabel,
  viewFromV1Report,
  type ReportView,
  type RunView
} from "@/lib/scan-report-views";
// Type-only: the deep reader module stays lazy-loaded (client-report-reader);
// a type import is erased at build time and adds nothing to the bundle.
import type { LoadedReport } from "@/lib/scan-report-view";
import { REPORT_ID_PATTERN } from "@/lib/report-validation";
import { safeNavigableHttpUrl } from "@/lib/report-url";
import type {
  ComparisonScanResult,
  ReportShare,
  ScanApiResponse,
  ScanDevice,
  ScanJobApiResponse,
  ScanJobSubmissionResponse,
  ScanReport,
  StaticReportManifestEntry
} from "@/lib/types";

type ScanFormState = {
  url: string;
  device: ScanDevice;
  gpcEnabled: boolean;
  compareGpc: boolean;
  compareShields: boolean;
  compareConsent: boolean;
  accessKey: string;
};

const initialForm: ScanFormState = {
  url: "",
  device: "desktop",
  gpcEnabled: true,
  compareGpc: false,
  compareShields: false,
  compareConsent: false,
  accessKey: ""
};

function isComparisonMode(form: ScanFormState): boolean {
  return form.compareGpc || form.compareShields || form.compareConsent;
}

// One plain-language line under the run controls. "Brave Shields" and "GPC" are
// jargon to a first-time visitor, so the selected mode always explains itself;
// the copy lives in lib/run-mode-copy.ts where unit tests pin it.
function selectedRunMode(form: ScanFormState): RunMode {
  return form.compareShields ? "shields" : form.compareGpc ? "gpc" : form.compareConsent ? "consent" : "single";
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
  /** A pre-loaded report (the saved-report permalink page's read result). */
  initialLoaded?: LoadedReport | null;
  initialError?: string | null;
  initialLoading?: boolean;
  corpusHighlights?: CorpusHighlights | null;
};

export function SiteBehaviorApp({
  initialLoaded = null,
  initialError = null,
  initialLoading = false,
  corpusHighlights = null
}: SiteBehaviorAppProps) {
  const [form, setForm] = useState<ScanFormState>(initialForm);
  // The shell's report state is the version-independent LoadedReport (RFC
  // 14.8 atomic consumer migration): original wire retained for share links
  // and exports, the view for every render read.
  const [loaded, setLoaded] = useState<LoadedReport | null>(initialLoaded);
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
  // Set when a submit stripped a query string/fragment from the typed URL, so
  // the user understands why the address in the box changed.
  const [urlNotice, setUrlNotice] = useState("");

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
    setLoaded(initialLoaded);
  }, [initialLoaded]);

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
  const consentComparisonEnabled = !STATIC_EXPORT || scannerHealth?.capabilities?.consentComparison === true;
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
      compareShields: current.compareShields && shieldsComparisonEnabled,
      compareConsent: current.compareConsent && consentComparisonEnabled
    }));
  }, [consentComparisonEnabled, gpcComparisonEnabled, shieldsComparisonEnabled]);

  async function runScan(targetUrl: string) {
    if (!LIVE_SCAN_ENABLED) {
      setLoading(false);
      setLoaded(null);
      setError("This published build cannot run live scans. Use an Actions-generated report, upload JSON, or run the Node app locally.");
      return;
    }
    if (scannerUnavailable) {
      setLoading(false);
      setLoaded(null);
      setError(scannerHealthError || "The public scanner is not available right now. Try again shortly.");
      return;
    }
    if (turnstileUnsupported) {
      setLoading(false);
      setLoaded(null);
      setError(
        "This scanner requires Turnstile verification, but this site was not built with a Turnstile site key. Rebuild with NEXT_PUBLIC_SITE_BEHAVIOR_LAB_TURNSTILE_SITE_KEY set to the Worker's site key."
      );
      return;
    }
    if (awaitingTurnstile) {
      setLoading(false);
      setLoaded(null);
      setError("Complete the Turnstile check before scanning.");
      return;
    }

    setLoading(true);
    setScanning(true);
    setError(null);
    setLoaded(null);

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
          compareConsent: consentComparisonEnabled && form.compareConsent,
          consentMode: "observe",
          ...(turnstileRequired && turnstileToken ? { turnstileToken } : {})
        })
      });
      const payload = (await response.json()) as ScanApiResponse;
      if (!payload.ok) throw new Error(payload.error);
      if (isScanJobSubmissionResponse(payload)) {
        setLoaded(await pollScanJob(payload.statusPath, scannerRequiresAccessKey ? accessKey : "", payload.reportId));
        return;
      }
      // A synchronous scan result is untrusted wire data like every other
      // payload: it goes through the canonical reader, never a bare cast.
      const read = await readLoadedReport(payload, "The scan result");
      if (!read.ok) throw new Error(read.message);
      setLoaded(read.loaded);
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
    const normalized = normalizeScanUrl(trimmed);
    setForm((current) => ({ ...current, url: normalized }));
    setUrlNotice(
      /[?#]/.test(trimmed)
        ? "Removed the query string and fragment from the URL for privacy before scanning."
        : ""
    );
    void runScan(normalized);
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
    setLoaded(null);

    try {
      const payload = JSON.parse(await file.text()) as unknown;
      const read = await readLoadedReport(payload, "This report JSON");
      if (!read.ok) {
        throw new Error(read.message);
      }
      setLoaded(stripShareFromLoaded(read.loaded));
    } catch (readError) {
      setError(readError instanceof Error ? readError.message : "Report JSON could not be opened.");
    }
  }

  async function loadPageGraphFile(file: File | null) {
    if (!file) return;
    setLoading(false);
    setError(null);
    setLoaded(null);

    try {
      const graphml = await file.text();
      // Code-split the PageGraph parser (and its tldts dependency) so it loads
      // only when a GraphML file is actually opened, keeping the main bundle lean.
      const { pageGraphUploadToScanResult } = await import("@/lib/pagegraph-parser");
      setLoaded(loadedFromV1Wire(pageGraphUploadToScanResult(graphml)));
    } catch (readError) {
      setError(readError instanceof Error ? readError.message : "PageGraph file could not be parsed.");
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
  // lead run; report-level surfaces (headline, findings, panel) stay pair-fed.
  const [selectedArm, setSelectedArm] = useState<"baseline" | "variant" | null>(null);
  // A new report must not inherit the previous report's arm selection.
  useEffect(() => {
    setSelectedArm(null);
  }, [loaded]);
  const displayedRun = arms && selectedArm ? arms[selectedArm] : primaryRun;
  const displayedArmLabel: "baseline" | "variant" =
    selectedArm ?? (reportView?.comparison?.temporalPair ? "variant" : "baseline");

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
          onChange={(event) => {
            setUrlNotice("");
            setForm((current) => ({ ...current, url: event.target.value }));
          }}
          placeholder="https://example.com"
        />
        <button className={`primary-button${loading ? " is-loading" : ""}`} type="submit" disabled={loading || scanBlocked}>
          {loading ? <Loader2 className="spin" size={18} aria-hidden="true" /> : <Search size={18} aria-hidden="true" />}
          {isComparisonMode(form) ? "Compare" : "Scan"}
        </button>
      </div>

      {urlNotice && (
        <p className="scanner-status-note url-privacy-note">{urlNotice}</p>
      )}

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

      {awaitingTurnstile && (
        <p className="scanner-status-note">
          Finishing a quick browser check above. Scan turns on once it passes; reload the page if it does not complete.
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
                title={RUN_MODE_TITLES.single}
                onClick={() => setForm((current) => ({ ...current, compareGpc: false, compareShields: false, compareConsent: false }))}
              >
                <Search size={16} aria-hidden="true" />
                {RUN_MODE_LABELS.single}
              </button>
              <button
                type="button"
                aria-pressed={form.compareGpc}
                className={form.compareGpc ? "active" : ""}
                disabled={!gpcComparisonEnabled}
                title={gpcComparisonEnabled ? RUN_MODE_TITLES.gpc : "GPC comparison is not available from this scanner."}
                onClick={() =>
                  setForm((current) => ({ ...current, compareGpc: gpcComparisonEnabled, compareShields: false, compareConsent: false }))
                }
              >
                <ShieldCheck size={16} aria-hidden="true" />
                {RUN_MODE_LABELS.gpc}
              </button>
              <button
                type="button"
                aria-pressed={form.compareShields}
                className={form.compareShields ? "active" : ""}
                disabled={!shieldsComparisonEnabled}
                title={shieldsComparisonEnabled ? RUN_MODE_TITLES.shields : "Brave Shields comparison requires the Node scanner."}
                aria-label="Blocker comparison (Brave Shields)"
                onClick={() =>
                  setForm((current) => ({ ...current, compareGpc: false, compareShields: shieldsComparisonEnabled, compareConsent: false }))
                }
              >
                <Shield size={16} aria-hidden="true" />
                {RUN_MODE_LABELS.shields}
              </button>
              <button
                type="button"
                aria-pressed={form.compareConsent}
                className={form.compareConsent ? "active" : ""}
                disabled={!consentComparisonEnabled}
                title={consentComparisonEnabled ? RUN_MODE_TITLES.consent : "Consent comparison requires the Node scanner."}
                aria-label="Consent comparison (accept all versus reject all)"
                onClick={() =>
                  setForm((current) => ({ ...current, compareGpc: false, compareShields: false, compareConsent: consentComparisonEnabled }))
                }
              >
                <Cookie size={16} aria-hidden="true" />
                {RUN_MODE_LABELS.consent}
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
              <label
                className="switch-row"
                title='Global Privacy Control: a "do not sell or share my data" signal sent with every request.'
              >
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
        <p className="run-mode-hint">{runModeHint(selectedRunMode(form))}</p>
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

        {corpusHighlights && corpusHighlights.siteCount > 0 && !loaded && !loading && !error && (
          <CorpusHero highlights={corpusHighlights} />
        )}

        <section className="scan-workbench">
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
          {!loaded && !loading && !error && (
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
            />
          )}
          {loaded && reportView && primaryRun && displayedRun && (
            <section className="report-grid">
              <div className="report-main">
                <ReportHeader
                  share={loaded.wire.share ?? null}
                  view={reportView}
                  run={primaryRun}
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
                <Warnings warnings={reportView.warnings} />
                <DomainTable domains={displayedRun.evidence.domains} />
                <RequestTable requests={displayedRun.evidence.requests} />
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
                  <CookieList cookies={displayedRun.evidence.cookies} />
                </section>

                <section className="side-card">
                  <h2>Storage</h2>
                  <StorageList storage={displayedRun.evidence.storage} />
                </section>

                <section className="side-card">
                  <h2>Browser Behavior Signals</h2>
                  <FingerprintList
                    events={displayedRun.evidence.fingerprintEvents}
                    detections={displayedRun.evidence.fingerprintDetections}
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
                      <dd>{displayedRun.conditions.gpcEnabled ? "sent" : "not sent"}</dd>
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
                          {/* Dispatch vs verification stay distinct: the click
                              is a fact, the choice state is what an
                              interpreter could verify (v2 only). */}
                          {displayedRun.consent.choiceState ? ` · choice ${displayedRun.consent.choiceState}` : " · choice unverified"}
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
                          {displayedRun.conditions.trackerCatalog.entries.toLocaleString()} entries
                        </dd>
                      </div>
                    )}
                    {displayedRun.conditions.adblockLists && (
                      <div>
                        <dt>Brave Shields lists</dt>
                        <dd>
                          {displayedRun.conditions.adblockLists.source}
                          <br />
                          {displayedRun.conditions.adblockLists.lists.toLocaleString()} lists · fetched{" "}
                          {new Date(displayedRun.conditions.adblockLists.fetchedAt).toLocaleDateString()}
                        </dd>
                      </div>
                    )}
                  </dl>
                  {displayedRun.conditions.disclosure && <p>{displayedRun.conditions.disclosure}</p>}
                </section>
              </aside>
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
            <a className="footer-link" href={staticAssetPath("/privacy/")}>
              Privacy
            </a>
          </span>
          <span>One automated visit per condition (comparisons pair two). Reproducible for this configuration, not a universal claim.</span>
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
        We open {plural(highlights.siteCount, "real site")} in a controlled browser and record the requests, cookies, and
        trackers each visit observes (unusually heavy visits hit a recording cap and are flagged), then run each through <strong>Brave&rsquo;s own ad-block engine</strong> (the open-source{" "}
        <code>adblock-rust</code>, with Brave&rsquo;s default lists) to show which requests match the filter lists of
        Brave Shields, the ad and tracker blocker built into the Brave browser. Reproducible evidence, not a score.
      </p>
      {highlights.topCategories.length > 0 && (
        <div className="corpus-hero-cats">
          {highlights.topCategories.map((category) => (
            <div className="corpus-hero-cat" key={category.label}>
              <span className="corpus-hero-cat-num">{category.medianTrackers.toLocaleString()}</span>
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
  const comparisons = [
    health.capabilities?.gpcComparison ? "GPC" : null,
    health.capabilities?.shieldsComparison ? "Brave Shields" : null,
    health.capabilities?.consentComparison ? "Consent" : null
  ].filter((label): label is string => label !== null);
  const comparison =
    comparisons.length > 1
      ? ` ${comparisons.slice(0, -1).join(", ")} and ${comparisons[comparisons.length - 1]} comparisons are available.`
      : comparisons.length === 1
        ? ` ${comparisons[0]} comparison is available.`
        : "";
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
  if (
    lower.includes("could not be loaded") ||
    lower.includes("could not be resolved") ||
    lower.includes("blocking automated") ||
    lower.includes("unreachable")
  ) {
    return "The scanner couldn't load that page. The site may be down, unreachable, or actively blocking automated visits. Try again, or try a different page.";
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
  // Only genuine address-validation messages map to the "valid web address"
  // hint. The generic "Scan failed. Check the target URL" fallback also mentions
  // "url", so matching on "url"/"http" alone mislabels real load failures as bad
  // input, exactly the bug behind banks like fidelity.com appearing invalid.
  if (
    lower.includes("valid public url") ||
    lower.includes("enter a public url") ||
    lower.includes("only http and https") ||
    lower.includes("credentials in url") ||
    lower.includes("invalid url")
  ) {
    return "That doesn't look like a valid web address. Use a full URL such as https://example.com.";
  }
  return message;
}

async function pollScanJob(statusPath: string, accessKey = "", reportId?: string): Promise<LoadedReport> {
  // The saved report lives under its own ID (distinct from the job ID) so share
  // links can't derive the screenshot-bearing status URL. Older scanners saved
  // under the job ID itself and their submissions carry no reportId, so fall
  // back to the ID parsed from the status path for recovery against them.
  const savedReportId =
    reportId && REPORT_ID_PATTERN.test(reportId) ? reportId : scanJobIdFromStatusPath(statusPath);

  for (let attempt = 0; attempt < SCAN_JOB_MAX_POLLS; attempt += 1) {
    const headers: Record<string, string> = {};
    if (accessKey) {
      headers.Authorization = `Bearer ${accessKey}`;
    }

    const response = await fetch(scannerApiUrl(statusPath), { cache: "no-store", headers });
    const payload = (await response.json()) as ScanJobApiResponse;
    if (!payload.ok) {
      if (response.status === 404 && savedReportId) {
        const recovered = await readSavedReport(savedReportId);
        if (recovered) return recovered;
      }
      throw new Error(payload.error);
    }

    if (payload.status === "succeeded") {
      if (payload.report) {
        const read = await readLoadedReport(payload.report, "The completed scan's report");
        if (read.ok) return read.loaded;
        throw new Error(read.message);
      }
      throw new Error("Completed scan did not include a report.");
    }

    if (payload.status === "failed" || payload.status === "expired" || payload.status === "cancelled") {
      throw new Error(payload.error || "Scan job did not complete.");
    }

    await sleep(SCAN_JOB_POLL_INTERVAL_MS);
  }

  if (savedReportId) {
    const recovered = await readSavedReport(savedReportId);
    if (recovered) return recovered;
  }

  throw new Error("Scan is still running. Try opening the saved report again shortly.");
}

/**
 * Recovery read of a saved report. The 404-versus-everything-else semantics
 * live in lib/saved-report-recovery.ts (unit-tested there): `null` only for a
 * genuine 404, a thrown named reason for unreadable or unservable reports.
 */
async function readSavedReport(reportId: string): Promise<LoadedReport | null> {
  return recoverSavedReport(await fetch(scannerApiUrl(`/api/reports/${reportId}`), { cache: "no-store" }));
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
  const match = pathname.match(/^\/api\/scans\/([^/]+)$/);
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



function normalizeScanUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  // Accept bare domains (e.g. "fidelity.com") by assuming https://. If the user
  // already typed any scheme, keep it and let the scanner validate it.
  const withScheme = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
  // Drop the query string and fragment before the URL ever leaves the browser.
  // Those carry the most PII (tracking ids, tokens, emails); the scan reports a
  // page by origin + path anyway. The path is kept so specific pages still scan.
  try {
    const parsed = new URL(withScheme);
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return withScheme;
  }
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

/** Display label for one arm of a comparison view ("Shields off"). */
function armDisplayLabel(view: ReportView | null, arm: "baseline" | "variant"): string {
  return view?.comparison?.runLabels[arm] ?? arm;
}

/**
 * Wrap a locally built v1 wire report (a PageGraph import, the gallery's
 * client-side temporal comparison) as a LoadedReport, using the LIGHT view
 * builder so these paths never pull the deep validators into the bundle.
 */
function loadedFromV1Wire(report: ScanReport): LoadedReport {
  return { source: "v1", wire: report, view: viewFromV1Report(report) };
}

// A locally opened file has no servable permalink on this origin, so drop any
// stored share pointer from the retained wire (every generation carries the
// optional share block in the same place); the view carries no share at all.
function stripShareFromLoaded(loaded: LoadedReport): LoadedReport {
  if (loaded.source === "v1") {
    const wire = { ...loaded.wire, share: undefined };
    return { ...loaded, wire, view: viewFromV1Report(wire) };
  }
  if (loaded.source === "v2-public") {
    return { ...loaded, wire: { ...loaded.wire, share: undefined } };
  }
  if (loaded.source === "v2-r2-public") {
    return { ...loaded, wire: { ...loaded.wire, share: undefined } };
  }
  if (loaded.source === "v2-ephemeral") {
    return { ...loaded, wire: { ...loaded.wire, share: undefined }, public: { ...loaded.public, share: undefined } };
  }
  return { ...loaded, wire: { ...loaded.wire, share: undefined }, public: { ...loaded.public, share: undefined } };
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
  onUploadPageGraph: (file: File | null) => Promise<void>;
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
            Have a Brave <strong>PageGraph</strong> export? Open the <code>.graphml</code> to view it as a report: requests,
            storage, fingerprinting, and script-to-request causality, all rendered here.
          </span>
        </div>
        <PageGraphUploadButton onUploadReport={onUploadPageGraph} onError={onUploadError}>
          Open PageGraph .graphml
        </PageGraphUploadButton>
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

function LoadingState({ mode }: { mode: "single" | "gpc" | "shields" | "consent" | "opening" }) {
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
    <section className="loading-state" role="status">
      <span className="pulse-dot" />
      <h2>{isComparison ? "Running two controlled browser visits" : "Running controlled browser visit"}</h2>
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
        Keystroke capture is tested by typing a synthetic value into the page&rsquo;s form fields (never submitting) and
        watching for it to be sent off-site. It covers fields on the loaded page, not flows behind login or extra steps.
      </p>
    </section>
  );
}

function ReportHeader({
  share,
  view,
  run,
  csvArmLabel,
  onDownload,
  onDownloadCsv,
  liveApiServesReportPages
}: {
  /** The wire report's share pointer, needed only to resolve the permalink. */
  share: ReportShare | null;
  view: ReportView;
  run: RunView;
  /** Names the visit the CSV exports on comparisons; null on single reports. */
  csvArmLabel: string | null;
  onDownload: () => void;
  onDownloadCsv: () => void;
  liveApiServesReportPages: boolean;
}) {
  const sharePath = reportSharePath(share, liveApiServesReportPages);
  // The anchor keeps the origin-relative path (it navigates fine and stays
  // valid during static prerender), but the clipboard needs a complete URL, so
  // resolve it to absolute on the client once mounted.
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  useEffect(() => {
    setShareUrl(sharePath ? absoluteShareUrl(sharePath) : null);
  }, [sharePath]);
  // v2 subject URLs are privacy-generalized route shapes; they parse as URLs
  // but point nowhere real, so they render as text, never as a link.
  const finalUrl = run.conditions.urlsAreRouteShapes ? null : safeNavigableHttpUrl(run.conditions.finalUrl);
  const title = view.title || run.pageTitle;

  const [shareCopied, setShareCopied] = useState(false);
  async function handleShare(event: MouseEvent<HTMLAnchorElement>) {
    const url = shareUrl ?? sharePath;
    if (!url) return;
    // Prefer the platform's native share sheet where it exists (mobile, Safari).
    if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
      event.preventDefault();
      try {
        await navigator.share({ title: title || run.domain, url });
      } catch {
        /* the user dismissed the share sheet */
      }
      return;
    }
    // No native share: when the permalink is the page already open, navigating
    // does nothing, so copy the link instead, the button must always act.
    if (typeof window !== "undefined" && url === window.location.href) {
      event.preventDefault();
      try {
        await navigator.clipboard.writeText(url);
        setShareCopied(true);
        window.setTimeout(() => setShareCopied(false), 1500);
      } catch {
        /* clipboard unavailable */
      }
    }
  }
  return (
    <section className="report-header">
      <div>
        <p className="eyebrow">
          {view.reportType === "comparison" ? "Comparison Report" : "Scan Report"}
          {/* Provenance is always visible, not buried in the sidebar: a
              legacy-derived or limited report says so where the title is. */}
          <span className="report-provenance">{schemaProvenanceLabel(view)}</span>
          {familyCensoredOnRun(run, "requests") && (
            <span
              className="capped-chip"
              title="This visit hit the request-recording cap: its activity counts are floors cut off mid-collection, and cookie and storage figures are end-state snapshots of an interrupted visit."
            >
              recording capped
            </span>
          )}
        </p>
        <h2>{title || run.domain}</h2>
        {finalUrl ? (
          <a href={finalUrl} target="_blank" rel="noreferrer">
            {run.conditions.finalUrl}
            <ExternalLink size={14} aria-hidden="true" />
          </a>
        ) : (
          <span className="report-url">{run.conditions.finalUrl}</span>
        )}
      </div>
      <div className="report-actions">
        {sharePath && (
          <>
            <a className="secondary-button" href={sharePath} onClick={handleShare}>
              <ExternalLink size={17} aria-hidden="true" />
              {shareCopied ? "Link copied" : "Share"}
            </a>
            <CopyButton value={shareUrl ?? sharePath} label="share link" />
          </>
        )}
        <button
          className="secondary-button"
          type="button"
          onClick={onDownloadCsv}
          title={
            csvArmLabel
              ? `Download the "${csvArmLabel}" visit's request log as CSV (follows the evidence switcher below)`
              : "Download the request log as CSV"
          }
        >
          <Download size={17} aria-hidden="true" />
          {csvArmLabel ? `CSV · ${csvArmLabel}` : "CSV"}
        </button>
        <button className="secondary-button" type="button" onClick={onDownload}>
          <Download size={17} aria-hidden="true" />
          JSON
        </button>
      </div>
    </section>
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
