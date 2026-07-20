import assert from "node:assert/strict";
import { test } from "node:test";
import { createConsentComparisonReport, createGpcComparisonReport, createShieldsComparisonReport } from "./compare-reports";
import { buildFindings, type Finding, type FindingIconKey } from "./report-findings";
import type { CorpusStats } from "./corpus-stats";
import { makeConsentInterventionReportV2R2, makeShieldsInterventionReportV2R2 } from "./scan-report-v2-r2-fixtures";
import { makePublicSingleReportV2 } from "./scan-report-v2-fixtures";
import { viewFromV1Report, viewFromV2 } from "./scan-report-views";
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
  assert.match(bottomLine.title, /blocked\.example did not load \(HTTP 403\)/);
  assert.match(bottomLine.lead, /HTTP 403/);
  assert.doesNotMatch(bottomLine.title, /few review signals/);
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
  assert.equal(services.title, "Tracking and ad services responded during this visit");
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
  assert.match(byId(withCorpus, "third-party-services").benchmark ?? "", /90th-percentile mark for .* across the 60 fully measured sites/);
  assert.match(byId(withCorpus, "bottom-line").detail, /percentiles from the 60 fully measured sites/);

  // A corpus that also records its coverage names both concepts: the
  // measured sample and the larger set of sites scanned.
  const withCoverage = buildFindings(viewFromV1Report(result), { ...makeCorpus(60), coverageSiteCount: 62 });
  assert.match(
    byId(withCoverage, "bottom-line").detail,
    /60 fully measured sites \(of 62 sites scanned; failed and request-capped visits are excluded from statistics\)/
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

test("a consent comparison flags trackers that survive Reject all", () => {
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
  assert.equal(card.level, "warn");
  assert.match(card.title, /Requests were sent .* in the visit that clicked Reject all/);
  assert.match(card.lead, /Google/);
  assert.match(card.detail, /not a violation ruling/);
  // The claim must stay observational: recording spans the whole visit and the
  // click is dispatched, not verified.
  assert.match(card.detail, /v1 report records only/);
  assert.match(card.detail, /cannot verify/);
  assert.match(card.detail, /before and after the click/);
  assert.match(card.detail, /legitimate interest/);
  // The diff pointer must describe set membership, not an effect of rejecting.
  assert.match(card.detail, /appeared only in the visit that clicked Accept all/);
  assert.doesNotMatch(card.detail, /did remove/);
  assert.match(card.evidence, /30 with the accept-all click, 6 with the reject-all click/);
});

test("a consent finding never upgrades unanswered requests into receipt", () => {
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
  assert.match(card.title, /Requests were sent/);
  assert.match(card.lead, /recorded no response, so receipt is unproven/);
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
  assert.match(card.title, /No consent banner could be clicked/);
  assert.match(card.lead, /pre-consent state/);
});

test("a clean reject run earns the ok consent card, and a missing reject control stays neutral", () => {
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

  const okCard = byId(buildFindings(viewFromV1Report(consentPair(acceptRun, cleanRejectRun)), null), "consent-comparison");
  assert.equal(okCard.level, "ok");
  assert.match(okCard.title, /The visit that clicked Reject all had no catalogued trackers/);

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
  assert.match(card.title, /What you type was sent to 1 third party/);
  assert.match(card.lead, /collect\.example/);
  // A loud signal forces the bottom line loud, and bottom line still leads.
  assert.equal(findings[0].id, "bottom-line");
  assert.equal(byId(findings, "bottom-line").level, "loud");
});

test("keystroke leak severity escalates on one-way hashing, not reversible encodings", () => {
  // Plain-text leak = functional type-ahead/autocomplete → calmer "warn".
  const plain = makeResult({ fingerprintDetections: [makeKeystrokeDetection(["plain"])] });
  const plainCard = byId(buildFindings(viewFromV1Report(plain), null), "keystroke-exfiltration");
  assert.equal(plainCard.level, "warn");
  assert.match(plainCard.title, /Your typing is sent to/);

  // Reversible base64/hex is common in legitimate APIs, so it stays "warn", not an alarm.
  const reversible = makeResult({ fingerprintDetections: [makeKeystrokeDetection(["base64"])] });
  const reversibleCard = byId(buildFindings(viewFromV1Report(reversible), null), "keystroke-exfiltration");
  assert.equal(reversibleCard.level, "warn");
  assert.match(reversibleCard.title, /Your typing is sent to/);

  // A one-way hash cannot drive a type-ahead, so it reads as deliberate capture → "loud".
  const hashed = makeResult({ fingerprintDetections: [makeKeystrokeDetection(["sha256"])] });
  const hashedCard = byId(buildFindings(viewFromV1Report(hashed), null), "keystroke-exfiltration");
  assert.equal(hashedCard.level, "loud");
  assert.match(hashedCard.title, /What you type was sent to/);
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
  assert.match(informational.lead, /no request to a catalogued tracking company was recorded/);
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
  assert.match(card.title, /never names/);
  assert.match(card.lead, /Criteo was sent requests during this visit but is never named/);
  assert.match(card.detail, /not automatically a violation/);
});

test("reports a clean policy check at ok level", () => {
  const result = makeResult({});
  result.privacyPolicy = {
    url: "https://example.com/privacy",
    claims: [{ kind: "no-selling-or-sharing", quote: "We do not sell your personal information." }],
    mentionedEntities: [],
    unmentionedEntities: [],
    policyTextLength: 5000
  };

  const card = byId(buildFindings(viewFromV1Report(result), null), "privacy-policy");
  assert.equal(card.level, "ok");
  assert.match(card.title, /no checked statement contradicted/);
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
