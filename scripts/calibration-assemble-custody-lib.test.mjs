import assert from "node:assert/strict";
import test from "node:test";
import { acquireAssemblyCustody } from "./calibration-assemble-custody-lib.mjs";
import {
  CALIBRATION_LABEL_ROSTER_WORKFLOW_PATH,
  calibrationLabelRosterArtifactName,
  calibrationLabelRosterRunName,
  calibrationLabelRosterRunSelectionSnapshot
} from "./calibration-label-roster-lib.mjs";
import { canonicalCalibrationAcquisitionText } from "./calibration-acquisition-authorization-lib.mjs";
import { sha256Hex } from "./calibration-study-lib.mjs";

const STUDY_ID = "pixel-events-2026-08";
const CANDIDATE = "a".repeat(40);
const CARRIER = "b".repeat(40);
const CASE_ROOT = "c".repeat(64);
const ROSTER_RUN_ID = 31000001;
const ROSTER_ARTIFACT_ID = 4400001;

function rawRosterRun() {
  return {
    id: ROSTER_RUN_ID,
    run_attempt: 1,
    status: "completed",
    conclusion: "success",
    event: "workflow_dispatch",
    path: CALIBRATION_LABEL_ROSTER_WORKFLOW_PATH,
    head_branch: "main",
    head_sha: CARRIER,
    display_title: calibrationLabelRosterRunName({
      studyId: STUDY_ID,
      candidateCommit: CANDIDATE
    }),
    actor: { login: "iAnonymous3000" },
    triggering_actor: { login: "iAnonymous3000" },
    created_at: "2026-08-19T01:00:00.000Z",
    run_started_at: "2026-08-19T01:00:05.000Z",
    updated_at: "2026-08-19T01:02:00.000Z"
  };
}

function snapshot() {
  return calibrationLabelRosterRunSelectionSnapshot({
    studyId: STUDY_ID,
    candidateCommit: CANDIDATE,
    carrierCommit: CARRIER,
    caseInputRootSha256: CASE_ROOT,
    runs: [rawRosterRun()],
    selectedRunId: ROSTER_RUN_ID
  });
}

function fetchedRosterFixture() {
  const rosterText = '{\n  "fixture": "roster-authorization-bytes"\n}\n';
  const selectionSnapshot = snapshot();
  return {
    text: rosterText,
    sha256: sha256Hex(rosterText),
    selectionSnapshot,
    roster: {
      authenticatedCommitments: [],
      commitmentSetSha256: "d".repeat(64)
    },
    metadata: {
      runId: ROSTER_RUN_ID,
      runAttempt: 1,
      headSha: CARRIER,
      actor: "iAnonymous3000",
      triggeringActor: "iAnonymous3000",
      runName: calibrationLabelRosterRunName({
        studyId: STUDY_ID,
        candidateCommit: CANDIDATE
      }),
      runStatus: "completed",
      runConclusion: "success",
      runStartedAt: "2026-08-19T01:00:05.000Z",
      runUpdatedAt: "2026-08-19T01:02:00.000Z",
      runCompletedAt: "2026-08-19T01:02:00.000Z",
      artifactId: ROSTER_ARTIFACT_ID,
      artifactName: calibrationLabelRosterArtifactName(
        STUDY_ID,
        ROSTER_RUN_ID,
        1
      ),
      archiveSha256: "e".repeat(64),
      archiveBytes: 2048,
      artifactCreatedAt: "2026-08-19T01:01:30.000Z",
      artifactExpiresAt: "2026-11-17T01:02:10.000Z"
    }
  };
}

function authorizationFor(fetched) {
  return {
    studyId: STUDY_ID,
    detector: "pixel-events",
    candidateCommit: CANDIDATE,
    roster: {
      runId: ROSTER_RUN_ID,
      runAttempt: 1,
      headSha: CARRIER,
      artifactId: ROSTER_ARTIFACT_ID,
      archiveSha256: fetched.metadata.archiveSha256,
      authorizationSha256: fetched.sha256,
      artifactCreatedAt: fetched.metadata.artifactCreatedAt
    },
    commitmentSetSha256: fetched.roster.commitmentSetSha256,
    nonce: "f".repeat(64),
    acquisitionWorkflowPath: ".github/workflows/calibration-study.yml",
    authorizedRunAttempt: 1,
    caseInputRootSha256: CASE_ROOT,
    runName: `calibration-acquire:${STUDY_ID}:${ROSTER_RUN_ID}:${ROSTER_ARTIFACT_ID}:${"f".repeat(64)}`
  };
}

function attemptLedgerFixture() {
  const text = '{\n  "fixture": "attempt-ledger"\n}\n';
  return { ledger: { fixture: "attempt-ledger" }, text, sha256: sha256Hex(text) };
}

