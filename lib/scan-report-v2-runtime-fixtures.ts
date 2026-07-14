/** Deterministic scanner-to-runtime-builder fixtures used by API/job tests. */
import { makeScanReportV1 } from "./scan-report-v2-fixtures";
import { DETECTOR_VERSIONS } from "./measurement-kernel";
import type { ConsentFactsR2 } from "./scan-result-v2-r2-builder";
import {
  attachStagedSingleVisitMeasurement,
  type StagedSingleVisitMeasurement
} from "./scanner";
import type { ScanRunV2R2 } from "./scan-report-v2-r2";
import { DETECTOR_IDS } from "./scan-report-v2";
import type { ScanResult } from "./types";

export function scanResultWithStagedR2Run(
  source: ScanRunV2R2,
  screenshot = "data:image/png;base64,RUNTIME_PRIVATE"
): ScanResult {
  const run = structuredClone(source);
  const { consent, ...evidence } = run.evidence;
  for (const id of DETECTOR_IDS) run.detectors[id].version = DETECTOR_VERSIONS[id];
  const passivePhaseId = run.phases.find((phase) => phase.kind === "passive-load")?.phaseId;
  if (passivePhaseId === undefined) throw new Error("runtime r2 fixture requires a passive-load phase");

  const staged: StagedSingleVisitMeasurement = {
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
  return attachStagedSingleVisitMeasurement({ ...v1, screenshot }, staged);
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
