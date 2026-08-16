import { normalizePageGraphRequests } from "./pagegraph-adapter";
import { PAGEGRAPH_UNSUPPORTED_CAPTURE_LOSS_FAMILIES } from "./capture-loss-detail-contract";
import {
  PAGEGRAPH_R2_MAX_ARTIFACT_BYTES,
  PAGEGRAPH_R2_SUPPORTED_SCHEMA_VERSION,
  pageGraphGraphmlToStrictAdapterInput
} from "./pagegraph-parser";
import {
  REDACTION_VERSION,
  addRedactionCounters,
  emptyRedactionCounters,
  publicRegistrableDomain,
  redactPageTitle,
  redactUrlV2
} from "./redaction-v2";
import {
  RedactionPass,
  redactRequest,
  redactScannerWarnings
} from "./redact-scan-report-v1";
import { MAX_RECORDED_REQUESTS } from "./scan-runtime";
import { buildFingerprints } from "./scan-report-v2-fingerprints";
import {
  R2_NAVIGATION_STATUS_UNREPRESENTABLE,
  R2_REQUEST_STATUS_UNREPRESENTABLE,
  isHttpStatusCode,
  normalizeHttpStatusForScanReportV2R2
} from "./scan-report-v2-http-status";
import { scanReportV2R2SemanticViolations } from "./scan-report-v2-r2-evaluators";
import { NODE_SCAN_REPORT_V2_R2_MAX_PUBLIC_BYTES } from "./scan-report-v2-r2-limits";
import { isPublicScanReportV2R2 } from "./scan-report-v2-r2-validation";
import {
  SCAN_REPORT_V2_SCHEMA_REVISION_2,
  type PublicSingleReportV2R2,
  type ScanRunV2R2
} from "./scan-report-v2-r2";
import { evaluateQuality } from "./scan-report-v2-evaluators";
import {
  DETECTOR_IDS,
  SCAN_REPORT_V2_SCHEMA_VERSION,
  type CaptureLossEntry,
  type ConditionVector,
  type DetectorLedger,
  type QualityFacts,
  type SubjectKey,
  type Toolchain
} from "./scan-report-v2";
import { sha256BytesHex } from "./sha256";
import { trackerCatalogMetadata } from "./tracker-catalog";
import { PAGEGRAPH_R2_NORMALIZATION_VERSION } from "./scan-report-v2-normalization";
import {
  PAGEGRAPH_R2_DETECTOR_REGISTRY_DIGEST,
  PAGEGRAPH_R2_DETECTOR_REGISTRY_VERSION,
  PAGEGRAPH_R2_DETECTOR_VERSION,
  PAGEGRAPH_R2_EXPECTED_DETECTORS,
  PAGEGRAPH_R2_METHODOLOGY_VERSION
} from "./scan-report-v2-r2-producer-contract";
import type { NetworkRequestProvenance, NetworkRequestRecord } from "./types";

/** Exact sidecar contract accepted by the browser-safe PageGraph r2 importer. */
export const PAGEGRAPH_CAPTURE_METADATA_SCHEMA = "site-behavior-lab/pagegraph-capture@1" as const;
export {
  PAGEGRAPH_R2_DETECTOR_REGISTRY_DIGEST,
  PAGEGRAPH_R2_DETECTOR_REGISTRY_VERSION,
  PAGEGRAPH_R2_DETECTOR_VERSION,
  PAGEGRAPH_R2_METHODOLOGY_VERSION
} from "./scan-report-v2-r2-producer-contract";
export { PAGEGRAPH_R2_NORMALIZATION_VERSION } from "./scan-report-v2-normalization";

const SHA256 = /^[0-9a-f]{64}$/;
const FULL_GIT_SHA = /^[0-9a-f]{40}$/;
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:+@/-]{0,127}$/;
const SAFE_CODE = /^[a-z0-9][a-z0-9._:-]{0,63}$/;
const LOCALE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
const TIMEZONE = /^[A-Za-z0-9_+.-]+(?:\/[A-Za-z0-9_+.-]+)*$/;
const MAX_DURATION_MS = 60 * 60 * 1000;
const PAGEGRAPH_DISCLOSURE =
  "This report was adapted from Brave PageGraph-derived observations. Treat it as evidence for the recorded crawl conditions, not a universal claim about all visitors.";
const PAGEGRAPH_SELF_REPORTED_DISCLOSURE =
  "PageGraph browser and environment conditions, pagegraph-crawl version and source revision, sanitizer identity, and quality and coverage declarations are self-reported by the supplied metadata sidecar, not cryptographic proof or artifact-derived attestation; the GraphML description independently binds only schema, root URL, capture date, and duration.";
