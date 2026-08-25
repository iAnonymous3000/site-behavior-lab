import assert from "node:assert/strict";
import { test } from "node:test";
import { wilsonInterval } from "./cluster-interval-lib.mjs";
import {
  PREREGISTERED_PILOT_MINIMUM,
  PREREGISTERED_SIZING_ASSURANCE,
  assertFrameFeasible,
  binomialTailAtLeast,
  deriveFrameSizeFromPilot,
  deriveFrameSizeFromPilotEnvelope
} from "./calibration-pilot-sizing-lib.mjs";

test("the binomial tail is exact at its anchors", () => {
  // Small cases with hand-computable truth.
  assert.equal(binomialTailAtLeast(3, 0.5, 0), 1);
  assert.ok(Math.abs(binomialTailAtLeast(3, 0.5, 3) - 0.125) < 1e-12);
  assert.ok(Math.abs(binomialTailAtLeast(2, 0.5, 1) - 0.75) < 1e-12);
  assert.equal(binomialTailAtLeast(5, 0, 1), 0);
  assert.equal(binomialTailAtLeast(5, 1, 5), 1);
  assert.equal(binomialTailAtLeast(4, 0.3, 5), 0);
});

test("the sizing rule is the preregistered one, monotone and endpoint-conservative", () => {
  // A balanced pilot: 50/100 present. Wilson 95% is roughly [0.404, 0.596],
  // so both classes size from a rate near 0.40.
  const derived = deriveFrameSizeFromPilot({
    pilotPresent: 50,
    pilotTotal: 100,
    minimumPerClass: 100
  });
  const interval = wilsonInterval(50, 100, 1.96);
  assert.equal(derived.interval95.lower, interval.lo);
  assert.equal(derived.interval95.upper, interval.hi);
  assert.equal(derived.assurance, PREREGISTERED_SIZING_ASSURANCE);
  // The rule's own verdicts at N hold by construction.
  assert.ok(derived.perClass.referencePresent.assuranceAtN >= 0.99);
  assert.ok(derived.perClass.referenceAbsent.assuranceAtN >= 0.99);
  // And N-1 must NOT satisfy both, or N was not minimal.
  const nMinusOne = derived.derivedN - 1;
  const presentAt = binomialTailAtLeast(nMinusOne, derived.perClass.referencePresent.rate, 100);
  const absentAt = binomialTailAtLeast(nMinusOne, derived.perClass.referenceAbsent.rate, 100);
  assert.ok(presentAt < 0.99 || absentAt < 0.99, "derived N must be minimal");

  // A skewed pilot sizes from its WEAK class: 85/100 present makes the
  // absent class the binding constraint, so N grows well beyond the balanced
  // case.
  const skewed = deriveFrameSizeFromPilot({
    pilotPresent: 85,
    pilotTotal: 100,
    minimumPerClass: 100
  });
  assert.ok(skewed.derivedN > derived.derivedN);
  assert.ok(
    skewed.perClass.referenceAbsent.rate < skewed.perClass.referencePresent.rate,
    "the absent class binds"
  );
});

test("pilots below the preregistered minimum are refused, as is a pointless assurance", () => {
  assert.equal(PREREGISTERED_PILOT_MINIMUM, 100);
  assert.throws(
    () => deriveFrameSizeFromPilot({ pilotPresent: 10, pilotTotal: 60, minimumPerClass: 100 }),
    /preregistered minimum of 100/
  );
  assert.throws(
    () =>
      deriveFrameSizeFromPilot({
        pilotPresent: 50,
        pilotTotal: 100,
        minimumPerClass: 100,
        assurance: 1
      }),
    /strictly between 0 and 1/
  );
});

test("the fail condition is code, and offers no remedial parameter", () => {
  assert.deepEqual(assertFrameFeasible({ derivedN: 300, sweptEligiblePool: 480 }), {
    derivedN: 300,
    sweptEligiblePool: 480
  });
  assert.throws(
    () => assertFrameFeasible({ derivedN: 700, sweptEligiblePool: 480 }),
    /INFEASIBLE at this pool.*never a relaxed exclusion, a reused pilot site, or a narrowed population/
  );
});

test("an extreme pilot fails with the honest message, never a clamped answer", () => {
  // Everything present: the absent class has Wilson upper near 1, so the
  // absent-side rate is ~0 and no N can guard it.
  assert.throws(
    () => deriveFrameSizeFromPilot({ pilotPresent: 100, pilotTotal: 100, minimumPerClass: 100 }),
    /cannot support this study's claimed classes/
  );
});

