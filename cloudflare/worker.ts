/// <reference types="@cloudflare/workers-types" />

import {
  launch,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type BrowserWorker,
  type Page,
  type Request as PlaywrightRequest
} from "@cloudflare/playwright";
import { createGpcComparisonReport } from "../lib/compare-reports";
import { isThirdParty } from "../lib/domain-utils";
import { producerCapability } from "../lib/report-producers";
import { buildReportShare } from "../lib/report-locator";
import { scanCorsHeaders } from "../lib/cors";
import { scanTokenFromHeaders } from "../lib/scan-token";
import { asScanRuntimeHealth } from "../lib/scan-runtime-health";
import { collectFingerprintObservationsFromFrames, fingerprintObserverInitScript } from "../lib/fingerprint-observer";
import { safeParseUrl } from "../lib/report-url";
import {
  collectStorageEntries,
  MAX_RECORDED_REQUESTS,
  ScanNetworkRecorder,
  scanTimeoutMs,
  ScanWarningCollector,
  verifyRoutedHttpRequest,
  withScanDeadline
} from "../lib/scan-runtime";
import { buildScanConditions, buildScanResult } from "../lib/scan-result-builder";
import type {
  CookieRecord,
  ScanDevice,
  ScanRequestPayload,
  ScanReport,
  ScanResult
} from "../lib/types";
import { normalizeHttpUrlInput } from "../lib/url-normalization";
import { PublicFacingError } from "../lib/public-errors";
import {
  assertEdgePublicHttpUrl,
  assertEdgePublicHttpUrlShape,
  EdgeUrlSafetyError
} from "../lib/edge-url-safety";
import {
  DEFAULT_PUBLIC_SCAN_RATE_LIMIT_PER_DAY,
  DEFAULT_PUBLIC_SCAN_RATE_LIMIT_PER_MINUTE,
  assertTurnstileToken,
  constantTimeEqual,
  enforcePublicScanRateLimit,
  publicClientHash,
  publicScanRateLimit,
  scanTokenCost
} from "../lib/edge-scan-gate";

type Env = {
  BROWSER: BrowserWorker;
  REPORTS?: R2Bucket;
  REPORTS_KV?: KVNamespace;
  SITE_BEHAVIOR_LAB_SCAN_ACCESS_TOKEN?: string;
  SITE_BEHAVIOR_LAB_ALLOW_UNAUTHENTICATED_SCANS?: string;
  SITE_BEHAVIOR_LAB_ACCEPT_BROWSER_RUN_DNS_REBINDING_RISK?: string;
  SITE_BEHAVIOR_LAB_ALLOWED_ORIGIN?: string;
  SITE_BEHAVIOR_LAB_SCANNER_EGRESS?: string;
  SITE_BEHAVIOR_LAB_DNS_RESOLVER_URL?: string;
  SITE_BEHAVIOR_LAB_PUBLIC_SCAN_RATE_LIMIT_PER_MINUTE?: string;
  SITE_BEHAVIOR_LAB_PUBLIC_SCAN_RATE_LIMIT_PER_DAY?: string;
  TURNSTILE_SECRET_KEY?: string;
};

type IncomingScanPayload = {
  url?: unknown;
  device?: unknown;
  gpcEnabled?: unknown;
  compareGpc?: unknown;
  compareShields?: unknown;
  turnstileToken?: unknown;
};

type NormalizedScanRequest = {
  payload: ScanRequestPayload;
  compareGpc: boolean;
};

type WorkerRoute =
  | { kind: "health" }
  | { kind: "scan" }
  | { kind: "report"; reportId: string }
  | { kind: "not-found" };

