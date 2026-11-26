/**
 * Clean-slate ScanReportV3 schema (Site Behavior Lab 2.0).
 *
 * Designed from first principles with self-describing provenance, typed
 * per-probe coverage/status, persisted multi-phase capture (passive load,
 * consent choice, scroll interaction, active keystroke probe, privacy policy),
 * CDP-native network/WebSocket/ServiceWorker/cookie/storage/call-stack
 * evidence, full adblock-rust BlockerResult metadata, unified host-agnostic
 * beacon/pixel/server-side-tagging events, dark-pattern CMP scoring, and
 * multi-arm comparisons.
 *
 * Security invariant: no raw visitor PII, no cookie values, no storage values,
 * no raw query strings/fragments, and no raw form values are representable in
 * this schema.
 */

export const SCAN_REPORT_V3_SCHEMA_VERSION = 3 as const;

export type ScanDeviceV3 = "desktop" | "mobile";
export type ConsentModeV3 = "observe" | "accept-all" | "reject-all";
export type ShieldsModeV3 = "off" | "standard" | "aggressive";

export type ScanPhaseName =
  | "passive-load"
  | "consent-choice"
  | "scroll-interaction"
  | "active-input"
  | "policy-check";

export type ProbeName =
  | "network"
  | "websockets"
  | "serviceWorkers"
  | "cookies"
  | "storage"
  | "beacons"
  | "cname"
  | "fingerprinting"
  | "keystrokes"
  | "consent"
  | "policy";

export type ProbeCoverageStatus = "complete" | "partial" | "unavailable" | "skipped";

export type ProbeCoverageV3 = {
  status: ProbeCoverageStatus;
  reason?: string;
  omittedCount?: number;
};

export type ScanPhaseRecordV3 = {
  name: ScanPhaseName;
  startedAtMs: number;
  endedAtMs: number;
  status: "completed" | "partial" | "skipped" | "failed";
  reason?: string;
};

export type ServiceCategoryV3 =
  | "advertising"
  | "analytics"
  | "session-replay"
  | "cdp"
  | "consent-platform"
  | "anti-bot"
  | "tag-manager"
  | "social-widget"
  | "cdn-infra"
  | "error-monitoring"
  | "marketing-automation"
  | "identity-broker"
  | "server-side-tagging"
  | "other";

export type EntityRegionV3 = "US" | "EU" | "UK" | "APAC" | "CN" | "RU" | "LATAM" | "GLOBAL";

export type EntityAttributionV3 = {
  entity: string;
  parentOrg: string;
  category: ServiceCategoryV3;
  region: EntityRegionV3;
  confidence: "curated" | "shields-list" | "cname-uncloaked" | "server-side-signature";
  matchedDomain: string;
};

export type ShieldsMatchV3 = {
  matched: boolean;
  shouldBlockStandard: boolean;
  shouldBlockAggressive: boolean;
  /** Whether the request was actually blocked in this scan arm. */
  blocked: boolean;
  rule: string | null;
  list: string | null;
  exception: string | null;
  redirect: string | null;
  rewrittenUrl: string | null;
  important: boolean;
};

export type CallStackFrameV3 = {
  url: string;
  domain: string;
  line?: number;
  column?: number;
  functionName?: string;
};

export type RequestInitiatorV3 = {
  type: "parser" | "script" | "preload" | "redirect" | "preflight" | "other";
  scriptUrl?: string;
  scriptDomain?: string;
  callStack?: CallStackFrameV3[];
  workerType?: "dedicated" | "shared" | "service";
  frameId?: string;
};

export type AllowlistedResponseHeadersV3 = {
  setCookieCount?: number;
  cacheControl?: string;
  etagPresent?: boolean;
  accessControlAllowOrigin?: string;
  accessControlAllowCredentials?: boolean;
  contentSecurityPolicyPresent?: boolean;
  permissionsPolicyPresent?: boolean;
  strictTransportSecurityPresent?: boolean;
  referrerPolicy?: string;
  clearSiteData?: string;
};

