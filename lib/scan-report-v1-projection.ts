/**
 * Deep, named-field public projector for FROZEN v1 reports. The v1 validator
 * tolerates unknown properties (v1 was never key-strict), so any persistence
 * or export boundary that spreads a v1 object carries those unknowns along;
 * a reproduced upload smuggled root- and conditions-level secrets through the
 * previous spread-based helper. This projector copies KNOWN FIELDS ONLY at
 * every level, drops screenshots unconditionally (v1's strip-on-save rule),
 * and therefore cannot leak what it never copies.
 *
 * Companion to lib/scan-report-v1-guard.ts: both are security backports built
 * beside the frozen v1 modules, never edits to them.
 */
import type {
  ComparisonDiff,
  ComparisonScanResult,
  ConsentInteractionSummary,
  CookieRecord,
  DomainSummary,
  FingerprintDetectionSummary,
  NetworkRequestRecord,
  PixelEventSummary,
  PrivacyPolicySummary,
  ReportShare,
  ScanConditions,
  ScanReport,
  ScanResult,
  StorageRecord,
  TrackerMatch,
  CnameCloak
} from "./types";
import { redactScanReportV1 } from "./redact-scan-report-v1";

function copyTracker(tracker: TrackerMatch | null): TrackerMatch | null {
  if (tracker === null) return null;
  return {
    domain: tracker.domain,
    entity: tracker.entity,
    category: tracker.category,
    confidence: tracker.confidence,
    ...(tracker.prevalence !== undefined ? { prevalence: tracker.prevalence } : {}),
    ...(tracker.fingerprinting !== undefined ? { fingerprinting: tracker.fingerprinting } : {}),
    ...(tracker.cookiePrevalence !== undefined ? { cookiePrevalence: tracker.cookiePrevalence } : {})
  };
}

function copyRequest(request: NetworkRequestRecord): NetworkRequestRecord {
  const provenance = request.provenance;
  return {
    id: request.id,
    url: request.url,
    domain: request.domain,
    method: request.method,
    resourceType: request.resourceType,
    status: request.status,
    thirdParty: request.thirdParty,
    tracker: copyTracker(request.tracker),
    ...(request.blockedByShields !== undefined ? { blockedByShields: request.blockedByShields } : {}),
    ...(provenance !== undefined
      ? {
          provenance: {
            ...(provenance.graphRecordId !== undefined ? { graphRecordId: provenance.graphRecordId } : {}),
            ...(provenance.initiatorId !== undefined ? { initiatorId: provenance.initiatorId } : {}),
            ...(provenance.initiatorType !== undefined ? { initiatorType: provenance.initiatorType } : {}),
            ...(provenance.initiatorUrl !== undefined ? { initiatorUrl: provenance.initiatorUrl } : {}),
            ...(provenance.initiatorDomain !== undefined ? { initiatorDomain: provenance.initiatorDomain } : {}),
            ...(provenance.scriptId !== undefined ? { scriptId: provenance.scriptId } : {}),
            ...(provenance.scriptUrl !== undefined ? { scriptUrl: provenance.scriptUrl } : {}),
            ...(provenance.scriptDomain !== undefined ? { scriptDomain: provenance.scriptDomain } : {}),
            ...(provenance.injectedById !== undefined ? { injectedById: provenance.injectedById } : {}),
            ...(provenance.injectedByUrl !== undefined ? { injectedByUrl: provenance.injectedByUrl } : {}),
            ...(provenance.injectedByDomain !== undefined ? { injectedByDomain: provenance.injectedByDomain } : {})
          }
        }
      : {}),
    startedAtMs: request.startedAtMs
  };
}

function copyDomain(domain: DomainSummary): DomainSummary {
  return {
    domain: domain.domain,
    requests: domain.requests,
    thirdParty: domain.thirdParty,
    tracker: copyTracker(domain.tracker),
    ...(domain.blockedByShields !== undefined ? { blockedByShields: domain.blockedByShields } : {}),
    statuses: [...domain.statuses],
    resourceTypes: [...domain.resourceTypes]
  };
}

function copyCookie(cookie: CookieRecord): CookieRecord {
  return {
    name: cookie.name,
    domain: cookie.domain,
    path: cookie.path,
    sameSite: cookie.sameSite,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    session: cookie.session,
    thirdParty: cookie.thirdParty
  };
}

function copyStorage(entry: StorageRecord): StorageRecord {
  return { area: entry.area, key: entry.key, valueBytes: entry.valueBytes };
}

