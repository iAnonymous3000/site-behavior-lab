import {
  type Browser,
  chromium,
  devices,
  type BrowserContext,
  type BrowserContextOptions,
  type Page,
  type Request
} from "playwright";
import { findTrackerMatch } from "./tracker-catalog";
import { adblockListMeta, getAdblockEngine, mapRequestType } from "./adblock-engine";
import type {
  CookieRecord,
  ScanRequestPayload,
  ScanResult,
  StorageRecord
} from "./types";
import { isThirdParty } from "./domain-utils";
import { PublicScanError } from "./public-errors";
import { assertPublicHttpUrl, normalizeUrl } from "./url-safety";
import { redactUrlForReport, safeParseUrl } from "./report-url";
import { buildScanConditions, buildScanResult } from "./scan-result-builder";
import { collectFingerprintObservationsFromFrames, fingerprintObserverInitScript } from "./fingerprint-observer";
import { startPublicScanProxy, type ResolvePublicHost } from "./public-scan-proxy";
import {
  collectStorageEntries,
  MAX_RECORDED_REQUESTS,
  ScanNetworkRecorder,
  NON_HTTP_WARNING_EXAMPLE_LIMIT,
  ScanRequestBudget,
  scanTimeoutMs,
  ScanWarningCollector,
  verifyRoutedHttpRequest,
  withScanDeadline
} from "./scan-runtime";

export { redactUrlForReport } from "./report-url";
export { MAX_RECORDED_REQUESTS, NON_HTTP_WARNING_EXAMPLE_LIMIT, ScanRequestBudget, ScanWarningCollector } from "./scan-runtime";

type RoutedRequestLike = {
  frame(): unknown;
  isNavigationRequest(): boolean;
  resourceType(): string;
  url(): string;
};
type RoutePageLike = {
  mainFrame(): unknown;
};
type RouteAdblockEngine = {
  check(url: string, sourceUrl: string, requestType: string): boolean;
};

export type ScanRouteDecision = {
  action: "abort" | "continue";
  blockedByShields: boolean;
};

const DESKTOP_VIEWPORT = { width: 1440, height: 980 };
const MOBILE_VIEWPORT = { width: 390, height: 844 };
const SCAN_TIMEZONE = "UTC";
const SCAN_LOCALE = "en-US";
const SCAN_COLOR_SCHEME = "light" as const;
const NAVIGATION_TIMEOUT_MS = 30_000;
const NETWORK_IDLE_TIMEOUT_MS = 8_000;
const SCANNER_EGRESS_ENV = "SITE_BEHAVIOR_LAB_SCANNER_EGRESS";
export const MAX_SCAN_DURATION_MS = 45_000;

let sharedBrowser: Browser | null = null;
let browserLaunchPromise: Promise<Browser> | null = null;

export type ScanSiteOptions = {
  publicUrlAlreadyVerified?: boolean;
  shieldsBlockingEnabled?: boolean;
  resolvePublicHost?: ResolvePublicHost;
  verifyPublicUrl?: (url: URL) => Promise<void>;
};

