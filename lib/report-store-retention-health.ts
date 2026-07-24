import type { ReportStoreRetentionStatus } from "./report-store";

export const REPORT_RETENTION_HEALTH_SUCCESS_TTL_MS = 30_000;
export const REPORT_RETENTION_HEALTH_FAILURE_TTL_MS = 5_000;

export type ReportStoreRetentionHealthProbeResult = {
  retention: ReportStoreRetentionStatus;
  checkedAt: string;
  maxAgeMs: number;
  /** Operator-facing text. Log-only: it can name paths, buckets, and upstream bodies. */
  error: string | null;
  /** The original throw, so callers can classify it without parsing `error`. */
  errorCause: unknown;
  stateObserved: boolean;
};

type RetentionHealthProbeOptions = {
  now?: () => number;
  successTtlMs?: number;
  failureTtlMs?: number;
};

/**
 * Process-local single-flight/cadence for the public health endpoint. The
 * publication path deliberately does not use this cache: every publication
 * still performs an uncached fail-closed prune/debt preflight.
 */
export function createReportStoreRetentionHealthProbe(
  maintain: () => Promise<ReportStoreRetentionStatus>,
  readState: () => Promise<ReportStoreRetentionStatus>,
  options: RetentionHealthProbeOptions = {}
): (cacheKey?: string) => Promise<ReportStoreRetentionHealthProbeResult> {
  const now = options.now ?? Date.now;
  const successTtlMs = options.successTtlMs ?? REPORT_RETENTION_HEALTH_SUCCESS_TTL_MS;
  const failureTtlMs = options.failureTtlMs ?? REPORT_RETENTION_HEALTH_FAILURE_TTL_MS;
  let cached: {
    key: string;
    result: ReportStoreRetentionHealthProbeResult;
    expiresAt: number;
  } | null = null;
  let inFlight: { key: string; promise: Promise<ReportStoreRetentionHealthProbeResult> } | null = null;

  return async (cacheKey = "default") => {
    const current = now();
    if (cached?.key === cacheKey && current < cached.expiresAt) return cached.result;
    if (inFlight?.key === cacheKey) return inFlight.promise;

    const execution = (async (): Promise<ReportStoreRetentionHealthProbeResult> => {
      try {
        const retention = await maintain();
        const checkedAtMs = now();
        const result: ReportStoreRetentionHealthProbeResult = {
          retention,
          checkedAt: new Date(checkedAtMs).toISOString(),
          maxAgeMs: successTtlMs,
          error: null,
          errorCause: null,
          stateObserved: true
        };
        cached = { key: cacheKey, result, expiresAt: checkedAtMs + successTtlMs };
        return result;
      } catch (error) {
        let retention: ReportStoreRetentionStatus = {
          debtCount: 0,
          maintenanceRequired: true,
          healthy: false
        };
        let stateObserved = false;
        try {
          const observed = await readState();
          retention = { ...observed, healthy: false };
          stateObserved = true;
        } catch {
          // An unreadable debt ledger is fail-closed and intentionally does not
          // replace the original active-maintenance error.
        }
        const checkedAtMs = now();
        const result: ReportStoreRetentionHealthProbeResult = {
          retention,
          checkedAt: new Date(checkedAtMs).toISOString(),
          maxAgeMs: failureTtlMs,
          error: error instanceof Error ? error.message : "unknown retention maintenance error",
          errorCause: error,
          stateObserved
        };
        cached = { key: cacheKey, result, expiresAt: checkedAtMs + failureTtlMs };
        return result;
      }
    })();
    const flight = { key: cacheKey, promise: execution };
    inFlight = flight;
    try {
      return await execution;
    } finally {
      if (inFlight === flight) inFlight = null;
    }
  };
}
