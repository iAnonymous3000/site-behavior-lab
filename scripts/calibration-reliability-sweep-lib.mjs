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
 * Every field here answers "did the page load, and was the visit verified" or
 * "which evidence families survived" -- never "what did the detector find".
 * `censoredFamilies` carries family IDENTITY, not just a count. An earlier
 * revision kept only the count so the sweep could not even weakly hint at a
 * detector; the step-3 censoring decision
 * (docs/calibration-censoring-policy-decision.md) reverses that deliberately:
 * per-detector policies are sized from per-family loss structure, so the sweep
 * must report WHICH input families are lossy. The anti-selection property
 * moves to the eligibility boundary instead: `candidateEligible` reads load
 * validity only, so the frame can never be selected on input completeness,
 * and predictions remain unrepresentable in this vocabulary either way.
 */
export const BARE_LOAD_OUTCOME_FIELDS = Object.freeze([
  "caseId",
  "pass",
  "observedAt",
  "loaded",
  "status",
  "statusAgrees",
  "navigationSettled",
  "subjectVerified",
  "botWalled",
  "runOutcome",
  "factsLedgerRecorded",
  "recordedCaptureLosses",
  "budgetsExhausted",
  "familyLedgerReported",
  "familyLedgerComplete",
  "ledgersConsistent",
  "censoredFamilies",
  "requestEvidenceComplete"
]);

/**
 * The six families a Node run records, pinned to `EVIDENCE_FAMILIES` in
 * lib/scan-report-v2.ts by a guard in this module's test.
 *
 * A ledger carrying only some of them is not a clean run: it is a run whose
 * producer never reported on the rest. Reading it as "nothing censored" is the
 * same fail-open as an absent array, one level up.
 */
