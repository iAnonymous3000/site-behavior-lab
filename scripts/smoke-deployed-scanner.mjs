#!/usr/bin/env node

// Production smoke test for a DEPLOYED full Node/Playwright scanner, the
// Cloudflare Containers path (docs/deploy-cloudflare-containers.md) or any
// always-on Node deployment. It is API-only (no browser), so it runs anywhere,
// and it tolerates async scan mode (the container sets SITE_BEHAVIOR_LAB_ASYNC_SCANS=1,
// so /api/scan returns 202 + a jobId to poll) as well as synchronous responses.
//
// Usage:
//   SCAN_BASE_URL=https://scan.sitebehavior.org \
//   [SMOKE_SCAN_ACCESS_TOKEN=<token>] \
//   [SMOKE_SHIELDS_URL="https://www.iana.org/ https://www.w3.org/"] \
//   [SMOKE_EXPECTED_STORAGE=r2|filesystem] \
//   npm run test:smoke:scanner
//
// Turnstile note: an OPEN scanner that enforces Turnstile cannot be smoked
// automatically, Turnstile exists to block exactly this kind of unattended
// request, and the script has no token to submit. Run this against a deployment
// configured with an access token and pass SMOKE_SCAN_ACCESS_TOKEN: a matching
// token is checked *before* Turnstile (see gateScanRequest in container-worker.ts),
// so it bypasses the challenge. Validate the open public origin's Turnstile path
// by hand instead (complete the challenge in a browser).
//
// It verifies the things that distinguish a finished live scanner from the
// static corpus: health advertises live Shields and an enabled Chromium sandbox,
// a real scan completes and is stored without a screenshot, a Shields comparison
// actually runs the ad-block engine, and a link-local SSRF target is refused.

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
import { prepareScanAdmission } from "./scan-admission.mjs";
import {
  readResponseJsonWithinLimit,
  readResponseTextWithinLimit,
  withHttpOperationDeadline
} from "./http-response.mjs";

const baseUrl = (process.env.SCAN_BASE_URL || "").trim().replace(/\/+$/, "");
const token = (process.env.SMOKE_SCAN_ACCESS_TOKEN || process.env.SITE_BEHAVIOR_LAB_SCAN_ACCESS_TOKEN || "").trim();
// r2 verification requires at least one subresource to reach the engine. Use
// neutral, independently hosted standards sites so a sitebehavior.org outage
// cannot block promotion of the commit that repairs that outage. The list is
// ordered: a later candidate runs only after an earlier candidate's SCAN
// failed (target-side unavailability), so no single third party's outage or
// bot wall can block every promotion. Scanner-side contract violations still
// fail immediately regardless of target.
const shieldsUrlCandidates = (process.env.SMOKE_SHIELDS_URL || "https://www.iana.org/ https://www.w3.org/")
  .trim()
  .split(/\s+/)
  .filter(Boolean);
// The single-scan leg needs the same ordered fallback, and for the same
// reason: it proves the scanner, not any one target's availability. It kept a
// single hardcoded target when the Shields leg gained candidates, so one
// example.com outage failed the whole gate (net::ERR_FAILED, run 30835720588)
// on a commit that touched nothing in that path. Each candidate is scanned
// with a query string and fragment appended, so the leg still proves the
// report scrubs both.
const singleScanUrlCandidates = (
  process.env.SMOKE_SINGLE_SCAN_URL || "https://example.com/ https://www.iana.org/ https://www.w3.org/"
)
  .trim()
  .split(/\s+/)
  .filter(Boolean);
const expectedStorage = (process.env.SMOKE_EXPECTED_STORAGE || "r2").trim();
const POLL_INTERVAL_MS = 2000;
const MAX_POLLS = 120; // ~4 min ceiling for a Shields comparison (two visits)
const requestTimeoutMs = boundedIntegerEnv("SMOKE_SCANNER_REQUEST_TIMEOUT_MS", 30_000, 1_000, 60_000);
const controlResponseMaxBytes = 256 * 1024;
const reportResponseMaxBytes = 32 * 1024 * 1024;
const htmlResponseMaxBytes = 2 * 1024 * 1024;

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function authHeaders(extra = {}) {
  const headers = { ...extra };
  if (token) headers["x-site-behavior-lab-access-token"] = token;
  return headers;
}

