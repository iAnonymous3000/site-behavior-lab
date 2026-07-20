import { adblockListMeta, type AdblockListMeta } from "./adblock-engine";
import { BUILD_COMMIT_ENV, recordedBuildCommit } from "./build-provenance";
import { NODE_ADBLOCK_ENGINE_VERSION, NODE_SHIELDS_REQUEST_CONTEXT_VERSION } from "./legacy-methodology";
import {
  DETECTOR_REGISTRY_DIGEST,
  isDetectorReasonCode,
  isDetectorReasonForStatus,
  DETECTOR_REGISTRY_VERSION,
  DETECTOR_VERSIONS,
  AUDIO_FINGERPRINT_APIS,
  CANVAS_READ_APIS,
  FINGERPRINT_EVENT_APIS,
  INPUT_MONITORING_EVENTS,
  KEYSTROKE_ENCODINGS,
  KEYSTROKE_FIELD_TYPES,
  LISTENER_TARGETS,
  SESSION_RECORDING_EVENTS,
  WEBGL_PARAMETERS,
  WEBGL_READ_APIS
} from "./measurement-kernel";
import {
  REDACTION_ALLOWLISTS_VERSION,
  REDACTION_ALLOWLISTS_DIGEST,
  REDACTION_VERSION,
  PUBLIC_SUFFIX_ENGINE_VERSION,
  addRedactionCounters,
  emptyRedactionCounters,
  publicRegistrableDomain,
  redactUrlV2,
  type RedactionCounters
} from "./redaction-v2";
import {
  RedactionPass,
  PUBLIC_STRING_POLICY_DIGEST,
  PUBLIC_STRING_POLICY_VERSION,
  assertKnownPixelEventVocabulary,
  redactConsentInteraction,
  redactCookie,
  redactFingerprintDetection,
  redactPixelEvents,
  redactPrivacyPolicy,
  redactRequest,
  redactScannerWarnings,
  redactStorage,
  redactTrackerMatch
} from "./redact-scan-report-v1";
import { MIN_POLICY_TEXT_LENGTH } from "./privacy-policy";
import { toPublicScanReportR2 } from "./scan-report-v2-r2-projection";
import { NODE_SCAN_REPORT_V2_R2_MAX_PUBLIC_BYTES } from "./scan-report-v2-r2-limits";
import {
  deriveArmVerificationR2,
  deriveChoiceStateR2,
  deriveReverifiedAfterReloadR2,
  evaluateComparabilityR2,
  scanReportV2R2SemanticViolations
} from "./scan-report-v2-r2-evaluators";
import { isEphemeralScanReportR2 } from "./scan-report-v2-r2-validation";
import {
  SCAN_REPORT_V2_SCHEMA_REVISION_2,
  type BannerTransitionR2,
  type ConsentEvidenceR2,
  type ConsentObservationResultR2,
  type EphemeralComparisonReportR2,
  type EphemeralSingleReportR2,
  type GpcVerificationFactsR2,
  type InterventionExperimentR2,
  type RunEvidenceR2,
  type ScanRunV2R2,
  type ShieldsVerificationFactsR2
} from "./scan-report-v2-r2";
import {
  buildComparisonDiffV2,
  deriveObservationConsistency,
  evaluateQuality,
  interventionAxisDelta
} from "./scan-report-v2-evaluators";
import { BUDGET_FAMILIES } from "./scan-report-v2-evaluators";
import { buildFingerprints, canonicalJson } from "./scan-report-v2-fingerprints";
import {
  DETECTOR_IDS,
  SCAN_REPORT_V2_SCHEMA_VERSION,
  type AcquisitionKind,
  type CaptureLossEntry,
  type ConditionVector,
  type DetectorLedger,
  type PhaseId,
  type PhaseSpan,
  type QualityFacts,
  type RunSummary,
  type SubjectIdentity,
  type SubjectKey,
  type Toolchain
} from "./scan-report-v2";
import { trackerCatalogMetadata } from "./tracker-catalog";
import { findTrackerMatch } from "./tracker-catalog";
import { MAX_RECORDED_REQUESTS } from "./scan-runtime";
import { partyKey } from "./domain-utils";
import type { FingerprintDetectionSummary, PrivacyPolicySummary, TrackerMatch } from "./types";

/**
 * Node-only ScanReport v2/r2 single-run builder.
 *
 * The live Node scanner collects and stages this input shape out of band for
 * gated public or shadow r2 emission. Its input starts after the raw/classification
 * seam: evidence and mutation records are phase-tagged but
 * may still contain page-controlled strings. This builder owns the one public
 * sanitizer and computes its counters from the exact emitted evidence.
 * Every conclusion-like field is derived, and the completed ephemeral report
 * must pass the same structural and semantic gates used by readers.
 */

export const NODE_SCAN_REPORT_V2_R2_NORMALIZATION_VERSION =
  `redaction-v${REDACTION_VERSION}+${REDACTION_ALLOWLISTS_VERSION}:${REDACTION_ALLOWLISTS_DIGEST}+${PUBLIC_STRING_POLICY_VERSION}:${PUBLIC_STRING_POLICY_DIGEST}+${PUBLIC_SUFFIX_ENGINE_VERSION}+node-evidence-policy-v1`;
export const NODE_SCAN_REPORT_V2_R2_METHODOLOGY_VERSION =
  `${NODE_SHIELDS_REQUEST_CONTEXT_VERSION}+phase-kernel-v2+boundary-state-v1+consent-r2-v2+resource-budget-v1+proxy-traffic-v1+service-worker-block-v1`;

export { NODE_SCAN_REPORT_V2_R2_MAX_PUBLIC_BYTES } from "./scan-report-v2-r2-limits";
const MAX_PHASES = 16;
const MAX_WARNINGS = 64;
const MAX_COOKIE_RECORDS = 1_000;
const MAX_COOKIE_MUTATIONS = 2_000;
const MAX_STORAGE_RECORDS = 1_000;
const MAX_STORAGE_MUTATIONS = 2_000;
const MAX_FINGERPRINT_EVENTS = 1_000;
const MAX_FINGERPRINT_DETECTIONS = 256;
const MAX_CNAME_CLOAKS = 256;
const MAX_PIXEL_EVENTS = 512;
const MAX_CONSENT_OBSERVATIONS = 32;
const MAX_POLICY_CLAIMS = 32;
const MAX_POLICY_ENTITIES = 100;

const SHA256 = /^[0-9a-f]{64}$/;
const MAX_PAGE_TITLE_CHARS = 200;

export type MeasurementKernelResultR2 = {
  phases: PhaseSpan[];
  detectors: DetectorLedger;
  qualityFacts: QualityFacts;
};

export type ConsentObservationFactsR2 = {
  phaseId: PhaseId;
  method: string;
  observed: ConsentEvidenceR2["verificationObservations"][number]["observed"];
  result: ConsentObservationResultR2;
};

/** Facts only: the builder derives mode, consistency, choiceState, and reload verification. */
export type ConsentFactsR2 = {
  interactionAttempted: boolean;
  controlActivated: boolean;
  verificationObservations: ConsentObservationFactsR2[];
  bannerTransition?: BannerTransitionR2;
  cmp?: string;
  selector?: string;
  matchedText?: string;
  frameUrl?: string;
};

