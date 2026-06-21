import { readFile } from "node:fs/promises";
import path from "node:path";
import { isScanReport, REPORT_ID_PATTERN } from "./report-validation";
import type { ScanReport } from "./types";

/**
 * Server/build-time report lookup shared by the report page's social metadata
 * and the generated Open Graph card. It reads the committed, public evidence
 * under `public/reports/` first (the only source available to the static
 * GitHub Pages export), then falls back to the filesystem share store when the
 * full Node app is running.
 */
export async function readReportForId(id: string, rootDir = process.cwd()): Promise<ScanReport | null> {
  const publicReport = await readPublicReport(id, rootDir);
  if (publicReport) return publicReport;

  // The static export has no filesystem share store; avoid bundling it there.
  if (process.env.NEXT_PUBLIC_SITE_BEHAVIOR_LAB_STATIC_EXPORT === "1") return null;

  try {
    const { readScanReport } = await import("./report-store");
    return await readScanReport(id);
  } catch {
    return null;
  }
}

async function readPublicReport(id: string, rootDir: string): Promise<ScanReport | null> {
  if (!REPORT_ID_PATTERN.test(id)) return null;
  const filePath = path.join(rootDir, "public", "reports", `${id}.json`);

  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    return isScanReport(parsed) ? parsed : null;
  } catch (error) {
    if (isFileMissing(error) || error instanceof SyntaxError) return null;
    throw error;
  }
}

function isFileMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT");
}