const PAGEGRAPH_UNSUPPORTED_DISCLOSURE =
  "PageGraph r2 imports emit request observations only. Cookie, storage, fingerprinting, detector, and consent evidence are unsupported and explicitly censored.";
const PAGEGRAPH_NO_CAUSALITY_DISCLOSURE =
  "No PageGraph request provenance was supplied. This report can show observed requests but not script-to-request causality.";

const UNSUPPORTED_COVERAGE = Object.freeze({ outcome: "unsupported" as const });
const UNSUPPORTED_FAMILIES = PAGEGRAPH_UNSUPPORTED_CAPTURE_LOSS_FAMILIES;

export type PageGraphRequestCoverage =
  | { outcome: "complete" }
  | {
      outcome: "censored";
      kind: "dropped" | "clipped" | "truncated" | "timeout" | "cap";
      /** Exact positive number of request observations omitted by the capture. */
      count: number;
      budget: "request-capture" | "request-upload" | null;
    };

export type PageGraphCaptureMetadataV1 = {
  $schema: typeof PAGEGRAPH_CAPTURE_METADATA_SCHEMA;
  artifact: {
    sha256: string;
    bytes: number;
    sanitizerVersion: string;
  };
  capture: {
    requestedUrl: string;
    finalUrl: string;
    scannedAt: string;
    durationMs: number;
    pageTitle: string;
    browser: {
      name: "Brave Nightly";
      version: string;
      chromiumVersion: string;
      userAgent: string;
    };
    locale: string;
    language: string;
    timezone: string;
    device: {
      kind: "desktop" | "mobile";
      viewport: { width: number; height: number; isMobile: boolean };
    };
    headless: boolean;
    gpc: boolean;
    /** r2 @1 does not mislabel live Brave blocking as the scanner's block simulation. */
    shields: "off";
    egress: { label: string; region: string };
    timestampOrigin: "navigation-start";
    timestampUnit: "milliseconds";
  };
  tool: {
    name: "pagegraph-crawl";
    version: string;
    sourceRevision: string;
    pageGraphSchemaVersion: string;
  };
  quality: {
    status: number | null;
    navigationSettled: boolean;
    botWallTitleMatched: boolean;
    families: {
      requests: PageGraphRequestCoverage;
      cookies: { outcome: "unsupported" };
      storage: { outcome: "unsupported" };
      fingerprinting: { outcome: "unsupported" };
      "detector-output": { outcome: "unsupported" };
      "consent-verification": { outcome: "unsupported" };
    };
  };
  /** Explicit capture testimony; @1 requires every non-request detector unsupported. */
  detectors: DetectorLedger;
};

/** Trusted app-build context, deliberately separate from the untrusted sidecar. */
export type PageGraphR2BuildContext = {
  buildCommit: string;
  runId: string;
  /** Off for arbitrary local uploads; on only for deliberate fixture provenance. */
  includeSourceArtifactDigest?: boolean;
};

const EXPECTED_DETECTORS = PAGEGRAPH_R2_EXPECTED_DETECTORS;

/**
 * Parse and validate an untrusted metadata sidecar. Every object is exact-key;
 * unknown fields and all "unknown" placeholder identities fail closed.
 */
