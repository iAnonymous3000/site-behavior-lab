import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveAllowedOrigin, scanCorsHeaders } from "./cors";

test("resolveAllowedOrigin defaults to * when unconfigured", () => {
  assert.equal(resolveAllowedOrigin("https://acme.github.io", undefined), "*");
  assert.equal(resolveAllowedOrigin("https://acme.github.io", "   "), "*");
  assert.equal(resolveAllowedOrigin(null, undefined), "*");
});

test("resolveAllowedOrigin echoes a matching origin and denies others", () => {
  assert.equal(resolveAllowedOrigin("https://acme.github.io", "https://acme.github.io"), "https://acme.github.io");
  assert.equal(resolveAllowedOrigin("https://evil.example", "https://acme.github.io"), "null");
  assert.equal(resolveAllowedOrigin(null, "https://acme.github.io"), "null");
});

test("scanCorsHeaders permits the scan auth/turnstile headers and preflight methods", () => {
  const headers = scanCorsHeaders("https://acme.github.io", "*");
  assert.equal(headers["Access-Control-Allow-Origin"], "*");
  assert.equal(headers["Access-Control-Allow-Methods"], "GET, POST, OPTIONS");
  // The static UI sends the access token as `Authorization: Bearer` and JSON, both
  // of which trigger a preflight; the Turnstile and legacy token headers must pass too.
  assert.match(headers["Access-Control-Allow-Headers"], /\bauthorization\b/);
  assert.match(headers["Access-Control-Allow-Headers"], /\bcontent-type\b/);
  assert.match(headers["Access-Control-Allow-Headers"], /cf-turnstile-response/);
  assert.match(headers["Access-Control-Allow-Headers"], /x-site-behavior-lab-access-token/);
  assert.equal(headers["Vary"], "Origin");
});
