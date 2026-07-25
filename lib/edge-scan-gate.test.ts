import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EdgeScanGateError,
  RequestBodyInvalidUtf8Error,
  RequestBodyReadAbortedError,
  RequestBodyReadTimeoutError,
  assertTurnstileToken,
  constantTimeEqual,
  formatPublicScanRetryAfter,
  openScanBlockedForMissingTurnstile,
  probeTurnstileConfiguration,
  publicClientHash,
  publicScanGateStatus,
  publicScanRateLimit,
  publicScanRefusalReasons,
  readRequestBodyWithinLimit,
  scanAccessTokenMatches,
  scanTokenCost,
  turnstileAdmissionIdempotencyKey,
  withPublicScanAccessCheck
} from "./edge-scan-gate";

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

test("Turnstile retries carry one stable admission idempotency UUID", async () => {
  const requests: URLSearchParams[] = [];
  const fetchImpl = (async (_input: URL | RequestInfo, init?: RequestInit) => {
    requests.push(init?.body as URLSearchParams);
    return Response.json({ success: true });
  }) as typeof fetch;
  const idempotencyKey = "12345678-1234-4abc-8def-1234567890ab";

  await assertTurnstileToken({
    secret: "secret",
    token: "one-shot",
    idempotencyKey,
    fetchImpl
  });
  await assertTurnstileToken({
    secret: "secret",
    token: "one-shot",
    idempotencyKey,
    fetchImpl
  });
  assert.deepEqual(requests.map((body) => body.get("idempotency_key")), [idempotencyKey, idempotencyKey]);
  await assert.rejects(
    () => assertTurnstileToken({ secret: "secret", token: "one-shot", idempotencyKey: "not-a-uuid", fetchImpl }),
    /Invalid Turnstile idempotency key/
  );
});

test("Turnstile admission UUID is stable only for the same capability and challenge token", async () => {
  const capabilityHash = Uint8Array.from({ length: 32 }, (_value, index) => index).buffer;
  const first = await turnstileAdmissionIdempotencyKey(capabilityHash, "challenge-token-one");
  const exactRetry = await turnstileAdmissionIdempotencyKey(capabilityHash, "challenge-token-one");
  const refreshedChallenge = await turnstileAdmissionIdempotencyKey(capabilityHash, "challenge-token-two");
  const otherCapability = await turnstileAdmissionIdempotencyKey(new Uint8Array(32).buffer, "challenge-token-one");

  assert.equal(exactRetry, first);
  assert.notEqual(refreshedChallenge, first);
  assert.notEqual(otherCapability, first);
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("Turnstile verification bounds stalled headers, stalled bodies, and oversized JSON", async () => {
  const common = {
    secret: "secret",
    token: "one-shot",
    connectTimeoutMs: 5,
    operationTimeoutMs: 15,
    maxResponseBytes: 64
  } as const;

  await assert.rejects(
    () => assertTurnstileToken({
      ...common,
      fetchImpl: (async () => new Promise<Response>(() => undefined)) as typeof fetch
    }),
    (error: unknown) =>
      error instanceof EdgeScanGateError &&
      error.status === 503 &&
      /did not respond/.test(error.message)
  );

  await assert.rejects(
    () => assertTurnstileToken({
      ...common,
      connectTimeoutMs: 50,
      operationTimeoutMs: 5,
      fetchImpl: (async () => new Response(new ReadableStream<Uint8Array>({ start() {} }))) as typeof fetch
    }),
    (error: unknown) =>
      error instanceof EdgeScanGateError &&
      error.status === 503 &&
      /did not finish loading/.test(error.message)
  );

  await assert.rejects(
    () => assertTurnstileToken({
      ...common,
      fetchImpl: (async () => Response.json({ success: true, padding: "x".repeat(128) })) as typeof fetch
    }),
    (error: unknown) =>
      error instanceof EdgeScanGateError &&
      error.status === 503 &&
      /response limit/.test(error.message)
  );
});

test("Turnstile verification composes caller cancellation with its finite policy", async () => {
  const controller = new AbortController();
  const pending = assertTurnstileToken({
    secret: "secret",
    token: "one-shot",
    signal: controller.signal,
    connectTimeoutMs: 1_000,
    operationTimeoutMs: 1_000,
    fetchImpl: (async () => new Promise<Response>(() => undefined)) as typeof fetch
  });
  controller.abort(new DOMException("request ended", "AbortError"));
  await assert.rejects(
    pending,
    (error: unknown) => error instanceof EdgeScanGateError && error.status === 503 && /request ended/.test(error.message)
  );
});

test("Turnstile configuration probe distinguishes a valid secret from secret and transport failures", async () => {
  let requestedUrl = "";
  let requestInit: RequestInit | undefined;
  const validSecretFetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    requestedUrl = String(input);
    requestInit = init;
    return new Response(
      JSON.stringify({ success: false, "error-codes": ["invalid-input-response"] }),
      { status: 403, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;
  assert.equal(
    await probeTurnstileConfiguration({ secret: "valid-secret", fetchImpl: validSecretFetch }),
    "verified"
  );
  assert.equal(requestedUrl, "https://challenges.cloudflare.com/turnstile/v0/siteverify");
  assert.equal(requestInit?.method, "POST");
  assert.equal(requestInit?.redirect, undefined);
  assert.ok(requestInit?.signal instanceof AbortSignal);
  const body = requestInit?.body as URLSearchParams;
  assert.equal(body.get("secret"), "valid-secret");
  assert.equal(body.get("response"), "XXXX.DUMMY.TOKEN.XXXX");

  const invalidSecretFetch = (async () =>
    new Response(
      JSON.stringify({ success: false, "error-codes": ["invalid-input-secret"] }),
      { status: 400, headers: { "content-type": "application/json" } }
    )) as typeof fetch;
  assert.equal(
    await probeTurnstileConfiguration({ secret: "wrong-secret", fetchImpl: invalidSecretFetch }),
    "misconfigured"
  );
  assert.equal(await probeTurnstileConfiguration({ secret: "   ", fetchImpl: validSecretFetch }), "misconfigured");

  const unavailableFetch = (async () => {
    throw new Error("offline");
  }) as typeof fetch;
  assert.equal(
    await probeTurnstileConfiguration({ secret: "valid-secret", fetchImpl: unavailableFetch }),
    "unavailable"
  );
  assert.equal(
    await probeTurnstileConfiguration({
      secret: "valid-secret",
      fetchImpl: (async () => new Response("oops", { status: 502 })) as typeof fetch
    }),
    "unavailable"
  );
  assert.equal(
    await probeTurnstileConfiguration({
      secret: "valid-secret",
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({ success: false, "error-codes": ["invalid-input-response"] }),
          { status: 429, headers: { "content-type": "application/json" } }
        )) as typeof fetch
    }),
    "unavailable"
  );
  assert.equal(
    await probeTurnstileConfiguration({
      secret: "valid-secret",
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({ success: false, "error-codes": ["invalid-input-response", "internal-error"] }),
          { status: 200 }
        )) as typeof fetch
    }),
    "unavailable"
  );
});

