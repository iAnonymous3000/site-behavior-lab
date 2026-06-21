import assert from "node:assert/strict";
import { test } from "node:test";
import { pageGraphToScanResult } from "./pagegraph-adapter";

test("pageGraphToScanResult adapts PageGraph observations into a ScanResult", () => {
  const result = pageGraphToScanResult({
    requestedUrl: "https://example.com/?token=secret#frag",
    finalUrl: "https://example.com/home?session=secret",
    scannedAt: new Date(0).toISOString(),
    pageTitle: "Example",
    status: 200,
    durationMs: 1234.8,
    chromiumVersion: "Brave/1.80.0 Chromium/140.0.0.0",
    userAgent: "Brave test",
    timezone: "UTC",
    locale: "en-US",
    language: "en-US",
    viewport: {
      width: 390,
      height: 844,
      isMobile: true
    },
    gpcEnabled: true,
    scannerEgress: "Brave crawl lab",
    requests: [
      {
        url: "https://example.com/home?session=secret",
        method: "GET",
        resourceType: "document",
        status: 200,
        startedAtMs: 0
      },
      {
        url: "https://www.google-analytics.com/g/collect?id=123&email=a%40b.test#ignored",
        method: "POST",
        resourceType: "script",
        status: 204,
        startedAtMs: 42,
        provenance: {
          graphRecordId: "edge-2",
          initiatorType: "script",
          scriptUrl: "https://example.com/app.js?version=123&session=secret",
          injectedByUrl: "https://cdn.example.net/bootstrap.js?cache=1"
        }
      },
      {
        url: "data:text/plain,ignored"
      }
    ],
    cookies: [
      {
        name: "_ga",
        domain: ".google-analytics.com",
        path: "/",
        sameSite: "None",
        secure: true,
        httpOnly: false,
        session: false
      }
    ],
    storage: [
      {
        area: "localStorage",
        key: "feature-flag",
        valueBytes: 4
      }
    ],
    fingerprintEvents: [
      {
        api: "webgl.getParameter.UNMASKED_RENDERER_WEBGL",
        count: 2
      }
    ]
  });

  assert.equal(result.conditions.automation, "brave-pagegraph");
  assert.equal(result.conditions.requestedUrl, "https://example.com/");
  assert.equal(result.conditions.finalUrl, "https://example.com/home");
  assert.equal(result.conditions.viewport.isMobile, true);
  assert.equal(result.summary.totalRequests, 2);
  assert.equal(result.summary.thirdPartyRequests, 1);
  assert.equal(result.summary.knownTrackerRequests, 1);
  assert.equal(result.summary.thirdPartyCookies, 1);
  assert.equal(result.summary.storageEntries, 1);
  assert.equal(result.summary.fingerprintEvents, 2);
  assert.equal(result.requests[1].url, "https://www.google-analytics.com/g/collect?id=&email=");
  assert.equal(result.requests[1].provenance?.scriptDomain, "example.com");
  assert.equal(result.requests[1].provenance?.scriptUrl, "https://example.com/app.js?version=&session=");
  assert.equal(result.requests[1].provenance?.injectedByDomain, "cdn.example.net");
  assert.equal(result.domains.some((domain) => domain.domain === "www.google-analytics.com" && domain.tracker?.entity === "Google"), true);
  assert.equal(result.warnings.some((warning) => warning.includes("Skipped PageGraph request 3")), true);
  assert.equal(result.warnings.some((warning) => warning.includes("not script-to-request causality")), false);
});

test("pageGraphToScanResult rejects non-HTTP target URLs", () => {
  assert.throws(
    () =>
      pageGraphToScanResult({
        requestedUrl: "file:///tmp/report"
      }),
    /requestedUrl must be an HTTP\(S\) URL/
  );
});
