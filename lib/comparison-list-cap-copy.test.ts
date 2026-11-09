import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { MAX_DIFF_LIST, comparisonListsCut, createTemporalComparisonReport } from "./compare-reports";
import { makeScanReportV1 } from "./scan-report-v2-fixtures";
import { comparisonArmViews, comparisonDiffView, viewFromV1Report } from "./scan-report-views";
import type { ScanResult } from "./types";

/**
 * The comparison panel's sentence under a list that reached its cap.
 *
 * The sentence must not say the list "was capped when the report was
 * written", or that further changes "were not retained" or are "not
 * recoverable from this report". None of that is so: the panel derives every
 * list at read time from the two visits' rows (comparisonDiffView), the cap
 * is applied there, and the rows it cut are still in the report. A reader
 * told the evidence is gone has no reason to open the JSON that holds it.
 */
function visit(scannedAt: string, domains: number): ScanResult {
  const base = makeScanReportV1();
  if (base.reportType !== "single") throw new Error("expected the single-scan fixture");
  return {
    ...base,
    conditions: { ...base.conditions, scannedAt },
    domains: Array.from({ length: domains }, (_value, index) => ({
      domain: `host-${String(index).padStart(3, "0")}.example.net`,
      requests: 1,
      thirdParty: true,
      tracker: null,
      statuses: [200],
      resourceTypes: ["script"]
    }))
  };
}

/** A before/after pair whose second visit has `added` domains the first does not. */
function pairWithNewDomains(added: number) {
  const view = viewFromV1Report(
    createTemporalComparisonReport(visit("2026-07-09T10:00:00.000Z", 0), visit("2026-07-16T10:00:00.000Z", added))
  );
  const diff = comparisonDiffView(view);
  const arms = comparisonArmViews(view);
  if (!diff || !arms) throw new Error("expected a two-visit view");
  return { diff, arms, cut: comparisonListsCut(arms.baseline, arms.variant, "rows") };
}

test("a comparison list is called cut only when it holds more changes than it shows: not at 99, not at exactly 100, at 101", () => {
  assert.equal(MAX_DIFF_LIST, 100);
  for (const [added, listed, wasCut] of [
    [99, 99, false],
    // The case a length check gets wrong: the list is as long as the cap and every change is in it.
    [100, 100, false],
    [101, 100, true],
    [130, 100, true]
  ] as const) {
    const { diff, arms, cut } = pairWithNewDomains(added);
    assert.equal(diff.addedDomains.length, listed, `${added} new domains`);
    assert.equal(cut.has("addedDomains"), wasCut, `${added} new domains`);
    // What the sentence sends a reader to: every new domain is still a row of
    // the visit that recorded it, the ones past the cap included.
    assert.equal(arms.variant.evidence.domains.length, added);
    const shown = new Set(diff.addedDomains.map((change) => change.domain));
    assert.equal(arms.variant.evidence.domains.filter((domain) => !shown.has(domain.domain)).length, added - listed);
    // Nothing else changed between the two visits, so no other list is cut.
    assert.deepEqual([...cut], wasCut ? ["addedDomains"] : []);
  }
  // In the other direction the same domains are the removed list's.
  const view = viewFromV1Report(
    createTemporalComparisonReport(visit("2026-07-09T10:00:00.000Z", 101), visit("2026-07-16T10:00:00.000Z", 0))
  );
  const arms = comparisonArmViews(view);
  if (!arms) throw new Error("expected a two-visit view");
  assert.deepEqual([...comparisonListsCut(arms.baseline, arms.variant, "rows")], ["removedDomains"]);
});

test("the panel takes each list's cut from the builder and never from a list's length", () => {
  const panel = readFileSync(path.join(process.cwd(), "app", "_components", "comparison-panel.tsx"), "utf8");
  assert.match(panel, /comparisonListsCut\(pair\.baseline, pair\.variant, "rows"\)/);
  // No list decides it is cut by comparing its own length with the cap.
  assert.doesNotMatch(panel, /length\s*>=?\s*MAX_DIFF_LIST/);
  // Every list the builder can cut is asked about by its own name.
  for (const list of [
    "addedDomains", "removedDomains", "addedCookies", "removedCookies", "addedStorageKeys", "removedStorageKeys",
    "addedEntities", "removedEntities", "addedFingerprinting", "removedFingerprinting",
    "addedPixelEvents", "removedPixelEvents", "addedProvenance", "removedProvenance"
  ]) {
    assert.match(panel, new RegExp(`=\\{cut\\("${list}"\\)\\}`), list);
  }
});

test("the panel's sentence under a capped list says where the rest is, and claims no loss", () => {
  const panel = readFileSync(path.join(process.cwd(), "app", "_components", "comparison-panel.tsx"), "utf8");
  const note = panel.slice(panel.indexOf('className="muted change-list-cap-note"'), panel.indexOf("</p>", panel.indexOf("change-list-cap-note")));
  assert.match(
    note.replace(/\s+/g, " "),
    /This list stops at the first \{MAX_DIFF_LIST\.toLocaleString\("en-US"\)\} changes\. Further changes are not listed here; they can be worked out from both visits&apos; rows in the report JSON\./
  );
  assert.doesNotMatch(note, /not recoverable|were not retained|when the report was written/);
});
