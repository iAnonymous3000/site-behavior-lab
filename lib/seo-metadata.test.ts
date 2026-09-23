import assert from "node:assert/strict";
import test from "node:test";
import {
  conciseMetadataText,
  correctionMetadataDescription,
  newestSitemapDate,
  publicPageMetadata,
  REPORT_RENDERED_TITLE_MAX_LENGTH,
  reportMetadataDescription,
  reportMetadataTitle,
  SITE_TITLE_SUFFIX,
  sitemapLastModified
} from "./seo-metadata";
import { buildReportHeadline } from "./report-headline";
import { makePublicSingleReportV2R2 } from "./scan-report-v2-r2-fixtures";
import { viewFromV2 } from "./scan-report-views";

test("report metadata is concise, report-specific, and retains the evidence caveat", () => {
  const title = reportMetadataTitle({
    domain: "example.com",
    reportId: "20260720-0123456789abcdef",
    scannedAt: "2026-07-20T10:11:12.000Z",
    reportType: "comparison",
    comparisonAxis: "gpc"
  });
  assert.equal(title, "example.com GPC · 2026-07-20 · 89abcdef");
  assert.ok(`${title}${SITE_TITLE_SUFFIX}`.length <= REPORT_RENDERED_TITLE_MAX_LENGTH);
  assert.match(
    reportMetadataTitle({
      domain: "a-very-long-customer-portal-subdomain.example.test",
      reportId: "20260720-fedcba9876543210",
      scannedAt: "2026-07-20T10:11:12.000Z",
      reportType: "single"
    }),
    /scan · 2026-07-20 · 76543210$/
  );

  const secondTitle = reportMetadataTitle({
    domain: "example.com",
    reportId: "20260720-fedcba9876543210",
    scannedAt: "2026-07-20T10:11:12.000Z",
    reportType: "comparison",
    comparisonAxis: "gpc"
  });
  assert.notEqual(title, secondTitle, "same-day reports retain distinct titles");
  assert.ok(`${secondTitle}${SITE_TITLE_SUFFIX}`.length <= REPORT_RENDERED_TITLE_MAX_LENGTH);
  assert.match(
    reportMetadataTitle({
      domain: "{label}.example.com",
      reportId: "20260720-fedcba9876543210",
      scannedAt: "2026-07-20T10:11:12.000Z",
      reportType: "single"
    }),
    /^\*\.example\.com scan/
  );

  // Built from the real headline builder, never a hand-written claim: the
  // claim-bearing candidates this replaced were exercised only by a synthetic
  // 68-character claim no headline branch has ever produced, while every real
  // claim plus its qualification and the caveat exceeds the 160-character
  // bound, so every report already published this fallback.
  const headline = buildReportHeadline(viewFromV2(makePublicSingleReportV2R2(), 2));
  const description = reportMetadataDescription(headline);
  assert.equal(
    description,
    `Automated visit to ${headline.domain}. Open the report for the complete finding, evidence scope, and limitations. Evidence to check, not a verdict.`
  );
  assert.ok(description.length <= 160);

  // However short a claim is, the description never quotes headline prose: a
  // claim severed from the report's qualification is the overclaim the
  // fallback exists to prevent, and a fitting path only a synthetic claim
  // reaches is a guard that cannot fail.
  const shortClaim = {
    ...headline,
    headline: "example.com returned HTTP 403.",
    subheadPrimaryClaim: "Signals describe the returned block page, not normal site behavior.",
    subhead: "Signals describe the returned block page, not normal site behavior."
  };
  assert.equal(reportMetadataDescription(shortClaim), description);
});

test("metadata truncation collapses whitespace and stops cleanly", () => {
  assert.equal(conciseMetadataText("  one\n two   three  ", 20), "one two three");
  assert.equal(conciseMetadataText("one two three four five", 16), "one two three…");
});

