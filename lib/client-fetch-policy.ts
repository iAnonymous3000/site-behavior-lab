import { parseStrictJson } from "./strict-json";

/**
 * Browser-side JSON reads are deliberately finite. The connection deadline
 * bounds time-to-headers; the operation deadline stays armed while the body is
 * streamed and parsed. The byte cap applies to the decompressed response body,
 * not only a potentially compressed Content-Length header.
 */
export const CLIENT_FETCH_CONNECT_TIMEOUT_MS = 10_000;
export const CLIENT_FETCH_OPERATION_TIMEOUT_MS = 30_000;
export const MAX_DIRECTORY_JSON_BYTES = 8 * 1024 * 1024;
export const MAX_CORPUS_STATS_JSON_BYTES = 1024 * 1024;

export type ClientFetchTimeoutPhase = "connect" | "operation";

export class ClientFetchTimeoutError extends Error {
  readonly code = "client-fetch-timeout";

  constructor(
    readonly phase: ClientFetchTimeoutPhase,
    readonly timeoutMs: number,
    label: string
  ) {
    super(
      phase === "connect"
        ? `${label} did not respond within ${formatDuration(timeoutMs)}.`
        : `${label} did not finish loading within ${formatDuration(timeoutMs)}.`
    );
    this.name = "ClientFetchTimeoutError";
  }
}

export class ClientResponseTooLargeError extends Error {
  readonly code = "client-response-too-large";

  constructor(readonly maxBytes: number, label: string) {
    super(`${label} exceeded the ${formatBytes(maxBytes)} response limit.`);
    this.name = "ClientResponseTooLargeError";
  }
}

export class ClientInvalidJsonError extends Error {
  readonly code = "client-invalid-json";

  constructor(label: string, options?: ErrorOptions) {
    super(`${label} returned invalid JSON.`, options);
    this.name = "ClientInvalidJsonError";
  }
}

export type ClientJsonFetchPolicy = {
  label: string;
  maxBytes: number;
  signal?: AbortSignal;
  connectTimeoutMs?: number;
  operationTimeoutMs?: number;
  /** Test seam and non-window runtimes; production callers use global fetch. */
  fetchImpl?: typeof fetch;
  /** Defaults to response.ok. Accepted non-2xx responses are still size- and deadline-bounded. */
  acceptResponse?: (response: Response) => boolean;
  httpError?: (response: Response) => Error;
};

export type ClientJsonFetchResponse = {
  response: Response;
  payload: unknown;
};

export type ClientBytesFetchResponse = {
  response: Response;
  bytes: Uint8Array;
};

/**
 * Fetch and parse a JSON response under one bounded policy. Passing a caller
 * signal composes cancellation with both deadlines; the caller's abort reason
 * wins when it fires first.
 */
export async function fetchJsonWithPolicy(
  input: RequestInfo | URL,
  init: RequestInit,
  policy: ClientJsonFetchPolicy
): Promise<unknown> {
  return (await fetchJsonResponseWithPolicy(input, init, policy)).payload;
}

/**
 * Response-preserving variant for clients whose state machine needs status or
 * headers (for example 404 recovery and Retry-After) after a bounded JSON read.
 */
export async function fetchJsonResponseWithPolicy(
  input: RequestInfo | URL,
  init: RequestInit,
  policy: ClientJsonFetchPolicy
): Promise<ClientJsonFetchResponse> {
  const result = await fetchResponseWithPolicy(input, init, policy, (bytes) =>
    parseJsonBytesWithPolicy(bytes, policy.label)
  );
  return { response: result.response, payload: result.value };
}

/**
 * Bounded response bytes for clients that authenticate the exact wire before
 * decoding or parsing it. JSON and byte callers share the same deadlines,
 * byte ceiling, abort composition, and response-body cleanup.
 */
export async function fetchBytesResponseWithPolicy(
  input: RequestInfo | URL,
  init: RequestInit,
  policy: ClientJsonFetchPolicy
): Promise<ClientBytesFetchResponse> {
  const result = await fetchResponseWithPolicy(input, init, policy, (bytes) => bytes);
  return { response: result.response, bytes: result.value };
}

/** Invalid UTF-8 is invalid JSON evidence; replacement characters are never accepted. */
export function parseJsonBytesWithPolicy(bytes: Uint8Array, label: string): unknown {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return parseJsonTextWithPolicy(text, label);
  } catch (error) {
    if (error instanceof ClientInvalidJsonError) throw error;
    throw new ClientInvalidJsonError(label, { cause: error });
  }
}

/** Duplicate object keys are invalid at every untrusted browser JSON boundary. */
export function parseJsonTextWithPolicy(text: string, label: string): unknown {
  try {
    return parseStrictJson(text);
  } catch (error) {
    throw new ClientInvalidJsonError(label, { cause: error });
  }
}

