import assert from "node:assert/strict";
import { test } from "node:test";
import { NODE_SCAN_REPORT_V2_R2_MAX_PUBLIC_BYTES } from "./scan-report-v2-r2-limits";
import { aggregateSupportingPairR2 } from "./scan-report-v2-r2-aggregate";
import { readStoredScanReport } from "./scan-report-reader";
import { buildFingerprints } from "./scan-report-v2-fingerprints";
import {
  makeGpcInterventionReportV2R2,
  makeShieldsInterventionReportV2R2,
  makeSupportingPairInterventionReportV2R2
} from "./scan-report-v2-r2-fixtures";
import type { PublicComparisonReportV2R2, ScanRunV2R2 } from "./scan-report-v2-r2";

const BUILD = "f".repeat(40);

test("two independent primary pairs aggregate into complete counterbalanced r2 evidence", () => {
  const primary = makeGpcInterventionReportV2R2();
  const primaryBefore = structuredClone(primary);
  const supporting = makeSupportingGpcPair("BA");
  const result = aggregateSupportingPairR2(primary, supporting);

  assert.equal(result.buildCommit, BUILD);
  assert.equal(result.axis, "gpc");
  assert.equal(result.primaryPairId, "pair-gpc-r2");
  assert.equal(result.supportingPairId, "pair-gpc-r2-support-live");
  assert.equal(result.counterbalanced, true);
  assert.ok(result.publicBytes <= NODE_SCAN_REPORT_V2_R2_MAX_PUBLIC_BYTES);
  assert.deepEqual(primary, primaryBefore, "aggregation never mutates its source artifact");

  assert.equal(result.report.experiment.kind, "intervention");
  if (result.report.experiment.kind !== "intervention") return;
  assert.deepEqual(result.report.experiment.evidence, {
    pairs: 2,
    counterbalanced: true,
    strength: "observed-difference"
  });
  assert.equal(result.report.experiment.supportingPairs?.length, 1);
  assert.equal(result.report.experiment.supportingPairs?.[0].pairId, "pair-gpc-r2-support-live");
  assert.equal(result.report.experiment.supportingPairs?.[0].order, "BA");
  assert.deepEqual(readStoredScanReport(result.report).ok, true);
});

test("same-order repeats stay observed-difference and disclose that they are not counterbalanced", () => {
  const result = aggregateSupportingPairR2(makeGpcInterventionReportV2R2(), makeSupportingGpcPair("AB"));
  assert.equal(result.counterbalanced, false);
  assert.equal(result.report.experiment.kind, "intervention");
  if (result.report.experiment.kind !== "intervention") return;
  assert.deepEqual(result.report.experiment.evidence, {
    pairs: 2,
    counterbalanced: false,
    strength: "observed-difference"
  });
});

test("aggregation rejects wrong axes, builds, prior supporting pairs, shares, and reused ids", () => {
  assert.throws(
    () => aggregateSupportingPairR2(makeGpcInterventionReportV2R2(), makeShieldsInterventionReportV2R2()),
    /axes do not match/
  );

  const wrongBuild = makeSupportingGpcPair("BA");
  for (const run of [wrongBuild.baseline, wrongBuild.variant]) setBuild(run, "a".repeat(40));
  assert.equal(readStoredScanReport(wrongBuild).ok, true, "wrong-build fixture stays independently validator-clean");
  assert.throws(
    () => aggregateSupportingPairR2(makeGpcInterventionReportV2R2(), wrongBuild),
    /build provenance does not match/
  );

  assert.throws(
    () => aggregateSupportingPairR2(makeGpcInterventionReportV2R2(), makeSupportingPairInterventionReportV2R2()),
    /no supportingPairs property/
  );

  const shared = makeSupportingGpcPair("BA");
  shared.share = { id: "shared", path: "/reports/shared", jsonPath: "/api/reports/shared" };
  assert.throws(
    () => aggregateSupportingPairR2(makeGpcInterventionReportV2R2(), shared),
    /without a share identity/
  );

  const reusedPair = makeSupportingGpcPair("BA");
  if (reusedPair.experiment.kind !== "intervention") throw new Error("fixture invariant");
  reusedPair.experiment.pairId = "pair-gpc-r2";
  assert.throws(
    () => aggregateSupportingPairR2(makeGpcInterventionReportV2R2(), reusedPair),
    /pairId .* is reused/
  );

  const reusedRun = makeSupportingGpcPair("BA");
  reusedRun.baseline.runId = "run-gpc-off";
  assert.throws(
    () => aggregateSupportingPairR2(makeGpcInterventionReportV2R2(), reusedRun),
    /runIds must be unique/
  );

  const unsafePairId = makeSupportingGpcPair("BA");
  if (unsafePairId.experiment.kind !== "intervention") throw new Error("fixture invariant");
  unsafePairId.experiment.pairId = "../outside";
  assert.throws(
    () => aggregateSupportingPairR2(makeGpcInterventionReportV2R2(), unsafePairId),
    /pairIds must be bounded producer-generated opaque tokens/
  );
});

