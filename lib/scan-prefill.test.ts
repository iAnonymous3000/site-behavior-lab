import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  isScannableHostname,
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

/**
 * These cases used to pass here for the wrong reason. This module runs in the browser,
 * and rejection used to depend on `new URL()` throwing: Node throws on a space in the
 * authority, Chromium percent-encodes it and returns `https://not%20a%20url/`. So the
 * suite was green while a visitor who typed a space got no validation error, had their
 * text silently rewritten to a percent-encoded string, and spent a real scan request on
 * it. Assert on the shapes Chromium salvages, which Node never produced.
 *
 * NOTE the split below. Feeding raw-space input to normalizeScanUrl under Node proves
 * almost nothing, because Node throws in the parser and the hostname predicate never
 * runs: this suite stayed green when the percent guard was deleted. The hostname cases
 * therefore go straight to isScannableHostname with the exact strings Chromium's parser
 * produces, so the Chromium-only branch is actually exercised here.
 */
test("hostnames Chromium salvages from malformed input are refused", () => {
  // These are Chromium's real outputs for "not a url", "ex ample.com", "hello world",
  // "a b c d" and "my notes about example". Node never produces them, so asserting on
  // normalizeScanUrl alone cannot reach this branch.
  for (const hostname of [
    "not%20a%20url",
    "ex%20ample.com",
    "hello%20world",
    "a%20b%20c%20d",
    "my%20notes%20about%20example"
  ]) {
    assert.equal(isScannableHostname(hostname), false, hostname);
  }
  // And the same predicate still accepts every real target shape.
  for (const hostname of ["example.com", "xn--mnchen-3ya.de", "sub.example.co.uk", "example.com.", "[::1]"]) {
    assert.equal(isScannableHostname(hostname), true, hostname);
  }
  for (const hostname of ["", "example", "localhost", "a..b", ".example.com"]) {
    assert.equal(isScannableHostname(hostname), false, hostname);
  }
});

test("targets Chromium salvages instead of rejecting are still refused", () => {
  for (const input of [
    "not a url",
    "hello world",
    "my notes about example",
    "ex ample.com",
    "a b c d"
  ]) {
    assert.equal(normalizeScanUrl(input), null, input);
  }
  // Pre-encoded input reaches the hostname predicate under Node too, so this one case
  // does fail if the percent guard is removed.
  assert.equal(normalizeScanUrl("https://ex%20ample.com/account"), null);
  assert.equal(normalizeScanUrl("https://not%20a%20url/"), null);
  // Single-label and empty-label hosts are not scannable public targets either.
  assert.equal(normalizeScanUrl("example"), null);
  assert.equal(normalizeScanUrl("localhost"), null);
  assert.equal(normalizeScanUrl("a..b"), null);
  assert.equal(normalizeScanUrl(".example.com"), null);
  // Non-http schemes never reach the scanner.
  assert.equal(normalizeScanUrl("javascript:alert(1)"), null);
  assert.equal(normalizeScanUrl("file:///etc/passwd"), null);
  // Real targets still normalize, including IDN, ports, and a trailing root dot.
  assert.equal(normalizeScanUrl("EXAMPLE.COM"), "https://example.com/");
  assert.equal(normalizeScanUrl("münchen.de"), "https://xn--mnchen-3ya.de/");
  assert.equal(normalizeScanUrl("http://example.com:8080/path?q=1#f"), "http://example.com:8080/path");
  assert.equal(normalizeScanUrl("example.com."), "https://example.com./");
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
