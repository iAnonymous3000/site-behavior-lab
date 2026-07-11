import assert from "node:assert/strict";
import { test } from "node:test";
import { createConsentComparisonReport, createGpcComparisonReport, createShieldsComparisonReport, createTemporalComparisonReport } from "./compare-reports";
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
  const report = shieldsPair(makeRun({ firstPartyDomain: "www.example.com" }), makeRun({ firstPartyDomain: "example.com" }));
  assert.deepEqual(comparisonEligibility(report), { eligible: true, reasons: [] });
});

test("a failed arm disqualifies the comparison and names the run label", () => {
  const report = shieldsPair(makeRun({}), makeRun({ status: 403 }));
  const eligibility = comparisonEligibility(report);
  assert.equal(eligibility.eligible, false);
  assert.equal(eligibility.reasons.length, 1);
  assert.match(eligibility.reasons[0], /"Brave-list blocking" visit returned HTTP 403/);
});

test("the declared experiment must have happened: unvaried axes disqualify", () => {
  // GPC pair whose arms both ran without the signal.
  const gpcReport = createGpcComparisonReport(makeRun({}), makeRun({}));
  const gpc = comparisonEligibility(gpcReport);
  assert.equal(gpc.eligible, false);
  assert.match(gpc.reasons.join(" "), /did not vary the signal/);

  // Shields pair whose blocking arm never ran the engine.
  const shieldsReport = createShieldsComparisonReport(makeRun({}), makeRun({}));
  const shields = comparisonEligibility(shieldsReport);
  assert.equal(shields.eligible, false);
  assert.match(shields.reasons.join(" "), /requires the variant visit to have run the blocking engine/);

  // Consent pair whose arms never attempted the accept/reject modes.
  const consentReport = createConsentComparisonReport(makeRun({}), makeRun({}));
  const consent = comparisonEligibility(consentReport);
  assert.equal(consent.eligible, false);
  assert.match(consent.reasons.join(" "), /requires an accept-all baseline visit and a reject-all variant visit/);
});

test("unknown load state and literal-unknown environments disqualify", () => {
  const nullStatus = makeRun({});
  nullStatus.summary = { ...nullStatus.summary, status: null };
  const noStatus = comparisonEligibility(createTemporalComparisonReport(makeRun({}), nullStatus));
  assert.equal(noStatus.eligible, false);
  assert.match(noStatus.reasons.join(" "), /recorded no HTTP status/);

  const unknownEgress = makeRun({});
  unknownEgress.conditions = { ...unknownEgress.conditions, scannerEgress: "unknown" };
  const bothUnknown = makeRun({});
  bothUnknown.conditions = { ...bothUnknown.conditions, scannerEgress: "Unknown" };
  const egress = comparisonEligibility(createTemporalComparisonReport(bothUnknown, unknownEgress));
  assert.equal(egress.eligible, false);
  assert.match(egress.reasons.join(" "), /did not record its network egress/);
});

test("user agent, language, and final page must also match", () => {
  const uaVariant = makeRun({});
  uaVariant.conditions = { ...uaVariant.conditions, userAgent: "other" };
  assert.match(
    comparisonEligibility(createTemporalComparisonReport(makeRun({}), uaVariant)).reasons.join(" "),
    /different user agents/
  );

  const langVariant = makeRun({});
  langVariant.conditions = { ...langVariant.conditions, language: "de" };
  assert.match(
    comparisonEligibility(createTemporalComparisonReport(makeRun({}), langVariant)).reasons.join(" "),
    /different languages/
  );

  const redirected = makeRun({});
  redirected.conditions = { ...redirected.conditions, finalUrl: "https://example.com/en/services" };
  assert.match(
    comparisonEligibility(createTemporalComparisonReport(makeRun({}), redirected)).reasons.join(" "),
    /ended on different pages/
  );

  // Consent pairs are exempt from the final-URL rule: the dispatched click
  // itself can navigate.
  const acceptArm = makeRun({});
  acceptArm.conditions = { ...acceptArm.conditions, consentMode: "accept-all" };
  acceptArm.consentInteraction = { mode: "accept-all", clicked: true };
  const rejectArm = makeRun({});
  rejectArm.conditions = { ...rejectArm.conditions, consentMode: "reject-all", finalUrl: "https://example.com/consent-done" };
  rejectArm.consentInteraction = { mode: "reject-all", clicked: true };
  assert.equal(comparisonEligibility(createConsentComparisonReport(acceptArm, rejectArm)).eligible, true);
});

