#!/usr/bin/env node

/**
 * ScanReport v2 schema build (docs/scan-report-v2-rfc.md, 10.3):
 *
 * 1. Compiles the v2 reader/validator lane to dist/schema/ (CommonJS), the
 *    production-safe artifact .mjs scripts consume during consumer migration;
 *    never the .unit-test-dist test tree.
 * 2. Generates the immutable revisioned scan-report and detector-calibration
 *    JSON Schemas from their TS types (the source of truth), writes them to
 *    public/schemas/, and updates the stable scan-report alias, so all schemas
 *    publish with any static build.
 *
 * The generated files are committed; the scan-report and detector-calibration
 * schema-parity tests fail on drift between the committed schemas and fresh
 * generation. The Pages builder also reruns this script inside its isolated
 * worktree (which excludes dist/) so the published copy can never go stale.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createGenerator } from "ts-json-schema-generator";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const SCHEMA_ID = "https://sitebehavior.org/schemas/scan-report.v2.r1.schema.json";
export const R2_SCHEMA_ID = "https://sitebehavior.org/schemas/scan-report.v2.r2.schema.json";
export const DETECTOR_CALIBRATION_SCHEMA_ID =
  "https://sitebehavior.org/schemas/detector-calibration-study.v1.schema.json";
export const DETECTOR_CALIBRATION_V2_SCHEMA_ID =
  "https://sitebehavior.org/schemas/detector-calibration-study.v2.schema.json";
export const DETECTOR_CALIBRATION_V3_SCHEMA_ID =
  "https://sitebehavior.org/schemas/detector-calibration-study.v3.schema.json";
export const DETECTOR_CALIBRATION_V4_SCHEMA_ID =
  "https://sitebehavior.org/schemas/detector-calibration-study.v4.schema.json";
const REVISIONED_PATH = path.join(rootDir, "public", "schemas", "scan-report.v2.r1.schema.json");
const R2_REVISIONED_PATH = path.join(rootDir, "public", "schemas", "scan-report.v2.r2.schema.json");
const DETECTOR_CALIBRATION_PATH = path.join(
  rootDir,
  "public",
  "schemas",
  "detector-calibration-study.v1.schema.json"
);
const DETECTOR_CALIBRATION_V2_PATH = path.join(
  rootDir,
  "public",
  "schemas",
  "detector-calibration-study.v2.schema.json"
);
const DETECTOR_CALIBRATION_V3_PATH = path.join(
  rootDir,
  "public",
  "schemas",
  "detector-calibration-study.v3.schema.json"
);
const DETECTOR_CALIBRATION_V4_PATH = path.join(
  rootDir,
  "public",
  "schemas",
  "detector-calibration-study.v4.schema.json"
);
// The stable alias serves the current revision (r2). The immutable r1 and r2
// files above remain independently published for exact historical reads.
const ALIAS_PATH = path.join(rootDir, "public", "scan-report.schema.json");

/**
 * THE r1 freeze (RFC 10.2), executable: the published r1 schema is immutable
 * apart from validator-parity correctness backports that do not change shape.
 * The drift test alone would pass if the r1 types were edited and both files
 * regenerated together; this pin makes that path fail at build time instead.
 * This pin includes the 2026-07-14 numeric-domain correctness backport. New
 * shapes still go into a new revision's types and schema file.
 */
export const R1_SCHEMA_SHA256 = "018584cefeebedfe2d17ba0117216257865637fc23ba7aafbf2092fee2898821";

/**
 * THE r2 freeze: pinned at publication (2026-07-10) with the same discipline
 * as r1, including its 2026-07-14 numeric-domain correctness backport. New
 * shapes belong in a future revision's file.
 */
export const R2_SCHEMA_SHA256 = "37775a2692dba7ef247cea6047d9da0f355d7084483fda328e5beaca5d2e3df1";

/** Published detector-calibration study v1 is immutable; incompatible changes require v2. */
export const DETECTOR_CALIBRATION_SCHEMA_SHA256 =
  "420cb5db0992cf11a1145fef594d6aeb61dc29cc87ea521a559f1b3c3e538694";
export const DETECTOR_CALIBRATION_V2_SCHEMA_SHA256 =
  "bff4614bb10c983ec4222707309f184aa20ee0f26737a25f46d3ea4256b826ff";
export const DETECTOR_CALIBRATION_V3_SCHEMA_SHA256 =
  "abcbd56177ffcd2d609502251180806bf90b509c11720eae8a205e33d62188b3";
/**
 * The v4 side-separated study shape
 * (docs/calibration-v4-reference-architecture.md); generated from
 * lib/detector-calibration-v4.ts. Pinned at introduction; v4 drift after
 * publication requires an explicit v5 revision.
 */