test("Turnstile configuration probe bounds stalled and oversized response bodies", async () => {
  const common = {
    secret: "valid-secret",
    connectTimeoutMs: 5,
    operationTimeoutMs: 10,
    maxResponseBytes: 64
  } as const;
  for (const fetchImpl of [
    (async () => new Promise<Response>(() => undefined)) as typeof fetch,
    (async () => new Response(new ReadableStream<Uint8Array>({ start() {} }))) as typeof fetch,
    (async () => Response.json({
      success: false,
      "error-codes": ["invalid-input-response"],
      padding: "x".repeat(128)
    })) as typeof fetch
  ]) {
    assert.equal(await probeTurnstileConfiguration({ ...common, fetchImpl }), "unavailable");
  }
});

test("the module exposes no KV-backed rate limiter for a caller to mistake for one", async () => {
  // The counters here were a read-then-write that concurrent requests could
  // overshoot. They were the Browser Run worker's limiter; the container charges
  // its quota atomically in the Durable Object. Leaving them exported would let
  // a future caller reach for a limiter that does not hold under load.
  const gate: Record<string, unknown> = await import("./edge-scan-gate");
  for (const removed of ["enforcePublicScanRateLimit", "RateLimitStore"]) {
    assert.equal(removed in gate, false, `${removed} must not be re-exported`);
  }
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
  assert.deepEqual(publicScanRefusalReasons({ accessToken: "t" }), []);
  assert.deepEqual(publicScanRefusalReasons({ allowUnauthenticated: "1", turnstileSecret: "secret" }), []);

  // No token and not explicitly opened: every scan 503s and health must say so.
  const closed = publicScanRefusalReasons({});
  assert.equal(closed.length, 1);
  assert.match(closed[0], /unauthenticated scans are not enabled/);

  // Open without Turnstile (and without the explicit waiver): every scan 503s.
  const noTurnstile = publicScanRefusalReasons({ allowUnauthenticated: "1" });
  assert.equal(noTurnstile.length, 1);
  assert.match(noTurnstile[0], /Turnstile is not configured/);
  // The explicit waiver clears that refusal.
  assert.deepEqual(
    publicScanRefusalReasons({ allowUnauthenticated: "1", acceptNoTurnstileRisk: "1" }),
    []
  );

  // No refusal may name a KV rate-limit binding: the container has none, and
  // health asserting a missing binding would report an outage that cannot exist.
  for (const reasons of [closed, noTurnstile, publicScanRefusalReasons({ allowUnauthenticated: "1" })]) {
    for (const reason of reasons) assert.doesNotMatch(reason, /RATE_LIMITS_KV/);
  }
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
  const refusals = publicScanRefusalReasons({});
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

test("readRequestBodyWithinLimit preserves valid multibyte UTF-8", async () => {
  const body = JSON.stringify({ url: "https://例え.example/", label: "café" });
  const request = new Request("https://scanner.example/api/scan", { method: "POST", body });
  assert.equal(await readRequestBodyWithinLimit(request, 4_096), body);
});

test("readRequestBodyWithinLimit rejects invalid UTF-8 inside an otherwise valid JSON string", async () => {
  const prefix = new TextEncoder().encode('{"url":"https://example.com/');
  const suffix = new TextEncoder().encode('"}');
  // C3 28 is an invalid two-byte UTF-8 sequence. A replacement decoder would
  // turn it into a valid JSON string and silently alter the requested target.
  const bytes = new Uint8Array(prefix.byteLength + 2 + suffix.byteLength);
  bytes.set(prefix, 0);
  bytes.set([0xc3, 0x28], prefix.byteLength);
  bytes.set(suffix, prefix.byteLength + 2);
  const requestLike = {
    headers: new Headers(),
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      }
    })
  } as unknown as Request;

  await assert.rejects(
    readRequestBodyWithinLimit(requestLike, 4_096),
    (error: unknown) =>
      error instanceof RequestBodyInvalidUtf8Error &&
      error.status === 400 &&
      error.message === "The request body must be valid UTF-8."
  );
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
  const stream = new ReadableStream<Uint8Array>(
    {
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
        return new Promise<void>(() => undefined);
      }
    },
    // Keep this assertion about consumer demand, not the stream scheduler's
    // optional one-chunk prefetch while the abort race resolves.
    { highWaterMark: 0 }
  );
  const requestLike = { headers: new Headers(), body: stream } as unknown as Request;
  assert.equal(await settleWithin(readRequestBodyWithinLimit(requestLike, 4_096)), null);
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

