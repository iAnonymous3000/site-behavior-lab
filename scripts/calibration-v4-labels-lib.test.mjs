import assert from "node:assert/strict";
import { test } from "node:test";
import {
  V4_LABEL_BATCH_KIND,
  V4_LABEL_BATCH_SCHEMA_VERSION,
  buildV4AdjudicationArtifact,
  buildV4LabelsManifestCase,
  resolveV4ReferenceLabel,
  resolutionToReferenceStatus,
  validateV4FrameTasks,
  validateV4LabelBatch
} from "./calibration-v4-labels-lib.mjs";

const sha = (seed) => seed.repeat(64).slice(0, 64);

test("the merge is unanimity-then-tiebreaker, and its signature admits no frozen fact", () => {
  // Unanimous ABSENT stands on its own authority. Under v3 this exact shape
  // threw unless it reproduced the scanner's frozen presence fact; there is
  // no argument here through which such a fact could enter.
  assert.deepEqual(
    resolveV4ReferenceLabel({
      labels: [
        { labelerId: "labeler-1", value: "absent" },
        { labelerId: "labeler-2", value: "absent" }
      ],
      tiebreaker: { labelerId: "tiebreaker-1", value: "present" }
    }),
    { resolvedBy: "unanimous", value: "absent" }
  );
  // Unanimous uncertain is a result, not an error.
  assert.deepEqual(
    resolveV4ReferenceLabel({
      labels: [
        { labelerId: "labeler-1", value: "uncertain" },
        { labelerId: "labeler-2", value: "uncertain" }
      ],
      tiebreaker: { labelerId: "tiebreaker-1", value: "present" }
    }),
    { resolvedBy: "unanimous", value: "uncertain" }
  );
  // Disagreement: the precommitted tiebreaker's OWN tri-state resolves,
  // including to uncertain.
  assert.deepEqual(
    resolveV4ReferenceLabel({
      labels: [
        { labelerId: "labeler-1", value: "present" },
        { labelerId: "labeler-2", value: "absent" }
      ],
      tiebreaker: { labelerId: "tiebreaker-1", value: "uncertain" }
    }),
    { resolvedBy: "tiebreaker", value: "uncertain", tiebreakerId: "tiebreaker-1" }
  );
  // A smuggled extra argument is refused: the closed signature is the
  // evidence-independence guarantee.
  assert.throws(
    () =>
      resolveV4ReferenceLabel({
        labels: [
          { labelerId: "labeler-1", value: "present", frozenPresenceFact: true },
          { labelerId: "labeler-2", value: "absent" }
        ],
        tiebreaker: { labelerId: "tiebreaker-1", value: "present" }
      }),
    /unexpected field "frozenPresenceFact"/
  );
  // The tiebreaker is a distinct actor.
  assert.throws(
    () =>
      resolveV4ReferenceLabel({
        labels: [
          { labelerId: "labeler-1", value: "present" },
          { labelerId: "labeler-2", value: "absent" }
        ],
        tiebreaker: { labelerId: "labeler-1", value: "present" }
      }),
    /distinct from the primary labelers/
  );
});

test("uncertain resolves to the unknown status and can never become absence", () => {
  assert.deepEqual(resolutionToReferenceStatus({ resolvedBy: "unanimous", value: "uncertain" }), {
    status: "unknown",
    reason: "reference-label-uncertain"
  });
  assert.deepEqual(resolutionToReferenceStatus({ resolvedBy: "tiebreaker", value: "absent" }), {
    status: "known",
    value: "absent"
  });
  assert.deepEqual(resolutionToReferenceStatus({ resolvedBy: "unanimous", value: "present" }), {
    status: "known",
    value: "present"
  });
});

test("a v4 frame binds tasks, and anything answer-shaped is refused by name", () => {
  const frame = {
    schemaVersion: 1,
    referenceProtocolId: "cname-independent-v1",
    cases: [
      { caseId: "alpha.example", taskSha256: sha("a") },
      { caseId: "beta.example", taskSha256: sha("b") }
    ]
  };
  assert.equal(validateV4FrameTasks(frame), frame);
  assert.throws(
    () =>
      validateV4FrameTasks({
        ...frame,
        cases: [{ caseId: "alpha.example", taskSha256: sha("a"), referenceEvidenceDigest: sha("c") }]
      }),
    /binds a task, never a scanner-derived answer/
  );
  assert.throws(
    () =>
      validateV4FrameTasks({
        ...frame,
        cases: [{ caseId: "alpha.example", taskSha256: sha("a"), presenceFact: true }]
      }),
    /binds a task, never a scanner-derived answer/
  );
});

