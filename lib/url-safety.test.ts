import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertPublicHttpUrl,
  assertPublicHttpUrlShape,
  normalizeUrl,
  PUBLIC_URL_MAX_RESOLVED_ADDRESSES,
  PublicUrlDnsTimeoutError,
  PublicUrlDnsUnavailableError
} from "./url-safety";
import { PublicScanError } from "./public-errors";

test("normalizeUrl trims input, adds https, and removes fragments", () => {
  assert.equal(normalizeUrl(" example.com/path?x=1#frag ").toString(), "https://example.com/path?x=1");
  assert.equal(normalizeUrl("HTTP://Example.com/a#section").toString(), "http://example.com/a");
});

test("normalizeUrl rejects empty input and non-http protocols", () => {
  assert.throws(() => normalizeUrl(""), /Enter a public URL/);
  assert.throws(() => normalizeUrl("file:///etc/passwd"), /Only HTTP and HTTPS/);
  assert.throws(() => normalizeUrl("javascript:alert(1)"), /Only HTTP and HTTPS/);
});

test("normalizeUrl rejects credentials", () => {
  assert.throws(() => normalizeUrl("https://user:pass@example.com"), /Credentials in URLs/);
});

test("normalizeUrl canonicalizes non-decimal IPv4 forms before safety checks", () => {
  assert.equal(normalizeUrl("http://2130706433/").hostname, "127.0.0.1");
  assert.equal(normalizeUrl("http://0177.0.0.1/").hostname, "127.0.0.1");
  assert.equal(normalizeUrl("http://0x7f.0.0.1/").hostname, "127.0.0.1");
  assert.equal(normalizeUrl("http://127.1/").hostname, "127.0.0.1");
});

test("assertPublicHttpUrl allows public IP literals without DNS", async () => {
  await assert.doesNotReject(() => assertPublicHttpUrl(new URL("https://1.1.1.1/")));
  await assert.doesNotReject(() => assertPublicHttpUrl(new URL("https://[2606:4700:4700::1111]/")));
  await assert.doesNotReject(() => assertPublicHttpUrl(new URL("https://[2001:4860:4860::8888]/")));
});

test("assertPublicHttpUrlShape performs structural checks without DNS", () => {
  assert.doesNotThrow(() => assertPublicHttpUrlShape(new URL("https://unresolved.invalid/")));
  assert.throws(() => assertPublicHttpUrlShape(new URL("https://127.0.0.1/")), /Local and private/);
  assert.throws(() => assertPublicHttpUrlShape(new URL("https://example.com:8443/")), /standard HTTP and HTTPS ports/);
});

test("assertPublicHttpUrl blocks localhost names without DNS", async () => {
  await assertLocalBlocked("http://localhost/");
  await assertLocalBlocked("http://localhost./");
  await assertLocalBlocked("http://scan.localhost/");
  await assertLocalBlocked("http://printer.local/");
  await assertLocalBlocked("http://router.internal/");
});

test("assertPublicHttpUrl blocks private and reserved IPv4 literals", async () => {
  const blocked = [
    "http://0.0.0.0/",
    "http://2130706433/",
    "http://0177.0.0.1/",
    "http://0x7f.0.0.1/",
    "http://127.1/",
    "http://10.0.0.1/",
    "http://100.64.0.1/",
    "http://127.0.0.1/",
    "http://169.254.10.20/",
    "http://172.16.0.1/",
    "http://172.31.255.255/",
    "http://192.0.0.1/",
    "http://192.0.2.10/",
    "http://192.88.99.1/",
    "http://192.168.1.1/",
    "http://198.18.0.1/",
    "http://198.51.100.9/",
    "http://203.0.113.2/",
    "http://224.0.0.1/"
  ];

  await Promise.all(blocked.map((url) => assertLocalBlocked(url)));
});

test("assertPublicHttpUrl blocks private and reserved IPv6 literals", async () => {
  const blocked = [
    "http://[::]/",
    "http://[::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[::ffff:7f00:1]/",
    "http://[fc00::1]/",
    "http://[fd00::1]/",
    "http://[fe80::1]/",
    "http://[febf::1]/",
    "http://[fec0::1]/",
    "http://[feff::1]/",
    "http://[ff02::1]/",
    "http://[2001::1]/",
    "http://[2001:2::1]/",
    "http://[2001:db8::1]/",
    "http://[2002::1]/"
  ];

  await Promise.all(blocked.map((url) => assertLocalBlocked(url)));
});

