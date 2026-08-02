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
// before collection: exact measurement-identity manifest and target-frame
// digests, repetitions, conditions, and numeric acceptance thresholds) and an
// EVALUATION that binds a collected ledger to the preregistration and scores
// it. The manifest is the durable identity; the ledger still records the
// truthful producer build SHA, but a post-candidate evidence carrier is not
// required to pretend it has the same SHA as the frozen measurement input.
// A passing study says "under these preregistered thresholds, on this frozen
// frame and input identity, repeated scans agreed this well", nothing more.
import {
  METRICS,
  canonicalize,
  scannerFidelityAttemptLedgerIssues,
  sha256Hex
} from "./scanner-fidelity-study-lib.mjs";

const SHA256 = /^[0-9a-f]{64}$/;
const CANONICAL_INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const STUDY_ID = /^[a-z0-9][a-z0-9-]{0,79}$/;

export const AA_PREREGISTRATION_KIND = "site-behavior-aa-preregistration";
export const AA_EVALUATION_KIND = "site-behavior-aa-evaluation";
export const AA_STUDY_VERSION = 2;
export const AA_MEASUREMENT_IDENTITY_MANIFEST_PATH =
  "research/measurement-candidate/measurement-identity.json";

const PREREGISTRATION_KEYS = Object.freeze([
  "kind",
  "studyVersion",
  "studyId",
  "declaredAt",
  "measurementIdentityManifestPath",
  "measurementIdentityDigest",
  "sitesFile",
  "sitesFileDigest",
  "targetCount",
  "repetitionsPerTarget",
  "conditions",
  "thresholds"
]);
const THRESHOLD_KEYS = Object.freeze([
  "minimumEligibleTargets",
  "maximumFailingTargetFraction",
  "maximumMetricRelativeRange",
  "minimumThirdPartyDomainJaccard",
  "requireCounterbalancedOrders"
]);

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value, expected, label, issues) {
  if (!isRecord(value)) {
    issues.push(`${label} must be an object`);
    return false;
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    issues.push(`${label} must contain exactly: ${wanted.join(", ")}`);
    return false;
  }
  return true;
}

