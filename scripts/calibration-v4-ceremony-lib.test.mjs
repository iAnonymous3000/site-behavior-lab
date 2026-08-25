import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  calibrationLabelPublicKeyIdentity,
  openCalibrationLabelSourceEnvelope
} from "./calibration-label-source-envelope-lib.mjs";
import { describeAuthenticatedCalibrationCommitments } from "./calibration-label-sources-lib.mjs";
import { canonicalPrettyJson, sha256Hex } from "./calibration-study-lib.mjs";
import {
  V4_REFERENCE_TASK_KIND,
  buildV4FrameTasksArtifact,
  buildV4PilotLabelingAuthorization,
  buildV4ResolvedLabelsArtifact,
  computeV4PilotSizingArtifact,
  deepValidateV4StudyIdentity,
  parseV4FrameTasksBytes,
  revealAuthenticatedV4LabelBatches,
  revealAuthenticatedV4PilotLabelBatches,
  sealV4LabelBatch,
  validateV4PilotLabelingAuthorization,
  validateV4ResolvedLabelsArtifact,
  verifyV4TaskBytes
} from "./calibration-v4-ceremony-lib.mjs";
import {
  V4_LABEL_BATCH_SCHEMA_VERSION,
  assembleV4ReferenceCases,
  padV4LabelBatch
} from "./calibration-v4-labels-lib.mjs";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const requireFromHere = createRequire(import.meta.url);

const sha = (value) => createHash("sha256").update(value).digest("hex");
const CANDIDATE = "d".repeat(40);
const STUDY = "cname-uncloaking-v4-ceremony-test";
const DETECTOR = "cname-uncloaking";
const PROTOCOL = "cname-independent-v1";

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const keyId = calibrationLabelPublicKeyIdentity(publicKeyPem).keyId;

const PROTOCOL_BYTES = "# fixture labeling protocol\n";
const PROTOCOL_SHA = createHash("sha256").update(PROTOCOL_BYTES).digest("hex");
const FIXTURE_PINS = {
  trackerDefinition: {
    provider: "fixture-trackers",
    permanentId: "FIXTURE-TRACKERS-1",
    url: "https://pins.fixture.example/trackers",
    sha256: sha("d1")
  },
  publicSuffixDefinition: {
    provider: "fixture-suffixes",
    permanentId: "FIXTURE-SUFFIXES-1",
    url: "https://pins.fixture.example/suffixes",
    sha256: sha("d2")
  }
};

function builtFrame(cases = [
  { caseId: "case-0001", url: "https://alpha-news.example/" },
  { caseId: "case-0002", url: "https://beta-news.example/" }
]) {
  return buildV4FrameTasksArtifact({
    studyId: STUDY,
    detector: DETECTOR,
    candidateCommit: CANDIDATE,
    referenceProtocolId: PROTOCOL,
    referenceProtocolSha256: PROTOCOL_SHA,
    externalDefinitions: FIXTURE_PINS,
    cases
  });
}

function batchFor(built, role, values, who) {
  return padV4LabelBatch({
    schemaVersion: V4_LABEL_BATCH_SCHEMA_VERSION,
    artifactKind: "site-behavior-detector-calibration-label-batch-source",
    role,
    studyId: STUDY,
    detector: DETECTOR,
    candidateCommit: CANDIDATE,
    referenceProtocolId: PROTOCOL,
    frameTasksSha256: built.frameTasksSha256,
    cases: built.frameTasks.cases.map((entry, index) => ({
      caseId: entry.caseId,
      value: values[index],
      // Each reviewer's evidence is their OWN: distinct digests must be
      // acceptable end to end (the v3 byte-identity rule is forbidden here).
      evidence: {
        sha256: sha(`${who}:${entry.caseId}`),
        provenance: `har://${who}/${entry.caseId}`
      }
    }))
  }, built.frameTasks);
}

function commitmentEntryFor(built, role, values, actor, createdAt) {
  const batchBytes = canonicalPrettyJson(batchFor(built, role, values, actor));
  const sealed = sealV4LabelBatch({
    batchBytes,
    frameTasks: built.frameTasks,
    taskBytesByCaseId: built.taskBytesByCaseId,
    role,
    reviewerLogin: actor,
    publicKeyPem,
    keyId
  });
  return {
    metadata: {
      actor,
      artifactCreatedAt: createdAt,
      runId: 1000 + actor.length,
      runAttempt: 1,
      headSha: "e".repeat(40),
      artifactId: 2000 + actor.length,
      artifactName: `site-behavior-calibration-label-commitment-${role}-${STUDY}-1-1`,
      archiveSha256: sha(`archive:${actor}`)
    },
    commitment: {
      role,
      source: { commit: "f".repeat(40), path: `calibration-labels/${STUDY}/sources.json`, actor },
      keyId,
      envelopeSha256: sha256Hex(canonicalPrettyJson(sealed.envelope)),
      envelope: sealed.envelope
    }
  };
}

function rosterFor(commitments) {
  const { authenticatedCommitments, commitmentSetSha256 } =
    describeAuthenticatedCalibrationCommitments(commitments);
  return {
    authorizationPath: `calibration/${STUDY}/label-roster-authorization.json`,
    authorizationSha256: sha("authorization"),
    selectionLedgerPath: `calibration/${STUDY}/roster-selection-ledger.json`,
    selectionLedgerSha256: sha("selection"),
    candidateCommit: CANDIDATE,
    carrierCommit: "c".repeat(40),
    authenticatedCommitments,
    commitmentSetSha256
  };
}

const BOUNDARIES = {
  acquisitionRunStartedAt: "2026-08-24T12:00:00.000Z",
  acquisitionJobStartedAt: "2026-08-24T12:05:00.000Z"
};
const BEFORE = "2026-08-22T00:00:00.000Z";

test("frame tasks build canonically, bind by digest, and refuse non-subject URLs", () => {
  const built = builtFrame();
  assert.equal(built.frameTasks.cases.length, 2);
  assert.equal(built.frameTasksSha256, sha256Hex(built.frameTasksBytes));
  for (const [caseId, bytes] of built.taskBytesByCaseId) {
    const parsed = JSON.parse(bytes);
    assert.equal(bytes, canonicalPrettyJson(parsed));
    assert.equal(parsed.artifactKind, V4_REFERENCE_TASK_KIND);
    assert.equal(parsed.caseId, caseId);
    assert.equal(
      built.frameTasks.cases.find((entry) => entry.caseId === caseId).taskSha256,
      sha256Hex(bytes)
    );
  }
  // Determinism: the same inputs produce the same bytes.
  assert.equal(builtFrame().frameTasksSha256, built.frameTasksSha256);
  // The file reader accepts only the canonical bytes: a re-serialized file
  // whose value-derived digest would disagree with its byte digest refuses.
  assert.equal(parseV4FrameTasksBytes(built.frameTasksBytes).studyId, STUDY);
  assert.throws(
    () => parseV4FrameTasksBytes(JSON.stringify(built.frameTasks)),
    /not canonical serialized JSON/
  );
  assert.throws(
    () => builtFrame([{ caseId: "case-0001", url: "http://insecure.example/" }]),
    /must use HTTPS/
  );
  assert.throws(
    () => builtFrame([{ caseId: "case-0001", url: "https://user:pw@x.example/" }]),
    /cannot carry credentials/
  );
  assert.throws(
    () =>
      builtFrame([
        { caseId: "case-0001", url: "https://a.example/" },
        { caseId: "case-0001", url: "https://b.example/" }
      ]),
    /duplicate frame case/
  );
  // caseIds become file names; anything path-shaped is refused.
  for (const evil of ["../escape", "a/b", ".hidden", "a..b"]) {
    assert.throws(
      () => builtFrame([{ caseId: evil, url: "https://a.example/" }]),
      /not a safe file-name token/
    );
  }
});

