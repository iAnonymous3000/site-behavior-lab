import assert from "node:assert/strict";
import { test } from "node:test";
import {
  reportConsistencyViolations,
  validateReportPresentation,
  type ReportConsistencyRuleId
} from "./report-consistency";
import type { Finding } from "./report-findings";
import type { ReportHeadline } from "./report-headline";
import { makeScanReportV1 } from "./scan-report-v2-fixtures";
import { viewFromV1Report } from "./scan-report-views";
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
  const findings: Finding[] = presentation.findings.map((finding, index) =>
    index === 0 ? { ...finding, level: "loud" } : finding
  );

  assertOnlyViolation(
    presentation,
    "quiet-copy-over-loud-finding",
    presentation.headline,
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
  assert.equal(presentation.headline.semantic.reassuring, true);
  const bottomLine = presentation.findings.find((finding) => finding.id === "bottom-line");
  assert.equal(bottomLine?.icon, "check", "the clean path must not already alert");

  const findings: Finding[] = presentation.findings.map((finding) =>
    finding.id === "bottom-line" ? { ...finding, icon: "alert" as const } : finding
  );

  assertOnlyViolation(
    presentation,
    "quiet-copy-over-loud-finding",
    presentation.headline,
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
