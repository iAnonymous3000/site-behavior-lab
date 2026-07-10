/**
 * Tier 1 -> Tier 2 public projection (docs/scan-report-v2-rfc.md, section 8).
 *
 * Copies NAMED FIELDS ONLY at every level it defines, so the ephemeral block
 * and any unknown/new field are dropped by construction; a future ephemeral
 * addition cannot leak into a persisted report by default. This is defense in
 * depth on top of the sanitizer (which runs at the raw -> sanitized boundary),
 * and the strict public validator rejects anything that still carries extras.
 *
 * The one deliberate exception is `diff`: its shape is non-normative until
 * implementation step 2 (RFC 10.5), so it is deep-cloned as-is here and gains
 * its own allowlist copier together with its normative shape.
 */
import type {
  CnameCloak,
  CookieRecord,
  FingerprintDetectionSummary,
  NetworkRequestRecord,
  PixelEventSummary,
  PrivacyPolicySummary,
  ReportShare,
  StorageRecord,
  TrackerMatch
} from "./types";
import {
  DETECTOR_IDS,
  METRIC_FAMILIES,
  EVIDENCE_FAMILIES,
  type Comparability,
  type ConditionVector,
  type ConsentEvidence,
  type DetectorLedger,
  type EphemeralComparisonReport,
  type EphemeralScanReport,
  type EphemeralSingleReport,
  type Experiment,
  type Fingerprints,
  type PhaseId,
  type PhaseSpan,
  type PrivacyStats,
  type Provenance,
  type PublicComparisonReportV2,
  type PublicScanReportV2,
  type PublicSingleReportV2,
  type Quality,
  type QualityFacts,
  type RunEvidence,
  type RunSummary,
  type ScanRunV2,
  type SubjectIdentity,
  type Toolchain
} from "./scan-report-v2";

function copySubject(subject: SubjectIdentity): SubjectIdentity {
  return {
    requested: {
      origin: subject.requested.origin,
      registrableDomain: subject.requested.registrableDomain,
      routeShape: subject.requested.routeShape
    },
    observed: {
      origin: subject.observed.origin,
      registrableDomain: subject.observed.registrableDomain,
      routeShape: subject.observed.routeShape
    }
  };
}

function copyConditions(conditions: ConditionVector): ConditionVector {
  return {
    gpc: conditions.gpc,
    shields: conditions.shields,
    consent: conditions.consent,
    device: {
      kind: conditions.device.kind,
      viewport: {
        width: conditions.device.viewport.width,
        height: conditions.device.viewport.height,
        isMobile: conditions.device.viewport.isMobile
      }
    },
    probes: { keystroke: conditions.probes.keystroke, policyVisit: conditions.probes.policyVisit },
    locale: conditions.locale,
    language: conditions.language,
    timezone: conditions.timezone,
    egress: {
      label: conditions.egress.label,
      ...(conditions.egress.region !== undefined ? { region: conditions.egress.region } : {})
    },
    browser: { name: conditions.browser.name, version: conditions.browser.version },
    headless: conditions.headless,
    automation: conditions.automation
  };
}

function copyProvenance(provenance: Provenance): Provenance {
  return {
    observer: provenance.observer,
    acquisition: provenance.acquisition,
    buildCommit: provenance.buildCommit,
    methodologyVersion: provenance.methodologyVersion,
    detectorRegistry: { version: provenance.detectorRegistry.version, digest: provenance.detectorRegistry.digest },
    ...(provenance.sourceArtifactDigest !== undefined ? { sourceArtifactDigest: provenance.sourceArtifactDigest } : {})
  };
}

