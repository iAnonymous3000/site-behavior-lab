/**
 * FROZEN v1 wire types (ScanReport schema version 1). Per the accepted ScanReport v2
 * RFC (docs/scan-report-v2-rfc.md, sections 10.2 and 14), this module receives
 * security backports only: no shape changes and no new fields of any kind (the
 * once-floated v1 `redactionVersion` marker is withdrawn; redaction provenance is
 * tracked outside the wire, RFC 15.8). New schema work happens in
 * lib/scan-report-v2.ts.
 */
export type ScanDevice = "desktop" | "mobile";
// "observe" never touches the consent banner (the default; everything recorded is
// pre-consent). "accept-all"/"reject-all" dispatch that click on the banner when a
// recognizable control exists; the visit's recording still spans before and
// after the click, and the site's registered consent state is not verified.
export type ConsentMode = "observe" | "accept-all" | "reject-all";
export type ScanAutomation = "playwright-chromium" | "brave-pagegraph" | "external";
export type ComparisonType = "gpc" | "shields" | "consent" | "temporal" | "custom";
export const SCAN_REPORT_SCHEMA_VERSION = 1 as const;
export type ScanReportSchemaVersion = typeof SCAN_REPORT_SCHEMA_VERSION;

export type ScanRequestPayload = {
  url: string;
  device: ScanDevice;
  gpcEnabled: boolean;
  consentMode: ConsentMode;
};

export type ReportShare = {
  id: string;
  path: string;
  jsonPath: string;
};

export type TrackerMatch = {
  domain: string;
  entity: string;
  category: string;
  // "curated": named entry in the hand-curated catalog. "shields-list": matched
  // only by the Brave Shields ad-block engine (broader coverage, no curated name).
  confidence: "curated" | "shields-list";
  prevalence?: number;
  fingerprinting?: number;
  cookiePrevalence?: number;
};

/**
 * A CNAME-cloaked tracker: a first-party-looking subdomain the page contacted
 * (`host`) that is a DNS CNAME alias for a third-party tracking service
 * (`tracker`, reached via `cname`), which request-URL matching alone misses.
 */
export type CnameCloak = {
  host: string;
  cname: string;
  tracker: TrackerMatch;
};

// This docblock is the FROZEN v2 r1/r2 schema description and must not
// change (see the RFC errata, E1: "never reads" overstates the transient
// non-emptiness check; the accurate wording lives in lib/pixel-events.ts).
/**
 * A personal-data category an advertising pixel attached to its events
 * ("advanced matching" in Meta's terms). Detected by parameter-key presence
 * only: the scanner never reads, decodes, or stores the (usually hashed) value.
 */
export type PixelMatchField = "email" | "phone" | "name" | "address" | "date_of_birth" | "gender" | "external_id";

/**
 * Pixel-level event analysis for one advertising platform observed in a visit.
 *
 * Goes beyond catalogue presence ("a Meta pixel loaded") to the events the pixel
 * actually fired (PageView, Purchase, ...) and whether it carried personal
 * identifiers. Event names are site configuration, not visitor PII, so they are
 * stored verbatim; identifier categories are stored as field labels only, never
 * values.
 */
export type PixelEventSummary = {
  /** Catalogue entity name (e.g. "Meta"), aligned with HEADLINE_PLATFORMS. */
  platform: string;
  /** Human-facing pixel product name (e.g. "Meta Pixel"). */
  product: string;
  /** Event names observed (configuration signals, never visitor PII). */
  events: string[];
  /** Personal-data categories attached, detected by key presence only. */
  advancedMatching: PixelMatchField[];
  /** Pixel requests observed for this platform in this visit. */
  requests: number;
};

/**
 * A specific, checkable statement found in the site's privacy policy by a
 * conservative sentence-level text match. `quote` is the matched sentence
 * (capped) so a reader can verify the match in context; this is an automated
 * text match, never a legal reading of the policy.
 */
export type PrivacyPolicyClaimKind = "no-cookies" | "no-third-party-cookies" | "no-selling-or-sharing" | "honors-gpc";

export type PrivacyPolicyClaim = {
  kind: PrivacyPolicyClaimKind;
  quote: string;
};

/**
 * What the scanner found when it read the site's own privacy policy and
 * compared it against the observed evidence. Best-effort and Node-scanner only:
 * the policy page is discovered from the scanned page's links and fetched
 * through the same SSRF-guarded browser context.
 */
export type PrivacyPolicySummary = {
  /** Redacted URL of the policy page that was read. */
  url: string;
  /** Checkable statements matched in the policy text. */
  claims: PrivacyPolicyClaim[];
  /** Observed tracking companies whose name (or alias) appears in the policy. */
  mentionedEntities: string[];
  /** Observed tracking companies never named in the policy text. */
  unmentionedEntities: string[];
  /** Characters of policy text analyzed (evidence the fetch worked). */
  policyTextLength: number;
};

