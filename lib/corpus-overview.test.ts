import assert from "node:assert/strict";
import { test } from "node:test";
import { createConsentComparisonReport } from "./compare-reports";
import { corpusSiteDomainKey } from "./corpus-site-domain";
import {
  consentClicksForView,
  corpusExportMetadataForView,
  entryEligibleForCorpusRollups,
  entryEvidenceCompleteness,
  preferAsSiteDataPoint,
  selectAggregateCorpusCohort,
  selectSiteDataPoints,
  summarizeCorpusSiteCounts,
  type DirectoryEntry
} from "./corpus-overview";
import {
  makeConsentInterventionReportV2R2,
  makeConsentSingleReportV2R2,
  makePublicSingleReportV2R2
} from "./scan-report-v2-r2-fixtures";
import { evaluateQuality } from "./scan-report-v2-evaluators";
import {
  METRIC_CONTRACT_DIGEST,
  METRIC_CONTRACT_VERSION
} from "./metric-contract";
import { SCAN_REPORT_SCHEMA_VERSION, type ConsentInteractionSummary, type ScanResult } from "./types";
import { familyCensoredOnRun, viewFromV1Report, viewFromV2 } from "./scan-report-views";
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

function makeResult(overrides: { consentInteraction?: ConsentInteractionSummary } = {}): ScanResult {
  return {
    ok: true,
    schemaVersion: SCAN_REPORT_SCHEMA_VERSION,
    reportType: "single",
    summary: {
      pageTitle: "",
      status: 200,
      durationMs: 1,
      firstPartyDomain: "shop.example",
      totalRequests: 5,
      thirdPartyRequests: 0,
      knownTrackerRequests: 0,
      thirdPartyDomains: 0,
      cookies: 0,
      thirdPartyCookies: 0,
      storageEntries: 0,
      fingerprintEvents: 0
    },
    conditions: {
      requestedUrl: "https://shop.example/",
      finalUrl: "https://shop.example/",
      scannedAt: new Date(0).toISOString(),
      chromiumVersion: "test",
      userAgent: "test",
      timezone: "UTC",
      locale: "en-US",
      language: "en-US",
      viewport: { width: 1440, height: 980, isMobile: false },
      gpcEnabled: false,
      consentMode: "observe",
      automation: "playwright-chromium",
      headless: true,
      scannerEgress: "test",
      trackerCatalog: { source: "test", version: "test", region: "test", entries: 0, curatedOverrides: 0, license: "test" },
      scannerDisclosure: "test"
    },
    requests: [],
    domains: [],
    cookies: [],
    storage: [],
    fingerprintEvents: [],
    screenshot: null,
    warnings: [],
    ...(overrides.consentInteraction ? { consentInteraction: overrides.consentInteraction } : {})
  };
}

function consentComparison(acceptClicked: boolean, rejectClicked: boolean) {
  return createConsentComparisonReport(
    makeResult({ consentInteraction: { mode: "accept-all", clicked: acceptClicked } }),
    makeResult({ consentInteraction: { mode: "reject-all", clicked: rejectClicked } })
  );
}

test("consentClicksForView classifies by what was actually clicked, not the requested mode", () => {
  assert.equal(consentClicksForView(viewFromV1Report(consentComparison(true, true))), "accept-and-reject");
  assert.equal(consentClicksForView(viewFromV1Report(consentComparison(true, false))), "accept-only");
  assert.equal(consentClicksForView(viewFromV1Report(consentComparison(false, true))), "reject-only");
  assert.equal(consentClicksForView(viewFromV1Report(consentComparison(false, false))), "none");
});

test("consentClicksForView returns null when no consent interaction was attempted", () => {
  assert.equal(consentClicksForView(viewFromV1Report(makeResult())), null);
});

test("consentClicksForView classifies single consent-mode runs", () => {
  assert.equal(consentClicksForView(viewFromV1Report(makeResult({ consentInteraction: { mode: "accept-all", clicked: true } }))), "accept-only");
  assert.equal(consentClicksForView(viewFromV1Report(makeResult({ consentInteraction: { mode: "reject-all", clicked: true } }))), "reject-only");
  assert.equal(consentClicksForView(viewFromV1Report(makeResult({ consentInteraction: { mode: "reject-all", clicked: false } }))), "none");
});

