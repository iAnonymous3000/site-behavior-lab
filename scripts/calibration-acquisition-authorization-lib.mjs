import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  readFileSync,
  realpathSync
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { TextDecoder } from "node:util";

const requireFromHere = createRequire(import.meta.url);
let sharedCanonicalSerializer;

export const CALIBRATION_ACQUISITION_REPOSITORY =
  "iAnonymous3000/site-behavior-lab";
export const CALIBRATION_ACQUISITION_WORKFLOW_PATH =
  ".github/workflows/calibration-study.yml";
export const CALIBRATION_ACQUISITION_RUN_NAME_PREFIX =
  "calibration-acquire";
export const CALIBRATION_ACQUISITION_ATTEMPT_LEDGER_SCHEMA_VERSION = 1;
export const CALIBRATION_ACQUISITION_ATTEMPT_LEDGER_KIND =
  "site-behavior-detector-calibration-acquisition-attempt-ledger";
export const CALIBRATION_LABEL_ROSTER_WORKFLOW_PATH =
  ".github/workflows/calibration-label-roster.yml";
export const CALIBRATION_LABEL_ROSTER_SELECTION_KIND =
  "site-behavior-detector-calibration-label-roster-selection";
export const CALIBRATION_LABEL_ROSTER_SELECTION_LEDGER_SCHEMA_VERSION = 1;
export const CALIBRATION_LABEL_ROSTER_SELECTION_LEDGER_KIND =
  "site-behavior-detector-calibration-label-roster-selection-ledger";
export const CALIBRATION_ACQUISITION_MAX_WORKFLOW_PAGES = 10;
export const CALIBRATION_ACQUISITION_MAX_QUERY_RUNS = 999;
export const CALIBRATION_ACQUISITION_MAX_MATCHING_RUNS = 100;
export const CALIBRATION_ACQUISITION_MAX_RUN_ATTEMPTS = 100;
export const CALIBRATION_ACQUISITION_MAX_TOTAL_ATTEMPTS = 200;

const FULL_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const TOKEN = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const LOGIN =
  /^(?:(?!-)(?!.*--)[a-z0-9-]{1,39}(?<!-)|[a-z0-9-]{1,100}\[bot\])$/;
const ACTIONS_INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const RUN_STATUSES = new Set([
  "completed",
  "in_progress",
  "pending",
  "queued",
  "requested",
  "waiting"
]);
const RUN_CONCLUSIONS = new Set([
  "action_required",
  "cancelled",
  "failure",
  "neutral",
  "skipped",
  "stale",
  "startup_failure",
  "success",
  "timed_out"
]);
const AUTHORIZATION_KEYS = [
  "studyId",
  "detector",
  "candidateCommit",
  "roster",
  "commitmentSetSha256",
  "nonce",
  "acquisitionWorkflowPath",
  "authorizedRunAttempt",
  "caseInputRootSha256",
  "runName"
];
const AUTHORIZATION_ROSTER_KEYS = [
  "runId",
  "runAttempt",
  "headSha",
  "artifactId",
  "archiveSha256",
  "authorizationSha256",
  "artifactCreatedAt"
];
const ATTEMPT_KEYS = [
  "runId",
  "runAttempt",
  "workflowId",
  "runNumber",
  "repository",
  "workflowPath",
  "displayTitle",
  "event",
  "headBranch",
  "headSha",
  "actor",
  "triggeringActor",
  "status",
  "conclusion",
  "createdAt",
  "runStartedAt",
  "updatedAt"
];
const LEDGER_KEYS = [
  "schemaVersion",
  "artifactKind",
  "authorization",
  "query",
  "attempts"
];
const QUERY_KEYS = [
  "repository",
  "workflowPath",
  "event",
  "headBranch",
  "runName",
  "createdNotBefore"
];
const STABLE_RUN_KEYS = [
  "runId",
  "workflowId",
  "runNumber",
  "repository",
  "workflowPath",
  "displayTitle",
  "event",
  "headBranch",
  "headSha",
  "actor",
  "createdAt"
];
const ROSTER_SELECTION_DIGEST_DOMAIN =
  "site-behavior-calibration-label-roster-selection-v1";
const ROSTER_SELECTION_KEYS = [
  "schemaVersion",
  "artifactKind",
  "identity",
  "selectedRun",
  "runs",
  "snapshotSha256"
];
const ROSTER_SELECTION_IDENTITY_KEYS = [
  "studyId",
  "candidateCommit",
  "carrierCommit",
  "caseInputRootSha256",
  "runName"
];
const ROSTER_RUN_KEYS = [
  "runId",
  "runAttempt",
  "status",
  "conclusion",
  "event",
  "workflowPath",
  "headBranch",
  "headSha",
  "actor",
  "triggeringActor",
  "createdAt",
  "runStartedAt",
  "updatedAt",
  "displayTitle"
];
const ROSTER_SELECTION_LEDGER_KEYS = [
  "schemaVersion",
  "artifactKind",
  "rosterAuthorizationSha256",
  "selection",
  "selectedArtifact"
];
const ROSTER_ARTIFACT_KEYS = [
  "runId",
  "runAttempt",
  "headSha",
  "actor",
  "triggeringActor",
  "runName",
  "runStatus",
  "runConclusion",
  "runStartedAt",
  "runUpdatedAt",
  "runCompletedAt",
  "artifactId",
  "artifactName",
  "archiveSha256",
  "archiveBytes",
  "artifactCreatedAt",
  "artifactExpiresAt"
];

export function calibrationAcquisitionRunName(input) {
  const studyId = token(input?.studyId, "calibration acquisition studyId");
  const rosterRunId = positiveInteger(
    input?.rosterRunId,
    "calibration acquisition roster run id"
  );
  const rosterArtifactId = positiveInteger(
    input?.rosterArtifactId,
    "calibration acquisition roster artifact id"
  );
  const nonce = digest(input?.nonce, "calibration acquisition authorization nonce");
  const value =
    `${CALIBRATION_ACQUISITION_RUN_NAME_PREFIX}:${studyId}:` +
    `${rosterRunId}:${rosterArtifactId}:${nonce}`;
  requireValue(
    value.length <= 255,
    "calibration acquisition run-name exceeds the GitHub title bound"
  );
  return value;
}

/**
 * Normalize the exact immutable authorization identity produced by the
 * pre-acquisition roster ceremony. Every timestamp accepted here is server
 * supplied by GitHub; this object deliberately has no operator-authored time.
 */
