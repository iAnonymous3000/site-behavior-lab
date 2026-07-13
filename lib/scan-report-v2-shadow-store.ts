import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createR2ReportStoreBackend, r2ReportStoreConfigFromEnv, type R2ReportStoreConfig } from "./report-store-r2";
import { readStoredScanReport } from "./scan-report-reader";
import { toPublicScanReportR2 } from "./scan-report-v2-r2-projection";
import type { EphemeralComparisonReportR2, EphemeralSingleReportR2, ScanRunV2R2 } from "./scan-report-v2-r2";

export const V2_SHADOW_BACKEND_ENV = "SITE_BEHAVIOR_LAB_V2_SHADOW_BACKEND";
export const V2_SHADOW_DIR_ENV = "SITE_BEHAVIOR_LAB_V2_SHADOW_DIR";
export const V2_SHADOW_EMISSION_ENV = "SITE_BEHAVIOR_LAB_V2_SHADOW_EMISSION";
export const DEFAULT_V2_SHADOW_DIR = ".site-behavior-lab/v2-shadow";
const BUILD_COMMIT_ENV = "SITE_BEHAVIOR_LAB_BUILD_COMMIT";
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const FULL_GIT_SHA = /^[0-9a-f]{40}$/;

export type V2ShadowStoreSink = "filesystem" | "r2";

export type V2ShadowWriteReceipt =
  | { sink: "filesystem"; key: string; filePath: string }
  | { sink: "r2"; key: string };

export type V2ShadowStoreStatus =
  | { sink: V2ShadowStoreSink; error: null }
  | { sink: "unavailable"; error: string };

type V2ShadowStoreDeps = {
  createR2Backend?: (config: R2ReportStoreConfig) => { write(id: string, contents: string): Promise<void> };
};

export function v2ShadowEmissionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[V2_SHADOW_EMISSION_ENV] === "1";
}

/**
 * Persist one already-public r2 shadow wire. The object ID is a producer-minted
 * opaque token and every backend is create-only: a collision surfaces instead
 * of replacing prior evidence.
 */
export async function writeV2ShadowArtifact(
  report: EphemeralSingleReportR2 | EphemeralComparisonReportR2,
  env: NodeJS.ProcessEnv = process.env,
  deps: V2ShadowStoreDeps = {}
): Promise<V2ShadowWriteReceipt> {
  const buildCommit = env[BUILD_COMMIT_ENV]?.trim().toLowerCase() ?? "";
  const publicReport = toPublicScanReportR2(report);
  const read = readStoredScanReport(publicReport);
  if (!read.ok || read.stored.schemaVersion !== 2 || read.stored.schemaRevision !== 2) {
    throw new Error("Shadow persistence accepts only a validator-clean public ScanReport v2/r2 wire.");
  }

  const id = shadowArtifactId(publicReport);
  assertShadowIdentity(id, buildCommit);
  const runs = shadowRuns(publicReport);
  if (runs.some((run) => run.provenance.buildCommit !== buildCommit)) {
    throw new Error("Shadow report build provenance disagrees with the configured build commit.");
  }
  const wire = `${JSON.stringify(publicReport, null, 2)}\n`;
  const sink = shadowSinkFromEnv(env);

  if (sink === "filesystem") {
    const directory = path.resolve(env[V2_SHADOW_DIR_ENV]?.trim() || DEFAULT_V2_SHADOW_DIR);
    await mkdir(directory, { recursive: true });
    const key = `${id}.json`;
    const filePath = path.join(directory, key);
    await writeFile(filePath, wire, { flag: "wx" });
    return { sink, key, filePath };
  }

  const config = shadowR2Config(env, buildCommit, publicReport.reportType);
  const backend = (deps.createR2Backend ?? createR2ReportStoreBackend)(config);
  await backend.write(id, wire);
  return { sink, key: `${config.prefix}${id}.json` };
}

/** Safe health projection: never exposes a path, bucket, endpoint, or key. */
export function v2ShadowStoreStatus(env: NodeJS.ProcessEnv = process.env): V2ShadowStoreStatus {
  try {
    const buildCommit = env[BUILD_COMMIT_ENV]?.trim().toLowerCase() ?? "";
    if (v2ShadowEmissionEnabled(env) && !FULL_GIT_SHA.test(buildCommit)) {
      throw new Error(`${BUILD_COMMIT_ENV} must identify a full 40-character Git commit for shadow emission.`);
    }
    const sink = shadowSinkFromEnv(env);
    if (sink === "r2") {
      shadowR2Config(env, buildCommit, "single");
    }
    return { sink, error: null };
  } catch (error) {
    return { sink: "unavailable", error: error instanceof Error ? error.message : "unknown configuration error" };
  }
}

export function shadowR2Config(
  env: NodeJS.ProcessEnv,
  buildCommit: string,
  reportType: "single" | "comparison"
): R2ReportStoreConfig {
  if (!FULL_GIT_SHA.test(buildCommit)) {
    throw new Error(`${BUILD_COMMIT_ENV} must identify a full 40-character Git commit for the r2 shadow prefix.`);
  }
  const base = r2ReportStoreConfigFromEnv(env);
  return { ...base, prefix: `v2-shadow/${buildCommit}/${reportType}/` };
}

function shadowSinkFromEnv(env: NodeJS.ProcessEnv): V2ShadowStoreSink {
  const configured = env[V2_SHADOW_BACKEND_ENV]?.trim().toLowerCase();
  if (!configured || configured === "filesystem") return "filesystem";
  if (configured === "r2") return "r2";
  throw new Error(`${V2_SHADOW_BACKEND_ENV} must be filesystem or r2.`);
}

function assertShadowIdentity(id: string, buildCommit: string): void {
  if (!OPAQUE_ID.test(id)) throw new Error("Shadow artifact id must be a bounded producer-generated opaque token.");
  if (!FULL_GIT_SHA.test(buildCommit)) throw new Error("Shadow artifact buildCommit must be a full lowercase Git SHA.");
}

function shadowArtifactId(
  report: ReturnType<typeof toPublicScanReportR2>
): string {
  if (report.reportType === "single") return report.run.runId;
  if (report.experiment.kind !== "intervention") {
    throw new Error("Node comparison shadows must carry an intervention experiment.");
  }
  return report.experiment.pairId;
}

function shadowRuns(report: ReturnType<typeof toPublicScanReportR2>): ScanRunV2R2[] {
  if (report.reportType === "single") return [report.run];
  const supporting =
    report.experiment.kind === "intervention" ? report.experiment.supportingPairs ?? [] : [];
  return [
    report.baseline,
    report.variant,
    ...supporting.flatMap((pair) => [pair.baseline, pair.variant])
  ];
}
