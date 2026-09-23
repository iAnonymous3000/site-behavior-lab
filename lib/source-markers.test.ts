import assert from "node:assert/strict";
import { test } from "node:test";
import { assertOrdered, requireIndex, requireLastIndex, sliceBetween, sliceToNext } from "./source-markers";

// The helpers exist so a guard CAN fail; prove each failure mode fires.
const SOURCE = "function first() {}\nfunction end() {}\nfunction second() {}\nfunction end() {}\n";

test("a missing marker fails and names the marker instead of answering -1", () => {
  assert.equal(requireIndex(SOURCE, "function second"), SOURCE.indexOf("function second"));
  assert.throws(() => requireIndex(SOURCE, "function renamed", "worker"), /worker no longer contains "function renamed"/);
  assert.throws(() => requireIndex(SOURCE, "function first", "worker", 1), /after offset 1/);
  assert.equal(requireLastIndex(SOURCE, "function end"), SOURCE.lastIndexOf("function end"));
  assert.throws(() => requireLastIndex(SOURCE, "function renamed"), /no longer contains/);
});

test("an ordering fails when a marker is missing or out of order", () => {
  assertOrdered(SOURCE, ["function first", "function end", "function second"]);
  // The shape that used to pass vacuously: `-1 < indexOf(b)`.
  assert.throws(() => assertOrdered(SOURCE, ["function renamed", "function second"]), /no longer contains "function renamed"/);
  assert.throws(() => assertOrdered(SOURCE, ["function second", "function renamed"]), /no longer contains "function renamed"/);
  assert.throws(
    () => assertOrdered(SOURCE, ["function second", "function first"], "worker", "why it matters"),
    /worker: "function second" must precede "function first"\. why it matters/
  );
  // First occurrences decide, so a later copy of the second marker cannot
  // rescue an inverted pair.
  assert.throws(() => assertOrdered(SOURCE, ["function second", "function end"]), /must precede/);
});

test("a region never widens onto a later copy or collapses to empty", () => {
  assert.equal(sliceBetween(SOURCE, "function first", "function second"), "function first() {}\nfunction end() {}\n");
  assert.throws(() => sliceBetween(SOURCE, "function second", "function first"), /precedes "function second"/);
  assert.throws(() => sliceBetween(SOURCE, "function second", "function end"), /precedes "function second"/);
  assert.throws(() => sliceBetween(SOURCE, "function first", "function renamed"), /no longer contains/);
  // An end marker that also appears earlier is only reachable explicitly.
  assert.equal(sliceToNext(SOURCE, "function second", "function end"), "function second() {}\n");
  assert.throws(() => sliceToNext(SOURCE, "function second", "function first"), /no longer contains "function first" after offset/);
});