export type AllowlistedRequestHeadersV3 = {
  secGpc?: string;
  dnt?: string;
  origin?: string;
  refererOrigin?: string;
  secFetchSite?: string;
  secFetchMode?: string;
};

export type NetworkRequestV3 = {
  id: number;
  phase: ScanPhaseName;
  url: string;
  domain: string;
  registrableDomain: string;
  method: string;
  resourceType: string;
  status: number | null;
  thirdParty: boolean;
  protocol: string | null;
  encodedBytes: number;
  startedAtMs: number;
  durationMs: number | null;
  redirectChain: string[];
  responseHeaders: AllowlistedResponseHeadersV3;
  requestHeaders: AllowlistedRequestHeadersV3;
  entity: EntityAttributionV3 | null;
  shields: ShieldsMatchV3;
  initiator: RequestInitiatorV3 | null;
};

export type WebSocketRecordV3 = {
  id: number;
  phase: ScanPhaseName;
  url: string;
  domain: string;
  registrableDomain: string;
  thirdParty: boolean;
  framesSent: number;
  framesReceived: number;
  bytesSent: number;
  bytesReceived: number;
  entity: EntityAttributionV3 | null;
  startedAtMs: number;
  closedAtMs: number | null;
};

export type ServiceWorkerRecordV3 = {
  scope: string;
  scriptUrl: string;
  domain: string;
  state: string;
  interceptedRequests: number;
};

export type CookieRecordV3 = {
  name: string;
  domain: string;
  registrableDomain: string;
  path: string;
  sameSite: string;
  secure: boolean;
  httpOnly: boolean;
  session: boolean;
  thirdParty: boolean;
  /** Rounded lifetime in days (null for session cookies). */
  ttlDays: number | null;
  /** CHIPS top-level site partition key when partitioned, null otherwise. */
  partitionKey: string | null;
  setVia: "http" | "js" | "unknown";
  phase: ScanPhaseName;
  entity: EntityAttributionV3 | null;
};

export type StorageAreaV3 = "localStorage" | "sessionStorage" | "indexedDB" | "cacheStorage";

export type StorageRecordV3 = {
  origin: string;
  domain: string;
  thirdParty: boolean;
  area: StorageAreaV3;
  keyOrStore: string;
  entryCount?: number;
  valueBytes: number;
  phase: ScanPhaseName;
  entity: EntityAttributionV3 | null;
};

export type IdentifierCategoryV3 =
  | "email"
  | "phone"
  | "name"
  | "address"
  | "date_of_birth"
  | "gender"
  | "external_id";

export type GoogleConsentModeSignalV3 = {
  /** Raw `gcs` flag (e.g. "G111", "G100") when observed on GA4/Ads beacons. */
  gcs?: string;
  /** Decoded ad_storage / analytics_storage summary from `gcs`/`gcd`. */
  adStorage: "granted" | "denied" | "unknown";
  analyticsStorage: "granted" | "denied" | "unknown";
  adUserData?: "granted" | "denied" | "unknown";
  adPersonalization?: "granted" | "denied" | "unknown";
};

export type BeaconEventSummaryV3 = {
  platform: string;
  product: string;
  format: string;
  endpointHost: string;
  firstPartyEndpoint: boolean;
  serverSideTagging: boolean;
  phases: ScanPhaseName[];
  events: string[];
  scrollDepths: number[];
  consentModeSignals: GoogleConsentModeSignalV3[];
  identifierCategories: IdentifierCategoryV3[];
  requests: number;
  complete: boolean;
};

export type CnameCloakV3 = {
  host: string;
  cnameChain: string[];
  targetDomain: string;
  entity: EntityAttributionV3;
  shieldsMatched: boolean;
  requestCount: number;
};

