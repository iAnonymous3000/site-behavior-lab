import type {
  ComparisonDiff,
  ComparisonMetricDelta,
  ComparisonRunLabels,
  ComparisonScanResult,
  ComparisonType,
  CookieChange,
  CookieRecord,
  DomainChange,
  DomainSummary,
  EntityChange,
  FingerprintDetectionSummary,
  FingerprintingChange,
  NetworkRequestRecord,
  ProvenanceChange,
  ScanResult,
  StorageKeyChange,
  StorageRecord
} from "./types";
import { SCAN_REPORT_SCHEMA_VERSION } from "./types";

// Upper bound on entries kept in each diff list. High enough to be effectively
// "complete" for realistic pages while keeping stored comparison JSON bounded;
// the UI collapses long lists and offers a "show all" toggle up to this cap.
const MAX_DIFF_LIST = 100;

export function createGpcComparisonReport(baseline: ScanResult, variant: ScanResult): ComparisonScanResult {
  return createComparisonReport({
    comparisonType: "gpc",
    title: "GPC off/on comparison",
    runLabels: {
      baseline: "GPC off",
      variant: "GPC on"
    },
    baseline,
    variant,
    warningPrefix: "Comparison runs are sequential automated visits, not simultaneous observations. Differences can also come from timing, experiments, cache state, consent state, or bot detection."
  });
}

export function createShieldsComparisonReport(baseline: ScanResult, variant: ScanResult): ComparisonScanResult {
  return createComparisonReport({
    comparisonType: "shields",
    title: "Shields off/on comparison",
    runLabels: {
      baseline: "Shields off",
      variant: "Shields on"
    },
    baseline,
    variant,
    warningPrefix:
      "Shields comparison runs should be collected under matched crawl conditions. Differences can still reflect timing, experiments, cache state, consent state, or bot detection."
  });
}

export function createTemporalComparisonReport(before: ScanResult, after: ScanResult): ComparisonScanResult {
  return createComparisonReport({
    comparisonType: "temporal",
    title: "Before/after site behavior comparison",
    runLabels: {
      baseline: "Before",
      variant: "After"
    },
    baseline: before,
    variant: after,
    warningPrefix:
      "Temporal comparison runs are separate observations. Differences can reflect site releases, experiments, timing, geography, cache state, or bot detection."
  });
}

export function createComparisonReport({
  comparisonType,
  title,
  runLabels,
  baseline,
  variant,
  warningPrefix
}: {
  comparisonType: ComparisonType;
  title: string;
  runLabels: ComparisonRunLabels;
  baseline: ScanResult;
  variant: ScanResult;
  warningPrefix: string;
}): ComparisonScanResult {
  const diff = compareScanResults(baseline, variant);
  const warnings = [
    warningPrefix,
    ...prefixWarnings(runLabels.baseline, baseline.warnings),
    ...prefixWarnings(runLabels.variant, variant.warnings)
  ];

  return {
    ok: true,
    schemaVersion: SCAN_REPORT_SCHEMA_VERSION,
    reportType: "comparison",
    comparisonType,
    title,
    runLabels,
    requestedUrl: variant.conditions.requestedUrl,
    scannedAt: variant.conditions.scannedAt,
    device: variant.conditions.viewport.isMobile ? "mobile" : "desktop",
    baseline,
    variant,
    diff,
    warnings
  };
}

