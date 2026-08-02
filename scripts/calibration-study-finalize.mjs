#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  addAssembledCalibrationToMeasurementBinding,
  canonicalPrettyJson,
  readJsonFile,
  sha256Hex,
  validateCalibrationCandidateFiles
} from "./calibration-study-lib.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const options = parseOptions(process.argv.slice(2));
const candidate = validateCalibrationCandidateFiles(
  rootDir,
  options.studyId
);
if (candidate.preregistration.detector !== options.detector) {
  throw new Error("finalization detector does not match the preregistered study");
}

const studyRoot = `calibration/${options.studyId}`;
const corePaths = {
  study: `${studyRoot}/study.json`,
  analysis: `${studyRoot}/analysis.json`,
  runtimeReceipt: `${studyRoot}/runtime-receipt.json`,
  artifactManifest: `${studyRoot}/artifact-manifest.json`,
  labelsManifest: `${studyRoot}/labels-manifest.json`,
  bundle: `${studyRoot}/runtime-receipt.sigstore.json`
};
const studyRead = readJsonFile(
  absolute(corePaths.study),
  corePaths.study
);
const analysisRead = readJsonFile(
  absolute(corePaths.analysis),
  corePaths.analysis
);
const receiptRead = readJsonFile(
  absolute(corePaths.runtimeReceipt),
  corePaths.runtimeReceipt
);
const manifestRead = readJsonFile(
  absolute(corePaths.artifactManifest),
  corePaths.artifactManifest
);
const labelsManifestRead = readJsonFile(
  absolute(corePaths.labelsManifest),
  corePaths.labelsManifest
);
for (const [label, read] of [
  ["study", studyRead],
  ["analysis", analysisRead],
  ["runtime receipt", receiptRead],
  ["artifact manifest", manifestRead],
  ["labels manifest", labelsManifestRead]
]) {
  if (read.text !== canonicalPrettyJson(read.value)) {
    throw new Error(`${label} is not canonical pretty JSON`);
  }
}
if (
  studyRead.value?.release?.buildCommit !== options.candidateCommit ||
  receiptRead.value?.candidateCommit !== options.candidateCommit ||
  receiptRead.value?.producerCommit !== git(["rev-parse", "HEAD^"])
) {
  throw new Error(
    "prepared calibration carrier does not bind candidate C and its trusted producer parent"
  );
}
const outputs = receiptRead.value?.outputs;
if (
  outputs?.studySha256 !== sha256Hex(studyRead.text) ||
  outputs?.analysisSha256 !== sha256Hex(analysisRead.text) ||
  outputs?.artifactManifestSha256 !== sha256Hex(manifestRead.text) ||
  outputs?.labelsManifestSha256 !== sha256Hex(labelsManifestRead.text)
) {
  throw new Error("prepared calibration outputs do not match the attested receipt");
}
verifyManifestArtifacts(manifestRead.value, studyRoot);

const bundleBytes = readFileSync(options.bundleSource);
if (bundleBytes.byteLength < 2 || bundleBytes.byteLength > 32 * 1024 * 1024) {
  throw new Error("calibration attestation bundle is outside the byte bound");
}
JSON.parse(bundleBytes.toString("utf8"));
const bundlePath = absolute(corePaths.bundle);
mkdirSync(path.dirname(bundlePath), { recursive: true, mode: 0o755 });
writeFileSync(bundlePath, bundleBytes, { flag: "wx", mode: 0o644 });

const assembled = {
  study: studyRead.value,
  files: [
    { path: corePaths.study, text: studyRead.text },
    { path: corePaths.analysis, text: analysisRead.text },
    { path: corePaths.runtimeReceipt, text: receiptRead.text },
    { path: corePaths.artifactManifest, text: manifestRead.text },
    { path: corePaths.labelsManifest, text: labelsManifestRead.text }
  ]
};
const entry = addAssembledCalibrationToMeasurementBinding(
  rootDir,
  candidate,
  assembled,
  {
    path: corePaths.bundle,
    sha256: sha256Hex(bundleBytes)
  }
);
console.log(
  `Finalized ${options.studyId} with attested receipt ${entry.runtimeReceiptSha256}.`
);

function verifyManifestArtifacts(manifest, expectedRoot) {
  if (
    manifest?.schemaVersion !== 1 ||
    manifest?.artifactKind !==
      "site-behavior-detector-calibration-artifact-manifest" ||
    manifest?.studyId !== options.studyId ||
    !Array.isArray(manifest.artifacts)
  ) {
    throw new Error("calibration artifact manifest identity is invalid");
  }
  const expected = [];
  for (const artifact of manifest.artifacts) {
    if (
      typeof artifact?.path !== "string" ||
      !artifact.path.startsWith(`${expectedRoot}/artifacts/`) ||
      typeof artifact.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(artifact.sha256)
    ) {
      throw new Error("calibration artifact manifest contains an invalid path or digest");
    }
    const bytes = readFileSync(absolute(artifact.path));
    if (sha256Hex(bytes) !== artifact.sha256) {
      throw new Error(`calibration artifact digest mismatch at ${artifact.path}`);
    }
    expected.push(artifact.path);
  }
  if (
    new Set(expected).size !== expected.length ||
    JSON.stringify(expected) !== JSON.stringify([...expected].sort())
  ) {
    throw new Error("calibration artifact manifest paths must be unique and sorted");
  }
}

function parseOptions(args) {
  const allowed = new Set([
    "--study-id",
    "--detector",
    "--candidate-commit",
    "--bundle-source"
  ]);
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (
      !allowed.has(name) ||
      !value ||
      value.startsWith("--") ||
      values.has(name)
    ) {
      throw new Error(`Invalid calibration finalization argument ${name ?? "(missing)"}`);
    }
    values.set(name, value);
  }
  for (const name of allowed) {
    if (!values.has(name)) throw new Error(`Missing required argument ${name}`);
  }
  if (
    !/^[a-z0-9][a-z0-9._-]{0,99}$/.test(values.get("--study-id")) ||
    !/^[a-z0-9][a-z0-9-]{0,99}$/.test(values.get("--detector")) ||
    !/^[0-9a-f]{40}$/.test(values.get("--candidate-commit")) ||
    !path.isAbsolute(values.get("--bundle-source"))
  ) {
    throw new Error("calibration finalization arguments are malformed");
  }
  return {
    studyId: values.get("--study-id"),
    detector: values.get("--detector"),
    candidateCommit: values.get("--candidate-commit"),
    bundleSource: values.get("--bundle-source")
  };
}

function absolute(relative) {
  const resolved = path.resolve(rootDir, ...relative.split("/"));
  if (!resolved.startsWith(`${rootDir}${path.sep}`)) {
    throw new Error("calibration finalization path escapes the repository");
  }
  return resolved;
}

function git(args) {
  return execFileSync("git", args, {
    cwd: rootDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"]
  }).trim();
}
