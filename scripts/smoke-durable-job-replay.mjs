#!/usr/bin/env node

// Operator-only live canary for durable scan-job replay/reconciliation.
//
// This script deliberately refuses to submit anything unless a gated deployment
// advertises an explicit staging identity and staging-only fault-injection
// capability in /api/health, and the operator independently confirms that staging
// identity. There is no production override: production must never expose the hook.

const CONFIRMATION = "I_ACKNOWLEDGE_THIS_SUBMITS_A_LIVE_SCAN";
const STAGING_CONFIRMATION = "I_ACKNOWLEDGE_THIS_IS_A_GATED_STAGING_DEPLOYMENT";
const REPORT_ID_PATTERN = /^[0-9]{8}-[0-9a-f]{32}$/;
const HEADER_NAME_PATTERN = /^x-[a-z0-9-]{1,100}$/;
const POLL_INTERVAL_MS = positiveIntegerEnv("DURABLE_REPLAY_POLL_INTERVAL_MS", 2_000);
const MAX_POLLS = positiveIntegerEnv("DURABLE_REPLAY_MAX_POLLS", 180);

const baseUrl = requiredOrigin("DURABLE_REPLAY_BASE_URL");
const accessToken = requiredHeaderValue("DURABLE_REPLAY_ACCESS_TOKEN");
const targetUrl = requiredTargetUrl("DURABLE_REPLAY_TARGET_URL");
const faultToken = requiredHeaderValue("DURABLE_REPLAY_FAULT_TOKEN");
const faultMode = requiredFaultMode();
const noPollMs = positiveIntegerEnv("DURABLE_REPLAY_NO_POLL_MS");

if (process.env.DURABLE_REPLAY_CONFIRM !== CONFIRMATION) {
  fail(`Set DURABLE_REPLAY_CONFIRM=${CONFIRMATION} to acknowledge that this submits a real scan.`);
}
if (process.env.DURABLE_REPLAY_STAGING_CONFIRM !== STAGING_CONFIRMATION) {
  fail(
    `Set DURABLE_REPLAY_STAGING_CONFIRM=${STAGING_CONFIRMATION} only after verifying that the configured origin is ` +
      "a separate access-token-gated staging deployment."
  );
}
if (normalizedHostname(baseUrl) === "scan.sitebehavior.org") {
  fail("The production scanner is never a valid durable replay canary target; use a separate gated staging deployment.");
}

const health = await readJson(
  await fetch(`${baseUrl}/api/health`, { headers: authHeaders(), cache: "no-store", redirect: "error" }),
  "/api/health"
);
const hook = assertSafeFaultInjectionPrerequisites(health);
const minimumNoPollMs = Number(hook.minimumNoPollMs);
if (!Number.isSafeInteger(minimumNoPollMs) || minimumNoPollMs <= 0) {
  fail("The advertised fault hook does not publish a positive minimumNoPollMs lease/replay margin; no scan was submitted.");
}
if (noPollMs < minimumNoPollMs) {
  fail(
    `DURABLE_REPLAY_NO_POLL_MS=${noPollMs} is shorter than the deployment-advertised lease-expiry/replay margin ` +
      `(${minimumNoPollMs} ms); no scan was submitted.`
  );
}

console.log(
  `Submitting ${faultMode} durable replay canary to ${baseUrl}; no status, health, or report request will be sent for ${noPollMs} ms.`
);
const submissionResponse = await fetch(`${baseUrl}/api/scan`, {
  method: "POST",
  headers: authHeaders({
    "content-type": "application/json; charset=utf-8",
    [hook.modeHeaderName]: faultMode,
    [hook.tokenHeaderName]: faultToken
  }),
  body: JSON.stringify({
    url: targetUrl,
    device: "desktop",
    gpcEnabled: true,
    consentMode: "observe"
  }),
  cache: "no-store",
  redirect: "error"
});
const submission = await readJson(submissionResponse, "/api/scan");
if (submissionResponse.status !== 202 || !isDurableSubmission(submission)) {
  fail(
    `Fault-injected scan was not accepted as an async durable job (HTTP ${submissionResponse.status}: ` +
      `${publicError(submission)}).`
  );
}

