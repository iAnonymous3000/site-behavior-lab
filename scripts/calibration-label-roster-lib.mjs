import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  CALIBRATION_LABEL_SEALING_ALGORITHM,
  CALIBRATION_LABEL_WORKFLOW_PATH,
  canonicalPrettyJson,
  canonicalizeCalibrationValue,
  sha256Hex,
  validateCalibrationLabelCommitment
} from "./calibration-study-lib.mjs";
import { readCalibrationSingleJsonArtifact } from "./calibration-study-archive-lib.mjs";

export const CALIBRATION_LABEL_ROSTER_AUTHORIZATION_KIND =
  "site-behavior-detector-calibration-label-roster-authorization";
export const CALIBRATION_LABEL_ROSTER_WORKFLOW_PATH =
  ".github/workflows/calibration-label-roster.yml";
export const CALIBRATION_ACQUISITION_WORKFLOW_PATH =
  ".github/workflows/calibration-study.yml";
export const CALIBRATION_LABEL_ROSTER_SELECTION_KIND =
  "site-behavior-detector-calibration-label-roster-selection";

const REPOSITORY = "iAnonymous3000/site-behavior-lab";
const CASE_INPUT_ROOT_DIGEST_DOMAIN =
  "site-behavior-calibration-case-input-root-v1";
const ROSTER_SELECTION_DIGEST_DOMAIN =
  "site-behavior-calibration-label-roster-selection-v1";
const RUN_NAME_PREFIX = "calibration-label-roster:";
const FULL_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const TOKEN = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const LOGIN = /^(?!-)(?!.*--)[A-Za-z0-9-]{1,39}(?<!-)$/;
const MAX_COMMITMENTS = 11;
const MAX_ROSTER_ARCHIVE_BYTES = 64 * 1024 * 1024;

export function calibrationCaseInputRootSha256(caseInputRoot) {
  const root = opaqueAbsolutePath(caseInputRoot, "case input root");
  return sha256Hex(`${CASE_INPUT_ROOT_DIGEST_DOMAIN}\u0000${root}`);
}

export function calibrationLabelRosterRunName(identity) {
  const studyId = token(identity?.studyId, "roster run studyId");
  const candidateCommit = fullSha(
    identity?.candidateCommit,
    "roster run candidateCommit"
  );
  return `${RUN_NAME_PREFIX}${studyId}:${candidateCommit}`;
}

export function parseCalibrationLabelRosterRunName(value) {
  if (typeof value !== "string" || !value.startsWith(RUN_NAME_PREFIX)) {
    return null;
  }
  const suffix = value.slice(RUN_NAME_PREFIX.length);
  const firstSeparator = suffix.indexOf(":");
  if (
    firstSeparator <= 0 ||
    suffix.indexOf(":", firstSeparator + 1) !== -1
  ) {
    return null;
  }
  const parsed = {
    studyId: suffix.slice(0, firstSeparator),
    candidateCommit: suffix.slice(firstSeparator + 1)
  };
  try {
    return {
      ...parsed,
      runName: calibrationLabelRosterRunName(parsed)
    };
  } catch {
    return null;
  }
}

export function calibrationLabelRosterArtifactName(
  studyId,
  runId,
  runAttempt
) {
  return (
    `site-behavior-calibration-label-roster-${token(studyId, "studyId")}-` +
    `${positiveInteger(runId, "run id")}-` +
    `${boundedRunAttempt(runAttempt, "run attempt")}`
  );
}

export function calibrationLabelRosterWorkflowPath(value) {
  if (
    value === CALIBRATION_LABEL_ROSTER_WORKFLOW_PATH ||
    value === `${CALIBRATION_LABEL_ROSTER_WORKFLOW_PATH}@main`
  ) {
    return CALIBRATION_LABEL_ROSTER_WORKFLOW_PATH;
  }
  throw new Error(
    "roster run path must identify the governed workflow on main"
  );
}

