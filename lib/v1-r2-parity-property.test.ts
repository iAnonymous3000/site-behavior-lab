import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { adblockListMeta } from "./adblock-engine";
import { ACTIVE_PROBE_SUBJECT_WARNING, CONSENT_RELOAD_SUBJECT_WARNING } from "./active-probe-subject-warnings";
import {
  PAGE_SUBJECT_CAPTURE_LOSS_DETAIL,
  PAGE_SUBJECT_UNVERIFIED_WARNING,
  SUSPECTED_CHALLENGE_OR_SOFT_BLOCK_WARNING
} from "./bot-wall-classifier";
import { CAPTURE_LOSS_DETAIL_CONTRACT } from "./capture-loss-detail-contract";
import { consentInteractionWarning, type ConsentProbeFailure } from "./consent-interaction";
import { CONSENT_INTERACTION_LEFT_SUBJECT_WARNING } from "./consent-subject-loss-warning";
import { CONSENT_RELOAD_DISCLOSURE } from "./consent-verification";
import { DETECTOR_OBLIGATION_REGISTRY } from "./detector-obligations";
import { GPC_WORKER_CAPTURE_LOSS_WARNING } from "./gpc-injection";
import { DETECTOR_VERSIONS, deriveCookieMutations, deriveStorageMutations } from "./measurement-kernel";
import { createNodeScanMeasurementEnvelope, type NodeScanMeasurement } from "./node-scan-measurement";
import {
  DEFAULT_PUBLIC_SCAN_PROXY_RESPONSE_BYTE_LIMIT,
  DEFAULT_PUBLIC_SCAN_PROXY_UPLOAD_BYTE_LIMIT
} from "./public-scan-proxy";
import { publicStringPolicyInputs, redactScanResultV1 } from "./redact-scan-report-v1";
import { buildReportFacts, REPORT_CLAIM_REQUIREMENTS, type ReportClaimId, type RunFacts } from "./report-facts";
import { buildScanConditions, buildScanResult } from "./scan-result-builder";
import {
  EVIDENCE_FAMILIES,
  type CaptureLossEntry,
  type DetectorId,
  type DetectorLedger,
  type DetectorStatus,
  type EvidenceFamily,
  type PhaseSpan
} from "./scan-report-v2";
import { toPublicScanReportR2 } from "./scan-report-v2-r2-projection";
import { buildRuntimeScanReportV2R2 } from "./scan-report-v2-runtime-builder";
import {
  familyCensoredOnRun,
  runInCorpusDistributionPopulation,
  viewFromV1Report,
  viewFromV2
} from "./scan-report-views";
import {
  aggregateByteBudgetWarning,
  AUXILIARY_PAGE_REQUESTS_BLOCKED_WARNING,
  FINGERPRINT_LISTENER_ATTRIBUTION_LOSS_WARNING,
  FINGERPRINT_OBSERVER_CAPTURE_LOSS_WARNING,
  FINGERPRINT_WORKER_REALM_CAPTURE_LOSS_WARNING,
  INVALID_UPSTREAM_RESPONSE_WARNING,
  KEYSTROKE_PROBE_INCOMPLETE_WARNING,
  KEYSTROKE_PROBE_NAVIGATION_STOPPED_WARNING,
  KEYSTROKE_PROBE_PAGE_LEFT_WARNING,
  KEYSTROKE_PROBE_REQUEST_UNREAD_WARNING,
  KEYSTROKE_PROBE_TEST_INCOMPLETE_WARNING,
  MAX_RECORDED_REQUESTS,
  PAGE_LEFT_SUBJECT_BEFORE_STATE_WARNING,
  PIXEL_DECODE_CAPTURE_LOSS_WARNING,
  UNSETTLED_ROUTED_REQUEST_WARNING
} from "./scan-runtime";
import { recordedDetails, stringConstants } from "./producer-loss-source";
import { assertProperty, seededRandom, withoutOne, type SeededRandom } from "./seeded-property";
import { findTrackerMatch } from "./tracker-catalog";
import type {
  CnameCloak,
  CookieRecord,
  FingerprintDetectionSummary,
  NetworkRequestRecord,
  PixelEventSummary,
  PrivacyPolicySummary,
  StorageRecord
} from "./types";

// ---------------------------------------------------------------------------
// v1/r2 parity as a property.
//
// One Node visit writes two wires: the frozen v1 result and the r2 report,
// through two sanitizers and read by two readers. The rule the project keeps
// re-breaking by hand is one-directional: for the same visit, the v1 view may
// never allow a claim, a corpus-population membership or a family's
// completeness that the r2 view withholds. v1 may be stricter, because it
// never recorded some evidence r2 has.
//
// The scanner writes both wires from one warning list, one loss ledger and one
// detector ledger (lib/scanner.ts, scanSiteWithMeasurement). This file models
// what each scanner branch writes to each: the r2 capture losses, budgets and
// detector outcome, and the v1 line (or lines) the same branch adds. The
// model is a restatement of the scanner and can drift from it, so each entry
// names the branch it copies, the browser tests in lib/scanner.test.ts pin
// the pairings they reach, and the coverage test below holds the model to
// every loss the scanner source records and every detector outcome it sets.
// Everything after the model is the real code: the v1 builder and sanitizer,
// the runtime r2 builder, the projection, both views and ReportFacts.
// ---------------------------------------------------------------------------

const BUILD_ENV = { SITE_BEHAVIOR_LAB_BUILD_COMMIT: "a".repeat(40) } as NodeJS.ProcessEnv;

const SEED = 20260928;
const ITERATIONS = 1500;

const SUBJECT_HOST = "www.parity-fixture.net";
const SUBJECT_URL = `https://${SUBJECT_HOST}/`;
const STARTED_AT = "2026-09-28T12:00:00.000Z";
const CHROMIUM_VERSION = "136.0.0.0";
const VIEWPORT = { width: 1440, height: 980, isMobile: false };

type Mode = "observe" | "accept-all" | "reject-all";

/**
 * Where the recorded subject went. Each value is one exclusive branch of the
 * scanner's subject handling; they decide most detector outcomes together, so
 * they are drawn first and the rest is drawn inside what they leave.
 */
const SUBJECTS = [
  // The page stayed on the recorded site throughout.
  "kept",
  // markPassiveStateSubjectLoss (observe) or markConsentInteractionSubjectLoss
  // (consent): the page left before its state was read.
  "left-before-state",
  // The consent click left the site (markConsentInteractionSubjectLoss).
  "consent-left",
  // The post-consent reload left the site (markPostConsentReloadSubjectLoss).
  "reload-left",
  // The page was off the site just before the input probe, with its state
  // already read: the probe's subject line and no family loss.
  "left-before-probe",
  // pageSubjectInvalid: an HTTP error, a classified interstitial, or an
  // unavailable subject read.
  "http-error",
  "soft-block",
  "unverified"
] as const;
type Subject = (typeof SUBJECTS)[number];

/** fingerprint-heuristics, from the coverage branches after the state read. */
const FINGERPRINT_OUTCOMES = [
  "complete",
  "frame-partial",
  "frame-failed",
  // No frame readable, but a worker realm read returned evidence.
  "frame-failed-worker-evidence",
  "listener",
  "worker",
  "frame-and-worker",
  "listener-and-worker",
  // Consent mode only: the passive read just before the click.
  "passive-worker",
  "passive-frame",
  "passive-listener",
  "passive-read-failed",
  "attribution-incomplete"
] as const;
type FingerprintOutcome = (typeof FINGERPRINT_OUTCOMES)[number];

/** keystroke-exfiltration, from probeKeystrokeExfiltration and its caller. */
const KEYSTROKE_OUTCOMES = [
  "complete",
  // No time to open the phase: keystrokeProbeScanWarnings(null, true).
  "no-time-before-phase",
  // Inside the probe, too little time left once started.
  "no-time-in-probe",
  // A capture bound (URL, body, request count) or an untested field.
  "cap-after-keystroke",
  "cap-before-keystroke",
  // A stopped navigation that may have carried the value, or an unreadable body.
  "failure-after-keystroke",
  "failure-before-keystroke",
  // The probe's own work threw.
  "probe-threw",
  // The scan deadline cancelled the probe (the caller's timeout branch).
  "deadline",
  // The caller caught a non-deadline throw.
  "caller-threw",
  // The page left the site during the probe, before or after a field kept the value.
  "page-left-before-typing",
  "page-left-after-typing"
] as const;
type KeystrokeOutcome = (typeof KEYSTROKE_OUTCOMES)[number];

const CNAME_OUTCOMES = ["complete", "omitted-candidates", "no-budget", "probe-failed"] as const;
type CnameOutcome = (typeof CNAME_OUTCOMES)[number];

const PIXEL_OUTCOMES = ["complete", "body-capped", "body-unreadable"] as const;
type PixelOutcome = (typeof PIXEL_OUTCOMES)[number];

/** consent-banner in observe mode: the one banner-visibility read. */
const OBSERVE_BANNER_OUTCOMES = ["complete", "unreadable", "not-calibration-usable", "no-budget"] as const;
/** consent-banner in a consent mode: the click and its failures. */
const CONSENT_BANNER_OUTCOMES = [
  "clicked",
  "no-budget-for-phase",
  // The phase began, then the search ran out of scan budget.
  "search-out-of-budget",
  "search-interrupted",
  "frames-unreadable",
  "dispatch-unconfirmed",
  "search-threw",
  "engine-unavailable"
] as const;
type BannerOutcome = (typeof OBSERVE_BANNER_OUTCOMES)[number] | (typeof CONSENT_BANNER_OUTCOMES)[number];

const POLICY_OUTCOMES = [
  "read",
  "read-with-truncated-candidates",
  "no-link",
  "visit-failed",
  "links-failed",
  "no-budget",
  "candidates-truncated"
] as const;
type PolicyOutcome = (typeof POLICY_OUTCOMES)[number];

/** Losses the scanner records independently of any detector outcome. */
const LOSS_EVENTS = [
  "auxiliary-page-request",
  "unsettled-routed-requests",
  "gpc-worker",
  "invalid-upstream-response",
  "request-cap",
  "response-byte-budget",
  "upload-byte-budget",
  "proxy-traffic-budget",
  "probe-stopped-navigation",
  "final-storage-truncated",
  "final-storage-failed",
  "page-title-truncated",
  // Consent mode only.
  "consent-settle-interrupted",
  "passive-cookies-failed",
  "passive-storage-failed",
  "passive-storage-truncated",
  "reload-cookies-failed",
  "reload-storage-failed",
  "reload-storage-truncated"
] as const;
type LossEvent = (typeof LOSS_EVENTS)[number];

