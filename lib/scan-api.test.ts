import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { CONSENT_VERIFICATION_ENV } from "./consent-verification";
import { PublicScanError } from "./public-errors";
import { RATE_LIMIT_MAX, resetScanLimitStateForTests, scanLimitStateForTests } from "./scan-limits";
import {
  executePreparedScan,
  prepareScanRequest,
  runScanRequest,
  type PreparedScanRequest,
  type ReportSaver,
  type ScanRunner
} from "./scan-api";
import { readStoredScanReportById, saveScanReport } from "./report-store";
import {
  makeConsentInterventionReportV2R2,
  makeGpcInterventionReportV2R2,
  makePublicSingleReportV2R2,
  makeShieldsInterventionReportV2R2
} from "./scan-report-v2-r2-fixtures";
import { scanResultWithStagedR2Run } from "./scan-report-v2-runtime-fixtures";
import {
  BUILD_COMMIT_ENV,
  PUBLIC_R2_REPORTS_ENV,
  type RuntimeScanReport
} from "./runtime-scan-report";
import { SCAN_REPORT_SCHEMA_VERSION, type ScanReport, type ScanRequestPayload, type ScanResult } from "./types";

// Reads through the typed accessor, narrowing to v1 exactly as production
// render surfaces do (the old readScanReport wrapper had no production callers).
async function readV1Report(id: string) {
  const result = await readStoredScanReportById(id);
  return result.outcome === "found" && result.stored.schemaVersion === 1 ? result.stored.report : null;
}


const SCAN_ACCESS_TOKEN_ENV = "SITE_BEHAVIOR_LAB_SCAN_ACCESS_TOKEN";
const REPORT_STORE_DIR_ENV = "SITE_BEHAVIOR_LAB_REPORT_STORE_DIR";
const REPORT_STORE_BACKEND_ENV = "SITE_BEHAVIOR_LAB_REPORT_STORE_BACKEND";
const R2_ENVS = [
  "SITE_BEHAVIOR_LAB_R2_BUCKET",
  "SITE_BEHAVIOR_LAB_R2_ENDPOINT",
  "SITE_BEHAVIOR_LAB_R2_ACCESS_KEY_ID",
  "SITE_BEHAVIOR_LAB_R2_SECRET_ACCESS_KEY"
] as const;

// Route report writes to a per-test temp dir; never touch (or delete) the
// repo's real `.site-behavior-lab` default store, which may hold a developer's
// actual saved reports.
let reportDir = "";

beforeEach(async () => {
  reportDir = await mkdtemp(path.join(tmpdir(), "sbl-scan-api-"));
  process.env[REPORT_STORE_DIR_ENV] = reportDir;
});

afterEach(async () => {
  delete process.env[SCAN_ACCESS_TOKEN_ENV];
  delete process.env[REPORT_STORE_DIR_ENV];
  delete process.env[PUBLIC_R2_REPORTS_ENV];
  delete process.env[BUILD_COMMIT_ENV];
  delete process.env[CONSENT_VERIFICATION_ENV];
  delete process.env.SITE_BEHAVIOR_LAB_V2_SHADOW_EMISSION;
  delete process.env[REPORT_STORE_BACKEND_ENV];
  for (const name of R2_ENVS) delete process.env[name];
  resetScanLimitStateForTests();
  await rm(reportDir, { recursive: true, force: true });
});

test("runScanRequest rejects unauthorized scans before charging rate limits", async () => {
  process.env[SCAN_ACCESS_TOKEN_ENV] = "secret-key";
  const scannedPayloads: ScanRequestPayload[] = [];
  const scan: ScanRunner = async (payload) => {
    scannedPayloads.push(payload);
    return makeScanResult(payload);
  };

  await assert.rejects(
    () => runScanRequest(makeScanRequest("https://1.1.1.1/"), scan),
    (error) => error instanceof PublicScanError && error.status === 401
  );

  assert.equal(scannedPayloads.length, 0);
  assert.deepEqual(scanLimitStateForTests(), {
    activeScans: 0,
    queuedScans: 0,
    trackedClients: 0,
    trackedReportReadClients: 0
  });
});

