import { randomBytes } from "node:crypto";
import type { AcquisitionKind } from "./scan-report-v2";
import type { EphemeralComparisonReportR2, EphemeralSingleReportR2 } from "./scan-report-v2-r2";
import {
  buildNodeComparisonScanReportV2R2,
  buildNodeScanReportV2R2,
  type NodeScanReportV2R2Input
} from "./scan-result-v2-r2-builder";
import { stagedSingleVisitMeasurement, type StagedSingleVisitMeasurement } from "./scanner";
import type { ScanResult } from "./types";

const BUILD_COMMIT_ENV = "SITE_BEHAVIOR_LAB_BUILD_COMMIT";

export type RuntimeR2BuildFailureCode = "no-staged-measurement" | "build-provenance-missing";

export class RuntimeR2BuildPrerequisiteError extends Error {
  constructor(
    public readonly code: RuntimeR2BuildFailureCode,
    message: string
  ) {
    super(message);
    this.name = "RuntimeR2BuildPrerequisiteError";
  }
}

/** Build one screenshot-bearing immediate r2 result from a completed Node visit. */
export function buildRuntimeScanReportV2R2(
  result: ScanResult,
  acquisition: AcquisitionKind,
  env: NodeJS.ProcessEnv = process.env
): EphemeralSingleReportR2 {
  const staged = requireStagedMeasurement(result);
  assertBuildProvenance(env);
  return buildNodeScanReportV2R2(
    nodeBuilderInput(staged, acquisition, mintRunId(staged.emissionInputs.startedAt)),
    env
  );
}

/** Build one complete screenshot-bearing r2 intervention pair from two visits. */
export function buildRuntimeComparisonScanReportV2R2(
  baselineResult: ScanResult,
  variantResult: ScanResult,
  executedFirst: "baseline" | "variant",
  acquisition: AcquisitionKind,
  env: NodeJS.ProcessEnv = process.env
): EphemeralComparisonReportR2 {
  const baseline = requireStagedMeasurement(baselineResult);
  const variant = requireStagedMeasurement(variantResult);
  assertBuildProvenance(env);
  return buildNodeComparisonScanReportV2R2(
    {
      pairId: `pair-${randomBytes(16).toString("hex")}`,
      executedFirst,
      baseline: nodeBuilderInput(baseline, acquisition, mintRunId(baseline.emissionInputs.startedAt)),
      variant: nodeBuilderInput(variant, acquisition, mintRunId(variant.emissionInputs.startedAt))
    },
    env
  );
}

function assertBuildProvenance(env: NodeJS.ProcessEnv): void {
  const buildCommit = env[BUILD_COMMIT_ENV]?.trim().toLowerCase() ?? "";
  if (!/^[0-9a-f]{40}$/.test(buildCommit)) {
    throw new RuntimeR2BuildPrerequisiteError(
      "build-provenance-missing",
      `${BUILD_COMMIT_ENV} must identify a full 40-character Git commit; unknown provenance is rejected.`
    );
  }
}

function requireStagedMeasurement(result: ScanResult): StagedSingleVisitMeasurement {
  const staged = stagedSingleVisitMeasurement(result);
  if (staged === null) {
    throw new RuntimeR2BuildPrerequisiteError(
      "no-staged-measurement",
      "The completed scan is missing its process-local r2 measurement facts."
    );
  }
  return staged;
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
