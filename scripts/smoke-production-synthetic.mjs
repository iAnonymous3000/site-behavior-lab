#!/usr/bin/env node

// Hourly production synthetic for the public Containers scanner. A distinct
// Worker-only credential bypasses Turnstile for this one operator request while
// leaving the visitor path open and challenged. The completed single scan is
// intentionally ordinary persisted output: write + readback prove Chromium,
// outbound navigation, the public r2 builder, and remote R2 together.

import {
  isSupportedDeployedReport,
  savedReportRetainsScreenshot,
  singleReportTotalRequests
} from "./smoke-deployed-scanner-report.mjs";

const configuredBaseUrl = (process.env.SCAN_BASE_URL || "").trim();
const token = (process.env.PRODUCTION_SYNTHETIC_MONITOR_TOKEN || "").trim();
const targetUrl = "https://www.iana.org/domains/reserved";
const targetRequestedSubject = {
  origin: "https://www.iana.org",
  registrableDomain: "iana.org",
  routeShape: "/{seg}/{seg}"
};
const monitorHeader = "x-site-behavior-lab-synthetic-monitor-token";
const runStartedAtClockSkewMs = 60_000;
const requestTimeoutMs = boundedDuration(
  process.env.PRODUCTION_SYNTHETIC_REQUEST_TIMEOUT_MS,
  15_000,
  100,
  30_000,
  "PRODUCTION_SYNTHETIC_REQUEST_TIMEOUT_MS"
);
const totalTimeoutMs = boundedDuration(
  process.env.PRODUCTION_SYNTHETIC_TOTAL_TIMEOUT_MS,
  300_000,
  500,
  360_000,
  "PRODUCTION_SYNTHETIC_TOTAL_TIMEOUT_MS"
);
const pollIntervalMs = boundedDuration(
  process.env.PRODUCTION_SYNTHETIC_POLL_INTERVAL_MS,
  2_000,
  10,
  2_000,
  "PRODUCTION_SYNTHETIC_POLL_INTERVAL_MS"
);

if (!configuredBaseUrl) fail("Set SCAN_BASE_URL to the deployed scanner origin.");
if (!/^[\x21-\x7e]{32,256}$/.test(token)) {
  fail("PRODUCTION_SYNTHETIC_MONITOR_TOKEN must be 32-256 printable ASCII characters.");
}

const baseUrl = exactScannerOrigin(configuredBaseUrl);
const totalDeadline = Date.now() + totalTimeoutMs;

function fail(message) {
  console.error(`FAIL ${message}`);
  process.exit(1);
}

function monitorHeaders(extra = {}) {
  return { ...extra, [monitorHeader]: token };
}

