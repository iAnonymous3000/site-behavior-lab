#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";

// Operator-only live canary for encrypted scheduled rescans. It intentionally
// performs one preflight, creates one watch with its first durable job, sends
// no request at all during the configured blind window, then reads exactly one
// job status, one watch status, and deletes the watch.

const LIVE_CONFIRMATION = "I_ACKNOWLEDGE_THIS_CREATES_A_LIVE_SCHEDULED_RESCAN";
const STAGING_CONFIRMATION = "I_ACKNOWLEDGE_THIS_IS_A_GATED_STAGING_DEPLOYMENT";
const WATCH_ID_PATTERN = /^[0-9a-f]{32}$/;
const CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const JOB_ID_PATTERN = /^[0-9]{8}-[0-9a-f]{32}$/;
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const SAFE_ERROR_CODE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MAX_RUNS = 5;
const WATCH_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const WATCH_ID_DERIVATION_DOMAIN = "site-behavior-lab/encrypted-watch/id/v1";

class SmokeFailure extends Error {
  constructor(message) {
    super(message);
    this.name = "SmokeFailure";
  }
}

let REQUEST_TIMEOUT_MS = 30_000;
let baseUrl = "";
let accessToken = "";
let targetUrl = "";
let expectedDeployment = "";
let noRequestMs = 0;
let cleanup = null;
try {
  REQUEST_TIMEOUT_MS = positiveIntegerEnv("ENCRYPTED_WATCH_SMOKE_REQUEST_TIMEOUT_MS", 30_000);
  baseUrl = requiredOrigin("ENCRYPTED_WATCH_SMOKE_BASE_URL");
  accessToken = requiredHeaderValue("ENCRYPTED_WATCH_SMOKE_ACCESS_TOKEN");
  targetUrl = requiredTargetUrl("ENCRYPTED_WATCH_SMOKE_TARGET_URL");
  expectedDeployment = requiredCommitSha("ENCRYPTED_WATCH_SMOKE_EXPECTED_SHA");
  noRequestMs = positiveIntegerEnv("ENCRYPTED_WATCH_SMOKE_NO_REQUEST_MS");
  if (process.env.ENCRYPTED_WATCH_SMOKE_CONFIRM !== LIVE_CONFIRMATION) {
    abort(`Set ENCRYPTED_WATCH_SMOKE_CONFIRM=${LIVE_CONFIRMATION} to acknowledge the live watch creation.`);
  }
  if (process.env.ENCRYPTED_WATCH_SMOKE_STAGING_CONFIRM !== STAGING_CONFIRMATION) {
    abort(
      `Set ENCRYPTED_WATCH_SMOKE_STAGING_CONFIRM=${STAGING_CONFIRMATION} only after verifying that the origin is ` +
        "a separate access-token-gated staging deployment."
    );
  }
  if (normalizedHostname(baseUrl) === "scan.sitebehavior.org") {
    abort("The production scanner is never a valid encrypted-watch canary target; use gated staging.");
  }

  await readAttestedStagingHealth("pre-creation");

  const clientCredential = mintClientCredential();
  cleanup = {
    watchId: clientCredential.watchId,
    capability: clientCredential.capability,
    // A lost POST response may still mean a committed first run. Even cleanup
    // observes the blind window before sending a capability-authenticated DELETE.
    notBefore: Date.now() + REQUEST_TIMEOUT_MS + noRequestMs
  };
  const creationUrl = `${baseUrl}/api/watches`;
  assertLoggableUrl(creationUrl, "watch creation URL", [clientCredential.capability, targetUrl]);
  const creationResponse = await guardedFetch(creationUrl, "/api/watches", {
    method: "POST",
    headers: capabilityHeaders(clientCredential.capability, {
      "content-type": "application/json; charset=utf-8"
    }),
    body: JSON.stringify({ url: targetUrl, device: "desktop", gpcEnabled: true }),
    cache: "no-store",
    redirect: "error"
  });
  const creationPayload = await readJson(creationResponse, "/api/watches");
  const creation = parseWatchStatus(creationPayload, true);
  if (
    (creationResponse.status !== 200 && creationResponse.status !== 201) ||
    !creation ||
    creation.watchId !== clientCredential.watchId ||
    creation.capability !== clientCredential.capability
  ) {
    abort("The staging origin did not atomically create a watch and its first durable run.");
  }
  cleanup = {
    watchId: creation.watchId,
    capability: creation.capability,
    notBefore: Date.now() + noRequestMs
  };
  const initialRun = creation.runs[0];
  if (
    !initialRun ||
    initialRun.sequence !== 1 ||
    initialRun.admittedAt === null ||
    initialRun.jobId === null ||
    initialRun.statusPath === null ||
    initialRun.reportId === null
  ) {
    abort("The creation response did not expose the first bounded run link.");
  }
  assertLoggableUrl(new URL(creation.statusPath, `${baseUrl}/`).href, "watch status URL", [
    creation.capability,
    targetUrl
  ]);
  assertLoggableUrl(new URL(initialRun.statusPath, `${baseUrl}/`).href, "initial run status URL", [
    creation.capability,
    targetUrl
  ]);
  if (JSON.stringify({ ...creationPayload, capability: undefined }).includes(targetUrl)) {
    abort("The creation metadata reflected the plaintext target.");
  }

  console.log(
    `Accepted encrypted watch ${creation.watchId} with initial job ${initialRun.jobId}. ` +
      `Sending no status, health, or report request for ${noRequestMs} ms.`
  );
  await sleep(noRequestMs);
  console.log("No-request window complete; reading exactly one initial-job status snapshot.");

  const initialStatusUrl = new URL(initialRun.statusPath, `${baseUrl}/`).href;
  const initialStatusResponse = await guardedFetch(initialStatusUrl, "/api/scans/:id", {
    headers: accessHeaders(),
    cache: "no-store",
    redirect: "error"
  });
  const initialStatus = await readJson(initialStatusResponse, "/api/scans/:id");
  if (
    !initialStatusResponse.ok ||
    initialStatus?.ok !== true ||
    initialStatus.jobId !== initialRun.jobId ||
    initialStatus.status !== "succeeded"
  ) {
    abort(
      "The single post-wait job snapshot was not succeeded. Increase ENCRYPTED_WATCH_SMOKE_NO_REQUEST_MS; " +
        "the canary deliberately does not poll."
    );
  }
  if (initialStatus.report !== undefined && initialStatus.report?.share?.id !== initialRun.reportId) {
    abort("The initial job returned a report other than the admission-linked report capability.");
  }

  const watchStatusUrl = new URL(creation.statusPath, `${baseUrl}/`).href;
  const watchStatusResponse = await guardedFetch(watchStatusUrl, "/api/watches/:id", {
    headers: capabilityHeaders(creation.capability),
    cache: "no-store",
    redirect: "error"
  });
  const watchStatusPayload = await readJson(watchStatusResponse, "/api/watches/:id");
  const watchStatus = parseWatchStatus(watchStatusPayload, false);
  if (!watchStatusResponse.ok || !watchStatus || watchStatus.watchId !== creation.watchId) {
    abort("The capability-authenticated watch metadata could not be read.");
  }
  const readbackRun = watchStatus.runs.find((run) => run.jobId === initialRun.jobId);
  if (!readbackRun || readbackRun.reportId !== initialRun.reportId || readbackRun.status !== "succeeded") {
    abort("The watch history did not retain and resolve its first durable run.");
  }
  if (
    JSON.stringify(watchStatusPayload).includes(creation.capability) ||
    JSON.stringify(watchStatusPayload).includes(targetUrl)
  ) {
    abort("The public watch status reflected capability or plaintext target material.");
  }

  const deletionResponse = await guardedFetch(watchStatusUrl, "DELETE /api/watches/:id", {
    method: "DELETE",
    headers: capabilityHeaders(creation.capability),
    cache: "no-store",
    redirect: "error"
  });
  const deletion = await readJson(deletionResponse, "DELETE /api/watches/:id");
  if (
    !deletionResponse.ok ||
    !hasExactKeys(deletion, ["ok", "watchId", "state"]) ||
    deletion.ok !== true ||
    deletion.watchId !== creation.watchId ||
    deletion.state !== "deleted"
  ) {
    abort("The capability-authenticated watch deletion was not acknowledged.");
  }
  cleanup = null;

  await readAttestedStagingHealth("post-deletion");
  console.log(
    `PASS Encrypted watch ${creation.watchId} admitted one durable run, retained bounded metadata, and was deleted.`
  );
} catch (error) {
  if (cleanup) await bestEffortDelete(cleanup);
  console.error(`FAIL ${publicFailure(error)}`);
  process.exitCode = 1;
}

