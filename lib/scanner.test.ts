import assert from "node:assert/strict";
import { createServer } from "node:http";
import { connect } from "node:net";
import { test } from "node:test";
import { PublicScanError } from "./public-errors";
import { TCF_API_METHOD } from "./consent-verification";
import { MeasurementKernel } from "./measurement-kernel";
import { buildScanConditions, buildScanResult } from "./scan-result-builder";
import { ScanNetworkRecorder } from "./scan-runtime";
import type { FingerprintDetectionSummary } from "./types";
import {
  attachStagedSingleVisitMeasurement,
  browserProcessEnvironment,
  closeSharedBrowserForTests,
  createContextOptions,
  decideRoutedRequest,
  MAX_RECORDED_REQUESTS,
  NON_HTTP_WARNING_EXAMPLE_LIMIT,
  phaseAwareDetections,
  redactUrlForReport,
  SCAN_CHROMIUM_LAUNCH_ARGS,
  ScanRequestBudget,
  scannerEgressRegion,
  scanSite,
  scanTimeout,
  ScanWarningCollector,
  sameScanSubjectUrl,
  stagedSingleVisitMeasurement,
  typeSentinelIntoFields
} from "./scanner";
import { resolveScannerEgressRegion } from "./scanner-egress";

test("scannerEgressRegion records only r2-safe explicit regions or complete Cloudflare placement", () => {
  // The r2 comparability gates treat an unrecorded egress region as unknown,
  // and two unknowns never match (RFC 3.2), so a deployment that can name its
  // egress location must record it or every production pair loses its deltas.
  assert.equal(
    scannerEgressRegion({ SITE_BEHAVIOR_LAB_SCANNER_EGRESS_REGION: " us-east " , CLOUDFLARE_REGION: "wnam" }),
    "us-east"
  );
  assert.equal(
    scannerEgressRegion({ CLOUDFLARE_REGION: "wnam", CLOUDFLARE_LOCATION: "Los Angeles", CLOUDFLARE_COUNTRY_A2: "US" }),
    "wnam/Los Angeles/US"
  );
  assert.equal(scannerEgressRegion({ CLOUDFLARE_COUNTRY_A2: "US" }), undefined);
  assert.equal(scannerEgressRegion({ SITE_BEHAVIOR_LAB_SCANNER_EGRESS_REGION: "  " }), undefined);
  assert.equal(scannerEgressRegion({ SITE_BEHAVIOR_LAB_SCANNER_EGRESS_REGION: "unknown" }), undefined);
  assert.equal(scannerEgressRegion({ SITE_BEHAVIOR_LAB_SCANNER_EGRESS_REGION: "x".repeat(65) }), undefined);
  assert.equal(scannerEgressRegion({ SITE_BEHAVIOR_LAB_SCANNER_EGRESS_REGION: "us-west\u0000other" }), undefined);
  assert.equal(scannerEgressRegion({}), undefined);

  assert.deepEqual(resolveScannerEgressRegion({ CLOUDFLARE_COUNTRY_A2: "US" }), { status: "misconfigured" });
  assert.deepEqual(resolveScannerEgressRegion({ SITE_BEHAVIOR_LAB_SCANNER_EGRESS_REGION: "  " }), {
    status: "misconfigured"
  });
  assert.deepEqual(resolveScannerEgressRegion({}), { status: "unrecorded" });
});

test("scan browser launch args contain WebRTC egress containment", () => {
  // ICE/STUN speaks UDP directly to arbitrary hosts, bypassing the HTTP-only
  // scan proxy and its public-address guard; disable_non_proxied_udp is the
  // control that closes that channel (verified at runtime: without it a
  // proxied Chromium still gathers direct-UDP host candidates). Removing this
  // flag reopens direct scanner egress.
  assert.ok(
    SCAN_CHROMIUM_LAUNCH_ARGS.includes("--force-webrtc-ip-handling-policy=disable_non_proxied_udp"),
    "WebRTC containment flag missing from scan launch args"
  );
});

test("scan browser child environment preserves runtime essentials but strips application secrets", () => {
  const child = browserProcessEnvironment({
    HOME: "/home/pwuser",
    PATH: "/usr/bin:/bin",
    LANG: "en_US.UTF-8",
    XDG_RUNTIME_DIR: "/tmp/runtime",
    SITE_BEHAVIOR_LAB_R2_SECRET_ACCESS_KEY: "r2-secret",
    SITE_BEHAVIOR_LAB_TURNSTILE_SECRET_KEY: "turnstile-secret",
    SITE_BEHAVIOR_LAB_SCAN_ACCESS_TOKEN: "scan-secret",
    AWS_SECRET_ACCESS_KEY: "aws-secret",
    HTTP_PROXY: "http://unexpected-proxy.test"
  });

  assert.deepEqual(child, {
    HOME: "/home/pwuser",
    LANG: "en_US.UTF-8",
    PATH: "/usr/bin:/bin",
    XDG_RUNTIME_DIR: "/tmp/runtime"
  });
  assert.equal(Object.values(child).some((value) => value.includes("secret")), false);
});

test("scan browser contexts block Service Workers on desktop and mobile", () => {
  for (const device of ["desktop", "mobile"] as const) {
    const options = createContextOptions(
      { url: "https://example.com/", device, gpcEnabled: false, consentMode: "observe" },
      "http://127.0.0.1:9000"
    );
    assert.equal(options.serviceWorkers, "block");
  }
});

test("post-consent subject checks require the exact normalized HTTP(S) origin", () => {
  assert.equal(sameScanSubjectUrl("https://www.example.com/after", "https://www.example.com/before"), true);
  assert.equal(sameScanSubjectUrl("https://account.example.com/after", "https://www.example.com/before"), false);
  assert.equal(sameScanSubjectUrl("http://www.example.com/after", "https://www.example.com/before"), false);
  assert.equal(sameScanSubjectUrl("https://www.example.com:8443/after", "https://www.example.com/before"), false);
  assert.equal(sameScanSubjectUrl("ftp://www.example.com/after", "https://www.example.com/before"), false);
  assert.equal(sameScanSubjectUrl("about:blank", "https://www.example.com/before"), false);
});

test("active input typing stops if focus races an origin change", async () => {
  let currentUrl = "https://www.example.com/form";
  let typed = false;
  const handle = {
    async isVisible() {
      return true;
    },
    async evaluate(callback: (element: HTMLElement) => unknown) {
      const element = {
        tagName: "INPUT",
        isContentEditable: false,
        getAttribute: () => "text",
        blur: () => undefined
      } as unknown as HTMLElement;
      return callback(element);
    },
    async focus() {
      currentUrl = "https://account.example.com/redirected";
    },
    async type() {
      typed = true;
    },
    async dispose() {}
  };
  const page = {
    url: () => currentUrl,
    $$: async () => [handle]
  };

  const result = await typeSentinelIntoFields(
    page as unknown as Parameters<typeof typeSentinelIntoFields>[0],
    "synthetic-value",
    "https://www.example.com/form"
  );

  assert.deepEqual(result, { count: 0, types: [], subjectLost: true });
  assert.equal(typed, false);
});

test("phase-aware fingerprint detections never assign cumulative evidence to the passive phase", () => {
  const passive: FingerprintDetectionSummary = {
    kind: "canvas-fingerprinting",
    heuristic: "openwpm-canvas-v1",
    count: 1,
    evidence: {
      readApis: ["canvas.toDataURL"],
      maxCanvasWidth: 32,
      maxCanvasHeight: 32,
      maxDistinctTextCharacters: 10,
      maxTextWriteCalls: 1
    }
  };
  const cumulative: FingerprintDetectionSummary = {
    ...passive,
    count: 5,
    evidence: { ...passive.evidence, maxTextWriteCalls: 9 }
  };
  const laterOnly: FingerprintDetectionSummary = {
    kind: "webrtc-fingerprinting",
    heuristic: "webrtc-peerconnection-v1",
    count: 1,
    evidence: {
      constructorCalls: 1,
      createDataChannelCalls: 1,
      createOfferCalls: 0,
      setLocalDescriptionCalls: 0
    }
  };

  const split = phaseAwareDetections([cumulative, laterOnly], [passive], 0, 1);
  assert.equal(split.attributionIncomplete, true);
  assert.deepEqual(split.detections, [
    { ...passive, phaseId: 0 },
    { ...laterOnly, phaseId: 1 }
  ]);
});

