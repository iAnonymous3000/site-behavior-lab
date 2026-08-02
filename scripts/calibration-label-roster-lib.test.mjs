import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  CALIBRATION_LABEL_SEALING_ALGORITHM,
  canonicalPrettyJson,
  createCalibrationLabelCommitment,
  sha256Hex
} from "./calibration-study-lib.mjs";
import {
  CALIBRATION_LABEL_SOURCE_ENVELOPE_KIND
} from "./calibration-label-source-envelope-lib.mjs";
import {
  CALIBRATION_ACQUISITION_WORKFLOW_PATH,
  CALIBRATION_LABEL_ROSTER_AUTHORIZATION_KIND,
  CALIBRATION_LABEL_ROSTER_SELECTION_KIND,
  CALIBRATION_LABEL_ROSTER_WORKFLOW_PATH,
  assertUniqueCalibrationLabelRosterRun,
  authenticatedCalibrationCommitmentSummaries,
  calibrationCaseInputRootSha256,
  calibrationLabelRosterArtifactName,
  calibrationLabelRosterRunName,
  calibrationLabelRosterRunSelectionSnapshot,
  calibrationLabelRosterWorkflowPath,
  compareCalibrationLabelRosterRunSelectionSnapshots,
  createCalibrationLabelRosterAuthorization,
  parseCalibrationLabelRosterRunName,
  validateCalibrationLabelRosterAuthorization,
  validateCalibrationLabelRosterGithubMetadata,
  validateCalibrationLabelRosterRunSelectionSnapshot,
  waitForTerminalCalibrationLabelRosterRun
} from "./calibration-label-roster-lib.mjs";

const STUDY = "calibration-roster-test";
const DETECTOR = "pixel-events";
const CANDIDATE = "c".repeat(40);
const CARRIER = "4".repeat(40);
const KEY_ID = "1".repeat(64);
const CASE_INPUT_ROOT = "/srv/site-behavior/calibration/cases";
const CASE_INPUT_ROOT_SHA256 =
  calibrationCaseInputRootSha256(CASE_INPUT_ROOT);
const ROSTER_NONCE = "9".repeat(64);
const LABEL_KEY = {
  algorithm: CALIBRATION_LABEL_SEALING_ALGORITHM,
  keyId: KEY_ID,
  publicKeyPath: `calibration/${STUDY}/label-sealing-public-key.pem`,
  publicKeySha256: "2".repeat(64)
};
const CANDIDATE_FIXTURE = {
  studyId: STUDY,
  detector: DETECTOR,
  labelSealingKey: LABEL_KEY
};

function commitmentEntry({
  role,
  actor,
  runId,
  artifactId,
  digestCharacter,
  recordedSecond
}) {
  const envelope = {
    schemaVersion: 1,
    artifactKind: CALIBRATION_LABEL_SOURCE_ENVELOPE_KIND,
    studyId: STUDY,
    detector: DETECTOR,
    role,
    candidateCommit: CANDIDATE,
    reviewerLogin: actor,
    algorithm: CALIBRATION_LABEL_SEALING_ALGORITHM,
    keyId: KEY_ID,
    encryptedKey: `encrypted-key-${actor}`,
    iv: `iv-${actor}`,
    ciphertext: `ciphertext-${actor}`,
    authTag: `auth-tag-${actor}`
  };
  const archiveSha256 = digestCharacter.repeat(64);
  const created = createCalibrationLabelCommitment({
    candidate: CANDIDATE_FIXTURE,
    candidateCommit: CANDIDATE,
    role,
    envelope,
    producer: {
      repository: "iAnonymous3000/site-behavior-lab",
      workflowPath: ".github/workflows/calibration-label-batch.yml",
      workflowRef: "refs/heads/main",
      runId,
      runAttempt: 1,
      headSha: CANDIDATE,
      actor,
      triggeringActor: actor
    },
    sourceProvenance: {
      commit: digestCharacter.repeat(40),
      tree: ((Number.parseInt(digestCharacter, 16) + 1) % 16)
        .toString(16)
        .repeat(40),
      path: `calibration-labels/${STUDY}/${actor}.sealed.json`,
      sha256: ((Number.parseInt(digestCharacter, 16) + 2) % 16)
        .toString(16)
        .repeat(64)
    }
  });
  const second = String(recordedSecond).padStart(2, "0");
  return {
    coordinate: {
      role,
      runId,
      runAttempt: 1,
      artifactId,
      archiveSha256
    },
    metadata: {
      role,
      runId,
      runAttempt: 1,
      headSha: CANDIDATE,
      actor,
      triggeringActor: actor,
      runStartedAt: "2026-08-01T01:00:00.000Z",
      runCompletedAt: "2026-08-01T01:01:00.000Z",
      artifactId,
      artifactName:
        `site-behavior-calibration-label-commitment-${role}-${STUDY}-` +
        `${runId}-1`,
      archiveSha256,
      archiveBytes: 4096,
      artifactCreatedAt: `2026-08-01T01:00:${second}.000Z`,
      artifactExpiresAt: "2026-10-30T01:00:00.000Z"
    },
    commitment: created.commitment,
    text: created.text
  };
}