export function parsePageGraphCaptureMetadata(value: unknown): PageGraphCaptureMetadataV1 {
  const root = exactRecord(value, ["$schema", "artifact", "capture", "tool", "quality", "detectors"], "metadata");
  if (root.$schema !== PAGEGRAPH_CAPTURE_METADATA_SCHEMA) {
    throw new Error(`PageGraph metadata must declare ${PAGEGRAPH_CAPTURE_METADATA_SCHEMA}.`);
  }

  const artifact = exactRecord(root.artifact, ["sha256", "bytes", "sanitizerVersion"], "artifact");
  const capture = exactRecord(
    root.capture,
    [
      "requestedUrl",
      "finalUrl",
      "scannedAt",
      "durationMs",
      "pageTitle",
      "browser",
      "locale",
      "language",
      "timezone",
      "device",
      "headless",
      "gpc",
      "shields",
      "egress",
      "timestampOrigin",
      "timestampUnit"
    ],
    "capture"
  );
  const browser = exactRecord(capture.browser, ["name", "version", "chromiumVersion", "userAgent"], "capture.browser");
  const device = exactRecord(capture.device, ["kind", "viewport"], "capture.device");
  const viewport = exactRecord(device.viewport, ["width", "height", "isMobile"], "capture.device.viewport");
  const egress = exactRecord(capture.egress, ["label", "region"], "capture.egress");
  const tool = exactRecord(root.tool, ["name", "version", "sourceRevision", "pageGraphSchemaVersion"], "tool");
  const quality = exactRecord(root.quality, ["status", "navigationSettled", "botWallTitleMatched", "families"], "quality");
  const families = exactRecord(
    quality.families,
    ["requests", "cookies", "storage", "fingerprinting", "detector-output", "consent-verification"],
    "quality.families"
  );

  if (typeof artifact.sha256 !== "string" || !SHA256.test(artifact.sha256)) {
    throw new Error("PageGraph artifact sha256 must be a lowercase 64-character digest.");
  }
  if (!isPositiveSafeInteger(artifact.bytes) || artifact.bytes > PAGEGRAPH_R2_MAX_ARTIFACT_BYTES) {
    throw new Error(`PageGraph artifact bytes must be between 1 and ${PAGEGRAPH_R2_MAX_ARTIFACT_BYTES}.`);
  }
  assertSafeIdentity("artifact sanitizerVersion", artifact.sanitizerVersion);

  const requestedUrl = exactHttpUrl(capture.requestedUrl, "capture.requestedUrl");
  const finalUrl = exactHttpUrl(capture.finalUrl, "capture.finalUrl");
  assertCanonicalTimestamp(capture.scannedAt, "capture.scannedAt");
  if (!isCount(capture.durationMs) || capture.durationMs > MAX_DURATION_MS) {
    throw new Error(`PageGraph capture.durationMs must be an integer from 0 through ${MAX_DURATION_MS}.`);
  }
  if (typeof capture.pageTitle !== "string" || containsControl(capture.pageTitle)) {
    throw new Error("PageGraph capture.pageTitle must be control-free text.");
  }
  if (browser.name !== "Brave Nightly") throw new Error("PageGraph r2 @1 requires Brave Nightly capture identity.");
  assertSafeIdentity("browser version", browser.version);
  assertSafeIdentity("Chromium version", browser.chromiumVersion);
  if (
    typeof browser.userAgent !== "string" ||
    !browser.userAgent.trim() ||
    browser.userAgent.length > 512 ||
    containsControl(browser.userAgent)
  ) {
    throw new Error("PageGraph browser userAgent is missing or outside its public envelope.");
  }
  assertPattern("locale", capture.locale, LOCALE);
  assertPattern("language", capture.language, LOCALE);
  assertPattern("timezone", capture.timezone, TIMEZONE);
  if (device.kind !== "desktop" && device.kind !== "mobile") throw new Error("PageGraph device kind is invalid.");
  assertViewport(viewport.width, "width");
  assertViewport(viewport.height, "height");
  if (typeof viewport.isMobile !== "boolean" || (device.kind === "mobile") !== viewport.isMobile) {
    throw new Error("PageGraph device kind disagrees with viewport.isMobile.");
  }
  if (typeof capture.headless !== "boolean" || typeof capture.gpc !== "boolean") {
    throw new Error("PageGraph headless and GPC capture facts must be booleans.");
  }
  if (capture.shields !== "off") {
    throw new Error("PageGraph r2 @1 only admits captures with Brave Shields explicitly off.");
  }
  assertPattern("egress label", egress.label, SAFE_CODE);
  assertPattern("egress region", egress.region, SAFE_CODE);
  if (capture.timestampOrigin !== "navigation-start" || capture.timestampUnit !== "milliseconds") {
    throw new Error("PageGraph r2 @1 requires navigation-start millisecond timestamps.");
  }

  if (tool.name !== "pagegraph-crawl") throw new Error("PageGraph tool name must be pagegraph-crawl.");
  assertSafeIdentity("pagegraph-crawl version", tool.version);
  if (typeof tool.sourceRevision !== "string" || !FULL_GIT_SHA.test(tool.sourceRevision)) {
    throw new Error("PageGraph tool sourceRevision must be a full lowercase Git SHA.");
  }
  if (tool.pageGraphSchemaVersion !== PAGEGRAPH_R2_SUPPORTED_SCHEMA_VERSION) {
    throw new Error(`PageGraph r2 @1 requires PageGraph schema ${PAGEGRAPH_R2_SUPPORTED_SCHEMA_VERSION}.`);
  }

  if (quality.status !== null && !isHttpStatusCode(quality.status)) {
    throw new Error("PageGraph quality.status must be null or an HTTP status from 100 through 999.");
  }
  if (typeof quality.navigationSettled !== "boolean" || typeof quality.botWallTitleMatched !== "boolean") {
    throw new Error("PageGraph navigation and bot-wall quality facts must be booleans.");
  }
  validateRequestCoverage(families.requests);
  for (const family of UNSUPPORTED_FAMILIES) {
    const declaration = exactRecord(families[family], ["outcome"], `quality.families.${family}`);
    if (declaration.outcome !== UNSUPPORTED_COVERAGE.outcome) {
      throw new Error(`PageGraph r2 @1 requires ${family} coverage to be explicitly unsupported.`);
    }
  }
  validateDetectorDeclaration(root.detectors);

  // Construct by name so getters/prototypes and unknown references never
  // survive validation into the producer.
  return {
    $schema: PAGEGRAPH_CAPTURE_METADATA_SCHEMA,
    artifact: {
      sha256: artifact.sha256,
      bytes: artifact.bytes,
      sanitizerVersion: artifact.sanitizerVersion
    },
    capture: {
      requestedUrl,
      finalUrl,
      scannedAt: capture.scannedAt,
      durationMs: capture.durationMs,
      pageTitle: capture.pageTitle,
      browser: {
        name: "Brave Nightly",
        version: browser.version,
        chromiumVersion: browser.chromiumVersion,
        userAgent: browser.userAgent
      },
      locale: capture.locale,
      language: capture.language,
      timezone: capture.timezone,
      device: {
        kind: device.kind,
        viewport: { width: viewport.width, height: viewport.height, isMobile: viewport.isMobile }
      },
      headless: capture.headless,
      gpc: capture.gpc,
      shields: "off",
      egress: { label: egress.label, region: egress.region },
      timestampOrigin: "navigation-start",
      timestampUnit: "milliseconds"
    },
    tool: {
      name: "pagegraph-crawl",
      version: tool.version,
      sourceRevision: tool.sourceRevision,
      pageGraphSchemaVersion: tool.pageGraphSchemaVersion
    },
    quality: {
      status: quality.status,
      navigationSettled: quality.navigationSettled,
      botWallTitleMatched: quality.botWallTitleMatched,
      families: {
        requests: copyRequestCoverage(families.requests),
        cookies: { outcome: "unsupported" },
        storage: { outcome: "unsupported" },
        fingerprinting: { outcome: "unsupported" },
        "detector-output": { outcome: "unsupported" },
        "consent-verification": { outcome: "unsupported" }
      }
    },
    detectors: structuredClone(EXPECTED_DETECTORS)
  };
}

