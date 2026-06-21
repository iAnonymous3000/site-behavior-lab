import assert from "node:assert/strict";
import { test } from "node:test";
import { PublicScanError } from "./public-errors";
import {
  closeSharedBrowserForTests,
  decideRoutedRequest,
  MAX_RECORDED_REQUESTS,
  NON_HTTP_WARNING_EXAMPLE_LIMIT,
  redactUrlForReport,
  ScanRequestBudget,
  scanSite,
  scanTimeout,
  ScanWarningCollector
} from "./scanner";

const mainFrame = {};
const childFrame = {};
const routePage = {
  mainFrame: () => mainFrame
};

function routeRequest({
  url,
  resourceType = "script",
  navigation = false,
  frame = childFrame
}: {
  url: string;
  resourceType?: string;
  navigation?: boolean;
  frame?: object;
}) {
  return {
    frame: () => frame,
    isNavigationRequest: () => navigation,
    resourceType: () => resourceType,
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
  const adblockEngine = {
    check: (url: string, sourceUrl: string, requestType: string) => {
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
    { action: "abort", blockedByShields: true }
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
    { action: "continue", blockedByShields: false }
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
