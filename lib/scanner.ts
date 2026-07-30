import {
  type Browser,
  chromium,
  devices,
  type BrowserContext,
  type BrowserContextOptions,
  type Frame,
  type Page,
  type Request,
  type Response
} from "playwright";
import { randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
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
  consentShadowRootCaptureArgs,
  consentVisibilityArgs,
  findAndClickConsentControl,
  findVisibleConsentControl,
  installConsentShadowRootCapture,
  type ConsentClickOutcome,
  type ConsentChoice,
  type ConsentInteractionSummary,
  type ConsentProbeFailure
} from "./consent-interaction";
import {
  CONSENT_RELOAD_DISCLOSURE,
  consentVerificationEnabled,
  onetrustObservedState,
  applicableOneTrustConsentCookie,
  ONETRUST_COOKIE_METHOD,
  readTcfApiState,
  TCF_API_METHOD,
  TCF_READ_TIMEOUT_MS,
  tcfObservedState,
  type TcfApiReadOutcome
} from "./consent-verification";
import { decodePixelRequest, summarizePixelEvents, type PixelEventInput } from "./pixel-events";
import {
  buildPrivacyPolicySummary,
  isAllowedPrivacyPolicyUrl,
  pickPrivacyPolicyLink,
  type PolicyLinkCandidate
} from "./privacy-policy";
import {
  isTrackingEntity,
  isTrackingTrackerMatch,
  trackerEntitySummaries
} from "./report-insights";
import { isThirdParty, partyKey, summarizeDomains } from "./domain-utils";
import {
  resolveCnameCloaks,
  type CnameChainResolver,
  type CnameCloakResolution
} from "./cname-uncloaking";
import type { NetworkRequestRecord, TrackerMatch } from "./types";
import { promises as dnsPromises } from "node:dns";
import { PublicScanError } from "./public-errors";
import {
  assertPublicHttpUrl,
  normalizeUrl,
  PUBLIC_URL_DNS_TIMEOUT_MS
} from "./url-safety";
import { safeParseUrl } from "./report-url";
import { redactUrlV2 } from "./redaction-v2";
import { buildScanConditions, buildScanResult } from "./scan-result-builder";
import { MeasurementKernel, deriveCookieMutations, deriveStorageMutations } from "./measurement-kernel";
import {
  collectFingerprintObservationsWithCoverage,
  fingerprintObserverInitScript,
  type FingerprintObservationCollection,
  type FingerprintObservations
} from "./fingerprint-observer";
import {
  startPublicScanProxy,
  type PublicScanProxyDiagnostics,
  type ResolvePublicHost
} from "./public-scan-proxy";
import { chromiumSandboxEnabled } from "./chromium-sandbox";
import {
  aggregateByteBudgetWarning,
  collectBoundedPageContentText,
  collectBoundedPageTitle,
  collectStorageEntriesWithCoverage,
  FINGERPRINT_OBSERVER_CAPTURE_LOSS_WARNING,
  INVALID_UPSTREAM_RESPONSE_WARNING,
  KEYSTROKE_PROBE_INCOMPLETE_WARNING,
  MAX_RECORDED_REQUEST_URL_CHARS,
  PIXEL_DECODE_CAPTURE_LOSS_WARNING,
  UNSETTLED_ROUTED_REQUEST_WARNING,
  ScanNetworkRecorder,
  ScanRequestBudget,
  type ScanRequestBudgetDiagnostics,
  scanAbortError,
  scanTimeoutMs,
  ScanWarningCollector,
  verifyRoutedHttpRequest,
  withDeadlineDisposing,
  withScanDeadline
} from "./scan-runtime";
import {
  runScannerCleanupWithinDeadline,
  SCANNER_OPERATION_TIMEOUT_MS,
  withScannerOperationDeadline
} from "./scanner-resource-lifecycle";
import {
  callBoundedElementCollector,
  callBoundedPageCollector,
  createBoundedPageCollectorKey,
  installBoundedPageCollector
} from "./bounded-page-collector";
import type {
  ConsentObservationFactsR2
} from "./scan-result-v2-r2-builder";
import type {
  BannerTransitionR2,
  GpcVerificationFactsR2
} from "./scan-report-v2-r2";
import {
  createNodeScanMeasurementEnvelope,
  type NodeScanMeasurement,
  type NodeScanMeasurementEnvelope
} from "./node-scan-measurement";
import { scannerEgressLabel, scannerEgressRegion } from "./scanner-egress";
import {
  classifyPageSubject,
  PAGE_SUBJECT_CAPTURE_LOSS_DETAIL,
  PAGE_SUBJECT_UNVERIFIED_STATE,
  PAGE_SUBJECT_UNVERIFIED_WARNING,
  SUSPECTED_CHALLENGE_OR_SOFT_BLOCK_STATE,
  SUSPECTED_CHALLENGE_OR_SOFT_BLOCK_WARNING
} from "./bot-wall-classifier";
import {
  createGpcWorkerInjectionSession,
  GPC_WORKER_CAPTURE_LOSS_WARNING,
  GpcWorkerInjectionError,
  installGlobalPrivacyControlWithWorkerRegistration,
  type GpcWorkerInjectionCheckpoint
} from "./gpc-injection";

export { scannerEgressLabel, scannerEgressRegion } from "./scanner-egress";
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

/**
 * Shields verification facts for the passive load, frozen at ONE boundary.
 *
 * The three counters must stay commensurable, because the r2 evaluator refuses
 * any run where `requestsActuallyBlocked <= requestsMatched <= requestsEvaluated`
 * does not hold, and a refused run is not a degraded report but a failed scan.
 *
 * `boundaryCounters` are the route-time totals snapshotted the instant the
 * passive load settled. A classification arm cannot use its `requestsMatched`
 * directly because matched requests are removed there, so it recounts from the
 * retained per-request flags; that recount must be restricted to the SAME
 * boundary, since a straggler can still be recorded into the passive phase
 * after the snapshot and would otherwise be matched against a frozen
 * denominator that never saw it.
 */
export function freezePassiveShieldsFacts(input: {
  boundaryCounters: { requestsEvaluated: number; requestsMatched: number; requestsActuallyBlocked: number };
  retainedRequests: readonly { id: number; phaseId: number; blockedByShields?: boolean | undefined }[];
  passivePhaseId: number;
  boundaryRequestIds: ReadonlySet<number>;
  blockingEnabled: boolean;
}): { requestsEvaluated: number; requestsMatched: number; requestsActuallyBlocked: number } {
  const retainedPassiveMatches = input.retainedRequests.filter(
    (request) =>
      request.phaseId === input.passivePhaseId &&
      request.blockedByShields === true &&
      input.boundaryRequestIds.has(request.id)
  ).length;
  return {
    requestsEvaluated: input.boundaryCounters.requestsEvaluated,
    requestsMatched: input.blockingEnabled ? input.boundaryCounters.requestsMatched : retainedPassiveMatches,
    requestsActuallyBlocked: input.boundaryCounters.requestsActuallyBlocked
  };
}

export function fingerprintFrameCoverageStatus(
  coverage: Pick<FingerprintObservationCollection, "attemptedFrames" | "readableFrames">
): "complete" | "failed" | "partial" {
  if (coverage.attemptedFrames <= 0 || coverage.readableFrames <= 0) return "failed";
  return coverage.readableFrames === coverage.attemptedFrames ? "complete" : "partial";
}

const DESKTOP_VIEWPORT = { width: 1440, height: 980 };
const MOBILE_VIEWPORT = { width: 390, height: 844 };
const SCAN_TIMEZONE = "UTC";
const SCAN_LOCALE = "en-US";
const SCAN_COLOR_SCHEME = "light" as const;
const NAVIGATION_TIMEOUT_MS = 30_000;
const NETWORK_IDLE_TIMEOUT_MS = 8_000;
const MAX_SCAN_DURATION_MS = 45_000;
/**
 * Held back from every GPC worker-script fetch so its route handler can finish
 * and leave the in-flight set before the scan deadline. The evidence boundary
 * waits for those handlers, and a handler still running when the deadline
 * lands rejects the whole visit instead of publishing what it measured.
 */
const GPC_WORKER_ROUTE_SETTLE_MARGIN_MS = 1_000;
// Active keystroke-exfiltration probe: how many fields to type into, the minimum
// time budget needed to bother, and how long to watch for the sentinel leaving.
const MAX_PROBE_FIELDS = 8;
export const MAX_PROBE_FIELD_CANDIDATES = 64;
export const MAX_PROBE_CAPTURED_REQUESTS = 1_000;
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
const CONSENT_INTERACTION_SUBJECT_WARNING =
  "The consent interaction left the recorded site; later page state was not used and the active input probe was skipped.";
const CONSENT_RELOAD_SUBJECT_WARNING =
  "The post-consent reload left the recorded site; its state was not used and the active input probe was skipped.";
const ACTIVE_PROBE_SUBJECT_WARNING =
  "The page left the recorded site before or during the active input probe; the probe stopped without acting on the other site.";
const PROXY_TRAFFIC_BUDGET_WARNING =
  "The scan stopped opening additional proxy requests after reaching its connection and target safety budget.";
// Privacy-policy cross-check: budget needed for the extra page visit, its own
// navigation timeout, a short wait for JS-rendered policies (CMP-hosted pages),
// and hard caps on links considered, subresources loaded, and text analyzed.
const PRIVACY_POLICY_MIN_BUDGET_MS = 7_000;
const PRIVACY_POLICY_NAV_TIMEOUT_MS = 8_000;
const PRIVACY_POLICY_RENDER_WAIT_MS = 1_000;
const MAX_POLICY_LINK_CANDIDATES = 12;
export const MAX_POLICY_LINKS_INSPECTED = 2_000;
export const MAX_POLICY_LINK_HREF_CHARS = MAX_RECORDED_REQUEST_URL_CHARS;
export const MAX_POLICY_LINK_TEXT_CHARS = 80;
/**
 * How much of a link's text is read to DECIDE whether it is a policy link, as
 * opposed to how much is stored as its label. Matching on the short display
 * budget meant one long link label anywhere on the page reported the whole
 * candidate collection as truncated.
 */
export const MAX_POLICY_LINK_MATCH_TEXT_CHARS = 512;
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

// Chromium needs a small set of host-runtime variables for executable lookup,
// locale, temporary files, fonts, and sandbox/runtime directories. It does not
// need the Next process's application secrets. Supplying an explicit child env
// prevents R2 credentials, Turnstile secrets, scan tokens, and unrelated cloud
// credentials from being inherited by the attacker-facing renderer process.
const BROWSER_PROCESS_ENV_ALLOWLIST = [
  "CHROME_DEVEL_SANDBOX",
  "FONTCONFIG_FILE",
  "FONTCONFIG_PATH",
  "FONTCONFIG_SYSROOT",
  "HOME",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "LD_LIBRARY_PATH",
  "PATH",
  "PLAYWRIGHT_BROWSERS_PATH",
  "TEMP",
  "TMP",
  "TMPDIR",
  "TZ",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_RUNTIME_DIR"
] as const;

export function browserProcessEnvironment(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return Object.fromEntries(
    BROWSER_PROCESS_ENV_ALLOWLIST.flatMap((name) => {
      const value = env[name];
      return typeof value === "string" ? [[name, value] as const] : [];
    })
  );
}

export type ScanSiteOptions = {
  publicUrlAlreadyVerified?: boolean;
  shieldsBlockingEnabled?: boolean;
  /** Cooperatively stops the browser visit and closes its isolated context. */
  signal?: AbortSignal;
  /** Coarse, observed browser lifecycle stages; never a percentage or ETA. */
  onProgress?: (phase: "launching" | "navigating" | "collecting") => void;
  resolvePublicHost?: ResolvePublicHost;
  verifyPublicUrl?: (url: URL) => Promise<void>;
  /** Override CNAME-chain resolution (defaults to node:dns); injected in tests. */
  resolveCnameChain?: CnameChainResolver;
  /** Deterministic socket injection for scanner integration tests only. */
  connectProxyUpstreamForTests?: NonNullable<
    NonNullable<Parameters<typeof startPublicScanProxy>[0]>["connectUpstreamForTests"]
  >;
  /** Force the independent proxy transaction cap in scanner integration tests. */
  proxyTransactionLimitForTests?: NonNullable<
    NonNullable<Parameters<typeof startPublicScanProxy>[0]>["transactionLimit"]
  >;
  /**
   * Shorten only the non-mutating consent-visibility evaluation deadline in
   * scanner integration tests. Production always uses the absolute scan
   * deadline.
   */
  consentVisibilityProbeTimeoutMsForTests?: number;
  /**
   * Coordinate frame lifecycle immediately before consent evaluation in
   * scanner integration tests. Production never supplies this hook.
   */
  beforeConsentSubframeEvaluationForTests?: (frame: Frame) => Promise<void>;
  /** Exercise the fail-closed subject-validity path with an absent collector capability. */
  forceMissingPageSubjectCollectorForTests?: boolean;
};

export type ScanEvidenceDiagnostics = {
  proxy: PublicScanProxyDiagnostics;
  requestCapture: ScanRequestBudgetDiagnostics;
  gpcWorker: GpcWorkerInjectionCheckpoint | null;
};

type ExcludedScanDiagnosticsInterval = {
  before: ScanEvidenceDiagnostics;
  after: ScanEvidenceDiagnostics;
};

function retainedMonotonicCount(before: number, after: number, final: number): number {
  return before + Math.max(0, final - after);
}

/**
 * Remove one deliberately excluded interval from cumulative scanner-quality
 * counters. The post-choice reload is interleaved before the retained active
 * probe by the r2 phase plan, so the evidence boundary is `before +
 * (final-after)`. The policy probe runs after `final` and never enters these
 * snapshots.
 */
