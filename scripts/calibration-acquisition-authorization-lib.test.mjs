import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildCalibrationAcquisitionAttemptLedger,
  buildCalibrationAcquisitionAuthorizationIdentity,
  buildCalibrationAcquisitionAuthorizationFromRoster,
  buildCalibrationLabelRosterSelectionLedger,
  calibrationAcquisitionAttemptLedgerSha256,
  calibrationAcquisitionAuthorizationSha256,
  calibrationAcquisitionRunAttemptEndpoint,
  calibrationAcquisitionRunName,
  calibrationAcquisitionWorkflowRunsEndpoint,
  calibrationLabelRosterSelectionLedgerSha256,
  canonicalCalibrationAcquisitionText,
  compareCalibrationAcquisitionAttemptLedgers,
  compareCalibrationLabelRosterSelectionLedgers,
  enumerateCalibrationAcquisitionAttempts,
  fetchCalibrationAcquisitionAttemptLedger,
  requireEligibleCalibrationAcquisitionAttemptLedger,
  validateCalibrationAcquisitionAttemptLedger,
  validateCalibrationAcquisitionAuthorizationIdentity,
  validateCalibrationLabelRosterSelectionLedger,
  validateCalibrationLabelRosterSelectionSnapshot,
  verifyArchivedCalibrationAcquisitionAttemptLedgerAgainstGithub,
  verifyCalibrationCeremonyFilesLive,
  CALIBRATION_ACQUISITION_ATTEMPT_LEDGER_KIND,
  CALIBRATION_ACQUISITION_REPOSITORY,
  CALIBRATION_ACQUISITION_WORKFLOW_PATH,
  CALIBRATION_LABEL_ROSTER_SELECTION_KIND,
  CALIBRATION_LABEL_ROSTER_WORKFLOW_PATH
} from "./calibration-acquisition-authorization-lib.mjs";

const STUDY_ID = "pixel-events-2026-08";
const CANDIDATE = "1".repeat(40);
const ROSTER_HEAD = "2".repeat(40);
const NONCE = "3".repeat(64);
const CASE_ROOT = "4".repeat(64);
const COMMITMENT_SET = "5".repeat(64);
const ROSTER_ARCHIVE = "6".repeat(64);
const ROSTER_AUTHORIZATION = "7".repeat(64);
const ROSTER_CREATED_AT = "2026-08-01T12:00:00.000Z";

function authorization(overrides = {}) {
  const source = {
    studyId: STUDY_ID,
    detector: "pixel-events",
    candidateCommit: CANDIDATE,
    roster: {
      runId: 31001,
      runAttempt: 1,
      headSha: ROSTER_HEAD,
      artifactId: 41001,
      archiveSha256: ROSTER_ARCHIVE,
      authorizationSha256: ROSTER_AUTHORIZATION,
      artifactCreatedAt: ROSTER_CREATED_AT
    },
    commitmentSetSha256: COMMITMENT_SET,
    nonce: NONCE,
    acquisitionWorkflowPath: CALIBRATION_ACQUISITION_WORKFLOW_PATH,
    authorizedRunAttempt: 1,
    caseInputRootSha256: CASE_ROOT
  };
  const merged = {
    ...source,
    ...overrides,
    roster: { ...source.roster, ...(overrides.roster ?? {}) }
  };
  return buildCalibrationAcquisitionAuthorizationIdentity(merged);
}

function rawRun(auth, overrides = {}) {
  const runAttempt = overrides.run_attempt ?? 1;
  const status = overrides.status ?? "completed";
  const conclusion =
    Object.hasOwn(overrides, "conclusion")
      ? overrides.conclusion
      : status === "completed"
        ? "success"
        : null;
  return {
    id: overrides.id ?? 51001,
    run_attempt: runAttempt,
    workflow_id: overrides.workflow_id ?? 61001,
    run_number: overrides.run_number ?? 71,
    repository: {
      full_name:
        overrides.repository ?? CALIBRATION_ACQUISITION_REPOSITORY
    },
    path: overrides.path ?? CALIBRATION_ACQUISITION_WORKFLOW_PATH,
    display_title: overrides.display_title ?? auth.runName,
    event: overrides.event ?? "workflow_dispatch",
    head_branch: overrides.head_branch ?? "main",
    head_sha: overrides.head_sha ?? auth.roster.headSha,
    actor: { login: overrides.actor ?? "github-actions[bot]" },
    triggering_actor: {
      login: overrides.triggering_actor ?? "maintainer"
    },
    status,
    conclusion,
    created_at: overrides.created_at ?? "2026-08-01T12:01:00Z",
    run_started_at:
      Object.hasOwn(overrides, "run_started_at")
        ? overrides.run_started_at
        : "2026-08-01T12:01:02Z",
    updated_at:
      overrides.updated_at ??
      (status === "completed"
        ? "2026-08-01T12:20:00Z"
        : "2026-08-01T12:02:00Z")
  };
}

