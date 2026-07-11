/**
 * The consumer seam over both wire generations (docs/scan-report-v2-rfc.md,
 * 10.1 and 14 step 3). Consumers migrate onto these views instead of touching
 * wire shapes directly; v1-derived facts are marked "legacy-derived" and never
 * presented as recorded v2 fact.
 *
 * The view TYPES and builders live in lib/scan-report-views.ts (runtime-light,
 * safe for static client imports) and are re-exported here; this module adds
 * the transport reader, which pulls in the full validator set and is therefore
 * only ever loaded lazily in the browser (lib/client-report-reader.ts).
 *
 * JSON download rule: serialize LoadedReport.wire (the original public wire
 * report), never a view. For an ephemeral result the downloadable/persistable
 * form is LoadedReport.public (the projection), never the ephemeral shell.
 */
import { isRecord } from "./guards";
import type { ScanReport } from "./types";
import type { EphemeralScanReport, PublicScanReportV2 } from "./scan-report-v2";
import { isPublicScanReportV2 } from "./scan-report-v2-validation";
import { scanReportV2SemanticViolations } from "./scan-report-v2-evaluators";
import { toPublicScanReport } from "./scan-report-projection";
import { toPublicScanReportV1 } from "./scan-report-v1-projection";
import type {
  EphemeralComparisonReportR2,
  EphemeralSingleReportR2,
  PublicScanReportV2R2
} from "./scan-report-v2-r2";
import { isEphemeralScanReportR2, isPublicScanReportV2R2 } from "./scan-report-v2-r2-validation";
import { scanReportV2R2SemanticViolations } from "./scan-report-v2-r2-evaluators";
import { toPublicScanReportR2 } from "./scan-report-v2-r2-projection";
import {
  readStoredScanReport,
  type ReadStoredScanReportError
} from "./scan-report-reader";
import { toReportView, viewFromV2, type ReportView } from "./scan-report-views";

export * from "./scan-report-views";

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/**
 * A readable report with its original wire form retained. `wire` is what JSON
 * download serializes; for ephemeral results, `public` is the only persistable
 * form (the ephemeral shell never validates as public).
 */
export type LoadedReport =
  | { source: "v1"; wire: ScanReport; view: ReportView }
  | { source: "v2-public"; wire: PublicScanReportV2; view: ReportView }
  | { source: "v2-ephemeral"; wire: EphemeralScanReport; public: PublicScanReportV2; view: ReportView }
  | { source: "v2-r2-public"; wire: PublicScanReportV2R2; view: ReportView }
  | {
      source: "v2-r2-ephemeral";
      wire: EphemeralSingleReportR2 | EphemeralComparisonReportR2;
      public: PublicScanReportV2R2;
      view: ReportView;
    };

/**
 * One reader for everything a scan endpoint can return: API errors, async job
 * envelopes in every status, v1 reports, public v2 reports, and ephemeral v2
 * immediate results. Replaces the v1-era `payload.ok` sniffing (v2 roots have
 * no `ok`). Total by construction: no payload shape may throw or fall through
 * to `unreadable` when it has a meaningful job state.
 */
/** Validated polling progress: flat primitives only, never raw payload data. */
export type JobProgress = Record<string, string | number | boolean>;

const MAX_PROGRESS_ENTRIES = 16;