export async function scanSite(payload: ScanRequestPayload, options: ScanSiteOptions = {}): Promise<ScanResult> {
  const started = Date.now();
  const targetUrl = normalizeUrl(payload.url);
  const verifyPublicUrl = options.verifyPublicUrl ?? assertPublicHttpUrl;
  if (!options.publicUrlAlreadyVerified) {
    await verifyPublicUrl(targetUrl);
  }

  const warnings = new ScanWarningCollector([
    "This report is one automated, headless Chromium visit from a fixed en-US / UTC profile, with no scrolling, clicking, or consent interaction. Sites can behave differently for real users, browsers, regions, accounts, or network locations.",
    "Counts are a lower bound: trackers that load only after interaction or consent, and any activity inside Web or Service Workers, are not observed. Service labels use a US-biased hand-curated catalog, so regional services may be under-labeled. Cookie and storage figures are an end-of-visit snapshot."
  ]);

  const browser = await getSharedBrowser();
  const chromiumVersion = browser.version();
  const adblockEngine = await getAdblockEngine();
  if (!adblockEngine) {
    warnings.add("Brave Shields classification was unavailable for this scan; tracker labels use the curated catalog only.");
  }
  if (options.shieldsBlockingEnabled && !adblockEngine) {
    throw new PublicScanError("Brave Shields block simulation is unavailable on this scanner.", 503);
  }
  if (options.shieldsBlockingEnabled) {
    warnings.add("Brave Shields block simulation was enabled; matching requests were aborted before loading and are not included in request totals.");
  }
  let context: BrowserContext | null = null;
  const scanProxy = await startPublicScanProxy({ resolveHost: options.resolvePublicHost });

  try {
    context = await browser.newContext(createContextOptions(payload, scanProxy.server));
    if (payload.gpcEnabled) {
      await context.addInitScript(() => {
        Object.defineProperty(navigator, "globalPrivacyControl", {
          configurable: true,
          get: () => true
        });
      });
      await context.setExtraHTTPHeaders({ "Sec-GPC": "1" });
    }

    const page = await context.newPage();
    await installFingerprintObserver(page);

    const requestsBlockedByShields = new WeakSet<Request>();
    const requestsBlockedByGuard = new WeakSet<Request>();
    let shieldsBlockedRequestCount = 0;
    const networkRecorder = new ScanNetworkRecorder<Request>({
      firstPartyHostname: targetUrl.hostname,
      warnings,
      trackerMatcher: findTrackerMatch
    });
    const publicHostChecks = new Map<string, Promise<void>>();

    await page.route("**/*", async (route) => {
      const request = route.request();
      const decision = await decideRoutedRequest({
        request,
        page,
        targetUrl,
        warnings,
        requestBudget: networkRecorder.requestBudget,
        publicHostChecks,
        shieldsBlockingEnabled: options.shieldsBlockingEnabled,
        adblockEngine,
        verifyPublicUrl
      });

      if (decision.action === "continue") {
        await route.continue();
        return;
      }

      if (decision.blockedByShields) {
        shieldsBlockedRequestCount += 1;
        requestsBlockedByShields.add(request);
        networkRecorder.removeRequest(request);
      } else {
        // Requests aborted by the SSRF/public-address guard (or non-HTTP and
        // over-budget aborts) never loaded, so keep them out of the recorded
        // log and request totals, mirroring how Shields-blocked requests are
        // handled. They remain surfaced through scan warnings.
        requestsBlockedByGuard.add(request);
        networkRecorder.removeRequest(request);
      }

      await route.abort();
    });

    page.on("request", (request) => {
      if (requestsBlockedByShields.has(request) || requestsBlockedByGuard.has(request)) return;
      networkRecorder.recordRequest(request, Date.now() - started);
    });
    page.on("response", (response) => networkRecorder.recordResponse(response));

    const response = await page
      .goto(targetUrl.toString(), {
        waitUntil: "domcontentloaded",
        timeout: scanTimeout(started, NAVIGATION_TIMEOUT_MS)
      })
      .catch((error: unknown) => {
        if (scanProxy.blockedTargets.length > 0) {
          throw new PublicScanError("The page could not be loaded because it resolved to a local or private network address.");
        }
        if (isTimeoutError(error)) {
          throw new PublicScanError("The page did not load before the scan timeout.", 504);
        }
        throw error;
      });

    await withScanTimeout(page.waitForLoadState("networkidle", { timeout: scanTimeout(started, NETWORK_IDLE_TIMEOUT_MS) }), started).catch((error) => {
      if (isScanBudgetError(error)) throw error;
      warnings.add("The page did not reach network idle before the scan window ended.");
    });

    const pageTitle = await withScanTimeout(page.title(), started).catch((error) => {
      if (isScanBudgetError(error)) throw error;
      return "";
    });
    const finalUrl = page.url();
    const finalParsed = safeParseUrl(finalUrl) ?? targetUrl;
    const cookies = await withScanTimeout(collectCookies(context, finalParsed.hostname), started);
    const storage = await withScanTimeout(collectStorage(page), started);
    const fingerprintObservations = await withScanTimeout(collectFingerprintObservations(page), started);
    const screenshot = await withScanTimeout(
      page
        .screenshot({ type: "jpeg", quality: 62, fullPage: false })
        .then((buffer) => `data:image/jpeg;base64,${buffer.toString("base64")}`)
        .catch(() => null),
      started
    );
    if (scanProxy.blockedTargets.length > 0) {
      warnings.add("Blocked one or more requests that resolved to local or private network addresses at connection time.");
    }

    const publicRequests = networkRecorder.publicRecords(finalParsed.hostname, (record, request) => ({
      ...record,
      blockedByShields: adblockEngine ? adblockEngine.check(request.url(), finalUrl, mapRequestType(record.resourceType)) : undefined
    }));
    const scannerEgress = scannerEgressDescription();
    const adblockMeta = adblockEngine ? adblockListMeta() : null;
    const conditions = buildScanConditions({
      profile: "node-playwright",
      requestedUrl: redactUrlForReport(targetUrl.toString()),
      finalUrl: redactUrlForReport(finalUrl),
      scannedAt: new Date(started).toISOString(),
      chromiumVersion,
      userAgent: await withScanTimeout(page.evaluate(() => navigator.userAgent), started),
      timezone: SCAN_TIMEZONE,
      locale: SCAN_LOCALE,
      language: await withScanTimeout(page.evaluate(() => navigator.language), started),
      viewport: {
        width: page.viewportSize()?.width ?? DESKTOP_VIEWPORT.width,
        height: page.viewportSize()?.height ?? DESKTOP_VIEWPORT.height,
        isMobile: payload.device === "mobile"
      },
      gpcEnabled: payload.gpcEnabled,
      consentMode: payload.consentMode,
      headless: true,
      scannerEgress,
      shieldsMode: options.shieldsBlockingEnabled ? "block-simulation" as const : "classification" as const,
      adblock: adblockMeta
        ? { active: true, source: adblockMeta.source, lists: adblockMeta.lists, fetchedAt: adblockMeta.fetchedAt }
        : undefined
    });

    return buildScanResult({
      pageTitle,
      status: response?.status() ?? null,
      durationMs: Date.now() - started,
      firstPartyDomain: finalParsed.hostname,
      conditions,
      requests: publicRequests,
      cookies,
      storage,
      fingerprintDetections: fingerprintObservations.detections,
      fingerprintEvents: fingerprintObservations.events,
      screenshot,
      warnings: warnings.list,
      shieldsBlockedRequests: adblockEngine
        ? options.shieldsBlockingEnabled
          ? shieldsBlockedRequestCount
          : publicRequests.filter((item) => item.blockedByShields).length
        : undefined
    });
  } finally {
    await context?.close().catch(() => undefined);
    await scanProxy.close().catch(() => undefined);
  }
}

