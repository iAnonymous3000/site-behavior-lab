import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  RUN_MODE_CHECKING_NOTE,
  RUN_MODE_LABELS,
  RUN_MODE_TITLES,
  RUN_MODE_UNAVAILABLE_NOTES,
  reportRunMode,
  runModeAvailability,
  runModeDescription,
  runModeHint
} from "./run-mode-copy";

test("a published report names its kind by the Run control's mode, or by none the form cannot run", () => {
  assert.equal(reportRunMode({ reportType: "single" }), "single");
  assert.equal(reportRunMode({ reportType: "single", comparisonType: null }), "single");
  assert.equal(reportRunMode({ reportType: "comparison", comparisonType: "gpc" }), "gpc");
  assert.equal(reportRunMode({ reportType: "comparison", comparisonType: "shields" }), "shields");
  assert.equal(reportRunMode({ reportType: "comparison", comparisonType: "consent" }), "consent");
  // Kinds the Run control cannot produce get no mode, never a borrowed one.
  assert.equal(reportRunMode({ reportType: "comparison", comparisonType: "temporal" }), null);
  assert.equal(reportRunMode({ reportType: "comparison", comparisonType: "custom" }), null);
  assert.equal(reportRunMode({ reportType: "comparison", comparisonType: null }), null);
  assert.equal(reportRunMode({ reportType: "comparison" }), null);
});

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

test("no comparison is claimed available or unavailable before the scanner's health answers", () => {
  // Journey audit gap 18: the static build flashed three "not available" lines
  // on first paint, and the dynamic build offered modes health could refuse.
  assert.equal(runModeAvailability(true, true), "checking");
  assert.equal(runModeAvailability(false, true), "checking");
  assert.equal(runModeAvailability(true, false), "available");
  assert.equal(runModeAvailability(false, false), "unavailable");
  for (const mode of ["gpc", "shields", "consent"] as const) {
    assert.deepEqual(runModeDescription(mode, "checking"), { text: RUN_MODE_TITLES[mode], shown: false });
    assert.deepEqual(runModeDescription(mode, "available"), { text: RUN_MODE_TITLES[mode], shown: false });
    assert.deepEqual(runModeDescription(mode, "unavailable"), { text: RUN_MODE_UNAVAILABLE_NOTES[mode], shown: true });
    assert.doesNotMatch(RUN_MODE_TITLES[mode], /not available|requires/, "a description says what a mode does, not whether it is offered");
  }
  assert.match(RUN_MODE_CHECKING_NOTE, /^Checking /);
});

test("the scan form shows the run modes as checking until health answers", () => {
  const source = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");
  const controls = source("app/_components/scan-controls.tsx");
  for (const mode of ["gpc", "shields", "consent"] as const) {
    assert.match(controls, new RegExp(`const ${mode}Availability = runModeAvailability\\(${mode}ComparisonEnabled, awaitingScannerHealth\\);`));
    assert.match(controls, new RegExp(`disabled=\\{${mode}Availability !== "available"\\}`));
    assert.match(controls, new RegExp(`id="run-mode-${mode}-description">\\s*\\{${mode}Description\\.text\\}`));
  }
  assert.match(controls, /\{awaitingScannerHealth && <p className="run-mode-checking">\{RUN_MODE_CHECKING_NOTE\}<\/p>\}/);
  // The refusal copy lives in one place, behind health's answer.
  for (const note of Object.values(RUN_MODE_UNAVAILABLE_NOTES)) assert.ok(!controls.includes(note), note);
  assert.match(source("app/site-behavior-app.tsx"), /awaitingScannerHealth=\{awaitingScannerHealth\}/);
});
