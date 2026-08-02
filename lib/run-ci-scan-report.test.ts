import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import {
  PAGE_SUBJECT_UNVERIFIED_WARNING,
  SUSPECTED_CHALLENGE_OR_SOFT_BLOCK_WARNING
} from "./bot-wall-classifier";
import { createGpcComparisonReport } from "./compare-reports";
import { makeSupportingPairInterventionReportV2R2 } from "./scan-report-v2-r2-fixtures";
import { makePublicSingleReportV2, makeScanReportV1 } from "./scan-report-v2-fixtures";

type RunCiReportHelpers = {
  isPublishableScanReport(value: unknown): boolean;
  botBlockReason(value: unknown): string | null;
  botBlockUnavailableReason(value: unknown): string | null;
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
        primaryBaseline.qualityFacts.navigationSettled = false;
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
        supportingVariant.qualityFacts.navigationSettled = false;
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

test("the CI report gate rejects HTTP error pages even with an unrecognized title and several requests", async () => {
  const { botBlockReason } = await helpers;

  const legacyHealthy = makeScanReportV1();
  if (legacyHealthy.reportType === "comparison") throw new Error("expected single fixture");
  legacyHealthy.summary.pageTitle = "Example Shop";
  legacyHealthy.summary.status = 200;
  legacyHealthy.summary.totalRequests = 5;
  assert.equal(botBlockReason(legacyHealthy), null, "a healthy v1 run remains publishable");

  const legacySoftBlock = structuredClone(legacyHealthy);
  legacySoftBlock.warnings.push(SUSPECTED_CHALLENGE_OR_SOFT_BLOCK_WARNING);
  assert.match(
    botBlockReason(legacySoftBlock) ?? "",
    /^single run: report recorded a suspected challenge or soft block$/
  );

  const legacyUnverifiedSubject = structuredClone(legacyHealthy);
  legacyUnverifiedSubject.warnings.push(PAGE_SUBJECT_UNVERIFIED_WARNING);
  assert.match(
    botBlockReason(legacyUnverifiedSubject) ?? "",
    /^single run: report could not verify the rendered page subject$/
  );

  const legacyForbidden = structuredClone(legacyHealthy);
  legacyForbidden.summary.pageTitle = "Forbidden";
  legacyForbidden.summary.status = 403;
  assert.match(botBlockReason(legacyForbidden) ?? "", /^single run: main navigation returned HTTP 403$/);

  const r2Healthy = makeHealthySupportingComparison();
  assert.equal(botBlockReason(r2Healthy), null, "a healthy r2 report remains publishable");

  const r2Forbidden = structuredClone(r2Healthy);
  const forbiddenArm = supportingArms(r2Forbidden).supportingVariant;
  forbiddenArm.summary.pageTitle = "Forbidden";
  forbiddenArm.summary.status = 403;
  forbiddenArm.qualityFacts.status = 403;
  forbiddenArm.quality.run = { outcome: "failed", reasons: ["http-error-status"] };
  assert.match(
    botBlockReason(r2Forbidden) ?? "",
    /^supporting pair 1 variant arm: main navigation returned HTTP 403$/
  );
});

test("the CI report gate rejects recorded navigation and quality failures", async () => {
  const { botBlockReason } = await helpers;

  const noResponse = makeScanReportV1();
  if (noResponse.reportType === "comparison") throw new Error("expected single fixture");
  noResponse.summary.status = null;
  noResponse.summary.totalRequests = 5;
  assert.match(botBlockReason(noResponse) ?? "", /^single run: main navigation produced no HTTP response$/);

  const navigationFailure = makeHealthySupportingComparison();
  supportingArms(navigationFailure).primaryBaseline.qualityFacts.navigationSettled = false;
  assert.match(botBlockReason(navigationFailure) ?? "", /^primary baseline arm: main navigation did not settle$/);

  const qualityFailure = makeHealthySupportingComparison();
  supportingArms(qualityFailure).primaryVariant.quality.run = {
    outcome: "failed",
    reasons: ["scan-slot-timeout"]
  };
  assert.match(
    botBlockReason(qualityFailure) ?? "",
    /^primary variant arm: report quality evaluator marked the run failed$/
  );
});

test("the CI bot-wall gate does not treat generic title prose as a failed visit", async () => {
  const { botBlockReason } = await helpers;
  const report = makeHealthySupportingComparison();
  const { primaryBaseline, primaryVariant } = supportingArms(report);

  primaryBaseline.summary.pageTitle = "Account security check results";
  primaryBaseline.summary.counts.totalRequests = 20;
  primaryVariant.summary.pageTitle = "How to enable JavaScript in your browser";
  primaryVariant.summary.counts.totalRequests = 20;

  assert.equal(botBlockReason(report), null);

  primaryBaseline.summary.pageTitle = "Security check";
  assert.equal(botBlockReason(report), null, "an otherwise dense, healthy visit needs more than title testimony");

  primaryBaseline.summary.counts.totalRequests = 2;
  primaryVariant.summary.counts.totalRequests = 2;
  primaryVariant.summary.pageTitle = "Enable JavaScript";
  assert.equal(botBlockReason(report), null, "generic exact titles and sparse pages are both site-controlled");
});

test("the re-adjudication classifier derives only closed reasons from structured report facts", async () => {
  const { botBlockUnavailableReason } = await helpers;
  const challenge = makeHealthySupportingComparison();
  supportingArms(challenge).primaryBaseline.summary.pageTitle =
    "Attention Required";
  supportingArms(challenge).primaryBaseline.qualityFacts.navigationSettled =
    false;
  assert.equal(botBlockUnavailableReason(challenge), "automation-blocked");

  for (const [status, expected] of [
    [429, "rate-limited"],
    [401, "authentication-required"],
    [403, "access-denied"],
    [500, "navigation-incomplete"]
  ] as const) {
    const report = makeHealthySupportingComparison();
    const arm = supportingArms(report).primaryBaseline;
    arm.summary.status = status;
    arm.qualityFacts.status = status;
    assert.equal(botBlockUnavailableReason(report), expected);
  }

  const incomplete = makeHealthySupportingComparison();
  supportingArms(incomplete).primaryVariant.qualityFacts.navigationSettled =
    false;
  assert.equal(
    botBlockUnavailableReason(incomplete),
    "navigation-incomplete"
  );
  assert.equal(
    botBlockUnavailableReason(makeHealthySupportingComparison()),
    null
  );
  assert.equal(
    botBlockUnavailableReason({ error: "arbitrary 403 rate limit prose" }),
    null,
    "free-form failure prose is never classified as site unavailability"
  );
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
