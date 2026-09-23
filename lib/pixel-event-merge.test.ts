import assert from "node:assert/strict";
import { test } from "node:test";
import { mergePixelEventSummaries } from "./pixel-event-merge";
import { summarizePixelEvents, type PixelEventInput } from "./pixel-events";
import { buildRunFacts } from "./report-facts";
import { buildFindings } from "./report-findings";
import { makeGpcInterventionReportV2R2, makePublicSingleReportV2R2 } from "./scan-report-v2-r2-fixtures";
import { comparisonDiffView, viewFromV2 } from "./scan-report-views";
import type { PixelEventSummary } from "./types";

const HASH = "a".repeat(64);

type PhasedPixelRow = PixelEventSummary & { phaseId: number };

// The r2 producer's per-phase rows for one Meta pixel that fired during the
// page load and again during a later phase (lib/scanner.ts summarizes each
// phase separately and tags the rows with its phaseId).
function twoPhaseMetaRows(): PhasedPixelRow[] {
  return [
    { platform: "Meta", product: "Meta Pixel", events: ["PageView"], advancedMatching: ["external_id"], requests: 2, phaseId: 0 },
    { platform: "Meta", product: "Meta Pixel", events: ["Lead", "PageView"], advancedMatching: ["email"], requests: 1, phaseId: 1 }
  ];
}

test("merging per-phase summaries reproduces the whole-visit summary", () => {
  // Every platform and every identifier category, deliberately out of
  // canonical order and split across two phases the way the scanner splits
  // them. If this merge and summarizePixelEvents ever disagree on ordering
  // or dedupe, a v2 report stops rendering like the v1 aggregate of the
  // same visit.
  const loadPhase: PixelEventInput[] = [
    { url: "https://analytics.twitter.com/i/adsct?txn_id=a&type=javascript" },
    { url: `https://www.facebook.com/tr/?id=1&ev=Purchase&ud%5Bexternal_id%5D=abc&ud%5Bge%5D=${HASH}&ud%5Bem%5D=${HASH}` },
    {
      url: "https://analytics.tiktok.com/api/v2/pixel",
      method: "POST",
      postData: JSON.stringify({ event: "CompletePayment", context: { user: { phone_number: HASH } } })
    }
  ];
  const laterPhase: PixelEventInput[] = [
    { url: `https://www.facebook.com/tr/?id=1&ev=PageView&ud%5Bdb%5D=${HASH}&ud%5Bct%5D=${HASH}&ud%5Bfn%5D=${HASH}&ud%5Bph%5D=${HASH}` },
    { url: "https://www.facebook.com/tr/?id=1&ev=AddToCart" },
    {
      url: "https://analytics.tiktok.com/api/v2/pixel",
      method: "POST",
      postData: JSON.stringify({ event: "ViewContent", context: { user: { email: HASH } } })
    }
  ];

  const perPhase = [...summarizePixelEvents(laterPhase), ...summarizePixelEvents(loadPhase)];
  assert.equal(perPhase.length, 5, "the fixture must actually repeat platforms across phases");
  assert.deepEqual(mergePixelEventSummaries(perPhase), summarizePixelEvents([...loadPhase, ...laterPhase]));
});

test("a v2 pixel that fired in two phases is one platform on every reader surface", () => {
  const report = makePublicSingleReportV2R2();
  report.run.evidence.pixelEvents = twoPhaseMetaRows();
  report.run.evidence.privacyPolicy = {
    url: "https://shop.example.com/privacy",
    claims: [{ kind: "no-selling-or-sharing", quote: "We do not sell or share your personal information." }],
    mentionedEntities: [],
    unmentionedEntities: [],
    policyTextLength: 5000
  };
  report.run.detectors["privacy-policy"] = { version: report.run.detectors["privacy-policy"].version, status: "complete" };

  const view = viewFromV2(report, 2);
  const run = view.runs[0];
  assert.deepEqual(run.evidence.pixelEvents, [
    { platform: "Meta", product: "Meta Pixel", events: ["Lead", "PageView"], advancedMatching: ["email", "external_id"], requests: 3 }
  ]);

  const facts = buildRunFacts(run);
  assert.equal(facts.signals.pixels.withEventLabels.length, 1);
  assert.equal(facts.signals.pixels.withIdentifiers.length, 1);

  const findings = buildFindings(view, null);
  const pixel = findings.find((finding) => finding.id === "pixel-events");
  assert.ok(pixel);
  assert.equal(
    pixel.lead,
    "Meta Pixel attached populated personal-identifier fields (email and external ID) to requests observed in this visit."
  );
  assert.equal(pixel.evidence, "Meta Pixel: Lead and PageView; identifiers email and external ID (3 requests)");

  const policy = findings.find((finding) => finding.id === "privacy-policy");
  assert.ok(policy);
  assert.match(policy.lead, /advertising events to Meta Pixel carried populated personal-identifier fields/);
  assert.doesNotMatch(policy.lead, /Meta Pixel and Meta Pixel/);

  // The wire is untouched: the per-phase rows stay the published record.
  assert.equal(report.run.evidence.pixelEvents.length, 2);
});

test("a comparison arm whose pixel fired in two phases diffs as one platform", () => {
  const report = makeGpcInterventionReportV2R2();
  report.baseline.evidence.pixelEvents = [];
  report.variant.evidence.pixelEvents = twoPhaseMetaRows();

  const diff = comparisonDiffView(viewFromV2(report, 2));
  assert.deepEqual(diff?.addedPixelEvents, [
    { platform: "Meta", product: "Meta Pixel", events: ["Lead", "PageView"], advancedMatching: ["email", "external_id"] }
  ]);
});
