/**
 * The consumer seam over both wire generations (docs/scan-report-v2-rfc.md,
 * 10.1 and 14 step 3). Consumers migrate onto these views instead of touching
 * wire shapes directly; v1-derived facts are marked "legacy-derived" and never
 * presented as recorded v2 fact.
 *
 * JSON download rule: serialize LoadedReport.wire (the original public wire
 * report), never a view. For an ephemeral result the downloadable/persistable
 * form is LoadedReport.public (the projection), never the ephemeral shell.
 */
import { isRecord } from "./guards";
import type { ScanReport, ScanResult } from "./types";
import {
  type EphemeralScanReport,
  type InterventionAxis,
  type MetricFamily,
  type PublicScanReportV2,
  type ScanRunV2
} from "./scan-report-v2";
import { isPublicScanReportV2 } from "./scan-report-v2-validation";
import { scanReportV2SemanticViolations } from "./scan-report-v2-evaluators";
import { toPublicScanReport } from "./scan-report-projection";
import {
  readStoredScanReport,
  type ReadStoredScanReportError,
  type StoredScanReport
} from "./scan-report-reader";

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export type RunView = {
  /** null for a single report's only run. */
  label: "baseline" | "variant" | null;
  domain: string;
  startedAt: string | null;
  status: number | null;
  counts: {
    totalRequests: number;
    thirdPartyRequests: number;
    knownTrackerRequests: number;
    thirdPartyCookies: number;
    shieldsBlockedRequests: number | null;
  };
};

export type ComparisonView = {
  kind: "intervention" | "temporal" | "descriptive";
  axis: InterventionAxis | null;
  /** null = unknown (legacy reports never recorded verification). */
  interventionVerified: boolean | null;
  /** null = unknown (legacy reports predate per-metric eligibility). */
  familiesEligible: Record<MetricFamily, boolean> | null;
};

export type ReportView = {
  origin: "v2" | "legacy-derived";
  reportType: "single" | "comparison";
  domain: string;
  scannedAt: string | null;
  runs: RunView[];
  comparison: ComparisonView | null;
};

function runViewFromV2(run: ScanRunV2, label: RunView["label"]): RunView {
  return {
    label,
    domain: run.subject.observed.registrableDomain,
    startedAt: run.startedAt,
    status: run.summary.status,
    counts: {
      totalRequests: run.summary.counts.totalRequests,
      thirdPartyRequests: run.summary.counts.thirdPartyRequests,
      knownTrackerRequests: run.summary.counts.knownTrackerRequests,
      thirdPartyCookies: run.summary.counts.thirdPartyCookies,
      shieldsBlockedRequests: run.summary.counts.shieldsBlockedRequests ?? null
    }
  };
}

function runViewFromV1(result: ScanResult, label: RunView["label"], scannedAt: string | null): RunView {
  return {
    label,
    domain: result.summary.firstPartyDomain,
    startedAt: scannedAt,
    status: result.summary.status,
    counts: {
      totalRequests: result.summary.totalRequests,
      thirdPartyRequests: result.summary.thirdPartyRequests,
      knownTrackerRequests: result.summary.knownTrackerRequests,
      thirdPartyCookies: result.summary.thirdPartyCookies,
      shieldsBlockedRequests: result.summary.shieldsBlockedRequests ?? null
    }
  };
}

/** v1 comparisonType to the v2 design vocabulary; "custom" is descriptive. */
function legacyComparisonKind(comparisonType: string): ComparisonView["kind"] {
  if (comparisonType === "gpc" || comparisonType === "shields" || comparisonType === "consent") return "intervention";
  if (comparisonType === "temporal") return "temporal";
  return "descriptive";
}

function legacyComparisonAxis(comparisonType: string): InterventionAxis | null {
  if (comparisonType === "gpc" || comparisonType === "shields" || comparisonType === "consent") return comparisonType;
  return null;
}

