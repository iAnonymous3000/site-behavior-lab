import assert from "node:assert/strict";
import { test } from "node:test";
import { createConsentComparisonReport, createGpcComparisonReport, createShieldsComparisonReport } from "./compare-reports";
import { displayableScreenshot } from "./report-insights";
import { buildReportHeadline } from "./report-headline";
import { viewFromV1Report } from "./scan-report-views";
import {
  SCAN_REPORT_SCHEMA_VERSION,
  type DomainSummary,
  type FingerprintDetectionSummary,
  type PixelEventSummary,
  type ScanResult
} from "./types";

test("only inline data-URI screenshots are displayable; uploaded URLs never render", () => {
  assert.equal(
    displayableScreenshot("data:image/jpeg;base64,AAAA"),
    "data:image/jpeg;base64,AAAA"
  );
  assert.equal(displayableScreenshot("data:image/png;base64,iVBORw0KGgo="), "data:image/png;base64,iVBORw0KGgo=");
  // An uploaded report's screenshot field must never drive a network request
  // or execute anything in the viewer's browser.
  assert.equal(displayableScreenshot("https://attacker.example/beacon.png"), null);
  assert.equal(displayableScreenshot("//attacker.example/beacon.png"), null);
  assert.equal(displayableScreenshot("javascript:alert(1)"), null);
  assert.equal(displayableScreenshot("data:text/html;base64,PGh0bWw+"), null);
  assert.equal(displayableScreenshot("data:image/svg+xml;base64,AAAA"), null);
  assert.equal(displayableScreenshot(null), null);
  assert.equal(displayableScreenshot(undefined), null);
});

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

  const headline = buildReportHeadline(viewFromV1Report(result));

  assert.equal(headline.domain, "shop.example");
  assert.equal(headline.tone, "warn");
  assert.match(headline.headline, /shop\.example told Google and Meta you were here\./);
  assert.equal(headline.stats[0].value, "2");
});

test("headlines name the stable site instead of a redacted subdomain marker", () => {
  const result = makeResult({ firstPartyDomain: "www.{label}.clevelandclinic.org" });
  const headline = buildReportHeadline(viewFromV1Report(result));
  assert.equal(headline.domain, "clevelandclinic.org");
  assert.equal(headline.headline.includes("{label}"), false);
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

  const headline = buildReportHeadline(viewFromV1Report(result));
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

  const headline = buildReportHeadline(viewFromV1Report(result));
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

  const headline = buildReportHeadline(viewFromV1Report(result));
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

  const headline = buildReportHeadline(viewFromV1Report(gpcPair(baseline, variant)));
  assert.equal(headline.tone, "alarm");
  // DESCRIPTIVE two-visit wording only: "the signal barely changed what
  // loaded" is intervention-attributed phrasing (RFC 4.4) and would need
  // claims.interventionAttribution, which no v1 report can grant.
  assert.match(headline.headline, /amazon\.com still contacted 1 tracking company with a privacy signal on\./);
  assert.match(headline.subhead, /do not sell or share/);
  assert.match(headline.subhead, /versus 420 in the visit without the signal/);
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

  const headline = buildReportHeadline(viewFromV1Report(gpcPair(baseline, variant)));
  assert.equal(headline.tone, "alarm");
  // Side-by-side numbers, never a computed "down just -10%" phrase.
  assert.match(headline.subhead, /110 third-party requests, versus 100 in the visit without the signal/);
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

  const headline = buildReportHeadline(viewFromV1Report(gpcPair(baseline, variant)));
  assert.equal(headline.tone, "calm");
  assert.match(headline.headline, /Off-site requests to respectful\.example dropped 100% with a privacy signal on\./);
  assert.match(headline.subhead, /not proof the site honors the signal/);
});