function copyDetection(detection: FingerprintDetectionSummary): FingerprintDetectionSummary {
  switch (detection.kind) {
    case "canvas-fingerprinting":
      return {
        kind: detection.kind,
        heuristic: detection.heuristic,
        count: detection.count,
        evidence: {
          readApis: [...detection.evidence.readApis],
          maxCanvasWidth: detection.evidence.maxCanvasWidth,
          maxCanvasHeight: detection.evidence.maxCanvasHeight,
          maxDistinctTextCharacters: detection.evidence.maxDistinctTextCharacters,
          maxTextWriteCalls: detection.evidence.maxTextWriteCalls
        }
      };
    case "canvas-font-fingerprinting":
      return {
        kind: detection.kind,
        heuristic: detection.heuristic,
        count: detection.count,
        evidence: {
          measureTextCalls: detection.evidence.measureTextCalls,
          maxDistinctFonts: detection.evidence.maxDistinctFonts,
          maxDistinctTextSamples: detection.evidence.maxDistinctTextSamples,
          maxTextLength: detection.evidence.maxTextLength
        }
      };
    case "webgl-fingerprinting":
      return {
        kind: detection.kind,
        heuristic: detection.heuristic,
        count: detection.count,
        evidence: {
          readApis: [...detection.evidence.readApis],
          parameters: [...detection.evidence.parameters],
          getParameterCalls: detection.evidence.getParameterCalls,
          readPixelsCalls: detection.evidence.readPixelsCalls
        }
      };
    case "audio-fingerprinting":
      return {
        kind: detection.kind,
        heuristic: detection.heuristic,
        count: detection.count,
        evidence: {
          apis: [...detection.evidence.apis],
          offlineRenderCalls: detection.evidence.offlineRenderCalls,
          oscillatorCalls: detection.evidence.oscillatorCalls,
          compressorCalls: detection.evidence.compressorCalls,
          analyserCalls: detection.evidence.analyserCalls
        }
      };
    case "webrtc-fingerprinting":
      return {
        kind: detection.kind,
        heuristic: detection.heuristic,
        count: detection.count,
        evidence: {
          constructorCalls: detection.evidence.constructorCalls,
          createDataChannelCalls: detection.evidence.createDataChannelCalls,
          createOfferCalls: detection.evidence.createOfferCalls,
          setLocalDescriptionCalls: detection.evidence.setLocalDescriptionCalls
        }
      };
    case "session-recording":
      return {
        kind: detection.kind,
        heuristic: detection.heuristic,
        count: detection.count,
        evidence: {
          eventTypes: [...detection.evidence.eventTypes],
          listenerTargets: [...detection.evidence.listenerTargets],
          thirdPartyOrigins: [...detection.evidence.thirdPartyOrigins],
          totalListenerCalls: detection.evidence.totalListenerCalls
        }
      };
    case "input-monitoring":
      return {
        kind: detection.kind,
        heuristic: detection.heuristic,
        count: detection.count,
        evidence: {
          eventTypes: [...detection.evidence.eventTypes],
          listenerTargets: [...detection.evidence.listenerTargets],
          thirdPartyOrigins: [...detection.evidence.thirdPartyOrigins],
          totalListenerCalls: detection.evidence.totalListenerCalls
        }
      };
    case "keystroke-exfiltration":
      return {
        kind: detection.kind,
        heuristic: detection.heuristic,
        count: detection.count,
        evidence: {
          recipients: [...detection.evidence.recipients],
          encodings: [...detection.evidence.encodings],
          fieldsTyped: detection.evidence.fieldsTyped,
          fieldTypes: [...detection.evidence.fieldTypes]
        }
      };
  }
}

function copyCnameCloak(cloak: CnameCloak): CnameCloak {
  return { host: cloak.host, cname: cloak.cname, tracker: copyTracker(cloak.tracker) as TrackerMatch };
}

function copyPixelEvent(pixel: PixelEventSummary): PixelEventSummary {
  return {
    platform: pixel.platform,
    product: pixel.product,
    events: [...pixel.events],
    advancedMatching: [...pixel.advancedMatching],
    requests: pixel.requests
  };
}

function copyPrivacyPolicy(policy: PrivacyPolicySummary): PrivacyPolicySummary {
  return {
    url: policy.url,
    claims: policy.claims.map((claim) => ({ kind: claim.kind, quote: claim.quote })),
    mentionedEntities: [...policy.mentionedEntities],
    unmentionedEntities: [...policy.unmentionedEntities],
    policyTextLength: policy.policyTextLength
  };
}

function copyConsentInteraction(interaction: ConsentInteractionSummary): ConsentInteractionSummary {
  return {
    mode: interaction.mode,
    clicked: interaction.clicked,
    ...(interaction.cmp !== undefined ? { cmp: interaction.cmp } : {}),
    ...(interaction.selector !== undefined ? { selector: interaction.selector } : {}),
    ...(interaction.matchedText !== undefined ? { matchedText: interaction.matchedText } : {}),
    ...(interaction.frameUrl !== undefined ? { frameUrl: interaction.frameUrl } : {})
  };
}