export function retainedScanEvidenceDiagnostics(
  final: ScanEvidenceDiagnostics,
  excluded?: ExcludedScanDiagnosticsInterval
): ScanEvidenceDiagnostics {
  if (!excluded) return final;

  const { before, after } = excluded;
  const retainedTrafficCaptureLoss = retainedMonotonicCount(
    before.proxy.trafficBudget.captureLoss?.count ?? 0,
    after.proxy.trafficBudget.captureLoss?.count ?? 0,
    final.proxy.trafficBudget.captureLoss?.count ?? 0
  );
  const retainedResponseCaptureLoss = retainedMonotonicCount(
    before.proxy.responseByteBudget.captureLoss?.count ?? 0,
    after.proxy.responseByteBudget.captureLoss?.count ?? 0,
    final.proxy.responseByteBudget.captureLoss?.count ?? 0
  );
  const retainedUploadCaptureLoss = retainedMonotonicCount(
    before.proxy.uploadByteBudget.captureLoss?.count ?? 0,
    after.proxy.uploadByteBudget.captureLoss?.count ?? 0,
    final.proxy.uploadByteBudget.captureLoss?.count ?? 0
  );
  const retainedResponseBytes = retainedMonotonicCount(
    before.proxy.responseByteBudget.forwardedBytes,
    after.proxy.responseByteBudget.forwardedBytes,
    final.proxy.responseByteBudget.forwardedBytes
  );
  const retainedUploadBytes = retainedMonotonicCount(
    before.proxy.uploadByteBudget.forwardedBytes,
    after.proxy.uploadByteBudget.forwardedBytes,
    final.proxy.uploadByteBudget.forwardedBytes
  );
  const requestCaptureLossCount = retainedMonotonicCount(
    before.requestCapture.captureLossCount,
    after.requestCapture.captureLossCount,
    final.requestCapture.captureLossCount
  );

  let gpcWorker: GpcWorkerInjectionCheckpoint | null = final.gpcWorker;
  if (before.gpcWorker && after.gpcWorker && final.gpcWorker) {
    const beforeGpc = before.gpcWorker.diagnostics;
    const afterGpc = after.gpcWorker.diagnostics;
    const finalGpc = final.gpcWorker.diagnostics;
    const ambiguousWorkerRequestCount = retainedMonotonicCount(
      beforeGpc.ambiguousWorkerRequestCount,
      afterGpc.ambiguousWorkerRequestCount,
      finalGpc.ambiguousWorkerRequestCount
    );
    const beforePendingIds = new Set(before.gpcWorker.pendingWorkerRegistrationIds);
    const excludedPendingIds = new Set(
      after.gpcWorker.pendingWorkerRegistrationIds.filter((registrationId) => !beforePendingIds.has(registrationId))
    );
    const pendingWorkerRegistrationIds = final.gpcWorker.pendingWorkerRegistrationIds.filter(
      (registrationId) => !excludedPendingIds.has(registrationId)
    );
    const pendingWorkerRegistrationCount = pendingWorkerRegistrationIds.length;
    const transformFailureCount = retainedMonotonicCount(
      beforeGpc.transformFailureCount,
      afterGpc.transformFailureCount,
      finalGpc.transformFailureCount
    );
    const unsupportedWorkerCount = retainedMonotonicCount(
      beforeGpc.unsupportedWorkerCount,
      afterGpc.unsupportedWorkerCount,
      finalGpc.unsupportedWorkerCount
    );
    gpcWorker = {
      diagnostics: {
        ambiguousWorkerRequestCount,
        captureLossCount:
          ambiguousWorkerRequestCount +
          pendingWorkerRegistrationCount +
          transformFailureCount +
          unsupportedWorkerCount,
        pendingWorkerRegistrationCount,
        transformFailureCount,
        unsupportedWorkerCount
      },
      pendingWorkerRegistrationIds
    };
  }

  return {
    proxy: {
      invalidUpstreamResponseCount: retainedMonotonicCount(
        before.proxy.invalidUpstreamResponseCount,
        after.proxy.invalidUpstreamResponseCount,
        final.proxy.invalidUpstreamResponseCount
      ),
      trafficBudget: {
        ...final.proxy.trafficBudget,
        transactionsSeen: retainedMonotonicCount(
          before.proxy.trafficBudget.transactionsSeen,
          after.proxy.trafficBudget.transactionsSeen,
          final.proxy.trafficBudget.transactionsSeen
        ),
        uniqueTargetsSeen: retainedMonotonicCount(
          before.proxy.trafficBudget.uniqueTargetsSeen,
          after.proxy.trafficBudget.uniqueTargetsSeen,
          final.proxy.trafficBudget.uniqueTargetsSeen
        ),
        captureLoss: retainedTrafficCaptureLoss > 0
          ? {
              family: "requests",
              phaseId: null,
              kind: "cap",
              count: retainedTrafficCaptureLoss,
              detail: final.proxy.trafficBudget.name
            }
          : null
      },
      responseByteBudget: {
        ...final.proxy.responseByteBudget,
        forwardedBytes: retainedResponseBytes,
        remainingBytes: Math.max(0, final.proxy.responseByteBudget.limitBytes - retainedResponseBytes),
        limitReached: retainedResponseBytes >= final.proxy.responseByteBudget.limitBytes,
        captureLoss: retainedResponseCaptureLoss > 0
          ? {
              family: "requests",
              phaseId: null,
              kind: "cap",
              count: retainedResponseCaptureLoss,
              detail: final.proxy.responseByteBudget.name
            }
          : null
      },
      uploadByteBudget: {
        ...final.proxy.uploadByteBudget,
        forwardedBytes: retainedUploadBytes,
        remainingBytes: Math.max(0, final.proxy.uploadByteBudget.limitBytes - retainedUploadBytes),
        limitReached: retainedUploadBytes >= final.proxy.uploadByteBudget.limitBytes,
        captureLoss: retainedUploadCaptureLoss > 0
          ? {
              family: "requests",
              phaseId: null,
              kind: "cap",
              count: retainedUploadCaptureLoss,
              detail: final.proxy.uploadByteBudget.name
            }
          : null
      }
    },
    requestCapture: {
      ...final.requestCapture,
      captureLoss: requestCaptureLossCount > 0,
      captureLossCount: requestCaptureLossCount
    },
    gpcWorker
  };
}

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

export type KeystrokeProbeOutcome =
  | { status: "complete"; detection: KeystrokeExfiltrationDetectionSummary | null }
  | {
      status: "partial";
      reason: "budget-unavailable" | "evidence-cap-reached" | "load-failed" | "scan-failed";
      detection: KeystrokeExfiltrationDetectionSummary | null;
      captureLossCount?: number;
      subjectLost?: true;
    }
  | { status: "skipped"; reason: "load-failed"; detection: null; subjectLost: true }
  | { status: "failed"; reason: "scan-failed"; detection: null };

type KeystrokeProbeLifecycle = {
  cancelled: boolean;
  typedFieldCount: number;
  stopCapture: () => void;
};

export function completedKeystrokeProbeOutcome(
  detection: KeystrokeExfiltrationDetectionSummary | null,
  evidenceCapLossCount: number,
  failureLossCount = 0
): KeystrokeProbeOutcome {
  if (failureLossCount > 0) {
    return {
      status: "partial",
      reason: "scan-failed",
      detection,
      ...(evidenceCapLossCount > 0 ? { captureLossCount: evidenceCapLossCount } : {})
    };
  }
  return evidenceCapLossCount > 0
    ? {
        status: "partial",
        reason: "evidence-cap-reached",
        detection,
        captureLossCount: evidenceCapLossCount
      }
    : { status: "complete", detection };
}

/** One unknown-size request-evidence boundary was lost after the probe promise escaped its caller. */
export function incompleteKeystrokeProbeRequestLoss(
  phaseId: number,
  kind: "timeout" | "dropped" = "timeout"
) {
  return {
    family: "requests" as const,
    phaseId,
    kind,
    count: 1
  };
}

type PassiveBoundaryOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; kind: "timeout" | "dropped" };

type ConsentChoiceProbeOutcome = {
  summary: ConsentInteractionSummary;
  readableFrames: number;
  /**
   * True when the probe declined to start because too little scan budget was
   * left. Distinct from "no frame was readable": one is the scanner running out
   * of time, the other is the page's frames refusing evaluation, and the
   * detector ledger records different reasons for them.
   */
  budgetExhausted?: boolean;
  /**
   * Frames the probe asked to search and could not read to the end.
   *
   * The dominant cause is the thing this probe is FOR: a consent control that
   * navigates or reloads on click destroys the execution context, and the
   * in-page result is lost with it. The click landed, the page moved, and the
   * only channel that could have said so is gone. Zero readable frames is a
   * different failure and is counted separately.
   */
  unreadableFrames?: number;
  /**
   * Clicks that landed on a candidate which never visibly responded. The page
   * was clicked, so the visit's evidence can span both sides of a choice even
   * though no control could be attributed.
   */
  dispatchedControls?: number;
  /**
   * Top-document navigations observed during the probe.
   *
   * An unreadable frame has two very different causes that look identical from
   * outside: a consent control that reloads the page on click (the page really
   * did move out from under the search) and an unrelated third-party iframe
   * detaching mid-probe (it did not). Guessing the first from the frame count
   * alone published "the page moved out from under the search" for any
   * ad-funded page with churning iframes. This counts the navigation instead of
   * inferring it.
   */
  mainFrameNavigations?: number;
};

const publicHostCheckFailures = new WeakMap<Map<string, Promise<void>>, Map<string, number>>();
const MAX_PUBLIC_HOST_CHECK_ATTEMPTS = 2;

/** Frozen-v1 compatibility entrypoint for direct scanner consumers. */
export async function scanSite(payload: ScanRequestPayload, options: ScanSiteOptions = {}): Promise<ScanResult> {
  return (await scanSiteWithMeasurement(payload, options)).result;
}

