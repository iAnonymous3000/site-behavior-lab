import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  PAGE_SUBJECT_UNVERIFIED_WARNING,
  SUSPECTED_CHALLENGE_OR_SOFT_BLOCK_WARNING
} from "./bot-wall-classifier";
import { createConsentComparisonReport, createGpcComparisonReport, createShieldsComparisonReport } from "./compare-reports";
import { corpusCohortIdentityForView } from "./corpus-cohort";
import { GPC_WORKER_CAPTURE_LOSS_WARNING } from "./gpc-injection";
import { buildFindings, requestProvenanceSummary, type Finding, type FindingIconKey } from "./report-findings";
import { buildReportHeadline } from "./report-headline";
import { HEADLINE_PLATFORMS, isTrackingTrackerMatch } from "./report-insights";
import { COMPARED_POLICY_CLAIM_KINDS } from "./privacy-policy";
import { reviewedOwnershipRelationship } from "./reviewed-ownership";
import type { CorpusStats } from "./corpus-stats";
import { readStoredScanReport } from "./scan-report-reader";
import {
  FINGERPRINT_OBSERVER_CAPTURE_LOSS_WARNING,
  INVALID_UPSTREAM_RESPONSE_WARNING,
  PIXEL_DECODE_CAPTURE_LOSS_WARNING
} from "./scan-runtime";
import { buildComparisonDiffV2, evaluateQuality } from "./scan-report-v2-evaluators";
import { R2_NAVIGATION_STATUS_UNREPRESENTABLE } from "./scan-report-v2-http-status";
import { evaluateComparabilityR2 } from "./scan-report-v2-r2-evaluators";
import {
  makeConsentInterventionReportV2R2,
  makeGpcInterventionReportV2R2,
  makePublicSingleReportV2R2,
  makeShieldsInterventionReportV2R2
} from "./scan-report-v2-r2-fixtures";
import { makeInterventionComparisonReportV2, makePublicSingleReportV2 } from "./scan-report-v2-fixtures";
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
  type NetworkRequestRecord,
  type PrivacyPolicyClaimKind,
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
  assert.match(bottomLine.title, /requested page returned HTTP 403/);
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
  // The copy must not claim the code was deliberately withheld: post
  // scanner-warning-patterns-v8 the exact code survives in the scan warnings,
  // and older r2 reports lost it to redaction rather than to a choice.
  assert.match(bottomLine.lead, /status field is left empty rather than coerced/);
  assert.doesNotMatch(bottomLine.lead, /withheld/);
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
  assert.match(card.lead, /1 fewer tracking-related service request/);
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

test("major-platform evidence counts exact tracking-role request rows on a mixed matched host", () => {
  const result = makeResult({
    firstPartyDomain: "news.example",
    domains: [
      makeTrackerDomain("{label}.google.com", 56, "Google", "advertising"),
      // A catalogued tracking host that is NOT one of the headline platforms.
      // Without it, dropping the platform scoping still counts 48 and the test
      // stays green through the mutation it exists to catch.
      makeTrackerDomain("{label}.casalemedia.example", 120, "Casale", "advertising")
    ],
    thirdPartyRequests: 176,
    thirdPartyDomains: 2
  });
  // The host summary preserves the catalog identity because some rows match,
  // but these eight exact request rows did not match the catalog. Bounded to
  // the Google tail: nulling from 48 onward would also strip the non-platform
  // host and undo the discrimination it was added for.
  for (const request of result.requests.slice(48, 56)) request.tracker = null;
  // NO summary override. `makeResult` derives knownTrackerRequests from the
  // domain summary (176), which differs from the 48 exact rows this finding
  // must count. Pinning it to 48 made the fixture agree with itself no matter
  // which source the implementation read, so a switch to the summary counted
  // as a pass. The gap between 48 and 176 is the whole discriminating power.
  assert.notEqual(
    result.summary.knownTrackerRequests,
    48,
    "the fixture must not agree with the expected count by construction"
  );

  const platforms = byId(buildFindings(viewFromV1Report(result), null), "named-platforms");
  assert.match(platforms.lead, /catalogued domains for Google/);
  assert.equal(platforms.evidence, "48 requests to these platforms.");
  assert.doesNotMatch(platforms.evidence, /56/);
});

test("receipt wording attributes a shared-host response to its exact request entity", () => {
  const result = makeResult({
    domains: [makeTrackerDomain("shared-vendor.example", 2, "Pinterest", "advertising")],
    totalRequests: 2,
    thirdPartyRequests: 2,
    thirdPartyDomains: 1
  });
  result.requests[0].status = null;
  result.requests[1].tracker = {
    domain: "sentry.io",
    entity: "Sentry",
    category: "error monitoring",
    confidence: "curated"
  };

  // The v1 host summary retains Pinterest from the first request and the 200
  // response from Sentry's second request. The generic reader accepts this
  // legitimate mixed-match shape, so presentation code must not attribute
  // Sentry's response to Pinterest through that lossy summary.
  const read = readStoredScanReport(result);
  assert.equal(read.ok, true, "shared-host fixture must remain reader-valid");
  if (!read.ok || read.stored.schemaVersion !== 1) assert.fail("expected a valid v1 report");
  const view = viewFromV1Report(read.stored.report);

  const headline = buildReportHeadline(view);
  assert.match(headline.headline, /contacted catalogued Pinterest domains/);
  assert.match(headline.subhead, /had requests dispatched, though no response was recorded/);
  assert.doesNotMatch(headline.subhead, /Pinterest recorded responses/);

  const services = byId(buildFindings(view, null), "third-party-services");
  assert.equal(services.title, "Requests were dispatched to catalogued service domains");
  assert.notEqual(services.title, "Catalogued service domains recorded responses during this visit");
});

test("major-platform discovery reads exact request matches instead of a lossy host summary", () => {
  const result = makeResult({
    firstPartyDomain: "news.example",
    domains: [
      makeTrackerDomain(
        "mixed-vendor.example",
        2,
        "Sentry",
        "error monitoring"
      )
    ],
    thirdPartyRequests: 2,
    thirdPartyDomains: 1
  });
  // A v1 host summary carries one catalog identity for the host, while exact
  // request rows can carry different reviewed matches. The Meta row must not
  // disappear merely because the lossy summary retained Sentry.
  result.requests[1].tracker = {
    domain: "facebook.net",
    entity: "Meta",
    category: "social / advertising pixel",
    confidence: "curated"
  };

  const platforms = byId(
    buildFindings(viewFromV1Report(result), null),
    "named-platforms"
  );
  assert.match(platforms.title, /catalogued major-platform domains/);
  assert.match(platforms.lead, /Meta/);
  assert.equal(platforms.evidence, "1 request to these platforms.");
  assert.doesNotMatch(
    `${platforms.title} ${platforms.lead}`,
    /No requests to major-platform/
  );
});

