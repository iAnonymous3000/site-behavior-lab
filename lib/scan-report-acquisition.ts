import type { AcquisitionKind } from "./scan-report-v2";
import { resolveScannerEgressRegion } from "./scanner-egress";

export const REPORT_ACQUISITION_ENV = "SITE_BEHAVIOR_LAB_REPORT_ACQUISITION";

/**
 * Resolve acquisition provenance from server-owned process configuration.
 * Request bodies and headers never participate. An absent setting names the
 * ordinary public API; the stronger ci-workflow label is accepted only when
 * the same process still carries the controlled r2 preflight facts.
 */
export function runtimeReportAcquisition(
  reportMode: "v1" | "r2",
  environment: NodeJS.ProcessEnv = process.env
): Extract<AcquisitionKind, "public-api" | "ci-workflow"> {
  const configured = environment[REPORT_ACQUISITION_ENV];
  if (configured === undefined || configured === "") return "public-api";
  if (configured !== "ci-workflow") {
    throw new Error(`${REPORT_ACQUISITION_ENV} must be exactly ci-workflow when configured.`);
  }

  const egress = resolveScannerEgressRegion(environment);
  const egressLabel = environment.SITE_BEHAVIOR_LAB_SCANNER_EGRESS?.trim() ?? "";
  if (
    environment.CI !== "1" ||
    reportMode !== "r2" ||
    environment.RUNNER_ENVIRONMENT !== "self-hosted" ||
    environment.FEATURED_R2_EGRESS_ATTESTED !== "1" ||
    environment.SITE_BEHAVIOR_LAB_CHROMIUM_SANDBOX !== "1" ||
    !egressLabel ||
    egressLabel === "github-actions-ubuntu" ||
    egressLabel.toLowerCase() === "unknown" ||
    egress.status !== "configured"
  ) {
    throw new Error(
      "ci-workflow report provenance requires CI=1, r2, the Chromium sandbox, and operator-attested controlled self-hosted egress."
    );
  }
  return "ci-workflow";
}
