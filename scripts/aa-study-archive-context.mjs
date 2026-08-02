#!/usr/bin/env node

import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  inspectAaArtifact
} from "./aa-study-producer-lib.mjs";
import { sha256Hex } from "./scanner-fidelity-study-lib.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (
  process.argv.length !== 4 ||
  process.argv[2] !== "--artifact-dir" ||
  !path.isAbsolute(process.argv[3])
) {
  throw new Error(
    "Usage: aa-study-archive-context.mjs --artifact-dir <absolute-directory>"
  );
}
const inspection = inspectAaArtifact(process.argv[3]);
const runnerLabel = requiredCanonicalEnv("FEATURED_RUNNER_LABEL");
const egressIdentity = requiredCanonicalEnv("SCANNER_EGRESS");
const egressRegion = requiredCanonicalEnv("SCANNER_EGRESS_REGION");
if (
  requiredEnv("SITE_BEHAVIOR_LAB_MEASUREMENT_FREEZE") !== "1" ||
  requiredEnv("FEATURED_R2_EGRESS_ATTESTED") !== "1" ||
  egressIdentity !== "controlled-self-hosted"
) {
  throw new Error("A/A archive requires the activated controlled-runner freeze");
}
const runnerLabelSha256 = sha256Hex(`runner-label\u0000${runnerLabel}`);
const egressRegionSha256 = sha256Hex(
  `scanner-egress-region\u0000${egressRegion}`
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
const online = Array.isArray(freeze?.controlledRunner?.onlineMatches)
  ? freeze.controlledRunner.onlineMatches.filter(
      (entry) =>
        entry?.status === "online" &&
        typeof entry?.identitySha256 === "string" &&
        /^[0-9a-f]{64}$/.test(entry.identitySha256)
    )
  : [];
if (
  freeze?.safeConfiguration?.measurementFreeze !== "1" ||
  freeze?.safeConfiguration?.runnerLabelSha256 !==
    runnerLabelSha256 ||
  freeze?.safeConfiguration?.scannerEgress !== egressIdentity ||
  freeze?.safeConfiguration?.scannerEgressRegionSha256 !==
    egressRegionSha256 ||
  freeze?.safeConfiguration?.featuredR2EgressAttested !== "1" ||
  online.length !== 1 ||
  inspection.manifest.runner.labelSha256 !== runnerLabelSha256 ||
  inspection.manifest.runner.identitySha256 !==
    online[0].identitySha256 ||
  inspection.manifest.egress.identity !== egressIdentity ||
  inspection.manifest.egress.regionSha256 !== egressRegionSha256
) {
  throw new Error(
    "A/A artifact runner and egress do not equal the live freeze-bound context"
  );
}
writeOutputs({
  study_id: inspection.manifest.studyId,
  candidate_commit: inspection.manifest.candidateCommit,
  run_head_commit: inspection.manifest.producer.runHeadCommit,
  run_id: inspection.manifest.producer.runId,
  run_attempt: inspection.manifest.producer.runAttempt,
  runner_label_sha256: runnerLabelSha256,
  runner_identity_sha256: online[0].identitySha256,
  egress_identity: egressIdentity,
  egress_region_sha256: egressRegionSha256
});

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
