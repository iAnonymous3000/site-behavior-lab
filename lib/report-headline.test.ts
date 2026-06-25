import assert from "node:assert/strict";
import { test } from "node:test";
import { createGpcComparisonReport, createShieldsComparisonReport } from "./compare-reports";
import { buildReportHeadline } from "./report-headline";
import {
  SCAN_REPORT_SCHEMA_VERSION,
  type DomainSummary,
  type FingerprintDetectionSummary,
  type PixelEventSummary,
  type ScanResult
} from "./types";

test("leads with named platforms and strips the www prefix", () => {
  const result = makeResult({
    firstPartyDomain: "www.shop.example",
    domains: [
      makeTrackerDomain("google-analytics.com", 6, "Google", "analytics / advertising"),
      makeTrackerDomain("facebook.net", 4, "Meta", "social / advertising pixel")
    ],
    thirdPartyRequests: 10,
    thirdPartyDomains: 2
  });

  const headline = buildReportHeadline(result);

  assert.equal(headline.domain, "shop.example");
  assert.equal(headline.tone, "warn");
  assert.match(headline.headline, /shop\.example told Google and Meta you were here\./);
  assert.equal(headline.stats[0].value, "2");
});

test("escalates to alarm when three or more major platforms appear", () => {
  const result = makeResult({
    firstPartyDomain: "news.example",
    domains: [
      makeTrackerDomain("google-analytics.com", 6, "Google", "analytics"),
      makeTrackerDomain("facebook.net", 4, "Meta", "social / advertising pixel"),
      makeTrackerDomain("analytics.tiktok.com", 3, "TikTok", "advertising"),
      makeTrackerDomain("ads.linkedin.com", 2, "LinkedIn", "advertising")
    ],
    thirdPartyRequests: 15,
    thirdPartyDomains: 4
  });

  const headline = buildReportHeadline(result);
  assert.equal(headline.tone, "alarm");
  assert.match(headline.headline, /news\.example told Google, Meta and TikTok, \+1 more you were here\./);
});

test("falls back to a tracking-company count when no major platform matches", () => {
  const result = makeResult({
    firstPartyDomain: "store.example",
    domains: [
      makeTrackerDomain("hotjar.com", 5, "Hotjar", "session replay / behavior analytics"),
      makeTrackerDomain("segment.com", 3, "Segment", "customer data platform")
    ],
    thirdPartyRequests: 8,
    thirdPartyDomains: 2
  });

  const headline = buildReportHeadline(result);
  assert.match(headline.headline, /store\.example shared this visit with 2 tracking companies\./);
  // Hotjar is a session-replay vendor, so the subhead should flag recording.
  assert.match(headline.subhead, /session-replay vendor can record/);
});

test("treats operational-only services as not tracking", () => {
  const result = makeResult({
    firstPartyDomain: "app.example",
    domains: [
      makeTrackerDomain("sentry.io", 2, "Sentry", "error monitoring"),
      makeTrackerDomain("newrelic.com", 2, "New Relic", "performance monitoring")
    ],
    thirdPartyRequests: 4,
    thirdPartyDomains: 2
  });

  const headline = buildReportHeadline(result);
  assert.equal(headline.tone, "calm");
  assert.match(headline.headline, /app\.example kept this visit relatively private\./);
});

test("flags a GPC comparison that barely changed as an alarm", () => {
  const baseline = makeResult({
    firstPartyDomain: "www.amazon.com",
    domains: [makeTrackerDomain("amazon-adsystem.com", 200, "Amazon", "advertising")],
    thirdPartyRequests: 420,
    thirdPartyDomains: 40
  });
  const variant = makeResult({
    firstPartyDomain: "www.amazon.com",
    domains: [makeTrackerDomain("amazon-adsystem.com", 195, "Amazon", "advertising")],
    thirdPartyRequests: 415,
    thirdPartyDomains: 40
  });

  const headline = buildReportHeadline(createGpcComparisonReport(baseline, variant));
  assert.equal(headline.tone, "alarm");
  assert.match(headline.headline, /Your privacy signal barely changed what amazon\.com loaded\./);
  assert.match(headline.subhead, /do not sell or share/);
});

test("phrases a GPC comparison that loaded more as 'more', not a negative percent", () => {
  const baseline = makeResult({
    firstPartyDomain: "www.shop.example",
    domains: [makeTrackerDomain("ads.example", 100, "AdCo", "advertising")],
    thirdPartyRequests: 100,
    thirdPartyDomains: 10
  });
  const variant = makeResult({
    firstPartyDomain: "www.shop.example",
    domains: [makeTrackerDomain("ads.example", 110, "AdCo", "advertising")],
    thirdPartyRequests: 110,
    thirdPartyDomains: 10
  });

  const headline = buildReportHeadline(createGpcComparisonReport(baseline, variant));
  assert.equal(headline.tone, "alarm");
  assert.match(headline.subhead, /10% more than without it/);
  assert.doesNotMatch(headline.subhead, /down just/);
  assert.doesNotMatch(headline.subhead, /-\d/);
});

