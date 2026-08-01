import {
  PAGE_SUBJECT_UNVERIFIED_WARNING,
  SUSPECTED_CHALLENGE_OR_SOFT_BLOCK_WARNING
} from "./bot-wall-classifier";
import { compareScanResults } from "./compare-reports";
import {
  CONSENT_CMP_SELECTORS,
  CONSENT_PROBE_OUTCOMES,
  CONSENT_SHADOW_HOSTS,
  CONSENT_TEXT_PATTERNS,
  consentInteractionWarning,
  matchesConsentChoice,
  normalizeConsentLabel
} from "./consent-interaction";
import { CONSENT_RELOAD_DISCLOSURE } from "./consent-verification";
import { summarizeDomains } from "./domain-summaries";
import { isFingerprintDetectionSummary } from "./fingerprint-detection-guard";
import {
  AUDIO_FINGERPRINT_APIS,
  CANVAS_READ_APIS,
  FINGERPRINT_EVENT_APIS,
  INPUT_MONITORING_EVENTS,
  KEYSTROKE_ENCODINGS,
  KEYSTROKE_FIELD_TYPES,
  LISTENER_TARGETS,
  SESSION_RECORDING_EVENTS,
  WEBGL_PARAMETERS,
  WEBGL_READ_APIS
} from "./measurement-kernel";
import {
  addRedactionCounters,
  emptyRedactionCounters,
  redactCookieName,
  redactHostnameV2,
  redactPageTitle,
  redactPathV2,
  redactStorageKey,
  redactUrlV2,
  publicRegistrableDomain,
  type RedactionCounters
} from "./redaction-v2";
import { isCanonicalReportShare } from "./report-locator";
import { MIN_POLICY_TEXT_LENGTH } from "./privacy-policy";
import { scannerDisclosure, type ScanConditionsProfile } from "./scan-condition-disclosure";
import { PUBLIC_SCANNER_EGRESS_LABELS } from "./scanner-egress";
import {
  FINGERPRINT_OBSERVER_CAPTURE_LOSS_WARNING,
  INVALID_UPSTREAM_RESPONSE_WARNING,
  KEYSTROKE_PROBE_INCOMPLETE_WARNING,
  PIXEL_DECODE_CAPTURE_LOSS_WARNING,
  UNSETTLED_ROUTED_REQUEST_WARNING
} from "./scan-runtime";
import { GPC_WORKER_CAPTURE_LOSS_WARNING } from "./gpc-injection";
import {
  NODE_PLAYWRIGHT_VERSION,
  NODE_SCANNER_METHODOLOGY_VERSION,
  NODE_SHIELDS_REQUEST_CONTEXT_VERSION
} from "./legacy-methodology";
import { canonicalJson } from "./scan-report-v2-fingerprints";
import { sha256Hex } from "./sha256";
import { canonicalTrackerCatalogContents, findTrackerMatch, trackerCatalogMetadata } from "./tracker-catalog";
import type {
  ComparisonScanResult,
  ConsentInteractionSummary,
  CookieRecord,
  FingerprintDetectionSummary,
  FingerprintEventSummary,
  NetworkRequestProvenance,
  NetworkRequestRecord,
  PixelEventSummary,
  PrivacyPolicySummary,
  ReportShare,
  ScanConditions,
  ScanReport,
  ScanResult,
  StorageRecord,
  TrackerMatch
} from "./types";

/**
 * Redaction-v2 backport for the frozen v1 wire.
 *
 * V1 cannot gain a redactionVersion or privacy counters without changing its
 * schema, so the public bytes stay v1 while managed-storage provenance lives
 * outside the report. This pure transform still returns the exact counters a
 * later v2 producer will place on the wire. It is deliberately non-mutating
 * and byte-idempotent: producer, persistence, export, and remediation may all
 * apply it without progressively degrading class markers.
 */
export type RedactedV1<T extends ScanReport> = {
  report: T;
  counters: RedactionCounters;
};

const MAX_POLICY_QUOTE_CHARS = 200;
const MAX_POLICY_TEXT_CHARS = 400_000;
const MAX_WARNING_CHARS = 600;
const MAX_COMPARISON_TITLE_CHARS = 160;
const MAX_RUN_LABEL_CHARS = 80;
const REDACTED_PUBLIC_STRING = "[redacted]";
const REDACTED_WARNING = "[redacted warning]";
const SAFE_HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
const SAFE_COOKIE_SAME_SITE = new Set(["Strict", "Lax", "None", "Unspecified"]);
const SAFE_RESOURCE_TYPES = new Set([
  "document",
  "stylesheet",
  "image",
  "media",
  "font",
  "script",
  "texttrack",
  "xhr",
  "fetch",
  "ping",
  "cspreport",
  "beacon",
  "eventsource",
  "websocket",
  "manifest",
  "other"
]);
const SAFE_SCANNER_EGRESS = new Set<string>(PUBLIC_SCANNER_EGRESS_LABELS);
const SAFE_ADBLOCK_SOURCE = "Brave default ad-block lists";
const INVALID_METHODOLOGY_DISCLOSURE = "Methodology metadata was invalid and was removed at the public boundary.";
const CHROMIUM_VERSION = /^(?:Brave\/\d+(?:\.\d+){1,3} Chromium\/)?\d+(?:\.\d+){1,3}$/;
const CHROMIUM_USER_AGENT = /^Mozilla\/5\.0 \((?:X11; Linux x86_64|Macintosh; Intel Mac OS X \d+(?:_\d+){1,3}|Windows NT \d+\.\d+; Win64; x64)\) AppleWebKit\/\d+\.\d+ \(KHTML, like Gecko\) (?:HeadlessChrome|Chrome)\/\d+(?:\.\d+){1,3} Safari\/\d+\.\d+$/;
const HISTORICAL_TRACKER_CATALOGS = Object.freeze([
  Object.freeze({
    source: "Hand-curated service catalog",
    version: "hand-curated-2026.06",
    region: "US-biased",
    entries: 133,
    curatedOverrides: 133,
    license: "AGPL-3.0-or-later"
  }),
  Object.freeze({
    source: "Hand-curated service catalog",
    version: "hand-curated-2026.07",
    region: "US-biased",
    entries: 137,
    curatedOverrides: 137,
    license: "AGPL-3.0-or-later"
  })
] satisfies readonly ScanConditions["trackerCatalog"][]);

// PageGraph exports are external input. Lexical shape cannot prove an id or
// node type is producer-owned rather than a page-controlled name. A redaction
// pass therefore aliases every opaque id by first-seen order and admits only
// the closed PageGraph node-type vocabulary. Sequential aliases keep causal
// joins useful and remain byte-idempotent when the same report is sanitized
// again because encounter order is stable.
const OPAQUE_ID_ALIAS_PREFIX = "id-";
const OPAQUE_ID_ALIAS_WIDTH = 6;
const PAGEGRAPH_INITIATOR_TYPES = new Set([
  "resource",
  "script",
  "HTML element",
  "text node",
  "DOM root",
  "frame owner",
  "parser",
  "web API",
  "JS builtin",
  "local storage",
  "session storage",
  "cookie jar",
  "storage",
  "remote frame",
  "binding",
  "binding event",
  "ad filter",
  "tracker filter",
  "fingerprinting filter",
  "Brave Shields",
  "ads shield",
  "trackers shield",
  "javascript shield",
  "fingerprinting shield",
  "fingerprintingV2 shield",
  "extensions",
  // Present in the maintained parser fixture even though older PageGraph
  // documentation called the corresponding node a DOM root.
  "web page"
]);

