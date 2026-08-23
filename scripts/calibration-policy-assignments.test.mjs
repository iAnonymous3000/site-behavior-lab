import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { POLICIES } from "./calibration-censoring-simulation-lib.mjs";
import { CALIBRATION_DETECTOR_IDS } from "./calibration-study-lib.mjs";
import {
  B_SCOPE,
  C_PRIMARY_SCOPES,
  DETECTOR_POLICY_ASSIGNMENTS,
  POLICY_B_ID,
  POLICY_C_ID,
  PUBLICATION_PROFILES,
  assertStudyPermitted,
  validateDetectorPolicyAssignments
} from "./calibration-policy-assignments.mjs";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const decisionDoc = readFileSync(
  path.join(moduleDir, "..", "docs", "calibration-censoring-policy-decision.md"),
  "utf8"
);

test("the assignment table validates and covers exactly the governed detectors", () => {
  validateDetectorPolicyAssignments();
  assert.deepEqual(
    Object.keys(DETECTOR_POLICY_ASSIGNMENTS).sort(),
    [...CALIBRATION_DETECTOR_IDS].sort()
  );
});

test("policy ids are the simulation library's canonical ids, never forks", () => {
  assert.equal(POLICY_C_ID in POLICIES, true);
  assert.equal(POLICY_B_ID in POLICIES, true);
  assert.equal(POLICIES[POLICY_C_ID].admitsIndeterminate, true);
  assert.equal(POLICIES[POLICY_B_ID].admitsIndeterminate, false);
});

test("the table restates the decision document, checked against it and not the reverse", () => {
  // The decision doc is authoritative. Each load-bearing clause of the table
  // must appear there, so an edit to either surface alone fails here.
  const bindings = [
    // The per-detector dispositions.
    ["cname-uncloaking proceeds", /`cname-uncloaking` \| proceed/],
    ["consent-banner proceeds for the seam only", /`consent-banner` \| proceed for `banner-visibility@1` only/],
    ["keystroke takes memo option (b)", /choose memo option \(b\); synthetic-positive arm only/],
    ["pixel-events is rule conformance only", /`pixel-events` \| proceed as rule conformance only/],
    ["fingerprint-heuristics holds", /`fingerprint-heuristics` \| hold/],
    ["privacy-policy holds", /`privacy-policy` \| hold/],
    // The governing rules the validator enforces.
    ["A is superseded", /is superseded for new studies/],
    ["B never rescues C", /never rescues an ineligible or inconclusive policy-C result/],
    ["accuracy primaries are C", /policy C[\s\S]{0,120}as their primary analysis/],
    ["the four-margin reframe", /publication profile for a two-class\s+accuracy study, not a universal definition of evidence/],
    ["keystroke makes no absent-class claim", /makes no\s+absent-class claim/]
  ];
  for (const [label, pattern] of bindings) {
    assert.match(decisionDoc, pattern, `decision document no longer states: ${label}`);
  }

  // And the table agrees with what those clauses say.
  for (const [detector, entry] of Object.entries(DETECTOR_POLICY_ASSIGNMENTS)) {
    if (entry.disposition !== "proceed") continue;
    assert.notEqual(entry.primary.policy, "zero-censoring", `${detector} runs under superseded A`);
    if (entry.resultType === "accuracy") {
      assert.equal(entry.primary.policy, POLICY_C_ID, `${detector} accuracy primary must be C`);
    }
    if (entry.secondary !== null) {
      assert.equal(entry.secondary.policy, POLICY_B_ID);
      assert.equal(entry.secondary.inferenceScope, "scoreable-subpopulation");
    }
  }
  assert.equal(DETECTOR_POLICY_ASSIGNMENTS["pixel-events"].secondary, null);
  assert.equal(
    DETECTOR_POLICY_ASSIGNMENTS["keystroke-exfiltration"].publicationProfile,
    "sensitivity-only"
  );
  assert.deepEqual(PUBLICATION_PROFILES["sensitivity-only"].claimedClasses, ["reference-present"]);
});

