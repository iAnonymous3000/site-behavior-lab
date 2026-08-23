import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import path from "node:path";
import Ajv from "ajv";
import { createGenerator } from "ts-json-schema-generator";
import {
  currentDetectorCalibrationReleaseIdentity,
  detectorCalibrationMeasurementCondition,
  detectorCalibrationRuntimeDigest,
  detectorCalibrationStudyIssues,
  DETECTOR_CALIBRATION_STUDY_SCHEMA_ID,
  DETECTOR_CALIBRATION_STUDY_V2_SCHEMA_ID,
  DETECTOR_CALIBRATION_STUDY_V3_SCHEMA_ID,
  type DetectorCalibrationRuntimeIdentity,
  type DetectorCalibrationStudy,
  type DetectorCalibrationStudyV2,
  type DetectorCalibrationStudyV3
} from "./detector-calibration";
import { sha256Hex } from "./sha256";

const ROOT = process.cwd();
const SCHEMA_PATH = path.join(ROOT, "public", "schemas", "detector-calibration-study.v1.schema.json");
const FROZEN_SCHEMA_SHA256 = "420cb5db0992cf11a1145fef594d6aeb61dc29cc87ea521a559f1b3c3e538694";
const V2_SCHEMA_PATH = path.join(
  ROOT,
  "public",
  "schemas",
  "detector-calibration-study.v2.schema.json"
);
const FROZEN_V2_SCHEMA_SHA256 =
  "bff4614bb10c983ec4222707309f184aa20ee0f26737a25f46d3ea4256b826ff";
const V3_SCHEMA_PATH = path.join(
  ROOT,
  "public",
  "schemas",
  "detector-calibration-study.v3.schema.json"
);
const FROZEN_V3_SCHEMA_SHA256 =
  "abcbd56177ffcd2d609502251180806bf90b509c11720eae8a205e33d62188b3";
const V4_SCHEMA_PATH = path.join(
  ROOT,
  "public",
  "schemas",
  "detector-calibration-study.v4.schema.json"
);
const FROZEN_V4_SCHEMA_SHA256 =
  "b273b058f51ace25ca9d4aabb61910dbec7a1050dcf4d3ef4f2e4c281c0f5538";

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

function generatedV2Schema(): Record<string, unknown> {
  const schema = createGenerator({
    path: path.join(ROOT, "lib", "detector-calibration.ts"),
    type: "DetectorCalibrationStudyV2",
    skipTypeCheck: true,
    additionalProperties: false,
    topRef: true
  }).createSchema("DetectorCalibrationStudyV2");
  return { $id: DETECTOR_CALIBRATION_STUDY_V2_SCHEMA_ID, ...schema };
}

function generatedV4Schema(): Record<string, unknown> {
  const schema = createGenerator({
    path: path.join(ROOT, "lib", "detector-calibration-v4.ts"),
    type: "DetectorCalibrationStudyV4",
    skipTypeCheck: true,
    additionalProperties: false,
    topRef: true
  }).createSchema("DetectorCalibrationStudyV4");
  return {
    $id: "https://sitebehavior.org/schemas/detector-calibration-study.v4.schema.json",
    ...schema
  };
}

function generatedV3Schema(): Record<string, unknown> {
  const schema = createGenerator({
    path: path.join(ROOT, "lib", "detector-calibration.ts"),
    type: "DetectorCalibrationStudyV3",
    skipTypeCheck: true,
    additionalProperties: false,
    topRef: true
  }).createSchema("DetectorCalibrationStudyV3");
  return { $id: DETECTOR_CALIBRATION_STUDY_V3_SCHEMA_ID, ...schema };
}

test("the committed detector-calibration schema equals a fresh generation from the study type", () => {
  const bytes = readFileSync(SCHEMA_PATH);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), FROZEN_SCHEMA_SHA256);
  const committed = JSON.parse(bytes.toString("utf8"));
  assert.deepEqual(committed, generatedSchema(), "run `npm run build:schema` and commit the result");
});

