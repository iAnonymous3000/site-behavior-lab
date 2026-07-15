import { randomBytes } from "node:crypto";
import { readManagedReport } from "./managed-report-reader";
import { buildProvenanceEntry } from "./redaction-provenance";
import { redactScanReportV1 } from "./redact-scan-report-v1";
import { buildReportShare } from "./report-locator";
import type { RuntimeScanReport } from "./runtime-scan-report";
import { NODE_SCAN_REPORT_V2_R2_MAX_PUBLIC_BYTES } from "./scan-report-v2-r2-limits";
import { toPublicScanReportR2 } from "./scan-report-v2-r2-projection";
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
const DEFAULT_REPORT_MIN_SURVIVAL_MS = 60_000;
const MAX_REPORT_MIN_SURVIVAL_MS = 5 * 60_000;
const REPORT_MAX_AGE_DAYS_ENV = "SITE_BEHAVIOR_LAB_REPORT_MAX_AGE_DAYS";
const REPORT_MAX_COUNT_ENV = "SITE_BEHAVIOR_LAB_REPORT_MAX_COUNT";
const REPORT_MIN_SURVIVAL_MS_ENV = "SITE_BEHAVIOR_LAB_REPORT_MIN_SURVIVAL_MS";

// Report creation is a three-object bundle on the filesystem and a two-object
// bundle in R2. Keep local mutations in one FIFO. Across processes, backends
// expose the provenance sidecar as the bundle's commit marker, so count-based
// pruning ignores a report still between its report and sidecar writes.
let reportStoreMutationTail: Promise<void> = Promise.resolve();
const PARTIAL_SAVE_CLEANUP_ATTEMPTS = 2;

export type ReportStoreStatus = ReportStoreBackendStatus & {
  maxAgeDays: number;
  maxCount: number;
};

export async function saveScanReport<T extends RuntimeScanReport>(
  report: T,
  options: { shareId?: string } = {}
): Promise<T> {
  const share = createReportShare(options.shareId);
  const runtimeReport: RuntimeScanReport = report;
  let saved: RuntimeScanReport;
  let publicReport: ScanReport | ReturnType<typeof toPublicScanReportR2>;
  if (runtimeReport.schemaVersion === 1) {
    // Idempotently enforce the frozen v1 public sanitizer at the persistence
    // boundary even when the producer already applied it.
    const sanitized = redactScanReportV1(attachShare(runtimeReport, share)).report;
    saved = sanitized;
    publicReport = stripScreenshotsForStorage(sanitized);
  } else {
    // r2 was already sanitized and semantically gated by its builder. Attach
    // the share to the immediate shell, then use the named-field projector as
    // the only persistence path; it strips the entire ephemeral screenshot
    // block by construction.
    saved = attachShare(runtimeReport, share);
    publicReport = toPublicScanReportR2(saved);
  }
  const now = new Date();
  const retention: ReportRetentionMetadata = {
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + reportMaxAgeMs()).toISOString()
  };
  const reportWire = `${JSON.stringify(publicReport, null, 2)}\n`;
  if (
    runtimeReport.schemaVersion === 2 &&
    Buffer.byteLength(reportWire, "utf8") > NODE_SCAN_REPORT_V2_R2_MAX_PUBLIC_BYTES
  ) {
    throw new Error(
      `Refusing to persist a ScanReport v2/r2 larger than ${NODE_SCAN_REPORT_V2_R2_MAX_PUBLIC_BYTES} public bytes after attaching its share.`
    );
  }
  const sidecar = buildProvenanceEntry({
    reportId: share.id,
    publicReport,
    writtenAt: retention.createdAt,
    createdAt: retention.createdAt,
    expiresAt: retention.expiresAt
  });
  const sidecarWire = `${JSON.stringify(sidecar, null, 2)}\n`;
  // Validate the exact bundle before the first externally visible write. This
  // also pins every embedded r2 run to the sidecar's current redactionVersion.
  const managed = readManagedReport({
    reportId: share.id,
    reportContents: reportWire,
    sidecarContents: sidecarWire,
    retention
  });
  if (!managed.ok) {
    throw new Error(`Refusing to persist an unreadable managed report (${managed.reason}).`);
  }
  const backend = resolveReportStoreBackend();
  await withReportStoreMutationLock(async () => {
    // Deliberately non-atomic and ordered: a crash/failure after the report PUT
    // leaves no matching sidecar, so reads fail closed rather than trusting an
    // unattested object. The local mutation lock prevents another in-process
    // save/prune from mistaking this deliberately partial interval for an old
    // bundle. The share operation itself does not succeed until both writes do.
    let reportCertainlyCreatedByThisSave = false;
    try {
      const write = await backend.write(share.id, reportWire, retention);
      reportCertainlyCreatedByThisSave = write.ownership === "certain";
      await backend.writeSidecar(share.id, sidecarWire);
    } catch (error) {
      // Only the backend's certain create result proves ownership. A fulfilled
      // ambiguous R2 replay may instead have read back an identical concurrent
      // writer's object; cleanup could delete that writer's delayed bundle.
      // Once ownership is certain, make a small bounded number of idempotent
      // attempts to remove every partial bundle object.
      if (reportCertainlyCreatedByThisSave) {
        await cleanupOwnedPartialBundle(backend, share.id);
      }
      throw error;
    }
    await pruneStoredReportsSafely(backend);
    await assertSavedBundleSurvived(backend, share.id, reportWire, sidecarWire, retention);
  });
  return saved as T;
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