export type NodeScanReportV2R2Input = {
  runId: string;
  startedAt: string;
  requestedUrl: string;
  observedUrl: string;
  conditions: ConditionVector;
  acquisition: AcquisitionKind;
  /** False is a known absence and produces toolchain.adblock=null. */
  adblockEngineLoaded: boolean;
  measurement: MeasurementKernelResultR2;
  /** Classified, phase-tagged Tier-0 evidence, excluding consent. */
  evidence: Omit<RunEvidenceR2, "consent">;
  /** Counts are rebuilt from evidence; only display/timing inputs are accepted. */
  summary: Pick<RunSummary, "pageTitle" | "durationMs">;
  consent?: ConsentFactsR2;
  verificationFacts?: { gpc?: GpcVerificationFactsR2; shields?: ShieldsVerificationFactsR2 };
  /** Scanner-vocabulary strings only; page-derived warnings do not belong here. */
  warnings: string[];
  screenshot: string | null;
};

export type NodeInterventionComparisonV2R2Input = {
  pairId: string;
  /** Scheduler testimony used only to cross-check recorded chronology. */
  executedFirst: "baseline" | "variant";
  baseline: NodeScanReportV2R2Input;
  variant: NodeScanReportV2R2Input;
};

export function buildNodeScanReportV2R2(
  input: NodeScanReportV2R2Input,
  env: NodeJS.ProcessEnv = process.env
): EphemeralSingleReportR2 {
  assertProducerIdentity(input.runId, input.startedAt);
  assertNodeConditions(input.conditions);
  assertMeasurementRegistry(input.measurement.detectors);
  assertQualityVocabulary(input.measurement.qualityFacts);
  assertSummaryInputs(input.summary, input.measurement.phases);

  if (Object.prototype.hasOwnProperty.call(input.evidence, "consent")) {
    throw new Error("r2 builder input evidence must not carry consent; pass consent facts separately.");
  }
  if (input.conditions.consent === "observe" && input.consent !== undefined) {
    throw new Error("observe-mode runs cannot carry consent facts.");
  }
  if (input.conditions.consent !== "observe" && input.consent === undefined) {
    throw new Error("consent-mode runs require recorded consent facts.");
  }
  if (input.consent && Object.prototype.hasOwnProperty.call(input.consent, "verificationFailureReason")) {
    throw new Error("r2 consent failures derive from structured observation results, not a free-form failure reason.");
  }

  const buildCommit = resolveBuildCommit(env);
  const toolchain = currentNodeToolchain(input.adblockEngineLoaded);
  assertKnownNodeToolchainIdentity(toolchain);

  const conditions = structuredClone(input.conditions);
  const phases = structuredClone(input.measurement.phases);
  const detectors = structuredClone(input.measurement.detectors);
  assertPhasePlan(input.conditions, phases, detectors);
  assertPhaseEvidence(phases, detectors, input.evidence);
  const qualityFacts = structuredClone(input.measurement.qualityFacts);
  const verificationFacts = input.verificationFacts === undefined ? undefined : structuredClone(input.verificationFacts);
  assertVerificationFacts(input.conditions, input.adblockEngineLoaded, verificationFacts);

  const privacyCounters = emptyRedactionCounters();
  const subject: SubjectIdentity = {
    requested: subjectKey(input.requestedUrl, privacyCounters, "requestedUrl"),
    observed: subjectKey(input.observedUrl, privacyCounters, "observedUrl")
  };
  const publicPass = new RedactionPass();
  const evidence = sanitizeEvidence(
    input.evidence,
    subject.observed.registrableDomain,
    input.adblockEngineLoaded,
    publicPass,
    qualityFacts
  );
  const consentFacts =
    input.consent === undefined
      ? undefined
      : sanitizeConsentFacts(input.consent, input.conditions.consent, publicPass, qualityFacts);
  const warningInput = clipArray(input.warnings, MAX_WARNINGS, "detector-output", "public-warnings", qualityFacts);
  const warnings = redactScannerWarnings(warningInput, publicPass);
  addRedactionCounters(privacyCounters, publicPass.counters);

  const provenance: ScanRunV2R2["provenance"] = {
    observer: "node-playwright",
    acquisition: input.acquisition,
    buildCommit,
    methodologyVersion: NODE_SCAN_REPORT_V2_R2_METHODOLOGY_VERSION,
    detectorRegistry: { version: DETECTOR_REGISTRY_VERSION, digest: DETECTOR_REGISTRY_DIGEST }
  };

  const fingerprints = buildFingerprints({ conditions, provenance, toolchain, detectors });
  const quality = evaluateQuality(qualityFacts, { observedRequests: evidence.requests.length });
  const summary = buildSummary(
    input.summary,
    evidence,
    qualityFacts,
    conditions.shields,
    verificationFacts?.shields
  );

  let run: ScanRunV2R2 = {
    runId: input.runId,
    startedAt: input.startedAt,
    subject,
    conditions,
    provenance,
    toolchain,
    fingerprints,
    qualityFacts,
    quality,
    privacy: { redactionVersion: REDACTION_VERSION, redaction: privacyCounters },
    detectors,
    phases,
    summary,
    evidence,
    ...(verificationFacts !== undefined ? { verificationFacts } : {}),
    warnings
  };

  if (consentFacts !== undefined) {
    const consent = consentEvidenceFromFacts(consentFacts, run);
    run = {
      ...run,
      // The v1 result keeps its dispatch-only disclosure. An r2 run whose
      // structured readbacks verified registration must not contradict that
      // evidence by forwarding the same legacy warning.
      warnings:
        consent.choiceState === "verified"
          ? run.warnings.filter((warning) => !isLegacyUnverifiedConsentWarning(warning))
          : run.warnings,
      evidence: { ...run.evidence, consent }
    };
  }

  const report: EphemeralSingleReportR2 = {
    schemaVersion: SCAN_REPORT_V2_SCHEMA_VERSION,
    schemaRevision: SCAN_REPORT_V2_SCHEMA_REVISION_2,
    reportType: "single",
    run,
    ephemeral: { screenshot: input.screenshot }
  };

  if (!isEphemeralScanReportR2(report)) {
    throw new Error("Refusing to build an invalid ScanReport v2/r2 ephemeral shell.");
  }
  const publicReport = toPublicScanReportR2(report);
  const storedWireBytes = Buffer.byteLength(`${JSON.stringify(publicReport, null, 2)}\n`, "utf8");
  if (storedWireBytes > NODE_SCAN_REPORT_V2_R2_MAX_PUBLIC_BYTES) {
    throw new Error(
      `Refusing to build a ScanReport v2/r2 larger than ${NODE_SCAN_REPORT_V2_R2_MAX_PUBLIC_BYTES} public bytes.`
    );
  }
  const violations = scanReportV2R2SemanticViolations(publicReport);
  if (violations.length > 0) {
    throw new Error(`Refusing to build an inconsistent ScanReport v2/r2: ${violations.join("; ")}`);
  }
  return report;
}

function isLegacyUnverifiedConsentWarning(warning: string): boolean {
  return warning.includes("The click was dispatched, not verified as registered by the site");
}

/**
 * Build one complete intervention pair from two staged Node visits. The caller
 * supplies only facts and scheduler order: axis, semantic arms, evidence
 * strength, comparability, and diff are all derived here.
 */