async function requestJson(url, init, label, maxBytes = reportResponseMaxBytes) {
  return guardedRequest(url, init, label, async (response) => {
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
  });
}

async function requestText(url, init, label) {
  return guardedRequest(url, init, label, (response) =>
    readResponseTextWithinLimit(response, { maxBytes: htmlResponseMaxBytes, label })
  );
}

async function guardedRequest(url, init, label, read) {
  try {
    return await withHttpOperationDeadline(
      { timeoutMs: requestTimeoutMs, label },
      async (signal) => {
        const response = await fetch(url, { ...init, redirect: "error", signal });
        return { response, value: await read(response) };
      }
    );
  } catch (error) {
    if (error instanceof RangeError) fail(error.message);
    fail(`${label} request failed or exceeded its ${requestTimeoutMs}ms deadline`);
  }
}

// Submit a scan and return the raw API payload (a report, or an async submission).
async function submitScan(body) {
  const admission = prepareScanAdmission(body);
  const { response, value: payload } = await requestJson(
    `${baseUrl}/api/scan`,
    {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json", ...admission.headers }),
      body: JSON.stringify(admission.body)
    },
    "/api/scan"
  );
  return { status: response.status, payload };
}

function isAsyncSubmission(payload) {
  return Boolean(payload && payload.ok && payload.status === "queued" && typeof payload.statusPath === "string");
}

function isReport(payload) {
  return isSupportedDeployedReport(payload);
}

// Resolve a submission to a finished report, polling the job status if async.
async function resolveReport(submission, label, { tolerateScanFailure = false } = {}) {
  const { payload } = submission;
  if (isReport(payload)) return { report: payload };
  if (isAsyncSubmission(payload)) return pollJob(payload.statusPath, label, { tolerateScanFailure });
  const errorText = payload && typeof payload.error === "string" ? payload.error : "";
  if (/turnstile/i.test(errorText)) {
    fail(
      `${label}: this scanner enforces Turnstile, which blocks automated scans. ` +
        "Smoke a deployment that has an access token configured and pass SMOKE_SCAN_ACCESS_TOKEN " +
        "(a valid token bypasses Turnstile); an open Turnstile-gated public origin cannot be smoked automatically."
    );
  }
  fail(`${label}: scan was not accepted (${errorText || JSON.stringify(payload)})`);
}

