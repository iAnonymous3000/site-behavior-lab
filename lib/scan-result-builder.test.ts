import assert from "node:assert/strict";
import { test } from "node:test";
import { NODE_SHIELDS_REQUEST_CONTEXT_VERSION } from "./legacy-methodology";
import { buildScanConditions, buildScanResult } from "./scan-result-builder";
import type { NetworkRequestRecord, ScanConditions } from "./types";

test("buildScanConditions owns producer profiles, disclosure text, and nested metadata", () => {
  const input = {
    profile: "node-playwright" as const,
    requestedUrl: "https://example.com/",
    finalUrl: "https://example.com/",
    scannedAt: new Date(0).toISOString(),
    chromiumVersion: "Chromium/126",
    userAgent: "test agent",
    viewport: {
      width: 1440,
      height: 980,
      isMobile: false
    },
    scannerEgress: "iad-lab-egress",
    shieldsMode: "classification" as const,
    adblock: {
      active: true,
      source: "Brave default ad-block lists",
      lists: 31,
      fetchedAt: new Date(0).toISOString()
    }
  };

  const conditions = buildScanConditions(input);
  input.viewport.width = 1;
  input.adblock.source = "mutated";

  assert.equal(conditions.viewport.width, 1440);
  assert.equal(conditions.automation, "playwright-chromium");
  assert.equal(conditions.trackerCatalog.source, "Hand-curated service catalog");
  assert.equal("digest" in conditions.trackerCatalog, false, "v1 tracker catalog wire shape must stay unchanged");
  assert.match(conditions.scannerDisclosure, /iad-lab-egress/);
  assert.match(conditions.scannerDisclosure, /Brave Shields classification only/);
  assert.match(conditions.scannerDisclosure, new RegExp(NODE_SHIELDS_REQUEST_CONTEXT_VERSION));
  assert.match(conditions.scannerDisclosure, /initiating document/);
  assert.match(conditions.scannerDisclosure, /redirect follow-up URLs/);
  assert.deepEqual(conditions.adblock, {
    active: true,
    source: "Brave default ad-block lists",
    lists: 31,
    fetchedAt: new Date(0).toISOString()
  });
  assert.equal("manifestDigest" in conditions.adblock, false, "v1 adblock wire shape must stay unchanged");
  assert.equal(conditions.shieldsMode, "classification");

  const workerConditions = buildScanConditions({
    profile: "cloudflare-browser-run",
    requestedUrl: "https://example.com/",
    finalUrl: "https://example.com/",
    chromiumVersion: "Cloudflare Chromium",
    viewport: {
      width: 390,
      height: 844,
      isMobile: true
    }
  });

  assert.equal(workerConditions.automation, "external");
  assert.equal(workerConditions.trackerCatalog.source, "none");
  assert.match(workerConditions.scannerDisclosure, /cannot currently pin the browser connection/);

  const customCatalog = {
    source: "provided catalog",
    version: "1",
    region: "test",
    entries: 1,
    curatedOverrides: 0,
    license: "provided"
  };
  const pageGraphConditions = buildScanConditions({
    profile: "brave-pagegraph",
    requestedUrl: "https://example.com/",
    finalUrl: "https://example.com/",
    viewport: {
      width: 1440,
      height: 980,
      isMobile: false
    },
    trackerCatalog: customCatalog
  });
  customCatalog.source = "mutated";

  assert.equal(pageGraphConditions.automation, "brave-pagegraph");
  assert.equal(pageGraphConditions.trackerCatalog.source, "provided catalog");
  assert.match(pageGraphConditions.scannerDisclosure, /Brave PageGraph-derived scan/);
});

