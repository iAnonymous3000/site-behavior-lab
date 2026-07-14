// Front Worker for the Cloudflare Containers deployment of the full Node/Playwright
// scanner, the path that runs *live* Brave Shields (tried-vs-blocked). It runs the
// repo Dockerfile as a Cloudflare Container and forwards requests to it.
//
// This Worker is the edge enforcement point: before a scan reaches the container's
// real Chromium it applies access-token, Turnstile, and KV rate-limit gating
// (shared with cloudflare/worker.ts via lib/edge-scan-gate.ts). Everything else
// (health, report reads, CORS preflight) forwards straight through.
//
// Deployed separately (wrangler.container.jsonc) from cloudflare/worker.ts (the
// Browser Run GPC worker), so the existing live GPC worker is untouched.
// Full runbook: docs/go-live-public-scanner.md
import { Container, getContainer } from "@cloudflare/containers";
import { scanCorsHeaders } from "../lib/cors";
import { scansAvailableAfterEdgeOverlay } from "../lib/container-health-overlay";
import { PublicFacingError } from "../lib/public-errors";
import {
  DEFAULT_PUBLIC_SCAN_RATE_LIMIT_PER_DAY,
  DEFAULT_PUBLIC_SCAN_RATE_LIMIT_PER_MINUTE,
  EdgeScanGateError,
  assertTurnstileToken,
  formatPublicScanRetryAfter,
  openScanBlockedForMissingTurnstile,
  publicClientHash,
  publicScanGateStatus,
  publicScanRateLimit,
  publicScanRefusalReasons,
  readRequestBodyWithinLimit,
  scanAccessTokenMatches,
  scanTokenCost,
  withPublicScanAccessCheck
} from "../lib/edge-scan-gate";
import {
  findDurableScanJob,
  recordAcceptedScanJob,
  registerDurableScanJob,
  scanJobIdFromPath,
  type DurableScanJobRegistration
} from "../lib/durable-scan-job-registry";
import {
  recoverDurableScanJobCancellationResponse,
  recoverDurableScanJobResponse
} from "../lib/durable-scan-job-recovery";

type Env = {
  SCANNER: DurableObjectNamespace<ScannerContainer>;
  // Non-secret browser CORS allow-list, set via `vars` in wrangler.container.jsonc.
  SITE_BEHAVIOR_LAB_ALLOWED_ORIGIN?: string;
  // "1" opens the scanner to unauthenticated public scans (Turnstile + rate limit
  // then apply). Unset/anything else keeps it operator-gated behind the token.
  SITE_BEHAVIOR_LAB_ALLOW_UNAUTHENTICATED_SCANS?: string;
  SITE_BEHAVIOR_LAB_PUBLIC_SCAN_RATE_LIMIT_PER_MINUTE?: string;
  SITE_BEHAVIOR_LAB_PUBLIC_SCAN_RATE_LIMIT_PER_DAY?: string;
  // Forwarded to the Node scanner. Only "1" enables Playwright's Chromium
  // sandbox; /api/health exposes the effective state for deployment checks.
  SITE_BEHAVIOR_LAB_CHROMIUM_SANDBOX?: string;
  SITE_BEHAVIOR_LAB_CONSENT_VERIFICATION?: string;
  SITE_BEHAVIOR_LAB_PUBLIC_R2_REPORTS?: string;
  SITE_BEHAVIOR_LAB_V2_SHADOW_EMISSION?: string;
  // "1" waives the Turnstile requirement for open access (atomic rate limit only).
  // Without it, open access with no TURNSTILE_SECRET_KEY fails closed.
  SITE_BEHAVIOR_LAB_ACCEPT_NO_TURNSTILE_RISK?: string;
  // Set as Worker secrets (`wrangler secret put -c wrangler.container.jsonc <NAME>`)
  // and forwarded into the container via envVars below.
  SITE_BEHAVIOR_LAB_SCAN_ACCESS_TOKEN?: string;
  TURNSTILE_SECRET_KEY?: string;
  SITE_BEHAVIOR_LAB_R2_ENDPOINT?: string;
  SITE_BEHAVIOR_LAB_R2_ACCESS_KEY_ID?: string;
  SITE_BEHAVIOR_LAB_R2_SECRET_ACCESS_KEY?: string;
};