export function validateCalibrationAcquisitionAuthorizationIdentity(value) {
  exactKeys(value, AUTHORIZATION_KEYS, "calibration acquisition authorization");
  exactKeys(
    value.roster,
    AUTHORIZATION_ROSTER_KEYS,
    "calibration acquisition authorization roster"
  );
  const normalized = {
    studyId: token(value.studyId, "calibration acquisition studyId"),
    detector: token(value.detector, "calibration acquisition detector"),
    candidateCommit: fullSha(
      value.candidateCommit,
      "calibration acquisition candidate commit"
    ),
    roster: {
      runId: positiveInteger(
        value.roster.runId,
        "calibration acquisition roster run id"
      ),
      runAttempt: positiveInteger(
        value.roster.runAttempt,
        "calibration acquisition roster run attempt",
        CALIBRATION_ACQUISITION_MAX_RUN_ATTEMPTS
      ),
      headSha: fullSha(
        value.roster.headSha,
        "calibration acquisition roster head SHA"
      ),
      artifactId: positiveInteger(
        value.roster.artifactId,
        "calibration acquisition roster artifact id"
      ),
      archiveSha256: digest(
        value.roster.archiveSha256,
        "calibration acquisition roster archive digest"
      ),
      authorizationSha256: digest(
        value.roster.authorizationSha256,
        "calibration acquisition roster authorization digest"
      ),
      artifactCreatedAt: actionsInstant(
        value.roster.artifactCreatedAt,
        "calibration acquisition roster artifact created_at"
      )
    },
    commitmentSetSha256: digest(
      value.commitmentSetSha256,
      "calibration acquisition commitment-set digest"
    ),
    nonce: digest(
      value.nonce,
      "calibration acquisition authorization nonce"
    ),
    acquisitionWorkflowPath: value.acquisitionWorkflowPath,
    authorizedRunAttempt: positiveInteger(
      value.authorizedRunAttempt,
      "calibration acquisition authorized run attempt",
      CALIBRATION_ACQUISITION_MAX_RUN_ATTEMPTS
    ),
    caseInputRootSha256: digest(
      value.caseInputRootSha256,
      "calibration acquisition case-input-root digest"
    ),
    runName: value.runName
  };
  requireValue(
    normalized.roster.runAttempt === 1,
    "calibration acquisition authorization requires roster run attempt 1"
  );
  requireValue(
    normalized.acquisitionWorkflowPath ===
      CALIBRATION_ACQUISITION_WORKFLOW_PATH,
    "calibration acquisition authorization names the wrong workflow"
  );
  requireValue(
    normalized.authorizedRunAttempt === 1,
    "calibration acquisition authorization may authorize only run attempt 1"
  );
  const expectedRunName = calibrationAcquisitionRunName({
    studyId: normalized.studyId,
    rosterRunId: normalized.roster.runId,
    rosterArtifactId: normalized.roster.artifactId,
    nonce: normalized.nonce
  });
  requireValue(
    normalized.runName === expectedRunName,
    "calibration acquisition authorization run-name is not identity-bound"
  );
  return normalized;
}

export function buildCalibrationAcquisitionAuthorizationIdentity(input) {
  return validateCalibrationAcquisitionAuthorizationIdentity({
    studyId: input.studyId,
    detector: input.detector,
    candidateCommit: input.candidateCommit,
    roster: {
      runId: input.roster.runId,
      runAttempt: input.roster.runAttempt,
      headSha: input.roster.headSha,
      artifactId: input.roster.artifactId,
      archiveSha256: input.roster.archiveSha256,
      authorizationSha256: input.roster.authorizationSha256,
      artifactCreatedAt: input.roster.artifactCreatedAt
    },
    commitmentSetSha256: input.commitmentSetSha256,
    nonce: input.nonce,
    acquisitionWorkflowPath:
      input.acquisitionWorkflowPath ??
      CALIBRATION_ACQUISITION_WORKFLOW_PATH,
    authorizedRunAttempt: input.authorizedRunAttempt ?? 1,
    caseInputRootSha256: input.caseInputRootSha256,
    runName:
      input.runName ??
      calibrationAcquisitionRunName({
        studyId: input.studyId,
        rosterRunId: input.roster.runId,
        rosterArtifactId: input.roster.artifactId,
        nonce: input.nonce
      })
  });
}

export function calibrationAcquisitionAuthorizationSha256(value) {
  const authorization =
    validateCalibrationAcquisitionAuthorizationIdentity(value);
  return sha256Hex(canonicalCalibrationAcquisitionText(authorization));
}

export function validateCalibrationLabelRosterSelectionSnapshot(value) {
  exactKeys(
    value,
    ROSTER_SELECTION_KEYS,
    "calibration label roster selection snapshot"
  );
  requireValue(
    value.schemaVersion === 1 &&
      value.artifactKind === CALIBRATION_LABEL_ROSTER_SELECTION_KIND,
    "calibration label roster selection snapshot identity is invalid"
  );
  exactKeys(
    value.identity,
    ROSTER_SELECTION_IDENTITY_KEYS,
    "calibration label roster selection identity"
  );
  const identity = {
    studyId: token(
      value.identity.studyId,
      "calibration label roster selection studyId"
    ),
    candidateCommit: fullSha(
      value.identity.candidateCommit,
      "calibration label roster selection candidateCommit"
    ),
    carrierCommit: fullSha(
      value.identity.carrierCommit,
      "calibration label roster selection carrierCommit"
    ),
    caseInputRootSha256: digest(
      value.identity.caseInputRootSha256,
      "calibration label roster selection case-input-root digest"
    ),
    runName: value.identity.runName
  };
  const expectedRunName =
    `calibration-label-roster:${identity.studyId}:` +
    identity.candidateCommit;
  requireValue(
    identity.runName === expectedRunName && identity.runName.length <= 300,
    "calibration label roster selection run-name is not identity-bound"
  );
  requireValue(
    Array.isArray(value.runs) && value.runs.length === 1,
    "calibration label roster selection must retain exactly one same-identity server run"
  );
  const runs = value.runs.map((run, index) =>
    validateRosterRunSummary(
      run,
      identity,
      `calibration label roster selection runs[${index}]`
    )
  );
  const selectedRun = validateRosterRunSummary(
    value.selectedRun,
    identity,
    "calibration label roster selection selectedRun"
  );
  requireValue(
    canonicalCompactJson(selectedRun) === canonicalCompactJson(runs[0]) &&
      selectedRun.runAttempt === 1 &&
      selectedRun.status === "completed" &&
      selectedRun.conclusion === "success",
    "calibration label roster selection must select its sole successful attempt-1 run"
  );
  const core = {
    schemaVersion: 1,
    artifactKind: CALIBRATION_LABEL_ROSTER_SELECTION_KIND,
    identity,
    selectedRun,
    runs
  };
  const snapshotSha256 = digest(
    value.snapshotSha256,
    "calibration label roster selection snapshot digest"
  );
  requireValue(
    snapshotSha256 ===
      sha256Hex(
        `${ROSTER_SELECTION_DIGEST_DOMAIN}\u0000${sharedCanonicalJson(core)}`
      ),
    "calibration label roster selection snapshot digest is invalid"
  );
  return { ...core, snapshotSha256 };
}

export function buildCalibrationLabelRosterSelectionLedger({
  rosterAuthorizationSha256,
  selection,
  selectedArtifact
}) {
  return validateCalibrationLabelRosterSelectionLedger({
    schemaVersion:
      CALIBRATION_LABEL_ROSTER_SELECTION_LEDGER_SCHEMA_VERSION,
    artifactKind: CALIBRATION_LABEL_ROSTER_SELECTION_LEDGER_KIND,
    rosterAuthorizationSha256,
    selection,
    selectedArtifact
  });
}

export function validateCalibrationLabelRosterSelectionLedger(
  value,
  expected = {}
) {
  exactKeys(
    value,
    ROSTER_SELECTION_LEDGER_KEYS,
    "calibration label roster selection ledger"
  );
  requireValue(
    value.schemaVersion ===
      CALIBRATION_LABEL_ROSTER_SELECTION_LEDGER_SCHEMA_VERSION &&
      value.artifactKind ===
        CALIBRATION_LABEL_ROSTER_SELECTION_LEDGER_KIND,
    "calibration label roster selection-ledger identity is invalid"
  );
  const rosterAuthorizationSha256 = digest(
    value.rosterAuthorizationSha256,
    "calibration label roster authorization digest"
  );
  const selection =
    validateCalibrationLabelRosterSelectionSnapshot(value.selection);
  const selectedArtifact = validateRosterSelectedArtifact(
    value.selectedArtifact,
    selection
  );
  if (expected.rosterAuthorizationSha256 !== undefined) {
    requireValue(
      rosterAuthorizationSha256 === expected.rosterAuthorizationSha256,
      "calibration label roster selection ledger changed the roster authorization digest"
    );
  }
  if (expected.studyId !== undefined) {
    requireValue(
      selection.identity.studyId === expected.studyId,
      "calibration label roster selection ledger changed studyId"
    );
  }
  if (expected.candidateCommit !== undefined) {
    requireValue(
      selection.identity.candidateCommit === expected.candidateCommit,
      "calibration label roster selection ledger changed candidateCommit"
    );
  }
  if (expected.carrierCommit !== undefined) {
    requireValue(
      selection.identity.carrierCommit === expected.carrierCommit,
      "calibration label roster selection ledger changed carrierCommit"
    );
  }
  return {
    schemaVersion:
      CALIBRATION_LABEL_ROSTER_SELECTION_LEDGER_SCHEMA_VERSION,
    artifactKind: CALIBRATION_LABEL_ROSTER_SELECTION_LEDGER_KIND,
    rosterAuthorizationSha256,
    selection,
    selectedArtifact
  };
}

