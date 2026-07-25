import assert from "node:assert/strict";
import { test } from "node:test";
import { siteProfileKey, siteProfilePath } from "./site-profile";

test("site profile keys collapse display-only www and normalize casing", () => {
  assert.equal(siteProfileKey("WWW.Example.COM."), "example.com");
  assert.equal(siteProfilePath("www.example.com"), "/sites/example.com");
  assert.equal(siteProfileKey("shop.example.com"), "example.com");
  assert.equal(siteProfileKey("{label}.ClevelandClinic.org"), "clevelandclinic.org");
  assert.equal(siteProfileKey("{label}.{label}.shop.ClevelandClinic.org"), "clevelandclinic.org");
  assert.equal(siteProfilePath("{label}.clevelandclinic.org"), "/sites/clevelandclinic.org");
});

test("site profile keys retain valid public-suffix apex websites", () => {
  assert.equal(siteProfileKey("gov.uk"), "gov.uk");
  assert.equal(siteProfilePath("GOVT.NZ."), "/sites/govt.nz");
});

test("a www host of a public-suffix apex keys to the same site as the apex", () => {
  // The PSL makes `www` the registrable label of `www.gov.uk`, so the
  // registrable-domain rule cannot strip it the way it strips
  // `www.example.com`. Left alone, the two spellings produced two keys: report
  // pages linked to /sites/www.gov.uk/ while the generated history page (whose
  // domain reached the same identity through friendlyDomain) was
  // /sites/gov.uk/, so the link 404d in production for both scanned sites in
  // this shape.
  for (const [alias, apex] of [
    ["www.gov.uk", "gov.uk"],
    ["WWW.GOV.UK.", "gov.uk"],
    ["www.govt.nz", "govt.nz"],
    ["sub.www.gov.uk", "gov.uk"]
  ] as const) {
    assert.equal(siteProfileKey(alias), apex);
    assert.equal(siteProfilePath(alias), `/sites/${apex}`);
    assert.equal(siteProfileKey(apex), apex);
  }
});

test("site profile keys are idempotent", () => {
  // Every surface derives the route key from a different field, so a key that
  // does not survive a second pass silently produces two paths for one site.
  for (const domain of [
    "www.gov.uk",
    "gov.uk",
    "www.example.com",
    "shop.example.com",
    "www.nasa.gov",
    "{label}.clevelandclinic.org"
  ]) {
    const once = siteProfileKey(domain);
    assert.notEqual(once, null);
    assert.equal(siteProfileKey(once as string), once);
  }
});

test("site profile paths reject unknown and path-shaped input", () => {
  assert.equal(siteProfileKey("unknown"), null);
  assert.equal(siteProfilePath("example.com/private"), null);
  assert.equal(siteProfilePath("{label}.com"), null);
  assert.equal(siteProfilePath("{label}.gov.uk"), null);
  assert.equal(siteProfilePath("gov..uk"), null);
  assert.equal(siteProfilePath("_gov.uk"), null);
  assert.equal(siteProfilePath(`${"a".repeat(64)}.gov.uk`), null);
  assert.equal(siteProfilePath(""), null);
});
