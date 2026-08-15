import assert from "node:assert/strict";
import { test } from "node:test";
import type { DirectoryEntry } from "./corpus-overview";
import {
  buildCategoryEvidencePages,
  buildDirectorySites,
  directoryPageCount,
  directoryPageSlice
} from "./directory-view";
import {
  METRIC_CONTRACT_DIGEST,
  METRIC_CONTRACT_VERSION
} from "./metric-contract";
import {
  SERVICE_ROLE_TAXONOMY_DIGEST,
  SERVICE_ROLE_TAXONOMY_VERSION
} from "./service-role";

const SERVICE_ROLE_IDENTITY = {
  serviceRoleTaxonomyVersion: SERVICE_ROLE_TAXONOMY_VERSION,
  serviceRoleTaxonomyDigest: SERVICE_ROLE_TAXONOMY_DIGEST,
  metricContractVersion: METRIC_CONTRACT_VERSION,
  metricContractDigest: METRIC_CONTRACT_DIGEST
} as const;

function entry(id: string, overrides: Partial<DirectoryEntry> = {}): DirectoryEntry {
  return {
    id,
    domain: "www.example.com",
    tone: "info",
    headline: "Observed evidence.",
    thirdPartyRequests: 12,
    cataloguedServiceRequests: 6,
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
      gpc: true,
      trackerCatalogDigest: "b".repeat(64),
      trackerCatalogOrigin: "recorded",
      ...SERVICE_ROLE_IDENTITY
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
    gpc: true,
    trackerCatalogDigest: "a".repeat(64),
    trackerCatalogOrigin: "legacy-metadata-hash" as const,
    ...SERVICE_ROLE_IDENTITY
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

  // Generation still separates first: a v1 cohort is never displaced by a v2
  // one, so an r2 migration stays visible rather than blending denominators.
  const [page] = buildCategoryEvidencePages([...r2, ...legacy], 1);
  assert.equal(page.cohort.id, legacyCohort.id, "a v1 cohort is not displaced by a v2 one");
  assert.equal(page.sites.length, 3);
  assert.equal(page.rollup.medianTrackers, 2);
});

/**
 * The rule used to be size, and the guard above used to assert it with the
 * message "the larger independently counted cohort wins" while every fixture
 * row shared one `scannedAt`. With recency held constant the test could not
 * distinguish size from freshness, so it was structurally blind to the defect
 * it sat next to.
 *
 * Live consequence at the time of this fix: six of twelve published categories
 * were owned by a frozen `legacy-v1-methodology-unspecified` cohort dated
 * 2026-07-06, each winning on an EXACT TIE against an equally sized
 * current-line cohort up to five weeks newer, resolved by
 * `"v1:legacy-" < "v1:shields-"`. Because a tie survives rescanning the same
 * sites, and a cohort keyed on an unrecorded methodology can never receive
 * another scan, no amount of scanning could move those numbers.
 */
test("a category publishes the newest usable cohort, not the biggest", () => {
  const stale = {
    id: "v1:legacy-v1-methodology-unspecified:producer-unrecorded",
    schemaVersion: 1 as const,
    schemaRevision: null,
    methodologyVersion: "legacy-v1-methodology-unspecified",
    methodologyOrigin: "legacy-derived" as const,
    producer: null,
    gpc: true,
    trackerCatalogDigest: "b".repeat(64),
    trackerCatalogOrigin: "legacy-metadata-hash" as const,
    ...SERVICE_ROLE_IDENTITY
  };
  const fresh = { ...stale, id: "v1:shields-current:producer-node", methodologyVersion: "shields-current" };

  // Same size, same sites, five weeks apart. Under the old rule the stale
  // cohort took the page on the lexicographic tiebreak.
  const older = ["a.com", "b.com", "c.com"].map((domain, index) =>
    entry(`old-${index}`, {
      domain,
      trackerRequests: 1,
      corpusCohort: stale,
      scannedAt: "2026-07-06T00:00:00.000Z"
    })
  );
  const newer = ["a.com", "b.com", "c.com"].map((domain, index) =>
    entry(`new-${index}`, {
      domain,
      trackerRequests: 90,
      corpusCohort: fresh,
      scannedAt: "2026-08-10T00:00:00.000Z"
    })
  );

  const [page] = buildCategoryEvidencePages([...older, ...newer], 1);
  assert.equal(page.cohort.id, fresh.id, "an exact tie must be broken by recency, not by cohort id");
  assert.equal(page.rollup.medianTrackers, 90);
  assert.equal(page.lastScannedAt, "2026-08-10T00:00:00.000Z");
});

test("recency may not buy a category a narrower universe", () => {
  // The composition veto the aggregate already applies, and the reason this
  // cannot be naive newest-wins. Scoped to SUBSTITUTABLE cohorts: two
  // descriptions of the same measurement that differ only in the requested GPC
  // condition. A different methodology is a different question and deliberately
  // does not veto, which is why the fixtures here differ only in `gpc`.
  const wide = {
    id: "v1:same-line:producer-node:gpc-on",
    schemaVersion: 1 as const,
    schemaRevision: null,
    methodologyVersion: "same-line",
    methodologyOrigin: "legacy-derived" as const,
    producer: null,
    gpc: true,
    trackerCatalogDigest: "c".repeat(64),
    trackerCatalogOrigin: "legacy-metadata-hash" as const,
    ...SERVICE_ROLE_IDENTITY
  };
  const narrow = { ...wide, id: "v1:same-line:producer-node:gpc-off", gpc: false };

  const broad = ["a.com", "b.com", "c.com", "d.com", "e.com"].map((domain, index) =>
    entry(`w-${index}`, { domain, trackerRequests: 10, corpusCohort: wide, scannedAt: "2026-07-06T00:00:00.000Z" })
  );
  const thin = [
    entry("n-0", { domain: "a.com", trackerRequests: 99, corpusCohort: narrow, scannedAt: "2026-08-10T00:00:00.000Z" })
  ];

  const [page] = buildCategoryEvidencePages([...broad, ...thin], 1);
  assert.equal(page.cohort.id, wide.id, "a newer cohort measuring one of five sites must not take the page");
  assert.equal(page.sites.length, 5);
});
