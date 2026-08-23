/**
 * The per-detector censoring-policy assignments from the step-3 decision
 * (docs/calibration-censoring-policy-decision.md), as one machine-readable
 * structure the step-4 analyzer and frame tooling consume.
 *
 * AUTHORITY. The decision document is authoritative and this module is checked
 * against it by test, not the other way around: the repository's top defect
 * class is one contract restated in two files, and a schema that drifted from
 * the decision would be exactly that. This module is also NOT the
 * candidate-resident policy artifact: the decision record separates the
 * technical assignment (here) from the later named-human approval of the
 * exact artifact and disposition digests, which happens only after the
 * analyzer behaviors exist.
 *
 * Policy ids are the simulation library's canonical ids, imported and pinned
 * by test so B and C cannot fork identifiers. Detector ids are the study
 * library's governed six.
 */

import { POLICIES } from "./calibration-censoring-simulation-lib.mjs";
import { CALIBRATION_DETECTOR_IDS } from "./calibration-study-lib.mjs";

function require(condition, message) {
  if (!condition) throw new Error(message);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const POLICY_C_ID = "bounded-censoring-with-sensitivity-analysis";
export const POLICY_B_ID = "detector-scoped-complete-case";

/**
 * Publication profiles. The decision reframes the historical four-margin
 * minimum as a profile for TWO-CLASS ACCURACY, never a universal definition of
 * evidence; each estimand binds its own minimums without weakening a claimed
 * class. Numbers the decision fixed are fixed here; numbers it deferred to
 * preregistration are represented as preregistration obligations, not
 * defaults, so a plan cannot inherit a size it never argued for.
 */
export const PUBLICATION_PROFILES = Object.freeze({
  "two-class-accuracy": Object.freeze({
    id: "two-class-accuracy",
    claimedClasses: Object.freeze(["reference-present", "reference-absent", "predicted-detected", "predicted-not-detected"]),
    minimumPerClaimedClass: 100,
    confidence: "wilson-score-95",
    maxWorstCaseHalfWidth: 0.1,
    preregistrationMustSupply: Object.freeze(["detector-specific power calculation"])
  }),
  "sensitivity-only": Object.freeze({
    id: "sensitivity-only",
    // No absent-class claim is made, so no absent-class minimum is imposed.
    claimedClasses: Object.freeze(["reference-present"]),
    minimumPerClaimedClass: 100,
    confidence: "wilson-score-95",
    maxWorstCaseHalfWidth: 0.1,
    preregistrationMustSupply: Object.freeze(["power calculation for sensitivity"])
  }),
  "rule-conformance-strata": Object.freeze({
    id: "rule-conformance-strata",
    claimedClasses: Object.freeze([]),
    minimumPerClaimedClass: null,
    confidence: "wilson-score-95",
    maxWorstCaseHalfWidth: 0.1,
    preregistrationMustSupply: Object.freeze([
      "the positive and negative endpoint-rule strata the study reports",
      "an independent size for each claimed stratum"
    ])
  })
});

/**
 * The assignment table. `proposition` restates the decision document's
 * proposition binding in one sentence so a published rate can name what it
 * measured; the binding test asserts each proposition's distinctive phrase
 * appears in the decision document.
 */
export const DETECTOR_POLICY_ASSIGNMENTS = Object.freeze({
  "cname-uncloaking": Object.freeze({
    disposition: "proceed",
    proposition:
      "At least one contacted first-party subdomain in the reviewer-owned browser capture independently resolved through a CNAME chain to a service classified by the SHA-256-pinned external tracker definition.",
    resultType: "accuracy",
    primary: Object.freeze({ policy: POLICY_C_ID, inferenceScope: "target-population" }),
    secondary: Object.freeze({ policy: POLICY_B_ID, inferenceScope: "scoreable-subpopulation" }),
    publicationProfile: "two-class-accuracy"
  }),
  "consent-banner": Object.freeze({
    disposition: "proceed",
    proposition:
      "A first-layer consent control was visibly offered at the observation time in the retained capture (banner-visibility@1). The rate does not cover the published claim that a consent management platform was requested.",
    resultType: "accuracy",
    primary: Object.freeze({ policy: POLICY_C_ID, inferenceScope: "target-population" }),
    secondary: Object.freeze({ policy: POLICY_B_ID, inferenceScope: "scoreable-subpopulation" }),
    publicationProfile: "two-class-accuracy"
  }),
  "keystroke-exfiltration": Object.freeze({
    disposition: "proceed",
    proposition:
      "Under the synthetic-positive lab protocol, the detector observed its typed sentinel leaving in network traffic. Sensitivity for that constructed population, not open-web accuracy.",
    resultType: "accuracy",
    primary: Object.freeze({ policy: POLICY_C_ID, inferenceScope: "synthetic-positive-population" }),
    secondary: Object.freeze({ policy: POLICY_B_ID, inferenceScope: "scoreable-subpopulation" }),
    publicationProfile: "sensitivity-only"
  }),
  "pixel-events": Object.freeze({
    disposition: "proceed",
    proposition:
      "The implementation agreed with the pinned Meta, TikTok, and X endpoint predicates when independently re-executed over retained, request-complete rows. Not accuracy about tracking behavior; does not cover the populated-identifier tier.",
    resultType: "rule-conformance",
    primary: Object.freeze({ policy: POLICY_B_ID, inferenceScope: "scoreable-subpopulation" }),
    secondary: null,
    publicationProfile: "rule-conformance-strata"
  }),
  "fingerprint-heuristics": Object.freeze({
    disposition: "hold",
    holdReason:
      "No rate until the pooled boolean is split into the separately hedged published propositions and an independent behavioral reference is preregistered.",
    proposition: null,
    resultType: null,
    primary: null,
    secondary: null,
    publicationProfile: null
  }),
  "privacy-policy": Object.freeze({
    disposition: "hold",
    holdReason:
      "No 2x2 rate until the analyzer exposes a real negative class and the evidence vocabulary separates subject absence from capture or budget failure.",
    proposition: null,
    resultType: null,
    primary: null,
    secondary: null,
    publicationProfile: null
  })
});

const ASSIGNMENT_FIELDS = new Set([
  "disposition",
  "holdReason",
  "proposition",
  "resultType",
  "primary",
  "secondary",
  "publicationProfile"
]);

/** Structural validation, run by the module's own test and by consumers. */
export function validateDetectorPolicyAssignments(assignments = DETECTOR_POLICY_ASSIGNMENTS) {
  require(isRecord(assignments), "assignments must be a record");
  const detectors = Object.keys(assignments).sort();
  require(
    JSON.stringify(detectors) === JSON.stringify([...CALIBRATION_DETECTOR_IDS].sort()),
    "assignments must cover exactly the six governed detectors"
  );
  for (const [detector, entry] of Object.entries(assignments)) {
    require(isRecord(entry), `${detector} assignment must be a record`);
    for (const key of Object.keys(entry)) {
      require(ASSIGNMENT_FIELDS.has(key), `${detector} carries unexpected field "${key}"`);
    }
    if (entry.disposition === "hold") {
      require(
        typeof entry.holdReason === "string" && entry.holdReason.length > 0,
        `${detector} is held without a recorded reason`
      );
      for (const field of ["proposition", "resultType", "primary", "secondary", "publicationProfile"]) {
        require(entry[field] === null || entry[field] === undefined, `${detector} is held but declares ${field}`);
      }
      continue;
    }
    require(entry.disposition === "proceed", `${detector} disposition must be proceed or hold`);
    require(
      typeof entry.proposition === "string" && entry.proposition.length > 0,
      `${detector} proceeds without a named proposition; a detector id is not a claim`
    );
    require(
      entry.resultType === "accuracy" || entry.resultType === "rule-conformance",
      `${detector} needs a result type`
    );
    require(isRecord(entry.primary), `${detector} needs a primary analysis`);
    require(
      entry.primary.policy in POLICIES,
      `${detector} primary policy "${entry.primary.policy}" is not a canonical policy id`
    );
    require(
      entry.primary.policy !== "zero-censoring",
      `${detector} must not run under superseded policy A`
    );
    if (entry.secondary !== null) {
      require(isRecord(entry.secondary), `${detector} secondary must be null or a record`);
      require(
        entry.secondary.policy === POLICY_B_ID,
        `${detector} secondary must be the scope-tagged policy B`
      );
      require(
        entry.secondary.inferenceScope === "scoreable-subpopulation",
        `${detector} secondary must carry the scoreable-subpopulation scope tag`
      );
    }
    // Rule-conformance may run B as primary because it makes no
    // target-population accuracy claim; an ACCURACY claim's primary must be C.
    if (entry.resultType === "accuracy") {
      require(
        entry.primary.policy === POLICY_C_ID,
        `${detector} claims accuracy, so its primary analysis must be policy C`
      );
    }
    require(
      entry.publicationProfile in PUBLICATION_PROFILES,
      `${detector} names unknown publication profile "${entry.publicationProfile}"`
    );
  }
  return assignments;
}

/** The gate a ceremony or frame producer calls before touching a detector. */
export function assertStudyPermitted(detector) {
  const entry = DETECTOR_POLICY_ASSIGNMENTS[detector];
  require(entry !== undefined, `${detector} is not a governed detector`);
  require(
    entry.disposition === "proceed",
    `${detector} is held by the step-3 censoring decision: ${entry.holdReason}`
  );
  return entry;
}
