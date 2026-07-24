import type { DurableScanJobRegistration } from "./durable-scan-job-registry";
import { SERVER_STORED_REPORT_JSON_MAX_BYTES } from "./report-resource-limits";
import {
  DURABLE_SCAN_JOB_INTERNAL_RESPONSE_MAX_BYTES,
  readDurableScanJobInternalResponseBytes,
  readDurableScanJobInternalResponseJson
} from "./durable-scan-job-internal-response";
import { readStoredScanReport } from "./scan-report-reader";

export const DURABLE_SCAN_JOB_RECOVERY_REPORT_MAX_BYTES = SERVER_STORED_REPORT_JSON_MAX_BYTES;
export const DURABLE_SCAN_JOB_RECOVERY_ERROR_MAX_BYTES =
  DURABLE_SCAN_JOB_INTERNAL_RESPONSE_MAX_BYTES;
export const DURABLE_SCAN_JOB_RECOVERY_REPORT_TIMEOUT_MS = 30_000;

export class DurableScanJobRecoveryTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super("Durable scan-job report recovery timed out.");
    this.name = "DurableScanJobRecoveryTimeoutError";
  }
}

export class DurableScanJobRecoveryAbortedError extends Error {
  override readonly cause: unknown;

  constructor(cause?: unknown) {
    super("Durable scan-job report recovery was aborted.");
    this.name = "DurableScanJobRecoveryAbortedError";
    this.cause = cause;
  }
}

export type DurableScanJobInternalState =
  | "queued"
  | "leased"
  | "publishing"
  | "succeeded"
  | "failed"
  | "expired"
  | "cancelled";

export type DurableScanJobRecoverySnapshot = Readonly<{
  jobId: string;
  reportId: string;
  state: DurableScanJobInternalState;
  totalRuns: number;
}>;

type SnapshotRecoveryDependencies = {
  fetchReport: (reportId: string, signal: AbortSignal) => Promise<Response>;
  signal?: AbortSignal;
  operationTimeoutMs?: number;
  onReportError?: (error: unknown) => void;
  // Emitted only by the separately attested, token-gated staging fault hook.
  // Production callers never provide it, preserving the public status wire.
  stagingFaultEvidence?: {
    faultMode: "lease-expiry" | "lost-resolve";
    attempts: number;
    triggered: boolean;
    triggeredGeneration: number | null;
    finishedBeforeStatusRequest: boolean;
  };
};

type RecoveryDependencies = {
  findRegistration: (
    jobId: string,
    signal: AbortSignal
  ) => Promise<DurableScanJobRegistration | null>;
  fetchReport: (reportId: string, signal: AbortSignal) => Promise<Response>;
  signal?: AbortSignal;
  operationTimeoutMs?: number;
  onRegistryError?: (error: unknown) => void;
  onReportError?: (error: unknown) => void;
};

type CancellationRecoveryDependencies = {
  findRegistration: (
    jobId: string,
    signal: AbortSignal
  ) => Promise<DurableScanJobRegistration | null>;
  signal?: AbortSignal;
  operationTimeoutMs?: number;
  onRegistryError?: (error: unknown) => void;
};

/** Collapse the internal lease/publication vocabulary onto the public API. */
export function publicDurableScanJobStatus(state: DurableScanJobInternalState):
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "expired"
  | "cancelled" {
  if (state === "leased" || state === "publishing") return "running";
  return state;
}

/**
 * Render the Durable Object's authoritative Phase-2 status. Lease credentials,
 * manifests, report capabilities, and ciphertext never cross this boundary.
 * Production also omits attempts; the separately attested staging replay hook
 * may add bounded attempt/fault evidence for its two operator canaries. A
 * succeeded status is returned only with the exact saved report.
 */