test("committed major-platform evidence reconciles to retained request rows, not host summaries", () => {
  const reportName = "20260727-3f4388acdcec5a5a1883ad2909ebf88b.json";
  const raw: unknown = JSON.parse(
    readFileSync(path.join(process.cwd(), "public", "reports", reportName), "utf8")
  );
  const read = readStoredScanReport(raw);
  assert.equal(read.ok, true, `reader rejected committed report ${reportName}`);
  if (!read.ok || read.stored.schemaVersion !== 1) {
    assert.fail(`expected committed v1 report ${reportName}`);
  }
  const report = read.stored.report;
  assert.equal(report.reportType, "comparison");
  if (report.reportType !== "comparison") assert.fail("expected comparison report");

  const baseline = report.baseline;
  const inheritedHostSummaryCount = baseline.domains
    .filter(
      (domain) =>
        domain.thirdParty &&
        domain.tracker !== null &&
        HEADLINE_PLATFORMS.includes(domain.tracker.entity) &&
        isTrackingTrackerMatch(domain.tracker) &&
        reviewedOwnershipRelationship(baseline.summary.firstPartyDomain, domain.domain).kind !==
          "same-organization"
    )
    .reduce((total, domain) => total + domain.requests, 0);
  const exactRequestCount = baseline.requests.filter(
    (request) =>
      request.thirdParty &&
      request.tracker !== null &&
      HEADLINE_PLATFORMS.includes(request.tracker.entity) &&
      isTrackingTrackerMatch(request.tracker) &&
      reviewedOwnershipRelationship(baseline.summary.firstPartyDomain, request.domain).kind !==
        "same-organization"
  ).length;

  assert.equal(inheritedHostSummaryCount, 56, "fixture must preserve the overcounting shape");
  assert.equal(exactRequestCount, 48, "fixture must preserve the exact retained-row count");
  const platforms = byId(buildFindings(viewFromV1Report(report), null), "named-platforms");
  assert.equal(platforms.evidence, "48 requests to these platforms.");
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
      makeTrackerDomain("newrelic.com", 2, "New Relic", "performance monitoring"),
      makeTrackerDomain("security.example", 1, "Security Co", "security / anti-abuse"),
      makeTrackerDomain("cdn.example", 1, "CDN Co", "cdn / hosting"),
      makeTrackerDomain("consent.example", 1, "Consent Co", "consent management")
    ],
    thirdPartyRequests: 7,
    thirdPartyDomains: 5
  });

  const services = byId(buildFindings(viewFromV1Report(result), null), "third-party-services");
  assert.equal(services.title, "Operational service matches were recorded");
  assert.equal(services.level, "info");
  assert.match(services.detail, /operational, support, security, consent-management, or hosting roles/);
});