const KNOWN_CMP_NAMES = new Set(CONSENT_CMP_SELECTORS.map((entry) => entry.cmp));
const LEGACY_PUBLIC_CONSENT_MATCHED_TEXT: Record<
  ConsentInteractionSummary["mode"],
  readonly string[]
> = {
  "accept-all": ["agree", "consent"],
  "reject-all": []
};
const KNOWN_PIXEL_MATCH_FIELDS = new Set([
  "email",
  "phone",
  "name",
  "address",
  "date_of_birth",
  "gender",
  "external_id"
]);
const KNOWN_POLICY_CLAIM_KINDS = new Set(["no-cookies", "no-third-party-cookies", "no-selling-or-sharing", "honors-gpc"]);
const CURATED_TRACKER_MATCHES = (JSON.parse(canonicalTrackerCatalogContents()) as Array<{ domain: string }>)
  .flatMap((entry) => {
    const match = findTrackerMatch(entry.domain);
    return match === null ? [] : [match];
  });

/**
 * Own-property lookup only. `PIXEL_PRODUCTS[platform]` on a plain object
 * literal resolves inherited Object.prototype members, so a platform value of
 * "constructor", "toString", or "valueOf" returned a truthy Function and
 * walked straight past the `if (!catalog) continue` fail-closed guard, then
 * threw on `catalog.events`. The scanner only ever emits literal platform
 * names, but this function is also reachable from imported and uploaded
 * reports, where the value is not ours.
 */
function pixelCatalogFor(platform: string): (typeof PIXEL_PRODUCTS)[keyof typeof PIXEL_PRODUCTS] | null {
  return Object.hasOwn(PIXEL_PRODUCTS, platform)
    ? PIXEL_PRODUCTS[platform as keyof typeof PIXEL_PRODUCTS]
    : null;
}

const PIXEL_PRODUCTS = {
  Meta: {
    product: "Meta Pixel",
    events: new Set([
      "PageView",
      "AddPaymentInfo",
      "AddToCart",
      "AddToWishlist",
      "CompleteRegistration",
      "Contact",
      "CustomizeProduct",
      "Donate",
      "FindLocation",
      "InitiateCheckout",
      "Lead",
      "Purchase",
      "Schedule",
      "Search",
      "StartTrial",
      "SubmitApplication",
      "Subscribe",
      "ViewContent",
      "custom event"
    ])
  },
  TikTok: {
    product: "TikTok Pixel",
    events: new Set([
      "Pageview",
      "AddPaymentInfo",
      "AddToCart",
      "AddToWishlist",
      "ClickButton",
      "CompletePayment",
      "CompleteRegistration",
      "Contact",
      "Download",
      "InitiateCheckout",
      "PlaceAnOrder",
      "Search",
      "SubmitForm",
      "Subscribe",
      "ViewContent",
      "custom event"
    ])
  },
  X: {
    product: "X (Twitter) Pixel",
    events: new Set(["Purchase", "Conversion tracking", "custom event"])
  }
} as const;

const FIXED_SCANNER_WARNINGS = new Set([
  "This report is one automated, headless Chromium visit from a fixed en-US / UTC profile, with no scrolling, clicking, or consent interaction. Sites can behave differently for real users, browsers, regions, accounts, or network locations.",
  "This report is one automated, headless Chromium visit from a fixed en-US / UTC profile, with no scrolling or clicking except one scripted choice on the cookie/consent banner (disclosed below). Sites can behave differently for real users, browsers, regions, accounts, or network locations.",
  "Counts are a lower bound: trackers that load only after interaction or consent are not observed; Service Workers are blocked, and Web Worker or WebSocket traffic may be incomplete. Service labels use a US-biased hand-curated catalog, so regional services may be under-labeled. Cookie and storage figures are an end-of-visit snapshot, with storage keys read from the top frame only.",
  "Counts are a lower bound: trackers that load only after further interaction are not observed; Service Workers are blocked, and Web Worker or WebSocket traffic may be incomplete. Service labels use a US-biased hand-curated catalog, so regional services may be under-labeled. Cookie and storage figures are an end-of-visit snapshot, with storage keys read from the top frame only.",
  // Historical pre-worker-block wording remains safe producer vocabulary for
  // remediation of reports generated by earlier methodology versions.
  "Counts are a lower bound: trackers that load only after interaction or consent, any activity inside Web or Service Workers, and WebSocket traffic are not observed. Service labels use a US-biased hand-curated catalog, so regional services may be under-labeled. Cookie and storage figures are an end-of-visit snapshot, with storage keys read from the top frame only.",
  "Counts are a lower bound: trackers that load only after further interaction, any activity inside Web or Service Workers, and WebSocket traffic are not observed. Service labels use a US-biased hand-curated catalog, so regional services may be under-labeled. Cookie and storage figures are an end-of-visit snapshot, with storage keys read from the top frame only.",
  // Historical scanner wording remains producer vocabulary during in-place
  // remediation even though new reports use the more precise lines above.
  "Counts are a lower bound: trackers that load only after interaction or consent, and any activity inside Web or Service Workers, are not observed. Service labels use a US-biased hand-curated catalog, so regional services may be under-labeled. Cookie and storage figures are an end-of-visit snapshot.",
  "Counts are a lower bound: trackers that load only after further interaction, and any activity inside Web or Service Workers, are not observed. Service labels use a US-biased hand-curated catalog, so regional services may be under-labeled. Cookie and storage figures are an end-of-visit snapshot.",
  "One or more requests were blocked or failed at connection time. This scan did not record whether that was a private-address guard block or an ordinary connection failure (a DNS or connect error), so no private-network claim is made.",
  "Brave Shields classification was unavailable for this scan; tracker labels use the curated catalog only.",
  "Brave Shields block simulation was enabled; matching requests were aborted before loading and are not included in request totals.",
  "The page did not reach network idle before the scan window ended.",
  "The page did not reach network idle before the Cloudflare scan window ended.",
  SUSPECTED_CHALLENGE_OR_SOFT_BLOCK_WARNING,
  PAGE_SUBJECT_UNVERIFIED_WARNING,
  "Blocked one or more requests that resolved to local or private network addresses at connection time.",
  "The scan stopped opening additional proxy requests after reaching its connection and target safety budget.",
  INVALID_UPSTREAM_RESPONSE_WARNING,
  UNSETTLED_ROUTED_REQUEST_WARNING,
  FINGERPRINT_OBSERVER_CAPTURE_LOSS_WARNING,
  KEYSTROKE_PROBE_INCOMPLETE_WARNING,
  PIXEL_DECODE_CAPTURE_LOSS_WARNING,
  GPC_WORKER_CAPTURE_LOSS_WARNING,
  CONSENT_RELOAD_DISCLOSURE,
  "The consent interaction left the recorded site; later page state was not used and the active input probe was skipped.",
  "The post-consent reload left the recorded site; its state was not used and the active input probe was skipped.",
  "The page left the recorded site before or during the active input probe; the probe stopped without acting on the other site.",
  "Blocked additional non-HTTP(S) requests. Only the first 5 examples are shown.",
  "Blocked additional requests that could not be verified as public. Only the first 5 examples are shown.",
  "Shareable report could not be saved on this host; JSON export is still available.",
  "This report was adapted from Brave PageGraph-derived observations. Treat it as evidence for the recorded crawl conditions, not a universal claim about all visitors.",
  "PageGraph browser and environment conditions, pagegraph-crawl version and source revision, sanitizer identity, and quality and coverage declarations are self-reported by the supplied metadata sidecar, not cryptographic proof or artifact-derived attestation; the GraphML description independently binds only schema, root URL, capture date, and duration.",
  "PageGraph r2 imports emit request observations only. Cookie, storage, fingerprinting, detector, and consent evidence are unsupported and explicitly censored.",
  "No PageGraph request provenance was supplied. This report can show observed requests but not script-to-request causality.",
  "One or more PageGraph requests were omitted because their URLs were not HTTP(S).",
  "No PageGraph nodes or edges were found in the supplied GraphML.",
  "No PageGraph network request observations were extracted.",
  "The scanned page URL was inferred from the first observed URL because the export had no page/frame root node. First-party vs third-party classification may be off; re-run with an explicit page URL if it looks wrong.",
  "This Cloudflare report is one automated, headless Chromium visit from Cloudflare Browser Run. It does not scroll, click, sign in, or interact with consent prompts.",
  "This Cloudflare scanner verifies public URL shape and DNS answers before navigation and resource loading, but Browser Run performs its own connection-time DNS resolution and this Worker cannot currently pin the browser connection to the verified IP. Brave Shields block simulation is not enabled in this deployment.",
  "Comparison runs are sequential automated visits, not simultaneous observations. Differences can also come from timing, experiments, cache state, consent state, or bot detection.",
  "Brave-list blocking comparison runs should be collected under matched crawl conditions, and the blocking run is a simulation with Brave's engine and default lists in this scanner's browser, not a live Brave visit. Differences can still reflect timing, experiments, cache state, consent state, or bot detection.",
  "Shields comparison runs should be collected under matched crawl conditions. Differences can still reflect timing, experiments, cache state, consent state, or bot detection.",
  "Consent comparison runs are sequential automated visits: one asked to click the banner's accept-all choice, one asked to click reject-all (first layer only). A run where no control was clicked reflects the pre-consent state instead; see each run's consent note. Differences can also come from timing, experiments, cache state, or bot detection.",
  "Temporal comparison runs are separate observations. Differences can reflect site releases, experiments, timing, geography, cache state, or bot detection."
]);

