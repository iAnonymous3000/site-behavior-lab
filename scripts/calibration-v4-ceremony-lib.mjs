/**
 * v4 ceremony tooling: the five items docs/calibration-v4-reference-architecture.md
 * deliberately deferred to ceremony time, envelope sealing for v4 batches,
 * authenticated artifact fetching/reveal, CLI support, task-byte
 * verification against taskSha256, and deep release/design identity
 * validation. Every function here is REFUSAL-ONLY: nothing can change a
 * value `assembleV4ReferenceCases` produces, only refuse to produce one.
 *
 * Custody is REUSED, never restated: sealing goes through
 * sealCalibrationLabelSourceEnvelope, fetching through
 * fetchAuthenticatedCalibrationLabelCommitments (already
 * generation-agnostic), and the reveal composes the same extracted custody
 * helpers the v3 assembly runs (roster record, commitment-set
 * arity/chronology/uniqueness, roster-set equality, per-entry envelope
 * open). The v3 SEMANTIC checks are deliberately absent by design: no
 * byte-identical evidence rule and no frozen `${detector}-presence` fact , 
 * each reviewer's evidence is their own, and uncertainty is representable.
 *
 * Pilot-runbook notes recorded at review time: GCM is unpadded, so a sealed
 * tri-state batch's ciphertext length would leak its label distribution;
 * RESOLVED by the fixed-length padding requirement in validateV4LabelBatch
 * (every batch serializes to its frame's one target length), which the
 * seal below additionally enforces at the byte level. A referenceProtocolId names
 * exactly one frozen protocol byte sequence; changing the protocol document
 * without a new id is invisible here and is caught only by the deep design
 * validation's protocol digests.
 */

import {
  CNAME_REFERENCE_TOOL_VERSION,
  CNAME_REFERENCE_WORKSHEET_KIND
} from "./calibration-cname-reference-lib.mjs";
import {
  buildCalibrationLabelEnvelopeIdentity,
  sealCalibrationLabelSourceEnvelope
} from "./calibration-label-source-envelope-lib.mjs";
import {
  assertRevealedCommitmentsEqualRoster,
  describeAuthenticatedCalibrationCommitments,
  openCalibrationCommitmentEnvelope,
  validateCalibrationCommitmentSetCustody,
  validateCalibrationRosterCustodyRecord
} from "./calibration-label-sources-lib.mjs";
import { readFileSync } from "node:fs";
import { join as pathJoin } from "node:path";
import {
  CALIBRATION_CENSORING_POLICY_ID,
  CALIBRATION_CENSORING_POLICY_PATH,
  calibrationMeasurementCondition,
  canonicalPrettyJson,
  canonicalizeCalibrationValue,
  requireCalibrationSubjectUrl,
  sha256Hex
} from "./calibration-study-lib.mjs";
import {
  V4_LABEL_BATCH_KIND,
  V4_LABEL_BATCH_SCHEMA_VERSION,
  assembleV4ReferenceCases,
  padV4LabelBatch,
  validateV4FrameTasks,
  validateV4LabelBatch
} from "./calibration-v4-labels-lib.mjs";
import { CALIBRATION_LABEL_SEALING_ALGORITHM } from "./calibration-label-source-envelope-lib.mjs";
import {
  PREREGISTERED_SIZING_ASSURANCE,
  deriveFrameSizeFromPilotEnvelope,
  requireSweptEligiblePoolCount
} from "./calibration-pilot-sizing-lib.mjs";

export const V4_REFERENCE_TASK_KIND =
  "site-behavior-detector-calibration-reference-task";
export const V4_REFERENCE_TASK_SCHEMA_VERSION = 1;

const SHA256 = /^[0-9a-f]{64}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const REFERENCE_TASK_KEYS = [
  "schemaVersion",
  "artifactKind",
  "studyId",
  "detector",
  "candidateCommit",
  "referenceProtocolId",
  "caseId",
  "subjectUrl"
];

