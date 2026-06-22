import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EdgeScanGateError,
  assertTurnstileToken,
  constantTimeEqual,
  enforcePublicScanRateLimit,
  publicClientHash,
  publicScanGateStatus,
  publicScanRateLimit,
  scanAccessTokenMatches,
  scanTokenCost,
  type RateLimitStore
} from "./edge-scan-gate";

function fakeStore(): RateLimitStore {
  const map = new Map<string, string>();
  return {
    async get(key) {
      return map.get(key) ?? null;
    },
    async put(key, value) {
      map.set(key, value);
    }
  };
}

function okFetch(success: boolean): typeof fetch {
  return (async () => new Response(JSON.stringify({ success }), { headers: { "content-type": "application/json" } })) as typeof fetch;
}

test("scanTokenCost charges two for comparison runs and one otherwise", () => {
  assert.equal(scanTokenCost({}), 1);
  assert.equal(scanTokenCost({ compareGpc: true }), 2);
  assert.equal(scanTokenCost({ compareShields: true }), 2);
});

test("scanAccessTokenMatches accepts the configured token and rejects mismatches", async () => {
  const good = new Headers({ authorization: "Bearer s3cret" });
  const bad = new Headers({ authorization: "Bearer nope" });
  const missing = new Headers();
  assert.equal(await scanAccessTokenMatches(good, "s3cret"), true);
  assert.equal(await scanAccessTokenMatches(bad, "s3cret"), false);
  assert.equal(await scanAccessTokenMatches(missing, "s3cret"), false);
});

test("constantTimeEqual compares by value", async () => {
  assert.equal(await constantTimeEqual("abc", "abc"), true);
  assert.equal(await constantTimeEqual("abc", "abd"), false);
  assert.equal(await constantTimeEqual("short", "longer-value"), false);
});

test("assertTurnstileToken requires a token and honors the siteverify result", async () => {
  await assert.rejects(
    () => assertTurnstileToken({ secret: "k", token: "", fetchImpl: okFetch(true) }),
    (error: unknown) => error instanceof EdgeScanGateError && error.status === 400
  );
  await assert.rejects(
    () => assertTurnstileToken({ secret: "k", token: "t", fetchImpl: okFetch(false) }),
    (error: unknown) => error instanceof EdgeScanGateError && error.status === 403
  );
  await assert.doesNotReject(() => assertTurnstileToken({ secret: "k", token: "t", fetchImpl: okFetch(true) }));
});

test("enforcePublicScanRateLimit charges windows and rejects over the per-minute limit", async () => {
  const store = fakeStore();
  const now = 1_000_000_000_000;
  // Six single-cost scans fit a per-minute limit of 6.
  for (let i = 0; i < 6; i += 1) {
    await enforcePublicScanRateLimit({ store, clientHash: "client", cost: 1, perMinute: 6, perDay: 120, now });
  }
  await assert.rejects(
    () => enforcePublicScanRateLimit({ store, clientHash: "client", cost: 1, perMinute: 6, perDay: 120, now }),
    (error: unknown) => error instanceof EdgeScanGateError && error.status === 429
  );
});

test("enforcePublicScanRateLimit counts comparison cost and the daily window independently", async () => {
  const store = fakeStore();
  const now = 1_000_000_000_000;
  // Daily limit of 2; a comparison costs 2 and fills it.
  await enforcePublicScanRateLimit({ store, clientHash: "c", cost: 2, perMinute: 100, perDay: 2, now });
  await assert.rejects(
    () => enforcePublicScanRateLimit({ store, clientHash: "c", cost: 1, perMinute: 100, perDay: 2, now }),
    (error: unknown) => error instanceof EdgeScanGateError && error.status === 429
  );
});

test("separate clients and separate minute windows do not share budget", async () => {
  const store = fakeStore();
  const base = 1_000_000_000_000;
  await enforcePublicScanRateLimit({ store, clientHash: "a", cost: 1, perMinute: 1, perDay: 120, now: base });
  // A different client is unaffected.
  await assert.doesNotReject(() =>
    enforcePublicScanRateLimit({ store, clientHash: "b", cost: 1, perMinute: 1, perDay: 120, now: base })
  );
  // The same client one minute later gets a fresh minute window.
  await assert.doesNotReject(() =>
    enforcePublicScanRateLimit({ store, clientHash: "a", cost: 1, perMinute: 1, perDay: 120, now: base + 60_000 })
  );
});

test("publicClientHash is stable per IP and varies across IPs", async () => {
  const a1 = await publicClientHash(new Headers({ "cf-connecting-ip": "203.0.113.7" }));
  const a2 = await publicClientHash(new Headers({ "cf-connecting-ip": "203.0.113.7" }));
  const b = await publicClientHash(new Headers({ "cf-connecting-ip": "203.0.113.8" }));
  assert.equal(a1, a2);
  assert.notEqual(a1, b);
  assert.match(a1, /^[a-f0-9]{64}$/);
});

test("publicScanGateStatus reflects the edge gate's admission rules", () => {
  // Open public scanner with Turnstile: the field the UI reads to show the widget.
  assert.deepEqual(
    publicScanGateStatus({ allowUnauthenticated: "1", turnstileSecret: "secret" }),
    { authenticated: false, openAccess: true, turnstile: true }
  );
  // Open but no Turnstile secret configured.
  assert.deepEqual(
    publicScanGateStatus({ allowUnauthenticated: "1" }),
    { authenticated: false, openAccess: true, turnstile: false }
  );
  // A configured token forces gated mode: open access and Turnstile are off.
  assert.deepEqual(
    publicScanGateStatus({ accessToken: "t", allowUnauthenticated: "1", turnstileSecret: "secret" }),
    { authenticated: true, openAccess: false, turnstile: false }
  );
  // Neither token nor explicit open access: refused (not open, not authenticated).
  assert.deepEqual(publicScanGateStatus({}), { authenticated: false, openAccess: false, turnstile: false });
});

test("publicScanRateLimit parses overrides and falls back", () => {
  assert.equal(publicScanRateLimit("10", 6), 10);
  assert.equal(publicScanRateLimit(undefined, 6), 6);
  assert.equal(publicScanRateLimit("0", 6), 6);
  assert.equal(publicScanRateLimit("nan", 6), 6);
});