test("researcher-export metadata keeps v1 derivation and r2 recorded states distinct", () => {
  const v1 = corpusExportMetadataForView(viewFromV1Report(consentComparison(true, true)));
  assert.equal(v1.consentChoiceState, null, "v1 click dispatch was never a verified consent state");
  assert.equal(v1.variantConsentChoiceState, null);
  assert.equal(v1.comparisonDecisionMode, "raw-only");
  assert.equal(v1.compatibilityFingerprintOrigin, "legacy-derived");
  assert.equal(v1.compatibilityFingerprintMatched, true);
  assert.equal(v1.corpusCohort.schemaVersion, 1);
  assert.equal(v1.corpusCohort.methodologyOrigin, "legacy-derived");
  assert.equal(v1.corpusCohort.trackerCatalogOrigin, "legacy-metadata-hash");
  assert.match(v1.corpusCohort.trackerCatalogDigest, /^[a-f0-9]{64}$/);
  assert.equal(v1.corpusCohort.serviceRoleTaxonomyVersion, SERVICE_ROLE_TAXONOMY_VERSION);
  assert.equal(v1.corpusCohort.serviceRoleTaxonomyDigest, SERVICE_ROLE_TAXONOMY_DIGEST);
  assert.equal(v1.corpusCohort.metricContractVersion, METRIC_CONTRACT_VERSION);
  assert.equal(v1.corpusCohort.metricContractDigest, METRIC_CONTRACT_DIGEST);
  assert.equal(v1.producer, null);
  assert.equal(v1.acquisition, null);
  assert.equal(v1.browserName, null);
  assert.equal(v1.egressRegion, null);

  const r2Pair = corpusExportMetadataForView(viewFromV2(makeConsentInterventionReportV2R2(), 2));
  assert.equal(r2Pair.consentChoiceState, "verified", "consent comparison leads with accept-all");
  assert.equal(r2Pair.variantConsentChoiceState, "verified", "the variant is the reject-all arm");
  assert.equal(r2Pair.comparisonDecisionMode, "comparable");
  assert.equal(r2Pair.compatibilityFingerprintOrigin, "recorded");
  assert.equal(r2Pair.compatibilityFingerprintMatched, true);
  assert.equal(r2Pair.corpusCohort.schemaRevision, 2);
  assert.equal(r2Pair.corpusCohort.methodologyOrigin, "recorded");
  assert.equal(r2Pair.corpusCohort.trackerCatalogOrigin, "recorded");
  assert.match(r2Pair.corpusCohort.trackerCatalogDigest, /^[a-f0-9]{64}$/);
  assert.equal(r2Pair.corpusCohort.serviceRoleTaxonomyVersion, SERVICE_ROLE_TAXONOMY_VERSION);
  assert.equal(r2Pair.corpusCohort.serviceRoleTaxonomyDigest, SERVICE_ROLE_TAXONOMY_DIGEST);
  assert.equal(r2Pair.corpusCohort.metricContractVersion, METRIC_CONTRACT_VERSION);
  assert.equal(r2Pair.corpusCohort.metricContractDigest, METRIC_CONTRACT_DIGEST);
  assert.equal(r2Pair.producer, "node-playwright");
  assert.equal(r2Pair.acquisition, "operator-cli");
  assert.equal(r2Pair.browserName, "chromium");
  assert.equal(r2Pair.egressRegion, "us");

  const r2Single = corpusExportMetadataForView(viewFromV2(makeConsentSingleReportV2R2(), 2));
  assert.equal(r2Single.consentChoiceState, "verified");
  assert.equal(r2Single.variantConsentChoiceState, null);
  assert.equal(r2Single.comparisonDecisionMode, null);
  assert.equal(r2Single.compatibilityFingerprintOrigin, null);
  assert.equal(r2Single.compatibilityFingerprintMatched, null);
});

