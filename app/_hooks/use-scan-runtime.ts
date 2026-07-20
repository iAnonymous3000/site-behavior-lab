"use client";

import type { FormEvent } from "react";
import { useEffect, useRef, useState } from "react";
import type { ScanFormState } from "../_components/scan-controls";
import {
  LIVE_SCAN_ENABLED,
  LIVE_SCAN_TURNSTILE_SITE_KEY,
  OPEN_ACCESS_SCANNER,
  STATIC_EXPORT,
  STATIC_LIVE_SCAN_ENABLED,
  scannerApiUrl
} from "../client-runtime";
import { normalizeScanUrl } from "../scan-form";
import {
  cancelRuntimeScan,
  deriveScanRuntimePolicy,
  fetchRuntimeScannerHealth,
  friendlyScanError,
  isAbortError,
  liveScannerStatusLabel,
  resumeRuntimeScan,
  scannerStatusText,
  shouldLoadSavedScanAccessKey,
  shouldReleaseAcceptedScanJob,
  submitRuntimeScan,
  type ActiveScanJob
} from "@/lib/scan-client-orchestration";
import type { ScanRuntimeHealth } from "@/lib/scan-runtime-health";
import type { LoadedReport } from "@/lib/scan-report-view";

const INITIAL_SCAN_FORM: ScanFormState = {
  url: "",
  device: "desktop",
  gpcEnabled: true,
  compareGpc: false,
  compareShields: false,
  compareConsent: false,
  accessKey: ""
};

type UseScanRuntimeOptions = {
  reportPage: boolean;
  initialLoaded: LoadedReport | null;
  initialError: string | null;
  initialLoading: boolean;
};

/**
 * Own the browser-side scan lifecycle while keeping the report renderer and
 * local upload adapters independent. Accepted job capabilities deliberately
 * live here rather than in a polling helper so transient status failures can
 * be resumed or cancelled without resubmitting paid browser work.
 */
