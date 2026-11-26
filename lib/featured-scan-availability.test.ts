import assert from "node:assert/strict";
import { test } from "node:test";
import { activeFeaturedSiteUnavailability, featuredAcquisitionDateFromRun } from "./featured-scan-availability";
import { featuredReportPublicationRequest } from "./report-publication-request";

const SHA = "a".repeat(40);
const site = { domain: "blocked.test", scanAvailability: {
  status: "temporarily-unavailable", reason: "automation-blocked", observedAt: "2026-08-10",
  reviewAfter: "2026-09-07", workflowRunIds: ["30798490888", "31363160441"]
}};

test("expired deferrals re-enter ordinary selection, while frozen and malformed evidence fails closed", () => {
  assert.ok(activeFeaturedSiteUnavailability(site, {}, "2026-09-07"));
  assert.equal(activeFeaturedSiteUnavailability(site, {}, "2026-09-08"), null);
  assert.ok(activeFeaturedSiteUnavailability(site, { FEATURED_ACQUISITION_DATE: "2026-09-07" }, "2026-09-08"));
  assert.throws(() => activeFeaturedSiteUnavailability(site, {
    FEATURED_ACQUISITION_DATE: "2026-09-07", SITE_BEHAVIOR_LAB_MEASUREMENT_FREEZE: "1"
  }, "2026-09-08"), /Invalid scanAvailability/);
  assert.throws(() => activeFeaturedSiteUnavailability({ ...site, scanAvailability: {
    ...site.scanAvailability, workflowRunIds: []
  }}, {}, "2026-09-08"), /Invalid scanAvailability/);
  assert.throws(() => activeFeaturedSiteUnavailability(site, { FEATURED_ACQUISITION_DATE: "2026-09-09" }, "2026-09-08"), /Invalid FEATURED_ACQUISITION_DATE/);
  assert.throws(() => activeFeaturedSiteUnavailability(site, { SITE_BEHAVIOR_LAB_MEASUREMENT_FREEZE: "true" }), /must be exactly/);
});

test("trusted publication derives deterministic catalog selection from acquisition date", async () => {
  const environment = { FEATURED_ACQUISITION_DATE: "2026-09-07", FEATURED_COMPARE_SHIELDS: "true" };
  const publication = await featuredReportPublicationRequest(process.cwd(), environment);
  assert.equal(publication.targets.length, 68);
  const expiredPublication = await featuredReportPublicationRequest(
    process.cwd(),
    { ...environment, FEATURED_ACQUISITION_DATE: "2026-09-08" },
    "2026-09-08"
  );
  assert.equal(expiredPublication.targets.length, 81);
});

test("eligibility date is bound to immutable run and source metadata", () => {
  const metadata = { id: 123456, head_sha: SHA, created_at: "2026-09-07T04:36:03Z" };
  const now = new Date("2026-09-08T00:00:00Z");
  assert.equal(featuredAcquisitionDateFromRun(metadata, "123456", SHA, now), "2026-09-07");
  for (const changed of [ {id: 654321}, {head_sha: "b".repeat(40)}, {created_at: "2026-09-09T00:00:00Z"},
    {created_at: "2026-02-30T00:00:00Z"}, {created_at: "garbage"} ]) {
    assert.throws(() => featuredAcquisitionDateFromRun({ ...metadata, ...changed }, "123456", SHA, now));
  }
});
