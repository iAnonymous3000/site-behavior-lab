import assert from "node:assert/strict";
import { createServer } from "node:http";
import { connect } from "node:net";
import { test } from "node:test";
import { PublicScanError } from "./public-errors";
import { MeasurementKernel } from "./measurement-kernel";
import { buildScanConditions, buildScanResult } from "./scan-result-builder";
import { ScanNetworkRecorder } from "./scan-runtime";
import {
  attachStagedSingleVisitMeasurement,
  closeSharedBrowserForTests,
  decideRoutedRequest,
  MAX_RECORDED_REQUESTS,
  NON_HTTP_WARNING_EXAMPLE_LIMIT,
  redactUrlForReport,
  SCAN_CHROMIUM_LAUNCH_ARGS,
  ScanRequestBudget,
  scanSite,
  scanTimeout,
  ScanWarningCollector,
  stagedSingleVisitMeasurement
} from "./scanner";

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

test("decideRoutedRequest memoizes public host checks by scheme, host, and port", async () => {
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
    }
  };

  assert.deepEqual(
    await decideRoutedRequest({
      ...options,
      request: routeRequest({ url: "https://cdn.example.com/app.js" })
    }),
    { action: "continue", blockedByShields: false }
  );
  assert.deepEqual(
    await decideRoutedRequest({
      ...options,
      request: routeRequest({ url: "https://cdn.example.com/style.css", resourceType: "stylesheet" })
    }),
    { action: "continue", blockedByShields: false }
  );

  assert.equal(verifierCalls, 1);
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

test("scanSite stages live phase-aware readbacks while returning only v1", { timeout: 20_000 }, async () => {
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
      staged!.evidence.requests.filter((request) => request.blockedByShields === true).length
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
  } finally {
    await closeSharedBrowserForTests();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

test("failed passive storage collection cannot manufacture consent-phase mutations", { timeout: 20_000 }, async () => {
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
      </script>
      <script src="http://ads.example/pixel.js"></script>
      <button onclick="localStorage.setItem('consent-state', 'accepted')">Accept all</button>`);
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
    assert.equal(receivedGpcHeader, undefined);
    const staged = stagedSingleVisitMeasurement(result);
    assert.notEqual(staged, null);
    assert.equal(staged!.evidence.storageFinal.some((entry) => entry.key === "consent-state"), true);
    assert.deepEqual(staged!.evidence.storageMutations, []);
    assert.deepEqual(
      staged!.measurement.qualityFacts.captureLoss.filter((loss) => loss.family === "storage"),
      [{ family: "storage", phaseId: 0, kind: "dropped", count: 1, detail: "passive-boundary" }]
    );
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