/** Real Node producer entrypoint: the v1 result and r2 facts travel together. */
export async function scanSiteWithMeasurement(
  payload: ScanRequestPayload,
  options: ScanSiteOptions = {}
): Promise<NodeScanMeasurementEnvelope> {
  throwIfScanAborted(options.signal);
  const started = Date.now();
  const measurementKernel = new MeasurementKernel<Request>(started);
  const passivePhaseId = measurementKernel.beginPhase("passive-load");
  const targetUrl = normalizeUrl(payload.url);
  const verifyPublicUrl = options.verifyPublicUrl ?? assertPublicHttpUrl;
  if (!options.publicUrlAlreadyVerified) {
    await withScannerOperationDeadline(
      (signal) =>
        options.verifyPublicUrl
          ? options.verifyPublicUrl(targetUrl)
          : assertPublicHttpUrl(targetUrl, { signal, timeoutMs: PUBLIC_URL_DNS_TIMEOUT_MS }),
      {
        label: "initial public target verification",
        timeoutMs: PUBLIC_URL_DNS_TIMEOUT_MS,
        signal: options.signal,
        createTimeoutError: () =>
          new PublicScanError("Public host verification timed out. Try again shortly.", 503)
      }
    );
  }

  const warnings = new ScanWarningCollector([
    payload.consentMode === "observe"
      ? "This report is one automated, headless Chromium visit from a fixed en-US / UTC profile, with no scrolling, clicking, or consent interaction. Sites can behave differently for real users, browsers, regions, accounts, or network locations."
      : "This report is one automated, headless Chromium visit from a fixed en-US / UTC profile, with no scrolling or clicking except one scripted choice on the cookie/consent banner (disclosed below). Sites can behave differently for real users, browsers, regions, accounts, or network locations.",
    payload.consentMode === "observe"
      ? "Counts are a lower bound: trackers that load only after interaction or consent are not observed; Service Workers are blocked, and Web Worker or WebSocket traffic may be incomplete. Service labels use a US-biased hand-curated catalog, so regional services may be under-labeled. Cookie and storage figures are an end-of-visit snapshot, with storage keys read from the top frame only."
      : "Counts are a lower bound: trackers that load only after further interaction are not observed; Service Workers are blocked, and Web Worker or WebSocket traffic may be incomplete. Service labels use a US-biased hand-curated catalog, so regional services may be under-labeled. Cookie and storage figures are an end-of-visit snapshot, with storage keys read from the top frame only."
  ]);

  options.onProgress?.("launching");
  // Setup is inside the advertised duration, not before it. Launching, adblock
  // readiness, proxy startup, and context/page creation used to run unbounded,
  // so a wedged Playwright or DNS call held one of only two scan slots with no
  // deadline to end it. The browser and engine are process-wide singletons that
  // other scans reuse, so they are bounded but never disposed here.
  const browser = await withScanTimeout(getSharedBrowser(), started);
  throwIfScanAborted(options.signal);
  const chromiumVersion = browser.version();
  const adblockEngine = await withScanTimeout(getAdblockEngine(), started);
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
  const verificationFlagOn = consentVerificationEnabled();
  const consentShadowRootCapability = randomBytes(32).toString("hex");
  const boundedPageCollectorKey = createBoundedPageCollectorKey();
  const gpcWorkerInjection = payload.gpcEnabled
    ? createGpcWorkerInjectionSession({
        // Leave the caller room to fulfill the route and settle it before the
        // scan deadline: an in-flight handler AT the deadline discards a
        // measurement that had otherwise finished.
        routeFetchTimeoutMs: () =>
          MAX_SCAN_DURATION_MS - (Date.now() - started) - GPC_WORKER_ROUTE_SETTLE_MARGIN_MS
      })
    : null;
  let context: BrowserContext | null = null;
  const scanProxy = await withScanTimeoutDisposing(
    () =>
      startPublicScanProxy({
        resolveHost: options.resolvePublicHost,
        connectUpstreamForTests: options.connectProxyUpstreamForTests,
        transactionLimit: options.proxyTransactionLimitForTests
      }),
    started,
    (proxy) => proxy.close(),
    options.signal
  );
  const closeOnAbort = () => {
    // Abort handlers cannot await, but closing both resources immediately
    // rejects in-flight Playwright work and tears down pending proxy connects.
    void context?.close().catch(() => undefined);
    void scanProxy.close().catch(() => undefined);
  };
  options.signal?.addEventListener("abort", closeOnAbort, { once: true });

  try {
    throwIfScanAborted(options.signal);
    context = await withScanTimeoutDisposing(
      () => browser.newContext(createContextOptions(payload, scanProxy.server)),
      started,
      (created) => created.close(),
      options.signal
    );
    throwIfScanAborted(options.signal);
    await withScanTimeout(context.addInitScript(installBoundedPageCollector, boundedPageCollectorKey), started);
    if (payload.consentMode !== "observe" || verificationFlagOn) {
      await withScanTimeout(
        context.addInitScript(
          installConsentShadowRootCapture,
          consentShadowRootCaptureArgs(consentShadowRootCapability)
        ),
        started
      );
    }
    if (gpcWorkerInjection) {
      await withScanTimeout(
        context.exposeBinding(gpcWorkerInjection.bindingName, (source, value) => {
          gpcWorkerInjection.register(source, value);
        }),
        started
      );
      await withScanTimeout(context.setExtraHTTPHeaders({ "Sec-GPC": "1" }), started);
    }

    const page = await withScanTimeout(context.newPage(), started);
    if (gpcWorkerInjection) {
      // Scope the registration wrapper to the measured page and its child
      // frames. Popups and the later out-of-evidence policy page do not share
      // this page-local route transformer, so they must not create tickets in
      // the measured session.
      await withScanTimeout(
        page.addInitScript(
          installGlobalPrivacyControlWithWorkerRegistration,
          gpcWorkerInjection.initScriptArgs
        ),
        started
      );
    }
    // Read environment metadata from the pristine about:blank page before any
    // target script can shadow Navigator getters. The configured locale is
    // producer-owned and must never be replaced with page testimony.
    const configuredUserAgent = await withScanTimeout(page.evaluate(() => navigator.userAgent), started);
    await withScanTimeout(installFingerprintObserver(page, targetUrl.hostname), started);

    const requestsBlockedByShields = new WeakSet<Request>();
    const requestsBlockedByGuard = new WeakSet<Request>();
    // The source document can navigate or detach before report construction.
    // Keep only the route-time boolean keyed by Playwright's Request identity:
    // raw frame/worker URLs remain transient and never enter the public wire.
    const shieldsMatches = new WeakMap<Request, boolean>();
    // Preserve the route-time subframe/document distinction for the later
    // CNAME rule probe. Calling request.frame() after a frame detaches can no
    // longer recover that distinction, while the public wire intentionally
    // keeps the older coarse `document` resource type.
    const cnameRequestTypes = new WeakMap<Request, string>();
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
      trackerMatcher: findTrackerMatch,
      deferRequestBudgetWarning: true
    });
    const snapshotScanEvidenceDiagnostics = (): ScanEvidenceDiagnostics => ({
      proxy: scanProxy.getDiagnostics(),
      requestCapture: networkRecorder.requestBudget.getDiagnostics(),
      gpcWorker: gpcWorkerInjection?.checkpoint() ?? null
    });
    let beforeExcludedReloadDiagnostics: ScanEvidenceDiagnostics | null = null;
    let afterExcludedReloadDiagnostics: ScanEvidenceDiagnostics | null = null;
    const cookieSnapshots: Array<{ phaseId: number; records: CookieRecord[] }> = [];
    const storageSnapshots: Array<{ phaseId: number; records: StorageRecord[] }> = [];
    let passiveCookiesForTrustedSubject: CookieRecord[] | null = null;
    let passiveStorageForTrustedSubject: StorageRecord[] | null = null;
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
        cnameRequestTypes.set(
          request,
          mapRequestType(request.resourceType(), { subFrame: requestIsSubFrameNavigation(request) })
        );
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

        if (decision.action === "continue" && gpcWorkerInjection) {
          try {
            const fulfillment = await gpcWorkerInjection.buildRouteFulfillment(route);
            if (fulfillment) {
              await route.fulfill(fulfillment);
              return;
            }
          } catch (error) {
            if (!(error instanceof GpcWorkerInjectionError)) throw error;
            await route.abort().catch(() => undefined);
            return;
          }
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
    // Everything recorded here is process-local r2 fact material. It remains private
    // until an r2 builder sanitizes and projects it onto a report wire.
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
    const recordResponse = (response: Response) => {
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
    };
    page.on("response", recordResponse);

    options.onProgress?.("navigating");
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
    const responseStatus = response?.status() ?? null;

    options.onProgress?.("collecting");
    // The navigation itself already succeeded: a failed `goto` throws above and
    // the visit never reaches here. What follows waits for the page to go
    // QUIET, which is a different question.
    //
    // Conflating the two failed the whole run whenever an ordinary dynamic site
    // kept polling, streaming, or beaconing past the observation window, which
    // is most of the modern web and was a third of all scans. A page that is
    // still working is not a page that failed to load, and reporting it as one
    // discarded every real observation the visit had already made.
    //
    // So the navigation fact stays true, and the page staying active is
    // recorded as what it is: the observation window closed first, and the
    // counts below are a lower bound. Every report already carries that
    // lower-bound disclosure, and this warning names the specific reason.
    // Deliberately NOT fed to the subject classifier either: a page that is
    // still busy is not evidence of a challenge, and treating it as one is how
    // an ordinary title on an ordinary dynamic site would become a block-page
    // verdict. Status and page-body signatures carry that judgement instead.
    const navigationSettled = true;
    await withScanTimeout(page.waitForLoadState("networkidle", { timeout: scanTimeout(started, NETWORK_IDLE_TIMEOUT_MS) }), started).catch(
      (error) => {
        throwIfScanAborted(options.signal);
        if (isScanBudgetError(error)) throw error;
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
    // Initial HTTP redirects are part of the passive navigation and may
    // legitimately establish the site being measured. Freeze that subject now,
    // before any scripted consent click can navigate elsewhere and accidentally
    // promote the destination into the scanner's active-interaction scope.
    const trustedSubjectCandidate = safeParseUrl(page.url());
    const trustedSubjectUrl =
      trustedSubjectCandidate &&
      (trustedSubjectCandidate.protocol === "http:" || trustedSubjectCandidate.protocol === "https:")
        ? trustedSubjectCandidate.toString()
        : targetUrl.toString();
    const trustedSubjectHostname = safeParseUrl(trustedSubjectUrl)!.hostname;
    const [trustedSubjectPageTitleRead, trustedSubjectPageTextRead] = await Promise.all([
      withScanTimeout(
        collectBoundedPageTitle(page, boundedPageCollectorKey),
        started
      ).catch((error) => {
        if (isScanBudgetError(error)) throw error;
        return { value: "", truncated: false };
      }),
      withScanTimeout(
        collectBoundedPageContentText(
          page,
          options.forceMissingPageSubjectCollectorForTests
            ? `${boundedPageCollectorKey}-missing`
            : boundedPageCollectorKey
        ),
        started
      ).catch((error) => {
        if (isScanBudgetError(error)) throw error;
        return { value: "", truncated: true, available: false };
      })
    ]);
    const trustedSubjectPageTitle = trustedSubjectPageTitleRead.value;
    const trustedSubjectRequestIds = new Set(
      networkRecorder.publicRecords(trustedSubjectHostname).map((record) => record.id)
    );
    const pageSubjectState = classifyPageSubject({
      pageTitle: trustedSubjectPageTitle,
      pageText: trustedSubjectPageTextRead.value,
      pageTextAvailable: trustedSubjectPageTextRead.available,
      status: responseStatus,
      navigationSettled,
      totalRequests: trustedSubjectRequestIds.size
    });
    const suspectedChallengeOrSoftBlock =
      pageSubjectState === SUSPECTED_CHALLENGE_OR_SOFT_BLOCK_STATE;
    const pageSubjectUnverified = pageSubjectState === PAGE_SUBJECT_UNVERIFIED_STATE;
    const httpLoadFailed = responseStatus !== null && responseStatus >= 400;
    const pageSubjectInvalid =
      httpLoadFailed ||
      suspectedChallengeOrSoftBlock ||
      pageSubjectUnverified;
    if (pageSubjectUnverified) {
      measurementKernel.recordCaptureLoss({
        family: "detector-output",
        phaseId: passivePhaseId,
        kind: "dropped",
        count: 1,
        detail: PAGE_SUBJECT_CAPTURE_LOSS_DETAIL
      });
    }
    const trustedSubjectShieldsFacts = {
      requestsEvaluated: shieldsRequestsEvaluated,
      requestsMatched: shieldsRequestsMatched,
      requestsActuallyBlocked: shieldsBlockedRequestCount
    };

    // Kernel step 3 helpers. Weak banner-visibility moments plus the strong
    // CMP interpreters (TCF API in-page read, OneTrust consent cookie), each
    // mapped to the closed observed-state vocabulary before anything is
    // retained; raw CMP payloads never leave the read. Best-effort: a failed
    // read records its structured failure outcome and the scan continues.
    const probeConsentBannerVisibility = async (): Promise<boolean | null> => {
      const args = consentVisibilityArgs(consentShadowRootCapability);
      let readableFrames = 0;
      for (const frame of page.frames()) {
        try {
          const operation = frame.evaluate(findVisibleConsentControl, args);
          const visible =
            options.consentVisibilityProbeTimeoutMsForTests === undefined
              ? await withScanTimeout(operation, started)
              : await withScanDeadline(
                  operation,
                  Date.now(),
                  Math.max(
                    1,
                    Math.floor(options.consentVisibilityProbeTimeoutMsForTests)
                  ),
                  scanTimeoutError
                );
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
        const currentUrl = page.url();
        const currentHostname = safeParseUrl(currentUrl)?.hostname ?? targetUrl.hostname;
        // Ask for the cookies that APPLY to this exact page rather than every
        // cookie in the context: host, path, secure, and host-only scoping all
        // decide whether the site can actually see a value, and re-deriving
        // that here would be a second, worse implementation of cookie matching.
        // A cookie set for another host or another path of the same
        // registrable domain does not speak for this page's registration.
        const contextCookies = await withScanTimeout(context!.cookies(currentUrl), started);
        onetrustCookie = applicableOneTrustConsentCookie(contextCookies, currentHostname, isThirdParty);
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
    const collectStorageSnapshot = async (phaseId: number): Promise<StorageRecord[]> => {
      const collection = await collectStorageEntriesWithCoverage(page, boundedPageCollectorKey);
      if (collection.truncated) {
        measurementKernel.recordCaptureLoss({
          family: "storage",
          phaseId,
          kind: "truncated",
          count: Math.max(1, collection.omittedCount),
          detail: "storage-snapshot"
        });
      }
      return collection.records;
    };

    // An HTTP-error top-level response does not reject goto, so the scan otherwise
    // completes and an error/block page reads as a low-tracker (falsely "private")
    // result. Surface it as a warning, and the headline/findings reframe it.
    if (httpLoadFailed) {
      warnings.add(`The page returned HTTP ${responseStatus}; this report reflects an error or block page, not a normal load.`);
    }
    if (suspectedChallengeOrSoftBlock) {
      warnings.add(SUSPECTED_CHALLENGE_OR_SOFT_BLOCK_WARNING);
    }
    if (pageSubjectUnverified) {
      warnings.add(PAGE_SUBJECT_UNVERIFIED_WARNING);
    }

    let consentInteractionLeftSubject = false;
    const recordedConsentCoverageLosses = new Set<string>();
    const recordConsentCoverageLoss = (
      phaseId: number | null,
      kind: "cap" | "dropped",
      includeVerification: boolean
    ): void => {
      const record = (
        family: "detector-output" | "consent-verification",
        detail: "consent-banner" | "consent-verification"
      ) => {
        const key = `${family}:${phaseId ?? "none"}:${kind}`;
        if (recordedConsentCoverageLosses.has(key)) return;
        recordedConsentCoverageLosses.add(key);
        measurementKernel.recordCaptureLoss({
          family,
          phaseId,
          kind,
          count: 1,
          detail
        });
      };
      record("detector-output", "consent-banner");
      if (includeVerification) record("consent-verification", "consent-verification");
    };
    const markConsentInteractionSubjectLoss = (phaseId: number) => {
      if (consentInteractionLeftSubject) return;
      consentInteractionLeftSubject = true;
      warnings.add(CONSENT_INTERACTION_SUBJECT_WARNING);
      for (const family of ["requests", "cookies", "storage", "fingerprinting"] as const) {
        measurementKernel.recordCaptureLoss({ family, phaseId, kind: "dropped", count: 1 });
      }
      recordConsentCoverageLoss(phaseId, "dropped", verificationEnabled);
    };

    // Consent-choice modes: dispatch the Accept all / Reject all click on the
    // banner now. Collection is cumulative for the whole visit (traffic from
    // before AND after the click), and the site's registered consent state is
    // never verified; the report copy must say so. Skipped on failed loads: an
    // interstitial's banner (a challenge page's cookie notice) is not the
    // site's consent banner.
    let consentPhaseId: number | null = null;
    if (payload.consentMode !== "observe" && !pageSubjectInvalid) {
      // Snapshot the passive-load boundary before any scripted interaction.
      // These reads are internal only; the legacy final snapshot and wire stay
      // exactly where they were.
      const [passiveCookies, passiveStorage, passiveFingerprint] = await Promise.all([
        capturePassiveBoundary(withScanTimeout(collectCookies(context, trustedSubjectHostname), started)),
        capturePassiveBoundary(withScanTimeout(collectStorageSnapshot(passivePhaseId), started)),
        capturePassiveBoundary(withScanTimeout(collectFingerprintObservationsWithCoverage(page.frames()), started))
      ]);
      // Capture-loss details use the registered budget vocabulary
      // (BUDGET_FAMILIES); the phaseId already records WHICH boundary was lost.
      if (passiveCookies.ok) {
        passiveBoundary.cookies = true;
        passiveCookiesForTrustedSubject = passiveCookies.value;
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
        passiveStorageForTrustedSubject = passiveStorage.value;
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
      const passiveFingerprintCoverage = passiveFingerprint.ok
        ? fingerprintFrameCoverageStatus(passiveFingerprint.value)
        : "failed";
      if (passiveFingerprint.ok && passiveFingerprint.value.readableFrames > 0) {
        passiveFingerprintObservations = passiveFingerprint.value.observations;
      }
      if (passiveFingerprint.ok && passiveFingerprintCoverage === "complete") {
        passiveBoundary.fingerprinting = true;
      } else {
        measurementKernel.recordCaptureLoss({
          family: "fingerprinting",
          phaseId: passivePhaseId,
          kind: passiveFingerprint.ok ? "dropped" : passiveFingerprint.kind,
          count: passiveFingerprint.ok
            ? Math.max(1, passiveFingerprint.value.attemptedFrames - passiveFingerprint.value.readableFrames)
            : 1,
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

    const consentProbeState: { failure: ConsentProbeFailure | null } = { failure: null };
    // A choice was requested, the page loaded, and the phase still never began:
    // the only way to reach that is the budget check above. Record it, because
    // the synthesized `clicked: false` below is otherwise indistinguishable from
    // a completed search, and the disclosure would report "no recognizable
    // control was found" - a claim about the SITE - for a banner nothing ever
    // looked at. The detector already records skipped/budget-unavailable.
    if (payload.consentMode !== "observe" && !pageSubjectInvalid && consentPhaseId === null) {
      consentProbeState.failure = "budget-unavailable";
    }
    const consentProbe =
      payload.consentMode === "observe" || pageSubjectInvalid
        ? undefined
        : consentPhaseId === null
          ? {
              summary: { mode: payload.consentMode as ConsentChoice, clicked: false },
              readableFrames: 0
            }
          : await withScanTimeout(
              applyConsentChoice(
                page,
                payload.consentMode,
                started,
                consentShadowRootCapability,
                options.beforeConsentSubframeEvaluationForTests
              ),
              started
            ).catch(
              (error): ConsentChoiceProbeOutcome => {
                consentProbeState.failure = isScanBudgetError(error) ? "budget-unavailable" : "scan-failed";
                return {
                  summary: { mode: payload.consentMode as ConsentChoice, clicked: false },
                  readableFrames: 0
                };
              }
            );
    const consentInteraction = consentProbe?.summary;
    if (consentPhaseId !== null && !sameScanSubjectUrl(page.url(), trustedSubjectUrl)) {
      markConsentInteractionSubjectLoss(consentPhaseId);
    }
    if (consentPhaseId !== null && consentProbeState.failure === null && consentProbe?.readableFrames === 0) {
      // A probe that never started because the budget ran out is not an
      // unreadable page. Both produce zero readable frames, so without the
      // explicit signal the budget case was reported as an engine failure and
      // the budget branch below could never be reached.
      consentProbeState.failure = consentProbe.budgetExhausted ? "budget-unavailable" : "engine-unavailable";
    }
    if (
      consentPhaseId !== null &&
      consentProbeState.failure === null &&
      consentInteraction?.clicked === false &&
      (consentProbe?.dispatchedControls ?? 0) > 0
    ) {
      // A click landed and nothing visibly reacted. The anti-decoy rule is why
      // that is not recorded as a click, but it is also not an empty search:
      // saying results reflect the pre-consent state would be false about a
      // page this visit demonstrably clicked.
      consentProbeState.failure = "dispatch-unconfirmed";
    }
    if (
      consentPhaseId !== null &&
      consentProbeState.failure === null &&
      consentInteraction?.clicked === false &&
      (consentProbe?.unreadableFrames ?? 0) > 0
    ) {
      // Some frame's search never returned a result. Reporting that as "no
      // recognizable control was found" is the exact inversion of what the
      // evidence supports for the most common cause, a control that reloads the
      // page on click: the search was cut short BY the thing it was looking for.
      //
      // But that cause has to be OBSERVED, not assumed. An ad-funded page whose
      // third-party iframes detach mid-probe produces the same unreadable-frame
      // count while the top document never moves, and claiming it did is a
      // false statement about the site made from a failure of the instrument.
      // The top-document navigation counter separates the two.
      consentProbeState.failure =
        (consentProbe?.mainFrameNavigations ?? 0) > 0 ? "search-interrupted" : "frames-unreadable";
    }
    if (consentPhaseId !== null) {
      if (consentInteractionLeftSubject) {
        measurementKernel.setDetector("consent-banner", "partial", {
          reason: "load-failed",
          phaseId: consentPhaseId
        });
        recordConsentCoverageLoss(consentPhaseId, "dropped", verificationEnabled);
      } else if (consentProbeState.failure === "budget-unavailable") {
        measurementKernel.setDetector("consent-banner", "partial", {
          reason: "budget-unavailable",
          phaseId: consentPhaseId
        });
        recordConsentCoverageLoss(consentPhaseId, "cap", verificationEnabled);
      } else if (consentProbeState.failure === "search-interrupted") {
        // Partial, not failed: frames WERE read, the page just stopped standing
        // still. Recording it keeps the run out of comparison eligibility for
        // the reason that actually applies.
        measurementKernel.setDetector("consent-banner", "partial", {
          reason: "load-failed",
          phaseId: consentPhaseId
        });
        recordConsentCoverageLoss(consentPhaseId, "dropped", verificationEnabled);
      } else if (consentProbeState.failure === "frames-unreadable") {
        // Also partial, and for a different reason: nothing failed to LOAD.
        // The probe's own evaluation threw inside one or more frames, so the
        // search did not cover the page it claims to have searched.
        measurementKernel.setDetector("consent-banner", "partial", {
          reason: "scan-failed",
          phaseId: consentPhaseId
        });
        recordConsentCoverageLoss(consentPhaseId, "dropped", verificationEnabled);
      } else if (consentProbeState.failure === "dispatch-unconfirmed") {
        measurementKernel.setDetector("consent-banner", "partial", {
          reason: "scan-failed",
          phaseId: consentPhaseId
        });
        recordConsentCoverageLoss(consentPhaseId, "dropped", verificationEnabled);
      } else if (consentProbeState.failure === "scan-failed") {
        measurementKernel.setDetector("consent-banner", "failed", { reason: "scan-failed", phaseId: consentPhaseId });
        recordConsentCoverageLoss(consentPhaseId, "dropped", verificationEnabled);
      } else if (consentProbeState.failure === "engine-unavailable") {
        measurementKernel.setDetector("consent-banner", "failed", {
          reason: "engine-unavailable",
          phaseId: consentPhaseId
        });
        recordConsentCoverageLoss(consentPhaseId, "dropped", verificationEnabled);
      } else {
        measurementKernel.setDetector("consent-banner", "complete", { phaseId: consentPhaseId });
      }
    } else if (pageSubjectInvalid && payload.consentMode !== "observe") {
      measurementKernel.setDetector("consent-banner", "skipped", { reason: "load-failed" });
      recordConsentCoverageLoss(null, "dropped", verificationEnabled);
    } else if (payload.consentMode !== "observe") {
      measurementKernel.setDetector("consent-banner", "skipped", { reason: "budget-unavailable" });
      recordConsentCoverageLoss(null, "cap", verificationEnabled);
    } else if (verificationFlagOn && !pageSubjectInvalid) {
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
          recordConsentCoverageLoss(passivePhaseId, "dropped", false);
        } else {
          measurementKernel.setDetector("consent-banner", "complete", { phaseId: passivePhaseId });
        }
      } catch (error) {
        throwIfScanAborted(options.signal);
        if (!isScanBudgetError(error)) throw error;
        measurementKernel.setDetector("consent-banner", "skipped", {
          reason: "budget-unavailable",
          phaseId: passivePhaseId
        });
        recordConsentCoverageLoss(passivePhaseId, "cap", false);
      }
    } else if (pageSubjectInvalid) {
      measurementKernel.setDetector("consent-banner", "skipped", { reason: "load-failed" });
      recordConsentCoverageLoss(null, "dropped", false);
    } else {
      // Observe mode without the verification flag performs no banner
      // interaction or detection in v1. Recorded honestly; such runs are not
      // r2 emission candidates until the flag enables the visibility read.
      measurementKernel.setDetector("consent-banner", "skipped", { reason: "probe-disabled" });
    }
    throwIfScanAborted(options.signal);
    if (consentInteraction) {
      warnings.add(consentInteractionWarning(consentInteraction, consentProbeState.failure));
    }
    if (verificationEnabled && consentPhaseId !== null && !consentInteractionLeftSubject) {
      const bannerObservationCheckpoint = bannerObservations.length;
      const consentObservationCheckpoint = consentObservations.length;
      await recordBannerMoment("after-interaction", consentPhaseId);
      await recordConsentStateReadback(consentPhaseId);
      if (!sameScanSubjectUrl(page.url(), trustedSubjectUrl)) {
        // A navigation can race either interpreter read. Neither observation may
        // be attributed to the subject frozen before the interaction.
        bannerObservations.splice(bannerObservationCheckpoint);
        consentObservations.splice(consentObservationCheckpoint);
        markConsentInteractionSubjectLoss(consentPhaseId);
        measurementKernel.setDetector("consent-banner", "partial", {
          reason: "load-failed",
          phaseId: consentPhaseId
        });
      }
    }

    const stateSnapshotPhaseId = consentPhaseId ?? passivePhaseId;
    let subjectStateTrusted =
      !consentInteractionLeftSubject && sameScanSubjectUrl(page.url(), trustedSubjectUrl);
    if (!subjectStateTrusted) {
      if (consentPhaseId !== null) {
        markConsentInteractionSubjectLoss(consentPhaseId);
      } else {
        warnings.add(ACTIVE_PROBE_SUBJECT_WARNING);
        for (const family of ["requests", "cookies", "storage", "fingerprinting"] as const) {
          measurementKernel.recordCaptureLoss({ family, phaseId: passivePhaseId, kind: "dropped", count: 1 });
        }
      }
    }

    let tentativePageTitle = trustedSubjectPageTitle;
    let tentativePageTitleTruncated = trustedSubjectPageTitleRead.truncated;
    let tentativeFinalUrl = trustedSubjectUrl;
    let tentativeCookies: CookieRecord[] = [];
    let tentativeStorage: PassiveBoundaryOutcome<StorageRecord[]> = { ok: false, kind: "dropped" };
    let tentativeFingerprintCollection = {
      observations: { events: [], detections: [] } as FingerprintObservations,
      attemptedFrames: 0,
      readableFrames: 0
    };
    let tentativeScreenshot: string | null = null;
    let tentativePolicyLinks: PolicyLinkCandidate[] = [];
    let tentativePolicyLinksTruncated = false;
    // The link collection FAILED, as opposed to finding nothing. Publishing
    // those two the same way is how an instrument failure became a statement
    // about the site.
    let tentativePolicyLinksFailed = false;

    if (subjectStateTrusted) {
      const titleRead = await withScanTimeout(
        collectBoundedPageTitle(page, boundedPageCollectorKey),
        started
      ).catch((error) => {
        if (isScanBudgetError(error)) throw error;
        return { value: "", truncated: false };
      });
      tentativePageTitle = titleRead.value;
      tentativePageTitleTruncated = titleRead.truncated;
      tentativeCookies = await withScanTimeout(collectCookies(context, trustedSubjectHostname), started);
      tentativeStorage = await capturePassiveBoundary(
        withScanTimeout(collectStorageSnapshot(stateSnapshotPhaseId), started)
      );
      tentativeFingerprintCollection = await withScanTimeout(
        collectFingerprintObservationsWithCoverage(page.frames()),
        started
      );
      tentativeScreenshot = await withScanTimeout(
        page
          .screenshot({ type: "jpeg", quality: 62, fullPage: false })
          .then((buffer) => `data:image/jpeg;base64,${buffer.toString("base64")}`)
          .catch(() => null),
        started
      );
      // A bare catch here made every failure of this read indistinguishable
      // from a page that offers no policy link, and the probe published the
      // second: a claim about the SITE for a failure of the INSTRUMENT. The
      // sibling title read above already rethrows a budget error; this one is
      // the outlier. Other failures are recorded as a failed collection so the
      // detector can say what actually happened.
      const policyLinkCollection = await withScanTimeout(
        collectPrivacyPolicyLinks(page, boundedPageCollectorKey),
        started
      ).catch((error) => {
        if (isScanBudgetError(error)) throw error;
        tentativePolicyLinksFailed = true;
        return { links: [] as PolicyLinkCandidate[], truncated: false };
      });
      tentativePolicyLinks = policyLinkCollection.links;
      tentativePolicyLinksTruncated = policyLinkCollection.truncated;
      tentativeFinalUrl = page.url();

      // Every page-bound read above is tentative. A navigation can race any
      // await; commit the bundle only if the exact origin frozen before the
      // consent interaction is still active after the last read.
      if (!sameScanSubjectUrl(tentativeFinalUrl, trustedSubjectUrl)) {
        subjectStateTrusted = false;
        if (consentPhaseId !== null) {
          markConsentInteractionSubjectLoss(consentPhaseId);
        } else {
          warnings.add(ACTIVE_PROBE_SUBJECT_WARNING);
          for (const family of ["requests", "cookies", "storage", "fingerprinting"] as const) {
            measurementKernel.recordCaptureLoss({ family, phaseId: passivePhaseId, kind: "dropped", count: 1 });
          }
        }
      }
    }

    const pageTitle = subjectStateTrusted ? tentativePageTitle : trustedSubjectPageTitle;
    const pageTitleTruncated = subjectStateTrusted
      ? tentativePageTitleTruncated
      : trustedSubjectPageTitleRead.truncated;
    const finalUrl = subjectStateTrusted ? tentativeFinalUrl : trustedSubjectUrl;
    const finalParsed = safeParseUrl(finalUrl) ?? targetUrl;
    const cookies = subjectStateTrusted ? tentativeCookies : passiveCookiesForTrustedSubject ?? [];
    const finalStorage = subjectStateTrusted
      ? tentativeStorage
      : passiveStorageForTrustedSubject !== null
        ? ({ ok: true, value: passiveStorageForTrustedSubject } as const)
        : ({ ok: false, kind: "dropped" } as const);
    const storage = finalStorage.ok ? finalStorage.value : [];
    const fingerprintCollection = subjectStateTrusted
      ? tentativeFingerprintCollection
      : {
          observations: passiveFingerprintObservations ?? { events: [], detections: [] },
          attemptedFrames: passiveBoundary.fingerprinting ? 1 : 0,
          readableFrames: passiveBoundary.fingerprinting ? 1 : 0
        };
    const fingerprintObservations = fingerprintCollection.observations;
    const fingerprintFrameCoverage = fingerprintFrameCoverageStatus(fingerprintCollection);
    // v2 carries this as a `fingerprinting` capture loss in its quality facts.
    // v1 has no quality block, so without a warning a run whose observer never
    // executed looks exactly like a run that looked and found nothing, and the
    // report publishes an unhedged "No fingerprint-like API calls observed".
    if (fingerprintFrameCoverage !== "complete") {
      warnings.add(FINGERPRINT_OBSERVER_CAPTURE_LOSS_WARNING);
    }
    const fingerprintCoverageIncomplete =
      fingerprintFrameCoverage === "partial" || (consentPhaseId !== null && !passiveBoundary.fingerprinting);
    const canAttributeConsentFingerprinting =
      subjectStateTrusted && (consentPhaseId === null || passiveBoundary.fingerprinting);
    const fingerprintAttribution = subjectStateTrusted
      ? canAttributeConsentFingerprinting
        ? phaseAwareDetections(
            fingerprintObservations.detections,
            passiveFingerprintObservations?.detections ?? null,
            passivePhaseId,
            stateSnapshotPhaseId
          )
        : { detections: [], attributionIncomplete: false }
      : {
          detections: (passiveFingerprintObservations?.detections ?? []).map((detection) => ({
            ...detection,
            phaseId: passivePhaseId
          })),
          attributionIncomplete: false
        };
    if (pageTitleTruncated) {
      measurementKernel.recordCaptureLoss({
        family: "detector-output",
        phaseId: stateSnapshotPhaseId,
        kind: "truncated",
        count: 1,
        detail: "page-title"
      });
    }
    if (fingerprintAttribution.attributionIncomplete) {
      // The observer exposes cumulative heuristic summaries. If a summary
      // changed across a phase boundary but cannot be losslessly differenced,
      // retain the known passive record and censor the unknown later portion
      // instead of assigning the cumulative total to the passive phase.
      measurementKernel.recordCaptureLoss({
        family: "fingerprinting",
        phaseId: stateSnapshotPhaseId,
        kind: "dropped",
        count: 1,
        detail: "fingerprint-observer"
      });
    }
    // Every non-complete coverage, not only "partial". A "failed" observer read
    // zero frames, which is the strongest possible reason to hedge, yet it
    // recorded no capture loss: evaluateQuality builds byFamily strictly from
    // the loss ledger, familyCensoredOnRun consults byFamily first on recorded
    // v2 quality, and the report then published "No fingerprint-like API calls
    // observed" at ok level for a page that defeated the instrument. The v1
    // warning above already covers both states; the r2 facts now agree with it.
    if (subjectStateTrusted && fingerprintFrameCoverage !== "complete") {
      measurementKernel.recordCaptureLoss({
        family: "fingerprinting",
        phaseId: stateSnapshotPhaseId,
        kind: "dropped",
        count: Math.max(1, fingerprintCollection.attemptedFrames - fingerprintCollection.readableFrames),
        detail: "fingerprint-observer"
      });
    }
    if (subjectStateTrusted) {
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
    }
    if (!subjectStateTrusted) {
      measurementKernel.recordCaptureLoss({
        family: "fingerprinting",
        phaseId: stateSnapshotPhaseId,
        kind: "dropped",
        count: 1,
        detail: "fingerprint-observer"
      });
      measurementKernel.setDetector("fingerprint-heuristics", passiveBoundary.fingerprinting ? "partial" : "failed", {
        reason: "load-failed",
        phaseId: stateSnapshotPhaseId
      });
    } else if (fingerprintFrameCoverage === "failed") {
      measurementKernel.setDetector("fingerprint-heuristics", "failed", {
        reason: "engine-unavailable",
        phaseId: stateSnapshotPhaseId
      });
    } else if (fingerprintCoverageIncomplete || fingerprintAttribution.attributionIncomplete) {
      measurementKernel.setDetector("fingerprint-heuristics", "partial", {
        reason: "scan-failed",
        phaseId: stateSnapshotPhaseId
      });
    } else {
      measurementKernel.setDetector("fingerprint-heuristics", "complete", { phaseId: stateSnapshotPhaseId });
    }
    const screenshot = subjectStateTrusted ? tentativeScreenshot : null;
    throwIfScanAborted(options.signal);
    // Warn only for actual private/local-address guard blocks here. Other
    // outcomes must not be mislabeled as private-network targets; upstream
    // forwarding failures receive separate conservative quality accounting
    // after every probe has finished below.
    if (scanProxy.blockedTargets.some((blocked) => blocked.reason === "non-public-address")) {
      warnings.add("Blocked one or more requests that resolved to local or private network addresses at connection time.");
    }

    // Privacy-policy link candidates were part of the tentatively captured
    // trusted-subject bundle above. The keystroke probe may navigate away to
    // flush unload beacons, so the policy page itself is visited later from
    // this frozen list, after the request log has been snapshotted.
    const policyLinks = subjectStateTrusted ? tentativePolicyLinks : [];
    const policyLinksTruncated = subjectStateTrusted && tentativePolicyLinksTruncated;
    const policyLinksFailed = subjectStateTrusted && tentativePolicyLinksFailed;

    // Kernel step 3 (flag-gated): one post-choice reload to read the site's
    // REGISTERED consent state from a fresh document. It runs in its own
    // measurement phase whose traffic is excluded from the v1 request log
    // (recordRequest skips the phase; the warning below discloses it), after
    // the v1 evidence snapshots so the frozen wire is untouched, and before
    // the active-probe phase per the r2 phase-plan ordering. Only a really
    // clicked control has a registration to verify.
    let postConsentReloadLeftSubject = false;
    const markPostConsentReloadSubjectLoss = (phaseId: number) => {
      if (postConsentReloadLeftSubject) return;
      postConsentReloadLeftSubject = true;
      warnings.add(CONSENT_RELOAD_SUBJECT_WARNING);
      measurementKernel.recordCaptureLoss({
        family: "consent-verification",
        phaseId,
        kind: "dropped",
        count: 1
      });
    };
    if (
      verificationEnabled &&
      consentPhaseId !== null &&
      consentInteraction?.clicked === true &&
      subjectStateTrusted
    ) {
      const reloadBudgetAvailable = MAX_SCAN_DURATION_MS - (Date.now() - started) >= CONSENT_RELOAD_MIN_BUDGET_MS;
      if (reloadBudgetAvailable) {
        // The r2 phase order puts this excluded v1 reload between retained
        // consent and active-probe traffic. Bracket it with monotonic quality
        // snapshots so only this interval can be subtracted at the final
        // request-evidence boundary.
        await settleRoutedRequests(inFlightRouteHandlers, started, options.signal);
        beforeExcludedReloadDiagnostics = snapshotScanEvidenceDiagnostics();
        const reloadPhaseId = measurementKernel.beginPhase("post-choice-reload");
        consentReadState.reloadPhaseId = reloadPhaseId;
        warnings.add(CONSENT_RELOAD_DISCLOSURE);
        try {
          await page.goto(page.url(), {
            waitUntil: "domcontentloaded",
            timeout: scanTimeout(started, CONSENT_RELOAD_NAV_TIMEOUT_MS)
          });
          if (!sameScanSubjectUrl(page.url(), trustedSubjectUrl)) {
            markPostConsentReloadSubjectLoss(reloadPhaseId);
          } else {
            const idleBudgetMs = Math.min(
              CONSENT_RELOAD_SETTLE_IDLE_TIMEOUT_MS,
              MAX_SCAN_DURATION_MS - (Date.now() - started) - 500
            );
            if (idleBudgetMs > 250) {
              await page.waitForLoadState("networkidle", { timeout: idleBudgetMs }).catch(() => undefined);
            }
            // A settle-time script can navigate after goto resolved. Check the
            // recorded subject again before accepting any readback or snapshot.
            if (!sameScanSubjectUrl(page.url(), trustedSubjectUrl)) {
              markPostConsentReloadSubjectLoss(reloadPhaseId);
            } else {
              const bannerObservationCheckpoint = bannerObservations.length;
              const consentObservationCheckpoint = consentObservations.length;
              await recordBannerMoment("after-reload", reloadPhaseId);
              await recordConsentStateReadback(reloadPhaseId);
              if (!sameScanSubjectUrl(page.url(), trustedSubjectUrl)) {
                // A navigation racing the interpreter read cannot leave partial
                // testimony attributed to the original subject.
                bannerObservations.splice(bannerObservationCheckpoint);
                consentObservations.splice(consentObservationCheckpoint);
                markPostConsentReloadSubjectLoss(reloadPhaseId);
              } else {
                // Post-reload state snapshots feed only the phase-aware mutation
                // ledgers; the v1 wire's cookies/storage stayed frozen above.
                const reloadCookies = await capturePassiveBoundary(
                  withScanTimeout(collectCookies(context, trustedSubjectHostname), started)
                );
                const reloadStorage = await capturePassiveBoundary(
                  withScanTimeout(collectStorageSnapshot(reloadPhaseId), started)
                );
                if (!sameScanSubjectUrl(page.url(), trustedSubjectUrl)) {
                  // The async snapshots are tentative just like the interpreter
                  // reads above. Discard the entire reload-phase bundle if a
                  // navigation raced either collection.
                  bannerObservations.splice(bannerObservationCheckpoint);
                  consentObservations.splice(consentObservationCheckpoint);
                  measurementKernel.recordCaptureLoss({
                    family: "cookies",
                    phaseId: reloadPhaseId,
                    kind: "dropped",
                    count: 1,
                    detail: "cookie-snapshot"
                  });
                  measurementKernel.recordCaptureLoss({
                    family: "storage",
                    phaseId: reloadPhaseId,
                    kind: "dropped",
                    count: 1,
                    detail: "storage-snapshot"
                  });
                  markPostConsentReloadSubjectLoss(reloadPhaseId);
                } else {
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
                }
              }
            }
          }
        } catch {
          throwIfScanAborted(options.signal);
          if (!sameScanSubjectUrl(page.url(), trustedSubjectUrl)) {
            for (let index = bannerObservations.length - 1; index >= 0; index -= 1) {
              if (bannerObservations[index].phaseId === reloadPhaseId) bannerObservations.splice(index, 1);
            }
            for (let index = consentObservations.length - 1; index >= 0; index -= 1) {
              if (consentObservations[index].phaseId === reloadPhaseId) consentObservations.splice(index, 1);
            }
            markPostConsentReloadSubjectLoss(reloadPhaseId);
          }
          // Best-effort verification: a failed reload leaves the round-one
          // observations standing and the scan continues on the reloaded (or
          // original) document.
        }
        await settleRoutedRequests(inFlightRouteHandlers, started, options.signal);
        afterExcludedReloadDiagnostics = snapshotScanEvidenceDiagnostics();
      }
    }

    // Active input-capture probe: type a synthetic sentinel into form fields and
    // watch for it leaving to a third party. Best-effort and fully bounded, it
    // never throws into the scan and is skipped when the time budget is tight.
    const trustedRequestIdsBeforeActiveProbe = subjectStateTrusted
      ? new Set(networkRecorder.publicRecords(trustedSubjectHostname).map((record) => record.id))
      : trustedSubjectRequestIds;
    const activeProbeSubjectAvailable =
      !pageSubjectInvalid &&
      subjectStateTrusted &&
      !consentInteractionLeftSubject &&
      !postConsentReloadLeftSubject &&
      sameScanSubjectUrl(page.url(), trustedSubjectUrl);
    if (
      !pageSubjectInvalid &&
      subjectStateTrusted &&
      !consentInteractionLeftSubject &&
      !postConsentReloadLeftSubject &&
      !activeProbeSubjectAvailable
    ) {
      warnings.add(ACTIVE_PROBE_SUBJECT_WARNING);
    }
    const keystrokeBudgetAvailable =
      activeProbeSubjectAvailable &&
      MAX_SCAN_DURATION_MS - (Date.now() - started) >= KEYSTROKE_PROBE_MIN_BUDGET_MS;
    const keystrokePhaseId = keystrokeBudgetAvailable ? measurementKernel.beginPhase("active-probe") : null;
    let keystrokeProbe: KeystrokeProbeOutcome | null = null;
    const keystrokeProbeLifecycle: KeystrokeProbeLifecycle = {
      cancelled: false,
      typedFieldCount: 0,
      stopCapture: () => undefined
    };
    if (keystrokePhaseId !== null) {
      try {
        keystrokeProbe = await withScanTimeout(
          probeKeystrokeExfiltration(
            page,
            trustedSubjectUrl,
            trustedSubjectHostname,
            started,
            warnings,
            boundedPageCollectorKey,
            keystrokeProbeLifecycle
          ),
          started
        );
      } catch (error) {
        // Promise timeouts do not cancel the still-running Playwright work.
        // Retire its request listener immediately and freeze the disclosure
        // state before report warnings/evidence are constructed.
        keystrokeProbeLifecycle.cancelled = true;
        keystrokeProbeLifecycle.stopCapture();
        if (keystrokeProbeLifecycle.typedFieldCount > 0) {
          addKeystrokeProbeDisclosure(warnings, keystrokeProbeLifecycle.typedFieldCount);
        }
        // The timed-out promise can still emit network activity after the
        // report snapshot, even though its probe listener is detached above.
        // Never claim those requests or counts are complete.
        warnings.add(KEYSTROKE_PROBE_INCOMPLETE_WARNING);
        const timedOut = isScanBudgetError(error);
        measurementKernel.recordCaptureLoss(
          incompleteKeystrokeProbeRequestLoss(keystrokePhaseId, timedOut ? "timeout" : "dropped")
        );
        keystrokeProbe = timedOut
          ? { status: "partial", reason: "budget-unavailable", detection: null }
          : { status: "failed", reason: "scan-failed", detection: null };
      }
    }
    const activeProbeSubjectLost =
      keystrokeProbe !== null && "subjectLost" in keystrokeProbe && keystrokeProbe.subjectLost === true;
    if (activeProbeSubjectLost) {
      warnings.add(ACTIVE_PROBE_SUBJECT_WARNING);
      measurementKernel.recordCaptureLoss({
        family: "requests",
        phaseId: keystrokePhaseId,
        kind: "dropped",
        count: 1
      });
      measurementKernel.recordCaptureLoss({
        family: "fingerprinting",
        phaseId: keystrokePhaseId,
        kind: "dropped",
        count: 1
      });
    }
    const keystrokeDetection = keystrokeProbe?.detection ?? null;
    const keystrokeCaptureLossCount =
      keystrokeProbe && "captureLossCount" in keystrokeProbe
        ? keystrokeProbe.captureLossCount ?? 0
        : 0;
    if (keystrokePhaseId !== null && keystrokeCaptureLossCount > 0) {
      measurementKernel.recordCaptureLoss({
        family: "detector-output",
        phaseId: keystrokePhaseId,
        kind: "truncated",
        count: keystrokeCaptureLossCount,
        detail: "keystroke-probe-capture"
      });
    }
    // Quality is derived from capture loss, not from detector status (the same
    // rule the CNAME probe follows below), so a keystroke probe that did not
    // run or did not finish must censor its family too. Without this the run
    // publishes detector-output "complete" and the board's loudest absence
    // card, "no synthetic input left this page", over a probe that never typed.
    const recordKeystrokeCaptureLoss = (kind: "cap" | "dropped"): void => {
      measurementKernel.recordCaptureLoss({
        family: "detector-output",
        phaseId: keystrokePhaseId,
        kind,
        count: 1,
        detail: "keystroke-probe"
      });
    };
    if (keystrokePhaseId === null) {
      measurementKernel.setDetector("keystroke-exfiltration", "skipped", {
        reason: activeProbeSubjectAvailable ? "budget-unavailable" : "load-failed"
      });
      recordKeystrokeCaptureLoss(activeProbeSubjectAvailable ? "cap" : "dropped");
    } else if (keystrokeProbe?.status === "skipped") {
      measurementKernel.setDetector("keystroke-exfiltration", "skipped", {
        reason: keystrokeProbe.reason,
        phaseId: keystrokePhaseId
      });
      // Every skip the probe itself reports is a lost subject, not a budget.
      recordKeystrokeCaptureLoss("dropped");
    } else if (keystrokeProbe?.status === "partial") {
      measurementKernel.setDetector("keystroke-exfiltration", "partial", {
        reason: keystrokeProbe.reason,
        phaseId: keystrokePhaseId
      });
      // The probe's own truncation counter is recorded above; a partial
      // synthesized by the deadline or a thrown probe carries no count.
      if (
        keystrokeCaptureLossCount === 0 ||
        keystrokeProbe.reason !== "evidence-cap-reached"
      ) {
        recordKeystrokeCaptureLoss("dropped");
      }
    } else if (keystrokeProbe?.status === "failed") {
      measurementKernel.setDetector("keystroke-exfiltration", "failed", {
        reason: keystrokeProbe.reason,
        phaseId: keystrokePhaseId
      });
      recordKeystrokeCaptureLoss("dropped");
    } else {
      measurementKernel.setDetector("keystroke-exfiltration", "complete", { phaseId: keystrokePhaseId });
    }
    const fingerprintDetections = keystrokeDetection
      ? [...fingerprintObservations.detections, keystrokeDetection]
      : fingerprintObservations.detections;

    // Decode pixel-level events from the raw (pre-redaction) request and POST
    // body while it is still available here; the public record's URL is scrubbed.
    // Event names are kept; an identifier category is recorded only when its
    // recognized key has a non-empty value. Identifier values are never retained.
    const pixelEventInputs: PixelEventInput[] = [];
    const pixelEventInputsByPhase = new Map<number, PixelEventInput[]>();
    const pixelBodyCaptureLosses = new Map<
      string,
      { phaseId: number; kind: "truncated" | "dropped"; count: number }
    >();
    let pixelBodyReadFailed = false;
    const cnameRequestTypeByRecordId = new Map<number, string>();
    const phaseAwareRequests: Array<NetworkRequestRecord & { phaseId: number }> = [];
    let gpcNavigationRetained = false;
    // The last boundary before evidence is read. Everything after it degrades
    // gracefully on its own budget, so rejecting here threw away a completed
    // measurement; record the loss and publish what was measured instead.
    await settleRoutedRequests(inFlightRouteHandlers, started, options.signal, () => {
      warnings.add(UNSETTLED_ROUTED_REQUEST_WARNING);
      measurementKernel.recordCaptureLoss({
        family: "requests",
        phaseId: null,
        kind: "dropped",
        count: inFlightRouteHandlers.size
      });
    });
    const allPublicRequests = networkRecorder.publicRecords(trustedSubjectHostname, (record, request) => {
      const phaseId = measurementKernel.phaseForRequest(request) ?? passivePhaseId;
      const retainAtTrustedBoundary =
        subjectStateTrusted && activeProbeSubjectAvailable && !activeProbeSubjectLost
          ? true
          : trustedRequestIdsBeforeActiveProbe.has(record.id);
      if (
        retainAtTrustedBoundary &&
        request === pendingGpcReadback.request &&
        phaseId === passivePhaseId &&
        record.resourceType === "document" &&
        !record.thirdParty
      ) {
        gpcNavigationRetained = true;
      }
      if (retainAtTrustedBoundary) {
        cnameRequestTypeByRecordId.set(
          record.id,
          cnameRequestTypes.get(request) ?? mapRequestType(record.resourceType)
        );
      }
      if (retainAtTrustedBoundary && record.thirdParty) {
        const url = request.url();
        const body = safeRequestPostDataWithCoverage(request);
        const input = { url, method: record.method, postData: body.value };
        pixelEventInputs.push(input);
        const phaseInputs = pixelEventInputsByPhase.get(phaseId) ?? [];
        phaseInputs.push(input);
        pixelEventInputsByPhase.set(phaseId, phaseInputs);
        if (
          record.method.toUpperCase() !== "GET" &&
          record.method.toUpperCase() !== "HEAD" &&
          (body.truncated || body.unreadable) &&
          decodePixelRequest({ url, method: record.method, postData: null }) !== null
        ) {
          const kind = body.truncated ? "truncated" : "dropped";
          const key = `${phaseId}:${kind}`;
          const previous = pixelBodyCaptureLosses.get(key);
          pixelBodyCaptureLosses.set(key, {
            phaseId,
            kind,
            count: Math.min(Number.MAX_SAFE_INTEGER, (previous?.count ?? 0) + 1)
          });
          if (body.unreadable) pixelBodyReadFailed = true;
        }
      }
      const decorated = {
        ...record,
        // Reuse the exact route-time decision. Re-evaluating here against the
        // final top-level URL misclassifies iframe and redirected-document
        // requests and can disagree with what the blocking arm actually did.
        blockedByShields: adblockEngine ? shieldsMatches.get(request) : undefined
      };
      if (retainAtTrustedBoundary) phaseAwareRequests.push({ ...decorated, phaseId });
      return decorated;
    });
    const publicRequests = subjectStateTrusted && activeProbeSubjectAvailable && !activeProbeSubjectLost
      ? allPublicRequests
      : allPublicRequests.filter((record) => trustedRequestIdsBeforeActiveProbe.has(record.id));
    const frozenShieldsFacts = freezePassiveShieldsFacts({
      boundaryCounters: trustedSubjectShieldsFacts,
      retainedRequests: phaseAwareRequests,
      passivePhaseId,
      boundaryRequestIds: trustedSubjectRequestIds,
      blockingEnabled: options.shieldsBlockingEnabled === true
    });
    // This is the existing v1 request-log snapshot boundary. Requests from the
    // later policy visit are intentionally excluded, and no late main-page
    // event should stretch the active phase after its evidence was frozen.
    // Both listeners retire together: a late response cannot corrupt the frozen
    // snapshot (publicRecords already mapped to fresh objects), but leaving one
    // attached keeps its closure alive on the page and rescans up to a thousand
    // records per straggler for the rest of the context's life.
    page.off("request", recordRequest);
    page.off("response", recordResponse);
    measurementKernel.endPhase();
    // Freeze every request-quality producer at the same boundary as retained
    // request evidence. The bracketed post-choice reload delta is excluded,
    // while later active-probe changes remain retained; the policy visit below
    // occurs after this immutable snapshot and cannot contaminate it.
    const finalEvidenceDiagnostics = snapshotScanEvidenceDiagnostics();
    const evidenceDiagnostics = retainedScanEvidenceDiagnostics(
      finalEvidenceDiagnostics,
      beforeExcludedReloadDiagnostics && afterExcludedReloadDiagnostics
        ? { before: beforeExcludedReloadDiagnostics, after: afterExcludedReloadDiagnostics }
        : undefined
    );
    const pixelEvents = summarizePixelEvents(pixelEventInputs);
    const phaseAwarePixelEvents = [...pixelEventInputsByPhase.entries()].flatMap(([phaseId, inputs]) =>
      summarizePixelEvents(inputs).map((event) => ({ ...event, phaseId }))
    );
    for (const loss of pixelBodyCaptureLosses.values()) {
      measurementKernel.recordCaptureLoss({
        family: "detector-output",
        phaseId: loss.phaseId,
        kind: loss.kind,
        count: loss.count,
        detail: "pixel-decode"
      });
    }
    if (pixelBodyCaptureLosses.size > 0) {
      warnings.add(PIXEL_DECODE_CAPTURE_LOSS_WARNING);
      measurementKernel.setDetector("pixel-events", "partial", {
        reason: pixelBodyReadFailed ? "scan-failed" : "evidence-cap-reached",
        phaseId: stateSnapshotPhaseId
      });
    } else {
      measurementKernel.setDetector("pixel-events", "complete", { phaseId: stateSnapshotPhaseId });
    }

    // Un-hide CNAME-cloaked trackers: first-party subdomains that are DNS aliases
    // for a known tracker. The oracle is the curated catalog (named) first, then
    // the broader Brave Shields engine (which carries the CNAME-cloak vendors the
    // small catalog lacks). Best-effort and bounded, DNS can never stall the scan.
    // Probe the engine with the request types this host was actually seen
    // carrying, not a single hardcoded "other". Cloaked vendors are commonly
    // listed with a type option ($script, $xmlhttprequest, $image), and a rule
    // carrying one can never match a probe typed "other", so the oracle
    // silently missed exactly the vendors it exists to un-hide.
    const observedRequestTypesByHost = new Map<string, Set<string>>();
    for (const record of publicRequests) {
      let host: string;
      try {
        host = new URL(record.url).hostname.toLowerCase();
      } catch {
        continue;
      }
      const types = observedRequestTypesByHost.get(host) ?? new Set<string>();
      types.add(cnameRequestTypeByRecordId.get(record.id) ?? mapRequestType(record.resourceType));
      observedRequestTypesByHost.set(host, types);
    }
    const matchCnameTracker = (host: string): TrackerMatch | null => {
      const named = findTrackerMatch(host);
      if (named) return isTrackingTrackerMatch(named) ? named : null;
      if (adblockEngine) {
        const observed = observedRequestTypesByHost.get(host.toLowerCase());
        const probeTypes = observed && observed.size > 0 ? [...observed] : [mapRequestType("other")];
        for (const requestType of probeTypes) {
          if (adblockEngine.check(`https://${host}/`, finalUrl, requestType)) {
            const registrable = partyKey(host);
            return {
              domain: registrable,
              entity: registrable,
              category: "tracking (Brave Shields list)",
              confidence: "shields-list"
            };
          }
        }
      }
      return null;
    };
    const cnameBudgetAvailable = MAX_SCAN_DURATION_MS - (Date.now() - started) >= CNAME_PROBE_MIN_BUDGET_MS;
    let cnameProbeFailed = false;
    const cnameResolution: CnameCloakResolution = cnameBudgetAvailable
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
          return { cloaks: [], omittedCandidateCount: 0 };
        })
      : { cloaks: [], omittedCandidateCount: 0 };
    const cnameCloaks = cnameResolution.cloaks;
    if (cnameResolution.omittedCandidateCount > 0) {
      measurementKernel.recordCaptureLoss({
        family: "detector-output",
        phaseId: stateSnapshotPhaseId,
        kind: "cap",
        count: cnameResolution.omittedCandidateCount,
        detail: "cname-lookups"
      });
    }
    if (!cnameBudgetAvailable) {
      measurementKernel.setDetector("cname-uncloaking", "skipped", {
        reason: "budget-unavailable",
        phaseId: stateSnapshotPhaseId
      });
      // Quality is derived from capture loss, not from detector status, so a
      // detector that did not run must censor its evidence family too or the
      // run publishes "complete" over evidence nobody collected.
      measurementKernel.recordCaptureLoss({
        family: "detector-output",
        phaseId: stateSnapshotPhaseId,
        kind: "cap",
        count: 1,
        detail: "cname-lookups"
      });
    } else if (cnameProbeFailed) {
      measurementKernel.setDetector("cname-uncloaking", "failed", {
        reason: "scan-failed",
        phaseId: stateSnapshotPhaseId
      });
      measurementKernel.recordCaptureLoss({
        family: "detector-output",
        phaseId: stateSnapshotPhaseId,
        kind: "dropped",
        count: 1,
        detail: "cname-lookups"
      });
    } else if (cnameResolution.omittedCandidateCount > 0) {
      measurementKernel.setDetector("cname-uncloaking", "partial", {
        reason: "evidence-cap-reached",
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
    // Skipped when the page subject is an HTTP error or suspected soft block:
    // is not the site, and its only policy link is typically the interstitial
    // vendor's own policy (e.g. Cloudflare's), which must not be attributed to
    // the scanned site.
    const policyCandidate = pageSubjectInvalid ? null : pickPrivacyPolicyLink(policyLinks, finalParsed.hostname);
    const policyBudgetAvailable = MAX_SCAN_DURATION_MS - (Date.now() - started) >= PRIVACY_POLICY_MIN_BUDGET_MS;
    const policyPhaseId = policyCandidate && policyBudgetAvailable ? measurementKernel.beginPhase("policy-analysis") : null;
    if (policyLinksTruncated && !pageSubjectInvalid) {
      measurementKernel.recordCaptureLoss({
        family: "detector-output",
        phaseId: policyPhaseId,
        kind: "truncated",
        count: 1,
        detail: "policy-link-candidates"
      });
    }
    // Same rule as the keystroke and CNAME probes: a policy visit the scanner
    // could not make or could not finish censors its family instead of leaving
    // the run's detector-output quality "complete". The two paths that are NOT
    // capture loss stay silent: "unsupported" (the page offers no policy link,
    // an observed property of the subject) and a failed load, where the probe
    // is withheld deliberately because an interstitial's policy is not the
    // site's.
    const recordPolicyCaptureLoss = (kind: "cap" | "dropped", phaseId: number | null): void => {
      measurementKernel.recordCaptureLoss({
        family: "detector-output",
        phaseId,
        kind,
        count: 1,
        detail: "policy-visit"
      });
    };
    let privacyPolicy: PrivacyPolicySummary | null = null;
    if (policyPhaseId !== null) {
      try {
        privacyPolicy = await probePrivacyPolicy({
          context,
          boundedPageCollectorKey,
          links: policyLinks,
          firstPartyHostname: finalParsed.hostname,
          requests: publicRequests,
          started,
          verifyPublicUrl,
          warnings
        });
        // The probe found a policy, fetched it, and cross-checked its text, so
        // the detector's own work finished. A truncated candidate list means
        // the SEARCH that fed it was incomplete, which is already recorded as
        // a `policy-link-candidates` capture loss and already censors this
        // family for absence claims.
        //
        // Reporting that as `partial` forced a reason from a closed vocabulary
        // that has no code for it, and the one chosen said the scan ran out of
        // budget. On a five-second scan of a small site that is simply false,
        // and it was the reported cause on most real pages. Say what happened
        // once, in the ledger that can express it.
        //
        // "Complete" requires evidence. The probe returns null when the policy
        // page did not serve, when it served an error body, or when its text is
        // too short to be a policy, and reporting complete over that told
        // readers the cross-check had run when nothing was ever checked.
        if (privacyPolicy === null) {
          measurementKernel.setDetector("privacy-policy", "failed", {
            reason: "load-failed",
            phaseId: policyPhaseId
          });
          recordPolicyCaptureLoss("dropped", policyPhaseId);
        } else {
          measurementKernel.setDetector("privacy-policy", "complete", { phaseId: policyPhaseId });
        }
      } catch {
        measurementKernel.setDetector("privacy-policy", "failed", { reason: "load-failed", phaseId: policyPhaseId });
        recordPolicyCaptureLoss("dropped", policyPhaseId);
      }
    } else if (!subjectStateTrusted || consentInteractionLeftSubject) {
      measurementKernel.setDetector("privacy-policy", "skipped", { reason: "load-failed" });
      recordPolicyCaptureLoss("dropped", policyPhaseId);
    } else if (httpLoadFailed || suspectedChallengeOrSoftBlock) {
      // A challenge/error page's policy link is the interstitial vendor's, not
      // the site's; the probe is deliberately withheld on failed loads.
      //
      // This MUST precede the truncation branch below. A fat vendor error page
      // trips the candidate cap like any other page, and checking truncation
      // first published a budget failure and a capture loss for a visit the
      // contract says stays silent.
      measurementKernel.setDetector("privacy-policy", "skipped", { reason: "load-failed" });
    } else if (pageSubjectUnverified) {
      // Unlike an HTTP error or classified interstitial, an unavailable
      // subject-classification read does not prove that a policy visit would
      // be misattributed. Account for the withheld probe explicitly.
      measurementKernel.setDetector("privacy-policy", "skipped", { reason: "load-failed" });
      recordPolicyCaptureLoss("dropped", policyPhaseId);
    } else if (policyLinksFailed) {
      // The collection itself failed. Not a budget, and not an absence.
      measurementKernel.setDetector("privacy-policy", "failed", { reason: "scan-failed", ...(policyPhaseId === null ? {} : { phaseId: policyPhaseId }) });
      recordPolicyCaptureLoss("dropped", policyPhaseId);
    } else if (policyCandidate && !policyBudgetAvailable) {
      measurementKernel.setDetector("privacy-policy", "skipped", { reason: "budget-unavailable" });
      recordPolicyCaptureLoss("cap", policyPhaseId);
    } else if (policyLinksTruncated) {
      measurementKernel.setDetector("privacy-policy", "skipped", { reason: "evidence-cap-reached" });
    } else {
      // The probe is configured on, but the page offers no discoverable policy
      // link: the subject does not support this probe. "unsupported" (not
      // "probe-disabled") keeps the outcome accountable under the r2 builder's
      // declared-probe rule.
      measurementKernel.setDetector("privacy-policy", "unsupported", { reason: "unsupported" });
    }
    throwIfScanAborted(options.signal);

    const proxyDiagnostics = evidenceDiagnostics.proxy;
    const gpcWorkerCaptureLoss = evidenceDiagnostics.gpcWorker?.diagnostics.captureLossCount ?? 0;
    if (gpcWorkerCaptureLoss > 0) {
      warnings.add(GPC_WORKER_CAPTURE_LOSS_WARNING);
      measurementKernel.recordCaptureLoss({
        family: "requests",
        phaseId: null,
        kind: "dropped",
        count: gpcWorkerCaptureLoss
      });
    }
    if (proxyDiagnostics.invalidUpstreamResponseCount > 0) {
      warnings.add(INVALID_UPSTREAM_RESPONSE_WARNING);
      measurementKernel.recordCaptureLoss({
        family: "requests",
        phaseId: null,
        kind: "dropped",
        count: proxyDiagnostics.invalidUpstreamResponseCount
      });
    }
    const trafficBudget = proxyDiagnostics.trafficBudget;
    if (trafficBudget.captureLoss) {
      warnings.add(PROXY_TRAFFIC_BUDGET_WARNING);
    }
    const responseByteBudget = proxyDiagnostics.responseByteBudget;
    if (responseByteBudget.captureLoss) {
      warnings.add(aggregateByteBudgetWarning("response", responseByteBudget.limitBytes));
    }
    const uploadByteBudget = proxyDiagnostics.uploadByteBudget;
    if (uploadByteBudget.captureLoss) {
      warnings.add(aggregateByteBudgetWarning("upload", uploadByteBudget.limitBytes));
    }

    const requestCapture = evidenceDiagnostics.requestCapture;
    const captureLossByBudget = new Map<string, { family: "requests"; count: number }>();
    const addBudgetLoss = (name: string, family: "requests", count: number) => {
      const existing = captureLossByBudget.get(name);
      captureLossByBudget.set(name, { family, count: (existing?.count ?? 0) + count });
    };
    if (requestCapture.captureLoss) {
      networkRecorder.requestBudget.emitCaptureLossWarning();
      addBudgetLoss(requestCapture.name, requestCapture.family, requestCapture.captureLossCount);
    }
    if (trafficBudget.captureLoss) {
      addBudgetLoss(trafficBudget.name, trafficBudget.family, trafficBudget.captureLoss.count);
    }
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
      // Frozen r2 calls this fact `botWallTitleMatched`; the current producer
      // sets it from the stricter multi-signal subject-validity classifier.
      botWallTitleMatched: suspectedChallengeOrSoftBlock,
      navigationSettled
    });
    const finishedMeasurement = measurementKernel.finish();
    const phaseAwareFingerprintDetections = fingerprintAttribution.detections;
    if (keystrokeDetection && keystrokePhaseId !== null) {
      phaseAwareFingerprintDetections.push({ ...keystrokeDetection, phaseId: keystrokePhaseId });
    }
    const measurement: NodeScanMeasurement = {
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
        fingerprintEvents: subjectStateTrusted
          ? canAttributeConsentFingerprinting
            ? phaseAwareFingerprintEvents(
                fingerprintObservations.events,
                passiveFingerprintObservations?.events ?? null,
                passivePhaseId,
                stateSnapshotPhaseId
              )
            : []
          : (passiveFingerprintObservations?.events ?? []).map((event) => ({
              ...event,
              phaseId: passivePhaseId
            })),
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
    return createNodeScanMeasurementEnvelope(v1Result, measurement);
  } finally {
    options.signal?.removeEventListener("abort", closeOnAbort);
    const contextToClose = context;
    await runScannerCleanupWithinDeadline([
      ...(contextToClose
        ? [{ label: "Chromium context cleanup", run: () => contextToClose.close() }]
        : []),
      { label: "scan proxy cleanup", run: () => scanProxy.close() }
    ]);
  }
}

export function phaseAwareFingerprintEvents(
  finalEvents: FingerprintEventSummary[],
  passiveEvents: FingerprintEventSummary[] | null,
  passivePhaseId: number,
  finalPhaseId: number
): Array<FingerprintEventSummary & { phaseId: number }> {
  if (!passiveEvents || passivePhaseId === finalPhaseId) {
    return finalEvents.map((event) => ({ ...event, phaseId: finalPhaseId }));
  }

  const passiveByApi = new Map(passiveEvents.map((event) => [event.api, event]));
  const attributed = finalEvents.flatMap((event) => {
    const passiveCount = Math.min(event.count, passiveByApi.get(event.api)?.count ?? 0);
    const laterCount = event.count - passiveCount;
    return [
      ...(passiveCount > 0 ? [{ ...event, count: passiveCount, phaseId: passivePhaseId }] : []),
      ...(laterCount > 0 ? [{ ...event, count: laterCount, phaseId: finalPhaseId }] : [])
    ];
  });
  // The observer's counters are cumulative, so the final read normally covers
  // every API the passive read saw. It does not when a frame stops being
  // readable before the end of the visit (a navigation or a removed iframe):
  // iterating only finalEvents then silently discarded a call the scanner had
  // already recorded, turning observed evidence into an absence. Keep the
  // passive observation on its own phase.
  const seen = new Set(finalEvents.map((event) => event.api));
  for (const event of passiveEvents) {
    if (seen.has(event.api) || event.count <= 0) continue;
    attributed.push({ ...event, phaseId: passivePhaseId });
  }
  return attributed;
}

export function phaseAwareDetections(
  finalDetections: FingerprintDetectionSummary[],
  passiveDetections: FingerprintDetectionSummary[] | null,
  passivePhaseId: number,
  finalPhaseId: number
): {
  detections: Array<FingerprintDetectionSummary & { phaseId: number }>;
  attributionIncomplete: boolean;
} {
  if (!passiveDetections || passivePhaseId === finalPhaseId) {
    return {
      detections: finalDetections.map((detection) => ({ ...detection, phaseId: finalPhaseId })),
      attributionIncomplete: false
    };
  }

  const keyOf = (detection: FingerprintDetectionSummary) => `${detection.kind}\u0000${detection.heuristic}`;
  const passiveByKey = new Map(passiveDetections.map((detection) => [keyOf(detection), detection]));
  const finalKeys = new Set<string>();
  const detections: Array<FingerprintDetectionSummary & { phaseId: number }> = [];
  let attributionIncomplete = false;

  for (const detection of finalDetections) {
    const key = keyOf(detection);
    finalKeys.add(key);
    const passive = passiveByKey.get(key);
    if (!passive) {
      detections.push({ ...detection, phaseId: finalPhaseId });
      continue;
    }

    // The passive snapshot is phase-pure. When the cumulative final record is
    // identical, nothing new happened. When it changed, the schema cannot
    // express a lossless per-phase delta for maxima/set-valued evidence, so
    // retain only the known passive fact and report capture loss for the rest.
    detections.push({ ...passive, phaseId: passivePhaseId });
    if (!isDeepStrictEqual(detection, passive)) attributionIncomplete = true;
  }

  for (const passive of passiveDetections) {
    if (finalKeys.has(keyOf(passive))) continue;
    detections.push({ ...passive, phaseId: passivePhaseId });
    attributionIncomplete = true;
  }

  return { detections, attributionIncomplete };
}

export function sameScanSubjectUrl(url: string, recordedUrl: string): boolean {
  const parsed = safeParseUrl(url);
  const recorded = safeParseUrl(recordedUrl);
  return (
    parsed !== null &&
    recorded !== null &&
    (parsed.protocol === "http:" || parsed.protocol === "https:") &&
    (recorded.protocol === "http:" || recorded.protocol === "https:") &&
    parsed.origin === recorded.origin
  );
}

function throwIfScanAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw scanAbortError(signal);
}

/**
 * Wait for every routed request handler to finish before evidence is read.
 *
 * `onDeadline` makes the wait degradable. At the FINAL evidence boundary a
 * handler still in flight when the deadline lands used to reject the whole
 * visit, so one slow route discarded a measurement that had already completed
 * every phase. Recording the loss and publishing what was measured is the
 * better answer there; every earlier boundary still fails closed, because
 * continuing past one would attribute a phase's requests to the wrong phase.
 *
 * Cancellation always throws: a caller that went away is not owed a report.
 */
async function settleRoutedRequests(
  inFlight: ReadonlySet<Promise<void>>,
  started: number,
  signal?: AbortSignal,
  onDeadline?: () => void
): Promise<void> {
  while (inFlight.size > 0) {
    throwIfScanAborted(signal);
    try {
      await withScanTimeout(Promise.allSettled([...inFlight]), started);
    } catch (error) {
      throwIfScanAborted(signal);
      if (!onDeadline || !isScanBudgetError(error)) throw error;
      onDeadline();
      return;
    }
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
      try {
        await hostCheck;
        publicHostCheckFailures.get(publicHostChecks)?.delete(hostCheckKey);
      } catch (error) {
        // A transient DNS failure must not poison every later request to this
        // host for the rest of the visit. Retry once, while keeping a repeated
        // rejection cached so one dead host cannot trigger up to the full route
        // budget in DNS work. Only the owner of the exact rejected promise may
        // update this state; concurrent waiters share its result.
        if (publicHostChecks.get(hostCheckKey) === hostCheck) {
          let failures = publicHostCheckFailures.get(publicHostChecks);
          if (!failures) {
            failures = new Map();
            publicHostCheckFailures.set(publicHostChecks, failures);
          }
          const attempts = (failures.get(hostCheckKey) ?? 0) + 1;
          failures.set(hostCheckKey, attempts);
          if (attempts < MAX_PUBLIC_HOST_CHECK_ATTEMPTS) {
            publicHostChecks.delete(hostCheckKey);
          }
        }
        throw error;
      }
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
          mapRequestType(request.resourceType(), { subFrame: requestIsSubFrameNavigation(request) }),
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

/**
 * A navigation into a nested browsing context, which adblock-rust types as
 * `subdocument` rather than `document`. Playwright uses the same
 * `document` resource type for both, so the frame's parent is the only
 * available discriminator. Unknown frame topology falls back to the top-level
 * type, matching the previous behavior rather than guessing.
 */
function requestIsSubFrameNavigation(request: RoutedRequestLike): boolean {
  if (request.resourceType() !== "document") return false;
  const frame = safeRequestFrame(request);
  return frame !== null && safeParentFrame(frame) !== null;
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
  browserLaunchPromise ??= withScannerOperationDeadline<Browser>(
    () => chromium.launch({
        headless: true,
        args: [...SCAN_CHROMIUM_LAUNCH_ARGS],
        chromiumSandbox: chromiumSandboxEnabled(),
        env: browserProcessEnvironment()
      }),
    {
      label: "Chromium launch",
      timeoutMs: SCANNER_OPERATION_TIMEOUT_MS,
      createTimeoutError: () =>
        new PublicScanError("The browser runtime could not start in time. Try again shortly.", 503),
      // Playwright launch does not expose an AbortSignal. If it eventually
      // materializes after losing the deadline race, close it immediately so
      // a timed-out launch cannot leak a browser process.
      onLateSuccess: (browser) => browser.close()
    }
  )
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
  if (browser) {
    await runScannerCleanupWithinDeadline([
      { label: "shared Chromium test cleanup", run: () => browser.close() }
    ]);
  }
}

export function createContextOptions(payload: ScanRequestPayload, proxyServer: string): BrowserContextOptions {
  const shared = {
    colorScheme: SCAN_COLOR_SCHEME,
    locale: SCAN_LOCALE,
    proxy: { server: proxyServer, bypass: "<-loopback>" },
    // Fresh scan contexts do not need persisted workers. Blocking registration
    // closes Playwright's documented route-visibility gap and keeps every
    // network path inside the page route plus connect-time proxy controls.
    serviceWorkers: "block" as const,
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
async function applyConsentChoice(
  page: Page,
  choice: ConsentChoice,
  started: number,
  shadowRootCapability: string,
  beforeSubframeEvaluationForTests?: (frame: Frame) => Promise<void>
): Promise<ConsentChoiceProbeOutcome> {
  const summary: ConsentInteractionSummary = { mode: choice, clicked: false };
  let readableFrames = 0;
  let unreadableFrames = 0;
  let dispatchedControls = 0;
  let mainFrameNavigations = 0;
  if (MAX_SCAN_DURATION_MS - (Date.now() - started) < CONSENT_CLICK_MIN_BUDGET_MS) {
    return { summary, readableFrames, unreadableFrames, dispatchedControls, mainFrameNavigations, budgetExhausted: true };
  }

  const onFrameNavigated = (frame: Frame) => {
    if (frame === page.mainFrame()) mainFrameNavigations += 1;
  };
  page.on("framenavigated", onFrameNavigated);
  try {

  const args = consentClickArgs(choice, shadowRootCapability);
  for (let attempt = 0; attempt < CONSENT_BANNER_RETRIES && !summary.clicked; attempt += 1) {
    // Main frame first; consent iframes (Sourcepoint and similar) after it.
    for (const frame of page.frames()) {
      // Keep deterministic lifecycle coordination outside the capture-loss
      // catch: a broken test hook must fail the test, not become site evidence.
      if (beforeSubframeEvaluationForTests && frame !== page.mainFrame()) {
        await beforeSubframeEvaluationForTests(frame);
      }
      let outcome: ConsentClickOutcome | null;
      try {
        outcome = await frame.evaluate(findAndClickConsentControl, args);
        readableFrames += 1;
      } catch {
        // The in-page result is the ONLY evidence of what happened in this
        // frame, so losing it is not the same as searching and finding nothing.
        // A control that reloads the page on click destroys its own context
        // this way, which means the very outcome the probe exists to record is
        // the one most likely to arrive as an error.
        unreadableFrames += 1;
        outcome = null;
      }
      if (outcome && !outcome.clicked) dispatchedControls += outcome.dispatched;
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

  return { summary, readableFrames, unreadableFrames, dispatchedControls, mainFrameNavigations };
  } finally {
    page.off("framenavigated", onFrameNavigated);
  }
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
  trustedSubjectUrl: string,
  firstPartyHostname: string,
  started: number,
  warnings: ScanWarningCollector,
  boundedPageCollectorKey: string,
  lifecycle: KeystrokeProbeLifecycle
): Promise<KeystrokeProbeOutcome> {
  if (MAX_SCAN_DURATION_MS - (Date.now() - started) < KEYSTROKE_PROBE_MIN_BUDGET_MS) {
    return { status: "partial", reason: "budget-unavailable", detection: null };
  }
  if (!sameScanSubjectUrl(page.url(), trustedSubjectUrl)) {
    return { status: "skipped", reason: "load-failed", detection: null, subjectLost: true };
  }

  const sentinel = createSentinel(randomBytes(6).toString("hex"));
  const captured = createProbeRequestCaptureState();
  const onRequest = (request: Request) => {
    if (lifecycle.cancelled) return;
    captureProbeRequest(captured, request, firstPartyHostname);
  };

  page.on("request", onRequest);
  lifecycle.stopCapture = () => page.off("request", onRequest);
  let typed: { count: number; types: string[]; subjectLost: boolean; omittedCandidateCount: number; preventedFieldCount: number };
  // Disclosure must survive a mid-probe failure. Typing has already happened by
  // the time anything below can throw, and those requests stay in the retained
  // log, so a scan that reports them without saying the scanner provoked them
  // is publishing its own traffic as the site's.
  let typedFieldCount = 0;
  try {
    typed = await typeSentinelIntoFields(
      page,
      sentinel,
      trustedSubjectUrl,
      boundedPageCollectorKey,
      {
        isCancelled: () => lifecycle.cancelled,
        onTypedField: (count) => {
          lifecycle.typedFieldCount = count;
        }
      }
    );
    typedFieldCount = typed.count;
    if (lifecycle.cancelled) {
      return { status: "partial", reason: "budget-unavailable", detection: null };
    }
    if (typed.subjectLost) {
      if (typed.count > 0) addKeystrokeProbeDisclosure(warnings, typed.count, false);
      return typed.count > 0
        ? { status: "partial", reason: "load-failed", detection: null, subjectLost: true }
        : { status: "skipped", reason: "load-failed", detection: null, subjectLost: true };
    }
    if (typed.count === 0) {
      const evidenceCapLossCount = Math.min(
        Number.MAX_SAFE_INTEGER,
        captured.capLossCount + typed.omittedCandidateCount
      );
      const failureLossCount = Math.min(
        Number.MAX_SAFE_INTEGER,
        captured.failureLossCount + typed.preventedFieldCount
      );
      return completedKeystrokeProbeOutcome(null, evidenceCapLossCount, failureLossCount);
    }
    const waitMs = Math.min(KEYSTROKE_EXFIL_WAIT_MS, MAX_SCAN_DURATION_MS - (Date.now() - started) - 250);
    if (waitMs > 0) await page.waitForTimeout(waitMs);
    if (lifecycle.cancelled) {
      return { status: "partial", reason: "budget-unavailable", detection: null };
    }
    if (!sameScanSubjectUrl(page.url(), trustedSubjectUrl)) {
      addKeystrokeProbeDisclosure(warnings, typed.count, false);
      return { status: "partial", reason: "load-failed", detection: null, subjectLost: true };
    }
    // Flush batch-on-unload senders: many recorders buffer keystrokes and only
    // transmit via sendBeacon on pagehide. Best-effort and isolated, so a failure
    // here never discards the real-time captures above.
    await flushUnloadBeacons(page, started).catch(() => undefined);
  } catch {
    if (!lifecycle.cancelled && typedFieldCount > 0) addKeystrokeProbeDisclosure(warnings, typedFieldCount);
    return { status: "failed", reason: "scan-failed", detection: null };
  } finally {
    lifecycle.stopCapture();
  }

  if (lifecycle.cancelled) {
    return { status: "partial", reason: "budget-unavailable", detection: null };
  }
  addKeystrokeProbeDisclosure(warnings, typed.count);

  const evidenceCapLossCount = Math.min(
    Number.MAX_SAFE_INTEGER,
    captured.capLossCount + typed.omittedCandidateCount
  );
  const failureLossCount = Math.min(
    Number.MAX_SAFE_INTEGER,
    captured.failureLossCount + typed.preventedFieldCount
  );
  const detection = buildKeystrokeExfiltrationDetection(
    findSentinelLeaks(sentinelEncodings(sentinel), captured.requests),
    {
      fieldsTyped: typed.count,
      fieldTypes: typed.types
    }
  );

  return completedKeystrokeProbeOutcome(detection, evidenceCapLossCount, failureLossCount);
}

function addKeystrokeProbeDisclosure(
  warnings: ScanWarningCollector,
  count: number,
  evidenceRetained = true
): void {
  warnings.add(
    `This scan typed a synthetic test value into ${
      count === 1 ? "1 form field" : `${count} form fields`
    } (never submitting the form) to test whether typed input is captured and sent to third parties. The value is synthetic and is not stored. ${
      evidenceRetained
        ? "Requests the page sent during and after this typing, including any unload beacons, are part of the recorded request log and counts."
        : "Requests from this incomplete probe were omitted from the recorded request log and counts."
    }`
  );
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

export async function typeSentinelIntoFields(
  page: Page,
  sentinel: string,
  trustedSubjectUrl: string,
  boundedPageCollectorKey: string,
  lifecycle?: {
    isCancelled: () => boolean;
    onTypedField: (count: number) => void;
  }
): Promise<{ count: number; types: string[]; subjectLost: boolean; omittedCandidateCount: number; preventedFieldCount: number }> {
  if (!sameScanSubjectUrl(page.url(), trustedSubjectUrl)) {
    return { count: 0, types: [], subjectLost: true, omittedCandidateCount: 0, preventedFieldCount: 0 };
  }
  const locator = page.locator(FILLABLE_FIELD_SELECTOR);
  const rawCandidateCount = await locator.count();
  const totalCandidateCount = Number.isSafeInteger(rawCandidateCount) && rawCandidateCount > 0
    ? rawCandidateCount
    : 0;
  const candidateCount = Math.min(totalCandidateCount, MAX_PROBE_FIELD_CANDIDATES);
  const omittedCandidateCount = Math.max(0, totalCandidateCount - candidateCount);
  const types: string[] = [];
  let count = 0;
  // Fields the probe reached and typed into, where the page refused the input.
  // Tracked separately so a refused field is never reported as a typed one.
  let preventedFieldCount = 0;

  for (
    let candidateIndex = 0;
    candidateIndex < candidateCount && count < MAX_PROBE_FIELDS && !lifecycle?.isCancelled();
    candidateIndex += 1
  ) {
    const handle = await locator.nth(candidateIndex).elementHandle();
    if (!handle) continue;
    if (!sameScanSubjectUrl(page.url(), trustedSubjectUrl)) {
      await handle.dispose().catch(() => undefined);
      return { count, types, subjectLost: true, omittedCandidateCount, preventedFieldCount };
    }
    try {
      if (!(await handle.isVisible())) continue;
      const rawFieldType = await callBoundedElementCollector(
        handle,
        boundedPageCollectorKey,
        "fieldType"
      );
      const fieldType = isBoundedFieldType(rawFieldType) ? rawFieldType : "other";
      if (!sameScanSubjectUrl(page.url(), trustedSubjectUrl)) {
        return { count, types, subjectLost: true, omittedCandidateCount, preventedFieldCount };
      }
      await handle.focus();
      if (!sameScanSubjectUrl(page.url(), trustedSubjectUrl)) {
        return { count, types, subjectLost: true, omittedCandidateCount, preventedFieldCount };
      }
      // Bind typing to the element handle from the trusted document. If a
      // navigation detaches it after the final origin check, Playwright throws;
      // page.keyboard.type could otherwise deliver the sentinel to whichever
      // element happens to gain focus in the replacement document.
      if (lifecycle?.isCancelled()) {
        return { count, types, subjectLost: false, omittedCandidateCount, preventedFieldCount };
      }
      await handle.type(sentinel, { delay: 1 });
      // `type()` resolving only means the keystrokes were dispatched. A field
      // that is readonly, disabled mid-type, or that cancels every keydown
      // accepts none of them, and counting it anyway told readers the scan had
      // "typed into 1 field" when nothing was ever entered. Confirm the
      // scanner's own sentinel is actually in the field before claiming it.
      // The check returns a boolean computed in the page; no field contents
      // are read out.
      const sentinelLanded =
        (await callBoundedElementCollector(handle, boundedPageCollectorKey, "sentinelPresent", sentinel)) === true;
      if (!sentinelLanded) {
        preventedFieldCount += 1;
        continue;
      }
      types.push(fieldType);
      count += 1;
      lifecycle?.onTypedField(count);
      if (lifecycle?.isCancelled()) continue;
      // Some recorders only transmit on blur; never press Enter, which could submit.
      await callBoundedElementCollector(handle, boundedPageCollectorKey, "blur");
    } catch {
      /* skip fields that cannot be focused or typed into */
    } finally {
      await handle.dispose().catch(() => undefined);
    }
  }

  return {
    count,
    types,
    subjectLost: !sameScanSubjectUrl(page.url(), trustedSubjectUrl),
    omittedCandidateCount,
    preventedFieldCount
  };
}

function isBoundedFieldType(value: unknown): value is string {
  return typeof value === "string" && [
    "textarea", "contenteditable", "date", "datetime-local", "email", "month",
    "number", "password", "search", "tel", "text", "time", "url", "week", "other"
  ].includes(value);
}

export type PolicyLinkCollection = {
  links: PolicyLinkCandidate[];
  truncated: boolean;
};

/** Links on the loaded page that plausibly point at a privacy policy. */
export async function collectPrivacyPolicyLinks(
  page: Page,
  boundedPageCollectorKey: string
): Promise<PolicyLinkCollection> {
  const wire = await callBoundedPageCollector(page, boundedPageCollectorKey, "links", {
    maxCandidates: MAX_POLICY_LINK_CANDIDATES,
    maxHrefChars: MAX_POLICY_LINK_HREF_CHARS,
    maxInspected: MAX_POLICY_LINKS_INSPECTED,
    maxMatchTextChars: MAX_POLICY_LINK_MATCH_TEXT_CHARS,
    maxTextChars: MAX_POLICY_LINK_TEXT_CHARS
  });
  if (typeof wire !== "string" || wire.length > 256 * 1024) {
    return { links: [], truncated: true };
  }
  let result: unknown;
  try {
    result = JSON.parse(wire);
  } catch {
    return { links: [], truncated: true };
  }

  const candidate = result as Partial<PolicyLinkCollection>;
  if (!result || typeof result !== "object" || !Array.isArray(candidate.links)) {
    return { links: [], truncated: true };
  }
  const links = candidate.links
    .filter(
      (link): link is PolicyLinkCandidate =>
        link !== null &&
        typeof link === "object" &&
        typeof link.href === "string" &&
        link.href.length <= MAX_POLICY_LINK_HREF_CHARS &&
        typeof link.text === "string" &&
        link.text.length <= MAX_POLICY_LINK_TEXT_CHARS
    )
    .slice(0, MAX_POLICY_LINK_CANDIDATES);
  return {
    links,
    truncated: candidate.truncated === true || links.length !== candidate.links.length
  };
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
  boundedPageCollectorKey: string;
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

    const policyResponse = await policyPage.goto(policyUrl, {
      waitUntil: "domcontentloaded",
      timeout: scanTimeout(input.started, PRIVACY_POLICY_NAV_TIMEOUT_MS)
    });
    // The candidate link is only a guess about where the policy lives. A 404,
    // a 403, or any other error response is an error page, not the site's
    // policy, and reading its body produced claims (and contradictions with
    // the visit's evidence) attributed to a document the site never published.
    // Retain the response and refuse anything that did not actually serve.
    // Reported through the detector ledger and its capture loss rather than a
    // new warning string: the scanner's fixed warning vocabulary is part of the
    // published redaction identity, and adding to it would retire the current
    // r2 normalization for every live report.
    const policyStatus = policyResponse?.status() ?? null;
    if (policyStatus === null || policyStatus < 200 || policyStatus >= 400) return null;
    assertAllowedPrivacyPolicyPage(policyPage.url(), input.firstPartyHostname);
    // CMP-hosted policies often render their text client-side after load.
    const renderWait = Math.min(PRIVACY_POLICY_RENDER_WAIT_MS, MAX_SCAN_DURATION_MS - (Date.now() - input.started) - 500);
    if (renderWait > 0) await policyPage.waitForTimeout(renderWait);
    assertAllowedPrivacyPolicyPage(policyPage.url(), input.firstPartyHostname);

    const policyTextWire = await withScanDeadline(
      callBoundedPageCollector(
        policyPage,
        input.boundedPageCollectorKey,
        "text",
        MAX_POLICY_TEXT_CHARS
      ),
      input.started,
      MAX_SCAN_DURATION_MS,
      scanTimeoutError
    );
    const policyText = boundedPolicyTextFromWire(policyTextWire);
    // Re-check after DOM extraction as a final race boundary. If the page
    // navigated while text was being read, neither its text nor URL is safe to
    // attribute to the original scan subject.
    const observedPolicyUrl = policyPage.url();
    assertAllowedPrivacyPolicyPage(observedPolicyUrl, input.firstPartyHostname);

    const trackingEntities = trackerEntitySummaries({ domains: summarizeDomains(input.requests) })
      .filter(isTrackingEntity)
      .map((entity) => entity.entity);

    const summary = buildPrivacyPolicySummary({
      url: observedPolicyUrl,
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

function boundedPolicyTextFromWire(wire: string | null): string {
  if (typeof wire !== "string" || wire.length > MAX_POLICY_TEXT_CHARS + 128) return "";
  try {
    const value = JSON.parse(wire) as { value?: unknown };
    return typeof value?.value === "string" && value.value.length <= MAX_POLICY_TEXT_CHARS
      ? value.value
      : "";
  } catch {
    return "";
  }
}

function assertAllowedPrivacyPolicyPage(url: string, firstPartyHostname: string): void {
  if (!isAllowedPrivacyPolicyUrl(url, firstPartyHostname)) {
    // Do not include the attacker-controlled destination in the error: callers
    // deliberately collapse this to the detector's safe load-failed reason.
    throw new Error("Privacy policy navigation left the allowed policy subject.");
  }
}

// Cap captured POST bodies before we retain, parse, or substring-search them.
// The scanned page controls these bodies, so without a bound a single very large
// POST would be copied into scan memory and then JSON-parsed (pixel decoding) or
// scanned for the keystroke sentinel. 64 KB is far above real pixel/beacon
// payloads, so decoding stays lossless in practice while the work stays bounded.
export const MAX_CAPTURED_BODY_CHARS = 64_000;

type BoundedPostData = {
  value: string | null;
  truncated: boolean;
  unreadable: boolean;
};

export type ProbeRequestCaptureState = {
  requests: CapturedRequest[];
  captureLossCount: number;
  capLossCount: number;
  failureLossCount: number;
};

export function createProbeRequestCaptureState(): ProbeRequestCaptureState {
  return { requests: [], captureLossCount: 0, capLossCount: 0, failureLossCount: 0 };
}

function addProbeCaptureLoss(
  state: ProbeRequestCaptureState,
  cause: "cap" | "failure"
): void {
  state.captureLossCount = Math.min(Number.MAX_SAFE_INTEGER, state.captureLossCount + 1);
  const key = cause === "cap" ? "capLossCount" : "failureLossCount";
  state[key] = Math.min(Number.MAX_SAFE_INTEGER, state[key] + 1);
}

/** Retain only bounded request evidence while the active probe listener is live. */
export function captureProbeRequest(
  state: ProbeRequestCaptureState,
  request: Pick<Request, "postData" | "url">,
  firstPartyHostname: string
): void {
  if (state.requests.length >= MAX_PROBE_CAPTURED_REQUESTS) {
    addProbeCaptureLoss(state, "cap");
    return;
  }

  try {
    const url = request.url();
    if (url.length > MAX_RECORDED_REQUEST_URL_CHARS) {
      addProbeCaptureLoss(state, "cap");
      return;
    }
    const hostname = safeParseUrl(url)?.hostname;
    if (!hostname) {
      addProbeCaptureLoss(state, "failure");
      return;
    }
    const body = safeRequestPostDataWithCoverage(request);
    if (body.truncated) addProbeCaptureLoss(state, "cap");
    if (body.unreadable) addProbeCaptureLoss(state, "failure");
    state.requests.push({
      domain: hostname,
      thirdParty: isThirdParty(firstPartyHostname, hostname),
      url,
      body: body.value
    });
  } catch {
    addProbeCaptureLoss(state, "failure");
  }
}

// Playwright exposes the POST body synchronously, but reading it can throw for
// some request types. Keep unreadable distinct from a legitimately absent body
// so detector coverage cannot turn a read failure into a complete negative.
// Over-long bodies are truncated (see MAX_CAPTURED_BODY_CHARS).
function safeRequestPostDataWithCoverage(request: Pick<Request, "postData">): BoundedPostData {
  try {
    const body = request.postData();
    if (body === null) return { value: null, truncated: false, unreadable: false };
    return body.length > MAX_CAPTURED_BODY_CHARS
      ? { value: body.slice(0, MAX_CAPTURED_BODY_CHARS), truncated: true, unreadable: false }
      : { value: body, truncated: false, unreadable: false };
  } catch {
    return { value: null, truncated: false, unreadable: true };
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

/** {@link withDeadlineDisposing} bound to this scanner's absolute scan deadline. */
async function withScanTimeoutDisposing<T>(
  start: () => Promise<T>,
  started: number,
  dispose: (value: T) => Promise<unknown> | unknown,
  signal?: AbortSignal
): Promise<T> {
  return withDeadlineDisposing(start, started, MAX_SCAN_DURATION_MS, dispose, scanTimeoutError, signal);
}

function scanTimeoutError(): PublicScanError {
  return new PublicScanError("The scan exceeded the maximum scan duration.", 504);
}

function scannerEgressDescription(): string {
  return scannerEgressLabel();
}

async function resolveCnameCloaksForScan(
  requests: NetworkRequestRecord[],
  firstPartyHostname: string,
  started: number,
  options: ScanSiteOptions,
  matchTracker: (host: string) => TrackerMatch | null,
  onResolutionFailure?: (host: string) => void
): Promise<CnameCloakResolution> {
  if (MAX_SCAN_DURATION_MS - (Date.now() - started) < CNAME_PROBE_MIN_BUDGET_MS) {
    return { cloaks: [], omittedCandidateCount: 0 };
  }
  // The entry check only proved there was budget to BEGIN. Bind every lookup to
  // the same deadline so the probe cannot outlive the scan it belongs to.
  const deadline = started + MAX_SCAN_DURATION_MS;
  return resolveCnameCloaks(requests, firstPartyHostname, {
    registrableDomain: partyKey,
    matchTracker,
    resolveCnameChain: options.resolveCnameChain ?? ((host: string) => resolveCnameChainViaDns(host, deadline)),
    onResolutionFailure,
    maxHosts: MAX_CNAME_LOOKUPS
  });
}

/**
 * Follow a hostname's CNAME chain via DNS, bounded by hops, a per-lookup
 * timeout, AND the scan's own deadline.
 *
 * The hop and lookup bounds alone are per-host: ten hosts of three hops at
 * 1.5 s each is 45 s of DNS that could begin with three seconds of scan budget
 * left, so the advertised scan duration bounded nothing here. The deadline is
 * therefore checked before every lookup and also caps each one, and exhausting
 * it throws so the caller discloses the loss instead of reporting a short chain
 * as if the probe had finished.
 */
async function resolveCnameChainViaDns(host: string, deadline: number): Promise<string[]> {
  const chain: string[] = [];
  let current = host;
  for (let hop = 0; hop < CNAME_MAX_HOPS; hop += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("cname-deadline-exceeded");
    let records: string[];
    try {
      records = await withDnsTimeout(dnsPromises.resolveCname(current), Math.min(CNAME_LOOKUP_TIMEOUT_MS, remaining));
    } catch (error) {
      // ENODATA is the authoritative answer "this name exists and has no
      // CNAME", which ends the chain cleanly. Everything else, NXDOMAIN,
      // SERVFAIL, REFUSED, and this module's own lookup timeout, means the
      // detector could not observe. Collapsing those into an empty chain let a
      // detector that never resolved anything publish as complete evidence,
      // so they propagate and the caller records the loss.
      if ((error as NodeJS.ErrnoException | undefined)?.code === "ENODATA") break;
      throw error;
    }
    const next = records[0];
    if (!next) break;
    chain.push(next);
    current = next;
  }
  return chain;
}

function withDnsTimeout(operation: Promise<string[]>, timeoutMs = CNAME_LOOKUP_TIMEOUT_MS): Promise<string[]> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<string[]>((_, reject) => {
    timer = setTimeout(() => reject(new Error("dns-lookup-timeout")), Math.max(1, timeoutMs));
  });
  return Promise.race([operation, timeout]).finally(() => clearTimeout(timer));
}
