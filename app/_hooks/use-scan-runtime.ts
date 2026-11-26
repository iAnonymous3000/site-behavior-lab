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
import type { ComparisonRunMode } from "@/lib/run-mode-copy";
import { heldRunModeOutcome, normalizeScanUrl, resolveScanPrefillNavigation } from "@/lib/scan-prefill";
import {
  assertClientOperationOwner,
  ClientOperationOwner
} from "@/lib/client-operation-ownership";
import {
  deriveScanRuntimePolicy,
  fetchRuntimeScannerHealth,
  friendlyScanError,
  isAbortError,
  liveScannerStatusLabel,
  scannerStatusText
} from "@/lib/scan-client-orchestration";
import type { ScanRuntimeHealth } from "@/lib/scan-runtime-health";
import type { LoadedReport } from "@/lib/scan-report-view";
import { submitV3RuntimeScan, type V3LiveScanResult } from "@/lib/v3/client-scan";

const INITIAL_SCAN_FORM: ScanFormState = {
  url: "",
  device: "desktop",
  region: "auto",
  gpcEnabled: true,
  compareGpc: false,
  compareShields: false,
  shieldsStrength: "standard",
  compareConsent: false,
  accessKey: ""
};

type UseScanRuntimeOptions = {
  reportPage: boolean;
  initialLoaded: LoadedReport | null;
  initialError: string | null;
  initialLoading: boolean;
};

type ScanLifecycleOperationKind = "submit";

/**
 * Own the browser-side v3 live scan lifecycle while keeping local report upload
 * adapters independent. Submissions run synchronously against `POST /api/v3/scan`
 * under an abortable `ClientOperationOwner` lease so duplicate clicks never fire
 * a second scan and cancelling aborts cleanly.
 */