const { jobId, reportId, statusPath } = submission;
console.log(`Accepted job ${jobId} with report ${reportId}. Entering the deliberate no-poll window.`);
await sleep(noPollMs);
console.log("No-poll window complete; beginning bounded status polling.");

const terminal = await pollTerminalStatus(statusPath);
if (terminal.status !== "succeeded") {
  fail(`Durable job became ${terminal.status} (${publicError(terminal)}).`);
}
if (terminal.report !== undefined) {
  assertReportIdentity(terminal.report, reportId, "terminal job response");
}

const reportResponse = await fetch(`${baseUrl}/api/reports/${reportId}`, {
  headers: authHeaders(),
  cache: "no-store",
  redirect: "error"
});
const savedReport = await readJson(reportResponse, `/api/reports/${reportId}`);
if (!reportResponse.ok) {
  fail(`Saved report ${reportId} returned HTTP ${reportResponse.status} (${publicError(savedReport)}).`);
}
assertReportIdentity(savedReport, reportId, "saved report endpoint");

const attempts = exposedAttemptCount(terminal);
if (attempts === null) {
  console.warn("WARN The status endpoint does not expose an attempt count; report identity and terminal recovery passed.");
} else if (faultMode === "lease-expiry" && attempts < 2) {
  fail(`Status exposed ${attempts} attempt(s); lease-expiry replay requires evidence of a second attempt.`);
} else if (faultMode === "lost-resolve" && attempts !== 1) {
  fail(`Status exposed ${attempts} attempt(s); lost-resolve reconciliation must not repeat the site visit.`);
} else {
  console.log(`PASS Status exposed the expected attempt evidence (${attempts} attempt(s)).`);
}

console.log(`PASS ${faultMode} recovered the same reportId (${reportId}) after an idle lease/replay window.`);

function assertSafeFaultInjectionPrerequisites(value) {
  if (!value || value.ok !== true) fail(`/api/health is not healthy (${publicError(value)}).`);
  if (value.authenticated !== true || value.openAccess !== false) {
    fail("The replay canary requires a gated staging deployment (authenticated=true, openAccess=false); no scan was submitted.");
  }
  const durable = value.checks?.durableJobs;
  if (!durable || durable.requested !== true || durable.enabled !== true || durable.readiness !== "ready") {
    fail("The deployment does not advertise fully ready durable jobs; no scan was submitted.");
  }

  const injection = durable.faultInjection;
  if (!injection || injection.environment !== "staging") {
    fail(
      "The deployment does not positively attest checks.durableJobs.faultInjection.environment=staging; no scan was submitted."
    );
  }
  if (injection.enabled !== true || !Array.isArray(injection.modes) || !injection.modes.includes(faultMode)) {
    fail(
      `The deployment does not advertise the staging-only ${faultMode} fault hook in ` +
        "checks.durableJobs.faultInjection; no scan was submitted. Production intentionally omits this hook."
    );
  }
  if (!validHeaderName(injection.modeHeaderName) || !validHeaderName(injection.tokenHeaderName)) {
    fail("The advertised fault hook does not provide valid mode/token header names; no scan was submitted.");
  }
  if (injection.modeHeaderName === injection.tokenHeaderName) {
    fail("The advertised fault hook reuses one header for mode and token; no scan was submitted.");
  }
  return injection;
}