test("held detectors refuse study permission with their recorded reason", () => {
  assert.equal(assertStudyPermitted("cname-uncloaking").disposition, "proceed");
  assert.throws(() => assertStudyPermitted("fingerprint-heuristics"), /held by the step-3/);
  assert.throws(() => assertStudyPermitted("privacy-policy"), /negative class/);
  assert.throws(() => assertStudyPermitted("not-a-detector"), /not a governed detector/);
});

test("the validator refuses the widenings the decision forbids", () => {
  const mutate = (apply) => {
    const draft = structuredClone(
      Object.fromEntries(
        Object.entries(DETECTOR_POLICY_ASSIGNMENTS).map(([k, v]) => [k, structuredClone(v)])
      )
    );
    apply(draft);
    return draft;
  };
  // Accuracy under B as primary is the exact rescue the decision forbids.
  assert.throws(
    () =>
      validateDetectorPolicyAssignments(
        mutate((d) => {
          d["cname-uncloaking"].primary = { policy: POLICY_B_ID, inferenceScope: "target-population" };
        })
      ),
    /population-claiming B is the rescue the decision forbids/
  );
  // And the same rescue attempted with the honest B scope still fails, on the
  // accuracy rule.
  assert.throws(
    () =>
      validateDetectorPolicyAssignments(
        mutate((d) => {
          d["cname-uncloaking"].primary = { policy: POLICY_B_ID, inferenceScope: "scoreable-subpopulation" };
        })
      ),
    /accuracy, so its primary analysis must be policy C/
  );
  // Reviving policy A.
  assert.throws(
    () =>
      validateDetectorPolicyAssignments(
        mutate((d) => {
          d["pixel-events"].primary = { policy: "zero-censoring", inferenceScope: "target-population" };
        })
      ),
    /superseded policy A/
  );
  // A secondary without the scope tag.
  assert.throws(
    () =>
      validateDetectorPolicyAssignments(
        mutate((d) => {
          d["consent-banner"].secondary = { policy: POLICY_B_ID, inferenceScope: "target-population" };
        })
      ),
    /scoreable-subpopulation scope tag/
  );
  // A hold quietly acquiring an analysis.
  assert.throws(
    () =>
      validateDetectorPolicyAssignments(
        mutate((d) => {
          d["fingerprint-heuristics"].primary = { policy: POLICY_C_ID, inferenceScope: "target-population" };
        })
      ),
    /held but declares primary/
  );
  // A proceed without a proposition: a detector id is not a claim.
  assert.throws(
    () =>
      validateDetectorPolicyAssignments(
        mutate((d) => {
          d["cname-uncloaking"].proposition = "";
        })
      ),
    /detector id is not a claim/
  );
});

test("the per-detector table is pinned exactly: a silent flip fails here", () => {
  // The review flipped consent-banner to rule-conformance with a B primary
  // and the suite stayed green: the accuracy-primary rule was conditional on
  // a resultType nothing pinned. The table's load-bearing columns are pinned
  // as one literal now.
  const projection = Object.fromEntries(
    Object.entries(DETECTOR_POLICY_ASSIGNMENTS).map(([detector, entry]) => [
      detector,
      entry.disposition === "hold"
        ? { disposition: "hold" }
        : {
            disposition: "proceed",
            resultType: entry.resultType,
            primaryPolicy: entry.primary.policy,
            primaryScope: entry.primary.inferenceScope,
            secondaryPolicy: entry.secondary?.policy ?? null,
            publicationProfile: entry.publicationProfile
          }
    ])
  );
  assert.deepEqual(projection, {
    "cname-uncloaking": {
      disposition: "proceed",
      resultType: "accuracy",
      primaryPolicy: POLICY_C_ID,
      primaryScope: "target-population",
      secondaryPolicy: POLICY_B_ID,
      publicationProfile: "two-class-accuracy"
    },
    "consent-banner": {
      disposition: "proceed",
      resultType: "accuracy",
      primaryPolicy: POLICY_C_ID,
      primaryScope: "target-population",
      secondaryPolicy: POLICY_B_ID,
      publicationProfile: "two-class-accuracy"
    },
    "keystroke-exfiltration": {
      disposition: "proceed",
      resultType: "accuracy",
      primaryPolicy: POLICY_C_ID,
      primaryScope: "synthetic-positive-population",
      secondaryPolicy: POLICY_B_ID,
      publicationProfile: "sensitivity-only"
    },
    "pixel-events": {
      disposition: "proceed",
      resultType: "rule-conformance",
      primaryPolicy: POLICY_B_ID,
      primaryScope: B_SCOPE,
      secondaryPolicy: null,
      publicationProfile: "rule-conformance-strata"
    },
    "fingerprint-heuristics": { disposition: "hold" },
    "privacy-policy": { disposition: "hold" }
  });
});