test("task-byte verification is exact: a flipped byte, a missing task, or a foreign identity refuses", () => {
  const built = builtFrame();
  assert.equal(
    verifyV4TaskBytes({ frameTasks: built.frameTasks, taskBytesByCaseId: built.taskBytesByCaseId }),
    built.frameTasks
  );
  const flipped = new Map(built.taskBytesByCaseId);
  flipped.set("case-0001", flipped.get("case-0001").replace("alpha", "alpha-tampered"));
  assert.throws(
    () => verifyV4TaskBytes({ frameTasks: built.frameTasks, taskBytesByCaseId: flipped }),
    /task bytes do not match the frame's taskSha256/
  );
  const missing = new Map(built.taskBytesByCaseId);
  missing.delete("case-0002");
  assert.throws(
    () => verifyV4TaskBytes({ frameTasks: built.frameTasks, taskBytesByCaseId: missing }),
    /coverage is exact/
  );
  // A task whose bytes digest correctly for ANOTHER frame's header cannot
  // satisfy this frame: identity fields are inside the digested bytes.
  const foreign = buildV4FrameTasksArtifact({
    studyId: "another-study",
    detector: DETECTOR,
    candidateCommit: CANDIDATE,
    referenceProtocolId: PROTOCOL,
    referenceProtocolSha256: PROTOCOL_SHA,
    externalDefinitions: FIXTURE_PINS,
    cases: [
      { caseId: "case-0001", url: "https://alpha-news.example/" },
      { caseId: "case-0002", url: "https://beta-news.example/" }
    ]
  });
  assert.throws(
    () =>
      verifyV4TaskBytes({
        frameTasks: built.frameTasks,
        taskBytesByCaseId: foreign.taskBytesByCaseId
      }),
    /task identity does not match the frame/
  );
  const notCanonical = new Map(built.taskBytesByCaseId);
  notCanonical.set(
    "case-0001",
    JSON.stringify(JSON.parse(notCanonical.get("case-0001")))
  );
  assert.throws(
    () => verifyV4TaskBytes({ frameTasks: built.frameTasks, taskBytesByCaseId: notCanonical }),
    /not canonical serialized JSON/
  );
});

test("sealing validates the batch and the tasks BEFORE encrypting, and round-trips", () => {
  const built = builtFrame();
  const good = canonicalPrettyJson(batchFor(built, "labeler", ["present", "uncertain"], "alice"));
  const sealed = sealV4LabelBatch({
    batchBytes: good,
    frameTasks: built.frameTasks,
    taskBytesByCaseId: built.taskBytesByCaseId,
    role: "labeler",
    reviewerLogin: "alice",
    publicKeyPem,
    keyId
  });
  const opened = openCalibrationLabelSourceEnvelope(sealed.envelope, privateKeyPem, {
    schemaVersion: 1,
    artifactKind: "site-behavior-detector-calibration-label-source-envelope",
    studyId: STUDY,
    detector: DETECTOR,
    role: "labeler",
    candidateCommit: CANDIDATE,
    reviewerLogin: "alice",
    algorithm: "rsa-oaep-sha256+a256gcm",
    keyId
  });
  assert.equal(opened.text, good);
  // Role mismatch refuses before any sealing.
  assert.throws(
    () =>
      sealV4LabelBatch({
        batchBytes: good,
        frameTasks: built.frameTasks,
        taskBytesByCaseId: built.taskBytesByCaseId,
        role: "tiebreaker",
        reviewerLogin: "alice",
        publicKeyPem,
        keyId
      }),
    /does not match the sealing role/
  );
  // A batch for OTHER frame bytes refuses at validation: the content binding.
  const otherBuilt = buildV4FrameTasksArtifact({
    studyId: STUDY,
    detector: DETECTOR,
    candidateCommit: CANDIDATE,
    referenceProtocolId: PROTOCOL,
    referenceProtocolSha256: PROTOCOL_SHA,
    externalDefinitions: FIXTURE_PINS,
    cases: [
      { caseId: "case-0001", url: "https://gamma-news.example/" },
      { caseId: "case-0002", url: "https://delta-news.example/" }
    ]
  });
  const otherBatch = canonicalPrettyJson(
    batchFor(otherBuilt, "labeler", ["present", "uncertain"], "alice")
  );
  assert.throws(
    () =>
      sealV4LabelBatch({
        batchBytes: otherBatch,
        frameTasks: built.frameTasks,
        taskBytesByCaseId: built.taskBytesByCaseId,
        role: "labeler",
        reviewerLogin: "alice",
        publicKeyPem,
        keyId
      }),
    /frameTasksSha256 does not match the frame-tasks artifact/
  );
  // Non-canonical plaintext bytes refuse even when the parsed VALUE passes
  // every check: the seal encrypts raw bytes, and formatting variance
  // would reopen the ciphertext length channel the padding closed.
  assert.throws(
    () =>
      sealV4LabelBatch({
        batchBytes: JSON.stringify(JSON.parse(good), null, 4),
        frameTasks: built.frameTasks,
        taskBytesByCaseId: built.taskBytesByCaseId,
        role: "labeler",
        reviewerLogin: "alice",
        publicKeyPem,
        keyId
      }),
    /canonical serialized JSON/
  );
  // Tampered task bytes refuse the seal outright: never seal against
  // unverified tasks.
  const tampered = new Map(built.taskBytesByCaseId);
  tampered.set("case-0001", tampered.get("case-0001").replace("alpha", "omega"));
  assert.throws(
    () =>
      sealV4LabelBatch({
        batchBytes: good,
        frameTasks: built.frameTasks,
        taskBytesByCaseId: tampered,
        role: "labeler",
        reviewerLogin: "alice",
        publicKeyPem,
        keyId
      }),
    /task bytes do not match/
  );
});

test("the v4 reveal composes the v3 custody rules, then feeds the untouched bridge", () => {
  const built = builtFrame();
  const commitments = [
    commitmentEntryFor(built, "labeler", ["present", "uncertain"], "alice", BEFORE),
    commitmentEntryFor(built, "labeler", ["present", "absent"], "bob", BEFORE),
    commitmentEntryFor(built, "tiebreaker", ["present", "absent"], "carol", BEFORE)
  ];
  const roster = rosterFor(commitments);
  let keyReads = 0;
  const revealed = revealAuthenticatedV4LabelBatches({
    roster,
    commitments,
    readPrivateKey: () => {
      keyReads += 1;
      return privateKeyPem;
    },
    candidate: { studyId: STUDY, detector: DETECTOR, labelSealingKey: { keyId } },
    candidateCommit: CANDIDATE,
    frameTasks: built.frameTasks,
    taskBytesByCaseId: built.taskBytesByCaseId,
    ...BOUNDARIES
  });
  assert.equal(keyReads, 1);
  assert.equal(revealed.labelerBatches.length, 2);
  assert.equal(revealed.tiebreakerBatch.labelerId, "github-carol");
  assert.equal(revealed.commitmentSetSha256, roster.commitmentSetSha256);
  // Reviewers supplied DIFFERENT evidence digests per case and the pipeline
  // accepted them: reintroducing the v3 byte-identity rule fails this test.
  const [a, b] = revealed.labelerBatches.map((entry) => entry.batch.cases[0].evidence.sha256);
  assert.notEqual(a, b);
  // The untouched bridge consumes the revealed batches directly.
  const cases = assembleV4ReferenceCases({
    frame: built.frameTasks,
    labelerBatches: revealed.labelerBatches,
    tiebreakerBatch: revealed.tiebreakerBatch
  });
  assert.equal(cases.get("case-0001").referenceSide.status, "known");
  assert.equal(cases.get("case-0001").referenceSide.value, "present");
  // Disagreement on case-0002 resolves to the tiebreaker's own value.
  assert.equal(cases.get("case-0002").referenceSide.status, "known");
  assert.equal(cases.get("case-0002").referenceSide.value, "absent");
  assert.equal(
    cases.get("case-0002").referenceSide.adjudication.status,
    "disagreement-resolved-by-blind-tiebreaker"
  );
});

