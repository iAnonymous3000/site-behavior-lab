import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const SCRIPT = path.join(process.cwd(), "scripts/smoke-durable-job-replay.mjs");
const SAFE_BASE_ENV = {
  ...process.env,
  DURABLE_REPLAY_ACCESS_TOKEN: "test-access-token",
  DURABLE_REPLAY_TARGET_URL: "https://example.com/",
  DURABLE_REPLAY_FAULT_TOKEN: "test-fault-token",
  DURABLE_REPLAY_FAULT_MODE: "lease-expiry",
  DURABLE_REPLAY_NO_POLL_MS: "240000",
  DURABLE_REPLAY_EXPECTED_SHA: "a".repeat(40),
  DURABLE_REPLAY_CONFIRM: "I_ACKNOWLEDGE_THIS_SUBMITS_A_LIVE_SCAN"
};

test("durable replay smoke is positively staging-gated with no production override", async () => {
  const source = await readFile(path.join(process.cwd(), "scripts/smoke-durable-job-replay.mjs"), "utf8");

  assert.match(source, /DURABLE_REPLAY_STAGING_CONFIRM/);
  assert.match(source, /faultInjection\.environment=staging/);
  assert.match(source, /injection\.environment !== "staging"/);
  assert.match(source, /production scanner is never a valid durable replay canary target/i);
  assert.match(source, /guardedFetch\(`\$\{baseUrl\}\/api\/health`[\s\S]*redirect: "error"/);
  assert.match(source, /durable\.coordinatorOrigin !== baseUrl/);
  assert.match(source, /injection\.attemptEvidence !== true/);
  assert.match(source, /injection\.completionBeforeStatusRequestEvidence !== true/);
  assert.match(source, /injection\.wholeOriginAccessGate !== true/);
  assert.match(source, /value\.status !== "ok"/);
  assert.match(source, /value\.warnings\.length !== 0/);
  assert.match(source, /value\.scansAvailable !== true/);
  assert.match(source, /value\.checks\?\.chromiumSandbox !== "enabled"/);
  assert.match(source, /value\.checks\?\.publicR2Reports\?\.status !== "enabled"/);
  assert.match(source, /value\.checks\?\.reportStore\?\.kind !== "r2"/);
  assert.match(source, /finishedBeforeStatusRequest !== true/);
  assert.match(source, /health\.deployment !== expectedDeployment/);
  assert.match(source, /readAttestedStagingHealth\("post-recovery"\)/);
  assert.match(source, /DURABLE_REPLAY_RECEIPT_PATH/);
  assert.match(source, /DURABLE_REPLAY_ORIGIN_LABEL/);
  assert.match(source, /buildDurableReplayReceipt\(/);
  assert.match(source, /flag: "wx"/);
  assert.match(source, /mode: 0o600/);
  assert.match(source, /withHttpOperationDeadline\(/);
  assert.match(source, /timeoutMs: REQUEST_TIMEOUT_MS/);
  assert.match(source, /readResponseJsonWithinLimit\(response/);
  assert.match(source, /maxBytes: JSON_RESPONSE_MAX_BYTES/);
  assert.match(source, /reading exactly one terminal status snapshot/i);
  assert.match(source, /const value = status\?\.durable\?\.attempts/);
  assert.match(source, /lease-expiry replay requires exactly two fenced attempts/);
  assert.doesNotMatch(source, /MAX_POLLS|POLL_INTERVAL_MS|pollTerminalStatus/);
  assert.doesNotMatch(source, /WARN The status endpoint does not expose an attempt count/);
  assert.doesNotMatch(source, /DURABLE_REPLAY_ALLOW_PRODUCTION/);
  assert.doesNotMatch(source, /I_ACKNOWLEDGE_THIS_IS_PRODUCTION/);
});

test("durable replay smoke refuses production before making a health request", () => {
  const result = spawnSync(process.execPath, [SCRIPT], {
    encoding: "utf8",
    env: {
      ...SAFE_BASE_ENV,
      DURABLE_REPLAY_BASE_URL: "https://scan.sitebehavior.org.",
      DURABLE_REPLAY_STAGING_CONFIRM: "I_ACKNOWLEDGE_THIS_IS_A_GATED_STAGING_DEPLOYMENT",
      // A stale value from the old interface must not restore a production escape hatch.
      DURABLE_REPLAY_ALLOW_PRODUCTION: "I_ACKNOWLEDGE_THIS_IS_PRODUCTION"
    }
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /production scanner is never a valid durable replay canary target/i);
});

test("durable replay smoke requires independent operator staging confirmation before health", () => {
  const result = spawnSync(process.execPath, [SCRIPT], {
    encoding: "utf8",
    env: {
      ...SAFE_BASE_ENV,
      DURABLE_REPLAY_BASE_URL: "https://staging-scanner.example"
    }
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /DURABLE_REPLAY_STAGING_CONFIRM/);
});

test("durable replay smoke rejects an unreceiptable no-poll interval before health", () => {
  const result = spawnSync(process.execPath, [SCRIPT], {
    encoding: "utf8",
    env: {
      ...SAFE_BASE_ENV,
      DURABLE_REPLAY_NO_POLL_MS: "3600001",
      DURABLE_REPLAY_BASE_URL: "https://staging-scanner.example"
    }
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /DURABLE_REPLAY_NO_POLL_MS must be an integer from 1 to 3600000/);
});

test("durable replay smoke requires an append-only receipt path before health", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "sbl-durable-replay-existing-"));
  const receiptPath = path.join(directory, "receipt.json");
  writeFileSync(receiptPath, "do-not-overwrite\n");
  try {
    const result = spawnSync(process.execPath, [SCRIPT], {
      encoding: "utf8",
      env: {
        ...SAFE_BASE_ENV,
        DURABLE_REPLAY_BASE_URL: "https://staging-scanner.example",
        DURABLE_REPLAY_STAGING_CONFIRM: "I_ACKNOWLEDGE_THIS_IS_A_GATED_STAGING_DEPLOYMENT",
        DURABLE_REPLAY_ORIGIN_LABEL: "test-staging",
        DURABLE_REPLAY_RECEIPT_PATH: receiptPath
      }
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /already exists.*never overwritten/i);
    assert.equal(readFileSync(receiptPath, "utf8"), "do-not-overwrite\n");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("durable replay runbook binds coordinator and secrets to staging", async () => {
  const source = await readFile(path.join(process.cwd(), "docs/go-live-public-scanner.md"), "utf8");

  assert.match(source, /"environment": "staging"/);
  assert.match(source, /DURABLE_REPLAY_STAGING_CONFIRM=I_ACKNOWLEDGE_THIS_IS_A_GATED_STAGING_DEPLOYMENT/);
  assert.match(
    source,
    /SITE_BEHAVIOR_LAB_DURABLE_JOBS_COORDINATOR_URL=https:\/\/<gated-staging-scanner>/
  );
  assert.match(source, /staging-only key and internal token/i);
  assert.match(source, /production Durable Object namespace[\s\S]*R2 bucket/);
  assert.match(source, /DURABLE_REPLAY_RECEIPT_PATH="\$receipt_path"/);
  assert.match(source, /run_durable_replay lease-expiry "\$LEASE_EXPIRY_RECEIPT"/);
  assert.match(source, /run_durable_replay lost-resolve "\$LOST_RESOLVE_RECEIPT"/);
  assert.match(source, /validate-durable-replay-receipts\.mjs/);
  assert.match(source, /same full deployment[\s\S]*same labeled origin digest/);
});

test("durable replay refuses a nonterminal first post-idle snapshot without polling again", async () => {
  let statusReads = 0;
  const result = await runLocalCanary((request, response, baseUrl) => {
    if (request.url === "/api/scans/20260719-11111111111111111111111111111111") {
      statusReads += 1;
      return sendJson(response, 200, {
        ok: true,
        status: "queued",
        durable: { attempts: 2, faultMode: "lease-expiry", triggered: true, triggeredGeneration: 1 }
      });
    }
    return standardCanaryRoute(request, response, baseUrl);
  });

  assert.equal(result.status, 1);
  assert.equal(statusReads, 1);
  assert.match(result.stderr, /first post-idle status snapshot was queued/i);
});

test("durable replay ignores contradictory attempt fields outside durable evidence", async () => {
  const result = await runLocalCanary((request, response, baseUrl) => {
    if (request.url === "/api/scans/20260719-11111111111111111111111111111111") {
      return sendJson(response, 200, {
        ok: true,
        status: "succeeded",
        attempts: 2,
        progress: { attempts: 2 },
        durable: {
          attempts: 1,
          faultMode: "lease-expiry",
          triggered: true,
          triggeredGeneration: 1,
          finishedBeforeStatusRequest: true
        }
      });
    }
    return standardCanaryRoute(request, response, baseUrl);
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /lease-expiry replay requires exactly two fenced attempts/i);
});

test("durable replay re-attests the exact staging deployment after recovery", async () => {
  let healthReads = 0;
  const result = await runLocalCanary((request, response, baseUrl) => {
    if (request.url === "/api/health") healthReads += 1;
    if (request.url === `/api/scans/${JOB_ID}`) {
      return sendJson(response, 200, {
        ok: true,
        status: "succeeded",
        durable: {
          attempts: 2,
          faultMode: "lease-expiry",
          triggered: true,
          triggeredGeneration: 1,
          finishedBeforeStatusRequest: true
        }
      });
    }
    return standardCanaryRoute(request, response, baseUrl);
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(healthReads, 2);
  assert.ok(result.receipt);
  assert.equal(result.receipt.mode, "lease-expiry");
  assert.equal(result.receipt.expectedDeploymentSha, SAFE_BASE_ENV.DURABLE_REPLAY_EXPECTED_SHA);
  assert.equal(result.receipt.execution.jobId, JOB_ID);
  assert.equal(result.receipt.execution.reportId, REPORT_ID);
  assert.equal(result.receipt.execution.attempts, 2);
  assert.equal(result.receipt.execution.finishedBeforeStatusRequest, true);
  assert.equal(result.receipt.preHealth.identitySha256, result.receipt.postHealth.identitySha256);
  const receiptWire = JSON.stringify(result.receipt);
  assert.doesNotMatch(receiptWire, /test-access-token|test-fault-token|https:\/\/example\.com/);
  assert.doesNotMatch(receiptWire, /http:\/\/127\.0\.0\.1/);
  assert.match(result.stdout, /PASS lease-expiry recovered the same reportId/);
  assert.match(result.stdout, /replay receipt.*sha256:/i);
});

test("durable replay refuses degraded staging before submitting a scan", async () => {
  let scanSubmissions = 0;
  const result = await runLocalCanary((request, response, baseUrl) => {
    if (request.url === "/api/health") {
      const health = standardCanaryHealth(baseUrl);
      health.status = "degraded";
      health.warnings = ["sandbox unavailable"];
      return sendJson(response, 200, health);
    }
    if (request.url === "/api/scan") scanSubmissions += 1;
    return standardCanaryRoute(request, response, baseUrl);
  });

  assert.equal(result.status, 1);
  assert.equal(scanSubmissions, 0);
  assert.match(result.stderr, /status=ok with an explicitly empty warnings array/i);
});

type CanaryHandler = (
  request: IncomingMessage,
  response: ServerResponse,
  baseUrl: string
) => void;

const JOB_ID = "20260719-11111111111111111111111111111111";
const REPORT_ID = "20260719-22222222222222222222222222222222";

async function runLocalCanary(handler: CanaryHandler): Promise<{
  status: number | null;
  stdout: string;
  stderr: string;
  receipt?: Record<string, any>;
}> {
  let baseUrl = "";
  const receiptDirectory = mkdtempSync(path.join(tmpdir(), "sbl-durable-replay-"));
  const receiptPath = path.join(receiptDirectory, "receipt.json");
  const server = createServer((request, response) => handler(request, response, baseUrl));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not bind local canary server.");
  baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [SCRIPT], {
        env: {
          ...SAFE_BASE_ENV,
          DURABLE_REPLAY_BASE_URL: baseUrl,
          DURABLE_REPLAY_NO_POLL_MS: "1",
          DURABLE_REPLAY_REQUEST_TIMEOUT_MS: "2000",
          DURABLE_REPLAY_STAGING_CONFIRM: "I_ACKNOWLEDGE_THIS_IS_A_GATED_STAGING_DEPLOYMENT",
          DURABLE_REPLAY_ORIGIN_LABEL: "test-staging",
          DURABLE_REPLAY_RECEIPT_PATH: receiptPath
        }
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.setEncoding("utf8").on("data", (chunk) => {
        stderr += chunk;
      });
      child.once("error", reject);
      child.once("close", (status) => resolve({ status, stdout, stderr }));
    });
    try {
      return { ...result, receipt: JSON.parse(readFileSync(receiptPath, "utf8")) };
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return result;
      throw error;
    }
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
    rmSync(receiptDirectory, { recursive: true, force: true });
  }
}

function standardCanaryRoute(
  request: IncomingMessage,
  response: ServerResponse,
  baseUrl: string
): void {
  if (request.url === "/api/health") {
    return sendJson(response, 200, standardCanaryHealth(baseUrl));
  }
  if (request.url === "/api/scan" && request.method === "POST") {
    return sendJson(response, 202, {
      ok: true,
      jobId: JOB_ID,
      reportId: REPORT_ID,
      status: "queued",
      statusPath: `/api/scans/${JOB_ID}`
    });
  }
  if (request.url === `/api/reports/${REPORT_ID}`) {
    return sendJson(response, 200, { share: { id: REPORT_ID } });
  }
  sendJson(response, 404, { error: "not found" });
}

function standardCanaryHealth(baseUrl: string): Record<string, unknown> {
  return {
    ok: true,
    status: "ok",
    warnings: [],
    scansAvailable: true,
    authenticated: true,
    openAccess: false,
    deployment: SAFE_BASE_ENV.DURABLE_REPLAY_EXPECTED_SHA,
    checks: {
      chromiumSandbox: "enabled",
      publicR2Reports: { status: "enabled" },
      reportStore: { kind: "r2" },
      durableJobs: {
        requested: true,
        enabled: true,
        readiness: "ready",
        coordinatorOrigin: baseUrl,
        faultInjection: {
          environment: "staging",
          enabled: true,
          modes: ["lease-expiry", "lost-resolve"],
          modeHeaderName: "x-staging-fault-mode",
          tokenHeaderName: "x-staging-fault-token",
          minimumNoPollMs: 1,
          attemptEvidence: true,
          completionBeforeStatusRequestEvidence: true,
          wholeOriginAccessGate: true
        }
      }
    }
  };
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}
