import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

test("the research model describes the current precommitted blind-tiebreaker contract", () => {
  const document = readFileSync(
    path.join(process.cwd(), "docs", "research-evidence-model.md"),
    "utf8"
  );
  const calibration = document.slice(
    document.indexOf("## Detector calibration")
  );

  assert.match(
    calibration,
    /\/schemas\/detector-calibration-study\.v3\.schema\.json/
  );
  assert.match(
    calibration,
    /two through ten unique opaque labeler ids/
  );
  assert.match(
    calibration,
    /primary labelers and one\s+distinct blind tiebreaker commit their complete-frame encrypted label sources\s+before acquisition starts/i
  );
  assert.match(
    calibration,
    /contributes to the final reference value only when the primary labels\s+disagree/
  );
  assert.doesNotMatch(calibration, /disagreement-adjudicated/);
  assert.doesNotMatch(calibration, /separately identified adjudicator/);
  assert.doesNotMatch(calibration, /label\/adjudicator identities/);
});
