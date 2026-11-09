import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { MAX_DIFF_LIST, createTemporalComparisonReport } from "./compare-reports";
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

test("a comparison list that reaches its cap was cut at read time, and the rows it cut are still in the report", () => {
  const extra = MAX_DIFF_LIST + 30;
  const view = viewFromV1Report(
    createTemporalComparisonReport(visit("2026-07-09T10:00:00.000Z", 0), visit("2026-07-16T10:00:00.000Z", extra))
  );
  const diff = comparisonDiffView(view);
  const arms = comparisonArmViews(view);
  if (!diff || !arms) throw new Error("expected a two-visit view");
  // The list stops at the cap...
  assert.equal(diff.addedDomains.length, MAX_DIFF_LIST);
  // ...and every domain past it is still a row of the visit that recorded it.
  assert.equal(arms.variant.evidence.domains.length, extra);
  const listed = new Set(diff.addedDomains.map((change) => change.domain));
  assert.equal(arms.variant.evidence.domains.filter((domain) => !listed.has(domain.domain)).length, 30);
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
