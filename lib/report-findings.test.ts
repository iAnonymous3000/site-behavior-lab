import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PAGE_SUBJECT_UNVERIFIED_WARNING,
  SUSPECTED_CHALLENGE_OR_SOFT_BLOCK_WARNING
} from "./bot-wall-classifier";
import { createConsentComparisonReport, createGpcComparisonReport, createShieldsComparisonReport } from "./compare-reports";
import { corpusCohortIdentityForView } from "./corpus-cohort";
import { GPC_WORKER_CAPTURE_LOSS_WARNING } from "./gpc-injection";
import { buildFindings, type Finding, type FindingIconKey } from "./report-findings";
import type { CorpusStats } from "./corpus-stats";
import {
  FINGERPRINT_OBSERVER_CAPTURE_LOSS_WARNING,
  INVALID_UPSTREAM_RESPONSE_WARNING,
  PIXEL_DECODE_CAPTURE_LOSS_WARNING
} from "./scan-runtime";
import { evaluateQuality } from "./scan-report-v2-evaluators";
import { R2_NAVIGATION_STATUS_UNREPRESENTABLE } from "./scan-report-v2-http-status";
import {
  makeConsentInterventionReportV2R2,
  makePublicSingleReportV2R2,
  makeShieldsInterventionReportV2R2
} from "./scan-report-v2-r2-fixtures";
import { makePublicSingleReportV2 } from "./scan-report-v2-fixtures";
import {
  displayRunView,
  familyCensoredOnRun,
  requestEvidenceState,
  runCensorshipNotes,
  viewFromV1Report,
  viewFromV2
} from "./scan-report-views";
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
  "keyboard",
  "fingerprint",
  "shield-check",
  "check",
  "alert",
  "file-text"
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

  const findings = buildFindings(viewFromV1Report(result), null);

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

test("an HTTP error load gets a failed-load bottom line, not a low-signal one", () => {
  const result = makeResult({ firstPartyDomain: "blocked.example", status: 403, totalRequests: 1 });

  const findings = buildFindings(viewFromV1Report(result), null);

  const bottomLine = findings[0];
  assert.equal(bottomLine.id, "bottom-line");
  assert.equal(bottomLine.icon, "alert");
  assert.match(bottomLine.title, /blocked\.example did not serve its page \(HTTP 403\)/);
  assert.match(bottomLine.lead, /HTTP 403/);
  assert.doesNotMatch(bottomLine.title, /few review signals/);
  // A 403 is a refusal, not an outage: the site answered. Advising a retry "when
  // the site is reachable" pointed readers at a loop.
  assert.doesNotMatch(bottomLine.detail, /when the site is reachable/);
  assert.match(bottomLine.detail, /answered and denied this visit/);
  assert.match(bottomLine.detail, /status alone cannot distinguish/);
  assert.doesNotMatch(bottomLine.detail, /most common reason|does not disguise itself/);

  // An error page cannot support reassuring absence cards. This branch used to
  // return before the hedge that the failed-navigation branch applies.
  const absence = findings.filter((finding) => finding.id !== "bottom-line");
  assert.ok(absence.length > 0, "expected absence cards to hedge");
  for (const finding of absence) {
    assert.notEqual(finding.level, "ok");
    assert.notEqual(finding.level, "quiet");
    assert.match(finding.detail, /error or block page, not the site/);
  }
});