test("runScanRequest accepts authorized scans", async () => {
  process.env[SCAN_ACCESS_TOKEN_ENV] = "secret-key";
  const scan: ScanRunner = async (payload) => makeScanResult(payload);

  const result = expectV1Report(
    await runScanRequest(
      makeScanRequest("https://1.1.1.1/", {}, { "x-site-behavior-lab-access-token": "secret-key" }),
      scan
    )
  );

  assert.equal(result.ok, true);
  assert.equal(scanLimitStateForTests().trackedClients, 1);
});

test("prepareScanRequest returns a queue-ready payload without acquiring a scan slot", async () => {
  const prepared = await prepareScanRequest(makeScanRequest(" 1.1.1.1/path?token=kept#fragment ", { compareGpc: true }));

  assert.deepEqual(prepared, {
    clientKey: "local",
    url: "https://1.1.1.1/path?token=kept",
    device: "desktop",
    gpcEnabled: true,
    compareGpc: true,
    compareShields: false,
    compareConsent: false,
    rateLimitCost: 2
  });
  assert.deepEqual(scanLimitStateForTests(), {
    activeScans: 0,
    queuedScans: 0,
    trackedClients: 0,
    trackedReportReadClients: 0
  });
});

test("prepareScanRequest rejects a declared oversized body before reading it", async () => {
  let pulled = false;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulled = true;
        controller.enqueue(new TextEncoder().encode('{"url":"https://1.1.1.1/"}'));
        controller.close();
      }
    },
    { highWaterMark: 0 }
  );
  const request = {
    headers: new Headers({ "content-length": "999999" }),
    body: stream
  } as unknown as Request;

  await assert.rejects(
    () => prepareScanRequest(request),
    (error) => error instanceof PublicScanError && error.status === 413
  );
  assert.equal(pulled, false);
});

test("prepareScanRequest cancels an oversized chunked body before buffering the rest", async () => {
  let chunksServed = 0;
  let cancelled = false;
  const chunk = new Uint8Array(2_048).fill(120);
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (chunksServed >= 5) {
        controller.close();
        return;
      }
      chunksServed += 1;
      controller.enqueue(chunk);
    },
    cancel() {
      cancelled = true;
    }
  });
  const request = { headers: new Headers(), body: stream } as unknown as Request;

  await assert.rejects(
    () => prepareScanRequest(request),
    (error) => error instanceof PublicScanError && error.status === 413
  );
  assert.equal(cancelled, true);
  assert.ok(chunksServed <= 3, `served ${chunksServed} chunks; the byte cap must stop the read early`);
});

test("executePreparedScan charges rate limits only after acquiring a scan slot", async () => {
  const prepared: PreparedScanRequest = {
    clientKey: "queued-client",
    url: "https://1.1.1.1/",
    device: "mobile",
    gpcEnabled: false,
    compareGpc: false,
    compareShields: false,
    compareConsent: false,
    rateLimitCost: 1
  };
  let stateDuringScan: ReturnType<typeof scanLimitStateForTests> | undefined;
  const scannedPayloads: ScanRequestPayload[] = [];
  const scan: ScanRunner = async (payload, options) => {
    stateDuringScan = scanLimitStateForTests();
    scannedPayloads.push(payload);
    assert.equal(options?.publicUrlAlreadyVerified, true);
    return makeScanResult(payload);
  };

  const result = expectV1Report(await executePreparedScan(prepared, scan, async (report) => report));

  assert.equal(result.ok, true);
  assert.deepEqual(scannedPayloads, [
    {
      url: "https://1.1.1.1/",
      device: "mobile",
      gpcEnabled: false,
      consentMode: "observe"
    }
  ]);
  assert.deepEqual(stateDuringScan, {
    activeScans: 1,
    queuedScans: 0,
    trackedClients: 1,
    trackedReportReadClients: 0
  });
  assert.deepEqual(scanLimitStateForTests(), {
    activeScans: 0,
    queuedScans: 0,
    trackedClients: 1,
    trackedReportReadClients: 0
  });
});

