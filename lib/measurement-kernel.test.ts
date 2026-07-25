import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DETECTOR_REGISTRY_DIGEST,
  DETECTOR_REGISTRY_VERSION,
  MeasurementKernel,
  deriveCookieMutations,
  deriveStorageMutations
} from "./measurement-kernel";
import { evaluateQuality } from "./scan-report-v2-evaluators";

test("records non-overlapping indexed phases and request attribution", () => {
  let now = 1_000;
  const kernel = new MeasurementKernel<object>(1_000, () => now);
  const requestA = {};
  const requestB = {};
  assert.equal(kernel.beginPhase("passive-load"), 0);
  now = 1_025;
  assert.equal(kernel.tagRequest(requestA), 0);
  now = 1_100;
  assert.equal(kernel.beginPhase("active-probe"), 1);
  now = 1_125;
  assert.equal(kernel.tagRequest(requestB), 1);
  now = 1_150;

  const result = kernel.finish();
  assert.deepEqual(result.phases, [
    { phaseId: 0, kind: "passive-load", startedAtMs: 0, endedAtMs: 100 },
    { phaseId: 1, kind: "active-probe", startedAtMs: 100, endedAtMs: 150 }
  ]);
  assert.equal(kernel.phaseForRequest(requestA), 0);
  assert.equal(kernel.phaseForRequest(requestB), 1);
  assert.throws(() => kernel.beginPhase("policy-analysis"), /already finished/);
});

test("records detector outcomes and maps exhausted budgets to capture loss once", () => {
  const kernel = new MeasurementKernel(0, () => 10);
  const phaseId = kernel.beginPhase("passive-load");
  kernel.setDetector("pixel-events", "complete", { phaseId });
  kernel.exhaustBudget({ name: "request-capture", family: "requests", count: 3 });
  kernel.exhaustBudget({ name: "request-capture", family: "requests", count: 9 });
  const result = kernel.finish();

  assert.deepEqual(result.budgetsExhausted, ["request-capture"]);
  assert.deepEqual(result.captureLoss, [
    { family: "requests", phaseId: 0, kind: "cap", count: 3, detail: "request-capture" }
  ]);
  assert.deepEqual(result.detectors["pixel-events"], {
    version: "pixel-request-decoder@1",
    status: "complete",
    phaseId: 0
  });
  assert.equal(result.detectors["privacy-policy"].status, "skipped");
});

test("quality stays evaluator-owned and capture loss censors only its family", () => {
  const kernel = new MeasurementKernel(0, () => 1);
  kernel.beginPhase("passive-load");
  kernel.exhaustBudget({ name: "request-capture", family: "requests" });
  const facts = kernel.qualityFacts({ status: 200, botWallTitleMatched: false, navigationSettled: true });
  const quality = evaluateQuality(facts, { observedRequests: 5 });
  assert.equal(quality.run.outcome, "complete");
  assert.equal(quality.byFamily.requests.outcome, "censored");
  assert.equal(quality.byFamily.cookies.outcome, "complete");
});

test("boundary snapshots derive added, changed, and removed cookie/storage records", () => {
  const cookie = {
    name: "session",
    domain: "example.com",
    path: "/",
    sameSite: "Lax",
    secure: true,
    httpOnly: true,
    session: true,
    thirdParty: false
  };
  assert.deepEqual(
    deriveCookieMutations([
      { phaseId: 0, records: [] },
      { phaseId: 0, records: [cookie] },
      { phaseId: 1, records: [{ ...cookie, secure: false }] },
      { phaseId: 2, records: [] }
    ]),
    [
      { phaseId: 0, op: "added", cookie },
      { phaseId: 1, op: "changed", cookie: { ...cookie, secure: false } },
      { phaseId: 2, op: "removed", cookie: { ...cookie, secure: false } }
    ]
  );

  const entry = { area: "localStorage" as const, key: "theme", valueBytes: 4 };
  assert.deepEqual(
    deriveStorageMutations([
      { phaseId: 0, records: [] },
      { phaseId: 0, records: [entry] },
      { phaseId: 1, records: [{ ...entry, valueBytes: 5 }] }
    ]),
    [
      { phaseId: 0, op: "added", entry },
      { phaseId: 1, op: "changed", entry: { ...entry, valueBytes: 5 } }
    ]
  );
});

test("detector registry identity is stable and non-empty", () => {
  assert.equal(DETECTOR_REGISTRY_VERSION, "node-detectors-v2");
  // Three committed r2 reports carry this exact digest in their provenance, so
  // it is published identity, not an internal value. A shape-only assertion
  // would let a registry edit orphan them silently.
  assert.equal(DETECTOR_REGISTRY_DIGEST, "1961b4197b649b6eb8028f95a9f2f6b28973b7427178b23e661017da7ed0c7c4");
});
