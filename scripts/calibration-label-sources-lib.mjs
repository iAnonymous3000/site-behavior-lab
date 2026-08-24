import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  CALIBRATION_LABEL_COMMITMENT_KIND,
  CALIBRATION_LABEL_SOURCES_KIND,
  CALIBRATION_LABEL_WORKFLOW_PATH,
  canonicalPrettyJson,
  canonicalizeCalibrationValue,
  sha256Hex,
  validateCalibrationLabelCommitment,
  validateCalibrationLabelSource
} from "./calibration-study-lib.mjs";
import {
  CALIBRATION_LABEL_SEALING_ALGORITHM,
  CALIBRATION_LABEL_SOURCE_ENVELOPE_KIND,
  buildCalibrationLabelEnvelopeIdentity,
  calibrationCommitmentCiphertextSha256,
  openCalibrationLabelSourceEnvelope,
  validateCalibrationLabelSourceEnvelope
} from "./calibration-label-source-envelope-lib.mjs";
import { readCalibrationSingleJsonArtifact } from "./calibration-study-archive-lib.mjs";

const REPOSITORY = "iAnonymous3000/site-behavior-lab";
const FULL_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const LOGIN = /^(?!-)(?!.*--)[A-Za-z0-9-]{1,39}(?<!-)$/;
const MAX_COMMITMENTS = 11;
const LABEL_SET_DOMAIN = "site-behavior-calibration-label-set-v1";

export function validateCalibrationLabelSources(value, candidate) {
  requireRecord(value, "calibration label sources");
  exactKeys(
    value,
    [
      "schemaVersion",
      "artifactKind",
      "studyId",
      "detector",
      "candidateCommit",
      "commitments"
    ],
    "calibration label sources"
  );
  if (
    value.schemaVersion !== 2 ||
    value.artifactKind !== CALIBRATION_LABEL_SOURCES_KIND ||
    value.studyId !== candidate.studyId ||
    value.detector !== candidate.detector ||
    !FULL_SHA.test(value.candidateCommit) ||
    !Array.isArray(value.commitments) ||
    value.commitments.length < 3 ||
    value.commitments.length > MAX_COMMITMENTS
  ) {
    throw new Error(
      "calibration label sources identity or commitment count is invalid"
    );
  }
  const commitments = [];
  let prior = "";
  const artifactIds = new Set();
  for (const [index, raw] of value.commitments.entries()) {
    const label = `calibration label sources commitments[${index}]`;
    requireRecord(raw, label);
    exactKeys(
      raw,
      ["role", "runId", "runAttempt", "artifactId", "archiveSha256"],
      label
    );
    if (raw.role !== "labeler" && raw.role !== "tiebreaker") {
      throw new Error(`${label}.role is invalid`);
    }
    const runId = positiveInteger(raw.runId, `${label}.runId`);
    const runAttempt = positiveInteger(raw.runAttempt, `${label}.runAttempt`);
    const artifactId = positiveInteger(raw.artifactId, `${label}.artifactId`);
    const archiveSha256 = digest(raw.archiveSha256, `${label}.archiveSha256`);
    if (runAttempt > 100 || artifactIds.has(artifactId)) {
      throw new Error(`${label} repeats an artifact or exceeds the attempt bound`);
    }
    artifactIds.add(artifactId);
    const key = `${raw.role === "labeler" ? "0" : "1"}:${String(runId).padStart(20, "0")}:${String(runAttempt).padStart(3, "0")}:${String(artifactId).padStart(20, "0")}`;
    if (key.localeCompare(prior) <= 0) {
      throw new Error(
        "calibration label source commitments must be unique and canonically sorted"
      );
    }
    prior = key;
    commitments.push({
      role: raw.role,
      runId,
      runAttempt,
      artifactId,
      archiveSha256
    });
  }
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
      "calibration label sources require 2 through 10 labelers and exactly one blind tiebreaker"
    );
  }
  return {
    schemaVersion: 2,
    artifactKind: CALIBRATION_LABEL_SOURCES_KIND,
    studyId: candidate.studyId,
    detector: candidate.detector,
    candidateCommit: value.candidateCommit,
    commitments
  };
}

