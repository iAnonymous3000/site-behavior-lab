import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EdgeScanGateError,
  assertTurnstileToken,
  constantTimeEqual,
  enforcePublicScanRateLimit,
  openScanBlockedForMissingTurnstile,
  publicClientHash,
  publicScanGateStatus,
  publicScanRateLimit,
  publicScanRefusalReasons,
  readRequestBodyWithinLimit,
  scanAccessTokenMatches,
  scanTokenCost,
  withPublicScanAccessCheck,
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

test("publicScanRefusalReasons names every configuration that fails all scans closed", () => {
  // A healthy gated scanner and a healthy open scanner refuse nothing.
  assert.deepEqual(publicScanRefusalReasons({ accessToken: "t", rateLimitStoreBound: false }), []);
  assert.deepEqual(
    publicScanRefusalReasons({ allowUnauthenticated: "1", turnstileSecret: "secret", rateLimitStoreBound: true }),
    []
  );

  // No token and not explicitly opened: every scan 503s and health must say so.
  const closed = publicScanRefusalReasons({ rateLimitStoreBound: true });
  assert.equal(closed.length, 1);
  assert.match(closed[0], /unauthenticated scans are not enabled/);

  // Open without Turnstile (and without the explicit waiver): every scan 503s.
  const noTurnstile = publicScanRefusalReasons({ allowUnauthenticated: "1", rateLimitStoreBound: true });
  assert.equal(noTurnstile.length, 1);
  assert.match(noTurnstile[0], /Turnstile is not configured/);
  // The explicit waiver clears that refusal.
  assert.deepEqual(
    publicScanRefusalReasons({ allowUnauthenticated: "1", acceptNoTurnstileRisk: "1", rateLimitStoreBound: true }),
    []
  );

  // Open without the KV rate-limit binding: every scan 503s.
  const noKv = publicScanRefusalReasons({ allowUnauthenticated: "1", turnstileSecret: "secret", rateLimitStoreBound: false });
  assert.equal(noKv.length, 1);
  assert.match(noKv[0], /RATE_LIMITS_KV/);
});

test("withPublicScanAccessCheck overlays the authoritative edge posture and preserves other checks", () => {
  const upstream = {
    adblock: { active: true },
    scanAccess: "open",
    reportStore: { kind: "r2" }
  };

  const authenticatedGate = publicScanGateStatus({ accessToken: "token", allowUnauthenticated: "1" });
  assert.deepEqual(withPublicScanAccessCheck(upstream, authenticatedGate, []), {
    adblock: { active: true },
    scanAccess: "configured",
    reportStore: { kind: "r2" }
  });
  assert.equal(upstream.scanAccess, "open");

  const openGate = publicScanGateStatus({ allowUnauthenticated: "1", turnstileSecret: "secret" });
  assert.equal(withPublicScanAccessCheck(upstream, openGate, []).scanAccess, "open");

  const refusedGate = publicScanGateStatus({});
  const refusals = publicScanRefusalReasons({ rateLimitStoreBound: true });
  assert.equal(withPublicScanAccessCheck(upstream, refusedGate, refusals).scanAccess, "refused");
  assert.deepEqual(withPublicScanAccessCheck(null, refusedGate, refusals), { scanAccess: "refused" });
});

test("publicScanRateLimit parses overrides and falls back", () => {
  assert.equal(publicScanRateLimit("10", 6), 10);
  assert.equal(publicScanRateLimit(undefined, 6), 6);
  assert.equal(publicScanRateLimit("0", 6), 6);
  assert.equal(publicScanRateLimit("nan", 6), 6);
});

test("openScanBlockedForMissingTurnstile fails closed unless configured or explicitly waived", () => {
  // No Turnstile secret and no waiver: refuse the open scan.
  assert.equal(openScanBlockedForMissingTurnstile({}), true);
  assert.equal(openScanBlockedForMissingTurnstile({ turnstileSecret: "  " }), true);
  // A configured secret means Turnstile is enforced elsewhere, not blocked here.
  assert.equal(openScanBlockedForMissingTurnstile({ turnstileSecret: "secret" }), false);
  // Conscious waiver allows open access without Turnstile.
  assert.equal(openScanBlockedForMissingTurnstile({ acceptNoTurnstileRisk: "1" }), false);
  // Any value other than exactly "1" does not waive.
  assert.equal(openScanBlockedForMissingTurnstile({ acceptNoTurnstileRisk: "true" }), true);
});

test("readRequestBodyWithinLimit reads bodies within the cap", async () => {
  const body = JSON.stringify({ url: "https://example.com" });
  const request = new Request("https://scanner.example/api/scan", { method: "POST", body });
  assert.equal(await readRequestBodyWithinLimit(request, 4_096), body);
});

test("readRequestBodyWithinLimit rejects a declared oversize length without reading the body", async () => {
  // Headers built standalone (guard "none") so content-length survives; the
  // body stream records whether it was ever pulled.
  let pulled = false;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulled = true;
        controller.enqueue(new TextEncoder().encode("x"));
        controller.close();
      }
    },
    // Without this, the stream machinery pulls eagerly at construction to
    // fill its queue and the flag would trip with no consumer at all.
    { highWaterMark: 0 }
  );
  const requestLike = {
    headers: new Headers({ "content-length": "999999" }),
    body: stream
  } as unknown as Request;
  assert.equal(await readRequestBodyWithinLimit(requestLike, 4_096), null);
  assert.equal(pulled, false);
});

test("readRequestBodyWithinLimit caps chunked bodies mid-stream and cancels the reader", async () => {
  // No content-length: five 2 KiB chunks against a 4 KiB cap must stop the
  // read at the third chunk instead of buffering all five.
  let chunksServed = 0;
  let cancelled = false;
  const chunk = new Uint8Array(2_048).fill(120);
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (chunksServed >= 5) {
        controller.close();
        return;
      }
      chunksServed += 1;
      controller.enqueue(chunk);
    },
    cancel() {
      cancelled = true;
    }
  });
  const requestLike = { headers: new Headers(), body: stream } as unknown as Request;
  assert.equal(await readRequestBodyWithinLimit(requestLike, 4_096), null);
  assert.equal(cancelled, true);
  assert.ok(chunksServed <= 3, `served ${chunksServed} chunks; the cap must stop the read early`);
});

test("readRequestBodyWithinLimit accepts a body at exactly the cap and treats no body as empty", async () => {
  const exact = "a".repeat(64);
  const request = new Request("https://scanner.example/api/scan", { method: "POST", body: exact });
  assert.equal(await readRequestBodyWithinLimit(request, 64), exact);
  const bodiless = { headers: new Headers(), body: null } as unknown as Request;
  assert.equal(await readRequestBodyWithinLimit(bodiless, 64), "");
});
