import { publicReportDigest } from "./canonical-json";
import {
  INVALID_HOST_MARKER,
  INVALID_URL_MARKER,
  REDACTION_VERSION,
  redactPageTitle
} from "./redaction-v2";
import {
  RedactionPass,
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
import { FINGERPRINT_EVENT_APIS } from "./measurement-kernel";
import {
  R2ProducerContractError,
  assertR2ProducerContract
} from "./scan-report-v2-r2-producer-contract";
import {
  isReadableR2Normalization,
  migratedR2NormalizationForV3,
  MIGRATABLE_REDACTION_V3_NORMALIZATIONS,
  REDACTION_V3_TO_V4_NORMALIZATION_SUFFIX
} from "./scan-report-v2-normalization";
import { buildComparisonDiffV2 } from "./scan-report-v2-evaluators";
import {
  evaluateComparabilityR2,
  scanReportV2R2SemanticViolations
} from "./scan-report-v2-r2-evaluators";
import { buildFingerprints } from "./scan-report-v2-fingerprints";
import type {
  PublicScanReportV2R2,
  ScanRunV2R2
} from "./scan-report-v2-r2";
import type {
  Experiment,
  RunSummary,
  SubjectKey
} from "./scan-report-v2";
import type { FingerprintDetectionSummary } from "./types";

export const MIGRATABLE_REDACTION_VERSION = 3;

export type R2RedactionRemediationFailure =
  | "mixed-redaction-versions"
  | "unsupported-redaction-version"
  | "unreviewed-normalization-identity"
  | "unsafe-subject-identity"
  | "sanitizer-rejected-evidence"
  | "generated-report-inconsistent";

export class R2RedactionRemediationError extends Error {
  constructor(readonly reason: R2RedactionRemediationFailure, detail?: string) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = "R2RedactionRemediationError";
  }
}

/** Every embedded run, including supporting replication pairs. */
export function r2ReportRuns(report: PublicScanReportV2R2): ScanRunV2R2[] {
  if (report.reportType === "single") return [report.run];
  const runs = [report.baseline, report.variant];
  if (report.experiment.kind === "intervention") {
    for (const pair of report.experiment.supportingPairs ?? []) {
      runs.push(pair.baseline, pair.variant);
    }
  }
  return runs;
}

export function r2ReportRedactionVersion(report: PublicScanReportV2R2): number {
  const versions = new Set(r2ReportRuns(report).map((run) => run.privacy.redactionVersion));
  if (versions.size !== 1) throw new R2RedactionRemediationError("mixed-redaction-versions");
  return [...versions][0];
}

/**
 * Immutable identity carried across an in-place redaction migration. The
 * experiment metadata is included in full; only complete supporting-pair run
 * bodies are reduced to their stable run IDs and start clocks.
 */
export function r2ReportIdentityProjection(report: PublicScanReportV2R2): unknown {
  const run = (value: ScanRunV2R2) => ({ runId: value.runId, startedAt: value.startedAt });
  if (report.reportType === "single") {
    return {
      schemaVersion: report.schemaVersion,
      schemaRevision: report.schemaRevision,
      reportType: report.reportType,
      run: run(report.run),
      share: report.share
    };
  }

  let experiment: unknown;
  if (report.experiment.kind === "intervention") {
    const { supportingPairs, ...metadata } = report.experiment;
    experiment = {
      ...metadata,
      supportingPairs: (supportingPairs ?? []).map(({ baseline, variant, ...pairMetadata }) => ({
        ...pairMetadata,
        baseline: run(baseline),
        variant: run(variant)
      }))
    };
  } else {
    experiment = report.experiment;
  }
  return {
    schemaVersion: report.schemaVersion,
    schemaRevision: report.schemaRevision,
    reportType: report.reportType,
    baseline: run(report.baseline),
    variant: run(report.variant),
    experiment,
    share: report.share
  };
}

