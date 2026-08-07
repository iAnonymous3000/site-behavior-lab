#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  extractCalibrationAcquisitionArchive,
  validateCalibrationGithubArtifactMetadata
} from "./calibration-study-archive-lib.mjs";
import {
  assembleAuthenticatedCalibrationLabels,
  fetchAuthenticatedCalibrationLabelCommitments,
  validateCalibrationLabelSources
} from "./calibration-label-sources-lib.mjs";
import { fetchAuthenticatedCalibrationLabelRoster } from "./calibration-label-roster-lib.mjs";
import {
  canonicalCalibrationAcquisitionText,
  fetchCalibrationAcquisitionAttemptLedger
} from "./calibration-acquisition-authorization-lib.mjs";
import { acquireAssemblyCustody } from "./calibration-assemble-custody-lib.mjs";
import {
  assembleCalibrationStudy,
  assertCalibrationDecisionApproved,
  canonicalPrettyJson,
  inspectCalibrationAcquisition,
  readJsonFile,
  sha256Hex,
  validateCalibrationCandidateFiles,
  writeAssembledCalibration
} from "./calibration-study-lib.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const options = parseOptions(process.argv.slice(2));
// The reveal private key is read only AFTER the pre-acquisition custody
// phase has succeeded (see below): a custody failure must never cost a
// sealed envelope its secrecy. Nothing before that point may touch the
// secret, and the custody phase itself performs no decryption.
const checkoutCommit = git(["rev-parse", "HEAD"]).toLowerCase();
if (checkoutCommit !== options.assemblyHeadCommit) {
  throw new Error("assembly checkout does not match the trusted workflow head");
}
if (git(["status", "--porcelain", "--untracked-files=all"]) !== "") {
  throw new Error("assembly checkout is dirty before calibration output is created");
}

const requireFromRoot = createRequire(import.meta.url);
const bindingModule = requireFromRoot(
  path.join(rootDir, "dist", "schema", "lib", "measurement-candidate-binding.js")
);
const calibration = requireFromRoot(
  path.join(rootDir, "dist", "schema", "lib", "detector-calibration.js")
);
const binding =
  bindingModule.verifiedMeasurementCandidateAcquisitionContext(rootDir, {
    requireCleanWorktree: true
  });
if (!binding) throw new Error("assembly requires a verified measurement-candidate binding");
if (
  binding.candidateCommit !== options.candidateCommit ||
  binding.carrierCommit !== checkoutCommit
) {
  throw new Error("assembly candidate/carrier inputs disagree with the verified binding");
}
const candidate = validateCalibrationCandidateFiles(rootDir, options.studyId);
if (candidate.detector !== options.detector) {
  throw new Error("assembly detector does not match candidate preregistration");
}

const metadata = validateCalibrationGithubArtifactMetadata({
  runMetadataPath: options.runMetadataPath,
  jobMetadataPath: options.jobMetadataPath,
  artifactMetadataPath: options.artifactMetadataPath,
  studyId: options.studyId,
  runId: options.runId,
  runAttempt: options.runAttempt,
  artifactId: options.artifactId,
  artifactName: options.artifactName,
  archiveSha256: options.archiveSha256,
  runnerLabel: options.runnerLabel
});
if (!binding.acceptedProducerCommits.includes(metadata.headCommit)) {
  throw new Error("acquisition Actions head is not an accepted evidence producer commit");
}
git(["merge-base", "--is-ancestor", metadata.headCommit, checkoutCommit]);
extractCalibrationAcquisitionArchive({
  archivePath: options.archivePath,
  destinationDir: options.extractedDir,
  archiveSha256: metadata.archiveSha256,
  archiveBytes: metadata.archiveBytes,
  studyId: options.studyId
});
const acquisitionInspection = inspectCalibrationAcquisition(
  options.extractedDir,
  {
    studyId: options.studyId,
    candidateCommit: options.candidateCommit,
    carrierCommit: metadata.headCommit,
    runId: metadata.runId,
    runAttempt: metadata.runAttempt
  }
);
if (
  Date.parse(acquisitionInspection.acquisition.startedAt) <
    Date.parse(metadata.jobStartedAt) ||
  Date.parse(acquisitionInspection.acquisition.completedAt) >
    Date.parse(metadata.jobCompletedAt)
) {
  throw new Error(
    "self-hosted acquisition timestamps are outside the authenticated Actions job window"
  );
}
if (
  acquisitionInspection.acquisition.runner.labelSha256 !==
    options.runnerLabelSha256 ||
  acquisitionInspection.acquisition.egress.identity !==
    options.egressIdentity ||
  acquisitionInspection.acquisition.egress.regionSha256 !==
    options.egressRegionSha256
) {
  throw new Error("acquisition runner/egress identity disagrees with the freeze-bound assembly inputs");
}
const freezeReceiptPath =
  "research/ops-receipts/measurement-freeze-activation.json";