test("post-publication shadow work cannot hold the v1 result or scan slot", { timeout: 1_000 }, async () => {
  const prepared: PreparedScanRequest = {
    clientKey: "shadow-background-client",
    url: "https://1.1.1.1/",
    device: "desktop",
    gpcEnabled: false,
    compareGpc: false,
    compareShields: false,
    compareConsent: false,
    rateLimitCost: 1
  };
  let scheduled = 0;
  process.env.SITE_BEHAVIOR_LAB_V2_SHADOW_EMISSION = "1";
  try {
    const result = expectV1Report(
      await executePreparedScan(
        prepared,
        async (payload) => makeScanResult(payload),
        async (report) => report,
        undefined,
        false,
        {
          schedulePostPublication: () => {
            scheduled += 1;
            return new Promise(() => {});
          }
        }
      )
    );
    assert.equal(result.ok, true);
    assert.equal(scheduled, 1);
    assert.equal(scanLimitStateForTests().activeScans, 0);
  } finally {
    delete process.env.SITE_BEHAVIOR_LAB_V2_SHADOW_EMISSION;
  }
});

test("runScanRequest does not charge rate limit quota for blocked target URLs", async () => {
  const scannedPayloads: ScanRequestPayload[] = [];
  const scan: ScanRunner = async (payload) => {
    scannedPayloads.push(payload);
    return makeScanResult(payload);
  };

  for (let index = 0; index < RATE_LIMIT_MAX + 1; index += 1) {
    await assert.rejects(
      () => runScanRequest(makeScanRequest("http://127.0.0.1/"), scan),
      (error) => error instanceof PublicScanError && error.status === 400
    );
  }

  assert.deepEqual(scanLimitStateForTests(), {
    activeScans: 0,
    queuedScans: 0,
    trackedClients: 0,
    trackedReportReadClients: 0
  });

  const result = expectV1Report(
    await runScanRequest(makeScanRequest("https://1.1.1.1/?token=still-scanned"), scan)
  );

  assert.equal(result.ok, true);
  assert.equal(result.share?.path.startsWith("/reports/"), true);
  assert.deepEqual(await readV1Report(result.share?.id || ""), result);
  assert.equal(scannedPayloads.length, 1);
  assert.equal(scannedPayloads[0].url, "https://1.1.1.1/?token=still-scanned");
  assert.deepEqual(scanLimitStateForTests(), {
    activeScans: 0,
    queuedScans: 0,
    trackedClients: 1,
    trackedReportReadClients: 0
  });
});

test("runScanRequest rate-limits before resolving hostname targets", async () => {
  const scan: ScanRunner = async (payload) => makeScanResult(payload);

  for (let index = 0; index < RATE_LIMIT_MAX; index += 1) {
    await runScanRequest(makeScanRequest(`https://1.1.1.1/?n=${index}`), scan);
  }

  await assert.rejects(
    () => runScanRequest(makeScanRequest("https://definitely-not-a-real-hostname.invalid/"), scan),
    (error) =>
      error instanceof PublicScanError &&
      error.status === 429 &&
      error.message === "Too many scan requests. Try again shortly."
  );
});

test("runScanRequest can run and persist a GPC off/on comparison", async () => {
  const scannedPayloads: ScanRequestPayload[] = [];
  const scan: ScanRunner = async (payload, options) => {
    scannedPayloads.push({
      ...payload,
      url: `${payload.url}#verified=${options?.publicUrlAlreadyVerified === true}`
    });
    return makeScanResult(payload, payload.gpcEnabled ? 3 : 5);
  };

  const result = expectV1Report(
    await runScanRequest(makeScanRequest("https://1.1.1.1/", { compareGpc: true }), scan)
  );

  assert.equal(result.reportType, "comparison");
  // Execution order is a randomized counterbalancing draw; both arms always run.
  assert.deepEqual([...scannedPayloads.map((payload) => payload.gpcEnabled)].sort(), [false, true]);
  assert.deepEqual(scannedPayloads.map((payload) => payload.url.endsWith("#verified=true")), [true, true]);
  if (result.reportType !== "comparison") throw new Error("expected comparison report");
  // The report's baseline/variant semantics never depend on the executed order.
  assert.equal(result.diff.totalRequests.before, 5);
  assert.equal(result.diff.totalRequests.after, 3);
  assert.equal(result.diff.totalRequests.delta, -2);
  // The disclosure names the arm that really ran first.
  const firstLabel = scannedPayloads[0].gpcEnabled ? "GPC on" : "GPC off";
  assert.equal(
    result.warnings.includes(`The two visits ran in randomized order; the "${firstLabel}" visit ran first.`),
    true
  );
  assert.equal(result.share?.path.startsWith("/reports/"), true);
  assert.deepEqual(await readV1Report(result.share?.id || ""), result);
});

