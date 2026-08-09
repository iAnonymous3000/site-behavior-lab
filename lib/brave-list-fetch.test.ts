import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { gzipSync } from "node:zlib";

type BraveListFetchHelpers = {
  CATALOG_COMMIT: string;
  CATALOG_SHA256: string;
  CATALOG_URL: string;
  collectDefaultSources(catalog: unknown): string[];
  isTransientHttpStatus(status: unknown): boolean;
  retryAfterMs(value: unknown, now?: number): number | null;
  validateApprovedSourceUrl(value: string): string;
  fetchTextWithRetry(
    url: string,
    options?: {
      fetcher?: typeof fetch;
      wait?: (ms: number) => Promise<void>;
      now?: () => number;
      timeoutMs?: number;
      transientRetries?: number;
      maxBytes?: number;
      allowedUrls?: Iterable<string>;
      onRetry?: (value: { attempt: number; delayMs: number; reason: string }) => void;
    }
  ): Promise<string>;
};

const nativeImport = new Function("specifier", "return import(specifier)") as (
  specifier: string
) => Promise<BraveListFetchHelpers>;
const helpers = nativeImport(
  pathToFileURL(path.join(process.cwd(), "scripts", "fetch-brave-lists.mjs")).href
);

function settleWithin<T>(operation: Promise<T>, timeoutMs = 250): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("The Brave-list body reader did not settle promptly.")),
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

test("Brave-list source collection keeps only unique default-enabled URLs", async () => {
  const { collectDefaultSources } = await helpers;
  assert.deepEqual(
    collectDefaultSources([
      { default_enabled: true, sources: [{ url: "https://example.test/a" }, { url: "https://example.test/a" }] },
      { default_enabled: false, sources: [{ url: "https://example.test/off" }] },
      { default_enabled: true, sources: [{ url: "https://example.test/b" }, {}, null] }
    ]),
    ["https://example.test/a", "https://example.test/b"]
  );
});

test("Brave-list catalog and source policy are immutable reviewed inputs", async () => {
  const { CATALOG_COMMIT, CATALOG_SHA256, CATALOG_URL, validateApprovedSourceUrl } = await helpers;
  assert.match(CATALOG_COMMIT, /^[a-f0-9]{40}$/);
  assert.match(CATALOG_SHA256, /^[a-f0-9]{64}$/);
  assert.equal(
    CATALOG_URL,
    `https://raw.githubusercontent.com/brave/adblock-resources/${CATALOG_COMMIT}/filter_lists/list_catalog.json`
  );
  assert.equal(
    validateApprovedSourceUrl("https://easylist.to/easylist/easylist.txt"),
    "https://easylist.to/easylist/easylist.txt"
  );
  for (const rejected of [
    "http://easylist.to/easylist/easylist.txt",
    "https://easylist.to:443/easylist/easylist.txt",
    "https://easylist.to:444/easylist/easylist.txt",
    "https://easylist.to/easylist/other.txt",
    "https://raw.githubusercontent.com/attacker/repository/master/list.txt",
    "https://127.0.0.1/list.txt"
  ]) {
    assert.throws(() => validateApprovedSourceUrl(rejected), /HTTPS|port, query, or fragment|host\/path policy/);
  }
});

test("Brave-list fetch retries 429 and 5xx with bounded Retry-After handling", async () => {
  const { fetchTextWithRetry, isTransientHttpStatus, retryAfterMs } = await helpers;
  const statuses = [429, 503, 200];
  const waits: number[] = [];
  const retries: Array<{ attempt: number; delayMs: number; reason: string }> = [];
  let calls = 0;
  const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
    assert.ok(init?.signal instanceof AbortSignal);
    const status = statuses[calls++] ?? 500;
    return new Response(status === 200 ? "complete rules" : "busy", {
      status,
      headers: status === 429 ? { "Retry-After": "2" } : undefined
    });
  }) as typeof fetch;

  assert.equal(await fetchTextWithRetry("https://example.test/list", {
    fetcher,
    wait: async (ms) => { waits.push(ms); },
    transientRetries: 2,
    onRetry: (value) => { retries.push(value); }
  }), "complete rules");
  assert.equal(calls, 3);
  assert.deepEqual(waits, [2_000, 2_000]);
  assert.deepEqual(retries.map(({ attempt, reason }) => ({ attempt, reason })), [
    { attempt: 1, reason: "HTTP 429" },
    { attempt: 2, reason: "HTTP 503" }
  ]);
  assert.equal(isTransientHttpStatus(500), true);
  assert.equal(isTransientHttpStatus(599), true);
  assert.equal(isTransientHttpStatus(404), false);
  assert.equal(retryAfterMs("999999"), 30_000);
});

