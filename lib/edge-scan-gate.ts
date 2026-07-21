/**
 * Shared abuse-control mechanisms for the edge scanners.
 *
 * Both Cloudflare front Workers, the Browser Run worker (`cloudflare/worker.ts`)
 * and the Containers front Worker (`cloudflare/container-worker.ts`), need the
 * same primitives to make a public scan endpoint safe: a constant-time access
 * token check, Cloudflare Turnstile verification, and best-effort KV-backed
 * per-client rate limiting. This module is the single definition of those
 * mechanisms so the two Workers cannot drift apart.
 *
 * Each Worker still composes its *own policy* (when to require a token, whether
 * open access is allowed, which DNS-rebinding caveats apply) on top of these
 * primitives, the policies genuinely differ between Browser Run (no IP pinning)
 * and the Node container (connect-time DNS pinning).
 *
 * It is typed against Web-standard `Headers`/`fetch` and a minimal structural
 * `RateLimitStore` rather than `KVNamespace`, so it carries no Worker-only types
 * and runs in the Node unit-test runner with a fake store.
 */

import { PublicFacingError } from "./public-errors";
import { scanTokenFromHeaders } from "./scan-token";

export class EdgeScanGateError extends PublicFacingError {
  constructor(message: string, status: number) {
    super(message, status, "EdgeScanGateError");
  }
}

/** Minimal structural view of the KV operations rate limiting needs. A real `KVNamespace` satisfies it. */
export interface RateLimitStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

export const DEFAULT_PUBLIC_SCAN_RATE_LIMIT_PER_MINUTE = 6;
export const DEFAULT_PUBLIC_SCAN_RATE_LIMIT_PER_DAY = 120;

const RATE_LIMIT_BUCKET_PREFIX = "rate-limits";
const TURNSTILE_SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const TURNSTILE_CONFIGURATION_PROBE_TOKEN = "site-behavior-lab-health-probe-invalid-token";

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
  rateLimitStoreBound: boolean;
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
  if (!config.rateLimitStoreBound) {
    reasons.push("Open access is enabled but the RATE_LIMITS_KV binding is missing; every scan request returns 503.");
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
  fetchImpl?: typeof fetch;
}): Promise<void> {
  if (!options.token) {
    throw new EdgeScanGateError("Turnstile verification is required.", 400);
  }

  const body = new URLSearchParams();
  body.set("secret", options.secret);
  body.set("response", options.token);
  if (options.remoteIp) body.set("remoteip", options.remoteIp);

  const doFetch = options.fetchImpl ?? fetch;
  const response = await doFetch(TURNSTILE_SITEVERIFY_URL, { method: "POST", body });
  const result = (await response.json().catch(() => ({ success: false }))) as { success?: boolean };

  if (!result.success) {
    throw new EdgeScanGateError("Turnstile verification failed.", 403);
  }
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
}): Promise<TurnstileConfigurationProbeResult> {
  const secret = options.secret.trim();
  if (!secret) return "misconfigured";

  const body = new URLSearchParams();
  body.set("secret", secret);
  body.set("response", TURNSTILE_CONFIGURATION_PROBE_TOKEN);

  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(TURNSTILE_SITEVERIFY_URL, {
      method: "POST",
      body,
      redirect: "error",
      signal: options.signal ?? AbortSignal.timeout(5_000)
    });
  } catch {
    return "unavailable";
  }
  // Siteverify currently returns its structured input-validation errors with
  // HTTP 400 as well as HTTP 200. Parse that documented client-error response
  // so a recognized secret can be distinguished from an invalid one, while
  // continuing to treat every other HTTP failure as unavailable.
  if (!response.ok && response.status !== 400) return "unavailable";

  let result: unknown;
  try {
    result = await response.json();
  } catch {
    return "unavailable";
  }
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

/**
 * Charge a scan against per-minute and per-day windows for the calling client.
 * Throws {@link EdgeScanGateError} (429) when either window would be exceeded.
 *
 * Best-effort: KV read-then-write is not atomic, so concurrent requests can
 * slightly overshoot. Pair with Cloudflare WAF/rate-limiting for hard caps.
 */
export async function enforcePublicScanRateLimit(options: {
  store: RateLimitStore;
  clientHash: string;
  cost: 1 | 2;
  perMinute: number;
  perDay: number;
  now?: number;
}): Promise<void> {
  const now = options.now ?? Date.now();
  await chargeRateLimitWindow({
    store: options.store,
    key: rateLimitKey("minute", Math.floor(now / 60_000), options.clientHash),
    cost: options.cost,
    limit: options.perMinute,
    ttlSeconds: 120,
    retryAfterSeconds: secondsUntilNextWindow(now, 60_000)
  });
  await chargeRateLimitWindow({
    store: options.store,
    key: rateLimitKey("day", Math.floor(now / 86_400_000), options.clientHash),
    cost: options.cost,
    limit: options.perDay,
    ttlSeconds: 172_800,
    retryAfterSeconds: secondsUntilNextWindow(now, 86_400_000)
  });
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
 * caller can never force an allocation beyond the cap plus one network chunk.
 * Returns null when the body exceeds the cap.
 */
export async function readRequestBodyWithinLimit(request: Request, maxBytes: number): Promise<string | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (!request.body) return "";

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
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

async function chargeRateLimitWindow(options: {
  store: RateLimitStore;
  key: string;
  cost: 1 | 2;
  limit: number;
  ttlSeconds: number;
  retryAfterSeconds: number;
}): Promise<void> {
  const currentValue = await options.store.get(options.key);
  const current = currentValue ? Number.parseInt(currentValue, 10) : 0;
  const next = (Number.isFinite(current) ? current : 0) + options.cost;
  if (next > options.limit) {
    throw new EdgeScanGateError(
      `Too many public scans. Try again in about ${formatPublicScanRetryAfter(options.retryAfterSeconds)}.`,
      429
    );
  }

  await options.store.put(options.key, String(next), { expirationTtl: options.ttlSeconds });
}

function rateLimitKey(windowName: "minute" | "day", windowId: number, clientHash: string): string {
  return `${RATE_LIMIT_BUCKET_PREFIX}/public-scan/${windowName}/${windowId}/${clientHash}`;
}

function secondsUntilNextWindow(nowMs: number, windowMs: number): number {
  return Math.max(1, Math.ceil((windowMs - (nowMs % windowMs)) / 1000));
}

export function formatPublicScanRetryAfter(seconds: number): string {
  if (seconds < 90) return `${seconds} seconds`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 90) return `${minutes} minutes`;
  return `${Math.ceil(minutes / 60)} hours`;
}
