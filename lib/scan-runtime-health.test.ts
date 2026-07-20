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
        durableJobs: { requested: true, enabled: true, readiness: "node-ready" },
        encryptedWatches: { requested: true, enabled: true, readiness: "node-ready" },
        v2ShadowEmission: { status: "enabled", backend: "r2" }
      }
    }),
    true
  );
  assert.equal(isScanRuntimeHealth({ ok: true, checks: { scannerEgressRegion: "misconfigured" } }), true);
});

test("isScanRuntimeHealth validates the bounded durable container topology", () => {
  const durableJobs = {
    requested: true,
    enabled: true,
    readiness: "ready",
    containerSharding: { requested: true, enabled: true, readiness: "ready", shardCount: 3 }
  };
  assert.equal(isScanRuntimeHealth({ ok: true, checks: { durableJobs } }), true);
  assert.equal(
    isScanRuntimeHealth({
      ok: true,
      checks: { durableJobs: { ...durableJobs, containerSharding: { ...durableJobs.containerSharding, shardCount: 4 } } }
    }),
    false
  );
  assert.equal(
    isScanRuntimeHealth({
      ok: true,
      checks: {
        durableJobs: {
          ...durableJobs,
          containerSharding: { requested: true, enabled: false, readiness: "ready", shardCount: 3 }
        }
      }
    }),
    false
  );
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
    isScanRuntimeHealth({ ok: true, checks: { durableJobs: { requested: true, enabled: true, readiness: "ready" } } }),
    true
  );
  assert.equal(
    isScanRuntimeHealth({ ok: true, checks: { durableJobs: { requested: "yes", enabled: true, readiness: "ready" } } }),
    false
  );
  assert.equal(
    isScanRuntimeHealth({ ok: true, checks: { durableJobs: { requested: true, enabled: true, readiness: "warming" } } }),
    false
  );
  assert.equal(
    isScanRuntimeHealth({
      ok: true,
      checks: { encryptedWatches: { requested: true, enabled: true, readiness: "ready" } }
    }),
    true
  );
  assert.equal(
    isScanRuntimeHealth({
      ok: true,
      checks: { encryptedWatches: { requested: true, enabled: true, readiness: "warming" } }
    }),
    false
  );
  assert.equal(
    isScanRuntimeHealth({
      ok: true,
      checks: { encryptedWatches: { requested: true, enabled: false, readiness: "misconfigured", reasons: [42] } }
    }),
    false
  );
  assert.equal(
    isScanRuntimeHealth({
      ok: true,
      checks: { durableJobs: { requested: true, enabled: false, readiness: "misconfigured", reasons: [42] } }
    }),
    false
  );
  assert.equal(
    isScanRuntimeHealth({ ok: true, checks: { v2ShadowEmission: { status: "enabled", backend: "public" } } }),
    false
  );
  assert.equal(
    isScanRuntimeHealth({ ok: true, checks: { v2ShadowEmission: { status: "sometimes", backend: "r2" } } }),
    false
  );
  assert.equal(isScanRuntimeHealth({ ok: true, capabilities: { gpcComparison: "maybe" } }), false);
  assert.equal(isScanRuntimeHealth({ ok: true, capabilities: { scheduledRescans: "maybe" } }), false);
});

test("asScanRuntimeHealth returns its argument unchanged", () => {
  const health = { ok: true, status: "ok" as const };
  assert.equal(asScanRuntimeHealth(health), health);
});