export async function recoverDurableScanJobSnapshotResponse(
  snapshot: DurableScanJobRecoverySnapshot,
  source: Response,
  dependencies: SnapshotRecoveryDependencies
): Promise<Response> {
  const status = publicDurableScanJobStatus(snapshot.state);
  const totalRuns = snapshot.totalRuns === 2 ? 2 : 1;
  const progress =
    snapshot.state === "queued"
      ? { phase: "queued", completedRuns: 0, totalRuns }
      : snapshot.state === "publishing" || snapshot.state === "succeeded"
        ? { phase: "saving", completedRuns: totalRuns, totalRuns }
        : { phase: "waiting", completedRuns: 0, totalRuns };

  if (snapshot.state === "succeeded") {
    let recovered: BoundedRecoveryReport;
    try {
      recovered = await fetchBoundedRecoveryReport(snapshot.reportId, dependencies);
    } catch (error) {
      dependencies.onReportError?.(error);
      const status = isDurableRecoveryUnavailable(error) ? 503 : 502;
      return recoveryJson(
        { ok: false, error: "The saved scan report could not be read during durable recovery." },
        source,
        status
      );
    }
    const { report } = recovered;
    if (recovered.status === 404) {
      return recoveryJson(
        { ok: false, error: "The saved scan report is temporarily unavailable during durable recovery." },
        source,
        502
      );
    }
    if (!recovered.ok) {
      return sanitizedRecoveryReportFailure(
        recovered,
        source,
        "The saved scan report is temporarily unavailable during durable recovery."
      );
    }
    if (!readStoredScanReport(report).ok) {
      return recoveryJson(
        { ok: false, error: "The saved scan report was invalid during durable recovery." },
        source,
        502
      );
    }
    return recoveryJson(
      withStagingFaultEvidence(
        { ok: true, jobId: snapshot.jobId, status, progress, report },
        dependencies.stagingFaultEvidence
      ),
      source
    );
  }

  const payload: Record<string, unknown> = { ok: true, jobId: snapshot.jobId, status, progress };
  if (snapshot.state === "failed") payload.error = "This scan job could not be completed.";
  if (snapshot.state === "expired") {
    payload.error = "This scan job expired because durable completion could not be confirmed.";
  }
  if (snapshot.state === "cancelled") payload.error = "This scan job was cancelled.";
  return recoveryJson(withStagingFaultEvidence(payload, dependencies.stagingFaultEvidence), source);
}

function withStagingFaultEvidence(
  payload: Record<string, unknown>,
  evidence: SnapshotRecoveryDependencies["stagingFaultEvidence"]
): Record<string, unknown> {
  if (!evidence) return payload;
  return {
    ...payload,
    durable: {
      faultMode: evidence.faultMode,
      attempts: evidence.attempts,
      triggered: evidence.triggered,
      triggeredGeneration: evidence.triggeredGeneration,
      finishedBeforeStatusRequest: evidence.finishedBeforeStatusRequest
    }
  };
}

/** Idempotent, control-only response after the DO has atomically cancelled. */
export function durableScanJobCancellationResponse(
  snapshot: DurableScanJobRecoverySnapshot,
  source: Response
): Response {
  return recoveryJson(
    {
      ok: true,
      jobId: snapshot.jobId,
      status: "cancelled",
      progress: { phase: "waiting", completedRuns: 0, totalRuns: snapshot.totalRuns === 2 ? 2 : 1 },
      error: "This scan job was cancelled."
    },
    source
  );
}

/**
 * Turn an in-memory 404 into an evidence-backed terminal answer when the edge
 * registry still knows the job. Only a genuine saved-report 404 can produce
 * `expired`; every probe/storage fault stays retryable and never fabricates a
 * terminal outcome.
 */
