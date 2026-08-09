import assert from "node:assert/strict";
import test from "node:test";
import {
  createBoundedProviderClient,
  createProviderRequestLedger,
  STAGING_TEARDOWN_PROVIDER_REQUEST_TIMEOUT_MS,
  STAGING_TEARDOWN_PROVIDER_RESPONSE_MAX_BYTES
} from "./staging-teardown-provider-http.mjs";

const TOKEN = "t".repeat(32);

function client(fetchImpl, persistRaw = async () => undefined) {
  return createBoundedProviderClient({
    provider: "cloudflare",
    baseUrl: "https://provider.example.test",
    token: TOKEN,
    fetchImpl,
    persistRaw
  });
}

test("many empty and one-byte chunks retain only the fixed response buffer", async () => {
  const wire = new TextEncoder().encode('{"success":true,"result":[]}');
  const emptyChunks = 50_000;
  let pull = 0;
  const stream = new ReadableStream(
    {
      pull(controller) {
        if (pull < emptyChunks) {
          pull += 1;
          controller.enqueue(new Uint8Array());
          return;
        }
        const index = pull - emptyChunks;
        if (index < wire.length) {
          pull += 1;
          controller.enqueue(wire.subarray(index, index + 1));
          return;
        }
        controller.close();
      }
    },
    { highWaterMark: 0 }
  );
  let raw;
  const result = await client(
    async () => new Response(stream, { headers: { "content-type": "application/json" } }),
    async (_name, bytes) => { raw = Buffer.from(bytes); }
  ).request({ path: "/v1/items", label: "tiny chunks", rawName: "001.tiny.json" });
  assert.deepEqual(result.value, { success: true, result: [] });
  assert.equal(raw.toString("utf8"), new TextDecoder().decode(wire));
  assert.equal(pull, emptyChunks + wire.length);
});

test("a never-settling cancel and throwing releaseLock cannot mask an over-limit refusal", async () => {
  let cancelled = false;
  const reader = {
    async read() {
      return {
        done: false,
        value: new Uint8Array(STAGING_TEARDOWN_PROVIDER_RESPONSE_MAX_BYTES + 1)
      };
    },
    cancel() {
      cancelled = true;
      return new Promise(() => undefined);
    },
    releaseLock() {
      throw new Error("hostile releaseLock");
    }
  };
  const response = {
    status: 200,
    headers: new Headers({ "content-type": "application/json" }),
    body: { getReader: () => reader }
  };
  await assert.rejects(
    settleWithin(client(async () => response).request({
      path: "/v1/items",
      label: "oversized provider body",
      rawName: "001.oversized.json"
    })),
    /exceeds the 1048576-byte response limit/
  );
  assert.equal(cancelled, true);
});

test("declared oversize is refused without awaiting hostile body cancellation", async () => {
  let cancelled = false;
  const response = {
    status: 200,
    headers: new Headers({
      "content-type": "application/json",
      "content-encoding": "identity",
      "content-length": String(STAGING_TEARDOWN_PROVIDER_RESPONSE_MAX_BYTES + 1)
    }),
    body: {
      cancel() {
        cancelled = true;
        return new Promise(() => undefined);
      }
    }
  };
  await assert.rejects(
    settleWithin(client(async () => response).request({
      path: "/v1/items",
      label: "declared oversized body",
      rawName: "001.declared.json"
    })),
    /exceeds the 1048576-byte response limit/
  );
  assert.equal(cancelled, true);
});

test("wire Content-Length is ignored for decoded encoded bodies but exact for identity bodies", async () => {
  const wire = '{"success":true,"result":[]}';
  const encodedResult = await client(async () => new Response(wire, {
    headers: {
      "content-type": "application/json",
      "content-encoding": "gzip",
      // Fetch/Undici preserves the compressed wire length while exposing a
      // decoded body. It must not reject or exact-match that unrelated value.
      "content-length": String(STAGING_TEARDOWN_PROVIDER_RESPONSE_MAX_BYTES + 1)
    }
  })).request({
    path: "/v1/items",
    label: "decoded encoded provider body",
    rawName: "001.encoded.json"
  });
  assert.deepEqual(encodedResult.value, { success: true, result: [] });

  await assert.rejects(
    client(async () => new Response(wire, {
      headers: {
        "content-type": "application/json",
        "content-encoding": "identity",
        "content-length": String(Buffer.byteLength(wire, "utf8") + 1)
      }
    })).request({
      path: "/v1/items",
      label: "identity length mismatch",
      rawName: "002.identity.json"
    }),
    /response length does not match its Content-Length/
  );
});