async function fetchResponseWithPolicy<T>(
  input: RequestInfo | URL,
  init: RequestInit,
  policy: ClientJsonFetchPolicy,
  transform: (bytes: Uint8Array) => T | Promise<T>
): Promise<{ response: Response; value: T }> {
  const connectTimeoutMs = positiveDuration(
    policy.connectTimeoutMs ?? CLIENT_FETCH_CONNECT_TIMEOUT_MS,
    "connection timeout"
  );
  const operationTimeoutMs = positiveDuration(
    policy.operationTimeoutMs ?? CLIENT_FETCH_OPERATION_TIMEOUT_MS,
    "operation timeout"
  );
  const maxBytes = positiveByteLimit(policy.maxBytes);
  const controller = new AbortController();
  const callerSignals = uniqueSignals([init.signal, policy.signal]);
  const removeCallerAbortListeners = callerSignals.map((signal) => forwardAbort(signal, controller));
  const abortGate = abortPromise(controller.signal);
  let connectTimer: ReturnType<typeof setTimeout> | undefined;
  let operationTimer: ReturnType<typeof setTimeout> | undefined;

  try {
    if (controller.signal.aborted) throw abortReason(controller.signal);

    connectTimer = setTimeout(() => {
      controller.abort(new ClientFetchTimeoutError("connect", connectTimeoutMs, policy.label));
    }, connectTimeoutMs);
    operationTimer = setTimeout(() => {
      controller.abort(new ClientFetchTimeoutError("operation", operationTimeoutMs, policy.label));
    }, operationTimeoutMs);

    const fetchImpl = policy.fetchImpl ?? fetch;
    const response = await Promise.race([
      fetchImpl(input, { ...init, signal: controller.signal }),
      abortGate.promise
    ]);
    clearTimer(connectTimer);
    connectTimer = undefined;

    const accepted = policy.acceptResponse ? policy.acceptResponse(response) : response.ok;
    if (!accepted) {
      const error = policy.httpError?.(response) ?? new Error(`${policy.label} returned HTTP ${response.status}.`);
      cancelResponseBody(response, error);
      throw error;
    }

    const bytes = await readBoundedResponseBody(response, maxBytes, policy.label, controller.signal, abortGate.promise);
    const value = await transform(bytes);
    return { response, value };
  } catch (error) {
    if (controller.signal.aborted) throw abortReason(controller.signal);
    throw error;
  } finally {
    clearTimer(connectTimer);
    clearTimer(operationTimer);
    abortGate.dispose();
    for (const remove of removeCallerAbortListeners) remove();
  }
}

export type LatestClientOperationOutcome = "committed" | "failed" | "superseded";

export type LatestClientOperationHandlers<T> = {
  onStart?: () => void;
  onSuccess: (value: T) => void;
  onError: (error: unknown) => void;
  onSettled?: () => void;
};

/**
 * Owns one mutable UI operation at a time. Starting or cancelling an operation
 * aborts its predecessor and advances the epoch. Every success, error and
 * finally callback is fenced, including tasks that ignore AbortSignal.
 */
export class LatestClientOperation {
  #epoch = 0;
  #controller: AbortController | null = null;

  async run<T>(
    task: (signal: AbortSignal) => Promise<T>,
    handlers: LatestClientOperationHandlers<T>
  ): Promise<LatestClientOperationOutcome> {
    const ticket = this.#begin();
    handlers.onStart?.();

    let value: T;
    try {
      value = await task(ticket.signal);
    } catch (error) {
      if (!this.#owns(ticket)) return "superseded";
      try {
        handlers.onError(error);
        return "failed";
      } finally {
        this.#settle(ticket, handlers.onSettled);
      }
    }

    if (!this.#owns(ticket)) return "superseded";
    try {
      handlers.onSuccess(value);
      return "committed";
    } finally {
      this.#settle(ticket, handlers.onSettled);
    }
  }

  cancel(reason: unknown = new DOMException("The client operation was superseded.", "AbortError")): void {
    this.#epoch += 1;
    this.#controller?.abort(reason);
    this.#controller = null;
  }

  #begin(): OperationTicket {
    this.cancel();
    const controller = new AbortController();
    const ticket = { epoch: this.#epoch, controller, signal: controller.signal };
    this.#controller = controller;
    return ticket;
  }

  #owns(ticket: OperationTicket): boolean {
    return this.#epoch === ticket.epoch && this.#controller === ticket.controller && !ticket.signal.aborted;
  }

  #settle(ticket: OperationTicket, onSettled: (() => void) | undefined): void {
    if (!this.#owns(ticket)) return;
    this.#controller = null;
    onSettled?.();
  }
}

type OperationTicket = {
  epoch: number;
  controller: AbortController;
  signal: AbortSignal;
};

async function readBoundedResponseBody(
  response: Response,
  maxBytes: number,
  label: string,
  signal: AbortSignal,
  abortGate: Promise<never>
): Promise<Uint8Array> {
  const declaredLength = response.headers.get("content-length");
  let parsedDeclaredLength: number | null = null;
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (Number.isSafeInteger(parsedLength) && parsedLength > maxBytes) {
      cancelResponseBody(response, new ClientResponseTooLargeError(maxBytes, label));
      throw new ClientResponseTooLargeError(maxBytes, label);
    }
    if (Number.isSafeInteger(parsedLength) && parsedLength >= 0) parsedDeclaredLength = parsedLength;
  }

  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  let bytes = new Uint8Array(0);
  let totalBytes = 0;

