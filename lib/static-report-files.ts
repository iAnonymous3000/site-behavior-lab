import { readdir } from "node:fs/promises";
import path from "node:path";

const STATIC_REPORT_FILE_PATTERN = /^([0-9]{8}-[0-9a-f]{32})\.json$/;

export async function listStaticReportIds(rootDir = process.cwd()): Promise<string[]> {
  const reportsDir = path.join(rootDir, "public", "reports");

  let entries;
  try {
    entries = await readdir(reportsDir, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => STATIC_REPORT_FILE_PATTERN.exec(entry.name)?.[1] ?? null)
    .filter((id): id is string => Boolean(id))
    .sort();
}
