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
 *     --swept-eligible-pool <int> [--minimum-per-class <int>] --out <pilot-sizing.json>
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
  "usage: calibration-v4-pilot-sizing.mjs --resolved-labels <resolved-labels.json> --frame-tasks <frame-tasks.json> --swept-eligible-pool <int> [--minimum-per-class <int>] --out <pilot-sizing.json>";

function fail(message) {
  console.error(message);
  process.exit(1);
}

// The pool is REQUIRED: without it the artifact records no feasibility
// determination at all, and a run that skipped the preregistered gate read
// exactly like a run that passed it.
const required = new Set([
  "--resolved-labels",
  "--frame-tasks",
  "--swept-eligible-pool",
  "--out"
]);
const allowed = new Set([...required, "--minimum-per-class"]);
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
const pool = Number(values.get("--swept-eligible-pool"));
if (!Number.isSafeInteger(pool)) fail("--swept-eligible-pool must be an integer");

const sizingFrameBytes = readFileSync(values.get("--frame-tasks"), "utf8");
const sizingFrame = parseV4FrameTasksBytes(sizingFrameBytes);
const { artifact: approvedArtifact } = requireApprovedCensoringPolicyAssignments({
  rootDir: repoRoot,
  detector: sizingFrame.detector
});
requireFrameMatchesApprovedArtifact(sizingFrame, approvedArtifact);
// The claimed-class floor is PINNED in the approved artifact this CLI has
// already opened; it is not an operator's typed number. A supplied flag is
// honored only when it agrees, so the runbook's published command stays
// valid and a typo refuses instead of silently sizing to the wrong floor.
const profileId = approvedArtifact.detectors[sizingFrame.detector]?.publicationProfile;
const pinnedMinimum = approvedArtifact.publicationProfiles?.[profileId]?.minimumPerClaimedClass;
if (!Number.isSafeInteger(pinnedMinimum) || pinnedMinimum < 1) {
  fail(
    `the approved artifact pins no claimed-class minimum for ${sizingFrame.detector} (profile ${profileId})`
  );
}
if (values.has("--minimum-per-class") && Number(values.get("--minimum-per-class")) !== pinnedMinimum) {
  fail(
    `--minimum-per-class ${values.get("--minimum-per-class")} is not the approved artifact's pinned ${pinnedMinimum} for profile ${profileId}`
  );
}
const minimumPerClass = pinnedMinimum;
const { artifact, text, sha256 } = computeV4PilotSizingArtifact({
  resolvedLabelsBytes: readFileSync(values.get("--resolved-labels"), "utf8"),
  frameTasksBytes: sizingFrameBytes,
  minimumPerClass,
  sweptEligiblePool: pool
});
mkdirSync(path.dirname(values.get("--out")), { recursive: true, mode: 0o700 });
writeFileSync(values.get("--out"), text, { flag: "wx", mode: 0o600 });
console.log(
  `pilot sizing: ${artifact.counts.present} present, ${artifact.counts.absent} absent, ${artifact.counts.uncertain} uncertain of ${artifact.counts.total}` +
    `${artifact.derivedN === null ? "" : `; interval [${artifact.interval95.lower.toFixed(4)}, ${artifact.interval95.upper.toFixed(4)}]; derived N ${artifact.derivedN}`}` +
    `; pool ${artifact.feasibility.sweptEligiblePool} => ${artifact.feasibility.feasible ? "FEASIBLE" : "INFEASIBLE"}` +
    `; artifact sha256 ${sha256}`
);
if (!artifact.feasibility.feasible) {
  // The artifact is written first: an INFEASIBLE determination is the
  // evidence the study most needs. The process still fails, because a gate
  // that prints its fail condition and exits 0 is not a gate, and the next
  // ceremony step must not run on it. The remedy is a larger universe and
  // fresh sweep rounds, never a relaxed rule.
  console.error(
    artifact.unsizableReason === null
      ? `calibration:v4-pilot-sizing: INFEASIBLE. Derived N ${artifact.derivedN} exceeds the swept eligible pool ${artifact.feasibility.sweptEligiblePool}; enlarge the universe and sweep it afresh.`
      : `calibration:v4-pilot-sizing: INFEASIBLE. ${artifact.unsizableReason}`
  );
  process.exit(1);
}