export async function recoverDurableScanJobResponse(
  jobId: string,
  missingJobResponse: Response,
  dependencies: RecoveryDependencies
): Promise<Response> {
  let stage: "registry" | "report" = "registry";
  let recovery:
    | Readonly<{ registration: null }>
    | Readonly<{ registration: DurableScanJobRegistration; recovered: BoundedRecoveryReport }>;
  try {
    recovery = await withDurableRecoveryDeadline(
      async (signal) => {
        const registration = await awaitDurableRecoveryStep(
          () => dependencies.findRegistration(jobId, signal),
          signal
        );
        if (!registration) return { registration: null };
        stage = "report";
        const recovered = await fetchBoundedRecoveryReportUnderSignal(
          registration.reportId,
          dependencies.fetchReport,
          signal
        );
        return { registration, recovered };
      },
      { signal: dependencies.signal, timeoutMs: dependencies.operationTimeoutMs }
    );
  } catch (error) {
    if (stage === "registry") {
      dependencies.onRegistryError?.(error);
      return missingJobResponse;
    }
    dependencies.onReportError?.(error);
    return isDurableRecoveryUnavailable(error)
      ? missingJobResponse
      : recoveryJson(
          { ok: false, error: "The saved scan report could not be read during restart recovery." },
          missingJobResponse,
          502
        );
  }
  if (!recovery.registration) return missingJobResponse;
  const { registration, recovered } = recovery;
  const { report } = recovered;

  if (recovered.status === 404) {
    return recoveryJson(
      {
        ok: true,
        jobId,
        status: "expired",
        error:
          "The scanner lost this job's in-memory status, and no saved report is available, so the job can no longer be recovered."
      },
      missingJobResponse
    );
  }
  if (!recovered.ok) {
    return sanitizedRecoveryReportFailure(
      recovered,
      missingJobResponse,
      "The saved scan report is temporarily unavailable during restart recovery."
    );
  }

  // Saved-report recovery crosses the same version-aware public-wire boundary
  // as every other reader. r2 reports intentionally have no root `ok`, so a
  // transport-era truthiness check would turn valid recovered jobs into 502s.
  // Validate canonically, then return the parsed wire itself without projecting
  // or rewriting it so recovery preserves the exact persisted payload.
  if (!readStoredScanReport(report).ok) {
    return recoveryJson(
      { ok: false, error: "The saved scan report was invalid during restart recovery." },
      missingJobResponse,
      502
    );
  }

  return recoveryJson(
    {
      ok: true,
      jobId,
      status: "succeeded",
      progress: { phase: "saving", completedRuns: registration.totalRuns, totalRuns: registration.totalRuns },
      report
    },
    missingJobResponse
  );
}

/**
 * A lost in-memory job has no worker or AbortController left to cancel. Keep
 * DELETE a control-only response: never attach the report recovered for GET.
 */
export async function recoverDurableScanJobCancellationResponse(
  jobId: string,
  missingJobResponse: Response,
  dependencies: CancellationRecoveryDependencies
): Promise<Response> {
  let registration: DurableScanJobRegistration | null;
  try {
    registration = await withDurableRecoveryDeadline(
      (signal) =>
        awaitDurableRecoveryStep(
          () => dependencies.findRegistration(jobId, signal),
          signal
        ),
      { signal: dependencies.signal, timeoutMs: dependencies.operationTimeoutMs }
    );
  } catch (error) {
    dependencies.onRegistryError?.(error);
    return missingJobResponse;
  }
  if (!registration) return missingJobResponse;

  return recoveryJson(
    {
      ok: false,
      error: "This scan job can no longer be cancelled because its in-memory status was lost."
    },
    missingJobResponse,
    409
  );
}

type BoundedRecoveryReport = Readonly<{
  status: number;
  ok: boolean;
  retryAfter: string | null;
  report?: unknown;
}>;

class DurableScanJobRecoveryFetchError extends Error {
  override readonly cause: unknown;

  constructor(cause: unknown) {
    super("The saved report could not be fetched during durable recovery.");
    this.name = "DurableScanJobRecoveryFetchError";
    this.cause = cause;
  }
}

/**
 * One deadline covers time-to-headers and the decompressed bounded body. The
 * injected fetch receives the same composed signal, while the explicit abort
 * race protects against transports and test doubles that ignore it.
 */
async function fetchBoundedRecoveryReport(
  reportId: string,
  dependencies: Pick<
    SnapshotRecoveryDependencies,
    "fetchReport" | "signal" | "operationTimeoutMs"
  >
): Promise<BoundedRecoveryReport> {
  return withDurableRecoveryDeadline(
    (signal) => fetchBoundedRecoveryReportUnderSignal(reportId, dependencies.fetchReport, signal),
    {
      signal: dependencies.signal,
      timeoutMs: dependencies.operationTimeoutMs
    }
  );
}

