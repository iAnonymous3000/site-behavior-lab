import type { EvidenceFamily, MetricFamily } from "./scan-report-v2";

/**
 * Evidence families each comparison metric reads. The evaluator uses this to
 * gate deltas, while the runtime-light report decision layer uses the same map
 * to explain exactly which PageGraph families were unavailable.
 */
export const METRIC_EVIDENCE_SOURCES: Readonly<
  Record<MetricFamily, readonly EvidenceFamily[]>
> = {
  "raw-counts": ["requests", "cookies", "storage"],
  "tracker-classification": ["requests"],
  "shields-simulation": ["requests"],
  "consent-verification": ["consent-verification"],
  "detector-findings": ["requests", "fingerprinting", "detector-output"]
};
