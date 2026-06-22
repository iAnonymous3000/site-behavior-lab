/**
 * Shared abuse-control mechanisms for the edge scanners.
 *
 * Both Cloudflare front Workers — the Browser Run worker (`cloudflare/worker.ts`)
 * and the Containers front Worker (`cloudflare/container-worker.ts`) — need the
 * same primitives to make a public scan endpoint safe: a constant-time access
 * token check, Cloudflare Turnstile verification, and best-effort KV-backed
 * per-client rate limiting. This module is the single definition of those
 * mechanisms so the two Workers cannot drift apart.
 *
 * Each Worker still composes its *own policy* (when to require a token, whether
 * open access is allowed, which DNS-rebinding caveats apply) on top of these
 * primitives — the policies genuinely differ between Browser Run (no IP pinning)
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

/** Comparison runs (GPC or Shields off/on) make two browser visits and cost two tokens. */
export function scanTokenCost(payload: { compareGpc?: boolean; compareShields?: boolean }): 1 | 2 {
  return payload.compareGpc || payload.compareShields ? 2 : 1;
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
      `Too many public scans. Try again in about ${formatRetryAfter(options.retryAfterSeconds)}.`,
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

function formatRetryAfter(seconds: number): string {
  if (seconds < 90) return `${seconds} seconds`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 90) return `${minutes} minutes`;
  return `${Math.ceil(minutes / 60)} hours`;
}
