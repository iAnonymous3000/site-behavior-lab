import assert from "node:assert/strict";
import { test } from "node:test";
import { asScanRuntimeHealth, isScanRuntimeHealth } from "./scan-runtime-health";

test("isScanRuntimeHealth accepts a minimal healthy payload", () => {
  assert.equal(isScanRuntimeHealth({ ok: true }), true);
  assert.equal(isScanRuntimeHealth({ ok: false, error: "Report storage is not configured." }), true);
});

test("isScanRuntimeHealth accepts a full worker-shaped payload", () => {
  const payload = {
    ok: true,
    status: "ok",
    runtime: "cloudflare-worker",
    storage: "kv",
    authenticated: true,
    openAccess: false,
    turnstile: false,
    capabilities: { singleScan: true, gpcComparison: true, shieldsComparison: false, savedReports: true },
    limits: { publicScanRateLimitPerMinute: 6, publicScanRateLimitPerDay: 120 }
  };
  assert.equal(isScanRuntimeHealth(payload), true);
});

test("isScanRuntimeHealth rejects malformed payloads", () => {
  assert.equal(isScanRuntimeHealth(null), false);
  assert.equal(isScanRuntimeHealth("ok"), false);
  assert.equal(isScanRuntimeHealth({}), false);
  assert.equal(isScanRuntimeHealth({ ok: "yes" }), false);
  assert.equal(isScanRuntimeHealth({ ok: true, status: "broken" }), false);
  assert.equal(isScanRuntimeHealth({ ok: true, capabilities: { gpcComparison: "maybe" } }), false);
});

test("asScanRuntimeHealth returns its argument unchanged", () => {
  const health = { ok: true, status: "ok" as const };
  assert.equal(asScanRuntimeHealth(health), health);
});