export function calibrationLabelRosterSelectionLedgerSha256(value) {
  const ledger = validateCalibrationLabelRosterSelectionLedger(value);
  return sha256Hex(canonicalCalibrationAcquisitionText(ledger));
}

export function canonicalCalibrationLabelRosterSelectionLedgerText(value) {
  return canonicalCalibrationAcquisitionText(
    validateCalibrationLabelRosterSelectionLedger(value)
  );
}

export function compareCalibrationLabelRosterSelectionLedgers({
  archivedLedger,
  liveSelection,
  liveSelectedArtifact
}) {
  const archived =
    validateCalibrationLabelRosterSelectionLedger(archivedLedger);
  const live = buildCalibrationLabelRosterSelectionLedger({
    rosterAuthorizationSha256:
      archived.rosterAuthorizationSha256,
    selection: liveSelection,
    selectedArtifact: liveSelectedArtifact
  });
  requireValue(
    canonicalCompactJson(archived) === canonicalCompactJson(live),
    "live GitHub roster run or selected-artifact set drifted from the archived selection ledger"
  );
  return archived;
}

/**
 * Cross-bind the immutable roster bytes and their server selection to the
 * acquisition authorization. Callers should pass the normalized roster
 * returned by calibration-label-roster-lib.mjs.
 */
export function buildCalibrationAcquisitionAuthorizationFromRoster({
  rosterAuthorization,
  rosterAuthorizationSha256,
  rosterSelectionLedger
}) {
  requireRecord(
    rosterAuthorization,
    "calibration label roster authorization"
  );
  const selection = validateCalibrationLabelRosterSelectionLedger(
    rosterSelectionLedger,
    {
      rosterAuthorizationSha256: digest(
        rosterAuthorizationSha256,
        "calibration label roster authorization digest"
      ),
      studyId: rosterAuthorization.studyId,
      candidateCommit: rosterAuthorization.candidateCommit,
      carrierCommit: rosterAuthorization.carrierCommit
    }
  );
  const producer = rosterAuthorization.producer;
  const authorization = rosterAuthorization.authorization;
  requireRecord(producer, "calibration label roster producer");
  requireRecord(authorization, "calibration label roster authorization policy");
  requireValue(
    rosterAuthorization.detector !== undefined &&
      rosterAuthorization.carrierCommit !== undefined &&
      rosterAuthorization.commitmentSetSha256 !== undefined &&
      selection.selection.identity.caseInputRootSha256 ===
        authorization.caseInputRootSha256 &&
      selection.selectedArtifact.runId === producer.runId &&
      selection.selectedArtifact.runAttempt === producer.runAttempt &&
      selection.selectedArtifact.headSha === producer.headSha &&
      selection.selectedArtifact.actor === producer.actor &&
      selection.selectedArtifact.triggeringActor ===
        producer.triggeringActor &&
      selection.selectedArtifact.headSha ===
        rosterAuthorization.carrierCommit,
    "calibration label roster bytes, server selection, producer, and authorization disagree"
  );
  return buildCalibrationAcquisitionAuthorizationIdentity({
    studyId: rosterAuthorization.studyId,
    detector: rosterAuthorization.detector,
    candidateCommit: rosterAuthorization.candidateCommit,
    roster: {
      runId: selection.selectedArtifact.runId,
      runAttempt: selection.selectedArtifact.runAttempt,
      headSha: selection.selectedArtifact.headSha,
      artifactId: selection.selectedArtifact.artifactId,
      archiveSha256: selection.selectedArtifact.archiveSha256,
      authorizationSha256: selection.rosterAuthorizationSha256,
      artifactCreatedAt:
        selection.selectedArtifact.artifactCreatedAt
    },
    commitmentSetSha256: rosterAuthorization.commitmentSetSha256,
    nonce: authorization.nonce,
    acquisitionWorkflowPath: authorization.acquisitionWorkflowPath,
    authorizedRunAttempt: authorization.authorizedRunAttempt,
    caseInputRootSha256: authorization.caseInputRootSha256
  });
}

export function calibrationAcquisitionWorkflowRunsEndpoint({
  authorization,
  page,
  perPage = 100
}) {
  validateCalibrationAcquisitionAuthorizationIdentity(authorization);
  const pageNumber = positiveInteger(
    page,
    "calibration acquisition workflow-runs page",
    CALIBRATION_ACQUISITION_MAX_WORKFLOW_PAGES
  );
  const pageSize = positiveInteger(
    perPage,
    "calibration acquisition workflow-runs page size",
    100
  );
  return (
    `/repos/${CALIBRATION_ACQUISITION_REPOSITORY}/actions/workflows/` +
    `calibration-study.yml/runs?event=workflow_dispatch&branch=main&` +
    `exclude_pull_requests=true&per_page=${pageSize}&` +
    `page=${pageNumber}`
  );
}

export function calibrationAcquisitionRunAttemptEndpoint({
  runId,
  runAttempt
}) {
  const normalizedRunId = positiveInteger(
    runId,
    "calibration acquisition run id"
  );
  const normalizedAttempt = positiveInteger(
    runAttempt,
    "calibration acquisition run attempt",
    CALIBRATION_ACQUISITION_MAX_RUN_ATTEMPTS
  );
  return (
    `/repos/${CALIBRATION_ACQUISITION_REPOSITORY}/actions/runs/` +
    `${normalizedRunId}/attempts/${normalizedAttempt}`
  );
}

/**
 * Enumerate the complete bounded workflow query and then fetch every attempt
 * for every run whose server display_title exactly equals the authorization
 * run-name. The callbacks are intentionally injectable; production callers
 * use GitHub REST while tests can supply an immutable response transcript.
 */
