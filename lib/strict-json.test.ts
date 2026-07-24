import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseStrictJson,
  STRICT_JSON_MAX_NESTING_DEPTH,
  StrictJsonError
} from "./strict-json";

test("strict JSON accepts ordinary nested values", () => {
  assert.deepEqual(parseStrictJson('{"a":[1,true,null,{"b":"x"}]}'), { a: [1, true, null, { b: "x" }] });
});

test("strict JSON rejects duplicate keys at every depth including escaped aliases", () => {
  for (const wire of [
    '{"a":1,"a":2}',
    '{"outer":{"secret":1,"secret":2}}',
    '{"outer":{"a":1,"\\u0061":2}}'
  ]) {
    assert.throws(
      () => parseStrictJson(wire),
      (error: unknown) => error instanceof StrictJsonError && error.reason === "duplicate-key"
    );
  }
});

test("strict JSON enforces its UTF-8 byte budget and grammar", () => {
  assert.throws(() => parseStrictJson('"é"', 3), StrictJsonError);
  for (const wire of ["", "01", "[1,]", '{"a":}', '{"a":"\\x"}']) {
    assert.throws(() => parseStrictJson(wire), StrictJsonError);
  }
});

test("strict JSON rejects excessive nesting with a stable typed error", () => {
  const wire = "[".repeat(STRICT_JSON_MAX_NESTING_DEPTH + 1) + "0" + "]".repeat(STRICT_JSON_MAX_NESTING_DEPTH + 1);
  assert.throws(
    () => parseStrictJson(wire),
    (error: unknown) => error instanceof StrictJsonError && error.reason === "too-deep"
  );
});

test("strict JSON scans a large flat numeric array without quadratic suffix copies", { timeout: 2_000 }, () => {
  const values = Array.from({ length: 50_000 }, (_, index) => index);
  assert.deepEqual(parseStrictJson(JSON.stringify(values)), values);
});
