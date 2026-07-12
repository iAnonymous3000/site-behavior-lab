import {
  type Browser,
  chromium,
  devices,
  type BrowserContext,
  type BrowserContextOptions,
  type Page,
  type Request
} from "playwright";
import { randomBytes } from "node:crypto";
import { findTrackerMatch } from "./tracker-catalog";
import { adblockListMeta, getAdblockEngine, mapRequestType } from "./adblock-engine";
import type {
  CookieRecord,
  KeystrokeExfiltrationDetectionSummary,
  PrivacyPolicySummary,
  ScanRequestPayload,
  ScanResult,
  StorageRecord
} from "./types";
import {
  buildKeystrokeExfiltrationDetection,
  createSentinel,
  findSentinelLeaks,
  sentinelEncodings,
  type CapturedRequest
} from "./keystroke-exfiltration";
import {
  consentClickArgs,
  consentInteractionWarning,
  findAndClickConsentControl,
  type ConsentChoice,
  type ConsentInteractionSummary
} from "./consent-interaction";
import { summarizePixelEvents, type PixelEventInput } from "./pixel-events";
import { buildPrivacyPolicySummary, pickPrivacyPolicyLink, type PolicyLinkCandidate } from "./privacy-policy";
import { isOperationalEntity, trackerEntitySummaries } from "./report-insights";
import { isThirdParty, partyKey, summarizeDomains } from "./domain-utils";
import { resolveCnameCloaks, type CnameChainResolver } from "./cname-uncloaking";
import type { CnameCloak, NetworkRequestRecord, TrackerMatch } from "./types";
import { promises as dnsPromises } from "node:dns";
import { PublicScanError } from "./public-errors";
import { assertPublicHttpUrl, normalizeUrl } from "./url-safety";
import { redactUrlForReport, safeParseUrl } from "./report-url";
import { redactUrlV2 } from "./redaction-v2";
import { buildScanConditions, buildScanResult } from "./scan-result-builder";
import { collectFingerprintObservationsFromFrames, fingerprintObserverInitScript } from "./fingerprint-observer";
import { startPublicScanProxy, type ResolvePublicHost } from "./public-scan-proxy";
import { chromiumSandboxEnabled } from "./chromium-sandbox";
import {
  collectStorageEntries,
  ScanNetworkRecorder,
  ScanRequestBudget,
  scanTimeoutMs,
  ScanWarningCollector,
  verifyRoutedHttpRequest,
  withScanDeadline
} from "./scan-runtime";

export { redactUrlForReport } from "./report-url";
export { MAX_RECORDED_REQUESTS, NON_HTTP_WARNING_EXAMPLE_LIMIT, ScanRequestBudget, ScanWarningCollector } from "./scan-runtime";

type RouteFrameLike = {
  parentFrame(): RouteFrameLike | null;
  url(): string;
};
type RouteWorkerLike = {
  url(): string;
};
type RoutedRequestLike = {
  frame(): RouteFrameLike;
  isNavigationRequest(): boolean;
  method?(): string;
  resourceType(): string;
  serviceWorker?(): RouteWorkerLike | null;
  url(): string;
};
type RoutePageLike = {
  mainFrame(): RouteFrameLike;
};
type RouteAdblockEngine = {
  checkWithMethod(url: string, sourceUrl: string, requestType: string, method: string): boolean;
};

