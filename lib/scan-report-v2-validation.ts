/**
 * Structural runtime validator for ScanReport v2 revision 1
 * (docs/scan-report-v2-rfc.md). Hand-written against lib/scan-report-v2.ts,
 * which is the source of truth; the generated JSON Schema and this validator
 * are held equivalent by the differential fixture harness (RFC 10.3).
 *
 * DEEP and DEFAULT-DENY: every object in the public wire shape accepts KNOWN
 * KEYS ONLY, and every nested evidence record is validated field by field.
 * That is what makes the ephemeral block (and any smuggled field, e.g. a
 * screenshot hidden inside a request record) structurally unpersistable.
 *
 * Structural only: cross-field consistency (quality vs facts, comparability vs
 * the evaluator, diff derivability) lives in lib/scan-report-v2-evaluators.ts
 * and is enforced by the reader on top of this module.
 */
import { isRecord } from "./guards";
import { isFingerprintDetectionSummary } from "./fingerprint-detection-guard";
import {
  CONSENT_OBSERVED_STATES,
  DETECTOR_IDS,
  EVIDENCE_FAMILIES,
  INTERVENTION_AXES,
  METRIC_FAMILIES,
  PHASE_KINDS,
  SCAN_REPORT_V2_SCHEMA_REVISION,
  SCAN_REPORT_V2_SCHEMA_VERSION,
  type ArmVerification,
  type Comparability,
  type ComparisonDiffV2,
  type ConditionVector,
  type ConsentEvidence,
  type DetectorLedger,
  type Experiment,
  type Fingerprints,
  type PhaseSpan,
  type PrivacyStats,
  type Provenance,
  type PublicComparisonReportV2,
  type PublicScanReportV2,
  type PublicSingleReportV2,
  type Quality,
  type QualityFacts,
  type RunEvidence,
  type RunSummary,
  type ScanRunV2,
  type SubjectIdentity,
  type Toolchain
} from "./scan-report-v2";

// --------------------------------------------------------------------------
// Key sets (default-deny at every level)
// --------------------------------------------------------------------------

