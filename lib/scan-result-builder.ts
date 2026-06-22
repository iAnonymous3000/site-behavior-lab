import { summarizeDomains } from "./domain-utils";
import { trackerCatalogMetadata } from "./tracker-catalog";
import { SCAN_REPORT_SCHEMA_VERSION } from "./types";
import type {
  CnameCloak,
  ConsentMode,
  CookieRecord,
  FingerprintDetectionSummary,
  FingerprintEventSummary,
  NetworkRequestRecord,
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
  screenshot: string | null;
  warnings: string[];
  shieldsBlockedRequests?: number;
};

export type ScanConditionsProfile = "node-playwright" | "cloudflare-browser-run" | "brave-pagegraph";

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

function scannerDisclosure(
  profile: ScanConditionsProfile,
  input: {
    chromiumVersion: string;
    locale: string;
    scannerEgress: string;
    shieldsMode?: ScanConditions["shieldsMode"];
    timezone: string;
  }
): string {
  if (profile === "node-playwright") {
    const shieldsDescription = input.shieldsMode === "block-simulation" ? "block simulation" : "classification only";
    return `Automated Chromium scan from ${input.scannerEgress} with browser ${input.chromiumVersion}, timezone ${input.timezone}, locale ${input.locale}, the listed viewport, and Brave Shields ${shieldsDescription}. Treat results as reproducible evidence for this scan configuration, not a universal claim about all visitors.`;
  }

  if (profile === "cloudflare-browser-run") {
    return `Cloudflare Browser Run headless Chromium from ${input.scannerEgress} with browser ${input.chromiumVersion}, timezone ${input.timezone}, locale ${input.locale}, and the listed viewport. This Worker verifies public URL shape and DNS answers before navigation and resource loading, but Browser Run performs connection-time DNS resolution and this Worker cannot currently pin the browser connection to the verified IP. Treat results as reproducible evidence for this scan configuration, not a universal claim about all visitors.`;
  }

  return `Brave PageGraph-derived scan from ${input.scannerEgress} with browser ${input.chromiumVersion} and the listed viewport. Treat results as reproducible evidence for this crawl configuration, not a universal claim about all visitors.`;
}

export function buildScanResult(input: BuildScanResultInput): ScanResult {
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

  return result;
}