async function acquire(overrides = {}) {
  const fetched = overrides.fetched ?? fetchedRosterFixture();
  const authorization = overrides.authorization ?? authorizationFor(fetched);
  return acquireAssemblyCustody({
    studyId: STUDY_ID,
    authorization,
    acquisitionSnapshotText:
      overrides.acquisitionSnapshotText ??
      canonicalCalibrationAcquisitionText(fetched.selectionSnapshot),
    carrierCommit: CARRIER,
    fetchRoster: async () => fetched,
    fetchAttemptLedger: async () =>
      overrides.attemptLedger ?? attemptLedgerFixture()
  });
}

test("a fully bound custody acquisition produces the three fixed-path custody files", async () => {
  const { custody, roster } = await acquire();
  const dir = `calibration/${STUDY_ID}`;
  assert.equal(custody.labelRosterAuthorization.path, `${dir}/label-roster-authorization.json`);
  assert.equal(custody.rosterSelectionLedger.path, `${dir}/roster-selection-ledger.json`);
  assert.equal(custody.acquisitionAttemptLedger.path, `${dir}/acquisition-attempt-ledger.json`);
  for (const file of Object.values(custody)) {
    assert.equal(file.sha256, sha256Hex(file.text));
  }
  const ledger = JSON.parse(custody.rosterSelectionLedger.text);
  assert.equal(ledger.rosterAuthorizationSha256, custody.labelRosterAuthorization.sha256);
  assert.equal(ledger.selection.identity.studyId, STUDY_ID);
  assert.equal(roster.authorizationSha256, custody.labelRosterAuthorization.sha256);
  assert.equal(roster.selectionLedgerSha256, custody.rosterSelectionLedger.sha256);
  assert.equal(roster.candidateCommit, CANDIDATE);
  assert.equal(roster.carrierCommit, CARRIER);
});

test("every authorization coordinate is enforced against the re-fetched roster", async () => {
  const cases = [
    [(a) => (a.roster.authorizationSha256 = "0".repeat(64)), /bytes differ from the pre-acquisition digest/],
    [(a) => (a.roster.headSha = "9".repeat(40)), /head differs from the authorized roster head/],
    [(a) => (a.roster.runId = ROSTER_RUN_ID + 1), /run id differs/],
    [(a) => (a.roster.runAttempt = 2), /attempt differs/],
    [(a) => (a.roster.artifactId = ROSTER_ARTIFACT_ID + 1), /artifact id differs/],
    [(a) => (a.roster.archiveSha256 = "0".repeat(64)), /archive digest differs/],
    [(a) => (a.commitmentSetSha256 = "0".repeat(64)), /commitment set differs/]
  ];
  for (const [mutate, expected] of cases) {
    const fetched = fetchedRosterFixture();
    const authorization = authorizationFor(fetched);
    mutate(authorization);
    await assert.rejects(() => acquire({ fetched, authorization }), expected);
  }
});

test("a divergent selection snapshot refuses before any custody output exists", async () => {
  await assert.rejects(
    () => acquire({ acquisitionSnapshotText: '{\n  "different": true\n}\n' }),
    /snapshot differs from the acquisition-embedded snapshot/
  );
});

test("roster metadata missing a ledger field is a loud contract drift, not a silent omission", async () => {
  const fetched = fetchedRosterFixture();
  delete fetched.metadata.runConclusion;
  await assert.rejects(() => acquire({ fetched }), /missing runConclusion/);
});

test("an attempt ledger whose digest disagrees with its bytes refuses", async () => {
  await assert.rejects(
    () => acquire({ attemptLedger: { ledger: {}, text: "{}\n", sha256: "0".repeat(64) } }),
    /digest does not match its canonical bytes/
  );
});

test("the assemble CLI reads the reveal key only after custody succeeds", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("./calibration-study-assemble.mjs", import.meta.url), "utf8");
  assert.ok(!source.includes("not yet implemented"), "the refusal must be gone");
  const custodyAt = source.indexOf("acquireAssemblyCustody({");
  const revealAt = source.indexOf('requiredSecret(\n  "CALIBRATION_LABEL_REVEAL_PRIVATE_KEY"');
  const labelsAt = source.indexOf("assembleAuthenticatedCalibrationLabels({");
  const studyAt = source.indexOf("assembleCalibrationStudy({");
  assert.ok(custodyAt > 0 && revealAt > 0 && labelsAt > 0 && studyAt > 0);
  assert.ok(custodyAt < revealAt, "custody must be held before the reveal key is read");
  assert.ok(revealAt < labelsAt, "the key is read only for label assembly");
  assert.ok(source.indexOf("roster,", custodyAt) < labelsAt + 200, "labels assembly receives the roster descriptor");
  assert.match(source.slice(studyAt, studyAt + 200), /custody,/);
});