test("an unclassified service remains visible without becoming a tracking claim", () => {
  const result = makeResult({
    domains: [makeTrackerDomain("experiment.example", 3, "Google", "experimentation")],
    thirdPartyRequests: 3,
    thirdPartyDomains: 1
  });

  const findings = buildFindings(viewFromV1Report(result), null);
  const services = byId(findings, "third-party-services");
  assert.equal(services.level, "info");
  assert.equal(services.title, "Identified services have unclassified functional roles");
  assert.match(services.lead, /Google/);
  assert.match(services.detail, /not a basis for calling the service tracking-related/);
  assert.doesNotMatch(`${services.title} ${services.lead}`, /No known services matched/);

  const platforms = byId(findings, "named-platforms");
  assert.equal(platforms.level, "info");
  assert.equal(
    platforms.title,
    "Major-platform domains were identified without a tracking-role assignment"
  );
  assert.match(platforms.lead, /catalogued domains for Google/);
  assert.doesNotMatch(`${platforms.title} ${platforms.lead}`, /No requests .* were recorded/);
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
  // A legacy v1-only artifact carries no v2 cohort, so ranking a v2 report
  // against its compatibility projection would compare across methodologies.
  // V2 falls back to fixed thresholds until the supplied artifact contains
  // its exact cohort.
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
  assert.match(
    byId(matched, "bottom-line").detail,
    /exact schema, methodology, tracker-catalog, ServiceRole-taxonomy, metric-contract, producer, and Global Privacy Control cohort/
  );
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
  assert.match(partialCard.title, /Only the Accept all control's activation was recorded/);
  assert.match(partialCard.lead, /does not measure the reject all choice/);
});

test("a one-sided consent pair reports activation, not clickability, and admits an unconfirmed dispatch", () => {
  // The producer writes `clicked: false` both for a control it never found and
  // for a click it dispatched on a candidate that never visibly responded (its
  // own run warning says exactly that), and the v1 wire cannot tell the two
  // apart. So the card may not say the control could not be clicked, and its
  // causes may not stop at the banner's design and the scanner's catalog.
  const acceptRun = {
    ...makeResult({ firstPartyDomain: "shop.example", thirdPartyRequests: 20 }),
    consentInteraction: { mode: "accept-all" as const, clicked: true, cmp: "Cookiebot" }
  };
  const unactivatedRejectRun = {
    ...makeResult({ firstPartyDomain: "shop.example", thirdPartyRequests: 18 }),
    consentInteraction: { mode: "reject-all" as const, clicked: false }
  };

  const card = byId(
    buildFindings(viewFromV1Report(consentPair(acceptRun, unactivatedRejectRun)), null),
    "consent-comparison"
  );
  assert.doesNotMatch(`${card.title} ${card.lead} ${card.detail} ${card.evidence}`, /could (?:not )?be clicked/i);
  assert.match(card.title, /Only the Accept all control's activation was recorded/);
  assert.match(card.detail, /no observable reaction/);

  // The mirrored pair (only the reject visit activated a control) reads the
  // same way, so neither direction publishes a clickability claim.
  const unactivatedAcceptRun = {
    ...makeResult({ firstPartyDomain: "shop.example", thirdPartyRequests: 20 }),
    consentInteraction: { mode: "accept-all" as const, clicked: false }
  };
  const rejectRun = {
    ...makeResult({ firstPartyDomain: "shop.example", thirdPartyRequests: 18 }),
    consentInteraction: { mode: "reject-all" as const, clicked: true, cmp: "Cookiebot" }
  };
  const mirrored = byId(
    buildFindings(viewFromV1Report(consentPair(unactivatedAcceptRun, rejectRun)), null),
    "consent-comparison"
  );
  assert.doesNotMatch(
    `${mirrored.title} ${mirrored.lead} ${mirrored.detail} ${mirrored.evidence}`,
    /could (?:not )?be clicked/i
  );
  assert.match(mirrored.title, /Only the Reject all control's activation was recorded/);
});

test("a both-arms-unactivated pair names the unconfirmed dispatch alongside the region and catalog causes", () => {
  // Both arms carry the same `clicked: false` record the one-sided branch
  // hedges: it also covers a click the scanner dispatched on a candidate that
  // never visibly responded. A causal enumeration that stops at region gating
  // and catalog coverage states as fact that no click was dispatched, which
  // this pair of visits did not establish.
  const acceptRun = {
    ...makeResult({ firstPartyDomain: "shop.example", thirdPartyRequests: 21 }),
    consentInteraction: { mode: "accept-all" as const, clicked: false }
  };
  const rejectRun = {
    ...makeResult({ firstPartyDomain: "shop.example", thirdPartyRequests: 19 }),
    consentInteraction: { mode: "reject-all" as const, clicked: false }
  };
  const unconfirmedDispatch =
    /a click may have been dispatched on a candidate that showed no observable reaction within the scanner's confirmation window/;

  const card = byId(buildFindings(viewFromV1Report(consentPair(acceptRun, rejectRun)), null), "consent-comparison");
  assert.match(card.title, /No consent control activation was recorded/);
  assert.match(card.detail, unconfirmedDispatch);

  // The same sentence, in the same vocabulary, as the one-sided branch: the
  // two enumerations describe one wire record and may not drift apart.
  const oneSided = byId(
    buildFindings(
      viewFromV1Report(
        consentPair({ ...acceptRun, consentInteraction: { mode: "accept-all" as const, clicked: true } }, rejectRun)
      ),
      null
    ),
    "consent-comparison"
  );
  assert.match(oneSided.detail, unconfirmedDispatch);
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

  const operationalOnly: ScanResult = {
    ...base,
    cnameCloaks: [
      {
        host: "errors.shop.example",
        cname: "ingest.sentry.io",
        tracker: {
          domain: "sentry.io",
          entity: "Sentry",
          category: "error monitoring",
          confidence: "curated"
        }
      }
    ]
  };
  assert.equal(
    buildFindings(viewFromV1Report(operationalOnly), null).some(
      (finding) => finding.id === "cname-cloaking"
    ),
    false,
    "historical operational aliases must not be republished as cloaked trackers"
  );

  const cloaked: ScanResult = {
    ...base,
    cnameCloaks: [
      {
        host: "metrics.shop.example",
        cname: "shop.eulerian.net",
        tracker: { domain: "eulerian.net", entity: "Eulerian", category: "advertising", confidence: "curated" }
      },
      {
        host: "errors.shop.example",
        cname: "ingest.sentry.io",
        tracker: {
          domain: "sentry.io",
          entity: "Sentry",
          category: "error monitoring",
          confidence: "curated"
        }
      }
    ]
  };
  const cloakedFindings = buildFindings(viewFromV1Report(cloaked), null);
  const card = byId(cloakedFindings, "cname-cloaking");
  assert.equal(card.level, "warn");
  assert.match(card.title, /1 tracker hidden behind a first-party subdomain/);
  assert.match(card.lead, /Eulerian/);
  assert.match(card.evidence, /metrics\.shop\.example → shop\.eulerian\.net/);
  assert.doesNotMatch(`${card.title} ${card.lead} ${card.evidence}`, /Sentry|errors\.shop\.example/);

  const services = byId(cloakedFindings, "third-party-services");
  assert.equal(services.title, "Tracking services were identified behind first-party aliases");
  assert.match(`${services.lead} ${services.evidence}`, /Eulerian/);
  assert.doesNotMatch(
    `${services.title} ${services.lead} ${services.detail}`,
    /without being classified as tracking services/
  );
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
  assert.match(card.title, /requests to tracking-service entities appeared before any choice/);
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
  assert.match(informational.lead, /before the scanner made any consent choice/);
  assert.match(informational.lead, /Tracker-service observations are reported separately/);
  assert.doesNotMatch(informational.lead, /no request to a catalogued tracking-related service was recorded/);

  const noCmp = makeResult({
    domains: [makeTrackerDomain("google-analytics.com", 5, "Google", "analytics")],
    thirdPartyRequests: 5,
    thirdPartyDomains: 1
  });
  assert.equal(buildFindings(viewFromV1Report(noCmp), null).some((finding) => finding.id === "consent-banner"), false);
});

test("a shared IAB TCF endpoint is described as a framework endpoint, not as the platform that ran", () => {
  // consensu.org is the framework's shared endpoint, served for many
  // registered platforms, so the request identifies the standard and leaves
  // the platform that ran unnamed. Printing the acronym where a vendor name
  // goes publishes an identification this scan does not have.
  const frameworkDomain: DomainSummary = {
    domain: "mysite.mgr.consensu.org",
    requests: 2,
    thirdParty: true,
    tracker: null,
    statuses: [200],
    resourceTypes: ["script"]
  };
  const card = byId(
    buildFindings(
      viewFromV1Report(makeResult({ domains: [frameworkDomain], thirdPartyRequests: 2, thirdPartyDomains: 1 })),
      null
    ),
    "consent-banner"
  );
  assert.equal(card.title, "A shared consent framework endpoint answered");
  assert.doesNotMatch(card.lead, /IAB TCF, a consent management platform/);
  assert.match(card.lead, /shared by many consent management platforms/);
  assert.match(card.lead, /could not name the platform that served it/);
  assert.match(card.evidence, /Consent framework endpoint detected via a request to mysite\.mgr\.consensu\.org/);

  // A dedicated vendor host still names the vendor outright.
  const vendorCard = byId(
    buildFindings(
      viewFromV1Report(
        makeResult({
          domains: [
            {
              domain: "cdn.cookielaw.org",
              requests: 2,
              thirdParty: true,
              tracker: null,
              statuses: [200],
              resourceTypes: ["script"]
            }
          ],
          thirdPartyRequests: 2,
          thirdPartyDomains: 1
        })
      ),
      null
    ),
    "consent-banner"
  );
  assert.equal(vendorCard.title, "A consent management platform answered");
  assert.match(vendorCard.lead, /OneTrust, a consent management platform/);
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
  assert.match(card.title, /Lower values observed across comparable metrics in the visit with a privacy signal/);
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
  assert.match(cookiesOnly.title, /Lower values observed across comparable metrics/);

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
  assert.match(mixedCard.lead, /10 fewer tracking-related service requests/);
});

test("comparison cards never turn operational-only catalog deltas into tracking changes", () => {
  const baseline = makeResult({
    firstPartyDomain: "app.example",
    domains: [makeTrackerDomain("sentry.io", 4, "Sentry", "error monitoring")],
    totalRequests: 10,
    thirdPartyRequests: 4,
    thirdPartyDomains: 1
  });
  const variant = makeResult({
    firstPartyDomain: "app.example",
    domains: [
      {
        domain: "asset.example",
        requests: 4,
        thirdParty: true,
        tracker: null,
        statuses: [200],
        resourceTypes: ["script"]
      }
    ],
    totalRequests: 10,
    thirdPartyRequests: 4,
    thirdPartyDomains: 1
  });

  for (const [id, report] of [
    ["gpc-comparison", gpcPair(structuredClone(baseline), structuredClone(variant))],
    ["shields-comparison", shieldsPair(structuredClone(baseline), structuredClone(variant))]
  ] as const) {
    const card = byId(buildFindings(viewFromV1Report(report), null), id);
    assert.match(card.title, /No change observed/);
    assert.doesNotMatch(`${card.title} ${card.lead} ${card.detail}`, /fewer tracking|Sentry/);
    assert.match(card.lead, /tracking-related service requests/);
  }

  const emptyVariant = makeResult({
    firstPartyDomain: "app.example",
    totalRequests: 6,
    thirdPartyRequests: 0,
    thirdPartyDomains: 0
  });
  for (const [id, report] of [
    ["gpc-comparison", gpcPair(structuredClone(baseline), structuredClone(emptyVariant))],
    ["shields-comparison", shieldsPair(structuredClone(baseline), structuredClone(emptyVariant))]
  ] as const) {
    const card = byId(buildFindings(viewFromV1Report(report), null), id);
    assert.match(card.title, /Lower values observed across comparable metrics/);
    assert.match(card.lead, /4 fewer third-party requests/);
    assert.doesNotMatch(`${card.title} ${card.lead} ${card.detail}`, /tracking signals|Sentry/);
  }
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

test("the session-recording lead names only the event categories the detection recorded", () => {
  // The producing gate accepts any five of a sixteen-event vocabulary, so a
  // card that enumerates categories has to read this detection's own event
  // types: this one registered no scroll listener and no input listener.
  const sessionDetection = (eventTypes: string[]): FingerprintDetectionSummary => ({
    kind: "session-recording",
    heuristic: "interaction-listener-coverage-v1",
    count: 1,
    evidence: {
      eventTypes,
      listenerTargets: ["document", "window"],
      thirdPartyOrigins: ["https://recorder.example.net"],
      totalListenerCalls: 9
    }
  });
  const leadFor = (eventTypes: string[]): string =>
    byId(
      buildFindings(
        viewFromV1Report(
          makeResult({ firstPartyDomain: "www.shop.example", fingerprintDetections: [sessionDetection(eventTypes)] })
        ),
        null
      ),
      "session-recording-input-monitoring"
    ).lead;

  const pointerLead = leadFor(["click", "keydown", "mousedown", "touchstart", "visibilitychange"]);
  assert.doesNotMatch(pointerLead, /scroll/i);
  assert.doesNotMatch(pointerLead, /\binput\b/i);
  assert.match(pointerLead, /mouse/);
  assert.match(pointerLead, /touch/);
  assert.match(pointerLead, /click/);
  assert.match(pointerLead, /keyboard/);
  assert.match(pointerLead, /visibility/);

  // The categories that WERE recorded still get named.
  const scrollLead = leadFor(["mousemove", "scroll", "input", "wheel", "selectionchange"]);
  assert.match(scrollLead, /scroll/);
  assert.match(scrollLead, /\binput\b/);
  assert.match(scrollLead, /wheel/);
  assert.match(scrollLead, /selection/);
  assert.doesNotMatch(scrollLead, /visibility|touch|keyboard/i);

  // An event set the category map does not cover names no category at all
  // rather than falling back to a list the visit did not support.
  const unmappedLead = leadFor(["gotpointercapture", "auxclick", "dblclick", "drag", "focusin"]);
  assert.match(unmappedLead, /broad interaction listener coverage/);
  assert.doesNotMatch(unmappedLead, /scroll|visibility|keyboard/i);
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

test("frozen-v1 policy arrays retain actual tracking entities and discard non-tracking role matches", () => {
  const result = makeResult({
    domains: [
      makeTrackerDomain("track.criteo.com", 4, "Criteo", "advertising"),
      makeTrackerDomain("cdn.optimizely.com", 2, "Optimizely", "experimentation"),
      makeTrackerDomain("sdk.iad-01.braze.com", 2, "Braze", "customer engagement")
    ],
    thirdPartyDomains: 3
  });
  result.privacyPolicy = {
    url: "https://example.com/privacy",
    claims: [],
    mentionedEntities: ["Google"],
    unmentionedEntities: ["Criteo", "Optimizely", "Braze"],
    policyTextLength: 5000
  };

  const card = byId(buildFindings(viewFromV1Report(result), null), "privacy-policy");
  assert.equal(card.level, "info");
  // Scoped to what the matcher can prove: the stored list is alias-bounded and
  // the policy text is not retained, so an absolute "never names" cannot be
  // re-verified for any committed report.
  assert.match(card.title, /does not appear to name/);
  assert.match(card.lead, /Criteo was sent requests during this visit, but the policy text matched none of the names this scan knows that company by/);
  assert.doesNotMatch(`${card.lead} ${card.detail}`, /Optimizely|Braze|Google/);
  assert.match(card.detail, /not automatically a violation/);
  assert.match(card.evidence, /0 of 1 observed tracking company named in the policy/);
  assert.equal(card.claim?.mode, "presence");
});

test("frozen-v1 unclassified services cannot create a tracking-company policy claim", () => {
  const result = makeResult({
    domains: [
      makeTrackerDomain("cdn.optimizely.com", 2, "Optimizely", "experimentation"),
      makeTrackerDomain("sdk.iad-01.braze.com", 2, "Braze", "customer engagement")
    ],
    thirdPartyDomains: 2
  });
  result.privacyPolicy = {
    url: "https://example.com/privacy",
    claims: [],
    mentionedEntities: [],
    unmentionedEntities: ["Optimizely", "Braze"],
    policyTextLength: 5000
  };

  const card = byId(buildFindings(viewFromV1Report(result), null), "privacy-policy");
  assert.equal(card.level, "info");
  assert.match(card.title, /no statement this scan can check/);
  assert.doesNotMatch(`${card.title} ${card.lead} ${card.detail}`, /Optimizely|Braze|does not appear to name/);
  assert.match(card.evidence, /no catalogued tracking companies observed to check against it/);
  assert.equal(card.claim?.mode, "unavailable");
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

test("an uncheckable policy is a report fact and never raises the bottom line", () => {
  // gov.uk: every substantive card was ok and the headline was the calm
  // "showed few catalogued or fingerprint-like signals", yet the bottom line
  // read "this visit has review-worthy signals" -- driven only by this card,
  // whose own lead says it is "a limit of the automated check, not a finding
  // about the site either way".
  const result = makeResult({});
  result.privacyPolicy = {
    url: "https://example.com/privacy",
    claims: [],
    mentionedEntities: [],
    unmentionedEntities: [],
    policyTextLength: 5000
  };

  const findings = buildFindings(viewFromV1Report(result), null);
  const card = byId(findings, "privacy-policy");
  assert.match(card.title, /made no statement this scan can check/);
  assert.equal(card.level, "info");
  assert.equal(card.methodology, true);

  const bottom = byId(findings, "bottom-line");
  assert.equal(bottom.title, "Bottom line: few review signals in this visit");
  assert.equal(bottom.icon, "check");
});

test("a policy card that names an unmentioned tracker stays site evidence", () => {
  // The converse of the guard above: a transparency gap IS about the site, so
  // marking the unavailable branch methodology must not silence this one.
  const result = makeResult({
    domains: [makeTrackerDomain("ads.example", 10, "AdCo", "advertising")],
    thirdPartyRequests: 10,
    thirdPartyDomains: 1
  });
  result.privacyPolicy = {
    url: "https://example.com/privacy",
    claims: [],
    mentionedEntities: [],
    unmentionedEntities: ["AdCo"],
    policyTextLength: 5000
  };

  const card = byId(buildFindings(viewFromV1Report(result), null), "privacy-policy");
  assert.match(card.title, /does not appear to name/);
  assert.equal(card.level, "info");
  assert.notEqual(card.methodology, true);
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
  assert.doesNotMatch(card.lead, /Global Privacy Control is honored, but/);
  assert.match(card.detail, /never checked against request counts/);

  // A GPC claim is not merely uncontradicted, it is unchecked. Counting it as
  // a checkable statement published "Privacy policy read; no checked statement
  // contradicted" and "1 checkable statement matched" over zero comparisons,
  // on 8 committed reports. The card must say nothing was checked instead.
  assert.equal(card.level, "info");
  assert.equal(card.methodology, true);
  assert.match(card.title, /it made no statement this scan can check/);
  assert.match(card.evidence, /0 checkable statements matched/);
  assert.match(card.lead, /nothing was compared against this visit's evidence/);
});

test("a claim kind the board never compares is never counted as checkable", () => {
  // The reassuring "no checked statement contradicted" branch is only honest
  // while every claim counted as checkable actually gets compared. Rather than
  // trusting that the comparison block and the predicate stay in step, walk
  // every kind in the wire vocabulary: a kind outside
  // COMPARED_POLICY_CLAIM_KINDS must produce the unavailable card, and a kind
  // inside it must produce a real comparison. A newly added kind fails here
  // until someone decides which side it belongs on.
  const ALL_KINDS: PrivacyPolicyClaimKind[] = [
    "no-cookies",
    "no-third-party-cookies",
    "no-selling-or-sharing",
    "honors-gpc"
  ];

  for (const kind of ALL_KINDS) {
    const result = makeResult({
      domains: [makeTrackerDomain("ads.example.net", 40, "AdCo", "advertising")],
      thirdPartyRequests: 40,
      thirdPartyDomains: 1
    });
    result.privacyPolicy = {
      url: "https://example.com/privacy",
      claims: [{ kind, quote: quoteForClaimKind(kind) }],
      // Keep the entity sides empty so the only thing under test is whether
      // the claim itself counted as checkable.
      mentionedEntities: ["AdCo"],
      unmentionedEntities: [],
      policyTextLength: 5000
    };
    const card = byId(
      buildFindings(viewFromV1Report(result), null),
      "privacy-policy"
    );

    if (COMPARED_POLICY_CLAIM_KINDS.includes(kind)) {
      assert.match(
        card.evidence,
        /1 checkable statement matched/,
        `${kind} is compared, so it must count as checkable`
      );
      assert.doesNotMatch(
        card.title,
        /made no statement this scan can check/,
        `${kind} is compared, so the card must not claim nothing was checkable`
      );
    } else {
      assert.match(
        card.evidence,
        /0 checkable statements matched/,
        `${kind} is never compared, so it must not count as checkable`
      );
      assert.match(
        card.title,
        /made no statement this scan can check/,
        `${kind} is never compared, so the card must say so`
      );
    }
  }
});

function quoteForClaimKind(kind: PrivacyPolicyClaimKind): string {
  switch (kind) {
    case "no-cookies":
      return "We do not use cookies.";
    case "no-third-party-cookies":
      return "We do not use third-party cookies.";
    case "no-selling-or-sharing":
      return "We do not sell or share your personal information.";
    case "honors-gpc":
      return "We honor Global Privacy Control signals.";
  }
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
    requests,
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
  assert.match(card.lead, /55 fewer third-party requests and 60 fewer tracking-related service requests/);
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

test("an uncatalogued cross-site host count never renders ok under its own high badge", () => {
  // The services card scored only catalog matches, so a visit to 40 hosts that
  // the catalog cannot name rendered "ok" and "No known services matched" while
  // the SAME card carried a "High third-party domains count" badge and
  // ReportFacts scored the run "loud". Level, title and badge now come from one
  // number.
  for (const [hosts, expectedLevel] of [
    [2, "info"],
    [20, "warn"],
    [40, "loud"]
  ] as const) {
    const result = makeResult({
      firstPartyDomain: "example.com",
      domains: Array.from({ length: hosts }, (_unused, index) => ({
        domain: `host${index}.example`,
        requests: 3,
        thirdParty: true,
        tracker: null,
        statuses: [200],
        resourceTypes: ["script"]
      })),
      thirdPartyRequests: hosts * 3,
      thirdPartyDomains: hosts
    });

    const findings = buildFindings(viewFromV1Report(result), null);
    const card = byId(findings, "third-party-services");
    assert.equal(card.level, expectedLevel, `${hosts} hosts should score ${expectedLevel}`);
    if (expectedLevel === "warn" || expectedLevel === "loud") {
      assert.match(card.title, new RegExp(`${hosts} cross-site hosts recorded, none matched`));
      assert.doesNotMatch(card.title, /No known services matched/);
      // The summary must not stay green while a card is loud.
      assert.equal(byId(findings, "bottom-line").icon, "alert");
    }
  }
});

test("a quiet-only board reads as few signals, and PageGraph provenance is a report fact", () => {
  // "quiet" is the level a flat comparison delta and an absent-provenance note
  // carry. It is only reachable when every metric card is already "ok"
  // (metricSeverity returns "ok" at zero and "info" at one), so reading it as
  // review-worthy put an alert icon and "this visit has review-worthy signals"
  // over a board whose every substantive card said ok.
  const pagegraph = JSON.parse(JSON.stringify(makePublicSingleReportV2())) as ReturnType<
    typeof makePublicSingleReportV2
  >;
  pagegraph.run.conditions.automation = "brave-pagegraph";
  const findings = buildFindings(viewFromV2(pagegraph, 1), null);

  // Whether the export carried initiator metadata is a property of the
  // artifact, not the site, so it must not drive the bottom line.
  const provenance = byId(findings, "pagegraph-provenance");
  assert.equal(provenance.methodology, true);
  assert.equal(provenance.level, "quiet");

  const bottom = byId(findings, "bottom-line");
  assert.equal(bottom.title, "Bottom line: few review signals in this visit");
  assert.equal(bottom.icon, "check");

  // A quiet card that IS site evidence (a flat comparison delta, from the
  // repo's own shipped comparison fixture) must not flip the summary either.
  const flat = buildFindings(viewFromV2(makeInterventionComparisonReportV2(), 1), null);
  const flatDelta = byId(flat, "shields-comparison");
  assert.equal(flatDelta.level, "quiet");
  assert.notEqual(flatDelta.methodology, true);
  const flatBottom = byId(flat, "bottom-line");
  assert.equal(flatBottom.title, "Bottom line: few review signals in this visit");
  assert.equal(flatBottom.icon, "check");
});

test("comparison prose omits a fingerprint delta when either arm lacks an exact measurement", () => {
  const report = makeGpcInterventionReportV2R2();
  report.baseline.summary.counts = {
    ...report.baseline.summary.counts,
    thirdPartyRequests: 10,
    fingerprintEvents: 5
  };
  report.variant.summary.counts = {
    ...report.variant.summary.counts,
    thirdPartyRequests: 4,
    fingerprintEvents: 1
  };
  for (const run of [report.baseline, report.variant]) {
    run.detectors["fingerprint-heuristics"] = {
      ...run.detectors["fingerprint-heuristics"],
      status: "failed",
      reason: "engine-unavailable",
      phaseId: 0
    };
    run.qualityFacts.captureLoss.push({
      family: "fingerprinting",
      phaseId: 0,
      kind: "dropped",
      count: 1,
      detail: "fingerprint-observer"
    });
    run.quality = evaluateQuality(run.qualityFacts, {
      observedRequests: run.evidence.requests.length
    });
  }

  const view = viewFromV2(report, 2);
  assert.equal(view.claims.familyDeltas?.["detector-findings"]?.allowed, true);
  const card = byId(buildFindings(view, null), "gpc-comparison");
  assert.match(card.lead, /6 fewer third-party requests/);
  assert.doesNotMatch(`${card.title} ${card.lead} ${card.detail}`, /fingerprint-like calls/);

  // Also exercise a reader-accepted report: rebuild the derived comparison
  // blocks after the detector failures. The current evaluator closes the broad
  // detector family, while ReportFacts remains a second fail-closed seam for
  // historical or future family registries that are less claim-specific.
  const accepted = makeGpcInterventionReportV2R2();
  for (const run of [accepted.baseline, accepted.variant]) {
    run.detectors["fingerprint-heuristics"] = {
      ...run.detectors["fingerprint-heuristics"],
      status: "failed",
      reason: "engine-unavailable",
      phaseId: 0
    };
    run.qualityFacts.captureLoss.push({
      family: "fingerprinting",
      phaseId: 0,
      kind: "dropped",
      count: 1,
      detail: "fingerprint-observer"
    });
    run.quality = evaluateQuality(run.qualityFacts, {
      observedRequests: run.evidence.requests.length
    });
  }
  if (accepted.experiment.kind !== "intervention") throw new Error("fixture invariant");
  const { supportingPairs: _supportingPairs, ...primaryExperiment } = accepted.experiment;
  accepted.comparability = evaluateComparabilityR2(
    primaryExperiment,
    accepted.baseline,
    accepted.variant
  );
  accepted.diff = buildComparisonDiffV2(
    accepted.baseline,
    accepted.variant,
    accepted.comparability.perMetric
  );
  assert.equal(readStoredScanReport(accepted).ok, true);
  const acceptedView = viewFromV2(accepted, 2);
  assert.equal(acceptedView.claims.familyDeltas?.["detector-findings"]?.allowed, false);
  const acceptedCard = byId(buildFindings(acceptedView, null), "gpc-comparison");
  assert.doesNotMatch(
    `${acceptedCard.title} ${acceptedCard.lead} ${acceptedCard.detail}`,
    /fingerprint-like calls/
  );
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
  const bottomLine = byId(buildFindings(view, null), "bottom-line");
  assert.doesNotMatch(bottomLine.title, /activity evidence was cut short/);
  // The defect this now also covers: an unfinished detector is not an
  // observation. The bottom line used to answer "The scan observed signals a
  // non-expert should not have to decode from raw request tables" over a board
  // whose every substantive card read "No X observed", because the detector's
  // forced "info" level was read as observed severity.
  assert.doesNotMatch(
    bottomLine.lead,
    /The scan observed signals/,
    "an incomplete detector must never be reported as an observed signal"
  );
  assert.doesNotMatch(bottomLine.title, /review-worthy signals/);
  assert.match(bottomLine.title, /a detector did not finish/i);
  assert.match(bottomLine.lead, /did not observe known third-party services/);
  assert.match(bottomLine.lead, /absence is not established for its scope/);
  assert.doesNotMatch(bottomLine.lead, /activity counts are floors|request counts are retained lower bounds/);
  assert.doesNotMatch(bottomLine.evidence, /at least|retained/);

  // The reason reaches the reader as prose, never as a wire slug.
  for (const note of runCensorshipNotes(run)) {
    assert.doesNotMatch(note, /capture-loss:/);
  }
  assert.equal(
    runCensorshipNotes(run).some((note) => note.includes("in-page fingerprint observer")),
    true
  );
});

test("a partial fingerprint detector never presents retained API counts as exact totals", () => {
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

  const card = byId(buildFindings(viewFromV2(report, 2), null), "fingerprint-apis");
  assert.match(card.lead, /At least 3 retained high-entropy API calls/);
  assert.match(card.lead, /incomplete instrumentation log/);
  assert.match(card.evidence, /Retained incomplete evidence includes 1 API event record/);
  assert.doesNotMatch(card.lead, /^3 high-entropy API calls appeared/);
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
  assert.match(mixedDetail, /could not identify 2 of the 3 third-party hosts recorded here/);
  assert.match(mixedDetail, /limit of identity coverage, not evidence about the site/);

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
  assert.match(unmatchedCard.detail, /could not identify 1 of the 1 third-party host recorded here/);

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
  assert.match(coveredDetail, /identified an operator for every one of the 1 third-party domain recorded here/);
  assert.doesNotMatch(coveredDetail, /could not identify/);

  // A visit with no third parties at all has nothing to quantify.
  const none = buildFindings(
    viewFromV1Report(makeResult({ domains: [], thirdPartyRequests: 0, thirdPartyDomains: 0 })),
    null
  );
  assert.doesNotMatch(byId(none, "third-party-services").detail, /recorded here/);
});

test("a report never calls a domain unidentifiable while another card names it", () => {
  // blackrock.com, 2026-07-28: four third-party domains, none in the service
  // catalog, but cdn.cookielaw.org is OneTrust and the consent card said so.
  // Counting only the catalog made the same page assert both "OneTrust" and
  // "cannot say who operates them" about that one domain.
  const plain = (domain: string): DomainSummary => ({
    domain,
    requests: 2,
    thirdParty: true,
    tracker: null,
    statuses: [200],
    resourceTypes: ["script"]
  });
  const findings = buildFindings(
    viewFromV1Report(
      makeResult({
        firstPartyDomain: "www.blackrock.com",
        domains: [
          plain("cdn.cookielaw.org"),
          plain("{label}.onetrust.com"),
          plain("{label}.tiqcdn.com"),
          plain("{label}.sdiapi.com")
        ],
        thirdPartyRequests: 8,
        thirdPartyDomains: 4
      })
    ),
    null
  );

  const consent = findings.find((finding) => finding.id === "consent-banner");
  assert.ok(consent, "expected the consent card to name the CMP");
  assert.match(consent.lead, /OneTrust/);

  // Two of the four are OneTrust hosts, so the shortfall is two, not four.
  const services = byId(findings, "third-party-services").detail;
  assert.match(services, /could not identify 2 of the 4 third-party hosts recorded here/);
  assert.doesNotMatch(services, /could not identify 4 of the 4/);
});

test("an uncatalogued platform domain is not reported as no platform requests", () => {
  // terafab.ai, 2026-07-28: fonts.googleapis.com and a gstatic.com host were
  // both contacted. Neither is in the service catalog, and the card derived its
  // absence claim from catalog matches alone, so it published a green "no
  // requests to catalogued Google domains were observed" over those requests.
  // reviewed-ownership.ts names both as Google, so the report contradicted its
  // own ownership data.
  const asset = (domain: string): DomainSummary => ({
    domain,
    requests: 2,
    thirdParty: true,
    tracker: null,
    statuses: [200],
    resourceTypes: ["font"]
  });
  const findings = buildFindings(
    viewFromV1Report(
      makeResult({
        firstPartyDomain: "terafab.ai",
        domains: [asset("fonts.googleapis.com"), asset("{label}.gstatic.com")],
        thirdPartyRequests: 4,
        thirdPartyDomains: 2
      })
    ),
    null
  );

  const platforms = byId(findings, "named-platforms");
  assert.notEqual(platforms.level, "ok", "an observed platform request may not read as a clean absence");
  assert.doesNotMatch(platforms.lead, /No requests to catalogued Google/);
  assert.match(platforms.lead, /dispatched requests to Google domains/);
  // Naming the operator must not inflate the tracker counts.
  assert.match(platforms.detail, /not counted as catalog-matched requests/);

  // A visit that really contacted no platform domain keeps the clean absence.
  const clean = buildFindings(
    viewFromV1Report(
      makeResult({
        firstPartyDomain: "terafab.ai",
        domains: [asset("unknown-vendor.example")],
        thirdPartyRequests: 2,
        thirdPartyDomains: 1
      })
    ),
    null
  );
  const cleanCard = byId(clean, "named-platforms");
  assert.equal(cleanCard.level, "ok");
  assert.match(cleanCard.lead, /No requests to catalogued Google/);
});

test("the causal map names each provenance actor with the request log's own word for that field", () => {
  const base: NetworkRequestRecord = {
    id: 1,
    url: "https://ads.example.com/pixel",
    domain: "ads.example.com",
    method: "GET",
    resourceType: "script",
    status: 200,
    thirdParty: true,
    tracker: null,
    startedAtMs: 1
  };
  // Injector only: the domain executed the script that made the request, it is not
  // itself the recorded script.
  const injectorOnly: NetworkRequestRecord = { ...base, provenance: { injectedByDomain: "cdn.example.net" } };
  // Initiator only, with a recorded type the log prints. The log says iframe, so no
  // other surface may call the same record a script.
  const iframeInitiator: NetworkRequestRecord = {
    ...base,
    provenance: {
      initiatorType: "iframe",
      initiatorDomain: "widget.example.net",
      initiatorUrl: "https://widget.example.net/embed.html"
    }
  };
  // A recorded script outranks the rest of the chain, and only then is "script" true.
  const scripted: NetworkRequestRecord = {
    ...base,
    provenance: {
      scriptDomain: "tags.example.net",
      initiatorDomain: "widget.example.net",
      injectedByDomain: "cdn.example.net"
    }
  };
  assert.equal(requestProvenanceSummary(scripted)?.primary, "script tags.example.net");

  const graph = readFileSync(path.join(process.cwd(), "app", "_components", "causality-graph.tsx"), "utf8");

  // Whatever phrase the log prints for a field is the phrase the map has to print for it.
  const logWording = [
    { request: injectorOnly, phrase: "injected by", actor: "cdn.example.net" },
    { request: iframeInitiator, phrase: "initiated by", actor: "iframe widget.example.net" }
  ];
  for (const { request, phrase, actor } of logWording) {
    assert.equal(requestProvenanceSummary(request)?.primary, `${phrase} ${actor}`);
    assert.ok(
      graph.includes(`return "${phrase}"`),
      `the causal map has to offer "${phrase}", the request log's own phrase for that field`
    );
  }

  // The map has to read the role off the field that named the actor, in the same order
  // the log resolves it, rather than calling every actor a script.
  const fieldRoles = [
    { field: "scriptDomain", role: "script" },
    { field: "initiatorDomain", role: "initiator" },
    { field: "injectedByDomain", role: "injector" }
  ];
  for (const { field, role } of fieldRoles) {
    assert.ok(
      graph.includes(`domain: provenance.${field}, role: "${role}"`),
      `the causal map has to record ${field} as the ${role} role`
    );
  }
  const consulted = Array.from(new Set(graph.match(/provenance\.[A-Za-z]+/g) ?? []));
  assert.deepEqual(
    consulted,
    fieldRoles.map(({ field }) => `provenance.${field}`),
    "the map has to resolve the actor from the same fields, in the same order, as the request log"
  );

  assert.doesNotMatch(
    graph,
    /script →/,
    "the map may not label every provenance actor a script; the role comes from the field that named it"
  );
  assert.doesNotMatch(
    graph,
    /\bcaused\b/,
    "PageGraph provenance attributes a request to an actor, it does not establish that the actor caused it"
  );
});

test("the provenance chip claims recorded attribution, not a causal chain", () => {
  // The chip's filter matches only rows requestProvenanceSummary can display,
  // and the causal map describes the same records as attribution ("which
  // recorded actor each third-party request is attributed to"). A title
  // asserting a recorded causal chain and a script that triggered the request
  // overclaims both: PageGraph provenance records reachability, and the
  // recorded actor is often an initiator or injector, not a script.
  const tables = readFileSync(path.join(process.cwd(), "app", "_components", "report-tables.tsx"), "utf8");
  assert.doesNotMatch(tables, /recorded causal chain|which script triggered/);
  assert.match(
    tables,
    /Requests whose recorded provenance can be shown: the initiator, script, or injecting actor the request is attributed to\./
  );
});

test("the findings board describes the arm the rest of the page describes", () => {
  // Three headline branches describe the variant arm and set focusArm to it,
  // and everything else on the page follows: stat chips, the arm switcher's
  // default and therefore the metric grid and every evidence table, and each
  // card's own "open the evidence" link. The board was the one surface still
  // pinned to the display run, so the page stated two different counts for
  // "this visit" and a card's evidence link landed in an arm its numbers did
  // not come from.
  //
  // No committed report reaches those branches yet (swept all 574: zero have
  // focusArm "variant"), so this pins the contract directly rather than
  // through a fixture that happens to trip one.
  const baseline = makeResult({
    domains: [
      makeTrackerDomain("ads.example.net", 40, "AdCo", "advertising"),
      makeTrackerDomain("pixel.example.org", 12, "PixelCo", "advertising")
    ],
    thirdPartyRequests: 52,
    thirdPartyDomains: 2
  });
  const variant = makeResult({
    domains: [makeTrackerDomain("ads.example.net", 3, "AdCo", "advertising")],
    thirdPartyRequests: 3,
    thirdPartyDomains: 1
  });
  const view = viewFromV1Report(gpcPair(baseline, variant));

  const onBaseline = byId(buildFindings(view, null, undefined, "baseline"), "third-party-services");
  const onVariant = byId(buildFindings(view, null, undefined, "variant"), "third-party-services");

  // The two arms must actually differ, or the assertion below proves nothing.
  assert.notEqual(
    onBaseline.lead,
    onVariant.lead,
    "the fixture's arms must differ for this contract to be observable"
  );
  // The baseline arm saw a second tracking company; the variant did not.
  assert.match(onBaseline.lead, /PixelCo/);
  assert.doesNotMatch(onVariant.lead, /PixelCo/);
  assert.match(onVariant.lead, /AdCo/);

  // Omitting the arm keeps the previous behaviour: the display run.
  const unspecified = byId(buildFindings(view, null), "third-party-services");
  assert.equal(unspecified.lead, onBaseline.lead);
});

test("a focused variant arm is never ranked against the display run's cohort", () => {
  // The corpus distribution admits only lead runs, and the cohort buildFindings
  // selects is keyed by the display run's identity, including its requested-GPC
  // condition. A GPC comparison's alarm headline focuses the GPC-on variant;
  // ranking that arm's counts against the gpc-off cohort is cross-cohort
  // pooling under scope copy claiming an exact-cohort match, and it
  // systematically understates the site because GPC-on visits carry fewer
  // requests. The consent focus branches only dodge this because their
  // variant's consent mode already fails the population predicate; the GPC
  // branch has no such shield, so the arm gate must supply it.
  const corpus = makeCorpus(60);
  const baseline = makeResult({
    domains: [makeTrackerDomain("ads.example.net", 40, "AdCo", "advertising")],
    thirdPartyRequests: 40,
    thirdPartyDomains: 25
  });
  const variant = makeResult({
    domains: [makeTrackerDomain("ads.example.net", 30, "AdCo", "advertising")],
    thirdPartyRequests: 30,
    thirdPartyDomains: 20
  });
  const view = viewFromV1Report(gpcPair(baseline, variant));

  const displayBoard = byId(buildFindings(view, corpus, undefined, "baseline"), "third-party-services");
  assert.match(
    displayBoard.benchmark ?? "",
    /percentile mark|median/,
    "the display arm is the cohort's own population and must keep its percentile badge"
  );

  const variantBoard = byId(buildFindings(view, corpus, undefined, "variant"), "third-party-services");
  assert.equal(
    variantBoard.benchmark,
    undefined,
    "a variant arm belongs to no corpus cohort and must not carry percentile wording"
  );
});