function makeEntry(overrides: Partial<DirectoryEntry> & { id: string }): DirectoryEntry {
  return {
    domain: "shop.example",
    tone: "warn",
    headline: "shop.example told Google you were here.",
    thirdPartyRequests: 100,
    cataloguedServiceRequests: 50,
    trackerRequests: 40,
    thirdPartyCookies: 8,
    shieldsThirdPartyChange: -20,
    category: "shopping",
    categoryLabel: "Shopping",
    scannedAt: "2026-07-01T00:00:00.000Z",
    reportType: "comparison",
    comparisonType: "shields",
    device: "desktop",
    gpcEnabled: true,
    consentMode: "observe",
    consentClicks: null,
    capped: false,
    requestedUrl: "https://shop.example/",
    finalUrl: "https://shop.example/",
    status: 200,
    runOutcome: "complete",
    corpusCohort: {
      id: "v1:test-methodology:producer-unrecorded",
      schemaVersion: 1,
      schemaRevision: null,
      methodologyVersion: "test-methodology",
      methodologyOrigin: "legacy-derived",
      producer: null,
      gpc: true,
      trackerCatalogDigest: "a".repeat(64),
      trackerCatalogOrigin: "legacy-metadata-hash",
      ...SERVICE_ROLE_IDENTITY
    },
    producer: null,
    acquisition: null,
    buildCommit: null,
    browserName: null,
    browserVersion: "test-chromium",
    egressLabel: "test-egress",
    egressRegion: null,
    reportHasSuccessfulLoad: true,
    reportHasRequestCappedLoad: false,
    requestEvidenceComplete: true,
    cookieEvidenceComplete: true,
    schemaVersion: 1,
    schemaRevision: null,
    schemaOrigin: "legacy-derived",
    limited: true,
    consentChoiceState: null,
    variantConsentChoiceState: null,
    comparisonDecisionMode: "comparable",
    compatibilityFingerprintOrigin: "legacy-derived",
    compatibilityFingerprintMatched: true,
    ...overrides
  };
}

test("preferAsSiteDataPoint uses the newest eligible behavior report regardless of kind", () => {
  const shields = makeEntry({ id: "shields", scannedAt: "2026-06-01T00:00:00.000Z" });
  const gpc = makeEntry({ id: "gpc", comparisonType: "gpc", scannedAt: "2026-07-05T00:00:00.000Z" });

  assert.equal(preferAsSiteDataPoint(shields, gpc), false);
  assert.equal(preferAsSiteDataPoint(gpc, shields), true);
});

test("preferAsSiteDataPoint uses the shared report-id tie-break at an equal timestamp", () => {
  const scannedAt = "2026-07-05T00:00:00.000Z";
  const lower = makeEntry({ id: "20260705-" + "a".repeat(32), scannedAt });
  const higher = makeEntry({ id: "20260705-" + "b".repeat(32), scannedAt });

  assert.equal(preferAsSiteDataPoint(higher, lower), true);
  assert.equal(preferAsSiteDataPoint(lower, higher), false);
});

test("site data points combine newest behavior with the newest eligible Shields pair", () => {
  const oldShields = makeEntry({
    id: "shields-old",
    scannedAt: "2026-06-01T00:00:00.000Z",
    shieldsThirdPartyChange: -20
  });
  const latestBehavior = makeEntry({
    id: "gpc-new",
    comparisonType: "gpc",
    scannedAt: "2026-07-05T00:00:00.000Z",
    thirdPartyRequests: 12,
    shieldsThirdPartyChange: null
  });

  const [site] = selectSiteDataPoints([oldShields, latestBehavior]);
  assert.equal(site.id, "gpc-new");
  assert.equal(site.thirdPartyRequests, 12);
  assert.equal(site.shieldsThirdPartyChange, -20);
});

