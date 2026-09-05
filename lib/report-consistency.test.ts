import assert from "node:assert/strict";
import { test } from "node:test";
import {
  reportConsistencyViolations,
  validateReportPresentation,
  type ReportConsistencyRuleId
} from "./report-consistency";
import { buildFindings, type Finding } from "./report-findings";
import type { ReportHeadline } from "./report-headline";
import {
  makeInterventionComparisonReportV2,
  makeScanReportV1
} from "./scan-report-v2-fixtures";
import { buildComparisonDiffV2, evaluateComparability } from "./scan-report-v2-evaluators";
import type { PublicComparisonReportV2 } from "./scan-report-v2";
import { viewFromV1Report, viewFromV2 } from "./scan-report-views";
import type { ScanReport, ScanResult } from "./types";

type Presentation = ReturnType<typeof validateReportPresentation>;

function presentationFor(report: ScanReport): Presentation {
  const presentation = validateReportPresentation(viewFromV1Report(report));
  assert.deepEqual(
    presentation.violations,
    [],
    "the unmodified renderer path must satisfy every semantic consistency rule"
  );
  return presentation;
}

function assertOnlyViolation(
  presentation: Presentation,
  id: ReportConsistencyRuleId,
  headline: ReportHeadline = presentation.headline,
  findings: readonly Finding[] = presentation.findings
): void {
  assert.deepEqual(
    reportConsistencyViolations(presentation.facts, headline, findings).map(
      (violation) => violation.id
    ),
    [id]
  );
}

function reportWithThirdPartyCookie(): ScanResult {
  const report = makeScanReportV1() as ScanResult;
  report.summary.cookies = 1;
  report.summary.thirdPartyCookies = 1;
  report.cookies = [
    {
      name: "visit",
      domain: "metrics.example",
      path: "/",
      sameSite: "None",
      secure: true,
      httpOnly: true,
      session: true,
      thirdParty: true
    }
  ];
  return report;
}

function reportWithNamedThirdParty(): ScanResult {
  const report = makeScanReportV1() as ScanResult;
  report.summary.totalRequests = 1;
  report.summary.thirdPartyRequests = 1;
  report.summary.knownTrackerRequests = 1;
  report.summary.thirdPartyDomains = 1;
  report.domains = [
    {
      domain: "metrics.example",
      requests: 1,
      thirdParty: true,
      tracker: {
        domain: "metrics.example",
        entity: "Example Analytics",
        category: "analytics",
        confidence: "curated"
      },
      statuses: [200],
      resourceTypes: ["script"]
    }
  ];
  return report;
}

function reportWithHttpError(): ScanResult {
  const report = makeScanReportV1() as ScanResult;
  report.summary.status = 404;
  return report;
}

test("the valid renderer path has no semantic consistency violations", () => {
  const presentation = validateReportPresentation(
    viewFromV1Report(makeScanReportV1())
  );

  assert.deepEqual(presentation.violations, []);
});

test("detects a fingerprint-API story rendered without API activity", () => {
  const presentation = presentationFor(makeScanReportV1());
  const headline: ReportHeadline = {
    ...presentation.headline,
    semantic: {
      ...presentation.headline.semantic,
      story: "fingerprint-api"
    }
  };

  assertOnlyViolation(
    presentation,
    "fingerprint-asserted-without-events",
    headline
  );
});

test("detects a cookie-absence claim over a recorded third-party cookie", () => {
  const presentation = presentationFor(reportWithThirdPartyCookie());
  const headline: ReportHeadline = {
    ...presentation.headline,
    semantic: {
      ...presentation.headline.semantic,
      absenceClaims: [
        ...presentation.headline.semantic.absenceClaims,
        "third-party-cookies"
      ]
    }
  };

  assertOnlyViolation(
    presentation,
    "cookie-absence-with-recorded-cookie",
    headline
  );
});

test("detects reassuring framing over a loud finding", () => {
  const presentation = presentationFor(makeScanReportV1());
  const headline: ReportHeadline = {
    ...presentation.headline, tone: "calm",
    semantic: { ...presentation.headline.semantic, reassuring: true }
  };
  const findings: Finding[] = presentation.findings.map((finding, index) =>
    index === 0 ? { ...finding, level: "loud" } : finding
  );

  assertOnlyViolation(
    presentation,
    "quiet-copy-over-loud-finding",
    headline,
    findings
  );
});

test("detects a reassuring headline over an alert bottom line", () => {
  // The headline comes from ReportFacts and the bottom line from the findings
  // board: two answers to "is this visit quiet?". gov.uk rendered the calm
  // "showed few catalogued or fingerprint-like signals" directly above an alert
  // card reading "this visit has review-worthy signals", and neither the
  // warn/loud check nor any card-level rule caught it, because the disagreement
  // sat at "info".
  const presentation = presentationFor(makeScanReportV1());
  assert.equal(presentation.headline.semantic.reassuring, false, "omitted legacy evidence must not reassure");
  const headline: ReportHeadline = {
    ...presentation.headline, tone: "calm",
    semantic: { ...presentation.headline.semantic, reassuring: true }
  };
  const bottomLine = presentation.findings.find((finding) => finding.id === "bottom-line");
  assert.equal(bottomLine?.icon, "check", "the clean path must not already alert");

  const findings: Finding[] = presentation.findings.map((finding) =>
    finding.id === "bottom-line" ? { ...finding, icon: "alert" as const } : finding
  );

  assertOnlyViolation(
    presentation,
    "quiet-copy-over-loud-finding",
    headline,
    findings
  );
});