const COMPARISON_WARNING_LABELS = new Set([
  "GPC off",
  "GPC on",
  "No blocking",
  "Brave-list blocking",
  "Shields off",
  "Shields on",
  "Accept-all click",
  "Accept-all attempt",
  "Reject-all click",
  "Reject-all attempt",
  "Before",
  "After",
  "Baseline",
  "Variant"
]);

export const PUBLIC_STRING_POLICY_VERSION = "public-string-policy-v3";
/**
 * Identity of every non-allowlist public string vocabulary in this sanitizer.
 * A selector, warning, method, resource, pixel, or opaque-id change changes the
 * normalization identity used by v2.
 *
 * ONE ENTRY IS NOT MACHINE-DERIVED. `dynamicWarningPatterns` is the hand-bumped
 * label below, not a digest of the roughly ten admission regexes inside
 * `isScannerWarning`, because those regexes are already baked into the
 * published normalization identity of every committed report: deriving it now
 * would change the digest for reports whose bytes are frozen. Editing any of
 * those regexes therefore REQUIRES bumping that label in the same commit, or
 * two different warning vocabularies publish the same identity. The docblock
 * used to claim the whole object was machine-derived, which is exactly the
 * assumption that makes the manual step easy to skip.
 */
export const PUBLIC_STRING_POLICY_DIGEST = sha256Hex(
  canonicalJson({
    version: PUBLIC_STRING_POLICY_VERSION,
    httpMethods: [...SAFE_HTTP_METHODS].sort(),
    resourceTypes: [...SAFE_RESOURCE_TYPES].sort(),
    cookieSameSite: [...SAFE_COOKIE_SAME_SITE].sort(),
    scannerEgress: [...SAFE_SCANNER_EGRESS].sort(),
    adblockSource: SAFE_ADBLOCK_SOURCE,
    historicalTrackerCatalogs: HISTORICAL_TRACKER_CATALOGS,
    chromiumVersionPattern: CHROMIUM_VERSION.source,
    chromiumUserAgentPattern: CHROMIUM_USER_AGENT.source,
    fixedWarnings: [...FIXED_SCANNER_WARNINGS].sort(),
    warningLabels: [...COMPARISON_WARNING_LABELS].sort(),
    dynamicWarningPatterns: "scanner-warning-patterns-v7",
    cmpSelectors: CONSENT_CMP_SELECTORS,
    consentShadowHosts: CONSENT_SHADOW_HOSTS,
    consentTextPatterns: Object.fromEntries(
      Object.entries(CONSENT_TEXT_PATTERNS).map(([key, value]) => [key, value.source])
    ),
    legacyConsentMatchedText: LEGACY_PUBLIC_CONSENT_MATCHED_TEXT,
    pixelMatchFields: [...KNOWN_PIXEL_MATCH_FIELDS].sort(),
    pixelProducts: Object.fromEntries(
      Object.entries(PIXEL_PRODUCTS).map(([key, value]) => [key, { product: value.product, events: [...value.events].sort() }])
    ),
    opaqueIdPolicy: {
      prefix: OPAQUE_ID_ALIAS_PREFIX,
      width: OPAQUE_ID_ALIAS_WIDTH,
      initiatorTypes: [...PAGEGRAPH_INITIATOR_TYPES].sort()
    },
    fingerprintVocabulary: {
      eventApis: FINGERPRINT_EVENT_APIS,
      canvasReadApis: CANVAS_READ_APIS,
      webglReadApis: WEBGL_READ_APIS,
      webglParameters: WEBGL_PARAMETERS,
      audioApis: AUDIO_FINGERPRINT_APIS,
      sessionEvents: SESSION_RECORDING_EVENTS,
      inputEvents: INPUT_MONITORING_EVENTS,
      listenerTargets: LISTENER_TARGETS,
      keystrokeEncodings: KEYSTROKE_ENCODINGS,
      keystrokeFieldTypes: KEYSTROKE_FIELD_TYPES
    },
    limits: {
      pageTitle: "withheld-empty-marker",
      policyQuote: MAX_POLICY_QUOTE_CHARS,
      warning: MAX_WARNING_CHARS,
      comparisonTitle: MAX_COMPARISON_TITLE_CHARS,
      runLabel: MAX_RUN_LABEL_CHARS
    }
  })
);

export function redactScanReportV1<T extends ScanReport>(report: T): RedactedV1<T> {
  if (report.reportType !== "comparison") {
    return redactScanResultV1(report) as RedactedV1<T>;
  }

  const pass = new RedactionPass();
  const baseline = redactScanResultV1(report.baseline);
  const variant = redactScanResultV1(report.variant);
  pass.add(baseline.counters);
  pass.add(variant.counters);

  const redacted: ComparisonScanResult = {
    ok: true,
    schemaVersion: report.schemaVersion,
    reportType: "comparison",
    comparisonType: report.comparisonType,
    title: boundedPublicText(report.title, MAX_COMPARISON_TITLE_CHARS),
    ...(report.runLabels
      ? {
          runLabels: {
            baseline: boundedPublicText(report.runLabels.baseline, MAX_RUN_LABEL_CHARS),
            variant: boundedPublicText(report.runLabels.variant, MAX_RUN_LABEL_CHARS)
          }
        }
      : {}),
    requestedUrl: pass.url(report.requestedUrl, false),
    scannedAt: report.scannedAt,
    device: report.device,
    baseline: baseline.report,
    variant: variant.report,
    // Domain/name generalization can collapse formerly-distinct keys. Rebuild
    // from the sanitized arms so no raw diff string survives and the diff is
    // internally consistent with the evidence a reader actually receives.
    diff: compareScanResults(baseline.report, variant.report),
    warnings: redactScannerWarnings(report.warnings, pass),
    ...copyValidatedShare(report.share)
  };

  return { report: redacted as T, counters: pass.counters };
}

