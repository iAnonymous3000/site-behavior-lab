/**
 * Shared contract for the `/api/health` response across scan runtimes.
 *
 * The Node app and the Cloudflare Worker keep separate health implementations
 * (different internals, warnings, and limits), but both must present this common
 * shape so the browser client can read capability/readiness signals uniformly.
 * `asScanRuntimeHealth` enforces conformance at compile time on each producer
 * (it is an identity function — no runtime effect), and `isScanRuntimeHealth`
 * validates a fetched payload before the client trusts it.
 *
 * Neutral by construction (no Node/Worker/browser APIs) so every runtime can
 * import it.
 */

import { isRecord } from "./guards";

export type ScanRuntimeStatus = "ok" | "degraded" | "error";

export type ScanRuntimeCapabilities = {
  singleScan?: boolean;
  gpcComparison?: boolean;
  shieldsComparison?: boolean;
  savedReports?: boolean;
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
  checks?: {
    adblock?: {
      active?: boolean;
      engine?: "loaded" | "unavailable";
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
  if (value.capabilities !== undefined && !isCapabilities(value.capabilities)) return false;
  return true;
}

function isScanRuntimeStatus(value: unknown): value is ScanRuntimeStatus {
  return value === "ok" || value === "degraded" || value === "error";
}

function isCapabilities(value: unknown): value is ScanRuntimeCapabilities {
  if (!isRecord(value)) return false;
  return (["singleScan", "gpcComparison", "shieldsComparison", "savedReports"] as const).every(
    (key) => value[key] === undefined || typeof value[key] === "boolean"
  );
}