export function authenticatedCalibrationCommitmentSummaries(input) {
  requireRecord(input?.candidate, "validated calibration candidate");
  const candidateCommit = fullSha(
    input.candidateCommit,
    "roster candidateCommit"
  );
  const entries = input.commitments;
  if (
    !Array.isArray(entries) ||
    entries.length < 3 ||
    entries.length > MAX_COMMITMENTS
  ) {
    throw new Error(
      "roster commitments must contain 2 through 10 labelers and one tiebreaker"
    );
  }

  const actors = new Set();
  const sourceCommitments = new Set();
  const envelopeCommitments = new Set();
  const ciphertextCommitments = new Set();
  const authenticatedCommitments = [];
  let priorCoordinate = "";

  for (const [index, entry] of entries.entries()) {
    const label = `roster commitments[${index}]`;
    exactKeys(entry, ["coordinate", "metadata", "commitment", "text"], label);
    const coordinate = coordinateObject(entry.coordinate, `${label}.coordinate`);
    const metadata = commitmentMetadataObject(
      entry.metadata,
      `${label}.metadata`
    );
    const commitment = validateCalibrationLabelCommitment(
      entry.commitment,
      input.candidate,
      candidateCommit
    );
    if (entry.text !== canonicalPrettyJson(entry.commitment)) {
      throw new Error(`${label} commitment bytes are not canonical`);
    }

    const coordinateKey = sortableCoordinate(coordinate);
    if (coordinateKey.localeCompare(priorCoordinate) <= 0) {
      throw new Error(
        "roster commitments must be unique and canonically sorted"
      );
    }
    priorCoordinate = coordinateKey;

    const expectedArtifactName =
      `site-behavior-calibration-label-commitment-${coordinate.role}-` +
      `${input.candidate.studyId}-${coordinate.runId}-${coordinate.runAttempt}`;
    const producer = commitment.producer;
    if (
      coordinate.role !== metadata.role ||
      coordinate.role !== commitment.role ||
      coordinate.runId !== metadata.runId ||
      coordinate.runId !== producer.runId ||
      coordinate.runAttempt !== metadata.runAttempt ||
      coordinate.runAttempt !== producer.runAttempt ||
      coordinate.artifactId !== metadata.artifactId ||
      coordinate.archiveSha256 !== metadata.archiveSha256 ||
      metadata.artifactName !== expectedArtifactName ||
      metadata.headSha !== producer.headSha ||
      metadata.actor !== producer.actor ||
      metadata.triggeringActor !== producer.triggeringActor ||
      metadata.actor !== metadata.triggeringActor ||
      commitment.studyId !== input.candidate.studyId ||
      commitment.detector !== input.candidate.detector ||
      commitment.candidateCommit !== candidateCommit ||
      commitment.keyId !== input.candidate.labelSealingKey.keyId ||
      commitment.envelope.algorithm !==
        input.candidate.labelSealingKey.algorithm ||
      producer.repository !== REPOSITORY ||
      producer.workflowPath !== CALIBRATION_LABEL_WORKFLOW_PATH ||
      producer.workflowRef !== "refs/heads/main" ||
      Date.parse(metadata.runCompletedAt) <
        Date.parse(metadata.runStartedAt) ||
      Date.parse(metadata.artifactCreatedAt) <
        Date.parse(metadata.runStartedAt) ||
      Date.parse(metadata.artifactCreatedAt) >
        Date.parse(metadata.runCompletedAt) ||
      Date.parse(metadata.artifactExpiresAt) <=
        Date.parse(metadata.artifactCreatedAt)
    ) {
      throw new Error(
        `${label} disagrees with authenticated producer, artifact, or candidate identity`
      );
    }

    const sourceCommitment = canonicalizeCalibrationValue(commitment.source);
    const envelopeCommitment = commitment.envelopeSha256;
    const ciphertextCommitment = sha256Hex(
      [
        commitment.envelope.encryptedKey,
        commitment.envelope.iv,
        commitment.envelope.ciphertext,
        commitment.envelope.authTag
      ].join("\u0000")
    );
    if (
      actors.has(metadata.actor) ||
      sourceCommitments.has(sourceCommitment) ||
      envelopeCommitments.has(envelopeCommitment) ||
      ciphertextCommitments.has(ciphertextCommitment)
    ) {
      throw new Error(
        "roster commitments require distinct actors, sources, envelopes, and ciphertexts"
      );
    }
    actors.add(metadata.actor);
    sourceCommitments.add(sourceCommitment);
    envelopeCommitments.add(envelopeCommitment);
    ciphertextCommitments.add(ciphertextCommitment);

    authenticatedCommitments.push({
      role: commitment.role,
      actor: metadata.actor,
      runId: metadata.runId,
      runAttempt: metadata.runAttempt,
      headSha: metadata.headSha,
      artifactId: metadata.artifactId,
      artifactName: metadata.artifactName,
      archiveSha256: metadata.archiveSha256,
      createdAt: metadata.artifactCreatedAt,
      source: commitment.source,
      algorithm: commitment.envelope.algorithm,
      keyId: commitment.keyId,
      envelopeSha256: commitment.envelopeSha256,
      ciphertextSha256: ciphertextCommitment
    });
  }

  enforceCommitmentRoles(authenticatedCommitments);
  return {
    authenticatedCommitments,
    commitmentSetSha256: sha256Hex(
      canonicalizeCalibrationValue(authenticatedCommitments)
    )
  };
}

export function createCalibrationLabelRosterAuthorization(input) {
  requireRecord(input?.candidate, "validated calibration candidate");
  const candidateCommit = fullSha(
    input.candidateCommit,
    "roster candidateCommit"
  );
  const carrierCommit = fullSha(
    input.carrierCommit,
    "roster carrierCommit"
  );
  const labelSealingKey = labelSealingKeyObject(
    input.candidate.labelSealingKey,
    input.candidate.studyId
  );
  const source = sourceProvenanceObject(
    input.source,
    "roster coordinate source"
  );
  const producer = rosterProducerObject(input.producer);
  const authorization = rosterAuthorizationObject(input.authorization);
  const {
    authenticatedCommitments,
    commitmentSetSha256
  } = authenticatedCalibrationCommitmentSummaries({
    candidate: input.candidate,
    candidateCommit,
    commitments: input.commitments
  });
  const roster = {
    schemaVersion: 1,
    artifactKind: CALIBRATION_LABEL_ROSTER_AUTHORIZATION_KIND,
    studyId: token(input.candidate.studyId, "roster studyId"),
    detector: detector(input.candidate.detector, "roster detector"),
    candidateCommit,
    carrierCommit,
    labelSealingKey,
    source,
    producer,
    authorization,
    authenticatedCommitments,
    commitmentSetSha256
  };
  const normalized = validateCalibrationLabelRosterAuthorization(roster, {
    studyId: input.candidate.studyId,
    detector: input.candidate.detector,
    candidateCommit,
    carrierCommit,
    labelSealingKey,
    producer,
    authorization,
    source
  });
  const text = canonicalPrettyJson(normalized);
  return {
    roster: normalized,
    text,
    sha256: sha256Hex(text),
    runName: calibrationLabelRosterRunName({
      studyId: normalized.studyId,
      candidateCommit: normalized.candidateCommit,
      caseInputRootSha256:
        normalized.authorization.caseInputRootSha256
    })
  };
}

export function validateCalibrationLabelRosterAuthorization(
  value,
  expected = {}
) {
  exactKeys(
    value,
    [
      "schemaVersion",
      "artifactKind",
      "studyId",
      "detector",
      "candidateCommit",
      "carrierCommit",
      "labelSealingKey",
      "source",
      "producer",
      "authorization",
      "authenticatedCommitments",
      "commitmentSetSha256"
    ],
    "calibration label roster authorization"
  );
  if (
    value.schemaVersion !== 1 ||
    value.artifactKind !== CALIBRATION_LABEL_ROSTER_AUTHORIZATION_KIND
  ) {
    throw new Error("calibration label roster authorization identity is invalid");
  }
  const studyId = token(value.studyId, "roster studyId");
  const normalized = {
    schemaVersion: 1,
    artifactKind: CALIBRATION_LABEL_ROSTER_AUTHORIZATION_KIND,
    studyId,
    detector: detector(value.detector, "roster detector"),
    candidateCommit: fullSha(
      value.candidateCommit,
      "roster candidateCommit"
    ),
    carrierCommit: fullSha(
      value.carrierCommit,
      "roster carrierCommit"
    ),
    labelSealingKey: labelSealingKeyObject(
      value.labelSealingKey,
      studyId
    ),
    source: sourceProvenanceObject(
      value.source,
      "roster coordinate source"
    ),
    producer: rosterProducerObject(value.producer),
    authorization: rosterAuthorizationObject(value.authorization),
    authenticatedCommitments: commitmentSummaryArray(
      value.authenticatedCommitments,
      {
        studyId,
        candidateCommit: value.candidateCommit,
        keyId: value.labelSealingKey?.keyId
      }
    ),
    commitmentSetSha256: digest(
      value.commitmentSetSha256,
      "roster commitmentSetSha256"
    )
  };
  const calculatedSetSha256 = sha256Hex(
    canonicalizeCalibrationValue(normalized.authenticatedCommitments)
  );
  if (normalized.commitmentSetSha256 !== calculatedSetSha256) {
    throw new Error("roster commitment-set digest is invalid");
  }
  if (
    normalized.producer.headSha !== normalized.carrierCommit ||
    normalized.source.commit !== normalized.carrierCommit ||
    normalized.source.path !==
      `calibration-labels/${normalized.studyId}/sources.json`
  ) {
    throw new Error(
      "roster producer head and fixed coordinate source must equal the evidence-only carrier commit"
    );
  }
  compareExpected(normalized, expected);
  return normalized;
}