test("the decision-fixed profile numbers are pinned to the decision document", () => {
  // The review set every minimum to 50 and every half-width to 0.5 and the
  // suite stayed green. The decision fixes these numbers; the doc clauses are
  // asserted beside the values so an edit to either surface alone fails.
  assert.match(decisionDoc, /at least 100 cases in every claimed reference and\s+prediction margin/);
  assert.match(decisionDoc, /maximum worst-case half-width of `0\.10` remain\s+unchanged/);
  assert.match(decisionDoc, /at least 100\s+reference-present cases/);
  assert.equal(PUBLICATION_PROFILES["two-class-accuracy"].minimumPerClaimedClass, 100);
  assert.equal(PUBLICATION_PROFILES["sensitivity-only"].minimumPerClaimedClass, 100);
  for (const profile of Object.values(PUBLICATION_PROFILES)) {
    assert.equal(profile.maxWorstCaseHalfWidth, 0.1);
    assert.equal(profile.confidence, "wilson-score-95");
  }
  assert.equal(PUBLICATION_PROFILES["rule-conformance-strata"].minimumPerClaimedClass, null);
});

test("scope vocabulary and remaining refusal paths are enforced, not decorative", () => {
  const mutate = (apply) => {
    const draft = structuredClone(
      Object.fromEntries(
        Object.entries(DETECTOR_POLICY_ASSIGNMENTS).map(([k, v]) => [k, structuredClone(v)])
      )
    );
    apply(draft);
    return draft;
  };
  assert.deepEqual([...C_PRIMARY_SCOPES], ["target-population", "synthetic-positive-population"]);
  // A C primary drifting to the B scope is refused.
  assert.throws(
    () =>
      validateDetectorPolicyAssignments(
        mutate((d) => {
          d["cname-uncloaking"].primary.inferenceScope = "scoreable-subpopulation";
        })
      ),
    /not a population claim/
  );
  // Keystroke's synthetic-positive scope cannot be silently erased to an
  // unknown string.
  assert.throws(
    () =>
      validateDetectorPolicyAssignments(
        mutate((d) => {
          d["keystroke-exfiltration"].primary.inferenceScope = "open-web";
        })
      ),
    /not a population claim/
  );
  // A key smuggled inside primary is refused.
  assert.throws(
    () =>
      validateDetectorPolicyAssignments(
        mutate((d) => {
          d["consent-banner"].primary = {
            policy: POLICY_C_ID,
            inferenceScope: "target-population",
            note: "smuggled"
          };
        })
      ),
    /primary carries unexpected field "note"/
  );
  // An unknown publication profile is refused.
  assert.throws(
    () =>
      validateDetectorPolicyAssignments(
        mutate((d) => {
          d["pixel-events"].publicationProfile = "vibes";
        })
      ),
    /unknown publication profile/
  );
  // A table missing a governed detector is refused.
  assert.throws(
    () =>
      validateDetectorPolicyAssignments(
        mutate((d) => {
          delete d["privacy-policy"];
        })
      ),
    /exactly the six governed detectors/
  );
});
