import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { test } from "node:test";
import { assertCaughtBy, holds, loadVariant, type SourceEdit } from "../../lib/finite-check";
import * as productionCanonical from "../core/canonical-json";
import { canonicalBytes, MAX_CANONICAL_DEPTH, parseCanonical, sha256Hex } from "../core/canonical-json";

/**
 * The form a digest is taken over. Expected bytes and digests here are written out,
 * worked out with shasum and openssl rather than by this module. Injectivity is
 * walked over a closed domain with JSON.parse as the independent reader: two values
 * that shared bytes could not both round-trip.
 */

type CanonicalModule = typeof productionCanonical;

const canonicalVariant = (...edits: SourceEdit[]) => loadVariant<CanonicalModule>(require.resolve("../core/canonical-json"), edits);

const text = (value: unknown, module: CanonicalModule = productionCanonical): string | null => {
  const bytes = module.canonicalBytes(value);
  return bytes === null ? null : new TextDecoder().decode(bytes);
};

test("known value, known bytes, known digest", async () => {
  const value = { b: [1, { y: null, x: true }], a: "é" };
  const bytes = canonicalBytes(value) as Uint8Array<ArrayBuffer>;
  assert.deepEqual(
    Buffer.from(bytes).toString("hex"),
    "7b2261223a22c3a9222c2262223a5b312c7b2278223a747275652c2279223a6e756c6c7d5d7d"
  );
  // printf '%s' '{"a":"é","b":[1,{"x":true,"y":null}]}' | shasum -a 256
  assert.equal(await sha256Hex(bytes), "9446ef5ffc723b7f3c8645663cdb0051a9a80f9fe3a1a0b160053f5c876e8f91");
  // printf '%s' '{}' | openssl dgst -sha256
  assert.equal(await sha256Hex(canonicalBytes({}) as Uint8Array<ArrayBuffer>), "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a");
  // printf '' | shasum -a 256
  assert.equal(await sha256Hex(new Uint8Array(0)), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
});

test("the digest agrees with node:crypto, an implementation that is not this module's", async () => {
  for (const value of [{}, [], "text", 7, null, { nested: { deep: ["\u{1f600}", "\n", '"', "\\"] } }]) {
    const bytes = canonicalBytes(value) as Uint8Array<ArrayBuffer>;
    assert.equal(await sha256Hex(bytes), createHash("sha256").update(bytes).digest("hex"));
  }
});

const SPELLED = [
  [{}, "{}"],
  [[], "[]"],
  [null, "null"],
  [true, "true"],
  [false, "false"],
  [0, "0"],
  [-1, "-1"],
  [Number.MAX_SAFE_INTEGER, "9007199254740991"],
  [Number.MIN_SAFE_INTEGER, "-9007199254740991"],
  ["", '""'],
  ["é", '"é"'],
  ["\n\t\u0000\u001f", '"\\n\\t\\u0000\\u001f"'],
  ['"\\', '"\\"\\\\"'],
  [" \u007f", '" \u007f"'],
  ["\u{1f600}", '"\u{1f600}"'],
  [{ z: 1, a: 2 }, '{"a":2,"z":1}'],
  [{ b: { d: 1, c: 2 }, a: [{ f: 1, e: 2 }] }, '{"a":[{"e":2,"f":1}],"b":{"c":2,"d":1}}'],
  // By UTF-16 code unit: an astral letter's lead surrogate, D83D, sorts before U+FFFD, the reverse of code point order.
  [{ "�": 1, "\u{1f600}": 2 }, '{"\u{1f600}":2,"�":1}'],
  // By code unit, not locale: uppercase before lowercase, and "a10" before "a9".
  [{ a: 1, B: 2, a9: 3, a10: 4 }, '{"B":2,"a":1,"a10":4,"a9":3}']
] as const;

test("each value's one spelling, written out", () => {
  for (const [value, spelled] of SPELLED) assert.equal(text(value), spelled);
});

const checkKeyOrder = (module: CanonicalModule) => {
  const fields = [["a", 1], ["b", { y: 1, x: 2 }], ["c", [{ q: 1, p: 2 }]], ["é", null]] as const;
  const permutations = <T>(items: readonly T[]): T[][] =>
    items.length < 2 ? [[...items]] : items.flatMap((item, index) => permutations(items.filter((_, other) => other !== index)).map((rest) => [item, ...rest]));
  for (const order of permutations(fields)) {
    holds("every key order gives one spelling", text(Object.fromEntries(order), module) === '{"a":1,"b":{"x":2,"y":1},"c":[{"p":2,"q":1}],"é":null}', () => order);
  }
};

test("every key order gives one spelling, at every level", () => {
  checkKeyOrder(productionCanonical);
});

test("removing the key sort is caught", async () => {
  await assertCaughtBy("the sort", "every key order gives one spelling", () => checkKeyOrder(canonicalVariant({ find: "of keys.sort())", replace: "of keys)" })));
});

test("a locale sort or code point order is a different form, and caught by the written spellings", () => {
  const spellings = (module: CanonicalModule) => SPELLED.every(([value, spelled]) => text(value, module) === spelled);
  assert.equal(spellings(productionCanonical), true);
  assert.equal(spellings(canonicalVariant({ find: "of keys.sort())", replace: "of keys.sort((a, b) => a.localeCompare(b)))" })), false);
  const codePoints =
    "of keys.sort((a, b) => { const l = [...a], r = [...b]; for (let i = 0; i < Math.min(l.length, r.length); i += 1) { const d = l[i].codePointAt(0) - r[i].codePointAt(0); if (d !== 0) return d; } return l.length - r.length; }))";
  assert.equal(spellings(canonicalVariant({ find: "of keys.sort())", replace: codePoints })), false);
});

/** Every value within a small bound: scalars that are easy to confuse, nested under each key and in each list. */
function domain(depth: number): unknown[] {
  const scalars: unknown[] = [null, true, false, 0, 1, -1, "", "0", "1", "a", "null", "true", ",", '"', '","b":"', "é", "é"];
  if (depth === 0) return scalars;
  const inner = domain(depth - 1);
  const values = [...scalars];
  // Keys that are easy to confuse too: one that reads as two fields once its quotes are gone.
  const trickyKey = 'a":1,"b';
  for (const item of inner) {
    values.push([item], { a: item }, { b: item }, { [trickyKey]: item }, { "\u00e9": item });
  }
  for (const left of scalars) {
    for (const right of scalars) {
      values.push([left, right], { a: left, b: right }, { [trickyKey]: left, b: right });
    }
  }
  return values;
}

const checkInjective = (module: CanonicalModule) => {
  const seen = new Map<string, unknown>();
  let walked = 0;
  for (const value of domain(2)) {
    walked += 1;
    const spelled = text(value, module);
    holds("every value in the domain has a spelling", spelled !== null, () => value);
    holds("a spelling reads back as exactly its value", isDeepStrictEqual(JSON.parse(spelled as string), value), () => ({ value, spelled }));
    const earlier = seen.get(spelled as string);
    holds("two different values never share a spelling", !seen.has(spelled as string) || isDeepStrictEqual(earlier, value), () => ({ value, earlier, spelled }));
    seen.set(spelled as string, value);
  }
  holds("the walk covered the domain it states", walked === 5_729, () => walked);
};

test("no two values within the bound share bytes, walked exhaustively", () => {
  checkInjective(productionCanonical);
});

test("a key is escaped like a value, and leaving it bare is caught by the walk", async () => {
  await assertCaughtBy("a bare key", "a spelling reads back as exactly its value", () =>
    checkInjective(canonicalVariant({ find: "parts.push(`${JSON.stringify(key)}:${part}`);", replace: 'parts.push(`"${key}":${part}`);' }))
  );
});

const CONFUSABLE_PAIRS = [
  ["a key that reads as two fields", { 'a":1,"b': 2 }, { a: 1, b: 2 }],
  ["a key with a quote and an escaped one", { 'a"': 1 }, { 'a\\"': 1 }],
  ["a field moved down a level", { a: { b: 1 } }, { a: {}, b: 1 }],
  ["a field moved up a level", { a: 1, b: { c: 2 } }, { a: 1, b: {}, c: 2 }],
  ["a number and its text", { a: 1 }, { a: "1" }],
  ["null and its text", { a: null }, { a: "null" }],
  ["a list and an object with index keys", [1, 2], { 0: 1, 1: 2 }],
  ["an event's data holding what another's type holds", { type: "x", data: {} }, { type: "", data: { type: "x" } }],
  ["a value crafted to look like two fields", { a: '1","b":"2' }, { a: "1", b: "2" }],
  ["a composed letter and its decomposed spelling", { a: "é" }, { a: "é" }],
  ["a key's composed and decomposed spelling", { "é": 1 }, { "é": 1 }],
  ["an empty list and an empty object", [], {}],
  ["null and an empty object", null, {}],
  ["a nested and a flat list", [[1], 2], [1, [2]]],
  ["the __proto__ key and no key", JSON.parse('{"__proto__":1}'), {}]
] as const;

for (const [name, left, right] of CONFUSABLE_PAIRS) {
  test(`different bytes: ${name}`, () => {
    assert.notEqual(text(left), null);
    assert.notEqual(text(left), text(right));
  });
}

const NO_SPELLING = [
  ["negative zero", -0],
  ["negative zero, nested", { a: [-0] }],
  ["a fraction", 1.5],
  ["past the safe integers", Number.MAX_SAFE_INTEGER + 1],
  ["below the safe integers", Number.MIN_SAFE_INTEGER - 1],
  ["NaN", Number.NaN],
  ["infinity", Number.POSITIVE_INFINITY],
  ["undefined", undefined],
  ["undefined under a key", { a: undefined }],
  ["undefined in a list", [undefined]],
  ["a function", () => 1],
  ["a symbol", Symbol("x")],
  ["a bigint", BigInt(1)],
  ["a date", new Date(0)],
  ["a map", new Map()],
  ["a class instance", new (class Thing {})()],
  ["a lone surrogate in a value", "\ud83d"],
  ["a lone surrogate in a key", { "\ud83d": 1 }],
  ["an array with a hole", [1, , 3]],
  ["an array with a hole and a key that hides it", Object.assign([1, , 3], { x: 1 })],
  ["an array with an extra property", Object.assign([1], { x: 1 })],
  ["a symbol key", { [Symbol("x")]: 1 }],
  ["a non-enumerable key", Object.defineProperty({}, "hidden", { value: 1, enumerable: false })],
  ["an object past the depth bound", Array.from({ length: 33 }).reduce<unknown>((inner) => ({ a: inner }), 1)]
] as const;

const checkNoSpelling = (module: CanonicalModule) => {
  for (const [name, value] of NO_SPELLING) {
    holds("a value that could share bytes with another has no spelling", module.canonicalBytes(value) === null, () => name);
  }
};

test("a value that could share bytes with another has no spelling", () => {
  checkNoSpelling(productionCanonical);
});

test("a value exactly at the depth bound has a spelling, and a cycle is refused rather than overflowing", () => {
  // The bound is written here, so a changed constant cannot move this test with it.
  assert.equal(MAX_CANONICAL_DEPTH, 32);
  const nest = (levels: number): unknown => Array.from({ length: levels }).reduce<unknown>((inner) => [inner], 1);
  assert.notEqual(canonicalBytes(nest(32)), null);
  assert.equal(canonicalBytes(nest(33)), null);
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  assert.equal(canonicalBytes(cycle), null);
});

for (const [name, edit] of [
  ["the safe integer rule", { find: "!Number.isSafeInteger(value) || ", replace: "" }],
  ["the negative zero rule", { find: " || Object.is(value, -0)", replace: "" }],
  ["the depth bound", { find: "if (depth > exports.MAX_CANONICAL_DEPTH)\n        return null;", replace: "if (depth > 5000)\n        return null;" }],
  ["the well-formed value rule", { find: "if (!value.isWellFormed())\n            return null;\n        return JSON.stringify(value);", replace: "return JSON.stringify(value);" }],
  ["the well-formed key rule", { find: "if (!key.isWellFormed())\n            return null;\n", replace: "" }],
  ["the type rule", { find: 'if (typeof value !== "object")\n        return null;', replace: 'if (typeof value !== "object")\n        return String(value);' }],
  ["the array shape rule", { find: "if (Reflect.ownKeys(value).length !== value.length + 1)\n            return null;", replace: "" }],
  ["the plain object rule", { find: "if (!isPlainObject(value))\n        return null;", replace: "" }],
  ["the hidden key rule", { find: "if (Reflect.ownKeys(value).length !== keys.length)\n        return null;", replace: "" }]
] as const) {
  test(`removing ${name} gives a value with no spelling one, and is caught`, async () => {
    await assertCaughtBy(name, "a value that could share bytes with another has no spelling", () => checkNoSpelling(canonicalVariant(edit)));
  });
}

const NOT_CANONICAL = [
  ["a space", '{"a": 1}'],
  ["a trailing newline", '{"a":1}\n'],
  ["a leading space", ' {"a":1}'],
  ["unsorted keys", '{"b":1,"a":2}'],
  ["a repeated key", '{"a":1,"a":2}'],
  ["a number with a fraction spelled", '{"a":1.0}'],
  ["a number with an exponent", '{"a":1e2}'],
  ["a number past the safe range", '{"a":9007199254740993}'],
  ["negative zero", '{"a":-0}'],
  ["an escape where a letter would do", '{"a":"\\u0061"}'],
  ["a non-ASCII letter escaped", '{"a":"\\u00e9"}'],
  ["an escaped solidus", '{"a":"\\/"}'],
  ["not JSON", "not json"],
  ["torn JSON", '{"a":'],
  ["empty", ""]
] as const;

const checkParse = (module: CanonicalModule) => {
  for (const [name, spelled] of NOT_CANONICAL) {
    holds("bytes that are not a value's one spelling are refused", module.parseCanonical(new TextEncoder().encode(spelled)) === null, () => name);
  }
  holds("a byte order mark is not part of the form", module.parseCanonical(new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d])) === null, () => "BOM");
  holds("invalid UTF-8 is refused", module.parseCanonical(new Uint8Array([0x22, 0xff, 0x22])) === null, () => "0xff");
  holds("overlong UTF-8 is refused", module.parseCanonical(new Uint8Array([0x22, 0xc0, 0xaf, 0x22])) === null, () => "0xc0af");
  holds("a value's spelling reads back", isDeepStrictEqual(module.parseCanonical(new TextEncoder().encode('{"a":[1,"é"]}')), { a: [1, "é"] }), () => "round trip");
};

