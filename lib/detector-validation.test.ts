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
  assert.equal(DETECTOR_VALIDATION_FIXTURES.length, 26);
  assert.equal(detectorValidationRows().length, DETECTOR_IDS.length);
  // fingerprint-heuristics carries two more positive cases: the two-vendor
  // chain fixture proving multi-origin chains detect instead of censoring, and
  // the OffscreenCanvas readback fixture proving that surface is observed.
  assert.equal(detectorValidationRows().every((row) => row.positiveCases >= 1), true);
  assert.equal(
    detectorValidationRows().find((row) => row.detector === "fingerprint-heuristics")?.positiveCases,
    3
  );
  // privacy-policy carries two more positive and two more negative cases: a
  // policy that renders its text after load is read in full, and a shell read
  // while its policy request is still open publishes nothing; a short page
  // that names itself a policy is read beside its link to a state notice, and
  // a privacy hub that keeps the policy on another page publishes nothing.
  assert.equal(
    detectorValidationRows()
      .filter((row) => row.detector !== "fingerprint-heuristics" && row.detector !== "privacy-policy")
      .every((row) => row.positiveCases === 1),
    true
  );
  const policyRow = detectorValidationRows().find((row) => row.detector === "privacy-policy");
  assert.equal(policyRow?.positiveCases, 3);
  assert.equal(policyRow?.negativeCases, 3);
  assert.equal(
    detectorValidationRows().filter((row) => row.detector !== "privacy-policy").every((row) => row.negativeCases === 1),
    true
  );
  // fingerprint-heuristics carries two more adversarial cases: the
  // depth-bound coverage-loss fixture that pairs with the wrapper-delegation
  // fixture, and a widget's headline layout overflowing the measured-string
  // bound beside real canvas and audio fingerprinting.
  assert.equal(detectorValidationRows().every((row) => row.adversarialCases >= 1), true);
  assert.equal(
    detectorValidationRows().find((row) => row.detector === "fingerprint-heuristics")?.adversarialCases,
    3
  );
  assert.equal(
    detectorValidationRows().filter((row) => row.detector !== "fingerprint-heuristics").every((row) => row.adversarialCases === 1),
    true
  );
  // Four of them are privacy-policy cases: the two settle cases (rendered
  // late, still loading) and the two hub cases (a labeled short policy, a
  // hub); one is the widget headline-layout case.
  assert.equal(detectorValidationRows().reduce((sum, row) => sum + row.realChromiumCases, 0), 11);
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
  assert.equal(detectorValidationMetadata.registryVersion, "node-detectors-v15");
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
