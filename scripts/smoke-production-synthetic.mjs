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
import { prepareScanAdmission } from "./scan-admission.mjs";
import {
  readResponseJsonWithinLimit,
  readResponseTextWithinLimit,
  withHttpOperationDeadline
} from "./http-response.mjs";

const configuredBaseUrl = (process.env.SCAN_BASE_URL || "").trim();
const token = (process.env.PRODUCTION_SYNTHETIC_MONITOR_TOKEN || "").trim();
// Ordered fixed candidates, mirrored by the server-side allowlist in
// lib/production-synthetic.ts (the monitor credential authorizes ONLY these).
// A later candidate runs only after an earlier candidate's scan itself failed
// (job failed/expired/cancelled, or its attempt budget ran out), so a single
// third party's outage or block cannot page the operator about the scanner.
// Scanner-side contract violations stay fatal on the first occurrence. Route
// shapes are the exact redaction-v2 shapes of each fixed path.
const syntheticTargets = [
  {
    url: "https://www.iana.org/domains/reserved",
    subject: { origin: "https://www.iana.org", registrableDomain: "iana.org", routeShape: "/{seg}/{seg}" }
  },
  {
    url: "https://www.w3.org/TR/",
    subject: { origin: "https://www.w3.org", registrableDomain: "w3.org", routeShape: "/{seg}" }
  }
];

/** A target-attributable scan failure: fall through to the next candidate. */
class TargetScanFailure extends Error {}
const monitorHeader = "x-site-behavior-lab-synthetic-monitor-token";
const runStartedAtClockSkewMs = 60_000;
const jsonResponseMaxBytes = 32 * 1024 * 1024;
const htmlResponseMaxBytes = 2 * 1024 * 1024;
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
// Each candidate target gets a bounded share of the total budget so a hung
// primary target cannot starve the fallback candidate of any time.
const attemptTimeoutMs = Math.max(30_000, Math.floor(totalTimeoutMs / syntheticTargets.length));
let attemptDeadline = Infinity;

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

function remainingAttemptMs() {
  return Math.min(totalDeadline, attemptDeadline) - Date.now();
}

async function guardedRequest(url, options, label, read) {
  const remaining = remainingTotalMs();
  if (remaining <= 0) fail(`Synthetic scan exceeded its ${totalTimeoutMs}ms total deadline.`);
  const timeout = Math.min(requestTimeoutMs, remaining);
  const boundedByTotalDeadline = remaining <= requestTimeoutMs;
  try {
    return await withHttpOperationDeadline(
      { timeoutMs: timeout, label },
      async (signal) => {
        const response = await fetch(url, {
          ...options,
          redirect: "error",
          signal
        });
        return { response, value: await read(response) };
      }
    );
  } catch (error) {
    if (error instanceof RangeError) fail(error.message);
    if (boundedByTotalDeadline) {
      fail(`Synthetic scan exceeded its ${totalTimeoutMs}ms total deadline.`);
    }
    fail(`${label} request failed or exceeded its ${timeout}ms deadline.`);
  }
}

async function guardedJsonFetch(url, options, label) {
  return guardedRequest(url, options, label, async (response) => {
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      fail(`${label} returned ${response.status} with non-JSON content.`);
    }
    try {
      return await readResponseJsonWithinLimit(response, {
        maxBytes: jsonResponseMaxBytes,
        label
      });
    } catch (error) {
      if (error instanceof RangeError) fail(error.message);
      if (error instanceof SyntaxError) fail(`${label} returned malformed JSON.`);
      throw error;
    }
  });
}

async function guardedTextFetch(url, options, label) {
  return guardedRequest(url, options, label, (response) =>
    readResponseTextWithinLimit(response, {
      maxBytes: htmlResponseMaxBytes,
      label
    })
  );
}

async function sleep(ms) {
  const remaining = remainingTotalMs();
  if (remaining <= 0) fail(`Synthetic scan exceeded its ${totalTimeoutMs}ms total deadline.`);
  await new Promise((resolve) => setTimeout(resolve, Math.min(ms, remaining)));
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
  while (remainingTotalMs() > 0 && remainingAttemptMs() > 0) {
    const { response, value: status } = await guardedJsonFetch(
      statusUrl,
      { cache: "no-store" },
      "/api/scans/:id"
    );
    if (response.status !== 200) {
      fail(`Synthetic scan status returned unexpected HTTP status ${response.status}.`);
    }
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
      // The scanner answered every poll; only THIS target's scan failed. With
      // an independent fallback candidate available, that failure is
      // attributable to the target, not the scanner.
      throw new TargetScanFailure(`scan job ended ${status.status} (${status.error || "no reason given"})`);
    }
    await sleep(pollIntervalMs);
  }
  if (remainingTotalMs() <= 0) fail(`Synthetic scan did not finish within ${totalTimeoutMs / 1_000}s.`);
  throw new TargetScanFailure(`scan did not finish within its ${attemptTimeoutMs / 1_000}s attempt budget`);
}

