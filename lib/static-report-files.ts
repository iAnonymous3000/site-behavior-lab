import { access, readFile, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import { readManagedReport, type ManagedReportReadFailureReason } from "./managed-report-reader";
import {
  committedSidecarFilename,
  isProvenanceEntry,
  type RedactionProvenanceEntry
} from "./redaction-provenance";
import { REPORT_ID_PATTERN } from "./report-validation";
import type { ReadStoredScanReportError, StoredScanReport } from "./scan-report-reader";

const STATIC_REPORT_FILE_PATTERN = /^([0-9]{8}-[0-9a-f]{32})\.json$/;
const STATIC_SIDECAR_FILE_PATTERN = /^([0-9]{8}-[0-9a-f]{32})\.provenance\.json$/;

export class StaticReportBundleError extends Error {
  constructor(
    readonly reportId: string,
    readonly reason: string
  ) {
    super(`Static report ${reportId} is not a valid managed bundle (${reason}).`);
    this.name = "StaticReportBundleError";
  }
}

export async function listStaticReportIds(rootDir = process.cwd()): Promise<string[]> {
  const reportsDir = path.join(rootDir, "public", "reports");
  const dangling = await listDanglingStaticSidecarIds(reportsDir);
  if (dangling.length > 0) throw new StaticReportBundleError(dangling[0], "dangling-sidecar");

  const readable: string[] = [];
  for (const id of await listStaticReportCandidateIds(reportsDir)) {
    const read = await readStaticReportBundle(reportsDir, id);
    if (read.outcome !== "found") {
      throw new StaticReportBundleError(id, read.outcome === "not-found" ? "missing-report" : read.reason);
    }
    readable.push(id);
  }
  return readable;
}

/** Report ids named like committed reports, before managed-sidecar validation. */
export async function listStaticReportCandidateIds(reportsDir: string): Promise<string[]> {
  const entries = await readStaticDirectoryEntries(reportsDir);

  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => STATIC_REPORT_FILE_PATTERN.exec(entry.name)?.[1] ?? null)
    .filter((id): id is string => Boolean(id))
    .sort();
}

export async function listDanglingStaticSidecarIds(reportsDir: string): Promise<string[]> {
  const entries = await readStaticDirectoryEntries(reportsDir);
  const reports = new Set(
    entries
      .filter((entry) => entry.isFile())
      .map((entry) => STATIC_REPORT_FILE_PATTERN.exec(entry.name)?.[1] ?? null)
      .filter((id): id is string => Boolean(id))
  );
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => STATIC_SIDECAR_FILE_PATTERN.exec(entry.name)?.[1] ?? null)
    .filter((id): id is string => id !== null && !reports.has(id))
    .sort();
}

export type StaticReportBundleReadResult =
  | {
      outcome: "found";
      id: string;
      stored: StoredScanReport;
      wire: string;
      provenance: RedactionProvenanceEntry;
    }
  | { outcome: "not-found" }
  | {
      outcome: "unreadable";
      error: ReadStoredScanReportError;
      reason: ManagedReportReadFailureReason;
      violations?: string[];
    };

/**
 * Read a committed report as one managed report + sidecar unit. Committed
 * reports never expire, so their clock is sourced from the strictly parsed
 * sidecar and pinned to `expiresAt: null`; a runtime-style non-null expiry
 * consequently fails the managed reader's clock comparison.
 */
export async function readStaticReportBundle(
  reportsDir: string,
  id: string
): Promise<StaticReportBundleReadResult> {
  if (!REPORT_ID_PATTERN.test(id)) return { outcome: "not-found" };

  const reportContents = await readOptionalFile(path.join(reportsDir, `${id}.json`));
  if (reportContents === null) return { outcome: "not-found" };

  const sidecarContents = await readOptionalFile(path.join(reportsDir, committedSidecarFilename(id)));
  let parsedSidecar: unknown;
  if (sidecarContents !== null) {
    try {
      parsedSidecar = JSON.parse(sidecarContents) as unknown;
    } catch {
      // The managed reader owns the named invalid-sidecar-json outcome.
    }
  }

  const retention = isProvenanceEntry(parsedSidecar)
    ? { createdAt: parsedSidecar.createdAt, expiresAt: null }
    : null;
  const managed = readManagedReport({ reportId: id, reportContents, sidecarContents, retention });
  if (!managed.ok) {
    return {
      outcome: "unreadable",
      error: managed.error,
      reason: managed.reason,
      ...(managed.violations ? { violations: managed.violations } : {})
    };
  }

  return {
    outcome: "found",
    id,
    stored: managed.stored,
    wire: managed.wire,
    provenance: managed.provenance
  };
}

/** Sidecar first, report second; both absences are verified before success. */
export async function removeStaticReportBundle(reportsDir: string, id: string): Promise<void> {
  if (!REPORT_ID_PATTERN.test(id)) throw new Error(`Invalid static report id: ${id}`);
  const files = [
    path.join(reportsDir, committedSidecarFilename(id)),
    path.join(reportsDir, `${id}.json`)
  ];
  let firstError: unknown;

  for (const file of files) {
    try {
      await unlink(file);
    } catch (error) {
      if (!isErrno(error, "ENOENT") && firstError === undefined) firstError = error;
    }
  }
  for (const file of files) {
    try {
      await access(file);
      firstError ??= new Error(`Static report deletion was not durable: ${file}`);
    } catch (error) {
      if (!isErrno(error, "ENOENT") && firstError === undefined) firstError = error;
    }
  }
  if (firstError !== undefined) throw firstError;
}

async function readOptionalFile(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (isErrno(error, "ENOENT")) return null;
    throw error;
  }
}

async function readStaticDirectoryEntries(reportsDir: string) {
  try {
    return await readdir(reportsDir, { withFileTypes: true });
  } catch (error) {
    if (isErrno(error, "ENOENT")) return [];
    throw error;
  }
}

function isErrno(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === code);
}