// Mirrors the scan fields the edge gate needs from the request body.
type ScanGatePayload = {
  compareGpc?: unknown;
  compareShields?: unknown;
  compareConsent?: unknown;
  turnstileToken?: unknown;
};

const MAX_BODY_BYTES = 4_096;

type AtomicRateLimitResult =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

export class ScannerContainer extends Container<Env> {
  // The Dockerfile serves Next.js on :3000.
  defaultPort = 3000;
  // Keep the instance (and its warm Chromium) alive between scans; it scales to
  // zero after this idle window. Raise for fewer cold starts, lower to save cost.
  sleepAfter = "15m";

  // Non-secret config plus secrets sourced from Worker secrets, passed to the
  // container process. Reports go to R2 because container disk is ephemeral.
  envVars = {
    SITE_BEHAVIOR_LAB_REPORT_STORE_BACKEND: "r2",
    SITE_BEHAVIOR_LAB_R2_BUCKET: "site-behavior-lab-reports",
    SITE_BEHAVIOR_LAB_R2_PREFIX: "reports/",
    SITE_BEHAVIOR_LAB_SCANNER_EGRESS: "cloudflare-containers",
    // This Worker is the only ingress and rewrites x-real-ip from the trusted
    // cf-connecting-ip on every forward (see forwardToContainer), so the container
    // can key its per-client rate limits on the real caller instead of collapsing
    // every reader into one shared "local" bucket.
    SITE_BEHAVIOR_LAB_TRUST_PROXY_HEADERS: "1",
    // Browser CORS allow-list for the scan API. Pin to the Pages origin that calls
    // this scanner (set via `vars` in wrangler.container.jsonc); "*" allows any
    // origin, which is safe here because the scan API uses no cookies.
    SITE_BEHAVIOR_LAB_ALLOWED_ORIGIN: this.env.SITE_BEHAVIOR_LAB_ALLOWED_ORIGIN ?? "*",
    // Long Shields scans return 202 + jobId instead of holding the connection.
    SITE_BEHAVIOR_LAB_ASYNC_SCANS: "1",
    SITE_BEHAVIOR_LAB_CHROMIUM_SANDBOX: this.env.SITE_BEHAVIOR_LAB_CHROMIUM_SANDBOX ?? "",
    // Shadow output is always the operator-only R2 prefix in Containers; the
    // two rollout flags remain off unless explicitly set at the Worker boundary.
    // Bucket-level public access is an operator preflight in the runbook.
    SITE_BEHAVIOR_LAB_V2_SHADOW_BACKEND: "r2",
    SITE_BEHAVIOR_LAB_CONSENT_VERIFICATION: this.env.SITE_BEHAVIOR_LAB_CONSENT_VERIFICATION ?? "",
    SITE_BEHAVIOR_LAB_PUBLIC_R2_REPORTS: this.env.SITE_BEHAVIOR_LAB_PUBLIC_R2_REPORTS ?? "",
    SITE_BEHAVIOR_LAB_V2_SHADOW_EMISSION: this.env.SITE_BEHAVIOR_LAB_V2_SHADOW_EMISSION ?? "",
    // The front Worker is the public gate, but the container also enforces the
    // token (defense in depth). Cloudflare's deny-by-default egress switch is
    // intentionally not enabled here: the app proxy opens raw TCP to a validated,
    // pinned public IP, which that switch blocks. See the deployment runbook.
    SITE_BEHAVIOR_LAB_SCAN_ACCESS_TOKEN: this.env.SITE_BEHAVIOR_LAB_SCAN_ACCESS_TOKEN ?? "",
    // Forwarded so the container's /api/health treats open access as intentional
    // (no "token not configured" degradation) instead of looking misconfigured.
    SITE_BEHAVIOR_LAB_ALLOW_UNAUTHENTICATED_SCANS: this.env.SITE_BEHAVIOR_LAB_ALLOW_UNAUTHENTICATED_SCANS ?? "",
    SITE_BEHAVIOR_LAB_R2_ENDPOINT: this.env.SITE_BEHAVIOR_LAB_R2_ENDPOINT ?? "",
    SITE_BEHAVIOR_LAB_R2_ACCESS_KEY_ID: this.env.SITE_BEHAVIOR_LAB_R2_ACCESS_KEY_ID ?? "",
    SITE_BEHAVIOR_LAB_R2_SECRET_ACCESS_KEY: this.env.SITE_BEHAVIOR_LAB_R2_SECRET_ACCESS_KEY ?? ""
  };