function boundedDuration(raw, fallback, minimum, maximum, label) {
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) fail(`${label} must be an integer from ${minimum} to ${maximum}.`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail(`${label} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

function exactScannerOrigin(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail("SCAN_BASE_URL must be an absolute scanner origin.");
  }
  const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "[::1]";
  if (
    (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    fail("SCAN_BASE_URL must be an exact HTTPS scanner origin (HTTP is allowed only for loopback tests).");
  }
  return parsed.origin;
}

function sameOriginUrl(value, label, pathnamePattern) {
  let parsed;
  try {
    parsed = new URL(value, `${baseUrl}/`);
  } catch {
    fail(`${label} returned an invalid URL.`);
  }
  if (parsed.origin !== baseUrl || !pathnamePattern.test(parsed.pathname) || parsed.search || parsed.hash) {
    fail(`${label} returned a URL outside its exact same-origin path contract.`);
  }
  return parsed.href;
}

function remainingTotalMs() {
  return totalDeadline - Date.now();
}

async function guardedFetch(url, options, label) {
  const remaining = remainingTotalMs();
  if (remaining <= 0) fail(`Synthetic scan exceeded its ${totalTimeoutMs}ms total deadline.`);
  const timeout = Math.min(requestTimeoutMs, remaining);
  const boundedByTotalDeadline = remaining <= requestTimeoutMs;
  try {
    return await fetch(url, {
      ...options,
      redirect: "error",
      signal: AbortSignal.timeout(timeout)
    });
  } catch {
    if (boundedByTotalDeadline) {
      fail(`Synthetic scan exceeded its ${totalTimeoutMs}ms total deadline.`);
    }
    fail(`${label} request failed or exceeded its ${timeout}ms deadline.`);
  }
}

async function sleep(ms) {
  const remaining = remainingTotalMs();
  if (remaining <= 0) fail(`Synthetic scan exceeded its ${totalTimeoutMs}ms total deadline.`);
  await new Promise((resolve) => setTimeout(resolve, Math.min(ms, remaining)));
}

async function readJson(response, label) {
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    fail(`${label} returned ${response.status} with non-JSON content.`);
  }
  try {
    return await response.json();
  } catch {
    fail(`${label} returned malformed JSON.`);
  }
}

async function resolveReport(payload, submissionStatus) {
  if (submissionStatus === 200) {
    if (isSupportedDeployedReport(payload)) return { report: payload, queuedReportId: null };
    fail("Synthetic scan returned 200 without a supported direct report.");
  }
  if (submissionStatus !== 202) {
    fail(`Synthetic scan submission returned unexpected HTTP status ${submissionStatus}.`);
  }
  if (isSupportedDeployedReport(payload)) {
    fail("Synthetic scan returned a direct report with queued HTTP status 202.");
  }
  if (!payload?.ok || payload.status !== "queued" || typeof payload.statusPath !== "string") {
    fail("Synthetic scan returned 202 without the queued response contract.");
  }
  const queuedReportId = typeof payload.reportId === "string" ? payload.reportId.trim() : "";
  if (!queuedReportId) fail("Synthetic scan was queued without its reserved report ID.");

  const statusUrl = sameOriginUrl(payload.statusPath, "Synthetic scan status", /^\/api\/scans\/[^/]+$/);
  while (remainingTotalMs() > 0) {
    const response = await guardedFetch(statusUrl, { cache: "no-store" }, "/api/scans/:id");
    if (response.status !== 200) {
      fail(`Synthetic scan status returned unexpected HTTP status ${response.status}.`);
    }
    const status = await readJson(response, "/api/scans/:id");
    if (status.status === "succeeded") {
      if (isSupportedDeployedReport(status.report)) {
        if (status.report.share?.id !== queuedReportId) {
          fail("Synthetic scan completed with a report other than its reserved queued report ID.");
        }
        return { report: status.report, queuedReportId };
      }
      fail("Synthetic scan succeeded without a supported report.");
    }
    if (["failed", "expired", "cancelled"].includes(status.status)) {
      fail(`Synthetic scan ended ${status.status} (${status.error || "no reason given"}).`);
    }
    await sleep(pollIntervalMs);
  }
  fail(`Synthetic scan did not finish within ${totalTimeoutMs / 1_000}s.`);
}

function assertFixedSyntheticReport(report, expectedReportId = null, expectedStartedAt = null) {
  if (report.schemaVersion !== 2 || report.schemaRevision !== 2 || report.reportType !== "single") {
    fail("Synthetic scan did not produce the production single-report ScanReport v2/r2 contract.");
  }
  if (expectedReportId !== null && report.share?.id !== expectedReportId) {
    fail("Synthetic scan report did not match its reserved queued report ID.");
  }

  const requested = report.run?.subject?.requested;
  if (
    requested?.origin !== targetRequestedSubject.origin ||
    requested?.registrableDomain !== targetRequestedSubject.registrableDomain ||
    requested?.routeShape !== targetRequestedSubject.routeShape
  ) {
    fail("Synthetic scan report did not describe the fixed IANA requested subject.");
  }
  const observed = report.run?.subject?.observed;
  if (
    observed?.origin !== targetRequestedSubject.origin ||
    observed?.registrableDomain !== targetRequestedSubject.registrableDomain ||
    observed?.routeShape !== targetRequestedSubject.routeShape
  ) {
    fail("Synthetic scan report did not finish on the fixed IANA observed subject.");
  }

  const conditions = report.run?.conditions;
  if (
    conditions?.gpc !== true ||
    conditions?.consent !== "observe" ||
    conditions?.device?.kind !== "desktop" ||
    conditions?.device?.viewport?.isMobile !== false
  ) {
    fail("Synthetic scan report did not retain the fixed desktop, GPC-on, observe-mode conditions.");
  }

  const runId = typeof report.run?.runId === "string" ? report.run.runId.trim() : "";
  if (!runId) fail("Synthetic scan report did not carry a stable run identity.");
  const startedAt = typeof report.run?.startedAt === "string" ? report.run.startedAt : "";
  const startedAtMs = Date.parse(startedAt);
  if (
    !startedAt ||
    !Number.isFinite(startedAtMs) ||
    new Date(startedAtMs).toISOString() !== startedAt ||
    startedAtMs < submissionStartedAt - runStartedAtClockSkewMs ||
    startedAtMs > Date.now() + runStartedAtClockSkewMs
  ) {
    fail("Synthetic scan report was not started within this monitor invocation.");
  }
  if (expectedStartedAt !== null && startedAt !== expectedStartedAt) {
    fail("Synthetic scan report readback changed its run start identity.");
  }
  return { runId, startedAt };
}

const submissionStartedAt = Date.now();
const submissionResponse = await guardedFetch(`${baseUrl}/api/scan`, {
  method: "POST",
  headers: monitorHeaders({ "content-type": "application/json" }),
  body: JSON.stringify({
    url: targetUrl,
    device: "desktop",
    gpcEnabled: true,
    consentMode: "observe"
  })
}, "/api/scan");
const submission = await readJson(submissionResponse, "/api/scan");
const resolved = await resolveReport(submission, submissionResponse.status);
const report = resolved.report;
const { runId, startedAt } = assertFixedSyntheticReport(report, resolved.queuedReportId);

const totalRequests = singleReportTotalRequests(report);
if (totalRequests === null || totalRequests < 1) fail("Synthetic scan produced no recorded requests.");
if (!report.share?.id || !report.share?.jsonPath?.startsWith("/api/reports/")) {
  fail("Synthetic scan did not return a durable report capability.");
}

const reportUrl = sameOriginUrl(report.share.jsonPath, "Synthetic report readback", /^\/api\/reports\/[^/]+$/);
const savedResponse = await guardedFetch(reportUrl, { cache: "no-store" }, report.share.jsonPath);
if (!savedResponse.ok) fail(`Synthetic report readback returned ${savedResponse.status}.`);
const saved = await readJson(savedResponse, report.share.jsonPath);
const { runId: savedRunId } = assertFixedSyntheticReport(saved, report.share.id, startedAt);
const savedTotalRequests = singleReportTotalRequests(saved);
if (
  !isSupportedDeployedReport(saved) ||
  saved.share?.id !== report.share.id ||
  savedRunId !== runId ||
  savedTotalRequests === null ||
  savedTotalRequests < 1
) {
  fail("Synthetic report readback did not return the exact saved report.");
}
if (savedReportRetainsScreenshot(saved)) fail("Synthetic saved report retained screenshot material.");

if (!report.share.path?.startsWith("/reports/")) fail("Synthetic report has no shareable page path.");
const pageUrl = sameOriginUrl(report.share.path, "Synthetic report page", /^\/reports\/[^/]+$/);
// This is also the canonical contract gate, not just a cosmetic render check:
// the dynamic report page resolves the share through readStoredReportForId ->
// readStoredScanReportById -> readManagedReport. Malformed or semantically
// inconsistent v2/r2 bytes therefore return a non-200 page before rendering.
const pageResponse = await guardedFetch(pageUrl, { cache: "no-store" }, report.share.path);
if (!pageResponse.ok || !(pageResponse.headers.get("content-type") || "").includes("text/html")) {
  fail(`Synthetic report page did not render as HTML (${pageResponse.status}).`);
}
if (!(await pageResponse.text()).includes(report.share.id)) {
  fail("Synthetic report page did not render the saved report ID.");
}

console.log(
  `PASS production synthetic completed, persisted, read back, and rendered (${totalRequests} recorded requests).`
);