export function calibrationLabelRosterRunsForIdentity(runs, identity) {
  if (!Array.isArray(runs)) {
    throw new Error("calibration roster Actions runs must be an array");
  }
  const runName = calibrationLabelRosterRunName(identity);
  return runs
    .filter(
      (run) =>
        isRecord(run) &&
        run.display_title === runName &&
        isCalibrationLabelRosterWorkflowPath(run.path)
    )
    .map((run, index) =>
      normalizedRosterRunSummary(
        run,
        `calibration roster Actions runs[${index}]`
      )
    )
    .sort(
      (left, right) =>
        left.runStartedAt.localeCompare(right.runStartedAt) ||
        left.runId - right.runId
    );
}

export function calibrationLabelRosterRunSelectionSnapshot(input) {
  const identity = {
    studyId: token(input.studyId, "roster selection studyId"),
    candidateCommit: fullSha(
      input.candidateCommit,
      "roster selection candidateCommit"
    ),
    carrierCommit: fullSha(
      input.carrierCommit,
      "roster selection carrierCommit"
    ),
    caseInputRootSha256: digest(
      input.caseInputRootSha256,
      "roster selection caseInputRootSha256"
    )
  };
  const normalizedIdentity = {
    ...identity,
    runName: calibrationLabelRosterRunName(identity)
  };
  const runs = calibrationLabelRosterRunsForIdentity(
    input.runs,
    normalizedIdentity
  );
  const selectedRunId = positiveInteger(
    input.selectedRunId,
    "selected roster run id"
  );
  const selected = runs.filter((run) => run.runId === selectedRunId);
  if (runs.length !== 1 || selected.length !== 1) {
    throw new Error(
      "exactly one server-visible roster run may exist for this frozen study and candidate"
    );
  }
  const selectedRun = selected[0];
  if (selectedRun.headSha !== identity.carrierCommit) {
    throw new Error(
      "the unique roster run head must equal the evidence-only carrier"
    );
  }
  const allowedInProgress =
    input.allowInProgress === true &&
    selectedRun.status === "in_progress" &&
    selectedRun.conclusion === null;
  if (
    selectedRun.runAttempt !== 1 ||
    (selectedRun.status !== "completed" && !allowedInProgress) ||
    (selectedRun.status === "completed" &&
      selectedRun.conclusion !== "success")
  ) {
    throw new Error(
      "the unique roster authorization must be attempt 1 and successful, or its dispatch parent must still be in progress"
    );
  }
  const snapshotCore = {
    schemaVersion: 1,
    artifactKind: CALIBRATION_LABEL_ROSTER_SELECTION_KIND,
    identity: normalizedIdentity,
    selectedRun,
    runs
  };
  return {
    ...snapshotCore,
    snapshotSha256: sha256Hex(
      `${ROSTER_SELECTION_DIGEST_DOMAIN}\u0000` +
        canonicalizeCalibrationValue(snapshotCore)
    )
  };
}

export function assertUniqueCalibrationLabelRosterRun(input) {
  return calibrationLabelRosterRunSelectionSnapshot(input);
}

export function validateCalibrationLabelRosterRunSelectionSnapshot(
  value,
  expected = {}
) {
  exactKeys(
    value,
    [
      "schemaVersion",
      "artifactKind",
      "identity",
      "selectedRun",
      "runs",
      "snapshotSha256"
    ],
    "calibration label roster selection snapshot"
  );
  if (
    value.schemaVersion !== 1 ||
    value.artifactKind !== CALIBRATION_LABEL_ROSTER_SELECTION_KIND
  ) {
    throw new Error("calibration label roster selection identity is invalid");
  }
  exactKeys(
    value.identity,
    [
      "studyId",
      "candidateCommit",
      "carrierCommit",
      "caseInputRootSha256",
      "runName"
    ],
    "calibration label roster selection identity"
  );
  const identity = {
    studyId: token(
      value.identity.studyId,
      "roster selection identity studyId"
    ),
    candidateCommit: fullSha(
      value.identity.candidateCommit,
      "roster selection identity candidateCommit"
    ),
    carrierCommit: fullSha(
      value.identity.carrierCommit,
      "roster selection identity carrierCommit"
    ),
    caseInputRootSha256: digest(
      value.identity.caseInputRootSha256,
      "roster selection identity caseInputRootSha256"
    ),
    runName: boundedText(
      value.identity.runName,
      "roster selection identity runName",
      300
    )
  };
  if (identity.runName !== calibrationLabelRosterRunName(identity)) {
    throw new Error("roster selection runName is not its deterministic identity");
  }
  if (!Array.isArray(value.runs) || value.runs.length !== 1) {
    throw new Error(
      "roster selection must preserve exactly one same-identity server run"
    );
  }
  const runs = value.runs.map((run, index) =>
    rosterRunSummaryObject(run, `roster selection runs[${index}]`)
  );
  const selectedRun = rosterRunSummaryObject(
    value.selectedRun,
    "roster selection selectedRun"
  );
  if (
    canonicalizeCalibrationValue(selectedRun) !==
      canonicalizeCalibrationValue(runs[0]) ||
    selectedRun.displayTitle !== identity.runName ||
    selectedRun.headSha !== identity.carrierCommit ||
    selectedRun.runAttempt !== 1 ||
    selectedRun.workflowPath !== CALIBRATION_LABEL_ROSTER_WORKFLOW_PATH
  ) {
    throw new Error(
      "roster selection selectedRun must equal the sole attempt-1 identity run"
    );
  }
  const allowsInProgress =
    expected.allowInProgress === true &&
    selectedRun.status === "in_progress" &&
    selectedRun.conclusion === null;
  if (
    !allowsInProgress &&
    (selectedRun.status !== "completed" ||
      selectedRun.conclusion !== "success")
  ) {
    throw new Error(
      "archived roster selection requires a terminal successful roster run"
    );
  }
  const core = {
    schemaVersion: 1,
    artifactKind: CALIBRATION_LABEL_ROSTER_SELECTION_KIND,
    identity,
    selectedRun,
    runs
  };
  const snapshotSha256 = digest(
    value.snapshotSha256,
    "roster selection snapshotSha256"
  );
  const calculated = sha256Hex(
    `${ROSTER_SELECTION_DIGEST_DOMAIN}\u0000` +
      canonicalizeCalibrationValue(core)
  );
  if (snapshotSha256 !== calculated) {
    throw new Error("roster selection snapshot digest is invalid");
  }
  for (const field of [
    "studyId",
    "candidateCommit",
    "carrierCommit",
    "caseInputRootSha256"
  ]) {
    if (
      expected[field] !== undefined &&
      identity[field] !== expected[field]
    ) {
      throw new Error(
        `roster selection ${field} does not match the expected identity`
      );
    }
  }
  if (
    expected.selectedRunId !== undefined &&
    selectedRun.runId !== expected.selectedRunId
  ) {
    throw new Error(
      "roster selection selectedRun does not match the expected run id"
    );
  }
  return { ...core, snapshotSha256 };
}