function copyConditions(conditions: ScanConditions): ScanConditions {
  return {
    requestedUrl: conditions.requestedUrl,
    finalUrl: conditions.finalUrl,
    scannedAt: conditions.scannedAt,
    chromiumVersion: conditions.chromiumVersion,
    userAgent: conditions.userAgent,
    timezone: conditions.timezone,
    locale: conditions.locale,
    language: conditions.language,
    viewport: {
      width: conditions.viewport.width,
      height: conditions.viewport.height,
      isMobile: conditions.viewport.isMobile
    },
    gpcEnabled: conditions.gpcEnabled,
    consentMode: conditions.consentMode,
    automation: conditions.automation,
    headless: conditions.headless,
    scannerEgress: conditions.scannerEgress,
    ...(conditions.shieldsMode !== undefined ? { shieldsMode: conditions.shieldsMode } : {}),
    ...(conditions.adblock !== undefined
      ? {
          adblock: {
            active: conditions.adblock.active,
            source: conditions.adblock.source,
            lists: conditions.adblock.lists,
            fetchedAt: conditions.adblock.fetchedAt
          }
        }
      : {}),
    trackerCatalog: {
      source: conditions.trackerCatalog.source,
      version: conditions.trackerCatalog.version,
      region: conditions.trackerCatalog.region,
      entries: conditions.trackerCatalog.entries,
      curatedOverrides: conditions.trackerCatalog.curatedOverrides,
      license: conditions.trackerCatalog.license
    },
    scannerDisclosure: conditions.scannerDisclosure
  };
}

function copyShare(share: ReportShare | undefined): { share?: ReportShare } {
  if (share === undefined) return {};
  return { share: { id: share.id, path: share.path, jsonPath: share.jsonPath } };
}

function copyResult(result: ScanResult): ScanResult {
  return {
    ok: true,
    schemaVersion: result.schemaVersion,
    ...(result.reportType !== undefined ? { reportType: result.reportType } : {}),
    summary: {
      pageTitle: result.summary.pageTitle,
      status: result.summary.status,
      durationMs: result.summary.durationMs,
      firstPartyDomain: result.summary.firstPartyDomain,
      totalRequests: result.summary.totalRequests,
      thirdPartyRequests: result.summary.thirdPartyRequests,
      knownTrackerRequests: result.summary.knownTrackerRequests,
      thirdPartyDomains: result.summary.thirdPartyDomains,
      cookies: result.summary.cookies,
      thirdPartyCookies: result.summary.thirdPartyCookies,
      storageEntries: result.summary.storageEntries,
      fingerprintEvents: result.summary.fingerprintEvents,
      ...(result.summary.shieldsBlockedRequests !== undefined
        ? { shieldsBlockedRequests: result.summary.shieldsBlockedRequests }
        : {})
    },
    conditions: copyConditions(result.conditions),
    requests: result.requests.map(copyRequest),
    domains: result.domains.map(copyDomain),
    cookies: result.cookies.map(copyCookie),
    storage: result.storage.map(copyStorage),
    fingerprintEvents: result.fingerprintEvents.map((event) => ({ api: event.api, count: event.count })),
    ...(result.fingerprintDetections !== undefined
      ? { fingerprintDetections: result.fingerprintDetections.map(copyDetection) }
      : {}),
    ...(result.cnameCloaks !== undefined ? { cnameCloaks: result.cnameCloaks.map(copyCnameCloak) } : {}),
    ...(result.pixelEvents !== undefined ? { pixelEvents: result.pixelEvents.map(copyPixelEvent) } : {}),
    ...(result.privacyPolicy !== undefined ? { privacyPolicy: copyPrivacyPolicy(result.privacyPolicy) } : {}),
    ...(result.consentInteraction !== undefined
      ? { consentInteraction: copyConsentInteraction(result.consentInteraction) }
      : {}),
    // v1's strip-on-save rule, applied structurally: never copied, always null.
    screenshot: null,
    warnings: [...result.warnings],
    ...copyShare(result.share)
  };
}

function copyMetricDelta(delta: ComparisonDiff["totalRequests"]): ComparisonDiff["totalRequests"] {
  return { before: delta.before, after: delta.after, delta: delta.delta };
}