export function buildNodeComparisonScanReportV2R2(
  input: NodeInterventionComparisonV2R2Input,
  env: NodeJS.ProcessEnv = process.env
): EphemeralComparisonReportR2 {
  assertOpaqueProducerToken(input.pairId, "pairId");
  if (input.executedFirst !== "baseline" && input.executedFirst !== "variant") {
    throw new Error("executedFirst must be exactly baseline or variant.");
  }
  const baselineShell = buildNodeScanReportV2R2(input.baseline, env);
  const variantShell = buildNodeScanReportV2R2(input.variant, env);
  const baseline = baselineShell.run;
  const variant = variantShell.run;

  if (baseline.runId === variant.runId) {
    throw new Error("Comparison arms require distinct runId values.");
  }
  const axis = interventionAxisDelta(baseline, variant);
  if (axis === null) {
    throw new Error("Comparison arms must differ on exactly one intervention axis.");
  }
  assertCanonicalNodeIntervention(axis, baseline, variant);

  const baselineStartedAt = Date.parse(baseline.startedAt);
  const variantStartedAt = Date.parse(variant.startedAt);
  if (baselineStartedAt === variantStartedAt) {
    throw new Error("Comparison arms require distinct startedAt timestamps.");
  }
  const chronologicalOrder = baselineStartedAt < variantStartedAt ? "AB" : "BA";
  const schedulerOrder = input.executedFirst === "baseline" ? "AB" : "BA";
  if (chronologicalOrder !== schedulerOrder) {
    throw new Error("Comparison scheduler order disagrees with the arms' startedAt chronology.");
  }

  const baselineVerification = deriveArmVerificationR2(baseline, axis);
  const variantVerification = deriveArmVerificationR2(variant, axis);
  if (baselineVerification === null || variantVerification === null) {
    throw new Error(`Comparison arms require structured verificationFacts.${axis}.`);
  }

  const experiment: InterventionExperimentR2 = {
    kind: "intervention",
    axis,
    pairId: input.pairId,
    order: chronologicalOrder,
    verification: { baseline: baselineVerification, variant: variantVerification },
    evidence: { pairs: 1, counterbalanced: false, strength: "observed-difference" }
  };
  const comparability = evaluateComparabilityR2(experiment, baseline, variant);
  const report: EphemeralComparisonReportR2 = {
    schemaVersion: SCAN_REPORT_V2_SCHEMA_VERSION,
    schemaRevision: SCAN_REPORT_V2_SCHEMA_REVISION_2,
    reportType: "comparison",
    baseline,
    variant,
    experiment,
    comparability,
    diff: buildComparisonDiffV2(baseline, variant, comparability.perMetric),
    ephemeral: {
      baselineScreenshot: baselineShell.ephemeral.screenshot,
      variantScreenshot: variantShell.ephemeral.screenshot
    }
  };

  if (!isEphemeralScanReportR2(report)) {
    throw new Error("Refusing to build an invalid ScanReport v2/r2 comparison shell.");
  }
  const publicReport = toPublicScanReportR2(report);
  const storedWireBytes = Buffer.byteLength(`${JSON.stringify(publicReport, null, 2)}\n`, "utf8");
  if (storedWireBytes > NODE_SCAN_REPORT_V2_R2_MAX_PUBLIC_BYTES) {
    throw new Error(
      `Refusing to build a ScanReport v2/r2 comparison larger than ${NODE_SCAN_REPORT_V2_R2_MAX_PUBLIC_BYTES} public bytes.`
    );
  }
  const violations = scanReportV2R2SemanticViolations(publicReport);
  if (violations.length > 0) {
    throw new Error(`Refusing to build an inconsistent ScanReport v2/r2 comparison: ${violations.join("; ")}`);
  }
  return report;
}

function assertCanonicalNodeIntervention(
  axis: "gpc" | "shields" | "consent",
  baseline: ScanRunV2R2,
  variant: ScanRunV2R2
): void {
  const canonical =
    (axis === "gpc" && baseline.conditions.gpc === false && variant.conditions.gpc === true) ||
    (axis === "shields" &&
      baseline.conditions.shields === "classification" &&
      variant.conditions.shields === "block-simulation") ||
    (axis === "consent" &&
      baseline.conditions.consent === "accept-all" &&
      variant.conditions.consent === "reject-all");
  if (!canonical) {
    throw new Error(`Comparison ${axis} arms are not in the canonical baseline/variant orientation.`);
  }
}

function assertProducerIdentity(runId: string, startedAt: string): void {
  assertOpaqueProducerToken(runId, "runId");
  const parsed = Date.parse(startedAt);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== startedAt) {
    throw new Error("startedAt must be a canonical ISO-8601 UTC timestamp.");
  }
}

function assertOpaqueProducerToken(value: string, label: "runId" | "pairId"): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new Error(`${label} must be a bounded producer-generated opaque token.`);
  }
}

function assertVerificationFacts(
  conditions: ConditionVector,
  engineLoaded: boolean,
  facts: NodeScanReportV2R2Input["verificationFacts"]
): void {
  const shields = facts?.shields;
  if (shields !== undefined) {
    if (shields.engineLoaded !== engineLoaded) {
      throw new Error("Shields verification facts disagree with the loaded adblock engine state.");
    }
  }
  if (conditions.shields === "block-simulation" && shields === undefined) {
    throw new Error("Block-simulation runs require structured Shields verification facts.");
  }
}

