import type {
  DurableScanJobPreparation,
  DurableScanJobSubmission
} from "./durable-scan-job-contract";

export type DurableScanJobAdmissionOutcome =
  | { accepted: true; status: 202; submission: DurableScanJobSubmission }
  | { accepted: false; status: 503 };

export type DurableScanJobAdmissionProof = Readonly<{
  jobId: string;
  reportId: string;
  createdAt: number;
  totalRuns: 1 | 2;
}>;

export type DurableScanJobPumpWakeInput = Readonly<{
  storeWakeAt: number | null;
  publishingWakeAt: number | null;
  minimumWakeAt?: number;
}>;

export type DurableScanJobsFlagState = "disabled" | "enabled" | "misconfigured";

export type DurableScanJobNodeHealthState = Readonly<{
  requested: boolean;
  ready: boolean;
}>;

export const DURABLE_SCAN_JOB_ADMISSION_TIMEOUT_MS = 30_000;

export class DurableScanJobAdmissionTimeoutError extends Error {
  constructor() {
    super("Durable scan-job admission timed out with an unknown outcome.");
    this.name = "DurableScanJobAdmissionTimeoutError";
  }
}

/** Feature flags are an exact wire contract; whitespace is never normalized. */
export function durableScanJobsFlagState(value: string | undefined): DurableScanJobsFlagState {
  if (value === undefined || value === "" || value === "0") return "disabled";
  return value === "1" ? "enabled" : "misconfigured";
}

/** Read only the rollout fields the edge needs from the untrusted Node health wire. */
export function durableScanJobNodeHealthState(checks: unknown): DurableScanJobNodeHealthState {
  const durableJobs =
    checks && typeof checks === "object"
      ? (checks as Record<string, unknown>).durableJobs
      : undefined;
  if (!durableJobs || typeof durableJobs !== "object") return { requested: false, ready: false };
  const record = durableJobs as Record<string, unknown>;
  return {
    requested: record.requested === true,
    ready: record.requested === true && record.readiness === "node-ready"
  };
}

export function durablePumpReuseNeedsAlarmKick(scheduleTimeSeconds: number, nowMs: number): boolean {
  return (
    Number.isSafeInteger(scheduleTimeSeconds) &&
    scheduleTimeSeconds >= 0 &&
    Number.isSafeInteger(nowMs) &&
    nowMs >= 0 &&
    scheduleTimeSeconds * 1_000 <= nowMs
  );
}

/** Never let a reconciliation request keep encrypted job state past purge. */
export function durableReconciliationTimeoutMs(
  nowMs: number,
  purgeAtMs: number,
  maximumTimeoutMs = 30_000
): number {
  return Math.max(0, Math.min(maximumTimeoutMs, purgeAtMs - nowMs));
}

/** The Worker-only AES key must never alias the token forwarded into Node. */
export function durableScanJobSecretsAreDistinct(encryptionKey: string, internalToken: string): boolean {
  const key = encryptionKey.trim();
  const token = internalToken.trim();
  return key.length > 0 && token.length > 0 && key !== token;
}

/** No value forwarded into Node may reuse the Worker-only admission key. */
export function durableScanJobKeyIsIsolated(encryptionKey: string, forwardedSecrets: readonly string[]): boolean {
  const key = encryptionKey.trim();
  return key.length > 0 && forwardedSecrets.every((value) => !value.trim() || value.trim() !== key);
}

/**
 * Bound the complete body + Node-prepare + DO-commit admission operation. The
 * absolute deadline is also passed to the authoritative DO transaction; the
 * signal fences every edge continuation, while exact retries can still recover
 * work that demonstrably committed before the deadline.
 */
export async function withDurableScanJobAdmissionDeadline<T>(
  operation: (signal: AbortSignal, deadlineAt: number) => Promise<T>,
  options: Readonly<{ signal?: AbortSignal; timeoutMs?: number }> = {}
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DURABLE_SCAN_JOB_ADMISSION_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Invalid durable scan-job admission timeout.");
  }
  const deadlineAt = Date.now() + timeoutMs;
  if (!Number.isSafeInteger(deadlineAt)) {
    throw new Error("Invalid durable scan-job admission deadline.");
  }

  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) abortFromCaller();
  else options.signal?.addEventListener("abort", abortFromCaller, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new DurableScanJobAdmissionTimeoutError());
  }, timeoutMs);
  const aborted = new Promise<never>((_resolve, reject) => {
    const rejectAbort = () => reject(controller.signal.reason ?? new DOMException("The request was cancelled.", "AbortError"));
    if (controller.signal.aborted) rejectAbort();
    else controller.signal.addEventListener("abort", rejectAbort, { once: true });
  });

  try {
    return await Promise.race([operation(controller.signal, deadlineAt), aborted]);
  } catch (error) {
    if (timedOut) throw new DurableScanJobAdmissionTimeoutError();
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abortFromCaller);
  }
}

/**
 * Fence one admission step behind the shared operation signal. This remains
 * necessary even when an underlying Request carries that signal: a test
 * double or non-conforming transport can ignore it. A late preparation may
 * settle, but it has no continuation that can reach admission commit.
 */
