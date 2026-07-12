import { compareScanResults } from "./compare-reports";
import {
  CONSENT_CMP_SELECTORS,
  consentInteractionWarning,
  matchesConsentChoice,
  normalizeConsentLabel
} from "./consent-interaction";
import { summarizeDomains } from "./domain-summaries";
import {
  addRedactionCounters,
  emptyRedactionCounters,
  redactCookieName,
  redactHostnameV2,
  redactPathV2,
  redactStorageKey,
  redactUrlV2,
  type RedactionCounters
} from "./redaction-v2";
import { isCanonicalReportShare } from "./report-locator";
import type {
  ComparisonScanResult,
  ConsentInteractionSummary,
  CookieRecord,
  FingerprintDetectionSummary,
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

const MAX_PAGE_TITLE_CHARS = 200;
const MAX_POLICY_QUOTE_CHARS = 200;
const MAX_WARNING_CHARS = 600;
const MAX_COMPARISON_TITLE_CHARS = 160;
const MAX_RUN_LABEL_CHARS = 80;
const INVALID_OPAQUE_ID_MARKER = "{invalid-id}";
const REDACTED_PUBLIC_STRING = "[redacted]";
const REDACTED_WARNING = "[redacted warning]";

// PageGraph node/edge ids are producer-generated opaque join keys. Preserve
// their graph utility only when they stay inside the documented ASCII token
// envelope; never pass URLs, paths, email-like strings, controls, or unbounded
// input through an id field. The marker is terminal for repeat boundaries.
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const KNOWN_CMP_NAMES = new Set(CONSENT_CMP_SELECTORS.map((entry) => entry.cmp));
const KNOWN_PIXEL_MATCH_FIELDS = new Set([
  "email",
  "phone",
  "name",
  "address",
  "date_of_birth",
  "gender",
  "external_id"
]);

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
  "Blocked one or more requests that resolved to local or private network addresses at connection time.",
  "Blocked additional non-HTTP(S) requests. Only the first 5 examples are shown.",
  "Blocked additional requests that could not be verified as public. Only the first 5 examples are shown.",
  "Shareable report could not be saved on this host; JSON export is still available.",
  "This report was adapted from Brave PageGraph-derived observations. Treat it as evidence for the recorded crawl conditions, not a universal claim about all visitors.",
  "No PageGraph request provenance was supplied. This report can show observed requests but not script-to-request causality.",
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
    warnings: redactWarnings(report.warnings, pass),
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
  const fingerprintEvents = result.fingerprintEvents.map((event) => ({ ...event }));
  const fingerprintDetections = result.fingerprintDetections?.map((detection) =>
    redactFingerprintDetection(detection, pass)
  );

  const redacted: ScanResult = {
    ok: true,
    schemaVersion: result.schemaVersion,
    ...(result.reportType !== undefined ? { reportType: "single" as const } : {}),
    summary: {
      pageTitle: boundedPublicText(result.summary.pageTitle, MAX_PAGE_TITLE_CHARS),
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
    ...(result.cnameCloaks !== undefined
      ? {
          cnameCloaks: result.cnameCloaks.map((cloak) => ({
            host: pass.hostname(cloak.host),
            cname: pass.hostname(cloak.cname),
            tracker: redactTracker(cloak.tracker, pass) as TrackerMatch
          }))
        }
      : {}),
    ...(result.pixelEvents !== undefined
      ? { pixelEvents: redactPixelEvents(result.pixelEvents) }
      : {}),
    ...(result.privacyPolicy !== undefined
      ? { privacyPolicy: redactPrivacyPolicy(result.privacyPolicy, pass) }
      : {}),
    ...(result.consentInteraction !== undefined
      ? { consentInteraction: redactConsentInteraction(result.consentInteraction, pass) }
      : {}),
    // The immediate result may intentionally retain a screenshot for the
    // submitter. Persistence/export projectors strip it at their own boundary.
    screenshot: result.screenshot,
    warnings: redactWarnings(result.warnings, pass),
    ...copyValidatedShare(result.share)
  };

  return { report: redacted, counters: pass.counters };
}

class RedactionPass {
  readonly counters = emptyRedactionCounters();

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

  originOrHostname(value: string): string {
    return /^https?:\/\//i.test(value) ? this.url(value, false) : this.hostname(value);
  }
}

function redactConditions(conditions: ScanConditions, pass: RedactionPass): ScanConditions {
  return {
    requestedUrl: pass.url(conditions.requestedUrl, false),
    finalUrl: pass.url(conditions.finalUrl, false),
    scannedAt: conditions.scannedAt,
    chromiumVersion: conditions.chromiumVersion,
    userAgent: conditions.userAgent,
    timezone: conditions.timezone,
    locale: conditions.locale,
    language: conditions.language,
    viewport: { ...conditions.viewport },
    gpcEnabled: conditions.gpcEnabled,
    consentMode: conditions.consentMode,
    automation: conditions.automation,
    headless: conditions.headless,
    scannerEgress: conditions.scannerEgress,
    ...(conditions.shieldsMode !== undefined ? { shieldsMode: conditions.shieldsMode } : {}),
    ...(conditions.adblock !== undefined ? { adblock: { ...conditions.adblock } } : {}),
    trackerCatalog: { ...conditions.trackerCatalog },
    scannerDisclosure: conditions.scannerDisclosure
  };
}

function redactRequest(request: NetworkRequestRecord, pass: RedactionPass): NetworkRequestRecord {
  return {
    id: request.id,
    url: pass.url(request.url, request.thirdParty),
    domain: pass.hostname(request.domain),
    method: request.method,
    resourceType: request.resourceType,
    status: request.status,
    thirdParty: request.thirdParty,
    tracker: redactTracker(request.tracker, pass),
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
      ? { graphRecordId: redactOpaqueId(provenance.graphRecordId) }
      : {}),
    ...(provenance.initiatorId !== undefined
      ? { initiatorId: redactOpaqueId(provenance.initiatorId) }
      : {}),
    ...(provenance.initiatorType !== undefined
      ? { initiatorType: boundedProducerToken(provenance.initiatorType) }
      : {}),
    ...(provenance.initiatorUrl !== undefined ? { initiatorUrl: pass.url(provenance.initiatorUrl, false) } : {}),
    ...(provenance.initiatorDomain !== undefined
      ? { initiatorDomain: pass.hostname(provenance.initiatorDomain) }
      : {}),
    ...(provenance.scriptId !== undefined ? { scriptId: redactOpaqueId(provenance.scriptId) } : {}),
    ...(provenance.scriptUrl !== undefined ? { scriptUrl: pass.url(provenance.scriptUrl, false) } : {}),
    ...(provenance.scriptDomain !== undefined ? { scriptDomain: pass.hostname(provenance.scriptDomain) } : {}),
    ...(provenance.injectedById !== undefined
      ? { injectedById: redactOpaqueId(provenance.injectedById) }
      : {}),
    ...(provenance.injectedByUrl !== undefined ? { injectedByUrl: pass.url(provenance.injectedByUrl, false) } : {}),
    ...(provenance.injectedByDomain !== undefined
      ? { injectedByDomain: pass.hostname(provenance.injectedByDomain) }
      : {})
  };
}