export type ScanRouteDecision = {
  action: "abort" | "continue";
  blockedByShields: boolean;
  /** Route-time classifier result, reused when the public request record is built. */
  shieldsMatched?: boolean;
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
// Active keystroke-exfiltration probe: how many fields to type into, the minimum
// time budget needed to bother, and how long to watch for the sentinel leaving.
const MAX_PROBE_FIELDS = 8;
const KEYSTROKE_PROBE_MIN_BUDGET_MS = 4_000;
const KEYSTROKE_EXFIL_WAIT_MS = 2_500;
// Batch-on-unload flush: budget needed to navigate away (firing pagehide so
// recorders that buffer keystrokes transmit via sendBeacon) and watch for it.
const KEYSTROKE_UNLOAD_MIN_BUDGET_MS = 1_500;
const KEYSTROKE_UNLOAD_WAIT_MS = 700;
const FILLABLE_FIELD_SELECTOR =
  "input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]):not([type=reset]):not([type=file]):not([type=range]):not([type=color]):not([disabled]):not([readonly]), textarea:not([disabled]):not([readonly]), [contenteditable=true], [contenteditable='']";
// CNAME-uncloaking: how many first-party subdomains to resolve, the budget to
// bother, and the per-lookup / chain bounds so DNS can never stall the scan.
const MAX_CNAME_LOOKUPS = 10;
const CNAME_PROBE_MIN_BUDGET_MS = 3_000;
const CNAME_LOOKUP_TIMEOUT_MS = 1_500;
const CNAME_MAX_HOPS = 3;
// Consent-choice click (accept-all / reject-all modes): budget needed to bother,
// a short retry window for banners that render late, and the settle wait that
// lets the post-choice tracker burst land in the request log before collection.
const CONSENT_CLICK_MIN_BUDGET_MS = 6_000;
const CONSENT_BANNER_RETRIES = 3;
const CONSENT_BANNER_RETRY_WAIT_MS = 800;
const CONSENT_SETTLE_WAIT_MS = 3_500;
const CONSENT_SETTLE_IDLE_TIMEOUT_MS = 3_000;
// Privacy-policy cross-check: budget needed for the extra page visit, its own
// navigation timeout, a short wait for JS-rendered policies (CMP-hosted pages),
// and hard caps on links considered, subresources loaded, and text analyzed.
const PRIVACY_POLICY_MIN_BUDGET_MS = 7_000;
const PRIVACY_POLICY_NAV_TIMEOUT_MS = 8_000;
const PRIVACY_POLICY_RENDER_WAIT_MS = 1_000;
const MAX_POLICY_LINK_CANDIDATES = 12;
const MAX_POLICY_PAGE_REQUESTS = 150;
const MAX_POLICY_TEXT_CHARS = 400_000;

let sharedBrowser: Browser | null = null;
let browserLaunchPromise: Promise<Browser> | null = null;

/**
 * Chromium flags every scan browser launches with. WebRTC must not carry
 * traffic the scan proxy never sees: ICE/STUN speaks UDP directly to arbitrary
 * hosts (loopback and RFC1918 included), bypassing the connect-time
 * public-address guard that every HTTP(S) request goes through.
 * disable_non_proxied_udp confines WebRTC to proxied transports, and because
 * the scan proxy is HTTP-only (no UDP relay), that disables WebRTC egress
 * outright rather than merely hiding local IPs.
 */
export const SCAN_CHROMIUM_LAUNCH_ARGS = ["--force-webrtc-ip-handling-policy=disable_non_proxied_udp"] as const;

export type ScanSiteOptions = {
  publicUrlAlreadyVerified?: boolean;
  shieldsBlockingEnabled?: boolean;
  /** Cooperatively stops the browser visit and closes its isolated context. */
  signal?: AbortSignal;
  resolvePublicHost?: ResolvePublicHost;
  verifyPublicUrl?: (url: URL) => Promise<void>;
  /** Override CNAME-chain resolution (defaults to node:dns); injected in tests. */
  resolveCnameChain?: CnameChainResolver;
};

export async function scanSite(payload: ScanRequestPayload, options: ScanSiteOptions = {}): Promise<ScanResult> {
  throwIfScanAborted(options.signal);
  const started = Date.now();
  const targetUrl = normalizeUrl(payload.url);
  const verifyPublicUrl = options.verifyPublicUrl ?? assertPublicHttpUrl;
  if (!options.publicUrlAlreadyVerified) {
    await verifyPublicUrl(targetUrl);
  }

  const warnings = new ScanWarningCollector([
    payload.consentMode === "observe"
      ? "This report is one automated, headless Chromium visit from a fixed en-US / UTC profile, with no scrolling, clicking, or consent interaction. Sites can behave differently for real users, browsers, regions, accounts, or network locations."
      : "This report is one automated, headless Chromium visit from a fixed en-US / UTC profile, with no scrolling or clicking except one scripted choice on the cookie/consent banner (disclosed below). Sites can behave differently for real users, browsers, regions, accounts, or network locations.",
    payload.consentMode === "observe"
      ? "Counts are a lower bound: trackers that load only after interaction or consent, any activity inside Web or Service Workers, and WebSocket traffic are not observed. Service labels use a US-biased hand-curated catalog, so regional services may be under-labeled. Cookie and storage figures are an end-of-visit snapshot, with storage keys read from the top frame only."
      : "Counts are a lower bound: trackers that load only after further interaction, any activity inside Web or Service Workers, and WebSocket traffic are not observed. Service labels use a US-biased hand-curated catalog, so regional services may be under-labeled. Cookie and storage figures are an end-of-visit snapshot, with storage keys read from the top frame only."
  ]);

  const browser = await getSharedBrowser();
  throwIfScanAborted(options.signal);
  const chromiumVersion = browser.version();
  const adblockEngine = await getAdblockEngine();
  throwIfScanAborted(options.signal);
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
  const closeOnAbort = () => {
    // Abort handlers cannot await, but closing both resources immediately
    // rejects in-flight Playwright work and tears down pending proxy connects.
    void context?.close().catch(() => undefined);
    void scanProxy.close().catch(() => undefined);
  };
  options.signal?.addEventListener("abort", closeOnAbort, { once: true });

  try {
    throwIfScanAborted(options.signal);
    context = await browser.newContext(createContextOptions(payload, scanProxy.server));
    throwIfScanAborted(options.signal);
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
    await installFingerprintObserver(page, targetUrl.hostname);

    const requestsBlockedByShields = new WeakSet<Request>();
    const requestsBlockedByGuard = new WeakSet<Request>();
    // The source document can navigate or detach before report construction.
    // Keep only the route-time boolean keyed by Playwright's Request identity:
    // raw frame/worker URLs remain transient and never enter the public wire.
    const shieldsMatches = new WeakMap<Request, boolean>();
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
      if (decision.shieldsMatched !== undefined) {
        shieldsMatches.set(request, decision.shieldsMatched);
      }

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
        throwIfScanAborted(options.signal);
        // Only an actual guard block ("non-public-address") may be described as
        // one: the proxy also records DNS failures, refused upstream connects,
        // and policy refusals, none of which prove a private-network target.
        if (scanProxy.blockedTargets.some((blocked) => blocked.reason === "non-public-address")) {
          throw new PublicScanError("The page could not be loaded because it resolved to a local or private network address.");
        }
        if (isTimeoutError(error)) {
          throw new PublicScanError("The page did not load before the scan timeout.", 504);
        }
        // Navigation failures (TLS/HTTP2 errors, connection resets, sites that
        // refuse automated browsers) would otherwise be scrubbed to the opaque
        // "Scan failed. Check the target URL" 500, which reads as an invalid-URL
        // error. Surface them as an honest load failure. Log a redacted target
        // plus the failure reason only -- the raw Playwright message embeds the
        // full URL (query string included), which must never reach the logs.
        console.error("Scan navigation failed", {
          target: redactUrlV2(targetUrl.toString()).value,
          reason: navigationFailureReason(error)
        });
        throw new PublicScanError(
          "The page could not be loaded. The site may be down, unreachable, or blocking automated visits.",
          502
        );
      });

    await withScanTimeout(page.waitForLoadState("networkidle", { timeout: scanTimeout(started, NETWORK_IDLE_TIMEOUT_MS) }), started).catch((error) => {
      throwIfScanAborted(options.signal);
      if (isScanBudgetError(error)) throw error;
      warnings.add("The page did not reach network idle before the scan window ended.");
    });

    // A non-2xx top-level response does not reject goto, so the scan otherwise
    // completes and an error/block page reads as a low-tracker (falsely "private")
    // result. Surface it as a warning, and the headline/findings reframe it.
    const responseStatus = response?.status() ?? null;
    const pageLoadFailed = responseStatus !== null && responseStatus >= 400;
    if (pageLoadFailed) {
      warnings.add(`The page returned HTTP ${responseStatus}; this report reflects an error or block page, not a normal load.`);
    }

    // Consent-choice modes: dispatch the Accept all / Reject all click on the
    // banner now. Collection is cumulative for the whole visit (traffic from
    // before AND after the click), and the site's registered consent state is
    // never verified; the report copy must say so. Skipped on failed loads: an
    // interstitial's banner (a challenge page's cookie notice) is not the
    // site's consent banner.
    const consentInteraction =
      payload.consentMode === "observe" || pageLoadFailed
        ? undefined
        : await withScanTimeout(applyConsentChoice(page, payload.consentMode, started), started).catch(
            (): ConsentInteractionSummary => ({ mode: payload.consentMode as ConsentChoice, clicked: false })
          );
    throwIfScanAborted(options.signal);
    if (consentInteraction) {
      warnings.add(consentInteractionWarning(consentInteraction));
    }

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
    throwIfScanAborted(options.signal);
    // Warn only for actual private/local-address guard blocks. The proxy's
    // other recorded outcomes (DNS failures, refused upstream connects, policy
    // refusals) are ordinary load failures already visible in the request log
    // as requests without a response, and claiming they "resolved to local or
    // private network addresses" would be false.
    if (scanProxy.blockedTargets.some((blocked) => blocked.reason === "non-public-address")) {
      warnings.add("Blocked one or more requests that resolved to local or private network addresses at connection time.");
    }

    // Privacy-policy link candidates must be read now: the keystroke probe below
    // may navigate the page away to flush unload beacons. The policy page itself
    // is visited later, after the request log has been snapshotted.
    const policyLinks = await withScanTimeout(collectPrivacyPolicyLinks(page), started).catch(() => [] as PolicyLinkCandidate[]);

    // Active input-capture probe: type a synthetic sentinel into form fields and
    // watch for it leaving to a third party. Best-effort and fully bounded, it
    // never throws into the scan and is skipped when the time budget is tight.
    const keystrokeDetection = await withScanTimeout(
      probeKeystrokeExfiltration(page, finalParsed.hostname, started, warnings),
      started
    ).catch(() => null);
    const fingerprintDetections = keystrokeDetection
      ? [...fingerprintObservations.detections, keystrokeDetection]
      : fingerprintObservations.detections;

    // Decode pixel-level events from the raw (pre-redaction) request and POST
    // body while it is still available here; the public record's URL is scrubbed.
    // Event names are kept; identifier values are detected by key presence only.
    const pixelEventInputs: PixelEventInput[] = [];
    const publicRequests = networkRecorder.publicRecords(finalParsed.hostname, (record, request) => {
      if (record.thirdParty) {
        pixelEventInputs.push({ url: request.url(), method: record.method, postData: safeRequestPostData(request) });
      }
      return {
        ...record,
        // Reuse the exact route-time decision. Re-evaluating here against the
        // final top-level URL misclassifies iframe and redirected-document
        // requests and can disagree with what the blocking arm actually did.
        blockedByShields: adblockEngine ? shieldsMatches.get(request) : undefined
      };
    });
    const pixelEvents = summarizePixelEvents(pixelEventInputs);

    // Un-hide CNAME-cloaked trackers: first-party subdomains that are DNS aliases
    // for a known tracker. The oracle is the curated catalog (named) first, then
    // the broader Brave Shields engine (which carries the CNAME-cloak vendors the
    // small catalog lacks). Best-effort and bounded, DNS can never stall the scan.
    const matchCnameTracker = (host: string): TrackerMatch | null => {
      const named = findTrackerMatch(host);
      if (named) return named;
      if (adblockEngine && adblockEngine.check(`https://${host}/`, finalUrl, mapRequestType("other"))) {
        const registrable = partyKey(host);
        return { domain: registrable, entity: registrable, category: "tracking (Brave Shields list)", confidence: "shields-list" };
      }
      return null;
    };
    const cnameCloaks = await resolveCnameCloaksForScan(
      publicRequests,
      finalParsed.hostname,
      started,
      options,
      matchCnameTracker
    );
    if (cnameCloaks.length > 0) {
      warnings.add(
        `Resolved ${
          cnameCloaks.length === 1 ? "1 first-party subdomain" : `${cnameCloaks.length} first-party subdomains`
        } that are CNAME aliases for third-party trackers (CNAME cloaking), which request-URL matching alone would miss.`
      );
    }

    // Read the site's own privacy policy and compare its text to the observed
    // evidence (checkable claims + tracking companies it never names). Runs
    // after the request log is snapshotted so the extra page visit never
    // contaminates the report's counts; best-effort and budget-bounded.
    // Skipped on failed/blocked loads (HTTP >= 400): a challenge or error page
    // is not the site, and its only policy link is typically the interstitial
    // vendor's own policy (e.g. Cloudflare's), which must not be attributed to
    // the scanned site.
    const privacyPolicy = pageLoadFailed
      ? null
      : await probePrivacyPolicy({
          context,
          links: policyLinks,
          firstPartyHostname: finalParsed.hostname,
          requests: publicRequests,
          started,
          verifyPublicUrl,
          warnings
        }).catch(() => null);
    throwIfScanAborted(options.signal);

    const scannerEgress = scannerEgressDescription();
    const adblockMeta = adblockEngine ? adblockListMeta() : null;
    const conditions = buildScanConditions({
      profile: "node-playwright",
      requestedUrl: targetUrl.toString(),
      finalUrl,
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

    throwIfScanAborted(options.signal);
    return buildScanResult({
      pageTitle,
      status: responseStatus,
      durationMs: Date.now() - started,
      firstPartyDomain: finalParsed.hostname,
      conditions,
      requests: publicRequests,
      cookies,
      storage,
      fingerprintDetections,
      fingerprintEvents: fingerprintObservations.events,
      cnameCloaks,
      pixelEvents,
      privacyPolicy: privacyPolicy ?? undefined,
      consentInteraction,
      screenshot,
      warnings: warnings.list,
      shieldsBlockedRequests: adblockEngine
        ? options.shieldsBlockingEnabled
          ? shieldsBlockedRequestCount
          : publicRequests.filter((item) => item.blockedByShields).length
        : undefined
    });
  } finally {
    options.signal?.removeEventListener("abort", closeOnAbort);
    await context?.close().catch(() => undefined);
    await scanProxy.close().catch(() => undefined);
  }
}

function throwIfScanAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new DOMException("The scan was cancelled.", "AbortError");
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
  // Capture synchronously, before DNS/public-host verification awaits: a frame
  // can navigate or detach while that check is in flight. The raw source URL is
  // used only in memory by adblock-rust and is never logged or persisted.
  const shieldsContext = adblockEngine ? shieldsRequestContext(request, page, targetUrl) : null;
  const shieldsMethod = adblockEngine ? safeRequestMethod(request) : "GET";
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

  const shieldsMatched =
    adblockEngine && shieldsContext
      ? shieldsContext.eligible &&
        adblockEngine.checkWithMethod(
          requestUrl,
          shieldsContext.sourceUrl,
          mapRequestType(request.resourceType()),
          shieldsMethod
        )
      : undefined;

  if (shieldsBlockingEnabled && shieldsMatched) {
    return { action: "abort", blockedByShields: true, shieldsMatched: true };
  }

  return {
    action: "continue",
    blockedByShields: false,
    ...(shieldsMatched !== undefined ? { shieldsMatched } : {})
  };
}

