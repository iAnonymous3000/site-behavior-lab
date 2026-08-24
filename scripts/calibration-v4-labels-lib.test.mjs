import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  V4_LABEL_BATCH_KIND,
  V4_LABEL_BATCH_SCHEMA_VERSION,
  padV4LabelBatch,
  v4PaddedBatchByteLength,
  assembleV4ReferenceCases,
  buildV4AdjudicationArtifact,
  buildV4LabelsManifestCase,
  resolveV4ReferenceLabel,
  resolutionToReferenceStatus,
  validateV4AdjudicationArtifact,
  validateV4FrameTasks,
  validateV4LabelBatch,
  validateV4LabelsManifestCase
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

const FRAME = {
  schemaVersion: 1,
  artifactKind: "site-behavior-detector-calibration-frame-tasks",
  studyId: "cname-uncloaking-v4-test",
  detector: "cname-uncloaking",
  candidateCommit: "a".repeat(40),
  referenceProtocolId: "cname-independent-v1",
  cases: [
    { caseId: "alpha.example", taskSha256: sha("a") },
    { caseId: "beta.example", taskSha256: sha("b") }
  ]
};
const FRAME_TASKS_SHA256 = createHash("sha256")
  .update(`${JSON.stringify(FRAME, null, 2)}\n`)
  .digest("hex");

test("a v4 frame binds tasks and its study identity; anything answer-shaped is refused by name", () => {
  const frame = FRAME;
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
  assert.throws(() => validateV4FrameTasks({ ...frame, studyId: "" }), /need a studyId/);
  assert.throws(
    () => validateV4FrameTasks({ ...frame, artifactKind: "something-else" }),
    /kind mismatch/
  );
});

