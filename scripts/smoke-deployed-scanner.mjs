#!/usr/bin/env node

// Production smoke test for a DEPLOYED full Node/Playwright v3 scanner, the
// Cloudflare Containers path (docs/deploy-cloudflare-containers.md) or any
// always-on Node deployment. It is API-only (no browser), so it runs anywhere
// against the synchronous POST /api/v3/scan contract.
//
// Usage:
//   SCAN_BASE_URL=https://scan.sitebehavior.org \
//   [SMOKE_SCAN_ACCESS_TOKEN=<token>] \
//   [SMOKE_SHIELDS_URL="https://www.iana.org/ https://www.w3.org/"] \
//   [SMOKE_EXPECTED_STORAGE=r2|filesystem] \
//   npm run test:smoke:scanner
//
// Turnstile note: an OPEN scanner that enforces Turnstile cannot be smoked
// automatically — Turnstile exists to block unattended requests. Run this
// against a deployment configured with an access token and pass
// SMOKE_SCAN_ACCESS_TOKEN: a matching token is checked *before* Turnstile
// (see gateScanRequest in container-worker.ts).
//
// It verifies the things that distinguish a finished live scanner from the
// static corpus: health advertises live Shields and an enabled Chromium sandbox,
// a real v3 scan completes and is persisted durably (JSON, HTML, and PDF), a
// Shields comparison actually runs the ad-block engine, and a link-local SSRF
// target is refused by the URL-safety guard.

import { REPORT_PDF_MAX_BYTES } from "../lib/report-pdf-limits.ts";
import {
  hasShieldsComparisonDiff,
  healthMatchesExpectedReportStore,
  isShieldsComparisonReport,
  isSupportedDeployedReport,
  savedReportRetainsScreenshot,
  shieldsBlockedCounts,
  shieldsEngineActive,
  singleReportTotalRequests,
  ssrfGuardRefusalReason
} from "./smoke-deployed-scanner-report.mjs";
import {
  readResponseBytesWithinLimit,
  readResponseJsonWithinLimit,
  readResponseTextWithinLimit,
  withHttpOperationDeadline
} from "./http-response.mjs";

const baseUrl = (process.env.SCAN_BASE_URL || "").trim().replace(/\/+$/, "");
const token = (process.env.SMOKE_SCAN_ACCESS_TOKEN || process.env.SITE_BEHAVIOR_LAB_SCAN_ACCESS_TOKEN || "").trim();
// Neutral, independently hosted standards sites so a sitebehavior.org outage
// cannot block promotion of the commit that repairs that outage. The list is
// ordered: a later candidate runs only after an earlier candidate's SCAN
// failed (target-side unavailability), so no single third party's outage or
// bot wall can block every promotion. Scanner-side contract violations still
// fail immediately regardless of target.
const shieldsUrlCandidates = (process.env.SMOKE_SHIELDS_URL || "https://www.iana.org/ https://www.w3.org/")
  .trim()
  .split(/\s+/)
  .filter(Boolean);
const singleScanUrlCandidates = (
  process.env.SMOKE_SINGLE_SCAN_URL || "https://example.com/ https://www.iana.org/ https://www.w3.org/"
)
  .trim()
  .split(/\s+/)
  .filter(Boolean);
const expectedStorage = (process.env.SMOKE_EXPECTED_STORAGE || "r2").trim();
const requestTimeoutMs = boundedIntegerEnv("SMOKE_SCANNER_REQUEST_TIMEOUT_MS", 30_000, 1_000, 60_000);
const scanTimeoutMs = boundedIntegerEnv("SMOKE_SCANNER_SCAN_TIMEOUT_MS", 180_000, 10_000, 300_000);
const pdfTimeoutMs = boundedIntegerEnv("SMOKE_SCANNER_PDF_TIMEOUT_MS", 60_000, 5_000, 120_000);
const controlResponseMaxBytes = 256 * 1024;
const reportResponseMaxBytes = 32 * 1024 * 1024;
const htmlResponseMaxBytes = 4 * 1024 * 1024;

if (!baseUrl) {
  fail("Set SCAN_BASE_URL to the deployed scanner origin, e.g. https://scan.sitebehavior.org");
}
if (expectedStorage !== "r2" && expectedStorage !== "filesystem") {
  fail("SMOKE_EXPECTED_STORAGE must be r2 or filesystem");
}

function pass(message) {
  console.log(`PASS ${message}`);
}

function fail(message) {
  console.error(`FAIL ${message}`);
  process.exit(1);
}

function boundedIntegerEnv(name, fallback, minimum, maximum) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

function authHeaders(extra = {}) {
  const headers = { ...extra };
  if (token) headers["x-site-behavior-lab-access-token"] = token;
  return headers;
}