function copyToolchain(toolchain: Toolchain): Toolchain {
  return {
    trackerCatalog: {
      source: toolchain.trackerCatalog.source,
      version: toolchain.trackerCatalog.version,
      entries: toolchain.trackerCatalog.entries,
      digest: toolchain.trackerCatalog.digest
    },
    adblock:
      toolchain.adblock === null
        ? null
        : {
            source: toolchain.adblock.source,
            lists: toolchain.adblock.lists,
            fetchedAt: toolchain.adblock.fetchedAt,
            manifestDigest: toolchain.adblock.manifestDigest,
            engineVersion: toolchain.adblock.engineVersion
          },
    normalizationVersion: toolchain.normalizationVersion
  };
}

function copyFingerprints(fingerprints: Fingerprints): Fingerprints {
  return {
    execution: fingerprints.execution,
    measurementEnvironment: fingerprints.measurementEnvironment,
    condition: fingerprints.condition
  };
}

function copyQualityFacts(facts: QualityFacts): QualityFacts {
  return {
    status: facts.status,
    botWallTitleMatched: facts.botWallTitleMatched,
    navigationSettled: facts.navigationSettled,
    budgetsExhausted: [...facts.budgetsExhausted],
    captureLoss: facts.captureLoss.map((entry) => ({
      family: entry.family,
      phaseId: entry.phaseId,
      kind: entry.kind,
      count: entry.count,
      ...(entry.detail !== undefined ? { detail: entry.detail } : {})
    }))
  };
}

function copyQuality(quality: Quality): Quality {
  return {
    evaluatorVersion: quality.evaluatorVersion,
    run: { outcome: quality.run.outcome, reasons: [...quality.run.reasons] },
    byFamily: Object.fromEntries(
      EVIDENCE_FAMILIES.map((family) => [
        family,
        { outcome: quality.byFamily[family].outcome, reasons: [...quality.byFamily[family].reasons] }
      ])
    ) as Quality["byFamily"]
  };
}

function copyPrivacy(privacy: PrivacyStats): PrivacyStats {
  return {
    redactionVersion: privacy.redactionVersion,
    redaction: {
      pathSegmentsGeneralized: privacy.redaction.pathSegmentsGeneralized,
      queryKeysRedacted: privacy.redaction.queryKeysRedacted,
      storageKeysRedacted: privacy.redaction.storageKeysRedacted,
      cookieNamesRedacted: privacy.redaction.cookieNamesRedacted,
      matrixParamsStripped: privacy.redaction.matrixParamsStripped,
      subdomainLabelsGeneralized: privacy.redaction.subdomainLabelsGeneralized,
      malformedUrlsDropped: privacy.redaction.malformedUrlsDropped
    }
  };
}

function copyDetectors(detectors: DetectorLedger): DetectorLedger {
  return Object.fromEntries(
    DETECTOR_IDS.map((id) => {
      const entry = detectors[id];
      return [
        id,
        {
          version: entry.version,
          status: entry.status,
          ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
          ...(entry.phaseId !== undefined ? { phaseId: entry.phaseId } : {})
        }
      ];
    })
  ) as DetectorLedger;
}

function copyPhases(phases: PhaseSpan[]): PhaseSpan[] {
  return phases.map((span) => ({
    phaseId: span.phaseId,
    kind: span.kind,
    startedAtMs: span.startedAtMs,
    endedAtMs: span.endedAtMs
  }));
}

function copySummary(summary: RunSummary): RunSummary {
  return {
    pageTitle: summary.pageTitle,
    status: summary.status,
    durationMs: summary.durationMs,
    counts: {
      totalRequests: summary.counts.totalRequests,
      thirdPartyRequests: summary.counts.thirdPartyRequests,
      knownTrackerRequests: summary.counts.knownTrackerRequests,
      thirdPartyDomains: summary.counts.thirdPartyDomains,
      cookies: summary.counts.cookies,
      thirdPartyCookies: summary.counts.thirdPartyCookies,
      storageEntries: summary.counts.storageEntries,
      fingerprintEvents: summary.counts.fingerprintEvents,
      ...(summary.counts.shieldsBlockedRequests !== undefined
        ? { shieldsBlockedRequests: summary.counts.shieldsBlockedRequests }
        : {})
    },
    countsByPhase: summary.countsByPhase.map((entry) => ({
      phaseId: entry.phaseId,
      totalRequests: entry.totalRequests,
      thirdPartyRequests: entry.thirdPartyRequests,
      knownTrackerRequests: entry.knownTrackerRequests
    }))
  };
}

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

