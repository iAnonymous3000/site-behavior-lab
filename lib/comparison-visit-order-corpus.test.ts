import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { comparisonVisitOrderLine } from "./comparison-visit-order";
import { readStoredScanReport } from "./scan-report-reader";
import { loadedReportFromStored, type LoadedReport } from "./scan-report-view";
import { createLoadedTemporalComparison } from "./temporal-report-comparison";

const reportsDir = path.join(process.cwd(), "public", "reports");
const reportFilePattern = /^[0-9]{8}-[0-9a-f]{32}\.json$/;
// Any warning shaped like the v1 producer's order sentence, whatever label it
// names. Deliberately not comparisonOrderDisclosure: if that function and the
// stored sentences ever drift apart, every v1 order would silently read as not
// recorded, and this independent shape is what notices.
const ORDER_SENTENCE = /^The two visits ran in randomized order; the "[^"]+" visit ran first\.$/;
// Commit 5b28f16a ("Randomize comparison arm execution order"). A comparison
// with no order record must have run under the fixed order that preceded it.
const RANDOMIZATION_COMMITTED_AT = Date.parse("2026-07-13T20:25:14Z");
const FORBIDDEN_ORDER_WORDS = /randomi[sz]|counterbalanc/i;

test("every committed comparison states its visit order, and every recorded order matches the start times", () => {
  // A missing or empty corpus fails here instead of passing over zero reports.
  const files = readdirSync(reportsDir).filter((name) => reportFilePattern.test(name)).sort();
  assert.ok(files.length > 0, "no committed reports under public/reports; this test would be vacuous");

  const counts = { recordedV1: 0, recordedV2: 0, startTimeOrder: 0, archivePairs: 0 };
  const bySite = new Map<string, LoadedReport[]>();
  for (const name of files) {
    const read = readStoredScanReport(JSON.parse(readFileSync(path.join(reportsDir, name), "utf8")));
    assert.equal(read.ok, true, `reader rejected committed report ${name}`);
    if (!read.ok) continue;
    const loaded = loadedReportFromStored(read.stored);
    const siteKey = `${loaded.source}|${loaded.view.domain}`;
    const site = bySite.get(siteKey);
    if (site) site.push(loaded);
    else bySite.set(siteKey, [loaded]);

    const view = loaded.view;
    if (view.reportType !== "comparison") continue;
    assert.ok(view.comparison, `${name}: a comparison view without its comparison block`);
    const order = view.comparison.visitOrder;
    const line = comparisonVisitOrderLine(order, view.comparison.runLabels);
    assert.doesNotMatch(line?.text ?? "", FORBIDDEN_ORDER_WORDS, `${name}: the order line calls the pair ${line?.text}`);
    assert.equal(
      order.state === "not-applicable",
      view.comparison.temporalPair,
      `${name}: only a temporal pair may state no order (state ${order.state})`
    );
    if (order.state === "not-applicable") continue;

    // Both records must land in "recorded", read independently of the reader.
    if (loaded.source === "v1" && loaded.wire.warnings.some((warning) => ORDER_SENTENCE.test(warning))) {
      assert.equal(order.state, "recorded", `${name}: carries an order sentence the view did not read`);
    }
    if (view.comparison.order !== null) {
      assert.equal(order.state, "recorded", `${name}: records ${view.comparison.order}, which the view did not read`);
    }

    const baselineMs = Date.parse(view.runs[0].startedAt ?? "");
    const variantMs = Date.parse(view.runs[view.runs.length - 1].startedAt ?? "");
    if (order.state === "recorded") {
      assert.ok(
        Number.isFinite(baselineMs) && Number.isFinite(variantMs) && baselineMs !== variantMs,
        `${name}: the recorded order cannot be checked against start times that do not order the visits`
      );
      assert.equal(
        order.first,
        baselineMs < variantMs ? "baseline" : "variant",
        `${name}: the recorded order disagrees with the visits' start times`
      );
      if (view.origin === "v2") counts.recordedV2 += 1;
      else counts.recordedV1 += 1;
      continue;
    }
    assert.ok(
      Math.max(baselineMs, variantMs) < RANDOMIZATION_COMMITTED_AT,
      `${name}: has no order record but ran after order randomization was committed`
    );
    if (order.startedFirst !== null) counts.startTimeOrder += 1;
  }

  // The committed corpus holds no temporal pair: the publisher commits
  // paired interventions only, and before/after pairs are built in the reader.
  // So the "not applicable" floor comes from that reader path, the archive's
  // before/after comparison of two committed reports of one site (the newest
  // two per site and generation, as a reader would pick them).
  for (const reports of bySite.values()) {
    if (reports.length < 2) continue;
    const result = createLoadedTemporalComparison(reports[reports.length - 2], reports[reports.length - 1]);
    if (!result.ok) continue;
    const comparison = result.loaded.view.comparison;
    assert.ok(comparison?.temporalPair, `${result.loaded.view.domain}: an archive comparison that is not temporal`);
    assert.deepEqual(comparison.visitOrder, { state: "not-applicable" }, `${result.loaded.view.domain}: archive pair`);
    assert.equal(comparisonVisitOrderLine(comparison.visitOrder, comparison.runLabels), null);
    counts.archivePairs += 1;
  }

  // Floors, never exact counts: the weekly corpus refresh adds and prunes
  // reports. Each floor keeps its state exercised by real reports.
  assert.ok(
    counts.recordedV1 > 0,
    "no committed v1 comparison reads a recorded order; check viewFromV1Report's match against comparisonOrderDisclosure"
  );
  assert.ok(counts.recordedV2 > 0, "no committed v2 comparison reads its recorded experiment order");
  assert.ok(
    counts.startTimeOrder > 0,
    "no committed comparison falls back to its start times; the pre-randomization comparisons include " +
      "correction-pinned reports that retention never removes, so check the reader before relaxing this"
  );
  assert.ok(counts.archivePairs > 0, "no archive before/after pair could be built from the committed corpus");
});
