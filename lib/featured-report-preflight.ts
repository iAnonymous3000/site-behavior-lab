import { FULL_GIT_SHA } from "./build-provenance";
import {
  CONTROLLED_SCANNER_EGRESS_ALIAS,
  resolveScannerEgressLabel,
  resolveScannerEgressRegion,
  SCANNER_EGRESS_LABEL_ENV,
  SCANNER_EGRESS_REGION_ENV
} from "./scanner-egress";

export type FeaturedReportMode = "v1" | "r2";

export type FeaturedReportPreflightInput = {
  mode: string | undefined;
  eventName: string | undefined;
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
  chromiumSandbox: string | undefined;
  /** Whether the operator has configured the controlled r2 runner label. */
  controlledRunnerConfigured: boolean;
};

export type FeaturedReportPreflightPlan = {
  mode: FeaturedReportMode;
  comparison: boolean;
  environment: Record<string, string>;
  summary: string[];
  /** Loud workflow annotations (GitHub `::warning::`), never silent. */
  warnings: string[];
};

/**
 * Resolve the featured-corpus producer before either Next or Chromium starts.
 *
 * GitHub-hosted runners identify their platform but do not expose a stable,
 * verifiable network region. Automated corpus production therefore requires
 * r2 on a controlled runner. Enabling r2 requires a self-hosted runner plus an
 * explicit operator attestation that its declared egress label and region are
 * stable and true; that keeps comparisons eligible without inventing placement.
 *
 * Frozen v1 remains available as an explicit workflow_dispatch compatibility
 * lane, and additionally as a LOUDLY DISCLOSED scheduled fallback while the
 * controlled r2 runner is not yet configured: the weekly corpus refresh keeps
 * running on the production-proven v1 lane instead of failing every Monday
 * against infrastructure that does not exist. The moment the operator
 * configures the runner label, automated v1 is refused again and only r2 can
 * produce scheduled reports.
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
  if (input.chromiumSandbox !== "1") {
    throw new Error(
      "Committed report acquisition requires SITE_BEHAVIOR_LAB_CHROMIUM_SANDBOX=1 before Chromium can start."
    );
  }

  if (mode === "v1") {
    const scheduledFallback = input.eventName !== "workflow_dispatch";
    if (scheduledFallback && input.controlledRunnerConfigured) {
      throw new Error(
        "Frozen v1 corpus production is an explicit manual compatibility lane (workflow_dispatch); the controlled r2 runner is configured, so scheduled and repository-dispatch production must use r2."
      );
    }
    return {
      mode,
      comparison,
      environment: {
        SITE_BEHAVIOR_LAB_PUBLIC_R2_REPORTS: "0",
        SITE_BEHAVIOR_LAB_CONSENT_VERIFICATION: "0"
      },
      summary: [
        scheduledFallback
          ? "Committed report producer: frozen v1 scheduled fallback; the controlled r2 runner is not configured."
          : "Committed report producer: explicit manual frozen v1 compatibility mode.",
        `Exact scanner source: ${checkoutCommit}.`,
        "Chromium renderer sandbox: required.",
        "v1 scan generation does not rewrite existing report bytes; the separate retention process may delete unpinned reports."
      ],
      warnings: scheduledFallback
        ? [
            "Scheduled corpus production fell back to the frozen v1 lane on GitHub-hosted Ubuntu because the controlled r2 runner is not configured. Configure FEATURED_RUNNER_LABEL, SCANNER_EGRESS, SCANNER_EGRESS_REGION, and FEATURED_R2_EGRESS_ATTESTED=1 for an operator-verified self-hosted runner to restore automated r2 production."
          ]
        : []
    };
  }

  const configuredEgressLabel = requiredText(input.egressLabel, SCANNER_EGRESS_LABEL_ENV, 120);
  const egressLabelResolution = resolveScannerEgressLabel({
    NODE_ENV: process.env.NODE_ENV,
    [SCANNER_EGRESS_LABEL_ENV]: configuredEgressLabel
  });
  if (
    configuredEgressLabel !== CONTROLLED_SCANNER_EGRESS_ALIAS ||
    egressLabelResolution.status !== "aliased"
  ) {
    throw new Error(
      `${SCANNER_EGRESS_LABEL_ENV} must be ${CONTROLLED_SCANNER_EGRESS_ALIAS} for committed r2 production; the report uses a generic public label and records the operator-attested location in ${SCANNER_EGRESS_REGION_ENV}.`
    );
  }
  const publicEgressLabel = egressLabelResolution.value;
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
      "Committed r2 production requires a self-hosted runner with stable declared egress; GitHub-hosted runner placement is not a truthful comparison region. Configure FEATURED_RUNNER_LABEL for a controlled self-hosted runner; v1 is available only through the explicit manual compatibility lane."
    );
  }
  if (!egressRegion || egressRegion.toLowerCase() === "unknown") {
    throw new Error(
      "Committed r2 production requires SITE_BEHAVIOR_LAB_SCANNER_EGRESS_REGION to name the controlled runner's stable outbound region."
    );
  }
  if (input.egressAttested !== "1") {
    throw new Error(
      "Committed r2 production requires FEATURED_R2_EGRESS_ATTESTED=1 after the operator verifies the self-hosted runner's stable egress label and region."
    );
  }

  return {
    mode,
    comparison,
    environment: {
      SITE_BEHAVIOR_LAB_BUILD_COMMIT: checkoutCommit,
      SITE_BEHAVIOR_LAB_CONSENT_VERIFICATION: "1",
      SITE_BEHAVIOR_LAB_PUBLIC_R2_REPORTS: "1",
      // Server-only provenance. The scan API reads this process setting; no
      // request payload or header can opt into the ci-workflow label.
      SITE_BEHAVIOR_LAB_REPORT_ACQUISITION: "ci-workflow"
    },
    summary: [
      "Committed report producer: ScanReport v2/r2 via the controlled ci-workflow acquisition lane.",
      `Exact scanner source: ${checkoutCommit}.`,
      "Consent-state verification: enabled and required before scan admission.",
      "Chromium renderer sandbox: required.",
      `${comparison ? "Comparison" : "Single-run"} egress: operator-attested self-hosted lane ${configuredEgressLabel}; public label ${publicEgressLabel}; region ${egressRegion}.`,
      "r2 scan generation does not rewrite existing report bytes; the separate retention process may delete unpinned reports."
    ],
    warnings: []
  };
}

function reportMode(value: string | undefined): FeaturedReportMode {
  const normalized = value?.trim().toLowerCase() ?? "";
  if (normalized === "v1" || normalized === "r2") return normalized;
  throw new Error("FEATURED_REPORT_MODE must be explicitly set to exactly v1 or r2; there is no legacy default.");
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