export const EXPECTED_EVIDENCE_FAMILIES = Object.freeze([
  "requests",
  "cookies",
  "storage",
  "fingerprinting",
  "detector-output",
  "consent-verification"
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
  // The one array-valued field is closed by VALUE as well as by key: a
  // hand-edited artifact must not be able to smuggle arbitrary strings
  // (including detector names) through it, and the sorted-unique requirement
  // keeps the persisted artifact canonical.
  if ("censoredFamilies" in outcome) {
    const families = outcome.censoredFamilies;
    require(Array.isArray(families), `${context} censoredFamilies must be an array`);
    for (let index = 0; index < families.length; index += 1) {
      require(
        EXPECTED_EVIDENCE_FAMILIES.includes(families[index]),
        `${context} censoredFamilies carries "${families[index]}", which is not an evidence family`
      );
      require(
        index === 0 || families[index - 1] < families[index],
        `${context} censoredFamilies must be sorted and unique`
      );
    }
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
    Number.isSafeInteger(pass) && pass >= 1 && pass <= MAX_SWEEP_ROUNDS,
    `bare-load outcome requires an explicit sweep round number (1 to ${MAX_SWEEP_ROUNDS})`
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
    statusAgrees: false,
    navigationSettled: false,
    subjectVerified: false,
    botWalled: true,
    runOutcome: "unavailable",
    factsLedgerRecorded: false,
    recordedCaptureLosses: 0,
    budgetsExhausted: 0,
    familyLedgerReported: false,
    familyLedgerComplete: false,
    ledgersConsistent: false,
    censoredFamilies: [],
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

  // `quality.byFamily` is DERIVED; `qualityFacts` is what the producer
  // RECORDED. This module runs no semantic r2 validation, so it cannot assume
  // the two agree -- a stale or hand-edited ledger can say "complete" beside a
  // recorded request-capture loss. Both ledgers must be present and both must
  // say nothing was lost, and an absent array is a missing ledger rather than
  // an empty one.
  const factsLedgerRecorded =
    Array.isArray(facts.captureLoss) && Array.isArray(facts.budgetsExhausted);
  const captureLoss = factsLedgerRecorded ? facts.captureLoss : null;

  // The summary and the recorded facts are two statements about one visit. This
  // module runs no semantic validation, so a disagreement between them is not
  // something it can resolve -- and it must not pick the reassuring one. A
  // summary reading 200 beside a recorded 403 is an unverified report.
  const statusAgrees = status !== null && facts.status === status;

  return assertBareLoadOnly({
    caseId,
    pass,
    observedAt,
    loaded: status !== null && status >= 200 && status < 400,
    status,
    statusAgrees,
    // Read the producer's own recorded facts, never its English. The warning
    // strings restate these; a restatement drifts, and the report's canonical
    // botWallTitleMatched is the thing the evaluator actually decided.
    navigationSettled: facts.navigationSettled === true,
    botWalled: facts.botWallTitleMatched !== false,
    subjectVerified:
      captureLoss !== null &&
      !captureLoss.some((loss) => loss?.detail === PAGE_SUBJECT_CAPTURE_LOSS_DETAIL),
    runOutcome:
      typeof run.quality.run?.outcome === "string" ? run.quality.run.outcome : "unrecorded",
    factsLedgerRecorded,
    recordedCaptureLosses: captureLoss === null ? 0 : captureLoss.length,
    budgetsExhausted: factsLedgerRecorded ? facts.budgetsExhausted.length : 0,
    // Reported and complete are different statements: a producer that never
    // spoke about a family is an unverified report (validity), while a
    // producer that reported a family censored is a verified report with an
    // input loss (readiness).
    familyLedgerReported: EXPECTED_EVIDENCE_FAMILIES.every((family) =>
      isRecord(byFamily[family])
    ),
    familyLedgerComplete: EXPECTED_EVIDENCE_FAMILIES.every(
      (family) => byFamily[family]?.outcome === "complete"
    ),
    censoredFamilies: EXPECTED_EVIDENCE_FAMILIES.filter(
      (family) => byFamily[family]?.outcome === "censored"
    ),
    // Per-family agreement between the two ledgers, in the one direction this
    // module refuses: every RECORDED loss must name a family the derived
    // ledger admits is censored. A loss against a family claiming complete is
    // the reassuring-direction contradiction, whichever other families were
    // censored; a loss entry whose family this module cannot recognize is
    // unverifiable and fails closed. The inverse direction (a censored family
    // with no recorded loss) is the HARSH direction and stays acceptable.
    // Budget entries carry no family this module can attribute without
    // semantic knowledge, so budgets keep the whole-run rule in the validity
    // predicate below.
    ledgersConsistent:
      captureLoss !== null &&
      captureLoss.every(
        (loss) =>
          typeof loss?.family === "string" &&
          EXPECTED_EVIDENCE_FAMILIES.includes(loss.family) &&
          byFamily[loss.family]?.outcome === "censored"
      ),
    requestEvidenceComplete: byFamily.requests?.outcome === "complete"
  });
}

/**
 * BARE-LOAD VALIDITY: the visit happened, was verified, and produced a
 * complete run whose producer spoke about every family. Every clause demands
 * exact positive evidence. This is the eligibility predicate.
 *
 * What is deliberately NOT here: input completeness. Under the step-3
 * censoring decision, policy C conserves cases whose evidence families were
 * lost, so screening a candidate out for a censored family would re-create
 * policy A at the frame boundary AND bias the frame toward easy-to-measure
 * sites, which is the exact selection-on-measurement-difficulty hazard that
 * makes a B rate subpopulation-scoped. Input losses are REPORTED (see
 * `allEvidenceFamiliesComplete` and the receipt diagnostics), never screened
 * on.
 */
export function bareLoadValid(outcome) {
  assertBareLoadOnly(outcome, "eligibility input");
  return (
    outcome.loaded &&
    // Two statements about one visit must agree; this module cannot adjudicate
    // a disagreement, so it refuses the case instead of choosing a side.
    outcome.statusAgrees &&
    outcome.navigationSettled &&
    outcome.subjectVerified &&
    !outcome.botWalled &&
    outcome.runOutcome === "complete" &&
    // Every expected family REPORTED (whatever its outcome). A partial ledger
    // is a producer that never spoke about the rest: an unverified report,
    // not a clean run with losses.
    outcome.familyLedgerReported &&
    // The recorded-facts ledger must exist. The derived family view alone is
    // not enough: it can say "complete" beside a recorded capture loss, and
    // nothing here validates that they agree.
    outcome.factsLedgerRecorded &&
    // The two ledgers must not disagree in the reassuring direction, checked
    // PER FAMILY for recorded losses: a loss recorded against a family whose
    // derived entry claims complete is refused even when some other family is
    // censored (the adversarial review showed the whole-run version of this
    // clause absolved exactly that shape). Budgets cannot be attributed to a
    // family without semantic knowledge this module refuses to hold, so an
    // exhausted budget is refused only in the fully reassuring case, beside a
    // family ledger claiming everything completed; beside any censored family
    // it is the conserved lossy shape and MUST stay valid, or the budget
    // clause would quietly re-create the policy-A screen for budget-lossy
    // sites.
    outcome.ledgersConsistent &&
    !(outcome.familyLedgerComplete && outcome.budgetsExhausted > 0)
  );
}

/**
 * DETECTOR-INPUT READINESS DIAGNOSTIC: every evidence family survived intact.
 * This is the old zero-censoring soundness rule, retained as a reported
 * statistic because it lower-bounds every per-detector scoreable rate; it is
 * no longer an eligibility criterion anywhere.
 */
export function allEvidenceFamiliesComplete(outcome) {
  assertBareLoadOnly(outcome, "readiness input");
  return (
    outcome.familyLedgerComplete &&
    outcome.factsLedgerRecorded &&
    outcome.recordedCaptureLosses === 0 &&
    outcome.budgetsExhausted === 0 &&
    outcome.requestEvidenceComplete &&
    outcome.censoredFamilies.length === 0
  );
}

export const SWEEP_MINIMUM_PASS_SEPARATION_MS = 48 * 60 * 60 * 1000;

/**
 * Multi-round collection (docs/reliability-sweep-cluster-design.md). Rounds 1
 * and 2 remain the ELIGIBILITY pair; rounds 3 and up exist so the loss bound
 * has independent time clusters, because the censoring analysis refuses
 * cluster bootstrapping below three clusters and calls two clusters an
 * iid-only diagnostic, never a design bound. Consecutive rounds are disjoint
 * sessions at least this far apart.
 */
export const SWEEP_MINIMUM_ROUND_SEPARATION_MS = 24 * 60 * 60 * 1000;
export const MAX_SWEEP_ROUNDS = 12;

/**
 * A candidate joins the eligible pool only if BOTH passes were bare-load
 * valid and they are at least 48 hours apart, which is what the
 * frame-construction draft requires. A single valid visit says nothing about
 * reliability; two visits an hour apart mostly re-measure one cache state.
 * Input losses do not disqualify; they are reported in the receipt
 * diagnostics for sizing.
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
  if (!bareLoadValid(first) || !bareLoadValid(second)) return false;
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
  // Sizing diagnostics, derived from projected facts only. familyCensorCounts
  // counts OUTCOMES (visits) across ALL candidates, eligible or not; extra
  // losses from invalid passes inflate apparent loss, which errs conservative.
  // allFamiliesCompleteBothPasses counts ELIGIBLE candidates whose every pass
  // kept every family: the readiness numerator must be a subset of the pool
  // the frame is drawn from, or a bot-walled site with clean ledgers inflates
  // readiness against a pool it can never join (the anti-conservative
  // direction the review flagged).
  const familyCensorCounts = {};
  let allFamiliesCompleteBothPasses = 0;
  for (const entry of cases) {
    for (const pass of entry.passes) {
      for (const family of pass.censoredFamilies) {
        familyCensorCounts[family] = (familyCensorCounts[family] ?? 0) + 1;
      }
    }
    if (
      entry.eligible &&
      entry.passes.length === 2 &&
      entry.passes.every((pass) => allEvidenceFamiliesComplete(pass))
    ) {
      allFamiliesCompleteBothPasses += 1;
    }
  }
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
    diagnostics: {
      allFamiliesCompleteBothPasses,
      familyCensorCounts: Object.fromEntries(
        Object.entries(familyCensorCounts).sort(([a], [b]) => a.localeCompare(b))
      )
    },
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
