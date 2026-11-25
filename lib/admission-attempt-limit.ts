import { edgeClientIdentity } from "./client-identity";
import { scanCorsHeaders } from "./cors";
import type { DurableScanJobStoreSql } from "./durable-scan-job-store";
import { publicErrorBody } from "./public-errors";
import type { PublicScanRateLimitResult } from "./public-scan-rate-limit-store";
import { sha256Hex } from "./sha256";

// Per-client rolling ceiling applied BEFORE body parsing, capability lookup
// and Siteverify. Unlike the old global 100-attempt bucket, one group of
// abusive IPs can never deny service to unrelated legitimate visitors; SQLite
// storage stays strictly bounded by per-call expiry pruning plus oldest-row
// LRU eviction at ADMISSION_ATTEMPT_MAX_STORED_ROWS.
export const ADMISSION_ATTEMPT_WINDOW_MS = 10_000;
export const ADMISSION_ATTEMPT_CLIENT_LIMIT = 10;
export const ADMISSION_ATTEMPT_MAX_STORED_ROWS = 5_000;
const ADMISSION_ATTEMPT_PRUNE_BATCH = 200;

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
  sql.exec(
    "CREATE INDEX IF NOT EXISTS admission_attempts_client_time ON admission_attempts(client_hash, charged_at, id)"
  );
  const cutoff = now - ADMISSION_ATTEMPT_WINDOW_MS;
  sql.exec(
    `DELETE FROM admission_attempts WHERE id IN (
      SELECT id FROM admission_attempts WHERE charged_at <= ?
      ORDER BY charged_at, id LIMIT ${ADMISSION_ATTEMPT_PRUNE_BATCH}
    )`,
    cutoff
  );
  const clientRows = sql
    .exec<{ charged_at: number }>(
      `SELECT charged_at FROM admission_attempts
       WHERE client_hash = ? AND charged_at > ?
       ORDER BY charged_at ASC, id ASC LIMIT ${ADMISSION_ATTEMPT_CLIENT_LIMIT + 1}`,
      clientHash,
      cutoff
    )
    .toArray();
  if (clientRows.length >= ADMISSION_ATTEMPT_CLIENT_LIMIT) {
    const oldest = clientRows[clientRows.length - ADMISSION_ATTEMPT_CLIENT_LIMIT];
    const waitMs = oldest.charged_at + ADMISSION_ATTEMPT_WINDOW_MS - now;
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1_000)) };
  }
  sql.exec("INSERT INTO admission_attempts (client_hash, charged_at) VALUES (?, ?)", clientHash, now);
  const totalRow = sql
    .exec<{ count: number }>("SELECT COUNT(*) AS count FROM admission_attempts")
    .toArray()[0];
  const overflow = (totalRow?.count ?? 0) - ADMISSION_ATTEMPT_MAX_STORED_ROWS;
  if (overflow > 0) {
    sql.exec(
      `DELETE FROM admission_attempts WHERE id IN (
        SELECT id FROM admission_attempts ORDER BY charged_at ASC, id ASC LIMIT ?
      )`,
      overflow
    );
  }
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
    // The shared edge identity: Cloudflare's client address only, an IPv6
    // client keyed on its /64, and never a caller-controlled
    // X-Forwarded-For/X-Real-IP as an alternate quota identity.
    const clientHash = await sha256Hex(edgeClientIdentity(request.headers));
    decision = await charge(clientHash);
  } catch {
    return refusal(request, allowedOrigin, 503, "Scan admission is temporarily unavailable.", 5);
  }
  if (decision.allowed) return null;
  // Both the per-client and the global bucket refuse here, so the declared
  // cause makes no claim about whose attempts filled the window. Only the scan
  // submission declares it: the GET recovery lookup is not a scan being held
  // back, matching the uncaused recovery refusal in the Worker.
  return refusal(
    request,
    allowedOrigin,
    429,
    "Too many scan admission requests. Try again shortly.",
    decision.retryAfterSeconds,
    request.method === "POST" ? "request-limit" : undefined
  );
}

function refusal(
  request: Request,
  allowedOrigin: string | undefined,
  status: 429 | 503,
  error: string,
  retryAfter: number,
  cause?: "request-limit"
): Response {
  const retryAfterSeconds = Math.max(1, Math.ceil(retryAfter));
  return new Response(JSON.stringify(publicErrorBody({
    message: error,
    status,
    ...(cause === undefined ? {} : { cause, retryAfterSeconds })
  })), {
    status,
    headers: {
      ...scanCorsHeaders(request.headers.get("origin"), allowedOrigin),
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "retry-after": String(retryAfterSeconds),
      "x-content-type-options": "nosniff"
    }
  });
}
