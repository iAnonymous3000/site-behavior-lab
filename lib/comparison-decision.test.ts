import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createConsentComparisonReport,
  createShieldsComparisonReport,
  createTemporalComparisonReport
} from "./compare-reports";
import {
  describeComparabilityReason,
  legacyComparisonDecision,
  legacyComparisonHistoryCohortFingerprint,
  legacyMeasurementEnvironmentFingerprint,
  legacyTemporalCohortFingerprint,
  v2ComparisonDecision
} from "./comparison-decision";
import {
  LEGACY_V1_METHODOLOGY_UNSPECIFIED,
  legacyV1MethodologyIdentity,
  NODE_SHIELDS_REQUEST_CONTEXT_VERSION
} from "./legacy-methodology";
import {
  makeInterventionComparisonReportV2,
  makeTemporalComparisonReportV2
} from "./scan-report-v2-fixtures";
import { viewFromV1Report, viewFromV2 } from "./scan-report-views";
import { SCAN_REPORT_SCHEMA_VERSION, type ScanConditions, type ScanResult } from "./types";

type RunOverrides = {
  status?: number;
  firstPartyDomain?: string;
  scannedAt?: string;
};

function makeRun(overrides: RunOverrides = {}): ScanResult {
  const conditions: ScanConditions = {
    requestedUrl: "https://example.com/",
    finalUrl: "https://example.com/",
    scannedAt: overrides.scannedAt ?? new Date(0).toISOString(),
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
      totalRequests: 20,
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

/** Axis-valid Shields pair (classification baseline, block-simulation variant). */
function shieldsPair(baseline: ScanResult, variant: ScanResult) {
  const adblock = { active: true, source: "brave", lists: 3, fetchedAt: "2026-01-01T00:00:00.000Z" };
  baseline.conditions = { ...baseline.conditions, shieldsMode: "classification" as const, adblock: { ...adblock } };
  variant.conditions = { ...variant.conditions, shieldsMode: "block-simulation" as const, adblock: { ...adblock } };
  return createShieldsComparisonReport(baseline, variant);
}

/** Ordered temporal pair (variant one day later), so temporal eligibility can pass. */
function orderedTemporalPair(baseline: ScanResult, variant: ScanResult) {
  baseline.conditions = { ...baseline.conditions, scannedAt: "2026-01-01T00:00:00.000Z" };
  variant.conditions = { ...variant.conditions, scannedAt: "2026-01-02T00:00:00.000Z" };
  return createTemporalComparisonReport(baseline, variant);
}

test("an eligible Shields pair is comparable with the expected family modes", () => {
  const baseline = makeRun({});
  const variant = makeRun({});
  baseline.summary = { ...baseline.summary, shieldsBlockedRequests: 12 };
  variant.summary = { ...variant.summary, shieldsBlockedRequests: 9 };
  const decision = legacyComparisonDecision(shieldsPair(baseline, variant));

  assert.equal(decision.mode, "comparable");
  assert.deepEqual(decision.reasons, []);
  assert.equal(decision.families["raw-counts"].mode, "comparable");
  assert.equal(decision.families["tracker-classification"].mode, "comparable");
  // A Shields-axis pair measures filter matches on one arm and engine blocks
  // on the other: two quantities that never share a delta, so the family
  // stays raw-only even on an eligible pair.
  assert.equal(decision.families["shields-simulation"].mode, "raw-only");
  assert.match(decision.families["shields-simulation"].reasons.join(" "), /different Shields quantities/);
  // v1 never measured a verified consent state: suppressed, not just denied.
  assert.equal(decision.families["consent-verification"].mode, "suppressed");
  // Detectors ran (their per-arm evidence renders) without version identity:
  // raw-only, never suppressed.
  assert.equal(decision.families["detector-findings"].mode, "raw-only");
});

test("an ineligible pair is raw-only and its reasons flow into every gated family", () => {
  const decision = legacyComparisonDecision(shieldsPair(makeRun({}), makeRun({ status: 403 })));

  assert.equal(decision.mode, "raw-only");
  assert.equal(decision.reasons.length, 1);
  assert.match(decision.reasons[0], /HTTP 403/);
  assert.equal(decision.families["raw-counts"].mode, "raw-only");
  assert.match(decision.families["raw-counts"].reasons.join(" "), /HTTP 403/);
});

test("shields family: never measured is suppressed, one-arm is raw-only, both-arms comparable", () => {
  // Neither arm carried an engine measurement: nothing to display side by side.
  const unmeasured = legacyComparisonDecision(orderedTemporalPair(makeRun({}), makeRun({})));
  assert.equal(unmeasured.families["shields-simulation"].mode, "suppressed");
  assert.match(unmeasured.families["shields-simulation"].reasons.join(" "), /Neither visit carried a Shields measurement/);

  // Exactly one measured arm: its number renders, but no like-for-like delta.
  const baselineOnly = makeRun({});
  baselineOnly.summary = { ...baselineOnly.summary, shieldsBlockedRequests: 4 };
  baselineOnly.conditions = {
    ...baselineOnly.conditions,
    shieldsMode: "classification" as const,
    adblock: { active: true, source: "brave", lists: 3, fetchedAt: "2026-01-01T00:00:00.000Z" }
  };
  const oneArm = legacyComparisonDecision(orderedTemporalPair(baselineOnly, makeRun({})));
  assert.equal(oneArm.families["shields-simulation"].mode, "raw-only");
  assert.match(oneArm.families["shields-simulation"].reasons.join(" "), /only one visit/);

  // Both arms measured the SAME quantity from the same snapshot on an
  // eligible temporal pair: comparable.
  const before = makeRun({});
  const after = makeRun({});
  const adblock = { active: true, source: "brave", lists: 3, fetchedAt: "2026-01-01T00:00:00.000Z" };
  before.summary = { ...before.summary, shieldsBlockedRequests: 4 };
  after.summary = { ...after.summary, shieldsBlockedRequests: 6 };
  before.conditions = { ...before.conditions, shieldsMode: "classification" as const, adblock: { ...adblock } };
  after.conditions = { ...after.conditions, shieldsMode: "classification" as const, adblock: { ...adblock } };
  const bothArms = legacyComparisonDecision(orderedTemporalPair(before, after));
  assert.equal(bothArms.mode, "comparable");
  assert.equal(bothArms.families["shields-simulation"].mode, "comparable");

  // Same quantity, DIFFERENT list snapshot: raw-only with the snapshot reason.
  const staleBefore = makeRun({});
  const staleAfter = makeRun({});
  staleBefore.summary = { ...staleBefore.summary, shieldsBlockedRequests: 4 };
  staleAfter.summary = { ...staleAfter.summary, shieldsBlockedRequests: 6 };
  staleBefore.conditions = { ...staleBefore.conditions, shieldsMode: "classification" as const, adblock: { ...adblock } };
  staleAfter.conditions = {
    ...staleAfter.conditions,
    shieldsMode: "classification" as const,
    adblock: { ...adblock, fetchedAt: "2026-02-01T00:00:00.000Z" }
  };
  const stalePair = orderedTemporalPair(staleBefore, staleAfter);
  const staleSnapshot = legacyComparisonDecision(stalePair);
  assert.equal(staleSnapshot.mode, "comparable");
  assert.equal(staleSnapshot.families["raw-counts"].mode, "comparable");
  assert.equal(staleSnapshot.families["tracker-classification"].mode, "comparable");
  assert.equal(staleSnapshot.families["shields-simulation"].mode, "raw-only");
  assert.equal(staleSnapshot.families["detector-findings"].mode, "raw-only");
  assert.equal(staleSnapshot.compatibility.matched, false);
  assert.match(staleSnapshot.families["shields-simulation"].reasons.join(" "), /different filter-list snapshots/);
  const staleView = viewFromV1Report(stalePair);
  assert.equal(staleView.claims.pairComparison?.allowed, true);
  assert.equal(staleView.claims.temporalChange, false);
});

test("the legacy fingerprint matches identical environments and follows the unknown rule", () => {
  const decision = legacyComparisonDecision(orderedTemporalPair(makeRun({}), makeRun({})));
  assert.equal(decision.compatibility.origin, "legacy-derived");
  assert.equal(typeof decision.compatibility.baseline, "string");
  assert.equal(decision.compatibility.baseline, decision.compatibility.variant);
  assert.equal(decision.compatibility.matched, true);

  // A differing environment dimension produces a different digest.
  const otherLocale = makeRun({});
  otherLocale.conditions = { ...otherLocale.conditions, locale: "de-DE" };
  const mismatch = legacyComparisonDecision(orderedTemporalPair(makeRun({}), otherLocale));
  assert.equal(mismatch.compatibility.matched, false);

  const listA = makeRun({});
  const listB = makeRun({});
  listA.conditions = {
    ...listA.conditions,
    adblock: { active: true, source: "brave", lists: 31, fetchedAt: "2026-07-12T00:00:00.000Z" }
  };
  listB.conditions = {
    ...listB.conditions,
    adblock: { active: true, source: "brave", lists: 31, fetchedAt: "2026-07-13T00:00:00.000Z" }
  };
  const listMismatch = legacyComparisonDecision(orderedTemporalPair(listA, listB));
  assert.equal(listMismatch.compatibility.matched, false);

  // The unknown rule: an arm with a literal-"unknown" dimension has NO
  // fingerprint, and null never matches anything, including itself.
  const unknownRun = makeRun({});
  unknownRun.conditions = { ...unknownRun.conditions, scannerEgress: "Unknown" };
  assert.equal(legacyMeasurementEnvironmentFingerprint(unknownRun), null);
  const unproven = legacyComparisonDecision(orderedTemporalPair(makeRun({}), unknownRun));
  assert.equal(unproven.compatibility.variant, null);
  assert.equal(unproven.compatibility.matched, null);
});

test("legacy temporal comparisons separate old and initiator-aware methodology cohorts", () => {
  const oldRun = makeRun({});
  oldRun.conditions = {
    ...oldRun.conditions,
    scannerDisclosure: "Automated Chromium scan with Brave Shields classification only."
  };
  const currentRun = makeRun({});
  currentRun.conditions = {
    ...currentRun.conditions,
    scannerDisclosure: `Automated Chromium scan under methodology ${NODE_SHIELDS_REQUEST_CONTEXT_VERSION}; initiating document context.`
  };

  assert.equal(legacyV1MethodologyIdentity(oldRun.conditions.scannerDisclosure), LEGACY_V1_METHODOLOGY_UNSPECIFIED);
  assert.equal(legacyV1MethodologyIdentity(currentRun.conditions.scannerDisclosure), NODE_SHIELDS_REQUEST_CONTEXT_VERSION);

  const crossMethod = legacyComparisonDecision(orderedTemporalPair(oldRun, currentRun));
  assert.equal(crossMethod.mode, "raw-only");
  assert.equal(crossMethod.compatibility.matched, false);
  assert.equal(crossMethod.families["raw-counts"].mode, "raw-only");
  assert.match(crossMethod.reasons.join(" "), /different scanner methodology generations/);

  const currentBefore = makeRun({});
  const currentAfter = makeRun({});
  currentBefore.conditions = { ...currentBefore.conditions, scannerDisclosure: currentRun.conditions.scannerDisclosure };
  currentAfter.conditions = { ...currentAfter.conditions, scannerDisclosure: currentRun.conditions.scannerDisclosure };
  const sameMethod = legacyComparisonDecision(orderedTemporalPair(currentBefore, currentAfter));
  assert.equal(sameMethod.mode, "comparable");
  assert.equal(sameMethod.compatibility.matched, true);
  assert.equal(sameMethod.families["raw-counts"].mode, "comparable");
});

test("automatic v1 history cohorts include methodology, conditions, lists, and catalog identity", () => {
  const current = makeRun({});
  current.conditions = {
    ...current.conditions,
    shieldsMode: "classification",
    adblock: { active: true, source: "brave", lists: 31, fetchedAt: "2026-07-12T00:00:00.000Z" },
    scannerDisclosure: `Automated Chromium scan under methodology ${NODE_SHIELDS_REQUEST_CONTEXT_VERSION}.`
  };
  const same = structuredClone(current);
  assert.equal(legacyTemporalCohortFingerprint(current), legacyTemporalCohortFingerprint(same));

  const mutations: Array<(run: ScanResult) => void> = [
    (run) => { run.conditions.gpcEnabled = true; },
    (run) => { run.conditions.consentMode = "accept-all"; },
    (run) => { run.conditions.viewport.width += 1; },
    (run) => { if (run.conditions.adblock) run.conditions.adblock.fetchedAt = "2026-07-13T00:00:00.000Z"; },
    (run) => { run.conditions.trackerCatalog.version = "other"; },
    (run) => { run.conditions.scannerDisclosure = "legacy unspecified methodology"; }
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(current);
    mutate(changed);
    assert.notEqual(legacyTemporalCohortFingerprint(current), legacyTemporalCohortFingerprint(changed));
  }

  const unknown = structuredClone(current);
  delete unknown.conditions.shieldsMode;
  assert.equal(legacyTemporalCohortFingerprint(unknown), null);
});

test("passive comparison-history cohorts omit only the known snapshot date", () => {
  const before = makeRun({});
  before.conditions = {
    ...before.conditions,
    shieldsMode: "classification",
    adblock: { active: true, source: "brave", lists: 31, fetchedAt: "2026-07-12T00:00:00.000Z" },
    scannerDisclosure: `Automated Chromium scan under methodology ${NODE_SHIELDS_REQUEST_CONTEXT_VERSION}.`
  };
  const after = structuredClone(before);
  after.conditions.adblock!.fetchedAt = "2026-07-13T00:00:00.000Z";

  assert.notEqual(legacyTemporalCohortFingerprint(before), legacyTemporalCohortFingerprint(after));
  assert.equal(
    legacyComparisonHistoryCohortFingerprint(before),
    legacyComparisonHistoryCohortFingerprint(after)
  );

  after.conditions.adblock!.lists = 30;
  assert.notEqual(
    legacyComparisonHistoryCohortFingerprint(before),
    legacyComparisonHistoryCohortFingerprint(after)
  );
  after.conditions.shieldsMode = "block-simulation";
  assert.equal(legacyComparisonHistoryCohortFingerprint(after), null);
  after.conditions.shieldsMode = "classification";
  after.conditions.adblock!.fetchedAt = "unknown";
  assert.equal(legacyComparisonHistoryCohortFingerprint(after), null);
});

test("the fingerprint excludes the intervention axes: a GPC flip does not change it", () => {
  const off = makeRun({});
  const on = makeRun({});
  on.conditions = { ...on.conditions, gpcEnabled: true };
  assert.equal(legacyMeasurementEnvironmentFingerprint(off), legacyMeasurementEnvironmentFingerprint(on));
});

test("the view's claim gates are derived from the decision and cannot disagree", () => {
  const baseline = makeRun({});
  const variant = makeRun({ status: 500 });
  const view = viewFromV1Report(shieldsPair(baseline, variant));
  const decision = view.claims.decision;

  assert.notEqual(decision, null);
  assert.equal(view.claims.pairComparison?.allowed, decision?.mode === "comparable");
  assert.deepEqual(view.claims.pairComparison?.reasons, decision?.reasons);
  for (const [family, gate] of Object.entries(view.claims.familyDeltas ?? {})) {
    const familyDecision = decision?.families[family as keyof typeof decision.families];
    assert.equal(gate.allowed, familyDecision?.mode === "comparable", family);
    assert.deepEqual(gate.reasons, familyDecision?.reasons, family);
  }
});

test("single reports carry no decision", () => {
  const view = viewFromV1Report(makeRun({}));
  assert.equal(view.claims.decision, null);
  assert.equal(view.claims.pairComparison, null);
});

test("consent pairs keep the dispatch rules through the decision", () => {
  const accept = makeRun({});
  const reject = makeRun({});
  accept.conditions = { ...accept.conditions, consentMode: "accept-all" };
  reject.conditions = { ...reject.conditions, consentMode: "reject-all" };
  accept.consentInteraction = { mode: "accept-all", clicked: true };
  reject.consentInteraction = { mode: "reject-all", clicked: false };
  const decision = legacyComparisonDecision(createConsentComparisonReport(accept, reject));

  assert.equal(decision.mode, "raw-only");
  assert.match(decision.reasons.join(" "), /found no recognizable reject-all control/);
  assert.equal(decision.families["consent-verification"].mode, "suppressed");
});

test("v2 decisions come from the recorded comparability block and recorded fingerprints", () => {
  const temporal = makeTemporalComparisonReportV2();
  const decision = v2ComparisonDecision(temporal);

  assert.equal(decision.mode, temporal.comparability.pairValidity.eligible ? "comparable" : "raw-only");
  assert.equal(decision.compatibility.origin, "recorded");
  assert.equal(decision.compatibility.baseline, temporal.baseline.fingerprints.measurementEnvironment);
  assert.equal(decision.compatibility.variant, temporal.variant.fingerprints.measurementEnvironment);
  assert.equal(decision.compatibility.matched, decision.compatibility.baseline === decision.compatibility.variant);
  for (const [family, entry] of Object.entries(temporal.comparability.perMetric)) {
    const familyDecision = decision.families[family as keyof typeof decision.families];
    assert.equal(familyDecision.mode, entry.eligible ? "comparable" : "raw-only", family);
    assert.deepEqual(familyDecision.reasons, entry.eligible ? [] : entry.reasons, family);
  }

  // The v2 view folds the same decision into its claim policy.
  const view = viewFromV2(temporal, 1);
  assert.deepEqual(view.claims.decision, decision);
  assert.equal(view.claims.pairComparison?.allowed, decision.mode === "comparable");

  const intervention = makeInterventionComparisonReportV2();
  const interventionView = viewFromV2(intervention, 1);
  assert.notEqual(interventionView.claims.decision, null);
  assert.equal(
    interventionView.claims.pairComparison?.allowed,
    interventionView.claims.decision?.mode === "comparable"
  );
});

test("v2 decision reasons are reader-facing sentences, never recorded tokens", () => {
  const report = makeInterventionComparisonReportV2();
  report.comparability = {
    ...report.comparability,
    pairValidity: { eligible: false, reasons: ["run-failed:variant"] },
    perMetric: {
      ...report.comparability.perMetric,
      "raw-counts": {
        eligible: false,
        reasons: ["unknown-dimension:egress.region", "dependency-version-mismatch:environment"]
      },
      "shields-simulation": { eligible: false, reasons: ["dependency-digest-mismatch:adblockManifest"] },
      "detector-findings": {
        eligible: false,
        reasons: ["dependency-version-mismatch:detectorStatus.privacy-policy"]
      }
    }
  };
  const decision = v2ComparisonDecision(report);

  assert.equal(decision.mode, "raw-only");
  assert.deepEqual(decision.reasons, [
    "The variant visit did not complete, and a failed load reflects an error page, not the site."
  ]);
  assert.deepEqual(decision.families["raw-counts"].reasons, [
    "The pair did not record the network egress region for both visits, and an unrecorded condition never counts as matching.",
    "The two visits ran in different measurement environments (browser, device, probe, or session configuration)."
  ]);
  assert.deepEqual(decision.families["shields-simulation"].reasons, [
    "The two visits used different versions of the filter-list snapshot, so their numbers measure different things."
  ]);
  assert.deepEqual(decision.families["detector-findings"].reasons, [
    "The privacy-policy detector's status differed between the two visits, so their numbers measure different things."
  ]);
  // No raw vocabulary token may reach a reader through the decision.
  for (const family of Object.values(decision.families)) {
    for (const reason of family.reasons) assert.doesNotMatch(reason, /^[a-z-]+(:|$)/);
  }
});

test("an unrecognized recorded reason token is quoted, never guessed at", () => {
  assert.equal(
    describeComparabilityReason("brand-new-evaluator-token"),
    'The recorded comparability evaluation named "brand-new-evaluator-token".'
  );
  assert.equal(
    describeComparabilityReason("unknown-dimension:detectorStatus.pixel-events"),
    "The pair did not record the pixel-events detector's status for both visits, and an unrecorded condition never counts as matching."
  );
});
