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

test("every dimension the r2 history identity claims to bind actually changes the key", () => {
  // REGRESSION. Nothing pinned the composition: replacing `provenance.observer`
  // and `toolchain.normalizationVersion` with a constant left the key unchanged
  // and every suite that touches it still passed. Those are exactly the axes the
  // identity-widening ledger governs, so a silent drop there is a retirement
  // nobody records.
  const base = makePublicSingleReportV2R2();
  const baseline = historyCohort(base);
  assert.ok(baseline, "the fixture must be history-eligible or this guard proves nothing");

  // Each mutation touches ONE recorded dimension the identity claims to bind.
  const bound: Array<[string, (report: ReturnType<typeof makePublicSingleReportV2R2>) => void]> = [
    ["browser.name", (r) => { r.run.conditions.browser.name = "other-browser"; }],
    ["browser.version", (r) => { r.run.conditions.browser.version = "999.0"; }],
    ["locale", (r) => { r.run.conditions.locale = "fr-FR"; }],
    ["language", (r) => { r.run.conditions.language = "fr"; }],
    ["timezone", (r) => { r.run.conditions.timezone = "Europe/Paris"; }],
    ["egress.label", (r) => { r.run.conditions.egress.label = "docker-smoke"; }],
    ["egress.region", (r) => { r.run.conditions.egress.region = "elsewhere"; }],
    ["automation", (r) => { r.run.conditions.automation = "external"; }],
    ["methodologyVersion", (r) => { r.run.provenance.methodologyVersion = "other-methodology"; }],
    ["observer", (r) => { r.run.provenance.observer = "browser-run-worker"; }],
    ["normalizationVersion", (r) => { r.run.toolchain.normalizationVersion = "other-normalization"; }],
    ["trackerCatalog.digest", (r) => { r.run.toolchain.trackerCatalog.digest = "f".repeat(64); }]
  ];

  for (const [label, mutate] of bound) {
    const mutated = structuredClone(base);
    mutate(mutated);
    rebuildFingerprints(mutated);
    assert.notEqual(
      historyCohort(mutated),
      baseline,
      `${label} is named by the identity but does not change the key`
    );
  }

  // The converse, and it is deliberate: the ad-block identity is NOT bound.
  // The tracker-classification evaluator never reads it, so Brave-list source,
  // count and snapshot may drift within one cohort. The site-history page must
  // therefore not promise they are held constant.
  const listMoved = structuredClone(base);
  listMoved.run.toolchain.adblock = {
    ...(listMoved.run.toolchain.adblock ?? {}),
    source: "Brave default ad-block lists",
    lists: 68,
    manifestDigest: "a".repeat(64)
  } as typeof listMoved.run.toolchain.adblock;
  rebuildFingerprints(listMoved);
  assert.equal(
    historyCohort(listMoved),
    baseline,
    "the ad-block identity is deliberately outside this cohort; see the docblock"
  );
});
