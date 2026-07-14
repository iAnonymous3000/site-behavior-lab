#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { botBlockReason, isPublishableScanReport } from "./run-ci-scan-report.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reportsDir = path.join(rootDir, "public", "reports");
const baseUrl = stripTrailingSlash(process.env.BASE_URL || "http://127.0.0.1:3100");
const targetUrl = process.env.SCAN_URL?.trim();
const reportIdPattern = /^[0-9]{8}-[0-9a-f]{32}$/;

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

// Shields tried-vs-blocked is the headline comparison and takes precedence,
// then the consent accept/reject diff, then GPC: the scanner accepts only one
// comparison mode per scan (see lib/scan-gate.ts).
if (booleanEnv("SCAN_COMPARE_SHIELDS", false)) {
  payload.compareShields = true;
} else if (booleanEnv("SCAN_COMPARE_CONSENT", false)) {
  payload.compareConsent = true;
} else if (booleanEnv("SCAN_COMPARE_GPC", false)) {
  payload.compareGpc = true;
}

try {
  const scanResponse = await postJson(`${baseUrl}/api/scan`, payload);
  if (!isJobSubmission(scanResponse) && !isPublishableScanReport(scanResponse)) {
    throw new Error(isRecord(scanResponse) && typeof scanResponse.error === "string" ? scanResponse.error : "Scan failed.");
  }

  const scanReport = isJobSubmission(scanResponse) ? await awaitScanJob(scanResponse) : scanResponse;

  const id = reportIdPattern.test(scanReport.share?.id || "") ? scanReport.share.id : createReportId();
  const savedReport = await fetchSavedReport(scanReport);

  // Bot-detection interstitials return HTTP 200 with a challenge page, so the scan
  // "succeeds" but the report misrepresents the site (e.g. a cnn.com report with 0
  // trackers). Refuse to commit those; the caller logs it as a skipped site.
  const blockReason = botBlockReason(savedReport);
  if (blockReason) {
    console.error(`Skipping scan target: ${blockReason}.`);
    process.exit(1);
  }

  // The persistence boundary is the compiled publisher CLI (RFC 10.3 dist
  // artifact): it deep-validates the payload, projects known fields only
  // (never a spread of untrusted JSON), attaches the canonical share pointer,
  // and re-validates the exact bytes before writing. A scan result that fails
  // the canonical reader is never committed. An orchestrator that already
  // built dist/schema for the whole run (run-featured-scans) sets the env
  // flag so 81 sites do not mean 81 recompiles.
  const reportPath = path.join(reportsDir, `${id}.json`);
  const stagingDir = await mkdtemp(path.join(tmpdir(), "sbl-publish-"));
  try {
    const stagingPath = path.join(stagingDir, "scan-result.json");
    await writeFile(stagingPath, JSON.stringify(savedReport));
    if (process.env.SITE_BEHAVIOR_LAB_SCHEMA_DIST_READY !== "1") {
      const tsc = path.join(rootDir, "node_modules", "typescript", "bin", "tsc");
      execFileSync(process.execPath, [tsc, "-p", "tsconfig.schema.json"], { cwd: rootDir, stdio: "inherit" });
    }
    execFileSync(
      process.execPath,
      [path.join(rootDir, "dist", "schema", "lib", "publish-scan-report-cli.js"), stagingPath, reportPath, id],
      { cwd: rootDir, stdio: "inherit" }
    );
  } finally {
    // The staging file is the UNPROJECTED scan result (it can carry an inline
    // screenshot); never leave it behind in the temp directory.
    await rm(stagingDir, { recursive: true, force: true });
  }
  // Fail closed before this report can become an artifact or commit. The
  // exact remediation check verifies the full managed corpus, including the
  // publisher's report/sidecar pair and its digest.
  execFileSync(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["run", "reports:remediate", "--", "--check"],
    { cwd: rootDir, stdio: "inherit", env: { ...process.env, SITE_BEHAVIOR_LAB_SCHEMA_DIST_READY: "1" } }
  );
  await writeGithubOutput({
    report_id: id,
    report_path: `public/reports/${id}.json`,
    sidecar_path: `public/reports/${id}.provenance.json`
  });

  console.log(`Wrote validated static report and sidecar ${id}.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

async function fetchSavedReport(scanReport) {
  if (typeof scanReport.share?.jsonPath !== "string") return scanReport;

  try {
    const savedReport = await fetchJson(`${baseUrl}${scanReport.share.jsonPath}`);
    return isPublishableScanReport(savedReport) ? savedReport : scanReport;
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
    isRecord(response) &&
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
    if (isRecord(status) && status.ok && status.status === "succeeded") {
      if (!isPublishableScanReport(status.report)) {
        throw new Error("Completed scan job did not include a publishable report.");
      }
      return status.report;
    }
    if (isRecord(status) && status.ok && (status.status === "queued" || status.status === "running")) {
      await delay(1000);
      continue;
    }
    throw new Error(
      isRecord(status) && typeof status.error === "string"
        ? status.error
        : `Scan job ${submission.jobId} did not complete.`
    );
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

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