const REPORT_BUCKET_PREFIX = "reports";
const MAX_BODY_BYTES = 4_096;
const MAX_SCAN_DURATION_MS = 45_000;
const MAX_COMPARISON_DURATION_MS = 90_000;
const NAVIGATION_TIMEOUT_MS = 30_000;
const NETWORK_IDLE_TIMEOUT_MS = 8_000;
const DESKTOP_VIEWPORT = { width: 1440, height: 980 };
const MOBILE_VIEWPORT = { width: 390, height: 844 };
const REPORT_ID_PATTERN = /^\d{8}-[a-f0-9]{32}$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders(request, env) });

    const url = new URL(request.url);
    const route = matchWorkerRoute(request, url);

    try {
      switch (route.kind) {
        case "health":
          return jsonResponse(workerHealth(env), request, env);
        case "scan":
          return runWorkerScanRoute(request, env);
        case "report": {
          const report = await readReport(route.reportId, env);
          if (!report) throw new HttpError("Report not found.", 404);
          return jsonResponse(report, request, env);
        }
        case "not-found":
          throw new HttpError("Not found.", 404);
      }
    } catch (error) {
      const status = error instanceof PublicFacingError ? error.status : 500;
      const message = error instanceof Error ? error.message : "The scan failed.";
      return jsonResponse({ ok: false, error: message }, request, env, status);
    }
  }
};

function matchWorkerRoute(request: Request, url: URL): WorkerRoute {
  if (request.method === "GET" && url.pathname === "/api/health") return { kind: "health" };
  if (request.method === "POST" && url.pathname === "/api/scan") return { kind: "scan" };

  const reportId = request.method === "GET" ? matchReportId(url.pathname) : null;
  if (reportId) return { kind: "report", reportId };

  return { kind: "not-found" };
}

function workerHealth(env: Env) {
  // Report readiness honestly: every state below later throws from `/api/scan`
  // (sometimes only after a Browser Run scan has already completed), so health
  // must not advertise scan capability the Worker cannot deliver.
  const issues = workerScanReadinessIssues(env);
  const ready = issues.length === 0;
  // Advertise capabilities from the shared producer matrix so worker health and
  // the documented capability contract cannot drift; readiness still gates the
  // scan-dependent ones.
  const capability = producerCapability("cloudflare-worker");

  return asScanRuntimeHealth({
    ok: ready,
    runtime: "cloudflare-worker",
    scanner: "cloudflare-browser-run",
    status: ready ? "ok" : "error",
    deployment: "production",
    storage: env.REPORTS ? "r2" : env.REPORTS_KV ? "kv" : "none",
    authenticated: Boolean(env.SITE_BEHAVIOR_LAB_SCAN_ACCESS_TOKEN?.trim()) && !openAccessEnabled(env),
    openAccessRequested: openAccessRequested(env),
    openAccess: openAccessEnabled(env),
    turnstile: Boolean(env.TURNSTILE_SECRET_KEY?.trim()) && !openAccessEnabled(env),
    ...(ready ? {} : { error: issues[0], configIssues: issues }),
    capabilities: {
      singleScan: ready && capability.singleScan,
      gpcComparison: ready && capability.gpcComparison,
      shieldsComparison: capability.shieldsComparison,
      savedReports: Boolean(env.REPORTS || env.REPORTS_KV),
      // API-only: this Worker exposes /api/reports/:id JSON but no /reports/:id
      // page, so a freshly scanned report has no shareable permalink here.
      savedReportPages: false
    },
    security: {
      dnsRebindingGuard: "doh-preflight-only",
      connectTimeDnsPinning: false,
      openAccessRiskAccepted: edgeOpenAccessRiskAccepted(env)
    },
    knownLimitations: [
      "Cloudflare Browser Run performs its own connection-time DNS resolution; this Worker verifies DNS answers before navigation and resource loading but cannot currently pin the browser connection to the verified IP."
    ],
    limits: {
      maxBodyBytes: MAX_BODY_BYTES,
      maxRecordedRequests: MAX_RECORDED_REQUESTS,
      maxScanDurationMs: MAX_SCAN_DURATION_MS,
      maxComparisonDurationMs: MAX_COMPARISON_DURATION_MS,
      publicScanRateLimitPerMinute: publicScanRateLimitPerMinute(env),
      publicScanRateLimitPerDay: publicScanRateLimitPerDay(env)
    }
  });
}

