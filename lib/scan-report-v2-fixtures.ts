/**
 * Deterministic ScanReport v2 r1 fixtures (docs/scan-report-v2-rfc.md).
 * Shared by the runtime-validator tests and the JSON Schema differential
 * harness: both must accept every valid fixture and reject every mutant.
 *
 * Derived blocks are built BY THE SHARED EVALUATORS (fingerprints, quality,
 * comparability, diff), never hand-written, so fixtures are internally
 * consistent by construction, exactly as a correct producer would emit them.
 */
import type { ScanReport } from "./types";
import type {
  ArmVerification,
  DetectorLedger,
  EphemeralSingleReport,
  PublicComparisonReportV2,
  PublicSingleReportV2,
  QualityFacts,
  ScanRunV2
} from "./scan-report-v2";
import { buildComparisonDiffV2, evaluateComparability, evaluateQuality } from "./scan-report-v2-evaluators";
import { buildFingerprints } from "./scan-report-v2-fingerprints";

export function makeScanRunV2(
  overrides: { runId?: string; startedAt?: string; shields?: ScanRunV2["conditions"]["shields"] } = {}
): ScanRunV2 {
  const detectors: DetectorLedger = {
    "fingerprint-heuristics": { version: "1", status: "complete" },
    // The probe conditions below are off, so their detectors must not report
    // activity (enforced by the semantic evaluator).
    "keystroke-exfiltration": { version: "1", status: "skipped", reason: "probe-disabled" },
    "cname-uncloaking": { version: "1", status: "complete" },
    "pixel-events": { version: "1", status: "complete" },
    "consent-banner": { version: "1", status: "complete" },
    "privacy-policy": { version: "1", status: "skipped", reason: "probe-disabled" }
  };

  const conditions: ScanRunV2["conditions"] = {
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
  };

  const provenance: ScanRunV2["provenance"] = {
    observer: "node-playwright",
    acquisition: "operator-cli",
    buildCommit: "f".repeat(40),
    methodologyVersion: "2.0",
    detectorRegistry: { version: "1", digest: "d".repeat(64) }
  };

  const toolchain: ScanRunV2["toolchain"] = {
    trackerCatalog: { source: "test", version: "1", entries: 128, digest: "a".repeat(64) },
    adblock: {
      source: "brave",
      lists: 31,
      fetchedAt: "2026-07-01T00:00:00.000Z",
      manifestDigest: "b".repeat(64),
      engineVersion: "0.9.0"
    },
    normalizationVersion: "1"
  };

  const qualityFacts: QualityFacts = {
    status: 200,
    botWallTitleMatched: false,
    navigationSettled: true,
    budgetsExhausted: [],
    captureLoss: []
  };

  return {
    runId: overrides.runId ?? "run-baseline",
    startedAt: overrides.startedAt ?? "2026-07-09T10:00:00.000Z",
    subject: {
      requested: { origin: "https://shop.example.com", registrableDomain: "example.com", routeShape: "/products/{seg}" },
      observed: { origin: "https://shop.example.com", registrableDomain: "example.com", routeShape: "/products/{seg}" }
    },
    conditions,
    provenance,
    toolchain,
    fingerprints: buildFingerprints({ conditions, provenance, toolchain, detectors }),
    qualityFacts,
    // One observed request in the evidence below; the evaluator needs the
    // count to derive empty-load.
    quality: evaluateQuality(qualityFacts, { observedRequests: 1 }),
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
      // Reconciled with the evidence below (one first-party document request).
      counts: {
        totalRequests: 1,
        thirdPartyRequests: 0,
        knownTrackerRequests: 0,
        thirdPartyDomains: 0,
        cookies: 0,
        thirdPartyCookies: 0,
        storageEntries: 0,
        fingerprintEvents: 0
      },
      countsByPhase: [{ phaseId: 0, totalRequests: 1, thirdPartyRequests: 0, knownTrackerRequests: 0 }]
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
      pixelEvents: []
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

/** Minimal well-formed FROZEN v1 single report, for reader/view coverage. */
export function makeScanReportV1(): ScanReport {
  return {
    ok: true,
    schemaVersion: 1,
    reportType: "single",
    summary: {
      pageTitle: "",
      status: 200,
      durationMs: 1,
      firstPartyDomain: "example.com",
      totalRequests: 1,
      thirdPartyRequests: 0,
      knownTrackerRequests: 0,
      thirdPartyDomains: 0,
      cookies: 0,
      thirdPartyCookies: 0,
      storageEntries: 0,
      fingerprintEvents: 0
    },
    conditions: {
      requestedUrl: "https://example.com/",
      finalUrl: "https://example.com/",
      scannedAt: "2026-07-09T10:00:00.000Z",
      chromiumVersion: "test",
      userAgent: "test",
      timezone: "UTC",
      locale: "en-US",
      language: "en-US",
      viewport: { width: 1440, height: 980, isMobile: false },
      gpcEnabled: false,
      consentMode: "observe",
      automation: "playwright-chromium",
      headless: true,
      scannerEgress: "test",
      trackerCatalog: { source: "t", version: "1", region: "t", entries: 0, curatedOverrides: 0, license: "t" },
      scannerDisclosure: "test"
    },
    requests: [],
    domains: [],
    cookies: [],
    storage: [],
    fingerprintEvents: [],
    screenshot: null,
    warnings: []
  };
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

/** RFC example 12.1: Shields off/on while GPC stays enabled. */
export function makeInterventionComparisonReportV2(): PublicComparisonReportV2 {
  const baseline = makeScanRunV2({ runId: "run-baseline", shields: "classification" });
  const variant = makeScanRunV2({ runId: "run-variant", startedAt: "2026-07-09T10:01:00.000Z", shields: "block-simulation" });
  const experiment: PublicComparisonReportV2["experiment"] = {
    kind: "intervention",
    axis: "shields",
    pairId: "pair-shields",
    order: "AB",
    verification: {
      baseline: makeArmVerification(),
      variant: makeArmVerification({ expected: "shields:block-simulation", observed: "shields:block-simulation" })
    },
    evidence: { pairs: 1, counterbalanced: false, strength: "observed-difference" }
  };
  const comparability = evaluateComparability(experiment, baseline, variant);
  return {
    schemaVersion: 2,
    schemaRevision: 1,
    reportType: "comparison",
    baseline,
    variant,
    experiment,
    comparability,
    diff: buildComparisonDiffV2(baseline, variant, comparability.perMetric)
  };
}

/** RFC example 12.3: temporal pair, no axis, no order, no verification. */
export function makeTemporalComparisonReportV2(): PublicComparisonReportV2 {
  const baseline = makeScanRunV2({ runId: "run-earlier", startedAt: "2026-06-18T10:00:00.000Z" });
  const variant = makeScanRunV2({ runId: "run-later", startedAt: "2026-07-09T10:00:00.000Z" });
  const experiment: PublicComparisonReportV2["experiment"] = { kind: "temporal", pairId: "pair-temporal" };
  const comparability = evaluateComparability(experiment, baseline, variant);
  return {
    schemaVersion: 2,
    schemaRevision: 1,
    reportType: "comparison",
    baseline,
    variant,
    experiment,
    comparability,
    diff: buildComparisonDiffV2(baseline, variant, comparability.perMetric)
  };
}

/** RFC example 12.4: descriptive upload, never causal. */
export function makeDescriptiveComparisonReportV2(): PublicComparisonReportV2 {
  const baseline = makeScanRunV2({ runId: "run-a" });
  const variant = makeScanRunV2({ runId: "run-b", startedAt: "2026-07-09T10:02:00.000Z" });
  const experiment: PublicComparisonReportV2["experiment"] = {
    kind: "descriptive",
    pairId: "pair-descriptive",
    sourceOrder: "as-provided"
  };
  const comparability = evaluateComparability(experiment, baseline, variant);
  return {
    schemaVersion: 2,
    schemaRevision: 1,
    reportType: "comparison",
    baseline,
    variant,
    experiment,
    comparability,
    diff: buildComparisonDiffV2(baseline, variant, comparability.perMetric)
  };
}