export type FingerprintSignalKindV3 =
  | "canvas"
  | "canvas-font"
  | "webgl"
  | "audio"
  | "webgpu"
  | "client-hints-high-entropy"
  | "dom-font-enumeration"
  | "mutation-observer-replay"
  | "webrtc"
  | "screen-hardware"
  | "document-cookie-writes";

export type FingerprintRealmV3 =
  | "main"
  | "iframe"
  | "dedicated-worker"
  | "shared-worker"
  | "service-worker";

export type FingerprintDetectionV3 = {
  kind: FingerprintSignalKindV3;
  count: number;
  realms: FingerprintRealmV3[];
  apis: string[];
  scriptDomains: string[];
  evidence: Record<string, string | number | boolean | string[]>;
};

export type KeystrokeTransportV3 =
  | "http-url"
  | "http-body"
  | "http-body-gzip"
  | "websocket"
  | "beacon";

export type KeystrokeLeakV3 = {
  domain: string;
  registrableDomain: string;
  thirdParty: boolean;
  cnameTarget?: string;
  transport: KeystrokeTransportV3;
  encoding: string;
  phase: ScanPhaseName;
};

export type KeystrokeSummaryV3 = {
  fieldsTyped: number;
  iframeFieldsTyped: number;
  shadowDomFieldsTyped: number;
  fieldTypes: string[];
  leaks: KeystrokeLeakV3[];
};

export type DarkPatternFlagV3 =
  | "asymmetric-clicks"
  | "reject-hidden-in-settings"
  | "pre-ticked-non-essential"
  | "prominence-asymmetry"
  | "cookie-wall";

export type ConsentBannerAuditV3 = {
  detected: boolean;
  cmp: string | null;
  hasFirstLayerAccept: boolean;
  hasFirstLayerReject: boolean;
  hasSettingsEntry: boolean;
  clicksToAccept: number | null;
  clicksToReject: number | null;
  darkPatternFlags: DarkPatternFlagV3[];
  /** 0 (symmetric / clean) to 100 (severe dark patterns). */
  darkPatternScore: number;
};

export type ConsentSignalStateV3 = "granted" | "denied" | "mixed" | "unknown" | "unavailable";

export type ConsentVerificationV3 = {
  tcf: {
    present: boolean;
    gdprApplies: boolean | null;
    eventStatus: string | null;
    state: ConsentSignalStateV3;
  };
  gpp: {
    present: boolean;
    applicableSections: number[];
    state: ConsentSignalStateV3;
  };
  usp: {
    present: boolean;
    optOutSale: boolean | null;
  };
  googleConsentMode: GoogleConsentModeSignalV3[];
  cmpCookies: {
    cmp: string;
    cookieName: string;
    state: ConsentSignalStateV3;
  }[];
  consistency: "verified" | "contradicted" | "inconclusive" | "unavailable";
};

export type ConsentSummaryV3 = {
  mode: ConsentModeV3;
  banner: ConsentBannerAuditV3;
  interaction: {
    attempted: boolean;
    clicked: boolean;
    layer: 1 | 2 | null;
    selector?: string;
    matchedText?: string;
    frameUrl?: string;
  };
  verification: ConsentVerificationV3;
};

export type PolicyClaimKindV3 =
  | "no-cookies"
  | "no-third-party-cookies"
  | "no-selling-or-sharing"
  | "honors-gpc";

export type PolicySummaryV3 = {
  url: string;
  language: string | null;
  textLength: number;
  fromIframe: boolean;
  claims: { kind: PolicyClaimKindV3; quote: string }[];
  mentionedEntities: string[];
  unmentionedEntities: string[];
};

export type ArmConditionsV3 = {
  device: ScanDeviceV3;
  gpcEnabled: boolean;
  shieldsMode: ShieldsModeV3;
  consentMode: ConsentModeV3;
  scrollCheck: boolean;
  activeInputProbe: boolean;
  policyCheck: boolean;
};