test("readRequestBodyWithinLimit promptly cancels a stalled stream on caller abort", async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    }
  });
  const controller = new AbortController();
  const requestLike = {
    headers: new Headers(),
    body: stream,
    signal: controller.signal
  } as unknown as Request;
  const reading = readRequestBodyWithinLimit(requestLike, 4_096, { timeoutMs: 5_000 });
  controller.abort(new DOMException("caller disconnected", "AbortError"));

  await assert.rejects(reading, (error: unknown) => error instanceof RequestBodyReadAbortedError);
  assert.equal(cancelled, true);
});

test("readRequestBodyWithinLimit enforces an explicit whole-body deadline", async () => {
  let cancelled = false;
  const requestLike = {
    headers: new Headers(),
    body: new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      }
    })
  } as unknown as Request;
  const startedAt = Date.now();
  await assert.rejects(
    readRequestBodyWithinLimit(requestLike, 4_096, { timeoutMs: 10 }),
    (error: unknown) =>
      error instanceof RequestBodyReadTimeoutError && error.timeoutMs === 10 && error.status === 408
  );
  assert.ok(Date.now() - startedAt < 1_000, "the helper must not wait for an external platform cutoff");
  assert.equal(cancelled, true);
});

function settleWithin<T>(operation: Promise<T>, timeoutMs = 250): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("The request-body helper did not settle promptly.")),
      timeoutMs
    );
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

test("a retry-after window of one second reads as one second", () => {
  // Only the seconds branch can carry a singular value: the minutes branch
  // starts at 90 seconds and the hours branch at 90 minutes, so both always
  // round to at least two. A visitor refused in the final second of a window
  // was told to "Try again in about 1 seconds."
  assert.equal(formatPublicScanRetryAfter(1), "1 second");
  assert.equal(formatPublicScanRetryAfter(2), "2 seconds");
  assert.equal(formatPublicScanRetryAfter(89), "89 seconds");
  assert.equal(formatPublicScanRetryAfter(90), "2 minutes");
  assert.equal(formatPublicScanRetryAfter(5400), "2 hours");
});
