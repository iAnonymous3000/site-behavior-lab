// Front Worker for the Cloudflare Containers deployment of the full Node/Playwright
// scanner — the path that runs *live* Brave Shields (tried-vs-blocked). It runs the
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
import { PublicFacingError } from "../lib/public-errors";
import {
  DEFAULT_PUBLIC_SCAN_RATE_LIMIT_PER_DAY,
  DEFAULT_PUBLIC_SCAN_RATE_LIMIT_PER_MINUTE,
  EdgeScanGateError,
  assertTurnstileToken,
  enforcePublicScanRateLimit,
  publicClientHash,
  publicScanRateLimit,
  scanAccessTokenMatches,
  scanTokenCost
} from "../lib/edge-scan-gate";

type Env = {
  SCANNER: DurableObjectNamespace<ScannerContainer>;
  // KV namespace for public-scan rate limiting. Required only when the scanner is
  // opened to the public (SITE_BEHAVIOR_LAB_ALLOW_UNAUTHENTICATED_SCANS=1).
  RATE_LIMITS_KV?: KVNamespace;
  // Non-secret browser CORS allow-list, set via `vars` in wrangler.container.jsonc.
  SITE_BEHAVIOR_LAB_ALLOWED_ORIGIN?: string;
  // "1" opens the scanner to unauthenticated public scans (Turnstile + rate limit
  // then apply). Unset/anything else keeps it operator-gated behind the token.
  SITE_BEHAVIOR_LAB_ALLOW_UNAUTHENTICATED_SCANS?: string;
  SITE_BEHAVIOR_LAB_PUBLIC_SCAN_RATE_LIMIT_PER_MINUTE?: string;
  SITE_BEHAVIOR_LAB_PUBLIC_SCAN_RATE_LIMIT_PER_DAY?: string;
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
  turnstileToken?: unknown;
};

const MAX_BODY_BYTES = 4_096;

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
    // Browser CORS allow-list for the scan API. Pin to the Pages origin that calls
    // this scanner (set via `vars` in wrangler.container.jsonc); "*" allows any
    // origin, which is safe here because the scan API uses no cookies.
    SITE_BEHAVIOR_LAB_ALLOWED_ORIGIN: this.env.SITE_BEHAVIOR_LAB_ALLOWED_ORIGIN ?? "*",
    // Long Shields scans return 202 + jobId instead of holding the connection.
    SITE_BEHAVIOR_LAB_ASYNC_SCANS: "1",
    // The front Worker is the public gate, but the container also enforces the
    // token (defense in depth): managed containers have no external egress
    // firewall, so the in-app connect-time proxy is the only SSRF backstop.
    SITE_BEHAVIOR_LAB_SCAN_ACCESS_TOKEN: this.env.SITE_BEHAVIOR_LAB_SCAN_ACCESS_TOKEN ?? "",
    SITE_BEHAVIOR_LAB_R2_ENDPOINT: this.env.SITE_BEHAVIOR_LAB_R2_ENDPOINT ?? "",
    SITE_BEHAVIOR_LAB_R2_ACCESS_KEY_ID: this.env.SITE_BEHAVIOR_LAB_R2_ACCESS_KEY_ID ?? "",
    SITE_BEHAVIOR_LAB_R2_SECRET_ACCESS_KEY: this.env.SITE_BEHAVIOR_LAB_R2_SECRET_ACCESS_KEY ?? ""
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const isScan = request.method === "POST" && url.pathname === "/api/scan";

    // Health, report reads, and CORS preflight forward straight to the container.
    if (!isScan) {
      return forwardToContainer(request, env);
    }

    // Read the scan body once: the gate inspects it, then it is forwarded verbatim.
    const body = await request.text();
    if (new Blob([body]).size > MAX_BODY_BYTES) {
      return gateErrorResponse(new EdgeScanGateError("The scan request is too large.", 413), request, env);
    }

    try {
      await gateScanRequest(request, body, env);
    } catch (error) {
      return gateErrorResponse(error, request, env);
    }

    const forwarded = new Request(request.url, { method: "POST", headers: request.headers, body });
    return forwardToContainer(forwarded, env);
  }
} satisfies ExportedHandler<Env>;

function forwardToContainer(request: Request, env: Env): Promise<Response> {
  // One warm singleton instance keeps the scanner's in-memory async job queue
  // coherent (a client polls /api/scans/:id on the same instance). Shard on a
  // key here once a single instance is not enough.
  return getContainer(env.SCANNER).fetch(request);
}

/**
 * Edge abuse-control policy for the Containers scanner.
 *
 * - Token configured  → operator-gated: require the matching access token.
 * - No token + opened  → public: require Turnstile (when configured) and charge
 *   the per-client KV rate limit.
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
  }

  const store = env.RATE_LIMITS_KV;
  if (!store) {
    throw new EdgeScanGateError("Public scan rate limiting requires the RATE_LIMITS_KV binding.", 503);
  }

  await enforcePublicScanRateLimit({
    store,
    clientHash: await publicClientHash(request.headers),
    cost: scanTokenCost({ compareGpc: payload.compareGpc === true, compareShields: payload.compareShields === true }),
    perMinute: publicScanRateLimit(env.SITE_BEHAVIOR_LAB_PUBLIC_SCAN_RATE_LIMIT_PER_MINUTE, DEFAULT_PUBLIC_SCAN_RATE_LIMIT_PER_MINUTE),
    perDay: publicScanRateLimit(env.SITE_BEHAVIOR_LAB_PUBLIC_SCAN_RATE_LIMIT_PER_DAY, DEFAULT_PUBLIC_SCAN_RATE_LIMIT_PER_DAY)
  });
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