function assertPhasePlan(conditions: ConditionVector, phases: PhaseSpan[], detectors: DetectorLedger): void {
  for (const [index, phase] of phases.entries()) {
    if (
      phase.phaseId !== index ||
      !Number.isSafeInteger(phase.startedAtMs) ||
      !Number.isSafeInteger(phase.endedAtMs) ||
      phase.startedAtMs < 0 ||
      phase.endedAtMs < phase.startedAtMs
    ) {
      throw new Error("Node measurement phases require sequential IDs and nonnegative integer spans.");
    }
  }
  const kinds = phases.map((phase) => phase.kind);
  if (kinds[0] !== "passive-load") throw new Error("A Node r2 phase plan must start with passive-load.");
  if (new Set(kinds).size !== kinds.length) throw new Error("A Node r2 phase plan cannot repeat a phase kind.");
  const order = new Map([
    ["passive-load", 0],
    ["consent-interaction", 1],
    ["post-choice-reload", 2],
    ["active-probe", 3],
    ["policy-analysis", 4]
  ] as const);
  for (let index = 1; index < kinds.length; index += 1) {
    if ((order.get(kinds[index - 1]) ?? -1) >= (order.get(kinds[index]) ?? -1)) {
      throw new Error("A Node r2 phase plan is out of order.");
    }
  }

  const hasConsent = kinds.includes("consent-interaction");
  const hasReload = kinds.includes("post-choice-reload");
  if (conditions.consent === "observe" && (hasConsent || hasReload)) {
    throw new Error("Observe-mode runs cannot carry consent interaction or reload phases.");
  }
  if (conditions.consent !== "observe" && !hasConsent) {
    throw new Error("Consent-mode runs require a consent-interaction phase.");
  }
  if (hasReload && !hasConsent) throw new Error("A post-choice reload requires a consent-interaction phase.");
  const hasActiveProbe = kinds.includes("active-probe");
  if (hasActiveProbe && !conditions.probes.keystroke) {
    throw new Error("An active-probe phase requires the declared keystroke probe condition.");
  }
  if (conditions.probes.keystroke && !hasActiveProbe && !accountableSkippedDetector(detectors["keystroke-exfiltration"])) {
    throw new Error("A skipped active probe requires an accountable keystroke detector outcome.");
  }
  if (hasActiveProbe && !executedDetector(detectors["keystroke-exfiltration"])) {
    throw new Error("An active-probe phase requires an executed keystroke detector outcome.");
  }
  if (!hasActiveProbe && executedDetector(detectors["keystroke-exfiltration"])) {
    throw new Error("An executed keystroke detector requires an active-probe phase.");
  }
  const hasPolicy = kinds.includes("policy-analysis");
  if (hasPolicy && !conditions.probes.policyVisit) {
    throw new Error("A policy-analysis phase requires the declared policy-visit condition.");
  }
  if (conditions.probes.policyVisit && !hasPolicy && !accountableSkippedDetector(detectors["privacy-policy"])) {
    throw new Error("A skipped policy visit requires an accountable privacy-policy detector outcome.");
  }
  if (hasPolicy && !executedDetector(detectors["privacy-policy"])) {
    throw new Error("A policy-analysis phase requires an executed privacy-policy detector outcome.");
  }
  if (!hasPolicy && executedDetector(detectors["privacy-policy"])) {
    throw new Error("An executed privacy-policy detector requires a policy-analysis phase.");
  }

  for (const id of ["fingerprint-heuristics", "cname-uncloaking", "pixel-events", "consent-banner"] as const) {
    const entry = detectors[id];
    if (entry.status === "skipped" && (entry.reason === "not-requested" || entry.reason === "probe-disabled")) {
      throw new Error(`Always-on detector ${id} cannot remain in its default unrequested state.`);
    }
  }
}

function assertPhaseEvidence(
  phases: PhaseSpan[],
  detectors: DetectorLedger,
  evidence: Omit<RunEvidenceR2, "consent">
): void {
  const activeProbe = phases.find((phase) => phase.kind === "active-probe");
  const policyAnalysis = phases.find((phase) => phase.kind === "policy-analysis");
  const keystroke = detectors["keystroke-exfiltration"];
  if (activeProbe && keystroke.phaseId !== activeProbe.phaseId) {
    throw new Error("The keystroke detector ledger must identify the active-probe phase.");
  }
  for (const detection of evidence.fingerprintDetections) {
    if (detection.kind === "keystroke-exfiltration" && detection.phaseId !== activeProbe?.phaseId) {
      throw new Error("Keystroke detection evidence must belong to the active-probe phase.");
    }
  }
  const policy = detectors["privacy-policy"];
  if (policyAnalysis && policy.phaseId !== policyAnalysis.phaseId) {
    throw new Error("The privacy-policy detector ledger must identify the policy-analysis phase.");
  }
  if (evidence.privacyPolicy !== undefined && policyAnalysis === undefined) {
    throw new Error("Privacy-policy evidence requires a policy-analysis phase.");
  }
}

function accountableSkippedDetector(entry: DetectorLedger[keyof DetectorLedger]): boolean {
  return (
    entry.status !== "complete" &&
    entry.status !== "partial" &&
    entry.reason !== undefined &&
    ["budget-unavailable", "unsupported", "load-failed", "scan-failed"].includes(entry.reason)
  );
}

function executedDetector(entry: DetectorLedger[keyof DetectorLedger]): boolean {
  return entry.status === "complete" || entry.status === "partial" || entry.status === "failed";
}

function sanitizeEvidence(
  source: Omit<RunEvidenceR2, "consent">,
  observedRegistrableDomain: string,
  adblockEngineLoaded: boolean,
  pass: RedactionPass,
  qualityFacts: QualityFacts
): RunEvidenceR2 {
  assertRequestTrackerAndPolicyVocabulary(source, observedRegistrableDomain, adblockEngineLoaded);
  const requests = clipArray(
    source.requests,
    MAX_RECORDED_REQUESTS,
    "requests",
    "public-request-records",
    qualityFacts
  ).map((request) => ({ ...redactRequest(request, pass), phaseId: request.phaseId }));

  const cookieMutations = clipArray(
    source.cookieMutations,
    MAX_COOKIE_MUTATIONS,
    "cookies",
    "public-cookie-mutations",
    qualityFacts
  ).map((mutation) => ({ ...mutation, cookie: redactCookie(mutation.cookie, pass) }));
  const cookiesFinal = clipArray(
    source.cookiesFinal,
    MAX_COOKIE_RECORDS,
    "cookies",
    "public-cookie-final",
    qualityFacts
  ).map((cookie) => redactCookie(cookie, pass));

  const storageMutations = clipArray(
    source.storageMutations,
    MAX_STORAGE_MUTATIONS,
    "storage",
    "public-storage-mutations",
    qualityFacts
  ).map((mutation) => ({ ...mutation, entry: redactStorage(mutation.entry, pass) }));
  const storageFinal = clipArray(
    source.storageFinal,
    MAX_STORAGE_RECORDS,
    "storage",
    "public-storage-final",
    qualityFacts
  ).map((entry) => redactStorage(entry, pass));

  const fingerprintEvents = clipArray(
    source.fingerprintEvents,
    MAX_FINGERPRINT_EVENTS,
    "fingerprinting",
    "public-fingerprint-events",
    qualityFacts
  ).map((event) => {
    if (!(FINGERPRINT_EVENT_APIS as readonly string[]).includes(event.api)) {
      throw new Error(`Unknown fingerprint event API: ${event.api}`);
    }
    return { ...event };
  });
  const fingerprintDetections = clipArray(
    source.fingerprintDetections,
    MAX_FINGERPRINT_DETECTIONS,
    "detector-output",
    "public-fingerprint-detections",
    qualityFacts
  ).map((entry) => {
    const { phaseId, ...detection } = entry;
    return { ...sanitizeFingerprintDetection(detection, pass), phaseId };
  });

  const clippedCnameCloaks = clipArray(
    source.cnameCloaks,
    MAX_CNAME_CLOAKS,
    "detector-output",
    "public-cname-cloaks",
    qualityFacts
  ).map((cloak) => {
    const tracker = redactTrackerMatch(cloak.tracker, pass, cloak.cname);
    if (tracker === null) throw new Error("A CNAME cloak must carry a catalogued tracker match.");
    return { host: pass.hostname(cloak.host), cname: pass.hostname(cloak.cname), tracker };
  });
  const retainedRequestHosts = new Set(requests.map((request) => request.domain));
  const cnameCloaks = clippedCnameCloaks.filter((cloak) => retainedRequestHosts.has(cloak.host));
  if (cnameCloaks.length !== clippedCnameCloaks.length) {
    recordPublicCaptureLoss(
      "detector-output",
      "public-cname-cloaks",
      clippedCnameCloaks.length - cnameCloaks.length,
      qualityFacts
    );
  }

  const pixelEvents = clipArray(
    source.pixelEvents,
    MAX_PIXEL_EVENTS,
    "detector-output",
    "public-pixel-events",
    qualityFacts
  ).flatMap((entry) => {
    const { phaseId, ...event } = entry;
    assertKnownPixelEventVocabulary(event);
    return redactPixelEvents([event]).map((redacted) => ({ ...redacted, phaseId }));
  });

  const retainedTrackerEntities = new Set<string>();
  for (const request of requests) {
    if (request.tracker !== null) retainedTrackerEntities.add(request.tracker.entity);
  }
  for (const cloak of cnameCloaks) retainedTrackerEntities.add(cloak.tracker.entity);

  const privacyPolicy = source.privacyPolicy === undefined
    ? undefined
    : sanitizePrivacyPolicy(source.privacyPolicy, retainedTrackerEntities, pass, qualityFacts);

  return {
    requests,
    cookieMutations,
    cookiesFinal,
    storageMutations,
    storageFinal,
    fingerprintEvents,
    fingerprintDetections,
    cnameCloaks,
    pixelEvents,
    ...(privacyPolicy === undefined ? {} : { privacyPolicy })
  };
}

