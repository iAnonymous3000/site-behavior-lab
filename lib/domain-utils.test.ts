import assert from "node:assert/strict";
import { test } from "node:test";
import { isThirdParty, partyKey, summarizeDomains } from "./domain-utils";
import type { NetworkRequestRecord } from "./types";

test("partyKey uses registrable domains for normal ICANN suffixes", () => {
  assert.equal(partyKey("shop.example.co.uk"), "example.co.uk");
  assert.equal(partyKey("cdn.example.co.uk"), "example.co.uk");
  assert.equal(isThirdParty("shop.example.co.uk", "cdn.example.co.uk"), false);
  assert.equal(isThirdParty("shop.example.co.uk", "cdn.other.co.uk"), true);
});

test("partyKey honors private suffix tenants", () => {
  assert.equal(partyKey("foo.github.io"), "foo.github.io");
  assert.equal(partyKey("assets.foo.github.io"), "foo.github.io");
  assert.equal(isThirdParty("foo.github.io", "assets.foo.github.io"), false);
  assert.equal(isThirdParty("foo.github.io", "bar.github.io"), true);
  assert.equal(isThirdParty("a.vercel.app", "b.vercel.app"), true);
  assert.equal(isThirdParty("store.myshopify.com", "cdn.shopify.com"), true);
});

test("partyKey falls back cleanly for IPs and localhost-style names", () => {
  assert.equal(partyKey("127.0.0.1"), "127.0.0.1");
  assert.equal(partyKey("[::1]"), "::1");
  assert.equal(partyKey(".LocalHost."), "localhost");
});

test("summarizeDomains aggregates stable domain evidence", () => {
  const requests: NetworkRequestRecord[] = [
    request({ domain: "example.com", thirdParty: false, resourceType: "document", status: 200 }),
    request({ domain: "cdn.example.com", thirdParty: false, resourceType: "script", status: 304 }),
    request({ domain: "tracker.example", thirdParty: true, resourceType: "script", status: 200 }),
    request({ domain: "tracker.example", thirdParty: true, resourceType: "image", status: null })
  ];

  const summaries = summarizeDomains(requests);

  assert.equal(summaries[0].domain, "tracker.example");
  assert.equal(summaries[0].requests, 2);
  assert.deepEqual(summaries[0].statuses, [200]);
  assert.deepEqual(summaries[0].resourceTypes, ["script", "image"]);
});

function request(overrides: Partial<NetworkRequestRecord>): NetworkRequestRecord {
  return {
    id: 1,
    url: `https://${overrides.domain ?? "example.com"}/`,
    domain: "example.com",
    method: "GET",
    resourceType: "document",
    status: 200,
    thirdParty: false,
    tracker: null,
    startedAtMs: 0,
    ...overrides
  };
}