export const DETECTOR_CALIBRATION_V4_SCHEMA_SHA256 =
  "18e925c5419de1233225ff66cd1c1f2800645c3b699f5405d811a05596e433e2";

export function generateScanReportV2Schema() {
  const schema = createGenerator({
    path: path.join(rootDir, "lib", "scan-report-v2.ts"),
    type: "PublicScanReportV2",
    skipTypeCheck: true,
    additionalProperties: false,
    topRef: true
  }).createSchema("PublicScanReportV2");
  return { $id: SCHEMA_ID, ...schema };
}

export function generateScanReportV2R2Schema() {
  const schema = createGenerator({
    path: path.join(rootDir, "lib", "scan-report-v2-r2.ts"),
    type: "PublicScanReportV2R2",
    skipTypeCheck: true,
    additionalProperties: false,
    topRef: true
  }).createSchema("PublicScanReportV2R2");
  return { $id: R2_SCHEMA_ID, ...schema };
}

export function generateDetectorCalibrationStudySchema() {
  const schema = createGenerator({
    path: path.join(rootDir, "lib", "detector-calibration.ts"),
    type: "DetectorCalibrationStudy",
    skipTypeCheck: true,
    additionalProperties: false,
    topRef: true
  }).createSchema("DetectorCalibrationStudy");
  return { $id: DETECTOR_CALIBRATION_SCHEMA_ID, ...schema };
}

export function generateDetectorCalibrationStudyV2Schema() {
  const schema = createGenerator({
    path: path.join(rootDir, "lib", "detector-calibration.ts"),
    type: "DetectorCalibrationStudyV2",
    skipTypeCheck: true,
    additionalProperties: false,
    topRef: true
  }).createSchema("DetectorCalibrationStudyV2");
  return { $id: DETECTOR_CALIBRATION_V2_SCHEMA_ID, ...schema };
}

export function generateDetectorCalibrationStudyV3Schema() {
  const schema = createGenerator({
    path: path.join(rootDir, "lib", "detector-calibration.ts"),
    type: "DetectorCalibrationStudyV3",
    skipTypeCheck: true,
    additionalProperties: false,
    topRef: true
  }).createSchema("DetectorCalibrationStudyV3");
  return { $id: DETECTOR_CALIBRATION_V3_SCHEMA_ID, ...schema };
}

export function generateDetectorCalibrationStudyV4Schema() {
  const schema = createGenerator({
    path: path.join(rootDir, "lib", "detector-calibration-v4.ts"),
    type: "DetectorCalibrationStudyV4",
    skipTypeCheck: true,
    additionalProperties: false,
    topRef: true
  }).createSchema("DetectorCalibrationStudyV4");
  return { $id: DETECTOR_CALIBRATION_V4_SCHEMA_ID, ...schema };
}

