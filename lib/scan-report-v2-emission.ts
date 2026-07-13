import { randomBytes } from "node:crypto";
import type { AcquisitionKind } from "./scan-report-v2";
import {
  V2_SHADOW_DIR_ENV,
  V2_SHADOW_EMISSION_ENV,
  v2ShadowEmissionEnabled,
  writeV2ShadowArtifact,
  type V2ShadowWriteReceipt
} from "./scan-report-v2-shadow-store";
import {
  buildNodeComparisonScanReportV2R2,
  buildNodeScanReportV2R2,
  type NodeScanReportV2R2Input
} from "./scan-result-v2-r2-builder";
import { stagedSingleVisitMeasurement, type StagedSingleVisitMeasurement } from "./scanner";
import type { ScanResult } from "./types";

/**
 * Kernel step 4: CONTROLLED r2 emission. With the shadow flag on, a successful
 * single scan writes one single report and a successful comparison writes one
 * complete pair report from the visits' staged phase-aware facts. The PUBLIC
 * wire is screenshot-free and builder-redacted. Nothing public changes:
 * producers keep emitting v1, the alias stays on r1, and a failed build is an
 * operator diagnostic, never a failed scan.
 */

export { V2_SHADOW_DIR_ENV, V2_SHADOW_EMISSION_ENV, v2ShadowEmissionEnabled };
const BUILD_COMMIT_ENV = "SITE_BEHAVIOR_LAB_BUILD_COMMIT";

export type ShadowEmissionOutcome =
  | { status: "disabled" }
  | { status: "skipped"; reason: "no-staged-measurement" | "build-provenance-missing" }
  | ({ status: "written"; runId: string } & V2ShadowWriteReceipt)
  | { status: "failed"; message: string };

export type ShadowComparisonEmissionOutcome =
  | { status: "disabled" }
  | { status: "skipped"; reason: "no-staged-measurement" | "build-provenance-missing" }
  | ({ status: "written"; pairId: string; baselineRunId: string; variantRunId: string } & V2ShadowWriteReceipt)
  | { status: "failed"; message: string };

/**
 * Build and write the shadow r2 report for one completed visit. Best-effort by
 * contract: every failure resolves to a returned outcome (and an operator log
 * line that never contains a raw subject URL), so the v1 scan path cannot be
 * affected by emission-readiness gaps.
 */
export async function emitShadowScanReportV2R2(
  result: ScanResult,
  acquisition: AcquisitionKind,
  env: NodeJS.ProcessEnv = process.env
): Promise<ShadowEmissionOutcome> {
  if (!v2ShadowEmissionEnabled(env)) return { status: "disabled" };
  let runId = "unassigned";
  try {
    const staged = stagedSingleVisitMeasurement(result);
    if (staged === null) return { status: "skipped", reason: "no-staged-measurement" };
    const buildCommit = env[BUILD_COMMIT_ENV]?.trim().toLowerCase() ?? "";
    if (!/^[0-9a-f]{40}$/.test(buildCommit)) {
      // The builder hard-requires build provenance; without it there is
      // nothing controlled about the emission.
      return { status: "skipped", reason: "build-provenance-missing" };
    }

    runId = mintRunId(staged.emissionInputs.startedAt);
    const report = buildNodeScanReportV2R2(nodeBuilderInput(staged, acquisition, runId), env);
    const receipt = await writeV2ShadowArtifact(report, env);
    console.info("Shadow v2/r2 emission written.", {
      sink: receipt.sink,
      key: receipt.key,
      reportType: "single",
      runId,
      buildCommit
    });
    return { status: "written", runId, ...receipt };
  } catch (error) {
    // Builder errors use the closed scanner vocabulary and the write path;
    // neither embeds a raw subject URL.
    const message = error instanceof Error ? error.message : String(error);
    console.warn("Shadow v2/r2 emission failed.", { runId, message });
    return { status: "failed", message };
  }
}

/**
 * Build and write exactly one shadow report for a completed intervention pair.
 * Missing facts on either arm skip the whole pair; partial single artifacts are
 * never written.
 */
export async function emitShadowComparisonScanReportV2R2(
  baselineResult: ScanResult,
  variantResult: ScanResult,
  executedFirst: "baseline" | "variant",
  acquisition: AcquisitionKind,
  env: NodeJS.ProcessEnv = process.env
): Promise<ShadowComparisonEmissionOutcome> {
  if (!v2ShadowEmissionEnabled(env)) return { status: "disabled" };
  let pairId = "unassigned";
  try {
    const baselineStaged = stagedSingleVisitMeasurement(baselineResult);
    const variantStaged = stagedSingleVisitMeasurement(variantResult);
    if (baselineStaged === null || variantStaged === null) {
      return { status: "skipped", reason: "no-staged-measurement" };
    }
    const buildCommit = env[BUILD_COMMIT_ENV]?.trim().toLowerCase() ?? "";
    if (!/^[0-9a-f]{40}$/.test(buildCommit)) {
      return { status: "skipped", reason: "build-provenance-missing" };
    }

    pairId = `pair-${randomBytes(16).toString("hex")}`;
    const baselineRunId = mintRunId(baselineStaged.emissionInputs.startedAt);
    const variantRunId = mintRunId(variantStaged.emissionInputs.startedAt);
    const report = buildNodeComparisonScanReportV2R2(
      {
        pairId,
        executedFirst,
        baseline: nodeBuilderInput(baselineStaged, acquisition, baselineRunId),
        variant: nodeBuilderInput(variantStaged, acquisition, variantRunId)
      },
      env
    );
    if (report.experiment.kind !== "intervention") {
      throw new Error("Node comparison shadow builder returned a non-intervention experiment.");
    }
    const receipt = await writeV2ShadowArtifact(report, env);
    console.info("Shadow v2/r2 emission written.", {
      sink: receipt.sink,
      key: receipt.key,
      reportType: "comparison",
      pairId,
      baselineRunId,
      variantRunId,
      axis: report.experiment.axis,
      order: report.experiment.order,
      buildCommit
    });
    return { status: "written", pairId, baselineRunId, variantRunId, ...receipt };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("Shadow v2/r2 comparison emission failed.", { pairId, message });
    return { status: "failed", message };
  }
}

function mintRunId(startedAt: string): string {
  return `${startedAt.slice(0, 10).replaceAll("-", "")}-${randomBytes(16).toString("hex")}`;
}

function nodeBuilderInput(
  staged: StagedSingleVisitMeasurement,
  acquisition: AcquisitionKind,
  runId: string
): NodeScanReportV2R2Input {
  const inputs = staged.emissionInputs;
  return {
    runId,
    startedAt: inputs.startedAt,
    requestedUrl: inputs.requestedUrl,
    observedUrl: inputs.observedUrl,
    conditions: inputs.conditions,
    acquisition,
    adblockEngineLoaded: inputs.adblockEngineLoaded,
    measurement: staged.measurement,
    evidence: staged.evidence,
    summary: { pageTitle: inputs.pageTitle, durationMs: inputs.durationMs },
    ...(staged.consent !== undefined ? { consent: staged.consent } : {}),
    verificationFacts: staged.verificationFacts,
    warnings: inputs.warnings,
    screenshot: inputs.screenshot
  };
}
