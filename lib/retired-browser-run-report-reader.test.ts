import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { toPublicError } from "./public-errors";
import {
  readRetiredBrowserRunReportJson,
  RETIRED_BROWSER_RUN_REPORT_MAX_BYTES,
  RetiredBrowserRunReportFragmentedError,
  RetiredBrowserRunReportInvalidError,
  RetiredBrowserRunReportTimeoutError,
  RetiredBrowserRunReportTooLargeError,
  withRetiredBrowserRunReportDeadline
} from "./retired-browser-run-report-reader";

const encoder = new TextEncoder();

test("historical Browser Run reports accept valid JSON at the exact stream cap", async () => {
  const wire = '{"ok":true}';
  const bytes = encoder.encode(wire);

  const report = await readRetiredBrowserRunReportJson<{ ok: boolean }>(streamOf(bytes), {
    declaredBytes: bytes.byteLength,
    maxBytes: bytes.byteLength
  });

  assert.deepEqual(report, { ok: true });
});

test("R2 object size rejects an oversized report before its body is pulled", async () => {
  let pulls = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      controller.enqueue(encoder.encode('{"ok":true}'));
      controller.close();
    },
    cancel() {
      cancelled = true;
    }
  });

  await assert.rejects(
    readRetiredBrowserRunReportJson(body, { declaredBytes: 17, maxBytes: 16 }),
    (error: unknown) => error instanceof RetiredBrowserRunReportTooLargeError && error.maxBytes === 16
  );
  assert.equal(pulls, 0);
  assert.equal(cancelled, true);
});

test("KV-style streams without size metadata are capped and cancelled mid-read", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode("1234"));
      controller.enqueue(encoder.encode("5"));
    },
    cancel() {
      cancelled = true;
    }
  });

  await assert.rejects(
    readRetiredBrowserRunReportJson(body, { maxBytes: 4 }),
    RetiredBrowserRunReportTooLargeError
  );
  assert.equal(cancelled, true);
});

test("oversize rejection never awaits non-cooperative stream cancellation", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode("12345"));
    },
    cancel() {
      cancelled = true;
      return new Promise<void>(() => undefined);
    }
  });
  const started = Date.now();

  await assert.rejects(
    readRetiredBrowserRunReportJson(body, { maxBytes: 4, timeoutMs: 1_000 }),
    RetiredBrowserRunReportTooLargeError
  );
  assert.equal(cancelled, true);
  assert.equal(Date.now() - started < 250, true);
});

test("body reads lose an explicit deadline race when read and cancel never settle", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull() {
      return new Promise<void>(() => undefined);
    },
    cancel() {
      cancelled = true;
      return new Promise<void>(() => undefined);
    }
  });
  const started = Date.now();

  await assert.rejects(
    readRetiredBrowserRunReportJson(body, { maxBytes: 64, timeoutMs: 5 }),
    (error: unknown) => error instanceof RetiredBrowserRunReportTimeoutError && error.timeoutMs === 5
  );
  assert.equal(cancelled, true);
  assert.equal(Date.now() - started < 250, true);
});

test("the whole storage lookup returns at its deadline when the implementation ignores abort", async () => {
  let signal: AbortSignal | null = null;
  const started = Date.now();

  await assert.rejects(
    withRetiredBrowserRunReportDeadline(
      async (operationSignal) => {
        signal = operationSignal;
        return new Promise<never>(() => undefined);
      },
      { timeoutMs: 5 }
    ),
    RetiredBrowserRunReportTimeoutError
  );
  assert.equal((signal as AbortSignal | null)?.aborted, true);
  assert.equal(Date.now() - started < 250, true);
});

test("fragmented and duplicate-key stored reports fail closed", async () => {
  const fragmented = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode("{"));
      controller.enqueue(encoder.encode("}"));
    }
  });
  await assert.rejects(
    readRetiredBrowserRunReportJson(fragmented, { maxBytes: 64, maxChunks: 1 }),
    RetiredBrowserRunReportFragmentedError
  );

  await assert.rejects(
    readRetiredBrowserRunReportJson(streamOf(encoder.encode('{"ok":true,"ok":false}')), {
      maxBytes: 64
    }),
    RetiredBrowserRunReportInvalidError
  );
});

test("wrong R2 size metadata cannot bypass the independent stream cap", async () => {
  await assert.rejects(
    readRetiredBrowserRunReportJson(streamOf(encoder.encode("12345")), {
      declaredBytes: 1,
      maxBytes: 4
    }),
    RetiredBrowserRunReportTooLargeError
  );
});

test("malformed JSON and invalid UTF-8 are storage errors, not public details", async () => {
  const invalidJson = readRetiredBrowserRunReportJson(streamOf(encoder.encode("{private-corruption}")), {
    maxBytes: 64
  });
  await assert.rejects(invalidJson, RetiredBrowserRunReportInvalidError);

  const invalidUtf8 = readRetiredBrowserRunReportJson(streamOf(new Uint8Array([0xff])), { maxBytes: 64 });
  await assert.rejects(invalidUtf8, RetiredBrowserRunReportInvalidError);

  const originalConsoleError = console.error;
  console.error = () => undefined;
  try {
    assert.deepEqual(toPublicError(new RetiredBrowserRunReportInvalidError()), {
      message: "The service could not complete this request. Try again later.",
      status: 500
    });
    assert.deepEqual(toPublicError(new RetiredBrowserRunReportTooLargeError(64)), {
      message: "The service could not complete this request. Try again later.",
      status: 500
    });
  } finally {
    console.error = originalConsoleError;
  }
});

test("the retired Worker uses R2 size plus raw bounded R2 and KV streams", async () => {
  const source = await readFile(path.join(process.cwd(), "cloudflare/worker.ts"), "utf8");

  assert.match(source, /withRetiredBrowserRunReportDeadline\(async \(signal\) =>/);
  assert.match(source, /declaredBytes: object\.size,[\s\S]*?signal/);
  assert.match(source, /readReport\(route\.reportId, env, request\.signal\)/);
  assert.match(source, /REPORTS_KV\.get\(reportKey\(id\), "stream"\)/);
  assert.doesNotMatch(source, /object\.json<ScanReport>/);
  assert.doesNotMatch(source, /REPORTS_KV\.get<ScanReport>\(reportKey\(id\), "json"\)/);
  assert.equal(RETIRED_BROWSER_RUN_REPORT_MAX_BYTES, 32 * 1024 * 1024);
});

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    }
  });
}
