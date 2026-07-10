/**
 * Deterministic ScanReport v2 r1 fixtures (docs/scan-report-v2-rfc.md).
 * Shared by the runtime-validator tests today and the JSON Schema differential
 * harness (RFC 10.3) once the generated schema lands: both must accept every
 * valid fixture and reject every mutant, so keep builders here rather than
 * inline in one test file.
 */
import type {
  ArmVerification,
  DetectorLedger,
  EphemeralSingleReport,
  Experiment,
  PublicComparisonReportV2,
  PublicSingleReportV2,
  ScanRunV2
} from "./scan-report-v2";
import { DETECTOR_IDS } from "./scan-report-v2";

export function makeScanRunV2(overrides: { runId?: string; startedAt?: string; shields?: ScanRunV2["conditions"]["shields"] } = {}): ScanRunV2 {
  const detectors = Object.fromEntries(
    DETECTOR_IDS.map((id) => [id, { version: "1", status: "complete" as const }])
  ) as DetectorLedger;

  return {
    runId: overrides.runId ?? "run-baseline",
    startedAt: overrides.startedAt ?? "2026-07-09T10:00:00.000Z",
    subject: {
      requested: { origin: "https://shop.example.com", registrableDomain: "example.com", routeShape: "/products/{seg}" },
      observed: { origin: "https://shop.example.com", registrableDomain: "example.com", routeShape: "/products/{seg}" }
    },
    conditions: {
      gpc: true,
      shields: overrides.shields ?? "classification",
      consent: "observe",
      device: { kind: "desktop", viewport: { width: 1440, height: 980, isMobile: false } },
      probes: { keystroke: false, policyVisit: false },
      locale: "en-US",
      language: "en-US",
      timezone: "UTC",
      egress: { label: "test", region: "us" },
      browser: { name: "chromium", version: "126.0.0.0" },
      headless: true,
      automation: "playwright-chromium"
    },
    provenance: {
      observer: "node-playwright",
      acquisition: "operator-cli",
      buildCommit: "f".repeat(40),
      methodologyVersion: "2.0",
      detectorRegistry: { version: "1", digest: "d".repeat(64) }
    },
    toolchain: {
      trackerCatalog: { source: "test", version: "1", entries: 128, digest: "a".repeat(64) },
      adblock: {
        source: "brave",
        lists: 31,
        fetchedAt: "2026-07-01T00:00:00.000Z",
        manifestDigest: "b".repeat(64),
        engineVersion: "0.9.0"
      },
      normalizationVersion: "1"
    },
    fingerprints: { execution: "e".repeat(64), measurementEnvironment: "m".repeat(64), condition: "c".repeat(64) },
    qualityFacts: {
      status: 200,
      botWallTitleMatched: false,
      navigationSettled: true,
      budgetsExhausted: [],
      captureLoss: []
    },
    quality: {
      evaluatorVersion: "1",
      run: { outcome: "complete", reasons: [] },
      byFamily: {
        requests: { outcome: "complete", reasons: [] },
        cookies: { outcome: "complete", reasons: [] },
        storage: { outcome: "complete", reasons: [] },
        fingerprinting: { outcome: "complete", reasons: [] },
        "detector-output": { outcome: "complete", reasons: [] },
        "consent-verification": { outcome: "complete", reasons: [] }
      }
    },
    privacy: {
      redactionVersion: 2,
      redaction: {
        pathSegmentsGeneralized: 1,
        queryKeysRedacted: 0,
        storageKeysRedacted: 0,
        cookieNamesRedacted: 0,
        matrixParamsStripped: 0,
        subdomainLabelsGeneralized: 0,
        malformedUrlsDropped: 0
      }
    },
    detectors,
    phases: [{ phaseId: 0, kind: "passive-load", startedAtMs: 0, endedAtMs: 5000 }],
    summary: {
      pageTitle: "Example Shop",
      status: 200,
      durationMs: 5000,
      counts: {
        totalRequests: 12,
        thirdPartyRequests: 4,
        knownTrackerRequests: 2,
        thirdPartyDomains: 2,
        cookies: 1,
        thirdPartyCookies: 0,
        storageEntries: 1,
        fingerprintEvents: 0
      },
      countsByPhase: [{ phaseId: 0, totalRequests: 12, thirdPartyRequests: 4, knownTrackerRequests: 2 }]
    },
    evidence: {
      requests: [
        {
          id: 1,
          url: "https://shop.example.com/products/{seg}",
          domain: "shop.example.com",
          method: "GET",
          resourceType: "document",
          status: 200,
          thirdParty: false,
          tracker: null,
          startedAtMs: 10,
          phaseId: 0
        }
      ],
      cookieMutations: [],
      cookiesFinal: [],
      storageMutations: [],
      storageFinal: [],
      fingerprintEvents: [],
      fingerprintDetections: [],
      cnameCloaks: [],
      pixelEvents: [],
    },
    warnings: []
  };
}