test("the GPC alarm counts tracking companies from the GPC-on visit, not the baseline", () => {
  // Baseline (GPC off) saw three tracking companies; the GPC-on visit saw one.
  // The alarm sentence describes the GPC-on visit, so it must say one.
  const baseline = makeResult({
    firstPartyDomain: "www.shop.example",
    domains: [
      makeTrackerDomain("ads.example", 100, "AdCo", "advertising"),
      makeTrackerDomain("pixels.example", 40, "PixelCo", "advertising"),
      makeTrackerDomain("metrics.example", 20, "MetricCo", "analytics")
    ],
    thirdPartyRequests: 200,
    thirdPartyDomains: 12
  });
  const variant = makeResult({
    firstPartyDomain: "www.shop.example",
    domains: [makeTrackerDomain("ads.example", 90, "AdCo", "advertising")],
    thirdPartyRequests: 180,
    thirdPartyDomains: 8
  });

  const headline = buildReportHeadline(viewFromV1Report(gpcPair(baseline, variant)));
  assert.equal(headline.tone, "alarm");
  assert.match(headline.subhead, /still contacted 1 tracking company:/);
  assert.doesNotMatch(headline.subhead, /3 tracking companies/);
  // The stat chips and share text sit next to the sentence, so they must quote
  // the same GPC-on visit, not the baseline's three companies.
  assert.equal(headline.stats.find((stat) => stat.label.includes("tracking"))?.value, "1");
  assert.match(headline.shareText, /1 tracking company/);
  assert.doesNotMatch(headline.shareText, /3 tracking companies/);
});

test("the GPC alarm is not raised from baseline-only tracking companies", () => {
  // Every catalogued tracker disappeared in the GPC-on visit even though the
  // request-count reduction is small; the old code read the baseline's
  // entities and would still have alarmed "still contacted 1 tracking company".
  const baseline = makeResult({
    firstPartyDomain: "www.shop.example",
    domains: [makeTrackerDomain("ads.example", 100, "AdCo", "advertising")],
    thirdPartyRequests: 100,
    thirdPartyDomains: 10
  });
  const variant = makeResult({
    firstPartyDomain: "www.shop.example",
    domains: [],
    thirdPartyRequests: 90,
    thirdPartyDomains: 9
  });

  const headline = buildReportHeadline(viewFromV1Report(gpcPair(baseline, variant)));
  assert.doesNotMatch(headline.subhead, /still contacted/);
});

test("frames a Shields comparison as the observed paired-visit difference", () => {
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

  const headline = buildReportHeadline(viewFromV1Report(shieldsPair(baseline, variant)));
  assert.equal(headline.tone, "warn");
  assert.match(headline.headline, /heavy\.example loaded 55 fewer third-party requests with Brave-list blocking on\./);
  assert.doesNotMatch(headline.headline, /would/);
});

test("a Shields comparison names the direct engine blocks separately from the reduction", () => {
  const baseline = makeResult({
    firstPartyDomain: "heavy.example",
    domains: [makeTrackerDomain("ads.example", 60, "AdCo", "advertising")],
    totalRequests: 100,
    thirdPartyRequests: 60
  });
  const variant = makeResult({
    firstPartyDomain: "heavy.example",
    domains: [],
    totalRequests: 45,
    thirdPartyRequests: 5
  });
  variant.summary = { ...variant.summary, shieldsBlockedRequests: 12 };
  variant.conditions = {
    ...variant.conditions,
    shieldsMode: "block-simulation",
    adblock: { active: true, source: "brave-default", lists: 5, fetchedAt: new Date(0).toISOString() }
  };

  const headline = buildReportHeadline(viewFromV1Report(shieldsPair(baseline, variant)));
  assert.match(headline.headline, /55 fewer third-party requests/);
  // The direct-abort count and the total reduction are different measurements
  // and must appear as two separately-labeled numbers, never blended.
  assert.match(headline.subhead, /directly stopped 12 requests/);
  // The residual is NOT established to be follow-on prevention: it can also be
  // ordinary run variance, so the wording must stay hedged.
  assert.match(headline.subhead, /may include follow-on requests/);
  assert.match(headline.subhead, /run-to-run variance/);
  assert.doesNotMatch(headline.subhead, /the rest never started/);
});