type ShieldsRequestContext = {
  /** Whether this request participates in classification/block simulation. */
  eligible: boolean;
  /** Raw, transient adblock-rust source_url; never part of a report. */
  sourceUrl: string;
};

/**
 * Resolve adblock-rust's source_url from the document that initiated a request.
 * Playwright exposes the frame being navigated for a subframe navigation, whose
 * URL is often empty until commit, so that case uses its parent document. A
 * Service Worker has no frame and must be checked before calling frame().
 */
function shieldsRequestContext(request: RoutedRequestLike, page: RoutePageLike, targetUrl: URL): ShieldsRequestContext {
  const mainFrame = safeMainFrame(page);
  const fallback = httpUrlFromFrameChain(mainFrame) ?? targetUrl.toString();
  const serviceWorker = safeServiceWorker(request);
  if (serviceWorker) {
    return {
      eligible: true,
      sourceUrl: safeHttpUrl(safeWorkerUrl(serviceWorker)) ?? fallback
    };
  }

  const frame = safeRequestFrame(request);
  if (request.isNavigationRequest()) {
    // The scanner intentionally never blocks its main document. Playwright can
    // also expose a navigation before its frame exists; fail open in that
    // ambiguous case rather than accidentally aborting the page under test.
    if (!frame || frame === mainFrame) {
      return { eligible: false, sourceUrl: fallback };
    }
    return {
      eligible: true,
      sourceUrl: httpUrlFromFrameChain(safeParentFrame(frame)) ?? fallback
    };
  }

  return {
    eligible: true,
    sourceUrl: httpUrlFromFrameChain(frame) ?? fallback
  };
}