test("detects a service-absence card when the identity union names a party", () => {
  const presentation = presentationFor(reportWithNamedThirdParty());
  const findings: Finding[] = presentation.findings.map((finding) =>
    finding.id === "third-party-services" && finding.claim
      ? {
          ...finding,
          claim: {
            ...finding.claim,
            mode: "categorical-absence"
          }
        }
      : finding
  );

  assertOnlyViolation(
    presentation,
    "identity-conflict",
    presentation.headline,
    findings
  );
});

test("detects a categorical absence rendered while its fact gate is closed", () => {
  const presentation = presentationFor(reportWithHttpError());
  const findings: Finding[] = presentation.findings.map((finding) =>
    finding.id === "third-party-services" && finding.claim
      ? {
          ...finding,
          claim: {
            ...finding.claim,
            mode: "categorical-absence"
          }
        }
      : finding
  );

  assertOnlyViolation(
    presentation,
    "unsafe-categorical-title-under-incomplete-evidence",
    presentation.headline,
    findings
  );
});

/**
 * An intervention pair carrying one third-party cookie on exactly one arm.
 * The display arm of an intervention comparison is the baseline, so putting
 * the cookie on the variant separates "the arm the reader sees" from "the arm
 * the gate reads".
 */
function comparisonWithThirdPartyCookieOn(
  arm: "baseline" | "variant"
): PublicComparisonReportV2 {
  const report = makeInterventionComparisonReportV2();
  const run = report[arm];
  run.summary.counts.cookies = 1;
  run.summary.counts.thirdPartyCookies = 1;
  run.evidence.cookiesFinal = [
    {
      name: "visit",
      domain: "metrics.example",
      path: "/",
      sameSite: "None",
      secure: true,
      httpOnly: true,
      session: true,
      thirdParty: true
    }
  ];
  // Derived blocks are rebuilt by the shared evaluators, never hand-written,
  // so the mutated pair stays internally consistent exactly as a correct
  // producer would emit it.
  report.comparability = evaluateComparability(
    report.experiment,
    report.baseline,
    report.variant
  );
  report.diff = buildComparisonDiffV2(
    report.baseline,
    report.variant,
    report.comparability.perMetric
  );
  return report;
}

test("a variant-focused board is not failed by the display arm's cookies", () => {
  // The gate must read the arm the board was built from. Reading the display
  // arm instead invents a violation no reader can see: the variant's own card
  // correctly renders an absence, and the baseline's cookie is not its subject.
  const view = viewFromV2(comparisonWithThirdPartyCookieOn("baseline"), 1);
  const presentation = validateReportPresentation(view);
  const headline: ReportHeadline = { ...presentation.headline, focusArm: "variant" };
  const findings = buildFindings(view, null, presentation.facts, "variant");

  const cookieClaim = findings.find(
    (finding) => finding.claim?.id === "third-party-cookies"
  )?.claim;
  assert.ok(
    cookieClaim?.mode === "categorical-absence" ||
      cookieClaim?.mode === "qualified-absence",
    "the variant board must render a cookie-absence claim for this test to mean anything"
  );
  assert.equal(presentation.facts.arms?.baseline.signals.cookies.thirdParty, 1);
  assert.equal(presentation.facts.arms?.variant.signals.cookies.thirdParty, 0);

  assert.deepEqual(
    reportConsistencyViolations(presentation.facts, headline, findings),
    []
  );
});

test("a variant-focused board is still failed by the variant arm's own cookies", () => {
  // The same seam hides real defects in the other direction: an absence
  // rendered over the focused arm's own recorded cookie must still be caught
  // when the display arm happens to be clean.
  const view = viewFromV2(comparisonWithThirdPartyCookieOn("variant"), 1);
  const presentation = validateReportPresentation(view);
  const headline: ReportHeadline = { ...presentation.headline, focusArm: "variant" };
  const findings = buildFindings(view, null, presentation.facts, "variant").map(
    (finding) =>
      finding.claim?.id === "third-party-cookies"
        ? { ...finding, claim: { ...finding.claim, mode: "categorical-absence" as const } }
        : finding
  );

  assert.equal(presentation.facts.display.signals.cookies.thirdParty, 0);
  assert.equal(presentation.facts.arms?.variant.signals.cookies.thirdParty, 1);

  assert.deepEqual(
    reportConsistencyViolations(presentation.facts, headline, findings).map(
      (violation) => violation.id
    ),
    ["cookie-absence-with-recorded-cookie"]
  );
});

test("detects requested-page attribution for returned error-page evidence", () => {
  const presentation = presentationFor(reportWithHttpError());
  const headline: ReportHeadline = {
    ...presentation.headline,
    semantic: {
      ...presentation.headline.semantic,
      subjectScope: "requested-page"
    }
  };

  assertOnlyViolation(
    presentation,
    "error-page-signals-attributed-to-site",
    headline
  );
});