test("duplicate keys and excessive JSON nesting are rejected at the provider boundary", async () => {
  for (const [wire, label] of [
    ['{"success":true,"result":[],"result":[{"id":"replacement"}]}', "duplicate"],
    [`${"[".repeat(129)}0${"]".repeat(129)}`, "deep"]
  ]) {
    await assert.rejects(
      client(async () => new Response(wire, { headers: { "content-type": "application/json" } })).request({
        path: "/v1/items",
        label,
        rawName: `001.${label}.json`
      }),
      /did not return bounded, strict UTF-8 JSON/
    );
  }
});

test("non-NFC provider JSON keys and values are refused before they can be canonicalized", async () => {
  for (const [value, label] of [
    [{ success: true, result: { ["e\u0301"]: "nested-key" } }, "non-nfc-key"],
    [{ success: true, result: { nested: "e\u0301" } }, "non-nfc-value"],
    [{ success: true, result: { "é": 1, ["e\u0301"]: 2 } }, "nfc-key-collision"]
  ]) {
    await assert.rejects(
      client(async () => new Response(JSON.stringify(value), {
        headers: { "content-type": "application/json" }
      })).request({
        path: "/v1/items",
        label,
        rawName: `001.${label}.json`
      }),
      /did not return bounded, strict UTF-8 JSON/
    );
  }
});

test("the client pins origin, method, bearer, redirects, and request budget", async () => {
  const calls = [];
  const bounded = createBoundedProviderClient({
    provider: "github",
    baseUrl: "https://api.example.test",
    token: "g".repeat(32),
    requestLimit: 1,
    fetchImpl: async (url, init) => {
      calls.push({ url: url.href, init });
      return new Response('{"ok":true}', { headers: { "content-type": "application/json" } });
    }
  });
  await bounded.request({ path: "/repos/o/r", label: "GitHub inventory", rawName: "001.github.json" });
  assert.equal(calls[0].url, "https://api.example.test/repos/o/r");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.redirect, "error");
  assert.equal(calls[0].init.headers.authorization, `Bearer ${"g".repeat(32)}`);
  await assert.rejects(
    bounded.request({ path: "https://evil.test/x", label: "escape", rawName: "002.escape.json" }),
    /absolute bounded API path/
  );
  await assert.rejects(
    bounded.request({ path: "/repos/o/r", label: "second", rawName: "002.second.json" }),
    /request budget of 1 was exceeded/
  );
});

test("the client emits only a documented jurisdiction header on Cloudflare R2 bucket paths", async () => {
  const calls = [];
  const bounded = client(async (url, init) => {
    calls.push({ url: url.href, init });
    return new Response('{"success":true,"result":{"buckets":[]},"result_info":{"cursor":null}}', {
      headers: { "content-type": "application/json" }
    });
  });
  await bounded.request({
    path: `/client/v4/accounts/${"a".repeat(32)}/r2/buckets?per_page=1000`,
    label: "default-jurisdiction bucket inventory",
    rawName: "001.r2-default.json",
    cloudflareR2Jurisdiction: "default"
  });
  assert.equal(calls[0].init.headers["cf-r2-jurisdiction"], "default");
  await assert.rejects(
    bounded.request({
      path: "/client/v4/accounts/a/tokens",
      label: "wrong surface",
      rawName: "002.wrong-surface.json",
      cloudflareR2Jurisdiction: "default"
    }),
    /permitted only on a bounded Cloudflare R2 bucket request/
  );
  await assert.rejects(
    bounded.request({
      path: `/client/v4/accounts/${"a".repeat(32)}/r2/buckets`,
      label: "wrong jurisdiction",
      rawName: "003.wrong-jurisdiction.json",
      cloudflareR2Jurisdiction: "unknown"
    }),
    /permitted only on a bounded Cloudflare R2 bucket request/
  );
});