test("credits a GPC comparison that pulled back as calm", () => {
  const baseline = makeResult({
    firstPartyDomain: "respectful.example",
    domains: [makeTrackerDomain("ads.example", 100, "AdCo", "advertising")],
    thirdPartyRequests: 100,
    thirdPartyDomains: 10
  });
  const variant = makeResult({
    firstPartyDomain: "respectful.example",
    domains: [],
    thirdPartyRequests: 0,
    thirdPartyDomains: 0
  });

  const headline = buildReportHeadline(createGpcComparisonReport(baseline, variant));
  assert.equal(headline.tone, "calm");
  assert.match(headline.headline, /respectful\.example pulled back when you sent a privacy signal\./);
});

test("frames a Shields comparison around what a blocker removes", () => {
  const baseline = makeResult({
    firstPartyDomain: "heavy.example",
    domains: [makeTrackerDomain("ads.example", 60, "AdCo", "advertising")],
    totalRequests: 100,
    thirdPartyRequests: 60,
    thirdPartyDomains: 12
  });
  const variant = makeResult({
    firstPartyDomain: "heavy.example",
    domains: [makeTrackerDomain("ads.example", 5, "AdCo", "advertising")],
    totalRequests: 45,
    thirdPartyRequests: 5,
    thirdPartyDomains: 2
  });

  const headline = buildReportHeadline(createShieldsComparisonReport(baseline, variant));
  assert.equal(headline.tone, "warn");
  assert.match(headline.headline, /A basic blocker would stop 55 requests on heavy\.example\./);
});

test("surfaces browser probing when fingerprinting matches without catalogued trackers", () => {
  const result = makeResult({
    firstPartyDomain: "fp.example",
    domains: [],
    thirdPartyRequests: 0,
    thirdPartyDomains: 0,
    fingerprintDetections: [makeCanvasDetection()]
  });

  const headline = buildReportHeadline(result);
  assert.equal(headline.tone, "warn");
  assert.match(headline.headline, /fp\.example probed your browser, not just served a page\./);
  assert.equal(headline.stats[0].value, "1");
});

test("share text combines the headline, top stats, and the reproducibility tagline", () => {
  const result = makeResult({
    firstPartyDomain: "store.example",
    domains: [makeTrackerDomain("hotjar.com", 5, "Hotjar", "session replay / behavior analytics")],
    thirdPartyRequests: 5,
    thirdPartyDomains: 1
  });

  const headline = buildReportHeadline(result);
  assert.match(headline.shareText, /shared this visit with 1 tracking company/);
  assert.match(headline.shareText, /Open-source and reproducible:/);
});

test("confirmed keystroke exfiltration leads the headline with alarm", () => {
  const result = makeResult({
    firstPartyDomain: "shop.example",
    domains: [makeTrackerDomain("google-analytics.com", 4, "Google", "analytics")],
    thirdPartyRequests: 4,
    thirdPartyDomains: 1,
    fingerprintDetections: [
      {
        kind: "keystroke-exfiltration",
        heuristic: "input-sentinel-exfiltration-v1",
        count: 1,
        evidence: { recipients: ["collect.tracker.example"], encodings: ["base64"], fieldsTyped: 1, fieldTypes: ["email"] }
      }
    ]
  });

  const headline = buildReportHeadline(result);
  // Confirmed input capture outranks the named-platform (Google) story.
  assert.equal(headline.tone, "alarm");
  assert.match(headline.headline, /shop\.example sent what you type to 1 third party\./);
  assert.match(headline.subhead, /collect\.tracker\.example/);
});

test("a plain-text keystroke leak reads as a calmer third-party type-ahead, not an alarm", () => {
  // The real weather.gov case: typing in the location search reaches Esri's
  // geocoder in plain text, functional autocomplete, not covert capture.
  const result = makeResult({
    firstPartyDomain: "weather.gov",
    fingerprintDetections: [
      {
        kind: "keystroke-exfiltration",
        heuristic: "input-sentinel-exfiltration-v1",
        count: 1,
        evidence: { recipients: ["geocode.arcgis.com"], encodings: ["plain"], fieldsTyped: 2, fieldTypes: ["search"] }
      }
    ]
  });

  const headline = buildReportHeadline(result);
  assert.equal(headline.tone, "warn");
  assert.match(headline.headline, /weather\.gov sends what you type to 1 third party as you type\./);
  assert.match(headline.subhead, /geocode\.arcgis\.com/);
});

