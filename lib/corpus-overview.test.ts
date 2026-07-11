import assert from "node:assert/strict";
import { test } from "node:test";
import { createConsentComparisonReport } from "./compare-reports";
import { consentClicksForView, preferAsSiteDataPoint, type DirectoryEntry } from "./corpus-overview";
import { SCAN_REPORT_SCHEMA_VERSION, type ConsentInteractionSummary, type ScanResult } from "./types";
import { viewFromV1Report } from "./scan-report-views";

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

function makeEntry(overrides: Partial<DirectoryEntry> & { id: string }): DirectoryEntry {
  return {
    domain: "shop.example",
    tone: "warn",
    headline: "shop.example told Google you were here.",
    thirdPartyRequests: 100,
    trackerRequests: 40,
    thirdPartyCookies: 8,
    shieldsThirdPartyReduction: 20,
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
    schemaVersion: 1,
    schemaRevision: null,
    schemaOrigin: "legacy-derived",
    limited: true,
    ...overrides
  };
}

test("preferAsSiteDataPoint keeps a Shields report over other kinds regardless of age", () => {
  const shields = makeEntry({ id: "shields", scannedAt: "2026-06-01T00:00:00.000Z" });
  const gpc = makeEntry({ id: "gpc", comparisonType: "gpc", scannedAt: "2026-07-05T00:00:00.000Z" });

  assert.equal(preferAsSiteDataPoint(shields, gpc), true);
  assert.equal(preferAsSiteDataPoint(gpc, shields), false);
});

test("preferAsSiteDataPoint picks the newest scan within a kind, not the heaviest", () => {
  // The archive keeps historical runs; a heavier June run must not represent
  // the site once a lighter July re-scan exists.
  const heavyOld = makeEntry({ id: "heavy-old", scannedAt: "2026-06-25T00:00:00.000Z", thirdPartyRequests: 589 });
  const lightNew = makeEntry({ id: "light-new", scannedAt: "2026-07-06T00:00:00.000Z", thirdPartyRequests: 399 });

  assert.equal(preferAsSiteDataPoint(lightNew, heavyOld), true);
  assert.equal(preferAsSiteDataPoint(heavyOld, lightNew), false);
});
