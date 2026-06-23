#!/usr/bin/env node

// Production smoke test for a DEPLOYED full Node/Playwright scanner — the
// Cloudflare Containers path (docs/deploy-cloudflare-containers.md) or any
// always-on Node deployment. It is API-only (no browser), so it runs anywhere,
// and it tolerates async scan mode (the container sets SITE_BEHAVIOR_LAB_ASYNC_SCANS=1,
// so /api/scan returns 202 + a jobId to poll) as well as synchronous responses.
//
// Usage:
//   SCAN_BASE_URL=https://scan.sitebehavior.org \
//   [SMOKE_SCAN_ACCESS_TOKEN=<token>] \
//   [SMOKE_SHIELDS_URL=https://example.com] \
//   npm run test:smoke:scanner
//
// Turnstile note: an OPEN scanner that enforces Turnstile cannot be smoked
// automatically — Turnstile exists to block exactly this kind of unattended
// request, and the script has no token to submit. Run this against a deployment
// configured with an access token and pass SMOKE_SCAN_ACCESS_TOKEN: a matching
// token is checked *before* Turnstile (see gateScanRequest in container-worker.ts),
// so it bypasses the challenge. Validate the open public origin's Turnstile path
// by hand instead (complete the challenge in a browser).
//
// It verifies the things that distinguish a finished live scanner from the
// static corpus: health advertises live Shields, a real scan completes and is
// stored without a screenshot, a Shields comparison actually runs the ad-block
// engine, and a link-local SSRF target is refused.

const baseUrl = (process.env.SCAN_BASE_URL || "").trim().replace(/\/+$/, "");
const token = (process.env.SMOKE_SCAN_ACCESS_TOKEN || process.env.SITE_BEHAVIOR_LAB_SCAN_ACCESS_TOKEN || "").trim();
const shieldsUrl = (process.env.SMOKE_SHIELDS_URL || "https://example.com").trim();
const SCHEMA_VERSION = 1;
const POLL_INTERVAL_MS = 2000;
const MAX_POLLS = 120; // ~4 min ceiling for a Shields comparison (two visits)

if (!baseUrl) {
  fail("Set SCAN_BASE_URL to the deployed scanner origin, e.g. https://scan.sitebehavior.org");
}

function pass(message) {
  console.log(`PASS ${message}`);
}

function fail(message) {
  console.error(`FAIL ${message}`);
  process.exit(1);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function authHeaders(extra = {}) {
  const headers = { ...extra };
  if (token) headers["x-site-behavior-lab-access-token"] = token;
  return headers;
}

async function readJson(response, label) {
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    fail(`${label} returned ${response.status} with non-JSON content`);
  }
  return response.json();
}

// Submit a scan and return the raw API payload (a report, or an async submission).
async function submitScan(body) {
  const response = await fetch(`${baseUrl}/api/scan`, {
    method: "POST",
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify(body)
  });
  return { status: response.status, payload: await readJson(response, "/api/scan") };
}

function isAsyncSubmission(payload) {
  return Boolean(payload && payload.ok && payload.status === "queued" && typeof payload.statusPath === "string");
}

function isReport(payload) {
  return Boolean(payload && payload.ok !== false && (payload.summary || payload.baseline || payload.reportType));
}