test("bytes that are not a value's one spelling are refused", () => {
  checkParse(productionCanonical);
});

test("removing the re-spelling comparison, or weakening what it compares, is caught", async () => {
  const unlike = "bytes that are not a value's one spelling are refused";
  await assertCaughtBy("the re-spelling", unlike, () =>
    checkParse(canonicalVariant({ find: "return again !== null && bytesEqual(again, bytes) ? parsed : null;", replace: "return parsed;" }))
  );
  await assertCaughtBy("the length comparison", unlike, () =>
    checkParse(canonicalVariant({ find: "if (left.length !== right.length)\n        return false;", replace: "" }))
  );
  await assertCaughtBy("the byte comparison", unlike, () =>
    checkParse(canonicalVariant({ find: "if (left[index] !== right[index])\n            return false;", replace: "" }))
  );
  // Comparing decoded text instead lets through what a decoder absorbs.
  const decodedComparison = {
    find: "return again !== null && bytesEqual(again, bytes) ? parsed : null;",
    replace: "return again !== null && new TextDecoder().decode(again) === new TextDecoder().decode(bytes) ? parsed : null;"
  };
  await assertCaughtBy("the comparison of bytes", "a byte order mark is not part of the form", () => checkParse(canonicalVariant(decodedComparison)));
});