test("reveal custody refusals fire BEFORE the key thunk is invoked", () => {
  const built = builtFrame();
  const commitments = [
    commitmentEntryFor(built, "labeler", ["present", "uncertain"], "alice", BEFORE),
    commitmentEntryFor(built, "labeler", ["present", "absent"], "bob", BEFORE),
    commitmentEntryFor(built, "tiebreaker", ["present", "absent"], "carol", BEFORE)
  ];
  const roster = rosterFor(commitments);
  const reveal = (overrides) => {
    let keyReads = 0;
    const input = {
      roster,
      commitments,
      readPrivateKey: () => {
        keyReads += 1;
        return privateKeyPem;
      },
      candidate: { studyId: STUDY, detector: DETECTOR, labelSealingKey: { keyId } },
      candidateCommit: CANDIDATE,
      frameTasks: built.frameTasks,
      taskBytesByCaseId: built.taskBytesByCaseId,
      ...BOUNDARIES,
      ...overrides
    };
    try {
      revealAuthenticatedV4LabelBatches(input);
      return { threw: null, keyReads };
    } catch (error) {
      return { threw: error.message, keyReads };
    }
  };

  // A commitment created ONE HOUR after the boundary: chronology refusal.
  const late = [
    commitments[0],
    commitments[1],
    commitmentEntryFor(built, "tiebreaker", ["present", "absent"], "carol", "2026-08-24T13:00:00.000Z")
  ];
  const lateResult = reveal({ commitments: late, roster: rosterFor(late) });
  assert.match(lateResult.threw, /must exist before the authenticated acquisition run and job start/);
  assert.equal(lateResult.keyReads, 0, "a custody failure must never cost an envelope its secrecy");

  // A replayed ciphertext: uniqueness refusal, key untouched.
  const replayed = [commitments[0], { ...commitments[1], commitment: { ...commitments[0].commitment, role: "labeler" }, metadata: { ...commitments[1].metadata } }, commitments[2]];
  const replayResult = reveal({ commitments: replayed, roster: rosterFor(replayed) });
  assert.match(replayResult.threw, /cross-actor replay is forbidden/);
  assert.equal(replayResult.keyReads, 0);

  // A substituted commitment that authenticates and opens cleanly but was
  // never authorized: the revealed set must EXACTLY equal the roster.
  const substituted = [
    commitments[0],
    commitmentEntryFor(built, "labeler", ["absent", "absent"], "mallory", BEFORE),
    commitments[2]
  ];
  const substitutionResult = reveal({ commitments: substituted });
  assert.match(
    substitutionResult.threw,
    /do not exactly equal the pre-acquisition authorized roster/
  );
  assert.equal(substitutionResult.keyReads, 0);

  // Tampered task bytes refuse before the key.
  const tampered = new Map(built.taskBytesByCaseId);
  tampered.set("case-0001", tampered.get("case-0001").replace("alpha", "omega"));
  const taskResult = reveal({ taskBytesByCaseId: tampered });
  assert.match(taskResult.threw, /task bytes do not match/);
  assert.equal(taskResult.keyReads, 0);

  // A frame for a different candidate refuses before the key.
  const frameResult = reveal({ candidateCommit: "9".repeat(40) });
  assert.ok(frameResult.threw !== null);
  assert.equal(frameResult.keyReads, 0);

  // An absent or malformed boundary would make every NaN comparison false
  // and silently disable the chronology refusal: refused up front instead.
  const missingBoundary = reveal({ acquisitionRunStartedAt: undefined });
  assert.match(missingBoundary.threw, /must be an ISO-8601 UTC instant/);
  assert.equal(missingBoundary.keyReads, 0);
  const malformedBoundary = reveal({ acquisitionJobStartedAt: "yesterday" });
  assert.match(malformedBoundary.threw, /must be an ISO-8601 UTC instant/);
  assert.equal(malformedBoundary.keyReads, 0);
});

test("deep identity validation refuses release and design drift through ONE comparator home", () => {
  const calibration = requireFromHere(
    path.join(moduleDir, "..", "dist", "schema", "lib", "detector-calibration.js")
  );
  const legacy = requireFromHere(
    path.join(moduleDir, "..", "dist", "schema", "lib", "legacy-methodology.js")
  );
  const pkg = JSON.parse(readFileSync(path.join(moduleDir, "..", "package.json"), "utf8"));
  const runtime = {
    observer: "node-playwright",
    nodeVersion: pkg.engines.node,
    playwrightVersion: legacy.NODE_PLAYWRIGHT_VERSION,
    runtimeDigest: sha("runtime")
  };
  const release = calibration.currentDetectorCalibrationReleaseIdentity(
    DETECTOR,
    CANDIDATE,
    runtime
  );
  const design = {
    sampling: "simple-random",
    samplingFrame: `calibration/${STUDY}/frame-tasks.json`,
    samplingFrameDigest: sha("frame-tasks"),
    selectionProtocol: "seeded draw from the swept eligible pool",
    referenceProtocol: "independent reviewer capture and resolvers",
    referenceProtocolDigest: sha("reference-protocol"),
    adjudicationProtocol: "blind precommitted tiebreaker",
    adjudicationProtocolDigest: sha("adjudication-protocol"),
    measurementCondition: calibration.detectorCalibrationMeasurementCondition(DETECTOR),
    independentUnits: true,
    predictionBlindedToReference: true,
    referenceBlindedToPrediction: true
  };
  const study = Object.freeze({
    schemaVersion: 4,
    studyId: STUDY,
    detector: DETECTOR,
    release,
    design
  });
  const expectations = {
    expectedBuildCommit: CANDIDATE,
    expectedRuntimeDigest: runtime.runtimeDigest,
    expectedDesign: {
      samplingFrameSha256: sha("frame-tasks"),
      referenceProtocolSha256: sha("reference-protocol"),
      adjudicationProtocolSha256: sha("adjudication-protocol"),
      sampling: "simple-random",
      independentUnits: true,
      predictionBlindedToReference: true,
      referenceBlindedToPrediction: true
    }
  };
  assert.deepEqual(
    deepValidateV4StudyIdentity({ study, ...expectations }, calibration),
    []
  );
  // Release drift: the v3 vocabulary arrives verbatim from the ONE comparator.
  const drifted = deepValidateV4StudyIdentity(
    {
      study: { ...study, release: { ...release, buildCommit: "1".repeat(40) } },
      ...expectations
    },
    calibration
  );
  // The implementation digest is computed from the EXPECTED commit, so a
  // mutated release.buildCommit alone yields exactly one reason.
  assert.deepEqual(drifted, ["build-commit-mismatch"]);
  // Design drift, one reason per field.
  // EVERY design field drifts to exactly its own reason: deleting any one
  // comparison in the validator fails one of these.
  const designDrifts = [
    [{ samplingFrameDigest: sha("other") }, "sampling-frame-digest-mismatch"],
    [{ referenceProtocolDigest: sha("other") }, "reference-protocol-digest-mismatch"],
    [{ adjudicationProtocolDigest: sha("other") }, "adjudication-protocol-digest-mismatch"],
    [{ sampling: "census" }, "sampling-design-mismatch"],
    [{ independentUnits: false }, "independent-units-mismatch"],
    [{ predictionBlindedToReference: false }, "prediction-blinding-mismatch"],
    [{ referenceBlindedToPrediction: false }, "reference-blinding-mismatch"]
  ];
  for (const [drift, reason] of designDrifts) {
    assert.deepEqual(
      deepValidateV4StudyIdentity(
        { study: { ...study, design: { ...design, ...drift } }, ...expectations },
        calibration
      ),
      [reason]
    );
  }
  const conditionDrift = deepValidateV4StudyIdentity(
    {
      study: {
        ...study,
        design: {
          ...design,
          measurementCondition: { ...design.measurementCondition, gpcEnabled: true }
        }
      },
      ...expectations
    },
    calibration
  );
  assert.deepEqual(conditionDrift, ["measurement-condition-mismatch"]);
  // An absent expectation is a caller error, never a vacuous pass.
  assert.throws(
    () =>
      deepValidateV4StudyIdentity(
        {
          study,
          ...expectations,
          expectedDesign: { ...expectations.expectedDesign, samplingFrameSha256: undefined }
        },
        calibration
      ),
    /requires expectedDesign.samplingFrameSha256/
  );
  // Unknown detector: a precise refusal, not a digest over undefined.
  const unknown = deepValidateV4StudyIdentity(
    { study: { ...study, detector: "not-a-detector" }, ...expectations },
    calibration
  );
  assert.deepEqual(unknown, ["unknown detector not-a-detector; no canonical measurement arm exists"]);
});