function assertRequestTrackerAndPolicyVocabulary(
  source: Omit<RunEvidenceR2, "consent">,
  observedRegistrableDomain: string,
  adblockEngineLoaded: boolean
): void {
  const entities = new Set<string>();
  const requestIds = new Set<number>();
  const requestHosts = new Set<string>();
  for (const request of source.requests) {
    if (!Number.isSafeInteger(request.id) || request.id <= 0 || requestIds.has(request.id)) {
      throw new Error("Node request evidence IDs must be positive and unique.");
    }
    requestIds.add(request.id);
    if (!Number.isSafeInteger(request.startedAtMs) || request.startedAtMs < 0) {
      throw new Error("Node request evidence timestamps must be nonnegative integers.");
    }
    if (request.status !== null && (!Number.isInteger(request.status) || request.status < 100 || request.status > 599)) {
      throw new Error("Node request evidence HTTP status must be null or an integer from 100 through 599.");
    }
    let parsed: URL;
    try {
      parsed = new URL(request.url);
    } catch {
      throw new Error("Node request evidence contains an invalid URL.");
    }
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.hostname) {
      throw new Error("Node request evidence contains a non-HTTP(S) URL.");
    }
    const canonicalDomain = parsed.hostname.toLowerCase().replace(/\.$/, "");
    const requestParty = evidencePartyKey(canonicalDomain);
    if (requestParty === null) throw new Error("Node request evidence host has no public registrable domain.");
    if (request.domain.toLowerCase().replace(/\.$/, "") !== canonicalDomain) {
      throw new Error("Node request evidence domain disagrees with its URL.");
    }
    const thirdParty = requestParty !== observedRegistrableDomain;
    if (request.thirdParty !== thirdParty) {
      throw new Error("Node request evidence third-party classification disagrees with the observed subject.");
    }
    if (!thirdParty && request.tracker !== null) {
      throw new Error("First-party request evidence cannot carry a third-party tracker classification.");
    }
    if (request.blockedByShields === true && !adblockEngineLoaded) {
      throw new Error("Shields-derived request evidence requires the loaded adblock toolchain identity.");
    }
    requestHosts.add(canonicalDomain);
    if (request.tracker === null) continue;
    if (request.tracker.confidence === "shields-list" && !adblockEngineLoaded) {
      throw new Error("Shields-list tracker evidence requires the loaded adblock toolchain identity.");
    }
    assertTrackerVocabulary(request.domain, request.tracker);
    entities.add(request.tracker.entity);
  }
  for (const cloak of source.cnameCloaks) {
    const host = normalizeEvidenceHostname(cloak.host);
    const cname = normalizeEvidenceHostname(cloak.cname);
    if (host === null || cname === null) throw new Error("CNAME evidence contains an invalid hostname.");
    const hostParty = publicRegistrableDomain(host);
    const cnameParty = publicRegistrableDomain(cname);
    if (hostParty !== observedRegistrableDomain || cnameParty === null || cnameParty === observedRegistrableDomain) {
      throw new Error("CNAME evidence must connect an observed first-party alias to a distinct third-party target.");
    }
    if (!requestHosts.has(host)) throw new Error("CNAME evidence must be grounded in an observed first-party request host.");
    if (cloak.tracker.confidence === "shields-list" && !adblockEngineLoaded) {
      throw new Error("Shields-list CNAME evidence requires the loaded adblock toolchain identity.");
    }
    assertTrackerVocabulary(cloak.cname, cloak.tracker);
    entities.add(cloak.tracker.entity);
  }
  for (const cookie of source.cookiesFinal) assertCookieParty(cookie, observedRegistrableDomain);
  for (const mutation of source.cookieMutations) assertCookieParty(mutation.cookie, observedRegistrableDomain);
  const policy = source.privacyPolicy;
  if (!policy) return;
  assertPrivacyPolicyShape(policy);
  for (const entity of [...policy.mentionedEntities, ...policy.unmentionedEntities]) {
    if (!entities.has(entity)) throw new Error("Privacy-policy entity output is not grounded in observed tracker evidence.");
  }
}

