import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PAGE_SUBJECT_CAPTURE_LOSS_DETAIL,
  PAGE_SUBJECT_UNVERIFIED_WARNING,
  SUSPECTED_CHALLENGE_OR_SOFT_BLOCK_WARNING
} from "./bot-wall-classifier";
import { createConsentComparisonReport, createGpcComparisonReport, createShieldsComparisonReport } from "./compare-reports";
import { GPC_WORKER_CAPTURE_LOSS_WARNING } from "./gpc-injection";
import { displayableScreenshot } from "./report-insights";
import { buildReportHeadline, reportPageTitle } from "./report-headline";
import { INVALID_UPSTREAM_RESPONSE_WARNING } from "./scan-runtime";
import { evaluateQuality } from "./scan-report-v2-evaluators";
import { R2_NAVIGATION_STATUS_UNREPRESENTABLE } from "./scan-report-v2-http-status";
import { makeConsentInterventionReportV2R2, makePublicSingleReportV2R2 } from "./scan-report-v2-r2-fixtures";
import { viewFromV1Report, viewFromV2 } from "./scan-report-views";
import {
  SCAN_REPORT_SCHEMA_VERSION,
  type DomainSummary,
  type FingerprintDetectionSummary,
  type NetworkRequestRecord,
  type PixelEventSummary,
  type ScanResult
} from "./types";

test("a censored run's Shields subhead states the evaluated denominator exactly", () => {
  // Latent-branch guard: no committed report currently reaches the Shields
  // headline, so only a synthetic wire pins this copy. The numerator is
  // recounted from retained request rows and keeps the censoring hedge; the
  // evaluated count is the engine's own route-time counter, which
  // request-capture censoring cannot truncate, so it must never render as a
  // "retained" floor. The fixture's raw digits (2416) and the expected
  // literal ("2,416") differ by construction, and the retained total (3000)
  // differs from both counts.
  const wire = makePublicSingleReportV2R2();
  wire.run.verificationFacts = {
    shields: {
      method: "shields-engine-status@1",
      engineLoaded: true,
      applied: false,
      requestsEvaluated: 2416,
      requestsMatched: 1204,
      requestsActuallyBlocked: 0,
      phaseId: 0
    }
  };
  wire.run.summary = {
    ...wire.run.summary,
    counts: { ...wire.run.summary.counts, totalRequests: 3000, shieldsBlockedRequests: 1204 }
  };
  const view = viewFromV2(wire, 2);
  const run = view.runs[0];
  run.quality.byFamily = {
    ...(run.quality.byFamily ?? {}),
    requests: { outcome: "censored", reasons: ["budget-exhausted:public-request-records"] }
  };
  const headline = buildReportHeadline(view);
  assert.match(
    headline.subhead,
    /at least 1,204 retained requests matched while loading normally, out of 2,416 requests the engine evaluated\./,
    "the numerator keeps its retained-floor hedge and the denominator stays exact"
  );
  assert.doesNotMatch(
    headline.subhead,
    /retained (?:before request capture stopped )?requests the engine evaluated|(?:at least |≥)2,416/,
    "the evaluated denominator must never inherit the capture-loss hedge"
  );
});

test("only inline data-URI screenshots are displayable; uploaded URLs never render", () => {
  const png =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  assert.equal(displayableScreenshot(png), png);
  assert.equal(displayableScreenshot("data:image/jpeg;base64,AAAA"), null);
  assert.equal(displayableScreenshot("data:image/png;base64,iVBORw0KGgo="), null);
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
  assert.match(headline.headline, /shop\.example contacted catalogued Google and Meta domains during this visit\./);
  assert.equal(headline.stats[0].value, "2");
});

test("headlines name the stable site instead of a redacted subdomain marker", () => {
  const result = makeResult({ firstPartyDomain: "www.{label}.clevelandclinic.org" });
  const headline = buildReportHeadline(viewFromV1Report(result));
  assert.equal(headline.domain, "clevelandclinic.org");
  assert.equal(headline.headline.includes("{label}"), false);
});

test("same-organization infrastructure is not headlined as an outside recipient", () => {
  const result = makeResult({
    firstPartyDomain: "youtube.com",
    domains: [makeTrackerDomain("stats.g.doubleclick.net", 4, "Google", "advertising")],
    thirdPartyRequests: 4,
    thirdPartyDomains: 1
  });

  const headline = buildReportHeadline(viewFromV1Report(result));
  assert.match(headline.headline, /youtube\.com contacted catalogued services on separate Google domains/);
  assert.match(headline.subhead, /not evidence of disclosure to an outside company/);
  assert.doesNotMatch(headline.headline, /told Google|shared this visit|outside company/);
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
  assert.match(headline.headline, /news\.example contacted catalogued Google, Meta and TikTok, \+1 more domains during this visit\./);
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
  assert.match(headline.headline, /store\.example contacted 2 distinct catalogued tracking-related services during this visit\./);
  // Hotjar is catalogued as session replay; the copy must keep the domain match
  // separate from a claim that recording actually happened.
  assert.match(headline.subhead, /catalogued session-replay service appeared/);
  assert.doesNotMatch(headline.subhead, /can record how you move/);
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
  assert.equal(headline.tone, "info");
  assert.match(headline.headline, /app\.example contacted 2 cross-site hosts/);
});