export function useScanRuntime({
  reportPage,
  initialLoaded,
  initialError,
  initialLoading
}: UseScanRuntimeOptions) {
  const [form, setForm] = useState<ScanFormState>(INITIAL_SCAN_FORM);
  const [loaded, setLoaded] = useState<LoadedReport | null>(initialLoaded);
  const [liveV3Result, setLiveV3Result] = useState<V3LiveScanResult | null>(null);
  const [error, setError] = useState<string | null>(initialError);
  const [loading, setLoading] = useState(initialLoading);
  const [scanning, setScanning] = useState(false);
  // A completed lifecycle action that the visitor asked for is not an error. Routing
  // it through `error` would style a successful cancellation as a red failure alert.
  const [scanNotice, setScanNotice] = useState<string | null>(null);
  // State updates are asynchronous and therefore cannot be the ownership
  // boundary for paid work. This ref is claimed synchronously before any
  // scan request can leave the tab.
  const operationOwnerRef = useRef(new ClientOperationOwner<ScanLifecycleOperationKind>());
  const [scannerHealth, setScannerHealth] = useState<ScanRuntimeHealth | null>(null);
  const [scannerHealthError, setScannerHealthError] = useState<string | null>(null);
  const [scannerHealthAttempt, setScannerHealthAttempt] = useState(0);
  const [turnstileToken, setTurnstileToken] = useState("");
  // Bumped after every network scan attempt: Turnstile tokens are single-use.
  const [turnstileResetNonce, setTurnstileResetNonce] = useState(0);
  const [urlNotice, setUrlNotice] = useState("");
  const [urlError, setUrlError] = useState("");
  // The address a site's own "Scan ... again" link prefilled, so the form can
  // tell that arrival from typing.
  const [prefilledUrl, setPrefilledUrl] = useState<string | null>(null);
  // The comparison that link asked for, if any: kept for the arrival, and held
  // until the scanner's health says whether it is offered.
  const [prefilledMode, setPrefilledMode] = useState<ComparisonRunMode | null>(null);
  const [heldMode, setHeldMode] = useState<ComparisonRunMode | null>(null);

  useEffect(() => {
    if (reportPage) return;
    try {
      // Remove any legacy browser copy of a deployment-wide credential.
      localStorage.removeItem("sbl-access-key");
    } catch {
      /* localStorage unavailable */
    }
  }, [reportPage]);

  useEffect(() => {
    if (reportPage || typeof window === "undefined") return;
    const applyScanPrefill = () => {
      const navigation = resolveScanPrefillNavigation(window.location.href);
      if (!navigation) return;

      if (navigation.cleanHref !== window.location.href) {
        try {
          // Cleanup must succeed before target text reaches React state. This
          // also removes legacy query-prefill input from browser history.
          window.history.replaceState(window.history.state, "", navigation.cleanHref);
        } catch {
          return;
        }
      }

      if (navigation.targetUrl) {
        setForm((current) => ({
          ...current,
          url: navigation.targetUrl ?? current.url
        }));
        setPrefilledUrl(navigation.targetUrl);
        setPrefilledMode(navigation.mode);
        setHeldMode(navigation.mode);
      }
      if (navigation.scrollToScan) document.getElementById("scan")?.scrollIntoView();
    };

    applyScanPrefill();
    window.addEventListener("hashchange", applyScanPrefill);
    window.addEventListener("popstate", applyScanPrefill);
    return () => {
      window.removeEventListener("hashchange", applyScanPrefill);
      window.removeEventListener("popstate", applyScanPrefill);
    };
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

  useEffect(
    () => () => {
      operationOwnerRef.current.cancelCurrent();
    },
    []
  );

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

  // A mode a scan link asked for is applied once, after health answers: the
  // effect above clears any comparison set before then, since a static build
  // offers none until health says so. The form selects the mode if offered,
  // or keeps Single beside the run control's unavailable note. It never
  // submits: only the visitor's own press of the button does.
  useEffect(() => {
    if (heldMode === null) return;
    const outcome = heldRunModeOutcome({
      requested: heldMode,
      awaitingScannerHealth: policy.awaitingScannerHealth,
      offered: {
        gpc: policy.gpcComparisonEnabled,
        shields: policy.shieldsComparisonEnabled,
        consent: policy.consentComparisonEnabled
      }
    });
    if (outcome === "hold") return;
    setHeldMode(null);
    setForm((current) => ({
      ...current,
      compareGpc: outcome === "select" && heldMode === "gpc",
      compareShields: outcome === "select" && heldMode === "shields",
      compareConsent: outcome === "select" && heldMode === "consent"
    }));
  }, [
    heldMode,
    policy.awaitingScannerHealth,
    policy.consentComparisonEnabled,
    policy.gpcComparisonEnabled,
    policy.shieldsComparisonEnabled
  ]);

  function resetTurnstileIfRequired(): void {
    if (!policy.turnstileRequired) return;
    setTurnstileToken("");
    setTurnstileResetNonce((nonce) => nonce + 1);
  }

  async function runScan(targetUrl: string) {
    // React may deliver two submit handlers before `scanning` re-renders. The
    // synchronous owner is authoritative; a duplicate does not mutate UI or
    // send another POST.
    if (operationOwnerRef.current.current() !== null) return;
    if (!LIVE_SCAN_ENABLED) {
      setLoading(false);
      setLoaded(null);
      setLiveV3Result(null);
      setError("This published build cannot run live scans. Use an Actions-generated report, upload JSON, or run the Node app locally.");
      return;
    }
    if (policy.awaitingScannerHealth) {
      setLoading(false);
      setLoaded(null);
      setLiveV3Result(null);
      setError("Checking public scanner status. Try again in a moment.");
      return;
    }
    if (policy.scannerUnavailable) {
      setLoading(false);
      setLoaded(null);
      setLiveV3Result(null);
      setError(scannerHealthError || "The public scanner is not available right now. Try again shortly.");
      return;
    }
    if (policy.turnstileUnsupported) {
      setLoading(false);
      setLoaded(null);
      setLiveV3Result(null);
      setError(
        "This scanner requires Turnstile verification, but this site was not built with a Turnstile site key. Rebuild with NEXT_PUBLIC_SITE_BEHAVIOR_LAB_TURNSTILE_SITE_KEY set to the Worker's site key."
      );
      return;
    }
    if (policy.awaitingTurnstile) {
      setLoading(false);
      setLoaded(null);
      setLiveV3Result(null);
      setError("Complete the Turnstile check before scanning.");
      return;
    }

    const operation = operationOwnerRef.current.claim("submit");
    if (operation === null) return;
    setLoading(true);
    setScanning(true);
    setError(null);
    setScanNotice(null);
    setLoaded(null);
    setLiveV3Result(null);

    try {
      const result = await submitV3RuntimeScan({
        targetUrl,
        form,
        gpcComparisonEnabled: policy.gpcComparisonEnabled,
        shieldsComparisonEnabled: policy.shieldsComparisonEnabled,
        consentComparisonEnabled: policy.consentComparisonEnabled,
        scannerRequiresAccessKey: policy.scannerRequiresAccessKey,
        turnstileRequired: policy.turnstileRequired,
        turnstileToken,
        signal: operation.controller.signal,
        resolveApiUrl: scannerApiUrl
      });
      assertClientOperationOwner(operationOwnerRef.current, operation);
      setLiveV3Result(result);
    } catch (scanError) {
      if (!operationOwnerRef.current.owns(operation) || isAbortError(scanError)) return;
      setError(
        scanError instanceof Error
          ? friendlyScanError(scanError, policy.openAccessScanner)
          : "Scan failed."
      );
    } finally {
      if (!operationOwnerRef.current.owns(operation)) return;
      operationOwnerRef.current.release(operation);
      setLoading(false);
      setScanning(false);
      resetTurnstileIfRequired();
    }
  }

  function cancelActiveScan(): void {
    const cancelled = operationOwnerRef.current.cancelCurrent();
    if (!cancelled) return;
    resetTurnstileIfRequired();
    setLoading(false);
    setScanning(false);
    setError(null);
    setScanNotice("Scan cancelled.");
  }

  function dismissBanner(): void {
    setError(null);
    setScanNotice(null);
  }

  function retryScannerHealth() {
    setScannerHealth(null);
    setScannerHealthError(null);
    setScannerHealthAttempt((attempt) => attempt + 1);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (operationOwnerRef.current.current() !== null) return;
    const trimmed = form.url.trim();
    // A rejected URL never reaches the network, so it is a field-level problem and
    // stays in the field. Mirroring it into `error` would raise the recovery banner,
    // pull focus out of the field the visitor still has to correct, announce the
    // same sentence twice, and hide the corpus hero until the next successful scan.
    if (!trimmed) {
      setUrlError("Enter a public URL to scan, for example https://example.com.");
      window.requestAnimationFrame(() => document.getElementById("url")?.focus());
      return;
    }
    const normalized = normalizeScanUrl(trimmed);
    if (!normalized) {
      setUrlNotice("");
      setUrlError("Enter a valid public URL, for example https://example.com.");
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

  return {
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
    turnstileToken,
    turnstileResetNonce,
    setTurnstileToken,
    urlNotice,
    urlError,
    prefilledUrl,
    prefilledMode,
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
    cancelActiveScan,
    dismissBanner
  };
}

export type ScanRuntimeController = ReturnType<typeof useScanRuntime>;
