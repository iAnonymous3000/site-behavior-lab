import { EdgeScanGateError } from "./edge-scan-gate";
import type { PublicScanRateLimitResult } from "./public-scan-rate-limit-store";

/**
 * The refusal for a client over the ingress preflight's per-client ceiling,
 * held in this one constant.
 */
export const PUBLIC_INGRESS_PREFLIGHT_REFUSAL = "Too many health check requests. Try again shortly.";

/**
 * The edge's answer to a refused ingress-preflight charge: the gate's
 * ordinary refusal, uncaused, carrying the window's wait so it also travels
 * as Retry-After. Null when the charge was allowed.
 */
export function publicIngressPreflightRefusal(charge: PublicScanRateLimitResult): EdgeScanGateError | null {
  if (charge.allowed) return null;
  return new EdgeScanGateError(PUBLIC_INGRESS_PREFLIGHT_REFUSAL, 429, undefined, charge.retryAfterSeconds);
}
