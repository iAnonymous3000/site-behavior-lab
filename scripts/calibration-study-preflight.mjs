#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertCalibrationCandidateCanSatisfyRatePolicy,
  assertCalibrationDecisionApproved,
  assertCalibrationWorkflowPreflight,
  canonicalPrettyJson,
  sha256Hex,
  validateCalibrationCandidateFiles
} from "./calibration-study-lib.mjs";
import {
  calibrationCaseInputRootSha256,
  fetchAuthenticatedCalibrationLabelRoster,
  waitForTerminalCalibrationLabelRosterRun
} from "./calibration-label-roster-lib.mjs";
import {
  buildCalibrationAcquisitionAuthorizationIdentity,
  validateCalibrationAcquisitionAuthorizationIdentity
} from "./calibration-acquisition-authorization-lib.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const phase = process.argv[2];
if ((phase !== "--dispatch" && phase !== "--acquisition") || process.argv.length !== 3) {
  throw new Error("Usage: calibration-study-preflight.mjs --dispatch|--acquisition");
}
const phaseId = phase === "--dispatch" ? "dispatch" : "acquisition";
const studyId = requiredEnv("CALIBRATION_STUDY_ID");
const requestedCandidate = requiredEnv("CALIBRATION_CANDIDATE_COMMIT").toLowerCase();
const eventCommit = requiredEnv("GITHUB_SHA").toLowerCase();
const checkoutCommit = git(["rev-parse", "HEAD"]).toLowerCase();
if (checkoutCommit !== eventCommit) {
  throw new Error(`Trusted carrier checkout ${checkoutCommit} does not match Actions head ${eventCommit}`);
}
if (git(["status", "--porcelain", "--untracked-files=all"]) !== "") {
  throw new Error("Trusted carrier checkout is dirty");
}

const requireFromRoot = createRequire(import.meta.url);
const bindingModule = requireFromRoot(
  path.join(rootDir, "dist", "schema", "lib", "measurement-candidate-binding.js")
);
const binding =
  bindingModule.verifiedMeasurementCandidateAcquisitionContext(rootDir, {
    requireCleanWorktree: true
  });
if (!binding) throw new Error("A verified measurement-candidate binding is required");

const readiness = JSON.parse(readFileSync(path.join(rootDir, "RELEASE_READINESS.json"), "utf8"));
const candidate = validateCalibrationCandidateFiles(rootDir, studyId);
assertCalibrationCandidateCanSatisfyRatePolicy(candidate);
const decision = assertCalibrationDecisionApproved(
  readiness,
  candidate.policySha256
);
if (candidate.preregistration.declaredAt >= decision.decidedAt) {
  // Candidate inputs may be preregistered before the governance decision, but
  // acquisition cannot begin until the decision itself exists. This note is
  // deliberately informational: the release gate binds the policy bytes at C.
  console.log(
    `Calibration policy approval ${decision.decidedAt} is no later than preregistration ${candidate.preregistration.declaredAt}.`
  );
}

const runnerLabel = requiredEnv("FEATURED_RUNNER_LABEL");
const scannerEgress = requiredEnv("SCANNER_EGRESS");
const scannerEgressRegion = requiredEnv("SCANNER_EGRESS_REGION");
const preflight = assertCalibrationWorkflowPreflight({
  phase: phaseId,
  candidateCommit: requestedCandidate,
  carrierCommit: checkoutCommit,
  eventCommit,
  binding,
  measurementFreeze: requiredEnv("SITE_BEHAVIOR_LAB_MEASUREMENT_FREEZE"),
  runnerEnvironment: process.env.RUNNER_ENVIRONMENT,
  runnerLabel,
  egressIdentity: scannerEgress,
  egressRegion: scannerEgressRegion,
  egressAttested: requiredEnv("FEATURED_R2_EGRESS_ATTESTED")
});
if (candidate.detector !== requiredEnv("CALIBRATION_DETECTOR")) {
  throw new Error("workflow detector input does not match the candidate preregistration");
}

