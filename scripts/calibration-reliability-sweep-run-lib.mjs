/**
 * Pure logic for the reliability-sweep CALLER (step 4, item 4 of
 * docs/calibration-censoring-policy-decision.md). The narrowing layer itself
 * lives in calibration-reliability-sweep-lib.mjs and is not restated here:
 * this module never touches a report. It handles what the driver around that
 * layer must get right and what a test can prove without a network:
 *
 *   - the candidate set is parsed strictly and digested from its exact bytes,
 *     so the receipt's candidateSetDigest names the file that was swept;
 *   - each pass persists PROJECTIONS ONLY, wrapped in a closed envelope that
 *     records the identity and condition the pass ran under;
 *   - the two passes must agree on identity and condition before a receipt is
 *     assembled. buildReliabilitySweepReceipt records ONE identity for the
 *     whole sweep, so a build or condition change between passes would be
 *     silently misattributed to both; the caller refuses it instead.
 *
 * The summary derived here reads projected load facts only. It exists to give
 * the frame producer the detector-input loss structure the step-3 decision
 * requires: the all-family-complete rate lower-bounds every per-detector
 * scoreable rate (conservative for sizing by construction), and the
 * per-family censor counts size per-detector policies. Eligibility itself is
 * bare-load validity only; input losses are reported, never screened on.
 */

import {
  allEvidenceFamiliesComplete,
  assertBareLoadOnly,
  bareLoadValid,
  buildReliabilitySweepReceipt
} from "./calibration-reliability-sweep-lib.mjs";
import { sha256Hex } from "./scanner-fidelity-study-lib.mjs";

export const SWEEP_PASS_ARTIFACT_KIND =
  "site-behavior-calibration-reliability-sweep-pass";
export const SWEEP_PASS_ARTIFACT_VERSION = 2;

const CASE_ID = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