export function validateCalibrationLabelCommitmentGithubMetadata(input) {
  const coordinate = input.coordinate;
  const expectedName =
    `site-behavior-calibration-label-commitment-${coordinate.role}-${input.studyId}-` +
    `${coordinate.runId}-${coordinate.runAttempt}`;
  const run = input.run;
  requireRecord(run, "calibration label Actions run");
  const actor = githubLogin(run.actor?.login, "calibration label run actor");
  const triggeringActor = githubLogin(
    run.triggering_actor?.login,
    "calibration label run triggering actor"
  );
  const runStartedAt = instant(
    run.run_started_at,
    "calibration label run_started_at"
  );
  const runCompletedAt = instant(
    run.updated_at,
    "calibration label run updated_at"
  );
  if (
    run.id !== coordinate.runId ||
    run.run_attempt !== coordinate.runAttempt ||
    run.event !== "workflow_dispatch" ||
    run.path !== CALIBRATION_LABEL_WORKFLOW_PATH ||
    run.head_branch !== "main" ||
    !FULL_SHA.test(run.head_sha) ||
    run.conclusion !== "success" ||
    run.repository?.full_name !== REPOSITORY ||
    actor !== triggeringActor ||
    Date.parse(runCompletedAt) < Date.parse(runStartedAt)
  ) {
    throw new Error(
      "calibration label run is not one successful non-delegated main-branch producer"
    );
  }
  const page = input.artifacts;
  requireRecord(page, "calibration label artifact metadata");
  if (
    !Number.isSafeInteger(page.total_count) ||
    !Array.isArray(page.artifacts) ||
    page.total_count !== page.artifacts.length ||
    page.artifacts.length > 100
  ) {
    throw new Error("calibration label artifact metadata is malformed or paginated");
  }
  const matches = page.artifacts.filter(
    (entry) =>
      entry?.id === coordinate.artifactId && entry?.name === expectedName
  );
  if (matches.length !== 1) {
    throw new Error("calibration label metadata did not identify exactly one artifact");
  }
  const artifact = matches[0];
  const archiveBytes = positiveInteger(
    artifact.size_in_bytes,
    "calibration label artifact bytes"
  );
  const artifactCreatedAt = instant(
    artifact.created_at,
    "calibration label artifact created_at"
  );
  const artifactExpiresAt = instant(
    artifact.expires_at,
    "calibration label artifact expires_at"
  );
  if (
    artifact.expired !== false ||
    archiveBytes > 64 * 1024 * 1024 ||
    artifact.workflow_run?.id !== coordinate.runId ||
    artifact.workflow_run?.head_sha !== run.head_sha ||
    normalizedDigest(artifact.digest) !== coordinate.archiveSha256 ||
    Date.parse(artifactCreatedAt) < Date.parse(runStartedAt) ||
    Date.parse(artifactCreatedAt) > Date.parse(runCompletedAt) ||
    Date.parse(artifactExpiresAt) <= Date.parse(artifactCreatedAt)
  ) {
    throw new Error(
      "calibration label artifact does not bind the authenticated run window and digest"
    );
  }
  return {
    role: coordinate.role,
    runId: coordinate.runId,
    runAttempt: coordinate.runAttempt,
    headSha: run.head_sha,
    actor,
    triggeringActor,
    runStartedAt,
    runCompletedAt,
    artifactId: coordinate.artifactId,
    artifactName: expectedName,
    archiveSha256: coordinate.archiveSha256,
    archiveBytes,
    artifactCreatedAt,
    artifactExpiresAt
  };
}

