import assert from "node:assert/strict";
import { test } from "node:test";
import { domainsMatch, isFeaturedSiteConfig, normalizeMatchDomain } from "./featured-sites";

test("normalizeMatchDomain strips www, trailing dots, and casing", () => {
  assert.equal(normalizeMatchDomain("WWW.Amazon.com"), "amazon.com");
  assert.equal(normalizeMatchDomain("amazon.com."), "amazon.com");
  assert.equal(normalizeMatchDomain("  www.example.org  "), "example.org");
});

test("domainsMatch handles www and deeper subdomains", () => {
  assert.equal(domainsMatch("www.amazon.com", "amazon.com"), true);
  assert.equal(domainsMatch("amazon.com", "amazon.com"), true);
  assert.equal(domainsMatch("m.facebook.com", "facebook.com"), true);
  assert.equal(domainsMatch("www.notamazon.com", "amazon.com"), false);
  assert.equal(domainsMatch("amazon.com.evil.com", "amazon.com"), false);
  assert.equal(domainsMatch("", "amazon.com"), false);
});

test("isFeaturedSiteConfig accepts the documented shape and rejects malformed input", () => {
  assert.equal(
    isFeaturedSiteConfig({
      version: 1,
      categories: [{ id: "shopping", label: "Shopping" }],
      sites: [{ domain: "amazon.com", label: "Amazon", category: "shopping", url: "https://www.amazon.com/" }]
    }),
    true
  );
  assert.equal(isFeaturedSiteConfig({ version: 1, categories: [], sites: [{ domain: "x" }] }), false);
  assert.equal(isFeaturedSiteConfig({ categories: [], sites: [] }), false);
  assert.equal(isFeaturedSiteConfig(null), false);
});
