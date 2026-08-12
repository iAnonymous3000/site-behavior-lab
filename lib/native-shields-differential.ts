import { FULL_GIT_SHA } from "./build-provenance";
import { mapRequestType, type AdblockEngineStatus } from "./adblock-engine";
import {
  REDACTION_VERSION,
  addRedactionCounters,
  emptyRedactionCounters,
  redactUrlV2,
  type RedactionCounters
} from "./redaction-v2";
import { sha256Hex } from "./sha256";

/**
 * Research-only native Brave Shields differential receipt.
 *
 * This is deliberately not a ScanReport producer. It compares the sparse,
 * Brave-only Network.requestAdblockInfoReceived event with the boolean
 * adblock-rust decision Site Behavior Lab can make from the corresponding CDP
 * request. The public v2/r2 report wire remains unchanged.
 */

export const NATIVE_SHIELDS_DIFFERENTIAL_ARTIFACT_KIND =
  "site-behavior-native-shields-differential" as const;
export const NATIVE_SHIELDS_DIFFERENTIAL_SCHEMA_VERSION = 1 as const;
export const MAX_NATIVE_SHIELDS_EVENTS = 5_000;
export const MAX_NATIVE_NETWORK_RECORDS = 10_000;

const MAX_URL_CHARS = 16_384;
const MAX_REQUEST_ID_CHARS = 512;
const MAX_HOST_CHARS = 253;
const MAX_RESOURCE_TYPE_CHARS = 64;
const SHA256 = /^[0-9a-f]{64}$/;
const LOCAL_DECISIONS = new Set<string>([
  "would-block",
  "would-not-block",
  "not-evaluated",
  "engine-unavailable",
  "evaluation-failed"
]);
const SOURCE_URL_BASES = new Set<string>([
  "parent-frame",
  "frame",
  "document-url",
  "root-subject",
  "native-source-host",
  "unavailable"
]);
const AGREEMENTS = new Set<string>([
  "agrees-block",
  "native-block-local-canonical-match",
  "native-block-local-miss",
  "native-block-local-unresolved",
  "native-exception-local-would-block",
  "native-exception-local-nonblock",
  "native-exception-local-unresolved",
  "native-event-unclassified"
]);
const COVERAGE_KEYS = [
  "networkRequestRecords",
  "nativeEvents",
  "nativeBlockedEvents",
  "nativeExceptionEvents",
  "correlatedNativeEvents",
  "uncorrelatedNativeEvents",
  "networkRequestRecordsWithoutNativeEvent",
  "localEvaluations",
  "cnameRechecksObserved",
  "droppedNetworkRequestRecords",
  "droppedNativeEvents",
  "proxyBlockedTargets",
  "proxyResourceLimitHit"
] as const;
const REDACTION_COUNTER_KEYS = [
  "pathSegmentsGeneralized",
  "queryKeysRedacted",
  "storageKeysRedacted",
  "cookieNamesRedacted",
  "matrixParamsStripped",
  "subdomainLabelsGeneralized",
  "malformedUrlsDropped"
] as const;

export const NATIVE_SHIELDS_DIFFERENTIAL_LIMITATIONS = Object.freeze([
  "native-events-are-sparse-block-or-exception-only",
  "no-native-event-is-not-an-allow-verdict",
  "brave-profile-shields-settings-are-not-read-back",
  "local-source-url-is-reconstructed-from-cdp-or-native-host-state",
  "native-cname-uncloaking-may-be-disabled-by-the-safety-proxy",
  "fresh-profile-component-readiness-is-not-attested",
  "raw-urls-and-request-ids-are-retained-in-memory-only"
] as const);

export type RawNativeAdblockEvent = {
  sequence: number;
  requestId: string;
  requestUrl: string;
  checkedUrl: string;
  sourceHost: string;
  resourceType?: string;
  aggressive: boolean;
  blocked: boolean;
  didMatchImportantRule: boolean;
  didMatchRule: boolean;
  didMatchException: boolean;
  hasMockData: boolean;
  rewrittenUrl?: string;
};

export type RawCdpNetworkRequest = {
  sequence: number;
  requestId: string;
  url: string;
  documentUrl: string;
  method: string;
  resourceType: string;
  frameId?: string;
};

export type RawCdpFrame = {
  id: string;
  parentId?: string;
  url: string;
};

export type NativeShieldsLocalDecision =
  | "would-block"
  | "would-not-block"
  | "not-evaluated"
  | "engine-unavailable"
  | "evaluation-failed";

export type NativeShieldsAgreement =
  | "agrees-block"
  | "native-block-local-canonical-match"
  | "native-block-local-miss"
  | "native-block-local-unresolved"
  | "native-exception-local-would-block"
  | "native-exception-local-nonblock"
  | "native-exception-local-unresolved"
  | "native-event-unclassified";

