/**
 * Abuse-control mechanisms for the Containers front Worker
 * (`cloudflare/container-worker.ts`): a constant-time access-token check,
 * Cloudflare Turnstile verification, a bounded request-body reader, and the
 * client-identity hash the quota is keyed on.
 *
 * It once also held best-effort KV-backed rate limiting, shared with the Browser
 * Run worker so the two could not drift apart. That worker was deleted on
 * 2026-07-24 and the container charges its quota atomically in the scanner
 * Durable Object, so the KV counters and their `RATE_LIMITS_KV` readiness check
 * were removed on 2026-07-25 rather than left exported: a read-then-write
 * counter that concurrent requests can overshoot must not stay importable as if
 * it were a working limiter.
 *
 * It is typed against Web-standard `Headers`/`fetch` rather than Worker types,
 * so it carries no Worker-only globals and runs in the Node unit-test runner.
 */

import { PublicFacingError } from "./public-errors";
import { scanTokenFromHeaders } from "./scan-token";
import { fetchJsonResponseWithPolicy } from "./client-fetch-policy";

export class EdgeScanGateError extends PublicFacingError {
  constructor(message: string, status: number) {
    super(message, status, "EdgeScanGateError");
  }
}

export const DEFAULT_PUBLIC_SCAN_RATE_LIMIT_PER_MINUTE = 6;
export const DEFAULT_PUBLIC_SCAN_RATE_LIMIT_PER_DAY = 120;

const TURNSTILE_SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
export const TURNSTILE_SITEVERIFY_CONNECT_TIMEOUT_MS = 5_000;
export const TURNSTILE_SITEVERIFY_OPERATION_TIMEOUT_MS = 10_000;
export const TURNSTILE_SITEVERIFY_MAX_RESPONSE_BYTES = 8 * 1024;
export const TURNSTILE_CONFIGURATION_PROBE_TIMEOUT_MS = 5_000;
export const REQUEST_BODY_OPERATION_TIMEOUT_MS = 10_000;
// Cloudflare documents this as the dummy token: production secrets reject it
// deterministically without requiring or redeeming a visitor challenge.
const TURNSTILE_CONFIGURATION_PROBE_TOKEN = "XXXX.DUMMY.TOKEN.XXXX";

export class RequestBodyReadTimeoutError extends EdgeScanGateError {
  constructor(readonly timeoutMs: number) {
    super("The request body was not received in time.", 408);
    this.name = "RequestBodyReadTimeoutError";
  }
}

export class RequestBodyReadAbortedError extends EdgeScanGateError {
  override readonly cause: unknown;

  constructor(cause?: unknown) {
    // 499 is intentionally distinct from an edge-generated timeout. In normal
    // operation the disconnected caller cannot receive this response, but the
    // typed status keeps logs and conforming test/runtime callers honest.
    super("The request ended before its body was received.", 499);
    this.name = "RequestBodyReadAbortedError";
    this.cause = cause;
  }
}

export class RequestBodyInvalidUtf8Error extends EdgeScanGateError {
  constructor() {
    // Keep decoder/runtime detail private and give every ingress path one
    // stable malformed-body contract.
    super("The request body must be valid UTF-8.", 400);
    this.name = "RequestBodyInvalidUtf8Error";
  }
}

/** Comparison runs (GPC, Shields, or consent accept/reject) make two browser visits and cost two tokens. */
export function scanTokenCost(payload: { compareGpc?: boolean; compareShields?: boolean; compareConsent?: boolean }): 1 | 2 {
  return payload.compareGpc || payload.compareShields || payload.compareConsent ? 2 : 1;
}

export type PublicScanGateStatus = {
  authenticated: boolean;
  openAccess: boolean;
  turnstile: boolean;
};

export type PublicScanAccessMode = "configured" | "open" | "refused";

/**
 * Replace an upstream health response's scan-access check with the edge gate's
 * authoritative posture while preserving every unrelated upstream check.
 */
export function withPublicScanAccessCheck(
  checks: unknown,
  gate: PublicScanGateStatus,
  refusalReasons: readonly string[]
): Record<string, unknown> {
  const upstream = checks !== null && typeof checks === "object" && !Array.isArray(checks) ? checks : {};
  const scanAccess: PublicScanAccessMode =
    refusalReasons.length > 0 ? "refused" : gate.authenticated ? "configured" : gate.openAccess ? "open" : "refused";
  return { ...upstream, scanAccess };
}

/**
 * The gate's own view of how it admits scans, for `/api/health`. A front Worker
 * is the edge enforcement point, so it, not the upstream Node app, which has no
 * Turnstile concept, is the source of truth for these fields. Mirrors exactly
 * when the gate requires a token, allows open access, and enforces Turnstile.
 */