function normalizedAttempt(auth, overrides = {}) {
  const raw = rawRun(auth, overrides);
  return {
    runId: raw.id,
    runAttempt: raw.run_attempt,
    workflowId: raw.workflow_id,
    runNumber: raw.run_number,
    repository: raw.repository.full_name,
    workflowPath: raw.path,
    displayTitle: raw.display_title,
    event: raw.event,
    headBranch: raw.head_branch,
    headSha: raw.head_sha,
    actor: raw.actor.login,
    triggeringActor: raw.triggering_actor.login,
    status: raw.status,
    conclusion: raw.conclusion,
    createdAt: new Date(raw.created_at).toISOString(),
    runStartedAt:
      raw.run_started_at === null
        ? null
        : new Date(raw.run_started_at).toISOString(),
    updatedAt: new Date(raw.updated_at).toISOString()
  };
}

function singleSuccessLedger(auth = authorization(), overrides = {}) {
  return buildCalibrationAcquisitionAttemptLedger({
    authorization: auth,
    attempts: [normalizedAttempt(auth, overrides)]
  });
}

function rosterRunSummary(overrides = {}) {
  const identity = rosterSelectionIdentity();
  return {
    runId: overrides.runId ?? 31001,
    runAttempt: overrides.runAttempt ?? 1,
    status: overrides.status ?? "completed",
    conclusion:
      Object.hasOwn(overrides, "conclusion")
        ? overrides.conclusion
        : "success",
    event: overrides.event ?? "workflow_dispatch",
    workflowPath:
      overrides.workflowPath ?? CALIBRATION_LABEL_ROSTER_WORKFLOW_PATH,
    headBranch: overrides.headBranch ?? "main",
    headSha: overrides.headSha ?? ROSTER_HEAD,
    actor: overrides.actor ?? "maintainer",
    triggeringActor: overrides.triggeringActor ?? "maintainer",
    createdAt: overrides.createdAt ?? "2026-08-01T11:58:00.000Z",
    runStartedAt:
      overrides.runStartedAt ?? "2026-08-01T11:58:02.000Z",
    updatedAt: overrides.updatedAt ?? "2026-08-01T12:00:10.000Z",
    displayTitle: overrides.displayTitle ?? identity.runName
  };
}

function rosterSelectionIdentity() {
  return {
    studyId: STUDY_ID,
    candidateCommit: CANDIDATE,
    carrierCommit: ROSTER_HEAD,
    caseInputRootSha256: CASE_ROOT,
    runName:
      `calibration-label-roster:${STUDY_ID}:` +
      CANDIDATE
  };
}

function rosterSelectionSnapshot(overrides = {}) {
  const identity = rosterSelectionIdentity();
  const selectedRun = overrides.selectedRun ?? rosterRunSummary();
  const runs = overrides.runs ?? [selectedRun];
  const core = {
    schemaVersion: 1,
    artifactKind: CALIBRATION_LABEL_ROSTER_SELECTION_KIND,
    identity,
    selectedRun,
    runs
  };
  return {
    ...core,
    snapshotSha256:
      overrides.snapshotSha256 ??
      sha256(
        "site-behavior-calibration-label-roster-selection-v1\u0000" +
          canonicalCompact(core)
      )
  };
}

function rosterSelectedArtifact(overrides = {}) {
  const run = rosterRunSummary();
  return {
    runId: overrides.runId ?? run.runId,
    runAttempt: overrides.runAttempt ?? run.runAttempt,
    headSha: overrides.headSha ?? run.headSha,
    actor: overrides.actor ?? run.actor,
    triggeringActor:
      overrides.triggeringActor ?? run.triggeringActor,
    runName: overrides.runName ?? run.displayTitle,
    runStatus: overrides.runStatus ?? run.status,
    runConclusion: overrides.runConclusion ?? run.conclusion,
    runStartedAt: overrides.runStartedAt ?? run.runStartedAt,
    runUpdatedAt: overrides.runUpdatedAt ?? run.updatedAt,
    runCompletedAt: overrides.runCompletedAt ?? run.updatedAt,
    artifactId: overrides.artifactId ?? 41001,
    artifactName:
      overrides.artifactName ??
      `site-behavior-calibration-label-roster-${STUDY_ID}-31001-1`,
    archiveSha256: overrides.archiveSha256 ?? ROSTER_ARCHIVE,
    archiveBytes: overrides.archiveBytes ?? 2048,
    artifactCreatedAt:
      overrides.artifactCreatedAt ?? ROSTER_CREATED_AT,
    artifactExpiresAt:
      overrides.artifactExpiresAt ?? "2026-10-30T12:00:00.000Z"
  };
}