export async function enumerateCalibrationAcquisitionAttempts({
  authorization,
  fetchWorkflowRunsPage,
  fetchRunAttempt
}) {
  const normalizedAuthorization =
    validateCalibrationAcquisitionAuthorizationIdentity(authorization);
  requireValue(
    typeof fetchWorkflowRunsPage === "function",
    "calibration acquisition enumeration requires fetchWorkflowRunsPage"
  );
  requireValue(
    typeof fetchRunAttempt === "function",
    "calibration acquisition enumeration requires fetchRunAttempt"
  );
  const listedRuns = [];
  const listedRunIds = new Set();
  let firstPageIdentity = null;
  let declaredTotal = null;
  for (
    let page = 1;
    page <= CALIBRATION_ACQUISITION_MAX_WORKFLOW_PAGES;
    page += 1
  ) {
    const endpoint = calibrationAcquisitionWorkflowRunsEndpoint({
      authorization: normalizedAuthorization,
      page
    });
    const response = await fetchWorkflowRunsPage({
      repository: CALIBRATION_ACQUISITION_REPOSITORY,
      workflowPath: CALIBRATION_ACQUISITION_WORKFLOW_PATH,
      event: "workflow_dispatch",
      headBranch: "main",
      createdNotBefore:
        normalizedAuthorization.roster.artifactCreatedAt,
      runName: normalizedAuthorization.runName,
      page,
      perPage: 100,
      endpoint
    });
    requireRecord(
      response,
      `calibration acquisition workflow-runs page ${page}`
    );
    requireValue(
      Number.isSafeInteger(response.total_count) &&
        response.total_count >= 0 &&
        response.total_count <= CALIBRATION_ACQUISITION_MAX_QUERY_RUNS &&
        Array.isArray(response.workflow_runs) &&
        response.workflow_runs.length <= 100,
      `calibration acquisition workflow-runs page ${page} is not one bounded GitHub response`
    );
    if (declaredTotal === null) declaredTotal = response.total_count;
    requireValue(
      response.total_count === declaredTotal,
      "calibration acquisition workflow-run pages changed total_count during enumeration"
    );
    for (const [index, listed] of response.workflow_runs.entries()) {
      requireRecord(
        listed,
        `calibration acquisition listed run ${listedRuns.length + index + 1}`
      );
      const id = positiveInteger(
        listed.id,
        `calibration acquisition listed run ${listedRuns.length + index + 1} id`
      );
      requireValue(
        typeof listed.display_title === "string" &&
          listed.display_title.length >= 1 &&
          listed.display_title.length <= 255 &&
          !listedRunIds.has(id),
        "calibration acquisition workflow-run pagination returned a malformed or duplicate run"
      );
      listedRunIds.add(id);
      listedRuns.push(listed);
    }
    if (page === 1) {
      firstPageIdentity = response.workflow_runs.map((run) => ({
        id: run.id,
        displayTitle: run.display_title
      }));
    }
    requireValue(
      listedRuns.length <= declaredTotal,
      "calibration acquisition workflow-run pagination exceeded total_count"
    );
    if (listedRuns.length === declaredTotal) break;
    requireValue(
      response.workflow_runs.length > 0,
      "calibration acquisition workflow-run pagination ended before total_count"
    );
    if (page === CALIBRATION_ACQUISITION_MAX_WORKFLOW_PAGES) {
      throw new Error(
        `calibration acquisition workflow-run pagination exceeded ${CALIBRATION_ACQUISITION_MAX_WORKFLOW_PAGES} pages`
      );
    }
  }
  requireValue(
    listedRuns.length === declaredTotal,
    "calibration acquisition workflow-run enumeration is not set-complete"
  );
  const matches = listedRuns.filter(
    (run) => run.display_title === normalizedAuthorization.runName
  );
  requireValue(
    matches.length <= CALIBRATION_ACQUISITION_MAX_MATCHING_RUNS,
    `calibration acquisition authorization exceeds ${CALIBRATION_ACQUISITION_MAX_MATCHING_RUNS} matching runs`
  );
  let projectedAttempts = 0;
  const listedNormalized = [];
  for (const listed of matches) {
    const normalized = normalizeGithubAcquisitionAttempt(
      listed,
      normalizedAuthorization,
      `calibration acquisition listed run ${listed.id}`
    );
    projectedAttempts += normalized.runAttempt;
    requireValue(
      projectedAttempts <= CALIBRATION_ACQUISITION_MAX_TOTAL_ATTEMPTS,
      `calibration acquisition authorization exceeds ${CALIBRATION_ACQUISITION_MAX_TOTAL_ATTEMPTS} total attempts`
    );
    listedNormalized.push(normalized);
  }
  const attempts = [];
  for (const listed of listedNormalized) {
    const runAttempts = [];
    for (
      let runAttempt = 1;
      runAttempt <= listed.runAttempt;
      runAttempt += 1
    ) {
      const endpoint = calibrationAcquisitionRunAttemptEndpoint({
        runId: listed.runId,
        runAttempt
      });
      const raw = await fetchRunAttempt({
        repository: CALIBRATION_ACQUISITION_REPOSITORY,
        workflowPath: CALIBRATION_ACQUISITION_WORKFLOW_PATH,
        runName: normalizedAuthorization.runName,
        runId: listed.runId,
        runAttempt,
        endpoint
      });
      const normalized = normalizeGithubAcquisitionAttempt(
        raw,
        normalizedAuthorization,
        `calibration acquisition run ${listed.runId} attempt ${runAttempt}`
      );
      requireValue(
        normalized.runId === listed.runId &&
          normalized.runAttempt === runAttempt,
        `calibration acquisition run ${listed.runId} attempt endpoint returned a different identity`
      );
      runAttempts.push(normalized);
      attempts.push(normalized);
    }
    const current = runAttempts.at(-1);
    requireValue(
      canonicalCompactJson(current) === canonicalCompactJson(listed),
      `calibration acquisition listed run ${listed.runId} changed or disagreed with its current attempt`
    );
  }
  const confirmationRequest = {
    repository: CALIBRATION_ACQUISITION_REPOSITORY,
    workflowPath: CALIBRATION_ACQUISITION_WORKFLOW_PATH,
    event: "workflow_dispatch",
    headBranch: "main",
    createdNotBefore:
      normalizedAuthorization.roster.artifactCreatedAt,
    runName: normalizedAuthorization.runName,
    page: 1,
    perPage: 100,
    endpoint: calibrationAcquisitionWorkflowRunsEndpoint({
      authorization: normalizedAuthorization,
      page: 1
    })
  };
  const confirmation = await fetchWorkflowRunsPage(confirmationRequest);
  requireRecord(
    confirmation,
    "calibration acquisition workflow-runs confirmation page"
  );
  requireValue(
    confirmation.total_count === declaredTotal &&
      Array.isArray(confirmation.workflow_runs) &&
      confirmation.workflow_runs.length <= 100 &&
      canonicalCompactJson(
        confirmation.workflow_runs.map((run) => ({
          id: run?.id,
          displayTitle: run?.display_title
        }))
      ) === canonicalCompactJson(firstPageIdentity),
    "calibration acquisition workflow-run enumeration changed before its consistency barrier"
  );
  const listedById = new Map(
    listedNormalized.map((run) => [run.runId, run])
  );
  for (const raw of confirmation.workflow_runs) {
    if (raw?.display_title !== normalizedAuthorization.runName) continue;
    const confirmed = normalizeGithubAcquisitionAttempt(
      raw,
      normalizedAuthorization,
      `calibration acquisition confirmed run ${raw?.id}`
    );
    requireValue(
      canonicalCompactJson(confirmed) ===
        canonicalCompactJson(listedById.get(confirmed.runId)),
      `calibration acquisition run ${confirmed.runId} changed before the consistency barrier`
    );
  }
  return normalizeCalibrationAcquisitionAttempts(
    attempts,
    normalizedAuthorization
  );
}

export function buildCalibrationAcquisitionAttemptLedger({
  authorization,
  attempts
}) {
  const normalizedAuthorization =
    validateCalibrationAcquisitionAuthorizationIdentity(authorization);
  const normalizedAttempts = normalizeCalibrationAcquisitionAttempts(
    attempts,
    normalizedAuthorization
  );
  return {
    schemaVersion: CALIBRATION_ACQUISITION_ATTEMPT_LEDGER_SCHEMA_VERSION,
    artifactKind: CALIBRATION_ACQUISITION_ATTEMPT_LEDGER_KIND,
    authorization: normalizedAuthorization,
    query: {
      repository: CALIBRATION_ACQUISITION_REPOSITORY,
      workflowPath: CALIBRATION_ACQUISITION_WORKFLOW_PATH,
      event: "workflow_dispatch",
      headBranch: "main",
      runName: normalizedAuthorization.runName,
      createdNotBefore:
        normalizedAuthorization.roster.artifactCreatedAt
    },
    attempts: normalizedAttempts
  };
}

