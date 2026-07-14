import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  makeConsentInterventionReportV2R2,
  makeGpcInterventionReportV2R2,
  makePublicSingleReportV2R2,
  makeShieldsInterventionReportV2R2
} from "./scan-report-v2-r2-fixtures";
import { makeScanReportV1 } from "./scan-report-v2-fixtures";
import { buildComparisonDiffV2 } from "./scan-report-v2-evaluators";
import { deriveArmVerificationR2, evaluateComparabilityR2 } from "./scan-report-v2-r2-evaluators";
import type { PublicComparisonReportV2R2 } from "./scan-report-v2-r2";
import {
  formatV2ShadowVerificationSummary,
  parseVerifyV2ShadowArgs,
  verifyV2ShadowDirectory
} from "./verify-v2-shadow-cli";

const BUILD = "f".repeat(40);

test("the shadow verifier deep-checks and summarizes singles plus all intervention axes", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "sbl-shadow-verify-"));
  try {
    const single = makePublicSingleReportV2R2();
    const gpc = makeGpcInterventionReportV2R2();
    const shields = makeShieldsInterventionReportV2R2();
    const consent = makeConsentInterventionReportV2R2();
    await writeReport(directory, `${single.run.runId}.json`, single);
    for (const report of [gpc, shields, consent]) {
      if (report.experiment.kind !== "intervention") throw new Error("fixture invariant");
      await writeReport(directory, `${report.experiment.pairId}.json`, report);
    }

    const summary = await verifyV2ShadowDirectory({ directory, expectedBuild: BUILD });
    assert.equal(summary.artifacts, 4);
    assert.equal(summary.singles, 1);
    assert.equal(summary.comparisons, 3);
    assert.deepEqual(summary.axes.gpc, {
      comparisons: 1,
      AB: 1,
      BA: 0,
      pairEligible: 1,
      interventionVerified: 1
    });
    assert.equal(summary.axes.shields.comparisons, 1);
    assert.equal(summary.axes.consent.comparisons, 1);
    assert.deepEqual(summary.arms, { passed: 6, failed: 0, inconclusive: 0 });
    assert.match(formatV2ShadowVerificationSummary(summary), /gpc: 1 \(AB 1, BA 0; eligible 1, verified 1\)/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the shadow verifier rejects empty, malformed, wrong-generation, and wrong-build artifacts", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "sbl-shadow-invalid-"));
  try {
    await assert.rejects(
      () => verifyV2ShadowDirectory({ directory, expectedBuild: BUILD }),
      /No v2 shadow JSON artifacts/
    );

    await writeFile(path.join(directory, "broken.json"), "{");
    await assert.rejects(
      () => verifyV2ShadowDirectory({ directory, expectedBuild: BUILD }),
      /broken\.json: invalid JSON/
    );
    await rm(path.join(directory, "broken.json"));

    await writeReport(directory, "v1.json", makeScanReportV1());
    await assert.rejects(
      () => verifyV2ShadowDirectory({ directory, expectedBuild: BUILD }),
      /expected ScanReport v2\/r2/
    );
    await rm(path.join(directory, "v1.json"));

    const single = makePublicSingleReportV2R2();
    await writeReport(directory, `${single.run.runId}.json`, single);
    await assert.rejects(
      () => verifyV2ShadowDirectory({ directory, expectedBuild: "a".repeat(40) }),
      /embedded build provenance/
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the shadow verifier binds filenames to recorded artifact ids", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "sbl-shadow-name-"));
  try {
    await writeReport(directory, "renamed.json", makePublicSingleReportV2R2());
    await assert.rejects(
      () => verifyV2ShadowDirectory({ directory, expectedBuild: BUILD }),
      /filename does not match the recorded runId/
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the shadow verifier can require complete rollout coverage across all axes", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "sbl-shadow-required-"));
  try {
    const gpc = makeGpcInterventionReportV2R2();
    if (gpc.experiment.kind !== "intervention") throw new Error("fixture invariant");
    await writeReport(directory, `${gpc.experiment.pairId}.json`, gpc);
    await assert.rejects(
      () =>
        verifyV2ShadowDirectory({
          directory,
          expectedBuild: BUILD,
          requiredAxes: ["gpc", "shields", "consent"]
        }),
      /Missing required comparison axes: shields, consent/
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("required axes reject a present but pair-ineligible comparison", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "sbl-shadow-ineligible-"));
  try {
    const gpc = makeGpcInterventionReportV2R2();
    if (gpc.experiment.kind !== "intervention") throw new Error("fixture invariant");
    gpc.variant.subject.observed.routeShape = "/different-route";
    rederiveComparison(gpc);
    await writeReport(directory, `${gpc.experiment.pairId}.json`, gpc);

    // Audit mode remains descriptive: without an explicit rollout gate, a
    // valid but ineligible pair is summarized rather than rejected.
    const summary = await verifyV2ShadowDirectory({ directory, expectedBuild: BUILD });
    assert.equal(summary.axes.gpc.pairEligible, 0);
    assert.equal(summary.axes.gpc.interventionVerified, 1);
    assert.deepEqual(summary.arms, { passed: 2, failed: 0, inconclusive: 0 });

    await assert.rejects(
      () =>
        verifyV2ShadowDirectory({
          directory,
          expectedBuild: BUILD,
          requiredAxes: ["gpc"]
        }),
      /Required comparison axes failed rollout gate: gpc \(eligible 0\/1, verified 1\/1, primary arms 2\/2 passed\)/
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("required axes reject failed and inconclusive primary arms", async () => {
  for (const outcome of ["failed", "inconclusive"] as const) {
    const directory = await mkdtemp(path.join(tmpdir(), `sbl-shadow-${outcome}-`));
    try {
      const gpc = makeGpcInterventionReportV2R2();
      if (gpc.experiment.kind !== "intervention") throw new Error("fixture invariant");
      const facts = gpc.variant.verificationFacts?.gpc;
      if (!facts) throw new Error("fixture invariant");
      if (outcome === "failed") {
        facts.header = "confirmed-absent";
        facts.jsSignal = "confirmed-absent";
      } else {
        facts.header = "unobservable";
        facts.jsSignal = "unobservable";
      }
      const arm = deriveArmVerificationR2(gpc.variant, "gpc");
      if (!arm) throw new Error("fixture invariant");
      gpc.experiment.verification.variant = arm;
      rederiveComparison(gpc);
      await writeReport(directory, `${gpc.experiment.pairId}.json`, gpc);

      // The report remains reader-valid and visible in non-gating audit mode.
      const summary = await verifyV2ShadowDirectory({ directory, expectedBuild: BUILD });
      assert.equal(summary.axes.gpc.pairEligible, 1);
      assert.equal(summary.axes.gpc.interventionVerified, 0);
      assert.equal(summary.arms.passed, 1);
      assert.equal(summary.arms[outcome], 1);

      await assert.rejects(
        () =>
          verifyV2ShadowDirectory({
            directory,
            expectedBuild: BUILD,
            requiredAxes: ["gpc"]
          }),
        new RegExp(
          `Required comparison axes failed rollout gate: gpc \\(eligible 1/1, verified 0/1, primary arms 1/2 passed, 1 ${outcome}\\)`
        )
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("CLI arguments require one full expected build and reject unknowns", () => {
  assert.deepEqual(parseVerifyV2ShadowArgs([
    "--expected-build",
    BUILD,
    "--dir",
    "artifacts",
    "--require-axes",
    "gpc,shields,consent,gpc"
  ], {}), {
    directory: path.resolve("artifacts"),
    expectedBuild: BUILD,
    requiredAxes: ["gpc", "shields", "consent"]
  });
  assert.throws(() => parseVerifyV2ShadowArgs([], {}), /--expected-build/);
  assert.throws(() => parseVerifyV2ShadowArgs(["--expected-build", "main"], {}), /full 40-character/);
  assert.throws(
    () => parseVerifyV2ShadowArgs(["--expected-build", BUILD, "--require-axes", "gpc,unknown"], {}),
    /comma-separated subset/
  );
  assert.throws(() => parseVerifyV2ShadowArgs(["--wat"], {}), /Unknown argument/);
});

async function writeReport(directory: string, file: string, report: unknown): Promise<void> {
  await writeFile(path.join(directory, file), `${JSON.stringify(report, null, 2)}\n`);
}

function rederiveComparison(report: PublicComparisonReportV2R2): void {
  if (report.experiment.kind !== "intervention") throw new Error("fixture invariant");
  const { supportingPairs: _supportingPairs, ...experiment } = report.experiment;
  report.comparability = evaluateComparabilityR2(experiment, report.baseline, report.variant);
  report.diff = buildComparisonDiffV2(report.baseline, report.variant, report.comparability.perMetric);
}