test("buildScanResult owns single-report shape and summary math", () => {
  const result = buildScanResult({
    pageTitle: "Example",
    status: 200,
    durationMs: 123.8,
    firstPartyDomain: "example.com",
    conditions: makeConditions(),
    requests: [
      requestRecord({
        id: 1,
        domain: "example.com",
        thirdParty: false,
        tracker: null,
        blockedByShields: false
      }),
      requestRecord({
        id: 2,
        domain: "google-analytics.com",
        thirdParty: true,
        tracker: {
          domain: "google-analytics.com",
          entity: "Google",
          category: "analytics / tag management",
          confidence: "curated"
        },
        blockedByShields: true
      }),
      requestRecord({
        id: 3,
        domain: "cdn.example.net",
        thirdParty: true,
        tracker: null,
        blockedByShields: false
      })
    ],
    cookies: [
      {
        name: "sid",
        domain: "example.com",
        path: "/",
        sameSite: "Lax",
        secure: true,
        httpOnly: true,
        session: true,
        thirdParty: false
      },
      {
        name: "_ga",
        domain: ".google-analytics.com",
        path: "/",
        sameSite: "None",
        secure: true,
        httpOnly: false,
        session: false,
        thirdParty: true
      }
    ],
    storage: [
      {
        area: "localStorage",
        key: "feature",
        valueBytes: 4
      }
    ],
    fingerprintEvents: [
      {
        api: "canvas.toDataURL",
        count: 2
      },
      {
        api: "webgl.readPixels",
        count: 1
      }
    ],
    screenshot: null,
    warnings: ["The page did not reach network idle before the scan window ended."],
    shieldsBlockedRequests: 7
  });

  assert.equal(result.reportType, "single");
  assert.deepEqual(result.summary, {
    pageTitle: "Example",
    status: 200,
    durationMs: 123,
    firstPartyDomain: "example.com",
    totalRequests: 3,
    thirdPartyRequests: 2,
    knownTrackerRequests: 1,
    thirdPartyDomains: 2,
    cookies: 2,
    thirdPartyCookies: 1,
    storageEntries: 1,
    fingerprintEvents: 3,
    shieldsBlockedRequests: 7
  });
  assert.equal(result.domains.length, 3);
  assert.equal(result.domains.find((domain) => domain.domain === "google-analytics.com")?.blockedByShields, true);
  assert.deepEqual(result.warnings, ["The page did not reach network idle before the scan window ended."]);
});

test("buildScanResult is the default-deny public seam after matching and classification", () => {
  const conditions = makeConditions();
  conditions.requestedUrl = "https://example.com/patients/anna?token=secret";
  conditions.finalUrl = "https://example.com/account/12345";

  const result = buildScanResult({
    pageTitle: "Anna\u0000 private page",
    status: 200,
    durationMs: 1,
    firstPartyDomain: "example.com",
    conditions,
    requests: [
      {
        id: 1,
        url: "https://a8f3c9d2e1b4f6a7.google-analytics.com/users/anna?email=x&utm_source=y",
        domain: "a8f3c9d2e1b4f6a7.google-analytics.com",
        method: "GET",
        resourceType: "script",
        status: 200,
        thirdParty: true,
        // The match happened against the raw hostname before this seam. The
        // classified label survives while page-controlled host/path data does not.
        tracker: {
          domain: "google-analytics.com",
          entity: "Google",
          category: "analytics / tag management",
          confidence: "curated"
        },
        startedAtMs: 1
      }
    ],
    cookies: [
      {
        name: "anna_session",
        domain: ".example.com",
        path: "/users/anna",
        sameSite: "Lax",
        secure: true,
        httpOnly: true,
        session: true,
        thirdParty: false
      }
    ],
    storage: [{ area: "localStorage", key: "anna_private", valueBytes: 4 }],
    fingerprintEvents: [],
    screenshot: null,
    warnings: []
  });

  assert.equal(result.summary.pageTitle, "Anna private page");
  assert.equal(result.conditions.requestedUrl, "https://example.com/{seg}/{seg}");
  assert.equal(result.conditions.finalUrl, "https://example.com/account/{n}");
  assert.equal(
    result.requests[0].url,
    "https://{label}.google-analytics.com/{seg}/{seg}?%5Bredacted%5D=&utm_source="
  );
  assert.equal(result.requests[0].tracker?.entity, "Google");
  assert.equal(result.cookies[0].name, "[redacted]");
  assert.equal(result.cookies[0].path, "/{seg}/{seg}");
  assert.equal(result.storage[0].key, "[redacted]");
});

function requestRecord({
  id,
  domain,
  thirdParty,
  tracker,
  blockedByShields
}: Pick<NetworkRequestRecord, "blockedByShields" | "domain" | "id" | "thirdParty" | "tracker">): NetworkRequestRecord {
  return {
    id,
    url: `https://${domain}/resource.js`,
    domain,
    method: "GET",
    resourceType: "script",
    status: 200,
    thirdParty,
    tracker,
    blockedByShields,
    startedAtMs: id
  };
}

function makeConditions(): ScanConditions {
  return buildScanConditions({
    profile: "node-playwright",
    requestedUrl: "https://example.com/",
    finalUrl: "https://example.com/",
    scannedAt: new Date(0).toISOString(),
    chromiumVersion: "test",
    userAgent: "test",
    timezone: "UTC",
    locale: "en-US",
    language: "en-US",
    viewport: {
      width: 1440,
      height: 980,
      isMobile: false
    }
  });
}
