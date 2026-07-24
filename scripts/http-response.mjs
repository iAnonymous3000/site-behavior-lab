import { parseStrictJson } from "../lib/strict-json.ts";

const textDecoder = new TextDecoder("utf-8", { fatal: true });

/**
 * Run a complete first-party HTTP operation (headers plus the consumed body)
 * under one deadline. The callback must read or cancel the response before it
 * returns; returning a live Response would move body I/O outside the deadline.
 */
export async function withHttpOperationDeadline(
  { timeoutMs, label, signal: callerSignal },
  operation
) {
  assertPositiveSafeInteger(timeoutMs, "HTTP operation timeout");
  if (typeof label !== "string" || label.trim() === "") {
    throw new TypeError("HTTP operation label must be a non-empty string.");
  }
  if (typeof operation !== "function") {
    throw new TypeError("HTTP operation callback must be a function.");
  }

  const deadlineController = new AbortController();
  const timeout = setTimeout(() => {
    deadlineController.abort(
      new DOMException(`${label} exceeded its ${timeoutMs}ms whole-operation deadline.`, "TimeoutError")
    );
  }, timeoutMs);
  const signal = callerSignal
    ? AbortSignal.any([callerSignal, deadlineController.signal])
    : deadlineController.signal;

  let removeAbortListener = () => undefined;
  const aborted = new Promise((_, reject) => {
    const rejectWithReason = () => {
      reject(
        signal.reason ??
          new DOMException(`${label} was aborted before the HTTP operation completed.`, "AbortError")
      );
    };
    if (signal.aborted) {
      rejectWithReason();
      return;
    }
    signal.addEventListener("abort", rejectWithReason, { once: true });
    removeAbortListener = () => signal.removeEventListener("abort", rejectWithReason);
  });

  // Start through a promise boundary so an already-aborted caller cannot enter
  // the operation. Promise.race installs rejection observers on both branches:
  // a callback that ignores AbortSignal may settle later, but it cannot retain
  // this caller or surface an unhandled rejection after the hard deadline wins.
  const operationResult = Promise.resolve().then(() => {
    signal.throwIfAborted();
    return operation(signal);
  });

  try {
    return await Promise.race([operationResult, aborted]);
  } finally {
    clearTimeout(timeout);
    removeAbortListener();
  }
}

/** Count decompressed response bytes while streaming; never buffer past maxBytes. */
export async function readResponseBytesWithinLimit(response, { maxBytes, label }) {
  assertResponse(response);
  assertPositiveSafeInteger(maxBytes, "Response byte limit");
  if (typeof label !== "string" || label.trim() === "") {
    throw new TypeError("Response label must be a non-empty string.");
  }

  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && /^\d+$/.test(declaredLength.trim())) {
    const declaredBytes = Number(declaredLength);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes > maxBytes) {
      cancelBodyDetached(response);
      throw new RangeError(`${label} exceeds the ${maxBytes}-byte response limit.`);
    }
  }

  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  let bytes = new Uint8Array(0);
  let totalBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        throw new TypeError(`${label} returned a non-byte response stream.`);
      }
      const nextTotal = totalBytes + value.byteLength;
      if (!Number.isSafeInteger(nextTotal) || nextTotal > maxBytes) {
        cancelReaderDetached(reader);
        throw new RangeError(`${label} exceeds the ${maxBytes}-byte response limit.`);
      }
      if (bytes.byteLength < nextTotal) {
        const doubledCapacity =
          bytes.byteLength === 0
            ? Math.min(1024, maxBytes)
            : bytes.byteLength > Math.floor(maxBytes / 2)
              ? maxBytes
              : bytes.byteLength * 2;
        const nextCapacity = Math.max(nextTotal, doubledCapacity);
        const grown = new Uint8Array(nextCapacity);
        grown.set(bytes.subarray(0, totalBytes));
        bytes = grown;
      }
      bytes.set(value, totalBytes);
      totalBytes = nextTotal;
    }
  } finally {
    reader.releaseLock();
  }
  return bytes.slice(0, totalBytes);
}

export async function readResponseTextWithinLimit(response, options) {
  return textDecoder.decode(await readResponseBytesWithinLimit(response, options));
}

export async function readResponseJsonWithinLimit(response, options) {
  return parseStrictJson(await readResponseTextWithinLimit(response, options), options.maxBytes);
}

function assertPositiveSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
}

function assertResponse(response) {
  if (!(response instanceof Response)) {
    throw new TypeError("A Response instance is required.");
  }
}

function cancelBodyDetached(response) {
  try {
    observeDetached(response.body?.cancel());
  } catch {
    // The limit decision is authoritative even when a broken stream cannot be cancelled.
  }
}

function cancelReaderDetached(reader) {
  try {
    observeDetached(reader.cancel());
  } catch {
    // The limit decision is authoritative even when a broken stream cannot be cancelled.
  }
}

function observeDetached(value) {
  if (value && typeof value.then === "function") {
    Promise.resolve(value).catch(() => undefined);
  }
}