function assertFixedSyntheticReport(report, target, submissionStartedAt, expectedReportId = null, expectedStartedAt = null) {
  if (report.schemaVersion !== 2 || report.schemaRevision !== 2 || report.reportType !== "single") {
    fail("Synthetic scan did not produce the production single-report ScanReport v2/r2 contract.");
  }
  if (expectedReportId !== null && report.share?.id !== expectedReportId) {
    fail("Synthetic scan report did not match its reserved queued report ID.");
  }

  const requested = report.run?.subject?.requested;
  if (
    requested?.origin !== target.subject.origin ||
    requested?.registrableDomain !== target.subject.registrableDomain ||
    requested?.routeShape !== target.subject.routeShape
  ) {
    fail("Synthetic scan report did not describe the fixed synthetic requested subject.");
  }
  const observed = report.run?.subject?.observed;
  if (
    observed?.origin !== target.subject.origin ||
    observed?.registrableDomain !== target.subject.registrableDomain ||
    observed?.routeShape !== target.subject.routeShape
  ) {
    fail("Synthetic scan report did not finish on the fixed synthetic observed subject.");
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

async function runSyntheticAttempt(target) {
  const submissionStartedAt = Date.now();
  const admission = prepareScanAdmission({
    url: target.url,
    device: "desktop",
    gpcEnabled: true,
    consentMode: "observe"
  });
  const { response: submissionResponse, value: submission } = await guardedJsonFetch(
    `${baseUrl}/api/scan`,
    {
      method: "POST",
      headers: monitorHeaders({ "content-type": "application/json", ...admission.headers }),
      body: JSON.stringify(admission.body)
    },
    "/api/scan"
  );
  const resolved = await resolveReport(submission, submissionResponse.status);
  const report = resolved.report;
  const { runId, startedAt } = assertFixedSyntheticReport(report, target, submissionStartedAt, resolved.queuedReportId);

  const totalRequests = singleReportTotalRequests(report);
  if (totalRequests === null || totalRequests < 1) fail("Synthetic scan produced no recorded requests.");
  if (!report.share?.id || !report.share?.jsonPath?.startsWith("/api/reports/")) {
    fail("Synthetic scan did not return a durable report capability.");
  }

  const reportUrl = sameOriginUrl(report.share.jsonPath, "Synthetic report readback", /^\/api\/reports\/[^/]+$/);
  const { response: savedResponse, value: saved } = await guardedJsonFetch(
    reportUrl,
    { cache: "no-store" },
    report.share.jsonPath
  );
  if (!savedResponse.ok) fail(`Synthetic report readback returned ${savedResponse.status}.`);
  const { runId: savedRunId } = assertFixedSyntheticReport(saved, target, submissionStartedAt, report.share.id, startedAt);
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
  const { response: pageResponse, value: pageHtml } = await guardedTextFetch(
    pageUrl,
    { cache: "no-store" },
    report.share.path
  );
  if (!pageResponse.ok || !(pageResponse.headers.get("content-type") || "").includes("text/html")) {
    fail(`Synthetic report page did not render as HTML (${pageResponse.status}).`);
  }
  if (!pageHtml.includes(report.share.id)) {
    fail("Synthetic report page did not render the saved report ID.");
  }

  return totalRequests;
}

const targetFailures = [];
let completedTotalRequests = null;
for (const target of syntheticTargets) {
  attemptDeadline = Date.now() + attemptTimeoutMs;
  try {
    completedTotalRequests = await runSyntheticAttempt(target);
    break;
  } catch (error) {
    if (!(error instanceof TargetScanFailure)) throw error;
    targetFailures.push(`${target.url}: ${error.message}`);
    console.warn(
      `WARN synthetic target ${target.url} did not produce a scan (${error.message}); trying the next candidate target.`
    );
  }
}
if (completedTotalRequests === null) {
  fail(`Synthetic scan failed on every candidate target: ${targetFailures.join("; ")}`);
}

console.log(
  `PASS production synthetic completed, persisted, read back, and rendered (${completedTotalRequests} recorded requests).`
);