// Mirror the hard failures that `/api/scan` raises so health can flag a Worker
// that would accept a scan request and then reject it (or fail after the scan).
function workerScanReadinessIssues(env: Env): string[] {
  const issues: string[] = [];

  if (openAccessRequested(env) && !edgeOpenAccessRiskAccepted(env)) {
    // assertScanAccess rejects every request in this state.
    issues.push(
      "Open public scans are requested but SITE_BEHAVIOR_LAB_ACCEPT_BROWSER_RUN_DNS_REBINDING_RISK=1 is not set, so every scan is rejected."
    );
  } else if (openAccessEnabled(env)) {
    // assertPublicScanRateLimit requires KV for open-access quota tracking.
    if (!env.REPORTS_KV) {
      issues.push("Open public scans require the REPORTS_KV binding for per-client rate limiting.");
    }
  } else if (!env.SITE_BEHAVIOR_LAB_SCAN_ACCESS_TOKEN?.trim()) {
    // assertScanAccess rejects gated scans when no token is configured.
    issues.push("Authenticated scans require the SITE_BEHAVIOR_LAB_SCAN_ACCESS_TOKEN secret.");
  }

  // saveReport throws after the scan runs when no report store is bound.
  if (!env.REPORTS && !env.REPORTS_KV) {
    issues.push("Report storage is not configured; bind REPORTS (R2) or REPORTS_KV (KV).");
  }

  return issues;
}

async function runWorkerScanRoute(request: Request, env: Env): Promise<Response> {
  await assertScanAccess(request, env);
  const incomingPayload = await readScanPayload(request);
  await verifyTurnstile(request, env, incomingPayload);

  const normalized = normalizeScanRequest(incomingPayload);
  await assertPublicScanRateLimit(request, env, scanTokenCost({ compareGpc: normalized.compareGpc }));
  const report = await runWorkerScan(normalized, env);
  const saved = await saveReport(report, env);
  return jsonResponse(saved, request, env);
}

async function readScanPayload(request: Request): Promise<IncomingScanPayload> {
  const body = await request.text();
  if (new Blob([body]).size > MAX_BODY_BYTES) {
    throw new HttpError("The scan request is too large.", 413);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new HttpError("Send a JSON body with a url field.", 400);
  }

  if (!isObject(parsed)) {
    throw new HttpError("Send a JSON body with a url field.", 400);
  }

  return parsed as IncomingScanPayload;
}

function normalizeScanRequest(payload: IncomingScanPayload): NormalizedScanRequest {
  if (payload.compareShields === true) {
    throw new HttpError("Shields comparison is not enabled in the Cloudflare scanner yet.", 400);
  }

  if (typeof payload.url !== "string") {
    throw new HttpError("Enter a public URL to scan.", 400);
  }

  const url = normalizePublicUrl(payload.url);

  return {
    payload: {
      url: url.toString(),
      device: normalizeDevice(payload.device),
      gpcEnabled: payload.gpcEnabled === true,
      consentMode: "observe"
    },
    compareGpc: payload.compareGpc === true
  };
}

async function runWorkerScan(request: NormalizedScanRequest, env: Env): Promise<ScanReport> {
  if (!request.compareGpc) {
    return scanWithBrowserRun(request.payload, env);
  }

  const started = Date.now();
  const publicHostChecks = new Map<string, Promise<void>>();
  const targetUrl = normalizePublicUrl(request.payload.url);
  await withWorkerScanTimeout(assertWorkerPublicHttpUrl(targetUrl, env, publicHostChecks), started, MAX_COMPARISON_DURATION_MS);

  const browser = await withWorkerScanTimeout(launch(env.BROWSER), started, MAX_COMPARISON_DURATION_MS);
  try {
    const baseline = await scanWithBrowserSession(
      {
        ...request.payload,
        gpcEnabled: false
      },
      env,
      browser,
      publicHostChecks,
      MAX_COMPARISON_DURATION_MS,
      started
    );
    const variant = await scanWithBrowserSession(
      {
        ...request.payload,
        gpcEnabled: true
      },
      env,
      browser,
      publicHostChecks,
      MAX_COMPARISON_DURATION_MS,
      started
    );
    return createGpcComparisonReport(baseline, variant);
  } finally {
    await browser.close().catch(() => undefined);
  }
}

