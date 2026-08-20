import assert from "node:assert/strict";
import test from "node:test";
import {
  DETECTOR_CAUSAL_INPUTS,
  declaredOwnStageDetails,
  detectorCausalInputs,
  evaluateDetectorCausalInputs,
  ownStageDetailsAreDetectorOutput,
  type CalibratableDetectorId
} from "./detector-causal-inputs";
import { DETECTOR_IDS, EVIDENCE_FAMILIES } from "./scan-report-v2";

function wholeRun(): Record<string, unknown> {
  return {
    quality: {
      run: { outcome: "complete", reasons: [] },
      byFamily: Object.fromEntries(
        EVIDENCE_FAMILIES.map((family) => [
          family,
          { outcome: "complete", reasons: [] }
        ])
      )
    },
    qualityFacts: {
      status: 200,
      botWallTitleMatched: false,
      navigationSettled: true,
      budgetsExhausted: [],
      captureLoss: []
    }
  };
}

test("every calibratable detector declares its causal inputs", () => {
  const calibratable = DETECTOR_IDS.filter(
    (detector) => detector !== "consent-banner"
  );
  assert.deepEqual(
    Object.keys(DETECTOR_CAUSAL_INPUTS).sort(),
    [...calibratable].sort(),
    "a detector without a declared causal-input contract would be scored from a rule nobody wrote"
  );
});

/**
 * `detector-output` is shared by every detector in the registry, so admitting
 * it as a family would censor a CNAME prediction because a privacy-policy visit
 * was dropped. The whole point of the two-axis shape is that this family is
 * scoped by detail instead.
 */
test("no detector claims the shared detector-output family", () => {
  // Widened on purpose. The literal `satisfies` type already makes some of
  // these unrepresentable at compile time, and an empty `families` narrows to
  // never[], so the runtime check needs a string view to be able to fail at all.
  const declared = DETECTOR_CAUSAL_INPUTS as unknown as Record<
    string,
    { families: readonly string[]; ownStageDetails: readonly string[] }
  >;
  for (const [detector, contract] of Object.entries(declared)) {
    assert.ok(
      !contract.families.includes("detector-output"),
      `${detector} must scope detector-output by detail, never by family`
    );
    for (const family of contract.families) {
      assert.ok(
        (EVIDENCE_FAMILIES as readonly string[]).includes(family),
        `${detector} names an evidence family the schema does not define: ${family}`
      );
    }
  }
});

test("every declared own-stage detail is a real producer token under detector-output", () => {
  const details = declaredOwnStageDetails();
  assert.ok(details.length > 0);
  assert.ok(
    ownStageDetailsAreDetectorOutput(details),
    "a token absent from the producer's capture-loss registry can never fire, so the claim it enforces would be decorative"
  );
  // Mutation coverage: the check is shown refusing a token that is real but
  // belongs to another family, which is the realistic way this drifts.
  assert.equal(ownStageDetailsAreDetectorOutput(["request-capture"]), false);
  assert.equal(ownStageDetailsAreDetectorOutput(["not-a-real-token"]), false);
});

test("a whole run is complete for every detector", () => {
  for (const detector of Object.keys(
    DETECTOR_CAUSAL_INPUTS
  ) as CalibratableDetectorId[]) {
    assert.deepEqual(
      evaluateDetectorCausalInputs(wholeRun(), detector),
      { complete: true },
      detector
    );
  }
});

test("a censored causal family censors only the detectors that depend on it", () => {
  const run = wholeRun();
  (run.quality as Record<string, Record<string, unknown>>).byFamily.requests = {
    outcome: "censored",
    reasons: ["capture-loss:cap"]
  };
  const cname = evaluateDetectorCausalInputs(run, "cname-uncloaking");
  assert.equal(cname.complete, false);
  assert.match(cname.complete ? "" : cname.cause, /requests evidence is censored/);
  assert.equal(
    evaluateDetectorCausalInputs(run, "pixel-events").complete,
    false,
    "pixel events are decoded from the same request stream"
  );
  assert.deepEqual(
    evaluateDetectorCausalInputs(run, "fingerprint-heuristics"),
    { complete: true },
    "the fingerprint observer does not read the request log"
  );
  assert.deepEqual(
    evaluateDetectorCausalInputs(run, "privacy-policy"),
    { complete: true },
    "the policy page is discovered from links and fetched on its own navigation"
  );
});