export async function decideRoutedRequest({
  request,
  page,
  targetUrl,
  warnings,
  requestBudget,
  publicHostChecks,
  shieldsBlockingEnabled,
  adblockEngine,
  verifyPublicUrl = assertPublicHttpUrl
}: {
  request: RoutedRequestLike;
  page: RoutePageLike;
  targetUrl: URL;
  warnings: ScanWarningCollector;
  requestBudget: ScanRequestBudget;
  publicHostChecks: Map<string, Promise<void>>;
  shieldsBlockingEnabled?: boolean;
  adblockEngine?: RouteAdblockEngine | null;
  verifyPublicUrl?: (url: URL) => Promise<void>;
}): Promise<ScanRouteDecision> {
  const requestUrl = request.url();
  const decision = await verifyRoutedHttpRequest({
    requestUrl,
    warnings,
    requestBudget,
    verifyPublicUrl: async (parsed) => {
      // Memoize the SSRF/public-address check per host:port so the DNS lookup
      // runs once per host instead of once per subresource, which otherwise
      // serializes a DNS round-trip in front of every request and skews timing.
      const hostCheckKey = `${parsed.protocol}//${parsed.hostname}:${parsed.port}`;
      let hostCheck = publicHostChecks.get(hostCheckKey);
      if (!hostCheck) {
        hostCheck = verifyPublicUrl(parsed);
        publicHostChecks.set(hostCheckKey, hostCheck);
      }
      await hostCheck;
    }
  });
  if (decision.action === "abort") {
    return { action: "abort", blockedByShields: false };
  }

  if (
    shieldsBlockingEnabled &&
    adblockEngine &&
    !isTopLevelNavigation(request, page) &&
    adblockEngine.check(requestUrl, targetUrl.toString(), mapRequestType(request.resourceType()))
  ) {
    return { action: "abort", blockedByShields: true };
  }

  return { action: "continue", blockedByShields: false };
}