test("aggregate selection names one methodology cohort and mixed direct aggregation fails closed", () => {
  const legacy = makeEntry({ id: "legacy", domain: "legacy.example" });
  const r2Cohort = {
    id: "v2-r2:method-b:node-playwright",
    schemaVersion: 2 as const,
    schemaRevision: 2 as const,
    methodologyVersion: "method-b",
    methodologyOrigin: "recorded" as const,
    producer: "node-playwright",
    gpc: true,
    trackerCatalogDigest: "b".repeat(64),
    trackerCatalogOrigin: "recorded" as const,
    ...SERVICE_ROLE_IDENTITY
  };
  const r2a = makeEntry({ id: "r2-a", domain: "a.example", corpusCohort: r2Cohort });
  const r2b = makeEntry({ id: "r2-b", domain: "b.example", corpusCohort: r2Cohort });

  // v1 keeps the aggregate while it remains the deployed benchmark source,
  // even though the r2 cohort here has more sites. This used to differ between
  // the two selection sites: the stats builder filtered to v1 and the directory
  // did not, so the artifact and the leaderboard could name different cohorts.
  // Both now call selectPrimaryCorpusCohort, and promoting r2 stays a
  // deliberate policy change rather than an emergent one.
  const selected = selectAggregateCorpusCohort([legacy, r2a, r2b]);
  assert.equal(selected.cohort?.id, "v1:test-methodology:producer-unrecorded");
  assert.deepEqual(selected.entries.map((entry) => entry.id), ["legacy"]);

  // With no v1 rows at all, the r2 generation is selected on its own terms.
  const r2Only = selectAggregateCorpusCohort([r2a, r2b]);
  assert.equal(r2Only.cohort?.id, r2Cohort.id);
  assert.deepEqual(r2Only.entries.map((entry) => entry.id), ["r2-a", "r2-b"]);

  assert.throws(() => selectSiteDataPoints([legacy, r2a]), /mixed methodology cohorts/);
});

test("preferAsSiteDataPoint picks the newest scan within a kind, not the heaviest", () => {
  // The archive keeps historical runs; a heavier June run must not represent
  // the site once a lighter July re-scan exists.
  const heavyOld = makeEntry({ id: "heavy-old", scannedAt: "2026-06-25T00:00:00.000Z", thirdPartyRequests: 589 });
  const lightNew = makeEntry({ id: "light-new", scannedAt: "2026-07-06T00:00:00.000Z", thirdPartyRequests: 399 });

  assert.equal(preferAsSiteDataPoint(lightNew, heavyOld), true);
  assert.equal(preferAsSiteDataPoint(heavyOld, lightNew), false);
});

test("corpus rollups require an uncensored passive lead run", () => {
  assert.equal(entryEligibleForCorpusRollups(makeEntry({ id: "passive" })), true);
  assert.equal(entryEligibleForCorpusRollups(makeEntry({ id: "failed", status: 403 })), false);
  assert.equal(entryEligibleForCorpusRollups(makeEntry({ id: "quality-failed", runOutcome: "failed" })), false);
  assert.equal(entryEligibleForCorpusRollups(makeEntry({ id: "no-response", status: null })), false);
  assert.equal(entryEligibleForCorpusRollups(makeEntry({ id: "capped", capped: true })), false);
  assert.equal(
    entryEligibleForCorpusRollups(makeEntry({ id: "requests-incomplete", requestEvidenceComplete: false })),
    false
  );
  assert.equal(
    entryEligibleForCorpusRollups(makeEntry({ id: "cookies-incomplete", cookieEvidenceComplete: false })),
    true,
    "cookie-family loss must not discard otherwise complete request metrics"
  );
  assert.equal(
    entryEligibleForCorpusRollups(makeEntry({ id: "consent-accept", consentMode: "accept-all", comparisonType: "consent" })),
    false
  );
  assert.equal(
    entryEligibleForCorpusRollups(makeEntry({ id: "consent-reject", consentMode: "reject-all", comparisonType: "consent" })),
    false
  );
});