export function redactScanResultV1(result: ScanResult): RedactedV1<ScanResult> {
  const pass = new RedactionPass();
  const requests = result.requests.map((request) => redactRequest(request, pass));
  const domains = summarizeDomains(requests);
  const cookies = result.cookies.map((cookie) => redactCookie(cookie, pass));
  const storage = result.storage.map((entry) => redactStorage(entry, pass));
  const fingerprintEvents = redactFingerprintEvents(result.fingerprintEvents);
  const fingerprintDetections = result.fingerprintDetections?.flatMap((detection) => {
    const redacted = redactFingerprintDetection(detection, pass);
    return redacted === null ? [] : [redacted];
  });
  const cnameCloaks = result.cnameCloaks?.flatMap((cloak) => {
    const tracker = redactTrackerMatch(cloak.tracker, pass, cloak.cname);
    return tracker === null
      ? []
      : [{ host: pass.hostname(cloak.host), cname: pass.hostname(cloak.cname), tracker }];
  });
  const trackerEntities = new Set<string>();
  for (const request of requests) if (request.tracker !== null) trackerEntities.add(request.tracker.entity);
  for (const cloak of cnameCloaks ?? []) trackerEntities.add(cloak.tracker.entity);
  const privacyPolicy = result.privacyPolicy === undefined || !validPolicyTextLength(result.privacyPolicy.policyTextLength)
    ? undefined
    : redactPrivacyPolicy(result.privacyPolicy, pass, trackerEntities);

  const redacted: ScanResult = {
    ok: true,
    schemaVersion: result.schemaVersion,
    ...(result.reportType !== undefined ? { reportType: "single" as const } : {}),
    summary: {
      pageTitle: redactPageTitle(result.summary.pageTitle),
      status: result.summary.status,
      durationMs: result.summary.durationMs,
      firstPartyDomain: pass.hostname(result.summary.firstPartyDomain),
      totalRequests: requests.length,
      thirdPartyRequests: requests.filter((request) => request.thirdParty).length,
      knownTrackerRequests: requests.filter((request) => request.tracker !== null).length,
      thirdPartyDomains: domains.filter((domain) => domain.thirdParty).length,
      cookies: cookies.length,
      thirdPartyCookies: cookies.filter((cookie) => cookie.thirdParty).length,
      storageEntries: storage.length,
      fingerprintEvents: fingerprintEvents.reduce((total, event) => total + event.count, 0),
      ...(result.summary.shieldsBlockedRequests !== undefined
        // The blocking arm aborts matched requests before they enter the
        // request log, so this producer-owned count cannot be reconstructed
        // from the surviving rows the way the ordinary summary counts can.
        ? { shieldsBlockedRequests: result.summary.shieldsBlockedRequests }
        : {})
    },
    conditions: redactConditions(result.conditions, pass),
    requests,
    domains,
    cookies,
    storage,
    fingerprintEvents,
    ...(fingerprintDetections !== undefined ? { fingerprintDetections } : {}),
    ...(cnameCloaks !== undefined ? { cnameCloaks } : {}),
    ...(result.pixelEvents !== undefined
      ? { pixelEvents: redactPixelEvents(result.pixelEvents) }
      : {}),
    ...(privacyPolicy !== undefined ? { privacyPolicy } : {}),
    ...(result.consentInteraction !== undefined
      ? { consentInteraction: redactConsentInteraction(result.consentInteraction, pass) }
      : {}),
    // The immediate result may intentionally retain a screenshot for the
    // submitter. Persistence/export projectors strip it at their own boundary.
    screenshot: result.screenshot,
    warnings: redactScannerWarnings(result.warnings, pass),
    ...copyValidatedShare(result.share)
  };

  return { report: redacted, counters: pass.counters };
}

export class RedactionPass {
  readonly counters = emptyRedactionCounters();
  private readonly opaqueIdAliases = new Map<string, string>();

  add(counters: RedactionCounters): void {
    addRedactionCounters(this.counters, counters);
  }

  url(value: string, preserveQueryKeys: boolean): string {
    const redacted = redactUrlV2(value, { preserveQueryKeys });
    this.add(redacted.counters);
    return redacted.value;
  }

  hostname(value: string): string {
    const redacted = redactHostnameV2(value);
    this.add(redacted.counters);
    return redacted.value;
  }

  path(value: string): string {
    const redacted = redactPathV2(value);
    this.add(redacted.counters);
    return redacted.value;
  }

  cookieName(value: string): string {
    return redactCookieName(value, this.counters).value;
  }

  storageKey(value: string): string {
    return redactStorageKey(value, this.counters).value;
  }

  opaqueId(value: string): string {
    const existing = this.opaqueIdAliases.get(value);
    if (existing !== undefined) return existing;
    const alias = `${OPAQUE_ID_ALIAS_PREFIX}${String(this.opaqueIdAliases.size + 1).padStart(OPAQUE_ID_ALIAS_WIDTH, "0")}`;
    this.opaqueIdAliases.set(value, alias);
    return alias;
  }

  originOrHostname(value: string): string {
    return /^https?:\/\//i.test(value) ? this.url(value, false) : this.hostname(value);
  }
}

function redactConditions(conditions: ScanConditions, pass: RedactionPass): ScanConditions {
  const profile = conditionsProfile(conditions.automation);
  const chromiumVersion = safeChromiumVersion(conditions.chromiumVersion);
  const userAgent = safeChromiumUserAgent(conditions.userAgent);
  const timezone = profile === "brave-pagegraph" ? "unknown" : conditions.timezone === "UTC" ? "UTC" : "unknown";
  const locale = profile === "brave-pagegraph" ? "unknown" : conditions.locale === "en-US" ? "en-US" : "unknown";
  const language = profile === "brave-pagegraph" ? "unknown" : conditions.language === "en-US" ? "en-US" : "unknown";
  const scannerEgress = safeScannerEgress(profile, conditions.scannerEgress);
  const shieldsMode: NonNullable<ScanConditions["shieldsMode"]> =
    conditions.shieldsMode === "block-simulation" ? "block-simulation" : "classification";
  const disclosureInput = { chromiumVersion, locale, scannerEgress, shieldsMode, timezone };
  const currentDisclosure = scannerDisclosure(profile, disclosureInput);
  const historicalDisclosure = historicalNodeScannerDisclosure(
    profile,
    disclosureInput,
    conditions.scannerDisclosure
  );
  const legacyDisclosure = legacyNodeScannerDisclosure(profile, disclosureInput);
  const scannerDisclosureValue =
    conditions.scannerDisclosure === currentDisclosure ||
    conditions.scannerDisclosure === historicalDisclosure ||
    conditions.scannerDisclosure === legacyDisclosure
      ? conditions.scannerDisclosure
      : INVALID_METHODOLOGY_DISCLOSURE;
  const adblock = conditions.adblock === undefined
    ? undefined
    : {
        active: conditions.adblock.active === true,
        source: conditions.adblock.source === SAFE_ADBLOCK_SOURCE ? SAFE_ADBLOCK_SOURCE : REDACTED_PUBLIC_STRING,
        lists:
          Number.isSafeInteger(conditions.adblock.lists) && conditions.adblock.lists >= 0 && conditions.adblock.lists <= 100
            ? conditions.adblock.lists
            : 0,
        fetchedAt: canonicalTimestamp(conditions.adblock.fetchedAt) ?? "unknown"
      };
  return {
    requestedUrl: pass.url(conditions.requestedUrl, false),
    finalUrl: pass.url(conditions.finalUrl, false),
    scannedAt: canonicalTimestamp(conditions.scannedAt) ?? "1970-01-01T00:00:00.000Z",
    chromiumVersion,
    userAgent,
    timezone,
    locale,
    language,
    viewport: {
      width: boundedViewportDimension(conditions.viewport.width, 1440),
      height: boundedViewportDimension(conditions.viewport.height, 980),
      isMobile: conditions.viewport.isMobile === true
    },
    gpcEnabled: conditions.gpcEnabled === true,
    consentMode: ["observe", "accept-all", "reject-all"].includes(conditions.consentMode)
      ? conditions.consentMode
      : "observe",
    automation:
      profile === "node-playwright" ? "playwright-chromium" : profile === "brave-pagegraph" ? "brave-pagegraph" : "external",
    headless: conditions.headless === true,
    scannerEgress,
    ...(conditions.shieldsMode !== undefined ? { shieldsMode } : {}),
    ...(adblock !== undefined ? { adblock } : {}),
    trackerCatalog: safeTrackerCatalog(profile, conditions.trackerCatalog),
    scannerDisclosure: scannerDisclosureValue
  };
}

