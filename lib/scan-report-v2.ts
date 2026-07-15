/**
 * ScanReport v2 revision 1 wire types, as specified by the accepted RFC
 * (docs/scan-report-v2-rfc.md). These types are the source of truth for the v2
 * runtime validator (lib/scan-report-v2-validation.ts) and the generated JSON
 * Schema. v1 stays frozen in lib/types.ts; public r2 production composes these
 * unchanged r1 foundations through the revision-2 types.
 *
 * Normative-vs-non-normative status follows RFC section 10.5: the shapes here
 * are the normative r1 contract except ComparisonDiffV2, which is
 * implementation-defined during step 2 under the constraints stated on its
 * declaration below.
 */
import type {
  CnameCloak,
  CookieRecord,
  FingerprintDetectionSummary,
  FingerprintEventSummary,
  NetworkRequestRecord,
  PixelEventSummary,
  PrivacyPolicySummary,
  ReportShare,
  ScanAutomation,
  StorageRecord
} from "./types";

export const SCAN_REPORT_V2_SCHEMA_VERSION = 2 as const;
/**
 * Revision literal pinned per RFC 10.2: r1 types declare 1; an r2 release ships
 * new types declaring 2. Readers reject unknown revisions with
 * "unsupported-revision" instead of best-effort parsing.
 */
export const SCAN_REPORT_V2_SCHEMA_REVISION = 1 as const;

// ---------------------------------------------------------------------------
// Subject identity (RFC section 2)
// ---------------------------------------------------------------------------

// The property doc below is byte-frozen into the published r1 schema and keeps
// its historical "token-like" wording. Executable sanitizer revision 3 and
// RFC 9.1 are stricter: every non-allowlisted subdomain label generalizes, and
// trailing dots are stripped. Correcting schema prose requires a new revision.
export type SubjectKey = {
  /**
   * Normalized privacy-safe origin: lowercase, IDN as punycode A-label, default
   * port stripped, token-like subdomain labels generalized (RFC 9.1).
   */
  origin: string;
  /** eTLD+1 ("example.com"). Public profile grouping key. */
  registrableDomain: string;
  /** Privacy-safe path shape ("/products/{seg}", RFC 9.1). */
  routeShape: string;
};

export type SubjectIdentity = {
  /** What the submitter asked for. */
  requested: SubjectKey;
  /** Derived from the FINAL url; the measured subject and comparison identity. */
  observed: SubjectKey;
};

// ---------------------------------------------------------------------------
// Conditions and toolchain (RFC sections 3.1, 3.5)
// ---------------------------------------------------------------------------

/** The axes an experiment may move. Everything else is environment. */
export type InterventionAxis = "gpc" | "shields" | "consent";
export const INTERVENTION_AXES: readonly InterventionAxis[] = ["gpc", "shields", "consent"];

export type ShieldsCondition = "off" | "classification" | "block-simulation";
export type ConsentCondition = "observe" | "accept-all" | "reject-all";

export type ConditionVector = {
  gpc: boolean;
  shields: ShieldsCondition;
  consent: ConsentCondition;
  device: {
    kind: "desktop" | "mobile";
    viewport: { width: number; height: number; isMobile: boolean };
  };
  probes: { keystroke: boolean; policyVisit: boolean };
  locale: string;
  language: string;
  timezone: string;
  egress: { label: string; region?: string };
  browser: { name: string; version: string };
  headless: boolean;
  automation: ScanAutomation;
};

/** The digests/versions the fingerprints hash, stored on the run (RFC 3.5). */
export type Toolchain = {
  trackerCatalog: { source: string; version: string; entries: number; digest: string };
  adblock: {
    source: string;
    lists: number;
    fetchedAt: string;
    /** Aggregate digest; keys the published immutable per-list digest manifest. */
    manifestDigest: string;
    engineVersion: string;
  } | null;
  /** URL/host canonicalization rules version (RFC section 9). */
  normalizationVersion: string;
};

/**
 * RFC 3.2: three digests over canonical JSON. Stored beside their inputs
 * (conditions, provenance, toolchain), so every fingerprint is recomputable
 * from the report itself.
 */
