import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { createShieldsComparisonReport } from "./compare-reports";
import { makeShieldsInterventionReportV2R2 } from "./scan-report-v2-r2-fixtures";
import { makeScanReportV1 } from "./scan-report-v2-fixtures";

type SmokeReportHelpers = {
  isSupportedDeployedReport(value: unknown): boolean;
  singleReportTotalRequests(value: unknown): number | null;
  isShieldsComparisonReport(value: unknown): boolean;
  hasShieldsComparisonDiff(value: unknown): boolean;
  shieldsEngineActive(value: unknown): boolean;
  shieldsBlockedCounts(value: unknown): { baseline: number | null; variant: number | null };
  savedReportRetainsScreenshot(value: unknown): boolean;
};

// Preserve native import() after CommonJS test compilation so this exercises
// the exact .mjs helper loaded by the deployed smoke script.
const nativeImport = new Function("specifier", "return import(specifier)") as (
  specifier: string
) => Promise<SmokeReportHelpers>;
const helpers = nativeImport(
  pathToFileURL(path.join(process.cwd(), "scripts", "smoke-deployed-scanner-report.mjs")).href
);

test("deployed smoke helpers recognize v1 and r2 singles without root-ok assumptions", async () => {
  const adapter = await helpers;
  const v1 = makeScanReportV1();
  const r2 = makeShieldsInterventionReportV2R2().baseline;
  const r2Single = {
    schemaVersion: 2,
    schemaRevision: 2,
    reportType: "single",
    run: r2
  };

  assert.equal(adapter.isSupportedDeployedReport(v1), true);
  assert.equal(adapter.singleReportTotalRequests(v1), v1.reportType === "single" ? v1.summary.totalRequests : null);
  assert.equal(adapter.isSupportedDeployedReport(r2Single), true);
  assert.equal(adapter.singleReportTotalRequests(r2Single), r2.summary.counts.totalRequests);
  assert.equal("ok" in r2Single, false);
  assert.equal(adapter.isSupportedDeployedReport({ ...r2Single, schemaRevision: 1 }), false);
  assert.equal(adapter.isSupportedDeployedReport({ ok: false, error: "scan failed" }), false);
});

test("deployed smoke helpers read Shields diff, engine, and counts from both wires", async () => {
  const adapter = await helpers;
  const baseline = makeScanReportV1();
  const variant = makeScanReportV1();
  if (baseline.reportType !== "single" || variant.reportType !== "single") throw new Error("fixture invariant");
  baseline.conditions.adblock = {
    active: true,
    source: "Brave default lists",
    lists: 1,
    fetchedAt: "2026-07-09T10:00:00.000Z"
  };
  variant.conditions.adblock = { ...baseline.conditions.adblock };
  baseline.conditions.shieldsMode = "classification";
  variant.conditions.shieldsMode = "block-simulation";
  baseline.summary.shieldsBlockedRequests = 3;
  variant.summary.shieldsBlockedRequests = 2;
  const v1 = createShieldsComparisonReport(baseline, variant);
  const r2 = makeShieldsInterventionReportV2R2();

  for (const report of [v1, r2]) {
    assert.equal(adapter.isSupportedDeployedReport(report), true);
    assert.equal(adapter.isShieldsComparisonReport(report), true);
    assert.equal(adapter.hasShieldsComparisonDiff(report), true);
    assert.equal(adapter.shieldsEngineActive(report), true);
  }
  assert.deepEqual(adapter.shieldsBlockedCounts(v1), { baseline: 3, variant: 2 });
  assert.deepEqual(adapter.shieldsBlockedCounts(r2), { baseline: 0, variant: 0 });

  const v1WithoutSimulation = structuredClone(v1);
  v1WithoutSimulation.variant.conditions.shieldsMode = "classification";
  assert.equal(
    adapter.shieldsEngineActive(v1WithoutSimulation),
    false,
    "v1 must prove the variant used block-simulation mode"
  );

  const r2WithoutAppliedSimulation = structuredClone(r2);
  if (!r2WithoutAppliedSimulation.variant.verificationFacts?.shields) {
    throw new Error("fixture invariant");
  }
  if (r2WithoutAppliedSimulation.experiment.kind !== "intervention") {
    throw new Error("fixture invariant");
  }
  r2WithoutAppliedSimulation.variant.verificationFacts.shields.applied = false;
  r2WithoutAppliedSimulation.experiment.verification.variant.outcome = "failed";
  assert.equal(
    adapter.shieldsEngineActive(r2WithoutAppliedSimulation),
    false,
    "an engine-loaded r2 arm is not enough when blocking was not applied"
  );

  const r2WithFailedArm = structuredClone(r2);
  if (r2WithFailedArm.experiment.kind !== "intervention") {
    throw new Error("fixture invariant");
  }
  r2WithFailedArm.experiment.verification.variant.outcome = "failed";
  assert.equal(
    adapter.shieldsEngineActive(r2WithFailedArm),
    false,
    "the r2 verification arm must report that the intervention passed"
  );
});

test("deployed smoke helpers reject persisted screenshot material for each generation", async () => {
  const adapter = await helpers;
  const v1 = makeScanReportV1();
  if (v1.reportType !== "single") throw new Error("fixture invariant");
  assert.equal(adapter.savedReportRetainsScreenshot(v1), false, "explicit v1 null is safe");
  assert.equal(
    adapter.savedReportRetainsScreenshot({ ...v1, screenshot: "data:image/png;base64,PRIVATE" }),
    true
  );

  const r2 = makeShieldsInterventionReportV2R2();
  assert.equal(adapter.savedReportRetainsScreenshot(r2), false);
  assert.equal(
    adapter.savedReportRetainsScreenshot({
      ...r2,
      ephemeral: { baselineScreenshot: null, variantScreenshot: null }
    }),
    true,
    "the r2 ephemeral shell itself is never persistable"
  );
});