test("scanSite rejects a pre-aborted visit before launching browser work", async () => {
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    () =>
      scanSite(
        {
          url: "https://example.com/",
          device: "desktop",
          gpcEnabled: true,
          consentMode: "observe"
        },
        { signal: controller.signal }
      ),
    (error) => error instanceof Error && error.name === "AbortError"
  );
});

type TestFrame = {
  parentFrame(): TestFrame | null;
  url(): string;
};

function testFrame(url: string, parent: TestFrame | null = null): TestFrame {
  return {
    parentFrame: () => parent,
    url: () => url
  };
}

const mainFrame = testFrame("https://example.com/");
const routePage = {
  mainFrame: () => mainFrame
};

function routeRequest({
  url,
  method = "GET",
  resourceType = "script",
  navigation = false,
  frame = mainFrame,
  frameThrows = false,
  serviceWorkerUrl = null,
  serviceWorkerUrlThrows = false
}: {
  url: string;
  method?: string;
  resourceType?: string;
  navigation?: boolean;
  frame?: TestFrame;
  frameThrows?: boolean;
  serviceWorkerUrl?: string | null;
  serviceWorkerUrlThrows?: boolean;
}) {
  return {
    frame: () => {
      if (frameThrows) throw new Error("frame unavailable");
      return frame;
    },
    isNavigationRequest: () => navigation,
    method: () => method,
    resourceType: () => resourceType,
    serviceWorker: () =>
      serviceWorkerUrl
        ? {
            url: () => {
              if (serviceWorkerUrlThrows) throw new Error("worker URL unavailable");
              return serviceWorkerUrl;
            }
          }
        : null,
    url: () => url
  };
}

test("redactUrlForReport removes report-sensitive URL components", () => {
  assert.equal(
    redactUrlForReport("https://user:pass@example.com/path/to/page?token=secret&email=a%40b.test#section"),
    "https://example.com/path/to/page"
  );
});

test("redactUrlForReport keeps origin and path for normal report context", () => {
  assert.equal(redactUrlForReport("https://Example.com/a/b?utm_source=newsletter"), "https://example.com/a/b");
  assert.equal(redactUrlForReport("not a url"), "not a url");
});

test("redactUrlForReport can preserve query keys while redacting values", () => {
  assert.equal(
    redactUrlForReport("https://tracker.example/pixel?id=123&email=a%40b.test&id=456#frag", { preserveQueryKeys: true }),
    "https://tracker.example/pixel?id=&email=&id="
  );
});

test("redactUrlForReport replaces value-shaped query keys so names cannot leak PII", () => {
  // A scanned page could put sensitive data in the parameter *name* itself.
  const emailAsKey = redactUrlForReport("https://tracker.example/p?alice%40example.com=1", { preserveQueryKeys: true });
  assert.equal(emailAsKey.includes("alice"), false);
  assert.equal(emailAsKey, "https://tracker.example/p?%5Bredacted%5D=");

  const longKey = "a".repeat(120);
  const overlong = redactUrlForReport(`https://tracker.example/p?${longKey}=1`, { preserveQueryKeys: true });
  assert.equal(overlong.includes(longKey), false);

  // Conventional analytics/pixel key shapes still survive.
  assert.equal(
    redactUrlForReport("https://tracker.example/tr?ev=Purchase&ud%5Bem%5D=x&utm_source=n", { preserveQueryKeys: true }),
    "https://tracker.example/tr?ev=&ud%5Bem%5D=&utm_source="
  );
});

test("scanTimeout returns the smaller of the preferred timeout and remaining scan budget", () => {
  assert.equal(scanTimeout(1_000, 30_000, 2_000), 30_000);
  assert.equal(scanTimeout(1_000, 30_000, 45_000), 1_000);
});

test("scanTimeout throws a public timeout error after the scan budget is exhausted", () => {
  assert.throws(
    () => scanTimeout(1_000, 30_000, 46_000),
    (error) => error instanceof PublicScanError && error.status === 504
  );
});

test("ScanRequestBudget allows exactly the configured request cap and warns once after it", () => {
  const warnings = new ScanWarningCollector();
  const budget = new ScanRequestBudget(warnings, 2);

  assert.equal(budget.allowRoutedHttpRequest(), true);
  assert.equal(budget.allowRoutedHttpRequest(), true);
  assert.equal(budget.allowRoutedHttpRequest(), false);
  assert.equal(budget.allowRoutedHttpRequest(), false);
  assert.deepEqual(warnings.list, ["The scan stopped recording or loading additional requests after 2 requests."]);

  const recordWarnings = new ScanWarningCollector();
  const recordBudget = new ScanRequestBudget(recordWarnings, MAX_RECORDED_REQUESTS);
  for (let index = 0; index < MAX_RECORDED_REQUESTS; index += 1) {
    assert.equal(recordBudget.allowRecordedRequest(), true);
  }
  assert.equal(recordBudget.allowRecordedRequest(), false);
  assert.equal(recordWarnings.list.length, 1);
});

test("ScanRequestBudget can release skipped recorded requests", () => {
  const warnings = new ScanWarningCollector();
  const budget = new ScanRequestBudget(warnings, 1);

  assert.equal(budget.allowRecordedRequest(), true);
  budget.releaseRecordedRequest();
  assert.equal(budget.allowRecordedRequest(), true);
  assert.deepEqual(warnings.list, []);
});

test("ScanRequestBudget exposes its request-capture loss without target data", () => {
  const budget = new ScanRequestBudget(new ScanWarningCollector(), 1);
  assert.deepEqual(budget.getDiagnostics(), {
    name: "request-capture",
    family: "requests",
    captureLoss: false
  });
  assert.equal(budget.allowRoutedHttpRequest(), true);
  assert.equal(budget.allowRoutedHttpRequest(), false);
  assert.deepEqual(budget.getDiagnostics(), {
    name: "request-capture",
    family: "requests",
    captureLoss: true
  });
});