function pilotBuilt() {
  return buildV4FrameTasksArtifact({
    studyId: `${STUDY}-prevalence-pilot`,
    detector: DETECTOR,
    candidateCommit: CANDIDATE,
    referenceProtocolId: PROTOCOL,
    referenceProtocolSha256: PROTOCOL_SHA,
    externalDefinitions: FIXTURE_PINS,
    cases: [
      { caseId: "pilot-alpha.example", url: "https://pilot-alpha.example/" },
      { caseId: "pilot-beta.example", url: "https://pilot-beta.example/" },
      { caseId: "pilot-gamma.example", url: "https://pilot-gamma.example/" }
    ]
  });
}

function pilotBatchFor(built, role, values, who) {
  return padV4LabelBatch({
    schemaVersion: V4_LABEL_BATCH_SCHEMA_VERSION,
    artifactKind: "site-behavior-detector-calibration-label-batch-source",
    role,
    studyId: built.frameTasks.studyId,
    detector: DETECTOR,
    candidateCommit: CANDIDATE,
    referenceProtocolId: PROTOCOL,
    frameTasksSha256: built.frameTasksSha256,
    cases: built.frameTasks.cases.map((entry, index) => ({
      caseId: entry.caseId,
      value: values[index],
      evidence: {
        sha256: sha(`${who}:${entry.caseId}`),
        provenance: `har://${who}/${entry.caseId}`
      }
    }))
  }, built.frameTasks);
}

function pilotCommitmentFor(built, role, values, actor, createdAt) {
  const batchBytes = canonicalPrettyJson(pilotBatchFor(built, role, values, actor));
  const sealed = sealV4LabelBatch({
    batchBytes,
    frameTasks: built.frameTasks,
    taskBytesByCaseId: built.taskBytesByCaseId,
    role,
    reviewerLogin: actor,
    publicKeyPem,
    keyId
  });
  return {
    metadata: {
      actor,
      artifactCreatedAt: createdAt,
      runId: 5000 + actor.length,
      runAttempt: 1,
      headSha: "e".repeat(40),
      artifactId: 6000 + actor.length,
      artifactName: `site-behavior-calibration-label-commitment-${role}-${built.frameTasks.studyId}-1-1`,
      archiveSha256: sha(`pilot-archive:${actor}`)
    },
    commitment: {
      role,
      source: {
        commit: "f".repeat(40),
        path: `calibration-labels/${built.frameTasks.studyId}/sources.json`,
        actor
      },
      keyId,
      envelopeSha256: sha256Hex(canonicalPrettyJson(sealed.envelope)),
      envelope: sealed.envelope
    }
  };
}

const CLOSE = "2026-08-23T00:00:00.000Z";

test("the pilot pipeline: close, reveal, resolve, and size from resolved labels only", () => {
  const built = pilotBuilt();
  const commitments = [
    pilotCommitmentFor(built, "labeler", ["present", "absent", "uncertain"], "alice", BEFORE),
    pilotCommitmentFor(built, "labeler", ["present", "absent", "absent"], "bob", BEFORE),
    pilotCommitmentFor(built, "tiebreaker", ["present", "absent", "uncertain"], "carol", BEFORE)
  ];
  const closed = buildV4PilotLabelingAuthorization({
    studyId: built.frameTasks.studyId,
    detector: DETECTOR,
    candidateCommit: CANDIDATE,
    referenceProtocolId: PROTOCOL,
    keyId,
    frameTasksSha256: built.frameTasksSha256,
    labelingClosedAt: CLOSE,
    commitments
  });
  assert.equal(validateV4PilotLabelingAuthorization(closed.authorization), closed.authorization);

  let keyReads = 0;
  const revealed = revealAuthenticatedV4PilotLabelBatches({
    authorizationBytes: closed.text,
    commitments,
    readPrivateKey: () => {
      keyReads += 1;
      return privateKeyPem;
    },
    candidate: {
      studyId: built.frameTasks.studyId,
      detector: DETECTOR,
      labelSealingKey: { keyId }
    },
    candidateCommit: CANDIDATE,
    frameTasks: built.frameTasks,
    taskBytesByCaseId: built.taskBytesByCaseId
  });
  assert.equal(keyReads, 1);
  assert.equal(revealed.labelerBatches.length, 2);
  assert.equal(revealed.tiebreakerBatch.labelerId, "github-carol");

  const resolved = buildV4ResolvedLabelsArtifact({
    frameTasks: built.frameTasks,
    labelerBatches: revealed.labelerBatches,
    tiebreakerBatch: revealed.tiebreakerBatch,
    commitmentSetSha256: revealed.commitmentSetSha256
  });
  assert.equal(resolved.artifact.commitmentSetSha256, revealed.commitmentSetSha256);
  // Resolved labels without their authorizing set digest are unanchored.
  assert.throws(
    () =>
      buildV4ResolvedLabelsArtifact({
        frameTasks: built.frameTasks,
        labelerBatches: revealed.labelerBatches,
        tiebreakerBatch: revealed.tiebreakerBatch
      }),
    /need the authorized commitmentSetSha256/
  );
  assert.equal(validateV4ResolvedLabelsArtifact(resolved.artifact), resolved.artifact);
  // The unknown-reason vocabulary is CLOSED: a future reason must be
  // adjudicated into the sizing rule before it can exist, or the sizing
  // denominator would silently shrink.
  assert.throws(
    () =>
      validateV4ResolvedLabelsArtifact({
        ...resolved.artifact,
        cases: resolved.artifact.cases.map((entry) =>
          entry.status === "unknown" ? { ...entry, reason: "reference-capture-lost" } : entry
        )
      }),
    /the closed vocabulary is exactly reference-label-uncertain/
  );
  // The artifact is a PURE projection of the bridge: unanimity stands, the
  // disagreement resolves to the tiebreaker's own tri-state, and a resolved
  // uncertain is UNKNOWN, never a class.
  const byCase = new Map(resolved.artifact.cases.map((entry) => [entry.caseId, entry]));
  assert.deepEqual(byCase.get("pilot-alpha.example"), {
    caseId: "pilot-alpha.example",
    status: "known",
    value: "present",
    resolvedBy: "unanimous",
    tiebreakerId: null,
    adjudicationSha256: null
  });
  assert.equal(byCase.get("pilot-beta.example").value, "absent");
  const gamma = byCase.get("pilot-gamma.example");
  assert.equal(gamma.status, "unknown");
  assert.equal(gamma.reason, "reference-label-uncertain");
  assert.equal(gamma.resolvedBy, "tiebreaker");
  assert.match(gamma.adjudicationSha256, /^[0-9a-f]{64}$/);
  // Direct-projection equality: rebuilding from the same batches is
  // byte-identical, so resolution has exactly one home.
  assert.equal(
    buildV4ResolvedLabelsArtifact({
      frameTasks: built.frameTasks,
      labelerBatches: revealed.labelerBatches,
      tiebreakerBatch: revealed.tiebreakerBatch,
      commitmentSetSha256: revealed.commitmentSetSha256
    }).text,
    resolved.text
  );

  // The sizing producer binds case for case: an alien roster with the right
  // COUNT but foreign caseIds refuses before anything is counted.
  const alien = {
    ...resolved.artifact,
    cases: resolved.artifact.cases.map((entry, index) => ({ ...entry, caseId: `alien-${index}.example` }))
  };
  assert.throws(
    () =>
      computeV4PilotSizingArtifact({
        resolvedLabelsBytes: `${JSON.stringify(alien, null, 2)}\n`,
        frameTasksBytes: built.frameTasksBytes,
        minimumPerClass: 100
      }),
    /case for case in frame order/
  );

  // Sizing consumes ONLY the artifacts. Three cases is below the pilot
  // minimum, so the producer must refuse: no prevalence estimate from a
  // toy pilot.
  assert.throws(
    () =>
      computeV4PilotSizingArtifact({
        resolvedLabelsBytes: resolved.text,
        frameTasksBytes: built.frameTasksBytes,
        minimumPerClass: 100
      }),
    /preregistered minimum of 100/
  );
});

