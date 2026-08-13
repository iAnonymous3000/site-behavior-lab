import { readLoadedReport } from "./client-report-reader";
import {
  ClientFetchTimeoutError,
  fetchJsonWithPolicy
} from "./client-fetch-policy";
import {
  isRecoverableScanJob,
  type ActiveScanJob
} from "./active-scan-session";
import {
  SCAN_ADMISSION_CAPABILITY_HEADER,
  SCAN_ADMISSION_COMMITMENT_HEADER,
  SCAN_ADMISSION_RECOVERY_PATH,
  isScanAdmissionCredential,
  mintScanAdmissionCredential,
  scanAdmissionCredentialMatchesSemantics,
  scanAdmissionSemanticsFromBody,
  type ScanAdmissionCredential,
  type ScanAdmissionRandomBytes
} from "./scan-admission-capability";
import { scanFailureText, type ScanFailureNotice } from "./scan-failure-causes";
import { isRecord } from "./guards";
import { BROWSER_PUBLIC_REPORT_JSON_MAX_BYTES } from "./report-resource-limits";
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
export type RuntimeScanAdmissionRecovery =
  | Readonly<{ status: "accepted"; job: ActiveScanJob }>
  | Readonly<{ status: "not-found" }>;

const SCAN_ADMISSION_RESPONSE_MAX_BYTES = 16 * 1024;
const SCAN_HEALTH_RESPONSE_MAX_BYTES = 64 * 1024;
const SCAN_CANCELLATION_RESPONSE_MAX_BYTES = 16 * 1024;
/** Edge admission is bounded to 30s; keep checking slightly beyond that race window. */
export const SCAN_ADMISSION_COMMIT_RECOVERY_WINDOW_MS = 35_000;
const SCAN_ADMISSION_RECOVERY_BACKOFF_MS = [250, 500, 1_000, 2_000] as const;