test("executePreparedScan honors the drawn arm order in both directions", async () => {
  for (const executedFirst of ["baseline", "variant"] as const) {
    const scannedPayloads: ScanRequestPayload[] = [];
    const scan: ScanRunner = async (payload) => {
      scannedPayloads.push(payload);
      return makeScanResult(payload, payload.gpcEnabled ? 3 : 5);
    };
    const prepared: PreparedScanRequest = {
      clientKey: `order-${executedFirst}`,
      url: "https://1.1.1.1/",
      device: "desktop",
      gpcEnabled: true,
      compareGpc: true,
      compareShields: false,
      compareConsent: false,
      rateLimitCost: 2
    };

    const result = expectV1Report(
      await executePreparedScan(prepared, scan, async (report) => report, undefined, true, {
        drawComparisonFirstArm: () => executedFirst
      })
    );

    if (result.reportType !== "comparison") throw new Error("expected comparison report");
    assert.deepEqual(
      scannedPayloads.map((payload) => payload.gpcEnabled),
      executedFirst === "baseline" ? [false, true] : [true, false]
    );
    // Semantics stay fixed regardless of order: baseline is the GPC-off run.
    assert.equal(result.baseline.conditions.gpcEnabled, false);
    assert.equal(result.variant.conditions.gpcEnabled, true);
    assert.equal(result.diff.totalRequests.before, 5);
    assert.equal(result.diff.totalRequests.after, 3);
    const expectedLabel = executedFirst === "baseline" ? "GPC off" : "GPC on";
    assert.equal(result.warnings[1], `The two visits ran in randomized order; the "${expectedLabel}" visit ran first.`);
  }
});

test("the public r2 gate returns and persists a single plus every comparison axis", async () => {
  enablePublicR2();

  for (const kind of ["single", "gpc", "shields", "consent"] as const) {
    const prepared: PreparedScanRequest = {
      clientKey: `public-r2-${kind}`,
      url: "https://shop.example.com/products/runtime-private",
      device: "desktop",
      gpcEnabled: true,
      compareGpc: kind === "gpc",
      compareShields: kind === "shields",
      compareConsent: kind === "consent",
      rateLimitCost: kind === "single" ? 1 : 2
    };
    const scan: ScanRunner = async (payload, options) => {
      if (kind === "single") {
        return scanResultWithStagedR2Run(makePublicSingleReportV2R2().run, `data:image/png;base64,${kind}`);
      }
      if (kind === "gpc") {
        const fixture = makeGpcInterventionReportV2R2();
        return scanResultWithStagedR2Run(payload.gpcEnabled ? fixture.variant : fixture.baseline, `data:image/png;base64,${kind}`);
      }
      if (kind === "shields") {
        const fixture = makeShieldsInterventionReportV2R2();
        return scanResultWithStagedR2Run(
          options?.shieldsBlockingEnabled ? fixture.variant : fixture.baseline,
          `data:image/png;base64,${kind}`
        );
      }
      const fixture = makeConsentInterventionReportV2R2();
      return scanResultWithStagedR2Run(
        payload.consentMode === "reject-all" ? fixture.variant : fixture.baseline,
        `data:image/png;base64,${kind}`
      );
    };

    const result = await executePreparedScan(prepared, scan, saveScanReport, undefined, false, {
      drawComparisonFirstArm: () => "baseline"
    });
    assert.equal(result.schemaVersion, 2);
    if (result.schemaVersion !== 2) throw new Error("expected public r2 result");
    assert.equal(result.schemaRevision, 2);
    assert.match(result.share?.id ?? "", /^[0-9]{8}-[0-9a-f]{32}$/);
    if (kind === "single") {
      assert.equal(result.reportType, "single");
      if (result.reportType !== "single") throw new Error("expected r2 single");
      assert.equal(result.ephemeral.screenshot, `data:image/png;base64,${kind}`);
    } else {
      assert.equal(result.reportType, "comparison");
      if (result.reportType !== "comparison") throw new Error("expected r2 comparison");
      assert.equal(result.experiment.kind, "intervention");
      if (result.experiment.kind !== "intervention") throw new Error("expected intervention");
      assert.equal(result.experiment.axis, kind);
      assert.equal(result.ephemeral.baselineScreenshot, `data:image/png;base64,${kind}`);
      assert.equal(result.ephemeral.variantScreenshot, `data:image/png;base64,${kind}`);
    }

    const stored = await readStoredScanReportById(result.share?.id ?? "");
    assert.equal(stored.outcome, "found");
    if (stored.outcome !== "found") throw new Error("expected stored r2 report");
    assert.equal(stored.stored.schemaVersion, 2);
    if (stored.stored.schemaVersion !== 2) throw new Error("expected stored r2 report");
    assert.equal(stored.stored.schemaRevision, 2);
    assert.equal("ephemeral" in JSON.parse(stored.wire), false);
  }
});