export type NativeShieldsDifferentialEvent = {
  requestIdDigest: string;
  correlated: boolean;
  requestUrl: string;
  checkedUrl: string;
  rewrittenUrl?: string;
  sourceHost: string;
  resourceType: string;
  method: string;
  cnameRecheckObserved: boolean;
  native: {
    aggressive: boolean;
    blocked: boolean;
    didMatchImportantRule: boolean;
    didMatchRule: boolean;
    didMatchException: boolean;
    hasMockData: boolean;
    rewritten: boolean;
  };
  local: {
    requestUrlDecision: NativeShieldsLocalDecision;
    checkedUrlDecision: NativeShieldsLocalDecision | null;
    requestType: string;
    sourceUrlBasis:
      | "parent-frame"
      | "frame"
      | "document-url"
      | "root-subject"
      | "native-source-host"
      | "unavailable";
  };
  agreement: NativeShieldsAgreement;
};

export type NativeShieldsDifferentialReceipt = {
  schemaVersion: typeof NATIVE_SHIELDS_DIFFERENTIAL_SCHEMA_VERSION;
  artifactKind: typeof NATIVE_SHIELDS_DIFFERENTIAL_ARTIFACT_KIND;
  generatedAt: string;
  status: "complete" | "partial" | "inconclusive";
  siteBehaviorLabCommit: string | null;
  subject: {
    requestedUrl: string;
    observedUrl: string | null;
  };
  capture: {
    startedAt: string;
    finishedAt: string;
    browser: {
      executableLabel: "brave-stable" | "brave-beta" | "brave-nightly" | "custom";
      version: string;
      executableSha256: string;
      runtimeBinarySha256: string;
      runtimeBinaryKind: "executable" | "macos-framework";
      headless: boolean;
    };
    profile: "playwright-temporary-persistent" | "operator-dedicated-persistent";
    shieldsConfiguration: "default-profile-unverified";
    networkMode: "sbl-connect-time-public-proxy";
    navigation: {
      outcome: "completed" | "timeout" | "failed";
      status: number | null;
    };
  };
  simulation: {
    semantics: "site-behavior-lab-boolean-would-block";
    engineLoaded: boolean;
    source: string | null;
    lists: number | null;
    fetchedAt: string | null;
    manifestDigest: string | null;
    engineVersion: string | null;
  };
  coverage: {
    networkRequestRecords: number;
    nativeEvents: number;
    nativeBlockedEvents: number;
    nativeExceptionEvents: number;
    correlatedNativeEvents: number;
    uncorrelatedNativeEvents: number;
    networkRequestRecordsWithoutNativeEvent: number;
    localEvaluations: number;
    cnameRechecksObserved: number;
    droppedNetworkRequestRecords: number;
    droppedNativeEvents: number;
    proxyBlockedTargets: number;
    proxyResourceLimitHit: boolean;
  };
  events: NativeShieldsDifferentialEvent[];
  privacy: {
    redactionVersion: typeof REDACTION_VERSION;
    redaction: RedactionCounters;
  };
  limitations: typeof NATIVE_SHIELDS_DIFFERENTIAL_LIMITATIONS;
};

type LocalAdblockEngine = {
  checkWithMethod(url: string, sourceUrl: string, requestType: string, method: string): boolean;
};

export type BuildNativeShieldsDifferentialInput = {
  generatedAt: string;
  startedAt: string;
  finishedAt: string;
  buildCommit: string | null;
  requestedUrl: string;
  observedUrl: string | null;
  navigation: NativeShieldsDifferentialReceipt["capture"]["navigation"];
  browser: NativeShieldsDifferentialReceipt["capture"]["browser"];
  profile: NativeShieldsDifferentialReceipt["capture"]["profile"];
  engineStatus: AdblockEngineStatus;
  engine: LocalAdblockEngine | null;
  rootFrameId: string | null;
  frames: RawCdpFrame[];
  networkRequests: RawCdpNetworkRequest[];
  nativeEvents: RawNativeAdblockEvent[];
  droppedNetworkRequestRecords: number;
  droppedNativeEvents: number;
  proxyBlockedTargets: number;
  proxyResourceLimitHit: boolean;
};

export function parseNativeAdblockEvent(params: unknown, sequence: number): RawNativeAdblockEvent | null {
  if (!isRecord(params) || !boundedString(params.requestId, MAX_REQUEST_ID_CHARS) || !isRecord(params.info)) {
    return null;
  }
  const info = params.info;
  if (
    !boundedString(info.requestUrl, MAX_URL_CHARS) ||
    !boundedString(info.checkedUrl, MAX_URL_CHARS) ||
    !boundedStringAllowEmpty(info.sourceHost, MAX_HOST_CHARS) ||
    !optionalBoundedString(info.resourceType, MAX_RESOURCE_TYPE_CHARS) ||
    !optionalBoundedString(info.rewrittenUrl, MAX_URL_CHARS) ||
    !booleans(info, [
      "aggressive",
      "blocked",
      "didMatchImportantRule",
      "didMatchRule",
      "didMatchException",
      "hasMockData"
    ])
  ) {
    return null;
  }
  return {
    sequence,
    requestId: params.requestId,
    requestUrl: info.requestUrl,
    checkedUrl: info.checkedUrl,
    sourceHost: info.sourceHost,
    ...(typeof info.resourceType === "string" ? { resourceType: info.resourceType } : {}),
    aggressive: info.aggressive as boolean,
    blocked: info.blocked as boolean,
    didMatchImportantRule: info.didMatchImportantRule as boolean,
    didMatchRule: info.didMatchRule as boolean,
    didMatchException: info.didMatchException as boolean,
    hasMockData: info.hasMockData as boolean,
    ...(typeof info.rewrittenUrl === "string" ? { rewrittenUrl: info.rewrittenUrl } : {})
  };
}