test("comparison framings are refused when an arm failed, is capped, or mismatches", () => {
  const trackerDomains = [makeTrackerDomain("ads.example", 60, "AdCo", "advertising")];

  // Capped baseline: the Shields story must not be told from truncated counts.
  const cappedBaseline = makeResult({
    firstPartyDomain: "heavy.example",
    domains: trackerDomains,
    totalRequests: 1000,
    thirdPartyRequests: 60
  });
  const shieldsVariant = makeResult({ firstPartyDomain: "heavy.example", totalRequests: 45, thirdPartyRequests: 5 });
  const cappedHeadline = buildReportHeadline(viewFromV1Report(shieldsPair(cappedBaseline, shieldsVariant)));
  assert.doesNotMatch(cappedHeadline.headline, /fewer third-party requests with Brave-list blocking on/);

  // Failed GPC variant: the pair supports no signal story.
  const gpcBaseline = makeResult({ firstPartyDomain: "shop.example", domains: trackerDomains, thirdPartyRequests: 100 });
  const failedVariant = makeResult({ firstPartyDomain: "shop.example", thirdPartyRequests: 0, status: 403 });
  const gpcHeadline = buildReportHeadline(viewFromV1Report(gpcPair(gpcBaseline, failedVariant)));
  assert.doesNotMatch(gpcHeadline.headline, /privacy signal/);

  // Mismatched consent subject: the click story must not be told across sites.
  const acceptRun = {
    ...makeResult({ firstPartyDomain: "shop.example", domains: trackerDomains, thirdPartyRequests: 30 }),
    consentInteraction: { mode: "accept-all" as const, clicked: true, cmp: "OneTrust" }
  };
  const strayRejectRun = {
    ...makeResult({
      firstPartyDomain: "other.example",
      domains: [makeTrackerDomain("google-analytics.com", 3, "Google", "analytics")],
      thirdPartyRequests: 6
    }),
    consentInteraction: { mode: "reject-all" as const, clicked: true, cmp: "OneTrust" }
  };
  const consentHeadline = buildReportHeadline(viewFromV1Report(consentPair(acceptRun, strayRejectRun)));
  assert.doesNotMatch(consentHeadline.headline, /Reject-all visit/);
});

test("listener detections whose origins are same-site per the request log claim nothing", () => {
  const sameSiteDomain: DomainSummary = {
    domain: "verified.shop.example",
    requests: 3,
    thirdParty: false,
    tracker: null,
    statuses: [200],
    resourceTypes: ["script"]
  };
  const result = makeResult({
    firstPartyDomain: "www.shop.example",
    domains: [sameSiteDomain],
    thirdPartyRequests: 0,
    thirdPartyDomains: 0,
    fingerprintDetections: [makeInputMonitoringDetection(["https://verified.shop.example"])]
  });

  const headline = buildReportHeadline(viewFromV1Report(result));
  assert.doesNotMatch(headline.headline, /probed your browser/);
  assert.doesNotMatch(headline.subhead, /keyboard input/);
  assert.equal(headline.tone, "calm");
});

test("cross-site input monitoring keeps the probe headline with listener wording", () => {
  const result = makeResult({
    firstPartyDomain: "www.shop.example",
    domains: [],
    thirdPartyRequests: 0,
    thirdPartyDomains: 0,
    fingerprintDetections: [makeInputMonitoringDetection(["https://recorder.example.net"])]
  });

  const headline = buildReportHeadline(viewFromV1Report(result));
  assert.match(headline.headline, /probed your browser/);
  // The evidence is listener registration, not observed capture, so the
  // wording must not say the script "watched" input.
  assert.match(headline.subhead, /registered listeners on keyboard input/);
  assert.doesNotMatch(headline.subhead, /watched/);
});

test("surfaces browser probing when fingerprinting matches without catalogued trackers", () => {
  const result = makeResult({
    firstPartyDomain: "fp.example",
    domains: [],
    thirdPartyRequests: 0,
    thirdPartyDomains: 0,
    fingerprintDetections: [makeCanvasDetection()]
  });

  const headline = buildReportHeadline(viewFromV1Report(result));
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

  const headline = buildReportHeadline(viewFromV1Report(result));
  assert.match(headline.shareText, /shared this visit with 1 tracking company/);
  assert.match(headline.shareText, /Open-source and reproducible:/);
});

test("a hashed keystroke leak leads the headline with alarm", () => {
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
        // A one-way hash (not a reversible base64/hex) is the deliberate-capture signal.
        evidence: { recipients: ["collect.tracker.example"], encodings: ["sha256"], fieldsTyped: 1, fieldTypes: ["email"] }
      }
    ]
  });

  const headline = buildReportHeadline(viewFromV1Report(result));
  // Confirmed input capture outranks the named-platform (Google) story.
  assert.equal(headline.tone, "alarm");
  assert.match(headline.headline, /shop\.example sent a hashed copy of what you type to 1 third party\./);
  assert.match(headline.subhead, /collect\.tracker\.example/);
});

