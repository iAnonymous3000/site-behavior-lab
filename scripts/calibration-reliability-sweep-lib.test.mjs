import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  BARE_LOAD_OUTCOME_FIELDS,
  assertBareLoadOnly,
  bareLoadEligible,
  bareLoadOutcome,
  buildReliabilitySweepReceipt
} from "./calibration-reliability-sweep-lib.mjs";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * A report shaped like the real thing: a sound load AND populated detector
 * evidence. If any of that evidence can reach a projection or a receipt, the
 * sweep can select on the detector's own answers and the preregistration is
 * void.
 */
function reportWithDetectorOutput(overrides = {}) {
  return {
    run: {
      summary: { status: 200, pageTitle: "Example" },
      qualityFacts: { navigationSettled: true },
      quality: {
        run: { outcome: "complete" },
        byFamily: {
          requests: { outcome: "complete", reasons: [] },
          fingerprinting: { outcome: "censored", reasons: ["capture-loss:dropped"] }
        }
      },
      evidence: {
        cnameCloaks: [
          { host: "metrics.example.com", target: "collect.tracker.example", service: "Tracker Co" }
        ],
        pixelEvents: [{ platform: "meta", event: "PageView" }],
        requests: [{ url: "https://collect.tracker.example/p", domain: "collect.tracker.example" }]
      },
      ...overrides
    }
  };
}

test("a projection strips detector evidence from a report that has plenty", () => {
  const outcome = bareLoadOutcome("case-a", reportWithDetectorOutput());
  assert.deepEqual(Object.keys(outcome).sort(), [...BARE_LOAD_OUTCOME_FIELDS].sort());

  // The load facts survive.
  assert.equal(outcome.loaded, true);
  assert.equal(outcome.status, 200);
  assert.equal(outcome.navigationSettled, true);
  assert.equal(outcome.censoredFamilyCount, 1);

  // Nothing about what the detector found does. Serializing is the honest
  // check: a nested leak would not show up in a key comparison.
  const serialized = JSON.stringify(outcome);
  for (const forbidden of [
    "cnameCloaks",
    "pixelEvents",
    "metrics.example.com",
    "collect.tracker.example",
    "Tracker Co",
    "PageView"
  ]) {
    assert.equal(
      serialized.includes(forbidden),
      false,
      `projected outcome leaked "${forbidden}"`
    );
  }
});

test("the projection refuses a widened field set instead of admitting it", () => {
  // The enforcement the frame-construction draft said was missing. A future
  // edit that adds a detector field to the projection must fail here.
  assert.throws(
    () => assertBareLoadOnly({ caseId: "case-a", loaded: true, cnameCloaks: [] }),
    /carries "cnameCloaks", which is not a bare-load field/
  );
  assert.throws(
    () => assertBareLoadOnly({ caseId: "case-a", detected: true }),
    /carries "detected"/
  );
});

test("eligibility reads only load facts and cannot be handed a report", () => {
  const sound = bareLoadOutcome("case-a", reportWithDetectorOutput());
  assert.equal(bareLoadEligible(sound), true);

  const failed = bareLoadOutcome("case-b", {
    run: {
      summary: { status: 403 },
      qualityFacts: { navigationSettled: false },
      quality: { run: { outcome: "failed" }, byFamily: {} }
    }
  });
  assert.equal(bareLoadEligible(failed), false);
  assert.equal(failed.loaded, false);

  // A raw report is not an eligibility input.
  assert.throws(() => bareLoadEligible(reportWithDetectorOutput()), /not a bare-load field/);
});

test("a missing or unusable report is recorded as a failed load, never skipped", () => {
  // Silently dropping unloadable cases would bias the frame toward sites that
  // happen to cooperate, which is the same selection hazard by another route.
  const missing = bareLoadOutcome("case-c", null);
  assert.equal(missing.loaded, false);
  assert.equal(missing.runOutcome, "unavailable");
  assert.equal(bareLoadEligible(missing), false);
});

test("the receipt carries load outcomes, an eligible rate, and no verdict", () => {
  const receipt = buildReliabilitySweepReceipt({
    studyId: "cname-uncloaking-2026-08",
    sweptAt: "2026-08-16T00:00:00.000Z",
    outcomes: [
      bareLoadOutcome("case-b", reportWithDetectorOutput()),
      bareLoadOutcome("case-a", reportWithDetectorOutput()),
      bareLoadOutcome("case-c", null)
    ]
  });

  assert.equal(receipt.observedCases, 3);
  assert.equal(receipt.eligibleCases, 2);
  assert.equal(receipt.eligibleFraction, 2 / 3);
  assert.deepEqual(
    receipt.cases.map((entry) => entry.caseId),
    ["case-a", "case-b", "case-c"],
    "cases are sorted so the receipt is deterministic"
  );
  // No pass/fail: clearing the pool is a preregistered human threshold.
  assert.equal("cleared" in receipt, false);
  assert.equal("passed" in receipt, false);

  const serialized = JSON.stringify(receipt);
  for (const forbidden of ["cnameCloaks", "pixelEvents", "collect.tracker.example", "PageView"]) {
    assert.equal(serialized.includes(forbidden), false, `receipt leaked "${forbidden}"`);
  }
});

test("the receipt refuses inputs that would make it non-reproducible or unsound", () => {
  const ok = bareLoadOutcome("case-a", reportWithDetectorOutput());
  assert.throws(
    () => buildReliabilitySweepReceipt({ studyId: "s", sweptAt: "2026-08-16T00:00:00.000Z", outcomes: [] }),
    /observed no cases/
  );
  assert.throws(
    () => buildReliabilitySweepReceipt({ studyId: "s", sweptAt: "not-a-time", outcomes: [ok] }),
    /ISO-8601 UTC sweptAt/
  );
  assert.throws(
    () =>
      buildReliabilitySweepReceipt({
        studyId: "s",
        sweptAt: "2026-08-16T00:00:00.000Z",
        outcomes: [ok, ok]
      }),
    /duplicate case id/
  );
  // A raw report handed straight to the receipt builder must not pass through.
  assert.throws(
    () =>
      buildReliabilitySweepReceipt({
        studyId: "s",
        sweptAt: "2026-08-16T00:00:00.000Z",
        outcomes: [reportWithDetectorOutput()]
      }),
    /not a bare-load field/
  );
});

test("the sweep module never names a detector evidence field in its source", () => {
  // Layer three. The projection could be correct today and a later edit could
  // reach into evidence directly; this reads the module the way the repo's
  // other source-binding guards do, so that edit fails here.
  const source = readFileSync(
    path.join(moduleDir, "calibration-reliability-sweep-lib.mjs"),
    "utf8"
  );
  const code = source
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("*") && !line.trimStart().startsWith("//"))
    .join("\n");
  for (const forbidden of [
    "cnameCloaks",
    "pixelEvents",
    "keystroke",
    "fingerprintEvents",
    "policyClaims",
    "consentObservations",
    "trackerMatches"
  ]) {
    assert.equal(
      code.includes(forbidden),
      false,
      `sweep source reads "${forbidden}"; the sweep must never observe detector output`
    );
  }
  assert.equal(code.includes(".evidence"), false, "sweep source must not reach into run.evidence");
});
