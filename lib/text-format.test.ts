import assert from "node:assert/strict";
import { test } from "node:test";
import { comparisonDeltaHeading, displayHost, hostMatchesQuery, reportKindLabel } from "./text-format";

test("host search accepts the wildcard form displayed to readers", () => {
  assert.equal(displayHost("{label}.metrics.example"), "*.metrics.example");
  assert.equal(hostMatchesQuery("{label}.metrics.example", "*.metrics.example"), true);
  assert.equal(hostMatchesQuery("{label}.metrics.example", "{label}.metrics"), true);
  assert.equal(hostMatchesQuery("{label}.metrics.example", "unrelated"), false);
});

test("report kind labels distinguish consent comparisons from incomplete attempts", () => {
  const consent = (consentClicks: "accept-and-reject" | "accept-only" | "reject-only" | "none") =>
    reportKindLabel({ reportType: "comparison", comparisonType: "consent", consentClicks });

  assert.equal(consent("accept-and-reject"), "consent comparison");
  assert.equal(consent("accept-only"), "consent comparison attempt (Reject not clicked)");
  assert.equal(consent("reject-only"), "consent comparison attempt (Accept not clicked)");
  assert.equal(consent("none"), "consent comparison attempt (no banner clicked)");
  assert.equal(reportKindLabel({ reportType: "single" }), "single scan");
  assert.equal(reportKindLabel({ reportType: "comparison", comparisonType: "shields" }), "Brave-list blocking comparison");
});

test("comparison heading does not promise a delta when no metric family is comparable", () => {
  const labels = { baseline: "GPC off", variant: "GPC on" };
  assert.equal(comparisonDeltaHeading(labels, true), "GPC off → GPC on delta");
  assert.equal(
    comparisonDeltaHeading(labels, false),
    "GPC off and GPC on: two visits, no comparable metric delta"
  );
});
