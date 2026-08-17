import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DETECTOR_REGISTRY_DIGEST,
  DETECTOR_REGISTRY_VERSION,
  DETECTOR_VERSIONS,
  MeasurementKernel,
  deriveCookieMutations,
  deriveStorageMutations
} from "./measurement-kernel";
import { DETECTOR_OBLIGATION_TARGET_REGISTRY } from "./detector-obligations";
import { evaluateQuality } from "./scan-report-v2-evaluators";
import { PAGE_SUBJECT_CAPTURE_LOSS_DETAIL } from "./bot-wall-classifier";

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
    version: "pixel-request-decoder@3",
    status: "complete",
    phaseId: 0
  });
  assert.equal(result.detectors["privacy-policy"].status, "skipped");
});

test("request-count and response-byte ceilings retain separate loss identities and counts", () => {
  const kernel = new MeasurementKernel(0, () => 10);
  kernel.beginPhase("passive-load");
  kernel.exhaustBudget({ name: "request-capture", family: "requests", count: 9 });
  kernel.exhaustBudget({ name: "response-bytes", family: "requests", count: 74 });
  const result = kernel.finish();

  assert.deepEqual(result.budgetsExhausted, ["request-capture", "response-bytes"]);
  assert.deepEqual(result.captureLoss, [
    { family: "requests", phaseId: 0, kind: "cap", count: 9, detail: "request-capture" },
    { family: "requests", phaseId: 0, kind: "cap", count: 74, detail: "response-bytes" }
  ]);
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

test("page-subject capture loss fails run quality", () => {
  const kernel = new MeasurementKernel(0, () => 1);
  const phaseId = kernel.beginPhase("passive-load");
  kernel.recordCaptureLoss({
    family: "detector-output",
    phaseId,
    kind: "dropped",
    count: 1,
    detail: PAGE_SUBJECT_CAPTURE_LOSS_DETAIL
  });
  const facts = kernel.qualityFacts({ status: 200, botWallTitleMatched: false, navigationSettled: true });
  const quality = evaluateQuality(facts, { observedRequests: 5 });
  assert.deepEqual(quality.run, {
    outcome: "failed",
    reasons: [`capture-loss:${PAGE_SUBJECT_CAPTURE_LOSS_DETAIL}`]
  });
  assert.equal(quality.byFamily["detector-output"].outcome, "censored");
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
  assert.equal(DETECTOR_REGISTRY_VERSION, "node-detectors-v5");
  assert.equal(DETECTOR_VERSIONS["cname-uncloaking"], "dns-cname-chain@4");
  assert.equal(DETECTOR_VERSIONS["fingerprint-heuristics"], "fingerprint-observer@2");
  assert.equal(DETECTOR_VERSIONS["privacy-policy"], "policy-text-cross-check@5");
  // Detector behavior is published provenance. Completeness, cancellation,
  // and truncation semantics moved together with the detector versions rather
  // than silently presenting the new behavior as the old release.
  assert.equal(DETECTOR_REGISTRY_DIGEST, "65547960bf03ca7d6d7b8279aa8b5ffed3a995bed2f36a64535d4179743ce204");
  assert.deepEqual(DETECTOR_OBLIGATION_TARGET_REGISTRY, {
    detectorRegistryVersion: DETECTOR_REGISTRY_VERSION,
    detectorRegistryDigest: DETECTOR_REGISTRY_DIGEST
  });
});