export function publicScanGateStatus(config: {
  accessToken?: string;
  allowUnauthenticated?: string;
  turnstileSecret?: string;
}): PublicScanGateStatus {
  const token = config.accessToken?.trim();
  const openAccess = !token && config.allowUnauthenticated === "1";
  return {
    authenticated: Boolean(token),
    openAccess,
    turnstile: openAccess && Boolean(config.turnstileSecret?.trim())
  };
}

/**
 * Configurations under which the gate refuses EVERY scan with a 503, mirroring
 * gateScanRequest's fail-closed branches exactly. `/api/health` must surface
 * these as degraded status instead of reporting a green scanner that cannot
 * accept a single scan.
 */
export function publicScanRefusalReasons(config: {
  accessToken?: string;
  allowUnauthenticated?: string;
  turnstileSecret?: string;
  acceptNoTurnstileRisk?: string;
}): string[] {
  const gate = publicScanGateStatus(config);
  if (gate.authenticated) return [];

  if (!gate.openAccess) {
    return ["No access token is configured and unauthenticated scans are not enabled; every scan request returns 503."];
  }

  const reasons: string[] = [];
  if (
    openScanBlockedForMissingTurnstile({
      turnstileSecret: config.turnstileSecret,
      acceptNoTurnstileRisk: config.acceptNoTurnstileRisk
    })
  ) {
    reasons.push(
      "Open access is enabled but Turnstile is not configured (and not explicitly waived); every scan request returns 503."
    );
  }
  return reasons;
}

/**
 * In open (unauthenticated) scan mode, Turnstile is the human-verification cost
 * control. If it is neither configured nor explicitly waived, the gate should
 * fail closed rather than serve an open scanner with only best-effort rate
 * limiting. Returns true when the caller must refuse the scan. Waiving requires
 * a conscious `SITE_BEHAVIOR_LAB_ACCEPT_NO_TURNSTILE_RISK=1`.
 */
export function openScanBlockedForMissingTurnstile(config: {
  turnstileSecret?: string;
  acceptNoTurnstileRisk?: string;
}): boolean {
  return !config.turnstileSecret?.trim() && config.acceptNoTurnstileRisk !== "1";
}

/**
 * Whether the request carries the configured access token. Returns false when no
 * token is supplied or it does not match; callers decide the failure response.
 */
export async function scanAccessTokenMatches(headers: Headers, expectedToken: string): Promise<boolean> {
  const supplied = scanTokenFromHeaders(headers);
  if (!supplied) return false;
  return constantTimeEqual(supplied, expectedToken);
}

/**
 * Verify a Cloudflare Turnstile token against the siteverify API. Throws
 * {@link EdgeScanGateError} when the token is missing (400) or rejected (403).
 * `fetchImpl` is injectable for tests; it defaults to the global `fetch`.
 */
export async function assertTurnstileToken(options: {
  secret: string;
  token: string;
  remoteIp?: string | null;
  /** Stable UUID for safe Siteverify retries of one admission capability. */
  idempotencyKey?: string;
  /** Composed with finite Siteverify connection and whole-body deadlines. */
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  /** Test seams; production callers use the finite constants above. */
  connectTimeoutMs?: number;
  operationTimeoutMs?: number;
  maxResponseBytes?: number;
}): Promise<void> {
  if (!options.token) {
    throw new EdgeScanGateError("Turnstile verification is required.", 400);
  }

  const body = new URLSearchParams();
  body.set("secret", options.secret);
  body.set("response", options.token);
  if (options.remoteIp) body.set("remoteip", options.remoteIp);
  if (options.idempotencyKey !== undefined) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(options.idempotencyKey)) {
      throw new Error("Invalid Turnstile idempotency key.");
    }
    body.set("idempotency_key", options.idempotencyKey);
  }

  let result: unknown;
  try {
    ({ payload: result } = await fetchJsonResponseWithPolicy(
      TURNSTILE_SITEVERIFY_URL,
      { method: "POST", body, signal: options.signal },
      {
        label: "Turnstile verification",
        maxBytes: options.maxResponseBytes ?? TURNSTILE_SITEVERIFY_MAX_RESPONSE_BYTES,
        connectTimeoutMs: options.connectTimeoutMs ?? TURNSTILE_SITEVERIFY_CONNECT_TIMEOUT_MS,
        operationTimeoutMs: options.operationTimeoutMs ?? TURNSTILE_SITEVERIFY_OPERATION_TIMEOUT_MS,
        fetchImpl: options.fetchImpl
      }
    ));
  } catch (error) {
    throw new EdgeScanGateError(
      error instanceof Error && error.message
        ? `Turnstile verification is unavailable: ${error.message}`
        : "Turnstile verification is unavailable.",
      503
    );
  }

  if (!result || typeof result !== "object" || Array.isArray(result) || (result as { success?: unknown }).success !== true) {
    throw new EdgeScanGateError("Turnstile verification failed.", 403);
  }
}

