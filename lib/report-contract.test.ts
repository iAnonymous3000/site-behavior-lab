import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { createGpcComparisonReport } from "./compare-reports";
import { pageGraphToScanResult } from "./pagegraph-adapter";
import { REPORT_PRODUCER_CAPABILITIES } from "./report-producers";
import { isScanReport } from "./report-validation";
import { SCAN_REPORT_SCHEMA_VERSION, type ScanConditions, type ScanReport, type ScanRequestPayload, type ScanResult } from "./types";

const DISALLOWED_STATIC_CATALOG_VALUES = new Set([
  "DuckDuckGo Tracker Radar + curated overrides",
  "Brave-curated service list",
  "brave-curated-2026.06"
]);

test("static fixture reports use the current ScanReport schema", async () => {
  const reportsDir = path.join(process.cwd(), "public", "reports");
  const reportFiles = (await readdir(reportsDir)).filter((file) => /^\d{8}-[a-f0-9]{32}\.json$/.test(file));

  assert.ok(reportFiles.length > 0, "expected static report fixtures");

  for (const file of reportFiles) {
    const report = JSON.parse(await readFile(path.join(reportsDir, file), "utf8")) as unknown;
    if (!isScanReport(report)) {
      assert.fail(`${file} should be a current ScanReport`);
    }

    for (const catalog of trackerCatalogsForReport(report)) {
      assert.equal(DISALLOWED_STATIC_CATALOG_VALUES.has(catalog.source), false, `${file} has stale tracker catalog source`);
      assert.equal(DISALLOWED_STATIC_CATALOG_VALUES.has(catalog.version), false, `${file} has stale tracker catalog version`);
    }
  }
});

test("report validation rejects reports without a current schema version", () => {
  const report = makeScanResult({
    url: "https://example.com/",
    device: "desktop",
    gpcEnabled: true,
    consentMode: "observe"
  }) as Partial<ScanResult>;
  delete report.schemaVersion;

  assert.equal(isScanReport(report), false);
});

test("report validation rejects malformed fingerprint detections", () => {
  const report = makeScanResult({
    url: "https://example.com/",
    device: "desktop",
    gpcEnabled: true,
    consentMode: "observe"
  }) as unknown as Record<string, unknown>;

  report.fingerprintDetections = [
    {
      kind: "canvas-fingerprinting",
      heuristic: "openwpm-canvas-v1",
      count: "1",
      evidence: {
        readApis: ["canvas.toDataURL"],
        maxCanvasWidth: 32,
        maxCanvasHeight: 32,
        maxDistinctTextCharacters: 10,
        maxTextWriteCalls: 1
      }
    }
  ];

  assert.equal(isScanReport(report), false);
});

test("report validation accepts session recording and input-monitoring detections", () => {
  const report = makeScanResult({
    url: "https://example.com/",
    device: "desktop",
    gpcEnabled: true,
    consentMode: "observe"
  });

  report.fingerprintDetections = [
    {
      kind: "session-recording",
      heuristic: "interaction-listener-coverage-v1",
      count: 1,
      evidence: {
        eventTypes: ["click", "mousemove", "scroll", "visibilitychange"],
        listenerTargets: ["document", "window"],
        thirdPartyOrigins: ["https://recorder.example.net"],
        totalListenerCalls: 6
      }
    },
    {
      kind: "input-monitoring",
      heuristic: "input-listener-coverage-v1",
      count: 1,
      evidence: {
        eventTypes: ["input", "keydown"],
        listenerTargets: ["input"],
        thirdPartyOrigins: ["https://recorder.example.net"],
        totalListenerCalls: 2
      }
    }
  ];

  assert.equal(isScanReport(report), true);
});

