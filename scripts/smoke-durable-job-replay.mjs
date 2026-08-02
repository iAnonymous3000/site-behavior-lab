#!/usr/bin/env node

// Operator-only live canary for durable scan-job replay/reconciliation.
//
// This script deliberately refuses to submit anything unless a gated deployment
// advertises an explicit staging identity and staging-only fault-injection
// capability in /api/health, and the operator independently confirms that staging
// identity. There is no production override: production must never expose the hook.

import { prepareScanAdmission } from "./scan-admission.mjs";
import { randomBytes } from "node:crypto";
import { linkSync, lstatSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildDurableReplayReceipt } from "./durable-replay-receipt-lib.mjs";
import {
  readResponseJsonWithinLimit,
  withHttpOperationDeadline
} from "./http-response.mjs";

const CONFIRMATION = "I_ACKNOWLEDGE_THIS_SUBMITS_A_LIVE_SCAN";
const STAGING_CONFIRMATION = "I_ACKNOWLEDGE_THIS_IS_A_GATED_STAGING_DEPLOYMENT";
const REPORT_ID_PATTERN = /^[0-9]{8}-[0-9a-f]{32}$/;
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const HEADER_NAME_PATTERN = /^x-[a-z0-9-]{1,100}$/;
const REQUEST_TIMEOUT_MS = boundedIntegerEnv(
  "DURABLE_REPLAY_REQUEST_TIMEOUT_MS",
  30_000,
  100,
  60_000
);
const JSON_RESPONSE_MAX_BYTES = 32 * 1024 * 1024;

const baseUrl = requiredOrigin("DURABLE_REPLAY_BASE_URL");
const accessToken = requiredHeaderValue("DURABLE_REPLAY_ACCESS_TOKEN");
const targetUrl = requiredTargetUrl("DURABLE_REPLAY_TARGET_URL");
const faultToken = requiredHeaderValue("DURABLE_REPLAY_FAULT_TOKEN");
const faultMode = requiredFaultMode();
const noPollMs = boundedIntegerEnv("DURABLE_REPLAY_NO_POLL_MS", undefined, 1, 3_600_000);
const expectedDeployment = requiredCommitSha("DURABLE_REPLAY_EXPECTED_SHA");

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
const originLabel = requiredOriginLabel("DURABLE_REPLAY_ORIGIN_LABEL");
const receiptOutputPath = requiredReceiptOutputPath("DURABLE_REPLAY_RECEIPT_PATH");

const startedAt = new Date().toISOString();
const preHealth = await readAttestedStagingHealth("pre-submission");
const { hook } = preHealth;
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
const admission = prepareScanAdmission({
  url: targetUrl,
  device: "desktop",
  gpcEnabled: true,
  consentMode: "observe"
});
const { response: submissionResponse, value: submission } = await guardedFetch(
  `${baseUrl}/api/scan`,
  {
    method: "POST",
    headers: authHeaders({
      "content-type": "application/json; charset=utf-8",
      ...admission.headers,
      [hook.modeHeaderName]: faultMode,
      [hook.tokenHeaderName]: faultToken
    }),
    body: JSON.stringify(admission.body),
    cache: "no-store",
    redirect: "error"
  },
  "/api/scan"
);
if (submissionResponse.status !== 202 || !isDurableSubmission(submission)) {
  fail(
    `Fault-injected scan was not accepted as an async durable job (HTTP ${submissionResponse.status}: ` +
      `${publicError(submission)}).`
  );
}

const { jobId, reportId, statusPath } = submission;
const submittedAt = new Date().toISOString();
console.log(`Accepted job ${jobId} with report ${reportId}. Entering the deliberate no-poll window.`);
await sleep(noPollMs);
const blindWindowEndedAt = new Date().toISOString();
console.log("No-poll window complete; reading exactly one terminal status snapshot.");

const terminal = await readFirstPostIdleStatus(statusPath);
const statusObservedAt = new Date().toISOString();
if (terminal.status !== "succeeded") {
  fail(
    `The first post-idle status snapshot was ${String(terminal.status)} instead of succeeded; ` +
      "recovery must complete before any status request can wake the Durable Object."
  );
}
if (terminal?.durable?.finishedBeforeStatusRequest !== true) {
  fail(
    "Status did not prove that durable completion predated the first status request; " +
      "a request-woken recovery is not a valid replay receipt."
  );
}
if (terminal.report !== undefined) {
  assertReportIdentity(terminal.report, reportId, "terminal job response");
}

const { response: reportResponse, value: savedReport } = await guardedFetch(
  `${baseUrl}/api/reports/${reportId}`,
  {
    headers: authHeaders(),
    cache: "no-store",
    redirect: "error"
  },
  `/api/reports/${reportId}`
);
if (!reportResponse.ok) {
  fail(`Saved report ${reportId} returned HTTP ${reportResponse.status} (${publicError(savedReport)}).`);
}
assertReportIdentity(savedReport, reportId, "saved report endpoint");
const reportReadbackAt = new Date().toISOString();

