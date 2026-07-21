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
