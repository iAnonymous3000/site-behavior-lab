import assert from "node:assert/strict";
import { test } from "node:test";
import { wilsonInterval } from "./cluster-interval-lib.mjs";
import {
  PREREGISTERED_PILOT_MINIMUM,
  PREREGISTERED_SIZING_ASSURANCE,
  assertFrameFeasible,
  binomialTailAtLeast,
  deriveFrameSizeFromPilot
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
