import assert from "node:assert/strict";
import { test } from "node:test";
import { createGpcComparisonReport } from "./compare-reports";
import { buildReportDataset } from "./report-jsonld";
import { SCAN_REPORT_SCHEMA_VERSION, type DomainSummary, type ScanResult } from "./types";
import { viewFromV1Report } from "./scan-report-views";

test("builds a Dataset with metrics, download link, and the scanned site", () => {
  const result = makeResult({
    firstPartyDomain: "www.shop.example",
    domains: [makeTrackerDomain("ads.example", 6, "AdCo", "advertising")],
    thirdPartyRequests: 6,
    thirdPartyDomains: 1,
    thirdPartyCookies: 2
  });

  const dataset = buildReportDataset(viewFromV1Report(result), {
    url: "https://example.org/reports/abc/",
    jsonUrl: "https://example.org/reports/abc.json"
  });

  assert.equal(dataset["@type"], "Dataset");
  assert.equal(dataset.name, "Site Behavior Lab scan of shop.example");
  assert.equal(dataset.url, "https://example.org/reports/abc/");
  assert.deepEqual(dataset.about, { "@type": "WebSite", name: "shop.example", url: "https://example.com/" });
  assert.deepEqual(dataset.distribution, {
    "@type": "DataDownload",
    encodingFormat: "application/json",
    contentUrl: "https://example.org/reports/abc.json"
  });

  const measured = dataset.variableMeasured as { name: string; value: number }[];
  const thirdParty = measured.find((entry) => entry.name === "Third-party requests");
  assert.equal(thirdParty?.value, 6);

  // The summary count includes operational services (Sentry and friends), so
  // the structured-data label must say catalogued services, not trackers.
  assert.ok(measured.some((entry) => entry.name === "Catalogued service requests"));
  assert.ok(!measured.some((entry) => entry.name.toLowerCase().includes("tracker")));
});

test("omits the download link when no JSON URL is provided", () => {
  const dataset = buildReportDataset(viewFromV1Report(makeResult({})), { url: "https://example.org/reports/abc/" });
  assert.equal(dataset.distribution, undefined);
});

test("measures both labeled runs and top-level dates for comparison reports", () => {
  const baseline = makeResult({ firstPartyDomain: "news.example", thirdPartyRequests: 50, thirdPartyDomains: 5 });
  const variant = makeResult({ firstPartyDomain: "news.example", thirdPartyRequests: 12, thirdPartyDomains: 5 });
  const comparison = createGpcComparisonReport(baseline, variant);

  const dataset = buildReportDataset(viewFromV1Report(comparison), { url: "https://example.org/reports/cmp/" });
  assert.equal(dataset.name, "Site Behavior Lab scan of news.example");
  assert.equal(dataset.dateCreated, comparison.scannedAt);

  // A comparison headline can describe either arm, so the structured data must
  // carry BOTH runs' numbers with the run label in each variable name; an
  // unlabeled single-run number could silently disagree with the description.
  const measured = dataset.variableMeasured as { name: string; value: number }[];
  assert.equal(measured.find((entry) => entry.name === "Third-party requests (GPC off)")?.value, 50);
  assert.equal(measured.find((entry) => entry.name === "Third-party requests (GPC on)")?.value, 12);
  assert.ok(!measured.some((entry) => entry.name === "Third-party requests"));
});

type ResultOverrides = {
  firstPartyDomain?: string;
  domains?: DomainSummary[];
  thirdPartyRequests?: number;
  thirdPartyDomains?: number;
  thirdPartyCookies?: number;
};

function makeTrackerDomain(domain: string, requests: number, entity: string, category: string): DomainSummary {
  return {
    domain,
    requests,
    thirdParty: true,
    tracker: { domain, entity, category, confidence: "curated" },
    statuses: [200],
    resourceTypes: ["script"]
  };
}

function makeResult(overrides: ResultOverrides): ScanResult {
  const domains = overrides.domains ?? [];
  return {
    ok: true,
    schemaVersion: SCAN_REPORT_SCHEMA_VERSION,
    reportType: "single",
    summary: {
      pageTitle: "",
      status: 200,
      durationMs: 1,
      firstPartyDomain: overrides.firstPartyDomain ?? "example.com",
      totalRequests: (overrides.thirdPartyRequests ?? 0) + 5,
      thirdPartyRequests: overrides.thirdPartyRequests ?? 0,
      knownTrackerRequests: domains.reduce((total, domain) => total + domain.requests, 0),
      thirdPartyDomains: overrides.thirdPartyDomains ?? domains.length,
      cookies: overrides.thirdPartyCookies ?? 0,
      thirdPartyCookies: overrides.thirdPartyCookies ?? 0,
      storageEntries: 0,
      fingerprintEvents: 0
    },
    conditions: {
      requestedUrl: "https://example.com/",
      finalUrl: "https://example.com/",
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
    domains,
    cookies: [],
    storage: [],
    fingerprintEvents: [],
    fingerprintDetections: [],
    screenshot: null,
    warnings: []
  };
}