export type ArmSummaryV3 = {
  totalRequests: number;
  thirdPartyRequests: number;
  thirdPartyDomains: number;
  trackingRequests: number;
  shieldsMatchedRequests: number;
  shieldsBlockedStandard: number;
  shieldsBlockedAggressive: number;
  distinctEntities: number;
  distinctParentOrgs: number;
  cookiesTotal: number;
  thirdPartyCookies: number;
  longLivedCookies: number;
  partitionedCookies: number;
  storageKeysTotal: number;
  websocketsTotal: number;
  serviceWorkersTotal: number;
  beaconPlatforms: number;
  serverSideTaggingEndpoints: number;
  cnameCloaksCount: number;
  fingerprintKindsCount: number;
  keystrokeLeaksCount: number;
  darkPatternScore: number;
  topEntities: {
    entity: string;
    parentOrg: string;
    category: ServiceCategoryV3;
    requests: number;
    domains: number;
  }[];
};

export type ScanArmV3 = {
  armId: string;
  label: string;
  conditions: ArmConditionsV3;
  finalUrl: string;
  httpStatus: number | null;
  loadOutcome: "ok" | "bot-wall" | "consent-wall" | "http-error" | "navigation-error" | "timeout";
  durationMs: number;
  phases: ScanPhaseRecordV3[];
  probes: Record<ProbeName, ProbeCoverageV3>;
  network: NetworkRequestV3[];
  websockets: WebSocketRecordV3[];
  serviceWorkers: ServiceWorkerRecordV3[];
  cookies: CookieRecordV3[];
  storage: StorageRecordV3[];
  beacons: BeaconEventSummaryV3[];
  cnameCloaks: CnameCloakV3[];
  fingerprinting: FingerprintDetectionV3[];
  keystrokes: KeystrokeSummaryV3;
  consent: ConsentSummaryV3;
  policy: PolicySummaryV3 | null;
  summary: ArmSummaryV3;
};

export type ComparisonAxisV3 = "shields-standard" | "shields-aggressive" | "gpc" | "consent-accept" | "consent-reject" | "temporal" | "custom";

export type ComparisonDeltaV3 = {
  baselineArmId: string;
  variantArmId: string;
  axis: ComparisonAxisV3;
  requestsDelta: number;
  thirdPartyRequestsDelta: number;
  thirdPartyDomainsDelta: number;
  cookiesDelta: number;
  beaconsDelta: number;
  fingerprintKindsDelta: number;
  keystrokeLeaksDelta: number;
  entitiesRemoved: string[];
  entitiesAdded: string[];
  shieldsBlockedCount: number;
};

export type ReportHighlightSeverityV3 = "critical" | "high" | "medium" | "info";

export type ReportHighlightV3 = {
  id: string;
  severity: ReportHighlightSeverityV3;
  category:
    | "keystrokes"
    | "fingerprinting"
    | "beacons"
    | "cname-cloaking"
    | "server-side-tagging"
    | "consent"
    | "cookies"
    | "third-parties"
    | "policy";
  title: string;
  detail: string;
};

export type ReportProvenanceV3 = {
  schemaVersion: typeof SCAN_REPORT_V3_SCHEMA_VERSION;
  scannerVersion: string;
  buildCommit: string;
  engineVersions: {
    chromium: string;
    playwright: string;
    adblockRust: string;
    filterListsDigest: string;
    entityCatalogDigest: string;
  };
  egressRegion: string;
  locale: string;
  timezone: string;
  acquisition: "live-api" | "cli" | "ci-corpus" | "watch";
};

export type ScanReportV3 = {
  schemaVersion: typeof SCAN_REPORT_V3_SCHEMA_VERSION;
  reportId: string;
  scannedAt: string;
  targetUrl: string;
  finalUrl: string;
  canonicalDomain: string;
  provenance: ReportProvenanceV3;
  leadArm: ScanArmV3;
  comparisonArms: ScanArmV3[];
  comparisons: ComparisonDeltaV3[];
  highlights: ReportHighlightV3[];
};