function httpUrlFromFrameChain(frame: RouteFrameLike | null): string | null {
  const seen = new Set<RouteFrameLike>();
  let current = frame;
  while (current && !seen.has(current)) {
    seen.add(current);
    const url = safeHttpUrl(safeFrameUrl(current));
    if (url) return url;
    current = safeParentFrame(current);
  }
  return null;
}

function safeHttpUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}

function safeFrameUrl(frame: RouteFrameLike): string | null {
  try {
    return frame.url();
  } catch {
    return null;
  }
}

function safeMainFrame(page: RoutePageLike): RouteFrameLike | null {
  try {
    return page.mainFrame();
  } catch {
    return null;
  }
}

function safeParentFrame(frame: RouteFrameLike): RouteFrameLike | null {
  try {
    return frame.parentFrame();
  } catch {
    return null;
  }
}

function safeRequestFrame(request: RoutedRequestLike): RouteFrameLike | null {
  try {
    return request.frame();
  } catch {
    return null;
  }
}

function safeRequestMethod(request: RoutedRequestLike): string {
  try {
    const method = request.method?.().trim().toUpperCase();
    return method || "GET";
  } catch {
    return "GET";
  }
}

function safeServiceWorker(request: RoutedRequestLike): RouteWorkerLike | null {
  try {
    return request.serviceWorker?.() ?? null;
  } catch {
    return null;
  }
}

