import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertInspectionRunnable,
  assertScrollCheckRunnable,
  INSPECTION_REQUEST_MESSAGE,
  PRIVATE_SUFFIX_TENANT_SUBJECT_MESSAGE,
  ScanGate,
  scanRateLimitCost,
  ScanTargetVerificationTimeoutError
} from "./scan-gate";
import { INSPECTION_V1_PRODUCER_REFUSAL } from "./connection-inspection-address";
import { scanTokenCost } from "./edge-scan-gate";
import {
  SCROLL_CHECK_BUSY_REFUSAL,
  SCROLL_CHECK_DURABLE_REFUSAL,
  SCROLL_CHECK_SINGLE_ONLY_REFUSAL,
  SCROLL_CHECK_UNKNOWN_REFUSAL,
  SCROLL_CHECK_V1_PRODUCER_REFUSAL,
  scanBodyNamesScrollCheck
} from "./scroll-check-request";
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
      error instanceof ScanTargetVerificationTimeoutError &&
      error.timeoutMs === 5 &&
      error.status === 503 &&
      // The same event as the resolver's own deadline, which races this one
      // at the same 5 s: both must declare the same cause.
      error.failureCause === "host-lookup-timeout"
  );
  assert.ok(Date.now() - started < 1_000, "the 5ms verification deadline must win, not the 5s default");
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
        error.failureCause === "public-suffix-target" &&
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

test("a token-shaped private-suffix tenant is refused before quota, DNS, or Chromium", async () => {
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
  const prepare = (url: string) =>
    gate.prepare(
      new Request("https://scanner.example/api/scan", { method: "POST", body: JSON.stringify({ url }) })
    );

  // Redaction generalizes these tenants, but the r2 subject key keeps the raw
  // registrable domain, so the public boundary would refuse the finished
  // report after the requester paid for the visit.
  for (const url of [
    "https://192-0-2-41_s-198-51-100-43_ts-1767225600-clienttons-s.akamaihd.net/",
    "https://5f8e9a0b1c2d3e4f5a6b7c8d--site.netlify.app/",
    "https://abcde1fghij2klmnopqr-abc1d2-12a34b567-clientnsv4-s.akamaihd.net/"
  ]) {
    await assert.rejects(
      prepare(url),
      (error: unknown) =>
        error instanceof PublicScanError &&
        error.status === 400 &&
        error.failureCause === "generalized-tenant-target" &&
        error.message === PRIVATE_SUFFIX_TENANT_SUBJECT_MESSAGE,
      url
    );
    assert.equal(quotaPeeked, false, `${url} must not reach the quota peek`);
    assert.equal(verifierCalled, false, `${url} must not reach target verification`);
  }

  // Stable tenants under the same kind of suffix stay scannable, platform
  // default hostnames included: that address is the site's stable one.
  for (const url of [
    "https://trial-eum-clienttons-s.akamaihd.net/",
    "https://face2face.github.io/",
    "https://example-app-1234567890ab.herokuapp.com/",
    "https://hello-123456789012.us-central1.run.app/"
  ]) {
    verifierCalled = false;
    await prepare(url);
    assert.equal(verifierCalled, true, url);
  }
});

function inspectionGate(reportMode: "v1" | "r2" = "r2") {
  const calls = { quotaPeeked: 0, verified: 0 };
  const gate = new ScanGate({
    assertAccess: () => undefined,
    assertBodySize: () => undefined,
    clientKeyFromRequest: () => "client",
    peekRateLimit: () => {
      calls.quotaPeeked += 1;
    },
    verifyPublicUrl: async () => {
      calls.verified += 1;
    },
    targetVerificationTimeoutMs: 1_000,
    reportMode: () => reportMode
  });
  const prepare = (body: Record<string, unknown>) =>
    gate.prepare(new Request("https://scanner.example/api/scan", { method: "POST", body: JSON.stringify(body) }));
  return { calls, prepare };
}

const INSPECTED = "https://pixel.example.net/{seg}";

test("a single scan may name one published address to inspect, as a visit option of one rate-limit token", async () => {
  const { calls, prepare } = inspectionGate();
  const prepared = await prepare({ url: "https://www.example.com/", device: "desktop", gpcEnabled: true, inspect: INSPECTED });
  assert.equal(prepared.inspect, INSPECTED);
  assert.equal(prepared.rateLimitCost, 1);
  assert.equal(calls.verified, 1);
  // A request that names none prepares exactly as before, with no such key.
  const ordinary = await prepare({ url: "https://www.example.com/", device: "desktop", gpcEnabled: true });
  assert.equal(Object.prototype.hasOwnProperty.call(ordinary, "inspect"), false);
  assert.deepEqual(Object.keys(ordinary).sort(), [
    "clientKey",
    "compareConsent",
    "compareGpc",
    "compareShields",
    "device",
    "gpcEnabled",
    "rateLimitCost",
    "url"
  ]);
});