test("assertPublicHttpUrl blocks custom ports", async () => {
  await assert.rejects(
    () => assertPublicHttpUrl(new URL("https://1.1.1.1:8443/")),
    /standard HTTP and HTTPS ports/
  );
  await assert.rejects(
    () => assertPublicHttpUrl(new URL("http://127.0.0.1:3000/")),
    /Local and private network targets are blocked/
  );
});

test("assertPublicHttpUrl returns at its DNS deadline when the resolver ignores cancellation", async () => {
  const started = Date.now();
  await assert.rejects(
    assertPublicHttpUrl(new URL("https://deadline.example/"), {
      lookup: async () => new Promise(() => undefined),
      timeoutMs: 5
    }),
    (error: unknown) => error instanceof PublicUrlDnsTimeoutError && error.timeoutMs === 5
  );
  assert.equal(Date.now() - started < 250, true);
});

test("assertPublicHttpUrl propagates caller cancellation and caps resolver fan-out", async () => {
  const caller = new AbortController();
  const reason = new DOMException("request ended", "AbortError");
  const pending = assertPublicHttpUrl(new URL("https://cancel.example/"), {
    lookup: async () => new Promise(() => undefined),
    signal: caller.signal,
    timeoutMs: 1_000
  });
  caller.abort(reason);
  await assert.rejects(pending, (error: unknown) => error === reason);

  await assert.rejects(
    assertPublicHttpUrl(new URL("https://fanout.example/"), {
      lookup: async () =>
        Array.from({ length: PUBLIC_URL_MAX_RESOLVED_ADDRESSES + 1 }, (_, index) => ({
          address: `1.1.1.${index % 255}`,
          family: 4
        })),
      timeoutMs: 1_000
    }),
    // A ceiling the scanner declines to verify, not a lookup that failed: the
    // copy must not blame resolution for a policy refusal.
    (error: unknown) =>
      error instanceof PublicScanError &&
      error.status === 400 &&
      /resolved to more than 64 addresses/.test(error.message)
  );
});

test("a resolver that fails is a scanner outage, never a verdict about the host", async () => {
  // The distinction is the whole point: only an authoritative "no such name"
  // proves the caller's URL has no address. Everything else means verification
  // never ran, and a 4xx would tell the caller its perfectly good URL is bad
  // while a resolver flake blames a target the scanner never reached.
  const rejectingLookup = (code: string | null) => async () => {
    const error: Error & { code?: string } = new Error("lookup failed");
    if (code !== null) error.code = code;
    throw error;
  };

  for (const code of ["EAI_AGAIN", "ESERVFAIL", "ETIMEDOUT", "ECONNREFUSED", "EAI_SYSTEM"]) {
    await assert.rejects(
      assertPublicHttpUrl(new URL("https://flaky.example/"), {
        lookup: rejectingLookup(code),
        timeoutMs: 1_000
      }),
      (error: unknown) =>
        error instanceof PublicUrlDnsUnavailableError && error.status === 503 && error.code === code,
      `${code} must refuse as unavailable, not as an invalid request`
    );
  }

  // An unrecognized failure is still an unproven one; a future resolver code
  // must not silently start reading as "this host does not exist".
  await assert.rejects(
    assertPublicHttpUrl(new URL("https://unknown-code.example/"), {
      lookup: rejectingLookup(null),
      timeoutMs: 1_000
    }),
    (error: unknown) => error instanceof PublicUrlDnsUnavailableError && error.code === null
  );

  for (const code of ["ENOTFOUND", "ENODATA"]) {
    await assert.rejects(
      assertPublicHttpUrl(new URL("https://absent.example/"), {
        lookup: rejectingLookup(code),
        timeoutMs: 1_000
      }),
      (error: unknown) =>
        error instanceof PublicScanError &&
        !(error instanceof PublicUrlDnsUnavailableError) &&
        error.status === 400 &&
        /could not be resolved to a public address/.test(error.message),
      `${code} is authoritative and must stay a client error`
    );
  }
});

test("an unresolvable host still fails closed rather than reaching the network", async () => {
  // Every branch above refuses. The 503 changes the status and the sentence,
  // never the outcome, so a resolver outage can never admit an unverified host.
  await assert.rejects(
    assertPublicHttpUrl(new URL("https://empty.example/"), {
      lookup: async () => [],
      timeoutMs: 1_000
    }),
    /could not be resolved to a public address/
  );
});

async function assertLocalBlocked(url: string): Promise<void> {
  await assert.rejects(() => assertPublicHttpUrl(new URL(url)), /Local and private network targets are blocked/);
}