/** Raw evidence both sanitizers see; some shapes make one of them drop a row. */
type EvidenceKnobs = {
  thirdPartyTracker: boolean;
  cookie: boolean;
  storage: boolean;
  fingerprintEvents: boolean;
  cnameCloak: boolean;
  pixelEvent: boolean;
  /** A listener detection naming a publishable origin, one naming a bare IP, or none. */
  listener: "none" | "publishable" | "unpublishable";
  /** A third-party request to an IP literal, its own party on both wires. */
  ipLiteralRequest: boolean;
  /** A request to a host that is itself a public suffix (a path-style S3 URL): no party boundary. */
  publicSuffixRequest: boolean;
  /** A subresource whose HTTP status the r2 schema cannot carry. */
  unrepresentableRequestStatus: boolean;
};

type Visit = {
  mode: Mode;
  /** Consent mode: whether the verification reload phase ran. */
  reload: boolean;
  subject: Subject;
  httpStatus: number;
  fingerprint: FingerprintOutcome;
  keystroke: KeystrokeOutcome;
  cname: CnameOutcome;
  pixel: PixelOutcome;
  banner: BannerOutcome;
  policy: PolicyOutcome;
  losses: LossEvent[];
  evidence: EvidenceKnobs;
  /** Fixed scanner lines added to both wires with no r2 fact beside them. */
  freeLines: string[];
};

const FIXED_WARNINGS: readonly string[] = publicStringPolicyInputs().fixedWarnings;
const PROXY_TRAFFIC_BUDGET_WARNING = onlyFixedWarning(/opening additional proxy requests/);
const REQUEST_CAP_WARNING = `The scan stopped recording or loading additional requests after ${MAX_RECORDED_REQUESTS} requests.`;

function onlyFixedWarning(pattern: RegExp): string {
  const matches = FIXED_WARNINGS.filter((warning) => pattern.test(warning));
  if (matches.length !== 1) throw new Error(`expected one fixed warning to match ${pattern}, found ${matches.length}`);
  return matches[0];
}

// ---------------------------------------------------------------------------
// Validity: which draws the scanner can reach together.
// ---------------------------------------------------------------------------

/** Outcomes of the passive read the consent modes take just before the click. */
const PASSIVE_BOUNDARY_FINGERPRINT = new Set<FingerprintOutcome>([
  "passive-worker",
  "passive-frame",
  "passive-listener",
  "passive-read-failed"
]);
const PASSIVE_BOUNDARY_LOSSES = new Set<LossEvent>([
  "passive-cookies-failed",
  "passive-storage-failed",
  "passive-storage-truncated"
]);
const RELOAD_LOSSES = new Set<LossEvent>(["reload-cookies-failed", "reload-storage-failed", "reload-storage-truncated"]);
const STATE_READ_LOSSES = new Set<LossEvent>(["final-storage-truncated", "final-storage-failed", "page-title-truncated"]);
const POLICY_VISIT_OUTCOMES = new Set<PolicyOutcome>(["read", "read-with-truncated-candidates", "visit-failed"]);

function subjectInvalid(visit: Visit): boolean {
  return visit.subject === "http-error" || visit.subject === "soft-block" || visit.subject === "unverified";
}

/** A consent mode reads the passive boundary on every valid subject, before its budget check. */
function passiveBoundaryRead(visit: Visit): boolean {
  return visit.mode !== "observe" && !subjectInvalid(visit);
}

/** Whether the consent interaction phase began (consent mode, valid subject, time left). */
function consentPhaseBegan(visit: Visit): boolean {
  return passiveBoundaryRead(visit) && visit.banner !== "no-budget-for-phase";
}

function clicked(visit: Visit): boolean {
  return consentPhaseBegan(visit) && visit.banner === "clicked";
}

/** The subject's state was read and committed (subjectStateTrusted). */
function stateRead(visit: Visit): boolean {
  return visit.subject !== "left-before-state" && visit.subject !== "consent-left";
}

function reloadRan(visit: Visit): boolean {
  return visit.reload && clicked(visit) && stateRead(visit);
}

/** The input probe opened its phase. */
function probePhaseOpened(visit: Visit): boolean {
  return (
    !subjectInvalid(visit) &&
    stateRead(visit) &&
    visit.subject !== "reload-left" &&
    visit.subject !== "left-before-probe" &&
    visit.keystroke !== "no-time-before-phase"
  );
}

function policyVisited(visit: Visit): boolean {
  return !subjectInvalid(visit) && stateRead(visit) && POLICY_VISIT_OUTCOMES.has(visit.policy);
}

/**
 * Coerce a draw into one the scanner can reach. Generation draws each
 * dimension freely and then applies this; the shrinker applies it after every
 * step, so a smaller counterexample is always a reachable visit too.
 */
function normalizeVisit(input: Visit): Visit {
  const visit: Visit = structuredClone(input);
  const banners: readonly string[] = visit.mode === "observe" ? OBSERVE_BANNER_OUTCOMES : CONSENT_BANNER_OUTCOMES;
  if (!banners.includes(visit.banner)) visit.banner = visit.mode === "observe" ? "complete" : "clicked";
  if (subjectInvalid(visit)) {
    // A failed load reads no passive boundary, begins no interaction, opens
    // no probe and visits no policy; the subject branch decides all four.
    visit.httpStatus = visit.subject === "http-error" ? (visit.httpStatus >= 400 ? visit.httpStatus : 503) : 200;
    if (visit.mode === "observe") visit.banner = "complete";
    else visit.banner = "clicked";
    visit.keystroke = "complete";
    visit.policy = "read";
  } else {
    visit.httpStatus = 200;
  }
  // Once the consent phase began, a page off the site before or during the
  // state read is the consent interaction's loss, clicked or not; before it,
  // the passive-state loss.
  if (consentPhaseBegan(visit)) {
    if (visit.subject === "left-before-state") visit.subject = "consent-left";
  } else if (visit.subject === "consent-left") {
    visit.subject = "left-before-state";
  }
  if (visit.subject === "reload-left") visit.reload = true;
  if (!reloadRan(visit)) {
    visit.reload = false;
    if (visit.subject === "reload-left") visit.subject = "kept";
  }
  if (!passiveBoundaryRead(visit) && PASSIVE_BOUNDARY_FINGERPRINT.has(visit.fingerprint)) visit.fingerprint = "complete";
  if (visit.fingerprint === "attribution-incomplete" && !(consentPhaseBegan(visit) && stateRead(visit))) {
    visit.fingerprint = "complete";
  }
  if (!stateRead(visit) && !PASSIVE_BOUNDARY_FINGERPRINT.has(visit.fingerprint)) visit.fingerprint = "complete";
  if (!stateRead(visit)) visit.policy = "read";
  if (!probePhaseOpened(visit) && visit.keystroke !== "no-time-before-phase") visit.keystroke = "complete";
  visit.losses = [...new Set(visit.losses)].filter((loss) => {
    if (PASSIVE_BOUNDARY_LOSSES.has(loss)) return passiveBoundaryRead(visit);
    if (RELOAD_LOSSES.has(loss)) return reloadRan(visit) && visit.subject !== "reload-left";
    if (STATE_READ_LOSSES.has(loss)) return stateRead(visit);
    if (loss === "consent-settle-interrupted") return clicked(visit);
    if (loss === "probe-stopped-navigation") return probePhaseOpened(visit);
    return true;
  });
  visit.freeLines = [...new Set(visit.freeLines)];
  return visit;
}

function generateVisit(random: SeededRandom): Visit {
  const rare = <T>(values: readonly T[], common: T, p: number): T => (random.chance(p) ? random.pick(values) : common);
  return normalizeVisit({
    mode: random.pick(["observe", "observe", "accept-all", "reject-all"] as const),
    reload: random.chance(0.5),
    subject: rare(SUBJECTS, "kept", 0.35),
    httpStatus: random.pick([403, 404, 500, 503, 999]),
    fingerprint: rare(FINGERPRINT_OUTCOMES, "complete", 0.45),
    keystroke: rare(KEYSTROKE_OUTCOMES, "complete", 0.45),
    cname: rare(CNAME_OUTCOMES, "complete", 0.35),
    pixel: rare(PIXEL_OUTCOMES, "complete", 0.3),
    banner: random.pick([...OBSERVE_BANNER_OUTCOMES, ...CONSENT_BANNER_OUTCOMES]),
    policy: rare(POLICY_OUTCOMES, "read", 0.5),
    losses: random.subset(LOSS_EVENTS, 0.08),
    evidence: {
      thirdPartyTracker: random.chance(0.8),
      cookie: random.chance(0.6),
      storage: random.chance(0.6),
      fingerprintEvents: random.chance(0.6),
      cnameCloak: random.chance(0.3),
      pixelEvent: random.chance(0.3),
      listener: random.pick(["none", "none", "publishable", "unpublishable"] as const),
      ipLiteralRequest: random.chance(0.1),
      publicSuffixRequest: random.chance(0.1),
      unrepresentableRequestStatus: random.chance(0.1)
    },
    freeLines: random.subset(FIXED_WARNINGS, 0.02)
  });
}

// ---------------------------------------------------------------------------
// The scanner model: one visit's two wires.
// ---------------------------------------------------------------------------

type Draft = {
  phases: PhaseSpan[];
  passive: number;
  consent: number | null;
  reload: number | null;
  probe: number | null;
  policy: number | null;
  /** The phase of the state read: the consent phase when one began (stateSnapshotPhaseId). */
  snapshot: number;
  losses: CaptureLossEntry[];
  budgets: Set<string>;
  detectors: DetectorLedger;
  lines: string[];
};

function line(draft: Draft, warning: string): void {
  if (!draft.lines.includes(warning)) draft.lines.push(warning);
}

function loss(
  draft: Draft,
  family: EvidenceFamily,
  phaseId: number | null,
  kind: CaptureLossEntry["kind"],
  detail?: string,
  count = 1
): void {
  draft.losses.push({ family, phaseId, kind, count, ...(detail !== undefined ? { detail } : {}) });
}

/** MeasurementKernel.exhaustBudget: the budget name and a cap loss under it. */
function budget(draft: Draft, name: string): void {
  if (draft.budgets.has(name)) return;
  draft.budgets.add(name);
  loss(draft, "requests", null, "cap", name);
}

