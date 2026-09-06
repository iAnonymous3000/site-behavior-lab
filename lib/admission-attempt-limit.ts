import { scanCorsHeaders } from "./cors";
import type { DurableScanJobStoreSql } from "./durable-scan-job-store";
import type { PublicScanRateLimitResult } from "./public-scan-rate-limit-store";
import { sha256Hex } from "./sha256";

// This bounds work BEFORE body parsing, capability lookup and Siteverify.
// Accepted browser work still consumes the separate scan quota. Both admission
// routes share this rolling window; changing route, credential or colo does not
// buy another allowance. The singleton DO is the authority, not a WAF counter.
export const ADMISSION_ATTEMPT_WINDOW_MS = 10_000;
export const ADMISSION_ATTEMPT_CLIENT_LIMIT = 10;
export const ADMISSION_ATTEMPT_GLOBAL_LIMIT = 100;

/** Called only inside the owning Durable Object's transactionSync. */
export function chargeAdmissionAttempt(
  sql: DurableScanJobStoreSql,
  clientHash: string,
  now: number
): PublicScanRateLimitResult {
  if (!/^[0-9a-f]{64}$/.test(clientHash) || !Number.isSafeInteger(now) || now < 0) {
    throw new Error("Invalid admission-attempt charge.");
  }
  sql.exec(`CREATE TABLE IF NOT EXISTS admission_attempts (
    id INTEGER PRIMARY KEY,
    client_hash TEXT NOT NULL CHECK(length(client_hash) = 64),
    charged_at INTEGER NOT NULL
  )`);
  sql.exec("CREATE INDEX IF NOT EXISTS admission_attempts_time ON admission_attempts(charged_at, id)");
  const cutoff = now - ADMISSION_ATTEMPT_WINDOW_MS;
  sql.exec(`DELETE FROM admission_attempts WHERE id IN (
    SELECT id FROM admission_attempts WHERE charged_at <= ?
    ORDER BY charged_at, id LIMIT ${ADMISSION_ATTEMPT_GLOBAL_LIMIT}
  )`, cutoff);
  // At most 100 live events can exist, so one bounded read establishes both
  // ceilings without allocating a row for every rejected/rotating identity.
  const rows = sql.exec<{ client_hash: string; charged_at: number }>(
    `SELECT client_hash, charged_at FROM admission_attempts
     WHERE charged_at > ? ORDER BY charged_at, id LIMIT ${ADMISSION_ATTEMPT_GLOBAL_LIMIT + 1}`,
    cutoff
  ).toArray();
  const clientRows = rows.filter((row) => row.client_hash === clientHash);
  const waits: number[] = [];
  for (const [events, limit] of [
    [rows, ADMISSION_ATTEMPT_GLOBAL_LIMIT],
    [clientRows, ADMISSION_ATTEMPT_CLIENT_LIMIT]
  ] as const) {
    if (events.length >= limit) {
      waits.push(events[events.length - limit].charged_at + ADMISSION_ATTEMPT_WINDOW_MS - now);
    }
  }
  if (waits.length) {
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(Math.max(...waits) / 1_000)) };
  }
  sql.exec("INSERT INTO admission_attempts (client_hash, charged_at) VALUES (?, ?)", clientHash, now);
  return { allowed: true };
}

export function isAdmissionAttempt(method: string, pathname: string): boolean {
  return (method === "POST" && pathname === "/api/scan") ||
    (method === "GET" && pathname === "/api/scan/admission");
}

/** Returns a refusal before the caller reads any body or starts expensive work. */
export async function enforceAdmissionAttemptLimit(
  request: Request,
  allowedOrigin: string | undefined,
  charge: (clientHash: string) => Promise<PublicScanRateLimitResult>
): Promise<Response | null> {
  let decision: PublicScanRateLimitResult;
  try {
    // Cloudflare supplies this header at the sole public ingress. Never use
    // caller-controlled X-Forwarded-For/X-Real-IP as alternate quota identities.
    const clientHash = await sha256Hex(request.headers.get("cf-connecting-ip")?.trim() || "unknown");
    decision = await charge(clientHash);
  } catch {
    return refusal(request, allowedOrigin, 503, "Scan admission is temporarily unavailable.", 5);
  }
  if (decision.allowed) return null;
  return refusal(request, allowedOrigin, 429, "Too many scan admission requests. Try again shortly.", decision.retryAfterSeconds);
}

function refusal(request: Request, allowedOrigin: string | undefined, status: 429 | 503, error: string, retryAfter: number): Response {
  return new Response(JSON.stringify({ ok: false, error }), {
    status,
    headers: {
      ...scanCorsHeaders(request.headers.get("origin"), allowedOrigin),
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "retry-after": String(Math.max(1, Math.ceil(retryAfter))),
      "x-content-type-options": "nosniff"
    }
  });
}
