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
  /** null for v1 (no v2 revision applies). */
  revision: 1 | 2 | null;
  /**
   * RFC 15.7: v1 and v2 r1 reports are limited/descriptive; their
   * intervention-attributed and causal surfaces are suppressed (r1 lacks the
   * structured facts for authoritative verification). Only r2 views may
   * render causal framing.
   */
  limited: boolean;
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
      revision: null,
      limited: true,
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
    revision: null,
    limited: true,
    reportType: "single",
    domain: report.summary.firstPartyDomain,
    scannedAt: report.conditions.scannedAt,
    runs: [runViewFromV1(report, null, report.conditions.scannedAt)],
    comparison: null
  };
}

function viewFromV2(report: PublicScanReportV2 | PublicScanReportV2R2, revision: 1 | 2): ReportView {
  // RFC 15.7: r1 reports stay readable but limited/descriptive; the
  // intervention-attributed surface (interventionVerified) is suppressed and
  // may never be re-derived from asserted r1 strings.
  const limited = revision === 1;
  if (report.reportType === "comparison") {
    return {
      origin: "v2",
      revision,
      limited,
      reportType: "comparison",
      domain: report.baseline.subject.observed.registrableDomain,
      scannedAt: report.baseline.startedAt,
      runs: [runViewFromV2(report.baseline, "baseline"), runViewFromV2(report.variant, "variant")],
      comparison: {
        kind: report.experiment.kind,
        axis: report.experiment.kind === "intervention" ? report.experiment.axis : null,
        interventionVerified: limited ? null : report.comparability.interventionVerified ?? null,
        familiesEligible: Object.fromEntries(
          Object.entries(report.comparability.perMetric).map(([family, entry]) => [family, entry.eligible])
        ) as Record<MetricFamily, boolean>
      }
    };
  }
  return {
    origin: "v2",
    revision,
    limited,
    reportType: "single",
    domain: report.run.subject.observed.registrableDomain,
    scannedAt: report.run.startedAt,
    runs: [runViewFromV2(report.run, null)],
    comparison: null
  };
}

export function toReportView(stored: StoredScanReport): ReportView {
  if (stored.schemaVersion === 1) return viewFromV1(stored.report);
  return viewFromV2(stored.report, stored.schemaRevision);
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
