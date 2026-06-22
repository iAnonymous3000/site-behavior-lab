import assert from "node:assert/strict";
import { test } from "node:test";
import { createShieldsComparisonReport } from "./compare-reports";
import { buildFindings, type Finding, type FindingIconKey } from "./report-findings";
import type { CorpusStats } from "./corpus-stats";
import {
  SCAN_REPORT_SCHEMA_VERSION,
  type DomainSummary,
  type FingerprintDetectionSummary,
  type ScanResult
} from "./types";

const VALID_ICON_KEYS: Set<FindingIconKey> = new Set([
  "globe",
  "network",
  "radar",
  "cookie",
  "eye",
  "fingerprint",
  "shield-check",
  "check",
  "alert"
]);

function byId(findings: Finding[], id: string): Finding {
  const finding = findings.find((item) => item.id === id);
  assert.ok(finding, `expected a "${id}" finding`);
  return finding;
}

test("leads with the bottom line and never caps the cards it emits", () => {
  const result = makeResult({
    domains: [makeTrackerDomain("google-analytics.com", 6, "Google", "analytics")],
    thirdPartyRequests: 6,
    thirdPartyDomains: 1
  });

  const findings = buildFindings(result, result, null);

  assert.equal(findings[0].id, "bottom-line");
  const ids = findings.map((finding) => finding.id);
  for (const expected of ["third-party-services", "named-platforms", "ga-remarketing", "third-party-cookies", "fingerprint-apis"]) {
    assert.ok(ids.includes(expected), `expected a "${expected}" card`);
  }
  // Every icon must be a known key so the UI's icon map can render it.
  for (const finding of findings) {
    assert.ok(VALID_ICON_KEYS.has(finding.icon), `unknown icon key: ${finding.icon}`);
  }
});

test("names major platforms and escalates the third-party card", () => {
  const result = makeResult({
    firstPartyDomain: "news.example",
    domains: [
      makeTrackerDomain("google-analytics.com", 6, "Google", "analytics"),
      makeTrackerDomain("facebook.net", 4, "Meta", "social / advertising pixel"),
      makeTrackerDomain("analytics.tiktok.com", 3, "TikTok", "advertising")
    ],
    thirdPartyRequests: 13,
    thirdPartyDomains: 3
  });

  const findings = buildFindings(result, result, null);

  const platforms = byId(findings, "named-platforms");
  assert.equal(platforms.level, "warn");
  assert.match(platforms.lead, /Google, Meta and TikTok/);

  const services = byId(findings, "third-party-services");
  assert.equal(services.title, "Tracking and ad services saw this visit");
});

test("flags Google Analytics remarketing only when the DoubleClick sync is present", () => {
  const withSync = makeResult({
    domains: [
      makeTrackerDomain("www.google-analytics.com", 4, "Google", "analytics"),
      makeTrackerDomain("stats.g.doubleclick.net", 1, "Google", "advertising")
    ],
    thirdPartyRequests: 5,
    thirdPartyDomains: 2
  });
  assert.equal(byId(buildFindings(withSync, withSync, null), "ga-remarketing").level, "warn");

  const gaOnly = makeResult({
    domains: [makeTrackerDomain("www.google-analytics.com", 4, "Google", "analytics")],
    thirdPartyRequests: 4,
    thirdPartyDomains: 1
  });
  assert.equal(byId(buildFindings(gaOnly, gaOnly, null), "ga-remarketing").title, "Google Analytics present, no remarketing signal");

  // Other *.g.doubleclick.net hosts are publisher ads / cookie matching, not the GA remarketing marker.
  const otherDoubleclick = makeResult({
    domains: [
      makeTrackerDomain("www.google-analytics.com", 4, "Google", "analytics"),
      makeTrackerDomain("securepubads.g.doubleclick.net", 2, "Google", "advertising")
    ],
    thirdPartyRequests: 6,
    thirdPartyDomains: 2
  });
  assert.equal(byId(buildFindings(otherDoubleclick, otherDoubleclick, null), "ga-remarketing").level, "ok");
});