test("invalid UTF-8 is refused because decoding it cannot give the same bytes back", async () => {
  const check = (module: CanonicalModule) => {
    holds("invalid UTF-8 is refused", module.parseCanonical(new Uint8Array([0x22, 0xff, 0x22])) === null, () => "0xff");
  };
  check(productionCanonical);
  await assertCaughtBy("the comparison of bytes", "invalid UTF-8 is refused", () =>
    check(
      canonicalVariant({
        find: "return again !== null && bytesEqual(again, bytes) ? parsed : null;",
        replace: "return again !== null && new TextDecoder().decode(again) === new TextDecoder().decode(bytes) ? parsed : null;"
      })
    )
  );
});

test("two buffers are equal only byte for byte, at every position of every length", async () => {
  const check = (module: CanonicalModule) => {
    for (let length = 0; length <= 5; length += 1) {
      const left = Uint8Array.from({ length }, (_, index) => index + 1);
      holds("a buffer equals its copy", module.bytesEqual(left, left.slice()), () => length);
      for (let position = 0; position < length; position += 1) {
        const right = left.slice();
        right[position] ^= 0xff;
        holds("one differing byte makes two buffers different, wherever it is", !module.bytesEqual(left, right), () => ({ length, position }));
      }
      const longer = Uint8Array.from({ length: length + 1 }, (_, index) => index + 1);
      holds("a prefix is not equal to what it begins", !module.bytesEqual(left, longer) && !module.bytesEqual(longer, left), () => length);
    }
  };
  check(productionCanonical);
  const edit = (replace: string) => canonicalVariant({ find: "for (let index = 0; index < left.length; index += 1)", replace });
  await assertCaughtBy("skipping the last byte", "one differing byte makes two buffers different, wherever it is", () => check(edit("for (let index = 0; index < left.length - 1; index += 1)")));
  await assertCaughtBy("skipping the first byte", "one differing byte makes two buffers different, wherever it is", () => check(edit("for (let index = 1; index < left.length; index += 1)")));
  await assertCaughtBy("the length comparison", "a prefix is not equal to what it begins", () =>
    check(canonicalVariant({ find: "if (left.length !== right.length)\n        return false;", replace: "" }))
  );
});

