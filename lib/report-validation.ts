import { SCAN_REPORT_SCHEMA_VERSION, type ComparisonScanResult, type ReportShare, type ScanReport, type ScanResult } from "./types";
import { isRecord } from "./guards";
import { isFingerprintDetectionSummary } from "./fingerprint-detection-guard";

export const REPORT_ID_PATTERN = /^[0-9]{8}-[0-9a-f]{32}$/;
const COMPARISON_TYPES = new Set(["gpc", "shields", "temporal", "custom"]);

export function isScanReport(value: unknown): value is ScanReport {
  if (!isRecord(value) || value.ok !== true || value.schemaVersion !== SCAN_REPORT_SCHEMA_VERSION || !Array.isArray(value.warnings)) {
    return false;
  }
  if (value.reportType === "comparison") return isComparisonScanReport(value);
  return isSingleScanResult(value);
}

function isSingleScanResult(value: unknown): value is ScanResult {
  if (!isRecord(value) || value.ok !== true) return false;

  return (
    value.schemaVersion === SCAN_REPORT_SCHEMA_VERSION &&
    (value.reportType === undefined || value.reportType === "single") &&
    isRecord(value.summary) &&
    isRecord(value.conditions) &&
    typeof value.conditions.requestedUrl === "string" &&
    typeof value.conditions.finalUrl === "string" &&
    typeof value.conditions.scannedAt === "string" &&
    Array.isArray(value.requests) &&
    Array.isArray(value.domains) &&
    Array.isArray(value.cookies) &&
    Array.isArray(value.storage) &&
    Array.isArray(value.fingerprintEvents) &&
    (value.fingerprintDetections === undefined ||
      (Array.isArray(value.fingerprintDetections) && value.fingerprintDetections.every(isFingerprintDetectionSummary))) &&
    (value.cnameCloaks === undefined ||
      (Array.isArray(value.cnameCloaks) && value.cnameCloaks.every(isCnameCloak))) &&
    (value.screenshot === null || typeof value.screenshot === "string") &&
    Array.isArray(value.warnings) &&
    (value.share === undefined || isReportShare(value.share))
  );
}

function isComparisonScanReport(value: unknown): value is ComparisonScanResult {
  if (!isRecord(value)) return false;

  return (
    value.ok === true &&
    value.schemaVersion === SCAN_REPORT_SCHEMA_VERSION &&
    value.reportType === "comparison" &&
    typeof value.comparisonType === "string" &&
    COMPARISON_TYPES.has(value.comparisonType) &&
    typeof value.title === "string" &&
    (value.runLabels === undefined || isComparisonRunLabels(value.runLabels)) &&
    typeof value.requestedUrl === "string" &&
    typeof value.scannedAt === "string" &&
    (value.device === "desktop" || value.device === "mobile") &&
    isSingleScanResult(value.baseline) &&
    isSingleScanResult(value.variant) &&
    isRecord(value.diff) &&
    Array.isArray(value.warnings) &&
    (value.share === undefined || isReportShare(value.share))
  );
}

function isComparisonRunLabels(value: unknown): boolean {
  return isRecord(value) && typeof value.baseline === "string" && typeof value.variant === "string";
}

function isCnameCloak(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.host === "string" &&
    typeof value.cname === "string" &&
    isRecord(value.tracker) &&
    typeof value.tracker.domain === "string" &&
    typeof value.tracker.entity === "string" &&
    typeof value.tracker.category === "string"
  );
}

function isReportShare(value: unknown): value is ReportShare {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    REPORT_ID_PATTERN.test(value.id) &&
    typeof value.path === "string" &&
    typeof value.jsonPath === "string"
  );
}

// Fingerprint-detection validation lives in ./fingerprint-detection-guard (shared
// with the in-page observer) so the two no longer drift in strictness.