test("treats operational-only services as not tracking", () => {
  const result = makeResult({
    domains: [
      makeTrackerDomain("sentry.io", 2, "Sentry", "error monitoring"),
      makeTrackerDomain("newrelic.com", 2, "New Relic", "performance monitoring")
    ],
    thirdPartyRequests: 4,
    thirdPartyDomains: 2
  });

  const services = byId(buildFindings(result, result, null), "third-party-services");
  assert.equal(services.title, "Only operational services matched");
  assert.equal(services.level, "ok");
});

test("uses measured percentile wording when the corpus is usable, fixed thresholds otherwise", () => {
  const result = makeResult({
    domains: Array.from({ length: 20 }, (_, index) => makeTrackerDomain(`tracker${index}.example`, 2, `Vendor ${index}`, "advertising")),
    thirdPartyRequests: 40,
    thirdPartyDomains: 40
  });

  const withCorpus = buildFindings(result, result, makeCorpus(60));
  assert.match(byId(withCorpus, "third-party-services").benchmark ?? "", /about 90% of the 60 sites scanned so far/);
  assert.match(byId(withCorpus, "bottom-line").detail, /percentiles from the 60 sites/);

  const withoutCorpus = buildFindings(result, result, null);
  const fixedBenchmark = byId(withoutCorpus, "third-party-services").benchmark ?? "";
  assert.doesNotMatch(fixedBenchmark, /sites scanned so far/);
  assert.match(byId(withoutCorpus, "bottom-line").detail, /fixed reference thresholds/);
});

test("small corpora below the honesty gate fall back to fixed thresholds", () => {
  const result = makeResult({ thirdPartyDomains: 40, thirdPartyRequests: 40 });
  const tiny = buildFindings(result, result, makeCorpus(10));
  assert.doesNotMatch(byId(tiny, "third-party-services").benchmark ?? "", /sites scanned so far/);
});

test("adds a Shields-block card only when ad-block is active", () => {
  const base = makeResult({ thirdPartyRequests: 10, thirdPartyDomains: 4, totalRequests: 25 });
  assert.equal(buildFindings(base, base, null).some((finding) => finding.id === "shields-blocked"), false);

  const withAdblock: ScanResult = {
    ...base,
    summary: { ...base.summary, shieldsBlockedRequests: 12 },
    conditions: {
      ...base.conditions,
      adblock: { active: true, source: "brave-default", lists: 5, fetchedAt: new Date(0).toISOString() }
    }
  };
  const blocked = byId(buildFindings(withAdblock, withAdblock, null), "shields-blocked");
  assert.equal(blocked.level, "warn");
  assert.match(blocked.title, /Brave Shields would block 12 of 25 requests/);
});

test("a Shields comparison keeps the fingerprinting card alongside session-recording (no silent cap)", () => {
  const baseline = makeResult({
    firstPartyDomain: "shop.example",
    domains: [
      makeTrackerDomain("google-analytics.com", 8, "Google", "analytics"),
      makeTrackerDomain("hotjar.com", 6, "Hotjar", "session replay / behavior analytics")
    ],
    thirdPartyRequests: 30,
    thirdPartyDomains: 12,
    thirdPartyCookies: 5,
    fingerprintEvents: 6,
    fingerprintDetections: [makeSessionRecordingDetection()]
  });
  const variant = makeResult({
    firstPartyDomain: "shop.example",
    domains: [makeTrackerDomain("google-analytics.com", 2, "Google", "analytics")],
    thirdPartyRequests: 6,
    thirdPartyDomains: 2,
    thirdPartyCookies: 1,
    fingerprintEvents: 0
  });

  const report = createShieldsComparisonReport(baseline, variant);
  const ids = buildFindings(report, baseline, null).map((finding) => finding.id);

  // The historical bug capped the list at eight and dropped the last-pushed
  // fingerprinting card on exactly this shape (Shields comparison + behavioral signal).
  for (const expected of ["shields-comparison", "bottom-line", "session-recording-input-monitoring", "fingerprint-apis"]) {
    assert.ok(ids.includes(expected), `expected a "${expected}" card, got: ${ids.join(", ")}`);
  }
  assert.equal(ids[0], "bottom-line");
  assert.equal(ids[1], "shields-comparison");
});

