#!/usr/bin/env node
/**
 * Produce ONE reviewer's padded v4 label batch from their approved CNAME
 * worksheet. Reviewers never hand-author the 100-case schema: the producer
 * applies the protocol's value mapping, the reviewer's decisions file
 * overrides individual cases (with the unresolved-never-absent prohibition
 * enforced), and the output is the exact canonical plaintext the seal CLI
 * consumes. Governance-gated like every pilot entrypoint.
 *
 *   node scripts/calibration-v4-reviewer-batch.mjs \
 *     --worksheet <worksheet.json> --frame-tasks <frame-tasks.json> \
 *     --tasks-dir <dir> --role labeler|tiebreaker --actor <github-login> \
 *     [--decisions <decisions.json>] --out <batch.json>
 */

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildV4ReviewerBatchFromWorksheet,
  parseV4FrameTasksBytes,
  requireApprovedCensoringPolicyAssignments,
  requireFrameMatchesApprovedArtifact
} from "./calibration-v4-ceremony-lib.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const USAGE =
  "usage: calibration-v4-reviewer-batch.mjs --worksheet <worksheet.json> --frame-tasks <frame-tasks.json> --tasks-dir <dir> --role labeler|tiebreaker --actor <github-login> [--decisions <decisions.json>] --out <batch.json>";

function fail(message) {
  console.error(message);
  process.exit(1);
}

const required = new Set(["--worksheet", "--frame-tasks", "--tasks-dir", "--role", "--actor", "--out"]);
const allowed = new Set([...required, "--decisions"]);
const values = new Map();
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 2) {
  const name = args[index];
  const value = args[index + 1];
  if (!allowed.has(name) || !value || value.startsWith("--") || values.has(name)) fail(USAGE);
  values.set(name, value);
}
for (const name of required) {
  if (!values.has(name)) fail(`Missing required argument ${name}\n${USAGE}`);
}

const frameTasks = parseV4FrameTasksBytes(readFileSync(values.get("--frame-tasks"), "utf8"));
const { artifact: approvedArtifact } = requireApprovedCensoringPolicyAssignments({
  rootDir: repoRoot,
  detector: frameTasks.detector
});
requireFrameMatchesApprovedArtifact(frameTasks, approvedArtifact);
const taskBytesByCaseId = new Map();
for (const file of readdirSync(values.get("--tasks-dir"))) {
  if (!file.endsWith(".json")) fail(`${file} in the tasks directory is not a task file`);
  taskBytesByCaseId.set(
    file.slice(0, -".json".length),
    readFileSync(path.join(values.get("--tasks-dir"), file), "utf8")
  );
}
// A reviewer is entitled to a named refusal, not a stack trace: every
// refusal on this path is something they can act on (re-capture a case,
// correct a decisions entry, fetch the right definition snapshot).
let produced;
try {
  produced = buildV4ReviewerBatchFromWorksheet({
    worksheetBytes: readFileSync(values.get("--worksheet"), "utf8"),
    frameTasks,
    taskBytesByCaseId,
    role: values.get("--role"),
    reviewerLogin: values.get("--actor").toLowerCase(),
    decisions: values.has("--decisions")
      ? JSON.parse(readFileSync(values.get("--decisions"), "utf8"))
      : []
  });
} catch (error) {
  fail(`calibration:v4-reviewer-batch: ${error.message}`);
}
const { text, worksheetSha256 } = produced;
mkdirSync(path.dirname(values.get("--out")), { recursive: true, mode: 0o700 });
writeFileSync(values.get("--out"), text, { flag: "wx", mode: 0o600 });
console.log(
  `reviewer batch written from worksheet ${worksheetSha256.slice(0, 16)}; seal it with calibration:v4-seal-label-batch under the same --actor`
);