const REPORT_ROOT_KEYS_SINGLE = new Set(["schemaVersion", "schemaRevision", "reportType", "run", "share"]);
const REPORT_ROOT_KEYS_COMPARISON = new Set([
  "schemaVersion",
  "schemaRevision",
  "reportType",
  "baseline",
  "variant",
  "experiment",
  "comparability",
  "diff",
  "share"
]);
const RUN_KEYS = new Set([
  "runId",
  "startedAt",
  "subject",
  "conditions",
  "provenance",
  "toolchain",
  "fingerprints",
  "qualityFacts",
  "quality",
  "privacy",
  "detectors",
  "phases",
  "summary",
  "evidence",
  "warnings"
]);
const SUBJECT_KEYS = new Set(["requested", "observed"]);
const SUBJECT_KEY_KEYS = new Set(["origin", "registrableDomain", "routeShape"]);
const CONDITION_KEYS = new Set([
  "gpc",
  "shields",
  "consent",
  "device",
  "probes",
  "locale",
  "language",
  "timezone",
  "egress",
  "browser",
  "headless",
  "automation"
]);
const DEVICE_KEYS = new Set(["kind", "viewport"]);
const VIEWPORT_KEYS = new Set(["width", "height", "isMobile"]);
const PROBES_KEYS = new Set(["keystroke", "policyVisit"]);
const EGRESS_KEYS = new Set(["label", "region"]);
const BROWSER_KEYS = new Set(["name", "version"]);
const PROVENANCE_KEYS = new Set([
  "observer",
  "acquisition",
  "buildCommit",
  "methodologyVersion",
  "detectorRegistry",
  "sourceArtifactDigest"
]);
const DETECTOR_REGISTRY_KEYS = new Set(["version", "digest"]);
const TOOLCHAIN_KEYS = new Set(["trackerCatalog", "adblock", "normalizationVersion"]);
const TRACKER_CATALOG_KEYS = new Set(["source", "version", "entries", "digest"]);
const ADBLOCK_KEYS = new Set(["source", "lists", "fetchedAt", "manifestDigest", "engineVersion"]);
const FINGERPRINTS_KEYS = new Set(["execution", "measurementEnvironment", "condition"]);
const QUALITY_FACTS_KEYS = new Set(["status", "botWallTitleMatched", "navigationSettled", "budgetsExhausted", "captureLoss"]);
const CAPTURE_LOSS_KEYS = new Set(["family", "phaseId", "kind", "count", "detail"]);
const QUALITY_KEYS = new Set(["evaluatorVersion", "run", "byFamily"]);
const OUTCOME_KEYS = new Set(["outcome", "reasons"]);
const PRIVACY_KEYS = new Set(["redactionVersion", "redaction"]);
const REDACTION_KEYS = new Set([
  "pathSegmentsGeneralized",
  "queryKeysRedacted",
  "storageKeysRedacted",
  "cookieNamesRedacted",
  "matrixParamsStripped",
  "subdomainLabelsGeneralized",
  "malformedUrlsDropped"
]);
const DETECTOR_ENTRY_KEYS = new Set(["version", "status", "reason", "phaseId"]);
const PHASE_SPAN_KEYS = new Set(["phaseId", "kind", "startedAtMs", "endedAtMs"]);
const SUMMARY_KEYS = new Set(["pageTitle", "status", "durationMs", "counts", "countsByPhase"]);
const COUNTS_KEYS = new Set([
  "totalRequests",
  "thirdPartyRequests",
  "knownTrackerRequests",
  "thirdPartyDomains",
  "cookies",
  "thirdPartyCookies",
  "storageEntries",
  "fingerprintEvents",
  "shieldsBlockedRequests"
]);
const COUNTS_BY_PHASE_KEYS = new Set(["phaseId", "totalRequests", "thirdPartyRequests", "knownTrackerRequests"]);
const EVIDENCE_KEYS = new Set([
  "requests",
  "cookieMutations",
  "cookiesFinal",
  "storageMutations",
  "storageFinal",
  "fingerprintEvents",
  "fingerprintDetections",
  "cnameCloaks",
  "pixelEvents",
  "privacyPolicy",
  "consent"
]);
const REQUEST_KEYS = new Set([
  "id",
  "url",
  "domain",
  "method",
  "resourceType",
  "status",
  "thirdParty",
  "tracker",
  "blockedByShields",
  "provenance",
  "startedAtMs",
  "phaseId"
]);
const TRACKER_KEYS = new Set(["domain", "entity", "category", "confidence", "prevalence", "fingerprinting", "cookiePrevalence"]);
const REQUEST_PROVENANCE_KEYS = new Set([
  "graphRecordId",
  "initiatorId",
  "initiatorType",
  "initiatorUrl",
  "initiatorDomain",
  "scriptId",
  "scriptUrl",
  "scriptDomain",
  "injectedById",
  "injectedByUrl",
  "injectedByDomain"
]);
const COOKIE_KEYS = new Set(["name", "domain", "path", "sameSite", "secure", "httpOnly", "session", "thirdParty"]);
const STORAGE_KEYS = new Set(["area", "key", "valueBytes"]);
const FINGERPRINT_EVENT_KEYS = new Set(["api", "count", "phaseId"]);
const DETECTION_KEYS = new Set(["kind", "heuristic", "count", "evidence", "phaseId"]);
const DETECTION_EVIDENCE_KEYS: Record<string, Set<string>> = {
  "canvas-fingerprinting": new Set(["readApis", "maxCanvasWidth", "maxCanvasHeight", "maxDistinctTextCharacters", "maxTextWriteCalls"]),
  "canvas-font-fingerprinting": new Set(["measureTextCalls", "maxDistinctFonts", "maxDistinctTextSamples", "maxTextLength"]),
  "webgl-fingerprinting": new Set(["readApis", "parameters", "getParameterCalls", "readPixelsCalls"]),
  "audio-fingerprinting": new Set(["apis", "offlineRenderCalls", "oscillatorCalls", "compressorCalls", "analyserCalls"]),
  "webrtc-fingerprinting": new Set(["constructorCalls", "createDataChannelCalls", "createOfferCalls", "setLocalDescriptionCalls"]),
  "session-recording": new Set(["eventTypes", "listenerTargets", "thirdPartyOrigins", "totalListenerCalls"]),
  "input-monitoring": new Set(["eventTypes", "listenerTargets", "thirdPartyOrigins", "totalListenerCalls"]),
  "keystroke-exfiltration": new Set(["recipients", "encodings", "fieldsTyped", "fieldTypes"])
};
const CNAME_CLOAK_KEYS = new Set(["host", "cname", "tracker"]);
const PIXEL_EVENT_KEYS = new Set(["platform", "product", "events", "advancedMatching", "requests", "phaseId"]);
const PRIVACY_POLICY_KEYS = new Set(["url", "claims", "mentionedEntities", "unmentionedEntities", "policyTextLength"]);
const POLICY_CLAIM_KEYS = new Set(["kind", "quote"]);
const CONSENT_KEYS = new Set([
  "mode",
  "interactionAttempted",
  "controlActivated",
  "verificationObservations",
  "choiceState",
  "reverifiedAfterReload",
  "verificationFailureReason",
  "cmp",
  "selector",
  "matchedText",
  "frameUrl"
]);
const CONSENT_OBSERVATION_KEYS = new Set(["phaseId", "method", "observed", "consistentWithChoice"]);
const COOKIE_MUTATION_KEYS = new Set(["phaseId", "op", "cookie"]);
const STORAGE_MUTATION_KEYS = new Set(["phaseId", "op", "entry"]);
const INTERVENTION_EXPERIMENT_KEYS = new Set(["kind", "axis", "pairId", "order", "verification", "evidence"]);
const TEMPORAL_EXPERIMENT_KEYS = new Set(["kind", "pairId"]);
const DESCRIPTIVE_EXPERIMENT_KEYS = new Set(["kind", "pairId", "sourceOrder"]);
const VERIFICATION_KEYS = new Set(["baseline", "variant"]);
const ARM_KEYS = new Set(["axis", "expected", "observed", "method", "outcome", "phaseId"]);
const EXPERIMENT_EVIDENCE_KEYS = new Set(["pairs", "counterbalanced", "strength"]);
const COMPARABILITY_KEYS = new Set([
  "evaluatorVersion",
  "metricRegistryVersion",
  "pairValidity",
  "perMetric",
  "interventionVerified"
]);
const ELIGIBILITY_KEYS = new Set(["eligible", "reasons"]);
const DIFF_KEYS = new Set(["families"]);
const DIFF_RAW_KEYS = new Set(["eligible", "metrics"]);
const DIFF_RAW_METRIC_KEYS = new Set([
  "totalRequests",
  "thirdPartyRequests",
  "thirdPartyDomains",
  "cookies",
  "thirdPartyCookies",
  "storageEntries"
]);
const DIFF_TRACKER_KEYS = new Set(["eligible", "metrics", "addedTrackerDomains", "removedTrackerDomains"]);
const DIFF_TRACKER_METRIC_KEYS = new Set(["knownTrackerRequests"]);
const DIFF_SHIELDS_KEYS = new Set(["eligible", "metrics"]);
const DIFF_SHIELDS_METRIC_KEYS = new Set(["shieldsBlockedRequests"]);
const DIFF_CONSENT_KEYS = new Set(["eligible"]);
const DIFF_DETECTOR_KEYS = new Set(["eligible", "addedDetectionKinds", "removedDetectionKinds"]);
const METRIC_DELTA_KEYS = new Set(["baseline", "variant", "delta"]);
const SHARE_KEYS = new Set(["id", "path", "jsonPath"]);