const freezeReceiptText = readFileSync(
  path.join(rootDir, ...freezeReceiptPath.split("/")),
  "utf8"
);
const freezeReceipt = JSON.parse(freezeReceiptText);
const matchingFreezeIdentities =
  freezeReceipt?.controlledRunner?.onlineMatches?.filter(
    (entry) =>
      entry?.status === "online" &&
      entry?.identitySha256 ===
        acquisitionInspection.acquisition.runner.identitySha256
  ) ?? [];
if (matchingFreezeIdentities.length !== 1) {
  throw new Error(
    "acquisition runner identity is not exactly one freeze-attested online runner"
  );
}
if (
  matchingFreezeIdentities[0].nameSha256 !==
  sha256Hex(`runner-name\u0000${metadata.runnerName}`)
) {
  throw new Error(
    "authenticated acquisition job runner name disagrees with the freeze-attested runner identity"
  );
}
// ---- Pre-acquisition custody phase: the wiring the old refusal guarded. ----
// Re-fetch the roster artifact the authorization pinned, re-derive the
// selection snapshot and attempt ledger from live Actions history, and
// cross-bind all three against the acquisition's own embedded records. Only
// when every identity agrees does the reveal key get read below.
const authorization = acquisitionInspection.acquisition.authorization;
const { custody, roster } = await acquireAssemblyCustody({
  studyId: options.studyId,
  authorization,
  acquisitionSnapshotText: canonicalCalibrationAcquisitionText(
    acquisitionInspection.acquisition.rosterSelectionSnapshot
  ),
  carrierCommit: metadata.headCommit,
  fetchRoster: async () =>
    fetchAuthenticatedCalibrationLabelRoster({
      studyId: options.studyId,
      detector: options.detector,
      candidateCommit: options.candidateCommit,
      carrierCommit: metadata.headCommit,
      labelSealingKey: candidate.labelSealingKey,
      runId: authorization.roster.runId,
      runAttempt: authorization.roster.runAttempt,
      authorizationNonce: authorization.nonce,
      caseInputRootSha256: authorization.caseInputRootSha256,
      scratchDir: path.join(
        path.dirname(options.extractedDir),
        "calibration-roster-custody"
      )
    }),
  fetchAttemptLedger: async () =>
    fetchCalibrationAcquisitionAttemptLedger({ authorization })
});

// Custody held; the sealed envelopes may now be opened.
const revealPrivateKeyPem = requiredSecret(
  "CALIBRATION_LABEL_REVEAL_PRIVATE_KEY"
);
delete process.env.CALIBRATION_LABEL_REVEAL_PRIVATE_KEY;

const assembledAt = new Date().toISOString();
const labelEntries = readdirSync(options.labelsDir, { withFileTypes: true });
if (
  labelEntries.length !== 1 ||
  labelEntries[0].name !== "sources.json" ||
  !lstatSync(path.join(options.labelsDir, "sources.json")).isFile()
) {
  throw new Error(
    "label source commit must contain exactly one sources.json coordinate manifest"
  );
}
const labelSourcesRead = readJsonFile(
  path.join(options.labelsDir, "sources.json"),
  "calibration label sources"
);
const labelSources = validateCalibrationLabelSources(
  labelSourcesRead.value,
  candidate
);
if (
  labelSourcesRead.text !== canonicalPrettyJson(labelSources) ||
  labelSources.candidateCommit !== options.candidateCommit
) {
  throw new Error(
    "calibration label sources are not canonical or do not bind candidate C"
  );
}
const authenticatedCommitments =
  fetchAuthenticatedCalibrationLabelCommitments({
    repository: "iAnonymous3000/site-behavior-lab",
    sources: labelSources,
    candidate,
    acceptedProducerCommits: binding.acceptedProducerCommits,
    isAncestor: (commit) => {
      try {
        git(["merge-base", "--is-ancestor", commit, checkoutCommit]);
        return true;
      } catch {
        return false;
      }
    },
    scratchDir: path.join(
      path.dirname(options.extractedDir),
      "calibration-label-commitment-archives"
    )
  });
