/** Deterministic scanner-to-runtime-builder fixtures used by API/job tests. */
import { makeScanReportV1 } from "./scan-report-v2-fixtures";
import { DETECTOR_VERSIONS } from "./measurement-kernel";
import type { ConsentFactsR2 } from "./scan-result-v2-r2-builder";
import {
  createNodeScanMeasurementEnvelope,
  type NodeScanMeasurement,
  type NodeScanMeasurementEnvelope
} from "./node-scan-measurement";
import type { ScanRunV2R2 } from "./scan-report-v2-r2";
import { DETECTOR_IDS } from "./scan-report-v2";
import type { ScanResult } from "./types";
import { makeScanRunV2R2 } from "./scan-report-v2-r2-fixtures";

export function scanMeasurementEnvelopeWithR2Run(
  source: ScanRunV2R2,
  screenshot = "data:image/png;base64,RUNTIME_PRIVATE"
): NodeScanMeasurementEnvelope {
  const run = structuredClone(source);
  const { consent, ...evidence } = run.evidence;
  for (const id of DETECTOR_IDS) run.detectors[id].version = DETECTOR_VERSIONS[id];
  const passivePhaseId = run.phases.find((phase) => phase.kind === "passive-load")?.phaseId;
  if (passivePhaseId === undefined) throw new Error("runtime r2 fixture requires a passive-load phase");

  const measurement: NodeScanMeasurement = {
    measurement: {
      phases: run.phases,
      detectors: run.detectors,
      qualityFacts: run.qualityFacts
    },
    evidence,
    ...(consent !== undefined ? { consent: consentFacts(consent) } : {}),
    verificationFacts: {
      gpc: run.verificationFacts?.gpc ?? {
        method: "gpc-header-readback@1",
        header: run.conditions.gpc ? "confirmed-present" : "confirmed-absent",
        jsSignal: run.conditions.gpc ? "confirmed-true" : "confirmed-absent",
        observedOn: "first-party-navigation",
        phaseId: passivePhaseId
      },
      shields: run.verificationFacts?.shields ?? {
        method: "shields-engine-status@1",
        engineLoaded: true,
        applied: run.conditions.shields === "block-simulation",
        requestsEvaluated: run.evidence.requests.length,
        requestsMatched: 0,
        requestsActuallyBlocked: 0,
        phaseId: passivePhaseId
      }
    },
    emissionInputs: {
      startedAt: run.startedAt,
      requestedUrl: "https://shop.example.com/products/runtime-private?token=secret",
      observedUrl: "https://shop.example.com/products/runtime-private?session=secret",
      conditions: run.conditions,
      adblockEngineLoaded: true,
      pageTitle: run.summary.pageTitle,
      durationMs: run.summary.durationMs,
      warnings: run.warnings,
      screenshot
    }
  };

  const v1 = makeScanReportV1();
  if (v1.reportType === "comparison") throw new Error("expected a single v1 fixture");
  const result: ScanResult = {
    ...v1,
    summary: { ...v1.summary, status: run.qualityFacts.status },
    conditions: {
      ...v1.conditions,
      scannedAt: run.startedAt,
      chromiumVersion: run.conditions.browser.version,
      timezone: run.conditions.timezone,
      locale: run.conditions.locale,
      language: run.conditions.language,
      viewport: { ...run.conditions.device.viewport },
      gpcEnabled: run.conditions.gpc,
      consentMode: run.conditions.consent,
      automation: run.conditions.automation,
      headless: run.conditions.headless,
      scannerEgress: run.conditions.egress.label,
      shieldsMode: nodeShieldsMode(run.conditions.shields)
    },
    screenshot
  };
  return createNodeScanMeasurementEnvelope(result, measurement);
}

/** Explicit envelope adapter for v1-only orchestration tests. */
export function testMeasurementEnvelopeForResult(result: ScanResult): NodeScanMeasurementEnvelope {
  const template = scanMeasurementEnvelopeWithR2Run(makeScanRunV2R2());
  const measurement = structuredClone(template.measurement) as NodeScanMeasurement;
  measurement.measurement.qualityFacts.status = result.summary.status;
  measurement.emissionInputs = {
    ...measurement.emissionInputs,
    startedAt: result.conditions.scannedAt,
    requestedUrl: result.conditions.requestedUrl,
    observedUrl: result.conditions.finalUrl,
    conditions: {
      ...measurement.emissionInputs.conditions,
      gpc: result.conditions.gpcEnabled,
      shields: result.conditions.shieldsMode ?? "classification",
      consent: result.conditions.consentMode,
      device: {
        kind: result.conditions.viewport.isMobile ? "mobile" : "desktop",
        viewport: { ...result.conditions.viewport }
      },
      locale: result.conditions.locale,
      language: result.conditions.language,
      timezone: result.conditions.timezone,
      egress: { label: result.conditions.scannerEgress },
      browser: { name: "chromium", version: result.conditions.chromiumVersion },
      headless: result.conditions.headless,
      automation: result.conditions.automation
    },
    pageTitle: result.summary.pageTitle,
    durationMs: result.summary.durationMs,
    warnings: [...result.warnings],
    screenshot: result.screenshot
  };
  return createNodeScanMeasurementEnvelope(result, measurement);
}

function nodeShieldsMode(value: ScanRunV2R2["conditions"]["shields"]): "classification" | "block-simulation" {
  if (value === "off") throw new Error("runtime Node fixture cannot use the non-Node Shields-off condition");
  return value;
}

function consentFacts(consent: NonNullable<ScanRunV2R2["evidence"]["consent"]>): ConsentFactsR2 {
  return {
    interactionAttempted: consent.interactionAttempted,
    controlActivated: consent.controlActivated,
    verificationObservations: consent.verificationObservations.map((observation) => {
      if (observation.result === undefined) throw new Error("runtime r2 fixture requires observation results");
      return {
        phaseId: observation.phaseId,
        method: observation.method,
        observed: observation.observed,
        result: observation.result
      };
    }),
    ...(consent.bannerTransition !== undefined ? { bannerTransition: consent.bannerTransition } : {})
  };
}
