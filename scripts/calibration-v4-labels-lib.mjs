/**
 * v4 label wire shapes and the tri-state merge
 * (docs/calibration-v4-reference-architecture.md).
 *
 * WHAT IS DELIBERATELY ABSENT FROM EVERY SIGNATURE HERE: the frozen frame's
 * evidence, and any `${detector}-presence` fact. The v3 reveal path required
 * the tiebreaker to match a frozen presence fact
 * (calibration-study-lib.mjs:1091-1095) and refused unanimous labels that
 * disagreed with it (calibration-label-sources-lib.mjs:505-511), which made
 * labels a verification of the scanner rather than information about the
 * site. The v4 merge takes labels and a tiebreaker and NOTHING else; there is
 * no argument through which a scanner-derived truth value could re-enter.
 *
 * The v3 modules are untouched and keep validating historical artifacts.
 */

import { sha256Hex } from "./scanner-fidelity-study-lib.mjs";

export const V4_LABEL_BATCH_KIND =
  "site-behavior-detector-calibration-label-batch-source";
export const V4_LABEL_BATCH_SCHEMA_VERSION = 3;
export const V4_ADJUDICATION_KIND =
  "site-behavior-detector-calibration-blind-tiebreaker-resolution";
export const V4_ADJUDICATION_SCHEMA_VERSION = 2;
export const V4_LABELS_MANIFEST_SCHEMA_VERSION = 4;
export const V4_LABELS_MANIFEST_KIND =
  "site-behavior-detector-calibration-labels-manifest";
export const V4_FRAME_TASK_SCHEMA_VERSION = 2;
export const V4_FRAME_TASK_KIND =
  "site-behavior-detector-calibration-frame-tasks";
export const V4_LABEL_ARTIFACT_KIND =
  "site-behavior-detector-calibration-label";
export const V4_LABEL_ARTIFACT_SCHEMA_VERSION = 2;

export const V4_LABEL_VALUES = Object.freeze(["present", "absent", "uncertain"]);
/**
 * Reviewer provenance grammar: 1..200 printable-ASCII characters excluding
 * `"` and `\`, so a provenance string's canonical-JSON serialization is
 * exactly its raw length plus two quotes and the padded-batch target is
 * computable without escape analysis.
 */
export const V4_PROVENANCE_MAX_LENGTH = 200;
const V4_PROVENANCE_GRAMMAR = /^[\x20-\x21\x23-\x5b\x5d-\x7e]{1,200}$/;
const V4_PADDING_GRAMMAR = /^0*$/;

const SHA256 = /^[0-9a-f]{64}$/;

