import { randomBytes } from "node:crypto";
import { readManagedReport } from "./managed-report-reader";
import { buildProvenanceEntry } from "./redaction-provenance";
import { redactScanReportV1 } from "./redact-scan-report-v1";
import { buildReportShare } from "./report-locator";
import {
  resolveReportStoreBackend,
  type ReportRetentionMetadata,
  type ReportStoreBackendStatus,
  type StoredReportEntry
} from "./report-store-backend";
import { REPORT_ID_PATTERN } from "./report-validation";
import type { ReadStoredScanReportError, StoredScanReport } from "./scan-report-reader";
import type { ReportShare, ScanReport } from "./types";

const DEFAULT_REPORT_MAX_AGE_DAYS = 7;
const DEFAULT_REPORT_MAX_COUNT = 500;
const REPORT_MAX_AGE_DAYS_ENV = "SITE_BEHAVIOR_LAB_REPORT_MAX_AGE_DAYS";
const REPORT_MAX_COUNT_ENV = "SITE_BEHAVIOR_LAB_REPORT_MAX_COUNT";

export type ReportStoreStatus = ReportStoreBackendStatus & {
  maxAgeDays: number;
  maxCount: number;
};

export async function saveScanReport<T extends ScanReport>(report: T, options: { shareId?: string } = {}): Promise<T> {
  const share = createReportShare(options.shareId);
  // Idempotently enforce the current public sanitizer at the persistence
  // boundary even when the producer already applied it. Only those exact
  // sanitized bytes may receive a current-version provenance sidecar.
  const saved = redactScanReportV1(attachShare(report, share)).report;
  const publicReport = stripScreenshotsForStorage(saved);
  const now = new Date();
  const retention: ReportRetentionMetadata = {
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + reportMaxAgeMs()).toISOString()
  };
  const reportWire = `${JSON.stringify(publicReport, null, 2)}\n`;
  const sidecar = buildProvenanceEntry({
    reportId: share.id,
    publicReport,
    writtenAt: retention.createdAt,
    createdAt: retention.createdAt,
    expiresAt: retention.expiresAt
  });
  const backend = resolveReportStoreBackend();
  // Deliberately non-atomic and ordered: a crash/failure after the report PUT
  // leaves no matching sidecar, so reads fail closed rather than trusting an
  // unattested object. The share operation itself does not succeed until both
  // writes do.
  await backend.write(share.id, reportWire, retention);
  await backend.writeSidecar(share.id, `${JSON.stringify(sidecar, null, 2)}\n`);
  await pruneStoredReportsSafely(share.id);
  return saved;
}

/**
 * Typed outcome of a store read (RFC 14.8: consumers get explicit
 * unreadable/unsupported handling, never a silent null that conflates
 * "missing" with "the store holds bytes this deployment cannot read").
 * Backend failures (outage, bad credentials) still throw and must propagate.
 */
export type StoredReportReadOutcome =
  | { outcome: "found"; stored: StoredScanReport; wire: string }
  | { outcome: "not-found" }
  | { outcome: "unreadable"; error: ReadStoredScanReportError; violations?: string[] };

/**
 * The canonical store read: parses the blob and dispatches it through the
 * version-aware deep reader, so a malformed stored report (a `requests:[null]`
 * entry, a truncated write) surfaces as a typed "unreadable" instead of
 * crashing a renderer downstream. `wire` is the stored bytes; API responses
 * serve it as-is so the wire form is never re-synthesized.
 */
export async function readStoredScanReportById(id: string): Promise<StoredReportReadOutcome> {
  if (!REPORT_ID_PATTERN.test(id)) return { outcome: "not-found" };
  const backend = resolveReportStoreBackend();
  const blob = await backend.read(id);
  if (!blob) return { outcome: "not-found" };

  if (blob.retention && isExpired(blob.retention)) {
    await backend.remove(id).catch(() => undefined);
    return { outcome: "not-found" };
  }
  const managed = readManagedReport({
    reportId: id,
    reportContents: blob.contents,
    sidecarContents: await backend.readSidecar(id),
    retention: blob.retention
  });
  if (!managed.ok) {
    return {
      outcome: "unreadable",
      error: managed.error,
      ...(managed.violations ? { violations: managed.violations } : {})
    };
  }
  return { outcome: "found", stored: managed.stored, wire: managed.wire };
}

export async function pruneStoredReports(now = Date.now(), preserveId?: string): Promise<void> {
  const backend = resolveReportStoreBackend();
  const entries = await backend.list();
  const kept: StoredReportEntry[] = [];

  for (const entry of entries) {
    // Legacy/malformed objects have no trustworthy immutable clock. Never
    // fall back to LastModified: a remediation rewrite would restart it and
    // silently extend retention. Delete such runtime shares fail-closed.
    if (!entry.retention || now >= Date.parse(entry.retention.expiresAt)) {
      await backend.remove(entry.id).catch(() => undefined);
    } else {
      kept.push(entry);
    }
  }

  const maxCount = reportMaxCount();
  const preserved = preserveId ? kept.find((entry) => entry.id === preserveId) : undefined;
  const candidates = kept
    .filter((entry) => entry.id !== preserveId)
    .sort((a, b) => Date.parse(b.retention!.createdAt) - Date.parse(a.retention!.createdAt));
  const candidateLimit = preserved ? Math.max(0, maxCount - 1) : maxCount;
  await Promise.all(candidates.slice(candidateLimit).map((entry) => backend.remove(entry.id).catch(() => undefined)));
}

export function reportStoreStatus(): ReportStoreStatus {
  return {
    ...resolveReportStoreBackend().status(),
    maxAgeDays: reportMaxAgeDays(),
    maxCount: reportMaxCount()
  };
}

function attachShare<T extends ScanReport>(report: T, share: ReportShare): T {
  return {
    ...report,
    share
  };
}

function stripScreenshotsForStorage(report: ScanReport): ScanReport {
  if (report.reportType === "comparison") {
    return {
      ...report,
      baseline: { ...report.baseline, screenshot: null },
      variant: { ...report.variant, screenshot: null }
    };
  }

  return {
    ...report,
    screenshot: null
  };
}

function createReportShare(id = `${dateSlug(new Date())}-${randomBytes(16).toString("hex")}`): ReportShare {
  return buildReportShare(id);
}

function dateSlug(date: Date): string {
  return date.toISOString().slice(0, 10).replaceAll("-", "");
}

async function pruneStoredReportsSafely(preserveId: string): Promise<void> {
  try {
    await pruneStoredReports(Date.now(), preserveId);
  } catch (error) {
    console.warn("Failed to prune stored reports.", error);
  }
}

function isExpired(retention: ReportRetentionMetadata): boolean {
  return Date.now() >= Date.parse(retention.expiresAt);
}

function reportMaxAgeMs(): number {
  return reportMaxAgeDays() * 24 * 60 * 60 * 1_000;
}

function reportMaxAgeDays(): number {
  return positiveNumberFromEnv(REPORT_MAX_AGE_DAYS_ENV, DEFAULT_REPORT_MAX_AGE_DAYS);
}

function reportMaxCount(): number {
  return Math.max(1, Math.floor(positiveNumberFromEnv(REPORT_MAX_COUNT_ENV, DEFAULT_REPORT_MAX_COUNT)));
}

function positiveNumberFromEnv(name: string, fallback: number): number {
  const value = Number(process.env[name] || "");
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