function rosterAuthorizationDocument() {
  return {
    studyId: STUDY_ID,
    detector: "pixel-events",
    candidateCommit: CANDIDATE,
    carrierCommit: ROSTER_HEAD,
    producer: {
      repository: CALIBRATION_ACQUISITION_REPOSITORY,
      workflowPath: CALIBRATION_LABEL_ROSTER_WORKFLOW_PATH,
      workflowRef: "refs/heads/main",
      runId: 31001,
      runAttempt: 1,
      headSha: ROSTER_HEAD,
      actor: "maintainer",
      triggeringActor: "maintainer"
    },
    authorization: {
      nonce: NONCE,
      acquisitionWorkflowPath: CALIBRATION_ACQUISITION_WORKFLOW_PATH,
      authorizedRunAttempt: 1,
      caseInputRootSha256: CASE_ROOT
    },
    commitmentSetSha256: COMMITMENT_SET
  };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalCompact(value) {
  if (value === null) return "null";
  if (typeof value === "string") {
    return JSON.stringify(value.normalize("NFC"));
  }
  if (typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalCompact(entry)).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key.normalize("NFC"))}:${canonicalCompact(value[key])}`
    )
    .join(",")}}`;
}

test("run-name and authorization bind the exact roster identity", () => {
  const auth = authorization();
  assert.equal(
    auth.runName,
    `calibration-acquire:${STUDY_ID}:31001:41001:${NONCE}`
  );
  assert.equal(
    calibrationAcquisitionRunName({
      studyId: STUDY_ID,
      rosterRunId: 31001,
      rosterArtifactId: 41001,
      nonce: NONCE
    }),
    auth.runName
  );
  assert.deepEqual(
    validateCalibrationAcquisitionAuthorizationIdentity(auth),
    auth
  );
  assert.match(
    calibrationAcquisitionAuthorizationSha256(auth),
    /^[0-9a-f]{64}$/
  );

  const changed = structuredClone(auth);
  changed.roster.artifactId += 1;
  assert.throws(
    () => validateCalibrationAcquisitionAuthorizationIdentity(changed),
    /run-name is not identity-bound/
  );
  assert.throws(
    () =>
      authorization({
        authorizedRunAttempt: 2
      }),
    /may authorize only run attempt 1/
  );
  assert.throws(
    () => authorization({ roster: { runAttempt: 2 } }),
    /requires roster run attempt 1/
  );
});

test("GitHub endpoints enumerate the complete workflow history and exact attempts", () => {
  const auth = authorization();
  const page = calibrationAcquisitionWorkflowRunsEndpoint({
    authorization: auth,
    page: 2
  });
  assert.match(
    page,
    /^\/repos\/iAnonymous3000\/site-behavior-lab\/actions\/workflows\/calibration-study\.yml\/runs\?/
  );
  assert.match(page, /event=workflow_dispatch/);
  assert.match(page, /branch=main/);
  assert.doesNotMatch(page, /created=/);
  assert.match(page, /per_page=100&page=2$/);
  assert.equal(
    calibrationAcquisitionRunAttemptEndpoint({
      runId: 51001,
      runAttempt: 1
    }),
    "/repos/iAnonymous3000/site-behavior-lab/actions/runs/51001/attempts/1"
  );
});