test("an object with no prototype is as good as a plain one", async () => {
  const check = (module: CanonicalModule) => {
    const bare = Object.assign(Object.create(null) as Record<string, unknown>, { b: 1, a: 2 });
    holds("a null-prototype object has its plain spelling", text(bare, module) === '{"a":2,"b":1}', () => "null prototype");
  };
  check(productionCanonical);
  await assertCaughtBy("refusing it", "a null-prototype object has its plain spelling", () => check(canonicalVariant({ find: "return prototype === Object.prototype || prototype === null;", replace: "return prototype === Object.prototype;" })));
});

test("the __proto__ key is data, and changes no prototype", () => {
  const parsed = parseCanonical(new TextEncoder().encode('{"__proto__":{"polluted":true}}')) as Record<string, unknown>;
  assert.notEqual(parsed, null);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.equal(new TextDecoder().decode(canonicalBytes(parsed) as Uint8Array), '{"__proto__":{"polluted":true}}');
});

const EXACT = "a record has exactly the keys named, no more and no fewer";

const checkExactKeys = (module: CanonicalModule) => {
  const table: readonly (readonly [Record<string, unknown>, readonly string[], boolean])[] = [
    [{}, [], true],
    [{ a: 1 }, ["a"], true],
    [{ a: 1, b: 2 }, ["b", "a"], true],
    // What joined strings let through: an empty key joins like no keys at all, and a key with a comma like two.
    [{ "": 1 }, [], false],
    [{ "a,b": 1 }, ["a", "b"], false],
    [{ a: 1, "": 2 }, ["a"], false],
    [{ a: 1, b: 2 }, ["a,b"], false],
    // Too many, too few, and the right number of the wrong ones.
    [{ a: 1, b: 2 }, ["a"], false],
    [{ a: 1 }, ["a", "b"], false],
    [{ a: 1, c: 2 }, ["a", "b"], false],
    [{ c: 1 }, ["a"], false],
    // A name every object answers to is not a key this one holds.
    [{}, ["constructor"], false],
    [{ toString: 1 }, [], false]
  ];
  for (const [record, keys, expected] of table) {
    const answer = module.hasExactly(record, keys);
    holds(EXACT, answer === expected, () => ({ record, keys, answer }));
  }
};

test("the one exact-key check, on the forms joined strings let through", async () => {
  checkExactKeys(productionCanonical);
  const rule = "return own.length === keys.length && own.every((key) => keys.includes(key));";
  await assertCaughtBy("the joined strings it replaced", EXACT, () => checkExactKeys(canonicalVariant({ find: rule, replace: "return own.sort().join() === [...keys].sort().join();" })));
  await assertCaughtBy("no rule", EXACT, () => checkExactKeys(canonicalVariant({ find: rule, replace: "return true;" })));
  await assertCaughtBy("no length check", EXACT, () => checkExactKeys(canonicalVariant({ find: rule, replace: "return own.every((key) => keys.includes(key));" })));
  await assertCaughtBy("no membership check", EXACT, () => checkExactKeys(canonicalVariant({ find: rule, replace: "return own.length === keys.length;" })));
});
