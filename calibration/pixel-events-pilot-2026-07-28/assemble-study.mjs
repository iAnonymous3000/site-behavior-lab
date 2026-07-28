#!/usr/bin/env node
/**
 * Pilot step 3: assemble the reference labels and the recorded predictions into
 * a detector-calibration-study.v1 artifact, then run the repository's own
 * analyzer over it.
 *
 * The analyzer is the authority on what may be claimed. This script never
 * computes a rate itself; it only builds the artifact and prints the verdict.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(here, "..", "..");
const requireFromHere = createRequire(import.meta.url);
const calibration = requireFromHere(path.join(rootDir, ".unit-test-dist", "lib", "detector-calibration.js"));

const BUILD_COMMIT = process.env.PILOT_BUILD_COMMIT;
if (!BUILD_COMMIT || !/^[0-9a-f]{40}$/.test(BUILD_COMMIT)) {
  console.error("PILOT_BUILD_COMMIT must be the full 40-character commit the scans ran at.");
  process.exit(1);
}

const frame = JSON.parse(readFileSync(path.join(here, "frame.json"), "utf8"));
const scans = JSON.parse(readFileSync(path.join(here, "scan-results.json"), "utf8"));
const labels = JSON.parse(readFileSync(path.join(here, "labels.json"), "utf8"));

const sha = (value) => createHash("sha256").update(typeof value === "string" ? value : canonical(value)).digest("hex");
function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
}

const runtimeCore = {
  observer: "node-playwright",
  automation: "playwright-chromium",
  nodeVersion: process.env.PILOT_NODE_VERSION,
  playwrightVersion: process.env.PILOT_PLAYWRIGHT_VERSION,
  browserName: "chromium",
  browserVersion: process.env.PILOT_BROWSER_VERSION,
  operatingSystem: process.env.PILOT_OS,
  architecture: process.env.PILOT_ARCH
};
const runtimeDigest = calibration.detectorCalibrationRuntimeDigest(runtimeCore);
const runtime = { ...runtimeCore, runtimeDigest };

const release = calibration.currentDetectorCalibrationReleaseIdentity("pixel-events", BUILD_COMMIT, runtime);

const labelById = new Map(labels.finalLabels.map((entry) => [entry.caseId, entry]));
const cases = scans.results.map((result) => {
  if (!result.loaded) {
    return {
      caseId: result.caseId,
      outcome: "censored",
      // The page never served, so the visit cannot test the detector either way.
      reason: "capture-failed",
      conditionDigest: result.conditionDigest,
      attemptArtifactDigest: result.artifactDigest
    };
  }
  const label = labelById.get(result.caseId);
  if (!label) throw new Error(`no reference label for ${result.caseId}`);
  return {
    caseId: result.caseId,
    outcome: "complete",
    conditionDigest: result.conditionDigest,
    prediction: { value: result.prediction, artifactDigest: result.artifactDigest },
    reference: {
      value: label.value,
      evidenceArtifactDigest: label.evidenceArtifactDigest,
      labelArtifactDigest: label.labelArtifactDigest,
      labelerIds: label.labelerIds,
      adjudication: label.adjudication
    }
  };
});

const study = {
  schemaVersion: 1,
  studyId: frame.frameId,
  detector: "pixel-events",
  release,
  targetPopulation: frame.targetPopulation,
  plannedCases: frame.sites.length,
  design: {
    sampling: frame.sampling,
    samplingFrame: "calibration/pixel-events-pilot-2026-07-28/frame.json",
    samplingFrameDigest: sha(frame),
    selectionProtocol: frame.selectionProtocol,
    referenceProtocol: labels.referenceProtocol,
    referenceProtocolDigest: sha(labels.referenceProtocol),
    adjudicationProtocol: labels.adjudicationProtocol,
    adjudicationProtocolDigest: sha(labels.adjudicationProtocol),
    independentUnits: true,
    predictionBlindedToReference: true,
    referenceBlindedToPrediction: true
  },
  cases
};

writeFileSync(path.join(here, "study.json"), JSON.stringify(study, null, 2));

const analysis = calibration.analyzeDetectorCalibrationStudy(study, {
  expectedBuildCommit: BUILD_COMMIT,
  expectedRuntimeDigest: runtimeDigest
});
writeFileSync(path.join(here, "analysis.json"), JSON.stringify(analysis, null, 2));

console.log(`status:               ${analysis.status}`);
console.log(`issues:               ${analysis.issues.length ? analysis.issues.join("; ") : "none"}`);
console.log(`ineligibilityReasons: ${analysis.ineligibilityReasons.join(", ") || "none"}`);
console.log(`denominators:         ${JSON.stringify(analysis.denominators)}`);
console.log(`confusionMatrix:      ${JSON.stringify(analysis.confusionMatrix)}`);
console.log(`rates:                ${analysis.rates ? JSON.stringify(analysis.rates) : "null (suppressed)"}`);
console.log(`inference.scope:      ${analysis.inference.scope}`);
console.log(`caveats:              ${analysis.inference.caveats.join(" | ") || "none"}`);
