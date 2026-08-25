#!/usr/bin/env node
/**
 * Repository gate: every committed pilot frame must derive from the carrier
 * it names.
 *
 * The gate is keyed on the FRAME, not on the carrier file. If it keyed on
 * `pilot-carrier.txt`, deleting that one file would silently disable the only
 * check in the ceremony that can catch a frame bound to a commit that never
 * landed, inputs edited after the carrier, or a frame built from some other
 * tree. A study directory that holds `frame-tasks.json` and no carrier file
 * fails here by name.
 *
 * With no pilot frames committed it passes trivially, and it stays wired so
 * the first frame to land is checked by the PR that lands it. Needs full
 * history (fetch-depth 0) because it reads the carrier commit's tree.
 */

import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyPilotCarrier, PILOT_CARRIER_FILE, PILOT_FRAME_FILE } from "./calibration-v4-pilot-carrier-lib.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const calibrationRoot = path.join(repoRoot, "calibration");
const upstreamRef = process.env.CALIBRATION_PILOT_UPSTREAM_REF ?? "origin/main";

const problems = [];
const verified = [];
const studyDirs = existsSync(calibrationRoot)
  ? readdirSync(calibrationRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  : [];

for (const name of studyDirs) {
  const studyDir = path.posix.join("calibration", name);
  const hasFrame = existsSync(path.join(repoRoot, studyDir, PILOT_FRAME_FILE));
  const hasCarrier = existsSync(path.join(repoRoot, studyDir, PILOT_CARRIER_FILE));
  if (!hasFrame && !hasCarrier) continue;
  if (!hasFrame) {
    problems.push(`${studyDir} records a carrier but holds no ${PILOT_FRAME_FILE}`);
    continue;
  }
  if (!hasCarrier) {
    problems.push(
      `${studyDir} holds a committed frame with no ${PILOT_CARRIER_FILE}; a frame that names no carrier cannot be shown to derive from one`
    );
    continue;
  }
  try {
    const result = verifyPilotCarrier({ rootDir: repoRoot, studyDir, upstreamRef });
    verified.push(`${studyDir}: ${result.cases} cases re-derived from ${result.carrier}`);
  } catch (error) {
    problems.push(`${studyDir}: ${error.message}`);
  }
}

for (const line of verified) console.log(`pilot carrier ok - ${line}`);
if (problems.length > 0) {
  for (const problem of problems) console.error(`::error::pilot carrier gate: ${problem}`);
  process.exit(1);
}
console.log(
  verified.length > 0
    ? `pilot carrier gate: ${verified.length} committed frame(s) verified`
    : "pilot carrier gate: no committed pilot frames"
);
