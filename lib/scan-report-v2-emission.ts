import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AcquisitionKind } from "./scan-report-v2";
import { toPublicScanReportR2 } from "./scan-report-v2-r2-projection";
import { buildNodeScanReportV2R2 } from "./scan-result-v2-r2-builder";
import { stagedSingleVisitMeasurement } from "./scanner";
import type { ScanResult } from "./types";

/**
 * Kernel step 4: CONTROLLED r2 emission. With the shadow flag on, every
 * successful live visit additionally builds a ScanReport v2/r2 from its staged
 * phase-aware facts and writes the PUBLIC wire (screenshot stripped, redaction
 * applied by the builder) to an operator-local directory. Nothing public
 * changes: producers keep emitting v1, the alias stays on r1, and a failed
 * build is an operator diagnostic, never a failed scan. This proves the
 * builder against real traffic before any alias or corpus decision.
 */

export const V2_SHADOW_EMISSION_ENV = "SITE_BEHAVIOR_LAB_V2_SHADOW_EMISSION";
export const V2_SHADOW_DIR_ENV = "SITE_BEHAVIOR_LAB_V2_SHADOW_DIR";
const DEFAULT_SHADOW_DIR = ".site-behavior-lab/v2-shadow";
const BUILD_COMMIT_ENV = "SITE_BEHAVIOR_LAB_BUILD_COMMIT";

export function v2ShadowEmissionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[V2_SHADOW_EMISSION_ENV] === "1";
}

export type ShadowEmissionOutcome =
  | { status: "disabled" }
  | { status: "skipped"; reason: "no-staged-measurement" | "build-provenance-missing" }
  | { status: "written"; filePath: string; runId: string }
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
  const staged = stagedSingleVisitMeasurement(result);
  if (staged === null) return { status: "skipped", reason: "no-staged-measurement" };
  if (!/^[0-9a-f]{40}$/.test(env[BUILD_COMMIT_ENV]?.trim().toLowerCase() ?? "")) {
    // The builder hard-requires build provenance; without it there is nothing
    // controlled about the emission.
    return { status: "skipped", reason: "build-provenance-missing" };
  }

  const inputs = staged.emissionInputs;
  const runId = `${inputs.startedAt.slice(0, 10).replaceAll("-", "")}-${randomBytes(16).toString("hex")}`;
  try {
    const report = buildNodeScanReportV2R2({
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
    });
    const publicReport = toPublicScanReportR2(report);
    const directory = env[V2_SHADOW_DIR_ENV]?.trim() || DEFAULT_SHADOW_DIR;
    await mkdir(directory, { recursive: true });
    const filePath = path.join(directory, `${runId}.json`);
    // Create-only write: a runId collision must surface, never overwrite.
    await writeFile(filePath, `${JSON.stringify(publicReport, null, 2)}\n`, { flag: "wx" });
    return { status: "written", filePath, runId };
  } catch (error) {
    // Builder errors use the closed scanner vocabulary and the write path;
    // neither embeds a raw subject URL.
    const message = error instanceof Error ? error.message : String(error);
    console.warn("Shadow v2/r2 emission failed.", { runId, message });
    return { status: "failed", message };
  }
}