test("phase-aware single-visit facts attach out of band while the v1 wire stays byte-identical", () => {
  let now = 1_000;
  const kernel = new MeasurementKernel<object>(1_000, () => now);
  const passiveRequest = {};
  const probeRequest = {};
  const passivePhaseId = kernel.beginPhase("passive-load");
  kernel.tagRequest(passiveRequest);
  now = 1_100;
  const probePhaseId = kernel.beginPhase("active-probe");
  kernel.tagRequest(probeRequest);
  kernel.setDetector("fingerprint-heuristics", "complete", { phaseId: passivePhaseId });
  kernel.setDetector("keystroke-exfiltration", "complete", { phaseId: probePhaseId });
  kernel.setDetector("cname-uncloaking", "complete", { phaseId: passivePhaseId });
  kernel.setDetector("pixel-events", "complete", { phaseId: passivePhaseId });
  kernel.setDetector("consent-banner", "skipped", { reason: "probe-disabled" });
  kernel.setDetector("privacy-policy", "skipped", { reason: "probe-disabled" });
  kernel.exhaustBudget({ name: "request-upload", family: "requests", phaseId: null, count: 2 });
  now = 1_200;
  const qualityFacts = kernel.qualityFacts({ status: 200, botWallTitleMatched: false, navigationSettled: true });
  const finished = kernel.finish();

  const conditions = buildScanConditions({
    profile: "node-playwright",
    requestedUrl: "https://example.com/",
    finalUrl: "https://example.com/",
    scannedAt: new Date(0).toISOString(),
    chromiumVersion: "Chromium/126",
    userAgent: "test agent",
    viewport: { width: 1440, height: 980, isMobile: false },
    gpcEnabled: true,
    consentMode: "observe"
  });
  const request = {
    id: 1,
    url: "https://example.com/",
    domain: "example.com",
    method: "GET",
    resourceType: "document",
    status: 200,
    thirdParty: false,
    tracker: null,
    startedAtMs: 0
  };
  const result = buildScanResult({
    pageTitle: "Example",
    status: 200,
    durationMs: 200,
    firstPartyDomain: "example.com",
    conditions,
    requests: [request],
    cookies: [],
    storage: [],
    fingerprintEvents: [],
    screenshot: null,
    warnings: []
  });
  const before = JSON.stringify(result);

  const returned = attachStagedSingleVisitMeasurement(result, {
    measurement: { phases: finished.phases, detectors: finished.detectors, qualityFacts },
    evidence: {
      requests: [
        { ...request, phaseId: kernel.phaseForRequest(passiveRequest)! },
        { ...request, id: 2, startedAtMs: 100, phaseId: kernel.phaseForRequest(probeRequest)! }
      ],
      cookieMutations: [],
      cookiesFinal: [],
      storageMutations: [],
      storageFinal: [],
      fingerprintEvents: [],
      fingerprintDetections: [],
      cnameCloaks: [],
      pixelEvents: []
    },
    verificationFacts: {
      gpc: {
        method: "gpc-header-readback@1",
        header: "confirmed-present",
        jsSignal: "confirmed-true",
        observedOn: "first-party-navigation",
        phaseId: passivePhaseId
      },
      shields: {
        method: "shields-engine-status@1",
        engineLoaded: false,
        applied: false,
        requestsEvaluated: 0,
        requestsMatched: 0,
        requestsActuallyBlocked: 0,
        phaseId: passivePhaseId
      }
    },
    emissionInputs: {
      startedAt: new Date(0).toISOString(),
      requestedUrl: "https://example.com/",
      observedUrl: "https://example.com/",
      conditions: {
        gpc: true,
        shields: "classification",
        consent: "observe",
        device: { kind: "desktop", viewport: { width: 1440, height: 980, isMobile: false } },
        probes: { keystroke: true, policyVisit: true },
        locale: "en-US",
        language: "en-US",
        timezone: "UTC",
        egress: { label: "test" },
        browser: { name: "chromium", version: "126.0.0.0" },
        headless: true,
        automation: "playwright-chromium"
      },
      adblockEngineLoaded: false,
      pageTitle: "Example",
      durationMs: 200,
      warnings: [],
      screenshot: null
    }
  });

  assert.equal(returned, result);
  assert.equal(JSON.stringify(result), before);
  assert.equal(result.schemaVersion, 1);
  assert.equal(Object.prototype.hasOwnProperty.call(result, "measurement"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(result, "phases"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(result, "verificationFacts"), false);

  const staged = stagedSingleVisitMeasurement(result);
  assert.deepEqual(staged?.measurement.phases, [
    { phaseId: 0, kind: "passive-load", startedAtMs: 0, endedAtMs: 100 },
    { phaseId: 1, kind: "active-probe", startedAtMs: 100, endedAtMs: 200 }
  ]);
  assert.deepEqual(staged?.evidence.requests.map((item) => item.phaseId), [0, 1]);
  assert.deepEqual(staged?.measurement.qualityFacts.captureLoss, [
    { family: "requests", phaseId: null, kind: "cap", count: 2, detail: "request-upload" }
  ]);
  assert.equal(staged?.measurement.detectors["consent-banner"].status, "skipped");
  assert.deepEqual(staged?.verificationFacts.gpc, {
    method: "gpc-header-readback@1",
    header: "confirmed-present",
    jsSignal: "confirmed-true",
    observedOn: "first-party-navigation",
    phaseId: 0
  });

  staged!.measurement.phases[0].endedAtMs = 999;
  staged!.verificationFacts.gpc.jsSignal = "read-failed";
  assert.equal(stagedSingleVisitMeasurement(result)?.measurement.phases[0].endedAtMs, 100);
  assert.equal(stagedSingleVisitMeasurement(result)?.verificationFacts.gpc.jsSignal, "confirmed-true");
});

test("ScanNetworkRecorder keeps raw evidence ephemeral until the post-classification build seam", () => {
  const matchedDomains: string[] = [];
  const recorder = new ScanNetworkRecorder({
    firstPartyHostname: "example.com",
    warnings: new ScanWarningCollector(),
    trackerMatcher: (domain) => {
      matchedDomains.push(domain);
      return {
        domain,
        entity: "Example Tracker",
        category: "analytics",
        confidence: "curated"
      };
    }
  });
  const request = {
    url: () => "https://a8f3c9d2e1b4f6a7.tracker.example.net/patients/anna?token=secret",
    method: () => "GET",
    resourceType: () => "script"
  };

  recorder.recordRequest(request, 1);
  const records = recorder.publicRecords("example.com");

  assert.equal(records[0].url.includes("anna?token=secret"), true);
  assert.equal(records[0].tracker?.entity, "Example Tracker");
  assert.deepEqual(matchedDomains, [
    "a8f3c9d2e1b4f6a7.tracker.example.net",
    "a8f3c9d2e1b4f6a7.tracker.example.net"
  ]);
});

test("ScanWarningCollector limits noisy non-HTTP request examples", () => {
  const warnings = new ScanWarningCollector();
  const attempts = NON_HTTP_WARNING_EXAMPLE_LIMIT + 3;

  for (let index = 0; index < attempts; index += 1) {
    warnings.addNonHttpRequest(`blob:https://example.com/${index}?token=secret`);
  }

  // Non-HTTP input has no public URL shape under redaction-v2. Every example
  // collapses to one fixed marker instead of retaining blob paths.
  assert.deepEqual(warnings.list, ["Blocked a non-HTTP(S) request: {invalid-url}"]);
  assert.equal(warnings.list.some((warning) => warning.includes("secret")), false);
});

test("ScanWarningCollector drops exact-duplicate warnings", () => {
  const warnings = new ScanWarningCollector(["initial warning"]);

  warnings.add("initial warning");
  warnings.add("second warning");
  warnings.add("second warning");

  assert.deepEqual(warnings.list, ["initial warning", "second warning"]);
});

test("ScanWarningCollector dedupes and caps unverified-request examples", () => {
  const warnings = new ScanWarningCollector();

  // Retries of the same URL (different query strings) collapse after redaction.
  warnings.addUnverifiedRequest("https://blocked.example.com/pixel?attempt=1");
  warnings.addUnverifiedRequest("https://blocked.example.com/pixel?attempt=2");
  assert.deepEqual(warnings.list, ["Blocked a request that could not be verified as public: https://{label}.example.com/{seg}"]);

  for (let index = 0; index < NON_HTTP_WARNING_EXAMPLE_LIMIT + 3; index += 1) {
    warnings.addUnverifiedRequest(`https://blocked-${index}.com/asset?token=secret`);
  }

  assert.equal(warnings.list.length, NON_HTTP_WARNING_EXAMPLE_LIMIT + 1);
  assert.equal(
    warnings.list.at(-1),
    `Blocked additional requests that could not be verified as public. Only the first ${NON_HTTP_WARNING_EXAMPLE_LIMIT} examples are shown.`
  );
  assert.equal(warnings.list.some((warning) => warning.includes("secret")), false);
});

test("decideRoutedRequest aborts non-HTTP requests before public host verification", async () => {
  const warnings = new ScanWarningCollector();
  const requestBudget = new ScanRequestBudget(warnings);
  let verifierCalls = 0;

  const decision = await decideRoutedRequest({
    request: routeRequest({ url: "blob:https://example.com/asset?token=secret" }),
    page: routePage,
    targetUrl: new URL("https://example.com/"),
    warnings,
    requestBudget,
    publicHostChecks: new Map(),
    verifyPublicUrl: async () => {
      verifierCalls += 1;
    }
  });

  assert.deepEqual(decision, { action: "abort", blockedByShields: false });
  assert.equal(verifierCalls, 0);
  assert.deepEqual(warnings.list, ["Blocked a non-HTTP(S) request: {invalid-url}"]);
});

test("decideRoutedRequest aborts after the routed request cap", async () => {
  const warnings = new ScanWarningCollector();
  const requestBudget = new ScanRequestBudget(warnings, 0);
  let verifierCalls = 0;

  const decision = await decideRoutedRequest({
    request: routeRequest({ url: "https://cdn.example.com/app.js" }),
    page: routePage,
    targetUrl: new URL("https://example.com/"),
    warnings,
    requestBudget,
    publicHostChecks: new Map(),
    verifyPublicUrl: async () => {
      verifierCalls += 1;
    }
  });

  assert.deepEqual(decision, { action: "abort", blockedByShields: false });
  assert.equal(verifierCalls, 0);
  assert.deepEqual(warnings.list, ["The scan stopped recording or loading additional requests after 0 requests."]);
});

test("decideRoutedRequest aborts requests that fail public host verification", async () => {
  const warnings = new ScanWarningCollector();
  const requestBudget = new ScanRequestBudget(warnings);

  const decision = await decideRoutedRequest({
    request: routeRequest({ url: "https://metadata.example.com/latest?token=secret" }),
    page: routePage,
    targetUrl: new URL("https://example.com/"),
    warnings,
    requestBudget,
    publicHostChecks: new Map(),
    verifyPublicUrl: async () => {
      throw new Error("resolved to a private address");
    }
  });

  assert.deepEqual(decision, { action: "abort", blockedByShields: false });
  assert.deepEqual(warnings.list, ["Blocked a request that could not be verified as public: https://{label}.example.com/{seg}"]);
});

test("decideRoutedRequest retries a public host check after a transient failure", async () => {
  const warnings = new ScanWarningCollector();
  const requestBudget = new ScanRequestBudget(warnings);
  const publicHostChecks = new Map<string, Promise<void>>();
  let verifierCalls = 0;

  const options = {
    page: routePage,
    targetUrl: new URL("https://example.com/"),
    warnings,
    requestBudget,
    publicHostChecks,
    verifyPublicUrl: async () => {
      verifierCalls += 1;
      if (verifierCalls === 1) throw new Error("transient DNS failure");
    }
  };

  assert.deepEqual(
    await decideRoutedRequest({
      ...options,
      request: routeRequest({ url: "https://cdn.example.com/app.js" })
    }),
    { action: "abort", blockedByShields: false }
  );
  assert.equal(publicHostChecks.size, 0);

  assert.deepEqual(
    await decideRoutedRequest({
      ...options,
      request: routeRequest({ url: "https://cdn.example.com/style.css", resourceType: "stylesheet" })
    }),
    { action: "continue", blockedByShields: false }
  );
  assert.equal(verifierCalls, 2);
  assert.equal(publicHostChecks.size, 1);
});

test("decideRoutedRequest deduplicates in-flight checks and retains successful checks", async () => {
  const warnings = new ScanWarningCollector();
  const requestBudget = new ScanRequestBudget(warnings);
  const publicHostChecks = new Map<string, Promise<void>>();
  let verifierCalls = 0;
  let releaseVerifier: () => void = () => {
    assert.fail("host verification did not start");
  };
  const verifierBlocked = new Promise<void>((resolve) => {
    releaseVerifier = resolve;
  });

  const options = {
    page: routePage,
    targetUrl: new URL("https://example.com/"),
    warnings,
    requestBudget,
    publicHostChecks,
    verifyPublicUrl: async () => {
      verifierCalls += 1;
      await verifierBlocked;
    }
  };

  const scriptDecision = decideRoutedRequest({
    ...options,
    request: routeRequest({ url: "https://cdn.example.com/app.js" })
  });
  const styleDecision = decideRoutedRequest({
    ...options,
    request: routeRequest({ url: "https://cdn.example.com/style.css", resourceType: "stylesheet" })
  });

  assert.equal(verifierCalls, 1);
  assert.equal(publicHostChecks.size, 1);
  releaseVerifier();

  assert.deepEqual(
    await Promise.all([scriptDecision, styleDecision]),
    [
      { action: "continue", blockedByShields: false },
      { action: "continue", blockedByShields: false }
    ]
  );
  assert.deepEqual(
    await decideRoutedRequest({
      ...options,
      request: routeRequest({ url: "https://cdn.example.com/image.png", resourceType: "image" })
    }),
    { action: "continue", blockedByShields: false }
  );

  assert.equal(verifierCalls, 1);
  assert.equal(publicHostChecks.size, 1);
});

test("decideRoutedRequest bounds repeated verification work for a permanently failing host", async () => {
  const warnings = new ScanWarningCollector();
  const requestBudget = new ScanRequestBudget(warnings);
  const publicHostChecks = new Map<string, Promise<void>>();
  let verifierCalls = 0;
  const options = {
    page: routePage,
    targetUrl: new URL("https://example.com/"),
    warnings,
    requestBudget,
    publicHostChecks,
    verifyPublicUrl: async () => {
      verifierCalls += 1;
      throw new Error("permanent DNS failure");
    }
  };

  for (let request = 0; request < 10; request += 1) {
    assert.deepEqual(
      await decideRoutedRequest({
        ...options,
        request: routeRequest({ url: `https://dead.example.com/asset-${request}.js` })
      }),
      { action: "abort", blockedByShields: false }
    );
  }

  assert.equal(verifierCalls, 2);
  assert.equal(publicHostChecks.size, 1);
});

test("decideRoutedRequest aborts Shields-blocked subresources but not top-level navigations", async () => {
  const warnings = new ScanWarningCollector();
  const requestBudget = new ScanRequestBudget(warnings);
  const publicHostChecks = new Map<string, Promise<void>>();
  let engineCalls = 0;
  const adblockEngine = {
    check: () => {
      throw new Error("live routed requests must use method-aware matching");
    },
    checkWithMethod: (url: string, sourceUrl: string, requestType: string, method: string) => {
      engineCalls += 1;
      assert.equal(url.startsWith("https://ads.example/"), true);
      assert.equal(sourceUrl, "https://example.com/");
      assert.equal(requestType, "script");
      assert.equal(method, "POST");
      return true;
    }
  };

  assert.deepEqual(
    await decideRoutedRequest({
      request: routeRequest({ url: "https://ads.example/pixel.js", method: "post" }),
      page: routePage,
      targetUrl: new URL("https://example.com/"),
      warnings,
      requestBudget,
      publicHostChecks,
      shieldsBlockingEnabled: true,
      adblockEngine,
      verifyPublicUrl: async () => undefined
    }),
    { action: "abort", blockedByShields: true, shieldsMatched: true }
  );

  assert.deepEqual(
    await decideRoutedRequest({
      request: routeRequest({
        url: "https://ads.example/landing",
        navigation: true,
        frame: mainFrame
      }),
      page: routePage,
      targetUrl: new URL("https://example.com/"),
      warnings,
      requestBudget,
      publicHostChecks,
      shieldsBlockingEnabled: true,
      adblockEngine,
      verifyPublicUrl: async () => undefined
    }),
    { action: "continue", blockedByShields: false, shieldsMatched: false }
  );
  assert.equal(engineCalls, 1, "the deliberately exempt main-frame navigation must not be classified");
});

test("decideRoutedRequest captures the redirected document source before awaiting host verification", async () => {
  let frameUrl = "https://final.example/page";
  const redirectedFrame: TestFrame = {
    parentFrame: () => null,
    url: () => frameUrl
  };
  const sources: string[] = [];

  const decision = await decideRoutedRequest({
    request: routeRequest({ url: "https://ads.example/pixel.js", frame: redirectedFrame }),
    page: { mainFrame: () => redirectedFrame },
    targetUrl: new URL("https://submitted.example/"),
    warnings: new ScanWarningCollector(),
    requestBudget: new ScanRequestBudget(new ScanWarningCollector()),
    publicHostChecks: new Map(),
    adblockEngine: {
      checkWithMethod: (_url, sourceUrl) => {
        sources.push(sourceUrl);
        return true;
      }
    },
    verifyPublicUrl: async () => {
      frameUrl = "https://later-navigation.example/";
    }
  });

  assert.deepEqual(decision, { action: "continue", blockedByShields: false, shieldsMatched: true });
  assert.deepEqual(sources, ["https://final.example/page"]);
});

test("decideRoutedRequest uses child documents and parent documents for their respective request types", async () => {
  const parent = testFrame("https://top.example/page");
  const child = testFrame("https://frame.example/embed", parent);
  const inheritedBlankChild = testFrame("about:blank", parent);
  const navigatingChild = testFrame("", parent);
  const page = { mainFrame: () => parent };
  const calls: Array<{ sourceUrl: string; requestType: string }> = [];
  const options = {
    page,
    targetUrl: new URL("https://submitted.example/"),
    warnings: new ScanWarningCollector(),
    requestBudget: new ScanRequestBudget(new ScanWarningCollector()),
    publicHostChecks: new Map<string, Promise<void>>(),
    adblockEngine: {
      checkWithMethod: (_url: string, sourceUrl: string, requestType: string) => {
        calls.push({ sourceUrl, requestType });
        return false;
      }
    },
    verifyPublicUrl: async () => undefined
  };

  assert.deepEqual(
    await decideRoutedRequest({
      ...options,
      request: routeRequest({ url: "https://cdn.example/frame.js", frame: child })
    }),
    { action: "continue", blockedByShields: false, shieldsMatched: false }
  );
  assert.deepEqual(
    await decideRoutedRequest({
      ...options,
      request: routeRequest({ url: "https://cdn.example/inherited.png", resourceType: "image", frame: inheritedBlankChild })
    }),
    { action: "continue", blockedByShields: false, shieldsMatched: false }
  );
  assert.deepEqual(
    await decideRoutedRequest({
      ...options,
      request: routeRequest({
        url: "https://frame-destination.example/",
        resourceType: "document",
        navigation: true,
        frame: navigatingChild
      })
    }),
    { action: "continue", blockedByShields: false, shieldsMatched: false }
  );

  assert.deepEqual(calls, [
    { sourceUrl: "https://frame.example/embed", requestType: "script" },
    { sourceUrl: "https://top.example/page", requestType: "image" },
    { sourceUrl: "https://top.example/page", requestType: "document" }
  ]);
});

test("decideRoutedRequest handles Service Worker and frame-less navigation requests without throwing", async () => {
  const warnings = new ScanWarningCollector();
  const requestBudget = new ScanRequestBudget(warnings);
  const publicHostChecks = new Map<string, Promise<void>>();
  const sources: string[] = [];
  const adblockEngine = {
    checkWithMethod: (_url: string, sourceUrl: string) => {
      sources.push(sourceUrl);
      return true;
    }
  };
  const options = {
    page: routePage,
    targetUrl: new URL("https://submitted.example/"),
    warnings,
    requestBudget,
    publicHostChecks,
    adblockEngine,
    verifyPublicUrl: async () => undefined
  };

  assert.deepEqual(
    await decideRoutedRequest({
      ...options,
      request: routeRequest({
        url: "https://api.example/worker-fetch",
        resourceType: "fetch",
        frameThrows: true,
        serviceWorkerUrl: "https://example.com/sw.js"
      })
    }),
    { action: "continue", blockedByShields: false, shieldsMatched: true }
  );
  assert.deepEqual(
    await decideRoutedRequest({
      ...options,
      request: routeRequest({
        url: "https://api.example/worker-fetch-with-missing-source",
        resourceType: "fetch",
        frameThrows: true,
        serviceWorkerUrl: "https://example.com/sw.js",
        serviceWorkerUrlThrows: true
      })
    }),
    { action: "continue", blockedByShields: false, shieldsMatched: true }
  );
  assert.deepEqual(
    await decideRoutedRequest({
      ...options,
      request: routeRequest({
        url: "https://navigation.example/",
        resourceType: "document",
        navigation: true,
        frameThrows: true
      })
    }),
    { action: "continue", blockedByShields: false, shieldsMatched: false }
  );

  assert.deepEqual(
    sources,
    ["https://example.com/sw.js", "https://example.com/"],
    "a missing worker URL falls back to the main document; frame-less navigation makes no engine call"
  );
});

test("scanSite stages live phase-aware readbacks while returning only v1", { timeout: 30_000 }, async () => {
  const receivedFinalGpcHeaders: Array<string | undefined> = [];
  const upstream = createServer((request, response) => {
    const host = request.headers.host?.split(":")[0];
    if (host === "ads.example" || host?.startsWith("sub.")) {
      response.writeHead(200, { "content-type": "application/javascript" });
      response.end("void 0;");
      return;
    }
    if (host === "phase-collection.test") {
      const tamper = request.url?.includes("tamper=1") === true;
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        `<!doctype html><title>Redirecting fixture</title><script>setTimeout(()=>location.replace("http://final-phase.test/${
          tamper ? "?tamper=1" : ""
        }"),0)</script>`
      );
      return;
    }
    if (request.url === "/" || request.url === "/?tamper=1") {
      receivedFinalGpcHeaders.push(request.headers["sec-gpc"] as string | undefined);
    }
    const tamper = request.url?.includes("tamper=1") === true;
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      `<!doctype html><title>Phase fixture</title>${
        tamper
          ? '<script>Object.defineProperty(navigator,"globalPrivacyControl",{configurable:true,get:()=>false});</script>'
          : ""
      }<script src="http://sub.final-phase.test/app.js"></script><script src="http://ads.example/pixel.js"></script><p>ok</p>`
    );
  });
  await new Promise<void>((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen(0, "127.0.0.1", resolve);
  });
  const address = upstream.address();
  assert.ok(address && typeof address === "object");

  try {
    const runFixture = (url: string) =>
      scanSite(
        { url, device: "desktop", gpcEnabled: true, consentMode: "observe" },
        {
        publicUrlAlreadyVerified: true,
        verifyPublicUrl: async () => undefined,
        resolvePublicHost: async () => [{ address: "93.184.216.34", family: 4 }],
        connectProxyUpstreamForTests: () => connect(address.port, "127.0.0.1"),
        resolveCnameChain: async () => {
          throw new Error("synthetic CNAME resolver failure");
        }
        }
      );
    const result = await runFixture("http://phase-collection.test/");

    assert.equal(result.schemaVersion, 1);
    assert.equal(Object.prototype.hasOwnProperty.call(result, "measurement"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(result, "phases"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(result, "verificationFacts"), false);
    assert.deepEqual(receivedFinalGpcHeaders, ["1"]);
    const staged = stagedSingleVisitMeasurement(result);
    assert.notEqual(staged, null);
    assert.deepEqual(staged!.measurement.phases.map((phase) => phase.kind), ["passive-load", "active-probe"]);
    assert.equal(Object.keys(staged!.measurement.detectors).length, 6);
    assert.equal(staged!.measurement.detectors["fingerprint-heuristics"].status, "complete");
    assert.deepEqual(staged!.measurement.detectors["keystroke-exfiltration"], {
      version: "synthetic-sentinel@1",
      status: "complete",
      phaseId: 1
    });
    assert.deepEqual(staged!.measurement.detectors["cname-uncloaking"], {
      version: "dns-cname-chain@1",
      status: "failed",
      reason: "scan-failed",
      phaseId: 0
    });
    assert.ok(staged!.evidence.requests.length > 0);
    assert.equal(staged!.evidence.requests.every((request) => Number.isInteger(request.phaseId)), true);
    assert.equal(staged!.evidence.requests[0].phaseId, 0);
    assert.deepEqual(staged!.verificationFacts.gpc, {
      method: "gpc-header-readback@1",
      header: "confirmed-present",
      jsSignal: "confirmed-true",
      observedOn: "first-party-navigation",
      phaseId: 0
    });
    assert.equal(staged!.verificationFacts.shields.engineLoaded, true);
    assert.equal(staged!.verificationFacts.shields.applied, false);
    assert.ok(staged!.verificationFacts.shields.requestsEvaluated > 0);
    assert.ok(staged!.verificationFacts.shields.requestsMatched > 0);
    assert.equal(staged!.verificationFacts.shields.requestsActuallyBlocked, 0);
    assert.equal(
      staged!.verificationFacts.shields.requestsMatched,
      staged!.evidence.requests.filter(
        (request) =>
          request.phaseId === staged!.verificationFacts.shields.phaseId && request.blockedByShields === true
      ).length
    );

    const tampered = stagedSingleVisitMeasurement(await runFixture("http://phase-collection.test/?tamper=1"));
    assert.notEqual(tampered, null);
    assert.deepEqual(tampered!.verificationFacts.gpc, {
      method: "gpc-header-readback@1",
      header: "confirmed-present",
      jsSignal: "confirmed-false",
      observedOn: "first-party-navigation",
      phaseId: 0
    });
    assert.deepEqual(receivedFinalGpcHeaders, ["1", "1"]);

    const cappedResult = await scanSite(
      { url: "http://final-phase.test/", device: "desktop", gpcEnabled: false, consentMode: "observe" },
      {
        publicUrlAlreadyVerified: true,
        verifyPublicUrl: async () => undefined,
        resolvePublicHost: async () => [{ address: "93.184.216.34", family: 4 }],
        connectProxyUpstreamForTests: () => connect(address.port, "127.0.0.1"),
        resolveCnameChain: async () => [],
        proxyTransactionLimitForTests: 1
      }
    );
    const capped = stagedSingleVisitMeasurement(cappedResult);
    assert.notEqual(capped, null);
    assert.equal(
      cappedResult.warnings.includes(
        "The scan stopped opening additional proxy requests after reaching its connection and target safety budget."
      ),
      true
    );
    assert.equal(
      capped!.measurement.qualityFacts.captureLoss.some(
        (loss) => loss.family === "requests" && loss.kind === "cap" && loss.detail === "proxy-traffic"
      ),
      true
    );
  } finally {
    await closeSharedBrowserForTests();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

test("a closed Usercentrics root remains clickable after a failed passive storage collection", { timeout: 20_000 }, async () => {
  let receivedGpcHeader: string | string[] | undefined;
  const upstream = createServer((request, response) => {
    if (request.headers.host?.startsWith("ads.")) {
      response.writeHead(200, { "content-type": "application/javascript" });
      response.end("void 0;");
      return;
    }
    receivedGpcHeader = request.headers["sec-gpc"];
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html>
      <title>Consent boundary fixture</title>
      <body>
      <div id="usercentrics-root"></div>
      <script>
        const realLocalStorage = window.localStorage;
        let localStorageReads = 0;
        Object.defineProperty(window, "localStorage", {
          configurable: true,
          get() {
            localStorageReads += 1;
            if (localStorageReads === 1) throw new Error("synthetic passive snapshot failure");
            return realLocalStorage;
          }
        });
        const consentRoot = document.getElementById("usercentrics-root").attachShadow({ mode: "closed" });
        const accept = document.createElement("button");
        accept.dataset.testid = "uc-accept-all-button";
        accept.textContent = "Accept all";
        accept.addEventListener("click", () => localStorage.setItem("consent-state", "accepted"));
        consentRoot.append(accept);
      </script>
      <script src="http://ads.example/pixel.js"></script>
      </body>`);
  });
  await new Promise<void>((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen(0, "127.0.0.1", resolve);
  });
  const address = upstream.address();
  assert.ok(address && typeof address === "object");

  try {
    const result = await scanSite(
      {
        url: "http://consent-boundary.test/",
        device: "desktop",
        gpcEnabled: false,
        consentMode: "accept-all"
      },
      {
        publicUrlAlreadyVerified: true,
        verifyPublicUrl: async () => undefined,
        resolvePublicHost: async () => [{ address: "93.184.216.34", family: 4 }],
        connectProxyUpstreamForTests: () => connect(address.port, "127.0.0.1"),
        resolveCnameChain: async () => [],
        shieldsBlockingEnabled: true
      }
    );

    assert.equal(result.schemaVersion, 1);
    assert.deepEqual(result.consentInteraction, {
      mode: "accept-all",
      clicked: true,
      cmp: "Usercentrics",
      selector: "[data-testid=uc-accept-all-button]"
    });
    assert.equal(receivedGpcHeader, undefined);
    const staged = stagedSingleVisitMeasurement(result);
    assert.notEqual(staged, null);
    assert.equal(staged!.evidence.storageFinal.some((entry) => entry.key === "consent-state"), true);
    assert.deepEqual(staged!.evidence.storageMutations, []);
    assert.deepEqual(
      staged!.measurement.qualityFacts.captureLoss.filter((loss) => loss.family === "storage"),
      [{ family: "storage", phaseId: 0, kind: "dropped", count: 1, detail: "storage-snapshot" }]
    );
    // Flag off (the default): consent facts are still recorded for the staged
    // r2 artifact, with zero verification observations and no banner block.
    assert.deepEqual(staged!.consent, {
      interactionAttempted: true,
      controlActivated: true,
      verificationObservations: [],
      cmp: "Usercentrics",
      selector: "[data-testid=uc-accept-all-button]"
    });
    assert.equal(staged!.measurement.phases.some((phase) => phase.kind === "post-choice-reload"), false);
    assert.equal(staged!.measurement.detectors["consent-banner"].status, "complete");
    assert.equal(staged!.verificationFacts.gpc.header, "confirmed-absent");
    assert.ok(
      staged!.verificationFacts.gpc.jsSignal === "confirmed-absent" ||
        staged!.verificationFacts.gpc.jsSignal === "confirmed-false"
    );
    const shields = staged!.verificationFacts.shields;
    assert.equal(shields.engineLoaded, true);
    assert.equal(shields.applied, true);
    assert.ok(shields.requestsEvaluated > 0);
    assert.ok(shields.requestsMatched > 0);
    assert.ok(shields.requestsActuallyBlocked > 0);
    assert.ok(shields.requestsActuallyBlocked <= shields.requestsMatched);
    assert.ok(shields.requestsMatched <= shields.requestsEvaluated);
    assert.equal(staged!.evidence.requests.some((request) => request.blockedByShields === true), false);
  } finally {
    await closeSharedBrowserForTests();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

test("observe-mode verification can see a closed Usercentrics root without clicking it", { timeout: 20_000 }, async () => {
  let closedRootProbeRequests = 0;
  let clickRequests = 0;
  const upstream = createServer((request, response) => {
    if (request.url === "/closed-root-probed") {
      closedRootProbeRequests += 1;
      response.writeHead(204);
      response.end();
      return;
    }
    if (request.url === "/must-not-click") {
      clickRequests += 1;
      response.writeHead(204);
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html>
      <title>Closed consent observation fixture</title>
      <div id="usercentrics-root"></div>
      <script>
        const root = document.getElementById("usercentrics-root").attachShadow({ mode: "closed" });
        const accept = document.createElement("button");
        accept.dataset.testid = "uc-accept-all-button";
        accept.textContent = "Accept all";
        accept.getBoundingClientRect = () => {
          fetch("/closed-root-probed").catch(() => {});
          return { x: 0, y: 0, top: 0, left: 0, right: 120, bottom: 24, width: 120, height: 24, toJSON() {} };
        };
        accept.addEventListener("click", () => fetch("/must-not-click").catch(() => {}));
        root.append(accept);
      </script>`);
  });
  await new Promise<void>((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen(0, "127.0.0.1", resolve);
  });
  const address = upstream.address();
  assert.ok(address && typeof address === "object");

  process.env.SITE_BEHAVIOR_LAB_CONSENT_VERIFICATION = "1";
  try {
    const result = await scanSite(
      {
        url: "http://closed-consent-observe.test/",
        device: "desktop",
        gpcEnabled: false,
        consentMode: "observe"
      },
      {
        publicUrlAlreadyVerified: true,
        verifyPublicUrl: async () => undefined,
        resolvePublicHost: async () => [{ address: "93.184.216.34", family: 4 }],
        connectProxyUpstreamForTests: () => connect(address.port, "127.0.0.1"),
        resolveCnameChain: async () => []
      }
    );

    assert.equal(result.consentInteraction, undefined);
    assert.ok(closedRootProbeRequests > 0);
    assert.equal(clickRequests, 0);
    const staged = stagedSingleVisitMeasurement(result);
    assert.equal(staged?.measurement.detectors["consent-banner"].status, "complete");
  } finally {
    delete process.env.SITE_BEHAVIOR_LAB_CONSENT_VERIFICATION;
    await closeSharedBrowserForTests();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

test("scanSite verifies a consent click end to end when the verification flag is on", { timeout: 30_000 }, async () => {
  const assetHits: string[] = [];
  const upstream = createServer((request, response) => {
    if (request.url === "/asset.js") {
      assetHits.push(request.headers.host ?? "");
      response.writeHead(200, { "content-type": "application/javascript" });
      response.end("void 0;");
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html>
      <title>Consent verification fixture</title>
      <script>
        const rejected = localStorage.getItem("cmp-choice") === "rejected";
        const tcData = {
          gdprApplies: true,
          eventStatus: rejected ? "tcloaded" : "cmpuishown",
          purpose: {
            consents: rejected ? { "1": false, "2": false } : {},
            legitimateInterests: rejected ? { "1": false, "2": false } : {}
          }
        };
        window.__tcfapi = (command, version, callback) => callback(tcData, true);
        window.registerRejection = () => {
          localStorage.setItem("cmp-choice", "rejected");
          tcData.eventStatus = "useractioncomplete";
          tcData.purpose = {
            consents: { "1": false, "2": false },
            legitimateInterests: { "1": false, "2": false }
          };
          document.getElementById("consent-banner").style.display = "none";
        };
      </script>
      <script src="/asset.js"></script>
      <div id="consent-banner" style="display:none">
        <button onclick="registerRejection()">Reject all</button>
      </div>
      <script>
        if (!rejected) document.getElementById("consent-banner").style.display = "block";
      </script>
      <p>fixture</p>`);
  });
  await new Promise<void>((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen(0, "127.0.0.1", resolve);
  });
  const address = upstream.address();
  assert.ok(address && typeof address === "object");

  process.env.SITE_BEHAVIOR_LAB_CONSENT_VERIFICATION = "1";
  try {
    const result = await scanSite(
      {
        url: "http://consent-verify.test/",
        device: "desktop",
        gpcEnabled: false,
        consentMode: "reject-all"
      },
      {
        publicUrlAlreadyVerified: true,
        verifyPublicUrl: async () => undefined,
        resolvePublicHost: async () => [{ address: "93.184.216.34", family: 4 }],
        connectProxyUpstreamForTests: () => connect(address.port, "127.0.0.1"),
        resolveCnameChain: async () => []
      }
    );

    // The reload really happened upstream, and its traffic stayed out of v1.
    assert.equal(result.schemaVersion, 1);
    assert.equal(assetHits.length, 2);
    assert.equal(
      result.warnings.some((warning) => warning.includes("attempted one page reload to read the site's registered consent state")),
      true
    );
    assert.equal(result.consentInteraction?.clicked, true);

    const staged = stagedSingleVisitMeasurement(result);
    assert.notEqual(staged, null);
    // Exactly one recorded asset load (the reload's copy is excluded), and the
    // v1 wire counts agree with the staged phase-aware evidence.
    assert.equal(staged!.evidence.requests.filter((request) => request.url.endsWith("/asset.js")).length, 1);
    assert.equal(result.summary.totalRequests, staged!.evidence.requests.length);
    assert.deepEqual(
      staged!.measurement.phases.map((phase) => phase.kind),
      ["passive-load", "consent-interaction", "post-choice-reload", "active-probe"]
    );
    const consentPhaseId = staged!.measurement.phases.find((phase) => phase.kind === "consent-interaction")!.phaseId;
    const reloadPhaseId = staged!.measurement.phases.find((phase) => phase.kind === "post-choice-reload")!.phaseId;
    assert.equal(staged!.evidence.requests.some((request) => request.phaseId === reloadPhaseId), false);

    const consent = staged!.consent;
    assert.notEqual(consent, undefined);
    assert.equal(consent!.interactionAttempted, true);
    assert.equal(consent!.controlActivated, true);
    assert.equal(consent!.matchedText, "reject all");

    // Banner-visibility moments: visible before the click, gone after it and
    // after the reload, chronology strictly increasing.
    const moments = consent!.bannerTransition?.observations ?? [];
    assert.deepEqual(
      moments.map((entry) => [entry.moment, entry.phaseId, entry.visible]),
      [
        ["before-interaction", consentPhaseId, true],
        ["after-interaction", consentPhaseId, false],
        ["after-reload", reloadPhaseId, false]
      ]
    );
    assert.ok(moments[0].atMs < moments[1].atMs && moments[1].atMs < moments[2].atMs);

    // TCF alone proves the registered reject state in BOTH consent phases
    // when consent and legitimate-interest vectors are complete and false.
    // The normal OneTrust fallback remains recorded as unreadable; it neither
    // supplies nor weakens the TCF verification.
    assert.deepEqual(
      consent!.verificationObservations.map((observation) => [
        observation.phaseId,
        observation.method,
        observation.observed,
        observation.result.outcome
      ]),
      [
        [consentPhaseId, TCF_API_METHOD, "rejected-all", "read"],
        [consentPhaseId, "onetrust-cookie@1", null, "unreadable"],
        [reloadPhaseId, TCF_API_METHOD, "rejected-all", "read"],
        [reloadPhaseId, "onetrust-cookie@1", null, "unreadable"]
      ]
    );
    const sequences = consent!.verificationObservations.map((observation) => observation.result.sequence);
    assert.deepEqual([...sequences].sort((a, b) => a - b), sequences);
    assert.equal(new Set(sequences).size, sequences.length);

    // The clicked choice shows up as a consent-phase storage mutation.
    assert.equal(
      staged!.evidence.storageMutations.some(
        (mutation) => mutation.op === "added" && mutation.entry.key === "cmp-choice" && mutation.phaseId === consentPhaseId
      ),
      true
    );
  } finally {
    delete process.env.SITE_BEHAVIOR_LAB_CONSENT_VERIFICATION;
    await closeSharedBrowserForTests();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

test("a consent click cannot promote a sibling origin into evidence or active-input scope", { timeout: 30_000 }, async () => {
  let siblingReceivedSyntheticInput = false;
  const upstream = createServer((request, response) => {
    if (request.headers.host?.startsWith("account.consent-origin.com")) {
      if (request.url === "/typed") {
        siblingReceivedSyntheticInput = true;
        response.writeHead(204);
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html>
        <title>Sibling origin</title>
        <script>
          localStorage.setItem("sibling-origin-state", "must-not-be-retained");
          document.cookie = "sibling-origin-cookie=must-not-be-retained; path=/";
          addEventListener("input", () => fetch("/typed", { method: "POST" }));
        </script>
        <input type="text">`);
      return;
    }

    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html>
      <title>Trusted consent origin</title>
      <div id="consent-banner"><button onclick="location.href='http://account.consent-origin.com/'">Accept all</button></div>`);
  });
  await new Promise<void>((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen(0, "127.0.0.1", resolve);
  });
  const address = upstream.address();
  assert.ok(address && typeof address === "object");

  process.env.SITE_BEHAVIOR_LAB_CONSENT_VERIFICATION = "1";
  try {
    const result = await scanSite(
      {
        url: "http://www.consent-origin.com/",
        device: "desktop",
        gpcEnabled: false,
        consentMode: "accept-all"
      },
      {
        publicUrlAlreadyVerified: true,
        verifyPublicUrl: async () => undefined,
        resolvePublicHost: async () => [{ address: "93.184.216.34", family: 4 }],
        connectProxyUpstreamForTests: () => connect(address.port, "127.0.0.1"),
        resolveCnameChain: async () => []
      }
    );

    assert.equal(result.summary.firstPartyDomain, "www.consent-origin.com");
    assert.equal(new URL(result.conditions.finalUrl).origin, "http://www.consent-origin.com");
    assert.equal(result.summary.pageTitle, "Trusted consent origin");
    assert.equal(result.screenshot, null);
    assert.equal(result.requests.some((request) => request.domain === "account.consent-origin.com"), false);
    assert.equal(result.cookies.some((cookie) => cookie.name === "sibling-origin-cookie"), false);
    assert.equal(result.storage.some((entry) => entry.key === "sibling-origin-state"), false);
    assert.equal(siblingReceivedSyntheticInput, false);
    assert.equal(
      result.warnings.includes(
        "The consent interaction left the recorded site; later page state was not used and the active input probe was skipped."
      ),
      true
    );

    const staged = stagedSingleVisitMeasurement(result);
    assert.notEqual(staged, null);
    assert.deepEqual(
      staged!.measurement.phases.map((phase) => phase.kind),
      ["passive-load", "consent-interaction"]
    );
    assert.deepEqual(staged!.measurement.detectors["consent-banner"], {
      version: "consent-control-and-state@1",
      status: "partial",
      reason: "load-failed",
      phaseId: 1
    });
    assert.deepEqual(staged!.measurement.detectors["keystroke-exfiltration"], {
      version: "synthetic-sentinel@1",
      status: "skipped",
      reason: "load-failed"
    });
    for (const family of ["requests", "cookies", "storage", "fingerprinting", "consent-verification"] as const) {
      assert.equal(
        staged!.measurement.qualityFacts.captureLoss.some(
          (loss) => loss.family === family && loss.phaseId === 1 && loss.kind === "dropped"
        ),
        true,
        `missing ${family} subject-loss accounting`
      );
    }
  } finally {
    delete process.env.SITE_BEHAVIOR_LAB_CONSENT_VERIFICATION;
    await closeSharedBrowserForTests();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

test("post-consent cross-site reload evidence is rejected and the active input probe is skipped", { timeout: 30_000 }, async () => {
  const upstream = createServer((request, response) => {
    if (request.headers.host?.startsWith("other-subject.test")) {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><title>Other subject</title><input type='text'>");
      return;
    }

    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html>
      <title>Consent redirect fixture</title>
      <script>
        const rejected = localStorage.getItem("cmp-choice") === "rejected";
        const tcData = {
          gdprApplies: true,
          eventStatus: rejected ? "tcloaded" : "cmpuishown",
          purpose: { consents: rejected ? { "1": false } : {} }
        };
        window.__tcfapi = (command, version, callback) => callback(tcData, true);
        window.reject = () => {
          localStorage.setItem("cmp-choice", "rejected");
          tcData.eventStatus = "useractioncomplete";
          tcData.purpose = { consents: { "1": false } };
          document.getElementById("consent-banner").style.display = "none";
        };
        if (rejected) location.replace("http://other-subject.test/");
      </script>
      <div id="consent-banner"><button onclick="reject()">Reject all</button></div>`);
  });
  await new Promise<void>((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen(0, "127.0.0.1", resolve);
  });
  const address = upstream.address();
  assert.ok(address && typeof address === "object");

  process.env.SITE_BEHAVIOR_LAB_CONSENT_VERIFICATION = "1";
  try {
    const result = await scanSite(
      {
        url: "http://consent-origin.test/",
        device: "desktop",
        gpcEnabled: false,
        consentMode: "reject-all"
      },
      {
        publicUrlAlreadyVerified: true,
        verifyPublicUrl: async () => undefined,
        resolvePublicHost: async () => [{ address: "93.184.216.34", family: 4 }],
        connectProxyUpstreamForTests: () => connect(address.port, "127.0.0.1"),
        resolveCnameChain: async () => []
      }
    );

    assert.equal(
      result.warnings.includes(
        "The post-consent reload left the recorded site; its state was not used and the active input probe was skipped."
      ),
      true
    );
    const staged = stagedSingleVisitMeasurement(result);
    assert.notEqual(staged, null);
    assert.deepEqual(
      staged!.measurement.phases.map((phase) => phase.kind),
      ["passive-load", "consent-interaction", "post-choice-reload"]
    );
    const reloadPhase = staged!.measurement.phases.find((phase) => phase.kind === "post-choice-reload")!;
    assert.deepEqual(staged!.measurement.detectors["keystroke-exfiltration"], {
      version: "synthetic-sentinel@1",
      status: "skipped",
      reason: "load-failed"
    });
    assert.equal(
      staged!.measurement.qualityFacts.captureLoss.some(
        (loss) =>
          loss.family === "consent-verification" &&
          loss.phaseId === reloadPhase.phaseId &&
          loss.kind === "dropped"
      ),
      true
    );
    assert.equal(
      staged!.consent?.verificationObservations.some((observation) => observation.phaseId === reloadPhase.phaseId),
      false
    );
    assert.equal(
      staged!.consent?.bannerTransition?.observations.some((observation) => observation.phaseId === reloadPhase.phaseId),
      false
    );
  } finally {
    delete process.env.SITE_BEHAVIOR_LAB_CONSENT_VERIFICATION;
    await closeSharedBrowserForTests();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

test("scanSite blocks a browser request when the connect-time resolver returns a private address", { timeout: 20_000 }, async () => {
  try {
    await assert.rejects(
      () =>
        scanSite(
          {
            url: "http://rebind.test/",
            device: "desktop",
            gpcEnabled: false,
            consentMode: "observe"
          },
          {
            publicUrlAlreadyVerified: true,
            verifyPublicUrl: async () => undefined,
            resolvePublicHost: async () => [{ address: "127.0.0.1", family: 4 }]
          }
        ),
      (error) => error instanceof PublicScanError && /local or private network address/.test(error.message)
    );
  } finally {
    await closeSharedBrowserForTests();
  }
});

test("scanSite reports a DNS-failed target as an honest load failure, never a private-address block", { timeout: 20_000 }, async () => {
  try {
    await assert.rejects(
      () =>
        scanSite(
          {
            url: "http://gone.test/",
            device: "desktop",
            gpcEnabled: false,
            consentMode: "observe"
          },
          {
            publicUrlAlreadyVerified: true,
            verifyPublicUrl: async () => undefined,
            resolvePublicHost: async () => {
              throw new Error("getaddrinfo ENOTFOUND gone.test");
            }
          }
        ),
      (error) =>
        error instanceof PublicScanError &&
        error.status === 502 &&
        /down, unreachable, or blocking automated visits/.test(error.message) &&
        !/local or private network address/.test(error.message)
    );
  } finally {
    await closeSharedBrowserForTests();
  }
});

test("scanSite forces loopback literals through the connect-time proxy", { timeout: 20_000 }, async () => {
  try {
    await assert.rejects(
      () =>
        scanSite(
          {
            url: "http://127.0.0.1/",
            device: "desktop",
            gpcEnabled: false,
            consentMode: "observe"
          },
          {
            publicUrlAlreadyVerified: true,
            verifyPublicUrl: async () => undefined
          }
        ),
      (error) => error instanceof PublicScanError && /local or private network address/.test(error.message)
    );
  } finally {
    await closeSharedBrowserForTests();
  }
});
