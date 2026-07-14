import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { createGpcComparisonReport } from "./compare-reports";
import { makeSupportingPairInterventionReportV2R2 } from "./scan-report-v2-r2-fixtures";
import { makePublicSingleReportV2, makeScanReportV1 } from "./scan-report-v2-fixtures";

type RunCiReportHelpers = {
  isPublishableScanReport(value: unknown): boolean;
  botBlockReason(value: unknown): string | null;
};

// Preserve native import() after this test is compiled to CommonJS; TypeScript
// would otherwise lower a direct dynamic import to require(), which cannot load
// the source .mjs helper exercised by the actual CI script.
const nativeImport = new Function("specifier", "return import(specifier)") as (
  specifier: string
) => Promise<RunCiReportHelpers>;
const helpers = nativeImport(
  pathToFileURL(path.join(process.cwd(), "scripts", "run-ci-scan-report.mjs")).href
);

test("the CI report gate recognizes frozen v1 and current r2 without relying on root ok", async () => {
  const { isPublishableScanReport } = await helpers;
  const r2 = makeSupportingPairInterventionReportV2R2();

  assert.equal(isPublishableScanReport(makeScanReportV1()), true);
  assert.equal(isPublishableScanReport(r2), true);
  assert.equal(isPublishableScanReport({ ...r2, ephemeral: { baselineScreenshot: null, variantScreenshot: null } }), true);
  assert.equal(isPublishableScanReport(makePublicSingleReportV2()), false, "v2/r1 stays read-only");
  assert.equal(isPublishableScanReport({ ok: false, error: "failed" }), false);
});

test("the CI bot-wall gate checks every primary and r2 supporting-pair arm", async () => {
  const { botBlockReason } = await helpers;
  const healthy = makeHealthySupportingComparison();
  assert.equal(botBlockReason(healthy), null);

  const cases: Array<{
    name: string;
    mutate: (arms: ReturnType<typeof supportingArms>) => void;
    expected: RegExp;
  }> = [
    {
      name: "primary baseline title",
      mutate: ({ primaryBaseline }) => {
        primaryBaseline.summary.pageTitle = "Attention Required";
      },
      expected: /^primary baseline arm: landing page title matches/
    },
    {
      name: "primary variant request floor",
      mutate: ({ primaryVariant }) => {
        primaryVariant.summary.counts.totalRequests = 1;
      },
      expected: /^primary variant arm: only 1 network request\(s\) observed/
    },
    {
      name: "supporting baseline request floor",
      mutate: ({ supportingBaseline }) => {
        supportingBaseline.summary.counts.totalRequests = 0;
      },
      expected: /^supporting pair 1 baseline arm: only 0 network request\(s\) observed/
    },
    {
      name: "supporting variant title",
      mutate: ({ supportingVariant }) => {
        supportingVariant.summary.pageTitle = "Checking your browser";
      },
      expected: /^supporting pair 1 variant arm: landing page title matches/
    }
  ];

  for (const fixture of cases) {
    const report = structuredClone(healthy);
    fixture.mutate(supportingArms(report));
    const reason = botBlockReason(report);
    assert.match(reason ?? "", fixture.expected, fixture.name);
    assert.equal(reason?.includes("Attention Required"), false, `${fixture.name}: raw title must not enter logs`);
    assert.equal(reason?.includes("Checking your browser"), false, `${fixture.name}: raw title must not enter logs`);
  }
});

test("the CI bot-wall gate checks the variant of a legacy comparison too", async () => {
  const { botBlockReason } = await helpers;
  const baseline = makeScanReportV1();
  if (baseline.reportType === "comparison") throw new Error("expected single fixture");
  const variant = structuredClone(baseline);
  baseline.summary.totalRequests = 5;
  variant.summary.totalRequests = 1;
  variant.conditions.gpcEnabled = true;
  const report = createGpcComparisonReport(baseline, variant);

  assert.match(botBlockReason(report) ?? "", /^primary variant arm: only 1 network request\(s\) observed/);
});

function makeHealthySupportingComparison() {
  const report = makeSupportingPairInterventionReportV2R2();
  for (const run of Object.values(supportingArms(report))) {
    run.summary.pageTitle = "Example Shop";
    run.summary.counts.totalRequests = 5;
  }
  return report;
}

function supportingArms(report: ReturnType<typeof makeSupportingPairInterventionReportV2R2>) {
  if (report.experiment.kind !== "intervention") throw new Error("expected intervention fixture");
  const supporting = report.experiment.supportingPairs?.[0];
  if (!supporting) throw new Error("expected supporting-pair fixture");
  return {
    primaryBaseline: report.baseline,
    primaryVariant: report.variant,
    supportingBaseline: supporting.baseline,
    supportingVariant: supporting.variant
  };
}
