import { summarizeDomains } from "./domain-utils";
import { scannerDisclosure, type ScanConditionsProfile } from "./scan-condition-disclosure";
import { trackerCatalogMetadata } from "./tracker-catalog";
import { SCAN_REPORT_SCHEMA_VERSION } from "./types";
import { redactScanResultV1, type RedactedV1 } from "./redact-scan-report-v1";
import type {
  CnameCloak,
  ConsentInteractionSummary,
  ConsentMode,
  CookieRecord,
  FingerprintDetectionSummary,
  FingerprintEventSummary,
  NetworkRequestRecord,
  PixelEventSummary,
  PrivacyPolicySummary,
  ScanAutomation,
  ScanConditions,
  ScanResult,
  StorageRecord
} from "./types";

export type BuildScanResultInput = {
  pageTitle: string;
  status: number | null;
  durationMs: number;
  firstPartyDomain: string;
  conditions: ScanConditions;
  requests: NetworkRequestRecord[];
  cookies: CookieRecord[];
  storage: StorageRecord[];
  fingerprintDetections?: FingerprintDetectionSummary[];
  fingerprintEvents: FingerprintEventSummary[];
  cnameCloaks?: CnameCloak[];
  pixelEvents?: PixelEventSummary[];
  privacyPolicy?: PrivacyPolicySummary;
  consentInteraction?: ConsentInteractionSummary;
  screenshot: string | null;
  warnings: string[];
  shieldsBlockedRequests?: number;
};

export type { ScanConditionsProfile } from "./scan-condition-disclosure";

export type BuildScanConditionsInput = {
  profile: ScanConditionsProfile;
  requestedUrl: string;
  finalUrl: string;
  scannedAt?: string;
  chromiumVersion?: string;
  userAgent?: string;
  timezone?: string;
  locale?: string;
  language?: string;
  viewport: ScanConditions["viewport"];
  gpcEnabled?: boolean;
  consentMode?: ConsentMode;
  headless?: boolean;
  scannerEgress?: string;
  trackerCatalog?: ScanConditions["trackerCatalog"];
  adblock?: ScanConditions["adblock"];
  shieldsMode?: ScanConditions["shieldsMode"];
};

export function buildScanConditions(input: BuildScanConditionsInput): ScanConditions {
  const defaults = profileDefaults(input.profile);
  const scannerEgress = input.scannerEgress ?? defaults.scannerEgress;
  const chromiumVersion = input.chromiumVersion ?? "unknown";
  const timezone = input.timezone ?? defaults.timezone;
  const locale = input.locale ?? defaults.locale;
  const language = input.language ?? defaults.language;
  const shieldsMode = input.shieldsMode ?? defaults.shieldsMode;
  const trackerCatalog = input.trackerCatalog ?? defaults.trackerCatalog;

  const conditions: ScanConditions = {
    requestedUrl: input.requestedUrl,
    finalUrl: input.finalUrl,
    scannedAt: input.scannedAt ?? new Date().toISOString(),
    chromiumVersion,
    userAgent: input.userAgent ?? "unknown",
    timezone,
    locale,
    language,
    viewport: {
      width: input.viewport.width,
      height: input.viewport.height,
      isMobile: input.viewport.isMobile
    },
    gpcEnabled: input.gpcEnabled ?? false,
    consentMode: input.consentMode ?? "observe",
    automation: defaults.automation,
    headless: input.headless ?? defaults.headless,
    scannerEgress,
    trackerCatalog: {
      source: trackerCatalog.source,
      version: trackerCatalog.version,
      region: trackerCatalog.region,
      entries: trackerCatalog.entries,
      curatedOverrides: trackerCatalog.curatedOverrides,
      license: trackerCatalog.license
    },
    scannerDisclosure: scannerDisclosure(input.profile, {
      chromiumVersion,
      locale,
      scannerEgress,
      shieldsMode,
      timezone
    })
  };

  if (input.adblock) {
    conditions.adblock = {
      active: input.adblock.active,
      source: input.adblock.source,
      lists: input.adblock.lists,
      fetchedAt: input.adblock.fetchedAt
    };
  }
  if (shieldsMode) {
    conditions.shieldsMode = shieldsMode;
  }

  return conditions;
}