function copyRequest(request: NetworkRequestRecord & { phaseId: PhaseId }): NetworkRequestRecord & { phaseId: PhaseId } {
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
    startedAtMs: request.startedAtMs,
    phaseId: request.phaseId
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

function copyDetection(
  detection: FingerprintDetectionSummary & { phaseId: PhaseId }
): FingerprintDetectionSummary & { phaseId: PhaseId } {
  const base = { count: detection.count, phaseId: detection.phaseId };
  switch (detection.kind) {
    case "canvas-fingerprinting":
      return {
        kind: detection.kind,
        ...base,
        heuristic: detection.heuristic,
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
        ...base,
        heuristic: detection.heuristic,
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
        ...base,
        heuristic: detection.heuristic,
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
        ...base,
        heuristic: detection.heuristic,
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
        ...base,
        heuristic: detection.heuristic,
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
        ...base,
        heuristic: detection.heuristic,
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
        ...base,
        heuristic: detection.heuristic,
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
        ...base,
        heuristic: detection.heuristic,
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

function copyPixelEvent(pixel: PixelEventSummary & { phaseId: PhaseId }): PixelEventSummary & { phaseId: PhaseId } {
  return {
    platform: pixel.platform,
    product: pixel.product,
    events: [...pixel.events],
    advancedMatching: [...pixel.advancedMatching],
    requests: pixel.requests,
    phaseId: pixel.phaseId
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

function copyConsent(consent: ConsentEvidence): ConsentEvidence {
  return {
    mode: consent.mode,
    interactionAttempted: consent.interactionAttempted,
    controlActivated: consent.controlActivated,
    verificationObservations: consent.verificationObservations.map((observation) => ({
      phaseId: observation.phaseId,
      method: observation.method,
      observed: observation.observed,
      consistentWithChoice: observation.consistentWithChoice
    })),
    choiceState: consent.choiceState,
    reverifiedAfterReload: consent.reverifiedAfterReload,
    ...(consent.verificationFailureReason !== undefined
      ? { verificationFailureReason: consent.verificationFailureReason }
      : {}),
    ...(consent.cmp !== undefined ? { cmp: consent.cmp } : {}),
    ...(consent.selector !== undefined ? { selector: consent.selector } : {}),
    ...(consent.matchedText !== undefined ? { matchedText: consent.matchedText } : {}),
    ...(consent.frameUrl !== undefined ? { frameUrl: consent.frameUrl } : {})
  };
}

function copyEvidence(evidence: RunEvidence): RunEvidence {
  return {
    requests: evidence.requests.map(copyRequest),
    cookieMutations: evidence.cookieMutations.map((mutation) => ({
      phaseId: mutation.phaseId,
      op: mutation.op,
      cookie: copyCookie(mutation.cookie)
    })),
    cookiesFinal: evidence.cookiesFinal.map(copyCookie),
    storageMutations: evidence.storageMutations.map((mutation) => ({
      phaseId: mutation.phaseId,
      op: mutation.op,
      entry: copyStorage(mutation.entry)
    })),
    storageFinal: evidence.storageFinal.map(copyStorage),
    fingerprintEvents: evidence.fingerprintEvents.map((event) => ({
      api: event.api,
      count: event.count,
      phaseId: event.phaseId
    })),
    fingerprintDetections: evidence.fingerprintDetections.map(copyDetection),
    cnameCloaks: evidence.cnameCloaks.map(copyCnameCloak),
    pixelEvents: evidence.pixelEvents.map(copyPixelEvent),
    ...(evidence.privacyPolicy !== undefined ? { privacyPolicy: copyPrivacyPolicy(evidence.privacyPolicy) } : {}),
    ...(evidence.consent !== undefined ? { consent: copyConsent(evidence.consent) } : {})
  };
}

export function copyScanRunV2(run: ScanRunV2): ScanRunV2 {
  return {
    runId: run.runId,
    startedAt: run.startedAt,
    subject: copySubject(run.subject),
    conditions: copyConditions(run.conditions),
    provenance: copyProvenance(run.provenance),
    toolchain: copyToolchain(run.toolchain),
    fingerprints: copyFingerprints(run.fingerprints),
    qualityFacts: copyQualityFacts(run.qualityFacts),
    quality: copyQuality(run.quality),
    privacy: copyPrivacy(run.privacy),
    detectors: copyDetectors(run.detectors),
    phases: copyPhases(run.phases),
    summary: copySummary(run.summary),
    evidence: copyEvidence(run.evidence),
    warnings: [...run.warnings]
  };
}

function copyExperiment(experiment: Experiment): Experiment {
  if (experiment.kind === "intervention") {
    const copyArm = (arm: typeof experiment.verification.baseline) => ({
      axis: arm.axis,
      expected: arm.expected,
      observed: arm.observed,
      method: arm.method,
      outcome: arm.outcome,
      phaseId: arm.phaseId
    });
    return {
      kind: "intervention",
      axis: experiment.axis,
      pairId: experiment.pairId,
      order: experiment.order,
      verification: {
        baseline: copyArm(experiment.verification.baseline),
        variant: copyArm(experiment.verification.variant)
      },
      evidence: {
        pairs: experiment.evidence.pairs,
        counterbalanced: experiment.evidence.counterbalanced,
        strength: experiment.evidence.strength
      }
    };
  }
  if (experiment.kind === "temporal") {
    return { kind: "temporal", pairId: experiment.pairId };
  }
  return { kind: "descriptive", pairId: experiment.pairId, sourceOrder: experiment.sourceOrder };
}

function copyComparability(comparability: Comparability): Comparability {
  return {
    evaluatorVersion: comparability.evaluatorVersion,
    metricRegistryVersion: comparability.metricRegistryVersion,
    pairValidity: { eligible: comparability.pairValidity.eligible, reasons: [...comparability.pairValidity.reasons] },
    perMetric: Object.fromEntries(
      METRIC_FAMILIES.map((family) => [
        family,
        { eligible: comparability.perMetric[family].eligible, reasons: [...comparability.perMetric[family].reasons] }
      ])
    ) as Comparability["perMetric"],
    ...(comparability.interventionVerified !== undefined
      ? { interventionVerified: comparability.interventionVerified }
      : {})
  };
}

function copyShare(share: ReportShare | undefined): { share?: ReportShare } {
  if (share === undefined) return {};
  return { share: { id: share.id, path: share.path, jsonPath: share.jsonPath } };
}

export function toPublicScanReport(report: EphemeralSingleReport): PublicSingleReportV2;
export function toPublicScanReport(report: EphemeralComparisonReport): PublicComparisonReportV2;
export function toPublicScanReport(report: EphemeralScanReport): PublicScanReportV2;
export function toPublicScanReport(report: EphemeralScanReport): PublicScanReportV2 {
  if (report.reportType === "single") {
    return {
      schemaVersion: report.schemaVersion,
      schemaRevision: report.schemaRevision,
      reportType: "single",
      run: copyScanRunV2(report.run),
      ...copyShare(report.share)
    };
  }
  return {
    schemaVersion: report.schemaVersion,
    schemaRevision: report.schemaRevision,
    reportType: "comparison",
    baseline: copyScanRunV2(report.baseline),
    variant: copyScanRunV2(report.variant),
    experiment: copyExperiment(report.experiment),
    comparability: copyComparability(report.comparability),
    // Non-normative until step 2 (RFC 10.5): cloned as-is, gains its own
    // allowlist copier together with its normative shape.
    diff: structuredClone(report.diff),
    ...copyShare(report.share)
  };
}