function conditionsProfile(automation: ScanConditions["automation"]): ScanConditionsProfile {
  if (automation === "playwright-chromium") return "node-playwright";
  if (automation === "brave-pagegraph") return "brave-pagegraph";
  return "cloudflare-browser-run";
}

function safeChromiumVersion(value: string): string {
  const normalized = value.trim();
  return normalized === "unknown" || normalized === "test" || CHROMIUM_VERSION.test(normalized) ? normalized : "unknown";
}

function safeChromiumUserAgent(value: string): string {
  const normalized = value.trim();
  return normalized === "unknown" || normalized === "test" || CHROMIUM_USER_AGENT.test(normalized) ? normalized : "unknown";
}

function safeScannerEgress(profile: ScanConditionsProfile, value: string): string {
  if (profile === "brave-pagegraph") return "Brave PageGraph crawl";
  if (profile === "cloudflare-browser-run") return "cloudflare-browser-run";
  return SAFE_SCANNER_EGRESS.has(value) ? value : "this scanner instance";
}

function safeTrackerCatalog(
  profile: ScanConditionsProfile,
  declared: ScanConditions["trackerCatalog"]
): ScanConditions["trackerCatalog"] {
  if (profile === "cloudflare-browser-run") {
    return {
      source: "none",
      version: "cloudflare-worker-2026.06",
      region: "n/a",
      entries: 0,
      curatedOverrides: 0,
      license: "n/a"
    };
  }
  const current = {
    source: trackerCatalogMetadata.source,
    version: trackerCatalogMetadata.version,
    region: trackerCatalogMetadata.region,
    entries: trackerCatalogMetadata.entries,
    curatedOverrides: trackerCatalogMetadata.curatedOverrides,
    license: trackerCatalogMetadata.license
  };
  // Frozen v1 has no separate producer-contract epoch. Replacing an already
  // published catalog identity with today's catalog makes every historical
  // report non-idempotent and, worse, says old classifications used entries
  // that did not yet exist. Preserve only exact reviewed historical identities;
  // arbitrary self-declared metadata still canonicalizes to the current one.
  const reviewed = [current, ...HISTORICAL_TRACKER_CATALOGS].find(
    (candidate) => canonicalJson(candidate) === canonicalJson(declared)
  );
  return { ...(reviewed ?? current) };
}

function previousNodeScannerDisclosure(
  profile: ScanConditionsProfile,
  input: {
    chromiumVersion: string;
    locale: string;
    scannerEgress: string;
    shieldsMode?: ScanConditions["shieldsMode"];
    timezone: string;
  }
): string | null {
  if (profile !== "node-playwright") return null;
  const shieldsDescription = input.shieldsMode === "block-simulation" ? "block simulation" : "classification only";
  return `Automated Chromium scan from ${input.scannerEgress} with browser ${input.chromiumVersion}, timezone ${input.timezone}, locale ${input.locale}, the listed viewport, and Brave Shields ${shieldsDescription}. Brave-list matching uses each route-evaluated request's initiating document (the parent document for a subframe navigation), under methodology ${NODE_SHIELDS_REQUEST_CONTEXT_VERSION}; main-frame navigations are not blocked or counted as matches, and redirect follow-up URLs that Playwright does not re-route are not independently evaluated. Treat results as reproducible evidence for this scan configuration, not a universal claim about all visitors.`;
}

const CANONICAL_VERSION = String.raw`(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)`;
const HISTORICAL_NODE_METHOD_WITH_PLAYWRIGHT = new RegExp(
  String.raw` methodology (shields-request-context-v2-adblock-rust-${CANONICAL_VERSION}-request-method-v1-playwright-(${CANONICAL_VERSION}));`
);
const HISTORICAL_NODE_METHOD_PRE_PLAYWRIGHT = new RegExp(
  String.raw` methodology (shields-request-context-v2-adblock-rust-${CANONICAL_VERSION}-request-method-v1);`
);

function historicalNodeScannerDisclosure(
  profile: ScanConditionsProfile,
  input: {
    chromiumVersion: string;
    locale: string;
    scannerEgress: string;
    shieldsMode?: ScanConditions["shieldsMode"];
    timezone: string;
  },
  disclosure: string
): string | null {
  if (profile !== "node-playwright") return null;

  const withPlaywright = HISTORICAL_NODE_METHOD_WITH_PLAYWRIGHT.exec(disclosure);
  if (withPlaywright) {
    const methodologyVersion = withPlaywright[1];
    const playwrightVersion = withPlaywright[2];
    if (!methodologyVersion || !playwrightVersion) return null;
    const expected = scannerDisclosure(profile, input)
      .replace(`Playwright ${NODE_PLAYWRIGHT_VERSION}`, `Playwright ${playwrightVersion}`)
      .replace(NODE_SCANNER_METHODOLOGY_VERSION, methodologyVersion);
    return disclosure === expected ? disclosure : null;
  }

  const prePlaywright = HISTORICAL_NODE_METHOD_PRE_PLAYWRIGHT.exec(disclosure);
  if (prePlaywright) {
    const methodologyVersion = prePlaywright[1];
    const template = previousNodeScannerDisclosure(profile, input);
    if (!methodologyVersion || !template) return null;
    const expected = template.replace(NODE_SHIELDS_REQUEST_CONTEXT_VERSION, methodologyVersion);
    return disclosure === expected ? disclosure : null;
  }

  return null;
}

function legacyNodeScannerDisclosure(
  profile: ScanConditionsProfile,
  input: {
    chromiumVersion: string;
    locale: string;
    scannerEgress: string;
    shieldsMode?: ScanConditions["shieldsMode"];
    timezone: string;
  }
): string | null {
  if (profile !== "node-playwright") return null;
  const shieldsDescription = input.shieldsMode === "block-simulation" ? "block simulation" : "classification only";
  return `Automated Chromium scan from ${input.scannerEgress} with browser ${input.chromiumVersion}, timezone ${input.timezone}, locale ${input.locale}, the listed viewport, and Brave Shields ${shieldsDescription}. Treat results as reproducible evidence for this scan configuration, not a universal claim about all visitors.`;
}

function canonicalTimestamp(value: string): string | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? value : null;
}

function boundedViewportDimension(value: number, fallback: number): number {
  return Number.isSafeInteger(value) && value > 0 && value <= 10_000 ? value : fallback;
}