/**
 * What happened when the scanner was asked to click a consent-banner choice
 * ("accept-all" / "reject-all"). `clicked: false` means no recognizable control
 * was found, so that visit still reflects the PRE-consent state and no claim may
 * be made about the site's post-choice behavior. `matchedText` only ever holds a
 * label that matched the scanner's own conservative accept/reject phrase list,
 * never arbitrary page text.
 */
export type ConsentInteractionSummary = {
  mode: Exclude<ConsentMode, "observe">;
  clicked: boolean;
  /** Consent platform name when a known CMP selector matched (e.g. "OneTrust"). */
  cmp?: string;
  /** The CSS selector that matched, when a known CMP control was clicked. */
  selector?: string;
  /** The visible control label, when the generic accept/reject text match clicked it. */
  matchedText?: string;
  /** Redacted URL of the (i)frame the control was found in, when not the main frame. */
  frameUrl?: string;
};

export type NetworkRequestRecord = {
  /**
   * @minimum 1
   * @maximum 9007199254740991
   * @multipleOf 1
   */
  id: number;
  url: string;
  domain: string;
  method: string;
  resourceType: string;
  /**
   * @minimum 100
   * @maximum 599
   * @multipleOf 1
   */
  status: number | null;
  thirdParty: boolean;
  tracker: TrackerMatch | null;
  blockedByShields?: boolean;
  provenance?: NetworkRequestProvenance;
  /**
   * @minimum 0
   * @maximum 9007199254740991
   * @multipleOf 1
   */
  startedAtMs: number;
};

export type NetworkRequestProvenance = {
  graphRecordId?: string;
  initiatorId?: string;
  initiatorType?: string;
  initiatorUrl?: string;
  initiatorDomain?: string;
  scriptId?: string;
  scriptUrl?: string;
  scriptDomain?: string;
  injectedById?: string;
  injectedByUrl?: string;
  injectedByDomain?: string;
};

export type DomainSummary = {
  domain: string;
  requests: number;
  thirdParty: boolean;
  tracker: TrackerMatch | null;
  blockedByShields?: boolean;
  statuses: number[];
  resourceTypes: string[];
};

export type CookieRecord = {
  name: string;
  domain: string;
  path: string;
  sameSite: string;
  secure: boolean;
  httpOnly: boolean;
  session: boolean;
  thirdParty: boolean;
};

export type StorageRecord = {
  area: "localStorage" | "sessionStorage";
  key: string;
  valueBytes: number;
};

export type FingerprintEventSummary = {
  api: string;
  count: number;
};

export type CanvasFingerprintDetectionSummary = {
  kind: "canvas-fingerprinting";
  heuristic: "openwpm-canvas-v1";
  count: number;
  evidence: {
    readApis: string[];
    maxCanvasWidth: number;
    maxCanvasHeight: number;
    maxDistinctTextCharacters: number;
    maxTextWriteCalls: number;
  };
};

export type CanvasFontFingerprintDetectionSummary = {
  kind: "canvas-font-fingerprinting";
  heuristic: "canvas-font-probing-v1";
  count: number;
  evidence: {
    measureTextCalls: number;
    maxDistinctFonts: number;
    maxDistinctTextSamples: number;
    maxTextLength: number;
  };
};

export type WebglFingerprintDetectionSummary = {
  kind: "webgl-fingerprinting";
  heuristic: "webgl-entropy-read-v1";
  count: number;
  evidence: {
    readApis: string[];
    parameters: string[];
    getParameterCalls: number;
    readPixelsCalls: number;
  };
};

export type AudioFingerprintDetectionSummary = {
  kind: "audio-fingerprinting";
  heuristic: "audio-rendering-v1";
  count: number;
  evidence: {
    apis: string[];
    offlineRenderCalls: number;
    oscillatorCalls: number;
    compressorCalls: number;
    analyserCalls: number;
  };
};

export type WebrtcFingerprintDetectionSummary = {
  kind: "webrtc-fingerprinting";
  heuristic: "webrtc-peerconnection-v1";
  count: number;
  evidence: {
    constructorCalls: number;
    createDataChannelCalls: number;
    createOfferCalls: number;
    setLocalDescriptionCalls: number;
  };
};

export type SessionRecordingDetectionSummary = {
  kind: "session-recording";
  heuristic: "interaction-listener-coverage-v1";
  count: number;
  evidence: {
    eventTypes: string[];
    listenerTargets: string[];
    thirdPartyOrigins: string[];
    totalListenerCalls: number;
  };
};