async function scanWithBrowserRun(payload: ScanRequestPayload, env: Env): Promise<ScanResult> {
  const started = Date.now();
  const publicHostChecks = new Map<string, Promise<void>>();
  const targetUrl = normalizePublicUrl(payload.url);
  await withWorkerScanTimeout(assertWorkerPublicHttpUrl(targetUrl, env, publicHostChecks), started, MAX_SCAN_DURATION_MS);

  const browser = await withWorkerScanTimeout(launch(env.BROWSER), started, MAX_SCAN_DURATION_MS);
  try {
    return await scanWithBrowserSession(payload, env, browser, publicHostChecks, MAX_SCAN_DURATION_MS, started);
  } finally {
    await browser.close().catch(() => undefined);
  }
}

async function scanWithBrowserSession(
  payload: ScanRequestPayload,
  env: Env,
  browser: Browser,
  publicHostChecks: Map<string, Promise<void>>,
  maxDurationMs: number,
  deadlineStarted: number
): Promise<ScanResult> {
  const scanStarted = Date.now();
  const targetUrl = normalizePublicUrl(payload.url);
  await withWorkerScanTimeout(assertWorkerPublicHttpUrl(targetUrl, env, publicHostChecks), deadlineStarted, maxDurationMs);
  const warnings = new ScanWarningCollector([
    "This Cloudflare report is one automated, headless Chromium visit from Cloudflare Browser Run. It does not scroll, click, sign in, or interact with consent prompts.",
    "This Cloudflare scanner verifies public URL shape and DNS answers before navigation and resource loading, but Browser Run performs its own connection-time DNS resolution and this Worker cannot currently pin the browser connection to the verified IP. Brave Shields block simulation is not enabled in this deployment."
  ]);

  let context: BrowserContext | null = null;

  try {
    context = await withWorkerScanTimeout(browser.newContext(createContextOptions(payload)), deadlineStarted, maxDurationMs);

    if (payload.gpcEnabled) {
      await withWorkerScanTimeout(
        context.addInitScript(() => {
          Object.defineProperty(navigator, "globalPrivacyControl", {
            configurable: true,
            get: () => true
          });
        }),
        deadlineStarted,
        maxDurationMs
      );
      await withWorkerScanTimeout(context.setExtraHTTPHeaders({ "Sec-GPC": "1" }), deadlineStarted, maxDurationMs);
    }

    const page = await withWorkerScanTimeout(context.newPage(), deadlineStarted, maxDurationMs);
    await withWorkerScanTimeout(installFingerprintObserver(page), deadlineStarted, maxDurationMs);

    const networkRecorder = new ScanNetworkRecorder<PlaywrightRequest>({
      firstPartyHostname: targetUrl.hostname,
      warnings
    });
    const requestsBlockedByGuard = new WeakSet<PlaywrightRequest>();

    await withWorkerScanTimeout(
      page.route("**/*", async (route) => {
        const request = route.request();
        const decision = await verifyRoutedHttpRequest({
          requestUrl: request.url(),
          warnings,
          requestBudget: networkRecorder.requestBudget,
          verifyPublicUrl: (url) => assertWorkerPublicHttpUrl(url, env, publicHostChecks),
          unverifiedWarning: "Blocked a request that could not be verified as a public HTTP(S) URL"
        });
        if (decision.action === "continue") {
          await route.continue();
          return;
        }

        // Requests aborted by the public-address guard never loaded, so keep
        // them out of the recorded log and request totals, mirroring the Node
        // scanner. They remain surfaced through scan warnings.
        requestsBlockedByGuard.add(request);
        networkRecorder.removeRequest(request);
        await route.abort();
      }),
      deadlineStarted,
      maxDurationMs
    );

    page.on("request", (request) => {
      if (requestsBlockedByGuard.has(request)) return;
      networkRecorder.recordRequest(request, Date.now() - scanStarted);
    });
    page.on("response", (response) => networkRecorder.recordResponse(response));

    const response = await withWorkerScanTimeout(
      page.goto(targetUrl.toString(), {
        waitUntil: "domcontentloaded",
        timeout: workerScanTimeout(deadlineStarted, maxDurationMs, NAVIGATION_TIMEOUT_MS)
      }),
      deadlineStarted,
      maxDurationMs
    );

    await withWorkerScanTimeout(
      page.waitForLoadState("networkidle", {
        timeout: workerScanTimeout(deadlineStarted, maxDurationMs, NETWORK_IDLE_TIMEOUT_MS)
      }),
      deadlineStarted,
      maxDurationMs
    ).catch((error) => {
      if (isWorkerScanTimeoutError(error)) throw error;
      warnings.add("The page did not reach network idle before the Cloudflare scan window ended.");
    });

    const pageTitle = await withWorkerScanTimeout(page.title(), deadlineStarted, maxDurationMs).catch((error) => {
      if (isWorkerScanTimeoutError(error)) throw error;
      return "";
    });
    const finalUrl = page.url();
    const finalParsed = safeParseUrl(finalUrl) ?? targetUrl;
    const cookies = await withWorkerScanTimeout(collectCookies(context, finalParsed.hostname), deadlineStarted, maxDurationMs);
    const storage = await withWorkerScanTimeout(collectStorageEntries(page), deadlineStarted, maxDurationMs);
    const fingerprintObservations = await withWorkerScanTimeout(collectFingerprintObservations(page), deadlineStarted, maxDurationMs);
    const screenshot = await withWorkerScanTimeout(
      page.screenshot({ type: "jpeg", quality: 62, fullPage: false }).then((bytes) => `data:image/jpeg;base64,${bytesToBase64(bytes)}`),
      deadlineStarted,
      maxDurationMs
    ).catch((error) => {
      if (isWorkerScanTimeoutError(error)) throw error;
      return null;
    });

    const publicRequests = networkRecorder.publicRecords(finalParsed.hostname);
    const conditions = buildScanConditions({
      profile: "cloudflare-browser-run",
      requestedUrl: targetUrl.toString(),
      finalUrl,
      scannedAt: new Date(scanStarted).toISOString(),
      chromiumVersion: browser.version(),
      userAgent: await withWorkerScanTimeout(page.evaluate(() => navigator.userAgent), deadlineStarted, maxDurationMs).catch(() => ""),
      timezone: "UTC",
      locale: "en-US",
      language: "en-US",
      viewport: {
        width: payload.device === "mobile" ? MOBILE_VIEWPORT.width : DESKTOP_VIEWPORT.width,
        height: payload.device === "mobile" ? MOBILE_VIEWPORT.height : DESKTOP_VIEWPORT.height,
        isMobile: payload.device === "mobile"
      },
      gpcEnabled: payload.gpcEnabled,
      scannerEgress: env.SITE_BEHAVIOR_LAB_SCANNER_EGRESS?.trim() || "cloudflare-browser-run"
    });

    return buildScanResult({
      pageTitle,
      status: response?.status() ?? null,
      durationMs: Date.now() - scanStarted,
      firstPartyDomain: finalParsed.hostname,
      conditions,
      requests: publicRequests,
      cookies,
      storage,
      fingerprintDetections: fingerprintObservations.detections,
      fingerprintEvents: fingerprintObservations.events,
      screenshot,
      warnings: warnings.list
    });
  } finally {
    await context?.close().catch(() => undefined);
  }
}

