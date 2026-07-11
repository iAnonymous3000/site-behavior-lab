import { readFile } from "node:fs/promises";
import path from "node:path";
import { REPORT_ID_PATTERN } from "./report-validation";
import {
  readStoredScanReport,
  type ReadStoredScanReportError,
  type StoredScanReport
} from "./scan-report-reader";
import type { ScanReport } from "./types";

/**
 * Server/build-time report lookup shared by the report page, its social
 * metadata, the generated Open Graph card, and the report API route. It reads
 * the committed, public evidence under `public/reports/` first (the only
 * source available to the static GitHub Pages export), then falls back to the
 * runtime share store when the full Node app is running.
 *
 * Every path goes through the version-aware deep reader (RFC 14.8), so a
 * malformed or newer-schema report is a typed "unreadable" outcome the caller
 * must handle, never a silent null that reads as "not found".
 */
export type ReportSourceReadResult =
  | { outcome: "found"; stored: StoredScanReport; wire: string; origin: "committed" | "share-store" }
  | { outcome: "not-found" }
  | { outcome: "unreadable"; error: ReadStoredScanReportError; violations?: string[] };

export async function readStoredReportForId(id: string, rootDir = process.cwd()): Promise<ReportSourceReadResult> {
  const committed = await readCommittedReport(id, rootDir);
  if (committed) return committed;

  // The static export has no filesystem share store; avoid bundling it there.
  if (process.env.NEXT_PUBLIC_SITE_BEHAVIOR_LAB_STATIC_EXPORT === "1") return { outcome: "not-found" };

  // readStoredScanReportById answers typed outcomes for missing/expired/
  // malformed reports. A thrown backend failure (store outage, bad
  // credentials) must PROPAGATE: swallowing it here turned an unavailable
  // store into a false "not found" for every report it holds.
  const { readStoredScanReportById } = await import("./report-store");
  const stored = await readStoredScanReportById(id);
  return stored.outcome === "found" ? { ...stored, origin: "share-store" } : stored;
}

/**
 * v1-narrowing wrapper for the one surface still consuming the legacy wire
 * type directly (the sitemap). It treats every non-v1 outcome as absent and
 * skips the entry; surfaces that must answer honestly for unreadable reports
 * (the report page, the API route) or that render from the view (metadata,
 * OG images, corpus loader) use {@link readStoredReportForId} instead.
 */
export async function readReportForId(id: string, rootDir = process.cwd()): Promise<ScanReport | null> {
  const result = await readStoredReportForId(id, rootDir);
  return result.outcome === "found" && result.stored.schemaVersion === 1 ? result.stored.report : null;
}

async function readCommittedReport(id: string, rootDir: string): Promise<ReportSourceReadResult | null> {
  if (!REPORT_ID_PATTERN.test(id)) return null;
  const filePath = path.join(rootDir, "public", "reports", `${id}.json`);

  let contents: string;
  try {
    contents = await readFile(filePath, "utf8");
  } catch (error) {
    if (isFileMissing(error)) return null;
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) return { outcome: "unreadable", error: "invalid" };
    throw error;
  }

  const read = readStoredScanReport(parsed);
  if (!read.ok) {
    return { outcome: "unreadable", error: read.error, ...(read.violations ? { violations: read.violations } : {}) };
  }
  return { outcome: "found", stored: read.stored, wire: contents, origin: "committed" };
}

function isFileMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT");
}
