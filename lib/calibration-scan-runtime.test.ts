import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CalibrationMeasurementInvariantError,
  consentBannerPredictionFromMeasurement
} from "./calibration-scan-runtime";
import {
  consentBannerObserveCalibrationFact,
  createNodeScanMeasurementEnvelope,
  type ConsentBannerObserveCalibrationFact,
  type NodeScanMeasurementEnvelope,
  type NodeScanMeasurement
} from "./node-scan-measurement";
import { makeScanRunV2R2 } from "./scan-report-v2-r2-fixtures";
import { buildRuntimeScanReportV2R2 } from "./scan-report-v2-runtime-builder";
import { scanMeasurementEnvelopeWithR2Run } from "./scan-report-v2-runtime-fixtures";

const BUILD_ENV = {
  SITE_BEHAVIOR_LAB_BUILD_COMMIT: "a".repeat(40)
} as NodeJS.ProcessEnv;

test("process-local consent calibration maps exact visible true and false results", () => {
  assert.deepEqual(
    consentBannerPredictionFromMeasurement(consentEnvelope(true)),
    { outcome: "complete", value: "detected" }
  );
  assert.deepEqual(
    consentBannerPredictionFromMeasurement(consentEnvelope(false)),
    { outcome: "complete", value: "not-detected" }
  );
});

test("unreadable and censored consent probes never become negative predictions", () => {
  for (const status of ["failed", "partial", "skipped"] as const) {
    const envelope = consentEnvelope(undefined, status);
    assert.deepEqual(
      consentBannerPredictionFromMeasurement(envelope),
      { outcome: "censored", reason: "eligibility-criteria-not-met" },
      status
    );
  }
  const inconsistent = consentEnvelope(true, "failed");
  assert.throws(
    () => consentBannerPredictionFromMeasurement(inconsistent),
    (error) =>
      error instanceof CalibrationMeasurementInvariantError &&
      /censored consent-banner detector/.test(error.message)
  );
});

test("CMP request presence cannot substitute for a missing consent detector result", () => {
  const envelope = consentEnvelope(undefined, "complete");
  const mutable = structuredClone(envelope.measurement) as NodeScanMeasurement;
  mutable.evidence.requests[0].domain = "cdn.cookielaw.org";
  const cmpOnly = createNodeScanMeasurementEnvelope(
    structuredClone(envelope.result),
    mutable
  );
  assert.throws(
    () => consentBannerPredictionFromMeasurement(cmpOnly),
    (error) =>
      error instanceof CalibrationMeasurementInvariantError &&
      /missing its process-local calibration result/.test(error.message)
  );
});

test("consent calibration rejects extra fields and detector/phase mismatch", () => {
  const extra = consentEnvelope(true);
  const extraFact = {
    ...consentBannerObserveCalibrationFact(extra),
    proxySignal: true
  } as unknown as ConsentBannerObserveCalibrationFact;
  assert.throws(
    () =>
      consentBannerPredictionFromMeasurement(
        createNodeScanMeasurementEnvelope(
          structuredClone(extra.result),
          structuredClone(extra.measurement) as NodeScanMeasurement,
          extraFact
        )
      ),
    /must contain exactly/
  );

  const wrongPhase = consentEnvelope(true);
  const originalFact = consentBannerObserveCalibrationFact(wrongPhase);
  assert.ok(originalFact);
  const wrongPhaseFact = {
    ...originalFact,
    phaseId: originalFact.phaseId + 1
  };
  assert.throws(
    () =>
      consentBannerPredictionFromMeasurement(
        createNodeScanMeasurementEnvelope(
          structuredClone(wrongPhase.result),
          structuredClone(wrongPhase.measurement) as NodeScanMeasurement,
          wrongPhaseFact
        )
      ),
    /does not match the detector phase/
  );
});

test("private calibration facts cannot serialize or survive clones and spreads", () => {
  const envelope = consentEnvelope(true);
  for (const serialized of [
    JSON.stringify(envelope.measurement),
    JSON.stringify({ ...envelope }),
    JSON.stringify(structuredClone(envelope))
  ]) {
    assert.doesNotMatch(serialized, /calibration|banner-visibility|visible/);
  }
  const clone = structuredClone(envelope) as NodeScanMeasurementEnvelope;
  const spread = { ...envelope } as NodeScanMeasurementEnvelope;
  assert.equal(consentBannerObserveCalibrationFact(clone), undefined);
  assert.equal(consentBannerObserveCalibrationFact(spread), undefined);
  for (const untrusted of [clone, spread]) {
    assert.throws(
      () => consentBannerPredictionFromMeasurement(untrusted),
      /missing its process-local calibration result/
    );
  }
});

test("private calibration facts change neither frozen v1 nor public r2 output", () => {
  const without = consentEnvelope(undefined, "complete");
  const withFact = consentEnvelope(true, "complete");
  assert.deepEqual(withFact.result, without.result);
  assert.equal("calibration" in withFact.result, false);

  const publicWithout = buildRuntimeScanReportV2R2(
    without,
    "ci-workflow",
    BUILD_ENV
  );
  const publicWith = buildRuntimeScanReportV2R2(
    withFact,
    "ci-workflow",
    BUILD_ENV
  );
  publicWith.run.runId = publicWithout.run.runId;
  assert.deepEqual(publicWith, publicWithout);
  assert.equal("calibration" in publicWith.run, false);
});

function consentEnvelope(
  visible: boolean | undefined,
  status: "complete" | "failed" | "partial" | "skipped" = "complete"
) {
  const template = scanMeasurementEnvelopeWithR2Run(
    makeScanRunV2R2({ consent: "observe" })
  );
  const measurement = structuredClone(
    template.measurement
  ) as NodeScanMeasurement;
  const passive = measurement.measurement.phases.find(
    (phase) => phase.kind === "passive-load"
  );
  assert.ok(passive);
  measurement.measurement.detectors["consent-banner"] = {
    version: measurement.measurement.detectors["consent-banner"].version,
    status,
    ...(status === "complete"
      ? {}
      : {
          reason:
            status === "skipped" ? "budget-unavailable" : "engine-unavailable"
        }),
    phaseId: passive.phaseId
  };
  const fact =
    visible === undefined
      ? undefined
      : {
          detector: "consent-banner" as const,
          method: "banner-visibility@1" as const,
          phaseId: passive.phaseId,
          outcome: "complete" as const,
          visible
        };
  return createNodeScanMeasurementEnvelope(
    structuredClone(template.result),
    measurement,
    fact
  );
}
