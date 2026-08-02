#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AA_PRODUCER_BUNDLE_FILE,
  AA_PRODUCER_RECEIPT_FILE,
  AA_PRODUCER_REPOSITORY,
  AA_ARCHIVE_WORKFLOW,
  addAaStudyEvidenceToMeasurementBinding,
  canonicalAaJson,
  inspectAaArtifact,
  verifyAaProducerReceiptAgainstArtifact
} from "./aa-study-producer-lib.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const options = parseOptions(process.argv.slice(2));
const checkoutCommit = git(["rev-parse", "HEAD"]).toLowerCase();
if (checkoutCommit !== options.carrierCommit) {
  throw new Error("A/A archive checkout does not equal the workflow carrier");
}
if (git(["status", "--porcelain", "--untracked-files=all"]) !== "") {
  throw new Error("A/A archive checkout is dirty before readback");
}
const inspection = inspectAaArtifact(options.artifactDirectory, {
  studyId: options.studyId,
  candidateCommit: options.candidateCommit
});
const receiptPath = path.join(
  options.attestedDirectory,
  AA_PRODUCER_RECEIPT_FILE
);
const bundlePath = path.join(
  options.attestedDirectory,
  AA_PRODUCER_BUNDLE_FILE
);
const handoffEntries = readdirSync(options.attestedDirectory, {
  withFileTypes: true
});
if (
  !handoffEntries.every((entry) => entry.isFile()) ||
  JSON.stringify(handoffEntries.map((entry) => entry.name).sort()) !==
    JSON.stringify(
      [AA_PRODUCER_BUNDLE_FILE, AA_PRODUCER_RECEIPT_FILE].sort()
    )
) {
  throw new Error("A/A attested handoff must contain exactly two regular files");
}
const receiptText = readFileSync(receiptPath, "utf8");
const receipt = JSON.parse(receiptText);
if (receiptText !== canonicalAaJson(receipt)) {
  throw new Error("A/A producer receipt is not canonical JSON");
}
verifyAaProducerReceiptAgainstArtifact(receipt, inspection);
if (
  receipt.studyId !== options.studyId ||
  receipt.producer.checkoutCommit !== options.candidateCommit ||
  receipt.attester.sourceCommit !== options.carrierCommit ||
  receipt.producer.conclusion !== "success"
) {
  throw new Error("A/A receipt study, candidate, conclusion, or attester head is inconsistent");
}
const bundle = readFileSync(bundlePath);
if (bundle.byteLength <= 0 || bundle.byteLength > 16 * 1024 * 1024) {
  throw new Error("A/A attestation bundle is empty or outside its bound");
}
JSON.parse(bundle.toString("utf8"));
const gh = execFileSync(
  process.execPath,
  [path.join(rootDir, "scripts", "ensure-gh-attestation-verifier.mjs")],
  {
    cwd: rootDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"]
  }
).trim();
const verification = execFileSync(
  gh,
  [
    "attestation",
    "verify",
    receiptPath,
    "--bundle",
    bundlePath,
    "--repo",
    AA_PRODUCER_REPOSITORY,
    "--cert-identity",
    `https://github.com/${AA_ARCHIVE_WORKFLOW}`,
    "--signer-digest",
    receipt.attester.sourceCommit,
    "--source-digest",
    receipt.attester.sourceCommit,
    "--source-ref",
    "refs/heads/main",
    "--predicate-type",
    "https://slsa.dev/provenance/v1",
    "--cert-oidc-issuer",
    "https://token.actions.githubusercontent.com",
    "--deny-self-hosted-runners",
    "--format",
    "json"
  ],
  {
    cwd: rootDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 16 * 1024 * 1024
  }
);
const verified = JSON.parse(verification);
if (!Array.isArray(verified) || verified.length === 0) {
  throw new Error("A/A receipt attestation returned no verified result");
}

const destination = path.join(
  rootDir,
  "research",
  "aa-studies",
  options.studyId
);
mkdirSync(destination, { recursive: true, mode: 0o755 });
const destinationInfo = lstatSync(destination);
const studiesRoot = path.join(rootDir, "research", "aa-studies");
if (
  !destinationInfo.isDirectory() ||
  destinationInfo.isSymbolicLink() ||
  !path
    .relative(studiesRoot, destination)
    .split(path.sep)
    .every((part) => part !== "..")
) {
  throw new Error("A/A archive destination is not a real study-local directory");
}
for (const file of ["preregistration.json", "target-frame.json"]) {
  const existing = path.join(destination, file);
  const incoming = path.join(options.artifactDirectory, file);
  if (
    !existsSync(existing) ||
    !readFileSync(existing).equals(readFileSync(incoming))
  ) {
    throw new Error(`A/A archive ${file} does not equal the candidate-resident bytes`);
  }
}
for (const [source, filename] of [
  [path.join(options.artifactDirectory, "attempt-ledger.json"), "attempt-ledger.json"],
  [path.join(options.artifactDirectory, "evaluation.json"), "evaluation.json"],
  [receiptPath, AA_PRODUCER_RECEIPT_FILE],
  [bundlePath, AA_PRODUCER_BUNDLE_FILE]
]) {
  const target = path.join(destination, filename);
  if (existsSync(target)) throw new Error(`A/A archive target already exists: ${filename}`);
  copyFileSync(source, target, fsConstants.COPYFILE_EXCL);
}
addAaStudyEvidenceToMeasurementBinding(
  rootDir,
  options.studyId,
  receipt
);
console.log(
  `Archived authenticated A/A evidence for ${options.studyId} and updated the measurement binding.`
);

function parseOptions(args) {
  const names = new Set([
    "--artifact-dir",
    "--attested-dir",
    "--study-id",
    "--candidate-commit",
    "--carrier-commit"
  ]);
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (
      !names.has(name) ||
      !value ||
      value.startsWith("--") ||
      values.has(name)
    ) {
      throw new Error(`Invalid A/A archive argument ${name ?? "(missing)"}`);
    }
    values.set(name, value);
  }
  for (const name of names) {
    if (!values.has(name)) throw new Error(`Missing A/A archive argument ${name}`);
  }
  for (const name of ["--artifact-dir", "--attested-dir"]) {
    if (!path.isAbsolute(values.get(name))) {
      throw new Error(`${name} must be absolute`);
    }
  }
  for (const name of ["--candidate-commit", "--carrier-commit"]) {
    if (!/^[0-9a-f]{40}$/.test(values.get(name))) {
      throw new Error(`${name} must be a full lowercase Git SHA`);
    }
  }
  return {
    artifactDirectory: values.get("--artifact-dir"),
    attestedDirectory: values.get("--attested-dir"),
    studyId: values.get("--study-id"),
    candidateCommit: values.get("--candidate-commit"),
    carrierCommit: values.get("--carrier-commit")
  };
}

function git(args) {
  return execFileSync("git", args, {
    cwd: rootDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"]
  }).trim();
}
