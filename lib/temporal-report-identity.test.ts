import assert from "node:assert/strict";
import { test } from "node:test";
import { buildFingerprints } from "./scan-report-v2-fingerprints";
import { evaluateQuality } from "./scan-report-v2-evaluators";
import {
  METRIC_CONTRACT_DIGEST,
  METRIC_CONTRACT_VERSION
} from "./metric-contract";
import { makePublicSingleReportV2R2 } from "./scan-report-v2-r2-fixtures";
import type { StoredScanReport } from "./scan-report-reader";
import { toReportView } from "./scan-report-views";
import { comparisonHistoryPairingKey } from "./temporal-deltas";
import {
  comparisonHistoryCohortForStoredReport,
  temporalCohortForStoredReport
} from "./temporal-report-identity";

function storedR2(report: ReturnType<typeof makePublicSingleReportV2R2>): Extract<StoredScanReport, { schemaVersion: 2; schemaRevision: 2 }> {
  return { schemaVersion: 2, schemaRevision: 2, report };
}

function rebuildFingerprints(report: ReturnType<typeof makePublicSingleReportV2R2>): void {
  report.run.fingerprints = buildFingerprints({
    conditions: report.run.conditions,
    provenance: report.run.provenance,
    toolchain: report.run.toolchain,
    detectors: report.run.detectors
  });
}

function historyCohort(report: ReturnType<typeof makePublicSingleReportV2R2>): string | null {
  const stored = storedR2(report);
  return comparisonHistoryCohortForStoredReport(stored, toReportView(stored));
}

test("r2 comparison history uses a tracker-family methodology identity", () => {
  const before = makePublicSingleReportV2R2();
  const after = structuredClone(before);
  after.run.runId = "later-run";
  after.run.startedAt = "2026-07-10T11:00:00.000Z";
  after.run.provenance.buildCommit = "e".repeat(40);
  rebuildFingerprints(after);

  const beforeCohort = historyCohort(before);
  const afterCohort = historyCohort(after);
  assert.match(beforeCohort ?? "", /^v2-r2-comparison-history:tracker-classification:/);
  assert.match(
    beforeCohort ?? "",
    new RegExp(`:metrics-${METRIC_CONTRACT_VERSION}-${METRIC_CONTRACT_DIGEST}$`)
  );
  assert.equal(afterCohort, beforeCohort, "build provenance alone does not change tracker-family semantics");

  const key = comparisonHistoryPairingKey({
    domain: "example.com",
    reportType: "single",
    requestedUrl: before.run.subject.requested.origin + before.run.subject.requested.routeShape,
    finalUrl: before.run.subject.observed.origin + before.run.subject.observed.routeShape,
    comparisonHistoryCohort: beforeCohort
  });
  assert.match(key ?? "", /^comparison-history-key-v2\|/);
});

test("strict temporal history also binds the read-time metric contract", () => {
  const report = makePublicSingleReportV2R2();
  const stored = storedR2(report);
  const cohort = temporalCohortForStoredReport(stored, toReportView(stored));

  assert.match(cohort ?? "", /^v2-r2:/);
  assert.match(
    cohort ?? "",
    new RegExp(`:metrics-${METRIC_CONTRACT_VERSION}-${METRIC_CONTRACT_DIGEST}$`)
  );
});

test("r2 history splits methodology and tracker-catalog cohorts", () => {
  const baseline = makePublicSingleReportV2R2();
  const baselineCohort = historyCohort(baseline);

  const methodology = structuredClone(baseline);
  methodology.run.provenance.methodologyVersion = "3.0";
  rebuildFingerprints(methodology);
  assert.notEqual(historyCohort(methodology), baselineCohort);

  const catalog = structuredClone(baseline);
  catalog.run.toolchain.trackerCatalog.digest = "c".repeat(64);
  rebuildFingerprints(catalog);
  assert.notEqual(historyCohort(catalog), baselineCohort);
});

test("r2 history excludes unknown environment dimensions and request-censored visits", () => {
  const unknownRegion = makePublicSingleReportV2R2();
  unknownRegion.run.conditions.egress.region = "unknown";
  rebuildFingerprints(unknownRegion);
  assert.equal(historyCohort(unknownRegion), null);

  const censored = makePublicSingleReportV2R2();
  censored.run.qualityFacts.captureLoss.push({
    family: "requests",
    phaseId: 0,
    kind: "timeout",
    count: 1,
    detail: "network-observer"
  });
  censored.run.quality = evaluateQuality(censored.run.qualityFacts, {
    observedRequests: censored.run.evidence.requests.length
  });
  assert.equal(historyCohort(censored), null);
});
