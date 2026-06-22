import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyCnameCloak, cnameCloakCandidates, resolveCnameCloaks, type CnameCloakDeps } from "./cname-uncloaking";
import type { NetworkRequestRecord, TrackerMatch } from "./types";

// Simple eTLD+1 for two-label test hosts; real callers inject tldts getDomain.
const registrableDomain = (host: string): string => host.split(".").slice(-2).join(".");

const TRACKERS: Record<string, TrackerMatch> = {
  "eulerian.net": { domain: "eulerian.net", entity: "Eulerian", category: "advertising", confidence: "curated" },
  "adobedc.net": { domain: "adobedc.net", entity: "Adobe", category: "analytics", confidence: "curated" }
};
const matchTracker = (host: string): TrackerMatch | null => TRACKERS[registrableDomain(host)] ?? null;
const deps: CnameCloakDeps = { registrableDomain, matchTracker };

test("cnameCloakCandidates picks first-party subdomains only, deduped, no apex or third parties", () => {
  const requests = [
    makeRequest("metrics.shop.example", false),
    makeRequest("metrics.shop.example", false), // duplicate
    makeRequest("www.shop.example", false),
    makeRequest("shop.example", false), // apex — cannot be cloaked
    makeRequest("google-analytics.com", true) // third party
  ];

  const candidates = cnameCloakCandidates(requests, "shop.example", deps).sort();
  assert.deepEqual(candidates, ["metrics.shop.example", "www.shop.example"]);
});

test("classifyCnameCloak flags a first-party subdomain CNAME'd to a tracking vendor", () => {
  const cloak = classifyCnameCloak("metrics.shop.example", ["shop.eulerian.net"], "shop.example", deps);
  assert.ok(cloak);
  assert.equal(cloak.host, "metrics.shop.example");
  assert.equal(cloak.cname, "shop.eulerian.net");
  assert.equal(cloak.tracker.entity, "Eulerian");
});

test("classifyCnameCloak ignores a CNAME to a non-tracker CDN", () => {
  assert.equal(classifyCnameCloak("assets.shop.example", ["shop.cloudfront.net"], "shop.example", deps), null);
});

test("classifyCnameCloak ignores a CNAME that stays within the first party", () => {
  assert.equal(classifyCnameCloak("metrics.shop.example", ["origin.shop.example"], "shop.example", deps), null);
});

test("classifyCnameCloak walks a chain and flags the cloaking vendor link", () => {
  // subdomain -> vendor -> vendor CDN: the tracker is the middle (off-org) link.
  const cloak = classifyCnameCloak(
    "data.shop.example",
    ["collect.adobedc.net", "edge.cdnvendor.example"],
    "shop.example",
    deps
  );
  assert.ok(cloak);
  assert.equal(cloak.cname, "collect.adobedc.net");
  assert.equal(cloak.tracker.entity, "Adobe");
});

test("classifyCnameCloak tolerates trailing dots and casing in the chain", () => {
  const cloak = classifyCnameCloak("Metrics.Shop.Example", ["Shop.Eulerian.NET."], "shop.example", deps);
  assert.ok(cloak);
  assert.equal(cloak.host, "metrics.shop.example");
  assert.equal(cloak.cname, "shop.eulerian.net");
});

test("resolveCnameCloaks returns only the cloaked trackers, skipping CDNs and apex", async () => {
  const requests = [
    makeRequest("metrics.shop.example", false), // cloaked -> Eulerian
    makeRequest("assets.shop.example", false), // CDN, not a tracker
    makeRequest("shop.example", false), // apex
    makeRequest("google-analytics.com", true) // third party
  ];
  const chains: Record<string, string[]> = {
    "metrics.shop.example": ["shop.eulerian.net"],
    "assets.shop.example": ["shop.cloudfront.net"]
  };
  const resolveCnameChain = async (host: string) => chains[host] ?? [];

  const cloaks = await resolveCnameCloaks(requests, "shop.example", { ...deps, resolveCnameChain });
  assert.equal(cloaks.length, 1);
  assert.equal(cloaks[0].host, "metrics.shop.example");
  assert.equal(cloaks[0].cname, "shop.eulerian.net");
  assert.equal(cloaks[0].tracker.entity, "Eulerian");
});

test("resolveCnameCloaks skips a host whose DNS resolution throws", async () => {
  const requests = [makeRequest("metrics.shop.example", false)];
  const resolveCnameChain = async () => {
    throw new Error("ENOTFOUND");
  };
  const cloaks = await resolveCnameCloaks(requests, "shop.example", { ...deps, resolveCnameChain });
  assert.deepEqual(cloaks, []);
});

function makeRequest(domain: string, thirdParty: boolean): NetworkRequestRecord {
  return {
    id: 1,
    url: `https://${domain}/x`,
    domain,
    method: "GET",
    resourceType: "script",
    status: 200,
    thirdParty,
    tracker: null,
    startedAtMs: 1
  };
}