function safeWorkerUrl(worker: RouteWorkerLike): string | null {
  try {
    return worker.url();
  } catch {
    return null;
  }
}

async function getSharedBrowser(): Promise<Browser> {
  if (sharedBrowser?.isConnected()) {
    return sharedBrowser;
  }

  // The Chromium sandbox stays opt-in per deployment: it needs kernel features
  // (unprivileged user namespaces or a setuid helper) the container platform
  // may not provide, and a launch that fails there would break every scan. Set
  // the env to "1" only after verifying a deployed scan succeeds with it. The
  // container process itself runs as a non-root user either way (Dockerfile).
  browserLaunchPromise ??= chromium
    .launch({
      headless: true,
      args: [...SCAN_CHROMIUM_LAUNCH_ARGS],
      chromiumSandbox: chromiumSandboxEnabled()
    })
    .then(
    (browser) => {
      sharedBrowser = browser;
      browser.on("disconnected", () => {
        if (sharedBrowser === browser) {
          sharedBrowser = null;
          browserLaunchPromise = null;
        }
      });
      return browser;
    },
    (error: unknown) => {
      // A failed launch must not be cached: leaving the rejected promise in
      // place would fail every later scan until the process restarts, even
      // after the transient cause (memory pressure, missing display) clears.
      browserLaunchPromise = null;
      throw error;
    }
  );

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

async function installFingerprintObserver(page: Page, firstPartyHostname: string): Promise<void> {
  // The registrable domain of the scanned site rides along as the init-script
  // argument so the in-page listener-origin classification can recognize
  // same-site sibling subdomains (see fingerprintObserverInitScript).
  await page.addInitScript(fingerprintObserverInitScript, partyKey(firstPartyHostname));
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

/**
 * Click the requested consent-banner choice (Accept all / Reject all) in the
 * first frame that has a recognizable control: known CMP selectors first, then
 * a conservative whole-label text match (see lib/consent-interaction.ts). After
 * a successful click, waits briefly so the post-choice tracker burst lands in
 * the request log before collection. Bounded by the scan budget, first-layer
 * only, and honest on failure: `clicked: false` means the visit stays
 * pre-consent, and the caller discloses exactly that.
 */
async function applyConsentChoice(page: Page, choice: ConsentChoice, started: number): Promise<ConsentInteractionSummary> {
  const summary: ConsentInteractionSummary = { mode: choice, clicked: false };
  if (MAX_SCAN_DURATION_MS - (Date.now() - started) < CONSENT_CLICK_MIN_BUDGET_MS) return summary;

  const args = consentClickArgs(choice);
  for (let attempt = 0; attempt < CONSENT_BANNER_RETRIES && !summary.clicked; attempt += 1) {
    // Main frame first; consent iframes (Sourcepoint and similar) after it.
    for (const frame of page.frames()) {
      const outcome = await frame.evaluate(findAndClickConsentControl, args).catch(() => null);
      if (!outcome?.clicked) continue;
      summary.clicked = true;
      if (outcome.cmp) summary.cmp = outcome.cmp;
      if (outcome.selector) summary.selector = outcome.selector;
      if (outcome.matchedText) summary.matchedText = outcome.matchedText;
      if (frame !== page.mainFrame()) summary.frameUrl = frame.url();
      break;
    }
    // Banners often render after network idle; retry briefly while budget allows.
    if (!summary.clicked && attempt < CONSENT_BANNER_RETRIES - 1) {
      if (MAX_SCAN_DURATION_MS - (Date.now() - started) < CONSENT_CLICK_MIN_BUDGET_MS) break;
      await page.waitForTimeout(CONSENT_BANNER_RETRY_WAIT_MS);
    }
  }

  if (summary.clicked) {
    const settleMs = Math.min(CONSENT_SETTLE_WAIT_MS, MAX_SCAN_DURATION_MS - (Date.now() - started) - 1_000);
    if (settleMs > 0) await page.waitForTimeout(settleMs);
    // Never throw after a successful click (the caller's failure fallback would
    // misreport it as un-clicked), so budget the idle wait locally instead of
    // via the throwing scanTimeout helper.
    const idleBudgetMs = MAX_SCAN_DURATION_MS - (Date.now() - started) - 500;
    if (idleBudgetMs > 250) {
      await page
        .waitForLoadState("networkidle", { timeout: Math.min(CONSENT_SETTLE_IDLE_TIMEOUT_MS, idleBudgetMs) })
        .catch(() => undefined);
    }
  }

  return summary;
}

/**
 * Type a unique synthetic sentinel into the page's form fields (never
 * submitting), then watch the network for that value leaving to a third party:
 * direct evidence of keystroke/input capture. Best-effort: bounded by the scan
 * budget, swallows its own errors, and returns null when nothing leaked or there
 * was no time to probe. The form is never submitted and typed values are
 * synthetic, so this performs no real action on the site.
 */
async function probeKeystrokeExfiltration(
  page: Page,
  firstPartyHostname: string,
  started: number,
  warnings: ScanWarningCollector
): Promise<KeystrokeExfiltrationDetectionSummary | null> {
  if (MAX_SCAN_DURATION_MS - (Date.now() - started) < KEYSTROKE_PROBE_MIN_BUDGET_MS) return null;

  const sentinel = createSentinel(randomBytes(6).toString("hex"));
  const captured: CapturedRequest[] = [];
  const onRequest = (request: Request) => {
    try {
      const url = request.url();
      const hostname = safeParseUrl(url)?.hostname;
      if (!hostname) return;
      captured.push({
        domain: hostname,
        thirdParty: isThirdParty(firstPartyHostname, hostname),
        url,
        body: safeRequestPostData(request)
      });
    } catch {
      /* ignore a malformed request */
    }
  };

  page.on("request", onRequest);
  let typed: { count: number; types: string[] };
  try {
    typed = await typeSentinelIntoFields(page, sentinel);
    if (typed.count === 0) return null;
    const waitMs = Math.min(KEYSTROKE_EXFIL_WAIT_MS, MAX_SCAN_DURATION_MS - (Date.now() - started) - 250);
    if (waitMs > 0) await page.waitForTimeout(waitMs);
    // Flush batch-on-unload senders: many recorders buffer keystrokes and only
    // transmit via sendBeacon on pagehide. Best-effort and isolated, so a failure
    // here never discards the real-time captures above.
    await flushUnloadBeacons(page, started).catch(() => undefined);
  } catch {
    return null;
  } finally {
    page.off("request", onRequest);
  }

  warnings.add(
    `This scan typed a synthetic test value into ${
      typed.count === 1 ? "1 form field" : `${typed.count} form fields`
    } (never submitting the form) to test whether typed input is captured and sent to third parties. The value is synthetic and is not stored. Requests the page sent during and after this typing, including any unload beacons, are part of the recorded request log and counts.`
  );

  return buildKeystrokeExfiltrationDetection(findSentinelLeaks(sentinelEncodings(sentinel), captured), {
    fieldsTyped: typed.count,
    fieldTypes: typed.types
  });
}

/**
 * Navigate to about:blank so the page fires pagehide/unload, prompting session
 * recorders that buffer keystrokes to flush them via sendBeacon, which the
 * probe's request listener then captures. Runs only after all page-dependent
 * report data is already collected; bounded by the remaining scan budget.
 */
async function flushUnloadBeacons(page: Page, started: number): Promise<void> {
  if (MAX_SCAN_DURATION_MS - (Date.now() - started) < KEYSTROKE_UNLOAD_MIN_BUDGET_MS) return;
  await page.goto("about:blank", { waitUntil: "commit", timeout: 2_000 });
  const remaining = MAX_SCAN_DURATION_MS - (Date.now() - started) - 100;
  if (remaining > 0) await page.waitForTimeout(Math.min(KEYSTROKE_UNLOAD_WAIT_MS, remaining));
}

async function typeSentinelIntoFields(page: Page, sentinel: string): Promise<{ count: number; types: string[] }> {
  const handles = await page.$$(FILLABLE_FIELD_SELECTOR);
  const types: string[] = [];
  let count = 0;

  for (const handle of handles) {
    if (count >= MAX_PROBE_FIELDS) {
      await handle.dispose().catch(() => undefined);
      continue;
    }
    try {
      if (!(await handle.isVisible())) continue;
      const fieldType = await handle.evaluate((element) => {
        const node = element as HTMLElement;
        if (node.tagName === "TEXTAREA") return "textarea";
        if (node.isContentEditable) return "contenteditable";
        return (node.getAttribute("type") || "text").toLowerCase();
      });
      await handle.focus();
      await page.keyboard.type(sentinel, { delay: 1 });
      // Some recorders only transmit on blur; never press Enter, which could submit.
      await handle.evaluate((element) => (element as HTMLElement).blur());
      types.push(fieldType);
      count += 1;
    } catch {
      /* skip fields that cannot be focused or typed into */
    } finally {
      await handle.dispose().catch(() => undefined);
    }
  }

  return { count, types };
}

/** Links on the loaded page that plausibly point at a privacy policy. */
async function collectPrivacyPolicyLinks(page: Page): Promise<PolicyLinkCandidate[]> {
  const links = await page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]"))
      .map((anchor) => ({ href: anchor.href, text: (anchor.textContent || "").trim().slice(0, 80) }))
      .filter((link) => /privacy/i.test(link.href) || /privacy/i.test(link.text))
  );
  return links.slice(0, MAX_POLICY_LINK_CANDIDATES);
}