function normalizeEvidenceHostname(value: string): string | null {
  const raw = value.trim().replace(/^\./, "").replace(/\.+$/, "");
  if (!raw || /[\s/@?#]/.test(raw)) return null;
  try {
    return new URL(`https://${raw}/`).hostname.replace(/\.+$/, "");
  } catch {
    return null;
  }
}

function evidencePartyKey(host: string): string | null {
  const registrable = publicRegistrableDomain(host);
  if (registrable !== null) return registrable;
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(host) || /^\[[0-9a-f:.]+\]$/i.test(host)) return host;
  return null;
}

function assertCookieParty(cookie: RunEvidenceR2["cookiesFinal"][number], observedRegistrableDomain: string): void {
  const host = normalizeEvidenceHostname(cookie.domain);
  const party = host === null ? null : evidencePartyKey(host);
  if (party === null) throw new Error("Cookie evidence host has no public registrable domain.");
  if (cookie.thirdParty !== (party !== observedRegistrableDomain)) {
    throw new Error("Cookie evidence third-party classification disagrees with the observed subject.");
  }
}

function assertTrackerVocabulary(host: string, tracker: TrackerMatch): void {
  const registrableDomain = publicRegistrableDomain(host);
  if (registrableDomain === null) {
    throw new Error("Tracker evidence host has no registrable domain.");
  }
  if (tracker.confidence === "curated") {
    const expected = findTrackerMatch(host);
    if (expected === null || canonicalJson(expected) !== canonicalJson(tracker)) {
      throw new Error("Tracker evidence does not match the current curated catalog.");
    }
    return;
  }
  const domain = partyKey(host);
  const expected: TrackerMatch = {
    domain,
    entity: domain,
    category: "tracking (Brave Shields list)",
    confidence: "shields-list"
  };
  if (canonicalJson(expected) !== canonicalJson(tracker)) {
    throw new Error("Shields-list tracker evidence is not in the producer-owned fallback shape.");
  }
}

function assertPrivacyPolicyShape(policy: PrivacyPolicySummary): void {
  if (!Number.isSafeInteger(policy.policyTextLength) || policy.policyTextLength < MIN_POLICY_TEXT_LENGTH) {
    throw new Error(`Privacy-policy text length must be at least ${MIN_POLICY_TEXT_LENGTH} characters.`);
  }
  assertUniqueStrings("privacy-policy mentioned entity", policy.mentionedEntities);
  assertUniqueStrings("privacy-policy unmentioned entity", policy.unmentionedEntities);
  const mentioned = new Set(policy.mentionedEntities);
  if (policy.unmentionedEntities.some((entity) => mentioned.has(entity))) {
    throw new Error("Privacy-policy mentioned and unmentioned entities must be disjoint.");
  }
  const claimKinds = policy.claims.map((claim) => claim.kind);
  assertUniqueStrings("privacy-policy claim kind", claimKinds);
}

function assertUniqueStrings(label: string, values: readonly string[]): void {
  if (new Set(values).size !== values.length) throw new Error(`${label} values must be unique.`);
}

function sanitizePrivacyPolicy(
  policy: PrivacyPolicySummary,
  retainedTrackerEntities: ReadonlySet<string>,
  pass: RedactionPass,
  qualityFacts: QualityFacts
): PrivacyPolicySummary {
  const claims = clipArray(
    policy.claims,
    MAX_POLICY_CLAIMS,
    "detector-output",
    "public-policy-claims",
    qualityFacts
  );
  const mentioned = clipArray(
    policy.mentionedEntities,
    MAX_POLICY_ENTITIES,
    "detector-output",
    "public-policy-entities",
    qualityFacts
  );
  const unmentioned = clipArray(
    policy.unmentionedEntities,
    MAX_POLICY_ENTITIES,
    "detector-output",
    "public-policy-entities",
    qualityFacts
  );
  const retainedMentioned = mentioned.filter((entity) => retainedTrackerEntities.has(entity));
  const retainedUnmentioned = unmentioned.filter((entity) => retainedTrackerEntities.has(entity));
  const ungroundedAfterClipping =
    mentioned.length - retainedMentioned.length + unmentioned.length - retainedUnmentioned.length;
  if (ungroundedAfterClipping > 0) {
    recordPublicCaptureLoss(
      "detector-output",
      "public-policy-entities",
      ungroundedAfterClipping,
      qualityFacts
    );
  }
  return redactPrivacyPolicy(
    {
      ...policy,
      claims,
      mentionedEntities: retainedMentioned,
      unmentionedEntities: retainedUnmentioned
    },
    pass,
    retainedTrackerEntities
  );
}

function sanitizeFingerprintDetection(
  detection: FingerprintDetectionSummary,
  pass: RedactionPass
): FingerprintDetectionSummary {
  if (detection.kind === "canvas-fingerprinting") {
    assertStringVocabulary("canvas read API", detection.evidence.readApis, CANVAS_READ_APIS);
  } else if (detection.kind === "webgl-fingerprinting") {
    assertStringVocabulary("WebGL read API", detection.evidence.readApis, WEBGL_READ_APIS);
    assertStringVocabulary("WebGL parameter", detection.evidence.parameters, WEBGL_PARAMETERS);
  } else if (detection.kind === "audio-fingerprinting") {
    assertStringVocabulary("audio API", detection.evidence.apis, AUDIO_FINGERPRINT_APIS);
  } else if (detection.kind === "session-recording") {
    assertStringVocabulary("session event", detection.evidence.eventTypes, SESSION_RECORDING_EVENTS);
    assertStringVocabulary("listener target", detection.evidence.listenerTargets, LISTENER_TARGETS);
  } else if (detection.kind === "input-monitoring") {
    assertStringVocabulary("input event", detection.evidence.eventTypes, INPUT_MONITORING_EVENTS);
    assertStringVocabulary("listener target", detection.evidence.listenerTargets, LISTENER_TARGETS);
  } else if (detection.kind === "keystroke-exfiltration") {
    assertStringVocabulary("sentinel encoding", detection.evidence.encodings, KEYSTROKE_ENCODINGS);
  }
  const redacted = redactFingerprintDetection(detection, pass);
  if (redacted === null) throw new Error("Unknown fingerprint detection kind.");
  if (redacted.kind === "canvas-fingerprinting") {
    assertStringVocabulary("canvas read API", redacted.evidence.readApis, CANVAS_READ_APIS);
  } else if (redacted.kind === "webgl-fingerprinting") {
    assertStringVocabulary("WebGL read API", redacted.evidence.readApis, WEBGL_READ_APIS);
    assertStringVocabulary("WebGL parameter", redacted.evidence.parameters, WEBGL_PARAMETERS);
  } else if (redacted.kind === "audio-fingerprinting") {
    assertStringVocabulary("audio API", redacted.evidence.apis, AUDIO_FINGERPRINT_APIS);
  } else if (redacted.kind === "session-recording") {
    assertStringVocabulary("session event", redacted.evidence.eventTypes, SESSION_RECORDING_EVENTS);
    assertStringVocabulary("listener target", redacted.evidence.listenerTargets, LISTENER_TARGETS);
  } else if (redacted.kind === "input-monitoring") {
    assertStringVocabulary("input event", redacted.evidence.eventTypes, INPUT_MONITORING_EVENTS);
    assertStringVocabulary("listener target", redacted.evidence.listenerTargets, LISTENER_TARGETS);
  } else if (redacted.kind === "keystroke-exfiltration") {
    assertStringVocabulary("sentinel encoding", redacted.evidence.encodings, KEYSTROKE_ENCODINGS);
    const allowedFields = new Set<string>(KEYSTROKE_FIELD_TYPES);
    redacted.evidence.fieldTypes = [...new Set(redacted.evidence.fieldTypes.map((field) =>
      allowedFields.has(field) ? field : "other"
    ))].sort();
  }
  return redacted;
}

function assertStringVocabulary(label: string, values: string[], allowed: readonly string[]): void {
  const registry = new Set(allowed);
  for (const value of values) {
    if (!registry.has(value)) throw new Error(`Unknown ${label}: ${value}`);
  }
}

function sanitizeConsentFacts(
  source: ConsentFactsR2,
  mode: ConditionVector["consent"],
  pass: RedactionPass,
  qualityFacts: QualityFacts
): ConsentFactsR2 {
  if (mode === "observe") throw new Error("Observe mode cannot sanitize consent facts.");
  const interaction = redactConsentInteraction(
    {
      mode,
      clicked: source.controlActivated,
      ...(source.cmp === undefined ? {} : { cmp: source.cmp }),
      ...(source.selector === undefined ? {} : { selector: source.selector }),
      ...(source.matchedText === undefined ? {} : { matchedText: source.matchedText }),
      ...(source.frameUrl === undefined ? {} : { frameUrl: source.frameUrl })
    },
    pass
  );
  const verificationObservations = clipArray(
    source.verificationObservations,
    MAX_CONSENT_OBSERVATIONS,
    "consent-verification",
    "public-consent-observations",
    qualityFacts
  ).map((observation) => structuredClone(observation));

  return {
    interactionAttempted: source.interactionAttempted,
    controlActivated: source.controlActivated,
    verificationObservations,
    ...(source.bannerTransition === undefined
      ? {}
      : { bannerTransition: structuredClone(source.bannerTransition) }),
    ...(interaction.cmp === undefined ? {} : { cmp: interaction.cmp }),
    ...(interaction.selector === undefined ? {} : { selector: interaction.selector }),
    ...(interaction.matchedText === undefined ? {} : { matchedText: interaction.matchedText }),
    ...(interaction.frameUrl === undefined ? {} : { frameUrl: interaction.frameUrl })
  };
}

function clipArray<T>(
  values: readonly T[],
  limit: number,
  family: CaptureLossEntry["family"],
  detail: string,
  qualityFacts: QualityFacts
): T[] {
  if (values.length <= limit) return values.map((value) => structuredClone(value));
  assertVocabCode("capture-loss detail", detail);
  const omitted = values.length - limit;
  recordPublicCaptureLoss(family, detail, omitted, qualityFacts);
  return values.slice(0, limit).map((value) => structuredClone(value));
}

function recordPublicCaptureLoss(
  family: CaptureLossEntry["family"],
  detail: string,
  count: number,
  qualityFacts: QualityFacts
): void {
  assertVocabCode("capture-loss detail", detail);
  if (!qualityFacts.budgetsExhausted.includes(detail)) qualityFacts.budgetsExhausted.push(detail);
  qualityFacts.captureLoss.push({ family, phaseId: null, kind: "clipped", count, detail });
}

function assertVocabCode(label: string, value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(value)) {
    throw new Error(`${label} must use the closed scanner vocabulary.`);
  }
}

