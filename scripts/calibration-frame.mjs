#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildFrameArtifacts, drawFrame, sha256Hex, CALIBRATION_FRAME_DRAW_VERSION } from "./calibration-frame-lib.mjs";
import { calibrationMeasurementCondition } from "./calibration-study-lib.mjs";

/**
 * Draw and freeze a calibration frame.
 *
 *   npm run calibration:frame -- \
 *     --preregistration calibration/<studyId>/preregistration.json \
 *     --pool /abs/screened-pool.json \
 *     --count 350 \
 *     --output-root /abs/case-input-root
 *
 * Deterministic, create-only, no network. The seed is the SHA-256 of the
 * committed preregistration bytes, so the frame cannot be drawn before the
 * preregistration is final and cannot be redrawn afterwards without changing
 * the preregistration that every other artifact is bound to.
 *
 * Emits the exact `cases/<caseId>/{selection,condition}.json` bytes the
 * acquisition validator recomputes digests over, plus `frame-rows.json` with
 * the per-case digests to paste into the plan's `cases` array.
 *
 * It does NOT compute `referenceEvidenceDigest`: reference evidence is sealed
 * independently by reviewers and must not be produced by the same hand that
 * draws the frame.
 */

const options = parseOptions(process.argv.slice(2));

const preregistrationBytes = readFileSync(options.preregistration);
const seed = sha256Hex(preregistrationBytes);
const preregistration = JSON.parse(preregistrationBytes.toString("utf8"));

const studyId = preregistration?.studyId;
const detector = preregistration?.detector;
const measurementCondition = preregistration?.design?.measurementCondition;
if (typeof studyId !== "string" || typeof detector !== "string") {
  fail("preregistration must carry studyId and detector");
}
if (
  !measurementCondition ||
  typeof measurementCondition.device !== "string" ||
  typeof measurementCondition.gpcEnabled !== "boolean" ||
  typeof measurementCondition.consentMode !== "string"
) {
  fail("preregistration design.measurementCondition must carry device, gpcEnabled and consentMode");
}
// Fail here rather than at acquisition. The validator compares every case's
// condition against the canonical detector arm INCLUDING its exact
// interpretation text, so a preregistration carrying a paraphrase would emit a
// whole frame of bytes that the one-shot ceremony then refuses.
const canonicalCondition = calibrationMeasurementCondition(detector);
for (const key of ["device", "gpcEnabled", "consentMode", "interpretation"]) {
  if (measurementCondition[key] !== canonicalCondition[key]) {
    fail(
      `preregistration measurementCondition.${key} does not equal the canonical ${detector} arm.\n` +
        `  expected: ${JSON.stringify(canonicalCondition[key])}\n` +
        `  found:    ${JSON.stringify(measurementCondition[key])}`
    );
  }
}

const pool = JSON.parse(readFileSync(options.pool, "utf8"));
const drawn = drawFrame(pool, seed, options.count);
const artifacts = buildFrameArtifacts({ drawn, studyId, detector, measurementCondition });

for (const artifact of artifacts) {
  const dir = path.join(options.outputRoot, "cases", artifact.caseId);
  mkdirSync(dir, { recursive: true });
  // `wx` so a second run cannot silently overwrite a frozen frame. Redrawing
  // has to be a deliberate act against a clean directory, not something that
  // happens because a command was repeated.
  createOnly(path.join(dir, "selection.json"), artifact.selectionText);
  createOnly(path.join(dir, "condition.json"), artifact.conditionText);
}

const rows = artifacts.map((artifact) => ({
  caseId: artifact.caseId,
  selectionDigest: artifact.selectionDigest,
  conditionDigest: artifact.conditionDigest
}));
const receipt = {
  schemaVersion: 1,
  artifactKind: "site-behavior-detector-calibration-frame-draw",
  drawVersion: CALIBRATION_FRAME_DRAW_VERSION,
  studyId,
  detector,
  seed,
  seedSource: path.basename(options.preregistration),
  poolSize: pool.length,
  drawnCases: artifacts.length,
  rows
};
createOnly(path.join(options.outputRoot, "frame-rows.json"), `${JSON.stringify(receipt, null, 2)}\n`);

console.log(
  `Drew ${artifacts.length} of ${pool.length} pool candidates for ${studyId} (${detector}).\n` +
    `Seed ${seed} = sha256(${path.basename(options.preregistration)}).\n` +
    `Wrote cases/ and frame-rows.json under ${options.outputRoot}.\n\n` +
    "Anyone can recheck the draw: key every pool url as sha256(seed + \"\\n\" + url),\n" +
    "sort ascending, take the first N. No PRNG is involved.\n\n" +
    "referenceEvidenceDigest is deliberately absent: reference evidence is sealed by\n" +
    "reviewers independently and must not come from the hand that drew the frame."
);

function parseOptions(argv) {
  const values = new Map();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!key?.startsWith("--")) fail(`unexpected argument ${key}`);
    values.set(key.slice(2), argv[i + 1]);
  }
  for (const key of ["preregistration", "pool", "count", "output-root"]) {
    if (!values.get(key)) fail(`--${key} is required`);
  }
  const count = Number(values.get("count"));
  if (!Number.isSafeInteger(count) || count <= 0) fail("--count must be a positive integer");
  return {
    preregistration: values.get("preregistration"),
    pool: values.get("pool"),
    count,
    outputRoot: values.get("output-root")
  };
}

/**
 * Write, or refuse if the file exists.
 *
 * A frozen frame is evidence. Overwriting one silently would let a second run
 * replace a frame that other artifacts are already bound to, which is exactly
 * the "redraw until the sample looks right" move the seeded draw exists to
 * prevent. The refusal has to read as a decision, not as a crash.
 */
function createOnly(filePath, text) {
  try {
    writeFileSync(filePath, text, { flag: "wx" });
  } catch (error) {
    if (error?.code === "EEXIST") {
      fail(
        `${filePath} already exists. A drawn frame is never overwritten: draw into a clean ` +
          "directory, and redraw only by changing the preregistration the seed comes from."
      );
    }
    throw error;
  }
}

function fail(message) {
  console.error(`calibration:frame: ${message}`);
  process.exit(1);
}
