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
  PixelEventChange,
  PixelEventSummary,
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

/** Which comparison arm the producer actually executed first (counterbalancing). */
export type ComparisonExecutedFirst = "baseline" | "variant";

/**
 * Producer disclosure of the executed arm order. Frozen v1 has no structural
 * order field, so this sentence is the record: the public warning boundary
 * (lib/redact-scan-report-v1.ts) admits it by exact shape with a known run
 * label, and readers recover the order from it or from the per-run timestamps.
 */
export function comparisonOrderDisclosure(runLabels: ComparisonRunLabels, executedFirst: ComparisonExecutedFirst): string {
  return `The two visits ran in randomized order; the "${runLabels[executedFirst]}" visit ran first.`;
}

export function createGpcComparisonReport(
  baseline: ScanResult,
  variant: ScanResult,
  options: { executedFirst?: ComparisonExecutedFirst } = {}
): ComparisonScanResult {
  return createComparisonReport({
    comparisonType: "gpc",
    title: "GPC off/on comparison",
    runLabels: {
      baseline: "GPC off",
      variant: "GPC on"
    },
    baseline,
    variant,
    executedFirst: options.executedFirst,
    warningPrefix: "Comparison runs are sequential automated visits, not simultaneous observations. Differences can also come from timing, experiments, cache state, consent state, or bot detection."
  });
}

export function createShieldsComparisonReport(
  baseline: ScanResult,
  variant: ScanResult,
  options: { executedFirst?: ComparisonExecutedFirst } = {}
): ComparisonScanResult {
  // "Brave-list blocking", never "Shields on": the blocking arm runs Brave's
  // ad-block engine and default Shields lists as a block SIMULATION in this
  // scanner's browser, not a live Brave-browser visit. (The view layer
  // normalizes the older "Shields off/on" labels on already-stored reports.)
  return createComparisonReport({
    comparisonType: "shields",
    title: "Brave-list blocking off/on comparison",
    runLabels: {
      baseline: "No blocking",
      variant: "Brave-list blocking"
    },
    baseline,
    variant,
    executedFirst: options.executedFirst,
    warningPrefix:
      "Brave-list blocking comparison runs should be collected under matched crawl conditions, and the blocking run is a simulation with Brave's engine and default lists in this scanner's browser, not a live Brave visit. Differences can still reflect timing, experiments, cache state, consent state, or bot detection."
  });
}

/**
 * The consent comparison title the recorded dispatch facts support: only a
 * pair whose accept AND reject clicks really dispatched is an accept/reject
 * comparison; anything else is an attempt, named for what was missed. Shared
 * with the view layer, which rewrites the legacy stored title the same way.
 */
export function consentComparisonTitle(dispatch: { baseline: boolean; variant: boolean }): string {
  if (dispatch.baseline && dispatch.variant) return "Consent accept/reject comparison";
  if (!dispatch.baseline && !dispatch.variant) return "Consent comparison attempt (no banner clicked)";
  return dispatch.baseline
    ? "Consent comparison attempt (only Accept all clicked)"
    : "Consent comparison attempt (only Reject all clicked)";
}

export function createConsentComparisonReport(
  acceptRun: ScanResult,
  rejectRun: ScanResult,
  options: { executedFirst?: ComparisonExecutedFirst } = {}
): ComparisonScanResult {
  // Baseline = the accept-all run (the maximal, "unprotected" behavior, matching
  // how GPC/Shields comparisons lead with the off run); variant = reject-all.
  // The title and arm labels come from what each run RECORDED: a visit whose
  // control was never found is a pre-consent recording, and labeling it
  // "Accept all"/"Reject all" would present run-to-run variance as a
  // comparison of the two choices. (The view layer applies the same rewrite
  // to already-stored legacy reports.)
  const dispatch = {
    baseline: acceptRun.consentInteraction?.clicked === true,
    variant: rejectRun.consentInteraction?.clicked === true
  };
  return createComparisonReport({
    comparisonType: "consent",
    title: consentComparisonTitle(dispatch),
    runLabels: {
      baseline: dispatch.baseline ? "Accept-all click" : "Accept-all attempt",
      variant: dispatch.variant ? "Reject-all click" : "Reject-all attempt"
    },
    baseline: acceptRun,
    variant: rejectRun,
    executedFirst: options.executedFirst,
    warningPrefix:
      "Consent comparison runs are sequential automated visits: one asked to click the banner's accept-all choice, one asked to click reject-all (first layer only). A run where no control was clicked reflects the pre-consent state instead; see each run's consent note. Differences can also come from timing, experiments, cache state, or bot detection."
  });
}

