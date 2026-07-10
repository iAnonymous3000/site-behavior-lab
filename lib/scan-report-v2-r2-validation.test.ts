/**
 * Adversarial suite for the v2 r2 validator/evaluator slice (RFC 14.3): the
 * strict structural validator, the a4 semantic derivations, and
 * reject-on-disagreement for every retained r1-derived field. Each MUST-REJECT
 * mutant asserts its SPECIFIC violation path, not merely rejection.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { isPublicScanReportV2 } from "./scan-report-v2-validation";
import { isEphemeralScanReportR2, isPublicScanReportV2R2 } from "./scan-report-v2-r2-validation";
import {
  attemptedStrongInterpreters,
  deriveChoiceStateR2,
  deriveConsentArmCompatR2,
  evaluateComparabilityR2,
  scanReportV2R2SemanticViolations
} from "./scan-report-v2-r2-evaluators";
import { CONSENT_VERIFICATION_UNAVAILABLE_METHOD, type PublicScanReportV2R2 } from "./scan-report-v2-r2";
import {
  makeConsentInterventionReportV2R2,
  makeConsentRunR2,
  makeConsentSingleReportV2R2,
  makeConsentSupportingPairReportV2R2,
  makeConsentUnavailableRunR2,
  makeConsentWithoutInteractionPhaseMutantR2,
  makeContradictedConsentRunR2,
  makeDescriptiveReportV2R2,
  makeDuplicateBannerMomentMutantR2,
  makeDuplicateSequenceMutantR2,
  makeFailedConsentRunR2,
  makeGpcInterventionReportV2R2,
  makeGpcUnobservedNavigationMutantR2,
  makeInterpreterMismatchMutantR2,
  makeInvertedBannerChronologyMutantR2,
  makeMalformedResultBlockMutantR2,
  makeMissingResultMutantR2,
  makePublicSingleReportV2R2,
  makeShieldsInterventionReportV2R2,
  makeSupportingPairIncompleteRunMutantR2,
  makeSupportingPairInterpreterParityMutantR2,
  makeSupportingPairInterventionReportV2R2,
  makeTemporalReportV2R2,
  makeWeakSignalConsentRunR2
} from "./scan-report-v2-r2-fixtures";

type AnyRecord = Record<string, any>;

function mutate<T>(fixture: T, apply: (draft: T) => void): T {
  const draft = structuredClone(fixture);
  apply(draft);
  return draft;
}

function singleWith(run: AnyRecord): PublicScanReportV2R2 {
  return { schemaVersion: 2, schemaRevision: 2, reportType: "single", run } as PublicScanReportV2R2;
}

function violationsOf(report: PublicScanReportV2R2): string[] {
  return scanReportV2R2SemanticViolations(report);
}

function assertSingleViolationPath(violations: string[], needle: string, label: string): void {
  assert.equal(violations.length > 0, true, `${label}: expected a violation`);
  assert.equal(
    violations.every((entry) => entry.includes(needle)),
    true,
    `${label}: expected only "${needle}" violations, got: ${JSON.stringify(violations)}`
  );
}

// ---------------------------------------------------------------------------
// Valid corpus: structural and semantic ground truth
// ---------------------------------------------------------------------------

const VALID_FIXTURES: Array<[string, () => PublicScanReportV2R2]> = [
  ["single", makePublicSingleReportV2R2],
  ["consent single", makeConsentSingleReportV2R2],
  ["consent unavailable", () => singleWith(makeConsentUnavailableRunR2())],
  ["consent weak-signal", () => singleWith(makeWeakSignalConsentRunR2())],
  ["consent failed", () => singleWith(makeFailedConsentRunR2())],
  ["consent contradicted", () => singleWith(makeContradictedConsentRunR2())],
  ["gpc intervention", makeGpcInterventionReportV2R2],
  ["shields intervention", makeShieldsInterventionReportV2R2],
  ["consent intervention", makeConsentInterventionReportV2R2],
  ["temporal", makeTemporalReportV2R2],
  ["descriptive", makeDescriptiveReportV2R2],
  ["supporting pair", makeSupportingPairInterventionReportV2R2],
  ["consent supporting pair", makeConsentSupportingPairReportV2R2]
];

test("every valid r2 fixture passes structural validation and has zero semantic violations", () => {
  for (const [label, make] of VALID_FIXTURES) {
    const fixture = make();
    assert.equal(isPublicScanReportV2R2(fixture), true, `${label}: structural`);
    assert.deepEqual(violationsOf(fixture), [], `${label}: semantic`);
    // r2 payloads are NOT r1 payloads: the r1 validator must reject them.
    assert.equal(isPublicScanReportV2(fixture), false, `${label}: r1 must reject revision 2`);
  }
});

test("consent derivations produce the five states from their fixtures", () => {
  const verified = makeConsentRunR2("reject-all");
  assert.equal(deriveChoiceStateR2(verified, verified.evidence.consent!), "verified");
  const unavailable = makeConsentUnavailableRunR2();
  assert.equal(deriveChoiceStateR2(unavailable, unavailable.evidence.consent!), "unavailable");
  const weak = makeWeakSignalConsentRunR2();
  assert.equal(deriveChoiceStateR2(weak, weak.evidence.consent!), "weak-signal");
  const failed = makeFailedConsentRunR2();
  assert.equal(deriveChoiceStateR2(failed, failed.evidence.consent!), "failed");
  const contradicted = makeContradictedConsentRunR2();
  assert.equal(deriveChoiceStateR2(contradicted, contradicted.evidence.consent!), "contradicted");

  // Zero observations select the closed placeholder, never a fabricated method.
  const compat = deriveConsentArmCompatR2(unavailable);
  assert.equal(compat.method, CONSENT_VERIFICATION_UNAVAILABLE_METHOD);
  assert.equal(unavailable.phases[compat.phaseId].kind, "consent-interaction");
});

// ---------------------------------------------------------------------------
// Structural default-deny over the r2 additions
// ---------------------------------------------------------------------------

test("unknown keys and bad enums in every r2 addition are rejected structurally", () => {
  const cases: Array<[string, PublicScanReportV2R2]> = [
    [
      "unknown key in verificationFacts",
      mutate(makeGpcInterventionReportV2R2(), (draft) => (((draft.baseline.verificationFacts as AnyRecord).extra = 1)))
    ],
    [
      "unknown key in gpc facts",
      mutate(makeGpcInterventionReportV2R2(), (draft) => (((draft.baseline.verificationFacts!.gpc as AnyRecord).screenshot = "x")))
    ],
    [
      "bad gpc header state",
      mutate(makeGpcInterventionReportV2R2(), (draft) => (((draft.baseline.verificationFacts!.gpc as AnyRecord).header = "maybe")))
    ],
    [
      "unknown key in shields facts",
      mutate(makeShieldsInterventionReportV2R2(), (draft) => (((draft.variant.verificationFacts!.shields as AnyRecord).extra = 1)))
    ],
    [
      "negative shields counter",
      mutate(makeShieldsInterventionReportV2R2(), (draft) => (((draft.variant.verificationFacts!.shields as AnyRecord).requestsEvaluated = -1)))
    ],
    [
      "unknown key in a result block",
      mutate(makeConsentSingleReportV2R2(), (draft) => (((draft.run.evidence.consent!.verificationObservations[0].result as AnyRecord).secret = "x")))
    ],
    [
      "errorCode on a read outcome",
      mutate(makeConsentSingleReportV2R2(), (draft) => (((draft.run.evidence.consent!.verificationObservations[0].result as AnyRecord).errorCode = "api-timeout")))
    ],
    [
      "wrong errorCode for a timeout",
      mutate(singleWith(makeFailedConsentRunR2()), (draft) => {
        ((draft as AnyRecord).run.evidence.consent.verificationObservations[1].result as AnyRecord).errorCode = "interpreter-threw";
      })
    ],
    [
      "unknown key in a banner observation",
      mutate(makeConsentSingleReportV2R2(), (draft) => (((draft.run.evidence.consent!.bannerTransition!.observations[0] as AnyRecord).extra = 1)))
    ],
    [
      "bad banner moment",
      mutate(makeConsentSingleReportV2R2(), (draft) => (((draft.run.evidence.consent!.bannerTransition!.observations[0] as AnyRecord).moment = "sometime")))
    ],
    [
      "unknown key in a supporting pair",
      mutate(makeSupportingPairInterventionReportV2R2(), (draft) => {
        if (draft.experiment.kind === "intervention") (draft.experiment.supportingPairs![0] as AnyRecord).extra = 1;
      })
    ],
    [
      "supportingPairs on a temporal experiment",
      mutate(makeTemporalReportV2R2(), (draft) => (((draft.experiment as AnyRecord).supportingPairs = [])))
    ],
    [
      "unknown key smuggled inside a supporting-pair run",
      mutate(makeSupportingPairInterventionReportV2R2(), (draft) => {
        if (draft.experiment.kind === "intervention") {
          (draft.experiment.supportingPairs![0].baseline as AnyRecord).screenshot = "SECRET";
        }
      })
    ]
  ];
  for (const [label, mutant] of cases) {
    assert.equal(isPublicScanReportV2R2(mutant), false, `structural mutant accepted: ${label}`);
  }
});

test("r2 ephemeral shells validate as ephemeral and never as public", () => {
  const ephemeral = { ...makePublicSingleReportV2R2(), ephemeral: { screenshot: "data:image/png;base64,AAAA" } };
  assert.equal(isEphemeralScanReportR2(ephemeral), true);
  assert.equal(isPublicScanReportV2R2(ephemeral), false);
});

// ---------------------------------------------------------------------------
// The exported MUST-REJECT mutants: specific violation paths
// ---------------------------------------------------------------------------

test("interpreter mismatch rejects via the consent-interpreter compatibility key", () => {
  const violations = violationsOf(makeInterpreterMismatchMutantR2());
  assertSingleViolationPath(violations, "consent-interpreter", "interpreter mismatch");
});

test("duplicate sequences reject via global sequence uniqueness", () => {
  const violations = violationsOf(singleWith(makeDuplicateSequenceMutantR2()));
  assertSingleViolationPath(violations, "duplicate consent observation sequence", "duplicate sequence");
});

test("a read outcome with a null observation rejects via the outcome mapping", () => {
  const violations = violationsOf(singleWith(makeMalformedResultBlockMutantR2()));
  assertSingleViolationPath(violations, "disagrees with its observed state", "malformed result");
});

test("a duplicate banner moment rejects via moment uniqueness", () => {
  const violations = violationsOf(singleWith(makeDuplicateBannerMomentMutantR2()));
  assertSingleViolationPath(violations, "duplicate banner moment", "duplicate banner moment");
});

test("inverted banner chronology rejects via the chronology rule", () => {
  const violations = violationsOf(singleWith(makeInvertedBannerChronologyMutantR2()));
  assertSingleViolationPath(violations, "banner chronology inverted", "inverted chronology");
});

test("a missing result block rejects via the semantically-mandatory rule", () => {
  const violations = violationsOf(singleWith(makeMissingResultMutantR2()));
  assertSingleViolationPath(violations, "missing its r2 result block", "missing result");
});

test("GPC facts without an observed eligible first-party navigation reject", () => {
  const violations = violationsOf(makeGpcUnobservedNavigationMutantR2());
  assertSingleViolationPath(
    violations,
    "without an observed eligible first-party navigation",
    "gpc unobserved navigation"
  );
});

test("a consent-mode run without a consent-interaction phase rejects", () => {
  const violations = violationsOf(singleWith(makeConsentWithoutInteractionPhaseMutantR2()));
  assertSingleViolationPath(violations, "no consent-interaction phase", "missing consent-interaction phase");
});

test("a supporting pair with an incomplete run rejects via the completeness gate", () => {
  const violations = violationsOf(makeSupportingPairIncompleteRunMutantR2());
  assertSingleViolationPath(violations, "did not complete; the pair cannot support", "supporting run incomplete");
});

test("a supporting pair whose variant attempted a different interpreter rejects", () => {
  const violations = violationsOf(makeSupportingPairInterpreterParityMutantR2());
  assertSingleViolationPath(violations, "variant interpreter set does not match the primary pair", "supporting parity");
});

// ---------------------------------------------------------------------------
// Retained-field forgeries: reject-on-disagreement
// ---------------------------------------------------------------------------

test("forged consent states and reload flags reject against the derivations", () => {
  const forgedVerified = mutate(singleWith(makeWeakSignalConsentRunR2()), (draft) => {
    (draft as AnyRecord).run.evidence.consent.choiceState = "verified";
  });
  const v1 = violationsOf(forgedVerified);
  assert.equal(v1.some((entry) => entry.includes("does not derive from the observations (expected weak-signal)")), true);

  const forgedReload = mutate(makeConsentSingleReportV2R2(), (draft) => {
    draft.run.evidence.consent!.reverifiedAfterReload = false; // strong reload read says true
  });
  assertSingleViolationPath(violationsOf(forgedReload), "reverifiedAfterReload disagrees", "forged reload flag");
});

test("GPC arms must derive from the structured facts", () => {
  const mixedSignals = mutate(makeGpcInterventionReportV2R2(), (draft) => {
    draft.variant.verificationFacts!.gpc!.jsSignal = "read-failed"; // derived observed becomes null
  });
  const violations = violationsOf(mixedSignals);
  assert.equal(violations.some((entry) => entry.includes("arm observed state does not derive from the structured facts")), true);

  const missingFacts = mutate(makeGpcInterventionReportV2R2(), (draft) => {
    delete (draft.baseline as AnyRecord).verificationFacts;
  });
  assert.equal(
    violationsOf(missingFacts).some((entry) => entry.includes("missing verificationFacts.gpc")),
    true
  );
});

test("Shields facts enforce nonzero exercise, toolchain agreement, and summary derivation", () => {
  const zeroExercise = mutate(makeShieldsInterventionReportV2R2(), (draft) => {
    draft.variant.verificationFacts!.shields!.requestsEvaluated = 0;
    draft.variant.verificationFacts!.shields!.requestsMatched = 0;
  });
  const v1 = violationsOf(zeroExercise);
  assert.equal(v1.some((entry) => entry.includes("arm observed state does not derive")), true, "zero exercise is inconclusive");

  const engineDisagrees = mutate(makeShieldsInterventionReportV2R2(), (draft) => {
    draft.variant.toolchain.adblock = null; // facts still say engineLoaded
  });
  assert.equal(
    violationsOf(engineDisagrees).some((entry) => entry.includes("engineLoaded disagrees with the toolchain")),
    true
  );

  const forgedSummary = mutate(makeShieldsInterventionReportV2R2(), (draft) => {
    draft.variant.summary.counts.shieldsBlockedRequests = 7; // facts say 0
  });
  assert.equal(
    violationsOf(forgedSummary).some((entry) => entry.includes("summary shieldsBlockedRequests does not derive")),
    true
  );

  const inequality = mutate(makeShieldsInterventionReportV2R2(), (draft) => {
    draft.variant.verificationFacts!.shields!.requestsActuallyBlocked = 5; // > matched
  });
  assert.equal(
    violationsOf(inequality).some((entry) => entry.includes("blocked <= matched <= evaluated")),
    true
  );
});

test("supporting-pair gates: chronology, identity, fingerprints, and evidence derivation", () => {
  const base = makeSupportingPairInterventionReportV2R2;

  const badChronology = mutate(base(), (draft) => {
    if (draft.experiment.kind === "intervention") draft.experiment.supportingPairs![0].order = "AB"; // runs say BA
  });
  assert.equal(
    violationsOf(badChronology).some((entry) => entry.includes("disagrees with the runs' chronology")),
    true
  );

  const reusedRun = mutate(base(), (draft) => {
    if (draft.experiment.kind === "intervention") {
      draft.experiment.supportingPairs![0].baseline.runId = draft.baseline.runId;
    }
  });
  assert.equal(violationsOf(reusedRun).some((entry) => entry.includes("is reused across pairs")), true);

  const duplicatePairId = mutate(base(), (draft) => {
    if (draft.experiment.kind === "intervention") {
      draft.experiment.supportingPairs![0].pairId = draft.experiment.pairId;
    }
  });
  assert.equal(violationsOf(duplicatePairId).some((entry) => entry.includes("duplicate pairId")), true);

  const subjectMismatch = mutate(base(), (draft) => {
    if (draft.experiment.kind === "intervention") {
      const run = draft.experiment.supportingPairs![0].baseline;
      run.subject = structuredClone(run.subject);
      run.subject.observed.origin = "https://other.example.com";
    }
  });
  assert.equal(violationsOf(subjectMismatch).some((entry) => entry.includes("subject does not match the primary")), true);

  const forgedEvidence = mutate(base(), (draft) => {
    if (draft.experiment.kind === "intervention") draft.experiment.evidence = { pairs: 3, counterbalanced: true, strength: "observed-difference" };
  });
  assert.equal(
    violationsOf(forgedEvidence).some((entry) => entry.includes("evidence does not derive from the embedded pairs")),
    true
  );

  const forgedStrength = mutate(base(), (draft) => {
    if (draft.experiment.kind === "intervention") draft.experiment.evidence.strength = "replicated-difference";
  });
  assert.equal(
    violationsOf(forgedStrength).some((entry) => entry.includes("evidence does not derive from the embedded pairs")),
    true,
    "strength stays observed-difference unconditionally in r2"
  );
});

test("primary order and comparability/diff forgeries reject", () => {
  const invertedOrder = mutate(makeShieldsInterventionReportV2R2(), (draft) => {
    if (draft.experiment.kind === "intervention") draft.experiment.order = "BA"; // runs say AB
  });
  assert.equal(
    violationsOf(invertedOrder).some((entry) => entry.includes("declared order disagrees with the runs' chronology")),
    true
  );

  const forgedFamily = mutate(makeTemporalReportV2R2(), (draft) => {
    draft.comparability.perMetric["consent-verification"] = { eligible: true, reasons: [] }; // unknown-dimension applies
  });
  const violations = violationsOf(forgedFamily);
  assert.equal(
    violations.some((entry) => entry.includes("perMetric.consent-verification disagrees") && entry.includes("unknown-dimension:consent-interpreter")),
    true,
    "the per-family message names the derived reason"
  );

  const forgedDiff = mutate(makeShieldsInterventionReportV2R2(), (draft) => {
    draft.diff.families["shields-simulation"].metrics!.shieldsBlockedRequests.delta = 42;
  });
  assert.equal(violationsOf(forgedDiff).some((entry) => entry.includes("diff: does not equal")), true);
});

test("the consent-verification family is unknown for pairs that attempted nothing", () => {
  const temporal = makeTemporalReportV2R2();
  assert.deepEqual(attemptedStrongInterpreters(temporal.baseline), []);
  const comparability = evaluateComparabilityR2({ kind: "temporal", pairId: "p" }, temporal.baseline, temporal.variant);
  assert.equal(comparability.perMetric["consent-verification"].eligible, false);
  assert.equal(
    comparability.perMetric["consent-verification"].reasons.includes("unknown-dimension:consent-interpreter"),
    true
  );
  // The consent intervention, by contrast, is eligible: matching non-empty sets.
  const consent = makeConsentInterventionReportV2R2();
  assert.equal(consent.comparability.perMetric["consent-verification"].eligible, true);
});
