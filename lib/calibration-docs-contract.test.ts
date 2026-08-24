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
  // The two-generation split must stay described on both surfaces: v3 as the
  // committed/historical contract, v4 as the adopted forward contract. A doc
  // declaring v3 "release-grade custody-lane" without the v4 sentence is the
  // stale state the item-3 review flagged.
  assert.match(calibration, /detector-calibration-study\.v4\.schema\.json/);
  const operations = readFileSync(
    path.join(process.cwd(), "docs", "calibration-study-operations.md"),
    "utf8"
  );
  assert.match(operations, /All NEW ceremonies use the v4\s+side-separated contract/);
  assert.match(operations, /detector-calibration-study\.v4\.schema\.json/);
  assert.doesNotMatch(
    operations,
    /release-grade custody-lane study schema is\n`\/schemas\/detector-calibration-study\.v3/
  );
});

test("the shared labeling protocol cannot widen the CNAME or consent plan", () => {
  const drafts = path.join(process.cwd(), "docs", "calibration-prereg-drafts");
  const protocol = readFileSync(path.join(drafts, "labeling-protocol.md"), "utf8");
  const consent = protocol.slice(
    protocol.indexOf("### consent-banner"),
    protocol.indexOf("### fingerprint-heuristics")
  );
  const cname = protocol.slice(
    protocol.indexOf("### cname-uncloaking"),
    protocol.indexOf("### keystroke-exfiltration")
  );
  const cnamePlan = JSON.parse(
    readFileSync(path.join(drafts, "plan-cname-uncloaking.draft.json"), "utf8")
  );
  const consentPlan = JSON.parse(
    readFileSync(path.join(drafts, "plan-consent-banner.draft.json"), "utf8")
  );

  assert.match(protocol, /detector plan's `referenceProtocol` is authoritative/);
  assert.match(protocol, /reference-label-uncertain/);
  assert.doesNotMatch(protocol, /cannot decide from the evidence labels absent/);

  assert.match(consent, /rendered and\s+visible in the page or one of its frames/i);
  assert.match(consent, /CMP loader\s+request[\s\S]*NOT PRESENT/);
  assert.match(consent, /banner-visibility@1/);
  assert.match(consentPlan.design.referenceProtocol, /VISIBLY OFFERED/);
  assert.match(consentPlan.design.referenceProtocol, /CMP loader request[\s\S]*NOT present/i);

  assert.match(cname, /Without using any input produced by this scanner/);
  assert.match(cname, /external, publicly published[\s\S]*pinned by SHA-256/);
  assert.match(cname, /not determined and must\s+not be labelled absent/);
  assert.doesNotMatch(cname, /recorded DNS evidence/);
  assert.doesNotMatch(cname, /curated catalog's CNAME vendors/);
  assert.match(cnamePlan.design.referenceProtocol, /WITHOUT any input produced by this scanner/);
  assert.match(cnamePlan.design.referenceProtocol, /NOT admissible reference inputs/);
});