function detector(
  draft: Draft,
  id: DetectorId,
  status: DetectorStatus,
  reason?: string,
  phaseId?: number | null
): void {
  draft.detectors[id] = {
    version: DETECTOR_VERSIONS[id],
    status,
    ...(reason !== undefined ? { reason } : {}),
    ...(phaseId !== undefined && phaseId !== null ? { phaseId } : {})
  };
}

function phasePlan(visit: Visit): Pick<Draft, "phases" | "passive" | "consent" | "reload" | "probe" | "policy" | "snapshot"> {
  const phases: PhaseSpan[] = [];
  const open = (kind: PhaseSpan["kind"]): number => {
    const phaseId = phases.length;
    phases.push({ phaseId, kind, startedAtMs: phaseId * 1000, endedAtMs: phaseId * 1000 + 1000 });
    return phaseId;
  };
  const passive = open("passive-load");
  const consent = consentPhaseBegan(visit) ? open("consent-interaction") : null;
  const reload = reloadRan(visit) ? open("post-choice-reload") : null;
  const probe = probePhaseOpened(visit) ? open("active-probe") : null;
  const policy = policyVisited(visit) ? open("policy-analysis") : null;
  return { phases, passive, consent, reload, probe, policy, snapshot: consent ?? passive };
}

/** The consent-mode banner outcome's failure, as applyConsentChoice's caller names it. */
function consentFailure(banner: BannerOutcome): ConsentProbeFailure | null {
  switch (banner) {
    case "no-budget-for-phase":
    case "search-out-of-budget":
      return "budget-unavailable";
    case "search-interrupted":
      return "search-interrupted";
    case "frames-unreadable":
      return "frames-unreadable";
    case "dispatch-unconfirmed":
      return "dispatch-unconfirmed";
    case "search-threw":
      return "scan-failed";
    case "engine-unavailable":
      return "engine-unavailable";
    default:
      return null;
  }
}

/** Apply every scanner branch the visit takes, in scanner order. */
function scannerDraft(visit: Visit): Draft {
  const draft: Draft = {
    ...phasePlan(visit),
    losses: [],
    budgets: new Set(),
    detectors: Object.fromEntries(
      Object.keys(DETECTOR_VERSIONS).map((id) => [id, { version: DETECTOR_VERSIONS[id as DetectorId], status: "complete" }])
    ) as DetectorLedger,
    lines: []
  };
  const { passive, snapshot } = draft;
  const invalid = subjectInvalid(visit);
  const consentMode = visit.mode !== "observe";

  // Auxiliary windows and probe-stopped navigations are recorded by the routes
  // as they arrive (context.route and page.route in scanSiteWithMeasurement).
  if (visit.losses.includes("auxiliary-page-request")) {
    loss(draft, "requests", passive, "dropped");
    line(draft, AUXILIARY_PAGE_REQUESTS_BLOCKED_WARNING);
  }
  if (visit.losses.includes("probe-stopped-navigation") && draft.probe !== null) {
    loss(draft, "requests", draft.probe, "dropped");
    line(draft, KEYSTROKE_PROBE_NAVIGATION_STOPPED_WARNING);
  }

  // The page-subject classification (pageSubjectState).
  if (visit.subject === "unverified") {
    loss(draft, "detector-output", passive, "dropped", PAGE_SUBJECT_CAPTURE_LOSS_DETAIL);
  }
  if (visit.subject === "http-error") {
    line(draft, `The page returned HTTP ${visit.httpStatus}; this report reflects an error or block page, not a normal load.`);
  }
  if (visit.subject === "soft-block") line(draft, SUSPECTED_CHALLENGE_OR_SOFT_BLOCK_WARNING);
  if (visit.subject === "unverified") line(draft, PAGE_SUBJECT_UNVERIFIED_WARNING);

  // markConsentInteractionSubjectLoss, markPassiveStateSubjectLoss and the
  // consent coverage losses they record.
  const consentCoverageLoss = (phaseId: number | null, kind: "cap" | "dropped", verification: boolean) => {
    const already = (family: EvidenceFamily) =>
      draft.losses.some(
        (entry) =>
          entry.family === family &&
          entry.phaseId === phaseId &&
          entry.kind === kind &&
          (entry.detail === "consent-banner" || entry.detail === "consent-verification")
      );
    if (!already("detector-output")) loss(draft, "detector-output", phaseId, kind, "consent-banner");
    if (verification && !already("consent-verification")) {
      loss(draft, "consent-verification", phaseId, kind, "consent-verification");
    }
  };

  // The consent-mode passive boundary, read just before the click.
  let passiveFingerprintRead = passiveBoundaryRead(visit);
  if (passiveBoundaryRead(visit)) {
    // A read that timed out means the scan deadline passed, so the consent
    // phase never began; only a read that threw reaches this branch.
    if (visit.losses.includes("passive-cookies-failed")) loss(draft, "cookies", passive, "dropped", "cookie-snapshot");
    if (visit.losses.includes("passive-storage-truncated")) loss(draft, "storage", passive, "truncated", "storage-snapshot");
    if (visit.losses.includes("passive-storage-failed")) loss(draft, "storage", passive, "dropped", "storage-snapshot");
    if (visit.fingerprint === "passive-read-failed") {
      loss(draft, "fingerprinting", passive, "dropped", "fingerprint-observer");
      passiveFingerprintRead = false;
    } else if (
      visit.fingerprint === "passive-frame" ||
      visit.fingerprint === "passive-listener" ||
      visit.fingerprint === "passive-worker"
    ) {
      loss(draft, "fingerprinting", passive, "dropped", "fingerprint-observer");
      passiveFingerprintRead = false;
    }
  }

  // The consent interaction and the consent-banner detector.
  if (visit.subject === "consent-left" && draft.consent !== null) {
    line(draft, CONSENT_INTERACTION_LEFT_SUBJECT_WARNING);
    for (const family of ["requests", "cookies", "storage", "fingerprinting"] as const) {
      loss(draft, family, draft.consent, "dropped");
    }
    consentCoverageLoss(draft.consent, "dropped", true);
  }
  if (visit.losses.includes("consent-settle-interrupted") && draft.consent !== null) {
    for (const family of ["requests", "cookies", "storage"] as const) loss(draft, family, draft.consent, "dropped");
  }
  if (draft.consent !== null) {
    const failure = consentFailure(visit.banner);
    if (visit.subject === "consent-left") {
      detector(draft, "consent-banner", "partial", "load-failed", draft.consent);
      consentCoverageLoss(draft.consent, "dropped", true);
    } else if (failure === "budget-unavailable") {
      detector(draft, "consent-banner", "partial", "budget-unavailable", draft.consent);
      consentCoverageLoss(draft.consent, "cap", true);
    } else if (failure === "search-interrupted") {
      detector(draft, "consent-banner", "partial", "load-failed", draft.consent);
      consentCoverageLoss(draft.consent, "dropped", true);
    } else if (failure === "frames-unreadable" || failure === "dispatch-unconfirmed") {
      detector(draft, "consent-banner", "partial", "scan-failed", draft.consent);
      consentCoverageLoss(draft.consent, "dropped", true);
    } else if (failure === "scan-failed") {
      detector(draft, "consent-banner", "failed", "scan-failed", draft.consent);
      consentCoverageLoss(draft.consent, "dropped", true);
    } else if (failure === "engine-unavailable") {
      detector(draft, "consent-banner", "failed", "engine-unavailable", draft.consent);
      consentCoverageLoss(draft.consent, "dropped", true);
    } else {
      detector(draft, "consent-banner", "complete", undefined, draft.consent);
    }
  } else if (invalid && consentMode) {
    detector(draft, "consent-banner", "skipped", "load-failed");
    consentCoverageLoss(null, "dropped", true);
  } else if (consentMode) {
    detector(draft, "consent-banner", "skipped", "budget-unavailable");
    consentCoverageLoss(null, "cap", true);
  } else if (!invalid) {
    // Observe mode with the verification flag on: one banner-visibility read.
    if (visit.banner === "unreadable") {
      detector(draft, "consent-banner", "failed", "engine-unavailable", passive);
      consentCoverageLoss(passive, "dropped", false);
    } else if (visit.banner === "not-calibration-usable") {
      detector(draft, "consent-banner", "partial", "scan-failed", passive);
      consentCoverageLoss(passive, "dropped", false);
    } else if (visit.banner === "no-budget") {
      detector(draft, "consent-banner", "skipped", "budget-unavailable", passive);
      consentCoverageLoss(passive, "cap", false);
    } else {
      detector(draft, "consent-banner", "complete", undefined, passive);
    }
  } else {
    detector(draft, "consent-banner", "skipped", "load-failed");
    consentCoverageLoss(null, "dropped", false);
  }
  if (consentMode && !invalid) {
    line(draft, consentInteractionWarning(consentSummary(visit), clicked(visit) ? null : consentFailure(visit.banner) ?? "budget-unavailable"));
  }

  // The state read, and the subject loss it can find at its end.
  if (visit.subject === "left-before-state") {
    line(draft, ACTIVE_PROBE_SUBJECT_WARNING);
    line(draft, PAGE_LEFT_SUBJECT_BEFORE_STATE_WARNING);
    for (const family of ["requests", "cookies", "storage", "fingerprinting"] as const) {
      loss(draft, family, passive, "dropped");
    }
  }

  // The fingerprint observer's coverage (after the state read). With the
  // state unread, the scan stands in the passive read, counted as one
  // attempted frame only when that read was complete.
  const state = stateRead(visit);
  const frameFailed = visit.fingerprint === "frame-failed" || visit.fingerprint === "frame-failed-worker-evidence";
  const finalFrame = visit.fingerprint === "frame-partial" || frameFailed || visit.fingerprint === "frame-and-worker";
  const finalListener = visit.fingerprint === "listener" || visit.fingerprint === "listener-and-worker";
  const finalWorker = visit.fingerprint === "worker" || visit.fingerprint === "frame-and-worker" || visit.fingerprint === "listener-and-worker";
  const frameCoverageComplete = state ? !finalFrame : passiveFingerprintRead;
  if (!frameCoverageComplete) line(draft, FINGERPRINT_OBSERVER_CAPTURE_LOSS_WARNING);
  else if (state && finalListener) line(draft, FINGERPRINT_LISTENER_ATTRIBUTION_LOSS_WARNING);
  if ((state && finalWorker) || visit.fingerprint === "passive-worker") line(draft, FINGERPRINT_WORKER_REALM_CAPTURE_LOSS_WARNING);
  if (state) {
    if (visit.losses.includes("page-title-truncated")) loss(draft, "detector-output", snapshot, "truncated", "page-title");
    if (visit.fingerprint === "attribution-incomplete") loss(draft, "fingerprinting", snapshot, "dropped", "fingerprint-observer");
    if (finalFrame || finalListener || finalWorker) loss(draft, "fingerprinting", snapshot, "dropped", "fingerprint-observer");
    if (visit.losses.includes("final-storage-failed")) loss(draft, "storage", snapshot, "dropped", "storage-snapshot");
    else if (visit.losses.includes("final-storage-truncated")) loss(draft, "storage", snapshot, "truncated", "storage-snapshot");
    if (frameFailed) {
      detector(draft, "fingerprint-heuristics", "failed", "engine-unavailable", snapshot);
    } else if (
      finalFrame ||
      finalListener ||
      finalWorker ||
      visit.fingerprint === "attribution-incomplete" ||
      (draft.consent !== null && !passiveFingerprintRead)
    ) {
      detector(draft, "fingerprint-heuristics", "partial", "scan-failed", snapshot);
    } else {
      detector(draft, "fingerprint-heuristics", "complete", undefined, snapshot);
    }
  } else {
    loss(draft, "fingerprinting", snapshot, "dropped", "fingerprint-observer");
    detector(draft, "fingerprint-heuristics", passiveFingerprintRead ? "partial" : "failed", "load-failed", snapshot);
  }

  // The post-consent verification reload.
  if (draft.reload !== null) {
    line(draft, CONSENT_RELOAD_DISCLOSURE);
    if (visit.subject === "reload-left") {
      line(draft, CONSENT_RELOAD_SUBJECT_WARNING);
      loss(draft, "consent-verification", draft.reload, "dropped");
    } else {
      if (visit.losses.includes("reload-cookies-failed")) loss(draft, "cookies", draft.reload, "dropped", "cookie-snapshot");
      if (visit.losses.includes("reload-storage-failed")) loss(draft, "storage", draft.reload, "dropped", "storage-snapshot");
      else if (visit.losses.includes("reload-storage-truncated")) loss(draft, "storage", draft.reload, "truncated", "storage-snapshot");
    }
  }

  // The active input probe.
  applyKeystroke(draft, visit);

  // Routed requests still in flight at the last boundary.
  if (visit.losses.includes("unsettled-routed-requests")) {
    line(draft, UNSETTLED_ROUTED_REQUEST_WARNING);
    loss(draft, "requests", null, "dropped");
  }

  // Pixel bodies.
  if (visit.pixel !== "complete") {
    loss(draft, "detector-output", passive, visit.pixel === "body-capped" ? "truncated" : "dropped", "pixel-decode");
    line(draft, PIXEL_DECODE_CAPTURE_LOSS_WARNING);
    detector(draft, "pixel-events", "partial", visit.pixel === "body-capped" ? "evidence-cap-reached" : "scan-failed", snapshot);
  } else {
    detector(draft, "pixel-events", "complete", undefined, snapshot);
  }

  // CNAME uncloaking.
  if (visit.cname === "omitted-candidates" || visit.cname === "probe-failed") {
    loss(draft, "detector-output", snapshot, "cap", "cname-lookups");
  }
  if (visit.cname === "no-budget") {
    detector(draft, "cname-uncloaking", "skipped", "budget-unavailable", snapshot);
    loss(draft, "detector-output", snapshot, "cap", "cname-lookups");
  } else if (visit.cname === "probe-failed") {
    detector(draft, "cname-uncloaking", "failed", "scan-failed", snapshot);
    loss(draft, "detector-output", snapshot, "dropped", "cname-lookups");
  } else if (visit.cname === "omitted-candidates") {
    detector(draft, "cname-uncloaking", "partial", "evidence-cap-reached", snapshot);
  } else {
    detector(draft, "cname-uncloaking", "complete", undefined, snapshot);
  }
  if (cnameCloaks(visit).length > 0) {
    line(
      draft,
      "Resolved 1 first-party subdomain that is a CNAME alias for a third-party tracker (CNAME cloaking), which request-URL matching alone would miss."
    );
  }

  // The privacy-policy visit.
  applyPolicy(draft, visit);

  // Request-quality producers frozen at the evidence boundary.
  if (visit.losses.includes("gpc-worker")) {
    line(draft, GPC_WORKER_CAPTURE_LOSS_WARNING);
    loss(draft, "requests", null, "dropped");
  }
  if (visit.losses.includes("invalid-upstream-response")) {
    line(draft, INVALID_UPSTREAM_RESPONSE_WARNING);
    loss(draft, "requests", null, "dropped");
  }
  if (visit.losses.includes("proxy-traffic-budget")) line(draft, PROXY_TRAFFIC_BUDGET_WARNING);
  if (visit.losses.includes("response-byte-budget")) {
    line(draft, aggregateByteBudgetWarning("response", DEFAULT_PUBLIC_SCAN_PROXY_RESPONSE_BYTE_LIMIT));
  }
  if (visit.losses.includes("upload-byte-budget")) {
    line(draft, aggregateByteBudgetWarning("upload", DEFAULT_PUBLIC_SCAN_PROXY_UPLOAD_BYTE_LIMIT));
  }
  if (visit.losses.includes("request-cap")) {
    line(draft, REQUEST_CAP_WARNING);
    budget(draft, "request-capture");
  }
  if (visit.losses.includes("proxy-traffic-budget")) budget(draft, "proxy-traffic");
  if (visit.losses.includes("response-byte-budget")) budget(draft, "response-bytes");
  if (visit.losses.includes("upload-byte-budget")) budget(draft, "request-upload");

  for (const warning of visit.freeLines) line(draft, warning);
  return draft;
}