async function requestJson(url, init, label, maxBytes = reportResponseMaxBytes, timeoutMs = requestTimeoutMs) {
  return guardedRequest(
    url,
    init,
    label,
    async (response) => {
      const contentType = response.headers.get("content-type") || "";
      if (!contentType.includes("application/json")) {
        fail(`${label} returned ${response.status} with non-JSON content`);
      }
      try {
        return await readResponseJsonWithinLimit(response, { maxBytes, label });
      } catch (error) {
        if (error instanceof RangeError) fail(error.message);
        if (error instanceof SyntaxError) fail(`${label} returned malformed JSON`);
        throw error;
      }
    },
    timeoutMs
  );
}

async function requestText(url, init, label, timeoutMs = requestTimeoutMs) {
  return guardedRequest(
    url,
    init,
    label,
    (response) => readResponseTextWithinLimit(response, { maxBytes: htmlResponseMaxBytes, label }),
    timeoutMs
  );
}

async function requestBytes(url, init, label, maxBytes = REPORT_PDF_MAX_BYTES, timeoutMs = pdfTimeoutMs) {
  return guardedRequest(
    url,
    init,
    label,
    (response) => readResponseBytesWithinLimit(response, { maxBytes, label }),
    timeoutMs
  );
}

async function guardedRequest(url, init, label, read, timeoutMs = requestTimeoutMs) {
  try {
    return await withHttpOperationDeadline({ timeoutMs, label }, async (signal) => {
      const response = await fetch(url, { ...init, redirect: "error", signal });
      return { response, value: await read(response) };
    });
  } catch (error) {
    if (error instanceof RangeError) fail(error.message);
    fail(`${label} request failed or exceeded its ${timeoutMs}ms deadline`);
  }
}

async function submitScan(body) {
  const { response, value: payload } = await requestJson(
    `${baseUrl}/api/v3/scan`,
    {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify(body)
    },
    "/api/v3/scan",
    reportResponseMaxBytes,
    scanTimeoutMs
  );
  return { status: response.status, payload };
}

function resolveReport(submission, label, { tolerateScanFailure = false } = {}) {
  const { status, payload } = submission;
  if (status === 200 && payload?.ok === true && isSupportedDeployedReport(payload.report)) {
    const report = payload.report;
    const leadOutcome = report.leadArm?.loadOutcome;
    if (leadOutcome && leadOutcome !== "ok") {
      const reason = `leadArm loadOutcome=${leadOutcome} (httpStatus=${report.leadArm?.httpStatus ?? "n/a"})`;
      if (tolerateScanFailure) return { scanFailure: reason };
      fail(`${label}: ${reason}`);
    }
    if (Array.isArray(report.comparisonArms)) {
      const failedComparison = report.comparisonArms.find((arm) => arm?.loadOutcome && arm.loadOutcome !== "ok");
      if (failedComparison) {
        const reason = `comparison arm ${failedComparison.armId} loadOutcome=${failedComparison.loadOutcome}`;
        if (tolerateScanFailure) return { scanFailure: reason };
        fail(`${label}: ${reason}`);
      }
    }
    return {
      report,
      reportId: payload.reportId,
      apiPath: payload.apiPath,
      sharePath: payload.sharePath,
      pdfPath: payload.pdfPath
    };
  }
  const errorText = payload && typeof payload.error === "string" ? payload.error : "";
  if (/turnstile/i.test(errorText)) {
    fail(
      `${label}: this scanner enforces Turnstile, which blocks automated scans. ` +
        "Smoke a deployment that has an access token configured and pass SMOKE_SCAN_ACCESS_TOKEN " +
        "(a valid token bypasses Turnstile); an open Turnstile-gated public origin cannot be smoked automatically."
    );
  }
  if ((status === 502 || status === 504) && tolerateScanFailure) {
    return { scanFailure: `HTTP ${status} (${errorText || "upstream target failure"})` };
  }
  fail(`${label}: scan was not accepted (${errorText || JSON.stringify(payload)})`);
}

async function fetchSavedReport(apiPath) {
  const url = /^https?:\/\//i.test(apiPath) ? apiPath : `${baseUrl}${apiPath}`;
  const { value } = await requestJson(url, { headers: authHeaders(), cache: "no-store" }, apiPath);
  return value;
}

async function fetchReportPage(pagePath) {
  const url = /^https?:\/\//i.test(pagePath) ? pagePath : `${baseUrl}${pagePath}`;
  const { response, value: body } = await requestText(
    url,
    { headers: authHeaders(), cache: "no-store" },
    pagePath
  );
  const contentType = response.headers.get("content-type") || "";
  return { ok: response.ok, status: response.status, contentType, body };
}