test("enumeration retains every matching run and every failed, cancelled, or active attempt", async () => {
  const auth = authorization();
  const unrelated = rawRun(auth, {
    id: 50000,
    display_title: "some-other-calibration-run"
  });
  const completedFirst = rawRun(auth, {
    id: 51001,
    run_attempt: 1,
    status: "completed",
    conclusion: "failure",
    updated_at: "2026-08-01T12:10:00Z"
  });
  const cancelledSecond = rawRun(auth, {
    id: 51001,
    run_attempt: 2,
    status: "completed",
    conclusion: "cancelled",
    run_started_at: "2026-08-01T12:11:00Z",
    updated_at: "2026-08-01T12:12:00Z"
  });
  const activeClone = rawRun(auth, {
    id: 51002,
    run_number: 72,
    status: "in_progress",
    conclusion: null,
    created_at: "2026-08-01T12:13:00Z",
    run_started_at: "2026-08-01T12:13:02Z",
    updated_at: "2026-08-01T12:14:00Z"
  });
  const calls = [];
  const attempts = await enumerateCalibrationAcquisitionAttempts({
    authorization: auth,
    fetchWorkflowRunsPage: async (request) => {
      calls.push(request);
      if (request.page === 1) {
        return {
          total_count: 3,
          workflow_runs: [unrelated, cancelledSecond]
        };
      }
      return { total_count: 3, workflow_runs: [activeClone] };
    },
    fetchRunAttempt: async (request) => {
      calls.push(request);
      if (request.runId === 51001 && request.runAttempt === 1) {
        return completedFirst;
      }
      if (request.runId === 51001 && request.runAttempt === 2) {
        return cancelledSecond;
      }
      return activeClone;
    }
  });
  assert.deepEqual(
    attempts.map(({ runId, runAttempt, status, conclusion }) => ({
      runId,
      runAttempt,
      status,
      conclusion
    })),
    [
      {
        runId: 51001,
        runAttempt: 1,
        status: "completed",
        conclusion: "failure"
      },
      {
        runId: 51001,
        runAttempt: 2,
        status: "completed",
        conclusion: "cancelled"
      },
      {
        runId: 51002,
        runAttempt: 1,
        status: "in_progress",
        conclusion: null
      }
    ]
  );
  assert.equal(
    calls.filter((entry) => "page" in entry).length,
    3,
    "all declared workflow pages plus a consistency barrier must be fetched"
  );
  assert.equal(
    calls.filter((entry) => "runAttempt" in entry).length,
    3,
    "every matching attempt must be fetched"
  );
  assert.throws(
    () =>
      requireEligibleCalibrationAcquisitionAttemptLedger(
        buildCalibrationAcquisitionAttemptLedger({
          authorization: auth,
          attempts
        })
      ),
    /exactly one successful matching run at attempt 1/
  );
});

test("a final ledger is deterministic and eligible only for one successful attempt 1", () => {
  const auth = authorization();
  const ledger = singleSuccessLedger(auth);
  const result =
    requireEligibleCalibrationAcquisitionAttemptLedger(ledger, auth);
  assert.equal(result.selectedAttempt.runId, 51001);
  assert.equal(result.selectedAttempt.runAttempt, 1);
  assert.equal(ledger.artifactKind, CALIBRATION_ACQUISITION_ATTEMPT_LEDGER_KIND);
  assert.equal(
    result.ledgerSha256,
    calibrationAcquisitionAttemptLedgerSha256(ledger)
  );
  assert.equal(
    canonicalCalibrationAcquisitionText(ledger),
    canonicalCalibrationAcquisitionText(
      validateCalibrationAcquisitionAttemptLedger(ledger)
    )
  );

  for (const invalid of [
    [
      normalizedAttempt(auth, {
        status: "completed",
        conclusion: "failure"
      })
    ],
    [
      normalizedAttempt(auth, {
        status: "completed",
        conclusion: "cancelled"
      })
    ],
    [
      normalizedAttempt(auth, {
        status: "in_progress",
        conclusion: null
      })
    ],
    [
      normalizedAttempt(auth),
      normalizedAttempt(auth, {
        id: 51002,
        run_number: 72,
        created_at: "2026-08-01T12:21:00Z",
        run_started_at: "2026-08-01T12:21:02Z",
        updated_at: "2026-08-01T12:40:00Z"
      })
    ]
  ]) {
    const rejected = buildCalibrationAcquisitionAttemptLedger({
      authorization: auth,
      attempts: invalid
    });
    assert.throws(
      () => requireEligibleCalibrationAcquisitionAttemptLedger(rejected),
      /exactly one successful matching run at attempt 1/
    );
  }
});

test("a rerun is retained canonically and makes the authorization permanently ineligible", () => {
  const auth = authorization();
  const second = normalizedAttempt(auth, {
    run_attempt: 2,
    triggering_actor: "second-maintainer",
    run_started_at: "2026-08-01T12:21:00Z",
    updated_at: "2026-08-01T12:30:00Z"
  });
  const first = normalizedAttempt(auth);
  first.updatedAt = "2026-08-01T12:20:00.000Z";
  const ledger = buildCalibrationAcquisitionAttemptLedger({
    authorization: auth,
    attempts: [second, first]
  });
  assert.deepEqual(
    ledger.attempts.map((entry) => entry.runAttempt),
    [1, 2]
  );
  assert.throws(
    () => requireEligibleCalibrationAcquisitionAttemptLedger(ledger),
    /no clone, rerun/
  );
});