test("an unclassified major-platform service is identified but never promoted to a tracking headline", () => {
  const result = makeResult({
    firstPartyDomain: "app.example",
    domains: [makeTrackerDomain("experiment.example", 3, "Google", "experimentation")],
    thirdPartyRequests: 3,
    thirdPartyDomains: 1
  });

  const headline = buildReportHeadline(viewFromV1Report(result));
  assert.equal(headline.tone, "info");
  assert.match(headline.headline, /app\.example contacted 1 cross-site host/);
  assert.doesNotMatch(`${headline.headline} ${headline.subhead}`, /catalogued Google|tracking-related service/);
});

test("a historical nontracking CNAME alias prevents a reassuring absence headline", () => {
  const result = makeResult({ firstPartyDomain: "app.example" });
  result.cnameCloaks = [
    {
      host: "errors.app.example",
      cname: "ingest.sentry.io",
      tracker: {
        domain: "sentry.io",
        entity: "Sentry",
        category: "error monitoring",
        confidence: "curated"
      }
    }
  ];

  const headline = buildReportHeadline(viewFromV1Report(result));
  assert.equal(headline.tone, "info");
  assert.equal(headline.semantic.reassuring, false);
  assert.match(headline.headline, /produced evidence that needs context/);
  assert.doesNotMatch(`${headline.headline} ${headline.subhead}`, /few catalogued|No cross-site hosts/);
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
  // V1 records configuration but no readback, so the headline must not claim
  // that the signal was verified as received or applied.
  assert.match(headline.headline, /amazon\.com still contacted 1 distinct catalogued tracking-related service with a privacy signal configured\./);
  assert.match(headline.subhead, /do not sell or share/);
  assert.match(headline.subhead, /versus 420 without the signal/);
  // The lead finding quotes the GPC-on visit's numbers, so the evidence
  // switcher must open on that arm.
  assert.equal(headline.focusArm, "variant");
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
  assert.match(headline.subhead, /110 third-party requests, versus 100 without the signal/);
  assert.doesNotMatch(headline.subhead, /down just/);
  assert.doesNotMatch(headline.subhead, /-\d/);
});

test("a GPC pair that did not move says so, instead of claiming a difference", () => {
  // This family fires when the signal did NOT reduce anything, so equal counts
  // are squarely in scope. cdc.gov published "An observed difference for this
  // pair of visits" over 4 versus 4: a hedge that asserts the very thing the
  // numbers deny. The limitation must survive in both branches, because a
  // request count cannot show whether a sale stopped either way.
  const same = () =>
    makeResult({
      firstPartyDomain: "www.shop.example",
      domains: [makeTrackerDomain("ads.example", 4, "AdCo", "advertising")],
      thirdPartyRequests: 4,
      thirdPartyDomains: 1
    });

  const headline = buildReportHeadline(viewFromV1Report(gpcPair(same(), same())));
  assert.match(headline.subhead, /4 third-party requests, versus 4 without the signal/);
  assert.match(headline.subhead, /No difference between this pair of visits/);
  assert.doesNotMatch(
    headline.subhead,
    /An observed difference/,
    "equal counts must not be described as a difference"
  );
  assert.match(
    headline.subhead,
    /request counts cannot show whether data sales stopped/,
    "the limitation is the half that must survive in both branches"
  );
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
  assert.match(headline.headline, /Off-site requests to respectful\.example were 100% lower in the visit configured with a privacy signal\./);
  assert.match(headline.subhead, /not proof the site honors or received the signal/);
});