export function parseCdpNetworkRequest(params: unknown, sequence: number): RawCdpNetworkRequest | null {
  if (
    !isRecord(params) ||
    !boundedString(params.requestId, MAX_REQUEST_ID_CHARS) ||
    !isRecord(params.request) ||
    !boundedString(params.request.url, MAX_URL_CHARS) ||
    !boundedStringAllowEmpty(params.documentURL, MAX_URL_CHARS) ||
    !boundedString(params.request.method, 32) ||
    !optionalBoundedString(params.type, MAX_RESOURCE_TYPE_CHARS) ||
    !optionalBoundedString(params.frameId, MAX_REQUEST_ID_CHARS)
  ) {
    return null;
  }
  return {
    sequence,
    requestId: params.requestId,
    url: params.request.url,
    documentUrl: params.documentURL,
    method: params.request.method,
    resourceType: typeof params.type === "string" ? params.type : "Other",
    ...(typeof params.frameId === "string" ? { frameId: params.frameId } : {})
  };
}

export function parseCdpFrame(value: unknown): RawCdpFrame | null {
  if (
    !isRecord(value) ||
    !boundedString(value.id, MAX_REQUEST_ID_CHARS) ||
    !boundedStringAllowEmpty(value.url, MAX_URL_CHARS) ||
    !optionalBoundedString(value.parentId, MAX_REQUEST_ID_CHARS)
  ) {
    return null;
  }
  return {
    id: value.id,
    url: value.url,
    ...(typeof value.parentId === "string" ? { parentId: value.parentId } : {})
  };
}