function applyKeystroke(draft: Draft, visit: Visit): void {
  const probe = draft.probe;
  const recordProbeLoss = (phaseId: number | null, kind: "cap" | "dropped") =>
    loss(draft, "detector-output", phaseId, kind, "keystroke-probe");
  if (probe === null) {
    // keystrokePhaseId === null: the subject was unavailable, or no time.
    const subjectAvailable = !subjectInvalid(visit) && stateRead(visit) && visit.subject !== "reload-left" && visit.subject !== "left-before-probe";
    if (visit.subject === "left-before-probe") line(draft, ACTIVE_PROBE_SUBJECT_WARNING);
    if (subjectAvailable) line(draft, KEYSTROKE_PROBE_TEST_INCOMPLETE_WARNING);
    detector(draft, "keystroke-exfiltration", "skipped", subjectAvailable ? "budget-unavailable" : "load-failed");
    recordProbeLoss(null, subjectAvailable ? "cap" : "dropped");
    return;
  }
  const typedDisclosure = (retained: boolean) =>
    line(
      draft,
      `This scan typed a synthetic test value into 1 form field with native form submission blocked. Focus, input and blur handlers may run and send requests. The value is synthetic and is not stored. ${
        retained
          ? "Observed requests during typing and the following wait are included in the request log. Teardown-only transmissions are not measured."
          : "Requests from this incomplete probe were omitted from the recorded request log and counts."
      }`
    );
  const pageLeft = () => {
    line(draft, ACTIVE_PROBE_SUBJECT_WARNING);
    loss(draft, "requests", probe, "dropped");
    loss(draft, "fingerprinting", probe, "dropped");
    line(draft, KEYSTROKE_PROBE_PAGE_LEFT_WARNING);
  };
  switch (visit.keystroke) {
    case "complete":
      typedDisclosure(true);
      detector(draft, "keystroke-exfiltration", "complete", undefined, probe);
      return;
    case "no-time-before-phase":
      throw new Error("a probe phase cannot open without time for it");
    case "no-time-in-probe":
      line(draft, KEYSTROKE_PROBE_TEST_INCOMPLETE_WARNING);
      detector(draft, "keystroke-exfiltration", "partial", "budget-unavailable", probe);
      recordProbeLoss(probe, "dropped");
      return;
    case "cap-after-keystroke":
    case "cap-before-keystroke":
      typedDisclosure(true);
      line(draft, visit.keystroke === "cap-after-keystroke" ? KEYSTROKE_PROBE_REQUEST_UNREAD_WARNING : KEYSTROKE_PROBE_TEST_INCOMPLETE_WARNING);
      loss(draft, "detector-output", probe, "truncated", "keystroke-probe-capture");
      detector(draft, "keystroke-exfiltration", "partial", "evidence-cap-reached", probe);
      return;
    case "failure-after-keystroke":
    case "failure-before-keystroke":
      typedDisclosure(true);
      line(draft, visit.keystroke === "failure-after-keystroke" ? KEYSTROKE_PROBE_REQUEST_UNREAD_WARNING : KEYSTROKE_PROBE_TEST_INCOMPLETE_WARNING);
      detector(draft, "keystroke-exfiltration", "partial", "scan-failed", probe);
      recordProbeLoss(probe, "dropped");
      return;
    case "probe-threw":
      typedDisclosure(true);
      line(draft, KEYSTROKE_PROBE_TEST_INCOMPLETE_WARNING);
      detector(draft, "keystroke-exfiltration", "failed", "scan-failed", probe);
      recordProbeLoss(probe, "dropped");
      return;
    case "deadline":
    case "caller-threw":
      typedDisclosure(true);
      line(draft, KEYSTROKE_PROBE_INCOMPLETE_WARNING);
      loss(draft, "requests", probe, visit.keystroke === "deadline" ? "timeout" : "dropped");
      if (visit.keystroke === "deadline") detector(draft, "keystroke-exfiltration", "partial", "budget-unavailable", probe);
      else detector(draft, "keystroke-exfiltration", "failed", "scan-failed", probe);
      recordProbeLoss(probe, "dropped");
      return;
    case "page-left-before-typing":
      pageLeft();
      detector(draft, "keystroke-exfiltration", "skipped", "load-failed", probe);
      recordProbeLoss(probe, "dropped");
      return;
    case "page-left-after-typing":
      typedDisclosure(false);
      pageLeft();
      detector(draft, "keystroke-exfiltration", "partial", "load-failed", probe);
      recordProbeLoss(probe, "dropped");
      return;
  }
}