const evidence = exposedFaultEvidence(terminal);
if (!evidence || evidence.mode !== faultMode || evidence.triggered !== true || evidence.triggeredGeneration !== 1) {
  fail(`Status did not expose the exact triggered ${faultMode} staging-fault evidence.`);
}
const attempts = exposedAttemptCount(terminal);
if (attempts === null) {
  fail("Status did not expose mandatory staging-only attempt evidence.");
} else if (faultMode === "lease-expiry" && attempts !== 2) {
  fail(`Status exposed ${attempts} attempt(s); lease-expiry replay requires exactly two fenced attempts.`);
} else if (faultMode === "lost-resolve" && attempts !== 1) {
  fail(`Status exposed ${attempts} attempt(s); lost-resolve reconciliation must not repeat the site visit.`);
} else {
  console.log(`PASS Status exposed the expected attempt evidence (${attempts} attempt(s)).`);
}

// Refuse a mixed-version receipt if staging was redeployed during the blind
// window. Re-run the complete attestation, not just the SHA comparison.
const postHealth = await readAttestedStagingHealth("post-recovery");
const completedAt = new Date().toISOString();

let receipt;
try {
  receipt = buildDurableReplayReceipt({
    mode: faultMode,
    expectedDeploymentSha: expectedDeployment,
    origin: baseUrl,
    originLabel,
    timing: {
      startedAt,
      submittedAt,
      noPollMs,
      blindWindowEndedAt,
      statusObservedAt,
      reportReadbackAt,
      completedAt
    },
    preHealth,
    postHealth,
    execution: {
      terminalStatus: terminal.status,
      jobId,
      reportId,
      attempts,
      faultTriggered: evidence.triggered,
      triggeredGeneration: evidence.triggeredGeneration,
      finishedBeforeStatusRequest: terminal.durable.finishedBeforeStatusRequest,
      reportReadback: true
    }
  });
  writeExclusiveReceipt(receiptOutputPath, `${JSON.stringify(receipt, null, 2)}\n`);
} catch {
  fail("The canary passed, but its exclusive machine-readable receipt could not be written; preserve no partial claim.");
}
console.log(`PASS Wrote the ${faultMode} replay receipt to ${receiptOutputPath} (sha256:${receipt.receiptDigest}).`);
console.log(`PASS ${faultMode} recovered the same reportId (${reportId}) after an idle lease/replay window.`);

async function readAttestedStagingHealth(phase) {
  const { value: health } = await guardedFetch(`${baseUrl}/api/health`, {
    headers: authHeaders(),
    cache: "no-store",
    redirect: "error"
  }, "/api/health");
  const hook = assertSafeFaultInjectionPrerequisites(health);
  if (health.deployment !== expectedDeployment) {
    fail(
      `The ${phase} staging deployment (${String(health.deployment)}) does not match the reviewed commit ` +
        `(${expectedDeployment}).`
    );
  }
  return { health, hook, observedAt: new Date().toISOString() };
}