export function useScanRuntime({
  reportPage,
  initialLoaded,
  initialError,
  initialLoading
}: UseScanRuntimeOptions) {
  const [form, setForm] = useState<ScanFormState>(INITIAL_SCAN_FORM);
  const [loaded, setLoaded] = useState<LoadedReport | null>(initialLoaded);
  const [error, setError] = useState<string | null>(initialError);
  const [loading, setLoading] = useState(initialLoading);
  const [scanning, setScanning] = useState(false);
  const [activeScanJob, setActiveScanJob] = useState<ActiveScanJob | null>(null);
  const [cancellingScan, setCancellingScan] = useState(false);
  const [cancelScanError, setCancelScanError] = useState<string | null>(null);
  const scanControllerRef = useRef<AbortController | null>(null);
  const [scannerHealth, setScannerHealth] = useState<ScanRuntimeHealth | null>(null);
  const [scannerHealthError, setScannerHealthError] = useState<string | null>(null);
  const [turnstileToken, setTurnstileToken] = useState("");
  // Bumped after every network scan attempt: Turnstile tokens are single-use.
  const [turnstileResetNonce, setTurnstileResetNonce] = useState(0);
  const [scheduledRescanCreateBusy, setScheduledRescanCreateBusy] = useState(false);
  const [urlNotice, setUrlNotice] = useState("");

  useEffect(() => {
    if (!shouldLoadSavedScanAccessKey({ liveScanEnabled: LIVE_SCAN_ENABLED, reportPage })) return;
    try {
      const savedAccessKey = localStorage.getItem("sbl-access-key");
      if (savedAccessKey) setForm((current) => ({ ...current, accessKey: savedAccessKey }));
    } catch {
      /* localStorage unavailable */
    }
  }, [reportPage]);

  useEffect(() => {
    if (reportPage || typeof window === "undefined") return;
    const requested = new URLSearchParams(window.location.search).get("url");
    if (!requested) return;
    const normalized = normalizeScanUrl(requested);
    if (normalized) setForm((current) => ({ ...current, url: normalized }));
  }, [reportPage]);

  useEffect(() => {
    setLoaded(initialLoaded);
  }, [initialLoaded]);

  useEffect(() => {
    setError(initialError);
  }, [initialError]);

  useEffect(() => {
    setLoading(initialLoading);
  }, [initialLoading]);

  useEffect(() => () => scanControllerRef.current?.abort(), []);

  useEffect(() => {
    if (reportPage || !LIVE_SCAN_ENABLED) return;
    let cancelled = false;

    void fetchRuntimeScannerHealth({ resolveApiUrl: scannerApiUrl }).then((result) => {
      if (cancelled) return;
      setScannerHealth(result.health);
      setScannerHealthError(result.error);
    });

    return () => {
      cancelled = true;
    };
  }, [reportPage]);

  const policy = deriveScanRuntimePolicy({
    liveScanEnabled: LIVE_SCAN_ENABLED,
    staticExport: STATIC_EXPORT,
    staticLiveScanEnabled: STATIC_LIVE_SCAN_ENABLED,
    openAccessBuild: OPEN_ACCESS_SCANNER,
    reportPage,
    turnstileSiteKeyConfigured: Boolean(LIVE_SCAN_TURNSTILE_SITE_KEY),
    turnstileToken,
    health: scannerHealth,
    healthError: scannerHealthError
  });

  useEffect(() => {
    setForm((current) => ({
      ...current,
      compareGpc: current.compareGpc && policy.gpcComparisonEnabled,
      compareShields: current.compareShields && policy.shieldsComparisonEnabled,
      compareConsent: current.compareConsent && policy.consentComparisonEnabled
    }));
  }, [policy.consentComparisonEnabled, policy.gpcComparisonEnabled, policy.shieldsComparisonEnabled]);

  async function runScan(targetUrl: string) {
    if (scheduledRescanCreateBusy) {
      setError("Wait for the scheduled rescan request to finish before scanning.");
      return;
    }
    if (activeScanJob) {
      setError("This accepted scan is still available. Resume its status checks or cancel it before starting another scan.");
      return;
    }
    if (!LIVE_SCAN_ENABLED) {
      setLoading(false);
      setLoaded(null);
      setError("This published build cannot run live scans. Use an Actions-generated report, upload JSON, or run the Node app locally.");
      return;
    }
    if (policy.awaitingScannerHealth) {
      setLoading(false);
      setLoaded(null);
      setError("Checking public scanner status. Try again in a moment.");
      return;
    }
    if (policy.scannerUnavailable) {
      setLoading(false);
      setLoaded(null);
      setError(scannerHealthError || "The public scanner is not available right now. Try again shortly.");
      return;
    }
    if (policy.turnstileUnsupported) {
      setLoading(false);
      setLoaded(null);
      setError(
        "This scanner requires Turnstile verification, but this site was not built with a Turnstile site key. Rebuild with NEXT_PUBLIC_SITE_BEHAVIOR_LAB_TURNSTILE_SITE_KEY set to the Worker's site key."
      );
      return;
    }
    if (policy.awaitingTurnstile) {
      setLoading(false);
      setLoaded(null);
      setError("Complete the Turnstile check before scanning.");
      return;
    }

    const controller = new AbortController();
    scanControllerRef.current = controller;
    setLoading(true);
    setScanning(true);
    setError(null);
    setLoaded(null);
    setCancelScanError(null);

    try {
      const nextLoaded = await submitRuntimeScan({
        targetUrl,
        form,
        gpcComparisonEnabled: policy.gpcComparisonEnabled,
        shieldsComparisonEnabled: policy.shieldsComparisonEnabled,
        consentComparisonEnabled: policy.consentComparisonEnabled,
        scannerRequiresAccessKey: policy.scannerRequiresAccessKey,
        turnstileRequired: policy.turnstileRequired,
        turnstileToken,
        signal: controller.signal,
        resolveApiUrl: scannerApiUrl,
        onAccepted: setActiveScanJob
      });
      setLoaded(nextLoaded);
      setActiveScanJob(null);
    } catch (scanError) {
      if (isAbortError(scanError)) return;
      if (shouldReleaseAcceptedScanJob(scanError)) setActiveScanJob(null);
      setError(
        scanError instanceof Error
          ? friendlyScanError(scanError.message, policy.openAccessScanner)
          : "Scan failed."
      );
    } finally {
      if (scanControllerRef.current === controller) scanControllerRef.current = null;
      setCancellingScan(false);
      setLoading(false);
      setScanning(false);
      if (policy.turnstileRequired) {
        setTurnstileToken("");
        setTurnstileResetNonce((nonce) => nonce + 1);
      }
    }
  }

  async function resumeActiveScan() {
    if (!activeScanJob || loading) return;
    const job = activeScanJob;
    const controller = new AbortController();
    scanControllerRef.current = controller;
    setLoading(true);
    setScanning(true);
    setLoaded(null);
    setError(null);
    setCancelScanError(null);

    try {
      setLoaded(
        await resumeRuntimeScan({
          job,
          signal: controller.signal,
          resolveApiUrl: scannerApiUrl
        })
      );
      setActiveScanJob(null);
    } catch (scanError) {
      if (isAbortError(scanError)) return;
      if (shouldReleaseAcceptedScanJob(scanError)) setActiveScanJob(null);
      setError(
        scanError instanceof Error
          ? friendlyScanError(scanError.message, policy.openAccessScanner)
          : "Scan status checks failed."
      );
    } finally {
      if (scanControllerRef.current === controller) scanControllerRef.current = null;
      setCancellingScan(false);
      setLoading(false);
      setScanning(false);
    }
  }

  async function cancelActiveScan() {
    if (!activeScanJob || cancellingScan) return;
    const job = activeScanJob;
    setCancellingScan(true);
    setCancelScanError(null);

    try {
      const message = await cancelRuntimeScan({ job, resolveApiUrl: scannerApiUrl });
      scanControllerRef.current?.abort();
      setActiveScanJob(null);
      setLoading(false);
      setScanning(false);
      setError(message);
    } catch (cancelError) {
      // A failed DELETE never discards the accepted capability; the visitor can
      // retry cancellation or resume polling with the admission-time key.
      setCancelScanError(
        cancelError instanceof Error
          ? friendlyScanError(cancelError.message, policy.openAccessScanner)
          : "The scan could not be cancelled."
      );
    } finally {
      setCancellingScan(false);
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
    if (!normalized) {
      setUrlNotice("");
      setError("Enter a valid public URL, for example https://example.com.");
      return;
    }
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
    // Example chips prefill only; the visitor still chooses scan options and
    // deliberately submits before any paid browser work begins.
    window.requestAnimationFrame(() => document.getElementById("url")?.focus());
  }

  function updateAccessKey(accessKey: string) {
    setForm((current) => ({ ...current, accessKey }));
    try {
      if (accessKey) localStorage.setItem("sbl-access-key", accessKey);
      else localStorage.removeItem("sbl-access-key");
    } catch {
      /* localStorage unavailable */
    }
  }

  function acceptScheduledRescanTarget(targetUrl: string, removedPrivateParts: boolean) {
    setForm((current) => ({ ...current, url: targetUrl }));
    setUrlNotice(
      removedPrivateParts
        ? "Removed the query string and fragment from the URL for privacy before scheduling."
        : ""
    );
  }

  /** A successful or failed create request consumes the same one-shot token as a scan. */
  function resetTurnstileAfterScheduledRescanAttempt() {
    if (!policy.turnstileRequired) return;
    setTurnstileToken("");
    setTurnstileResetNonce((nonce) => nonce + 1);
  }

  return {
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
    clearUrlNotice: () => setUrlNotice(""),
    policy,
    scannerStatus: scannerStatusText(scannerHealth, scannerHealthError),
    statusLabel: liveScannerStatusLabel({
      health: scannerHealth,
      error: scannerHealthError,
      liveScanEnabled: LIVE_SCAN_ENABLED,
      staticExport: STATIC_EXPORT,
      staticLiveScanEnabled: STATIC_LIVE_SCAN_ENABLED
    }),
    handleSubmit,
    useExample,
    updateAccessKey,
    acceptScheduledRescanTarget,
    resetTurnstileAfterScheduledRescanAttempt,
    resumeActiveScan,
    cancelActiveScan
  };
}

export type ScanRuntimeController = ReturnType<typeof useScanRuntime>;