test("enumeration fails closed on incomplete, shifting, or duplicate pagination", async () => {
  const auth = authorization();
  const run = rawRun(auth);
  await assert.rejects(
    enumerateCalibrationAcquisitionAttempts({
      authorization: auth,
      fetchWorkflowRunsPage: async ({ page }) =>
        page === 1
          ? { total_count: 2, workflow_runs: [run] }
          : { total_count: 3, workflow_runs: [] },
      fetchRunAttempt: async () => run
    }),
    /changed total_count/
  );
  await assert.rejects(
    enumerateCalibrationAcquisitionAttempts({
      authorization: auth,
      fetchWorkflowRunsPage: async ({ page }) =>
        page === 1
          ? { total_count: 2, workflow_runs: [run] }
          : { total_count: 2, workflow_runs: [run] },
      fetchRunAttempt: async () => run
    }),
    /malformed or duplicate run/
  );
  await assert.rejects(
    enumerateCalibrationAcquisitionAttempts({
      authorization: auth,
      fetchWorkflowRunsPage: async () => ({
        total_count: 1000,
        workflow_runs: []
      }),
      fetchRunAttempt: async () => run
    }),
    /not one bounded GitHub response/
  );
});

test("enumeration consistency barrier catches a run inserted during attempt reads", async () => {
  const auth = authorization();
  const first = rawRun(auth);
  const clone = rawRun(auth, {
    id: 51002,
    run_number: 72,
    created_at: "2026-08-01T12:21:00Z",
    run_started_at: "2026-08-01T12:21:02Z",
    updated_at: "2026-08-01T12:40:00Z"
  });
  let workflowReads = 0;
  await assert.rejects(
    enumerateCalibrationAcquisitionAttempts({
      authorization: auth,
      fetchWorkflowRunsPage: async () => {
        workflowReads += 1;
        return workflowReads === 1
          ? { total_count: 1, workflow_runs: [first] }
          : { total_count: 2, workflow_runs: [clone, first] };
      },
      fetchRunAttempt: async () => first
    }),
    /changed before its consistency barrier/
  );
});

test("enumeration rejects attempt substitution and unstable identity across reruns", async () => {
  const auth = authorization();
  const latest = rawRun(auth, {
    run_attempt: 2,
    run_started_at: "2026-08-01T12:21:00Z",
    updated_at: "2026-08-01T12:30:00Z"
  });
  await assert.rejects(
    enumerateCalibrationAcquisitionAttempts({
      authorization: auth,
      fetchWorkflowRunsPage: async () => ({
        total_count: 1,
        workflow_runs: [latest]
      }),
      fetchRunAttempt: async ({ runAttempt }) =>
        runAttempt === 1
          ? rawRun(auth, {
              id: 99999,
              updated_at: "2026-08-01T12:20:00Z"
            })
          : latest
    }),
    /returned a different identity/
  );

  const changedHead = rawRun(auth, {
    run_attempt: 1,
    head_sha: "9".repeat(40),
    updated_at: "2026-08-01T12:20:00Z"
  });
  await assert.rejects(
    enumerateCalibrationAcquisitionAttempts({
      authorization: auth,
      fetchWorkflowRunsPage: async () => ({
        total_count: 1,
        workflow_runs: [latest]
      }),
      fetchRunAttempt: async ({ runAttempt }) =>
        runAttempt === 1 ? changedHead : latest
    }),
    /does not match the exact authorized acquisition workflow identity/
  );
});

test("a same-title acquisition on a different carrier head is never authorized", () => {
  const auth = authorization();
  assert.throws(
    () =>
      buildCalibrationAcquisitionAttemptLedger({
        authorization: auth,
        attempts: [
          normalizedAttempt(auth, {
            head_sha: "9".repeat(40)
          })
        ]
      }),
    /does not match the exact authorized acquisition workflow identity/
  );
});

test("GitHub login casing is accepted and canonicalized consistently", () => {
  const auth = authorization();
  const ledger = buildCalibrationAcquisitionAttemptLedger({
    authorization: auth,
    attempts: [
      normalizedAttempt(auth, {
        actor: "iAnonymous3000",
        triggering_actor: "iAnonymous3000"
      })
    ]
  });
  assert.equal(ledger.attempts[0].actor, "ianonymous3000");
  assert.equal(ledger.attempts[0].triggeringActor, "ianonymous3000");
});

