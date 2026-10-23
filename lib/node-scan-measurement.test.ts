import assert from "node:assert/strict";
import { test } from "node:test";
import { ConnectionInspectionRecorder } from "./connection-inspection";
import { isEphemeralScanReportR2 } from "./scan-report-v2-r2-validation";
import {
  createNodeScanMeasurementEnvelope,
  type NodeScanMeasurement,
  type NodeScanMeasurementEnvelope
} from "./node-scan-measurement";
import { makeScanRunV2R2 } from "./scan-report-v2-r2-fixtures";
import {
  RuntimeR2BuildPrerequisiteError,
  buildRuntimeScanReportV2R2
} from "./scan-report-v2-runtime-builder";
import { scanMeasurementEnvelopeWithR2Run } from "./scan-report-v2-runtime-fixtures";

const BUILD_ENV = { SITE_BEHAVIOR_LAB_BUILD_COMMIT: "a".repeat(40) } as NodeJS.ProcessEnv;

test("the Node measurement envelope owns and deeply freezes facts without changing the frozen v1 wire", () => {
  const template = scanMeasurementEnvelopeWithR2Run(makeScanRunV2R2());
  const mutable = structuredClone(template.measurement) as NodeScanMeasurement;
  const originalRequestCount = mutable.evidence.requests.length;
  const envelope = createNodeScanMeasurementEnvelope(structuredClone(template.result), mutable);

  mutable.evidence.requests.splice(0);
  mutable.emissionInputs.requestedUrl = "https://mutated.invalid/private";

  assert.equal(envelope.measurement.evidence.requests.length, originalRequestCount);
  assert.notEqual(envelope.measurement.emissionInputs.requestedUrl, mutable.emissionInputs.requestedUrl);
  assert.equal(Object.isFrozen(envelope), true);
  assert.equal(Object.isFrozen(envelope.measurement), true);
  assert.equal(Object.isFrozen(envelope.measurement.evidence.requests), true);
  assert.throws(
    () => (envelope.measurement.evidence.requests as unknown[]).splice(0),
    TypeError
  );
  assert.equal(envelope.result.schemaVersion, 1);
  assert.equal(Object.prototype.hasOwnProperty.call(envelope.result, "measurement"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(envelope.result, "verificationFacts"), false);
});

test("measurement envelopes refuse accidental serialization but retain explicit structured-clone transport", () => {
  const envelope = scanMeasurementEnvelopeWithR2Run(makeScanRunV2R2());
  assert.equal(Object.prototype.propertyIsEnumerable.call(envelope, "toJSON"), false);
  assert.throws(() => JSON.stringify(envelope), /process-local and cannot be serialized/);

  const clone = structuredClone(envelope) as NodeScanMeasurementEnvelope;
  assert.equal("toJSON" in clone, false);
  assert.deepEqual(clone.result, envelope.result);
  assert.deepEqual(clone.measurement, envelope.measurement);
  const report = buildRuntimeScanReportV2R2(clone, "public-api", BUILD_ENV);
  assert.equal(report.run.evidence.requests.length, envelope.measurement.evidence.requests.length);
});

test("runtime r2 production fails closed when the explicit envelope is missing or mixes visits", () => {
  const envelope = scanMeasurementEnvelopeWithR2Run(makeScanRunV2R2());
  assert.throws(
    () => buildRuntimeScanReportV2R2({ result: envelope.result } as NodeScanMeasurementEnvelope, "public-api", BUILD_ENV),
    (error) =>
      error instanceof RuntimeR2BuildPrerequisiteError &&
      error.code === "measurement-envelope-missing"
  );

  const inconsistent = createNodeScanMeasurementEnvelope(
    {
      ...envelope.result,
      conditions: {
        ...envelope.result.conditions,
        gpcEnabled: !envelope.result.conditions.gpcEnabled
      }
    },
    structuredClone(envelope.measurement) as NodeScanMeasurement
  );
  assert.throws(
    () => buildRuntimeScanReportV2R2(inconsistent, "public-api", BUILD_ENV),
    (error) =>
      error instanceof RuntimeR2BuildPrerequisiteError &&
      error.code === "measurement-envelope-inconsistent" &&
      /gpc/.test(error.message)
  );
});

test("an inspection visit's evidence reaches only its exact envelope's immediate shell", () => {
  const recorder = new ConnectionInspectionRecorder("https://pixel.example.net/{seg}");
  recorder.observe({ request: { url: "https://pixel.example.net/p.gif" }, type: "Image", initiator: { type: "parser" } });
  recorder.notePageRequest("https://pixel.example.net/p.gif");
  const evidence = recorder.evidence();
  assert.ok(evidence);
  const template = scanMeasurementEnvelopeWithR2Run(makeScanRunV2R2());
  const envelope = createNodeScanMeasurementEnvelope(
    structuredClone(template.result),
    structuredClone(template.measurement) as NodeScanMeasurement,
    undefined,
    evidence
  );
  const inspected = buildRuntimeScanReportV2R2(envelope, "public-api", BUILD_ENV);
  assert.deepEqual(inspected.ephemeral.inspection, evidence);
  assert.equal(isEphemeralScanReportR2(inspected), true);
  // Never a member of the envelope or its measurement, so no clone, spread
  // or builder that reads them carries it.
  assert.equal(JSON.stringify(envelope.measurement).includes("pixel.example.net"), false);
  assert.equal(Object.keys(envelope).sort().join(","), "measurement,result");
  const clone = structuredClone(envelope) as NodeScanMeasurementEnvelope;
  assert.equal("inspection" in buildRuntimeScanReportV2R2(clone, "public-api", BUILD_ENV).ephemeral, false);
  assert.equal("inspection" in buildRuntimeScanReportV2R2({ ...envelope }, "public-api", BUILD_ENV).ephemeral, false);
  // An ordinary visit's shell carries none, and the public report is the same.
  const ordinary = buildRuntimeScanReportV2R2(template, "public-api", BUILD_ENV);
  assert.equal("inspection" in ordinary.ephemeral, false);
  const { runId: _inspectedRunId, ...inspectedRun } = inspected.run;
  const { runId: _ordinaryRunId, ...ordinaryRun } = ordinary.run;
  assert.deepEqual(inspectedRun, ordinaryRun);
});

