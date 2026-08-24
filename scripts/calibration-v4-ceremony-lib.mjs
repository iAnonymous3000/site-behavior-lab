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
 * tri-state batch's ciphertext length can leak its label distribution;
 * fixed-length padding of the plaintext is a seal-time ceremony
 * consideration, not a validator concern. A referenceProtocolId names
 * exactly one frozen protocol byte sequence; changing the protocol document
 * without a new id is invisible here and is caught only by the deep design
 * validation's protocol digests.
 */

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
import {
  calibrationMeasurementCondition,
  canonicalPrettyJson,
  canonicalizeCalibrationValue,
  requireCalibrationSubjectUrl,
  sha256Hex
} from "./calibration-study-lib.mjs";
import {
  validateV4FrameTasks,
  validateV4LabelBatch
} from "./calibration-v4-labels-lib.mjs";

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
  cases
}) {
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
    schemaVersion: 1,
    artifactKind: "site-behavior-detector-calibration-frame-tasks",
    studyId,
    detector,
    candidateCommit,
    referenceProtocolId,
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
