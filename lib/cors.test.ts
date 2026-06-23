import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveAllowedOrigin, scanCorsHeaders } from "./cors";

test("resolveAllowedOrigin defaults to * when unconfigured", () => {
  assert.equal(resolveAllowedOrigin("https://acme.github.io", undefined), "*");
  assert.equal(resolveAllowedOrigin("https://acme.github.io", "   "), "*");
  assert.equal(resolveAllowedOrigin(null, undefined), "*");
});

test("resolveAllowedOrigin echoes a matching origin and denies others with null", () => {
  assert.equal(resolveAllowedOrigin("https://acme.github.io", "https://acme.github.io"), "https://acme.github.io");
  // Denials return null (the helper omits the header) rather than the literal
  // string "null", which an opaque-origin caller could otherwise match.
  assert.equal(resolveAllowedOrigin("https://evil.example", "https://acme.github.io"), null);
  assert.equal(resolveAllowedOrigin(null, "https://acme.github.io"), null);
  // An opaque origin sends the literal header value "null"; it must still be denied.
  assert.equal(resolveAllowedOrigin("null", "https://acme.github.io"), null);
});

test("scanCorsHeaders omits Access-Control-Allow-Origin for denied origins", () => {
  // Opaque origins (sandboxed docs, data:/blob:/file: pages) send `Origin: null`.
  // The pinned-origin deployment must not hand them a matching allow-origin value.
  const opaque = scanCorsHeaders("null", "https://sitebehavior.org");
  assert.equal("Access-Control-Allow-Origin" in opaque, false);
  assert.equal(opaque["Vary"], "Origin");

  const missing = scanCorsHeaders(null, "https://sitebehavior.org");
  assert.equal("Access-Control-Allow-Origin" in missing, false);

  const mismatch = scanCorsHeaders("https://evil.example", "https://sitebehavior.org");
  assert.equal("Access-Control-Allow-Origin" in mismatch, false);

  // The configured origin itself is still echoed.
  const allowed = scanCorsHeaders("https://sitebehavior.org", "https://sitebehavior.org");
  assert.equal(allowed["Access-Control-Allow-Origin"], "https://sitebehavior.org");
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
