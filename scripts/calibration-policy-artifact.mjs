#!/usr/bin/env node
/**
 * Build (or --check) the per-detector censoring-policy assignments
 * artifact at its fixed candidate path. Build is CREATE-OR-MATCH: it
 * refuses to overwrite different bytes, the same discipline as the
 * candidate scaffold. --check re-derives from the step-3 table and the
 * supplied inputs and byte-compares against the committed file, so the
 * table and the approved artifact cannot drift while CI is green.
 *
 *   node scripts/calibration-policy-artifact.mjs build \
 *     --protocol-file docs/calibration-prereg-drafts/labeling-protocol.md \
 *     --tracker-manifest <manifest.json> --public-suffix-manifest <manifest.json>
 *   node scripts/calibration-policy-artifact.mjs check \
 *     --tracker-manifest <manifest.json> --public-suffix-manifest <manifest.json>
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  POLICY_ASSIGNMENTS_REFERENCE_PROTOCOL_PATH,
  buildCalibrationPolicyAssignmentsArtifact,
  policyAssignmentsRepoRoot
} from "./calibration-policy-artifact-lib.mjs";

const ARTIFACT_PATH = "research/measurement-candidate/calibration-censoring-policy-assignments.json";
const USAGE =
  "usage: calibration-policy-artifact.mjs build|check [--protocol-file <path>] --tracker-manifest <json> --public-suffix-manifest <json>";

function fail(message) {
  console.error(message);
  process.exit(1);
}

const [mode, ...rest] = process.argv.slice(2);
if (mode !== "build" && mode !== "check") fail(USAGE);
const allowed = new Set(["--protocol-file", "--tracker-manifest", "--public-suffix-manifest"]);
const values = new Map();
for (let index = 0; index < rest.length; index += 2) {
  const name = rest[index];
  const value = rest[index + 1];
  if (!allowed.has(name) || !value || value.startsWith("--") || values.has(name)) fail(USAGE);
  values.set(name, value);
}
for (const name of ["--tracker-manifest", "--public-suffix-manifest"]) {
  if (!values.has(name)) fail(`Missing required argument ${name}\n${USAGE}`);
}
const root = policyAssignmentsRepoRoot();
const protocolPath =
  values.get("--protocol-file") ?? path.join(root, POLICY_ASSIGNMENTS_REFERENCE_PROTOCOL_PATH);

const { text, policyArtifactSha256, dispositionSha256 } =
  buildCalibrationPolicyAssignmentsArtifact({
    protocolBytes: readFileSync(protocolPath, "utf8"),
    trackerDefinition: JSON.parse(readFileSync(values.get("--tracker-manifest"), "utf8")),
    publicSuffixDefinition: JSON.parse(readFileSync(values.get("--public-suffix-manifest"), "utf8"))
  });

const artifactAbsolute = path.join(root, ARTIFACT_PATH);
if (mode === "check") {
  if (!existsSync(artifactAbsolute)) fail(`no artifact at ${ARTIFACT_PATH}; run build first`);
  const committed = readFileSync(artifactAbsolute, "utf8");
  if (committed !== text) {
    fail(
      "the committed censoring-policy assignments artifact does not equal the derivation from the step-3 table and the supplied inputs; regenerate it deliberately, never hand-edit"
    );
  }
  console.log(
    `censoring-policy assignments verified: sha256 ${policyArtifactSha256}, disposition ${dispositionSha256}`
  );
} else {
  if (existsSync(artifactAbsolute)) {
    const committed = readFileSync(artifactAbsolute, "utf8");
    if (committed !== text) {
      fail("the censoring-policy assignments artifact already exists with different bytes");
    }
    console.log("artifact already up to date");
  } else {
    writeFileSync(artifactAbsolute, text, { flag: "wx" });
    console.log(`censoring-policy assignments written to ${ARTIFACT_PATH}`);
  }
  console.log(`policyArtifactSha256 ${policyArtifactSha256}`);
  console.log(`dispositionSha256 ${dispositionSha256}`);
}