let acquisitionAuthorizationBase64 = "";
let rosterSelectionSnapshotBase64 = "";
let rosterSelectionSnapshotSha256 = "";
const calibrationMode = process.env.CALIBRATION_MODE?.trim() ?? "";
if (
  phaseId === "dispatch" &&
  calibrationMode === "acquire"
) {
  const rosterHeadSha = requiredEnv(
    "CALIBRATION_ROSTER_HEAD_SHA"
  ).toLowerCase();
  if (eventCommit !== rosterHeadSha) {
    throw new Error(
      "calibration acquisition dispatch must run at the exact preauthorized evidence carrier"
    );
  }
  git(["merge-base", "--is-ancestor", requestedCandidate, rosterHeadSha]);
  const caseInputRoot = requiredEnv("CASE_INPUT_ROOT");
  const caseInputRootSha256 =
    calibrationCaseInputRootSha256(caseInputRoot);
  if (
    caseInputRootSha256 !==
      requiredEnv("CALIBRATION_ROSTER_CASE_INPUT_ROOT_SHA256") ||
    requiredEnv("CALIBRATION_ROSTER_AUTHORIZED_RUN_ATTEMPT") !== "1"
  ) {
    throw new Error(
      "roster dispatch inputs do not equal the domain-separated case root and attempt-1 authorization"
    );
  }
  const terminalRosterRun =
    await waitForTerminalCalibrationLabelRosterRun({
      runId: positiveIntegerEnv("CALIBRATION_ROSTER_RUN_ID"),
      studyId,
      candidateCommit: requestedCandidate,
      carrierCommit: rosterHeadSha,
      caseInputRootSha256
    });
  const roster = fetchAuthenticatedCalibrationLabelRoster({
    repository: "iAnonymous3000/site-behavior-lab",
    runId: positiveIntegerEnv("CALIBRATION_ROSTER_RUN_ID"),
    runAttempt: positiveIntegerEnv(
      "CALIBRATION_ROSTER_RUN_ATTEMPT"
    ),
    artifactId: positiveIntegerEnv("CALIBRATION_ROSTER_ARTIFACT_ID"),
    archiveSha256: requiredEnv(
      "CALIBRATION_ROSTER_ARTIFACT_DIGEST"
    ),
    studyId,
    detector: candidate.detector,
    candidateCommit: requestedCandidate,
    carrierCommit: rosterHeadSha,
    caseInputRootSha256,
    labelSealingKey: candidate.labelSealingKey,
    authorizationNonce: requiredEnv(
      "CALIBRATION_ROSTER_AUTHORIZATION_NONCE"
    ),
    run: terminalRosterRun,
    scratchDir: path.join(
      requiredEnv("RUNNER_TEMP"),
      "calibration-label-roster-preflight"
    )
  });
  if (
    roster.metadata.headSha !== rosterHeadSha ||
    !binding.acceptedProducerCommits.includes(roster.metadata.headSha)
  ) {
    throw new Error(
      "roster authorization producer head must equal the preauthorized evidence carrier and be accepted by the binding"
    );
  }
  const authorization =
    buildCalibrationAcquisitionAuthorizationIdentity({
      studyId,
      detector: candidate.detector,
      candidateCommit: requestedCandidate,
      roster: {
        runId: roster.metadata.runId,
        runAttempt: roster.metadata.runAttempt,
        headSha: roster.metadata.headSha,
        artifactId: roster.metadata.artifactId,
        archiveSha256: roster.metadata.archiveSha256,
        authorizationSha256: roster.sha256,
        artifactCreatedAt: roster.metadata.artifactCreatedAt
      },
      commitmentSetSha256: roster.roster.commitmentSetSha256,
      nonce: roster.roster.authorization.nonce,
      caseInputRootSha256
    });
  const authorizationText = canonicalPrettyJson(authorization);
  const rosterSelectionSnapshotText = canonicalPrettyJson(
    roster.selectionSnapshot
  );
  acquisitionAuthorizationBase64 = Buffer.from(
    authorizationText,
    "utf8"
  ).toString("base64url");
  rosterSelectionSnapshotBase64 = Buffer.from(
    rosterSelectionSnapshotText,
    "utf8"
  ).toString("base64url");
  rosterSelectionSnapshotSha256 = sha256Hex(
    rosterSelectionSnapshotText
  );
}
if (phaseId === "acquisition") {
  const authorization =
    validateCalibrationAcquisitionAuthorizationIdentity(
      requiredBase64Json(
        "CALIBRATION_ACQUISITION_AUTHORIZATION_BASE64"
      )
    );
  if (
    eventCommit !== authorization.roster.headSha ||
    authorization.studyId !== studyId ||
    authorization.detector !== candidate.detector ||
    authorization.candidateCommit !== requestedCandidate ||
    authorization.authorizedRunAttempt !==
      positiveIntegerEnv("GITHUB_RUN_ATTEMPT")
  ) {
    throw new Error(
      "calibration acquisition workflow does not equal its precommitted authorization"
    );
  }
}