/**
 * Both halves, deliberately. Asserting only that keystroke survives would leave
 * the fingerprint-heuristics decision unpinned, which is how it gets reopened
 * later by someone who reads the two entries as inconsistent.
 */
test("an observer loss censors the detector that reads the observer, and not the probe that does not", () => {
  const run = wholeRun();
  (run.quality as Record<string, Record<string, unknown>>).byFamily.fingerprinting = {
    outcome: "censored",
    reasons: ["capture-loss:dropped"]
  };
  (run.qualityFacts as Record<string, unknown>).captureLoss = [
    {
      family: "fingerprinting",
      phaseId: 0,
      kind: "dropped",
      count: 3,
      detail: "fingerprint-observer"
    }
  ];
  assert.equal(
    evaluateDetectorCausalInputs(run, "fingerprint-heuristics").complete,
    false,
    "these detections are what the observer produced"
  );
  assert.deepEqual(
    evaluateDetectorCausalInputs(run, "keystroke-exfiltration"),
    { complete: true },
    "the keystroke probe captures its own requests; an unreadable frame in the passive observer cannot change whether its sentinel appeared"
  );
});

test("a detector-output loss censors only the stage it belongs to", () => {
  const run = wholeRun();
  (run.quality as Record<string, Record<string, unknown>>).byFamily[
    "detector-output"
  ] = { outcome: "censored", reasons: ["capture-loss:dropped"] };
  (run.qualityFacts as Record<string, unknown>).captureLoss = [
    { family: "detector-output", phaseId: 2, kind: "dropped", count: 1, detail: "policy-visit" }
  ];
  const policy = evaluateDetectorCausalInputs(run, "privacy-policy");
  assert.equal(policy.complete, false);
  assert.match(policy.complete ? "" : policy.cause, /policy-visit stage evidence is incomplete/);
  for (const detector of [
    "cname-uncloaking",
    "pixel-events",
    "fingerprint-heuristics",
    "keystroke-exfiltration"
  ] as CalibratableDetectorId[]) {
    assert.deepEqual(
      evaluateDetectorCausalInputs(run, detector),
      { complete: true },
      `${detector} does not own the policy-visit stage`
    );
  }
});

/**
 * The cases that decide whether the rule ships broken. A run without
 * `quality.byFamily` is malformed against a required v2 field, and an
 * optional-chained rule reads that absence as "nothing censored".
 */
test("an unprovable run fails closed", () => {
  const cases: Array<[string, unknown]> = [
    ["not an object", null],
    ["no quality", { qualityFacts: { captureLoss: [] } }],
    ["no byFamily", { quality: { run: { outcome: "complete" } }, qualityFacts: { captureLoss: [] } }],
    [
      "no qualityFacts",
      {
        quality: {
          run: { outcome: "complete" },
          byFamily: Object.fromEntries(
            EVIDENCE_FAMILIES.map((family) => [family, { outcome: "complete", reasons: [] }])
          )
        }
      }
    ],
    [
      "captureLoss is not an array",
      {
        quality: {
          run: { outcome: "complete" },
          byFamily: Object.fromEntries(
            EVIDENCE_FAMILIES.map((family) => [family, { outcome: "complete", reasons: [] }])
          )
        },
        qualityFacts: { captureLoss: {} }
      }
    ]
  ];
  for (const [label, run] of cases) {
    const verdict = evaluateDetectorCausalInputs(run, "cname-uncloaking");
    assert.equal(verdict.complete, false, label);
    assert.ok(verdict.complete || verdict.cause.length > 0, label);
  }
  // A declared family missing from an otherwise present ledger is the same
  // shape: proven whole is the only thing that passes.
  const partialLedger = {
    quality: { run: { outcome: "complete" }, byFamily: { cookies: { outcome: "complete" } } },
    qualityFacts: { captureLoss: [] }
  };
  assert.equal(
    evaluateDetectorCausalInputs(partialLedger, "cname-uncloaking").complete,
    false
  );
});

test("the accessor returns the frozen contract", () => {
  assert.deepEqual(
    detectorCausalInputs("cname-uncloaking").families,
    ["requests"]
  );
  assert.ok(Object.isFrozen(DETECTOR_CAUSAL_INPUTS));
});
