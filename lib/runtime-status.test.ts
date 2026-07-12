import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { runtimeStatus } from "./runtime-status";

const SCAN_ACCESS_TOKEN_ENV = "SITE_BEHAVIOR_LAB_SCAN_ACCESS_TOKEN";
const REPORT_STORE_DIR_ENV = "SITE_BEHAVIOR_LAB_REPORT_STORE_DIR";
const SCANNER_EGRESS_ENV = "SITE_BEHAVIOR_LAB_SCANNER_EGRESS";
const ALLOW_UNAUTHENTICATED_SCANS_ENV = "SITE_BEHAVIOR_LAB_ALLOW_UNAUTHENTICATED_SCANS";
const REPORT_STORE_BACKEND_ENV = "SITE_BEHAVIOR_LAB_REPORT_STORE_BACKEND";
const CHROMIUM_SANDBOX_ENV = "SITE_BEHAVIOR_LAB_CHROMIUM_SANDBOX";
const BUILD_COMMIT_ENV = "SITE_BEHAVIOR_LAB_BUILD_COMMIT";

afterEach(() => {
  delete process.env[SCAN_ACCESS_TOKEN_ENV];
  delete process.env[REPORT_STORE_DIR_ENV];
  delete process.env[SCANNER_EGRESS_ENV];
  delete process.env[ALLOW_UNAUTHENTICATED_SCANS_ENV];
  delete process.env[REPORT_STORE_BACKEND_ENV];
  delete process.env[CHROMIUM_SANDBOX_ENV];
  delete process.env[BUILD_COMMIT_ENV];
});

test("runtimeStatus degrades instead of throwing when the store backend is misconfigured", async () => {
  // r2 selected with none of its credentials set: constructing the backend
  // throws, and /api/health is exactly the endpoint an operator checks when
  // the configuration is broken, so it must answer, degraded.
  process.env[REPORT_STORE_BACKEND_ENV] = "r2";
  process.env[SCAN_ACCESS_TOKEN_ENV] = "secret-key";
  process.env[SCANNER_EGRESS_ENV] = "iad-lab-egress";

  const status = await runtimeStatus(loadedAdblock);
  assert.equal(status.ok, true);
  assert.equal(status.status, "degraded");
  assert.equal(status.checks.reportStore.kind, "unavailable");
  // A broken store cannot save or serve reports; the UI must not offer share links.
  assert.equal(status.capabilities.savedReports, false);
  assert.equal(
    status.warnings.some((warning) => warning.includes("report store backend is misconfigured")),
    true
  );
});

test("runtimeStatus reports degraded status for open local defaults", async () => {
  const status = await runtimeStatus(loadedAdblock);

  assert.equal(status.ok, true);
  assert.equal(status.status, "degraded");
  assert.deepEqual(status.checks.adblock, {
    active: true,
    engine: "loaded",
    version: "adblock-rust-0.13.0",
    engineVersion: "adblock-rust-0.13.0",
    source: "Brave default ad-block lists",
    lists: 31,
    fetchedAt: new Date(0).toISOString(),
    manifestDigest: "a".repeat(64)
  });
  assert.equal(status.checks.scanAccess, "open");
  assert.equal(status.authenticated, false);
  assert.equal(status.openAccess, true);
  assert.equal(status.turnstile, false);
  assert.equal(status.checks.dnsRebindingGuard, "connect-time-proxy");
  assert.equal(status.checks.reportStore.configuredPath, false);
  assert.equal(status.checks.scannerEgress, "default");
  assert.equal(status.checks.chromiumSandbox, "disabled");
  assert.equal(status.warnings.length, 3);
});

test("runtimeStatus reports ok status when production controls are configured", async () => {
  process.env[SCAN_ACCESS_TOKEN_ENV] = "secret-key";
  process.env[REPORT_STORE_DIR_ENV] = "/var/lib/site-behavior-lab/reports";
  process.env[SCANNER_EGRESS_ENV] = "iad-lab-egress";
  process.env[CHROMIUM_SANDBOX_ENV] = "1";

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
  assert.equal(status.checks.chromiumSandbox, "enabled");
  assert.equal(status.deployment, "unknown");
  assert.deepEqual(status.capabilities, {
    singleScan: true,
    gpcComparison: true,
    shieldsComparison: true,
    consentComparison: true,
    savedReports: true,
    savedReportPages: true
  });
  assert.deepEqual(status.warnings, []);
});

test("runtimeStatus exposes only a full validated build revision", async () => {
  process.env[BUILD_COMMIT_ENV] = "A".repeat(40);
  assert.equal((await runtimeStatus(loadedAdblock)).deployment, "a".repeat(40));

  process.env[BUILD_COMMIT_ENV] = "main";
  assert.equal((await runtimeStatus(loadedAdblock)).deployment, "unknown");
});

test("runtimeStatus treats explicit open access as intentional, not a degradation", async () => {
  process.env[ALLOW_UNAUTHENTICATED_SCANS_ENV] = "1";
  process.env[REPORT_STORE_DIR_ENV] = "/var/lib/site-behavior-lab/reports";
  process.env[SCANNER_EGRESS_ENV] = "iad-lab-egress";

  const status = await runtimeStatus(loadedAdblock);

  assert.equal(status.status, "ok");
  assert.equal(status.openAccess, true);
  assert.equal(status.authenticated, false);
  // The "public visitors can start scans" notice is suppressed when open access
  // is explicit, so the public scanner reads as "Live", not "Limited".
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
    version: "adblock-rust-0.13.0" as const,
    engineVersion: "adblock-rust-0.13.0" as const,
    source: "Brave default ad-block lists",
    lists: 31,
    fetchedAt: new Date(0).toISOString(),
    manifestDigest: "a".repeat(64)
  };
}