// REMOVED: verifyLiveCalibrationLabelRosterRunSelection and its
// compareCalibrationLabelRosterRunSelectionSnapshots helper. Nothing could
// enter that path -- the only tracked reference to the composer was its own
// declaration -- and the live-drift check it performed is independently
// implemented and actually wired as compareCalibrationLabelRosterSelectionLedgers
// in calibration-acquisition-authorization-lib.mjs. Two implementations of one
// check, one of them unreachable, is the shape this repo has already removed
// twice; see the NOTE in lib/durable-scan-job-store.ts on why a contract that
// looks authoritative while pinning nothing is left as a trap otherwise.

export async function waitForTerminalCalibrationLabelRosterRun(input) {
  const runId = positiveInteger(input.runId, "roster run id");
  const timeoutMs = boundedMilliseconds(
    input.timeoutMs ?? 10 * 60 * 1000,
    "roster terminal poll timeout",
    1_000,
    30 * 60 * 1000
  );
  const pollIntervalMs = boundedMilliseconds(
    input.pollIntervalMs ?? 2_000,
    "roster terminal poll interval",
    250,
    30_000
  );
  const fetchRun =
    input.fetchRun ??
    (() => ghJson(`repos/${REPOSITORY}/actions/runs/${runId}`));
  const wait =
    input.wait ??
    ((milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const run = await fetchRun(runId);
    const summary = normalizedRosterRunSummary(
      run,
      "polled calibration roster run"
    );
    if (
      summary.runId !== runId ||
      summary.displayTitle !==
        calibrationLabelRosterRunName({
          studyId: input.studyId,
          candidateCommit: input.candidateCommit,
          caseInputRootSha256: input.caseInputRootSha256
        }) ||
      summary.runAttempt !== 1 ||
      summary.headSha !== input.carrierCommit
    ) {
      throw new Error(
        "polled roster run does not match the attempt-1 authorization identity"
      );
    }
    if (summary.status === "completed") {
      if (summary.conclusion !== "success") {
        throw new Error(
          `roster authorization completed as ${summary.conclusion}`
        );
      }
      return run;
    }
    if (
      !["queued", "in_progress", "pending", "requested", "waiting"].includes(
        summary.status
      )
    ) {
      throw new Error(`roster authorization has unexpected ${summary.status} status`);
    }
    if (Date.now() + pollIntervalMs > deadline) {
      throw new Error("timed out waiting for roster authorization to succeed");
    }
    await wait(pollIntervalMs);
  }
}

export function validateCalibrationLabelRosterGithubMetadata(input) {
  const runId = positiveInteger(input.runId, "roster run id");
  const runAttempt = boundedRunAttempt(
    input.runAttempt,
    "roster run attempt"
  );
  const artifactId = positiveInteger(input.artifactId, "roster artifact id");
  const archiveSha256 = normalizedDigest(
    input.archiveSha256,
    "roster archive digest"
  );
  const runName = calibrationLabelRosterRunName({
    studyId: input.studyId,
    candidateCommit: input.candidateCommit,
    caseInputRootSha256: input.caseInputRootSha256
  });
  const run = input.run;
  requireRecord(run, "calibration roster Actions run");
  const actor = githubLogin(run.actor?.login, "roster run actor");
  const triggeringActor = githubLogin(
    run.triggering_actor?.login,
    "roster run triggering actor"
  );
  const runStartedAt = instant(
    run.run_started_at,
    "roster run started_at"
  );
  const runUpdatedAt = instant(run.updated_at, "roster run updated_at");
  const isInProgress =
    input.allowInProgress === true &&
    run.status === "in_progress" &&
    run.conclusion === null;
  if (
    run.id !== runId ||
    run.run_attempt !== runAttempt ||
    runAttempt !== 1 ||
    run.event !== "workflow_dispatch" ||
    !isCalibrationLabelRosterWorkflowPath(run.path) ||
    run.head_branch !== "main" ||
    !FULL_SHA.test(run.head_sha) ||
    run.head_sha !== input.carrierCommit ||
    run.repository?.full_name !== REPOSITORY ||
    run.display_title !== runName ||
    actor !== triggeringActor ||
    (!isInProgress &&
      (run.status !== "completed" || run.conclusion !== "success")) ||
    Date.parse(runUpdatedAt) < Date.parse(runStartedAt)
  ) {
    throw new Error(
      "roster run is not the unique non-delegated attempt-1 main-branch authorization producer"
    );
  }

  const artifactName = calibrationLabelRosterArtifactName(
    input.studyId,
    runId,
    runAttempt
  );
  const page = input.artifacts;
  requireRecord(page, "calibration roster artifact metadata");
  if (
    !Number.isSafeInteger(page.total_count) ||
    !Array.isArray(page.artifacts) ||
    page.total_count !== page.artifacts.length ||
    page.artifacts.length > 100
  ) {
    throw new Error("calibration roster artifact metadata is malformed or paginated");
  }
  const matches = page.artifacts.filter(
    (artifact) =>
      artifact?.id === artifactId && artifact?.name === artifactName
  );
  if (matches.length !== 1) {
    throw new Error(
      "calibration roster metadata did not identify exactly one artifact"
    );
  }
  const artifact = matches[0];
  const archiveBytes = positiveInteger(
    artifact.size_in_bytes,
    "roster artifact bytes"
  );
  const artifactCreatedAt = instant(
    artifact.created_at,
    "roster artifact created_at"
  );
  const artifactExpiresAt = instant(
    artifact.expires_at,
    "roster artifact expires_at"
  );
  if (
    artifact.expired !== false ||
    archiveBytes > MAX_ROSTER_ARCHIVE_BYTES ||
    artifact.workflow_run?.id !== runId ||
    artifact.workflow_run?.head_sha !== run.head_sha ||
    normalizedDigest(artifact.digest, "roster server artifact digest") !==
      archiveSha256 ||
    Date.parse(artifactCreatedAt) < Date.parse(runStartedAt) ||
    (!isInProgress &&
      Date.parse(artifactCreatedAt) > Date.parse(runUpdatedAt)) ||
    Date.parse(artifactExpiresAt) <= Date.parse(artifactCreatedAt)
  ) {
    throw new Error(
      "roster artifact does not bind the authenticated run, digest, and server chronology"
    );
  }
  return {
    runId,
    runAttempt,
    headSha: run.head_sha,
    actor,
    triggeringActor,
    runName,
    runStatus: run.status,
    runConclusion: run.conclusion,
    runStartedAt,
    runUpdatedAt,
    runCompletedAt: isInProgress ? null : runUpdatedAt,
    artifactId,
    artifactName,
    archiveSha256,
    archiveBytes,
    artifactCreatedAt,
    artifactExpiresAt
  };
}

export function fetchCalibrationLabelRosterRuns(
  repository = REPOSITORY
) {
  if (repository !== REPOSITORY) {
    throw new Error("calibration roster runs must come from the governed repository");
  }
  const pages = ghJson(
    `repos/${repository}/actions/workflows/calibration-label-roster.yml/runs?branch=main&event=workflow_dispatch&per_page=100`,
    ["--paginate", "--slurp"]
  );
  if (!Array.isArray(pages) || pages.length < 1) {
    throw new Error("calibration roster run enumeration returned no pages");
  }
  const runs = [];
  const ids = new Set();
  for (const [index, page] of pages.entries()) {
    requireRecord(page, `calibration roster run page[${index}]`);
    if (!Array.isArray(page.workflow_runs)) {
      throw new Error(
        `calibration roster run page[${index}] is missing workflow_runs`
      );
    }
    for (const run of page.workflow_runs) {
      if (!Number.isSafeInteger(run?.id) || ids.has(run.id)) {
        throw new Error("calibration roster run enumeration repeats an invalid run");
      }
      ids.add(run.id);
      runs.push(run);
    }
  }
  if (runs.length > 100_000) {
    throw new Error("calibration roster run enumeration exceeds the review bound");
  }
  return runs;
}

export function fetchAuthenticatedCalibrationLabelRoster(input) {
  if ((input.repository ?? REPOSITORY) !== REPOSITORY) {
    throw new Error("calibration roster must come from the governed repository");
  }
  const repository = REPOSITORY;
  const run =
    input.run ??
    ghJson(
      `repos/${repository}/actions/runs/${positiveInteger(input.runId, "roster run id")}`
    );
  const artifactName = calibrationLabelRosterArtifactName(
    input.studyId,
    input.runId,
    input.runAttempt
  );
  const artifacts = ghJson(
    `repos/${repository}/actions/runs/${input.runId}/artifacts`,
    ["-f", `name=${artifactName}`, "-f", "per_page=100"]
  );
  const metadata = validateCalibrationLabelRosterGithubMetadata({
    ...input,
    run,
    artifacts
  });
  const runs = fetchCalibrationLabelRosterRuns(repository);
  const selectionSnapshot = assertUniqueCalibrationLabelRosterRun({
    runs,
    studyId: input.studyId,
    candidateCommit: input.candidateCommit,
    carrierCommit: input.carrierCommit,
    caseInputRootSha256: input.caseInputRootSha256,
    selectedRunId: metadata.runId,
    allowInProgress: input.allowInProgress === true
  });

  mkdirSync(input.scratchDir, { recursive: false, mode: 0o700 });
  const archivePath = path.join(input.scratchDir, "roster.zip");
  const archive = ghBytes(
    `repos/${repository}/actions/artifacts/${metadata.artifactId}/zip`
  );
  writeFileSync(archivePath, archive, { flag: "wx", mode: 0o600 });
  const parsed = readCalibrationSingleJsonArtifact({
    archivePath,
    archiveSha256: metadata.archiveSha256,
    archiveBytes: metadata.archiveBytes,
    memberName: "roster.json",
    maximumBytes: 32 * 1024 * 1024,
    label: "calibration label roster authorization"
  });
  const roster = validateCalibrationLabelRosterAuthorization(
    parsed.value,
    {
      studyId: input.studyId,
      detector: input.detector,
      candidateCommit: input.candidateCommit,
      carrierCommit: input.carrierCommit,
      labelSealingKey: input.labelSealingKey,
      producer: {
        repository,
        workflowPath: CALIBRATION_LABEL_ROSTER_WORKFLOW_PATH,
        workflowRef: "refs/heads/main",
        runId: metadata.runId,
        runAttempt: metadata.runAttempt,
        headSha: metadata.headSha,
        actor: metadata.actor,
        triggeringActor: metadata.triggeringActor
      },
      authorization: {
        nonce: input.authorizationNonce,
        acquisitionWorkflowPath: CALIBRATION_ACQUISITION_WORKFLOW_PATH,
        authorizedRunAttempt: 1,
        caseInputRootSha256: input.caseInputRootSha256
      }
    }
  );
  if (parsed.text !== canonicalPrettyJson(roster)) {
    throw new Error("calibration roster authorization is not canonical JSON");
  }
  if (
    roster.authenticatedCommitments.some(
      (commitment) =>
        Date.parse(commitment.createdAt) >=
          Date.parse(metadata.runStartedAt) ||
        Date.parse(commitment.createdAt) >=
          Date.parse(metadata.artifactCreatedAt)
    )
  ) {
    throw new Error(
      "every authenticated label commitment must predate the roster run and artifact"
    );
  }
  return {
    metadata,
    roster,
    text: parsed.text,
    sha256: sha256Hex(parsed.text),
    selectionSnapshot
  };
}

function commitmentSummaryArray(value, identity) {
  if (
    !Array.isArray(value) ||
    value.length < 3 ||
    value.length > MAX_COMMITMENTS
  ) {
    throw new Error("roster authenticatedCommitments count is invalid");
  }
  const result = [];
  const actors = new Set();
  const sources = new Set();
  const envelopes = new Set();
  const ciphertexts = new Set();
  let prior = "";
  for (const [index, raw] of value.entries()) {
    const label = `roster authenticatedCommitments[${index}]`;
    exactKeys(
      raw,
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
      ],
      label
    );
    const summary = {
      role: role(raw.role, `${label}.role`),
      actor: githubLogin(raw.actor, `${label}.actor`),
      runId: positiveInteger(raw.runId, `${label}.runId`),
      runAttempt: boundedRunAttempt(
        raw.runAttempt,
        `${label}.runAttempt`
      ),
      headSha: fullSha(raw.headSha, `${label}.headSha`),
      artifactId: positiveInteger(raw.artifactId, `${label}.artifactId`),
      artifactName: boundedText(
        raw.artifactName,
        `${label}.artifactName`,
        300
      ),
      archiveSha256: digest(
        raw.archiveSha256,
        `${label}.archiveSha256`
      ),
      createdAt: instant(raw.createdAt, `${label}.createdAt`),
      source: sourceProvenanceObject(raw.source, `${label}.source`),
      algorithm: boundedText(raw.algorithm, `${label}.algorithm`, 100),
      keyId: digest(raw.keyId, `${label}.keyId`),
      envelopeSha256: digest(
        raw.envelopeSha256,
        `${label}.envelopeSha256`
      ),
      ciphertextSha256: digest(
        raw.ciphertextSha256,
        `${label}.ciphertextSha256`
      )
    };
    const expectedName =
      `site-behavior-calibration-label-commitment-${summary.role}-` +
      `${identity.studyId}-${summary.runId}-${summary.runAttempt}`;
    const coordinateKey = sortableCoordinate(summary);
    const sourceKey = canonicalizeCalibrationValue(summary.source);
    if (
      coordinateKey.localeCompare(prior) <= 0 ||
      summary.artifactName !== expectedName ||
      summary.algorithm !== CALIBRATION_LABEL_SEALING_ALGORITHM ||
      summary.keyId !== identity.keyId ||
      actors.has(summary.actor) ||
      sources.has(sourceKey) ||
      envelopes.has(summary.envelopeSha256) ||
      ciphertexts.has(summary.ciphertextSha256)
    ) {
      throw new Error(
        `${label} is replayed, out of order, or disagrees with roster identity`
      );
    }
    prior = coordinateKey;
    actors.add(summary.actor);
    sources.add(sourceKey);
    envelopes.add(summary.envelopeSha256);
    ciphertexts.add(summary.ciphertextSha256);
    result.push(summary);
  }
  enforceCommitmentRoles(result);
  return result;
}

