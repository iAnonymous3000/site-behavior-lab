#!/usr/bin/env node

/**
 * Computes percentile distributions of key behavior metrics across the committed
 * report corpus and writes public/corpus-stats.json. The findings board uses this
 * to rank a site against measured percentiles instead of fixed thresholds, but
 * only once the corpus is large enough (see CORPUS_MIN_SAMPLE in lib/corpus-stats).
 *
 * One data point per distinct real site (most recent scan wins) so repeated scans
 * of the same domain do not skew the distribution. Reserved/test domains are
 * excluded so the corpus reflects real sites only.
 */

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reportsDir = path.join(rootDir, "public", "reports");
const outPath = path.join(rootDir, "public", "corpus-stats.json");
const reportFilePattern = /^[0-9]{8}-[0-9a-f]{32}\.json$/;
const schemaVersion = 1;
const metricKeys = ["thirdPartyRequests", "thirdPartyDomains", "knownTrackerRequests", "thirdPartyCookies", "fingerprintEvents"];
const excludedDomains = new Set(["example.com", "example.org", "example.net", "example.edu", "localhost"]);

async function main() {
  const bySite = new Map();

  for (const file of await listReportFiles()) {
    let report;
    try {
      report = JSON.parse(await readFile(path.join(reportsDir, file), "utf8"));
    } catch {
      continue;
    }
    if (!isCurrentReport(report)) continue;

    // Use the baseline (the plain "off" state) of any comparison so the corpus
    // distribution stays comparable to a normal single scan. The "on" variant is a
    // protected state (Shields/GPC enabled) that no default scan is in, so ranking
    // ordinary scans against it, especially Shields-on, which blocks most third
    // parties, would misrank nearly every site.
    const result = report.reportType === "comparison" ? report.baseline : report;
    if (!isRecord(result) || !isRecord(result.summary) || !isRecord(result.conditions)) continue;

    const domain = normalizeDomain(result.summary.firstPartyDomain);
    if (!domain || excludedDomains.has(domain)) continue;

    const scannedAt = result.conditions.scannedAt;
    const existing = bySite.get(domain);
    if (existing && Date.parse(existing.scannedAt) >= Date.parse(typeof scannedAt === "string" ? scannedAt : 0)) {
      continue;
    }

    bySite.set(domain, {
      scannedAt: typeof scannedAt === "string" ? scannedAt : new Date(0).toISOString(),
      metrics: Object.fromEntries(metricKeys.map((key) => [key, numberOrZero(result.summary[key])]))
    });
  }

  const sites = Array.from(bySite.values());
  const metrics = {};
  for (const key of metricKeys) {
    const values = sites.map((site) => site.metrics[key]).filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
    if (values.length === 0) continue;
    metrics[key] = {
      count: values.length,
      min: values[0],
      max: values[values.length - 1],
      p50: percentile(values, 50),
      p75: percentile(values, 75),
      p90: percentile(values, 90),
      p95: percentile(values, 95)
    };
  }

  const stats = { version: 1, generatedAt: new Date().toISOString(), sampleSize: sites.length, metrics };

  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(stats, null, 2)}\n`);
  console.log(`Corpus stats written: ${sites.length} distinct real site${sites.length === 1 ? "" : "s"}.`);
}

async function listReportFiles() {
  try {
    const entries = await readdir(reportsDir, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile() && reportFilePattern.test(entry.name)).map((entry) => entry.name);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function normalizeDomain(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\.$/, "")
    .replace(/^www\./, "");
}

function isCurrentReport(report) {
  if (!isRecord(report) || report.ok !== true || report.schemaVersion !== schemaVersion) return false;
  if (report.reportType === "comparison") return isRecord(report.baseline) && isRecord(report.variant);
  return true;
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
