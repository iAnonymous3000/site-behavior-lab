import assert from "node:assert/strict";
import { test } from "node:test";
import { createShieldsComparisonReport } from "./compare-reports";
import { v2ComparisonDecision } from "./comparison-decision";
import {
  comparisonEligibility,
  runHitRouteGuardRequestsBlocked,
  runRequestEvidenceCapped
} from "./comparison-eligibility";
import { METRIC_EVIDENCE_SOURCES } from "./metric-evidence-sources";
import { RedactionPass, redactScannerWarnings } from "./redact-scan-report-v1";
import { buildReportFacts } from "./report-facts";
import { buildFindings } from "./report-findings";
import { ScanWarningCollector, NON_HTTP_WARNING_EXAMPLE_LIMIT } from "./scan-runtime";
import { runCensorshipNotes } from "./scan-report-censorship";
import { makeScanReportV1 } from "./scan-report-v2-fixtures";
import { makePublicSingleReportV2R2, makeShieldsInterventionReportV2R2 } from "./scan-report-v2-r2-fixtures";
import type { MetricFamily } from "./scan-report-v2";
import {
  familyCensoredOnRun,
  requestEvidenceState,
  ROUTE_GUARD_REQUESTS_BLOCKED_REASON,
  runInCorpusDistributionPopulation,
  viewFromV1Report,
  viewFromV2
} from "./scan-report-views";
import type { ScanResult } from "./types";

/**
 * A request the scanner's own route guard refuses is not sent and its row is
 * removed, and no producer records a requests-family loss for it. The line
 * the guard writes is the only trace, so the reading side must take the
 * request evidence as incomplete from that line, in both generations. Every
 * line below comes from the real collector and passes the real public
 * sanitizer, so the reader's prefixes cannot drift from what a scan writes.
 */
// Distinct registrable domains: the collector lists one example per distinct
// published address, and the sanitizer generalizes other labels.
const REFUSED_HOSTS = ["example.com", "example.org", "example.net", "example.edu", "iana.org", "icann.org", "ietf.org"];

function guardLines(count: number): string[] {
  assert.ok(count <= REFUSED_HOSTS.length);
  const collector = new ScanWarningCollector();
  for (const host of REFUSED_HOSTS.slice(0, count)) {
    collector.addUnverifiedRequest(`http://${host}/collect?id=1`);
  }
  return redactScannerWarnings(collector.list, new RedactionPass());
}

function v1ResultWith(warnings: string[]): ScanResult {
  const result = makeScanReportV1() as ScanResult;
  result.warnings = [...warnings];
  return result;
}

test("each line the route guard writes for an unverifiable request is read as a refused request", () => {
  const one = guardLines(1);
  assert.deepEqual(one, ["Blocked a request that could not be verified as public: http://example.com/{seg}"]);
  assert.equal(runHitRouteGuardRequestsBlocked({ warnings: one }), true);

  // Past the example limit the guard writes one summary line; alone it is a refusal too.
  const many = guardLines(NON_HTTP_WARNING_EXAMPLE_LIMIT + 2);
  const summary = many.filter((line) => line.startsWith("Blocked additional requests"));
  assert.equal(summary.length, 1);
  assert.equal(runHitRouteGuardRequestsBlocked({ warnings: summary }), true);
  for (const line of many) assert.equal(runHitRouteGuardRequestsBlocked({ warnings: [line] }), true, line);

  // The custom-label form the guard uses for a non-public HTTP(S) URL.
  const labelled = new ScanWarningCollector();
  labelled.addUnverifiedRequest("http://example.com/x", "Blocked a request that could not be verified as a public HTTP(S) URL");
  assert.equal(
    runHitRouteGuardRequestsBlocked({ warnings: redactScannerWarnings(labelled.list, new RedactionPass()) }),
    true
  );

  // A request with another scheme was never going to be a row of the HTTP log.
  const nonHttp = new ScanWarningCollector();
  nonHttp.addNonHttpRequest("ftp://example.com/a.gif");
  assert.equal(nonHttp.list.length, 1);
  assert.equal(runHitRouteGuardRequestsBlocked({ warnings: nonHttp.list }), false);
  assert.equal(runHitRouteGuardRequestsBlocked({ warnings: [] }), false);
});