async function fetchReportPdf(pdfPath) {
  const url = /^https?:\/\//i.test(pdfPath) ? pdfPath : `${baseUrl}${pdfPath}`;
  const { response, value: bytes } = await requestBytes(
    url,
    { headers: authHeaders({ accept: "application/pdf" }), cache: "no-store" },
    pdfPath
  );
  const contentType = response.headers.get("content-type") || "";
  return { ok: response.ok, status: response.status, contentType, bytes };
}

async function checkHealth() {
  const { value: health } = await requestJson(
    `${baseUrl}/api/health`,
    { headers: authHeaders(), cache: "no-store" },
    "/api/health",
    controlResponseMaxBytes
  );
  if (!health.ok) fail(`health is not ok: ${health.error || JSON.stringify(health.warnings || [])}`);
  const capabilities = health.capabilities || {};
  if (!capabilities.singleScan) fail("health does not advertise singleScan");
  if (!capabilities.shieldsComparison) {
    fail("health does not advertise live Shields, this is the Browser Run worker, not the full Node scanner");
  }
  if (!capabilities.savedReports) fail("health does not advertise durable savedReports (bind R2)");
  if (!capabilities.savedReportPages) {
    fail("health does not advertise savedReportPages, this origin cannot serve human-shareable report pages");
  }
  if (!healthMatchesExpectedReportStore(health, expectedStorage)) {
    fail(`health does not prove the expected ${expectedStorage} report store is configured`);
  }
  if (!health.checks?.adblock?.active) fail("Brave ad-block engine is not active on this deployment");
  if (health.checks?.chromiumSandbox !== "enabled") {
    fail("Chromium sandbox is not enabled on this deployment");
  }
  pass(`health advertises live Shields with the expected ${expectedStorage} report store`);
}

async function checkSingleScan() {
  const candidateFailures = [];
  for (const candidate of singleScanUrlCandidates) {
    const outcome = resolveReport(
      await submitScan({
        url: `${candidate}?token=smoke-secret#frag`,
        device: "desktop",
        gpcEnabled: true,
        consentMode: "observe"
      }),
      "single scan",
      // A target-attributable scan failure falls through, and only every
      // candidate failing stays red, because that is what indicates
      // scanner-side breakage rather than one site's outage.
      { tolerateScanFailure: true }
    );
    if (outcome.scanFailure) {
      candidateFailures.push(`${candidate}: ${outcome.scanFailure}`);
      console.warn(
        `WARN single-scan smoke target ${candidate} did not produce a scan (${outcome.scanFailure}); trying the next candidate target.`
      );
      continue;
    }
    await assertSingleScanReport(outcome);
    return;
  }
  fail(`single scan failed on every candidate target: ${candidateFailures.join("; ")}`);
}

async function assertSingleScanReport(outcome) {
  const { report, reportId, apiPath, sharePath, pdfPath } = outcome;
  if (report.schemaVersion !== 3) fail(`single scan returned unexpected schemaVersion ${report.schemaVersion}`);
  const totalRequests = singleReportTotalRequests(report);
  if (totalRequests === null || totalRequests < 1) fail("single scan produced no requests");
  if (
    report.leadArm?.keystrokes?.fieldsTyped === 0 &&
    report.leadArm?.probes?.keystrokes?.status === "complete"
  ) {
    fail("single scan marked probes.keystrokes as complete despite 0 fields typed");
  }
  if (JSON.stringify(report).includes("smoke-secret")) fail("single scan leaked a query-string secret");
  if (apiPath !== `/api/v3/reports/${reportId}`) fail(`single scan returned unexpected apiPath ${apiPath}`);
  if (sharePath !== `/v3/reports/${reportId}`) fail(`single scan returned unexpected sharePath ${sharePath}`);
  if (pdfPath !== `/api/v3/reports/${reportId}/pdf`) fail(`single scan returned unexpected pdfPath ${pdfPath}`);

  const saved = await fetchSavedReport(apiPath);
  if (!isSupportedDeployedReport(saved) || saved.reportId !== reportId) {
    fail("saved v3 report endpoint did not return the scan");
  }
  if (savedReportRetainsScreenshot(saved)) fail("saved v3 report retained screenshot material");
  pass("single v3 scan completes, is stored durably, and is screenshot-free");

  const page = await fetchReportPage(sharePath);
  if (!page.ok) fail(`shareable v3 report page ${sharePath} returned ${page.status}`);
  if (!page.contentType.includes("text/html")) {
    fail(`shareable v3 report page returned non-HTML content (${page.contentType})`);
  }
  if (!page.body.includes(reportId)) fail("shareable v3 report page did not render the scanned report");
  pass("shareable v3 report page renders the saved report as HTML");

  const pdf = await fetchReportPdf(pdfPath);
  if (!pdf.ok) fail(`v3 report PDF ${pdfPath} returned ${pdf.status}`);
  if (!pdf.contentType.toLowerCase().includes("application/pdf")) {
    fail(`v3 report PDF returned unexpected content-type (${pdf.contentType})`);
  }
  if (
    pdf.bytes.byteLength < 5 ||
    pdf.bytes[0] !== 0x25 ||
    pdf.bytes[1] !== 0x50 ||
    pdf.bytes[2] !== 0x44 ||
    pdf.bytes[3] !== 0x46 ||
    pdf.bytes[4] !== 0x2d
  ) {
    fail("v3 report PDF did not start with %PDF- magic bytes");
  }
  pass(`v3 report PDF export succeeds (${pdf.bytes.byteLength} B)`);
}

