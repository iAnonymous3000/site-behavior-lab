import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
  deepValidateV4StudyIdentity,
  parseV4FrameTasksBytes,
  revealAuthenticatedV4LabelBatches,
  sealV4LabelBatch,
  verifyV4TaskBytes
} from "./calibration-v4-ceremony-lib.mjs";
import { assembleV4ReferenceCases } from "./calibration-v4-labels-lib.mjs";

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

function builtFrame(cases = [
  { caseId: "case-0001", url: "https://alpha-news.example/" },
  { caseId: "case-0002", url: "https://beta-news.example/" }
]) {
  return buildV4FrameTasksArtifact({
    studyId: STUDY,
    detector: DETECTOR,
    candidateCommit: CANDIDATE,
    referenceProtocolId: PROTOCOL,
    cases
  });
}

function batchFor(built, role, values, who) {
  return {
    schemaVersion: 2,
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
  };
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

test("both CLIs work by EXECUTION: build, check, seal, and refuse tampered tasks", () => {
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
  const run = (args) =>
    spawnSync(process.execPath, args, { cwd: path.join(moduleDir, ".."), encoding: "utf8" });
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
    PROTOCOL,
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
    canonicalPrettyJson({
      schemaVersion: 2,
      artifactKind: "site-behavior-detector-calibration-label-batch-source",
      role: "labeler",
      studyId: STUDY,
      detector: DETECTOR,
      candidateCommit: CANDIDATE,
      referenceProtocolId: PROTOCOL,
      frameTasksSha256,
      cases: frameTasks.cases.map((entry) => ({
        caseId: entry.caseId,
        value: "uncertain",
        evidence: { sha256: sha(`cli:${entry.caseId}`), provenance: `har://cli/${entry.caseId}` }
      }))
    })
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