export function pruneStoredReports(now = Date.now()): Promise<void> {
  return withReportStoreMutationLock(() => pruneStoredReportsUnlocked(resolveReportStoreBackend(), now));
}

async function pruneStoredReportsUnlocked(
  backend: ReturnType<typeof resolveReportStoreBackend>,
  now: number
): Promise<void> {
  const entries = await backend.list();
  const kept: StoredReportEntry[] = [];

  for (const entry of entries) {
    if (!entry.reportPresent) {
      // The create protocol always writes the report before its sidecar, so a
      // listed sidecar without a report is a deletion orphan, not an in-flight
      // save. Remove only the sidecar: a new report may have appeared after
      // the listing snapshot and must not be deleted by stale reconciliation.
      if (entry.sidecarPresent) {
        await backend.removeSidecar(entry.id).catch(() => undefined);
      }
      continue;
    }
    if (!entry.committed) {
      // Another process may be between the create-only report and sidecar
      // writes. LastModified cannot distinguish a crashed save from a delayed
      // cross-process write, so it is never an age-based cleanup clock. Once a
      // valid immutable expiresAt is reached, however, even a writer that later
      // commits would be publishing an already-expired share and removal is safe.
      if (entry.retention && now >= Date.parse(entry.retention.expiresAt)) {
        await backend.remove(entry.id).catch(() => undefined);
      }
      continue;
    }
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
  // Every concurrent pruner must choose the same winners. Per-save
  // "preserveId" sets let two maxCount=1 saves preserve themselves and delete
  // each other; immutable creation time plus ID gives all processes one total
  // order instead.
  const ordered = kept.sort(
    (a, b) =>
      Date.parse(b.retention!.createdAt) - Date.parse(a.retention!.createdAt) ||
      b.id.localeCompare(a.id)
  );
  const minimumSurvivalMs = reportMinimumSurvivalMs();
  const removable = ordered
    .slice(maxCount)
    .filter((entry) => now - Date.parse(entry.retention!.createdAt) >= minimumSurvivalMs);
  await Promise.all(removable.map((entry) => backend.remove(entry.id).catch(() => undefined)));
}

export function reportStoreStatus(): ReportStoreStatus {
  return {
    ...resolveReportStoreBackend().status(),
    maxAgeDays: reportMaxAgeDays(),
    maxCount: reportMaxCount()
  };
}

/** Construct the configured backend without performing IO; throws on bad config. */
export function assertReportStoreAvailable(): void {
  resolveReportStoreBackend();
}

function attachShare<T extends RuntimeScanReport>(report: T, share: ReportShare): T {
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

async function pruneStoredReportsSafely(backend: ReturnType<typeof resolveReportStoreBackend>): Promise<void> {
  try {
    await pruneStoredReportsUnlocked(backend, Date.now());
  } catch (error) {
    console.warn("Failed to prune stored reports.", error);
  }
}

async function cleanupOwnedPartialBundle(
  backend: ReturnType<typeof resolveReportStoreBackend>,
  id: string
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < PARTIAL_SAVE_CLEANUP_ATTEMPTS; attempt += 1) {
    try {
      await backend.remove(id);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  console.warn("Failed to clean up a partially saved report bundle after bounded retries.", lastError);
}

async function assertSavedBundleSurvived(
  backend: ReturnType<typeof resolveReportStoreBackend>,
  id: string,
  reportContents: string,
  sidecarContents: string,
  retention: ReportRetentionMetadata
): Promise<void> {
  const stored = await backend.read(id);
  const storedSidecar = await backend.readSidecar(id);
  if (
    !stored ||
    stored.contents !== reportContents ||
    storedSidecar !== sidecarContents ||
    stored.retention?.createdAt !== retention.createdAt ||
    stored.retention.expiresAt !== retention.expiresAt
  ) {
    throw new Error("Saved report bundle did not survive retention pruning as a readable committed share.");
  }
  const managed = readManagedReport({
    reportId: id,
    reportContents: stored.contents,
    sidecarContents: storedSidecar,
    retention: stored.retention
  });
  if (!managed.ok) {
    throw new Error("Saved report bundle did not survive retention pruning as a readable committed share.");
  }
}

function withReportStoreMutationLock<T>(operation: () => Promise<T>): Promise<T> {
  const result = reportStoreMutationTail.then(operation, operation);
  reportStoreMutationTail = result.then(
    () => undefined,
    () => undefined
  );
  return result;
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

function reportMinimumSurvivalMs(): number {
  const raw = process.env[REPORT_MIN_SURVIVAL_MS_ENV]?.trim();
  if (raw === undefined || raw === "") return DEFAULT_REPORT_MIN_SURVIVAL_MS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return DEFAULT_REPORT_MIN_SURVIVAL_MS;
  return Math.min(Math.floor(value), MAX_REPORT_MIN_SURVIVAL_MS);
}

function positiveNumberFromEnv(name: string, fallback: number): number {
  const value = Number(process.env[name] || "");
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
