export const SCANNER_OPERATION_TIMEOUT_MS = 15_000;
export const SCANNER_CLEANUP_TIMEOUT_MS = 2_000;

export class ScannerOperationTimeoutError extends Error {
  constructor(
    readonly label: string,
    readonly timeoutMs: number
  ) {
    super(`${label} exceeded its ${timeoutMs}ms deadline.`);
    this.name = "ScannerOperationTimeoutError";
  }
}

export type ScannerOperationDeadlineOptions<T> = Readonly<{
  label: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  createTimeoutError?: () => Error;
  /** Dispose a resource that materializes after its caller already timed out. */
  onLateSuccess?: (value: T) => void | PromiseLike<void>;
}>;

/**
 * Bound operations whose underlying library may ignore cancellation. The
 * explicit race determines caller progress; late settlement is observed, and
 * a late resource can be disposed without re-entering the timed-out caller.
 */
export async function withScannerOperationDeadline<T>(
  operation: (signal: AbortSignal) => PromiseLike<T> | T,
  options: ScannerOperationDeadlineOptions<T>
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? SCANNER_OPERATION_TIMEOUT_MS;
  assertPositiveSafeInteger(timeoutMs, "The scanner operation timeout");
  options.signal?.throwIfAborted();

  const deadline = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, deadline.signal])
    : deadline.signal;
  const timer = setTimeout(() => {
    let reason: Error;
    try {
      reason = options.createTimeoutError?.() ??
        new ScannerOperationTimeoutError(options.label, timeoutMs);
    } catch {
      reason = new ScannerOperationTimeoutError(options.label, timeoutMs);
    }
    deadline.abort(reason);
  }, timeoutMs);
  const abort = abortGate(signal);
  let callerFinished = false;
  const pending = Promise.resolve().then(() => operation(signal));
  void pending.then(
    (value) => {
      if ((!callerFinished && !signal.aborted) || !options.onLateSuccess) return;
      try {
        void Promise.resolve(options.onLateSuccess(value)).catch(() => undefined);
      } catch {
        // Late disposal is best-effort and detached from the original caller.
      }
    },
    () => undefined
  );

  try {
    return await Promise.race([pending, abort.promise]);
  } catch (error) {
    callerFinished = true;
    throw error;
  } finally {
    clearTimeout(timer);
    abort.dispose();
  }
}

export type ScannerCleanupOperation = Readonly<{
  label: string;
  run: () => PromiseLike<unknown> | unknown;
}>;

/** Run independent cleanup concurrently and never let one stalled close hang a scan response. */
export async function runScannerCleanupWithinDeadline(
  operations: readonly ScannerCleanupOperation[],
  timeoutMs = SCANNER_CLEANUP_TIMEOUT_MS
): Promise<void> {
  assertPositiveSafeInteger(timeoutMs, "The scanner cleanup timeout");
  await Promise.allSettled(
    operations.map((operation) =>
      withScannerOperationDeadline(
        () => operation.run(),
        { label: operation.label, timeoutMs }
      )
    )
  );
}

function abortGate(signal: AbortSignal): { promise: Promise<never>; dispose(): void } {
  let listener: (() => void) | null = null;
  const promise = new Promise<never>((_resolve, reject) => {
    const rejectFromSignal = () => reject(signal.reason ?? new DOMException("Aborted.", "AbortError"));
    if (signal.aborted) {
      rejectFromSignal();
      return;
    }
    listener = rejectFromSignal;
    signal.addEventListener("abort", rejectFromSignal, { once: true });
  });
  return {
    promise,
    dispose() {
      if (listener) signal.removeEventListener("abort", listener);
      listener = null;
    }
  };
}

function assertPositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
}
