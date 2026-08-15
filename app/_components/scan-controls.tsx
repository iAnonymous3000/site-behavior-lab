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
import { useEffect, useRef, useState } from "react";
import {
  LIVE_SCAN_TURNSTILE_SITE_KEY,
  STATIC_LIVE_SCAN_ENABLED,
  clientReportRuntime,
  staticAssetPath
} from "../client-runtime";
import {
  createTurnstileScriptLoader,
  type TurnstileScriptDocument
} from "@/lib/turnstile-script-loader";
import { selectTurnstileWidgetSize, type TurnstileWidgetSize } from "@/lib/turnstile-widget-size";
import type { HomepageKnownSite } from "@/lib/homepage-discovery";
import { committedReportLocation } from "@/lib/report-locator";
import { RUN_MODE_LABELS, RUN_MODE_TITLES, runModeHint, type RunMode } from "@/lib/run-mode-copy";
import { displayHost } from "@/lib/text-format";
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
  // The verification widget failing is a problem with this control, not with a
  // scan. Routing it up to the shell let a challenge error tear down the
  // progress UI of a scan that was still running.
  const [turnstileError, setTurnstileError] = useState<string | null>(null);

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
      {urlError && <p className="scanner-status-note scanner-status-note-error" id="url-error" role="alert">{urlError}</p>}

      {knownSite ? (
        <div className="known-evidence" role="status">
          <span>
            Evidence already exists for <strong>{displayHost(knownSite.domain)}</strong> from {formatKnownEvidenceDate(knownSite.scannedAt)}.
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

      {/* The comparison modes are the differentiator, so they stay visible. Burying
          them in the disclosure also hid the reason a mode was unavailable. */}
      <div className="run-mode-row">
        <fieldset className="control-group run-mode-group">
          <legend>Run</legend>
          <div className="segmented-control run-mode-control" role="group" aria-label="Run mode">
            <button
              type="button"
              aria-pressed={!isComparisonMode(form)}
              aria-describedby="run-mode-single-description"
              className={!isComparisonMode(form) ? "active" : ""}
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
              aria-describedby="run-mode-gpc-description"
              className={form.compareGpc ? "active" : ""}
              disabled={!gpcComparisonEnabled}
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
              aria-describedby="run-mode-shields-description"
              className={form.compareShields ? "active" : ""}
              disabled={!shieldsComparisonEnabled}
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
              aria-describedby="run-mode-consent-description"
              className={form.compareConsent ? "active" : ""}
              disabled={!consentComparisonEnabled}
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
          <div className="run-mode-descriptions">
            <p className="visually-hidden" id="run-mode-single-description">{RUN_MODE_TITLES.single}</p>
            <p className={gpcComparisonEnabled ? "visually-hidden" : "run-mode-unavailable"} id="run-mode-gpc-description">
              {gpcComparisonEnabled ? RUN_MODE_TITLES.gpc : "GPC comparison is not available from this scanner."}
            </p>
            <p className={shieldsComparisonEnabled ? "visually-hidden" : "run-mode-unavailable"} id="run-mode-shields-description">
              {shieldsComparisonEnabled ? RUN_MODE_TITLES.shields : "Blocker comparison requires the Node scanner."}
            </p>
            <p className={consentComparisonEnabled ? "visually-hidden" : "run-mode-unavailable"} id="run-mode-consent-description">
              {consentComparisonEnabled ? RUN_MODE_TITLES.consent : "Consent comparison requires the Node scanner."}
            </p>
          </div>
        </fieldset>
        <p className="run-mode-hint" aria-live="polite">{runModeHint(selectedRunMode(form))}</p>
      </div>

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
            onToken={(token) => {
              if (token) setTurnstileError(null);
              onTurnstileToken(token);
            }}
            onError={setTurnstileError}
          />
          {turnstileError && (
            <p className="scanner-status-note scanner-status-note-error" role="alert">
              {turnstileError}
            </p>
          )}
        </div>
      )}

      {turnstileUnsupported && (
        <p className="scanner-status-note scanner-status-note-error" role="alert">
          This scanner requires Turnstile verification, but this static build has no Turnstile site key. Set{" "}
          <code>NEXT_PUBLIC_SITE_BEHAVIOR_LAB_TURNSTILE_SITE_KEY</code> at build time to enable scanning.
        </p>
      )}

      {awaitingTurnstile && (
        <p className="scanner-status-note" role="status">
          Finishing a quick browser check above. Scan turns on once it passes; if the check does not load you can retry it there.
        </p>
      )}

      <details className="options-disclosure">
        <summary>
          <SlidersHorizontal size={15} aria-hidden="true" />
          <span>More options</span>
          <ChevronDown className="disclosure-chevron" size={15} aria-hidden="true" />
        </summary>
        <div className="controls-grid">
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
              <>
                <label className="switch-row">
                  <input
                    aria-describedby="gpc-signal-description"
                    type="checkbox"
                    checked={form.gpcEnabled}
                    onChange={(event) => setForm((current) => ({ ...current, gpcEnabled: event.target.checked }))}
                  />
                  <span>Send GPC</span>
                </label>
                <p className="control-help" id="gpc-signal-description">
                  Global Privacy Control is a legal “do not sell or share my data” signal sent with every request.
                </p>
              </>
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
      </details>
    </form>
  );
}

function formatKnownEvidenceDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "an earlier scan";
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

// One shared loader, retryable after a failure. See lib/turnstile-script-loader.ts
// for why inferring load state from a leftover <script> tag deadlocks a remount.
const loadTurnstileScript = createTurnstileScriptLoader(TURNSTILE_SCRIPT_SRC, () =>
  typeof window === "undefined"
    ? null
    : {
        document: document as unknown as TurnstileScriptDocument,
        loaded: () => Boolean(window.turnstile)
      }
);

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
  // The shared loader drops a dead <script> and re-injects on the next call, but
  // nothing re-invoked it: the widget only remounts when scanner health flips, which
  // a blocked challenge script does not do. This makes that retry reachable in place.
  const [attempt, setAttempt] = useState(0);
  const [loadFailed, setLoadFailed] = useState(false);
  // Cloudflare's flexible widget has a 300px minimum. Measure the space the
  // widget actually receives instead of guessing from the viewport: at 320px,
  // shell and panel padding leave less than that minimum.
  const [widgetSize, setWidgetSize] = useState<TurnstileWidgetSize>("compact");

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const updateSize = (width: number) => setWidgetSize(selectTurnstileWidgetSize(width));
    updateSize(container.getBoundingClientRect().width);

    const observer = new ResizeObserver((entries) => {
      const entry = entries.find((candidate) => candidate.target === container);
      updateSize(entry?.contentRect.width ?? container.getBoundingClientRect().width);
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;

    loadTurnstileScript()
      .then(() => {
        if (cancelled || widgetIdRef.current || !containerRef.current || !window.turnstile) return;
        widgetIdRef.current = window.turnstile.render(containerRef.current, {
          sitekey: siteKey,
          size: widgetSize,
          callback: (token) => onTokenRef.current(token),
          "error-callback": () => {
            onTokenRef.current("");
            if (widgetIdRef.current && window.turnstile) {
              try {
                window.turnstile.reset(widgetIdRef.current);
              } catch {
                /* widget already gone */
              }
            }
            onErrorRef.current("Turnstile verification could not be completed. Try the check again.");
          },
          "expired-callback": () => onTokenRef.current(""),
          "timeout-callback": () => onTokenRef.current("")
        });
      })
      .catch(() => {
        if (cancelled) return;
        setLoadFailed(true);
        onErrorRef.current("Turnstile could not load. Check your connection, then try the check again.");
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
        onTokenRef.current("");
      }
    };
  }, [siteKey, attempt, widgetSize]);

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

  return (
    <>
      <div className="turnstile-widget" ref={containerRef} />
      {loadFailed && (
        <button
          className="ghost-button"
          type="button"
          onClick={() => {
            setLoadFailed(false);
            setAttempt((current) => current + 1);
          }}
        >
          Try the check again
        </button>
      )}
    </>
  );
}