async function fetchBoundedRecoveryReportUnderSignal(
  reportId: string,
  fetchReport: (reportId: string, signal: AbortSignal) => Promise<Response>,
  signal: AbortSignal
): Promise<BoundedRecoveryReport> {
  let response: Response;
  try {
    response = await awaitDurableRecoveryStep(
      () => fetchReport(reportId, signal),
      signal
    );
  } catch (error) {
    if (signal.aborted) throw durableRecoveryAbortReason(signal);
    throw new DurableScanJobRecoveryFetchError(error);
  }

  const retryAfter = sanitizedRetryAfter(response.headers.get("retry-after"));
  if (!response.ok) {
    // A non-success status is still an untrusted internal response. Consume it
    // under the same operation signal and a small cap before making any public
    // status decision; the raw body and headers never cross the edge boundary.
    await readDurableScanJobInternalResponseBytes(
      response,
      signal,
      DURABLE_SCAN_JOB_RECOVERY_ERROR_MAX_BYTES
    );
    throwIfDurableRecoveryAborted(signal);
    return { status: response.status, ok: false, retryAfter };
  }

  const report = await readDurableScanJobInternalResponseJson(
    response,
    signal,
    DURABLE_SCAN_JOB_RECOVERY_REPORT_MAX_BYTES
  );
  throwIfDurableRecoveryAborted(signal);
  return { status: response.status, ok: true, retryAfter, report };
}

async function withDurableRecoveryDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  options: Readonly<{ signal?: AbortSignal; timeoutMs?: number }>
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DURABLE_SCAN_JOB_RECOVERY_REPORT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("The durable recovery timeout must be a positive integer.");
  }

  const controller = new AbortController();
  const abortFromCaller = () => {
    if (!controller.signal.aborted) {
      controller.abort(new DurableScanJobRecoveryAbortedError(options.signal?.reason));
    }
  };
  if (options.signal?.aborted) abortFromCaller();
  else options.signal?.addEventListener("abort", abortFromCaller, { once: true });
  const timer = setTimeout(
    () => controller.abort(new DurableScanJobRecoveryTimeoutError(timeoutMs)),
    timeoutMs
  );
  const aborted = durableRecoveryAbortGate(controller.signal);
  try {
    throwIfDurableRecoveryAborted(controller.signal);
    return await Promise.race([operation(controller.signal), aborted.promise]);
  } finally {
    clearTimeout(timer);
    aborted.dispose();
    options.signal?.removeEventListener("abort", abortFromCaller);
  }
}

async function awaitDurableRecoveryStep<T>(
  operation: () => PromiseLike<T> | T,
  signal: AbortSignal
): Promise<T> {
  throwIfDurableRecoveryAborted(signal);
  const aborted = durableRecoveryAbortGate(signal);
  try {
    return await Promise.race([Promise.resolve().then(operation), aborted.promise]);
  } finally {
    aborted.dispose();
  }
}

function durableRecoveryAbortGate(
  signal: AbortSignal
): { promise: Promise<never>; dispose(): void } {
  let onAbort: (() => void) | undefined;
  const promise = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(durableRecoveryAbortReason(signal));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  void promise.catch(() => undefined);
  return {
    promise,
    dispose() {
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
  };
}

function throwIfDurableRecoveryAborted(signal: AbortSignal): void {
  if (signal.aborted) throw durableRecoveryAbortReason(signal);
}

function durableRecoveryAbortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DurableScanJobRecoveryAbortedError();
}

function isDurableRecoveryUnavailable(error: unknown): boolean {
  return (
    error instanceof DurableScanJobRecoveryTimeoutError ||
    error instanceof DurableScanJobRecoveryAbortedError ||
    error instanceof DurableScanJobRecoveryFetchError
  );
}

function sanitizedRecoveryReportFailure(
  recovered: BoundedRecoveryReport,
  source: Response,
  message: string
): Response {
  const status = recovered.status >= 400 && recovered.status <= 599 ? recovered.status : 502;
  const response = recoveryJson({ ok: false, error: message }, source, status);
  if (
    recovered.retryAfter !== null &&
    (status === 429 || status === 503)
  ) {
    response.headers.set("retry-after", recovered.retryAfter);
  }
  return response;
}

function sanitizedRetryAfter(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return /^\d{1,10}$/.test(trimmed) ? trimmed : null;
}

function recoveryJson(payload: unknown, source: Response, status = 200): Response {
  const headers = new Headers(source.headers);
  headers.delete("content-length");
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(payload), { status, headers });
}