export function fetchAuthenticatedCalibrationLabelCommitments(input) {
  mkdirSync(input.scratchDir, { recursive: false, mode: 0o700 });
  return input.sources.commitments.map((coordinate, index) => {
    const run = ghJson(
      input.repository,
      `repos/${input.repository}/actions/runs/${coordinate.runId}`
    );
    const artifactName =
      `site-behavior-calibration-label-commitment-${coordinate.role}-${input.sources.studyId}-` +
      `${coordinate.runId}-${coordinate.runAttempt}`;
    const artifacts = ghJson(
      input.repository,
      `repos/${input.repository}/actions/runs/${coordinate.runId}/artifacts`,
      ["-f", `name=${artifactName}`, "-f", "per_page=100"]
    );
    const metadata = validateCalibrationLabelCommitmentGithubMetadata({
      studyId: input.sources.studyId,
      coordinate,
      run,
      artifacts
    });
    if (
      !input.acceptedProducerCommits.includes(metadata.headSha) ||
      !input.isAncestor(metadata.headSha)
    ) {
      throw new Error(
        "calibration label producer head is not an accepted pre-assembly evidence producer"
      );
    }
    const archivePath = path.join(
      input.scratchDir,
      `${String(index).padStart(2, "0")}-${coordinate.artifactId}.zip`
    );
    const archive = ghBytes(
      input.repository,
      `repos/${input.repository}/actions/artifacts/${coordinate.artifactId}/zip`
    );
    writeFileSync(archivePath, archive, { flag: "wx", mode: 0o600 });
    const parsed = readCalibrationSingleJsonArtifact({
      archivePath,
      archiveSha256: metadata.archiveSha256,
      archiveBytes: metadata.archiveBytes,
      memberName: "commitment.json",
      maximumBytes: 32 * 1024 * 1024,
      label: `calibration ${coordinate.role} commitment`
    });
    const commitment = validateCalibrationLabelCommitment(
      parsed.value,
      input.candidate,
      input.sources.candidateCommit
    );
    validateCalibrationLabelSourceEnvelope(commitment.envelope, {
      schemaVersion: 1,
      artifactKind: CALIBRATION_LABEL_SOURCE_ENVELOPE_KIND,
      studyId: input.sources.studyId,
      detector: input.sources.detector,
      role: coordinate.role,
      candidateCommit: input.sources.candidateCommit,
      reviewerLogin: metadata.actor,
      algorithm: CALIBRATION_LABEL_SEALING_ALGORITHM,
      keyId: input.candidate.labelSealingKey.keyId
    });
    if (
      parsed.text !== canonicalPrettyJson(parsed.value) ||
      commitment.role !== coordinate.role ||
      commitment.producer.runId !== coordinate.runId ||
      commitment.producer.runAttempt !== coordinate.runAttempt ||
      commitment.producer.headSha !== metadata.headSha ||
      commitment.producer.actor !== metadata.actor ||
      commitment.producer.triggeringActor !== metadata.triggeringActor
    ) {
      throw new Error(
        "calibration label commitment bytes disagree with authenticated Actions metadata"
      );
    }
    return {
      coordinate,
      metadata,
      commitment,
      text: parsed.text
    };
  });
}

/**
 * GENERIC CUSTODY HELPERS, extracted verbatim from the v3 assembly so the
 * v4 reveal can enforce the identical custody rules by CALLING them rather
 * than restating them (the repo's top defect class is one contract in two
 * homes). v3 behavior, error strings, and per-entry ordering are unchanged:
 * assembleAuthenticatedCalibrationLabels below composes exactly these.
 */
export function validateCalibrationRosterCustodyRecord(roster, { studyId, candidateCommit }) {
  requireRecord(roster, "calibration label roster custody");
  exactKeys(
    roster,
    [
      "authorizationPath",
      "authorizationSha256",
      "selectionLedgerPath",
      "selectionLedgerSha256",
      "candidateCommit",
      "carrierCommit",
      "authenticatedCommitments",
      "commitmentSetSha256"
    ],
    "calibration label roster custody"
  );
  const expectedRosterRoot =
    `calibration/${studyId}`;
  if (
    roster.authorizationPath !==
      `${expectedRosterRoot}/label-roster-authorization.json` ||
    roster.selectionLedgerPath !==
      `${expectedRosterRoot}/roster-selection-ledger.json` ||
    !SHA256.test(roster.authorizationSha256) ||
    !SHA256.test(roster.selectionLedgerSha256) ||
    roster.candidateCommit !== candidateCommit ||
    !FULL_SHA.test(roster.carrierCommit) ||
    !Array.isArray(roster.authenticatedCommitments) ||
    !SHA256.test(roster.commitmentSetSha256)
  ) {
    throw new Error(
      "calibration label roster custody does not bind the fixed study paths, candidate, carrier, and hosted commitment set"
    );
  }
  return roster;
}