export type InputMonitoringDetectionSummary = {
  kind: "input-monitoring";
  heuristic: "input-listener-coverage-v1";
  count: number;
  evidence: {
    eventTypes: string[];
    listenerTargets: string[];
    thirdPartyOrigins: string[];
    totalListenerCalls: number;
  };
};

/**
 * Active keystroke/input exfiltration: the scanner typed a unique synthetic
 * sentinel into form fields (never submitting), then observed that value leave
 * to a third party in a network request. Unlike the listener-coverage heuristics
 * above, this is direct evidence that typed input was captured and transmitted.
 */
export type KeystrokeExfiltrationDetectionSummary = {
  kind: "keystroke-exfiltration";
  heuristic: "input-sentinel-exfiltration-v1";
  count: number;
  evidence: {
    /** Third-party domains the sentinel was sent to. */
    recipients: string[];
    /** Encodings the sentinel appeared in (plain, base64, hex, sha256, ...). */
    encodings: string[];
    /** How many form fields the probe typed into. */
    fieldsTyped: number;
    /** The input types probed (text, email, password, search, ...). */
    fieldTypes: string[];
  };
};

export type FingerprintDetectionSummary =
  | CanvasFingerprintDetectionSummary
  | CanvasFontFingerprintDetectionSummary
  | WebglFingerprintDetectionSummary
  | AudioFingerprintDetectionSummary
  | WebrtcFingerprintDetectionSummary
  | SessionRecordingDetectionSummary
  | InputMonitoringDetectionSummary
  | KeystrokeExfiltrationDetectionSummary;

export type ScanConditions = {
  requestedUrl: string;
  finalUrl: string;
  scannedAt: string;
  chromiumVersion: string;
  userAgent: string;
  timezone: string;
  locale: string;
  language: string;
  viewport: {
    width: number;
    height: number;
    isMobile: boolean;
  };
  gpcEnabled: boolean;
  consentMode: ConsentMode;
  automation: ScanAutomation;
  headless: boolean;
  scannerEgress: string;
  shieldsMode?: "classification" | "block-simulation";
  adblock?: {
    active: boolean;
    source: string;
    lists: number;
    fetchedAt: string;
  };
  trackerCatalog: {
    source: string;
    version: string;
    region: string;
    entries: number;
    curatedOverrides: number;
    license: string;
  };
  scannerDisclosure: string;
};

export type ScanResult = {
  ok: true;
  schemaVersion: ScanReportSchemaVersion;
  reportType?: "single";
  summary: {
    pageTitle: string;
    status: number | null;
    durationMs: number;
    firstPartyDomain: string;
    totalRequests: number;
    thirdPartyRequests: number;
    knownTrackerRequests: number;
    thirdPartyDomains: number;
    cookies: number;
    thirdPartyCookies: number;
    storageEntries: number;
    fingerprintEvents: number;
    shieldsBlockedRequests?: number;
  };
  conditions: ScanConditions;
  requests: NetworkRequestRecord[];
  domains: DomainSummary[];
  cookies: CookieRecord[];
  storage: StorageRecord[];
  fingerprintEvents: FingerprintEventSummary[];
  fingerprintDetections?: FingerprintDetectionSummary[];
  cnameCloaks?: CnameCloak[];
  pixelEvents?: PixelEventSummary[];
  privacyPolicy?: PrivacyPolicySummary;
  consentInteraction?: ConsentInteractionSummary;
  screenshot: string | null;
  warnings: string[];
  share?: ReportShare;
};

export type ComparisonMetricDelta = {
  before: number;
  after: number;
  delta: number;
};

export type DomainChange = {
  domain: string;
  requests: number;
  tracker: TrackerMatch | null;
};

export type EntityChange = {
  entity: string;
  requests: number;
  domains: number;
};

export type ProvenanceChange = {
  domain: string;
  requests: number;
  tracker: TrackerMatch | null;
  initiator: string | null;
  script: string | null;
  injectedBy: string | null;
};

export type CookieChange = {
  name: string;
  domain: string;
  thirdParty: boolean;
};

export type StorageKeyChange = {
  area: StorageRecord["area"];
  key: string;
};

export type FingerprintingChange = {
  kind: FingerprintDetectionSummary["kind"];
  heuristic: string;
  count: number;
};

export type PixelEventChange = {
  platform: string;
  product: string;
  events: string[];
  advancedMatching: PixelMatchField[];
};

