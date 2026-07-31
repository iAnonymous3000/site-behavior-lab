import { isRecord } from "./guards";
import { REPORT_ID_PATTERN } from "./report-validation";
import type { ComparisonType, StaticReportManifest } from "./types";

export const MAX_STATIC_REPORT_MANIFEST_ENTRIES = 10_000;
const MAX_MANIFEST_TEXT_LENGTH = 4_096;

const MANIFEST_KEYS = new Set(["generatedAt", "reports"]);
const ENTRY_KEYS = new Set([
  "comparisonHistoryKey",
  "comparisonType",
  "device",
  "domain",
  "gpcEnabled",
  "headline",
  "historyKey",
  "id",
  "metrics",
  "reportType",
  "requestCapped",
  "requestEvidenceComplete",
  "reportWireBytes",
  "reportWireSha256",
  "requestedUrl",
  "scannedAt",
  "title",
  "tone"
]);
const METRIC_KEYS = new Set([
  "cookies",
  "fingerprintEvents",
  "knownTrackerRequests",
  "shieldsBlockedRequests",
  "thirdPartyCookies",
  "thirdPartyDomains",
  "thirdPartyRequests",
  "totalRequests"
]);
const COMPARISON_TYPES = new Set<ComparisonType>([
  "consent",
  "custom",
  "gpc",
  "shields",
  "temporal"
]);

/** Closed, bounded browser guard for the generated static report manifest. */
export function isStaticReportManifest(value: unknown): value is StaticReportManifest {
  if (!isRecord(value) || !hasOnlyKeys(value, MANIFEST_KEYS)) return false;
  if (!isCanonicalTimestamp(value.generatedAt) || !Array.isArray(value.reports)) return false;
  if (value.reports.length > MAX_STATIC_REPORT_MANIFEST_ENTRIES) return false;

  const reportIds = new Set<string>();
  for (const entry of value.reports) {
    if (!isStaticReportManifestEntry(entry) || reportIds.has(entry.id)) return false;
    reportIds.add(entry.id);
  }
  return true;
}

function isStaticReportManifestEntry(value: unknown): value is StaticReportManifest["reports"][number] {
  if (!isRecord(value) || !hasOnlyKeys(value, ENTRY_KEYS)) return false;
  if (
    typeof value.id !== "string" ||
    !REPORT_ID_PATTERN.test(value.id) ||
    !isPositiveCount(value.reportWireBytes) ||
    typeof value.reportWireSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.reportWireSha256) ||
    !isBoundedText(value.title, true) ||
    !isBoundedText(value.headline, true) ||
    !isBoundedText(value.domain, false) ||
    !isBoundedText(value.requestedUrl, false) ||
    !isCanonicalTimestamp(value.scannedAt) ||
    (value.tone !== "alarm" && value.tone !== "warn" && value.tone !== "info" && value.tone !== "calm") ||
    (value.reportType !== "single" && value.reportType !== "comparison") ||
    (value.device !== "desktop" && value.device !== "mobile") ||
    (value.requestCapped !== undefined && typeof value.requestCapped !== "boolean") ||
    typeof value.requestEvidenceComplete !== "boolean" ||
    (value.requestCapped === true && value.requestEvidenceComplete) ||
    !isOptionalBoundedText(value.historyKey) ||
    !isOptionalBoundedText(value.comparisonHistoryKey) ||
    !isRecord(value.metrics) ||
    !hasOnlyKeys(value.metrics, METRIC_KEYS)
  ) {
    return false;
  }

  if (value.reportType === "single") {
    if (value.comparisonType !== undefined || typeof value.gpcEnabled !== "boolean") return false;
  } else {
    if (
      value.gpcEnabled !== "comparison" ||
      (value.comparisonType !== null &&
        (typeof value.comparisonType !== "string" ||
          !COMPARISON_TYPES.has(value.comparisonType as ComparisonType)))
    ) {
      return false;
    }
  }

  for (const metric of [
    "totalRequests",
    "thirdPartyRequests",
    "knownTrackerRequests",
    "thirdPartyDomains",
    "cookies",
    "thirdPartyCookies"
  ] as const) {
    if (!isCount(value.metrics[metric])) return false;
  }
  return (
    (value.metrics.fingerprintEvents === undefined ||
      isCount(value.metrics.fingerprintEvents)) &&
    (value.metrics.shieldsBlockedRequests === undefined ||
      isCount(value.metrics.shieldsBlockedRequests))
  );
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function isBoundedText(value: unknown, allowEmpty: boolean): value is string {
  return typeof value === "string" &&
    value.length <= MAX_MANIFEST_TEXT_LENGTH &&
    (allowEmpty || value.length > 0);
}

function isOptionalBoundedText(value: unknown): value is string | undefined {
  return value === undefined || isBoundedText(value, false);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveCount(value: unknown): value is number {
  return isCount(value) && value > 0;
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 64) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}