export type Fingerprints = {
  /** Exact reproducibility: full conditions + buildCommit + methodology + registries + toolchain. */
  execution: string;
  /**
   * Behavior-affecting environment EXCLUDING the intervention axes' values and
   * buildCommit. Equal values mean "measured the same way"; intervention state
   * may still differ.
   */
  measurementEnvironment: string;
  /** The complete condition vector alone. Equal values mean "same requested setup". */
  condition: string;
};

// ---------------------------------------------------------------------------
// Provenance, privacy, quality, detectors (RFC section 5)
// ---------------------------------------------------------------------------

export type ObserverKind = "node-playwright" | "browser-run-worker" | "pagegraph-import";
export type AcquisitionKind = "public-api" | "operator-cli" | "ci-workflow" | "upload";

export type Provenance = {
  /** What measured. */
  observer: ObserverKind;
  /** What asked for the measurement; CI is an orchestrator, not a scanner. */
  acquisition: AcquisitionKind;
  /** Self-reported, machine-checkable metadata, not cryptographic proof. */
  buildCommit: string;
  /** Meaning of the numbers; distinct from schemaVersion (shape). */
  methodologyVersion: string;
  /** The known-detector set itself is versioned. */
  detectorRegistry: { version: string; digest: string };
  /** e.g. sha256 of an imported PageGraph GraphML. */
  sourceArtifactDigest?: string;
};

/** Redaction is expected behavior, never censoring (RFC 5.2). */
export type PrivacyStats = {
  redactionVersion: number;
  redaction: {
    pathSegmentsGeneralized: number;
    queryKeysRedacted: number;
    storageKeysRedacted: number;
    cookieNamesRedacted: number;
    matrixParamsStripped: number;
    subdomainLabelsGeneralized: number;
    malformedUrlsDropped: number;
  };
};

export type EvidenceFamily =
  | "requests"
  | "cookies"
  | "storage"
  | "fingerprinting"
  | "detector-output"
  | "consent-verification";
export const EVIDENCE_FAMILIES: readonly EvidenceFamily[] = [
  "requests",
  "cookies",
  "storage",
  "fingerprinting",
  "detector-output",
  "consent-verification"
];

export type CaptureLossEntry = {
  family: EvidenceFamily;
  /** null = not attributable to a phase. */
  phaseId: PhaseId | null;
  kind: "dropped" | "clipped" | "truncated" | "timeout" | "cap";
  count: number;
  detail?: string;
};

/** Recorded facts; producers never declare quality directly (RFC 5.3). */
export type QualityFacts = {
  /**
   * @minimum 100
   * @maximum 599
   * @multipleOf 1
   */
  status: number | null;
  botWallTitleMatched: boolean;
  navigationSettled: boolean;
  budgetsExhausted: string[];
  captureLoss: CaptureLossEntry[];
};

/**
 * Normative initial vocabulary (RFC 5.3); extensible only with an
 * evaluatorVersion bump. Parameterized codes use "code:qualifier".
 */
export type QualityReason =
  | "http-error-status"
  | "bot-wall-title"
  | "navigation-timeout"
  | "empty-load"
  | "scan-slot-timeout"
  | `capture-loss:${string}`
  | `budget-exhausted:${string}`;

export type Quality = {
  evaluatorVersion: string;
  /** Run-level: did the page load produce a valid observation at all? */
  run: { outcome: "complete" | "failed"; reasons: QualityReason[] };
  /** Family-level censoring; one family's loss never contaminates another. */
  byFamily: Record<EvidenceFamily, { outcome: "complete" | "censored"; reasons: QualityReason[] }>;
};

/**
 * Normative initial registry, version "1" (RFC 5.4). The ledger must contain an
 * entry for every detector in the referenced registry version.
 */
export type DetectorId =
  | "fingerprint-heuristics"
  | "keystroke-exfiltration"
  | "cname-uncloaking"
  | "pixel-events"
  | "consent-banner"
  | "privacy-policy";
export const DETECTOR_IDS: readonly DetectorId[] = [
  "fingerprint-heuristics",
  "keystroke-exfiltration",
  "cname-uncloaking",
  "pixel-events",
  "consent-banner",
  "privacy-policy"
];

export type DetectorStatus = "complete" | "partial" | "skipped" | "unsupported" | "failed";

export type DetectorLedger = Record<
  DetectorId,
  {
    version: string;
    status: DetectorStatus;
    reason?: string;
    phaseId?: PhaseId;
  }
