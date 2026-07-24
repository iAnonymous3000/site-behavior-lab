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
  if (declaredLength !== null) {
    const parsed = Number(declaredLength);
    if (Number.isSafeInteger(parsed) && parsed > maxBytes) {
      // Never let a non-settling cancellation turn bounded rejection into an
      // unbounded wait. No stateful continuation depends on cleanup finishing.
      void response.body?.cancel().catch(() => undefined);
      throw new DurableScanJobInternalResponseTooLargeError(maxBytes);
    }
  }
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  const abort = signal ? abortGate(signal) : null;
  try {
    for (;;) {
      throwIfAborted(signal);
      const next = await (abort ? Promise.race([reader.read(), abort.promise]) : reader.read());
      if (next.done) break;
      totalBytes += next.value.byteLength;
      if (totalBytes > maxBytes) {
        void reader.cancel().catch(() => undefined);
        throw new DurableScanJobInternalResponseTooLargeError(maxBytes);
      }
      chunks.push(next.value);
    }
  } finally {
    abort?.dispose();
    if (signal?.aborted) void reader.cancel(abortReason(signal)).catch(() => undefined);
    try {
      reader.releaseLock();
    } catch {
      // A non-conforming stream may retain a pending read after cancellation;
      // no stateful work remains attached to that body.
    }
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
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
