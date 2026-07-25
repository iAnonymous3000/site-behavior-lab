import assert from "node:assert/strict";
import { test } from "node:test";
import type { DirectoryEntry } from "./corpus-overview";
import {
  buildCategoryEvidencePages,
  buildDirectorySites,
  directoryPageCount,
  directoryPageSlice
} from "./directory-view";

function entry(id: string, overrides: Partial<DirectoryEntry> = {}): DirectoryEntry {
  return {
    id,
    domain: "www.example.com",
    tone: "info",
    headline: "Observed evidence.",
    thirdPartyRequests: 12,
    trackerRequests: 4,
    thirdPartyCookies: 2,
    shieldsThirdPartyChange: null,
    category: "news",
    categoryLabel: "News & media",
    scannedAt: "2026-07-01T00:00:00.000Z",
    reportType: "single",
    device: "desktop",
    gpcEnabled: false,
    consentMode: "observe",
    consentClicks: null,
    status: 200,
    runOutcome: "complete",
    corpusCohort: {
      id: "v2-r2:test-methodology:node-playwright",
      schemaVersion: 2,
      schemaRevision: 2,
      methodologyVersion: "test-methodology",
      methodologyOrigin: "recorded",
      producer: "node-playwright",
      gpc: true
    },
    producer: "node-playwright",
    acquisition: "ci-workflow",
    buildCommit: "a".repeat(40),
    browserName: "chromium",
    browserVersion: "test-chromium",
    egressLabel: "test-egress",
    egressRegion: "test-region",
    reportHasSuccessfulLoad: true,
    reportHasRequestCappedLoad: false,
    requestEvidenceComplete: true,
    cookieEvidenceComplete: true,
    capped: false,
    requestedUrl: "https://www.example.com/",
    finalUrl: "https://www.example.com/",
    schemaVersion: 2,
    schemaRevision: 2,
    schemaOrigin: "v2",
    limited: false,
    consentChoiceState: null,
    variantConsentChoiceState: null,
    comparisonDecisionMode: null,
    compatibilityFingerprintOrigin: null,
    compatibilityFingerprintMatched: null,
    ...overrides
  };
}

test("directory collapses subdomains to one canonical profile and keeps the newest report", () => {
  const sites = buildDirectorySites([
    entry("old", { domain: "www.example.com", scannedAt: "2026-07-01T00:00:00.000Z" }),
    entry("new", { domain: "news.example.com", scannedAt: "2026-07-02T00:00:00.000Z" }),
    entry("other", { domain: "another.org", scannedAt: "2026-07-03T00:00:00.000Z" })
  ]);

  assert.equal(sites.length, 2);
  assert.equal(sites[1].domain, "example.com");
  assert.equal(sites[1].latest.id, "new");
  assert.equal(sites[1].reportCount, 2);
  assert.equal(sites[1].profilePath, "/sites/example.com");
});

test("directory pagination is bounded and rejects invalid page numbers", () => {
  assert.equal(directoryPageCount(0, 24), 1);
  assert.equal(directoryPageCount(49, 24), 3);
  assert.deepEqual(directoryPageSlice([1, 2, 3, 4, 5], 2, 2), [3, 4]);
  assert.deepEqual(directoryPageSlice([1, 2], 0, 2), []);
});

test("category pages use one newest eligible report per canonical site", () => {
  const reports: DirectoryEntry[] = [];
  for (let index = 0; index < 5; index += 1) {
    reports.push(
      entry(`site-${index}`, {
        domain: `site-${index}.com`,
        trackerRequests: index,
        scannedAt: `2026-07-0${index + 1}T00:00:00.000Z`
      })
    );
  }
  reports.push(
    entry("older-subdomain", {
      domain: "www.site-0.com",
      trackerRequests: 999,
      scannedAt: "2026-06-01T00:00:00.000Z"
    }),
    entry("capped-sixth", { domain: "capped.net", capped: true, requestEvidenceComplete: false })
  );

  const [page] = buildCategoryEvidencePages(reports);
  assert.equal(page.id, "news");
  assert.equal(page.sites.length, 5);
  assert.equal(page.sites[0].latest.id, "site-0");
  assert.equal(page.rollup.siteCount, 5);
  assert.equal(page.rollup.medianTrackers, 2);
  assert.equal(page.lastScannedAt, "2026-07-05T00:00:00.000Z");
  assert.equal(page.cohort.id, reports[0].corpusCohort.id);
});

test("category pages select current passive behavior and Shields pair evidence independently", () => {
  const reports = [
    entry("shields-old", {
      domain: "evidence.example.com",
      reportType: "comparison",
      comparisonType: "shields",
      scannedAt: "2026-06-01T00:00:00.000Z",
      thirdPartyRequests: 90,
      shieldsThirdPartyChange: -20
    }),
    entry("shields-old-category", {
      domain: "old.example.com",
      category: "shopping",
      categoryLabel: "Shopping",
      reportType: "comparison",
      comparisonType: "shields",
      scannedAt: "2026-07-03T00:00:00.000Z",
      shieldsThirdPartyChange: -99
    }),
    entry("shields-newer", {
      domain: "www.example.com",
      reportType: "comparison",
      comparisonType: "shields",
      scannedAt: "2026-07-01T00:00:00.000Z",
      thirdPartyRequests: 70,
      shieldsThirdPartyChange: -8
    }),
    entry("passive-current", {
      domain: "example.com",
      scannedAt: "2026-07-05T00:00:00.000Z",
      thirdPartyRequests: 12,
      shieldsThirdPartyChange: null
    })
  ];

  const [page] = buildCategoryEvidencePages(reports, 1);
  assert.equal(page.sites[0].latest.id, "passive-current");
  assert.equal(page.sites[0].latest.thirdPartyRequests, 12);
  assert.equal(page.rollup.medianThirdParty, 12);
  assert.equal(page.rollup.medianShieldsChange, -8);
  assert.equal(page.rollup.shieldsPairedSites, 1);
});

test("category pages stay gated until the minimum eligible site count is met", () => {
  const reports = [entry("one", { domain: "one.com" }), entry("two", { domain: "two.net" })];
  assert.deepEqual(buildCategoryEvidencePages(reports), []);
  assert.equal(buildCategoryEvidencePages(reports, 2).length, 1);
});

test("category medians select one methodology cohort instead of pooling generations", () => {
  const legacyCohort = {
    id: "v1:legacy-method:producer-unrecorded",
    schemaVersion: 1 as const,
    schemaRevision: null,
    methodologyVersion: "legacy-method",
    methodologyOrigin: "legacy-derived" as const,
    producer: null,
    gpc: true
  };
  const r2 = [
    entry("r2-a", { domain: "a.com", trackerRequests: 100 }),
    entry("r2-b", { domain: "b.com", trackerRequests: 200 })
  ];
  const legacy = [
    entry("v1-a", { domain: "c.com", trackerRequests: 1, corpusCohort: legacyCohort }),
    entry("v1-b", { domain: "d.com", trackerRequests: 2, corpusCohort: legacyCohort }),
    entry("v1-c", { domain: "e.com", trackerRequests: 3, corpusCohort: legacyCohort })
  ];

  const [page] = buildCategoryEvidencePages([...r2, ...legacy], 1);
  assert.equal(page.cohort.id, legacyCohort.id, "the larger independently counted cohort wins");
  assert.equal(page.sites.length, 3);
  assert.equal(page.rollup.medianTrackers, 2);
});