export function redactRequest(request: NetworkRequestRecord, pass: RedactionPass): NetworkRequestRecord {
  return {
    id: request.id,
    url: pass.url(request.url, request.thirdParty),
    domain: pass.hostname(request.domain),
    method: redactHttpMethod(request.method),
    resourceType: redactResourceType(request.resourceType),
    status: request.status,
    thirdParty: request.thirdParty,
    tracker: redactTrackerMatch(request.tracker, pass, request.domain),
    ...(request.blockedByShields !== undefined ? { blockedByShields: request.blockedByShields } : {}),
    ...(request.provenance ? { provenance: redactProvenance(request.provenance, pass) } : {}),
    startedAtMs: request.startedAtMs
  };
}

function redactProvenance(
  provenance: NetworkRequestProvenance,
  pass: RedactionPass
): NetworkRequestProvenance {
  return {
    ...(provenance.graphRecordId !== undefined
      ? { graphRecordId: pass.opaqueId(provenance.graphRecordId) }
      : {}),
    ...(provenance.initiatorId !== undefined
      ? { initiatorId: pass.opaqueId(provenance.initiatorId) }
      : {}),
    ...(provenance.initiatorType !== undefined
      ? { initiatorType: redactPageGraphInitiatorType(provenance.initiatorType) }
      : {}),
    ...(provenance.initiatorUrl !== undefined ? { initiatorUrl: pass.url(provenance.initiatorUrl, false) } : {}),
    ...(provenance.initiatorDomain !== undefined
      ? { initiatorDomain: pass.hostname(provenance.initiatorDomain) }
      : {}),
    ...(provenance.scriptId !== undefined ? { scriptId: pass.opaqueId(provenance.scriptId) } : {}),
    ...(provenance.scriptUrl !== undefined ? { scriptUrl: pass.url(provenance.scriptUrl, false) } : {}),
    ...(provenance.scriptDomain !== undefined ? { scriptDomain: pass.hostname(provenance.scriptDomain) } : {}),
    ...(provenance.injectedById !== undefined
      ? { injectedById: pass.opaqueId(provenance.injectedById) }
      : {}),
    ...(provenance.injectedByUrl !== undefined ? { injectedByUrl: pass.url(provenance.injectedByUrl, false) } : {}),
    ...(provenance.injectedByDomain !== undefined
      ? { injectedByDomain: pass.hostname(provenance.injectedByDomain) }
      : {})
  };
}

export function redactTrackerMatch(
  tracker: TrackerMatch | null,
  pass: RedactionPass,
  observedHost: string = tracker?.domain ?? ""
): TrackerMatch | null {
  if (tracker === null) return null;
  if (tracker.confidence === "curated") {
    const expected = observedHost.includes("{label}")
      ? markerAwareCuratedTrackerMatch(observedHost, tracker)
      : findTrackerMatch(observedHost);
    if (expected === null || canonicalJson(expected) !== canonicalJson(tracker)) return null;
  } else if (tracker.confidence === "shields-list") {
    const domain = publicRegistrableDomain(observedHost);
    if (domain === null) return null;
    const expected: TrackerMatch = {
      domain,
      entity: domain,
      category: "tracking (Brave Shields list)",
      confidence: "shields-list"
    };
    if (canonicalJson(expected) !== canonicalJson(tracker)) return null;
  } else {
    return null;
  }
  return {
    domain: pass.hostname(tracker.domain),
    entity: tracker.entity,
    category: tracker.category,
    confidence: tracker.confidence,
    ...(tracker.prevalence !== undefined ? { prevalence: tracker.prevalence } : {}),
    ...(tracker.fingerprinting !== undefined ? { fingerprinting: tracker.fingerprinting } : {}),
    ...(tracker.cookiePrevalence !== undefined ? { cookiePrevalence: tracker.cookiePrevalence } : {})
  };
}

function markerAwareCuratedTrackerMatch(observedHost: string, tracker: TrackerMatch): TrackerMatch | null {
  const publicObserved = redactHostnameV2(observedHost).value;
  for (const candidate of CURATED_TRACKER_MATCHES) {
    const publicCandidate: TrackerMatch = { ...candidate, domain: redactHostnameV2(candidate.domain).value };
    if (canonicalJson(publicCandidate) !== canonicalJson(tracker)) continue;
    if (publicObserved === publicCandidate.domain || publicObserved.endsWith(`.${publicCandidate.domain}`)) {
      return tracker;
    }
  }
  return null;
}

/** Page script can choose a custom Fetch method token; public wire is closed. */
export function redactHttpMethod(value: string): string {
  const normalized = value.trim().toUpperCase();
  return SAFE_HTTP_METHODS.has(normalized) ? normalized : "OTHER";
}

/** Resource types are producer vocabulary, never arbitrary page strings. */
export function redactResourceType(value: string): string {
  const normalized = value.trim().toLowerCase();
  return SAFE_RESOURCE_TYPES.has(normalized) ? normalized : "other";
}

export function redactCookie(cookie: CookieRecord, pass: RedactionPass): CookieRecord {
  return {
    name: pass.cookieName(cookie.name),
    domain: pass.hostname(cookie.domain),
    path: pass.path(cookie.path),
    sameSite: redactCookieSameSite(cookie.sameSite),
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    session: cookie.session,
    thirdParty: cookie.thirdParty
  };
}

export function redactStorage(entry: StorageRecord, pass: RedactionPass): StorageRecord {
  return { area: entry.area, key: pass.storageKey(entry.key), valueBytes: entry.valueBytes };
}

