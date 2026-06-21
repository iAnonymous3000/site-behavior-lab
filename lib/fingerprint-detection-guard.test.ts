import assert from "node:assert/strict";
import { test } from "node:test";
import { isFingerprintDetectionSummary } from "./fingerprint-detection-guard";

const VALID: Record<string, unknown>[] = [
  {
    kind: "canvas-fingerprinting",
    heuristic: "openwpm-canvas-v1",
    count: 1,
    evidence: { readApis: ["canvas.toDataURL"], maxCanvasWidth: 32, maxCanvasHeight: 32, maxDistinctTextCharacters: 10, maxTextWriteCalls: 1 }
  },
  {
    kind: "canvas-font-fingerprinting",
    heuristic: "canvas-font-probing-v1",
    count: 1,
    evidence: { measureTextCalls: 8, maxDistinctFonts: 4, maxDistinctTextSamples: 1, maxTextLength: 12 }
  },
  {
    kind: "webgl-fingerprinting",
    heuristic: "webgl-entropy-read-v1",
    count: 1,
    evidence: { readApis: ["webgl.readPixels"], parameters: ["webgl.getParameter.UNMASKED_RENDERER_WEBGL"], getParameterCalls: 2, readPixelsCalls: 1 }
  },
  {
    kind: "audio-fingerprinting",
    heuristic: "audio-rendering-v1",
    count: 1,
    evidence: { apis: ["a", "b"], offlineRenderCalls: 1, oscillatorCalls: 1, compressorCalls: 0, analyserCalls: 0 }
  },
  {
    kind: "webrtc-fingerprinting",
    heuristic: "webrtc-peerconnection-v1",
    count: 1,
    evidence: { constructorCalls: 1, createDataChannelCalls: 1, createOfferCalls: 0, setLocalDescriptionCalls: 0 }
  },
  {
    kind: "session-recording",
    heuristic: "interaction-listener-coverage-v1",
    count: 1,
    evidence: { eventTypes: ["click", "scroll"], listenerTargets: ["document"], thirdPartyOrigins: ["https://recorder.example.net"], totalListenerCalls: 8 }
  },
  {
    kind: "input-monitoring",
    heuristic: "input-listener-coverage-v1",
    count: 1,
    evidence: { eventTypes: ["input"], listenerTargets: ["input"], thirdPartyOrigins: ["https://analytics.example.net"], totalListenerCalls: 4 }
  }
];

test("isFingerprintDetectionSummary accepts every well-formed detection kind", () => {
  for (const detection of VALID) {
    assert.equal(isFingerprintDetectionSummary(detection), true, `expected ${detection.kind} to be valid`);
  }
});

test("isFingerprintDetectionSummary rejects unknown shapes", () => {
  assert.equal(isFingerprintDetectionSummary(null), false);
  assert.equal(isFingerprintDetectionSummary("canvas-fingerprinting"), false);
  assert.equal(isFingerprintDetectionSummary({ kind: "unknown-kind", heuristic: "x", count: 1, evidence: {} }), false);
  assert.equal(isFingerprintDetectionSummary({ kind: "canvas-fingerprinting" }), false); // missing evidence
});

test("isFingerprintDetectionSummary enforces the strict numeric checks", () => {
  const base = VALID[0];
  // Non-finite and negative numbers must be rejected (the looser typeof check would have passed NaN).
  assert.equal(isFingerprintDetectionSummary({ ...base, count: Number.NaN }), false);
  assert.equal(isFingerprintDetectionSummary({ ...base, count: 0 }), false);
  assert.equal(
    isFingerprintDetectionSummary({ ...base, evidence: { ...(base.evidence as object), maxCanvasWidth: Number.POSITIVE_INFINITY } }),
    false
  );
  assert.equal(
    isFingerprintDetectionSummary({ ...base, evidence: { ...(base.evidence as object), maxCanvasHeight: -1 } }),
    false
  );
});

test("isFingerprintDetectionSummary requires http(s) listener-coverage origins", () => {
  const session = VALID[5];
  const evidence = session.evidence as { thirdPartyOrigins: string[] };
  assert.equal(
    isFingerprintDetectionSummary({ ...session, evidence: { ...evidence, thirdPartyOrigins: ["ftp://x.example"] } }),
    false
  );
  assert.equal(
    isFingerprintDetectionSummary({ ...session, evidence: { ...evidence, thirdPartyOrigins: [] } }),
    false
  );
  // Wrong heuristic for the kind must be rejected.
  assert.equal(isFingerprintDetectionSummary({ ...session, heuristic: "input-listener-coverage-v1" }), false);
});
