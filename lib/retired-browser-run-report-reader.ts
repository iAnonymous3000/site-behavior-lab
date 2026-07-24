import { SERVER_STORED_REPORT_JSON_MAX_BYTES } from "./report-resource-limits";
import { parseStrictJson } from "./strict-json";

/**
 * Browser Run is retired as an active producer, but historical deployments can
 * still serve reports from their original R2 or KV bindings. Keep those reads
 * bounded by the same conservative ceiling as every current report consumer.
 */
export const RETIRED_BROWSER_RUN_REPORT_MAX_BYTES = SERVER_STORED_REPORT_JSON_MAX_BYTES;
export const RETIRED_BROWSER_RUN_REPORT_READ_TIMEOUT_MS = 10_000;
export const RETIRED_BROWSER_RUN_REPORT_MAX_CHUNKS = 8_192;

export class RetiredBrowserRunReportTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`The stored Browser Run report exceeded ${maxBytes} bytes.`);
    this.name = "RetiredBrowserRunReportTooLargeError";
  }
}

export class RetiredBrowserRunReportInvalidError extends Error {
  constructor(options?: ErrorOptions) {
    super("The stored Browser Run report is not valid JSON.", options);
    this.name = "RetiredBrowserRunReportInvalidError";
  }
}

export class RetiredBrowserRunReportTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`The stored Browser Run report read exceeded ${timeoutMs}ms.`);
    this.name = "RetiredBrowserRunReportTimeoutError";
  }
}

export class RetiredBrowserRunReportFragmentedError extends Error {
  constructor(readonly maxChunks: number) {
    super(`The stored Browser Run report exceeded ${maxChunks} stream chunks.`);
    this.name = "RetiredBrowserRunReportFragmentedError";
  }
}

export type RetiredBrowserRunReportReadOptions = Readonly<{
  /** R2 exposes the object's exact stored size. KV's legacy stream does not. */
  declaredBytes?: number | null;
  signal?: AbortSignal;
  /** Test seams; production callers deliberately use the fixed defaults. */
  maxBytes?: number;
  maxChunks?: number;
  timeoutMs?: number;
}>;

export type RetiredBrowserRunReportOperationOptions = Readonly<{
  signal?: AbortSignal;
  timeoutMs?: number;
}>;

/**
 * Put lookup and streaming under one explicit race. Storage APIs do not expose
 * portable cancellation, so abort is a cleanup signal only; the caller still
 * returns at the deadline if an implementation ignores it.
 */
export async function withRetiredBrowserRunReportDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  options: RetiredBrowserRunReportOperationOptions = {}
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? RETIRED_BROWSER_RUN_REPORT_READ_TIMEOUT_MS;
  assertPositiveSafeInteger(timeoutMs, "The stored Browser Run report timeout");
  options.signal?.throwIfAborted();

  const deadline = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, deadline.signal])
    : deadline.signal;
  const timer = setTimeout(
    () => deadline.abort(new RetiredBrowserRunReportTimeoutError(timeoutMs)),
    timeoutMs
  );
  const abort = abortGate(signal);
  const pending = Promise.resolve().then(() => operation(signal));
  // Observe a storage implementation that settles after losing the race.
  void pending.catch(() => undefined);

  try {
    return await Promise.race([pending, abort.promise]);
  } finally {
    clearTimeout(timer);
    abort.dispose();
  }
}

/**
 * Parse one historical Browser Run report without granting storage an
 * unbounded allocation. The declared size is only an early-rejection hint;
 * the stream is independently counted and read under a caller-aware deadline.
 */
export async function readRetiredBrowserRunReportJson<T>(
  body: ReadableStream<Uint8Array>,
  options: RetiredBrowserRunReportReadOptions = {}
): Promise<T> {
  const maxBytes = options.maxBytes ?? RETIRED_BROWSER_RUN_REPORT_MAX_BYTES;
  const maxChunks = options.maxChunks ?? RETIRED_BROWSER_RUN_REPORT_MAX_CHUNKS;
  const timeoutMs = options.timeoutMs ?? RETIRED_BROWSER_RUN_REPORT_READ_TIMEOUT_MS;
  assertPositiveSafeInteger(maxBytes, "The stored Browser Run report limit");
  assertPositiveSafeInteger(maxChunks, "The stored Browser Run report chunk limit");
  assertPositiveSafeInteger(timeoutMs, "The stored Browser Run report timeout");
  options.signal?.throwIfAborted();

  const deadline = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, deadline.signal])
    : deadline.signal;
  const timer = setTimeout(
    () => deadline.abort(new RetiredBrowserRunReportTimeoutError(timeoutMs)),
    timeoutMs
  );
  const abort = abortGate(signal);

  try {
    const declaredBytes = options.declaredBytes;
    if (declaredBytes !== undefined && declaredBytes !== null) {
      if (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0) {
        detachBodyCancellation(body, new RetiredBrowserRunReportInvalidError());
        throw new RetiredBrowserRunReportInvalidError();
      }
      if (declaredBytes > maxBytes) {
        detachBodyCancellation(body, new RetiredBrowserRunReportTooLargeError(maxBytes));
        throw new RetiredBrowserRunReportTooLargeError(maxBytes);
      }
    }

    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    let chunkCount = 0;
    try {
      for (;;) {
        signal.throwIfAborted();
        const pendingRead = reader.read();
        void pendingRead.catch(() => undefined);
        const next = await Promise.race([pendingRead, abort.promise]);
        if (next.done) break;
        if (!(next.value instanceof Uint8Array)) {
          throw new RetiredBrowserRunReportInvalidError();
        }
        chunkCount += 1;
        if (chunkCount > maxChunks) {
          throw new RetiredBrowserRunReportFragmentedError(maxChunks);
        }
        const nextTotal = totalBytes + next.value.byteLength;
        if (!Number.isSafeInteger(nextTotal) || nextTotal > maxBytes) {
          throw new RetiredBrowserRunReportTooLargeError(maxBytes);
        }
        totalBytes = nextTotal;
        if (next.value.byteLength > 0) chunks.push(next.value);
      }
    } catch (error) {
      detachReaderCancellation(reader, error);
      throw error;
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // A non-cooperative pending read may retain the lock. It has no caller
        // continuation after the explicit abort race has settled.
      }
    }

    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }

    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      return parseStrictJson(text) as T;
    } catch (error) {
      throw new RetiredBrowserRunReportInvalidError({ cause: error });
    }
  } finally {
    clearTimeout(timer);
    abort.dispose();
  }
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

function detachBodyCancellation(body: ReadableStream<Uint8Array>, reason: unknown): void {
  void body.cancel(reason).catch(() => undefined);
}

function detachReaderCancellation(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  reason: unknown
): void {
  void reader.cancel(reason).catch(() => undefined);
}

function assertPositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
}
