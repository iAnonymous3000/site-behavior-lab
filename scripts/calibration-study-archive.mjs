#!/usr/bin/env node

import path from "node:path";
import {
  extractCalibrationAcquisitionArchive,
  validateCalibrationGithubArtifactMetadata
} from "./calibration-study-archive-lib.mjs";

const options = parseOptions(process.argv.slice(2));
const metadata = validateCalibrationGithubArtifactMetadata(options);
const extracted = extractCalibrationAcquisitionArchive({
  archivePath: options.archivePath,
  destinationDir: options.destinationDir,
  archiveSha256: metadata.archiveSha256,
  archiveBytes: metadata.archiveBytes,
  studyId: options.studyId
});
console.log(
  `Authenticated run ${metadata.runId}/${metadata.runAttempt} and safely extracted ` +
    `${extracted.entries} calibration files (${extracted.uncompressedBytes} bytes).`
);

function parseOptions(args) {
  const names = new Set([
    "--run-metadata",
    "--artifact-metadata",
    "--archive",
    "--destination",
    "--study-id",
    "--run-id",
    "--run-attempt",
    "--artifact-id",
    "--artifact-name",
    "--archive-sha256"
  ]);
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!names.has(name) || !value || value.startsWith("--") || values.has(name)) {
      throw new Error(`Invalid calibration archive argument ${name ?? "(missing)"}`);
    }
    values.set(name, value);
  }
  for (const name of names) {
    if (!values.has(name)) throw new Error(`Missing required argument ${name}`);
  }
  for (const name of [
    "--run-metadata",
    "--artifact-metadata",
    "--archive",
    "--destination"
  ]) {
    if (!path.isAbsolute(values.get(name))) {
      throw new Error(`${name} must be an absolute path`);
    }
  }
  return {
    runMetadataPath: values.get("--run-metadata"),
    artifactMetadataPath: values.get("--artifact-metadata"),
    archivePath: values.get("--archive"),
    destinationDir: values.get("--destination"),
    studyId: values.get("--study-id"),
    runId: values.get("--run-id"),
    runAttempt: values.get("--run-attempt"),
    artifactId: values.get("--artifact-id"),
    artifactName: values.get("--artifact-name"),
    archiveSha256: values.get("--archive-sha256")
  };
}