function redactTracker(tracker: TrackerMatch | null, pass: RedactionPass): TrackerMatch | null {
  if (tracker === null) return null;
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

function redactCookie(cookie: CookieRecord, pass: RedactionPass): CookieRecord {
  return {
    name: pass.cookieName(cookie.name),
    domain: pass.hostname(cookie.domain),
    path: pass.path(cookie.path),
    sameSite: cookie.sameSite,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    session: cookie.session,
    thirdParty: cookie.thirdParty
  };
}

function redactStorage(entry: StorageRecord, pass: RedactionPass): StorageRecord {
  return { area: entry.area, key: pass.storageKey(entry.key), valueBytes: entry.valueBytes };
}

function redactFingerprintDetection(
  detection: FingerprintDetectionSummary,
  pass: RedactionPass
): FingerprintDetectionSummary {
  const copied = cloneJson(detection);
  if (copied.kind === "session-recording" || copied.kind === "input-monitoring") {
    copied.evidence.thirdPartyOrigins = copied.evidence.thirdPartyOrigins.map((origin) =>
      pass.originOrHostname(origin)
    );
  } else if (copied.kind === "keystroke-exfiltration") {
    copied.evidence.recipients = copied.evidence.recipients.map((recipient) => pass.hostname(recipient));
  }
  return copied;
}

function redactPrivacyPolicy(policy: PrivacyPolicySummary, pass: RedactionPass): PrivacyPolicySummary {
  return {
    url: pass.url(policy.url, false),
    claims: policy.claims.map((claim) => ({
      kind: claim.kind,
      quote: boundedPublicText(claim.quote, MAX_POLICY_QUOTE_CHARS)
    })),
    mentionedEntities: [...policy.mentionedEntities],
    unmentionedEntities: [...policy.unmentionedEntities],
    policyTextLength: policy.policyTextLength
  };
}

function redactConsentInteraction(
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
  return matchesConsentChoice(mode, normalized) ? normalized : REDACTED_PUBLIC_STRING;
}

function redactOpaqueId(value: string): string {
  if (value === INVALID_OPAQUE_ID_MARKER) return value;
  return OPAQUE_ID.test(value) ? value : INVALID_OPAQUE_ID_MARKER;
}

function boundedProducerToken(value: string): string {
  if (value === REDACTED_PUBLIC_STRING) return value;
  return /^[A-Za-z][A-Za-z0-9 ._:-]{0,79}$/.test(value)
    ? value
    : REDACTED_PUBLIC_STRING;
}

function redactPixelEvents(events: PixelEventSummary[]): PixelEventSummary[] {
  const redacted: PixelEventSummary[] = [];

  for (const event of events) {
    const catalog = PIXEL_PRODUCTS[event.platform as keyof typeof PIXEL_PRODUCTS];
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

function redactWarnings(warnings: string[], pass: RedactionPass): string[] {
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
  if (/^Skipped PageGraph request [0-9]+ because its URL was not HTTP\(S\)\.$/.test(warning)) {
    return true;
  }
  if (/^Resolved (?:1 first-party subdomain|[0-9]+ first-party subdomains) that are CNAME aliases for third-party trackers \(CNAME cloaking\), which request-URL matching alone would miss\.$/.test(warning)) {
    return true;
  }
  if (/^This scan typed a synthetic test value into (?:1 form field|[0-9]+ form fields) \(never submitting the form\) to test whether typed input is captured and sent to third parties\. The value is synthetic and is not stored\.(?: Requests the page sent during and after this typing, including any unload beacons, are part of the recorded request log and counts\.)?$/.test(warning)) {
    return true;
  }

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
    if (warning === consentInteractionWarning({ mode, clicked: false })) return true;
    for (const cmp of KNOWN_CMP_NAMES) {
      if (warning === consentInteractionWarning({ mode, clicked: true, cmp })) return true;
    }

    const matched = warning.match(/on a control labeled "([^"]+)" after page load/);
    if (!matched) continue;
    const label = normalizeConsentLabel(matched[1]);
    if (
      matchesConsentChoice(mode, label) &&
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