function applyPolicy(draft: Draft, visit: Visit): void {
  const policyLoss = (kind: "cap" | "dropped", phaseId: number | null) =>
    loss(draft, "detector-output", phaseId, kind, "policy-visit");
  if (visit.policy === "read-with-truncated-candidates" || (visit.policy === "candidates-truncated" && !subjectInvalid(visit))) {
    if (stateRead(visit)) loss(draft, "detector-output", draft.policy, "truncated", "policy-link-candidates");
  }
  if (draft.policy !== null) {
    if (visit.policy === "visit-failed") {
      detector(draft, "privacy-policy", "failed", "load-failed", draft.policy);
      policyLoss("dropped", draft.policy);
    } else {
      detector(draft, "privacy-policy", "complete", undefined, draft.policy);
    }
  } else if (!stateRead(visit)) {
    detector(draft, "privacy-policy", "skipped", "load-failed");
    policyLoss("dropped", null);
  } else if (visit.subject === "http-error" || visit.subject === "soft-block") {
    detector(draft, "privacy-policy", "skipped", "load-failed");
  } else if (visit.subject === "unverified") {
    detector(draft, "privacy-policy", "skipped", "load-failed");
    policyLoss("dropped", null);
  } else if (visit.policy === "links-failed") {
    detector(draft, "privacy-policy", "failed", "scan-failed");
    policyLoss("dropped", null);
  } else if (visit.policy === "no-budget") {
    detector(draft, "privacy-policy", "skipped", "budget-unavailable");
    policyLoss("cap", null);
  } else if (visit.policy === "candidates-truncated") {
    detector(draft, "privacy-policy", "skipped", "evidence-cap-reached");
  } else {
    detector(draft, "privacy-policy", "unsupported", "unsupported");
  }
}

function consentSummary(visit: Visit) {
  const mode = visit.mode === "observe" ? "accept-all" : visit.mode;
  return clicked(visit)
    ? { mode, clicked: true, cmp: "OneTrust", selector: "#onetrust-accept-btn-handler" }
    : { mode, clicked: false };
}

// ---------------------------------------------------------------------------
// Raw evidence, handed to both sanitizers exactly as the scanner hands it.
// ---------------------------------------------------------------------------

type RawRequest = NetworkRequestRecord & { phaseId: number };

function rawRequests(visit: Visit, draft: Draft): RawRequest[] {
  const requests: RawRequest[] = [
    {
      id: 1,
      url: SUBJECT_URL,
      domain: SUBJECT_HOST,
      method: "GET",
      resourceType: "document",
      status: visit.httpStatus,
      thirdParty: false,
      tracker: null,
      blockedByShields: false,
      startedAtMs: 10,
      phaseId: draft.passive
    }
  ];
  const add = (url: string, overrides: Partial<RawRequest> = {}) => {
    const host = new URL(url).hostname;
    requests.push({
      id: requests.length + 1,
      url,
      domain: host,
      method: "GET",
      resourceType: "script",
      status: 200,
      thirdParty: true,
      tracker: findTrackerMatch(host),
      blockedByShields: false,
      startedAtMs: 20 + requests.length,
      phaseId: draft.passive,
      ...overrides
    });
  };
  if (visit.evidence.thirdPartyTracker) add("https://www.google-analytics.com/analytics.js");
  if (visit.evidence.pixelEvent) add("https://www.facebook.com/tr?id=1&ev=PageView", { resourceType: "image" });
  if (cnameCloaks(visit).length > 0) {
    add(`https://metrics.parity-fixture.net/collect`, { thirdParty: false, tracker: null });
  }
  if (visit.evidence.ipLiteralRequest) add("http://203.0.113.9/pixel.gif", { resourceType: "image", tracker: null });
  if (visit.evidence.publicSuffixRequest) add("https://s3.amazonaws.com/parity-assets/app.js", { tracker: null });
  if (visit.evidence.unrepresentableRequestStatus) add("https://cdn.parity-fixture.net/app.js", { thirdParty: false, tracker: null, status: 999 });
  return requests;
}

function cnameCloaks(visit: Visit): CnameCloak[] {
  if (!visit.evidence.cnameCloak || !stateRead(visit) || visit.cname === "no-budget") return [];
  return [
    {
      host: "metrics.parity-fixture.net",
      cname: "parity-fixture.sc.omtrdc.net",
      tracker: {
        domain: "omtrdc.net",
        entity: "omtrdc.net",
        category: "tracking (Brave Shields list)",
        confidence: "shields-list"
      }
    }
  ];
}

function pixelEvents(visit: Visit): PixelEventSummary[] {
  if (!visit.evidence.pixelEvent) return [];
  return [{ platform: "Meta", product: "Meta Pixel", events: ["PageView"], advancedMatching: [], requests: 1 }];
}

function fingerprintDetections(visit: Visit): FingerprintDetectionSummary[] {
  // Listener coverage is read from frames only; a worker realm registers no listeners.
  if (visit.evidence.listener === "none" || !stateRead(visit) || visit.fingerprint.startsWith("frame-failed")) return [];
  return [
    {
      kind: "session-recording",
      heuristic: "interaction-listener-coverage-v1",
      count: 3,
      evidence: {
        eventTypes: ["click", "mousemove"],
        listenerTargets: ["document"],
        thirdPartyOrigins: [
          visit.evidence.listener === "publishable" ? "https://rec.hotjar-fixture.com" : "http://203.0.113.7"
        ],
        totalListenerCalls: 3
      }
    }
  ];
}

function privacyPolicy(visit: Visit): PrivacyPolicySummary | undefined {
  const policy = visit.policy;
  if (!policyVisited(visit) || (policy !== "read" && policy !== "read-with-truncated-candidates")) return undefined;
  return {
    url: `${SUBJECT_URL}privacy`,
    claims: [],
    mentionedEntities: [],
    unmentionedEntities: [],
    policyTextLength: 4000
  };
}

type Wires = {
  v1: RunFacts;
  r2: RunFacts;
  v1Population: boolean;
  r2Population: boolean;
  v1Censored: Record<EvidenceFamily, boolean>;
  r2Censored: Record<EvidenceFamily, boolean>;
  lines: string[];
};

/** Build both wires of one visit through the real builders, sanitizers and readers. */
function buildWires(visit: Visit): Wires {
  const draft = scannerDraft(visit);
  const requests = rawRequests(visit, draft);
  const state = stateRead(visit);
  const cookies: CookieRecord[] =
    visit.evidence.cookie && state
      ? [{ name: "_ga", domain: ".parity-fixture.net", path: "/", sameSite: "Lax", secure: true, httpOnly: false, session: false, thirdParty: false }]
      : [];
  const storageFailed = visit.losses.includes("final-storage-failed") && state;
  const storageRecords: StorageRecord[] = visit.evidence.storage && state && !storageFailed
    ? [{ area: "localStorage", key: "_ga_session", valueBytes: 24 }]
    : [];
  const fingerprintEvents =
    (visit.evidence.fingerprintEvents && state && visit.fingerprint !== "frame-failed") ||
    visit.fingerprint === "frame-failed-worker-evidence"
      ? [{ api: "canvas.toDataURL", count: 2 }]
      : [];
  const detections = fingerprintDetections(visit);
  const cloaks = cnameCloaks(visit);
  const pixels = pixelEvents(visit);
  const policy = privacyPolicy(visit);
  const consentMode = visit.mode !== "observe";
  const adblock = adblockListMeta();
  assert.ok(adblock, "the committed Brave list manifest must be readable");

  const v1 = buildScanResult({
    pageTitle: "Parity fixture",
    status: visit.httpStatus,
    durationMs: draft.phases.length * 1000,
    firstPartyDomain: SUBJECT_HOST,
    conditions: buildScanConditions({
      profile: "node-playwright",
      requestedUrl: SUBJECT_URL,
      finalUrl: SUBJECT_URL,
      scannedAt: STARTED_AT,
      chromiumVersion: CHROMIUM_VERSION,
      viewport: VIEWPORT,
      gpcEnabled: false,
      consentMode: visit.mode,
      headless: true,
      shieldsMode: "classification",
      adblock: { active: true, source: adblock.source, lists: adblock.lists, fetchedAt: adblock.fetchedAt }
    }),
    requests: requests.map(({ phaseId: _phaseId, ...request }) => request),
    cookies,
    storage: storageRecords,
    fingerprintDetections: detections,
    fingerprintEvents,
    cnameCloaks: cloaks,
    pixelEvents: pixels,
    privacyPolicy: policy,
    ...(consentMode && !subjectInvalid(visit) ? { consentInteraction: consentSummary(visit) } : {}),
    screenshot: null,
    warnings: [...draft.lines],
    shieldsBlockedRequests: 0
  });

  const cookieSnapshots = cookies.length > 0 ? [{ phaseId: draft.snapshot, records: cookies }] : [];
  const storageSnapshots = storageRecords.length > 0 ? [{ phaseId: draft.snapshot, records: storageRecords }] : [];
  const measurement: NodeScanMeasurement = {
    measurement: {
      phases: draft.phases,
      detectors: draft.detectors,
      qualityFacts: {
        status: visit.httpStatus,
        botWallTitleMatched: visit.subject === "soft-block",
        navigationSettled: true,
        budgetsExhausted: [...draft.budgets].sort(),
        captureLoss: draft.losses
      }
    },
    evidence: {
      requests,
      cookieMutations: deriveCookieMutations(cookieSnapshots),
      cookiesFinal: cookies,
      storageMutations: storageFailed ? [] : deriveStorageMutations(storageSnapshots),
      storageFinal: storageRecords,
      fingerprintEvents: fingerprintEvents.map((event) => ({ ...event, phaseId: draft.snapshot })),
      fingerprintDetections: detections.map((detection) => ({ ...detection, phaseId: draft.snapshot })),
      cnameCloaks: cloaks,
      pixelEvents: pixels.map((event) => ({ ...event, phaseId: draft.passive })),
      ...(policy !== undefined ? { privacyPolicy: policy } : {})
    },
    ...(consentMode ? { consent: consentFacts(visit, draft) } : {}),
    verificationFacts: {
      gpc: {
        method: "gpc-header-readback@1",
        header: "confirmed-absent",
        jsSignal: "confirmed-absent",
        observedOn: "first-party-navigation",
        phaseId: draft.passive
      },
      shields: {
        method: "shields-engine-status@1",
        engineLoaded: true,
        applied: false,
        requestsEvaluated: requests.length,
        requestsMatched: 0,
        requestsActuallyBlocked: 0,
        phaseId: draft.passive
      }
    },
    emissionInputs: {
      startedAt: STARTED_AT,
      requestedUrl: SUBJECT_URL,
      observedUrl: SUBJECT_URL,
      conditions: {
        gpc: false,
        shields: "classification",
        consent: visit.mode,
        device: { kind: "desktop", viewport: VIEWPORT },
        probes: { keystroke: true, policyVisit: true },
        locale: "en-US",
        language: "en-US",
        timezone: "UTC",
        egress: { label: v1.conditions.scannerEgress },
        browser: { name: "chromium", version: CHROMIUM_VERSION },
        headless: true,
        automation: "playwright-chromium"
      },
      adblockEngineLoaded: true,
      pageTitle: "Parity fixture",
      durationMs: draft.phases.length * 1000,
      warnings: [...draft.lines],
      screenshot: null
    }
  };

  const r2Report = toPublicScanReportR2(
    buildRuntimeScanReportV2R2(createNodeScanMeasurementEnvelope(v1, measurement), "public-api", BUILD_ENV)
  );
  const r2View = viewFromV2(r2Report, 2);
  // The stored v1 report is re-sanitized at the store, as the scanner tests read it.
  const v1View = viewFromV1Report(redactScanResultV1(v1).report);
  const r2Run = r2View.runs[0];
  const v1Run = v1View.runs[0];
  const censored = (run: typeof r2Run) =>
    Object.fromEntries(EVIDENCE_FAMILIES.map((family) => [family, familyCensoredOnRun(run, family)])) as Record<
      EvidenceFamily,
      boolean
    >;
  return {
    v1: buildReportFacts(v1View).display,
    r2: buildReportFacts(r2View).display,
    v1Population: runInCorpusDistributionPopulation(v1Run),
    r2Population: runInCorpusDistributionPopulation(r2Run),
    v1Censored: censored(v1Run),
    r2Censored: censored(r2Run),
    lines: draft.lines
  };
}