function enforceCommitmentRoles(commitments) {
  const labelers = commitments.filter(
    (commitment) => commitment.role === "labeler"
  );
  const tiebreakers = commitments.filter(
    (commitment) => commitment.role === "tiebreaker"
  );
  if (
    labelers.length < 2 ||
    labelers.length > 10 ||
    tiebreakers.length !== 1
  ) {
    throw new Error(
      "roster requires 2 through 10 distinct labelers and one distinct blind tiebreaker"
    );
  }
}

function coordinateObject(value, label) {
  exactKeys(
    value,
    ["role", "runId", "runAttempt", "artifactId", "archiveSha256"],
    label
  );
  return {
    role: role(value.role, `${label}.role`),
    runId: positiveInteger(value.runId, `${label}.runId`),
    runAttempt: boundedRunAttempt(
      value.runAttempt,
      `${label}.runAttempt`
    ),
    artifactId: positiveInteger(value.artifactId, `${label}.artifactId`),
    archiveSha256: digest(
      value.archiveSha256,
      `${label}.archiveSha256`
    )
  };
}

function commitmentMetadataObject(value, label) {
  exactKeys(
    value,
    [
      "role",
      "runId",
      "runAttempt",
      "headSha",
      "actor",
      "triggeringActor",
      "runStartedAt",
      "runCompletedAt",
      "artifactId",
      "artifactName",
      "archiveSha256",
      "archiveBytes",
      "artifactCreatedAt",
      "artifactExpiresAt"
    ],
    label
  );
  return {
    role: role(value.role, `${label}.role`),
    runId: positiveInteger(value.runId, `${label}.runId`),
    runAttempt: boundedRunAttempt(
      value.runAttempt,
      `${label}.runAttempt`
    ),
    headSha: fullSha(value.headSha, `${label}.headSha`),
    actor: githubLogin(value.actor, `${label}.actor`),
    triggeringActor: githubLogin(
      value.triggeringActor,
      `${label}.triggeringActor`
    ),
    runStartedAt: instant(value.runStartedAt, `${label}.runStartedAt`),
    runCompletedAt: instant(
      value.runCompletedAt,
      `${label}.runCompletedAt`
    ),
    artifactId: positiveInteger(value.artifactId, `${label}.artifactId`),
    artifactName: boundedText(
      value.artifactName,
      `${label}.artifactName`,
      300
    ),
    archiveSha256: digest(
      value.archiveSha256,
      `${label}.archiveSha256`
    ),
    archiveBytes: positiveInteger(
      value.archiveBytes,
      `${label}.archiveBytes`
    ),
    artifactCreatedAt: instant(
      value.artifactCreatedAt,
      `${label}.artifactCreatedAt`
    ),
    artifactExpiresAt: instant(
      value.artifactExpiresAt,
      `${label}.artifactExpiresAt`
    )
  };
}

