import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { parse as parseHostname } from "tldts";
import { publicReportDigest } from "./canonical-json";
import { committedReportCreatedAt } from "./committed-report-created-at";
import { createGpcComparisonReport } from "./compare-reports";
import {
  buildPageGraphScanReportV2R2,
  type PageGraphCaptureMetadataV1
} from "./pagegraph-v2-r2-builder";
import { redactScanReportV1 } from "./redact-scan-report-v1";
import { REPORT_PRODUCER_CAPABILITIES } from "./report-producers";
import { isScanReport } from "./report-validation";
import { isPublicScanReportV2R2 } from "./scan-report-v2-r2-validation";
import { readStoredScanReport, type StoredScanReport } from "./scan-report-reader";
import { redactPublicScanReportV2R2 } from "./scan-report-v2-r2-remediation";
import {
  listDanglingStaticSidecarIds,
  readStaticReportBundle
} from "./static-report-files";
import { SCAN_REPORT_SCHEMA_VERSION, type ScanRequestPayload, type ScanResult } from "./types";

const DISALLOWED_STATIC_CATALOG_VALUES = new Set([
  "DuckDuckGo Tracker Radar + curated overrides",
  "Brave-curated service list",
  "brave-curated-2026.06"
]);

test("static fixture reports are current version-aware managed reports", async () => {
  const reportsDir = path.join(process.cwd(), "public", "reports");
  const reportFiles = (await readdir(reportsDir)).filter((file) => /^\d{8}-[a-f0-9]{32}\.json$/.test(file));

  assert.ok(reportFiles.length > 0, "expected static report fixtures");
  assert.deepEqual(await listDanglingStaticSidecarIds(reportsDir), []);

  for (const file of reportFiles) {
    const id = file.replace(/\.json$/, "");
    const managed = await readStaticReportBundle(reportsDir, id);
    if (managed.outcome !== "found") {
      assert.fail(`${file} should be a current managed report (${managed.outcome === "unreadable" ? managed.reason : managed.outcome})`);
    }
    assert.equal(
      managed.provenance.createdAt,
      committedReportCreatedAt(managed.stored),
      `${file} has a provenance clock that does not cover every embedded run`
    );
    for (const catalog of trackerCatalogsForStoredReport(managed.stored)) {
      assert.equal(DISALLOWED_STATIC_CATALOG_VALUES.has(catalog.source), false, `${file} has stale tracker catalog source`);
      assert.equal(DISALLOWED_STATIC_CATALOG_VALUES.has(catalog.version), false, `${file} has stale tracker catalog version`);
    }
  }
});

test("every committed report is a sanitizer fixed point, and so is its sanitized form", async () => {
  // Both directions, every report, every offender named at once. The managed
  // read above checks one pass against the sidecar; the second pass catches a
  // rule that happens to be a fixed point on this corpus but is not
  // idempotent in general.
  const reportsDir = path.join(process.cwd(), "public", "reports");
  const reportFiles = (await readdir(reportsDir)).filter((file) => /^\d{8}-[a-f0-9]{32}\.json$/.test(file));
  assert.ok(reportFiles.length > 0, "expected static report fixtures");
  // Schema-2 revision 1 has no public sanitizer transform, and none is committed.
  const redact = (stored: StoredScanReport): unknown =>
    stored.schemaVersion === 1
      ? redactScanReportV1(stored.report).report
      : stored.schemaRevision === 2
        ? redactPublicScanReportV2R2(stored.report)
        : stored.report;
  const notFixedPoints: string[] = [];
  const notIdempotent: string[] = [];
  for (const file of reportFiles) {
    const id = file.replace(/\.json$/, "");
    const read = readStoredScanReport(JSON.parse(await readFile(path.join(reportsDir, file), "utf8")));
    if (!read.ok) {
      notFixedPoints.push(`${id} (unreadable)`);
      continue;
    }
    try {
      const once = redact(read.stored);
      if (publicReportDigest(once) !== publicReportDigest(read.stored.report)) notFixedPoints.push(id);
      const reread = readStoredScanReport(once);
      if (!reread.ok || publicReportDigest(redact(reread.stored)) !== publicReportDigest(once)) {
        notIdempotent.push(id);
      }
    } catch (error) {
      notFixedPoints.push(`${id} (${error instanceof Error ? error.message : "sanitizer threw"})`);
    }
  }
  assert.deepEqual({ notFixedPoints, notIdempotent }, { notFixedPoints: [], notIdempotent: [] });
});