export function r2RemediationPreservesIdentity(
  expectedReportId: string,
  before: PublicScanReportV2R2,
  after: PublicScanReportV2R2
): boolean {
  return (
    publicReportDigest(r2ReportIdentityProjection(before)) ===
      publicReportDigest(r2ReportIdentityProjection(after)) &&
    (after.share?.id === undefined || after.share.id === expectedReportId)
  );
}

/**
 * Re-sanitize one structurally and semantically valid r2 report.
 *
 * V3 is accepted only with an exact reviewed producer normalization identity;
 * the caller separately proves its v3 provenance sidecar before invoking this
 * transform. Current v4 reports are accepted only at a known fresh-producer or
 * known v3-to-v4 migrated normalization fixed point. Unknown declarations are
 * never upgraded by shape or prefix matching.
 */
export function redactPublicScanReportV2R2(report: PublicScanReportV2R2): PublicScanReportV2R2 {
  const sourceVersion = r2ReportRedactionVersion(report);
  if (sourceVersion !== MIGRATABLE_REDACTION_VERSION && sourceVersion !== REDACTION_VERSION) {
    throw new R2RedactionRemediationError("unsupported-redaction-version", String(sourceVersion));
  }

  const output = structuredClone(report);
  for (const run of r2ReportRuns(output)) redactRun(run, sourceVersion);

  if (output.reportType === "comparison") {
    const experiment: Experiment =
      output.experiment.kind === "intervention"
        ? (({ supportingPairs: _supportingPairs, ...rest }) => rest)(output.experiment)
        : output.experiment;
    const comparability = evaluateComparabilityR2(
      experiment,
      output.baseline,
      output.variant,
      output.comparability.metricRegistryVersion as Parameters<typeof evaluateComparabilityR2>[3],
      output.comparability.evaluatorVersion as Parameters<typeof evaluateComparabilityR2>[4]
    );
    output.comparability = comparability;
    output.diff = buildComparisonDiffV2(output.baseline, output.variant, comparability.perMetric);
  }

  const violations = scanReportV2R2SemanticViolations(output);
  if (violations.length > 0) {
    throw new R2RedactionRemediationError("generated-report-inconsistent", violations.join("; "));
  }
  return output;
}

