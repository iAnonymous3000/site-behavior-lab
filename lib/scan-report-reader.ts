/**
 * Version-aware entry point for stored scan reports (docs/scan-report-v2-rfc.md,
 * section 10.1). v1 and v2 stay distinct wire types; nothing here synthesizes a
 * v1 report into something that looks authoritatively v2.
 *
 * Revision discipline (RFC 10.2): a reader accepts exactly the revisions it was
 * built to understand. An unknown revision of a known major returns
 * "unsupported-revision"; an unknown major returns "unsupported-version". No
 * silent best-effort parse in either case.
 */
import { isRecord } from "./guards";
import { isScanReport } from "./report-validation";
import type { ScanReport } from "./types";
import {
  SCAN_REPORT_V2_SCHEMA_REVISION,
  SCAN_REPORT_V2_SCHEMA_VERSION,
  type PublicScanReportV2
} from "./scan-report-v2";
import { isPublicScanReportV2 } from "./scan-report-v2-validation";

export type StoredScanReport =
  | { schemaVersion: 1; report: ScanReport }
  | { schemaVersion: 2; report: PublicScanReportV2 };

export type ReadStoredScanReportError = "invalid" | "unsupported-version" | "unsupported-revision";

export type ReadStoredScanReportResult =
  | { ok: true; stored: StoredScanReport }
  | { ok: false; error: ReadStoredScanReportError };

const V1_SCHEMA_VERSION = 1;

export function readStoredScanReport(value: unknown): ReadStoredScanReportResult {
  if (!isRecord(value) || !Number.isInteger(value.schemaVersion)) {
    return { ok: false, error: "invalid" };
  }

  if (value.schemaVersion === V1_SCHEMA_VERSION) {
    return isScanReport(value)
      ? { ok: true, stored: { schemaVersion: 1, report: value } }
      : { ok: false, error: "invalid" };
  }

  if (value.schemaVersion === SCAN_REPORT_V2_SCHEMA_VERSION) {
    if (value.schemaRevision !== SCAN_REPORT_V2_SCHEMA_REVISION) {
      // A well-formed future revision is a capability gap, not corrupt data;
      // distinguish it so callers can message "upgrade to read this report".
      return Number.isInteger(value.schemaRevision) && (value.schemaRevision as number) > SCAN_REPORT_V2_SCHEMA_REVISION
        ? { ok: false, error: "unsupported-revision" }
        : { ok: false, error: "invalid" };
    }
    return isPublicScanReportV2(value)
      ? { ok: true, stored: { schemaVersion: 2, report: value } }
      : { ok: false, error: "invalid" };
  }

  return (value.schemaVersion as number) > SCAN_REPORT_V2_SCHEMA_VERSION
    ? { ok: false, error: "unsupported-version" }
    : { ok: false, error: "invalid" };
}