const REQUIRED_PROBES: readonly ProbeName[] = [
  "network",
  "websockets",
  "serviceWorkers",
  "cookies",
  "storage",
  "beacons",
  "cname",
  "fingerprinting",
  "keystrokes",
  "consent",
  "policy"
];

/** Structural validator for ScanReportV3; returns an empty list on valid reports. */
export function validateScanReportV3(value: unknown): string[] {
  const issues: string[] = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return ["report must be an object"];
  }
  const report = value as Partial<ScanReportV3>;
  if (report.schemaVersion !== SCAN_REPORT_V3_SCHEMA_VERSION) {
    issues.push(`schemaVersion must be ${SCAN_REPORT_V3_SCHEMA_VERSION}`);
  }
  if (typeof report.reportId !== "string" || report.reportId.length < 8) {
    issues.push("reportId must be a non-empty string");
  }
  if (typeof report.scannedAt !== "string" || Number.isNaN(Date.parse(report.scannedAt))) {
    issues.push("scannedAt must be a valid ISO timestamp");
  }
  if (
    typeof report.canonicalDomain !== "string" ||
    !/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])$/i.test(report.canonicalDomain) ||
    !report.canonicalDomain.includes(".")
  ) {
    issues.push("canonicalDomain must be a valid domain");
  }
  if (!report.provenance || report.provenance.schemaVersion !== SCAN_REPORT_V3_SCHEMA_VERSION) {
    issues.push("provenance.schemaVersion must be 3");
  }
  if (!report.leadArm || typeof report.leadArm !== "object") {
    issues.push("leadArm is required");
  } else {
    issues.push(...validateArm(report.leadArm, "leadArm"));
  }
  if (!Array.isArray(report.comparisonArms)) {
    issues.push("comparisonArms must be an array");
  } else {
    for (const [idx, arm] of report.comparisonArms.entries()) {
      issues.push(...validateArm(arm, `comparisonArms[${idx}]`));
    }
  }
  if (!Array.isArray(report.comparisons)) {
    issues.push("comparisons must be an array");
  }
  if (!Array.isArray(report.highlights)) {
    issues.push("highlights must be an array");
  }
  return issues;
}

function validateArm(arm: Partial<ScanArmV3>, prefix: string): string[] {
  const issues: string[] = [];
  if (typeof arm.armId !== "string" || !arm.armId) issues.push(`${prefix}.armId is required`);
  if (!arm.probes || typeof arm.probes !== "object") {
    issues.push(`${prefix}.probes is required`);
  } else {
    for (const probe of REQUIRED_PROBES) {
      const entry = arm.probes[probe];
      if (!entry || !["complete", "partial", "unavailable", "skipped"].includes(entry.status)) {
        issues.push(`${prefix}.probes.${probe} must have a valid status`);
      }
    }
  }
  if (!Array.isArray(arm.network)) issues.push(`${prefix}.network must be an array`);
  if (!Array.isArray(arm.cookies)) issues.push(`${prefix}.cookies must be an array`);
  else {
    for (const [i, cookie] of arm.cookies.entries()) {
      if (cookie && typeof cookie === "object" && "value" in cookie) {
        issues.push(`${prefix}.cookies[${i}] must never persist cookie values`);
      }
    }
  }
  if (!Array.isArray(arm.storage)) issues.push(`${prefix}.storage must be an array`);
  else {
    for (const [i, entry] of arm.storage.entries()) {
      if (entry && typeof entry === "object" && "value" in entry) {
        issues.push(`${prefix}.storage[${i}] must never persist storage values`);
      }
    }
  }
  if (!Array.isArray(arm.phases)) issues.push(`${prefix}.phases must be an array`);
  if (!arm.summary || typeof arm.summary !== "object") issues.push(`${prefix}.summary is required`);
  return issues;
}