function require(condition, message) {
  if (!condition) throw new Error(message);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * caseIds become file names (`tasks/<caseId>.json`), so the grammar refuses
 * anything path-shaped: no separators, no leading dot, no ".." segment. The
 * honest producers (domains, case-0001 style ids) all fit.
 */
function requireSafeCaseId(caseId, label) {
  require(
    typeof caseId === "string" && /^[a-z0-9][a-z0-9._-]{0,200}$/.test(caseId) && !caseId.includes(".."),
    `${label} caseId is not a safe file-name token`
  );
}

/**
 * Item 4 (producer half): one reference-task file per case plus the
 * frame-tasks artifact binding each task by digest. The task states the
 * SUBJECT and the protocol id; it carries no scanner-derived anything (the
 * frame validator refuses answer-shaped keys by name, and this builder has
 * no parameter through which an answer could enter).
 */
export function buildV4FrameTasksArtifact({
  studyId,
  detector,
  candidateCommit,
  referenceProtocolId,
  referenceProtocolSha256,
  externalDefinitions = null,
  cases
}) {
  require(
    typeof referenceProtocolSha256 === "string" && SHA256.test(referenceProtocolSha256),
    "frame tasks need the referenceProtocolSha256 of the exact protocol bytes"
  );
  require(Array.isArray(cases) && cases.length > 0, "frame tasks need cases");
  const taskBytesByCaseId = new Map();
  const frameCases = cases.map((entry) => {
    require(isRecord(entry), "each frame-task case must be a record");
    const keys = Object.keys(entry);
    require(
      JSON.stringify(keys) === JSON.stringify(["caseId", "url"]),
      `frame-task case must carry exactly caseId and url, saw ${keys.join(", ")}`
    );
    requireSafeCaseId(entry.caseId, "frame-task case");
    requireCalibrationSubjectUrl(entry.url, `${entry.caseId} reference task`);
    const task = {
      schemaVersion: V4_REFERENCE_TASK_SCHEMA_VERSION,
      artifactKind: V4_REFERENCE_TASK_KIND,
      studyId,
      detector,
      candidateCommit,
      referenceProtocolId,
      caseId: entry.caseId,
      subjectUrl: entry.url
    };
    const bytes = canonicalPrettyJson(task);
    require(!taskBytesByCaseId.has(entry.caseId), `duplicate frame case ${entry.caseId}`);
    taskBytesByCaseId.set(entry.caseId, bytes);
    return { caseId: entry.caseId, taskSha256: sha256Hex(bytes) };
  });
  const frameTasks = validateV4FrameTasks({
    schemaVersion: 2,
    artifactKind: "site-behavior-detector-calibration-frame-tasks",
    studyId,
    detector,
    candidateCommit,
    referenceProtocolId,
    referenceProtocolSha256,
    externalDefinitions,
    cases: frameCases
  });
  const frameTasksBytes = canonicalPrettyJson(frameTasks);
  return {
    frameTasks,
    frameTasksBytes,
    frameTasksSha256: sha256Hex(frameTasksBytes),
    taskBytesByCaseId
  };
}

/**
 * Item 4 (verification half): the exact task bytes for every frame case.
 * Refusal-only, an exact bijection caseId to task file, canonical bytes,
 * per-task identity equal to the frame header plus its own caseId, the
 * subject-URL rule the frozen selection contract uses, and
 * sha256(bytes) === taskSha256. Returns the frame unchanged.
 */
export function verifyV4TaskBytes({ frameTasks, taskBytesByCaseId }) {
  validateV4FrameTasks(frameTasks);
  require(
    taskBytesByCaseId instanceof Map,
    "task verification needs a caseId-to-bytes map"
  );
  require(
    taskBytesByCaseId.size === frameTasks.cases.length,
    `task files cover ${taskBytesByCaseId.size} of ${frameTasks.cases.length} frame cases; coverage is exact`
  );
  for (const frameCase of frameTasks.cases) {
    requireSafeCaseId(frameCase.caseId, "frame case");
    const bytes = taskBytesByCaseId.get(frameCase.caseId);
    require(
      typeof bytes === "string" && bytes.length > 0,
      `${frameCase.caseId} has no task file`
    );
    let parsed;
    try {
      parsed = JSON.parse(bytes);
    } catch {
      throw new Error(`${frameCase.caseId} task file is not JSON`);
    }
    require(
      bytes === canonicalPrettyJson(parsed),
      `${frameCase.caseId} task file is not canonical serialized JSON`
    );
    require(isRecord(parsed), `${frameCase.caseId} task must be a record`);
    require(
      JSON.stringify(Object.keys(parsed)) === JSON.stringify(REFERENCE_TASK_KEYS),
      `${frameCase.caseId} task must contain exactly ${REFERENCE_TASK_KEYS.join(", ")}`
    );
    require(
      parsed.schemaVersion === V4_REFERENCE_TASK_SCHEMA_VERSION &&
        parsed.artifactKind === V4_REFERENCE_TASK_KIND &&
        parsed.studyId === frameTasks.studyId &&
        parsed.detector === frameTasks.detector &&
        parsed.candidateCommit === frameTasks.candidateCommit &&
        parsed.referenceProtocolId === frameTasks.referenceProtocolId &&
        parsed.caseId === frameCase.caseId,
      `${frameCase.caseId} task identity does not match the frame`
    );
    requireCalibrationSubjectUrl(parsed.subjectUrl, `${frameCase.caseId} reference task`);
    require(
      sha256Hex(bytes) === frameCase.taskSha256,
      `${frameCase.caseId} task bytes do not match the frame's taskSha256`
    );
  }
  return frameTasks;
}

/**
 * Read a frame-tasks FILE the way custody reads artifacts: strict JSON whose
 * bytes are exactly the canonical serialization, validated as a frame-tasks
 * artifact. Both CLIs read the file only through this, so a non-canonical
 * file (whose value-derived digest would disagree with its byte digest) is
 * refused before anything binds to it.
 */
export function parseV4FrameTasksBytes(bytes) {
  let parsed;
  try {
    parsed = JSON.parse(bytes);
  } catch {
    throw new Error("frame-tasks file is not JSON");
  }
  require(
    bytes === canonicalPrettyJson(parsed),
    "frame-tasks file is not canonical serialized JSON"
  );
  return validateV4FrameTasks(parsed);
}

/**
 * Item 1: validate-then-seal. A reviewer's batch is validated against the
 * frame (including the frameTasksSha256 CONTENT binding) and the frame's
 * task bytes are verified BEFORE anything is sealed, so a wrong-protocol or
 * wrong-frame batch fails at the reviewer's desk instead of after the one
 * authorized acquisition attempt is spent. Sealing itself is the existing
 * v3 envelope (rsa-oaep-sha256+a256gcm) with the existing 9-field identity:
 * protocol and frame-content binding live inside the sealed plaintext and
 * are re-enforced at reveal by the same validator, which is the deliberate
 * decision recorded here (the envelope identity shape stays shared with v3).
 */
export function sealV4LabelBatch({
  batchBytes,
  frameTasks,
  taskBytesByCaseId,
  role,
  reviewerLogin,
  publicKeyPem,
  keyId,
  dataKey,
  iv
}) {
  verifyV4TaskBytes({ frameTasks, taskBytesByCaseId });
  let parsed;
  try {
    parsed = JSON.parse(batchBytes);
  } catch {
    throw new Error("label batch plaintext is not JSON");
  }
  // The fixed-length rule is checked on the canonical VALUE, and the seal
  // encrypts the raw BYTES; the envelope lib's own canonical-plaintext rule
  // (sealCalibrationLabelSourceEnvelope) is the ONE home that forces the
  // two to coincide, so formatting variance cannot reopen the ciphertext
  // length channel. The suite pins that refusal on this path.
  const batch = validateV4LabelBatch(parsed, { frame: frameTasks });
  require(
    batch.role === role,
    `label batch role ${batch.role} does not match the sealing role ${role}`
  );
  return sealCalibrationLabelSourceEnvelope({
    ...buildCalibrationLabelEnvelopeIdentity({
      studyId: frameTasks.studyId,
      detector: frameTasks.detector,
      role,
      candidateCommit: frameTasks.candidateCommit,
      reviewerLogin,
      keyId
    }),
    publicKeyPem,
    plaintext: batchBytes,
    ...(dataKey === undefined ? {} : { dataKey }),
    ...(iv === undefined ? {} : { iv })
  });
}

/**
 * Item 2: the v4 reveal. Composes the SAME extracted custody rules the v3
 * assembly runs, roster record, commitment-set arity/chronology/uniqueness,
 * revealed-set-equals-roster, then opens each envelope and validates the
 * plaintext as a v4 batch against the frame.
 *
 * KEY-FREE CUSTODY FIRST: the private key is a THUNK (`readPrivateKey`),
 * invoked only after every key-free check has passed, so a custody failure
 * can never cost a sealed envelope its secrecy, the same rule the v3
 * assemble CLI enforces around acquireAssemblyCustody.
 *
 * DELIBERATELY ABSENT, by the adopted architecture: no byte-identical
 * evidence rule, no frozen presence fact, no value rewriting of any kind.
 */
export function revealAuthenticatedV4LabelBatches({
  roster,
  commitments,
  readPrivateKey,
  candidate,
  candidateCommit,
  frameTasks,
  taskBytesByCaseId,
  acquisitionRunStartedAt,
  acquisitionJobStartedAt
}) {
  require(typeof readPrivateKey === "function", "the reveal key must arrive as a thunk");
  // Date.parse of an absent or malformed boundary is NaN and every NaN
  // comparison is false, which would make the chronology refusal silently
  // unreachable; the v3 caller was shielded by CI-validated metadata, this
  // exported surface is not.
  for (const [name, value] of [
    ["acquisitionRunStartedAt", acquisitionRunStartedAt],
    ["acquisitionJobStartedAt", acquisitionJobStartedAt]
  ]) {
    require(
      typeof value === "string" && ISO_INSTANT.test(value) && Number.isFinite(Date.parse(value)),
      `${name} must be an ISO-8601 UTC instant; a malformed boundary would disable the chronology refusal`
    );
  }
  validateV4FrameTasks(frameTasks);
  require(
    frameTasks.studyId === candidate.studyId &&
      frameTasks.detector === candidate.detector &&
      frameTasks.candidateCommit === candidateCommit,
    "frame tasks do not bind the revealing study, detector, and candidate"
  );
  verifyV4TaskBytes({ frameTasks, taskBytesByCaseId });
  validateCalibrationRosterCustodyRecord(roster, {
    studyId: candidate.studyId,
    candidateCommit
  });
  validateCalibrationCommitmentSetCustody({
    commitments,
    acquisitionRunStartedAt,
    acquisitionJobStartedAt
  });
  const { authenticatedCommitments, commitmentSetSha256 } =
    describeAuthenticatedCalibrationCommitments(commitments);
  assertRevealedCommitmentsEqualRoster({
    authenticatedCommitments,
    commitmentSetSha256,
    roster
  });
  const privateKeyPem = readPrivateKey();
  const labelerBatches = [];
  let tiebreakerBatch = null;
  for (const entry of commitments) {
    const opened = openCalibrationCommitmentEnvelope(entry, {
      privateKeyPem,
      candidate,
      candidateCommit
    });
    const batch = validateV4LabelBatch(opened.value, { frame: frameTasks });
    require(
      batch.role === entry.commitment.role,
      `revealed batch role ${batch.role} does not match its authenticated commitment role ${entry.commitment.role}`
    );
    const labeled = { labelerId: `github-${entry.metadata.actor}`, batch };
    if (batch.role === "tiebreaker") {
      tiebreakerBatch = labeled;
    } else {
      labelerBatches.push(labeled);
    }
  }
  return {
    labelerBatches,
    tiebreakerBatch,
    authenticatedCommitments,
    commitmentSetSha256
  };
}

/**
 * Item 5: deep release/design identity validation, refusal-only. The
 * release half CALLS the extracted v3 comparator
 * (detectorCalibrationReleaseMismatchReasons from the compiled
 * dist/schema/lib/detector-calibration.js, passed in by the caller), so the
 * fourteen-reason vocabulary, the fetchedAt-excluded Brave-list comparison,
 * and the fail-closed availability arms have exactly one home. The design
 * half compares against REQUIRED caller-stated expectations: an absent
 * expectation is a caller error and throws; only a stated-and-unequal field
 * becomes an issue. The expected measurement condition is derived from the
 * study's own detector through the one canonical-arm export, never supplied
 * as a literal.
 */
export function deepValidateV4StudyIdentity(
  { study, expectedBuildCommit, expectedRuntimeDigest, expectedDesign },
  calibrationModule
) {
  require(
    isRecord(calibrationModule) &&
      typeof calibrationModule.detectorCalibrationReleaseMismatchReasons === "function",
    "deep identity validation needs the compiled detector-calibration module"
  );
  require(isRecord(study), "deep identity validation needs the v4 study");
  require(isRecord(study.release), "the v4 study must carry a release identity");
  require(isRecord(study.design), "the v4 study must carry a design");
  require(isRecord(expectedDesign), "deep identity validation needs the design expectations");
  for (const field of [
    "samplingFrameSha256",
    "referenceProtocolSha256",
    "adjudicationProtocolSha256"
  ]) {
    require(
      typeof expectedDesign[field] === "string" && SHA256.test(expectedDesign[field]),
      `deep identity validation requires expectedDesign.${field}; an absent expectation would pass vacuously`
    );
  }
  require(
    typeof expectedDesign.sampling === "string" && expectedDesign.sampling.length > 0,
    "deep identity validation requires expectedDesign.sampling"
  );
  for (const field of [
    "independentUnits",
    "predictionBlindedToReference",
    "referenceBlindedToPrediction"
  ]) {
    require(
      typeof expectedDesign[field] === "boolean",
      `deep identity validation requires boolean expectedDesign.${field}`
    );
  }
  const issues = [];
  let expectedCondition;
  try {
    expectedCondition = calibrationMeasurementCondition(study.detector);
  } catch {
    return [`unknown detector ${String(study.detector)}; no canonical measurement arm exists`];
  }
  issues.push(
    ...calibrationModule.detectorCalibrationReleaseMismatchReasons(
      study.release,
      study.detector,
      { expectedBuildCommit, expectedRuntimeDigest }
    )
  );
  const design = study.design;
  if (design.samplingFrameDigest !== expectedDesign.samplingFrameSha256) {
    issues.push("sampling-frame-digest-mismatch");
  }
  if (design.referenceProtocolDigest !== expectedDesign.referenceProtocolSha256) {
    issues.push("reference-protocol-digest-mismatch");
  }
  if (design.adjudicationProtocolDigest !== expectedDesign.adjudicationProtocolSha256) {
    issues.push("adjudication-protocol-digest-mismatch");
  }
  if (design.sampling !== expectedDesign.sampling) {
    issues.push("sampling-design-mismatch");
  }
  if (design.independentUnits !== expectedDesign.independentUnits) {
    issues.push("independent-units-mismatch");
  }
  if (design.predictionBlindedToReference !== expectedDesign.predictionBlindedToReference) {
    issues.push("prediction-blinding-mismatch");
  }
  if (design.referenceBlindedToPrediction !== expectedDesign.referenceBlindedToPrediction) {
    issues.push("reference-blinding-mismatch");
  }
  if (
    canonicalizeCalibrationValue(design.measurementCondition) !==
    canonicalizeCalibrationValue(expectedCondition)
  ) {
    issues.push("measurement-condition-mismatch");
  }
  return issues;
}

/**
 * The governance gate every pilot entrypoint runs BEFORE doing anything: the
 * per-detector censoring-policy assignments must be EXPLICITLY approved by a
 * named human in RELEASE_READINESS.json, the committed artifact bytes must
 * match the approved digest, and the detector must be dispositioned
 * `proceed`. COMMITTED BYTES ONLY: this deliberately does not recompute the
 * disposition digest (that is the dist-backed preflight/readiness job), so a
 * reviewer on a fresh clone can seal without building anything. A pending
 * decision refuses with the decision's own vocabulary: no labels are
 * generated or sealed until the approval commit exists.
 */
export function requireApprovedCensoringPolicyAssignments({ rootDir, detector }) {
  const readiness = JSON.parse(
    readFileSync(pathJoin(rootDir, "RELEASE_READINESS.json"), "utf8")
  );
  const decision = readiness?.decisions?.calibrationCensoringPolicy;
  require(isRecord(decision), "calibrationCensoringPolicy decision is missing");
  require(
    decision.status === "approved" &&
      typeof decision.decidedBy === "string" &&
      decision.decidedBy.length > 0 &&
      typeof decision.decidedAt === "string",
    "calibrationCensoringPolicy must explicitly approve the exact candidate policy and analyzer disposition before acquisition or labeling; the decision is not approved by a named human"
  );
  require(
    decision.selected === CALIBRATION_CENSORING_POLICY_ID &&
      decision.policyArtifactPath === CALIBRATION_CENSORING_POLICY_PATH,
    "calibrationCensoringPolicy approves a different policy than the current assignments artifact"
  );
  const artifactBytes = readFileSync(
    pathJoin(rootDir, ...CALIBRATION_CENSORING_POLICY_PATH.split("/")),
    "utf8"
  );
  require(
    sha256Hex(artifactBytes) === decision.policyArtifactSha256,
    "the committed censoring-policy assignments bytes do not match the approved digest"
  );
  const artifact = JSON.parse(artifactBytes);
  require(
    artifactBytes === canonicalPrettyJson(artifact),
    "censoring-policy assignments must be canonical serialized JSON"
  );
  const row = artifact?.detectors?.[detector];
  require(isRecord(row), `the policy assignments carry no row for detector ${detector}`);
  require(
    row.disposition === "proceed",
    `detector ${detector} is dispositioned "${row.disposition}" and cannot enter a ceremony${row.holdReason ? `: ${row.holdReason}` : ""}`
  );
  return { artifact, policyArtifactSha256: decision.policyArtifactSha256, detectorRow: row };
}

/**
 * A frame built under an OLDER approved artifact must not keep operating
 * after a re-approval: the frame's frozen protocol digest and external
 * definition pins must equal the CURRENTLY approved artifact's, or seal,
 * close, reveal, and sizing all refuse. (The gate itself trusts the
 * repository checkout it runs from; the ceremony runbook verifies that
 * checkout against the protected branch before any step, which is the same
 * trust root every committed-custody check in this repository uses.)
 */
export function requireFrameMatchesApprovedArtifact(frameTasks, artifact) {
  validateV4FrameTasks(frameTasks);
  require(
    frameTasks.referenceProtocolSha256 === artifact.referenceProtocol.sha256 &&
      frameTasks.referenceProtocolId === artifact.referenceProtocol.id,
    "the frame's reference protocol does not equal the currently approved artifact's; a frame built under a superseded approval must be rebuilt"
  );
  const expectedDefinitions =
    artifact.detectors?.[frameTasks.detector]?.externalDefinitions ?? null;
  // Compared with the PURE serializer, not the dist-backed canonicalizer:
  // both sides are the same fixed-key record (the build CLI copies the
  // artifact's block into the frame verbatim), and every reviewer-facing CLI
  // calls this on a fresh clone. Reaching for the compiled canonical-JSON
  // module here made "committed-bytes check only, no build required" false
  // for the two CLIs that say it.
  require(
    canonicalPrettyJson(frameTasks.externalDefinitions) ===
      canonicalPrettyJson(expectedDefinitions),
    "the frame's external definition pins do not equal the currently approved artifact's; a frame built under a superseded approval must be rebuilt"
  );
  return frameTasks;
}

export const V4_PILOT_LABELING_AUTHORIZATION_KIND =
  "site-behavior-detector-calibration-pilot-labeling-authorization";
export const V4_PILOT_LABELING_AUTHORIZATION_SCHEMA_VERSION = 1;
export const V4_RESOLVED_LABELS_KIND =
  "site-behavior-detector-calibration-resolved-reference-labels";
export const V4_RESOLVED_LABELS_SCHEMA_VERSION = 1;
export const V4_PILOT_SIZING_KIND =
  "site-behavior-detector-calibration-pilot-sizing";
export const V4_PILOT_SIZING_SCHEMA_VERSION = 1;
const PILOT_STUDY_SUFFIX = "-prevalence-pilot";
const PILOT_BOUNDARY_LABEL = "the authorized labeling close";

function requireInstant(value, label) {
  require(
    typeof value === "string" && ISO_INSTANT.test(value) && Number.isFinite(Date.parse(value)),
    `${label} must be an ISO-8601 UTC instant`
  );
  return value;
}

function requirePilotStudyId(studyId, label) {
  require(
    typeof studyId === "string" && studyId.endsWith(PILOT_STUDY_SUFFIX) && studyId.length > PILOT_STUDY_SUFFIX.length,
    `${label} must name a prevalence pilot (studyId ending in ${PILOT_STUDY_SUFFIX})`
  );
}

/**
 * The pilot labeling authorization: the ONE authenticated home for both
 * the labeling-close instant and the authorized commitment set. Produced
 * at close time from commitment records obtained through the
 * authenticated fetcher, then committed to the repository at
 * calibration/<pilotStudyId>/pilot-labeling-authorization.json BEFORE any
 * reveal; the repo commit is the anchor, exactly as the v3 custody trio
 * is anchored. The reveal takes NO free boundary and NO free roster: a
 * chronology or membership decision an operator could re-supply at reveal
 * time would make both refusals vacuous (the flag-written-read-by-nothing
 * class).
 */
export function buildV4PilotLabelingAuthorization({
  studyId,
  detector,
  candidateCommit,
  referenceProtocolId,
  keyId,
  frameTasksSha256,
  labelingClosedAt,
  commitments
}) {
  requirePilotStudyId(studyId, "pilot labeling authorization");
  require(typeof detector === "string" && detector.length > 0, "authorization needs a detector");
  require(/^[0-9a-f]{40}$/.test(candidateCommit ?? ""), "authorization needs the candidate commit");
  require(
    typeof referenceProtocolId === "string" && referenceProtocolId.length > 0,
    "authorization needs the referenceProtocolId"
  );
  require(SHA256.test(keyId ?? ""), "authorization needs the sealing keyId");
  require(SHA256.test(frameTasksSha256 ?? ""), "authorization needs the frameTasksSha256");
  requireInstant(labelingClosedAt, "labelingClosedAt");
  require(Array.isArray(commitments) && commitments.length > 0, "authorization needs commitments");
  for (const entry of commitments) {
    requireInstant(entry?.metadata?.artifactCreatedAt, "commitment artifactCreatedAt");
    require(
      Date.parse(entry.metadata.artifactCreatedAt) < Date.parse(labelingClosedAt),
      "every commitment must predate the labeling close it is authorized under"
    );
  }
  for (const entry of commitments) {
    require(
      entry?.commitment?.keyId === keyId,
      "every authorized commitment must be sealed under the authorization's own keyId; a mismatched key would defeat every reveal after the authorization is committed"
    );
  }
  const { authenticatedCommitments, commitmentSetSha256 } =
    describeAuthenticatedCalibrationCommitments(commitments);
  const authorization = {
    schemaVersion: V4_PILOT_LABELING_AUTHORIZATION_SCHEMA_VERSION,
    artifactKind: V4_PILOT_LABELING_AUTHORIZATION_KIND,
    studyId,
    detector,
    candidateCommit,
    referenceProtocolId,
    labelSealingKey: { algorithm: CALIBRATION_LABEL_SEALING_ALGORITHM, keyId },
    frameTasksSha256,
    labelingClosedAt,
    authenticatedCommitments,
    commitmentSetSha256
  };
  const text = canonicalPrettyJson(authorization);
  return { authorization, text, sha256: sha256Hex(text) };
}

export function validateV4PilotLabelingAuthorization(value) {
  require(isRecord(value), "pilot labeling authorization must be a record");
  const keys = [
    "schemaVersion",
    "artifactKind",
    "studyId",
    "detector",
    "candidateCommit",
    "referenceProtocolId",
    "labelSealingKey",
    "frameTasksSha256",
    "labelingClosedAt",
    "authenticatedCommitments",
    "commitmentSetSha256"
  ];
  require(
    JSON.stringify(Object.keys(value)) === JSON.stringify(keys),
    `pilot labeling authorization must contain exactly ${keys.join(", ")}`
  );
  require(
    value.schemaVersion === V4_PILOT_LABELING_AUTHORIZATION_SCHEMA_VERSION &&
      value.artifactKind === V4_PILOT_LABELING_AUTHORIZATION_KIND,
    "pilot labeling authorization identity is invalid"
  );
  requirePilotStudyId(value.studyId, "pilot labeling authorization");
  require(typeof value.detector === "string" && value.detector.length > 0, "authorization needs a detector");
  require(/^[0-9a-f]{40}$/.test(value.candidateCommit ?? ""), "authorization needs the candidate commit");
  require(
    typeof value.referenceProtocolId === "string" && value.referenceProtocolId.length > 0,
    "authorization needs the referenceProtocolId"
  );
  require(
    isRecord(value.labelSealingKey) &&
      JSON.stringify(Object.keys(value.labelSealingKey)) === JSON.stringify(["algorithm", "keyId"]) &&
      value.labelSealingKey.algorithm === CALIBRATION_LABEL_SEALING_ALGORITHM &&
      SHA256.test(value.labelSealingKey.keyId ?? ""),
    "authorization needs the sealing key identity"
  );
  require(SHA256.test(value.frameTasksSha256 ?? ""), "authorization needs the frameTasksSha256");
  requireInstant(value.labelingClosedAt, "labelingClosedAt");
  require(
    Array.isArray(value.authenticatedCommitments) && value.authenticatedCommitments.length > 0,
    "authorization needs authenticated commitments"
  );
  for (const entry of value.authenticatedCommitments) {
    require(isRecord(entry), "each authorized commitment must be a record");
    requireInstant(entry.createdAt, "authorized commitment createdAt");
    require(
      Date.parse(entry.createdAt) < Date.parse(value.labelingClosedAt),
      "every authorized commitment must predate the labeling close"
    );
    require(SHA256.test(entry.ciphertextSha256 ?? ""), "authorized commitment needs ciphertextSha256");
    require(
      entry.keyId === value.labelSealingKey.keyId,
      "every authorized commitment must be sealed under the authorization's own keyId; a mismatched key would defeat every reveal after the authorization is committed"
    );
  }
  require(
    value.commitmentSetSha256 ===
      sha256Hex(`${canonicalizeCalibrationValue(value.authenticatedCommitments)}`),
    "authorization commitmentSetSha256 does not match its own commitment set"
  );
  return value;
}

/**
 * The pilot reveal. The pilot has no acquisition event, so its identity
 * and chronology rules come from the repo-committed authorization: both
 * chronology boundaries are the authorized labeling close, and the
 * revealed commitment set must EXACTLY equal the authorized one (a forged
 * or substituted record has a different ciphertext digest and
 * self-defeats). Same key-free-custody-first discipline: the private key
 * thunk is invoked only after every key-free check passes.
 */
export function revealAuthenticatedV4PilotLabelBatches({
  authorizationBytes,
  commitments,
  readPrivateKey,
  candidate,
  candidateCommit,
  frameTasks,
  taskBytesByCaseId
}) {
  require(typeof readPrivateKey === "function", "the reveal key must arrive as a thunk");
  let parsedAuthorization;
  try {
    parsedAuthorization = JSON.parse(authorizationBytes);
  } catch {
    throw new Error("pilot labeling authorization is not JSON");
  }
  require(
    authorizationBytes === canonicalPrettyJson(parsedAuthorization),
    "pilot labeling authorization must be canonical serialized JSON"
  );
  const authorization = validateV4PilotLabelingAuthorization(parsedAuthorization);
  // The artifact can prove a close was not moved BEFORE any authorized
  // commitment (per-commitment chronology) and not into the FUTURE (the
  // rule below); a close moved to a different PAST instant that still
  // postdates every commitment is indistinguishable in-artifact, and the
  // repository commit of the authorization is the protection against it.
  require(
    Date.parse(authorization.labelingClosedAt) <= Date.now(),
    "the authorized labeling close cannot postdate the reveal"
  );
  validateV4FrameTasks(frameTasks);
  require(
    authorization.studyId === candidate.studyId &&
      authorization.detector === candidate.detector &&
      authorization.candidateCommit === candidateCommit &&
      authorization.labelSealingKey.keyId === candidate.labelSealingKey.keyId,
    "pilot authorization does not bind the revealing study, detector, candidate, and sealing key"
  );
  require(
    frameTasks.studyId === candidate.studyId &&
      frameTasks.detector === candidate.detector &&
      frameTasks.candidateCommit === candidateCommit &&
      frameTasks.referenceProtocolId === authorization.referenceProtocolId,
    "frame tasks do not bind the revealing study, detector, candidate, and protocol"
  );
  require(
    authorization.frameTasksSha256 === sha256Hex(`${JSON.stringify(frameTasks, null, 2)}\n`),
    "pilot authorization frameTasksSha256 does not match the frame-tasks artifact"
  );
  verifyV4TaskBytes({ frameTasks, taskBytesByCaseId });
  require(Array.isArray(commitments) && commitments.length > 0, "the reveal needs commitment records");
  for (const entry of commitments) {
    requireInstant(entry?.metadata?.artifactCreatedAt, "commitment artifactCreatedAt");
  }
  validateCalibrationCommitmentSetCustody({
    commitments,
    acquisitionRunStartedAt: authorization.labelingClosedAt,
    acquisitionJobStartedAt: authorization.labelingClosedAt,
    boundaryLabel: PILOT_BOUNDARY_LABEL
  });
  const { authenticatedCommitments, commitmentSetSha256 } =
    describeAuthenticatedCalibrationCommitments(commitments);
  assertRevealedCommitmentsEqualRoster({
    authenticatedCommitments,
    commitmentSetSha256,
    roster: authorization
  });
  const privateKeyPem = readPrivateKey();
  const labelerBatches = [];
  let tiebreakerBatch = null;
  for (const entry of commitments) {
    const opened = openCalibrationCommitmentEnvelope(entry, {
      privateKeyPem,
      candidate,
      candidateCommit
    });
    const batch = validateV4LabelBatch(opened.value, { frame: frameTasks });
    require(
      batch.role === entry.commitment.role,
      `revealed batch role ${batch.role} does not match its authenticated commitment role ${entry.commitment.role}`
    );
    const labeled = { labelerId: `github-${entry.metadata.actor}`, batch };
    if (batch.role === "tiebreaker") {
      tiebreakerBatch = labeled;
    } else {
      labelerBatches.push(labeled);
    }
  }
  return {
    labelerBatches,
    tiebreakerBatch,
    authenticatedCommitments,
    commitmentSetSha256,
    authorization
  };
}

/**
 * The resolved-labels artifact: a pure PROJECTION of the untouched
 * bridge's reference sides. Resolution has exactly one home
 * (resolveV4ReferenceLabel inside assembleV4ReferenceCases); this
 * function computes nothing and can only restate or refuse.
 */
export function buildV4ResolvedLabelsArtifact({
  frameTasks,
  labelerBatches,
  tiebreakerBatch,
  commitmentSetSha256
}) {
  require(
    SHA256.test(commitmentSetSha256 ?? ""),
    "resolved labels need the authorized commitmentSetSha256 they were revealed under"
  );
  const bridgeCases = assembleV4ReferenceCases({ frame: frameTasks, labelerBatches, tiebreakerBatch });
  const cases = frameTasks.cases.map((frameCase) => {
    const side = bridgeCases.get(frameCase.caseId).referenceSide;
    const adjudication = side.adjudication;
    const resolvedBy = adjudication.status === "labelers-agreed" ? "unanimous" : "tiebreaker";
    return {
      caseId: frameCase.caseId,
      status: side.status,
      ...(side.status === "known" ? { value: side.value } : { reason: side.reason }),
      resolvedBy,
      tiebreakerId: adjudication.tiebreakerId,
      adjudicationSha256: adjudication.artifactDigest
    };
  });
  const artifact = {
    schemaVersion: V4_RESOLVED_LABELS_SCHEMA_VERSION,
    artifactKind: V4_RESOLVED_LABELS_KIND,
    studyId: frameTasks.studyId,
    detector: frameTasks.detector,
    candidateCommit: frameTasks.candidateCommit,
    referenceProtocolId: frameTasks.referenceProtocolId,
    frameTasksSha256: sha256Hex(`${JSON.stringify(frameTasks, null, 2)}\n`),
    commitmentSetSha256,
    cases
  };
  const text = canonicalPrettyJson(artifact);
  return { artifact, text, sha256: sha256Hex(text), bridgeCases };
}

export function validateV4ResolvedLabelsArtifact(value) {
  require(isRecord(value), "resolved labels artifact must be a record");
  const keys = [
    "schemaVersion",
    "artifactKind",
    "studyId",
    "detector",
    "candidateCommit",
    "referenceProtocolId",
    "frameTasksSha256",
    "commitmentSetSha256",
    "cases"
  ];
  require(
    JSON.stringify(Object.keys(value)) === JSON.stringify(keys),
    `resolved labels artifact must contain exactly ${keys.join(", ")}`
  );
  require(
    value.schemaVersion === V4_RESOLVED_LABELS_SCHEMA_VERSION &&
      value.artifactKind === V4_RESOLVED_LABELS_KIND,
    "resolved labels artifact identity is invalid"
  );
  require(typeof value.studyId === "string" && value.studyId.length > 0, "resolved labels need a studyId");
  require(typeof value.detector === "string" && value.detector.length > 0, "resolved labels need a detector");
  require(/^[0-9a-f]{40}$/.test(value.candidateCommit ?? ""), "resolved labels need the candidate commit");
  require(SHA256.test(value.frameTasksSha256 ?? ""), "resolved labels need the frameTasksSha256");
  require(
    SHA256.test(value.commitmentSetSha256 ?? ""),
    "resolved labels need the authorized commitmentSetSha256"
  );
  require(Array.isArray(value.cases) && value.cases.length > 0, "resolved labels need cases");
  const seen = new Set();
  for (const [index, entry] of value.cases.entries()) {
    const where = `resolved label ${index + 1}`;
    require(isRecord(entry), `${where} must be a record`);
    require(!seen.has(entry.caseId), `duplicate resolved case ${entry.caseId}`);
    seen.add(entry.caseId);
    const expected =
      entry.status === "known"
        ? ["caseId", "status", "value", "resolvedBy", "tiebreakerId", "adjudicationSha256"]
        : ["caseId", "status", "reason", "resolvedBy", "tiebreakerId", "adjudicationSha256"];
    require(
      JSON.stringify(Object.keys(entry)) === JSON.stringify(expected),
      `${where} must contain exactly ${expected.join(", ")}`
    );
    if (entry.status === "known") {
      require(
        entry.value === "present" || entry.value === "absent",
        `${where} known value must be present or absent; a resolved uncertain is UNKNOWN, never a class`
      );
    } else {
      require(entry.status === "unknown", `${where} status must be known or unknown`);
      require(
        entry.reason === "reference-label-uncertain",
        `${where} carries unknown reason "${entry.reason}"; the closed vocabulary is exactly reference-label-uncertain, and a new reason must be adjudicated into the sizing rule before it can exist`
      );
    }
    if (entry.resolvedBy === "unanimous") {
      require(
        entry.tiebreakerId === null && entry.adjudicationSha256 === null,
        `${where} unanimity carries no tiebreaker`
      );
    } else {
      require(entry.resolvedBy === "tiebreaker", `${where} resolvedBy must be unanimous or tiebreaker`);
      require(
        typeof entry.tiebreakerId === "string" && entry.tiebreakerId.length > 0,
        `${where} tiebreaker resolution needs the tiebreakerId`
      );
      require(SHA256.test(entry.adjudicationSha256 ?? ""), `${where} tiebreaker resolution needs the adjudication digest`);
    }
  }
  return value;
}

/**
 * The canonical pilot-sizing producer: consumes the RESOLVED labels
 * artifact and the frame-tasks bytes, never typed counts. The three bins
 * must PARTITION the cases; an unrecognized shape refuses rather than
 * silently shrinking a denominator. Feasibility against a supplied swept
 * pool is RECORDED, not decided here: the preregistered fail condition
 * acts on the artifact.
 */
export function computeV4PilotSizingArtifact({
  resolvedLabelsBytes,
  frameTasksBytes,
  minimumPerClass,
  sweptEligiblePool = null
}) {
  const frameTasks = parseV4FrameTasksBytes(frameTasksBytes);
  let parsed;
  try {
    parsed = JSON.parse(resolvedLabelsBytes);
  } catch {
    throw new Error("resolved labels artifact is not JSON");
  }
  require(
    resolvedLabelsBytes === canonicalPrettyJson(parsed),
    "resolved labels artifact must be canonical serialized JSON"
  );
  const resolved = validateV4ResolvedLabelsArtifact(parsed);
  const frameTasksSha256 = sha256Hex(frameTasksBytes);
  require(
    resolved.frameTasksSha256 === frameTasksSha256 &&
      resolved.studyId === frameTasks.studyId &&
      resolved.detector === frameTasks.detector &&
      resolved.candidateCommit === frameTasks.candidateCommit &&
      resolved.referenceProtocolId === frameTasks.referenceProtocolId,
    "resolved labels do not bind the supplied frame-tasks artifact"
  );
  requirePilotStudyId(resolved.studyId, "pilot sizing");
  require(
    resolved.cases.length === frameTasks.cases.length &&
      resolved.cases.every((entry, index) => entry.caseId === frameTasks.cases[index].caseId),
    "resolved labels must cover the frame exactly, case for case in frame order"
  );
  let present = 0;
  let absent = 0;
  let uncertain = 0;
  for (const entry of resolved.cases) {
    if (entry.status === "known" && entry.value === "present") present += 1;
    else if (entry.status === "known" && entry.value === "absent") absent += 1;
    else if (entry.status === "unknown" && entry.reason === "reference-label-uncertain") uncertain += 1;
    else throw new Error(`resolved case ${entry.caseId} fits no sizing bin; the partition is closed`);
  }
  const derived = deriveFrameSizeFromPilotEnvelope({
    present,
    absent,
    uncertain,
    minimumPerClass
  });
  const artifact = {
    schemaVersion: V4_PILOT_SIZING_SCHEMA_VERSION,
    artifactKind: V4_PILOT_SIZING_KIND,
    studyId: resolved.studyId,
    detector: resolved.detector,
    candidateCommit: resolved.candidateCommit,
    referenceProtocolId: resolved.referenceProtocolId,
    frameTasksSha256,
    resolvedLabelsSha256: sha256Hex(resolvedLabelsBytes),
    counts: { present, absent, uncertain, total: present + absent + uncertain },
    interval95: derived.interval95,
    minimumPerClass: derived.minimumPerClass,
    assurance: PREREGISTERED_SIZING_ASSURANCE,
    derivedN: derived.derivedN,
    feasibility:
      sweptEligiblePool === null
        ? null
        : {
            sweptEligiblePool: requireSweptEligiblePoolCount(sweptEligiblePool),
            feasible: derived.derivedN <= sweptEligiblePool
          }
  };
  const text = canonicalPrettyJson(artifact);
  return { artifact, text, sha256: sha256Hex(text) };
}

/**
 * The canonical reviewer-batch producer: converts ONE reviewer's approved
 * CNAME worksheet into the padded v4 label batch their seal will carry.
 * Reviewers never hand-author the 100-case schema; the producer applies
 * the protocol's value mapping mechanically and the reviewer's own
 * decisions file overrides individual cases, with the protocol's ABSENT
 * precondition enforced against the override too: absent requires a
 * worksheet in which every candidate resolved and no chain matched.
 *
 * Bindings, all refusal-only:
 * - frame coverage exact, case for case in frame order (a missing or
 *   duplicated worksheet case refuses);
 * - task bytes verified and each worksheet case's subject equal to its
 *   task's subjectUrl;
 * - protocol via the frame's referenceProtocolId/Sha256 (the batch
 *   inherits both through frameTasksSha256);
 * - the SHARED definitions: the worksheet's trackerSource and
 *   publicSuffixSource digests must equal the frame's pins, so a silently
 *   divergent classification definition refuses here too;
 * - reviewer and role: role is stamped into the batch, and every case's
 *   provenance embeds the reviewer login plus the worksheet digest, so a
 *   batch produced for one reviewer refuses to seal under another.
 *
 * Value mapping (docs/calibration-prereg-drafts/labeling-protocol.md): a
 * matched chain is PRESENT even when other candidates failed to resolve
 * (one reached tracker suffices); no match with every candidate resolved
 * is ABSENT; no match with any unresolved candidate is UNCERTAIN. The
 * protocol conditions ABSENT on resolution alone, so a reviewer who
 * disbelieves a recorded match, or whose case has an unresolved
 * candidate, may override to UNCERTAIN but never to ABSENT: the producer
 * refuses by name rather than coercing the value, because a plan may be
 * stricter than the protocol about uncertainty and never weaker.
 *
 * The worksheet's own shape is checked before it is read as meaning
 * (proposedLabel present|absent, determined a real boolean): a truthy
 * "false" or a capitalized label would otherwise manufacture the
 * protocol's most consequential value out of malformed input.
 */
export function buildV4ReviewerBatchFromWorksheet({
  worksheetBytes,
  frameTasks,
  taskBytesByCaseId,
  role,
  reviewerLogin,
  decisions = []
}) {
  validateV4FrameTasks(frameTasks);
  verifyV4TaskBytes({ frameTasks, taskBytesByCaseId });
  require(
    role === "labeler" || role === "tiebreaker",
    "reviewer batch role must be labeler or tiebreaker"
  );
  require(
    typeof reviewerLogin === "string" &&
      /^(?!-)(?!.*--)[a-z0-9-]{1,39}(?<!-)$/.test(reviewerLogin),
    "reviewer batch needs the reviewer's GitHub login"
  );
  let worksheet;
  try {
    worksheet = JSON.parse(worksheetBytes);
  } catch {
    throw new Error("worksheet is not JSON");
  }
  require(
    worksheetBytes === canonicalPrettyJson(worksheet),
    "worksheet must be the tool's canonical serialized JSON"
  );
  // The kind and tool version are the reference instrument's OWN exported
  // constants, never literals restated here: a restated contract is how a
  // producer comes to accept only worksheets no real reviewer can make.
  require(
    worksheet.artifactKind === CNAME_REFERENCE_WORKSHEET_KIND,
    `the reviewer batch producer consumes ${CNAME_REFERENCE_WORKSHEET_KIND} worksheets, saw ${worksheet.artifactKind}`
  );
  require(
    worksheet.toolVersion === CNAME_REFERENCE_TOOL_VERSION,
    `worksheet toolVersion ${worksheet.toolVersion} is not ${CNAME_REFERENCE_TOOL_VERSION}`
  );
  require(
    worksheet.studyId === frameTasks.studyId,
    `worksheet studyId ${worksheet.studyId} does not match the frame's ${frameTasks.studyId}`
  );
  const pins = frameTasks.externalDefinitions;
  require(
    isRecord(pins) && isRecord(pins.trackerDefinition) && isRecord(pins.publicSuffixDefinition),
    "the frame carries no external definition pins for this detector"
  );
  require(
    worksheet.trackerSource?.sha256 === pins.trackerDefinition.sha256,
    "worksheet tracker definition does not equal the frame's pinned snapshot; a silently divergent classification definition would turn definition drift into fake labeling disagreement"
  );
  require(
    worksheet.publicSuffixSource?.sha256 === pins.publicSuffixDefinition.sha256,
    "worksheet public-suffix definition does not equal the frame's pinned snapshot"
  );
  const worksheetSha256 = sha256Hex(worksheetBytes);
  const byCaseId = new Map();
  for (const entry of worksheet.cases ?? []) {
    require(isRecord(entry), "worksheet cases must be records");
    require(!byCaseId.has(entry.caseId), `worksheet duplicates case ${entry.caseId}`);
    byCaseId.set(entry.caseId, entry);
  }
  const overrides = new Map();
  for (const decision of decisions) {
    require(isRecord(decision), "each reviewer decision must be a record");
    require(
      typeof decision.caseId === "string" && byCaseId.has(decision.caseId),
      `reviewer decision names unknown case ${decision.caseId}`
    );
    require(
      decision.value === "present" || decision.value === "absent" || decision.value === "uncertain",
      `reviewer decision for ${decision.caseId} must be present, absent, or uncertain`
    );
    require(!overrides.has(decision.caseId), `duplicate reviewer decision for ${decision.caseId}`);
    overrides.set(decision.caseId, decision.value);
  }
  const cases = frameTasks.cases.map((frameCase) => {
    const entry = byCaseId.get(frameCase.caseId);
    require(entry !== undefined, `worksheet is missing frame case ${frameCase.caseId}`);
    byCaseId.delete(frameCase.caseId);
    // The two fields the mapping reads are checked for SHAPE before they are
    // read as meaning. A `determined` of "false" is truthy, and a
    // proposedLabel of "Present" is not "present": either would silently
    // manufacture the protocol's most consequential label out of malformed
    // input, in a producer whose whole contract is that deviations refuse.
    require(
      entry.proposedLabel === "present" || entry.proposedLabel === "absent",
      `${frameCase.caseId} worksheet proposedLabel must be present or absent, saw ${JSON.stringify(entry.proposedLabel)}`
    );
    require(
      typeof entry.determined === "boolean",
      `${frameCase.caseId} worksheet determined must be a boolean, saw ${JSON.stringify(entry.determined)}`
    );
    // Each worksheet case must concern the SUBJECT the frame assigned. The
    // reviewer supplies their own candidate file to the reference tool, so
    // without this a worksheet built against stale or wrong URLs would seal
    // labels for pages the frame never named.
    const task = JSON.parse(taskBytesByCaseId.get(frameCase.caseId));
    require(
      entry.subjectUrl === task.subjectUrl,
      `${frameCase.caseId} worksheet subject ${JSON.stringify(entry.subjectUrl)} is not the task's ${JSON.stringify(task.subjectUrl)}`
    );
    const anyMatch = entry.proposedLabel === "present";
    const mechanical = anyMatch ? "present" : entry.determined ? "absent" : "uncertain";
    let value = overrides.has(frameCase.caseId) ? overrides.get(frameCase.caseId) : mechanical;
    // The protocol: "Label ABSENT only when every candidate was resolved and
    // no chain matched that list." Absent is therefore permitted on exactly
    // one worksheet state, whatever the reviewer decides; a reviewer who
    // disbelieves a match downgrades to uncertain, never to absent. Refused,
    // never coerced: a plan may be stricter about uncertainty, not weaker.
    if (value === "absent") {
      require(
        entry.determined === true && !anyMatch,
        `${frameCase.caseId} may not be labeled absent: the protocol permits absent only when every candidate resolved and no chain matched` +
          `${anyMatch ? " (this worksheet records a matched chain)" : ""}` +
          `${entry.determined ? "" : " (this worksheet has unresolved candidates)"}`
      );
    }
    require(
      typeof entry.captureSha256 === "string" && SHA256.test(entry.captureSha256),
      `${frameCase.caseId} worksheet carries no reviewer capture digest`
    );
    return {
      caseId: frameCase.caseId,
      value,
      evidence: {
        sha256: entry.captureSha256,
        provenance: `worksheet:${worksheetSha256.slice(0, 16)}#${frameCase.caseId}@${reviewerLogin}`
      }
    };
  });
  require(
    byCaseId.size === 0,
    `worksheet carries ${byCaseId.size} cases outside the frame: ${[...byCaseId.keys()].slice(0, 3).join(", ")}`
  );
  const batch = padV4LabelBatch(
    {
      schemaVersion: V4_LABEL_BATCH_SCHEMA_VERSION,
      artifactKind: V4_LABEL_BATCH_KIND,
      role,
      studyId: frameTasks.studyId,
      detector: frameTasks.detector,
      candidateCommit: frameTasks.candidateCommit,
      referenceProtocolId: frameTasks.referenceProtocolId,
      frameTasksSha256: sha256Hex(`${JSON.stringify(frameTasks, null, 2)}\n`),
      cases
    },
    frameTasks
  );
  return { batch, text: canonicalPrettyJson(batch), worksheetSha256 };
}