async function readAttestedStagingHealth(phase) {
  const healthUrl = `${baseUrl}/api/health`;
  assertLoggableUrl(healthUrl, `${phase} health URL`, []);
  const response = await guardedFetch(healthUrl, "/api/health", {
    headers: accessHeaders(),
    cache: "no-store",
    redirect: "error"
  });
  const health = await readJson(response, "/api/health");
  if (!response.ok || health?.ok !== true || health.status !== "ok") {
    abort(`The ${phase} staging health response is not ready.`);
  }
  if (!Array.isArray(health.warnings) || health.warnings.length !== 0) {
    abort(`The ${phase} staging health response must contain an explicitly empty warnings array.`);
  }
  if (health.authenticated !== true || health.openAccess !== false) {
    abort(`The ${phase} deployment is not positively attested as access-token gated.`);
  }
  if (health.deployment !== expectedDeployment) {
    abort(`The ${phase} deployment does not match the exact reviewed commit.`);
  }
  const durable = health.checks?.durableJobs;
  if (!durable || durable.requested !== true || durable.enabled !== true || durable.readiness !== "ready") {
    abort(`The ${phase} deployment does not advertise ready durable jobs.`);
  }
  const watches = health.checks?.encryptedWatches;
  if (!watches || watches.requested !== true || watches.enabled !== true || watches.readiness !== "ready") {
    abort(`The ${phase} deployment does not advertise ready encrypted watches.`);
  }
  if (health.capabilities?.scheduledRescans !== true) {
    abort(`The ${phase} deployment does not advertise the scheduled-rescan capability.`);
  }
  return health;
}