test("public r2 failures never fall back to or persist a v1 report", async () => {
  enablePublicR2();
  const prepared: PreparedScanRequest = {
    clientKey: "public-r2-no-fallback",
    url: "https://1.1.1.1/",
    device: "desktop",
    gpcEnabled: true,
    compareGpc: false,
    compareShields: false,
    compareConsent: false,
    rateLimitCost: 1
  };
  let scanCalls = 0;
  let saveCalls = 0;
  const save: ReportSaver = async (report) => {
    saveCalls += 1;
    return report;
  };

  await assert.rejects(
    () =>
      executePreparedScan(
        prepared,
        async (payload) => {
          scanCalls += 1;
          return makeScanResult(payload);
        },
        save,
        undefined,
        false
      ),
    /missing its process-local r2 measurement facts/
  );
  assert.equal(scanCalls, 1);
  assert.equal(saveCalls, 0);

  delete process.env[CONSENT_VERIFICATION_ENV];
  scanCalls = 0;
  await assert.rejects(
    () => executePreparedScan(prepared, async (payload) => {
      scanCalls += 1;
      return makeScanResult(payload);
    }, save, undefined, false),
    (error) => error instanceof PublicScanError && error.status === 503 && /CONSENT_VERIFICATION/.test(error.message)
  );
  assert.equal(scanCalls, 0);
  assert.equal(saveCalls, 0);
});

test("public r2 keeps independently enabled shadow emission off the response path", async () => {
  enablePublicR2();
  process.env.SITE_BEHAVIOR_LAB_V2_SHADOW_EMISSION = "1";
  let scheduled = 0;
  const result = await executePreparedScan(
    {
      clientKey: "public-r2-plus-shadow",
      url: "https://shop.example.com/",
      device: "desktop",
      gpcEnabled: true,
      compareGpc: false,
      compareShields: false,
      compareConsent: false,
      rateLimitCost: 1
    },
    async () => scanResultWithStagedR2Run(makePublicSingleReportV2R2().run),
    async (report) => report,
    undefined,
    false,
    {
      schedulePostPublication: () => {
        scheduled += 1;
        return new Promise(() => {});
      }
    }
  );
  assert.equal(result.schemaVersion, 2);
  assert.equal(scheduled, 1);
  assert.equal(scanLimitStateForTests().activeScans, 0);
});

test("public r2 preflights default persistence before scan quota or Chromium", async () => {
  enablePublicR2();
  process.env[REPORT_STORE_BACKEND_ENV] = "r2";
  let scanCalls = 0;
  const scan: ScanRunner = async () => {
    scanCalls += 1;
    return scanResultWithStagedR2Run(makePublicSingleReportV2R2().run);
  };

  await assert.rejects(
    () => runScanRequest(makeScanRequest("https://1.1.1.1/"), scan),
    (error) =>
      error instanceof PublicScanError &&
      error.status === 503 &&
      error.message === "Public r2 report persistence is unavailable."
  );
  assert.equal(scanCalls, 0);
  assert.deepEqual(scanLimitStateForTests(), {
    activeScans: 0,
    queuedScans: 0,
    trackedClients: 0,
    trackedReportReadClients: 0
  });

  const injected = await executePreparedScan(
    {
      clientKey: "public-r2-injected-store",
      url: "https://1.1.1.1/",
      device: "desktop",
      gpcEnabled: true,
      compareGpc: false,
      compareShields: false,
      compareConsent: false,
      rateLimitCost: 1
    },
    scan,
    async (report) => report,
    undefined,
    false
  );
  assert.equal(injected.schemaVersion, 2);
  assert.equal(scanCalls, 1);
});

