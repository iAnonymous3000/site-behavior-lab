import assert from "node:assert/strict";
import { test } from "node:test";
import { assertCaughtBy, Counterexample, holds, loadVariant } from "./finite-check";
import { assertProperty } from "./seeded-property";

type SeededPropertyModule = { assertProperty: typeof assertProperty };

const seededProperty = require.resolve("./seeded-property");

test("holds names the property and the input, and builds the input only on failure", () => {
  let built = 0;
  holds("always", true, () => {
    built += 1;
    return null;
  });
  assert.equal(built, 0);
  assert.throws(
    () => holds("never", false, () => ({ row: 7 })),
    (error: unknown) => {
      assert.ok(error instanceof Counterexample);
      assert.equal(error.property, "never");
      assert.deepEqual(error.input, { row: 7 });
      return true;
    }
  );
});

test("assertCaughtBy returns the counterexample only for the named property", async () => {
  const caught = await assertCaughtBy("v", "p", () => holds("p", false, () => 1));
  assert.equal(caught.input, 1);
});

test("assertCaughtBy refuses a variant the check passes", async () => {
  await assert.rejects(assertCaughtBy("v", "p", () => undefined), /passed the check/);
});

test("assertCaughtBy refuses a variant caught for another property", async () => {
  await assert.rejects(assertCaughtBy("v", "p", () => holds("q", false, () => 1)), /caught by "q", not "p"/);
});

test("assertCaughtBy refuses a variant that breaks the check instead of a property", async () => {
  await assert.rejects(
    assertCaughtBy("v", "p", () => {
      throw new TypeError("not a counterexample");
    }),
    /broke the check itself/
  );
});

test("loadVariant applies its edit to a separate instance and leaves production alone", () => {
  const variant = loadVariant<SeededPropertyModule>(seededProperty, [{ find: "function assertProperty(", replace: "function assertProperty(" }]);
  assert.notEqual(variant.assertProperty, assertProperty);
  assert.equal(typeof variant.assertProperty, "function");
});

test("loadVariant resolves the variant's own imports", () => {
  const variant = loadVariant<{ NODE_R2_PRODUCER_TUPLES: readonly unknown[] }>(
    require.resolve("./scan-report-v2-r2-producer-contract"),
    []
  );
  assert.ok(variant.NODE_R2_PRODUCER_TUPLES.length > 0);
});

test("loadVariant keeps a replacement literal, including replacement patterns", () => {
  const variant = loadVariant<{ edited: string }>(seededProperty, [
    { find: "exports.seededRandom = seededRandom;", replace: 'exports.seededRandom = seededRandom; exports.edited = "$&";' }
  ]);
  assert.equal(variant.edited, "$&");
});

test("loadVariant refuses an edit that does not land exactly once", () => {
  assert.throws(() => loadVariant(seededProperty, [{ find: "no such text anywhere", replace: "" }]), /occurs 0 times/);
  assert.throws(() => loadVariant(seededProperty, [{ find: "function", replace: "function" }]), /must land exactly once/);
});