export function buildNativeShieldsDifferentialReceipt(
  input: BuildNativeShieldsDifferentialInput
): NativeShieldsDifferentialReceipt {
  requireTimestamp(input.generatedAt, "generatedAt");
  requireTimestamp(input.startedAt, "startedAt");
  requireTimestamp(input.finishedAt, "finishedAt");
  if (input.buildCommit !== null && !FULL_GIT_SHA.test(input.buildCommit)) {
    throw new TypeError("buildCommit must be a full lowercase Git SHA or null");
  }
  if (!SHA256.test(input.browser.executableSha256)) {
    throw new TypeError("browser executableSha256 must be lowercase SHA-256");
  }
  if (input.nativeEvents.length > MAX_NATIVE_SHIELDS_EVENTS) {
    throw new TypeError(`nativeEvents exceeds ${MAX_NATIVE_SHIELDS_EVENTS}`);
  }
  if (input.networkRequests.length > MAX_NATIVE_NETWORK_RECORDS) {
    throw new TypeError(`networkRequests exceeds ${MAX_NATIVE_NETWORK_RECORDS}`);
  }

  const redaction = emptyRedactionCounters();
  const redact = (url: string): string => {
    const result = redactUrlV2(url);
    addRedactionCounters(redaction, result.counters);
    return result.value;
  };
  const requestedUrl = redact(input.requestedUrl);
  const observedUrl = input.observedUrl === null ? null : redact(input.observedUrl);
  const frames = new Map(input.frames.map((frame) => [frame.id, frame]));
  const requestsById = groupRequests(input.networkRequests);
  const nativeRequestIds = new Set(input.nativeEvents.map((event) => event.requestId));
  let correlatedNativeEvents = 0;
  let nativeBlockedEvents = 0;
  let nativeExceptionEvents = 0;
  let localEvaluations = 0;
  let cnameRechecksObserved = 0;

  const events = input.nativeEvents.map((event): NativeShieldsDifferentialEvent => {
    const request = correlateRequest(event, requestsById.get(event.requestId) ?? []);
    if (request) correlatedNativeEvents += 1;
    if (event.blocked) nativeBlockedEvents += 1;
    if (event.didMatchException) nativeExceptionEvents += 1;

    const context = localContext(request, event, frames, input.rootFrameId, input.requestedUrl);
    const requestType = context.requestType;
    const method = safeMethod(request?.method);
    const requestUrlDecision = localDecision(
      input.engine,
      request?.url ?? event.requestUrl,
      context,
      method
    );
    if (isEvaluation(requestUrlDecision)) localEvaluations += 1;

    const cnameRecheckObserved = differentHttpHosts(event.requestUrl, event.checkedUrl);
    if (cnameRecheckObserved) cnameRechecksObserved += 1;
    const checkedUrlDecision = cnameRecheckObserved
      ? localDecision(input.engine, event.checkedUrl, context, method)
      : null;
    if (checkedUrlDecision !== null && isEvaluation(checkedUrlDecision)) localEvaluations += 1;

    return {
      requestIdDigest: sha256Hex(event.requestId),
      correlated: request !== null,
      requestUrl: redact(event.requestUrl),
      checkedUrl: redact(event.checkedUrl),
      ...(event.rewrittenUrl !== undefined ? { rewrittenUrl: redact(event.rewrittenUrl) } : {}),
      sourceHost: redactSourceHost(event.sourceHost, redaction),
      resourceType: safeResourceType(event.resourceType ?? request?.resourceType),
      method,
      cnameRecheckObserved,
      native: {
        aggressive: event.aggressive,
        blocked: event.blocked,
        didMatchImportantRule: event.didMatchImportantRule,
        didMatchRule: event.didMatchRule,
        didMatchException: event.didMatchException,
        hasMockData: event.hasMockData,
        rewritten: event.rewrittenUrl !== undefined
      },
      local: {
        requestUrlDecision,
        checkedUrlDecision,
        requestType,
        sourceUrlBasis: context.sourceUrlBasis
      },
      agreement: agreement(event, requestUrlDecision, checkedUrlDecision)
    };
  });

  const hasCaptureLoss =
    input.droppedNetworkRequestRecords > 0 ||
    input.droppedNativeEvents > 0 ||
    input.proxyBlockedTargets > 0 ||
    input.proxyResourceLimitHit ||
    input.navigation.outcome !== "completed" ||
    input.engine === null ||
    correlatedNativeEvents !== events.length;
  const status: NativeShieldsDifferentialReceipt["status"] =
    events.length === 0 ? "inconclusive" : hasCaptureLoss || !input.engineStatus.active ? "partial" : "complete";
  const meta = input.engineStatus;

  const receipt: NativeShieldsDifferentialReceipt = {
    schemaVersion: NATIVE_SHIELDS_DIFFERENTIAL_SCHEMA_VERSION,
    artifactKind: NATIVE_SHIELDS_DIFFERENTIAL_ARTIFACT_KIND,
    generatedAt: input.generatedAt,
    status,
    siteBehaviorLabCommit: input.buildCommit,
    subject: { requestedUrl, observedUrl },
    capture: {
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
      browser: { ...input.browser },
      profile: input.profile,
      shieldsConfiguration: "default-profile-unverified",
      networkMode: "sbl-connect-time-public-proxy",
      navigation: { ...input.navigation }
    },
    simulation: {
      semantics: "site-behavior-lab-boolean-would-block",
      engineLoaded: meta.active && input.engine !== null,
      source: meta.source ?? null,
      lists: meta.lists ?? null,
      fetchedAt: meta.fetchedAt ?? null,
      manifestDigest: meta.manifestDigest ?? null,
      engineVersion: meta.active && input.engine !== null ? meta.engineVersion : null
    },
    coverage: {
      networkRequestRecords: input.networkRequests.length,
      nativeEvents: events.length,
      nativeBlockedEvents,
      nativeExceptionEvents,
      correlatedNativeEvents,
      uncorrelatedNativeEvents: events.length - correlatedNativeEvents,
      networkRequestRecordsWithoutNativeEvent: input.networkRequests.filter(
        (request) => !nativeRequestIds.has(request.requestId)
      ).length,
      localEvaluations,
      cnameRechecksObserved,
      droppedNetworkRequestRecords: input.droppedNetworkRequestRecords,
      droppedNativeEvents: input.droppedNativeEvents,
      proxyBlockedTargets: input.proxyBlockedTargets,
      proxyResourceLimitHit: input.proxyResourceLimitHit
    },
    events,
    privacy: {
      redactionVersion: REDACTION_VERSION,
      redaction
    },
    limitations: NATIVE_SHIELDS_DIFFERENTIAL_LIMITATIONS
  };
  const issues = nativeShieldsDifferentialReceiptIssues(receipt);
  if (issues.length > 0) {
    throw new TypeError(`native Shields differential receipt is invalid: ${issues.join("; ")}`);
  }
  return receipt;
}

export function nativeShieldsDifferentialReceiptText(receipt: NativeShieldsDifferentialReceipt): string {
  const issues = nativeShieldsDifferentialReceiptIssues(receipt);
  if (issues.length > 0) throw new TypeError(`invalid native Shields receipt: ${issues.join("; ")}`);
  return `${JSON.stringify(receipt, null, 2)}\n`;
}