test("a large GPC reduction over a still-loud pair is not reassuring", () => {
  // Regression: theguardian.com went 641 -> 160 third-party requests with GPC,
  // which cleared the >=50% branch and rendered a CALM (semantic.reassuring)
  // headline directly above 20 catalogued tracking entities and 158 third-party
  // cookie records. report-consistency calls that "quiet-copy-over-loud-finding"
  // and nothing enforces the rule at render time, so the tone itself must not
  // reassure while either arm carries a review-worthy signal of its own.
  const baseline = makeResult({
    firstPartyDomain: "heavy.example",
    domains: [makeTrackerDomain("ads.example", 400, "AdCo", "advertising")],
    thirdPartyRequests: 400,
    thirdPartyDomains: 40,
    thirdPartyCookies: 30
  });
  const variant = makeResult({
    firstPartyDomain: "heavy.example",
    domains: [makeTrackerDomain("ads.example", 100, "AdCo", "advertising")],
    thirdPartyRequests: 100,
    thirdPartyDomains: 32,
    thirdPartyCookies: 25
  });

  const headline = buildReportHeadline(viewFromV1Report(gpcPair(baseline, variant)));
  // The measured reduction is still reported; only the reassurance is withheld.
  assert.match(headline.headline, /were 75% lower in the visit configured with a privacy signal\./);
  assert.equal(headline.tone, "info");
  assert.equal(headline.semantic.reassuring, false);
  assert.match(headline.subhead, /Both visits still recorded review-worthy activity of their own/);
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
  // Asserted on the HEADLINE, which is where the service count now lives: the
  // subhead stopped restating it so the claim would fit the 300-character card
  // bound. Pointing the negative assertion at the subhead too would have left a
  // pattern that can no longer appear there, i.e. a guard that passes because
  // it cannot fail.
  assert.match(headline.headline, /still contacted 1 distinct catalogued tracking-related service\b/);
  assert.doesNotMatch(headline.headline, /3 distinct catalogued tracking-related services/);
  // The stat chips and share text sit next to the sentence, so they must quote
  // the same GPC-on visit, not the baseline's three companies.
  assert.equal(headline.stats.find((stat) => stat.label.includes("tracking-service"))?.value, "1");
  assert.match(headline.shareText, /1 tracking-service entity/);
  assert.doesNotMatch(headline.shareText, /3 tracking-service entities/);
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
  assert.match(headline.headline, /heavy\.example recorded 55 fewer third-party requests in the visit configured for Brave-list blocking\./);
  assert.doesNotMatch(headline.headline, /would/);
  // Pair-framed with lead-run stat chips: the switcher default stays on the
  // lead (baseline) run, so no focus arm is declared.
  assert.equal(headline.focusArm, undefined);
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

test("request capture loss cannot produce a comparative GPC headline", () => {
  const captureLossWarnings = [
    GPC_WORKER_CAPTURE_LOSS_WARNING,
    INVALID_UPSTREAM_RESPONSE_WARNING,
    "The scan stopped opening additional proxy requests after reaching its connection and target safety budget."
  ];

  for (const warning of captureLossWarnings) {
    const baseline = makeResult({
      firstPartyDomain: "shop.example",
      domains: [makeTrackerDomain("ads.example", 100, "AdCo", "advertising")],
      thirdPartyRequests: 100,
      thirdPartyDomains: 10
    });
    const incompleteVariant = makeResult({
      firstPartyDomain: "shop.example",
      thirdPartyRequests: 0,
      thirdPartyDomains: 0
    });
    incompleteVariant.warnings = [warning];

    const headline = buildReportHeadline(viewFromV1Report(gpcPair(baseline, incompleteVariant)));
    assert.doesNotMatch(headline.headline, /privacy signal/, warning);
    assert.doesNotMatch(headline.subhead, /100% lower|100 → 0|versus 100 without the signal/, warning);
    assert.equal(headline.focusArm, undefined, warning);
  }
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
  assert.doesNotMatch(headline.headline, /fingerprint-like browser API patterns/);
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
  assert.match(headline.headline, /matched an interaction-monitoring signal involving a cross-site script/);
  assert.equal(headline.semantic.story, "listener-coverage");
  // The evidence is listener registration, not observed capture, so the
  // wording must not say the script "watched" input.
  assert.match(headline.subhead, /[Ll]isteners that could observe typing-related input were registered/);
  assert.doesNotMatch(headline.headline, /fingerprint-like browser API/);
  assert.doesNotMatch(headline.subhead, /watched/);
  // Chain attribution only: a first-party registrant delegating through a
  // third-party helper produces identical wire evidence, so the copy must not
  // say the cross-site script registered the listeners.
  assert.doesNotMatch(`${headline.headline} ${headline.subhead}`, /(cross-site|third-party) script registered/i);
  assert.match(headline.subhead, /call chain that included a cross-site script/);
});

test("the secondary extras clause states chain attribution through the real builder", () => {
  // The extras clause is a different compiled string from the listener-coverage
  // primary subhead, so a revert of that one push() to the old accusative copy
  // ("a cross-site script registered listeners on keyboard input") is invisible
  // to every guard that only exercises the primary branch or hand-inlines the
  // expected sentence. Drive the branch itself: a catalogued-tracker story wins
  // the headline, and the input-monitoring signal must surface as the appended
  // "It also looks like ..." clause with chain wording.
  const result = makeResult({
    firstPartyDomain: "www.shop.example",
    domains: [makeTrackerDomain("google-analytics.com", 6, "Google", "analytics")],
    thirdPartyRequests: 6,
    thirdPartyDomains: 1,
    fingerprintDetections: [makeInputMonitoringDetection(["https://recorder.example.net"])]
  });

  const headline = buildReportHeadline(viewFromV1Report(result));
  assert.notEqual(headline.semantic.story, "listener-coverage");
  const secondary = headline.subhead.slice(headline.subheadPrimaryClaim.length);
  // The clause must exist (an empty slice means the fixture stopped triggering
  // the branch and every assertion below would pass vacuously).
  assert.match(secondary, /^ It also looks like /);
  assert.match(
    secondary,
    /keyboard-input listeners were registered through a call chain that included a cross-site script/
  );
  // Chain attribution only: never the accusative registrant claim.
  assert.doesNotMatch(secondary, /(cross-site|third-party) script registered/i);
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
  assert.match(headline.headline, /fp\.example triggered fingerprint-like browser API patterns\./);
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
  assert.match(headline.shareText, /contacted 1 distinct catalogued tracking-related service/);
  assert.match(headline.shareText, /Open-source and reproducible:/);
  // A prefilled post is the one surface where the headline travels ALONE, to
  // readers who never open the report. It shipped the claim without the
  // qualification the page always renders beside it.
  assert.ok(
    headline.shareText.includes(headline.caveat),
    `share text must carry its caveat; got: ${headline.shareText}`
  );
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
  assert.match(headline.headline, /shop\.example sent a hashed form of synthetic input to 1 cross-site domain before submission\./);
  assert.match(headline.subhead, /collect\.tracker\.example/);
  assert.match(headline.subhead, /does not establish whether transmission happened during typing, blur, or unload/);
  assert.doesNotMatch(headline.subhead, /known identity/);
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
  assert.match(headline.headline, /shop\.example sent synthetic form input to 1 cross-site domain before submission\./);
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
  assert.match(headline.headline, /weather\.gov sent synthetic form input to 1 cross-site domain before submission\./);
  assert.match(headline.subhead, /geocode\.arcgis\.com/);
});

test("privacy-generalized recipient hosts render as wildcards in headline prose", () => {
  const result = makeResult({
    firstPartyDomain: "weather.gov",
    fingerprintDetections: [
      {
        kind: "keystroke-exfiltration",
        heuristic: "input-sentinel-exfiltration-v1",
        count: 1,
        evidence: { recipients: ["{label}.arcgis.com"], encodings: ["plain"], fieldsTyped: 1, fieldTypes: ["search"] }
      }
    ]
  });

  const headline = buildReportHeadline(viewFromV1Report(result));
  assert.match(headline.subhead, /\*\.arcgis\.com/);
  assert.equal(headline.subhead.includes("{label}"), false);
});

test("same-organization synthetic-input recipients retain the boundary fact without an outside-company claim", () => {
  const result = makeResult({
    firstPartyDomain: "x.com",
    fingerprintDetections: [
      {
        kind: "keystroke-exfiltration",
        heuristic: "input-sentinel-exfiltration-v1",
        count: 1,
        evidence: { recipients: ["api.twimg.com"], encodings: ["plain"], fieldsTyped: 1, fieldTypes: ["search"] }
      }
    ]
  });

  const headline = buildReportHeadline(viewFromV1Report(result));
  assert.match(headline.headline, /1 cross-site domain/);
  assert.match(headline.subhead, /same reviewed organization/);
  assert.match(headline.subhead, /not disclosure to an outside company/);
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
  assert.match(headline.subhead, /platform designates for personal identifiers \(email and phone\)/);
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
  assert.match(headline.headline, /shop\.example contacted catalogued Meta domains during this visit\./);
});

test("an unverified legacy consent pair falls through to the raw evidence headline", () => {
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
  assert.match(headline.headline, /shop\.example contacted catalogued Google and Meta domains during this visit\./);
  assert.doesNotMatch(`${headline.headline} ${headline.subhead}`, /Reject all|Accept all|after the click/);
  assert.equal(headline.focusArm, undefined);
});

test("an unverified legacy consent pair keeps unanswered traffic in raw send-only wording", () => {
  const quietTracker = {
    ...makeTrackerDomain("quiet-tracker.example", 2, "Quiet Analytics", "analytics"),
    statuses: []
  };
  const acceptRun = {
    ...makeResult({ firstPartyDomain: "shop.example", domains: [quietTracker], thirdPartyRequests: 2 }),
    consentInteraction: { mode: "accept-all" as const, clicked: true, cmp: "OneTrust" }
  };
  const rejectRun = {
    ...makeResult({ firstPartyDomain: "shop.example", domains: [quietTracker], thirdPartyRequests: 2 }),
    consentInteraction: { mode: "reject-all" as const, clicked: true, cmp: "OneTrust" }
  };

  const headline = buildReportHeadline(viewFromV1Report(consentPair(acceptRun, rejectRun)));
  assert.match(headline.headline, /contacted 1 distinct catalogued tracking-related service/);
  assert.match(headline.subhead, /had requests dispatched with no recorded response/);
  assert.doesNotMatch(`${headline.headline} ${headline.subhead}`, /received requests|still reached|Reject all|Accept all/);
});

test("a verified r2 consent headline states registration without dropping whole-visit caveats", () => {
  const view = viewFromV2(makeConsentInterventionReportV2R2(), 2);
  const variant = view.runs.find((run) => run.label === "variant");
  if (!variant) throw new Error("fixture invariant");
  const google = makeTrackerDomain(
    "google-analytics.com",
    3,
    "Google",
    "analytics"
  );
  variant.evidence.domains = [google];
  variant.evidence.requests = Array.from(
    { length: 3 },
    (_, index): NetworkRequestRecord => ({
      id: index + 1,
      url: `https://google-analytics.com/request-${index + 1}`,
      domain: google.domain,
      method: "GET",
      resourceType: "script",
      status: 204,
      thirdParty: true,
      tracker: google.tracker,
      startedAtMs: index + 1
    })
  );
  variant.counts.knownTrackerRequests = 3;
  variant.counts.thirdPartyRequests = 3;
  variant.counts.thirdPartyDomains = 1;

  const headline = buildReportHeadline(view);
  assert.match(headline.subhead, /verified that the site registered Reject all/);
  assert.match(headline.subhead, /again after one page reload/);
  assert.match(headline.subhead, /pre-choice traffic/);
  assert.match(headline.subhead, /strictly necessary/);
  assert.match(headline.subhead, /legitimate interest/);
  assert.doesNotMatch(headline.subhead, /never verified|cannot verify/);
});

test("v2 dispatch alone cannot drive a Reject-all headline", () => {
  const view = viewFromV2(makeConsentInterventionReportV2R2(), 2);
  const variant = view.runs.find((run) => run.label === "variant");
  if (!variant?.consent) throw new Error("fixture invariant");
  variant.consent.choiceState = "unavailable";
  variant.consent.bannerTransition = null;

  const headline = buildReportHeadline(view);
  assert.doesNotMatch(headline.headline, /clicked Reject all/);
  assert.doesNotMatch(headline.subhead, /visit that clicked Reject all/);
});

test("a contradicted registered consent state cannot fall through to a calm headline", () => {
  const view = viewFromV2(makeConsentInterventionReportV2R2(), 2);
  const variant = view.runs.find((run) => run.label === "variant");
  if (!variant?.consent) throw new Error("fixture invariant");
  variant.consent.choiceState = "contradicted";

  const headline = buildReportHeadline(view);
  assert.equal(headline.tone, "warn");
  assert.match(headline.headline, /registered consent state contradicted the Reject all click/);
  assert.match(headline.subhead, /does not support an accept-versus-reject outcome/);
  assert.equal(headline.focusArm, "variant");
  assert.doesNotMatch(headline.headline, /relatively private/);
});

test("a no-click consent contradiction names the requested choice without inventing dispatch", () => {
  const view = viewFromV2(makeConsentInterventionReportV2R2(), 2);
  const variant = view.runs.find((run) => run.label === "variant");
  if (!variant?.consent) throw new Error("fixture invariant");
  variant.consent.controlActivated = false;
  variant.consent.choiceState = "contradicted";

  const headline = buildReportHeadline(view);
  assert.equal(headline.tone, "warn");
  assert.match(headline.headline, /inconsistent with the requested Reject all choice/);
  assert.match(headline.subhead, /did not activate the Reject all control/);
  assert.doesNotMatch(`${headline.headline} ${headline.subhead}`, /Reject all click|dispatched choice/);
  assert.doesNotMatch(headline.headline, /relatively private/);
});

test("a clean legacy reject attempt cannot drive a consent headline", () => {
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
  assert.equal(headline.tone, "warn");
  assert.match(headline.headline, /shop\.example contacted catalogued Google domains during this visit\./);
  assert.doesNotMatch(`${headline.headline} ${headline.subhead}`, /Reject all|Accept all|Rejecting|removed/);
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
  assert.match(headline.headline, /shop\.example contacted catalogued Google domains during this visit\./);
});

test("an HTTP error load is framed as a failed load, not as relatively private", () => {
  const result = makeResult({ firstPartyDomain: "blocked.example", status: 403, totalRequests: 1 });

  const headline = buildReportHeadline(viewFromV1Report(result));
  assert.equal(headline.tone, "info");
  assert.match(headline.headline, /blocked\.example returned HTTP 403 instead of a verified normal page load\./);
  assert.match(headline.subhead, /HTTP 403/);
  assert.match(headline.subhead, /returned error or block page/);
  assert.doesNotMatch(headline.headline, /little to scan/);
  assert.doesNotMatch(headline.headline, /relatively private/);
  // A 403 means the site answered and declined this visitor, so it is reachable.
  // Advising a retry "when it is reachable" sent readers into a loop against a
  // deterministic refusal.
  assert.doesNotMatch(headline.subhead, /when it is reachable/);
  assert.match(headline.subhead, /status alone cannot identify/);
  assert.doesNotMatch(headline.subhead, /automated visit.*caused|usually repeats/);
  assert.equal(headline.stats[0]?.value, "403");
});

test("subresource 401, 403, and 429 responses do not become a site-access failure", () => {
  for (const subresourceStatus of [401, 403, 429]) {
    const result = makeResult({
      firstPartyDomain: "shop.example",
      status: 200,
      domains: [
        {
          ...makeTrackerDomain("google-analytics.com", 1, "Google", "analytics"),
          statuses: [subresourceStatus]
        }
      ],
      thirdPartyRequests: 1,
      thirdPartyDomains: 1
    });

    const headline = buildReportHeadline(viewFromV1Report(result));
    assert.match(headline.headline, /contacted catalogued Google domains/, String(subresourceStatus));
    assert.doesNotMatch(
      `${headline.headline} ${headline.subhead}`,
      /refused this visit|returned an error|little to scan/,
      String(subresourceStatus)
    );
  }
});

test("an HTTP-200 suspected soft block cannot produce a calm or comparison headline", () => {
  const result = makeResult({ firstPartyDomain: "www.amazon.com", status: 200, totalRequests: 3 });
  result.warnings.push(SUSPECTED_CHALLENGE_OR_SOFT_BLOCK_WARNING);

  const view = viewFromV1Report(result);
  const headline = buildReportHeadline(view);
  assert.equal(view.runs[0].quality.outcome, "failed");
  assert.equal(headline.tone, "info");
  assert.match(headline.headline, /suspected challenge or soft block/);
  assert.match(headline.subhead, /robot check, CAPTCHA, or blocking consent interstitial/);
  assert.doesNotMatch(`${headline.headline} ${headline.subhead}`, /relatively private/);

  const baseline = makeResult({ firstPartyDomain: "www.amazon.com", totalRequests: 300 });
  const comparison = viewFromV1Report(gpcPair(baseline, result));
  assert.equal(comparison.claims.pairComparison?.allowed, false);
  assert.doesNotMatch(buildReportHeadline(comparison).headline, /with a privacy signal|fewer|more/);
});

test("the frozen r2 bot-wall fact renders the same suspected-soft-block state", () => {
  const report = makePublicSingleReportV2R2();
  report.run.qualityFacts.status = 200;
  report.run.summary.status = 200;
  report.run.qualityFacts.botWallTitleMatched = true;
  report.run.quality = evaluateQuality(report.run.qualityFacts, {
    observedRequests: report.run.evidence.requests.length
  });

  const headline = buildReportHeadline(viewFromV2(report, 2));
  assert.equal(report.run.quality.run.outcome, "failed");
  assert.match(headline.headline, /suspected challenge or soft block/);
  assert.doesNotMatch(`${headline.headline} ${headline.subhead}`, /relatively private/);
});

test("an unavailable subject collector prevents calm v1 and r2 headlines", () => {
  const legacy = makeResult({ firstPartyDomain: "unknown-subject.example", status: 200, totalRequests: 4 });
  legacy.warnings.push(PAGE_SUBJECT_UNVERIFIED_WARNING);
  const legacyView = viewFromV1Report(legacy);
  const legacyHeadline = buildReportHeadline(legacyView);
  assert.equal(legacyView.runs[0].quality.outcome, "failed");
  assert.match(legacyHeadline.headline, /could not be verified as the requested page/);
  assert.doesNotMatch(`${legacyHeadline.headline} ${legacyHeadline.subhead}`, /relatively private/);

  const report = makePublicSingleReportV2R2();
  report.run.qualityFacts.status = 200;
  report.run.summary.status = 200;
  report.run.qualityFacts.captureLoss.push({
    family: "detector-output",
    phaseId: null,
    kind: "dropped",
    count: 1,
    detail: PAGE_SUBJECT_CAPTURE_LOSS_DETAIL
  });
  report.run.warnings.push(PAGE_SUBJECT_UNVERIFIED_WARNING);
  report.run.quality = evaluateQuality(report.run.qualityFacts, {
    observedRequests: report.run.evidence.requests.length
  });
  const r2Headline = buildReportHeadline(viewFromV2(report, 2));
  assert.equal(report.run.quality.run.outcome, "failed");
  assert.deepEqual(report.run.quality.run.reasons, [
    `capture-loss:${PAGE_SUBJECT_CAPTURE_LOSS_DETAIL}`
  ]);
  assert.match(r2Headline.headline, /could not be verified as the requested page/);
  assert.doesNotMatch(`${r2Headline.headline} ${r2Headline.subhead}`, /relatively private/);
});

test("a server-error load with zero requests does not read as private", () => {
  const result = makeResult({ firstPartyDomain: "down.example", status: 503, totalRequests: 0 });

  const headline = buildReportHeadline(viewFromV1Report(result));
  assert.equal(headline.tone, "info");
  assert.match(headline.subhead, /HTTP 503/);
  assert.doesNotMatch(headline.subhead, /denied this visit/);
  assert.doesNotMatch(headline.headline, /relatively private/);
});

test("a failed r2 navigation with an unrepresentable status cannot produce a positive headline", () => {
  const report = makePublicSingleReportV2R2();
  report.run.qualityFacts.status = null;
  report.run.summary.status = null;
  report.run.qualityFacts.captureLoss.push({
    family: "requests",
    phaseId: null,
    kind: "dropped",
    count: 1,
    detail: R2_NAVIGATION_STATUS_UNREPRESENTABLE
  });
  report.run.quality = evaluateQuality(report.run.qualityFacts, { observedRequests: report.run.evidence.requests.length });

  const headline = buildReportHeadline(viewFromV2(report, 2));
  assert.equal(headline.tone, "info");
  assert.match(headline.headline, /main page did not complete a trustworthy load/);
  assert.match(headline.subhead, /outside this frozen report format's representable range/);
  // Same rule as the findings pin: no deliberate-withholding claim; the field
  // is empty because the wire cannot represent the code, nothing more.
  assert.match(headline.subhead, /status field is left empty rather than coerced/);
  assert.doesNotMatch(headline.subhead, /withheld/);
  assert.match(headline.subhead, /not a positive privacy result/);
  assert.doesNotMatch(`${headline.headline} ${headline.subhead}`, /relatively private|HTTP \d{3}/);
  assert.deepEqual(headline.stats, [{ label: "Navigation", value: "Failed", emphasis: true }]);
});

test("a null status (e.g. PageGraph import) is not treated as a failed load", () => {
  const result = makeResult({ firstPartyDomain: "quiet.example", status: null });

  const headline = buildReportHeadline(viewFromV1Report(result));
  assert.equal(headline.tone, "calm");
  assert.match(headline.headline, /quiet\.example showed few catalogued or fingerprint-like signals in this visit\./);
});

test("the calm absence claim qualifies cookies as third-party", () => {
  const result = makeResult({ firstPartyDomain: "quiet.example", cookies: 5, thirdPartyCookies: 0 });

  const headline = buildReportHeadline(viewFromV1Report(result));
  assert.equal(headline.tone, "calm");
  assert.match(headline.subhead, /third-party cookie records/);
  assert.doesNotMatch(headline.subhead, /tracking companies, cookies/);
});

test("raw fingerprint-observer events get an informational API story below the detector threshold", () => {
  const result = makeResult({ firstPartyDomain: "quiet.example", fingerprintEvents: 2 });

  const headline = buildReportHeadline(viewFromV1Report(result));
  assert.equal(headline.tone, "info");
  assert.equal(headline.semantic.story, "raw-fingerprint-events");
  assert.match(headline.subhead, /2 browser-API events/);
  assert.match(headline.subhead, /not proof of fingerprinting intent/);
  assert.doesNotMatch(headline.subhead, /no .*fingerprinting signal/i);
});

test("a partial fingerprint detector states retained API events as a lower bound", () => {
  const report = makePublicSingleReportV2R2();
  report.run.summary.counts.fingerprintEvents = 3;
  report.run.evidence.fingerprintEvents = [
    { api: "canvas.toDataURL", count: 3, phaseId: 0 }
  ];
  report.run.detectors["fingerprint-heuristics"] = {
    ...report.run.detectors["fingerprint-heuristics"],
    status: "partial",
    reason: "budget-unavailable"
  };

  const headline = buildReportHeadline(viewFromV2(report, 2));
  assert.equal(headline.semantic.story, "raw-fingerprint-events");
  assert.match(headline.subhead, /At least 3 retained browser-API events/);
  assert.match(headline.subhead, /incomplete instrumentation log/);
  assert.doesNotMatch(headline.subhead, /^3 browser-API events appeared/);
});

test("a request-capped quiet visit is framed as cut short, never as relatively private", () => {
  // 1,200 recorded requests trips the cap rule; with no catalogued trackers
  // the old calm story would have read truncation as privacy.
  const result = makeResult({ firstPartyDomain: "quiet.example", totalRequests: 1200 });

  const headline = buildReportHeadline(viewFromV1Report(result));
  assert.equal(headline.tone, "info");
  assert.match(headline.headline, /quiet\.example's scan did not finish every measurement\./);
  assert.match(headline.subhead, /request-recording cap/);
  assert.match(headline.subhead, /retained lower bounds for this visit/);
  // Cookie/storage figures are snapshots of an interrupted visit, not floors.
  assert.match(headline.subhead, /cookie and storage figures are incomplete end-state snapshots/);
  assert.doesNotMatch(headline.headline, /relatively private/);
});

test("a detector loss hedges the detectors, not the request and cookie counts", () => {
  // The real codeberg.org report: a non-profit that runs no third-party
  // requests and sets no third-party cookies, scanned cleanly, with only the
  // detector ledger cut short (detector-output, capture-loss:truncated).
  //
  // Reading ANY censored family as "the scan was cut short" told that visitor
  // their activity counts were floors and their cookie and storage figures
  // were "snapshots of an interrupted visit". All three were observed to
  // completion. It also made a genuinely quiet site impossible to report as
  // quiet, which is the outcome this scanner exists to be able to state.
  const report = makePublicSingleReportV2R2();
  const run = report.run;
  run.quality.byFamily["detector-output"] = { outcome: "censored", reasons: ["capture-loss:truncated"] };
  run.qualityFacts.captureLoss.push({
    family: "detector-output",
    phaseId: null,
    kind: "truncated",
    count: 1,
    detail: "policy-visit"
  });

  const headline = buildReportHeadline(viewFromV2(report, 2));

  // The detector loss is disclosed, and absence claims over it are hedged.
  assert.equal(headline.tone, "info");
  assert.match(headline.subhead, /detector output evidence was censored/);
  assert.match(headline.subhead, /unproven here rather than shown to be absent/);

  // But nothing may call the completed families interrupted.
  assert.doesNotMatch(headline.headline, /low counts are not the full story/);
  assert.doesNotMatch(headline.subhead, /retained lower bounds/);
  assert.doesNotMatch(headline.subhead, /incomplete end-state snapshots/);
  assert.match(headline.subhead, /request log recorded no cross-site hosts/);
  assert.match(headline.subhead, /cookie snapshot recorded no third-party cookie records/);
  // "capture-loss:truncated" names a mechanism, not an instrument. The reader
  // must be able to tell WHICH check stopped.
  assert.match(headline.subhead, /1 privacy-policy visit did not finish before collection stopped/);

  // A loss in a family that DOES back the counts still hedges them.
  const capped = makePublicSingleReportV2R2();
  capped.run.quality.byFamily.requests = { outcome: "censored", reasons: ["capture-loss:truncated"] };
  const cappedHeadline = buildReportHeadline(viewFromV2(capped, 2));
  assert.match(cappedHeadline.headline, /scan did not finish every measurement/);
  assert.match(cappedHeadline.subhead, /retained lower bounds for this visit/);
  assert.doesNotMatch(cappedHeadline.subhead, /cookie and storage figures are incomplete end-state snapshots/);
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
  cookies?: number;
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
  let nextRequestId = 1;
  const requests = domains.flatMap((domain) =>
    Array.from({ length: domain.requests }, (): NetworkRequestRecord => {
      const id = nextRequestId;
      nextRequestId += 1;
      return {
        id,
        url: `https://fixture.invalid/request-${id}`,
        domain: domain.domain,
        method: "GET",
        resourceType: domain.resourceTypes[0] ?? "other",
        status: domain.statuses[0] ?? null,
        thirdParty: domain.thirdParty,
        tracker: domain.tracker,
        blockedByShields: domain.blockedByShields,
        startedAtMs: id
      };
    })
  );

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
      cookies: overrides.cookies ?? overrides.thirdPartyCookies ?? 0,
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
    requests,
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
  assert.match(headline.headline, /heavy\.example recorded 55 fewer third-party requests in the visit configured for Brave-list blocking\./);
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
  assert.match(headline.headline, /shop\.example contacted catalogued Google and Meta domains during this visit\./);
  assert.match(headline.subhead, /had requests dispatched, though no response was recorded/);
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
  assert.match(headline.headline, /shop\.example contacted catalogued Google and Meta domains during this visit\./);
  assert.match(headline.subhead, /1 recorded responses; the rest recorded no response/);
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
  assert.match(headline.headline, /shop\.example contacted 1 distinct catalogued tracking-related service during this visit\./);
  assert.match(headline.subhead, /had requests dispatched with no recorded response/);
});

test("reportPageTitle prefixes the domain only when the headline does not already name the site", () => {
  const base = {
    tone: "info" as const,
    kicker: "What this actually means",
    subhead: "subhead",
    subheadPrimaryClaim: "subhead",
    caveat: "caveat",
    stats: [],
    shareText: "share",
    semantic: {
      story: "observed-activity" as const,
      reassuring: false,
      runScope: "display" as const,
      subjectScope: "requested-page" as const,
      assertedClaims: [],
      absenceClaims: []
    }
  };
  // Most branches name the site themselves; prefixing again produced
  // "webmd.com: webmd.com loaded ..." in every tab title and page header.
  assert.equal(
    reportPageTitle({ ...base, domain: "webmd.com", headline: "webmd.com loaded 306 fewer third-party requests with Brave-list blocking on." }),
    "webmd.com loaded 306 fewer third-party requests with Brave-list blocking on."
  );
  // Domain matching is case-insensitive and position-independent.
  assert.equal(
    reportPageTitle({ ...base, domain: "shop.example", headline: "Off-site requests to shop.example dropped 62% with a privacy signal on." }),
    "Off-site requests to shop.example dropped 62% with a privacy signal on."
  );
  // A headline that never names the site still gets the identifying prefix.
  assert.equal(
    reportPageTitle({ ...base, domain: "shop.example", headline: "This visit looked quiet." }),
    "shop.example: This visit looked quiet."
  );
});
