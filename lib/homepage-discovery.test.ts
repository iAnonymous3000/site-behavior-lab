import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildHomepageDiscovery,
  buildHomepageFeaturedGroups,
  type HomepageReportSource
} from "./homepage-discovery";
import type { FeaturedSiteConfig } from "./featured-sites";

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
  return {
    id: `report-${index}`,
    domain: `site-${index}.com`,
    headline: `Report ${index}`,
    tone: "info",
    scannedAt: `2026-07-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
    reportType: "single",
    thirdPartyRequests: index,
    trackerRequests: index,
    requestCapped: false,
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

test("discovery emits only each site's latest successful evidence", () => {
  const discovery = buildHomepageDiscovery(config, [
    report(0, { id: "old", scannedAt: "2026-07-01T00:00:00.000Z" }),
    report(0, { id: "new", domain: "www.site-0.com", scannedAt: "2026-07-20T00:00:00.000Z" }),
    report(1, { id: "failed-latest", scannedAt: "2026-07-21T00:00:00.000Z", successfulLoad: false })
  ]);

  assert.deepEqual(discovery.knownSites, [
    { domain: "site-0.com", latestReportId: "new", scannedAt: "2026-07-20T00:00:00.000Z" }
  ]);
  assert.equal(discovery.latestReport?.latestReportId, "new");
  assert.equal(discovery.reportCount, 3);
});
