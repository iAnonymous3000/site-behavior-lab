/**
 * Runtime validator for ScanReport v2 revision 1 (docs/scan-report-v2-rfc.md).
 * Hand-written against the types in lib/scan-report-v2.ts, which are the source
 * of truth; the generated JSON Schema and this validator are held equivalent by
 * the differential fixture harness (RFC 10.3).
 *
 * Strictness: the report root and the run object accept KNOWN KEYS ONLY. That
 * is what makes the ephemeral block structurally unpersistable: an
 * EphemeralScanReport fails public validation because of its extra `ephemeral`
 * key. Nested records tolerate additive unknown keys (they are covered by the
 * schemaRevision discipline instead).
 */
import { isRecord } from "./guards";
import {
  DETECTOR_IDS,
  EVIDENCE_FAMILIES,
  INTERVENTION_AXES,
  METRIC_FAMILIES,
  PHASE_KINDS,
  SCAN_REPORT_V2_SCHEMA_REVISION,
  SCAN_REPORT_V2_SCHEMA_VERSION,
  type ArmVerification,
  type Comparability,
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

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isCount(value: unknown): value is number {
  return isFiniteNumber(value) && Number.isInteger(value) && value >= 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function isSubjectKey(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonEmptyString(value.origin) &&
    isNonEmptyString(value.registrableDomain) &&
    typeof value.routeShape === "string"
  );
}

function isSubjectIdentity(value: unknown): value is SubjectIdentity {
  return isRecord(value) && isSubjectKey(value.requested) && isSubjectKey(value.observed);
}

function isConditionVector(value: unknown): value is ConditionVector {
  if (!isRecord(value)) return false;
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
    isRecord(device) &&
    typeof device.kind === "string" &&
    DEVICE_KINDS.has(device.kind) &&
    isRecord(device.viewport) &&
    isCount(device.viewport.width) &&
    isCount(device.viewport.height) &&
    typeof device.viewport.isMobile === "boolean" &&
    isRecord(probes) &&
    typeof probes.keystroke === "boolean" &&
    typeof probes.policyVisit === "boolean" &&
    isNonEmptyString(value.locale) &&
    isNonEmptyString(value.language) &&
    isNonEmptyString(value.timezone) &&
    isRecord(egress) &&
    isNonEmptyString(egress.label) &&
    (egress.region === undefined || typeof egress.region === "string") &&
    isRecord(browser) &&
    isNonEmptyString(browser.name) &&
    isNonEmptyString(browser.version) &&
    typeof value.headless === "boolean" &&
    isNonEmptyString(value.automation)
  );
}

function isProvenance(value: unknown): value is Provenance {
  return (
    isRecord(value) &&
    typeof value.observer === "string" &&
    OBSERVERS.has(value.observer) &&
    typeof value.acquisition === "string" &&
    ACQUISITIONS.has(value.acquisition) &&
    isNonEmptyString(value.buildCommit) &&
    isNonEmptyString(value.methodologyVersion) &&
    isRecord(value.detectorRegistry) &&
    isNonEmptyString(value.detectorRegistry.version) &&
    isNonEmptyString(value.detectorRegistry.digest) &&
    (value.sourceArtifactDigest === undefined || isNonEmptyString(value.sourceArtifactDigest))
  );
}

function isToolchain(value: unknown): value is Toolchain {
  if (!isRecord(value)) return false;
  const catalog = value.trackerCatalog;
  const adblock = value.adblock;
  const adblockOk =
    adblock === null ||
    (isRecord(adblock) &&
      isNonEmptyString(adblock.source) &&
      isCount(adblock.lists) &&
      isNonEmptyString(adblock.fetchedAt) &&
      isNonEmptyString(adblock.manifestDigest) &&
      isNonEmptyString(adblock.engineVersion));
  return (
    isRecord(catalog) &&
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
    isRecord(value) &&
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
    isRecord(value) &&
    typeof value.family === "string" &&
    (EVIDENCE_FAMILIES as readonly string[]).includes(value.family) &&
    (value.phaseId === null || isPhaseId(value.phaseId, phaseCount)) &&
    typeof value.kind === "string" &&
    CAPTURE_LOSS_KINDS.has(value.kind) &&
    isCount(value.count) &&
    (value.detail === undefined || typeof value.detail === "string")
  );
}

function isQualityFacts(value: unknown, phaseCount: number): value is QualityFacts {
  return (
    isRecord(value) &&
    (value.status === null || isFiniteNumber(value.status)) &&
    typeof value.botWallTitleMatched === "boolean" &&
    typeof value.navigationSettled === "boolean" &&
    isStringArray(value.budgetsExhausted) &&
    Array.isArray(value.captureLoss) &&
    value.captureLoss.every((entry) => isCaptureLossEntry(entry, phaseCount))
  );
}

