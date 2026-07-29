import assert from "node:assert/strict";
import { test } from "node:test";
import { createGpcComparisonReport } from "./compare-reports";
import { buildReportDataset } from "./report-jsonld";
import { makePublicSingleReportV2R2 } from "./scan-report-v2-r2-fixtures";
import { SCAN_REPORT_SCHEMA_VERSION, type DomainSummary, type ScanResult } from "./types";
import { viewFromV1Report, viewFromV2 } from "./scan-report-views";

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
  assert.deepEqual(dataset.about, {
    "@type": "WebSite",
    name: "shop.example",
    url: "https://www.shop.example/"
  });
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

test("does not publish a privacy-generalized route shape as a WebSite URL", () => {
  const report = makePublicSingleReportV2R2();
  assert.match(report.run.subject.requested.routeShape, /\{/);

  const dataset = buildReportDataset(viewFromV2(report, 2), { url: "https://example.org/reports/r2/" });
  assert.deepEqual(dataset.about, { "@type": "WebSite", name: "example.com" });
});

test("measures both labeled runs and top-level dates for comparison reports", () => {
  const baseline = makeResult({ firstPartyDomain: "news.example", thirdPartyRequests: 50, thirdPartyDomains: 5 });
  const variant = makeResult({ firstPartyDomain: "news.example", thirdPartyRequests: 12, thirdPartyDomains: 5 });
  const comparison = createGpcComparisonReport(baseline, variant);

  const dataset = buildReportDataset(viewFromV1Report(comparison), { url: "https://example.org/reports/cmp/" });
  assert.equal(dataset.name, "Site Behavior Lab scan of news.example");
  assert.equal(dataset.dateCreated, comparison.scannedAt);
  assert.equal(dataset.datePublished, undefined, "scan time is not claimed as publication time");

  // A comparison headline can describe either arm, so the structured data must
  // carry BOTH runs' numbers with the run label in each variable name; an
  // unlabeled single-run number could silently disagree with the description.
  const measured = dataset.variableMeasured as { name: string; value: number }[];
  assert.equal(measured.find((entry) => entry.name === "Third-party requests (GPC off)")?.value, 50);
  assert.equal(measured.find((entry) => entry.name === "Third-party requests (GPC on)")?.value, 12);
  assert.ok(!measured.some((entry) => entry.name === "Third-party requests"));
});

test("omits report-level site attribution for a comparison of different sites", () => {
  const baseline = makeResult({ firstPartyDomain: "news.example" });
  const variant = makeResult({ firstPartyDomain: "other.example" });
  const comparison = createGpcComparisonReport(baseline, variant);

  const dataset = buildReportDataset(viewFromV1Report(comparison), {
    url: "https://example.org/reports/mismatched/"
  });

  assert.equal(dataset.about, undefined);
});

test("omits an incoherent subject URL instead of pairing it with another site name", () => {
  const result = makeResult({ firstPartyDomain: "news.example" });
  result.conditions.requestedUrl = "https://other.example/";
  result.conditions.finalUrl = "https://other.example/";

  const dataset = buildReportDataset(viewFromV1Report(result), {
    url: "https://example.org/reports/incoherent/"
  });

  assert.deepEqual(dataset.about, { "@type": "WebSite", name: "news.example" });
});

test("omits PageGraph-unsupported metrics instead of publishing observed zeroes", () => {
  const view = viewFromV2(makePublicSingleReportV2R2(), 2);
  const run = view.runs[0];
  assert.notEqual(run.quality.byFamily, null);
  assert.notEqual(run.quality.facts, null);
  for (const family of ["cookies", "storage", "fingerprinting", "detector-output", "consent-verification"] as const) {
    run.quality.byFamily![family] = { outcome: "censored", reasons: ["capture-loss:dropped"] };
    run.quality.facts!.captureLoss.push({
      family,
      phaseId: null,
      kind: "dropped",
      count: 0,
      detail: "pagegraph-unsupported"
    });
  }

  const measured = buildReportDataset(view, { url: "https://example.org/reports/pagegraph/" }).variableMeasured as Array<
    Record<string, unknown>
  >;
  assert.ok(measured.some((entry) => entry.name === "Third-party requests" && "value" in entry));
  assert.ok(!measured.some((entry) => entry.name === "Third-party cookies"));
  assert.ok(!measured.some((entry) => entry.name === "Fingerprint-like API calls"));
  const quality = measured.find((entry) => entry.name === "Measurement quality");
  assert.equal(quality?.value, "limited coverage");
  assert.match(String(quality?.description), /Unsupported measurements omitted/);
});

test("omits detector-incomplete metrics instead of publishing an unmeasured zero", () => {
  const view = viewFromV2(makePublicSingleReportV2R2(), 2);
  const run = view.runs[0];
  assert.ok(run.detectors);
  run.detectors["fingerprint-heuristics"] = {
    ...run.detectors["fingerprint-heuristics"],
    status: "failed",
    reason: "scan-failed"
  };
  assert.equal(run.counts.fingerprintEvents, 0);
  assert.equal(run.quality.byFamily?.fingerprinting.outcome, "complete");

  const measured = buildReportDataset(view, {
    url: "https://example.org/reports/detector-incomplete/"
  }).variableMeasured as Array<Record<string, unknown>>;

  assert.ok(
    !measured.some((entry) => entry.name === "Fingerprint-like API calls"),
    "an unfinished detector must not publish its zero as a measurement"
  );
  assert.ok(
    measured.some((entry) => entry.name === "Third-party requests" && "value" in entry),
    "unrelated measurements remain exact"
  );
  const quality = measured.find((entry) => entry.name === "Measurement quality");
  assert.equal(quality?.value, "incomplete");
  assert.match(String(quality?.description), /Unavailable detector measurements omitted: Fingerprint-like API calls/);

  const failedWithLossView = viewFromV2(makePublicSingleReportV2R2(), 2);
  const failedWithLossRun = failedWithLossView.runs[0];
  assert.ok(failedWithLossRun.detectors && failedWithLossRun.quality.facts);
  failedWithLossRun.detectors["fingerprint-heuristics"] = {
    ...failedWithLossRun.detectors["fingerprint-heuristics"],
    status: "failed",
    reason: "engine-unavailable"
  };
  failedWithLossRun.quality.byFamily!.fingerprinting = {
    outcome: "censored",
    reasons: ["capture-loss:dropped"]
  };
  failedWithLossRun.quality.facts.captureLoss.push({
    family: "fingerprinting",
    phaseId: null,
    kind: "dropped",
    count: 0,
    detail: "fingerprint-observer"
  });
  const failedWithLossMeasured = buildReportDataset(failedWithLossView, {
    url: "https://example.org/reports/detector-failed-with-loss/"
  }).variableMeasured as Array<Record<string, unknown>>;
  assert.ok(
    !failedWithLossMeasured.some((entry) => entry.name === "Fingerprint-like API calls"),
    "a failed observer with capture loss is unavailable, not minValue zero"
  );

  const partialView = viewFromV2(makePublicSingleReportV2R2(), 2);
  const partialRun = partialView.runs[0];
  assert.ok(partialRun.detectors);
  partialRun.counts.fingerprintEvents = 3;
  partialRun.detectors["fingerprint-heuristics"] = {
    ...partialRun.detectors["fingerprint-heuristics"],
    status: "partial",
    reason: "budget-unavailable"
  };
  const partialDataset = buildReportDataset(partialView, {
    url: "https://example.org/reports/detector-partial/"
  });
  const partialMeasured = partialDataset.variableMeasured as Array<Record<string, unknown>>;
  const fingerprint = partialMeasured.find((entry) => entry.name === "Fingerprint-like API calls");
  assert.equal(fingerprint?.minValue, 3);
  assert.equal("value" in (fingerprint ?? {}), false);
  assert.match(String(fingerprint?.description), /detector that completed only part/);
  assert.match(String(partialDataset.description), /At least 3 retained browser-API events/);
  assert.doesNotMatch(String(partialDataset.description), /^3 browser-API events appeared/);

  const partialZeroView = viewFromV2(makePublicSingleReportV2R2(), 2);
  const partialZeroRun = partialZeroView.runs[0];
  assert.ok(partialZeroRun.detectors);
  partialZeroRun.detectors["fingerprint-heuristics"] = {
    ...partialZeroRun.detectors["fingerprint-heuristics"],
    status: "partial",
    reason: "budget-unavailable"
  };
  const partialZeroMeasured = buildReportDataset(partialZeroView, {
    url: "https://example.org/reports/detector-partial-zero/"
  }).variableMeasured as Array<Record<string, unknown>>;
  assert.ok(
    !partialZeroMeasured.some((entry) => entry.name === "Fingerprint-like API calls"),
    "a zero lower bound conveys no measurement and must be omitted"
  );
});

test("publishes failed-visit counts as lower bounds rather than exact zeroes", () => {
  const dataset = buildReportDataset(viewFromV1Report(makeResult({ status: 500 })), {
    url: "https://example.org/reports/failed/"
  });
  assert.equal(dataset.about, undefined, "a returned error document is not machine-attributed to the site");
  assert.equal(
    dataset.name,
    "Site Behavior Lab returned-document scan while requesting example.com"
  );
  const measured = dataset.variableMeasured as Array<Record<string, unknown>>;
  const requests = measured.find((entry) => entry.name === "Third-party requests");
  assert.equal(requests?.minValue, 0);
  assert.equal("value" in (requests ?? {}), false);
  assert.match(String(requests?.description), /failed visit/);
  assert.match(String(requests?.description), /returned document/);
  assert.ok(!measured.some((entry) => entry.name === "Third-party cookies"));
  assert.match(
    String(measured.find((entry) => entry.name === "Measurement quality")?.description),
    /Interrupted end-state snapshots omitted: Third-party cookies/
  );
  assert.equal(measured.find((entry) => entry.name === "Measurement quality")?.value, "failed");
});

test("marks capped and generically incomplete metrics as lower bounds while retaining complete families", () => {
  const capped = viewFromV1Report(
    makeResult({ warnings: ["The scan stopped recording or loading additional requests after 1000 requests."] })
  );
  const cappedMeasured = buildReportDataset(capped, { url: "https://example.org/reports/capped/" })
    .variableMeasured as Array<Record<string, unknown>>;
  assert.equal("value" in (cappedMeasured.find((entry) => entry.name === "Third-party requests") ?? {}), false);
  assert.match(
    String(cappedMeasured.find((entry) => entry.name === "Third-party requests")?.description),
    /recording cap/
  );
  assert.ok(!cappedMeasured.some((entry) => entry.name === "Third-party cookies"));
  assert.equal(cappedMeasured.find((entry) => entry.name === "Measurement quality")?.value, "capped");

  const incomplete = viewFromV2(makePublicSingleReportV2R2(), 2);
  incomplete.runs[0].quality.byFamily!.requests = { outcome: "censored", reasons: ["capture-loss:dropped"] };
  const incompleteMeasured = buildReportDataset(incomplete, { url: "https://example.org/reports/incomplete/" })
    .variableMeasured as Array<Record<string, unknown>>;
  const incompleteRequests = incompleteMeasured.find((entry) => entry.name === "Third-party requests");
  const completeCookies = incompleteMeasured.find((entry) => entry.name === "Third-party cookies");
  assert.equal("value" in (incompleteRequests ?? {}), false);
  assert.equal("minValue" in (incompleteRequests ?? {}), true);
  assert.equal("value" in (completeCookies ?? {}), true);
  assert.equal(incompleteMeasured.find((entry) => entry.name === "Measurement quality")?.value, "incomplete");

  const cookieSnapshot = viewFromV2(makePublicSingleReportV2R2(), 2);
  cookieSnapshot.runs[0].quality.byFamily!.cookies = { outcome: "censored", reasons: ["capture-loss:dropped"] };
  const cookieSnapshotMeasured = buildReportDataset(cookieSnapshot, {
    url: "https://example.org/reports/cookie-snapshot/"
  }).variableMeasured as Array<Record<string, unknown>>;
  assert.ok(!cookieSnapshotMeasured.some((entry) => entry.name === "Third-party cookies"));
  assert.equal(cookieSnapshotMeasured.find((entry) => entry.name === "Measurement quality")?.value, "incomplete");
  assert.match(
    String(cookieSnapshotMeasured.find((entry) => entry.name === "Measurement quality")?.description),
    /Interrupted end-state snapshots omitted/
  );
});

type ResultOverrides = {
  firstPartyDomain?: string;
  domains?: DomainSummary[];
  thirdPartyRequests?: number;
  thirdPartyDomains?: number;
  thirdPartyCookies?: number;
  status?: number;
  warnings?: string[];
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
  const firstPartyDomain = overrides.firstPartyDomain ?? "example.com";
  return {
    ok: true,
    schemaVersion: SCAN_REPORT_SCHEMA_VERSION,
    reportType: "single",
    summary: {
      pageTitle: "",
      status: overrides.status ?? 200,
      durationMs: 1,
      firstPartyDomain,
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
      requestedUrl: `https://${firstPartyDomain}/`,
      finalUrl: `https://${firstPartyDomain}/`,
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
    warnings: overrides.warnings ?? []
  };
}
