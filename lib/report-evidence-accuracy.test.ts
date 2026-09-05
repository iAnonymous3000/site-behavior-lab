import assert from "node:assert/strict";
import { test } from "node:test";
import { buildReportFacts } from "./report-facts";
import { buildFindings } from "./report-findings";
import { buildReportHeadline } from "./report-headline";
import { readStoredScanReport } from "./scan-report-reader";
import { evaluateQuality } from "./scan-report-v2-evaluators";
import { makePublicSingleReportV2, makeScanReportV1 } from "./scan-report-v2-fixtures";
import { viewFromV1Report, viewFromV2 } from "./scan-report-views";
import type { ScanResult } from "./types";

test("reader-valid unknown and unscoped loss cannot certify a scoped detector measurement", () => {
  for (const detail of [undefined, "external-producer-buffer-loss"]) {
    const report = makePublicSingleReportV2();
    report.run.qualityFacts.captureLoss.push({
      family: "detector-output", phaseId: 0, kind: "dropped", count: 1,
      ...(detail ? { detail } : {})
    });
    report.run.quality = evaluateQuality(report.run.qualityFacts, { observedRequests: 1 });
    assert.equal(readStoredScanReport(report).ok, true, "open diagnostic vocabulary remains readable");
    const view = viewFromV2(report, 1);
    const facts = buildReportFacts(view).display;
    for (const id of ["pixel-events", "cname-cloaking", "consent-banner"] as const) {
      assert.equal(facts.claims[id].allowed, false, `${id}: ${detail}`);
      assert.equal(facts.claims[id].exactCountAllowed, false);
      assert.equal(facts.claims[id].benchmarkAllowed, false);
    }
    assert.equal(facts.claims["pixel-events"].lowerBound, true, "retained positive counts remain useful");
    assert.equal(facts.claims["third-party-services"].allowed, true, "independent request evidence remains usable");
  }
});

test("legacy normalization preserves omitted optional evidence without rewriting the wire", () => {
  const report = makeScanReportV1() as ScanResult;
  const original = JSON.stringify(report);
  assert.equal(readStoredScanReport(report).ok, true);
  const view = viewFromV1Report(report);
  const facts = buildReportFacts(view).display;
  assert.equal(facts.calmEligible, false);
  for (const id of ["pixel-events", "cname-cloaking", "session-recording-input-monitoring", "privacy-policy"] as const) {
    assert.ok(facts.claims[id].blockers.includes("evidence-unrecorded"));
    assert.equal(facts.claims[id].exactCountAllowed, false);
    assert.equal(facts.claims[id].lowerBound, false);
  }
  assert.equal(facts.claims["third-party-services"].allowed, true);
  assert.equal(view.runs[0].detectors, null, "no synthetic historical detector ledger");
  assert.match(buildReportHeadline(view).subhead, /not recorded in this legacy report/);
  assert.doesNotMatch(buildReportHeadline(view).subhead, /no .*matched heuristics/);
  assert.equal(JSON.stringify(report), original);

  report.pixelEvents = [];
  const recordedEmpty = buildReportFacts(viewFromV1Report(report)).display;
  assert.equal(recordedEmpty.claims["pixel-events"].allowed, true, "explicit empty output differs from omitted output");
  assert.equal(recordedEmpty.claims["cname-cloaking"].allowed, false);
});

test("an endpoint-only pixel record never becomes a named-event claim", () => {
  const report = makeScanReportV1() as ScanResult;
  report.pixelEvents = [{ platform: "Meta", product: "Meta Pixel", requests: 1, events: [], advancedMatching: [] }];
  assert.equal(readStoredScanReport(report).ok, true);
  const finding = buildFindings(viewFromV1Report(report), null).find((item) => item.id === "pixel-events");
  assert.ok(finding);
  assert.equal(finding.title, "Advertising pixel endpoints were observed");
  assert.match(finding.lead, /no event label was retained/);
  assert.doesNotMatch(finding.lead, /reported specific|contained event labels/);
  assert.match(finding.detail, /older decoders did not record every decoding gap/);
});

test("mixed pixel records name only products with retained labels and never infer a user action", () => {
  const report = makeScanReportV1() as ScanResult;
  report.pixelEvents = [
    { platform: "Meta", product: "Meta Pixel", requests: 1, events: [], advancedMatching: [] },
    { platform: "TikTok", product: "TikTok Pixel", requests: 1, events: ["CompletePayment"], advancedMatching: [] }
  ];
  const finding = buildFindings(viewFromV1Report(report), null).find((item) => item.id === "pixel-events");
  assert.ok(finding);
  assert.match(finding.lead, /TikTok Pixel requests contained event labels/);
  assert.doesNotMatch(finding.lead, /Meta/);
  assert.match(finding.detail, /do not establish user actions or successful delivery/);
});