function consentFacts(visit: Visit, draft: Draft): NonNullable<NodeScanMeasurement["consent"]> {
  if (draft.consent === null) {
    return { interactionAttempted: false, controlActivated: false, verificationObservations: [] };
  }
  const observed = visit.mode === "accept-all" ? ("accepted-all" as const) : ("rejected-all" as const);
  const leftAtClick = visit.subject === "consent-left";
  const observations: NonNullable<NodeScanMeasurement["consent"]>["verificationObservations"] = [];
  const moments: NonNullable<NonNullable<NodeScanMeasurement["consent"]>["bannerTransition"]>["observations"] = [
    { moment: "before-interaction", phaseId: draft.consent, atMs: draft.consent * 1000 + 100, visible: true }
  ];
  if (clicked(visit) && !leftAtClick) {
    observations.push({ phaseId: draft.consent, method: "onetrust-cookie@1", observed, result: { outcome: "read", sequence: 0 } });
    moments.push({ moment: "after-interaction", phaseId: draft.consent, atMs: draft.consent * 1000 + 900, visible: false });
    if (draft.reload !== null && visit.subject !== "reload-left") {
      observations.push({ phaseId: draft.reload, method: "onetrust-cookie@1", observed, result: { outcome: "read", sequence: 1 } });
      moments.push({ moment: "after-reload", phaseId: draft.reload, atMs: draft.reload * 1000 + 500, visible: false });
    }
  }
  return {
    interactionAttempted: true,
    controlActivated: clicked(visit),
    verificationObservations: observations,
    bannerTransition: { method: "banner-visibility@1", observations: moments },
    ...(clicked(visit) ? { cmp: "OneTrust", selector: "#onetrust-accept-btn-handler" } : {})
  };
}

// ---------------------------------------------------------------------------
// The property, and the divergences the codebase documents as deliberate.
// ---------------------------------------------------------------------------

type Violation = { kind: "claim" | "benchmark" | "population" | "family"; subject: string };

function violationsOf(wires: Wires): Violation[] {
  const violations: Violation[] = [];
  for (const claim of Object.keys(REPORT_CLAIM_REQUIREMENTS) as ReportClaimId[]) {
    if (!wires.r2.claims[claim].allowed && wires.v1.claims[claim].allowed) violations.push({ kind: "claim", subject: claim });
    if (!wires.r2.claims[claim].benchmarkAllowed && wires.v1.claims[claim].benchmarkAllowed) {
      violations.push({ kind: "benchmark", subject: claim });
    }
  }
  if (!wires.r2Population && wires.v1Population) violations.push({ kind: "population", subject: "corpus-distribution" });
  for (const family of EVIDENCE_FAMILIES) {
    if (wires.r2Censored[family] && !wires.v1Censored[family]) violations.push({ kind: "family", subject: family });
  }
  return violations;
}

const REQUEST_FAMILY_CLAIMS = new Set<string>(
  (Object.keys(REPORT_CLAIM_REQUIREMENTS) as ReportClaimId[]).filter((claim) =>
    (REPORT_CLAIM_REQUIREMENTS[claim].families as readonly string[]).includes("requests")
  )
);
const FINGERPRINT_SUBJECTS = new Set(["fingerprint-apis", "session-recording-input-monitoring", "fingerprinting"]);

type AllowedDivergence = {
  name: string;
  /**
   * Where the codebase records the divergence as deliberate, or, for a
   * `todo` entry, the open finding it waits on.
   */
  record: string;
  /**
   * An entry nothing in the codebase documents yet. It is a finding held open
   * so the suite stays green, not a decision: fixing the divergence, or
   * recording it as deliberate, must remove the `todo` (the hit check below
   * fails once the divergence is gone).
   */
  todo?: true;
  covers(visit: Visit, violation: Violation): boolean;
};

/**
 * Every allowed divergence, named and scoped to the drawn cause and the
 * claims, families or population it moves, never to a whole claim or family.
 */
const ALLOWED_DIVERGENCES: readonly AllowedDivergence[] = [
  {
    name: "listener-withheld-censors-keystroke-on-r2",
    record:
      "docs/comprehensive-review-2026-09-22.md, section 4, 'Still divergent': the listener-withheld drop is r2 " +
      "over-censoring and is left (and the keystroke-exfiltration note in REPORT_CLAIM_REQUIREMENTS)",
    covers: (visit, violation) =>
      visit.evidence.listener === "unpublishable" &&
      (violation.kind === "claim" || violation.kind === "benchmark") &&
      violation.subject === "keystroke-exfiltration"
  },
  {
    name: "consent-passive-fingerprint-boundary",
    record:
      "docs/limitations.md, fingerprinting paragraph: a frame or worker realm the read just before the click could " +
      "not cover withholds the r2 fingerprint evidence, while the v1 report, which has no phases, keeps it",
    covers: (visit, violation) =>
      (visit.fingerprint === "passive-frame" || visit.fingerprint === "passive-read-failed") &&
      violation.kind !== "population" &&
      FINGERPRINT_SUBJECTS.has(violation.subject)
  },
  {
    name: "v1-detector-output-and-consent-verification-are-claim-scoped",
    record:
      "docs/comprehensive-review-2026-09-22.md, section 4, the 2026-09-25 updates: v1 reads the detector-output and " +
      "consent-verification families as complete where r2 censors them, no v1 surface renders detector-output, and " +
      "v1 carries those losses to each claim through REPORT_CLAIM_REQUIREMENTS legacyReasons instead",
    covers: (_visit, violation) =>
      violation.kind === "family" &&
      (violation.subject === "detector-output" || violation.subject === "consent-verification")
  },
  // TODO(v1-r2-parity finding P1): a final storage read that failed or was
  // truncated. r2 records a storage-snapshot loss; v1 publishes the empty or
  // cut list with no line, so its storage-keys claim stands and is
  // benchmarked. Closing it needs a new admitted v1 line (an identity change).
  {
    name: "final-storage-read-lost-has-no-v1-line",
    record: "finding P1 (property test, 2026-09-28): scanSiteWithMeasurement, the finalStorage branch",
    todo: true,
    covers: (visit, violation) =>
      (visit.losses.includes("final-storage-failed") || visit.losses.includes("final-storage-truncated")) &&
      violation.subject.startsWith("storage")
  },
  // TODO(v1-r2-parity finding P2): an interrupted post-click settle. r2
  // records dropped request, cookie and storage losses at the consent phase;
  // v1 has no line. The settle wait rejects only when the page or context
  // closes, so a published report may not reach it.
  {
    name: "consent-settle-interrupted-has-no-v1-line",
    record: "finding P2 (property test, 2026-09-28): scanSiteWithMeasurement, consentProbe.settleInterrupted",
    todo: true,
    covers: (visit, violation) =>
      visit.losses.includes("consent-settle-interrupted") &&
      (violation.kind === "population" ||
        REQUEST_FAMILY_CLAIMS.has(violation.subject) ||
        ["requests", "cookies", "storage", "third-party-cookies", "storage-keys"].includes(violation.subject))
  },
  // TODO(v1-r2-parity finding P3): a consent-banner detector that did not
  // complete (the observe-mode visibility read, a consent search that failed
  // or ran out of budget, a reload that left the site). r2 withholds the
  // consent-banner claim, which the calm headline requires; v1 has no
  // detector ledger and no line its readers map, so it allows the claim.
  {
    name: "consent-banner-detector-incomplete-has-no-v1-channel",
    record: "finding P3 (property test, 2026-09-28): the consent-banner branches of scanSiteWithMeasurement",
    todo: true,
    covers: (visit, violation) =>
      violation.kind === "claim" &&
      violation.subject === "consent-banner" &&
      ((visit.banner !== "complete" && visit.banner !== "clicked") || visit.subject === "reload-left")
  },
  // TODO(v1-r2-parity finding P4): a policy read after a truncated link
  // search. r2 scopes the policy-link-candidates loss to the privacy-policy
  // claim; v1 publishes the policy summary and allows the claim.
  {
    name: "policy-candidates-truncated-has-no-v1-channel",
    record: "finding P4 (property test, 2026-09-28): scanSiteWithMeasurement, policyLinksTruncated",
    todo: true,
    covers: (visit, violation) =>
      visit.policy === "read-with-truncated-candidates" && violation.kind === "claim" && violation.subject === "privacy-policy"
  },
  // TODO(v1-r2-parity finding P5): CNAME candidates left unresolved at the
  // lookup bound on a visit that found a cloak. r2 ends the detector partial
  // and withholds the claim; v1 records the cloak and allows it.
  {
    name: "cname-omitted-candidates-has-no-v1-channel",
    record: "finding P5 (property test, 2026-09-28): scanSiteWithMeasurement, cnameResolution.omittedCandidateCount",
    todo: true,
    covers: (visit, violation) =>
      visit.cname === "omitted-candidates" && violation.kind === "claim" && violation.subject === "cname-cloaking"
  },
  // TODO(v1-r2-parity finding P6): a cookie or storage snapshot lost at the
  // passive boundary or the verification reload of a consent visit. The loss
  // is of r2's phase attribution: v1 publishes only the final snapshot, which
  // was read, yet r2 censors the whole family. Either r2 over-censors or v1
  // needs a line; nothing records which.
  {
    name: "consent-phase-snapshot-loss-is-r2-only",
    record: "finding P6 (property test, 2026-09-28): the passive-boundary and reload snapshot branches",
    todo: true,
    covers: (visit, violation) =>
      visit.losses.some((loss) => loss.startsWith("passive-") || loss.startsWith("reload-")) &&
      ["cookies", "storage", "third-party-cookies", "storage-keys", "privacy-policy"].includes(violation.subject)
  },
  // TODO(v1-r2-parity finding P7): fingerprint summaries that changed across
  // the click but cannot be differenced. r2 censors the later portion; v1
  // keeps the cumulative read. The same shape as the documented passive
  // boundary above, but the limitations page does not name this cause.
  {
    name: "consent-fingerprint-attribution-is-r2-only",
    record: "finding P7 (property test, 2026-09-28): scanSiteWithMeasurement, fingerprintAttribution.attributionIncomplete",
    todo: true,
    covers: (visit, violation) =>
      visit.fingerprint === "attribution-incomplete" && violation.kind !== "population" && FINGERPRINT_SUBJECTS.has(violation.subject)
  },
  // TODO(v1-r2-parity finding P10): listener attribution lost at the read
  // just before the click (the passive boundary's
  // listenerAttributionLostFrames). r2 withholds the visit's fingerprint
  // evidence as for a frame or worker realm that read could not cover; v1
  // keeps it with no line. The limitations page names frames, dedicated
  // workers and shared workers for that withholding, not listener
  // attribution, so this cause is not the documented passive boundary above.
  {
    name: "consent-passive-listener-attribution-is-r2-only",
    record: "finding P10 (property test review, 2026-09-28): scanSiteWithMeasurement, the passive boundary's listenerAttributionLostFrames",
    todo: true,
    covers: (visit, violation) =>
      visit.fingerprint === "passive-listener" && violation.kind !== "population" && FINGERPRINT_SUBJECTS.has(violation.subject)
  },
  // TODO(v1-r2-parity finding P8): an HTTP status the r2 schema cannot carry
  // (600 or more). r2 keeps the row and records a requests-family loss for
  // the status alone, which censors every request claim and the corpus
  // population; v1 keeps the row and the family.
  {
    name: "unrepresentable-http-status-is-r2-only",
    record: "finding P8 (property test, 2026-09-28): normalizeNodeR2HttpStatuses in lib/scan-result-v2-r2-builder.ts",
    todo: true,
    covers: (visit, violation) =>
      (visit.evidence.unrepresentableRequestStatus || (visit.subject === "http-error" && visit.httpStatus > 599)) &&
      (violation.kind === "population" || violation.subject === "requests" || REQUEST_FAMILY_CLAIMS.has(violation.subject))
  },
  // TODO(v1-r2-parity finding P9): a request to a host that is itself a
  // public suffix (a path-style S3 URL such as s3.amazonaws.com/bucket/app.js).
  // r2 drops the row and records a requests-family loss, which censors every
  // request claim and the corpus population; v1 keeps the row with its host
  // redacted and allows them.
  {
    name: "public-suffix-request-host-is-r2-only",
    record: "finding P9 (property test, 2026-09-28): sanitizeEvidence, public-request-unregistrable-hosts",
    todo: true,
    covers: (visit, violation) =>
      visit.evidence.publicSuffixRequest &&
      (violation.kind === "population" || violation.subject === "requests" || REQUEST_FAMILY_CLAIMS.has(violation.subject))
  }
];