/**
 * Derive Siteverify's retry UUID from one admission capability and one exact
 * challenge token. Retries of the same token converge; a refreshed challenge
 * creates a new validation operation. Only the digest is returned or sent.
 */
export async function turnstileAdmissionIdempotencyKey(
  capabilityHash: ArrayBuffer,
  token: string
): Promise<string> {
  if (!(capabilityHash instanceof ArrayBuffer) || capabilityHash.byteLength !== 32 || !token) {
    throw new Error("Invalid Turnstile admission retry material.");
  }
  const domain = new TextEncoder().encode("site-behavior-lab/turnstile-admission/v1\0");
  const tokenBytes = new TextEncoder().encode(token);
  const material = new Uint8Array(domain.byteLength + 32 + 4 + tokenBytes.byteLength);
  material.set(domain, 0);
  material.set(new Uint8Array(capabilityHash), domain.byteLength);
  new DataView(material.buffer).setUint32(domain.byteLength + 32, tokenBytes.byteLength);
  material.set(tokenBytes, domain.byteLength + 36);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", material));
  const bytes = digest.slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export type TurnstileConfigurationProbeResult = "verified" | "misconfigured" | "unavailable";

/**
 * Verify that the configured Turnstile secret is recognized by Siteverify
 * without solving a challenge or admitting a scan. A deliberately invalid
 * response token must be rejected specifically as `invalid-input-response`;
 * secret errors prove misconfiguration, while transport/shape drift remains
 * unavailable. No visitor quota is touched by this probe.
 */
export async function probeTurnstileConfiguration(options: {
  secret: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  /** Test seams; production uses the same small response cap and a 5s whole-operation deadline. */
  connectTimeoutMs?: number;
  operationTimeoutMs?: number;
  maxResponseBytes?: number;
}): Promise<TurnstileConfigurationProbeResult> {
  const secret = options.secret.trim();
  if (!secret) return "misconfigured";

  const body = new URLSearchParams();
  body.set("secret", secret);
  body.set("response", TURNSTILE_CONFIGURATION_PROBE_TOKEN);

  let result: unknown;
  try {
    ({ payload: result } = await fetchJsonResponseWithPolicy(
      TURNSTILE_SITEVERIFY_URL,
      { method: "POST", body, signal: options.signal },
      {
        label: "Turnstile configuration probe",
        maxBytes: options.maxResponseBytes ?? TURNSTILE_SITEVERIFY_MAX_RESPONSE_BYTES,
        connectTimeoutMs: options.connectTimeoutMs ?? TURNSTILE_CONFIGURATION_PROBE_TIMEOUT_MS,
        operationTimeoutMs: options.operationTimeoutMs ?? TURNSTILE_CONFIGURATION_PROBE_TIMEOUT_MS,
        fetchImpl: options.fetchImpl,
        acceptResponse: (response) =>
          response.ok || (response.status >= 400 && response.status < 500 && response.status !== 429)
      }
    ));
  } catch {
    return "unavailable";
  }
  // Siteverify returns structured input-validation errors with both successful
  // and client-error HTTP statuses. Parse any non-rate-limit 4xx response so a
  // recognized secret can be distinguished from an invalid one, while keeping
  // redirects, throttling, and server failures unavailable. Use the same
  // redirect behavior as the visitor validation path: Cloudflare may route the
  // fixed Siteverify origin internally before returning its JSON response.
  if (!result || typeof result !== "object" || Array.isArray(result)) return "unavailable";
  const record = result as Record<string, unknown>;
  const codes = Array.isArray(record["error-codes"])
    ? record["error-codes"].filter((value): value is string => typeof value === "string")
    : [];
  if (codes.includes("missing-input-secret") || codes.includes("invalid-input-secret")) {
    return "misconfigured";
  }
  if (record.success === false && codes.length === 1 && codes[0] === "invalid-input-response") {
    return "verified";
  }
  return "unavailable";
}

/** Stable per-client hash from the proxied client IP headers. */
export async function publicClientHash(headers: Headers): Promise<string> {
  const key =
    headers.get("cf-connecting-ip")?.trim() ||
    headers.get("x-real-ip")?.trim() ||
    headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown";
  return sha256Hex(key);
}

/** Parse a positive-integer env override, falling back when unset or invalid. */
export function publicScanRateLimit(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Read a request body while enforcing the byte cap BEFORE buffering: a
 * declared Content-Length over the cap rejects outright without reading, and
 * bodies without one (chunked) stream through the cap, so an unauthenticated
 * caller can never make this reader retain bytes beyond the cap. The stream or
 * transport may speculatively queue chunks outside this reader; cancellation
 * is issued immediately when the first over-cap chunk is observed.
 * Returns null when the body exceeds the cap.
 */
export async function readRequestBodyWithinLimit(
  request: Request,
  maxBytes: number,
  options: Readonly<{ signal?: AbortSignal; timeoutMs?: number }> = {}
): Promise<string | null> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new TypeError("The request-body byte limit must be a positive integer.");
  }
  const timeoutMs = options.timeoutMs ?? REQUEST_BODY_OPERATION_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("The request-body timeout must be a positive integer.");
  }

  const controller = new AbortController();
  const requestSignal = (request as Request & { signal?: AbortSignal }).signal;
  const callerSignals = [...new Set([requestSignal, options.signal].filter(isAbortSignal))];
  const removeAbortListeners = callerSignals.map((signal) =>
    forwardRequestBodyAbort(signal, controller)
  );
  const timer = setTimeout(
    () => controller.abort(new RequestBodyReadTimeoutError(timeoutMs)),
    timeoutMs
  );
  const abort = requestBodyAbortGate(controller.signal);

  try {
    throwIfRequestBodyAborted(controller.signal);
    const declared = Number(request.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) return null;
    if (!request.body) return "";

    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        throwIfRequestBodyAborted(controller.signal);
        const { done, value } = await Promise.race([reader.read(), abort.promise]);
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          // Cancellation is cleanup, not part of the body deadline. A broken
          // or adversarial stream may never settle its cancel promise.
          void reader.cancel().catch(() => undefined);
          return null;
        }
        chunks.push(value);
      }
    } finally {
      if (controller.signal.aborted) {
        void reader.cancel(requestBodyAbortReason(controller.signal)).catch(() => undefined);
      }
      // Some stream doubles ignore cancellation and keep read() pending. Do
      // not let releaseLock's resulting TypeError mask the abort/timeout.
      try {
        reader.releaseLock();
      } catch {
        // The detached read has no remaining admission or parsing continuation.
      }
    }

    throwIfRequestBodyAborted(controller.signal);
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new RequestBodyInvalidUtf8Error();
    }
  } finally {
    clearTimeout(timer);
    abort.dispose();
    for (const remove of removeAbortListeners) remove();
  }
}