>;

// ---------------------------------------------------------------------------
// Phases (RFC section 7)
// ---------------------------------------------------------------------------

export type PhaseId = number;

export type PhaseKind =
  | "passive-load"
  | "consent-interaction"
  | "post-choice-reload"
  | "active-probe"
  | "policy-analysis";
export const PHASE_KINDS: readonly PhaseKind[] = [
  "passive-load",
  "consent-interaction",
  "post-choice-reload",
  "active-probe",
  "policy-analysis"
];

export type PhaseSpan = {
  phaseId: PhaseId;
  kind: PhaseKind;
  /**
   * @minimum 0
   * @maximum 9007199254740991
   * @multipleOf 1
   */
  startedAtMs: number;
  /**
   * @minimum 0
   * @maximum 9007199254740991
   * @multipleOf 1
   */
  endedAtMs: number;
};

// ---------------------------------------------------------------------------
// Consent evidence (RFC section 6)
// ---------------------------------------------------------------------------

export type ConsentChoiceState = "verified" | "contradicted" | "weak-signal" | "unavailable" | "failed";

/**
 * Normalized consent state (RFC 9.4): never the raw CMP payload. Interpreters
 * map whatever they read into this closed vocabulary before anything persists.
 */
export type ConsentObservedState = "accepted-all" | "rejected-all" | "partial" | "unknown";
export const CONSENT_OBSERVED_STATES: readonly ConsentObservedState[] = [
  "accepted-all",
  "rejected-all",
  "partial",
  "unknown"
];

export type ConsentVerificationObservation = {
  phaseId: PhaseId;
  /** Versioned interpreter id: "tcf-api@1", "onetrust-cookie@1". */
  method: string;
  /** The normalized state read; null = interpreter ran, nothing readable. */
  observed: ConsentObservedState | null;
  /** null when observed is null. */
  consistentWithChoice: boolean | null;
};

export type ConsentEvidence = {
  mode: "accept-all" | "reject-all";
  interactionAttempted: boolean;
  /** A control was actually clicked (v1 `clicked`). */
  controlActivated: boolean;
  /**
   * The recorded facts, phase-tagged. An intervention-grade verification has at
   * least one observation in consent-interaction and one in post-choice-reload.
   */
  verificationObservations: ConsentVerificationObservation[];
  /** Derived by the shared evaluator from the observations. */
  choiceState: ConsentChoiceState;
  /** true iff a post-choice-reload observation exists and agrees. */
  reverifiedAfterReload: boolean;
  verificationFailureReason?: string;
  cmp?: string;
  selector?: string;
  matchedText?: string;
  frameUrl?: string;
};

// ---------------------------------------------------------------------------
// Evidence (RFC section 7.1, 7.2): v1 records + phase awareness
// ---------------------------------------------------------------------------

export type NetworkRequestRecordV2 = NetworkRequestRecord & { phaseId: PhaseId };
export type CookieRecordV2 = CookieRecord;
export type StorageRecordV2 = StorageRecord;

export type CookieMutation = {
  phaseId: PhaseId;
  op: "added" | "changed" | "removed";
  /** State after the op (or last state, for "removed"). */
  cookie: CookieRecordV2;
};

export type StorageMutation = {
  phaseId: PhaseId;
  op: "added" | "changed" | "removed";
  entry: StorageRecordV2;
};

export type RunEvidence = {
  requests: NetworkRequestRecordV2[];
  cookieMutations: CookieMutation[];
  cookiesFinal: CookieRecordV2[];
  storageMutations: StorageMutation[];
  storageFinal: StorageRecordV2[];
  fingerprintEvents: Array<FingerprintEventSummary & { phaseId: PhaseId }>;
  fingerprintDetections: Array<FingerprintDetectionSummary & { phaseId: PhaseId }>;
  cnameCloaks: CnameCloak[];
  pixelEvents: Array<PixelEventSummary & { phaseId: PhaseId }>;
  privacyPolicy?: PrivacyPolicySummary;
  consent?: ConsentEvidence;
};

// ---------------------------------------------------------------------------
// Run summary (RFC section 1.1)
// ---------------------------------------------------------------------------

