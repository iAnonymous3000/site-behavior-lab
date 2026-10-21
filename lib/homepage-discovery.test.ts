import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildHomepageDiscovery,
  buildHomepageFeaturedGroups,
  type HomepageReportSource
} from "./homepage-discovery";
import type { FeaturedSiteConfig } from "./featured-sites";
import { siteProfileKey } from "./site-profile";

const config: FeaturedSiteConfig = {
  version: 1,
  categories: Array.from({ length: 8 }, (_, index) => ({ id: `category-${index}`, label: `Category ${index}` })),
  sites: Array.from({ length: 16 }, (_, index) => ({
    domain: `site-${index}.com`,
    label: `Site ${index}`,
    category: `category-${Math.floor(index / 2)}`,
    url: `https://site-${index}.com/`
  }))
};

function report(index: number, overrides: Partial<HomepageReportSource> = {}): HomepageReportSource {
  const domain = overrides.domain ?? `site-${index}.com`;
  return {
    id: `report-${index}`,
    domain,
    // The loader keys from the lead run (corpusSiteKeyForRun). Fixture hosts
    // under the reserved `.example` name have no public suffix, so they key to
    // themselves.
    siteKey: siteProfileKey(domain) ?? domain.toLowerCase(),
    requestedUrl: `https://${domain}/`,
    headline: `Report ${index}`,
    tone: "info",
    scannedAt: `2026-07-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
    reportType: "single",
    comparisonType: null,
    thirdPartyRequests: index,
    trackerRequests: index,
    requestCapped: false,
    requestEvidenceComplete: true,
    successfulLoad: true,
    ...overrides
  };
}

test("featured selection covers every populated category before taking second cards", () => {
  const groups = buildHomepageFeaturedGroups(config, Array.from({ length: 16 }, (_, index) => report(index)));

  assert.deepEqual(groups.map((group) => group.id), config.categories.map((category) => category.id));
  assert.deepEqual(groups.map((group) => group.items.length), [2, 2, 2, 2, 1, 1, 1, 1]);
  assert.equal(groups.flatMap((group) => group.items).length, 12);
});

test("featured selection prefers a comparison and excludes failed visits", () => {
  const reports = [
    report(0, { id: "new-single", scannedAt: "2026-07-20T00:00:00.000Z" }),
    report(0, { id: "older-comparison", scannedAt: "2026-07-19T00:00:00.000Z", reportType: "comparison" }),
    report(1, { id: "failed", successfulLoad: false })
  ];

  const groups = buildHomepageFeaturedGroups(config, reports);
  assert.equal(groups[0]?.items[0]?.id, "older-comparison");
  assert.equal(groups.flatMap((group) => group.items).some((item) => item.id === "failed"), false);
});

test("featured cards preserve incomplete non-cap request evidence for lower-bound labels", () => {
  const groups = buildHomepageFeaturedGroups(config, [
    report(0, {
      thirdPartyRequests: 14,
      trackerRequests: 6,
      requestCapped: false,
      requestEvidenceComplete: false
    })
  ]);

  assert.deepEqual(groups[0]?.items[0], {
    id: "report-0",
    domain: "site-0.com",
    siteLabel: "Site 0",
    headline: "Report 0",
    tone: "info",
    scannedAt: "2026-07-01T00:00:00.000Z",
    thirdPartyRequests: 14,
    trackerRequests: 6,
    requestCapped: false,
    requestEvidenceComplete: false
  });
});

test("a generalized lead host is never a site's latest report on the homepage", () => {
  const discovery = buildHomepageDiscovery(config, [
    report(0, { id: "flagship", scannedAt: "2026-08-24T08:14:17.900Z" }),
    report(0, { id: "generalized", siteKey: null, scannedAt: "2026-08-24T08:14:58.913Z" })
  ]);

  assert.deepEqual(discovery.knownSites, [
    {
      domain: "site-0.com",
      latestReportId: "flagship",
      scannedAt: "2026-08-24T08:14:17.900Z",
      requestedUrl: "https://site-0.com/",
      headline: "Report 0",
      runMode: "single"
    }
  ]);
  assert.equal(discovery.latestReport, null, "the newest successful report names no site");
  assert.equal(discovery.reportCount, 2);
});

test("discovery emits only each site's latest successful evidence", () => {
  const discovery = buildHomepageDiscovery(config, [
    report(0, { id: "old", scannedAt: "2026-07-01T00:00:00.000Z" }),
    report(0, { id: "new", domain: "www.site-0.com", scannedAt: "2026-07-20T00:00:00.000Z" }),
    report(1, { id: "failed-latest", scannedAt: "2026-07-21T00:00:00.000Z", successfulLoad: false })
  ]);

  assert.deepEqual(discovery.knownSites, [
    {
      domain: "site-0.com",
      latestReportId: "new",
      scannedAt: "2026-07-20T00:00:00.000Z",
      requestedUrl: "https://www.site-0.com/",
      headline: "Report 0",
      runMode: "single"
    }
  ]);
  assert.equal(discovery.latestReport?.latestReportId, "new");
  assert.equal(discovery.reportCount, 3);
});

test("a known site carries its newest report's requested URL, headline and run mode", () => {
  const discovery = buildHomepageDiscovery(config, [
    report(0, {
      id: "older-gpc",
      scannedAt: "2026-07-01T00:00:00.000Z",
      reportType: "comparison",
      comparisonType: "gpc",
      headline: "Older headline"
    }),
    report(0, {
      id: "newest-blocker",
      scannedAt: "2026-07-20T00:00:00.000Z",
      requestedUrl: "https://www.site-0.com/en",
      reportType: "comparison",
      comparisonType: "shields",
      headline: "site-0.com loaded 4 fewer third-party requests with Shields on."
    }),
    report(1, { id: "temporal", reportType: "comparison", comparisonType: "temporal" }),
    report(2, { id: "consent", reportType: "comparison", comparisonType: "consent" })
  ]);

  assert.deepEqual(
    discovery.knownSites.map(({ domain, latestReportId, requestedUrl, headline, runMode }) => ({
      domain,
      latestReportId,
      requestedUrl,
      headline,
      runMode
    })),
    [
      {
        domain: "site-0.com",
        latestReportId: "newest-blocker",
        requestedUrl: "https://www.site-0.com/en",
        headline: "site-0.com loaded 4 fewer third-party requests with Shields on.",
        runMode: "shields"
      },
      { domain: "site-1.com", latestReportId: "temporal", requestedUrl: "https://site-1.com/", headline: "Report 1", runMode: null },
      { domain: "site-2.com", latestReportId: "consent", requestedUrl: "https://site-2.com/", headline: "Report 2", runMode: "consent" }
    ]
  );
  // The homepage's "Open latest report" needs none of it, so the newest report stays small.
  assert.deepEqual(Object.keys(discovery.latestReport ?? {}).sort(), ["domain", "latestReportId", "scannedAt"]);
});