function main() {
  // Atomicity: verify the freeze BEFORE any other side effect (including the
  // validator-artifact compile), so a rejected mutation leaves nothing behind.
  const schema = generateScanReportV2Schema();
  const serialized = `${JSON.stringify(schema, null, 2)}\n`;
  const r2Schema = generateScanReportV2R2Schema();
  const r2Serialized = `${JSON.stringify(r2Schema, null, 2)}\n`;
  const detectorCalibrationSchema = generateDetectorCalibrationStudySchema();
  const detectorCalibrationSerialized = `${JSON.stringify(detectorCalibrationSchema, null, 2)}\n`;
  const detectorCalibrationV2Schema =
    generateDetectorCalibrationStudyV2Schema();
  const detectorCalibrationV2Serialized =
    `${JSON.stringify(detectorCalibrationV2Schema, null, 2)}\n`;
  const detectorCalibrationV3Schema =
    generateDetectorCalibrationStudyV3Schema();
  const detectorCalibrationV3Serialized =
    `${JSON.stringify(detectorCalibrationV3Schema, null, 2)}\n`;
  const detectorCalibrationV4Schema =
    generateDetectorCalibrationStudyV4Schema();
  const detectorCalibrationV4Serialized =
    `${JSON.stringify(detectorCalibrationV4Schema, null, 2)}\n`;
  const digest = createHash("sha256").update(serialized).digest("hex");
  if (digest !== R1_SCHEMA_SHA256) {
    console.error(
      `FATAL: generated r1 schema hash ${digest} does not match the frozen ${R1_SCHEMA_SHA256}.\n` +
        "The published v2 r1 schema is immutable. If the r1 types changed, revert them; " +
        "new shapes belong in a new revision (scan-report.v2.r2.schema.json), never in r1."
    );
    process.exit(1);
  }

  const r2Digest = createHash("sha256").update(r2Serialized).digest("hex");
  if (r2Digest !== R2_SCHEMA_SHA256) {
    console.error(
      `FATAL: generated r2 schema hash ${r2Digest} does not match the frozen ${R2_SCHEMA_SHA256}.\n` +
        "The published v2 r2 schema is immutable. If the r2 types changed, revert them; " +
        "new shapes belong in a new revision, never in a published one."
    );
    process.exit(1);
  }

  const detectorCalibrationDigest = createHash("sha256").update(detectorCalibrationSerialized).digest("hex");
  if (detectorCalibrationDigest !== DETECTOR_CALIBRATION_SCHEMA_SHA256) {
    console.error(
      `FATAL: generated detector-calibration v1 schema hash ${detectorCalibrationDigest} does not match the frozen ` +
        `${DETECTOR_CALIBRATION_SCHEMA_SHA256}.\n` +
        "The published detector-calibration v1 shape is immutable. Revert the change or introduce a v2 study schema."
    );
    process.exit(1);
  }
  const detectorCalibrationV2Digest = createHash("sha256")
    .update(detectorCalibrationV2Serialized)
    .digest("hex");
  if (
    detectorCalibrationV2Digest !==
    DETECTOR_CALIBRATION_V2_SCHEMA_SHA256
  ) {
    console.error(
      `FATAL: generated detector-calibration v2 schema hash ${detectorCalibrationV2Digest} does not match the frozen ` +
        `${DETECTOR_CALIBRATION_V2_SCHEMA_SHA256}. The release-grade v2 shape is immutable after publication.`
    );
    process.exit(1);
  }
  const detectorCalibrationV3Digest = createHash("sha256")
    .update(detectorCalibrationV3Serialized)
    .digest("hex");
  if (
    detectorCalibrationV3Digest !==
    DETECTOR_CALIBRATION_V3_SCHEMA_SHA256
  ) {
    console.error(
      `FATAL: generated detector-calibration v3 schema hash ${detectorCalibrationV3Digest} does not match the pinned ` +
        `${DETECTOR_CALIBRATION_V3_SCHEMA_SHA256}. New v3 drift requires an explicit schema revision.`
    );
    process.exit(1);
  }

  const detectorCalibrationV4Digest = createHash("sha256")
    .update(detectorCalibrationV4Serialized)
    .digest("hex");
  if (
    detectorCalibrationV4Digest !==
    DETECTOR_CALIBRATION_V4_SCHEMA_SHA256
  ) {
    console.error(
      `FATAL: generated detector-calibration v4 schema hash ${detectorCalibrationV4Digest} does not match the pinned ` +
        `${DETECTOR_CALIBRATION_V4_SCHEMA_SHA256}. New v4 drift requires an explicit schema revision.`
    );
    process.exit(1);
  }

  execFileSync(process.execPath, [path.join(rootDir, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.schema.json"], {
    cwd: rootDir,
    stdio: "inherit"
  });

  mkdirSync(path.dirname(REVISIONED_PATH), { recursive: true });
  writeFileSync(REVISIONED_PATH, serialized);
  writeFileSync(R2_REVISIONED_PATH, r2Serialized);
  writeFileSync(DETECTOR_CALIBRATION_PATH, detectorCalibrationSerialized);
  writeFileSync(
    DETECTOR_CALIBRATION_V2_PATH,
    detectorCalibrationV2Serialized
  );
  writeFileSync(
    DETECTOR_CALIBRATION_V3_PATH,
    detectorCalibrationV3Serialized
  );
  writeFileSync(
    DETECTOR_CALIBRATION_V4_PATH,
    detectorCalibrationV4Serialized
  );
  // Dual-read migration is complete: the stable alias now serves r2. This
  // does not mutate either revisioned file or rewrite historical reports.
  writeFileSync(ALIAS_PATH, r2Serialized);
  console.log(
    `Schemas written: ${path.relative(rootDir, REVISIONED_PATH)}, ${path.relative(rootDir, R2_REVISIONED_PATH)}, ` +
      `${path.relative(rootDir, DETECTOR_CALIBRATION_PATH)}, ${path.relative(rootDir, DETECTOR_CALIBRATION_V2_PATH)}, ` +
      `${path.relative(rootDir, DETECTOR_CALIBRATION_V3_PATH)}, ${path.relative(rootDir, DETECTOR_CALIBRATION_V4_PATH)} ` +
      `(+ stable alias on r2), validator artifact in dist/schema/.`
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
