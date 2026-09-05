/**
 * ScanReport v2 REVISION 2 wire types, exactly as specified by the accepted
 * r2-a4 addendum (docs/scan-report-v2-rfc.md, section 15). These are the current
 * producer and reader contract; the published r2 schema is also frozen.
 *
 * The r1 types and schema are FROZEN (executable hash gate in
 * scripts/build-schema.mjs); this module never modifies them, it composes them
 * via Omit/intersection per RFC 15.2. The explicit *R1 aliases at the bottom
 * give r2-aware code an unambiguous name for the unchanged r1 shapes.
 */
import type {
  ArmVerification,
  ConsentEvidence,
  ConsentVerificationObservation,
  DescriptiveExperiment,
  InterventionExperiment,
  PhaseId,
  PublicComparisonReportV2,
  PublicSingleReportV2,
  RunEvidence,
  ScanRunV2,
  TemporalExperiment
} from "./scan-report-v2";

export const SCAN_REPORT_V2_SCHEMA_REVISION_2 = 2 as const;

// ---------------------------------------------------------------------------
// Consent observation results (RFC 15.2/15.4)
// ---------------------------------------------------------------------------

/**
 * Structurally OPTIONAL so the r2 schema stays a superset of r1; the r2
 * evaluator makes it MANDATORY on every observation present in an r2 consent
 * run. Discriminated: each outcome pins its allowed error code.
 */
export type ConsentObservationResultR2 =
  | { outcome: "read"; sequence: number }
  | { outcome: "unreadable"; sequence: number }
  | { outcome: "error"; sequence: number; errorCode: "interpreter-threw" | "state-format-unrecognized" }
  | { outcome: "timeout"; sequence: number; errorCode: "api-timeout" }
  | { outcome: "unsupported-frame"; sequence: number; errorCode: "cross-origin-frame-blocked" };

export type ConsentVerificationObservationR2 = ConsentVerificationObservation & {
  result?: ConsentObservationResultR2;
};

/**
 * Closed compatibility placeholder for the zero-observation case (RFC 15.4):
 * no interpreter ran, so none is fabricated. Never appears on an observation.
 */
export const CONSENT_VERIFICATION_UNAVAILABLE_METHOD = "consent-verification-unavailable@1";

// ---------------------------------------------------------------------------
// Banner transitions (RFC 15.5)
// ---------------------------------------------------------------------------

export type BannerTransitionMomentR2 = "before-interaction" | "after-interaction" | "after-reload";

export type BannerTransitionR2 = {
  method: "banner-visibility@1";
  observations: Array<{
    moment: BannerTransitionMomentR2;
    phaseId: PhaseId;
    /**
     * Must lie inside the referenced phase's span; strictly before < after (< reload).
     *
     * @minimum 0
     * @maximum 9007199254740991
     * @multipleOf 1
     */
    atMs: number;
    visible: boolean;
  }>;
};

export type ConsentEvidenceR2 = Omit<ConsentEvidence, "verificationObservations"> & {
  verificationObservations: ConsentVerificationObservationR2[];
  bannerTransition?: BannerTransitionR2;
};

export type RunEvidenceR2 = Omit<RunEvidence, "consent"> & { consent?: ConsentEvidenceR2 };

// ---------------------------------------------------------------------------
// Structured arm facts (RFC 15.3)
// ---------------------------------------------------------------------------

export type GpcVerificationFactsR2 = {
  method: "gpc-header-readback@1";
  header: "confirmed-present" | "confirmed-absent" | "unobservable";
  jsSignal: "confirmed-true" | "confirmed-false" | "confirmed-absent" | "read-failed" | "unobservable";
  /** The only scope in r2; sampled scopes are deferred to a later revision. */
  observedOn: "first-party-navigation";
  /** Must reference a passive-load phase containing the eligible navigation. */
  phaseId: PhaseId;
};

export type ShieldsVerificationFactsR2 = {
  method: "shields-engine-status@1";
  engineLoaded: boolean;
  applied: boolean;
  /** Nonnegative integers; actuallyBlocked <= matched <= evaluated. */
  requestsEvaluated: number;
  requestsMatched: number;
  requestsActuallyBlocked: number;
  /** The passive-load phase of the engine-status observation. */
  phaseId: PhaseId;
};

export type ScanRunV2R2 = Omit<ScanRunV2, "evidence"> & {
  evidence: RunEvidenceR2;
  verificationFacts?: {
    gpc?: GpcVerificationFactsR2;
    shields?: ShieldsVerificationFactsR2;
  };
};

// ---------------------------------------------------------------------------
// Experiments (RFC 15.2/15.6)
// ---------------------------------------------------------------------------

export type SupportingPairR2 = {
  pairId: string;
  order: "AB" | "BA";
  /** COMPLETE embedded runs, never counters (RFC 15.6). */
  baseline: ScanRunV2R2;
  variant: ScanRunV2R2;
  verification: { baseline: ArmVerification; variant: ArmVerification };
};

/** supportingPairs exist ONLY on intervention experiments. */
export type InterventionExperimentR2 = InterventionExperiment & { supportingPairs?: SupportingPairR2[] };

export type ExperimentR2 = InterventionExperimentR2 | TemporalExperiment | DescriptiveExperiment;

// ---------------------------------------------------------------------------
// Reports (RFC 15.2)
// ---------------------------------------------------------------------------

export type PublicSingleReportV2R2 = Omit<PublicSingleReportV2, "schemaRevision" | "run"> & {
  schemaRevision: typeof SCAN_REPORT_V2_SCHEMA_REVISION_2;
  run: ScanRunV2R2;
};

export type PublicComparisonReportV2R2 = Omit<
  PublicComparisonReportV2,
  "schemaRevision" | "baseline" | "variant" | "experiment"
> & {
  schemaRevision: typeof SCAN_REPORT_V2_SCHEMA_REVISION_2;
  baseline: ScanRunV2R2;
  variant: ScanRunV2R2;
  experiment: ExperimentR2;
};

export type PublicScanReportV2R2 = PublicSingleReportV2R2 | PublicComparisonReportV2R2;

export type EphemeralSingleReportR2 = PublicSingleReportV2R2 & {
  ephemeral: { screenshot: string | null };
};

export type EphemeralComparisonReportR2 = PublicComparisonReportV2R2 & {
  ephemeral: { baselineScreenshot: string | null; variantScreenshot: string | null };
};

// ---------------------------------------------------------------------------
// Explicit unchanged v2/r1 aliases (implementation slice 1, review item 1).
// Naming only: the shapes are the frozen r1 types, proven unchanged by the
// pinned schema hash. r2-aware code uses these names when it must say "r1"
// unambiguously next to the *R2 types above.
// ---------------------------------------------------------------------------

export type ScanRunV2R1 = ScanRunV2;
export type RunEvidenceR1 = RunEvidence;
export type ConsentEvidenceR1 = ConsentEvidence;
export type ConsentVerificationObservationR1 = ConsentVerificationObservation;
export type PublicSingleReportV2R1 = PublicSingleReportV2;
export type PublicComparisonReportV2R1 = PublicComparisonReportV2;
