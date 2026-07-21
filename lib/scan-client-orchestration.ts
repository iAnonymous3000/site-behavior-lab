import { readLoadedReport } from "./client-report-reader";
import {
  isRecoverableScanJob,
  type ActiveScanJob
} from "./active-scan-session";
import { isRecord } from "./guards";
import {
  pollAcceptedScanJob,
  ScanJobEndedError,
  type AcceptedScanJobPoll
} from "./scan-job-polling";
import { isScanRuntimeHealth, type ScanRuntimeHealth } from "./scan-runtime-health";
import type { LoadedReport } from "./scan-report-view";
import type { ScanDevice, ScanJobProgress, ScanJobSubmissionResponse } from "./types";

export type { ActiveScanJob } from "./active-scan-session";

/** Prefer a newly entered gated-deployment key without persisting it. */
export function scanJobWithCurrentAccessKey(job: ActiveScanJob, currentAccessKey: string): ActiveScanJob {
  const accessKey = currentAccessKey.trim();
  return { ...job, accessKey: accessKey || job.accessKey };
}

export type RuntimeScanForm = {
  device: ScanDevice;
  gpcEnabled: boolean;
  compareGpc: boolean;
  compareShields: boolean;
  compareConsent: boolean;
  accessKey: string;
};

export type RuntimeScanFetcher = (input: string, init: RequestInit) => Promise<Response>;
export type RuntimeScanPoller = (options: AcceptedScanJobPoll) => Promise<LoadedReport>;

export type ScanRuntimePolicy = {
  gpcComparisonEnabled: boolean;
  shieldsComparisonEnabled: boolean;
  consentComparisonEnabled: boolean;
  openAccessScanner: boolean;
  liveApiServesReportPages: boolean;
  /** True only on an exact, validated edge-health capability advertisement. */
  scheduledRescansEnabled: boolean;
  scannerRequiresAccessKey: boolean;
  scannerUnavailable: boolean;
  turnstileRequired: boolean;
  turnstileUnsupported: boolean;
  awaitingTurnstile: boolean;
  awaitingScannerHealth: boolean;
  scanBlocked: boolean;
};

export function deriveScanRuntimePolicy(input: {
  liveScanEnabled: boolean;
  staticExport: boolean;
  staticLiveScanEnabled: boolean;
  openAccessBuild: boolean;
  reportPage: boolean;
  turnstileSiteKeyConfigured: boolean;
  turnstileToken: string;
  health: ScanRuntimeHealth | null;
  healthError: string | null;
}): ScanRuntimePolicy {
  // Before health resolves, a dynamic build may render its configured options
  // while submission remains blocked. Once health answers, advertised false
  // is authoritative on every surface, not only the static-live client.
  const gpcComparisonEnabled = input.health
    ? input.health.capabilities?.gpcComparison === true
    : !input.staticExport;
  const shieldsComparisonEnabled = input.health
    ? input.health.capabilities?.shieldsComparison === true
    : !input.staticExport;
  const consentComparisonEnabled = input.health
    ? input.health.capabilities?.consentComparison === true
    : !input.staticExport;
  // The build flag is only a pre-health rendering hint. Once the live edge has
  // answered, its resolved posture is authoritative so an activation-time
  // access gate cannot be hidden by an older open-access Pages build.
  const openAccessScanner = input.health
    ? input.health.openAccess === true
    : input.openAccessBuild;
  const liveApiServesReportPages =
    input.reportPage || input.health?.capabilities?.savedReportPages === true;
  const scheduledRescansEnabled = input.health?.capabilities?.scheduledRescans === true;
  const scannerRequiresAccessKey =
    input.liveScanEnabled &&
    !openAccessScanner &&
    (!input.staticLiveScanEnabled || input.health?.authenticated === true);
  const scannerUnavailable =
    input.liveScanEnabled && (Boolean(input.healthError) || input.health?.scansAvailable === false);
  const turnstileRequired = input.liveScanEnabled && input.health?.turnstile === true;
  const turnstileUnsupported = turnstileRequired && !input.turnstileSiteKeyConfigured;
  const awaitingTurnstile =
    turnstileRequired && input.turnstileSiteKeyConfigured && !input.turnstileToken;
  const awaitingScannerHealth =
    input.liveScanEnabled &&
    !input.reportPage &&
    input.health === null &&
    input.healthError === null;
  const scanBlocked =
    awaitingScannerHealth || scannerUnavailable || turnstileUnsupported || awaitingTurnstile;

  return {
    gpcComparisonEnabled,
    shieldsComparisonEnabled,
    consentComparisonEnabled,
    openAccessScanner,
    liveApiServesReportPages,
    scheduledRescansEnabled,
    scannerRequiresAccessKey,
    scannerUnavailable,
    turnstileRequired,
    turnstileUnsupported,
    awaitingTurnstile,
    awaitingScannerHealth,
    scanBlocked
  };
}