/**
 * Visits the scanner can produce that the r2 builder refuses outright, so the
 * public scan fails instead of publishing. Each is a finding held open like a
 * `todo` divergence above, and each must still be reached (the hit check).
 */
type KnownRefusal = { name: string; record: string; covers(visit: Visit, clause: string): boolean };

const KNOWN_BUILDER_REFUSALS: readonly KnownRefusal[] = [
  // TODO(v1-r2-parity finding R2): a consent search that threw or read no
  // frame after the interaction phase began. The scanner records the
  // detector failed with interactionAttempted true; the r2 consent evaluator
  // requires activity (complete or partial) once an attempt is claimed.
  {
    name: "consent-search-failed-after-the-phase-began",
    record: "finding R2 (property test, 2026-09-28): scan-report-v2-r2-evaluators.ts consent activity rule",
    covers: (visit, clause) =>
      (visit.banner === "search-threw" || visit.banner === "engine-unavailable") &&
      consentPhaseBegan(visit) &&
      visit.subject !== "consent-left" &&
      clause.includes("consent evidence present but the consent-banner detector did not report activity")
  },
  // TODO(v1-r2-parity finding R3): a CNAME probe where one host's lookup
  // failed and another resolved to a cloak. The scanner ends the detector
  // failed and keeps the cloak; the r2 evaluator refuses findings from a
  // detector that did not report activity.
  {
    name: "cname-lookup-failure-beside-a-found-cloak",
    record: "finding R3 (property test, 2026-09-28): resolveCnameCloaks keeps cloaks after onResolutionFailure",
    covers: (visit, clause) =>
      visit.cname === "probe-failed" &&
      visit.evidence.cnameCloak &&
      clause.includes("evidence contains CNAME findings but the cname-uncloaking detector did not report activity")
  },
  // TODO(v1-r2-parity finding R4): no frame readable but a worker realm read
  // returned evidence. The scanner ends the detector failed and publishes
  // the worker's events; the r2 evaluator refuses them.
  {
    name: "unreadable-frames-beside-worker-evidence",
    record: "finding R4 (property test, 2026-09-28): collectFingerprintObservationsWithCoverage merges worker realms",
    covers: (visit, clause) =>
      visit.fingerprint === "frame-failed-worker-evidence" &&
      clause.includes("evidence contains fingerprint observations but the fingerprint-heuristics detector did not report activity")
  }
];

/** The refusal each clause of a builder error matches, or null when any clause is unknown. */
function knownRefusals(visit: Visit, message: string): KnownRefusal[] | null {
  const clauses = message.replace(/^Refusing to build an inconsistent ScanReport v2\/r2: /, "").split("; ");
  const matched: KnownRefusal[] = [];
  for (const clause of clauses) {
    const refusal = KNOWN_BUILDER_REFUSALS.find((candidate) => candidate.covers(visit, clause));
    if (!refusal) return null;
    matched.push(refusal);
  }
  return matched;
}

function uncovered(visit: Visit, violations: readonly Violation[], hits?: Map<string, number>): Violation[] {
  return violations.filter((violation) => {
    const divergence = ALLOWED_DIVERGENCES.find((candidate) => candidate.covers(visit, violation));
    if (divergence && hits) hits.set(divergence.name, (hits.get(divergence.name) ?? 0) + 1);
    return divergence === undefined;
  });
}

type ParityOutcome =
  | { kind: "held" }
  | { kind: "refused"; refusals: KnownRefusal[] }
  | { kind: "failed"; message: string };

/** One visit through both wires; `hits` counts the allowed divergences it used. */
function parityOf(visit: Visit, hits?: Map<string, number>, withheld?: Map<string, number>): ParityOutcome {
  let wires: Wires;
  try {
    wires = buildWires(visit);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const refusals = knownRefusals(visit, message);
    return refusals === null ? { kind: "failed", message: `the build threw: ${message}` } : { kind: "refused", refusals };
  }
  if (withheld) {
    for (const claim of Object.keys(REPORT_CLAIM_REQUIREMENTS) as ReportClaimId[]) {
      if (!wires.r2.claims[claim].allowed) withheld.set(claim, (withheld.get(claim) ?? 0) + 1);
    }
  }
  const left = uncovered(visit, violationsOf(wires), hits);
  return left.length === 0
    ? { kind: "held" }
    : {
        kind: "failed",
        message: `r2 withholds and v1 allows: ${left.map((violation) => `${violation.kind}:${violation.subject}`).join(", ")}`
      };
}

function shrinkVisit(visit: Visit): Iterable<Visit> {
  const candidates: Visit[] = [];
  const push = (next: Visit) => candidates.push(normalizeVisit(next));
  for (const losses of withoutOne(visit.losses)) push({ ...visit, losses });
  for (const freeLines of withoutOne(visit.freeLines)) push({ ...visit, freeLines });
  if (visit.subject !== "kept") push({ ...visit, subject: "kept" });
  if (visit.mode !== "observe") push({ ...visit, mode: "observe" });
  if (visit.reload) push({ ...visit, reload: false });
  if (visit.fingerprint !== "complete") push({ ...visit, fingerprint: "complete" });
  if (visit.keystroke !== "complete") push({ ...visit, keystroke: "complete" });
  if (visit.cname !== "complete") push({ ...visit, cname: "complete" });
  if (visit.pixel !== "complete") push({ ...visit, pixel: "complete" });
  if (visit.banner !== "complete" && visit.banner !== "clicked") push({ ...visit, banner: visit.mode === "observe" ? "complete" : "clicked" });
  if (visit.policy !== "read") push({ ...visit, policy: "read" });
  for (const key of Object.keys(visit.evidence) as (keyof EvidenceKnobs)[]) {
    const value = visit.evidence[key];
    if (value === true || value === "publishable" || value === "unpublishable") {
      push({ ...visit, evidence: { ...visit.evidence, [key]: key === "listener" ? "none" : false } });
    }
  }
  const key = (value: Visit) => JSON.stringify(value);
  const self = key(visit);
  return candidates.filter((candidate) => key(candidate) !== self);
}

function describeVisit(visit: Visit): string {
  const wires = (() => {
    try {
      return buildWires(visit);
    } catch {
      return null;
    }
  })();
  return JSON.stringify({ visit, lines: wires?.lines ?? "(the build threw)" }, null, 2);
}

