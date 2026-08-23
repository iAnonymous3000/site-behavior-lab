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
  EXPECTED_EVIDENCE_FAMILIES,
  MAX_SWEEP_ROUNDS,
  SWEEP_MINIMUM_ROUND_SEPARATION_MS,
  allEvidenceFamiliesComplete,
  assertBareLoadOnly,
  bareLoadValid,
  buildReliabilitySweepReceipt
} from "./calibration-reliability-sweep-lib.mjs";
import {
  CLUSTER_BOOTSTRAP_ITERATIONS,
  CLUSTER_BOOTSTRAP_SEED,
  clusterInterval
} from "./cluster-interval-lib.mjs";
import { sha256Hex } from "./scanner-fidelity-study-lib.mjs";

export const SWEEP_PASS_ARTIFACT_KIND =
  "site-behavior-calibration-reliability-sweep-pass";
export const SWEEP_PASS_ARTIFACT_VERSION = 3;

/**
 * The preregistered fail-closed minimum for the loss bound
 * (docs/reliability-sweep-cluster-design.md): four usable rounds, one above
 * the bootstrap implementation's own hard floor of three. Below it the bound
 * command REFUSES; it never substitutes an iid interval, because a per-case
 * Wilson endpoint over clustered failures is a diagnostic, not a design
 * bound, by the censoring analysis's own record.
 */
export const SWEEP_BOUND_MINIMUM_ROUNDS = 4;
export const SWEEP_LOSS_BOUND_KIND =
  "site-behavior-calibration-reliability-loss-bound";
export const SWEEP_LOSS_BOUND_VERSION = 1;

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
  require(
    Number.isSafeInteger(pass) && pass >= 1 && pass <= MAX_SWEEP_ROUNDS,
    `pass artifact requires a round from 1 to ${MAX_SWEEP_ROUNDS}`
  );
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
export function assertRoundsConsistent(artifacts) {
  require(
    Array.isArray(artifacts) && artifacts.length >= 2,
    "receipt assembly needs at least the two eligibility rounds"
  );
  for (const [index, artifact] of artifacts.entries()) {
    require(
      artifact.pass === index + 1,
      `receipt assembly needs contiguous rounds starting at 1; position ${index + 1} carries round ${artifact.pass}`
    );
  }
  const first = artifacts[0];
  for (const artifact of artifacts.slice(1)) {
    require(artifact.studyId === first.studyId, "rounds belong to different studies");
    require(
      artifact.candidateSetDigest === first.candidateSetDigest,
      "rounds swept different candidate sets"
    );
    for (const field of IDENTITY_FIELDS) {
      require(
        artifact.identity[field] === first.identity[field],
        `round identity ${field} changed between rounds; that is two sweeps, not one`
      );
    }
    for (const field of CONDITION_FIELDS) {
      require(
        artifact.measurementCondition[field] === first.measurementCondition[field],
        `measurement condition ${field} changed between rounds; that is two sweeps, not one`
      );
    }
  }
  // Rounds are DISJOINT sessions in chronological order, each at least the
  // minimum separation after the previous round's last observation. Cluster
  // independence is temporal: two rounds an hour apart mostly re-measure one
  // web state, which is the two-cluster diagnosis by another route.
  for (let index = 1; index < artifacts.length; index += 1) {
    const previousMax = Math.max(
      ...artifacts[index - 1].outcomes.map((outcome) => Date.parse(outcome.observedAt))
    );
    const currentMin = Math.min(
      ...artifacts[index].outcomes.map((outcome) => Date.parse(outcome.observedAt))
    );
    require(
      currentMin - previousMax >= SWEEP_MINIMUM_ROUND_SEPARATION_MS,
      `round ${index + 1} begins ${currentMin - previousMax}ms after round ${index} ended; rounds are disjoint sessions at least ${SWEEP_MINIMUM_ROUND_SEPARATION_MS}ms apart`
    );
  }
}

/**
 * Assemble the receipt from two validated, consistent pass artifacts. The
 * sourceDigests bind the receipt to the exact bytes of the candidate set and
 * of both pass artifacts, so a re-derivation can prove which inputs produced
 * it.
 */