test("a reversible (base64) keystroke leak stays a warn, not an alarm", () => {
  // base64/hex are common transport encodings in legitimate APIs, so a reversible
  // leak reads as a third-party type-ahead, not covert capture.
  const result = makeResult({
    firstPartyDomain: "shop.example",
    fingerprintDetections: [
      {
        kind: "keystroke-exfiltration",
        heuristic: "input-sentinel-exfiltration-v1",
        count: 1,
        evidence: { recipients: ["collect.tracker.example"], encodings: ["base64"], fieldsTyped: 1, fieldTypes: ["search"] }
      }
    ]
  });

  const headline = buildReportHeadline(viewFromV1Report(result));
  assert.equal(headline.tone, "warn");
  assert.match(headline.headline, /shop\.example sends what you type to 1 third party as you type\./);
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

  const headline = buildReportHeadline(viewFromV1Report(result));
  assert.equal(headline.tone, "warn");
  assert.match(headline.headline, /weather\.gov sends what you type to 1 third party as you type\./);
  assert.match(headline.subhead, /geocode\.arcgis\.com/);
});

test("a pixel with populated identifier fields leads over the named-platform story", () => {
  const result = makeResult({
    firstPartyDomain: "shop.example",
    domains: [makeTrackerDomain("facebook.net", 4, "Meta", "social / advertising pixel")],
    thirdPartyRequests: 4,
    thirdPartyDomains: 1,
    pixelEvents: [
      { platform: "Meta", product: "Meta Pixel", events: ["Purchase"], advancedMatching: ["email", "phone"], requests: 2 }
    ]
  });

  const headline = buildReportHeadline(viewFromV1Report(result));
  assert.equal(headline.tone, "warn");
  // Field POPULATION is what the detector proves; the values are never read,
  // so the copy must not assert personal identifiers were sent, must not call
  // the values hashed, and must not assert matching succeeded.
  assert.match(headline.headline, /shop\.example sent data in personal-identifier fields to Meta Pixel\./);
  assert.doesNotMatch(headline.headline, /sent personal identifiers to/);
  assert.match(headline.subhead, /personal-identifier fields \(email and phone\)/);
  assert.match(headline.subhead, /never their values/);
  assert.doesNotMatch(headline.subhead, /hashed/);
});

test("an event-only pixel does not trigger the identifier headline", () => {
  const result = makeResult({
    firstPartyDomain: "shop.example",
    domains: [makeTrackerDomain("facebook.net", 4, "Meta", "social / advertising pixel")],
    thirdPartyRequests: 4,
    thirdPartyDomains: 1,
    pixelEvents: [{ platform: "Meta", product: "Meta Pixel", events: ["PageView"], advancedMatching: [], requests: 1 }]
  });

  const headline = buildReportHeadline(viewFromV1Report(result));
  // No advanced matching, so it falls through to the named-platform line.
  assert.match(headline.headline, /shop\.example told Meta you were here\./);
});

test("trackers surviving a real Reject all click lead the consent-comparison headline", () => {
  const acceptRun = {
    ...makeResult({
      firstPartyDomain: "shop.example",
      domains: [
        makeTrackerDomain("google-analytics.com", 8, "Google", "analytics"),
        makeTrackerDomain("facebook.net", 4, "Meta", "social / advertising pixel")
      ],
      thirdPartyRequests: 25
    }),
    consentInteraction: { mode: "accept-all" as const, clicked: true, cmp: "OneTrust" }
  };
  const rejectRun = {
    ...makeResult({
      firstPartyDomain: "shop.example",
      domains: [makeTrackerDomain("google-analytics.com", 3, "Google", "analytics")],
      thirdPartyRequests: 6
    }),
    consentInteraction: { mode: "reject-all" as const, clicked: true, cmp: "OneTrust" }
  };

  const headline = buildReportHeadline(viewFromV1Report(consentPair(acceptRun, rejectRun)));
  assert.equal(headline.tone, "warn");
  assert.match(headline.headline, /shop\.example still reached 1 tracking company in the visit that clicked Reject all\./);
  assert.match(headline.subhead, /Google/);
  // The recording covers the full visit and the click is never verified, so
  // no sentence may sequence the traffic relative to the click.
  assert.match(headline.subhead, /In the visit where the scanner clicked Reject all/);
  assert.match(headline.subhead, /before and after the click/);
  assert.match(headline.subhead, /never verified/);
  assert.doesNotMatch(headline.subhead, /After the scanner clicked/);
});