export async function fetchCalibrationAcquisitionAttemptLedger(input) {
  let attempts;
  if (typeof input.requestJson === "function") {
    attempts = await enumerateCalibrationAcquisitionAttempts({
      authorization: input.authorization,
      fetchWorkflowRunsPage: async (request) =>
        normalizeJsonResponse(
          await input.requestJson(request),
          `calibration acquisition workflow-runs page ${request.page}`
        ),
      fetchRunAttempt: async (request) =>
        normalizeJsonResponse(
          await input.requestJson(request),
          `calibration acquisition run ${request.runId} attempt ${request.runAttempt}`
        )
    });
  } else {
    attempts = await enumerateCalibrationAcquisitionAttempts(input);
  }
  const ledger = buildCalibrationAcquisitionAttemptLedger({
    authorization: input.authorization,
    attempts
  });
  return {
    ledger,
    text: canonicalCalibrationAcquisitionText(ledger),
    sha256: calibrationAcquisitionAttemptLedgerSha256(ledger)
  };
}

export function validateCalibrationAcquisitionAttemptLedger(
  value,
  expectedAuthorization
) {
  exactKeys(value, LEDGER_KEYS, "calibration acquisition attempt ledger");
  requireValue(
    value.schemaVersion ===
      CALIBRATION_ACQUISITION_ATTEMPT_LEDGER_SCHEMA_VERSION &&
      value.artifactKind ===
        CALIBRATION_ACQUISITION_ATTEMPT_LEDGER_KIND,
    "calibration acquisition attempt ledger identity is invalid"
  );
  const authorization =
    validateCalibrationAcquisitionAuthorizationIdentity(value.authorization);
  if (expectedAuthorization !== undefined) {
    const expected =
      validateCalibrationAcquisitionAuthorizationIdentity(
        expectedAuthorization
      );
    requireValue(
      canonicalCompactJson(authorization) === canonicalCompactJson(expected),
      "calibration acquisition attempt ledger changed its authorization identity"
    );
  }
  exactKeys(
    value.query,
    QUERY_KEYS,
    "calibration acquisition attempt-ledger query"
  );
  const query = {
    repository: value.query.repository,
    workflowPath: value.query.workflowPath,
    event: value.query.event,
    headBranch: value.query.headBranch,
    runName: value.query.runName,
    createdNotBefore: actionsInstant(
      value.query.createdNotBefore,
      "calibration acquisition attempt-ledger createdNotBefore"
    )
  };
  requireValue(
    query.repository === CALIBRATION_ACQUISITION_REPOSITORY &&
      query.workflowPath === CALIBRATION_ACQUISITION_WORKFLOW_PATH &&
      query.event === "workflow_dispatch" &&
      query.headBranch === "main" &&
      query.runName === authorization.runName &&
      query.createdNotBefore === authorization.roster.artifactCreatedAt,
    "calibration acquisition attempt-ledger query is not authorization-bound"
  );
  const attempts = normalizeCalibrationAcquisitionAttempts(
    value.attempts,
    authorization
  );
  requireValue(
    canonicalCompactJson(attempts) === canonicalCompactJson(value.attempts),
    "calibration acquisition attempts are not in canonical normalized order"
  );
  return {
    schemaVersion: CALIBRATION_ACQUISITION_ATTEMPT_LEDGER_SCHEMA_VERSION,
    artifactKind: CALIBRATION_ACQUISITION_ATTEMPT_LEDGER_KIND,
    authorization,
    query,
    attempts
  };
}

export function requireEligibleCalibrationAcquisitionAttemptLedger(
  value,
  expectedAuthorization
) {
  const ledger = validateCalibrationAcquisitionAttemptLedger(
    value,
    expectedAuthorization
  );
  const runIds = new Set(ledger.attempts.map((attempt) => attempt.runId));
  requireValue(
    runIds.size === 1 &&
      ledger.attempts.length === 1 &&
      ledger.attempts[0].runAttempt ===
        ledger.authorization.authorizedRunAttempt &&
      ledger.attempts[0].status === "completed" &&
      ledger.attempts[0].conclusion === "success",
    "calibration acquisition authorization is ineligible: it must have exactly one successful matching run at attempt 1 and no clone, rerun, failed, cancelled, or in-progress attempt"
  );
  return {
    ledger,
    selectedAttempt: ledger.attempts[0],
    ledgerSha256: calibrationAcquisitionAttemptLedgerSha256(ledger)
  };
}

export function calibrationAcquisitionAttemptLedgerSha256(value) {
  const ledger = validateCalibrationAcquisitionAttemptLedger(value);
  return sha256Hex(canonicalCalibrationAcquisitionText(ledger));
}

export function canonicalCalibrationAcquisitionAttemptLedgerText(value) {
  return canonicalCalibrationAcquisitionText(
    validateCalibrationAcquisitionAttemptLedger(value)
  );
}

export function compareCalibrationAcquisitionAttemptLedgers({
  archivedLedger,
  liveLedger,
  expectedAuthorization
}) {
  const archived = requireEligibleCalibrationAcquisitionAttemptLedger(
    archivedLedger,
    expectedAuthorization
  );
  const live = requireEligibleCalibrationAcquisitionAttemptLedger(
    liveLedger,
    archived.ledger.authorization
  );
  requireValue(
    canonicalCompactJson(archived.ledger) ===
      canonicalCompactJson(live.ledger),
    "live GitHub acquisition attempt set drifted from the archived append-only ledger"
  );
  return {
    authorization: archived.ledger.authorization,
    selectedAttempt: archived.selectedAttempt,
    ledgerSha256: archived.ledgerSha256
  };
}

export async function verifyArchivedCalibrationAcquisitionAttemptLedgerAgainstGithub(
  input
) {
  const archived = validateCalibrationAcquisitionAttemptLedger(
    input.archivedLedger,
    input.expectedAuthorization
  );
  const live = await fetchCalibrationAcquisitionAttemptLedger({
    authorization: archived.authorization,
    requestJson: input.requestJson,
    fetchWorkflowRunsPage: input.fetchWorkflowRunsPage,
    fetchRunAttempt: input.fetchRunAttempt
  });
  return compareCalibrationAcquisitionAttemptLedgers({
    archivedLedger: archived,
    liveLedger: live.ledger,
    expectedAuthorization: archived.authorization
  });
}

/**
 * Canonical end-to-end verifier used by the release binding. It authenticates
 * all three archived files before making network requests, re-enumerates the
 * roster selection and acquisition attempts from GitHub, and rejects any
 * later clone/rerun/set drift.
 */
