import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

type BraveListFetchHelpers = {
  collectDefaultSources(catalog: unknown): string[];
  isTransientHttpStatus(status: unknown): boolean;
  retryAfterMs(value: unknown, now?: number): number | null;
  fetchTextWithRetry(
    url: string,
    options?: {
      fetcher?: typeof fetch;
      wait?: (ms: number) => Promise<void>;
      now?: () => number;
      timeoutMs?: number;
      transientRetries?: number;
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
