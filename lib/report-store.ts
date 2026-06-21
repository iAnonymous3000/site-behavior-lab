import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildReportShare } from "./report-locator";
import { isScanReport, REPORT_ID_PATTERN } from "./report-validation";
import type { ReportShare, ScanReport } from "./types";

const STORED_REPORT_FILE_PATTERN = /^[0-9]{8}-[0-9a-f]{8,32}\.json$/;
const DEFAULT_REPORT_STORE_DIR = path.join(process.cwd(), ".site-behavior-lab", "reports");
const DEFAULT_REPORT_MAX_AGE_DAYS = 7;
const DEFAULT_REPORT_MAX_COUNT = 500;
const REPORT_STORE_DIR_ENV = "SITE_BEHAVIOR_LAB_REPORT_STORE_DIR";
const REPORT_MAX_AGE_DAYS_ENV = "SITE_BEHAVIOR_LAB_REPORT_MAX_AGE_DAYS";
const REPORT_MAX_COUNT_ENV = "SITE_BEHAVIOR_LAB_REPORT_MAX_COUNT";

type StoredReportFile = {
  path: string;
  mtimeMs: number;
};

export async function saveScanReport<T extends ScanReport>(report: T, options: { shareId?: string } = {}): Promise<T> {
  const share = createReportShare(options.shareId);
  const saved = attachShare(report, share);
  await mkdir(reportStoreDir(), { recursive: true });
  const savedPath = reportFilePath(share.id);
  await writeFile(savedPath, `${JSON.stringify(stripScreenshotsForStorage(saved), null, 2)}\n`, { flag: "wx" });
  await pruneStoredReportsSafely(savedPath);
  return saved;
}

export async function readScanReport(id: string): Promise<ScanReport | null> {
  if (!REPORT_ID_PATTERN.test(id)) return null;
  const filePath = reportFilePath(id);

  try {
    if (await isExpiredReport(filePath)) {
      await unlink(filePath).catch(() => undefined);
      return null;
    }

    const report = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    return isScanReport(report) ? report : null;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return null;
    }
    if (error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
}

export async function pruneStoredReports(now = Date.now(), preservePath?: string): Promise<void> {
  const files = await listStoredReportFiles();
  const maxAgeMs = reportMaxAgeMs();
  const kept: StoredReportFile[] = [];

  for (const file of files) {
    if (maxAgeMs > 0 && now - file.mtimeMs > maxAgeMs) {
      await unlink(file.path).catch(() => undefined);
    } else {
      kept.push(file);
    }
  }

  const maxCount = reportMaxCount();
  const preserved = preservePath ? kept.find((file) => file.path === preservePath) : undefined;
  const candidates = kept.filter((file) => file.path !== preservePath).sort((a, b) => b.mtimeMs - a.mtimeMs);
  const candidateLimit = preserved ? Math.max(0, maxCount - 1) : maxCount;
  await Promise.all(candidates.slice(candidateLimit).map((file) => unlink(file.path).catch(() => undefined)));
}

export function reportStoreStatus(): {
  kind: "filesystem";
  path: string;
  configuredPath: boolean;
  maxAgeDays: number;
  maxCount: number;
} {
  return {
    kind: "filesystem",
    path: reportStoreDir(),
    configuredPath: Boolean(process.env[REPORT_STORE_DIR_ENV]?.trim()),
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

function reportFilePath(id: string): string {
  return path.join(reportStoreDir(), `${id}.json`);
}

async function listStoredReportFiles(): Promise<StoredReportFile[]> {
  let entries;
  try {
    entries = await readdir(reportStoreDir(), { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const files: StoredReportFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !STORED_REPORT_FILE_PATTERN.test(entry.name)) continue;

    const filePath = path.join(reportStoreDir(), entry.name);
    try {
      const stats = await stat(filePath);
      files.push({ path: filePath, mtimeMs: stats.mtimeMs });
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
  }

  return files;
}

async function isExpiredReport(filePath: string): Promise<boolean> {
  const maxAgeMs = reportMaxAgeMs();
  if (maxAgeMs <= 0) return false;

  const stats = await stat(filePath);
  return Date.now() - stats.mtimeMs > maxAgeMs;
}

async function pruneStoredReportsSafely(preservePath: string): Promise<void> {
  try {
    await pruneStoredReports(Date.now(), preservePath);
  } catch (error) {
    console.warn("Failed to prune stored reports.", error);
  }
}

function reportMaxAgeMs(): number {
  return reportMaxAgeDays() * 24 * 60 * 60 * 1_000;
}

function reportStoreDir(): string {
  const configured = process.env[REPORT_STORE_DIR_ENV]?.trim();
  return configured ? path.resolve(configured) : DEFAULT_REPORT_STORE_DIR;
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
