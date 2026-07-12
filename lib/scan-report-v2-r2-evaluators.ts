/**
 * Semantic derivations and reject-on-disagreement evaluator for ScanReport v2
 * REVISION 2 (r2-a4, RFC section 15). Every retained r1-derived field
 * (quality, fingerprints, summary, consent choiceState/reverifiedAfterReload,
 * observation consistency, arm expected/observed/outcome/method/phaseId,
 * experiment evidence, comparability, diff) is recomputed from the structured
 * facts and any disagreement is a violation.
 *
 * Version discipline: r2 rules extend evaluator "1" pre-emission (decision
 * recorded in lib/scan-report-v2-evaluators.ts: no v2 artifact exists
 * anywhere; versions freeze at first producer emission).
 */
import {
  axisStateFor,
  type ArmVerification,
  type AxisState,
  type Comparability,
  type ComparabilityReason,
  type Experiment,
  type InterventionAxis,
  type PhaseKind,
  type ScanRunV2
} from "./scan-report-v2";
import {
  CONSENT_CHOICE_TO_ARM_OUTCOME,
  CONSENT_INTERPRETER_METHODS,
  STRONG_CONSENT_INTERPRETERS,
  WEAK_CONSENT_INTERPRETERS,
  buildComparisonDiffV2,
  deriveObservationConsistency,
  evaluateComparability,
  interventionAxisDelta,
  phaseKindAt,
  scanRunCoreViolations,
  subjectsMatch
} from "./scan-report-v2-evaluators";
import { canonicalJson } from "./scan-report-v2-fingerprints";
import {
  CONSENT_VERIFICATION_UNAVAILABLE_METHOD,
  type BannerTransitionR2,
  type ConsentEvidenceR2,
  type GpcVerificationFactsR2,
  type InterventionExperimentR2,
  type PublicScanReportV2R2,
  type ScanRunV2R2,
  type ShieldsVerificationFactsR2,
  type SupportingPairR2
} from "./scan-report-v2-r2";

