#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import {
  canonicalAaJson,
  createAaProducerReceipt,
  inspectAaArtifact,
  validateAaGithubMetadata,
  verifyAaProducerReceiptAgainstArtifact
} from "./aa-study-producer-lib.mjs";
import { sha256Hex } from "./scanner-fidelity-study-lib.mjs";

const options = parseOptions(process.argv.slice(2));
const requireFromCheckout = createRequire(
  path.join(options.checkoutRoot, "package.json")
);
const bindingModule = requireFromCheckout(
  path.join(
    options.checkoutRoot,
    "dist",
    "schema",
    "lib",
    "measurement-candidate-binding.js"
  )
);
const binding =
  bindingModule.verifiedMeasurementCandidateAcquisitionContext(
    options.checkoutRoot,
    { requireCleanWorktree: true }
  );
if (
  !binding ||
  binding.candidateCommit !== options.candidateCommit ||
  binding.carrierCommit !== options.attesterCommit ||
  !binding.acceptedProducerCommits.includes(options.runHeadCommit)
) {
  throw new Error(
    "A/A run head and candidate are not accepted by the verified measurement binding"
  );
}
const inspection = inspectAaArtifact(options.artifactDirectory, {
  studyId: options.studyId,
  candidateCommit: options.candidateCommit
});
if (
  inspection.manifest.producer.runHeadCommit !== options.runHeadCommit ||
  inspection.manifest.producer.runId !== Number(options.runId) ||
  inspection.manifest.producer.runAttempt !== Number(options.runAttempt) ||
  inspection.manifest.runner.labelSha256 !== options.runnerLabelSha256 ||
  inspection.manifest.runner.identitySha256 !== options.runnerIdentitySha256 ||
  inspection.manifest.egress.identity !== options.egressIdentity ||
  inspection.manifest.egress.regionSha256 !== options.egressRegionSha256
) {
  throw new Error("A/A artifact disagrees with the independently passed governed context");
}
for (const file of ["preregistration.json", "target-frame.json"]) {
  const candidateBytes = execFileSync(
    "git",
    ["show", `${options.candidateCommit}:research/aa-studies/${options.studyId}/${file}`],
    {
      cwd: options.checkoutRoot,
      encoding: null,
      stdio: ["ignore", "pipe", "inherit"],
      maxBuffer: 32 * 1024 * 1024
    }
  );
  const artifactBytes = readFileSync(
    path.join(options.artifactDirectory, file)
  );
  if (!candidateBytes.equals(artifactBytes)) {
    throw new Error(`A/A artifact ${file} does not equal the frozen candidate blob`);
  }
}
const metadata = validateAaGithubMetadata({
  runMetadataPath: options.runMetadataPath,
  artifactMetadataPath: options.artifactMetadataPath,
  studyId: options.studyId,
  runId: options.runId,
  runAttempt: options.runAttempt,
  artifactId: options.artifactId,
  artifactName: options.artifactName,
  archiveSha256: options.archiveSha256,
  runHeadCommit: options.runHeadCommit
});
const receipt = createAaProducerReceipt({
  artifactInspection: inspection,
  metadata,
  attesterCommit: options.attesterCommit,
  recordedAt: new Date().toISOString()
});
verifyAaProducerReceiptAgainstArtifact(receipt, inspection);
const receiptText = canonicalAaJson(receipt);
writeFileSync(options.outputPath, receiptText, {
  encoding: "utf8",
  flag: "wx",
  mode: 0o600
});
const output = process.env.GITHUB_OUTPUT?.trim();
if (output) {
  appendFileSync(
    output,
    `receipt_sha256=${sha256Hex(receiptText)}\n`,
    "utf8"
  );
}
console.log(
  `Authenticated A/A run ${metadata.runId}/${metadata.runAttempt}, artifact ${metadata.artifactId}, and exact passing evidence.`
);

function parseOptions(args) {
  const names = new Set([
    "--checkout-root",
    "--artifact-dir",
    "--run-metadata",
    "--artifact-metadata",
    "--output",
    "--study-id",
    "--candidate-commit",
    "--run-head-commit",
    "--attester-commit",
    "--run-id",
    "--run-attempt",
    "--artifact-id",
    "--artifact-name",
    "--archive-sha256",
    "--runner-label-sha256",
    "--runner-identity-sha256",
    "--egress-identity",
    "--egress-region-sha256"
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
      throw new Error(`Invalid A/A attestation argument ${name ?? "(missing)"}`);
    }
    values.set(name, value);
  }
  for (const name of names) {
    if (!values.has(name)) throw new Error(`Missing A/A attestation argument ${name}`);
  }
  for (const name of [
    "--checkout-root",
    "--artifact-dir",
    "--run-metadata",
    "--artifact-metadata",
    "--output"
  ]) {
    if (!path.isAbsolute(values.get(name))) {
      throw new Error(`${name} must be absolute`);
    }
  }
  for (const name of [
    "--candidate-commit",
    "--run-head-commit",
    "--attester-commit"
  ]) {
    if (!/^[0-9a-f]{40}$/.test(values.get(name))) {
      throw new Error(`${name} must be a full lowercase Git SHA`);
    }
  }
  for (const name of [
    "--archive-sha256",
    "--runner-label-sha256",
    "--runner-identity-sha256",
    "--egress-region-sha256"
  ]) {
    const normalized = values.get(name).replace(/^sha256:/, "");
    if (!/^[0-9a-f]{64}$/.test(normalized)) {
      throw new Error(`${name} must be a sha256 digest`);
    }
    values.set(name, normalized);
  }
  return {
    checkoutRoot: values.get("--checkout-root"),
    artifactDirectory: values.get("--artifact-dir"),
    runMetadataPath: values.get("--run-metadata"),
    artifactMetadataPath: values.get("--artifact-metadata"),
    outputPath: values.get("--output"),
    studyId: values.get("--study-id"),
    candidateCommit: values.get("--candidate-commit"),
    runHeadCommit: values.get("--run-head-commit"),
    attesterCommit: values.get("--attester-commit"),
    runId: values.get("--run-id"),
    runAttempt: values.get("--run-attempt"),
    artifactId: values.get("--artifact-id"),
    artifactName: values.get("--artifact-name"),
    archiveSha256: values.get("--archive-sha256"),
    runnerLabelSha256: values.get("--runner-label-sha256"),
    runnerIdentitySha256: values.get("--runner-identity-sha256"),
    egressIdentity: values.get("--egress-identity"),
    egressRegionSha256: values.get("--egress-region-sha256")
  };
}
