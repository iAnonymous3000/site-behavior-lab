import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { isReservedReportDomain } from "./reserved-report-domains";
import { readStoredScanReport } from "./scan-report-reader";
import { familyCensoredOnRun, toReportView, type ReportView } from "./scan-report-views";
import type { StaticReportManifest, StaticReportManifestEntry } from "./types";

/**
 * Builds the static gallery manifest (public/reports/index.json) from the
 * committed report corpus. Recognition goes through the canonical
 * version-aware deep reader (RFC 14.8) and the entry derives from the
 * version-independent VIEW, so every readable generation joins the gallery: a
 * malformed report is SKIPPED WITH A WARNING, and its metrics are the
 * validated summary numbers verbatim, never a silently zero-coerced guess
 * (the deep guard already proves every count is a finite number).
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

    const entry = toManifestEntry(id, toReportView(read.stored));
    if (!entry) continue;
    entries.push(entry);
  }

  entries.sort((a, b) => Date.parse(b.scannedAt) - Date.parse(a.scannedAt));
  return { manifest: { generatedAt: now.toISOString(), reports: entries }, warnings };
}

function toManifestEntry(id: string, view: ReportView): StaticReportManifestEntry | null {
  // Cards summarize the baseline (the plain "off" state) so a Shields card
  // shows what the site tried, not the blocked residual; the blocked count is
  // surfaced separately. The v1 producer wrote the comparison root's
  // requestedUrl/device from the VARIANT arm, so those two stay variant-fed
  // for byte parity with the committed manifest.
  const lead = view.runs[0];
  const tail = view.runs[view.runs.length - 1];
  if (!lead) return null;
  const comparison = view.reportType === "comparison";

  // Keep reserved/test domains (example.com fixtures, localhost) out of the
  // public gallery.
  if (isReservedReportDomain(lead.domain)) return null;

  return {
    id,
    title: (view.title ?? "").trim() || lead.pageTitle || lead.domain,
    domain: lead.domain,
    requestedUrl: (comparison ? tail : lead).conditions.requestedUrl,
    scannedAt: view.scannedAt ?? "",
    reportType: view.reportType,
    ...(comparison
      ? {
          comparisonType:
            view.comparison?.axis ?? (view.comparison?.temporalPair ? ("temporal" as const) : ("custom" as const))
        }
      : {}),
    device: (comparison ? tail : lead).conditions.viewport.isMobile ? "mobile" : "desktop",
    gpcEnabled: comparison ? "comparison" : lead.conditions.gpcEnabled,
    ...(familyCensoredOnRun(lead, "requests") ? { requestCapped: true } : {}),
    metrics: {
      totalRequests: lead.counts.totalRequests,
      thirdPartyRequests: lead.counts.thirdPartyRequests,
      knownTrackerRequests: lead.counts.knownTrackerRequests,
      thirdPartyDomains: lead.counts.thirdPartyDomains,
      cookies: lead.counts.cookies,
      thirdPartyCookies: lead.counts.thirdPartyCookies,
      fingerprintEvents: lead.counts.fingerprintEvents,
      ...(lead.counts.shieldsBlockedRequests !== null ? { shieldsBlockedRequests: lead.counts.shieldsBlockedRequests } : {})
    }
  };
}

function isMissingDirectory(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT");
}
