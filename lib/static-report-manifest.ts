import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { isReservedReportDomain } from "./reserved-report-domains";
import { readStoredScanReport } from "./scan-report-reader";
import type { ScanReport, ScanResult, StaticReportManifest, StaticReportManifestEntry } from "./types";

/**
 * Builds the static gallery manifest (public/reports/index.json) from the
 * committed report corpus. Ported from the former MJS script so recognition
 * goes through the canonical version-aware deep reader (RFC 14.8) instead of a
 * duplicated shallow shape check: a malformed report is SKIPPED WITH A WARNING,
 * and its metrics are the validated summary numbers verbatim, never a
 * silently zero-coerced guess (the deep guard already proves every count is a
 * finite number).
 *
 * Node-only module (filesystem); used by the CLI wrapper the build scripts and
 * workflows invoke. Never imported by app, worker, or browser code.
 */

const REPORT_FILE_PATTERN = /^([0-9]{8}-[0-9a-f]{32})\.json$/;

export type ManifestBuildResult = {
  manifest: StaticReportManifest;
  /** One line per skipped file, already formatted for the build log. */
  warnings: string[];
};

export async function buildStaticReportManifest(reportsDir: string, now = new Date()): Promise<ManifestBuildResult> {
  const warnings: string[] = [];
  const entries: StaticReportManifestEntry[] = [];

  let files: string[];
  try {
    files = await readdir(reportsDir);
  } catch (error) {
    if (isMissingDirectory(error)) {
      return { manifest: { generatedAt: now.toISOString(), reports: [] }, warnings };
    }
    throw error;
  }

  for (const file of files.sort()) {
    const match = REPORT_FILE_PATTERN.exec(file);
    if (!match) continue;
    const id = match[1];

    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path.join(reportsDir, file), "utf8")) as unknown;
    } catch (error) {
      warnings.push(`Skipping unparseable static report ${file}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }

    const read = readStoredScanReport(parsed);
    if (!read.ok) {
      warnings.push(`Skipping static report ${file}: ${read.error}${read.violations ? ` (${read.violations[0]})` : ""}`);
      continue;
    }
    if (read.stored.schemaVersion !== 1) {
      // The gallery renders v1 only today; a v2 report is a named skip so the
      // build log shows the capability gap instead of silently thinning the
      // gallery.
      warnings.push(`Skipping static report ${file}: schemaVersion 2 is not renderable by the gallery yet.`);
      continue;
    }

    const entry = toManifestEntry(id, read.stored.report);
    if (!entry) continue;
    entries.push(entry);
  }

  entries.sort((a, b) => Date.parse(b.scannedAt) - Date.parse(a.scannedAt));
  return { manifest: { generatedAt: now.toISOString(), reports: entries }, warnings };
}

function toManifestEntry(id: string, report: ScanReport): StaticReportManifestEntry | null {
  // Cards summarize the baseline (the plain "off" state) so a Shields card
  // shows what the site tried, not the blocked residual; the blocked count is
  // surfaced separately.
  const result: ScanResult = report.reportType === "comparison" ? report.baseline : report;
  const scannedAt = report.reportType === "comparison" ? report.scannedAt : result.conditions.scannedAt;
  const requestedUrl = report.reportType === "comparison" ? report.requestedUrl : result.conditions.requestedUrl;
  const device: StaticReportManifestEntry["device"] =
    report.reportType === "comparison" ? report.device : result.conditions.viewport.isMobile ? "mobile" : "desktop";

  // Keep reserved/test domains (example.com fixtures, localhost) out of the
  // public gallery.
  if (isReservedReportDomain(result.summary.firstPartyDomain)) return null;

  return {
    id,
    title: displayTitle(report, result),
    domain: result.summary.firstPartyDomain,
    requestedUrl,
    scannedAt,
    reportType: report.reportType === "comparison" ? "comparison" : "single",
    ...(report.reportType === "comparison" ? { comparisonType: report.comparisonType } : {}),
    device,
    gpcEnabled: report.reportType === "comparison" ? "comparison" : result.conditions.gpcEnabled,
    metrics: {
      totalRequests: result.summary.totalRequests,
      thirdPartyRequests: result.summary.thirdPartyRequests,
      knownTrackerRequests: result.summary.knownTrackerRequests,
      thirdPartyDomains: result.summary.thirdPartyDomains,
      cookies: result.summary.cookies,
      thirdPartyCookies: result.summary.thirdPartyCookies,
      fingerprintEvents: result.summary.fingerprintEvents,
      ...(result.summary.shieldsBlockedRequests !== undefined
        ? { shieldsBlockedRequests: result.summary.shieldsBlockedRequests }
        : {})
    }
  };
}

function displayTitle(report: ScanReport, result: ScanResult): string {
  if (report.reportType === "comparison" && report.title.trim()) {
    return report.title.trim();
  }
  return result.summary.pageTitle || result.summary.firstPartyDomain;
}

function isMissingDirectory(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT");
}