export async function verifyCalibrationCeremonyFilesLive(input) {
  requireValue(
    input.repository === CALIBRATION_ACQUISITION_REPOSITORY,
    "calibration ceremony verification is restricted to the governed repository"
  );
  const rootDir = realpathSync(input.rootDir);
  const expectedStudyId = token(
    input.studyId,
    "calibration ceremony studyId"
  );
  const expectedCandidateCommit = fullSha(
    input.candidateCommit,
    "calibration ceremony candidate commit"
  );
  for (const [name, dependency] of [
    ["validateRosterAuthorization", input.validateRosterAuthorization],
    ["fetchRosterRuns", input.fetchRosterRuns],
    ["buildRosterSelectionSnapshot", input.buildRosterSelectionSnapshot],
    ["fetchRosterRun", input.fetchRosterRun],
    ["fetchRosterArtifacts", input.fetchRosterArtifacts],
    ["validateRosterGithubMetadata", input.validateRosterGithubMetadata]
  ]) {
    requireValue(
      typeof dependency === "function",
      `calibration ceremony live verification requires ${name}`
    );
  }

  const rosterFile = readVerifiedJsonFile({
    rootDir,
    file: input.labelRosterAuthorizationPath,
    sha256: input.labelRosterAuthorizationSha256,
    maximumBytes: 32 * 1024 * 1024,
    label: "calibration label roster authorization"
  });
  const roster = input.validateRosterAuthorization(rosterFile.value, {
    studyId: expectedStudyId,
    candidateCommit: expectedCandidateCommit
  });
  requireValue(
    rosterFile.text === `${JSON.stringify(roster, null, 2)}\n`,
    "calibration label roster authorization file is not canonical producer JSON"
  );

  const selectionFile = readVerifiedJsonFile({
    rootDir,
    file: input.rosterSelectionLedgerPath,
    sha256: input.rosterSelectionLedgerSha256,
    maximumBytes: 4 * 1024 * 1024,
    label: "calibration label roster selection ledger"
  });
  const archivedSelection = validateCalibrationLabelRosterSelectionLedger(
    selectionFile.value,
    {
      rosterAuthorizationSha256: rosterFile.sha256,
      studyId: expectedStudyId,
      candidateCommit: expectedCandidateCommit
    }
  );
  requireValue(
    selectionFile.text ===
      canonicalCalibrationAcquisitionText(archivedSelection),
    "calibration label roster selection ledger is not canonical JSON"
  );

  const expectedAuthorization =
    buildCalibrationAcquisitionAuthorizationFromRoster({
      rosterAuthorization: roster,
      rosterAuthorizationSha256: rosterFile.sha256,
      rosterSelectionLedger: archivedSelection
    });
  const attemptFile = readVerifiedJsonFile({
    rootDir,
    file: input.acquisitionAttemptLedgerPath,
    sha256: input.acquisitionAttemptLedgerSha256,
    maximumBytes: 8 * 1024 * 1024,
    label: "calibration acquisition attempt ledger"
  });
  const archivedAttempts =
    requireEligibleCalibrationAcquisitionAttemptLedger(
      attemptFile.value,
      expectedAuthorization
    );
  requireValue(
    attemptFile.text ===
      canonicalCalibrationAcquisitionText(archivedAttempts.ledger),
    "calibration acquisition attempt ledger is not canonical JSON"
  );
  requireValue(
    archivedAttempts.selectedAttempt.runId > 0,
    "calibration acquisition attempt ledger has no selected attempt"
  );

  const liveRosterRuns = await input.fetchRosterRuns(
    CALIBRATION_ACQUISITION_REPOSITORY
  );
  const liveSelection = await input.buildRosterSelectionSnapshot({
    runs: liveRosterRuns,
    studyId: roster.studyId,
    candidateCommit: roster.candidateCommit,
    caseInputRootSha256:
      roster.authorization.caseInputRootSha256,
    carrierCommit: roster.carrierCommit,
    selectedRunId: archivedSelection.selectedArtifact.runId
  });
  const liveRosterRun = await input.fetchRosterRun({
    repository: CALIBRATION_ACQUISITION_REPOSITORY,
    runId: archivedSelection.selectedArtifact.runId
  });
  const liveRosterArtifacts = await input.fetchRosterArtifacts({
    repository: CALIBRATION_ACQUISITION_REPOSITORY,
    runId: archivedSelection.selectedArtifact.runId,
    artifactName: archivedSelection.selectedArtifact.artifactName
  });
  const liveSelectedArtifact =
    input.validateRosterGithubMetadata({
      studyId: roster.studyId,
      candidateCommit: roster.candidateCommit,
      caseInputRootSha256:
        roster.authorization.caseInputRootSha256,
      carrierCommit: roster.carrierCommit,
      runId: archivedSelection.selectedArtifact.runId,
      runAttempt: archivedSelection.selectedArtifact.runAttempt,
      artifactId: archivedSelection.selectedArtifact.artifactId,
      archiveSha256:
        archivedSelection.selectedArtifact.archiveSha256,
      run: liveRosterRun,
      artifacts: liveRosterArtifacts
    });
  compareCalibrationLabelRosterSelectionLedgers({
    archivedLedger: archivedSelection,
    liveSelection,
    liveSelectedArtifact
  });

  const liveAttempts =
    await verifyArchivedCalibrationAcquisitionAttemptLedgerAgainstGithub({
      archivedLedger: archivedAttempts.ledger,
      expectedAuthorization,
      requestJson: input.requestJson,
      fetchWorkflowRunsPage: input.fetchWorkflowRunsPage,
      fetchRunAttempt: input.fetchRunAttempt
    });
  return {
    repository: CALIBRATION_ACQUISITION_REPOSITORY,
    studyId: expectedStudyId,
    candidateCommit: expectedCandidateCommit,
    rosterAuthorizationSha256: rosterFile.sha256,
    rosterSelectionLedgerSha256: selectionFile.sha256,
    acquisitionAttemptLedgerSha256: attemptFile.sha256,
    rosterRunId: archivedSelection.selectedArtifact.runId,
    acquisitionRunId: liveAttempts.selectedAttempt.runId,
    acquisitionRunAttempt:
      liveAttempts.selectedAttempt.runAttempt
  };
}

export function canonicalCalibrationAcquisitionText(value) {
  return `${JSON.stringify(canonicalJsonValue(value), null, 2)}\n`;
}

export function sha256CalibrationAcquisition(value) {
  return sha256Hex(value);
}

function normalizeCalibrationAcquisitionAttempts(
  value,
  authorization
) {
  requireValue(
    Array.isArray(value) &&
      value.length <= CALIBRATION_ACQUISITION_MAX_TOTAL_ATTEMPTS,
    `calibration acquisition attempts must be an array no larger than ${CALIBRATION_ACQUISITION_MAX_TOTAL_ATTEMPTS}`
  );
  const attempts = value.map((entry, index) =>
    validateNormalizedAcquisitionAttempt(
      entry,
      authorization,
      `calibration acquisition attempt ledger attempts[${index}]`
    )
  );
  attempts.sort(
    (left, right) =>
      left.runId - right.runId || left.runAttempt - right.runAttempt
  );
  const runIds = new Set();
  let priorRunId = null;
  let priorAttempt = 0;
  let stable = null;
  for (const attempt of attempts) {
    if (attempt.runId !== priorRunId) {
      priorRunId = attempt.runId;
      priorAttempt = 0;
      stable = attempt;
      requireValue(
        !runIds.has(attempt.runId),
        "calibration acquisition attempt ledger repeats a non-contiguous run"
      );
      runIds.add(attempt.runId);
    }
    requireValue(
      attempt.runAttempt === priorAttempt + 1,
      `calibration acquisition run ${attempt.runId} attempts must be contiguous from 1`
    );
    for (const key of STABLE_RUN_KEYS) {
      requireValue(
        attempt[key] === stable[key],
        `calibration acquisition run ${attempt.runId} changed stable server field ${key} across attempts`
      );
    }
    if (priorAttempt > 0) {
      const previous = attempts.find(
        (candidate) =>
          candidate.runId === attempt.runId &&
          candidate.runAttempt === priorAttempt
      );
      requireValue(
        previous.status === "completed" &&
          previous.conclusion !== null,
        `calibration acquisition run ${attempt.runId} has a later attempt after an incomplete attempt`
      );
    }
    priorAttempt = attempt.runAttempt;
  }
  requireValue(
    runIds.size <= CALIBRATION_ACQUISITION_MAX_MATCHING_RUNS,
    `calibration acquisition attempt ledger exceeds ${CALIBRATION_ACQUISITION_MAX_MATCHING_RUNS} matching runs`
  );
  return attempts;
}