test("clients sharing one bearer authority cannot reset its cumulative request or deadline ledger", async () => {
  let calls = 0;
  const ledger = createProviderRequestLedger({
    label: "shared observation authority",
    requestLimit: 2,
    deadlineBudgetMilliseconds: 2 * STAGING_TEARDOWN_PROVIDER_REQUEST_TIMEOUT_MS
  });
  const options = {
    provider: "cloudflare",
    baseUrl: "https://provider.example.test",
    token: TOKEN,
    requestLimit: 2,
    requestLedger: ledger,
    fetchImpl: async () => {
      calls += 1;
      return new Response('{"success":true,"result":[]}', {
        headers: { "content-type": "application/json" }
      });
    }
  };
  const first = createBoundedProviderClient(options);
  const second = createBoundedProviderClient(options);
  await first.request({ path: "/v1/one", label: "first", rawName: "001.first.json" });
  await second.request({ path: "/v1/two", label: "second", rawName: "002.second.json" });
  await assert.rejects(
    first.request({ path: "/v1/three", label: "third", rawName: "003.third.json" }),
    /cumulative request budget of 2 was exceeded/
  );
  assert.equal(calls, 2);
  assert.deepEqual(ledger.snapshot(), {
    requestCount: 2,
    requestLimit: 2,
    reservedDeadlineMilliseconds: 2 * STAGING_TEARDOWN_PROVIDER_REQUEST_TIMEOUT_MS,
    deadlineBudgetMilliseconds: 2 * STAGING_TEARDOWN_PROVIDER_REQUEST_TIMEOUT_MS
  });

  const deadlineLedger = createProviderRequestLedger({
    label: "short deadline authority",
    requestLimit: 2,
    deadlineBudgetMilliseconds: STAGING_TEARDOWN_PROVIDER_REQUEST_TIMEOUT_MS
  });
  const deadlineClient = createBoundedProviderClient({ ...options, requestLedger: deadlineLedger });
  await deadlineClient.request({
    path: "/v1/deadline-one",
    label: "deadline one",
    rawName: "004.deadline-one.json"
  });
  await assert.rejects(
    deadlineClient.request({
      path: "/v1/deadline-two",
      label: "deadline two",
      rawName: "005.deadline-two.json"
    }),
    /cumulative request deadline budget was exceeded/
  );
});

test("an explicitly enabled POST uses canonical JSON and refreshes auth for every request", async () => {
  const calls = [];
  let tokenNumber = 0;
  const bounded = createBoundedProviderClient({
    provider: "github",
    baseUrl: "https://api.example.test",
    tokenProvider: async () => `ghs_dynamic_${++tokenNumber}_${"x".repeat(24)}`,
    allowedMethods: ["GET", "POST"],
    fetchImpl: async (url, init) => {
      calls.push({ url: url.href, init });
      return new Response('{"ok":true}', {
        status: init.method === "POST" ? 201 : 200,
        headers: { "content-type": "application/json" }
      });
    }
  });
  await bounded.request({
    path: "/app/installations/1",
    label: "installation",
    rawName: "001.installation.json"
  });
  await bounded.request({
    method: "POST",
    path: "/app/installations/1/access_tokens",
    label: "token mint",
    rawName: "002.token.json",
    acceptedStatuses: [201],
    jsonBody: { repositories: ["site-behavior-lab"], permissions: { administration: "write" } }
  });
  assert.equal(
    calls[0].init.headers.authorization,
    `Bearer ghs_dynamic_1_${"x".repeat(24)}`
  );
  assert.equal(
    calls[1].init.headers.authorization,
    `Bearer ghs_dynamic_2_${"x".repeat(24)}`
  );
  assert.equal(calls[0].init.body, undefined);
  assert.equal(
    calls[1].init.body,
    '{"permissions":{"administration":"write"},"repositories":["site-behavior-lab"]}\n'
  );
  assert.equal(calls[1].init.headers["content-type"], "application/json");
});