test("an inspection that is not a published address, or that sits beside a comparison, is refused before quota or DNS", async () => {
  const { calls, prepare } = inspectionGate();
  for (const [name, body] of [
    ["a raw URL", { inspect: "https://pixel.example.net/p.gif" }],
    ["a query", { inspect: `${INSPECTED}?id=` }],
    ["an IP host", { inspect: "https://203.0.113.9/{seg}" }],
    ["a label redaction would generalize", { inspect: "https://x9.example.net/{seg}" }],
    ["an empty value", { inspect: "" }],
    ["a null value", { inspect: null }],
    ["a list", { inspect: [INSPECTED] }],
    ["a GPC comparison", { inspect: INSPECTED, compareGpc: true }],
    ["a Blocker comparison", { inspect: INSPECTED, compareShields: true }],
    ["a consent comparison", { inspect: INSPECTED, compareConsent: true }]
  ] as const) {
    await assert.rejects(
      prepare({ url: "https://www.example.com/", device: "desktop", gpcEnabled: true, ...body }),
      (error: unknown) =>
        error instanceof PublicScanError &&
        error.status === 400 &&
        error.failureCause === "request-rejected" &&
        error.message === INSPECTION_REQUEST_MESSAGE,
      name
    );
  }
  assert.deepEqual(calls, { quotaPeeked: 0, verified: 0 });
});

test("a scanner that writes version 1 reports refuses an inspection with its own sentence, before quota or DNS", async () => {
  const { calls, prepare } = inspectionGate("v1");
  await assert.rejects(
    prepare({ url: "https://www.example.com/", device: "desktop", gpcEnabled: true, inspect: INSPECTED }),
    (error: unknown) =>
      error instanceof PublicScanError &&
      error.status === 503 &&
      // Undeclared, so the visitor reads the sentence itself.
      error.failureCause === undefined &&
      error.message === INSPECTION_V1_PRODUCER_REFUSAL
  );
  assert.deepEqual(calls, { quotaPeeked: 0, verified: 0 });
  // An ordinary scan on the same scanner is untouched.
  await prepare({ url: "https://www.example.com/", device: "desktop", gpcEnabled: true });
  assert.equal(calls.verified, 1);
});

test("the execution-side check holds a prepared inspection to the same rules", () => {
  const single = { compareGpc: false, compareShields: false, compareConsent: false };
  assert.doesNotThrow(() => assertInspectionRunnable({ ...single, inspect: INSPECTED }, "r2"));
  assert.doesNotThrow(() => assertInspectionRunnable(single, "v1"));
  assert.throws(() => assertInspectionRunnable({ ...single, inspect: INSPECTED }, "v1"), { message: INSPECTION_V1_PRODUCER_REFUSAL });
  assert.throws(
    () => assertInspectionRunnable({ ...single, compareShields: true, inspect: INSPECTED }, "r2"),
    { message: INSPECTION_REQUEST_MESSAGE }
  );
});

test("a single scan may ask for the after-scrolling check, which costs two rate-limit tokens", async () => {
  const { calls, prepare } = inspectionGate();
  const prepared = await prepare({ url: "https://www.example.com/", device: "desktop", gpcEnabled: true, check: "scroll" });
  assert.equal(prepared.check, "scroll");
  assert.equal(prepared.rateLimitCost, 2);
  assert.equal(calls.verified, 1);
  // A request that asks for none prepares exactly as before, with no such key.
  const ordinary = await prepare({ url: "https://www.example.com/", device: "desktop", gpcEnabled: true });
  assert.equal(Object.prototype.hasOwnProperty.call(ordinary, "check"), false);
  assert.equal(ordinary.rateLimitCost, 1);
});

test("a check beside a comparison or an inspection, or any other check, is refused before quota or DNS", async () => {
  const { calls, prepare } = inspectionGate();
  for (const [name, body, message] of [
    ["a GPC comparison", { check: "scroll", compareGpc: true }, SCROLL_CHECK_SINGLE_ONLY_REFUSAL],
    ["a Blocker comparison", { check: "scroll", compareShields: true }, SCROLL_CHECK_SINGLE_ONLY_REFUSAL],
    ["a consent comparison", { check: "scroll", compareConsent: true }, SCROLL_CHECK_SINGLE_ONLY_REFUSAL],
    ["an inspection", { check: "scroll", inspect: INSPECTED }, SCROLL_CHECK_SINGLE_ONLY_REFUSAL],
    ["another check", { check: "zoom" }, SCROLL_CHECK_UNKNOWN_REFUSAL],
    ["a capitalized value", { check: "Scroll" }, SCROLL_CHECK_UNKNOWN_REFUSAL],
    ["true", { check: true }, SCROLL_CHECK_UNKNOWN_REFUSAL],
    ["a null value", { check: null }, SCROLL_CHECK_UNKNOWN_REFUSAL],
    ["a list", { check: ["scroll"] }, SCROLL_CHECK_UNKNOWN_REFUSAL]
  ] as const) {
    await assert.rejects(
      prepare({ url: "https://www.example.com/", device: "desktop", gpcEnabled: true, ...body }),
      (error: unknown) =>
        error instanceof PublicScanError &&
        error.status === 400 &&
        error.failureCause === "request-rejected" &&
        error.message === message,
      name
    );
  }
  assert.deepEqual(calls, { quotaPeeked: 0, verified: 0 });
});

