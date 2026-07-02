#!/usr/bin/env node

import { readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reportsDir = path.join(rootDir, "public", "reports");
const reportFilePattern = /^([0-9]{8}-[0-9a-f]{32})\.json$/;
const DEFAULT_MAX_AGE_DAYS = 7;
// Hard ceiling on committed reports. With per-site-per-kind history retention
// (see DEFAULT_KEEP_PER_SITE) the protected set alone can approach
// sites x kinds x 2, so this sits well above it; at ~150 KB per report the
// ceiling bounds the repo at roughly 150 MB of report JSON.
const DEFAULT_MAX_COUNT = 1_000;
// Each site's newest reports PER KIND (shields / consent / gpc / single) are
// exempt from AGE pruning so the corpus keeps a "current" and a "previous"
// generation of each kind for the directory's "changed since last scan" view
// (deltas only pair same-kind reports), and a site that stops being re-scanned
// never silently vanishes from the corpus. The overall count cap stays the
// hard ceiling. Set to 0 to restore pure age-based pruning.
const DEFAULT_KEEP_PER_SITE = 2;

async function main() {
  const records = await readReportRecords();
  const now = Date.now();
  const maxAgeMs = positiveNumberFromEnv(
    "SITE_BEHAVIOR_LAB_STATIC_REPORT_MAX_AGE_DAYS",
    positiveNumberFromEnv("SITE_BEHAVIOR_LAB_REPORT_MAX_AGE_DAYS", DEFAULT_MAX_AGE_DAYS)
  ) * 24 * 60 * 60 * 1_000;
  const maxCount = Math.max(
    1,
    Math.floor(
      positiveNumberFromEnv(
        "SITE_BEHAVIOR_LAB_STATIC_REPORT_MAX_COUNT",
        positiveNumberFromEnv("SITE_BEHAVIOR_LAB_REPORT_MAX_COUNT", DEFAULT_MAX_COUNT)
      )
    )
  );
  const keepPerSite = Math.max(
    0,
    Math.floor(nonNegativeNumberFromEnv("SITE_BEHAVIOR_LAB_STATIC_REPORT_KEEP_PER_SITE", DEFAULT_KEEP_PER_SITE))
  );

  const ageExempt = newestPerSite(records, keepPerSite);
  const kept = [];
  const removePaths = new Set();

  for (const record of records) {
    if (now - record.scannedAtMs > maxAgeMs && !ageExempt.has(record)) {
      removePaths.add(record.path);
    } else {
      kept.push(record);
    }
  }

  // The count cap is the hard ceiling: trim oldest first, but prefer removing
  // reports that are not a site's protected newest generations.
  kept
    .sort((a, b) => Number(ageExempt.has(b)) - Number(ageExempt.has(a)) || b.scannedAtMs - a.scannedAtMs)
    .slice(maxCount)
    .forEach((record) => removePaths.add(record.path));

  await Promise.all([...removePaths].map((filePath) => rm(filePath, { force: true })));
  console.log(`Pruned ${removePaths.size} static report${removePaths.size === 1 ? "" : "s"}.`);
}

function newestPerSite(records, keepPerSite) {
  const exempt = new Set();
  if (keepPerSite === 0) return exempt;

  const bySiteAndKind = new Map();
  for (const record of records) {
    if (!record.domain) continue;
    const key = `${record.domain}|${record.kind}`;
    const list = bySiteAndKind.get(key);
    if (list) list.push(record);
    else bySiteAndKind.set(key, [record]);
  }

  for (const list of bySiteAndKind.values()) {
    list.sort((a, b) => b.scannedAtMs - a.scannedAtMs);
    for (const record of list.slice(0, keepPerSite)) {
      exempt.add(record);
    }
  }

  return exempt;
}

async function readReportRecords() {
  let entries;
  try {
    entries = await readdir(reportsDir, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }

  const records = [];
  for (const entry of entries) {
    const match = entry.isFile() ? reportFilePattern.exec(entry.name) : null;
    if (!match) continue;

    const filePath = path.join(reportsDir, entry.name);
    try {
      const report = JSON.parse(await readFile(filePath, "utf8"));
      const scannedAtMs = reportScannedAtMs(report);
      if (scannedAtMs === null) {
        console.warn(`Skipping static report with missing scannedAt: ${entry.name}`);
        continue;
      }
      records.push({ path: filePath, scannedAtMs, domain: reportDomain(report), kind: reportKind(report) });
    } catch (error) {
      console.warn(`Skipping unreadable static report ${entry.name}:`, error instanceof Error ? error.message : error);
    }
  }

  return records;
}

function reportDomain(report) {
  const result = isRecord(report) && report.reportType === "comparison" ? report.baseline : report;
  const domain = isRecord(result) && isRecord(result.summary) ? result.summary.firstPartyDomain : null;
  return typeof domain === "string" && domain ? domain.toLowerCase().replace(/^www\./, "") : null;
}

function reportKind(report) {
  if (!isRecord(report) || report.reportType !== "comparison") return "single";
  return typeof report.comparisonType === "string" && report.comparisonType ? report.comparisonType : "comparison";
}

function reportScannedAtMs(report) {
  const scannedAt =
    isRecord(report) && report.reportType === "comparison"
      ? report.scannedAt
      : isRecord(report) && isRecord(report.conditions)
        ? report.conditions.scannedAt
        : null;

  if (typeof scannedAt !== "string") return null;
  const scannedAtMs = Date.parse(scannedAt);
  return Number.isFinite(scannedAtMs) ? scannedAtMs : null;
}

function positiveNumberFromEnv(name, fallback) {
  const value = Number(process.env[name] || "");
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function nonNegativeNumberFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
