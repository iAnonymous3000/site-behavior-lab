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
import { normalizeScanUrl, resolveScanPrefillNavigation } from "@/lib/scan-prefill";
import {
  ACTIVE_SCAN_SESSION_MAX_AGE_MS,
  clearActiveScanSession,
  clearPendingScanAdmissionSession,
  persistActiveScanSession,
  persistPendingScanAdmissionSession,
  restoreActiveScanSession,
  restorePendingScanAdmissionSession,
  type ActiveScanSession,
  type PendingScanAdmissionSession
} from "@/lib/active-scan-session";
import {
  assertClientOperationOwner,
  ClientOperationOwner,
  type ClientOperationLease
} from "@/lib/client-operation-ownership";
import {
  cancelRuntimeScan,
  deriveScanRuntimePolicy,
  fetchRuntimeScannerHealth,
  friendlyScanError,
  isAbortError,
  liveScannerStatusLabel,
  recoverRuntimeScanAdmissionThroughCommitWindow,
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

type ScanLifecycleOperationKind = "restore" | "submit" | "admission-recovery" | "resume" | "cancel";
type ScanLifecycleOperation = ClientOperationLease<ScanLifecycleOperationKind>;

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
  const [pendingScanAdmission, setPendingScanAdmission] = useState<PendingScanAdmissionSession | null>(null);
  const [recoveringScanAdmission, setRecoveringScanAdmission] = useState(false);
  const [activeScanProgress, setActiveScanProgress] = useState<ScanJobProgress | null>(null);
  const [cancellingScan, setCancellingScan] = useState(false);
  const [cancelScanError, setCancelScanError] = useState<string | null>(null);
  // A completed lifecycle action that the visitor asked for is not an error. Routing
  // it through `error` would style a successful cancellation as a red failure alert.
  const [scanNotice, setScanNotice] = useState<string | null>(null);
  // State updates are asynchronous and therefore cannot be the ownership
  // boundary for paid work. This ref is claimed synchronously before any scan
  // credential can be minted or any request can leave the tab.
  const operationOwnerRef = useRef(new ClientOperationOwner<ScanLifecycleOperationKind>());
  const activeScanJobRef = useRef<ActiveScanJob | null>(null);
  const pendingScanAdmissionRef = useRef<PendingScanAdmissionSession | null>(null);
  const autoRecoveredAdmissionRef = useRef<string | null>(null);
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
        setForm((current) => ({ ...current, url: navigation.targetUrl ?? current.url }));
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
    if (reportPage || !LIVE_SCAN_ENABLED || typeof window === "undefined") return;
    let recovered: ActiveScanSession | null = null;
    let pending: PendingScanAdmissionSession | null = null;
    try {
      recovered = restoreActiveScanSession(window.sessionStorage);
      pending = restorePendingScanAdmissionSession(window.sessionStorage);
    } catch {
      return;
    }
    if (!recovered) {
      if (pending) {
        pendingScanAdmissionRef.current = pending;
        setPendingScanAdmission(pending);
        setError("A previous scan request has an unknown admission outcome. Checking it will never submit a second request.");
      }
      return;
    }

    const operation = operationOwnerRef.current.claim("restore");
    if (operation === null) return;

    // Accepted identifiers are strictly stronger recovery authority than a
    // pending bearer. A crash may leave both records between the two writes.
    if (pending) {
      assertClientOperationOwner(operationOwnerRef.current, operation);
      clearPendingScanAdmissionSession(window.sessionStorage);
    }
    pendingScanAdmissionRef.current = null;
    setPendingScanAdmission(null);

    const recoveredJob: ActiveScanJob = { ...recovered.job, accessKey: "" };
    let disposed = false;
    activeScanJobRef.current = recoveredJob;
    setActiveScanJob(recoveredJob);
    setActiveScanExpiresAt(recovered.expiresAt);
    // A recovered capability was already accepted in the earlier page load.
    setActiveScanProgress(acceptedScanJobProgress());
    setLoading(true);
    setScanning(true);
    setLoaded(null);
    setError(null);
    setScanNotice(null);
    setCancelScanError(null);

    void resumeRuntimeScan({
      job: recoveredJob,
      signal: operation.controller.signal,
      resolveApiUrl: scannerApiUrl,
      onProgress: (progress) => {
        if (!disposed && operationOwnerRef.current.owns(operation)) setActiveScanProgress(progress);
      }
    })
      .then((nextLoaded) => {
        if (disposed || !operationOwnerRef.current.owns(operation)) return;
        setLoaded(nextLoaded);
        releaseActiveScanSession(operation);
      })
      .catch((scanError: unknown) => {
        if (disposed || !operationOwnerRef.current.owns(operation) || isAbortError(scanError)) return;
        if (shouldReleaseAcceptedScanJob(scanError)) releaseActiveScanSession(operation);
        setError(
          scanError instanceof Error
            ? friendlyScanError(scanError.message, OPEN_ACCESS_SCANNER)
            : "Scan status checks failed."
        );
      })
      .finally(() => {
        if (disposed || !operationOwnerRef.current.owns(operation)) return;
        operationOwnerRef.current.release(operation);
        setLoading(false);
        setScanning(false);
      });

    return () => {
      disposed = true;
      operationOwnerRef.current.cancel(operation);
    };
  }, [reportPage]);

  useEffect(() => {
    if (!activeScanJob || activeScanExpiresAt === null || typeof window === "undefined") return;
    const expire = () => {
      if (activeScanJobRef.current?.jobId !== activeScanJob.jobId) return;
      cancelCurrentLifecycleOperation();
      forceReleaseActiveScanSession();
      setLoading(false);
      setScanning(false);
      setCancellingScan(false);
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
    if (!pendingScanAdmission || typeof window === "undefined") return;
    const expire = () => {
      if (
        pendingScanAdmissionRef.current?.credential.capabilityToken !==
        pendingScanAdmission.credential.capabilityToken
      ) {
        return;
      }
      cancelCurrentLifecycleOperation();
      clearPendingScanAdmissionSession(window.sessionStorage);
      pendingScanAdmissionRef.current = null;
      setPendingScanAdmission(null);
      setRecoveringScanAdmission(false);
      setLoading(false);
      setScanning(false);
      setError("The unresolved scan-admission recovery window expired. You can safely start a new scan.");
    };
    const remainingMs = pendingScanAdmission.expiresAt - Date.now();
    if (remainingMs <= 0) {
      expire();
      return;
    }
    const timer = window.setTimeout(expire, remainingMs);
    return () => window.clearTimeout(timer);
  }, [pendingScanAdmission]);

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

  function resetTurnstileAfterLifecycleOperation(kind: ScanLifecycleOperationKind): void {
    if (kind !== "submit" || !policy.turnstileRequired) return;
    setTurnstileToken("");
    setTurnstileResetNonce((nonce) => nonce + 1);
  }

  function cancelCurrentLifecycleOperation(): ScanLifecycleOperation | null {
    const cancelled = operationOwnerRef.current.cancelCurrent();
    if (cancelled) resetTurnstileAfterLifecycleOperation(cancelled.kind);
    return cancelled;
  }

  function retainActiveScanSession(operation: ScanLifecycleOperation, job: ActiveScanJob): void {
    assertClientOperationOwner(operationOwnerRef.current, operation);
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
    assertClientOperationOwner(operationOwnerRef.current, operation);
    activeScanJobRef.current = job;
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

  function releaseActiveScanSession(operation: ScanLifecycleOperation): void {
    assertClientOperationOwner(operationOwnerRef.current, operation);
    forceReleaseActiveScanSession();
  }

  function forceReleaseActiveScanSession(): void {
    if (typeof window !== "undefined") {
      try {
        clearActiveScanSession(window.sessionStorage);
      } catch {
        /* sessionStorage unavailable */
      }
    }
    activeScanJobRef.current = null;
    setActiveScanJob(null);
    setActiveScanExpiresAt(null);
    setActiveScanProgress(null);
  }

  function retainPendingAdmission(
    operation: ScanLifecycleOperation,
    credential: PendingScanAdmissionSession["credential"]
  ): void {
    assertClientOperationOwner(operationOwnerRef.current, operation);
    const currentPending = pendingScanAdmissionRef.current;
    if (
      currentPending?.credential.capabilityToken === credential.capabilityToken &&
      currentPending.credential.requestCommitment === credential.requestCommitment
    ) {
      if (typeof window !== "undefined") {
        // Re-write and read back before every exact POST retry: browser/user
        // storage clearing must not silently downgrade a retained capability
        // to memory-only recovery authority.
        persistPendingScanAdmissionSession(
          window.sessionStorage,
          credential,
          currentPending.createdAt
        );
      }
      assertClientOperationOwner(operationOwnerRef.current, operation);
      return;
    }
    const createdAt = Date.now();
    let session: PendingScanAdmissionSession = {
      credential,
      createdAt,
      expiresAt: createdAt + ACTIVE_SCAN_SESSION_MAX_AGE_MS
    };
    if (typeof window !== "undefined") {
      session = persistPendingScanAdmissionSession(window.sessionStorage, credential, createdAt);
    }
    assertClientOperationOwner(operationOwnerRef.current, operation);
    autoRecoveredAdmissionRef.current = null;
    pendingScanAdmissionRef.current = session;
    setPendingScanAdmission(session);
  }

  function releasePendingAdmission(operation: ScanLifecycleOperation): void {
    assertClientOperationOwner(operationOwnerRef.current, operation);
    if (typeof window !== "undefined") {
      clearPendingScanAdmissionSession(window.sessionStorage);
    }
    assertClientOperationOwner(operationOwnerRef.current, operation);
    pendingScanAdmissionRef.current = null;
    setPendingScanAdmission(null);
    autoRecoveredAdmissionRef.current = null;
  }

  async function recoverPendingAdmission(): Promise<void> {
    const pending = pendingScanAdmissionRef.current;
    if (!pending || recoveringScanAdmission || activeScanJobRef.current) return;
    if (!policy.durableAdmissionEnabled) {
      setError("The durable scanner is not ready to check this retained admission yet. Retry scanner status, then check again.");
      return;
    }
    if (policy.scannerRequiresAccessKey && !form.accessKey.trim()) {
      setError("Enter this deployment's access key under Options before checking the retained admission.");
      return;
    }

    const operation = operationOwnerRef.current.claim("admission-recovery");
    if (operation === null) return;
    setRecoveringScanAdmission(true);
    setLoading(true);
    setScanning(false);
    setLoaded(null);
    setError(null);
    setScanNotice(null);
    setCancelScanError(null);

    try {
      const recovery = await recoverRuntimeScanAdmissionThroughCommitWindow({
        credential: pending.credential,
        createdAt: pending.createdAt,
        accessKey: form.accessKey,
        signal: operation.controller.signal,
        resolveApiUrl: scannerApiUrl
      });
      assertClientOperationOwner(operationOwnerRef.current, operation);
      if (recovery.status === "not-found") {
        setError(
          "No committed job was found after the admission race window. The request remains retained; submit only the exact original URL and options to retry safely."
        );
        return;
      }

      // Persist accepted identifiers before clearing the outcome-unknown
      // bearer. The accepted job then follows the ordinary resume/cancel path.
      retainActiveScanSession(operation, recovery.job);
      releasePendingAdmission(operation);
      setScanning(true);
      const nextLoaded = await resumeRuntimeScan({
        job: recovery.job,
        signal: operation.controller.signal,
        resolveApiUrl: scannerApiUrl,
        onProgress: (progress) => {
          if (operationOwnerRef.current.owns(operation)) setActiveScanProgress(progress);
        }
      });
      assertClientOperationOwner(operationOwnerRef.current, operation);
      setLoaded(nextLoaded);
      releaseActiveScanSession(operation);
    } catch (recoveryError) {
      if (!operationOwnerRef.current.owns(operation) || isAbortError(recoveryError)) return;
      if (shouldReleaseAcceptedScanJob(recoveryError)) releaseActiveScanSession(operation);
      const message = recoveryError instanceof Error
        ? recoveryError.message
        : "The retained scan admission could not be checked.";
      setError(
        activeScanJobRef.current
          ? `${message} The accepted scan remains retained; resume its status checks or cancel it without resubmitting work.`
          : `${message} The admission remains retained; checking it again will not submit another scan.`
      );
    } finally {
      if (!operationOwnerRef.current.owns(operation)) return;
      operationOwnerRef.current.release(operation);
      setRecoveringScanAdmission(false);
      setLoading(false);
      setScanning(false);
    }
  }

  async function runScan(targetUrl: string) {
    // React may deliver two submit handlers before `scanning` re-renders. The
    // synchronous owner is authoritative; a duplicate does not mutate UI,
    // mint a second recovery credential, or send another POST.
    if (operationOwnerRef.current.current() !== null) return;
    if (cancellingScan) {
      setError("Wait for the cancellation request to finish before starting another scan.");
      return;
    }
    if (scheduledRescanCreateBusy) {
      setError("Wait for the scheduled rescan request to finish before scanning.");
      return;
    }
    if (activeScanJobRef.current) {
      setError("This accepted scan is still available. Resume its status checks or cancel it before starting another scan.");
      return;
    }
    if (pendingScanAdmissionRef.current && !policy.durableAdmissionEnabled) {
      setError("This tab is retaining an unresolved durable admission. Wait for the durable scanner to become ready, then check or retry that exact request.");
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

    const operation = operationOwnerRef.current.claim("submit");
    if (operation === null) return;
    const pendingForSubmission = pendingScanAdmissionRef.current;
    setLoading(true);
    setScanning(true);
    setError(null);
    setScanNotice(null);
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
        signal: operation.controller.signal,
        resolveApiUrl: scannerApiUrl,
        durableAdmissionEnabled: policy.durableAdmissionEnabled,
        ...(pendingForSubmission ? { admissionCredential: pendingForSubmission.credential } : {}),
        onAdmissionReady: (credential) => retainPendingAdmission(operation, credential),
        onAdmissionCleared: () => releasePendingAdmission(operation),
        onAccepted: (job) => retainActiveScanSession(operation, job),
        onProgress: (progress) => {
          if (operationOwnerRef.current.owns(operation)) setActiveScanProgress(progress);
        }
      });
      assertClientOperationOwner(operationOwnerRef.current, operation);
      setLoaded(nextLoaded);
      releaseActiveScanSession(operation);
    } catch (scanError) {
      if (!operationOwnerRef.current.owns(operation) || isAbortError(scanError)) return;
      if (shouldReleaseAcceptedScanJob(scanError)) releaseActiveScanSession(operation);
      setError(
        scanError instanceof Error
          ? friendlyScanError(scanError.message, policy.openAccessScanner)
          : "Scan failed."
      );
    } finally {
      if (!operationOwnerRef.current.owns(operation)) return;
      operationOwnerRef.current.release(operation);
      setLoading(false);
      setScanning(false);
      resetTurnstileAfterLifecycleOperation(operation.kind);
    }
  }

  async function resumeActiveScan() {
    const retainedJob = activeScanJobRef.current;
    if (!retainedJob || loading || cancellingScan) return;
    const operation = operationOwnerRef.current.claim("resume");
    // The button that calls this stays visible whenever an accepted job is
    // retained, so a claim can legitimately lose to a request this tab is still
    // running. Say so instead of returning silently and looking broken.
    if (operation === null) {
      setError("Another scan request from this tab is still in flight. Wait for it to finish, then resume status checks.");
      return;
    }
    const job = scanJobWithCurrentAccessKey(retainedJob, form.accessKey);
    setLoading(true);
    setScanning(true);
    setLoaded(null);
    setError(null);
    setScanNotice(null);
    setCancelScanError(null);
    setActiveScanProgress((current) => current ?? acceptedScanJobProgress());

    try {
      const nextLoaded = await resumeRuntimeScan({
        job,
        signal: operation.controller.signal,
        resolveApiUrl: scannerApiUrl,
        onProgress: (progress) => {
          if (operationOwnerRef.current.owns(operation)) setActiveScanProgress(progress);
        }
      });
      assertClientOperationOwner(operationOwnerRef.current, operation);
      setLoaded(nextLoaded);
      releaseActiveScanSession(operation);
    } catch (scanError) {
      if (!operationOwnerRef.current.owns(operation) || isAbortError(scanError)) return;
      if (shouldReleaseAcceptedScanJob(scanError)) releaseActiveScanSession(operation);
      setError(
        scanError instanceof Error
          ? friendlyScanError(scanError.message, policy.openAccessScanner)
          : "Scan status checks failed."
      );
    } finally {
      if (!operationOwnerRef.current.owns(operation)) return;
      operationOwnerRef.current.release(operation);
      setLoading(false);
      setScanning(false);
    }
  }

  async function cancelActiveScan() {
    const retainedJob = activeScanJobRef.current;
    if (!retainedJob || cancellingScan) return;
    const currentOperation = operationOwnerRef.current.current();
    if (currentOperation?.kind === "cancel") return;
    const operation = currentOperation
      ? operationOwnerRef.current.supersede("cancel")
      : operationOwnerRef.current.claim("cancel");
    if (operation === null) return;
    if (currentOperation) resetTurnstileAfterLifecycleOperation(currentOperation.kind);
    const job = scanJobWithCurrentAccessKey(retainedJob, form.accessKey);
    setCancellingScan(true);
    setLoading(false);
    setScanning(false);
    setCancelScanError(null);

    try {
      const message = await cancelRuntimeScan({
        job,
        resolveApiUrl: scannerApiUrl,
        signal: operation.controller.signal
      });
      assertClientOperationOwner(operationOwnerRef.current, operation);
      releaseActiveScanSession(operation);
      setLoading(false);
      setScanning(false);
      setScanNotice(message);
    } catch (cancelError) {
      if (!operationOwnerRef.current.owns(operation) || isAbortError(cancelError)) return;
      // A failed DELETE never discards the accepted capability; the visitor can
      // retry cancellation or resume polling with the admission-time key.
      setCancelScanError(
        cancelError instanceof Error
          ? friendlyScanError(cancelError.message, policy.openAccessScanner)
          : "The scan could not be cancelled."
      );
    } finally {
      if (!operationOwnerRef.current.owns(operation)) return;
      operationOwnerRef.current.release(operation);
      setCancellingScan(false);
    }
  }

  function dismissActiveScan(): void {
    cancelCurrentLifecycleOperation();
    forceReleaseActiveScanSession();
    setLoading(false);
    setScanning(false);
    setCancellingScan(false);
    setCancelScanError(null);
    setError(null);
    setScanNotice(null);
  }

  /**
   * Before admission there is nothing to cancel: the POST may already have left this
   * tab, and with async scans on, the scanner can still complete the visit. So this
   * stops the client waiting and says exactly that, rather than claiming a
   * cancellation it cannot perform.
   */
  function stopWaitingForAdmission(): void {
    // Stopping the wait must also stop automatic admission recovery. The effect
    // below re-runs the moment `loading` clears, so unless the once-per-capability
    // guard is armed for the retained credential it restarts the wait and erases
    // the notice set here. The credential itself stays retained: the visitor can
    // still check admission deliberately, or retry the exact same request.
    const pending = pendingScanAdmissionRef.current;
    dismissActiveScan();
    if (pending) autoRecoveredAdmissionRef.current = pending.credential.capabilityToken;
    // A cancelled recovery's finalizer no longer owns its lease, so it will not
    // clear this flag; leaving it set disables the banner's Check admission button.
    setRecoveringScanAdmission(false);
    setScanNotice(
      "Stopped waiting for the scanner. The request may already have been accepted, so check back shortly before scanning again."
    );
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
    // stays in the field. Mirroring it into `error` would raise the scan-recovery
    // banner, pull focus out of the field the visitor still has to correct, announce
    // the same sentence twice, and hide the corpus hero until the next successful scan.
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

  useEffect(() => {
    if (
      reportPage ||
      !pendingScanAdmission ||
      activeScanJob ||
      recoveringScanAdmission ||
      loading ||
      !policy.durableAdmissionEnabled ||
      policy.scannerUnavailable ||
      (policy.scannerRequiresAccessKey && !form.accessKey.trim())
    ) {
      return;
    }
    const capability = pendingScanAdmission.credential.capabilityToken;
    if (autoRecoveredAdmissionRef.current === capability) return;
    autoRecoveredAdmissionRef.current = capability;
    void recoverPendingAdmission();
  }, [
    activeScanJob,
    form.accessKey,
    loading,
    pendingScanAdmission,
    policy.durableAdmissionEnabled,
    policy.scannerRequiresAccessKey,
    policy.scannerUnavailable,
    recoveringScanAdmission,
    reportPage
  ]);

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
    pendingScanAdmission,
    recoveringScanAdmission,
    activeScanProgress,
    cancellingScan,
    cancelScanError,
    scanNotice,
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
    recoverPendingAdmission,
    resumeActiveScan,
    cancelActiveScan,
    dismissActiveScan,
    stopWaitingForAdmission
  };
}

export type ScanRuntimeController = ReturnType<typeof useScanRuntime>;