test("pilot custody refusals: late commitments, substituted records, and free boundaries are impossible", () => {
  const built = pilotBuilt();
  const commitments = [
    pilotCommitmentFor(built, "labeler", ["present", "absent", "absent"], "alice", BEFORE),
    pilotCommitmentFor(built, "labeler", ["present", "absent", "absent"], "bob", BEFORE),
    pilotCommitmentFor(built, "tiebreaker", ["present", "absent", "absent"], "carol", BEFORE)
  ];
  // A commitment AFTER the close cannot even be authorized.
  const late = pilotCommitmentFor(built, "tiebreaker", ["present", "absent", "absent"], "carol", "2026-08-23T01:00:00.000Z");
  assert.throws(
    () =>
      buildV4PilotLabelingAuthorization({
        studyId: built.frameTasks.studyId,
        detector: DETECTOR,
        candidateCommit: CANDIDATE,
        referenceProtocolId: PROTOCOL,
        keyId,
        frameTasksSha256: built.frameTasksSha256,
        labelingClosedAt: CLOSE,
        commitments: [commitments[0], commitments[1], late]
      }),
    /must predate the labeling close/
  );
  const closed = buildV4PilotLabelingAuthorization({
    studyId: built.frameTasks.studyId,
    detector: DETECTOR,
    candidateCommit: CANDIDATE,
    referenceProtocolId: PROTOCOL,
    keyId,
    frameTasksSha256: built.frameTasksSha256,
    labelingClosedAt: CLOSE,
    commitments
  });
  const reveal = (overrides) => {
    let keyReads = 0;
    try {
      revealAuthenticatedV4PilotLabelBatches({
        authorizationBytes: closed.text,
        commitments,
        readPrivateKey: () => {
          keyReads += 1;
          return privateKeyPem;
        },
        candidate: {
          studyId: built.frameTasks.studyId,
          detector: DETECTOR,
          labelSealingKey: { keyId }
        },
        candidateCommit: CANDIDATE,
        frameTasks: built.frameTasks,
        taskBytesByCaseId: built.taskBytesByCaseId,
        ...overrides
      });
      return { threw: null, keyReads };
    } catch (error) {
      return { threw: error.message, keyReads };
    }
  };
  // A commitment sealed cleanly but AFTER the authorized close: the
  // chronology refusal fires with the pilot boundary noun, key untouched.
  const lateSet = [commitments[0], commitments[1], late];
  const lateResult = reveal({ commitments: lateSet });
  assert.match(lateResult.threw, /must exist before the authorized labeling close|do not exactly equal/);
  assert.equal(lateResult.keyReads, 0);
  // A substituted record that seals and authenticates but was never
  // authorized: the revealed set must EXACTLY equal the authorization.
  const substituted = [
    commitments[0],
    pilotCommitmentFor(built, "labeler", ["absent", "absent", "absent"], "mallory", BEFORE),
    commitments[2]
  ];
  const substitution = reveal({ commitments: substituted });
  assert.match(substitution.threw, /do not exactly equal the pre-acquisition authorized roster/);
  assert.equal(substitution.keyReads, 0);
  // A NaN-shaped createdAt cannot slip past the chronology comparison.
  const nan = [
    { ...commitments[0], metadata: { ...commitments[0].metadata, artifactCreatedAt: "not-a-time" } },
    commitments[1],
    commitments[2]
  ];
  const nanResult = reveal({ commitments: nan });
  assert.match(nanResult.threw, /must be an ISO-8601 UTC instant/);
  assert.equal(nanResult.keyReads, 0);
  // A non-pilot studyId cannot enter the pilot path at all.
  assert.throws(
    () =>
      buildV4PilotLabelingAuthorization({
        studyId: STUDY,
        detector: DETECTOR,
        candidateCommit: CANDIDATE,
        referenceProtocolId: PROTOCOL,
        keyId,
        frameTasksSha256: built.frameTasksSha256,
        labelingClosedAt: CLOSE,
        commitments
      }),
    /must name a prevalence pilot/
  );
  // A substituted entry inside the authorization itself fails the set's
  // own digest: the authorization cannot disagree with itself.
  const forged = {
    ...closed.authorization,
    authenticatedCommitments: closed.authorization.authenticatedCommitments.map((entry, index) =>
      index === 0 ? { ...entry, actor: "mallory" } : entry
    )
  };
  assert.throws(
    () => validateV4PilotLabelingAuthorization(forged),
    /does not match its own commitment set/
  );
  // A close moved BEFORE the authorized commitments is refused by the
  // authorization's own per-commitment chronology, timelessly (a close
  // moved to a LATER past instant is indistinguishable in-artifact by
  // design; the repository commit of the authorization is the protection
  // there, and the postdate rule covers future instants).
  const tampered = closed.text.replace(CLOSE, "2026-08-21T00:00:00.000Z");
  const tamperedResult = reveal({ authorizationBytes: tampered });
  assert.match(tamperedResult.threw, /must predate the labeling close/);
  assert.equal(tamperedResult.keyReads, 0);
  // A close instant in the FUTURE relative to the reveal is refused by the
  // postdate rule regardless of the run date.
  const future = closed.text.replace(
    CLOSE,
    new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, ".000Z")
  );
  const futureResult = reveal({ authorizationBytes: future });
  assert.ok(futureResult.threw !== null);
  assert.equal(futureResult.keyReads, 0);
  // A keyId that disagrees with the sealed commitments refuses at CLOSE
  // time, key-free, before the authorization can ever be committed.
  assert.throws(
    () =>
      buildV4PilotLabelingAuthorization({
        studyId: built.frameTasks.studyId,
        detector: DETECTOR,
        candidateCommit: CANDIDATE,
        referenceProtocolId: PROTOCOL,
        keyId: sha("f"),
        frameTasksSha256: built.frameTasksSha256,
        labelingClosedAt: CLOSE,
        commitments
      }),
    /sealed under the authorization's own keyId/
  );
});