function rosterProducerObject(value) {
  exactKeys(
    value,
    [
      "repository",
      "workflowPath",
      "workflowRef",
      "runId",
      "runAttempt",
      "headSha",
      "actor",
      "triggeringActor"
    ],
    "roster producer"
  );
  const producer = {
    repository: boundedText(value.repository, "roster producer repository", 200),
    workflowPath: boundedText(
      value.workflowPath,
      "roster producer workflowPath",
      300
    ),
    workflowRef: boundedText(
      value.workflowRef,
      "roster producer workflowRef",
      300
    ),
    runId: positiveInteger(value.runId, "roster producer runId"),
    runAttempt: boundedRunAttempt(
      value.runAttempt,
      "roster producer runAttempt"
    ),
    headSha: fullSha(value.headSha, "roster producer headSha"),
    actor: githubLogin(value.actor, "roster producer actor"),
    triggeringActor: githubLogin(
      value.triggeringActor,
      "roster producer triggeringActor"
    )
  };
  if (
    producer.repository !== REPOSITORY ||
    producer.workflowPath !== CALIBRATION_LABEL_ROSTER_WORKFLOW_PATH ||
    producer.workflowRef !== "refs/heads/main" ||
    producer.runAttempt !== 1 ||
    producer.actor !== producer.triggeringActor
  ) {
    throw new Error(
      "roster producer must be one non-delegated attempt-1 main-branch workflow run"
    );
  }
  return producer;
}

