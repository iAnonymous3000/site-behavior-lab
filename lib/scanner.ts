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
  FingerprintDetectionSummary,
  FingerprintEventSummary,
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
  consentVisibilityArgs,
  findAndClickConsentControl,
  findVisibleConsentControl,
  type ConsentClickOutcome,
  type ConsentChoice,
  type ConsentInteractionSummary
} from "./consent-interaction";
import {
  CONSENT_RELOAD_DISCLOSURE,
  consentVerificationEnabled,
  onetrustObservedState,
  ONETRUST_CONSENT_COOKIE,
  ONETRUST_COOKIE_METHOD,
  readTcfApiState,
  TCF_API_METHOD,
  TCF_READ_TIMEOUT_MS,
  tcfObservedState,
  type TcfApiReadOutcome
} from "./consent-verification";
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
import { MeasurementKernel, deriveCookieMutations, deriveStorageMutations } from "./measurement-kernel";
import {
  collectFingerprintObservationsWithCoverage,
  fingerprintObserverInitScript,
  type FingerprintObservations
} from "./fingerprint-observer";
import { startPublicScanProxy, type ResolvePublicHost } from "./public-scan-proxy";
import { chromiumSandboxEnabled } from "./chromium-sandbox";
import {
  aggregateByteBudgetWarning,
  collectStorageEntries,
  ScanNetworkRecorder,
  ScanRequestBudget,
  scanTimeoutMs,
  ScanWarningCollector,
  verifyRoutedHttpRequest,
  withScanDeadline
} from "./scan-runtime";
import type {
  ConsentFactsR2,
  ConsentObservationFactsR2,
  MeasurementKernelResultR2
} from "./scan-result-v2-r2-builder";
import type {
  BannerTransitionR2,
  GpcVerificationFactsR2,
  RunEvidenceR2,
  ShieldsVerificationFactsR2
} from "./scan-report-v2-r2";
import type { ConditionVector } from "./scan-report-v2";

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
const SCANNER_EGRESS_REGION_ENV = "SITE_BEHAVIOR_LAB_SCANNER_EGRESS_REGION";
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
// Post-choice reload (kernel step 3, flag-gated): budget needed to bother, its
// own navigation timeout, and a short settle before the registered consent
// state is read back. Reload traffic never enters the v1 request log.
const CONSENT_RELOAD_MIN_BUDGET_MS = 8_000;
const CONSENT_RELOAD_NAV_TIMEOUT_MS = 10_000;
const CONSENT_RELOAD_SETTLE_IDLE_TIMEOUT_MS = 1_500;
// Privacy-policy cross-check: budget needed for the extra page visit, its own
// navigation timeout, a short wait for JS-rendered policies (CMP-hosted pages),
// and hard caps on links considered, subresources loaded, and text analyzed.
const PRIVACY_POLICY_MIN_BUDGET_MS = 7_000;
const PRIVACY_POLICY_NAV_TIMEOUT_MS = 8_000;
const PRIVACY_POLICY_RENDER_WAIT_MS = 1_000;
const MAX_POLICY_LINK_CANDIDATES = 12;
const MAX_POLICY_PAGE_REQUESTS = 150;
const MAX_POLICY_TEXT_CHARS = 400_000;
const BOT_WALL_TITLE_PATTERN =
  /access denied|attention required|just a moment|pardon our interruption|are you (a )?(human|robot)|verify (you are|you'?re|your) (a )?human|checking your browser|unusual traffic|security check|request unsuccessful|captcha|enable javascript/i;

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
  /** Deterministic socket injection for scanner integration tests only. */
  connectProxyUpstreamForTests?: NonNullable<
    NonNullable<Parameters<typeof startPublicScanProxy>[0]>["connectUpstreamForTests"]
  >;
};

/**
 * Phase-1 collection artifact for a live Node single visit. It has the exact
 * measurement/evidence shape consumed by the staged r2 builder. It remains
 * process-local until a public or shadow r2 report is built from it.
 */
export type StagedSingleVisitMeasurement = {
  measurement: MeasurementKernelResultR2;
  evidence: Omit<RunEvidenceR2, "consent">;
  /** Recorded consent facts (RFC 15.4/15.5); present on every consent-mode run. */
  consent?: ConsentFactsR2;
  verificationFacts: {
    gpc: GpcVerificationFactsR2;
    shields: ShieldsVerificationFactsR2;
  };
  /**
   * Raw builder inputs for public and shadow r2 emission (kernel step 4).
   * Process-local only: the raw subject URLs here never serialize anywhere;
   * the r2 builder applies its own redaction when a report is built from them.
   */
  emissionInputs: {
    startedAt: string;
    requestedUrl: string;
    observedUrl: string;
    conditions: ConditionVector;
    adblockEngineLoaded: boolean;
    pageTitle: string;
    durationMs: number;
    warnings: string[];
    screenshot: string | null;
  };
};

type PendingGpcReadback = {
  request: Request | null;
  header: GpcVerificationFactsR2["header"];
  jsSignal: GpcVerificationFactsR2["jsSignal"];
};

type PassiveBoundaryState = {
  cookies: boolean;
  storage: boolean;
  fingerprinting: boolean;
};

type KeystrokeProbeOutcome =
  | { status: "complete"; detection: KeystrokeExfiltrationDetectionSummary | null }
  | { status: "partial"; reason: "budget-unavailable"; detection: null }
  | { status: "failed"; reason: "scan-failed"; detection: null };

type PassiveBoundaryOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; kind: "timeout" | "dropped" };

type ConsentChoiceProbeOutcome = {
  summary: ConsentInteractionSummary;
  readableFrames: number;
};

const stagedSingleVisitMeasurements = new WeakMap<ScanResult, StagedSingleVisitMeasurement>();

/**
 * Read the process-local phase-aware facts attached to a live v1 result.
 * Returning a clone prevents a future consumer from mutating the recorded
 * facts. The attachment is a WeakMap entry, never a public wire property.
 */
export function stagedSingleVisitMeasurement(result: ScanResult): StagedSingleVisitMeasurement | null {
  const measurement = stagedSingleVisitMeasurements.get(result);
  return measurement ? structuredClone(measurement) : null;
}

/** Exported for parity tests; production calls this only at the final v1 seam. */
export function attachStagedSingleVisitMeasurement(
  result: ScanResult,
  measurement: StagedSingleVisitMeasurement
): ScanResult {
  stagedSingleVisitMeasurements.set(result, structuredClone(measurement));
  return result;
}