function assertSafeFaultInjectionPrerequisites(value) {
  if (!value || value.ok !== true) fail(`/api/health is not healthy (${publicError(value)}).`);
  if (value.status !== "ok" || !Array.isArray(value.warnings) || value.warnings.length !== 0) {
    fail("The replay canary requires status=ok with an explicitly empty warnings array; no scan was submitted.");
  }
  if (value.scansAvailable !== true) {
    fail("The replay canary requires scansAvailable=true; no scan was submitted.");
  }
  if (value.authenticated !== true || value.openAccess !== false) {
    fail("The replay canary requires a gated staging deployment (authenticated=true, openAccess=false); no scan was submitted.");
  }
  const durable = value.checks?.durableJobs;
  if (
    value.checks?.chromiumSandbox !== "enabled" ||
    value.checks?.publicR2Reports?.status !== "enabled" ||
    value.checks?.reportStore?.kind !== "r2"
  ) {
    fail("The replay canary requires the Chromium sandbox and the dedicated R2 report path to be ready; no scan was submitted.");
  }
  if (!durable || durable.requested !== true || durable.enabled !== true || durable.readiness !== "ready") {
    fail("The deployment does not advertise fully ready durable jobs; no scan was submitted.");
  }
  if (durable.coordinatorOrigin !== baseUrl) {
    fail(
      `The deployment coordinator origin (${String(durable.coordinatorOrigin)}) does not exactly match ` +
        `the configured staging origin (${baseUrl}); no scan was submitted.`
    );
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
  if (injection.attemptEvidence !== true) {
    fail("The staging fault hook does not promise mandatory attempt evidence; no scan was submitted.");
  }
  if (injection.completionBeforeStatusRequestEvidence !== true) {
    fail(
      "The staging fault hook does not promise pre-request completion evidence; no scan was submitted."
    );
  }
  if (injection.wholeOriginAccessGate !== true) {
    fail("The staging fault hook does not attest a whole-origin access gate; no scan was submitted.");
  }
  if (!validHeaderName(injection.modeHeaderName) || !validHeaderName(injection.tokenHeaderName)) {
    fail("The advertised fault hook does not provide valid mode/token header names; no scan was submitted.");
  }
  if (injection.modeHeaderName === injection.tokenHeaderName) {
    fail("The advertised fault hook reuses one header for mode and token; no scan was submitted.");
  }
  return injection;
}

async function readFirstPostIdleStatus(statusPath) {
  const statusUrl = new URL(statusPath, `${baseUrl}/`);
  if (statusUrl.origin !== new URL(baseUrl).origin) {
    fail("The submitted job status path escaped the configured scanner origin.");
  }
  const { response, value: status } = await guardedFetch(
    statusUrl,
    {
      headers: authHeaders(),
      cache: "no-store",
      redirect: "error"
    },
    "/api/scans/:id"
  );
  if (!response.ok || status?.ok !== true) {
    fail(`The first post-idle status read failed with HTTP ${response.status} (${publicError(status)}).`);
  }
  return status;
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
  const value = status?.durable?.attempts;
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function exposedFaultEvidence(status) {
  const durable = status?.durable;
  if (!durable || typeof durable !== "object" || Array.isArray(durable)) return null;
  return {
    mode: durable.faultMode,
    triggered: durable.triggered,
    triggeredGeneration: durable.triggeredGeneration,
    finishedBeforeStatusRequest: durable.finishedBeforeStatusRequest
  };
}

async function guardedFetch(input, init, label) {
  try {
    return await withHttpOperationDeadline(
      { timeoutMs: REQUEST_TIMEOUT_MS, label },
      async (signal) => {
        const response = await fetch(input, { ...init, signal });
        const contentType = response.headers.get("content-type") ?? "";
        if (!contentType.includes("application/json")) {
          fail(`${label} returned HTTP ${response.status} with non-JSON content.`);
        }
        return {
          response,
          value: await readResponseJsonWithinLimit(response, {
            maxBytes: JSON_RESPONSE_MAX_BYTES,
            label
          })
        };
      }
    );
  } catch (error) {
    if (error instanceof RangeError) fail(error.message);
    if (error instanceof SyntaxError) fail(`${label} returned invalid JSON.`);
    fail(`Request failed before a valid scanner response was received (${publicException(error)}).`);
  }
}

function authHeaders(extra = {}) {
  return { ...extra, "x-site-behavior-lab-access-token": accessToken };
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

function requiredCommitSha(name) {
  const value = requiredEnv(name);
  if (!COMMIT_SHA_PATTERN.test(value)) fail(`${name} must be the exact reviewed 40-character lowercase commit SHA.`);
  return value;
}

function requiredOriginLabel(name) {
  const value = requiredEnv(name);
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(value) || value === "production") {
    fail(`${name} must be a bounded lowercase non-production evidence label.`);
  }
  return value;
}

function requiredReceiptOutputPath(name) {
  const value = requiredEnv(name);
  if (!value.endsWith(".json") || /[\u0000\r\n]/.test(value)) {
    fail(`${name} must name an explicit .json output path.`);
  }
  const outputPath = path.resolve(value);
  const relative = path.relative(process.cwd(), outputPath);
  if (relative === "public" || relative.startsWith(`public${path.sep}`)) {
    fail(`${name} must not put operational evidence under public/.`);
  }
  let parent;
  try {
    parent = lstatSync(path.dirname(outputPath));
  } catch {
    fail(`${name} parent directory must already exist.`);
  }
  if (!parent.isDirectory() || parent.isSymbolicLink()) {
    fail(`${name} parent must be a real directory, not a symlink.`);
  }
  try {
    lstatSync(outputPath);
    fail(`${name} already exists; replay receipts are append-only and never overwritten.`);
  } catch (error) {
    if (!(error && typeof error === "object" && error.code === "ENOENT")) throw error;
  }
  return outputPath;
}

function writeExclusiveReceipt(outputPath, wire) {
  const temporaryPath = `${outputPath}.pending-${process.pid}-${randomBytes(8).toString("hex")}`;
  let temporaryCreated = false;
  try {
    writeFileSync(temporaryPath, wire, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
    temporaryCreated = true;
    // A hard-link publish is atomic and refuses an output path that appeared
    // after preflight. Removing the private temporary name leaves the one
    // append-only receipt inode; no rename can overwrite earlier evidence.
    linkSync(temporaryPath, outputPath);
  } finally {
    if (temporaryCreated) {
      try {
        unlinkSync(temporaryPath);
      } catch {
        // If cleanup itself fails, the validator still recognizes only the
        // exact operator-selected output path, never this pending name.
      }
    }
  }
}

function boundedIntegerEnv(name, fallback, minimum, maximum) {
  const raw = process.env[name]?.trim();
  if (!raw && fallback !== undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

function validHeaderName(value) {
  return typeof value === "string" && HEADER_NAME_PATTERN.test(value) && value !== "x-site-behavior-lab-access-token";
}

function publicError(value) {
  return typeof value?.error === "string" && value.error.trim() ? value.error : "no public error detail";
}

function publicException(error) {
  return error instanceof Error && error.name ? error.name : "network error";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fail(message) {
  console.error(`FAIL ${message}`);
  process.exit(1);
}