test("a scanner that writes version 1 reports refuses a check with its own sentence, before quota or DNS", async () => {
  const { calls, prepare } = inspectionGate("v1");
  await assert.rejects(
    prepare({ url: "https://www.example.com/", device: "desktop", gpcEnabled: true, check: "scroll" }),
    (error: unknown) =>
      error instanceof PublicScanError &&
      error.status === 503 &&
      // Undeclared, so the visitor reads the sentence itself.
      error.failureCause === undefined &&
      error.message === SCROLL_CHECK_V1_PRODUCER_REFUSAL
  );
  assert.deepEqual(calls, { quotaPeeked: 0, verified: 0 });
});

test("the execution-side check holds a prepared check to the same rules", () => {
  const single = { compareGpc: false, compareShields: false, compareConsent: false };
  assert.doesNotThrow(() => assertScrollCheckRunnable({ ...single, check: "scroll" }, "r2"));
  assert.doesNotThrow(() => assertScrollCheckRunnable(single, "v1"));
  assert.throws(() => assertScrollCheckRunnable({ ...single, check: "scroll" }, "v1"), { message: SCROLL_CHECK_V1_PRODUCER_REFUSAL });
  assert.throws(() => assertScrollCheckRunnable({ ...single, compareGpc: true, check: "scroll" }, "r2"), {
    message: SCROLL_CHECK_SINGLE_ONLY_REFUSAL
  });
  assert.throws(() => assertScrollCheckRunnable({ ...single, inspect: INSPECTED, check: "scroll" }, "r2"), {
    message: SCROLL_CHECK_SINGLE_ONLY_REFUSAL
  });
});

test("the container's charge is the edge's charge for every shape of body", () => {
  for (const body of [
    {},
    { compareGpc: true },
    { compareShields: true },
    { compareConsent: true },
    { check: "scroll" },
    { check: "zoom" },
    { compareGpc: false, check: "scroll" }
  ]) {
    assert.equal(scanRateLimitCost(body), scanTokenCost(body), JSON.stringify(body));
  }
  assert.equal(scanTokenCost({ check: "scroll" }), 2);
  assert.equal(scanTokenCost({ check: "zoom" }), 1);
});

test("each check refusal is one sentence of at most 30 words with no dash, and the edge finds a check key in any body", () => {
  const dashes = new RegExp(`[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]`);
  const refusals = [
    SCROLL_CHECK_SINGLE_ONLY_REFUSAL,
    SCROLL_CHECK_UNKNOWN_REFUSAL,
    SCROLL_CHECK_DURABLE_REFUSAL,
    SCROLL_CHECK_V1_PRODUCER_REFUSAL,
    SCROLL_CHECK_BUSY_REFUSAL
  ];
  for (const sentence of refusals) {
    assert.ok(sentence.split(/\s+/).length <= 30, sentence);
    assert.equal(sentence.match(/[.!?](\s|$)/g)?.length, 1, sentence);
    assert.equal(dashes.test(sentence), false, sentence);
  }
  assert.equal(new Set(refusals).size, refusals.length);
  assert.equal(scanBodyNamesScrollCheck(JSON.stringify({ url: "https://www.example.com/", check: "scroll" })), true);
  // Any value names one: the edge refuses the key, the gate judges values.
  assert.equal(scanBodyNamesScrollCheck(JSON.stringify({ url: "https://www.example.com/", check: null })), true);
  assert.equal(scanBodyNamesScrollCheck(JSON.stringify({ url: "https://www.example.com/" })), false);
  assert.equal(scanBodyNamesScrollCheck(JSON.stringify({ nested: { check: "scroll" } })), false);
  assert.equal(scanBodyNamesScrollCheck(JSON.stringify([{ check: "scroll" }])), false);
  assert.equal(scanBodyNamesScrollCheck("{"), false);
  assert.equal(scanBodyNamesScrollCheck("null"), false);
});
