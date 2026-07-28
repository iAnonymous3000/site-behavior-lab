import assert from "node:assert/strict";
import test from "node:test";
import { RUN_MODE_LABELS, RUN_MODE_TITLES, runModeHint } from "./run-mode-copy";

test("run-mode labels lead with function, not Brave-internal vocabulary", () => {
  assert.equal(RUN_MODE_LABELS.shields, "Blocker");
  // The bare word "Shields" meant nothing to first-time visitors; the brand
  // belongs in the definitions below, never alone in a label.
  for (const label of Object.values(RUN_MODE_LABELS)) {
    assert.equal(/shields/i.test(label), false, `label "${label}" must not use bare Shields vocabulary`);
  }
});

test("every comparison mode defines its jargon in the tooltip and hint", () => {
  // The blocking mode must name the SIMULATION: Brave's engine and lists in
  // this scanner's browser, never a claim of a live Brave-browser visit.
  assert.match(RUN_MODE_TITLES.shields, /simulation, not a live Brave-browser visit/);
  assert.match(RUN_MODE_TITLES.gpc, /Global Privacy Control/);
  assert.match(runModeHint("shields"), /simulation of Brave Shields inside this scanner's browser/);
  assert.match(runModeHint("shields"), /one pair of visits/);
  assert.match(runModeHint("shields"), /does not treat that difference as a causal blocking rate/);
  assert.match(runModeHint("gpc"), /Global Privacy Control \(GPC\)/);
  assert.match(runModeHint("gpc"), /cannot prove that the site received or honored the signal/);
  assert.match(runModeHint("single"), /One controlled visit/);
});

test("consent mode explains both choices and the honest failure state", () => {
  assert.match(RUN_MODE_TITLES.consent, /"Accept all"/);
  assert.match(RUN_MODE_TITLES.consent, /"Reject all"/);
  assert.match(runModeHint("consent"), /"Accept all"/);
  assert.match(runModeHint("consent"), /"Reject all"/);
  // The hint must state what happens when no control is found, so the mode
  // never implies the choice was measured when it was not.
  assert.match(runModeHint("consent"), /pre-consent/);
});