export type RunSummary = {
  pageTitle: string;
  /**
   * @minimum 100
   * @maximum 599
   * @multipleOf 1
   */
  status: number | null;
  /**
   * @minimum 0
   * @maximum 9007199254740991
   * @multipleOf 1
   */
  durationMs: number;
  counts: {
    totalRequests: number;
    thirdPartyRequests: number;
    knownTrackerRequests: number;
    thirdPartyDomains: number;
    cookies: number;
    thirdPartyCookies: number;
    storageEntries: number;
    fingerprintEvents: number;
    shieldsBlockedRequests?: number;
  };
  countsByPhase: Array<{
    phaseId: PhaseId;
    totalRequests: number;
    thirdPartyRequests: number;
    knownTrackerRequests: number;
  }>;
};

// ---------------------------------------------------------------------------
// The run (RFC section 1)
// ---------------------------------------------------------------------------

export type ScanRunV2 = {
  runId: string;
  /** ISO 8601, per run (v1 comparisons shared one root scannedAt). */
  startedAt: string;
  subject: SubjectIdentity;
  conditions: ConditionVector;
  provenance: Provenance;
  toolchain: Toolchain;
  fingerprints: Fingerprints;
  qualityFacts: QualityFacts;
  quality: Quality;
  privacy: PrivacyStats;
  detectors: DetectorLedger;
  phases: PhaseSpan[];
  summary: RunSummary;
  evidence: RunEvidence;
  /** Scanner-vocabulary strings only (RFC 9.4). */
  warnings: string[];
};

// ---------------------------------------------------------------------------
// Experiments (RFC section 4)
// ---------------------------------------------------------------------------

/**
 * Closed axis-state vocabulary (RFC 9.4): arm expectations and observations are
 * scanner-controlled codes, never page-derived strings.
 */
export type AxisState =
  | `gpc:${"on" | "off"}`
  | `shields:${ShieldsCondition}`
  | `consent:${ConsentCondition}`;

export function axisStateFor(axis: InterventionAxis, conditions: ConditionVector): AxisState {
  if (axis === "gpc") return conditions.gpc ? "gpc:on" : "gpc:off";
  if (axis === "shields") return `shields:${conditions.shields}`;
  return `consent:${conditions.consent}`;
}

export type ArmVerification = {
  axis: InterventionAxis;
  /** The condition the arm was supposed to run under. */
  expected: AxisState;
  /** What the interpreter actually read; null = unobservable. */
  observed: AxisState | null;
  /** Versioned: "gpc-header-readback@1", "shields-engine-status@1", "tcf-api@1". */
  method: string;
  outcome: "passed" | "failed" | "inconclusive";
  phaseId: PhaseId;
};

export type EvidenceStrength = "observed-difference" | "replicated-difference";

export type InterventionExperiment = {
  kind: "intervention";
  axis: InterventionAxis;
  /** Random id shared by both runs of the pair. */
  pairId: string;
  /** Counterbalanced across pairs from the first v2 release. */
  order: "AB" | "BA";
  /** Both arms, always (RFC 4.3). */
  verification: { baseline: ArmVerification; variant: ArmVerification };
  evidence: { pairs: number; counterbalanced: boolean; strength: EvidenceStrength };
};

export type TemporalExperiment = {
  kind: "temporal";
  pairId: string;
  // baseline is the chronologically earlier run (validator enforces
  // baseline.startedAt < variant.startedAt). No order, no verification:
  // nothing was manipulated.
};

export type DescriptiveExperiment = {
  kind: "descriptive";
  pairId: string;
  /** Ordering if known; NEVER causal. */
  sourceOrder: "as-provided" | "chronological" | "unknown";
};

export type Experiment = InterventionExperiment | TemporalExperiment | DescriptiveExperiment;

// ---------------------------------------------------------------------------
// Comparability (RFC section 4.4)
// ---------------------------------------------------------------------------

export type MetricFamily =
  | "raw-counts"
  | "tracker-classification"
  | "shields-simulation"
  | "consent-verification"
  | "detector-findings";
export const METRIC_FAMILIES: readonly MetricFamily[] = [
  "raw-counts",
  "tracker-classification",
  "shields-simulation",
  "consent-verification",
  "detector-findings"
];

/**
 * Normative initial reason vocabulary (RFC 4.4); extensible only with a
 * metricRegistryVersion or evaluatorVersion bump.
 */