export function validateCalibrationCommitmentSetCustody({
  commitments,
  acquisitionRunStartedAt,
  acquisitionJobStartedAt,
  boundaryLabel = "the authenticated acquisition run and job start"
}) {
  const labelCommitments = commitments.filter(
    (entry) => entry.commitment.role === "labeler"
  );
  const tiebreakerCommitments = commitments.filter(
    (entry) => entry.commitment.role === "tiebreaker"
  );
  const actors = commitments.map((entry) => entry.metadata.actor);
  if (
    labelCommitments.length < 2 ||
    labelCommitments.length > 10 ||
    new Set(actors).size !== actors.length ||
    tiebreakerCommitments.length !== 1
  ) {
    throw new Error(
      "calibration labels require 2 through 10 distinct authenticated labelers and exactly one distinct blind tiebreaker"
    );
  }
  const sourceCommitments = new Set();
  const envelopeCommitments = new Set();
  const ciphertextCommitments = new Set();
  for (const entry of commitments) {
    if (
      Date.parse(entry.metadata.artifactCreatedAt) >=
        Date.parse(acquisitionRunStartedAt) ||
      Date.parse(entry.metadata.artifactCreatedAt) >=
        Date.parse(acquisitionJobStartedAt)
    ) {
      throw new Error(
        `every label and blind-tiebreaker ciphertext commitment must exist before ${boundaryLabel}`
      );
    }
    const sourceCommitment = canonicalizeCalibrationValue(
      entry.commitment.source
    );
    const envelopeCommitment = entry.commitment.envelopeSha256;
    const ciphertextCommitment = calibrationCommitmentCiphertextSha256(
      entry.commitment.envelope
    );
    if (
      sourceCommitments.has(sourceCommitment) ||
      envelopeCommitments.has(envelopeCommitment) ||
      ciphertextCommitments.has(ciphertextCommitment)
    ) {
      throw new Error(
        "calibration label commitments must use unique source, envelope, and ciphertext commitments; cross-actor replay is forbidden"
      );
    }
    sourceCommitments.add(sourceCommitment);
    envelopeCommitments.add(envelopeCommitment);
    ciphertextCommitments.add(ciphertextCommitment);
  }
  return {
    labelCommitments,
    tiebreakerCommitments
  };
}

/** Open ONE authenticated commitment's envelope against its expected identity. */
export function openCalibrationCommitmentEnvelope(entry, { privateKeyPem, candidate, candidateCommit }) {
  return openCalibrationLabelSourceEnvelope(
    entry.commitment.envelope,
    privateKeyPem,
    buildCalibrationLabelEnvelopeIdentity({
      studyId: candidate.studyId,
      detector: candidate.detector,
      role: entry.commitment.role,
      candidateCommit,
      reviewerLogin: entry.metadata.actor,
      keyId: candidate.labelSealingKey.keyId
    })
  );
}

/**
 * The 14-field authenticated-commitment projection and its set digest for
 * the reveal side. The roster builder's own projection
 * (calibration-label-roster-lib.mjs) deliberately stays as it is and the
 * two are cross-pinned by the producer suite, which builds a roster with
 * the real builder and reveals it through this path; any divergence fails
 * that suite, never a live ceremony.
 */
export function describeAuthenticatedCalibrationCommitments(commitments) {
  const authenticatedCommitments = commitments.map((entry) => ({
    role: entry.commitment.role,
    actor: entry.metadata.actor,
    runId: entry.metadata.runId,
    runAttempt: entry.metadata.runAttempt,
    headSha: entry.metadata.headSha,
    artifactId: entry.metadata.artifactId,
    artifactName: entry.metadata.artifactName,
    archiveSha256: entry.metadata.archiveSha256,
    createdAt: entry.metadata.artifactCreatedAt,
    source: entry.commitment.source,
    algorithm: entry.commitment.envelope.algorithm,
    keyId: entry.commitment.keyId,
    envelopeSha256: entry.commitment.envelopeSha256,
    ciphertextSha256: calibrationCommitmentCiphertextSha256(entry.commitment.envelope)
  }));
  const commitmentSetSha256 = sha256Hex(
    `${canonicalizeCalibrationValue(authenticatedCommitments)}`
  );
  return { authenticatedCommitments, commitmentSetSha256 };
}

/** The revealed commitment set must EXACTLY equal the pre-acquisition roster. */
export function assertRevealedCommitmentsEqualRoster({
  authenticatedCommitments,
  commitmentSetSha256,
  roster
}) {
  if (
    canonicalizeCalibrationValue(authenticatedCommitments) !==
      canonicalizeCalibrationValue(
        roster.authenticatedCommitments
      ) ||
    commitmentSetSha256 !== roster.commitmentSetSha256
  ) {
    throw new Error(
      "revealed calibration commitments do not exactly equal the pre-acquisition authorized roster"
    );
  }
}