function canonicallyEqual(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

const CONSENT_OBSERVATION_PHASES = new Set<PhaseKind>(["consent-interaction", "post-choice-reload"]);

// ---------------------------------------------------------------------------
// Interpreter compatibility key (RFC 15.4)
// ---------------------------------------------------------------------------

/**
 * The sorted unique set of ALL attempted strong interpreter method strings,
 * regardless of outcome: an attempt that timed out still names the
 * interpreter that ran.
 */
export function attemptedStrongInterpreters(run: ScanRunV2R2): string[] {
  const consent = run.evidence.consent;
  if (consent === undefined) return [];
  return [
    ...new Set(
      consent.verificationObservations
        .map((observation) => observation.method)
        .filter((method) => STRONG_CONSENT_INTERPRETERS.has(method))
    )
  ].sort();
}

export function evaluateComparabilityR2(
  experiment: Experiment,
  baseline: ScanRunV2R2,
  variant: ScanRunV2R2
): Comparability {
  const base = evaluateComparability(experiment, baseline, variant);
  const reasons: ComparabilityReason[] = [...base.perMetric["consent-verification"].reasons];
  const setA = attemptedStrongInterpreters(baseline);
  const setB = attemptedStrongInterpreters(variant);
  if (setA.length === 0 || setB.length === 0) {
    // Two runs that attempted nothing never establish consent-verification
    // compatibility (the unknown rule, RFC 15.4).
    reasons.push("unknown-dimension:consent-interpreter");
  } else if (!canonicallyEqual(setA, setB)) {
    reasons.push("dependency-version-mismatch:consent-interpreter");
  }
  return {
    ...base,
    perMetric: {
      ...base.perMetric,
      "consent-verification": { eligible: reasons.length === 0, reasons }
    }
  };
}

// ---------------------------------------------------------------------------
// Consent derivation (RFC 15.4/15.5), total
// ---------------------------------------------------------------------------

type ObservationR2 = ConsentEvidenceR2["verificationObservations"][number];

function isStrongRead(observation: ObservationR2): boolean {
  return STRONG_CONSENT_INTERPRETERS.has(observation.method) && observation.result?.outcome === "read";
}

function isStrongFailure(observation: ObservationR2): boolean {
  return (
    STRONG_CONSENT_INTERPRETERS.has(observation.method) &&
    (observation.result?.outcome === "error" || observation.result?.outcome === "timeout")
  );
}

function groundedWeakSignal(run: ScanRunV2R2, consent: ConsentEvidenceR2): boolean {
  const transition = consent.bannerTransition;
  if (transition === undefined) return false;
  const before = transition.observations.filter((entry) => entry.moment === "before-interaction");
  const after = transition.observations.filter((entry) => entry.moment === "after-interaction");
  return (
    consent.interactionAttempted &&
    consent.controlActivated &&
    run.detectors["consent-banner"].status === "complete" &&
    before.length === 1 &&
    after.length === 1 &&
    before[0].visible === true &&
    after[0].visible === false
  );
}

export function deriveChoiceStateR2(
  run: ScanRunV2R2,
  consent: ConsentEvidenceR2
): "verified" | "contradicted" | "failed" | "weak-signal" | "unavailable" {
  const observations = consent.verificationObservations;
  if (observations.some((observation) => isStrongRead(observation) && observation.consistentWithChoice === false)) {
    return "contradicted";
  }
  const strongConsistentInInteraction = observations.some(
    (observation) =>
      isStrongRead(observation) &&
      observation.consistentWithChoice === true &&
      phaseKindAt(run, observation.phaseId) === "consent-interaction"
  );
  const strongConsistentInReload = observations.some(
    (observation) =>
      isStrongRead(observation) &&
      observation.consistentWithChoice === true &&
      phaseKindAt(run, observation.phaseId) === "post-choice-reload"
  );
  if (consent.controlActivated && strongConsistentInInteraction && strongConsistentInReload) return "verified";
  if (observations.some(isStrongFailure)) return "failed";
  if (groundedWeakSignal(run, consent)) return "weak-signal";
  return "unavailable";
}

/** Shared producer/read-side derivation; never trust a producer-supplied reload claim. */
export function deriveReverifiedAfterReloadR2(run: ScanRunV2R2, consent: ConsentEvidenceR2): boolean {
  return consent.verificationObservations.some(
    (observation) =>
      isStrongRead(observation) &&
      observation.consistentWithChoice === true &&
      phaseKindAt(run, observation.phaseId) === "post-choice-reload"
  );
}

/** Singular compatibility method/phaseId selection (RFC 15.4). */
export function deriveConsentArmCompatR2(run: ScanRunV2R2): { method: string; phaseId: number } {
  const consent = run.evidence.consent;
  const observations = consent?.verificationObservations ?? [];
  const state = consent === undefined ? "unavailable" : deriveChoiceStateR2(run, consent);

  const earliest = (predicate: (observation: ObservationR2) => boolean): ObservationR2 | undefined =>
    observations.find(predicate);

  if (state === "verified") {
    const establishing = earliest(
      (observation) =>
        isStrongRead(observation) &&
        observation.consistentWithChoice === true &&
        phaseKindAt(run, observation.phaseId) === "post-choice-reload"
    );
    if (establishing !== undefined) return { method: establishing.method, phaseId: establishing.phaseId };
  }
  if (state === "contradicted") {
    const establishing = earliest((observation) => isStrongRead(observation) && observation.consistentWithChoice === false);
    if (establishing !== undefined) return { method: establishing.method, phaseId: establishing.phaseId };
  }
  if (state === "failed") {
    const establishing = earliest(isStrongFailure);
    if (establishing !== undefined) return { method: establishing.method, phaseId: establishing.phaseId };
  }
  if (state === "weak-signal" && consent?.bannerTransition !== undefined) {
    const after = consent.bannerTransition.observations.find((entry) => entry.moment === "after-interaction");
    if (after !== undefined) return { method: "banner-visibility@1", phaseId: after.phaseId };
  }
  if (observations.length > 0) return { method: observations[0].method, phaseId: observations[0].phaseId };
  const interactionPhase = run.phases.find((span) => span.kind === "consent-interaction");
  return { method: CONSENT_VERIFICATION_UNAVAILABLE_METHOD, phaseId: interactionPhase?.phaseId ?? 0 };
}

const BANNER_MOMENT_PHASES: Record<BannerTransitionR2["observations"][number]["moment"], PhaseKind> = {
  "before-interaction": "consent-interaction",
  "after-interaction": "consent-interaction",
  "after-reload": "post-choice-reload"
};

function bannerViolations(run: ScanRunV2R2, transition: BannerTransitionR2, label: string): string[] {
  const violations: string[] = [];
  const byMoment = new Map<string, Array<BannerTransitionR2["observations"][number]>>();
  for (const observation of transition.observations) {
    byMoment.set(observation.moment, [...(byMoment.get(observation.moment) ?? []), observation]);
    const expectedKind = BANNER_MOMENT_PHASES[observation.moment];
    if (phaseKindAt(run, observation.phaseId) !== expectedKind) {
      violations.push(`${label}: banner ${observation.moment} observation is tagged to a non-${expectedKind} phase`);
    }
    const span = run.phases[observation.phaseId];
    if (span !== undefined && (observation.atMs < span.startedAtMs || observation.atMs > span.endedAtMs)) {
      violations.push(`${label}: banner ${observation.moment} observation lies outside its phase span`);
    }
  }
  for (const [moment, entries] of byMoment) {
    if (entries.length > 1) violations.push(`${label}: duplicate banner moment ${moment}`);
  }
  const before = byMoment.get("before-interaction")?.[0];
  const after = byMoment.get("after-interaction")?.[0];
  const reload = byMoment.get("after-reload")?.[0];
  if (before !== undefined && after !== undefined && !(before.atMs < after.atMs)) {
    violations.push(`${label}: banner chronology inverted (before-interaction is not before after-interaction)`);
  }
  if (after !== undefined && reload !== undefined && !(after.atMs < reload.atMs)) {
    violations.push(`${label}: banner chronology inverted (after-reload precedes after-interaction)`);
  }
  return violations;
}

function consentViolationsR2(run: ScanRunV2R2, label: string): string[] {
  const violations: string[] = [];
  const consent = run.evidence.consent;

  if (run.conditions.consent === "observe") {
    if (consent !== undefined) violations.push(`${label}: consent evidence present on an observe-mode run`);
    return violations;
  }
  if (consent === undefined) {
    violations.push(`${label}: consent-mode run carries no consent evidence`);
    return violations;
  }
  if (consent.mode !== run.conditions.consent) {
    violations.push(`${label}: consent evidence mode disagrees with the run's consent condition`);
  }
  if (!consent.interactionAttempted && consent.controlActivated) {
    violations.push(`${label}: a control was activated without an interaction attempt`);
  }
  if (run.detectors["consent-banner"].status !== "complete" && run.detectors["consent-banner"].status !== "partial") {
    violations.push(`${label}: consent evidence present but the consent-banner detector did not report activity`);
  }
  // RFC 15.4: every consent-mode run carries a consent-interaction phase (the
  // interaction was at least attempted). The zero-observation placeholder's
  // phaseId also anchors to it, so its absence must reject, never default.
  if (!run.phases.some((span) => span.kind === "consent-interaction")) {
    violations.push(`${label}: consent-mode run has no consent-interaction phase`);
  }

  const observations = consent.verificationObservations;

  // Result blocks: structurally optional, semantically MANDATORY on every
  // present observation of an r2 consent run (RFC 15.4). Cascading checks are
  // skipped when one is missing so the defect stays singular.
  let resultsComplete = true;
  for (const [index, observation] of observations.entries()) {
    if (observation.result === undefined) {
      violations.push(`${label}: consent observation ${index} is missing its r2 result block`);
      resultsComplete = false;
    }
  }
  if (!resultsComplete) return violations;

  const sequences = new Set<number>();
  for (const [index, observation] of observations.entries()) {
    const result = observation.result!;
    if (!CONSENT_INTERPRETER_METHODS.has(observation.method)) {
      violations.push(`${label}: consent observation ${index} uses an unknown interpreter method`);
    }
    if (
      WEAK_CONSENT_INTERPRETERS.has(observation.method) &&
      observation.observed !== null &&
      observation.observed !== "unknown"
    ) {
      violations.push(`${label}: consent observation ${index} claims a definite state from a weak UI method`);
    }
    const phaseKind = phaseKindAt(run, observation.phaseId);
    if (phaseKind === null || !CONSENT_OBSERVATION_PHASES.has(phaseKind)) {
      violations.push(`${label}: consent observation ${index} is tagged to a non-consent phase`);
    }
    if ((result.outcome === "read") !== (observation.observed !== null)) {
      violations.push(`${label}: consent observation ${index} outcome ${result.outcome} disagrees with its observed state`);
    }
    const derivedConsistency = deriveObservationConsistency(consent.mode, observation.observed);
    if (observation.consistentWithChoice !== derivedConsistency) {
      violations.push(`${label}: consent observation ${index} consistency does not derive from its observed state`);
    }
    if (sequences.has(result.sequence)) {
      violations.push(`${label}: duplicate consent observation sequence ${result.sequence}`);
    }
    sequences.add(result.sequence);
  }

  for (let index = 1; index < observations.length; index += 1) {
    const previous = observations[index - 1];
    const current = observations[index];
    const ordered =
      previous.phaseId < current.phaseId ||
      (previous.phaseId === current.phaseId && previous.result!.sequence < current.result!.sequence);
    if (!ordered) {
      violations.push(`${label}: consent observations are not ordered by (phaseId, sequence) at index ${index}`);
    }
  }

  if (consent.bannerTransition !== undefined) {
    violations.push(...bannerViolations(run, consent.bannerTransition, label));
  }

  const derivedState = deriveChoiceStateR2(run, consent);
  if (consent.choiceState !== derivedState) {
    violations.push(`${label}: choiceState ${consent.choiceState} does not derive from the observations (expected ${derivedState})`);
  }
  const derivedReload = deriveReverifiedAfterReloadR2(run, consent);
  if (consent.reverifiedAfterReload !== derivedReload) {
    violations.push(`${label}: reverifiedAfterReload disagrees with the recorded strong observations`);
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Structured arm facts (RFC 15.3)
// ---------------------------------------------------------------------------

export function gpcObservedFromFacts(facts: GpcVerificationFactsR2): AxisState | null {
  if (facts.header === "confirmed-present" && facts.jsSignal === "confirmed-true") return "gpc:on";
  if (facts.header === "confirmed-absent" && (facts.jsSignal === "confirmed-absent" || facts.jsSignal === "confirmed-false")) {
    return "gpc:off";
  }
  return null;
}

export function shieldsObservedFromFacts(facts: ShieldsVerificationFactsR2): AxisState | null {
  if (facts.engineLoaded && facts.applied && facts.requestsEvaluated > 0) return "shields:block-simulation";
  if (facts.engineLoaded && !facts.applied && facts.requestsEvaluated > 0) return "shields:classification";
  if (!facts.engineLoaded) return "shields:off";
  return null; // an engine that evaluated nothing verified nothing
}

function factsViolationsR2(run: ScanRunV2R2, label: string): string[] {
  const violations: string[] = [];
  const facts = run.verificationFacts;
  if (facts === undefined) return violations;

  const gpc = facts.gpc;
  if (gpc !== undefined) {
    if (phaseKindAt(run, gpc.phaseId) !== "passive-load") {
      violations.push(`${label}: gpc facts are tagged to a non-passive-load phase`);
    }
    // RFC 15.3 GPC sampling semantics (closed): the referenced phase must
    // contain an observed eligible first-party navigation (a retained
    // first-party document request in that phase). Without one, both signals
    // are "unobservable"; any confirmed-*/read state is invalid.
    const eligibleNavigation = run.evidence.requests.some(
      (request) => request.phaseId === gpc.phaseId && request.resourceType === "document" && !request.thirdParty
    );
    if (!eligibleNavigation && (gpc.header !== "unobservable" || gpc.jsSignal !== "unobservable")) {
      violations.push(`${label}: gpc facts claim signal states without an observed eligible first-party navigation`);
    }
  }

  const shields = facts.shields;
  if (shields !== undefined) {
    if (!(shields.requestsActuallyBlocked <= shields.requestsMatched && shields.requestsMatched <= shields.requestsEvaluated)) {
      violations.push(`${label}: shields counters violate blocked <= matched <= evaluated`);
    }
    if (!shields.engineLoaded && (shields.applied || shields.requestsEvaluated !== 0 || shields.requestsMatched !== 0 || shields.requestsActuallyBlocked !== 0)) {
      violations.push(`${label}: shields facts claim activity from an unloaded engine`);
    }
    if (!shields.applied && shields.requestsActuallyBlocked !== 0) {
      violations.push(`${label}: shields facts claim actual blocking without an applied simulation`);
    }
    if (shields.engineLoaded !== (run.toolchain.adblock !== null)) {
      violations.push(`${label}: shields engineLoaded disagrees with the toolchain adblock block`);
    }
    if (phaseKindAt(run, shields.phaseId) !== "passive-load") {
      violations.push(`${label}: shields facts are tagged to a non-passive-load phase`);
    }
    const flagged = run.evidence.requests.filter((request) => request.blockedByShields === true).length;
    if (run.conditions.shields === "block-simulation" && flagged !== 0) {
      violations.push(`${label}: a block-simulation run retains blockedByShields flags in evidence`);
    }
    if (run.conditions.shields === "classification" && flagged !== shields.requestsMatched) {
      violations.push(`${label}: retained blockedByShields flags disagree with shields requestsMatched`);
    }
    const summaryBlocked = run.summary.counts.shieldsBlockedRequests;
    if (!shields.engineLoaded) {
      if (summaryBlocked !== undefined) {
        violations.push(`${label}: summary carries shieldsBlockedRequests without a loaded engine`);
      }
    } else {
      const expected =
        run.conditions.shields === "block-simulation" ? shields.requestsActuallyBlocked : shields.requestsMatched;
      if (summaryBlocked !== expected) {
        violations.push(`${label}: summary shieldsBlockedRequests does not derive from the shields facts`);
      }
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Arms and experiments (RFC 15.3/15.4/15.6)
// ---------------------------------------------------------------------------

function armViolationsR2(arm: ArmVerification, run: ScanRunV2R2, axis: InterventionAxis, label: string): string[] {
  const violations: string[] = [];
  if (arm.axis !== axis) violations.push(`${label}: arm axis ${arm.axis} differs from experiment axis ${axis}`);
  if (arm.expected !== axisStateFor(axis, run.conditions)) {
    violations.push(`${label}: arm expected state does not match the run's declared condition`);
  }

  if (axis === "consent") {
    const choiceState = run.evidence.consent === undefined ? undefined : deriveChoiceStateR2(run, run.evidence.consent);
    const mappedOutcome = choiceState === undefined ? "inconclusive" : CONSENT_CHOICE_TO_ARM_OUTCOME[choiceState];
    if (arm.outcome !== mappedOutcome) {
      violations.push(`${label}: arm outcome ${arm.outcome} disagrees with the derived choiceState`);
    }
    const expectedObserved = choiceState === "verified" ? arm.expected : null;
    if (arm.observed !== expectedObserved) {
      violations.push(`${label}: consent arm observed state does not derive from the choiceState`);
    }
    const compat = deriveConsentArmCompatR2(run);
    if (arm.method !== compat.method || arm.phaseId !== compat.phaseId) {
      violations.push(`${label}: consent arm method/phaseId do not match the establishing observation`);
    }
    return violations;
  }

  // GPC/Shields: the structured facts are the source of truth (RFC 15.3);
  // they are REQUIRED on both runs of the pair for the declared axis.
  const facts = axis === "gpc" ? run.verificationFacts?.gpc : run.verificationFacts?.shields;
  if (facts === undefined) {
    violations.push(`${label}: missing verificationFacts.${axis} for the declared intervention axis`);
    return violations;
  }
  if (arm.method !== facts.method) violations.push(`${label}: arm method does not match the facts'`);
  if (arm.phaseId !== facts.phaseId) violations.push(`${label}: arm phaseId does not match the facts'`);
  const derivedObserved =
    axis === "gpc"
      ? gpcObservedFromFacts(facts as GpcVerificationFactsR2)
      : shieldsObservedFromFacts(facts as ShieldsVerificationFactsR2);
  if (arm.observed !== derivedObserved) {
    violations.push(`${label}: arm observed state does not derive from the structured facts`);
  }
  const consistentOutcome: ArmVerification["outcome"] =
    derivedObserved === null ? "inconclusive" : derivedObserved === arm.expected ? "passed" : "failed";
  if (arm.outcome !== consistentOutcome) {
    violations.push(`${label}: arm outcome ${arm.outcome} disagrees with the facts-derived state`);
  }
  return violations;
}

function supportingPairViolations(
  experiment: InterventionExperimentR2,
  primaryBaseline: ScanRunV2R2,
  primaryVariant: ScanRunV2R2
): string[] {
  const violations: string[] = [];
  const pairs = experiment.supportingPairs ?? [];

  const pairIds = new Set<string>([experiment.pairId]);
  const runIds = new Set<string>([primaryBaseline.runId, primaryVariant.runId]);
  const primaryBaselineInterpreters = attemptedStrongInterpreters(primaryBaseline);
  const primaryVariantInterpreters = attemptedStrongInterpreters(primaryVariant);

  for (const [index, pair] of pairs.entries()) {
    const label = `supporting pair ${index}`;
    if (pairIds.has(pair.pairId)) violations.push(`${label}: duplicate pairId ${pair.pairId}`);
    pairIds.add(pair.pairId);
    for (const run of [pair.baseline, pair.variant]) {
      if (runIds.has(run.runId)) violations.push(`${label}: run ${run.runId} is reused across pairs`);
      runIds.add(run.runId);
    }

    violations.push(...runR2Violations(pair.baseline, `${label} baseline`));
    violations.push(...runR2Violations(pair.variant, `${label} variant`));

    // RFC 15.6: each supporting pair passes the SAME evaluator gates as the
    // primary: run completeness and the exact axis delta (the condition
    // fingerprint match below pins conditions to the primary's, but the gates
    // are normative and must hold in their own right).
    for (const [runLabel, run] of [["baseline", pair.baseline], ["variant", pair.variant]] as const) {
      if (run.quality.run.outcome !== "complete") {
        violations.push(`${label}: ${runLabel} run did not complete; the pair cannot support the experiment`);
      }
    }
    if (interventionAxisDelta(pair.baseline, pair.variant) !== experiment.axis) {
      violations.push(`${label}: runs do not differ on exactly the experiment axis`);
    }

    const chronological = pair.baseline.startedAt < pair.variant.startedAt;
    if ((pair.order === "AB") !== chronological) {
      violations.push(`${label}: declared order ${pair.order} disagrees with the runs' chronology`);
    }
    if (!subjectsMatch(pair.baseline, primaryBaseline) || !subjectsMatch(pair.variant, primaryBaseline)) {
      violations.push(`${label}: subject does not match the primary pair`);
    }
    if (pair.baseline.fingerprints.condition !== primaryBaseline.fingerprints.condition) {
      violations.push(`${label}: baseline condition fingerprint does not match the primary baseline`);
    }
    if (pair.variant.fingerprints.condition !== primaryVariant.fingerprints.condition) {
      violations.push(`${label}: variant condition fingerprint does not match the primary variant`);
    }
    for (const run of [pair.baseline, pair.variant]) {
      if (run.fingerprints.measurementEnvironment !== primaryBaseline.fingerprints.measurementEnvironment) {
        violations.push(`${label}: measurement environment does not match the primary pair`);
      }
    }

    violations.push(
      ...armViolationsR2(pair.verification.baseline, pair.baseline, experiment.axis, `${label} baseline arm`),
      ...armViolationsR2(pair.verification.variant, pair.variant, experiment.axis, `${label} variant arm`)
    );
    for (const arm of ["baseline", "variant"] as const) {
      if (pair.verification[arm].outcome !== "passed") {
        violations.push(`${label}: ${arm} arm did not pass; the pair cannot support the experiment`);
      }
    }
    if (experiment.axis === "consent") {
      // RFC 15.4: BOTH supporting runs' attempted-strong-interpreter sets must
      // equal the primary's key. When the primary's own arms disagree, its key
      // is undefined and no pair can support the experiment.
      for (const [runLabel, run] of [["baseline", pair.baseline], ["variant", pair.variant]] as const) {
        const interpreters = attemptedStrongInterpreters(run);
        if (
          !canonicallyEqual(interpreters, primaryBaselineInterpreters) ||
          !canonicallyEqual(interpreters, primaryVariantInterpreters)
        ) {
          violations.push(`${label}: ${runLabel} interpreter set does not match the primary pair`);
        }
      }
    }
  }

  // Derived experiment evidence (RFC 15.6); strength is held at
  // observed-difference unconditionally in r2.
  const orders = new Set<string>([experiment.order, ...pairs.map((pair) => pair.order)]);
  const derivedEvidence = {
    pairs: 1 + pairs.length,
    counterbalanced: orders.has("AB") && orders.has("BA") && pairs.length > 0,
    strength: "observed-difference" as const
  };
  if (!canonicallyEqual(experiment.evidence, derivedEvidence)) {
    violations.push(
      `experiment: evidence does not derive from the embedded pairs (expected ${JSON.stringify(derivedEvidence)})`
    );
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Runs and reports
// ---------------------------------------------------------------------------

function runR2Violations(run: ScanRunV2R2, label: string): string[] {
  return [
    // Shields facts supersede the r1 evidence-flag summary rule (RFC 15.3).
    ...scanRunCoreViolations(run, label, { skipShieldsSummary: run.verificationFacts?.shields !== undefined }),
    ...consentViolationsR2(run, label),
    ...factsViolationsR2(run, label)
  ];
}

export function scanReportV2R2SemanticViolations(report: PublicScanReportV2R2): string[] {
  if (report.reportType === "single") return runR2Violations(report.run, "run");

  const violations: string[] = [
    ...runR2Violations(report.baseline, "baseline"),
    ...runR2Violations(report.variant, "variant")
  ];

  const experiment = report.experiment;
  if (experiment.kind === "intervention") {
    violations.push(
      ...armViolationsR2(experiment.verification.baseline, report.baseline, experiment.axis, "baseline arm"),
      ...armViolationsR2(experiment.verification.variant, report.variant, experiment.axis, "variant arm")
    );
    const chronological = report.baseline.startedAt < report.variant.startedAt;
    if ((experiment.order === "AB") !== chronological) {
      violations.push("experiment: declared order disagrees with the runs' chronology");
    }
    violations.push(...supportingPairViolations(experiment, report.baseline, report.variant));
  }

  const strippedExperiment: Experiment =
    experiment.kind === "intervention"
      ? (({ supportingPairs: _supportingPairs, ...rest }) => rest)(experiment)
      : experiment;
  const derived = evaluateComparabilityR2(strippedExperiment, report.baseline, report.variant);
  if (report.comparability.evaluatorVersion !== derived.evaluatorVersion) {
    violations.push("comparability: evaluatorVersion disagrees with the r2 evaluator");
  }
  if (report.comparability.metricRegistryVersion !== derived.metricRegistryVersion) {
    violations.push("comparability: metricRegistryVersion disagrees with the r2 evaluator");
  }
  if (!canonicallyEqual(report.comparability.pairValidity, derived.pairValidity)) {
    violations.push("comparability: pairValidity disagrees with the r2 evaluator");
  }
  for (const family of Object.keys(derived.perMetric) as Array<keyof Comparability["perMetric"]>) {
    if (!canonicallyEqual(report.comparability.perMetric[family], derived.perMetric[family])) {
      const reasons = derived.perMetric[family].reasons.join(", ") || "none";
      violations.push(`comparability: perMetric.${family} disagrees with the r2 evaluator (derived reasons: ${reasons})`);
    }
  }
  if (report.comparability.interventionVerified !== derived.interventionVerified) {
    violations.push("comparability: interventionVerified disagrees with the arm outcomes");
  }

  const rebuiltDiff = buildComparisonDiffV2(report.baseline, report.variant, report.comparability.perMetric);
  if (!canonicallyEqual(report.diff, rebuiltDiff)) {
    violations.push("diff: does not equal the diff rebuilt from the two runs");
  }
  return violations;
}