export type ScanRuntimePolicy = {
  gpcComparisonEnabled: boolean;
  shieldsComparisonEnabled: boolean;
  consentComparisonEnabled: boolean;
  openAccessScanner: boolean;
  liveApiServesReportPages: boolean;
  /** True only on an exact, validated edge-health capability advertisement. */
  scheduledRescansEnabled: boolean;
  /** Browser admission recovery is safe only while the durable edge is ready. */
  durableAdmissionEnabled: boolean;
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
  const durableAdmissionEnabled =
    input.health?.checks?.durableJobs?.enabled === true &&
    input.health.checks.durableJobs.readiness === "ready";
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
    durableAdmissionEnabled,
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
    const { status, payload } = await fetchRuntimeJsonWithPolicy(
      options.resolveApiUrl("/api/health"),
      {
        fetcher,
        init: { cache: "no-store", signal: options.signal },
        label: "Scanner health check",
        maxBytes: SCAN_HEALTH_RESPONSE_MAX_BYTES,
        connectTimeoutMs: options.timeoutMs ?? 8_000,
        operationTimeoutMs: options.timeoutMs ?? 8_000
      }
    );
    if (status < 200 || status >= 300 || !isScanRuntimeHealth(payload)) {
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
  /** Test seams; production uses the shared finite defaults. */
  responseConnectTimeoutMs?: number;
  responseOperationTimeoutMs?: number;
  /** Enable only when exact durable-admission replay is advertised by health. */
  durableAdmissionEnabled?: boolean;
  /** Reuse this exact credential for an explicit same-semantics retry. */
  admissionCredential?: ScanAdmissionCredential;
  admissionRandomBytes?: ScanAdmissionRandomBytes;
  /** Must retain the credential before this promise resolves and POST begins. */
  onAdmissionReady?: (credential: ScanAdmissionCredential) => void | Promise<void>;
  /** Called only after accepted recovery is durable or rejection is definitive. */
  onAdmissionCleared?: () => void | Promise<void>;
  onAccepted: (job: ActiveScanJob) => void | Promise<void>;
  onProgress?: (progress: ScanJobProgress) => void;
}): Promise<LoadedReport> {
  const fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
  const poller = options.poller ?? pollAcceptedScanJob;
  const accessKey = options.form.accessKey.trim();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (options.scannerRequiresAccessKey && accessKey) {
    headers.Authorization = `Bearer ${accessKey}`;
  }

  const requestBody = {
    url: options.targetUrl,
    device: options.form.device,
    gpcEnabled: options.form.gpcEnabled,
    compareGpc: options.gpcComparisonEnabled && options.form.compareGpc,
    compareShields: options.shieldsComparisonEnabled && options.form.compareShields,
    compareConsent: options.consentComparisonEnabled && options.form.compareConsent,
    consentMode: "observe" as const,
    ...(options.turnstileRequired && options.turnstileToken
      ? { turnstileToken: options.turnstileToken }
      : {})
  };

  let responseStatus: number;
  let payload: unknown;
  if (options.durableAdmissionEnabled) {
    if (!options.onAdmissionReady || !options.onAdmissionCleared) {
      throw new Error("Durable scan admission requires explicit recovery lifecycle callbacks.");
    }
    const semantics = scanAdmissionSemanticsFromBody(requestBody);
    if (!semantics) throw new Error("The scan request could not be bound to a durable admission.");
    const credential = options.admissionCredential ??
      (await mintScanAdmissionCredential(semantics, options.admissionRandomBytes));
    if (
      !isScanAdmissionCredential(credential) ||
      !(await scanAdmissionCredentialMatchesSemantics(credential, semantics))
    ) {
      throw new Error("The retained scan admission does not match this scan request.");
    }
    // This callback is deliberately awaited: no POST bytes may leave the tab
    // until the caller has retained the outcome-unknown recovery capability.
    await options.onAdmissionReady(credential);
    headers[SCAN_ADMISSION_CAPABILITY_HEADER] = credential.capabilityToken;
    headers[SCAN_ADMISSION_COMMITMENT_HEADER] = credential.requestCommitment;
    const result = await fetchRuntimeJsonWithPolicy(options.resolveApiUrl("/api/scan"), {
      fetcher,
      init: {
        method: "POST",
        headers,
        signal: options.signal,
        body: JSON.stringify(requestBody),
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer"
      },
      label: "Scan admission",
      maxBytes: SCAN_ADMISSION_RESPONSE_MAX_BYTES,
      connectTimeoutMs: options.responseConnectTimeoutMs,
      operationTimeoutMs: options.responseOperationTimeoutMs
    });
    responseStatus = result.status;
    payload = result.payload;
  } else {
    const result = await fetchRuntimeJsonWithPolicy(options.resolveApiUrl("/api/scan"), {
      fetcher,
      init: {
        method: "POST",
        headers,
        signal: options.signal,
        body: JSON.stringify(requestBody),
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer"
      },
      label: "Scan response",
      maxBytes: BROWSER_PUBLIC_REPORT_JSON_MAX_BYTES,
      connectTimeoutMs: options.responseConnectTimeoutMs,
      operationTimeoutMs: options.responseOperationTimeoutMs
    });
    responseStatus = result.status;
    payload = result.payload;
  }

  if (isRuntimeScanError(payload)) {
    if (options.durableAdmissionEnabled && responseStatus >= 400 && responseStatus < 500) {
      await options.onAdmissionCleared!();
    }
    throw scanRequestError(payload);
  }
  if (responseStatus >= 200 && responseStatus < 300 && isScanJobSubmissionResponse(payload)) {
    // The status path is a recovery capability. Keep the admission access key
    // in memory for this page lifetime only; tab recovery persists identifiers
    // but deliberately omits this deployment-wide credential.
    const acceptedJob: ActiveScanJob = {
      jobId: payload.jobId,
      statusPath: payload.statusPath,
      accessKey: options.scannerRequiresAccessKey ? accessKey : "",
      reportId: payload.reportId
    };
    // Persist the accepted tuple before removing the pending bearer. A crash
    // between these operations may leave both records, but never neither.
    await options.onAccepted(acceptedJob);
    if (options.durableAdmissionEnabled) await options.onAdmissionCleared!();
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
  if (options.durableAdmissionEnabled) await options.onAdmissionCleared!();
  return read.loaded;
}

/** Recover an outcome-unknown durable POST without putting the bearer in a URL. */
export async function recoverRuntimeScanAdmission(options: {
  credential: ScanAdmissionCredential;
  accessKey?: string;
  signal?: AbortSignal;
  resolveApiUrl: (path: string) => string;
  fetcher?: RuntimeScanFetcher;
}): Promise<RuntimeScanAdmissionRecovery> {
  if (!isScanAdmissionCredential(options.credential)) {
    throw new Error("The retained scan admission is invalid.");
  }
  const accessKey = options.accessKey?.trim() ?? "";
  const headers: Record<string, string> = {
    [SCAN_ADMISSION_CAPABILITY_HEADER]: options.credential.capabilityToken,
    [SCAN_ADMISSION_COMMITMENT_HEADER]: options.credential.requestCommitment
  };
  if (accessKey) headers.Authorization = `Bearer ${accessKey}`;
  const result = await fetchRuntimeJsonWithPolicy(
    options.resolveApiUrl(SCAN_ADMISSION_RECOVERY_PATH),
    {
      fetcher: options.fetcher ?? ((input, init) => fetch(input, init)),
      init: {
        method: "GET",
        headers,
        signal: options.signal,
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer"
      },
      label: "Scan admission recovery",
      maxBytes: SCAN_ADMISSION_RESPONSE_MAX_BYTES
    }
  );
  if (result.status === 404 && isRuntimeScanError(result.payload)) {
    return Object.freeze({ status: "not-found" });
  }
  if (isRuntimeScanError(result.payload)) throw scanRequestError(result.payload);
  if (result.status < 200 || result.status >= 300 || !isScanJobSubmissionResponse(result.payload)) {
    throw new Error("The retained scan admission could not be recovered.");
  }
  return Object.freeze({
    status: "accepted",
    job: {
      jobId: result.payload.jobId,
      statusPath: result.payload.statusPath,
      reportId: result.payload.reportId,
      accessKey
    }
  });
}

/**
 * A 404 is only a point-in-time answer while an outcome-unknown POST may still
 * be committing in the Durable Object. Retry the header-only lookup through
 * the server admission deadline plus margin, under the caller's abort signal.
 */
export async function recoverRuntimeScanAdmissionThroughCommitWindow(options: {
  credential: ScanAdmissionCredential;
  createdAt: number;
  accessKey?: string;
  signal?: AbortSignal;
  resolveApiUrl: (path: string) => string;
  fetcher?: RuntimeScanFetcher;
  now?: () => number;
  wait?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
}): Promise<RuntimeScanAdmissionRecovery> {
  if (!Number.isSafeInteger(options.createdAt) || options.createdAt < 0) {
    throw new Error("The retained scan admission has an invalid creation time.");
  }
  const now = options.now ?? Date.now;
  const wait = options.wait ?? waitForRuntimeScanRecovery;
  const deadline = options.createdAt + SCAN_ADMISSION_COMMIT_RECOVERY_WINDOW_MS;
  let attempt = 0;

  while (true) {
    const result = await recoverRuntimeScanAdmission(options);
    if (result.status === "accepted") return result;
    const remainingMs = deadline - now();
    if (remainingMs <= 0) return result;
    const backoffMs = SCAN_ADMISSION_RECOVERY_BACKOFF_MS[
      Math.min(attempt, SCAN_ADMISSION_RECOVERY_BACKOFF_MS.length - 1)
    ];
    attempt += 1;
    await wait(Math.min(backoffMs, remainingMs), options.signal);
  }
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
  if (!isRecoverableScanJob({
    jobId: options.job.jobId,
    statusPath: options.job.statusPath,
    reportId: options.job.reportId
  })) {
    throw new Error("The accepted scan recovery capability is invalid.");
  }
  const fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
  const headers: Record<string, string> = {};
  if (options.job.accessKey) headers.Authorization = `Bearer ${options.job.accessKey}`;

  let payload: unknown;
  let responseStatus: number;
  try {
    ({ status: responseStatus, payload } = await fetchRuntimeJsonWithPolicy(
      options.resolveApiUrl(options.job.statusPath),
      {
        fetcher,
        init: {
          method: "DELETE",
          cache: "no-store",
          headers,
          signal: options.signal,
          credentials: "omit",
          redirect: "error",
          referrerPolicy: "no-referrer"
        },
        label: "Scan cancellation",
        maxBytes: SCAN_CANCELLATION_RESPONSE_MAX_BYTES,
        connectTimeoutMs: options.timeoutMs ?? 10_000,
        operationTimeoutMs: options.timeoutMs ?? 10_000
      }
    ));
  } catch (error) {
    if (error instanceof ClientFetchTimeoutError) throw new Error("Scan cancellation timed out.");
    throw error;
  }
  if (responseStatus < 200 || responseStatus >= 300) {
    throw new Error(`The scan could not be cancelled (HTTP ${responseStatus}).`);
  }
  if (isRuntimeScanError(payload)) throw scanRequestError(payload);
  if (
    !isRecord(payload) ||
    payload.ok !== true ||
    payload.jobId !== options.job.jobId ||
    payload.status !== "cancelled"
  ) {
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

/**
 * The reader-facing text for a failed scan.
 *
 * This used to infer the cause by testing the server's message for substrings
 * in order, which is how "Durable scan admission must use the private
 * coordinator" became "That address can't be scanned... not localhost, private
 * networks" -- the product blaming a visitor's public URL for a server
 * misconfiguration. The cause is now declared by whoever throws and carried on
 * the wire; see lib/scan-failure-causes.ts.
 *
 * An undeclared cause returns the server's own words unchanged, with no added
 * instruction. That is deliberate: the unclassified case is exactly where the
 * old code guessed.
 */
export function friendlyScanError(error: unknown, openAccessScanner: boolean): string {
  const notice = scanFailureNoticeFor(error, openAccessScanner);
  return notice.action ? `${notice.message} ${notice.action}` : notice.message;
}

/** The structured notice, for surfaces that render the action separately. */
export function scanFailureNoticeFor(
  error: unknown,
  openAccessScanner: boolean
): ScanFailureNotice {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const cause = error instanceof ScanRequestError ? error.failureCause : undefined;
  return scanFailureText(cause, message, { openAccessScanner });
}

async function fetchRuntimeJsonWithPolicy(
  input: string,
  options: {
    fetcher: RuntimeScanFetcher;
    init: RequestInit;
    label: string;
    maxBytes: number;
    connectTimeoutMs?: number;
    operationTimeoutMs?: number;
  }
): Promise<{ status: number; payload: unknown }> {
  let status: number | null = null;
  const fetchImpl = (async (requestInput: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof requestInput === "string"
        ? requestInput
        : requestInput instanceof URL
          ? requestInput.href
          : requestInput.url;
    const response = await options.fetcher(url, init ?? {});
    status = response.status;
    if (response.ok) return response;
    // fetchJsonWithPolicy deliberately rejects HTTP errors before reading the
    // body. Admission needs the bounded JSON body to distinguish a definitive
    // public rejection from an outcome-unknown 5xx, so preserve the original
    // status out of band while the shared policy owns streaming and parsing.
    return new Response(response.body, {
      status: 200,
      headers: response.headers
    });
  }) as typeof fetch;
  const payload = await fetchJsonWithPolicy(input, options.init, {
    label: options.label,
    maxBytes: options.maxBytes,
    connectTimeoutMs: options.connectTimeoutMs,
    operationTimeoutMs: options.operationTimeoutMs,
    fetchImpl
  });
  if (status === null) throw new Error(`${options.label} returned no HTTP status.`);
  return { status, payload };
}

function isRuntimeScanError(
  value: unknown
): value is { ok: false; error: string; cause?: unknown } {
  return isRecord(value) && value.ok === false && typeof value.error === "string";
}

/**
 * A failed scan response, carrying the cause the SERVER declared.
 *
 * Without this the cause was parsed and thrown away, and the client re-derived
 * one by matching substrings of the message. Carrying it is what lets the
 * reader surface state a cause instead of guessing at one.
 */
export class ScanRequestError extends Error {
  constructor(
    message: string,
    readonly failureCause?: unknown
  ) {
    super(message);
    this.name = "ScanRequestError";
  }
}

function scanRequestError(payload: { error: string; cause?: unknown }): ScanRequestError {
  return new ScanRequestError(payload.error, payload.cause);
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

function waitForRuntimeScanRecovery(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("The request was cancelled.", "AbortError"));
      return;
    }
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, Math.max(1, delayMs));
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason ?? new DOMException("The request was cancelled.", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}
