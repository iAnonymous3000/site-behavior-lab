"use client";

import {
  ChevronDown,
  Cookie,
  Globe2,
  Loader2,
  Monitor,
  Search,
  Shield,
  ShieldCheck,
  SlidersHorizontal,
  Smartphone
} from "lucide-react";
import type { Dispatch, FormEventHandler, SetStateAction } from "react";
import { useEffect, useRef } from "react";
import {
  LIVE_SCAN_TURNSTILE_SITE_KEY,
  STATIC_LIVE_SCAN_ENABLED,
  clientReportRuntime,
  staticAssetPath
} from "../client-runtime";
import type { HomepageKnownSite } from "@/lib/homepage-discovery";
import { committedReportLocation } from "@/lib/report-locator";
import { RUN_MODE_LABELS, RUN_MODE_TITLES, runModeHint, type RunMode } from "@/lib/run-mode-copy";
import type { ScanDevice } from "@/lib/types";

export type ScanFormState = {
  url: string;
  device: ScanDevice;
  gpcEnabled: boolean;
  compareGpc: boolean;
  compareShields: boolean;
  compareConsent: boolean;
  accessKey: string;
};

type ScanControlsProps = {
  form: ScanFormState;
  setForm: Dispatch<SetStateAction<ScanFormState>>;
  onSubmit: FormEventHandler<HTMLFormElement>;
  loading: boolean;
  scanBlocked: boolean;
  activeScanJob: boolean;
  urlNotice: string;
  urlError: string;
  clearUrlNotice: () => void;
  scannerStatus: string;
  scannerStatusError: boolean;
  onRetryScannerHealth: () => void;
  turnstileRequired: boolean;
  turnstileResetNonce: number;
  onTurnstileToken: (token: string) => void;
  onError: (message: string) => void;
  turnstileUnsupported: boolean;
  awaitingTurnstile: boolean;
  gpcComparisonEnabled: boolean;
  shieldsComparisonEnabled: boolean;
  consentComparisonEnabled: boolean;
  scannerRequiresAccessKey: boolean;
  onAccessKeyChange: (accessKey: string) => void;
  examples: { url: string; hint: string }[];
  onPickExample: (url: string) => void;
  knownSites: HomepageKnownSite[];
};

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

function isComparisonMode(form: ScanFormState): boolean {
  return form.compareGpc || form.compareShields || form.compareConsent;
}

// One plain-language line under the run controls. "Brave Shields" and "GPC"
// are jargon to a first-time visitor, so the selected mode always explains
// itself; lib/run-mode-copy.ts owns and tests the copy.
function selectedRunMode(form: ScanFormState): RunMode {
  return form.compareShields ? "shields" : form.compareGpc ? "gpc" : form.compareConsent ? "consent" : "single";
}

function hostnameFromInput(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return null;
  }
}

function matchingKnownSite(value: string, knownSites: HomepageKnownSite[]): HomepageKnownSite | null {
  const hostname = hostnameFromInput(value);
  if (!hostname) return null;
  return knownSites.find((site) => hostname === site.domain || hostname.endsWith(`.${site.domain}`)) ?? null;
}