export function redactFingerprintDetection(
  detection: FingerprintDetectionSummary,
  pass: RedactionPass
): FingerprintDetectionSummary | null {
  const copied = cloneJson(detection);
  copied.count = safeCount(copied.count);
  if (copied.kind === "canvas-fingerprinting") {
    copied.evidence.readApis = closedEvidenceValues(copied.evidence.readApis, CANVAS_READ_APIS);
    copied.evidence.maxCanvasWidth = safeCount(copied.evidence.maxCanvasWidth);
    copied.evidence.maxCanvasHeight = safeCount(copied.evidence.maxCanvasHeight);
    copied.evidence.maxDistinctTextCharacters = safeCount(copied.evidence.maxDistinctTextCharacters);
    copied.evidence.maxTextWriteCalls = safeCount(copied.evidence.maxTextWriteCalls);
  } else if (copied.kind === "canvas-font-fingerprinting") {
    copied.evidence.measureTextCalls = safeCount(copied.evidence.measureTextCalls);
    copied.evidence.maxDistinctFonts = safeCount(copied.evidence.maxDistinctFonts);
    copied.evidence.maxDistinctTextSamples = safeCount(copied.evidence.maxDistinctTextSamples);
    copied.evidence.maxTextLength = safeCount(copied.evidence.maxTextLength);
  } else if (copied.kind === "webgl-fingerprinting") {
    copied.evidence.readApis = closedEvidenceValues(copied.evidence.readApis, WEBGL_READ_APIS);
    copied.evidence.parameters = closedEvidenceValues(copied.evidence.parameters, WEBGL_PARAMETERS);
    copied.evidence.getParameterCalls = safeCount(copied.evidence.getParameterCalls);
    copied.evidence.readPixelsCalls = safeCount(copied.evidence.readPixelsCalls);
  } else if (copied.kind === "audio-fingerprinting") {
    copied.evidence.apis = closedEvidenceValues(copied.evidence.apis, AUDIO_FINGERPRINT_APIS);
    copied.evidence.offlineRenderCalls = safeCount(copied.evidence.offlineRenderCalls);
    copied.evidence.oscillatorCalls = safeCount(copied.evidence.oscillatorCalls);
    copied.evidence.compressorCalls = safeCount(copied.evidence.compressorCalls);
    copied.evidence.analyserCalls = safeCount(copied.evidence.analyserCalls);
  } else if (copied.kind === "webrtc-fingerprinting") {
    copied.evidence.constructorCalls = safeCount(copied.evidence.constructorCalls);
    copied.evidence.createDataChannelCalls = safeCount(copied.evidence.createDataChannelCalls);
    copied.evidence.createOfferCalls = safeCount(copied.evidence.createOfferCalls);
    copied.evidence.setLocalDescriptionCalls = safeCount(copied.evidence.setLocalDescriptionCalls);
  } else if (copied.kind === "session-recording") {
    copied.evidence.eventTypes = closedEvidenceValues(copied.evidence.eventTypes, SESSION_RECORDING_EVENTS, true);
    copied.evidence.listenerTargets = closedEvidenceValues(copied.evidence.listenerTargets, LISTENER_TARGETS, true);
    copied.evidence.thirdPartyOrigins = copied.evidence.thirdPartyOrigins.map((origin) =>
      pass.originOrHostname(origin)
    );
    copied.evidence.totalListenerCalls = safeCount(copied.evidence.totalListenerCalls);
  } else if (copied.kind === "input-monitoring") {
    copied.evidence.eventTypes = closedEvidenceValues(copied.evidence.eventTypes, INPUT_MONITORING_EVENTS, true);
    copied.evidence.listenerTargets = closedEvidenceValues(copied.evidence.listenerTargets, LISTENER_TARGETS, true);
    copied.evidence.thirdPartyOrigins = copied.evidence.thirdPartyOrigins.map((origin) =>
      pass.originOrHostname(origin)
    );
    copied.evidence.totalListenerCalls = safeCount(copied.evidence.totalListenerCalls);
  } else if (copied.kind === "keystroke-exfiltration") {
    copied.evidence.recipients = copied.evidence.recipients.map((recipient) => pass.hostname(recipient));
    copied.evidence.encodings = closedEvidenceValues(copied.evidence.encodings, KEYSTROKE_ENCODINGS, true);
    copied.evidence.fieldsTyped = safeCount(copied.evidence.fieldsTyped);
    copied.evidence.fieldTypes = closedEvidenceValues(copied.evidence.fieldTypes, KEYSTROKE_FIELD_TYPES, true);
  } else {
    return null;
  }
  return isFingerprintDetectionSummary(copied) ? copied : null;
}

function redactFingerprintEvents(events: FingerprintEventSummary[]): FingerprintEventSummary[] {
  const counts = new Map<string, number>();
  const allowed = new Set<string>(FINGERPRINT_EVENT_APIS);
  for (const event of events) {
    const api = allowed.has(event.api) ? event.api : "other";
    const count = safeCount(event.count);
    if (count > 0) counts.set(api, (counts.get(api) ?? 0) + count);
  }
  return Array.from(counts, ([api, count]) => ({ api, count })).sort((left, right) => left.api.localeCompare(right.api));
}

function closedEvidenceValues(values: string[], allowed: readonly string[], generalizeUnknown = false): string[] {
  const registry = new Set(allowed);
  return Array.from(new Set(values.flatMap((value) => registry.has(value) ? [value] : generalizeUnknown ? ["other"] : []))).sort();
}