function createContextOptions(payload: ScanRequestPayload): BrowserContextOptions {
  const viewport = payload.device === "mobile" ? MOBILE_VIEWPORT : DESKTOP_VIEWPORT;

  return {
    viewport,
    isMobile: payload.device === "mobile",
    hasTouch: payload.device === "mobile",
    locale: "en-US",
    timezoneId: "UTC",
    colorScheme: "light",
    userAgent:
      payload.device === "mobile"
        ? "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"
        : "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
  };
}

async function installFingerprintObserver(page: Page): Promise<void> {
  await page.addInitScript(fingerprintObserverInitScript);
}

async function collectCookies(context: BrowserContext, finalHostname: string): Promise<CookieRecord[]> {
  const cookies = await context.cookies();
  return cookies.map((cookie) => {
    const domain = cookie.domain.replace(/^\./, "");
    return {
      name: cookie.name,
      domain: cookie.domain,
      path: cookie.path,
      sameSite: cookie.sameSite || "Unspecified",
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
      session: cookie.expires === -1,
      thirdParty: isThirdParty(finalHostname, domain)
    };
  });
}

async function collectFingerprintObservations(page: Page) {
  return collectFingerprintObservationsFromFrames(page.frames());
}

async function saveReport<T extends ScanReport>(report: T, env: Env): Promise<T> {
  const id = createReportId(reportScannedAt(report));
  const saved = {
    ...report,
    share: buildReportShare(id)
  };
  const persisted = stripScreenshotsForStorage(saved);

  if (env.REPORTS) {
    await env.REPORTS.put(reportKey(id), JSON.stringify(persisted, null, 2), {
      httpMetadata: { contentType: "application/json; charset=utf-8" }
    });
  } else if (env.REPORTS_KV) {
    await env.REPORTS_KV.put(reportKey(id), JSON.stringify(persisted, null, 2));
  } else {
    throw new HttpError("Report storage is not configured for this Worker.", 503);
  }

  return saved;
}