// --------------------------------------------------------------------------
// Closed vocabularies
// --------------------------------------------------------------------------

const SHIELDS_CONDITIONS = new Set(["off", "classification", "block-simulation"]);
const CONSENT_CONDITIONS = new Set(["observe", "accept-all", "reject-all"]);
const DEVICE_KINDS = new Set(["desktop", "mobile"]);
const OBSERVERS = new Set(["node-playwright", "browser-run-worker", "pagegraph-import"]);
const ACQUISITIONS = new Set(["public-api", "operator-cli", "ci-workflow", "upload"]);
const DETECTOR_STATUSES = new Set(["complete", "partial", "skipped", "unsupported", "failed"]);
const RUN_OUTCOMES = new Set(["complete", "failed"]);
const FAMILY_OUTCOMES = new Set(["complete", "censored"]);
const CAPTURE_LOSS_KINDS = new Set(["dropped", "clipped", "truncated", "timeout", "cap"]);
const MUTATION_OPS = new Set(["added", "changed", "removed"]);
const ARM_OUTCOMES = new Set(["passed", "failed", "inconclusive"]);
const EVIDENCE_STRENGTHS = new Set(["observed-difference", "replicated-difference"]);
const SOURCE_ORDERS = new Set(["as-provided", "chronological", "unknown"]);
const CONSENT_CHOICE_STATES = new Set(["verified", "contradicted", "weak-signal", "unavailable", "failed"]);
const CONSENT_MODES = new Set(["accept-all", "reject-all"]);
const EXPERIMENT_KINDS = new Set(["intervention", "temporal", "descriptive"]);
const STORAGE_AREAS = new Set(["localStorage", "sessionStorage"]);
const TRACKER_CONFIDENCES = new Set(["curated", "shields-list"]);
const PIXEL_MATCH_FIELDS = new Set(["email", "phone", "name", "address", "date_of_birth", "gender", "external_id"]);
const POLICY_CLAIM_KINDS = new Set(["no-cookies", "no-third-party-cookies", "no-selling-or-sharing", "honors-gpc"]);
const AXIS_STATES = new Set([
  "gpc:on",
  "gpc:off",
  "shields:off",
  "shields:classification",
  "shields:block-simulation",
  "consent:observe",
  "consent:accept-all",
  "consent:reject-all"
]);
const CONSENT_OBSERVED = new Set<string>(CONSENT_OBSERVED_STATES);

/** Scanner-vocabulary code (RFC 9.4): reason/detail fields, never page text. */
const VOCAB_CODE_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const QUALITY_REASON_BASE = new Set(["http-error-status", "bot-wall-title", "navigation-timeout", "empty-load", "scan-slot-timeout"]);
const QUALITY_REASON_PREFIXES = ["capture-loss:", "budget-exhausted:"];
const COMPARABILITY_REASON_BASE = new Set(["subject-mismatch", "design-invalid"]);
const COMPARABILITY_REASON_PREFIXES = [
  "run-failed:",
  "unknown-dimension:",
  "dependency-digest-mismatch:",
  "dependency-version-mismatch:",
  "family-censored:",
  "arm-verification-failed:",
  "arm-verification-inconclusive:"
];
const REASON_QUALIFIER_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

function isParameterizedReason(value: string, base: Set<string>, prefixes: string[]): boolean {
  if (base.has(value)) return true;
  return prefixes.some((prefix) => {
    if (!value.startsWith(prefix)) return false;
    return REASON_QUALIFIER_PATTERN.test(value.slice(prefix.length));
  });
}

