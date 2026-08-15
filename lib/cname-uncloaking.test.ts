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
    makeRequest("shop.example", false), // apex, cannot be cloaked
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

  const { cloaks, omittedCandidateCount } = await resolveCnameCloaks(requests, "shop.example", {
    ...deps,
    resolveCnameChain
  });
  assert.equal(cloaks.length, 1);
  assert.equal(omittedCandidateCount, 0);
  assert.equal(cloaks[0].host, "metrics.shop.example");
  assert.equal(cloaks[0].cname, "shop.eulerian.net");
  assert.equal(cloaks[0].tracker.entity, "Eulerian");
});

test("resolveCnameCloaks skips a host whose DNS resolution throws", async () => {
  const requests = [makeRequest("metrics.shop.example", false)];
  const resolveCnameChain = async () => {
    throw new Error("ENOTFOUND");
  };
  const { cloaks, omittedCandidateCount } = await resolveCnameCloaks(requests, "shop.example", {
    ...deps,
    resolveCnameChain
  });
  assert.deepEqual(cloaks, []);
  assert.equal(omittedCandidateCount, 0);
});

test("resolveCnameCloaks reports every candidate omitted by the lookup cap", async () => {
  const requests = Array.from({ length: 11 }, (_, index) => makeRequest(`h${index}.shop.example`, false));
  const resolved: string[] = [];
  const result = await resolveCnameCloaks(requests, "shop.example", {
    ...deps,
    maxHosts: 10,
    resolveCnameChain: async (host) => {
      resolved.push(host);
      return host === "h10.shop.example" ? ["shop.eulerian.net"] : [];
    }
  });

  assert.equal(resolved.length, 10);
  assert.equal(result.omittedCandidateCount, 1);
  assert.deepEqual(result.cloaks, [], "a tracker beyond the cap must be treated as unknown, not absent");
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

test("a scan deadline bounds the whole probe, not just each lookup", async () => {
  // Hop and per-lookup bounds are per host: ten hosts of three hops at 1.5s
  // each is 45s of DNS that could begin with three seconds of scan budget
  // left, so the advertised scan duration bounded nothing. The deadline must
  // bind every lookup, and exhausting it must be disclosed as a failure to
  // observe rather than reported as a finished chain.
  const requests = Array.from({ length: 10 }, (_, index) => ({
    url: `https://h${index}.example.com/x`,
    domain: `h${index}.example.com`,
    thirdParty: false,
    method: "GET"
  })) as unknown as NetworkRequestRecord[];

  const deadline = Date.now() + 300;
  const failures: string[] = [];
  const started = Date.now();
  const { cloaks } = await resolveCnameCloaks(requests, "example.com", {
    registrableDomain,
    matchTracker: () => null,
    maxHosts: 10,
    onResolutionFailure: (host) => failures.push(host),
    resolveCnameChain: async (host) => {
      if (Date.now() >= deadline) throw new Error("cname-deadline-exceeded");
      await new Promise((resolve) => setTimeout(resolve, 100));
      return [`${host}.cdn.example.net`];
    }
  });
  const elapsed = Date.now() - started;

  assert.deepEqual(cloaks, [], "an unrelated CDN chain is not a cloak");
  assert.ok(elapsed < 1_000, `the probe must stop at its deadline, took ${elapsed}ms`);
  assert.ok(
    failures.length > 0,
    "hosts abandoned at the deadline must be disclosed, never silently dropped"
  );
});

/**
 * The matcher is given the host the PAGE contacted, alongside the CNAME target.
 *
 * A cloaked target is by definition never a requested hostname -- that is what
 * cloaking means -- so a matcher that keys anything on the observed request log
 * can only find the first-party subdomain. The scanner's matcher looks up the
 * resource types a host was seen carrying, to probe the ad-block engine with a
 * real type instead of "other"; keyed on the target that lookup never hit, so
 * every probe fell back to "other" and the type-scoped rules ($script, $image,
 * $xmlhttprequest) the step exists to catch stayed unmatched. Its own comment
 * described the fix it was not performing.
 */
test("the matcher receives the requested subdomain, not only the CNAME target", () => {
  const seen: Array<{ target: string; requestedHost: string }> = [];
  const recordingDeps: CnameCloakDeps = {
    registrableDomain,
    matchTracker: (target, requestedHost) => {
      seen.push({ target, requestedHost });
      return null;
    }
  };

  classifyCnameCloak(
    "metrics.shop.example",
    ["alias.cdn.example", "shop.eulerian.net"],
    "shop.example",
    recordingDeps
  );

  assert.equal(seen.length, 2, "every off-party link in the chain is probed");
  assert.deepEqual(
    seen.map((call) => call.target),
    ["alias.cdn.example", "shop.eulerian.net"]
  );
  for (const call of seen) {
    assert.equal(
      call.requestedHost,
      "metrics.shop.example",
      "the requested host is the only one that can appear in the request log"
    );
    assert.notEqual(call.requestedHost, call.target);
  }
});

test("a matcher keyed on the requested host still classifies the target", () => {
  // Both arguments matter and they are not interchangeable: the verdict is
  // about the TARGET, the observed-usage lookup is about the REQUESTED host.
  const typesByRequestedHost = new Map([["metrics.shop.example", "script"]]);
  const probed: string[] = [];
  const cloak = classifyCnameCloak("metrics.shop.example", ["shop.eulerian.net"], "shop.example", {
    registrableDomain,
    matchTracker: (target, requestedHost) => {
      probed.push(typesByRequestedHost.get(requestedHost) ?? "other");
      return TRACKERS[registrableDomain(target)] ?? null;
    }
  });

  assert.deepEqual(probed, ["script"], "the observed type is found, not the 'other' fallback");
  assert.equal(cloak?.cname, "shop.eulerian.net");
  assert.equal(cloak?.tracker.entity, "Eulerian");
});
