#!/usr/bin/env node
/**
 * Mint ONE authenticated ciphertext commitment for the v4 prevalence pilot.
 * This runs INSIDE the hosted workflow and nowhere else.
 *
 * WHY A SEPARATE PRODUCER. The v3 builder demands a preregistration.json and
 * frame.json that a pilot carrier cannot have: a pilot has a frame-tasks
 * artifact and a 100-case set, and the structural floor for the v3 candidate
 * is 200 planned cases. Manufacturing those files to satisfy a validator
 * would be forging the evidence the validator exists to check. So the pilot
 * gets its own thin producer, and REUSES every shared contract underneath:
 * the commitment constructor, the envelope validator, the envelope-digest
 * function, and the record shape. There is no second record schema.
 *
 * WHAT IT READS, AND FROM WHERE. Everything but the reviewer's sealed
 * envelope comes from the TRUSTED checkout the workflow made at github.sha:
 * the frame, its tasks, the carrier record, the sealing public key, and the
 * approval. Reading the frame from a reviewer-supplied ref instead would let
 * a reviewer with dispatch rights mint an authorized commitment against a
 * frame they edited, because a frame's task digests are stored inside the
 * frame itself and would agree with a doctored case list.
 *
 * WHAT IT NEVER DOES. It does not open the envelope. The plaintext stays
 * sealed until the operator's offline reveal, which is the entire point of
 * committing ciphertext first.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CALIBRATION_V4_PILOT_LABEL_WORKFLOW_PATH,
  canonicalPrettyJson,
  createCalibrationLabelCommitment,
  sha256Hex
} from "./calibration-study-lib.mjs";
import {
  CALIBRATION_LABEL_SEALING_ALGORITHM,
  CALIBRATION_LABEL_SOURCE_ENVELOPE_KIND,
  calibrationLabelPublicKeyIdentity
} from "./calibration-label-source-envelope-lib.mjs";
import {
  parseV4FrameTasksBytes,
  requireApprovedCensoringPolicyAssignments,
  requireFrameMatchesApprovedArtifact,
  verifyV4TaskBytes
} from "./calibration-v4-ceremony-lib.mjs";
import { PILOT_CARRIER_FILE } from "./calibration-v4-pilot-carrier-lib.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const USAGE =
  "usage: calibration-v4-pilot-commitment-build.mjs --study-id <id> --role labeler|tiebreaker --source-root <dir> --source-path <path> --output-dir <dir>";

function fail(message) {
  console.error(`calibration:v4-pilot-commitment-build: ${message}`);
  process.exit(1);
}

function requiredEnv(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value.length === 0) fail(`${name} is required`);
  return value;
}

function positiveIntegerEnv(name) {
  const value = Number(requiredEnv(name));
  if (!Number.isSafeInteger(value) || value <= 0) fail(`${name} must be a positive integer`);
  return value;
}

const required = new Set(["--study-id", "--role", "--source-root", "--source-path", "--output-dir"]);
const values = new Map();
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 2) {
  const name = args[index];
  const value = args[index + 1];
  if (!required.has(name) || !value || value.startsWith("--") || values.has(name)) fail(USAGE);
  values.set(name, value);
}
for (const name of required) {
  if (!values.has(name)) fail(`Missing required argument ${name}\n${USAGE}`);
}

const studyId = values.get("--study-id");
if (!/^[a-z0-9][a-z0-9._-]{0,99}$/.test(studyId)) fail("study id is not a study id");
const role = values.get("--role");
if (role !== "labeler" && role !== "tiebreaker") fail("role must be labeler or tiebreaker");
const sourcePath = values.get("--source-path");
if (!/^[a-z0-9][a-z0-9._/-]{0,499}\.json$/.test(sourcePath) || sourcePath.includes("..") || sourcePath.includes("//")) {
  fail("source path is not a plain repository-relative json path");
}

// ONE authenticated identity. The workflow checks this too; a producer that
// trusted the workflow to have checked would be a producer that cannot be
// tested on its own.
const actor = requiredEnv("GITHUB_ACTOR").toLowerCase();
const triggeringActor = requiredEnv("GITHUB_TRIGGERING_ACTOR").toLowerCase();
if (actor !== triggeringActor) {
  fail("dispatch actor and triggering actor must be identical; a delegated dispatch is not an authenticated reviewer");
}

const studyDir = path.join(repoRoot, "calibration", studyId);
let frameTasks;
let carrier;
let sealingKeyId;
try {
  const frameBytes = readFileSync(path.join(studyDir, "frame-tasks.json"), "utf8");
  frameTasks = parseV4FrameTasksBytes(frameBytes);
  const { artifact } = requireApprovedCensoringPolicyAssignments({
    rootDir: repoRoot,
    detector: frameTasks.detector
  });
  requireFrameMatchesApprovedArtifact(frameTasks, artifact);
  const taskBytesByCaseId = new Map();
  for (const file of readdirSync(path.join(studyDir, "tasks"))) {
    if (!file.endsWith(".json")) fail(`${file} in the tasks directory is not a task file`);
    taskBytesByCaseId.set(
      file.slice(0, -".json".length),
      readFileSync(path.join(studyDir, "tasks", file), "utf8")
    );
  }
  verifyV4TaskBytes({ frameTasks, taskBytesByCaseId });
  const carrierBytes = readFileSync(path.join(studyDir, PILOT_CARRIER_FILE), "utf8");
  if (!/^[0-9a-f]{40}\n$/.test(carrierBytes)) fail(`${PILOT_CARRIER_FILE} must be one 40-hex sha and a newline`);
  carrier = carrierBytes.trim();
  if (frameTasks.candidateCommit !== carrier) {
    fail(`the committed frame binds ${frameTasks.candidateCommit}, and ${PILOT_CARRIER_FILE} names ${carrier}`);
  }
  if (frameTasks.studyId !== studyId) fail(`the committed frame is for ${frameTasks.studyId}, not ${studyId}`);
  sealingKeyId = calibrationLabelPublicKeyIdentity(
    readFileSync(path.join(studyDir, "label-sealing-public-key.pem"), "utf8")
  ).keyId;
} catch (error) {
  fail(error.message);
}

// The reviewer's sealed envelope is the ONE reviewer-controlled input, and it
// is read as data from a detached worktree, never executed.
let envelopeValue;
let sourceDigest;
let sourceCommit;
let sourceTree;
try {
  const sourceRoot = values.get("--source-root");
  const inSource = (args, { binary = false } = {}) => {
    const result = spawnSync("git", ["-C", sourceRoot, ...args], {
      encoding: binary ? null : "utf8",
      maxBuffer: 16 * 1024 * 1024
    });
    if (result.status !== 0) {
      fail(`git ${args.join(" ")} in the source worktree failed`);
    }
    return binary ? result.stdout : result.stdout.trim().toLowerCase();
  };
  sourceCommit = inSource(["rev-parse", "HEAD"]);
  sourceTree = inSource(["rev-parse", "HEAD^{tree}"]);
  const declared = requiredEnv("CALIBRATION_SOURCE_COMMIT").toLowerCase();
  if (sourceCommit !== declared) {
    fail(`the source worktree is at ${sourceCommit}, and the dispatch named ${declared}`);
  }
  // Read the blob BY COMMIT IDENTITY, never through the worktree filesystem.
  // Otherwise an untracked file or a committed symlink could be followed and
  // wrapped while the record falsely claimed the bytes lived at this path in
  // sourceCommit. `cat-file blob` also bounds the read and makes a symlink's
  // own blob (its target text) the bytes that must validate as the envelope.
  const sourceBlob = inSource(["cat-file", "blob", `${sourceCommit}:${sourcePath}`], {
    binary: true
  });
  const sourceBytes = sourceBlob.toString("utf8");
  if (!sourceBlob.equals(Buffer.from(sourceBytes, "utf8"))) {
    fail("the sealed envelope blob must be UTF-8");
  }
  envelopeValue = JSON.parse(sourceBytes);
  if (sourceBytes !== canonicalPrettyJson(envelopeValue)) {
    fail("the sealed envelope must be canonical serialized JSON");
  }
  sourceDigest = sha256Hex(sourceBlob);
} catch (error) {
  fail(`sealed envelope: ${error.message}`);
}

// The candidate projection is built from artifacts the pilot really has: the
// committed frame and the committed public key. Nothing is manufactured.
const candidate = {
  studyId: frameTasks.studyId,
  detector: frameTasks.detector,
  labelSealingKey: { algorithm: CALIBRATION_LABEL_SEALING_ALGORITHM, keyId: sealingKeyId }
};

let created;
try {
  const { validateCalibrationLabelSourceEnvelope } = await import("./calibration-label-source-envelope-lib.mjs");
  const envelope = validateCalibrationLabelSourceEnvelope(envelopeValue, {
    schemaVersion: 1,
    artifactKind: CALIBRATION_LABEL_SOURCE_ENVELOPE_KIND,
    studyId: frameTasks.studyId,
    detector: frameTasks.detector,
    role,
    candidateCommit: carrier,
    reviewerLogin: actor,
    algorithm: CALIBRATION_LABEL_SEALING_ALGORITHM,
    keyId: sealingKeyId
  });
  created = createCalibrationLabelCommitment({
    candidate,
    candidateCommit: carrier,
    role,
    envelope,
    expectedWorkflowPath: CALIBRATION_V4_PILOT_LABEL_WORKFLOW_PATH,
    producer: {
      repository: requiredEnv("GITHUB_REPOSITORY"),
      workflowPath: CALIBRATION_V4_PILOT_LABEL_WORKFLOW_PATH,
      workflowRef: "refs/heads/main",
      runId: positiveIntegerEnv("GITHUB_RUN_ID"),
      runAttempt: positiveIntegerEnv("GITHUB_RUN_ATTEMPT"),
      headSha: requiredEnv("GITHUB_SHA").toLowerCase(),
      actor,
      triggeringActor
    },
    // The reviewer's source provenance, read from the data-only worktree the
    // workflow made: which commit, which tree, which path, and the digest of
    // the exact bytes wrapped. Same shape the v3 producer records.
    sourceProvenance: {
      commit: sourceCommit,
      tree: sourceTree,
      path: sourcePath,
      sha256: sourceDigest
    }
  });
} catch (error) {
  fail(error.message);
}

mkdirSync(values.get("--output-dir"), { recursive: false, mode: 0o700 });
writeFileSync(path.join(values.get("--output-dir"), "commitment.json"), created.text, {
  flag: "wx",
  mode: 0o600
});
console.log(
  `authenticated ${role} commitment for ${frameTasks.studyId} under ${actor}: envelope ${created.commitment.envelopeSha256.slice(0, 16)}, carrier ${carrier.slice(0, 12)}. The plaintext was not opened.`
);