function viewFromV1(report: ScanReport): ReportView {
  if (report.reportType === "comparison") {
    return {
      origin: "legacy-derived",
      reportType: "comparison",
      domain: report.baseline.summary.firstPartyDomain,
      scannedAt: report.scannedAt,
      runs: [
        runViewFromV1(report.baseline, "baseline", report.baseline.conditions.scannedAt),
        runViewFromV1(report.variant, "variant", report.variant.conditions.scannedAt)
      ],
      comparison: {
        kind: legacyComparisonKind(report.comparisonType),
        axis: legacyComparisonAxis(report.comparisonType),
        interventionVerified: null,
        familiesEligible: null
      }
    };
  }
  return {
    origin: "legacy-derived",
    reportType: "single",
    domain: report.summary.firstPartyDomain,
    scannedAt: report.conditions.scannedAt,
    runs: [runViewFromV1(report, null, report.conditions.scannedAt)],
    comparison: null
  };
}

function viewFromV2(report: PublicScanReportV2): ReportView {
  if (report.reportType === "comparison") {
    return {
      origin: "v2",
      reportType: "comparison",
      domain: report.baseline.subject.observed.registrableDomain,
      scannedAt: report.baseline.startedAt,
      runs: [runViewFromV2(report.baseline, "baseline"), runViewFromV2(report.variant, "variant")],
      comparison: {
        kind: report.experiment.kind,
        axis: report.experiment.kind === "intervention" ? report.experiment.axis : null,
        interventionVerified: report.comparability.interventionVerified ?? null,
        familiesEligible: Object.fromEntries(
          Object.entries(report.comparability.perMetric).map(([family, entry]) => [family, entry.eligible])
        ) as Record<MetricFamily, boolean>
      }
    };
  }
  return {
    origin: "v2",
    reportType: "single",
    domain: report.run.subject.observed.registrableDomain,
    scannedAt: report.run.startedAt,
    runs: [runViewFromV2(report.run, null)],
    comparison: null
  };
}

export function toReportView(stored: StoredScanReport): ReportView {
  return stored.schemaVersion === 1 ? viewFromV1(stored.report) : viewFromV2(stored.report);
}

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
  | { source: "v2-ephemeral"; wire: EphemeralScanReport; public: PublicScanReportV2; view: ReportView };

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
 * v1 carries its screenshot inline on the wire (the immediate-response shape),
 * with stripping historically applied at each save site. This helper is the
 * boundary now, so it strips here too; otherwise a migrated persistence path
 * would serialize the screenshot v1's strip-on-save always removed.
 */
function stripV1Screenshots(report: ScanReport): ScanReport {
  if (report.reportType === "comparison") {
    return {
      ...report,
      baseline: { ...report.baseline, screenshot: null },
      variant: { ...report.variant, screenshot: null }
    };
  }
  return { ...report, screenshot: null };
}

/**
 * THE serialization boundary for persistence, download, and export: the
 * original public wire report, never a view, never a storage envelope, never
 * an ephemeral shell, and never an inline v1 screenshot. An ephemeral v2
 * result resolves to its projection and a v1 report is screenshot-stripped,
 * so no path through this helper can serialize a screenshot by accident.
 */
export function publicWireForExportOrPersistence(loaded: LoadedReport): ScanReport | PublicScanReportV2 {
  if (loaded.source === "v2-ephemeral") return loaded.public;
  if (loaded.source === "v1") return stripV1Screenshots(loaded.wire);
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

  // Ephemeral v2 immediate result: a public shape plus the `ephemeral` block.
  // A malformed shell must come back as unreadable, never as a thrown
  // exception from inside the projector.
  if (payload.schemaVersion === 2 && "ephemeral" in payload) {
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
      loaded: {
        source: "v2-ephemeral",
        wire: payload,
        public: projected,
        view: viewFromV2(projected)
      }
    };
  }

  const read = readStoredScanReport(payload);
  if (!read.ok) return { kind: "unreadable", error: read.error, ...(read.violations ? { violations: read.violations } : {}) };
  const loaded: LoadedReport =
    read.stored.schemaVersion === 1
      ? { source: "v1", wire: read.stored.report, view: toReportView(read.stored) }
      : { source: "v2-public", wire: read.stored.report, view: toReportView(read.stored) };
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