async function pollJob(statusPath, label, { tolerateScanFailure = false } = {}) {
  const url = /^https?:\/\//i.test(statusPath) ? statusPath : `${baseUrl}${statusPath}`;
  for (let attempt = 0; attempt < MAX_POLLS; attempt += 1) {
    const { response, value: data } = await requestJson(
      url,
      { headers: authHeaders(), cache: "no-store" },
      "/api/scans/:id"
    );
    if (!data.ok) fail(`${label}: job poll failed (${data.error || response.status})`);
    if (data.status === "succeeded") {
      if (data.report) return { report: data.report };
      fail(`${label}: job succeeded without a report`);
    }
    if (data.status === "failed" || data.status === "expired" || data.status === "cancelled") {
      // The scanner infrastructure answered every poll; only the SCAN of this
      // particular target failed. That is attributable to the target when a
      // caller has an independent fallback target to prove the scanner with.
      const reason = `job ${data.status} (${data.error || "no reason given"})`;
      if (tolerateScanFailure) return { scanFailure: reason };
      fail(`${label}: ${reason}`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
  const timeoutReason = `job did not finish within ${(MAX_POLLS * POLL_INTERVAL_MS) / 1000}s`;
  if (tolerateScanFailure) return { scanFailure: timeoutReason };
  fail(`${label}: ${timeoutReason}`);
}

async function fetchSavedReport(jsonPath) {
  const url = /^https?:\/\//i.test(jsonPath) ? jsonPath : `${baseUrl}${jsonPath}`;
  const { value } = await requestJson(
    url,
    { headers: authHeaders(), cache: "no-store" },
    jsonPath
  );
  return value;
}

// Fetch the human-shareable HTML report page (the thing the Share button links
// to). JSON readback alone does not prove a deployment can render this page.
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
    fail("health does not advertise savedReportPages, this origin cannot serve human-shareable /reports/:id pages");
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
    const outcome = await resolveReport(
      await submitScan({
        url: `${candidate}?token=smoke-secret#frag`,
        device: "desktop",
        gpcEnabled: true,
        consentMode: "observe"
      }),
      "single scan",
      // Same rule as the Shields leg: a target-attributable scan failure falls
      // through, and only every candidate failing stays red, because that is
      // what indicates scanner-side breakage rather than one site's outage.
      { tolerateScanFailure: true }
    );
    if (outcome.scanFailure) {
      candidateFailures.push(`${candidate}: ${outcome.scanFailure}`);
      console.warn(
        `WARN single-scan smoke target ${candidate} did not produce a scan (${outcome.scanFailure}); trying the next candidate target.`
      );
      continue;
    }
    await assertSingleScanReport(outcome.report);
    return;
  }
  fail(`single scan failed on every candidate target: ${candidateFailures.join("; ")}`);
}

async function assertSingleScanReport(report) {
  const totalRequests = singleReportTotalRequests(report);
  if (totalRequests === null || totalRequests < 1) fail("single scan produced no requests");
  if (JSON.stringify(report).includes("smoke-secret")) fail("single scan leaked a query-string secret");
  if (!report.share?.jsonPath?.startsWith("/api/reports/")) fail("single scan did not return a share permalink");

  const saved = await fetchSavedReport(report.share.jsonPath);
  if (!isSupportedDeployedReport(saved) || saved.share?.id !== report.share.id) {
    fail("saved report endpoint did not return the scan");
  }
  if (savedReportRetainsScreenshot(saved)) fail("saved report retained an inline screenshot");
  pass("single scan completes, is stored durably, and is screenshot-stripped");

  // The share permalink is only useful if the HTML page renders, not just the JSON.
  if (!report.share?.path?.startsWith("/reports/")) fail("single scan did not return a shareable report page path");
  const page = await fetchReportPage(report.share.path);
  if (!page.ok) fail(`shareable report page ${report.share.path} returned ${page.status}`);
  if (!page.contentType.includes("text/html")) fail(`shareable report page returned non-HTML content (${page.contentType})`);
  if (!page.body.includes(report.share.id)) fail("shareable report page did not render the scanned report");
  pass("shareable report page renders the saved report as HTML");
}

async function checkShieldsComparison() {
  const candidateFailures = [];
  for (const shieldsUrl of shieldsUrlCandidates) {
    const outcome = await resolveReport(
      await submitScan({
        url: shieldsUrl,
        device: "desktop",
        compareShields: true,
        consentMode: "observe"
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
      fail("Shields request did not produce a Shields comparison report");
    }
    if (!hasShieldsComparisonDiff(report)) fail("Shields comparison is missing its diff");
    if (!shieldsEngineActive(report)) {
      fail(`Shields comparison ran without the ad-block engine active: ${shieldsPostureSummary(report)}`);
    }
    // Two DIFFERENT measurements, never blended: the variant's engine-aborted
    // count and the baseline's filter-list matches while loading normally.
    const { baseline: filterMatches, variant: engineBlocked } = shieldsBlockedCounts(report);
    pass(
      `live Shields comparison ran on ${shieldsUrl} (engine active; engine-blocked: ${engineBlocked ?? "n/a"}, baseline filter matches: ${filterMatches ?? "n/a"})`
    );
    return;
  }
  fail(`Shields comparison failed on every candidate target: ${candidateFailures.join("; ")}`);
}

function shieldsPostureSummary(report) {
  if (report.schemaVersion === 1) {
    return JSON.stringify({
      baseline: { adblock: report.baseline?.conditions?.adblock, shieldsMode: report.baseline?.conditions?.shieldsMode },
      variant: { adblock: report.variant?.conditions?.adblock, shieldsMode: report.variant?.conditions?.shieldsMode }
    });
  }
  return JSON.stringify({
    baseline: {
      shields: report.baseline?.conditions?.shields,
      facts: report.baseline?.verificationFacts?.shields,
      verification: report.experiment?.verification?.baseline
    },
    variant: {
      shields: report.variant?.conditions?.shields,
      facts: report.variant?.verificationFacts?.shields,
      verification: report.experiment?.verification?.variant
    }
  });
}

async function checkSsrfRefusal() {
  // A link-local literal (cloud metadata range) must never be scannable. Refusal
  // can arrive at submit (URL-shape check) or as a failed job, both are a pass.
  const submission = await submitScan({
    url: "http://169.254.169.254/",
    device: "desktop",
    gpcEnabled: false,
    consentMode: "observe"
  });
  const { payload } = submission;
  if (payload && payload.ok === false) {
    const reason = typeof payload.error === "string" ? payload.error : "";
    // A gate rejection (Turnstile / auth / rate limit) stops the request BEFORE it
    // reaches the URL-safety guard, so it proves nothing about SSRF protection.
    // Treat it as inconclusive, never a pass. This is the trap that let a
    // Turnstile "refusal" masquerade as SSRF coverage.
    if (/turnstile|unauthorized|access token|not configured for public|rate limit|too many/i.test(reason)) {
      fail(
        `SSRF check inconclusive: a gate stopped the request before the URL-safety guard (${reason || "rejected"}). ` +
          "Run with SMOKE_SCAN_ACCESS_TOKEN against a token-gated deployment so the scan reaches the guard."
      );
    }
    // Require the refusal to actually name an unsafe-address reason from the URL
    // guard, so an unrelated 4xx cannot be mistaken for SSRF coverage.
    if (!ssrfGuardRefusalReason({ status: "failed", error: reason })) {
      fail(`link-local target refused, but not by the URL-safety guard (${reason || "no reason given"})`);
    }
    pass(`link-local SSRF target refused by the URL-safety guard (${reason})`);
    return;
  }
  if (isAsyncSubmission(payload)) {
    const url = /^https?:\/\//i.test(payload.statusPath) ? payload.statusPath : `${baseUrl}${payload.statusPath}`;
    for (let attempt = 0; attempt < MAX_POLLS; attempt += 1) {
      const { value: data } = await requestJson(
        url,
        { headers: authHeaders(), cache: "no-store" },
        "/api/scans/:id"
      );
      if (data.status === "failed") {
        const reason = ssrfGuardRefusalReason(data);
        if (!reason) fail(`link-local scan job failed, but not at the URL-safety guard (${data.error || "no reason given"})`);
        pass(`link-local SSRF target refused by the scan job URL-safety guard (${reason})`);
        return;
      }
      if (data.status === "expired" || data.status === "cancelled") {
        fail(`SSRF check inconclusive: link-local scan job ${data.status} (${data.error || "no reason given"})`);
      }
      if (data.status === "succeeded") fail("link-local SSRF target was scanned successfully, guard failed");
      await sleep(POLL_INTERVAL_MS);
    }
    fail("SSRF job neither failed nor completed within the poll window");
  }
  fail(`link-local SSRF target was not refused: ${JSON.stringify(payload)}`);
}

console.log(`Smoke-testing deployed scanner at ${baseUrl}${token ? " (authenticated)" : ""}`);
await checkHealth();
await checkSsrfRefusal();
await checkSingleScan();
await checkShieldsComparison();
console.log("Deployed scanner smoke tests passed.");