test("the uncertainty envelope reduces exactly to the point rule at zero uncertain and never below it", () => {
  for (const present of [18, 50, 82]) {
    const point = deriveFrameSizeFromPilot({ pilotPresent: present, pilotTotal: 100, minimumPerClass: 100 });
    const envelope = deriveFrameSizeFromPilotEnvelope({
      present,
      absent: 100 - present,
      uncertain: 0,
      minimumPerClass: 100
    });
    assert.equal(envelope.derivedN, point.derivedN);
    assert.deepEqual(envelope.interval95, point.interval95);
  }
  // Uncertainty can only demand MORE: each uncertain label widens the
  // interval both ways, so the envelope N is monotonically at or above the
  // point rule's N for the same present count.
  const withUncertain = deriveFrameSizeFromPilotEnvelope({
    present: 50,
    absent: 40,
    uncertain: 10,
    minimumPerClass: 100
  });
  const without = deriveFrameSizeFromPilot({ pilotPresent: 50, pilotTotal: 100, minimumPerClass: 100 });
  assert.ok(withUncertain.derivedN > without.derivedN);
  assert.equal(withUncertain.derivedN, 390);
  assert.equal(without.derivedN, 295);
  assert.throws(
    () => deriveFrameSizeFromPilotEnvelope({ present: 40, absent: 40, uncertain: 19, minimumPerClass: 100 }),
    /preregistered minimum of 100/
  );
});

test("the round-1 feasibility band: 18..82 present of 100 is NECESSARY at the optimistic 1,126 ceiling", () => {
  // Round 1 of the reliability sweep (artifact sha256
  // 7dfc91056e1f194ae2b53c6807d0c6ffe0064b58dbb3fce817ffe05dd81e00e3)
  // observed 1,126 bare-load-valid cases of 2,262: the rounds-1/2 eligible
  // pool can never exceed that ceiling. This band is the ZERO-UNCERTAIN
  // boundary case and therefore necessary only: uncertain labels narrow it
  // through the envelope. Outside the band the run stops and the universe
  // is enlarged; never a relaxed rule.
  const ceiling = 1126;
  for (const [present, fits] of [[17, false], [18, true], [82, true], [83, false]]) {
    const derived = deriveFrameSizeFromPilot({
      pilotPresent: present,
      pilotTotal: 100,
      minimumPerClass: 100
    });
    assert.equal(
      derived.derivedN <= ceiling,
      fits,
      `${present}/100 derives N=${derived.derivedN}, expected ${fits ? "within" : "beyond"} ${ceiling}`
    );
  }
  assert.equal(deriveFrameSizeFromPilot({ pilotPresent: 18, pilotTotal: 100, minimumPerClass: 100 }).derivedN, 1053);
  assert.equal(deriveFrameSizeFromPilot({ pilotPresent: 17, pilotTotal: 100, minimumPerClass: 100 }).derivedN, 1132);
});

test("an unsizable pilot is a DETERMINATION for the artifact, and still an assertion for callers", async () => {
  const { deriveFrameSizeFromPilotEnvelope, tryDeriveFrameSizeFromPilotEnvelope } = await import(
    "./calibration-pilot-sizing-lib.mjs"
  );
  // The gate's fail condition is the outcome the study most needs recorded.
  // Throwing produced a stack trace and no artifact, so the one result that
  // stops the study left no evidence behind.
  for (const counts of [
    { present: 0, absent: 0, uncertain: 100 },
    { present: 0, absent: 100, uncertain: 0 },
    { present: 100, absent: 0, uncertain: 0 }
  ]) {
    const determination = tryDeriveFrameSizeFromPilotEnvelope({ ...counts, minimumPerClass: 100 });
    assert.equal(determination.sized, false);
    assert.match(determination.reason, /cannot support this study's claimed classes/);
    assert.throws(
      () => deriveFrameSizeFromPilotEnvelope({ ...counts, minimumPerClass: 100 }),
      /cannot support this study's claimed classes/
    );
  }
  // A sizable pilot returns the same numbers through both forms: one search,
  // two presentations.
  const sizable = { present: 18, absent: 82, uncertain: 0, minimumPerClass: 100 };
  const asserted = deriveFrameSizeFromPilotEnvelope(sizable);
  const determined = tryDeriveFrameSizeFromPilotEnvelope(sizable);
  assert.equal(determined.sized, true);
  assert.equal(determined.derivedN, asserted.derivedN);
  assert.deepEqual(determined.interval95, asserted.interval95);
});
