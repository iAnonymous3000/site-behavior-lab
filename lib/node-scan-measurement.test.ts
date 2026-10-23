import assert from "node:assert/strict";
import { test } from "node:test";
import { ConnectionInspectionRecorder } from "./connection-inspection";
import { isEphemeralScanReportR2 } from "./scan-report-v2-r2-validation";
import {
  attachScrollCheckEvidence,
  createNodeScanMeasurementEnvelope,
  scrollCheckEvidence,
  type NodeScanMeasurement,
  type NodeScanMeasurementEnvelope
} from "./node-scan-measurement";
import { runScrollCheck, SCROLL_CHECK_TIMING, ScrollCheckRecorder } from "./scroll-check";
import type { ScrollCheckEvidence } from "./scroll-check-evidence";
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

/** The evidence a real check returns for a page that failed its load gate. */
async function notRunScrollCheck(): Promise<ScrollCheckEvidence> {
  return runScrollCheck({
    recorder: new ScrollCheckRecorder<{ url: string }>({ url: (request) => request.url, redirected: () => false, mainFrameNavigation: () => false }),
    timing: SCROLL_CHECK_TIMING,
    navigationStartedAt: 0,
    startedAt: 0,
    subjectAvailable: false,
    firstPartyHostname: "www.example.com",
    sameSubject: () => true,
    leftSiteAt: () => null,
    visitBudgetUsedUp: false,
    proxyLossCount: () => 0,
    settleRoutes: async () => undefined,
    now: () => 0,
    sleep: async () => undefined,
    page: { url: () => "https://www.example.com/", scrollState: async () => null, scrollTo: async () => false }
  });
}

test("a check's evidence attaches once, only to an envelope this module built, and reaches only that envelope's immediate shell", async () => {
  const evidence = await notRunScrollCheck();
  const template = scanMeasurementEnvelopeWithR2Run(makeScanRunV2R2());
  const envelope = createNodeScanMeasurementEnvelope(structuredClone(template.result), structuredClone(template.measurement) as NodeScanMeasurement);
  assert.equal(scrollCheckEvidence(envelope), undefined);
  attachScrollCheckEvidence(envelope, evidence);
  assert.deepEqual(scrollCheckEvidence(envelope), evidence);
  // Once only, and never to a copy, a foreign object or an inspection's envelope.
  assert.throws(() => attachScrollCheckEvidence(envelope, evidence), /already carries/);
  assert.throws(() => attachScrollCheckEvidence({ ...envelope }, evidence), /its own visit built/);
  assert.throws(() => attachScrollCheckEvidence(structuredClone(template) as NodeScanMeasurementEnvelope, evidence), /its own visit built/);
  const recorder = new ConnectionInspectionRecorder("https://pixel.example.net/{seg}");
  recorder.observe({ request: { url: "https://pixel.example.net/p.gif" }, type: "Image", initiator: { type: "parser" } });
  recorder.notePageRequest("https://pixel.example.net/p.gif");
  const inspection = recorder.evidence();
  assert.ok(inspection);
  const inspected = createNodeScanMeasurementEnvelope(
    structuredClone(template.result),
    structuredClone(template.measurement) as NodeScanMeasurement,
    undefined,
    inspection
  );
  assert.throws(() => attachScrollCheckEvidence(inspected, evidence), /never travels beside an inspection/);
  // Evidence its readers' validator refuses is refused here too.
  const fresh = createNodeScanMeasurementEnvelope(structuredClone(template.result), structuredClone(template.measurement) as NodeScanMeasurement);
  assert.throws(() => attachScrollCheckEvidence(fresh, { ...evidence, screens: 9 }), /validator refuses/);
  assert.equal(scrollCheckEvidence(fresh), undefined);
  // The runtime builder carries it into the immediate shell, and the public
  // report is exactly an ordinary scan's.
  const checked = buildRuntimeScanReportV2R2(envelope, "public-api", BUILD_ENV);
  assert.deepEqual(checked.ephemeral.scrollCheck, evidence);
  assert.equal(isEphemeralScanReportR2(checked), true);
  assert.equal(JSON.stringify(envelope.measurement).includes("not-run"), false);
  assert.equal("scrollCheck" in buildRuntimeScanReportV2R2({ ...envelope }, "public-api", BUILD_ENV).ephemeral, false);
  const ordinary = buildRuntimeScanReportV2R2(template, "public-api", BUILD_ENV);
  const { runId: _checkedRunId, ...checkedRun } = checked.run;
  const { runId: _ordinaryRunId, ...ordinaryRun } = ordinary.run;
  assert.deepEqual(checkedRun, ordinaryRun);
});

