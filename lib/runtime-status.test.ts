import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { runtimeStatus } from "./runtime-status";

const SCAN_ACCESS_TOKEN_ENV = "SITE_BEHAVIOR_LAB_SCAN_ACCESS_TOKEN";
const REPORT_STORE_DIR_ENV = "SITE_BEHAVIOR_LAB_REPORT_STORE_DIR";
const SCANNER_EGRESS_ENV = "SITE_BEHAVIOR_LAB_SCANNER_EGRESS";

afterEach(() => {
  delete process.env[SCAN_ACCESS_TOKEN_ENV];
  delete process.env[REPORT_STORE_DIR_ENV];
  delete process.env[SCANNER_EGRESS_ENV];
});

test("runtimeStatus reports degraded status for open local defaults", async () => {
  const status = await runtimeStatus(loadedAdblock);

  assert.equal(status.ok, true);
  assert.equal(status.status, "degraded");
  assert.deepEqual(status.checks.adblock, {
    active: true,
    engine: "loaded",
    source: "Brave default ad-block lists",
    lists: 31,
    fetchedAt: new Date(0).toISOString()
  });
  assert.equal(status.checks.scanAccess, "open");
  assert.equal(status.authenticated, false);
  assert.equal(status.openAccess, true);
  assert.equal(status.turnstile, false);
  assert.equal(status.checks.dnsRebindingGuard, "connect-time-proxy");
  assert.equal(status.checks.reportStore.configuredPath, false);
  assert.equal(status.checks.scannerEgress, "default");
  assert.equal(status.warnings.length, 3);
});

test("runtimeStatus reports ok status when production controls are configured", async () => {
  process.env[SCAN_ACCESS_TOKEN_ENV] = "secret-key";
  process.env[REPORT_STORE_DIR_ENV] = "/var/lib/site-behavior-lab/reports";
  process.env[SCANNER_EGRESS_ENV] = "iad-lab-egress";

  const status = await runtimeStatus(loadedAdblock);

  assert.equal(status.ok, true);
  assert.equal(status.status, "ok");
  assert.equal(status.checks.adblock.engine, "loaded");
  assert.equal(status.checks.scanAccess, "configured");
  // A gated container must advertise authentication so the static UI sends the key.
  assert.equal(status.authenticated, true);
  assert.equal(status.openAccess, false);
  assert.equal(status.checks.dnsRebindingGuard, "connect-time-proxy");
  assert.deepEqual(status.checks.reportStore, {
    kind: "filesystem",
    configuredPath: true,
    maxAgeDays: 7,
    maxCount: 500
  });
  assert.equal(status.checks.scannerEgress, "configured");
  assert.deepEqual(status.capabilities, {
    singleScan: true,
    gpcComparison: true,
    shieldsComparison: true,
    savedReports: true
  });
  assert.deepEqual(status.warnings, []);
});

test("runtimeStatus degrades when Brave adblock cannot load", async () => {
  process.env[SCAN_ACCESS_TOKEN_ENV] = "secret-key";
  process.env[REPORT_STORE_DIR_ENV] = "/var/lib/site-behavior-lab/reports";
  process.env[SCANNER_EGRESS_ENV] = "iad-lab-egress";

  const status = await runtimeStatus(async () => ({
    active: false,
    engine: "unavailable",
    source: "Brave default ad-block lists",
    lists: 31,
    fetchedAt: new Date(0).toISOString()
  }));

  assert.equal(status.ok, true);
  assert.equal(status.status, "degraded");
  assert.equal(status.checks.adblock.engine, "unavailable");
  // Shields comparison capability must drop when the engine cannot load, so the
  // static UI disables that toggle instead of offering a degraded comparison.
  assert.equal(status.capabilities.shieldsComparison, false);
  assert.equal(status.capabilities.gpcComparison, true);
  assert.equal(status.capabilities.singleScan, true);
  assert.deepEqual(status.warnings, ["Brave Shields classification is unavailable; tracker labels use the curated catalog only."]);
});

async function loadedAdblock() {
  return {
    active: true as const,
    engine: "loaded" as const,
    source: "Brave default ad-block lists",
    lists: 31,
    fetchedAt: new Date(0).toISOString()
  };
}
