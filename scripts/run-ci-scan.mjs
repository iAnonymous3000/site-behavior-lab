#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reportsDir = path.join(rootDir, "public", "reports");
const baseUrl = stripTrailingSlash(process.env.BASE_URL || "http://127.0.0.1:3100");
const targetUrl = process.env.SCAN_URL?.trim();
const reportIdPattern = /^[0-9]{8}-[0-9a-f]{32}$/;
const scanReportSchemaVersion = 1;
// Titles served by common bot walls (Cloudflare, Akamai, PerimeterX, Google). A
// report whose landing page is one of these is a challenge page, not the site, and
// must not enter the public corpus.
const BLOCK_TITLE_PATTERN =
  /access denied|attention required|just a moment|pardon our interruption|are you (a )?(human|robot)|verify (you are|you'?re|your) (a )?human|checking your browser|unusual traffic|security check|request unsuccessful|captcha|enable javascript/i;

if (!targetUrl) {
  console.error("SCAN_URL is required.");
  process.exit(1);
}

const payload = {
  url: targetUrl,
  device: process.env.SCAN_DEVICE === "mobile" ? "mobile" : "desktop",
  gpcEnabled: booleanEnv("SCAN_GPC_ENABLED", true),
  consentMode: "observe"
};

// Shields tried-vs-blocked is the headline comparison and takes precedence: the
// scanner accepts only one comparison mode per scan (see lib/scan-gate.ts).
if (booleanEnv("SCAN_COMPARE_SHIELDS", false)) {
  payload.compareShields = true;
} else if (booleanEnv("SCAN_COMPARE_GPC", false)) {
  payload.compareGpc = true;
}

try {
  const scanResponse = await postJson(`${baseUrl}/api/scan`, payload);
  if (!scanResponse.ok) {
    throw new Error(scanResponse.error || "Scan failed.");
  }

  const scanReport = isJobSubmission(scanResponse) ? await awaitScanJob(scanResponse) : scanResponse;

  const id = reportIdPattern.test(scanReport.share?.id || "") ? scanReport.share.id : createReportId();
  const savedReport = await fetchSavedReport(scanReport, id);
  const publicReport = makePublicReport(savedReport, id);

  // Bot-detection interstitials return HTTP 200 with a challenge page, so the scan
  // "succeeds" but the report misrepresents the site (e.g. a cnn.com report with 0
  // trackers). Refuse to commit those; the caller logs it as a skipped site.
  const blockReason = botBlockReason(publicReport);
  if (blockReason) {
    console.error(`Skipping ${targetUrl}: ${blockReason}.`);
    process.exit(1);
  }

  await mkdir(reportsDir, { recursive: true });
  const reportPath = path.join(reportsDir, `${id}.json`);
  await writeFile(reportPath, `${JSON.stringify(publicReport, null, 2)}\n`);
  await writeGithubOutput({ report_id: id, report_path: `public/reports/${id}.json` });

  console.log(`Wrote static report ${id} for ${targetUrl}.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

async function fetchSavedReport(scanReport, id) {
  if (!scanReport.share?.jsonPath) return scanReport;

  try {
    const savedReport = await fetchJson(`${baseUrl}${scanReport.share.jsonPath}`);
    return savedReport.ok ? savedReport : scanReport;
  } catch {
    return scanReport;
  }
}

function accessHeaders() {
  const accessToken = process.env.SITE_BEHAVIOR_LAB_SCAN_ACCESS_TOKEN?.trim();
  return accessToken ? { "x-site-behavior-lab-access-token": accessToken } : {};
}

function isJobSubmission(response) {
  return (
    response.ok === true &&
    typeof response.jobId === "string" &&
    response.status === "queued" &&
    typeof response.statusPath === "string"
  );
}

async function awaitScanJob(submission) {
  const statusUrl = `${baseUrl}${submission.statusPath}`;
  for (let attempt = 0; attempt < 180; attempt += 1) {
    const status = await fetchJson(statusUrl, accessHeaders());
    if (status.ok && status.status === "succeeded") {
      if (!status.report) throw new Error("Completed scan job did not include a report.");
      return status.report;
    }
    if (status.ok && (status.status === "queued" || status.status === "running")) {
      await delay(1000);
      continue;
    }
    throw new Error(status.error || `Scan job ${submission.jobId} did not complete.`);
  }
  throw new Error(`Scan job ${submission.jobId} did not finish before the polling timeout.`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...accessHeaders() },
    body: JSON.stringify(body)
  });
  const payload = await readJsonResponse(response);
  if (!response.ok && payload.ok !== false) {
    throw new Error(`Scan endpoint returned ${response.status}.`);
  }
  return payload;
}

async function fetchJson(url, headers = {}) {
  const response = await fetch(url, { headers });
  return readJsonResponse(response);
}

async function readJsonResponse(response) {
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    throw new Error(`Expected JSON from ${response.url}, got ${response.status}.`);
  }
  return response.json();
}

function botBlockReason(report) {
  const result = report.reportType === "comparison" ? report.baseline : report;
  const summary = result?.summary;
  if (!summary) return null;

  const title = String(summary.pageTitle || "").trim();
  const totalRequests = Number(summary.totalRequests) || 0;
  if (title && BLOCK_TITLE_PATTERN.test(title)) {
    return `landing page title "${title}" matches a bot-block/challenge page`;
  }
  if (totalRequests <= 1) {
    return `only ${totalRequests} network request(s) observed, navigation likely failed or was blocked`;
  }
  return null;
}

function makePublicReport(report, id) {
  const share = {
    id,
    path: `/reports/${id}/`,
    jsonPath: `/reports/${id}.json`
  };

  if (report.reportType === "comparison") {
    return {
      ...report,
      schemaVersion: scanReportSchemaVersion,
      share,
      baseline: { ...report.baseline, schemaVersion: scanReportSchemaVersion, screenshot: null },
      variant: { ...report.variant, schemaVersion: scanReportSchemaVersion, screenshot: null }
    };
  }

  return {
    ...report,
    schemaVersion: scanReportSchemaVersion,
    share,
    screenshot: null
  };
}

function createReportId() {
  return `${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomBytes(16).toString("hex")}`;
}

function booleanEnv(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  return /^(1|true|yes|on)$/i.test(value);
}

function stripTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

async function writeGithubOutput(values) {
  if (!process.env.GITHUB_OUTPUT) return;
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}`);
  await appendFile(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
}