test("report validation accepts behavioral fingerprint detections", () => {
  const report = makeScanResult({
    url: "https://example.com/",
    device: "desktop",
    gpcEnabled: true,
    consentMode: "observe"
  });

  report.fingerprintDetections = [
    {
      kind: "canvas-font-fingerprinting",
      heuristic: "canvas-font-probing-v1",
      count: 1,
      evidence: {
        measureTextCalls: 8,
        maxDistinctFonts: 4,
        maxDistinctTextSamples: 1,
        maxTextLength: 12
      }
    },
    {
      kind: "webgl-fingerprinting",
      heuristic: "webgl-entropy-read-v1",
      count: 1,
      evidence: {
        readApis: ["webgl.readPixels"],
        parameters: ["webgl.getParameter.UNMASKED_RENDERER_WEBGL"],
        getParameterCalls: 1,
        readPixelsCalls: 1
      }
    },
    {
      kind: "audio-fingerprinting",
      heuristic: "audio-rendering-v1",
      count: 1,
      evidence: {
        apis: ["audio.OfflineAudioContext.createOscillator", "audio.OfflineAudioContext.startRendering"],
        offlineRenderCalls: 1,
        oscillatorCalls: 1,
        compressorCalls: 0,
        analyserCalls: 0
      }
    },
    {
      kind: "webrtc-fingerprinting",
      heuristic: "webrtc-peerconnection-v1",
      count: 1,
      evidence: {
        constructorCalls: 1,
        createDataChannelCalls: 1,
        createOfferCalls: 1,
        setLocalDescriptionCalls: 0
      }
    }
  ];

  assert.equal(isScanReport(report), true);
});

test("report validation rejects listener detections without third-party origins", () => {
  const report = makeScanResult({
    url: "https://example.com/",
    device: "desktop",
    gpcEnabled: true,
    consentMode: "observe"
  }) as unknown as Record<string, unknown>;

  report.fingerprintDetections = [
    {
      kind: "input-monitoring",
      heuristic: "input-listener-coverage-v1",
      count: 1,
      evidence: {
        eventTypes: ["input", "keydown"],
        listenerTargets: ["input"],
        totalListenerCalls: 4
      }
    }
  ];

  assert.equal(isScanReport(report), false);
});

test("PageGraph and comparison producers emit current ScanReport artifacts", () => {
  const pageGraph = pageGraphToScanResult({
    requestedUrl: "https://example.com/",
    finalUrl: "https://example.com/",
    scannedAt: new Date(0).toISOString()
  });
  const comparison = createGpcComparisonReport(
    makeScanResult({ url: "https://example.com/", device: "desktop", gpcEnabled: false, consentMode: "observe" }),
    makeScanResult({ url: "https://example.com/", device: "desktop", gpcEnabled: true, consentMode: "observe" })
  );

  assert.equal(pageGraph.schemaVersion, SCAN_REPORT_SCHEMA_VERSION);
  assert.equal(comparison.schemaVersion, SCAN_REPORT_SCHEMA_VERSION);
  assert.equal(comparison.baseline.schemaVersion, SCAN_REPORT_SCHEMA_VERSION);
  assert.equal(comparison.variant.schemaVersion, SCAN_REPORT_SCHEMA_VERSION);
  assert.equal(isScanReport(pageGraph), true);
  assert.equal(isScanReport(comparison), true);
});

test("report producer capability matrix captures intentional runtime gaps", () => {
  const capabilities = new Map(REPORT_PRODUCER_CAPABILITIES.map((capability) => [capability.producer, capability]));

  assert.equal(capabilities.get("node")?.gpcComparison, true);
  assert.equal(capabilities.get("node")?.shieldsComparison, true);
  assert.equal(capabilities.get("node")?.asyncJobs, true);
  assert.equal(capabilities.get("node")?.trackerCatalog, "hand-curated-service-catalog");
  assert.equal(capabilities.get("cloudflare-worker")?.gpcComparison, true);
  assert.equal(capabilities.get("cloudflare-worker")?.shieldsComparison, false);
  assert.equal(capabilities.get("node")?.dnsGuard, "node-connect-time-proxy");
  assert.equal(capabilities.get("cloudflare-worker")?.dnsGuard, "edge-doh-preflight-only");
  assert.equal(capabilities.get("cloudflare-worker")?.trackerCatalog, "none");
  assert.equal(capabilities.get("pagegraph")?.singleScan, true);
  assert.equal(capabilities.get("pagegraph")?.trackerCatalog, "provided-or-hand-curated");
  assert.equal(capabilities.get("pagegraph")?.reportStore, "caller-managed");
});

function trackerCatalogsForReport(report: ScanReport): ScanConditions["trackerCatalog"][] {
  if (report.reportType === "comparison") {
    return [report.baseline.conditions.trackerCatalog, report.variant.conditions.trackerCatalog];
  }

  return [report.conditions.trackerCatalog];
}

function makeScanResult(payload: ScanRequestPayload): ScanResult {
  return {
    ok: true,
    schemaVersion: SCAN_REPORT_SCHEMA_VERSION,
    reportType: "single",
    summary: {
      pageTitle: "",
      status: 200,
      durationMs: 1,
      firstPartyDomain: new URL(payload.url).hostname,
      totalRequests: 0,
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