test("confirmed keystroke exfiltration surfaces a loud finding and drives the bottom line", () => {
  const result = makeResult({
    fingerprintDetections: [
      {
        kind: "keystroke-exfiltration",
        heuristic: "input-sentinel-exfiltration-v1",
        count: 1,
        evidence: { recipients: ["collect.example"], encodings: ["base64", "plain"], fieldsTyped: 2, fieldTypes: ["email", "password"] }
      }
    ]
  });

  const findings = buildFindings(result, result, null);
  const card = byId(findings, "keystroke-exfiltration");
  assert.equal(card.level, "loud");
  assert.equal(card.icon, "keyboard");
  assert.match(card.title, /What you type was sent to 1 third party/);
  assert.match(card.lead, /collect\.example/);
  // A loud signal forces the bottom line loud, and bottom line still leads.
  assert.equal(findings[0].id, "bottom-line");
  assert.equal(byId(findings, "bottom-line").level, "loud");
});

test("keystroke leak severity scales with encoding obfuscation", () => {
  // Plain-text leak = functional type-ahead/autocomplete → calmer "warn".
  const plain = makeResult({ fingerprintDetections: [makeKeystrokeDetection(["plain"])] });
  const plainCard = byId(buildFindings(plain, plain, null), "keystroke-exfiltration");
  assert.equal(plainCard.level, "warn");
  assert.match(plainCard.title, /Your typing is sent to/);

  // Transformed (base64/hex/hashed) leak = consistent with covert capture → "loud".
  const obfuscated = makeResult({ fingerprintDetections: [makeKeystrokeDetection(["base64"])] });
  const obfuscatedCard = byId(buildFindings(obfuscated, obfuscated, null), "keystroke-exfiltration");
  assert.equal(obfuscatedCard.level, "loud");
  assert.match(obfuscatedCard.title, /What you type was sent to/);
});

function makeKeystrokeDetection(encodings: string[]): FingerprintDetectionSummary {
  return {
    kind: "keystroke-exfiltration",
    heuristic: "input-sentinel-exfiltration-v1",
    count: 1,
    evidence: { recipients: ["geocode.arcgis.com"], encodings, fieldsTyped: 2, fieldTypes: ["search"] }
  };
}

function makeCorpus(sampleSize: number): CorpusStats {
  return {
    version: 1,
    generatedAt: new Date(0).toISOString(),
    sampleSize,
    metrics: {
      thirdPartyDomains: { count: sampleSize, min: 0, max: 50, p50: 8, p75: 18, p90: 30, p95: 42 },
      thirdPartyCookies: { count: sampleSize, min: 0, max: 30, p50: 2, p75: 6, p90: 12, p95: 20 }
    }
  };
}

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

function makeSessionRecordingDetection(): FingerprintDetectionSummary {
  return {
    kind: "session-recording",
    heuristic: "interaction-listener-coverage-v1",
    count: 1,
    evidence: {
      eventTypes: ["mousemove", "scroll", "click"],
      listenerTargets: ["document", "window"],
      thirdPartyOrigins: ["hotjar.com"],
      totalListenerCalls: 9
    }
  };
}

type ResultOverrides = {
  firstPartyDomain?: string;
  domains?: DomainSummary[];
  totalRequests?: number;
  thirdPartyRequests?: number;
  thirdPartyDomains?: number;
  thirdPartyCookies?: number;
  fingerprintEvents?: number;
  fingerprintDetections?: FingerprintDetectionSummary[];
};

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
      status: 200,
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
    screenshot: null,
    warnings: []
  };
}
