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
    scansAvailable: true,
    warnings: [],
    checks: { scanAccess: "configured" },
    capabilities: { singleScan: true, gpcComparison: true, shieldsComparison: false, savedReports: true },
    limits: { publicScanRateLimitPerMinute: 6, publicScanRateLimitPerDay: 120 }
  };
  assert.equal(isScanRuntimeHealth(payload), true);
});

test("isScanRuntimeHealth accepts the private shadow readiness projection", () => {
  assert.equal(
    isScanRuntimeHealth({
      ok: true,
      checks: {
        consentVerification: "enabled",
        scannerEgressRegion: "configured",
        publicR2Reports: { status: "enabled" },
        v2ShadowEmission: { status: "enabled", backend: "r2" }
      }
    }),
    true
  );
  assert.equal(isScanRuntimeHealth({ ok: true, checks: { scannerEgressRegion: "misconfigured" } }), true);
});

test("isScanRuntimeHealth rejects malformed payloads", () => {
  assert.equal(isScanRuntimeHealth(null), false);
  assert.equal(isScanRuntimeHealth("ok"), false);
  assert.equal(isScanRuntimeHealth({}), false);
  assert.equal(isScanRuntimeHealth({ ok: "yes" }), false);
  assert.equal(isScanRuntimeHealth({ ok: true, status: "broken" }), false);
  assert.equal(isScanRuntimeHealth({ ok: true, deployment: 123 }), false);
  assert.equal(isScanRuntimeHealth({ ok: true, scansAvailable: "yes" }), false);
  assert.equal(isScanRuntimeHealth({ ok: true, warnings: ["ok", 1] }), false);
  assert.equal(isScanRuntimeHealth({ ok: true, checks: { scanAccess: "broken" } }), false);
  assert.equal(isScanRuntimeHealth({ ok: true, checks: { consentVerification: "sometimes" } }), false);
  assert.equal(isScanRuntimeHealth({ ok: true, checks: { scannerEgressRegion: "unknown" } }), false);
  assert.equal(isScanRuntimeHealth({ ok: true, checks: { publicR2Reports: { status: "sometimes" } } }), false);
  assert.equal(
    isScanRuntimeHealth({ ok: true, checks: { v2ShadowEmission: { status: "enabled", backend: "public" } } }),
    false
  );
  assert.equal(
    isScanRuntimeHealth({ ok: true, checks: { v2ShadowEmission: { status: "sometimes", backend: "r2" } } }),
    false
  );
  assert.equal(isScanRuntimeHealth({ ok: true, capabilities: { gpcComparison: "maybe" } }), false);
});

test("asScanRuntimeHealth returns its argument unchanged", () => {
  const health = { ok: true, status: "ok" as const };
  assert.equal(asScanRuntimeHealth(health), health);
});
