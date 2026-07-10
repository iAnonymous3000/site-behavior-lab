/**
 * Version-aware entry point for stored scan reports (docs/scan-report-v2-rfc.md,
 * 10.1, 14.4). v1, v2 r1, and v2 r2 stay distinct wire types; nothing here
 * synthesizes one into another.
 *
 * Revision discipline (RFC 10.2): a reader accepts exactly the revisions it was
 * built to understand, each validated against its own revision's structural
 * validator and semantic evaluator. An unknown revision of a known major
 * returns "unsupported-revision"; an unknown major returns
 * "unsupported-version". No silent best-effort parse in either case.
 */
import { isRecord } from "./guards";
import { isScanReport } from "./report-validation";
import { deepValidateScanReportV1 } from "./scan-report-v1-guard";
import type { ScanReport } from "./types";
import {
  SCAN_REPORT_V2_SCHEMA_REVISION,
  SCAN_REPORT_V2_SCHEMA_VERSION,
  type PublicScanReportV2
} from "./scan-report-v2";
import { isPublicScanReportV2 } from "./scan-report-v2-validation";
import { scanReportV2SemanticViolations } from "./scan-report-v2-evaluators";
import { SCAN_REPORT_V2_SCHEMA_REVISION_2, type PublicScanReportV2R2 } from "./scan-report-v2-r2";
import { isPublicScanReportV2R2 } from "./scan-report-v2-r2-validation";
import { scanReportV2R2SemanticViolations } from "./scan-report-v2-r2-evaluators";

export type StoredScanReport =
  | { schemaVersion: 1; report: ScanReport }
  | { schemaVersion: 2; schemaRevision: 1; report: PublicScanReportV2 }
  | { schemaVersion: 2; schemaRevision: 2; report: PublicScanReportV2R2 };

/**
 * "invalid": malformed wire data. "inconsistent": structurally valid v2 whose
 * derived blocks (quality, verification outcomes, comparability, diff)
 * disagree with a recomputation from the recorded facts; a forged conclusion,
 * not a parse problem. "unsupported-*": capability gaps, never best-effort
 * parsed.
 */
export type ReadStoredScanReportError = "invalid" | "inconsistent" | "unsupported-version" | "unsupported-revision";

export type ReadStoredScanReportResult =
  | { ok: true; stored: StoredScanReport }
  | { ok: false; error: ReadStoredScanReportError; violations?: string[] };

const V1_SCHEMA_VERSION = 1;

export function readStoredScanReport(value: unknown): ReadStoredScanReportResult {
  if (!isRecord(value) || !Number.isInteger(value.schemaVersion)) {
    return { ok: false, error: "invalid" };
  }

  if (value.schemaVersion === V1_SCHEMA_VERSION) {
    // The frozen validator plus the deep security backport: malformed uploads
    // (null request entries, cookie without a name) fail here as a typed
    // error instead of crashing a consumer downstream.
    return isScanReport(value) && deepValidateScanReportV1(value)
      ? { ok: true, stored: { schemaVersion: 1, report: value } }
      : { ok: false, error: "invalid" };
  }

  if (value.schemaVersion === SCAN_REPORT_V2_SCHEMA_VERSION) {
    if (value.schemaRevision === SCAN_REPORT_V2_SCHEMA_REVISION) {
      if (!isPublicScanReportV2(value)) return { ok: false, error: "invalid" };
      const violations = scanReportV2SemanticViolations(value);
      if (violations.length > 0) return { ok: false, error: "inconsistent", violations };
      return { ok: true, stored: { schemaVersion: 2, schemaRevision: 1, report: value } };
    }
    if (value.schemaRevision === SCAN_REPORT_V2_SCHEMA_REVISION_2) {
      if (!isPublicScanReportV2R2(value)) return { ok: false, error: "invalid" };
      const violations = scanReportV2R2SemanticViolations(value);
      if (violations.length > 0) return { ok: false, error: "inconsistent", violations };
      return { ok: true, stored: { schemaVersion: 2, schemaRevision: 2, report: value } };
    }
    // A well-formed future revision is a capability gap, not corrupt data;
    // distinguish it so callers can message "upgrade to read this report".
    return Number.isInteger(value.schemaRevision) && (value.schemaRevision as number) > SCAN_REPORT_V2_SCHEMA_REVISION_2
      ? { ok: false, error: "unsupported-revision" }
      : { ok: false, error: "invalid" };
  }

  return (value.schemaVersion as number) > SCAN_REPORT_V2_SCHEMA_VERSION
    ? { ok: false, error: "unsupported-version" }
    : { ok: false, error: "invalid" };
}