test("the release-grade v2 schema binds the fixed measurement condition", () => {
  const bytes = readFileSync(V2_SCHEMA_PATH);
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    FROZEN_V2_SCHEMA_SHA256
  );
  const committed = JSON.parse(bytes.toString("utf8"));
  assert.deepEqual(
    committed,
    generatedV2Schema(),
    "run `npm run build:schema` and commit the result"
  );
  const validate = new Ajv({ allErrors: true, strict: false }).compile(
    generatedV2Schema()
  );
  const valid = fixtureV2();
  assert.equal(validate(valid), true, JSON.stringify(validate.errors));
  assert.deepEqual(detectorCalibrationStudyIssues(valid), []);

  const wrongArm = structuredClone(valid);
  wrongArm.design.measurementCondition.consentMode = "accept-all";
  assert.equal(
    validate(wrongArm),
    true,
    "JSON Schema checks shape; runtime policy pins the detector-specific arm"
  );
  assert.match(
    detectorCalibrationStudyIssues(wrongArm).join("\n"),
    /canonical detector-specific measurement arm/
  );
});

test("the current v3 schema preserves the v2 measurement arm and binds blind-tiebreaker semantics", () => {
  const bytes = readFileSync(V3_SCHEMA_PATH);
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    FROZEN_V3_SCHEMA_SHA256
  );
  const committed = JSON.parse(bytes.toString("utf8"));
  assert.deepEqual(
    committed,
    generatedV3Schema(),
    "run `npm run build:schema` and commit the result"
  );
  const validateV3 = new Ajv({ allErrors: true, strict: false }).compile(
    generatedV3Schema()
  );
  const valid = fixtureV3();
  assert.equal(validateV3(valid), true, JSON.stringify(validateV3.errors));
  assert.deepEqual(detectorCalibrationStudyIssues(valid), []);

  const v2WithV3Custody = structuredClone(fixtureV2()) as Record<
    string,
    unknown
  >;
  const firstCase = (v2WithV3Custody.cases as Array<Record<string, unknown>>)[0];
  const reference = firstCase.reference as Record<string, unknown>;
  reference.adjudication = {
    status: "labelers-agreed",
    tiebreakerId: null,
    artifactDigest: null
  };
  const validateV2 = new Ajv({ allErrors: true, strict: false }).compile(
    generatedV2Schema()
  );
  assert.equal(validateV2(v2WithV3Custody), false);
  assert.notDeepEqual(detectorCalibrationStudyIssues(v2WithV3Custody), []);
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

function fixtureV2(): DetectorCalibrationStudyV2 {
  const legacy = fixture();
  return {
    ...legacy,
    schemaVersion: 2,
    design: {
      ...legacy.design,
      measurementCondition: detectorCalibrationMeasurementCondition(
        legacy.detector
      )
    }
  };
}

function fixtureV3(): DetectorCalibrationStudyV3 {
  const legacy = fixture();
  return {
    ...legacy,
    schemaVersion: 3,
    labelRosterAuthorizationSha256: digest(
      "label-roster-authorization"
    ),
    rosterSelectionLedgerSha256: digest("roster-selection-ledger"),
    acquisitionAttemptLedgerSha256: digest(
      "acquisition-attempt-ledger"
    ),
    design: {
      ...legacy.design,
      measurementCondition: detectorCalibrationMeasurementCondition(
        legacy.detector
      )
    },
    cases: legacy.cases.map((entry) =>
      entry.outcome === "complete"
        ? {
            ...entry,
            reference: {
              ...entry.reference,
              adjudication: {
                status: "labelers-agreed" as const,
                tiebreakerId: null,
                artifactDigest: null
              }
            }
          }
        : entry
    )
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

test("the v4 side-separated schema is committed, pinned, and generated from its own module", () => {
  const bytes = readFileSync(V4_SCHEMA_PATH);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), FROZEN_V4_SCHEMA_SHA256);
  const committed = JSON.parse(bytes.toString("utf8"));
  assert.deepEqual(committed, generatedV4Schema(), "run `npm run build:schema` and commit the result");
  // The generations stay separate: the v4 schema never mentions a merged
  // outcome or the frozen presence fact, and the frozen v3 digest is
  // untouched by v4's existence.
  const serialized = JSON.stringify(committed);
  assert.equal(/-presence/.test(serialized), false, "no scanner-derived presence fact in v4");
  assert.equal(
    createHash("sha256").update(readFileSync(V3_SCHEMA_PATH)).digest("hex"),
    FROZEN_V3_SCHEMA_SHA256
  );
});