function isQuality(value: unknown): value is Quality {
  if (!isRecord(value) || !isNonEmptyString(value.evaluatorVersion)) return false;
  const run = value.run;
  if (
    !isRecord(run) ||
    typeof run.outcome !== "string" ||
    !RUN_OUTCOMES.has(run.outcome) ||
    !isStringArray(run.reasons)
  ) {
    return false;
  }
  const byFamily = value.byFamily;
  if (!isRecord(byFamily)) return false;
  return EVIDENCE_FAMILIES.every((family) => {
    const entry = byFamily[family];
    return (
      isRecord(entry) &&
      typeof entry.outcome === "string" &&
      FAMILY_OUTCOMES.has(entry.outcome) &&
      isStringArray(entry.reasons)
    );
  });
}

function isPrivacyStats(value: unknown): value is PrivacyStats {
  if (!isRecord(value) || !isCount(value.redactionVersion)) return false;
  const redaction = value.redaction;
  return (
    isRecord(redaction) &&
    isCount(redaction.pathSegmentsGeneralized) &&
    isCount(redaction.queryKeysRedacted) &&
    isCount(redaction.storageKeysRedacted) &&
    isCount(redaction.cookieNamesRedacted) &&
    isCount(redaction.matrixParamsStripped) &&
    isCount(redaction.subdomainLabelsGeneralized) &&
    isCount(redaction.malformedUrlsDropped)
  );
}

/** The ledger must cover every detector in the registry (RFC 5.4). */
function isDetectorLedger(value: unknown, phaseCount: number): value is DetectorLedger {
  if (!isRecord(value)) return false;
  return DETECTOR_IDS.every((id) => {
    const entry = value[id];
    return (
      isRecord(entry) &&
      isNonEmptyString(entry.version) &&
      typeof entry.status === "string" &&
      DETECTOR_STATUSES.has(entry.status) &&
      (entry.reason === undefined || typeof entry.reason === "string") &&
      (entry.phaseId === undefined || isPhaseId(entry.phaseId, phaseCount))
    );
  });
}

function isPhaseSpans(value: unknown): value is PhaseSpan[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  return value.every(
    (span, index) =>
      isRecord(span) &&
      span.phaseId === index &&
      typeof span.kind === "string" &&
      (PHASE_KINDS as readonly string[]).includes(span.kind) &&
      isFiniteNumber(span.startedAtMs) &&
      isFiniteNumber(span.endedAtMs)
  );
}

function isRunSummary(value: unknown, phaseCount: number): value is RunSummary {
  if (!isRecord(value)) return false;
  const counts = value.counts;
  const countsOk =
    isRecord(counts) &&
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
    (value.status === null || isFiniteNumber(value.status)) &&
    isCount(value.durationMs) &&
    countsOk &&
    Array.isArray(value.countsByPhase) &&
    value.countsByPhase.every(
      (entry) =>
        isRecord(entry) &&
        isPhaseId(entry.phaseId, phaseCount) &&
        isCount(entry.totalRequests) &&
        isCount(entry.thirdPartyRequests) &&
        isCount(entry.knownTrackerRequests)
    )
  );
}

function isConsentObservation(value: unknown, phaseCount: number): boolean {
  return (
    isRecord(value) &&
    isPhaseId(value.phaseId, phaseCount) &&
    isNonEmptyString(value.method) &&
    (value.observed === null || typeof value.observed === "string") &&
    (value.consistentWithChoice === null || typeof value.consistentWithChoice === "boolean")
  );
}

function isConsentEvidence(value: unknown, phaseCount: number): value is ConsentEvidence {
  return (
    isRecord(value) &&
    typeof value.mode === "string" &&
    CONSENT_MODES.has(value.mode) &&
    typeof value.interactionAttempted === "boolean" &&
    typeof value.controlActivated === "boolean" &&
    Array.isArray(value.verificationObservations) &&
    value.verificationObservations.every((entry) => isConsentObservation(entry, phaseCount)) &&
    typeof value.choiceState === "string" &&
    CONSENT_CHOICE_STATES.has(value.choiceState) &&
    typeof value.reverifiedAfterReload === "boolean" &&
    (value.verificationFailureReason === undefined || typeof value.verificationFailureReason === "string") &&
    (value.cmp === undefined || typeof value.cmp === "string") &&
    (value.selector === undefined || typeof value.selector === "string") &&
    (value.matchedText === undefined || typeof value.matchedText === "string") &&
    (value.frameUrl === undefined || typeof value.frameUrl === "string")
  );
}