function redactRun(run: ScanRunV2R2, sourceVersion: number): void {
  // Classify an unknown producer normalization at the explicit migration
  // boundary before selecting the matching producer epoch. This keeps an
  // unreviewed self-declaration distinct from otherwise impossible evidence.
  const normalization =
    run.provenance.observer === "node-playwright" || run.provenance.observer === "pagegraph-import"
      ? normalizationAfterRedaction(run, sourceVersion)
      : undefined;
  try {
    assertR2ProducerContract(run);
  } catch (error) {
    if (error instanceof R2ProducerContractError) {
      throw new R2RedactionRemediationError("sanitizer-rejected-evidence", error.message);
    }
    throw error;
  }
  const pass = new RedactionPass();
  run.subject = {
    requested: redactSubjectKey(run.subject.requested, pass),
    observed: redactSubjectKey(run.subject.observed, pass)
  };

  run.evidence.requests = run.evidence.requests.map((request) => {
    const { phaseId, ...record } = request;
    return { ...redactRequest(record, pass), phaseId };
  });
  run.evidence.cookieMutations = run.evidence.cookieMutations.map((mutation) => ({
    ...mutation,
    cookie: redactCookie(mutation.cookie, pass)
  }));
  run.evidence.cookiesFinal = run.evidence.cookiesFinal.map((cookie) => redactCookie(cookie, pass));
  run.evidence.storageMutations = run.evidence.storageMutations.map((mutation) => ({
    ...mutation,
    entry: redactStorage(mutation.entry, pass)
  }));
  run.evidence.storageFinal = run.evidence.storageFinal.map((entry) => redactStorage(entry, pass));
  run.evidence.fingerprintEvents = run.evidence.fingerprintEvents.map((event) => {
    if (!(FINGERPRINT_EVENT_APIS as readonly string[]).includes(event.api)) {
      throw new R2RedactionRemediationError(
        "sanitizer-rejected-evidence",
        `unknown fingerprint event API: ${event.api}`
      );
    }
    return { ...event };
  });
  run.evidence.fingerprintDetections = run.evidence.fingerprintDetections.map((entry) => {
    const { phaseId, ...detection } = entry;
    const redacted = redactFingerprintDetection(detection, pass);
    if (redacted === null) {
      throw new R2RedactionRemediationError("sanitizer-rejected-evidence", `detection ${detection.kind}`);
    }
    return { ...redacted, phaseId } as FingerprintDetectionSummary & { phaseId: number };
  });
  run.evidence.cnameCloaks = run.evidence.cnameCloaks.map((cloak) => {
    const tracker = redactTrackerMatch(cloak.tracker, pass, cloak.cname);
    if (tracker === null) {
      throw new R2RedactionRemediationError(
        "sanitizer-rejected-evidence",
        "CNAME cloak has no catalog-grounded tracker match"
      );
    }
    return { host: pass.hostname(cloak.host), cname: pass.hostname(cloak.cname), tracker };
  });
  const retainedRequestHosts = new Set(run.evidence.requests.map((request) => request.domain));
  for (const cloak of run.evidence.cnameCloaks) {
    if (!retainedRequestHosts.has(cloak.host)) {
      throw new R2RedactionRemediationError(
        "sanitizer-rejected-evidence",
        "CNAME cloak is not grounded in retained request evidence"
      );
    }
  }
  run.evidence.pixelEvents = run.evidence.pixelEvents.flatMap((entry) => {
    const { phaseId, ...event } = entry;
    try {
      assertKnownPixelEventVocabulary(event);
      return redactPixelEvents([event]).map((redacted) => ({ ...redacted, phaseId }));
    } catch (error) {
      throw new R2RedactionRemediationError(
        "sanitizer-rejected-evidence",
        error instanceof Error ? error.message : "unknown pixel event vocabulary"
      );
    }
  });

  const retainedTrackerEntities = new Set<string>();
  for (const request of run.evidence.requests) {
    if (request.tracker !== null) retainedTrackerEntities.add(request.tracker.entity);
  }
  for (const cloak of run.evidence.cnameCloaks) retainedTrackerEntities.add(cloak.tracker.entity);
  if (run.evidence.privacyPolicy) {
    run.evidence.privacyPolicy = redactPrivacyPolicy(
      run.evidence.privacyPolicy,
      pass,
      retainedTrackerEntities
    );
  }
  if (run.evidence.consent !== undefined) {
    const consent = run.evidence.consent;
    const interaction = redactConsentInteraction(
      {
        mode: consent.mode,
        clicked: consent.controlActivated,
        ...(consent.cmp === undefined ? {} : { cmp: consent.cmp }),
        ...(consent.selector === undefined ? {} : { selector: consent.selector }),
        ...(consent.matchedText === undefined ? {} : { matchedText: consent.matchedText }),
        ...(consent.frameUrl === undefined ? {} : { frameUrl: consent.frameUrl })
      },
      pass
    );
    const { verificationFailureReason: _unsupportedFreeFormReason, ...derived } = consent;
    run.evidence.consent = {
      ...derived,
      ...(interaction.cmp === undefined ? {} : { cmp: interaction.cmp }),
      ...(interaction.selector === undefined ? {} : { selector: interaction.selector }),
      ...(interaction.matchedText === undefined ? {} : { matchedText: interaction.matchedText }),
      ...(interaction.frameUrl === undefined ? {} : { frameUrl: interaction.frameUrl })
    };
  }
  run.warnings = redactScannerWarnings(run.warnings, pass);

  run.toolchain = {
    ...run.toolchain,
    normalizationVersion: normalization ?? normalizationAfterRedaction(run, sourceVersion)
  };
  run.fingerprints = buildFingerprints({
    conditions: run.conditions,
    provenance: run.provenance,
    toolchain: run.toolchain,
    detectors: run.detectors
  });
  run.summary = rebuildSummary(run);

  const redaction = { ...run.privacy.redaction };
  for (const key of Object.keys(redaction) as Array<keyof typeof redaction>) {
    const next = redaction[key] + pass.counters[key];
    if (!Number.isSafeInteger(next) || next < 0) {
      throw new R2RedactionRemediationError("sanitizer-rejected-evidence", `redaction counter overflow: ${key}`);
    }
    redaction[key] = next;
  }
  run.privacy = { redactionVersion: REDACTION_VERSION, redaction };
}

