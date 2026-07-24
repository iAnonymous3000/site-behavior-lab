import type { AcquisitionKind } from "./scan-report-v2";
import {
  V2_SHADOW_DIR_ENV,
  V2_SHADOW_EMISSION_ENV,
  v2ShadowEmissionEnabled,
  writeV2ShadowArtifact,
  type V2ShadowWriteReceipt
} from "./scan-report-v2-shadow-store";
import {
  RuntimeR2BuildPrerequisiteError,
  buildRuntimeComparisonScanReportV2R2,
  buildRuntimeScanReportV2R2
} from "./scan-report-v2-runtime-builder";
import type { NodeScanMeasurementEnvelope } from "./node-scan-measurement";

/**
 * Kernel step 4: CONTROLLED r2 emission. With the shadow flag on, a successful
 * single scan writes one single report and a successful comparison writes one
 * complete pair report from the visits' explicit phase-aware envelopes. The stored
 * wire is screenshot-free and builder-redacted. Shadow emission is independent
 * of public report selection: gate-off scans remain v1, while gate-on scans may
 * publish r2 and still write a separate shadow artifact. A failed shadow build
 * is an operator diagnostic, never a failed scan.
 */

export { V2_SHADOW_DIR_ENV, V2_SHADOW_EMISSION_ENV, v2ShadowEmissionEnabled };

export type ShadowEmissionOutcome =
  | { status: "disabled" }
  | {
      status: "skipped";
      reason: "measurement-envelope-missing" | "measurement-envelope-inconsistent" | "build-provenance-missing";
    }
  | ({ status: "written"; runId: string } & V2ShadowWriteReceipt)
  | { status: "failed"; message: string };

export type ShadowComparisonEmissionOutcome =
  | { status: "disabled" }
  | {
      status: "skipped";
      reason: "measurement-envelope-missing" | "measurement-envelope-inconsistent" | "build-provenance-missing";
    }
  | ({ status: "written"; pairId: string; baselineRunId: string; variantRunId: string } & V2ShadowWriteReceipt)
  | { status: "failed"; message: string };

/**
 * Build and write the shadow r2 report for one completed visit. Best-effort by
 * contract: every failure resolves to a returned outcome (and an operator log
 * line that never contains a raw subject URL), so the public scan path cannot
 * be affected by shadow-emission readiness gaps.
 */
export async function emitShadowScanReportV2R2(
  envelope: NodeScanMeasurementEnvelope,
  acquisition: AcquisitionKind,
  env: NodeJS.ProcessEnv = process.env
): Promise<ShadowEmissionOutcome> {
  if (!v2ShadowEmissionEnabled(env)) return { status: "disabled" };
  let runId = "unassigned";
  try {
    const report = buildRuntimeScanReportV2R2(envelope, acquisition, env);
    runId = report.run.runId;
    const buildCommit = report.run.provenance.buildCommit;
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
    if (error instanceof RuntimeR2BuildPrerequisiteError) {
      return { status: "skipped", reason: error.code };
    }
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
  baselineEnvelope: NodeScanMeasurementEnvelope,
  variantEnvelope: NodeScanMeasurementEnvelope,
  executedFirst: "baseline" | "variant",
  acquisition: AcquisitionKind,
  env: NodeJS.ProcessEnv = process.env
): Promise<ShadowComparisonEmissionOutcome> {
  if (!v2ShadowEmissionEnabled(env)) return { status: "disabled" };
  let pairId = "unassigned";
  try {
    const report = buildRuntimeComparisonScanReportV2R2(
      baselineEnvelope,
      variantEnvelope,
      executedFirst,
      acquisition,
      env
    );
    if (report.experiment.kind !== "intervention") {
      throw new Error("Node comparison shadow builder returned a non-intervention experiment.");
    }
    pairId = report.experiment.pairId;
    const baselineRunId = report.baseline.runId;
    const variantRunId = report.variant.runId;
    const buildCommit = report.baseline.provenance.buildCommit;
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
    if (error instanceof RuntimeR2BuildPrerequisiteError) {
      return { status: "skipped", reason: error.code };
    }
    const message = error instanceof Error ? error.message : String(error);
    console.warn("Shadow v2/r2 comparison emission failed.", { pairId, message });
    return { status: "failed", message };
  }
}