function resolveBuildCommit(env: NodeJS.ProcessEnv): string {
  const value = recordedBuildCommit(env);
  if (value === null) {
    throw new Error(`${BUILD_COMMIT_ENV} must identify a full 40-character Git commit; unknown provenance is rejected.`);
  }
  return value;
}

function currentNodeToolchain(engineLoaded: boolean): Toolchain {
  const trackerCatalog: Toolchain["trackerCatalog"] = {
    source: trackerCatalogMetadata.source,
    version: trackerCatalogMetadata.version,
    entries: trackerCatalogMetadata.entries,
    digest: trackerCatalogMetadata.digest
  };
  if (!engineLoaded) {
    return { trackerCatalog, adblock: null, normalizationVersion: NODE_SCAN_REPORT_V2_R2_NORMALIZATION_VERSION };
  }
  const meta = adblockListMeta();
  if (meta === null) {
    throw new Error("The adblock engine was reported loaded but its immutable list manifest is unavailable.");
  }
  return {
    trackerCatalog,
    adblock: { ...meta, engineVersion: NODE_ADBLOCK_ENGINE_VERSION },
    normalizationVersion: NODE_SCAN_REPORT_V2_R2_NORMALIZATION_VERSION
  };
}

/**
 * Exact current-identity gate, exported so producer wiring can health-check
 * before emission and tests can prove drift/"unknown" values fail closed.
 */
export function assertKnownNodeToolchainIdentity(toolchain: Toolchain): void {
  assertKnownText("tracker catalog source", toolchain.trackerCatalog.source);
  assertKnownText("tracker catalog version", toolchain.trackerCatalog.version);
  if (!SHA256.test(toolchain.trackerCatalog.digest)) throw new Error("Tracker catalog digest is not a SHA-256 identity.");
  const expectedCatalog = {
    source: trackerCatalogMetadata.source,
    version: trackerCatalogMetadata.version,
    entries: trackerCatalogMetadata.entries,
    digest: trackerCatalogMetadata.digest
  };
  if (canonicalJson(toolchain.trackerCatalog) !== canonicalJson(expectedCatalog)) {
    throw new Error("Tracker catalog identity does not match the current catalog snapshot.");
  }
  if (toolchain.normalizationVersion !== NODE_SCAN_REPORT_V2_R2_NORMALIZATION_VERSION) {
    throw new Error("Normalization identity does not match the current redaction-v2 policy.");
  }
  assertKnownText("normalization version", toolchain.normalizationVersion);

  if (toolchain.adblock === null) return;
  const meta = adblockListMeta();
  if (meta === null) throw new Error("Adblock manifest identity is unavailable.");
  assertAdblockIdentity(toolchain.adblock, meta);
}

function assertAdblockIdentity(adblock: NonNullable<Toolchain["adblock"]>, meta: AdblockListMeta): void {
  assertKnownText("adblock source", adblock.source);
  assertKnownText("adblock fetchedAt", adblock.fetchedAt);
  assertKnownText("adblock engine version", adblock.engineVersion);
  if (!SHA256.test(adblock.manifestDigest)) throw new Error("Adblock manifest digest is not a SHA-256 identity.");
  const expected = { ...meta, engineVersion: NODE_ADBLOCK_ENGINE_VERSION };
  if (canonicalJson(adblock) !== canonicalJson(expected)) {
    throw new Error("Adblock identity does not match the current list snapshot and engine version.");
  }
}

function assertKnownText(label: string, value: string): void {
  if (!value.trim() || value.trim().toLowerCase() === "unknown") throw new Error(`${label} is unknown.`);
}

function assertNodeConditions(conditions: ConditionVector): void {
  if (conditions.automation !== "playwright-chromium") {
    throw new Error("The Node r2 builder only accepts playwright-chromium measurements.");
  }
  assertBoundedInternalText("browser name", conditions.browser.name, 40);
  if (conditions.browser.name !== "chromium") throw new Error("The Node r2 browser name must be chromium.");
  assertBoundedInternalText("browser version", conditions.browser.version, 80);
  assertBoundedInternalText("locale", conditions.locale, 35, /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/);
  assertBoundedInternalText("language", conditions.language, 35, /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/);
  if (conditions.language !== conditions.locale) {
    throw new Error("The Node r2 language must derive from the configured locale.");
  }
  assertBoundedInternalText("timezone", conditions.timezone, 64, /^[A-Za-z0-9_+.-]+(?:\/[A-Za-z0-9_+.-]+)*$/);
  assertBoundedInternalText("egress label", conditions.egress.label, 120);
  if (conditions.egress.region !== undefined) assertBoundedInternalText("egress region", conditions.egress.region, 64);
  const viewport = conditions.device.viewport;
  if (
    !Number.isSafeInteger(viewport.width) ||
    !Number.isSafeInteger(viewport.height) ||
    viewport.width <= 0 ||
    viewport.height <= 0 ||
    viewport.width > 10_000 ||
    viewport.height > 10_000
  ) {
    throw new Error("Node r2 viewport dimensions are invalid.");
  }
  if ((conditions.device.kind === "mobile") !== viewport.isMobile) {
    throw new Error("Node r2 device kind disagrees with viewport.isMobile.");
  }
  if (!conditions.headless) throw new Error("The Node r2 producer requires a headless browser condition.");
}

function assertBoundedInternalText(label: string, value: string, maxChars: number, pattern?: RegExp): void {
  assertKnownText(label, value);
  if (Array.from(value).length > maxChars || /[\u0000-\u001f\u007f-\u009f]/.test(value)) {
    throw new Error(`${label} exceeds its producer-owned text envelope.`);
  }
  if (pattern && !pattern.test(value)) throw new Error(`${label} does not match its configured vocabulary.`);
}

