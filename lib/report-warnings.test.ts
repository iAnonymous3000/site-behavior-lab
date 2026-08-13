import assert from "node:assert/strict";
import test from "node:test";
import {
  groupReportWarnings,
  reportWarningCount,
  type ComparisonRunLabels
} from "./report-warnings";

const SHIELDS: ComparisonRunLabels = { baseline: "No blocking", variant: "Brave-list blocking" };

/**
 * Verbatim from the committed report for usatoday.com
 * (20260807-638b67a5f3933ada6476b68781c9bb37), which rendered sixteen banners.
 * Three of these sentences are recorded by both visits and were printed twice.
 */
const REAL_WARNINGS = [
  "Brave-list blocking comparison runs should be collected under matched crawl conditions, and the blocking run is a simulation with Brave's engine and default lists in this scanner's browser, not a live Brave visit.",
  'The two visits ran in randomized order; the "Brave-list blocking" visit ran first.',
  "No blocking: This report is one automated, headless Chromium visit from a fixed en-US / UTC profile, with no scrolling, clicking, or consent interaction.",
  "No blocking: Counts are a lower bound: trackers that load only after interaction or consent are not observed.",
  "No blocking: The page did not reach network idle before the scan window ended.",
  "No blocking: The scan stopped recording or loading additional requests after 1000 requests.",
  "Brave-list blocking: This report is one automated, headless Chromium visit from a fixed en-US / UTC profile, with no scrolling, clicking, or consent interaction.",
  "Brave-list blocking: Counts are a lower bound: trackers that load only after interaction or consent are not observed.",
  "Brave-list blocking: Brave Shields block simulation was enabled; matching requests were aborted before loading and are not included in request totals."
];

test("a single-run report keeps one unattributed group", () => {
  const groups = groupReportWarnings(["The page did not reach network idle.", "Counts are a lower bound."], null);
  assert.deepEqual(groups, [
    {
      scope: "report",
      label: null,
      warnings: ["The page did not reach network idle.", "Counts are a lower bound."]
    }
  ]);
});

test("no warnings produce no groups", () => {
  assert.deepEqual(groupReportWarnings([], SHIELDS), []);
  assert.deepEqual(groupReportWarnings([], null), []);
});

test("exact duplicates collapse, as the flat renderer already did", () => {
  const groups = groupReportWarnings(["Same sentence.", "Same sentence."], null);
  assert.deepEqual(groups[0].warnings, ["Same sentence."]);
});

test("a sentence recorded by both visits is stated once, attributed to both", () => {
  const groups = groupReportWarnings(REAL_WARNINGS, SHIELDS);
  const both = groups.find((group) => group.scope === "both");
  assert.ok(both, "expected a both-visits group");
  assert.equal(both.label, "Both visits");
  assert.deepEqual(both.warnings, [
    "This report is one automated, headless Chromium visit from a fixed en-US / UTC profile, with no scrolling, clicking, or consent interaction.",
    "Counts are a lower bound: trackers that load only after interaction or consent are not observed."
  ]);
});

test("arm-specific sentences stay attributed to the visit that recorded them", () => {
  const groups = groupReportWarnings(REAL_WARNINGS, SHIELDS);
  const baseline = groups.find((group) => group.scope === "baseline");
  const variant = groups.find((group) => group.scope === "variant");

  assert.equal(baseline?.label, "No blocking visit only");
  assert.deepEqual(baseline?.warnings, [
    "The page did not reach network idle before the scan window ended.",
    "The scan stopped recording or loading additional requests after 1000 requests."
  ]);

  assert.equal(variant?.label, "Brave-list blocking visit only");
  assert.deepEqual(variant?.warnings, [
    "Brave Shields block simulation was enabled; matching requests were aborted before loading and are not included in request totals."
  ]);
});

test("unprefixed report-level sentences are not attributed to a visit", () => {
  const groups = groupReportWarnings(REAL_WARNINGS, SHIELDS);
  const report = groups.find((group) => group.scope === "report");
  assert.equal(report?.label, "This report");
  assert.deepEqual(report?.warnings, [REAL_WARNINGS[0], REAL_WARNINGS[1]]);
});

/**
 * The property that makes this safe to ship: regrouping may not lose, add, or
 * silently alter a caveat. A sentence behind a disclosure is a defect; a
 * sentence that vanished is worse.
 */
