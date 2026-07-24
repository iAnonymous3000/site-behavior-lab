import path from "node:path";
import { REPORT_ID_PATTERN } from "./report-validation";
import type { ReadStoredScanReportError, StoredScanReport } from "./scan-report-reader";
import { readStaticReportBundle } from "./static-report-files";
import { sha256Hex } from "./sha256";

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
  | {
      outcome: "found";
      stored: StoredScanReport;
      wire: string;
      wireSha256: string;
      origin: "committed" | "share-store";
    }
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
  return stored.outcome === "found"
    ? { ...stored, wireSha256: sha256Hex(stored.wire), origin: "share-store" }
    : stored;
}

async function readCommittedReport(id: string, rootDir: string): Promise<ReportSourceReadResult | null> {
  if (!REPORT_ID_PATTERN.test(id)) return null;
  const read = await readStaticReportBundle(path.join(rootDir, "public", "reports"), id);
  if (read.outcome === "not-found") return null;
  if (read.outcome === "unreadable") {
    return {
      outcome: "unreadable",
      error: read.error,
      ...(read.violations ? { violations: read.violations } : {})
    };
  }
  return {
    outcome: "found",
    stored: read.stored,
    wire: read.wire,
    wireSha256: sha256Hex(read.wire),
    origin: "committed"
  };
}