  /**
   * Exact public-scan quota accounting in the same singleton Durable Object
   * that owns the scanner container. SQLite and transactionSync make the
   * minute + day check-and-charge one atomic operation, so concurrent requests
   * cannot overshoot the configured token budget as they could with KV
   * read-then-write counters.
   */
  chargePublicScanRateLimit(input: {
    clientHash: string;
    cost: 1 | 2;
    perMinute: number;
    perDay: number;
    now: number;
  }): AtomicRateLimitResult {
    if (!/^[a-f0-9]{64}$/.test(input.clientHash)) {
      throw new Error("Invalid public-scan client hash.");
    }
    if ((input.cost !== 1 && input.cost !== 2) || !Number.isSafeInteger(input.now) || input.now < 0) {
      throw new Error("Invalid public-scan rate-limit charge.");
    }
    if (
      !Number.isSafeInteger(input.perMinute) ||
      input.perMinute <= 0 ||
      !Number.isSafeInteger(input.perDay) ||
      input.perDay <= 0
    ) {
      throw new Error("Invalid public-scan rate-limit configuration.");
    }

    return this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      sql.exec(
        "CREATE TABLE IF NOT EXISTS public_scan_rate_limits (bucket TEXT PRIMARY KEY, used INTEGER NOT NULL, expires_at INTEGER NOT NULL)"
      );
      sql.exec("DELETE FROM public_scan_rate_limits WHERE expires_at <= ?", input.now);

      const windows = [
        atomicRateLimitWindow("minute", 60_000, input.perMinute, input),
        atomicRateLimitWindow("day", 86_400_000, input.perDay, input)
      ];
      const exceeded: number[] = [];
      const charges: Array<{ bucket: string; used: number; expiresAt: number }> = [];

      for (const window of windows) {
        const row = sql
          .exec<{ used: number }>(
            "SELECT used FROM public_scan_rate_limits WHERE bucket = ? AND expires_at > ?",
            window.bucket,
            input.now
          )
          .toArray()[0];
        const used = row?.used ?? 0;
        if (used + input.cost > window.limit) {
          exceeded.push(window.retryAfterSeconds);
        } else {
          charges.push({ bucket: window.bucket, used: used + input.cost, expiresAt: window.expiresAt });
        }
      }

      if (exceeded.length > 0) {
        return { allowed: false, retryAfterSeconds: Math.max(...exceeded) };
      }

      for (const charge of charges) {
        sql.exec(
          "INSERT INTO public_scan_rate_limits (bucket, used, expires_at) VALUES (?, ?, ?) ON CONFLICT(bucket) DO UPDATE SET used = excluded.used, expires_at = excluded.expires_at",
          charge.bucket,
          charge.used,
          charge.expiresAt
        );
      }
      return { allowed: true };
    });
  }

  /**
   * Record only the submitter-held job capability and the separately minted
   * report capability. This registry survives a container process restart but
   * deliberately stores neither the scan target nor a client identifier.
   */
  registerScanJob(registration: DurableScanJobRegistration): void {
    this.ctx.storage.transactionSync(() => {
      registerDurableScanJob(this.ctx.storage.sql, registration);
    });
  }

  findRegisteredScanJob(jobId: string, now: number): DurableScanJobRegistration | null {
    return this.ctx.storage.transactionSync(() => findDurableScanJob(this.ctx.storage.sql, jobId, now));
  }
}