test("subresource access statuses never replace a successful page with a failed-load finding", () => {
  for (const subresourceStatus of [401, 403, 429]) {
    const result = makeResult({
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
    const findings = buildFindings(viewFromV1Report(result), null);
    assert.doesNotMatch(findings[0].title, /did not serve its page/, String(subresourceStatus));
    assert.match(byId(findings, "third-party-services").lead, /Google appeared in the request log/);
  }
});

test("catalog, cookie, and ownership cards state only what their evidence supports", () => {
  const result = makeResult({
    firstPartyDomain: "youtube.com",
    domains: [makeTrackerDomain("stats.g.doubleclick.net", 2, "Google", "advertising")],
    thirdPartyRequests: 2,
    thirdPartyDomains: 1,
    thirdPartyCookies: 1
  });

  const findings = buildFindings(viewFromV1Report(result), null);
  const services = byId(findings, "third-party-services");
  assert.match(services.detail, /does not establish why an individual request occurred/);
  assert.doesNotMatch(services.detail, /can profile visitors/);
  assert.match(services.detail, /not evidence of disclosure to an outside company/);

  const platforms = byId(findings, "named-platforms");
  assert.match(platforms.title, /within the site's reviewed organization/);
  assert.match(platforms.detail, /does not support an outside-recipient disclosure claim/);

  const cookies = byId(findings, "third-party-cookies");
  assert.match(cookies.detail, /does not retain cookie values or partition keys/);
  assert.match(cookies.detail, /does not establish whether a cookie was a persistent identifier/);
  assert.doesNotMatch(cookies.detail, /can help outside services recognize/);
});

test("an HTTP-200 suspected soft block hedges every reassuring absence card", () => {
  const result = makeResult({ firstPartyDomain: "www.amazon.com", status: 200, totalRequests: 3 });
  result.warnings.push(SUSPECTED_CHALLENGE_OR_SOFT_BLOCK_WARNING);

  const findings = buildFindings(viewFromV1Report(result), null);
  assert.match(findings[0].title, /suspected challenge or soft block/);
  assert.match(findings[0].lead, /robot check, CAPTCHA, or blocking consent interstitial/);
  assert.doesNotMatch(findings[0].title, /few review signals/);
  assert.equal(findings.some((finding) => finding.level === "ok" || finding.level === "quiet"), false);
  assert.match(byId(findings, "third-party-services").detail, /interstitial, not the site/);
  assert.match(byId(findings, "third-party-cookies").detail, /interstitial, not the site/);
});

test("an unverified page subject hedges every reassuring absence card", () => {
  const result = makeResult({ firstPartyDomain: "unknown-subject.example", status: 200, totalRequests: 4 });
  result.warnings.push(PAGE_SUBJECT_UNVERIFIED_WARNING);

  const findings = buildFindings(viewFromV1Report(result), null);
  assert.match(findings[0].title, /page subject was not verified/);
  assert.doesNotMatch(findings[0].title, /few review signals/);
  assert.equal(findings.some((finding) => finding.level === "ok" || finding.level === "quiet"), false);
  assert.match(byId(findings, "third-party-services").detail, /does not describe the site/);
  assert.match(byId(findings, "third-party-cookies").detail, /does not describe the site/);
});

test("a failed r2 navigation with an unrepresentable status leads with incomplete navigation, not reassurance", () => {
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

  const findings = buildFindings(viewFromV2(report, 2), null);
  const bottomLine = findings[0];
  assert.equal(bottomLine.id, "bottom-line");
  assert.equal(bottomLine.level, "info");
  assert.match(bottomLine.title, /main page did not complete a trustworthy load/);
  assert.match(bottomLine.lead, /outside this frozen report format's representable range/);
  assert.match(bottomLine.lead, /exact code is withheld instead of being coerced/);
  assert.match(bottomLine.detail, /incomplete visit, not a positive privacy conclusion/);
  assert.doesNotMatch(`${bottomLine.title} ${bottomLine.lead}`, /few review signals|HTTP \d{3}/);
  assert.equal(byId(findings, "third-party-services").level, "info");
  assert.equal(findings.some((finding) => finding.level === "ok" || finding.level === "quiet"), false);
  assert.match(byId(findings, "third-party-cookies").detail, /absence describes only an incomplete visit/);
});

test("failed and request-capped visits never receive corpus benchmark labels", () => {
  const corpus = makeCorpus(60);
  const visits = [
    makeResult({ firstPartyDomain: "blocked.example", status: 403, totalRequests: 1 }),
    makeResult({ firstPartyDomain: "capped.example", totalRequests: 1200 })
  ];

  for (const visit of visits) {
    const findings = buildFindings(viewFromV1Report(visit), corpus);
    assert.equal(byId(findings, "third-party-services").benchmark, undefined);
    assert.equal(byId(findings, "third-party-cookies").benchmark, undefined);
  }
});

test("a request-capped quiet visit gets an incomplete-evidence bottom line, not a quiet one", () => {
  const result = makeResult({ firstPartyDomain: "quiet.example", totalRequests: 1200 });

  const findings = buildFindings(viewFromV1Report(result), null);

  const bottomLine = findings[0];
  assert.equal(bottomLine.id, "bottom-line");
  assert.equal(bottomLine.level, "info");
  assert.equal(bottomLine.icon, "alert");
  assert.match(bottomLine.title, /cut short/);
  assert.match(bottomLine.lead, /request-recording cap/);
  assert.doesNotMatch(bottomLine.title, /few review signals/);
});

test("absence claims over censored evidence hedge instead of reassuring", () => {
  // The cap aborts subsequent loads, which also suppresses the scripts that
  // would have set cookies, fired pixels, or called fingerprinting APIs, so
  // EVERY absence card on a capped run drops to "info" and says the absence
  // covers only pre-cutoff evidence.
  const result = makeResult({ firstPartyDomain: "quiet.example", totalRequests: 1200 });

  const findings = buildFindings(viewFromV1Report(result), null);

  const services = byId(findings, "third-party-services");
  assert.equal(services.level, "info");
  assert.match(services.detail, /covers only what was recorded before the cutoff/);
  const platforms = byId(findings, "named-platforms");
  assert.equal(platforms.level, "info");
  assert.match(platforms.detail, /covers only what was recorded before the cutoff/);
  const ga = byId(findings, "ga-remarketing");
  assert.equal(ga.level, "info");
  // The cap aborts subsequent loads, which also suppresses the scripts that
  // would have set cookies, so the cookie absence hedges too.
  const cookies = byId(findings, "third-party-cookies");
  assert.equal(cookies.level, "info");
  assert.match(cookies.detail, /covers only what was recorded before the cutoff/);
});

test("a v1 Shields card quotes no fingerprint-call delta; detector versions were never recorded", () => {
  const baseline = makeResult({
    firstPartyDomain: "heavy.example",
    domains: [makeTrackerDomain("ads.example", 60, "AdCo", "advertising")],
    totalRequests: 100,
    thirdPartyRequests: 60,
    thirdPartyDomains: 12
  });
  const variant = makeResult({ firstPartyDomain: "heavy.example", totalRequests: 45, thirdPartyRequests: 5, thirdPartyDomains: 2 });

  const card = byId(buildFindings(viewFromV1Report(shieldsPair(baseline, variant)), null), "shields-comparison");
  // The detector-findings family is denied on every v1 pair, so the card must
  // compose without a fingerprint-call delta anywhere.
  assert.doesNotMatch(`${card.lead} ${card.evidence}`, /fingerprint-like call/);
  assert.match(card.lead, /55 fewer third-party requests/);
});

test("a Shields pair with mixed directions never reads as 'fewer tracking signals'", () => {
  // Khan Academy case: more third-party requests but one fewer known-service
  // request. Signed per-family reporting, never clamped or summed.
  const baseline = makeResult({
    firstPartyDomain: "learn.example",
    domains: [
      makeTrackerDomain("ads.example", 3, "AdCo", "advertising"),
      makeTrackerDomain("pixels.example", 1, "PixelCo", "advertising")
    ],
    totalRequests: 60,
    thirdPartyRequests: 20,
    thirdPartyDomains: 6
  });
  const variant = makeResult({
    firstPartyDomain: "learn.example",
    domains: [makeTrackerDomain("ads.example", 3, "AdCo", "advertising")],
    totalRequests: 70,
    thirdPartyRequests: 28,
    thirdPartyDomains: 6
  });

  const card = byId(buildFindings(viewFromV1Report(shieldsPair(baseline, variant)), null), "shields-comparison");
  assert.equal(card.level, "info");
  assert.match(card.title, /Mixed changes observed in the Brave-list blocking attempt/);
  assert.match(card.lead, /8 more third-party requests/);
  assert.match(card.lead, /1 fewer known-service request/);
  assert.doesNotMatch(card.title, /Fewer tracking signals/);
  assert.doesNotMatch(card.lead, /0 fewer/);
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

  const findings = buildFindings(viewFromV1Report(result), null);

  const platforms = byId(findings, "named-platforms");
  assert.equal(platforms.level, "warn");
  assert.match(platforms.lead, /Google, Meta and TikTok/);

  const services = byId(findings, "third-party-services");
  assert.equal(services.title, "Catalogued service domains recorded responses during this visit");
  assert.match(services.detail, /Functional catalog labels include/);
  assert.doesNotMatch(services.detail, /Observed categories/);
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
  assert.equal(byId(buildFindings(viewFromV1Report(withSync), null), "ga-remarketing").level, "warn");

  const gaOnly = makeResult({
    domains: [makeTrackerDomain("www.google-analytics.com", 4, "Google", "analytics")],
    thirdPartyRequests: 4,
    thirdPartyDomains: 1
  });
  assert.equal(byId(buildFindings(viewFromV1Report(gaOnly), null), "ga-remarketing").title, "Google Analytics present, no remarketing signal");

  // Other *.g.doubleclick.net hosts are publisher ads / cookie matching, not the GA remarketing marker.
  const otherDoubleclick = makeResult({
    domains: [
      makeTrackerDomain("www.google-analytics.com", 4, "Google", "analytics"),
      makeTrackerDomain("securepubads.g.doubleclick.net", 2, "Google", "advertising")
    ],
    thirdPartyRequests: 6,
    thirdPartyDomains: 2
  });
  assert.equal(byId(buildFindings(viewFromV1Report(otherDoubleclick), null), "ga-remarketing").level, "ok");
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

  const services = byId(buildFindings(viewFromV1Report(result), null), "third-party-services");
  assert.equal(services.title, "Only operational services matched");
  assert.equal(services.level, "ok");
});

test("uses measured percentile wording when the corpus is usable, fixed thresholds otherwise", () => {
  const result = makeResult({
    domains: Array.from({ length: 20 }, (_, index) => makeTrackerDomain(`tracker${index}.example`, 2, `Vendor ${index}`, "advertising")),
    thirdPartyRequests: 40,
    thirdPartyDomains: 40
  });

  const withCorpus = buildFindings(viewFromV1Report(result), makeCorpus(60));
  assert.match(byId(withCorpus, "third-party-services").benchmark ?? "", /90th-percentile mark for .* across the 60 sites measured for this metric/);
  assert.match(byId(withCorpus, "bottom-line").detail, /each percentile card naming its metric-specific measured-site denominator/);

  // A corpus that also records its coverage names both concepts without
  // mislabeling loaded coverage as every attempted scan.
  const withCoverage = buildFindings(viewFromV1Report(result), { ...makeCorpus(60), coverageSiteCount: 62 });
  assert.match(
    byId(withCoverage, "bottom-line").detail,
    /legacy-v1 cohort, with each percentile card naming its metric-specific measured-site denominator \(among 62 sites with a successful load; request-capped, post-choice consent, and v2 loads are included in that coverage but excluded from this legacy-v1 cohort, while failed or block-page attempts are outside it\)/
  );

  const withoutCorpus = buildFindings(viewFromV1Report(result), null);
  const fixedBenchmark = byId(withoutCorpus, "third-party-services").benchmark ?? "";
  assert.doesNotMatch(fixedBenchmark, /fully measured sites/);
  assert.match(byId(withoutCorpus, "bottom-line").detail, /fixed reference thresholds/);
});

test("a v2 view is never benchmarked against the v1-only corpus", () => {
  // The published percentiles are built from v1 reports only (the builder
  // excludes v2 as non-comparable), so ranking a v2 report against them
  // would compare across methodologies; v2 falls back to fixed thresholds
  // until a matching cohort exists.
  const view = viewFromV2(makePublicSingleReportV2(), 1);
  const findings = buildFindings(view, makeCorpus(60));
  assert.doesNotMatch(byId(findings, "third-party-services").benchmark ?? "", /fully measured sites/);
  assert.match(byId(findings, "bottom-line").detail, /fixed reference thresholds/);
});

test("a version-2 corpus benchmarks only the report's exact methodology cohort", () => {
  const view = viewFromV2(makePublicSingleReportV2(), 1);
  const identity = corpusCohortIdentityForView(view);
  const legacyCompatibility = makeCorpus(75);
  const matching: CorpusStats = {
    ...legacyCompatibility,
    version: 2,
    primaryCohortId: "v1:legacy:producer-unrecorded",
    cohorts: [
      {
        ...identity,
        sampleSize: 60,
        latestRunAt: "2026-07-06T09:35:00.000Z",
        metrics: legacyCompatibility.metrics
      }
    ]
  };

  const matched = buildFindings(view, matching);
  assert.match(
    byId(matched, "bottom-line").detail,
    /each percentile card naming its metric-specific measured-site denominator/,
    "the matching r1 methodology cohort is usable"
  );
  assert.match(byId(matched, "bottom-line").detail, /exact schema, methodology, producer, and Global Privacy Control cohort/);
  assert.doesNotMatch(byId(matched, "bottom-line").detail, /legacy-v1 distribution/);

  const mismatched: CorpusStats = {
    ...matching,
    cohorts: matching.cohorts?.map((cohort) => ({ ...cohort, id: `${cohort.id}-different-method` }))
  };
  const rejected = buildFindings(view, mismatched);
  assert.match(byId(rejected, "bottom-line").detail, /fixed reference thresholds/);
});

test("small corpora below the honesty gate fall back to fixed thresholds", () => {
  const result = makeResult({ thirdPartyDomains: 40, thirdPartyRequests: 40 });
  const tiny = buildFindings(viewFromV1Report(result), makeCorpus(10));
  assert.doesNotMatch(byId(tiny, "third-party-services").benchmark ?? "", /fully measured sites/);
});

test("adds a Shields-block card only when ad-block is active", () => {
  const base = makeResult({ thirdPartyRequests: 10, thirdPartyDomains: 4, totalRequests: 25 });
  assert.equal(buildFindings(viewFromV1Report(base), null).some((finding) => finding.id === "shields-blocked"), false);

  const withAdblock: ScanResult = {
    ...base,
    summary: { ...base.summary, shieldsBlockedRequests: 12 },
    conditions: {
      ...base.conditions,
      adblock: { active: true, source: "brave-default", lists: 5, fetchedAt: new Date(0).toISOString() }
    }
  };
  const blocked = byId(buildFindings(viewFromV1Report(withAdblock), null), "shields-blocked");
  assert.equal(blocked.level, "warn");
  // Classification mode: the number is filter-list MATCHES on a normal load,
  // never presented as a measured block.
  assert.match(blocked.title, /12 of 25 requests matched Brave Shields filter lists/);
  assert.doesNotMatch(blocked.title, /would block/);
  assert.doesNotMatch(blocked.detail, /requests LOADED/);
  assert.match(blocked.detail, /were not blocked by the scanner/);
  assert.match(blocked.detail, /neither a measured block count nor the total effect/);

  const simulated: ScanResult = {
    ...withAdblock,
    conditions: { ...withAdblock.conditions, shieldsMode: "block-simulation" }
  };
  const simulatedCard = byId(buildFindings(viewFromV1Report(simulated), null), "shields-blocked");
  assert.match(simulatedCard.title, /Brave's blocking engine stopped 12 requests in this visit/);
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

  const report = shieldsPair(baseline, variant);
  const ids = buildFindings(viewFromV1Report(report), null).map((finding) => finding.id);

  // The historical bug capped the list at eight and dropped the last-pushed
  // fingerprinting card on exactly this shape (Shields comparison + behavioral signal).
  for (const expected of ["shields-comparison", "bottom-line", "session-recording-input-monitoring", "fingerprint-apis"]) {
    assert.ok(ids.includes(expected), `expected a "${expected}" card, got: ${ids.join(", ")}`);
  }
  assert.equal(ids[0], "bottom-line");
  assert.equal(ids[1], "shields-comparison");
});

test("the Shields comparison card hedges the residual beyond the direct engine blocks", () => {
  const baseline = makeResult({
    firstPartyDomain: "shop.example",
    domains: [makeTrackerDomain("google-analytics.com", 8, "Google", "analytics")],
    thirdPartyRequests: 30,
    thirdPartyDomains: 12,
    totalRequests: 60
  });
  const variant: ScanResult = {
    ...makeResult({ firstPartyDomain: "shop.example", thirdPartyRequests: 5, thirdPartyDomains: 2, totalRequests: 20 }),
  };
  variant.summary = { ...variant.summary, shieldsBlockedRequests: 9 };
  variant.conditions = {
    ...variant.conditions,
    shieldsMode: "block-simulation",
    adblock: { active: true, source: "brave-default", lists: 5, fetchedAt: new Date(0).toISOString() }
  };

  const card = byId(buildFindings(viewFromV1Report(shieldsPair(baseline, variant)), null), "shields-comparison");
  assert.match(card.detail, /directly blocked 9 requests/);
  // The residual is not established to be follow-on prevention; it can also be
  // run variance, so the attribution must stay hedged.
  assert.match(card.detail, /may include follow-on requests/);
  assert.doesNotMatch(card.detail, /the rest of the reduction is/);
  assert.match(card.detail, /run-to-run variance/);
});

test("a legacy consent pair stays attempt-only because v1 cannot verify either registered choice", () => {
  const acceptRun = {
    ...makeResult({
      firstPartyDomain: "shop.example",
      domains: [
        makeTrackerDomain("google-analytics.com", 8, "Google", "analytics"),
        makeTrackerDomain("facebook.net", 4, "Meta", "social / advertising pixel")
      ],
      thirdPartyRequests: 30
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

  const report = consentPair(acceptRun, rejectRun);
  const findings = buildFindings(viewFromV1Report(report), null);

  assert.equal(findings[0].id, "bottom-line");
  const card = byId(findings, "consent-comparison");
  assert.equal(card.level, "info");
  assert.match(card.title, /Consent choices were attempted, but not verified/);
  assert.match(card.lead, /v1 report records only that the scanner dispatched the Accept all click/);
  assert.match(card.lead, /v1 report records only that the scanner dispatched the Reject all click/);
  assert.match(card.detail, /do not support an accept-versus-reject outcome/);
  assert.match(card.detail, /both requested choices are verified as registered/);
  assert.doesNotMatch(`${card.title} ${card.lead} ${card.detail}`, /survive Reject|appeared only|did remove/);
});

test("an unverified legacy consent pair never upgrades raw traffic into a consent outcome", () => {
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

  const card = byId(buildFindings(viewFromV1Report(consentPair(acceptRun, rejectRun)), null), "consent-comparison");
  assert.match(card.title, /attempted, but not verified/);
  assert.match(card.lead, /records only that the scanner dispatched/);
  assert.doesNotMatch(`${card.title} ${card.lead}`, /received requests|loaded in/);
});

test("a verified r2 consent finding reports registration and retains scope caveats", () => {
  const view = viewFromV2(makeConsentInterventionReportV2R2(), 2);
  const variant = view.runs.find((run) => run.label === "variant");
  if (!variant) throw new Error("fixture invariant");
  variant.evidence.domains = [makeTrackerDomain("google-analytics.com", 3, "Google", "analytics")];
  variant.counts.knownTrackerRequests = 3;
  variant.counts.thirdPartyRequests = 3;
  variant.counts.thirdPartyDomains = 1;

  const card = byId(buildFindings(view, null), "consent-comparison");
  assert.match(card.detail, /verified that the site registered Reject all/);
  assert.match(card.detail, /again after one page reload/);
  assert.match(card.detail, /pre-choice traffic/);
  assert.match(card.detail, /strictly necessary/);
  assert.match(card.detail, /legitimate interest/);
  assert.doesNotMatch(card.detail, /cannot verify|never verified/);
});

test("both v2 arms must verify registration before any consent outcome claim", () => {
  for (const label of ["baseline", "variant"] as const) {
    const view = viewFromV2(makeConsentInterventionReportV2R2(), 2);
    const arm = view.runs.find((run) => run.label === label);
    if (!arm?.consent) throw new Error("fixture invariant");
    arm.consent.choiceState = "unavailable";
    arm.consent.bannerTransition = null;

    const card = byId(buildFindings(view, null), "consent-comparison");
    assert.equal(card.level, "info");
    assert.match(card.title, /choice was attempted, but not verified/);
    assert.doesNotMatch(card.title, /had no catalogued trackers/);
    assert.match(card.detail, /do not support an accept-versus-reject outcome/);
  }
});

test("a banner-only v2 reject observation cannot earn an ok consent card", () => {
  const view = viewFromV2(makeConsentInterventionReportV2R2(), 2);
  const variant = view.runs.find((run) => run.label === "variant");
  if (!variant?.consent) throw new Error("fixture invariant");
  variant.consent.choiceState = "weak-signal";
  variant.consent.reverifiedAfterReload = false;

  const card = byId(buildFindings(view, null), "consent-comparison");
  assert.equal(card.level, "info");
  assert.match(card.title, /choice was attempted, but not verified/);
  assert.match(card.lead, /no registered consent state was verified/);
  assert.match(card.detail, /do not support an accept-versus-reject outcome/);
});

test("a contradicted registered state is disclosed as a warning, never an outcome", () => {
  const view = viewFromV2(makeConsentInterventionReportV2R2(), 2);
  const variant = view.runs.find((run) => run.label === "variant");
  if (!variant?.consent) throw new Error("fixture invariant");
  variant.consent.choiceState = "contradicted";

  const card = byId(buildFindings(view, null), "consent-comparison");
  assert.equal(card.level, "warn");
  assert.equal(card.methodology, undefined);
  assert.match(card.title, /registered consent state contradicted/);
  assert.match(card.lead, /contradicted the Reject all click/);
  assert.match(card.detail, /do not support an accept-versus-reject outcome/);

  const bottomLine = byId(buildFindings(view, null), "bottom-line");
  assert.equal(bottomLine.level, "warn");
  assert.match(bottomLine.title, /review-worthy signals/);
});

test("a no-click contradiction is non-calm evidence with explicit no-dispatch copy", () => {
  const view = viewFromV2(makeConsentInterventionReportV2R2(), 2);
  const variant = view.runs.find((run) => run.label === "variant");
  if (!variant?.consent) throw new Error("fixture invariant");
  variant.consent.controlActivated = false;
  variant.consent.choiceState = "contradicted";

  const findings = buildFindings(view, null);
  const card = byId(findings, "consent-comparison");
  assert.equal(card.level, "warn");
  assert.equal(card.methodology, undefined);
  assert.match(card.title, /requested choice/);
  assert.match(card.lead, /did not activate that control/);
  assert.doesNotMatch(`${card.title} ${card.lead}`, /dispatched choice|contradicted the Reject all click/);
  assert.notEqual(card.lead, "");
  assert.match(card.evidence, /no activated choice/);

  const bottomLine = byId(findings, "bottom-line");
  assert.equal(bottomLine.level, "warn");
  assert.doesNotMatch(bottomLine.title, /few review signals/);
});

test("a consent comparison with no clickable banner claims nothing", () => {
  const acceptRun = {
    ...makeResult({ firstPartyDomain: "shop.example", thirdPartyRequests: 10 }),
    consentInteraction: { mode: "accept-all" as const, clicked: false }
  };
  const rejectRun = {
    ...makeResult({ firstPartyDomain: "shop.example", thirdPartyRequests: 9 }),
    consentInteraction: { mode: "reject-all" as const, clicked: false }
  };

  const report = consentPair(acceptRun, rejectRun);
  const card = byId(buildFindings(viewFromV1Report(report), null), "consent-comparison");

  assert.equal(card.level, "info");
  assert.match(card.title, /No consent control activation was recorded/);
  assert.match(card.lead, /can be shown to reflect the choice it attempted/);
});

test("reader copy never asserts the pre-consent state from an unrecorded activation", () => {
  // `clicked: false` records that no control activation was OBSERVED. The
  // producer also writes it for a click that was dispatched and never visibly
  // responded, whose own warning says the visit's requests, cookies and
  // storage may include traffic from after that click. The v1 wire cannot tell
  // the two apart, so no reader-derived sentence may claim the visit stayed
  // pre-consent: on that run the claim is exactly false.
  const acceptRun = {
    ...makeResult({ firstPartyDomain: "shop.example", thirdPartyRequests: 21 }),
    consentInteraction: { mode: "accept-all" as const, clicked: false }
  };
  const rejectRun = {
    ...makeResult({ firstPartyDomain: "shop.example", thirdPartyRequests: 19 }),
    consentInteraction: { mode: "reject-all" as const, clicked: false }
  };

  const card = byId(buildFindings(viewFromV1Report(consentPair(acceptRun, rejectRun)), null), "consent-comparison");
  const rendered = `${card.title} ${card.lead} ${card.detail} ${card.evidence}`;
  assert.doesNotMatch(rendered, /pre-consent/i);
  assert.doesNotMatch(rendered, /found no recognizable/i);

  // One arm activated, one not: the un-activated side must hedge the same way.
  const mixed = byId(
    buildFindings(
      viewFromV1Report(
        consentPair({ ...acceptRun, consentInteraction: { mode: "accept-all" as const, clicked: true } }, rejectRun)
      ),
      null
    ),
    "consent-comparison"
  );
  assert.doesNotMatch(`${mixed.title} ${mixed.lead} ${mixed.detail} ${mixed.evidence}`, /pre-consent/i);
});

test("a clean legacy reject attempt stays neutral, and a missing reject control is explicit", () => {
  const acceptRun = {
    ...makeResult({
      firstPartyDomain: "shop.example",
      domains: [makeTrackerDomain("google-analytics.com", 8, "Google", "analytics")],
      thirdPartyRequests: 20
    }),
    consentInteraction: { mode: "accept-all" as const, clicked: true, cmp: "Cookiebot" }
  };
  const cleanRejectRun = {
    ...makeResult({ firstPartyDomain: "shop.example", thirdPartyRequests: 2 }),
    consentInteraction: { mode: "reject-all" as const, clicked: true, cmp: "Cookiebot" }
  };

  const neutralCard = byId(buildFindings(viewFromV1Report(consentPair(acceptRun, cleanRejectRun)), null), "consent-comparison");
  assert.equal(neutralCard.level, "info");
  assert.match(neutralCard.title, /attempted, but not verified/);
  assert.doesNotMatch(neutralCard.title, /had no catalogued trackers/);

  const unclickedRejectRun = {
    ...makeResult({ firstPartyDomain: "shop.example", thirdPartyRequests: 19 }),
    consentInteraction: { mode: "reject-all" as const, clicked: false }
  };
  const partialCard = byId(
    buildFindings(viewFromV1Report(consentPair(acceptRun, unclickedRejectRun)), null),
    "consent-comparison"
  );
  assert.equal(partialCard.level, "info");
  assert.match(partialCard.title, /Only the Accept all control could be clicked/);
  assert.match(partialCard.lead, /does not measure the reject all choice/);
});

test("a clean consent pair earns an ok card only when both registered choices are verified", () => {
  const view = viewFromV2(makeConsentInterventionReportV2R2(), 2);
  const card = byId(buildFindings(view, null), "consent-comparison");
  assert.equal(card.level, "ok");
  assert.match(card.title, /clicked Reject all had no catalogued trackers/);
});

test("the pre-consent CMP card is suppressed on consent-mode runs", () => {
  const observed = makeResult({
    domains: [
      makeTrackerDomain("cdn.cookielaw.org", 2, "OneTrust", "consent management"),
      makeTrackerDomain("google-analytics.com", 5, "Google", "analytics")
    ],
    thirdPartyRequests: 7
  });
  const observedIds = buildFindings(viewFromV1Report(observed), null).map((finding) => finding.id);
  assert.ok(observedIds.includes("consent-banner"), "observe-mode runs keep the pre-consent card");

  const consentRun = {
    ...observed,
    conditions: { ...observed.conditions, consentMode: "accept-all" as const }
  };
  const consentIds = buildFindings(viewFromV1Report(consentRun), null).map((finding) => finding.id);
  assert.equal(consentIds.includes("consent-banner"), false, "post-click runs must not claim the pre-consent state");
});

test("confirmed keystroke exfiltration surfaces a loud finding and drives the bottom line", () => {
  const result = makeResult({
    fingerprintDetections: [
      {
        kind: "keystroke-exfiltration",
        heuristic: "input-sentinel-exfiltration-v1",
        count: 1,
        evidence: { recipients: ["collect.example"], encodings: ["sha256", "plain"], fieldsTyped: 2, fieldTypes: ["email", "password"] }
      }
    ]
  });

  const findings = buildFindings(viewFromV1Report(result), null);
  const card = byId(findings, "keystroke-exfiltration");
  assert.equal(card.level, "loud");
  assert.equal(card.icon, "keyboard");
  assert.match(card.title, /hashed form of synthetic input reached 1 cross-site domain before submission/);
  assert.match(card.lead, /collect\.example/);
  assert.match(card.detail, /does not establish whether transmission happened during typing, blur, or unload/);
  assert.doesNotMatch(card.detail, /known identity/);
  // A loud signal forces the bottom line loud, and bottom line still leads.
  assert.equal(findings[0].id, "bottom-line");
  assert.equal(byId(findings, "bottom-line").level, "loud");
});

test("keystroke leak severity escalates on one-way hashing, not reversible encodings", () => {
  // Plain-text leak = functional type-ahead/autocomplete → calmer "warn".
  const plain = makeResult({ fingerprintDetections: [makeKeystrokeDetection(["plain"])] });
  const plainCard = byId(buildFindings(viewFromV1Report(plain), null), "keystroke-exfiltration");
  assert.equal(plainCard.level, "warn");
  assert.match(plainCard.title, /Synthetic form input reached/);

  // Reversible base64/hex is common in legitimate APIs, so it stays "warn", not an alarm.
  const reversible = makeResult({ fingerprintDetections: [makeKeystrokeDetection(["base64"])] });
  const reversibleCard = byId(buildFindings(viewFromV1Report(reversible), null), "keystroke-exfiltration");
  assert.equal(reversibleCard.level, "warn");
  assert.match(reversibleCard.title, /Synthetic form input reached/);

  // A one-way hash cannot drive a type-ahead, so it reads as deliberate capture → "loud".
  const hashed = makeResult({ fingerprintDetections: [makeKeystrokeDetection(["sha256"])] });
  const hashedCard = byId(buildFindings(viewFromV1Report(hashed), null), "keystroke-exfiltration");
  assert.equal(hashedCard.level, "loud");
  assert.match(hashedCard.title, /hashed form of synthetic input reached/);
});

test("surfaces CNAME-cloaked trackers as their own finding, and omits it when there are none", () => {
  const base = makeResult({ thirdPartyDomains: 2, thirdPartyRequests: 4 });
  assert.equal(buildFindings(viewFromV1Report(base), null).some((finding) => finding.id === "cname-cloaking"), false);

  const cloaked: ScanResult = {
    ...base,
    cnameCloaks: [
      {
        host: "metrics.shop.example",
        cname: "shop.eulerian.net",
        tracker: { domain: "eulerian.net", entity: "Eulerian", category: "advertising", confidence: "curated" }
      }
    ]
  };
  const card = byId(buildFindings(viewFromV1Report(cloaked), null), "cname-cloaking");
  assert.equal(card.level, "warn");
  assert.match(card.title, /1 tracker hidden behind a first-party subdomain/);
  assert.match(card.lead, /Eulerian/);
  assert.match(card.evidence, /metrics\.shop\.example → shop\.eulerian\.net/);
});

test("surfaces pre-consent tracking when a consent-management platform is present", () => {
  const cmpDomain: DomainSummary = {
    domain: "cdn.cookielaw.org",
    requests: 2,
    thirdParty: true,
    tracker: null,
    statuses: [200],
    resourceTypes: ["script"]
  };
  const withCmp = makeResult({
    domains: [cmpDomain, makeTrackerDomain("google-analytics.com", 5, "Google", "analytics")],
    thirdPartyRequests: 7,
    thirdPartyDomains: 2
  });
  const card = byId(buildFindings(viewFromV1Report(withCmp), null), "consent-banner");
  assert.equal(card.level, "warn");
  assert.match(card.title, /tracker requests appeared before any choice/);
  assert.match(card.lead, /OneTrust/);
  assert.match(card.lead, /before the scanner made any consent choice/);
  assert.match(card.detail, /records requests made before the scanner made a consent choice/);
  assert.match(card.detail, /does not determine whether any request required consent/);
  assert.match(card.detail, /whether the site's behavior complied with applicable law/);
  assert.doesNotMatch(card.detail, /not permitted under GDPR\/ePrivacy/);

  const cmpOnly = makeResult({
    domains: [cmpDomain],
    thirdPartyRequests: 2,
    thirdPartyDomains: 1
  });
  const informational = byId(buildFindings(viewFromV1Report(cmpOnly), null), "consent-banner");
  assert.equal(informational.level, "info");
  assert.equal(informational.title, "A consent management platform answered");
  assert.match(informational.lead, /no request to a catalogued tracking-related service was recorded/);
  assert.match(informational.lead, /before the scanner made any consent choice/);

  const noCmp = makeResult({
    domains: [makeTrackerDomain("google-analytics.com", 5, "Google", "analytics")],
    thirdPartyRequests: 5,
    thirdPartyDomains: 1
  });
  assert.equal(buildFindings(viewFromV1Report(noCmp), null).some((finding) => finding.id === "consent-banner"), false);
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

test("an ineligible comparison replaces the story card with the disqualifying facts", () => {
  const cappedBaseline = makeResult({
    firstPartyDomain: "heavy.example",
    domains: [makeTrackerDomain("ads.example", 60, "AdCo", "advertising")],
    totalRequests: 1000,
    thirdPartyRequests: 60
  });
  const variant = makeResult({ firstPartyDomain: "heavy.example", totalRequests: 45, thirdPartyRequests: 5 });

  const shieldsFindings = buildFindings(viewFromV1Report(shieldsPair(cappedBaseline, variant)), null);
  const shieldsCard = byId(shieldsFindings, "shields-comparison");
  assert.match(shieldsCard.title, /not conclusive/);
  assert.match(shieldsCard.lead, /recording cap/);
  assert.doesNotMatch(shieldsCard.lead, /fewer third-party/);

  const acceptRun = {
    ...makeResult({ firstPartyDomain: "shop.example", thirdPartyRequests: 30 }),
    consentInteraction: { mode: "accept-all" as const, clicked: true, cmp: "OneTrust" }
  };
  const failedRejectRun = {
    ...makeResult({ firstPartyDomain: "shop.example", thirdPartyRequests: 0, status: 503 }),
    consentInteraction: { mode: "reject-all" as const, clicked: true, cmp: "OneTrust" }
  };
  const consentCard = byId(
    buildFindings(viewFromV1Report(consentPair(acceptRun, failedRejectRun)), null),
    "consent-comparison"
  );
  assert.match(consentCard.title, /not conclusive/);
  assert.match(consentCard.lead, /HTTP 503/);

  const gpcCard = byId(
    buildFindings(viewFromV1Report(gpcPair(makeResult({ firstPartyDomain: "a.example" }), makeResult({ firstPartyDomain: "b.example" }))), null),
    "gpc-comparison"
  );
  assert.match(gpcCard.title, /not conclusive/);
  assert.match(gpcCard.lead, /different sites/);
});

test("an eligible GPC pair gets a card, signed and never attributed to the signal", () => {
  const baseline = makeResult({
    firstPartyDomain: "shop.example",
    domains: [
      makeTrackerDomain("ads.example", 30, "AdCo", "advertising"),
      makeTrackerDomain("pixels.example", 10, "PixelCo", "advertising")
    ],
    totalRequests: 100,
    thirdPartyRequests: 40,
    thirdPartyDomains: 8
  });
  const variant = makeResult({
    firstPartyDomain: "shop.example",
    domains: [makeTrackerDomain("ads.example", 8, "AdCo", "advertising")],
    totalRequests: 40,
    thirdPartyRequests: 10,
    thirdPartyDomains: 3
  });

  // The headline already speaks for this pair; without a card the findings
  // board narrated only the baseline arm.
  const card = byId(buildFindings(viewFromV1Report(gpcPair(baseline, variant)), null), "gpc-comparison");
  assert.equal(card.level, "ok");
  assert.match(card.title, /Fewer tracking signals observed in the visit with a privacy signal/);
  assert.match(card.lead, /30 fewer third-party requests/);
  assert.match(card.detail, /not proof the site received or honored the signal/);
  assert.doesNotMatch(`${card.title} ${card.lead} ${card.detail}`, /honors|respects|complied|obeyed/i);
  assert.doesNotMatch(card.title, /not conclusive/);

  // A GPC card's `direction` is computed over every comparable family, so the
  // headline noun may not name one of them. Here the request counts are held
  // equal and only third-party cookies move; the card must not publish that as
  // a change in off-site requests.
  const heldRequests = {
    firstPartyDomain: "shop.example",
    domains: [makeTrackerDomain("ads.example", 30, "AdCo", "advertising")],
    totalRequests: 100,
    thirdPartyRequests: 40,
    thirdPartyDomains: 8
  };
  const cookiesOnly = byId(
    buildFindings(
      viewFromV1Report(gpcPair(makeResult({ ...heldRequests, thirdPartyCookies: 5 }), makeResult(heldRequests))),
      null
    ),
    "gpc-comparison"
  );
  assert.match(cookiesOnly.lead, /fewer third-party cookies/);
  assert.doesNotMatch(cookiesOnly.title, /off-site request|off-site activity/i);
  assert.match(cookiesOnly.title, /Fewer tracking signals/);

  // Mixed directions must never collapse into a reduction story.
  const mixed = makeResult({
    firstPartyDomain: "shop.example",
    domains: [makeTrackerDomain("ads.example", 30, "AdCo", "advertising")],
    totalRequests: 120,
    thirdPartyRequests: 48,
    thirdPartyDomains: 9
  });
  const mixedCard = byId(buildFindings(viewFromV1Report(gpcPair(baseline, mixed)), null), "gpc-comparison");
  assert.equal(mixedCard.level, "info");
  assert.match(mixedCard.title, /Mixed changes observed/);
  assert.match(mixedCard.lead, /8 more third-party requests/);
  assert.match(mixedCard.lead, /10 fewer known-service requests/);
});

test("request capture loss replaces the GPC finding with a non-comparative methodology card", () => {
  const captureLossCases = [
    { warning: GPC_WORKER_CAPTURE_LOSS_WARNING, reason: /GPC Worker capture loss/ },
    { warning: INVALID_UPSTREAM_RESPONSE_WARNING, reason: /rejected invalid upstream responses/ },
    {
      warning: "The scan stopped opening additional proxy requests after reaching its connection and target safety budget.",
      reason: /proxy connection and target safety budget/
    }
  ];

  for (const { warning, reason } of captureLossCases) {
    const baseline = makeResult({
      firstPartyDomain: "shop.example",
      domains: [makeTrackerDomain("ads.example", 100, "AdCo", "advertising")],
      thirdPartyRequests: 100,
      thirdPartyDomains: 10
    });
    const incompleteVariant = makeResult({ firstPartyDomain: "shop.example", thirdPartyRequests: 0, thirdPartyDomains: 0 });
    incompleteVariant.warnings = [warning];

    const card = byId(buildFindings(viewFromV1Report(gpcPair(baseline, incompleteVariant)), null), "gpc-comparison");
    assert.equal(card.methodology, true, warning);
    assert.match(card.title, /not conclusive/, warning);
    assert.match(card.lead, reason, warning);
    assert.doesNotMatch(card.lead, /fewer|lower|more|versus|changed/, warning);
    assert.match(card.detail, /diff between them supports no claim/, warning);
  }
});

test("listener-coverage cards are restricted to cross-site origins", () => {
  const sameSiteDomain: DomainSummary = {
    domain: "verified.shop.example",
    requests: 3,
    thirdParty: false,
    tracker: null,
    statuses: [200],
    resourceTypes: ["script"]
  };

  // Solely same-party origins: no monitoring card at all.
  const samePartyOnly = makeResult({
    firstPartyDomain: "www.shop.example",
    domains: [sameSiteDomain],
    fingerprintDetections: [makeListenerDetection("input-monitoring", ["https://verified.shop.example"])]
  });
  const suppressedIds = buildFindings(viewFromV1Report(samePartyOnly), null).map((finding) => finding.id);
  assert.equal(suppressedIds.includes("session-recording-input-monitoring"), false);

  // Mixed origins: the card names only the cross-site one.
  const mixed = makeResult({
    firstPartyDomain: "www.shop.example",
    domains: [sameSiteDomain],
    fingerprintDetections: [
      makeListenerDetection("input-monitoring", ["https://recorder.example.net", "https://verified.shop.example"])
    ]
  });
  const mixedCard = byId(buildFindings(viewFromV1Report(mixed), null), "session-recording-input-monitoring");
  assert.match(mixedCard.evidence, /recorder\.example\.net/);
  assert.doesNotMatch(mixedCard.evidence, /verified\.shop\.example/);
  // The probe reports ONE call total across every origin it attributed and no
  // per-origin breakdown, so a narrowed origin list cannot carry the whole
  // count as if the retained names made every call.
  assert.match(mixedCard.evidence, /attributed across/);
  assert.match(mixedCard.evidence, /same-site origins the probe could not separate/);
  assert.doesNotMatch(mixedCard.evidence, /4 third-party input listeners from/);

  // Nothing was filtered, so the direct attribution stands unqualified.
  const crossSiteOnly = makeResult({
    firstPartyDomain: "www.shop.example",
    domains: [sameSiteDomain],
    fingerprintDetections: [makeListenerDetection("input-monitoring", ["https://recorder.example.net"])]
  });
  const cleanCard = byId(buildFindings(viewFromV1Report(crossSiteOnly), null), "session-recording-input-monitoring");
  assert.match(cleanCard.evidence, /4 third-party input listeners from/);
  assert.doesNotMatch(cleanCard.evidence, /attributed across/);
});

function makeListenerDetection(
  kind: "session-recording" | "input-monitoring",
  thirdPartyOrigins: string[]
): FingerprintDetectionSummary {
  if (kind === "session-recording") {
    return {
      kind,
      heuristic: "interaction-listener-coverage-v1",
      count: 1,
      evidence: { eventTypes: ["mousemove", "scroll", "click"], listenerTargets: ["document", "window"], thirdPartyOrigins, totalListenerCalls: 9 }
    };
  }
  return {
    kind,
    heuristic: "input-listener-coverage-v1",
    count: 1,
    evidence: { eventTypes: ["input", "keydown"], listenerTargets: ["input"], thirdPartyOrigins, totalListenerCalls: 4 }
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
  status?: number | null;
};

test("flags a policy contradiction when the policy denies third-party cookies that were observed", () => {
  const result = makeResult({ thirdPartyCookies: 3 });
  result.privacyPolicy = {
    url: "https://example.com/privacy",
    claims: [{ kind: "no-third-party-cookies", quote: "We do not use third-party cookies." }],
    mentionedEntities: [],
    unmentionedEntities: [],
    policyTextLength: 5000
  };

  const card = byId(buildFindings(viewFromV1Report(result), null), "privacy-policy");
  assert.equal(card.level, "warn");
  assert.equal(card.icon, "file-text");
  assert.match(card.lead, /third-party cookies are not used, but 3 third-party cookies/);
  assert.match(card.detail, /"We do not use third-party cookies\."/);
  assert.match(card.detail, /not a legal conclusion/);
});

test("flags unnamed tracking companies as an informational disclosure gap", () => {
  const result = makeResult({
    domains: [makeTrackerDomain("track.criteo.com", 4, "Criteo", "advertising")],
    thirdPartyDomains: 1
  });
  result.privacyPolicy = {
    url: "https://example.com/privacy",
    claims: [],
    mentionedEntities: ["Google"],
    unmentionedEntities: ["Criteo"],
    policyTextLength: 5000
  };

  const card = byId(buildFindings(viewFromV1Report(result), null), "privacy-policy");
  assert.equal(card.level, "info");
  // Scoped to what the matcher can prove: the stored list is alias-bounded and
  // the policy text is not retained, so an absolute "never names" cannot be
  // re-verified for any committed report.
  assert.match(card.title, /does not appear to name/);
  assert.match(card.lead, /Criteo was sent requests during this visit, but the policy text matched none of the names this scan knows that company by/);
  assert.match(card.detail, /not automatically a violation/);
});

test("reports a clean policy check at ok level", () => {
  const result = makeResult({});
  result.privacyPolicy = {
    url: "https://example.com/privacy",
    claims: [{ kind: "no-selling-or-sharing", quote: "We do not sell or share your personal information." }],
    mentionedEntities: [],
    unmentionedEntities: [],
    policyTextLength: 5000
  };

  const card = byId(buildFindings(viewFromV1Report(result), null), "privacy-policy");
  assert.equal(card.level, "ok");
  assert.match(card.title, /no checked statement contradicted/);
  assert.match(card.detail, /combined do-not-sell-or-share claims/);
});

test("historical sell-only or share-only combined claims are not treated as checkable", () => {
  for (const quote of [
    "We do not sell your personal information.",
    "We do not share your personal information.",
    "We do not sell personal data and we do not share it."
  ]) {
    const result = makeResult({});
    result.privacyPolicy = {
      url: "https://example.com/privacy",
      claims: [{ kind: "no-selling-or-sharing", quote }],
      mentionedEntities: [],
      unmentionedEntities: [],
      policyTextLength: 5000
    };

    const card = byId(buildFindings(viewFromV1Report(result), null), "privacy-policy");
    assert.equal(card.level, "info", quote);
    assert.match(card.title, /no statement this scan can check/, quote);
    assert.match(card.evidence, /0 checkable statements matched/, quote);
  }
});

test("a blanket combined no-selling-or-sharing claim uses combined finding wording", () => {
  const result = makeResult({});
  result.pixelEvents = [
    {
      platform: "Meta",
      product: "Meta Pixel",
      events: ["PageView"],
      advancedMatching: ["email"],
      requests: 1
    }
  ];
  result.privacyPolicy = {
    url: "https://example.com/privacy",
    claims: [
      {
        kind: "no-selling-or-sharing",
        quote: "We do not sell or share your personal information."
      }
    ],
    mentionedEntities: ["Meta"],
    unmentionedEntities: [],
    policyTextLength: 5000
  };

  const card = byId(buildFindings(viewFromV1Report(result), null), "privacy-policy");
  assert.equal(card.level, "info");
  assert.match(card.title, /may conflict/);
  assert.match(card.lead, /personal information is not sold or shared/);
});

test("a policy with no checkable statement never reads as a clean comparison", () => {
  // "No checked statement contradicted" is vacuously true when the extractor
  // matched nothing, and rendering it green presents zero checks as a clean
  // result. 83 committed reports took exactly this branch.
  const result = makeResult({});
  result.privacyPolicy = {
    url: "https://example.com/privacy",
    claims: [],
    mentionedEntities: [],
    unmentionedEntities: [],
    policyTextLength: 5000
  };

  const card = byId(buildFindings(viewFromV1Report(result), null), "privacy-policy");
  assert.equal(card.level, "info");
  assert.doesNotMatch(card.title, /no checked statement contradicted/);
  assert.match(card.title, /no statement this scan can check/);
  assert.match(card.lead, /nothing was compared against this visit's evidence/);
  assert.match(card.lead, /not a finding about the site either way/);
  // The honest count stays visible alongside the corrected headline.
  assert.match(card.evidence, /0 checkable statements matched/);
});

test("a qualified legacy combined transfer quote is revalidated before it can drive a finding", () => {
  const result = makeResult({});
  result.pixelEvents = [
    {
      platform: "Meta",
      product: "Meta Pixel",
      events: ["PageView"],
      advancedMatching: ["email"],
      requests: 1
    }
  ];
  result.privacyPolicy = {
    url: "https://example.com/privacy",
    claims: [
      {
        kind: "no-selling-or-sharing",
        quote: "We do not knowingly sell or share the personal information of minors under 16 years of age."
      }
    ],
    mentionedEntities: [],
    unmentionedEntities: [],
    policyTextLength: 5000
  };

  const card = byId(buildFindings(viewFromV1Report(result), null), "privacy-policy");
  assert.equal(card.level, "info");
  assert.match(card.title, /no statement this scan can check/);
  assert.doesNotMatch(card.title, /may conflict/);
  assert.match(card.evidence, /0 checkable statements matched/);
});

test("an honored-GPC claim is never contradicted by request counts", () => {
  // Honoring GPC means not selling or sharing data, which request counts
  // cannot observe: a site can honor the signal while loading identical
  // requests. The claim must therefore never surface as a policy conflict.
  const baseline = makeResult({
    domains: [makeTrackerDomain("ads.example.net", 40, "AdCo", "advertising")],
    thirdPartyRequests: 40,
    thirdPartyDomains: 1
  });
  baseline.privacyPolicy = {
    url: "https://example.com/privacy",
    claims: [{ kind: "honors-gpc", quote: "We honor Global Privacy Control signals." }],
    mentionedEntities: [],
    unmentionedEntities: [],
    policyTextLength: 5000
  };
  const variant = makeResult({
    domains: [makeTrackerDomain("ads.example.net", 38, "AdCo", "advertising")],
    thirdPartyRequests: 38,
    thirdPartyDomains: 1
  });
  const report = gpcPair(baseline, variant);

  const card = byId(buildFindings(viewFromV1Report(report), null), "privacy-policy");
  assert.equal(card.level, "ok");
  assert.doesNotMatch(card.lead, /Global Privacy Control is honored, but/);
  assert.match(card.detail, /never checked against request counts/);
});

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
    screenshot: null,
    warnings: []
  };
}

test("a tampered wire diff cannot drive the Shields card; deltas and entity lists derive from the arms", () => {
  const baseline = makeResult({
    firstPartyDomain: "heavy.example",
    domains: [makeTrackerDomain("ads.example", 60, "AdCo", "advertising")],
    totalRequests: 100,
    thirdPartyRequests: 60,
    thirdPartyDomains: 12
  });
  const variant = makeResult({
    firstPartyDomain: "heavy.example",
    totalRequests: 45,
    thirdPartyRequests: 5,
    thirdPartyDomains: 2
  });
  const report = shieldsPair(baseline, variant);
  // An uploaded report can carry any diff block it likes; the card must quote
  // the arms' recorded counts and entities, never the wire's precomputed claim.
  report.diff.thirdPartyRequests = { before: 9, after: 9, delta: 0 };
  report.diff.knownTrackerRequests = { before: 9, after: 9, delta: 0 };
  report.diff.removedEntities = [{ entity: "Forged Co", requests: 999, domains: 9 }];

  const card = byId(buildFindings(viewFromV1Report(report), null), "shields-comparison");
  assert.match(card.lead, /55 fewer third-party requests and 60 fewer known-service requests/);
  assert.match(card.detail, /Services only seen in the unblocked visit: AdCo/);
  assert.doesNotMatch(card.detail, /Forged Co/);
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

test("an ineligible pair is a methodology note: prose reasons, and no bottom-line flip", () => {
  // The production gap this pins: a producer that recorded no egress region
  // gates every family (unknown never matches unknown), like the first three
  // committed r2 reports.
  const gated = makeShieldsInterventionReportV2R2();
  const ineligible = () => ({ eligible: false, reasons: ["unknown-dimension:egress.region" as const] });
  gated.comparability = {
    ...gated.comparability,
    perMetric: {
      "raw-counts": ineligible(),
      "tracker-classification": ineligible(),
      "shields-simulation": ineligible(),
      "consent-verification": ineligible(),
      "detector-findings": ineligible()
    }
  };
  const findings = buildFindings(viewFromV2(gated, 2), null);

  const card = byId(findings, "shields-comparison");
  assert.equal(card.methodology, true);
  // The recorded token is translated for readers; the raw vocabulary never renders.
  assert.match(card.lead, /did not record the network egress region/);
  assert.doesNotMatch(card.lead, /unknown-dimension/);

  // The meta card describes the report, not the site: with otherwise-clean
  // evidence the bottom line must not call the visit review-worthy just
  // because the pair's deltas are refused.
  const bottom = byId(findings, "bottom-line");
  assert.equal(bottom.title, "Bottom line: few review signals in this visit");
  assert.equal(bottom.level, "ok");
});

test("a post-choice consent arm is never ranked against the plain-first-visit distribution", () => {
  // corpus-stats-builder, entryEligibleForCorpusRollups, and the researcher
  // export all exclude an accept-all or reject-all lead from the denominator.
  // The findings board is the fourth consumer and must apply the same rule, or
  // it ranks an accepted-cookies state against a pre-consent population.
  const corpus = makeCorpus(60);
  const observed = makeResult({
    firstPartyDomain: "consented.example",
    domains: [makeTrackerDomain("ads.example", 40, "AdCo", "advertising")],
    thirdPartyDomains: 24,
    thirdPartyCookies: 14
  });
  const observedFindings = buildFindings(viewFromV1Report(observed), corpus);
  assert.notEqual(byId(observedFindings, "third-party-services").benchmark, undefined);
  assert.notEqual(byId(observedFindings, "third-party-cookies").benchmark, undefined);

  for (const consentMode of ["accept-all", "reject-all"] as const) {
    const postChoice: ScanResult = { ...observed, conditions: { ...observed.conditions, consentMode } };
    const findings = buildFindings(viewFromV1Report(postChoice), corpus);
    assert.equal(byId(findings, "third-party-services").benchmark, undefined);
    assert.equal(byId(findings, "third-party-cookies").benchmark, undefined);
  }
});

test("every exhausted v1 budget censors the evidence families, not only the request cap", () => {
  // The response-byte and upload-byte budgets tear down proxied traffic the
  // same way the request cap does, so a byte-capped run must not be ranked or
  // allowed to publish an unhedged absence claim either.
  const corpus = makeCorpus(60);
  const budgets = [
    "The scan stopped loading additional response bytes after reaching the 64 MiB aggregate response-byte budget.",
    "The scan stopped forwarding additional request bytes after reaching the 8 MiB aggregate upload-byte budget."
  ];

  for (const warning of budgets) {
    const result = makeResult({ firstPartyDomain: "truncated.example", thirdPartyDomains: 7 });
    const capped: ScanResult = { ...result, warnings: [warning] };
    const view = viewFromV1Report(capped);
    assert.equal(familyCensoredOnRun(displayRunView(view), "requests"), true);
    assert.equal(requestEvidenceState(displayRunView(view)), "incomplete");

    const findings = buildFindings(view, corpus);
    assert.equal(byId(findings, "third-party-services").benchmark, undefined);
    assert.match(byId(findings, "third-party-cookies").detail, /cut short/);
  }
});

test("a budget reason the note table does not enumerate still reads as prose", () => {
  const result = makeResult({ firstPartyDomain: "truncated.example" });
  const capped: ScanResult = {
    ...result,
    warnings: ["The scan stopped loading additional response bytes after reaching the 64 MiB aggregate response-byte budget."]
  };
  const notes = runCensorshipNotes(displayRunView(viewFromV1Report(capped)));
  assert.equal(notes.length > 0, true);
  for (const note of notes) {
    // The raw wire slug must never reach the reader.
    assert.doesNotMatch(note, /budget-exhausted:/);
  }
  assert.equal(
    notes.some((note) => note.includes("response-byte budget")),
    true
  );
});

test("a reject arm whose request evidence was cut short never gets the reassuring consent card", () => {
  // "No catalogued trackers" is an absence claim over the reject visit's
  // request log. Censored collection makes that a floor, not reassurance, and
  // nothing in the suite covered the guard that says so: it could be deleted
  // outright and every test stayed green.
  const baseline = viewFromV2(makeConsentInterventionReportV2R2(), 2);
  const reassuringCard = byId(buildFindings(baseline, null), "consent-comparison");
  assert.equal(reassuringCard.icon, "shield-check");
  assert.equal(reassuringCard.level, "ok");
  assert.match(reassuringCard.title, /had no catalogued trackers/);

  const view = viewFromV2(makeConsentInterventionReportV2R2(), 2);
  const variant = view.runs.find((run) => run.label === "variant");
  if (!variant) throw new Error("fixture invariant");
  variant.quality.byFamily = {
    ...(variant.quality.byFamily ?? {}),
    requests: { outcome: "censored", reasons: ["budget-exhausted:public-request-records"] }
  };

  const card = byId(buildFindings(view, null), "consent-comparison");
  assert.notEqual(card.icon, "shield-check");
  assert.equal(card.level, "info");
  assert.match(card.title, /cut short/);
  assert.match(card.detail, /covers only what was recorded before the cutoff/);
});

test("a fingerprint observer that never read a frame cannot publish a clean absence", () => {
  // The observer failing is not a budget: it is the instrument not running.
  // On v1 the scanner warning is the only channel that records it, and without
  // it the card published "No fingerprint-like API calls observed" at level
  // "ok" for a scan that never looked.
  const observed = makeResult({ firstPartyDomain: "quiet.example" });
  const clean = byId(buildFindings(viewFromV1Report(observed), null), "fingerprint-apis");
  assert.equal(clean.level, "ok");
  assert.match(clean.title, /No fingerprint-like API calls observed/);
  assert.doesNotMatch(clean.detail, /cut short/);

  const blindfolded: ScanResult = {
    ...observed,
    warnings: [FINGERPRINT_OBSERVER_CAPTURE_LOSS_WARNING]
  };
  const view = viewFromV1Report(blindfolded);
  const run = displayRunView(view);
  assert.equal(familyCensoredOnRun(run, "fingerprinting"), true);
  assert.equal(familyCensoredOnRun(run, "detector-output"), true);
  // Scoped: a dead fingerprint observer says nothing about the request log.
  assert.equal(familyCensoredOnRun(run, "requests"), false);
  assert.equal(familyCensoredOnRun(run, "cookies"), false);
  assert.equal(requestEvidenceState(run), "complete");

  const card = byId(buildFindings(view, null), "fingerprint-apis");
  assert.notEqual(card.level, "ok");
  assert.match(card.detail, /covers only what was recorded before the cutoff/);

  // The reason reaches the reader as prose, never as a wire slug.
  for (const note of runCensorshipNotes(run)) {
    assert.doesNotMatch(note, /capture-loss:/);
  }
  assert.equal(
    runCensorshipNotes(run).some((note) => note.includes("in-page fingerprint observer")),
    true
  );
});

test("an incomplete pixel-body read never publishes a no-identifier-fields claim", () => {
  const result = makeResult({ firstPartyDomain: "shop.example" });
  result.pixelEvents = [
    {
      platform: "Meta",
      product: "Meta Pixel",
      events: ["PageView"],
      advancedMatching: [],
      requests: 1
    }
  ];

  const complete = byId(buildFindings(viewFromV1Report(result), null), "pixel-events");
  assert.match(complete.detail, /No advanced-matching identifier fields were observed/);

  result.warnings = [PIXEL_DECODE_CAPTURE_LOSS_WARNING];
  const view = viewFromV1Report(result);
  const run = displayRunView(view);
  assert.equal(familyCensoredOnRun(run, "detector-output"), true);
  assert.equal(familyCensoredOnRun(run, "requests"), false);

  const partial = byId(buildFindings(view, null), "pixel-events");
  assert.doesNotMatch(partial.detail, /No advanced-matching identifier fields were observed/);
  assert.match(partial.detail, /Pixel decoding was incomplete/);
  assert.match(partial.detail, /advanced-matching identifier fields is unknown/);
});

test("a warn-level Shields card raises the bottom line instead of being outranked by it", () => {
  // The Shields card used to be spliced in after overallLevel was computed, so
  // a visit with ten or more matched requests could still headline "few review
  // signals" while a warn card sat directly beneath it.
  const result = makeResult({ totalRequests: 40 });
  result.summary.shieldsBlockedRequests = 12;
  result.conditions.adblock = { active: true, engine: "loaded" } as never;

  const findings = buildFindings(viewFromV1Report(result), null);
  const shields = byId(findings, "shields-blocked");
  assert.equal(shields.level, "warn");
  const bottomLine = byId(findings, "bottom-line");
  assert.equal(bottomLine.level, "warn");
  assert.match(bottomLine.title, /review-worthy signals/);
  // The Shields card still renders immediately under the bottom line.
  assert.equal(findings[0].id, "bottom-line");
  assert.equal(findings[1].id, "shields-blocked");
});

test("the services card quantifies the domains the catalog could not name", () => {
  const uncatalogued = (domain: string): DomainSummary => ({
    domain,
    requests: 1,
    thirdParty: true,
    tracker: null,
    statuses: [200],
    resourceTypes: ["script"]
  });

  // A catalog match plus two unnamed domains: the card must say how much of
  // the visit it could not account for, not only what it recognized.
  const mixed = buildFindings(
    viewFromV1Report(
      makeResult({
        domains: [
          makeTrackerDomain("google-analytics.com", 1, "Google", "analytics"),
          uncatalogued("unknown-a.example"),
          uncatalogued("unknown-b.example")
        ],
        thirdPartyRequests: 3,
        thirdPartyDomains: 3
      })
    ),
    null
  );
  const mixedDetail = byId(mixed, "third-party-services").detail;
  assert.match(mixedDetail, /2 of the 3 third-party domains recorded here matched no catalog entry/);
  assert.match(mixedDetail, /limit of catalog coverage, not evidence about the site/);

  // Nothing matched, but third parties were still present. The old copy said
  // only that unlabeled parties "may" exist; the count is what stops a reader
  // treating no-matches as no-third-parties.
  const unmatched = buildFindings(
    viewFromV1Report(
      makeResult({
        domains: [uncatalogued("unknown-a.example")],
        thirdPartyRequests: 1,
        thirdPartyDomains: 1
      })
    ),
    null
  );
  const unmatchedCard = byId(unmatched, "third-party-services");
  assert.match(unmatchedCard.title, /No known services matched/);
  assert.match(unmatchedCard.detail, /1 of the 1 third-party domain recorded here matched no catalog entry/);

  // Full coverage must not borrow the shortfall sentence.
  const covered = buildFindings(
    viewFromV1Report(
      makeResult({
        domains: [makeTrackerDomain("google-analytics.com", 1, "Google", "analytics")],
        thirdPartyRequests: 1,
        thirdPartyDomains: 1
      })
    ),
    null
  );
  const coveredDetail = byId(covered, "third-party-services").detail;
  assert.match(coveredDetail, /Every one of the 1 third-party domain recorded here matched a catalog entry/);
  assert.doesNotMatch(coveredDetail, /matched no catalog entry/);

  // A visit with no third parties at all has nothing to quantify.
  const none = buildFindings(
    viewFromV1Report(makeResult({ domains: [], thirdPartyRequests: 0, thirdPartyDomains: 0 })),
    null
  );
  assert.doesNotMatch(byId(none, "third-party-services").detail, /recorded here matched/);
});
