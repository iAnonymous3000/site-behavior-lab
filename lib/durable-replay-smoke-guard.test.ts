import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
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
  DURABLE_REPLAY_CONFIRM: "I_ACKNOWLEDGE_THIS_SUBMITS_A_LIVE_SCAN"
};

test("durable replay smoke is positively staging-gated with no production override", async () => {
  const source = await readFile(path.join(process.cwd(), "scripts/smoke-durable-job-replay.mjs"), "utf8");

  assert.match(source, /DURABLE_REPLAY_STAGING_CONFIRM/);
  assert.match(source, /faultInjection\.environment=staging/);
  assert.match(source, /injection\.environment !== "staging"/);
  assert.match(source, /production scanner is never a valid durable replay canary target/i);
  assert.match(source, /fetch\(`\$\{baseUrl\}\/api\/health`[\s\S]*redirect: "error"/);
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
});