function atomicRateLimitWindow(
  name: "minute" | "day",
  durationMs: number,
  limit: number,
  input: { clientHash: string; now: number }
): { bucket: string; expiresAt: number; limit: number; retryAfterSeconds: number } {
  const windowId = Math.floor(input.now / durationMs);
  const expiresAt = (windowId + 1) * durationMs;
  return {
    bucket: `${name}/${windowId}/${input.clientHash}`,
    expiresAt,
    limit,
    retryAfterSeconds: Math.max(1, Math.ceil((expiresAt - input.now) / 1_000))
  };
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // This origin is the scan API + report-page backend, not a front door. Send
    // anyone landing on its root to the public site so they never hit the
    // container's own scan form (which has no Turnstile site key for this host
    // and so cannot scan). /api/*, /reports/:id, /_next/* and the rest still
    // serve from the container, so shared report links keep working.
    if (request.method === "GET" && url.pathname === "/") {
      const frontDoor = frontDoorOrigin(env);
      if (frontDoor) {
        return Response.redirect(frontDoor, 302);
      }
    }

    // Health: the container's Node app has no Turnstile concept and cannot see
    // the front Worker's open-access/Turnstile config, so overlay the edge gate's
    // own view onto its response, otherwise the UI never shows the Turnstile
    // widget the gate then requires, and every public scan 400s.
    if (request.method === "GET" && url.pathname === "/api/health") {
      return patchHealthResponse(await forwardToContainer(request, env), env);
    }

    const isScan = request.method === "POST" && url.pathname === "/api/scan";
    const scanJobId =
      request.method === "GET" || request.method === "DELETE" ? scanJobIdFromPath(url.pathname) : null;

    if (scanJobId) {
      const response = await forwardToContainer(request, env);
      if (response.status !== 404) return response;
      return recoverRegisteredScanJob(request, env, scanJobId, response);
    }

    // Report reads and CORS preflight forward straight to the container.
    if (!isScan) {
      return forwardToContainer(request, env);
    }

    // Read the scan body once: the gate inspects it, then it is forwarded
    // verbatim. The size cap is enforced before buffering (declared length
    // short-circuits, chunked bodies stream through the cap), so a tokenless
    // caller cannot force a large allocation just by posting one.
    const body = await readRequestBodyWithinLimit(request, MAX_BODY_BYTES);
    if (body === null) {
      return gateErrorResponse(new EdgeScanGateError("The scan request is too large.", 413), request, env);
    }

    try {
      await gateScanRequest(request, body, env);
    } catch (error) {
      return gateErrorResponse(error, request, env);
    }

    const forwarded = new Request(request.url, { method: "POST", headers: request.headers, body });
    const response = await forwardToContainer(forwarded, env);
    ctx.waitUntil(
      recordAcceptedScanJob(
        response,
        body,
        (registration) => getContainer(env.SCANNER).registerScanJob(registration),
        (error) => console.error("Could not register an accepted scan job in Durable Object storage.", error)
      )
    );
    return response;
  }
} satisfies ExportedHandler<Env>;

async function recoverRegisteredScanJob(
  request: Request,
  env: Env,
  jobId: string,
  missingJobResponse: Response
): Promise<Response> {
  const findRegistration = (id: string) => getContainer(env.SCANNER).findRegisteredScanJob(id, Date.now());
  const onRegistryError = (error: unknown) => console.error("Could not read the durable scan-job registry.", error);

  if (request.method === "DELETE") {
    return recoverDurableScanJobCancellationResponse(jobId, missingJobResponse, {
      findRegistration,
      onRegistryError
    });
  }

  return recoverDurableScanJobResponse(jobId, missingJobResponse, {
    findRegistration,
    fetchReport: (reportId) => {
      const reportUrl = new URL(request.url);
      reportUrl.pathname = `/api/reports/${reportId}`;
      reportUrl.search = "";
      const headers = new Headers(request.headers);
      headers.delete("content-length");
      headers.delete("content-type");
      return forwardToContainer(new Request(reportUrl, { method: "GET", headers }), env);
    },
    onRegistryError,
    onReportError: (error) => console.error("Could not probe a saved report during scan-job recovery.", error)
  });
}