/**
 * Visit the site's privacy policy (in a fresh page of the same SSRF-proxied
 * context) and build the stored cross-check summary: checkable claims matched in
 * the policy text plus observed tracking companies the policy never names.
 * Best-effort: bounded by the scan budget, swallows its own errors, and returns
 * null when there is no policy link, no time, or the fetch looks like an error
 * page. The extra visit's requests are never recorded into the report.
 */
async function probePrivacyPolicy(input: {
  context: BrowserContext;
  links: PolicyLinkCandidate[];
  firstPartyHostname: string;
  requests: NetworkRequestRecord[];
  started: number;
  verifyPublicUrl: (url: URL) => Promise<void>;
  warnings: ScanWarningCollector;
}): Promise<PrivacyPolicySummary | null> {
  if (MAX_SCAN_DURATION_MS - (Date.now() - input.started) < PRIVACY_POLICY_MIN_BUDGET_MS) return null;

  const policyUrl = pickPrivacyPolicyLink(input.links, input.firstPartyHostname);
  if (!policyUrl) return null;
  const parsed = safeParseUrl(policyUrl);
  if (!parsed) return null;
  // Same SSRF posture as every other navigation: shape + DNS preflight here,
  // with the context's connect-time public-address proxy as the backstop.
  await input.verifyPublicUrl(parsed);

  const policyPage = await input.context.newPage();
  let requestCount = 0;
  try {
    await policyPage.route("**/*", async (route) => {
      requestCount += 1;
      const resourceType = route.request().resourceType();
      const isHttp = /^https?:$/.test(safeParseUrl(route.request().url())?.protocol ?? "");
      if (!isHttp || requestCount > MAX_POLICY_PAGE_REQUESTS || ["image", "media", "font"].includes(resourceType)) {
        await route.abort();
        return;
      }
      await route.continue();
    });

    await policyPage.goto(policyUrl, {
      waitUntil: "domcontentloaded",
      timeout: scanTimeout(input.started, PRIVACY_POLICY_NAV_TIMEOUT_MS)
    });
    // CMP-hosted policies often render their text client-side after load.
    const renderWait = Math.min(PRIVACY_POLICY_RENDER_WAIT_MS, MAX_SCAN_DURATION_MS - (Date.now() - input.started) - 500);
    if (renderWait > 0) await policyPage.waitForTimeout(renderWait);

    const policyText = await withScanDeadline(
      policyPage.evaluate((cap) => (document.body?.innerText ?? "").slice(0, cap), MAX_POLICY_TEXT_CHARS),
      input.started,
      MAX_SCAN_DURATION_MS,
      scanTimeoutError
    );

    const trackingEntities = trackerEntitySummaries({ domains: summarizeDomains(input.requests) })
      .filter((entity) => !isOperationalEntity(entity))
      .map((entity) => entity.entity);

    const summary = buildPrivacyPolicySummary({
      url: policyUrl,
      policyText,
      trackingEntities
    });
    if (summary) {
      input.warnings.add(
        `Read the site's privacy policy (${summary.url}) and compared its text against this visit's observed behavior. Policy checks are an automated text match with the matched sentences quoted, not a legal reading.`
      );
    }
    return summary;
  } finally {
    await policyPage.close().catch(() => undefined);
  }
}

