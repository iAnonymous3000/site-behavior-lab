import type { DetectorStatus } from "./scan-report-v2";

/**
 * Reader-safe detector outcome vocabulary.
 *
 * This contract intentionally does not import the Node measurement kernel.
 * Public readers must be able to validate detector outcomes without loading a
 * producer implementation (and historical readers must not inherit mutable
 * producer state).
 */
export const DETECTOR_REASON_CODES = Object.freeze([
  "probe-disabled",
  "budget-unavailable",
  "evidence-cap-reached",
  "not-requested",
  "unsupported",
  "load-failed",
  "engine-unavailable",
  "scan-failed"
] as const);

export type DetectorReasonCode = (typeof DETECTOR_REASON_CODES)[number];

const DETECTOR_REASON_CODE_SET: ReadonlySet<string> = new Set(DETECTOR_REASON_CODES);

export const DETECTOR_STATUS_REASON_CODES = Object.freeze({
  partial: Object.freeze([
    "budget-unavailable",
    "evidence-cap-reached",
    "load-failed",
    "scan-failed"
  ]),
  skipped: Object.freeze([
    "probe-disabled",
    "budget-unavailable",
    "evidence-cap-reached",
    "not-requested",
    "load-failed",
    "engine-unavailable"
  ]),
  unsupported: Object.freeze(["unsupported"]),
  failed: Object.freeze(["load-failed", "engine-unavailable", "scan-failed"])
} satisfies Readonly<Record<Exclude<DetectorStatus, "complete">, readonly DetectorReasonCode[]>>);

export function isDetectorReasonCode(value: string): value is DetectorReasonCode {
  return DETECTOR_REASON_CODE_SET.has(value);
}

export function isDetectorReasonForStatus(
  status: DetectorStatus,
  reason: string
): reason is DetectorReasonCode {
  return (
    status !== "complete" &&
    (DETECTOR_STATUS_REASON_CODES[status] as readonly string[]).includes(reason)
  );
}

/**
 * Complete rows carry no reason; every non-complete row carries one known,
 * status-compatible reason. This is the structural half of accountability.
 */
export function detectorStatusReasonIsValid(entry: {
  status: DetectorStatus;
  reason?: unknown;
}): boolean {
  if (entry.status === "complete") return entry.reason === undefined;
  return (
    typeof entry.reason === "string" &&
    isDetectorReasonCode(entry.reason) &&
    isDetectorReasonForStatus(entry.status, entry.reason)
  );
}