function normalizeGithubAcquisitionAttempt(raw, authorization, label) {
  requireRecord(raw, label);
  return validateNormalizedAcquisitionAttempt(
    {
      runId: raw.id,
      runAttempt: raw.run_attempt,
      workflowId: raw.workflow_id,
      runNumber: raw.run_number,
      repository: raw.repository?.full_name,
      workflowPath: raw.path,
      displayTitle: raw.display_title,
      event: raw.event,
      headBranch: raw.head_branch,
      headSha: raw.head_sha,
      actor: raw.actor?.login,
      triggeringActor: raw.triggering_actor?.login,
      status: raw.status,
      conclusion: raw.conclusion ?? null,
      createdAt: raw.created_at,
      runStartedAt: raw.run_started_at ?? null,
      updatedAt: raw.updated_at
    },
    authorization,
    label
  );
}

function validateNormalizedAcquisitionAttempt(
  value,
  authorization,
  label
) {
  exactKeys(value, ATTEMPT_KEYS, label);
  const attempt = {
    runId: positiveInteger(value.runId, `${label}.runId`),
    runAttempt: positiveInteger(
      value.runAttempt,
      `${label}.runAttempt`,
      CALIBRATION_ACQUISITION_MAX_RUN_ATTEMPTS
    ),
    workflowId: positiveInteger(
      value.workflowId,
      `${label}.workflowId`
    ),
    runNumber: positiveInteger(value.runNumber, `${label}.runNumber`),
    repository: value.repository,
    workflowPath: value.workflowPath,
    displayTitle: value.displayTitle,
    event: value.event,
    headBranch: value.headBranch,
    headSha: fullSha(value.headSha, `${label}.headSha`),
    actor: githubLogin(value.actor, `${label}.actor`),
    triggeringActor: githubLogin(
      value.triggeringActor,
      `${label}.triggeringActor`
    ),
    status: value.status,
    conclusion: value.conclusion,
    createdAt: actionsInstant(value.createdAt, `${label}.createdAt`),
    runStartedAt:
      value.runStartedAt === null
        ? null
        : actionsInstant(value.runStartedAt, `${label}.runStartedAt`),
    updatedAt: actionsInstant(value.updatedAt, `${label}.updatedAt`)
  };
  requireValue(
    attempt.repository === CALIBRATION_ACQUISITION_REPOSITORY &&
      attempt.workflowPath === CALIBRATION_ACQUISITION_WORKFLOW_PATH &&
      attempt.displayTitle === authorization.runName &&
      attempt.event === "workflow_dispatch" &&
      attempt.headBranch === "main" &&
      attempt.headSha === authorization.roster.headSha,
    `${label} does not match the exact authorized acquisition workflow identity`
  );
  requireValue(
    RUN_STATUSES.has(attempt.status) &&
      ((attempt.status === "completed" &&
        RUN_CONCLUSIONS.has(attempt.conclusion)) ||
        (attempt.status !== "completed" && attempt.conclusion === null)),
    `${label} has an invalid status/conclusion pair`
  );
  requireValue(
    Date.parse(attempt.createdAt) >=
      Date.parse(authorization.roster.artifactCreatedAt) &&
      Date.parse(attempt.updatedAt) >= Date.parse(attempt.createdAt) &&
      (attempt.runStartedAt === null ||
        (Date.parse(attempt.runStartedAt) >=
          Date.parse(attempt.createdAt) &&
          Date.parse(attempt.runStartedAt) <=
            Date.parse(attempt.updatedAt))),
    `${label} server timestamps are reversed or predate the roster authorization artifact`
  );
  return attempt;
}

function validateRosterRunSummary(value, identity, label) {
  exactKeys(value, ROSTER_RUN_KEYS, label);
  const run = {
    runId: positiveInteger(value.runId, `${label}.runId`),
    runAttempt: positiveInteger(
      value.runAttempt,
      `${label}.runAttempt`,
      CALIBRATION_ACQUISITION_MAX_RUN_ATTEMPTS
    ),
    status: value.status,
    conclusion: value.conclusion,
    event: value.event,
    workflowPath: value.workflowPath,
    headBranch: value.headBranch,
    headSha: fullSha(value.headSha, `${label}.headSha`),
    actor: githubLogin(value.actor, `${label}.actor`),
    triggeringActor: githubLogin(
      value.triggeringActor,
      `${label}.triggeringActor`
    ),
    createdAt: actionsInstant(value.createdAt, `${label}.createdAt`),
    runStartedAt: actionsInstant(
      value.runStartedAt,
      `${label}.runStartedAt`
    ),
    updatedAt: actionsInstant(value.updatedAt, `${label}.updatedAt`),
    displayTitle: value.displayTitle
  };
  requireValue(
    RUN_STATUSES.has(run.status) &&
      ((run.status === "completed" &&
        RUN_CONCLUSIONS.has(run.conclusion)) ||
        (run.status !== "completed" && run.conclusion === null)) &&
      run.event === "workflow_dispatch" &&
      run.workflowPath === CALIBRATION_LABEL_ROSTER_WORKFLOW_PATH &&
      run.headBranch === "main" &&
      run.headSha === identity.carrierCommit &&
      run.actor === run.triggeringActor &&
      run.displayTitle === identity.runName &&
      Date.parse(run.runStartedAt) >= Date.parse(run.createdAt) &&
      Date.parse(run.updatedAt) >= Date.parse(run.runStartedAt),
    `${label} is not one exact same-identity governed roster run`
  );
  return run;
}

function validateRosterSelectedArtifact(value, selection) {
  const label = "calibration label roster selected artifact";
  exactKeys(value, ROSTER_ARTIFACT_KEYS, label);
  const artifact = {
    runId: positiveInteger(value.runId, `${label}.runId`),
    runAttempt: positiveInteger(
      value.runAttempt,
      `${label}.runAttempt`,
      CALIBRATION_ACQUISITION_MAX_RUN_ATTEMPTS
    ),
    headSha: fullSha(value.headSha, `${label}.headSha`),
    actor: githubLogin(value.actor, `${label}.actor`),
    triggeringActor: githubLogin(
      value.triggeringActor,
      `${label}.triggeringActor`
    ),
    runName: value.runName,
    runStatus: value.runStatus,
    runConclusion: value.runConclusion,
    runStartedAt: actionsInstant(
      value.runStartedAt,
      `${label}.runStartedAt`
    ),
    runUpdatedAt: actionsInstant(
      value.runUpdatedAt,
      `${label}.runUpdatedAt`
    ),
    runCompletedAt: actionsInstant(
      value.runCompletedAt,
      `${label}.runCompletedAt`
    ),
    artifactId: positiveInteger(value.artifactId, `${label}.artifactId`),
    artifactName: value.artifactName,
    archiveSha256: digest(
      value.archiveSha256,
      `${label}.archiveSha256`
    ),
    archiveBytes: positiveInteger(
      value.archiveBytes,
      `${label}.archiveBytes`,
      64 * 1024 * 1024
    ),
    artifactCreatedAt: actionsInstant(
      value.artifactCreatedAt,
      `${label}.artifactCreatedAt`
    ),
    artifactExpiresAt: actionsInstant(
      value.artifactExpiresAt,
      `${label}.artifactExpiresAt`
    )
  };
  const run = selection.selectedRun;
  const expectedName =
    `site-behavior-calibration-label-roster-${selection.identity.studyId}-` +
    `${run.runId}-${run.runAttempt}`;
  requireValue(
    artifact.runId === run.runId &&
      artifact.runAttempt === run.runAttempt &&
      artifact.headSha === run.headSha &&
      artifact.actor === run.actor &&
      artifact.triggeringActor === run.triggeringActor &&
      artifact.runName === selection.identity.runName &&
      artifact.runStatus === run.status &&
      artifact.runConclusion === run.conclusion &&
      artifact.runStartedAt === run.runStartedAt &&
      artifact.runUpdatedAt === run.updatedAt &&
      artifact.runCompletedAt === run.updatedAt &&
      artifact.artifactName === expectedName &&
      Date.parse(artifact.artifactCreatedAt) >=
        Date.parse(artifact.runStartedAt) &&
      Date.parse(artifact.artifactCreatedAt) <=
        Date.parse(artifact.runCompletedAt) &&
      Date.parse(artifact.artifactExpiresAt) >
        Date.parse(artifact.artifactCreatedAt),
    "calibration label roster selected artifact does not bind the sole terminal server run and chronology"
  );
  return artifact;
}

