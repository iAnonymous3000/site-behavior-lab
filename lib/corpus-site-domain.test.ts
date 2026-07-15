import assert from "node:assert/strict";
import { test } from "node:test";
import { corpusSiteDomainKey } from "./corpus-site-domain";

test("public redaction labels never become distinct corpus sites", () => {
  assert.equal(corpusSiteDomainKey("{label}.mit.edu"), "mit.edu");
  assert.equal(corpusSiteDomainKey("{label}.{label}.Example.COM."), "example.com");
  assert.equal(corpusSiteDomainKey("WWW.Stanford.edu."), "stanford.edu");
  assert.equal(corpusSiteDomainKey("www.example.co.uk"), "example.co.uk");
  assert.equal(corpusSiteDomainKey("{label}.example.co.uk"), "example.co.uk");
  assert.equal(corpusSiteDomainKey("not/a/hostname"), "");
});