export type ComparabilityReason =
  | "subject-mismatch"
  | "design-invalid"
  | `run-failed:${"baseline" | "variant"}`
  | `unknown-dimension:${string}`
  | `dependency-digest-mismatch:${string}`
  | `dependency-version-mismatch:${string}`
  | `family-censored:${"baseline" | "variant"}`
  | `arm-verification-failed:${"baseline" | "variant"}`
  | `arm-verification-inconclusive:${"baseline" | "variant"}`;

export type Comparability = {
  evaluatorVersion: string;
  metricRegistryVersion: string;
  /**
   * Structural: observed subjects match, the experiment is well-formed for its
   * kind, and BOTH runs are run-level complete. Matching failure statuses never
   * make a pair valid.
   */
  pairValidity: { eligible: boolean; reasons: ComparabilityReason[] };
  /** Per metric family; split eligibility is the point (RFC example 12.3). */
  perMetric: Record<MetricFamily, { eligible: boolean; reasons: ComparabilityReason[] }>;
  /**
   * ONLY present when experiment.kind === "intervention": both arms passed.
   * Gates intervention-ATTRIBUTED claims, not family eligibility.
   */
  interventionVerified?: boolean;
};

// ---------------------------------------------------------------------------
// Reports (RFC section 1)
// ---------------------------------------------------------------------------

export type MetricDelta = { baseline: number; variant: number; delta: number };

/**
 * Normative r1 diff. Derivable from the two runs alone (the shared builder in
 * lib/scan-report-v2-evaluators.ts is the definition; semantic validation
 * rejects any diff that does not equal the rebuilt one), organized per metric
 * family, carrying each family's eligibility (mirrored from
 * comparability.perMetric) so renderers cannot show an ineligible delta.
 */
export type ComparisonDiffV2 = {
  families: {
    "raw-counts": {
      eligible: boolean;
      metrics: {
        totalRequests: MetricDelta;
        thirdPartyRequests: MetricDelta;
        thirdPartyDomains: MetricDelta;
        cookies: MetricDelta;
        thirdPartyCookies: MetricDelta;
        storageEntries: MetricDelta;
      };
    };
    "tracker-classification": {
      eligible: boolean;
      metrics: { knownTrackerRequests: MetricDelta };
      addedTrackerDomains: string[];
      removedTrackerDomains: string[];
    };
    "shields-simulation": {
      eligible: boolean;
      /** null when either run recorded no Shields count. */
      metrics: { shieldsBlockedRequests: MetricDelta } | null;
    };
    "consent-verification": { eligible: boolean };
    "detector-findings": {
      eligible: boolean;
      addedDetectionKinds: string[];
      removedDetectionKinds: string[];
    };
  };
};

export type PublicSingleReportV2 = {
  schemaVersion: typeof SCAN_REPORT_V2_SCHEMA_VERSION;
  schemaRevision: typeof SCAN_REPORT_V2_SCHEMA_REVISION;
  reportType: "single";
  run: ScanRunV2;
  share?: ReportShare;
};

export type PublicComparisonReportV2 = {
  schemaVersion: typeof SCAN_REPORT_V2_SCHEMA_VERSION;
  schemaRevision: typeof SCAN_REPORT_V2_SCHEMA_REVISION;
  reportType: "comparison";
  baseline: ScanRunV2;
  variant: ScanRunV2;
  experiment: Experiment;
  comparability: Comparability;
  diff: ComparisonDiffV2;
  share?: ReportShare;
};

export type PublicScanReportV2 = PublicSingleReportV2 | PublicComparisonReportV2;

// ---------------------------------------------------------------------------
// Ephemeral shells (RFC section 8): sanitized evidence + an explicit ephemeral
// block. The projector (lib/scan-report-projection.ts) drops the block by
// allowlist copy; the public validator rejects reports that still carry it.
// ---------------------------------------------------------------------------

export type EphemeralSingleReport = PublicSingleReportV2 & {
  ephemeral: { screenshot: string | null };
};

export type EphemeralComparisonReport = PublicComparisonReportV2 & {
  ephemeral: { baselineScreenshot: string | null; variantScreenshot: string | null };
};

export type EphemeralScanReport = EphemeralSingleReport | EphemeralComparisonReport;
