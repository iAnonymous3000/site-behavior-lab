#!/usr/bin/env node
/**
 * The canonical pilot-sizing producer. Consumes the RESOLVED-LABELS
 * artifact and the frame-tasks bytes; there is no typed-count input. The
 * three sizing bins must partition the resolved cases, the interval is
 * the preregistered uncertainty envelope, and feasibility against a
 * supplied swept eligible pool is RECORDED in the artifact for the
 * preregistered fail condition to act on.
 *
 *   node scripts/calibration-v4-pilot-sizing.mjs \
 *     --resolved-labels <resolved-labels.json> --frame-tasks <frame-tasks.json> \
 *     --minimum-per-class <int> [--swept-eligible-pool <int>] --out <pilot-sizing.json>
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  computeV4PilotSizingArtifact,
  parseV4FrameTasksBytes,
  requireApprovedCensoringPolicyAssignments,
  requireFrameMatchesApprovedArtifact
} from "./calibration-v4-ceremony-lib.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const USAGE =
  "usage: calibration-v4-pilot-sizing.mjs --resolved-labels <resolved-labels.json> --frame-tasks <frame-tasks.json> --minimum-per-class <int> [--swept-eligible-pool <int>] --out <pilot-sizing.json>";

function fail(message) {
  console.error(message);
  process.exit(1);
}

const required = new Set(["--resolved-labels", "--frame-tasks", "--minimum-per-class", "--out"]);
const allowed = new Set([...required, "--swept-eligible-pool"]);
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
const minimumPerClass = Number(values.get("--minimum-per-class"));
const pool = values.has("--swept-eligible-pool") ? Number(values.get("--swept-eligible-pool")) : null;
if (!Number.isSafeInteger(minimumPerClass) || (pool !== null && !Number.isSafeInteger(pool))) {
  fail("--minimum-per-class and --swept-eligible-pool must be integers");
}

const sizingFrameBytes = readFileSync(values.get("--frame-tasks"), "utf8");
const sizingFrame = parseV4FrameTasksBytes(sizingFrameBytes);
const { artifact: approvedArtifact } = requireApprovedCensoringPolicyAssignments({
  rootDir: repoRoot,
  detector: sizingFrame.detector
});
requireFrameMatchesApprovedArtifact(sizingFrame, approvedArtifact);
const { artifact, text, sha256 } = computeV4PilotSizingArtifact({
  resolvedLabelsBytes: readFileSync(values.get("--resolved-labels"), "utf8"),
  frameTasksBytes: sizingFrameBytes,
  minimumPerClass,
  sweptEligiblePool: pool
});
mkdirSync(path.dirname(values.get("--out")), { recursive: true, mode: 0o700 });
writeFileSync(values.get("--out"), text, { flag: "wx", mode: 0o600 });
console.log(
  `pilot sizing: ${artifact.counts.present} present, ${artifact.counts.absent} absent, ${artifact.counts.uncertain} uncertain of ${artifact.counts.total}; interval [${artifact.interval95.lower.toFixed(4)}, ${artifact.interval95.upper.toFixed(4)}]; derived N ${artifact.derivedN}${artifact.feasibility === null ? "" : `; pool ${artifact.feasibility.sweptEligiblePool} => ${artifact.feasibility.feasible ? "FEASIBLE" : "INFEASIBLE (larger universe and fresh rounds, never a relaxed rule)"}`}; artifact sha256 ${sha256}`
);