test("server chronology is exact and operator-authored timestamps are not accepted", () => {
  const auth = authorization();
  assert.throws(
    () =>
      buildCalibrationAcquisitionAttemptLedger({
        authorization: auth,
        attempts: [
          normalizedAttempt(auth, {
            created_at: "2026-08-01T11:59:59Z",
            run_started_at: "2026-08-01T12:00:00Z",
            updated_at: "2026-08-01T12:20:00Z"
          })
        ]
      }),
    /predate the roster authorization artifact/
  );
  const ledger = singleSuccessLedger(auth);
  const withOperatorTime = {
    ...ledger,
    collectedAt: "2026-08-01T12:21:00.000Z"
  };
  assert.throws(
    () => validateCalibrationAcquisitionAttemptLedger(withOperatorTime),
    /must contain exactly/
  );
});

test("a matching pre-authorization run is enumerated and invalidates the ceremony", async () => {
  const auth = authorization();
  const predictedIdentityRun = rawRun(auth, {
    created_at: "2026-08-01T11:59:00Z",
    run_started_at: "2026-08-01T11:59:01Z",
    updated_at: "2026-08-01T11:59:30Z"
  });
  await assert.rejects(
    enumerateCalibrationAcquisitionAttempts({
      authorization: auth,
      fetchWorkflowRunsPage: async ({ endpoint }) => {
        assert.doesNotMatch(endpoint, /created=/);
        return {
          total_count: 1,
          workflow_runs: [predictedIdentityRun]
        };
      },
      fetchRunAttempt: async () => predictedIdentityRun
    }),
    /predate the roster authorization artifact/
  );
});

test("live comparison detects a later clone or rerun instead of trusting stale archived bytes", async () => {
  const auth = authorization();
  const archived = singleSuccessLedger(auth);
  const clone = normalizedAttempt(auth, {
    id: 51002,
    run_number: 72,
    created_at: "2026-08-01T12:21:00Z",
    run_started_at: "2026-08-01T12:21:02Z",
    updated_at: "2026-08-01T12:40:00Z"
  });
  const live = buildCalibrationAcquisitionAttemptLedger({
    authorization: auth,
    attempts: [...archived.attempts, clone]
  });
  assert.throws(
    () =>
      compareCalibrationAcquisitionAttemptLedgers({
        archivedLedger: archived,
        liveLedger: live,
        expectedAuthorization: auth
      }),
    /exactly one successful matching run at attempt 1/
  );

  const archivedRaw = rawRun(auth);
  const verified =
    await verifyArchivedCalibrationAcquisitionAttemptLedgerAgainstGithub({
      archivedLedger: archived,
      requestJson: async ({ endpoint }) =>
        endpoint.includes("/attempts/1")
          ? archivedRaw
          : { total_count: 1, workflow_runs: [archivedRaw] }
    });
  assert.equal(verified.selectedAttempt.runId, 51001);
});

test("requestJson convenience path returns canonical text and digest", async () => {
  const auth = authorization();
  const run = rawRun(auth);
  const fetched = await fetchCalibrationAcquisitionAttemptLedger({
    authorization: auth,
    requestJson: async ({ endpoint }) =>
      endpoint.includes("/attempts/1")
        ? Buffer.from(JSON.stringify(run))
        : JSON.stringify({ total_count: 1, workflow_runs: [run] })
  });
  assert.equal(
    fetched.text,
    canonicalCalibrationAcquisitionText(fetched.ledger)
  );
  assert.equal(
    fetched.sha256,
    calibrationAcquisitionAttemptLedgerSha256(fetched.ledger)
  );
});

test("roster selection ledger binds the complete unique run set and server artifact", () => {
  const snapshot = rosterSelectionSnapshot();
  assert.equal(
    snapshot.identity.runName,
    `calibration-label-roster:${STUDY_ID}:${CANDIDATE}`
  );
  assert.doesNotMatch(snapshot.identity.runName, new RegExp(CASE_ROOT));
  assert.deepEqual(
    validateCalibrationLabelRosterSelectionSnapshot(snapshot),
    snapshot
  );
  const ledger = buildCalibrationLabelRosterSelectionLedger({
    rosterAuthorizationSha256: ROSTER_AUTHORIZATION,
    selection: snapshot,
    selectedArtifact: rosterSelectedArtifact()
  });
  assert.deepEqual(
    validateCalibrationLabelRosterSelectionLedger(ledger, {
      rosterAuthorizationSha256: ROSTER_AUTHORIZATION,
      studyId: STUDY_ID,
      candidateCommit: CANDIDATE
    }),
    ledger
  );
  assert.match(
    calibrationLabelRosterSelectionLedgerSha256(ledger),
    /^[0-9a-f]{64}$/
  );

  const digestDrift = structuredClone(snapshot);
  digestDrift.snapshotSha256 = "0".repeat(64);
  assert.throws(
    () => validateCalibrationLabelRosterSelectionSnapshot(digestDrift),
    /snapshot digest is invalid/
  );
  const clone = rosterRunSummary({
    runId: 31002,
    createdAt: "2026-08-01T12:01:00.000Z",
    runStartedAt: "2026-08-01T12:01:02.000Z",
    updatedAt: "2026-08-01T12:02:00.000Z"
  });
  assert.throws(
    () =>
      validateCalibrationLabelRosterSelectionSnapshot(
        rosterSelectionSnapshot({
          runs: [rosterRunSummary(), clone]
        })
      ),
    /exactly one same-identity server run/
  );
  assert.throws(
    () =>
      buildCalibrationLabelRosterSelectionLedger({
        rosterAuthorizationSha256: ROSTER_AUTHORIZATION,
        selection: snapshot,
        selectedArtifact: rosterSelectedArtifact({
          actor: "different-actor"
        })
      }),
    /does not bind the sole terminal server run/
  );
});