test("a v1 visit with a refused request reads its request evidence as incomplete, and only that family", () => {
  const clean = viewFromV1Report(v1ResultWith([])).runs[0];
  assert.equal(familyCensoredOnRun(clean, "requests"), false);
  assert.equal(requestEvidenceState(clean), "complete");

  const result = v1ResultWith(guardLines(1));
  assert.equal(runRequestEvidenceCapped(result), true);
  const view = viewFromV1Report(result);
  const run = view.runs[0];
  assert.ok(run.quality.reasons.includes(ROUTE_GUARD_REQUESTS_BLOCKED_REASON));
  assert.equal(run.quality.outcome, "complete", "the visit itself completed");
  assert.equal(familyCensoredOnRun(run, "requests"), true);
  assert.equal(familyCensoredOnRun(run, "cookies"), false);
  assert.equal(familyCensoredOnRun(run, "storage"), false);
  assert.equal(requestEvidenceState(run), "incomplete");
  assert.equal(runInCorpusDistributionPopulation(run), false, "a floor is not ranked or added to a distribution");
  assert.ok(
    runCensorshipNotes(run).some((note) => note.includes("the scanner's own network guard refused one or more requests")),
    runCensorshipNotes(run).join(" | ")
  );

  // No request-family absence is asserted categorically under the guard's own line.
  const facts = buildReportFacts(view);
  assert.equal(facts.display.evidence.requests.state, "censored");
  for (const finding of buildFindings(view, null, facts)) {
    if (finding.claim?.mode === "categorical-absence") {
      assert.ok(
        !["third-party-services", "named-platforms", "ga-remarketing", "shields-blocked"].includes(finding.claim.id),
        `${finding.claim.id} asserted a categorical absence: ${finding.title}`
      );
    }
  }
});

test("a v1 pair with a refused request in one visit supports no delta", () => {
  const adblock = { active: true, source: "brave", lists: 3, fetchedAt: "2026-01-01T00:00:00.000Z" };
  const baseline = v1ResultWith([]);
  const variant = v1ResultWith(guardLines(1));
  baseline.conditions = { ...baseline.conditions, shieldsMode: "classification", adblock: { ...adblock } };
  variant.conditions = { ...variant.conditions, shieldsMode: "block-simulation", adblock: { ...adblock } };
  const control = comparisonEligibility(createShieldsComparisonReport(baseline, { ...variant, warnings: [] }));
  const withRefusal = comparisonEligibility(createShieldsComparisonReport(baseline, variant));
  assert.equal(withRefusal.eligible, false);
  const added = withRefusal.reasons.filter((reason) => !control.reasons.includes(reason));
  assert.equal(added.length, 1, withRefusal.reasons.join(" | "));
  assert.match(added[0], /had one or more requests refused by the scanner's own network guard, so its request evidence is incomplete\.$/);
});

test("an r2 visit whose producer recorded complete requests beside a refusal line is still read as incomplete", () => {
  const recordedClean = viewFromV2(makePublicSingleReportV2R2(), 2).runs[0];
  assert.equal(recordedClean.quality.byFamily?.requests.outcome, "complete");
  assert.equal(familyCensoredOnRun(recordedClean, "requests"), false);

  const report = makePublicSingleReportV2R2();
  report.run.warnings = [...report.run.warnings, ...guardLines(1)];
  const run = viewFromV2(report, 2).runs[0];
  // The stored block is not rewritten; the reader adds its own reason beside it.
  assert.equal(run.quality.byFamily?.requests.outcome, "complete");
  assert.ok(run.quality.reasons.includes(ROUTE_GUARD_REQUESTS_BLOCKED_REASON));
  assert.equal(familyCensoredOnRun(run, "requests"), true);
  assert.equal(familyCensoredOnRun(run, "cookies"), false);
  assert.equal(requestEvidenceState(run), "incomplete");
  assert.equal(runInCorpusDistributionPopulation(run), false);
});

test("an r2 pair with a refused request refuses every delta that reads the request log, and names the visit", () => {
  const families = (edit: (report: ReturnType<typeof makeShieldsInterventionReportV2R2>) => void) => {
    const report = makeShieldsInterventionReportV2R2();
    edit(report);
    return v2ComparisonDecision(report).families;
  };
  const control = families(() => undefined);
  const requestFamilies = (Object.keys(METRIC_EVIDENCE_SOURCES) as MetricFamily[]).filter((family) =>
    METRIC_EVIDENCE_SOURCES[family].includes("requests")
  );
  assert.ok(requestFamilies.includes("raw-counts") && requestFamilies.includes("tracker-classification"));

  const variantOnly = families((report) => {
    report.variant.warnings = [...report.variant.warnings, ...guardLines(1)];
  });
  const both = families((report) => {
    report.baseline.warnings = [...report.baseline.warnings, ...guardLines(1)];
    report.variant.warnings = [...report.variant.warnings, ...guardLines(2)];
  });
  for (const family of Object.keys(control) as MetricFamily[]) {
    const reads = requestFamilies.includes(family);
    const variantReasons = variantOnly[family].reasons.filter((reason) => !control[family].reasons.includes(reason));
    const bothReasons = both[family].reasons.filter((reason) => !control[family].reasons.includes(reason));
    if (!reads) {
      assert.deepEqual(variantOnly[family], control[family], `${family} does not read the request log`);
      continue;
    }
    assert.equal(variantOnly[family].mode, "raw-only", family);
    assert.equal(variantReasons.length, 1, family);
    assert.match(variantReasons[0], /refused one or more requests in the variant visit\./);
    assert.equal(bothReasons.length, 1, family);
    assert.match(bothReasons[0], /refused one or more requests in both visits\./);
  }
});
