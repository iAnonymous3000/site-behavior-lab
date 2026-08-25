#!/usr/bin/env node
/**
 * Close pilot labeling: freeze the authorized commitment set and the close
 * instant into ONE repo-committable artifact, the pilot labeling
 * authorization. The reveal takes no free boundary and no free roster;
 * both come from this artifact, whose repository commit (via PR and CI) is
 * the anchor, exactly as the v3 custody trio is anchored.
 *
 * The commitment record files MUST come from the authenticated fetcher
 * (fetchAuthenticatedCalibrationLabelCommitments over the GitHub Actions
 * API) at close time; this CLI freezes what that step produced, and the
 * operator committing the artifact attests the set. Records are read in
 * lexicographic filename order, which becomes the authorized order.
 *
 *   node scripts/calibration-v4-pilot-close.mjs \
 *     --frame-tasks <frame-tasks.json> --commitments-dir <dir> \
 *     --key-id <64-hex sealing keyId> --out <authorization.json>
 */

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildV4PilotLabelingAuthorization,
  parseV4FrameTasksBytes,
  requireApprovedCensoringPolicyAssignments
} from "./calibration-v4-ceremony-lib.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
import { sha256Hex } from "./calibration-study-lib.mjs";

const USAGE =
  "usage: calibration-v4-pilot-close.mjs --frame-tasks <frame-tasks.json> --commitments-dir <dir> --key-id <64-hex> --out <authorization.json>";

function fail(message) {
  console.error(message);
  process.exit(1);
}

const allowed = new Set(["--frame-tasks", "--commitments-dir", "--key-id", "--out"]);
const values = new Map();
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 2) {
  const name = args[index];
  const value = args[index + 1];
  if (!allowed.has(name) || !value || value.startsWith("--") || values.has(name)) fail(USAGE);
  values.set(name, value);
}
for (const name of allowed) {
  if (!values.has(name)) fail(`Missing required argument ${name}\n${USAGE}`);
}

const frameTasksBytes = readFileSync(values.get("--frame-tasks"), "utf8");
const frameTasks = parseV4FrameTasksBytes(frameTasksBytes);
requireApprovedCensoringPolicyAssignments({ rootDir: repoRoot, detector: frameTasks.detector });
const commitments = [];
for (const file of readdirSync(values.get("--commitments-dir")).sort()) {
  if (!file.endsWith(".json")) fail(`${file} in the commitments directory is not a record file`);
  commitments.push(JSON.parse(readFileSync(path.join(values.get("--commitments-dir"), file), "utf8")));
}
const { text, sha256 } = buildV4PilotLabelingAuthorization({
  studyId: frameTasks.studyId,
  detector: frameTasks.detector,
  candidateCommit: frameTasks.candidateCommit,
  referenceProtocolId: frameTasks.referenceProtocolId,
  keyId: values.get("--key-id"),
  frameTasksSha256: sha256Hex(frameTasksBytes),
  labelingClosedAt: new Date().toISOString(),
  commitments
});
mkdirSync(path.dirname(values.get("--out")), { recursive: true, mode: 0o700 });
writeFileSync(values.get("--out"), text, { flag: "wx", mode: 0o600 });
console.log(
  `pilot labeling closed: ${commitments.length} authorized commitments, authorization sha256 ${sha256}. Commit this artifact at calibration/${frameTasks.studyId}/pilot-labeling-authorization.json before any reveal.`
);