test("a clean reject run headlines that the consent choice made a difference", () => {
  const acceptRun = {
    ...makeResult({
      firstPartyDomain: "shop.example",
      domains: [makeTrackerDomain("google-analytics.com", 8, "Google", "analytics")],
      thirdPartyRequests: 20
    }),
    consentInteraction: { mode: "accept-all" as const, clicked: true, cmp: "Cookiebot" }
  };
  const rejectRun = {
    ...makeResult({ firstPartyDomain: "shop.example", thirdPartyRequests: 1 }),
    consentInteraction: { mode: "reject-all" as const, clicked: true, cmp: "Cookiebot" }
  };

  const headline = buildReportHeadline(viewFromV1Report(consentPair(acceptRun, rejectRun)));
  assert.equal(headline.tone, "info");
  // The scanner cannot verify the site registered the click, so the headline
  // describes the Reject-all visit, never an effect the rejection caused.
  assert.match(headline.headline, /shop\.example loaded no catalogued trackers in the visit that clicked Reject all\./);
  assert.doesNotMatch(headline.headline, /Rejecting|removed/);
});

test("an un-clicked reject run falls through to the ordinary evidence headline", () => {
  const acceptRun = {
    ...makeResult({
      firstPartyDomain: "shop.example",
      domains: [makeTrackerDomain("google-analytics.com", 8, "Google", "analytics")],
      thirdPartyRequests: 20
    }),
    consentInteraction: { mode: "accept-all" as const, clicked: true, cmp: "OneTrust" }
  };
  const rejectRun = {
    ...makeResult({ firstPartyDomain: "shop.example", thirdPartyRequests: 18 }),
    consentInteraction: { mode: "reject-all" as const, clicked: false }
  };

  const headline = buildReportHeadline(viewFromV1Report(consentPair(acceptRun, rejectRun)));
  // No Reject all claim is allowed when the click never happened; the report
  // leads with the ordinary evidence story instead.
  assert.equal(/Reject all/.test(headline.headline), false);
  assert.match(headline.headline, /shop\.example told Google you were here\./);
});

test("an HTTP error load is framed as a failed load, not as relatively private", () => {
  const result = makeResult({ firstPartyDomain: "blocked.example", status: 403, totalRequests: 1 });

  const headline = buildReportHeadline(viewFromV1Report(result));
  assert.equal(headline.tone, "info");
  assert.match(headline.headline, /blocked\.example returned an error, so there was little to scan\./);
  assert.match(headline.subhead, /HTTP 403/);
  assert.doesNotMatch(headline.headline, /relatively private/);
  assert.equal(headline.stats[0]?.value, "403");
});

test("a server-error load with zero requests does not read as private", () => {
  const result = makeResult({ firstPartyDomain: "down.example", status: 503, totalRequests: 0 });

  const headline = buildReportHeadline(viewFromV1Report(result));
  assert.equal(headline.tone, "info");
  assert.match(headline.subhead, /HTTP 503/);
  assert.doesNotMatch(headline.headline, /relatively private/);
});

test("a null status (e.g. PageGraph import) is not treated as a failed load", () => {
  const result = makeResult({ firstPartyDomain: "quiet.example", status: null });

  const headline = buildReportHeadline(viewFromV1Report(result));
  assert.equal(headline.tone, "calm");
  assert.match(headline.headline, /quiet\.example kept this visit relatively private\./);
});