function profileDefaults(profile: ScanConditionsProfile): {
  automation: ScanAutomation;
  headless: boolean;
  scannerEgress: string;
  shieldsMode?: ScanConditions["shieldsMode"];
  timezone: string;
  locale: string;
  language: string;
  trackerCatalog: ScanConditions["trackerCatalog"];
} {
  if (profile === "node-playwright") {
    return {
      automation: "playwright-chromium",
      headless: true,
      scannerEgress: "this scanner instance",
      shieldsMode: "classification",
      timezone: "UTC",
      locale: "en-US",
      language: "en-US",
      trackerCatalog: curatedTrackerCatalog()
    };
  }

  if (profile === "cloudflare-browser-run") {
    return {
      automation: "external",
      headless: true,
      scannerEgress: "cloudflare-browser-run",
      shieldsMode: "classification",
      timezone: "UTC",
      locale: "en-US",
      language: "en-US",
      trackerCatalog: {
        source: "none",
        version: "cloudflare-worker-2026.06",
        region: "n/a",
        entries: 0,
        curatedOverrides: 0,
        license: "n/a"
      }
    };
  }

  return {
    automation: "brave-pagegraph",
    headless: true,
    scannerEgress: "Brave PageGraph crawl",
    timezone: "unknown",
    locale: "unknown",
    language: "unknown",
    trackerCatalog: curatedTrackerCatalog()
  };
}

function curatedTrackerCatalog(): ScanConditions["trackerCatalog"] {
  return {
    source: trackerCatalogMetadata.source,
    version: trackerCatalogMetadata.version,
    region: trackerCatalogMetadata.region,
    entries: trackerCatalogMetadata.entries,
    curatedOverrides: trackerCatalogMetadata.curatedOverrides,
    license: trackerCatalogMetadata.license
  };
}

export function buildScanResultArtifacts(input: BuildScanResultInput): RedactedV1<ScanResult> {
  const domains = summarizeDomains(input.requests);
  const summary: ScanResult["summary"] = {
    pageTitle: input.pageTitle,
    status: input.status,
    durationMs: Math.max(0, Math.floor(input.durationMs)),
    firstPartyDomain: input.firstPartyDomain,
    totalRequests: input.requests.length,
    thirdPartyRequests: input.requests.filter((request) => request.thirdParty).length,
    knownTrackerRequests: input.requests.filter((request) => request.tracker).length,
    thirdPartyDomains: domains.filter((domain) => domain.thirdParty).length,
    cookies: input.cookies.length,
    thirdPartyCookies: input.cookies.filter((cookie) => cookie.thirdParty).length,
    storageEntries: input.storage.length,
    fingerprintEvents: input.fingerprintEvents.reduce((total, item) => total + item.count, 0)
  };

  if (input.shieldsBlockedRequests !== undefined) {
    summary.shieldsBlockedRequests = input.shieldsBlockedRequests;
  }

  const result: ScanResult = {
    ok: true,
    schemaVersion: SCAN_REPORT_SCHEMA_VERSION,
    reportType: "single",
    summary,
    conditions: input.conditions,
    requests: input.requests,
    domains,
    cookies: input.cookies,
    storage: input.storage,
    fingerprintDetections: input.fingerprintDetections ?? [],
    fingerprintEvents: input.fingerprintEvents,
    screenshot: input.screenshot,
    warnings: input.warnings
  };

  // Only attach when there is something to report, so clean visits stay clean.
  if (input.cnameCloaks && input.cnameCloaks.length > 0) {
    result.cnameCloaks = input.cnameCloaks;
  }
  if (input.pixelEvents && input.pixelEvents.length > 0) {
    result.pixelEvents = input.pixelEvents;
  }
  if (input.privacyPolicy) {
    result.privacyPolicy = input.privacyPolicy;
  }
  // Attached whenever a consent choice was ATTEMPTED (clicked or not): a failed
  // click means the run is still pre-consent, and the report must say which.
  if (input.consentInteraction) {
    result.consentInteraction = input.consentInteraction;
  }

  // Every current ScanReport producer (Node Playwright, Browser Run, and
  // PageGraph) converges here. Match/classify first, then apply the immutable
  // default-deny public transform once the evidence is complete; comparisons
  // are subsequently built from these already-sanitized arms.
  return redactScanResultV1(result);
}

export function buildScanResult(input: BuildScanResultInput): ScanResult {
  return buildScanResultArtifacts(input).report;
}