function normalizeJsonResponse(value, label) {
  if (Buffer.isBuffer(value) || typeof value === "string") {
    let text;
    try {
      text = Buffer.isBuffer(value)
        ? new TextDecoder("utf-8", {
            fatal: true,
            ignoreBOM: true
          }).decode(value)
        : value;
      requireValue(
        Buffer.byteLength(text) <= 4 * 1024 * 1024,
        `${label} exceeds the 4 MiB JSON bound`
      );
      return JSON.parse(text);
    } catch (error) {
      if (error instanceof Error && /4 MiB/.test(error.message)) throw error;
      throw new Error(`${label} is not valid bounded JSON`);
    }
  }
  requireValue(
    Buffer.byteLength(JSON.stringify(value)) <= 4 * 1024 * 1024,
    `${label} exceeds the 4 MiB JSON bound`
  );
  return value;
}

function readVerifiedJsonFile({
  rootDir,
  file,
  sha256,
  maximumBytes,
  label
}) {
  const expectedSha256 = digest(sha256, `${label} expected digest`);
  requireValue(
    typeof file === "string" &&
      file.length >= 1 &&
      file.length <= 4096 &&
      !file.includes("\u0000"),
    `${label} path is invalid`
  );
  const absolute = path.isAbsolute(file)
    ? path.resolve(file)
    : path.resolve(rootDir, file);
  const relative = path.relative(rootDir, absolute);
  requireValue(
    relative !== "" &&
      !relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative),
    `${label} must remain inside the repository root`
  );
  const parent = path.dirname(absolute);
  requireValue(
    realpathSync(parent) === parent,
    `${label} parent path may not traverse a symbolic link`
  );
  let descriptor;
  try {
    descriptor = openSync(
      absolute,
      fsConstants.O_RDONLY |
        (fsConstants.O_NOFOLLOW ?? 0)
    );
    const before = fstatSync(descriptor);
    requireValue(
      before.isFile() &&
        before.size > 0 &&
        before.size <= maximumBytes,
      `${label} must be one bounded regular file`
    );
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    requireValue(
      before.dev === after.dev &&
        before.ino === after.ino &&
        before.size === after.size &&
        bytes.byteLength === before.size,
      `${label} changed while it was read`
    );
    const observedSha256 = sha256Hex(bytes);
    requireValue(
      observedSha256 === expectedSha256,
      `${label} bytes do not match the declared digest`
    );
    let text;
    try {
      text = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true
      }).decode(bytes);
    } catch {
      throw new Error(`${label} is not valid UTF-8`);
    }
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      throw new Error(`${label} is not valid JSON`);
    }
    requireRecord(value, label);
    return {
      absolute,
      relative: relative.split(path.sep).join("/"),
      text,
      value,
      sha256: observedSha256
    };
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

// Roster-selection snapshot digests are produced with the shared canonical
// serializer (lib/canonical-json.ts); verification must reproduce those exact
// bytes, so the local equality serializer below must never feed that digest.
function sharedCanonicalJson(value) {
  if (sharedCanonicalSerializer === undefined) {
    for (const candidate of [
      "../dist/schema/lib/canonical-json.js",
      "../.unit-test-dist/lib/canonical-json.js"
    ]) {
      try {
        const loaded = requireFromHere(candidate);
        if (typeof loaded.canonicalJson === "function") {
          sharedCanonicalSerializer = loaded.canonicalJson;
          break;
        }
      } catch {
        // Workflows compile tsconfig.schema.json before verification; the
        // unit lane compiles the same source into .unit-test-dist.
      }
    }
    if (sharedCanonicalSerializer === undefined) {
      throw new Error(
        "the shared canonical JSON module is unavailable; compile tsconfig.schema.json first"
      );
    }
  }
  return sharedCanonicalSerializer(value);
}

function canonicalCompactJson(value) {
  return JSON.stringify(canonicalJsonValue(value));
}

function canonicalJsonValue(value, path = "$") {
  if (value === null) return null;
  if (typeof value === "string") return value.normalize("NFC");
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    requireValue(
      Number.isFinite(value),
      `calibration acquisition canonical JSON rejects non-finite number at ${path}`
    );
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => {
      requireValue(
        entry !== undefined,
        `calibration acquisition canonical JSON rejects undefined at ${path}[${index}]`
      );
      return canonicalJsonValue(entry, `${path}[${index}]`);
    });
  }
  requireRecord(
    value,
    `calibration acquisition canonical JSON value at ${path}`
  );
  const normalizedKeys = new Set();
  return Object.fromEntries(
    Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => {
        const normalized = key.normalize("NFC");
        requireValue(
          !normalizedKeys.has(normalized),
          `calibration acquisition canonical JSON repeats normalized key ${normalized} at ${path}`
        );
        normalizedKeys.add(normalized);
        return [
          normalized,
          canonicalJsonValue(value[key], `${path}.${normalized}`)
        ];
      })
  );
}

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function exactKeys(value, expected, label) {
  requireRecord(value, label);
  requireValue(
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify([...expected].sort()),
    `${label} must contain exactly ${[...expected].sort().join(", ")}`
  );
}

function requireRecord(value, label) {
  requireValue(
    typeof value === "object" && value !== null && !Array.isArray(value),
    `${label} must be an object`
  );
}

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function positiveInteger(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  requireValue(
    Number.isSafeInteger(value) && value > 0 && value <= maximum,
    `${label} must be a positive safe integer no greater than ${maximum}`
  );
  return value;
}

function digest(value, label) {
  requireValue(
    typeof value === "string" && SHA256.test(value),
    `${label} must be one lowercase sha256 digest`
  );
  return value;
}

function fullSha(value, label) {
  requireValue(
    typeof value === "string" && FULL_SHA.test(value),
    `${label} must be one full lowercase Git commit`
  );
  return value;
}

function token(value, label) {
  requireValue(
    typeof value === "string" && TOKEN.test(value),
    `${label} must be one lowercase token`
  );
  return value;
}

function githubLogin(value, label) {
  const normalized =
    typeof value === "string" ? value.toLowerCase() : "";
  requireValue(
    LOGIN.test(normalized),
    `${label} must be one GitHub login`
  );
  return normalized;
}

function actionsInstant(value, label) {
  requireValue(
    typeof value === "string" &&
      ACTIONS_INSTANT.test(value) &&
      Number.isFinite(Date.parse(value)),
    `${label} must be one GitHub Actions UTC instant`
  );
  return new Date(value).toISOString();
}
