import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { legacyComparisonDecision } from "./comparison-decision";
import { createTemporalComparisonReport, orderTemporalPair } from "./compare-reports";
import { isReservedReportDomain } from "./reserved-report-domains";
import { redactScanReportV1 } from "./redact-scan-report-v1";
import { safeNavigableHttpUrl } from "./report-url";
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
  id: string;
  domain: string;
  kind: string;
  device: "desktop" | "mobile";
  scannedAt: string;
  requestedUrl: string;
  run: ScanResult;
  comparisonHistoryKey: string | null;
};

test("independent passive-history eligibility requires an exact requested URL", () => {
  assert.equal(independentHistorySubjectEligible({ requestedUrl: "https://example.com/research" }), true);
  assert.equal(independentHistorySubjectEligible({ requestedUrl: "https://{label}.example.com/" }), false);
  assert.equal(independentHistorySubjectEligible({ requestedUrl: "https://example.com/{seg}" }), false);
});

test("every committed passive-history cohort exposes a safe loaded pair", () => {
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
      id: name,
      domain: lead.domain,
      kind: `${view.reportType}:${comparisonType ?? ""}`,
      device: lead.conditions.viewport.isMobile ? "mobile" : "desktop",
      scannedAt: view.scannedAt ?? "",
      requestedUrl: lead.conditions.requestedUrl,
      run,
      comparisonHistoryKey
    });
  }

  // Build the expected set without consulting the production history key.
  // The corpus scan workflow revisits each site/kind/device candidate under a
  // fixed setup, while the loaded comparison decision independently rejects
  // failed, capped, or otherwise incompatible pairs. Comparing exact member
  // IDs (not just a non-zero count) means a regression that nulls or splits
  // nearly every production cohort cannot leave this test green.
  // Privacy-generalized requested URLs do not prove that two visits observed
  // the same exact route. Keep that public-subject safety boundary independent
  // from the production history key, then continue deriving compatibility
  // without consulting the key itself.
  const candidates = groupBy(visits.filter(independentHistorySubjectEligible), independentCandidateKey);
  const expectedEligibleCohorts: string[][] = [];
  for (const group of candidates.values()) {
    for (const cohort of independentCompatibilityCohorts(group)) {
      if (cohort.length < 2) continue;
      const newest = newestFirst(cohort);
      expectedEligibleCohorts.push([newest[0].id, newest[1].id]);
    }
  }
  assert.ok(
    expectedEligibleCohorts.length > 0,
    "the committed corpus should expose at least one independently eligible passive-history cohort"
  );

  const byHistoryKey = groupBy(visits.filter((visit) => visit.comparisonHistoryKey), (visit) => visit.comparisonHistoryKey!);
  const historyCohorts = [...byHistoryKey.values()].filter((group) => group.length >= 2);
  const actualEligibleCohorts: string[][] = [];

  // Corpus refreshes legitimately add or prune generations, so cardinality is
  // data rather than a source-code invariant. Methodology or condition changes
  // may also create multiple legitimate cohorts for one site/kind/device, so
  // derive those components independently from pair compatibility instead of
  // assuming the broad candidate has exactly one production key.
  for (const group of historyCohorts) {
    const candidateKeys = new Set(group.map(independentCandidateKey));
    assert.equal(candidateKeys.size, 1, "one production history key merged independent corpus candidates");

    // A refresh can legitimately add a third (or later) generation. Check
    // every member pair, not only the newest two: otherwise a key regression
    // could merge an older incompatible visit while today's displayed pair
    // remained safe and leave this corpus gate green.
    for (let left = 0; left < group.length; left += 1) {
      for (let right = left + 1; right < group.length; right += 1) {
        assert.equal(
          loadedPairIsUsable(group[left], group[right]),
          true,
          `${[...candidateKeys][0]} history key merged incompatible reports ${group[left].id} and ${group[right].id}`
        );
      }
    }

    const newest = newestFirst(group);
    actualEligibleCohorts.push([newest[0].id, newest[1].id]);
  }

  assert.deepEqual(
    sortedCohorts(actualEligibleCohorts),
    sortedCohorts(expectedEligibleCohorts),
    "production history keys must retain every independently eligible candidate and its newest pair"
  );
});

function independentCandidateKey(visit: CorpusVisit): string {
  return `${visit.domain.toLowerCase()}|${visit.kind}|${visit.device}`;
}

function independentHistorySubjectEligible(visit: Pick<CorpusVisit, "requestedUrl">): boolean {
  return safeNavigableHttpUrl(visit.requestedUrl) !== null;
}

function newestFirst(visits: CorpusVisit[]): CorpusVisit[] {
  return [...visits].sort(
    (left, right) => Date.parse(right.scannedAt) - Date.parse(left.scannedAt) || left.id.localeCompare(right.id)
  );
}

function loadedPairIsUsable(left: CorpusVisit, right: CorpusVisit): boolean {
  const ordered = orderTemporalPair(left.run, right.run);
  assert.ok(ordered, `could not order ${left.domain}`);
  const decision = legacyComparisonDecision(createTemporalComparisonReport(ordered[0], ordered[1]));
  return (
    decision.mode === "comparable" &&
    (decision.families["raw-counts"].mode === "comparable" ||
      decision.families["tracker-classification"].mode === "comparable")
  );
}

/**
 * Connected components under the same loaded comparison decision used by the
 * UI, without consulting `comparisonHistoryKey`. A future methodology change
 * can therefore create a second legitimate cohort for one broad site key
 * without making this regression test a permanent deploy blocker.
 */
function independentCompatibilityCohorts(visits: CorpusVisit[]): CorpusVisit[][] {
  const parents = visits.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parents[root] !== root) root = parents[root];
    while (parents[index] !== index) {
      const parent = parents[index];
      parents[index] = root;
      index = parent;
    }
    return root;
  };
  const union = (left: number, right: number): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parents[rightRoot] = leftRoot;
  };

  for (let left = 0; left < visits.length; left += 1) {
    for (let right = left + 1; right < visits.length; right += 1) {
      if (loadedPairIsUsable(visits[left], visits[right])) union(left, right);
    }
  }

  const groups = new Map<number, CorpusVisit[]>();
  for (let index = 0; index < visits.length; index += 1) {
    const root = find(index);
    const group = groups.get(root);
    if (group) group.push(visits[index]);
    else groups.set(root, [visits[index]]);
  }
  return [...groups.values()];
}

function sortedCohorts(cohorts: string[][]): string[][] {
  return cohorts
    .map((members) => [...members].sort())
    .sort((left, right) => left.join("|").localeCompare(right.join("|")));
}

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