export async function scanSite(payload: ScanRequestPayload, options: ScanSiteOptions = {}): Promise<ScanResult> {
  throwIfScanAborted(options.signal);
  const started = Date.now();
  const measurementKernel = new MeasurementKernel<Request>(started);
  const passivePhaseId = measurementKernel.beginPhase("passive-load");
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
  const scanProxy = await startPublicScanProxy({
    resolveHost: options.resolvePublicHost,
    connectUpstreamForTests: options.connectProxyUpstreamForTests
  });
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
    // Read environment metadata from the pristine about:blank page before any
    // target script can shadow Navigator getters. The configured locale is
    // producer-owned and must never be replaced with page testimony.
    const configuredUserAgent = await page.evaluate(() => navigator.userAgent);
    await installFingerprintObserver(page, targetUrl.hostname);

    const requestsBlockedByShields = new WeakSet<Request>();
    const requestsBlockedByGuard = new WeakSet<Request>();
    // The source document can navigate or detach before report construction.
    // Keep only the route-time boolean keyed by Playwright's Request identity:
    // raw frame/worker URLs remain transient and never enter the public wire.
    const shieldsMatches = new WeakMap<Request, boolean>();
    let shieldsBlockedRequestCount = 0;
    let shieldsRequestsEvaluated = 0;
    let shieldsRequestsMatched = 0;
    // Meter only the classifier call used by the page route. Later CNAME
    // checks use the original engine and therefore cannot inflate these facts.
    const routedAdblockEngine: RouteAdblockEngine | null = adblockEngine
      ? {
          checkWithMethod: (url, sourceUrl, requestType, method) => {
            shieldsRequestsEvaluated += 1;
            const matched = adblockEngine.checkWithMethod(url, sourceUrl, requestType, method);
            if (matched) shieldsRequestsMatched += 1;
            return matched;
          }
        }
      : null;
    const networkRecorder = new ScanNetworkRecorder<Request>({
      firstPartyHostname: targetUrl.hostname,
      warnings,
      trackerMatcher: findTrackerMatch
    });
    const cookieSnapshots: Array<{ phaseId: number; records: CookieRecord[] }> = [];
    const storageSnapshots: Array<{ phaseId: number; records: StorageRecord[] }> = [];
    let passiveFingerprintObservations: FingerprintObservations | null = null;
    const passiveBoundary: PassiveBoundaryState = {
      cookies: false,
      storage: false,
      fingerprinting: false
    };
    const publicHostChecks = new Map<string, Promise<void>>();
    const inFlightRouteHandlers = new Set<Promise<void>>();

    await page.route("**/*", (route) => {
      const operation = (async () => {
        const request = route.request();
        const decision = await decideRoutedRequest({
          request,
          page,
          targetUrl,
          warnings,
          requestBudget: networkRecorder.requestBudget,
          publicHostChecks,
          shieldsBlockingEnabled: options.shieldsBlockingEnabled,
          adblockEngine: routedAdblockEngine,
          verifyPublicUrl
        });
        if (decision.shieldsMatched !== undefined) {
          shieldsMatches.set(request, decision.shieldsMatched);
        }

        if (decision.action === "continue") {
          await route.continue();
          return;
        }

        try {
          await route.abort();
        } catch (error) {
          // A classifier match is not a retained blocked flag in simulation
          // unless the abort succeeds. Keep failed-abort evidence semantically
          // retained while preserving the route match in the raw facts count.
          if (decision.blockedByShields) shieldsMatches.delete(request);
          throw error;
        }
        if (decision.blockedByShields) {
          // Remove and count only once Playwright confirms the abort. A failed
          // abort is not an actual block and must not erase retained evidence.
          requestsBlockedByShields.add(request);
          networkRecorder.removeRequest(request);
          shieldsBlockedRequestCount += 1;
        } else {
          // Requests successfully aborted by the SSRF/public-address guard (or
          // non-HTTP and over-budget aborts) never loaded, so keep them out of
          // the recorded log and request totals. They remain surfaced through
          // scan warnings.
          requestsBlockedByGuard.add(request);
          networkRecorder.removeRequest(request);
        }
      })();
      inFlightRouteHandlers.add(operation);
      operation.then(
        () => inFlightRouteHandlers.delete(operation),
        () => inFlightRouteHandlers.delete(operation)
      );
      return operation;
    });

    // Kernel step 3 state (flag-gated): registered consent-state readback.
    // Everything recorded here is staged r2 fact material. It remains private
    // until an r2 builder sanitizes and projects it onto a report wire.
    const verificationFlagOn = consentVerificationEnabled();
    const verificationEnabled = payload.consentMode !== "observe" && verificationFlagOn;
    const consentObservations: ConsentObservationFactsR2[] = [];
    const bannerObservations: BannerTransitionR2["observations"][number][] = [];
    const consentReadState = { sequence: 0, reloadPhaseId: null as number | null };

    const recordRequest = (request: Request) => {
      if (requestsBlockedByShields.has(request) || requestsBlockedByGuard.has(request)) return;
      const phaseId = measurementKernel.tagRequest(request);
      // Post-choice reload traffic exists only to read the registered consent
      // state back; it never enters the v1 request log or counts (the report
      // warning discloses exactly that).
      if (consentReadState.reloadPhaseId !== null && phaseId === consentReadState.reloadPhaseId) return;
      networkRecorder.recordRequest(request, Date.now() - started);
    };
    page.on("request", recordRequest);
    const passiveNavigation = { latestResponseRequest: null as Request | null };
    page.on("response", (response) => {
      networkRecorder.recordResponse(response);
      const request = response.request();
      if (
        measurementKernel.phaseForRequest(request) === passivePhaseId &&
        request.isNavigationRequest() &&
        request.resourceType() === "document" &&
        safeRequestFrame(request) === safeMainFrame(page)
      ) {
        passiveNavigation.latestResponseRequest = request;
      }
    });

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

    let navigationSettled = true;
    await withScanTimeout(page.waitForLoadState("networkidle", { timeout: scanTimeout(started, NETWORK_IDLE_TIMEOUT_MS) }), started).catch(
      (error) => {
        throwIfScanAborted(options.signal);
        if (isScanBudgetError(error)) throw error;
        navigationSettled = false;
        warnings.add("The page did not reach network idle before the scan window ended.");
      }
    );

    await settleRoutedRequests(inFlightRouteHandlers, started, options.signal);
    const navigationRequest = passiveNavigation.latestResponseRequest;
    const eligibleGpcRequest =
      navigationRequest?.isNavigationRequest() === true &&
      navigationRequest.resourceType() === "document" &&
      measurementKernel.phaseForRequest(navigationRequest) === passivePhaseId
        ? navigationRequest
        : null;
    const pendingGpcReadback = await captureGpcReadback({
      page,
      request: eligibleGpcRequest,
      started,
      signal: options.signal
    });

    // Kernel step 3 helpers. Weak banner-visibility moments plus the strong
    // CMP interpreters (TCF API in-page read, OneTrust consent cookie), each
    // mapped to the closed observed-state vocabulary before anything is
    // retained; raw CMP payloads never leave the read. Best-effort: a failed
    // read records its structured failure outcome and the scan continues.
    const probeConsentBannerVisibility = async (): Promise<boolean | null> => {
      const args = consentVisibilityArgs();
      let readableFrames = 0;
      for (const frame of page.frames()) {
        try {
          const visible = await withScanTimeout(frame.evaluate(findVisibleConsentControl, args), started);
          readableFrames += 1;
          if (visible) return true;
        } catch (error) {
          if (isScanBudgetError(error)) throw error;
        }
      }
      return readableFrames > 0 ? false : null;
    };
    const recordBannerMoment = async (
      moment: BannerTransitionR2["observations"][number]["moment"],
      phaseId: number
    ): Promise<void> => {
      try {
        const visible = await probeConsentBannerVisibility();
        if (visible === null) return;
        // The validator requires strictly increasing moments; guard the
        // degenerate same-millisecond probe pair.
        const lastAtMs = bannerObservations[bannerObservations.length - 1]?.atMs ?? -1;
        bannerObservations.push({ moment, phaseId, atMs: Math.max(measurementKernel.elapsed(), lastAtMs + 1), visible });
      } catch (error) {
        throwIfScanAborted(options.signal);
        if (!isScanBudgetError(error)) throw error;
      }
    };
    const recordConsentStateReadback = async (phaseId: number): Promise<void> => {
      let tcf: TcfApiReadOutcome;
      try {
        tcf = await withScanTimeout(page.evaluate(readTcfApiState, TCF_READ_TIMEOUT_MS), started);
      } catch (error) {
        throwIfScanAborted(options.signal);
        tcf = isScanBudgetError(error) ? { status: "timeout" } : { status: "error" };
      }
      consentReadState.sequence += 1;
      consentObservations.push({
        phaseId,
        method: TCF_API_METHOD,
        ...(tcf.status === "read"
          ? { observed: tcfObservedState(tcf), result: { outcome: "read" as const, sequence: consentReadState.sequence } }
          : tcf.status === "unavailable"
            ? { observed: null, result: { outcome: "unreadable" as const, sequence: consentReadState.sequence } }
            : tcf.status === "timeout"
              ? {
                  observed: null,
                  result: { outcome: "timeout" as const, sequence: consentReadState.sequence, errorCode: "api-timeout" as const }
                }
              : {
                  observed: null,
                  result: {
                    outcome: "error" as const,
                    sequence: consentReadState.sequence,
                    errorCode: "interpreter-threw" as const
                  }
                })
      });

      let onetrustCookie: string | null | undefined;
      try {
        const currentHostname = safeParseUrl(page.url())?.hostname ?? targetUrl.hostname;
        const contextCookies = await withScanTimeout(context!.cookies(), started);
        // Only the scanned site's own cookie may speak for its registration:
        // an embedded vendor's OptanonConsent reflects the vendor, not the site.
        const match = contextCookies.find(
          (cookie) =>
            cookie.name === ONETRUST_CONSENT_COOKIE && !isThirdParty(currentHostname, cookie.domain.replace(/^\./, ""))
        );
        onetrustCookie = match?.value ?? null;
      } catch (error) {
        throwIfScanAborted(options.signal);
        onetrustCookie = undefined;
      }
      consentReadState.sequence += 1;
      if (onetrustCookie === undefined) {
        consentObservations.push({
          phaseId,
          method: ONETRUST_COOKIE_METHOD,
          observed: null,
          result: { outcome: "error", sequence: consentReadState.sequence, errorCode: "interpreter-threw" }
        });
      } else if (onetrustCookie === null) {
        consentObservations.push({
          phaseId,
          method: ONETRUST_COOKIE_METHOD,
          observed: null,
          result: { outcome: "unreadable", sequence: consentReadState.sequence }
        });
      } else {
        const parsed = onetrustObservedState(onetrustCookie);
        consentObservations.push(
          parsed.parsed
            ? {
                phaseId,
                method: ONETRUST_COOKIE_METHOD,
                observed: parsed.observed,
                result: { outcome: "read", sequence: consentReadState.sequence }
              }
            : {
                phaseId,
                method: ONETRUST_COOKIE_METHOD,
                observed: null,
                result: { outcome: "error", sequence: consentReadState.sequence, errorCode: "state-format-unrecognized" }
              }
        );
      }
    };

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
    let consentPhaseId: number | null = null;
    if (payload.consentMode !== "observe" && !pageLoadFailed) {
      // Snapshot the passive-load boundary before any scripted interaction.
      // These reads are internal only; the legacy final snapshot and wire stay
      // exactly where they were.
      const passiveHostname = safeParseUrl(page.url())?.hostname ?? targetUrl.hostname;
      const [passiveCookies, passiveStorage, passiveFingerprint] = await Promise.all([
        capturePassiveBoundary(withScanTimeout(collectCookies(context, passiveHostname), started)),
        capturePassiveBoundary(withScanTimeout(collectStorageEntries(page), started)),
        capturePassiveBoundary(withScanTimeout(collectFingerprintObservationsWithCoverage(page.frames()), started))
      ]);
      // Capture-loss details use the registered budget vocabulary
      // (BUDGET_FAMILIES); the phaseId already records WHICH boundary was lost.
      if (passiveCookies.ok) {
        passiveBoundary.cookies = true;
        cookieSnapshots.push({ phaseId: passivePhaseId, records: passiveCookies.value });
      } else {
        measurementKernel.recordCaptureLoss({
          family: "cookies",
          phaseId: passivePhaseId,
          kind: passiveCookies.kind,
          count: 1,
          detail: "cookie-snapshot"
        });
      }
      if (passiveStorage.ok) {
        passiveBoundary.storage = true;
        storageSnapshots.push({ phaseId: passivePhaseId, records: passiveStorage.value });
      } else {
        measurementKernel.recordCaptureLoss({
          family: "storage",
          phaseId: passivePhaseId,
          kind: passiveStorage.kind,
          count: 1,
          detail: "storage-snapshot"
        });
      }
      if (passiveFingerprint.ok && passiveFingerprint.value.readableFrames > 0) {
        passiveBoundary.fingerprinting = true;
        passiveFingerprintObservations = passiveFingerprint.value.observations;
      } else {
        measurementKernel.recordCaptureLoss({
          family: "fingerprinting",
          phaseId: passivePhaseId,
          kind: passiveFingerprint.ok ? "dropped" : passiveFingerprint.kind,
          count: 1,
          detail: "fingerprint-observer"
        });
      }
      if (MAX_SCAN_DURATION_MS - (Date.now() - started) >= CONSENT_CLICK_MIN_BUDGET_MS) {
        consentPhaseId = measurementKernel.beginPhase("consent-interaction");
        if (verificationEnabled) {
          await recordBannerMoment("before-interaction", consentPhaseId);
        }
      }
    }

    const consentProbeState: {
      failure: "budget-unavailable" | "scan-failed" | "engine-unavailable" | null;
    } = { failure: null };
    const consentProbe =
      payload.consentMode === "observe" || pageLoadFailed
        ? undefined
        : consentPhaseId === null
          ? {
              summary: { mode: payload.consentMode as ConsentChoice, clicked: false },
              readableFrames: 0
            }
          : await withScanTimeout(applyConsentChoice(page, payload.consentMode, started), started).catch(
              (error): ConsentChoiceProbeOutcome => {
                consentProbeState.failure = isScanBudgetError(error) ? "budget-unavailable" : "scan-failed";
                return {
                  summary: { mode: payload.consentMode as ConsentChoice, clicked: false },
                  readableFrames: 0
                };
              }
            );
    const consentInteraction = consentProbe?.summary;
    if (consentPhaseId !== null && consentProbeState.failure === null && consentProbe?.readableFrames === 0) {
      consentProbeState.failure = "engine-unavailable";
    }
    if (consentPhaseId !== null) {
      if (consentProbeState.failure === "budget-unavailable") {
        measurementKernel.setDetector("consent-banner", "partial", {
          reason: "budget-unavailable",
          phaseId: consentPhaseId
        });
      } else if (consentProbeState.failure === "scan-failed") {
        measurementKernel.setDetector("consent-banner", "failed", { reason: "scan-failed", phaseId: consentPhaseId });
      } else if (consentProbeState.failure === "engine-unavailable") {
        measurementKernel.setDetector("consent-banner", "failed", {
          reason: "engine-unavailable",
          phaseId: consentPhaseId
        });
      } else {
        measurementKernel.setDetector("consent-banner", "complete", { phaseId: consentPhaseId });
      }
    } else if (pageLoadFailed && payload.consentMode !== "observe") {
      measurementKernel.setDetector("consent-banner", "skipped", { reason: "load-failed" });
    } else if (payload.consentMode !== "observe") {
      measurementKernel.setDetector("consent-banner", "skipped", { reason: "budget-unavailable" });
    } else if (verificationFlagOn && !pageLoadFailed) {
      // Observe mode with the verification flag on performs ONE non-mutating
      // banner-visibility read so the always-on detector reflects a real
      // detection (the r2 builder rejects a probe-disabled default). Only the
      // detector outcome is recorded: observe-mode runs carry no consent
      // evidence by schema rule.
      try {
        const visible = await probeConsentBannerVisibility();
        if (visible === null) {
          measurementKernel.setDetector("consent-banner", "failed", {
            reason: "engine-unavailable",
            phaseId: passivePhaseId
          });
        } else {
          measurementKernel.setDetector("consent-banner", "complete", { phaseId: passivePhaseId });
        }
      } catch (error) {
        throwIfScanAborted(options.signal);
        if (!isScanBudgetError(error)) throw error;
        measurementKernel.setDetector("consent-banner", "skipped", { reason: "budget-unavailable" });
      }
    } else if (pageLoadFailed) {
      measurementKernel.setDetector("consent-banner", "skipped", { reason: "load-failed" });
    } else {
      // Observe mode without the verification flag performs no banner
      // interaction or detection in v1. Recorded honestly; such runs are not
      // r2 emission candidates until the flag enables the visibility read.
      measurementKernel.setDetector("consent-banner", "skipped", { reason: "probe-disabled" });
    }
    throwIfScanAborted(options.signal);
    if (consentInteraction) {
      warnings.add(consentInteractionWarning(consentInteraction));
    }
    if (verificationEnabled && consentPhaseId !== null) {
      await recordBannerMoment("after-interaction", consentPhaseId);
      await recordConsentStateReadback(consentPhaseId);
    }

    const pageTitle = await withScanTimeout(page.title(), started).catch((error) => {
      if (isScanBudgetError(error)) throw error;
      return "";
    });
    const finalUrl = page.url();
    const finalParsed = safeParseUrl(finalUrl) ?? targetUrl;
    const cookies = await withScanTimeout(collectCookies(context, finalParsed.hostname), started);
    const finalStorage = await capturePassiveBoundary(withScanTimeout(collectStorageEntries(page), started));
    const storage = finalStorage.ok ? finalStorage.value : [];
    const fingerprintCollection = await withScanTimeout(collectFingerprintObservationsWithCoverage(page.frames()), started);
    const fingerprintObservations = fingerprintCollection.observations;
    const stateSnapshotPhaseId = consentPhaseId ?? passivePhaseId;
    cookieSnapshots.push({ phaseId: stateSnapshotPhaseId, records: cookies });
    if (finalStorage.ok) {
      storageSnapshots.push({ phaseId: stateSnapshotPhaseId, records: storage });
    } else {
      measurementKernel.recordCaptureLoss({
        family: "storage",
        phaseId: stateSnapshotPhaseId,
        kind: finalStorage.kind,
        count: 1,
        detail: "storage-snapshot"
      });
    }
    measurementKernel.setDetector(
      "fingerprint-heuristics",
      fingerprintCollection.readableFrames > 0 ? "complete" : "failed",
      fingerprintCollection.readableFrames > 0
        ? { phaseId: stateSnapshotPhaseId }
        : { reason: "engine-unavailable", phaseId: stateSnapshotPhaseId }
    );
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

    // Kernel step 3 (flag-gated): one post-choice reload to read the site's
    // REGISTERED consent state from a fresh document. It runs in its own
    // measurement phase whose traffic is excluded from the v1 request log
    // (recordRequest skips the phase; the warning below discloses it), after
    // the v1 evidence snapshots so the frozen wire is untouched, and before
    // the active-probe phase per the r2 phase-plan ordering. Only a really
    // clicked control has a registration to verify.
    if (verificationEnabled && consentPhaseId !== null && consentInteraction?.clicked === true) {
      const reloadBudgetAvailable = MAX_SCAN_DURATION_MS - (Date.now() - started) >= CONSENT_RELOAD_MIN_BUDGET_MS;
      if (reloadBudgetAvailable) {
        const reloadPhaseId = measurementKernel.beginPhase("post-choice-reload");
        consentReadState.reloadPhaseId = reloadPhaseId;
        warnings.add(CONSENT_RELOAD_DISCLOSURE);
        try {
          await page.goto(page.url(), {
            waitUntil: "domcontentloaded",
            timeout: scanTimeout(started, CONSENT_RELOAD_NAV_TIMEOUT_MS)
          });
          const idleBudgetMs = Math.min(
            CONSENT_RELOAD_SETTLE_IDLE_TIMEOUT_MS,
            MAX_SCAN_DURATION_MS - (Date.now() - started) - 500
          );
          if (idleBudgetMs > 250) {
            await page.waitForLoadState("networkidle", { timeout: idleBudgetMs }).catch(() => undefined);
          }
          await recordBannerMoment("after-reload", reloadPhaseId);
          await recordConsentStateReadback(reloadPhaseId);
          // Post-reload state snapshots feed only the phase-aware mutation
          // ledgers; the v1 wire's cookies/storage stayed frozen above.
          const reloadCookies = await capturePassiveBoundary(
            withScanTimeout(collectCookies(context, finalParsed.hostname), started)
          );
          if (reloadCookies.ok) {
            cookieSnapshots.push({ phaseId: reloadPhaseId, records: reloadCookies.value });
          } else {
            measurementKernel.recordCaptureLoss({
              family: "cookies",
              phaseId: reloadPhaseId,
              kind: reloadCookies.kind,
              count: 1,
              detail: "cookie-snapshot"
            });
          }
          const reloadStorage = await capturePassiveBoundary(withScanTimeout(collectStorageEntries(page), started));
          if (reloadStorage.ok) {
            storageSnapshots.push({ phaseId: reloadPhaseId, records: reloadStorage.value });
          } else {
            measurementKernel.recordCaptureLoss({
              family: "storage",
              phaseId: reloadPhaseId,
              kind: reloadStorage.kind,
              count: 1,
              detail: "storage-snapshot"
            });
          }
        } catch {
          throwIfScanAborted(options.signal);
          // Best-effort verification: a failed reload leaves the round-one
          // observations standing and the scan continues on the reloaded (or
          // original) document.
        }
      }
    }

    // Active input-capture probe: type a synthetic sentinel into form fields and
    // watch for it leaving to a third party. Best-effort and fully bounded, it
    // never throws into the scan and is skipped when the time budget is tight.
    const keystrokeBudgetAvailable = MAX_SCAN_DURATION_MS - (Date.now() - started) >= KEYSTROKE_PROBE_MIN_BUDGET_MS;
    const keystrokePhaseId = keystrokeBudgetAvailable ? measurementKernel.beginPhase("active-probe") : null;
    let keystrokeProbe: KeystrokeProbeOutcome | null = null;
    if (keystrokePhaseId !== null) {
      keystrokeProbe = await withScanTimeout(
        probeKeystrokeExfiltration(page, finalParsed.hostname, started, warnings),
        started
      ).catch(
        (error): KeystrokeProbeOutcome =>
          isScanBudgetError(error)
            ? { status: "partial", reason: "budget-unavailable", detection: null }
            : { status: "failed", reason: "scan-failed", detection: null }
      );
    }
    const keystrokeDetection = keystrokeProbe?.detection ?? null;
    if (keystrokePhaseId === null) {
      measurementKernel.setDetector("keystroke-exfiltration", "skipped", { reason: "budget-unavailable" });
    } else if (keystrokeProbe?.status === "partial") {
      measurementKernel.setDetector("keystroke-exfiltration", "partial", {
        reason: keystrokeProbe.reason,
        phaseId: keystrokePhaseId
      });
    } else if (keystrokeProbe?.status === "failed") {
      measurementKernel.setDetector("keystroke-exfiltration", "failed", {
        reason: keystrokeProbe.reason,
        phaseId: keystrokePhaseId
      });
    } else {
      measurementKernel.setDetector("keystroke-exfiltration", "complete", { phaseId: keystrokePhaseId });
    }
    const fingerprintDetections = keystrokeDetection
      ? [...fingerprintObservations.detections, keystrokeDetection]
      : fingerprintObservations.detections;

    // Decode pixel-level events from the raw (pre-redaction) request and POST
    // body while it is still available here; the public record's URL is scrubbed.
    // Event names are kept; identifier values are detected by key presence only.
    const pixelEventInputs: PixelEventInput[] = [];
    const pixelEventInputsByPhase = new Map<number, PixelEventInput[]>();
    const phaseAwareRequests: Array<NetworkRequestRecord & { phaseId: number }> = [];
    let gpcNavigationRetained = false;
    await settleRoutedRequests(inFlightRouteHandlers, started, options.signal);
    const publicRequests = networkRecorder.publicRecords(finalParsed.hostname, (record, request) => {
      const phaseId = measurementKernel.phaseForRequest(request) ?? passivePhaseId;
      if (
        request === pendingGpcReadback.request &&
        phaseId === passivePhaseId &&
        record.resourceType === "document" &&
        !record.thirdParty
      ) {
        gpcNavigationRetained = true;
      }
      if (record.thirdParty) {
        const input = { url: request.url(), method: record.method, postData: safeRequestPostData(request) };
        pixelEventInputs.push(input);
        const phaseInputs = pixelEventInputsByPhase.get(phaseId) ?? [];
        phaseInputs.push(input);
        pixelEventInputsByPhase.set(phaseId, phaseInputs);
      }
      const decorated = {
        ...record,
        // Reuse the exact route-time decision. Re-evaluating here against the
        // final top-level URL misclassifies iframe and redirected-document
        // requests and can disagree with what the blocking arm actually did.
        blockedByShields: adblockEngine ? shieldsMatches.get(request) : undefined
      };
      phaseAwareRequests.push({ ...decorated, phaseId });
      return decorated;
    });
    // Freeze route facts at the same boundary as retained request evidence.
    // Classification matches derive from those retained flags, while block
    // simulation uses the route count because matched requests were removed.
    const retainedShieldsMatches = publicRequests.filter((request) => request.blockedByShields === true).length;
    const frozenShieldsFacts = {
      requestsEvaluated: shieldsRequestsEvaluated,
      requestsMatched: options.shieldsBlockingEnabled ? shieldsRequestsMatched : retainedShieldsMatches,
      requestsActuallyBlocked: shieldsBlockedRequestCount
    };
    // This is the existing v1 request-log snapshot boundary. Requests from the
    // later policy visit are intentionally excluded, and no late main-page
    // event should stretch the active phase after its evidence was frozen.
    page.off("request", recordRequest);
    measurementKernel.endPhase();
    const pixelEvents = summarizePixelEvents(pixelEventInputs);
    const phaseAwarePixelEvents = [...pixelEventInputsByPhase.entries()].flatMap(([phaseId, inputs]) =>
      summarizePixelEvents(inputs).map((event) => ({ ...event, phaseId }))
    );
    measurementKernel.setDetector("pixel-events", "complete", { phaseId: stateSnapshotPhaseId });

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
    const cnameBudgetAvailable = MAX_SCAN_DURATION_MS - (Date.now() - started) >= CNAME_PROBE_MIN_BUDGET_MS;
    let cnameProbeFailed = false;
    const cnameCloaks = cnameBudgetAvailable
      ? await resolveCnameCloaksForScan(
          publicRequests,
          finalParsed.hostname,
          started,
          options,
          matchCnameTracker,
          () => {
            cnameProbeFailed = true;
          }
        ).catch(() => {
          cnameProbeFailed = true;
          return [];
        })
      : [];
    if (!cnameBudgetAvailable) {
      measurementKernel.setDetector("cname-uncloaking", "skipped", { reason: "budget-unavailable" });
    } else if (cnameProbeFailed) {
      measurementKernel.setDetector("cname-uncloaking", "failed", {
        reason: "scan-failed",
        phaseId: stateSnapshotPhaseId
      });
    } else {
      measurementKernel.setDetector("cname-uncloaking", "complete", { phaseId: stateSnapshotPhaseId });
    }
    if (cnameCloaks.length > 0) {
      warnings.add(
        cnameCloaks.length === 1
          ? "Resolved 1 first-party subdomain that is a CNAME alias for a third-party tracker (CNAME cloaking), which request-URL matching alone would miss."
          : `Resolved ${cnameCloaks.length} first-party subdomains that are CNAME aliases for third-party trackers (CNAME cloaking), which request-URL matching alone would miss.`
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
    const policyCandidate = pageLoadFailed ? null : pickPrivacyPolicyLink(policyLinks, finalParsed.hostname);
    const policyBudgetAvailable = MAX_SCAN_DURATION_MS - (Date.now() - started) >= PRIVACY_POLICY_MIN_BUDGET_MS;
    const policyPhaseId = policyCandidate && policyBudgetAvailable ? measurementKernel.beginPhase("policy-analysis") : null;
    let privacyPolicy: PrivacyPolicySummary | null = null;
    if (policyPhaseId !== null) {
      try {
        privacyPolicy = await probePrivacyPolicy({
          context,
          links: policyLinks,
          firstPartyHostname: finalParsed.hostname,
          requests: publicRequests,
          started,
          verifyPublicUrl,
          warnings
        });
        measurementKernel.setDetector("privacy-policy", "complete", { phaseId: policyPhaseId });
      } catch {
        measurementKernel.setDetector("privacy-policy", "failed", { reason: "load-failed", phaseId: policyPhaseId });
      }
    } else if (policyCandidate && !policyBudgetAvailable) {
      measurementKernel.setDetector("privacy-policy", "skipped", { reason: "budget-unavailable" });
    } else if (pageLoadFailed) {
      // A challenge/error page's policy link is the interstitial vendor's, not
      // the site's; the probe is deliberately withheld on failed loads.
      measurementKernel.setDetector("privacy-policy", "skipped", { reason: "load-failed" });
    } else {
      // The probe is configured on, but the page offers no discoverable policy
      // link: the subject does not support this probe. "unsupported" (not
      // "probe-disabled") keeps the outcome accountable under the r2 builder's
      // declared-probe rule.
      measurementKernel.setDetector("privacy-policy", "unsupported", { reason: "unsupported" });
    }
    throwIfScanAborted(options.signal);

    const proxyDiagnostics = scanProxy.getDiagnostics();
    const responseByteBudget = proxyDiagnostics.responseByteBudget;
    if (responseByteBudget.captureLoss) {
      warnings.add(aggregateByteBudgetWarning("response", responseByteBudget.limitBytes));
    }
    const uploadByteBudget = proxyDiagnostics.uploadByteBudget;
    if (uploadByteBudget.captureLoss) {
      warnings.add(aggregateByteBudgetWarning("upload", uploadByteBudget.limitBytes));
    }

    const requestCapture = networkRecorder.requestBudget.getDiagnostics();
    const captureLossByBudget = new Map<string, { family: "requests"; count: number }>();
    const addBudgetLoss = (name: string, family: "requests", count: number) => {
      const existing = captureLossByBudget.get(name);
      captureLossByBudget.set(name, { family, count: (existing?.count ?? 0) + count });
    };
    if (requestCapture.captureLoss) addBudgetLoss(requestCapture.name, requestCapture.family, 1);
    if (responseByteBudget.captureLoss) {
      addBudgetLoss(responseByteBudget.name, responseByteBudget.family, responseByteBudget.captureLoss.count);
    }
    if (uploadByteBudget.captureLoss) {
      addBudgetLoss(uploadByteBudget.name, uploadByteBudget.family, uploadByteBudget.captureLoss.count);
    }
    for (const [name, loss] of captureLossByBudget) {
      measurementKernel.exhaustBudget({ name, family: loss.family, phaseId: null, count: loss.count });
    }

    const scannerEgress = scannerEgressDescription();
    const egressRegion = scannerEgressRegion();
    const adblockMeta = adblockEngine ? adblockListMeta() : null;
    const conditions = buildScanConditions({
      profile: "node-playwright",
      requestedUrl: targetUrl.toString(),
      finalUrl,
      scannedAt: new Date(started).toISOString(),
      chromiumVersion,
      userAgent: configuredUserAgent,
      timezone: SCAN_TIMEZONE,
      locale: SCAN_LOCALE,
      language: SCAN_LOCALE,
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
    const qualityFacts = measurementKernel.qualityFacts({
      status: responseStatus,
      botWallTitleMatched: BOT_WALL_TITLE_PATTERN.test(pageTitle),
      navigationSettled
    });
    const finishedMeasurement = measurementKernel.finish();
    const fingerprintCollectionPhaseId = consentPhaseId ?? passivePhaseId;
    const canAttributeConsentFingerprinting = consentPhaseId === null || passiveBoundary.fingerprinting;
    const phaseAwareFingerprintDetections = canAttributeConsentFingerprinting
      ? phaseAwareDetections(
          fingerprintObservations.detections,
          passiveFingerprintObservations?.detections ?? null,
          passivePhaseId,
          fingerprintCollectionPhaseId
        )
      : [];
    if (keystrokeDetection && keystrokePhaseId !== null) {
      phaseAwareFingerprintDetections.push({ ...keystrokeDetection, phaseId: keystrokePhaseId });
    }
    const stagedMeasurement: StagedSingleVisitMeasurement = {
      measurement: {
        phases: finishedMeasurement.phases,
        detectors: finishedMeasurement.detectors,
        qualityFacts
      },
      evidence: {
        requests: phaseAwareRequests,
        cookieMutations: consentPhaseId === null || passiveBoundary.cookies ? deriveCookieMutations(cookieSnapshots) : [],
        cookiesFinal: cookies,
        storageMutations:
          finalStorage.ok && (consentPhaseId === null || passiveBoundary.storage) ? deriveStorageMutations(storageSnapshots) : [],
        storageFinal: storage,
        fingerprintEvents: canAttributeConsentFingerprinting
          ? phaseAwareFingerprintEvents(
              fingerprintObservations.events,
              passiveFingerprintObservations?.events ?? null,
              passivePhaseId,
              fingerprintCollectionPhaseId
            )
          : [],
        fingerprintDetections: phaseAwareFingerprintDetections,
        cnameCloaks,
        pixelEvents: phaseAwarePixelEvents,
        ...(privacyPolicy ? { privacyPolicy } : {})
      },
      ...(payload.consentMode !== "observe"
        ? {
            consent: {
              interactionAttempted: consentPhaseId !== null,
              controlActivated: consentInteraction?.clicked === true,
              verificationObservations: consentObservations,
              ...(bannerObservations.length > 0
                ? { bannerTransition: { method: "banner-visibility@1" as const, observations: bannerObservations } }
                : {}),
              ...(consentInteraction?.cmp ? { cmp: consentInteraction.cmp } : {}),
              ...(consentInteraction?.selector ? { selector: consentInteraction.selector } : {}),
              ...(consentInteraction?.matchedText ? { matchedText: consentInteraction.matchedText } : {}),
              ...(consentInteraction?.frameUrl ? { frameUrl: consentInteraction.frameUrl } : {})
            }
          }
        : {}),
      verificationFacts: {
        gpc: {
          method: "gpc-header-readback@1",
          header: gpcNavigationRetained ? pendingGpcReadback.header : "unobservable",
          jsSignal: gpcNavigationRetained ? pendingGpcReadback.jsSignal : "unobservable",
          observedOn: "first-party-navigation",
          phaseId: passivePhaseId
        },
        shields: {
          method: "shields-engine-status@1",
          engineLoaded: adblockEngine !== null,
          applied: adblockEngine !== null && options.shieldsBlockingEnabled === true,
          ...frozenShieldsFacts,
          phaseId: passivePhaseId
        }
      },
      emissionInputs: {
        startedAt: new Date(started).toISOString(),
        requestedUrl: targetUrl.toString(),
        observedUrl: finalUrl,
        conditions: {
          gpc: payload.gpcEnabled,
          shields: options.shieldsBlockingEnabled ? "block-simulation" : "classification",
          consent: payload.consentMode,
          device: {
            kind: payload.device === "mobile" ? "mobile" : "desktop",
            viewport: {
              width: page.viewportSize()?.width ?? DESKTOP_VIEWPORT.width,
              height: page.viewportSize()?.height ?? DESKTOP_VIEWPORT.height,
              isMobile: payload.device === "mobile"
            }
          },
          // The Node scanner's probes are configuration-always-on; skipped
          // outcomes stay accountable through the detector ledger.
          probes: { keystroke: true, policyVisit: true },
          locale: SCAN_LOCALE,
          language: SCAN_LOCALE,
          timezone: SCAN_TIMEZONE,
          egress: {
            label: scannerEgress,
            ...(egressRegion !== undefined ? { region: egressRegion } : {})
          },
          browser: { name: "chromium", version: chromiumVersion },
          headless: true,
          automation: "playwright-chromium"
        },
        adblockEngineLoaded: adblockEngine !== null,
        pageTitle,
        durationMs: Date.now() - started,
        warnings: warnings.list,
        screenshot
      }
    };

    const v1Result = buildScanResult({
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
    return attachStagedSingleVisitMeasurement(v1Result, stagedMeasurement);
  } finally {
    options.signal?.removeEventListener("abort", closeOnAbort);
    await context?.close().catch(() => undefined);
    await scanProxy.close().catch(() => undefined);
  }
}

function phaseAwareFingerprintEvents(
  finalEvents: FingerprintEventSummary[],
  passiveEvents: FingerprintEventSummary[] | null,
  passivePhaseId: number,
  finalPhaseId: number
): Array<FingerprintEventSummary & { phaseId: number }> {
  if (!passiveEvents || passivePhaseId === finalPhaseId) {
    return finalEvents.map((event) => ({ ...event, phaseId: finalPhaseId }));
  }

  const passiveCounts = new Map(passiveEvents.map((event) => [event.api, event.count]));
  return finalEvents.flatMap((event) => {
    const passiveCount = Math.min(event.count, passiveCounts.get(event.api) ?? 0);
    const laterCount = event.count - passiveCount;
    return [
      ...(passiveCount > 0 ? [{ ...event, count: passiveCount, phaseId: passivePhaseId }] : []),
      ...(laterCount > 0 ? [{ ...event, count: laterCount, phaseId: finalPhaseId }] : [])
    ];
  });
}

function phaseAwareDetections(
  finalDetections: FingerprintDetectionSummary[],
  passiveDetections: FingerprintDetectionSummary[] | null,
  passivePhaseId: number,
  finalPhaseId: number
): Array<FingerprintDetectionSummary & { phaseId: number }> {
  if (!passiveDetections || passivePhaseId === finalPhaseId) {
    return finalDetections.map((detection) => ({ ...detection, phaseId: finalPhaseId }));
  }

  const passiveKeys = new Set(passiveDetections.map((detection) => `${detection.kind}\u0000${detection.heuristic}`));
  return finalDetections.map((detection) => ({
    ...detection,
    phaseId: passiveKeys.has(`${detection.kind}\u0000${detection.heuristic}`) ? passivePhaseId : finalPhaseId
  }));
}

function throwIfScanAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new DOMException("The scan was cancelled.", "AbortError");
}

async function settleRoutedRequests(
  inFlight: ReadonlySet<Promise<void>>,
  started: number,
  signal?: AbortSignal
): Promise<void> {
  while (inFlight.size > 0) {
    throwIfScanAborted(signal);
    await withScanTimeout(Promise.allSettled([...inFlight]), started);
  }
  throwIfScanAborted(signal);
}

async function captureGpcReadback(input: {
  page: Page;
  request: Request | null;
  started: number;
  signal?: AbortSignal;
}): Promise<PendingGpcReadback> {
  if (!input.request) {
    return { request: null, header: "unobservable", jsSignal: "unobservable" };
  }

  const header = await withScanTimeout(input.request.headerValue("sec-gpc"), input.started)
    .then<GpcVerificationFactsR2["header"]>((value) =>
      value === null ? "confirmed-absent" : value === "1" ? "confirmed-present" : "unobservable"
    )
    .catch(() => {
      throwIfScanAborted(input.signal);
      return "unobservable" as const;
    });
  const jsSignal = await withScanTimeout(
    input.page.evaluate(() => {
      try {
        if (!("globalPrivacyControl" in navigator)) return "confirmed-absent" as const;
        const value = (navigator as Navigator & { globalPrivacyControl?: unknown }).globalPrivacyControl;
        return value === true
          ? "confirmed-true" as const
          : value === false
            ? "confirmed-false" as const
            : value === undefined
              ? "confirmed-absent" as const
              : "read-failed" as const;
      } catch {
        return "read-failed" as const;
      }
    }),
    input.started
  ).catch(() => {
    throwIfScanAborted(input.signal);
    return "read-failed" as const;
  });

  return { request: input.request, header, jsSignal };
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

async function capturePassiveBoundary<T>(operation: Promise<T>): Promise<PassiveBoundaryOutcome<T>> {
  try {
    return { ok: true, value: await operation };
  } catch (error) {
    return { ok: false, kind: isScanBudgetError(error) ? "timeout" : "dropped" };
  }
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
async function applyConsentChoice(page: Page, choice: ConsentChoice, started: number): Promise<ConsentChoiceProbeOutcome> {
  const summary: ConsentInteractionSummary = { mode: choice, clicked: false };
  let readableFrames = 0;
  if (MAX_SCAN_DURATION_MS - (Date.now() - started) < CONSENT_CLICK_MIN_BUDGET_MS) {
    return { summary, readableFrames };
  }

  const args = consentClickArgs(choice);
  for (let attempt = 0; attempt < CONSENT_BANNER_RETRIES && !summary.clicked; attempt += 1) {
    // Main frame first; consent iframes (Sourcepoint and similar) after it.
    for (const frame of page.frames()) {
      let outcome: ConsentClickOutcome | null;
      try {
        outcome = await frame.evaluate(findAndClickConsentControl, args);
        readableFrames += 1;
      } catch {
        outcome = null;
      }
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

  return { summary, readableFrames };
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
): Promise<KeystrokeProbeOutcome> {
  if (MAX_SCAN_DURATION_MS - (Date.now() - started) < KEYSTROKE_PROBE_MIN_BUDGET_MS) {
    return { status: "partial", reason: "budget-unavailable", detection: null };
  }

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
    if (typed.count === 0) return { status: "complete", detection: null };
    const waitMs = Math.min(KEYSTROKE_EXFIL_WAIT_MS, MAX_SCAN_DURATION_MS - (Date.now() - started) - 250);
    if (waitMs > 0) await page.waitForTimeout(waitMs);
    // Flush batch-on-unload senders: many recorders buffer keystrokes and only
    // transmit via sendBeacon on pagehide. Best-effort and isolated, so a failure
    // here never discards the real-time captures above.
    await flushUnloadBeacons(page, started).catch(() => undefined);
  } catch {
    return { status: "failed", reason: "scan-failed", detection: null };
  } finally {
    page.off("request", onRequest);
  }

  warnings.add(
    `This scan typed a synthetic test value into ${
      typed.count === 1 ? "1 form field" : `${typed.count} form fields`
    } (never submitting the form) to test whether typed input is captured and sent to third parties. The value is synthetic and is not stored. Requests the page sent during and after this typing, including any unload beacons, are part of the recorded request log and counts.`
  );

  return {
    status: "complete",
    detection: buildKeystrokeExfiltrationDetection(findSentinelLeaks(sentinelEncodings(sentinel), captured), {
      fieldsTyped: typed.count,
      fieldTypes: typed.types
    })
  };
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

/**
 * The recorded egress region: an explicit operator declaration first, then
 * the placement metadata Cloudflare Containers injects into every instance
 * (region/location/country), joined so equality means equality on every
 * recorded axis. Undefined when the deployment genuinely cannot name where
 * its traffic leaves from; the r2 comparability gates then keep refusing
 * cross-visit deltas instead of assuming two unknown regions match. Values
 * are recorded verbatim; an oversized declaration fails the r2 build's text
 * envelope rather than being silently rewritten.
 */
export function scannerEgressRegion(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const declared = env[SCANNER_EGRESS_REGION_ENV]?.trim();
  if (declared) return declared;
  const parts = [env.CLOUDFLARE_REGION?.trim(), env.CLOUDFLARE_LOCATION?.trim(), env.CLOUDFLARE_COUNTRY_A2?.trim()];
  const present = parts.filter((part): part is string => part !== undefined && part !== "");
  return present.length > 0 ? present.join("/") : undefined;
}

async function resolveCnameCloaksForScan(
  requests: NetworkRequestRecord[],
  firstPartyHostname: string,
  started: number,
  options: ScanSiteOptions,
  matchTracker: (host: string) => TrackerMatch | null,
  onResolutionFailure?: (host: string) => void
): Promise<CnameCloak[]> {
  if (MAX_SCAN_DURATION_MS - (Date.now() - started) < CNAME_PROBE_MIN_BUDGET_MS) return [];
  return resolveCnameCloaks(requests, firstPartyHostname, {
    registrableDomain: partyKey,
    matchTracker,
    resolveCnameChain: options.resolveCnameChain ?? resolveCnameChainViaDns,
    onResolutionFailure,
    maxHosts: MAX_CNAME_LOOKUPS
  });
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