function parseWatchStatus(value, withCapability) {
  const keys = [
    "ok",
    "watchId",
    "statusPath",
    "state",
    "createdAt",
    "expiresAt",
    "nextRunAt",
    "attemptCount",
    "maxAttempts",
    "runs",
    ...(withCapability ? ["capability"] : [])
  ];
  if (!hasExactKeys(value, keys) || value.ok !== true || !WATCH_ID_PATTERN.test(value.watchId)) return null;
  if (value.statusPath !== `/api/watches/${value.watchId}`) return null;
  if (value.state !== "active" && value.state !== "leased" && value.state !== "completed") return null;
  if (!timestamp(value.createdAt) || value.expiresAt !== value.createdAt + WATCH_TTL_MS) return null;
  if (value.nextRunAt !== null && !timestamp(value.nextRunAt)) return null;
  if (value.state === "completed" ? value.nextRunAt !== null : value.nextRunAt === null) return null;
  if (
    !Number.isSafeInteger(value.attemptCount) ||
    value.attemptCount < 1 ||
    value.attemptCount > MAX_RUNS ||
    value.maxAttempts !== MAX_RUNS ||
    !Array.isArray(value.runs) ||
    value.runs.length < 1 ||
    value.runs.length !== value.attemptCount ||
    value.runs.length > MAX_RUNS
  ) {
    return null;
  }
  if (withCapability ? !CAPABILITY_PATTERN.test(value.capability) : "capability" in value) return null;

  const runs = [];
  for (const [index, candidate] of value.runs.entries()) {
    const parsed = parseRun(candidate, value.createdAt, value.expiresAt);
    if (!parsed || parsed.sequence !== index + 1) return null;
    runs.push(parsed);
  }
  return { ...value, runs };
}

function parseRun(value, createdAt, expiresAt) {
  if (
    !hasExactKeys(value, [
      "sequence",
      "admittedAt",
      "jobId",
      "statusPath",
      "reportId",
      "status",
      "errorCode"
    ]) ||
    !Number.isSafeInteger(value.sequence) ||
    value.sequence < 1 ||
    value.sequence > MAX_RUNS
  ) {
    return null;
  }
  if (
    value.admittedAt === null &&
    value.jobId === null &&
    value.statusPath === null &&
    value.reportId === null &&
    value.status === "failed" &&
    value.errorCode === "admission-failed"
  ) {
    return value;
  }
  if (
    !timestamp(value.admittedAt) ||
    value.admittedAt < createdAt ||
    value.admittedAt >= expiresAt ||
    !JOB_ID_PATTERN.test(value.jobId) ||
    !JOB_ID_PATTERN.test(value.reportId) ||
    value.jobId === value.reportId ||
    value.statusPath !== `/api/scans/${value.jobId}` ||
    !["queued", "running", "succeeded", "failed", "expired", "cancelled"].includes(value.status) ||
    (value.errorCode !== null &&
      (typeof value.errorCode !== "string" || !SAFE_ERROR_CODE_PATTERN.test(value.errorCode)))
  ) {
    return null;
  }
  return value;
}

