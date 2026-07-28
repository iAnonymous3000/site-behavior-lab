#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { awaitSubmittedScanJob } from "./run-ci-scan-job.mjs";
import { botBlockReason, isPublishableScanReport } from "./run-ci-scan-report.mjs";
import {
  readResponseJsonWithinLimit,
  withHttpOperationDeadline
} from "./http-response.mjs";
import { prepareScanAdmission } from "./scan-admission.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reportsDir = path.join(rootDir, "public", "reports");
const baseUrl = stripTrailingSlash(process.env.BASE_URL || "http://127.0.0.1:3100");
const targetUrl = process.env.SCAN_URL?.trim();
const reportIdPattern = /^[0-9]{8}-[0-9a-f]{32}$/;
const scanRequestTimeoutMs = boundedIntegerEnv("CI_SCAN_REQUEST_TIMEOUT_MS", 300_000, 1_000, 600_000);
const controlRequestTimeoutMs = 30_000;
const jsonResponseMaxBytes = 32 * 1024 * 1024;

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

  const scanReport = isJobSubmission(scanResponse)
    ? await awaitSubmittedScanJob({
        submission: scanResponse,
        baseUrl,
        headers: accessHeaders(),
        isPublishableScanReport
      })
    : scanResponse;

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
  // publisher's report/sidecar pair and its digest. The trusted featured-site
  // parent may defer this O(corpus) pass because it runs the same check once
  // after every child has exited; a standalone publication never defers it.
  if (process.env.CI_SCAN_DEFER_CORPUS_CHECK !== "1") {
    execFileSync(
      process.platform === "win32" ? "npm.cmd" : "npm",
      ["run", "reports:remediate", "--", "--check"],
      { cwd: rootDir, stdio: "inherit", env: { ...process.env, SITE_BEHAVIOR_LAB_SCHEMA_DIST_READY: "1" } }
    );
  }
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

async function postJson(url, body) {
  const admission = prepareScanAdmission(body);
  const { response, value: payload } = await requestJson(
    url,
    {
      method: "POST",
      headers: { "content-type": "application/json", ...accessHeaders(), ...admission.headers },
      body: JSON.stringify(admission.body)
    },
    scanRequestTimeoutMs
  );
  if (!response.ok && payload.ok !== false) {
    throw new Error(`Scan endpoint returned ${response.status}.`);
  }
  return payload;
}

async function fetchJson(url, headers = {}) {
  const { value } = await requestJson(url, { headers }, controlRequestTimeoutMs);
  return value;
}

async function requestJson(url, init, timeoutMs) {
  return withHttpOperationDeadline(
    { timeoutMs, label: url },
    async (signal) => {
      const response = await fetch(url, { ...init, redirect: "error", signal });
      const contentType = response.headers.get("content-type") || "";
      if (!contentType.includes("application/json")) {
        throw new Error(`Expected JSON from ${response.url}, got ${response.status}.`);
      }
      const value = await readResponseJsonWithinLimit(response, {
        maxBytes: jsonResponseMaxBytes,
        label: url
      });
      return { response, value };
    }
  );
}

function createReportId() {
  return `${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomBytes(16).toString("hex")}`;
}

function booleanEnv(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  return /^(1|true|yes|on)$/i.test(value);
}

function boundedIntegerEnv(name, fallback, minimum, maximum) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
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