// --------------------------------------------------------------------------
// Primitives
// --------------------------------------------------------------------------

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isHttpStatus(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isVocabCode(value: unknown): value is string {
  return typeof value === "string" && VOCAB_CODE_PATTERN.test(value);
}

function only(value: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function record(value: unknown, allowed: Set<string>): value is Record<string, unknown> {
  return isRecord(value) && only(value, allowed);
}

// --------------------------------------------------------------------------
// Blocks
// --------------------------------------------------------------------------

function isSubjectKey(value: unknown): boolean {
  return (
    record(value, SUBJECT_KEY_KEYS) &&
    isNonEmptyString(value.origin) &&
    isNonEmptyString(value.registrableDomain) &&
    typeof value.routeShape === "string"
  );
}

function isSubjectIdentity(value: unknown): value is SubjectIdentity {
  return record(value, SUBJECT_KEYS) && isSubjectKey(value.requested) && isSubjectKey(value.observed);
}

function isConditionVector(value: unknown): value is ConditionVector {
  if (!record(value, CONDITION_KEYS)) return false;
  const device = value.device;
  const probes = value.probes;
  const egress = value.egress;
  const browser = value.browser;
  return (
    typeof value.gpc === "boolean" &&
    typeof value.shields === "string" &&
    SHIELDS_CONDITIONS.has(value.shields) &&
    typeof value.consent === "string" &&
    CONSENT_CONDITIONS.has(value.consent) &&
    record(device, DEVICE_KEYS) &&
    typeof device.kind === "string" &&
    DEVICE_KINDS.has(device.kind) &&
    record(device.viewport, VIEWPORT_KEYS) &&
    isCount((device.viewport as Record<string, unknown>).width) &&
    isCount((device.viewport as Record<string, unknown>).height) &&
    typeof (device.viewport as Record<string, unknown>).isMobile === "boolean" &&
    record(probes, PROBES_KEYS) &&
    typeof probes.keystroke === "boolean" &&
    typeof probes.policyVisit === "boolean" &&
    isNonEmptyString(value.locale) &&
    isNonEmptyString(value.language) &&
    isNonEmptyString(value.timezone) &&
    record(egress, EGRESS_KEYS) &&
    isNonEmptyString(egress.label) &&
    (egress.region === undefined || typeof egress.region === "string") &&
    record(browser, BROWSER_KEYS) &&
    isNonEmptyString(browser.name) &&
    isNonEmptyString(browser.version) &&
    typeof value.headless === "boolean" &&
    isNonEmptyString(value.automation)
  );
}

function isProvenance(value: unknown): value is Provenance {
  return (
    record(value, PROVENANCE_KEYS) &&
    typeof value.observer === "string" &&
    OBSERVERS.has(value.observer) &&
    typeof value.acquisition === "string" &&
    ACQUISITIONS.has(value.acquisition) &&
    isNonEmptyString(value.buildCommit) &&
    isNonEmptyString(value.methodologyVersion) &&
    record(value.detectorRegistry, DETECTOR_REGISTRY_KEYS) &&
    isNonEmptyString((value.detectorRegistry as Record<string, unknown>).version) &&
    isNonEmptyString((value.detectorRegistry as Record<string, unknown>).digest) &&
    (value.sourceArtifactDigest === undefined || isNonEmptyString(value.sourceArtifactDigest))
  );
}

function isToolchain(value: unknown): value is Toolchain {
  if (!record(value, TOOLCHAIN_KEYS)) return false;
  const catalog = value.trackerCatalog;
  const adblock = value.adblock;
  const adblockOk =
    adblock === null ||
    (record(adblock, ADBLOCK_KEYS) &&
      isNonEmptyString(adblock.source) &&
      isCount(adblock.lists) &&
      isNonEmptyString(adblock.fetchedAt) &&
      isNonEmptyString(adblock.manifestDigest) &&
      isNonEmptyString(adblock.engineVersion));
  return (
    record(catalog, TRACKER_CATALOG_KEYS) &&
    isNonEmptyString(catalog.source) &&
    isNonEmptyString(catalog.version) &&
    isCount(catalog.entries) &&
    isNonEmptyString(catalog.digest) &&
    adblockOk &&
    isNonEmptyString(value.normalizationVersion)
  );
}

function isFingerprints(value: unknown): value is Fingerprints {
  return (
    record(value, FINGERPRINTS_KEYS) &&
    isNonEmptyString(value.execution) &&
    isNonEmptyString(value.measurementEnvironment) &&
    isNonEmptyString(value.condition)
  );
}

function isPhaseId(value: unknown, phaseCount: number): value is number {
  return isCount(value) && value < phaseCount;
}

function isCaptureLossEntry(value: unknown, phaseCount: number): boolean {
  return (
    record(value, CAPTURE_LOSS_KEYS) &&
    typeof value.family === "string" &&
    (EVIDENCE_FAMILIES as readonly string[]).includes(value.family) &&
    (value.phaseId === null || isPhaseId(value.phaseId, phaseCount)) &&
    typeof value.kind === "string" &&
    CAPTURE_LOSS_KINDS.has(value.kind) &&
    isCount(value.count) &&
    (value.detail === undefined || isVocabCode(value.detail))
  );
}

function isQualityFacts(value: unknown, phaseCount: number): value is QualityFacts {
  return (
    record(value, QUALITY_FACTS_KEYS) &&
    (value.status === null || isHttpStatus(value.status)) &&
    typeof value.botWallTitleMatched === "boolean" &&
    typeof value.navigationSettled === "boolean" &&
    Array.isArray(value.budgetsExhausted) &&
    value.budgetsExhausted.every(isVocabCode) &&
    Array.isArray(value.captureLoss) &&
    value.captureLoss.every((entry) => isCaptureLossEntry(entry, phaseCount))
  );
}

function isQualityReasons(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (reason) => typeof reason === "string" && isParameterizedReason(reason, QUALITY_REASON_BASE, QUALITY_REASON_PREFIXES)
    )
  );
}