test("runScanRequest can run and persist a Shields off/on comparison", async () => {
  const scannedPayloads: ScanRequestPayload[] = [];
  const scanOptions: unknown[] = [];
  const scan: ScanRunner = async (payload, options) => {
    scannedPayloads.push(payload);
    scanOptions.push(options);
    return makeScanResult(payload, options?.shieldsBlockingEnabled ? 3 : 8);
  };

  const result = expectV1Report(
    await runScanRequest(makeScanRequest("https://1.1.1.1/", { compareShields: true }), scan)
  );

  assert.equal(result.reportType, "comparison");
  if (result.reportType !== "comparison") throw new Error("expected comparison report");
  assert.equal(result.comparisonType, "shields");
  assert.deepEqual(scannedPayloads.map((payload) => payload.gpcEnabled), [true, true]);
  // Execution order is randomized; exactly one arm runs the blocking engine.
  const blockingFlags = scanOptions.map((options) =>
    Boolean((options as { shieldsBlockingEnabled?: boolean }).shieldsBlockingEnabled)
  );
  assert.deepEqual([...blockingFlags].sort(), [false, true]);
  assert.equal(result.diff.totalRequests.before, 8);
  assert.equal(result.diff.totalRequests.after, 3);
  assert.equal(result.diff.totalRequests.delta, -5);
  const firstLabel = blockingFlags[0] ? "Brave-list blocking" : "No blocking";
  assert.equal(
    result.warnings.includes(`The two visits ran in randomized order; the "${firstLabel}" visit ran first.`),
    true
  );
  assert.equal(result.share?.path.startsWith("/reports/"), true);
  assert.deepEqual(await readV1Report(result.share?.id || ""), result);
});

test("prepareScanRequest rejects conflicting comparison modes", async () => {
  await assert.rejects(
    () => prepareScanRequest(makeScanRequest("https://1.1.1.1/", { compareGpc: true, compareShields: true })),
    (error) => error instanceof PublicScanError && error.message === "Choose one comparison mode."
  );
  await assert.rejects(
    () => prepareScanRequest(makeScanRequest("https://1.1.1.1/", { compareGpc: true, compareConsent: true })),
    (error) => error instanceof PublicScanError && error.message === "Choose one comparison mode."
  );
});

test("runScanRequest can run and persist a consent accept/reject comparison", async () => {
  const scannedPayloads: ScanRequestPayload[] = [];
  const scan: ScanRunner = async (payload) => {
    scannedPayloads.push(payload);
    return makeScanResult(payload, payload.consentMode === "accept-all" ? 9 : 2);
  };

  const result = expectV1Report(
    await runScanRequest(makeScanRequest("https://1.1.1.1/", { compareConsent: true }), scan)
  );

  assert.equal(result.reportType, "comparison");
  if (result.reportType !== "comparison") throw new Error("expected comparison report");
  assert.equal(result.comparisonType, "consent");
  // The mock scanner records no consentInteraction, so neither click is
  // provably dispatched and the producer must label both arms as attempts.
  assert.equal(result.title, "Consent comparison attempt (no banner clicked)");
  assert.deepEqual(result.runLabels, { baseline: "Accept-all attempt", variant: "Reject-all attempt" });
  // Execution order is randomized; the accept run stays the baseline arm and
  // both visits keep the requested GPC state.
  assert.deepEqual([...scannedPayloads.map((payload) => payload.consentMode)].sort(), ["accept-all", "reject-all"]);
  assert.equal(result.baseline.conditions.consentMode, "accept-all");
  assert.equal(result.variant.conditions.consentMode, "reject-all");
  assert.deepEqual(scannedPayloads.map((payload) => payload.gpcEnabled), [true, true]);
  const firstConsentLabel = scannedPayloads[0].consentMode === "accept-all" ? "Accept-all attempt" : "Reject-all attempt";
  assert.equal(
    result.warnings.includes(`The two visits ran in randomized order; the "${firstConsentLabel}" visit ran first.`),
    true
  );
  assert.equal(result.diff.totalRequests.before, 9);
  assert.equal(result.diff.totalRequests.after, 2);
  assert.equal(result.diff.totalRequests.delta, -7);
  assert.equal(result.share?.path.startsWith("/reports/"), true);
  assert.deepEqual(await readV1Report(result.share?.id || ""), result);
});

