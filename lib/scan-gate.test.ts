import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ScanGate,
  ScanTargetVerificationTimeoutError
} from "./scan-gate";
import { PublicScanError } from "./public-errors";

test("scan preparation returns at its target-verification deadline when an injected verifier stalls", async () => {
  const gate = new ScanGate({
    assertAccess: () => undefined,
    assertBodySize: () => undefined,
    clientKeyFromRequest: () => "client",
    peekRateLimit: () => undefined,
    verifyPublicUrl: async () => new Promise(() => undefined),
    targetVerificationTimeoutMs: 5
  });
  const request = new Request("https://scanner.example/api/scan", {
    method: "POST",
    body: JSON.stringify({ url: "https://1.1.1.1/" })
  });
  const started = Date.now();

  await assert.rejects(
    gate.prepare(request),
    (error: unknown) =>
      error instanceof ScanTargetVerificationTimeoutError && error.timeoutMs === 5
  );
  assert.equal(Date.now() - started < 250, true);
});

test("scan preparation propagates request cancellation while a verifier ignores it", async () => {
  let verificationStarted: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    verificationStarted = resolve;
  });
  const gate = new ScanGate({
    assertAccess: () => undefined,
    assertBodySize: () => undefined,
    clientKeyFromRequest: () => "client",
    peekRateLimit: () => undefined,
    verifyPublicUrl: async () => {
      verificationStarted();
      return new Promise(() => undefined);
    },
    targetVerificationTimeoutMs: 1_000
  });
  const caller = new AbortController();
  const reason = new DOMException("request ended", "AbortError");
  const request = new Request("https://scanner.example/api/scan", {
    method: "POST",
    body: JSON.stringify({ url: "https://1.1.1.1/" }),
    signal: caller.signal
  });
  const pending = gate.prepare(request);
  await started;
  caller.abort(reason);

  await assert.rejects(
    pending,
    (error: unknown) =>
      error instanceof DOMException && error.name === "AbortError" && error.message === reason.message
  );
});

test("a public-suffix target is refused before quota, DNS, or Chromium", async () => {
  let quotaPeeked = false;
  let verifierCalled = false;
  const gate = new ScanGate({
    assertAccess: () => undefined,
    assertBodySize: () => undefined,
    clientKeyFromRequest: () => "client",
    peekRateLimit: () => {
      quotaPeeked = true;
    },
    verifyPublicUrl: async () => {
      verifierCalled = true;
    },
    targetVerificationTimeoutMs: 1_000
  });

  // These hosts have no registrable domain, so the r2 builder's subject key
  // cannot name them; without this gate the requester paid for a whole scan
  // and got a 500 back.
  for (const host of ["github.io", "gov.uk", "s3.amazonaws.com", "herokuapp.com", "pages.dev"]) {
    await assert.rejects(
      gate.prepare(
        new Request("https://scanner.example/api/scan", {
          method: "POST",
          body: JSON.stringify({ url: `https://${host}/` })
        })
      ),
      (error: unknown) =>
        error instanceof PublicScanError &&
        error.status === 400 &&
        /registry boundary/.test(error.message),
      host
    );
    assert.equal(quotaPeeked, false, `${host} must not reach the quota peek`);
    assert.equal(verifierCalled, false, `${host} must not reach target verification`);
  }

  // A site UNDER the same suffix stays scannable.
  await gate.prepare(
    new Request("https://scanner.example/api/scan", {
      method: "POST",
      body: JSON.stringify({ url: "https://example.github.io/" })
    })
  );
  assert.equal(verifierCalled, true);
});