async function checkShieldsComparison() {
  const candidateFailures = [];
  for (const shieldsUrl of shieldsUrlCandidates) {
    const outcome = resolveReport(
      await submitScan({
        url: shieldsUrl,
        device: "desktop",
        gpcEnabled: false,
        consentMode: "observe",
        comparisons: ["shields-standard"]
      }),
      "Shields comparison",
      // One target's outage or bot wall is attributable to that target and
      // must not block promotion while another candidate can still prove the
      // scanner. When EVERY candidate fails to scan, the aggregate failure
      // below stays red: independent targets all failing indicates
      // scanner-side breakage.
      { tolerateScanFailure: true }
    );
    if (outcome.scanFailure) {
      candidateFailures.push(`${shieldsUrl}: ${outcome.scanFailure}`);
      console.warn(
        `WARN Shields smoke target ${shieldsUrl} did not produce a scan (${outcome.scanFailure}); trying the next candidate target.`
      );
      continue;
    }
    const report = outcome.report;
    if (!isShieldsComparisonReport(report)) {
      fail("Shields request did not produce a v3 Shields comparison report");
    }
    if (!hasShieldsComparisonDiff(report)) fail("Shields comparison is missing its diff");
    if (!shieldsEngineActive(report)) {
      fail(`Shields comparison ran without the ad-block engine active: ${shieldsPostureSummary(report)}`);
    }
    const { baseline: filterMatches, variant: engineBlocked } = shieldsBlockedCounts(report);
    pass(
      `live v3 Shields comparison ran on ${shieldsUrl} (engine active; engine-blocked: ${engineBlocked ?? "n/a"}, baseline filter matches: ${filterMatches ?? "n/a"})`
    );
    return;
  }
  fail(`Shields comparison failed on every candidate target: ${candidateFailures.join("; ")}`);
}

function shieldsPostureSummary(report) {
  return JSON.stringify({
    engineVersions: report.provenance?.engineVersions,
    leadShieldsMode: report.leadArm?.conditions?.shieldsMode,
    comparisonArms: Array.isArray(report.comparisonArms)
      ? report.comparisonArms.map((arm) => ({
          armId: arm.armId,
          shieldsMode: arm.conditions?.shieldsMode,
          loadOutcome: arm.loadOutcome
        }))
      : []
  });
}

async function checkSsrfRefusal() {
  // A link-local literal (cloud metadata range) must never be scannable.
  const submission = await submitScan({
    url: "http://169.254.169.254/",
    device: "desktop",
    gpcEnabled: false,
    consentMode: "observe"
  });
  const { payload } = submission;
  if (payload && payload.ok === false) {
    const reason = typeof payload.error === "string" ? payload.error : "";
    // A gate rejection (Turnstile / auth / rate limit) stops the request BEFORE
    // it reaches the URL-safety guard, so it proves nothing about SSRF
    // protection. Treat it as inconclusive, never a pass.
    if (/turnstile|unauthorized|access token|not configured for public|rate limit|too many/i.test(reason)) {
      fail(
        `SSRF check inconclusive: a gate stopped the request before the URL-safety guard (${reason || "rejected"}). ` +
          "Run with SMOKE_SCAN_ACCESS_TOKEN against a token-gated deployment so the scan reaches the guard."
      );
    }
    if (!ssrfGuardRefusalReason({ status: "failed", error: reason })) {
      fail(`link-local target refused, but not by the URL-safety guard (${reason || "no reason given"})`);
    }
    pass(`link-local SSRF target refused by the URL-safety guard (${reason})`);
    return;
  }
  fail(`link-local SSRF target was not refused: ${JSON.stringify(payload)}`);
}

console.log(`Smoke-testing deployed v3 scanner at ${baseUrl}${token ? " (authenticated)" : ""}`);
await checkHealth();
await checkSsrfRefusal();
await checkSingleScan();
await checkShieldsComparison();
console.log("Deployed scanner smoke tests passed.");
