"use client";

import { useCallback, useEffect, useState } from "react";
import {
  LIVE_SCAN_API_BASE,
  LIVE_SCAN_TURNSTILE_SITE_KEY,
  STATIC_BASE_PATH,
  STATIC_EXPORT
} from "@/app/client-runtime";
import styles from "@/app/v3/v3.module.css";
import {
  buildV3ScanBody,
  buildV3ScanHeaders,
  parseV3ScannerHealth,
  resolveV3ApiUrl,
  resolveV3DynamicPageUrl,
  type V3ScannerHealthSummary
} from "@/lib/v3/client-urls";
import type { ComparisonAxisV3, ScanDeviceV3, ScanRegionIdV3, ScanReportV3 } from "@/lib/v3/schema";
import { ReportViewV3 } from "./ReportViewV3";
import { TurnstileCheckV3 } from "./TurnstileCheckV3";

const V3_LOCATION = {
  staticExport: STATIC_EXPORT,
  scanApiBase: LIVE_SCAN_API_BASE,
  basePath: STATIC_BASE_PATH
};

/**
 * Lazy-loaded Direction A multi-arm live scan workbench embedded on the homepage.
 * Runs isolated concurrent Chromium arms (Brave Shields Standard/Aggressive, GPC,
 * Consent Reject-All) with Developer Mode, causality tree, sGTM/beacon decoding,
 * CNAME uncloaking, and 2-layer CMP dark-pattern scoring.
 */
