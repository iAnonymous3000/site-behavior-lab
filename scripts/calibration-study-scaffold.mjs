#!/usr/bin/env node

import path from "node:path";
import {
  calibrationCandidateScaffold,
  readJsonFile,
  sha256Hex,
  writeCalibrationCandidateScaffold
} from "./calibration-study-lib.mjs";

const options = parseOptions(process.argv.slice(2));
const plan = readJsonFile(options.plan, "calibration scaffold plan").value;
const scaffold = calibrationCandidateScaffold(plan);

if (options.check) {
  for (const file of scaffold.files) {
    const actual = readJsonFile(
      path.join(options.outputRoot, ...file.path.split("/")),
      file.path
    );
    if (actual.text !== file.text || sha256Hex(actual.text) !== file.sha256) {
      throw new Error(`${file.path} does not match the deterministic calibration scaffold`);
    }
  }
  console.log(`Verified candidate-resident calibration scaffold for ${scaffold.studyId}.`);
} else {
  writeCalibrationCandidateScaffold(options.outputRoot, scaffold);
  console.log(`Created candidate-resident calibration scaffold for ${scaffold.studyId}:`);
  for (const file of scaffold.files) console.log(`${file.sha256}  ${file.path}`);
  console.log(
    "Add all three files to research/measurement-candidate/measurement-inputs.json before freezing candidate C."
  );
}

function parseOptions(args) {
  let plan = "";
  let outputRoot = "";
  let check = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--check") {
      if (check) throw new Error("Duplicate --check");
      check = true;
      continue;
    }
    if (argument !== "--plan" && argument !== "--output-root") {
      throw new Error(`Unknown argument: ${argument}`);
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${argument}`);
    if (argument === "--plan") plan = value;
    else outputRoot = value;
    index += 1;
  }
  if (!path.isAbsolute(plan) || !path.isAbsolute(outputRoot)) {
    throw new Error("--plan and --output-root must be absolute paths");
  }
  return { plan, outputRoot, check };
}