function commitments() {
  return [
    commitmentEntry({
      role: "labeler",
      actor: "alice-reviewer",
      runId: 101,
      artifactId: 1001,
      digestCharacter: "a",
      recordedSecond: 10
    }),
    commitmentEntry({
      role: "labeler",
      actor: "bob-reviewer",
      runId: 102,
      artifactId: 1002,
      digestCharacter: "b",
      recordedSecond: 20
    }),
    commitmentEntry({
      role: "tiebreaker",
      actor: "tie-reviewer",
      runId: 103,
      artifactId: 1003,
      digestCharacter: "d",
      recordedSecond: 30
    })
  ];
}

function rosterInput(overrides = {}) {
  return {
    candidate: CANDIDATE_FIXTURE,
    candidateCommit: CANDIDATE,
    carrierCommit: CARRIER,
    source: {
      commit: CARRIER,
      tree: "f".repeat(40),
      path: `calibration-labels/${STUDY}/sources.json`,
      sha256: "3".repeat(64)
    },
    producer: {
      repository: "iAnonymous3000/site-behavior-lab",
      workflowPath: CALIBRATION_LABEL_ROSTER_WORKFLOW_PATH,
      workflowRef: "refs/heads/main",
      runId: 201,
      runAttempt: 1,
      headSha: CARRIER,
      actor: "ceremony-operator",
      triggeringActor: "ceremony-operator"
    },
    authorization: {
      nonce: ROSTER_NONCE,
      acquisitionWorkflowPath: CALIBRATION_ACQUISITION_WORKFLOW_PATH,
      authorizedRunAttempt: 1,
      caseInputRootSha256: CASE_INPUT_ROOT_SHA256
    },
    commitments: commitments(),
    ...overrides
  };
}

function rawRosterRun(overrides = {}) {
  const displayTitle = calibrationLabelRosterRunName({
    studyId: STUDY,
    candidateCommit: CANDIDATE,
    caseInputRootSha256: CASE_INPUT_ROOT_SHA256
  });
  return {
    id: 201,
    run_attempt: 1,
    status: "completed",
    conclusion: "success",
    event: "workflow_dispatch",
    path: `${CALIBRATION_LABEL_ROSTER_WORKFLOW_PATH}@main`,
    head_branch: "main",
    head_sha: CARRIER,
    actor: { login: "ceremony-operator" },
    triggering_actor: { login: "ceremony-operator" },
    created_at: "2026-08-01T02:00:00.000Z",
    run_started_at: "2026-08-01T02:00:01.000Z",
    updated_at: "2026-08-01T02:01:00.000Z",
    display_title: displayTitle,
    repository: { full_name: "iAnonymous3000/site-behavior-lab" },
    ...overrides
  };
}