test("roster bytes and selection derive the one exact acquisition authorization", () => {
  const roster = rosterAuthorizationDocument();
  const rosterText = `${JSON.stringify(roster, null, 2)}\n`;
  const rosterSha256 = sha256(rosterText);
  const selectionLedger = buildCalibrationLabelRosterSelectionLedger({
    rosterAuthorizationSha256: rosterSha256,
    selection: rosterSelectionSnapshot(),
    selectedArtifact: rosterSelectedArtifact()
  });
  const derived = buildCalibrationAcquisitionAuthorizationFromRoster({
    rosterAuthorization: roster,
    rosterAuthorizationSha256: rosterSha256,
    rosterSelectionLedger: selectionLedger
  });
  assert.equal(derived.studyId, STUDY_ID);
  assert.equal(derived.candidateCommit, CANDIDATE);
  assert.equal(derived.roster.artifactId, 41001);
  assert.equal(derived.roster.authorizationSha256, rosterSha256);
  assert.equal(derived.roster.artifactCreatedAt, ROSTER_CREATED_AT);
  assert.equal(derived.runName, authorization({
    roster: { authorizationSha256: rosterSha256 }
  }).runName);

  const actorDrift = structuredClone(roster);
  actorDrift.producer.actor = "someone-else";
  assert.throws(
    () =>
      buildCalibrationAcquisitionAuthorizationFromRoster({
        rosterAuthorization: actorDrift,
        rosterAuthorizationSha256: rosterSha256,
        rosterSelectionLedger: selectionLedger
      }),
    /producer, and authorization disagree/
  );
});

test("roster live comparison rejects post-archive run or artifact drift", () => {
  const ledger = buildCalibrationLabelRosterSelectionLedger({
    rosterAuthorizationSha256: ROSTER_AUTHORIZATION,
    selection: rosterSelectionSnapshot(),
    selectedArtifact: rosterSelectedArtifact()
  });
  assert.deepEqual(
    compareCalibrationLabelRosterSelectionLedgers({
      archivedLedger: ledger,
      liveSelection: rosterSelectionSnapshot(),
      liveSelectedArtifact: rosterSelectedArtifact()
    }),
    ledger
  );
  assert.throws(
    () =>
      compareCalibrationLabelRosterSelectionLedgers({
        archivedLedger: ledger,
        liveSelection: rosterSelectionSnapshot(),
        liveSelectedArtifact: rosterSelectedArtifact({
          archiveSha256: "a".repeat(64)
        })
      }),
    /drifted from the archived selection ledger/
  );
});