test("a request-capped quiet visit is framed as cut short, never as relatively private", () => {
  // 1,200 recorded requests trips the cap rule; with no catalogued trackers
  // the old calm story would have read truncation as privacy.
  const result = makeResult({ firstPartyDomain: "quiet.example", totalRequests: 1200 });

  const headline = buildReportHeadline(viewFromV1Report(result));
  assert.equal(headline.tone, "info");
  assert.match(headline.headline, /quiet\.example's scan was cut short, so low counts are not the full story\./);
  assert.match(headline.subhead, /request-recording cap/);
  assert.match(headline.subhead, /floors for this visit/);
  // Cookie/storage figures are snapshots of an interrupted visit, not floors.
  assert.match(headline.subhead, /snapshots of an interrupted visit/);
  assert.doesNotMatch(headline.headline, /relatively private/);
});

test("caveat counts one visit on single reports and two on comparisons", () => {
  const single = buildReportHeadline(viewFromV1Report(makeResult({ firstPartyDomain: "solo.example" })));
  assert.match(single.caveat, /one automated visit/);

  const comparison = buildReportHeadline(viewFromV1Report(gpcPair(makeResult({ firstPartyDomain: "pair.example" }), makeResult({ firstPartyDomain: "pair.example" }))));
  assert.match(comparison.caveat, /two automated visits/);
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

function makeInputMonitoringDetection(thirdPartyOrigins: string[]): FingerprintDetectionSummary {
  return {
    kind: "input-monitoring",
    heuristic: "input-listener-coverage-v1",
    count: 1,
    evidence: {
      eventTypes: ["input", "keydown"],
      listenerTargets: ["input"],
      thirdPartyOrigins,
      totalListenerCalls: 4
    }
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

test("a tampered wire diff cannot drive the headline; numbers derive from the two arms", () => {
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
  const report = shieldsPair(baseline, variant);
  // An uploaded report can carry any diff block it likes; the headline must
  // quote the arms' recorded counts, never the wire's precomputed claim.
  report.diff.thirdPartyRequests = { before: 9999, after: 9998, delta: -1 };
  report.diff.totalRequests = { before: 12345, after: 12345, delta: 0 };

  const headline = buildReportHeadline(viewFromV1Report(report));
  assert.match(headline.headline, /heavy\.example loaded 55 fewer third-party requests with Brave-list blocking on\./);
  assert.match(headline.subhead, /made 100 requests/);
});

// Axis-valid pair builders: the eligibility gate now verifies the DECLARED
// experiment actually happened (GPC off->on, an unblocked baseline vs a
// blocking variant, accept-all vs reject-all), so test pairs must vary their
// axis the way real producer runs do.
function gpcPair(baseline: ScanResult, variant: ScanResult) {
  baseline.conditions = { ...baseline.conditions, gpcEnabled: false };
  variant.conditions = { ...variant.conditions, gpcEnabled: true };
  return createGpcComparisonReport(baseline, variant);
}

function shieldsPair(baseline: ScanResult, variant: ScanResult) {
  const adblock = { active: true, source: "brave", lists: 3, fetchedAt: "2026-01-01T00:00:00.000Z" };
  baseline.conditions = { ...baseline.conditions, shieldsMode: "classification" as const, adblock: { ...adblock } };
  variant.conditions = { ...variant.conditions, shieldsMode: "block-simulation" as const, adblock: { ...adblock } };
  return createShieldsComparisonReport(baseline, variant);
}

function consentPair(accept: ScanResult, reject: ScanResult) {
  accept.conditions = { ...accept.conditions, consentMode: "accept-all" as const };
  reject.conditions = { ...reject.conditions, consentMode: "reject-all" as const };
  return createConsentComparisonReport(accept, reject);
}

test("platforms whose requests all went unanswered get attempt wording, not receipt wording", () => {
  // A request record is created at dispatch; statuses: [] means no response
  // was ever observed, so "told X you were here" would overclaim receipt.
  const result = makeResult({
    firstPartyDomain: "shop.example",
    domains: [
      { ...makeTrackerDomain("google-analytics.com", 6, "Google", "analytics / advertising"), statuses: [] },
      { ...makeTrackerDomain("facebook.net", 4, "Meta", "social / advertising pixel"), statuses: [] }
    ],
    thirdPartyRequests: 10,
    thirdPartyDomains: 2
  });

  const headline = buildReportHeadline(viewFromV1Report(result));
  assert.match(headline.headline, /shop\.example tried to tell Google and Meta you were here\./);
  assert.match(headline.subhead, /receipt is unproven/);
});

test("a mixed answered/unanswered platform set names only the answered platforms as told", () => {
  const result = makeResult({
    firstPartyDomain: "shop.example",
    domains: [
      makeTrackerDomain("google-analytics.com", 6, "Google", "analytics / advertising"),
      { ...makeTrackerDomain("facebook.net", 4, "Meta", "social / advertising pixel"), statuses: [] }
    ],
    thirdPartyRequests: 10,
    thirdPartyDomains: 2
  });

  const headline = buildReportHeadline(viewFromV1Report(result));
  assert.match(headline.headline, /shop\.example told Google you were here\./);
  assert.doesNotMatch(headline.headline, /Meta/);
  assert.match(headline.subhead, /1 answered; the rest recorded no response/);
});

test("unanswered tracking companies get sent-not-shared wording", () => {
  const result = makeResult({
    firstPartyDomain: "shop.example",
    domains: [
      { ...makeTrackerDomain("quiet-tracker.example", 3, "Quiet Analytics", "analytics"), statuses: [] }
    ],
    thirdPartyRequests: 3,
    thirdPartyDomains: 1
  });

  const headline = buildReportHeadline(viewFromV1Report(result));
  assert.match(headline.headline, /shop\.example sent this visit to 1 tracking company\./);
  assert.match(headline.subhead, /recorded no response, so receipt is unproven/);
});
