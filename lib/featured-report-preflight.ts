import { FULL_GIT_SHA } from "./build-provenance";
import { resolveScannerEgressRegion, SCANNER_EGRESS_REGION_ENV } from "./scanner-egress";

export type FeaturedReportMode = "v1" | "r2";

export type FeaturedReportPreflightInput = {
  mode: string | undefined;
  eventCommit: string | undefined;
  checkoutCommit: string;
  worktreeClean: boolean;
  compareGpc: string | undefined;
  compareShields: string | undefined;
  compareConsent: string | undefined;
  runnerEnvironment: string | undefined;
  egressLabel: string | undefined;
  egressRegion: string | undefined;
  egressAttested: string | undefined;
};

export type FeaturedReportPreflightPlan = {
  mode: FeaturedReportMode;
  comparison: boolean;
  environment: Record<string, string>;
  summary: string[];
};

/**
 * Resolve the featured-corpus producer before either Next or Chromium starts.
 *
 * GitHub-hosted runners identify their platform but do not expose a stable,
 * verifiable network region. The featured corpus remains v1 on that platform.
 * Enabling r2 requires a self-hosted runner plus an explicit operator
 * attestation that its declared egress label and region are stable and true;
 * that keeps the default comparison path eligible without inventing placement.
 */
export function featuredReportPreflight(input: FeaturedReportPreflightInput): FeaturedReportPreflightPlan {
  const mode = reportMode(input.mode);
  const checkoutCommit = normalizedCommit(input.checkoutCommit, "checked-out Git commit");
  const eventCommit = normalizedCommit(input.eventCommit, "GitHub event commit");
  if (checkoutCommit !== eventCommit) {
    throw new Error(
      `GitHub event commit ${eventCommit} does not match checked-out HEAD ${checkoutCommit}; refusing false build provenance.`
    );
  }
  if (!input.worktreeClean) {
    throw new Error("The featured scanner checkout is dirty; refusing to build reports with ambiguous source provenance.");
  }

  // Validate every flag before applying the same precedence as the runner.
  // Short-circuiting here would let a malformed lower-precedence value escape
  // the preflight whenever Shields happened to be enabled.
  const compareShields = exactBoolean(input.compareShields, "FEATURED_COMPARE_SHIELDS");
  const compareConsent = exactBoolean(input.compareConsent, "FEATURED_COMPARE_CONSENT");
  const compareGpc = exactBoolean(input.compareGpc, "FEATURED_COMPARE_GPC");
  const comparison = compareShields || compareConsent || compareGpc;

  if (mode === "v1") {
    return {
      mode,
      comparison,
      environment: {
        SITE_BEHAVIOR_LAB_PUBLIC_R2_REPORTS: "0",
        SITE_BEHAVIOR_LAB_CONSENT_VERIFICATION: "0"
      },
      summary: [
        "Featured report producer: frozen v1 compatibility mode.",
        `Exact scanner source: ${checkoutCommit}.`,
        "v1 scan generation does not rewrite existing report bytes; the separate retention process may delete unpinned reports."
      ]
    };
  }

  const egressLabel = requiredText(input.egressLabel, "SITE_BEHAVIOR_LAB_SCANNER_EGRESS", 120);
  const runnerEnvironment = requiredText(input.runnerEnvironment, "RUNNER_ENVIRONMENT");
  if (runnerEnvironment !== "github-hosted" && runnerEnvironment !== "self-hosted") {
    throw new Error("RUNNER_ENVIRONMENT must identify either github-hosted or self-hosted execution.");
  }
  const declaredRegion = input.egressRegion?.trim();
  // Next's ambient ProcessEnv makes NODE_ENV required; preserve that one
  // process invariant while intentionally excluding every placement fallback.
  const regionEnvironment: NodeJS.ProcessEnv = { NODE_ENV: process.env.NODE_ENV };
  if (declaredRegion) regionEnvironment[SCANNER_EGRESS_REGION_ENV] = declaredRegion;
  const regionResolution = resolveScannerEgressRegion(regionEnvironment);
  if (regionResolution.status === "misconfigured") {
    throw new Error(`${SCANNER_EGRESS_REGION_ENV} is present but is not a valid r2 egress region.`);
  }
  const egressRegion = regionResolution.status === "configured" ? regionResolution.value : "";

  if (runnerEnvironment !== "self-hosted") {
    throw new Error(
      "Featured r2 production requires a self-hosted runner with stable declared egress; GitHub-hosted runner placement is not a truthful comparison region. Keep GitHub-hosted refreshes on v1 or configure FEATURED_RUNNER_LABEL for a controlled self-hosted runner."
    );
  }
  if (egressLabel === "github-actions-ubuntu") {
    throw new Error(
      "Featured r2 production on a self-hosted runner requires an explicit SCANNER_EGRESS label; the GitHub-hosted default label is not accepted."
    );
  }
  if (!egressRegion || egressRegion.toLowerCase() === "unknown") {
    throw new Error(
      "Featured r2 production requires SITE_BEHAVIOR_LAB_SCANNER_EGRESS_REGION to name the controlled runner's stable outbound region."
    );
  }
  if (input.egressAttested !== "1") {
    throw new Error(
      "Featured r2 production requires FEATURED_R2_EGRESS_ATTESTED=1 after the operator verifies the self-hosted runner's stable egress label and region."
    );
  }

  return {
    mode,
    comparison,
    environment: {
      SITE_BEHAVIOR_LAB_BUILD_COMMIT: checkoutCommit,
      SITE_BEHAVIOR_LAB_CONSENT_VERIFICATION: "1",
      SITE_BEHAVIOR_LAB_PUBLIC_R2_REPORTS: "1"
    },
    summary: [
      "Featured report producer: ScanReport v2/r2.",
      `Exact scanner source: ${checkoutCommit}.`,
      "Consent-state verification: enabled and required before scan admission.",
      `${comparison ? "Comparison" : "Single-run"} egress: operator-attested self-hosted ${egressLabel} (${egressRegion}).`,
      "r2 scan generation does not rewrite existing report bytes; the separate retention process may delete unpinned reports."
    ]
  };
}

function reportMode(value: string | undefined): FeaturedReportMode {
  const normalized = value?.trim().toLowerCase() || "v1";
  if (normalized === "v1" || normalized === "r2") return normalized;
  throw new Error("FEATURED_REPORT_MODE must be exactly v1 or r2.");
}

function normalizedCommit(value: string | undefined, label: string): string {
  const normalized = value?.trim().toLowerCase() ?? "";
  if (!FULL_GIT_SHA.test(normalized)) {
    throw new Error(`${label} must be a full 40-character lowercase Git commit.`);
  }
  return normalized;
}

function exactBoolean(value: string | undefined, name: string): boolean {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new Error(`${name} must be exactly true or false.`);
}

function requiredText(value: string | undefined, name: string, maxChars = 64): string {
  const normalized = value?.trim() ?? "";
  if (!normalized || normalized.toLowerCase() === "unknown") {
    throw new Error(`${name} must contain a truthful, non-unknown value for r2 production.`);
  }
  if (Array.from(normalized).length > maxChars || /[\u0000-\u001f\u007f-\u009f]/.test(normalized)) {
    throw new Error(`${name} must be at most ${maxChars} characters and contain no control characters.`);
  }
  return normalized;
}