test("a v4 label batch is tri-state with per-reviewer evidence, covering the frame in order", () => {
  const frameCaseIds = ["alpha.example", "beta.example"];
  const batch = {
    schemaVersion: V4_LABEL_BATCH_SCHEMA_VERSION,
    artifactKind: V4_LABEL_BATCH_KIND,
    role: "labeler",
    studyId: "cname-uncloaking-v4-test",
    detector: "cname-uncloaking",
    candidateCommit: "a".repeat(40),
    referenceProtocolId: "cname-independent-v1",
    cases: [
      { caseId: "alpha.example", value: "uncertain", evidence: { sha256: sha("1"), provenance: "har://labeler-a/1" } },
      { caseId: "beta.example", value: "absent", evidence: { sha256: sha("2"), provenance: "har://labeler-a/2" } }
    ]
  };
  assert.equal(validateV4LabelBatch(batch, { frameCaseIds }), batch);
  // Partial coverage is a disappearing label; refused.
  assert.throws(
    () => validateV4LabelBatch({ ...batch, cases: batch.cases.slice(0, 1) }, { frameCaseIds }),
    /coverage is total/
  );
  // v1 batches belong to the historical pipeline.
  assert.throws(
    () => validateV4LabelBatch({ ...batch, schemaVersion: 1 }, { frameCaseIds }),
    /historical v3 pipeline/
  );
  // Frame order is binding.
  assert.throws(
    () =>
      validateV4LabelBatch(
        { ...batch, cases: [batch.cases[1], batch.cases[0]] },
        { frameCaseIds }
      ),
    /frame order is binding/
  );
  // Evidence must be the reviewer's own record, both halves.
  assert.throws(
    () =>
      validateV4LabelBatch(
        {
          ...batch,
          cases: [
            { caseId: "alpha.example", value: "present", evidence: { sha256: sha("1"), provenance: "" } },
            batch.cases[1]
          ]
        },
        { frameCaseIds }
      ),
    /needs provenance/
  );
});

test("adjudication artifacts exist only for tiebreaker resolutions and carry the tri-state", () => {
  const artifact = buildV4AdjudicationArtifact({
    studyId: "s",
    detector: "cname-uncloaking",
    caseId: "alpha.example",
    resolution: { resolvedBy: "tiebreaker", value: "uncertain", tiebreakerId: "tiebreaker-1" }
  });
  assert.equal(artifact.schemaVersion, 2);
  assert.equal(artifact.value, "uncertain");
  assert.equal(artifact.tiebreakerId, "tiebreaker-1");
  assert.throws(
    () =>
      buildV4AdjudicationArtifact({
        studyId: "s",
        detector: "cname-uncloaking",
        caseId: "alpha.example",
        resolution: { resolvedBy: "unanimous", value: "present" }
      }),
    /unanimity needs none/
  );
});

test("the v4 manifest row carries every reviewer's own evidence digest", () => {
  const row = buildV4LabelsManifestCase({
    caseId: "alpha.example",
    labelRecords: [
      { labelerId: "labeler-1", labelSha256: sha("1"), evidenceSha256: sha("2"), evidenceProvenance: "har://1" },
      { labelerId: "labeler-2", labelSha256: sha("3"), evidenceSha256: sha("4"), evidenceProvenance: "har://2" }
    ],
    adjudicationSha256: null
  });
  assert.equal(row.schemaVersion, 4);
  assert.equal(row.labels.length, 2);
  assert.notEqual(row.labels[0].evidenceSha256, row.labels[1].evidenceSha256);
  assert.throws(
    () =>
      buildV4LabelsManifestCase({
        caseId: "alpha.example",
        labelRecords: [
          { labelerId: "labeler-1", labelSha256: sha("1"), evidenceSha256: sha("2"), evidenceProvenance: "har://1" }
        ],
        adjudicationSha256: null
      }),
    /needs the label records/
  );
});
