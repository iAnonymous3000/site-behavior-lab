import assert from "node:assert/strict";
import { test } from "node:test";
import { createShieldsComparisonReport, createTemporalComparisonReport } from "./compare-reports";
import {
  COMPARISON_REQUEST_CAP,
  comparableSubjectHosts,
  comparisonEligibility,
  runHitRequestCap
} from "./comparison-eligibility";
import { MAX_RECORDED_REQUESTS, ScanRequestBudget, ScanWarningCollector } from "./scan-runtime";
import { SCAN_REPORT_SCHEMA_VERSION, type ScanConditions, type ScanResult } from "./types";

test("the eligibility cap constant matches the scanner's recording cap", () => {
  // comparison-eligibility must stay client-safe (no public-suffix list), so it
  // mirrors the constant instead of importing scan-runtime; this pin keeps the
  // two from drifting.
  assert.equal(COMPARISON_REQUEST_CAP, MAX_RECORDED_REQUESTS);
});

test("a matched, uncapped, loaded pair is eligible", () => {
  const report = createShieldsComparisonReport(
    makeRun({ firstPartyDomain: "www.example.com" }),
    makeRun({ firstPartyDomain: "example.com" })
  );
  assert.deepEqual(comparisonEligibility(report), { eligible: true, reasons: [] });
});

test("a failed arm disqualifies the comparison and names the run label", () => {
  const report = createShieldsComparisonReport(makeRun({}), makeRun({ status: 403 }));
  const eligibility = comparisonEligibility(report);
  assert.equal(eligibility.eligible, false);
  assert.equal(eligibility.reasons.length, 1);
  assert.match(eligibility.reasons[0], /"Shields on" visit returned HTTP 403/);
});

test("a request-capped arm disqualifies the comparison", () => {
  const report = createShieldsComparisonReport(makeRun({ totalRequests: COMPARISON_REQUEST_CAP }), makeRun({}));
  const eligibility = comparisonEligibility(report);
  assert.equal(eligibility.eligible, false);
  assert.match(eligibility.reasons[0], /"Shields off" visit hit the 1,000-request recording cap/);
});

test("the cap is also detected from the scanner's real cap warning", () => {
  // Reproduce the exact warning ScanRequestBudget emits, so the fragment match
  // in runHitRequestCap is pinned to the real message.
  const warnings = new ScanWarningCollector();
  const budget = new ScanRequestBudget(warnings, 1);
  assert.equal(budget.allowRecordedRequest(), true);
  assert.equal(budget.allowRecordedRequest(), false);
  assert.equal(warnings.list.length, 1);

  const run = makeRun({ totalRequests: 1 });
  run.warnings = [...warnings.list];
  assert.equal(runHitRequestCap(run), true);
  assert.equal(runHitRequestCap(makeRun({ totalRequests: 1 })), false);
});

test("mismatched subjects, devices, and pipelines each disqualify", () => {
  const differentSite = comparisonEligibility(
    createTemporalComparisonReport(makeRun({ firstPartyDomain: "alpha.example" }), makeRun({ firstPartyDomain: "beta.example" }))
  );
  assert.equal(differentSite.eligible, false);
  assert.match(differentSite.reasons[0], /different sites \(alpha\.example vs beta\.example\)/);

  const mobileVariant = makeRun({});
  mobileVariant.conditions = { ...mobileVariant.conditions, viewport: { width: 390, height: 844, isMobile: true } };
  const differentDevice = comparisonEligibility(createTemporalComparisonReport(makeRun({}), mobileVariant));
  assert.equal(differentDevice.eligible, false);
  assert.match(differentDevice.reasons[0], /different devices/);

  const pagegraphVariant = makeRun({});
  pagegraphVariant.conditions = { ...pagegraphVariant.conditions, automation: "brave-pagegraph" };
  const differentPipeline = comparisonEligibility(createTemporalComparisonReport(makeRun({}), pagegraphVariant));
  assert.equal(differentPipeline.eligible, false);
  assert.match(differentPipeline.reasons[0], /different scanner pipelines \(playwright-chromium vs brave-pagegraph\)/);
});

test("every disqualifying condition is reported, not just the first", () => {
  const variant = makeRun({ firstPartyDomain: "beta.example", status: 500, totalRequests: COMPARISON_REQUEST_CAP });
  const eligibility = comparisonEligibility(createTemporalComparisonReport(makeRun({ firstPartyDomain: "alpha.example" }), variant));
  assert.equal(eligibility.eligible, false);
  assert.equal(eligibility.reasons.length, 3);
});

test("comparableSubjectHosts accepts same-site variations and rejects unrelated hosts", () => {
  assert.equal(comparableSubjectHosts("www.example.com", "example.com"), true);
  assert.equal(comparableSubjectHosts("m.example.com", "www.example.com"), true);
  assert.equal(comparableSubjectHosts("Example.com.", "example.com"), true);
  assert.equal(comparableSubjectHosts("example.com", "example.org"), false);
  assert.equal(comparableSubjectHosts("notexample.com", "example.com"), false);
  assert.equal(comparableSubjectHosts("", "example.com"), false);
});

type RunOverrides = {
  firstPartyDomain?: string;
  status?: number;
  totalRequests?: number;
};

function makeRun(overrides: RunOverrides): ScanResult {
  const conditions: ScanConditions = {
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
  };

  return {
    ok: true,
    schemaVersion: SCAN_REPORT_SCHEMA_VERSION,
    reportType: "single",
    summary: {
      pageTitle: "",
      status: overrides.status ?? 200,
      durationMs: 1,
      firstPartyDomain: overrides.firstPartyDomain ?? "example.com",
      totalRequests: overrides.totalRequests ?? 20,
      thirdPartyRequests: 5,
      knownTrackerRequests: 0,
      thirdPartyDomains: 2,
      cookies: 0,
      thirdPartyCookies: 0,
      storageEntries: 0,
      fingerprintEvents: 0
    },
    conditions,
    requests: [],
    domains: [],
    cookies: [],
    storage: [],
    fingerprintEvents: [],
    fingerprintDetections: [],
    screenshot: null,
    warnings: []
  };
}
