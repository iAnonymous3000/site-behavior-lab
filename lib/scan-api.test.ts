import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, test } from "node:test";
import { PublicScanError } from "./public-errors";
import { RATE_LIMIT_MAX, resetScanLimitStateForTests, scanLimitStateForTests } from "./scan-limits";
import { executePreparedScan, prepareScanRequest, runScanRequest, type PreparedScanRequest, type ScanRunner } from "./scan-api";
import { readScanReport } from "./report-store";
import { SCAN_REPORT_SCHEMA_VERSION, type ScanReport, type ScanRequestPayload, type ScanResult } from "./types";

const SCAN_ACCESS_TOKEN_ENV = "SITE_BEHAVIOR_LAB_SCAN_ACCESS_TOKEN";

afterEach(async () => {
  delete process.env[SCAN_ACCESS_TOKEN_ENV];
  resetScanLimitStateForTests();
  await rm(path.join(process.cwd(), ".site-behavior-lab"), { recursive: true, force: true });
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

  const result = await runScanRequest(
    makeScanRequest("https://1.1.1.1/", {}, { "x-site-behavior-lab-access-token": "secret-key" }),
    scan
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
    rateLimitCost: 2
  });
  assert.deepEqual(scanLimitStateForTests(), {
    activeScans: 0,
    queuedScans: 0,
    trackedClients: 0,
    trackedReportReadClients: 0
  });
});

test("executePreparedScan charges rate limits only after acquiring a scan slot", async () => {
  const prepared: PreparedScanRequest = {
    clientKey: "queued-client",
    url: "https://1.1.1.1/",
    device: "mobile",
    gpcEnabled: false,
    compareGpc: false,
    compareShields: false,
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

  const result = await executePreparedScan(prepared, scan, async (report) => report);

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

  const result = await runScanRequest(makeScanRequest("https://1.1.1.1/?token=still-scanned"), scan);

  assert.equal(result.ok, true);
  assert.equal(result.share?.path.startsWith("/reports/"), true);
  assert.deepEqual(await readScanReport(result.share?.id || ""), result);
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

  const result = await runScanRequest(makeScanRequest("https://1.1.1.1/", { compareGpc: true }), scan);

  assert.equal(result.reportType, "comparison");
  assert.deepEqual(scannedPayloads.map((payload) => payload.gpcEnabled), [false, true]);
  assert.deepEqual(scannedPayloads.map((payload) => payload.url.endsWith("#verified=true")), [true, true]);
  if (result.reportType !== "comparison") throw new Error("expected comparison report");
  assert.equal(result.diff.totalRequests.before, 5);
  assert.equal(result.diff.totalRequests.after, 3);
  assert.equal(result.diff.totalRequests.delta, -2);
  assert.equal(result.share?.path.startsWith("/reports/"), true);
  assert.deepEqual(await readScanReport(result.share?.id || ""), result);
});

test("runScanRequest can run and persist a Shields off/on comparison", async () => {
  const scannedPayloads: ScanRequestPayload[] = [];
  const scanOptions: unknown[] = [];
  const scan: ScanRunner = async (payload, options) => {
    scannedPayloads.push(payload);
    scanOptions.push(options);
    return makeScanResult(payload, options?.shieldsBlockingEnabled ? 3 : 8);
  };

  const result = await runScanRequest(makeScanRequest("https://1.1.1.1/", { compareShields: true }), scan);

  assert.equal(result.reportType, "comparison");
  if (result.reportType !== "comparison") throw new Error("expected comparison report");
  assert.equal(result.comparisonType, "shields");
  assert.deepEqual(scannedPayloads.map((payload) => payload.gpcEnabled), [true, true]);
  assert.deepEqual(scanOptions.map((options) => Boolean((options as { shieldsBlockingEnabled?: boolean }).shieldsBlockingEnabled)), [
    false,
    true
  ]);
  assert.equal(result.diff.totalRequests.before, 8);
  assert.equal(result.diff.totalRequests.after, 3);
  assert.equal(result.diff.totalRequests.delta, -5);
  assert.equal(result.share?.path.startsWith("/reports/"), true);
  assert.deepEqual(await readScanReport(result.share?.id || ""), result);
});

test("prepareScanRequest rejects conflicting comparison modes", async () => {
  await assert.rejects(
    () => prepareScanRequest(makeScanRequest("https://1.1.1.1/", { compareGpc: true, compareShields: true })),
    (error) => error instanceof PublicScanError && error.message === "Choose one comparison mode."
  );
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
    rateLimitCost: 1
  };
  const hang: ScanRunner = () => new Promise(() => {});
  const save = async <T extends ScanReport>(report: T) => report;

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

test("runScanRequest returns scan results when report persistence fails", async () => {
  const scan: ScanRunner = async (payload) => makeScanResult(payload);
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
  assert.equal(result.ok, true);
  assert.equal(result.share, undefined);
  assert.equal(result.warnings.includes("Shareable report could not be saved on this host; JSON export is still available."), true);
});

function makeScanRequest(
  url: string,
  options: { compareGpc?: boolean; compareShields?: boolean } = {},
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
      consentMode: "observe"
    })
  });
}

function makeScanResult(payload: ScanRequestPayload, totalRequests = 0): ScanResult {
  return {
    ok: true,
    schemaVersion: SCAN_REPORT_SCHEMA_VERSION,
    reportType: "single",
    summary: {
      pageTitle: "",
      status: 200,
      durationMs: 1,
      firstPartyDomain: new URL(payload.url).hostname,
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
    requests: [],
    domains: [],
    cookies: [],
    storage: [],
    fingerprintEvents: [],
    screenshot: null,
    warnings: []
  };
}