  try {
    while (true) {
      if (signal.aborted) throw abortReason(signal);
      const chunk = await Promise.race([reader.read(), abortGate]);
      if (chunk.done) break;
      totalBytes += chunk.value.byteLength;
      if (totalBytes > maxBytes) {
        void reader.cancel().catch(() => undefined);
        throw new ClientResponseTooLargeError(maxBytes, label);
      }
      const previousTotal = totalBytes - chunk.value.byteLength;
      if (bytes.byteLength < totalBytes) {
        const initialCapacity = parsedDeclaredLength && parsedDeclaredLength > 0
          ? Math.min(parsedDeclaredLength, 64 * 1024)
          : Math.min(64 * 1024, maxBytes);
        const doubledCapacity = bytes.byteLength > 0 ? bytes.byteLength * 2 : initialCapacity;
        const nextCapacity = Math.min(maxBytes, Math.max(totalBytes, doubledCapacity));
        const grown = new Uint8Array(nextCapacity);
        if (previousTotal > 0) grown.set(bytes.subarray(0, previousTotal));
        bytes = grown;
      }
      bytes.set(chunk.value, previousTotal);
    }
  } finally {
    if (signal.aborted) void reader.cancel(abortReason(signal)).catch(() => undefined);
    // A test double or non-conforming transport can ignore AbortSignal and
    // leave read() pending. Never let releaseLock's TypeError mask the timeout
    // or caller-abort reason that won the operation race.
    try {
      reader.releaseLock();
    } catch {
      // The pending read remains detached from UI state by the operation epoch.
    }
  }

  return bytes.subarray(0, totalBytes);
}

function cancelResponseBody(response: Response, reason?: unknown): void {
  try {
    const cancellation = response.body?.cancel(reason);
    if (cancellation) void cancellation.catch(() => undefined);
  } catch {
    // The response is already being rejected; transport cleanup must not mask
    // the stable policy error exposed to the caller.
  }
}

function forwardAbort(signal: AbortSignal, controller: AbortController): () => void {
  const onAbort = () => {
    if (!controller.signal.aborted) controller.abort(abortReason(signal));
  };
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}

function uniqueSignals(signals: (AbortSignal | null | undefined)[]): AbortSignal[] {
  return [...new Set(signals.filter((signal): signal is AbortSignal => Boolean(signal)))];
}

function abortPromise(signal: AbortSignal): { promise: Promise<never>; dispose: () => void } {
  let onAbort: (() => void) | undefined;
  const promise = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(abortReason(signal));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  // The caller can already be aborted before fetchJsonWithPolicy reaches its
  // Promise.race. Attach a rejection observer now so that fast-fail path never
  // emits an unhandled rejection; the original promise still rejects in races.
  void promise.catch(() => undefined);
  return {
    promise,
    dispose: () => {
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
  };
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The client operation was aborted.", "AbortError");
}

function positiveDuration(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new TypeError(`${label} must be a positive finite number.`);
  return value;
}

function positiveByteLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError("response byte limit must be a positive integer.");
  return value;
}

function clearTimer(timer: ReturnType<typeof setTimeout> | undefined): void {
  if (timer !== undefined) clearTimeout(timer);
}

function formatDuration(milliseconds: number): string {
  if (milliseconds % 1000 === 0) {
    const seconds = milliseconds / 1000;
    return `${seconds} ${seconds === 1 ? "second" : "seconds"}`;
  }
  return `${milliseconds} ${milliseconds === 1 ? "millisecond" : "milliseconds"}`;
}

function formatBytes(bytes: number): string {
  if (bytes % (1024 * 1024) === 0) return `${bytes / (1024 * 1024)} MB`;
  if (bytes % 1024 === 0) return `${bytes / 1024} KB`;
  return `${bytes} bytes`;
}