export async function awaitDurableScanJobAdmissionStep<T>(
  operation: () => PromiseLike<T> | T,
  signal: AbortSignal
): Promise<T> {
  throwIfDurableScanJobAdmissionAborted(signal);
  const aborted = durableScanJobAdmissionAbortGate(signal);
  try {
    return await Promise.race([Promise.resolve().then(operation), aborted.promise]);
  } finally {
    aborted.dispose();
  }
}

export function throwIfDurableScanJobAdmissionAborted(signal: AbortSignal): void {
  if (signal.aborted) throw durableScanJobAdmissionAbortReason(signal);
}

/**
 * The sole public-acceptance boundary: a 202-shaped result is impossible until
 * the injected Durable Object commit (which also schedules the pump) resolves.
 */
export async function finalizeDurableScanJobAdmission(
  preparation: DurableScanJobPreparation,
  commit: (preparation: DurableScanJobPreparation) => Promise<unknown>,
  onFailure?: (error: unknown) => void,
  recoverCommitted?: (
    preparation: DurableScanJobPreparation,
    error: unknown
  ) => Promise<boolean | DurableScanJobSubmission | null>,
  isDefinitiveRejection?: (error: unknown, attempt: 1 | 2) => boolean,
  submissionFromCommit?: (
    committed: unknown,
    preparation: DurableScanJobPreparation
  ) => DurableScanJobSubmission | null,
  options: Readonly<{ signal?: AbortSignal }> = {}
): Promise<DurableScanJobAdmissionOutcome> {
  let finalError: unknown;
  // One bounded retry closes the commit-response-lost + transient-readback
  // window. The preparation carries the same random job/report capabilities;
  // the DO refuses a duplicate and the exact readback below distinguishes a
  // committed retry from capacity/collision or infrastructure failure.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (options.signal) throwIfDurableScanJobAdmissionAborted(options.signal);
    try {
      const committed = options.signal
        ? await awaitDurableScanJobAdmissionStep(() => commit(preparation), options.signal)
        : await commit(preparation);
      if (options.signal) throwIfDurableScanJobAdmissionAborted(options.signal);
      const submission = submissionFromCommit
        ? submissionFromCommit(committed, preparation)
        : preparation.submission;
      if (!submission) throw new Error("The durable admission commit returned no valid public submission.");
      return { accepted: true, status: 202, submission };
    } catch (error) {
      if (options.signal?.aborted) throw durableScanJobAdmissionAbortReason(options.signal);
      finalError = error;
    }
    // A typed refusal returned by the authoritative DO proves that this
    // attempt did not commit. In particular, quota rejection must not be
    // retried as a second admission attempt. Transport/store failures remain
    // outcome-unknown and still use exact readback plus one idempotent retry.
    if (isDefinitiveRejection?.(finalError, attempt === 0 ? 1 : 2)) {
      onFailure?.(finalError);
      return { accepted: false, status: 503 };
    }
    try {
      const recovered = recoverCommitted
        ? options.signal
          ? await awaitDurableScanJobAdmissionStep(
              () => recoverCommitted(preparation, finalError),
              options.signal
            )
          : await recoverCommitted(preparation, finalError)
        : null;
      if (options.signal) throwIfDurableScanJobAdmissionAborted(options.signal);
      if (recovered) {
        return {
          accepted: true,
          status: 202,
          submission: recovered === true ? preparation.submission : recovered
        };
      }
    } catch {
      if (options.signal?.aborted) throw durableScanJobAdmissionAbortReason(options.signal);
      // Retry the same capability once. A second failed exact readback remains
      // indistinguishable from no commit and must preserve the public 503.
    }
  }
  onFailure?.(finalError);
  return { accepted: false, status: 503 };
}

function durableScanJobAdmissionAbortGate(
  signal: AbortSignal
): { promise: Promise<never>; dispose(): void } {
  let onAbort: (() => void) | undefined;
  const promise = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(durableScanJobAdmissionAbortReason(signal));
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

function durableScanJobAdmissionAbortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The durable scan-job admission was aborted.", "AbortError");
}

export function durableScanJobAdmissionProofMatches(
  proof: DurableScanJobAdmissionProof | null,
  preparation: DurableScanJobPreparation
): boolean {
  if (!proof) return false;
  const totalRuns =
    preparation.payload.compareGpc ||
    preparation.payload.compareShields ||
    preparation.payload.compareConsent
      ? 2
      : 1;
  return (
    proof.jobId === preparation.submission.jobId &&
    proof.reportId === preparation.submission.reportId &&
    proof.createdAt === preparation.payload.admittedAt &&
    proof.totalRuns === totalRuns
  );
}

/** Keep independently classified hard/store and publishing recovery wakes. */
export function chooseDurableScanJobPumpWakeAt(input: DurableScanJobPumpWakeInput): number | null {
  const candidates = [input.storeWakeAt, input.publishingWakeAt, input.minimumWakeAt].filter(
    (value): value is number => value !== null && value !== undefined
  );
  return candidates.length > 0 ? Math.min(...candidates) : null;
}