export function nativeShieldsDifferentialReceiptIssues(value: unknown): string[] {
  const issues: string[] = [];
  if (!isRecord(value)) return ["receipt must be an object"];
  if (!exactKeys(value, [
    "schemaVersion",
    "artifactKind",
    "generatedAt",
    "status",
    "siteBehaviorLabCommit",
    "subject",
    "capture",
    "simulation",
    "coverage",
    "events",
    "privacy",
    "limitations"
  ])) issues.push("receipt root keys do not match the closed contract");
  if (value.schemaVersion !== NATIVE_SHIELDS_DIFFERENTIAL_SCHEMA_VERSION) issues.push("unsupported schemaVersion");
  if (value.artifactKind !== NATIVE_SHIELDS_DIFFERENTIAL_ARTIFACT_KIND) issues.push("invalid artifactKind");
  if (!canonicalTimestamp(value.generatedAt)) issues.push("generatedAt must be canonical ISO 8601");
  if (!new Set(["complete", "partial", "inconclusive"]).has(String(value.status))) issues.push("invalid status");
  if (value.siteBehaviorLabCommit !== null && !(typeof value.siteBehaviorLabCommit === "string" && FULL_GIT_SHA.test(value.siteBehaviorLabCommit))) {
    issues.push("invalid siteBehaviorLabCommit");
  }
  if (
    !isRecord(value.subject) ||
    !exactKeys(value.subject, ["requestedUrl", "observedUrl"]) ||
    !safeReceiptUrl(value.subject.requestedUrl) ||
    !nullableSafeReceiptUrl(value.subject.observedUrl)
  ) {
    issues.push("subject URLs are invalid or not redacted");
  }
  if (
    !isRecord(value.capture) ||
    !exactKeys(value.capture, [
      "startedAt",
      "finishedAt",
      "browser",
      "profile",
      "shieldsConfiguration",
      "networkMode",
      "navigation"
    ]) ||
    !canonicalTimestamp(value.capture.startedAt) ||
    !canonicalTimestamp(value.capture.finishedAt) ||
    !new Set(["playwright-temporary-persistent", "operator-dedicated-persistent"]).has(
      String(value.capture.profile)
    ) ||
    value.capture.shieldsConfiguration !== "default-profile-unverified" ||
    value.capture.networkMode !== "sbl-connect-time-public-proxy"
  ) {
    issues.push("capture block is invalid");
  }
  const captureBrowser = isRecord(value.capture) ? value.capture.browser : null;
  if (
    !isRecord(captureBrowser) ||
    !exactKeys(captureBrowser, [
      "executableLabel",
      "version",
      "executableSha256",
      "runtimeBinarySha256",
      "runtimeBinaryKind",
      "headless"
    ]) ||
    !new Set(["brave-stable", "brave-beta", "brave-nightly", "custom"]).has(String(captureBrowser.executableLabel)) ||
    !boundedString(captureBrowser.version, 128) ||
    !SHA256.test(String(captureBrowser.executableSha256 ?? "")) ||
    !SHA256.test(String(captureBrowser.runtimeBinarySha256 ?? "")) ||
    !new Set(["executable", "macos-framework"]).has(String(captureBrowser.runtimeBinaryKind)) ||
    typeof captureBrowser.headless !== "boolean"
  ) {
    issues.push("browser executable digest is invalid");
  }
  const navigation = isRecord(value.capture) ? value.capture.navigation : null;
  if (
    !isRecord(navigation) ||
    !exactKeys(navigation, ["outcome", "status"]) ||
    !new Set(["completed", "timeout", "failed"]).has(String(navigation.outcome)) ||
    !(navigation.status === null || isHttpStatus(navigation.status))
  ) {
    issues.push("navigation block is invalid");
  }
  if (
    !isRecord(value.simulation) ||
    !exactKeys(value.simulation, [
      "semantics",
      "engineLoaded",
      "source",
      "lists",
      "fetchedAt",
      "manifestDigest",
      "engineVersion"
    ]) ||
    value.simulation.semantics !== "site-behavior-lab-boolean-would-block" ||
    typeof value.simulation.engineLoaded !== "boolean" ||
    !nullableBoundedString(value.simulation.source, 256) ||
    !(value.simulation.lists === null || (Number.isSafeInteger(value.simulation.lists) && Number(value.simulation.lists) >= 0)) ||
    !nullableBoundedString(value.simulation.fetchedAt, 64) ||
    !(value.simulation.manifestDigest === null || (typeof value.simulation.manifestDigest === "string" && SHA256.test(value.simulation.manifestDigest))) ||
    !nullableBoundedString(value.simulation.engineVersion, 128)
  ) {
    issues.push("simulation semantics are invalid");
  }
  if (!isCoverage(value.coverage)) {
    issues.push("coverage counters are invalid");
  }
  if (!Array.isArray(value.events) || value.events.length > MAX_NATIVE_SHIELDS_EVENTS) {
    issues.push("events must be a bounded array");
  } else {
    value.events.forEach((event, index) => validateReceiptEvent(event, index, issues));
  }
  if (isRecord(value.coverage) && Array.isArray(value.events)) {
    const correlated = value.events.filter((event) => isRecord(event) && event.correlated === true).length;
    const blocked = value.events.filter((event) => isRecord(event) && isRecord(event.native) && event.native.blocked === true).length;
    const exceptions = value.events.filter((event) => isRecord(event) && isRecord(event.native) && event.native.didMatchException === true).length;
    const cname = value.events.filter((event) => isRecord(event) && event.cnameRecheckObserved === true).length;
    if (
      value.coverage.nativeEvents !== value.events.length ||
      value.coverage.correlatedNativeEvents !== correlated ||
      value.coverage.uncorrelatedNativeEvents !== value.events.length - correlated ||
      value.coverage.nativeBlockedEvents !== blocked ||
      value.coverage.nativeExceptionEvents !== exceptions ||
      value.coverage.cnameRechecksObserved !== cname
    ) {
      issues.push("coverage counters do not derive from events");
    }
    if (
      Number(value.coverage.networkRequestRecordsWithoutNativeEvent) >
        Number(value.coverage.networkRequestRecords) ||
      Number(value.coverage.localEvaluations) > value.events.length * 2
    ) {
      issues.push("coverage counters exceed their observable denominators");
    }
  }
  if (
    !isRecord(value.privacy) ||
    !exactKeys(value.privacy, ["redactionVersion", "redaction"]) ||
    value.privacy.redactionVersion !== REDACTION_VERSION ||
    !isRedactionCounters(value.privacy.redaction)
  ) {
    issues.push("privacy redaction block is invalid");
  }
  if (
    !Array.isArray(value.limitations) ||
    JSON.stringify(value.limitations) !== JSON.stringify(NATIVE_SHIELDS_DIFFERENTIAL_LIMITATIONS)
  ) {
    issues.push("limitations must match the closed methodology list");
  }
  if (isRecord(value.capture)) {
    const started = Date.parse(String(value.capture.startedAt));
    const finished = Date.parse(String(value.capture.finishedAt));
    if (
      !Number.isFinite(started) ||
      !Number.isFinite(finished) ||
      started > finished ||
      value.generatedAt !== value.capture.finishedAt
    ) {
      issues.push("capture chronology is invalid");
    }
  }
  if (isRecord(value.coverage) && isRecord(value.capture) && isRecord(value.simulation)) {
    const nativeEvents = Number(value.coverage.nativeEvents);
    const hasCaptureLoss =
      Number(value.coverage.droppedNetworkRequestRecords) > 0 ||
      Number(value.coverage.droppedNativeEvents) > 0 ||
      Number(value.coverage.proxyBlockedTargets) > 0 ||
      value.coverage.proxyResourceLimitHit === true ||
      isRecord(value.capture.navigation) && value.capture.navigation.outcome !== "completed" ||
      value.simulation.engineLoaded !== true ||
      Number(value.coverage.uncorrelatedNativeEvents) > 0;
    const expectedStatus = nativeEvents === 0 ? "inconclusive" : hasCaptureLoss ? "partial" : "complete";
    if (value.status !== expectedStatus) issues.push("status does not derive from capture coverage");
  }
  return issues;
}