function normalizationAfterRedaction(run: ScanRunV2R2, sourceVersion: number): string {
  const source = run.toolchain.normalizationVersion;
  if (sourceVersion === MIGRATABLE_REDACTION_VERSION) {
    const migrated = migratedR2NormalizationForV3(run.provenance.observer, source);
    if (migrated === null) {
      throw new R2RedactionRemediationError(
        "unreviewed-normalization-identity",
        `${run.provenance.observer}:${source}`
      );
    }
    return migrated;
  }

  const migrated = [...MIGRATABLE_REDACTION_V3_NORMALIZATIONS[run.provenance.observer]].map(
    (identity) => `${identity}+${REDACTION_V3_TO_V4_NORMALIZATION_SUFFIX}`
  );
  if (!isReadableR2Normalization(run.provenance.observer, source) && !migrated.includes(source)) {
    throw new R2RedactionRemediationError(
      "unreviewed-normalization-identity",
      `${run.provenance.observer}:${source}`
    );
  }
  return source;
}

function redactSubjectKey(subject: SubjectKey, pass: RedactionPass): SubjectKey {
  if (!subject.routeShape.startsWith("/")) {
    throw new R2RedactionRemediationError("unsafe-subject-identity", "route shape is not absolute");
  }
  const full = pass.url(`${subject.origin}${subject.routeShape}`, false);
  if (full === INVALID_URL_MARKER) {
    throw new R2RedactionRemediationError("unsafe-subject-identity", "origin has no public host boundary");
  }
  const pathStart = full.indexOf("/", full.indexOf("//") + 2);
  const registrableDomain = pass.hostname(subject.registrableDomain);
  if (pathStart < 0 || registrableDomain === INVALID_HOST_MARKER || registrableDomain !== subject.registrableDomain) {
    throw new R2RedactionRemediationError("unsafe-subject-identity", "registrable domain changed");
  }
  return {
    origin: full.slice(0, pathStart),
    registrableDomain,
    routeShape: full.slice(pathStart)
  };
}

function rebuildSummary(run: ScanRunV2R2): RunSummary {
  const thirdPartyRequests = run.evidence.requests.filter((request) => request.thirdParty);
  const byPhase = new Map<number, RunSummary["countsByPhase"][number]>();
  for (const request of run.evidence.requests) {
    const row = byPhase.get(request.phaseId) ?? {
      phaseId: request.phaseId,
      totalRequests: 0,
      thirdPartyRequests: 0,
      knownTrackerRequests: 0
    };
    row.totalRequests += 1;
    if (request.thirdParty) row.thirdPartyRequests += 1;
    if (request.tracker !== null) row.knownTrackerRequests += 1;
    byPhase.set(request.phaseId, row);
  }
  return {
    ...run.summary,
    pageTitle: redactPageTitle(run.summary.pageTitle),
    counts: {
      ...run.summary.counts,
      totalRequests: run.evidence.requests.length,
      thirdPartyRequests: thirdPartyRequests.length,
      knownTrackerRequests: run.evidence.requests.filter((request) => request.tracker !== null).length,
      thirdPartyDomains: new Set(thirdPartyRequests.map((request) => request.domain)).size,
      cookies: run.evidence.cookiesFinal.length,
      thirdPartyCookies: run.evidence.cookiesFinal.filter((cookie) => cookie.thirdParty).length,
      storageEntries: run.evidence.storageFinal.length,
      fingerprintEvents: run.evidence.fingerprintEvents.reduce((total, event) => total + event.count, 0)
    },
    countsByPhase: [...byPhase.values()].sort((left, right) => left.phaseId - right.phaseId)
  };
}