function sanitizeJobProgress(value: unknown): JobProgress | null {
  if (!isRecord(value)) return null;
  const entries = Object.entries(value)
    .filter((entry): entry is [string, string | number | boolean] => {
      const type = typeof entry[1];
      return type === "string" || type === "number" || type === "boolean";
    })
    .slice(0, MAX_PROGRESS_ENTRIES);
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

/**
 * THE serialization boundary for persistence, download, and export: the
 * original public wire report, never a view, never a storage envelope, never
 * an ephemeral shell, and never anything the projectors do not name. An
 * ephemeral v2 result resolves to its allowlist projection, and a v1 report
 * goes through the deep named-field v1 projector (the v1 validator tolerates
 * unknown properties, so spreading the untrusted object would carry smuggled
 * fields and inline screenshots along; the projector cannot leak what it
 * never copies).
 */
export function publicWireForExportOrPersistence(
  loaded: LoadedReport
): ScanReport | PublicScanReportV2 | PublicScanReportV2R2 {
  if (loaded.source === "v2-ephemeral" || loaded.source === "v2-r2-ephemeral") return loaded.public;
  if (loaded.source === "v1") return toPublicScanReportV1(loaded.wire);
  return loaded.wire;
}

export type ScanTransportResult =
  | { kind: "api-error"; message: string }
  | { kind: "job-pending"; status: "queued" | "running"; jobId: string; statusPath: string | null; reportId: string | null; progress: JobProgress | null }
  | { kind: "job-ended"; status: "failed" | "expired" | "cancelled"; message: string }
  | { kind: "report"; loaded: LoadedReport }
  | { kind: "unreadable"; error: ReadStoredScanReportError; violations?: string[] };

export function readScanTransportPayload(payload: unknown): ScanTransportResult {
  if (!isRecord(payload)) return { kind: "unreadable", error: "invalid" };

  if (payload.ok === false) {
    return { kind: "api-error", message: typeof payload.error === "string" ? payload.error : "Scan failed." };
  }

  // Async job envelopes (`/api/scan` 202 and `/api/scans/:id` polling).
  if (payload.status === "queued" || payload.status === "running") {
    if (typeof payload.jobId !== "string") return { kind: "unreadable", error: "invalid" };
    return {
      kind: "job-pending",
      status: payload.status,
      jobId: payload.jobId,
      statusPath: typeof payload.statusPath === "string" ? payload.statusPath : null,
      reportId: typeof payload.reportId === "string" ? payload.reportId : null,
      progress: sanitizeJobProgress(payload.progress)
    };
  }
  if (payload.status === "failed" || payload.status === "expired" || payload.status === "cancelled") {
    return {
      kind: "job-ended",
      status: payload.status,
      message: typeof payload.error === "string" ? payload.error : `Scan job ${payload.status}.`
    };
  }
  if (payload.status === "succeeded" && "report" in payload) {
    // A completed poll wraps the report; unwrap exactly one level.
    return readScanTransportPayload(payload.report);
  }

  // Ephemeral v2 immediate result: a public shape plus the `ephemeral` block,
  // dispatched by revision exactly like the stored reader. A malformed shell
  // must come back as unreadable, never as a thrown exception from inside a
  // projector.
  if (payload.schemaVersion === 2 && "ephemeral" in payload) {
    if (payload.schemaRevision === 1) {
      if (!isEphemeralShell(payload)) return { kind: "unreadable", error: "invalid" };
      let projected: PublicScanReportV2;
      try {
        projected = toPublicScanReport(payload);
      } catch {
        return { kind: "unreadable", error: "invalid" };
      }
      if (!isPublicScanReportV2(projected)) return { kind: "unreadable", error: "invalid" };
      const violations = scanReportV2SemanticViolations(projected);
      if (violations.length > 0) return { kind: "unreadable", error: "inconsistent", violations };
      return {
        kind: "report",
        loaded: { source: "v2-ephemeral", wire: payload, public: projected, view: viewFromV2(projected, 1) }
      };
    }
    if (payload.schemaRevision === 2) {
      if (!isEphemeralScanReportR2(payload)) return { kind: "unreadable", error: "invalid" };
      let projected: PublicScanReportV2R2;
      try {
        projected = toPublicScanReportR2(payload);
      } catch {
        return { kind: "unreadable", error: "invalid" };
      }
      if (!isPublicScanReportV2R2(projected)) return { kind: "unreadable", error: "invalid" };
      const violations = scanReportV2R2SemanticViolations(projected);
      if (violations.length > 0) return { kind: "unreadable", error: "inconsistent", violations };
      return {
        kind: "report",
        loaded: { source: "v2-r2-ephemeral", wire: payload, public: projected, view: viewFromV2(projected, 2) }
      };
    }
    return Number.isInteger(payload.schemaRevision) && (payload.schemaRevision as number) > 2
      ? { kind: "unreadable", error: "unsupported-revision" }
      : { kind: "unreadable", error: "invalid" };
  }

  const read = readStoredScanReport(payload);
  if (!read.ok) return { kind: "unreadable", error: read.error, ...(read.violations ? { violations: read.violations } : {}) };
  const view = toReportView(read.stored);
  const loaded: LoadedReport =
    read.stored.schemaVersion === 1
      ? { source: "v1", wire: read.stored.report, view }
      : read.stored.schemaRevision === 1
        ? { source: "v2-public", wire: read.stored.report, view }
        : { source: "v2-r2-public", wire: read.stored.report, view };
  return { kind: "report", loaded };
}

function isEphemeralShell(payload: Record<string, unknown>): payload is EphemeralScanReport {
  const ephemeral = payload.ephemeral;
  if (!isRecord(ephemeral)) return false;
  if (payload.reportType === "single") {
    return "screenshot" in ephemeral && (ephemeral.screenshot === null || typeof ephemeral.screenshot === "string");
  }
  if (payload.reportType === "comparison") {
    return (
      (ephemeral.baselineScreenshot === null || typeof ephemeral.baselineScreenshot === "string") &&
      (ephemeral.variantScreenshot === null || typeof ephemeral.variantScreenshot === "string")
    );
  }
  return false;
}