/**
 * Produce one descriptive, passive ScanReport v2/r2 from exact artifact bytes.
 * No Node globals, Node builder, Buffer, or process environment are reachable
 * from this module.
 */
export function buildPageGraphScanReportV2R2(
  artifactBytes: Uint8Array,
  metadataValue: unknown,
  contextValue: PageGraphR2BuildContext
): PublicSingleReportV2R2 {
  const metadata = parsePageGraphCaptureMetadata(metadataValue);
  const context = validateBuildContext(contextValue);
  if (!(artifactBytes instanceof Uint8Array) || artifactBytes.byteLength === 0) {
    throw new Error("PageGraph artifact bytes are required.");
  }
  if (artifactBytes.byteLength > PAGEGRAPH_R2_MAX_ARTIFACT_BYTES) {
    throw new Error(`PageGraph artifacts must not exceed ${PAGEGRAPH_R2_MAX_ARTIFACT_BYTES} bytes.`);
  }
  if (artifactBytes.byteLength !== metadata.artifact.bytes) {
    throw new Error("PageGraph artifact byte length does not match its metadata.");
  }
  const artifactDigest = sha256BytesHex(artifactBytes);
  if (artifactDigest !== metadata.artifact.sha256) {
    throw new Error("PageGraph artifact SHA-256 does not match its metadata.");
  }

  let graphml: string;
  try {
    graphml = new TextDecoder("utf-8", { fatal: true }).decode(artifactBytes);
  } catch {
    throw new Error("PageGraph artifacts must be valid UTF-8 GraphML.");
  }

  const parserWarnings: string[] = [];
  const parsed = pageGraphGraphmlToStrictAdapterInput(graphml, {
    requestedUrl: metadata.capture.requestedUrl,
    finalUrl: metadata.capture.finalUrl,
    scannedAt: metadata.capture.scannedAt,
    pageTitle: metadata.capture.pageTitle,
    status: metadata.quality.status,
    durationMs: metadata.capture.durationMs,
    chromiumVersion: `Brave/${metadata.capture.browser.version} Chromium/${metadata.capture.browser.chromiumVersion}`,
    userAgent: metadata.capture.browser.userAgent,
    timezone: metadata.capture.timezone,
    locale: metadata.capture.locale,
    language: metadata.capture.language,
    device: metadata.capture.device.kind,
    viewport: metadata.capture.device.viewport,
    gpcEnabled: metadata.capture.gpc,
    headless: metadata.capture.headless,
    scannerEgress: metadata.capture.egress.label,
    warnings: parserWarnings
  });
  if (canonicalHttpUrl(parsed.graphRootUrl) !== metadata.capture.finalUrl) {
    throw new Error("PageGraph root URL does not match capture.finalUrl.");
  }
  if (parsed.description.schemaVersion !== metadata.tool.pageGraphSchemaVersion) {
    throw new Error("PageGraph description schema version does not match the metadata sidecar.");
  }
  if (parsed.description.rootUrl !== metadata.capture.finalUrl) {
    throw new Error("PageGraph description root URL does not match capture.finalUrl.");
  }
  if (parsed.description.scannedAt !== metadata.capture.scannedAt) {
    throw new Error("PageGraph description capture date does not match capture.scannedAt.");
  }
  if (parsed.description.durationMs !== metadata.capture.durationMs) {
    throw new Error("PageGraph description time interval does not match capture.durationMs.");
  }

  const rawObservations = parsed.requests ?? [];
  assertPageGraphRequestStatusVocabulary(rawObservations);
  const normalizationWarnings = [
    PAGEGRAPH_DISCLOSURE,
    PAGEGRAPH_SELF_REPORTED_DISCLOSURE,
    PAGEGRAPH_UNSUPPORTED_DISCLOSURE,
    ...(parsed.warnings ?? [])
  ];
  const firstPartyDomain = new URL(metadata.capture.finalUrl).hostname;
  const normalized = normalizePageGraphRequests(
    rawObservations,
    firstPartyDomain,
    normalizationWarnings,
    undefined,
    { requireTimestamps: true, aggregateInvalidWarnings: true }
  );
  for (const request of normalized) {
    if (request.startedAtMs > metadata.capture.durationMs) {
      throw new Error(`PageGraph request ${request.id} starts after the declared capture duration.`);
    }
  }

  const retainedSource = normalized.slice(0, MAX_RECORDED_REQUESTS);
  const statusNormalized = normalizePageGraphR2HttpStatuses(metadata.quality.status, retainedSource);
  const qualityFacts = buildQualityFacts(
    metadata,
    rawObservations.length - normalized.length,
    Math.max(0, normalized.length - MAX_RECORDED_REQUESTS),
    statusNormalized.status,
    statusNormalized.captureLoss
  );
  const retained = statusNormalized.requests;
  if (
    retained.length > 0 &&
    retained.every((request) => !hasHumanReadableProvenance(request.provenance))
  ) {
    normalizationWarnings.push(PAGEGRAPH_NO_CAUSALITY_DISCLOSURE);
  }
  const privacyCounters = emptyRedactionCounters();
  const subject = {
    requested: subjectKey(metadata.capture.requestedUrl, privacyCounters),
    observed: subjectKey(metadata.capture.finalUrl, privacyCounters)
  };
  const pass = new RedactionPass();
  const requests = retained.map((request) => ({ ...redactRequest(request, pass), phaseId: 0 }));
  const warnings = redactScannerWarnings(normalizationWarnings, pass);
  addRedactionCounters(privacyCounters, pass.counters);

  const conditions: ConditionVector = {
    gpc: metadata.capture.gpc,
    shields: "off",
    consent: "observe",
    device: structuredClone(metadata.capture.device),
    probes: { keystroke: false, policyVisit: false },
    locale: metadata.capture.locale,
    language: metadata.capture.language,
    timezone: metadata.capture.timezone,
    egress: structuredClone(metadata.capture.egress),
    browser: {
      name: metadata.capture.browser.name,
      version: `${metadata.capture.browser.version}+chromium-${metadata.capture.browser.chromiumVersion}`
    },
    headless: metadata.capture.headless,
    automation: "brave-pagegraph"
  };
  const detectors = structuredClone(metadata.detectors);
  const provenance: ScanRunV2R2["provenance"] = {
    observer: "pagegraph-import",
    acquisition: "upload",
    buildCommit: context.buildCommit,
    methodologyVersion: methodologyIdentity(metadata),
    detectorRegistry: {
      version: PAGEGRAPH_R2_DETECTOR_REGISTRY_VERSION,
      digest: PAGEGRAPH_R2_DETECTOR_REGISTRY_DIGEST
    },
    ...(context.includeSourceArtifactDigest ? { sourceArtifactDigest: artifactDigest } : {})
  };
  const toolchain: Toolchain = {
    trackerCatalog: {
      source: trackerCatalogMetadata.source,
      version: trackerCatalogMetadata.version,
      entries: trackerCatalogMetadata.entries,
      digest: trackerCatalogMetadata.digest
    },
    adblock: null,
    normalizationVersion: PAGEGRAPH_R2_NORMALIZATION_VERSION
  };
  const thirdPartyRequests = requests.filter((request) => request.thirdParty);
  const run: ScanRunV2R2 = {
    runId: context.runId,
    startedAt: metadata.capture.scannedAt,
    subject,
    conditions,
    provenance,
    toolchain,
    fingerprints: buildFingerprints({ conditions, provenance, toolchain, detectors }),
    qualityFacts,
    quality: evaluateQuality(qualityFacts, { observedRequests: requests.length }),
    privacy: { redactionVersion: REDACTION_VERSION, redaction: privacyCounters },
    detectors,
    phases: [{ phaseId: 0, kind: "passive-load", startedAtMs: 0, endedAtMs: metadata.capture.durationMs }],
    summary: {
      pageTitle: redactPageTitle(metadata.capture.pageTitle),
      status: statusNormalized.status,
      durationMs: metadata.capture.durationMs,
      counts: {
        totalRequests: requests.length,
        thirdPartyRequests: thirdPartyRequests.length,
        knownTrackerRequests: requests.filter((request) => request.tracker !== null).length,
        thirdPartyDomains: new Set(thirdPartyRequests.map((request) => request.domain)).size,
        cookies: 0,
        thirdPartyCookies: 0,
        storageEntries: 0,
        fingerprintEvents: 0
      },
      countsByPhase:
        requests.length === 0
          ? []
          : [
              {
                phaseId: 0,
                totalRequests: requests.length,
                thirdPartyRequests: thirdPartyRequests.length,
                knownTrackerRequests: requests.filter((request) => request.tracker !== null).length
              }
            ]
    },
    evidence: {
      requests,
      cookieMutations: [],
      cookiesFinal: [],
      storageMutations: [],
      storageFinal: [],
      fingerprintEvents: [],
      fingerprintDetections: [],
      cnameCloaks: [],
      pixelEvents: []
    },
    warnings
  };
  const report: PublicSingleReportV2R2 = {
    schemaVersion: SCAN_REPORT_V2_SCHEMA_VERSION,
    schemaRevision: SCAN_REPORT_V2_SCHEMA_REVISION_2,
    reportType: "single",
    run
  };

  if (!isPublicScanReportV2R2(report)) {
    throw new Error("Refusing to build an invalid PageGraph ScanReport v2/r2 wire.");
  }
  const violations = scanReportV2R2SemanticViolations(report);
  if (violations.length > 0) {
    throw new Error(`Refusing to build an inconsistent PageGraph ScanReport v2/r2: ${violations.join("; ")}`);
  }
  if (new TextEncoder().encode(`${JSON.stringify(report, null, 2)}\n`).byteLength > NODE_SCAN_REPORT_V2_R2_MAX_PUBLIC_BYTES) {
    throw new Error(
      `Refusing to build a PageGraph ScanReport v2/r2 larger than ${NODE_SCAN_REPORT_V2_R2_MAX_PUBLIC_BYTES} public bytes.`
    );
  }
  return report;
}

