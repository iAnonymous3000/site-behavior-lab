import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  normalizeScanUrl,
  resolveScanPrefillNavigation,
  scanPrefillHref
} from "./scan-prefill";

test("scan deep links keep target secrets out of every HTTP request URL", () => {
  const privateTarget = "https://example.com/account/settings?email=alice%40example.com&token=bearer-secret#receipt";
  const href = scanPrefillHref(privateTarget);
  assert.equal(href, "/#scan?url=https%3A%2F%2Fexample.com%2Faccount%2Fsettings");

  const browserUrl = new URL(href ?? "", "https://sitebehavior.org");
  assert.equal(browserUrl.search, "");
  const requestUrl = new URL(browserUrl);
  requestUrl.hash = "";
  assert.equal(requestUrl.toString(), "https://sitebehavior.org/");
  assert.doesNotMatch(browserUrl.toString(), /alice|bearer-secret|receipt/);
});

test("fragment prefills normalize the target and scrub browser history before use", () => {
  const navigation = resolveScanPrefillNavigation(
    "https://sitebehavior.org/#scan?url=https%3A%2F%2Fexample.com%2Faccount%3Ftoken%3Dbearer-secret%23receipt"
  );
  assert.deepEqual(navigation, {
    targetUrl: "https://example.com/account",
    cleanHref: "https://sitebehavior.org/#scan",
    scrollToScan: true
  });
  assert.doesNotMatch(navigation?.cleanHref ?? "", /bearer-secret|receipt/);
});

test("legacy query prefills are removed without trusting their target", () => {
  const navigation = resolveScanPrefillNavigation(
    "https://sitebehavior.org/?campaign=research&url=https%3A%2F%2Fexample.com%2Faccount%3Ftoken%3Dbearer-secret#scan"
  );
  assert.deepEqual(navigation, {
    targetUrl: null,
    cleanHref: "https://sitebehavior.org/?campaign=research#scan",
    scrollToScan: true
  });
  assert.doesNotMatch(navigation?.cleanHref ?? "", /url=|bearer-secret/);
});

test("malformed fragment prefills are scrubbed and never reach form state", () => {
  const navigation = resolveScanPrefillNavigation(
    "https://sitebehavior.org/#scan?url=https%3A%2F%2Fexample.com%2Faccount&token=bearer-secret"
  );
  assert.deepEqual(navigation, {
    targetUrl: null,
    cleanHref: "https://sitebehavior.org/#scan",
    scrollToScan: true
  });
});

test("scan URL normalization preserves route intent while stripping private data", () => {
  assert.equal(normalizeScanUrl("example.com/account?token=secret#receipt"), "https://example.com/account");
  assert.equal(normalizeScanUrl("https://exa mple.com/account?token=secret#receipt"), null);
  assert.equal(normalizeScanUrl("   "), null);
});

test("all scan-prefill producers use the fragment-only helper", () => {
  const root = process.cwd();
  const runtime = readFileSync(path.join(root, "app", "_hooks", "use-scan-runtime.ts"), "utf8");
  const trust = readFileSync(path.join(root, "lib", "report-trust.ts"), "utf8");
  const profile = readFileSync(path.join(root, "app", "sites", "[domain]", "page.tsx"), "utf8");

  assert.doesNotMatch(runtime, /new URLSearchParams\(window\.location\.search\)\.get\("url"\)/);
  assert.match(runtime, /resolveScanPrefillNavigation\(window\.location\.href\)/);
  assert.match(runtime, /history\.replaceState/);
  assert.match(trust, /scanPrefillHref\(exactTarget\)/);
  assert.match(profile, /scanPrefillHref\(rescanUrl\)/);
  assert.doesNotMatch(`${trust}\n${profile}`, /`\/\?url=/);
});

test("both deployment front doors suppress referrers and landing-page caching", () => {
  const root = process.cwd();
  const nextConfig = readFileSync(path.join(root, "next.config.mjs"), "utf8");
  const pagesHeaders = readFileSync(path.join(root, "public", "_headers"), "utf8");

  assert.match(nextConfig, /\{ key: "Referrer-Policy", value: "no-referrer" \}/);
  assert.match(nextConfig, /source: "\/",\s+headers: noStoreHeaders/);
  assert.match(pagesHeaders, /Referrer-Policy: no-referrer/);
  assert.match(pagesHeaders, /\n\/\n  Cache-Control: no-store/);
});