export function compareScanResults(before: ScanResult, after: ScanResult): ComparisonDiff {
  const diff: ComparisonDiff = {
    totalRequests: delta(before.summary.totalRequests, after.summary.totalRequests),
    thirdPartyRequests: delta(before.summary.thirdPartyRequests, after.summary.thirdPartyRequests),
    knownTrackerRequests: delta(before.summary.knownTrackerRequests, after.summary.knownTrackerRequests),
    thirdPartyDomains: delta(before.summary.thirdPartyDomains, after.summary.thirdPartyDomains),
    cookies: delta(before.summary.cookies, after.summary.cookies),
    thirdPartyCookies: delta(before.summary.thirdPartyCookies, after.summary.thirdPartyCookies),
    storageEntries: delta(before.summary.storageEntries, after.summary.storageEntries),
    fingerprintEvents: delta(before.summary.fingerprintEvents, after.summary.fingerprintEvents),
    addedDomains: domainChanges(before.domains, after.domains),
    removedDomains: domainChanges(after.domains, before.domains),
    addedEntities: entityChanges(before.domains, after.domains),
    removedEntities: entityChanges(after.domains, before.domains),
    addedCookies: cookieChanges(before.cookies, after.cookies),
    removedCookies: cookieChanges(after.cookies, before.cookies),
    addedStorageKeys: storageKeyChanges(before.storage, after.storage),
    removedStorageKeys: storageKeyChanges(after.storage, before.storage),
    addedFingerprinting: fingerprintingChanges(before.fingerprintDetections, after.fingerprintDetections),
    removedFingerprinting: fingerprintingChanges(after.fingerprintDetections, before.fingerprintDetections),
    addedProvenance: provenanceChanges(before.requests, after.requests),
    removedProvenance: provenanceChanges(after.requests, before.requests)
  };

  const shieldsBlockedRequests = optionalDelta(
    before.summary.shieldsBlockedRequests,
    after.summary.shieldsBlockedRequests
  );
  if (shieldsBlockedRequests) diff.shieldsBlockedRequests = shieldsBlockedRequests;

  return diff;
}

function delta(before: number, after: number): ComparisonMetricDelta {
  return {
    before,
    after,
    delta: after - before
  };
}

function optionalDelta(before: number | undefined, after: number | undefined): ComparisonMetricDelta | undefined {
  if (before === undefined && after === undefined) return undefined;
  return delta(before ?? 0, after ?? 0);
}

function domainChanges(before: DomainSummary[], after: DomainSummary[]): DomainChange[] {
  const beforeDomains = new Set(before.map((domain) => domain.domain));
  return after
    .filter((domain) => !beforeDomains.has(domain.domain))
    .map((domain) => ({
      domain: domain.domain,
      requests: domain.requests,
      tracker: domain.tracker
    }))
    .sort((a, b) => b.requests - a.requests || a.domain.localeCompare(b.domain))
    .slice(0, MAX_DIFF_LIST);
}

function entityChanges(before: DomainSummary[], after: DomainSummary[]): EntityChange[] {
  const beforeEntities = entityRequestMap(before);
  return Array.from(entityRequestMap(after).entries())
    .filter(([entity]) => !beforeEntities.has(entity))
    .map(([entity, summary]) => ({
      entity,
      requests: summary.requests,
      domains: summary.domains
    }))
    .sort((a, b) => b.requests - a.requests || a.entity.localeCompare(b.entity))
    .slice(0, MAX_DIFF_LIST);
}

function cookieChanges(before: CookieRecord[], after: CookieRecord[]): CookieChange[] {
  const beforeKeys = new Set(before.map(cookieKey));
  const seen = new Set<string>();
  const changes: CookieChange[] = [];

  for (const cookie of after) {
    const key = cookieKey(cookie);
    if (beforeKeys.has(key) || seen.has(key)) continue;
    seen.add(key);
    changes.push({ name: cookie.name, domain: cookie.domain, thirdParty: cookie.thirdParty });
  }

  return changes
    .sort(
      (a, b) =>
        Number(b.thirdParty) - Number(a.thirdParty) || a.domain.localeCompare(b.domain) || a.name.localeCompare(b.name)
    )
    .slice(0, MAX_DIFF_LIST);
}

function cookieKey(cookie: CookieRecord): string {
  return `${cookie.name}\u001f${cookie.domain}\u001f${cookie.path}`;
}

