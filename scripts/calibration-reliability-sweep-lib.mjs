/**
 * Bare-load reliability sweep for a calibration sampling frame.
 *
 * WHY THIS MODULE EXISTS AS A SEPARATE NARROWING LAYER.
 *
 * The sweep answers one question: can this candidate URL be loaded reliably
 * enough to be worth labeling? Answering it requires running the scanner, and
 * the scanner produces detector output. Preregistration is void if the frame is
 * chosen after predictions are seen -- selecting on the detector's own answers
 * is how a calibration study silently becomes a measurement of itself.
 *
 * So the separation cannot be a convention that reviewers remember. It is
 * enforced three ways here:
 *
 *   1. `bareLoadOutcome` is the ONLY way a report enters this module, and it
 *      returns a fixed, closed record. Anything it does not name is gone before
 *      sweep logic runs.
 *   2. `assertBareLoadOnly` refuses any object carrying a key outside that
 *      vocabulary, so a future edit that widens the projection fails loudly
 *      instead of quietly admitting evidence.
 *   3. The receipt is built only from projected outcomes, and is re-checked on
 *      the way out. A receipt is a published artifact; it must be provably free
 *      of predictions, not believed to be.
 *
 * The sweep deliberately cannot tell you whether a site is a positive. That is
 * the point. A frame built from these receipts is blind to the detector.
 */

/**
 * The complete vocabulary a sweep may observe. Load facts only.
 *
 * Every field here answers "did the page load, and was the visit sound enough
 * to label later" -- never "what did the detector find". `capturedFamilies` is
 * deliberately a COUNT of censored families rather than which ones: knowing
 * that cname evidence specifically was censored is a weak signal about the
 * detector, and the sweep has no need for it.
 */
export const BARE_LOAD_OUTCOME_FIELDS = Object.freeze([
  "caseId",
  "pass",
  "observedAt",
  "loaded",
  "status",
  "navigationSettled",
  "subjectVerified",
  "botWalled",
  "runOutcome",
  "censoredFamilyCount",
  "requestEvidenceComplete"
]);

const BARE_LOAD_FIELD_SET = new Set(BARE_LOAD_OUTCOME_FIELDS);

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

/**
 * The capture-loss detail the producer records when the page subject could not
 * be verified. Pinned to `PAGE_SUBJECT_CAPTURE_LOSS_DETAIL` in
 * lib/bot-wall-classifier.ts by a guard in this module's test, because a token
 * restated in two files that drift is this repository's most common defect.
 */
const PAGE_SUBJECT_CAPTURE_LOSS_DETAIL = "page-subject-validity";