test("a pixel that attached personal identifiers leads over the named-platform story", () => {
  const result = makeResult({
    firstPartyDomain: "shop.example",
    domains: [makeTrackerDomain("facebook.net", 4, "Meta", "social / advertising pixel")],
    thirdPartyRequests: 4,
    thirdPartyDomains: 1,
    pixelEvents: [
      { platform: "Meta", product: "Meta Pixel", events: ["Purchase"], advancedMatching: ["email", "phone"], requests: 2 }
    ]
  });

  const headline = buildReportHeadline(result);
  assert.equal(headline.tone, "warn");
  assert.match(headline.headline, /shop\.example sent personal identifiers to Meta Pixel\./);
  assert.match(headline.subhead, /hashed personal identifiers \(email and phone\)/);
});

test("an event-only pixel does not trigger the identifier headline", () => {
  const result = makeResult({
    firstPartyDomain: "shop.example",
    domains: [makeTrackerDomain("facebook.net", 4, "Meta", "social / advertising pixel")],
    thirdPartyRequests: 4,
    thirdPartyDomains: 1,
    pixelEvents: [{ platform: "Meta", product: "Meta Pixel", events: ["PageView"], advancedMatching: [], requests: 1 }]
  });

  const headline = buildReportHeadline(result);
  // No advanced matching, so it falls through to the named-platform line.
  assert.match(headline.headline, /shop\.example told Meta you were here\./);
});

test("an HTTP error load is framed as a failed load, not as relatively private", () => {
  const result = makeResult({ firstPartyDomain: "blocked.example", status: 403, totalRequests: 1 });

  const headline = buildReportHeadline(result);
  assert.equal(headline.tone, "info");
  assert.match(headline.headline, /blocked\.example returned an error, so there was little to scan\./);
  assert.match(headline.subhead, /HTTP 403/);
  assert.doesNotMatch(headline.headline, /relatively private/);
  assert.equal(headline.stats[0]?.value, "403");
});

test("a server-error load with zero requests does not read as private", () => {
  const result = makeResult({ firstPartyDomain: "down.example", status: 503, totalRequests: 0 });

  const headline = buildReportHeadline(result);
  assert.equal(headline.tone, "info");
  assert.match(headline.subhead, /HTTP 503/);
  assert.doesNotMatch(headline.headline, /relatively private/);
});

test("a null status (e.g. PageGraph import) is not treated as a failed load", () => {
  const result = makeResult({ firstPartyDomain: "quiet.example", status: null });

  const headline = buildReportHeadline(result);
  assert.equal(headline.tone, "calm");
  assert.match(headline.headline, /quiet\.example kept this visit relatively private\./);
});

type ResultOverrides = {
  firstPartyDomain?: string;
  domains?: DomainSummary[];
  totalRequests?: number;
  thirdPartyRequests?: number;
  thirdPartyDomains?: number;
  thirdPartyCookies?: number;
  fingerprintEvents?: number;
  fingerprintDetections?: FingerprintDetectionSummary[];
  pixelEvents?: PixelEventSummary[];
  status?: number | null;
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

function makeCanvasDetection(): FingerprintDetectionSummary {
  return {
    kind: "canvas-fingerprinting",
    heuristic: "openwpm-canvas-v1",
    count: 1,
    evidence: {
      readApis: ["canvas.toDataURL"],
      maxCanvasWidth: 280,
      maxCanvasHeight: 60,
      maxDistinctTextCharacters: 24,
      maxTextWriteCalls: 3
    }
  };
}

function makeResult(overrides: ResultOverrides = {}): ScanResult {
  const domains = overrides.domains ?? [];
  const thirdPartyRequests = overrides.thirdPartyRequests ?? domains.reduce((total, domain) => total + domain.requests, 0);
  const knownTrackerRequests = domains.filter((domain) => domain.tracker).reduce((total, domain) => total + domain.requests, 0);

  return {
    ok: true,
    schemaVersion: SCAN_REPORT_SCHEMA_VERSION,
    reportType: "single",
    summary: {
      pageTitle: "",
      status: overrides.status === undefined ? 200 : overrides.status,
      durationMs: 1,
      firstPartyDomain: overrides.firstPartyDomain ?? "example.com",
      totalRequests: overrides.totalRequests ?? thirdPartyRequests + 5,
      thirdPartyRequests,
      knownTrackerRequests,
      thirdPartyDomains: overrides.thirdPartyDomains ?? domains.length,
      cookies: overrides.thirdPartyCookies ?? 0,
      thirdPartyCookies: overrides.thirdPartyCookies ?? 0,
      storageEntries: 0,
      fingerprintEvents: overrides.fingerprintEvents ?? 0
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
    fingerprintDetections: overrides.fingerprintDetections ?? [],
    ...(overrides.pixelEvents ? { pixelEvents: overrides.pixelEvents } : {}),
    screenshot: null,
    warnings: []
  };
}
