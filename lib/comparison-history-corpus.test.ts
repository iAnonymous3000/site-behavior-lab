import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { legacyComparisonDecision } from "./comparison-decision";
import { createTemporalComparisonReport, orderTemporalPair } from "./compare-reports";
import { isReservedReportDomain } from "./reserved-report-domains";
import { redactScanReportV1 } from "./redact-scan-report-v1";
import { readStoredScanReport } from "./scan-report-reader";
import { displayRunView, toReportView } from "./scan-report-view";
import { comparisonHistoryPairingKey } from "./temporal-deltas";
import {
  comparisonHistoryCohortForStoredReport,
  consentClicksForView
} from "./temporal-report-identity";
import type { ComparisonType, ScanReport, ScanResult } from "./types";

const reportsDir = path.join(process.cwd(), "public", "reports");
const reportFilePattern = /^[0-9]{8}-[0-9a-f]{32}\.json$/;

type CorpusVisit = {
  domain: string;
  kind: string;
  device: "desktop" | "mobile";
  scannedAt: string;
  run: ScanResult;
  comparisonHistoryKey: string | null;
};

test("the committed corpus exposes exactly the reviewed 59 safe passive history pairs", () => {
  let files: string[];
  try {
    files = readdirSync(reportsDir).filter((name) => reportFilePattern.test(name));
  } catch {
    return;
  }
  if (files.length === 0) return;

  const visits: CorpusVisit[] = [];
  for (const name of files) {
    const persisted = JSON.parse(readFileSync(path.join(reportsDir, name), "utf8")) as ScanReport;
    // Exercise the current public-redaction policy even while a corpus
    // remediation is pending. Once remediated this is idempotent; before then
    // it prevents a newly generalized route/host marker from silently erasing
    // an otherwise reviewed history pair at publication time.
    const raw = persisted.schemaVersion === 1 ? redactScanReportV1(persisted).report : persisted;
    const read = readStoredScanReport(raw);
    assert.equal(read.ok, true, `reader rejected committed report ${name}`);
    if (!read.ok || read.stored.schemaVersion !== 1) continue;

    const stored = read.stored;
    const view = toReportView(stored);
    const lead = displayRunView(view);
    if (isReservedReportDomain(lead.domain)) continue;
    const comparisonType: ComparisonType | undefined =
      view.reportType === "comparison"
        ? view.comparison?.axis ?? (view.comparison?.temporalPair ? "temporal" : "custom")
        : undefined;
    const comparisonHistoryKey = comparisonHistoryPairingKey({
      domain: lead.domain,
      reportType: view.reportType,
      comparisonType,
      consentClicks: consentClicksForView(view),
      requestedUrl: lead.conditions.requestedUrl,
      finalUrl: lead.conditions.finalUrl,
      comparisonHistoryCohort: comparisonHistoryCohortForStoredReport(stored, view)
    });
    const report = stored.report;
    const run =
      report.reportType === "comparison"
        ? report.comparisonType === "temporal"
          ? report.variant
          : report.baseline
        : report;
    visits.push({
      domain: lead.domain,
      kind: `${view.reportType}:${comparisonType ?? ""}`,
      device: lead.conditions.viewport.isMobile ? "mobile" : "desktop",
      scannedAt: view.scannedAt ?? "",
      run,
      comparisonHistoryKey
    });
  }

  const byHistoryKey = groupBy(visits.filter((visit) => visit.comparisonHistoryKey), (visit) => visit.comparisonHistoryKey!);
  const historyPairs = [...byHistoryKey.values()].filter((group) => group.length >= 2);
  assert.equal(historyPairs.length, 59);
  assert.equal(historyPairs.reduce((sum, group) => sum + group.length, 0), 118);
  assert.equal(historyPairs.every((group) => group.length === 2), true);

  // The archive's broad site/kind/device candidate set has 66 pairs. The
  // loaded preflight admits the same 59 and rejects only the seven reviewed
  // failed/capped/subject-mismatch cohorts.
  const broad = groupBy(visits, (visit) => `${visit.domain}|${visit.kind}|${visit.device}`);
  const candidates = [...broad.values()].filter((group) => group.length >= 2);
  assert.equal(candidates.length, 66);
  const rejected = new Set<string>();
  let accepted = 0;
  for (const group of candidates) {
    group.sort((left, right) => Date.parse(right.scannedAt) - Date.parse(left.scannedAt));
    const ordered = orderTemporalPair(group[0].run, group[1].run);
    assert.ok(ordered, `could not order ${group[0].domain}`);
    const decision = legacyComparisonDecision(createTemporalComparisonReport(ordered[0], ordered[1]));
    const usable =
      decision.mode === "comparable" &&
      (decision.families["raw-counts"].mode === "comparable" ||
        decision.families["tracker-classification"].mode === "comparable");
    if (usable) accepted += 1;
    else rejected.add(group[0].domain);
  }
  assert.equal(accepted, 59);
  assert.deepEqual(
    [...rejected].sort(),
    ["my.gov.au", "www.etsy.com", "www.goodrx.com", "www.reuters.com", "www.usatoday.com", "www.wayfair.com", "www.zocdoc.com"]
  );
});

function groupBy<T>(items: T[], keyFor: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFor(item);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  return groups;
}