function forwardToContainer(request: Request, env: Env): Promise<Response> {
  // The container trusts x-real-ip for per-client rate limiting
  // (SITE_BEHAVIOR_LAB_TRUST_PROXY_HEADERS=1). This Worker is the only ingress, so
  // strip any client-supplied forwarding headers (anti-spoof) and set x-real-ip
  // from Cloudflare's cf-connecting-ip. Without this, report/status reads and the
  // container's own scan limiter collapse to one shared bucket for all clients.
  const headers = new Headers(request.headers);
  headers.delete("x-real-ip");
  headers.delete("x-forwarded-for");
  const clientIp = request.headers.get("cf-connecting-ip")?.trim();
  if (clientIp) headers.set("x-real-ip", clientIp);

  // One warm singleton instance keeps the scanner's in-memory async job queue
  // coherent (a client polls /api/scans/:id on the same instance). Shard on a
  // key here once a single instance is not enough.
  return getContainer(env.SCANNER).fetch(new Request(request, { headers }));
}

/** Public front-door origin to redirect the backend root to, from the configured allow-list origin. */
function frontDoorOrigin(env: Env): string | null {
  const origin = env.SITE_BEHAVIOR_LAB_ALLOWED_ORIGIN?.trim();
  if (!origin || origin === "*") return null;
  try {
    const url = new URL(origin);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return `${url.origin}/`;
  } catch {
    return null;
  }
}

/** Overlay the front Worker's gate decision (auth / open access / Turnstile) onto the container health. */
async function patchHealthResponse(response: Response, env: Env): Promise<Response> {
  const text = await response.text();
  let body = text;

  try {
    const health = JSON.parse(text) as Record<string, unknown>;
    if (health && typeof health === "object") {
      const gate = publicScanGateStatus({
        accessToken: env.SITE_BEHAVIOR_LAB_SCAN_ACCESS_TOKEN,
        allowUnauthenticated: env.SITE_BEHAVIOR_LAB_ALLOW_UNAUTHENTICATED_SCANS,
        turnstileSecret: env.TURNSTILE_SECRET_KEY
      });
      health.authenticated = gate.authenticated;
      health.openAccess = gate.openAccess;
      health.turnstile = gate.turnstile;
      // A configuration that refuses EVERY scan must never present as a green
      // scanner: surface the exact fail-closed reasons and degrade the status.
      const refusals = publicScanRefusalReasons({
        accessToken: env.SITE_BEHAVIOR_LAB_SCAN_ACCESS_TOKEN,
        allowUnauthenticated: env.SITE_BEHAVIOR_LAB_ALLOW_UNAUTHENTICATED_SCANS,
        turnstileSecret: env.TURNSTILE_SECRET_KEY,
        acceptNoTurnstileRisk: env.SITE_BEHAVIOR_LAB_ACCEPT_NO_TURNSTILE_RISK,
        // The SCANNER binding is required by this Worker and owns an atomic
        // SQLite quota ledger, so an external KV binding is no longer needed.
        rateLimitStoreBound: true
      });
      health.scansAvailable = scansAvailableAfterEdgeOverlay(health.scansAvailable, refusals);
      health.checks = withPublicScanAccessCheck(health.checks, gate, refusals);
      if (refusals.length > 0) {
        health.status = "degraded";
        health.warnings = [...(Array.isArray(health.warnings) ? health.warnings : []), ...refusals];
      }
      health.limits = {
        ...(typeof health.limits === "object" && health.limits ? health.limits : {}),
        publicScanRateLimitPerMinute: publicScanRateLimit(
          env.SITE_BEHAVIOR_LAB_PUBLIC_SCAN_RATE_LIMIT_PER_MINUTE,
          DEFAULT_PUBLIC_SCAN_RATE_LIMIT_PER_MINUTE
        ),
        publicScanRateLimitPerDay: publicScanRateLimit(
          env.SITE_BEHAVIOR_LAB_PUBLIC_SCAN_RATE_LIMIT_PER_DAY,
          DEFAULT_PUBLIC_SCAN_RATE_LIMIT_PER_DAY
        )
      };
      body = JSON.stringify(health);
    }
  } catch {
    // Non-JSON health (e.g. an error page) passes through untouched.
  }

  // Preserve the container's headers (CORS, content-type); drop the now-stale length.
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(body, { status: response.status, headers });
}

