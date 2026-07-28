import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import path from "node:path";
import Ajv from "ajv";
import { createGenerator } from "ts-json-schema-generator";
import {
  currentDetectorCalibrationReleaseIdentity,
  detectorCalibrationRuntimeDigest,
  detectorCalibrationStudyIssues,
  DETECTOR_CALIBRATION_STUDY_SCHEMA_ID,
  type DetectorCalibrationRuntimeIdentity,
  type DetectorCalibrationStudy
} from "./detector-calibration";
import { sha256Hex } from "./sha256";

const ROOT = process.cwd();
const SCHEMA_PATH = path.join(ROOT, "public", "schemas", "detector-calibration-study.v1.schema.json");
const FROZEN_SCHEMA_SHA256 = "420cb5db0992cf11a1145fef594d6aeb61dc29cc87ea521a559f1b3c3e538694";

function generatedSchema(): Record<string, unknown> {
  const schema = createGenerator({
    path: path.join(ROOT, "lib", "detector-calibration.ts"),
    type: "DetectorCalibrationStudy",
    skipTypeCheck: true,
    additionalProperties: false,
    topRef: true
  }).createSchema("DetectorCalibrationStudy");
  return { $id: DETECTOR_CALIBRATION_STUDY_SCHEMA_ID, ...schema };
}

test("the committed detector-calibration schema equals a fresh generation from the study type", () => {
  const bytes = readFileSync(SCHEMA_PATH);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), FROZEN_SCHEMA_SHA256);
  const committed = JSON.parse(bytes.toString("utf8"));
  assert.deepEqual(committed, generatedSchema(), "run `npm run build:schema` and commit the result");
});

test("schema and runtime validation agree on the complete strict study shape", () => {
  const schema = generatedSchema();
  const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);
  const valid = fixture();
  assert.equal(validate(valid), true, JSON.stringify(validate.errors));
  assert.deepEqual(detectorCalibrationStudyIssues(valid), []);

  const missingRelease = structuredClone(valid) as Partial<DetectorCalibrationStudy>;
  delete missingRelease.release;
  assert.equal(validate(missingRelease), false);
  assert.notDeepEqual(detectorCalibrationStudyIssues(missingRelease), []);

  const extraCaseField = structuredClone(valid) as DetectorCalibrationStudy;
  Object.assign(extraCaseField.cases[0], { inferredLabel: true });
  assert.equal(validate(extraCaseField), false);
  assert.notDeepEqual(detectorCalibrationStudyIssues(extraCaseField), []);
});

test("digest semantics remain a fail-closed runtime rule beyond generated JSON Schema", () => {
  const schema = generatedSchema();
  const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);
  const mutant = fixture();
  mutant.release.runtime.runtimeDigest = "0".repeat(64);
  assert.equal(validate(mutant), true, "JSON Schema checks shape; runtime validation recomputes semantic digests");
  assert.equal(
    detectorCalibrationStudyIssues(mutant).includes(
      "release.runtime.runtimeDigest does not match the declared runtime identity"
    ),
    true
  );
});

function fixture(): DetectorCalibrationStudy {
  return {
    schemaVersion: 1,
    studyId: "schema-contract-only",
    detector: "fingerprint-heuristics",
    release: currentDetectorCalibrationReleaseIdentity(
      "fingerprint-heuristics",
      "a".repeat(40),
      runtimeIdentity()
    ),
    targetPopulation: "Synthetic schema-validation records only; not calibration evidence.",
    plannedCases: 1,
    design: {
      sampling: "convenience",
      samplingFrame: "Synthetic schema-validation frame.",
      samplingFrameDigest: digest("frame"),
      selectionProtocol: "Synthetic contract fixture.",
      referenceProtocol: "Synthetic contract fixture.",
      referenceProtocolDigest: digest("reference-protocol"),
      adjudicationProtocol: "Synthetic contract fixture.",
      adjudicationProtocolDigest: digest("adjudication-protocol"),
      independentUnits: true,
      predictionBlindedToReference: true,
      referenceBlindedToPrediction: true
    },
    cases: [
      {
        caseId: "schema-case",
        outcome: "complete",
        conditionDigest: digest("condition"),
        prediction: {
          value: "detected",
          artifactDigest: digest("prediction-artifact")
        },
        reference: {
          value: "present",
          evidenceArtifactDigest: digest("evidence-artifact"),
          labelArtifactDigest: digest("label-artifact"),
          labelerIds: ["synthetic-labeler-a", "synthetic-labeler-b"],
          adjudication: {
            status: "labelers-agreed",
            adjudicatorId: null,
            artifactDigest: null
          }
        }
      }
    ]
  };
}

function runtimeIdentity(): DetectorCalibrationRuntimeIdentity {
  const declared = {
    observer: "node-playwright",
    automation: "playwright-chromium",
    nodeVersion: "24.14.1",
    playwrightVersion: "1.62.0",
    browserName: "chromium",
    browserVersion: "145.0.7632.6",
    operatingSystem: "linux",
    architecture: "x64"
  } as const;
  return { ...declared, runtimeDigest: detectorCalibrationRuntimeDigest(declared) };
}

function digest(value: string): string {
  return sha256Hex(value);
}
