#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  canonicalPrettyJson,
  createCalibrationLabelCommitment,
  readJsonFile,
  sha256Hex,
  validateCalibrationCandidateFiles
} from "./calibration-study-lib.mjs";
import {
  CALIBRATION_LABEL_SOURCE_ENVELOPE_KIND,
  CALIBRATION_LABEL_SEALING_ALGORITHM,
  validateCalibrationLabelSourceEnvelope
} from "./calibration-label-source-envelope-lib.mjs";

const options = parseOptions(process.argv.slice(2));
const candidate = validateCalibrationCandidateFiles(
  options.candidateRoot,
  options.studyId
);
if (
  candidate.detector !== options.detector ||
  git(options.candidateRoot, ["rev-parse", "HEAD"]).toLowerCase() !==
    options.candidateCommit
) {
  throw new Error("label batch candidate checkout does not match the frozen study");
}
const sourceRead = readJsonFile(
  path.join(options.sourceRoot, ...options.sourcePath.split("/")),
  "encrypted calibration label batch source",
  64 * 1024 * 1024
);
if (sourceRead.text !== canonicalPrettyJson(sourceRead.value)) {
  throw new Error(
    "encrypted calibration label batch source must be canonical serialized JSON"
  );
}
const actor = requiredEnv("GITHUB_ACTOR").toLowerCase();
const triggeringActor = requiredEnv("GITHUB_TRIGGERING_ACTOR").toLowerCase();
if (actor !== triggeringActor) {
  throw new Error(
    "label commitment dispatch actor and triggering actor must be identical"
  );
}
const envelope = validateCalibrationLabelSourceEnvelope(
  sourceRead.value,
  {
    schemaVersion: 1,
    artifactKind: CALIBRATION_LABEL_SOURCE_ENVELOPE_KIND,
    studyId: options.studyId,
    detector: options.detector,
    role: options.role,
    candidateCommit: options.candidateCommit,
    reviewerLogin: actor,
    algorithm: CALIBRATION_LABEL_SEALING_ALGORITHM,
    keyId: candidate.labelSealingKey.keyId
  }
);
const sourceCommit = git(options.sourceRoot, ["rev-parse", "HEAD"]).toLowerCase();
const sourceTree = git(options.sourceRoot, ["rev-parse", "HEAD^{tree}"]).toLowerCase();
const created = createCalibrationLabelCommitment({
  candidate,
  candidateCommit: options.candidateCommit,
  role: options.role,
  envelope,
  producer: {
    repository: requiredEnv("GITHUB_REPOSITORY"),
    workflowPath: ".github/workflows/calibration-label-batch.yml",
    workflowRef: "refs/heads/main",
    runId: positiveIntegerEnv("GITHUB_RUN_ID"),
    runAttempt: positiveIntegerEnv("GITHUB_RUN_ATTEMPT"),
    headSha: requiredEnv("GITHUB_SHA").toLowerCase(),
    actor,
    triggeringActor
  },
  sourceProvenance: {
    commit: sourceCommit,
    tree: sourceTree,
    path: options.sourcePath,
    sha256: sha256Hex(sourceRead.text)
  }
});
mkdirSync(options.outputDir, { recursive: false, mode: 0o700 });
writeFileSync(path.join(options.outputDir, "commitment.json"), created.text, {
  flag: "wx",
  mode: 0o600
});
console.log(
  `Prepared authenticated ${options.role} ciphertext commitment for ${options.studyId} as ${actor}; no label plaintext was revealed.`
);

function parseOptions(args) {
  const allowed = new Set([
    "--study-id",
    "--detector",
    "--candidate-commit",
    "--candidate-root",
    "--role",
    "--source-root",
    "--source-path",
    "--output-dir"
  ]);
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!allowed.has(name) || !value || value.startsWith("--") || values.has(name)) {
      throw new Error(`Invalid calibration label batch argument ${name ?? "(missing)"}`);
    }
    values.set(name, value);
  }
  for (const name of allowed) {
    if (!values.has(name)) throw new Error(`Missing required argument ${name}`);
  }
  for (const name of ["--candidate-root", "--source-root", "--output-dir"]) {
    if (!path.isAbsolute(values.get(name))) throw new Error(`${name} must be absolute`);
  }
  const sourcePath = values.get("--source-path");
  if (
    !/^[a-z0-9][a-z0-9._/-]{0,499}\.json$/.test(sourcePath) ||
    sourcePath.includes("..") ||
    sourcePath.includes("//") ||
    !/^[0-9a-f]{40}$/.test(values.get("--candidate-commit")) ||
    !["labeler", "tiebreaker"].includes(values.get("--role"))
  ) {
    throw new Error("calibration label batch arguments are malformed");
  }
  return {
    studyId: values.get("--study-id"),
    detector: values.get("--detector"),
    candidateCommit: values.get("--candidate-commit"),
    candidateRoot: values.get("--candidate-root"),
    role: values.get("--role"),
    sourceRoot: values.get("--source-root"),
    sourcePath,
    outputDir: values.get("--output-dir")
  };
}

function positiveIntegerEnv(name) {
  const value = Number(requiredEnv(name));
  if (!Number.isSafeInteger(value) || value <= 0 || (name === "GITHUB_RUN_ATTEMPT" && value > 100)) {
    throw new Error(`${name} must be a bounded positive integer`);
  }
  return value;
}

function requiredEnv(name) {
  const value = process.env[name]?.trim() ?? "";
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"]
  }).trim();
}