export type ComparisonDiff = {
  totalRequests: ComparisonMetricDelta;
  thirdPartyRequests: ComparisonMetricDelta;
  knownTrackerRequests: ComparisonMetricDelta;
  thirdPartyDomains: ComparisonMetricDelta;
  cookies: ComparisonMetricDelta;
  thirdPartyCookies: ComparisonMetricDelta;
  storageEntries: ComparisonMetricDelta;
  fingerprintEvents: ComparisonMetricDelta;
  shieldsBlockedRequests?: ComparisonMetricDelta;
  addedDomains: DomainChange[];
  removedDomains: DomainChange[];
  addedEntities: EntityChange[];
  removedEntities: EntityChange[];
  addedCookies: CookieChange[];
  removedCookies: CookieChange[];
  addedStorageKeys: StorageKeyChange[];
  removedStorageKeys: StorageKeyChange[];
  addedFingerprinting: FingerprintingChange[];
  removedFingerprinting: FingerprintingChange[];
  addedPixelEvents?: PixelEventChange[];
  removedPixelEvents?: PixelEventChange[];
  addedProvenance: ProvenanceChange[];
  removedProvenance: ProvenanceChange[];
};

export type ComparisonRunLabels = {
  baseline: string;
  variant: string;
};

export type ComparisonScanResult = {
  ok: true;
  schemaVersion: ScanReportSchemaVersion;
  reportType: "comparison";
  comparisonType: ComparisonType;
  title: string;
  runLabels?: ComparisonRunLabels;
  requestedUrl: string;
  scannedAt: string;
  device: ScanDevice;
  baseline: ScanResult;
  variant: ScanResult;
  diff: ComparisonDiff;
  warnings: string[];
  share?: ReportShare;
};

export type ScanError = {
  ok: false;
  error: string;
};

export type ScanJobStatus = "queued" | "running" | "succeeded" | "failed" | "expired" | "cancelled";
export type ScanJobProgressPhase = "queued" | "waiting" | "launching" | "navigating" | "collecting" | "saving";

export type ScanJobProgress = {
  phase: ScanJobProgressPhase;
  completedRuns: number;
  totalRuns: number;
};

export type ScanJobSubmissionResponse = {
  ok: true;
  jobId: string;
  status: "queued";
  statusPath: string;
  /**
   * The ID the finished report will be saved and shared under. Deliberately
   * different from jobId: the status endpoint (which can carry the screenshot)
   * is a capability held only by the submitter, so a shared report link must
   * not reveal it. The submitter keeps this ID to recover the saved report if
   * the in-memory job record disappears mid-poll (e.g. a container restart).
   */
  reportId: string;
};

export type ScanJobStatusResponse = {
  ok: true;
  jobId: string;
  status: ScanJobStatus;
  progress?: ScanJobProgress;
  report?: ScanReport;
  error?: string;
};

export type ScanReport = ScanResult | ComparisonScanResult;
export type ScanApiResponse = ScanReport | ScanJobSubmissionResponse | ScanError;
export type ScanJobApiResponse = ScanJobStatusResponse | ScanError;

export type StaticReportManifestEntry = {
  // Location is derived from `id` via the report locator, not stored, so the
  // manifest stays metadata-only and the path scheme has a single definition.
  id: string;
  title: string;
  /** Canonical evidence-gated card headline, derived during the managed build. */
  headline: string;
  /** Canonical headline tone; never re-inferred from raw counts in the browser. */
  tone: "alarm" | "warn" | "info" | "calm";
  domain: string;
  requestedUrl: string;
  scannedAt: string;
  reportType: "single" | "comparison";
  // Present for comparison reports so cards can pick the right framing
  // (notably the Shields tried-vs-blocked diff).
  comparisonType?: ComparisonType | null;
  device: ScanDevice;
  gpcEnabled: boolean | "comparison";
  // The lead run hit the request-recording cap, so its counts are truncated
  // (activity floors and interrupted-visit snapshots) and cards must flag it.
  requestCapped?: boolean;
  /**
   * Exact, versioned subject/method/condition identity for temporal history.
   * Absent means the setup is incomplete or generalized and cannot pair.
   */
  historyKey?: string;
  /**
   * Versioned identity for successful, uncapped passive-history comparisons.
   * It holds subject, method, browser/device, conditions, catalog, Brave-list
   * source and list count constant while permitting the snapshot date to
   * differ. It never replaces the stricter retention `historyKey` above.
   */
  comparisonHistoryKey?: string;
  metrics: {
    totalRequests: number;
    thirdPartyRequests: number;
    knownTrackerRequests: number;
    thirdPartyDomains: number;
    cookies: number;
    thirdPartyCookies: number;
    fingerprintEvents: number;
    // Requests that matched the Shields filter lists on the lead (baseline)
    // run while it loaded normally; nothing was blocked in that run.
    shieldsBlockedRequests?: number;
  };
};

export type StaticReportManifest = {
  generatedAt: string;
  reports: StaticReportManifestEntry[];
};