function validateReceiptEvent(value: unknown, index: number, issues: string[]): void {
  if (!isRecord(value)) {
    issues.push(`event ${index} must be an object`);
    return;
  }
  if (!exactKeys(value, [
    "requestIdDigest",
    "correlated",
    "requestUrl",
    "checkedUrl",
    "sourceHost",
    "resourceType",
    "method",
    "cnameRecheckObserved",
    "native",
    "local",
    "agreement"
  ], ["rewrittenUrl"])) issues.push(`event ${index} keys do not match the closed contract`);
  if (!SHA256.test(String(value.requestIdDigest ?? ""))) issues.push(`event ${index} requestIdDigest is invalid`);
  if (typeof value.correlated !== "boolean" || typeof value.cnameRecheckObserved !== "boolean") {
    issues.push(`event ${index} correlation flags are invalid`);
  }
  for (const key of ["requestUrl", "checkedUrl"] as const) {
    if (!safeReceiptUrl(value[key])) issues.push(`event ${index} ${key} is invalid or not redacted`);
  }
  if (value.rewrittenUrl !== undefined && !safeReceiptUrl(value.rewrittenUrl)) {
    issues.push(`event ${index} rewrittenUrl is invalid or not redacted`);
  }
  if (
    typeof value.sourceHost !== "string" ||
    value.sourceHost.length > MAX_HOST_CHARS ||
    /[/?#@]/.test(value.sourceHost) ||
    !boundedString(value.resourceType, 32) ||
    !/^[a-z][a-z0-9_-]{0,31}$/.test(value.resourceType) ||
    !boundedString(value.method, 16) ||
    !/^[A-Z]{1,16}$/.test(value.method)
  ) {
    issues.push(`event ${index} public request metadata is invalid`);
  }
  if (
    !isRecord(value.native) ||
    !exactKeys(value.native, [
      "aggressive",
      "blocked",
      "didMatchImportantRule",
      "didMatchRule",
      "didMatchException",
      "hasMockData",
      "rewritten"
    ]) ||
    !booleans(value.native, [
      "aggressive",
      "blocked",
      "didMatchImportantRule",
      "didMatchRule",
      "didMatchException",
      "hasMockData",
      "rewritten"
    ])
  ) {
    issues.push(`event ${index} native flags are invalid`);
  }
  if (
    !isRecord(value.local) ||
    !exactKeys(value.local, ["requestUrlDecision", "checkedUrlDecision", "requestType", "sourceUrlBasis"]) ||
    !LOCAL_DECISIONS.has(String(value.local.requestUrlDecision)) ||
    !(value.local.checkedUrlDecision === null || LOCAL_DECISIONS.has(String(value.local.checkedUrlDecision))) ||
    !boundedString(value.local.requestType, 32) ||
    !SOURCE_URL_BASES.has(String(value.local.sourceUrlBasis))
  ) issues.push(`event ${index} local decision block is invalid`);
  if (!AGREEMENTS.has(String(value.agreement))) issues.push(`event ${index} agreement is invalid`);
}

function groupRequests(requests: RawCdpNetworkRequest[]): Map<string, RawCdpNetworkRequest[]> {
  const grouped = new Map<string, RawCdpNetworkRequest[]>();
  for (const request of requests) {
    const group = grouped.get(request.requestId) ?? [];
    group.push(request);
    grouped.set(request.requestId, group);
  }
  return grouped;
}

function correlateRequest(event: RawNativeAdblockEvent, requests: RawCdpNetworkRequest[]): RawCdpNetworkRequest | null {
  if (requests.length === 0) return null;
  const prior = requests.filter((request) => request.sequence <= event.sequence);
  const pool = prior.length > 0 ? prior : requests;
  return (
    [...pool].reverse().find((request) => request.url === event.requestUrl) ??
    [...pool].reverse()[0] ??
    null
  );
}

function localContext(
  request: RawCdpNetworkRequest | null,
  nativeEvent: RawNativeAdblockEvent,
  frames: Map<string, RawCdpFrame>,
  rootFrameId: string | null,
  rootSubjectUrl: string
): {
  eligible: boolean;
  sourceUrl: string | null;
  sourceUrlBasis: NativeShieldsDifferentialEvent["local"]["sourceUrlBasis"];
  requestType: string;
} {
  if (!request) {
    const resourceType = (nativeEvent.resourceType ?? "other").toLowerCase();
    const requestType = mapRequestType(cdpResourceTypeToPlaywright(resourceType));
    const sourceUrl = resourceType === "document" ? null : nativeSourceUrl(nativeEvent.sourceHost);
    return sourceUrl
      ? { eligible: true, sourceUrl, sourceUrlBasis: "native-source-host", requestType }
      : { eligible: false, sourceUrl: null, sourceUrlBasis: "unavailable", requestType };
  }
  const resourceType = request.resourceType.toLowerCase();
  const frame = request.frameId ? frames.get(request.frameId) : undefined;
  const isSubFrameNavigation =
    resourceType === "document" &&
    request.frameId !== undefined &&
    rootFrameId !== null &&
    request.frameId !== rootFrameId;
  const requestType = mapRequestType(cdpResourceTypeToPlaywright(resourceType), {
    subFrame: isSubFrameNavigation
  });
  if (resourceType === "document" && !isSubFrameNavigation) {
    return { eligible: false, sourceUrl: null, sourceUrlBasis: "unavailable", requestType };
  }
  if (isSubFrameNavigation && frame?.parentId) {
    const parentUrl = httpUrlFromFrameChain(frame.parentId, frames);
    if (parentUrl) return { eligible: true, sourceUrl: parentUrl, sourceUrlBasis: "parent-frame", requestType };
  }
  if (frame) {
    const frameUrl = httpUrlFromFrameChain(frame.id, frames);
    if (frameUrl) return { eligible: true, sourceUrl: frameUrl, sourceUrlBasis: "frame", requestType };
  }
  if (isHttpUrl(request.documentUrl)) {
    return { eligible: true, sourceUrl: request.documentUrl, sourceUrlBasis: "document-url", requestType };
  }
  if (isHttpUrl(rootSubjectUrl)) {
    return { eligible: true, sourceUrl: rootSubjectUrl, sourceUrlBasis: "root-subject", requestType };
  }
  return { eligible: false, sourceUrl: null, sourceUrlBasis: "unavailable", requestType };
}

function nativeSourceUrl(sourceHost: string): string | null {
  if (!sourceHost || /[/?#@]/.test(sourceHost)) return null;
  try {
    const url = new URL(`https://${sourceHost}/`);
    return url.username === "" && url.password === "" && url.hostname !== "" ? url.toString() : null;
  } catch {
    return null;
  }
}

function localDecision(
  engine: LocalAdblockEngine | null,
  url: string,
  context: ReturnType<typeof localContext>,
  method: string
): NativeShieldsLocalDecision {
  if (!engine) return "engine-unavailable";
  if (!context.eligible || !context.sourceUrl || !isHttpUrl(url)) return "not-evaluated";
  try {
    return engine.checkWithMethod(url, context.sourceUrl, context.requestType, method) ? "would-block" : "would-not-block";
  } catch {
    return "evaluation-failed";
  }
}

function agreement(
  event: RawNativeAdblockEvent,
  request: NativeShieldsLocalDecision,
  checked: NativeShieldsLocalDecision | null
): NativeShieldsAgreement {
  if (event.blocked) {
    if (request === "would-block") return "agrees-block";
    if (checked === "would-block") return "native-block-local-canonical-match";
    if (request === "would-not-block") return "native-block-local-miss";
    return "native-block-local-unresolved";
  }
  if (event.didMatchException) {
    if (request === "would-block") return "native-exception-local-would-block";
    if (request === "would-not-block") return "native-exception-local-nonblock";
    return "native-exception-local-unresolved";
  }
  return "native-event-unclassified";
}

function httpUrlFromFrameChain(frameId: string, frames: Map<string, RawCdpFrame>): string | null {
  const seen = new Set<string>();
  let current: RawCdpFrame | undefined = frames.get(frameId);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    if (isHttpUrl(current.url)) return current.url;
    current = current.parentId ? frames.get(current.parentId) : undefined;
  }
  return null;
}

function cdpResourceTypeToPlaywright(resourceType: string): string {
  if (resourceType === "xhr") return "xhr";
  if (resourceType === "eventsource") return "eventsource";
  if (resourceType === "websocket") return "websocket";
  if (resourceType === "cspviolationreport") return "cspreport";
  if (resourceType === "preflight" || resourceType === "signedexchange") return "other";
  return resourceType;
}

function redactSourceHost(host: string, counters: RedactionCounters): string {
  if (!host) return "";
  const result = redactUrlV2(`https://${host}/`);
  addRedactionCounters(counters, result.counters);
  try {
    return new URL(result.value).hostname;
  } catch {
    return "{invalid-host}";
  }
}

function safeMethod(value: string | undefined): string {
  const method = value?.trim().toUpperCase() ?? "";
  return /^[A-Z]{1,16}$/.test(method) ? method : "OTHER";
}

function safeResourceType(value: string | undefined): string {
  const normalized = value?.trim().toLowerCase() ?? "";
  return /^[a-z][a-z0-9_-]{0,31}$/.test(normalized) ? normalized : "unknown";
}

function differentHttpHosts(left: string, right: string): boolean {
  try {
    const a = new URL(left);
    const b = new URL(right);
    if (!/^https?:$/.test(a.protocol) || !/^https?:$/.test(b.protocol)) return false;
    return a.hostname !== b.hostname;
  } catch {
    return false;
  }
}

function isHttpUrl(value: string): boolean {
  try {
    return /^https?:$/.test(new URL(value).protocol);
  } catch {
    return false;
  }
}

function isEvaluation(value: NativeShieldsLocalDecision): boolean {
  return value === "would-block" || value === "would-not-block";
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function requireTimestamp(value: string, label: string): void {
  if (!canonicalTimestamp(value)) throw new TypeError(`${label} must be canonical ISO 8601`);
}

function safeReceiptUrl(value: unknown): boolean {
  if (value === "{invalid-url}") return true;
  if (typeof value !== "string" || value.includes("?") || value.includes("#") || value.includes("@")) return false;
  return isHttpUrl(value);
}

function nullableSafeReceiptUrl(value: unknown): boolean {
  return value === null || safeReceiptUrl(value);
}

function isRedactionCounters(value: unknown): value is RedactionCounters {
  return isRecord(value) && exactKeys(value, REDACTION_COUNTER_KEYS) && nonNegativeIntegerRecord(value);
}

function isCoverage(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !exactKeys(value, COVERAGE_KEYS) ||
    typeof value.proxyResourceLimitHit !== "boolean"
  ) return false;
  return Object.entries(value).every(
    ([key, entry]) =>
      key === "proxyResourceLimitHit" ||
      (typeof entry === "number" && Number.isSafeInteger(entry) && entry >= 0)
  );
}

function isHttpStatus(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 100 && value <= 599;
}

function nullableBoundedString(value: unknown, max: number): boolean {
  return value === null || boundedStringAllowEmpty(value, max);
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = []
): boolean {
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) && keys.every((key) => allowed.has(key));
}

function nonNegativeIntegerRecord(value: Record<string, unknown>): boolean {
  return Object.values(value).every((entry) => typeof entry === "number" && Number.isSafeInteger(entry) && entry >= 0);
}

function booleans(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => typeof value[key] === "boolean");
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function boundedStringAllowEmpty(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length <= max;
}

function optionalBoundedString(value: unknown, max: number): boolean {
  return value === undefined || boundedStringAllowEmpty(value, max);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