// Cap captured POST bodies before we retain, parse, or substring-search them.
// The scanned page controls these bodies, so without a bound a single very large
// POST would be copied into scan memory and then JSON-parsed (pixel decoding) or
// scanned for the keystroke sentinel. 64 KB is far above real pixel/beacon
// payloads, so decoding stays lossless in practice while the work stays bounded.
const MAX_CAPTURED_BODY_CHARS = 64_000;

// Playwright exposes the POST body synchronously, but reading it can throw for
// some request types; pixel decoding treats an unreadable body as "no body".
// Over-long bodies are truncated (see MAX_CAPTURED_BODY_CHARS).
function safeRequestPostData(request: Request): string | null {
  try {
    const body = request.postData();
    if (body === null) return null;
    return body.length > MAX_CAPTURED_BODY_CHARS ? body.slice(0, MAX_CAPTURED_BODY_CHARS) : body;
  } catch {
    return null;
  }
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.message.toLowerCase().includes("timeout");
}

// A navigation failure reason safe for operator logs: the Chromium net error
// code if present, otherwise a generic label. Never the raw message, which
// embeds the full target URL (query string and all).
function navigationFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.match(/net::[A-Z0-9_]+/)?.[0] ?? "navigation failed";
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

async function resolveCnameCloaksForScan(
  requests: NetworkRequestRecord[],
  firstPartyHostname: string,
  started: number,
  options: ScanSiteOptions,
  matchTracker: (host: string) => TrackerMatch | null
): Promise<CnameCloak[]> {
  if (MAX_SCAN_DURATION_MS - (Date.now() - started) < CNAME_PROBE_MIN_BUDGET_MS) return [];
  try {
    return await resolveCnameCloaks(requests, firstPartyHostname, {
      registrableDomain: partyKey,
      matchTracker,
      resolveCnameChain: options.resolveCnameChain ?? resolveCnameChainViaDns,
      maxHosts: MAX_CNAME_LOOKUPS
    });
  } catch {
    return [];
  }
}

/** Follow a hostname's CNAME chain via DNS, bounded by hops and a per-lookup timeout. */
async function resolveCnameChainViaDns(host: string): Promise<string[]> {
  const chain: string[] = [];
  let current = host;
  for (let hop = 0; hop < CNAME_MAX_HOPS; hop += 1) {
    let records: string[];
    try {
      records = await withDnsTimeout(dnsPromises.resolveCname(current));
    } catch {
      break; // No CNAME (reached the A record), NXDOMAIN, or timeout.
    }
    const next = records[0];
    if (!next) break;
    chain.push(next);
    current = next;
  }
  return chain;
}

function withDnsTimeout(operation: Promise<string[]>): Promise<string[]> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<string[]>((_, reject) => {
    timer = setTimeout(() => reject(new Error("dns-lookup-timeout")), CNAME_LOOKUP_TIMEOUT_MS);
  });
  return Promise.race([operation, timeout]).finally(() => clearTimeout(timer));
}