function assertMeasurementRegistry(detectors: DetectorLedger): void {
  const actualIds = Object.keys(detectors).sort();
  const expectedIds = [...DETECTOR_IDS].sort();
  if (canonicalJson(actualIds) !== canonicalJson(expectedIds)) {
    throw new Error("Measurement detector ledger does not match the current detector registry.");
  }
  for (const id of DETECTOR_IDS) {
    if (detectors[id].version !== DETECTOR_VERSIONS[id]) {
      throw new Error(`Detector ${id} does not match registry ${DETECTOR_REGISTRY_VERSION}.`);
    }
    const reason = detectors[id].reason;
    if (reason !== undefined && !isDetectorReasonCode(reason)) {
      throw new Error(`Detector ${id} uses an unknown reason code.`);
    }
    if (detectors[id].status === "complete" && reason !== undefined) {
      throw new Error(`Complete detector ${id} cannot carry a reason code.`);
    }
    if (detectors[id].status !== "complete" && reason === undefined) {
      throw new Error(`${detectors[id].status} detector ${id} must carry a reason code.`);
    }
    if (reason !== undefined && !isDetectorReasonForStatus(detectors[id].status, reason)) {
      throw new Error(`Detector ${id} reason ${reason} is incompatible with status ${detectors[id].status}.`);
    }
  }
  if (!SHA256.test(DETECTOR_REGISTRY_DIGEST)) throw new Error("Detector registry digest is not a SHA-256 identity.");
}

function assertQualityVocabulary(facts: QualityFacts): void {
  if (facts.status !== null && (!Number.isInteger(facts.status) || facts.status < 100 || facts.status > 599)) {
    throw new Error("Node quality HTTP status must be null or an integer from 100 through 599.");
  }
  for (const budget of facts.budgetsExhausted) {
    if (budget.startsWith("public-")) throw new Error("Builder-owned public evidence budgets cannot be supplied by callers.");
    if (BUDGET_FAMILIES[budget] === undefined) throw new Error(`Unknown quality budget: ${budget}`);
  }
  for (const loss of facts.captureLoss) {
    if (loss.detail === undefined) continue;
    if (loss.detail.startsWith("public-")) throw new Error("Builder-owned public capture loss cannot be supplied by callers.");
    const family = BUDGET_FAMILIES[loss.detail];
    if (family === undefined || family !== loss.family) {
      throw new Error(`Capture-loss detail ${loss.detail} is not registered for ${loss.family}.`);
    }
  }
}

function assertSummaryInputs(summary: NodeScanReportV2R2Input["summary"], phases: PhaseSpan[]): void {
  if (phases.length === 0 || phases.length > MAX_PHASES) {
    throw new Error(`A Node r2 run must carry between 1 and ${MAX_PHASES} measurement phases.`);
  }
  if (!Number.isSafeInteger(summary.durationMs) || summary.durationMs < 0) {
    throw new Error("summary.durationMs must be a nonnegative integer.");
  }
  const lastPhaseEnd = Math.max(0, ...phases.map((phase) => phase.endedAtMs));
  if (summary.durationMs < lastPhaseEnd) {
    throw new Error("summary.durationMs cannot end before the final measurement phase.");
  }
}

function subjectKey(rawUrl: string, counters: RedactionCounters, label: string): SubjectKey {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`${label} is not a valid URL.`);
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.hostname) {
    throw new Error(`${label} must be an HTTP(S) URL with a hostname.`);
  }
  const registrableDomain = publicRegistrableDomain(parsed.hostname);
  if (registrableDomain === null) throw new Error(`${label} has no registrable domain.`);

  const redacted = redactUrlV2(rawUrl, { preserveQueryKeys: false });
  addRedactionCounters(counters, redacted.counters);
  const pathStart = redacted.value.indexOf("/", redacted.value.indexOf("//") + 2);
  if (pathStart < 0) throw new Error(`${label} could not be shaped by redaction v2.`);
  return {
    origin: redacted.value.slice(0, pathStart),
    registrableDomain,
    routeShape: redacted.value.slice(pathStart)
  };
}

function buildSummary(
  inputs: NodeScanReportV2R2Input["summary"],
  evidence: RunEvidenceR2,
  qualityFacts: QualityFacts,
  shieldsCondition: ConditionVector["shields"],
  shieldsFacts: ShieldsVerificationFactsR2 | undefined
): RunSummary {
  const thirdPartyRequests = evidence.requests.filter((request) => request.thirdParty);
  const byPhase = new Map<number, RunSummary["countsByPhase"][number]>();
  for (const request of evidence.requests) {
    const counts = byPhase.get(request.phaseId) ?? {
      phaseId: request.phaseId,
      totalRequests: 0,
      thirdPartyRequests: 0,
      knownTrackerRequests: 0
    };
    counts.totalRequests += 1;
    if (request.thirdParty) counts.thirdPartyRequests += 1;
    if (request.tracker !== null) counts.knownTrackerRequests += 1;
    byPhase.set(request.phaseId, counts);
  }

  const evidenceBlocked = evidence.requests.filter((request) => request.blockedByShields === true).length;
  const shieldsBlockedRequests =
    shieldsFacts !== undefined && shieldsFacts.engineLoaded
      ? shieldsCondition === "block-simulation"
        ? shieldsFacts.requestsActuallyBlocked
        : shieldsFacts.requestsMatched
      : evidenceBlocked > 0
        ? evidenceBlocked
        : undefined;

  return {
    pageTitle: boundedPageTitle(inputs.pageTitle),
    status: qualityFacts.status,
    durationMs: inputs.durationMs,
    counts: {
      totalRequests: evidence.requests.length,
      thirdPartyRequests: thirdPartyRequests.length,
      knownTrackerRequests: evidence.requests.filter((request) => request.tracker !== null).length,
      thirdPartyDomains: new Set(thirdPartyRequests.map((request) => request.domain)).size,
      cookies: evidence.cookiesFinal.length,
      thirdPartyCookies: evidence.cookiesFinal.filter((cookie) => cookie.thirdParty).length,
      storageEntries: evidence.storageFinal.length,
      fingerprintEvents: evidence.fingerprintEvents.reduce((total, event) => total + event.count, 0),
      ...(shieldsBlockedRequests !== undefined ? { shieldsBlockedRequests } : {})
    },
    countsByPhase: [...byPhase.values()].sort((left, right) => left.phaseId - right.phaseId)
  };
}

function consentEvidenceFromFacts(facts: ConsentFactsR2, run: ScanRunV2R2): ConsentEvidenceR2 {
  const mode = run.conditions.consent;
  if (mode === "observe") throw new Error("Internal consent-mode invariant failed.");
  const cloned = structuredClone(facts);
  const observations = cloned.verificationObservations.map((observation) => ({
    ...observation,
    consistentWithChoice: deriveObservationConsistency(mode, observation.observed)
  }));
  const consent: ConsentEvidenceR2 = {
    ...cloned,
    mode,
    verificationObservations: observations,
    choiceState: "unavailable",
    reverifiedAfterReload: false
  };
  const runWithConsent: ScanRunV2R2 = { ...run, evidence: { ...run.evidence, consent } };
  return {
    ...consent,
    choiceState: deriveChoiceStateR2(runWithConsent, consent),
    reverifiedAfterReload: deriveReverifiedAfterReloadR2(runWithConsent, consent)
  };
}

function boundedPageTitle(value: string): string {
  const normalized = value
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return Array.from(normalized).slice(0, MAX_PAGE_TITLE_CHARS).join("");
}