test("dynamic-auth and method/body configuration fail closed without leaking credential errors", async () => {
  assert.throws(
    () => createBoundedProviderClient({
      provider: "github",
      baseUrl: "https://api.example.test",
      token: "g".repeat(32),
      tokenProvider: async () => "h".repeat(32)
    }),
    /exactly one static token or token provider/
  );
  const staticClient = createBoundedProviderClient({
    provider: "github",
    baseUrl: "https://api.example.test",
    token: "g".repeat(32)
  });
  await assert.rejects(
    staticClient.request({
      method: "POST",
      path: "/app/installations/1/access_tokens",
      label: "forbidden post",
      rawName: "001.forbidden.json",
      jsonBody: {}
    }),
    /does not permit POST/
  );
  const dynamic = createBoundedProviderClient({
    provider: "github",
    baseUrl: "https://api.example.test",
    tokenProvider: async () => {
      throw new Error("private-refresh-detail-never-print");
    }
  });
  await assert.rejects(
    dynamic.request({
      path: "/repos/o/r",
      label: "runner inventory",
      rawName: "001.dynamic.json"
    }),
    (error) => {
      assert.equal(error.message, "runner inventory credential refresh failed");
      assert.doesNotMatch(error.message, /private-refresh-detail/);
      return true;
    }
  );
});

test("accepted JSON can register cleanup state before an authoritative raw-sink failure", async () => {
  const events = [];
  const bounded = createBoundedProviderClient({
    provider: "github",
    baseUrl: "https://api.example.test",
    token: "g".repeat(32),
    allowedMethods: ["POST"],
    fetchImpl: async () => new Response('{"token":"ghs_cleanup_candidate_1234567890"}', {
      status: 201,
      headers: { "content-type": "application/json" }
    }),
    persistRaw: async () => {
      events.push("persist");
      throw new Error("private raw sink failed");
    }
  });
  await assert.rejects(
    bounded.request({
      method: "POST",
      path: "/app/installations/1/access_tokens",
      label: "token mint",
      rawName: "001.token.json",
      acceptedStatuses: [201],
      jsonBody: { permissions: { administration: "write" } },
      onAcceptedJsonBeforePersist(value) {
        assert.equal(value.token, "ghs_cleanup_candidate_1234567890");
        events.push("observe");
      }
    }),
    /private raw sink failed/
  );
  assert.deepEqual(events, ["observe", "persist"]);
});

test("Cloudflare R2 jurisdiction is exact, allowlisted, and confined to bucket paths", async () => {
  let observedHeaders;
  await client(async (_input, init) => {
    observedHeaders = new Headers(init.headers);
    return new Response('{"success":true,"result":[]}', {
      headers: { "content-type": "application/json" }
    });
  }).request({
    path: "/client/v4/accounts/a/r2/buckets",
    label: "default jurisdiction bucket list",
    rawName: "001.r2-default.json",
    cloudflareR2Jurisdiction: "default"
  });
  assert.equal(observedHeaders.get("cf-r2-jurisdiction"), "default");

  for (const [path, jurisdiction] of [
    ["/client/v4/accounts/a/r2/buckets", "moon"],
    ["/client/v4/accounts/a/workers/scripts", "default"]
  ]) {
    await assert.rejects(
      client(async () => { throw new Error("must not fetch"); }).request({
        path,
        label: "invalid jurisdiction request",
        rawName: "001.r2-invalid.json",
        cloudflareR2Jurisdiction: jurisdiction
      }),
      /cf-r2-jurisdiction is permitted only/
    );
  }

  const github = createBoundedProviderClient({
    provider: "github",
    baseUrl: "https://api.github.test",
    token: "g".repeat(32),
    fetchImpl: async () => { throw new Error("must not fetch"); },
    persistRaw: async () => undefined
  });
  await assert.rejects(
    github.request({
      path: "/repos/o/r/actions/runners",
      label: "GitHub jurisdiction refusal",
      rawName: "001.github.json",
      cloudflareR2Jurisdiction: "default"
    }),
    /cf-r2-jurisdiction is permitted only/
  );
});

async function settleWithin(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("provider refusal did not settle")), 1_000);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