test("a consent pair requires both clicks to have really dispatched", () => {
  // The corpus counterexample (Codex round 10): 56 of the 59 then-eligible
  // consent pairs never dispatched both clicks, yet their pages compared
  // "Accept all" against "Reject all". A visit whose control was never found
  // records the pre-consent state, so the declared experiment did not happen.
  const consentArm = (mode: "accept-all" | "reject-all", clicked: boolean): ScanResult => {
    const run = makeRun({});
    run.conditions = { ...run.conditions, consentMode: mode };
    run.consentInteraction = { mode, clicked };
    return run;
  };

  const neither = comparisonEligibility(
    createConsentComparisonReport(consentArm("accept-all", false), consentArm("reject-all", false))
  );
  assert.equal(neither.eligible, false);
  assert.equal(neither.reasons.length, 2);
  assert.match(neither.reasons.join(" "), /found no recognizable accept-all control/);
  assert.match(neither.reasons.join(" "), /found no recognizable reject-all control/);

  const oneOnly = comparisonEligibility(
    createConsentComparisonReport(consentArm("accept-all", true), consentArm("reject-all", false))
  );
  assert.equal(oneOnly.eligible, false);
  assert.equal(oneOnly.reasons.length, 1);
  assert.match(oneOnly.reasons[0], /"Reject-all attempt" visit found no recognizable reject-all control/);

  // A visit that never recorded the interaction cannot prove the dispatch
  // (the unknown rule).
  const unrecorded = makeRun({});
  unrecorded.conditions = { ...unrecorded.conditions, consentMode: "accept-all" };
  const silent = comparisonEligibility(createConsentComparisonReport(unrecorded, consentArm("reject-all", true)));
  assert.equal(silent.eligible, false);
  assert.match(silent.reasons[0], /did not record whether the accept-all click was dispatched/);

  const both = comparisonEligibility(
    createConsentComparisonReport(consentArm("accept-all", true), consentArm("reject-all", true))
  );
  assert.deepEqual(both, { eligible: true, reasons: [] });
});

test("a request-capped arm disqualifies the comparison", () => {
  const report = createShieldsComparisonReport(makeRun({ totalRequests: COMPARISON_REQUEST_CAP }), makeRun({}));
  const eligibility = comparisonEligibility(report);
  assert.equal(eligibility.eligible, false);
  assert.match(eligibility.reasons[0], /"No blocking" visit hit the 1,000-request recording cap/);
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

test("mismatched or unrecorded environments disqualify: route, viewport, browser, timezone, locale, egress, headless", () => {
  // RFC 3.1/3.2: comparability requires the recorded environment to match on
  // every dimension that shapes what a page serves, and an unrecorded
  // dimension never matches. Verified corpus-neutral: all 235 committed
  // comparisons keep their eligibility (214 eligible) under these checks.
  const withConditions = (patch: Partial<ScanConditions>): ScanResult => {
    const run = makeRun({});
    run.conditions = { ...run.conditions, ...patch };
    return run;
  };
  const expectReason = (variant: ScanResult, pattern: RegExp) => {
    const eligibility = comparisonEligibility(createTemporalComparisonReport(makeRun({}), variant));
    assert.equal(eligibility.eligible, false);
    assert.match(eligibility.reasons.join(" "), pattern);
  };

  expectReason(withConditions({ requestedUrl: "https://example.com/pricing" }), /requested different pages/);
  expectReason(withConditions({ viewport: { width: 1280, height: 980, isMobile: false } }), /different viewport sizes/);
  expectReason(withConditions({ chromiumVersion: "other" }), /different browser versions \(test vs other\)/);
  expectReason(withConditions({ chromiumVersion: "" }), /did not record its browser version/);
  expectReason(withConditions({ timezone: "America/New_York" }), /different timezones/);
  expectReason(withConditions({ locale: "de-DE" }), /different locales/);
  expectReason(withConditions({ scannerEgress: "residential" }), /different network egress/);
  expectReason(withConditions({ headless: false }), /One visit ran headless/);

  // A trailing slash is presentation, not a different page.
  const slashless = withConditions({ requestedUrl: "https://example.com" });
  assert.equal(comparisonEligibility(createTemporalComparisonReport(makeRun({}), slashless)).eligible, true);
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

/** Axis-valid Shields pair: the gate verifies the blocking arm really blocked. */
function shieldsPair(baseline: ScanResult, variant: ScanResult) {
  const adblock = { active: true, source: "brave", lists: 3, fetchedAt: "2026-01-01T00:00:00.000Z" };
  baseline.conditions = { ...baseline.conditions, shieldsMode: "classification" as const, adblock: { ...adblock } };
  variant.conditions = { ...variant.conditions, shieldsMode: "block-simulation" as const, adblock: { ...adblock } };
  return createShieldsComparisonReport(baseline, variant);
}