async function readReport(id: string, env: Env): Promise<ScanReport | null> {
  if (!REPORT_ID_PATTERN.test(id)) return null;
  if (env.REPORTS) {
    const object = await env.REPORTS.get(reportKey(id));
    if (!object) return null;
    return object.json<ScanReport>();
  }

  if (env.REPORTS_KV) {
    return env.REPORTS_KV.get<ScanReport>(reportKey(id), "json");
  }

  return null;
}

function reportScannedAt(report: ScanReport): string {
  return report.reportType === "comparison" ? report.scannedAt : report.conditions.scannedAt;
}

function stripScreenshotsForStorage<T extends ScanReport>(report: T): T {
  if (report.reportType === "comparison") {
    return {
      ...report,
      baseline: { ...report.baseline, screenshot: null },
      variant: { ...report.variant, screenshot: null }
    };
  }

  return {
    ...report,
    screenshot: null
  };
}

function createReportId(scannedAt: string): string {
  const yyyymmdd = scannedAt.slice(0, 10).replaceAll("-", "");
  const random = crypto.randomUUID().replaceAll("-", "");
  return `${yyyymmdd}-${random}`;
}

function reportKey(id: string): string {
  return `${REPORT_BUCKET_PREFIX}/${id}.json`;
}

function matchReportId(pathname: string): string | null {
  const match = pathname.match(/^\/api\/reports\/([a-zA-Z0-9-]+)$/);
  return match?.[1] || null;
}

async function assertScanAccess(request: Request, env: Env): Promise<void> {
  if (openAccessRequested(env) && !edgeOpenAccessRiskAccepted(env)) {
    throw new HttpError(
      "Open public scans are disabled until SITE_BEHAVIOR_LAB_ACCEPT_BROWSER_RUN_DNS_REBINDING_RISK=1 is set for this Worker.",
      503
    );
  }

  if (openAccessEnabled(env)) return;

  const expected = env.SITE_BEHAVIOR_LAB_SCAN_ACCESS_TOKEN?.trim();
  if (!expected) {
    throw new HttpError("Scan access token is not configured for this Worker.", 503);
  }

  const supplied = scanTokenFromHeaders(request.headers);

  if (!supplied || !(await constantTimeEqual(supplied, expected))) {
    throw new HttpError("Unauthorized scan request.", 401);
  }
}

async function verifyTurnstile(request: Request, env: Env, payload: IncomingScanPayload): Promise<void> {
  if (openAccessEnabled(env)) return;

  const secret = env.TURNSTILE_SECRET_KEY?.trim();
  if (!secret) return;

  const token =
    typeof payload.turnstileToken === "string" ? payload.turnstileToken : request.headers.get("cf-turnstile-response") || "";
  await assertTurnstileToken({ secret, token, remoteIp: request.headers.get("cf-connecting-ip") });
}

function openAccessEnabled(env: Env): boolean {
  return openAccessRequested(env) && edgeOpenAccessRiskAccepted(env);
}