function isQuality(value: unknown): value is Quality {
  if (!record(value, QUALITY_KEYS) || !isNonEmptyString(value.evaluatorVersion)) return false;
  const run = value.run;
  if (
    !record(run, OUTCOME_KEYS) ||
    typeof run.outcome !== "string" ||
    !RUN_OUTCOMES.has(run.outcome) ||
    !isQualityReasons(run.reasons)
  ) {
    return false;
  }
  const byFamily = value.byFamily;
  if (!isRecord(byFamily) || !only(byFamily, new Set(EVIDENCE_FAMILIES))) return false;
  return EVIDENCE_FAMILIES.every((family) => {
    const entry = byFamily[family];
    return (
      record(entry, OUTCOME_KEYS) &&
      typeof entry.outcome === "string" &&
      FAMILY_OUTCOMES.has(entry.outcome) &&
      isQualityReasons(entry.reasons)
    );
  });
}

function isPrivacyStats(value: unknown): value is PrivacyStats {
  if (!record(value, PRIVACY_KEYS) || !isCount(value.redactionVersion)) return false;
  const redaction = value.redaction;
  return (
    record(redaction, REDACTION_KEYS) &&
    isCount(redaction.pathSegmentsGeneralized) &&
    isCount(redaction.queryKeysRedacted) &&
    isCount(redaction.storageKeysRedacted) &&
    isCount(redaction.cookieNamesRedacted) &&
    isCount(redaction.matrixParamsStripped) &&
    isCount(redaction.subdomainLabelsGeneralized) &&
    isCount(redaction.malformedUrlsDropped)
  );
}

function isDetectorLedger(value: unknown, phaseCount: number): value is DetectorLedger {
  if (!isRecord(value) || !only(value, new Set(DETECTOR_IDS))) return false;
  return DETECTOR_IDS.every((id) => {
    const entry = value[id];
    return (
      record(entry, DETECTOR_ENTRY_KEYS) &&
      isNonEmptyString(entry.version) &&
      typeof entry.status === "string" &&
      DETECTOR_STATUSES.has(entry.status) &&
      (entry.reason === undefined || isVocabCode(entry.reason)) &&
      (entry.phaseId === undefined || isPhaseId(entry.phaseId, phaseCount))
    );
  });
}

function isPhaseSpans(value: unknown): value is PhaseSpan[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  return value.every(
    (span, index) =>
      record(span, PHASE_SPAN_KEYS) &&
      span.phaseId === index &&
      typeof span.kind === "string" &&
      (PHASE_KINDS as readonly string[]).includes(span.kind) &&
      isCount(span.startedAtMs) &&
      isCount(span.endedAtMs)
  );
}

function isRunSummary(value: unknown, phaseCount: number): value is RunSummary {
  if (!record(value, SUMMARY_KEYS)) return false;
  const counts = value.counts;
  const countsOk =
    record(counts, COUNTS_KEYS) &&
    isCount(counts.totalRequests) &&
    isCount(counts.thirdPartyRequests) &&
    isCount(counts.knownTrackerRequests) &&
    isCount(counts.thirdPartyDomains) &&
    isCount(counts.cookies) &&
    isCount(counts.thirdPartyCookies) &&
    isCount(counts.storageEntries) &&
    isCount(counts.fingerprintEvents) &&
    (counts.shieldsBlockedRequests === undefined || isCount(counts.shieldsBlockedRequests));
  return (
    typeof value.pageTitle === "string" &&
    (value.status === null || isHttpStatus(value.status)) &&
    isCount(value.durationMs) &&
    countsOk &&
    Array.isArray(value.countsByPhase) &&
    value.countsByPhase.every(
      (entry) =>
        record(entry, COUNTS_BY_PHASE_KEYS) &&
        isPhaseId(entry.phaseId, phaseCount) &&
        isCount(entry.totalRequests) &&
        isCount(entry.thirdPartyRequests) &&
        isCount(entry.knownTrackerRequests)
    )
  );
}

function isTrackerMatch(value: unknown): boolean {
  return (
    record(value, TRACKER_KEYS) &&
    isNonEmptyString(value.domain) &&
    isNonEmptyString(value.entity) &&
    isNonEmptyString(value.category) &&
    typeof value.confidence === "string" &&
    TRACKER_CONFIDENCES.has(value.confidence) &&
    (value.prevalence === undefined || isFiniteNumber(value.prevalence)) &&
    (value.fingerprinting === undefined || isFiniteNumber(value.fingerprinting)) &&
    (value.cookiePrevalence === undefined || isFiniteNumber(value.cookiePrevalence))
  );
}

function isRequestProvenance(value: unknown): boolean {
  return (
    record(value, REQUEST_PROVENANCE_KEYS) &&
    Object.values(value).every((entry) => entry === undefined || typeof entry === "string")
  );
}

