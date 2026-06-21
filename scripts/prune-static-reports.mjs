#!/usr/bin/env node

import { readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reportsDir = path.join(rootDir, "public", "reports");
const reportFilePattern = /^([0-9]{8}-[0-9a-f]{32})\.json$/;
const DEFAULT_MAX_AGE_DAYS = 7;
const DEFAULT_MAX_COUNT = 500;

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

  const kept = [];
  const removePaths = new Set();

  for (const record of records) {
    if (now - record.scannedAtMs > maxAgeMs) {
      removePaths.add(record.path);
    } else {
      kept.push(record);
    }
  }

  kept
    .sort((a, b) => b.scannedAtMs - a.scannedAtMs)
    .slice(maxCount)
    .forEach((record) => removePaths.add(record.path));

  await Promise.all([...removePaths].map((filePath) => rm(filePath, { force: true })));
  console.log(`Pruned ${removePaths.size} static report${removePaths.size === 1 ? "" : "s"}.`);
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
      records.push({ path: filePath, scannedAtMs });
    } catch (error) {
      console.warn(`Skipping unreadable static report ${entry.name}:`, error instanceof Error ? error.message : error);
    }
  }

  return records;
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

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
