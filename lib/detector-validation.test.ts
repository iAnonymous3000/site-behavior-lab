import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { DETECTOR_IDS } from "./scan-report-v2";
import {
  DETECTOR_VALIDATION_FIXTURES,
  detectorValidationMetadata,
  detectorValidationRows,
  validateDetectorValidationManifest
} from "./detector-validation";

test("public detector validation manifest is complete and mechanically valid", () => {
  assert.deepEqual(validateDetectorValidationManifest(DETECTOR_VALIDATION_FIXTURES), []);
  assert.equal(DETECTOR_VALIDATION_FIXTURES.length, 19);
  assert.equal(detectorValidationRows().length, DETECTOR_IDS.length);
  assert.equal(detectorValidationRows().every((row) => row.positiveCases === 1), true);
  assert.equal(detectorValidationRows().every((row) => row.negativeCases === 1), true);
  // fingerprint-heuristics carries a second adversarial case: the depth-bound
  // coverage-loss fixture that pairs with the wrapper-delegation fixture.
  assert.equal(detectorValidationRows().every((row) => row.adversarialCases >= 1), true);
  assert.equal(
    detectorValidationRows().find((row) => row.detector === "fingerprint-heuristics")?.adversarialCases,
    2
  );
  assert.equal(
    detectorValidationRows().filter((row) => row.detector !== "fingerprint-heuristics").every((row) => row.adversarialCases === 1),
    true
  );
  assert.equal(detectorValidationRows().reduce((sum, row) => sum + row.realChromiumCases, 0), 4);
});

test("every public validation case points to an exact source-controlled test", () => {
  const sources = new Map<string, string>();
  for (const fixture of DETECTOR_VALIDATION_FIXTURES) {
    const source = sources.get(fixture.file) ?? readFileSync(path.join(process.cwd(), fixture.file), "utf8");
    sources.set(fixture.file, source);
    assert.equal(
      source.includes(`test("${fixture.testName}"`),
      true,
      `${fixture.file} no longer contains the pinned test: ${fixture.testName}`
    );
  }
});

test("validation matrix digest covers the exact public fixture inventory", () => {
  assert.equal(detectorValidationMetadata.version, "detector-fixture-matrix-v1");
  assert.equal(detectorValidationMetadata.registryVersion, "node-detectors-v6");
  assert.equal(
    createHash("sha256").update(JSON.stringify(DETECTOR_VALIDATION_FIXTURES)).digest("hex"),
    detectorValidationMetadata.digest
  );
});

test("manifest validation rejects malformed paths and missing case classes", () => {
  const onlyMalformed = [{
    ...DETECTOR_VALIDATION_FIXTURES[0],
    file: "../outside.test.ts"
  }];
  const issues = validateDetectorValidationManifest(onlyMalformed);
  assert.equal(issues.some((issue) => issue.includes("source must be a repository")), true);
  assert.equal(issues.some((issue) => issue === "fingerprint-heuristics: missing negative fixture"), true);
  assert.equal(issues.some((issue) => issue === "privacy-policy: missing positive fixture"), true);
});