test("end-to-end file verifier authenticates files before checking both live sets", async () => {
  const temporary = mkdtempSync(
    path.join(os.tmpdir(), "sbl-calibration-auth-")
  );
  try {
    const directory = path.join(temporary, "calibration", STUDY_ID);
    mkdirSync(directory, { recursive: true });
    const roster = rosterAuthorizationDocument();
    const rosterText = `${JSON.stringify(roster, null, 2)}\n`;
    const rosterSha256 = sha256(rosterText);
    const selection = buildCalibrationLabelRosterSelectionLedger({
      rosterAuthorizationSha256: rosterSha256,
      selection: rosterSelectionSnapshot(),
      selectedArtifact: rosterSelectedArtifact()
    });
    const selectionText =
      canonicalCalibrationAcquisitionText(selection);
    const expectedAuthorization =
      buildCalibrationAcquisitionAuthorizationFromRoster({
        rosterAuthorization: roster,
        rosterAuthorizationSha256: rosterSha256,
        rosterSelectionLedger: selection
      });
    const attempts = singleSuccessLedger(expectedAuthorization);
    const attemptsText =
      canonicalCalibrationAcquisitionText(attempts);
    const rosterPath = path.join(directory, "label-roster-authorization.json");
    const selectionPath = path.join(directory, "roster-selection-ledger.json");
    const attemptsPath = path.join(
      directory,
      "acquisition-attempt-ledger.json"
    );
    writeFileSync(rosterPath, rosterText);
    writeFileSync(selectionPath, selectionText);
    writeFileSync(attemptsPath, attemptsText);
    const rawAcquisition = rawRun(expectedAuthorization);
    const result = await verifyCalibrationCeremonyFilesLive({
      rootDir: temporary,
      repository: CALIBRATION_ACQUISITION_REPOSITORY,
      studyId: STUDY_ID,
      candidateCommit: CANDIDATE,
      labelRosterAuthorizationPath: path.relative(temporary, rosterPath),
      labelRosterAuthorizationSha256: rosterSha256,
      rosterSelectionLedgerPath: path.relative(temporary, selectionPath),
      rosterSelectionLedgerSha256: sha256(selectionText),
      acquisitionAttemptLedgerPath: path.relative(temporary, attemptsPath),
      acquisitionAttemptLedgerSha256: sha256(attemptsText),
      validateRosterAuthorization: (value, expected) => {
        assert.equal(value.studyId, expected.studyId);
        assert.equal(value.candidateCommit, expected.candidateCommit);
        return value;
      },
      fetchRosterRuns: async () => [{ id: 31001 }],
      buildRosterSelectionSnapshot: async ({ runs }) => {
        assert.equal(runs.length, 1);
        return rosterSelectionSnapshot();
      },
      fetchRosterRun: async () => ({ id: 31001 }),
      fetchRosterArtifacts: async () => ({
        total_count: 1,
        artifacts: [{ id: 41001 }]
      }),
      validateRosterGithubMetadata: () => rosterSelectedArtifact(),
      requestJson: async ({ endpoint }) =>
        endpoint.includes("/attempts/1")
          ? rawAcquisition
          : { total_count: 1, workflow_runs: [rawAcquisition] }
    });
    assert.equal(result.studyId, STUDY_ID);
    assert.equal(result.rosterRunId, 31001);
    assert.equal(result.acquisitionRunId, 51001);

    await assert.rejects(
      verifyCalibrationCeremonyFilesLive({
        rootDir: temporary,
        repository: CALIBRATION_ACQUISITION_REPOSITORY,
        studyId: STUDY_ID,
        candidateCommit: CANDIDATE,
        labelRosterAuthorizationPath: path.relative(temporary, rosterPath),
        labelRosterAuthorizationSha256: rosterSha256,
        rosterSelectionLedgerPath: path.relative(temporary, selectionPath),
        rosterSelectionLedgerSha256: sha256(selectionText),
        acquisitionAttemptLedgerPath: path.relative(
          temporary,
          attemptsPath
        ),
        acquisitionAttemptLedgerSha256: sha256(attemptsText),
        validateRosterAuthorization: (value) => value,
        fetchRosterRuns: async () => [],
        buildRosterSelectionSnapshot: async ({ runs }) => {
          if (runs.length !== 1) {
            throw new Error("same-identity roster run set drifted");
          }
          return rosterSelectionSnapshot();
        },
        fetchRosterRun: async () => ({ id: 31001 }),
        fetchRosterArtifacts: async () => ({ artifacts: [] }),
        validateRosterGithubMetadata: () => rosterSelectedArtifact(),
        requestJson: async ({ endpoint }) =>
          endpoint.includes("/attempts/1")
            ? rawAcquisition
            : { total_count: 1, workflow_runs: [rawAcquisition] }
      }),
      /selection ledger|same-identity|drifted/
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("canonical CLI exposes exactly the measurement-binding live-verifier flags", () => {
  const source = readFileSync(
    new URL("./calibration-acquisition-authorization.mjs", import.meta.url),
    "utf8"
  );
  for (const flag of [
    "--verify-live",
    "--repository",
    "--study-id",
    "--candidate-commit",
    "--label-roster-authorization",
    "--label-roster-authorization-sha256",
    "--roster-selection-ledger",
    "--roster-selection-ledger-sha256",
    "--acquisition-attempt-ledger",
    "--acquisition-attempt-ledger-sha256"
  ]) {
    assert.match(source, new RegExp(flag));
  }
  assert.match(source, /unknown calibration authorization argument/);
  assert.match(source, /may be supplied only once/);
});