export function ScanControls({
  form,
  setForm,
  onSubmit,
  loading,
  scanBlocked,
  activeScanJob,
  urlNotice,
  urlError,
  clearUrlNotice,
  scannerStatus,
  scannerStatusError,
  onRetryScannerHealth,
  turnstileRequired,
  turnstileResetNonce,
  onTurnstileToken,
  onError,
  turnstileUnsupported,
  awaitingTurnstile,
  gpcComparisonEnabled,
  shieldsComparisonEnabled,
  consentComparisonEnabled,
  scannerRequiresAccessKey,
  onAccessKeyChange,
  examples,
  onPickExample,
  knownSites
}: ScanControlsProps) {
  const turnstileSiteKeyConfigured = Boolean(LIVE_SCAN_TURNSTILE_SITE_KEY);
  const knownSite = matchingKnownSite(form.url, knownSites);

  return (
    <form className="scan-panel" onSubmit={onSubmit}>
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
          aria-invalid={urlError ? true : undefined}
          aria-describedby={urlError ? "url-error" : urlNotice ? "url-notice" : undefined}
          value={form.url}
          onChange={(event) => {
            clearUrlNotice();
            setForm((current) => ({ ...current, url: event.target.value }));
          }}
          placeholder="https://example.com"
        />
        <button
          className={`primary-button${loading ? " is-loading" : ""}`}
          type="submit"
          disabled={loading || scanBlocked || activeScanJob}
        >
          {loading ? <Loader2 className="spin" size={18} aria-hidden="true" /> : <Search size={18} aria-hidden="true" />}
          {isComparisonMode(form) ? "Compare" : "Scan"}
        </button>
      </div>

      {urlNotice && <p className="scanner-status-note url-privacy-note" id="url-notice">{urlNotice}</p>}
      {urlError && <p className="scanner-status-note scanner-status-note-error" id="url-error">{urlError}</p>}

      {knownSite ? (
        <div className="known-evidence" role="status">
          <span>
            Evidence already exists for <strong>{knownSite.domain}</strong> from {formatKnownEvidenceDate(knownSite.scannedAt)}.
          </span>
          <span className="known-evidence-actions">
            <a href={committedReportLocation(knownSite.latestReportId, clientReportRuntime()).pagePath}>
              Open latest evidence
            </a>
            <a href={staticAssetPath(`/sites/${encodeURIComponent(knownSite.domain)}/`)}>View history</a>
          </span>
        </div>
      ) : (
        <div className="scan-examples" aria-label="Example sites">
          <span>Try</span>
          {examples.map((example) => (
            <button key={example.url} type="button" onClick={() => onPickExample(example.url)}>
              {example.url}
              <small>{example.hint}</small>
            </button>
          ))}
        </div>
      )}

      <div className="scanner-health-row">
        <p
          className={`scanner-status-note${scannerStatusError ? " scanner-status-note-error" : ""}`}
          role="status"
          aria-live="polite"
        >
          {scannerStatus}
        </p>
        {scannerStatusError && (
          <button className="ghost-button scanner-health-retry" type="button" onClick={onRetryScannerHealth}>
            Retry status
          </button>
        )}
      </div>

      {turnstileRequired && turnstileSiteKeyConfigured && (
        <div className="turnstile-row">
          <TurnstileWidget
            siteKey={LIVE_SCAN_TURNSTILE_SITE_KEY}
            resetNonce={turnstileResetNonce}
            onToken={onTurnstileToken}
            onError={onError}
          />
        </div>
      )}

      {turnstileUnsupported && (
        <p className="scanner-status-note scanner-status-note-error">
          This scanner requires Turnstile verification, but this static build has no Turnstile site key. Set{" "}
          <code>NEXT_PUBLIC_SITE_BEHAVIOR_LAB_TURNSTILE_SITE_KEY</code> at build time to enable scanning.
        </p>
      )}

      {awaitingTurnstile && (
        <p className="scanner-status-note">
          Finishing a quick browser check above. Scan turns on once it passes; reload the page if it does not complete.
        </p>
      )}

      <details className="options-disclosure">
        <summary>
          <SlidersHorizontal size={15} aria-hidden="true" />
          <span>Options</span>
          <ChevronDown className="disclosure-chevron" size={15} aria-hidden="true" />
        </summary>
        <div className="controls-grid">
          <fieldset className="control-group run-mode-group">
            <legend>Run</legend>
            <div className="segmented-control run-mode-control" role="group" aria-label="Run mode">
              <button
                type="button"
                aria-pressed={!isComparisonMode(form)}
                className={!isComparisonMode(form) ? "active" : ""}
                title={RUN_MODE_TITLES.single}
                onClick={() =>
                  setForm((current) => ({
                    ...current,
                    compareGpc: false,
                    compareShields: false,
                    compareConsent: false
                  }))
                }
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
                  setForm((current) => ({
                    ...current,
                    compareGpc: gpcComparisonEnabled,
                    compareShields: false,
                    compareConsent: false
                  }))
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
                  setForm((current) => ({
                    ...current,
                    compareGpc: false,
                    compareShields: shieldsComparisonEnabled,
                    compareConsent: false
                  }))
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
                  setForm((current) => ({
                    ...current,
                    compareGpc: false,
                    compareShields: false,
                    compareConsent: consentComparisonEnabled
                  }))
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
                  onChange={(event) => onAccessKeyChange(event.target.value)}
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
}

function formatKnownEvidenceDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "an earlier scan";
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
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
