import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { runtimeStatus } from "./runtime-status";

const SCAN_ACCESS_TOKEN_ENV = "SITE_BEHAVIOR_LAB_SCAN_ACCESS_TOKEN";
const REPORT_STORE_DIR_ENV = "SITE_BEHAVIOR_LAB_REPORT_STORE_DIR";
const SCANNER_EGRESS_ENV = "SITE_BEHAVIOR_LAB_SCANNER_EGRESS";
const SCANNER_EGRESS_REGION_ENV = "SITE_BEHAVIOR_LAB_SCANNER_EGRESS_REGION";
const ALLOW_UNAUTHENTICATED_SCANS_ENV = "SITE_BEHAVIOR_LAB_ALLOW_UNAUTHENTICATED_SCANS";
const REPORT_STORE_BACKEND_ENV = "SITE_BEHAVIOR_LAB_REPORT_STORE_BACKEND";
const REPORT_MAX_AGE_DAYS_ENV = "SITE_BEHAVIOR_LAB_REPORT_MAX_AGE_DAYS";
const REPORT_MIN_SURVIVAL_MS_ENV = "SITE_BEHAVIOR_LAB_REPORT_MIN_SURVIVAL_MS";
const CHROMIUM_SANDBOX_ENV = "SITE_BEHAVIOR_LAB_CHROMIUM_SANDBOX";
const BUILD_COMMIT_ENV = "SITE_BEHAVIOR_LAB_BUILD_COMMIT";
const CONSENT_VERIFICATION_ENV = "SITE_BEHAVIOR_LAB_CONSENT_VERIFICATION";
const PUBLIC_R2_REPORTS_ENV = "SITE_BEHAVIOR_LAB_PUBLIC_R2_REPORTS";
const V2_SHADOW_EMISSION_ENV = "SITE_BEHAVIOR_LAB_V2_SHADOW_EMISSION";
const V2_SHADOW_BACKEND_ENV = "SITE_BEHAVIOR_LAB_V2_SHADOW_BACKEND";
const DURABLE_JOBS_ENV = "SITE_BEHAVIOR_LAB_DURABLE_JOBS";
const ENCRYPTED_WATCHES_ENV = "SITE_BEHAVIOR_LAB_ENCRYPTED_WATCHES";
const DURABLE_JOBS_INTERNAL_TOKEN_ENV = "SITE_BEHAVIOR_LAB_DURABLE_JOBS_INTERNAL_TOKEN";
const DURABLE_JOBS_COORDINATOR_URL_ENV = "SITE_BEHAVIOR_LAB_DURABLE_JOBS_COORDINATOR_URL";
const R2_ENVS = [
  "SITE_BEHAVIOR_LAB_R2_BUCKET",
  "SITE_BEHAVIOR_LAB_R2_ENDPOINT",
  "SITE_BEHAVIOR_LAB_R2_ACCESS_KEY_ID",
  "SITE_BEHAVIOR_LAB_R2_SECRET_ACCESS_KEY"
] as const;
const originalFetch = globalThis.fetch;

afterEach(() => {
  delete process.env[SCAN_ACCESS_TOKEN_ENV];
  delete process.env[REPORT_STORE_DIR_ENV];
  delete process.env[SCANNER_EGRESS_ENV];
  delete process.env[SCANNER_EGRESS_REGION_ENV];
  delete process.env.CLOUDFLARE_REGION;
  delete process.env.CLOUDFLARE_LOCATION;
  delete process.env.CLOUDFLARE_COUNTRY_A2;
  delete process.env[ALLOW_UNAUTHENTICATED_SCANS_ENV];
  delete process.env[REPORT_STORE_BACKEND_ENV];
  delete process.env[REPORT_MAX_AGE_DAYS_ENV];
  delete process.env[REPORT_MIN_SURVIVAL_MS_ENV];
  delete process.env[CHROMIUM_SANDBOX_ENV];
  delete process.env[BUILD_COMMIT_ENV];
  delete process.env[CONSENT_VERIFICATION_ENV];
  delete process.env[PUBLIC_R2_REPORTS_ENV];
  delete process.env[V2_SHADOW_EMISSION_ENV];
  delete process.env[V2_SHADOW_BACKEND_ENV];
  delete process.env[DURABLE_JOBS_ENV];
  delete process.env[ENCRYPTED_WATCHES_ENV];
  delete process.env[DURABLE_JOBS_INTERNAL_TOKEN_ENV];
  delete process.env[DURABLE_JOBS_COORDINATOR_URL_ENV];
  for (const name of R2_ENVS) delete process.env[name];
  globalThis.fetch = originalFetch;
});