function hasHumanReadableProvenance(provenance: NetworkRequestProvenance | undefined): boolean {
  return Boolean(
    provenance?.initiatorUrl ||
      provenance?.initiatorDomain ||
      provenance?.scriptUrl ||
      provenance?.scriptDomain ||
      provenance?.injectedByUrl ||
      provenance?.injectedByDomain
  );
}

function validateBuildContext(value: PageGraphR2BuildContext): Required<PageGraphR2BuildContext> {
  const context = exactRecord(value, ["buildCommit", "runId", "includeSourceArtifactDigest"], "build context", true);
  if (typeof context.buildCommit !== "string" || !FULL_GIT_SHA.test(context.buildCommit)) {
    throw new Error("PageGraph report buildCommit must come from a full lowercase app-build Git SHA.");
  }
  if (
    typeof context.runId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(context.runId) ||
    context.runId.toLowerCase() === "unknown"
  ) {
    throw new Error("PageGraph report runId must be an opaque producer token.");
  }
  if (context.includeSourceArtifactDigest !== undefined && typeof context.includeSourceArtifactDigest !== "boolean") {
    throw new Error("PageGraph includeSourceArtifactDigest must be boolean when supplied.");
  }
  return {
    buildCommit: context.buildCommit,
    runId: context.runId,
    includeSourceArtifactDigest: context.includeSourceArtifactDigest ?? false
  };
}