// Resolve a submission to a finished report, polling the job status if async.
async function resolveReport(submission, label) {
  const { payload } = submission;
  if (isReport(payload)) return payload;
  if (isAsyncSubmission(payload)) return pollJob(payload.statusPath, label);
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

async function pollJob(statusPath, label) {
  const url = /^https?:\/\//i.test(statusPath) ? statusPath : `${baseUrl}${statusPath}`;
  for (let attempt = 0; attempt < MAX_POLLS; attempt += 1) {
    const response = await fetch(url, { headers: authHeaders(), cache: "no-store" });
    const data = await readJson(response, "/api/scans/:id");
    if (!data.ok) fail(`${label}: job poll failed (${data.error || response.status})`);
    if (data.status === "succeeded") {
      if (data.report) return data.report;
      fail(`${label}: job succeeded without a report`);
    }
    if (data.status === "failed" || data.status === "expired" || data.status === "cancelled") {
      fail(`${label}: job ${data.status} (${data.error || "no reason given"})`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
  fail(`${label}: job did not finish within ${(MAX_POLLS * POLL_INTERVAL_MS) / 1000}s`);
}

async function fetchSavedReport(jsonPath) {
  const url = /^https?:\/\//i.test(jsonPath) ? jsonPath : `${baseUrl}${jsonPath}`;
  const response = await fetch(url, { headers: authHeaders(), cache: "no-store" });
  return readJson(response, jsonPath);
}

// Fetch the human-shareable HTML report page (the thing the Share button links
// to). JSON readback alone does not prove a deployment can render this page.
async function fetchReportPage(pagePath) {
  const url = /^https?:\/\//i.test(pagePath) ? pagePath : `${baseUrl}${pagePath}`;
  const response = await fetch(url, { headers: authHeaders(), cache: "no-store" });
  const contentType = response.headers.get("content-type") || "";
  return { ok: response.ok, status: response.status, contentType, body: await response.text() };
}

async function checkHealth() {
  const response = await fetch(`${baseUrl}/api/health`, { headers: authHeaders(), cache: "no-store" });
  const health = await readJson(response, "/api/health");
  if (!health.ok) fail(`health is not ok: ${health.error || JSON.stringify(health.warnings || [])}`);
  const capabilities = health.capabilities || {};
  if (!capabilities.singleScan) fail("health does not advertise singleScan");
  if (!capabilities.shieldsComparison) {
    fail("health does not advertise live Shields — this is the Browser Run worker, not the full Node scanner");
  }
  if (!capabilities.savedReports) fail("health does not advertise durable savedReports (bind R2)");
  if (!capabilities.savedReportPages) {
    fail("health does not advertise savedReportPages — this origin cannot serve human-shareable /reports/:id pages");
  }
  if (!health.checks?.adblock?.active) fail("Brave ad-block engine is not active on this deployment");
  pass(`health advertises live Shields (storage: ${health.storage || health.checks?.reportStore?.kind || "unknown"})`);
}

async function checkSingleScan() {
  const report = await resolveReport(
    await submitScan({
      url: "https://example.com/?token=smoke-secret#frag",
      device: "desktop",
      gpcEnabled: true,
      consentMode: "observe"
    }),
    "single scan"
  );
  if (!report.summary || report.summary.totalRequests < 1) fail("single scan produced no requests");
  if (report.schemaVersion !== SCHEMA_VERSION) fail("single scan used an unexpected report schema version");
  if (JSON.stringify(report).includes("smoke-secret")) fail("single scan leaked a query-string secret");
  if (!report.share?.jsonPath?.startsWith("/api/reports/")) fail("single scan did not return a share permalink");

  const saved = await fetchSavedReport(report.share.jsonPath);
  if (!saved.ok || saved.share?.id !== report.share.id) fail("saved report endpoint did not return the scan");
  if (saved.screenshot !== null && saved.screenshot !== undefined) fail("saved report retained an inline screenshot");
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
  const report = await resolveReport(
    await submitScan({
      url: shieldsUrl,
      device: "desktop",
      compareShields: true,
      consentMode: "observe"
    }),
    "Shields comparison"
  );
  if (report.reportType !== "comparison" || report.comparisonType !== "shields") {
    fail("Shields request did not produce a Shields comparison report");
  }
  if (!report.diff?.thirdPartyRequests) fail("Shields comparison is missing its diff");
  if (!report.baseline?.conditions?.adblock?.active) {
    fail("Shields comparison ran without the ad-block engine active");
  }
  const blocked = report.variant?.summary?.shieldsBlockedRequests ?? report.baseline?.summary?.shieldsBlockedRequests ?? 0;
  pass(`live Shields comparison ran on ${shieldsUrl} (engine active; would-block count: ${blocked})`);
}

async function checkSsrfRefusal() {
  // A link-local literal (cloud metadata range) must never be scannable. Refusal
  // can arrive at submit (URL-shape check) or as a failed job — both are a pass.
  const submission = await submitScan({
    url: "http://169.254.169.254/",
    device: "desktop",
    gpcEnabled: false,
    consentMode: "observe"
  });
  const { payload } = submission;
  if (payload && payload.ok === false) {
    pass(`link-local SSRF target refused at submit (${payload.error || "rejected"})`);
    return;
  }
  if (isAsyncSubmission(payload)) {
    const url = /^https?:\/\//i.test(payload.statusPath) ? payload.statusPath : `${baseUrl}${payload.statusPath}`;
    for (let attempt = 0; attempt < MAX_POLLS; attempt += 1) {
      const data = await readJson(await fetch(url, { headers: authHeaders(), cache: "no-store" }), "/api/scans/:id");
      if (data.status === "failed" || data.status === "expired" || data.status === "cancelled") {
        pass("link-local SSRF target refused by the scan job");
        return;
      }
      if (data.status === "succeeded") fail("link-local SSRF target was scanned successfully — guard failed");
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