test("every correction state retains bounded metadata and the complete evidence caveat", () => {
  for (const state of ["active", "corrected", "superseded", "withdrawn"] as const) {
    const description = correctionMetadataDescription(state);
    assert.ok(description.length <= 160);
    assert.match(description, /Read the report and correction together/);
    assert.match(description, /Evidence to check, not a verdict\.$/);
    assert.ok(description.includes(state === "active" ? "clarification" : state));
  }
});

test("report metadata never turns an incomplete fingerprint detector into clean absence copy", () => {
  const report = makePublicSingleReportV2R2();
  report.run.detectors["fingerprint-heuristics"] = {
    ...report.run.detectors["fingerprint-heuristics"],
    status: "failed",
    reason: "scan-failed"
  };
  const headline = buildReportHeadline(viewFromV2(report, 2));
  const description = reportMetadataDescription(headline);

  assert.equal(headline.tone, "info");
  assert.doesNotMatch(`${headline.headline} ${headline.subhead} ${description}`, /looked quiet|few .* signals|no fingerprint-observer events/i);
  assert.match(`${headline.headline} ${headline.subhead}`, /needs context|did not finish|unproven/i);
});

test("sitemap dates are evidence-derived, valid, and never future-dated", () => {
  const now = Date.parse("2026-07-21T00:00:00.000Z");
  assert.equal(sitemapLastModified("2026-07-20T10:11:12.000Z", now)?.toISOString(), "2026-07-20T10:11:12.000Z");
  assert.equal(sitemapLastModified("not-a-date", now), undefined);
  assert.equal(sitemapLastModified("2026-07-22T00:00:00.000Z", now), undefined);
  assert.equal(
    newestSitemapDate(["2026-07-18T00:00:00.000Z", "2026-07-20T00:00:00.000Z"], now)?.toISOString(),
    "2026-07-20T00:00:00.000Z"
  );
});

test("public page metadata uses one base-path-aware absolute URL and complete social copy", () => {
  const previousOrigin = process.env.NEXT_PUBLIC_SITE_BEHAVIOR_LAB_SITE_URL;
  const previousBasePath = process.env.NEXT_PUBLIC_SITE_BEHAVIOR_LAB_PAGES_BASE_PATH;
  process.env.NEXT_PUBLIC_SITE_BEHAVIOR_LAB_SITE_URL = "https://example.com";
  process.env.NEXT_PUBLIC_SITE_BEHAVIOR_LAB_PAGES_BASE_PATH = "/project";
  try {
    const metadata = publicPageMetadata({
      title: "Evidence catalog",
      description: "Review the current evidence catalog.",
      path: "/catalog/"
    });
    assert.equal(metadata.alternates?.canonical, "https://example.com/project/catalog/");
    assert.equal(metadata.openGraph?.url, "https://example.com/project/catalog/");
    assert.equal(metadata.openGraph?.title, "Evidence catalog");
    assert.equal(metadata.openGraph?.description, "Review the current evidence catalog.");
    assert.equal(metadata.openGraph?.siteName, "Site Behavior Lab");
    assert.deepEqual(metadata.openGraph?.images, [
      {
        url: "https://example.com/project/opengraph-image",
        width: 1200,
        height: 630,
        alt: "Site Behavior Lab"
      }
    ]);
    assert.equal(metadata.twitter?.title, "Evidence catalog");
    assert.equal(metadata.twitter?.description, "Review the current evidence catalog.");
    assert.deepEqual(metadata.twitter?.images, ["https://example.com/project/twitter-image"]);
  } finally {
    if (previousOrigin === undefined) delete process.env.NEXT_PUBLIC_SITE_BEHAVIOR_LAB_SITE_URL;
    else process.env.NEXT_PUBLIC_SITE_BEHAVIOR_LAB_SITE_URL = previousOrigin;
    if (previousBasePath === undefined) delete process.env.NEXT_PUBLIC_SITE_BEHAVIOR_LAB_PAGES_BASE_PATH;
    else process.env.NEXT_PUBLIC_SITE_BEHAVIOR_LAB_PAGES_BASE_PATH = previousBasePath;
  }
});