/**
 * Order two single-scan reports by their recorded scannedAt so a temporal
 * pair's "Before" arm really is the older visit regardless of pick order.
 * Returns null when the recorded timestamps cannot order the pair (missing,
 * unparseable, or identical); the eligibility gate rejects such a pair, so
 * callers should surface the problem instead of building it.
 */
export function orderTemporalPair(a: ScanResult, b: ScanResult): [ScanResult, ScanResult] | null {
  const aMs = Date.parse(a.conditions.scannedAt ?? "");
  const bMs = Date.parse(b.conditions.scannedAt ?? "");
  if (!Number.isFinite(aMs) || !Number.isFinite(bMs) || aMs === bMs) return null;
  return aMs < bMs ? [a, b] : [b, a];
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
  warningPrefix,
  executedFirst
}: {
  comparisonType: ComparisonType;
  title: string;
  runLabels: ComparisonRunLabels;
  baseline: ScanResult;
  variant: ScanResult;
  warningPrefix: string;
  /** Recorded only when the producer really counterbalanced this pair. */
  executedFirst?: ComparisonExecutedFirst;
}): ComparisonScanResult {
  const diff = compareScanResults(baseline, variant);
  const warnings = [
    warningPrefix,
    ...(executedFirst ? [comparisonOrderDisclosure(runLabels, executedFirst)] : []),
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
  return compareRunFacts(runFactsFromScanResult(before), runFactsFromScanResult(after));
}

/**
 * The count and evidence surface the diff derives from. Structurally matched
 * by the view seam's `RunView`, so a consumer holding views computes the SAME
 * diff the producer wrote (one definition; parity by construction), and a v2
 * pair (which carries no v1-shaped diff) or a tampered upload gets identical
 * treatment.
 */
export type ComparisonRunFacts = {
  counts: {
    totalRequests: number;
    thirdPartyRequests: number;
    knownTrackerRequests: number;
    thirdPartyDomains: number;
    cookies: number;
    thirdPartyCookies: number;
    storageEntries: number;
    fingerprintEvents: number;
    shieldsBlockedRequests: number | null;
  };
  evidence: {
    requests: NetworkRequestRecord[];
    domains: DomainSummary[];
    cookies: CookieRecord[];
    storage: StorageRecord[];
    fingerprintDetections: FingerprintDetectionSummary[];
    pixelEvents: PixelEventSummary[];
  };
};

function runFactsFromScanResult(result: ScanResult): ComparisonRunFacts {
  return {
    counts: {
      totalRequests: result.summary.totalRequests,
      thirdPartyRequests: result.summary.thirdPartyRequests,
      knownTrackerRequests: result.summary.knownTrackerRequests,
      thirdPartyDomains: result.summary.thirdPartyDomains,
      cookies: result.summary.cookies,
      thirdPartyCookies: result.summary.thirdPartyCookies,
      storageEntries: result.summary.storageEntries,
      fingerprintEvents: result.summary.fingerprintEvents,
      shieldsBlockedRequests: result.summary.shieldsBlockedRequests ?? null
    },
    evidence: {
      requests: result.requests,
      domains: result.domains,
      cookies: result.cookies,
      storage: result.storage,
      fingerprintDetections: result.fingerprintDetections ?? [],
      pixelEvents: result.pixelEvents ?? []
    }
  };
}

export function compareRunFacts(before: ComparisonRunFacts, after: ComparisonRunFacts): ComparisonDiff {
  const diff: ComparisonDiff = {
    totalRequests: delta(before.counts.totalRequests, after.counts.totalRequests),
    thirdPartyRequests: delta(before.counts.thirdPartyRequests, after.counts.thirdPartyRequests),
    knownTrackerRequests: delta(before.counts.knownTrackerRequests, after.counts.knownTrackerRequests),
    thirdPartyDomains: delta(before.counts.thirdPartyDomains, after.counts.thirdPartyDomains),
    cookies: delta(before.counts.cookies, after.counts.cookies),
    thirdPartyCookies: delta(before.counts.thirdPartyCookies, after.counts.thirdPartyCookies),
    storageEntries: delta(before.counts.storageEntries, after.counts.storageEntries),
    fingerprintEvents: delta(before.counts.fingerprintEvents, after.counts.fingerprintEvents),
    addedDomains: domainChanges(before.evidence.domains, after.evidence.domains),
    removedDomains: domainChanges(after.evidence.domains, before.evidence.domains),
    addedEntities: entityChanges(before.evidence.domains, after.evidence.domains),
    removedEntities: entityChanges(after.evidence.domains, before.evidence.domains),
    addedCookies: cookieChanges(before.evidence.cookies, after.evidence.cookies),
    removedCookies: cookieChanges(after.evidence.cookies, before.evidence.cookies),
    addedStorageKeys: storageKeyChanges(before.evidence.storage, after.evidence.storage),
    removedStorageKeys: storageKeyChanges(after.evidence.storage, before.evidence.storage),
    addedFingerprinting: fingerprintingChanges(before.evidence.fingerprintDetections, after.evidence.fingerprintDetections),
    removedFingerprinting: fingerprintingChanges(after.evidence.fingerprintDetections, before.evidence.fingerprintDetections),
    addedProvenance: provenanceChanges(before.evidence.requests, after.evidence.requests),
    removedProvenance: provenanceChanges(after.evidence.requests, before.evidence.requests)
  };

  const shieldsBlockedRequests = optionalDelta(
    before.counts.shieldsBlockedRequests ?? undefined,
    after.counts.shieldsBlockedRequests ?? undefined
  );
  if (shieldsBlockedRequests) diff.shieldsBlockedRequests = shieldsBlockedRequests;

  // Pixel-level detail behind the entity diff: when Shields blocks facebook.com,
  // "Meta" already drops out of removedEntities, but this also names the pixel
  // and the events that stopped firing (e.g. Meta Pixel: PageView, Purchase).
  const addedPixelEvents = pixelEventChanges(before.evidence.pixelEvents, after.evidence.pixelEvents);
  const removedPixelEvents = pixelEventChanges(after.evidence.pixelEvents, before.evidence.pixelEvents);
  if (addedPixelEvents.length > 0) diff.addedPixelEvents = addedPixelEvents;
  if (removedPixelEvents.length > 0) diff.removedPixelEvents = removedPixelEvents;

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

/**
 * Pixel activity in `candidate` that the matching `baseline` platform did not
 * have. A platform absent from `baseline` yields its whole event/identifier list
 * (the common Shields case: blocking facebook.com drops Meta entirely); a
 * platform present in both yields only the events and identifiers that changed,
 * so partial blocking and temporal event changes are not lost.
 */
function pixelEventChanges(
  baseline: PixelEventSummary[] | undefined,
  candidate: PixelEventSummary[] | undefined
): PixelEventChange[] {
  const baselineByPlatform = new Map((baseline ?? []).map((pixel) => [pixel.platform, pixel]));

  const changes: PixelEventChange[] = [];
  for (const pixel of candidate ?? []) {
    const prior = baselineByPlatform.get(pixel.platform);
    const events = onlyIn(pixel.events, prior?.events);
    const advancedMatching = onlyIn(pixel.advancedMatching, prior?.advancedMatching);
    if (!prior || events.length > 0 || advancedMatching.length > 0) {
      changes.push({ platform: pixel.platform, product: pixel.product, events, advancedMatching });
    }
  }

  return changes.sort((a, b) => a.platform.localeCompare(b.platform)).slice(0, MAX_DIFF_LIST);
}

function onlyIn<T>(values: T[], exclude: T[] | undefined): T[] {
  if (!exclude || exclude.length === 0) return [...values];
  const excluded = new Set(exclude);
  return values.filter((value) => !excluded.has(value));
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
