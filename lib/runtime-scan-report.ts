import { CONSENT_VERIFICATION_ENV } from "./consent-verification";
import { PublicScanError } from "./public-errors";
import type { EphemeralComparisonReportR2, EphemeralSingleReportR2 } from "./scan-report-v2-r2";
import type {
  ScanError,
  ScanJobSubmissionResponse,
  ScanJobStatusResponse,
  ScanReport
} from "./types";

/**
 * Runtime-only report contracts. The frozen v1 wire/API types stay untouched;
 * Node's controlled rollout widens at this separate seam instead.
 */
export type EphemeralScanReportR2 = EphemeralSingleReportR2 | EphemeralComparisonReportR2;
export type RuntimeScanReport = ScanReport | EphemeralScanReportR2;
export type RuntimeReportSaver = <T extends RuntimeScanReport>(report: T) => Promise<T>;
export type RuntimeScanApiResponse = RuntimeScanReport | ScanJobSubmissionResponse | ScanError;
export type RuntimeScanJobStatusResponse = Omit<ScanJobStatusResponse, "report"> & {
  report?: RuntimeScanReport;
};
export type RuntimeScanJobApiResponse = RuntimeScanJobStatusResponse | ScanError;

export const PUBLIC_R2_REPORTS_ENV = "SITE_BEHAVIOR_LAB_PUBLIC_R2_REPORTS";
export const BUILD_COMMIT_ENV = "SITE_BEHAVIOR_LAB_BUILD_COMMIT";

export type PublicR2ReportsReadiness = {
  status: "enabled" | "disabled" | "misconfigured";
  issues: string[];
};

/** Exact opt-in plus all prerequisites needed to produce trustworthy r2. */
export function publicR2ReportsReadiness(env: NodeJS.ProcessEnv = process.env): PublicR2ReportsReadiness {
  const flag = env[PUBLIC_R2_REPORTS_ENV];
  if (flag === undefined || flag === "" || flag === "0") {
    return { status: "disabled", issues: [] };
  }
  if (flag !== "1") {
    return {
      status: "misconfigured",
      issues: [`${PUBLIC_R2_REPORTS_ENV} must be 0, 1, or unset.`]
    };
  }

  const issues: string[] = [];
  const buildCommit = env[BUILD_COMMIT_ENV]?.trim().toLowerCase() ?? "";
  if (!/^[0-9a-f]{40}$/.test(buildCommit)) {
    issues.push(`${BUILD_COMMIT_ENV} must identify a full 40-character Git commit.`);
  }
  if (env[CONSENT_VERIFICATION_ENV] !== "1") {
    issues.push(`${CONSENT_VERIFICATION_ENV} must be 1 before public r2 reports are enabled.`);
  }
  return issues.length === 0
    ? { status: "enabled", issues }
    : { status: "misconfigured", issues };
}

/**
 * Resolve the runtime producer once, before a scan is admitted. A requested
 * but unready r2 producer is an outage, never permission to emit v1 instead.
 */
export function requireRuntimeScanReportMode(
  env: NodeJS.ProcessEnv = process.env
): "v1" | "r2" {
  const readiness = publicR2ReportsReadiness(env);
  if (readiness.status === "disabled") return "v1";
  if (readiness.status === "enabled") return "r2";
  throw new PublicScanError(
    `Public r2 report production is misconfigured: ${readiness.issues.join(" ")}`,
    503
  );
}