test("case-input authorization is domain-separated but aliases share one run identity", () => {
  assert.match(CASE_INPUT_ROOT_SHA256, /^[0-9a-f]{64}$/);
  assert.notEqual(CASE_INPUT_ROOT_SHA256, sha256Hex(CASE_INPUT_ROOT));
  assert.notEqual(
    CASE_INPUT_ROOT_SHA256,
    calibrationCaseInputRootSha256(`${CASE_INPUT_ROOT}/.`)
  );
  const runName = calibrationLabelRosterRunName({
    studyId: STUDY,
    candidateCommit: CANDIDATE,
    caseInputRootSha256: CASE_INPUT_ROOT_SHA256
  });
  assert.equal(
    runName,
    `calibration-label-roster:${STUDY}:${CANDIDATE}`
  );
  assert.equal(
    calibrationLabelRosterRunName({
      studyId: STUDY,
      candidateCommit: CANDIDATE,
      caseInputRootSha256:
        calibrationCaseInputRootSha256(`${CASE_INPUT_ROOT}/.`)
    }),
    runName
  );
  assert.deepEqual(parseCalibrationLabelRosterRunName(runName), {
    studyId: STUDY,
    candidateCommit: CANDIDATE,
    runName
  });
  assert.equal(parseCalibrationLabelRosterRunName(`${runName}:extra`), null);
  assert.equal(
    calibrationLabelRosterWorkflowPath(
      `${CALIBRATION_LABEL_ROSTER_WORKFLOW_PATH}@main`
    ),
    CALIBRATION_LABEL_ROSTER_WORKFLOW_PATH
  );
  assert.throws(
    () =>
      calibrationLabelRosterWorkflowPath(
        `${CALIBRATION_LABEL_ROSTER_WORKFLOW_PATH}@feature`
      ),
    /governed workflow on main/
  );
  assert.equal(
    calibrationLabelRosterArtifactName(STUDY, 201, 1),
    `site-behavior-calibration-label-roster-${STUDY}-201-1`
  );
});

test("roster freezes exact authenticated commitments without plaintext or ciphertext", () => {
  const created = createCalibrationLabelRosterAuthorization(rosterInput());
  assert.equal(
    created.roster.artifactKind,
    CALIBRATION_LABEL_ROSTER_AUTHORIZATION_KIND
  );
  assert.equal(created.roster.candidateCommit, CANDIDATE);
  assert.equal(created.roster.carrierCommit, CARRIER);
  assert.equal(created.roster.producer.headSha, CARRIER);
  assert.equal(created.roster.authenticatedCommitments.length, 3);
  assert.deepEqual(
    Object.keys(created.roster.authenticatedCommitments[0]),
    [
      "role",
      "actor",
      "runId",
      "runAttempt",
      "headSha",
      "artifactId",
      "artifactName",
      "archiveSha256",
      "createdAt",
      "source",
      "algorithm",
      "keyId",
      "envelopeSha256",
      "ciphertextSha256"
    ]
  );
  assert.equal(created.text, canonicalPrettyJson(created.roster));
  assert.equal(created.sha256, sha256Hex(created.text));
  assert.ok(!created.text.includes(CASE_INPUT_ROOT));
  assert.ok(!created.text.includes('"encryptedKey"'));
  assert.ok(!created.text.includes('"ciphertext"'));
  assert.ok(!created.text.includes("ciphertext-alice-reviewer"));
  assert.deepEqual(
    validateCalibrationLabelRosterAuthorization(created.roster, {
      studyId: STUDY,
      detector: DETECTOR,
      candidateCommit: CANDIDATE,
      carrierCommit: CARRIER,
      labelSealingKey: LABEL_KEY,
      producer: rosterInput().producer,
      authorization: rosterInput().authorization,
      source: rosterInput().source
    }),
    created.roster
  );
});

test("roster summary rejects post-hoc replay, actor reuse, and carrier-head drift", () => {
  const duplicatedActor = commitments();
  duplicatedActor[1].metadata.actor = duplicatedActor[0].metadata.actor;
  duplicatedActor[1].metadata.triggeringActor =
    duplicatedActor[0].metadata.actor;
  duplicatedActor[1].commitment.producer.actor =
    duplicatedActor[0].metadata.actor;
  duplicatedActor[1].commitment.producer.triggeringActor =
    duplicatedActor[0].metadata.actor;
  duplicatedActor[1].commitment.envelope.reviewerLogin =
    duplicatedActor[0].metadata.actor;
  duplicatedActor[1].commitment.envelopeSha256 = sha256Hex(
    canonicalPrettyJson(duplicatedActor[1].commitment.envelope)
  );
  duplicatedActor[1].text = canonicalPrettyJson(
    duplicatedActor[1].commitment
  );
  assert.throws(
    () =>
      authenticatedCalibrationCommitmentSummaries({
        candidate: CANDIDATE_FIXTURE,
        candidateCommit: CANDIDATE,
        commitments: duplicatedActor
      }),
    /distinct actors/
  );

  const replayed = commitments();
  replayed[1].commitment.source = structuredClone(
    replayed[0].commitment.source
  );
  replayed[1].text = canonicalPrettyJson(replayed[1].commitment);
  assert.throws(
    () =>
      authenticatedCalibrationCommitmentSummaries({
        candidate: CANDIDATE_FIXTURE,
        candidateCommit: CANDIDATE,
        commitments: replayed
      }),
    /distinct actors, sources, envelopes, and ciphertexts/
  );

  const wrongHead = rosterInput();
  wrongHead.producer = {
    ...wrongHead.producer,
    headSha: "a".repeat(40)
  };
  assert.throws(
    () => createCalibrationLabelRosterAuthorization(wrongHead),
    /producer head and fixed coordinate source must equal/
  );
});

