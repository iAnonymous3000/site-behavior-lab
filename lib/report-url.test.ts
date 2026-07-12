import assert from "node:assert/strict";
import { test } from "node:test";
import { safeNavigableHttpUrl } from "./report-url";

test("only exact HTTP(S) report URLs are navigable", () => {
  assert.equal(safeNavigableHttpUrl("https://example.com/privacy"), "https://example.com/privacy");
  assert.equal(safeNavigableHttpUrl("http://example.com/"), "http://example.com/");
  assert.equal(safeNavigableHttpUrl("javascript:alert(1)"), null);
  assert.equal(safeNavigableHttpUrl("not a url"), null);
});

test("redaction-v2 route shapes and encoded markers are never links", () => {
  for (const value of [
    "https://example.com/{seg}",
    "https://example.com/%7Bseg%7D",
    "https://example.com/{n}/privacy",
    "https://{label}.example.com/",
    "https://example.com/?%5Bredacted%5D=",
    "https://example.com/?id=%5Bredacted%3Along-token%5D"
  ]) {
    assert.equal(safeNavigableHttpUrl(value), null, value);
  }
});