export function makePublicSingleReportV2(): PublicSingleReportV2 {
  return { schemaVersion: 2, schemaRevision: 1, reportType: "single", run: makeScanRunV2() };
}

export function makeEphemeralSingleReport(): EphemeralSingleReport {
  return { ...makePublicSingleReportV2(), ephemeral: { screenshot: "data:image/png;base64,AAAA" } };
}

function makeArmVerification(overrides: Partial<ArmVerification> = {}): ArmVerification {
  return {
    axis: "shields",
    expected: "shields:classification",
    observed: "shields:classification",
    method: "shields-engine-status@1",
    outcome: "passed",
    phaseId: 0,
    ...overrides
  };
}

function makeComparability(experimentKind: Experiment["kind"]): PublicComparisonReportV2["comparability"] {
  return {
    evaluatorVersion: "1",
    metricRegistryVersion: "1",
    pairValidity: { eligible: true, reasons: [] },
    perMetric: {
      "raw-counts": { eligible: true, reasons: [] },
      "tracker-classification": { eligible: true, reasons: [] },
      "shields-simulation": { eligible: true, reasons: [] },
      "consent-verification": { eligible: true, reasons: [] },
      "detector-findings": { eligible: true, reasons: [] }
    },
    ...(experimentKind === "intervention" ? { interventionVerified: true } : {})
  };
}

/** RFC example 12.1: Shields off/on while GPC stays enabled. */
export function makeInterventionComparisonReportV2(): PublicComparisonReportV2 {
  return {
    schemaVersion: 2,
    schemaRevision: 1,
    reportType: "comparison",
    baseline: makeScanRunV2({ runId: "run-baseline", shields: "classification" }),
    variant: makeScanRunV2({ runId: "run-variant", startedAt: "2026-07-09T10:01:00.000Z", shields: "block-simulation" }),
    experiment: {
      kind: "intervention",
      axis: "shields",
      pairId: "pair-shields",
      order: "AB",
      verification: {
        baseline: makeArmVerification(),
        variant: makeArmVerification({ expected: "shields:block-simulation", observed: "shields:block-simulation" })
      },
      evidence: { pairs: 1, counterbalanced: false, strength: "observed-difference" }
    },
    comparability: makeComparability("intervention"),
    diff: {}
  };
}

/** RFC example 12.3: temporal pair, no axis, no order, no verification. */
export function makeTemporalComparisonReportV2(): PublicComparisonReportV2 {
  return {
    schemaVersion: 2,
    schemaRevision: 1,
    reportType: "comparison",
    baseline: makeScanRunV2({ runId: "run-earlier", startedAt: "2026-06-18T10:00:00.000Z" }),
    variant: makeScanRunV2({ runId: "run-later", startedAt: "2026-07-09T10:00:00.000Z" }),
    experiment: { kind: "temporal", pairId: "pair-temporal" },
    comparability: makeComparability("temporal"),
    diff: {}
  };
}

/** RFC example 12.4: descriptive upload, never causal. */
export function makeDescriptiveComparisonReportV2(): PublicComparisonReportV2 {
  return {
    schemaVersion: 2,
    schemaRevision: 1,
    reportType: "comparison",
    baseline: makeScanRunV2({ runId: "run-a" }),
    variant: makeScanRunV2({ runId: "run-b" }),
    experiment: { kind: "descriptive", pairId: "pair-descriptive", sourceOrder: "as-provided" },
    comparability: makeComparability("descriptive"),
    diff: {}
  };
}