/**
 * Edge abuse-control policy for the Containers scanner.
 *
 * - Token configured  → operator-gated: require the matching access token.
 * - No token + opened  → public: require Turnstile (when configured) and charge
 *   the per-client atomic Durable Object rate limit.
 * - No token + not opened → refuse, so an unconfigured scanner is never silently
 *   world-readable through its workers.dev URL.
 *
 * Unlike the Browser Run worker, the Node container pins DNS at connect time, so
 * opening it does not require the Browser Run DNS-rebinding risk acknowledgement.
 */
async function gateScanRequest(request: Request, body: string, env: Env): Promise<void> {
  const expectedToken = env.SITE_BEHAVIOR_LAB_SCAN_ACCESS_TOKEN?.trim();
  if (expectedToken) {
    if (!(await scanAccessTokenMatches(request.headers, expectedToken))) {
      throw new EdgeScanGateError("Unauthorized scan request.", 401);
    }
    return;
  }

  if (env.SITE_BEHAVIOR_LAB_ALLOW_UNAUTHENTICATED_SCANS !== "1") {
    throw new EdgeScanGateError(
      "This scanner is not configured for public scans. Set an access token, or set SITE_BEHAVIOR_LAB_ALLOW_UNAUTHENTICATED_SCANS=1 to open it.",
      503
    );
  }

  const payload = parseScanGatePayload(body);

  const secret = env.TURNSTILE_SECRET_KEY?.trim();
  if (secret) {
    const token =
      typeof payload.turnstileToken === "string" ? payload.turnstileToken : request.headers.get("cf-turnstile-response") || "";
    await assertTurnstileToken({ secret, token, remoteIp: request.headers.get("cf-connecting-ip") });
  } else if (
    openScanBlockedForMissingTurnstile({
      turnstileSecret: secret,
      acceptNoTurnstileRisk: env.SITE_BEHAVIOR_LAB_ACCEPT_NO_TURNSTILE_RISK
    })
  ) {
    throw new EdgeScanGateError(
      "Public scans require Turnstile. Set TURNSTILE_SECRET_KEY, or set SITE_BEHAVIOR_LAB_ACCEPT_NO_TURNSTILE_RISK=1 to open without it.",
      503
    );
  }

  const charge = await getContainer(env.SCANNER).chargePublicScanRateLimit({
    clientHash: await publicClientHash(request.headers),
    cost: scanTokenCost({
      compareGpc: payload.compareGpc === true,
      compareShields: payload.compareShields === true,
      compareConsent: payload.compareConsent === true
    }),
    perMinute: publicScanRateLimit(env.SITE_BEHAVIOR_LAB_PUBLIC_SCAN_RATE_LIMIT_PER_MINUTE, DEFAULT_PUBLIC_SCAN_RATE_LIMIT_PER_MINUTE),
    perDay: publicScanRateLimit(env.SITE_BEHAVIOR_LAB_PUBLIC_SCAN_RATE_LIMIT_PER_DAY, DEFAULT_PUBLIC_SCAN_RATE_LIMIT_PER_DAY),
    now: Date.now()
  });
  if (!charge.allowed) {
    throw new EdgeScanGateError(
      `Too many public scans. Try again in about ${formatPublicScanRetryAfter(charge.retryAfterSeconds)}.`,
      429
    );
  }
}

function parseScanGatePayload(body: string): ScanGatePayload {
  try {
    const parsed: unknown = JSON.parse(body);
    return parsed && typeof parsed === "object" ? (parsed as ScanGatePayload) : {};
  } catch {
    // A malformed body cannot scan; the container returns the proper 400. Treat it
    // as a minimum-cost request with no Turnstile token for gating purposes.
    return {};
  }
}

function gateErrorResponse(error: unknown, request: Request, env: Env): Response {
  const status = error instanceof PublicFacingError ? error.status : 500;
  const message = error instanceof Error ? error.message : "The scan request was rejected.";
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status,
    headers: {
      ...scanCorsHeaders(request.headers.get("origin"), env.SITE_BEHAVIOR_LAB_ALLOWED_ORIGIN),
      "Content-Type": "application/json; charset=utf-8"
    }
  });
}
