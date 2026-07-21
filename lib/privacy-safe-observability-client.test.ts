import assert from "node:assert/strict";
import test from "node:test";
import {
  browserPrivacySignalOptOut,
  deliverPrivacySafeObservabilityEvent,
  resolvePrivacySafeMetricsClientConfig
} from "./privacy-safe-observability-client";
import { routeViewEvent } from "./privacy-safe-observability";

test("client collection is disabled by default and endpoint is derived only from the scan API origin", () => {
  assert.deepEqual(resolvePrivacySafeMetricsClientConfig(undefined, "https://scan.sitebehavior.org"), {
    enabled: false,
    endpoint: null
  });
  assert.deepEqual(resolvePrivacySafeMetricsClientConfig("0", "https://scan.sitebehavior.org"), {
    enabled: false,
    endpoint: null
  });
  assert.deepEqual(resolvePrivacySafeMetricsClientConfig("1", "https://scan.sitebehavior.org"), {
    enabled: true,
    endpoint: "https://scan.sitebehavior.org/api/metrics"
  });
  for (const invalid of [
    "http://scan.sitebehavior.org",
    "https://user:pass@scan.sitebehavior.org",
    "https://scan.sitebehavior.org/other",
    "https://scan.sitebehavior.org?target=secret",
    "not-a-url"
  ]) {
    assert.deepEqual(resolvePrivacySafeMetricsClientConfig("1", invalid), { enabled: false, endpoint: null });
  }
  assert.deepEqual(resolvePrivacySafeMetricsClientConfig("1", "http://127.0.0.1:8787"), {
    enabled: true,
    endpoint: "http://127.0.0.1:8787/api/metrics"
  });
});

test("browser GPC and Do Not Track always opt out", () => {
  assert.equal(browserPrivacySignalOptOut({ globalPrivacyControl: true }), true);
  assert.equal(browserPrivacySignalOptOut({ doNotTrack: "1" }), true);
  assert.equal(browserPrivacySignalOptOut({ doNotTrack: "yes" }), true);
  assert.equal(browserPrivacySignalOptOut({ globalPrivacyControl: false, doNotTrack: "0" }), false);
});

test("client sends a validated event without credentials, referrer, retries, or identifiers", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const outcome = await deliverPrivacySafeObservabilityEvent(
    routeViewEvent("home"),
    resolvePrivacySafeMetricsClientConfig("1", "https://scan.sitebehavior.org"),
    { globalPrivacyControl: false, doNotTrack: "0" },
    async (url, init) => {
      calls.push({ url, init });
      return { ok: true };
    }
  );
  assert.equal(outcome, "sent");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://scan.sitebehavior.org/api/metrics");
  assert.equal(calls[0].init.credentials, "omit");
  assert.equal(calls[0].init.referrerPolicy, "no-referrer");
  assert.equal(calls[0].init.keepalive, true);
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), routeViewEvent("home"));
});

test("disabled, opted-out, invalid, and failed delivery never throw or invoke unsafe fallback storage", async () => {
  let calls = 0;
  const fetcher = async () => {
    calls += 1;
    throw new Error("offline");
  };
  assert.equal(
    await deliverPrivacySafeObservabilityEvent(
      routeViewEvent("home"),
      { enabled: false, endpoint: null },
      undefined,
      fetcher
    ),
    "disabled"
  );
  assert.equal(
    await deliverPrivacySafeObservabilityEvent(
      routeViewEvent("home"),
      resolvePrivacySafeMetricsClientConfig("1", "https://scan.sitebehavior.org"),
      { globalPrivacyControl: true },
      fetcher
    ),
    "opted-out"
  );
  assert.equal(
    await deliverPrivacySafeObservabilityEvent(
      { ...routeViewEvent("home"), targetUrl: "https://secret.example" },
      resolvePrivacySafeMetricsClientConfig("1", "https://scan.sitebehavior.org"),
      undefined,
      fetcher
    ),
    "rejected"
  );
  assert.equal(calls, 0);
  assert.equal(
    await deliverPrivacySafeObservabilityEvent(
      routeViewEvent("home"),
      resolvePrivacySafeMetricsClientConfig("1", "https://scan.sitebehavior.org"),
      undefined,
      fetcher
    ),
    "failed"
  );
  assert.equal(calls, 1);
});