test("server roster metadata binds candidate and carrier, run name, artifact, and chronology", () => {
  const run = rawRosterRun();
  const artifacts = {
    total_count: 1,
    artifacts: [
      {
        id: 9001,
        name: calibrationLabelRosterArtifactName(STUDY, 201, 1),
        size_in_bytes: 8192,
        expired: false,
        digest: `sha256:${"8".repeat(64)}`,
        created_at: "2026-08-01T02:00:30.000Z",
        expires_at: "2026-10-30T02:00:30.000Z",
        workflow_run: { id: 201, head_sha: CARRIER }
      }
    ]
  };
  const metadata = validateCalibrationLabelRosterGithubMetadata({
    studyId: STUDY,
    candidateCommit: CANDIDATE,
    carrierCommit: CARRIER,
    caseInputRootSha256: CASE_INPUT_ROOT_SHA256,
    runId: 201,
    runAttempt: 1,
    artifactId: 9001,
    archiveSha256: "8".repeat(64),
    run,
    artifacts
  });
  assert.equal(metadata.artifactCreatedAt, "2026-08-01T02:00:30.000Z");
  assert.equal(metadata.runCompletedAt, "2026-08-01T02:01:00.000Z");
  assert.throws(
    () =>
      validateCalibrationLabelRosterGithubMetadata({
        studyId: STUDY,
        candidateCommit: CANDIDATE,
        carrierCommit: CARRIER,
        caseInputRootSha256: CASE_INPUT_ROOT_SHA256,
        runId: 201,
        runAttempt: 1,
        artifactId: 9001,
        archiveSha256: "8".repeat(64),
        run: { ...run, head_sha: "a".repeat(40) },
        artifacts
      }),
    /roster run is not/
  );
});

test("terminal selection is canonical and any competing or rerun identity invalidates it", () => {
  const selection = assertUniqueCalibrationLabelRosterRun({
    runs: [rawRosterRun()],
    studyId: STUDY,
    candidateCommit: CANDIDATE,
    carrierCommit: CARRIER,
    caseInputRootSha256: CASE_INPUT_ROOT_SHA256,
    selectedRunId: 201
  });
  assert.equal(
    selection.artifactKind,
    CALIBRATION_LABEL_ROSTER_SELECTION_KIND
  );
  assert.deepEqual(
    validateCalibrationLabelRosterRunSelectionSnapshot(selection, {
      studyId: STUDY,
      candidateCommit: CANDIDATE,
      carrierCommit: CARRIER,
      caseInputRootSha256: CASE_INPUT_ROOT_SHA256,
      selectedRunId: 201
    }),
    selection
  );

  assert.throws(
    () =>
      calibrationLabelRosterRunSelectionSnapshot({
        runs: [
          rawRosterRun(),
          rawRosterRun({
            id: 202,
            created_at: "2026-08-01T02:02:00.000Z",
            run_started_at: "2026-08-01T02:02:01.000Z",
            updated_at: "2026-08-01T02:03:00.000Z"
          })
        ],
        studyId: STUDY,
        candidateCommit: CANDIDATE,
        carrierCommit: CARRIER,
        caseInputRootSha256: CASE_INPUT_ROOT_SHA256,
        selectedRunId: 201
      }),
    /exactly one server-visible roster run/
  );
  assert.throws(
    () =>
      calibrationLabelRosterRunSelectionSnapshot({
        runs: [rawRosterRun({ run_attempt: 2 })],
        studyId: STUDY,
        candidateCommit: CANDIDATE,
        carrierCommit: CARRIER,
        caseInputRootSha256: CASE_INPUT_ROOT_SHA256,
        selectedRunId: 201
      }),
    /attempt 1/
  );

  const changedTerminal = assertUniqueCalibrationLabelRosterRun({
    runs: [rawRosterRun({ updated_at: "2026-08-01T02:01:01.000Z" })],
    studyId: STUDY,
    candidateCommit: CANDIDATE,
    carrierCommit: CARRIER,
    caseInputRootSha256: CASE_INPUT_ROOT_SHA256,
    selectedRunId: 201
  });
  assert.throws(
    () =>
      compareCalibrationLabelRosterRunSelectionSnapshots({
        archivedSnapshot: selection,
        liveSnapshot: changedTerminal
      }),
    /enumeration changed/
  );
});

