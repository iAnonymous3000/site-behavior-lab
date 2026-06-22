import assert from "node:assert/strict";
import { test } from "node:test";
import { serializeJsonLd } from "./jsonld-script";

const LINE_SEP = String.fromCharCode(0x2028);
const PARA_SEP = String.fromCharCode(0x2029);

test("serializeJsonLd escapes script-tag breakouts", () => {
  const out = serializeJsonLd({ name: "</script><script>alert(1)</script>" });
  assert.ok(!out.includes("<"), "no raw <");
  assert.ok(!out.includes(">"), "no raw >");
  assert.ok(!out.toLowerCase().includes("</script"), "cannot close the script element");
  assert.ok(out.includes("\\u003c") && out.includes("\\u003e"), "uses unicode escapes");
});

test("serializeJsonLd escapes ampersands and the JS line separators", () => {
  const out = serializeJsonLd({ a: "x&y", b: `p${LINE_SEP}q${PARA_SEP}r` });
  assert.ok(!out.includes("&"), "no raw &");
  assert.ok(!out.includes(LINE_SEP) && !out.includes(PARA_SEP), "no raw line separators");
  assert.ok(out.includes("\\u0026") && out.includes("\\u2028") && out.includes("\\u2029"));
});

test("serializeJsonLd output stays valid JSON that round-trips", () => {
  const value = { a: "</script>", b: `x${LINE_SEP}y`, n: 5, nested: { url: "https://e.com/<b>&c" } };
  assert.deepEqual(JSON.parse(serializeJsonLd(value)), value);
});