function rosterAuthorizationObject(value) {
  exactKeys(
    value,
    [
      "nonce",
      "acquisitionWorkflowPath",
      "authorizedRunAttempt",
      "caseInputRootSha256"
    ],
    "roster authorization"
  );
  const authorization = {
    nonce: digest(value.nonce, "roster authorization nonce"),
    acquisitionWorkflowPath: boundedText(
      value.acquisitionWorkflowPath,
      "roster authorization acquisitionWorkflowPath",
      300
    ),
    authorizedRunAttempt: boundedRunAttempt(
      value.authorizedRunAttempt,
      "roster authorization authorizedRunAttempt"
    ),
    caseInputRootSha256: digest(
      value.caseInputRootSha256,
      "roster authorization caseInputRootSha256"
    )
  };
  if (
    authorization.acquisitionWorkflowPath !==
      CALIBRATION_ACQUISITION_WORKFLOW_PATH ||
    authorization.authorizedRunAttempt !== 1
  ) {
    throw new Error(
      "roster authorization must target only acquisition workflow attempt 1"
    );
  }
  return authorization;
}

function labelSealingKeyObject(value, studyId) {
  exactKeys(
    value,
    ["algorithm", "keyId", "publicKeyPath", "publicKeySha256"],
    "roster labelSealingKey"
  );
  const key = {
    algorithm: boundedText(
      value.algorithm,
      "roster labelSealingKey algorithm",
      100
    ),
    keyId: digest(value.keyId, "roster labelSealingKey keyId"),
    publicKeyPath: artifactPath(
      value.publicKeyPath,
      "roster labelSealingKey publicKeyPath"
    ),
    publicKeySha256: digest(
      value.publicKeySha256,
      "roster labelSealingKey publicKeySha256"
    )
  };
  if (
    key.algorithm !== CALIBRATION_LABEL_SEALING_ALGORITHM ||
    key.publicKeyPath !==
      `calibration/${studyId}/label-sealing-public-key.pem`
  ) {
    throw new Error("roster label-sealing key does not match the frozen study");
  }
  return key;
}

function sourceProvenanceObject(value, label) {
  exactKeys(value, ["commit", "tree", "path", "sha256"], label);
  return {
    commit: fullSha(value.commit, `${label}.commit`),
    tree: fullSha(value.tree, `${label}.tree`),
    path: artifactPath(value.path, `${label}.path`),
    sha256: digest(value.sha256, `${label}.sha256`)
  };
}

function isCalibrationLabelRosterWorkflowPath(value) {
  try {
    calibrationLabelRosterWorkflowPath(value);
    return true;
  } catch {
    return false;
  }
}

function normalizedRosterRunSummary(value, label) {
  requireRecord(value, label);
  const actor = githubLogin(value.actor?.login, `${label}.actor`);
  const triggeringActor = githubLogin(
    value.triggering_actor?.login,
    `${label}.triggering_actor`
  );
  const summary = {
    runId: positiveInteger(value.id, `${label}.id`),
    runAttempt: boundedRunAttempt(
      value.run_attempt,
      `${label}.run_attempt`
    ),
    status: boundedText(value.status, `${label}.status`, 50),
    conclusion:
      value.conclusion === null
        ? null
        : boundedText(value.conclusion, `${label}.conclusion`, 50),
    event: boundedText(value.event, `${label}.event`, 100),
    workflowPath: calibrationLabelRosterWorkflowPath(value.path),
    headBranch: boundedText(
      value.head_branch,
      `${label}.head_branch`,
      300
    ),
    headSha: fullSha(value.head_sha, `${label}.head_sha`),
    actor,
    triggeringActor,
    createdAt: instant(value.created_at, `${label}.created_at`),
    runStartedAt: instant(
      value.run_started_at,
      `${label}.run_started_at`
    ),
    updatedAt: instant(value.updated_at, `${label}.updated_at`),
    displayTitle: boundedText(
      value.display_title,
      `${label}.display_title`,
      300
    )
  };
  if (
    summary.event !== "workflow_dispatch" ||
    summary.workflowPath !== CALIBRATION_LABEL_ROSTER_WORKFLOW_PATH ||
    summary.headBranch !== "main" ||
    summary.actor !== summary.triggeringActor ||
    Date.parse(summary.runStartedAt) < Date.parse(summary.createdAt) ||
    Date.parse(summary.updatedAt) < Date.parse(summary.runStartedAt)
  ) {
    throw new Error(`${label} is not one valid governed roster run summary`);
  }
  return summary;
}

