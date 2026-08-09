import { parseStrictJson } from "./strict-json";

export const DURABLE_SCAN_JOB_INTERNAL_RESPONSE_MAX_BYTES = 64 * 1024;

export class DurableScanJobInternalResponseTooLargeError extends Error {
  constructor(public readonly maxBytes: number) {
    super(`The durable scan-job internal response exceeded ${maxBytes} bytes.`);
    this.name = "DurableScanJobInternalResponseTooLargeError";
  }
}

export class DurableScanJobInternalResponseInvalidUtf8Error extends Error {
  constructor() {
    super("The durable scan-job internal response was not valid UTF-8.");
    this.name = "DurableScanJobInternalResponseInvalidUtf8Error";
  }
}

/** Read one trusted internal response without granting it an unbounded body. */
export async function readDurableScanJobInternalResponseBytes(
  response: Response,
  signal?: AbortSignal,
  maxBytes = DURABLE_SCAN_JOB_INTERNAL_RESPONSE_MAX_BYTES
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new TypeError("The durable scan-job internal response limit must be a positive integer.");
  }
  throwIfAborted(signal);

  const declaredLength = response.headers.get("content-length");
  const contentEncoding = response.headers.get("content-encoding");
  // Fetch exposes decoded body bytes but may retain the compressed wire
  // Content-Length. Only identity responses can use that header as an early
  // decoded-size refusal; the streamed decoded cap remains authoritative.
  const declaredLengthDescribesBody =
    contentEncoding === null || contentEncoding.trim().toLowerCase() === "identity";
  let expectedLength: number | null = null;
  if (declaredLength !== null && declaredLengthDescribesBody) {
    if (!/^[0-9]+$/.test(declaredLength)) {
      cancelResponseBodyDetached(response.body);
      throw new Error("The durable scan-job internal response returned an invalid Content-Length.");
    }
    const parsed = Number(declaredLength);
    if (!Number.isSafeInteger(parsed) || parsed > maxBytes) {
      // Never let a non-settling cancellation turn bounded rejection into an
      // unbounded wait. No stateful continuation depends on cleanup finishing.
      cancelResponseBodyDetached(response.body);
      throw new DurableScanJobInternalResponseTooLargeError(maxBytes);
    }
    expectedLength = parsed;
  }
  if (!response.body) {
    if (expectedLength !== null && expectedLength !== 0) {
      throw new Error("The durable scan-job internal response length did not match Content-Length.");
    }
    return new Uint8Array();
  }

  const reader = response.body.getReader();
  // Retain one geometrically grown buffer so empty and tiny chunks cannot
  // create per-chunk metadata, while a small response does not eagerly reserve
  // the caller's entire (up to report-sized) byte ceiling.
  let bytes = new Uint8Array(Math.min(maxBytes, 64 * 1024));
  let totalBytes = 0;
  const abort = signal ? abortGate(signal) : null;
  try {
    for (;;) {
      throwIfAborted(signal);
      const next = await (abort ? Promise.race([reader.read(), abort.promise]) : reader.read());
      if (next.done) break;
      if (next.value.byteLength === 0) continue;
      if (next.value.byteLength > maxBytes - totalBytes) {
        cancelResponseReaderDetached(reader);
        throw new DurableScanJobInternalResponseTooLargeError(maxBytes);
      }
      const requiredBytes = totalBytes + next.value.byteLength;
      if (requiredBytes > bytes.byteLength) {
        bytes = growResponseBuffer(bytes, requiredBytes, maxBytes);
      }
      bytes.set(next.value, totalBytes);
      totalBytes += next.value.byteLength;
    }
  } finally {
    abort?.dispose();
    if (signal?.aborted) {
      cancelResponseReaderDetached(reader, abortReason(signal));
    }
    try {
      reader.releaseLock();
    } catch {
      // A non-conforming stream may retain a pending read after cancellation;
      // no stateful work remains attached to that body.
    }
  }

  if (expectedLength !== null && totalBytes !== expectedLength) {
    throw new Error("The durable scan-job internal response length did not match Content-Length.");
  }
  return bytes.slice(0, totalBytes);
}

function growResponseBuffer(
  current: Uint8Array<ArrayBuffer>,
  requiredBytes: number,
  maxBytes: number
): Uint8Array<ArrayBuffer> {
  let nextCapacity = current.byteLength;
  while (nextCapacity < requiredBytes) {
    nextCapacity = Math.min(maxBytes, Math.max(requiredBytes, nextCapacity * 2));
  }
  const grown = new Uint8Array(nextCapacity);
  grown.set(current);
  return grown;
}

function cancelResponseBodyDetached(
  body: ReadableStream<Uint8Array> | null
): void {
  try {
    observeDetachedCancellation(body?.cancel());
  } catch {
    // The declared-size refusal remains authoritative if cleanup throws.
  }
}

function cancelResponseReaderDetached(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  reason?: unknown
): void {
  try {
    observeDetachedCancellation(reader.cancel(reason));
  } catch {
    // The size/abort verdict remains authoritative if cleanup throws.
  }
}

function observeDetachedCancellation(
  cancellation: Promise<void> | undefined
): void {
  void cancellation?.catch(() => undefined);
}

export async function readDurableScanJobInternalResponseJson(
  response: Response,
  signal?: AbortSignal,
  maxBytes = DURABLE_SCAN_JOB_INTERNAL_RESPONSE_MAX_BYTES
): Promise<unknown> {
  const bytes = await readDurableScanJobInternalResponseBytes(response, signal, maxBytes);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new DurableScanJobInternalResponseInvalidUtf8Error();
  }
  // A compromised or version-skewed internal peer must not be able to make
  // separate validators observe different meanings for duplicate keys.
  return parseStrictJson(text, bytes.byteLength);
}

function abortGate(signal: AbortSignal): { promise: Promise<never>; dispose(): void } {
  let onAbort: (() => void) | undefined;
  const promise = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(abortReason(signal));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  return {
    promise,
    dispose() {
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
  };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The durable scan-job internal response was aborted.", "AbortError");
}