function validateRequestCoverage(value: unknown): asserts value is PageGraphRequestCoverage {
  const coverage = exactRecord(
    value,
    isRecord(value) && value.outcome === "complete" ? ["outcome"] : ["outcome", "kind", "count", "budget"],
    "quality.families.requests"
  );
  if (coverage.outcome === "complete") return;
  if (coverage.outcome !== "censored") throw new Error("PageGraph request coverage must be complete or censored.");
  if (!["dropped", "clipped", "truncated", "timeout", "cap"].includes(String(coverage.kind))) {
    throw new Error("PageGraph censored request coverage has an invalid loss kind.");
  }
  if (!isPositiveSafeInteger(coverage.count)) {
    throw new Error("PageGraph censored request coverage requires an exact positive loss count.");
  }
  if (coverage.budget !== null && coverage.budget !== "request-capture" && coverage.budget !== "request-upload") {
    throw new Error("PageGraph request loss budget is invalid.");
  }
}

function copyRequestCoverage(value: unknown): PageGraphRequestCoverage {
  validateRequestCoverage(value);
  if (value.outcome === "complete") return { outcome: "complete" };
  return { outcome: "censored", kind: value.kind, count: value.count, budget: value.budget };
}

function validateDetectorDeclaration(value: unknown): void {
  const detectors = exactRecord(value, [...DETECTOR_IDS], "detectors");
  for (const id of DETECTOR_IDS) {
    const entry = exactRecord(detectors[id], ["version", "status", "reason"], `detectors.${id}`);
    if (
      entry.version !== PAGEGRAPH_R2_DETECTOR_VERSION ||
      entry.status !== "unsupported" ||
      entry.reason !== "unsupported"
    ) {
      throw new Error(`PageGraph detector ${id} must explicitly declare the @1 unsupported identity.`);
    }
  }
}