async function bestEffortDelete({ watchId, capability, notBefore }) {
  const remainingBlindWindow = Math.max(0, notBefore - Date.now());
  if (remainingBlindWindow > 0) await sleep(remainingBlindWindow);
  const url = new URL(`/api/watches/${watchId}`, `${baseUrl}/`).href;
  const retryDelays = [0, 1_000, 5_000, 15_000];
  for (const delay of retryDelays) {
    if (delay > 0) await sleep(delay);
    try {
      assertLoggableUrl(url, "cleanup watch URL", [capability, targetUrl]);
      const response = await guardedFetch(url, "cleanup DELETE /api/watches/:id", {
        method: "DELETE",
        headers: capabilityHeaders(capability),
        cache: "no-store",
        redirect: "error"
      });
      if (response.status === 404) return;
      const deletion = await readJson(response, "cleanup DELETE /api/watches/:id");
      if (
        response.ok &&
        hasExactKeys(deletion, ["ok", "watchId", "state"]) &&
        deletion.ok === true &&
        deletion.watchId === watchId &&
        deletion.state === "deleted"
      ) {
        return;
      }
    } catch {
      // Retry a bounded number of times while the capability remains in RAM.
    }
  }
  console.error(
    "WARN Watch cleanup could not be confirmed after four bounded attempts; the watch will expire automatically within 30 days."
  );
}

function accessHeaders(extra = {}) {
  return { ...extra, "x-site-behavior-lab-access-token": accessToken };
}

function capabilityHeaders(capability, extra = {}) {
  return accessHeaders({ ...extra, "x-site-behavior-lab-watch-capability": capability });
}

function mintClientCredential() {
  const tokenBytes = randomBytes(32);
  const capability = tokenBytes.toString("base64url");
  const digest = createHash("sha256")
    .update(WATCH_ID_DERIVATION_DOMAIN, "utf8")
    .update(Buffer.from([0]))
    .update(tokenBytes)
    .digest("hex");
  return { watchId: digest.slice(0, 32), capability };
}

async function guardedFetch(input, label, init) {
  try {
    return await fetch(input, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (error) {
    abort(`${label} failed before a valid response was received (${publicException(error)}).`);
  }
}

async function readJson(response, label) {
  if (!(response.headers.get("content-type") ?? "").includes("application/json")) {
    abort(`${label} returned HTTP ${response.status} with non-JSON content.`);
  }
  try {
    return await response.json();
  } catch {
    abort(`${label} returned invalid JSON.`);
  }
}

function assertLoggableUrl(value, label, secrets) {
  let url;
  try {
    url = new URL(value);
  } catch {
    abort(`${label} is not an absolute URL.`);
  }
  if (url.origin !== baseUrl || url.username || url.password || url.search || url.hash) {
    abort(`${label} is not a same-origin, credential-free, query-free URL.`);
  }
  const raw = url.href;
  const decoded = safeDecode(raw);
  for (const secret of secrets) {
    if (secret && (raw.includes(secret) || decoded.includes(secret))) {
      abort(`${label} contains private watch material.`);
    }
  }
}

function requiredOrigin(name) {
  const value = requiredEnv(name).replace(/\/+$/, "");
  let url;
  try {
    url = new URL(value);
  } catch {
    abort(`${name} must be an absolute scanner origin.`);
  }
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname))) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    abort(`${name} must be an HTTPS origin without credentials, path, query, or fragment (HTTP is local-only).`);
  }
  return url.origin;
}

function requiredTargetUrl(name) {
  const value = requiredEnv(name);
  let url;
  try {
    url = new URL(value);
  } catch {
    abort(`${name} must be an absolute http(s) target.`);
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.href !== value
  ) {
    abort(`${name} must be a canonical http(s) URL without credentials, query, or fragment.`);
  }
  return url.href;
}

function requiredCommitSha(name) {
  const value = requiredEnv(name);
  if (!COMMIT_SHA_PATTERN.test(value)) abort(`${name} must be the exact reviewed lowercase commit SHA.`);
  return value;
}

function requiredHeaderValue(name) {
  const value = requiredEnv(name);
  if (value.length > 4_096 || /[\r\n]/.test(value)) abort(`${name} is not a safe HTTP header value.`);
  return value;
}

function requiredEnv(name) {
  const value = process.env[name]?.trim() ?? "";
  if (!value) abort(`Set ${name}; this live canary has no implicit operator default.`);
  return value;
}

function positiveIntegerEnv(name, fallback) {
  const raw = process.env[name]?.trim();
  if (!raw && fallback !== undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) abort(`${name} must be a positive integer.`);
  return value;
}

function timestamp(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function hasExactKeys(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function normalizedHostname(origin) {
  return new URL(origin).hostname.toLowerCase().replace(/\.+$/, "");
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function publicException(error) {
  return error instanceof Error && error.name ? error.name : "network error";
}

function publicFailure(error) {
  return error instanceof SmokeFailure ? error.message : "The encrypted-watch smoke failed unexpectedly.";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function abort(message) {
  throw new SmokeFailure(message);
}