function require(condition, message) {
  if (!condition) throw new Error(message);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function only(record, allowed, context) {
  for (const key of Object.keys(record)) {
    require(allowed.includes(key), `${context} carries unexpected field "${key}"`);
  }
}

/**
 * The frame's per-case reference-task binding: a task and protocol, never an
 * answer. A frame row carrying a referenceEvidenceDigest or any *-presence
 * fact is the v3 model and is refused by name, so the circularity cannot be
 * reintroduced through the frame file.
 */
export function validateV4FrameTasks(value) {
  require(isRecord(value), "frame tasks must be a record");
  only(
    value,
    [
      "schemaVersion",
      "artifactKind",
      "studyId",
      "detector",
      "candidateCommit",
      "referenceProtocolId",
      "referenceProtocolSha256",
      "externalDefinitions",
      "cases"
    ],
    "frame tasks"
  );
  require(
    value.schemaVersion === V4_FRAME_TASK_SCHEMA_VERSION,
    `frame tasks schemaVersion must be ${V4_FRAME_TASK_SCHEMA_VERSION}; a v1 frame predates the protocol-byte and shared-definition binding and is refused by version`
  );
  require(value.artifactKind === V4_FRAME_TASK_KIND, "frame tasks kind mismatch");
  require(typeof value.studyId === "string" && value.studyId.length > 0, "frame tasks need a studyId");
  require(typeof value.detector === "string" && value.detector.length > 0, "frame tasks need a detector");
  require(
    typeof value.candidateCommit === "string" && /^[0-9a-f]{40}$/.test(value.candidateCommit),
    "frame tasks need the candidate commit"
  );
  require(
    typeof value.referenceProtocolId === "string" && value.referenceProtocolId.length > 0,
    "frame tasks need a referenceProtocolId"
  );
  require(
    typeof value.referenceProtocolSha256 === "string" && SHA256.test(value.referenceProtocolSha256),
    "frame tasks need the referenceProtocolSha256 of the exact protocol bytes; an id alone cannot prove which bytes reviewers labeled under"
  );
  if (value.externalDefinitions !== null) {
    require(isRecord(value.externalDefinitions), "frame tasks externalDefinitions must be null or a record");
    for (const [name, definition] of Object.entries(value.externalDefinitions)) {
      require(isRecord(definition), `externalDefinitions.${name} must be a record`);
      only(definition, ["provider", "permanentId", "url", "sha256"], `externalDefinitions.${name}`);
      require(
        typeof definition.sha256 === "string" && SHA256.test(definition.sha256),
        `externalDefinitions.${name} needs a sha256`
      );
    }
  }
  require(Array.isArray(value.cases) && value.cases.length > 0, "frame tasks need cases");
  const seen = new Set();
  for (const [index, entry] of value.cases.entries()) {
    const where = `frame task ${index + 1}`;
    require(isRecord(entry), `${where} must be a record`);
    for (const forbidden of Object.keys(entry)) {
      require(
        !/referenceEvidence|presence/i.test(forbidden),
        `${where} carries "${forbidden}"; a v4 frame binds a task, never a scanner-derived answer`
      );
    }
    only(entry, ["caseId", "taskSha256"], where);
    require(typeof entry.caseId === "string" && entry.caseId.length > 0, `${where} needs a caseId`);
    require(!seen.has(entry.caseId), `duplicate frame case ${entry.caseId}`);
    seen.add(entry.caseId);
    require(
      typeof entry.taskSha256 === "string" && SHA256.test(entry.taskSha256),
      `${where} needs a sha256 task digest`
    );
  }
  return value;
}

/**
 * One reviewer's plaintext batch. Tri-state values; per-case evidence with
 * the reviewer's OWN digest and provenance. Coverage of the frame is total
 * and in frame order, exactly as v1 required, because a missing case is how a
 * label disappears.
 */
/**
 * The fixed sealed-batch length for one frame. AES-GCM ciphertext length
 * equals plaintext length, so without padding a sealed batch's public
 * ciphertext leaks its label distribution ("present" 7, "absent" 6,
 * "uncertain" 9 bytes) and provenance lengths. Every batch for a frame
 * must serialize to EXACTLY this many bytes: the length of a template
 * batch that is field-wise maximal (role "tiebreaker", every value
 * "uncertain", every provenance at V4_PROVENANCE_MAX_LENGTH, padding "").
 * Every valid batch is field-wise at or below the template, so the
 * deficit is never negative and the "0"-filled padding field makes up the
 * difference exactly. Both roles pad to the one target, so length reveals
 * neither values, provenance, nor role.
 */
export function v4PaddedBatchByteLength(frame) {
  validateV4FrameTasks(frame);
  return Buffer.byteLength(`${JSON.stringify(paddedBatchTemplate(frame), null, 2)}\n`);
}

function paddedBatchTemplate(frame) {
  return {
    schemaVersion: V4_LABEL_BATCH_SCHEMA_VERSION,
    artifactKind: V4_LABEL_BATCH_KIND,
    role: "tiebreaker",
    studyId: frame.studyId,
    detector: frame.detector,
    candidateCommit: frame.candidateCommit,
    referenceProtocolId: frame.referenceProtocolId,
    frameTasksSha256: "0".repeat(64),
    padding: "",
    cases: frame.cases.map((entry) => ({
      caseId: entry.caseId,
      value: "uncertain",
      evidence: {
        sha256: "0".repeat(64),
        provenance: "x".repeat(V4_PROVENANCE_MAX_LENGTH)
      }
    }))
  };
}

/**
 * Fill the padding field so the batch serializes to the frame's fixed
 * length. Values are untouched; only padding changes. The maximal batch
 * legitimately pads with the EMPTY string.
 */
export function padV4LabelBatch(batch, frame) {
  require(isRecord(batch), "padV4LabelBatch needs a batch record");
  const target = v4PaddedBatchByteLength(frame);
  const zeroed = { ...batch, padding: "" };
  const bare = Buffer.byteLength(`${JSON.stringify(zeroed, null, 2)}\n`);
  require(
    bare <= target,
    `batch serializes to ${bare} bytes, above the frame's fixed target ${target}; no valid batch exceeds the field-wise maximal template`
  );
  return { ...zeroed, padding: "0".repeat(target - bare) };
}

export function validateV4LabelBatch(value, { frame }) {
  validateV4FrameTasks(frame);
  const frameCaseIds = frame.cases.map((entry) => entry.caseId);
  require(isRecord(value), "label batch must be a record");
  only(
    value,
    [
      "schemaVersion",
      "artifactKind",
      "role",
      "studyId",
      "detector",
      "candidateCommit",
      "referenceProtocolId",
      "frameTasksSha256",
      "padding",
      "cases"
    ],
    "label batch"
  );
  require(
    value.schemaVersion === V4_LABEL_BATCH_SCHEMA_VERSION,
    `label batch schemaVersion must be ${V4_LABEL_BATCH_SCHEMA_VERSION}; v1 batches belong to the historical v3 pipeline, and v2 predates the fixed-length padding requirement`
  );
  require(value.artifactKind === V4_LABEL_BATCH_KIND, "label batch kind mismatch");
  require(value.role === "labeler" || value.role === "tiebreaker", "label batch role must be labeler or tiebreaker");
  require(typeof value.studyId === "string" && value.studyId.length > 0, "label batch needs a studyId");
  require(typeof value.detector === "string" && value.detector.length > 0, "label batch needs a detector");
  require(
    typeof value.candidateCommit === "string" && /^[0-9a-f]{40}$/.test(value.candidateCommit),
    "label batch needs the candidate commit"
  );
  // The batch must be a statement about THIS frame: same study, same
  // detector, same candidate, same protocol. Frame order alone binds none of
  // that, and a batch labeled under a different protocol validating against
  // this frame was the reviewed gap.
  require(
    value.studyId === frame.studyId,
    `label batch studyId ${value.studyId} does not match the frame's ${frame.studyId}`
  );
  require(
    value.detector === frame.detector,
    `label batch detector ${value.detector} does not match the frame's ${frame.detector}`
  );
  require(
    value.candidateCommit === frame.candidateCommit,
    "label batch candidate commit does not match the frame's"
  );
  require(
    value.referenceProtocolId === frame.referenceProtocolId,
    `label batch protocol ${value.referenceProtocolId} does not match the frame's ${frame.referenceProtocolId}`
  );
  // CONTENT binding, not just identity binding: caseIds are positional
  // (case-0001 onward), so two frames sharing studyId, detector, candidate,
  // protocol, and count are indistinguishable by the checks above, and a
  // batch sealed for one would replay verbatim against the other. The batch
  // therefore states WHICH frame-tasks bytes it labels; equality is against
  // the digest of the frame value's canonical serialization, which equals
  // the artifact's byte digest because frame-tasks files are canonical.
  require(
    typeof value.frameTasksSha256 === "string" &&
      value.frameTasksSha256 === sha256Hex(`${JSON.stringify(frame, null, 2)}\n`),
    "label batch frameTasksSha256 does not match the frame-tasks artifact; a batch labels exactly one frame's tasks"
  );
  // FIXED LENGTH: sealed ciphertext length equals plaintext length, so the
  // batch must serialize to exactly the frame's one target or the public
  // commitment leaks the label distribution. The empty padding string is
  // legitimate: the field-wise maximal batch has zero deficit.
  require(
    typeof value.padding === "string" && V4_PADDING_GRAMMAR.test(value.padding),
    'label batch padding must be a (possibly empty) string of "0"'
  );
  require(
    Buffer.byteLength(`${JSON.stringify(value, null, 2)}\n`) === v4PaddedBatchByteLength(frame),
    "label batch does not serialize to the frame's fixed padded length; an unpadded batch leaks its label distribution through ciphertext length"
  );
  require(Array.isArray(value.cases), "label batch needs cases");
  require(
    value.cases.length === frameCaseIds.length,
    `label batch covers ${value.cases.length} of ${frameCaseIds.length} frame cases; coverage is total`
  );
  for (const [index, entry] of value.cases.entries()) {
    const where = `label case ${index + 1}`;
    require(isRecord(entry), `${where} must be a record`);
    only(entry, ["caseId", "value", "evidence"], where);
    require(
      entry.caseId === frameCaseIds[index],
      `${where} is ${entry.caseId}; expected ${frameCaseIds[index]} (frame order is binding)`
    );
    require(
      V4_LABEL_VALUES.includes(entry.value),
      `${where} value must be present, absent, or uncertain`
    );
    require(isRecord(entry.evidence), `${where} needs the reviewer's own evidence record`);
    only(entry.evidence, ["sha256", "provenance"], `${where} evidence`);
    require(
      typeof entry.evidence.sha256 === "string" && SHA256.test(entry.evidence.sha256),
      `${where} evidence needs the reviewer's own sha256`
    );
    require(
      typeof entry.evidence.provenance === "string" &&
        V4_PROVENANCE_GRAMMAR.test(entry.evidence.provenance),
      `${where} evidence provenance must be 1..${V4_PROVENANCE_MAX_LENGTH} printable ASCII characters without quotes or backslashes`
    );
  }
  return value;
}

/**
 * THE MERGE. Unanimous primaries stand; otherwise the precommitted
 * tiebreaker's own tri-state value resolves. That is the entire rule, and the
 * signature is the guarantee: no frame, no evidence, no fact enters.
 */
export function resolveV4ReferenceLabel({ labels, tiebreaker }) {
  require(Array.isArray(labels) && labels.length >= 2, "resolution needs at least two primary labels");
  const seen = new Set();
  for (const label of labels) {
    require(isRecord(label), "each primary label must be a record");
    only(label, ["labelerId", "value"], "primary label");
    require(
      typeof label.labelerId === "string" && label.labelerId.length > 0,
      "each primary label needs a labelerId"
    );
    require(!seen.has(label.labelerId), `duplicate labeler ${label.labelerId}`);
    seen.add(label.labelerId);
    require(V4_LABEL_VALUES.includes(label.value), "primary label value must be tri-state");
  }
  require(isRecord(tiebreaker), "resolution needs the precommitted tiebreaker");
  only(tiebreaker, ["labelerId", "value"], "tiebreaker");
  require(
    typeof tiebreaker.labelerId === "string" && tiebreaker.labelerId.length > 0,
    "the tiebreaker needs a labelerId"
  );
  require(
    !seen.has(tiebreaker.labelerId),
    "the tiebreaker must be distinct from the primary labelers"
  );
  require(V4_LABEL_VALUES.includes(tiebreaker.value), "tiebreaker value must be tri-state");

  const distinct = new Set(labels.map((label) => label.value));
  if (distinct.size === 1) {
    return { resolvedBy: "unanimous", value: labels[0].value };
  }
  return { resolvedBy: "tiebreaker", value: tiebreaker.value, tiebreakerId: tiebreaker.labelerId };
}

/**
 * A resolution becomes a reference-side status. `uncertain` is the unknown
 * status with reason `reference-label-uncertain`; it is never a value, and
 * there is no branch by which it could become `absent`.
 */
export function resolutionToReferenceStatus(resolution) {
  require(isRecord(resolution), "resolution must be a record");
  require(V4_LABEL_VALUES.includes(resolution.value), "resolution value must be tri-state");
  if (resolution.value === "uncertain") {
    return { status: "unknown", reason: "reference-label-uncertain" };
  }
  return { status: "known", value: resolution.value };
}

/** The v2 adjudication artifact: the tiebreaker's OWN tri-state, attributed. */
export function buildV4AdjudicationArtifact({ studyId, detector, caseId, resolution }) {
  require(typeof studyId === "string" && studyId.length > 0, "adjudication needs a studyId");
  require(typeof detector === "string" && detector.length > 0, "adjudication needs a detector");
  require(typeof caseId === "string" && caseId.length > 0, "adjudication needs a caseId");
  require(isRecord(resolution), "adjudication needs the resolution");
  require(
    resolution.resolvedBy === "tiebreaker",
    "an adjudication artifact exists only for tiebreaker resolutions; unanimity needs none"
  );
  return {
    schemaVersion: V4_ADJUDICATION_SCHEMA_VERSION,
    artifactKind: V4_ADJUDICATION_KIND,
    studyId,
    detector,
    caseId,
    resolutionMethod: "blind-precommitted-tiebreaker",
    tiebreakerId: resolution.tiebreakerId,
    value: resolution.value
  };
}

/** Strict validator for a v4 adjudication artifact read back from disk. */
export function validateV4AdjudicationArtifact(value) {
  require(isRecord(value), "adjudication artifact must be a record");
  only(
    value,
    ["schemaVersion", "artifactKind", "studyId", "detector", "caseId", "resolutionMethod", "tiebreakerId", "value"],
    "adjudication artifact"
  );
  require(
    value.schemaVersion === V4_ADJUDICATION_SCHEMA_VERSION,
    `adjudication schemaVersion must be ${V4_ADJUDICATION_SCHEMA_VERSION}; v1 artifacts belong to the historical v3 pipeline`
  );
  require(value.artifactKind === V4_ADJUDICATION_KIND, "adjudication kind mismatch");
  require(typeof value.studyId === "string" && value.studyId.length > 0, "adjudication needs a studyId");
  require(typeof value.detector === "string" && value.detector.length > 0, "adjudication needs a detector");
  require(typeof value.caseId === "string" && value.caseId.length > 0, "adjudication needs a caseId");
  require(
    value.resolutionMethod === "blind-precommitted-tiebreaker",
    "adjudication resolution method mismatch"
  );
  require(
    typeof value.tiebreakerId === "string" && value.tiebreakerId.length > 0,
    "adjudication needs a tiebreakerId"
  );
  require(V4_LABEL_VALUES.includes(value.value), "adjudication value must be tri-state");
  return value;
}

/**
 * The v4 labels manifest row for one case: every reviewer's own evidence
 * digest beside the label artifacts, so provenance survives per source.
 */
export function buildV4LabelsManifestCase({ caseId, labelRecords, adjudicationSha256 }) {
  require(typeof caseId === "string" && caseId.length > 0, "manifest case needs a caseId");
  require(Array.isArray(labelRecords) && labelRecords.length >= 2, "manifest case needs the label records");
  for (const record of labelRecords) {
    require(isRecord(record), "each manifest label record must be a record");
    only(record, ["labelerId", "labelSha256", "evidenceSha256", "evidenceProvenance"], "manifest label record");
    require(typeof record.labelerId === "string" && record.labelerId.length > 0, "manifest record needs a labelerId");
    require(SHA256.test(record.labelSha256 ?? ""), "manifest record needs the label sha256");
    require(SHA256.test(record.evidenceSha256 ?? ""), "manifest record needs the reviewer's evidence sha256");
    require(
      typeof record.evidenceProvenance === "string" && record.evidenceProvenance.length > 0,
      "manifest record needs evidence provenance"
    );
  }
  require(
    adjudicationSha256 === null || SHA256.test(adjudicationSha256),
    "manifest adjudication sha must be null or a sha256"
  );
  return {
    schemaVersion: V4_LABELS_MANIFEST_SCHEMA_VERSION,
    artifactKind: V4_LABELS_MANIFEST_KIND,
    caseId,
    labels: labelRecords,
    adjudicationSha256
  };
}

/** Strict validator for a v4 labels-manifest row read back from disk. */
export function validateV4LabelsManifestCase(value) {
  require(isRecord(value), "manifest case must be a record");
  only(
    value,
    ["schemaVersion", "artifactKind", "caseId", "labels", "adjudicationSha256"],
    "manifest case"
  );
  require(
    value.schemaVersion === V4_LABELS_MANIFEST_SCHEMA_VERSION,
    `manifest schemaVersion must be ${V4_LABELS_MANIFEST_SCHEMA_VERSION}`
  );
  require(value.artifactKind === V4_LABELS_MANIFEST_KIND, "manifest kind mismatch");
  // Re-run the builder over the stored fields so a hand-edited row fails the
  // same checks a fresh one would.
  return buildV4LabelsManifestCase({
    caseId: value.caseId,
    labelRecords: value.labels,
    adjudicationSha256: value.adjudicationSha256
  });
}

/**
 * THE V4 ASSEMBLY BRIDGE: validated batches in, study-ready reference sides
 * and their artifacts out. Pure and deterministic: canonical label and
 * adjudication artifacts are built per case, digested, and threaded into the
 * V4ReferenceLabelRecord / V4Adjudication shapes the study validator demands,
 * so every digest the study schema requires has exactly one producer.
 *
 * What this deliberately is NOT: the ceremony's custody layer. Envelope
 * sealing, authenticated artifact fetching, roster cross-binding, and the
 * assemble CLI are ceremony-time tooling that reuses the existing custody
 * machinery and lands before the first v4 ceremony; nothing in it can change
 * a value this bridge produces, only refuse to produce one.
 */
export function assembleV4ReferenceCases({ frame, labelerBatches, tiebreakerBatch }) {
  validateV4FrameTasks(frame);
  require(
    Array.isArray(labelerBatches) && labelerBatches.length >= 2,
    "assembly needs at least two labeler batches"
  );
  const seen = new Set();
  for (const entry of labelerBatches) {
    require(isRecord(entry), "each labeler batch entry must be a record");
    only(entry, ["labelerId", "batch"], "labeler batch entry");
    require(
      typeof entry.labelerId === "string" && entry.labelerId.length > 0,
      "each labeler batch needs a labelerId"
    );
    require(!seen.has(entry.labelerId), `duplicate labeler ${entry.labelerId}`);
    seen.add(entry.labelerId);
    validateV4LabelBatch(entry.batch, { frame });
    require(entry.batch.role === "labeler", `${entry.labelerId} batch role must be labeler`);
  }
  require(isRecord(tiebreakerBatch), "assembly needs the tiebreaker batch");
  only(tiebreakerBatch, ["labelerId", "batch"], "tiebreaker batch entry");
  require(
    typeof tiebreakerBatch.labelerId === "string" && tiebreakerBatch.labelerId.length > 0,
    "the tiebreaker batch needs a labelerId"
  );
  require(
    !seen.has(tiebreakerBatch.labelerId),
    "the tiebreaker must be distinct from the primary labelers"
  );
  validateV4LabelBatch(tiebreakerBatch.batch, { frame });
  require(tiebreakerBatch.batch.role === "tiebreaker", "tiebreaker batch role must be tiebreaker");

  const cases = new Map();
  for (const [index, frameCase] of frame.cases.entries()) {
    const labelArtifacts = [];
    const labelRecords = [];
    const manifestRecords = [];
    const primaryValues = [];
    for (const { labelerId, batch } of labelerBatches) {
      const row = batch.cases[index];
      const artifact = {
        schemaVersion: V4_LABEL_ARTIFACT_SCHEMA_VERSION,
        artifactKind: V4_LABEL_ARTIFACT_KIND,
        studyId: frame.studyId,
        detector: frame.detector,
        caseId: frameCase.caseId,
        labelerId,
        value: row.value,
        evidence: { sha256: row.evidence.sha256, provenance: row.evidence.provenance }
      };
      const labelSha256 = sha256Hex(`${JSON.stringify(artifact, null, 2)}\n`);
      labelArtifacts.push({ labelerId, artifact, sha256: labelSha256 });
      labelRecords.push({
        labelerId,
        value: row.value,
        evidenceSha256: row.evidence.sha256,
        evidenceProvenance: row.evidence.provenance,
        labelArtifactDigest: labelSha256
      });
      manifestRecords.push({
        labelerId,
        labelSha256,
        evidenceSha256: row.evidence.sha256,
        evidenceProvenance: row.evidence.provenance
      });
      primaryValues.push({ labelerId, value: row.value });
    }
    const resolution = resolveV4ReferenceLabel({
      labels: primaryValues,
      tiebreaker: {
        labelerId: tiebreakerBatch.labelerId,
        value: tiebreakerBatch.batch.cases[index].value
      }
    });
    const statusPart = resolutionToReferenceStatus(resolution);
    let adjudication;
    let adjudicationArtifact = null;
    if (resolution.resolvedBy === "unanimous") {
      adjudication = { status: "labelers-agreed", tiebreakerId: null, artifactDigest: null };
    } else {
      const artifact = buildV4AdjudicationArtifact({
        studyId: frame.studyId,
        detector: frame.detector,
        caseId: frameCase.caseId,
        resolution
      });
      const sha256 = sha256Hex(`${JSON.stringify(artifact, null, 2)}\n`);
      adjudicationArtifact = { artifact, sha256 };
      adjudication = {
        status: "disagreement-resolved-by-blind-tiebreaker",
        tiebreakerId: resolution.tiebreakerId,
        artifactDigest: sha256,
        // The value travels WITH the digest, so the study validator can bind
        // the side to what the tiebreaker actually resolved.
        value: resolution.value
      };
    }
    const task = { protocolId: frame.referenceProtocolId, taskSha256: frameCase.taskSha256 };
    const referenceSide =
      statusPart.status === "known"
        ? { status: "known", value: statusPart.value, task, labels: labelRecords, adjudication }
        : {
            status: "unknown",
            reason: statusPart.reason,
            task,
            labels: labelRecords,
            adjudication
          };
    cases.set(frameCase.caseId, {
      referenceSide,
      artifacts: {
        labels: labelArtifacts,
        adjudication: adjudicationArtifact,
        manifestRow: buildV4LabelsManifestCase({
          caseId: frameCase.caseId,
          labelRecords: manifestRecords,
          adjudicationSha256: adjudicationArtifact?.sha256 ?? null
        })
      }
    });
  }
  return cases;
}
