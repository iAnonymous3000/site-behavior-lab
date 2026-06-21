export type ScanDevice = "desktop" | "mobile";
export type ConsentMode = "observe";
export type ScanAutomation = "playwright-chromium" | "brave-pagegraph" | "external";
export type ComparisonType = "gpc" | "shields" | "temporal" | "custom";
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
  confidence: "curated";
  prevalence?: number;
  fingerprinting?: number;
  cookiePrevalence?: number;
};

export type NetworkRequestRecord = {
  id: number;
  url: string;
  domain: string;
  method: string;
  resourceType: string;
  status: number | null;
  thirdParty: boolean;
  tracker: TrackerMatch | null;
  blockedByShields?: boolean;
  provenance?: NetworkRequestProvenance;
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

export type FingerprintDetectionSummary =
  | CanvasFingerprintDetectionSummary
  | CanvasFontFingerprintDetectionSummary
  | WebglFingerprintDetectionSummary
  | AudioFingerprintDetectionSummary
  | WebrtcFingerprintDetectionSummary
  | SessionRecordingDetectionSummary
  | InputMonitoringDetectionSummary;

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
  addedProvenance: ProvenanceChange[];
  removedProvenance: ProvenanceChange[];
};

export type GpcComparisonDiff = ComparisonDiff;

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
  domain: string;
  requestedUrl: string;
  scannedAt: string;
  reportType: "single" | "comparison";
  device: ScanDevice;
  gpcEnabled: boolean | "comparison";
  metrics: {
    totalRequests: number;
    thirdPartyRequests: number;
    knownTrackerRequests: number;
    thirdPartyDomains: number;
    cookies: number;
    thirdPartyCookies: number;
    fingerprintEvents: number;
  };
};

export type StaticReportManifest = {
  generatedAt: string;
  reports: StaticReportManifestEntry[];
};
