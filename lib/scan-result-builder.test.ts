import assert from "node:assert/strict";
import { test } from "node:test";
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
  assert.match(conditions.scannerDisclosure, /iad-lab-egress/);
  assert.match(conditions.scannerDisclosure, /Brave Shields classification only/);
  assert.deepEqual(conditions.adblock, {
    active: true,
    source: "Brave default ad-block lists",
    lists: 31,
    fetchedAt: new Date(0).toISOString()
  });
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
        domain: "analytics.example.net",
        thirdParty: true,
        tracker: {
          domain: "analytics.example.net",
          entity: "Example Analytics",
          category: "analytics",
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
        domain: ".analytics.example.net",
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
    warnings: ["test warning"],
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
  assert.equal(result.domains.find((domain) => domain.domain === "analytics.example.net")?.blockedByShields, true);
  assert.deepEqual(result.warnings, ["test warning"]);
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