export function DeepScanWorkbenchV3({
  initialUrl = "",
  onClose
}: {
  initialUrl?: string;
  onClose?: () => void;
}) {
  const [scanUrl, setScanUrl] = useState(initialUrl);
  const [device, setDevice] = useState<ScanDeviceV3>("desktop");
  const [region, setRegion] = useState<ScanRegionIdV3>("auto");
  const [comparisons, setComparisons] = useState<ComparisonAxisV3[]>(["shields-standard", "gpc"]);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [liveResult, setLiveResult] = useState<{ report: ScanReportV3; sharePath: string } | null>(null);

  const [health, setHealth] = useState<V3ScannerHealthSummary | null>(null);
  const [turnstileToken, setTurnstileToken] = useState("");
  const [turnstileError, setTurnstileError] = useState<string | null>(null);
  const [turnstileResetNonce, setTurnstileResetNonce] = useState(0);
  const [accessToken, setAccessToken] = useState("");

  const turnstileRequired = health?.turnstileRequired === true;
  const turnstileSiteKeyConfigured = Boolean(LIVE_SCAN_TURNSTILE_SITE_KEY);
  const awaitingTurnstile = turnstileRequired && turnstileSiteKeyConfigured && !turnstileToken;
  const turnstileUnavailable = turnstileRequired && !turnstileSiteKeyConfigured;
  const maxComparisons = health?.authenticated ? 4 : 2;

  const loadHealth = useCallback(async (signal?: AbortSignal) => {
    try {
      const resp = await fetch(resolveV3ApiUrl("/api/health", LIVE_SCAN_API_BASE), { signal });
      if (resp.ok) {
        setHealth(parseV3ScannerHealth((await resp.json()) as unknown));
      }
    } catch {}
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadHealth(controller.signal);
    return () => controller.abort();
  }, [loadHealth]);

  function toggleComparison(axis: ComparisonAxisV3) {
    setComparisons((prev) => {
      if (prev.includes(axis)) return prev.filter((a) => a !== axis);
      if (prev.length >= maxComparisons) return prev;
      return [...prev, axis];
    });
  }

  async function handleRunScan(e: React.FormEvent) {
    e.preventDefault();
    if (!scanUrl.trim() || awaitingTurnstile || turnstileUnavailable) return;
    setScanning(true);
    setScanError(null);
    const activeTurnstileToken = turnstileRequired ? turnstileToken : "";
    try {
      const resp = await fetch(resolveV3ApiUrl("/api/v3/scan", LIVE_SCAN_API_BASE), {
        method: "POST",
        headers: buildV3ScanHeaders({
          turnstileToken: activeTurnstileToken,
          accessToken: health?.authenticated ? accessToken : undefined
        }),
        body: JSON.stringify(
          buildV3ScanBody({
            url: scanUrl.trim(),
            device,
            region,
            comparisons: comparisons.slice(0, maxComparisons),
            turnstileToken: activeTurnstileToken
          })
        )
      });
      const data = (await resp.json()) as {
        ok?: boolean;
        error?: string;
        report?: ScanReportV3;
        sharePath?: string;
      };
      if (!resp.ok || !data.ok || !data.report) {
        setScanError(data.error ?? `Scan failed (HTTP ${resp.status})`);
        return;
      }
      setLiveResult({ report: data.report, sharePath: data.sharePath ?? `/v3/reports/${data.report.reportId}` });
    } catch (err) {
      setScanError(err instanceof Error ? err.message : "Network error submitting multi-arm scan.");
    } finally {
      setScanning(false);
      if (turnstileRequired) {
        setTurnstileToken("");
        setTurnstileResetNonce((n) => n + 1);
      }
    }
  }

  return (
    <section className={styles.section} id="multi-arm-scan" aria-labelledby="multi-arm-scan-title">
      <div className={styles.heroHeader}>
        <div>
          <p className={styles.eyebrow}>Concurrent multi-arm scan &amp; Developer Mode</p>
          <h2 id="multi-arm-scan-title" className={styles.sectionTitle}>
            Run simultaneous browser arms with deep signal decoding
          </h2>
          <p className={styles.subtitle}>
            Launches isolated Chromium arms in parallel to attribute Brave Shields filter rules, uncloak CNAME chains,
            decode 18 beacon and server-side tagging protocols, audit Shadow DOM keystroke leaks, and score 2-layer
            consent dark patterns.
          </p>
        </div>
        {onClose && (
          <button type="button" className={styles.btn} onClick={onClose}>
            Close panel
          </button>
        )}
      </div>

      <form onSubmit={handleRunScan}>
        <div className={styles.formGrid}>
          <label className={styles.fieldLabel} style={{ gridColumn: "span 2" }}>
            Website URL
            <input
              className={styles.input}
              type="url"
              required
              placeholder="https://example.com"
              value={scanUrl}
              onChange={(e) => setScanUrl(e.target.value)}
            />
          </label>
          <label className={styles.fieldLabel}>
            Locale &amp; timezone profile
            <select
              className={styles.select}
              value={region}
              onChange={(e) => setRegion(e.target.value as ScanRegionIdV3)}
            >
              <option value="auto">Auto (default scanner egress)</option>
              <option value="us-east">US East profile (en-US)</option>
              <option value="eu-central">EU Frankfurt profile (de-DE)</option>
              <option value="ap-northeast">APAC Tokyo profile (ja-JP)</option>
            </select>
          </label>
          <label className={styles.fieldLabel}>
            Device
            <select
              className={styles.select}
              value={device}
              onChange={(e) => setDevice(e.target.value as ScanDeviceV3)}
            >
              <option value="desktop">Desktop</option>
              <option value="mobile">Mobile</option>
            </select>
          </label>
          <button
            type="submit"
            className={`${styles.btn} ${styles.btnPrimary}`}
            disabled={scanning || awaitingTurnstile || turnstileUnavailable || health?.scansAvailable === false}
          >
            {scanning ? "Scanning concurrently…" : awaitingTurnstile ? "Complete check below…" : "Run multi-arm scan"}
          </button>
        </div>

        <div className={styles.checkboxRow}>
          <span>Intervention arms (up to {maxComparisons}):</span>
          {(
            [
              ["shields-standard", "Brave Shields (Standard)"],
              ["shields-aggressive", "Brave Shields (Aggressive)"],
              ["gpc", "Global Privacy Control (GPC)"],
              ["consent-reject", "Consent: Reject All"]
            ] as [ComparisonAxisV3, string][]
          ).map(([axis, label]) => {
            const checked = comparisons.includes(axis);
            const disabled = !checked && comparisons.length >= maxComparisons;
            return (
              <label key={axis} className={styles.checkboxLabel} style={disabled ? { opacity: 0.6 } : undefined}>
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={disabled}
                  onChange={() => toggleComparison(axis)}
                />
                {label}
              </label>
            );
          })}
        </div>

        {health?.authenticated && (
          <div style={{ marginTop: 12, maxWidth: 360 }}>
            <label className={styles.fieldLabel}>
              Scanner access token
              <input
                className={styles.input}
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder="Enter access key"
                value={accessToken}
                onChange={(e) => setAccessToken(e.target.value)}
              />
            </label>
          </div>
        )}

        {turnstileRequired && turnstileSiteKeyConfigured && (
          <TurnstileCheckV3
            siteKey={LIVE_SCAN_TURNSTILE_SITE_KEY}
            resetNonce={turnstileResetNonce}
            onToken={setTurnstileToken}
            onError={setTurnstileError}
          />
        )}

        {awaitingTurnstile && !turnstileError && (
          <p className={styles.subtitle} role="status">
            Complete the Cloudflare browser check above to enable multi-arm scanning.
          </p>
        )}

        {turnstileError && (
          <div className={`${styles.highlightItem} ${styles.hlHigh}`} role="alert" style={{ marginTop: 12 }}>
            {turnstileError}
          </div>
        )}

        {turnstileUnavailable && (
          <div className={`${styles.highlightItem} ${styles.hlHigh}`} role="alert" style={{ marginTop: 12 }}>
            Live public scanning requires a Turnstile site key in this build.
          </div>
        )}
      </form>

      {scanError && (
        <div className={`${styles.highlightItem} ${styles.hlCritical}`} role="alert" style={{ marginTop: 12 }}>
          {scanError}
        </div>
      )}

      {liveResult && (
        <div className={styles.calloutBand}>
          <div className={styles.heroHeader}>
            <p className={styles.eyebrow}>
              Multi-arm scan complete — report <span className={styles.mono}>{liveResult.report.reportId}</span>
            </p>
            <a
              href={resolveV3DynamicPageUrl(liveResult.sharePath, V3_LOCATION)}
              className={`${styles.btn} ${styles.btnPrimary}`}
            >
              Open permalink
            </a>
          </div>
          <ReportViewV3 key={liveResult.report.reportId} embedded report={liveResult.report} />
        </div>
      )}
    </section>
  );
}