test("a failed visit's directory entry carries no exact request or cookie counts", () => {
  // The report's JSON-LD publishes a failed visit's request counts as lower
  // bounds and withholds its cookie snapshot. The directory entry feeds the
  // site feed, the site profile, the directory and the category rows, and it
  // read family censoring alone, so a failed HTTP 403 visit with uncensored
  // families reached every one of those as "8 third-party requests, 0
  // third-party cookies" stated as fact.
  const completeV1 = viewFromV1Report(makeResult());
  assert.deepEqual(entryEvidenceCompleteness(completeV1.runs[0]), {
    requestEvidenceComplete: true,
    cookieEvidenceComplete: true
  });

  const blocked = makeResult();
  blocked.summary.status = 403;
  const blockedView = viewFromV1Report(blocked);
  assert.equal(blockedView.runs[0].quality.outcome, "failed");
  assert.equal(familyCensoredOnRun(blockedView.runs[0], "requests"), false, "the failure is the only defect");
  assert.deepEqual(entryEvidenceCompleteness(blockedView.runs[0]), {
    requestEvidenceComplete: false,
    cookieEvidenceComplete: false
  });

  const r2 = makePublicSingleReportV2R2();
  r2.run.qualityFacts = { ...r2.run.qualityFacts, status: 429 };
  r2.run.summary = { ...r2.run.summary, status: 429 };
  r2.run.quality = evaluateQuality(r2.run.qualityFacts, { observedRequests: r2.run.evidence.requests.length });
  const r2View = viewFromV2(r2, 2);
  assert.equal(r2View.runs[0].quality.outcome, "failed");
  assert.equal(familyCensoredOnRun(r2View.runs[0], "cookies"), false, "the failure is the only defect");
  assert.deepEqual(entryEvidenceCompleteness(r2View.runs[0]), {
    requestEvidenceComplete: false,
    cookieEvidenceComplete: false
  });
});

test("corpus site counts separate attempts, successful coverage, failures, and capped coverage", () => {
  const counts = summarizeCorpusSiteCounts([
    makeEntry({ id: "loaded", domain: "loaded.example" }),
    makeEntry({
      id: "loaded-old-failure",
      domain: "loaded.example",
      status: 403,
      runOutcome: "failed",
      reportHasSuccessfulLoad: false
    }),
    makeEntry({
      id: "capped",
      domain: "capped.example",
      capped: true,
      reportHasRequestCappedLoad: true
    }),
    makeEntry({
      id: "failed",
      domain: "failed.example",
      status: 403,
      runOutcome: "failed",
      reportHasSuccessfulLoad: false
    })
  ]);

  assert.deepEqual(counts, {
    attemptedSiteCount: 3,
    coverageSiteCount: 2,
    failedSiteCount: 1,
    cappedSiteCount: 1
  });
});

test("the corpus counts one site however the headline chose to spell it", () => {
  // The directory, the export, and the stats builder all collapse a site with
  // siteProfileKey. Counting on the headline's display string instead meant a
  // rescan recorded under the apex added a site the other three never saw, and
  // /corpus.json disagreed with itself in one payload.
  const entries = [
    makeEntry({ id: "sub", domain: "news.ycombinator.com" }),
    makeEntry({ id: "apex", domain: "ycombinator.com" }),
    makeEntry({ id: "www", domain: "www.ycombinator.com" }),
    makeEntry({ id: "other", domain: "other-site.com" })
  ];

  assert.equal(summarizeCorpusSiteCounts(entries).attemptedSiteCount, 2);
  assert.equal(summarizeCorpusSiteCounts(entries).coverageSiteCount, 2);
  assert.equal(
    new Set(selectSiteDataPoints(entries).map((entry) => corpusSiteDomainKey(entry.domain))).size,
    selectSiteDataPoints(entries).length
  );
  assert.equal(selectSiteDataPoints(entries).length, 2);
});

test("comparison coverage and cap counts consider every arm without double counting the site", () => {
  const counts = summarizeCorpusSiteCounts([
    makeEntry({
      id: "variant-loaded-and-capped",
      domain: "pair.example",
      // Lead/baseline failed and was not capped; report-wide facts record the
      // successful capped variant separately.
      status: 403,
      runOutcome: "failed",
      capped: false,
      reportHasSuccessfulLoad: true,
      reportHasRequestCappedLoad: true
    }),
    makeEntry({
      id: "another-two-arm-report",
      domain: "pair.example",
      reportHasSuccessfulLoad: true,
      reportHasRequestCappedLoad: false
    })
  ]);

  assert.deepEqual(counts, {
    attemptedSiteCount: 1,
    coverageSiteCount: 1,
    failedSiteCount: 0,
    cappedSiteCount: 1
  });
});