function isNetworkRequest(value: unknown, phaseCount: number): boolean {
  return (
    record(value, REQUEST_KEYS) &&
    isPositiveInteger(value.id) &&
    isNonEmptyString(value.url) &&
    isNonEmptyString(value.domain) &&
    isNonEmptyString(value.method) &&
    isNonEmptyString(value.resourceType) &&
    (value.status === null || isHttpStatus(value.status)) &&
    typeof value.thirdParty === "boolean" &&
    (value.tracker === null || isTrackerMatch(value.tracker)) &&
    (value.blockedByShields === undefined || typeof value.blockedByShields === "boolean") &&
    (value.provenance === undefined || isRequestProvenance(value.provenance)) &&
    isCount(value.startedAtMs) &&
    isPhaseId(value.phaseId, phaseCount)
  );
}

function isCookieRecord(value: unknown): boolean {
  return (
    record(value, COOKIE_KEYS) &&
    typeof value.name === "string" &&
    typeof value.domain === "string" &&
    typeof value.path === "string" &&
    typeof value.sameSite === "string" &&
    typeof value.secure === "boolean" &&
    typeof value.httpOnly === "boolean" &&
    typeof value.session === "boolean" &&
    typeof value.thirdParty === "boolean" &&
    value.name.length > 0
  );
}

function isStorageRecord(value: unknown): boolean {
  return (
    record(value, STORAGE_KEYS) &&
    typeof value.area === "string" &&
    STORAGE_AREAS.has(value.area) &&
    isNonEmptyString(value.key) &&
    isCount(value.valueBytes)
  );
}

function isFingerprintEvent(value: unknown, phaseCount: number): boolean {
  return record(value, FINGERPRINT_EVENT_KEYS) && isNonEmptyString(value.api) && isCount(value.count) && isPhaseId(value.phaseId, phaseCount);
}

function isDetection(value: unknown, phaseCount: number): boolean {
  if (!record(value, DETECTION_KEYS) || !isPhaseId(value.phaseId, phaseCount)) return false;
  if (!isFingerprintDetectionSummary(value)) return false;
  const evidenceKeys = DETECTION_EVIDENCE_KEYS[value.kind as string];
  return evidenceKeys !== undefined && isRecord(value.evidence) && only(value.evidence, evidenceKeys);
}

function isCnameCloak(value: unknown): boolean {
  return record(value, CNAME_CLOAK_KEYS) && isNonEmptyString(value.host) && isNonEmptyString(value.cname) && isTrackerMatch(value.tracker);
}

function isPixelEvent(value: unknown, phaseCount: number): boolean {
  return (
    record(value, PIXEL_EVENT_KEYS) &&
    isNonEmptyString(value.platform) &&
    isNonEmptyString(value.product) &&
    isStringArray(value.events) &&
    Array.isArray(value.advancedMatching) &&
    value.advancedMatching.every((field) => typeof field === "string" && PIXEL_MATCH_FIELDS.has(field)) &&
    isCount(value.requests) &&
    isPhaseId(value.phaseId, phaseCount)
  );
}

function isPrivacyPolicy(value: unknown): boolean {
  return (
    record(value, PRIVACY_POLICY_KEYS) &&
    isNonEmptyString(value.url) &&
    Array.isArray(value.claims) &&
    value.claims.every(
      (claim) =>
        record(claim, POLICY_CLAIM_KEYS) &&
        typeof claim.kind === "string" &&
        POLICY_CLAIM_KINDS.has(claim.kind) &&
        isNonEmptyString(claim.quote)
    ) &&
    isStringArray(value.mentionedEntities) &&
    isStringArray(value.unmentionedEntities) &&
    isCount(value.policyTextLength)
  );
}

function isConsentObservation(value: unknown, phaseCount: number): boolean {
  return (
    record(value, CONSENT_OBSERVATION_KEYS) &&
    isPhaseId(value.phaseId, phaseCount) &&
    isNonEmptyString(value.method) &&
    (value.observed === null || (typeof value.observed === "string" && CONSENT_OBSERVED.has(value.observed))) &&
    (value.consistentWithChoice === null || typeof value.consistentWithChoice === "boolean")
  );
}

function isConsentEvidence(value: unknown, phaseCount: number): value is ConsentEvidence {
  return (
    record(value, CONSENT_KEYS) &&
    typeof value.mode === "string" &&
    CONSENT_MODES.has(value.mode) &&
    typeof value.interactionAttempted === "boolean" &&
    typeof value.controlActivated === "boolean" &&
    Array.isArray(value.verificationObservations) &&
    value.verificationObservations.every((entry) => isConsentObservation(entry, phaseCount)) &&
    typeof value.choiceState === "string" &&
    CONSENT_CHOICE_STATES.has(value.choiceState) &&
    typeof value.reverifiedAfterReload === "boolean" &&
    (value.verificationFailureReason === undefined || isVocabCode(value.verificationFailureReason)) &&
    (value.cmp === undefined || typeof value.cmp === "string") &&
    (value.selector === undefined || typeof value.selector === "string") &&
    (value.matchedText === undefined || typeof value.matchedText === "string") &&
    (value.frameUrl === undefined || typeof value.frameUrl === "string")
  );
}

function isCookieMutation(value: unknown, phaseCount: number): boolean {
  return (
    record(value, COOKIE_MUTATION_KEYS) &&
    isPhaseId(value.phaseId, phaseCount) &&
    typeof value.op === "string" &&
    MUTATION_OPS.has(value.op) &&
    isCookieRecord(value.cookie)
  );
}