export function assembleReceiptFromRounds({ rounds, candidateSetBytes, sweptAt }) {
  require(Array.isArray(rounds) && rounds.length >= 2, "assembly needs at least two rounds");
  for (const entry of rounds) {
    require(
      isRecord(entry) && isRecord(entry.artifact) && typeof entry.bytes === "string",
      "each round entry needs { artifact, bytes }"
    );
  }
  const artifacts = rounds.map((entry) => entry.artifact);
  assertRoundsConsistent(artifacts);
  const first = artifacts[0];
  const candidateSet = parseCandidateSet(candidateSetBytes);
  require(
    candidateSet.studyId === first.studyId,
    "candidate set study id does not match the round artifacts"
  );
  require(
    candidateSet.candidateSetDigest === first.candidateSetDigest,
    "candidate set bytes do not match the digest the rounds swept"
  );
  const expected = new Set(candidateSet.candidates.map((entry) => entry.caseId));
  for (const artifact of artifacts) {
    for (const outcome of artifact.outcomes) {
      require(
        expected.has(outcome.caseId),
        `round ${artifact.pass} carries outcome for unknown case ${outcome.caseId}`
      );
    }
    require(
      artifact.outcomes.length === expected.size,
      `round ${artifact.pass} observed ${artifact.outcomes.length} of ${expected.size} candidates; a partial round is re-run, never assembled`
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
    sourceDigests: Object.fromEntries([
      ["candidate-set", candidateSet.candidateSetDigest],
      ...rounds.map((entry) => [`round-${entry.artifact.pass}-artifact`, sha256Hex(entry.bytes)])
    ]),
    identity: first.identity,
    outcomes: artifacts.flatMap((artifact) => artifact.outcomes)
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

/**
 * THE CLUSTER-AWARE LOSS BOUND (docs/reliability-sweep-cluster-design.md).
 * Cluster unit: the collection round. Method: the repository's one
 * cluster-bootstrap implementation, shared with the censoring analysis.
 *
 * FAIL-CLOSED, NEVER IID. Below the preregistered minimum of
 * SWEEP_BOUND_MINIMUM_ROUNDS usable rounds this THROWS. It does not return a
 * Wilson interval, a wider interval, or a partial artifact: a per-case
 * interval over clustered failures is an iid-only diagnostic, and emitting
 * one here is exactly the substitution the censoring analysis's own record
 * refuses. The remedy for too few clusters is more rounds, not a different
 * formula.
 */
export function computeClusterLossBound({ receipt, receiptBytes }) {
  require(isRecord(receipt), "loss bound requires the assembled receipt");
  require(typeof receiptBytes === "string" && receiptBytes.length > 0, "loss bound requires the receipt bytes");
  require(Array.isArray(receipt.cases), "loss bound requires receipt cases");
  const outcomes = receipt.cases.flatMap((entry) => entry.passes);
  for (const outcome of outcomes) assertBareLoadOnly(outcome, "loss bound input");
  const rounds = new Set(outcomes.map((outcome) => outcome.pass));
  require(
    rounds.size >= SWEEP_BOUND_MINIMUM_ROUNDS,
    `the receipt holds ${rounds.size} collection round(s); the preregistered minimum is ${SWEEP_BOUND_MINIMUM_ROUNDS}, and below it there is NO bound: collect more rounds, never substitute an iid interval`
  );

  const keyOf = (outcome) => outcome.pass;
  const boundFor = (predicate, label) => {
    const interval = clusterInterval(outcomes, predicate, keyOf);
    require(
      interval.lo !== null && interval.hi !== null,
      `${label}: the cluster bootstrap refused ${interval.clusters} cluster(s)`
    );
    return { lo: interval.lo, hi: interval.hi };
  };

  const censoredByFamily = Object.fromEntries(
    EXPECTED_EVIDENCE_FAMILIES.map((family) => [
      family,
      boundFor((outcome) => outcome.censoredFamilies.includes(family), `censored ${family}`)
    ])
  );

  return {
    kind: SWEEP_LOSS_BOUND_KIND,
    boundVersion: SWEEP_LOSS_BOUND_VERSION,
    studyId: receipt.studyId,
    candidateSetDigest: receipt.candidateSetDigest,
    identity: receipt.identity,
    measurementCondition: receipt.measurementCondition,
    rounds: rounds.size,
    observations: outcomes.length,
    method: {
      algorithm: "cluster-bootstrap",
      clusterUnit: "collection-round",
      iterations: CLUSTER_BOOTSTRAP_ITERATIONS,
      seed: CLUSTER_BOOTSTRAP_SEED,
      percentiles: [0.025, 0.975],
      minimumClusters: SWEEP_BOUND_MINIMUM_ROUNDS
    },
    bounds: {
      bareLoadValid: boundFor((outcome) => bareLoadValid(outcome), "bare-load valid"),
      allFamiliesComplete: boundFor(
        (outcome) => allEvidenceFamiliesComplete(outcome),
        "all families complete"
      ),
      censoredByFamily
    },
    receiptSha256: sha256Hex(receiptBytes)
  };
}