function canonicalTimestamp(value) {
  if (typeof value !== "string" || !CANONICAL_INSTANT.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

export function aaTargetFramePath(studyId) {
  if (typeof studyId !== "string" || !STUDY_ID.test(studyId)) {
    throw new TypeError("A/A studyId must use lowercase letters, digits, and hyphens");
  }
  return `research/aa-studies/${studyId}/target-frame.json`;
}

function isFraction(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

export function aaTargetFrameIssues({
  targetFrame,
  targetFrameText,
  preregistration,
  ledger
}) {
  const issues = [];
  if (typeof targetFrameText !== "string" || targetFrameText.length === 0) {
    return ["target frame text must contain the exact non-empty file bytes"];
  }
  let parsedFrame;
  try {
    parsedFrame = JSON.parse(targetFrameText);
  } catch {
    return ["target frame text must be valid JSON"];
  }
  if (canonicalize(parsedFrame) !== canonicalize(targetFrame)) {
    issues.push("target frame value must be parsed from the exact supplied file bytes");
  }
  const frameDigest = sha256Hex(targetFrameText);
  if (
    preregistration?.sitesFileDigest !== frameDigest ||
    ledger?.provenance?.sitesFileDigest !== frameDigest
  ) {
    issues.push(
      "preregistration and ledger must bind the sha256 of the exact target-frame bytes"
    );
  }
  if (!Array.isArray(targetFrame) || targetFrame.length === 0) {
    return [...issues, "target frame must be a non-empty array"];
  }
  const urls = new Set();
  const targetIds = new Set();
  for (const [index, target] of targetFrame.entries()) {
    if (!exactKeys(target, ["targetId", "url"], `target frame entry ${index + 1}`, issues)) {
      continue;
    }
    if (
      typeof target.targetId !== "string" ||
      !/^[a-z0-9][a-z0-9._-]{0,99}$/.test(target.targetId) ||
      targetIds.has(target.targetId)
    ) {
      issues.push(
        `target frame entry ${index + 1} has an invalid or duplicate targetId`
      );
    } else {
      targetIds.add(target.targetId);
    }
    let canonicalUrl = null;
    try {
      const parsed = new URL(target.url);
      if (
        parsed.protocol === "https:" &&
        parsed.username === "" &&
        parsed.password === "" &&
        parsed.hash === "" &&
        parsed.toString() === target.url
      ) {
        canonicalUrl = target.url;
      }
    } catch {
      // Report the single canonical URL problem below.
    }
    if (canonicalUrl === null || urls.has(canonicalUrl)) {
      issues.push(
        `target frame entry ${index + 1} has a non-canonical or duplicate HTTPS URL`
      );
    } else {
      urls.add(canonicalUrl);
    }
  }
  if (
    preregistration?.targetCount !== targetFrame.length ||
    ledger?.selectedTargets !== targetFrame.length
  ) {
    issues.push(
      "target frame size must equal preregistration.targetCount and ledger.selectedTargets"
    );
  }
  const repetitions = preregistration?.repetitionsPerTarget;
  if (!Number.isSafeInteger(repetitions) || repetitions < 2) return issues;
  const expectedAttempts = new Set();
  for (const url of urls) {
    for (let repetition = 1; repetition <= repetitions; repetition += 1) {
      expectedAttempts.add(`${url}\0${repetition}`);
    }
  }
  const actualAttempts = new Set();
  if (!Array.isArray(ledger?.attempts)) {
    issues.push("attempt ledger must preserve an attempts array");
    return issues;
  }
  for (const [index, attempt] of ledger.attempts.entries()) {
    if (
      !isRecord(attempt) ||
      typeof attempt.url !== "string" ||
      attempt.shape !== "aa" ||
      !Number.isSafeInteger(attempt.repetition)
    ) {
      issues.push(
        `attempt ${index + 1} must bind one target URL, shape aa, and an integer repetition`
      );
      continue;
    }
    const key = `${attempt.url}\0${attempt.repetition}`;
    if (!expectedAttempts.has(key)) {
      issues.push(
        `attempt ${index + 1} is not in the preregistered target/repetition frame`
      );
    }
    if (actualAttempts.has(key)) {
      issues.push(`attempt ${index + 1} duplicates a target/repetition pair`);
    }
    actualAttempts.add(key);
  }
  if (
    actualAttempts.size !== expectedAttempts.size ||
    [...expectedAttempts].some((key) => !actualAttempts.has(key))
  ) {
    issues.push(
      "attempt ledger is not set-equal to every preregistered target and repetition"
    );
  }
  return issues;
}

/** Structural validation; empty array means the preregistration is usable. */
export function aaPreregistrationIssues(preregistration) {
  const issues = [];
  const push = (message) => issues.push(message);
  if (!exactKeys(preregistration, PREREGISTRATION_KEYS, "preregistration", issues)) {
    return issues;
  }
  if (preregistration.kind !== AA_PREREGISTRATION_KIND) push(`kind must be ${AA_PREREGISTRATION_KIND}`);
  if (preregistration.studyVersion !== AA_STUDY_VERSION) push(`studyVersion must be ${AA_STUDY_VERSION}`);
  if (typeof preregistration.studyId !== "string" || !STUDY_ID.test(preregistration.studyId)) {
    push("studyId must use lowercase letters, digits, and hyphens");
  }
  if (!canonicalTimestamp(preregistration.declaredAt)) {
    push("declaredAt must be a canonical UTC timestamp");
  }
  if (
    preregistration.measurementIdentityManifestPath !==
    AA_MEASUREMENT_IDENTITY_MANIFEST_PATH
  ) {
    push(
      `measurementIdentityManifestPath must be ${AA_MEASUREMENT_IDENTITY_MANIFEST_PATH}`
    );
  }
  if (
    typeof preregistration.measurementIdentityDigest !== "string" ||
    !SHA256.test(preregistration.measurementIdentityDigest)
  ) {
    push(
      "measurementIdentityDigest must be the sha256 of the non-self-referential measurement-identity manifest"
    );
  }
  if (
    typeof preregistration.studyId === "string" &&
    STUDY_ID.test(preregistration.studyId) &&
    preregistration.sitesFile !== aaTargetFramePath(preregistration.studyId)
  ) {
    push("sitesFile must be the study-local frozen target-frame path");
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
  if (!isRecord(preregistration.conditions) || Object.keys(preregistration.conditions).length === 0) {
    push("conditions must declare the exact scan conditions object the driver will run");
  }
  const thresholds = preregistration.thresholds;
  if (!exactKeys(thresholds, THRESHOLD_KEYS, "thresholds", issues)) {
    return issues;
  }
  if (!Number.isSafeInteger(thresholds.minimumEligibleTargets) || thresholds.minimumEligibleTargets < 1) {
    push("thresholds.minimumEligibleTargets must be a positive integer");
  }
  if (!isFraction(thresholds.maximumFailingTargetFraction)) {
    push("thresholds.maximumFailingTargetFraction must be a fraction from 0 through 1");
  }
  if (!exactKeys(
    thresholds.maximumMetricRelativeRange,
    METRICS,
    "thresholds.maximumMetricRelativeRange",
    issues
  )) {
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
 * any binding mismatch (measurement inputs, frame, repetitions, conditions,
 * denominator) is an identity violation, never a threshold failure.
 */
export function evaluateAaStudy({
  preregistration,
  targetFrame,
  targetFrameText,
  ledger
}) {
  const issues = aaPreregistrationIssues(preregistration);
  if (issues.length > 0) {
    return { kind: AA_EVALUATION_KIND, studyVersion: AA_STUDY_VERSION, status: "invalid", issues, checks: [] };
  }
  const checks = [];
  const check = (id, ok, detail) => {
    checks.push({ id, ok, detail });
    return ok;
  };

  const ledgerIssues = scannerFidelityAttemptLedgerIssues(ledger, {
    requireMeasurementIdentityDigest: true
  });
  const ledgerUsable = ledgerIssues.length === 0;
  check("ledger-shape", ledgerUsable, "the collected artifact must be a v3 fidelity attempt ledger");
  if (!ledgerUsable) {
    return {
      kind: AA_EVALUATION_KIND,
      studyVersion: AA_STUDY_VERSION,
      status: "invalid",
      issues: ledgerIssues.map((issue) => `ledger: ${issue}`),
      checks
    };
  }

  // Identity binding. Every one of these was declared before collection.
  check(
    "measurement-identity-binding",
    ledger.provenance.measurementIdentityDigest ===
      preregistration.measurementIdentityDigest,
    "the ledger must bind the exact preregistered measurement-identity manifest digest"
  );
  check(
    "measurement-identity-manifest-path",
    preregistration.measurementIdentityManifestPath ===
      AA_MEASUREMENT_IDENTITY_MANIFEST_PATH,
    "the preregistration must name the fixed non-self-referential measurement-identity manifest"
  );
  check(
    "target-frame-path-binding",
    ledger.sitesFile === preregistration.sitesFile,
    "the ledger must be collected from the exact preregistered study-local target frame"
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
  const targetFrameIssues = aaTargetFrameIssues({
    targetFrame,
    targetFrameText,
    preregistration,
    ledger
  });
  check(
    "target-frame-attempt-set",
    targetFrameIssues.length === 0,
    targetFrameIssues.length === 0
      ? "the ledger is set-equal to every target and repetition in the exact digest-bound frame"
      : targetFrameIssues.join("; ")
  );
  // Preregistration means BEFORE: thresholds declared after the data existed
  // are curve-fitting, not preregistration.
  const declaredAt = Date.parse(preregistration.declaredAt);
  const collectedAt = Date.parse(ledger.collection.startedAt);
  check(
    "preregistration-precedes-collection",
    declaredAt < collectedAt,
    `preregistration declared ${preregistration.declaredAt}, collection began ${ledger.collection.startedAt}`
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
      (
        target.interventionOrders?.counterbalanced !== true ||
        target.interventionOrders?.AB !== target.interventionOrders?.BA ||
        target.interventionOrders?.AB < 1
      )
    ) {
      failures.push(
        "intervention orders are not exactly counterbalanced (equal non-zero AB and BA counts required)"
      );
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
    issues: targetFrameIssues,
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
        "A passing study describes agreement between repeated automated visits on the preregistered frame and measurement identity; it is not a population estimate and not evidence about any single site's behavior."
      ]
    }
  };
  return { ...core, evaluationDigest: sha256Hex(canonicalize(core)) };
}
