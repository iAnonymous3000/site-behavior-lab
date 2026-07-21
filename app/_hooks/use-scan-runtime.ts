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
  ACTIVE_SCAN_SESSION_MAX_AGE_MS,
  clearActiveScanSession,
  persistActiveScanSession,
  restoreActiveScanSession,
  type ActiveScanSession
} from "@/lib/active-scan-session";
import {
  cancelRuntimeScan,
  deriveScanRuntimePolicy,
  fetchRuntimeScannerHealth,
  friendlyScanError,
  isAbortError,
  liveScannerStatusLabel,
  resumeRuntimeScan,
  scanJobWithCurrentAccessKey,
  scannerStatusText,
  shouldReleaseAcceptedScanJob,
  submitRuntimeScan,
  type ActiveScanJob
} from "@/lib/scan-client-orchestration";
import type { ScanRuntimeHealth } from "@/lib/scan-runtime-health";
import { acceptedScanJobProgress } from "@/lib/scan-job-progress";
import type { LoadedReport } from "@/lib/scan-report-view";
import type { ScanJobProgress } from "@/lib/types";

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
  const [activeScanExpiresAt, setActiveScanExpiresAt] = useState<number | null>(null);
  const [activeScanProgress, setActiveScanProgress] = useState<ScanJobProgress | null>(null);
  const [cancellingScan, setCancellingScan] = useState(false);
  const [cancelScanError, setCancelScanError] = useState<string | null>(null);
  const scanControllerRef = useRef<AbortController | null>(null);
  const [scannerHealth, setScannerHealth] = useState<ScanRuntimeHealth | null>(null);
  const [scannerHealthError, setScannerHealthError] = useState<string | null>(null);
  const [scannerHealthAttempt, setScannerHealthAttempt] = useState(0);
  const [turnstileToken, setTurnstileToken] = useState("");
  // Bumped after every network scan attempt: Turnstile tokens are single-use.
  const [turnstileResetNonce, setTurnstileResetNonce] = useState(0);
  const [scheduledRescanCreateBusy, setScheduledRescanCreateBusy] = useState(false);
  const [urlNotice, setUrlNotice] = useState("");
  const [urlError, setUrlError] = useState("");

  useEffect(() => {
    if (reportPage) return;
    try {
      // Older builds retained this deployment-wide credential across tabs.
      // Recovery is identifier-only now, so remove any legacy browser copy.
      localStorage.removeItem("sbl-access-key");
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
    if (reportPage || !LIVE_SCAN_ENABLED || typeof window === "undefined") return;
    let recovered: ActiveScanSession | null = null;
    try {
      recovered = restoreActiveScanSession(window.sessionStorage);
    } catch {
      return;
    }
    if (!recovered) return;

    const recoveredJob: ActiveScanJob = { ...recovered.job, accessKey: "" };
    let disposed = false;
    const controller = new AbortController();
    scanControllerRef.current = controller;
    setActiveScanJob(recoveredJob);
    setActiveScanExpiresAt(recovered.expiresAt);
    // A recovered capability was already accepted in the earlier page load.
    setActiveScanProgress(acceptedScanJobProgress());
    setLoading(true);
    setScanning(true);
    setLoaded(null);
    setError(null);
    setCancelScanError(null);

    void resumeRuntimeScan({
      job: recoveredJob,
      signal: controller.signal,
      resolveApiUrl: scannerApiUrl,
      onProgress: (progress) => {
        if (!disposed) setActiveScanProgress(progress);
      }
    })
      .then((nextLoaded) => {
        if (disposed) return;
        setLoaded(nextLoaded);
        releaseActiveScanSession();
      })
      .catch((scanError: unknown) => {
        if (disposed || isAbortError(scanError)) return;
        if (shouldReleaseAcceptedScanJob(scanError)) releaseActiveScanSession();
        setError(
          scanError instanceof Error
            ? friendlyScanError(scanError.message, OPEN_ACCESS_SCANNER)
            : "Scan status checks failed."
        );
      })
      .finally(() => {
        if (disposed) return;
        if (scanControllerRef.current === controller) scanControllerRef.current = null;
        setLoading(false);
        setScanning(false);
      });

    return () => {
      disposed = true;
      controller.abort();
      if (scanControllerRef.current === controller) scanControllerRef.current = null;
    };
  }, [reportPage]);

  useEffect(() => {
    if (!activeScanJob || activeScanExpiresAt === null || typeof window === "undefined") return;
    const expire = () => {
      scanControllerRef.current?.abort();
      releaseActiveScanSession();
      setLoading(false);
      setScanning(false);
      setError("This accepted scan expired before it could be recovered.");
    };
    const remainingMs = activeScanExpiresAt - Date.now();
    if (remainingMs <= 0) {
      expire();
      return;
    }
    const timer = window.setTimeout(expire, remainingMs);
    return () => window.clearTimeout(timer);
  }, [activeScanExpiresAt, activeScanJob]);

  useEffect(() => {
    if (reportPage || !LIVE_SCAN_ENABLED) return;
    let cancelled = false;
    const controller = new AbortController();

    void fetchRuntimeScannerHealth({ resolveApiUrl: scannerApiUrl, signal: controller.signal }).then((result) => {
      if (cancelled) return;
      setScannerHealth(result.health);
      setScannerHealthError(result.error);
    });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [reportPage, scannerHealthAttempt]);

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

  function retainActiveScanSession(job: ActiveScanJob): void {
    const acceptedAt = Date.now();
    let session: ActiveScanSession = {
      job,
      acceptedAt,
      expiresAt: acceptedAt + ACTIVE_SCAN_SESSION_MAX_AGE_MS
    };
    if (typeof window !== "undefined") {
      try {
        session = persistActiveScanSession(window.sessionStorage, job, acceptedAt);
      } catch {
        /* sessionStorage unavailable; retain the accepted job in memory */
      }
    }
    setActiveScanJob(job);
    setActiveScanExpiresAt(session.expiresAt);
    setActiveScanProgress(
      acceptedScanJobProgress(
        (policy.gpcComparisonEnabled && form.compareGpc) ||
          (policy.shieldsComparisonEnabled && form.compareShields) ||
          (policy.consentComparisonEnabled && form.compareConsent)
          ? 2
          : 1
      )
    );
  }

  function releaseActiveScanSession(): void {
    if (typeof window !== "undefined") {
      try {
        clearActiveScanSession(window.sessionStorage);
      } catch {
        /* sessionStorage unavailable */
      }
    }
    setActiveScanJob(null);
    setActiveScanExpiresAt(null);
    setActiveScanProgress(null);
  }

  async function runScan(targetUrl: string) {
    if (cancellingScan) {
      setError("Wait for the cancellation request to finish before starting another scan.");
      return;
    }
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
    // Until onAccepted runs, the POST is only a request for admission.
    setActiveScanProgress(null);

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
        onAccepted: retainActiveScanSession,
        onProgress: setActiveScanProgress
      });
      setLoaded(nextLoaded);
      releaseActiveScanSession();
    } catch (scanError) {
      if (isAbortError(scanError)) return;
      if (shouldReleaseAcceptedScanJob(scanError)) releaseActiveScanSession();
      setError(
        scanError instanceof Error
          ? friendlyScanError(scanError.message, policy.openAccessScanner)
          : "Scan failed."
      );
    } finally {
      if (scanControllerRef.current === controller) scanControllerRef.current = null;
      setLoading(false);
      setScanning(false);
      if (policy.turnstileRequired) {
        setTurnstileToken("");
        setTurnstileResetNonce((nonce) => nonce + 1);
      }
    }
  }

  async function resumeActiveScan() {
    if (!activeScanJob || loading || cancellingScan) return;
    const job = scanJobWithCurrentAccessKey(activeScanJob, form.accessKey);
    const controller = new AbortController();
    scanControllerRef.current = controller;
    setLoading(true);
    setScanning(true);
    setLoaded(null);
    setError(null);
    setCancelScanError(null);
    setActiveScanProgress((current) => current ?? acceptedScanJobProgress());

    try {
      setLoaded(
        await resumeRuntimeScan({
          job,
          signal: controller.signal,
          resolveApiUrl: scannerApiUrl,
          onProgress: setActiveScanProgress
        })
      );
      releaseActiveScanSession();
    } catch (scanError) {
      if (isAbortError(scanError)) return;
      if (shouldReleaseAcceptedScanJob(scanError)) releaseActiveScanSession();
      setError(
        scanError instanceof Error
          ? friendlyScanError(scanError.message, policy.openAccessScanner)
          : "Scan status checks failed."
      );
    } finally {
      if (scanControllerRef.current === controller) scanControllerRef.current = null;
      setLoading(false);
      setScanning(false);
    }
  }

  async function cancelActiveScan() {
    if (!activeScanJob || cancellingScan) return;
    const job = scanJobWithCurrentAccessKey(activeScanJob, form.accessKey);
    scanControllerRef.current?.abort();
    const controller = new AbortController();
    scanControllerRef.current = controller;
    setCancellingScan(true);
    setLoading(false);
    setScanning(false);
    setCancelScanError(null);

    try {
      const message = await cancelRuntimeScan({ job, resolveApiUrl: scannerApiUrl, signal: controller.signal });
      releaseActiveScanSession();
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
      if (scanControllerRef.current === controller) scanControllerRef.current = null;
      setCancellingScan(false);
    }
  }

  function dismissActiveScan(): void {
    scanControllerRef.current?.abort();
    scanControllerRef.current = null;
    releaseActiveScanSession();
    setLoading(false);
    setScanning(false);
    setCancellingScan(false);
    setCancelScanError(null);
    setError(null);
  }

  function retryScannerHealth() {
    setScannerHealth(null);
    setScannerHealthError(null);
    setScannerHealthAttempt((attempt) => attempt + 1);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = form.url.trim();
    if (!trimmed) {
      const message = "Enter a public URL to scan, for example https://example.com.";
      setUrlError(message);
      setError(message);
      window.requestAnimationFrame(() => document.getElementById("url")?.focus());
      return;
    }
    const normalized = normalizeScanUrl(trimmed);
    if (!normalized) {
      setUrlNotice("");
      const message = "Enter a valid public URL, for example https://example.com.";
      setUrlError(message);
      setError(message);
      window.requestAnimationFrame(() => document.getElementById("url")?.focus());
      return;
    }
    setUrlError("");
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
    setUrlError("");
    // Example chips prefill only; the visitor still chooses scan options and
    // deliberately submits before any paid browser work begins.
    window.requestAnimationFrame(() => document.getElementById("url")?.focus());
  }

  function updateAccessKey(accessKey: string) {
    setForm((current) => ({ ...current, accessKey }));
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
    clearUrlNotice: () => {
      setUrlNotice("");
      setUrlError("");
    },
    policy,
    scannerStatus: scannerStatusText(scannerHealth, scannerHealthError),
    statusLabel: liveScannerStatusLabel({
      health: scannerHealth,
      error: scannerHealthError,
      liveScanEnabled: LIVE_SCAN_ENABLED,
      staticExport: STATIC_EXPORT
    }),
    retryScannerHealth,
    handleSubmit,
    useExample,
    updateAccessKey,
    acceptScheduledRescanTarget,
    resetTurnstileAfterScheduledRescanAttempt,
    resumeActiveScan,
    cancelActiveScan,
    dismissActiveScan
  };
}

export type ScanRuntimeController = ReturnType<typeof useScanRuntime>;