function require(condition, message) {
  if (!condition) throw new Error(message);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Refuse anything carrying a key outside the load vocabulary.
 *
 * This is the enforcement the frame-construction draft said nothing currently
 * provided. It runs on every projected case AND on the assembled receipt, so
 * neither a widened projection nor a receipt field added later can carry a
 * prediction into a published artifact.
 */
export function assertBareLoadOnly(outcome, context = "bare-load outcome") {
  require(isRecord(outcome), `${context} must be a record`);
  for (const key of Object.keys(outcome)) {
    require(
      BARE_LOAD_FIELD_SET.has(key),
      `${context} carries "${key}", which is not a bare-load field; the reliability sweep must never observe detector output`
    );
  }
  return outcome;
}

/**
 * Project a scan report down to load facts.
 *
 * Takes the whole report and returns only the closed record. Callers never see
 * the report again, so there is no path by which sweep logic can consult
 * evidence: the narrowing happens once, here, at ingestion.
 */
export function bareLoadOutcome(caseId, report, { pass, observedAt } = {}) {
  require(
    typeof caseId === "string" && caseId.length > 0,
    "bare-load outcome requires a case id"
  );
  require(
    pass === 1 || pass === 2,
    "bare-load outcome requires an explicit sweep pass number (1 or 2)"
  );
  require(
    typeof observedAt === "string" && ISO_UTC.test(observedAt),
    "bare-load outcome requires an ISO-8601 UTC observedAt supplied by the caller"
  );

  // EVERY field below defaults to the INELIGIBLE value. Absence of evidence is
  // never evidence of soundness: a report missing its quality ledger tells us
  // the visit was not verified, not that it was fine. The first version of this
  // function defaulted navigationSettled, runOutcome and requestEvidenceComplete
  // the other way, and `{run:{summary:{status:200}}}` -- a report with no
  // quality data at all -- came out eligible.
  const unverified = {
    caseId,
    pass,
    observedAt,
    loaded: false,
    status: null,
    navigationSettled: false,
    subjectVerified: false,
    botWalled: true,
    runOutcome: "unavailable",
    censoredFamilyCount: 0,
    requestEvidenceComplete: false
  };

  const run = isRecord(report) ? (report.run ?? report.baseline ?? null) : null;
  // qualityFacts is required, not optional: it is where the producer records
  // its own verdicts. Without it there is nothing to read but prose, and this
  // module does not run semantic r2 validation, so a report missing it is
  // unverified rather than fine.
  if (
    !isRecord(run) ||
    !isRecord(run.quality) ||
    !isRecord(run.quality.byFamily) ||
    !isRecord(run.qualityFacts)
  ) {
    return assertBareLoadOnly(unverified);
  }

  const facts = run.qualityFacts;
  const status = typeof run.summary?.status === "number" ? run.summary.status : null;
  const byFamily = run.quality.byFamily;
  const families = Object.values(byFamily);
  const captureLoss = Array.isArray(facts.captureLoss) ? facts.captureLoss : [];

  return assertBareLoadOnly({
    caseId,
    pass,
    observedAt,
    loaded: status !== null && status >= 200 && status < 400,
    status,
    // Read the producer's own recorded facts, never its English. The warning
    // strings restate these; a restatement drifts, and the report's canonical
    // botWallTitleMatched is the thing the evaluator actually decided.
    navigationSettled: facts.navigationSettled === true,
    botWalled: facts.botWallTitleMatched !== false,
    subjectVerified: !captureLoss.some(
      (loss) => loss?.detail === PAGE_SUBJECT_CAPTURE_LOSS_DETAIL
    ),
    runOutcome:
      typeof run.quality.run?.outcome === "string" ? run.quality.run.outcome : "unrecorded",
    censoredFamilyCount: families.filter((entry) => entry?.outcome === "censored").length,
    requestEvidenceComplete: byFamily.requests?.outcome === "complete"
  });
}

/**
 * A case is sweep-eligible when the visit was sound enough that a later labeled
 * run is likely to be usable. This reads ONLY projected load facts.
 */
/**
 * One pass is sound. Every clause demands exact positive evidence.
 *
 * `censoredFamilyCount === 0` is the approved zero-censoring policy, not
 * strictness for its own sake: one censored family on acquisition day kills the
 * study, so a candidate that censored anything during screening has already
 * shown it carries that risk.
 */
export function bareLoadPassSound(outcome) {
  assertBareLoadOnly(outcome, "eligibility input");
  return (
    outcome.loaded &&
    outcome.navigationSettled &&
    outcome.subjectVerified &&
    !outcome.botWalled &&
    outcome.runOutcome === "complete" &&
    outcome.requestEvidenceComplete &&
    outcome.censoredFamilyCount === 0
  );
}

export const SWEEP_MINIMUM_PASS_SEPARATION_MS = 48 * 60 * 60 * 1000;

/**
 * A candidate joins the eligible pool only if BOTH passes were sound and they
 * are at least 48 hours apart, which is what the frame-construction draft
 * requires. A single sound visit says nothing about reliability; two visits an
 * hour apart mostly re-measure one cache state.
 */
export function candidateEligible(outcomes) {
  require(Array.isArray(outcomes), "candidate eligibility requires its pass outcomes");
  const passes = new Map();
  for (const outcome of outcomes) {
    assertBareLoadOnly(outcome, "candidate eligibility input");
    require(!passes.has(outcome.pass), `duplicate pass ${outcome.pass} for ${outcome.caseId}`);
    passes.set(outcome.pass, outcome);
  }
  const first = passes.get(1);
  const second = passes.get(2);
  if (first === undefined || second === undefined) return false;
  if (!bareLoadPassSound(first) || !bareLoadPassSound(second)) return false;
  // Directed, not absolute. `Math.abs` accepted pass 2 occurring 48 hours
  // BEFORE pass 1, which is not a screening interval at all -- it is two visits
  // labelled out of order, and it would let a candidate qualify on a
  // chronology that never happened.
  const separation = Date.parse(second.observedAt) - Date.parse(first.observedAt);
  return separation >= SWEEP_MINIMUM_PASS_SEPARATION_MS;
}

export const CALIBRATION_RELIABILITY_SWEEP_RECEIPT_KIND =
  "site-behavior-calibration-reliability-sweep";

/**
 * Build the sweep receipt.
 *
 * `outcomes` must already be projections. The receipt records per-case load
 * outcome and the aggregate, and is re-checked field by field before it is
 * returned, so the published artifact provably carries no prediction.
 */
const REQUIRED_IDENTITY_FIELDS = Object.freeze([
  "buildCommit",
  "runtime",
  "runnerLabel",
  "egress"
]);

/**
 * Build the sweep receipt.
 *
 * A receipt that records only outcomes proves nothing: it cannot say WHICH
 * candidate set was swept, under WHAT condition, by WHICH build, so it cannot
 * be checked against the frame that was later frozen from it. The identity
 * below is what makes the receipt falsifiable rather than merely tidy, and all
 * of it is supplied by the caller because none of it is derivable from the
 * projections.
 *
 * `outcomes` must already be projections. Every case is re-checked field by
 * field on the way out: a receipt is a published artifact, so it must be
 * provably free of predictions rather than believed to be.
 */
export function buildReliabilitySweepReceipt({
  studyId,
  sweptAt,
  measurementCondition,
  candidateSetDigest,
  sourceDigests,
  identity,
  outcomes
}) {
  require(
    typeof studyId === "string" && studyId.length > 0,
    "reliability sweep receipt requires a study id"
  );
  require(
    typeof sweptAt === "string" && ISO_UTC.test(sweptAt),
    "reliability sweep receipt requires an ISO-8601 UTC sweptAt supplied by the caller"
  );
  require(
    typeof candidateSetDigest === "string" && /^[0-9a-f]{64}$/.test(candidateSetDigest),
    "reliability sweep receipt requires the sha256 of the exact candidate set it swept"
  );
  require(
    isRecord(measurementCondition) &&
      typeof measurementCondition.device === "string" &&
      typeof measurementCondition.consentMode === "string" &&
      typeof measurementCondition.gpcEnabled === "boolean",
    "reliability sweep receipt requires the exact measurement condition (device, consentMode, gpcEnabled)"
  );
  require(isRecord(identity), "reliability sweep receipt requires producer identity");
  for (const field of REQUIRED_IDENTITY_FIELDS) {
    require(
      typeof identity[field] === "string" && identity[field].length > 0,
      `reliability sweep receipt identity requires ${field}`
    );
  }
  require(
    isRecord(sourceDigests) && Object.keys(sourceDigests).length > 0,
    "reliability sweep receipt requires the digests of the sources it was produced from"
  );
  for (const [name, digest] of Object.entries(sourceDigests)) {
    require(
      typeof digest === "string" && /^[0-9a-f]{64}$/.test(digest),
      `reliability sweep source digest for ${name} must be a sha256`
    );
  }
  require(Array.isArray(outcomes) && outcomes.length > 0, "reliability sweep observed no cases");

  const byCase = new Map();
  for (const outcome of outcomes) {
    assertBareLoadOnly(outcome, "receipt case");
    const passes = byCase.get(outcome.caseId) ?? [];
    require(
      !passes.some((existing) => existing.pass === outcome.pass),
      `duplicate pass ${outcome.pass} for case ${outcome.caseId} in reliability sweep`
    );
    passes.push(outcome);
    byCase.set(outcome.caseId, passes);
  }

  const cases = [...byCase.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([caseId, passes]) => ({
      caseId,
      eligible: candidateEligible(passes),
      passes: [...passes].sort((a, b) => a.pass - b.pass)
    }));

  const eligible = cases.filter((entry) => entry.eligible).length;
  const receipt = {
    kind: CALIBRATION_RELIABILITY_SWEEP_RECEIPT_KIND,
    studyId,
    sweptAt,
    measurementCondition: {
      device: measurementCondition.device,
      consentMode: measurementCondition.consentMode,
      gpcEnabled: measurementCondition.gpcEnabled
    },
    candidateSetDigest,
    sourceDigests: Object.fromEntries(
      Object.entries(sourceDigests).sort(([a], [b]) => a.localeCompare(b))
    ),
    identity: Object.fromEntries(REQUIRED_IDENTITY_FIELDS.map((f) => [f, identity[f]])),
    minimumPassSeparationMs: SWEEP_MINIMUM_PASS_SEPARATION_MS,
    observedCandidates: cases.length,
    eligibleCandidates: eligible,
    // A rate, not a verdict. Whether the pool clears is a preregistered
    // threshold applied by a human, not something this producer decides.
    eligibleFraction: eligible / cases.length,
    cases
  };
  for (const entry of receipt.cases) {
    for (const pass of entry.passes) assertBareLoadOnly(pass, "assembled receipt case");
  }
  return receipt;
}

/**
 * Deterministic bytes for the receipt: keys sorted at every level, so two
 * sweeps of the same pool under the same identity produce byte-identical
 * artifacts and any difference is a real difference.
 */
export function serializeReliabilitySweepReceipt(receipt) {
  const canonical = (value) => {
    if (Array.isArray(value)) return value.map(canonical);
    if (isRecord(value)) {
      return Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((key) => [key, canonical(value[key])])
      );
    }
    return value;
  };
  return `${JSON.stringify(canonical(receipt), null, 2)}\n`;
}
