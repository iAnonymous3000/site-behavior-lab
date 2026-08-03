import { readFileSync } from "node:fs";
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
  healthMatchesExpectedReportStore(value: unknown, expectedKind: string): boolean;
  shieldsEngineActive(value: unknown): boolean;
  shieldsBlockedCounts(value: unknown): { baseline: number | null; variant: number | null };
  savedReportRetainsScreenshot(value: unknown): boolean;
  ssrfGuardRefusalReason(value: unknown): string | null;
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

  const r2WithIneligibleRawCounts = structuredClone(r2);
  r2WithIneligibleRawCounts.diff.families["raw-counts"].eligible = false;
  r2WithIneligibleRawCounts.comparability.perMetric["raw-counts"].eligible = false;
  assert.equal(
    adapter.hasShieldsComparisonDiff(r2WithIneligibleRawCounts),
    false,
    "an ineligible r2 metric object is not a usable Shields diff"
  );

  const r2WithoutEgressRegion = structuredClone(r2);
  delete r2WithoutEgressRegion.baseline.conditions.egress.region;
  delete r2WithoutEgressRegion.variant.conditions.egress.region;
  assert.equal(
    adapter.hasShieldsComparisonDiff(r2WithoutEgressRegion),
    false,
    "unknown egress cannot pass a paired-diff smoke assertion"
  );

  const r2WithMismatchedEgress = structuredClone(r2);
  r2WithMismatchedEgress.variant.conditions.egress.region = "eu";
  assert.equal(adapter.hasShieldsComparisonDiff(r2WithMismatchedEgress), false);
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

  const r2ComparisonWithScreenshot = structuredClone(r2);
  Object.assign(r2ComparisonWithScreenshot.variant, { screenshot: "data:image/png;base64,PRIVATE" });
  assert.equal(
    adapter.savedReportRetainsScreenshot(r2ComparisonWithScreenshot),
    true,
    "a persisted r2 comparison arm may not retain a screenshot"
  );
});

test("deployed smoke helpers prove the configured store instead of trusting capabilities", async () => {
  const adapter = await helpers;
  const r2 = { storage: "r2", checks: { reportStore: { kind: "r2", configuredPath: true } } };
  assert.equal(adapter.healthMatchesExpectedReportStore(r2, "r2"), true);
  assert.equal(adapter.healthMatchesExpectedReportStore({ ...r2, storage: "filesystem" }, "r2"), false);
  assert.equal(
    adapter.healthMatchesExpectedReportStore({ storage: "r2", checks: { reportStore: { kind: "r2" } } }, "r2"),
    false
  );
  assert.equal(
    adapter.healthMatchesExpectedReportStore(
      { storage: "filesystem", checks: { reportStore: { kind: "filesystem", configuredPath: true } } },
      "filesystem"
    ),
    true
  );
});

test("deployed smoke helpers accept only a concrete failed URL-safety job", async () => {
  const adapter = await helpers;
  assert.equal(
    adapter.ssrfGuardRefusalReason({ status: "failed", error: "Target resolves to a private network address." }),
    "Target resolves to a private network address."
  );
  assert.equal(adapter.ssrfGuardRefusalReason({ status: "failed", error: "Browser crashed" }), null);
  assert.equal(adapter.ssrfGuardRefusalReason({ status: "expired", error: "Lost after restart" }), null);
  assert.equal(adapter.ssrfGuardRefusalReason({ status: "cancelled", error: "Cancelled" }), null);
});

test("every external-target leg of the deployed smoke falls through to an ordered candidate list", () => {
  // The Shields leg gained ordered candidates when a single third party's
  // outage was found to block promotion, but the single-scan leg kept one
  // hardcoded target and failed the gate on an example.com net::ERR_FAILED.
  // Nothing pinned the rule, so the two legs could drift apart again. A leg
  // that scans a fixed external URL without tolerateScanFailure is the defect.
  const source = readFileSync(path.join(process.cwd(), "scripts", "smoke-deployed-scanner.mjs"), "utf8");

  for (const [leg, candidates] of [
    ["checkSingleScan", "singleScanUrlCandidates"],
    ["checkShieldsComparison", "shieldsUrlCandidates"]
  ]) {
    const start = source.indexOf(`async function ${leg}(`);
    assert.notEqual(start, -1, `${leg} must exist`);
    const body = source.slice(start, source.indexOf("\nasync function ", start + 1));
    assert.match(body, new RegExp(`for \\(const \\w+ of ${candidates}\\)`), `${leg} iterates its candidate list`);
    assert.match(body, /tolerateScanFailure: true/, `${leg} tolerates a target-attributable failure`);
    assert.match(body, /failed on every candidate target/, `${leg} stays red when every candidate fails`);
    // A literal https:// target inside the leg means it is scanning something
    // that is not drawn from the candidate list.
    assert.doesNotMatch(body, /url: "https:\/\//, `${leg} takes its target from the candidate list`);
  }

  // Each list must offer independent operators, or the fallthrough is theatre.
  for (const list of ["singleScanUrlCandidates", "shieldsUrlCandidates"]) {
    const defaults = new RegExp(`${list} = \\(?\\s*process\\.env\\.\\w+ \\|\\| "([^"]+)"`).exec(source);
    assert.notEqual(defaults, null, `${list} declares default candidates`);
    const hosts = defaults![1].trim().split(/\s+/).map((url) => new URL(url).hostname);
    assert.equal(hosts.length >= 2, true, `${list} offers a fallback`);
    assert.equal(new Set(hosts).size, hosts.length, `${list} candidates are distinct hosts`);
  }
});
