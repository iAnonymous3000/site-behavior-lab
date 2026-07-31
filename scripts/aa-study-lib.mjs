// Preregistered A/A repeatability studies over the scanner-fidelity attempt
// ledger.
//
// The fidelity driver already records every attempt (including failures and
// censored runs), summarizes per-target metric spread and third-party-domain
// Jaccard, excludes identity drift, and digests the whole receipt
// (scanner-fidelity-study-lib.mjs). What it deliberately does NOT do is turn
// those descriptive numbers into an accepted variance claim, because no
// thresholds were declared before the data existed.
//
// This module adds exactly that missing half: a PREREGISTRATION (declared
// before collection: exact target-frame digest, repetitions, conditions,
// build commit, and numeric acceptance thresholds) and an EVALUATION that
// binds a collected ledger to the preregistration and scores it. It never
// infers population rates: a passing study says "under these preregistered
// thresholds, on this frozen frame, at this exact identity, repeated scans
// agreed this well", nothing more.
import {
  METRICS,
  canonicalize,
  sha256Hex
} from "./scanner-fidelity-study-lib.mjs";

const SHA256 = /^[0-9a-f]{64}$/;
const FULL_GIT_SHA = /^[0-9a-f]{40}$/;

export const AA_PREREGISTRATION_KIND = "site-behavior-aa-preregistration";
export const AA_EVALUATION_KIND = "site-behavior-aa-evaluation";
export const AA_STUDY_VERSION = 1;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFraction(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

/** Structural validation; empty array means the preregistration is usable. */
export function aaPreregistrationIssues(preregistration) {
  const issues = [];
  const push = (message) => issues.push(message);
  if (!isRecord(preregistration)) return ["preregistration must be an object"];
  if (preregistration.kind !== AA_PREREGISTRATION_KIND) push(`kind must be ${AA_PREREGISTRATION_KIND}`);
  if (preregistration.studyVersion !== AA_STUDY_VERSION) push(`studyVersion must be ${AA_STUDY_VERSION}`);
  if (typeof preregistration.studyId !== "string" || preregistration.studyId.trim().length === 0) {
    push("studyId must be a non-empty string");
  }
  if (
    typeof preregistration.declaredAt !== "string" ||
    Number.isNaN(Date.parse(preregistration.declaredAt))
  ) {
    push("declaredAt must be an ISO 8601 timestamp");
  }
  if (typeof preregistration.buildCommit !== "string" || !FULL_GIT_SHA.test(preregistration.buildCommit)) {
    push("buildCommit must be a full lowercase git SHA");
  }
  if (
    typeof preregistration.sitesFileDigest !== "string" ||
    !SHA256.test(preregistration.sitesFileDigest)
  ) {
    push("sitesFileDigest must be the sha256 of the exact frozen target frame");
  }
  if (!Number.isSafeInteger(preregistration.targetCount) || preregistration.targetCount < 1) {
    push("targetCount must be a positive integer");
  }
  if (
    !Number.isSafeInteger(preregistration.repetitionsPerTarget) ||
    preregistration.repetitionsPerTarget < 2
  ) {
    push("repetitionsPerTarget must be an integer of at least 2");
  }
  if (!isRecord(preregistration.conditions)) {
    push("conditions must declare the exact scan conditions object the driver will run");
  }
  const thresholds = preregistration.thresholds;
  if (!isRecord(thresholds)) {
    push("thresholds must be declared before collection");
    return issues;
  }
  if (!Number.isSafeInteger(thresholds.minimumEligibleTargets) || thresholds.minimumEligibleTargets < 1) {
    push("thresholds.minimumEligibleTargets must be a positive integer");
  }
  if (!isFraction(thresholds.maximumFailingTargetFraction)) {
    push("thresholds.maximumFailingTargetFraction must be a fraction from 0 through 1");
  }
  if (!isRecord(thresholds.maximumMetricRelativeRange)) {
    push("thresholds.maximumMetricRelativeRange must map metric ids to ceilings");
  } else {
    for (const [metric, ceiling] of Object.entries(thresholds.maximumMetricRelativeRange)) {
      if (!METRICS.includes(metric)) push(`unknown metric in thresholds: ${metric}`);
      if (typeof ceiling !== "number" || !Number.isFinite(ceiling) || ceiling < 0) {
        push(`threshold ceiling for ${metric} must be a non-negative number`);
      }
    }
    if (Object.keys(thresholds.maximumMetricRelativeRange).length === 0) {
      push("thresholds.maximumMetricRelativeRange must name at least one metric");
    }
  }
  if (!isFraction(thresholds.minimumThirdPartyDomainJaccard)) {
    push("thresholds.minimumThirdPartyDomainJaccard must be a fraction from 0 through 1");
  }
  if (typeof thresholds.requireCounterbalancedOrders !== "boolean") {
    push("thresholds.requireCounterbalancedOrders must be declared explicitly");
  }
  return issues;
}

/**
 * Score a collected attempt ledger against its preregistration. Fails closed:
 * any binding mismatch (build, frame, repetitions, conditions, denominator)
 * is an identity violation, never a threshold failure.
 */
export function evaluateAaStudy({ preregistration, ledger }) {
  const issues = aaPreregistrationIssues(preregistration);
  if (issues.length > 0) {
    return { kind: AA_EVALUATION_KIND, studyVersion: AA_STUDY_VERSION, status: "invalid", issues, checks: [] };
  }
  const checks = [];
  const check = (id, ok, detail) => {
    checks.push({ id, ok, detail });
    return ok;
  };

  const ledgerUsable =
    isRecord(ledger) &&
    ledger.kind === "site-behavior-scanner-fidelity-attempt-ledger" &&
    ledger.receiptVersion === 2 &&
    isRecord(ledger.repeatability) &&
    isRecord(ledger.provenance);
  check("ledger-shape", ledgerUsable, "the collected artifact must be a v2 fidelity attempt ledger");
  if (!ledgerUsable) {
    return {
      kind: AA_EVALUATION_KIND,
      studyVersion: AA_STUDY_VERSION,
      status: "invalid",
      issues: ["ledger is not a v2 scanner-fidelity attempt ledger"],
      checks
    };
  }

  // Identity binding. Every one of these was declared before collection.
  check(
    "build-commit-binding",
    ledger.provenance.expectedBuildCommit === preregistration.buildCommit,
    `ledger build ${String(ledger.provenance.expectedBuildCommit)} vs preregistered ${preregistration.buildCommit}`
  );
  check(
    "target-frame-binding",
    ledger.provenance.sitesFileDigest === preregistration.sitesFileDigest,
    "the ledger must be collected over the exact preregistered target frame"
  );
  check(
    "repetition-binding",
    ledger.repetitions === preregistration.repetitionsPerTarget,
    `ledger repetitions ${String(ledger.repetitions)} vs preregistered ${preregistration.repetitionsPerTarget}`
  );
  check(
    "target-count-binding",
    ledger.selectedTargets === preregistration.targetCount,
    `ledger targets ${String(ledger.selectedTargets)} vs preregistered ${preregistration.targetCount}`
  );
  check(
    "condition-binding",
    canonicalize(ledger.conditions ?? null) === canonicalize(preregistration.conditions),
    "the ledger's scan conditions must equal the preregistered conditions"
  );
  check(
    "attempt-denominator",
    ledger.attemptedRuns === ledger.plannedRuns,
    `every planned attempt must be preserved: recorded ${String(ledger.attemptedRuns)} of ${String(ledger.plannedRuns)}`
  );
  // Preregistration means BEFORE: thresholds declared after the data existed
  // are curve-fitting, not preregistration.
  const declaredAt = Date.parse(preregistration.declaredAt);
  const collectedAt = Date.parse(ledger.createdAt ?? "");
  check(
    "preregistration-precedes-collection",
    !Number.isNaN(collectedAt) && declaredAt < collectedAt,
    Number.isNaN(collectedAt)
      ? "the ledger carries no valid createdAt to order against the preregistration"
      : `preregistration declared ${preregistration.declaredAt}, collection began ${ledger.createdAt}`
  );

  const bindingViolated = checks.some((entry) => !entry.ok);
  const thresholds = preregistration.thresholds;
  const repeatability = ledger.repeatability;
  const targets = Array.isArray(repeatability.targets) ? repeatability.targets : [];

  const failingTargets = [];
  for (const target of targets) {
    const failures = [];
    for (const [armName, arm] of Object.entries(target.arms ?? {})) {
      for (const [metric, ceiling] of Object.entries(thresholds.maximumMetricRelativeRange)) {
        const summary = arm?.metrics?.[metric];
        if (!isRecord(summary) || typeof summary.relativeRange !== "number") {
          failures.push(`${armName}.${metric}: summary missing`);
          continue;
        }
        if (summary.relativeRange > ceiling) {
          failures.push(
            `${armName}.${metric}: relative range ${summary.relativeRange.toFixed(4)} exceeds ${ceiling}`
          );
        }
      }
      const jaccard = arm?.thirdPartyDomainJaccard?.min;
      if (typeof jaccard !== "number") {
        failures.push(`${armName}: third-party-domain Jaccard missing`);
      } else if (jaccard < thresholds.minimumThirdPartyDomainJaccard) {
        failures.push(
          `${armName}: minimum pairwise Jaccard ${jaccard.toFixed(4)} below ${thresholds.minimumThirdPartyDomainJaccard}`
        );
      }
    }
    if (
      thresholds.requireCounterbalancedOrders &&
      target.reportType === "comparison" &&
      target.interventionOrders?.counterbalanced !== true
    ) {
      failures.push("intervention orders are not counterbalanced (AB and BA both required)");
    }
    if (failures.length > 0) failingTargets.push({ url: target.url, failures });
  }

  check(
    "eligible-target-floor",
    targets.length >= thresholds.minimumEligibleTargets,
    `${targets.length} eligible targets; ${thresholds.minimumEligibleTargets} preregistered as the floor`
  );
  const failingFraction = targets.length === 0 ? 1 : failingTargets.length / targets.length;
  check(
    "failing-target-fraction",
    failingFraction <= thresholds.maximumFailingTargetFraction,
    `${failingTargets.length} of ${targets.length} eligible targets exceeded a preregistered threshold`
  );

  const status = bindingViolated
    ? "identity-violation"
    : checks.every((entry) => entry.ok)
      ? "pass"
      : "fail";
  const core = {
    kind: AA_EVALUATION_KIND,
    studyVersion: AA_STUDY_VERSION,
    studyId: preregistration.studyId,
    status,
    issues: [],
    checks,
    eligibleTargets: targets.length,
    excludedTargets: Array.isArray(repeatability.excludedTargets)
      ? structuredClone(repeatability.excludedTargets)
      : [],
    failingTargets,
    preregistrationDigest: sha256Hex(canonicalize(preregistration)),
    ledgerReceiptDigest: typeof ledger.receiptDigest === "string" ? ledger.receiptDigest : null,
    inference: {
      scope: "recorded-attempts-only",
      caveats: [
        "A passing study describes agreement between repeated automated visits on the preregistered frame at one exact release identity; it is not a population estimate and not evidence about any single site's behavior."
      ]
    }
  };
  return { ...core, evaluationDigest: sha256Hex(canonicalize(core)) };
}
