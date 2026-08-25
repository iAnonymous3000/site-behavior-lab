#!/usr/bin/env node
/**
 * Seal a v4 tri-state label batch. VALIDATE-THEN-SEAL: the batch is
 * validated against the frame-tasks artifact (including the
 * frameTasksSha256 content binding) and every task file is verified against
 * its taskSha256 BEFORE anything is encrypted, so a wrong-frame or
 * wrong-protocol batch fails at the reviewer's desk, never after the one
 * authorized acquisition attempt is spent. The envelope and identity are
 * the existing custody machinery (rsa-oaep-sha256+a256gcm); the plaintext
 * is never copied anywhere.
 */

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { calibrationLabelPublicKeyIdentity } from "./calibration-label-source-envelope-lib.mjs";
import { canonicalPrettyJson } from "./calibration-study-lib.mjs";
import { fileURLToPath } from "node:url";
import {
  parseV4FrameTasksBytes,
  requireApprovedCensoringPolicyAssignments,
  requireFrameMatchesApprovedArtifact,
  sealV4LabelBatch
} from "./calibration-v4-ceremony-lib.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
import { padV4LabelBatch } from "./calibration-v4-labels-lib.mjs";

const USAGE =
  "usage: calibration-v4-seal-label-batch.mjs --role labeler|tiebreaker --actor <github-login> --public-key <pem> --frame-tasks <frame-tasks.json> --tasks-dir <dir> --input <batch.json> --output <envelope.json>";

function fail(message) {
  console.error(message);
  process.exit(1);
}

const allowed = new Set([
  "--role",
  "--actor",
  "--public-key",
  "--frame-tasks",
  "--tasks-dir",
  "--input",
  "--output"
]);
const values = new Map();
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 2) {
  const name = args[index];
  const value = args[index + 1];
  if (!allowed.has(name) || !value || value.startsWith("--") || values.has(name)) {
    fail(USAGE);
  }
  values.set(name, value);
}
for (const name of allowed) {
  if (!values.has(name)) fail(`Missing required argument ${name}\n${USAGE}`);
}
const actor = values.get("--actor").toLowerCase();
if (
  !["labeler", "tiebreaker"].includes(values.get("--role")) ||
  !/^(?!-)(?!.*--)[a-z0-9-]{1,39}(?<!-)$/.test(actor)
) {
  fail("calibration v4 seal arguments are malformed");
}

const frameTasks = parseV4FrameTasksBytes(readFileSync(values.get("--frame-tasks"), "utf8"));
// GOVERNANCE GATE: a reviewer must not seal a single label before the
// named-human approval commit exists (committed-bytes check only; no build
// is required on a fresh clone).
const { artifact: approvedArtifact } = requireApprovedCensoringPolicyAssignments({ rootDir: repoRoot, detector: frameTasks.detector });
requireFrameMatchesApprovedArtifact(frameTasks, approvedArtifact);
const taskBytesByCaseId = new Map();
for (const file of readdirSync(values.get("--tasks-dir"))) {
  if (!file.endsWith(".json")) fail(`${file} in the tasks directory is not a task file`);
  taskBytesByCaseId.set(
    file.slice(0, -".json".length),
    readFileSync(path.join(values.get("--tasks-dir"), file), "utf8")
  );
}
const publicKeyPem = readFileSync(values.get("--public-key"), "utf8");
// The reviewer authors the batch WITHOUT padding; the CLI fills the padding
// field to the frame's fixed length and canonicalizes, changing no value.
// An already-padded input is left exactly as supplied.
const inputBatch = JSON.parse(readFileSync(values.get("--input"), "utf8"));
const batchBytes = canonicalPrettyJson(
  typeof inputBatch.padding === "string" ? inputBatch : padV4LabelBatch(inputBatch, frameTasks)
);
const sealed = sealV4LabelBatch({
  batchBytes,
  frameTasks,
  taskBytesByCaseId,
  role: values.get("--role"),
  reviewerLogin: actor,
  publicKeyPem,
  keyId: calibrationLabelPublicKeyIdentity(publicKeyPem).keyId
});
mkdirSync(path.dirname(values.get("--output")), { recursive: true, mode: 0o700 });
writeFileSync(values.get("--output"), sealed.text, { flag: "wx", mode: 0o600 });
console.log(
  `Sealed ${values.get("--role")} v4 label batch for ${frameTasks.studyId}; plaintext was not copied.`
);