function require(condition, message) {
  if (!condition) throw new Error(message);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function only(record, allowed, context) {
  for (const key of Object.keys(record)) {
    require(allowed.has(key), `${context} carries unexpected field "${key}"`);
  }
}

/**
 * Parse the candidate-set file from its exact bytes. The digest is computed
 * over the bytes, never a re-serialization, so the receipt names the committed
 * file and not a formatting of it.
 */
export function parseCandidateSet(bytes) {
  require(
    typeof bytes === "string" && bytes.length > 0,
    "candidate set requires the file's exact contents"
  );
  let parsed;
  try {
    parsed = JSON.parse(bytes);
  } catch {
    throw new Error("candidate set is not valid JSON");
  }
  require(isRecord(parsed), "candidate set must be an object");
  only(parsed, new Set(["studyId", "candidates"]), "candidate set");
  require(
    typeof parsed.studyId === "string" && parsed.studyId.length > 0,
    "candidate set requires a study id"
  );
  require(
    Array.isArray(parsed.candidates) && parsed.candidates.length > 0,
    "candidate set requires at least one candidate"
  );
  const seen = new Set();
  const candidates = parsed.candidates.map((entry, index) => {
    require(isRecord(entry), `candidate ${index + 1} must be an object`);
    only(entry, new Set(["caseId", "url"]), `candidate ${index + 1}`);
    require(
      typeof entry.caseId === "string" && CASE_ID.test(entry.caseId),
      `candidate ${index + 1} needs a lowercase alphanumeric caseId`
    );
    require(!seen.has(entry.caseId), `duplicate caseId ${entry.caseId}`);
    seen.add(entry.caseId);
    let url;
    try {
      url = new URL(entry.url);
    } catch {
      throw new Error(`candidate ${entry.caseId} has an unparseable url`);
    }
    require(
      url.protocol === "https:",
      `candidate ${entry.caseId} must be https; the sweep frames public https sites only`
    );
    return { caseId: entry.caseId, url: entry.url };
  });
  return {
    studyId: parsed.studyId,
    candidates,
    candidateSetDigest: sha256Hex(bytes)
  };
}

const IDENTITY_FIELDS = Object.freeze(["buildCommit", "runtime", "runnerLabel", "egress"]);
const CONDITION_FIELDS = Object.freeze(["device", "consentMode", "gpcEnabled"]);

function validateIdentity(identity, context) {
  require(isRecord(identity), `${context} requires an identity record`);
  only(identity, new Set(IDENTITY_FIELDS), `${context} identity`);
  for (const field of IDENTITY_FIELDS) {
    require(
      typeof identity[field] === "string" && identity[field].length > 0,
      `${context} identity requires ${field}`
    );
  }
  require(
    /^[0-9a-f]{40}$/.test(identity.buildCommit),
    `${context} identity buildCommit must be a full lowercase git sha`
  );
}

function validateCondition(condition, context) {
  require(isRecord(condition), `${context} requires a measurement condition`);
  only(condition, new Set(CONDITION_FIELDS), `${context} condition`);
  require(
    typeof condition.device === "string" &&
      typeof condition.consentMode === "string" &&
      typeof condition.gpcEnabled === "boolean",
    `${context} condition requires device, consentMode, gpcEnabled`
  );
}

/**
 * Wrap one pass's projected outcomes for persistence. Every outcome row is
 * re-checked against the bare-load vocabulary on the way in: the pass artifact
 * is on disk between the two sessions, and it must be provably free of
 * predictions, not believed to be.
 */
export function buildPassArtifact({
  studyId,
  pass,
  candidateSetDigest,
  measurementCondition,
  identity,
  outcomes
}) {
  require(
    typeof studyId === "string" && studyId.length > 0,
    "pass artifact requires a study id"
  );
  require(pass === 1 || pass === 2, "pass artifact requires pass 1 or 2");
  require(
    typeof candidateSetDigest === "string" && /^[0-9a-f]{64}$/.test(candidateSetDigest),
    "pass artifact requires the candidate-set digest it swept"
  );
  validateCondition(measurementCondition, "pass artifact");
  validateIdentity(identity, "pass artifact");
  require(
    Array.isArray(outcomes) && outcomes.length > 0,
    "pass artifact requires at least one outcome"
  );
  const seen = new Set();
  for (const outcome of outcomes) {
    assertBareLoadOnly(outcome, "pass artifact outcome");
    require(outcome.pass === pass, `outcome for ${outcome.caseId} carries the wrong pass number`);
    require(!seen.has(outcome.caseId), `duplicate outcome for ${outcome.caseId}`);
    seen.add(outcome.caseId);
  }
  return {
    kind: SWEEP_PASS_ARTIFACT_KIND,
    version: SWEEP_PASS_ARTIFACT_VERSION,
    studyId,
    pass,
    candidateSetDigest,
    measurementCondition: { ...measurementCondition },
    identity: { ...identity },
    outcomes
  };
}

/** Strictly validate a persisted pass artifact read back from disk. */
export function validatePassArtifact(value, expectedPass) {
  require(isRecord(value), "pass artifact must be an object");
  only(
    value,
    new Set([
      "kind",
      "version",
      "studyId",
      "pass",
      "candidateSetDigest",
      "measurementCondition",
      "identity",
      "outcomes"
    ]),
    "pass artifact"
  );
  require(value.kind === SWEEP_PASS_ARTIFACT_KIND, "pass artifact kind mismatch");
  require(value.version === SWEEP_PASS_ARTIFACT_VERSION, "pass artifact version mismatch");
  // Re-run the constructor's checks over the stored fields; a hand-edited or
  // truncated artifact must fail here, not inside receipt assembly.
  const rebuilt = buildPassArtifact({
    studyId: value.studyId,
    pass: value.pass,
    candidateSetDigest: value.candidateSetDigest,
    measurementCondition: value.measurementCondition,
    identity: value.identity,
    outcomes: value.outcomes
  });
  if (expectedPass !== undefined) {
    require(value.pass === expectedPass, `expected pass ${expectedPass}, artifact is pass ${value.pass}`);
  }
  return rebuilt;
}

/**
 * Both passes must be statements about the same sweep. The receipt carries a
 * single identity and condition, so any disagreement between the passes would
 * be recorded as if it never happened; refuse instead. Two builds, two egress
 * points, or two conditions are two sweeps.
 */
export function assertPassesConsistent(first, second) {
  require(first.pass === 1 && second.pass === 2, "receipt assembly needs pass 1 then pass 2");
  require(first.studyId === second.studyId, "passes belong to different studies");
  require(
    first.candidateSetDigest === second.candidateSetDigest,
    "passes swept different candidate sets"
  );
  for (const field of IDENTITY_FIELDS) {
    require(
      first.identity[field] === second.identity[field],
      `pass identity ${field} changed between passes; that is two sweeps, not one`
    );
  }
  for (const field of CONDITION_FIELDS) {
    require(
      first.measurementCondition[field] === second.measurementCondition[field],
      `measurement condition ${field} changed between passes; that is two sweeps, not one`
    );
  }
}

/**
 * Assemble the receipt from two validated, consistent pass artifacts. The
 * sourceDigests bind the receipt to the exact bytes of the candidate set and
 * of both pass artifacts, so a re-derivation can prove which inputs produced
 * it.
 */
export function assembleReceiptFromPasses({
  first,
  second,
  firstArtifactBytes,
  secondArtifactBytes,
  candidateSetBytes,
  sweptAt
}) {
  assertPassesConsistent(first, second);
  const candidateSet = parseCandidateSet(candidateSetBytes);
  require(
    candidateSet.studyId === first.studyId,
    "candidate set study id does not match the pass artifacts"
  );
  require(
    candidateSet.candidateSetDigest === first.candidateSetDigest,
    "candidate set bytes do not match the digest the passes swept"
  );
  const expected = new Set(candidateSet.candidates.map((entry) => entry.caseId));
  for (const artifact of [first, second]) {
    for (const outcome of artifact.outcomes) {
      require(
        expected.has(outcome.caseId),
        `pass ${artifact.pass} carries outcome for unknown case ${outcome.caseId}`
      );
    }
    require(
      artifact.outcomes.length === expected.size,
      `pass ${artifact.pass} observed ${artifact.outcomes.length} of ${expected.size} candidates; a partial pass is re-run, never assembled`
    );
  }
  require(
    typeof sweptAt === "string" && ISO_UTC.test(sweptAt),
    "receipt assembly requires an ISO-8601 UTC sweptAt"
  );
  return buildReliabilitySweepReceipt({
    studyId: first.studyId,
    sweptAt,
    measurementCondition: first.measurementCondition,
    candidateSetDigest: first.candidateSetDigest,
    sourceDigests: {
      "candidate-set": candidateSet.candidateSetDigest,
      "pass-1-artifact": sha256Hex(firstArtifactBytes),
      "pass-2-artifact": sha256Hex(secondArtifactBytes)
    },
    identity: first.identity,
    outcomes: [...first.outcomes, ...second.outcomes]
  });
}

/**
 * The loss-bound summary for the frame producer, from projected facts only.
 * `allFamiliesComplete` lower-bounds every per-detector scoreable rate: a
 * case whose every family survived is scoreable for any detector, so sizing
 * against it is conservative for all of them. The summary DOES report which
 * families were lost (familyCensorCounts): the step-3 decision sizes
 * per-detector policies from per-family loss structure, and the
 * anti-selection property lives at the eligibility boundary, not in
 * blindness here.
 */
export function summarizeSweepOutcomes(outcomes) {
  require(Array.isArray(outcomes) && outcomes.length > 0, "summary requires outcomes");
  let loaded = 0;
  let valid = 0;
  let allFamiliesComplete = 0;
  const familyCensorCounts = {};
  for (const outcome of outcomes) {
    assertBareLoadOnly(outcome, "summary input");
    if (outcome.loaded) loaded += 1;
    if (bareLoadValid(outcome)) valid += 1;
    if (allEvidenceFamiliesComplete(outcome)) allFamiliesComplete += 1;
    for (const family of outcome.censoredFamilies) {
      familyCensorCounts[family] = (familyCensorCounts[family] ?? 0) + 1;
    }
  }
  return {
    observed: outcomes.length,
    loaded,
    valid,
    allFamiliesComplete,
    loadedFraction: loaded / outcomes.length,
    validFraction: valid / outcomes.length,
    allFamiliesCompleteFraction: allFamiliesComplete / outcomes.length,
    familyCensorCounts: Object.fromEntries(
      Object.entries(familyCensorCounts).sort(([a], [b]) => a.localeCompare(b))
    )
  };
}
