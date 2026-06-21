#!/usr/bin/env node

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reportsDir = path.join(rootDir, "public", "reports");
const manifestPath = path.join(reportsDir, "index.json");
const reportFilePattern = /^([0-9]{8}-[0-9a-f]{32})\.json$/;
const scanReportSchemaVersion = 1;

async function main() {
  await mkdir(reportsDir, { recursive: true });

  const entries = await readReportEntries();
  entries.sort((a, b) => Date.parse(b.scannedAt) - Date.parse(a.scannedAt));

  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        reports: entries
      },
      null,
      2
    )}\n`
  );

  console.log(`Static report manifest written with ${entries.length} report${entries.length === 1 ? "" : "s"}.`);
}

async function readReportEntries() {
  let entries;
  try {
    entries = await readdir(reportsDir, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }

  const reports = [];
  for (const entry of entries) {
    const match = entry.isFile() ? reportFilePattern.exec(entry.name) : null;
    if (!match) continue;

    const id = match[1];
    try {
      const report = JSON.parse(await readFile(path.join(reportsDir, entry.name), "utf8"));
      const manifestEntry = toManifestEntry(id, report);
      if (manifestEntry) reports.push(manifestEntry);
    } catch (error) {
      console.warn(`Skipping invalid static report ${entry.name}:`, error instanceof Error ? error.message : error);
    }
  }

  return reports;
}

function toManifestEntry(id, report) {
  if (!isCurrentScanReport(report)) return null;

  const result = report.reportType === "comparison" ? report.variant : report;
  if (!isRecord(result) || !isRecord(result.summary) || !isRecord(result.conditions)) return null;

  const scannedAt = report.reportType === "comparison" ? report.scannedAt : result.conditions.scannedAt;
  const requestedUrl = report.reportType === "comparison" ? report.requestedUrl : result.conditions.requestedUrl;
  const device =
    report.reportType === "comparison"
      ? report.device
      : result.conditions.viewport?.isMobile === true
        ? "mobile"
        : "desktop";

  if (
    typeof scannedAt !== "string" ||
    typeof requestedUrl !== "string" ||
    (device !== "desktop" && device !== "mobile") ||
    typeof result.summary.firstPartyDomain !== "string"
  ) {
    return null;
  }

  return {
    id,
    title: displayTitle(report, result),
    domain: result.summary.firstPartyDomain,
    requestedUrl,
    scannedAt,
    reportType: report.reportType === "comparison" ? "comparison" : "single",
    device,
    gpcEnabled: report.reportType === "comparison" ? "comparison" : result.conditions.gpcEnabled === true,
    metrics: {
      totalRequests: numberOrZero(result.summary.totalRequests),
      thirdPartyRequests: numberOrZero(result.summary.thirdPartyRequests),
      knownTrackerRequests: numberOrZero(result.summary.knownTrackerRequests),
      thirdPartyDomains: numberOrZero(result.summary.thirdPartyDomains),
      cookies: numberOrZero(result.summary.cookies),
      thirdPartyCookies: numberOrZero(result.summary.thirdPartyCookies),
      fingerprintEvents: numberOrZero(result.summary.fingerprintEvents)
    }
  };
}

function isCurrentScanReport(report) {
  if (!isRecord(report) || report.ok !== true || report.schemaVersion !== scanReportSchemaVersion) return false;

  if (report.reportType === "comparison") {
    return isCurrentSingleScanResult(report.baseline) && isCurrentSingleScanResult(report.variant);
  }

  return isCurrentSingleScanResult(report);
}

function isCurrentSingleScanResult(report) {
  return isRecord(report) && report.ok === true && report.schemaVersion === scanReportSchemaVersion;
}

function displayTitle(report, result) {
  if (report.reportType === "comparison" && typeof report.title === "string" && report.title.trim()) {
    return report.title.trim();
  }

  return String(result.summary.pageTitle || result.summary.firstPartyDomain);
}

function numberOrZero(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
