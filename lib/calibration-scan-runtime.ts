import {
  consentBannerObserveCalibrationFact,
  type NodeScanMeasurementEnvelope
} from "./node-scan-measurement";
import { buildRuntimeScanReportV2R2 } from "./scan-report-v2-runtime-builder";
import type { DetectorId } from "./scan-report-v2";
import { scanSiteWithMeasurement } from "./scanner";
import type { ScanRequestPayload } from "./types";

export type CalibrationDetectorPrediction =
  | {
      outcome: "complete";
      value: "detected" | "not-detected";
    }
  | {
      outcome: "censored";
      reason: "eligibility-criteria-not-met";
    };

export class CalibrationMeasurementInvariantError extends Error {
  readonly code = "CALIBRATION_MEASUREMENT_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "CalibrationMeasurementInvariantError";
  }
}

/**
 * The controlled calibration entrypoint. Public r2 and the private detector
 * result are derived from the same process-local envelope; the envelope itself
 * never crosses an HTTP or serialization boundary.
 */
export async function scanCalibrationCase(
  payload: ScanRequestPayload,
  detector: DetectorId
) {
  const envelope = await scanSiteWithMeasurement(payload);
  const report = buildRuntimeScanReportV2R2(envelope, "ci-workflow");
  const consentObservation =
    detector === "consent-banner"
      ? consentBannerObserveCalibrationFact(envelope)
      : undefined;
  return {
    report,
    consentBannerPrediction:
      detector === "consent-banner"
        ? consentBannerPredictionFromMeasurement(envelope)
        : null,
    consentBannerObservation: consentObservation ?? null
  };
}

export function consentBannerPredictionFromMeasurement(
  envelope: NodeScanMeasurementEnvelope
): CalibrationDetectorPrediction {
  const measurement = envelope.measurement;
  const detector = measurement.measurement.detectors["consent-banner"];
  const output = consentBannerObserveCalibrationFact(envelope);

  invariant(
    measurement.emissionInputs.conditions.consent === "observe",
    "consent-banner calibration requires the passive observe condition"
  );
  if (detector.status !== "complete") {
    invariant(
      output === undefined,
      "a censored consent-banner detector cannot carry a completed calibration result"
    );
    return {
      outcome: "censored",
      reason: "eligibility-criteria-not-met"
    };
  }

  invariant(
    output !== undefined,
    "a complete consent-banner detector is missing its process-local calibration result"
  );
  exactKeys(
    output,
    ["detector", "method", "phaseId", "outcome", "visible"],
    "consent-banner calibration result"
  );
  invariant(
    output.detector === "consent-banner" &&
      output.method === "banner-visibility@1" &&
      output.outcome === "complete" &&
      Number.isSafeInteger(output.phaseId) &&
      output.phaseId >= 0 &&
      typeof output.visible === "boolean",
    "consent-banner calibration result has an invalid closed shape"
  );
  invariant(
    detector.phaseId === output.phaseId,
    "consent-banner calibration result does not match the detector phase"
  );
  const phases = measurement.measurement.phases.filter(
    (phase) => phase.phaseId === output.phaseId
  );
  invariant(
    phases.length === 1 && phases[0].kind === "passive-load",
    "consent-banner calibration result is not linked to exactly one passive phase"
  );
  return {
    outcome: "complete",
    value: output.visible ? "detected" : "not-detected"
  };
}

function exactKeys(
  value: object,
  expected: string[],
  label: string
): void {
  invariant(
    JSON.stringify(Object.keys(value)) === JSON.stringify(expected),
    `${label} must contain exactly, in order: ${expected.join(", ")}`
  );
}

function invariant(
  condition: unknown,
  message: string
): asserts condition {
  if (!condition) throw new CalibrationMeasurementInvariantError(message);
}
