import { isRecord } from "./guards";
import type { FingerprintDetectionSummary } from "./types";

/**
 * The single validator for `FingerprintDetectionSummary` values arriving from
 * untrusted sources: the in-page instrumentation snapshot
 * (`lib/fingerprint-observer.ts`) and uploaded or stored reports
 * (`lib/report-validation.ts`). Both previously kept near-identical copies that
 * had drifted in strictness; this is the one strict definition.
 *
 * Strict by design, every numeric field must be finite (not just `typeof
 * "number"`, which accepts `NaN`/`Infinity`), and listener-coverage origins must
 * be `http(s)` URLs. The in-page observer only ever emits finite counts and
 * `http(s)` script origins, so the strict checks accept every genuine detection
 * while rejecting malformed input. Pure (types + `isRecord` only), so it is safe
 * to import from any runtime lane.
 */
export function isFingerprintDetectionSummary(value: unknown): value is FingerprintDetectionSummary {
  if (!isRecord(value)) return false;
  if (value.kind === "canvas-fingerprinting") return isCanvasFingerprintDetectionSummary(value);
  if (value.kind === "canvas-font-fingerprinting") return isCanvasFontFingerprintDetectionSummary(value);
  if (value.kind === "webgl-fingerprinting") return isWebglFingerprintDetectionSummary(value);
  if (value.kind === "audio-fingerprinting") return isAudioFingerprintDetectionSummary(value);
  if (value.kind === "webrtc-fingerprinting") return isWebrtcFingerprintDetectionSummary(value);
  if (value.kind === "session-recording") return isListenerCoverageDetectionSummary(value, "interaction-listener-coverage-v1");
  if (value.kind === "input-monitoring") return isListenerCoverageDetectionSummary(value, "input-listener-coverage-v1");
  if (value.kind === "keystroke-exfiltration") return isKeystrokeExfiltrationDetectionSummary(value);
  return false;
}

function isKeystrokeExfiltrationDetectionSummary(value: Record<string, unknown>): boolean {
  return (
    value.heuristic === "input-sentinel-exfiltration-v1" &&
    isFinitePositiveNumber(value.count) &&
    isRecord(value.evidence) &&
    isNonEmptyStringArray(value.evidence.recipients) &&
    isNonEmptyStringArray(value.evidence.encodings) &&
    isFiniteNonNegativeNumber(value.evidence.fieldsTyped) &&
    Array.isArray(value.evidence.fieldTypes) &&
    value.evidence.fieldTypes.every((fieldType) => typeof fieldType === "string")
  );
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string");
}

function isCanvasFingerprintDetectionSummary(value: Record<string, unknown>): boolean {
  return (
    value.kind === "canvas-fingerprinting" &&
    value.heuristic === "openwpm-canvas-v1" &&
    typeof value.count === "number" &&
    Number.isFinite(value.count) &&
    value.count > 0 &&
    isRecord(value.evidence) &&
    Array.isArray(value.evidence.readApis) &&
    value.evidence.readApis.every((api) => typeof api === "string") &&
    isFiniteNonNegativeNumber(value.evidence.maxCanvasWidth) &&
    isFiniteNonNegativeNumber(value.evidence.maxCanvasHeight) &&
    isFiniteNonNegativeNumber(value.evidence.maxDistinctTextCharacters) &&
    isFiniteNonNegativeNumber(value.evidence.maxTextWriteCalls)
  );
}

function isCanvasFontFingerprintDetectionSummary(value: Record<string, unknown>): boolean {
  return (
    value.kind === "canvas-font-fingerprinting" &&
    value.heuristic === "canvas-font-probing-v1" &&
    isFinitePositiveNumber(value.count) &&
    isRecord(value.evidence) &&
    isFinitePositiveNumber(value.evidence.measureTextCalls) &&
    isFinitePositiveNumber(value.evidence.maxDistinctFonts) &&
    isFinitePositiveNumber(value.evidence.maxDistinctTextSamples) &&
    isFiniteNonNegativeNumber(value.evidence.maxTextLength)
  );
}

function isWebglFingerprintDetectionSummary(value: Record<string, unknown>): boolean {
  if (!isRecord(value.evidence)) return false;
  const readPixelsCalls = value.evidence.readPixelsCalls;

  return (
    value.kind === "webgl-fingerprinting" &&
    value.heuristic === "webgl-entropy-read-v1" &&
    isFinitePositiveNumber(value.count) &&
    Array.isArray(value.evidence.readApis) &&
    value.evidence.readApis.every((api) => typeof api === "string") &&
    Array.isArray(value.evidence.parameters) &&
    value.evidence.parameters.every((parameter) => typeof parameter === "string") &&
    isFiniteNonNegativeNumber(value.evidence.getParameterCalls) &&
    isFiniteNonNegativeNumber(readPixelsCalls) &&
    (value.evidence.parameters.length > 0 || readPixelsCalls > 0)
  );
}

function isAudioFingerprintDetectionSummary(value: Record<string, unknown>): boolean {
  return (
    value.kind === "audio-fingerprinting" &&
    value.heuristic === "audio-rendering-v1" &&
    isFinitePositiveNumber(value.count) &&
    isRecord(value.evidence) &&
    Array.isArray(value.evidence.apis) &&
    value.evidence.apis.every((api) => typeof api === "string") &&
    value.evidence.apis.length >= 2 &&
    isFinitePositiveNumber(value.evidence.offlineRenderCalls) &&
    isFiniteNonNegativeNumber(value.evidence.oscillatorCalls) &&
    isFiniteNonNegativeNumber(value.evidence.compressorCalls) &&
    isFiniteNonNegativeNumber(value.evidence.analyserCalls)
  );
}

function isWebrtcFingerprintDetectionSummary(value: Record<string, unknown>): boolean {
  if (!isRecord(value.evidence)) return false;
  const createDataChannelCalls = value.evidence.createDataChannelCalls;
  const createOfferCalls = value.evidence.createOfferCalls;
  const setLocalDescriptionCalls = value.evidence.setLocalDescriptionCalls;

  return (
    value.kind === "webrtc-fingerprinting" &&
    value.heuristic === "webrtc-peerconnection-v1" &&
    isFinitePositiveNumber(value.count) &&
    isFinitePositiveNumber(value.evidence.constructorCalls) &&
    isFiniteNonNegativeNumber(createDataChannelCalls) &&
    isFiniteNonNegativeNumber(createOfferCalls) &&
    isFiniteNonNegativeNumber(setLocalDescriptionCalls) &&
    (createDataChannelCalls > 0 || createOfferCalls > 0 || setLocalDescriptionCalls > 0)
  );
}

function isListenerCoverageDetectionSummary(value: Record<string, unknown>, heuristic: string): boolean {
  return (
    isFinitePositiveNumber(value.count) &&
    value.heuristic === heuristic &&
    isRecord(value.evidence) &&
    Array.isArray(value.evidence.eventTypes) &&
    value.evidence.eventTypes.every((eventType) => typeof eventType === "string") &&
    Array.isArray(value.evidence.listenerTargets) &&
    value.evidence.listenerTargets.every((target) => typeof target === "string") &&
    Array.isArray(value.evidence.thirdPartyOrigins) &&
    value.evidence.thirdPartyOrigins.every((origin) => typeof origin === "string" && /^https?:\/\//.test(origin)) &&
    value.evidence.thirdPartyOrigins.length > 0 &&
    isFinitePositiveNumber(value.evidence.totalListenerCalls)
  );
}

function isFinitePositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isFiniteNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
