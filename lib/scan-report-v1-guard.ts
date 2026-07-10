/**
 * Deep structural guard for FROZEN v1 reports, applied by the version-aware
 * reader on top of the frozen lib/report-validation.ts checks. This is the
 * security backport the freeze allows (docs/scan-report-v2-rfc.md, 11.1): the
 * frozen validator verifies the report skeleton but trusts array elements, so
 * a malformed upload ({"requests":[null]}, a cookie without a name) could
 * crash consumers that map over the evidence. This module rejects those
 * without touching the frozen files.
 *
 * v1 was never key-strict, so unknown extra fields stay tolerated here; only
 * the fields consumers actually dereference are checked.
 */
import { isRecord } from "./guards";
import type { ScanReport, ScanResult } from "./types";

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isStringArrayLoose(value: unknown): boolean {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isV1Request(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.url === "string" &&
    typeof value.domain === "string" &&
    typeof value.method === "string" &&
    typeof value.resourceType === "string" &&
    (value.status === null || isFiniteNumber(value.status)) &&
    typeof value.thirdParty === "boolean" &&
    (value.tracker === null || isRecord(value.tracker))
  );
}

function isV1Domain(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.domain === "string" &&
    isFiniteNumber(value.requests) &&
    (value.tracker === null || value.tracker === undefined || isRecord(value.tracker))
  );
}

function isV1Cookie(value: unknown): boolean {
  return isRecord(value) && typeof value.name === "string" && typeof value.domain === "string";
}

function isV1Storage(value: unknown): boolean {
  return isRecord(value) && typeof value.key === "string" && isFiniteNumber(value.valueBytes);
}

function isV1SummaryNumbersSane(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const numericFields = [
    "totalRequests",
    "thirdPartyRequests",
    "knownTrackerRequests",
    "thirdPartyDomains",
    "cookies",
    "thirdPartyCookies",
    "storageEntries",
    "fingerprintEvents"
  ];
  return (
    typeof value.firstPartyDomain === "string" &&
    (value.status === null || isFiniteNumber(value.status)) &&
    numericFields.every((field) => isFiniteNumber(value[field]))
  );
}

function deepValidateV1Result(result: ScanResult): boolean {
  const value = result as unknown as Record<string, unknown>;
  return (
    isV1SummaryNumbersSane(value.summary) &&
    Array.isArray(value.requests) &&
    value.requests.every(isV1Request) &&
    Array.isArray(value.domains) &&
    value.domains.every(isV1Domain) &&
    Array.isArray(value.cookies) &&
    value.cookies.every(isV1Cookie) &&
    Array.isArray(value.storage) &&
    value.storage.every(isV1Storage) &&
    isStringArrayLoose(value.warnings)
  );
}

export function deepValidateScanReportV1(report: ScanReport): boolean {
  if (report.reportType === "comparison") {
    return (
      typeof report.requestedUrl === "string" &&
      typeof report.scannedAt === "string" &&
      deepValidateV1Result(report.baseline) &&
      deepValidateV1Result(report.variant) &&
      isRecord(report.diff)
    );
  }
  return deepValidateV1Result(report);
}