test("no committed evidence names a private-suffix tenant address or a quoted identifier", async () => {
  // Independent of the sanitizer on purpose: this reads the published bytes
  // with its own host split and its own digit count, so it cannot pass by
  // agreeing with the code it checks.
  const publicDir = path.join(process.cwd(), "public");
  const reportsDir = path.join(publicDir, "reports");
  const files = [
    ...(await readdir(reportsDir))
      .filter((file) => /^\d{8}-[a-f0-9]{32}\.json$/.test(file))
      .map((file) => path.join(reportsDir, file)),
    path.join(reportsDir, "index.json"),
    path.join(publicDir, "corpus-stats.json")
  ];
  const privateRegistrables = new Set<string>();
  let quotes = 0;
  const offenders = new Set<string>();

  const addressTenant = (label: string): boolean => {
    const segments = label.split(/[-_]/);
    for (let start = 0; start + 4 <= segments.length; start += 1) {
      if (segments.slice(start, start + 4).every((segment) => /^[0-9]{1,3}$/.test(segment) && Number(segment) <= 255)) {
        return true;
      }
    }
    return false;
  };
  const quoteIdentifier = (quote: string): boolean => {
    if (quote.includes("@") || quote.includes("://")) return true;
    const joinedDigits = quote.replace(/([0-9])[\s().-]{1,2}(?=[0-9])/g, "$1");
    return /[0-9]{9,}/.test(joinedDigits);
  };
  const visit = (value: unknown, source: string, key?: string): void => {
    if (typeof value === "string") {
      if (key === "quote") {
        quotes += 1;
        if (quoteIdentifier(value)) offenders.add(`${source} (quote)`);
      }
      for (const candidate of value.toLowerCase().match(/[a-z0-9_-]+(?:\.[a-z0-9_-]+)+/g) ?? []) {
        const parsed = parseHostname(candidate, { allowPrivateDomains: true });
        if (parsed.isPrivate !== true || !parsed.domain) continue;
        privateRegistrables.add(parsed.domain);
        if (addressTenant(parsed.domain.split(".")[0])) offenders.add(`${source} (${parsed.publicSuffix} tenant)`);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const element of value) visit(element, source, key);
      return;
    }
    if (value === null || typeof value !== "object") return;
    for (const [childKey, child] of Object.entries(value)) visit(child, source, childKey);
  };
  for (const file of files) {
    visit(JSON.parse(await readFile(file, "utf8")), path.basename(file, ".json"));
  }

  assert.ok(privateRegistrables.size > 0, "the walk must reach at least one private-suffix host");
  assert.ok(quotes > 0, "the walk must reach at least one policy quote");
  assert.deepEqual([...offenders].sort(), []);
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

test("report validation accepts a report without a screenshot key (UI JSON export shape)", () => {
  const report = makeScanResult({
    url: "https://example.com/",
    device: "desktop",
    gpcEnabled: true,
    consentMode: "observe"
  }) as Partial<ScanResult>;
  delete report.screenshot;

  // The UI's JSON export omits the screenshot key entirely; round-tripping the
  // exported file back through the report viewer must keep working.
  assert.equal(isScanReport(JSON.parse(JSON.stringify(report))), true);
});

test("report validation accepts and rejects privacy-policy summaries by shape", () => {
  const report = makeScanResult({
    url: "https://example.com/",
    device: "desktop",
    gpcEnabled: true,
    consentMode: "observe"
  });

  report.privacyPolicy = {
    url: "https://example.com/privacy",
    claims: [{ kind: "no-third-party-cookies", quote: "We do not use third-party cookies." }],
    mentionedEntities: ["Google"],
    unmentionedEntities: ["Criteo"],
    policyTextLength: 5200
  };
  assert.equal(isScanReport(report), true);

  const malformed = report as unknown as Record<string, unknown>;
  malformed.privacyPolicy = { url: "https://example.com/privacy", claims: [{ kind: "not-a-kind", quote: "x" }] };
  assert.equal(isScanReport(malformed), false);
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

test("paired PageGraph import and comparison producers emit their current report artifacts", async () => {
  const fixtureDir = path.join(process.cwd(), "lib", "__fixtures__", "pagegraph");
  const graphBytes = new Uint8Array(await readFile(path.join(fixtureDir, "real-wikipedia-2026-07-19.graphml")));
  const graphMetadata = JSON.parse(
    await readFile(path.join(fixtureDir, "real-wikipedia-2026-07-19.meta.json"), "utf8")
  ) as PageGraphCaptureMetadataV1;
  const pageGraph = buildPageGraphScanReportV2R2(graphBytes, graphMetadata, {
    buildCommit: "a".repeat(40),
    runId: "pagegraph-contract-test-0001"
  });
  const comparison = createGpcComparisonReport(
    makeScanResult({ url: "https://example.com/", device: "desktop", gpcEnabled: false, consentMode: "observe" }),
    makeScanResult({ url: "https://example.com/", device: "desktop", gpcEnabled: true, consentMode: "observe" })
  );

  assert.equal(pageGraph.schemaVersion, 2);
  assert.equal(pageGraph.schemaRevision, 2);
  assert.equal(pageGraph.run.provenance.observer, "pagegraph-import");
  assert.equal(comparison.schemaVersion, SCAN_REPORT_SCHEMA_VERSION);
  assert.equal(comparison.baseline.schemaVersion, SCAN_REPORT_SCHEMA_VERSION);
  assert.equal(comparison.variant.schemaVersion, SCAN_REPORT_SCHEMA_VERSION);
  assert.equal(isPublicScanReportV2R2(pageGraph), true);
  assert.equal(isScanReport(comparison), true);
});

test("report producer capability matrix captures intentional runtime gaps", () => {
  const capabilities = new Map(REPORT_PRODUCER_CAPABILITIES.map((capability) => [capability.producer, capability]));

  assert.equal(capabilities.get("node")?.gpcComparison, true);
  assert.equal(capabilities.get("node")?.shieldsComparison, true);
  assert.equal(capabilities.get("node")?.consentComparison, true);
  assert.equal(capabilities.get("node")?.asyncJobs, true);
  assert.equal(capabilities.get("node")?.trackerCatalog, "hand-curated-service-catalog");
  assert.equal(capabilities.get("cloudflare-worker")?.gpcComparison, true);
  assert.equal(capabilities.get("cloudflare-worker")?.shieldsComparison, false);
  assert.equal(capabilities.get("cloudflare-worker")?.consentComparison, false);
  assert.equal(capabilities.get("pagegraph")?.consentComparison, false);
  assert.equal(capabilities.get("node")?.dnsGuard, "node-connect-time-proxy");
  assert.equal(capabilities.get("cloudflare-worker")?.dnsGuard, "edge-doh-preflight-only");
  assert.equal(capabilities.get("cloudflare-worker")?.trackerCatalog, "none");
  assert.equal(capabilities.get("pagegraph")?.singleScan, true);
  assert.equal(capabilities.get("pagegraph")?.runtime, "Paired GraphML + sidecar r2 import");
  assert.equal(capabilities.get("pagegraph")?.dnsGuard, "not-applicable-local-artifact");
  assert.equal(capabilities.get("pagegraph")?.trackerCatalog, "hand-curated-service-catalog");
  assert.equal(capabilities.get("pagegraph")?.reportStore, "caller-managed");
});

function trackerCatalogsForStoredReport(stored: StoredScanReport): Array<{ source: string; version: string }> {
  if (stored.schemaVersion === 1) {
    if (stored.report.reportType === "comparison") {
      return [stored.report.baseline.conditions.trackerCatalog, stored.report.variant.conditions.trackerCatalog];
    }
    return [stored.report.conditions.trackerCatalog];
  }

  if (stored.report.reportType === "single") return [stored.report.run.toolchain.trackerCatalog];

  const catalogs = [
    stored.report.baseline.toolchain.trackerCatalog,
    stored.report.variant.toolchain.trackerCatalog
  ];
  if (
    stored.schemaRevision === 2 &&
    stored.report.experiment.kind === "intervention"
  ) {
    for (const pair of stored.report.experiment.supportingPairs ?? []) {
      catalogs.push(pair.baseline.toolchain.trackerCatalog, pair.variant.toolchain.trackerCatalog);
    }
  }
  return catalogs;
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