test("a v1 view never allows a claim, a corpus membership or a family completeness r2 withholds for the same visit", () => {
  const hits = new Map<string, number>();
  const withheld = new Map<string, number>();
  const drawn = new Set<string>();
  assertProperty({
    name: "v1/r2 parity",
    seed: SEED,
    iterations: ITERATIONS,
    generate: (random) => {
      const visit = generateVisit(random);
      for (const feature of visitFeatures(visit)) drawn.add(feature);
      return visit;
    },
    shrink: shrinkVisit,
    describe: describeVisit,
    // Shrink toward the same failure, so a smaller visit that fails for an
    // unrelated reason cannot replace the one being reported.
    sameFailure: (current, candidate) => firstFailure(current) === firstFailure(candidate),
    property: (visit) => {
      const outcome = parityOf(visit, hits, withheld);
      if (outcome.kind === "refused") {
        for (const refusal of outcome.refusals) hits.set(refusal.name, (hits.get(refusal.name) ?? 0) + 1);
      }
      return outcome.kind === "failed" ? outcome.message : null;
    }
  });

  // Not vacuous. The draws reach every claim r2 can withhold, every outcome
  // the model knows, and every allowed divergence and known refusal: an entry
  // nothing reaches any more is stale and must go, with its finding.
  for (const claim of Object.keys(REPORT_CLAIM_REQUIREMENTS)) {
    assert.ok((withheld.get(claim) ?? 0) > 0, `no draw made r2 withhold ${claim}`);
  }
  for (const feature of allVisitFeatures()) assert.ok(drawn.has(feature), `no draw reached ${feature}`);
  for (const entry of [...ALLOWED_DIVERGENCES, ...KNOWN_BUILDER_REFUSALS]) {
    assert.ok((hits.get(entry.name) ?? 0) > 0, `${entry.name} was never needed; if its cause is fixed, remove it`);
  }
});

/** The first uncovered violation, or the build error, that a failure message names. */
function firstFailure(message: string): string {
  return message.replace(/^r2 withholds and v1 allows: /, "").split(/, |; /)[0];
}

function visitFeatures(visit: Visit): string[] {
  return [
    `mode:${visit.mode}`,
    `subject:${visit.subject}`,
    `fingerprint:${visit.fingerprint}`,
    `keystroke:${visit.keystroke}`,
    `cname:${visit.cname}`,
    `pixel:${visit.pixel}`,
    `banner:${visit.banner}`,
    `policy:${visit.policy}`,
    ...visit.losses.map((loss) => `loss:${loss}`),
    `listener:${visit.evidence.listener}`,
    ...(visit.reload ? ["reload"] : [])
  ];
}

function allVisitFeatures(): string[] {
  return [
    ...["observe", "accept-all", "reject-all"].map((mode) => `mode:${mode}`),
    ...SUBJECTS.map((subject) => `subject:${subject}`),
    ...FINGERPRINT_OUTCOMES.map((outcome) => `fingerprint:${outcome}`),
    ...KEYSTROKE_OUTCOMES.map((outcome) => `keystroke:${outcome}`),
    ...CNAME_OUTCOMES.map((outcome) => `cname:${outcome}`),
    ...PIXEL_OUTCOMES.map((outcome) => `pixel:${outcome}`),
    ...[...OBSERVE_BANNER_OUTCOMES, ...CONSENT_BANNER_OUTCOMES].map((outcome) => `banner:${outcome}`),
    ...POLICY_OUTCOMES.map((outcome) => `policy:${outcome}`),
    ...LOSS_EVENTS.map((loss) => `loss:${loss}`),
    ...["none", "publishable", "unpublishable"].map((listener) => `listener:${listener}`),
    "reload"
  ];
}

/**
 * Obligation-registry outcomes the Node scanner never sets, each with the
 * source fact that says so. Every other registry outcome must be one the
 * model draws, so a new outcome the scanner learns to set cannot go unmodeled.
 */
const OUTCOMES_THE_NODE_SCANNER_NEVER_SETS: ReadonlyArray<{ tuple: string; because: RegExp }> = [
  // The Node scanner declares both probes on for every visit, so neither
  // probe-off exception applies to it.
  ...["keystroke-exfiltration", "privacy-policy"].flatMap((detector) =>
    ["probe-disabled", "not-requested"].map((reason) => ({
      tuple: `${detector}/skipped/${reason}`,
      because: /probes: \{ keystroke: true, policyVisit: true \}/
    }))
  ),
  // A keystroke probe that fails says scan-failed on every exit.
  ...["load-failed", "engine-unavailable"].map((reason) => ({
    tuple: `keystroke-exfiltration/failed/${reason}`,
    because: /status: "failed", reason: "scan-failed", detection: null/
  }))
];

/**
 * The scanner's losses with no detail, each named by the one identifier the
 * scanner writes beside it and the model feature that draws it. A detail-less
 * loss censors every claim scope of its family, so these are the losses the
 * v1 lines most often failed to follow.
 */
const DETAIL_LESS_LOSS_SITES: ReadonlyArray<{ anchor: string; feature: string }> = [
  { anchor: "AUXILIARY_PAGE_REQUESTS_BLOCKED_WARNING", feature: "loss:auxiliary-page-request" },
  { anchor: "KEYSTROKE_PROBE_NAVIGATION_STOPPED_WARNING", feature: "loss:probe-stopped-navigation" },
  { anchor: "CONSENT_INTERACTION_LEFT_SUBJECT_WARNING", feature: "subject:consent-left" },
  { anchor: "PAGE_LEFT_SUBJECT_BEFORE_STATE_WARNING", feature: "subject:left-before-state" },
  { anchor: "settleInterrupted", feature: "loss:consent-settle-interrupted" },
  { anchor: "CONSENT_RELOAD_SUBJECT_WARNING", feature: "subject:reload-left" },
  { anchor: "incompleteKeystrokeProbeRequestLoss", feature: "keystroke:deadline" },
  { anchor: "activeProbeSubjectLost", feature: "keystroke:page-left-after-typing" },
  { anchor: "UNSETTLED_ROUTED_REQUEST_WARNING", feature: "loss:unsettled-routed-requests" },
  { anchor: "GPC_WORKER_CAPTURE_LOSS_WARNING", feature: "loss:gpc-worker" },
  { anchor: "INVALID_UPSTREAM_RESPONSE_WARNING", feature: "loss:invalid-upstream-response" }
];

/**
 * Each `recordCaptureLoss(...)` call in the source with no detail, named by
 * the anchor nearest to it within the ten lines before and six after, or
 * `null` when none is.
 */
function detailLessLossSites(source: string): Array<{ context: string; anchor: string | null }> {
  const sites: Array<{ context: string; anchor: string | null }> = [];
  const lines = source.split("\n");
  for (const match of source.matchAll(/recordCaptureLoss\(/g)) {
    let depth = 1;
    let end = match.index + match[0].length;
    while (depth > 0 && end < source.length) {
      if (source[end] === "(") depth += 1;
      else if (source[end] === ")") depth -= 1;
      end += 1;
    }
    if (/\bdetail\b/.test(source.slice(match.index, end))) continue;
    const line = source.slice(0, match.index).split("\n").length - 1;
    let nearest: { anchor: string; distance: number } | null = null;
    for (let index = Math.max(0, line - 10); index <= Math.min(lines.length - 1, line + 6); index += 1) {
      for (const { anchor } of DETAIL_LESS_LOSS_SITES) {
        const distance = Math.abs(index - line);
        if (lines[index].includes(anchor) && (nearest === null || distance < nearest.distance)) {
          nearest = { anchor, distance };
        }
      }
    }
    sites.push({ context: lines.slice(Math.max(0, line - 10), line + 7).join("\n"), anchor: nearest?.anchor ?? null });
  }
  return sites;
}

test("the scanner model reaches every loss detail the Node scanner records and every outcome it sets", () => {
  const random = seededRandom(SEED);
  const details = new Set<string>();
  const outcomes = new Set<string>();
  for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
    const draft = scannerDraft(generateVisit(random));
    for (const entry of draft.losses) if (entry.detail !== undefined) details.add(entry.detail);
    for (const [id, entry] of Object.entries(draft.detectors)) {
      if (entry.status !== "complete") outcomes.add(`${id}/${entry.status}/${entry.reason}`);
    }
  }

  // Loss details: every one the Node producers' source records. Builder-owned
  // public markers are the builder's own and come from evidence, not the model.
  const libDir = path.join(process.cwd(), "lib");
  const constants = stringConstants(libDir);
  const recorded = new Set<string>();
  for (const file of ["scanner.ts", "scan-runtime.ts", "public-scan-proxy.ts", "measurement-kernel.ts"]) {
    for (const detail of recordedDetails(readFileSync(path.join(libDir, file), "utf8"), constants)) {
      if (!detail.startsWith("public-")) recorded.add(detail);
    }
  }
  assert.ok(recorded.size > 5, `expected the scanner source to record details, found ${recorded.size}`);
  for (const detail of recorded) assert.ok(details.has(detail), `the model never records the scanner's ${detail} loss`);
  for (const detail of details) {
    assert.ok(Object.prototype.hasOwnProperty.call(CAPTURE_LOSS_DETAIL_CONTRACT, detail), `the model invents ${detail}`);
  }

  // Detail-less losses: each scanner site is one the model draws.
  const scannerSource = readFileSync(path.join(libDir, "scanner.ts"), "utf8");
  const features = new Set(allVisitFeatures());
  const sites = detailLessLossSites(scannerSource);
  assert.ok(sites.length > 5, `expected detail-less scanner losses, found ${sites.length}`);
  for (const site of sites) {
    assert.notEqual(site.anchor, null, `a detail-less scanner loss the model does not name:\n${site.context}`);
  }
  for (const { anchor, feature } of DETAIL_LESS_LOSS_SITES) {
    assert.ok(sites.some((site) => site.anchor === anchor), `${anchor} no longer sits beside a detail-less scanner loss`);
    assert.ok(features.has(feature), `${anchor}: the model has no ${feature}`);
  }

  // Detector outcomes: the obligation registry is the closed set the active
  // producer may set.
  const neverSet = new Set<string>();
  for (const { tuple, because } of OUTCOMES_THE_NODE_SCANNER_NEVER_SETS) {
    assert.match(scannerSource, because, `${tuple}: the scanner no longer shows why it never sets this outcome`);
    neverSet.add(tuple);
  }
  for (const rule of DETECTOR_OBLIGATION_REGISTRY) {
    const tuple = `${rule.detector}/${rule.status}/${rule.reason}`;
    if (neverSet.has(tuple)) {
      assert.equal(outcomes.has(tuple), false, `the model sets ${tuple}, listed as never set`);
      continue;
    }
    assert.ok(outcomes.has(tuple), `the model never sets ${tuple}, which the registry admits`);
  }
  for (const tuple of outcomes) {
    assert.ok(
      DETECTOR_OBLIGATION_REGISTRY.some((rule) => `${rule.detector}/${rule.status}/${rule.reason}` === tuple),
      `the model sets ${tuple}, which the obligation registry does not admit`
    );
  }
});