test("aggregation rejects support that changes the subject or measurement environment", () => {
  const otherSubject = makeSupportingGpcPair("BA");
  for (const run of [otherSubject.baseline, otherSubject.variant]) {
    run.subject.observed.origin = "https://other.example";
  }
  assert.equal(readStoredScanReport(otherSubject).ok, true, "support pair is internally subject-consistent");
  assert.throws(
    () => aggregateSupportingPairR2(makeGpcInterventionReportV2R2(), otherSubject),
    /subject does not match the primary pair/
  );

  const otherEnvironment = makeSupportingGpcPair("BA");
  for (const run of [otherEnvironment.baseline, otherEnvironment.variant]) {
    run.conditions.device = {
      ...run.conditions.device,
      viewport: { ...run.conditions.device.viewport, width: run.conditions.device.viewport.width + 1 }
    };
    refreshFingerprints(run);
  }
  assert.equal(readStoredScanReport(otherEnvironment).ok, true, "support pair is internally environment-consistent");
  assert.throws(
    () => aggregateSupportingPairR2(makeGpcInterventionReportV2R2(), otherEnvironment),
    /condition fingerprint does not match|measurement environment does not match/
  );
});

test("aggregation enforces the 8 MiB public-wire ceiling", () => {
  const primary = makeGpcInterventionReportV2R2();
  const supporting = makeSupportingGpcPair("BA");
  primary.baseline.warnings = ["x".repeat(4_300_000)];
  supporting.baseline.warnings = ["y".repeat(4_300_000)];
  assert.equal(readStoredScanReport(primary).ok, true);
  assert.equal(readStoredScanReport(supporting).ok, true);
  assert.throws(
    () => aggregateSupportingPairR2(primary, supporting),
    /public bytes; the limit is 8388608/
  );
});

function makeSupportingGpcPair(order: "AB" | "BA"): PublicComparisonReportV2R2 {
  const report = structuredClone(makeGpcInterventionReportV2R2());
  if (report.experiment.kind !== "intervention") throw new Error("fixture invariant");
  report.experiment.pairId = "pair-gpc-r2-support-live";
  report.experiment.order = order;
  report.experiment.evidence = { pairs: 1, counterbalanced: false, strength: "observed-difference" };
  report.baseline.runId = "run-gpc-off-support-live";
  report.variant.runId = "run-gpc-on-support-live";
  if (order === "AB") {
    report.baseline.startedAt = "2026-07-09T11:00:00.000Z";
    report.variant.startedAt = "2026-07-09T11:01:00.000Z";
  } else {
    report.baseline.startedAt = "2026-07-09T11:01:00.000Z";
    report.variant.startedAt = "2026-07-09T11:00:00.000Z";
  }
  return report;
}

function setBuild(run: ScanRunV2R2, buildCommit: string): void {
  run.provenance = { ...run.provenance, buildCommit };
  refreshFingerprints(run);
}

function refreshFingerprints(run: ScanRunV2R2): void {
  run.fingerprints = buildFingerprints({
    conditions: run.conditions,
    provenance: run.provenance,
    toolchain: run.toolchain,
    detectors: run.detectors
  });
}