/**
 * A GOVERNED fixture world for spawn tests: the real scripts, a
 * producer-generated policy artifact with fixture pins, and a
 * RELEASE_READINESS decision in the requested state. Production code
 * carries no bypass: the CLIs resolve governance from their own script
 * location, so the world copies the scripts wholesale.
 */
async function governedWorld(status) {
  const { buildCalibrationPolicyAssignmentsArtifact } = await import(
    "./calibration-policy-artifact-lib.mjs"
  );
  const root = mkdtempSync(path.join(tmpdir(), "v4-governed-"));
  const scriptsDir = path.join(root, "scripts");
  mkdirSync(scriptsDir, { recursive: true });
  for (const file of readdirSync(moduleDir)) {
    if (file.endsWith(".mjs") && !file.endsWith(".test.mjs")) {
      writeFileSync(path.join(scriptsDir, file), readFileSync(path.join(moduleDir, file)));
    }
  }
  const produced = buildCalibrationPolicyAssignmentsArtifact({
    protocolBytes: PROTOCOL_BYTES,
    trackerDefinition: FIXTURE_PINS.trackerDefinition,
    publicSuffixDefinition: FIXTURE_PINS.publicSuffixDefinition
  });
  // The copied scripts resolve their compiled contracts relative to the
  // world root; share the repo's dist read-only.
  symlinkSync(path.join(moduleDir, "..", "dist"), path.join(root, "dist"));
  const artifactDir = path.join(root, "research", "measurement-candidate");
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(
    path.join(artifactDir, "calibration-censoring-policy-assignments.json"),
    produced.text
  );
  const decision = {
    currentlySupportedSelections: ["per-detector-censoring-assignments-v1"],
    recommendedDisposition: "human-decision-required-before-labeling",
    selected: "per-detector-censoring-assignments-v1",
    policyArtifactPath:
      "research/measurement-candidate/calibration-censoring-policy-assignments.json",
    policyArtifactSha256: produced.policyArtifactSha256,
    dispositionSha256: produced.dispositionSha256,
    status,
    ...(status === "approved"
      ? { decidedBy: "fixture-approver", decidedAt: "2026-08-24T00:00:00.000Z" }
      : {})
  };
  writeFileSync(
    path.join(root, "RELEASE_READINESS.json"),
    `${JSON.stringify({ decisions: { calibrationCensoringPolicy: decision } }, null, 2)}\n`
  );
  const protocolPath = path.join(root, "protocol.md");
  writeFileSync(protocolPath, PROTOCOL_BYTES);
  return { root, scriptsDir, protocolPath, produced };
}




test("the binding's assignments verifier refuses a proposition whose digest disagrees with its text", async () => {
  const binding = requireFromHere(
    path.join(moduleDir, "..", "dist", "schema", "lib", "measurement-candidate-binding.js")
  );
  const { buildCalibrationPolicyAssignmentsArtifact } = await import(
    "./calibration-policy-artifact-lib.mjs"
  );
  const produced = buildCalibrationPolicyAssignmentsArtifact({
    protocolBytes: PROTOCOL_BYTES,
    trackerDefinition: FIXTURE_PINS.trackerDefinition,
    publicSuffixDefinition: FIXTURE_PINS.publicSuffixDefinition
  });
  const root = mkdtempSync(path.join(tmpdir(), "v4-assignments-verify-"));
  const artifactPath = path.join(root, "research", "measurement-candidate");
  mkdirSync(artifactPath, { recursive: true });
  const write = (value) => {
    const text = `${JSON.stringify(value, null, 2)}\n`;
    writeFileSync(
      path.join(artifactPath, "calibration-censoring-policy-assignments.json"),
      text
    );
    return createHash("sha256").update(text).digest("hex");
  };
  const goodSha = write(produced.artifact);
  assert.equal(
    typeof binding.verifyCalibrationCensoringPolicyAssignments(
      root,
      "test",
      "d".repeat(40),
      goodSha,
      false
    ),
    "object"
  );
  const tampered = JSON.parse(JSON.stringify(produced.artifact));
  tampered.detectors["cname-uncloaking"].proposition.text += " and something else";
  const tamperedSha = write(tampered);
  assert.throws(
    () =>
      binding.verifyCalibrationCensoringPolicyAssignments(
        root,
        "test",
        "d".repeat(40),
        tamperedSha,
        false
      ),
    /proposition.sha256 does not digest its own text/
  );
});

test("the committed policy artifact IS the derivation from the step-3 table, by EXECUTION", () => {
  // The producer --check byte-compares the committed artifact against a
  // fresh derivation from DETECTOR_POLICY_ASSIGNMENTS plus the committed
  // protocol bytes and pins: desynchronizing the table from the artifact
  // (editing either without regenerating) fails this spawn.
  const result = spawnSync(
    process.execPath,
    [
      "scripts/calibration-policy-artifact.mjs",
      "check",
      "--tracker-manifest",
      "research/measurement-candidate/cname-tracker-definition.json",
      "--public-suffix-manifest",
      "research/measurement-candidate/cname-public-suffix-definition.json"
    ],
    { cwd: path.join(moduleDir, ".."), encoding: "utf8" }
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /censoring-policy assignments verified/);
  // And the repository's OWN decision block pins exactly those digests.
  const readiness = JSON.parse(
    readFileSync(path.join(moduleDir, "..", "RELEASE_READINESS.json"), "utf8")
  );
  const decision = readiness.decisions.calibrationCensoringPolicy;
  const digests = result.stdout.match(/sha256 ([0-9a-f]{64}), disposition ([0-9a-f]{64})/);
  assert.equal(decision.policyArtifactSha256, digests[1]);
  assert.equal(decision.dispositionSha256, digests[2]);
});

