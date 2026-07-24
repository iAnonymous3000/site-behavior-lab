import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

type HttpResponseHelpers = {
  withHttpOperationDeadline<T>(
    options: { timeoutMs: number; label: string; signal?: AbortSignal },
    operation: (signal: AbortSignal) => Promise<T>
  ): Promise<T>;
  readResponseBytesWithinLimit(
    response: Response,
    options: { maxBytes: number; label: string }
  ): Promise<Uint8Array>;
  readResponseTextWithinLimit(
    response: Response,
    options: { maxBytes: number; label: string }
  ): Promise<string>;
  readResponseJsonWithinLimit(
    response: Response,
    options: { maxBytes: number; label: string }
  ): Promise<unknown>;
};

const nativeImport = new Function("specifier", "return import(specifier)") as (
  specifier: string
) => Promise<HttpResponseHelpers>;
const helpers = nativeImport(
  pathToFileURL(path.join(process.cwd(), "scripts", "http-response.mjs")).href
);

test("script response reader accepts the exact decompressed byte boundary", async () => {
  const { readResponseBytesWithinLimit, readResponseJsonWithinLimit } = await helpers;
  const bytes = await readResponseBytesWithinLimit(new Response("12345"), {
    maxBytes: 5,
    label: "exact response"
  });
  assert.equal(new TextDecoder().decode(bytes), "12345");
  assert.deepEqual(
    await readResponseJsonWithinLimit(Response.json({ ok: true }), {
      maxBytes: 64,
      label: "JSON response"
    }),
    { ok: true }
  );
});

test("script response readers reject malformed UTF-8 and duplicate-key JSON", async () => {
  const { readResponseJsonWithinLimit, readResponseTextWithinLimit } = await helpers;
  const malformedUtf8 = new Uint8Array([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d]);
  await assert.rejects(
    readResponseTextWithinLimit(new Response(malformedUtf8), {
      maxBytes: malformedUtf8.byteLength,
      label: "malformed UTF-8 response"
    }),
    TypeError
  );

  const duplicateKeys = '{"ok":true,"ok":false}';
  await assert.rejects(
    readResponseJsonWithinLimit(new Response(duplicateKeys), {
      maxBytes: new TextEncoder().encode(duplicateKeys).byteLength,
      label: "duplicate-key response"
    }),
    (error: unknown) => error instanceof Error && error.name === "StrictJsonError" && error.message === "duplicate-key"
  );
});

test("script response reader rejects an oversized declared length before buffering", async () => {
  const { readResponseTextWithinLimit } = await helpers;
  await assert.rejects(
    readResponseTextWithinLimit(
      new Response("small", { headers: { "content-length": "999" } }),
      { maxBytes: 8, label: "declared response" }
    ),
    /declared response exceeds the 8-byte response limit/
  );
});

test("script response reader cancels a chunked stream as soon as it crosses the cap", async () => {
  const { readResponseBytesWithinLimit } = await helpers;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("123"));
      controller.enqueue(new TextEncoder().encode("456"));
    },
    cancel() {
      cancelled = true;
    }
  });

  await assert.rejects(
    readResponseBytesWithinLimit(new Response(body), {
      maxBytes: 5,
      label: "chunked response"
    }),
    /chunked response exceeds the 5-byte response limit/
  );
  assert.equal(cancelled, true);
});

test("script HTTP deadline covers the body-consumption callback and composes caller aborts", async () => {
  const { withHttpOperationDeadline } = await helpers;
  let deadlineSignal: AbortSignal | null = null;
  await assert.rejects(
    withHttpOperationDeadline(
      { timeoutMs: 5, label: "slow body" },
      (signal) => {
        deadlineSignal = signal;
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }
    ),
    (error) => error instanceof DOMException && error.name === "TimeoutError"
  );
  assert.equal((deadlineSignal as AbortSignal | null)?.aborted, true);

  const caller = new AbortController();
  const callerReason = new DOMException("operator cancelled", "AbortError");
  const pending = withHttpOperationDeadline(
    { timeoutMs: 1_000, label: "caller-aborted request", signal: caller.signal },
    (signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      })
  );
  caller.abort(callerReason);
  await assert.rejects(pending, (error) => error === callerReason);
});

test("script HTTP deadline returns even when the callback ignores abort and observes late rejection", async () => {
  const { withHttpOperationDeadline } = await helpers;
  const late = { reject: null as ((reason: unknown) => void) | null };
  const startedAt = Date.now();
  await assert.rejects(
    withHttpOperationDeadline(
      { timeoutMs: 5, label: "non-cooperative request" },
      () =>
        new Promise<never>((_resolve, reject) => {
          late.reject = reject;
        })
    ),
    (error) => error instanceof DOMException && error.name === "TimeoutError"
  );
  assert.ok(Date.now() - startedAt < 500, "hard deadline should not await a signal-ignoring callback");
  const rejectLate = late.reject as ((reason: unknown) => void) | null;
  assert.ok(rejectLate);
  rejectLate(new Error("late operation rejection"));
  await new Promise((resolve) => setImmediate(resolve));
});

test("script response limit returns even when stream cancellation never settles", async () => {
  const { readResponseBytesWithinLimit } = await helpers;
  let cancelStarted = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("too large"));
    },
    cancel() {
      cancelStarted = true;
      return new Promise<void>(() => undefined);
    }
  });

  const startedAt = Date.now();
  await assert.rejects(
    readResponseBytesWithinLimit(new Response(body), {
      maxBytes: 3,
      label: "non-cooperative stream"
    }),
    /non-cooperative stream exceeds the 3-byte response limit/
  );
  assert.equal(cancelStarted, true);
  assert.ok(Date.now() - startedAt < 500, "overflow rejection should not await stream cancellation");
});

test("first-party operator and smoke scripts contain no direct unbounded response readers", async () => {
  const scriptsDir = path.join(process.cwd(), "scripts");
  const excluded = new Set([
    "fetch-brave-lists.mjs",
    "verify-adblock-engine.mjs",
    "release-evidence.mjs"
  ]);
  const files = (await readdir(scriptsDir))
    .filter((file) => /\.(?:mjs|js|ts)$/.test(file) && !excluded.has(file));
  const violations: string[] = [];
  for (const file of files) {
    const source = await readFile(path.join(scriptsDir, file), "utf8");
    if (/\.(?:json|text|arrayBuffer)\(\)/.test(source)) violations.push(file);
  }
  assert.deepEqual(violations, []);
});