const freezeReceipt = JSON.parse(
  readFileSync(
    path.join(rootDir, "research", "ops-receipts", "measurement-freeze-activation.json"),
    "utf8"
  )
);
const configuration = freezeReceipt?.safeConfiguration;
const controlledRunner = freezeReceipt?.controlledRunner;
const runnerLabelSha256 = sha256Hex(`runner-label\u0000${runnerLabel}`);
const regionSha256 = sha256Hex(`scanner-egress-region\u0000${scannerEgressRegion}`);
if (
  configuration?.measurementFreeze !== "1" ||
  configuration?.scannerEgress !== scannerEgress ||
  configuration?.runnerLabelSha256 !== runnerLabelSha256 ||
  configuration?.scannerEgressRegionSha256 !== regionSha256 ||
  configuration?.featuredR2EgressAttested !== "1"
) {
  throw new Error("live calibration configuration does not equal the freeze activation receipt");
}

let runnerIdentitySha256 = "";
if (phaseId === "acquisition") {
  const runnerName = requiredEnv("RUNNER_NAME");
  const runnerNameSha256 = sha256Hex(`runner-name\u0000${runnerName}`);
  const matches = Array.isArray(controlledRunner?.onlineMatches)
    ? controlledRunner.onlineMatches.filter(
        (entry) =>
          entry?.nameSha256 === runnerNameSha256 &&
          entry?.status === "online" &&
          typeof entry?.identitySha256 === "string"
      )
    : [];
  if (matches.length !== 1) {
    throw new Error(
      "the executing runner name does not identify exactly one freeze-attested online runner"
    );
  }
  runnerIdentitySha256 = matches[0].identitySha256;
}

writeOutputs({
  candidate_commit: preflight.candidateCommit,
  carrier_commit: preflight.carrierCommit,
  detector: candidate.detector,
  runner_label: preflight.runnerLabel,
  runner_label_sha256: runnerLabelSha256,
  runner_identity_sha256: runnerIdentitySha256,
  egress_identity: scannerEgress,
  egress_region: preflight.egressRegion,
  egress_region_sha256: regionSha256,
  acquisition_authorization_base64:
    acquisitionAuthorizationBase64,
  roster_selection_snapshot_base64:
    rosterSelectionSnapshotBase64,
  roster_selection_snapshot_sha256:
    rosterSelectionSnapshotSha256
});
console.log(
  `Calibration ${phaseId} preflight passed for ${studyId} at candidate ${preflight.candidateCommit}.`
);

function writeOutputs(values) {
  const output = process.env.GITHUB_OUTPUT?.trim();
  if (!output) return;
  appendFileSync(
    output,
    `${Object.entries(values)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n")}\n`,
    "utf8"
  );
}

function requiredEnv(name) {
  const value = process.env[name]?.trim() ?? "";
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positiveIntegerEnv(name) {
  const value = Number(requiredEnv(name));
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

function requiredBase64Json(name) {
  const encoded = requiredEnv(name);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new Error(`${name} must be unpadded base64url`);
  }
  let value;
  try {
    value = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8")
    );
  } catch {
    throw new Error(`${name} must contain base64url JSON`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must contain one JSON object`);
  }
  return value;
}

function git(args) {
  return execFileSync("git", args, {
    cwd: rootDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"]
  }).trim();
}
