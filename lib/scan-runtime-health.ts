/**
 * Shared contract for the `/api/health` response across scan runtimes.
 *
 * The Node app and the Cloudflare Worker keep separate health implementations
 * (different internals, warnings, and limits), but both must present this common
 * shape so the browser client can read capability/readiness signals uniformly.
 * `asScanRuntimeHealth` enforces conformance at compile time on each producer
 * (it is an identity function, no runtime effect), and `isScanRuntimeHealth`
 * validates a fetched payload before the client trusts it.
 *
 * Neutral by construction (no Node/Worker/browser APIs) so every runtime can
 * import it.
 */

import { isRecord } from "./guards";

export type ScanRuntimeStatus = "ok" | "degraded" | "error";

export type DurableScanJobsReadiness = "disabled" | "node-ready" | "ready" | "misconfigured";

export type ScanRuntimeCapabilities = {
  singleScan?: boolean;
  gpcComparison?: boolean;
  shieldsComparison?: boolean;
  consentComparison?: boolean;
  savedReports?: boolean;
  /**
   * The scan API origin serves human-viewable `/reports/:id` HTML pages (it runs
   * the full Node app), so a freshly scanned report has a shareable permalink
   * there. False/absent for an API-only producer (e.g. the Browser Run Worker
   * exposes `/api/reports/:id` JSON only), where a fresh report is unshareable.
   */
  savedReportPages?: boolean;
};

export type ScanRuntimeHealth = {
  ok: boolean;
  status?: ScanRuntimeStatus;
  error?: string;
  configIssues?: string[];
  runtime?: string;
  scanner?: string;
  deployment?: string;
  storage?: string;
  authenticated?: boolean;
  openAccess?: boolean;
  turnstile?: boolean;
  /** False when the runtime is healthy enough to answer but its gate refuses every scan. */
  scansAvailable?: boolean;
  warnings?: string[];
  checks?: {
    adblock?: {
      active?: boolean;
      engine?: "loaded" | "unavailable";
    };
    chromiumSandbox?: "enabled" | "disabled";
    scanAccess?: "configured" | "open" | "refused";
    scannerEgressRegion?: "configured" | "unrecorded" | "misconfigured";
    consentVerification?: "enabled" | "disabled" | "misconfigured";
    publicR2Reports?: {
      status: "enabled" | "disabled" | "misconfigured";
    };
    /**
     * `node-ready` proves only the container-side prerequisites. The edge must
     * still verify its Worker-only encryption key and Durable Object wiring
     * before upgrading the effective posture to `ready`.
     */
    durableJobs?: {
      requested: boolean;
      enabled: boolean;
      readiness: DurableScanJobsReadiness;
      reasons?: string[];
    };
    v2ShadowEmission?: {
      status: "enabled" | "disabled" | "misconfigured";
      backend: "filesystem" | "r2" | "none";
    };
  };
  capabilities?: ScanRuntimeCapabilities;
  limits?: {
    maxRecordedRequests?: number;
    maxScanDurationMs?: number;
    maxComparisonDurationMs?: number;
    publicScanRateLimitPerMinute?: number;
    publicScanRateLimitPerDay?: number;
  };
};

/**
 * Compile-time conformance gate for a health producer. Returns its argument
 * unchanged, so a producer may return a richer object while proving it still
 * satisfies the shared contract.
 */
export function asScanRuntimeHealth<const T extends ScanRuntimeHealth>(health: T): T {
  return health;
}

/** Validate a fetched `/api/health` payload against the shared contract. */
export function isScanRuntimeHealth(value: unknown): value is ScanRuntimeHealth {
  if (!isRecord(value)) return false;
  if (typeof value.ok !== "boolean") return false;
  if (value.status !== undefined && !isScanRuntimeStatus(value.status)) return false;
  if (value.error !== undefined && typeof value.error !== "string") return false;
  if (value.deployment !== undefined && typeof value.deployment !== "string") return false;
  if (value.scansAvailable !== undefined && typeof value.scansAvailable !== "boolean") return false;
  if (value.warnings !== undefined && (!Array.isArray(value.warnings) || !value.warnings.every((item) => typeof item === "string"))) {
    return false;
  }
  if (value.checks !== undefined && !isChecks(value.checks)) return false;
  if (value.capabilities !== undefined && !isCapabilities(value.capabilities)) return false;
  return true;
}

function isScanRuntimeStatus(value: unknown): value is ScanRuntimeStatus {
  return value === "ok" || value === "degraded" || value === "error";
}

function isCapabilities(value: unknown): value is ScanRuntimeCapabilities {
  if (!isRecord(value)) return false;
  return (["singleScan", "gpcComparison", "shieldsComparison", "consentComparison", "savedReports", "savedReportPages"] as const).every(
    (key) => value[key] === undefined || typeof value[key] === "boolean"
  );
}

function isChecks(value: unknown): value is NonNullable<ScanRuntimeHealth["checks"]> {
  if (!isRecord(value)) return false;
  if (
    value.scanAccess !== undefined &&
    value.scanAccess !== "configured" &&
    value.scanAccess !== "open" &&
    value.scanAccess !== "refused"
  ) {
    return false;
  }
  if (
    value.consentVerification !== undefined &&
    value.consentVerification !== "enabled" &&
    value.consentVerification !== "disabled" &&
    value.consentVerification !== "misconfigured"
  ) {
    return false;
  }
  if (
    value.scannerEgressRegion !== undefined &&
    value.scannerEgressRegion !== "configured" &&
    value.scannerEgressRegion !== "unrecorded" &&
    value.scannerEgressRegion !== "misconfigured"
  ) {
    return false;
  }
  if (value.publicR2Reports !== undefined) {
    if (!isRecord(value.publicR2Reports)) return false;
    if (
      value.publicR2Reports.status !== "enabled" &&
      value.publicR2Reports.status !== "disabled" &&
      value.publicR2Reports.status !== "misconfigured"
    ) {
      return false;
    }
  }
  if (value.durableJobs !== undefined) {
    if (!isRecord(value.durableJobs)) return false;
    if (typeof value.durableJobs.requested !== "boolean" || typeof value.durableJobs.enabled !== "boolean") {
      return false;
    }
    if (
      value.durableJobs.readiness !== "disabled" &&
      value.durableJobs.readiness !== "node-ready" &&
      value.durableJobs.readiness !== "ready" &&
      value.durableJobs.readiness !== "misconfigured"
    ) {
      return false;
    }
    if (
      value.durableJobs.reasons !== undefined &&
      (!Array.isArray(value.durableJobs.reasons) ||
        !value.durableJobs.reasons.every((reason) => typeof reason === "string"))
    ) {
      return false;
    }
  }
  if (value.v2ShadowEmission !== undefined) {
    if (!isRecord(value.v2ShadowEmission)) return false;
    if (
      value.v2ShadowEmission.status !== "enabled" &&
      value.v2ShadowEmission.status !== "disabled" &&
      value.v2ShadowEmission.status !== "misconfigured"
    ) {
      return false;
    }
    if (
      value.v2ShadowEmission.backend !== "filesystem" &&
      value.v2ShadowEmission.backend !== "r2" &&
      value.v2ShadowEmission.backend !== "none"
    ) {
      return false;
    }
  }
  return true;
}