function assertPageGraphRequestStatusVocabulary(requests: Array<{ status?: number | null }>): void {
  for (const [index, request] of requests.entries()) {
    // PageGraph uses zero for a request-error completion; the adapter turns
    // that non-HTTP sentinel into null. Every other numeric value must obey
    // the real three-digit status grammar before r2 normalization.
    if (
      request.status !== undefined &&
      request.status !== null &&
      request.status !== 0 &&
      !isHttpStatusCode(request.status)
    ) {
      throw new Error(`PageGraph request ${index + 1} HTTP status must be 0, null, or an integer from 100 through 999.`);
    }
  }
}

function normalizePageGraphR2HttpStatuses(
  navigationStatus: number | null,
  requests: NetworkRequestRecord[]
): { status: number | null; requests: NetworkRequestRecord[]; captureLoss: CaptureLossEntry[] } {
  const navigation = normalizeHttpStatusForScanReportV2R2(navigationStatus, "PageGraph quality HTTP status");
  const captureLoss: CaptureLossEntry[] = [];
  if (navigation.unrepresentable) {
    captureLoss.push({
      family: "requests",
      phaseId: null,
      kind: "dropped",
      count: 1,
      detail: R2_NAVIGATION_STATUS_UNREPRESENTABLE
    });
  }

  let requestStatusLoss = 0;
  const normalizedRequests = requests.map((request, index) => {
    const normalized = normalizeHttpStatusForScanReportV2R2(
      request.status,
      `PageGraph request ${index + 1} HTTP status`
    );
    if (normalized.unrepresentable) requestStatusLoss += 1;
    return { ...request, status: normalized.status };
  });
  if (requestStatusLoss > 0) {
    captureLoss.push({
      family: "requests",
      phaseId: 0,
      kind: "dropped",
      count: requestStatusLoss,
      detail: R2_REQUEST_STATUS_UNREPRESENTABLE
    });
  }

  return { status: navigation.status, requests: normalizedRequests, captureLoss };
}

