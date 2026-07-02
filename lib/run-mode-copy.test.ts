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
  assert.match(RUN_MODE_TITLES.shields, /Brave Shields, the ad and tracker blocker built into the Brave browser/);
  assert.match(RUN_MODE_TITLES.gpc, /Global Privacy Control/);
  assert.match(runModeHint("shields"), /Brave Shields \(the ad and tracker blocker built into the Brave browser\)/);
  assert.match(runModeHint("gpc"), /Global Privacy Control \(GPC\)/);
  assert.match(runModeHint("single"), /One controlled visit/);
});