async function pollTerminalStatus(statusPath) {
  const statusUrl = new URL(statusPath, `${baseUrl}/`);
  if (statusUrl.origin !== new URL(baseUrl).origin) {
    fail("The submitted job status path escaped the configured scanner origin.");
  }
  for (let attempt = 0; attempt < MAX_POLLS; attempt += 1) {
    const response = await fetch(statusUrl, { headers: authHeaders(), cache: "no-store", redirect: "error" });
    const status = await readJson(response, "/api/scans/:id");
    if (!response.ok || status?.ok !== true) {
      fail(`Job polling failed with HTTP ${response.status} (${publicError(status)}).`);
    }
    if (["succeeded", "failed", "expired", "cancelled"].includes(status.status)) return status;
    await sleep(POLL_INTERVAL_MS);
  }
  fail(`Job did not reach a terminal state within ${(MAX_POLLS * POLL_INTERVAL_MS) / 1000} seconds after the no-poll window.`);
}

function isDurableSubmission(value) {
  return Boolean(
    value?.ok === true &&
      value.status === "queued" &&
      REPORT_ID_PATTERN.test(value.jobId) &&
      REPORT_ID_PATTERN.test(value.reportId) &&
      value.jobId !== value.reportId &&
      value.statusPath === `/api/scans/${value.jobId}`
  );
}

function assertReportIdentity(report, reportId, label) {
  if (!report || typeof report !== "object" || report.share?.id !== reportId) {
    fail(`${label} did not return the admission-minted reportId ${reportId}.`);
  }
}

function exposedAttemptCount(status) {
  const candidates = [
    status?.attempts,
    status?.attempt,
    status?.attemptCount,
    status?.progress?.attempts,
    status?.progress?.attempt,
    status?.progress?.attemptCount,
    status?.durable?.attempts,
    status?.durable?.attempt,
    status?.durable?.attemptCount
  ];
  for (const value of candidates) {
    if (Number.isSafeInteger(value) && value >= 0) return value;
  }
  return null;
}

function authHeaders(extra = {}) {
  return { ...extra, "x-site-behavior-lab-access-token": accessToken };
}

async function readJson(response, label) {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    fail(`${label} returned HTTP ${response.status} with non-JSON content.`);
  }
  try {
    return await response.json();
  } catch {
    fail(`${label} returned invalid JSON.`);
  }
}

function requiredFaultMode() {
  const value = requiredEnv("DURABLE_REPLAY_FAULT_MODE");
  if (value !== "lease-expiry" && value !== "lost-resolve") {
    fail("DURABLE_REPLAY_FAULT_MODE must be lease-expiry or lost-resolve.");
  }
  return value;
}

function requiredOrigin(name) {
  const value = requiredEnv(name).replace(/\/+$/, "");
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(`${name} must be an absolute scanner origin.`);
  }
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname))) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    fail(`${name} must be an HTTPS origin with no credentials, path, query, or fragment (HTTP is local-only).`);
  }
  return url.origin;
}

function requiredTargetUrl(name) {
  const value = requiredEnv(name);
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(`${name} must be an absolute http(s) URL.`);
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    fail(`${name} must be an http(s) URL without credentials, query, or fragment.`);
  }
  return url.href;
}

function normalizedHostname(origin) {
  return new URL(origin).hostname.toLowerCase().replace(/\.+$/, "");
}

function requiredEnv(name) {
  const value = process.env[name]?.trim() ?? "";
  if (!value) fail(`Set ${name}; the replay canary has no implicit operator defaults.`);
  return value;
}

function requiredHeaderValue(name) {
  const value = requiredEnv(name);
  if (value.length > 4_096 || /[\r\n]/.test(value)) fail(`${name} is not a safe HTTP header value.`);
  return value;
}

function positiveIntegerEnv(name, fallback) {
  const raw = process.env[name]?.trim();
  if (!raw && fallback !== undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) fail(`${name} must be a positive integer.`);
  return value;
}

function validHeaderName(value) {
  return typeof value === "string" && HEADER_NAME_PATTERN.test(value) && value !== "x-site-behavior-lab-access-token";
}

function publicError(value) {
  return typeof value?.error === "string" && value.error.trim() ? value.error : "no public error detail";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fail(message) {
  console.error(`FAIL ${message}`);
  process.exit(1);
}