function buildQualityFacts(
  metadata: PageGraphCaptureMetadataV1,
  invalidRequestsDropped: number,
  publicRequestsClipped: number,
  status: number | null,
  statusCaptureLoss: CaptureLossEntry[]
): QualityFacts {
  const captureLoss: CaptureLossEntry[] = UNSUPPORTED_FAMILIES.map((family) => ({
    family,
    phaseId: null,
    kind: "dropped",
    // Zero is an explicit unsupported-family sentinel, not a fabricated
    // estimate of records that the capture never attempted to collect.
    count: 0,
    detail: "pagegraph-unsupported"
  }));
  captureLoss.push(...statusCaptureLoss.map((entry) => ({ ...entry })));
  const budgetsExhausted: string[] = [];
  const requests = metadata.quality.families.requests;
  if (requests.outcome === "censored") {
    captureLoss.push({
      family: "requests",
      phaseId: 0,
      kind: requests.kind,
      count: requests.count,
      detail: requests.budget ?? "pagegraph-request-loss"
    });
    if (requests.budget !== null) budgetsExhausted.push(requests.budget);
  }
  if (invalidRequestsDropped > 0) {
    captureLoss.push({
      family: "requests",
      phaseId: 0,
      kind: "dropped",
      count: invalidRequestsDropped,
      detail: "pagegraph-invalid-request"
    });
  }
  if (publicRequestsClipped > 0) {
    captureLoss.push({
      family: "requests",
      phaseId: 0,
      kind: "clipped",
      count: publicRequestsClipped,
      detail: "public-request-records"
    });
    budgetsExhausted.push("public-request-records");
  }
  return {
    status,
    botWallTitleMatched: metadata.quality.botWallTitleMatched,
    navigationSettled: metadata.quality.navigationSettled,
    budgetsExhausted,
    captureLoss
  };
}

function methodologyIdentity(metadata: PageGraphCaptureMetadataV1): string {
  return [
    PAGEGRAPH_R2_METHODOLOGY_VERSION,
    `crawl-${metadata.tool.version}`,
    `crawl-sha-${metadata.tool.sourceRevision}`,
    `schema-${metadata.tool.pageGraphSchemaVersion}`,
    `sanitizer-${metadata.artifact.sanitizerVersion}`
  ].join("+");
}

function subjectKey(rawUrl: string, counters: ReturnType<typeof emptyRedactionCounters>): SubjectKey {
  const parsed = new URL(rawUrl);
  const registrableDomain = publicRegistrableDomain(parsed.hostname);
  if (registrableDomain === null) throw new Error("PageGraph subject URL has no registrable domain.");
  const redacted = redactUrlV2(rawUrl, { preserveQueryKeys: false });
  addRedactionCounters(counters, redacted.counters);
  const pathStart = redacted.value.indexOf("/", redacted.value.indexOf("//") + 2);
  if (pathStart < 0) throw new Error("PageGraph subject URL could not be shaped by redaction v2.");
  return {
    origin: redacted.value.slice(0, pathStart),
    registrableDomain,
    routeShape: redacted.value.slice(pathStart)
  };
}

function exactHttpUrl(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`PageGraph ${label} must be a canonical HTTP(S) URL.`);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`PageGraph ${label} must be a canonical HTTP(S) URL.`);
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    !parsed.hostname ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.toString() !== value
  ) {
    throw new Error(`PageGraph ${label} must be a canonical credential-free HTTP(S) URL.`);
  }
  return value;
}

function canonicalHttpUrl(value: string): string {
  return new URL(value).toString();
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
  optionalLast = false
): Record<string, any> {
  if (!isRecord(value)) throw new Error(`PageGraph ${label} must be an object.`);
  const actual = Object.keys(value).sort();
  const required = optionalLast ? keys.slice(0, -1) : keys;
  if (required.some((key) => !Object.prototype.hasOwnProperty.call(value, key))) {
    throw new Error(`PageGraph ${label} is missing required fields.`);
  }
  if (actual.some((key) => !keys.includes(key))) {
    throw new Error(`PageGraph ${label} contains an unknown field.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return isCount(value) && value > 0;
}

function assertCanonicalTimestamp(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error(`PageGraph ${label} must be a canonical ISO timestamp.`);
  }
}

function assertViewport(value: unknown, label: string): asserts value is number {
  if (!isPositiveSafeInteger(value) || value > 10_000) {
    throw new Error(`PageGraph viewport ${label} must be an integer from 1 through 10000.`);
  }
}

function assertSafeIdentity(label: string, value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !SAFE_TOKEN.test(value) ||
    value.trim().toLowerCase() === "unknown"
  ) {
    throw new Error(`PageGraph ${label} must be a known bounded identity.`);
  }
}

function assertPattern(label: string, value: unknown, pattern: RegExp): asserts value is string {
  if (typeof value !== "string" || !pattern.test(value) || value.trim().toLowerCase() === "unknown") {
    throw new Error(`PageGraph ${label} does not match its closed public vocabulary.`);
  }
}

function containsControl(value: string): boolean {
  return /[\u0000-\u001f\u007f-\u009f]/.test(value);
}