const labels = assembleAuthenticatedCalibrationLabels({
  candidate,
  candidateCommit: options.candidateCommit,
  roster,
  commitments: authenticatedCommitments,
  privateKeyPem: revealPrivateKeyPem,
  acquisitionRunStartedAt: metadata.runStartedAt,
  acquisitionJobStartedAt: metadata.jobStartedAt,
  retainedCaseIds: acquisitionInspection.acquisition.cases
    .filter((entry) => entry.outcome === "complete")
    .map((entry) => entry.caseId),
  source: {
    commit: options.labelsCommit,
    tree: options.labelsTree,
    path: options.labelsPath,
    sha256: sha256Hex(labelSourcesRead.text)
  }
});
const releaseIdentity = calibration.currentDetectorCalibrationReleaseIdentity(
  options.detector,
  options.candidateCommit,
  acquisitionInspection.acquisition.runtime
);
const policyDecision = assertCalibrationDecisionApproved(
  JSON.parse(
    readFileSync(path.join(rootDir, "RELEASE_READINESS.json"), "utf8")
  ),
  candidate.policySha256,
  new Date(assembledAt)
);
const assembled = assembleCalibrationStudy({
  candidate,
  acquisitionInspection,
  labels,
  custody,
  releaseIdentity,
  analyze: calibration.analyzeDetectorCalibrationStudy,
  runtimeReceiptArtifact: {
    id: metadata.artifactId,
    name: metadata.artifactName,
    archiveSha256: metadata.archiveSha256,
    bytes: metadata.archiveBytes,
    createdAt: metadata.createdAt,
    expiresAt: metadata.expiresAt
  },
  acquisitionJob: {
    id: metadata.jobId,
    runStartedAt: metadata.runStartedAt,
    runCompletedAt: metadata.runCompletedAt,
    startedAt: metadata.jobStartedAt,
    completedAt: metadata.jobCompletedAt,
    runnerNameSha256: sha256Hex(
      `runner-name\u0000${metadata.runnerName}`
    )
  },
  producerCommit: checkoutCommit,
  policyDecision,
  freezeReceipt: {
    path: freezeReceiptPath,
    sha256: sha256Hex(freezeReceiptText),
    activatedAt: freezeReceipt?.activation?.activatedAt
  },
  assembledAt
});
const policyProblems =
  bindingModule.measurementCalibrationAnalysisPolicyProblems(
    assembled.analysis,
    binding.calibrationPolicy
  );
if (policyProblems.length > 0) {
  throw new Error(
    `assembled calibration study does not satisfy the approved rate policy: ${policyProblems.join("; ")}`
  );
}
writeAssembledCalibration(rootDir, assembled);
console.log(
  `Assembled ${options.studyId}: ${assembled.analysis.status}; ` +
    `${assembled.analysis.denominators.completeCases} complete, ` +
    `${assembled.analysis.denominators.censoredCases} censored.`
);

function parseOptions(args) {
  const names = new Set([
    "--study-id",
    "--detector",
    "--candidate-commit",
    "--assembly-head-commit",
    "--run-metadata",
    "--job-metadata",
    "--artifact-metadata",
    "--archive",
    "--extracted-dir",
    "--labels-dir",
    "--labels-commit",
    "--labels-tree",
    "--labels-path",
    "--run-id",
    "--run-attempt",
    "--artifact-id",
    "--artifact-name",
    "--archive-sha256",
    "--runner-label",
    "--runner-label-sha256",
    "--egress-identity",
    "--egress-region-sha256"
  ]);
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!names.has(name) || !value || value.startsWith("--") || values.has(name)) {
      throw new Error(`Invalid calibration assembly argument ${name ?? "(missing)"}`);
    }
    values.set(name, value);
  }
  for (const name of names) {
    if (!values.has(name)) throw new Error(`Missing required argument ${name}`);
  }
  for (const name of [
    "--run-metadata",
    "--job-metadata",
    "--artifact-metadata",
    "--archive",
    "--extracted-dir",
    "--labels-dir"
  ]) {
    if (!path.isAbsolute(values.get(name))) throw new Error(`${name} must be absolute`);
  }
  for (const name of [
    "--candidate-commit",
    "--assembly-head-commit",
    "--labels-commit",
    "--labels-tree"
  ]) {
    if (!/^[0-9a-f]{40}$/.test(values.get(name))) {
      throw new Error(`${name} must be a full lowercase Git SHA`);
    }
  }
  for (const name of [
    "--archive-sha256",
    "--runner-label-sha256",
    "--egress-region-sha256"
  ]) {
    const normalized = values.get(name).replace(/^sha256:/, "");
    if (!/^[0-9a-f]{64}$/.test(normalized)) throw new Error(`${name} must be a sha256 digest`);
    values.set(name, normalized);
  }
  return {
    studyId: values.get("--study-id"),
    detector: values.get("--detector"),
    candidateCommit: values.get("--candidate-commit"),
    assemblyHeadCommit: values.get("--assembly-head-commit"),
    runMetadataPath: values.get("--run-metadata"),
    jobMetadataPath: values.get("--job-metadata"),
    artifactMetadataPath: values.get("--artifact-metadata"),
    archivePath: values.get("--archive"),
    extractedDir: values.get("--extracted-dir"),
    labelsDir: values.get("--labels-dir"),
    labelsCommit: values.get("--labels-commit"),
    labelsTree: values.get("--labels-tree"),
    labelsPath: values.get("--labels-path"),
    runId: values.get("--run-id"),
    runAttempt: values.get("--run-attempt"),
    artifactId: values.get("--artifact-id"),
    artifactName: values.get("--artifact-name"),
    archiveSha256: values.get("--archive-sha256"),
    runnerLabel: values.get("--runner-label"),
    runnerLabelSha256: values.get("--runner-label-sha256"),
    egressIdentity: values.get("--egress-identity"),
    egressRegionSha256: values.get("--egress-region-sha256")
  };
}

function git(args) {
  return execFileSync("git", args, {
    cwd: rootDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"]
  }).trim();
}

function requiredSecret(name) {
  const value = process.env[name] ?? "";
  if (value.trim() === "") {
    throw new Error(`${name} is required only in the protected reveal job`);
  }
  return value;
}
