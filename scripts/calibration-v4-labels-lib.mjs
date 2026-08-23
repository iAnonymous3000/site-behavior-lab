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

export const V4_LABEL_BATCH_KIND =
  "site-behavior-detector-calibration-label-batch-source";
export const V4_LABEL_BATCH_SCHEMA_VERSION = 2;
export const V4_ADJUDICATION_KIND =
  "site-behavior-detector-calibration-blind-tiebreaker-resolution";
export const V4_ADJUDICATION_SCHEMA_VERSION = 2;
export const V4_LABELS_MANIFEST_SCHEMA_VERSION = 4;
export const V4_FRAME_TASK_SCHEMA_VERSION = 1;

export const V4_LABEL_VALUES = Object.freeze(["present", "absent", "uncertain"]);

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
  only(value, ["schemaVersion", "referenceProtocolId", "cases"], "frame tasks");
  require(
    value.schemaVersion === V4_FRAME_TASK_SCHEMA_VERSION,
    `frame tasks schemaVersion must be ${V4_FRAME_TASK_SCHEMA_VERSION}`
  );
  require(
    typeof value.referenceProtocolId === "string" && value.referenceProtocolId.length > 0,
    "frame tasks need a referenceProtocolId"
  );
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
export function validateV4LabelBatch(value, { frameCaseIds }) {
  require(Array.isArray(frameCaseIds) && frameCaseIds.length > 0, "frame case ids are required");
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
      "cases"
    ],
    "label batch"
  );
  require(
    value.schemaVersion === V4_LABEL_BATCH_SCHEMA_VERSION,
    `label batch schemaVersion must be ${V4_LABEL_BATCH_SCHEMA_VERSION}; v1 batches belong to the historical v3 pipeline`
  );
  require(value.artifactKind === V4_LABEL_BATCH_KIND, "label batch kind mismatch");
  require(value.role === "labeler" || value.role === "tiebreaker", "label batch role must be labeler or tiebreaker");
  require(typeof value.studyId === "string" && value.studyId.length > 0, "label batch needs a studyId");
  require(typeof value.detector === "string" && value.detector.length > 0, "label batch needs a detector");
  require(
    typeof value.candidateCommit === "string" && /^[0-9a-f]{40}$/.test(value.candidateCommit),
    "label batch needs the candidate commit"
  );
  require(
    typeof value.referenceProtocolId === "string" && value.referenceProtocolId.length > 0,
    "label batch needs the reference protocol id"
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
      typeof entry.evidence.provenance === "string" && entry.evidence.provenance.length > 0,
      `${where} evidence needs provenance`
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
    caseId,
    labels: labelRecords,
    adjudicationSha256
  };
}