function isTopLevelNavigation(request: RoutedRequestLike, page: RoutePageLike): boolean {
  return request.isNavigationRequest() && request.frame() === page.mainFrame();
}

async function getSharedBrowser(): Promise<Browser> {
  if (sharedBrowser?.isConnected()) {
    return sharedBrowser;
  }

  browserLaunchPromise ??= chromium.launch({ headless: true }).then((browser) => {
    sharedBrowser = browser;
    browser.on("disconnected", () => {
      if (sharedBrowser === browser) {
        sharedBrowser = null;
        browserLaunchPromise = null;
      }
    });
    return browser;
  });

  return browserLaunchPromise;
}

export async function closeSharedBrowserForTests(): Promise<void> {
  const browser = sharedBrowser;
  sharedBrowser = null;
  browserLaunchPromise = null;
  await browser?.close().catch(() => undefined);
}

function createContextOptions(payload: ScanRequestPayload, proxyServer: string): BrowserContextOptions {
  const shared = {
    colorScheme: SCAN_COLOR_SCHEME,
    locale: SCAN_LOCALE,
    proxy: { server: proxyServer, bypass: "<-loopback>" },
    timezoneId: SCAN_TIMEZONE
  };

  if (payload.device === "mobile") {
    return {
      ...devices["Pixel 7"],
      ...shared,
      viewport: MOBILE_VIEWPORT
    };
  }

  return {
    ...shared,
    viewport: DESKTOP_VIEWPORT
  };
}

async function installFingerprintObserver(page: Page): Promise<void> {
  await page.addInitScript(fingerprintObserverInitScript);
}

async function collectCookies(context: BrowserContext, firstPartyDomain: string): Promise<CookieRecord[]> {
  const cookies = await context.cookies();
  return cookies
    .map((cookie) => ({
      name: cookie.name,
      domain: cookie.domain,
      path: cookie.path,
      sameSite: cookie.sameSite,
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
      session: cookie.expires === -1,
      thirdParty: isThirdParty(firstPartyDomain, cookie.domain.replace(/^\./, ""))
    }))
    .sort((a, b) => Number(b.thirdParty) - Number(a.thirdParty) || a.domain.localeCompare(b.domain));
}

async function collectStorage(page: Page): Promise<StorageRecord[]> {
  return collectStorageEntries(page).catch(() => []);
}

async function collectFingerprintObservations(page: Page) {
  return collectFingerprintObservationsFromFrames(page.frames());
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.message.toLowerCase().includes("timeout");
}

function isScanBudgetError(error: unknown): boolean {
  return error instanceof PublicScanError && error.status === 504 && error.message.includes("maximum scan duration");
}

export function scanTimeout(started: number, preferredMs: number, now = Date.now()): number {
  return scanTimeoutMs(started, MAX_SCAN_DURATION_MS, preferredMs, now, scanTimeoutError);
}

async function withScanTimeout<T>(operation: Promise<T>, started: number): Promise<T> {
  return withScanDeadline(operation, started, MAX_SCAN_DURATION_MS, scanTimeoutError);
}

function scanTimeoutError(): PublicScanError {
  return new PublicScanError("The scan exceeded the maximum scan duration.", 504);
}

function scannerEgressDescription(): string {
  return process.env[SCANNER_EGRESS_ENV]?.trim() || "this scanner instance";
}
