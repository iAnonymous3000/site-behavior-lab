/**
 * A container response is an external stream, even though it is reached through
 * a platform binding. Bound the complete exchange (dispatch, headers, and body)
 * and never await cancellation from a non-cooperative implementation.
 */
export const CONTAINER_FORWARD_OPERATION_TIMEOUT_MS = 180_000;
export const CONTAINER_FORWARD_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

export class ContainerForwardTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Container forwarding exceeded its ${timeoutMs}ms whole-operation deadline.`);
    this.name = "ContainerForwardTimeoutError";
  }
}

export class ContainerForwardResponseTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Container response exceeded the ${maxBytes}-byte forwarding limit.`);
    this.name = "ContainerForwardResponseTooLargeError";
  }
}

export type ContainerForwardDeadlineOptions = Readonly<{
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes?: number;
}>;

/**
 * Return a streaming response whose source remains under the same deadline that
 * covered dispatch. A stalled fetch/read loses an explicit race; abort and
 * stream cancellation are cleanup signals only and are deliberately detached.
 */
export async function forwardContainerResponseWithinDeadline(
  dispatch: (signal: AbortSignal) => Promise<Response>,
  options: ContainerForwardDeadlineOptions = {}
): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? CONTAINER_FORWARD_OPERATION_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? CONTAINER_FORWARD_MAX_RESPONSE_BYTES;
  assertPositiveSafeInteger(timeoutMs, "Container forwarding timeout");
  assertPositiveSafeInteger(maxBytes, "Container forwarding byte limit");
  options.signal?.throwIfAborted();

  const deadlineController = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, deadlineController.signal])
    : deadlineController.signal;
  let timeout: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    deadlineController.abort(new ContainerForwardTimeoutError(timeoutMs));
  }, timeoutMs);
  const abortGate = abortPromise(signal);
  const dispatchPromise = Promise.resolve().then(() => dispatch(signal));
  // Promise.race installs rejection observers, but keep this explicit: a custom
  // container double may reject long after its deadline and must never surface
  // as an unhandled rejection.
  void dispatchPromise.catch(() => undefined);

  let response: Response;
  try {
    response = await Promise.race([dispatchPromise, abortGate.promise]);
  } catch (error) {
    clearDeadline();
    abortGate.dispose();
    throw error;
  }

  // A HEAD response can truthfully describe a large GET representation while
  // carrying no body of its own. Only enforce representation bytes when a body
  // is actually present.
  if (!response.body) {
    clearDeadline();
    abortGate.dispose();
    return response;
  }

  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && /^\d+$/.test(declaredLength.trim())) {
    const declaredBytes = Number(declaredLength);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes > maxBytes) {
      deadlineController.abort(new ContainerForwardResponseTooLargeError(maxBytes));
      detachBodyCancellation(response.body, signal.reason);
      clearDeadline();
      abortGate.dispose();
      throw new ContainerForwardResponseTooLargeError(maxBytes);
    }
  }

  const reader = response.body.getReader();
  let totalBytes = 0;
  let finished = false;
  const finish = (reason?: unknown) => {
    if (finished) return;
    finished = true;
    if (!deadlineController.signal.aborted && reason !== undefined) {
      deadlineController.abort(reason);
    }
    clearDeadline();
    abortGate.dispose();
    try {
      reader.releaseLock();
    } catch {
      // A pending non-cooperative read may retain the lock. It has no consumer
      // continuation after the explicit abort race has settled.
    }
  };
  const onAbort = () => {
    detachReaderCancellation(reader, signal.reason);
  };
  signal.addEventListener("abort", onAbort, { once: true });

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await Promise.race([reader.read(), abortGate.promise]);
        if (next.done) {
          signal.removeEventListener("abort", onAbort);
          finish();
          controller.close();
          return;
        }
        if (!(next.value instanceof Uint8Array)) {
          throw new TypeError("Container response returned a non-byte stream chunk.");
        }
        const nextTotal = totalBytes + next.value.byteLength;
        if (!Number.isSafeInteger(nextTotal) || nextTotal > maxBytes) {
          throw new ContainerForwardResponseTooLargeError(maxBytes);
        }
        totalBytes = nextTotal;
        controller.enqueue(next.value);
      } catch (error) {
        signal.removeEventListener("abort", onAbort);
        detachReaderCancellation(reader, error);
        finish(error);
        controller.error(error);
      }
    },
    cancel(reason) {
      signal.removeEventListener("abort", onAbort);
      detachReaderCancellation(reader, reason);
      finish(reason ?? new DOMException("Container response consumer cancelled.", "AbortError"));
    }
  });

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  });

  function clearDeadline(): void {
    if (timeout === null) return;
    clearTimeout(timeout);
    timeout = null;
  }
}

function abortPromise(signal: AbortSignal): { promise: Promise<never>; dispose(): void } {
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

function detachBodyCancellation(body: ReadableStream<Uint8Array> | null, reason: unknown): void {
  if (!body) return;
  void body.cancel(reason).catch(() => undefined);
}

function detachReaderCancellation(reader: ReadableStreamDefaultReader<Uint8Array>, reason: unknown): void {
  void reader.cancel(reason).catch(() => undefined);
}

function assertPositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
}
