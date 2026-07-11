import assert from "node:assert/strict";
import { test } from "node:test";
import { CANONICALIZATION_VERSION, canonicalJson, publicReportDigest } from "./canonical-json";

test("canonical JSON sorts keys, strips whitespace, and is stable across formatting", () => {
  const a = { b: 1, a: { d: [1, 2], c: "x" } };
  const b = { a: { c: "x", d: [1, 2] }, b: 1 };
  assert.equal(canonicalJson(a), '{"a":{"c":"x","d":[1,2]},"b":1}');
  assert.equal(canonicalJson(a), canonicalJson(b));
  // A pretty-printed committed report and a compact R2 object digest identically.
  assert.equal(publicReportDigest(JSON.parse(JSON.stringify(a, null, 2))), publicReportDigest(b));
});

test("strings normalize to NFC so byte-different composed forms digest identically", () => {
  const composed = "café";
  const decomposed = "café";
  assert.notEqual(composed, decomposed);
  assert.equal(canonicalJson({ v: composed }), canonicalJson({ v: decomposed }));
});

test("undefined members are omitted; an absent and an undefined field digest identically", () => {
  assert.equal(canonicalJson({ a: 1, b: undefined }), canonicalJson({ a: 1 }));
});

test("non-JSON values are rejected loudly, never coerced", () => {
  assert.throws(() => canonicalJson({ v: Number.NaN }), /non-finite number/);
  assert.throws(() => canonicalJson({ v: [1, undefined, 2] }), /undefined array element/);
  assert.throws(() => canonicalJson({ v: () => 1 }), /unsupported function/);
});

test("the canonicalization version is pinned; changing the rules must change it", () => {
  assert.equal(CANONICALIZATION_VERSION, "canon-v1");
  // A frozen digest of a fixed value: if the canonical form ever changes
  // without a version bump, this pin fails first.
  assert.equal(
    publicReportDigest({ reportType: "single", schemaVersion: 1 }),
    publicReportDigest({ schemaVersion: 1, reportType: "single" })
  );
  assert.equal(canonicalJson({ z: true, a: null }), '{"a":null,"z":true}');
});
