import assert from "node:assert/strict";
import { test } from "node:test";
import { PublicScanError } from "./public-errors";
import {
  closeSharedBrowserForTests,
  decideRoutedRequest,
  MAX_RECORDED_REQUESTS,
  NON_HTTP_WARNING_EXAMPLE_LIMIT,
  redactUrlForReport,
  SCAN_CHROMIUM_LAUNCH_ARGS,
  ScanRequestBudget,
  scanSite,
  scanTimeout,
  ScanWarningCollector
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
  resourceType = "script",
  navigation = false,
  frame = mainFrame,
  frameThrows = false,
  serviceWorkerUrl = null,
  serviceWorkerUrlThrows = false
}: {
  url: string;
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

test("ScanWarningCollector limits noisy non-HTTP request examples", () => {
  const warnings = new ScanWarningCollector();
  const attempts = NON_HTTP_WARNING_EXAMPLE_LIMIT + 3;

  for (let index = 0; index < attempts; index += 1) {
    warnings.addNonHttpRequest(`blob:https://example.com/${index}?token=secret`);
  }

  assert.equal(warnings.list.length, NON_HTTP_WARNING_EXAMPLE_LIMIT + 1);
  assert.match(warnings.list[0], /^Blocked a non-HTTP\(S\) request: blob:https:\/\/example.com\/0$/);
  assert.equal(
    warnings.list.at(-1),
    `Blocked additional non-HTTP(S) requests. Only the first ${NON_HTTP_WARNING_EXAMPLE_LIMIT} examples are shown.`
  );
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
  warnings.addUnverifiedRequest("https://blocked.example/pixel?attempt=1");
  warnings.addUnverifiedRequest("https://blocked.example/pixel?attempt=2");
  assert.deepEqual(warnings.list, ["Blocked a request that could not be verified as public: https://blocked.example/pixel"]);

  for (let index = 0; index < NON_HTTP_WARNING_EXAMPLE_LIMIT + 3; index += 1) {
    warnings.addUnverifiedRequest(`https://blocked-${index}.example/asset?token=secret`);
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
  assert.deepEqual(warnings.list, ["Blocked a non-HTTP(S) request: blob:https://example.com/asset"]);
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
    request: routeRequest({ url: "https://metadata.example/latest?token=secret" }),
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
  assert.deepEqual(warnings.list, ["Blocked a request that could not be verified as public: https://metadata.example/latest"]);
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
    check: (url: string, sourceUrl: string, requestType: string) => {
      engineCalls += 1;
      assert.equal(url.startsWith("https://ads.example/"), true);
      assert.equal(sourceUrl, "https://example.com/");
      assert.equal(requestType, "script");
      return true;
    }
  };

  assert.deepEqual(
    await decideRoutedRequest({
      request: routeRequest({ url: "https://ads.example/pixel.js" }),
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
      check: (_url, sourceUrl) => {
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
      check: (_url: string, sourceUrl: string, requestType: string) => {
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
    check: (_url: string, sourceUrl: string) => {
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
