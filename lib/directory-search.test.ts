import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeDirectorySearchQuery } from "./directory-search";

test("directory search normalizes pasted full URLs to their host", () => {
  assert.equal(
    normalizeDirectorySearchQuery("  HTTPS://www.Example.COM:443/articles/story?source=test#details  "),
    "example.com"
  );
  assert.equal(normalizeDirectorySearchQuery("http://example.net/path"), "example.net");
  assert.equal(normalizeDirectorySearchQuery("https://m.facebook.com/story?id=123"), "facebook.com");
  assert.equal(normalizeDirectorySearchQuery("https://news.bbc.co.uk/story"), "bbc.co.uk");
  assert.equal(normalizeDirectorySearchQuery("https://www.gov.uk/browse/benefits"), "gov.uk");
});

test("directory search accepts www host forms without a URL scheme", () => {
  assert.equal(normalizeDirectorySearchQuery("www.Example.com"), "example.com");
  assert.equal(normalizeDirectorySearchQuery("www.example.com/path?q=1"), "example.com");
});

test("directory search preserves ordinary substring queries", () => {
  assert.equal(normalizeDirectorySearchQuery("  AMPLe  "), "ample");
  assert.equal(normalizeDirectorySearchQuery("example.com"), "example.com");
  assert.equal(normalizeDirectorySearchQuery(""), "");
});