test("runScanRequest charges comparisons as two rate-limit tokens", async () => {
  const scannedPayloads: ScanRequestPayload[] = [];
  const scan: ScanRunner = async (payload) => {
    scannedPayloads.push(payload);
    return makeScanResult(payload);
  };

  for (let index = 0; index < Math.floor(RATE_LIMIT_MAX / 2); index += 1) {
    await runScanRequest(makeScanRequest(`https://1.1.1.1/?comparison=${index}`, { compareGpc: true }), scan);
  }

  await assert.rejects(
    () => runScanRequest(makeScanRequest("https://1.1.1.1/?comparison=over-limit", { compareGpc: true }), scan),
    (error) => error instanceof PublicScanError && error.status === 429
  );
  assert.equal(scannedPayloads.length, Math.floor(RATE_LIMIT_MAX / 2) * 2);

  resetScanLimitStateForTests();
  scannedPayloads.splice(0, scannedPayloads.length);

  for (let index = 0; index < Math.floor(RATE_LIMIT_MAX / 2); index += 1) {
    await runScanRequest(makeScanRequest(`https://1.1.1.1/?shields=${index}`, { compareShields: true }), scan);
  }

  await assert.rejects(
    () => runScanRequest(makeScanRequest("https://1.1.1.1/?shields=over-limit", { compareShields: true }), scan),
    (error) => error instanceof PublicScanError && error.status === 429
  );
  assert.equal(scannedPayloads.length, Math.floor(RATE_LIMIT_MAX / 2) * 2);
});

test("executePreparedScan does not charge rate limits when the scan slot queue times out", async () => {
  const prepared: PreparedScanRequest = {
    clientKey: "queued-client",
    url: "https://1.1.1.1/",
    device: "desktop",
    gpcEnabled: true,
    compareGpc: false,
    compareShields: false,
    compareConsent: false,
    rateLimitCost: 1
  };
  const hang: ScanRunner = () => new Promise(() => {});
  const save: ReportSaver = async (report) => report;

  void executePreparedScan(prepared, hang, save, 50);
  void executePreparedScan(prepared, hang, save, 50);

  await assert.rejects(
    () => executePreparedScan(prepared, async (payload) => makeScanResult(payload), save, 50),
    (error) => error instanceof PublicScanError && error.status === 503
  );

  assert.deepEqual(scanLimitStateForTests(), {
    activeScans: 2,
    queuedScans: 0,
    trackedClients: 1,
    trackedReportReadClients: 0
  });
});

test("runScanRequest returns a redacted v1 result when report persistence fails", async () => {
  const scan: ScanRunner = async (payload) => makeSensitiveScanResult(payload);
  const warn = console.warn;
  console.warn = () => undefined;
  let result: Awaited<ReturnType<typeof runScanRequest>> | undefined;
  try {
    result = await runScanRequest(makeScanRequest("https://1.1.1.1/"), scan, async () => {
      throw new Error("read-only filesystem");
    });
  } finally {
    console.warn = warn;
  }

  assert.ok(result);
  const v1Result = expectV1Report(result);
  if (v1Result.reportType === "comparison") throw new Error("expected single report");
  assert.equal(v1Result.ok, true);
  assert.equal(v1Result.share, undefined);
  assert.equal(v1Result.summary.pageTitle, "Private customer dashboard");
  assert.equal(v1Result.cookies[0].name, "[redacted]");
  assert.equal(v1Result.storage[0].key, "[redacted]");
  assert.equal(JSON.stringify(v1Result).includes("patient_session_secret"), false);
  assert.equal(JSON.stringify(v1Result).includes("patient_private_record"), false);
  assert.equal(v1Result.warnings.includes("Shareable report could not be saved on this host; JSON export is still available."), true);
});

test("runScanRequest keeps the normal sanitized share when v1 persistence succeeds", async () => {
  const result = expectV1Report(
    await runScanRequest(makeScanRequest("https://1.1.1.1/"), async (payload) => makeSensitiveScanResult(payload))
  );
  if (result.reportType === "comparison") throw new Error("expected single report");

  assert.equal(result.summary.pageTitle, "Private customer dashboard");
  assert.equal(result.cookies[0].name, "[redacted]");
  assert.equal(result.storage[0].key, "[redacted]");
  assert.equal(result.warnings.includes("Shareable report could not be saved on this host; JSON export is still available."), false);
  assert.equal(result.share?.path.startsWith("/reports/"), true);
  assert.deepEqual(await readV1Report(result.share?.id || ""), result);
});

