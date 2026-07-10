import { randomBytes } from "node:crypto";
import { buildReportShare } from "./report-locator";
import {
  resolveReportStoreBackend,
  type ReportStoreBackendStatus,
  type StoredReportEntry
} from "./report-store-backend";
import { REPORT_ID_PATTERN } from "./report-validation";
import {
  readStoredScanReport,
  type ReadStoredScanReportError,
  type StoredScanReport
} from "./scan-report-reader";
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
  const saved = attachShare(report, share);
  const backend = resolveReportStoreBackend();
  await backend.write(share.id, `${JSON.stringify(stripScreenshotsForStorage(saved), null, 2)}\n`);
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

  if (isExpired(blob.lastModifiedMs)) {
    await backend.remove(id).catch(() => undefined);
    return { outcome: "not-found" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(blob.contents) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) return { outcome: "unreadable", error: "invalid" };
    throw error;
  }

  const read = readStoredScanReport(parsed);
  if (!read.ok) {
    return { outcome: "unreadable", error: read.error, ...(read.violations ? { violations: read.violations } : {}) };
  }
  return { outcome: "found", stored: read.stored, wire: blob.contents };
}

/**
 * v1-narrowing wrapper for the render surfaces that still consume the legacy
 * wire type directly (report page metadata, OG images, corpus loader). They
 * treat every non-v1 outcome as absent; the typed accessor above is the
 * primary path and the one API routes use to report unreadable/unsupported
 * outcomes honestly.
 */
export async function readScanReport(id: string): Promise<ScanReport | null> {
  const result = await readStoredScanReportById(id);
  return result.outcome === "found" && result.stored.schemaVersion === 1 ? result.stored.report : null;
}

export async function pruneStoredReports(now = Date.now(), preserveId?: string): Promise<void> {
  const backend = resolveReportStoreBackend();
  const entries = await backend.list();
  const maxAgeMs = reportMaxAgeMs();
  const kept: StoredReportEntry[] = [];

  for (const entry of entries) {
    if (maxAgeMs > 0 && now - entry.lastModifiedMs > maxAgeMs) {
      await backend.remove(entry.id).catch(() => undefined);
    } else {
      kept.push(entry);
    }
  }

  const maxCount = reportMaxCount();
  const preserved = preserveId ? kept.find((entry) => entry.id === preserveId) : undefined;
  const candidates = kept.filter((entry) => entry.id !== preserveId).sort((a, b) => b.lastModifiedMs - a.lastModifiedMs);
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

function isExpired(lastModifiedMs: number): boolean {
  const maxAgeMs = reportMaxAgeMs();
  if (maxAgeMs <= 0) return false;
  return Date.now() - lastModifiedMs > maxAgeMs;
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