function safeCount(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

export function redactPrivacyPolicy(
  policy: PrivacyPolicySummary,
  pass: RedactionPass,
  groundedEntities: ReadonlySet<string> = new Set()
): PrivacyPolicySummary {
  const claimKinds = new Set<string>();
  const claims = policy.claims.flatMap((claim) => {
    if (!KNOWN_POLICY_CLAIM_KINDS.has(claim.kind) || claimKinds.has(claim.kind)) return [];
    claimKinds.add(claim.kind);
    return [{ kind: claim.kind, quote: boundedPublicText(claim.quote, MAX_POLICY_QUOTE_CHARS) }];
  });
  const mentionedEntities = uniqueGroundedEntities(policy.mentionedEntities, groundedEntities);
  const mentionedSet = new Set(mentionedEntities);
  const unmentionedEntities = uniqueGroundedEntities(policy.unmentionedEntities, groundedEntities)
    .filter((entity) => !mentionedSet.has(entity));
  return {
    url: pass.url(policy.url, false),
    claims,
    mentionedEntities,
    unmentionedEntities,
    policyTextLength: validPolicyTextLength(policy.policyTextLength)
      ? Math.min(policy.policyTextLength, MAX_POLICY_TEXT_CHARS)
      : MIN_POLICY_TEXT_LENGTH
  };
}

function uniqueGroundedEntities(values: string[], grounded: ReadonlySet<string>): string[] {
  return Array.from(new Set(values.filter((entity) => grounded.has(entity))));
}

function validPolicyTextLength(value: number): boolean {
  return Number.isSafeInteger(value) && value >= MIN_POLICY_TEXT_LENGTH;
}

export function redactConsentInteraction(
  interaction: ConsentInteractionSummary,
  pass: RedactionPass
): ConsentInteractionSummary {
  const cmpEntry = interaction.cmp
    ? CONSENT_CMP_SELECTORS.find((entry) => entry.cmp === interaction.cmp)
    : undefined;
  const allowedSelectors = cmpEntry
    ? interaction.mode === "accept-all"
      ? cmpEntry.accept
      : cmpEntry.reject
    : [];

  return {
    mode: interaction.mode,
    clicked: interaction.clicked,
    ...(interaction.cmp !== undefined
      ? {
          cmp:
            interaction.cmp === REDACTED_PUBLIC_STRING || KNOWN_CMP_NAMES.has(interaction.cmp)
              ? interaction.cmp
              : REDACTED_PUBLIC_STRING
        }
      : {}),
    ...(interaction.selector !== undefined
      ? {
          selector:
            interaction.selector === REDACTED_PUBLIC_STRING || allowedSelectors.includes(interaction.selector)
              ? interaction.selector
              : REDACTED_PUBLIC_STRING
        }
      : {}),
    ...(interaction.matchedText !== undefined
      ? { matchedText: redactConsentMatchedText(interaction.mode, interaction.matchedText) }
      : {}),
    ...(interaction.frameUrl !== undefined ? { frameUrl: pass.url(interaction.frameUrl, false) } : {})
  };
}

function redactConsentMatchedText(
  mode: ConsentInteractionSummary["mode"],
  value: string
): string {
  if (value === REDACTED_PUBLIC_STRING) return value;
  const normalized = normalizeConsentLabel(value);
  return isPublicConsentMatchedText(mode, normalized) ? normalized : REDACTED_PUBLIC_STRING;
}

function isPublicConsentMatchedText(
  mode: ConsentInteractionSummary["mode"],
  normalized: string
): boolean {
  return (
    matchesConsentChoice(mode, normalized) ||
    LEGACY_PUBLIC_CONSENT_MATCHED_TEXT[mode].includes(normalized)
  );
}

export function redactCookieSameSite(value: string): string {
  const normalized = value.trim();
  return SAFE_COOKIE_SAME_SITE.has(normalized) ? normalized : "Unspecified";
}

function redactPageGraphInitiatorType(value: string): string {
  return PAGEGRAPH_INITIATOR_TYPES.has(value) ? value : REDACTED_PUBLIC_STRING;
}

/**
 * The r2 producer uses this before generalization so unknown producer
 * vocabulary cannot disappear while its detector still claims completeness.
 */
export function assertKnownPixelEventVocabulary(event: PixelEventSummary): void {
  const catalog = pixelCatalogFor(event.platform);
  if (!catalog || event.product !== catalog.product) {
    throw new Error("Unknown pixel platform or product vocabulary.");
  }
  for (const field of event.advancedMatching) {
    if (!KNOWN_PIXEL_MATCH_FIELDS.has(field)) throw new Error(`Unknown pixel advanced-matching field: ${field}`);
  }
  if (!Number.isSafeInteger(event.requests) || event.requests <= 0) {
    throw new Error("Pixel request count must be a positive integer.");
  }
}

export function redactPixelEvents(events: PixelEventSummary[]): PixelEventSummary[] {
  const redacted: PixelEventSummary[] = [];

  for (const event of events) {
    const catalog = pixelCatalogFor(event.platform);
    if (!catalog) continue;
    const allowedEvents = catalog.events as ReadonlySet<string>;
    const sanitizedEvents = Array.from(
      new Set(event.events.map((name) => (allowedEvents.has(name) ? name : "custom event")))
    ).sort((a, b) => a.localeCompare(b));
    const advancedMatching = Array.from(
      new Set(event.advancedMatching.filter((field) => KNOWN_PIXEL_MATCH_FIELDS.has(field)))
    );

    redacted.push({
      platform: event.platform,
      product: catalog.product,
      events: sanitizedEvents,
      advancedMatching,
      requests: Number.isFinite(event.requests) ? Math.max(0, Math.floor(event.requests)) : 0
    });
  }

  return redacted;
}

function copyValidatedShare(share: ReportShare | undefined): { share?: ReportShare } {
  if (!share || !isCanonicalReportShare(share)) return {};
  return { share: { ...share } };
}

/**
 * Admit only bounded scanner-owned warning vocabulary. Exported so every wire
 * generation applies the same default-deny warning boundary.
 */
export function redactScannerWarnings(warnings: string[], pass: RedactionPass): string[] {
  const redacted = new Set<string>();
  for (const warning of warnings) {
    const normalized = normalizePublicText(warning);
    const withoutEmails = normalized.replace(
      /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
      REDACTED_PUBLIC_STRING
    );
    const withSafeUrls = withoutEmails.replace(
      /(?:https?|blob):\/\/[^\s<>"']+/gi,
      (candidate) => redactWarningUrlToken(candidate, pass)
    );
    const bounded = capCharacters(withSafeUrls, MAX_WARNING_CHARS);
    redacted.add(isScannerWarning(bounded) ? bounded : REDACTED_WARNING);
  }
  return Array.from(redacted);
}

function redactWarningUrlToken(candidate: string, pass: RedactionPass): string {
  // Warning prose commonly wraps a URL in parentheses or ends a sentence
  // immediately after it. Keep that punctuation outside the URL parser.
  const match = candidate.match(/^(.*?)([),.;!?]+)?$/);
  const url = match?.[1] ?? candidate;
  const suffix = match?.[2] ?? "";
  return `${pass.url(url, false)}${suffix}`;
}

function isScannerWarning(warning: string): boolean {
  if (warning === REDACTED_WARNING || FIXED_SCANNER_WARNINGS.has(warning)) return true;

  const prefixEnd = warning.indexOf(": ");
  if (prefixEnd > 0 && COMPARISON_WARNING_LABELS.has(warning.slice(0, prefixEnd))) {
    return isScannerWarning(warning.slice(prefixEnd + 2));
  }

  if (/^The page returned HTTP [1-5][0-9]{2}; this report reflects an error or block page, not a normal load\.$/.test(warning)) {
    return true;
  }
  if (/^The scan stopped recording or loading additional requests after [0-9]+ requests\.$/.test(warning)) {
    return true;
  }
  if (
    /^The scan stopped loading additional response bytes after reaching the [0-9]+ MiB aggregate response-byte budget\.$/.test(
      warning
    )
  ) {
    return true;
  }
  if (
    /^The scan stopped forwarding additional request bytes after reaching the [0-9]+ MiB aggregate upload-byte budget\.$/.test(
      warning
    )
  ) {
    return true;
  }
  if (/^Skipped PageGraph request [0-9]+ because its URL was not HTTP\(S\)\.$/.test(warning)) {
    return true;
  }
  // Both CNAME sentence generations are admitted: the grammatical singular
  // emitted today, and the older "1 ... that are" form carried by committed
  // corpus reports, which remediation replays must keep intact.
  if (/^Resolved (?:1 first-party subdomain that (?:is a CNAME alias for a third-party tracker|are CNAME aliases for third-party trackers)|[0-9]+ first-party subdomains that are CNAME aliases for third-party trackers) \(CNAME cloaking\), which request-URL matching alone would miss\.$/.test(warning)) {
    return true;
  }
  if (/^This scan typed a synthetic test value into (?:1 form field|[0-9]+ form fields) \(never submitting the form\) to test whether typed input is captured and sent to third parties\. The value is synthetic and is not stored\.(?: Requests the page sent during and after this typing, including any unload beacons, are part of the recorded request log and counts\.| Requests from this incomplete probe were omitted from the recorded request log and counts\.)?$/.test(warning)) {
    return true;
  }

  // Counterbalancing disclosure: the label must be a known run label, so a
  // page-controlled string can never ride a look-alike sentence through.
  const orderDisclosure = warning.match(/^The two visits ran in randomized order; the "([^"]+)" visit ran first\.$/);
  if (orderDisclosure && COMPARISON_WARNING_LABELS.has(orderDisclosure[1])) return true;

  const blocked = warning.match(
    /^(?:Blocked a non-HTTP\(S\) request|Blocked a request that could not be verified as public|Blocked a request that could not be verified as a public HTTP\(S\) URL): (.+)$/
  );
  if (blocked && isAlreadyRedactedUrl(blocked[1])) return true;

  const policy = warning.match(
    /^Read the site's privacy policy \((.+)\) and compared its text against this visit's observed behavior\. Policy checks are an automated text match with the matched sentences quoted, not a legal reading\.$/
  );
  if (policy && isAlreadyRedactedUrl(policy[1])) return true;

  return isGeneratedConsentWarning(warning);
}

function isAlreadyRedactedUrl(value: string): boolean {
  return redactUrlV2(value).value === value;
}

function isGeneratedConsentWarning(warning: string): boolean {
  for (const mode of ["accept-all", "reject-all"] as const) {
    // Every un-clicked variant, not just the default. The three failure
    // sentences are the ones that say the instrument failed rather than the
    // site; admitting only the default replaced exactly those with
    // "[redacted warning]" and left the reader with no disclosure at all.
    for (const failure of CONSENT_PROBE_OUTCOMES) {
      if (warning === consentInteractionWarning({ mode, clicked: false }, failure)) return true;
    }
    for (const cmp of KNOWN_CMP_NAMES) {
      if (warning === consentInteractionWarning({ mode, clicked: true, cmp })) return true;
    }

    const matched = warning.match(/on a control labeled "([^"]+)" after page load/);
    if (!matched) continue;
    const label = normalizeConsentLabel(matched[1]);
    if (
      isPublicConsentMatchedText(mode, label) &&
      warning === consentInteractionWarning({ mode, clicked: true, matchedText: label })
    ) {
      return true;
    }
  }
  return false;
}

function boundedPublicText(value: string, maxChars: number): string {
  return capCharacters(normalizePublicText(value), maxChars);
}

function normalizePublicText(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function capCharacters(value: string, maxChars: number): string {
  const characters = Array.from(value);
  return characters.length <= maxChars ? value : characters.slice(0, maxChars).join("");
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
