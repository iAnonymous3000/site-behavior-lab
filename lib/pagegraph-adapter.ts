import { isThirdParty } from "./domain-utils";
import { safeParseUrl, redactUrlForReport } from "./report-url";
import { buildScanConditions, buildScanResult } from "./scan-result-builder";
import { findTrackerMatch } from "./tracker-catalog";
import type {
  CookieRecord,
  FingerprintEventSummary,
  NetworkRequestRecord,
  NetworkRequestProvenance,
  ScanDevice,
  ScanResult,
  StorageRecord,
  TrackerMatch
} from "./types";

export type TrackerMatcher = (domain: string) => TrackerMatch | null;

export type PageGraphViewport = {
  width: number;
  height: number;
  isMobile?: boolean;
};

export type PageGraphNetworkRequest = {
  url: string;
  domain?: string;
  method?: string;
  resourceType?: string;
  status?: number | null;
  startedAtMs?: number;
  provenance?: NetworkRequestProvenance;
};

export type PageGraphCookie = Omit<CookieRecord, "thirdParty"> & {
  thirdParty?: boolean;
};

export type PageGraphTrackerCatalog = {
  source: string;
  version: string;
  region: string;
  entries: number;
  curatedOverrides: number;
  license: string;
};

export type PageGraphAdapterInput = {
  requestedUrl: string;
  finalUrl?: string;
  scannedAt?: string;
  pageTitle?: string;
  status?: number | null;
  durationMs?: number;
  chromiumVersion?: string;
  userAgent?: string;
  timezone?: string;
  locale?: string;
  language?: string;
  device?: ScanDevice;
  viewport?: PageGraphViewport;
  gpcEnabled?: boolean;
  headless?: boolean;
  scannerEgress?: string;
  trackerCatalog?: PageGraphTrackerCatalog;
  trackerMatcher?: TrackerMatcher;
  requests?: PageGraphNetworkRequest[];
  cookies?: PageGraphCookie[];
  storage?: StorageRecord[];
  fingerprintEvents?: FingerprintEventSummary[];
  screenshot?: string | null;
  warnings?: string[];
};

export function pageGraphToScanResult(input: PageGraphAdapterInput): ScanResult {
  const requestedUrl = requiredUrl(input.requestedUrl, "requestedUrl");
  const finalUrl = input.finalUrl ? requiredUrl(input.finalUrl, "finalUrl") : requestedUrl;
  const firstPartyDomain = finalUrl.hostname;
  const viewport = normalizeViewport(input.viewport, input.device);
  const warnings = [
    "This report was adapted from Brave PageGraph-derived observations. Treat it as evidence for the recorded crawl conditions, not a universal claim about all visitors.",
    ...(input.warnings ?? [])
  ];
  const trackerMatcher = input.trackerMatcher ?? findTrackerMatch;
  const requests = normalizeRequests(input.requests ?? [], firstPartyDomain, warnings, trackerMatcher);
  if (requests.length > 0 && requests.every((request) => !hasHumanReadableProvenance(request.provenance))) {
    warnings.push(
      "No PageGraph request provenance was supplied. This report can show observed requests but not script-to-request causality."
    );
  }
  const cookies = normalizeCookies(input.cookies ?? [], firstPartyDomain);
  const storage = input.storage ?? [];
  const fingerprintEvents = normalizeFingerprintEvents(input.fingerprintEvents ?? []);
  const scannerEgress = input.scannerEgress ?? "Brave PageGraph crawl";
  const chromiumVersion = input.chromiumVersion ?? "unknown";
  const conditions = buildScanConditions({
    profile: "brave-pagegraph",
    requestedUrl: redactUrlForReport(requestedUrl.toString()),
    finalUrl: redactUrlForReport(finalUrl.toString()),
    scannedAt: input.scannedAt ?? new Date().toISOString(),
    chromiumVersion,
    userAgent: input.userAgent ?? "unknown",
    timezone: input.timezone ?? "unknown",
    locale: input.locale ?? "unknown",
    language: input.language ?? input.locale ?? "unknown",
    viewport,
    gpcEnabled: input.gpcEnabled ?? false,
    headless: input.headless ?? true,
    scannerEgress,
    trackerCatalog: input.trackerCatalog
  });

  return buildScanResult({
    pageTitle: input.pageTitle ?? "",
    status: input.status ?? null,
    durationMs: input.durationMs ?? 0,
    firstPartyDomain,
    conditions,
    requests,
    cookies,
    storage,
    fingerprintEvents,
    screenshot: input.screenshot ?? null,
    warnings
  });
}

