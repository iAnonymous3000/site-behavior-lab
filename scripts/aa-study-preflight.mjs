#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  aaExecutionPlan
} from "./aa-study-producer-lib.mjs";
import {
  aaTargetFramePath
} from "./aa-study-lib.mjs";
import {
  scannerFidelitySitesOf,
  sha256Hex
} from "./scanner-fidelity-study-lib.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const phase = process.argv[2];
if (
  (phase !== "--dispatch" && phase !== "--acquisition") ||
  process.argv.length !== 3
) {
  throw new Error("Usage: aa-study-preflight.mjs --dispatch|--acquisition");
}
const studyId = requiredEnv("AA_STUDY_ID");
if (!/^[a-z0-9][a-z0-9._-]{0,99}$/.test(studyId)) {
  throw new Error("AA_STUDY_ID is invalid");
}
const requestedCandidate = requiredEnv("AA_CANDIDATE_COMMIT").toLowerCase();
const eventCommit = requiredEnv("GITHUB_SHA").toLowerCase();
const checkoutCommit = git(["rev-parse", "HEAD"]).toLowerCase();
if (
  checkoutCommit !== eventCommit ||
  requiredEnv("GITHUB_REPOSITORY") !==
    "iAnonymous3000/site-behavior-lab" ||
  requiredEnv("GITHUB_EVENT_NAME") !== "workflow_dispatch" ||
  requiredEnv("GITHUB_REF") !== "refs/heads/main"
) {
  throw new Error("A/A preflight requires the exact governed workflow head on main");
}
if (git(["status", "--porcelain", "--untracked-files=all"]) !== "") {
  throw new Error("Trusted A/A carrier checkout is dirty");
}

const requireFromRoot = createRequire(import.meta.url);
const bindingModule = requireFromRoot(
  path.join(
    rootDir,
    "dist",
    "schema",
    "lib",
    "measurement-candidate-binding.js"
  )
);
const binding =
  bindingModule.verifiedMeasurementCandidateAcquisitionContext(rootDir, {
    requireCleanWorktree: true
  });
if (!binding) {
  throw new Error("A verified measurement candidate is required for A/A");
}
if (
  binding.candidateCommit !== requestedCandidate ||
  binding.carrierCommit !== checkoutCommit ||
  !binding.acceptedProducerCommits.includes(checkoutCommit)
) {
  throw new Error("A/A dispatch candidate/carrier does not match the verified binding");
}

const studyRoot = path.join(rootDir, "research", "aa-studies", studyId);
const preregistrationPath = `research/aa-studies/${studyId}/preregistration.json`;
const framePath = aaTargetFramePath(studyId);
const preregistrationText = readFileSync(
  path.join(studyRoot, "preregistration.json"),
  "utf8"
);
const frameText = readFileSync(path.join(studyRoot, "target-frame.json"), "utf8");
const preregistration = JSON.parse(preregistrationText);
const targetFrame = JSON.parse(frameText);
aaExecutionPlan(preregistration);
const sites = scannerFidelitySitesOf(targetFrame);
if (
  preregistration.studyId !== studyId ||
  preregistration.sitesFile !== framePath ||
  preregistration.targetCount !== sites.length ||
  preregistration.sitesFileDigest !== sha256Hex(frameText) ||
  preregistration.measurementIdentityDigest !==
    binding.measurementIdentity.manifestSha256 ||
  Date.parse(preregistration.declaredAt) >= Date.now()
) {
  throw new Error("A/A preregistration is not a prior exact binding of the candidate frame");
}
const candidateInputs = new Map(
  binding.measurementInputs.inputs.map((entry) => [entry.path, entry.sha256])
);
if (
  candidateInputs.get(preregistrationPath) !== sha256Hex(preregistrationText) ||
  candidateInputs.get(framePath) !== sha256Hex(frameText)
) {
  throw new Error("A/A preregistration and frame are not exact candidate inputs");
}

const runnerLabel = requiredCanonicalEnv("FEATURED_RUNNER_LABEL");
const scannerEgress = requiredCanonicalEnv("SCANNER_EGRESS");
const scannerEgressRegion = requiredCanonicalEnv("SCANNER_EGRESS_REGION");
if (
  requiredEnv("SITE_BEHAVIOR_LAB_MEASUREMENT_FREEZE") !== "1" ||
  requiredEnv("FEATURED_R2_EGRESS_ATTESTED") !== "1" ||
  runnerLabel === "ubuntu-latest" ||
  runnerLabel === "self-hosted" ||
  scannerEgress !== "controlled-self-hosted"
) {
  throw new Error("A/A requires the activated freeze and dedicated controlled runner/egress");
}
const runnerLabelSha256 = sha256Hex(`runner-label\u0000${runnerLabel}`);
const egressRegionSha256 = sha256Hex(
  `scanner-egress-region\u0000${scannerEgressRegion}`
);
const freeze = JSON.parse(
  readFileSync(
    path.join(
      rootDir,
      "research",
      "ops-receipts",
      "measurement-freeze-activation.json"
    ),
    "utf8"
  )
);
if (
  freeze?.safeConfiguration?.measurementFreeze !== "1" ||
  freeze?.safeConfiguration?.runnerLabelSha256 !==
    runnerLabelSha256 ||
  freeze?.safeConfiguration?.scannerEgress !== scannerEgress ||
  freeze?.safeConfiguration?.scannerEgressRegionSha256 !==
    egressRegionSha256 ||
  freeze?.safeConfiguration?.featuredR2EgressAttested !== "1"
) {
  throw new Error("A/A live variables do not equal the freeze activation receipt");
}
const online = Array.isArray(freeze?.controlledRunner?.onlineMatches)
  ? freeze.controlledRunner.onlineMatches.filter(
      (entry) =>
        entry?.status === "online" &&
        typeof entry?.nameSha256 === "string" &&
        /^[0-9a-f]{64}$/.test(entry.nameSha256) &&
        typeof entry?.identitySha256 === "string" &&
        /^[0-9a-f]{64}$/.test(entry.identitySha256)
    )
  : [];
if (online.length !== 1) {
  throw new Error("A/A requires exactly one freeze-attested online controlled runner");
}
if (phase === "--acquisition") {
  if (
    requiredEnv("RUNNER_ENVIRONMENT") !== "self-hosted" ||
    sha256Hex(`runner-name\u0000${requiredEnv("RUNNER_NAME")}`) !==
      online[0].nameSha256
  ) {
    throw new Error("The executing A/A runner is not the unique freeze-attested host");
  }
}
writeOutputs({
  candidate_commit: binding.candidateCommit,
  carrier_commit: binding.carrierCommit,
  runner_label: runnerLabel,
  runner_label_sha256: runnerLabelSha256,
  runner_identity_sha256: online[0].identitySha256,
  egress_identity: scannerEgress,
  egress_region: scannerEgressRegion,
  egress_region_sha256: egressRegionSha256
});
console.log(
  `A/A ${phase.slice(2)} preflight passed for ${studyId} at ${binding.candidateCommit}.`
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

function requiredCanonicalEnv(name) {
  const value = requiredEnv(name);
  if (
    value.length > 200 ||
    /[\u0000-\u001f\u007f-\u009f]/.test(value)
  ) {
    throw new Error(`${name} must be canonical bounded text`);
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