export async function fetchRuntimeScannerHealth(options: {
  resolveApiUrl: (path: string) => string;
  fetcher?: RuntimeScanFetcher;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<{ health: ScanRuntimeHealth | null; error: string | null }> {
  const fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
  try {
    const { response, payload } = await withAbortDeadline(
      {
        signal: options.signal,
        timeoutMs: options.timeoutMs ?? 8_000,
        timeoutMessage: "Scanner health check timed out."
      },
      async (signal) => {
        const response = await fetcher(options.resolveApiUrl("/api/health"), { cache: "no-store", signal });
        return { response, payload: (await response.json()) as unknown };
      }
    );
    if (!response.ok || !isScanRuntimeHealth(payload)) {
      throw new Error("Scanner health check failed.");
    }
    if (!payload.ok) {
      return {
        health: null,
        error: payload.error || "The public scanner is not ready for scans right now."
      };
    }
    return { health: payload, error: null };
  } catch {
    return {
      health: null,
      error: "Public scanner status is unavailable. Try again shortly."
    };
  }
}

export async function submitRuntimeScan(options: {
  targetUrl: string;
  form: RuntimeScanForm;
  gpcComparisonEnabled: boolean;
  shieldsComparisonEnabled: boolean;
  consentComparisonEnabled: boolean;
  scannerRequiresAccessKey: boolean;
  turnstileRequired: boolean;
  turnstileToken: string;
  signal?: AbortSignal;
  resolveApiUrl: (path: string) => string;
  fetcher?: RuntimeScanFetcher;
  poller?: RuntimeScanPoller;
  onAccepted: (job: ActiveScanJob) => void;
  onProgress?: (progress: ScanJobProgress) => void;
}): Promise<LoadedReport> {
  const fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
  const poller = options.poller ?? pollAcceptedScanJob;
  const accessKey = options.form.accessKey.trim();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (options.scannerRequiresAccessKey && accessKey) {
    headers.Authorization = `Bearer ${accessKey}`;
  }

  const response = await fetcher(options.resolveApiUrl("/api/scan"), {
    method: "POST",
    headers,
    signal: options.signal,
    body: JSON.stringify({
      url: options.targetUrl,
      device: options.form.device,
      gpcEnabled: options.form.gpcEnabled,
      compareGpc: options.gpcComparisonEnabled && options.form.compareGpc,
      compareShields: options.shieldsComparisonEnabled && options.form.compareShields,
      compareConsent: options.consentComparisonEnabled && options.form.compareConsent,
      consentMode: "observe",
      ...(options.turnstileRequired && options.turnstileToken
        ? { turnstileToken: options.turnstileToken }
        : {})
    })
  });
  const payload = (await response.json()) as unknown;

  if (isRuntimeScanError(payload)) throw new Error(payload.error);
  if (isScanJobSubmissionResponse(payload)) {
    // The status path is a recovery capability. Keep the admission access key
    // in memory for this page lifetime only; tab recovery persists identifiers
    // but deliberately omits this deployment-wide credential.
    const acceptedJob: ActiveScanJob = {
      jobId: payload.jobId,
      statusPath: payload.statusPath,
      accessKey: options.scannerRequiresAccessKey ? accessKey : "",
      reportId: payload.reportId
    };
    options.onAccepted(acceptedJob);
    return poller({
      ...acceptedJob,
      signal: options.signal,
      resolveApiUrl: options.resolveApiUrl,
      onProgress: options.onProgress
    });
  }

  // Synchronous results are untrusted wire data like every other payload and
  // must pass the canonical version-aware reader before reaching render state.
  const read = await readLoadedReport(payload, "The scan result");
  if (!read.ok) throw new Error(read.message);
  return read.loaded;
}

export function resumeRuntimeScan(options: {
  job: ActiveScanJob;
  signal?: AbortSignal;
  resolveApiUrl: (path: string) => string;
  poller?: RuntimeScanPoller;
  onProgress?: (progress: ScanJobProgress) => void;
}): Promise<LoadedReport> {
  const poller = options.poller ?? pollAcceptedScanJob;
  return poller({
    ...options.job,
    signal: options.signal,
    resolveApiUrl: options.resolveApiUrl,
    onProgress: options.onProgress
  });
}

export async function cancelRuntimeScan(options: {
  job: ActiveScanJob;
  resolveApiUrl: (path: string) => string;
  fetcher?: RuntimeScanFetcher;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<string> {
  const fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
  const headers: Record<string, string> = {};
  if (options.job.accessKey) headers.Authorization = `Bearer ${options.job.accessKey}`;

  const { payload } = await withAbortDeadline(
    {
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? 10_000,
      timeoutMessage: "Scan cancellation timed out."
    },
    async (signal) => {
      const response = await fetcher(options.resolveApiUrl(options.job.statusPath), {
        method: "DELETE",
        cache: "no-store",
        headers,
        signal
      });
      return { response, payload: (await response.json()) as unknown };
    }
  );
  if (isRuntimeScanError(payload)) throw new Error(payload.error);
  if (!isRecord(payload) || payload.ok !== true || payload.status !== "cancelled") {
    throw new Error("The scan could not be cancelled.");
  }
  return typeof payload.error === "string" && payload.error ? payload.error : "Scan cancelled.";
}

/** Definitive failure endings invalidate recovery; readable success is cleared by the caller. */
export function shouldReleaseAcceptedScanJob(error: unknown): boolean {
  return error instanceof ScanJobEndedError;
}

export function isAbortError(error: unknown): boolean {
  return isRecord(error) && error.name === "AbortError";
}

export function liveScannerStatusLabel(input: {
  health: ScanRuntimeHealth | null;
  error: string | null;
  liveScanEnabled: boolean;
  staticExport: boolean;
}): string {
  if (!input.liveScanEnabled) return input.staticExport ? "Evidence Library" : "Controlled";
  if (input.error) return "Offline";
  if (!input.health) return "Checking";
  if (input.health.scansAvailable === false) return "Offline";
  return input.health.status === "ok" ? "Live" : input.health.ok ? "Limited" : "Offline";
}

export function scannerStatusText(health: ScanRuntimeHealth | null, error: string | null): string {
  if (error) return error;
  if (!health) return "Checking public scanner status...";
  if (health.scansAvailable === false) return "Scanner temporarily unavailable. Try again later.";

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
    health.checks?.adblock?.active === false
      ? " Brave Shields classification is unavailable on this scanner."
      : "";

  if (health.openAccess) {
    return `Public scanner ready. No access key required.${limits}${comparison}${storage}${adblock}`;
  }
  return `Scanner ready. Access key required.${comparison}${storage}${adblock}`;
}

export function friendlyScanError(message: string, openAccessScanner: boolean): string {
  const lower = message.toLowerCase();
  if (lower.includes("cancellation") && lower.includes("timeout")) {
    return "The cancellation request timed out. The accepted scan is still retained; try cancelling again or resume its status checks.";
  }
  if (lower.includes("timeout") || lower.includes("did not load") || lower.includes("scan duration")) {
    return "The page did not finish loading in time. It may be slow, very large, or blocking automated visits. Try again, or try a different page.";
  }
  if (
    lower.includes("private") ||
    lower.includes("localhost") ||
    lower.includes("internal") ||
    lower.includes("not a public")
  ) {
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
  if (
    lower.includes("access") ||
    lower.includes("token") ||
    lower.includes("unauthorized") ||
    lower.includes("forbidden")
  ) {
    return openAccessScanner
      ? "The public scanner is still rejecting open scans. The Cloudflare Worker may need to be redeployed."
      : "This scanner requires a valid access key. Add it under Options, or contact whoever runs this instance.";
  }
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

async function withAbortDeadline<T>(
  options: { signal?: AbortSignal; timeoutMs: number; timeoutMessage: string },
  task: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) abortFromCaller();
  else options.signal?.addEventListener("abort", abortFromCaller, { once: true });

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException(options.timeoutMessage, "TimeoutError"));
  }, Math.max(1, options.timeoutMs));
  const aborted = new Promise<never>((_resolve, reject) => {
    const rejectAbort = () => reject(controller.signal.reason ?? new DOMException("The request was cancelled.", "AbortError"));
    if (controller.signal.aborted) rejectAbort();
    else controller.signal.addEventListener("abort", rejectAbort, { once: true });
  });

  try {
    return await Promise.race([task(controller.signal), aborted]);
  } catch (error) {
    if (timedOut) throw new Error(options.timeoutMessage);
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abortFromCaller);
  }
}

function isRuntimeScanError(value: unknown): value is { ok: false; error: string } {
  return isRecord(value) && value.ok === false && typeof value.error === "string";
}

function isScanJobSubmissionResponse(value: unknown): value is ScanJobSubmissionResponse {
  if (!(
    isRecord(value) &&
    value.ok === true &&
    typeof value.jobId === "string" &&
    value.status === "queued" &&
    typeof value.statusPath === "string" &&
    typeof value.reportId === "string"
  )) return false;
  return isRecoverableScanJob({
    jobId: value.jobId,
    statusPath: value.statusPath,
    reportId: value.reportId
  });
}