function isAbortSignal(value: AbortSignal | undefined): value is AbortSignal {
  return value !== undefined;
}

function forwardRequestBodyAbort(signal: AbortSignal, controller: AbortController): () => void {
  const onAbort = () => {
    if (!controller.signal.aborted) controller.abort(new RequestBodyReadAbortedError(signal.reason));
  };
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}

function requestBodyAbortGate(signal: AbortSignal): { promise: Promise<never>; dispose(): void } {
  let onAbort: (() => void) | undefined;
  const promise = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(requestBodyAbortReason(signal));
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

function throwIfRequestBodyAborted(signal: AbortSignal): void {
  if (signal.aborted) throw requestBodyAbortReason(signal);
}

function requestBodyAbortReason(signal: AbortSignal): RequestBodyReadTimeoutError | RequestBodyReadAbortedError {
  if (signal.reason instanceof RequestBodyReadTimeoutError) return signal.reason;
  if (signal.reason instanceof RequestBodyReadAbortedError) return signal.reason;
  return new RequestBodyReadAbortedError(signal.reason);
}

/**
 * Compare two secrets without leaking length or content through timing: both
 * sides are hashed to fixed-length SHA-256 hex first, then diffed byte by byte.
 */
export async function constantTimeEqual(candidate: string, expected: string): Promise<boolean> {
  const [candidateHash, expectedHash] = await Promise.all([sha256Hex(candidate), sha256Hex(expected)]);
  let mismatch = 0;
  for (let index = 0; index < candidateHash.length; index += 1) {
    mismatch |= candidateHash.charCodeAt(index) ^ expectedHash.charCodeAt(index);
  }
  return mismatch === 0;
}

export async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function formatPublicScanRetryAfter(seconds: number): string {
  // Only the seconds branch can carry a singular value: the minutes branch
  // starts at 90 seconds and the hours branch at 90 minutes, so both round to
  // at least two. A visitor refused in the last second of a window was still
  // told to "Try again in about 1 seconds."
  if (seconds < 90) return `${seconds} ${seconds === 1 ? "second" : "seconds"}`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 90) return `${minutes} minutes`;
  return `${Math.ceil(minutes / 60)} hours`;
}