test("Brave-list fetch does not retry permanent HTTP failures", async () => {
  const { fetchTextWithRetry } = await helpers;
  let calls = 0;
  const fetcher = (async () => {
    calls += 1;
    return new Response("missing", { status: 404 });
  }) as typeof fetch;

  await assert.rejects(
    () => fetchTextWithRetry("https://example.test/missing", {
      fetcher,
      wait: async () => { throw new Error("must not wait"); },
      transientRetries: 2
    }),
    /HTTP 404/
  );
  assert.equal(calls, 1);
});

test("Brave-list retry configuration is hard-capped at two retries", async () => {
  const { fetchTextWithRetry } = await helpers;
  let calls = 0;
  const fetcher = (async () => {
    calls += 1;
    return new Response("busy", { status: 503 });
  }) as typeof fetch;

  await assert.rejects(
    () => fetchTextWithRetry("https://example.test/list", { transientRetries: 3 }),
    /integer from 0 to 2/
  );
  assert.equal(calls, 0, "invalid retry policy must fail before the first request");

  await assert.rejects(
    () => fetchTextWithRetry("https://example.test/list", {
      fetcher,
      wait: async () => {},
      transientRetries: 2
    }),
    /HTTP 503/
  );
  assert.equal(calls, 3, "two retries means exactly three total attempts");
});

test("Brave-list fetch retries transport and response-body failures but remains bounded", async () => {
  const { fetchTextWithRetry } = await helpers;
  const waits: number[] = [];
  let calls = 0;
  const fetcher = (async () => {
    calls += 1;
    if (calls === 1) throw new TypeError("fetch failed");
    if (calls === 2) {
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        text: async () => { throw new Error("body stream reset"); }
      } as unknown as Response;
    }
    throw new TypeError("still unavailable");
  }) as typeof fetch;

  await assert.rejects(
    () => fetchTextWithRetry("https://example.test/flaky", {
      fetcher,
      wait: async (ms) => { waits.push(ms); },
      transientRetries: 2
    }),
    /still unavailable/
  );
  assert.equal(calls, 3);
  assert.deepEqual(waits, [1_000, 2_000]);
});

test("Brave-list fetch applies a real per-attempt deadline", async () => {
  const { fetchTextWithRetry } = await helpers;
  const fetcher = ((_url: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    })) as typeof fetch;

  await assert.rejects(
    () => fetchTextWithRetry("https://example.test/hangs", { fetcher, timeoutMs: 5, transientRetries: 0 }),
    (error) => error instanceof Error && error.name === "TimeoutError"
  );
});

test("Brave-list fetch refuses redirects, unreviewed URLs, and decompressed oversize bodies without retrying", async () => {
  const { fetchTextWithRetry } = await helpers;
  let redirectCalls = 0;
  let redirectCancelStarted = false;
  const redirectFetcher = (async () => {
    redirectCalls += 1;
    return {
      ok: false,
      status: 302,
      headers: new Headers({ Location: "https://other.test/list" }),
      body: {
        cancel() {
          redirectCancelStarted = true;
          return new Promise<void>(() => undefined);
        }
      }
    } as unknown as Response;
  }) as typeof fetch;
  await assert.rejects(
    settleWithin(
      fetchTextWithRetry("https://example.test/list", {
        fetcher: redirectFetcher,
        transientRetries: 2
      })
    ),
    /redirect 302 is forbidden/
  );
  assert.equal(redirectCalls, 1);
  assert.equal(redirectCancelStarted, true);

  await assert.rejects(
    () => fetchTextWithRetry("https://example.test/list", {
      allowedUrls: ["https://example.test/other"]
    }),
    /not present in the reviewed source lock/
  );

  let oversizeCalls = 0;
  const oversizeFetcher = (async () => {
    oversizeCalls += 1;
    return new Response("12345");
  }) as typeof fetch;
  await assert.rejects(
    () => fetchTextWithRetry("https://example.test/list", {
      fetcher: oversizeFetcher,
      maxBytes: 4,
      transientRetries: 2
    }),
    /exceeds the 4-byte limit/
  );
  assert.equal(oversizeCalls, 1);
});