test("runtimeStatus degrades instead of throwing when the store backend is misconfigured", async () => {
  // r2 selected with none of its credentials set: constructing the backend
  // throws, and /api/health is exactly the endpoint an operator checks when
  // the configuration is broken, so it must answer, degraded.
  process.env[REPORT_STORE_BACKEND_ENV] = "r2";
  process.env[SCAN_ACCESS_TOKEN_ENV] = "secret-key";
  process.env[SCANNER_EGRESS_ENV] = "github-actions-ubuntu";

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

  process.env[PUBLIC_R2_REPORTS_ENV] = "1";
  process.env[BUILD_COMMIT_ENV] = "a".repeat(40);
  process.env[CONSENT_VERIFICATION_ENV] = "1";
  const publicR2Status = await runtimeStatus(loadedAdblock);
  assert.equal(publicR2Status.scansAvailable, false);
  assert.deepEqual(publicR2Status.checks.publicR2Reports, { status: "misconfigured" });
  assert.equal(publicR2Status.warnings.some((warning) => warning.includes("required report persistence")), true);
});

test("runtimeStatus reports degraded status for open local defaults", async () => {
  const status = await runtimeStatus(loadedAdblock);

  assert.equal(status.ok, true);
  assert.equal(status.status, "degraded");
  assert.deepEqual(status.checks.adblock, {
    active: true,
    engine: "loaded",
    version: "adblock-rust-0.13.2",
    engineVersion: "adblock-rust-0.13.2",
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
  assert.equal(status.checks.scannerEgressRegion, "unrecorded");
  assert.equal(status.checks.chromiumSandbox, "disabled");
  assert.equal(status.checks.consentVerification, "disabled");
  assert.deepEqual(status.checks.publicR2Reports, { status: "disabled" });
  assert.deepEqual(status.checks.durableJobs, { requested: false, enabled: false, readiness: "disabled" });
  assert.deepEqual(status.checks.encryptedWatches, { requested: false, enabled: false, readiness: "disabled" });
  assert.deepEqual(status.checks.v2ShadowEmission, { status: "disabled", backend: "filesystem" });
  assert.equal(status.warnings.length, 3);
});

test("runtimeStatus discloses an egress label canonicalized before collection", async () => {
  process.env[SCANNER_EGRESS_ENV] = "iad-lab-egress";

  const status = await runtimeStatus(loadedAdblock);

  assert.equal(status.status, "degraded");
  assert.equal(status.checks.scannerEgress, "canonicalized");
  assert.equal(
    status.warnings.some((warning) => warning.includes("not in the reviewed public vocabulary")),
    true
  );
});

test("runtimeStatus recognizes the controlled acquisition alias without publishing it", async () => {
  process.env[SCANNER_EGRESS_ENV] = "controlled-self-hosted";

  const status = await runtimeStatus(loadedAdblock);

  assert.equal(status.checks.scannerEgress, "aliased");
  assert.equal(
    status.warnings.some((warning) => warning.includes("not in the reviewed public vocabulary")),
    false
  );
});

test("runtimeStatus reports ok status when production controls are configured", async () => {
  process.env[SCAN_ACCESS_TOKEN_ENV] = "secret-key";
  process.env[REPORT_STORE_DIR_ENV] = "/var/lib/site-behavior-lab/reports";
  process.env[SCANNER_EGRESS_ENV] = "github-actions-ubuntu";
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
    maxCount: 500,
    minSurvivalMs: 60_000,
    retentionDebtCount: 0,
    retentionMaintenanceRequired: false,
    retentionHealthy: true,
    retentionCheckedAt: status.checks.reportStore.retentionCheckedAt,
    retentionCheckMaxAgeMs: 30_000
  });
  assert.match(status.checks.reportStore.retentionCheckedAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(status.checks.scannerEgress, "configured");
  assert.equal(status.checks.scannerEgressRegion, "unrecorded");
  assert.equal(status.checks.chromiumSandbox, "enabled");
  assert.equal(status.deployment, "unknown");
  assert.deepEqual(status.capabilities, {
    singleScan: true,
    gpcComparison: true,
    shieldsComparison: true,
    consentComparison: true,
    savedReports: true,
    scheduledRescans: false,
    savedReportPages: true
  });
  assert.deepEqual(status.warnings, []);
});

test("runtimeStatus fails health and publication capabilities closed on durable retention debt", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sbl-runtime-retention-debt-"));
  try {
    process.env[SCAN_ACCESS_TOKEN_ENV] = "secret-key";
    process.env[REPORT_STORE_DIR_ENV] = dir;
    process.env[SCANNER_EGRESS_ENV] = "github-actions-ubuntu";
    process.env[CHROMIUM_SANDBOX_ENV] = "1";
    const debtDir = path.join(dir, ".retention-debt");
    await mkdir(debtDir, { recursive: true });
    await writeFile(
      path.join(debtDir, `20260721-${"a".repeat(32)}.bundle`),
      "1\n"
    );
    await writeFile(path.join(debtDir, "maintenance-required"), "1\n");
    // A directory at a bundle member path makes unlink fail while leaving the
    // ledger itself readable, modeling delete-only permission/transport debt.
    await mkdir(path.join(dir, `20260721-${"a".repeat(32)}.provenance.json`));

    const status = await runtimeStatus(loadedAdblock);
    assert.equal(status.status, "degraded");
    assert.equal(status.scansAvailable, false);
    assert.equal(status.capabilities.savedReports, false);
    assert.deepEqual(status.checks.reportStore, {
      kind: "filesystem",
      configuredPath: true,
      maxAgeDays: 7,
      maxCount: 500,
      minSurvivalMs: 60_000,
      retentionDebtCount: 1,
      retentionMaintenanceRequired: true,
      retentionHealthy: false,
      retentionCheckedAt: status.checks.reportStore.retentionCheckedAt,
      retentionCheckMaxAgeMs: 5_000
    });
    assert.match(status.checks.reportStore.retentionCheckedAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(
      status.warnings.some((warning) => warning.includes("Physical report retention")),
      true
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runtimeStatus exposes only a full validated build revision", async () => {
  process.env[BUILD_COMMIT_ENV] = "A".repeat(40);
  assert.equal((await runtimeStatus(loadedAdblock)).deployment, "a".repeat(40));

  process.env[BUILD_COMMIT_ENV] = "main";
  assert.equal((await runtimeStatus(loadedAdblock)).deployment, "unknown");
});

test("runtimeStatus makes public-r2 rollout readiness explicit and refuses misconfiguration", async () => {
  process.env[SCAN_ACCESS_TOKEN_ENV] = "secret-key";
  process.env[REPORT_STORE_DIR_ENV] = "/var/lib/site-behavior-lab/reports";
  process.env[SCANNER_EGRESS_ENV] = "github-actions-ubuntu";

  process.env[PUBLIC_R2_REPORTS_ENV] = "sometimes";
  const badFlag = await runtimeStatus(loadedAdblock);
  assert.equal(badFlag.status, "degraded");
  assert.equal(badFlag.scansAvailable, false);
  assert.deepEqual(badFlag.checks.publicR2Reports, { status: "misconfigured" });
  assert.equal(badFlag.warnings.some((warning) => warning.includes(`${PUBLIC_R2_REPORTS_ENV} must be 0, 1`)), true);

  process.env[PUBLIC_R2_REPORTS_ENV] = "1";
  const missingPrerequisites = await runtimeStatus(loadedAdblock);
  assert.equal(missingPrerequisites.status, "degraded");
  assert.equal(missingPrerequisites.scansAvailable, false);
  assert.deepEqual(missingPrerequisites.checks.publicR2Reports, { status: "misconfigured" });
  assert.equal(missingPrerequisites.warnings.some((warning) => warning.includes("full 40-character Git commit")), true);
  assert.equal(missingPrerequisites.warnings.some((warning) => warning.includes(CONSENT_VERIFICATION_ENV)), true);

  process.env[BUILD_COMMIT_ENV] = "a".repeat(40);
  process.env[CONSENT_VERIFICATION_ENV] = "1";
  process.env[SCANNER_EGRESS_REGION_ENV] = "us-west";
  const ready = await runtimeStatus(loadedAdblock);
  assert.equal(ready.status, "ok");
  assert.equal(ready.scansAvailable, true);
  assert.deepEqual(ready.checks.publicR2Reports, { status: "enabled" });
  assert.deepEqual(ready.warnings, []);
});

test("runtimeStatus exposes Node-only durable-job readiness without claiming edge readiness", async () => {
  process.env[SCAN_ACCESS_TOKEN_ENV] = "secret-key";
  process.env[SCANNER_EGRESS_ENV] = "github-actions-ubuntu";
  process.env[SCANNER_EGRESS_REGION_ENV] = "us-west";
  process.env[REPORT_STORE_BACKEND_ENV] = "r2";
  process.env.SITE_BEHAVIOR_LAB_R2_BUCKET = "reports";
  process.env.SITE_BEHAVIOR_LAB_R2_ENDPOINT = "https://acct.r2.cloudflarestorage.com";
  process.env.SITE_BEHAVIOR_LAB_R2_ACCESS_KEY_ID = "ak";
  process.env.SITE_BEHAVIOR_LAB_R2_SECRET_ACCESS_KEY = "sk";
  process.env[PUBLIC_R2_REPORTS_ENV] = "1";
  process.env[BUILD_COMMIT_ENV] = "a".repeat(40);
  process.env[CONSENT_VERIFICATION_ENV] = "1";
  process.env[DURABLE_JOBS_ENV] = "1";
  process.env[DURABLE_JOBS_INTERNAL_TOKEN_ENV] = "separate-private-coordinator-token";
  process.env[DURABLE_JOBS_COORDINATOR_URL_ENV] = "https://scan.sitebehavior.org";
  globalThis.fetch = (async () =>
    new Response(
      "<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>",
      { status: 200 }
    )) as typeof fetch;

  const shortCountSurvival = await runtimeStatus(loadedAdblock);
  assert.equal(shortCountSurvival.status, "degraded");
  assert.equal(shortCountSurvival.scansAvailable, false);
  assert.equal(
    shortCountSurvival.checks.durableJobs.reasons?.some(
      (reason) => reason.includes(REPORT_MIN_SURVIVAL_MS_ENV) && reason.includes("4500000")
    ),
    true
  );

  process.env[REPORT_MIN_SURVIVAL_MS_ENV] = "4500000";
  process.env[REPORT_MAX_AGE_DAYS_ENV] = "0.01";
  const shortAgeSurvival = await runtimeStatus(loadedAdblock);
  assert.equal(shortAgeSurvival.status, "degraded");
  assert.equal(shortAgeSurvival.scansAvailable, false);
  assert.equal(
    shortAgeSurvival.checks.durableJobs.reasons?.some((reason) => reason.includes(REPORT_MAX_AGE_DAYS_ENV)),
    true
  );

  delete process.env[REPORT_MAX_AGE_DAYS_ENV];
  const status = await runtimeStatus(loadedAdblock);

  assert.equal(status.status, "ok");
  assert.equal(status.scansAvailable, true);
  assert.deepEqual(status.checks.durableJobs, {
    requested: true,
    enabled: true,
    readiness: "node-ready"
  });
  assert.deepEqual(status.checks.encryptedWatches, {
    requested: false,
    enabled: false,
    readiness: "disabled"
  });
  assert.deepEqual(status.warnings, []);

  process.env[ENCRYPTED_WATCHES_ENV] = "1";
  const watchReady = await runtimeStatus(loadedAdblock);
  assert.deepEqual(watchReady.checks.encryptedWatches, {
    requested: true,
    enabled: true,
    readiness: "node-ready"
  });
  assert.equal(watchReady.capabilities.scheduledRescans, false);
  assert.deepEqual(watchReady.warnings, []);

  process.env[DURABLE_JOBS_ENV] = "0";
  const durableDisabled = await runtimeStatus(loadedAdblock);
  assert.equal(durableDisabled.scansAvailable, true, "watch readiness must not disable ordinary scans");
  assert.equal(durableDisabled.checks.encryptedWatches.readiness, "misconfigured");
  assert.equal(
    durableDisabled.checks.encryptedWatches.reasons?.some((reason) => reason.includes("durable scan jobs")),
    true
  );

  process.env[DURABLE_JOBS_ENV] = "1";
  process.env[ENCRYPTED_WATCHES_ENV] = "yes";
  const invalidWatchFlag = await runtimeStatus(loadedAdblock);
  assert.equal(invalidWatchFlag.scansAvailable, true, "an optional watch misconfiguration must not refuse scans");
  assert.deepEqual(invalidWatchFlag.checks.encryptedWatches, {
    requested: true,
    enabled: false,
    readiness: "misconfigured",
    reasons: [`${ENCRYPTED_WATCHES_ENV} must be 0, 1, or unset.`]
  });

  process.env[DURABLE_JOBS_INTERNAL_TOKEN_ENV] = "short";
  const shortToken = await runtimeStatus(loadedAdblock);
  assert.equal(shortToken.checks.durableJobs.readiness, "misconfigured");
  assert.equal(
    shortToken.checks.durableJobs.reasons?.some((reason) => reason.includes(DURABLE_JOBS_INTERNAL_TOKEN_ENV)),
    true
  );

  process.env[DURABLE_JOBS_INTERNAL_TOKEN_ENV] = "separate-private-coordinator-token";
  process.env[DURABLE_JOBS_COORDINATOR_URL_ENV] = "http://scan.sitebehavior.org";
  const insecureCoordinator = await runtimeStatus(loadedAdblock);
  assert.equal(insecureCoordinator.checks.durableJobs.readiness, "misconfigured");
  assert.equal(
    insecureCoordinator.checks.durableJobs.reasons?.some(
      (reason) => reason.includes(DURABLE_JOBS_COORDINATOR_URL_ENV)
    ),
    true
  );

  process.env[DURABLE_JOBS_COORDINATOR_URL_ENV] = "https://scan.sitebehavior.org/private";
  const coordinatorWithPath = await runtimeStatus(loadedAdblock);
  assert.equal(coordinatorWithPath.checks.durableJobs.readiness, "misconfigured");

  process.env[DURABLE_JOBS_COORDINATOR_URL_ENV] = "http://127.0.0.1:8787";
  const loopbackCoordinator = await runtimeStatus(loadedAdblock);
  assert.equal(loopbackCoordinator.checks.durableJobs.readiness, "node-ready");

  process.env[DURABLE_JOBS_COORDINATOR_URL_ENV] = "http://[::1]:8787";
  const ipv6LoopbackCoordinator = await runtimeStatus(loadedAdblock);
  assert.equal(ipv6LoopbackCoordinator.checks.durableJobs.readiness, "node-ready");
});

test("runtimeStatus fails durable-job readiness closed when requested prerequisites are absent", async () => {
  process.env[SCAN_ACCESS_TOKEN_ENV] = "secret-key";
  process.env[REPORT_STORE_DIR_ENV] = "/var/lib/site-behavior-lab/reports";
  process.env[SCANNER_EGRESS_ENV] = "github-actions-ubuntu";
  process.env[DURABLE_JOBS_ENV] = "1";
  process.env[DURABLE_JOBS_COORDINATOR_URL_ENV] = "https://user@scan.sitebehavior.org";

  const status = await runtimeStatus(loadedAdblock);

  assert.equal(status.status, "degraded");
  assert.equal(status.scansAvailable, false);
  assert.equal(status.checks.durableJobs.requested, true);
  assert.equal(status.checks.durableJobs.enabled, false);
  assert.equal(status.checks.durableJobs.readiness, "misconfigured");
  assert.equal(status.checks.durableJobs.reasons?.some((reason) => reason.includes("r2 report-store")), true);
  assert.equal(status.checks.durableJobs.reasons?.some((reason) => reason.includes(DURABLE_JOBS_INTERNAL_TOKEN_ENV)), true);
  assert.equal(status.checks.durableJobs.reasons?.some((reason) => reason.includes(DURABLE_JOBS_COORDINATOR_URL_ENV)), true);
});

test("runtimeStatus reports an invalid durable-job flag as misconfigured, not enabled", async () => {
  process.env[SCAN_ACCESS_TOKEN_ENV] = "secret-key";
  process.env[REPORT_STORE_DIR_ENV] = "/var/lib/site-behavior-lab/reports";
  process.env[SCANNER_EGRESS_ENV] = "github-actions-ubuntu";
  process.env[DURABLE_JOBS_ENV] = "yes";

  const status = await runtimeStatus(loadedAdblock);

  assert.equal(status.scansAvailable, false);
  assert.deepEqual(status.checks.durableJobs, {
    requested: true,
    enabled: false,
    readiness: "misconfigured",
    reasons: [`${DURABLE_JOBS_ENV} must be 0, 1, or unset.`]
  });
});

test("runtimeStatus makes an unrecorded public-r2 egress region observable", async () => {
  process.env[SCAN_ACCESS_TOKEN_ENV] = "secret-key";
  process.env[REPORT_STORE_DIR_ENV] = "/var/lib/site-behavior-lab/reports";
  process.env[SCANNER_EGRESS_ENV] = "github-actions-ubuntu";
  process.env[PUBLIC_R2_REPORTS_ENV] = "1";
  process.env[BUILD_COMMIT_ENV] = "a".repeat(40);
  process.env[CONSENT_VERIFICATION_ENV] = "1";

  const missing = await runtimeStatus(loadedAdblock);
  assert.equal(missing.status, "degraded");
  assert.equal(missing.scansAvailable, true, "single scans remain usable while comparison deltas fail closed");
  assert.equal(missing.checks.scannerEgressRegion, "unrecorded");
  assert.equal(missing.warnings.some((warning) => warning.includes("egress region is unrecorded")), true);

  process.env.CLOUDFLARE_COUNTRY_A2 = "US";
  const partialPlacement = await runtimeStatus(loadedAdblock);
  assert.equal(partialPlacement.status, "degraded");
  assert.equal(partialPlacement.scansAvailable, true, "single scans remain usable while invalid region metadata is omitted");
  assert.equal(partialPlacement.checks.scannerEgressRegion, "misconfigured");
  assert.equal(partialPlacement.warnings.some((warning) => warning.includes("full region/location/country")), true);

  process.env.CLOUDFLARE_REGION = "wnam";
  process.env.CLOUDFLARE_LOCATION = "Los Angeles";
  const configured = await runtimeStatus(loadedAdblock);
  assert.equal(configured.status, "ok");
  assert.equal(configured.checks.scannerEgressRegion, "configured");
  assert.deepEqual(configured.warnings, []);
});

test("runtimeStatus rejects explicit egress regions outside the r2 text envelope", async () => {
  process.env[SCAN_ACCESS_TOKEN_ENV] = "secret-key";
  process.env[REPORT_STORE_DIR_ENV] = "/var/lib/site-behavior-lab/reports";
  process.env[SCANNER_EGRESS_ENV] = "github-actions-ubuntu";
  process.env[SCANNER_EGRESS_REGION_ENV] = "x".repeat(65);

  const status = await runtimeStatus(loadedAdblock);
  assert.equal(status.status, "degraded");
  assert.equal(status.checks.scannerEgressRegion, "misconfigured");
  assert.equal(status.warnings.some((warning) => warning.includes("r2-safe stable region")), true);
});

test("runtimeStatus exposes a configured private R2 shadow posture", async () => {
  process.env[SCAN_ACCESS_TOKEN_ENV] = "secret-key";
  process.env[REPORT_STORE_DIR_ENV] = "/var/lib/site-behavior-lab/reports";
  process.env[SCANNER_EGRESS_ENV] = "github-actions-ubuntu";
  process.env[BUILD_COMMIT_ENV] = "a".repeat(40);
  process.env[CONSENT_VERIFICATION_ENV] = "1";
  process.env[V2_SHADOW_EMISSION_ENV] = "1";
  process.env[V2_SHADOW_BACKEND_ENV] = "r2";
  process.env.SITE_BEHAVIOR_LAB_R2_BUCKET = "reports";
  process.env.SITE_BEHAVIOR_LAB_R2_ENDPOINT = "https://acct.r2.cloudflarestorage.com";
  process.env.SITE_BEHAVIOR_LAB_R2_ACCESS_KEY_ID = "ak";
  process.env.SITE_BEHAVIOR_LAB_R2_SECRET_ACCESS_KEY = "sk";

  const status = await runtimeStatus(loadedAdblock);
  assert.equal(status.status, "ok");
  assert.equal(status.checks.consentVerification, "enabled");
  assert.deepEqual(status.checks.v2ShadowEmission, { status: "enabled", backend: "r2" });
  assert.deepEqual(status.warnings, []);
});

test("runtimeStatus degrades explicit shadow flag and sink misconfiguration", async () => {
  process.env[SCAN_ACCESS_TOKEN_ENV] = "secret-key";
  process.env[REPORT_STORE_DIR_ENV] = "/var/lib/site-behavior-lab/reports";
  process.env[SCANNER_EGRESS_ENV] = "github-actions-ubuntu";
  process.env[BUILD_COMMIT_ENV] = "a".repeat(40);
  process.env[CONSENT_VERIFICATION_ENV] = "1";
  process.env[V2_SHADOW_EMISSION_ENV] = "1";
  process.env[V2_SHADOW_BACKEND_ENV] = "r2";

  const missingStore = await runtimeStatus(loadedAdblock);
  assert.equal(missingStore.status, "degraded");
  assert.deepEqual(missingStore.checks.v2ShadowEmission, { status: "misconfigured", backend: "none" });
  assert.equal(missingStore.warnings.some((warning) => warning.includes("shadow store is misconfigured")), true);

  process.env[V2_SHADOW_EMISSION_ENV] = "sometimes";
  const badFlag = await runtimeStatus(loadedAdblock);
  assert.equal(badFlag.status, "degraded");
  assert.equal(badFlag.checks.v2ShadowEmission.status, "misconfigured");
});

test("runtimeStatus names consent verification required by observe-mode shadow emission", async () => {
  process.env[SCAN_ACCESS_TOKEN_ENV] = "secret-key";
  process.env[REPORT_STORE_DIR_ENV] = "/var/lib/site-behavior-lab/reports";
  process.env[SCANNER_EGRESS_ENV] = "github-actions-ubuntu";
  process.env[BUILD_COMMIT_ENV] = "a".repeat(40);
  process.env[V2_SHADOW_EMISSION_ENV] = "1";

  const status = await runtimeStatus(loadedAdblock);
  assert.equal(status.status, "degraded");
  assert.equal(status.checks.consentVerification, "disabled");
  assert.deepEqual(status.checks.v2ShadowEmission, { status: "enabled", backend: "filesystem" });
  assert.equal(status.warnings.some((warning) => warning.includes("observe-mode r2 shadows")), true);
});

test("runtimeStatus refuses filesystem shadow readiness without full build provenance", async () => {
  process.env[SCAN_ACCESS_TOKEN_ENV] = "secret-key";
  process.env[REPORT_STORE_DIR_ENV] = "/var/lib/site-behavior-lab/reports";
  process.env[SCANNER_EGRESS_ENV] = "github-actions-ubuntu";
  process.env[CONSENT_VERIFICATION_ENV] = "1";
  process.env[V2_SHADOW_EMISSION_ENV] = "1";

  const status = await runtimeStatus(loadedAdblock);
  assert.equal(status.status, "degraded");
  assert.deepEqual(status.checks.v2ShadowEmission, { status: "misconfigured", backend: "none" });
  assert.equal(status.warnings.some((warning) => warning.includes("full 40-character Git commit")), true);
});

test("runtimeStatus treats explicit open access as intentional, not a degradation", async () => {
  process.env[ALLOW_UNAUTHENTICATED_SCANS_ENV] = "1";
  process.env[REPORT_STORE_DIR_ENV] = "/var/lib/site-behavior-lab/reports";
  process.env[SCANNER_EGRESS_ENV] = "github-actions-ubuntu";

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
  process.env[SCANNER_EGRESS_ENV] = "github-actions-ubuntu";

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
    version: "adblock-rust-0.13.2" as const,
    engineVersion: "adblock-rust-0.13.2" as const,
    source: "Brave default ad-block lists",
    lists: 31,
    fetchedAt: new Date(0).toISOString(),
    manifestDigest: "a".repeat(64)
  };
}