test("every distinct sentence survives regrouping exactly once", () => {
  const groups = groupReportWarnings(REAL_WARNINGS, SHIELDS);
  const rendered = groups.flatMap((group) => group.warnings);
  assert.equal(rendered.length, new Set(rendered).size, "a sentence was rendered twice");
  assert.equal(reportWarningCount(groups), rendered.length);

  // Each original warning is still readable: either verbatim, or as a body that
  // one of its arms' groups now carries under an attributed heading.
  for (const original of REAL_WARNINGS) {
    const body = original
      .replace(/^No blocking: /, "")
      .replace(/^Brave-list blocking: /, "");
    assert.ok(rendered.includes(body), `lost: ${original}`);
  }

  // Seven rows for nine banners on this slice, with nothing removed: the two
  // sentences both visits recorded stop being printed twice.
  assert.equal(REAL_WARNINGS.length, 9);
  assert.equal(rendered.length, 7);
});

test("groups are ordered report, both, baseline, variant", () => {
  const groups = groupReportWarnings(REAL_WARNINGS, SHIELDS);
  assert.deepEqual(
    groups.map((group) => group.scope),
    ["report", "both", "baseline", "variant"]
  );
});

test("first appearance decides order inside a group", () => {
  const groups = groupReportWarnings(
    ["No blocking: Second.", "No blocking: First.", "Brave-list blocking: First."],
    SHIELDS
  );
  assert.deepEqual(groups.find((group) => group.scope === "baseline")?.warnings, ["Second."]);
  assert.deepEqual(groups.find((group) => group.scope === "both")?.warnings, ["First."]);
});

test("identical arm labels fall back to the flat, unattributed list", () => {
  const warnings = ["Same: one.", "Same: two."];
  const groups = groupReportWarnings(warnings, { baseline: "Same", variant: "Same" });
  assert.deepEqual(groups, [{ scope: "report", label: null, warnings }]);
});

/**
 * The subtle one. Attribution is ambiguous when one arm's whole PREFIX, colon
 * and space included, is a prefix of the other's: "A: " strips off the front of
 * an "A: B: ..." entry and files it under the wrong visit with a "B: " fragment
 * left in front of the sentence. Attributing a caveat to a visit that did not
 * record it is a claim the evidence does not support, so the grouping is
 * abandoned rather than guessed at.
 */
test("a label whose prefix prefixes the other falls back rather than misattributing", () => {
  const warnings = ["Baseline: Variant: one.", "Baseline: two."];
  for (const labels of [
    { baseline: "Baseline", variant: "Baseline: Variant" },
    { baseline: "Baseline: Variant", variant: "Baseline" }
  ]) {
    assert.deepEqual(
      groupReportWarnings(warnings, labels),
      [{ scope: "report", label: null, warnings }],
      `${labels.baseline} / ${labels.variant} must not attribute`
    );
  }
});

/**
 * And the case that only LOOKS ambiguous, kept so the guard is not widened into
 * refusing real label pairs. One label being a prefix of the other as a WORD is
 * fine, because the separator ends it: "Blocking off: x" cannot match the
 * "Blocking: " prefix. Blocking-off/blocking-on wording is exactly the shape
 * this project's own comparison labels take.
 */
test("a label that is a word-prefix of the other still attributes correctly", () => {
  const groups = groupReportWarnings(["Blocking off: one.", "Blocking: two."], {
    baseline: "Blocking",
    variant: "Blocking off"
  });
  assert.deepEqual(groups, [
    { scope: "baseline", label: "Blocking visit only", warnings: ["two."] },
    { scope: "variant", label: "Blocking off visit only", warnings: ["one."] }
  ]);
});

test("an empty label falls back rather than stripping every sentence", () => {
  const warnings = ["No blocking: one."];
  assert.deepEqual(groupReportWarnings(warnings, { baseline: "", variant: "No blocking" }), [
    { scope: "report", label: null, warnings }
  ]);
});

test("a bare label with no sentence after it keeps its original text", () => {
  const groups = groupReportWarnings(["No blocking: "], SHIELDS);
  assert.deepEqual(groups, [
    { scope: "baseline", label: "No blocking visit only", warnings: ["No blocking: "] }
  ]);
});

test("a colon inside a sentence is not mistaken for a label prefix", () => {
  const warnings = ["Counts are a lower bound: trackers that load after consent are not observed."];
  const groups = groupReportWarnings(warnings, SHIELDS);
  assert.deepEqual(groups, [{ scope: "report", label: "This report", warnings }]);
});