test("a v4 label batch is tri-state with per-reviewer evidence, bound to its frame's identity", () => {
  const batch = padV4LabelBatch({
    schemaVersion: V4_LABEL_BATCH_SCHEMA_VERSION,
    artifactKind: V4_LABEL_BATCH_KIND,
    role: "labeler",
    studyId: "cname-uncloaking-v4-test",
    detector: "cname-uncloaking",
    candidateCommit: "a".repeat(40),
    referenceProtocolId: "cname-independent-v1",
    frameTasksSha256: FRAME_TASKS_SHA256,
    cases: [
      { caseId: "alpha.example", value: "uncertain", evidence: { sha256: sha("1"), provenance: "har://labeler-a/1" } },
      { caseId: "beta.example", value: "absent", evidence: { sha256: sha("2"), provenance: "har://labeler-a/2" } }
    ]
  }, FRAME);
  assert.equal(validateV4LabelBatch(batch, { frame: FRAME }), batch);
  // The padded length is the frame's one fixed target.
  assert.equal(
    Buffer.byteLength(`${JSON.stringify(batch, null, 2)}\n`),
    v4PaddedBatchByteLength(FRAME)
  );
  // A batch with different values and provenance lengths pads to the SAME
  // byte length: the ciphertext length channel is closed.
  const opposite = padV4LabelBatch({
    ...batch,
    role: "tiebreaker",
    cases: [
      { caseId: "alpha.example", value: "absent", evidence: { sha256: sha("9"), provenance: "x" } },
      { caseId: "beta.example", value: "present", evidence: { sha256: sha("8"), provenance: "y" } }
    ]
  }, FRAME);
  assert.equal(
    Buffer.byteLength(`${JSON.stringify(opposite, null, 2)}\n`),
    Buffer.byteLength(`${JSON.stringify(batch, null, 2)}\n`)
  );
  // The field-wise MAXIMAL batch pads with the EMPTY string and validates.
  const maximal = padV4LabelBatch({
    ...batch,
    role: "tiebreaker",
    cases: FRAME.cases.map((entry) => ({
      caseId: entry.caseId,
      value: "uncertain",
      evidence: { sha256: sha("e"), provenance: "x".repeat(200) }
    }))
  }, FRAME);
  assert.equal(maximal.padding, "");
  assert.equal(validateV4LabelBatch(maximal, { frame: FRAME }), maximal);
  // Removing the padding (or shortening it) breaks the fixed length.
  assert.throws(
    () => validateV4LabelBatch({ ...batch, padding: batch.padding.slice(1) }, { frame: FRAME }),
    /fixed padded length/
  );
  assert.throws(
    () => validateV4LabelBatch({ ...batch, padding: "1".repeat(batch.padding.length) }, { frame: FRAME }),
    /padding must be/
  );
  // Provenance beyond the bound (or with escaping characters) refuses.
  assert.throws(
    () =>
      validateV4LabelBatch(
        padV4LabelBatch({
          ...batch,
          cases: [
            { caseId: "alpha.example", value: "absent", evidence: { sha256: sha("1"), provenance: "x".repeat(201) } },
            batch.cases[1]
          ]
        }, FRAME),
        { frame: FRAME }
      ),
    /provenance must be/
  );
  // Partial coverage is a disappearing label; refused.
  // Re-padded so the length rule cannot mask the coverage rule.
  assert.throws(
    () =>
      validateV4LabelBatch(
        padV4LabelBatch({ ...batch, cases: batch.cases.slice(0, 1) }, FRAME),
        { frame: FRAME }
      ),
    /coverage is total/
  );
  // A batch labeled under a different protocol, study, or candidate is not a
  // statement about this frame: the reviewed independence gap.
  assert.throws(
    () => validateV4LabelBatch({ ...batch, referenceProtocolId: "scanner-echo-v0" }, { frame: FRAME }),
    /does not match the frame's cname-independent-v1/
  );
  assert.throws(
    () => validateV4LabelBatch({ ...batch, studyId: "another-study" }, { frame: FRAME }),
    /does not match the frame's cname-uncloaking-v4-test/
  );
  assert.throws(
    () => validateV4LabelBatch({ ...batch, candidateCommit: "b".repeat(40) }, { frame: FRAME }),
    /candidate commit does not match/
  );
  // Identity fields alone cannot distinguish two frames with positional
  // caseIds; the CONTENT digest can, and a batch for other frame bytes is
  // refused even when every identity field matches.
  assert.throws(
    () =>
      validateV4LabelBatch(
        { ...batch, frameTasksSha256: sha("other-frame-bytes") },
        { frame: FRAME }
      ),
    /frameTasksSha256 does not match the frame-tasks artifact/
  );
  // v1 batches belong to the historical pipeline.
  assert.throws(
    () => validateV4LabelBatch({ ...batch, schemaVersion: 1 }, { frame: FRAME }),
    /historical v3 pipeline/
  );
  // Frame order is binding.
  assert.throws(
    () =>
      validateV4LabelBatch(
        { ...batch, cases: [batch.cases[1], batch.cases[0]] },
        { frame: FRAME }
      ),
    /frame order is binding/
  );
  // Evidence must be the reviewer's own record, both halves (re-padded so
  // the length rule cannot mask the provenance rule).
  assert.throws(
    () =>
      validateV4LabelBatch(
        padV4LabelBatch({
          ...batch,
          cases: [
            { caseId: "alpha.example", value: "present", evidence: { sha256: sha("1"), provenance: "" } },
            batch.cases[1]
          ]
        }, FRAME),
        { frame: FRAME }
      ),
    /provenance must be/
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

test("the merge refuses a duplicated primary and fewer than two primaries", () => {
  // The review deleted both guards with the suite green: a reviewer listed
  // twice counted as two-reviewer unanimity, and one label could stand alone.
  assert.throws(
    () =>
      resolveV4ReferenceLabel({
        labels: [
          { labelerId: "labeler-1", value: "present" },
          { labelerId: "labeler-1", value: "present" }
        ],
        tiebreaker: { labelerId: "tiebreaker-1", value: "absent" }
      }),
    /duplicate labeler labeler-1/
  );
  assert.throws(
    () =>
      resolveV4ReferenceLabel({
        labels: [{ labelerId: "labeler-1", value: "present" }],
        tiebreaker: { labelerId: "tiebreaker-1", value: "absent" }
      }),
    /at least two primary labels/
  );
});

test("the adjudication and manifest validators refuse the other generation and hand edits", () => {
  const artifact = buildV4AdjudicationArtifact({
    studyId: "s",
    detector: "cname-uncloaking",
    caseId: "alpha.example",
    resolution: { resolvedBy: "tiebreaker", value: "uncertain", tiebreakerId: "tiebreaker-1" }
  });
  assert.equal(validateV4AdjudicationArtifact(artifact), artifact);
  assert.throws(
    () => validateV4AdjudicationArtifact({ ...artifact, schemaVersion: 1 }),
    /historical v3 pipeline/
  );
  assert.throws(
    () => validateV4AdjudicationArtifact({ ...artifact, value: "maybe" }),
    /must be tri-state/
  );
  const row = buildV4LabelsManifestCase({
    caseId: "alpha.example",
    labelRecords: [
      { labelerId: "labeler-1", labelSha256: sha("1"), evidenceSha256: sha("2"), evidenceProvenance: "har://1" },
      { labelerId: "labeler-2", labelSha256: sha("3"), evidenceSha256: sha("4"), evidenceProvenance: "har://2" }
    ],
    adjudicationSha256: null
  });
  assert.deepEqual(validateV4LabelsManifestCase(JSON.parse(JSON.stringify(row))), row);
  assert.throws(
    () => validateV4LabelsManifestCase({ ...row, artifactKind: "something-else" }),
    /kind mismatch/
  );
});

test("the assembly bridge produces study-ready sides whose digests have one producer", () => {
  const batchFor = (role, values, who) => padV4LabelBatch({
    schemaVersion: V4_LABEL_BATCH_SCHEMA_VERSION,
    artifactKind: V4_LABEL_BATCH_KIND,
    role,
    studyId: FRAME.studyId,
    detector: FRAME.detector,
    candidateCommit: FRAME.candidateCommit,
    referenceProtocolId: FRAME.referenceProtocolId,
    frameTasksSha256: FRAME_TASKS_SHA256,
    cases: FRAME.cases.map((entry, index) => ({
      caseId: entry.caseId,
      value: values[index],
      evidence: { sha256: sha(String((index + 1) * (who + 1))), provenance: `har://${role}-${who}/${entry.caseId}` }
    }))
  }, FRAME);
  const assembled = assembleV4ReferenceCases({
    frame: FRAME,
    labelerBatches: [
      // Case 1: unanimous absent. Case 2: disagreement resolved uncertain.
      { labelerId: "labeler-1", batch: batchFor("labeler", ["absent", "present"], 1) },
      { labelerId: "labeler-2", batch: batchFor("labeler", ["absent", "absent"], 2) }
    ],
    tiebreakerBatch: {
      labelerId: "tiebreaker-1",
      batch: batchFor("tiebreaker", ["present", "uncertain"], 3)
    }
  });

  const unanimous = assembled.get("alpha.example");
  assert.equal(unanimous.referenceSide.status, "known");
  // Unanimous ABSENT stands even though the tiebreaker privately said
  // present: the tiebreaker only speaks on disagreement.
  assert.equal(unanimous.referenceSide.value, "absent");
  assert.equal(unanimous.referenceSide.adjudication.status, "labelers-agreed");
  assert.equal(unanimous.artifacts.adjudication, null);
  assert.equal(unanimous.artifacts.labels.length, 2);
  // Per-reviewer evidence stays distinct through assembly.
  assert.notEqual(
    unanimous.referenceSide.labels[0].evidenceSha256,
    unanimous.referenceSide.labels[1].evidenceSha256
  );
  // The manifest row validates and carries both reviewers.
  assert.equal(validateV4LabelsManifestCase(unanimous.artifacts.manifestRow).labels.length, 2);

  const disputed = assembled.get("beta.example");
  assert.equal(disputed.referenceSide.status, "unknown");
  assert.equal(disputed.referenceSide.reason, "reference-label-uncertain");
  assert.equal(disputed.referenceSide.adjudication.status, "disagreement-resolved-by-blind-tiebreaker");
  // The resolution value travels WITH the digest: the study validator binds
  // the side to it, which is what refuses the reviewed forgery.
  assert.equal(disputed.referenceSide.adjudication.value, "uncertain");
  assert.equal(
    validateV4AdjudicationArtifact(disputed.artifacts.adjudication.artifact).value,
    "uncertain"
  );
  assert.equal(disputed.artifacts.adjudication.sha256, disputed.referenceSide.adjudication.artifactDigest);
  assert.equal(disputed.artifacts.manifestRow.adjudicationSha256, disputed.artifacts.adjudication.sha256);

  // The tiebreaker cannot also be a primary.
  assert.throws(
    () =>
      assembleV4ReferenceCases({
        frame: FRAME,
        labelerBatches: [
          { labelerId: "labeler-1", batch: batchFor("labeler", ["absent", "present"], 1) },
          { labelerId: "labeler-2", batch: batchFor("labeler", ["absent", "absent"], 2) }
        ],
        tiebreakerBatch: { labelerId: "labeler-1", batch: batchFor("tiebreaker", ["present", "uncertain"], 3) }
      }),
    /distinct from the primary labelers/
  );
});