function rosterRunSummaryObject(value, label) {
  exactKeys(
    value,
    [
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
    ],
    label
  );
  const summary = {
    runId: positiveInteger(value.runId, `${label}.runId`),
    runAttempt: boundedRunAttempt(
      value.runAttempt,
      `${label}.runAttempt`
    ),
    status: boundedText(value.status, `${label}.status`, 50),
    conclusion:
      value.conclusion === null
        ? null
        : boundedText(value.conclusion, `${label}.conclusion`, 50),
    event: boundedText(value.event, `${label}.event`, 100),
    workflowPath: boundedText(
      value.workflowPath,
      `${label}.workflowPath`,
      300
    ),
    headBranch: boundedText(
      value.headBranch,
      `${label}.headBranch`,
      300
    ),
    headSha: fullSha(value.headSha, `${label}.headSha`),
    actor: githubLogin(value.actor, `${label}.actor`),
    triggeringActor: githubLogin(
      value.triggeringActor,
      `${label}.triggeringActor`
    ),
    createdAt: instant(value.createdAt, `${label}.createdAt`),
    runStartedAt: instant(value.runStartedAt, `${label}.runStartedAt`),
    updatedAt: instant(value.updatedAt, `${label}.updatedAt`),
    displayTitle: boundedText(
      value.displayTitle,
      `${label}.displayTitle`,
      300
    )
  };
  if (
    summary.event !== "workflow_dispatch" ||
    summary.workflowPath !== CALIBRATION_LABEL_ROSTER_WORKFLOW_PATH ||
    summary.headBranch !== "main" ||
    summary.actor !== summary.triggeringActor ||
    Date.parse(summary.runStartedAt) < Date.parse(summary.createdAt) ||
    Date.parse(summary.updatedAt) < Date.parse(summary.runStartedAt)
  ) {
    throw new Error(`${label} is not one valid governed roster run summary`);
  }
  return summary;
}

function compareExpected(value, expected) {
  for (const field of [
    "studyId",
    "detector",
    "candidateCommit",
    "carrierCommit"
  ]) {
    if (expected[field] !== undefined && value[field] !== expected[field]) {
      throw new Error(`roster ${field} does not match the expected identity`);
    }
  }
  for (const field of [
    "labelSealingKey",
    "source",
    "producer",
    "authorization"
  ]) {
    if (
      expected[field] !== undefined &&
      canonicalizeCalibrationValue(value[field]) !==
        canonicalizeCalibrationValue(expected[field])
    ) {
      throw new Error(`roster ${field} does not match the expected binding`);
    }
  }
}

function sortableCoordinate(value) {
  return (
    `${value.role === "labeler" ? "0" : "1"}:` +
    `${String(value.runId).padStart(20, "0")}:` +
    `${String(value.runAttempt).padStart(3, "0")}:` +
    `${String(value.artifactId).padStart(20, "0")}`
  );
}

function ghJson(endpoint, extraArguments = []) {
  const output = execFileSync(
    "gh",
    [
      "api",
      "--method",
      "GET",
      "-H",
      "Accept: application/vnd.github+json",
      "-H",
      "X-GitHub-Api-Version: 2022-11-28",
      ...extraArguments,
      endpoint
    ],
    {
      encoding: "utf8",
      maxBuffer: 128 * 1024 * 1024,
      stdio: ["ignore", "pipe", "inherit"]
    }
  );
  try {
    return JSON.parse(output);
  } catch {
    throw new Error(`GitHub API returned malformed JSON for ${endpoint}`);
  }
}

function ghBytes(endpoint) {
  return execFileSync(
    "gh",
    [
      "api",
      "--method",
      "GET",
      "-H",
      "Accept: application/vnd.github+json",
      "-H",
      "X-GitHub-Api-Version: 2022-11-28",
      endpoint
    ],
    {
      encoding: "buffer",
      maxBuffer: MAX_ROSTER_ARCHIVE_BYTES,
      stdio: ["ignore", "pipe", "inherit"]
    }
  );
}

function artifactPath(value, label) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 500 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("\u0000") ||
    value.split("/").some((component) => component === "" || component === "..")
  ) {
    throw new Error(`${label} must be a bounded repository-relative path`);
  }
  return value;
}

function opaqueAbsolutePath(value, label) {
  if (
    typeof value !== "string" ||
    value.length < 2 ||
    value.length > 4096 ||
    !value.startsWith("/") ||
    value.includes("\u0000") ||
    value.includes("\n") ||
    value.includes("\r")
  ) {
    throw new Error(`${label} must be one bounded opaque absolute path`);
  }
  return value;
}

function role(value, label) {
  if (value !== "labeler" && value !== "tiebreaker") {
    throw new Error(`${label} must be labeler or tiebreaker`);
  }
  return value;
}

function detector(value, label) {
  if (
    ![
      "fingerprint-heuristics",
      "keystroke-exfiltration",
      "cname-uncloaking",
      "pixel-events",
      "consent-banner",
      "privacy-policy"
    ].includes(value)
  ) {
    throw new Error(`${label} is not a governed detector`);
  }
  return value;
}

function token(value, label) {
  if (typeof value !== "string" || !TOKEN.test(value)) {
    throw new Error(`${label} must be a bounded opaque token`);
  }
  return value;
}

function fullSha(value, label) {
  if (typeof value !== "string" || !FULL_SHA.test(value)) {
    throw new Error(`${label} must be a full lowercase Git SHA`);
  }
  return value;
}

function digest(value, label) {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new Error(`${label} must be a lowercase sha256 digest`);
  }
  return value;
}

function normalizedDigest(value, label) {
  const normalized =
    typeof value === "string" && value.startsWith("sha256:")
      ? value.slice("sha256:".length)
      : value;
  return digest(normalized, label);
}

function githubLogin(value, label) {
  if (typeof value !== "string" || !LOGIN.test(value)) {
    throw new Error(`${label} must be one GitHub login`);
  }
  return value.toLowerCase();
}

function instant(value, label) {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(parsed)) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  return new Date(parsed).toISOString();
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

function boundedRunAttempt(value, label) {
  const attempt = positiveInteger(value, label);
  if (attempt > 100) {
    throw new Error(`${label} must be no greater than 100`);
  }
  return attempt;
}

function boundedText(value, label, maximum) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    value.includes("\u0000")
  ) {
    throw new Error(`${label} must be bounded text`);
  }
  return value;
}

function boundedMilliseconds(value, label, minimum, maximum) {
  if (
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function requireRecord(value, label) {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value, expected, label) {
  requireRecord(value, label);
  if (JSON.stringify(Object.keys(value)) !== JSON.stringify(expected)) {
    throw new Error(
      `${label} must contain exactly, in order: ${expected.join(", ")}`
    );
  }
}