test("Brave-list response retention ignores empty and one-byte chunk metadata", async () => {
  const { fetchTextWithRetry } = await helpers;
  const expected = "fixed-capacity-list";
  const expectedBytes = new TextEncoder().encode(expected);
  const emptyChunkCount = 50_000;
  let reads = 0;
  let released = false;
  const reader = {
    async read() {
      if (reads < emptyChunkCount) {
        reads += 1;
        return { done: false, value: new Uint8Array() };
      }
      const offset = reads - emptyChunkCount;
      reads += 1;
      if (offset < expectedBytes.byteLength) {
        return {
          done: false,
          value: expectedBytes.slice(offset, offset + 1)
        };
      }
      return { done: true, value: undefined };
    },
    cancel() {
      throw new Error("successful reads must not cancel");
    },
    releaseLock() {
      released = true;
    }
  };
  const fetcher = (async (input: string | URL | Request) => ({
    ok: true,
    status: 200,
    url: String(input),
    headers: new Headers(),
    body: { getReader: () => reader }
  })) as unknown as typeof fetch;

  assert.equal(
    await fetchTextWithRetry("https://example.test/list", {
      fetcher,
      maxBytes: expectedBytes.byteLength,
      transientRetries: 0
    }),
    expected
  );
  assert.equal(reads, emptyChunkCount + expectedBytes.byteLength + 1);
  assert.equal(released, true);
});

test("Brave-list overflow ignores non-settling cancellation and release errors", async () => {
  const { fetchTextWithRetry } = await helpers;
  let canceled = false;
  const reader = {
    async read() {
      return { done: false, value: new Uint8Array(5) };
    },
    cancel() {
      canceled = true;
      return new Promise<void>(() => undefined);
    },
    releaseLock() {
      throw new Error("hostile releaseLock");
    }
  };
  const fetcher = (async (input: string | URL | Request) => ({
    ok: true,
    status: 200,
    url: String(input),
    headers: new Headers(),
    body: { getReader: () => reader }
  })) as unknown as typeof fetch;

  await assert.rejects(
    settleWithin(
      fetchTextWithRetry("https://example.test/list", {
        fetcher,
        maxBytes: 4,
        transientRetries: 0
      })
    ),
    /exceeds the 4-byte limit/
  );
  assert.equal(canceled, true);
});

test("Brave-list length checks distinguish decoded gzip from identity bytes", async () => {
  const { fetchTextWithRetry } = await helpers;
  const expected = "decoded";
  const expectedBytes = Buffer.from(expected, "utf8");
  const gzipWireLength = gzipSync(expectedBytes).byteLength;
  assert.ok(gzipWireLength > expectedBytes.byteLength);

  const gzipFetcher = (async () =>
    new Response(expectedBytes, {
      headers: {
        "content-encoding": "gzip",
        "content-length": String(gzipWireLength)
      }
    })) as typeof fetch;
  assert.equal(
    await fetchTextWithRetry("https://example.test/list", {
      fetcher: gzipFetcher,
      maxBytes: expectedBytes.byteLength,
      transientRetries: 0
    }),
    expected
  );

  const identityFetcher = (async () =>
    new Response(expectedBytes, {
      headers: {
        "content-encoding": "identity",
        "content-length": String(expectedBytes.byteLength)
      }
    })) as typeof fetch;
  assert.equal(
    await fetchTextWithRetry("https://example.test/list", {
      fetcher: identityFetcher,
      maxBytes: expectedBytes.byteLength,
      transientRetries: 0
    }),
    expected
  );

  const mismatchFetcher = (async () =>
    new Response(expectedBytes, {
      headers: {
        "content-length": String(expectedBytes.byteLength - 1)
      }
    })) as typeof fetch;
  await assert.rejects(
    fetchTextWithRetry("https://example.test/list", {
      fetcher: mismatchFetcher,
      maxBytes: expectedBytes.byteLength,
      transientRetries: 0
    }),
    /does not match Content-Length/
  );
});
