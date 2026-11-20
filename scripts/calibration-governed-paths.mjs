#!/usr/bin/env node
// The paths an assembled calibration study may add or change: its eight
// governed JSON files and one JSON file per case and role under artifacts/.
// The prepare job of .github/workflows/calibration-study.yml checks its
// working tree with this before it commits the study, and the propose job
// checks the prepared commit's diff with it, so the two cannot disagree.
//
//   <paths, one per line> | calibration-governed-paths.mjs <study id>
//
// prints each path that is not governed, one per line, and exits 0; it
// exits 1 only when it cannot run the check.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CALIBRATION_GOVERNED_FILES = Object.freeze([
  "study.json",
  "analysis.json",
  "runtime-receipt.json",
  "artifact-manifest.json",
  "labels-manifest.json",
  "label-roster-authorization.json",
  "roster-selection-ledger.json",
  "acquisition-attempt-ledger.json"
]);
const ARTIFACT_FILE = /^artifacts\/[^/]+\/[^/]+\.json$/;
const STUDY_ID = /^[a-z0-9][a-z0-9._-]{0,99}$/;

/** The paths of `paths` that a study's assembly may not add or change. */
export function ungovernedCalibrationPaths(studyId, paths) {
  if (!STUDY_ID.test(studyId)) throw new Error(`${JSON.stringify(studyId)} is not a calibration study id`);
  const root = `calibration/${studyId}/`;
  return paths.filter((file) => {
    if (!file.startsWith(root)) return true;
    const inside = file.slice(root.length);
    return !CALIBRATION_GOVERNED_FILES.includes(inside) && !ARTIFACT_FILE.test(inside);
  });
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [studyId, ...rest] = process.argv.slice(2);
    if (studyId === undefined || rest.length > 0) throw new Error("Usage: calibration-governed-paths.mjs <study id> < paths");
    const paths = readFileSync(0, "utf8").split("\n").filter((line) => line !== "");
    for (const file of ungovernedCalibrationPaths(studyId, paths)) console.log(file);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