export function assembleAuthenticatedCalibrationLabels(input) {
  const roster = input.roster ?? null;
  if (roster !== null) {
    validateCalibrationRosterCustodyRecord(roster, {
      studyId: input.candidate.studyId,
      candidateCommit: input.candidateCommit
    });
  }
  const retainedCaseIds = new Set(input.retainedCaseIds);
  if (
    retainedCaseIds.size !== input.retainedCaseIds.length ||
    [...retainedCaseIds].some(
      (caseId) => !input.candidate.frameById.has(caseId)
    )
  ) {
    throw new Error(
      "retained calibration label case ids must be unique members of the frozen frame"
    );
  }
  validateCalibrationCommitmentSetCustody({
    commitments: input.commitments,
    acquisitionRunStartedAt: input.acquisitionRunStartedAt,
    acquisitionJobStartedAt: input.acquisitionJobStartedAt
  });
  const revealed = input.commitments.map((entry) => {
    const opened = openCalibrationCommitmentEnvelope(entry, {
      privateKeyPem: input.privateKeyPem,
      candidate: input.candidate,
      candidateCommit: input.candidateCommit
    });
    const source = validateCalibrationLabelSource(
      opened.value,
      input.candidate,
      entry.commitment.role,
      input.candidateCommit
    );
    return { ...entry, source, sourceText: opened.text };
  });
  const revealedLabelers = revealed.filter(
    (entry) => entry.commitment.role === "labeler"
  );
  const revealedTiebreaker = revealed.find(
    (entry) => entry.commitment.role === "tiebreaker"
  );
  const labelCases = revealedLabelers.map(
    (entry) => new Map(entry.source.cases.map((item) => [item.caseId, item]))
  );
  const tiebreakerCases = new Map(
    revealedTiebreaker.source.cases.map((item) => [item.caseId, item])
  );
  const disagreements = new Map();
  const cases = new Map();
  const files = [];
  const recordedTimes = input.commitments.map(
    (entry) => entry.metadata.artifactCreatedAt
  );
  for (const frameCase of input.candidate.frame.cases) {
    const caseId = frameCase.caseId;
    const entries = revealedLabelers.map((commitment, index) => {
      const value = labelCases[index].get(caseId);
      if (value === undefined) {
        throw new Error(
          `${caseId} is missing from an authenticated label commitment`
        );
      }
      const evidenceText = canonicalPrettyJson(value.referenceEvidence);
      if (
        sha256Hex(evidenceText) !== frameCase.referenceEvidenceDigest
      ) {
        throw new Error(
          `${caseId} revealed label commitment changed frozen reference evidence`
        );
      }
      return {
        actor: commitment.metadata.actor,
        value: value.value,
        recordedAt: commitment.metadata.artifactCreatedAt,
        evidenceText,
        evidence: value.referenceEvidence
      };
    });
    const tiebreaker = tiebreakerCases.get(caseId);
    if (tiebreaker === undefined) {
      throw new Error(
        `${caseId} is missing from the authenticated blind-tiebreaker commitment`
      );
    }
    const tiebreakerEvidenceText = canonicalPrettyJson(
      tiebreaker.referenceEvidence
    );
    const evidenceTexts = new Set([
      ...entries.map((entry) => entry.evidenceText),
      tiebreakerEvidenceText
    ]);
    if (evidenceTexts.size !== 1) {
      throw new Error(
        `${caseId} labelers and blind tiebreaker did not receive byte-identical reference evidence`
      );
    }
    entries.sort((left, right) => left.actor.localeCompare(right.actor));
    const labelSetSha256 = calibrationLabelSetSha256(
      caseId,
      entries.map(({ actor, value, recordedAt }) => ({
        actor,
        value,
        recordedAt
      }))
    );
    const distinct = new Set(entries.map((entry) => entry.value));
    const frozenPresence = entries[0].evidence.observations.find(
      (observation) =>
        observation.fact === `${input.candidate.detector}-presence`
    ).value;
    const frozenReferenceValue = frozenPresence ? "present" : "absent";
    if (
      distinct.size === 1 &&
      entries[0].value !== frozenReferenceValue
    ) {
      throw new Error(
        `${caseId} unanimous labeler value disagrees with the candidate-bound detector-presence fact`
      );
    }
    if (distinct.size > 1) {
      disagreements.set(caseId, {
        labelSetSha256,
        value: tiebreaker.value
      });
    }
    const evidenceText = entries[0].evidenceText;
    const label = {
      schemaVersion: 1,
      artifactKind: "site-behavior-detector-calibration-label",
      studyId: input.candidate.studyId,
      detector: input.candidate.detector,
      caseId,
      evidenceSha256: frameCase.referenceEvidenceDigest,
      labels: entries.map((entry) => ({
        labelerId: `github-${entry.actor}`,
        value: entry.value,
        recordedAt: entry.recordedAt
      }))
    };
    const labelText = canonicalPrettyJson(label);
    cases.set(caseId, {
      value: distinct.size === 1 ? entries[0].value : null,
      evidence: {
        value: entries[0].evidence,
        text: evidenceText
      },
      label: { value: label, text: labelText },
      adjudication: null,
      labelSetSha256
    });
    if (retainedCaseIds.has(caseId)) {
      files.push({
        path: `cases/${caseId}/label.json`,
        sha256: sha256Hex(labelText)
      });
    }
  }
  if (disagreements.size > 0) {
    for (const [caseId, resolution] of disagreements) {
      const current = cases.get(caseId);
      const adjudication = {
        schemaVersion: 1,
        artifactKind:
          "site-behavior-detector-calibration-blind-tiebreaker-resolution",
        studyId: input.candidate.studyId,
        detector: input.candidate.detector,
        caseId,
        evidenceSha256:
          input.candidate.frameById.get(caseId).referenceEvidenceDigest,
        labelSha256: sha256Hex(current.label.text),
        labelSetSha256: resolution.labelSetSha256,
        resolutionMethod: "blind-precommitted-tiebreaker",
        tiebreakerId: `github-${revealedTiebreaker.metadata.actor}`,
        tiebreakerCommitmentSha256:
          revealedTiebreaker.commitment.envelopeSha256,
        value: resolution.value,
        committedAt: revealedTiebreaker.metadata.artifactCreatedAt
      };
      const text = canonicalPrettyJson(adjudication);
      current.value = resolution.value;
      current.adjudication = { value: adjudication, text };
      if (retainedCaseIds.has(caseId)) {
        files.push({
          path: `cases/${caseId}/adjudication.json`,
          sha256: sha256Hex(text)
        });
      }
    }
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  const { authenticatedCommitments, commitmentSetSha256 } =
    describeAuthenticatedCalibrationCommitments(input.commitments);
  if (roster !== null) {
    assertRevealedCommitmentsEqualRoster({
      authenticatedCommitments,
      commitmentSetSha256,
      roster
    });
  }
  const manifest = {
    schemaVersion: 3,
    artifactKind: "site-behavior-detector-calibration-labels-manifest",
    studyId: input.candidate.studyId,
    detector: input.candidate.detector,
    source: input.source,
    ...(roster === null
      ? {}
      : {
          roster: {
            authorizationPath: roster.authorizationPath,
            authorizationSha256: roster.authorizationSha256,
            selectionLedgerPath: roster.selectionLedgerPath,
            selectionLedgerSha256: roster.selectionLedgerSha256,
            candidateCommit: roster.candidateCommit,
            carrierCommit: roster.carrierCommit
          }
        }),
    labelSealingKey: input.candidate.labelSealingKey,
    authenticatedCommitments,
    commitmentSetSha256,
    recordedFrom: [...recordedTimes].sort()[0],
    recordedThrough: [...recordedTimes].sort().at(-1),
    files
  };
  return {
    cases,
    manifest,
    manifestText: canonicalPrettyJson(manifest),
    source: input.source,
    roster,
    labelSealingKey: input.candidate.labelSealingKey,
    authenticatedCommitments,
    commitmentSetSha256,
    recordedFrom: manifest.recordedFrom,
    recordedThrough: manifest.recordedThrough
  };
}

export function calibrationLabelSetSha256(caseId, entries) {
  return sha256Hex(
    `${LABEL_SET_DOMAIN}\u0000${caseId}\u0000${canonicalizeCalibrationValue(entries)}`
  );
}

function ghJson(repository, endpoint, fields = []) {
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
      ...fields,
      endpoint
    ],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, GH_REPO: repository }
    }
  );
  return JSON.parse(output);
}

function ghBytes(repository, endpoint) {
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
      stdio: ["ignore", "pipe", "inherit"],
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, GH_REPO: repository }
    }
  );
}

function normalizedDigest(value) {
  const normalized =
    typeof value === "string" ? value.replace(/^sha256:/, "") : "";
  return digest(normalized, "artifact digest");
}

function digest(value, label) {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new Error(`${label} must be one lowercase sha256 digest`);
  }
  return value;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

function instant(value, label) {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be an ISO timestamp`);
  return new Date(parsed).toISOString();
}

function githubLogin(value, label) {
  if (typeof value !== "string" || !LOGIN.test(value)) {
    throw new Error(`${label} must be one GitHub login`);
  }
  return value.toLowerCase();
}

function requireRecord(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function exactKeys(value, expected, label) {
  requireRecord(value, label);
  if (JSON.stringify(Object.keys(value)) !== JSON.stringify(expected)) {
    throw new Error(`${label} must contain exactly ${expected.join(", ")}`);
  }
}