test("executePreparedScan awaits the publication fence before invoking the saver", async () => {
  const prepared: PreparedScanRequest = {
    clientKey: "already-charged",
    url: "https://1.1.1.1/",
    device: "desktop",
    gpcEnabled: true,
    compareGpc: false,
    compareShields: false,
    compareConsent: false,
    rateLimitCost: 1
  };
  let releaseFence: () => void = () => undefined;
  const fence = new Promise<void>((resolve) => {
    releaseFence = resolve;
  });
  const events: string[] = [];
  const execution = executePreparedScan(
    prepared,
    async (payload) => makeScanResult(payload),
    async (report) => {
      events.push("save");
      return report;
    },
    undefined,
    false,
    {
      beforeSave: (report) => {
        events.push(`fence:${report.schemaVersion}`);
        return fence;
      }
    }
  );

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["fence:1"]);
  releaseFence();
  await execution;
  assert.deepEqual(events, ["fence:1", "save"]);
});

function expectV1Report(report: RuntimeScanReport): ScanReport {
  assert.equal(report.schemaVersion, 1);
  if (report.schemaVersion !== 1) throw new Error("expected frozen v1 report");
  return report;
}

function enablePublicR2(): void {
  process.env[PUBLIC_R2_REPORTS_ENV] = "1";
  process.env[BUILD_COMMIT_ENV] = "a".repeat(40);
  process.env[CONSENT_VERIFICATION_ENV] = "1";
}

function makeScanRequest(
  url: string,
  options: { compareGpc?: boolean; compareShields?: boolean; compareConsent?: boolean } = {},
  headers: Record<string, string> = {}
): Request {
  return new Request("http://localhost/api/scan", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({
      url,
      device: "desktop",
      gpcEnabled: true,
      compareGpc: options.compareGpc,
      compareShields: options.compareShields,
      compareConsent: options.compareConsent,
      consentMode: "observe"
    })
  });
}

function makeScanResult(payload: ScanRequestPayload, totalRequests = 0): ScanResult {
  const firstPartyDomain = new URL(payload.url).hostname;
  const requests: ScanResult["requests"] = Array.from({ length: totalRequests }, (_, index) => ({
    id: index + 1,
    url: `https://${firstPartyDomain}/fixture-${index + 1}.js`,
    domain: firstPartyDomain,
    method: "GET",
    resourceType: "script",
    status: 200,
    thirdParty: false,
    tracker: null,
    startedAtMs: index
  }));
  return {
    ok: true,
    schemaVersion: SCAN_REPORT_SCHEMA_VERSION,
    reportType: "single",
    summary: {
      pageTitle: "",
      status: 200,
      durationMs: 1,
      firstPartyDomain,
      totalRequests,
      thirdPartyRequests: 0,
      knownTrackerRequests: 0,
      thirdPartyDomains: 0,
      cookies: 0,
      thirdPartyCookies: 0,
      storageEntries: 0,
      fingerprintEvents: 0
    },
    conditions: {
      requestedUrl: payload.url,
      finalUrl: payload.url,
      scannedAt: new Date(0).toISOString(),
      chromiumVersion: "test",
      userAgent: "test",
      timezone: "UTC",
      locale: "en-US",
      language: "en-US",
      viewport: {
        width: 1440,
        height: 980,
        isMobile: payload.device === "mobile"
      },
      gpcEnabled: payload.gpcEnabled,
      consentMode: payload.consentMode,
      automation: "playwright-chromium",
      headless: true,
      scannerEgress: "test",
      trackerCatalog: {
        source: "test",
        version: "test",
        region: "test",
        entries: 0,
        curatedOverrides: 0,
        license: "test"
      },
      scannerDisclosure: "test"
    },
    requests,
    domains: [],
    cookies: [],
    storage: [],
    fingerprintEvents: [],
    screenshot: null,
    warnings: []
  };
}

function makeSensitiveScanResult(payload: ScanRequestPayload): ScanResult {
  const result = makeScanResult(payload);
  result.summary.pageTitle = "  Private\u0000 customer dashboard  ";
  result.cookies = [
    {
      name: "patient_session_secret",
      domain: ".1.1.1.1",
      path: "/account/patient-name",
      sameSite: "Lax",
      secure: true,
      httpOnly: true,
      session: true,
      thirdParty: false
    }
  ];
  result.storage = [{ area: "localStorage", key: "patient_private_record", valueBytes: 24 }];
  return result;
}