function openAccessRequested(env: Env): boolean {
  return env.SITE_BEHAVIOR_LAB_ALLOW_UNAUTHENTICATED_SCANS === "1";
}

function edgeOpenAccessRiskAccepted(env: Env): boolean {
  return env.SITE_BEHAVIOR_LAB_ACCEPT_BROWSER_RUN_DNS_REBINDING_RISK === "1";
}

async function assertPublicScanRateLimit(request: Request, env: Env, cost: 1 | 2): Promise<void> {
  if (!openAccessEnabled(env)) return;

  const kv = env.REPORTS_KV;
  if (!kv) {
    throw new HttpError("Public scan rate limiting requires the REPORTS_KV binding.", 503);
  }

  await enforcePublicScanRateLimit({
    store: kv,
    clientHash: await publicClientHash(request.headers),
    cost,
    perMinute: publicScanRateLimitPerMinute(env),
    perDay: publicScanRateLimitPerDay(env)
  });
}

function publicScanRateLimitPerMinute(env: Env): number {
  return publicScanRateLimit(env.SITE_BEHAVIOR_LAB_PUBLIC_SCAN_RATE_LIMIT_PER_MINUTE, DEFAULT_PUBLIC_SCAN_RATE_LIMIT_PER_MINUTE);
}

function publicScanRateLimitPerDay(env: Env): number {
  return publicScanRateLimit(env.SITE_BEHAVIOR_LAB_PUBLIC_SCAN_RATE_LIMIT_PER_DAY, DEFAULT_PUBLIC_SCAN_RATE_LIMIT_PER_DAY);
}

function normalizePublicUrl(input: string): URL {
  const normalized = normalizeHttpUrlInput(input);
  if (!normalized.ok) {
    throw new HttpError(normalized.message, 400);
  }
  assertWorkerPublicHttpUrlShape(normalized.url);
  return normalized.url;
}

async function assertWorkerPublicHttpUrl(
  url: URL,
  env: Env,
  cache?: Map<string, Promise<void>>
): Promise<void> {
  try {
    await assertEdgePublicHttpUrl(url, {
      cache,
      resolverUrl: env.SITE_BEHAVIOR_LAB_DNS_RESOLVER_URL?.trim() || undefined
    });
  } catch (error) {
    throwWorkerUrlSafetyError(error);
  }
}

function assertWorkerPublicHttpUrlShape(url: URL): void {
  try {
    assertEdgePublicHttpUrlShape(url);
  } catch (error) {
    throwWorkerUrlSafetyError(error);
  }
}

function throwWorkerUrlSafetyError(error: unknown): never {
  if (error instanceof EdgeUrlSafetyError) {
    throw new HttpError(error.message, error.status);
  }
  throw error;
}

function normalizeDevice(value: unknown): ScanDevice {
  if (value === "mobile") return "mobile";
  return "desktop";
}

function workerScanTimeout(started: number, maxDurationMs: number, preferredMs = maxDurationMs, now = Date.now()): number {
  return scanTimeoutMs(started, maxDurationMs, preferredMs, now, workerScanTimeoutError);
}

async function withWorkerScanTimeout<T>(operation: Promise<T>, started: number, maxDurationMs: number): Promise<T> {
  return withScanDeadline(operation, started, maxDurationMs, workerScanTimeoutError);
}

function isWorkerScanTimeoutError(error: unknown): boolean {
  return error instanceof HttpError && error.status === 504;
}

function workerScanTimeoutError(): HttpError {
  return new HttpError("The scan exceeded the maximum scan duration.", 504);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function corsHeaders(request: Request, env: Env): HeadersInit {
  return scanCorsHeaders(request.headers.get("origin"), env.SITE_BEHAVIOR_LAB_ALLOWED_ORIGIN);
}

function jsonResponse(body: unknown, request: Request, env: Env, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      ...corsHeaders(request, env),
      "Content-Type": "application/json; charset=utf-8"
    }
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class HttpError extends PublicFacingError {
  constructor(message: string, status: number) {
    super(message, status, "HttpError");
  }
}