// ---------------------------------------------------------------------------
// Pure client-safe read-model & regional types (shared by UI and server)
// ---------------------------------------------------------------------------

export type ScanRegionIdV3 = "auto" | "us-east" | "eu-central" | "ap-northeast";

export type IndexedReportVisibilityV3 = "public" | "unlisted" | "corpus";

export type IndexedReportRowV3 = {
  reportId: string;
  canonicalDomain: string;
  finalUrl: string;
  scannedAt: string;
  visibility: IndexedReportVisibilityV3;
  egressRegion: string;
  device: string;
  loadOutcome: string;
  httpStatus: number | null;
  totalRequests: number;
  thirdPartyRequests: number;
  thirdPartyDomains: number;
  trackingRequests: number;
  shieldsBlockedStandard: number;
  shieldsBlockedAggressive: number;
  distinctEntities: number;
  distinctParentOrgs: number;
  cookiesTotal: number;
  thirdPartyCookies: number;
  longLivedCookies: number;
  partitionedCookies: number;
  storageKeysTotal: number;
  websocketsTotal: number;
  serviceWorkersTotal: number;
  beaconPlatforms: number;
  serverSideTaggingEndpoints: number;
  cnameCloaksCount: number;
  fingerprintKindsCount: number;
  keystrokeLeaksCount: number;
  keystrokeFieldsTyped?: number;
  darkPatternScore: number;
  topHighlight: string | null;
  r2Key: string;
  reportDigest: string;
  expiresAt: string | null;
};

export type EntityFootprintResultV3 = {
  name: string;
  totalSites: number;
  corpusSites: number;
  prevalencePct: number;
  sites: {
    canonicalDomain: string;
    reportId: string;
    scannedAt: string;
    category: string;
    requestCount: number;
    domainCount: number;
  }[];
};

export type CorpusOverviewStatsV3 = {
  totalReports: number;
  distinctSites: number;
  medianThirdPartyDomains: number;
  sitesWithKeystrokeLeaks: number;
  sitesWithKeystrokeProbeExercised?: number;
  sitesWithCnameCloaks: number;
  sitesWithServerSideTagging: number;
  sitesWithFingerprinting: number;
  sitesWithDarkPatterns: number;
  topEntities: { entity: string; parentOrg: string; category: string; siteCount: number }[];
  topParentOrgs: { parentOrg: string; siteCount: number }[];
};

export type WatchRegressionKindV3 =
  | "new-keystroke-leak"
  | "new-cname-cloak"
  | "new-server-side-tagging"
  | "new-beacon-identifiers"
  | "new-fingerprint-signal"
  | "new-tracking-entities"
  | "third-party-domain-spike"
  | "dark-pattern-regression"
  | "policy-disclosure-regression";

export type WatchRegressionAlertV3 = {
  kind: WatchRegressionKindV3;
  severity: "critical" | "high" | "medium";
  title: string;
  detail: string;
};

export type TemporalReportDiffV3 = {
  previousReportId: string;
  currentReportId: string;
  previousScannedAt: string;
  currentScannedAt: string;
  canonicalDomain: string;
  metrics: {
    totalRequestsDelta: number;
    thirdPartyRequestsDelta: number;
    thirdPartyDomainsDelta: number;
    cookiesDelta: number;
    longLivedCookiesDelta: number;
    darkPatternScoreDelta: number;
    keystrokeLeaksDelta: number;
    cnameCloaksDelta: number;
    fingerprintKindsDelta: number;
  };
  entitiesAdded: string[];
  entitiesRemoved: string[];
  beaconsAdded: string[];
  beaconsRemoved: string[];
  fingerprintsAdded: string[];
  fingerprintsRemoved: string[];
  regressions: WatchRegressionAlertV3[];
  improvements: string[];
};