function storageKeyChanges(before: StorageRecord[], after: StorageRecord[]): StorageKeyChange[] {
  const beforeKeys = new Set(before.map(storageKey));
  const seen = new Set<string>();
  const changes: StorageKeyChange[] = [];

  for (const record of after) {
    const key = storageKey(record);
    if (beforeKeys.has(key) || seen.has(key)) continue;
    seen.add(key);
    changes.push({ area: record.area, key: record.key });
  }

  return changes
    .sort((a, b) => a.area.localeCompare(b.area) || a.key.localeCompare(b.key))
    .slice(0, MAX_DIFF_LIST);
}

function storageKey(record: StorageRecord): string {
  return `${record.area}\u001f${record.key}`;
}

function fingerprintingChanges(
  before: FingerprintDetectionSummary[] | undefined,
  after: FingerprintDetectionSummary[] | undefined
): FingerprintingChange[] {
  const beforeKinds = new Set((before ?? []).map((detection) => detection.kind));

  return (after ?? [])
    .filter((detection) => !beforeKinds.has(detection.kind))
    .map((detection) => ({ kind: detection.kind, heuristic: detection.heuristic, count: detection.count }))
    .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind))
    .slice(0, MAX_DIFF_LIST);
}

function entityRequestMap(domains: DomainSummary[]): Map<string, { requests: number; domains: number }> {
  const entities = new Map<string, { requests: number; domains: number }>();
  for (const domain of domains) {
    if (!domain.tracker) continue;
    const entity = entities.get(domain.tracker.entity) ?? { requests: 0, domains: 0 };
    entity.requests += domain.requests;
    entity.domains += 1;
    entities.set(domain.tracker.entity, entity);
  }

  return entities;
}

function provenanceChanges(before: NetworkRequestRecord[], after: NetworkRequestRecord[]): ProvenanceChange[] {
  const beforeKeys = new Set(provenanceRequestMap(before).keys());
  return Array.from(provenanceRequestMap(after).entries())
    .filter(([key]) => !beforeKeys.has(key))
    .map(([, change]) => change)
    .sort((a, b) => b.requests - a.requests || a.domain.localeCompare(b.domain))
    .slice(0, MAX_DIFF_LIST);
}

function provenanceRequestMap(requests: NetworkRequestRecord[]): Map<string, ProvenanceChange> {
  const changes = new Map<string, ProvenanceChange>();

  for (const request of requests) {
    if (!request.thirdParty || !request.provenance) continue;

    const initiator = actorLabel(request.provenance.initiatorDomain, request.provenance.initiatorUrl, request.provenance.initiatorType);
    const script = actorLabel(request.provenance.scriptDomain, request.provenance.scriptUrl, "script");
    const injectedBy = actorLabel(request.provenance.injectedByDomain, request.provenance.injectedByUrl, "injected by");
    if (!initiator && !script && !injectedBy) continue;

    const key = [request.domain, request.tracker?.entity ?? "", initiator ?? "", script ?? "", injectedBy ?? ""].join("|");
    const existing =
      changes.get(key) ??
      ({
        domain: request.domain,
        requests: 0,
        tracker: request.tracker,
        initiator,
        script,
        injectedBy
      } satisfies ProvenanceChange);
    existing.requests += 1;
    changes.set(key, existing);
  }

  return changes;
}

function actorLabel(domain: string | undefined, url: string | undefined, type: string | undefined): string | null {
  const actor = domain || url;
  if (!actor) return null;
  const normalizedType = type?.trim().toLowerCase();
  if (!normalizedType || normalizedType === "script" || normalizedType === "injected by" || normalizedType === "unknown") return actor;
  if (actor.toLowerCase().includes(normalizedType)) return actor;
  return `${normalizedType} ${actor}`;
}

function prefixWarnings(label: string, warnings: string[]): string[] {
  return warnings.map((warning) => `${label}: ${warning}`);
}