function normalizeRequests(
  observations: PageGraphNetworkRequest[],
  firstPartyDomain: string,
  warnings: string[],
  trackerMatcher: TrackerMatcher
): NetworkRequestRecord[] {
  const requests: NetworkRequestRecord[] = [];

  observations.forEach((observation, index) => {
    const parsed = safeParseUrl(observation.url);
    const domain = normalizeDomain(observation.domain ?? parsed?.hostname ?? "");
    if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:") || !domain) {
      warnings.push(`Skipped PageGraph request ${index + 1} because its URL was not HTTP(S).`);
      return;
    }

    const thirdParty = isThirdParty(firstPartyDomain, domain);
    requests.push({
      id: requests.length + 1,
      url: redactUrlForReport(parsed.toString(), { preserveQueryKeys: thirdParty }),
      domain,
      method: observation.method ?? "UNKNOWN",
      resourceType: observation.resourceType ?? "other",
      status: observation.status ?? null,
      thirdParty,
      tracker: thirdParty ? trackerMatcher(domain) : null,
      provenance: normalizeProvenance(observation.provenance),
      startedAtMs: Math.max(0, Math.floor(observation.startedAtMs ?? 0))
    });
  });

  return requests;
}

function normalizeProvenance(provenance: NetworkRequestProvenance | undefined): NetworkRequestProvenance | undefined {
  if (!provenance) return undefined;

  const normalized: NetworkRequestProvenance = {
    graphRecordId: cleanString(provenance.graphRecordId),
    initiatorId: cleanString(provenance.initiatorId),
    initiatorType: cleanString(provenance.initiatorType),
    initiatorUrl: normalizeProvenanceUrl(provenance.initiatorUrl),
    initiatorDomain: normalizeDomain(provenance.initiatorDomain ?? domainFromUrl(provenance.initiatorUrl) ?? ""),
    scriptId: cleanString(provenance.scriptId),
    scriptUrl: normalizeProvenanceUrl(provenance.scriptUrl),
    scriptDomain: normalizeDomain(provenance.scriptDomain ?? domainFromUrl(provenance.scriptUrl) ?? ""),
    injectedById: cleanString(provenance.injectedById),
    injectedByUrl: normalizeProvenanceUrl(provenance.injectedByUrl),
    injectedByDomain: normalizeDomain(provenance.injectedByDomain ?? domainFromUrl(provenance.injectedByUrl) ?? "")
  };

  for (const key of Object.keys(normalized) as (keyof NetworkRequestProvenance)[]) {
    if (!normalized[key]) delete normalized[key];
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function hasHumanReadableProvenance(provenance: NetworkRequestProvenance | undefined): boolean {
  return Boolean(
    provenance?.initiatorUrl ||
      provenance?.initiatorDomain ||
      provenance?.scriptUrl ||
      provenance?.scriptDomain ||
      provenance?.injectedByUrl ||
      provenance?.injectedByDomain
  );
}

function normalizeProvenanceUrl(value: string | undefined): string | undefined {
  const parsed = value ? safeParseUrl(value) : null;
  if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) return undefined;
  return redactUrlForReport(parsed.toString(), { preserveQueryKeys: true });
}

function domainFromUrl(value: string | undefined): string | undefined {
  const parsed = value ? safeParseUrl(value) : null;
  return parsed?.hostname;
}

function cleanString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function normalizeCookies(cookies: PageGraphCookie[], firstPartyDomain: string): CookieRecord[] {
  return cookies.map((cookie) => {
    const cookieDomain = normalizeDomain(cookie.domain);
    return {
      ...cookie,
      thirdParty: cookie.thirdParty ?? isThirdParty(firstPartyDomain, cookieDomain)
    };
  });
}

function normalizeFingerprintEvents(events: FingerprintEventSummary[]): FingerprintEventSummary[] {
  return events
    .filter((event) => event.api && Number.isFinite(event.count) && event.count > 0)
    .map((event) => ({ api: event.api, count: Math.floor(event.count) }))
    .sort((a, b) => b.count - a.count || a.api.localeCompare(b.api));
}

function normalizeViewport(viewport: PageGraphViewport | undefined, device: ScanDevice | undefined): {
  width: number;
  height: number;
  isMobile: boolean;
} {
  const width = Math.max(1, Math.floor(viewport?.width ?? (device === "mobile" ? 390 : 1440)));
  const height = Math.max(1, Math.floor(viewport?.height ?? (device === "mobile" ? 844 : 980)));
  return {
    width,
    height,
    isMobile: viewport?.isMobile ?? device === "mobile"
  };
}

function requiredUrl(value: string, name: string): URL {
  const parsed = safeParseUrl(value);
  if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
    throw new Error(`PageGraph ${name} must be an HTTP(S) URL.`);
  }
  return parsed;
}

function normalizeDomain(domain: string): string {
  return domain.toLowerCase().replace(/^\./, "").replace(/^\[|\]$/g, "").replace(/\.$/, "");
}