function isStorageMutation(value: unknown, phaseCount: number): boolean {
  return (
    record(value, STORAGE_MUTATION_KEYS) &&
    isPhaseId(value.phaseId, phaseCount) &&
    typeof value.op === "string" &&
    MUTATION_OPS.has(value.op) &&
    isStorageRecord(value.entry)
  );
}

function isRunEvidence(value: unknown, phaseCount: number): value is RunEvidence {
  if (!record(value, EVIDENCE_KEYS)) return false;
  return (
    Array.isArray(value.requests) &&
    value.requests.every((entry) => isNetworkRequest(entry, phaseCount)) &&
    Array.isArray(value.cookieMutations) &&
    value.cookieMutations.every((entry) => isCookieMutation(entry, phaseCount)) &&
    Array.isArray(value.cookiesFinal) &&
    value.cookiesFinal.every(isCookieRecord) &&
    Array.isArray(value.storageMutations) &&
    value.storageMutations.every((entry) => isStorageMutation(entry, phaseCount)) &&
    Array.isArray(value.storageFinal) &&
    value.storageFinal.every(isStorageRecord) &&
    Array.isArray(value.fingerprintEvents) &&
    value.fingerprintEvents.every((entry) => isFingerprintEvent(entry, phaseCount)) &&
    Array.isArray(value.fingerprintDetections) &&
    value.fingerprintDetections.every((entry) => isDetection(entry, phaseCount)) &&
    Array.isArray(value.cnameCloaks) &&
    value.cnameCloaks.every(isCnameCloak) &&
    Array.isArray(value.pixelEvents) &&
    value.pixelEvents.every((entry) => isPixelEvent(entry, phaseCount)) &&
    (value.privacyPolicy === undefined || isPrivacyPolicy(value.privacyPolicy)) &&
    (value.consent === undefined || isConsentEvidence(value.consent, phaseCount))
  );
}

export function isScanRunV2(value: unknown): value is ScanRunV2 {
  if (!record(value, RUN_KEYS)) return false;
  if (!isPhaseSpans(value.phases)) return false;
  const phaseCount = value.phases.length;
  return (
    isNonEmptyString(value.runId) &&
    isNonEmptyString(value.startedAt) &&
    isSubjectIdentity(value.subject) &&
    isConditionVector(value.conditions) &&
    isProvenance(value.provenance) &&
    isToolchain(value.toolchain) &&
    isFingerprints(value.fingerprints) &&
    isQualityFacts(value.qualityFacts, phaseCount) &&
    isQuality(value.quality) &&
    isPrivacyStats(value.privacy) &&
    isDetectorLedger(value.detectors, phaseCount) &&
    isRunSummary(value.summary, phaseCount) &&
    isRunEvidence(value.evidence, phaseCount) &&
    isStringArray(value.warnings)
  );
}

function isArmVerification(value: unknown, phaseCount: number): value is ArmVerification {
  return (
    record(value, ARM_KEYS) &&
    typeof value.axis === "string" &&
    (INTERVENTION_AXES as readonly string[]).includes(value.axis) &&
    typeof value.expected === "string" &&
    AXIS_STATES.has(value.expected) &&
    (value.observed === null || (typeof value.observed === "string" && AXIS_STATES.has(value.observed))) &&
    isNonEmptyString(value.method) &&
    typeof value.outcome === "string" &&
    ARM_OUTCOMES.has(value.outcome) &&
    isPhaseId(value.phaseId, phaseCount)
  );
}

function isExperiment(value: unknown, baselinePhaseCount: number, variantPhaseCount: number): value is Experiment {
  if (!isRecord(value) || typeof value.kind !== "string" || !EXPERIMENT_KINDS.has(value.kind)) return false;
  if (!isNonEmptyString(value.pairId)) return false;
  if (value.kind === "intervention") {
    if (!only(value, INTERVENTION_EXPERIMENT_KEYS)) return false;
    const verification = value.verification;
    const evidence = value.evidence;
    return (
      typeof value.axis === "string" &&
      (INTERVENTION_AXES as readonly string[]).includes(value.axis) &&
      (value.order === "AB" || value.order === "BA") &&
      record(verification, VERIFICATION_KEYS) &&
      isArmVerification(verification.baseline, baselinePhaseCount) &&
      isArmVerification(verification.variant, variantPhaseCount) &&
      record(evidence, EXPERIMENT_EVIDENCE_KEYS) &&
      isCount(evidence.pairs) &&
      evidence.pairs >= 1 &&
      typeof evidence.counterbalanced === "boolean" &&
      typeof evidence.strength === "string" &&
      EVIDENCE_STRENGTHS.has(evidence.strength)
    );
  }
  if (value.kind === "temporal") return only(value, TEMPORAL_EXPERIMENT_KEYS);
  return only(value, DESCRIPTIVE_EXPERIMENT_KEYS) && typeof value.sourceOrder === "string" && SOURCE_ORDERS.has(value.sourceOrder);
}

function isComparabilityReasons(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (reason) =>
        typeof reason === "string" && isParameterizedReason(reason, COMPARABILITY_REASON_BASE, COMPARABILITY_REASON_PREFIXES)
    )
  );
}

