import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_V2_SHADOW_DIR, V2_SHADOW_DIR_ENV } from "./scan-report-v2-shadow-store";
import { readStoredScanReport } from "./scan-report-reader";
import type { ArmVerification, InterventionAxis } from "./scan-report-v2";
import type { PublicScanReportV2R2, ScanRunV2R2 } from "./scan-report-v2-r2";

const FULL_GIT_SHA = /^[0-9a-f]{40}$/;

export type VerifyV2ShadowArgs = {
  directory: string;
  expectedBuild: string;
  /** Optional rollout gate: require at least one comparison for each named axis. */
  requiredAxes?: readonly InterventionAxis[];
};
type AxisSummary = {
  comparisons: number;
  AB: number;
  BA: number;
  pairEligible: number;
  interventionVerified: number;
};

type AxisArmSummary = Record<ArmVerification["outcome"], number>;

export type V2ShadowVerificationSummary = {
  expectedBuild: string;
  artifacts: number;
  singles: number;
  comparisons: number;
  axes: Record<InterventionAxis, AxisSummary>;
  arms: Record<ArmVerification["outcome"], number>;
};

export function parseVerifyV2ShadowArgs(
  args: string[],
  env: NodeJS.ProcessEnv = process.env
): VerifyV2ShadowArgs {
  let expectedBuild = "";
  let directory = env[V2_SHADOW_DIR_ENV]?.trim() || DEFAULT_V2_SHADOW_DIR;
  let requiredAxes: InterventionAxis[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--expected-build") {
      expectedBuild = args[++index] ?? "";
    } else if (argument === "--dir") {
      directory = args[++index] ?? "";
    } else if (argument === "--require-axes") {
      const value = args[++index] ?? "";
      const axes = value
        .split(",")
        .map((axis) => axis.trim().toLowerCase())
        .filter((axis) => axis.length > 0);
      if (axes.length === 0 || axes.some((axis) => !isInterventionAxis(axis))) {
        throw new Error("--require-axes must be a comma-separated subset of gpc, shields, consent.");
      }
      requiredAxes = [...new Set(axes as InterventionAxis[])];
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  const normalizedBuild = expectedBuild.trim().toLowerCase();
  if (!FULL_GIT_SHA.test(normalizedBuild)) {
    throw new Error("--expected-build must be a full 40-character Git SHA.");
  }
  if (!directory.trim()) throw new Error("--dir requires a non-empty directory.");
  return { directory: path.resolve(directory), expectedBuild: normalizedBuild, requiredAxes };
}

export async function verifyV2ShadowDirectory(input: VerifyV2ShadowArgs): Promise<V2ShadowVerificationSummary> {
  if (!FULL_GIT_SHA.test(input.expectedBuild)) {
    throw new Error("Expected build must be a full lowercase 40-character Git SHA.");
  }
  const entries = (await readdir(input.directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();
  if (entries.length === 0) throw new Error("No v2 shadow JSON artifacts were found.");

  const summary = emptySummary(input.expectedBuild);
  const primaryArmsByAxis: Record<InterventionAxis, AxisArmSummary> = {
    gpc: emptyArmSummary(),
    shields: emptyArmSummary(),
    consent: emptyArmSummary()
  };
  for (const file of entries) {
    const report = await readShadowFile(path.join(input.directory, file), file);
    verifyBuild(report, input.expectedBuild, file);
    if (report.reportType === "single") {
      if (file !== `${report.run.runId}.json`) throw new Error(`${file}: filename does not match the recorded runId.`);
      summary.singles += 1;
      summary.artifacts += 1;
      continue;
    }

    if (report.experiment.kind !== "intervention") {
      throw new Error(`${file}: current Node comparison shadows must be intervention pairs.`);
    }
    if (report.experiment.supportingPairs !== undefined) {
      throw new Error(`${file}: current Node comparison shadows must contain exactly one primary pair.`);
    }
    if (file !== `${report.experiment.pairId}.json`) {
      throw new Error(`${file}: filename does not match the recorded pairId.`);
    }
    summary.comparisons += 1;
    summary.artifacts += 1;
    const axis = summary.axes[report.experiment.axis];
    axis.comparisons += 1;
    axis[report.experiment.order] += 1;
    if (report.comparability.pairValidity.eligible) axis.pairEligible += 1;
    if (report.comparability.interventionVerified) axis.interventionVerified += 1;
    for (const arm of [report.experiment.verification.baseline, report.experiment.verification.variant]) {
      summary.arms[arm.outcome] += 1;
      primaryArmsByAxis[report.experiment.axis][arm.outcome] += 1;
    }
  }
  const invalidRequiredAxis = input.requiredAxes?.find((axis) => !isInterventionAxis(axis));
  if (invalidRequiredAxis !== undefined) {
    throw new Error(`Unknown required comparison axis: ${String(invalidRequiredAxis)}`);
  }
  const missingAxes = [...new Set(input.requiredAxes ?? [])].filter(
    (axis) => summary.axes[axis].comparisons === 0
  );
  if (missingAxes.length > 0) {
    throw new Error(`Missing required comparison axes: ${missingAxes.join(", ")}.`);
  }
  const failedAxes = [...new Set(input.requiredAxes ?? [])].filter((axis) => {
    const value = summary.axes[axis];
    return (
      value.pairEligible !== value.comparisons ||
      value.interventionVerified !== value.comparisons ||
      primaryArmsByAxis[axis].passed !== value.comparisons * 2
    );
  });
  if (failedAxes.length > 0) {
    const details = failedAxes.map((axis) => {
      const value = summary.axes[axis];
      const arms = primaryArmsByAxis[axis];
      return (
        `${axis} (eligible ${value.pairEligible}/${value.comparisons}, ` +
        `verified ${value.interventionVerified}/${value.comparisons}, ` +
        `primary arms ${arms.passed}/${value.comparisons * 2} passed` +
        `${arms.failed > 0 ? `, ${arms.failed} failed` : ""}` +
        `${arms.inconclusive > 0 ? `, ${arms.inconclusive} inconclusive` : ""})`
      );
    });
    throw new Error(`Required comparison axes failed rollout gate: ${details.join("; ")}.`);
  }
  return summary;
}

export function formatV2ShadowVerificationSummary(summary: V2ShadowVerificationSummary): string {
  const lines = [
    `Checked ${summary.artifacts} public v2/r2 shadow artifact${summary.artifacts === 1 ? "" : "s"} for build ${summary.expectedBuild}: ${summary.singles} single, ${summary.comparisons} comparison${summary.comparisons === 1 ? "" : "s"}.`
  ];
  for (const axis of ["gpc", "shields", "consent"] as const) {
    const value = summary.axes[axis];
    if (value.comparisons === 0) continue;
    lines.push(
      `${axis}: ${value.comparisons} (AB ${value.AB}, BA ${value.BA}; eligible ${value.pairEligible}, verified ${value.interventionVerified})`
    );
  }
  lines.push(
    `Arms: ${summary.arms.passed} passed, ${summary.arms.failed} failed, ${summary.arms.inconclusive} inconclusive.`
  );
  return lines.join("\n");
}

async function readShadowFile(filePath: string, fileName: string): Promise<PublicScanReportV2R2> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${fileName}: invalid JSON.`);
    throw error;
  }
  const read = readStoredScanReport(parsed);
  if (!read.ok) throw new Error(`${fileName}: unreadable or inconsistent scan report (${read.error}).`);
  if (read.stored.schemaVersion !== 2 || read.stored.schemaRevision !== 2) {
    throw new Error(`${fileName}: expected ScanReport v2/r2.`);
  }
  return read.stored.report;
}

function verifyBuild(report: PublicScanReportV2R2, expectedBuild: string, fileName: string): void {
  const runs: ScanRunV2R2[] =
    report.reportType === "single"
      ? [report.run]
      : [
          report.baseline,
          report.variant,
          ...(report.experiment.kind === "intervention"
            ? (report.experiment.supportingPairs ?? []).flatMap((pair) => [pair.baseline, pair.variant])
            : [])
        ];
  if (runs.some((run) => run.provenance.buildCommit !== expectedBuild)) {
    throw new Error(`${fileName}: embedded build provenance does not match --expected-build.`);
  }
}

function emptySummary(expectedBuild: string): V2ShadowVerificationSummary {
  const axis = (): AxisSummary => ({ comparisons: 0, AB: 0, BA: 0, pairEligible: 0, interventionVerified: 0 });
  return {
    expectedBuild,
    artifacts: 0,
    singles: 0,
    comparisons: 0,
    axes: { gpc: axis(), shields: axis(), consent: axis() },
    arms: { passed: 0, failed: 0, inconclusive: 0 }
  };
}

function emptyArmSummary(): AxisArmSummary {
  return { passed: 0, failed: 0, inconclusive: 0 };
}

function isInterventionAxis(value: string): value is InterventionAxis {
  return value === "gpc" || value === "shields" || value === "consent";
}

async function main(): Promise<void> {
  const input = parseVerifyV2ShadowArgs(process.argv.slice(2));
  console.log(formatV2ShadowVerificationSummary(await verifyV2ShadowDirectory(input)));
}

if (require.main === module) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