test("the governance gate refuses pending decisions and held detectors by EXECUTION", async () => {
  const pendingWorld = await governedWorld("pending-named-human-approval");
  const spawnIn = (world, args) =>
    spawnSync(process.execPath, [path.join(world.scriptsDir, args[0].replace(/^scripts\//, "")), ...args.slice(1)], {
      cwd: world.root,
      encoding: "utf8"
    });
  const casesPath = path.join(pendingWorld.root, "cases.json");
  writeFileSync(
    casesPath,
    `${JSON.stringify({ studyId: STUDY, candidates: [{ caseId: "case-0001", url: "https://a.example/" }] }, null, 2)}\n`
  );
  // A pending decision blocks the frame producer outright: no labels can be
  // generated before the named-human approval commit exists.
  const pendingBuild = spawnIn(pendingWorld, [
    "scripts/calibration-v4-frame-tasks.mjs",
    "build",
    "--study-id", STUDY,
    "--detector", DETECTOR,
    "--candidate-commit", CANDIDATE,
    "--protocol-id", "independent-labeling-protocol@1",
    "--protocol-file", pendingWorld.protocolPath,
    "--cases", casesPath,
    "--output-root", path.join(pendingWorld.root, "frame")
  ]);
  assert.notEqual(pendingBuild.status, 0);
  assert.match(pendingBuild.stderr, /not approved by a named human/);

  // A HELD detector cannot be framed even under an approved decision.
  const approvedWorld = await governedWorld("approved");
  writeFileSync(
    path.join(approvedWorld.root, "cases.json"),
    `${JSON.stringify({ studyId: STUDY, candidates: [{ caseId: "case-0001", url: "https://a.example/" }] }, null, 2)}\n`
  );
  const heldBuild = spawnIn(approvedWorld, [
    "scripts/calibration-v4-frame-tasks.mjs",
    "build",
    "--study-id", STUDY,
    "--detector", "fingerprint-heuristics",
    "--candidate-commit", CANDIDATE,
    "--protocol-id", "independent-labeling-protocol@1",
    "--protocol-file", approvedWorld.protocolPath,
    "--cases", path.join(approvedWorld.root, "cases.json"),
    "--output-root", path.join(approvedWorld.root, "frame")
  ]);
  assert.notEqual(heldBuild.status, 0);
  assert.match(heldBuild.stderr, /dispositioned "hold" and cannot enter a ceremony/);

  // A wrong protocol file refuses against the approved artifact's pin.
  const wrongProtocol = path.join(approvedWorld.root, "wrong-protocol.md");
  writeFileSync(wrongProtocol, "# a different protocol\n");
  const wrongBuild = spawnIn(approvedWorld, [
    "scripts/calibration-v4-frame-tasks.mjs",
    "build",
    "--study-id", STUDY,
    "--detector", DETECTOR,
    "--candidate-commit", CANDIDATE,
    "--protocol-id", "independent-labeling-protocol@1",
    "--protocol-file", wrongProtocol,
    "--cases", path.join(approvedWorld.root, "cases.json"),
    "--output-root", path.join(approvedWorld.root, "frame")
  ]);
  assert.notEqual(wrongBuild.status, 0);
  assert.match(wrongBuild.stderr, /does not equal the approved artifact's referenceProtocol.sha256/);
});

test("both CLIs work by EXECUTION: build, check, seal, and refuse tampered tasks", async () => {
  const world = await governedWorld("approved");
  const root = mkdtempSync(path.join(tmpdir(), "v4-ceremony-"));
  const casesPath = path.join(root, "cases.json");
  writeFileSync(
    casesPath,
    `${JSON.stringify(
      {
        studyId: STUDY,
        candidates: [
          { caseId: "case-0001", url: "https://alpha-news.example/" },
          { caseId: "case-0002", url: "https://beta-news.example/" }
        ]
      },
      null,
      2
    )}\n`
  );
  const outRoot = path.join(root, "frame");
  const run = (args, env = {}) =>
    spawnSync(process.execPath, [path.join(world.scriptsDir, args[0].replace(/^scripts\//, "")), ...args.slice(1)], {
      cwd: world.root,
      encoding: "utf8",
      env: { ...process.env, ...env }
    });
  const build = run([
    "scripts/calibration-v4-frame-tasks.mjs",
    "build",
    "--study-id",
    STUDY,
    "--detector",
    DETECTOR,
    "--candidate-commit",
    CANDIDATE,
    "--protocol-id",
    "independent-labeling-protocol@1",
    "--protocol-file",
    world.protocolPath,
    "--cases",
    casesPath,
    "--output-root",
    outRoot
  ]);
  assert.equal(build.status, 0, build.stderr);
  assert.match(build.stdout, /frame tasks written: 2 cases/);
  const check = run([
    "scripts/calibration-v4-frame-tasks.mjs",
    "check",
    "--frame-tasks",
    path.join(outRoot, "frame-tasks.json"),
    "--tasks-dir",
    path.join(outRoot, "tasks")
  ]);
  assert.equal(check.status, 0, check.stderr);
  assert.match(check.stdout, /frame tasks verified: 2 cases/);

  const frameTasks = JSON.parse(readFileSync(path.join(outRoot, "frame-tasks.json"), "utf8"));
  const frameTasksSha256 = sha256Hex(readFileSync(path.join(outRoot, "frame-tasks.json"), "utf8"));
  const keyPath = path.join(root, "public.pem");
  writeFileSync(keyPath, publicKeyPem);
  const batchPath = path.join(root, "batch.json");
  writeFileSync(
    batchPath,
    canonicalPrettyJson(
      padV4LabelBatch(
        {
          schemaVersion: V4_LABEL_BATCH_SCHEMA_VERSION,
          artifactKind: "site-behavior-detector-calibration-label-batch-source",
          role: "labeler",
          studyId: STUDY,
          detector: DETECTOR,
          candidateCommit: CANDIDATE,
          referenceProtocolId: frameTasks.referenceProtocolId,
          frameTasksSha256,
          cases: frameTasks.cases.map((entry) => ({
            caseId: entry.caseId,
            value: "uncertain",
            evidence: { sha256: sha(`cli:${entry.caseId}`), provenance: `har://cli/${entry.caseId}` }
          }))
        },
        frameTasks
      )
    )
  );
  const sealOut = path.join(root, "sealed.json");
  const seal = run([
    "scripts/calibration-v4-seal-label-batch.mjs",
    "--role",
    "labeler",
    "--actor",
    "alice",
    "--public-key",
    keyPath,
    "--frame-tasks",
    path.join(outRoot, "frame-tasks.json"),
    "--tasks-dir",
    path.join(outRoot, "tasks"),
    "--input",
    batchPath,
    "--output",
    sealOut
  ]);
  assert.equal(seal.status, 0, seal.stderr);
  assert.match(seal.stdout, /plaintext was not copied/);

  // Tamper one task file on disk: check mode and seal mode both refuse.
  const taskPath = path.join(outRoot, "tasks", "case-0001.json");
  writeFileSync(taskPath, readFileSync(taskPath, "utf8").replace("alpha", "omega"));
  const failedCheck = run([
    "scripts/calibration-v4-frame-tasks.mjs",
    "check",
    "--frame-tasks",
    path.join(outRoot, "frame-tasks.json"),
    "--tasks-dir",
    path.join(outRoot, "tasks")
  ]);
  assert.notEqual(failedCheck.status, 0);
  assert.match(failedCheck.stderr, /task bytes do not match/);
  // FULL PILOT PIPELINE BY EXECUTION: a 100-case pilot frame, three padded
  // sealed batches, close, reveal (env key), and sizing, all through the
  // real CLIs.
  const pilotRoot = mkdtempSync(path.join(tmpdir(), "v4-pilot-smoke-"));
  const pilotStudy = `${STUDY}-prevalence-pilot`;
  writeFileSync(
    path.join(pilotRoot, "cases.json"),
    `${JSON.stringify(
      {
        studyId: pilotStudy,
        candidates: Array.from({ length: 100 }, (_, index) => ({
          caseId: `pilot-${String(index + 1).padStart(4, "0")}.example`,
          url: `https://pilot-${String(index + 1).padStart(4, "0")}.example/`
        }))
      },
      null,
      2
    )}\n`
  );
  const pilotFrameRoot = path.join(pilotRoot, "frame");
  assert.equal(
    run([
      "scripts/calibration-v4-frame-tasks.mjs",
      "build",
      "--study-id", pilotStudy,
      "--detector", DETECTOR,
      "--candidate-commit", CANDIDATE,
      "--protocol-id", "independent-labeling-protocol@1",
      "--protocol-file", world.protocolPath,
      "--cases", path.join(pilotRoot, "cases.json"),
      "--output-root", pilotFrameRoot
    ]).status,
    0
  );
  const pilotFrame = JSON.parse(readFileSync(path.join(pilotFrameRoot, "frame-tasks.json"), "utf8"));
  const pilotFrameSha = sha256Hex(readFileSync(path.join(pilotFrameRoot, "frame-tasks.json"), "utf8"));
  const pilotKeyPath = path.join(pilotRoot, "public.pem");
  writeFileSync(pilotKeyPath, publicKeyPem);
  const commitDir = path.join(pilotRoot, "commitments");
  const reviewers = [
    ["labeler", "alice", 25],
    ["labeler", "bob", 30],
    ["tiebreaker", "carol", 25]
  ];
  for (const [index, [role, actor, presentCount]] of reviewers.entries()) {
    // UNPADDED reviewer-authored batch: the seal CLI pads it.
    const batchPath = path.join(pilotRoot, `${actor}.json`);
    writeFileSync(
      batchPath,
      `${JSON.stringify(
        {
          schemaVersion: V4_LABEL_BATCH_SCHEMA_VERSION,
          artifactKind: "site-behavior-detector-calibration-label-batch-source",
          role,
          studyId: pilotStudy,
          detector: DETECTOR,
          candidateCommit: CANDIDATE,
          referenceProtocolId: pilotFrame.referenceProtocolId,
          frameTasksSha256: pilotFrameSha,
          cases: pilotFrame.cases.map((entry, caseIndex) => ({
            caseId: entry.caseId,
            value: caseIndex < presentCount ? "present" : caseIndex < 95 ? "absent" : "uncertain",
            evidence: {
              sha256: sha(`${actor}:${entry.caseId}`),
              provenance: `har://${actor}/${entry.caseId}`
            }
          }))
        },
        null,
        2
      )}\n`
    );
    const sealedPath = path.join(pilotRoot, `${actor}-sealed.json`);
    const sealRun = run([
      "scripts/calibration-v4-seal-label-batch.mjs",
      "--role", role,
      "--actor", actor,
      "--public-key", pilotKeyPath,
      "--frame-tasks", path.join(pilotFrameRoot, "frame-tasks.json"),
      "--tasks-dir", path.join(pilotFrameRoot, "tasks"),
      "--input", batchPath,
      "--output", sealedPath
    ]);
    assert.equal(sealRun.status, 0, sealRun.stderr);
    const envelope = JSON.parse(readFileSync(sealedPath, "utf8"));
    mkdirSync(commitDir, { recursive: true });
    writeFileSync(
      path.join(commitDir, `${String(index).padStart(2, "0")}-${actor}.json`),
      `${JSON.stringify(
        {
          metadata: {
            actor,
            artifactCreatedAt: BEFORE,
            runId: 9000 + index,
            runAttempt: 1,
            headSha: "e".repeat(40),
            artifactId: 9100 + index,
            artifactName: `site-behavior-calibration-label-commitment-${role}-${pilotStudy}-1-1`,
            archiveSha256: sha(`smoke-archive:${actor}`)
          },
          commitment: {
            role,
            source: { commit: "f".repeat(40), path: `calibration-labels/${pilotStudy}/sources.json`, actor },
            keyId,
            envelopeSha256: sha256Hex(canonicalPrettyJson(envelope)),
            envelope
          }
        },
        null,
        2
      )}\n`
    );
  }
  const authDir = path.join(pilotRoot, "repo", "calibration", pilotStudy);
  const authPath = path.join(authDir, "pilot-labeling-authorization.json");
  const close = run([
    "scripts/calibration-v4-pilot-close.mjs",
    "--frame-tasks", path.join(pilotFrameRoot, "frame-tasks.json"),
    "--commitments-dir", commitDir,
    "--key-id", keyId,
    "--out", authPath
  ]);
  assert.equal(close.status, 0, close.stderr);
  assert.match(close.stdout, /3 authorized commitments/);
  const outDir = path.join(pilotRoot, "revealed");
  const reveal = run(
    [
      "scripts/calibration-v4-reveal.mjs",
      "--frame-tasks", path.join(pilotFrameRoot, "frame-tasks.json"),
      "--tasks-dir", path.join(pilotFrameRoot, "tasks"),
      "--authorization", authPath,
      "--commitments-dir", commitDir,
      "--out-dir", outDir
    ],
    { CALIBRATION_LABEL_REVEAL_PRIVATE_KEY: privateKeyPem }
  );
  assert.equal(reveal.status, 0, reveal.stderr);
  assert.match(reveal.stdout, /resolved 100 cases/);
  // Disagreements (cases 25..29: alice absent vs bob present) resolved by
  // carol with adjudication artifacts on disk.
  assert.ok(readdirSync(path.join(outDir, "adjudications")).length > 0);
  const sizing = run([
    "scripts/calibration-v4-pilot-sizing.mjs",
    "--resolved-labels", path.join(outDir, "resolved-labels.json"),
    "--frame-tasks", path.join(pilotFrameRoot, "frame-tasks.json"),
    "--minimum-per-class", "100",
    "--swept-eligible-pool", "1126",
    "--out", path.join(pilotRoot, "pilot-sizing.json")
  ]);
  assert.equal(sizing.status, 0, sizing.stderr);
  const sizingArtifact = JSON.parse(readFileSync(path.join(pilotRoot, "pilot-sizing.json"), "utf8"));
  // Exact bin counts pinned to the constructed label distribution: alice 25
  // present, bob 30 (disagreements on 25..29 tiebroken by carol to absent),
  // unanimous uncertain on 95..99. A bin swap or merge changes these.
  assert.deepEqual(sizingArtifact.counts, { present: 25, absent: 70, uncertain: 5, total: 100 });
  assert.equal(typeof sizingArtifact.derivedN, "number");
  assert.equal(sizingArtifact.feasibility.sweptEligiblePool, 1126);
  // A nonsense pool refuses through the one validation home.
  const badPool = run([
    "scripts/calibration-v4-pilot-sizing.mjs",
    "--resolved-labels", path.join(outDir, "resolved-labels.json"),
    "--frame-tasks", path.join(pilotFrameRoot, "frame-tasks.json"),
    "--minimum-per-class", "100",
    "--swept-eligible-pool", "-5",
    "--out", path.join(pilotRoot, "pilot-sizing-bad.json")
  ]);
  assert.notEqual(badPool.status, 0);
  assert.match(badPool.stderr, /swept eligible pool count/);

  const failedSeal = run([
    "scripts/calibration-v4-seal-label-batch.mjs",
    "--role",
    "labeler",
    "--actor",
    "alice",
    "--public-key",
    keyPath,
    "--frame-tasks",
    path.join(outRoot, "frame-tasks.json"),
    "--tasks-dir",
    path.join(outRoot, "tasks"),
    "--input",
    batchPath,
    "--output",
    path.join(root, "sealed-2.json")
  ]);
  assert.notEqual(failedSeal.status, 0);
  assert.match(failedSeal.stderr, /task bytes do not match/);
});