function isEligibility(value: unknown): boolean {
  return record(value, ELIGIBILITY_KEYS) && typeof value.eligible === "boolean" && isComparabilityReasons(value.reasons);
}

function isComparability(value: unknown, experimentKind: string): value is Comparability {
  if (
    !record(value, COMPARABILITY_KEYS) ||
    !isNonEmptyString(value.evaluatorVersion) ||
    !isNonEmptyString(value.metricRegistryVersion) ||
    !isEligibility(value.pairValidity)
  ) {
    return false;
  }
  const perMetric = value.perMetric;
  if (!isRecord(perMetric) || !only(perMetric, new Set(METRIC_FAMILIES))) return false;
  if (!METRIC_FAMILIES.every((family) => isEligibility(perMetric[family]))) return false;
  if (experimentKind === "intervention") return typeof value.interventionVerified === "boolean";
  return value.interventionVerified === undefined;
}

function isMetricDelta(value: unknown): boolean {
  return record(value, METRIC_DELTA_KEYS) && isCount(value.baseline) && isCount(value.variant) && isInteger(value.delta);
}

function isComparisonDiff(value: unknown): value is ComparisonDiffV2 {
  if (!record(value, DIFF_KEYS)) return false;
  const families = value.families;
  if (!isRecord(families) || !only(families, new Set(METRIC_FAMILIES))) return false;

  const raw = families["raw-counts"];
  const rawOk =
    record(raw, DIFF_RAW_KEYS) &&
    typeof raw.eligible === "boolean" &&
    record(raw.metrics, DIFF_RAW_METRIC_KEYS) &&
    [...DIFF_RAW_METRIC_KEYS].every((key) => isMetricDelta((raw.metrics as Record<string, unknown>)[key]));

  const tracker = families["tracker-classification"];
  const trackerOk =
    record(tracker, DIFF_TRACKER_KEYS) &&
    typeof tracker.eligible === "boolean" &&
    record(tracker.metrics, DIFF_TRACKER_METRIC_KEYS) &&
    isMetricDelta((tracker.metrics as Record<string, unknown>).knownTrackerRequests) &&
    isStringArray(tracker.addedTrackerDomains) &&
    isStringArray(tracker.removedTrackerDomains);

  const shields = families["shields-simulation"];
  const shieldsOk =
    record(shields, DIFF_SHIELDS_KEYS) &&
    typeof shields.eligible === "boolean" &&
    (shields.metrics === null ||
      (record(shields.metrics, DIFF_SHIELDS_METRIC_KEYS) &&
        isMetricDelta((shields.metrics as Record<string, unknown>).shieldsBlockedRequests)));

  const consent = families["consent-verification"];
  const consentOk = record(consent, DIFF_CONSENT_KEYS) && typeof consent.eligible === "boolean";

  const detector = families["detector-findings"];
  const detectorOk =
    record(detector, DIFF_DETECTOR_KEYS) &&
    typeof detector.eligible === "boolean" &&
    isStringArray(detector.addedDetectionKinds) &&
    isStringArray(detector.removedDetectionKinds);

  return rawOk && trackerOk && shieldsOk && consentOk && detectorOk;
}

function isReportShareLike(value: unknown): boolean {
  return record(value, SHARE_KEYS) && isNonEmptyString(value.id) && isNonEmptyString(value.path) && isNonEmptyString(value.jsonPath);
}

export function isPublicSingleReportV2(value: unknown): value is PublicSingleReportV2 {
  return (
    isRecord(value) &&
    only(value, REPORT_ROOT_KEYS_SINGLE) &&
    value.schemaVersion === SCAN_REPORT_V2_SCHEMA_VERSION &&
    value.schemaRevision === SCAN_REPORT_V2_SCHEMA_REVISION &&
    value.reportType === "single" &&
    isScanRunV2(value.run) &&
    (value.share === undefined || isReportShareLike(value.share))
  );
}

export function isPublicComparisonReportV2(value: unknown): value is PublicComparisonReportV2 {
  if (
    !isRecord(value) ||
    !only(value, REPORT_ROOT_KEYS_COMPARISON) ||
    value.schemaVersion !== SCAN_REPORT_V2_SCHEMA_VERSION ||
    value.schemaRevision !== SCAN_REPORT_V2_SCHEMA_REVISION ||
    value.reportType !== "comparison" ||
    !isScanRunV2(value.baseline) ||
    !isScanRunV2(value.variant)
  ) {
    return false;
  }
  const baselinePhases = value.baseline.phases.length;
  const variantPhases = value.variant.phases.length;
  if (!isExperiment(value.experiment, baselinePhases, variantPhases)) return false;
  // Temporal chronology is a validity rule of the wire type itself (RFC 4.1).
  if (value.experiment.kind === "temporal" && !(value.baseline.startedAt < value.variant.startedAt)) return false;
  return (
    isComparability(value.comparability, value.experiment.kind) &&
    isComparisonDiff(value.diff) &&
    (value.share === undefined || isReportShareLike(value.share))
  );
}

export function isPublicScanReportV2(value: unknown): value is PublicScanReportV2 {
  if (!isRecord(value)) return false;
  if (value.reportType === "comparison") return isPublicComparisonReportV2(value);
  return isPublicSingleReportV2(value);
}
