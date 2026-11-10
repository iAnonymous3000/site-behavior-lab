import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
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
  assert.equal(headers["Access-Control-Allow-Methods"], "GET, POST, DELETE, OPTIONS");
  // The static UI sends the access token as `Authorization: Bearer` and JSON, both
  // of which trigger a preflight; the Turnstile and legacy token headers must pass too.
  assert.match(headers["Access-Control-Allow-Headers"], /\bauthorization\b/);
  assert.match(headers["Access-Control-Allow-Headers"], /\bcontent-type\b/);
  assert.match(headers["Access-Control-Allow-Headers"], /cf-turnstile-response/);
  assert.match(headers["Access-Control-Allow-Headers"], /x-site-behavior-lab-access-token/);
  assert.match(headers["Access-Control-Allow-Headers"], /x-site-behavior-lab-watch-access-token/);
  assert.match(headers["Access-Control-Allow-Headers"], /x-site-behavior-lab-watch-capability/);
  assert.equal(headers["Vary"], "Origin");
});

test("scanCorsHeaders exposes Retry-After, and its header set changes only on purpose", () => {
  // Retry-After is not a response header a browser shows a cross-origin
  // reader by default. The static site reads a fresh report from the scanner's
  // origin and waits as long as a refusal says, so the header must be exposed
  // on every answer these headers go on, whichever limiter refused.
  for (const [origin, configured] of [
    ["https://acme.github.io", "*"],
    ["https://sitebehavior.org", "https://sitebehavior.org"],
    [null, undefined]
  ] as const) {
    assert.equal(scanCorsHeaders(origin, configured)["Access-Control-Expose-Headers"], "Retry-After");
  }
  // The whole set, by name. Node's routes and the Worker both take it from
  // this one function, so a header added or dropped here reaches both.
  assert.deepEqual(Object.keys(scanCorsHeaders("https://acme.github.io", "*")).sort(), [
    "Access-Control-Allow-Headers",
    "Access-Control-Allow-Methods",
    "Access-Control-Allow-Origin",
    "Access-Control-Expose-Headers",
    "Access-Control-Max-Age",
    "Vary"
  ]);
  assert.deepEqual(Object.keys(scanCorsHeaders("https://evil.example", "https://acme.github.io")).sort(), [
    "Access-Control-Allow-Headers",
    "Access-Control-Allow-Methods",
    "Access-Control-Expose-Headers",
    "Access-Control-Max-Age",
    "Vary"
  ]);
});

test("the scan API's CORS headers have one builder, so Node's answers and the edge's cannot differ", () => {
  // Node's routes reach scanCorsHeaders through app/api/cors.ts, and the
  // Worker and the two edge gates call it directly. A CORS header written by
  // hand anywhere on that path would be a second definition that this
  // function's tests do not see.
  const handWritten = /["'`]access-control-[a-z-]+["'`]/i;
  const root = process.cwd();
  const sources = [
    "app/api/cors.ts",
    "cloudflare/container-worker.ts",
    "lib/admission-attempt-limit.ts",
    "lib/report-read-edge.ts"
  ];
  const walk = (dir: string): string[] =>
    readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? walk(path.join(dir, entry.name)) : entry.name === "route.ts" ? [path.join(dir, entry.name)] : []
    );
  const routes = walk("app/api");
  assert.ok(routes.length >= 5, "the walk should find the API route files");
  for (const file of [...sources, ...routes]) {
    const source = readFileSync(path.join(root, file), "utf8");
    assert.doesNotMatch(source, handWritten, `${file} writes a CORS header by hand`);
  }
  for (const file of sources) {
    assert.match(readFileSync(path.join(root, file), "utf8"), /scanCorsHeaders\(/, `${file} must build its CORS headers with scanCorsHeaders`);
  }
});