function copyDiff(diff: ComparisonDiff): ComparisonDiff {
  return {
    totalRequests: copyMetricDelta(diff.totalRequests),
    thirdPartyRequests: copyMetricDelta(diff.thirdPartyRequests),
    knownTrackerRequests: copyMetricDelta(diff.knownTrackerRequests),
    thirdPartyDomains: copyMetricDelta(diff.thirdPartyDomains),
    cookies: copyMetricDelta(diff.cookies),
    thirdPartyCookies: copyMetricDelta(diff.thirdPartyCookies),
    storageEntries: copyMetricDelta(diff.storageEntries),
    fingerprintEvents: copyMetricDelta(diff.fingerprintEvents),
    ...(diff.shieldsBlockedRequests !== undefined
      ? { shieldsBlockedRequests: copyMetricDelta(diff.shieldsBlockedRequests) }
      : {}),
    addedDomains: diff.addedDomains.map((change) => ({
      domain: change.domain,
      requests: change.requests,
      tracker: copyTracker(change.tracker)
    })),
    removedDomains: diff.removedDomains.map((change) => ({
      domain: change.domain,
      requests: change.requests,
      tracker: copyTracker(change.tracker)
    })),
    addedEntities: diff.addedEntities.map((change) => ({
      entity: change.entity,
      requests: change.requests,
      domains: change.domains
    })),
    removedEntities: diff.removedEntities.map((change) => ({
      entity: change.entity,
      requests: change.requests,
      domains: change.domains
    })),
    addedCookies: diff.addedCookies.map((change) => ({
      name: change.name,
      domain: change.domain,
      thirdParty: change.thirdParty
    })),
    removedCookies: diff.removedCookies.map((change) => ({
      name: change.name,
      domain: change.domain,
      thirdParty: change.thirdParty
    })),
    addedStorageKeys: diff.addedStorageKeys.map((change) => ({ area: change.area, key: change.key })),
    removedStorageKeys: diff.removedStorageKeys.map((change) => ({ area: change.area, key: change.key })),
    addedFingerprinting: diff.addedFingerprinting.map((change) => ({
      kind: change.kind,
      heuristic: change.heuristic,
      count: change.count
    })),
    removedFingerprinting: diff.removedFingerprinting.map((change) => ({
      kind: change.kind,
      heuristic: change.heuristic,
      count: change.count
    })),
    ...(diff.addedPixelEvents !== undefined
      ? {
          addedPixelEvents: diff.addedPixelEvents.map((change) => ({
            platform: change.platform,
            product: change.product,
            events: [...change.events],
            advancedMatching: [...change.advancedMatching]
          }))
        }
      : {}),
    ...(diff.removedPixelEvents !== undefined
      ? {
          removedPixelEvents: diff.removedPixelEvents.map((change) => ({
            platform: change.platform,
            product: change.product,
            events: [...change.events],
            advancedMatching: [...change.advancedMatching]
          }))
        }
      : {}),
    addedProvenance: diff.addedProvenance.map((change) => ({
      domain: change.domain,
      requests: change.requests,
      tracker: copyTracker(change.tracker),
      initiator: change.initiator,
      script: change.script,
      injectedBy: change.injectedBy
    })),
    removedProvenance: diff.removedProvenance.map((change) => ({
      domain: change.domain,
      requests: change.requests,
      tracker: copyTracker(change.tracker),
      initiator: change.initiator,
      script: change.script,
      injectedBy: change.injectedBy
    }))
  };
}

function copyComparison(report: ComparisonScanResult): ComparisonScanResult {
  return {
    ok: true,
    schemaVersion: report.schemaVersion,
    reportType: "comparison",
    comparisonType: report.comparisonType,
    title: report.title,
    ...(report.runLabels !== undefined
      ? { runLabels: { baseline: report.runLabels.baseline, variant: report.runLabels.variant } }
      : {}),
    requestedUrl: report.requestedUrl,
    scannedAt: report.scannedAt,
    device: report.device,
    baseline: copyResult(report.baseline),
    variant: copyResult(report.variant),
    diff: copyDiff(report.diff),
    warnings: [...report.warnings],
    ...copyShare(report.share)
  };
}

/**
 * Named-field public projection of a v1 report: unknown fields at any level
 * are dropped by construction and screenshots never survive.
 */
export function toPublicScanReportV1(report: ScanReport): ScanReport {
  // Projection and minimization are deliberately separate defenses: first
  // copy only frozen-v1 fields (so tolerant imports cannot smuggle unknown
  // properties), then apply the same idempotent public sanitizer used by
  // producers and managed storage. The sanitizer also rederives comparison
  // diffs from the sanitized arms, so no stale raw key can survive under diff.
  const projected = report.reportType === "comparison" ? copyComparison(report) : copyResult(report);
  return redactScanReportV1(projected).report;
}