test("terminal poll accepts only the same attempt-1 candidate-bound successful parent", async () => {
  const observations = [
    rawRosterRun({
      status: "in_progress",
      conclusion: null,
      updated_at: "2026-08-01T02:00:40.000Z"
    }),
    rawRosterRun()
  ];
  let index = 0;
  const terminal = await waitForTerminalCalibrationLabelRosterRun({
    runId: 201,
    studyId: STUDY,
    candidateCommit: CANDIDATE,
    carrierCommit: CARRIER,
    caseInputRootSha256: CASE_INPUT_ROOT_SHA256,
    timeoutMs: 1_000,
    pollIntervalMs: 250,
    fetchRun: async () => observations[index++],
    wait: async () => {}
  });
  assert.equal(terminal.conclusion, "success");
  await assert.rejects(
    waitForTerminalCalibrationLabelRosterRun({
      runId: 201,
      studyId: STUDY,
      candidateCommit: CANDIDATE,
      carrierCommit: CARRIER,
      caseInputRootSha256: CASE_INPUT_ROOT_SHA256,
      timeoutMs: 1_000,
      pollIntervalMs: 250,
      fetchRun: async () =>
        rawRosterRun({ status: "completed", conclusion: "failure" }),
      wait: async () => {}
    }),
    /completed as failure/
  );
});

test("workflow pins deterministic identity, least privilege, and a one-shot dependent dispatch", () => {
  const workflow = readFileSync(
    path.join(
      process.cwd(),
      ".github",
      "workflows",
      "calibration-label-roster.yml"
    ),
    "utf8"
  );
  assert.match(
    workflow,
    /run-name: "calibration-label-roster:\$\{\{ inputs\.study_id \}\}:\$\{\{ inputs\.candidate_commit \}\}"/
  );
  assert.doesNotMatch(
    workflow,
    /group: calibration-label-roster-[^\n]*case_input_root_sha256/
  );
  assert.match(workflow, /permissions: \{\}/);
  assert.match(
    workflow,
    /produce:[\s\S]*?permissions:\n\s+actions: read\n\s+attestations: read\n\s+contents: read/
  );
  assert.match(
    workflow,
    /dispatch_acquisition:[\s\S]*?needs: produce[\s\S]*?permissions:\n\s+actions: write/
  );
  assert.match(
    workflow,
    /test "\$SOURCES_REF" = "\$GITHUB_SHA"/
  );
  assert.match(
    workflow,
    /git merge-base --is-ancestor "\$CALIBRATION_CANDIDATE_COMMIT" "\$GITHUB_SHA"/
  );
  assert.match(workflow, /test "\$GITHUB_RUN_ATTEMPT" = "1"/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /fetch-depth: 0/);
  assert.match(workflow, /npm ci --ignore-scripts/);
  assert.match(workflow, /git merge-base --is-ancestor/);
  assert.match(
    workflow,
    /site-behavior-calibration-label-roster-\$\{\{ inputs\.study_id \}\}-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/
  );
  assert.match(workflow, /gh workflow run calibration-study\.yml/);
  assert.match(workflow, /-f roster_authorized_run_attempt=1/);
  assert.doesNotMatch(workflow, /pull_request:|push:|schedule:/);
  assert.doesNotMatch(workflow, /PRIVATE_KEY|private[-_ ]key/i);
});