function everyHasPhaseId(value: unknown, phaseCount: number): boolean {
  return Array.isArray(value) && value.every((entry) => isRecord(entry) && isPhaseId(entry.phaseId, phaseCount));
}

function isMutationArray(value: unknown, phaseCount: number, payloadKey: "cookie" | "entry"): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        isRecord(entry) &&
        isPhaseId(entry.phaseId, phaseCount) &&
        typeof entry.op === "string" &&
        MUTATION_OPS.has(entry.op) &&
        isRecord(entry[payloadKey])
    )
  );
}

function isRunEvidence(value: unknown, phaseCount: number): value is RunEvidence {
  if (!isRecord(value)) return false;
  return (
    everyHasPhaseId(value.requests, phaseCount) &&
    isMutationArray(value.cookieMutations, phaseCount, "cookie") &&
    Array.isArray(value.cookiesFinal) &&
    value.cookiesFinal.every(isRecord) &&
    isMutationArray(value.storageMutations, phaseCount, "entry") &&
    Array.isArray(value.storageFinal) &&
    value.storageFinal.every(isRecord) &&
    everyHasPhaseId(value.fingerprintEvents, phaseCount) &&
    everyHasPhaseId(value.fingerprintDetections, phaseCount) &&
    Array.isArray(value.cnameCloaks) &&
    value.cnameCloaks.every(isRecord) &&
    everyHasPhaseId(value.pixelEvents, phaseCount) &&
    (value.privacyPolicy === undefined || isRecord(value.privacyPolicy)) &&
    (value.consent === undefined || isConsentEvidence(value.consent, phaseCount))
  );
}

export function isScanRunV2(value: unknown): value is ScanRunV2 {
  if (!isRecord(value) || !hasOnlyKeys(value, RUN_KEYS)) return false;
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
    isRecord(value) &&
    typeof value.axis === "string" &&
    (INTERVENTION_AXES as readonly string[]).includes(value.axis) &&
    isNonEmptyString(value.expected) &&
    (value.observed === null || typeof value.observed === "string") &&
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
    const verification = value.verification;
    const evidence = value.evidence;
    return (
      typeof value.axis === "string" &&
      (INTERVENTION_AXES as readonly string[]).includes(value.axis) &&
      (value.order === "AB" || value.order === "BA") &&
      isRecord(verification) &&
      isArmVerification(verification.baseline, baselinePhaseCount) &&
      isArmVerification(verification.variant, variantPhaseCount) &&
      isRecord(evidence) &&
      isCount(evidence.pairs) &&
      evidence.pairs >= 1 &&
      typeof evidence.counterbalanced === "boolean" &&
      typeof evidence.strength === "string" &&
      EVIDENCE_STRENGTHS.has(evidence.strength)
    );
  }
  if (value.kind === "temporal") {
    // No order, no verification: nothing was manipulated (RFC 4.1).
    return value.axis === undefined && value.order === undefined && value.verification === undefined;
  }
  return (
    typeof value.sourceOrder === "string" &&
    SOURCE_ORDERS.has(value.sourceOrder) &&
    value.axis === undefined &&
    value.order === undefined &&
    value.verification === undefined
  );
}

function isEligibility(value: unknown): boolean {
  return isRecord(value) && typeof value.eligible === "boolean" && isStringArray(value.reasons);
}

function isComparability(value: unknown, experimentKind: string): value is Comparability {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.evaluatorVersion) ||
    !isNonEmptyString(value.metricRegistryVersion) ||
    !isEligibility(value.pairValidity)
  ) {
    return false;
  }
  const perMetric = value.perMetric;
  if (!isRecord(perMetric) || !METRIC_FAMILIES.every((family) => isEligibility(perMetric[family]))) return false;
  // interventionVerified exists exactly when the experiment is an intervention (RFC 4.4).
  if (experimentKind === "intervention") return typeof value.interventionVerified === "boolean";
  return value.interventionVerified === undefined;
}

function isReportShareLike(value: unknown): boolean {
  return isRecord(value) && isNonEmptyString(value.id) && isNonEmptyString(value.path) && isNonEmptyString(value.jsonPath);
}

export function isPublicSingleReportV2(value: unknown): value is PublicSingleReportV2 {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, REPORT_ROOT_KEYS_SINGLE) &&
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
    !hasOnlyKeys(value, REPORT_ROOT_KEYS_COMPARISON) ||
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
    isRecord(value.diff) &&
    (value.share === undefined || isReportShareLike(value.share))
  );
}

export function isPublicScanReportV2(value: unknown): value is PublicScanReportV2 {
  if (!isRecord(value)) return false;
  if (value.reportType === "comparison") return isPublicComparisonReportV2(value);
  return isPublicSingleReportV2(value);
}
