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
  assert.equal(DETECTOR_VALIDATION_FIXTURES.length, 36);
  assert.equal(detectorValidationRows().length, DETECTOR_IDS.length);
  const row = (detector: string) => detectorValidationRows().find((entry) => entry.detector === detector);
  // fingerprint-heuristics carries three more positive cases: the two-vendor
  // chain fixture proving multi-origin chains detect instead of censoring, the
  // OffscreenCanvas readback fixture proving that surface is observed, and a
  // React-shaped commit traversal past 64 frames that reads as the frame's own
  // registration and keeps a third-party recorder's finding.
  assert.equal(detectorValidationRows().every((entry) => entry.positiveCases >= 1), true);
  assert.equal(row("fingerprint-heuristics")?.positiveCases, 4);
  // privacy-policy carries three more positive and five more negative cases:
  // a policy that renders its text after load is read in full, and a shell
  // read while its policy request is still open publishes nothing; a short
  // page that names itself a policy is read beside its link to a state
  // notice, and a privacy hub that keeps the policy on another page publishes
  // nothing; a policy that folds most of its prose into collapsed sections is
  // read, and a hub whose prose sits in closed panels publishes nothing; and
  // reads cut at the character cap and at the node bound publish nothing.
  const policyRow = row("privacy-policy");
  assert.equal(policyRow?.positiveCases, 4);
  assert.equal(policyRow?.negativeCases, 6);
  // keystroke-exfiltration carries one more positive and one more negative
  // case: a value the route guard refused still names its recipient, and a
  // value the Shields engine stopped names none. cname-uncloaking carries one
  // more positive and one more adversarial case: a tracker four aliases down
  // is a cloak, and a looping chain is a lookup that did not complete.
  assert.equal(row("keystroke-exfiltration")?.positiveCases, 2);
  assert.equal(row("keystroke-exfiltration")?.negativeCases, 2);
  assert.equal(row("cname-uncloaking")?.positiveCases, 2);
  assert.equal(row("cname-uncloaking")?.adversarialCases, 2);
  const singleCaseDetectors = ["pixel-events", "consent-banner"];
  assert.equal(
    detectorValidationRows()
      .filter((entry) => singleCaseDetectors.includes(entry.detector))
      .every((entry) => entry.positiveCases === 1 && entry.negativeCases === 1 && entry.adversarialCases === 1),
    true
  );
  assert.equal(
    detectorValidationRows()
      .filter((entry) => entry.detector !== "privacy-policy" && entry.detector !== "keystroke-exfiltration")
      .every((entry) => entry.negativeCases === 1),
    true
  );
  // fingerprint-heuristics carries three more adversarial cases: the
  // depth-bound coverage-loss fixture that pairs with the wrapper-delegation
  // fixture, a widget's headline layout overflowing the measured-string
  // bound beside real canvas and audio fingerprinting, and two workers that
  // end before they can vouch for their owner read.
  assert.equal(detectorValidationRows().every((entry) => entry.adversarialCases >= 1), true);
  assert.equal(row("fingerprint-heuristics")?.adversarialCases, 4);
  assert.equal(
    detectorValidationRows()
      .filter((entry) => entry.detector !== "fingerprint-heuristics" && entry.detector !== "cname-uncloaking")
      .every((entry) => entry.adversarialCases === 1),
    true
  );
  // Eight of them are privacy-policy cases: the two settle cases (rendered
  // late, still loading), the four hub cases (a labeled short policy, a hub,
  // a folded policy, a hub whose prose sits in closed panels) and the two cut
  // reads; one is the widget headline-layout case, one the React-shaped
  // commit traversal, one the workers that end before they can vouch, two
  // the stopped and the refused typed value, and two the CNAME chains.
  assert.equal(detectorValidationRows().reduce((sum, entry) => sum + entry.realChromiumCases, 0), 21);
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
  assert.equal(detectorValidationMetadata.registryVersion, "node-detectors-v19");
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
